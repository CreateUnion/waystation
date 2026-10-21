import { DEFAULT_COLLAB_MODE, MAX_ACTIVE_SEATS, isPort } from '../net/protocol.js';
import { LOCAL_LEFT_STATE, MAX_BOARD_ENTRIES, isSnapshotShape } from './model.js';
import { createPostsStore } from './posts.js';
import { createMembersStore } from './members.js';
import { createCounterStore, notifyIndicatorChange } from './counter.js';
import { forgetMuteBaselinesOfCollab } from './mute.js';
import { createInjectedStore } from './injected.js';
import { appendLedger, ledgerDigest } from './store.js';
import { collabDir, ensureDir } from '../paths.js';
import { archiveLocalSeatsOfState, isLocalArchivedState, localModeOf, localRosterOf, localStateOf, persistMember, persistSnapshot, rememberKnownHost, retiredMuteHandle, selfJoinedOf, upsertLocalSeat } from './local.js';
import {
  managerFreezeReasonOf, matchConflictCollabs, memberSeatAdmits, noteForumGovernanceIgnored, seatEntryMatches, seatListAdmits,
} from './gate.js';
import { applyEndpoint, applyFreezeLocally, broadcastFreeze, downgradeToMember, endpointFor, governanceTargets, memberIdsOf, mutateLedger, notifyLocal, relayGovernance, relayRedistribute, selfIsRelay, sendTo, stopJoinReplay } from './outgoing.js';
import { applyIncomingJoin, applyIncomingLeave, handleHistoryBundle, handleHistoryRequest } from './sync.js';
import {
  LEDGER_FROZEN_REASON, appendDeparted, applyManagerFreeze, clearAutoTransferState, clearFreezeReason, clearManagerFreeze,
  closeManagerCatchupWindow, handleHandshake, handleSeatPresenceFrame, handleTakeover, handleTakeoverInit, ledgerTermOf,
  m5RuntimeOf, managerCatchupWindowOpen, managerLossTimeoutMsOf, managerSeatOfLedger, managerUnreachable,
  noteDirectFramePresence, presenceSignerOf, requestSnapshotFrom, resumeLocal, runHandshake, unexpiredAutoInFlight,
} from './takeover.js';
import { handleDecision, handleMergeOutcome, handleMergeRequest, handleUnfreeze } from './freeze.js';
import { adoptHandoverAsTarget, dropHandoverInFlight, handleAutoOffer, handleHandover } from './handover.js';
import { acceptManagerChange, windowAcceptsTakeover } from './term.js';

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

/* 解除冻结/裁定执行后清除冻结原因（载体与成员记录）：冻结态已不在 → 观察窗不得继续显示。
 * 台账 status 由 legacy 冻结族维护；本函数只清展示原因，不改状态机。 */
async function handleUnfreezeEvent(state, frame) {
  if (!conflictDecisionIssuerAdmits(state, frame)) {
    return refuseGovernanceFrame(state, 'unfreezeRejected', frame, '解冻');
  }
  const result = await withSeatScopedCollabs(state, frame, () => handleUnfreeze(state, frame));
  clearStaleFreezeReasons(state);
  return result;
}

async function handleDecisionEvent(state, frame) {
  if (!conflictDecisionIssuerAdmits(state, frame)) {
    return refuseGovernanceFrame(state, 'decisionRejected', frame, '裁定');
  }
  const result = await withSeatScopedCollabs(state, frame, () => handleDecision(state, frame));
  clearStaleFreezeReasons(state);
  return result;
}

function refuseGovernanceFrame(state, counter, frame, label) {
  bump(state, counter);
  state.log.warn(`${label}帧签发者不在名单或无从匹配（拒绝并计数）`, {
    collabId: frame.collabId,
    from: frame.from?.instanceId,
    sessionId: frame.from?.sessionId,
  });
  return undefined;
}

/* 裁定/解冻的签发者（设计 §7.1）：matched 的 managed 副本必须至少有一个能确认 from 是
 * 「现任站长或已记录的对端站长」；有对端站长数据时不得接受其他在册席位冒名。
 * 未匹配/讨论实例交原处理器计数（讨论无治理面）。 */
function conflictDecisionIssuerAdmits(state, frame) {
  const payload = frame.payload;
  if (!isPlainObject(payload) || !Array.isArray(payload.members)) {
    return false;
  }
  const managed = matchConflictCollabs(state, payload.name, payload.members);
  if (managed.length === 0) {
    return true;
  }
  if (!seatListAdmits(payload.members, frame.from)) {
    return false;
  }
  return managed.some((local) => conflictIssuerKnownTo(local, frame.from.instanceId));
}

function conflictIssuerKnownTo(local, instanceId) {
  const localManager = local.role === 'manager' ? local.ledger?.manager?.instanceId : local.member?.manager?.instanceId;
  /* 只信冻结帧里站长侧声明的 manager：意向帧的 managerInstanceId 只是帧来源，不是站长身份。 */
  const rivalManager = local.conflictRival?.managerInstanceId;
  if (typeof rivalManager !== 'string' || rivalManager === '') {
    return true;   // 无对端站长数据：只能按名单校验（§12 明文信任边界的如实上限）
  }
  return instanceId === rivalManager || instanceId === localManager;
}

/* 席位键匹配修正（D13）：freeze.js 的裁定/解冻处理器仍把 members 降为实例标识匹配，
 * 同机两会话、同名但席位不相交时会误命中另一条协作。调用期间临时隐藏「仅实例命中、
 * 席位不命中」的本地副本，让原处理器只作用于席位相交的条目；结束后原样恢复。
 * 只在歧义场景（同机多会话同名协作）触发，不改变正常路径。 */
async function withSeatScopedCollabs(state, frame, run) {
  const extras = instanceOnlyMatchedCollabIds(state, frame.payload);
  if (extras.length === 0) {
    return run();
  }
  const hidden = [];
  for (const collabId of extras) {
    const local = state.collabs.get(collabId);
    if (local !== undefined) {
      state.collabs.delete(collabId);
      hidden.push([collabId, local]);
    }
  }
  try {
    return await run();
  } finally {
    for (const [collabId, local] of hidden) {
      state.collabs.set(collabId, local);
    }
  }
}

function instanceOnlyMatchedCollabIds(state, payload) {
  const bySeat = new Set(matchConflictCollabs(state, payload.name, payload.members).map((local) => local.collabId));
  const byInstance = matchConflictCollabs(state, payload.name, payload.members.map((entry) => entry.instanceId));
  return byInstance.map((local) => local.collabId).filter((collabId) => !bySeat.has(collabId));
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
  const landingFailure = inviteLandingFailureOf(state, frame);
  if (landingFailure !== null) {
    return landingFailure;
  }
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
    /* 退役 mute.json 的兼容句柄（仅供尚未迁出的清理调用点）；静音权威是席位文件。 */
    mute: retiredMuteHandle(),
    injected: createInjectedStore({ dataDir: state.dataDir, collabId: frame.collabId, log: state.log }),
    suspended: null,
    staleManagerId: null,
  };
  learnInviteSource(state, local, frame, meta);
  learnInviteEndpoints(state, local, frame);
  state.counters.invitesReceived++;
  if (member.mode !== 'forum') {
    const conflict = matchConflictCollabs(state, member.name, inviteConflictIdsOf(frame, member));
    if (conflict.length > 0) {
      freezeOnInviteConflict(state, frame, local, conflict);
      return;
    }
  }
  state.collabs.set(frame.collabId, local);
  persistMember(state, local);
}

/* 邀请落点失败（载体写不成 / 挂起簿记写不进）时中止本次落地：继续建 member.json 会污染
 * 已标记只读的目录，且这条邀请之后也无从接受（没有可核对的挂起记录）。 */
function inviteLandingFailureOf(state, frame) {
  const recorded = recordPendingInvite(state, frame);
  if (recorded === null || recorded === undefined || recorded.ok === true) {
    noteInviteLandingOutcome(state, frame, false);
    return null;
  }
  state.counters.inviteLandingAborted = (state.counters.inviteLandingAborted ?? 0) + 1;
  state.log.warn('邀请落点登记失败——中止本次邀请落地（不建本地参与记录）', {
    collabId: frame.collabId, reason: recorded.reason ?? recorded.message ?? 'unknown',
  });
  /* 标记落点失败的帧：落点失败的事实只有本机知道，帧内的 sessionDeliver 声明可能在上游
   * 路径丢失；会话注入面改读本标记，确保失败邀请不会再以「待回应的待办」出现在会话里。 */
  noteInviteLandingOutcome(state, frame, true);
  return { ok: false, reason: recorded.reason ?? 'invite-landing-failed', sessionDeliver: false };
}

/* 邀请落点结果标记（按帧标识，进程内有界）：失败 → 记入；成功 → 清除（同一帧重试成功后可注入）。 */
const FAILED_INVITE_FRAME_MAX = 256;

function noteInviteLandingOutcome(state, frame, failed) {
  const msgId = typeof frame?.msgId === 'string' ? frame.msgId : null;
  if (msgId === null || !(state.failedInviteFrames instanceof Set)) {
    return;
  }
  state.failedInviteFrames.delete(msgId);
  if (!failed) {
    return;
  }
  state.failedInviteFrames.add(msgId);
  while (state.failedInviteFrames.size > FAILED_INVITE_FRAME_MAX) {
    state.failedInviteFrames.delete(state.failedInviteFrames.values().next().value);
  }
}

/* 目标机挂起邀请登记（邀请/加入域）：未入席会话据此在注册时收到补投；forum 无邀请簿记（D18）。 */
function recordPendingInvite(state, frame) {
  if (typeof state.join?.handleInviteFrame !== 'function') {
    return null;
  }
  const result = state.join.handleInviteFrame(frame);
  if (result?.ok !== true) {
    bump(state, 'pendingInviteRejected');
    state.log.warn('挂起邀请登记失败（已忽略）', { collabId: frame.collabId, reason: result?.reason ?? result?.ignored });
  }
  return result;
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
    /* 指名会话按席位判「已加入」：同机另一会话在席时，本会话仍要收到提议面并走自己的同意门。 */
    if (selfJoinedOf(existing, state.self.instanceId, inviteTargetSessionOf(state, frame))) {
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

/* 邀请载荷里指向本机的指名会话（无指名＝null，退回实例口径）。 */
function inviteTargetSessionOf(state, frame) {
  const targets = Array.isArray(frame.payload?.targets) ? frame.payload.targets : [];
  const own = targets.find((target) => target?.instanceId === state.self.instanceId);
  return typeof own?.targetSessionId === 'string' && own.targetSessionId !== '' ? own.targetSessionId : null;
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
  return frame.payload.members.map((entry) => ({
    instanceId: entry.instanceId,
    ...(typeof entry.sessionId === 'string' ? { sessionId: entry.sessionId } : {}),
    identityName: entry.identityName,
  }));
}

/* 同名冲突的候选参与者：邀请成员 ∪ 目标机器（设计 §2.2/D13）。managed 的既有协作增邀只把发起人
 * 放进 members，被邀目标只出现在 targets——只看 members 会让被邀成员侧漏检与既有协作的参与者交集，
 * 冲突因此不冻结。两侧同去重，targets 缺失的旧帧退回成员面。 */
function inviteConflictIdsOf(frame, member) {
  /* 席位键（D13）：名单条目带 sessionId 时按 (instanceId,sessionId) 求交集，旧行才退回实例。
   * 邀请 targets 的指名会话字段是 targetSessionId（协议形态），一并转成席位键。 */
  const seats = new Map();
  const remember = (entry) => {
    if (typeof entry?.instanceId !== 'string') {
      return;
    }
    const key = `${entry.instanceId}\u0000${typeof entry.sessionId === 'string' ? entry.sessionId : ''}`;
    if (!seats.has(key)) {
      seats.set(key, { instanceId: entry.instanceId, ...(typeof entry.sessionId === 'string' ? { sessionId: entry.sessionId } : {}) });
    }
  };
  for (const entry of member.roster) {
    remember(entry);
  }
  const targets = Array.isArray(frame.payload?.targets) ? frame.payload.targets : [];
  for (const target of targets) {
    remember({ instanceId: target?.instanceId, ...(typeof target?.targetSessionId === 'string' ? { sessionId: target.targetSessionId } : {}) });
  }
  return [...seats.values()];
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
 * 避免旧那条在检出机与另一机的副本形成分叉）。广播必须覆盖两条：只播新到那条时，旧那条的
 * 其他参与者（本机名单之外）收不到冲突事实，检出机与它们会长期停在「一边冻结、一边活跃」。
 * 两条广播共用「检出涉及的本地条名单并集」：对端在任一副本上都能命中本帧，并借此学到对端
 * 副本的参与者（第三方的合并裁定据此能同时命中两侧副本）。邀请目标若不在任何本地名单里则
 * 带不到席位键——名单按席位条目校验，宁缺勿造。
 * 广播 reason 用固定短文案（协议上限 200 字符——拼接多个实例标识会越界；明细在日志字段里）。 */
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
  const participants = conflictParticipantsOf(local, conflict);
  broadcastFreeze(state, local, '同名冲突：与本机既有协作参与者有交集', participants);
  for (const other of conflict) {
    broadcastFreeze(state, other, '同名冲突：与本机既有协作参与者有交集', participants);
  }
}

function conflictParticipantsOf(local, conflict) {
  const union = new Map();
  for (const source of [local, ...conflict]) {
    for (const entry of localRosterOf(source)) {
      if (union.size >= MAX_ACTIVE_SEATS) {
        return [...union.values()];   // 协议名单上限：本条名单优先，对端多出的席位由对端自己的广播覆盖
      }
      if (typeof entry.instanceId !== 'string' || typeof entry.sessionId !== 'string' || typeof entry.identityName !== 'string') {
        continue;
      }
      const key = `${entry.instanceId}\u0000${entry.sessionId}`;
      if (!union.has(key)) {
        union.set(key, { instanceId: entry.instanceId, sessionId: entry.sessionId, identityName: entry.identityName });
      }
    }
  }
  return [...union.values()];
}

/* 同意帧携 inviteId（会话级邀请）：转加入域的批准面签发 join-grant；无 inviteId 的旧形态
 * 或讨论实例仍走本地回应记账。 */
async function handleApproveResponse(state, frame) {
  if (typeof frame.payload?.inviteId === 'string' && typeof state.join?.handleInviteApproval === 'function') {
    /* 加入域是异步面：必须等它真正给出结论再判空，否则 Promise 恒真，形态异常的帧
     * 永远不会回落到下面的记账路径。 */
    const result = await state.join.handleInviteApproval(frame);
    if (result !== null && result !== undefined) {
      return result;
    }
  }
  applyInviteResponse(state, frame, 'approved');
}

function handleDeclineResponse(state, frame) {
  /* 0.2.0 邀请拒绝帧携 inviteId：发起侧据此关闭邀请记录（不只是计数）。 */
  if (typeof frame.payload?.inviteId === 'string' && typeof state.join?.handleInviteDecline === 'function') {
    const result = state.join.handleInviteDecline(frame);
    if (result !== null && result !== undefined) {
      /* 拒绝计数只在首次真实决定时 +1（幂等重发不重复计数）。 */
      if (result.ok === true && result.idempotent !== true) {
        countResponse(state, 'declined');
      }
      return result;
    }
  }
  applyInviteResponse(state, frame, 'declined');
}

/* 站长席位侧：邀请回应只记账与提示——共享名单是 active-only 席位表，邀请在途态只存在于
 * invites/pending-invites（邀请/加入域）。入席由两段式 join-confirm 完成（运行时/加入接线），本函数
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
  return ledger.members.map((entry) => ({
    instanceId: entry.instanceId,
    ...(typeof entry.sessionId === 'string' ? { sessionId: entry.sessionId } : {}),
  }));
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
  /* 0.2.0 撤回携 inviteId：目标端清对应挂起邀请，不留下一条永远可重试的死邀请。 */
  if (typeof frame.payload?.inviteId === 'string' && typeof state.join?.withdrawPendingInvite === 'function') {
    state.join.withdrawPendingInvite({ collabId: frame.collabId, inviteId: frame.payload.inviteId });
  }
  const local = state.collabs.get(frame.collabId);
  if (local === undefined || local.role !== 'member') {
    return;
  }
  if (frame.payload.scope === 'all') {
    local.member.state = 'terminated';
    local.member.archivedAt = new Date().toISOString();
    persistMember(state, local);
    archiveLocalSeatsOfState(state, local);
    forgetMuteBaselinesOfCollab(state, local.collabId);
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

/* 投稿转达触发（中继侧）：标记命中 + 本机即中继 + 投稿人在折叠成员表内（单一取数面）才转达。
 * 投稿人是会话（设计 §2.2）：帧携 sessionId 时按席位判，同机未入席会话不得借机器身份被转达；
 * 旧帧无 sessionId 才退回实例判据。非成员不转达并计数——防任意知 collabId 者借中继把一帧
 * 放大为全员直投与会话注入（帖子本身的受理 / 落盘 / 去重照旧：全信任模型的内容面不变，
 * 只堵 1→N 的放大路径）。 */
function handleRelaySubmission(state, local, frame) {
  if (frame.payload.relay !== true || frame.from.instanceId === state.self.instanceId || !selfIsRelay(state, local)) {
    return;
  }
  if (!memberSeatAdmits(local, frame.from)) {
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
  /* 签发者校验（设计 §7.1）：同名冲突冻结由任一活跃成员席位签发——from 必须按其声明的席位键
   * 在名单内；声明了 payload.manager 时 from 必须就是该站长席位。未授权帧拒收并计数。 */
  if (!freezeIssuerAdmits(state, frame)) {
    bump(state, 'freezeRejected');
    state.log.warn('冻结帧签发者不在名单（拒绝并计数）', { collabId: frame.collabId, from: frame.from?.instanceId, sessionId: frame.from?.sessionId });
    return;
  }
  const matched = matchConflictCollabs(state, payload.name, payload.members);
  if (matched.length === 0) {
    return noteForumGovernanceIgnored(state, frame) ? { sessionDeliver: false } : undefined;
  }
  let applied = 0;
  for (const local of matched) {
    /* 帧描述的是「检出方的那条」——记录到本地其它匹配条上即对端数据（合并并集与保留方判定的输入）。 */
    if (local.collabId !== frame.collabId) {
      local.conflictRival = {
        name: payload.name,
        /* 席位键透传：合流邀请要能指名到会话（只留 instanceId 会退化成整机不指名邀请）。 */
        members: payload.members.map((entry) => ({
          instanceId: entry.instanceId,
          ...(typeof entry.sessionId === 'string' && entry.sessionId !== '' ? { sessionId: entry.sessionId } : {}),
          identityName: entry.identityName,
        })),
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
  const record = snapshotRecordOf(frame);
  if (!snapshotFrameConsistent(frame, record)) {
    bump(state, 'snapshotCorrupt');
    state.log.warn('快照载荷不合形态或与帧不自洽（已忽略）', { collabId: frame.collabId });
    return;
  }
  if (ledgerDigest(record.ledger) !== record.digest) {
    bump(state, 'snapshotCorrupt');
    state.log.warn('快照摘要不符（已忽略）', { collabId: frame.collabId, version: record.version });
    return;
  }
  const termState = termStateOf(state, local);
  if (termState === null) {
    if (adoptFirstSnapshot(state, local, frame, record)) {
      return;
    }
    bump(state, 'snapshotCorrupt');
    state.log.warn('无本地任期基线的首个快照来源不成立（已忽略）', { collabId: frame.collabId });
    return;
  }
  /* 重启降级（设计 §2A.8⑥）：旧站长按 handshake 学到的更高任期向新站长取快照。握手只作
   * 候选比较与请求依据（2026-10-21 裁定「handshakeHighest 不构成授权」）：证据由 ctx 传入
   * 任期判决按旧站长重启面单独校验，绝不在判决前写 acceptedManager。 */
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

function snapshotFrameConsistent(frame, record) {
  return isSnapshotShape(record) && record.version === record.ledger.version
    && record.ledger.collabId === frame.collabId;
}

/* 首份快照基线（设计 §4.4④/§13.1 邀请 e2e）：受邀/两段式入席的成员没有本地台账，termStateOf
 * 返回 null。此时只接受来源＝本地邀请/批准记录中的站长、且台账含本席位的自洽快照，按新基线采纳；
 * 其余来源仍 fail-closed（不得凭「第一份」绕过来源校验）。 */
function adoptFirstSnapshot(state, local, frame, record) {
  const nextState = firstSnapshotBaselineOf(state, local, frame, record);
  if (nextState === null) {
    return false;
  }
  local.snapshot = record;
  persistSnapshot(state, local);
  termMapsOf(state).termState.set(local.collabId, nextState);
  applyMemberManagerRef(state, local, nextState, record.ledger);
  clearUnverifiedSeats(state, local, record.ledger);
  bump(state, 'snapshotBaselineAdopted');
  bump(state, 'snapshotStored');
  sendSnapshotReceipt(state, local, frame);
  resolvePendingView(state, local.collabId, local.snapshot);
  return true;
}

function firstSnapshotBaselineOf(state, local, frame, record) {
  if (local.role === 'manager' || local.snapshot !== null) {
    return null;
  }
  const source = { instanceId: frame.from?.instanceId, sessionId: frame.from?.sessionId };
  if (!firstSnapshotSourceAllowed(local, source, record.ledger.manager)) {
    return null;
  }
  if (!ownSeatListed(local, record.ledger, state)) {
    return null;
  }
  return termStateOfLedger(record.ledger);
}

/* 来源＝邀请/批准记录中的站长（member.manager），且必须是快照台账里的 manager。 */
function firstSnapshotSourceAllowed(local, source, manager) {
  const known = local.member?.manager;
  if (!isPlainObject(known) || !isPlainObject(manager)) {
    return false;
  }
  if (typeof source.instanceId !== 'string' || typeof source.sessionId !== 'string') {
    return false;
  }
  if (source.instanceId !== known.instanceId || !sameSeat(source, manager)) {
    return false;
  }
  return typeof known.sessionId !== 'string' || known.sessionId === '' || known.sessionId === source.sessionId;
}

function termStateOfLedger(ledger) {
  const manager = ledger.manager;
  return {
    managerTerm: ledgerTermOf(ledger),
    manager: {
      instanceId: manager.instanceId,
      sessionId: manager.sessionId,
      identityName: typeof manager.identityName === 'string' && manager.identityName !== '' ? manager.identityName : manager.instanceId,
    },
    version: ledger.version,
    ...(isPlainObject(ledger.managerWindow) ? { managerWindow: { ...ledger.managerWindow } } : {}),
  };
}

function ownSeatListed(local, ledger, state) {
  const members = Array.isArray(ledger?.members) ? ledger.members : [];
  for (const seat of local.seats?.values?.() ?? []) {
    if (isSelfSeatIn(members, state.self.instanceId, seat.sessionId)) {
      return true;
    }
  }
  return false;
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
  rememberSnapshotRoster(state, local, record.ledger);
  clearUnverifiedSeats(state, local, record.ledger);
  bump(state, 'snapshotStored');
  const runtime = m5RuntimeOf(state);
  const override = runtime.termState?.get(local.collabId);
  if (override !== undefined && override.managerTerm <= ledgerTermOf(record.ledger)) {
    runtime.termState.delete(local.collabId);
  }
}

/* 成员侧名单随权威快照刷新：member.roster 原先只在邀请时定格，而 0.2.0 的 managed 邀请 members
 * 只含发起人——入席后不刷新会让同名冲突匹配看不到本机与后来成员，冲突永远检不出。名单权威是
 * 共享台账，roster 只是成员机的本地视图；讨论不入此路径（成员关系按事件折叠）。 */
function rememberSnapshotRoster(state, local, ledger) {
  if (local.role === 'manager' || localModeOf(local) === 'forum') {
    return;
  }
  const members = Array.isArray(ledger?.members) ? ledger.members : [];
  if (members.length === 0) {
    return;
  }
  local.member.roster = members.map((entry) => ({
    instanceId: entry.instanceId,
    ...(typeof entry.sessionId === 'string' ? { sessionId: entry.sessionId } : {}),
    identityName: entry.identityName,
  }));
  persistMember(state, local);
}

/* 快照含本席 → 回填 joinSeq/joinedAt 并清除 unverified（两段式入席的收敛面，设计 §4.4⑤）：
 * 自此可发消息。名单行缺序号/时刻时保持 unverified（不得写出形态非法的 verified 席位）。 */
function clearUnverifiedSeats(state, local, ledger) {
  const members = Array.isArray(ledger?.members) ? ledger.members : [];
  for (const seat of local.seats?.values?.() ?? []) {
    if (seat.unverified === true) {
      clearUnverifiedSeatOf(state, local, members, seat);
    }
  }
}

function clearUnverifiedSeatOf(state, local, members, seat) {
  const row = selfSeatRowOf(members, state.self.instanceId, seat.sessionId);
  if (row === null) {
    return;
  }
  const joinSeq = Number.isInteger(seat.joinSeq) ? seat.joinSeq : row.joinSeq;
  const joinedAt = typeof seat.joinedAt === 'string' ? seat.joinedAt : row.joinedAt;
  if (!Number.isInteger(joinSeq) || typeof joinedAt !== 'string') {
    bump(state, 'unverifiedBackfillMissing');
    return;
  }
  upsertLocalSeat(local, { ...seat, joinSeq, joinedAt, unverified: false }, { persist: true, dataDir: state.dataDir });
  bump(state, 'unverifiedCleared');
}

function selfSeatRowOf(members, instanceId, sessionId) {
  return members.find((member) => member.instanceId === instanceId
    && (member.sessionId === undefined || member.sessionId === sessionId)) ?? null;
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
  /* 请求来源校验（设计 §7.1）：名单/peerView 内的席位，或本机台账 leave 事件中的旧站长。
   * 不校验等于任意知道 collabId 的主机都能拉走完整台账（并可用来伪造治理帧名单）。 */
  if (!snapshotRequesterAdmits(local, frame)) {
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

/* 快照请求来源：共享名单/peerView 内的席位，或本机台账 leave/名单移除事件中
 * manager-lost/manager-session-closed 的旧站长（回归追赶，设计 §7.1）。 */
function snapshotRequesterAdmits(local, frame) {
  const from = frame.from;
  if (!isPlainObject(from) || typeof from.instanceId !== 'string' || from.instanceId === '') {
    return false;
  }
  const ledger = local.role === 'manager' ? local.ledger : local.snapshot?.ledger;
  const members = Array.isArray(ledger?.members) ? ledger.members : [];
  if (seatListAdmits(members.length > 0 ? members : localRosterOf(local), from)) {
    return true;
  }
  return departedManagerSeatOf(ledger, from);
}

/* 台账 leave/名单移除事件中的旧站长（manager-lost/manager-session-closed）：回归追赶来源。 */
function departedManagerSeatOf(ledger, from) {
  const events = Array.isArray(ledger?.events) ? ledger.events : [];
  return events.some((event) => isDepartedManagerEventOf(event, from));
}

function isDepartedManagerEventOf(event, from) {
  const managerLost = event?.reason === 'manager-lost' || event?.reason === 'manager-session-closed';
  return event?.type === 'leave' && managerLost && seatEntryMatches(event.seat, from);
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
  /* 签发者校验（设计 §7.1）：managed 只认现任站长席位；forum 只认发起人（中继）。
   * 知道 collabId 的任意主机不得归档本机协作。 */
  if (!endIssuerAdmits(state, local, frame)) {
    bump(state, 'endRejected');
    state.log.warn('结束通告签发者不是现任站长/发起人（拒绝并计数）', { collabId: local.collabId, from: frame.from?.instanceId, sessionId: frame.from?.sessionId });
    return;
  }
  local.member.state = 'completed';
  local.member.archivedAt = new Date().toISOString();
  persistMember(state, local);
  archiveLocalSeatsOfState(state, local);
  forgetMuteBaselinesOfCollab(state, local.collabId);
  stopJoinReplay(state, local);
  state.counters.endedIn++;
}

/* 结束通告的签发者（设计 §7.1）：managed＝现任站长席位；forum＝发起人（邀请者/中继）。
 * 缺站长引用或来源不符一律拒绝（知道 collabId 不等于有权归档）。 */
function endIssuerAdmits(state, local, frame) {
  if (localModeOf(local) === 'forum') {
    return forumEndIssuerAdmits(local, frame.from);
  }
  const manager = managerSeatOfLedger(state, local);
  return manager !== null && seatEntryMatches(manager, frame.from);
}

function forumEndIssuerAdmits(local, from) {
  const initiator = local.member?.originator?.instanceId ?? local.member?.manager?.instanceId ?? null;
  return typeof initiator === 'string' && from?.instanceId === initiator;
}

/* 冻结帧签发者：from 必须按其席位键在声明的成员名单内；声明 manager 时必须与 from 一致。 */
function freezeIssuerAdmits(state, frame) {
  const payload = frame.payload;
  if (!isPlainObject(payload) || !Array.isArray(payload.members) || !seatListAdmits(payload.members, frame.from)) {
    return false;
  }
  if (isPlainObject(payload.manager) && payload.manager.instanceId !== frame.from?.instanceId) {
    return false;
  }
  return true;
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
  releaseJoiningOf(state, local.collabId, row.sessionId);
  broadcastRosterNotice(state, local);
}

/* 席位移除的生命周期收尾：未确认的两段式记录不得跨离席残留。 */
function releaseJoiningOf(state, collabId, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    return;
  }
  try {
    state.join?.releaseJoining?.(collabId, sessionId);
  } catch (error) {
    bump(state, 'eventFailures');
    state.log.warn('未确认入席记录释放失败（已隔离）', { collabId, sessionId, reason: error?.message });
  }
}

/* —— 任期接线（设计 §2A.2 受理表）：term.js 只做判决，本层组 ctx、落台账与执行 actions。 —— */

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bump(state, key) {
  state.counters[key] = (state.counters[key] ?? 0) + 1;
}

/* 时钟域（设计 §2A/D3）：任期窗口按墙钟；presence/失联证据按单调钟。两者不得共用同一变量。 */
function wallNow(state) {
  return typeof state.clock === 'function' ? state.clock() : Date.now();
}

function monoNow(state) {
  return typeof state.monoClock === 'function' ? state.monoClock() : performance.now();
}

function sameSeat(left, right) {
  return isPlainObject(left) && isPlainObject(right)
    && left.instanceId === right.instanceId
    && left.sessionId === right.sessionId;
}

function termMapsOf(state) {
  const runtime = m5RuntimeOf(state);
  for (const name of ['termState', 'acceptedManagerMap', 'authorizedEvidenceMap']) {
    if (!(runtime[name] instanceof Map)) {
      runtime[name] = new Map();
    }
  }
  return {
    termState: runtime.termState,
    accepted: runtime.acceptedManagerMap,
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
  const manager = managerSeatOfLedger(state, local);
  return {
    now: wallNow(state),
    localFrozen: runtime.frozen.get(local.collabId) ?? null,
    memberSeats: memberSeatsOf(local),
    isMemberSeat: (seat) => memberSeatsOf(local).some((entry) => sameSeat(entry, seat)),
    managerReachable: managerReachableEvidence(state, local),
    managerDeparted: manager !== null && runtime.departed(local.collabId, manager),
    ...termEvidenceCtxOf(state, local, frame),
    suspended: suspendCtxOf(state, local),
    handoverTarget: runtime.handoverTargets.get(local.collabId),
    handoverBaseTerm: runtime.pendingHandovers.get(local.collabId)?.baseTerm,
    windowBaseAt: runtime.managerWindowBaseAt.get(local.collabId),
    sessionTakeoverWindowMs: windowMsOf(state),
    windowSkewMs: 10000,
    ledgerDigestOf: (value) => ledgerDigest(value),
    from: { instanceId: frame.from.instanceId, sessionId: frame.from.sessionId },
    syncExpired: runtime.syncExpired?.has(local.collabId) === true,
  };
}

/* 受理证据面（任期判决的输入）：auto-offer、acceptedManager、catchup 选择、握手与 fork 证据。
 * 单独成形以保持 termCtxOf 的可读性；缺证据一律由 term.js fail-closed。 */
function termEvidenceCtxOf(state, local, frame) {
  const runtime = m5RuntimeOf(state);
  const maps = termMapsOf(state);
  const pendingOffer = runtime.managerPending.get(local.collabId) ?? runtime.autoPending.get(local.collabId);
  return {
    autoOffers: offersForCtx(state, local.collabId),
    autoInFlight: pendingOffer !== undefined,
    pendingOfferId: pendingOffer?.offerId,
    pendingTarget: pendingOffer?.target,
    acceptedManager: maps.accepted.get(local.collabId) ?? runtime.acceptedManagers.get(local.collabId),
    catchupSource: runtime.catchupSources?.get?.(local.collabId),
    handshakeHighest: highestHandshakeOf(state, local.collabId),
    /* 旧站长重启追赶证据（§2A.8⑥）：只对本机仍是站长、快照来源是旧名单成员且其握手应答
     * 与快照一致时才成立；仅供任期判决，不落盘、不构成通用授权。 */
    handshakeCatchup: handshakeCatchupEvidenceOf(state, local, frame, termStateOf(state, local)),
    authorizedEvidence: maps.authorized.get(local.collabId),
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
  /* 转达目标取采纳前的名册：采纳会降级/改写本地名单（设计 §2A.8④）。 */
  const relayTargets = new Map(governanceTargets(state, local));
  if (adoptHandoverAsTarget(state, local, change)) {
    relayManagerChange(state, frame, relayTargets);
    return;
  }
  const ctx = termCtxOf(state, local, frame);
  const bypass = oldManagerTakeoverBypass(state, local, termState, change);
  const result = bypass ?? acceptManagerChange(termState, change, ctx);
  if (result.accepted === true && isPlainObject(frame.payload.endpoint)) {
    learnManagerEndpoint(state, local, result.nextState.manager, frame.payload.endpoint);
  }
  applyManagerResult(state, local, frame, result);
  /* 已受理的站长变更由接收核继续转发（D15）：旧站长降级后仍要把变更送到其余成员；
   * 未受理/拒收的帧不扩散。 */
  if (result.accepted === true) {
    relayManagerChange(state, frame, relayTargets);
  }
}

function relayManagerChange(state, frame, targets) {
  state.counters.managerChangeRelayed = (state.counters.managerChangeRelayed ?? 0) + relayGovernance(state, frame, targets);
}

/* 旧站长仍在线时收到更高 term 的 takeover-manual：按 §2A.7⑥/§2A.8 降级采纳，
 * 不把「自己可达」当作拒收理由（那会制造两个同时写台账的站长核）。 */
function oldManagerTakeoverBypass(state, local, termState, change) {
  if (!oldManagerBypassEligible(state, local, termState, change)) {
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

function oldManagerBypassEligible(state, local, termState, change) {
  if (local.role !== 'manager' || change.via !== 'takeover-manual') {
    return false;
  }
  /* pending/fork 只读等待期间不得被第三方 takeover-manual 解除；未过期 auto 在途同理。 */
  if (m5RuntimeOf(state).frozen.has(local.collabId) || unexpiredAutoInFlight(state, local)) {
    return false;
  }
  if (change.term !== termState.managerTerm + 1 || change.version <= termState.version) {
    return false;
  }
  if (!sameSeat(change.prevManager, termState.manager) || !sameSeat(change.from, change.manager)) {
    return false;
  }
  if (!isAuthorizedTimestamp(change.authorizedAt)) {
    return false;
  }
  return memberSeatsOf(local).some((seat) => sameSeat(seat, change.from));
}

function isAuthorizedTimestamp(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function applyManagerResult(state, local, frame, result) {
  noteAuthorizedEvidence(state, local, frame, result);
  if (result.freezeReason !== undefined) {
    applyManagerFreeze(state, local.collabId, result.freezeReason);
    return;
  }
  if (result.accepted === true && result.nextState !== undefined) {
    applyAcceptedNextState(state, local, frame, result.nextState);
  }
  applyManagerActions(state, local, frame, result);
}

/* fork 收敛证据（设计 §2A.3/§2A.10）：被拒/待同步的窗口内 takeover 授权可绑定到后续快照。
 * 只有「除本地分叉/任期跳跃外其余 A3/A4 要件均成立」的帧才算证据：成员来源且来源＝新站长、
 * term=本地+1、version 更新、prevManager 匹配、窗口或站长不可达证据有效；证据绑定签发席位，
 * 快照必须由该席位送达。被窗口/来源/任期前提拒绝的帧一律不产生证据（不得洗白）。 */
function noteAuthorizedEvidence(state, local, frame, result) {
  if (result.accepted === true || /** @type {any} */ (result).idempotent === true || result.freezeReason !== undefined) {
    return;
  }
  const evidence = authorizedEvidenceOf(state, local, frame);
  if (evidence === null) {
    return;
  }
  termMapsOf(state).authorized.set(local.collabId, evidence);
  bump(state, 'authorizedEvidenceRecorded');
}

function authorizedEvidenceOf(state, local, frame) {
  const change = frame.payload;
  const source = evidenceSourceOf(change, frame);
  if (source === null || !evidenceShapeOk(change)) {
    return null;
  }
  const current = evidenceCurrentOf(state, local, change);
  if (current === null || !memberSeatsOf(local).some((seat) => sameSeat(seat, source))) {
    return null;   // 来源必须是名单内活跃成员席位
  }
  if (!evidencePrerequisites(state, local, change, current)) {
    return null;
  }
  return {
    via: change.via,
    authorizedAt: change.authorizedAt,
    term: change.term,
    manager: { instanceId: change.manager.instanceId, sessionId: change.manager.sessionId, identityName: change.manager.identityName },
    source: { instanceId: source.instanceId, sessionId: source.sessionId },
  };
}

/* 证据签发者：A3/A4 均由新站长本人签发（from 席位＝manager 席位）。 */
function evidenceSourceOf(change, frame) {
  if (!isPlainObject(change) || !['takeover', 'takeover-manual'].includes(change.via)) {
    return null;
  }
  const source = { instanceId: frame.from?.instanceId, sessionId: frame.from?.sessionId };
  if (!isSeatRef(source) || !isSeatRef(change.manager) || !sameSeat(source, change.manager)) {
    return null;
  }
  return source;
}

function evidenceShapeOk(change) {
  return isAuthorizedTimestamp(change.authorizedAt)
    && Number.isInteger(change.term)
    && Number.isFinite(change.version);
}

/* 分叉收敛允许任期跳跃（胜者可能已推进多个任期）；同 term/落后/版本不新/prevManager 不符都不产生证据。 */
function evidenceCurrentOf(state, local, change) {
  const current = termStateOf(state, local);
  if (current === null || current.manager === null || !sameSeat(change.prevManager, current.manager)) {
    return null;
  }
  if (!(change.term > current.managerTerm) || !(change.version > current.version)) {
    return null;
  }
  return current;
}

function isSeatRef(value) {
  return isPlainObject(value)
    && typeof value.instanceId === 'string' && value.instanceId !== ''
    && typeof value.sessionId === 'string' && value.sessionId !== '';
}

/* 证据前提：takeover 的本地同步帧要求窗口基准与授权时点均有效（窗口已关不得洗白）；
 * 任期跳跃帧无法用本地窗口复核，按「授权与传播分离」只认 authorizedAt；takeover-manual 要求站长不可达。 */
function evidencePrerequisites(state, local, change, current) {
  if (change.via === 'takeover') {
    if (change.term !== current.managerTerm + 1) {
      return true;
    }
    if (change.windowBaseTerm !== current.managerTerm) {
      return false;
    }
    if (!isPlainObject(current.managerWindow) || current.managerWindow.windowBaseTerm !== current.managerTerm) {
      return false;
    }
    return windowAcceptsTakeover(current.managerWindow, change.authorizedAt, {
      now: wallNow(state),
      windowMs: windowMsOf(state),
      windowBaseAt: m5RuntimeOf(state).managerWindowBaseAt.get(local.collabId),
    });
  }
  return managerUnreachable(state, local) === true;
}

function applyManagerActions(state, local, frame, result) {
  const actions = Array.isArray(result.actions) ? result.actions : [];
  applyWindowActions(state, local, frame, actions, result);
  applyReplyActions(state, local, frame, actions);
  if (actions.includes('handshake')) {
    runHandshake(state, { collabId: local.collabId });
    armSyncWatch(state, local.collabId);
  }
  if (actions.includes('clear-freeze')) {
    clearManagerFreeze(state, local.collabId);
  }
  if (actions.includes('count-reject') || result.accepted !== true) {
    bump(state, 'termRejects');
  }
}

/* A6 对表超时（设计 §2A.2 A6）：term 跳跃只做有界同步，超时按 manager-fork 冻结上报。 */
function armSyncWatch(state, collabId) {
  const runtime = m5RuntimeOf(state);
  if (!(runtime.syncWatch instanceof Map)) {
    runtime.syncWatch = new Map();
  }
  if (!(runtime.syncExpired instanceof Set)) {
    runtime.syncExpired = new Set();
  }
  const prior = runtime.syncWatch.get(collabId);
  if (prior !== undefined) {
    clearTimeout(prior);
  }
  runtime.syncExpired.delete(collabId);
  const timer = setTimeout(() => {
    runtime.syncWatch.delete(collabId);
    runtime.syncExpired.add(collabId);
    bump(state, 'termSyncTimeouts');
    applyManagerFreeze(state, collabId, 'manager-fork');
  }, managerLossTimeoutMsOf(state));
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  runtime.syncWatch.set(collabId, timer);
}

function clearSyncWatch(state, collabId) {
  const runtime = m5RuntimeOf(state);
  const timer = runtime.syncWatch?.get?.(collabId);
  if (timer !== undefined) {
    clearTimeout(timer);
    runtime.syncWatch.delete(collabId);
  }
  runtime.syncExpired?.delete?.(collabId);
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
  maps.termState.set(local.collabId, nextState);
  maps.authorized.delete(local.collabId);
  runtime.managerPending.delete(local.collabId);
  runtime.catchupSources?.delete?.(local.collabId);
  runtime.managerEvidenceAt.set(local.collabId, monoNow(state));
  clearAutoTransferState(state, local.collabId);
  dropHandoverInFlight(state, local.collabId);
  clearSyncWatch(state, local.collabId);
  applyNextStateWindow(state, local, frame, nextState);
  /* 首次成功收敛即关闭启动追赶窗口（设计 §2A.2）：窗口只服务旧站长重启后的那一次追赶。 */
  closeManagerCatchupWindow(state, local.collabId);
  if (local.role === 'manager') {
    const readonlyLedger = local.ledger === null ? null : structuredClone(local.ledger);
    keepReadonlySnapshot(state, local);
    downgradeToMember(state, local, { instanceId: nextState.manager.instanceId, identityName: nextState.manager.identityName }, nextState.version);
    writeReadonlyLedgerCopy(state, local, readonlyLedger);
    bump(state, 'managerDowngrades');
  } else {
    applyMemberManagerRef(state, local, nextState, frame.payload?.ledger);
  }
  /* 只清站长任期冻结（manager-offline/pending/fork）：同名冲突冻结不因快照采纳而解除，
   * 否则权威快照（哪怕是冻结态台账）一到就把侦测侧的冲突冻结静默翻回 active（设计 §2A.3）。 */
  if (managerFreezeReasonOf(state, local.collabId) !== null) {
    clearManagerFreeze(state, local.collabId);
  }
  notifyLocal(state, local, `站长已变更：现任站长「${nextState.manager.identityName}」（任期 ${nextState.managerTerm}）——本机已按新任期收敛。`);
}

/* 终态受理（manager:null）：只留本地只读终态，不做降级、不写 member manager 引用。 */
function applyTerminalAdoption(state, local, nextState) {
  const runtime = m5RuntimeOf(state);
  const maps = termMapsOf(state);
  /* acceptedManager 保留：本地终态后的权威台账恢复需要它作来源证据（不得在采纳终态时清掉）。 */
  maps.termState.set(local.collabId, { managerTerm: nextState.managerTerm, manager: null, version: nextState.version });
  runtime.managerPending.delete(local.collabId);
  runtime.catchupSources?.delete?.(local.collabId);
  runtime.managerWindowBaseAt.delete(local.collabId);
  clearAutoTransferState(state, local.collabId);
  dropHandoverInFlight(state, local.collabId);
  clearSyncWatch(state, local.collabId);
  if (local.role === 'manager') {
    keepReadonlySnapshot(state, local);
    /* 席位缓存必须先降级：重启按席位派生 role，残留 manager 席位会让 recoverLedger 复活旧活跃台账。 */
    demoteLocalSeatsOf(state, local);
    local.ledger = null;
    local.role = 'member';
  }
  if (local.member !== null && typeof local.member === 'object') {
    local.member.state = 'completed';
    local.member.archivedAt = new Date().toISOString();
    persistMember(state, local);
  }
  /* 与 handleEnd/terminateLocalCopy 同口径：归档本机席位（退出注入与静音聚合）、清静音基线、
   * 停 join 重播——终态快照是本机正常终态路径之一，不得只改 member.state 而留下活跃席位。 */
  archiveLocalSeatsOfState(state, local);
  forgetMuteBaselinesOfCollab(state, local.collabId);
  stopJoinReplay(state, local);
  clearManagerFreeze(state, local.collabId);
  bump(state, 'terminalAdoptions');
  notifyLocal(state, local, '协作已结束——本机采用本地只读终态。');
}

/* 采纳新任期时的窗口基准：携窗口且事件有 effectiveAt 才按事件时刻开窗，否则清除。 */
function applyNextStateWindow(state, local, frame, nextState) {
  const runtime = m5RuntimeOf(state);
  const at = Date.parse(frame.payload.effectiveAt);
  if (isPlainObject(nextState.managerWindow) && frame.payload.effectiveAt !== undefined) {
    runtime.managerWindowBaseAt.set(local.collabId, Number.isFinite(at) ? at : Date.now());
    return;
  }
  runtime.managerWindowBaseAt.delete(local.collabId);
}

/** @param {{ status?: string } | undefined} [ledger] 权威快照台账（站长变更帧未携时缺省） */
function applyMemberManagerRef(state, local, nextState, ledger = undefined) {
  if (local.member === null || typeof local.member !== 'object') {
    return;
  }
  backfillMemberBasicsOf(local.member, ledger);
  local.member.manager = { instanceId: nextState.manager.instanceId, identityName: nextState.manager.identityName };
  local.member.managerSinceVersion = nextState.version;
  /* 同名冲突冻结与任期冻结分开判：冲突冻结只由裁定/解冻解除，manager-changed 或 active 快照
   * 都不得把它翻回 active（设计 §2A.3「不因单一变更自动解除」）。 */
  if (conflictFrozenMemberOf(state, local)) {
    persistMember(state, local);
    return;
  }
  if (local.member.state === 'active' && ledger?.status === 'frozen') {
    /* 权威台账已冻结（同名冲突在站长侧检出）：在线成员按台账收敛为 frozen，避免继续写入被拒。 */
    markMemberFrozenByLedger(local);
    persistMember(state, local);
    return;
  }
  reviveTerminalMemberStateOf(local, ledger);
  persistMember(state, local);
}

/* 权威台账覆盖本地终态/冻结（设计 §3.4）：台账仍冻结则保持 frozen，否则回 active。
 * 由台账传播的冻结只认明确的 authoritative active 台账解除（manager-changed 可能不携台账，
 * 不能当作解冻依据）；恢复时清掉专用标记与冻结标记，否则下次判据会误认成同名冲突冻结（设计 §2A.2 C4）。 */
function reviveTerminalMemberStateOf(local, ledger) {
  if (!['completed', 'terminated', 'frozen', 'left'].includes(local.member.state)) {
    return;
  }
  const ledgerFrozen = local.member.freezeReason === LEDGER_FROZEN_REASON;
  if (ledger?.status === 'frozen') {
    if (local.member.state !== 'frozen') {
      markMemberFrozenByLedger(local);
    }
    return;
  }
  if (ledgerFrozen && ledger?.status !== 'active') {
    return;
  }
  local.member.state = 'active';
  delete local.member.archivedAt;
  if (ledgerFrozen) {
    delete local.member.freezeReason;
    delete local.member.frozenAt;
    delete local.member.frozenFrom;
  }
}

/* 本机同名冲突冻结（非任期三态）：运行时冻结表是任期冻结的权威；无任期冻结而成员已 frozen，
 * 持久化原因也不是三态或台账传播标记，即冲突冻结（含旧版共享冻结）。
 * 台账传播的冻结不在此列：它必须能由 authoritative active 台账反向恢复（设计 §2A.2 C4）。 */
function conflictFrozenMemberOf(state, local) {
  if (local.member?.state !== 'frozen' || m5RuntimeOf(state).frozen.has(local.collabId)) {
    return false;
  }
  const reason = local.member.freezeReason ?? local.freezeReason;
  if (reason === LEDGER_FROZEN_REASON) {
    return false;
  }
  return !['manager-offline', 'manager-pending', 'manager-fork'].includes(reason);
}

function markMemberFrozenByLedger(local) {
  if (local.member.state === 'frozen') {
    return;
  }
  /* frozenFrom 只允许 proposed/active（成员记录形态）；终态被台账冻结时按 active 记。 */
  local.member.frozenFrom = local.member.state === 'proposed' ? 'proposed' : 'active';
  local.member.frozenAt = new Date().toISOString();
  local.member.freezeReason = LEDGER_FROZEN_REASON;
  local.member.state = 'frozen';
  delete local.member.archivedAt;
}

/* 采纳快照即按台账回填成员记录（设计 §3.1/§4.4④）：冷启动且邀请记录不全时，本地名/题与
 * 「尚未回应」态会一直停在 collabId/proposed；名单已收到的快照就是参与成立的权威面。 */
function backfillMemberBasicsOf(member, ledger) {
  if (!isPlainObject(ledger)) {
    return;
  }
  if (typeof ledger.name === 'string' && ledger.name !== '') {
    member.name = ledger.name;
  }
  if (typeof ledger.topic === 'string') {
    member.topic = ledger.topic;
  }
  if (member.state === 'proposed' && ledger.status === 'active') {
    member.state = 'active';
    delete member.archivedAt;
  }
}

/* 降级后保留只读台账副本（设计 §2A.8③）：目录若无台账会被判 carrier-without-ledger/recovery 只读，
 * 旧站长从此接不到入站帧、也交不回席位。降级核不再写权威台账（以快照为准），此行仅是本地副本。 */
function writeReadonlyLedgerCopy(state, local, ledger) {
  if (!isPlainObject(ledger)) {
    return;
  }
  try {
    ensureDir(collabDir(state.dataDir, local.collabId));
    appendLedger(state.dataDir, { ...ledger, collabId: local.collabId });
    bump(state, 'readonlyLedgerKept');
  } catch (error) {
    bump(state, 'readonlyLedgerFailures');
    state.log.warn('降级后只读台账副本写入失败（已忽略）', { collabId: local.collabId, reason: error.message });
  }
}

function demoteLocalSeatsOf(state, local) {
  for (const seat of local.seats?.values?.() ?? []) {
    if (seat.role !== 'member') {
      upsertLocalSeat(local, { sessionId: seat.sessionId, role: 'member' }, { persist: true, dataDir: state.dataDir });
    }
  }
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
  if (acceptedManagerAuthorizes(ctx.acceptedManager, ledger, source)) {
    return true;
  }
  const handoverTarget = m5RuntimeOf(state).handoverTargets.get(local.collabId);
  if (local.suspended?.reason === 'handover-pending' && sameSeat(source, handoverTarget) && sameSeat(manager, handoverTarget)) {
    return true;
  }
  if (handshakeCatchupAuthorizes(ctx, ledger, source)) {
    return true;
  }
  return localAutoOfferMatches(state, local, frame, termState, source, manager);
}

function acceptedManagerAuthorizes(accepted, ledger, source) {
  return isPlainObject(accepted)
    && accepted.term === ledgerTermOf(ledger)
    && sameSeat(accepted.manager, ledger.manager)
    && sameSeat(accepted.manager, source);
}

/* 握手学到的站长证据（设计 §2A.8⑥）：快照来源机器本人直接应答过 handshake，且应答报告的
 * term/manager 与快照一致、报告端点与本地已知端点一致。任一不满足即不授权——不得放宽成
 * 「任意成员报告的最高 pair」授权。 */
function handshakeManagerEvidenceOf(state, local, frame, ledger) {
  const manager = ledger.manager;
  if (!isPlainObject(manager) || typeof manager.instanceId !== 'string' || frame.from.instanceId !== manager.instanceId) {
    return false;
  }
  const response = m5RuntimeOf(state).handshakeResponses.get(local.collabId)?.get(manager.instanceId);
  if (response === undefined) {
    return false;
  }
  if (response.term !== ledgerTermOf(ledger) || !sameSeat(response.manager, manager)) {
    return false;
  }
  return reportedManagerEndpointOk(state, local, manager, response.endpoint);
}

/* 旧站长重启追赶（§2A.8⑥，2026-10-21 裁定；2026-10-22 收紧）：握手证据只能服务
 * 「本机仍是旧站长、来源是旧名单成员、本机台账 manager 仍是自己」的启动追赶——成员/冻结态/
 * 本地终态一律不得经握手证据转正。证据只在启动追赶窗口内、且快照来源是本轮应答中最高
 * (term,version) 持有者时成立；证据内容仍须与快照完全一致，且不写入 acceptedManager
 * （判决前落记录等于授予通用授权）。 */
function handshakeCatchupEvidenceOf(state, local, frame, termState) {
  const ledger = frame.payload?.ledger;
  if (local.role !== 'manager' || termState === null || !isPlainObject(ledger)) {
    return undefined;
  }
  if (ledger.manager === null || ledgerTermOf(ledger) <= termState.managerTerm) {
    return undefined;
  }
  if (!handshakeRoundAuthorizesCatchup(state, local, frame, ledger)) {
    return undefined;   // 窗口外或非最高 pair：不得据此降级在位站长
  }
  if (!rosterHadSeat(localRosterOf(local), ledger.manager)) {
    return undefined;   // 来源必须在旧名单（现场成员），名单外主机不构成回归证据
  }
  return {
    term: ledgerTermOf(ledger),
    manager: { instanceId: ledger.manager.instanceId, sessionId: ledger.manager.sessionId, identityName: ledger.manager.identityName },
    source: { instanceId: frame.from.instanceId, sessionId: frame.from.sessionId },
  };
}

/* 启动追赶窗口 + 来源本人直连应答一致 + 来源是本轮最高 (term,version) 持有者（设计 §2A.2）。 */
function handshakeRoundAuthorizesCatchup(state, local, frame, ledger) {
  return managerCatchupWindowOpen(state, local.collabId)
    && handshakeManagerEvidenceOf(state, local, frame, ledger)
    && handshakeSourceIsHighestPair(state, local, ledger.manager);
}

/* 本轮握手应答中的最高 pair（设计 §2A.2）：来源应答必须等于最高 (term,version)；任一旁证更高即不授权。 */
function handshakeSourceIsHighestPair(state, local, manager) {
  const responses = m5RuntimeOf(state).handshakeResponses.get(local.collabId);
  const source = responses?.get(manager.instanceId);
  if (!isHandshakePairReport(source)) {
    return false;
  }
  for (const entry of responses.values()) {
    if (isHandshakePairReport(entry) && compareHandshakePair(entry, source) > 0) {
      return false;
    }
  }
  return true;
}

function isHandshakePairReport(entry) {
  return isPlainObject(entry) && Number.isInteger(entry.term) && Number.isInteger(entry.version);
}

function compareHandshakePair(left, right) {
  if (left.term !== right.term) {
    return left.term - right.term;
  }
  return left.version - right.version;
}

function rosterHadSeat(roster, seat) {
  return (Array.isArray(roster) ? roster : []).some((entry) => entry?.instanceId === seat.instanceId
    && (entry.sessionId === undefined || entry.sessionId === seat.sessionId));
}

function handshakeCatchupAuthorizes(ctx, ledger, source) {
  const evidence = ctx.handshakeCatchup;
  return isPlainObject(evidence)
    && evidence.term === ledgerTermOf(ledger)
    && sameSeat(evidence.manager, ledger.manager)
    && sameSeat(evidence.source, source);
}

function reportedManagerEndpointOk(state, local, manager, reported) {
  if (reported === undefined) {
    return true;   // 站长本人应答时不携 managerEndpoint（该字段只描述他机站长）
  }
  if (!isPlainObject(reported) || typeof reported.address !== 'string' || !Number.isInteger(reported.port)) {
    return false;
  }
  const endpoint = endpointFor(state, local, manager.instanceId);
  return endpoint !== undefined && endpoint.address === reported.address && endpoint.port === reported.port;
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
