import { isIP } from 'node:net';
import { ID_PATTERN, MAX_COLLAB_MEMBERS, MAX_MESSAGE_TEXT_CHARS, MAX_REASON_CHARS, MAX_TOPIC_CHARS, PROTOCOL_VERSION, isIdentityName, isPort, isPresentationText, newMsgId } from '../net/protocol.js';
import { MAX_LOCAL_COLLABS, canTransition, isArchived, newCollabId } from './model.js';
import { ledgerDigest, removeLedgerFile } from './store.js';
import { currentManagerIdOf, isLocalArchivedState, localNameOf, localRosterOf, localStateOf, memberStateFor, persistLedger, persistMember, persistSnapshot, rememberKnownHost } from './local.js';
import { matchConflictCollabs } from './gate.js';

/* 对外操作与协作态变更实现（服务公共 API 的落点）：请求来自本机会话（工具面）——
 * 参数不符合即返回 { ok:false, message }（由工具层呈现为 isError）；发送一律经注入的
 * dispatch.send（可靠队列），单条入队失败只计数不回滚已完成的本地状态。 */

/* 可投递成员状态集（消息广播与通告的收件人口径）。 */
const MESSAGING_MEMBER_STATES = ['invited', 'approved', 'member'];

/* 已转达 originMsgId 集上限：转达防环与防重复的记录面（进程内、插入序淘汰）——
 * 每条治理通告的每跳只在首次收到时转达一次，重复副本不再向外扩散（本地应用仍幂等执行）。 */
const RELAYED_ORIGINS_MAX = 256;

export function createCollab(state, { name, topic, targets }) {
  const rejected = createRejection(state, name, topic, targets);
  if (rejected !== null) {
    return { ok: false, message: rejected };
  }
  const ledger = freshLedgerOf(state, name, topic, targets);
  const local = {
    collabId: ledger.collabId,
    role: 'manager',
    ledger,
    member: managerRecordOf(ledger),
    endpoints: new Map(),
    snapshot: null,
    suspended: null,
    staleManagerId: null,
  };
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

/* 新建台账（v1 proposed；名单 = 本机〔manager〕+ 各目标〔invited〕）。 */
function freshLedgerOf(state, name, topic, targets) {
  const now = new Date().toISOString();
  return {
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
  /* 挂起期明确拒绝（与 sendMessage 同一口径）：撤回含台账写 + 通告面，收敛等待中会被
   * 暂停守卫截成半执行（撤回帧已发、台账未变）——待收敛后再试。 */
  if (local.suspended !== null) {
    return { ok: false, message: '协作对外写已暂停（在途抢接或未能对表）——收敛后恢复' };
  }
  if (local.ledger.status !== 'proposed') {
    const hint = local.ledger.status === 'active' ? '协作已建立——结束请用 ws_end_collab' : '当前状态不可撤回';
    return { ok: false, message: hint };
  }
  /* 省略 target = 整条撤回；「已提供但非法」明确拒绝——不得静默归并到最具破坏性的整条撤回路径
   * （服务会被夹具直调，形态把关不能只靠工具层）。 */
  if (target === undefined || target === null) {
    return withdrawAll(state, local);
  }
  const targetId = typeof target === 'string' ? target.trim() : '';
  if (!ID_PATTERN.test(targetId)) {
    return { ok: false, message: 'target 非法（1–64 位字母数字与连字符的实例标识）——整条撤回请省略 target' };
  }
  return withdrawOne(state, local, targetId);
}

export function sendMessage(state, { collabId, text, type, to }) {
  const local = state.collabs.get(collabId);
  if (local === undefined) {
    return { ok: false, message: '本机没有该协作（先 ws_list_collabs）' };
  }
  if (local.suspended !== null) {
    return { ok: false, message: '协作对外写已暂停（在途抢接或未能对表）——收敛后恢复' };
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
  /* 挂起期明确拒绝（与 sendMessage 同一口径）：收敛等待中的结束会半执行——台账写被暂停守卫
   * 拦下，成员记录与通告却照发，产出「成员已归档、驿丞仍活跃」的僵尸协作。 */
  if (local.suspended !== null) {
    return { ok: false, message: '协作对外写已暂停（在途抢接或未能对表）——收敛后恢复' };
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
 * 补丁函数直接改写台账字段（调用方可借闭包引用名单条目）；推快照失败不影响本地状态。
 * 暂停守卫：本机进入收敛等待（在途抢接 / 未对表）时拒绝一切非治理写——治理动作（冻结 / 解冻 /
 * 裁定执行 / 席位恢复）经 options.governance 放行：收敛本身依赖这些写入，暂停不得阻断收敛。 */
export function mutateLedger(state, local, apply, options = {}) {
  if (local.suspended !== null && options.governance !== true) {
    state.counters.mutationSuspended++;
    state.log.warn('协作写被暂停（收敛等待中）', { collabId: local.collabId, reason: local.suspended.reason });
    return null;
  }
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

/* 发送包装（注入的 dispatch.send 的统一入口）：结果只计数不抛出——协作操作不因单条入队失败而回滚。
 * options.from：转达帧的原发身份（治理转达原样携带发起者 from——身份语义定义在 from 上，
 * 不得改写为转达者；普通发送不携带，由发送侧以本机身份盖章）。 */
export function sendTo(state, collabId, instanceId, endpoint, type, payload, options = {}) {
  const message = { collabId, to: { instanceId, address: endpoint.address, port: endpoint.port }, type, payload };
  if (options.from !== undefined) {
    message.from = options.from;
  }
  const result = state.send(message);
  if (result.ok === true) {
    state.counters.messagesSent++;
    return result;
  }
  state.counters.sendFailures++;
  state.log.warn('协作消息入队失败', { collabId, type, to: instanceId, reason: result.reason });
  return result;
}

/* 治理寻址（跨协作回退）：协作内端点表优先；未学到时回退站点级已知主机清单（含其他协作与
 * 发现链路学到的「实例标识 → 地址:端口」）——治理转达 / 席位转移的触达由此不局限于单一协作的
 * 直接接触史（设计 §5 清单随协作参与关系更新的治理消费面）。未见过返回 undefined（调用方跳过）。 */
export function endpointFor(state, local, instanceId) {
  const held = local.endpoints.get(instanceId);
  if (held !== undefined) {
    return held;
  }
  if (typeof state.knownHosts?.lookup !== 'function') {
    return undefined;
  }
  const fallback = state.knownHosts.lookup(instanceId);
  return fallback ?? undefined;
}

/* 发给协作名册中全部已知端点的参与者（除本机与被排除者）：治理广播（抢接 / 裁定 / 握手 /
 * 席位变更通告）的统一出口；端点未知者跳过——可见性由转达与对等回执机制兜底（设计 §9 步骤 1/5）。 */
export function sendToRoster(state, local, type, payload, options = {}) {
  const exclude = options.exclude ?? new Set();
  let sent = 0;
  for (const entry of localRosterOf(local)) {
    const instanceId = entry.instanceId;
    if (instanceId === state.self.instanceId || exclude.has(instanceId)) {
      continue;
    }
    const endpoint = endpointFor(state, local, instanceId);
    if (endpoint === undefined) {
      state.counters.rosterSkipped++;   // 治理触达不可及的观测面（跳过不静默）
      continue;
    }
    const result = sendTo(state, local.collabId, instanceId, endpoint, type, payload);
    if (result.ok === true) {
      sent++;
    }
  }
  return sent;
}

/* 治理转达目标集：名册中全部端点可寻址的参与者（除本机与来源由 relayGovernance 过滤）；
 * 逐目标归属的本地协作信息供转达帧寻址。 */
export function governanceTargets(state, local) {
  const targets = new Map();
  for (const entry of localRosterOf(local)) {
    const endpoint = endpointFor(state, local, entry.instanceId);
    if (endpoint !== undefined) {
      targets.set(entry.instanceId, { address: endpoint.address, port: endpoint.port, collabId: local.collabId });
    }
  }
  return targets;
}

/* 治理转达（设计 §10 治理类例外）：逐目标独立入队——防环与防重复由 originMsgId 已转达集承载
 * （同 originMsgId 的重复副本不再向外扩散；发送队列以 msgId 为唯一键，多目标无法共用同一 msgId）。
 * targets：Map<instanceId, { address, port, collabId }>（逐目标归属的本地协作）。 */
export function relayGovernance(state, frame, targets) {
  const origin = typeof frame.payload.originMsgId === 'string' && frame.payload.originMsgId !== '' ? frame.payload.originMsgId : frame.msgId;
  if (state.relayedOrigins.has(origin)) {
    return 0;
  }
  rememberRelayedOrigin(state, origin);
  /* 转达原样携带原发身份（设计 §9）：帧的 from 是候选人 / 驿丞的权威身份——改写为转达者会让
   * 接收方把转达者当作新驿丞（身份归因错位）；只取协议定义的三字段，不夹带来源帧其它字段。 */
  const originFrom = { instanceId: frame.from.instanceId, identityName: frame.from.identityName, port: frame.from.port };
  let relayed = 0;
  for (const [instanceId, target] of targets) {
    if (instanceId === state.self.instanceId || instanceId === frame.from.instanceId) {
      continue;
    }
    const result = sendTo(state, target.collabId, instanceId, { address: target.address, port: target.port }, frame.type, { ...frame.payload, originMsgId: origin }, { from: originFrom });
    if (result.ok === true) {
      relayed++;
    }
  }
  return relayed;
}

/* 已转达集登记（插入序淘汰——表满丢最旧）。 */
export function rememberRelayedOrigin(state, origin) {
  state.relayedOrigins.delete(origin);
  state.relayedOrigins.set(origin, Date.now());
  while (state.relayedOrigins.size > RELAYED_ORIGINS_MAX) {
    const oldest = state.relayedOrigins.keys().next().value;
    state.relayedOrigins.delete(oldest);
  }
}

/* 冻结广播（设计 §6）：发给涉及两条协作的全部已知端点（除本机）——被冻那条的成员端点 ∪
 * 同名交集协作的成员端点；端点未知者跳过（转达与快照机制兜底可见性）。
 * 管理席位侧检出时随带被冻条的发起时间与管理者（合流并集与保留方判定的参考数据；
 * 成员侧检出无从提供——接收侧按数据缺省保守处理）。 */
export function broadcastFreeze(state, frozenLocal, reason) {
  const payload = {
    name: localNameOf(frozenLocal),
    members: localRosterOf(frozenLocal).map((entry) => ({ instanceId: entry.instanceId, identityName: entry.identityName })),
    reason,
  };
  if (frozenLocal.role === 'manager') {
    payload.createdAt = frozenLocal.ledger.createdAt;
    payload.manager = { instanceId: frozenLocal.ledger.manager.instanceId, identityName: frozenLocal.ledger.manager.identityName };
  }
  let sent = 0;
  for (const [instanceId, endpoint] of collectFreezeTargets(state, frozenLocal)) {
    const result = sendTo(state, frozenLocal.collabId, instanceId, endpoint, 'freeze', payload);
    if (result.ok === true) {
      sent++;
    }
  }
  return sent;
}

/* 本地冻结：管理席位冻台账（version 推进 + 快照）、成员冻本地记录；已冻结或迁移不允许时幂等返回 false。
 * 冻结标记（frozenAt / frozenFrom）随冻结写入——48 小时无裁定提示与「回冻结前状态」的依据。 */
export function applyFreezeLocally(state, local, reason) {
  if (localStateOf(local) === 'frozen') {
    return false;
  }
  const now = new Date().toISOString();
  if (local.role === 'manager') {
    if (!canTransition(local.ledger.status, 'frozen')) {
      return false;
    }
    const from = local.ledger.status;
    mutateLedger(state, local, (ledger) => {
      ledger.status = 'frozen';
      ledger.frozenAt = now;
      ledger.frozenFrom = from;
    }, { governance: true });
  } else {
    const from = local.member.state;
    local.member.state = 'frozen';
    local.member.frozenAt = now;
    local.member.frozenFrom = memberStateFor(from);
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

/* 席位转移原语（接管生效 / 移交受让共用）：以给定台账承担管理席位——本地记录转管理、
 * 台账落盘（本机成为单一写者）、自身留存并推送当前视图（成员由此学习新驿丞端点）。 */
export function promoteToManager(state, local, ledger) {
  syncRosterRoles(ledger);
  /* 席位变更（受让 / 接管）作废本机关于他方候选的生效抢接记录（指向本机自身的新记录
   * 由抢接生效路径随后登记）——陈旧记录继续随握手外传会让对手方按已翻页的席位收敛。 */
  invalidateEffectiveTakeovers(state, local, state.self.instanceId);
  local.role = 'manager';
  local.ledger = ledger;
  local.member = managerRecordOf(ledger);
  local.member.endpoints = Object.fromEntries(local.endpoints);
  local.member.managerSinceVersion = ledger.version;   // 席位时钟：本次席位变更的台账基准版本
  local.suspended = null;
  local.staleManagerId = null;
  persistMember(state, local);
  persistLedger(state, local);
  pushSnapshot(state, local);
}

/* 席位变更后的名册角色同步：台账 manager 与 members[].role 恒一致——新任驿丞置 manager、
 * 其余旧 manager 位回落 member（否则旧驿丞被移交前置按 role 误拒，交回路径永久不可达）。 */
function syncRosterRoles(ledger) {
  for (const member of ledger.members) {
    if (member.instanceId === ledger.manager.instanceId) {
      member.role = 'manager';
    } else if (member.role === 'manager') {
      member.role = 'member';
    }
  }
}

/* 生效抢接记录的席位翻页作废：keepCandidateId 指保留「关于该候选」的记录（传 null 清空全部）。
 * 生效记录是进程内的席位主张面——任何本机席位变更（受让 / 让位 / 采纳新驿丞）即告翻页；
 * 不清理会让组合链（抢占 × 移交）里已翻页的记录继续经握手传播，把新驿丞按旧记录拉下席位。 */
function invalidateEffectiveTakeovers(state, local, keepCandidateId) {
  const held = state.effectiveTakeovers.get(local.collabId);
  if (held === undefined) {
    return;
  }
  if (keepCandidateId === null || held.candidate.instanceId !== keepCandidateId) {
    state.effectiveTakeovers.delete(local.collabId);
  }
}

/* 降级为成员（被替换 / 合流让位的落点）：管理席位——以台账定格名单转成员记录、删除本地台账
 * （单副本纪律：台账随后任驿丞走；本机快照保留为成员备份）；成员——仅更新驿丞引用。
 * 随后重定向陈旧出站队列（发往旧驿丞的未确认消息改投新驿丞——不静默丢弃）并拉取现任视图。
 * 席位变更（让位）作废本机生效抢接记录并推进席位时钟（陈旧判据的本机已知面）。 */
export function downgradeToMember(state, local, managerPeer, version) {
  invalidateEffectiveTakeovers(state, local, null);
  const formerManagerId = currentManagerIdOf(local);
  if (local.role === 'manager') {
    local.member = memberRecordOf(local, managerPeer);
    local.ledger = null;
    local.role = 'member';
    if (!removeLedgerFile(state.dataDir, local.collabId)) {
      state.log.warn('台账文件删除失败（保守保留）', { collabId: local.collabId });
    }
  } else {
    local.member.manager = { instanceId: managerPeer.instanceId, identityName: managerPeer.identityName };
  }
  if (Number.isInteger(version)) {
    local.member.managerSinceVersion = version;
  }
  local.suspended = null;
  persistMember(state, local);
  retargetStaleQueue(state, local, formerManagerId, managerPeer.instanceId);
  requestCurrentView(state, local);
  state.counters.downgrades++;
}

/* 陈旧出站队列重定向：发往旧驿丞的未确认条目改投新驿丞（同 msgId 保持——进行中消息在新席位
 * 上等价有效且不产生重复投递）；新驿丞端点未知先暂存 staleManagerId、待端点学习后补投。 */
export function retargetStaleQueue(state, local, fromInstanceId, toInstanceId) {
  if (fromInstanceId === toInstanceId) {
    return;
  }
  const endpoint = endpointFor(state, local, toInstanceId);
  if (endpoint === undefined || typeof state.reassign !== 'function') {
    local.staleManagerId = fromInstanceId;
    state.counters.queueStaleKept++;
    return;
  }
  const result = state.reassign({
    collabId: local.collabId,
    fromInstanceId,
    to: { instanceId: toInstanceId, address: endpoint.address, port: endpoint.port },
  });
  if (result.ok === true) {
    state.counters.queueRetargeted += result.moved;
    local.staleManagerId = null;
  } else {
    local.staleManagerId = fromInstanceId;
    state.counters.queueStaleKept++;
  }
}

/* 端点学习后的补投（events.applyEndpoint 的挂点）：暂存的旧驿丞队列等到新驿丞端点即可重定向。 */
export function resumeStaleRetarget(state, local) {
  if (local.staleManagerId === null || local.staleManagerId === undefined) {
    return;
  }
  retargetStaleQueue(state, local, local.staleManagerId, currentManagerIdOf(local));
}

/* 向现任驿丞拉取当前视图（快照请求；端点未知静默跳过——对方主动联系时端点自然学习）。 */
export function requestCurrentView(state, local) {
  const managerId = local.member.manager.instanceId;
  const endpoint = endpointFor(state, local, managerId);
  if (endpoint === undefined) {
    return;
  }
  sendTo(state, local.collabId, managerId, endpoint, 'snapshot', { kind: 'request' });
}

/* 驿丞引用更新（成员侧；移交 / 抢接 / 握手共用）：更新记录、重定向陈旧队列并留痕；
 * 是否拉取当前视图由调用方决定（对表路径按版本差决定）。 */
export function adoptNewManager(state, local, managerPeer, remoteVersion) {
  if (local.role !== 'member') {
    return false;
  }
  const oldId = local.member.manager.instanceId;
  if (oldId === managerPeer.instanceId) {
    return false;
  }
  /* 席位变更（采纳新驿丞）作废关于其它候选的生效记录（关于新驿丞本人的记录保留——它是
   * 本机对「发生过抢接」的如实知识，继续随握手外传供他方收敛）；并推进席位时钟
   * （陈旧判据的本机已知面：早于或等于该次变更的席位主张与记录不再回翻本机引用）。 */
  invalidateEffectiveTakeovers(state, local, managerPeer.instanceId);
  local.member.manager = { instanceId: managerPeer.instanceId, identityName: managerPeer.identityName };
  if (Number.isInteger(remoteVersion)) {
    local.member.managerSinceVersion = remoteVersion;
  }
  persistMember(state, local);
  retargetStaleQueue(state, local, oldId, managerPeer.instanceId);
  state.counters.managerChangedIn++;
  state.log.info('驿丞引用已更新', { collabId: local.collabId, from: oldId, to: managerPeer.instanceId, version: remoteVersion });
  return true;
}

/* 合流递交（设计 §9 步骤 4）：把本地 diverged 台账整份发给现任驿丞、由其本机人裁定采纳 / 丢弃。
 * 不走快照通道——快照通道的「版本不倒退即收」会让 diverged 内容静默覆盖（禁止静默覆盖）。 */
export function sendMergeOffer(state, local, managerPeer, baseVersion) {
  const source = local.role === 'manager' ? local.ledger : (local.snapshot === null ? null : local.snapshot.ledger);
  if (source === null) {
    return { ok: false, reason: '无可递交的台账' };
  }
  const endpoint = local.endpoints.get(managerPeer.instanceId);
  if (endpoint === undefined) {
    return { ok: false, reason: '端点未知' };
  }
  const frozen = structuredClone(source);
  return sendTo(state, local.collabId, managerPeer.instanceId, endpoint, 'notice', {
    event: 'merge-request',
    baseVersion,
    version: frozen.version,
    digest: ledgerDigest(frozen),
    ledger: frozen,
  });
}

/* 本机提示（会话注入面；不经出站队列、不上网络）：notify 注入缺失或投递失败只计数与日志。
 * 帧形态为 notice + event:'local-alert'——该事件不入协议表（外发不存在；伪造入站被协议拒收）。 */
export function notifyLocal(state, local, text) {
  if (typeof state.notify !== 'function') {
    return;
  }
  try {
    state.notify({
      v: PROTOCOL_VERSION,
      type: 'notice',
      msgId: newMsgId(),
      from: state.self,
      collabId: local.collabId,
      ts: new Date().toISOString(),
      payload: { event: 'local-alert', text },
    });
    state.counters.notificationsSent++;
  } catch (error) {
    state.counters.notificationsDropped++;
    state.log.warn('本机提示投递失败（已忽略）', { collabId: local.collabId, reason: error.message });
  }
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

/* 管理席位记录（含移交受让与接管恢复的构造面）：roster = 台账定格名单，endpoints 由调用方补。 */
export function managerRecordOf(ledger) {
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

/* 成员记录（降级 / 让位的构造面）：以台账定格名单为 roster（不随台账逐次更新）。 */
function memberRecordOf(local, managerPeer) {
  const status = localStateOf(local);
  const record = {
    collabId: local.collabId,
    role: 'member',
    state: memberStateFor(status),
    name: localNameOf(local),
    manager: { instanceId: managerPeer.instanceId, identityName: managerPeer.identityName },
    roster: localRosterOf(local).map((entry) => ({ instanceId: entry.instanceId, identityName: entry.identityName })),
    endpoints: Object.fromEntries(local.endpoints),
    decision: null,
  };
  if (record.state === 'completed' || record.state === 'terminated') {
    record.archivedAt = new Date().toISOString();
  }
  return record;
}

export function invitePayloadOf(ledger) {
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
  return isPort(target.port);
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
