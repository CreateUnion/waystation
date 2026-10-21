/* 席位 presence 表（设计 §2A.9）：只服务离席判定与「目标是否可达」，不产生 manager、不用于选举。
 * 纯内存态：表是 Map<collabId\0instanceId\0sessionId, entry>，不落盘、不发帧。
 *
 * 刷新纪律：
 * - seat-presence 按列表级刷新：只刷新 sessions 数组内的席位，同机未列出的旧席位标 unlisted；
 * - 其它协作帧只有直连来源才刷新，转达副本（originMsgId）不刷新原发送者；
 * - 超时用本地单调时刻（调用方传入 now），不读墙钟。 */

const KEY_SEPARATOR = '\u0000';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSessionList(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.every((sessionId) => typeof sessionId === 'string' && sessionId !== '');
}

function keyOf(collabId, instanceId, sessionId) {
  return `${collabId}${KEY_SEPARATOR}${instanceId}${KEY_SEPARATOR}${sessionId}`;
}

function sameSeat(left, right) {
  return isPlainObject(left) && isPlainObject(right)
    && typeof left.instanceId === 'string' && typeof left.sessionId === 'string'
    && left.instanceId === right.instanceId
    && left.sessionId === right.sessionId;
}

function optionValue(value, seat) {
  return typeof value === 'function' ? value(seat) : value;
}

export function createPresenceTable() {
  return new Map();
}

/* 列表级刷新：同一台机器的列表是「该机当前有哪些活跃会话」的权威面，
 * 因此列表内的席位刷新 lastSeenAt，列表外的同机旧席位只标记、不刷新。 */
export function applySeatPresence(table, notice, now) {
  const at = Number.isFinite(now) ? now : Date.now();
  if (!isPlainObject(notice) || typeof notice.collabId !== 'string' || typeof notice.instanceId !== 'string') {
    return { refreshed: [], unlisted: [] };
  }
  if (!isSessionList(notice.sessions)) {
    return { refreshed: [], unlisted: [] };
  }
  const listed = new Set(notice.sessions);
  const refreshed = [];
  for (const sessionId of listed) {
    const key = keyOf(notice.collabId, notice.instanceId, sessionId);
    const entry = table.get(key);
    if (entry === undefined) {
      table.set(key, {
        collabId: notice.collabId,
        instanceId: notice.instanceId,
        sessionId,
        lastSeenAt: at,
        lastPresenceListAt: at,
        sourceInstanceId: notice.instanceId,
        unlisted: false,
      });
    } else {
      entry.lastSeenAt = at;
      entry.lastPresenceListAt = at;
      entry.sourceInstanceId = notice.instanceId;
      entry.unlisted = false;
    }
    refreshed.push({ instanceId: notice.instanceId, sessionId });
  }
  const unlisted = markUnlisted(table, notice.collabId, notice.instanceId, listed, at);
  return { refreshed, unlisted };
}

function markUnlisted(table, collabId, instanceId, listed, at) {
  const unlisted = [];
  for (const entry of table.values()) {
    if (entry.collabId !== collabId || entry.instanceId !== instanceId || listed.has(entry.sessionId)) {
      continue;
    }
    entry.unlisted = true;
    entry.unlistedAt = at;
    unlisted.push({ instanceId: entry.instanceId, sessionId: entry.sessionId });
  }
  return unlisted;
}

/* 直连帧才算证据：转达副本的 from 是原发者、连接来源是转达者，
 * 用转达副本刷新会让「原发机器已离线」被无限期掩盖。 */
export function applyDirectFrame(table, frame, now) {
  const at = Number.isFinite(now) ? now : Date.now();
  if (isRelayedFrame(frame)) {
    return { refreshed: false, reason: 'relayed' };
  }
  const direct = directSourceOf(frame, at);
  if (direct === null) {
    return { refreshed: false, reason: 'invalid' };
  }
  const key = keyOf(direct.collabId, direct.instanceId, direct.sessionId);
  const entry = table.get(key);
  if (entry === undefined) {
    table.set(key, {
      collabId: direct.collabId,
      instanceId: direct.instanceId,
      sessionId: direct.sessionId,
      lastSeenAt: direct.seenAt,
      lastPresenceListAt: 0,
      sourceInstanceId: direct.instanceId,
      unlisted: false,
    });
  } else {
    entry.lastSeenAt = Math.max(entry.lastSeenAt, direct.seenAt);
    entry.unlisted = false;
  }
  return { refreshed: true };
}

function isRelayedFrame(frame) {
  return isPlainObject(frame) && typeof frame.originMsgId === 'string' && frame.originMsgId !== '';
}

function directSourceOf(frame, at) {
  if (!isPlainObject(frame) || !isPlainObject(frame.from)) {
    return null;
  }
  const { collabId } = frame;
  const { instanceId, sessionId } = frame.from;
  if (typeof collabId !== 'string' || typeof instanceId !== 'string' || typeof sessionId !== 'string') {
    return null;
  }
  return {
    collabId,
    instanceId,
    sessionId,
    seenAt: Number.isFinite(frame.at) ? frame.at : at,
  };
}

/* 判离席由调用方决定；本函数只按单调时刻清理超时项并返回被移除的条目。 */
export function expireSeats(table, now, timeoutMs) {
  if (!Number.isFinite(now) || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return [];
  }
  const expired = [];
  for (const [key, entry] of [...table.entries()]) {
    if (now - entry.lastSeenAt < timeoutMs) {
      continue;
    }
    table.delete(key);
    expired.push({ ...entry });
  }
  return expired;
}

/* 可达性口径（设计 §2A.2「判定要件」）：有已知端点、不在已判离席集合，
 * 且在其机器最近一次 presence 列表内；列表从未收到时按「端点可达＋名单在册」处理。 */
export function isReachable(table, seat, options = {}) {
  const key = reachableKeyOf(seat);
  if (key === null) {
    return false;
  }
  if (optionValue(options.departed, seat) === true) {
    return false;
  }
  if (optionValue(options.hasEndpoint, seat) === false) {
    return false;
  }
  const entry = table.get(key);
  if (entry === undefined) {
    return true;
  }
  if (entry.unlisted === true) {
    return false;
  }
  return isFreshEntry(entry, options);
}

function reachableKeyOf(seat) {
  if (!isPlainObject(seat) || typeof seat.collabId !== 'string') {
    return null;
  }
  if (typeof seat.instanceId !== 'string' || typeof seat.sessionId !== 'string') {
    return null;
  }
  return keyOf(seat.collabId, seat.instanceId, seat.sessionId);
}

function isFreshEntry(entry, options) {
  if (!Number.isFinite(options.timeoutMs)) {
    return true;
  }
  const at = Number.isFinite(options.now) ? options.now : Date.now();
  return at - entry.lastSeenAt < options.timeoutMs;
}

/* 自动移交目标（设计 §2A.5）：除旧站长外的活跃席位，按 (joinSeq,sessionId) 升序取可达者。
 * presence 只做可达性过滤，不参与优先序计算；同 joinSeq 用 sessionId 破平。 */
export function autoSuccessorCandidates(table, seats, options = {}) {
  const { collabId, prevManager } = options;
  if (typeof collabId !== 'string' || !Array.isArray(seats)) {
    return [];
  }
  const seen = new Set();
  const candidates = [];
  for (const seat of seats) {
    if (!isEligibleCandidate(seat, prevManager)) {
      continue;
    }
    const key = keyOf(collabId, seat.instanceId, seat.sessionId);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    candidates.push(seat);
  }
  const reachable = candidates.filter((seat) => isReachable(
    table,
    { collabId, instanceId: seat.instanceId, sessionId: seat.sessionId },
    options,
  ));
  return reachable.sort(compareCandidateOrder);
}

function isEligibleCandidate(seat, prevManager) {
  if (!isPlainObject(seat) || typeof seat.instanceId !== 'string' || typeof seat.sessionId !== 'string') {
    return false;
  }
  if (seat.role === 'manager') {
    return false;
  }
  return !sameSeat(seat, prevManager);
}

function compareCandidateOrder(left, right) {
  const leftSeq = Number.isInteger(left.joinSeq) ? left.joinSeq : Number.MAX_SAFE_INTEGER;
  const rightSeq = Number.isInteger(right.joinSeq) ? right.joinSeq : Number.MAX_SAFE_INTEGER;
  if (leftSeq !== rightSeq) {
    return leftSeq - rightSeq;
  }
  if (left.sessionId === right.sessionId) {
    return 0;
  }
  return left.sessionId < right.sessionId ? -1 : 1;
}
