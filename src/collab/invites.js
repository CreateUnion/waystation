import { randomUUID } from 'node:crypto';
import { ID_PATTERN, MAX_ACTIVE_SEATS } from '../net/protocol.js';
import { matchSessionByToken } from '../util/short-id.js';

/* 邀请与两段式入席的纯内存簿记（设计 §4.1–§4.4）。
 * 三本账各管一段：发起侧 invites（谁被邀请、谁已接受/拒绝）、目标机 pending invites（未入席会话的补投依据）、
 * 站长侧 joining（已发 grant、待 confirm 的席位）。本模块只做状态判定与去重，不写盘、不发帧、不读服务层：
 * 持久化与网络投递由接线方按返回的 reason 决定，判定逻辑因此可在 PC 上单测。
 * 时间一律经注入时钟推进（调用参数可覆盖），过期判定与容量淘汰因此确定可复现。
 * 作用域：每协作一个实例（invites.json / pending-invites.json / joins.json 位于协作目录），不得跨协作复用；
 * invites/pending 的唯一键不含 collabId，joining 的席位键含 collabId（同 sessionId 在不同协作各自成 grant）；
 * 入口的 collabId 校验只是串台防线，不是复用支持。
 * 返回的 reason 是模块内部词表；只有 JOIN_DENY_REASONS 可直接进 join-deny，其余按接线语义转成快照/本地错误
 * （joinDenyReasonOf 只做兜底映射；already-member 须由接线回快照，不得当 deny 投递，见设计 §4.4.6）。 */

export const PENDING_INVITE_CAPACITY = 64;
export const JOINING_TTL_MS = 60000;
/* 在途入席不超过活跃席位硬顶：joining 不占活跃席位，但未确认记录也不得无界堆积。 */
export const MAX_JOINING = MAX_ACTIVE_SEATS;

/* join-deny 的协议词表；单一权威在协议层校验器，本表与之逐字一致，测试用真帧交叉核验。 */
export const JOIN_DENY_REASONS = ['expired', 'aborted', 'manager-changed', 'capacity'];

export function joinDenyReasonOf(reason) {
  return JOIN_DENY_REASONS.includes(reason) ? reason : 'aborted';
}

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

const INVITE_STATES = ['open', 'closed', 'withdrawn'];
const PENDING_STATES = ['open', 'consumed', 'expired', 'withdrawn'];

function failure(reason) {
  return { ok: false, reason };
}

function isPlainRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value) ? value : null;
}

function isTimestamp(value) {
  return Number.isInteger(value) && value >= 0;
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

/* restore(records)：records 为 invites.json 的 invites 数组（设计 §4.1 形态）。 */
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
    restore: (records) => restoreInvites(state, records),
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
  const usable = sameMachine.find((target) => target.targetSessionId === undefined || targetSessionIdMatches(target.targetSessionId, seat.sessionId));
  return usable === undefined ? 'session-mismatch' : usable;
}

/* 指名目标与会话的全等比较：目标可能记的是短码（用户从列表取到的 8 位表示），按短码精确匹配；
 * 完整标识按全等；歧义（同短码多候选）与非法输入由 matchSessionByToken 返回 null（拒绝）。 */
function targetSessionIdMatches(targetSessionId, sessionId) {
  return matchSessionByToken([{ sessionId }], targetSessionId) === sessionId;
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

/* 重启恢复：整表替换（先全部校验再落内存，坏档不留半份账）；重复 inviteId 视为坏条丢弃并计数。
 * 会话级拒绝只存内存（冻结形态不含该字段），恢复后不恢复——指名邀请仍因 closed 不可再接受，
 * 不指名邀请允许重投后由该会话重新决定。 */
function restoreInvites(state, records) {
  if (!Array.isArray(records)) {
    return failure('invalid');
  }
  const restored = new Map();
  let rejected = 0;
  for (const raw of records) {
    const record = restoredInviteOf(raw);
    if (record === null || restored.has(record.inviteId)) {
      rejected++;
      continue;
    }
    restored.set(record.inviteId, record);
  }
  state.records = restored;
  state.declines.clear();
  return { ok: true, restored: restored.size, rejected };
}

function restoredInviteOf(raw) {
  if (!isPlainRecord(raw)) {
    return null;
  }
  const inviteId = asId(raw.inviteId);
  const targets = restoredTargetsOf(raw.targets);
  if (inviteId === null || targets === null) {
    return null;
  }
  if (!isTimestamp(raw.createdAt) || !isTimestamp(raw.expiresAt) || raw.expiresAt < raw.createdAt) {
    return null;
  }
  const acceptedSessions = restoredSeatListOf(raw.acceptedSessions);
  if (acceptedSessions === null || !INVITE_STATES.includes(raw.state)) {
    return null;
  }
  return { inviteId, targets, createdAt: raw.createdAt, expiresAt: raw.expiresAt, state: raw.state, acceptedSessions };
}

function restoredTargetsOf(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_ACTIVE_SEATS) {
    return null;
  }
  const targets = [];
  for (const target of raw) {
    if (!isPlainRecord(target)) {
      return null;
    }
    const instanceId = asId(target.instanceId);
    const session = optionalIdOf(target.targetSessionId);
    if (instanceId === null || session.ok !== true) {
      return null;
    }
    targets.push(session.value === null ? { instanceId } : { instanceId, targetSessionId: session.value });
  }
  return targets;
}

function restoredSeatListOf(raw) {
  if (!Array.isArray(raw)) {
    return null;
  }
  const seats = [];
  for (const entry of raw) {
    const seat = seatOf(entry);
    if (seat === null) {
      return null;
    }
    seats.push(seat);
  }
  return seats;
}

/* —— 目标机挂起邀请 —— */

/* restore(records,{capacity?})：records 为 pending-invites.json 的 invites 数组；超容量按淘汰策略裁剪。 */
/**
 * @param {{ now?: () => number, capacity?: number }} [options]
 */
export function createPendingInvites({ now = Date.now, capacity = PENDING_INVITE_CAPACITY } = {}) {
  /**
   * @type {{ now: () => number, capacity: number, records: Map<string, PendingRecord>, declines: Map<string, Set<string>>,
   *   counters: { applied: number, duplicates: number, dropped: number, reclaimed: number, pruned: number, expired: number, withdrawn: number, accepted: number, declined: number } }}
   */
  const state = {
    now: typeof now === 'function' ? now : Date.now,
    capacity: isPositiveInt(capacity) ? capacity : PENDING_INVITE_CAPACITY,
    records: new Map(),
    declines: new Map(),
    counters: { applied: 0, duplicates: 0, dropped: 0, reclaimed: 0, pruned: 0, expired: 0, withdrawn: 0, accepted: 0, declined: 0 },
  };
  return {
    applyPendingInvite: (input) => applyPendingInvite(state, input ?? {}),
    matchPendingForSession: (input) => matchPendingForSession(state, input ?? {}),
    consumeForSession: (input) => consumeForSession(state, input ?? {}),
    declineForSession: (input) => declineForSession(state, input ?? {}),
    withdrawPending: (input) => withdrawPending(state, input ?? {}),
    expirePending: (at) => expirePending(state, at),
    pruneTerminal: (at) => pruneTerminalPending(state, at),
    restore: (records, options) => restorePending(state, records, options ?? {}),
    get: (input) => getPending(state, input ?? {}),
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
  return {
    ok: true,
    inviteId: parsed.inviteId,
    duplicate: false,
    state: parsed.state,
    evicted: evicted === null ? null : evicted.inviteId,
    evictedState: evicted === null ? null : evicted.state,
    evictedCount: evicted === null ? 0 : evicted.evictedCount,
  };
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
  return { ok: true, inviteId: existing.inviteId, duplicate: true, state: existing.state, evicted: null, evictedState: null, evictedCount: 0 };
}

/* 容量：先回收终态记录（expired/consumed/withdrawn），全部终态清空后才淘汰 open 中最早过期者。
 * 这样死记录不会挤掉仍在 TTL 内的有效邀请；丢 open 邀请才计 dropped，回收终态只计 reclaimed。
 * 循环到 size < capacity，超限恢复后的账也能在一次写入时收敛回上限。 */
function evictIfFull(state) {
  /** @type {{ inviteId: string, state: PendingState } | null} */
  let last = null;
  let evictedCount = 0;
  while (state.records.size >= state.capacity) {
    const victim = evictionVictimOf(state);
    if (victim === null) {
      break;
    }
    state.records.delete(victim.key);
    state.declines.delete(victim.key);
    if (victim.record.state === 'open') {
      state.counters.dropped++;
    } else {
      state.counters.reclaimed++;
    }
    last = { inviteId: victim.record.inviteId, state: victim.record.state };
    evictedCount++;
  }
  return last === null ? null : { ...last, evictedCount };
}

/**
 * @param {{ records: Map<string, PendingRecord> }} state
 * @returns {{ key: string, record: PendingRecord } | null}
 */
function evictionVictimOf(state) {
  /** @type {{ key: string, record: PendingRecord } | null} */
  let terminal = null;
  /** @type {{ key: string, record: PendingRecord } | null} */
  let open = null;
  for (const [key, record] of state.records) {
    if (record.state === 'open') {
      open = earlierExpiryOf(open, key, record);
      continue;
    }
    terminal = earlierExpiryOf(terminal, key, record);
  }
  return terminal ?? open;
}

/**
 * @param {{ key: string, record: PendingRecord } | null} held
 * @param {string} key
 * @param {PendingRecord} record
 * @returns {{ key: string, record: PendingRecord }}
 */
function earlierExpiryOf(held, key, record) {
  if (held === null || record.expiresAt < held.record.expiresAt) {
    return { key, record };
  }
  return held;
}

/* 补投面：指名只看目标会话，不指名对本机全部会话可见；已接受/拒绝/过期/撤回均不再冒泡。
 * collabId 必填（每协作一 store 的显式声明）：不传即返回空，避免调用方误把跨协作记录补投出去。 */
function matchPendingForSession(state, input) {
  const sessionId = asId(input?.sessionId);
  const collabId = asId(input?.collabId);
  const inviteId = optionalIdOf(input?.inviteId);
  if (sessionId === null || collabId === null || inviteId.ok !== true) {
    return [];
  }
  const at = clockOf(state, input?.now);
  return [...state.records.values()]
    .filter((record) => record.collabId === collabId)
    .filter((record) => pendingVisibleOf(record, sessionId, at, state.declines.get(pendingKey(record.inviteId, record.targetSessionId))))
    .filter((record) => inviteId.value === null || record.inviteId === inviteId.value)
    .map(clonePending);
}

function pendingVisibleOf(record, sessionId, at, declines) {
  if (record.state !== 'open' || at >= record.expiresAt) {
    return false;
  }
  if (record.targetSessionId !== null && !targetSessionIdMatches(record.targetSessionId, sessionId)) {
    return false;
  }
  return !record.acceptedSessions.includes(sessionId) && !(declines?.has(sessionId) ?? false);
}

/* 消费：指名记录在接受/拒绝后整条 consumed；不指名记录首 accept 只追加本会话，记录保持 open。
 * 消费必须同时给 collabId：同机一个 store 若跨协作复用，仅凭 inviteId 会串台。 */
function consumeForSession(state, input) {
  const ids = consumeIdsOf(input);
  if (ids === null) {
    return failure('invalid');
  }
  const flagged = declinedFlagOf(input?.declined);
  if (flagged.ok !== true) {
    return failure('invalid');
  }
  const found = pendingSeatOf(state, ids.collabId, ids.inviteId, ids.sessionId);
  if (found.record === null) {
    return failure(found.reason);
  }
  return consumeRecord(state, found.record, ids.sessionId, flagged.value, input?.now);
}

/* 会话级拒绝（设计 §4.3「拒绝 = 本条不参与」）：判定次序与 consumeForSession(declined:true) 完全一致
 * （过期 → 已决定 → 记录状态），复用同一 declined 账与消费语义——指名记录整条 consumed、不指名记录
 * 只挡本会话。reason 只供接线方组 decline 帧，本模块不落账。 */
function declineForSession(state, input) {
  const ids = consumeIdsOf(input);
  if (ids === null) {
    return failure('invalid');
  }
  const found = pendingSeatOf(state, ids.collabId, ids.inviteId, ids.sessionId);
  if (found.record === null) {
    return failure(found.reason);
  }
  return consumeRecord(state, found.record, ids.sessionId, true, input?.now);
}

function consumeIdsOf(input) {
  const collabId = asId(input?.collabId);
  const inviteId = asId(input?.inviteId);
  const sessionId = asId(input?.sessionId);
  if (collabId === null || inviteId === null || sessionId === null) {
    return null;
  }
  return { collabId, inviteId, sessionId };
}

/* declined 只接受布尔或缺省；'yes' / 1 之类误传必须报错，不能落进 accept 分支。 */
function declinedFlagOf(value) {
  if (value === undefined) {
    return { ok: true, value: false };
  }
  return typeof value === 'boolean' ? { ok: true, value } : { ok: false };
}

/* 过期优先于幂等返回：open 邀请过 TTL 后，即便该会话曾接受过，也按 expired 报（不得让接线误判仍可入席）。 */
function consumeRecord(state, record, sessionId, declined, at) {
  if (record.state === 'open' && clockOf(state, at) >= record.expiresAt) {
    record.state = 'expired';
    state.counters.expired++;
    return failure('expired');
  }
  const declines = state.declines.get(pendingKey(record.inviteId, record.targetSessionId));
  const decided = decidedOutcomeOf(record, sessionId, declined, declines);
  if (decided !== null) {
    return decided;
  }
  if (record.state !== 'open') {
    return failure(record.state);
  }
  return declined ? declineRecord(state, record, sessionId) : acceptRecord(state, record, sessionId);
}

/* 同一 inviteId 可能同时有指名与不指名两条（唯一键不同）：指名的优先，其余会话才落到不指名记录。
 * 只认请求协作名下的记录；同 inviteId 只在别的协作存在时回 collab-mismatch。 */
function pendingSeatOf(state, collabId, inviteId, sessionId) {
  let unnamed = null;
  let namedElsewhere = false;
  let seen = false;
  let matchedCollab = false;
  for (const record of state.records.values()) {
    if (record.inviteId !== inviteId) {
      continue;
    }
    seen = true;
    if (record.collabId !== collabId) {
      continue;
    }
    matchedCollab = true;
    if (record.targetSessionId !== null && targetSessionIdMatches(record.targetSessionId, sessionId)) {
      return { record, reason: 'unknown' };
    }
    if (record.targetSessionId === null) {
      unnamed = record;
    } else {
      namedElsewhere = true;
    }
  }
  return { record: unnamed, reason: seatMissReasonOf(namedElsewhere, matchedCollab, seen) };
}

function seatMissReasonOf(namedElsewhere, matchedCollab, seen) {
  if (namedElsewhere) {
    return 'target-mismatch';
  }
  return matchedCollab || !seen ? 'unknown' : 'collab-mismatch';
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

/* 撤回：open 记录全部置 withdrawn（同协作同 inviteId 的指名/不指名条目一并停投）。
 * 必须同时给 collabId：同 inviteId 只在别的协作存在时回 collab-mismatch，不跨协作撤回。 */
function withdrawPending(state, input) {
  const collabId = asId(input?.collabId);
  const inviteId = asId(input?.inviteId);
  if (collabId === null || inviteId === null) {
    return failure('invalid');
  }
  const matched = pendingRecordsOf(state, collabId, inviteId);
  if (matched === null) {
    return failure('collab-mismatch');
  }
  let withdrawn = 0;
  for (const record of matched) {
    if (record.state !== 'open') {
      continue;
    }
    record.state = 'withdrawn';
    state.declines.delete(pendingKey(record.inviteId, record.targetSessionId));
    withdrawn++;
  }
  state.counters.withdrawn += withdrawn;
  return { ok: true, withdrawn };
}

/* 按协作取同 inviteId 的记录；inviteId 完全不存在返回空数组，只在别的协作存在返回 null。 */
function pendingRecordsOf(state, collabId, inviteId) {
  const matched = [];
  let seen = false;
  for (const record of state.records.values()) {
    if (record.inviteId !== inviteId) {
      continue;
    }
    seen = true;
    if (record.collabId === collabId) {
      matched.push(record);
    }
  }
  return matched.length === 0 && seen ? null : matched;
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

function getPending(state, input) {
  const collabId = asId(input?.collabId);
  const inviteId = asId(input?.inviteId);
  if (collabId === null || inviteId === null) {
    return null;
  }
  const matched = pendingRecordsOf(state, collabId, inviteId);
  return matched === null || matched.length === 0 ? null : clonePending(matched[0]);
}

/* 终态清理：TTL 已过的终态记录（expired/consumed/withdrawn）可删，供接线按保留策略周期调用。
 * 默认保留（expirePending 只改状态）是为了观察窗能解释「邀请去过哪」，容量面由 evictIfFull 优先回收终态。 */
function pruneTerminalPending(state, at) {
  const now = clockOf(state, at);
  const inviteIds = [];
  for (const [key, record] of state.records) {
    if (record.state === 'open' || now < record.expiresAt) {
      continue;
    }
    state.records.delete(key);
    state.declines.delete(key);
    inviteIds.push(record.inviteId);
  }
  state.counters.pruned += inviteIds.length;
  return { pruned: inviteIds.length, inviteIds };
}

/* 重启恢复：整表替换；状态与 acceptedSessions 原样恢复，会话级拒绝不持久化（见 invites restore 说明）。
 * 文件可能被旧版本/手工编辑成超容量：按同一「终态优先、再最早过期」策略裁回选项上限，超出部分计入 rejected。
 * options.capacity 只作本次恢复的裁剪上限，不写回运行期容量：调用方传入的是一次性限制，
 * 写回会让后续 apply 永久按更小的上限淘汰。 */
function restorePending(state, records, options) {
  if (!Array.isArray(records)) {
    return failure('invalid');
  }
  const limit = isPositiveInt(options?.capacity) ? options.capacity : state.capacity;
  const restored = new Map();
  let rejected = 0;
  for (const raw of records) {
    const record = restoredPendingOf(raw);
    const key = record === null ? null : pendingKey(record.inviteId, record.targetSessionId);
    if (record === null || key === null || restored.has(key)) {
      rejected++;
      continue;
    }
    restored.set(key, record);
  }
  rejected += trimPendingRestored(state, restored, limit);
  state.records = restored;
  state.declines.clear();
  return { ok: true, restored: restored.size, rejected };
}

function trimPendingRestored(state, records, limit) {
  let trimmed = 0;
  while (records.size > limit) {
    const victim = evictionVictimOf({ records });
    if (victim === null) {
      break;
    }
    records.delete(victim.key);
    if (victim.record.state === 'open') {
      state.counters.dropped++;
    } else {
      state.counters.reclaimed++;
    }
    trimmed++;
  }
  return trimmed;
}

function restoredPendingOf(raw) {
  if (!isPlainRecord(raw)) {
    return null;
  }
  const base = restoredPendingBaseOf(raw);
  const acceptedSessions = restoredSessionListOf(raw.acceptedSessions);
  if (base === null || acceptedSessions === null) {
    return null;
  }
  if (!isTimestamp(raw.expiresAt) || !PENDING_STATES.includes(raw.state)) {
    return null;
  }
  return { ...base, expiresAt: raw.expiresAt, state: raw.state, acceptedSessions };
}

function restoredPendingBaseOf(raw) {
  const inviteId = asId(raw.inviteId);
  const collabId = asId(raw.collabId);
  const managerInstanceId = asId(raw.fromManager?.instanceId);
  if (inviteId === null || collabId === null || managerInstanceId === null) {
    return null;
  }
  const managerSession = optionalIdOf(raw.fromManager?.sessionId);
  if (managerSession.ok !== true) {
    return null;
  }
  const targetSession = optionalIdOf(raw.targetSessionId);
  if (targetSession.ok !== true) {
    return null;
  }
  return {
    inviteId,
    collabId,
    fromManager: { instanceId: managerInstanceId, sessionId: managerSession.value },
    targetSessionId: targetSession.value,
  };
}

function restoredSessionListOf(raw) {
  if (!Array.isArray(raw)) {
    return null;
  }
  const sessions = [];
  for (const sessionId of raw) {
    const id = asId(sessionId);
    if (id === null) {
      return null;
    }
    sessions.push(id);
  }
  return sessions;
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

/* restore(records,{collabId,maxJoining?})：records 为 joins.json 的 pendingJoins（仅未确认）。
 * pendingJoins() 是反向投影（只含未确认、无 collabId/confirmed 字段），供接线原样写盘。 */
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
   *   counters: { begun: number, reused: number, confirmed: number, unconfirmed: number, aborted: number, expired: number } }}
   */
  const state = {
    now: typeof now === 'function' ? now : Date.now,
    joiningTtlMs: isPositiveInt(joiningTtlMs) ? joiningTtlMs : JOINING_TTL_MS,
    maxJoining: isPositiveInt(maxJoining) ? maxJoining : MAX_JOINING,
    maxActiveSeats: isPositiveInt(maxActiveSeats) ? maxActiveSeats : MAX_ACTIVE_SEATS,
    byJoinId: new Map(),
    byKey: new Map(),
    counters: { begun: 0, reused: 0, confirmed: 0, unconfirmed: 0, aborted: 0, expired: 0 },
  };
  return {
    beginJoining: (input) => beginJoining(state, input ?? {}),
    confirmJoining: (joinId, sessionId, input) => confirmJoining(state, joinId, sessionId, input ?? {}),
    unconfirmJoining: (joinId) => unconfirmJoining(state, joinId),
    abortJoining: (joinId, reason) => abortJoining(state, joinId, reason),
    releaseJoining: (collabId, sessionId) => releaseJoining(state, collabId, sessionId),
    expireJoining: (at) => expireJoining(state, at),
    invalidateForManagerChange: (managerTerm) => invalidateForManagerChange(state, managerTerm),
    pendingJoins: () => [...state.byJoinId.values()].filter((record) => !record.confirmed).map(joiningPersistOf),
    restore: (records, options) => restoreJoining(state, records, options ?? {}),
    get: (joinId) => cloneJoiningOrNull(joiningOf(state, joinId)),
    find: (collabId, sessionId) => findJoining(state, collabId, sessionId),
    list: () => [...state.byJoinId.values()].map(cloneJoining),
    stats: () => ({ ...state.counters, size: state.byJoinId.size }),
  };
}

/* 发 grant：写 joining 前先查活跃席位容量。同 (collabId,sessionId) 已有记录时仅同实例可刷新并换新 joinId；
 * 另一实例用同 sessionId 申请不得覆盖他人 grant（返回 instance-mismatch），避免跨实例 DoS。
 * 已在共享名单的会话由接线在调用前短路（返回既有席位）；joins.json 只恢复未确认记录。 */
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
  return createWithinCapacity(state, prepared, at);
}

/* 新建 joining 的两处容量检查（begin 与 refresh 的失配兜底共用）：activeSeats 为共享名单当前活跃席位
 * （不含本席），必填，缺省即 invalid。 */
function createWithinCapacity(state, prepared, at) {
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

/* activeSeats 是容量判定的唯一输入，必须由接线显式取共享名单当前活跃席位数（不含本席）；
 * 缺省即 invalid（fail-closed）。 */
function activeSeatsOf(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function refreshJoining(state, joinId, prepared, at) {
  const held = state.byJoinId.get(joinId);
  if (held === undefined) {
    state.byKey.delete(joinKey(prepared.collabId, prepared.sessionId));
    return createWithinCapacity(state, prepared, at);
  }
  if (held.instanceId !== prepared.instanceId) {
    return failure('instance-mismatch');
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

/* confirm：校验席位键两半（instanceId+sessionId）与必填 managerTerm；已确认即幂等 member。
 * grantVersion 仅记录、version 推进不影响受理（设计 §4.4.7 版本校验口径）。
 * activeSeats 口径＝共享名单当前活跃席位数，**不含本席**（本席确认后才入名单）；必填，缺省即 invalid。
 * 顺序：confirmJoining → 写共享名单 → 失败 unconfirmJoining → 重试；幂等 member:true 时由接线重做名单写入。
 * alreadyMember=true 表示名单已含本席（崩溃后重放），跳过容量与过期检查，但实例/会话/term 仍校验。 */
function confirmJoining(state, joinId, sessionId, input) {
  const record = joiningOf(state, joinId);
  if (record === undefined) {
    return failure('unknown');
  }
  const pre = confirmPreconditionOf(record, sessionId, input);
  if (pre.ok !== true) {
    return pre;
  }
  const settled = settledConfirmOf(record, joinId);
  if (settled !== null) {
    return settled;
  }
  const blocked = confirmBlockOf(state, record, input, pre.alreadyMember);
  return blocked === null ? markConfirmed(state, record, input?.now) : blocked;
}

/* 确认前的必填面：席位键两半、managerTerm（形态与任期相等，幂等路径同样复核）、alreadyMember 布尔。 */
function confirmPreconditionOf(record, sessionId, input) {
  const identity = confirmIdentityOf(record, sessionId, input?.instanceId);
  if (identity.ok !== true) {
    return identity;
  }
  if (!isPositiveInt(input?.managerTerm)) {
    return failure('invalid');
  }
  if (input.managerTerm !== record.managerTerm) {
    return failure('manager-changed');
  }
  const alreadyMember = alreadyMemberFlagOf(input?.alreadyMember);
  return alreadyMember.ok === true
    ? { ok: true, alreadyMember: alreadyMember.value }
    : failure('invalid');
}

/* 席位键两半都要比：同 sessionId 跨机器不得确认他人的 grant。 */
function confirmIdentityOf(record, sessionId, instanceId) {
  const seat = seatOf({ instanceId, sessionId });
  if (seat === null) {
    return failure('invalid');
  }
  if (record.instanceId !== seat.instanceId) {
    return failure('instance-mismatch');
  }
  if (record.sessionId !== seat.sessionId) {
    return failure('session-mismatch');
  }
  return { ok: true };
}

function alreadyMemberFlagOf(value) {
  if (value === undefined) {
    return { ok: true, value: false };
  }
  return typeof value === 'boolean' ? { ok: true, value } : { ok: false };
}

/* 已确认记录的幂等路径仍复核 instanceId/sessionId/managerTerm（在 precondition 完成），只跳过容量。 */
function settledConfirmOf(record, joinId) {
  return record.confirmed
    ? { ok: true, member: true, joinId, idempotent: true, joinedAt: record.confirmedAt }
    : null;
}

/* confirm 的拒绝面：过期（顺手删记录）与活跃席位容量不足；除过期外失败保留 joining。
 * 名单已含本席（alreadyMember）时跳过容量与过期：崩溃重放可能慢于 TTL，已入名单的席位
 * 不得因 grant 过期拿 expired（接线会据此误投 join-deny）。身份/任期校验在此之前已完成。
 * 名单写入失败必须由接线调 unconfirmJoining 回滚。 */
function confirmBlockOf(state, record, input, alreadyMember) {
  if (alreadyMember) {
    return null;
  }
  if (clockOf(state, input?.now) >= record.expiresAt) {
    removeJoining(state, record.joinId, record);
    state.counters.expired++;
    return failure('expired');
  }
  const activeSeats = activeSeatsOf(input.activeSeats);
  if (activeSeats === null) {
    return failure('invalid');
  }
  return activeSeats >= state.maxActiveSeats ? failure('capacity') : null;
}

/* confirm 的内部提交步（不单独导出）：接线只调 confirmJoining；名单写失败用 unconfirmJoining 回滚。 */
function markConfirmed(state, record, at) {
  const now = clockOf(state, at);
  record.confirmed = true;
  record.confirmedAt = now;
  state.counters.confirmed++;
  return { ok: true, member: true, joinId: record.joinId, idempotent: false, joinedAt: now };
}

/* 名单写入失败的模块侧回滚（接线义务）：把已确认记录退回未确认，joinId 与 TTL 保留，confirm 可重试。
 * 接线在 confirmJoining 成功后写名单失败时**必调**本方法；未确认记录按幂等成功返回，未知 joinId 返回 unknown。 */
function unconfirmJoining(state, joinId) {
  const record = joiningOf(state, joinId);
  if (record === undefined) {
    return failure('unknown');
  }
  if (!record.confirmed) {
    return { ok: true, joinId, unconfirmed: false, idempotent: true, record: cloneJoining(record) };
  }
  record.confirmed = false;
  record.confirmedAt = null;
  state.counters.unconfirmed++;
  return { ok: true, joinId, unconfirmed: true, idempotent: false, record: cloneJoining(record) };
}

/* abort：申请人收到 join-deny 后的回滚；已确认（已入名单）的席位不可由 abort 撤销。
 * 返回被删记录的身份，接线可直接按它投 join-deny。 */
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
  return {
    ok: true,
    joinId,
    reason: typeof reason === 'string' && reason !== '' ? reason : 'aborted',
    removed: true,
    record: joiningIdentityOf(record),
  };
}

/* 离席释放（接线义务）：confirmed 记录是「本任期已入席」的缓存，不是永久席位；会话离席、被移除、
 * 名单移除或协作结束时**必调**本方法，否则同 (collabId,sessionId) 再入席会一直撞 already-member。
 * 未确认记录同样可释放（作废并计入 aborted）。 */
function releaseJoining(state, collabId, sessionId) {
  const collab = asId(collabId);
  const session = asId(sessionId);
  if (collab === null || session === null) {
    return failure('invalid');
  }
  const joinId = state.byKey.get(joinKey(collab, session));
  const record = joinId === undefined ? undefined : state.byJoinId.get(joinId);
  if (record === undefined || joinId === undefined) {
    return { ok: true, released: false, record: null };
  }
  removeJoining(state, joinId, record);
  if (!record.confirmed) {
    state.counters.aborted++;
  }
  return { ok: true, released: true, record: joiningIdentityOf(record) };
}

/* 超时清理：只清未确认记录；已确认席位是成员事实，跨 TTL 保留。返回值含被删记录身份供投 deny。 */
function expireJoining(state, at) {
  const now = clockOf(state, at);
  const joinIds = [];
  const records = [];
  for (const [joinId, record] of state.byJoinId) {
    if (record.confirmed || now < record.expiresAt) {
      continue;
    }
    removeJoining(state, joinId, record);
    joinIds.push(joinId);
    records.push(joiningIdentityOf(record));
  }
  state.counters.expired += joinIds.length;
  return { expired: joinIds.length, joinIds, records };
}

/* 站长更替：未确认 grant 全部作废（给了新 term 时只清旧 term 的），已确认席位保留。
 * abortedRecords 与 aborted 一一对应，接线据此投 join-deny(manager-changed/aborted)。 */
function invalidateForManagerChange(state, managerTerm) {
  const term = managerTerm === undefined || managerTerm === null ? null : managerTerm;
  if (term !== null && !isPositiveInt(term)) {
    return failure('invalid');
  }
  const aborted = [];
  const abortedRecords = [];
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
    abortedRecords.push(joiningIdentityOf(record));
  }
  state.counters.aborted += aborted.length;
  return { ok: true, aborted, abortedRecords, kept };
}

/* deny 路由所需的最小身份：记录删除后仍可据此寻址申请会话与携带 joinId/term。 */
function joiningIdentityOf(record) {
  return {
    joinId: record.joinId,
    collabId: record.collabId,
    instanceId: record.instanceId,
    sessionId: record.sessionId,
    managerTerm: record.managerTerm,
  };
}

/* 重启恢复：只吃 joins.json 的 pendingJoins 形态（collabId 由调用方按协作目录注入）。
 * 设计形态不含 confirmed/confirmedAt/collabId：confirmed 缺省 false；已确认席位以共享名单为准，
 * 不从 joins.json 恢复，confirmed:true 的记录一律拒收。整表替换并重建席位键索引；
 * 重复 joinId/席位键与坏字段计入 rejected；超过 maxJoining 时保留 expiresAt 最晚的 grant，其余拒收。
 * options.maxJoining 只作本次恢复的裁剪上限，不写回运行期上限：一次性限制不得改变后续 begin 的容量判定。 */
function restoreJoining(state, records, options) {
  if (!Array.isArray(records)) {
    return failure('invalid');
  }
  const collabId = asId(options?.collabId);
  if (collabId === null) {
    return failure('invalid');
  }
  const limit = isPositiveInt(options?.maxJoining) ? options.maxJoining : state.maxJoining;
  const kept = joinAcceptedOf(records, collabId);
  const byJoinId = new Map();
  const byKey = new Map();
  let rejected = kept.rejected;
  for (const record of kept.records) {
    const key = joinKey(record.collabId, record.sessionId);
    if (byJoinId.has(record.joinId) || byKey.has(key)) {
      rejected++;
      continue;
    }
    byJoinId.set(record.joinId, record);
    byKey.set(key, record.joinId);
  }
  rejected += trimJoiningTo(byJoinId, byKey, limit);
  state.byJoinId = byJoinId;
  state.byKey = byKey;
  return { ok: true, restored: byJoinId.size, rejected };
}

function joinAcceptedOf(records, collabId) {
  const accepted = [];
  let rejected = 0;
  for (const raw of records) {
    const record = restoredJoiningOf(raw, collabId);
    if (record === null) {
      rejected++;
      continue;
    }
    accepted.push(record);
  }
  return { records: accepted, rejected };
}

/* 设计形态：{joinId,instanceId,sessionId,managerTerm,grantVersion,requestedAt,expiresAt}。
 * 兼容模块 list() 里多出的 collabId（必须与注入值一致）；confirmed 只接受缺省或 false
 * （形态校验在 restoredJoiningFieldsOk 里统一做，此处不再重复复核）。 */
function restoredJoiningOf(raw, collabId) {
  if (!isPlainRecord(raw)) {
    return null;
  }
  const ids = restoredJoiningIdsOf(raw);
  if (ids === null || !restoredJoiningFieldsOk(raw)) {
    return null;
  }
  if (raw.collabId !== undefined && asId(raw.collabId) !== collabId) {
    return null;
  }
  return {
    joinId: ids.joinId,
    collabId,
    instanceId: ids.instanceId,
    sessionId: ids.sessionId,
    managerTerm: raw.managerTerm,
    grantVersion: raw.grantVersion,
    requestedAt: raw.requestedAt,
    expiresAt: raw.expiresAt,
    confirmed: false,
    confirmedAt: null,
  };
}

function restoredJoiningIdsOf(raw) {
  const joinId = asId(raw.joinId);
  const instanceId = asId(raw.instanceId);
  const sessionId = asId(raw.sessionId);
  if (joinId === null || instanceId === null || sessionId === null) {
    return null;
  }
  return { joinId, instanceId, sessionId };
}

function restoredJoiningFieldsOk(raw) {
  if (!isPositiveInt(raw.managerTerm) || !isPositiveInt(raw.grantVersion)) {
    return false;
  }
  if (!isTimestamp(raw.requestedAt) || !isTimestamp(raw.expiresAt) || raw.expiresAt < raw.requestedAt) {
    return false;
  }
  return raw.confirmed === undefined || raw.confirmed === false;
}

/* 超限恢复按「有效期更长者优先」裁剪：expiresAt 大者保留，同刻再比 requestedAt，最后按 joinId 稳定排序。
 * 不按 requestedAt 优先：跨重启改动 TTL 后，请求更晚不代表仍有效更久，按请求时刻会先丢有效期更长的 grant。 */
function trimJoiningTo(byJoinId, byKey, limit) {
  if (byJoinId.size <= limit) {
    return 0;
  }
  const ordered = [...byJoinId.values()]
    .sort((left, right) =>
      right.expiresAt - left.expiresAt
      || right.requestedAt - left.requestedAt
      || left.joinId.localeCompare(right.joinId));
  const keep = new Set(ordered.slice(0, limit).map((record) => record.joinId));
  let trimmed = 0;
  for (const [joinId, record] of [...byJoinId]) {
    if (keep.has(joinId)) {
      continue;
    }
    byJoinId.delete(joinId);
    byKey.delete(joinKey(record.collabId, record.sessionId));
    trimmed++;
  }
  return trimmed;
}

/* joins.json 的持久化投影：只写未确认记录，字段严格按设计 §4.4.2（不混入 confirmed/collabId）。 */
function joiningPersistOf(record) {
  return {
    joinId: record.joinId,
    instanceId: record.instanceId,
    sessionId: record.sessionId,
    managerTerm: record.managerTerm,
    grantVersion: record.grantVersion,
    requestedAt: record.requestedAt,
    expiresAt: record.expiresAt,
  };
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
