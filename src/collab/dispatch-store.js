import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { MAX_TOPIC_CHARS, ID_PATTERN, isIdentityName, isPresentationText } from '../net/protocol.js';
import { dispatchStateFilePath } from '../paths.js';
import { writeJsonAtomic } from '../storage.js';
import { isValidDispatchStatePath } from '../dispatch-config.js';
import { validateAcceptance, validateEvidence } from './dispatch-fields.js';

/* 调度状态文件的持久化层（设计 §5.3）：
 *   - 默认 <数据根>/dispatch/state.json；config.dispatch.state_path 可改写（相对数据根 / 绝对路径）；
 *   - 整体替换写（storage.writeJsonAtomic：临时文件 + rename），崩溃最坏留下孤儿临时文件；
 *   - 读取用严格形态校验：任一项不符按整份损坏处理（隔离 .corrupt-<ts> + 调用方降级），不部分恢复；
 *   - 损坏隔离 / 位置迁移 / 路径解析都在本模块，调度域只消费结论。
 * 形态版本 v1：字段口径变化时人工递增，旧版本按不可用处理（不静默猜测迁移）。 */

export const DISPATCH_STATE_VERSION = 1;
export const DISPATCH_STATUSES = ['active', 'pending-takeover'];
export const DISPATCH_TASK_STATUSES = ['assigned', 'active', 'done', 'failed'];
export const DISPATCH_TASK_SUMMARY_MAX = 200;
export const REPLACED_MASTER_MAX = 8;
const SLAVE_ROLES = ['slave', 'none'];
const SLAVE_KINDS = ['interactive', 'bg', 'unknown'];
const TASK_ID_MAX = 64;

/* —— 路径 —— */

/** 解析生效状态文件路径：空串＝默认位置；相对值以数据根为锚点、绝对值原样；含 .. 一律拒绝。 */
export function resolveDispatchStatePath(dataDir, configured) {
  if (typeof configured !== 'string' || configured.trim() === '') {
    return dispatchStateFilePath(dataDir);
  }
  if (!isValidDispatchStatePath(configured)) {
    throw new TypeError(`dispatch.state_path 非法（不得包含 .. 路径段或空字节）：${configured.slice(0, 64)}`);
  }
  const value = configured.trim();
  return isAbsolute(value) ? resolve(value) : resolve(dataDir, value);
}

/**
 * 位置变更迁移（设计 §5.3）：配置位置 ≠ 默认位置时，默认文件存在且新位置为空 → 改名迁移；
 * 两边都存在 → 新位置优先，默认文件改名 .archived-<ts>。失败返回结论，不抛（调用方告警降级）。
 * @returns {{ ok: boolean, changed: boolean, mode?: string, reason?: string }}
 */
export function migrateDispatchState({ dataDir, statePath, now = Date.now() }) {
  const defaultPath = dispatchStateFilePath(dataDir);
  if (resolve(defaultPath) === resolve(statePath) || !existsSync(defaultPath)) {
    return { ok: true, changed: false };
  }
  try {
    if (existsSync(statePath)) {
      renameSync(defaultPath, `${defaultPath}.archived-${now}`);
      return { ok: true, changed: true, mode: 'archived' };
    }
    mkdirSync(dirname(statePath), { recursive: true });
    renameSync(defaultPath, statePath);
    return { ok: true, changed: true, mode: 'moved' };
  } catch (error) {
    return { ok: false, changed: false, reason: error?.message ?? '未知原因' };
  }
}

/* —— 读写 —— */

/**
 * 读状态文件并校验。返回形态：
 *   { ok:true, record } | { ok:false, missing:true } | { ok:false, corrupt:true, reason } |
 *   { ok:false, unreadable:true, reason }
 * corrupt 的调用方负责 quarantineDispatchState（本函数不改动文件）。
 * @param {string} file
 */
export function loadDispatchState(file) {
  /** @type {string} */
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { ok: false, missing: true };
    }
    return { ok: false, unreadable: true, reason: error?.message ?? '读取失败' };
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, corrupt: true, reason: `JSON 解析失败：${error?.message ?? '未知原因'}` };
  }
  const checked = deserializeDispatchState(parsed);
  return checked.ok ? checked : { ok: false, corrupt: true, reason: checked.reason };
}

/** 损坏隔离：改名 `.corrupt-<ts>` 保留排查依据；失败返回 false（不影响按无状态启动）。 */
export function quarantineDispatchState(file, now = Date.now()) {
  try {
    renameSync(file, `${file}.corrupt-${now}`);
    return true;
  } catch {
    return false;
  }
}

/** 整体替换写；父目录不存在时先建。失败向上抛（调用方按「告警 + 降级纯内存」兜底）。 */
export function saveDispatchState(file, record, { now = Date.now() } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  writeJsonAtomic(file, serializeDispatchState(record, now));
}

/** 删除状态文件（正常结束 / 超期残留）：不存在不算失败。 */
export function removeDispatchState(file) {
  rmSync(file, { force: true });
}

/* —— 内存记录 ↔ 文件形态 —— */

/** 内部记录 → 持久面：只取可重建编排事实；Map → 数组、毫秒 → ISO；运行态（队列/计时器/claim）不落盘。 */
export function serializeDispatchState(record, now = Date.now()) {
  return { v: DISPATCH_STATE_VERSION, savedAt: isoOf(now), dispatch: persistedDispatchOf(record, now) };
}

function persistedDispatchOf(record, now) {
  return {
    collabId: record.collabId,
    name: record.name,
    topic: record.topic ?? null,
    status: DISPATCH_STATUSES.includes(record.status) ? record.status : 'active',
    autoClaim: record.autoClaim === true,
    createdAt: isoOf(record.createdAt, now),
    masterSessionId: record.masterSessionId,
    masterName: record.masterName,
    masterLastSeenAt: isoOf(record.masterLastSeenAt, now),
    masterLostAt: nullableIsoOf(record.masterLostAt, now),
    replacedMasterSessionIds: [...(record.replacedMasterSessionIds ?? [])].slice(-REPLACED_MASTER_MAX),
    slaves: [...(record.slaves?.values?.() ?? [])].map((slave) => slaveStateOf(slave, now)),
    tasks: [...(record.tasks?.values?.() ?? [])].map((task) => taskStateOf(task, now)),
  };
}

function slaveStateOf(slave, now) {
  return {
    sessionId: slave.sessionId,
    name: slave.name,
    kind: slave.kind,
    role: slave.role,
    boundAt: isoOf(slave.boundAt, now),
  };
}

function taskStateOf(task, now) {
  return {
    taskId: task.taskId,
    status: task.status,
    assigneeSessionId: task.assigneeSessionId ?? null,
    lastProgress: task.lastProgress ?? null,
    /* 问题 5-C / 5-A：验收标准与最近一次 result 的证据摘要（v1 增量字段，schema 版本不升）。 */
    acceptance: Array.isArray(task.acceptance) ? [...task.acceptance] : [],
    evidenceRef: task.evidenceRef ?? null,
    createdAt: isoOf(task.createdAt, now),
    updatedAt: isoOf(task.updatedAt, now),
    completedAt: nullableIsoOf(task.completedAt, now),
  };
}

function nullableIsoOf(value, now) {
  return value === null || value === undefined ? null : isoOf(value, now);
}

/** 文件形态 → 内部记录。严格校验；通过的对象可直接进入调度域（Maps 化、运行态清空）。 */
export function deserializeDispatchState(value) {
  if (!isPlainObject(value) || value.v !== DISPATCH_STATE_VERSION) {
    return invalid(`根节点须为 v=${DISPATCH_STATE_VERSION} 的 JSON 对象`);
  }
  const dispatch = value.dispatch;
  if (!isPlainObject(dispatch)) {
    return invalid('缺少 dispatch 对象');
  }
  const head = validateDispatchHead(dispatch);
  if (head !== null) {
    return invalid(head);
  }
  const parts = validateDispatchParts(dispatch);
  if (parts.error !== null) {
    return invalid(parts.error);
  }
  return { ok: true, record: restoredRecordOf(dispatch, parts) };
}

function validateDispatchParts(dispatch) {
  const slaves = validateSlaves(dispatch.slaves);
  if (slaves.error !== null) {
    return { error: `slaves 非法：${slaves.error}` };
  }
  const tasks = validateTasks(dispatch.tasks);
  if (tasks.error !== null) {
    return { error: `tasks 非法：${tasks.error}` };
  }
  const replaced = validateReplacedMasters(dispatch.replacedMasterSessionIds);
  if (replaced.error !== null) {
    return { error: `replacedMasterSessionIds 非法：${replaced.error}` };
  }
  return { error: null, slaves: slaves.value, tasks: tasks.value, replaced: replaced.value };
}

function restoredRecordOf(dispatch, parts) {
  return {
    collabId: dispatch.collabId,
    mode: 'dispatch',
    ephemeral: true,
    name: dispatch.name,
    topic: dispatch.topic ?? null,
    masterSessionId: dispatch.masterSessionId,
    masterName: dispatch.masterName,
    autoClaim: dispatch.autoClaim === true,
    status: dispatch.status,
    createdAt: isoOf(parseTimestamp(dispatch.createdAt), 0),
    masterLastSeenAt: parseTimestamp(dispatch.masterLastSeenAt),
    masterLostAt: dispatch.masterLostAt === null ? null : parseTimestamp(dispatch.masterLostAt),
    replacedMasterSessionIds: new Set(parts.replaced),
    rulesMissingWarned: false,
    slaves: new Map(parts.slaves.map((slave) => [slave.sessionId, slave])),
    /* staleNotified 是运行期去重位（问题 6-A），不落盘；恢复后从 false 起算（最多再提醒一次）。 */
    tasks: new Map(parts.tasks.map((task) => [task.taskId, { ...task, staleNotified: false }])),
    claims: new Map(),
    queues: new Map(),
    /* 运行态两本账不落盘（重启即丢）；恢复时补空 Map，与创建路径保持一致——
     * 缺了它们 sweep 的展开迭代会直接抛 TypeError，核心起不来。 */
    queueDeadlines: new Map(),
    pendingAcks: new Map(),
    grace: new Map(),
    pendingEvents: [],
    eventTimer: null,
  };
}

function validateDispatchHead(dispatch) {
  return validateDispatchText(dispatch)
    ?? validateDispatchMaster(dispatch)
    ?? validateDispatchCollections(dispatch);
}

function validateDispatchText(dispatch) {
  if (typeof dispatch.collabId !== 'string' || !ID_PATTERN.test(dispatch.collabId)) {
    return 'collabId 形态非法';
  }
  if (!isIdentityName(dispatch.name)) {
    return 'name 形态非法';
  }
  if (dispatch.topic !== null && dispatch.topic !== undefined && !isPresentationText(dispatch.topic, MAX_TOPIC_CHARS)) {
    return 'topic 形态非法';
  }
  if (!DISPATCH_STATUSES.includes(dispatch.status)) {
    return 'status 词表非法';
  }
  if (typeof dispatch.autoClaim !== 'boolean') {
    return 'autoClaim 须为布尔值';
  }
  return null;
}

function validateDispatchMaster(dispatch) {
  if (parseTimestamp(dispatch.createdAt) === null) {
    return 'createdAt 时间戳非法';
  }
  if (typeof dispatch.masterSessionId !== 'string' || !ID_PATTERN.test(dispatch.masterSessionId)) {
    return 'masterSessionId 形态非法';
  }
  if (!isIdentityName(dispatch.masterName)) {
    return 'masterName 形态非法';
  }
  if (parseTimestamp(dispatch.masterLastSeenAt) === null) {
    return 'masterLastSeenAt 时间戳非法';
  }
  if (dispatch.masterLostAt !== null && dispatch.masterLostAt !== undefined && parseTimestamp(dispatch.masterLostAt) === null) {
    return 'masterLostAt 时间戳非法';
  }
  return null;
}

function validateDispatchCollections(dispatch) {
  if (!Array.isArray(dispatch.slaves)) {
    return 'slaves 须为数组';
  }
  if (!Array.isArray(dispatch.tasks)) {
    return 'tasks 须为数组';
  }
  return null;
}

function validateSlaves(raw) {
  if (raw === undefined || raw === null) {
    return { value: [], error: null };
  }
  if (!Array.isArray(raw)) {
    return { value: [], error: '须为数组' };
  }
  const seen = new Set();
  const value = [];
  for (const entry of raw) {
    const checked = validateSlave(entry);
    if (checked.error !== null) {
      return { value: [], error: checked.error };
    }
    if (seen.has(checked.value.sessionId)) {
      return { value: [], error: `sessionId 重复：${checked.value.sessionId}` };
    }
    seen.add(checked.value.sessionId);
    value.push(checked.value);
  }
  return { value, error: null };
}

function validateSlave(entry) {
  if (!isPlainObject(entry)) {
    return { value: null, error: '条目须为对象' };
  }
  if (typeof entry.sessionId !== 'string' || !ID_PATTERN.test(entry.sessionId)) {
    return { value: null, error: 'sessionId 形态非法' };
  }
  if (!isIdentityName(entry.name)) {
    return { value: null, error: `name 形态非法（${String(entry.sessionId)}）` };
  }
  if (!SLAVE_KINDS.includes(entry.kind)) {
    return { value: null, error: `kind 词表非法（${String(entry.sessionId)}）` };
  }
  if (!SLAVE_ROLES.includes(entry.role)) {
    return { value: null, error: `role 词表非法（${String(entry.sessionId)}）` };
  }
  const boundAt = parseTimestamp(entry.boundAt);
  if (boundAt === null) {
    return { value: null, error: `boundAt 时间戳非法（${String(entry.sessionId)}）` };
  }
  return {
    value: { sessionId: entry.sessionId, name: entry.name, kind: entry.kind, role: entry.role, boundAt },
    error: null,
  };
}

function validateTasks(raw) {
  if (raw === undefined || raw === null) {
    return { value: [], error: null };
  }
  if (!Array.isArray(raw)) {
    return { value: [], error: '须为数组' };
  }
  const seen = new Set();
  const value = [];
  for (const entry of raw) {
    const checked = validateTask(entry);
    if (checked.error !== null) {
      return { value: [], error: checked.error };
    }
    if (seen.has(checked.value.taskId)) {
      return { value: [], error: `taskId 重复：${checked.value.taskId}` };
    }
    seen.add(checked.value.taskId);
    value.push(checked.value);
  }
  return { value, error: null };
}

function validateTask(entry) {
  if (!isPlainObject(entry)) {
    return { value: null, error: '条目须为对象' };
  }
  const fields = validateTaskFields(entry);
  if (fields.error !== null) {
    return fields;
  }
  const times = validateTaskTimes(entry, entry.taskId);
  if (times.error !== null) {
    return times;
  }
  return { value: { ...fields.value, ...times.value }, error: null };
}

function validateTaskFields(entry) {
  const identity = validateTaskIdentity(entry);
  if (identity.error !== null) {
    return identity;
  }
  const extras = validateTaskExtras(entry);
  if (extras.error !== null) {
    return extras;
  }
  return { value: { ...identity.value, ...extras.value }, error: null };
}

function validateTaskIdentity(entry) {
  if (typeof entry.taskId !== 'string' || entry.taskId.trim() === '' || entry.taskId.length > TASK_ID_MAX) {
    return { value: null, error: 'taskId 形态非法' };
  }
  if (!DISPATCH_TASK_STATUSES.includes(entry.status)) {
    return { value: null, error: `status 词表非法（${entry.taskId}）` };
  }
  return { value: { taskId: entry.taskId, status: entry.status }, error: null };
}

function validateTaskExtras(entry) {
  const assigneeSessionId = entry.assigneeSessionId ?? null;
  const lastProgress = entry.lastProgress ?? null;
  const simple = validateTaskSimpleFields(assigneeSessionId, lastProgress, entry.taskId);
  if (simple.error !== null) {
    return simple;
  }
  const structured = validateTaskStructuredFields(entry);
  if (structured.error !== null) {
    return structured;
  }
  return {
    value: { assigneeSessionId, lastProgress, ...structured.value },
    error: null,
  };
}

function validateTaskSimpleFields(assigneeSessionId, lastProgress, taskId) {
  if (assigneeSessionId !== null && (typeof assigneeSessionId !== 'string' || !ID_PATTERN.test(assigneeSessionId))) {
    return { value: null, error: `assigneeSessionId 形态非法（${taskId}）` };
  }
  if (lastProgress !== null && (typeof lastProgress !== 'string' || lastProgress.length > DISPATCH_TASK_SUMMARY_MAX)) {
    return { value: null, error: `lastProgress 形态非法（${taskId}）` };
  }
  return { value: null, error: null };
}

function validateTaskStructuredFields(entry) {
  const acceptance = validateStoredAcceptance(entry.acceptance);
  if (acceptance.error !== null) {
    return { value: null, error: `acceptance 形态非法（${entry.taskId}）：${acceptance.error}` };
  }
  const evidenceRef = validateStoredEvidenceRef(entry.evidenceRef);
  if (evidenceRef.error !== null) {
    return { value: null, error: `evidenceRef 形态非法（${entry.taskId}）：${evidenceRef.error}` };
  }
  return { value: { acceptance: acceptance.value, evidenceRef: evidenceRef.value }, error: null };
}

/* 旧文件（0.2.6 及以前）没有 acceptance / evidenceRef：缺失 / null / 空数组一律按空处理，
 * 不把旧文件判成损坏（schema 版本仍为 v1）。 */
function validateStoredAcceptance(raw) {
  if (raw === undefined || raw === null || (Array.isArray(raw) && raw.length === 0)) {
    return { value: [], error: null };
  }
  const checked = validateAcceptance(raw);
  return checked.ok ? { value: checked.value, error: null } : { value: null, error: checked.reason };
}

function validateStoredEvidenceRef(raw) {
  if (raw === undefined || raw === null) {
    return { value: null, error: null };
  }
  const checked = validateEvidence(raw);
  return checked.ok ? { value: checked.value, error: null } : { value: null, error: checked.reason };
}

function validateTaskTimes(entry, taskId) {
  const createdAt = parseTimestamp(entry.createdAt);
  const updatedAt = parseTimestamp(entry.updatedAt);
  const completedRaw = entry.completedAt ?? null;
  const completedAt = completedRaw === null ? null : parseTimestamp(completedRaw);
  if (createdAt === null || updatedAt === null || (completedRaw !== null && completedAt === null)) {
    return { value: null, error: `时间戳非法（${taskId}）` };
  }
  return { value: { createdAt, updatedAt, completedAt }, error: null };
}

function validateReplacedMasters(raw) {
  if (raw === undefined || raw === null) {
    return { value: [], error: null };
  }
  if (!Array.isArray(raw)) {
    return { value: [], error: '须为数组' };
  }
  const value = [];
  for (const sessionId of raw) {
    if (typeof sessionId !== 'string' || !ID_PATTERN.test(sessionId)) {
      return { value: [], error: 'sessionId 形态非法' };
    }
    if (!value.includes(sessionId)) {
      value.push(sessionId);
    }
  }
  return { value: value.slice(-REPLACED_MASTER_MAX), error: null };
}

function parseTimestamp(value) {
  if (typeof value !== 'string' || value.length > 40) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** @param {number | string | null | undefined} value @param {number | null} [fallback] */
function isoOf(value, fallback = null) {
  const ms = typeof value === 'number' && Number.isFinite(value) ? value : parseTimestamp(value);
  const resolved = ms ?? fallback ?? Date.now();
  return new Date(resolved).toISOString();
}

function invalid(reason) {
  return { ok: false, reason };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
