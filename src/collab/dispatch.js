import { randomUUID } from 'node:crypto';
import { MAX_TOPIC_CHARS, isIdentityName, isPresentationText } from '../net/protocol.js';
import { shortSessionId } from '../util/short-id.js';
import { gateValueOf } from './confirm-gate.js';

/* dispatch 内存域：与 managed / forum 同级的第三种模式，但不进 state.collabs、不写任何协作文件。
 * 状态全部在 state.dispatches（Map<collabId, record>）。本模块只做纯内存判定与组帧；
 * 消息投递经注入的 notify（routing.notify），不碰 LAN 出站队列 / 本机席位注入 / inbox 落盘。 */

export const DISPATCH_MESSAGE_TYPES = ['task', 'progress', 'result', 'error'];
export const DISPATCH_QUEUE_MAX = 256;
export const DISPATCH_CLAIM_TTL_MS = 10 * 60 * 1000;
export const DISPATCH_MEMBER_EVENT_DEBOUNCE_MS = 500;
/* 桥断开宽限（与席位宽限同源配置，缺省与 service 的 DEFAULT_SEAT_GRACE_MS 对齐）。 */
const DISPATCH_GRACE_MS = 60 * 1000;

export function createDispatchDomain(deps) {
  const { state, now = Date.now } = deps;
  const sessionMetaOf = deps.sessionMetaOf ?? (() => null);
  const listSessionIds = deps.listSessionIds ?? (() => []);
  const metaOf = (sessionId) => normalizeMeta(sessionMetaOf(sessionId), sessionId);
  /* 交互式判定只看「会话文件在档 + kind=interactive」：文件 mtime 的 5 分钟新鲜度上限
   * 已移除——Claude Code 不持续触碰会话文件，空闲数分钟的真实会话会被误判不可收编
   * （2026-10-30 实测：活跃会话被判 claimable=false）。活没活由桥连接性把关（注册表
   * 只含已连桥，断开即出列），文件新鲜度不承担存活判定。 */
  const isInteractiveOf = (meta) => meta !== null
    && meta.kind === 'interactive'
    && meta.metaUpdatedAt > 0;
  const masterDispatchOf = (sessionId) => masterDispatchOfIn(state, sessionId);
  const dispatchOf = (sessionId) => dispatchOfIn(state, sessionId, masterDispatchOf);
  /* 注入面运行期容器：notify 是唯一投递出口（未注入＝队列兜底，绝不静默丢弃），
   * log 只记投递异常与队列溢出，config 提供可选的容量参数（缺省用本模块常量）。 */
  const runtime = {
    state,
    config: deps.config ?? {},
    log: deps.log ?? null,
    notify: typeof deps.notify === 'function' ? deps.notify : null,
    now,
    metaOf,
    isInteractiveOf,
    masterDispatchOf,
    dispatchOf,
    listSessionIds,
  };
  return dispatchApiOf(runtime);
}

/* 域入口表：读面（list / status / isDispatch）＋写面（create / claim / send / end / leave / sweep）——
 * 全部经 runtime 取注入面，闭包不直接捕获 deps。 */
function dispatchApiOf(runtime) {
  const { state, now, metaOf, isInteractiveOf, masterDispatchOf, dispatchOf } = runtime;
  return {
    dispatches: state.dispatches,
    metaOf,
    isInteractiveOf,
    masterDispatchOf,
    dispatchOf,
    create: (input) => {
      const created = createDispatchIn(runtime, input);
      if (created.ok && created.autoClaim) {
        autoClaimPassIn(runtime, runtime.state.dispatches.get(created.collabId));
      }
      return created;
    },
    scan: (input) => scanSessionsIn(runtime, input),
    claim: (input) => claimSessionsIn(runtime, input),
    approve: (input) => approveClaimIn(runtime, input),
    release: (input) => releaseSlaveIn(runtime, input),
    send: (input) => sendMessageIn(runtime, input),
    end: (input) => endDispatchIn(runtime, input),
    leave: (input) => leaveDispatchIn(runtime, input),
    noteBridgeOnline: (sessionId) => noteBridgeOnlineIn(runtime, sessionId),
    noteBridgeClosed: (sessionId, at = now()) => noteBridgeClosedIn(runtime, sessionId, at),
    sweep: (at = now()) => sweepDispatchesIn(runtime, at),
    list: () => listDispatchesIn(state),
    describe: (collabId) => describeDispatchIn(state, collabId),
    view: (collabId) => viewDispatchIn(state, collabId),
    status: () => statusOfDispatches(state),
    isDispatch: (collabId) => state.dispatches.has(collabId),
  };
}

/* 会话元数据归一（桥上报的原始记录 → dispatch 域内形状）：名字非法时用会话短码兜底
 * （不是完整 sessionId——全量标识适合定位、不适合展示）。 */
function normalizeMeta(raw, sessionId) {
  if (!isMetaRecord(raw)) {
    return null;
  }
  return {
    sessionId,
    name: metaNameOf(raw, sessionId),
    kind: kindOf(raw.kind),
    entrypoint: textOrNull(raw.entrypoint),
    status: textOrNull(raw.status),
    role: roleOf(raw.role),
    masterName: isIdentityName(raw.masterName) ? raw.masterName.trim() : null,
    metaUpdatedAt: Number.isFinite(raw.metaUpdatedAt) ? raw.metaUpdatedAt : 0,
    online: raw.online !== false,
  };
}

function isMetaRecord(value) {
  return value !== null && value !== undefined && typeof value === 'object';
}

function metaNameOf(raw, sessionId) {
  return isIdentityName(raw.name) ? raw.name.trim() : shortSessionId(sessionId);
}

function textOrNull(value) {
  return typeof value === 'string' ? value : null;
}

/* kind 词表保留三态：交互式（可确认）与无头 bg（无人可确认）必须可区分，
 * 只有未知 / 缺失才回退 unknown——把 bg 吞成 unknown 会让拒绝理由失真。 */
function kindOf(value) {
  if (value === 'interactive' || value === 'bg') {
    return value;
  }
  return 'unknown';
}

function roleOf(value) {
  return value === 'master' || value === 'slave' ? value : 'none';
}

function masterDispatchOfIn(state, sessionId) {
  for (const record of state.dispatches.values()) {
    if (record.masterSessionId === sessionId) {
      return record;
    }
  }
  return null;
}

function dispatchOfIn(state, sessionId, masterDispatchOf) {
  const master = masterDispatchOf(sessionId);
  if (master !== null) {
    return master;
  }
  for (const record of state.dispatches.values()) {
    if (record.slaves.has(sessionId)) {
      return record;
    }
  }
  return null;
}

/* autoClaim：创建即扫描收编一次，之后随 presence 节拍的 sweep 持续补收新会话；可绑定判定与
 * claim 成功路径同口径（slave / 门 off 的交互式）——门开着的交互式会话绝不替人弹确认。
 * 移除面不新增机制：slave 桥断开超宽限由既有 sweepGraceOf 自动移除并通告。 */
function createDispatchIn(runtime, { name, topic, sessionId, autoClaim }) {
  const { state, metaOf, now } = runtime;
  const meta = metaOf(sessionId);
  if (meta === null || meta.role !== 'master') {
    return { ok: false, message: 'dispatch 只能由启动期 WAYSTATION_ROLE=master 的会话创建——工具参数与聊天内容不能声明 master 角色' };
  }
  if (state.dispatches.size > 0) {
    return { ok: false, message: '一个核心同一时刻只允许一个 dispatch——先结束现有 dispatch' };
  }
  if (!isIdentityName(name)) {
    return { ok: false, message: 'dispatch 名称非法：需要 1–64 字符且不含控制字符' };
  }
  if (topic !== undefined && topic !== null && !isPresentationText(topic, MAX_TOPIC_CHARS)) {
    return { ok: false, message: `dispatch 主题非法：需要不超过 ${MAX_TOPIC_CHARS} 字符` };
  }
  const collabId = randomUUID();
  const record = {
    collabId,
    mode: 'dispatch',
    ephemeral: true,
    name: name.trim(),
    topic: typeof topic === 'string' && topic.trim() !== '' ? topic.trim() : null,
    masterSessionId: sessionId,
    masterName: meta.name,
    autoClaim: autoClaim === true,
    createdAt: new Date(now()).toISOString(),
    slaves: new Map(),
    claims: new Map(),
    queues: new Map(),
    grace: new Map(),
    pendingEvents: [],
    eventTimer: null,
  };
  state.dispatches.set(collabId, record);
  return { ok: true, collabId, mode: 'dispatch', ephemeral: true, name: record.name, topic: record.topic, autoClaim: record.autoClaim };
}

/* 一轮自动收编：跳过 master 自身 / 已绑定 / 有在途确认申请 / 预检不过的目标；
 * 只直绑免确认可绑定的（slave，或 claim 门 off 的交互式）——门开时保持沉默。 */
function autoClaimPassIn(runtime, record) {
  const { metaOf, listSessionIds } = runtime;
  for (const target of listSessionIds()) {
    if (target === record.masterSessionId || record.slaves.has(target)) {
      continue;
    }
    if ([...record.claims.values()].some((entry) => entry.targetSessionId === target)) {
      continue;
    }
    const meta = metaOf(target);
    if (meta === null) {
      continue;
    }
    if (claimPrecheckOf(record, record.masterSessionId, meta, target) !== null) {
      continue;
    }
    const bindable = meta.role === 'slave'
      || (runtime.isInteractiveOf(meta) && gateValueOf(runtime.state, target, 'claim').effectiveValue === false);
    if (bindable) {
      bindSlave(runtime, record, meta);
    }
  }
}

/* scan 判定与 claim 判定同口径：claimable = role=slave（免确认绑定）或交互式元数据新鲜。
 * 不可收编条目仍列出（如实呈现本机注册面），由 claimable 字段引导 master 认领正确目标。 */
function scanSessionsIn(runtime, { sessionId }) {
  const { masterDispatchOf, metaOf, listSessionIds, isInteractiveOf } = runtime;
  const record = masterDispatchOf(sessionId);
  if (record === null) {
    return { ok: false, code: 'dispatch-lost', message: 'dispatch 不存在（可能已结束或核心已重启）——请重新创建' };
  }
  const sessions = [];
  for (const target of listSessionIds()) {
    if (target === sessionId) {
      continue;
    }
    const meta = metaOf(target);
    if (meta === null) {
      continue;
    }
    /* 只列可收编目标：role=slave 或交互式（会话文件在档）。不可收编条目（其他 master、
     * 无会话文件的子代理桥、非交互无角色）不列出——scan 是 master 的收编视野，不是注册表全量。 */
    if (meta.role === 'master' || !(meta.role === 'slave' || isInteractiveOf(meta))) {
      continue;
    }
    sessions.push({
      sessionId: target,
      name: meta.name,
      kind: meta.kind,
      entrypoint: meta.entrypoint,
      role: meta.role,
      status: meta.status,
      claimedBy: record.slaves.has(target) ? record.masterSessionId : null,
      claimable: true,
    });
  }
  return { ok: true, dispatchId: record.collabId, sessions };
}

function listDispatchesIn(state) {
  return [...state.dispatches.values()].map((record) => ({
    collabId: record.collabId,
    name: record.name,
    mode: 'dispatch',
    ephemeral: true,
    topic: record.topic,
    masterSessionId: record.masterSessionId,
    slaveCount: record.slaves.size,
    createdAt: record.createdAt,
  }));
}

function describeDispatchIn(state, collabId) {
  const record = state.dispatches.get(collabId);
  if (record === undefined) {
    return null;
  }
  return { collabId, name: record.name, mode: 'dispatch', ephemeral: true, topic: record.topic };
}

function viewDispatchIn(state, collabId) {
  const record = state.dispatches.get(collabId);
  if (record === undefined) {
    return { ok: false, message: '本机没有该 dispatch（可能已结束或核心已重启）' };
  }
  return {
    ok: true, collabId, mode: 'dispatch', ephemeral: true,
    message: 'dispatch 不保存历史：无台账、无帖、无收件流水、无观察窗回放',
  };
}

function statusOfDispatches(state) {
  const records = [...state.dispatches.values()];
  if (records.length === 0) {
    return { ok: true, dispatch: null };
  }
  const record = records[0];
  return {
    ok: true,
    dispatch: {
      collabId: record.collabId,
      name: record.name,
      masterSessionId: record.masterSessionId,
      slaves: [...record.slaves.values()].map((slave) => ({
        sessionId: slave.sessionId, name: slave.name, kind: slave.kind,
      })),
    },
  };
}

/* —— 收编判定（claim / approve / release）与通知投递 —— */

function dispatchLost() {
  return { ok: false, code: 'dispatch-lost', message: 'dispatch 不存在（可能已结束或核心已重启）' };
}

function rejectedClaim(sessionId, reason) {
  return { sessionId, status: 'rejected', reason };
}

function claimSessionsIn(runtime, { sessionId, sessionIds }) {
  const record = runtime.masterDispatchOf(sessionId);
  if (record === null) {
    return dispatchLost();
  }
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
    return { ok: false, message: 'sessionIds 非法：需要非空数组' };
  }
  const results = [];
  for (const targetSessionId of [...new Set(sessionIds)]) {
    results.push(claimTargetOf(runtime, record, sessionId, targetSessionId));
  }
  return { ok: true, dispatchId: record.collabId, results };
}

/* 单目标判定表：预检（在线 / 身份 / 已绑定 / 白名单）→ 直接绑定 / 待确认 / 拒绝。 */
function claimTargetOf(runtime, record, masterSessionId, targetSessionId) {
  const target = runtime.metaOf(targetSessionId);
  const precheck = claimPrecheckOf(record, masterSessionId, target, targetSessionId);
  if (precheck !== null) {
    return precheck;
  }
  if (target.role === 'slave') {
    bindSlave(runtime, record, target);
    return { sessionId: targetSessionId, status: 'bound' };
  }
  if (runtime.isInteractiveOf(target)) {
    /* claim 门 off（与邀请 / 加入门同族的第三道门）：收编免人工确认——直接绑定并注入
     * 知情通知，不进 pending（本机设置已表态，master 手动 claim 与 autoClaim 同待遇）。 */
    if (gateValueOf(runtime.state, targetSessionId, 'claim').effectiveValue === false) {
      bindSlave(runtime, record, target);
      sendNotice(
        runtime,
        record,
        targetSessionId,
        `已按本机设置自动同意 master「${record.masterName}」的收编（要退出用 ws_leave_collab）`,
        'dispatch-claim-auto',
      );
      return { sessionId: targetSessionId, status: 'bound' };
    }
    return pendingClaimOf(runtime, record, masterSessionId, targetSessionId);
  }
  return rejectedClaim(targetSessionId, '非交互式会话且未带 WAYSTATION_ROLE=slave——没有人可确认（可收编目标在 ws_dispatch_scan 中标 claimable: true）');
}

/* 返回非 null 即终局（拒绝或已绑定），null 表示继续按角色 / 交互性分流。 */
function claimPrecheckOf(record, masterSessionId, target, targetSessionId) {
  if (target === null || target.online !== true) {
    return rejectedClaim(targetSessionId, '本机会话不在线或不可见');
  }
  if (target.sessionId === masterSessionId || target.role === 'master') {
    return rejectedClaim(targetSessionId, '不能收编 master 自身或其他 master 会话');
  }
  if (record.slaves.has(targetSessionId)) {
    return { sessionId: targetSessionId, status: 'bound' };
  }
  if (target.masterName !== null && target.masterName !== record.masterName) {
    return rejectedClaim(targetSessionId, `该会话只接受 master「${target.masterName}」`);
  }
  return null;
}

/* 交互式首签：登记待确认申请并向目标注入提示（目标会话的模型转述给本机用户）。 */
function pendingClaimOf(runtime, record, masterSessionId, targetSessionId) {
  const claimId = randomUUID();
  record.claims.set(claimId, {
    claimId,
    targetSessionId,
    masterSessionId,
    expiresAt: runtime.now() + DISPATCH_CLAIM_TTL_MS,
    token: undefined,
  });
  sendNotice(
    runtime,
    record,
    targetSessionId,
    `master「${record.masterName}」请求收编本会话，允许吗？确认请调用 ws_dispatch_approve { claimId: "${claimId}", approve: true }`,
    'dispatch-claim',
  );
  return { sessionId: targetSessionId, status: 'pending', claimId };
}

function approveClaimIn(runtime, { sessionId, claimId, approve, confirmToken }) {
  const found = claimOf(runtime.state, claimId);
  if (found === null) {
    return { ok: false, message: '收编申请不存在、已过期或已处置' };
  }
  const { record, claim } = found;
  const refusal = claimRefusalOf(runtime, record, claim, sessionId, approve);
  if (refusal !== null) {
    return refusal;
  }
  if (approve === false) {
    return rejectPendingClaim(runtime, record, claimId);
  }
  /* 收编确认门（与邀请 / 加入门同族的第三道门）：目标会话的生效值为 off 时跳过令牌挑战
   * 直接绑定，仍注入一行知情通知（谁收编了你）；拒绝路径不受门影响。 */
  if (gateValueOf(runtime.state, sessionId, 'claim').effectiveValue === false) {
    const bound = bindApprovedClaim(runtime, record, claimId, sessionId);
    if (bound.ok) {
      sendNotice(
        runtime,
        record,
        sessionId,
        `已按本机设置自动同意 master「${record.masterName}」的收编（要退出用 ws_leave_collab）`,
        'dispatch-claim-auto',
      );
    }
    return bound;
  }
  const tokenRefusal = confirmTokenRefusalOf(runtime, record, claim, confirmToken);
  if (tokenRefusal !== null) {
    return tokenRefusal;
  }
  return bindApprovedClaim(runtime, record, claimId, sessionId);
}

/* 身份 / 时效 / 取值形态三判：拒绝直接给出终局结果；通过返回 null。 */
function claimRefusalOf(runtime, record, claim, sessionId, approve) {
  if (claim.targetSessionId !== sessionId) {
    return { ok: false, message: '只有被收编的目标会话可以确认该申请' };
  }
  if (runtime.now() >= claim.expiresAt) {
    record.claims.delete(claim.claimId);
    return { ok: false, message: '收编申请已超时——请让 master 重新发起' };
  }
  if (approve !== true && approve !== false) {
    return { ok: false, message: 'approve 须为布尔值' };
  }
  return null;
}

/* 拒绝是即时终局：释放申请并通知 master（拒绝不需要确认令牌）。 */
function rejectPendingClaim(runtime, record, claimId) {
  record.claims.delete(claimId);
  sendNotice(runtime, record, record.masterSessionId, `已拒绝 master「${record.masterName}」的收编请求`, 'dispatch-claim-rejected');
  return { ok: true, approved: false };
}

/* 一次性确认令牌：首次 approve:true 只签发不绑定；令牌只对目标会话有效，
 * 绑定时随申请一起删除（单次使用），令牌自身也有与申请相同的 10 分钟时限。 */
function confirmTokenRefusalOf(runtime, record, claim, confirmToken) {
  if (typeof confirmToken !== 'string' || confirmToken === '') {
    const token = randomUUID();
    claim.token = { value: token, expiresAt: runtime.now() + DISPATCH_CLAIM_TTL_MS };
    return {
      ok: false,
      needsUserConfirmation: true,
      confirmToken: token,
      summary: `master「${record.masterName}」请求收编本会话——这是模型转述的确认，不是带外硬人工门；请向本机用户确认后携令牌重试`,
    };
  }
  if (claim.token === undefined || claim.token.value !== confirmToken || claim.token.expiresAt <= runtime.now()) {
    return { ok: false, message: '确认令牌无效或已过期——请重新发起' };
  }
  return null;
}

function bindApprovedClaim(runtime, record, claimId, sessionId) {
  const target = runtime.metaOf(sessionId);
  if (target === null) {
    return { ok: false, message: '目标会话已不在本机注册表内——请让 master 重新发起' };
  }
  record.claims.delete(claimId);
  /* 加入事件统一由 bindSlave 入去抖队列——这里不再直发，避免同一成员被通知两次。 */
  bindSlave(runtime, record, target);
  return { ok: true, approved: true, bound: true, sessionId };
}

function releaseSlaveIn(runtime, { sessionId, targetSessionId }) {
  const record = runtime.masterDispatchOf(sessionId);
  if (record === null) {
    return dispatchLost();
  }
  const slave = record.slaves.get(targetSessionId);
  if (slave === undefined) {
    return { ok: false, message: '该会话不在本 dispatch 内' };
  }
  record.slaves.delete(targetSessionId);
  record.grace.delete(targetSessionId);
  sendNotice(runtime, record, targetSessionId, 'master 已释放本会话——dispatch 收编结束', 'dispatch-released');
  /* 释放后该会话不再属于本 dispatch（dispatchOf 也找不到它），待补投队列再无人 flush：
   * 连刚排入的释放通知一起回收，避免内存滞留。主调用的通知走 master 队列，不受影响。 */
  record.queues.delete(targetSessionId);
  /* 先把窗口内待发的加入事件送出去，保证 master 看到的顺序是「加入在前、离席在后」。 */
  flushMemberEvents(runtime, record);
  sendNotice(runtime, record, sessionId, `已释放「${slave.name}」`, 'dispatch-member-left');
  return { ok: true, sessionId: targetSessionId };
}

/* —— 纯内存消息（send / end / leave）与桥生命周期 —— */

/* 发送：master 可定向或广播给已收编 slave，slave 只能回 master（省略 toSessionIds 即回 master）。
 * 投递唯一出口是 runtime.notify；notify 返回 false 时按目标入有界队列，桥重连（noteBridgeOnline）补投。
 * 消息不落盘、不经 LAN 出站队列、不做本机席位注入——这是 dispatch 与 managed / forum 的根本差异。 */
function sendMessageIn(runtime, { collabId, sessionId, text, type, toSessionIds, taskId }) {
  const record = runtime.state.dispatches.get(collabId);
  if (record === undefined) {
    return dispatchLost();
  }
  const sender = runtime.metaOf(sessionId);
  if (sender === null) {
    return { ok: false, message: '调用会话不在本机注册表内' };
  }
  const targets = sendTargetsOf(record, sessionId, toSessionIds);
  if (targets.error !== undefined) {
    return { ok: false, message: targets.error };
  }
  const message = messageOf(record, { text, type, taskId, sessionId }, sender);
  if (message.error !== undefined) {
    return { ok: false, message: message.error };
  }
  return deliverMessage(runtime, record, targets.value, message.value);
}

/* 正文 / 类型 / taskId 的判定与出站文本组装。slave 的回复带 @来源——master 收到的是多条
 * slave 消息混流，纯文本无法区分说话者。 */
function messageOf(record, { text, type, taskId, sessionId }, sender) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { error: 'text 非法：需要非空白字符串' };
  }
  const messageType = type === undefined
    ? (sessionId === record.masterSessionId ? 'task' : 'result')
    : type;
  if (!DISPATCH_MESSAGE_TYPES.includes(messageType)) {
    return { error: `type 非法：dispatch 可取值为 ${DISPATCH_MESSAGE_TYPES.join(' / ')}` };
  }
  if (taskId !== undefined && !isDispatchTaskId(taskId)) {
    return { error: 'taskId 非法：需要 1–64 字符的非空白字符串' };
  }
  const outbound = sessionId === record.masterSessionId ? text : `@${sender.name} ${text}`;
  return {
    value: {
      messageType, taskId: taskId ?? null, outbound, fromSessionId: sessionId, fromSessionName: sender.name,
    },
  };
}

function isDispatchTaskId(taskId) {
  return typeof taskId === 'string' && taskId.trim() !== '' && taskId.length <= 64;
}

/* 投递循环：notify 成功即送达；失败入按目标分桶的有界队列（桥重连补投），不静默丢弃。 */
function deliverMessage(runtime, record, targets, message) {
  let delivered = 0;
  let queued = 0;
  for (const target of targets) {
    const frame = noticeFrame(runtime, record, target, message.outbound, 'dispatch-message');
    frame.payload.messageType = message.messageType;
    frame.payload.taskId = message.taskId;
    frame.payload.fromSessionId = message.fromSessionId;
    frame.payload.fromSessionName = message.fromSessionName;
    if (notifyOnce(runtime, frame)) {
      delivered++;
    } else {
      enqueue(runtime, record, target, frame);
      queued++;
    }
  }
  return { ok: true, dispatchId: record.collabId, delivered, queued, targets };
}

/* 路由判定：返回 { value: targets } 或 { error }。master 定向到非成员 / slave 越权回复 /
 * 非成员发送都必须如实拒绝——静默丢消息比拒绝更难排查。 */
function sendTargetsOf(record, sessionId, toSessionIds) {
  const refusal = toSessionIdsRefusalOf(toSessionIds);
  if (refusal !== null) {
    return { error: refusal };
  }
  return sessionId === record.masterSessionId
    ? masterTargetsOf(record, toSessionIds)
    : slaveTargetsOf(record, sessionId, toSessionIds);
}

/* toSessionIds 形状：未给＝按绑定路由（master 广播 / slave 回 master）；显式给出时必须是非空
 * 字符串数组——空数组既不等于「省略」也不该落到误导性的「目标不在 dispatch 内」判定。 */
function toSessionIdsRefusalOf(toSessionIds) {
  if (toSessionIds === undefined) {
    return null;
  }
  if (!Array.isArray(toSessionIds) || toSessionIds.length === 0) {
    return 'toSessionIds 非法：需要非空字符串数组（省略即按绑定路由）';
  }
  return toSessionIds.every((id) => typeof id === 'string' && id.trim() !== '')
    ? null
    : 'toSessionIds 非法：需要非空字符串数组';
}

function masterTargetsOf(record, toSessionIds) {
  const requested = toSessionIds !== undefined && toSessionIds.length > 0
    ? [...new Set(toSessionIds)]
    : [...record.slaves.keys()];
  if (requested.length === 0) {
    return { error: 'dispatch 内没有已收编的 slave' };
  }
  const invalid = requested.find((target) => !record.slaves.has(target));
  return invalid === undefined
    ? { value: requested }
    : { error: `目标会话不在本 dispatch 内：${invalid}` };
}

function slaveTargetsOf(record, sessionId, toSessionIds) {
  if (!record.slaves.has(sessionId)) {
    return { error: '本会话不是该 dispatch 的成员' };
  }
  if (Array.isArray(toSessionIds) && toSessionIds.length > 0
    && (toSessionIds.length !== 1 || toSessionIds[0] !== record.masterSessionId)) {
    return { error: 'slave 只能回复 master，不能给其他 slave 发消息' };
  }
  return { value: [record.masterSessionId] };
}

/* 结束（master 专属）：先向每个 slave 与 master 发结束通知，再从内存域删除整条记录
 * （队列随之回收；核心重启后本就没有持久面）。 */
function endDispatchIn(runtime, { collabId, sessionId }) {
  const record = runtime.state.dispatches.get(collabId);
  if (record === undefined) {
    return dispatchLost();
  }
  if (record.masterSessionId !== sessionId) {
    return { ok: false, message: '只有 master 可以结束 dispatch' };
  }
  endDispatch(runtime, record, 'master-ended');
  return { ok: true, collabId };
}

function endDispatch(runtime, record, reason) {
  for (const sessionId of [...record.slaves.keys()]) {
    sendNotice(runtime, record, sessionId, `dispatch「${record.name}」已结束（${reason}）`, 'dispatch-ended');
  }
  sendNotice(runtime, record, record.masterSessionId, `dispatch「${record.name}」已结束`, 'dispatch-ended');
  clearTimeout(record.eventTimer);
  runtime.state.dispatches.delete(record.collabId);
}

/* 退出（slave 专属）：只移除自己并通知 master；master 退出即「结束」，必须走 ws_end_collab。 */
function leaveDispatchIn(runtime, { collabId, sessionId }) {
  const record = runtime.state.dispatches.get(collabId);
  if (record === undefined) {
    return dispatchLost();
  }
  if (record.masterSessionId === sessionId) {
    return { ok: false, message: 'master 不能被 leave——结束请用 ws_end_collab' };
  }
  const slave = record.slaves.get(sessionId);
  if (slave === undefined) {
    return { ok: false, message: '本会话不在该 dispatch 内' };
  }
  record.slaves.delete(sessionId);
  record.grace.delete(sessionId);
  record.queues.delete(sessionId);
  flushMemberEvents(runtime, record);
  sendNotice(runtime, record, record.masterSessionId, `「${slave.name}」已退出 dispatch`, 'dispatch-member-left');
  return { ok: true, collabId };
}

/* 桥重连：撤销宽限并把断连期间排队的通知补投（notify 恢复后即可达）。 */
function noteBridgeOnlineIn(runtime, sessionId) {
  const record = runtime.dispatchOf(sessionId);
  if (record === null) {
    return;
  }
  record.grace.delete(sessionId);
  flushQueue(runtime, record, sessionId);
}

/* 桥断开：登记宽限截止时刻，超时由 sweep 收口（master 超时＝整个 dispatch 结束）。 */
function noteBridgeClosedIn(runtime, sessionId, at) {
  const record = runtime.dispatchOf(sessionId);
  if (record === null) {
    return;
  }
  record.grace.set(sessionId, at + graceMsOf(runtime.config));
}

function graceMsOf(config) {
  const value = config?.sessionSeatGraceMs;
  return Number.isInteger(value) && value >= 0 ? value : DISPATCH_GRACE_MS;
}

/* 清扫（presence 节拍驱动）：过期收编申请 + 桥断开宽限超时。核心重启后两本内存账一起清空。 */
function sweepDispatchesIn(runtime, at) {
  for (const record of [...runtime.state.dispatches.values()]) {
    if (!runtime.state.dispatches.has(record.collabId)) {
      continue;
    }
    sweepClaimsOf(runtime, record, at);
    sweepGraceOf(runtime, record, at);
    if (record.autoClaim) {
      autoClaimPassIn(runtime, record);
    }
  }
}

/* 宽限超时：master 超时＝整个 dispatch 结束（结束通知不合并）；slave 超时先移除再统一通告。
 * 单个超时保持既有直发 member-left（同步语义）；同一节拍多个超时合并成一条成员事件，
 * 避免一次清扫刷屏。 */
function sweepGraceOf(runtime, record, at) {
  const expired = [];
  for (const [sessionId, deadline] of [...record.grace]) {
    if (deadline > at) {
      continue;
    }
    if (sessionId === record.masterSessionId) {
      endDispatch(runtime, record, 'master-timeout');
      return;
    }
    const slave = record.slaves.get(sessionId);
    record.slaves.delete(sessionId);
    record.grace.delete(sessionId);
    record.queues.delete(sessionId);
    expired.push(slave?.name ?? sessionId);
  }
  notifyGraceTimeouts(runtime, record, expired);
}

function notifyGraceTimeouts(runtime, record, expired) {
  if (expired.length === 0) {
    return;
  }
  /* 先送窗口内待发的加入事件：成员先加入后超时，顺序不得倒置。 */
  flushMemberEvents(runtime, record);
  if (expired.length === 1) {
    sendNotice(runtime, record, record.masterSessionId, `「${expired[0]}」宽限超时离席`, 'dispatch-member-left');
    return;
  }
  for (const name of expired) {
    queueMemberEvent(runtime, record, `「${name}」宽限超时离席`);
  }
}

function sweepClaimsOf(runtime, record, at) {
  for (const [claimId, claim] of [...record.claims]) {
    if (claim.expiresAt > at) {
      continue;
    }
    record.claims.delete(claimId);
    sendNotice(runtime, record, record.masterSessionId, `收编申请已超时：${claim.targetSessionId}`, 'dispatch-claim-expired');
  }
}

/* 绑定收尾：登记 slave、清宽限标记，并把断连期间排队的通知补投（notify 恢复后即可达）。
 * 加入事件入 500ms 去抖队列（批量收编时合并成一条），不再逐成员直发。 */
function bindSlave(runtime, record, meta) {
  record.slaves.set(meta.sessionId, {
    sessionId: meta.sessionId, name: meta.name, kind: meta.kind, role: meta.role, boundAt: runtime.now(),
  });
  record.grace.delete(meta.sessionId);
  flushQueue(runtime, record, meta.sessionId);
  queueMemberEvent(runtime, record, `「${meta.name}」已加入`);
}

/* 成员事件去抖：同一 500ms 窗口内的加入 / 批量离席文本合并成一条 dispatch-member-event 投给 master。
 * 定时器 unref，不拖住进程；dispatch 结束时由 endDispatch 清除。离席的单个事件仍走既有直发
 * （Task 2/5 的同步口径），但投递前会 flush 本队列，保证「先加入、后离席」的顺序。 */
function queueMemberEvent(runtime, record, text) {
  record.pendingEvents.push(text);
  if (record.eventTimer !== null) {
    return;
  }
  const timer = setTimeout(() => {
    record.eventTimer = null;
    flushMemberEvents(runtime, record);
  }, DISPATCH_MEMBER_EVENT_DEBOUNCE_MS);
  timer.unref?.();
  record.eventTimer = timer;
}

function flushMemberEvents(runtime, record) {
  if (record.pendingEvents.length === 0) {
    return;
  }
  if (record.eventTimer !== null) {
    clearTimeout(record.eventTimer);
    record.eventTimer = null;
  }
  const text = record.pendingEvents.join('；');
  record.pendingEvents.length = 0;
  sendNotice(runtime, record, record.masterSessionId, text, 'dispatch-member-event');
}

function claimOf(state, claimId) {
  for (const record of state.dispatches.values()) {
    const claim = record.claims.get(claimId);
    if (claim !== undefined) {
      return { record, claim };
    }
  }
  return null;
}

function noticeFrame(runtime, record, targetSessionId, text, event) {
  return {
    v: 1,
    type: 'notice',
    msgId: randomUUID(),
    from: { instanceId: runtime.state.self.instanceId, identityName: record.name, sessionId: record.masterSessionId },
    collabId: record.collabId,
    ts: new Date(runtime.now()).toISOString(),
    payload: { event, text, targetSessionId },
  };
}

/* 投递出口：notify 返回 true 才算送达；未注入 / 返回 false / 抛异常一律转入待补投队列，
 * 不得静默丢失（核心的 notify 在桥重连后仍可 flush）。 */
function sendNotice(runtime, record, targetSessionId, text, event) {
  const frame = noticeFrame(runtime, record, targetSessionId, text, event);
  if (notifyOnce(runtime, frame)) {
    return;
  }
  enqueue(runtime, record, targetSessionId, frame);
}

function notifyOnce(runtime, frame) {
  if (runtime.notify === null) {
    return false;
  }
  try {
    return runtime.notify(frame) === true;
  } catch (error) {
    runtime.log?.warn?.('dispatch 通知投递异常（转入待补投队列）', {
      collabId: frame.collabId, targetSessionId: frame.payload?.targetSessionId, reason: error?.message,
    });
    return false;
  }
}

function enqueue(runtime, record, targetSessionId, frame) {
  const queue = record.queues.get(targetSessionId) ?? [];
  if (queue.length >= queueLimitOf(runtime.config)) {
    queue.shift();
    runtime.state.counters.dispatchQueueDropped = (runtime.state.counters.dispatchQueueDropped ?? 0) + 1;
    runtime.log?.warn?.('dispatch 通知队列已满，丢弃最旧一条', { collabId: record.collabId, targetSessionId });
  }
  queue.push(frame);
  record.queues.set(targetSessionId, queue);
}

/* 通知队列容量：缺省用本模块常量；配置可经 dispatchQueueMax 收紧 / 放宽（未知键原样保留在生效配置）。 */
function queueLimitOf(config) {
  const limit = config?.dispatchQueueMax;
  return Number.isInteger(limit) && limit > 0 ? limit : DISPATCH_QUEUE_MAX;
}

function flushQueue(runtime, record, targetSessionId) {
  const queue = record.queues.get(targetSessionId);
  if (queue === undefined) {
    return;
  }
  while (queue.length > 0 && notifyOnce(runtime, queue[0])) {
    queue.shift();
  }
  if (queue.length === 0) {
    record.queues.delete(targetSessionId);
  }
}
