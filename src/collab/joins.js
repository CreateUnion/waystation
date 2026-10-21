import { copyFileSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { writeJsonAtomic } from '../storage.js';
import {
  collabDir, ensureDir, invitesFilePath, joinApplicationsFilePath, joinsFilePath, pendingInvitesFilePath, runDir,
} from '../paths.js';
import { ID_PATTERN, MAX_ACTIVE_SEATS, isIdentityName } from '../net/protocol.js';
import { createInvitesBook, createJoiningRegistry, createPendingInvites, MAX_JOINING } from './invites.js';
import { isSeatArchived, loadSeats } from './local.js';
import { loadLedger } from './store.js';

/* 会话级加入的本地台账（设计 §4/§6.2）：
 *   joins.json（每协作）＝ 0.2.0 起 { v:2, pendingJoins:[未确认 joining] }（更早的 v1 记录与 approvals
 *   仅作读侧兼容，写侧不再产出）；pendingJoins 是「已发 grant、待 join-confirm」的唯一写盘投影，
 *   已确认席位以共享名单为准，不得从本文件恢复；
 *   run/join-applications.json（每机）＝ { v:1, applications:[待回执申请] }——本机会话发出的申请，
 *   跨协作（条目自带 collabId），比本机认识该协作还早（未在席者敲门解析后才得 collabId），故住 run/。
 *   本文件同时承载 0.2.0 的邀请簿记（invites.json）与目标机挂起邀请（pending-invites.json）的
 *   文件读写包装；纯判定仍归 invites.js（本层只做「读盘 → restore」「内存 → 原子替换」）。
 * 两本都是「本地进展记录」：整档读不出 / 解析不出 / 形态不符 → 空态＋留痕，单条形态不符 → 丢该条留其余；
 * 入账侧再设一道把关（坏条目不得借写路径进文件）。写 / 删失败只计数告警、内存态继续（静音状态先例）——
 * 台账损坏或写盘失败都不得让协作主链停下来：丢的是跨重启的持久性，不是当下已成立的接线。
 * joins.json 的写点由接线方显式控制（confirm 成功与名单提交之间不得写盘，见 join.js）。 */

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

function isPositiveInteger(value) {
  return Number.isInteger(value) && value >= 1;
}

/* v1：pendingJoins（待批准申请）+ approvals（本机获准）；v2：pendingJoins 只放未确认 joining。
 * 两版都接受是读侧兼容：0.2.0 只写 v2，v1 存量按原字段读入，不被写回。 */
export function isJoinsShape(record) {
  if (!isRecord(record) || !Array.isArray(record.pendingJoins)) {
    return false;
  }
  if (record.v === 1) {
    return Array.isArray(record.approvals);
  }
  return record.v === 2 && (record.approvals === undefined || Array.isArray(record.approvals));
}

/* joins.json v2 的未确认 joining 记录（设计 §4.4.2/§6.2）：confirmed 不落盘，出现即拒收。 */
export function isJoiningRecordShape(record) {
  return isRecord(record)
    && record.confirmed === undefined
    && isJoiningIdsOk(record)
    && isJoiningTimesOk(record);
}

function isJoiningIdsOk(record) {
  return isIdText(record.joinId)
    && isIdText(record.instanceId)
    && isIdText(record.sessionId)
    && isPositiveInteger(record.managerTerm)
    && isPositiveInteger(record.grantVersion);
}

function isJoiningTimesOk(record) {
  return isMillisecond(record.requestedAt)
    && isMillisecond(record.expiresAt)
    && record.expiresAt >= record.requestedAt;
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

/* 获准判据（契约 §4）：0.2.0 的权威是共享名单与本机席位——台账在就以名单为准；成员机没有
 * 台账，以席位文件为准。approvals 只在既无台账也无席位（尚未升级的旧档）时作只读兼容，
 * 不再参与任何写侧；判据面不可抛，读故障退到下一层。 */
function isGrantedOf(state, sessionId) {
  if (!isIdText(sessionId)) {
    return false;
  }
  try {
    const loaded = loadLedger(state.dataDir, state.collabId);
    const ledger = /** @type {any} */ (loaded.ledger);
    if (ledger !== null) {
      return (ledger.members ?? []).some((member) => member.sessionId === sessionId && member.state === 'member');
    }
  } catch {
    // 台账读不出：交给席位与旧档判据
  }
  const seat = loadSeats(state.dataDir, state.collabId).seats.get(sessionId);
  if (seat !== undefined) {
    return seat.state === 'member' && !isSeatArchived(seat);
  }
  return state.approvals.some((entry) => entry.sessionId === sessionId);
}

/**
 * @param {{ dataDir: string, collabId: string, log: any }} options
 */
export function createJoinsStore({ dataDir, collabId, log }) {
  /** @type {{ collabId: string, log: any, label: string, logFields: Record<string, unknown>, file: string, dataDir: string,
   *   pendingJoins: any[], approvals: any[], legacyFileOnDisk: boolean, legacyBackedUp: boolean, counters: any }} */
  const state = {
    collabId,
    log,
    label: JOINS_LABEL,
    logFields: { collabId },
    file: joinsFilePath(dataDir, collabId),
    dataDir,
    pendingJoins: [],
    approvals: [],
    legacyFileOnDisk: false,
    legacyBackedUp: false,
    counters: {
      corruptLoads: 0, corruptRecords: 0, corruptBackups: 0, corruptBackupFailures: 0,
      persists: 0, persistSkips: 0, persistFailures: 0, clears: 0,
    },
  };
  loadJoins(state);
  return {
    load: () => loadJoins(state),
    pendingJoins: () => cloneRecords(state.pendingJoins),
    approvals: () => cloneRecords(state.approvals),
    addPendingJoin: (record) => addPendingJoin(state, record),
    removePendingJoin: (sessionId) => removePendingJoin(state, sessionId),
    addApproval: (record) => addApproval(state, record),
    isGranted: (sessionId) => isGrantedOf(state, sessionId),
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
    counters: {
      corruptLoads: 0, corruptRecords: 0, corruptBackups: 0, corruptBackupFailures: 0,
      adds: 0, removes: 0, pruned: 0, pruneRefusals: 0, persistFailures: 0,
    },
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
  state.legacyFileOnDisk = isLegacyJoinsPayload(parsed);
  if (!state.legacyFileOnDisk) {
    state.legacyBackedUp = false;
  }
  const pendingShape = parsed.v === 2 ? isJoiningRecordShape : isPendingJoinShape;
  const pendingSection = parsed.v === 2 ? '在途入席' : '待批准';
  state.pendingJoins = keepShapedEntries(state, pendingSection, parsed.pendingJoins, pendingShape);
  state.approvals = Array.isArray(parsed.approvals)
    ? keepShapedEntries(state, '获准', parsed.approvals, isApprovalShape)
    : [];
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

/* 整档损坏的留证（契约 §4/设计 §6.3）：先把原文件改名成 `<file>.corrupt-<ts>`（保留原始字节），
 * 再按空态继续——后续 begin/accept/register 的写入不得静默覆盖排障证据。
 * 目录/无法改名的形态（如路径被目录占住）不搬动：没有「原始字节」可留，原样保持并计数。 */
function traceCorruptLoad(state, reason) {
  state.counters.corruptLoads++;
  const backup = quarantineCorruptFile(state);
  state.log.warn(`${state.label}文件不可用（按空态继续）`, {
    ...state.logFields,
    reason,
    ...(backup === null ? {} : { backup }),
  });
}

function quarantineCorruptFile(state) {
  const backup = `${state.file}.corrupt-${Date.now()}`;
  try {
    if (!statSync(state.file).isFile()) {
      return null;
    }
    renameSync(state.file, backup);
    state.counters.corruptBackups++;
    return backup;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      state.counters.corruptBackupFailures++;
      state.log.warn(`${state.label}损坏文件备份失败（原文件保持不动）`, { ...state.logFields, reason: error.message });
    }
    return null;
  }
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

/* 入账获准（仅旧档内存兼容面）：approvals 段已退役（契约 §4），不再写盘——获准权威是共享
 * 名单 / 本机席位。保留本函数只为旧调用面在同进程内可查，重启后以名单与席位重新判定。 */
function addApproval(state, record) {
  const entry = shapeGuardedEntry(state, '获准', record, isApprovalShape);
  if (entry === null) {
    return false;
  }
  state.approvals = upsertByKey(state.approvals, entry, 'sessionId');
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

/* 落盘只产 v2（契约 §4）：写侧唯一形态 {v:2,pendingJoins}，approvals 不再写回。
 * 旧 v1 待批准条目不是 v2 joining 形态：整档跳过不写——写回会把旧批准面混进 v2，
 * 并可能覆盖加入域刚落的在途 grant。协作目录惰性创建＋原子替换（crash 面只留孤儿临时文件）；
 * 失败只计数告警——内存台账继续服务本会话，丢的是跨重启的持久性，不是当下的批准链。 */
function persistJoins(state) {
  if (!state.pendingJoins.every(isJoiningRecordShape)) {
    state.counters.persistSkips++;
    state.log.warn(`${state.label}含旧 v1 条目（不写回：v2 只落未确认 joining）`, { ...state.logFields });
    return;
  }
  if (backupLegacyJoinsFile(state).ok !== true) {
    return;
  }
  try {
    ensureDir(collabDir(state.dataDir, state.collabId));
    writeJsonAtomic(state.file, { v: 2, pendingJoins: state.pendingJoins });
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

/* 入账申请（同 msgId 幂等）：按 msgId 唯一入账（同一份记录重复入账只刷新而不堆行）。
 * 注：会话级加入的**重发轮换用新 msgId**（发送面每帧生成新标识）——换记录键而不堆行由调用方
 * 先删旧后入账完成；因此「旧 msgId 的回执」在换键之后不再命中（两端认识分叉窗口：站长按旧帧
 * 批准时回执会被拒，由申请人按展示重新申请自愈）。 */
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

/* —— 0.2.0 会话级邀请与两段式入席的三份文件（读写包装；判定与去重归 invites.js） —— */

const INVITES_LABEL = '邀请簿记';
const PENDING_INVITES_LABEL = '挂起邀请';
const JOINING_LABEL = '在途入席台账';
const INVITES_FILE_VERSION = 1;
const PENDING_INVITES_FILE_VERSION = 1;
const JOINS_FILE_VERSION = 2;
const DEFAULT_INVITE_TTL_MS = 24 * 60 * 60 * 1000;

/* 每协作一个 store（唯一键不含 collabId 的两本账不得跨协作复用）；写盘只由 save 显式触发，
 * 这样调用方才能把「内存已确认、名单未提交」的窗口排除在写点之外。 */
/**
 * @param {{ dataDir: string, collabId: string, log: any, now?: () => number, ttlMs?: number }} options
 */
export function createInvitesFileStore({ dataDir, collabId, log, now = Date.now, ttlMs = DEFAULT_INVITE_TTL_MS }) {
  const state = fileStoreStateOf(dataDir, invitesFilePath(dataDir, collabId), INVITES_LABEL, collabId, log);
  const book = createInvitesBook({ now });
  state.ttlMs = Number.isInteger(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_INVITE_TTL_MS;
  loadInvitesFile(state, book);
  return {
    book,
    ttlMs: state.ttlMs,
    load: () => loadInvitesFile(state, book),
    save: () => saveInvitesFile(state, book),
    restore: (records) => restoreInvitesFile(state, book, records),
    list: () => book.list(),
    stats: () => ({ ...state.counters }),
  };
}

/**
 * @param {{ dataDir: string, collabId: string, log: any, now?: () => number, capacity?: number }} options
 */
export function createPendingInvitesFileStore({ dataDir, collabId, log, now = Date.now, capacity }) {
  const state = fileStoreStateOf(dataDir, pendingInvitesFilePath(dataDir, collabId), PENDING_INVITES_LABEL, collabId, log);
  const limit = typeof capacity === 'number' && Number.isInteger(capacity) && capacity > 0 ? capacity : undefined;
  const store = createPendingInvites({ now, ...(limit === undefined ? {} : { capacity: limit }) });
  state.capacity = limit ?? null;
  loadPendingInvitesFile(state, store);
  return {
    store,
    load: () => loadPendingInvitesFile(state, store),
    save: () => savePendingInvitesFile(state, store),
    restore: (records) => restorePendingInvitesFile(state, store, records),
    list: () => store.list(),
    stats: () => ({ ...state.counters, ...store.stats() }),
  };
}

/**
 * @param {{ dataDir: string, collabId: string, log: any, now?: () => number, joiningTtlMs?: number,
 *   maxJoining?: number, maxActiveSeats?: number }} options
 */
export function createJoiningFileStore({
  dataDir, collabId, log, now = Date.now, joiningTtlMs, maxJoining = MAX_JOINING, maxActiveSeats = MAX_ACTIVE_SEATS,
}) {
  const state = fileStoreStateOf(dataDir, joinsFilePath(dataDir, collabId), JOINING_LABEL, collabId, log);
  const ttl = typeof joiningTtlMs === 'number' && Number.isInteger(joiningTtlMs) && joiningTtlMs > 0 ? joiningTtlMs : undefined;
  const registry = createJoiningRegistry({
    now,
    ...(ttl === undefined ? {} : { joiningTtlMs: ttl }),
    maxJoining,
    maxActiveSeats,
  });
  state.collabId = collabId;
  loadJoiningFile(state, registry);
  return {
    registry,
    load: () => loadJoiningFile(state, registry),
    save: () => saveJoiningFile(state, registry),
    restore: (records, options = {}) => restoreJoiningFile(state, registry, records, options),
    list: () => registry.list(),
    pendingJoins: () => registry.pendingJoins(),
    stats: () => ({ ...state.counters, ...registry.stats() }),
  };
}

function fileStoreStateOf(dataDir, file, label, collabId, log) {
  return {
    dataDir,
    file,
    label,
    collabId,
    log,
    logFields: { collabId },
    counters: {
      corruptLoads: 0, corruptRecords: 0, corruptBackups: 0, corruptBackupFailures: 0,
      persists: 0, persistFailures: 0, restored: 0, rejected: 0,
    },
    /* joins.json 的 v1 留档：首次 v2 写前把旧档备份成 `<file>.v1-<ts>`（approvals 不得静默丢弃）。 */
    legacyFileOnDisk: false,
    legacyBackedUp: false,
  };
}

function loadInvitesFile(state, book) {
  const parsed = readParsed(state);
  const records = parsed !== null && isRecord(parsed) && Array.isArray(parsed.invites) ? parsed.invites : [];
  if (parsed !== null && records.length === 0 && !Array.isArray(parsed.invites)) {
    traceCorruptLoad(state, '形态不符');
  }
  const restored = book.restore(records);
  state.counters.restored = restored.ok === true ? restored.restored : 0;
  state.counters.rejected = restored.ok === true ? restored.rejected : records.length;
  return restored;
}

function saveInvitesFile(state, book) {
  return writeStoreFile(state, { version: INVITES_FILE_VERSION, invites: book.list() });
}

function restoreInvitesFile(state, book, records) {
  const restored = book.restore(records);
  state.counters.restored = restored.ok === true ? restored.restored : 0;
  state.counters.rejected = restored.ok === true ? restored.rejected : 0;
  return restored;
}

function loadPendingInvitesFile(state, store) {
  const parsed = readParsed(state);
  const records = parsed !== null && isRecord(parsed) && Array.isArray(parsed.invites) ? parsed.invites : [];
  if (parsed !== null && !Array.isArray(parsed.invites)) {
    traceCorruptLoad(state, '形态不符');
  }
  const options = state.capacity === null ? undefined : { capacity: state.capacity };
  return restorePendingInvitesFile(state, store, records, options);
}

function savePendingInvitesFile(state, store) {
  return writeStoreFile(state, { version: PENDING_INVITES_FILE_VERSION, invites: store.list() });
}

/**
 * @param {any} state
 * @param {any} store
 * @param {any} records
 * @param {object} [options]
 */
function restorePendingInvitesFile(state, store, records, options = undefined) {
  const restored = store.restore(records, options);
  state.counters.restored = restored.ok === true ? restored.restored : 0;
  state.counters.rejected = restored.ok === true ? restored.rejected : 0;
  return restored;
}

/* joins.json 只读 pendingJoins；v1 的旧待批准行没有 joinId/term，交给 restore 逐条拒收并计数。
 * v1 文件只在首次 v2 写前留档，读侧不覆盖它：旧读侧仍可能使用同一文件。 */
function loadJoiningFile(state, registry) {
  const parsed = readParsed(state);
  const records = parsed !== null && isRecord(parsed) && Array.isArray(parsed.pendingJoins) ? parsed.pendingJoins : [];
  if (parsed !== null && !Array.isArray(parsed.pendingJoins)) {
    traceCorruptLoad(state, '形态不符');
  }
  state.legacyFileOnDisk = isLegacyJoinsPayload(parsed);
  if (!state.legacyFileOnDisk) {
    state.legacyBackedUp = false;
  }
  const restored = registry.restore(records, { collabId: state.collabId });
  state.counters.restored = restored.ok === true ? restored.restored : 0;
  state.counters.rejected = restored.ok === true ? restored.rejected : 0;
  return restored;
}

/* v1 旧档（或带 approvals 段的旧形态）：首次 v2 写会让 approvals 退出磁盘——写前必须留档。 */
function isLegacyJoinsPayload(parsed) {
  if (!isRecord(parsed) || !Array.isArray(parsed.pendingJoins)) {
    return false;
  }
  return parsed.v === 1 || (Array.isArray(parsed.approvals) && parsed.approvals.length > 0);
}

function saveJoiningFile(state, registry) {
  const backedUp = backupLegacyJoinsFile(state);
  if (backedUp.ok !== true) {
    return backedUp;
  }
  return writeStoreFile(state, { v: JOINS_FILE_VERSION, pendingJoins: registry.pendingJoins() });
}

/* 首次 v2 写前把 v1 原文件复制为 `<file>.v1-<ts>`（原文件仍由原子写替换；备份保留 approvals 与
 * 旧记录的原始字节，回退 0.1.x 时可人工恢复）。复制失败即拒绝本次写入——宁可晚一轮入席，
 * 也不得未备份就抹掉旧数据（契约 §4「旧文件留盘不删」）。 */
function backupLegacyJoinsFile(state) {
  if (!state.legacyFileOnDisk || state.legacyBackedUp) {
    return { ok: true };
  }
  const backup = `${state.file}.v1-${Date.now()}`;
  try {
    copyFileSync(state.file, backup);
    state.legacyBackedUp = true;
    state.log.info(`${state.label}旧档已留档（首次 v2 写）`, { ...state.logFields, backup });
    return { ok: true, backup };
  } catch (error) {
    if (error.code === 'ENOENT') {
      state.legacyFileOnDisk = false;
      return { ok: true };
    }
    state.counters.persistFailures++;
    state.log.warn(`${state.label}旧档留档失败（拒绝本次 v2 写入，旧数据保持原样）`, { ...state.logFields, reason: error.message });
    return { ok: false, reason: `legacy-backup-failed: ${error.message}` };
  }
}

/* 显式恢复（启动面）：容量上限只作本次裁剪，不写回 registry 的运行期配置（由构造参数决定）。 */
function restoreJoiningFile(state, registry, records, options) {
  const restored = registry.restore(records, { collabId: state.collabId, ...options });
  state.counters.restored = restored.ok === true ? restored.restored : 0;
  state.counters.rejected = restored.ok === true ? restored.rejected : 0;
  return restored;
}

function writeStoreFile(state, payload) {
  try {
    ensureDir(collabDir(state.dataDir, state.collabId));
    writeJsonAtomic(state.file, payload);
    state.counters.persists++;
    return { ok: true };
  } catch (error) {
    state.counters.persistFailures++;
    state.log.warn(`${state.label}写入失败（内存态继续）`, { ...state.logFields, reason: error.message });
    return { ok: false, reason: error.message };
  }
}
