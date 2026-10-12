import { CONFLICT_STATES, INVITE_THROTTLE_TABLE_MAX, MAX_PENDING_INVITES } from './model.js';
import { isLocalArchivedState, localNameOf, localRosterOf, localStateOf } from './local.js';

/* 入站门控（admit 决策）：invite 与 freeze 不按 collabId 已知性判定（首个接触点 / 跨协作匹配）；
 * 已知协作按本地状态查白名单；未知 collabId 一律拒绝（沿用接收管线的安全默认语义）。
 * 白名单是「冻结期允许的操作」与「归档后幂等 / 只读类」的机器化（设计 §6/§10）。 */

const FROZEN_ALLOWED = new Set(['freeze', 'unfreeze', 'decision', 'takeover-init', 'takeover', 'notice', 'snapshot', 'end', 'leave']);
const ARCHIVED_ALLOWED = new Set(['snapshot', 'notice', 'end', 'leave']);

export function decideAdmission(state, frame, meta) {
  if (frame.type === 'invite') {
    return admitInvite(state, frame, meta);
  }
  if (frame.type === 'freeze') {
    return admitFreeze(state, frame);
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
  return { ok: true };
}

/* 同名 + 成员交集的匹配面（设计 §6 判据的机器化）：冻结通告、冲突检测、转达目标共用。
 * memberIds 传「完整参与者集合」（含发起者）——判据是两条协作的参与者集合有交集。 */
export function matchConflictCollabs(state, name, memberIds) {
  const ids = new Set(memberIds);
  const matched = [];
  for (const local of state.collabs.values()) {
    if (!CONFLICT_STATES.includes(localStateOf(local))) {
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

function admitFreeze(state, frame) {
  const matched = matchConflictCollabs(state, frame.payload.name, frame.payload.members.map((member) => member.instanceId));
  if (matched.length === 0) {
    state.counters.freezeUnmatched++;
    return { ok: false, reason: '冻结通告与本机协作无匹配（与己无关，忽略）' };
  }
  return { ok: true };
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
