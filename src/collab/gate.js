import { POST_KINDS } from '../net/protocol.js';
import { CONFLICT_STATES, INVITE_THROTTLE_TABLE_MAX, MAX_PENDING_INVITES } from './model.js';
import { isLocalArchivedState, localModeOf, localNameOf, localRosterOf, localStateOf } from './local.js';

/* 入站门控（admit 决策）：invite 与「冲突裁定族」（freeze / unfreeze / decision）不按 collabId
 * 已知性判定（首个接触点 / 跨协作匹配——裁定帧的 collabId 是执行方那条，须按名匹配）；
 * 已知协作按本地状态查白名单；未知 collabId 一律拒绝（沿用接收管线的安全默认语义）。
 * 白名单是「冻结期允许的操作」与「归档后幂等 / 只读类」的机器化（设计 §6/§10）。 */

const FROZEN_ALLOWED = new Set(['freeze', 'unfreeze', 'decision', 'takeover-init', 'takeover', 'notice', 'snapshot', 'end', 'leave']);
const ARCHIVED_ALLOWED = new Set(['snapshot', 'notice', 'end', 'leave']);
const CONFLICT_FRAME_TYPES = new Set(['freeze', 'unfreeze', 'decision']);

export function decideAdmission(state, frame, meta) {
  if (frame.type === 'invite') {
    return admitInvite(state, frame, meta);
  }
  if (CONFLICT_FRAME_TYPES.has(frame.type)) {
    return admitConflictFrame(state, frame);
  }
  const local = state.collabs.get(frame.collabId);
  if (local === undefined) {
    state.counters.unknownCollab++;
    return { ok: false, reason: '本机无此协作（未知 collabId）' };
  }
  const stateName = localStateOf(local);
  if (stateName === 'frozen') {
    if (FROZEN_ALLOWED.has(frame.type)) {
      return { ok: true };
    }
    state.counters.rejectedFrozen++;
    return { ok: false, reason: '协作已冻结：仅允许读台账 / 裁定 / 退出 / 终止' };
  }
  if (isLocalArchivedState(local)) {
    if (ARCHIVED_ALLOWED.has(frame.type)) {
      return { ok: true };
    }
    state.counters.lateDropped++;
    state.log.warn(`协作已结束（或已退出），迟到消息丢弃：${frame.type}`, { collabId: frame.collabId, msgId: frame.msgId, from: frame.from?.instanceId });
    return { ok: false, reason: '协作已结束（或已退出）：消息丢弃并计数留痕' };
  }
  if (frame.type === 'post') {
    return admitForumPost(state, local, frame);
  }
  return { ok: true };
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
    return { ok: false, reason: '邀请来源不在名单中（管理者身份不一致）' };
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

/* 待回应邀请数：成员侧 proposed 且未回应的本地记录（管理席位自己发起的提议中协作不算挂起）。 */
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
