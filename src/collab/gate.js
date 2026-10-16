import { POST_KINDS } from '../net/protocol.js';
import { CONFLICT_STATES, INVITE_THROTTLE_TABLE_MAX, MAX_PENDING_INVITES } from './model.js';
import { forumReachIdsOf, isLocalArchivedState, localModeOf, localNameOf, localRosterOf, localStateOf } from './local.js';

/* 入站门控（admit 决策）：invite 与「冲突裁定族」（freeze / unfreeze / decision）不按 collabId
 * 已知性判定（首个接触点 / 跨协作匹配——裁定帧的 collabId 是执行方那条，须按名匹配）；
 * 已知协作按本地状态查白名单；未知 collabId 一律拒绝（沿用接收管线的安全默认语义）。
 * 白名单是「冻结期允许的操作」与「归档后幂等 / 只读类」的机器化（设计 §6/§10）。
 * 会话级加入的 join 家族（设计 §2）同在第一梯队，见 admitJoinFamily——回执帧的发起机尚无
 * 该协作（申请先于入席），未知 collabId 判定不得先吞。 */

const FROZEN_ALLOWED = new Set(['freeze', 'unfreeze', 'decision', 'takeover-init', 'takeover', 'notice', 'snapshot', 'end', 'leave']);
const ARCHIVED_ALLOWED = new Set(['snapshot', 'notice', 'end', 'leave', 'history-request', 'history-bundle']);
/* 冻结族词表导出：静音栅栏的「被忽略治理帧」判定（mute.js）取自同一权威——词表分叉即判据分叉。 */
export const CONFLICT_FRAME_TYPES = new Set(['freeze', 'unfreeze', 'decision']);
const FORUM_CHANNEL_TYPES = new Set(['join', 'history-request', 'history-bundle']);
/* 讨论域类型白名单（冻结面隔离，设计 §5.5/§6）：forum 实例只受理其域内类型——邀请家族
 * （invite 经 admitInvite、approve/decline/withdraw 经本白名单）、帖通道（post）与
 * 控制事件（leave/end）；join/拉取两件套、冻结族在更前分支。managed 专属类型
 * （协作六类 topic/task/progress/issue/stop/reply、snapshot、takeover/handover 族）到达讨论
 * 一律拒绝并计数——六类在 managed 有处理器且以 role=manager 分派，讨论发起人恰是 manager：
 * 受理即让台账主题 / 任务板被域外帧改写（设计 §3「主题创建时定死」，本白名单的由来）。
 * notice 按事件再分（见 forumTypeAllowed）。 */
const FORUM_ALLOWED_TYPES = new Set(['post', 'approve', 'decline', 'withdraw', 'leave', 'end']);

/* notice 的讨论侧受理面：仅名单通告（roster）。它是讨论加入链在用的事件——发起人收齐
 * 新成员回应后广播名单变更（afterInviteResponse 的 active 分支对讨论同样生效），既有链路按
 * 「受理 + ack」走；拒收会让对端的重试队列停摆（join 重播的投递回报被钉死在这一帧之后）。
 * 其余事件（established / snapshot-stored / handshake / manager-changed / merge 系）是
 * managed 治理扩展，到达讨论一律拒绝并计数。 */
function forumTypeAllowed(frame) {
  if (frame.type === 'notice') {
    return frame.payload?.event === 'roster';
  }
  return FORUM_ALLOWED_TYPES.has(frame.type);
}

/* 请求类入站限流（设计 §5.3「请求类入站限流需新增」，计划 §4：同源 10s 内 2 次）：
 * 协作域现无通用入站限流器——沿同源记账思路新增（来源可见面为地址；拨入连接端口是临时端口，
 * 不作记账键——与邀请限频同一口径）。数值可经服务选项注入（测试收敛用）。 */
export const SYNC_REQUEST_WINDOW_MS = 10000;
export const SYNC_REQUEST_MAX = 2;
const SYNC_THROTTLE_TABLE_MAX = 64;

export function decideAdmission(state, frame, meta) {
  if (frame.type === 'invite') {
    return admitInvite(state, frame, meta);
  }
  const joinDecision = admitJoinFamily(state, frame, meta);
  if (joinDecision !== null) {
    return joinDecision;
  }
  if (CONFLICT_FRAME_TYPES.has(frame.type)) {
    return admitConflictFrame(state, frame);
  }
  const local = state.collabs.get(frame.collabId);
  if (local === undefined) {
    state.counters.unknownCollab++;
    return { ok: false, reason: '本机无此协作（未知 collabId）' };
  }
  if (FORUM_CHANNEL_TYPES.has(frame.type)) {
    return admitForumChannel(state, local, frame, meta);
  }
  if (localModeOf(local) === 'forum' && !forumTypeAllowed(frame)) {
    state.counters.forumTypeRejected++;
    return { ok: false, reason: `${frame.type} 属于协作模式——本机该实例为讨论（forum），类型语义不符` };
  }
  const stateGate = admitByLocalState(state, local, frame);
  if (stateGate !== null) {
    return stateGate;
  }
  if (frame.type === 'post') {
    return admitForumPost(state, local, frame);
  }
  return { ok: true };
}

/* 冻结 / 归档白名单门（状态相关分支的收口）：null = 本层无异议，交后续类型语义判定。 */
function admitByLocalState(state, local, frame) {
  const stateName = localStateOf(local);
  if (stateName === 'frozen') {
    if (FROZEN_ALLOWED.has(frame.type)) {
      return { ok: true };
    }
    state.counters.rejectedFrozen++;
    return { ok: false, reason: '协作已冻结：仅允许读台账 / 裁定 / 退出 / 终止' };
  }
  if (!isLocalArchivedState(local)) {
    return null;
  }
  if (ARCHIVED_ALLOWED.has(frame.type)) {
    return { ok: true };
  }
  state.counters.lateDropped++;
  state.log.warn(`协作已结束（或已退出），迟到消息丢弃：${frame.type}`, { collabId: frame.collabId, msgId: frame.msgId, from: frame.from?.instanceId });
  return { ok: false, reason: '协作已结束（或已退出）：消息丢弃并计数留痕' };
}

/* 讨论的 join 与拉取两件套（设计 §5.1/§5.3）：论坛专属类型——managed 实例收到即类型语义不符
 * 拒绝并计数；两件套在**归档后仍放行**（只读回填通道不因归档关闭，白名单与分支同点表达），
 * 且两者都要求请求方在本地折叠成员表内（非成员拒绝并计数）；join 在归档后不改变任何状态
 * （迟到副本丢弃并计数）。history-request 另过同源限流（被拒 = 无应答，由请求方换源/下轮）。 */
function admitForumChannel(state, local, frame, meta) {
  if (localModeOf(local) !== 'forum') {
    state.counters.eventMismatch++;
    return { ok: false, reason: `${frame.type} 通道属于讨论模式——本机该实例为协作（managed），类型语义不符` };
  }
  if (frame.type === 'join') {
    if (isLocalArchivedState(local)) {
      state.counters.lateDropped++;
      state.log.warn('讨论已结束（或已退出），join 迟到副本丢弃', { collabId: frame.collabId, from: frame.from?.instanceId });
      return { ok: false, reason: '讨论已结束（或已终止 / 已退出）：join 丢弃并计数留痕' };
    }
    return { ok: true };
  }
  if (frame.type === 'history-bundle') {
    /* 应答准入：本机的群体可达面内（折叠成员表 ∪ 邀请者引用 ∪ 端点表已知者——与对表候选、
     * 控制事件广播同一取数面）。新人首次回填窗口里，应答方可能既不在本机折叠成员表内
     * （对端事件尚未随对表拉回）、也不是邀请者：邀请随带的端点表（设计 §5.1 寻址信息）即
     * 「应答方是合法成员」的依据。请求侧准入不放宽（请求方须在折叠成员表内，见下）。 */
    if (forumReachIdsOf(local, state.self.instanceId).includes(frame.from.instanceId)) {
      return { ok: true };
    }
    state.counters.syncRequestsRejected++;
    return { ok: false, reason: '拉取应答方不在本机的可达成员面内（折叠成员表 / 邀请者引用 / 端点表——拒绝并计数）' };
  }
  if (!local.members.includes(frame.from.instanceId)) {
    state.counters.syncRequestsRejected++;
    state.log.warn('拉取请求方不在本机折叠成员表内（拒绝）', { collabId: frame.collabId, from: frame.from?.instanceId });
    return { ok: false, reason: '拉取请求方不在本机折叠成员表内（拒绝并计数）' };
  }
  if (!withinRequestRate(state, meta)) {
    state.counters.syncRequestsThrottled++;
    return { ok: false, reason: '拉取请求过于频繁（同源限频）' };
  }
  return { ok: true };
}

/* 同源请求频次判定：窗口内已达上限 → 拒绝（请求方按「无应答」换源或下轮对表）；
 * 表满按插入序淘汰（防伪造洪泛的写放大）。来源未知（测试假连接）不参与记账。 */
function withinRequestRate(state, meta) {
  const source = typeof meta?.remoteAddress === 'string' && meta.remoteAddress !== '' ? meta.remoteAddress : '';
  if (source === '') {
    return true;
  }
  const now = Date.now();
  const recent = (state.syncRequestWindow.get(source) ?? []).filter((at) => now - at < state.syncRequestWindowMs);
  if (recent.length >= state.syncRequestMax) {
    rememberRequestRate(state, source, recent);
    return false;
  }
  recent.push(now);
  rememberRequestRate(state, source, recent);
  return true;
}

/* 记账（删除后重插保持新鲜度；表满淘汰最旧来源）。 */
function rememberRequestRate(state, source, recent) {
  state.syncRequestWindow.delete(source);
  state.syncRequestWindow.set(source, recent);
  while (state.syncRequestWindow.size > SYNC_THROTTLE_TABLE_MAX) {
    const oldest = state.syncRequestWindow.keys().next().value;
    state.syncRequestWindow.delete(oldest);
  }
}

/* 帖通道的模式语义校验（设计 §5.2/§5.5 分层：协议层只校并集形态，本层判模式与词表）：
 * 帖只属于讨论实例——managed 实例收到 post 帧、或 post.kind 越出徽标词表，均为校验失败
 * （拒绝并计数；不匹配即不 ack，由发送侧按短重试与对表收敛）。帧形态（payload.post 齐全）
 * 已由协议层保证；此处只判「帖通道 ⇔ 讨论实例」与 kind 词表。 */
function admitForumPost(state, local, frame) {
  if (localModeOf(local) !== 'forum') {
    state.counters.postRejected++;
    return { ok: false, reason: 'post 通道属于讨论模式——本机该实例为协作（managed），类型语义不符' };
  }
  const kind = frame.payload?.post?.kind;
  if (typeof kind !== 'string' || !POST_KINDS.includes(kind)) {
    state.counters.postRejected++;
    return { ok: false, reason: `post.kind 不在标签词表（${POST_KINDS.join(' / ')}）` };
  }
  return { ok: true };
}

/* 同名 + 成员交集的匹配面（设计 §6 判据的机器化）：冻结通告、冲突检测、转达目标共用。
 * memberIds 传「完整参与者集合」（含发起者）——判据是两条协作的参与者集合有交集。
 * 模式隔离（设计 §6）：冲突匹配只取 managed 实例——讨论不参与同名冲突匹配（任何方向：
 * 不冻结别人、也不被人冻结；跨模式同名视为不同实例）。 */
export function matchConflictCollabs(state, name, memberIds) {
  return collabsMatchingName(state, name, memberIds, 'managed');
}

/* 讨论侧同名匹配：冻结流程帧的「忽略 + 受理」判定用——同判据、只取讨论实例。 */
export function matchForumCollabs(state, name, memberIds) {
  return collabsMatchingName(state, name, memberIds, 'forum');
}

/* 冻结族帧命中讨论实例的忽略计数（消费侧，与准入侧的受理 + ack 配对）：命中返回 true。
 * 冻结规程不施于讨论、讨论无治理面——忽略即正确处理（设计 §6；只可能来自同名 managed 邻域
 * 的广播，跨模式同名视为不同实例）。 */
export function noteForumGovernanceIgnored(state, frame) {
  const memberIds = frame.payload.members.map((member) => member.instanceId);
  if (matchForumCollabs(state, frame.payload.name, memberIds).length === 0) {
    return false;
  }
  state.counters.forumGovernanceIgnored++;
  return true;
}

function collabsMatchingName(state, name, memberIds, mode) {
  const ids = new Set(memberIds);
  const matched = [];
  for (const local of state.collabs.values()) {
    if (localModeOf(local) !== mode || !CONFLICT_STATES.includes(localStateOf(local))) {
      continue;
    }
    const roster = localRosterOf(local);
    if (localNameOf(local) === name && roster.some((entry) => ids.has(entry.instanceId))) {
      matched.push(local);
    }
  }
  return matched;
}

function admitInvite(state, frame, meta) {
  const members = frame.payload.members;
  if (frame.from.instanceId === state.self.instanceId) {
    state.counters.invitesRejected++;
    return { ok: false, reason: '邀请来源为本机（拒绝自邀 / 冒名 from）' };
  }
  if (!members.some((member) => member.instanceId === state.self.instanceId)) {
    state.counters.invitesRejected++;
    return { ok: false, reason: '邀请名单不含本机' };
  }
  if (!members.some((member) => member.instanceId === frame.from.instanceId)) {
    state.counters.invitesRejected++;
    return { ok: false, reason: '邀请来源不在名单中（来源身份与名单不符）' };
  }
  const source = typeof meta?.remoteAddress === 'string' && meta.remoteAddress !== '' ? meta.remoteAddress : '';
  const now = Date.now();
  const lastAt = state.inviteWindow.get(source);
  if (lastAt !== undefined && now - lastAt < state.inviteMinIntervalMs) {
    state.counters.invitesRejected++;
    return { ok: false, reason: '邀请过于频繁（同一来源限频）' };
  }
  if (countPendingInvites(state) >= MAX_PENDING_INVITES) {
    state.counters.invitesRejected++;
    return { ok: false, reason: `待回应邀请已达上限（${MAX_PENDING_INVITES}）——先处置既有邀请或等待过期` };
  }
  rememberInviteSource(state, source, now);
  return { ok: true };
}

/* 冲突裁定族（freeze / unfreeze / decision）的准入：同名 + 成员交集匹配本地在册协作
 * （裁定帧的 collabId 是执行方那条——按名匹配，与冻结检出的判据同一权威）。
 * 讨论实例命中（设计 §6）：受理 + ack，忽略与计数在消费侧（冻结流程帧只可能来自同名 managed
 * 邻域的广播，跨模式同名视为不同实例）；受理而非拒绝是为了不让邻域的治理重试被无 ack 钉死。 */
function admitConflictFrame(state, frame) {
  const memberIds = frame.payload.members.map((member) => member.instanceId);
  if (matchConflictCollabs(state, frame.payload.name, memberIds).length > 0) {
    return { ok: true };
  }
  if (matchForumCollabs(state, frame.payload.name, memberIds).length > 0) {
    return { ok: true };
  }
  state.counters.freezeUnmatched++;
  return { ok: false, reason: '冻结 / 裁定通告与本机协作无匹配（与己无关，忽略）' };
}

/* 待回应邀请数：成员侧 proposed 且未回应的本地记录（本机发起的提议中协作不算挂起）。 */
function countPendingInvites(state) {
  let count = 0;
  for (const local of state.collabs.values()) {
    if (local.role === 'member' && local.member.state === 'proposed' && (local.member.decision ?? null) === null) {
      count++;
    }
  }
  return count;
}

/* 邀请限频记录（键 = 来源地址）：插入序淘汰——表满丢最旧（表容量防伪造洪泛的写放大）。 */
function rememberInviteSource(state, source, now) {
  state.inviteWindow.delete(source);
  state.inviteWindow.set(source, now);
  while (state.inviteWindow.size > INVITE_THROTTLE_TABLE_MAX) {
    const oldest = state.inviteWindow.keys().next().value;
    state.inviteWindow.delete(oldest);
  }
}

/* 会话级加入的入站三帧（设计 §2「准入门 join 家族专支」）：join-request 是会话向站长发起的
 * 加入申请，join-grant / join-deny 是站长对某条申请的回执。回执的凭据是本机申请台账
 * （run/join-applications.json，「本机确实申请过」只有它说了算——伪造回执无从凭空造获准）；
 * 且发起机此刻尚无该协作的本地记录（申请先于入席、回执先于入席），故回执帧必须先于未知
 * collabId 判定，不得被既有链路吞掉。申请帧在本层只做三查（自邀 / 限频 / 上限），受理与否
 * 仍落既有链路定论（未知 collabId / 冻结 / 讨论实例类型语义不符自然拒）。
 * 返回 null = 非本族帧，或申请已过三查（交后续链路）。 */
function admitJoinFamily(state, frame, meta) {
  if (frame.type === 'join-request') {
    return admitJoinRequest(state, frame, meta);
  }
  if (frame.type === 'join-grant' || frame.type === 'join-deny') {
    return admitJoinDecision(state, frame);
  }
  return null;
}

/* 申请帧三查（设计 §2）：自邀拒（不得向自己所在实例发申请——本机对本站长协作的申请走本机
 * 待批准面，不经网络帧）；同源限频（沿邀请限频先例，窗口表独立——邀请与申请互不挤占额度，
 * 间隔沿用 inviteMinIntervalMs 这一注入旋钮）；待批准上限（沿待回应邀请上限先例，读该协作的
 * 待批准数——pendingJoinsOf(collabId) 即站长侧接入台账的注入面）。形态（sessionId 过标识
 * 白名单）已由协议层把关，此处不重验。三查的拒绝计 joinRequestsRejected；三查通过后落既有
 * 链路的拒绝（未知 collab / 冻结 / 讨论）计各自的既有计数。全过返回 null。 */
function admitJoinRequest(state, frame, meta) {
  if (frame.from.instanceId === state.self.instanceId) {
    state.counters.joinRequestsRejected++;
    return { ok: false, reason: '加入申请来源为本机（拒绝自邀 / 冒名 from）' };
  }
  const source = typeof meta?.remoteAddress === 'string' && meta.remoteAddress !== '' ? meta.remoteAddress : '';
  const now = Date.now();
  const lastAt = state.joinRequestWindow.get(source);
  if (lastAt !== undefined && now - lastAt < state.inviteMinIntervalMs) {
    state.counters.joinRequestsRejected++;
    return { ok: false, reason: '加入申请过于频繁（同一来源限频）' };
  }
  if (state.pendingJoinsOf(frame.collabId).length >= MAX_PENDING_INVITES) {
    state.counters.joinRequestsRejected++;
    return { ok: false, reason: `待批准加入申请已达上限（${MAX_PENDING_INVITES}）——先处置既有申请或等待过期` };
  }
  rememberJoinRequestSource(state, source, now);
  return null;
}

/* 回执帧的比对（设计 §2）：仅当本机申请台账存在三项逐条相符的记录才受理——collabId 相符、
 * from.instanceId 即受理该申请的站长实例（managerInstanceId）、payload.reqMsgId 即申请帧的
 * msgId（台账按它唯一）；且未过期——时效与台账过期剪除同一基准（now - sentAt < 申请时限，
 * 见加入台账的剪除判据）。时限取 state.joinRequestTtlMs（配置项的注入值——本门全部数值都走
 * 平铺注入，与邀请限频 / 请求限流同一样式）。无匹配 / 已过期一律拒并计数。
 * 申请记录不在此移除：回执后的收尾（删记录、接线）归加入域。 */
function admitJoinDecision(state, frame) {
  const record = state.joinApplications.list().find((application) =>
    application.collabId === frame.collabId
    && application.managerInstanceId === frame.from.instanceId
    && application.msgId === frame.payload?.reqMsgId);
  if (record !== undefined && Date.now() - record.sentAt < state.joinRequestTtlMs) {
    return { ok: true };
  }
  state.counters.joinDecisionsRejected++;
  if (record !== undefined) {
    return { ok: false, reason: '加入申请已过期——回执不再受理（时限内未收到回执的申请按失效处置）' };
  }
  return { ok: false, reason: '与本机加入申请台账不匹配（collabId / 站长实例 / 申请帧标识须逐项相符）——拒绝' };
}

/* 申请限频记录（键 = 来源地址，与邀请限频同一表容量先例）：插入序淘汰——表满丢最旧。 */
function rememberJoinRequestSource(state, source, now) {
  state.joinRequestWindow.delete(source);
  state.joinRequestWindow.set(source, now);
  while (state.joinRequestWindow.size > INVITE_THROTTLE_TABLE_MAX) {
    const oldest = state.joinRequestWindow.keys().next().value;
    state.joinRequestWindow.delete(oldest);
  }
}
