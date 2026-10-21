import { randomUUID } from 'node:crypto';
import { ID_PATTERN, MAX_ACTIVE_SEATS } from '../net/protocol.js';

/* 邀请与两段式入席的纯内存簿记（设计 §4.1–§4.4）。
 * 三本账各管一段：发起侧 invites（谁被邀请、谁已接受/拒绝）、目标机 pending invites（未入席会话的补投依据）、
 * 站长侧 joining（已发 grant、待 confirm 的席位）。本模块只做状态判定与去重，不写盘、不发帧、不读服务层：
 * 持久化与网络投递由接线方按返回的 reason 决定，判定逻辑因此可在 PC 上单测。
 * 时间一律经注入时钟推进（调用参数可覆盖），过期判定与容量淘汰因此确定可复现。
 * reason 词表与 join-deny 的原因同一口径：expired / aborted / manager-changed / capacity 等。 */

export const PENDING_INVITE_CAPACITY = 64;
export const JOINING_TTL_MS = 60000;
/* 在途入席不超过活跃席位硬顶：joining 不占活跃席位，但未确认记录也不得无界堆积。 */
export const MAX_JOINING = MAX_ACTIVE_SEATS;

/**
 * @typedef {{ instanceId: string, sessionId: string }} SeatRef
 * @typedef {{ instanceId: string, targetSessionId?: string }} InviteTarget
 * @typedef {'open' | 'closed' | 'withdrawn'} InviteState
 * @typedef {{
 *   inviteId: string,
 *   targets: InviteTarget[],
 *   createdAt: number,
 *   expiresAt: number,
 *   state: InviteState,
 *   acceptedSessions: SeatRef[]
 * }} InviteRecord
 * @typedef {'open' | 'consumed' | 'expired' | 'withdrawn'} PendingState
 * @typedef {{ instanceId: string, sessionId: string | null }} ManagerSeat
 * @typedef {{
 *   inviteId: string,
 *   collabId: string,
 *   fromManager: ManagerSeat,
 *   targetSessionId: string | null,
 *   expiresAt: number,
 *   state: PendingState,
 *   acceptedSessions: string[]
 * }} PendingRecord
 * @typedef {{
 *   joinId: string,
 *   collabId: string,
 *   instanceId: string,
 *   sessionId: string,
 *   managerTerm: number,
 *   grantVersion: number,
 *   requestedAt: number,
 *   expiresAt: number,
 *   confirmed: boolean,
 *   confirmedAt: number | null
 * }} JoiningRecord
 */

/* —— 形态与时钟原语 —— */

function failure(reason) {
  return { ok: false, reason };
}

function asId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value) ? value : null;
}

/**
 * 可缺省标识：缺省归一为 null，给了但形态不符即拒绝（不得把坏值当缺省）。
 * @param {unknown} value
 * @returns {{ ok: true, value: string | null } | { ok: false }}
 */
function optionalIdOf(value) {
  if (value === undefined || value === null) {
    return { ok: true, value: null };
  }
  const id = asId(value);
  return id === null ? { ok: false } : { ok: true, value: id };
}

function isPositiveInt(value) {
  return Number.isInteger(value) && value > 0;
}

function clockOf(state, explicit) {
  return Number.isFinite(explicit) ? explicit : state.now();
}

/**
 * @param {{ instanceId?: unknown, sessionId?: unknown } | null | undefined} input
 * @returns {SeatRef | null}
 */
function seatOf(input) {
  const instanceId = asId(input?.instanceId);
  const sessionId = asId(input?.sessionId);
  return instanceId === null || sessionId === null ? null : { instanceId, sessionId };
}

function hasSeat(seats, seat) {
  return seats.some((entry) => entry.instanceId === seat.instanceId && entry.sessionId === seat.sessionId);
}

function seatKey(seat) {
  return `${seat.instanceId}\u0000${seat.sessionId}`;
}

/* 拒绝记录只进内存（不进 invites.json 的冻结形态）：用于挡住同一会话的重试与反转决定。 */
function declinedInviteOf(state, inviteId, seat) {
  return state.declines.get(inviteId)?.has(seatKey(seat)) ?? false;
}

function rememberDecline(state, inviteId, seat) {
  const held = state.declines.get(inviteId);
  if (held === undefined) {
    state.declines.set(inviteId, new Set([seatKey(seat)]));
    return;
  }
  held.add(seatKey(seat));
}

/* —— 发起侧邀请簿记（站长机） —— */

/**
 * @param {{ now?: () => number }} [options]
 */
export function createInvitesBook({ now = Date.now } = {}) {
  /** @type {{ now: () => number, records: Map<string, InviteRecord>, declines: Map<string, Set<string>> }} */
  const state = { now: typeof now === 'function' ? now : Date.now, records: new Map(), declines: new Map() };
  return {
    openInvite: (input) => openInvite(state, input ?? {}),
    matchInvite: (inviteId, input) => matchInvite(state, inviteId, input ?? {}),
    acceptInvite: (inviteId, input) => acceptInvite(state, inviteId, input ?? {}),
    declineInvite: (inviteId, input) => declineInvite(state, inviteId, input ?? {}),
    withdrawInvite: (inviteId) => withdrawInvite(state, inviteId),
    expireInvites: (at) => expireInvites(state, at),
    get: (inviteId) => cloneInviteOrNull(recordOf(state, inviteId)),
    list: () => [...state.records.values()].map(cloneInvite),
  };
}

/* 生成邀请记录：targets 数组按设计形态预留，当前一次邀请只登记一个目标机器（指名时带会话）。 */
function openInvite(state, input) {
  const target = targetOf(input);
  if (target === null || !isPositiveInt(input?.ttl)) {
    return failure('invalid');
  }
  const at = clockOf(state, input?.now);
  const inviteId = `inv-${randomUUID()}`;
  /** @type {InviteRecord} */
  const record = {
    inviteId,
    targets: [target],
    createdAt: at,
    expiresAt: at + input.ttl,
    state: 'open',
    acceptedSessions: [],
  };
  state.records.set(inviteId, record);
  return { ok: true, inviteId, expiresAt: record.expiresAt };
}

function targetOf(input) {
  const instanceId = asId(input?.targetInstanceId);
  if (instanceId === null) {
    return null;
  }
  const session = optionalIdOf(input?.targetSessionId);
  if (session.ok !== true) {
    return null;
  }
  return session.value === null ? { instanceId } : { instanceId, targetSessionId: session.value };
}

/* 匹配顺序：先确认目标席位（防止给错机器/错会话放行），再判过期、已接受/已拒绝与记录状态。 */
function matchInvite(state, inviteId, input) {
  const record = recordOf(state, inviteId);
  if (record === undefined) {
    return failure('unknown');
  }
  const seat = seatOf(input);
  if (seat === null) {
    return failure('invalid');
  }
  const target = targetMatchOf(record, seat);
  if (typeof target === 'string') {
    return failure(target);
  }
  if (clockOf(state, input?.now) >= record.expiresAt) {
    return failure('expired');
  }
  if (hasSeat(record.acceptedSessions, seat)) {
    return failure('already-accepted');
  }
  if (declinedInviteOf(state, inviteId, seat)) {
    return failure('already-declined');
  }
  if (record.state !== 'open') {
    return failure(record.state);
  }
  return { ok: true, invite: cloneInvite(record) };
}

/* 目标命中：同机器且（指名会话相同或无指名）；分机器不符与会话不符两种 reason。 */
function targetMatchOf(record, seat) {
  const sameMachine = record.targets.filter((target) => target.instanceId === seat.instanceId);
  if (sameMachine.length === 0) {
    return 'target-mismatch';
  }
  const usable = sameMachine.find((target) => target.targetSessionId === undefined || target.targetSessionId === seat.sessionId);
  return usable === undefined ? 'session-mismatch' : usable;
}

/* 接受：重复接受幂等（重发不产生第二席）；指名邀请接受后整条关闭，不指名保持 open 多席。
 * acceptedSessions 按设计只登记**已 joined** 的席位：接线方应在 confirmJoining 成功后调用本方法，
 * approve 阶段只做 matchInvite + beginJoining。这样 joining 失败/超时不会留下「已接受未成席」，
 * 同一 inviteId 可用新 joinId 重试。 */
function acceptInvite(state, inviteId, input) {
  const seat = seatOf(input);
  if (seat === null) {
    return failure('invalid');
  }
  const record = recordOf(state, inviteId);
  if (record === undefined) {
    return failure('unknown');
  }
  const checked = matchInvite(state, inviteId, input);
  if (checked.ok !== true) {
    return checked.reason === 'already-accepted'
      ? { ok: true, inviteId, accepted: true, idempotent: true, state: record.state }
      : checked;
  }
  record.acceptedSessions.push(seat);
  closeIfNamed(record);
  return { ok: true, inviteId, accepted: true, idempotent: false, state: record.state };
}

/* 拒绝：只登记本会话的拒绝，不指名邀请因此仍可被同机其他会话接受；指名邀请拒绝后整条关闭。 */
function declineInvite(state, inviteId, input) {
  const seat = seatOf(input);
  if (seat === null) {
    return failure('invalid');
  }
  const record = recordOf(state, inviteId);
  if (record === undefined) {
    return failure('unknown');
  }
  const checked = matchInvite(state, inviteId, input);
  if (checked.ok !== true) {
    return checked.reason === 'already-declined'
      ? { ok: true, inviteId, declined: true, idempotent: true, state: record.state }
      : checked;
  }
  rememberDecline(state, inviteId, seat);
  closeIfNamed(record);
  return { ok: true, inviteId, declined: true, idempotent: false, state: record.state };
}

function closeIfNamed(record) {
  if (record.targets.some((target) => target.targetSessionId !== undefined)) {
    record.state = 'closed';
  }
}

/* 撤回：只关 open 的记录；已关闭（指名已接受/拒绝）不可撤回，避免撤销已成立的席位决定。 */
function withdrawInvite(state, inviteId) {
  const record = recordOf(state, inviteId);
  if (record === undefined) {
    return failure('unknown');
  }
  if (record.state === 'withdrawn') {
    return { ok: true, inviteId, withdrawn: true, idempotent: true };
  }
  if (record.state !== 'open') {
    return failure(record.state);
  }
  record.state = 'withdrawn';
  state.declines.delete(inviteId);
  return { ok: true, inviteId, withdrawn: true, idempotent: false };
}

/* 到期清理：记录整体移除（过期记录再匹配只能得 unknown）；返回值供调用方停补投/计数。 */
function expireInvites(state, at) {
  const now = clockOf(state, at);
  const inviteIds = [];
  for (const [inviteId, record] of state.records) {
    if (now < record.expiresAt) {
      continue;
    }
    state.records.delete(inviteId);
    state.declines.delete(inviteId);
    if (record.state === 'open') {
      inviteIds.push(inviteId);
    }
  }
  return { expired: inviteIds.length, inviteIds };
}

function recordOf(state, inviteId) {
  return typeof inviteId === 'string' ? state.records.get(inviteId) : undefined;
}

function cloneInviteOrNull(record) {
  return record === undefined ? null : cloneInvite(record);
}

function cloneInvite(record) {
  return {
    ...record,
    targets: record.targets.map((target) => ({ ...target })),
    acceptedSessions: record.acceptedSessions.map((seat) => ({ ...seat })),
  };
}

/* —— 目标机挂起邀请 —— */

/**
 * @param {{ now?: () => number, capacity?: number }} [options]
 */
export function createPendingInvites({ now = Date.now, capacity = PENDING_INVITE_CAPACITY } = {}) {
  /**
   * @type {{ now: () => number, capacity: number, records: Map<string, PendingRecord>, declines: Map<string, Set<string>>,
   *   counters: { applied: number, duplicates: number, dropped: number, expired: number, withdrawn: number, accepted: number, declined: number } }}
   */
  const state = {
    now: typeof now === 'function' ? now : Date.now,
    capacity: isPositiveInt(capacity) ? capacity : PENDING_INVITE_CAPACITY,
    records: new Map(),
    declines: new Map(),
    counters: { applied: 0, duplicates: 0, dropped: 0, expired: 0, withdrawn: 0, accepted: 0, declined: 0 },
  };
  return {
    applyPendingInvite: (input) => applyPendingInvite(state, input ?? {}),
    matchPendingForSession: (input) => matchPendingForSession(state, input ?? {}),
    consumeForSession: (input) => consumeForSession(state, input ?? {}),
    withdrawPending: (inviteId) => withdrawPending(state, inviteId),
    expirePending: (at) => expirePending(state, at),
    get: (inviteId) => getPending(state, inviteId),
    list: () => [...state.records.values()].map(clonePending),
    stats: () => ({ ...state.counters, size: state.records.size }),
  };
}

/* 登记：唯一键 (inviteId,targetSessionId ?? '')；重复帧只刷新 open 记录的过期时刻，不重开已消费记录。 */
function applyPendingInvite(state, input) {
  const at = clockOf(state, input?.now);
  const parsed = pendingRecordOf(input, at);
  if (parsed === null) {
    return failure('invalid');
  }
  if (parsed === 'expired') {
    return failure('expired');
  }
  const key = pendingKey(parsed.inviteId, parsed.targetSessionId);
  const existing = state.records.get(key);
  if (existing !== undefined) {
    return keepDuplicate(state, parsed, existing);
  }
  const evicted = evictIfFull(state);
  state.records.set(key, parsed);
  state.counters.applied++;
  return { ok: true, inviteId: parsed.inviteId, duplicate: false, state: parsed.state, evicted };
}

function pendingRecordOf(input, at) {
  const ids = pendingIdsOf(input);
  if (ids === null || !isPositiveInt(input?.expiresAt)) {
    return null;
  }
  if (input.expiresAt <= at) {
    return 'expired';
  }
  return { ...ids, expiresAt: input.expiresAt, state: 'open', acceptedSessions: [] };
}

function pendingIdsOf(input) {
  const required = requiredPendingIdsOf(input);
  if (required === null) {
    return null;
  }
  const managerSession = optionalIdOf(input?.fromManager?.sessionId);
  if (managerSession.ok !== true) {
    return null;
  }
  const targetSession = optionalIdOf(input?.targetSessionId);
  if (targetSession.ok !== true) {
    return null;
  }
  return {
    inviteId: required.inviteId,
    collabId: required.collabId,
    fromManager: { instanceId: required.managerInstanceId, sessionId: managerSession.value },
    targetSessionId: targetSession.value,
  };
}

function requiredPendingIdsOf(input) {
  const inviteId = asId(input?.inviteId);
  const collabId = asId(input?.collabId);
  const managerInstanceId = asId(input?.fromManager?.instanceId);
  if (inviteId === null || collabId === null || managerInstanceId === null) {
    return null;
  }
  return { inviteId, collabId, managerInstanceId };
}

function keepDuplicate(state, incoming, existing) {
  state.counters.duplicates++;
  if (existing.state === 'open' && incoming.expiresAt > existing.expiresAt) {
    existing.expiresAt = incoming.expiresAt;
  }
  return { ok: true, inviteId: existing.inviteId, duplicate: true, state: existing.state, evicted: null };
}

/* 容量：淘汰最早过期者（不是最旧插入者），且先腾位再登记——最新一条永远进账，不静默丢新。 */
function evictIfFull(state) {
  if (state.records.size < state.capacity) {
    return null;
  }
  /** @type {string | null} */
  let victimKey = null;
  /** @type {PendingRecord | null} */
  let victim = null;
  for (const [key, record] of state.records) {
    if (victim === null || record.expiresAt < victim.expiresAt) {
      victimKey = key;
      victim = record;
    }
  }
  if (victimKey === null || victim === null) {
    return null;
  }
  state.records.delete(victimKey);
  state.declines.delete(victimKey);
  state.counters.dropped++;
  return victim.inviteId;
}

/* 补投面：指名只看目标会话，不指名对本机全部会话可见；已接受/拒绝/过期/撤回均不再冒泡。 */
function matchPendingForSession(state, input) {
  const sessionId = asId(input?.sessionId);
  const inviteId = optionalIdOf(input?.inviteId);
  const collabId = optionalIdOf(input?.collabId);
  if (sessionId === null || inviteId.ok !== true || collabId.ok !== true) {
    return [];
  }
  const at = clockOf(state, input?.now);
  return [...state.records.values()]
    .filter((record) => pendingVisibleOf(record, sessionId, at, state.declines.get(pendingKey(record.inviteId, record.targetSessionId))))
    .filter((record) => inviteId.value === null || record.inviteId === inviteId.value)
    .filter((record) => collabId.value === null || record.collabId === collabId.value)
    .map(clonePending);
}

function pendingVisibleOf(record, sessionId, at, declines) {
  if (record.state !== 'open' || at >= record.expiresAt) {
    return false;
  }
  if (record.targetSessionId !== null && record.targetSessionId !== sessionId) {
    return false;
  }
  return !record.acceptedSessions.includes(sessionId) && !(declines?.has(sessionId) ?? false);
}

/* 消费：指名记录在接受/拒绝后整条 consumed；不指名记录首 accept 只追加本会话，记录保持 open。 */
function consumeForSession(state, input) {
  const ids = consumeIdsOf(input);
  if (ids === null) {
    return failure('invalid');
  }
  const found = pendingSeatOf(state, ids.inviteId, ids.sessionId);
  if (found.record === null) {
    return failure(found.reason);
  }
  return consumeRecord(state, found.record, ids.sessionId, input);
}

function consumeIdsOf(input) {
  const inviteId = asId(input?.inviteId);
  const sessionId = asId(input?.sessionId);
  if (inviteId === null || sessionId === null) {
    return null;
  }
  return { inviteId, sessionId };
}

function consumeRecord(state, record, sessionId, input) {
  const declined = input?.declined === true;
  const declines = state.declines.get(pendingKey(record.inviteId, record.targetSessionId));
  const decided = decidedOutcomeOf(record, sessionId, declined, declines);
  if (decided !== null) {
    return decided;
  }
  const blocked = consumeBlockOf(state, record, input?.now);
  if (blocked !== null) {
    return blocked;
  }
  return declined ? declineRecord(state, record, sessionId) : acceptRecord(state, record, sessionId);
}

/* 未决定的记录只剩「可消费」与「已过期/非 open」两种去向；过期顺手推进状态，下一轮按 expired 报。 */
function consumeBlockOf(state, record, at) {
  if (record.state !== 'open') {
    return failure(record.state);
  }
  if (clockOf(state, at) < record.expiresAt) {
    return null;
  }
  record.state = 'expired';
  state.counters.expired++;
  return failure('expired');
}

/* 同一 inviteId 可能同时有指名与不指名两条（唯一键不同）：指名的优先，其余会话才落到不指名记录。 */
function pendingSeatOf(state, inviteId, sessionId) {
  let unnamed = null;
  let namedElsewhere = false;
  for (const record of state.records.values()) {
    if (record.inviteId !== inviteId) {
      continue;
    }
    if (record.targetSessionId === sessionId) {
      return { record, reason: 'unknown' };
    }
    if (record.targetSessionId === null) {
      unnamed = record;
    } else {
      namedElsewhere = true;
    }
  }
  return { record: unnamed, reason: namedElsewhere ? 'target-mismatch' : 'unknown' };
}

/* 已决定会话的重复请求：接受/拒绝都幂等返回，反向决定（先拒后接）如实拒绝。
 * 拒绝记录只进内存 declines（不进 pending-invites.json 的冻结形态），用于挡住同一会话的重投。 */
function decidedOutcomeOf(record, sessionId, declined, declines) {
  const refused = declines?.has(sessionId) ?? false;
  if (declined && refused) {
    return { ok: true, inviteId: record.inviteId, declined: true, accepted: false, consumed: record.state === 'consumed', idempotent: true };
  }
  if (!declined && record.acceptedSessions.includes(sessionId)) {
    return { ok: true, inviteId: record.inviteId, accepted: true, declined: false, consumed: record.state === 'consumed', idempotent: true };
  }
  if (record.acceptedSessions.includes(sessionId)) {
    return failure('already-accepted');
  }
  if (refused) {
    return failure('already-declined');
  }
  return null;
}

function acceptRecord(state, record, sessionId) {
  record.acceptedSessions.push(sessionId);
  if (record.targetSessionId !== null) {
    record.state = 'consumed';
  }
  state.counters.accepted++;
  return { ok: true, inviteId: record.inviteId, accepted: true, declined: false, consumed: record.state === 'consumed', idempotent: false };
}

function declineRecord(state, record, sessionId) {
  rememberPendingDecline(state, record, sessionId);
  if (record.targetSessionId !== null) {
    record.state = 'consumed';
  }
  state.counters.declined++;
  return { ok: true, inviteId: record.inviteId, accepted: false, declined: true, consumed: record.state === 'consumed', idempotent: false };
}

function rememberPendingDecline(state, record, sessionId) {
  const key = pendingKey(record.inviteId, record.targetSessionId);
  const held = state.declines.get(key);
  if (held === undefined) {
    state.declines.set(key, new Set([sessionId]));
    return;
  }
  held.add(sessionId);
}

/* 撤回：open 记录全部置 withdrawn（同 inviteId 的指名/不指名条目一并停投）；未知记录按已撤回幂等处理。 */
function withdrawPending(state, inviteId) {
  const id = asId(inviteId);
  if (id === null) {
    return failure('invalid');
  }
  let withdrawn = 0;
  for (const record of state.records.values()) {
    if (record.inviteId !== id || record.state !== 'open') {
      continue;
    }
    record.state = 'withdrawn';
    state.declines.delete(pendingKey(record.inviteId, record.targetSessionId));
    withdrawn++;
  }
  state.counters.withdrawn += withdrawn;
  return { ok: true, withdrawn };
}

/* 过期：只推进 open 记录（已消费/已撤回保留原状态供观察窗解释去向）。 */
function expirePending(state, at) {
  const now = clockOf(state, at);
  const inviteIds = [];
  for (const record of state.records.values()) {
    if (record.state !== 'open' || now < record.expiresAt) {
      continue;
    }
    record.state = 'expired';
    state.declines.delete(pendingKey(record.inviteId, record.targetSessionId));
    inviteIds.push(record.inviteId);
  }
  state.counters.expired += inviteIds.length;
  return { expired: inviteIds.length, inviteIds };
}

function getPending(state, inviteId) {
  const id = asId(inviteId);
  if (id === null) {
    return null;
  }
  for (const record of state.records.values()) {
    if (record.inviteId === id) {
      return clonePending(record);
    }
  }
  return null;
}

function clonePending(record) {
  return {
    ...record,
    fromManager: { ...record.fromManager },
    acceptedSessions: [...record.acceptedSessions],
  };
}

function pendingKey(inviteId, targetSessionId) {
  return `${inviteId}\u0000${targetSessionId ?? ''}`;
}

/* —— 两段式入席（站长侧 joining 台账） —— */

/**
 * @param {{ now?: () => number, joiningTtlMs?: number, maxJoining?: number, maxActiveSeats?: number }} [options]
 */
export function createJoiningRegistry({
  now = Date.now,
  joiningTtlMs = JOINING_TTL_MS,
  maxJoining = MAX_JOINING,
  maxActiveSeats = MAX_ACTIVE_SEATS,
} = {}) {
  /**
   * @type {{ now: () => number, joiningTtlMs: number, maxJoining: number, maxActiveSeats: number,
   *   byJoinId: Map<string, JoiningRecord>, byKey: Map<string, string>,
   *   counters: { begun: number, reused: number, confirmed: number, aborted: number, expired: number } }}
   */
  const state = {
    now: typeof now === 'function' ? now : Date.now,
    joiningTtlMs: isPositiveInt(joiningTtlMs) ? joiningTtlMs : JOINING_TTL_MS,
    maxJoining: isPositiveInt(maxJoining) ? maxJoining : MAX_JOINING,
    maxActiveSeats: isPositiveInt(maxActiveSeats) ? maxActiveSeats : MAX_ACTIVE_SEATS,
    byJoinId: new Map(),
    byKey: new Map(),
    counters: { begun: 0, reused: 0, confirmed: 0, aborted: 0, expired: 0 },
  };
  return {
    beginJoining: (input) => beginJoining(state, input ?? {}),
    confirmJoining: (joinId, sessionId, input) => confirmJoining(state, joinId, sessionId, input ?? {}),
    abortJoining: (joinId, reason) => abortJoining(state, joinId, reason),
    expireJoining: (at) => expireJoining(state, at),
    invalidateForManagerChange: (managerTerm) => invalidateForManagerChange(state, managerTerm),
    get: (joinId) => cloneJoiningOrNull(joiningOf(state, joinId)),
    find: (collabId, sessionId) => findJoining(state, collabId, sessionId),
    list: () => [...state.byJoinId.values()].map(cloneJoining),
    stats: () => ({ ...state.counters, size: state.byJoinId.size }),
  };
}

/* 发 grant：写 joining 前先查活跃席位容量；同 (collabId,sessionId) 已有记录则复用并换新 joinId（旧 joinId 立即失效）。 */
function beginJoining(state, input) {
  const prepared = beginInputOf(input);
  if (prepared === null) {
    return failure('invalid');
  }
  const at = clockOf(state, input?.now);
  const joinId = state.byKey.get(joinKey(prepared.collabId, prepared.sessionId));
  if (joinId !== undefined) {
    return refreshJoining(state, joinId, prepared, at);
  }
  if (prepared.activeSeats >= state.maxActiveSeats) {
    return failure('capacity');
  }
  if (unconfirmedCount(state) >= state.maxJoining) {
    return failure('capacity');
  }
  return createJoining(state, prepared, at);
}

function beginInputOf(input) {
  const ids = beginIdsOf(input);
  if (ids === null) {
    return null;
  }
  if (!isPositiveInt(input?.managerTerm) || !isPositiveInt(input?.grantVersion)) {
    return null;
  }
  const activeSeats = activeSeatsOf(input?.activeSeats);
  return activeSeats === null ? null : { ...ids, managerTerm: input.managerTerm, grantVersion: input.grantVersion, activeSeats };
}

function beginIdsOf(input) {
  const collabId = asId(input?.collabId);
  const instanceId = asId(input?.instanceId);
  const sessionId = asId(input?.sessionId);
  if (collabId === null || instanceId === null || sessionId === null) {
    return null;
  }
  return { collabId, instanceId, sessionId };
}

function activeSeatsOf(value) {
  const activeSeats = value === undefined ? 0 : value;
  return Number.isInteger(activeSeats) && activeSeats >= 0 ? activeSeats : null;
}

function refreshJoining(state, joinId, prepared, at) {
  const held = state.byJoinId.get(joinId);
  if (held === undefined) {
    state.byKey.delete(joinKey(prepared.collabId, prepared.sessionId));
    return createJoining(state, prepared, at);
  }
  if (held.confirmed) {
    return failure('already-member');
  }
  if (prepared.activeSeats >= state.maxActiveSeats) {
    return failure('capacity');
  }
  removeJoining(state, joinId, held);
  const created = createJoining(state, prepared, at);
  state.counters.reused++;
  return { ...created, reused: true, previousJoinId: joinId };
}

function createJoining(state, prepared, at) {
  const joinId = `join-${randomUUID()}`;
  /** @type {JoiningRecord} */
  const record = {
    joinId,
    collabId: prepared.collabId,
    instanceId: prepared.instanceId,
    sessionId: prepared.sessionId,
    managerTerm: prepared.managerTerm,
    grantVersion: prepared.grantVersion,
    requestedAt: at,
    expiresAt: at + state.joiningTtlMs,
    confirmed: false,
    confirmedAt: null,
  };
  state.byJoinId.set(joinId, record);
  state.byKey.set(joinKey(record.collabId, record.sessionId), joinId);
  state.counters.begun++;
  return { ok: true, joinId, expiresAt: record.expiresAt, reused: false };
}

/* confirm：先幂等（已确认即 member），再验会话/过期/managerTerm；grantVersion 仅记录，version 推进不影响受理。 */
function confirmJoining(state, joinId, sessionId, input) {
  const record = joiningOf(state, joinId);
  if (record === undefined) {
    return failure('unknown');
  }
  const session = asId(sessionId);
  if (session === null) {
    return failure('invalid');
  }
  if (record.sessionId !== session) {
    return failure('session-mismatch');
  }
  const settled = settledConfirmOf(record, joinId);
  if (settled !== null) {
    return settled;
  }
  const blocked = confirmBlockOf(state, record, input);
  return blocked === null ? markConfirmed(state, record, input?.now) : blocked;
}

function settledConfirmOf(record, joinId) {
  return record.confirmed
    ? { ok: true, member: true, joinId, idempotent: true, joinedAt: record.confirmedAt }
    : null;
}

/* confirm 的拒绝面：过期（顺手删记录）、managerTerm 不符、活跃席位容量不足；失败一律保留 joining。 */
function confirmBlockOf(state, record, input) {
  const at = clockOf(state, input?.now);
  if (at >= record.expiresAt) {
    removeJoining(state, record.joinId, record);
    state.counters.expired++;
    return failure('expired');
  }
  const term = confirmTermOf(record, input?.managerTerm);
  if (term !== null) {
    return term;
  }
  const activeSeats = activeSeatsOf(input?.activeSeats);
  if (activeSeats === null) {
    return failure('invalid');
  }
  return activeSeats >= state.maxActiveSeats ? failure('capacity') : null;
}

function markConfirmed(state, record, at) {
  const now = clockOf(state, at);
  record.confirmed = true;
  record.confirmedAt = now;
  state.counters.confirmed++;
  return { ok: true, member: true, joinId: record.joinId, idempotent: false, joinedAt: now };
}

function confirmTermOf(record, managerTerm) {
  if (managerTerm === undefined) {
    return null;
  }
  if (!isPositiveInt(managerTerm)) {
    return failure('invalid');
  }
  return managerTerm === record.managerTerm ? null : failure('manager-changed');
}

/* abort：申请人收到 join-deny 后的回滚；已确认（已入名单）的席位不可由 abort 撤销。 */
function abortJoining(state, joinId, reason = 'aborted') {
  const record = joiningOf(state, joinId);
  if (record === undefined) {
    return failure('unknown');
  }
  if (record.confirmed) {
    return failure('already-member');
  }
  removeJoining(state, joinId, record);
  state.counters.aborted++;
  return { ok: true, joinId, reason: typeof reason === 'string' && reason !== '' ? reason : 'aborted', removed: true };
}

/* 超时清理：只清未确认记录；已确认席位是成员事实，跨 TTL 保留。 */
function expireJoining(state, at) {
  const now = clockOf(state, at);
  const joinIds = [];
  for (const [joinId, record] of state.byJoinId) {
    if (record.confirmed || now < record.expiresAt) {
      continue;
    }
    removeJoining(state, joinId, record);
    joinIds.push(joinId);
  }
  state.counters.expired += joinIds.length;
  return { expired: joinIds.length, joinIds };
}

/* 站长更替：未确认 grant 全部作废（给了新 term 时只清旧 term 的），已确认席位保留。 */
function invalidateForManagerChange(state, managerTerm) {
  const term = managerTerm === undefined || managerTerm === null ? null : managerTerm;
  if (term !== null && !isPositiveInt(term)) {
    return failure('invalid');
  }
  const aborted = [];
  const kept = [];
  for (const [joinId, record] of state.byJoinId) {
    if (record.confirmed) {
      kept.push(joinId);
      continue;
    }
    if (term !== null && record.managerTerm >= term) {
      continue;
    }
    removeJoining(state, joinId, record);
    aborted.push(joinId);
  }
  state.counters.aborted += aborted.length;
  return { ok: true, aborted, kept };
}

function joiningOf(state, joinId) {
  return typeof joinId === 'string' ? state.byJoinId.get(joinId) : undefined;
}

function findJoining(state, collabId, sessionId) {
  const collab = asId(collabId);
  const session = asId(sessionId);
  if (collab === null || session === null) {
    return null;
  }
  const joinId = state.byKey.get(joinKey(collab, session));
  const record = joinId === undefined ? undefined : state.byJoinId.get(joinId);
  return record === undefined ? null : cloneJoining(record);
}

function removeJoining(state, joinId, record) {
  state.byJoinId.delete(joinId);
  state.byKey.delete(joinKey(record.collabId, record.sessionId));
}

function unconfirmedCount(state) {
  let count = 0;
  for (const record of state.byJoinId.values()) {
    if (!record.confirmed) {
      count++;
    }
  }
  return count;
}

function joinKey(collabId, sessionId) {
  return `${collabId}\u0000${sessionId}`;
}

function cloneJoiningOrNull(record) {
  return record === undefined ? null : cloneJoining(record);
}

function cloneJoining(record) {
  return { ...record };
}
