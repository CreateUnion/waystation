import { isPort } from '../net/protocol.js';
import { MAX_BOARD_ENTRIES } from './model.js';
import { ledgerDigest } from './store.js';
import { isLocalArchivedState, persistMember, persistSnapshot, rememberKnownHost } from './local.js';
import { matchConflictCollabs } from './gate.js';
import { applyFreezeLocally, broadcastFreeze, memberIdsOf, mutateLedger, sendTo } from './outgoing.js';

/* 接收事件处理（consume 的落点）：端点学习、邀请建记录与冲突检测、回应与建立、撤回 / 退出 / 结束、
 * 主题与进度联动、冻结接收与转达、快照接收 / 回执 / 请求应答。异常由服务外层统一隔离（绝不穿出）。
 * 事件处理发生在接收管线的「落盘 + ack 之后」——此处失败不回滚消息的受理承诺。 */

/* 已转达 originMsgId 集上限：转达防环与防重复的记录面（进程内、插入序淘汰）——
 * 每条冻结通告的每跳只在首次收到时转达一次，重复副本不再向外扩散（本地冻结仍幂等执行）。 */
const RELAYED_ORIGINS_MAX = 256;

const EVENT_HANDLERS = {
  invite: handleInvite,
  approve: handleApproveResponse,
  decline: handleDeclineResponse,
  withdraw: handleWithdrawInbound,
  notice: handleNotice,
  topic: handleTopic,
  progress: handleProgress,
  freeze: handleFreeze,
  snapshot: handleSnapshot,
  end: handleEnd,
  leave: handleLeave,
};

export async function handleEvent(state, frame, meta) {
  learnEndpoints(state, frame, meta);
  const handler = EVENT_HANDLERS[frame.type];
  if (handler !== undefined) {
    await handler(state, frame, meta);
  }
}

/* 端点学习（设计 §5「清单随协作参与关系更新」的接入面）：已受理帧的来源地址与端口记入
 * 对应协作的端点表（仅当本机在协作中——注册表命中），并同步 known-hosts（单播兜底目标）。
 * 仅在端点变化时写 member.json（避免每条消息一次写盘）。 */
function learnEndpoints(state, frame, meta) {
  const local = state.collabs.get(frame.collabId);
  if (local === undefined) {
    return;
  }
  const address = typeof meta?.remoteAddress === 'string' ? meta.remoteAddress : '';
  if (address === '' || !isPort(frame.from?.port)) {
    return;
  }
  applyEndpoint(state, local, frame.from, address, frame.from.port);
}

export function applyEndpoint(state, local, peer, address, port) {
  const held = local.endpoints.get(peer.instanceId);
  if (held === undefined || held.address !== address || held.port !== port) {
    local.endpoints.set(peer.instanceId, { address, port });
    local.member.endpoints = Object.fromEntries(local.endpoints);
    persistMember(state, local);
  }
  rememberKnownHost(state, { address, port, instanceId: peer.instanceId, identityName: peer.identityName });
}

/* 邀请到达（admit 已做名单 / 频率 / 上限判定）：创建本地参与记录（proposed），冲突检测命中则
 * 直接冻结本记录并广播（第一检测点，设计 §6）；两种结局都投递会话（同意门入口）。 */
function handleInvite(state, frame, meta) {
  if (state.collabs.has(frame.collabId)) {
    state.counters.invitesRejected++;
    return;
  }
  const member = inviteRecordOf(state, frame);
  const local = { collabId: frame.collabId, role: 'member', ledger: null, member, endpoints: new Map(), snapshot: null };
  learnInviteSource(state, local, frame, meta);
  state.counters.invitesReceived++;
  const conflict = matchConflictCollabs(state, member.name, member.roster.map((entry) => entry.instanceId));
  if (conflict.length > 0) {
    freezeOnInviteConflict(state, frame, local, conflict);
    return;
  }
  state.collabs.set(frame.collabId, local);
  persistMember(state, local);
}

/* 邀请定格的本地记录（roster 供冲突交集判据在成员侧取数；有效期自本地收到时刻起算）。 */
function inviteRecordOf(state, frame) {
  const now = new Date().toISOString();
  return {
    collabId: frame.collabId,
    role: 'member',
    state: 'proposed',
    name: frame.payload.name,
    manager: { instanceId: frame.from.instanceId, identityName: frame.from.identityName },
    roster: frame.payload.members.map((entry) => ({ instanceId: entry.instanceId, identityName: entry.identityName })),
    endpoints: {},
    invitedAt: now,
    expiresAt: new Date(Date.parse(now) + state.config.inviteTtlMs).toISOString(),
    decision: null,
  };
}

/* 邀请来源端点学习（记录创建时的一次性学习——注册表尚无本条，走 learnEndpoints 之外的特例路径）。 */
function learnInviteSource(state, local, frame, meta) {
  const address = typeof meta?.remoteAddress === 'string' ? meta.remoteAddress : '';
  if (address === '' || !isPort(frame.from.port)) {
    return;
  }
  local.endpoints.set(frame.from.instanceId, { address, port: frame.from.port });
  local.member.endpoints = Object.fromEntries(local.endpoints);
  rememberKnownHost(state, { address, port: frame.from.port, instanceId: frame.from.instanceId, identityName: frame.from.identityName });
}

/* 冲突检出（第一检测点）：冻结新到那条并连带冻结本机全部匹配协作（检出方本地一并冻上，
 * 避免旧那条在检出机与另一机的副本形成分叉），随后广播。广播 reason 用固定短文案
 * （协议上限 200 字符——拼接多个实例标识会越界；明细在日志字段里）。 */
function freezeOnInviteConflict(state, frame, local, conflict) {
  local.member.state = 'frozen';
  state.counters.freezeDetected++;
  state.collabs.set(frame.collabId, local);
  persistMember(state, local);
  for (const other of conflict) {
    applyFreezeLocally(state, other, `同名冲突：与新到邀请（${frame.collabId}）参与者有交集`);
  }
  state.log.warn('检出同名并发冲突（邀请到达）——新到邀请与本机同名协作一并冻结', {
    collabId: frame.collabId,
    name: local.member.name,
    conflicts: conflict.map((entry) => entry.collabId).join('、'),
  });
  broadcastFreeze(state, local, '同名冲突：与本机既有协作参与者有交集');
}

function handleApproveResponse(state, frame) {
  applyInviteResponse(state, frame, 'approved');
}

function handleDeclineResponse(state, frame) {
  applyInviteResponse(state, frame, 'declined');
}

/* 管理席位侧：把回应入账（幂等——同向重试帧不再推进），随后走建立判定点。 */
function applyInviteResponse(state, frame, wanted) {
  const local = state.collabs.get(frame.collabId);
  if (local === undefined || local.role !== 'manager' || local.ledger.status !== 'proposed') {
    return;
  }
  const member = local.ledger.members.find((entry) => entry.instanceId === frame.from.instanceId);
  if (member === undefined || member.role === 'manager') {
    state.counters.eventMismatch++;
    state.log.warn('回应来源不在名单（忽略）', { collabId: frame.collabId, from: frame.from.instanceId });
    return;
  }
  if (member.state === wanted) {
    return;
  }
  mutateLedger(state, local, () => {
    member.state = wanted;
  });
  if (wanted === 'approved') {
    state.counters.approvalsIn++;
  } else {
    state.counters.declinesIn++;
  }
  maybeEstablish(state, local);
}

/* 建立判定点（定案 7）：全部应邀者有终局决策且同意 ≥1 → 建立前冲突复检（第二检测点）→
 * 冻结（检出）或转 active；部分未决等待；全部拒绝保持提议中（管理者可整条撤回）。 */
function maybeEstablish(state, local) {
  const invited = local.ledger.members.filter((entry) => entry.role !== 'manager');
  if (invited.some((entry) => entry.state === 'invited')) {
    return;
  }
  if (!invited.some((entry) => entry.state === 'approved')) {
    state.log.warn('全部受邀者未同意——协作保持提议中（可整条撤回）', { collabId: local.collabId });
    return;
  }
  const others = matchConflictCollabs(state, local.ledger.name, local.ledger.members.map((entry) => entry.instanceId))
    .filter((entry) => entry.collabId !== local.collabId);
  if (others.length > 0) {
    state.counters.freezeDetected++;
    applyFreezeLocally(state, local, `建立前检出同名冲突（与 ${others.map((entry) => entry.collabId).join('、')}）`);
    broadcastFreeze(state, local, '建立前检出同名冲突');
    return;
  }
  establish(state, local);
}

/* 建立：状态转 active、approved → member 定格；快照由台账变更统一推送（先于建立通告入队），
 * 随后广播建立通告。 */
function establish(state, local) {
  mutateLedger(state, local, (ledger) => {
    ledger.status = 'active';
    for (const member of ledger.members) {
      if (member.state === 'approved') {
        member.state = 'member';
      }
    }
  });
  local.member.state = 'active';
  persistMember(state, local);
  state.counters.established++;
  for (const instanceId of memberIdsOf(state, local)) {
    const endpoint = local.endpoints.get(instanceId);
    if (endpoint !== undefined) {
      sendTo(state, local.collabId, instanceId, endpoint, 'notice', { event: 'established', version: local.ledger.version });
    }
  }
}

/* 撤回到达（成员侧）：single 定格 withdrawn；all 终止并归档（终态数据本地保留）。 */
function handleWithdrawInbound(state, frame) {
  const local = state.collabs.get(frame.collabId);
  if (local === undefined || local.role !== 'member') {
    return;
  }
  if (frame.payload.scope === 'all') {
    local.member.state = 'terminated';
    local.member.archivedAt = new Date().toISOString();
    persistMember(state, local);
    state.counters.terminatedIn++;
    return;
  }
  if ((local.member.decision ?? null) === null) {
    local.member.decision = 'withdrawn';
    persistMember(state, local);
  }
  state.counters.withdrawn++;
}

function handleNotice(state, frame) {
  const local = state.collabs.get(frame.collabId);
  if (local === undefined) {
    return;
  }
  if (frame.payload.event === 'established') {
    handleEstablished(state, local);
    return;
  }
  state.counters.noticesIn++;
}

/* 建立通告（成员侧）：仅当本地已同意时定格 active——与本地决策矛盾的建立通告忽略并计数
 * （撤回 / 拒绝与建立的时序竞态面）。 */
function handleEstablished(state, local) {
  if (local.role !== 'member') {
    return;
  }
  if (local.member.state !== 'proposed' || (local.member.decision ?? null) !== 'approved') {
    state.counters.eventMismatch++;
    state.log.warn('收到建立通告但本地无对应同意（忽略）', { collabId: local.collabId, decision: local.member.decision ?? null });
    return;
  }
  local.member.state = 'active';
  persistMember(state, local);
  state.counters.establishedIn++;
}

/* 主题到达（管理席位）：主题下发与更新入账（快照随台账变更统一推送）。 */
function handleTopic(state, frame) {
  const local = state.collabs.get(frame.collabId);
  if (local === undefined || local.role !== 'manager') {
    return;
  }
  mutateLedger(state, local, (ledger) => {
    ledger.topic = frame.payload.text;
  });
  state.counters.topicsIn++;
}

/* 进度到达（管理席位）：任务板追加；超上限剪除最旧并计数（有界增长）。 */
function handleProgress(state, frame) {
  const local = state.collabs.get(frame.collabId);
  if (local === undefined || local.role !== 'manager') {
    return;
  }
  mutateLedger(state, local, (ledger) => {
    ledger.board.push({
      entryId: frame.msgId,
      ts: frame.ts,
      from: { instanceId: frame.from.instanceId, identityName: frame.from.identityName },
      kind: 'progress',
      text: frame.payload.text,
    });
    while (ledger.board.length > MAX_BOARD_ENTRIES) {
      ledger.board.shift();
      state.counters.boardEvicted++;
    }
  });
  state.counters.progressIn++;
}

/* 冻结接收（设计 §6）：匹配 → 本地冻结（幂等）→ 转达（每节点对同一原帧至多一次）。 */
function handleFreeze(state, frame) {
  const payload = frame.payload;
  const matched = matchConflictCollabs(state, payload.name, payload.members.map((entry) => entry.instanceId));
  let applied = 0;
  for (const local of matched) {
    if (applyFreezeLocally(state, local, payload.reason)) {
      applied++;
    }
  }
  state.counters.freezeApplied += applied;
  relayFreeze(state, frame, matched);
}

/* 转达（设计 §10 治理类例外；本计划的收敛见定案 11）：逐目标独立入队——防环与防重复由
 * originMsgId 已转达集承载（同 originMsgId 的重复副本不再向外扩散）。 */
function relayFreeze(state, frame, matched) {
  const origin = typeof frame.payload.originMsgId === 'string' && frame.payload.originMsgId !== '' ? frame.payload.originMsgId : frame.msgId;
  if (state.relayedOrigins.has(origin)) {
    return;
  }
  rememberRelayedOrigin(state, origin);
  let relayed = 0;
  for (const local of matched) {
    for (const [instanceId, endpoint] of local.endpoints) {
      if (instanceId === state.self.instanceId || instanceId === frame.from.instanceId) {
        continue;
      }
      const result = sendTo(state, local.collabId, instanceId, endpoint, 'freeze', { ...frame.payload, originMsgId: origin });
      if (result.ok === true) {
        relayed++;
      }
    }
  }
  state.counters.freezeRelayed += relayed;
}

/* 已转达集登记（插入序淘汰——表满丢最旧）。 */
function rememberRelayedOrigin(state, origin) {
  state.relayedOrigins.delete(origin);
  state.relayedOrigins.set(origin, Date.now());
  while (state.relayedOrigins.size > RELAYED_ORIGINS_MAX) {
    const oldest = state.relayedOrigins.keys().next().value;
    state.relayedOrigins.delete(oldest);
  }
}

function handleSnapshot(state, frame) {
  if (frame.payload.kind === 'request') {
    answerSnapshotRequest(state, frame);
    return;
  }
  storeSnapshot(state, frame);
}

/* 快照接收（定案 4）：digest 重算 → 版本不倒退 → 落盘 + 回执 + 唤醒等待中的 view。 */
function storeSnapshot(state, frame) {
  const local = state.collabs.get(frame.collabId);
  if (local === undefined) {
    state.counters.snapshotCorrupt++;
    return;
  }
  const payload = frame.payload;
  if (ledgerDigest(payload.ledger) !== payload.digest) {
    state.counters.snapshotCorrupt++;
    state.log.warn('快照摘要不符（已忽略）', { collabId: frame.collabId, version: payload.version });
    return;
  }
  if (local.snapshot !== null && payload.version < local.snapshot.version) {
    state.counters.snapshotStale++;
    return;
  }
  local.snapshot = {
    version: payload.version,
    digest: payload.digest,
    receivedAt: new Date().toISOString(),
    from: { instanceId: frame.from.instanceId, identityName: frame.from.identityName },
    ledger: payload.ledger,
  };
  persistSnapshot(state, local);
  state.counters.snapshotStored++;
  sendSnapshotReceipt(state, local, frame);
  resolvePendingView(state, local.collabId, local.snapshot);
}

/* 快照回执（「先确认后删除」的确认面，治理移交消费它）：发给快照来源；失败只计数。 */
function sendSnapshotReceipt(state, local, frame) {
  const endpoint = local.endpoints.get(frame.from.instanceId);
  if (endpoint === undefined) {
    return;
  }
  const result = sendTo(state, local.collabId, frame.from.instanceId, endpoint, 'notice', { event: 'snapshot-stored', version: frame.payload.version });
  if (result.ok === true) {
    state.counters.snapshotReceipts++;
  }
}

function resolvePendingView(state, collabId, snapshot) {
  const pending = state.pendingViews.get(collabId);
  if (pending === undefined) {
    return;
  }
  state.pendingViews.delete(collabId);
  clearTimeout(pending.timer);
  pending.resolve(snapshot);
}

/* 快照请求应答：管理席位把当前台账整份回给请求方（端点取请求帧来源；成员侧忽略）。 */
function answerSnapshotRequest(state, frame) {
  const local = state.collabs.get(frame.collabId);
  if (local === undefined || local.role !== 'manager') {
    return;
  }
  const endpoint = local.endpoints.get(frame.from.instanceId);
  if (endpoint === undefined) {
    state.counters.snapshotSkipped++;
    return;
  }
  sendTo(state, local.collabId, frame.from.instanceId, endpoint, 'snapshot', { kind: 'data', version: local.ledger.version, digest: ledgerDigest(local.ledger), ledger: local.ledger });
  state.counters.snapshotSent++;
}

/* 结束到达（成员侧）：归档；重复通告幂等；管理席位收到结束通告忽略（结束只能由本机发起）。 */
function handleEnd(state, frame) {
  const local = state.collabs.get(frame.collabId);
  if (local === undefined || isLocalArchivedState(local)) {
    return;
  }
  if (local.role === 'manager') {
    state.counters.eventMismatch++;
    state.log.warn('管理席位收到结束通告（忽略——结束只能由本机发起）', { collabId: local.collabId });
    return;
  }
  local.member.state = 'completed';
  local.member.archivedAt = new Date().toISOString();
  persistMember(state, local);
  state.counters.endedIn++;
}

/* 退出到达（管理席位）：成员状态入账 + 名单变更通告（既有参与者不重复点头，设计 §6）。 */
function handleLeave(state, frame) {
  const local = state.collabs.get(frame.collabId);
  if (local === undefined || local.role !== 'manager') {
    return;
  }
  const member = local.ledger.members.find((entry) => entry.instanceId === frame.from.instanceId);
  if (member === undefined || member.state === 'left') {
    return;
  }
  mutateLedger(state, local, () => {
    member.state = 'left';
  });
  state.counters.leftIn++;
  for (const instanceId of memberIdsOf(state, local)) {
    const endpoint = local.endpoints.get(instanceId);
    if (endpoint !== undefined) {
      sendTo(state, local.collabId, instanceId, endpoint, 'notice', { event: 'roster', version: local.ledger.version });
    }
  }
}
