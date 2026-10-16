import { readFileSync, rmSync } from 'node:fs';
import { writeJsonAtomic } from '../storage.js';
import { collabDir, ensureDir, joinApplicationsFilePath, joinsFilePath, runDir } from '../paths.js';
import { ID_PATTERN, isIdentityName } from '../net/protocol.js';

/* 会话级加入的两本台账（设计 §7）：
 *   joins.json（每协作）＝ { v:1, pendingJoins:[待批准], approvals:[本机获准] }——两侧（站长机 / 会话所在机）
 *   同形态各持本机相关：站长机记「谁在等批准」，会话机记「本机哪些会话获准了该协作」；
 *   run/join-applications.json（每机）＝ { v:1, applications:[待回执申请] }——本机会话发出的申请，
 *   跨协作（条目自带 collabId），比本机认识该协作还早（未在席者敲门解析后才得 collabId），故住 run/。
 * 两本都是「本地进展记录」：整档读不出 / 解析不出 / 形态不符 → 空态＋留痕，单条形态不符 → 丢该条留其余；
 * 入账侧再设一道把关（坏条目不得借写路径进文件）。写 / 删失败只计数告警、内存态继续（静音状态先例）——
 * 台账损坏或写盘失败都不得让协作主链停下来：丢的是跨重启的持久性，不是当下已成立的接线。 */

const JOINS_LABEL = '加入台账';
const APPLICATIONS_LABEL = '加入申请台账';

/* 获准来路（设计 §7）：create = 站长本机创建时即在席；invite = 受邀同意入席；grant = 申请经站长批准。
 * 与绑定表的 origin 同一思路（记「怎么进来的」），取值集不同（绑定表记接线动作，此处记获准来路）。 */
export const APPROVAL_ORIGINS = ['create', 'invite', 'grant'];

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIdText(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

/* 时间戳一律毫秒整数（纪元起算）：过期剪除与准入门时效按同一基准做差，不引入 ISO 串解析面。 */
function isMillisecond(value) {
  return Number.isInteger(value) && value >= 0;
}

export function isJoinsShape(record) {
  return isRecord(record)
    && record.v === 1
    && Array.isArray(record.pendingJoins)
    && Array.isArray(record.approvals);
}

/* 待批准条目：机器实例 + 会话标识 + 申请时刻。identityName 可缺省（未携名者按短码呈现），
 * 在时过身份名白名单（与协议入站同一权威——展示面直接呈现，不得带控制字符）。 */
export function isPendingJoinShape(record) {
  if (!isRecord(record) || !isIdText(record.instanceId) || !isIdText(record.sessionId)) {
    return false;
  }
  if (record.identityName !== undefined && !isIdentityName(record.identityName)) {
    return false;
  }
  return isMillisecond(record.requestedAt);
}

/* 获准条目：本机获准名单的一行。approvedBy 记批准人（身份名或实例标识，两者同过身份名白名单）。 */
export function isApprovalShape(record) {
  if (!isRecord(record) || !isIdText(record.instanceId) || !isIdText(record.sessionId)) {
    return false;
  }
  return APPROVAL_ORIGINS.includes(record.origin)
    && isMillisecond(record.grantedAt)
    && isIdentityName(record.approvedBy);
}

export function isJoinApplicationsShape(record) {
  return isRecord(record) && record.v === 1 && Array.isArray(record.applications);
}

/* 申请条目：管理机器 + 协作 + 本机会话 + 帧标识（回执比对按它命中）+ 发出时刻（过期剪除按它算）。 */
export function isJoinApplicationShape(record) {
  return isRecord(record)
    && isIdText(record.collabId)
    && isIdText(record.sessionId)
    && isIdText(record.managerInstanceId)
    && isIdText(record.msgId)
    && isMillisecond(record.sentAt);
}

/**
 * @param {{ dataDir: string, collabId: string, log: any }} options
 */
export function createJoinsStore({ dataDir, collabId, log }) {
  /** @type {{ collabId: string, log: any, label: string, logFields: Record<string, unknown>, file: string, dataDir: string, pendingJoins: any[], approvals: any[], counters: any }} */
  const state = {
    collabId,
    log,
    label: JOINS_LABEL,
    logFields: { collabId },
    file: joinsFilePath(dataDir, collabId),
    dataDir,
    pendingJoins: [],
    approvals: [],
    counters: { corruptLoads: 0, corruptRecords: 0, persists: 0, persistFailures: 0, clears: 0 },
  };
  loadJoins(state);
  return {
    load: () => loadJoins(state),
    pendingJoins: () => cloneRecords(state.pendingJoins),
    approvals: () => cloneRecords(state.approvals),
    addPendingJoin: (record) => addPendingJoin(state, record),
    removePendingJoin: (sessionId) => removePendingJoin(state, sessionId),
    addApproval: (record) => addApproval(state, record),
    isGranted: (sessionId) => state.approvals.some((entry) => entry.sessionId === sessionId),
    clear: () => clearJoins(state),
    stats: () => ({ ...state.counters, pendingJoins: state.pendingJoins.length, approvals: state.approvals.length }),
  };
}

/**
 * @param {{ dataDir: string, log: any }} options
 */
export function createJoinApplicationsStore({ dataDir, log }) {
  /** @type {{ log: any, label: string, logFields: Record<string, unknown>, file: string, dataDir: string, applications: any[], counters: any }} */
  const state = {
    log,
    label: APPLICATIONS_LABEL,
    logFields: {},
    file: joinApplicationsFilePath(dataDir),
    dataDir,
    applications: [],
    counters: { corruptLoads: 0, corruptRecords: 0, adds: 0, removes: 0, pruned: 0, pruneRefusals: 0, persistFailures: 0 },
  };
  loadApplications(state);
  return {
    load: () => loadApplications(state),
    list: () => cloneRecords(state.applications),
    add: (record) => addApplication(state, record),
    remove: (msgId) => removeApplication(state, msgId),
    pruneExpired: (ttlMs, now) => pruneExpired(state, ttlMs, now),
    stats: () => ({ ...state.counters, size: state.applications.length }),
  };
}

/* 加载：文件不存在（首次运行 / 尚无加入往来）静默按空态；其余故障并入损坏面。
 * 整档形态不符即空态——重来一轮申请 / 批准即可重建，绝不带病沿用半份名单（谁获准过不能靠猜）。 */
function loadJoins(state) {
  state.pendingJoins = [];
  state.approvals = [];
  const parsed = readParsed(state);
  if (parsed === null) {
    return;
  }
  if (!isJoinsShape(parsed)) {
    traceCorruptLoad(state, '形态不符');
    return;
  }
  state.pendingJoins = keepShapedEntries(state, '待批准', parsed.pendingJoins, isPendingJoinShape);
  state.approvals = keepShapedEntries(state, '获准', parsed.approvals, isApprovalShape);
}

function loadApplications(state) {
  state.applications = [];
  const parsed = readParsed(state);
  if (parsed === null) {
    return;
  }
  if (!isJoinApplicationsShape(parsed)) {
    traceCorruptLoad(state, '形态不符');
    return;
  }
  state.applications = keepShapedEntries(state, '申请', parsed.applications, isJoinApplicationShape);
}

/* 读取＋解析：文件不存在静默返回 null；读不出（非 ENOENT）与解析不出归损坏面留痕。
 * 顶层形态判定归调用方（两本台账不同形），此处只保证「拿到一个解析成功的值或 null」。 */
function readParsed(state) {
  const text = readText(state);
  if (text === null) {
    return null;
  }
  const parsed = parseJsonOrNull(text);
  if (parsed === null) {
    traceCorruptLoad(state, '无法解析');
    return null;
  }
  return parsed;
}

/* 读取：文件不存在（首次运行）静默按空台账处理；其他读故障并入损坏面（留痕）。 */
function readText(state) {
  try {
    return readFileSync(state.file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      traceCorruptLoad(state, error.message);
    }
    return null;
  }
}

function parseJsonOrNull(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function traceCorruptLoad(state, reason) {
  state.counters.corruptLoads++;
  state.log.warn(`${state.label}文件不可用（按空态继续）`, { ...state.logFields, reason });
}

/* 单条形态不符逐条丢弃（其余照常载入）：整档形态成立说明文件确是台账，个别坏条不该让全档作废；
 * 丢弃按条计数留痕（坏在哪一节、第几条），供排障定位写坏它的一方。
 * 通过者原样入内存（不裁字段）：谓词只管契约字段，加出的展示字段随记录走——裁剪会在加载-写回
 * 之间丢数据，而台账是本地记录，多留字段无害。 */
function keepShapedEntries(state, section, entries, isShape) {
  const kept = [];
  entries.forEach((entry, index) => {
    if (isShape(entry)) {
      kept.push(entry);
      return;
    }
    state.counters.corruptRecords++;
    state.log.warn(`${state.label}条目形态不符（丢弃该条）`, { ...state.logFields, section, index });
  });
  return kept;
}

/* 返回副本：调用方（工具面 / 观察窗）拿到的是快照，改不动内存台账。 */
function cloneRecords(records) {
  return records.map((record) => ({ ...record }));
}

/* 入账把关：形态不符一律拒绝并留痕——加载侧丢弃是兜底，写侧把关是主责（坏条目不得借写路径进文件）。
 * 通过后连同字段浅拷贝一起入账，调用方后续改动其对象不再影响台账。 */
function shapeGuardedEntry(state, section, record, isShape) {
  if (isShape(record)) {
    return { ...record };
  }
  state.counters.corruptRecords++;
  state.log.warn(`${state.label}条目形态不符（拒绝入账）`, { ...state.logFields, section });
  return null;
}

/* 同会话 / 同帧幂等：只留一条（重复申请、重试重发刷新原记录而不堆行）——获准判定与回执比对
 * 要求键唯一，堆行会让「同一会话的两条记录」在展示面与判定面分叉。 */
function upsertByKey(records, entry, key) {
  return records.filter((existing) => existing[key] !== entry[key]).concat(entry);
}

/* 入账待批准（站长侧）：提交申请即入账，等批准面按它取数。返回是否入账（形态不符即拒）。 */
function addPendingJoin(state, record) {
  const entry = shapeGuardedEntry(state, '待批准', record, isPendingJoinShape);
  if (entry === null) {
    return false;
  }
  state.pendingJoins = upsertByKey(state.pendingJoins, entry, 'sessionId');
  persistJoins(state);
  return true;
}

/* 入账获准（会话侧 / 站长侧各记本机相关条目）：获准是接线的前件——先落台账再动绑定，
 * 中途失败时宁可「已获准未接线」（重试接线即可），不可「已接线未获准」（准入门无据可查）。 */
function addApproval(state, record) {
  const entry = shapeGuardedEntry(state, '获准', record, isApprovalShape);
  if (entry === null) {
    return false;
  }
  state.approvals = upsertByKey(state.approvals, entry, 'sessionId');
  persistJoins(state);
  return true;
}

/* 移除待批准（批准 / 拒绝 / 会话退出的收尾）：命中即落盘；未命中如实报 false（重复移除 / 从未入账）。 */
function removePendingJoin(state, sessionId) {
  const rest = state.pendingJoins.filter((entry) => entry.sessionId !== sessionId);
  if (rest.length === state.pendingJoins.length) {
    return false;
  }
  state.pendingJoins = rest;
  persistJoins(state);
  return true;
}

/* 落盘：协作目录惰性创建（首次写入时建）＋原子替换（storage 层，crash 面只留孤儿临时文件）。
 * 失败只计数告警——内存台账继续服务本会话，丢的是跨重启的持久性，不是当下的批准链。 */
function persistJoins(state) {
  try {
    ensureDir(collabDir(state.dataDir, state.collabId));
    writeJsonAtomic(state.file, { v: 1, pendingJoins: state.pendingJoins, approvals: state.approvals });
    state.counters.persists++;
  } catch (error) {
    state.counters.persistFailures++;
    state.log.warn(`${state.label}写入失败（内存态继续）`, { ...state.logFields, reason: error.message });
  }
}

/* 清理（协作退出 / 归档时的生命周期终点）：内存复位 ＋ 删文件。台账随协作走——退出后本机不再有该
 * 协作的批准关系；重入时从空态重新申请 / 受批，不留幽灵获准（静音状态同一先例）。文件本已不在也算成功；
 * 删除失败只计数告警（终态已从内存消失，残留文件下次加载会被自己的形态校验拒绝或随归档删除）。 */
function clearJoins(state) {
  state.pendingJoins = [];
  state.approvals = [];
  try {
    rmSync(state.file, { force: true });
    state.counters.clears++;
  } catch (error) {
    state.counters.persistFailures++;
    state.log.warn(`${state.label}清理失败（已忽略）`, { ...state.logFields, reason: error.message });
  }
}

/* 入账申请（同 msgId 幂等）：重试重发沿用同一 msgId，只刷新原记录而不堆行——回执比对按 msgId 命中唯一一条。 */
function addApplication(state, record) {
  if (!isJoinApplicationShape(record)) {
    state.counters.corruptRecords++;
    state.log.warn(`${state.label}条目形态不符（拒绝入账）`, { ...state.logFields });
    return false;
  }
  state.applications = upsertByKey(state.applications, { ...record }, 'msgId');
  persistApplications(state);
  state.counters.adds++;
  return true;
}

/* 移除申请（收到批准 / 拒绝，或放弃等待）：命中即落盘；未命中如实报 false。 */
function removeApplication(state, msgId) {
  const rest = state.applications.filter((entry) => entry.msgId !== msgId);
  if (rest.length === state.applications.length) {
    return false;
  }
  state.applications = rest;
  persistApplications(state);
  state.counters.removes++;
  return true;
}

/* 过期剪除（申请回执的时效面）：按 sentAt 与 now 的间隔满 ttlMs 判过期——与准入门「申请仍未过期」的
 * 判据同一时间基准（回执晚到即不再匹配，剪除即时落盘，跨重启同样不再匹配）。
 * 参数非法一律不剪：剪早了会打断仍在窗口内的申请-回执链，滞留守候（记录有限）胜过误删。 */
function pruneExpired(state, ttlMs, now) {
  if (!Number.isFinite(ttlMs) || ttlMs < 0) {
    state.counters.pruneRefusals++;
    state.log.warn(`${state.label}剪除参数非法（本轮不剪除）`, { ...state.logFields, ttlMs });
    return 0;
  }
  const base = Number.isFinite(now) ? now : Date.now();
  const before = state.applications.length;
  state.applications = state.applications.filter((entry) => base - entry.sentAt < ttlMs);
  const pruned = before - state.applications.length;
  if (pruned > 0) {
    state.counters.pruned += pruned;
    persistApplications(state);
  }
  return pruned;
}

/* 落盘：run/ 目录惰性创建（正常运行时核心启动即建好 0700 目录，此处只兜底异常次序；mkdirSync 幂等、
 * 不改既有目录的 mode——0700 的单一权威在核心）＋原子替换。失败只计数告警、内存态继续。 */
function persistApplications(state) {
  try {
    ensureDir(runDir(state.dataDir));
    writeJsonAtomic(state.file, { v: 1, applications: state.applications });
  } catch (error) {
    state.counters.persistFailures++;
    state.log.warn(`${state.label}写入失败（内存态继续）`, { ...state.logFields, reason: error.message });
  }
}
