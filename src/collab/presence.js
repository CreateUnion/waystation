/* 席位 presence 表（设计 §2A.9）：只服务离席判定与「目标是否可达」，不产生 manager、不用于选举。
 * 纯内存态：表是 Map<collabId\0instanceId\0sessionId, entry>，不落盘、不发帧。
 *
 * 刷新纪律：
 * - seat-presence 按列表级刷新：只刷新 sessions 数组内的席位，同机未列出的旧席位标 unlisted；
 * - 其它协作帧只有直连来源才刷新，转达副本（payload.originMsgId）不刷新原发送者；
 * - 超时只用本地接收时刻（调用方传入 now）；帧自带时间只作偏斜参考，不进入 lastSeenAt；
 * - 过期项保留为 tombstone（expired=true），避免「删掉即无记录即可达」的 fail-open。
 *
 * 调用契约（缺证据一律拒绝并返回 reason，防止接线漏传导致 fail-open）：
 * - now：本地接收时刻，**单调钟**；不得用墙钟（term.js 才用墙钟），也不得取帧内 sentAt/at。
 *   缺失/非有限数 → now-missing；不得回落 Date.now()（墙钟与单调钟混用会让超时判定跳变）。
 * - applySeatPresence(table, notice, now, options)：notice 是 seat-presence **载荷**（不是帧），
 *   形态 {collabId,instanceId,sessions:[sessionId...],sentAt?}；非法 → notice-invalid。
 *   直连：options.peerInstanceId 是传输连接对端实例（来自连接层，不得取帧内 from），必须等于 notice.instanceId；
 *         缺 → peer-missing，不符 → peer-mismatch。
 *   forum 中继转发的副本（notice 顶层或 notice.payload 带 originMsgId）：要求
 *         options.mode === 'forum'、options.relayPeerInstanceId 是转达该副本的连接对端、
 *         relayPeerInstanceId === options.currentRelayPeerInstanceId（本机记录的当前中继），
 *         且 options.peerInstanceId === relayPeerInstanceId；否则 relay-rejected / peer-mismatch。
 *         副本的 notice.instanceId 仍是原发机器，不是中继。
 * - applyDirectFrame(table, frame, now, options)：frame 为完整协作帧；options.peerInstanceId 是连接对端，
 *   必须等于 frame.from.instanceId；转达副本（顶层或 payload.originMsgId）不刷新，返回 relayed。
 * - isReachable / autoSuccessorCandidates：hasEndpoint 必须显式 true/false、timeoutMs>0、now 有限；
 *   缺省按不可达（fail-closed）。expired/unlisted 优先于 lastSeenAt。
 * - expireSeats：now/timeoutMs 非法 → 返回 []（不判离、不回落墙钟）；两处出口无 reason，按 fail-closed 处理。 */

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

/* 真实转达副本把 originMsgId 放在 payload 里；顶层同名字段保留给本地调用方直传。 */
function originOf(frame) {
  if (typeof frame?.originMsgId === 'string' && frame.originMsgId !== '') {
    return frame.originMsgId;
  }
  if (isPlainObject(frame?.payload) && typeof frame.payload.originMsgId === 'string' && frame.payload.originMsgId !== '') {
    return frame.payload.originMsgId;
  }
  return null;
}

export function createPresenceTable() {
  return new Map();
}

/* 列表级刷新：同一台机器的列表是「该机当前有哪些活跃会话」的权威面，
 * 因此列表内的席位刷新 lastSeenAt，列表外的同机旧席位只标记、不刷新。
 * 转达的 seat-presence 默认拒收；forum 只放行「本机记录的当前中继」转发的那一份。 */
export function applySeatPresence(table, notice, now, options = {}) {
  if (!Number.isFinite(now)) {
    return { refreshed: [], unlisted: [], reason: 'now-missing' };
  }
  if (!isPresenceNotice(notice)) {
    return { refreshed: [], unlisted: [], reason: 'notice-invalid' };
  }
  const at = now;
  const sourceRejection = presenceSourceRejection(notice, options);
  if (sourceRejection !== null) {
    return { refreshed: [], unlisted: [], reason: sourceRejection };
  }
  const listed = new Set(notice.sessions);
  const refreshed = [];
  for (const sessionId of listed) {
    const key = keyOf(notice.collabId, notice.instanceId, sessionId);
    const entry = table.get(key);
    if (entry === undefined) {
      table.set(key, freshEntry(notice, sessionId, at));
    } else {
      refreshEntry(entry, at);
    }
    refreshed.push({ instanceId: notice.instanceId, sessionId });
  }
  const unlisted = markUnlisted(table, notice.collabId, notice.instanceId, listed, at);
  return { refreshed, unlisted };
}

function isPresenceNotice(notice) {
  return isPlainObject(notice)
    && typeof notice.collabId === 'string'
    && typeof notice.instanceId === 'string'
    && isSessionList(notice.sessions);
}

/* 直连要求传输对端就是原发机器；forum 中继转发只放行「连接对端＝本机记录的当前中继」的那一份。
 * 转达者的身份来自连接，不来自帧内 from；缺 peer 证据一律拒绝。 */
function presenceSourceRejection(notice, options) {
  const peer = options.peerInstanceId;
  if (typeof peer !== 'string' || peer === '') {
    return 'peer-missing';
  }
  if (originOf(notice) === null) {
    return peer === notice.instanceId ? null : 'peer-mismatch';
  }
  const relayPeer = options.relayPeerInstanceId;
  const viaCurrentRelay = options.mode === 'forum'
    && typeof relayPeer === 'string'
    && relayPeer === options.currentRelayPeerInstanceId;
  if (!viaCurrentRelay) {
    return 'relay-rejected';
  }
  return peer === relayPeer ? null : 'peer-mismatch';
}

function freshEntry(notice, sessionId, at) {
  return {
    collabId: notice.collabId,
    instanceId: notice.instanceId,
    sessionId,
    lastSeenAt: at,
    lastPresenceListAt: at,
    sourceInstanceId: notice.instanceId,
    unlisted: false,
    expired: false,
  };
}

/* 单调钟下不应回退；仍取 max 与直连路径一致，时钟源接错时不把已见时刻往回拨。 */
function refreshEntry(entry, at) {
  entry.lastSeenAt = Math.max(entry.lastSeenAt, at);
  entry.lastPresenceListAt = Math.max(entry.lastPresenceListAt, at);
  entry.unlisted = false;
  entry.expired = false;
  delete entry.expiredAt;
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
 * 用转达副本刷新会让「原发机器已离线」被无限期掩盖。
 * lastSeenAt 一律用本地接收时刻；帧自带 at 只记录为 reportedAt 供偏斜诊断。 */
export function applyDirectFrame(table, frame, now, options = {}) {
  if (!Number.isFinite(now)) {
    return { refreshed: false, reason: 'now-missing' };
  }
  const at = now;
  if (originOf(frame) !== null) {
    return { refreshed: false, reason: 'relayed' };
  }
  const direct = directSourceOf(frame);
  if (direct === null) {
    return { refreshed: false, reason: 'invalid' };
  }
  const peerProblem = peerProblemOf(direct, options);
  if (peerProblem !== null) {
    return { refreshed: false, reason: peerProblem };
  }
  const reportedAt = Number.isFinite(frame.at) ? frame.at : null;
  const key = keyOf(direct.collabId, direct.instanceId, direct.sessionId);
  const entry = table.get(key);
  if (entry === undefined) {
    table.set(key, {
      collabId: direct.collabId,
      instanceId: direct.instanceId,
      sessionId: direct.sessionId,
      lastSeenAt: at,
      lastPresenceListAt: 0,
      sourceInstanceId: direct.instanceId,
      unlisted: false,
      expired: false,
      reportedAt,
    });
  } else {
    entry.lastSeenAt = Math.max(entry.lastSeenAt, at);
    entry.expired = false;
    delete entry.expiredAt;
    entry.reportedAt = reportedAt;
  }
  return { refreshed: true };
}

function directSourceOf(frame) {
  if (!isPlainObject(frame) || !isPlainObject(frame.from)) {
    return null;
  }
  const { collabId } = frame;
  const { instanceId, sessionId } = frame.from;
  if (typeof collabId !== 'string' || typeof instanceId !== 'string' || typeof sessionId !== 'string') {
    return null;
  }
  return { collabId, instanceId, sessionId };
}

function peerProblemOf(direct, options) {
  const peer = options.peerInstanceId;
  if (typeof peer !== 'string' || peer === '') {
    return 'peer-missing';
  }
  return peer === direct.instanceId ? null : 'peer-mismatch';
}

/* 判离席由调用方决定；本函数把超时项标记为 tombstone 并返回被标记的条目。
 * 保留条目是为了让「已过期」在表内可查，防止删掉后又被当成「从未收到列表 → 可达」。 */
export function expireSeats(table, now, timeoutMs) {
  if (!Number.isFinite(now) || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return [];
  }
  const expired = [];
  for (const entry of table.values()) {
    if (entry.expired === true || now - entry.lastSeenAt < timeoutMs) {
      continue;
    }
    entry.expired = true;
    entry.expiredAt = now;
    expired.push({ ...entry });
  }
  return expired;
}

/* 可达性口径（设计 §2A.2「判定要件」）：有已知端点、不在已判离席集合，
 * 且在其机器最近一次 presence 列表内；列表从未收到时按「端点可达＋名单在册」处理。
 * 端点/超时证据缺失一律按不可达（fail-closed），避免漏传参数静默放行。 */
export function isReachable(table, seat, options = {}) {
  const key = reachableKeyOf(seat);
  if (key === null) {
    return false;
  }
  if (!reachabilityEvidenceOk(seat, options)) {
    return false;
  }
  const entry = table.get(key);
  if (entry === undefined) {
    return true;
  }
  if (entry.expired === true || entry.unlisted === true) {
    return false;
  }
  return isFreshEntry(entry, options);
}

/* 端点/超时/时钟/离席证据缺一不可：缺失按不可达（fail-closed），避免漏传参数静默放行。 */
function reachabilityEvidenceOk(seat, options) {
  if (!Number.isFinite(options.now) || !Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    return false;
  }
  if (optionValue(options.departed, seat) === true) {
    return false;
  }
  return optionValue(options.hasEndpoint, seat) === true;
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
  return options.now - entry.lastSeenAt < options.timeoutMs;
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
