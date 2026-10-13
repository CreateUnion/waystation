import { DEFAULT_COLLAB_MODE, isPort } from '../net/protocol.js';
import { MAX_BOARD_ENTRIES, isSnapshotShape } from './model.js';
import { createPostsStore } from './posts.js';
import { createMembersStore } from './members.js';
import { ledgerDigest } from './store.js';
import { isLocalArchivedState, localModeOf, persistMember, persistSnapshot, rememberKnownHost, selfJoinedOf } from './local.js';
import { matchConflictCollabs, noteForumGovernanceIgnored } from './gate.js';
import { applyEndpoint, applyFreezeLocally, broadcastFreeze, governanceTargets, memberIdsOf, mutateLedger, relayGovernance, sendTo, stopJoinReplay } from './outgoing.js';
import { applyIncomingJoin, applyIncomingLeave, handleHistoryBundle, handleHistoryRequest } from './sync.js';
import { handleHandshake, handleTakeover, handleTakeoverInit, resendEffectiveTakeover, resumeLocal } from './takeover.js';
import { handleDecision, handleMergeOutcome, handleMergeRequest, handleUnfreeze } from './freeze.js';
import { handleHandover, handleManagerChanged } from './handover.js';

/* 接收事件处理（consume 的落点）：端点学习、邀请建记录与冲突检测、回应与建立、撤回 / 退出 / 结束、
 * 主题与进度联动、冻结接收与转达、快照接收 / 回执 / 请求应答、治理与韧性五型（抢接 / 裁定 / 解冻 / 移交 /
 * 握手与驿丞变更通告）。异常由服务外层统一隔离（绝不穿出）。
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
  decision: handleDecision,
  unfreeze: handleUnfreeze,
  handover: handleHandover,
};

/* notice 事件分发表（建协 / 协作 + 治理扩展）：未挂表事件只计数（前向兼容面）。 */
const NOTICE_HANDLERS = {
  established: handleEstablished,
  'manager-changed': handleManagerChanged,
  handshake: handleHandshake,
  'merge-request': handleMergeRequest,
  'merge-outcome': handleMergeOutcome,
};

/* 事件分发：返回值透传（帖去重栅栏的「不重复注入会话」声明经此到达接收管线）。 */
export async function handleEvent(state, frame, meta) {
  learnEndpoints(state, frame, meta);
  const handler = EVENT_HANDLERS[frame.type];
  if (handler !== undefined) {
    return await handler(state, frame, meta);
  }
  return undefined;
}

/* 端点学习（设计 §5「清单随协作参与关系更新」的接入面）：已受理帧的来源地址与端口记入
 * 对应协作的端点表（仅当本机在协作中——注册表命中），并同步 known-hosts（单播兜底目标）。
 * 仅在端点变化时写 member.json（避免每条消息一次写盘）；学习到现任驿丞端点时补做队列重定向、
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
  if (applyEndpoint(state, local, frame.from, address, frame.from.port)) {
    resendEffectiveTakeover(state, local, frame.from.instanceId);
  }
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
    posts: createPostsStore({ dataDir: state.dataDir, collabId: frame.collabId, log: state.log }),
    members: createMembersStore({ dataDir: state.dataDir, collabId: frame.collabId, log: state.log }),
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

/* 同 collabId 再次邀请（讨论）：就地互认——已加入者只学端点（重复 join 由事件日志幂等吸收）；
 * 未加入者（含已拒绝、已过期、已退出重入）重新定格提议面（新有效期、最新名单与主题），
 * 事件日志与帖子原样保留（重入回填按同步游标续拉）。 */
function receiveRepeatInvite(state, existing, frame, meta) {
  if (localModeOf(existing) !== 'forum' || (frame.payload.mode ?? DEFAULT_COLLAB_MODE) !== 'forum') {
    state.counters.invitesRejected++;
    return;
  }
  learnInviteSource(state, existing, frame, meta);
  learnInviteEndpoints(state, existing, frame);
  state.counters.invitesReceived++;
  if (selfJoinedOf(existing, state.self.instanceId)) {
    return;   // 已加入：邀请幂等（并集吸收），不动本地成员面
  }
  const now = new Date().toISOString();
  existing.member.state = 'proposed';
  existing.member.decision = null;
  existing.member.invitedAt = now;
  existing.member.expiresAt = new Date(Date.parse(now) + state.config.inviteTtlMs).toISOString();
  existing.member.roster = inviteRosterOf(frame);
  existing.member.topic = frame.payload.topic;
  delete existing.member.archivedAt;
  persistMember(state, existing);
}

/* 邀请定格的本地记录（roster 供冲突交集判据在成员侧取数；有效期自本地收到时刻起算）。
 * 模式随邀请载荷定格（缺字段按 managed 解释——旧版对端不携带该字段）；主题随记录定格
 * （成员侧发起邀请的取数面）。 */
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
    roster: inviteRosterOf(frame),
    endpoints: {},
    invitedAt: now,
    expiresAt: new Date(Date.parse(now) + state.config.inviteTtlMs).toISOString(),
    decision: null,
  };
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

function handleApproveResponse(state, frame) {
  applyInviteResponse(state, frame, 'approved');
}

function handleDeclineResponse(state, frame) {
  applyInviteResponse(state, frame, 'declined');
}

/* 管理席位侧：把回应入账（幂等——同向重试帧不再推进）。提议中协作走建立判定点；
 * 进行中协作的邀请回应（合并新增成员）直接定格：approved → member（同意效力范围：已过同意门）、
 * declined → declined。冻结 / 归档态忽略（冻结期写被门控拦住，此处兜底语义一致）。 */
function applyInviteResponse(state, frame, wanted) {
  const local = state.collabs.get(frame.collabId);
  if (local === undefined || local.role !== 'manager') {
    return;
  }
  const status = local.ledger.status;
  if (status !== 'proposed' && status !== 'active') {
    return;
  }
  const member = responseMemberOf(state, local, frame, wanted);
  if (member === null) {
    return;
  }
  const settledState = wanted === 'approved' && status === 'active' ? 'member' : wanted;
  const applied = mutateLedger(state, local, () => {
    member.state = settledState;
  });
  if (applied === null) {
    /* 挂起期写被拦（mutateLedger 已按 mutationSuspended 留痕）：本帧拒绝且不进入后续副作用——
     * 不得虚增回应计数，也不得对未变更的名单发空名单通告。 */
    return;
  }
  countResponse(state, wanted);
  afterInviteResponse(state, local, status, settledState);
}

/* 回应入账后的两向收口：进行中协作的新成员定格（名单通告）；提议中协作走建立判定点。 */
function afterInviteResponse(state, local, status, settledState) {
  if (status === 'active' && settledState === 'member') {
    broadcastRosterNotice(state, local);   // 合并新增成员：既有参与者知悉名单变更（不重复点头）
    return;
  }
  if (status === 'proposed') {
    maybeEstablish(state, local);
  }
}

/* 回应的名单定位与合法态守卫（幂等重放与终局保护）：非法者计数告警并返回 null。 */
function responseMemberOf(state, local, frame, wanted) {
  const member = local.ledger.members.find((entry) => entry.instanceId === frame.from.instanceId);
  if (member === undefined || member.role === 'manager') {
    state.counters.eventMismatch++;
    state.log.warn('回应来源不在名单（忽略）', { collabId: local.collabId, from: frame.from.instanceId });
    return null;
  }
  if (member.state === wanted) {
    return null;
  }
  if (member.state !== 'invited') {
    state.counters.eventMismatch++;
    state.log.warn('回应与既有终局不符（忽略——已撤回 / 已回应的成员不得被翻转）', { collabId: local.collabId, from: frame.from.instanceId, state: member.state });
    return null;
  }
  return member;
}

function countResponse(state, wanted) {
  if (wanted === 'approved') {
    state.counters.approvalsIn++;
  } else {
    state.counters.declinesIn++;
  }
}

/* 建立判定点（定案 7）：全部应邀者有终局决策且同意 ≥1 → 建立前冲突复检（第二检测点）→
 * 冻结（检出）或转 active；部分未决等待；全部拒绝保持提议中（管理者可整条撤回）。
 * 讨论模式不走本路径：建立 = 加入事件（个别加入制、不设 established 帧——设计 §5.1），
 * 由加入链路推进；此处拦截以免讨论被 managed 的「收齐全票」判定提前转正。 */
function maybeEstablish(state, local) {
  if (localModeOf(local) === 'forum') {
    return;
  }
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

/* 帖到达（讨论实例；准入已判模式与词表）：按（作者实例标识, postId）幂等入本地列表——
 * 重复路径副本不再入列（计数留痕、无害）；帖只追加、不改任何元状态（topic 帖亦按普通帖处理，
 * 主题创建时定死）。ts 取帧 ts（作者侧落盘强制单调、随帖携带）；entryId 取载荷 postId 原样
 * （该帖在全部副本中的稳定标识）。
 * 注入栅栏（限帖通道、不泛化）：去重命中的副本以 sessionDeliver:false 声明不重复注入会话
 * （`(作者, postId)` 去重结果参与投递判定）——不同 msgId 的重复路径副本由此不再二次通知；
 * managed 的「受理帧仍注入」行为不受影响（本声明只由帖通道发出，接收管线只在该类型采信）。 */
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
    return { sessionDeliver: false };
  }
  state.counters.postsIn++;
  return undefined;
}

/* 冻结接收（设计 §6）：匹配 → 记下对端名单（合并并集的输入）→ 本地冻结（幂等）→ 转达
 * （每节点对同一原帧至多一次）。命中讨论实例（准入已受理 + ack）：忽略并计数——冻结规程
 * 不施于讨论、转达面也不进入（讨论无治理面）。 */
function handleFreeze(state, frame) {
  const payload = frame.payload;
  const matched = matchConflictCollabs(state, payload.name, payload.members.map((entry) => entry.instanceId));
  if (matched.length === 0) {
    noteForumGovernanceIgnored(state, frame);
    return;
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
  storeSnapshot(state, frame);
}

/* 快照接收（定案 4 + 治理收紧）：来源必须为现任驿丞（换席后陈旧副本不得经快照通道覆盖——
 * 版本号只保证单调，不保证来源正当）→ 形态 → 自洽（version ↔ 内嵌台账、collabId ↔ 帧 collabId）
 * → digest 重算 → 版本不倒退 → 落盘 + 回执 + 唤醒等待中的 view。 */
function storeSnapshot(state, frame) {
  const local = state.collabs.get(frame.collabId);
  if (local === undefined) {
    state.counters.snapshotCorrupt++;
    return;
  }
  const currentManagerId = local.role === 'manager' ? state.self.instanceId : local.member.manager.instanceId;
  if (frame.from.instanceId !== currentManagerId) {
    state.counters.snapshotFromNonManager++;
    state.log.warn('快照来源不是现任驿丞（拒绝：防陈旧副本经快照通道覆盖）', { collabId: frame.collabId, from: frame.from.instanceId });
    return;
  }
  const record = snapshotRecordOf(frame, frame.payload);
  if (!isSnapshotShape(record) || record.version !== record.ledger.version || record.ledger.collabId !== frame.collabId) {
    state.counters.snapshotCorrupt++;
    state.log.warn('快照载荷不合形态或与帧不自洽（已忽略）', { collabId: frame.collabId, version: record.version });
    return;
  }
  if (ledgerDigest(record.ledger) !== record.digest) {
    state.counters.snapshotCorrupt++;
    state.log.warn('快照摘要不符（已忽略）', { collabId: frame.collabId, version: record.version });
    return;
  }
  if (local.snapshot !== null && record.version < local.snapshot.version) {
    state.counters.snapshotStale++;
    return;
  }
  local.snapshot = record;
  persistSnapshot(state, local);
  state.counters.snapshotStored++;
  sendSnapshotReceipt(state, local, frame);
  resolvePendingView(state, local.collabId, local.snapshot);
}

/* 接收记录成形：与本地快照文件同一形态（同一份数据在接收侧与加载侧过同一校验）。 */
function snapshotRecordOf(frame, payload) {
  return {
    version: payload?.version,
    digest: payload?.digest,
    receivedAt: new Date().toISOString(),
    from: { instanceId: frame.from.instanceId, identityName: frame.from.identityName },
    ledger: payload?.ledger,
  };
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

/* 快照请求应答：管理席位把当前台账整份回给请求方（端点取请求帧来源；成员侧忽略；
 * 写暂停期间不服务——收敛等待中避免以未定身份对外供数）。
 * 载荷冻结：入队的是台账副本——活引用在「应答入队与上线序列化」的间隙会被后续变更改写，
 * 帧将以「摘要不符」被对端丢弃（与快照推送同一纪律）。 */
function answerSnapshotRequest(state, frame) {
  const local = state.collabs.get(frame.collabId);
  if (local === undefined || local.role !== 'manager') {
    return;
  }
  if (local.suspended !== null) {
    state.counters.snapshotSkipped++;
    return;
  }
  const endpoint = local.endpoints.get(frame.from.instanceId);
  if (endpoint === undefined) {
    state.counters.snapshotSkipped++;
    return;
  }
  const frozen = structuredClone(local.ledger);
  sendTo(state, local.collabId, frame.from.instanceId, endpoint, 'snapshot', { kind: 'data', version: frozen.version, digest: ledgerDigest(frozen), ledger: frozen });
  state.counters.snapshotSent++;
}

/* 结束到达（成员侧）：归档；重复通告幂等；管理席位收到结束通告忽略（结束只能由本机发起）。
 * 讨论实例的发起人同样收不到合法的 end（仅发起人可 end——本批状态面经归档守卫，守卫面归后续）；
 * 成员侧归档即停 join 重播与对表（end 双通道之一：在线广播；离线者经 bundle 元状态学到）。 */
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
  stopJoinReplay(state, local);
  state.counters.endedIn++;
}

/* 退出到达：讨论 = 成员事件并入（折叠出表）+ 触发对表（设计 §5.4——leave 是广播事件，
 * 由接收方按事件集并集吸收）；managed = 管理席位记成员状态 + 名单变更通告（设计 §6）。 */
function handleLeave(state, frame) {
  const local = state.collabs.get(frame.collabId);
  if (local === undefined) {
    return;
  }
  if (localModeOf(local) === 'forum') {
    applyIncomingLeave(state, local, frame);
    return;
  }
  if (local.role !== 'manager') {
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
  broadcastRosterNotice(state, local);
}
