import { randomUUID } from 'node:crypto';
import { MAX_TOPIC_CHARS, isIdentityName, isPresentationText } from '../net/protocol.js';
import { shortSessionId } from '../util/short-id.js';

/* dispatch 内存域：与 managed / forum 同级的第三种模式，但不进 state.collabs、不写任何协作文件。
 * 状态全部在 state.dispatches（Map<collabId, record>）。本模块只做纯内存判定与组帧；
 * 消息投递经注入的 notify（routing.notify），不碰 LAN 出站队列 / 本机席位注入 / inbox 落盘。 */

export const DISPATCH_MESSAGE_TYPES = ['task', 'progress', 'result', 'error'];
export const DISPATCH_QUEUE_MAX = 256;
export const DISPATCH_CLAIM_TTL_MS = 10 * 60 * 1000;
export const DISPATCH_META_FRESH_MS = 5 * 60 * 1000;
export const DISPATCH_MEMBER_EVENT_DEBOUNCE_MS = 500;

export function createDispatchDomain(deps) {
  const { state, now = Date.now } = deps;
  const sessionMetaOf = deps.sessionMetaOf ?? (() => null);
  const listSessionIds = deps.listSessionIds ?? (() => []);
  const metaOf = (sessionId) => normalizeMeta(sessionMetaOf(sessionId), sessionId);
  const isInteractiveOf = (meta) => meta !== null
    && meta.kind === 'interactive'
    && meta.metaUpdatedAt > 0
    && now() - meta.metaUpdatedAt <= DISPATCH_META_FRESH_MS;
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
  };
  return {
    dispatches: state.dispatches,
    metaOf,
    isInteractiveOf,
    masterDispatchOf,
    dispatchOf,
    create: (input) => createDispatchIn(state, metaOf, now, input),
    scan: (input) => scanSessionsIn(state, masterDispatchOf, metaOf, listSessionIds, input),
    claim: (input) => claimSessionsIn(runtime, input),
    approve: (input) => approveClaimIn(runtime, input),
    release: (input) => releaseSlaveIn(runtime, input),
    sweep: (at = now()) => sweepClaimsIn(runtime, at),
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

function createDispatchIn(state, metaOf, now, { name, topic, sessionId }) {
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
    createdAt: new Date(now()).toISOString(),
    slaves: new Map(),
    claims: new Map(),
    queues: new Map(),
    grace: new Map(),
    pendingEvents: [],
    eventTimer: null,
  };
  state.dispatches.set(collabId, record);
  return { ok: true, collabId, mode: 'dispatch', ephemeral: true, name: record.name, topic: record.topic };
}

function scanSessionsIn(state, masterDispatchOf, metaOf, listSessionIds, { sessionId }) {
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
    sessions.push({
      sessionId: target,
      name: meta.name,
      kind: meta.kind,
      entrypoint: meta.entrypoint,
      role: meta.role,
      status: meta.status,
      claimedBy: record.slaves.has(target) ? record.masterSessionId : null,
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
    return pendingClaimOf(runtime, record, masterSessionId, targetSessionId);
  }
  return rejectedClaim(targetSessionId, '非交互式会话且未带 WAYSTATION_ROLE=slave——没有人可确认');
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
  bindSlave(runtime, record, target);
  sendNotice(runtime, record, record.masterSessionId, `「${target.name}」已加入 dispatch`, 'dispatch-member-joined');
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
  sendNotice(runtime, record, sessionId, `已释放「${slave.name}」`, 'dispatch-member-left');
  return { ok: true, sessionId: targetSessionId };
}

/* 申请 TTL 清扫（presence 节拍驱动；核心重启后 claims 随内存清空，不另有持久面）。 */
function sweepClaimsIn(runtime, at) {
  for (const record of [...runtime.state.dispatches.values()]) {
    sweepClaimsOf(runtime, record, at);
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

/* 绑定收尾：登记 slave、清宽限标记，并把断连期间排队的通知补投（notify 恢复后即可达）。 */
function bindSlave(runtime, record, meta) {
  record.slaves.set(meta.sessionId, {
    sessionId: meta.sessionId, name: meta.name, kind: meta.kind, role: meta.role, boundAt: runtime.now(),
  });
  record.grace.delete(meta.sessionId);
  flushQueue(runtime, record, meta.sessionId);
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
