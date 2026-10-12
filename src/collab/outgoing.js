import { isIP } from 'node:net';
import { ID_PATTERN, MAX_COLLAB_MEMBERS, MAX_MESSAGE_TEXT_CHARS, MAX_REASON_CHARS, MAX_TOPIC_CHARS, isIdentityName, isPresentationText } from '../net/protocol.js';
import { MAX_LOCAL_COLLABS, canTransition, isArchived, newCollabId } from './model.js';
import { ledgerDigest } from './store.js';
import { isLocalArchivedState, localNameOf, localRosterOf, localStateOf, persistLedger, persistMember, persistSnapshot, rememberKnownHost } from './local.js';
import { matchConflictCollabs } from './gate.js';

/* 对外操作与协作态变更实现（服务公共 API 的落点）：请求来自本机会话（工具面）——
 * 参数不符合即返回 { ok:false, message }（由工具层呈现为 isError）；发送一律经注入的
 * dispatch.send（可靠队列），单条入队失败只计数不回滚已完成的本地状态。 */

/* 可投递成员状态集（消息广播与通告的收件人口径）。 */
const MESSAGING_MEMBER_STATES = ['invited', 'approved', 'member'];

export function createCollab(state, { name, topic, targets }) {
  const rejected = createRejection(state, name, topic, targets);
  if (rejected !== null) {
    return { ok: false, message: rejected };
  }
  const now = new Date().toISOString();
  const ledger = {
    version: 1,
    collabId: newCollabId(),
    name,
    topic,
    status: 'proposed',
    manager: { instanceId: state.self.instanceId, identityName: state.self.identityName },
    members: [
      { instanceId: state.self.instanceId, identityName: state.self.identityName, role: 'manager', state: 'member', joinedAt: now },
      ...targets.map((target) => ({ instanceId: target.instanceId, identityName: target.identityName, role: 'member', state: 'invited', joinedAt: now })),
    ],
    board: [],
    createdAt: now,
    updatedAt: now,
  };
  const local = { collabId: ledger.collabId, role: 'manager', ledger, member: managerRecordOf(ledger), endpoints: new Map(), snapshot: null };
  for (const target of targets) {
    local.endpoints.set(target.instanceId, { address: target.address, port: target.port });
    rememberKnownHost(state, { address: target.address, port: target.port, instanceId: target.instanceId, identityName: target.identityName });
  }
  local.member.endpoints = Object.fromEntries(local.endpoints);
  state.collabs.set(ledger.collabId, local);
  persistMember(state, local);
  persistLedger(state, local);
  const invited = [];
  for (const target of targets) {
    const result = sendTo(state, ledger.collabId, target.instanceId, { address: target.address, port: target.port }, 'invite', invitePayloadOf(ledger));
    invited.push({ instanceId: target.instanceId, ok: result.ok === true, msgId: result.msgId, reason: result.reason });
    state.counters.invitesSent++;
  }
  state.counters.collabsCreated++;
  return { ok: true, collabId: ledger.collabId, invited };
}

export function approveInvite(state, { collabId, approve, reason }) {
  const local = state.collabs.get(collabId);
  if (local === undefined) {
    return { ok: false, message: '本机没有该协作（collabId 不存在）——先看 ws_list_collabs' };
  }
  if (local.role !== 'member' || local.member.state !== 'proposed') {
    return { ok: false, message: '该协作不在待回应邀请状态' };
  }
  const wanted = approve ? 'approved' : 'declined';
  const decided = local.member.decision ?? null;
  if (decided === wanted) {
    return { ok: true, decision: wanted };
  }
  if (decided !== null) {
    return { ok: false, message: `已回应过（${decided}）——不能改口` };
  }
  return sendDecision(state, local, approve, wanted, reason);
}

/* 决策发帧：先定格 decision（本地状态即真相），再入队；管理者端点未知给出明确指引。
 * 拒绝原因按协议呈现判据先行校验（超限 / 换行在入队侧会被拒——不得先定格、后静默失败）。 */
function sendDecision(state, local, approve, wanted, reason) {
  const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
  if (!approve && trimmedReason !== '' && !isPresentationText(trimmedReason, MAX_REASON_CHARS)) {
    return { ok: false, message: `拒绝原因非法：需为 ≤${MAX_REASON_CHARS} 字符、不含换行 / 不可见字符的呈现文本` };
  }
  const endpoint = local.endpoints.get(local.member.manager.instanceId);
  if (endpoint === undefined) {
    return { ok: false, message: '管理者端点未知（邀请可能不完整）——请重新扫描后请对方重发邀请' };
  }
  local.member.decision = wanted;
  persistMember(state, local);
  const payload = approve || trimmedReason === '' ? {} : { reason: trimmedReason };
  const sent = sendTo(state, local.collabId, local.member.manager.instanceId, endpoint, approve ? 'approve' : 'decline', payload);
  state.counters.decisionsSent++;
  return { ok: true, decision: wanted, msgId: sent.msgId };
}

export function withdrawInvite(state, { collabId, target }) {
  const local = state.collabs.get(collabId);
  if (local === undefined || local.role !== 'manager') {
    return { ok: false, message: '只有管理席位可以撤回邀请' };
  }
  if (local.ledger.status !== 'proposed') {
    const hint = local.ledger.status === 'active' ? '协作已建立——结束请用 ws_end_collab' : '当前状态不可撤回';
    return { ok: false, message: hint };
  }
  const targetId = typeof target === 'string' && target.trim() !== '' ? target.trim() : null;
  return targetId === null ? withdrawAll(state, local) : withdrawOne(state, local, targetId);
}

export function sendMessage(state, { collabId, text, type, to }) {
  const local = state.collabs.get(collabId);
  if (local === undefined) {
    return { ok: false, message: '本机没有该协作（先 ws_list_collabs）' };
  }
  const messageType = type ?? 'reply';
  const stateName = localStateOf(local);
  if (stateName === 'frozen') {
    return { ok: false, message: '协作已冻结：仅允许读台账 / 裁定 / 退出 / 终止' };
  }
  if (isArchived(stateName)) {
    return { ok: false, message: '协作已结束（或已退出）——不再接受协作域消息' };
  }
  const textRejection = textRejectionOf(messageType, text);
  if (textRejection !== null) {
    return { ok: false, message: textRejection };
  }
  const routed = recipientsOf(state, local, to);
  if (routed.error !== undefined) {
    return { ok: false, message: routed.error };
  }
  if (messageType === 'topic' && local.role === 'manager') {
    mutateLedger(state, local, (ledger) => {
      ledger.topic = text;
    });
  }
  return deliverMessage(state, local, messageType, text, routed.targets);
}

/* 消息文本的服务层预校验（与协议校验器同一权威）：本机入口先行拒绝——绝不让「发送会被拒」
 * 的变更先落本地台账（非法主题会毒化台账行：重载时整行不过形态校验、后续变更静默回滚）。
 * 呈现面类型（topic / stop）按呈现文本判据；其余按正文上限。 */
function textRejectionOf(type, text) {
  const presentationMax = type === 'topic' ? MAX_TOPIC_CHARS : type === 'stop' ? MAX_REASON_CHARS : null;
  if (presentationMax !== null) {
    if (!isPresentationText(text, presentationMax)) {
      return `text 非法：需为非空、≤${presentationMax} 字符、不含换行 / 不可见字符的呈现文本`;
    }
    return null;
  }
  if (typeof text !== 'string' || text.trim() === '' || text.length > MAX_MESSAGE_TEXT_CHARS) {
    return `text 非法：需为非空、≤${MAX_MESSAGE_TEXT_CHARS} 字符`;
  }
  return null;
}

/* 逐目标入队与结果归并（部分成功按成功返回；全部失败给出逐目标原因）。 */
function deliverMessage(state, local, type, text, targets) {
  const payload = payloadOf(type, text);
  const results = targets.map((targetId) => sendToTarget(state, local, type, payload, targetId));
  const delivered = results.filter((entry) => entry.ok === true);
  if (delivered.length === 0) {
    return { ok: false, message: `消息未入队（${results.map((entry) => entry.reason ?? '未知原因').join('；')}）` };
  }
  return {
    ok: true,
    msgId: delivered[0].msgId,
    tier: 'queued',
    to: results.map((entry) => entry.instanceId),
    results,
    note: '已排队（对方离线时后台重试、对方重开后送达；档位可用 ws_delivery_status 查询）',
  };
}

function sendToTarget(state, local, type, payload, targetId) {
  const endpoint = local.endpoints.get(targetId);
  if (endpoint === undefined) {
    return { instanceId: targetId, ok: false, reason: '端点未知（先扫描或等对方联系）' };
  }
  const sent = sendTo(state, local.collabId, targetId, endpoint, type, payload);
  return { instanceId: targetId, ok: sent.ok === true, msgId: sent.msgId, reason: sent.reason };
}

export function endCollab(state, { collabId }) {
  const local = state.collabs.get(collabId);
  if (local === undefined || local.role !== 'manager') {
    return { ok: false, message: '只有管理席位可以结束协作' };
  }
  const status = local.ledger.status;
  if (status === 'proposed') {
    return { ok: false, message: '协作尚未建立——取消请用 ws_withdraw_invite（整条撤回）' };
  }
  if (status !== 'active' && status !== 'frozen') {
    return { ok: false, message: '协作已结束（或已终止）' };
  }
  mutateLedger(state, local, (ledger) => {
    ledger.status = 'completed';
    ledger.endedAt = new Date().toISOString();
  });
  local.member.state = 'completed';
  local.member.archivedAt = new Date().toISOString();
  persistMember(state, local);
  for (const instanceId of memberIdsOf(state, local)) {
    const endpoint = local.endpoints.get(instanceId);
    if (endpoint !== undefined) {
      sendTo(state, collabId, instanceId, endpoint, 'end', {});
    }
  }
  state.counters.ended++;
  return { ok: true };
}

export function leaveCollab(state, { collabId }) {
  const local = state.collabs.get(collabId);
  if (local === undefined) {
    return { ok: false, message: '本机没有该协作' };
  }
  if (local.role === 'manager') {
    return { ok: false, message: '管理席位不可退出——请先结束协作（显式交接属治理事项）' };
  }
  if (isLocalArchivedState(local)) {
    return { ok: false, message: '协作已结束（或已退出）' };
  }
  const managerId = local.member.manager.instanceId;
  const endpoint = local.endpoints.get(managerId);
  if (endpoint !== undefined) {
    sendTo(state, collabId, managerId, endpoint, 'leave', {});
  }
  local.member.state = 'left';
  local.member.archivedAt = new Date().toISOString();
  persistMember(state, local);
  state.counters.left++;
  return { ok: true, delivered: endpoint !== undefined };
}

export async function viewLedger(state, { collabId }) {
  const local = state.collabs.get(collabId);
  if (local === undefined) {
    return { ok: false, message: '本机没有该协作（先 ws_list_collabs）' };
  }
  if (local.role === 'manager') {
    return { ok: true, source: 'local', version: local.ledger.version, archived: isArchived(local.ledger.status), ledger: local.ledger };
  }
  const archived = isLocalArchivedState(local);
  const managerId = local.member.manager.instanceId;
  const endpoint = local.endpoints.get(managerId);
  if (!archived && endpoint !== undefined) {
    sendTo(state, collabId, managerId, endpoint, 'snapshot', { kind: 'request' });
    const live = await waitForSnapshot(state, collabId);
    if (live !== null) {
      return { ok: true, source: 'live', version: live.version, ledger: live.ledger };
    }
  }
  const stored = local.snapshot;
  if (stored !== null) {
    return { ok: true, source: 'snapshot', version: stored.version, note: `快照，版本 ${stored.version}，可能非最新`, archived, ledger: stored.ledger };
  }
  return { ok: false, message: archived ? '协作已归档且本机无可用快照' : '管理者离线且本机无快照——没有可读台账' };
}

/* 在线拉取的等待面：回应经接收管线到达（快照接收路径统一 resolve）；超时按快照回退。
 * 定时器保持引用（等待面是调用链的一环，事件循环留存至判定完成），服务 close 时统一清理。 */
function waitForSnapshot(state, collabId) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      state.pendingViews.delete(collabId);
      resolve(null);
    }, state.ledgerFetchTimeoutMs);
    state.pendingViews.set(collabId, { resolve, timer });
  });
}

/* 台账变更的统一入口（单写者纪律）：打补丁 → version 自增 → updatedAt → 落盘 → 推快照。
 * 补丁函数直接改写台账字段（调用方可借闭包引用名单条目）；推快照失败不影响本地状态。 */
export function mutateLedger(state, local, apply) {
  apply(local.ledger);
  local.ledger.version++;
  local.ledger.updatedAt = new Date().toISOString();
  persistLedger(state, local);
  state.counters.ledgerMutations++;
  pushSnapshot(state, local);
  return local.ledger;
}

/* 快照推送（设计 §8）：每次台账变更推全体成员（除本机）——端点已知者入可靠队列；
 * 端点未知者计数跳过（成员从未联系过管理席位的窗口）。管理席位同步留存自身最近快照。
 * 载荷冻结：帧在调度侧才序列化（入队落盘与上线各一次），活引用会让「摘要 ↔ 内容」分叉——
 * 台账被后续变更改写后，先入队的帧会以「摘要不符」被接收侧丢弃（本函数先深拷贝再入队）。 */
export function pushSnapshot(state, local) {
  const frozen = structuredClone(local.ledger);
  local.snapshot = {
    version: frozen.version,
    digest: ledgerDigest(frozen),
    receivedAt: new Date().toISOString(),
    from: { instanceId: state.self.instanceId, identityName: state.self.identityName },
    ledger: frozen,
  };
  persistSnapshot(state, local);
  for (const member of local.ledger.members) {
    if (member.instanceId === state.self.instanceId) {
      continue;
    }
    const endpoint = local.endpoints.get(member.instanceId);
    if (endpoint === undefined) {
      state.counters.snapshotSkipped++;
      continue;
    }
    sendTo(state, local.collabId, member.instanceId, endpoint, 'snapshot', { kind: 'data', version: frozen.version, digest: local.snapshot.digest, ledger: frozen });
    state.counters.snapshotSent++;
  }
}

/* 发送包装（注入的 dispatch.send 的统一入口）：结果只计数不抛出——协作操作不因单条入队失败而回滚。 */
export function sendTo(state, collabId, instanceId, endpoint, type, payload) {
  const result = state.send({ collabId, to: { instanceId, address: endpoint.address, port: endpoint.port }, type, payload });
  if (result.ok === true) {
    state.counters.messagesSent++;
    return result;
  }
  state.counters.sendFailures++;
  state.log.warn('协作消息入队失败', { collabId, type, to: instanceId, reason: result.reason });
  return result;
}

/* 冻结广播（设计 §6）：发给涉及两条协作的全部已知端点（除本机）——被冻那条的成员端点 ∪
 * 同名交集协作的成员端点；端点未知者跳过（转达与快照机制兜底可见性）。 */
export function broadcastFreeze(state, frozenLocal, reason) {
  const payload = {
    name: localNameOf(frozenLocal),
    members: localRosterOf(frozenLocal).map((entry) => ({ instanceId: entry.instanceId, identityName: entry.identityName })),
    reason,
  };
  let sent = 0;
  for (const [instanceId, endpoint] of collectFreezeTargets(state, frozenLocal)) {
    const result = sendTo(state, frozenLocal.collabId, instanceId, endpoint, 'freeze', payload);
    if (result.ok === true) {
      sent++;
    }
  }
  return sent;
}

/* 本地冻结：管理席位冻台账（version 推进 + 快照）、成员冻本地记录；已冻结或迁移不允许时幂等返回 false。 */
export function applyFreezeLocally(state, local, reason) {
  if (localStateOf(local) === 'frozen') {
    return false;
  }
  if (local.role === 'manager') {
    if (!canTransition(local.ledger.status, 'frozen')) {
      return false;
    }
    mutateLedger(state, local, (ledger) => {
      ledger.status = 'frozen';
    });
  } else {
    local.member.state = 'frozen';
    persistMember(state, local);
  }
  state.log.warn('协作已冻结（同名并发冲突）', { collabId: local.collabId, reason });
  return true;
}

/* 管理席位视角的可投递成员标识（除本机；终态成员——被拒 / 被撤回 / 已退出——不投消息）：
 * 消息广播与通告的收件人集合；提议中协作的「未回应」成员也在集内（提议中亦可沟通）。 */
export function memberIdsOf(state, local) {
  if (local.role !== 'manager') {
    return [];
  }
  return local.ledger.members
    .filter((entry) => entry.instanceId !== state.self.instanceId && MESSAGING_MEMBER_STATES.includes(entry.state))
    .map((entry) => entry.instanceId);
}

/* 非归档协作数（发现层 getCollabCount 的计数口径：提议中 / 进行中 / 冻结）。 */
export function countLiveCollabs(state) {
  let count = 0;
  for (const local of state.collabs.values()) {
    if (!isLocalArchivedState(local)) {
      count++;
    }
  }
  return count;
}

/* 星型路由（设计 §10）：成员只发给管理者（省略 to 或显式 = 管理者）；管理者发给任一人、
 * 省略 to = 全体已建立成员（不含本机）。 */
function recipientsOf(state, local, to) {
  const managerId = local.member.manager.instanceId;
  const explicit = typeof to === 'string' && to.trim() !== '' ? to.trim() : null;
  if (local.role === 'member') {
    if (explicit !== null && explicit !== managerId) {
      return { error: '成员只能发给管理者（星型路由）' };
    }
    return { targets: [managerId] };
  }
  if (explicit !== null) {
    const exists = local.ledger.members.some((entry) => entry.instanceId === explicit);
    return exists ? { targets: [explicit] } : { error: '目标不在协作名单中' };
  }
  return { targets: memberIdsOf(state, local) };
}

/* 协作类载荷构造：topic 走呈现文本、task 生成任务标识、stop 的正文即原因、其余为正文 text。 */
function payloadOf(type, text) {
  if (type === 'topic') {
    return { text };
  }
  if (type === 'task') {
    return { taskId: newCollabId(), text };
  }
  if (type === 'stop') {
    return { reason: text };
  }
  return { text };
}

function managerRecordOf(ledger) {
  return {
    collabId: ledger.collabId,
    role: 'manager',
    state: ledger.status,
    name: ledger.name,
    manager: { instanceId: ledger.manager.instanceId, identityName: ledger.manager.identityName },
    roster: ledger.members.map((member) => ({ instanceId: member.instanceId, identityName: member.identityName })),
    endpoints: {},
    decision: null,
  };
}

function invitePayloadOf(ledger) {
  return {
    name: ledger.name,
    topic: ledger.topic,
    members: ledger.members.map((member) => ({ instanceId: member.instanceId, identityName: member.identityName })),
  };
}

function withdrawOne(state, local, targetId) {
  const member = local.ledger.members.find((entry) => entry.instanceId === targetId);
  if (member === undefined) {
    return { ok: false, message: '名单里没有该成员' };
  }
  if (member.state !== 'invited') {
    return { ok: false, message: `该成员已回应（${member.state}）——不可撤回` };
  }
  mutateLedger(state, local, () => {
    member.state = 'withdrawn';
  });
  const endpoint = local.endpoints.get(targetId);
  const sent = endpoint === undefined
    ? { ok: false, reason: '端点未知' }
    : sendTo(state, local.collabId, targetId, endpoint, 'withdraw', { scope: 'single' });
  state.counters.withdrawn++;
  return { ok: true, scope: 'single', withdrawn: [targetId], delivered: sent.ok === true };
}

function withdrawAll(state, local) {
  /* 整条取消的通告面 = 全体非本机成员（含已单条撤回 / 已拒绝者——它们也应得知该协作已不存在） */
  const recipients = local.ledger.members.filter((entry) => entry.instanceId !== state.self.instanceId);
  mutateLedger(state, local, (ledger) => {
    ledger.status = 'terminated';
    for (const member of ledger.members) {
      if (member.state === 'invited' || member.state === 'approved') {
        member.state = 'withdrawn';
      }
    }
  });
  local.member.state = 'terminated';
  local.member.archivedAt = new Date().toISOString();
  persistMember(state, local);
  for (const member of recipients) {
    const endpoint = local.endpoints.get(member.instanceId);
    if (endpoint !== undefined) {
      sendTo(state, local.collabId, member.instanceId, endpoint, 'withdraw', { scope: 'all' });
    }
  }
  state.counters.withdrawn += recipients.length;
  return { ok: true, scope: 'all', withdrawn: recipients.map((member) => member.instanceId) };
}

/* 创建前置检查：名与主题的呈现判据、目标形态、本机协作上限、本机同名交集冲突（防重复发起——
 * 同名且参与者有交集的协作在本机再次创建必然构成设计 §6 的冲突面，直接拒绝给出明确指引）。 */
function createRejection(state, name, topic, targets) {
  if (typeof name !== 'string' || !isIdentityName(name)) {
    return '项目名非法：需为非空、≤64 字符、不含控制 / 不可见格式 / 行段分隔字符（同身份名呈现判据）';
  }
  if (typeof topic !== 'string' || !isPresentationText(topic, MAX_TOPIC_CHARS)) {
    return `主题非法：需为非空、≤${MAX_TOPIC_CHARS} 字符的呈现文本`;
  }
  const targetsRejection = targetsRejectionOf(targets, state.self.instanceId);
  if (targetsRejection !== null) {
    return targetsRejection;
  }
  if (countLiveCollabs(state) >= MAX_LOCAL_COLLABS) {
    return `本机参与协作数已达上限（${MAX_LOCAL_COLLABS}）——先结束或退出旧协作`;
  }
  const conflict = matchConflictCollabs(state, name, [state.self.instanceId, ...targets.map((target) => target.instanceId)]);
  if (conflict.length > 0) {
    return `本机已有同名且参与者有交集的协作（${conflict[0].collabId}）——请换名或先处理既有协作`;
  }
  return null;
}

/* 目标数组形态与去重（含本机排除）。 */
function targetsRejectionOf(targets, selfId) {
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > MAX_COLLAB_MEMBERS - 1) {
    return `目标非法：需要 1–${MAX_COLLAB_MEMBERS - 1} 项`;
  }
  const seen = new Set([selfId]);
  for (const target of targets) {
    const reason = targetRejection(target, seen);
    if (reason !== null) {
      return reason;
    }
  }
  return null;
}

function targetRejection(target, seen) {
  if (typeof target !== 'object' || target === null) {
    return '目标条目非法';
  }
  if (typeof target.instanceId !== 'string' || !ID_PATTERN.test(target.instanceId)) {
    return '目标实例标识非法（1–64 位字母数字与连字符）';
  }
  if (typeof target.identityName !== 'string' || !isIdentityName(target.identityName)) {
    return '目标身份名非法（呈现判据）';
  }
  if (!isEndpointValue(target)) {
    return '目标端点非法（地址需 IP 字面量、端口 1–65535）';
  }
  if (seen.has(target.instanceId)) {
    return '目标重复（或包含本机）';
  }
  seen.add(target.instanceId);
  return null;
}

function isEndpointValue(target) {
  if (typeof target.address !== 'string' || isIP(target.address) === 0) {
    return false;
  }
  return Number.isInteger(target.port) && target.port >= 1 && target.port <= 65535;
}

/* 冻结目标集：被冻协作成员端点 ∪ 同名交集协作成员端点（去重、除本机）。 */
function collectFreezeTargets(state, frozenLocal) {
  const ids = localRosterOf(frozenLocal).map((entry) => entry.instanceId);
  const targets = new Map();
  addTargetsOf(state, frozenLocal, targets);
  for (const other of matchConflictCollabs(state, localNameOf(frozenLocal), ids)) {
    if (other.collabId !== frozenLocal.collabId) {
      addTargetsOf(state, other, targets);
    }
  }
  targets.delete(state.self.instanceId);
  return targets;
}

function addTargetsOf(state, local, targets) {
  for (const [instanceId, endpoint] of local.endpoints) {
    if (instanceId !== state.self.instanceId && !targets.has(instanceId)) {
      targets.set(instanceId, endpoint);
    }
  }
}
