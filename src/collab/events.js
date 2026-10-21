import { DEFAULT_COLLAB_MODE, isPort } from '../net/protocol.js';
import { LOCAL_LEFT_STATE, MAX_BOARD_ENTRIES, isSnapshotShape } from './model.js';
import { createPostsStore } from './posts.js';
import { createMembersStore } from './members.js';
import { createCounterStore, notifyIndicatorChange } from './counter.js';
import { createMuteStore } from './mute.js';
import { createInjectedStore } from './injected.js';
import { ledgerDigest } from './store.js';
import { isLocalArchivedState, localModeOf, localStateOf, persistMember, persistSnapshot, rememberKnownHost, selfJoinedOf, upsertLocalSeat } from './local.js';
import { matchConflictCollabs, noteForumGovernanceIgnored } from './gate.js';
import { applyEndpoint, applyFreezeLocally, broadcastFreeze, downgradeToMember, endpointFor, governanceTargets, memberIdsOf, mutateLedger, notifyLocal, relayGovernance, relayRedistribute, selfIsRelay, sendTo, stopJoinReplay } from './outgoing.js';
import { applyIncomingJoin, applyIncomingLeave, handleHistoryBundle, handleHistoryRequest } from './sync.js';
import {
  appendDeparted, applyManagerFreeze, clearFreezeReason, clearManagerFreeze, handleHandshake, handleSeatPresenceFrame, handleTakeover, handleTakeoverInit,
  ledgerTermOf, m5RuntimeOf, managerSeatOfLedger, managerUnreachable, noteDirectFramePresence, presenceSignerOf,
  requestSnapshotFrom, resumeLocal,
} from './takeover.js';
import { handleDecision, handleMergeOutcome, handleMergeRequest, handleUnfreeze } from './freeze.js';
import { adoptHandoverAsTarget, handleAutoOffer, handleHandover } from './handover.js';
import { acceptManagerChange } from './term.js';

/* 接收事件处理（consume 的落点）：端点学习、邀请建记录与冲突检测、回应与建立、撤回 / 退出 / 结束、
 * 主题与进度联动、冻结接收与转达、快照接收 / 回执 / 请求应答、治理与韧性五型（抢接 / 裁定 / 解冻 / 移交 /
 * 握手与站长变更通告）。异常由服务外层统一隔离（绝不穿出）。
 * 事件处理发生在接收管线的「落盘 + ack 之后」——此处失败不回滚消息的受理承诺。 */

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
  post: handlePost,
  join: applyIncomingJoin,
  'history-request': handleHistoryRequest,
  'history-bundle': handleHistoryBundle,
  end: handleEnd,
  leave: handleLeave,
  'takeover-init': handleTakeoverInit,
  takeover: handleTakeover,
  decision: handleDecisionEvent,
  unfreeze: handleUnfreezeEvent,
  handover: handleHandover,
  'seat-presence': handleSeatPresenceEvent,
};

/* notice 事件分发表（建协 / 协作 + 治理扩展）：未挂表事件只计数（前向兼容面）。 */
const NOTICE_HANDLERS = {
  established: handleEstablished,
  'manager-changed': handleManagerChanged,
  'auto-offer': (state, frame) => handleAutoOffer(state, frame),
  handshake: handleHandshake,
  'merge-request': handleMergeRequest,
  'merge-outcome': handleMergeOutcome,
};

/* 事件分发：返回值透传（帖去重栅栏的「不重复注入会话」声明经此到达接收管线）。
 * presence 必须在端点学习之前判定：先学端点会把本帧来源地址写成权威端点，
 * 使「传输对端」校验退化为自证（见 presence 的 peerInstanceId 契约）。 */
export async function handleEvent(state, frame, meta) {
  refreshPresenceBeforeLearn(state, frame, meta);
  learnEndpoints(state, frame, meta);
  const handler = EVENT_HANDLERS[frame.type];
  if (handler !== undefined) {
    return await handler(state, frame, meta);
  }
  return undefined;
}

function refreshPresenceBeforeLearn(state, frame, meta) {
  if (frame.type === 'seat-presence') {
    handleSeatPresenceFrame(state, frame, meta);
    return;
  }
  noteDirectFramePresence(state, frame, meta);
}

/* 解除冻结/裁定执行后清除 M5 侧的冻结原因（载体与成员记录）：冻结态已不在 → 观察窗不得继续显示。
 * 台账 status 由 legacy 冻结族维护；本函数只清展示原因，不改状态机。 */
function handleUnfreezeEvent(state, frame) {
  const result = handleUnfreeze(state, frame);
  clearStaleFreezeReasons(state);
  return result;
}

function handleDecisionEvent(state, frame) {
  const result = handleDecision(state, frame);
  clearStaleFreezeReasons(state);
  return result;
}

function clearStaleFreezeReasons(state) {
  const frozen = m5RuntimeOf(state).frozen;
  for (const local of state.collabs.values()) {
    if (frozen.has(local.collabId) || localStateOf(local) === 'frozen') {
      continue;
    }
    clearFreezeReason(state, local.collabId);
  }
}

/* 席位心跳是核级事实，不进会话注入（与拉取通道同一呈现口径）。 */
function handleSeatPresenceEvent() {
  return { sessionDeliver: false };
}

/* 端点学习（设计 §5「清单随协作参与关系更新」的接入面）：已受理帧的来源地址与端口记入
 * 对应协作的端点表（仅当本机在协作中——注册表命中），并同步 known-hosts（单播兜底目标）。
 * 仅在端点变化时写 member.json（避免每条消息一次写盘）；学习到现任站长端点时补做队列重定向、
 * 学到生效抢接记录的成员端点时补发通告（「未入队即无重试」的盲区收窄）。
 * known-hosts 清单的 lastSeenAt 逐帧刷新（供单播兜底择新），其落盘由清单自身的节流窗口
 * 合并（见 net/known-hosts.js）——「避免每条消息一次写盘」在此按两处口径各自成立。
 * 「任一成功接触」口径：任何已受理帧（不限于握手）都证明对端可达——顺手解除无法对表的挂起。 */
function learnEndpoints(state, frame, meta) {
  const local = state.collabs.get(frame.collabId);
  if (local === undefined) {
    return;
  }
  const address = typeof meta?.remoteAddress === 'string' ? meta.remoteAddress : '';
  if (address === '' || !isPort(frame.from?.port)) {
    return;
  }
  learnDirectFrameEndpoints(state, local, frame, address);
  if (local.suspended !== null && local.suspended.reason === 'handshake-unresolved') {
    resumeLocal(state, local, 'handshake-contacted');
  }
  local.handshakeUnresolved = false;
}

/* 直连帧端点学习（转达副本的 from 是原发者、链路地址是转达者的——据此学习会把原发者端点记成
 * 转达者地址（错误寻址）：转达帧不作端点学习，仍作「任一成功接触」的可达性证据）；端点更新时
 * 补发生效通告（「未入队即无重试」的盲区收窄）。 */
function learnDirectFrameEndpoints(state, local, frame, address) {
  if (isRelayedCopy(frame)) {
    return;
  }
  applyEndpoint(state, local, frame.from, address, frame.from.port);
}

/* 转达副本判别：转达出口在载荷里带 originMsgId（原生帧没有）。 */
function isRelayedCopy(frame) {
  return typeof frame.payload?.originMsgId === 'string' && frame.payload.originMsgId !== '';
}

/* 邀请到达（admit 已做名单 / 频率 / 上限判定）：创建本地参与记录（proposed），冲突检测命中则
 * 直接冻结本记录并广播（第一检测点，设计 §6）；两种结局都投递会话（同意门入口）。
 * 讨论邀请跳过冲突检测（设计 §6 实现面②）：讨论不参与同名冲突匹配，到达即建记录。
 * 同一 collabId 的再次邀请不再丢弃（讨论侧"并发/重复邀请互认"与"退出后重入"两处修复，
 * 设计 §5.1/§5.4）；managed 的既有重复邀请语义（拒绝）不变。 */
function handleInvite(state, frame, meta) {
  recordPendingInvite(state, frame);
  const existing = state.collabs.get(frame.collabId);
  if (existing !== undefined) {
    receiveRepeatInvite(state, existing, frame, meta);
    return;
  }
  const member = inviteRecordOf(state, frame);
  const local = {
    collabId: frame.collabId,
    role: 'member',
    ledger: null,
    member,
    endpoints: new Map(),
    snapshot: null,
    posts: createPostsStore({ dataDir: state.dataDir, collabId: frame.collabId, log: state.log, onChange: () => notifyIndicatorChange(state) }),
    members: createMembersStore({ dataDir: state.dataDir, collabId: frame.collabId, log: state.log, onChange: () => notifyIndicatorChange(state) }),
    counter: createCounterStore({ dataDir: state.dataDir, collabId: frame.collabId, log: state.log, onChange: () => notifyIndicatorChange(state) }),
    mute: createMuteStore({ dataDir: state.dataDir, collabId: frame.collabId, log: state.log }),
    injected: createInjectedStore({ dataDir: state.dataDir, collabId: frame.collabId, log: state.log }),
    suspended: null,
    staleManagerId: null,
  };
  learnInviteSource(state, local, frame, meta);
  learnInviteEndpoints(state, local, frame);
  state.counters.invitesReceived++;
  if (member.mode !== 'forum') {
    const conflict = matchConflictCollabs(state, member.name, member.roster.map((entry) => entry.instanceId));
    if (conflict.length > 0) {
      freezeOnInviteConflict(state, frame, local, conflict);
      return;
    }
  }
  state.collabs.set(frame.collabId, local);
  persistMember(state, local);
}

/* 目标机挂起邀请登记（M4 域）：未入席会话据此在注册时收到补投；forum 无邀请簿记（D18）。 */
function recordPendingInvite(state, frame) {
  if (typeof state.join?.handleInviteFrame !== 'function') {
    return;
  }
  const result = state.join.handleInviteFrame(frame);
  if (result?.ok !== true) {
    bump(state, 'pendingInviteRejected');
    state.log.warn('挂起邀请登记失败（已忽略）', { collabId: frame.collabId, reason: result?.reason ?? result?.ignored });
  }
}

/* 同 collabId 再次邀请（讨论与可重入的协作共用）：讨论＝就地互认——已加入者只学端点（重复 join
 * 由事件日志幂等吸收）；未加入者（含已拒绝、已过期、已退出重入）重新定格提议面（新有效期、最新
 * 名单与主题），事件日志与帖子原样保留（重入回填按同步游标续拉）。协作（managed）仅在本地参与
 * 处于可重入终局（已退出 / 已拒绝 / 已撤回）时受理重邀，重走同意门；其余重复邀请照旧拒绝。 */
function receiveRepeatInvite(state, existing, frame, meta) {
  const localMode = localModeOf(existing);
  const incomingMode = frame.payload.mode ?? DEFAULT_COLLAB_MODE;
  learnInviteSource(state, existing, frame, meta);
  learnInviteEndpoints(state, existing, frame);
  if (localMode === 'forum' && incomingMode === 'forum') {
    state.counters.invitesReceived++;
    if (selfJoinedOf(existing, state.self.instanceId)) {
      return;   // 已加入：邀请幂等（并集吸收），不动本地成员面
    }
    resetProposedRecord(state, existing, frame);
    return;
  }
  if (localMode === 'managed' && incomingMode === 'managed' && isRejoinableMember(existing)) {
    /* 终局行可再入席（2026-10-19 产品裁定）：重邀重新定格提议面，是否入席仍由同意门决定。 */
    state.counters.invitesReceived++;
    resetProposedRecord(state, existing, frame);
    return;
  }
  state.counters.invitesRejected++;
}

/* 可重入的本地终局：成员记录已退出（left），或邀请决策已拒绝 / 已撤回——重邀重新定格提议面。
 * 站长记录不在此列（协作由站长本机持有，重邀无意义）；已加入（approved）不重入。 */
function isRejoinableMember(existing) {
  if (existing.role !== 'member') {
    return false;
  }
  if (localStateOf(existing) === LOCAL_LEFT_STATE) {
    return true;
  }
  return existing.member.decision === 'declined' || existing.member.decision === 'withdrawn';
}

/* 提议面重定格（讨论重入与协作可重入共用）：新有效期、最新名单 / 主题 / 邀请者引用；退出标记
 * 清除，事件日志 / 帖子 / 输出队列原样保留（重入按同步游标续拉）。 */
function resetProposedRecord(state, existing, frame) {
  const now = new Date().toISOString();
  existing.member.state = 'proposed';
  existing.member.decision = null;
  existing.member.invitedAt = now;
  existing.member.expiresAt = new Date(Date.parse(now) + state.config.inviteTtlMs).toISOString();
  existing.member.roster = inviteRosterOf(frame);
  existing.member.topic = frame.payload.topic;
  /* 邀请者引用随最新邀请定格（换人二次邀请的重入者）：join 广播、对表候选与 approve/decline
   * 簿记都以它为准——旧引用指向已退出/长期离线的邀请者时，重入者会再次被孤立。 */
  existing.member.manager = { instanceId: frame.from.instanceId, identityName: frame.from.identityName };
  /* 发起人标识（中继归属）随最新邀请补学；载荷未携带或值被拒（自指）时保留既有知识
   * （发起人不随邀请者变——构造性邀请也不得把受邀者自身改写成中继）。 */
  const originator = payloadOriginatorOf(state, frame);
  if (originator !== undefined) {
    existing.member.originator = originator;
  }
  delete existing.member.archivedAt;
  persistMember(state, existing);
}

/* 邀请定格的本地记录（roster 供冲突交集判据在成员侧取数；有效期自本地收到时刻起算）。
 * 模式随邀请载荷定格（缺字段按 managed 解释——旧版对端不携带该字段）；主题随记录定格
 * （成员侧发起邀请的取数面）；发起人实例标识（中继归属）随载荷定格——缺字段 = 旧版形态，
 * 按「中继未知」处理（发帖降级直投，待 bundle 元状态补学）。 */
function inviteRecordOf(state, frame) {
  const now = new Date().toISOString();
  return {
    collabId: frame.collabId,
    role: 'member',
    state: 'proposed',
    name: frame.payload.name,
    topic: frame.payload.topic,
    mode: frame.payload.mode ?? DEFAULT_COLLAB_MODE,
    manager: { instanceId: frame.from.instanceId, identityName: frame.from.identityName },
    originator: payloadOriginatorOf(state, frame),
    roster: inviteRosterOf(frame),
    endpoints: {},
    invitedAt: now,
    expiresAt: new Date(Date.parse(now) + state.config.inviteTtlMs).toISOString(),
    decision: null,
  };
}

/* 邀请载荷的发起人标识（协议层已过身份对形态；缺省 undefined = 未学到）。
 * 自指值（instanceId = 本机）拒绝并计数：发起人恒为他人他机（本机若为发起人则不经邀请路径
 * 收帧），自指只可能来自伪造或损坏，学入会让本机把自己当中继、把该讨论的转发职责错判给己
 * （与 bundle 元状态学习面 learnForumOriginator 同判据同计数）。 */
function payloadOriginatorOf(state, frame) {
  const originator = frame.payload.originator;
  if (originator === undefined) {
    return undefined;
  }
  if (originator.instanceId === state.self.instanceId) {
    state.counters.forumMetaRejected++;
    return undefined;
  }
  return { instanceId: originator.instanceId, identityName: originator.identityName };
}

function inviteRosterOf(frame) {
  return frame.payload.members.map((entry) => ({ instanceId: entry.instanceId, identityName: entry.identityName }));
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

/* 邀请载荷随带的端点表学习（讨论邀请；设计 §5.1）：被邀者据此取得入群寻址信息——
 * 加入后的 join 自播与回填对表由此不盲。身份名尽力取（邀请名单里找），缺名不拒（寻址不受影响）。 */
function learnInviteEndpoints(state, local, frame) {
  const endpoints = frame.payload?.endpoints;
  if (endpoints === undefined) {
    return;
  }
  for (const [instanceId, endpoint] of Object.entries(endpoints)) {
    if (instanceId === state.self.instanceId) {
      continue;
    }
    const identityName = local.member.roster.find((entry) => entry.instanceId === instanceId)?.identityName ?? '';
    applyEndpoint(state, local, { instanceId, identityName }, endpoint.address, endpoint.port);
  }
}

/* 冲突检出（第一检测点）：冻结新到那条并连带冻结本机全部匹配协作（检出方本地一并冻上，
 * 避免旧那条在检出机与另一机的副本形成分叉），随后广播。广播 reason 用固定短文案
 * （协议上限 200 字符——拼接多个实例标识会越界；明细在日志字段里）。 */
function freezeOnInviteConflict(state, frame, local, conflict) {
  const now = new Date().toISOString();
  local.member.state = 'frozen';
  local.member.frozenAt = now;
  local.member.frozenFrom = 'proposed';
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

/* 同意帧携 inviteId（M4 会话级邀请）：转加入域的批准面签发 join-grant；无 inviteId 的旧形态
 * 或讨论实例仍走本地回应记账。 */
function handleApproveResponse(state, frame) {
  if (typeof frame.payload?.inviteId === 'string' && typeof state.join?.handleInviteApproval === 'function') {
    const result = state.join.handleInviteApproval(frame);
    if (result !== null && result !== undefined) {
      return result;
    }
  }
  applyInviteResponse(state, frame, 'approved');
}

function handleDeclineResponse(state, frame) {
  applyInviteResponse(state, frame, 'declined');
}

/* 站长席位侧：邀请回应只记账与提示——共享名单是 active-only 席位表，邀请在途态只存在于
 * invites/pending-invites（M4 域）。入席由两段式 join-confirm 完成（M2/M4 接线），本函数
 * 不再把 invited/approved 写进共享名单。 */
function applyInviteResponse(state, frame, wanted) {
  const local = state.collabs.get(frame.collabId);
  if (local === undefined || local.role !== 'manager') {
    return;
  }
  if (local.ledger.status !== 'proposed' && local.ledger.status !== 'active') {
    return;
  }
  if (localModeOf(local) === 'forum') {
    return;
  }
  if (local.ledger.members.some((entry) => entry.instanceId === frame.from.instanceId
    && (entry.sessionId === undefined || entry.sessionId === frame.from.sessionId))) {
    state.counters.eventMismatch++;
    return;
  }
  countResponse(state, wanted);
  state.log.info('邀请回应已记录（入席由两段式 join-confirm 完成）', {
    collabId: local.collabId,
    from: frame.from.instanceId,
    wanted,
  });
}

function countResponse(state, wanted) {
  if (wanted === 'approved') {
    state.counters.approvalsIn++;
  } else {
    state.counters.declinesIn++;
  }
}

/* 建立判定点（active-only）：共享名单内已有非站长席位即建立。邀请在途（尚未 join-confirm）
 * 不占名单，故不再以 invited/approved 作为判据；讨论模式走加入事件，不在此路径。 */
export function maybeEstablish(state, local) {
  if (localModeOf(local) === 'forum' || local.ledger.status !== 'proposed') {
    return;
  }
  if (!local.ledger.members.some((entry) => entry.role !== 'manager')) {
    state.log.warn('尚无已入席成员——协作保持提议中（可整条撤回）', { collabId: local.collabId });
    return;
  }
  const others = matchConflictCollabs(state, local.ledger.name, activeSeatKeysOf(local.ledger))
    .filter((entry) => entry.collabId !== local.collabId);
  if (others.length > 0) {
    state.counters.freezeDetected++;
    applyFreezeLocally(state, local, `建立前检出同名冲突（与 ${others.map((entry) => entry.collabId).join('、')}）`);
    broadcastFreeze(state, local, '建立前检出同名冲突');
    return;
  }
  establish(state, local);
}

function activeSeatKeysOf(ledger) {
  return ledger.members.map((entry) => entry.instanceId);
}

/* 建立：状态转 active（名单已是 active-only，无需再翻状态）；快照由台账变更统一推送，
 * 随后广播建立通告。 */
function establish(state, local) {
  mutateLedger(state, local, (ledger) => {
    ledger.status = 'active';
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

function broadcastRosterNotice(state, local) {
  for (const instanceId of memberIdsOf(state, local)) {
    const endpoint = local.endpoints.get(instanceId);
    if (endpoint !== undefined) {
      sendTo(state, local.collabId, instanceId, endpoint, 'notice', { event: 'roster', version: local.ledger.version });
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
    local.mute.clear();
    state.counters.terminatedIn++;
    return;
  }
  if ((local.member.decision ?? null) === null) {
    local.member.decision = 'withdrawn';
    persistMember(state, local);
  }
  state.counters.withdrawn++;
}

async function handleNotice(state, frame) {
  const local = state.collabs.get(frame.collabId);
  if (local === undefined) {
    return;
  }
  const handler = NOTICE_HANDLERS[frame.payload.event];
  if (handler !== undefined) {
    await handler(state, frame);
    return;
  }
  state.counters.noticesIn++;
}

/* 建立通告（成员侧）：仅当本地已同意时定格 active——与本地决策矛盾的建立通告忽略并计数
 * （撤回 / 拒绝与建立的时序竞态面）。 */
function handleEstablished(state, frame) {
  const local = state.collabs.get(frame.collabId);
  if (local === undefined || local.role !== 'member') {
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

/* 主题到达（站长席位）：主题下发与更新入账（快照随台账变更统一推送）。 */
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

/* 进度到达（站长席位）：任务板追加；超上限剪除最旧并计数（有界增长）。 */
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

/* 帖到达（讨论实例；准入已判模式与词表）：按（作者实例标识, postId）幂等入本地列表——
 * 重复路径副本不再入列（计数留痕、无害）；帖只追加、不改任何元状态（topic 帖亦按普通帖处理，
 * 主题创建时定死）。ts 取帧 ts（作者侧落盘强制单调、随帖携带）；entryId 取载荷 postId 原样
 * （该帖在全部副本中的稳定标识）。
 * 投稿转达（中继侧）：payload.relay 标记 = 成员发往中继的投稿（设计 §5.2 投稿识别形态）——
 * 中继本机（发起人）对首发入列的投稿扇出转达（重复副本由列表去重吸收、不重复扇出；
 * 非中继节点与未标记的直投副本只入列、不转达——见 relayRedistribute 的两可项选定）。
 * 注入栅栏（限帖通道、不泛化）：去重命中的副本以 sessionDeliver:false 声明不重复注入会话
 * （`(作者, postId)` 去重结果参与投递判定）——不同 msgId 的重复路径副本由此不再二次通知；
 * managed 的「受理帧仍注入」行为不受影响（本声明只由帖通道发出，接收管线只在该类型采信）。
 * 去重命中同时带回 wasInjected（（作者, postId）是否曾实际注入会话）：接收管线以它为
 * 「已受理（重复）」终态回报的前件——静音期未注入的首份副本，其重复副本不回报终态。 */
function handlePost(state, frame) {
  const local = state.collabs.get(frame.collabId);
  if (local === undefined || localModeOf(local) !== 'forum') {
    return;   // 准入已保证（此处为直调 consume 的防御面：不把帖写进 managed 实例的列表）
  }
  const post = frame.payload.post;
  const added = local.posts.append({
    entryId: post.postId,
    seq: post.seq,
    ts: frame.ts,
    from: { instanceId: frame.from.instanceId, identityName: frame.from.identityName },
    kind: post.kind,
    text: post.text,
  });
  if (!added) {
    state.counters.postsDuplicated++;
    return { sessionDeliver: false, wasInjected: local.injected.has(frame.from.instanceId, post.postId) };
  }
  state.counters.postsIn++;
  handleRelaySubmission(state, local, frame);
  return undefined;
}

/* 投稿转达触发（中继侧）：标记命中 + 本机即中继 + 投稿人 ∈ 折叠成员表（单一取数面）才转达。
 * 非成员不转达并计数——防任意知 collabId 者借中继把一帧放大为全员直投与会话注入（帖子本身的
 * 受理 / 落盘 / 去重照旧：全信任模型的内容面不变，只堵 1→N 的放大路径）。 */
function handleRelaySubmission(state, local, frame) {
  if (frame.payload.relay !== true || frame.from.instanceId === state.self.instanceId || !selfIsRelay(state, local)) {
    return;
  }
  if (!local.members.includes(frame.from.instanceId)) {
    state.counters.relaySubmissionsRejected++;
    return;
  }
  state.counters.relaySubmissionsIn++;
  relayRedistribute(state, local, frame);
}

/* 冻结接收（设计 §6）：匹配 → 记下对端名单（合并并集的输入）→ 本地冻结（幂等）→ 转达
 * （每节点对同一原帧至多一次）。命中讨论实例（准入已受理 + ack）：忽略并计数——冻结规程
 * 不施于讨论、转达面也不进入（讨论无治理面）；忽略的帧以 sessionDeliver:false 声明不注入
 * 会话（设计 §5.7 裁定：讨论无冻结概念，注入只会困惑接收模型）。 */
function handleFreeze(state, frame) {
  const payload = frame.payload;
  const matched = matchConflictCollabs(state, payload.name, payload.members.map((entry) => entry.instanceId));
  if (matched.length === 0) {
    return noteForumGovernanceIgnored(state, frame) ? { sessionDeliver: false } : undefined;
  }
  let applied = 0;
  for (const local of matched) {
    /* 帧描述的是「检出方的那条」——记录到本地其它匹配条上即对端数据（合并并集与保留方判定的输入）。 */
    if (local.collabId !== frame.collabId) {
      local.conflictRival = {
        name: payload.name,
        members: payload.members.map((entry) => ({ instanceId: entry.instanceId, identityName: entry.identityName })),
        createdAt: payload.createdAt,
        managerInstanceId: payload.manager?.instanceId,
      };
    }
    if (applyFreezeLocally(state, local, payload.reason)) {
      applied++;
    }
  }
  state.counters.freezeApplied += applied;
  relayFreeze(state, frame, matched);
}

/* 转达：matched 协作的端点并集交给通用治理转达出口（逐目标独立入队 + originMsgId 防环）。 */
function relayFreeze(state, frame, matched) {
  /* 寻址与其余治理帧同口径（协作端点表 + 站点级清单回退）——不因实现路径分裂转达面。 */
  const targets = new Map();
  for (const local of matched) {
    for (const [instanceId, target] of governanceTargets(state, local)) {
      if (!targets.has(instanceId)) {
        targets.set(instanceId, target);
      }
    }
  }
  state.counters.freezeRelayed += relayGovernance(state, frame, targets);
}

function handleSnapshot(state, frame) {
  if (frame.payload.kind === 'request') {
    answerSnapshotRequest(state, frame);
    return;
  }
  acceptSnapshotFrame(state, frame);
}

/* 快照受理（设计 §2A.2 A10–A14）：形态 → 自洽 → digest 重算 → 任期判决 → 落盘/回执。
 * A10 离线追赶按用户裁定只认本机已收到的匹配 auto-offer：无本地 offer 的更高任期快照一律冻结，
 * 不采用「仅凭 ledger.events 自证」的追赶路径。 */
function acceptSnapshotFrame(state, frame) {
  const local = state.collabs.get(frame.collabId);
  if (local === undefined) {
    bump(state, 'snapshotCorrupt');
    return;
  }
  const termState = termStateOf(state, local);
  const record = snapshotRecordOf(frame);
  if (termState === null || !isSnapshotShape(record) || record.version !== record.ledger.version
    || record.ledger.collabId !== frame.collabId) {
    bump(state, 'snapshotCorrupt');
    state.log.warn('快照载荷不合形态或与帧不自洽（已忽略）', { collabId: frame.collabId });
    return;
  }
  if (ledgerDigest(record.ledger) !== record.digest) {
    bump(state, 'snapshotCorrupt');
    state.log.warn('快照摘要不符（已忽略）', { collabId: frame.collabId, version: record.version });
    return;
  }
  const ctx = termCtxOf(state, local, frame);
  const gate = snapshotAutoCatchupGate(state, local, frame, termState, ctx);
  const result = gate ?? acceptManagerChange(termState, frame.payload, ctx);
  applyManagerResult(state, local, frame, result);
  if (result.accepted === true || /** @type {any} */ (result).idempotent === true) {
    storeAcceptedSnapshot(state, local, record);
    sendSnapshotReceipt(state, local, frame);
    resolvePendingView(state, local.collabId, local.snapshot);
  }
}

/* 接收记录成形：与本地快照文件同一形态（同一份数据在接收侧与加载侧过同一校验）。 */
function snapshotRecordOf(frame) {
  const payload = frame.payload;
  return {
    version: payload?.version,
    digest: payload?.digest,
    receivedAt: new Date().toISOString(),
    from: { instanceId: frame.from.instanceId, identityName: frame.from.identityName },
    ledger: payload?.ledger,
  };
}

function storeAcceptedSnapshot(state, local, record) {
  local.snapshot = record;
  persistSnapshot(state, local);
  clearUnverifiedSeats(state, local, record.ledger);
  bump(state, 'snapshotStored');
  const runtime = m5RuntimeOf(state);
  const override = runtime.termState?.get(local.collabId);
  if (override !== undefined && override.managerTerm <= ledgerTermOf(record.ledger)) {
    runtime.termState.delete(local.collabId);
  }
}

/* 快照含本席 → 清除 unverified（两段式入席的收敛面，设计 §4.4⑤）：自此可发消息。 */
function clearUnverifiedSeats(state, local, ledger) {
  const members = Array.isArray(ledger?.members) ? ledger.members : [];
  for (const seat of local.seats?.values?.() ?? []) {
    if (seat.unverified !== true || !isSelfSeatIn(members, state.self.instanceId, seat.sessionId)) {
      continue;
    }
    upsertLocalSeat(local, { ...seat, unverified: false }, { persist: true, dataDir: state.dataDir });
    bump(state, 'unverifiedCleared');
  }
}

function isSelfSeatIn(members, instanceId, sessionId) {
  return members.some((member) => member.instanceId === instanceId
    && (member.sessionId === undefined || member.sessionId === sessionId));
}

/* 快照回执（「先确认后删除」的确认面，治理移交消费它）：发给快照来源；失败只计数。 */
function sendSnapshotReceipt(state, local, frame) {
  const endpoint = local.endpoints.get(frame.from.instanceId);
  if (endpoint === undefined) {
    return;
  }
  const result = sendTo(state, local.collabId, frame.from.instanceId, endpoint, 'notice', {
    event: 'snapshot-stored',
    version: frame.payload.version,
  }, { fromSessionId: presenceSignerOf(local)?.sessionId });
  if (result.ok === true) {
    bump(state, 'snapshotReceipts');
  }
}

function resolvePendingView(state, collabId, snapshot) {
  const held = state.pendingViews.get(collabId);
  if (held === undefined) {
    return;
  }
  state.pendingViews.delete(collabId);
  for (const waiter of held) {
    clearTimeout(waiter.timer);
    waiter.resolve(snapshot);   // 全部等待面拿到同一份应答（并发 view 互不顶替）
  }
}

/* 快照请求应答（生产端必须携 managerTerm 与 managerWindow，否则出站预检拒收）：
 * 活跃站长、冻结态成员（catch-up）、manager-pending 的等待对象均可应答；
 * 载荷冻结为台账副本，digest 覆盖含 managerWindow 的最终形态。 */
function answerSnapshotRequest(state, frame) {
  const local = state.collabs.get(frame.collabId);
  const ledgerSource = local === undefined ? null : (local.role === 'manager' ? local.ledger : local.snapshot?.ledger);
  if (!isSnapshotAnswerAllowed(state, local, frame, ledgerSource)) {
    bump(state, 'snapshotSkipped');
    return;
  }
  const endpoint = local.endpoints.get(frame.from.instanceId);
  if (endpoint === undefined) {
    bump(state, 'snapshotSkipped');
    return;
  }
  const ledger = normalizedSnapshotLedger(ledgerSource);
  const payload = {
    kind: 'data',
    managerTerm: ledgerTermOf(ledger),
    version: ledger.version,
    digest: ledgerDigest(ledger),
    ledger,
    ...(ledger.managerWindow === undefined ? {} : { managerWindow: { ...ledger.managerWindow } }),
    ...(isCatchupAnswerOf(state, local, frame) ? { purpose: 'catchup' } : {}),
  };
  const sent = sendTo(state, local.collabId, frame.from.instanceId, endpoint, 'snapshot', payload, {
    fromSessionId: presenceSignerOf(local)?.sessionId,
  });
  if (sent.ok === true) {
    bump(state, 'snapshotSent');
  }
}

function isSnapshotAnswerAllowed(state, local, frame, ledgerSource) {
  if (local === undefined || !isPlainObject(ledgerSource)) {
    return false;
  }
  if (local.role === 'manager' && local.suspended === null) {
    return true;
  }
  const frozen = m5RuntimeOf(state).frozen.get(local.collabId);
  if (frozen !== undefined && frame.payload.purpose === 'catchup') {
    return true;
  }
  const pending = m5RuntimeOf(state).managerPending.get(local.collabId);
  return pending !== undefined && frame.from.instanceId === pending.target?.instanceId;
}

function isCatchupAnswerOf(state, local, frame) {
  return frame.payload.purpose === 'catchup' || m5RuntimeOf(state).frozen.has(local.collabId);
}

/* 快照生产端归一：补任期面字段（旧台账兼容）并保证 events 数组随台账落盘。
 * 只用于本机产出的副本；接收侧的 digest 校验始终按原始台账。 */
function normalizedSnapshotLedger(source) {
  const ledger = structuredClone(source);
  if (!Number.isInteger(ledger.managerTerm)) {
    ledger.managerTerm = 1;
  }
  if (!Number.isInteger(ledger.joinSeqNext)) {
    ledger.joinSeqNext = Math.max(2, ...ledger.members.map((member) => (Number.isInteger(member.joinSeq) ? member.joinSeq + 1 : 2)));
  }
  if (isPlainObject(ledger.manager) && ledger.manager.term === undefined) {
    ledger.manager.term = ledger.managerTerm;
  }
  if (!Array.isArray(ledger.events)) {
    ledger.events = [];
  }
  return ledger;
}

/* 结束到达（成员侧）：归档；重复通告幂等；站长席位收到结束通告忽略（结束只能由本机发起）。
 * 讨论实例的发起人同样收不到合法的 end（仅发起人可 end——发送侧守卫在 outgoing.js 的 endCollab）；
 * 成员侧归档即停 join 重播与对表（end 双通道之一：在线广播；离线者经 bundle 元状态学到）。 */
function handleEnd(state, frame) {
  const local = state.collabs.get(frame.collabId);
  if (local === undefined || isLocalArchivedState(local)) {
    return;
  }
  if (local.role === 'manager') {
    state.counters.eventMismatch++;
    state.log.warn('站长席位收到结束通告（忽略——结束只能由本机发起）', { collabId: local.collabId });
    return;
  }
  local.member.state = 'completed';
  local.member.archivedAt = new Date().toISOString();
  persistMember(state, local);
  local.mute.clear();
  stopJoinReplay(state, local);
  state.counters.endedIn++;
}

/* 退出到达：讨论 = 成员事件并入（折叠出表）+ 触发对表（设计 §5.4——leave 是广播事件，
 * 由接收方按事件集并集吸收）；managed = 站长席位记成员状态 + 名单变更通告（设计 §6）。 */
function handleLeave(state, frame) {
  const local = state.collabs.get(frame.collabId);
  if (local === undefined) {
    return;
  }
  if (localModeOf(local) === 'forum') {
    applyIncomingLeave(state, local, frame);
    return;
  }
  const row = leaveRowOf(local, frame);
  if (!leaveAuthorized(row, frame)) {
    bump(state, 'leaveRejected');
    state.log.warn('离席来源或目标席位不符（拒绝并计数）', { collabId: local.collabId, from: frame.from.instanceId, reason: frame.payload?.reason });
    return;
  }
  recordLeave(state, local, row, frame);
  if (local.role === 'manager' && row !== null) {
    removeLeaveRow(state, local, row, frame);
  }
}

/* 名单行定位：先按席位键，旧台账（无 sessionId）退回实例键。 */
function leaveRowOf(local, frame) {
  return local.ledger.members.find((entry) => entry.instanceId === frame.from.instanceId
    && (entry.sessionId === undefined || entry.sessionId === frame.from.sessionId)) ?? null;
}

/* 两分支权威（设计 §3.2）：作者自离（from=离席席位）或现任站长代写名单事件
 * （manager-lost / manager-session-closed）。目标席位不要求当前仍在名单（快照先到幂等）。 */
function leaveAuthorized(row, frame) {
  if (row === null) {
    return false;
  }
  if (row.instanceId === frame.from.instanceId && (row.sessionId === undefined || row.sessionId === frame.from.sessionId)) {
    return true;
  }
  const reason = frame.payload?.reason;
  return ['manager-lost', 'manager-session-closed'].includes(reason);
}

function recordLeave(state, local, row, frame) {
  const reason = typeof frame.payload?.reason === 'string' ? frame.payload.reason : 'session-closed';
  appendDeparted(state, local.collabId, {
    instanceId: frame.from.instanceId,
    sessionId: frame.from.sessionId ?? row?.sessionId ?? null,
    reason,
    term: ledgerTermOf(local.ledger),
  });
  bump(state, 'leftIn');
}

function removeLeaveRow(state, local, row, frame) {
  const reason = typeof frame.payload?.reason === 'string' ? frame.payload.reason : 'session-closed';
  if (row.role === 'manager') {
    return;   // 站长席位由 manager-changed/自动移交移除；单条 leave 不删唯一站长
  }
  mutateLedger(state, local, (ledger) => {
    ledger.members = ledger.members.filter((member) => member !== row);
    ledger.events = [...(Array.isArray(ledger.events) ? ledger.events : []), {
      type: 'leave',
      seat: { instanceId: row.instanceId, sessionId: row.sessionId, identityName: row.identityName },
      reason,
      term: ledgerTermOf(ledger),
      at: new Date().toISOString(),
    }];
  });
  broadcastRosterNotice(state, local);
}

/* —— 任期接线（设计 §2A.2 受理表）：term.js 只做判决，本层组 ctx、落台账与执行 actions。 —— */

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bump(state, key) {
  state.counters[key] = (state.counters[key] ?? 0) + 1;
}

function sameSeat(left, right) {
  return isPlainObject(left) && isPlainObject(right)
    && left.instanceId === right.instanceId
    && left.sessionId === right.sessionId;
}

function termMapsOf(state) {
  const runtime = m5RuntimeOf(state);
  for (const name of ['termState', 'acceptedManagerMap', 'rejectedChangeFromMap', 'authorizedEvidenceMap']) {
    if (!(runtime[name] instanceof Map)) {
      runtime[name] = new Map();
    }
  }
  return {
    termState: runtime.termState,
    accepted: runtime.acceptedManagerMap,
    rejected: runtime.rejectedChangeFromMap,
    authorized: runtime.authorizedEvidenceMap,
  };
}

function termLedgerOf(local) {
  return local.role === 'manager' ? local.ledger : local.snapshot?.ledger;
}

function termStateOf(state, local) {
  const override = termMapsOf(state).termState.get(local.collabId);
  const ledgerState = ledgerStateOf(state, local);
  if (override === undefined) {
    return ledgerState;
  }
  if (ledgerState === null) {
    return override;
  }
  return compareTermStates(override, ledgerState) >= 0 ? override : ledgerState;
}

function ledgerStateOf(state, local) {
  const ledger = termLedgerOf(local);
  if (!isPlainObject(ledger) || !Number.isInteger(ledger.version)) {
    return null;
  }
  if (ledger.manager === null) {
    return { managerTerm: ledgerTermOf(ledger), manager: null, version: ledger.version };
  }
  const manager = managerSeatOfLedger(state, local);
  if (manager === null) {
    return null;
  }
  return {
    managerTerm: ledgerTermOf(ledger),
    manager: { instanceId: manager.instanceId, sessionId: manager.sessionId, identityName: manager.identityName },
    version: ledger.version,
    ...(isPlainObject(ledger.managerWindow) ? { managerWindow: { ...ledger.managerWindow } } : {}),
  };
}

function compareTermStates(left, right) {
  if (left.managerTerm !== right.managerTerm) {
    return left.managerTerm - right.managerTerm;
  }
  return (left.version ?? 0) - (right.version ?? 0);
}

function termCtxOf(state, local, frame) {
  const runtime = m5RuntimeOf(state);
  const maps = termMapsOf(state);
  const manager = managerSeatOfLedger(state, local);
  const pendingOffer = runtime.managerPending.get(local.collabId) ?? runtime.autoPending.get(local.collabId);
  return {
    now: Date.now(),
    localFrozen: runtime.frozen.get(local.collabId) ?? null,
    memberSeats: memberSeatsOf(local),
    isMemberSeat: (seat) => memberSeatsOf(local).some((entry) => sameSeat(entry, seat)),
    managerReachable: managerReachableEvidence(state, local),
    managerDeparted: manager !== null && runtime.departed(local.collabId, manager),
    autoOffers: offersForCtx(state, local.collabId),
    autoInFlight: pendingOffer !== undefined,
    pendingOfferId: pendingOffer?.offerId,
    pendingTarget: pendingOffer?.target,
    acceptedManager: maps.accepted.get(local.collabId),
    handshakeHighest: highestHandshakeOf(state, local.collabId),
    authorizedEvidence: maps.authorized.get(local.collabId),
    rejectedChangeFrom: maps.rejected.get(local.collabId),
    suspended: suspendCtxOf(state, local),
    handoverTarget: runtime.handoverTargets.get(local.collabId),
    windowBaseAt: runtime.managerWindowBaseAt.get(local.collabId),
    sessionTakeoverWindowMs: windowMsOf(state),
    windowSkewMs: 10000,
    ledgerDigestOf: (value) => ledgerDigest(value),
    from: { instanceId: frame.from.instanceId, sessionId: frame.from.sessionId },
    syncExpired: false,
  };
}

/* 成员资格取共享名单/最近快照（成员侧不读邀请阶段定格的旧 roster）。
 * 旧台账名单行可能缺 sessionId：成员资格按实例匹配（fail-closed 的兼容面）。 */
function memberSeatsOf(local) {
  return sharedRosterOf(local)
    .filter((entry) => entry.role !== 'manager')
    .map((entry) => ({ instanceId: entry.instanceId, sessionId: entry.sessionId ?? '', identityName: entry.identityName }));
}

function sharedRosterOf(local) {
  if (local.role === 'manager') {
    return local.ledger?.members ?? [];
  }
  return local.snapshot?.ledger?.members ?? local.member?.roster ?? [];
}

function managerReachableEvidence(state, local) {
  if (local.role === 'manager') {
    return undefined;   // 旧站长自身可达与否不构成受理证据（A4 的接收侧证据由第三方给出）
  }
  return managerUnreachable(state, local) !== true;
}

function offersForCtx(state, collabId) {
  const runtime = m5RuntimeOf(state);
  const offers = [...(runtime.autoOffers.get(collabId)?.values() ?? [])];
  for (const pending of [runtime.autoPending.get(collabId), runtime.managerPending.get(collabId)]) {
    if (pending !== undefined) {
      offers.push(pending);
    }
  }
  return offers;
}

function highestHandshakeOf(state, collabId) {
  /** @type {any} */
  let best = null;
  const responses = /** @type {any} */ (m5RuntimeOf(state).handshakeResponses.get(collabId));
  for (const entry of /** @type {any[]} */ ([...responses?.values() ?? []])) {
    if (best === null || compareTermStates(entry, best) > 0) {
      best = entry;
    }
  }
  return best === null ? undefined : { term: best.term, version: best.version, manager: best.manager };
}

function suspendCtxOf(state, local) {
  if (local.suspended === null) {
    return null;
  }
  return { state: local.suspended.reason, target: m5RuntimeOf(state).handoverTargets.get(local.collabId) ?? null };
}

function windowMsOf(state) {
  const value = state.config?.sessionTakeoverWindowMs;
  return Number.isFinite(value) && value > 0 ? value : 60000;
}

/* 站长变更到达（notice 事件）：唯一生效帧；旧站长以更高 term 降级，不停留在旧任期。 */
function handleManagerChanged(state, frame) {
  const local = state.collabs.get(frame.collabId);
  if (local === undefined || frame.from.instanceId === state.self.instanceId) {
    return;
  }
  const termState = termStateOf(state, local);
  if (termState === null) {
    bump(state, 'eventMismatch');
    return;
  }
  const change = { ...frame.payload, from: frame.from };
  if (adoptHandoverAsTarget(state, local, change)) {
    return;
  }
  const ctx = termCtxOf(state, local, frame);
  const bypass = oldManagerTakeoverBypass(state, local, termState, change);
  const result = bypass ?? acceptManagerChange(termState, change, ctx);
  if (result.accepted !== true && /** @type {any} */ (result).idempotent !== true) {
    termMapsOf(state).rejected.set(local.collabId, { instanceId: frame.from.instanceId, sessionId: frame.from.sessionId });
  }
  if (result.accepted === true && isPlainObject(frame.payload.endpoint)) {
    learnManagerEndpoint(state, local, result.nextState.manager, frame.payload.endpoint);
  }
  applyManagerResult(state, local, frame, result);
}

/* 旧站长仍在线时收到更高 term 的 takeover-manual：按 §2A.7⑥/§2A.8 降级采纳，
 * 不把「自己可达」当作拒收理由（那会制造两个同时写台账的站长核）。 */
function oldManagerTakeoverBypass(state, local, termState, change) {
  if (local.role !== 'manager' || change.via !== 'takeover-manual') {
    return null;
  }
  if (change.term !== termState.managerTerm + 1 || change.version <= termState.version) {
    return null;
  }
  if (!sameSeat(change.prevManager, termState.manager) || !sameSeat(change.from, change.manager)) {
    return null;
  }
  if (typeof change.authorizedAt !== 'string' || Number.isNaN(Date.parse(change.authorizedAt))) {
    return null;
  }
  if (!memberSeatsOf(local).some((seat) => sameSeat(seat, change.from))) {
    return null;
  }
  return {
    accepted: true,
    reason: 'takeover-manual-accepted',
    actions: ['adopt', 'request-snapshot', 'clear-freeze'],
    nextState: {
      managerTerm: change.term,
      manager: { instanceId: change.manager.instanceId, sessionId: change.manager.sessionId, identityName: change.manager.identityName },
      version: change.version,
    },
  };
}

function applyManagerResult(state, local, frame, result) {
  if (result.freezeReason !== undefined) {
    applyManagerFreeze(state, local.collabId, result.freezeReason);
    termMapsOf(state).rejected.set(local.collabId, { instanceId: frame.from.instanceId, sessionId: frame.from.sessionId });
    return;
  }
  if (result.accepted === true && result.nextState !== undefined) {
    applyAcceptedNextState(state, local, frame, result.nextState);
  }
  applyManagerActions(state, local, frame, result);
}

function applyManagerActions(state, local, frame, result) {
  const actions = Array.isArray(result.actions) ? result.actions : [];
  applyWindowActions(state, local, frame, actions, result);
  applyReplyActions(state, local, frame, actions);
  if (actions.includes('clear-freeze')) {
    clearManagerFreeze(state, local.collabId);
  }
  if (actions.includes('count-reject') || result.accepted !== true) {
    bump(state, 'termRejects');
  }
}

function applyWindowActions(state, local, frame, actions, result) {
  const runtime = m5RuntimeOf(state);
  if (actions.includes('open-window')) {
    const at = Date.parse(frame.payload.effectiveAt);
    runtime.managerWindowBaseAt.set(local.collabId, Number.isFinite(at) ? at : Date.now());
  }
  if (actions.includes('close-window')) {
    runtime.managerWindowBaseAt.delete(local.collabId);
  }
  if (actions.includes('request-snapshot')) {
    const target = result.accepted === true && isPlainObject(result.nextState?.manager) ? result.nextState.manager.instanceId : frame.from.instanceId;
    requestSnapshotFrom(state, local, target);
  }
}

function applyReplyActions(state, local, frame, actions) {
  if (actions.includes('ack')) {
    sendTermHandshake(state, local, frame.from.instanceId);
  }
  if (actions.includes('ack-snapshot-stored')) {
    sendSnapshotReceipt(state, local, frame);
  }
}

function applyAcceptedNextState(state, local, frame, nextState) {
  if (nextState.manager === null) {
    applyTerminalAdoption(state, local, nextState);
    return;
  }
  const runtime = m5RuntimeOf(state);
  const maps = termMapsOf(state);
  maps.accepted.set(local.collabId, {
    term: nextState.managerTerm,
    manager: { instanceId: nextState.manager.instanceId, sessionId: nextState.manager.sessionId, identityName: nextState.manager.identityName },
    source: { instanceId: frame.from.instanceId, sessionId: frame.from.sessionId },
  });
  maps.rejected.delete(local.collabId);
  maps.termState.set(local.collabId, nextState);
  runtime.managerPending.delete(local.collabId);
  runtime.managerEvidenceAt.set(local.collabId, Date.now());
  if (isPlainObject(nextState.managerWindow) && frame.payload.effectiveAt !== undefined) {
    const at = Date.parse(frame.payload.effectiveAt);
    runtime.managerWindowBaseAt.set(local.collabId, Number.isFinite(at) ? at : Date.now());
  } else {
    runtime.managerWindowBaseAt.delete(local.collabId);
  }
  if (local.role === 'manager') {
    keepReadonlySnapshot(state, local);
    downgradeToMember(state, local, { instanceId: nextState.manager.instanceId, identityName: nextState.manager.identityName }, nextState.version);
    bump(state, 'managerDowngrades');
  } else {
    applyMemberManagerRef(state, local, nextState);
  }
  clearManagerFreeze(state, local.collabId);
  notifyLocal(state, local, `站长已变更：现任站长「${nextState.manager.identityName}」（任期 ${nextState.managerTerm}）——本机已按新任期收敛。`);
}

/* 终态受理（manager:null）：只留本地只读终态，不做降级、不写 member manager 引用。 */
function applyTerminalAdoption(state, local, nextState) {
  const runtime = m5RuntimeOf(state);
  const maps = termMapsOf(state);
  /* acceptedManager 保留：本地终态后的权威台账恢复需要它作来源证据（不得在采纳终态时清掉）。 */
  maps.termState.set(local.collabId, { managerTerm: nextState.managerTerm, manager: null, version: nextState.version });
  maps.rejected.delete(local.collabId);
  runtime.managerPending.delete(local.collabId);
  runtime.managerWindowBaseAt.delete(local.collabId);
  if (local.role === 'manager') {
    keepReadonlySnapshot(state, local);
    local.ledger = null;
    local.role = 'member';
  }
  if (local.member !== null && typeof local.member === 'object') {
    local.member.state = 'completed';
    local.member.archivedAt = new Date().toISOString();
    persistMember(state, local);
  }
  clearManagerFreeze(state, local.collabId);
  bump(state, 'terminalAdoptions');
  notifyLocal(state, local, '协作已结束——本机采用本地只读终态。');
}

function applyMemberManagerRef(state, local, nextState) {
  if (local.member === null || typeof local.member !== 'object') {
    return;
  }
  local.member.manager = { instanceId: nextState.manager.instanceId, identityName: nextState.manager.identityName };
  local.member.managerSinceVersion = nextState.version;
  if (['completed', 'terminated', 'frozen', 'left'].includes(local.member.state)) {
    local.member.state = 'active';   // 权威台账覆盖本地终态/冻结（设计 §3.4）
    delete local.member.archivedAt;
  }
  persistMember(state, local);
}

function keepReadonlySnapshot(state, local) {
  if (local.ledger === null) {
    return;
  }
  local.snapshot = {
    version: local.ledger.version,
    digest: ledgerDigest(local.ledger),
    receivedAt: new Date().toISOString(),
    from: { instanceId: state.self.instanceId, identityName: state.self.identityName },
    ledger: structuredClone(local.ledger),
  };
  persistSnapshot(state, local);
}

function learnManagerEndpoint(state, local, manager, endpoint) {
  if (typeof endpoint?.address !== 'string' || typeof endpoint?.port !== 'number') {
    return;
  }
  applyEndpoint(state, local, { instanceId: manager.instanceId, identityName: manager.identityName }, endpoint.address, endpoint.port);
}

function sendTermHandshake(state, local, instanceId) {
  const endpoint = endpointFor(state, local, instanceId);
  const termState = termStateOf(state, local);
  if (endpoint === undefined || termState === null) {
    return;
  }
  const signer = presenceSignerOf(local);
  sendTo(state, local.collabId, instanceId, endpoint, 'notice', {
    event: 'handshake',
    role: local.role,
    managerTerm: termState.managerTerm,
    version: termState.version,
    manager: { instanceId: termState.manager.instanceId, sessionId: termState.manager.sessionId, identityName: termState.manager.identityName },
    takeover: null,
    reply: true,
  }, { fromSessionId: signer?.sessionId });
}

/* A10 追赶的用户裁定：只认本机已收到的匹配 auto-offer；无本地 offer 的更高任期快照一律冻结，
 * 不走「仅凭 ledger.events 自证」的路径（digest 只是校验和，成员可自造）。 */
function snapshotAutoCatchupGate(state, local, frame, termState, ctx) {
  if (ctx.localFrozen === 'manager-offline' || ctx.localFrozen === 'manager-fork') {
    return null;   // 冻结态 catch-up / 分叉收敛由任期判决按 §2A.3 处理
  }
  const ledger = frame.payload.ledger;
  if (!isPlainObject(ledger) || ledger.manager === null || ledgerTermOf(ledger) <= termState.managerTerm) {
    return null;   // 终态快照与同/低任期由 term.js 的专门分支判定
  }
  if (termState.manager === null) {
    return null;   // 本地终态后的恢复授权（acceptedManager / auto-offer / handshake）由 term.js 判定
  }
  if (snapshotSourceAuthorized(state, local, frame, termState, ctx)) {
    return null;
  }
  return {
    accepted: false,
    nextState: termState,
    actions: ['count-reject', 'freeze', 'report'],
    reason: 'snapshot-no-local-auto-offer',
    freezeReason: 'manager-fork',
  };
}

function snapshotSourceAuthorized(state, local, frame, termState, ctx) {
  const source = { instanceId: frame.from.instanceId, sessionId: frame.from.sessionId };
  const ledger = frame.payload.ledger;
  const manager = ledger.manager;
  if (sameSeat(source, termState.manager)) {
    return true;
  }
  const accepted = ctx.acceptedManager;
  if (isPlainObject(accepted) && accepted.term === ledgerTermOf(ledger) && sameSeat(accepted.manager, manager)
    && sameSeat(accepted.source, source)) {
    return true;
  }
  const handoverTarget = m5RuntimeOf(state).handoverTargets.get(local.collabId);
  if (local.suspended?.reason === 'handover-pending' && sameSeat(source, handoverTarget) && sameSeat(manager, handoverTarget)) {
    return true;
  }
  return localAutoOfferMatches(state, local, frame, termState, source, manager);
}

/* 只认本机已收到的匹配 auto-offer（2026-10-21 裁定）：快照台账 events 可自造，不作证据。 */
function localAutoOfferMatches(state, local, frame, termState, source, manager) {
  if (!sameSeat(source, manager)) {
    return false;
  }
  return offersForCtx(state, local.collabId).some((offer) => sameSeat(offer.target, manager)
    && offer.baseTerm === termState.managerTerm
    && (termState.manager === null || sameSeat(offer.prevManager, termState.manager)));
}
