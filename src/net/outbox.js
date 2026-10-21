import { collabDir, collabFilePath, ensureDir } from '../paths.js';
import { ANCHOR_PORT } from '../site.js';
import { appendLine, loadLines, replaceFile } from '../storage.js';
import { DELIVERY_EXEMPT_TYPES, ID_PATTERN, MAX_ACTIVE_SEATS, isPort } from './protocol.js';

export const OUTBOX_FILE_NAME = 'outbox.jsonl';
const STATES = ['queued', 'acked', 'session', 'expired'];

/* 压缩的行数触发阈值：自上次压缩以来的追加行数超过「存活条目数 × 该倍率」即压缩。
 * 只在过期/回收事件压缩时，长会话里的重试追加要等终态事件才收敛——治理类条目永不入过期路径，
 * 积压期间文件会无界增长；按行数触发保证「文件增长有界」对所有场景成立。 */
const COMPACT_LINE_FACTOR = 2;

/* 每协作发送队列（设计 §10 投递可靠性）：落盘、可重启续投。
 * 形态 = 追加写的状态快照流（每次状态推进追加一条完整条目），加载时按 msgId 折叠（后写胜）；
 * 折叠出的历史行在加载与清理后就地压缩（整体替换写回），文件增长有界。
 * 状态机：queued（未确认）→ acked（对方驿站已确认）→ session（已投进对方会话，终态）；
 * queued/acked 超保留期 → expired（终态，提示发送方）；豁免类（治理通告 + 讨论 end/join/leave，
 * 设计 §5.5）在未终态前豁免容量与过期。 */
/* 记录 to 含「地址:端口」——多站点下拨号目标必须写全；旧记录无 port 字段按锚点端口解释：
 * 本文件没有版本字段，旧记录来自单站点时代：默认配置下语义等价，故按默认端口兜底而不做文件级迁移。 */
export function createOutbox({ dataDir, collabId, config, log }) {
  const state = {
    collabId,
    config,
    log,
    file: collabFilePath(dataDir, collabId, OUTBOX_FILE_NAME),
    entries: new Map(),
    counters: { appended: 0, compactions: 0, expiredTotal: 0, corruptRecords: 0, persistFailures: 0 },
    appendsSinceCompact: 0,
  };
  try {
    ensureDir(collabDir(dataDir, collabId));
  } catch (error) {
    log.error('协作目录创建失败（队列写入将不可用）', { collabId, reason: error.message });
  }
  load(state);
  return {
    entries: () => [...state.entries.values()],
    unfinished: () => unfinishedOf(state),
    units: () => unitsOf(state),
    headFor: (peerInstanceId) => headFor(state, peerInstanceId),
    enqueue: (input) => enqueue(state, input),
    markAttempt: (msgId, ts) => markAttempt(state, msgId, ts),
    retryNow: (msgId, ts) => retryNow(state, msgId, ts),
    markAcked: (msgId, ts) => markAcked(state, msgId, ts),
    markSessionDelivered: (msgId, ts) => markSessionDelivered(state, msgId, ts),
    prune: (now) => prune(state, now),
    reassignPeer: (peerInstanceId, to) => reassignPeer(state, peerInstanceId, to),
    size: () => state.entries.size,
    stats: () => ({ ...state.counters, size: state.entries.size, unfinished: unfinishedOf(state).length }),
  };
}

function load(state) {
  /** @type {{ entries: unknown[], tailDropped: boolean, corruptLines: Array<{ lineNumber: number, text: string }> } | null} */
  let loaded = null;
  try {
    loaded = loadLines(state.file);
  } catch (error) {
    // 读失败按「存储不可用」处理：计数 + 告警留痕后按空队列继续——启动面不得因存储读失败而失败
    state.counters.persistFailures++;
    state.log.warn('发送队列读取失败（按空队列继续）', { collabId: state.collabId, reason: error.message });
  }
  if (loaded === null) {
    return;
  }
  if (loaded.tailDropped || loaded.corruptLines.length > 0) {
    state.log.warn('发送队列文件有残缺记录，按可解析条目载入', {
      tailDropped: loaded.tailDropped,
      corruptLines: loaded.corruptLines.length,
    });
  }
  for (const record of loaded.entries) {
    const checked = validateRecord(record);
    if (checked === null || checked.collabId !== state.collabId) {
      state.counters.corruptRecords++;   // 结构非法或不属于本协作：视同损坏记录跳过
      continue;
    }
    state.entries.set(checked.msgId, checked);
  }
  if (loaded.entries.length > state.entries.size) {
    compact(state);   // 有折叠出的历史行：就地压缩
  }
}

function unfinishedOf(state) {
  return [...state.entries.values()].filter((entry) => entry.state === 'queued' || entry.state === 'acked');
}

function unitsOf(state) {
  const peers = new Set();
  for (const entry of state.entries.values()) {
    if (entry.state === 'queued') {
      peers.add(entry.to.instanceId);
    }
  }
  return [...peers];
}

function headFor(state, peerInstanceId) {
  /** @type {undefined | { msgId: string, collabId: string, to: { instanceId: string, address: string, port: number }, type: string, payload?: unknown, governance: boolean, state: 'queued' | 'acked' | 'session' | 'expired', attempts: number, createdAt: string, nextAttemptAt: number, ackedAt?: string, deliveredAt?: string, expiredAt?: string }} */
  let head = undefined;
  for (const entry of state.entries.values()) {
    if (entry.state !== 'queued' || entry.to.instanceId !== peerInstanceId) {
      continue;
    }
    if (head === undefined || Date.parse(entry.createdAt) < Date.parse(head.createdAt)) {
      head = entry;
    }
  }
  return head;
}

function enqueue(state, { msgId, to, type, payload, ts, from, fromSessionId, toSessions }) {
  /* governance = 投递豁免标记（持久化字段名沿用）：治理类 + 讨论的 end/join/leave（设计 §5.5）。 */
  const governance = DELIVERY_EXEMPT_TYPES.includes(type);
  const sessions = normalizeToSessions(toSessions);
  if (sessions === null) {
    return { ok: false, reason: `toSessions 非法（须为 1–${MAX_ACTIVE_SEATS} 个会话标识的数组）` };
  }
  // 配额只统计非豁免类未完成条目：豁免类积压不得挤占普通消息的名额（豁免类任何时刻可入队）
  if (!governance && unfinishedOf(state).filter((entry) => !entry.governance).length >= state.config.queueMaxPerCollab) {
    return { ok: false, reason: `该协作待投队列已满（上限 ${state.config.queueMaxPerCollab} 条），等待送达或过期后再试` };
  }
  const entry = {
    msgId,
    collabId: state.collabId,
    to: { instanceId: to.instanceId, address: to.address, port: to.port },
    type,
    payload,
    governance,
    state: 'queued',
    attempts: 0,
    createdAt: ts,
    nextAttemptAt: Date.parse(ts),
  };
  if (from !== undefined) {
    entry.from = { instanceId: from.instanceId, identityName: from.identityName, port: from.port };
    if (typeof from.sessionId === 'string') {
      entry.from.sessionId = from.sessionId;
    }
  }
  /* 机器级条目：toSessions 是同一帧上的席位目标集合；不按席位拆条、不改 msgId 折叠键（D11）。 */
  if (sessions !== undefined) {
    entry.toSessions = sessions;
  }
  if (typeof fromSessionId === 'string') {
    entry.fromSessionId = fromSessionId;
  }
  state.entries.set(msgId, entry);
  if (!writeRecord(state, entry)) {
    state.entries.delete(msgId);   // 未落盘即不承诺：取消本次受理（重启后不会出现「幽灵发送」）
    return { ok: false, reason: '发送队列落盘失败（磁盘或权限问题），本次发送未受理' };
  }
  return { ok: true };
}

function markAttempt(state, msgId, ts) {
  const entry = state.entries.get(msgId);
  if (entry === undefined || entry.state !== 'queued') {
    return false;
  }
  entry.attempts++;
  const waiting = entry.attempts <= state.config.retryFastCount ? state.config.retryIntervalMs : state.config.retrySlowIntervalMs;
  entry.nextAttemptAt = ts + waiting;
  writeRecord(state, entry);
  return true;
}

/* 提前重试（调用方限频）：业务层再次投递同一对端时，把队头的退避拨回当下。
 * 只动 queued 条目（已确认/终态没有退避语义）；落盘保持「重启后不带着旧退避等待」。 */
function retryNow(state, msgId, ts) {
  const entry = state.entries.get(msgId);
  if (entry === undefined || entry.state !== 'queued' || entry.nextAttemptAt <= ts) {
    return false;
  }
  entry.nextAttemptAt = ts;
  writeRecord(state, entry);
  return true;
}

function markAcked(state, msgId, ts) {
  const entry = state.entries.get(msgId);
  if (entry === undefined || entry.state !== 'queued') {
    return false;
  }
  entry.state = 'acked';
  entry.ackedAt = new Date(ts).toISOString();
  writeRecord(state, entry);
  return true;
}

function markSessionDelivered(state, msgId, ts) {
  const entry = state.entries.get(msgId);
  if (entry === undefined || entry.state === 'session' || entry.state === 'expired') {
    return false;
  }
  entry.state = 'session';
  entry.deliveredAt = new Date(ts).toISOString();
  writeRecord(state, entry);
  return true;
}

function prune(state, now) {
  const expired = [];
  let dropped = 0;
  for (const entry of [...state.entries.values()]) {
    if (entry.state === 'queued' || entry.state === 'acked') {
      if (expireIfStale(state, entry, now)) {
        expired.push(entry.msgId);
      }
      continue;
    }
    if (dropIfRecyclable(state, entry, now)) {
      dropped++;
    }
  }
  // 过期/回收事件会改变条目集；无终态事件时靠追加行数超阈值兜底压缩，保证文件增长有界
  if (expired.length > 0 || dropped > 0 || state.appendsSinceCompact > state.entries.size * COMPACT_LINE_FACTOR) {
    compact(state);
  }
  return { expired, dropped };
}

/* 改投（协作层降级 / 移交时消费）：把发往某对端的未确认条目改投新端点——同 msgId 保持
 * （进行中的消息在新目标上等价有效，且不产生第二条重复投递）；只动 queued（未确认）条目，
 * ack 后 / 终态条目不属「陈旧未完成」语义；改投后立即可投（不等旧退避）。 */
function reassignPeer(state, peerInstanceId, to) {
  let moved = 0;
  for (const entry of state.entries.values()) {
    if (entry.state !== 'queued' || entry.to.instanceId !== peerInstanceId) {
      continue;
    }
    entry.to = { instanceId: to.instanceId, address: to.address, port: to.port };
    entry.nextAttemptAt = Date.now();
    writeRecord(state, entry);
    moved++;
  }
  return { moved };
}

/* 未完成条目超保留期 → 置 expired 并落盘（豁免类在未终态前豁免）；返回是否本次转为过期。 */
function expireIfStale(state, entry, now) {
  if (entry.governance) {
    return false;
  }
  if (now - Date.parse(entry.createdAt) < state.config.messageTtlMs) {
    return false;
  }
  entry.state = 'expired';
  entry.expiredAt = new Date(now).toISOString();
  state.counters.expiredTotal++;
  writeRecord(state, entry);
  return true;
}

/* 终态条目按「终态时刻 + 保留期」回收；返回是否本次被回收。 */
function dropIfRecyclable(state, entry, now) {
  const terminalAt = Date.parse(entry.deliveredAt ?? entry.expiredAt ?? entry.createdAt);
  if (now - terminalAt < state.config.messageTtlMs) {
    return false;
  }
  state.entries.delete(entry.msgId);
  return true;
}

function writeRecord(state, entry) {
  try {
    appendLine(state.file, entry);
    state.counters.appended++;
    state.appendsSinceCompact++;
    return true;
  } catch (error) {
    state.counters.persistFailures++;
    state.log.error('发送队列落盘失败（内存态继续可用）', { msgId: entry.msgId, reason: error.message });
    return false;
  }
}

function compact(state) {
  const lines = [...state.entries.values()].map((entry) => JSON.stringify(entry) + '\n').join('');
  try {
    replaceFile(state.file, lines);
    state.counters.compactions++;
    state.appendsSinceCompact = 0;
  } catch (error) {
    state.counters.persistFailures++;
    state.log.error('发送队列压缩失败（保留原文件）', { reason: error.message });
  }
}

function validateRecord(record) {
  const sessions = normalizeToSessions(record?.toSessions);
  if (sessions === null || !isRecordShape(record)) {
    return null;
  }
  return {
    msgId: record.msgId,
    collabId: record.collabId,
    to: { instanceId: record.to.instanceId, address: record.to.address, port: record.to.port ?? ANCHOR_PORT },
    type: record.type,
    payload: record.payload,
    governance: record.governance === true,
    state: record.state,
    attempts: record.attempts,
    createdAt: record.createdAt,
    nextAttemptAt: Number.isInteger(record.nextAttemptAt) ? record.nextAttemptAt : Date.parse(record.createdAt),
    ackedAt: typeof record.ackedAt === 'string' ? record.ackedAt : undefined,
    deliveredAt: typeof record.deliveredAt === 'string' ? record.deliveredAt : undefined,
    expiredAt: typeof record.expiredAt === 'string' ? record.expiredAt : undefined,
    from: normalizedFromOf(record),
    fromSessionId: fromSessionIdOf(record),
    toSessions: sessions,
  };
}

function normalizedFromOf(record) {
  if (record.from === undefined) {
    return undefined;
  }
  const from = { instanceId: record.from.instanceId, identityName: record.from.identityName, port: record.from.port };
  if (typeof record.from.sessionId === 'string') {
    from.sessionId = record.from.sessionId;
  }
  return from;
}

function fromSessionIdOf(record) {
  return typeof record.fromSessionId === 'string' ? record.fromSessionId : record.from?.sessionId;
}

/* 席位目标集合归一（出站入队与入站受理共用的单一判据）：缺省（无 toSessions）＝接收核按本机
 * 全部活跃席位扇出；非法即拒绝/按损坏跳过。去重保持首次出现顺序——一机一帧只带一份目标列表。
 * 返回 undefined（缺省）/ null（非法）/ 归一后的字符串数组（可能为空数组时已按空拒绝）。 */
export function normalizeToSessions(value) {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ACTIVE_SEATS) {
    return null;
  }
  const sessions = [];
  for (const sessionId of value) {
    if (typeof sessionId !== 'string' || !ID_PATTERN.test(sessionId)) {
      return null;
    }
    if (!sessions.includes(sessionId)) {
      sessions.push(sessionId);
    }
  }
  return sessions;
}

/* 结构底线（字段形态）：不合形态的记录一律视同损坏，跳过并计数——内容语义不在此层裁定。
 * port 缺省（旧记录）可接受：归一为锚点端口在 validateRecord 里补；存在但非法 = 损坏（拒绝优于猜测）。 */
function isRecordShape(record) {
  return isPlainRecord(record) && hasCoreFields(record) && isPeerShape(record.to) && hasCounterFields(record) && isOptionalFromShape(record.from);
}

/* 原发身份（可选字段，转达帧保留发起者 from）：缺省 = 本机（普通发送）；存在则须合身份形态——
 * 非法视同损坏记录（拒绝优于猜测：宁可不投也不冒名投递）。 */
function isOptionalFromShape(from) {
  if (from === undefined) {
    return true;
  }
  if (typeof from !== 'object' || from === null) {
    return false;
  }
  if (typeof from.instanceId !== 'string' || typeof from.identityName !== 'string') {
    return false;
  }
  if (from.sessionId !== undefined && (typeof from.sessionId !== 'string' || !ID_PATTERN.test(from.sessionId))) {
    return false;
  }
  return from.port === undefined || isPort(from.port);
}

function isPlainRecord(record) {
  return typeof record === 'object' && record !== null && !Array.isArray(record);
}

function hasCoreFields(record) {
  if (typeof record.msgId !== 'string' || record.msgId === '' || !STATES.includes(record.state)) {
    return false;
  }
  if (typeof record.collabId !== 'string' || typeof record.type !== 'string') {
    return false;
  }
  return typeof record.createdAt === 'string' && !Number.isNaN(Date.parse(record.createdAt));
}

function isPeerShape(peer) {
  if (typeof peer !== 'object' || peer === null) {
    return false;
  }
  if (typeof peer.instanceId !== 'string' || typeof peer.address !== 'string') {
    return false;
  }
  return peer.port === undefined || isPort(peer.port);
}

function hasCounterFields(record) {
  return Number.isInteger(record.attempts) && record.attempts >= 0;
}
