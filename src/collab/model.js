import { randomUUID } from 'node:crypto';
import { DEFAULT_COLLAB_MODE, DIGEST_PATTERN, ID_PATTERN, MAX_ACTIVE_SEATS, MAX_FORUM_ACTIVE_SEATS, MAX_MANAGER_TERM, MAX_MESSAGE_TEXT_CHARS, MAX_TOPIC_CHARS, isCollabMode, isIdentityName, isPort, isPresentationText } from '../net/protocol.js';

/* 协作实例模型（设计 §6/§11）：状态集、迁移表与本地记录形态校验。
 * 本地协作文件（member.json / 台账行 / 快照）是外部输入——手改与旧数据都可能出现；
 * 形态不符一律拒绝，不做清洗（与路径层 / 协议层同一思路）。 */

export const COLLAB_STATES = ['proposed', 'active', 'frozen', 'completed', 'terminated'];
export const LOCAL_LEFT_STATE = 'left';
/* 归档态：不再接受协作域写与消息（快照 / 通告 / 结束 / 退出等只读与幂等类除外，门控在协作层） */
export const ARCHIVED_STATES = ['completed', 'terminated', 'left'];
/* 同名冲突判据的参与状态集（设计 §6：不同名、或机器相同但项目不同都不算冲突） */
export const CONFLICT_STATES = ['proposed', 'active', 'frozen'];
/* 冻结前状态集（解除冻结「回冻结前状态」的取值域；抢接 / 降级后恢复的成员态由此映射） */
export const FROZEN_FROM_STATES = ['proposed', 'active'];
/* 协作域边界常量（服务内多模块共用；上界防失控，取值按人机协作量级）：待回应邀请上限、
 * 本机参与协作上限、任务板上限、邀请限频记录表容量。 */
export const MAX_PENDING_INVITES = 16;
export const MAX_LOCAL_COLLABS = 64;
export const MAX_BOARD_ENTRIES = 200;
export const INVITE_THROTTLE_TABLE_MAX = 64;
/* 讨论活跃席位软顶（设计 §2.5，邀请侧软约束）：按活跃会话计、历史行不占；协议硬顶仍是 32。 */
export const MAX_FORUM_MEMBERS = MAX_FORUM_ACTIVE_SEATS;

const ROLES = ['manager', 'member'];
const DECISIONS = [null, 'approved', 'declined', 'withdrawn'];
const BOARD_KINDS = ['progress', 'note'];
/* 状态迁移表（设计 §11 状态流转的机器化；裁定流程归治理里程碑，本表是其调用面） */
const TRANSITIONS = /** @type {Record<string, string[]>} */ ({
  proposed: ['active', 'completed', 'frozen', 'terminated'],
  active: ['frozen', 'completed'],
  frozen: ['proposed', 'active', 'completed', 'terminated'],
  completed: [],
  terminated: [],
});

/* 讨论模式的迁移表（四态去冻结，设计 §3/§4）：冻结态不可达、冻结规程不适用。
 * 与 managed 表的差异只有冻结面——其余边同形，收敛/终态语义两模式一致。 */
const FORUM_TRANSITIONS = /** @type {Record<string, string[]>} */ ({
  proposed: ['active', 'completed', 'terminated'],
  active: ['completed'],
  completed: [],
  terminated: [],
});

export function newCollabId() {
  return randomUUID();
}

export function isCollabState(value) {
  return typeof value === 'string' && COLLAB_STATES.includes(value);
}

export function isArchived(state) {
  return typeof state === 'string' && ARCHIVED_STATES.includes(state);
}

/* 状态迁移判定（模式相关）：mode 缺省 managed——既有调用点（治理冻结 / 解冻）零变化；
 * 讨论实例的冻结边一律拒绝（冻结态不可达，不依赖调用方自觉避开）。 */
export function canTransition(from, to, mode = DEFAULT_COLLAB_MODE) {
  const table = mode === 'forum' ? FORUM_TRANSITIONS : TRANSITIONS;
  const allowed = table[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

/* 载入兼容（对照 port 缺省先例）：缺 mode 的旧记录按 managed 解释——读取侧宽容、写入侧写全。
 * 就地补写缺省值（调用方随后按完整形态消费与落盘）。 */
export function withDefaultMode(record) {
  if (record.mode === undefined) {
    record.mode = DEFAULT_COLLAB_MODE;
  }
  return record;
}

/* 台账对象形态（单一权威形态的校验面）：字段逐一校验；校验通过的对象可参与 digest 计算。
 * 名单只含活跃席位（state=member）；managed 非终态恰一站长且 manager 非空，终态必须 manager:null
 * （可空名单）；forum 不要求 manager / joinSeq（D10/D17）。 */
export function isLedgerShape(ledger) {
  if (!isPlainObject(ledger) || !isLedgerHeadShape(ledger)) {
    return false;
  }
  const mode = ledger.mode ?? DEFAULT_COLLAB_MODE;
  const terminal = isTerminalStatus(ledger.status);
  if (!isManagerWindowShape(ledger.managerWindow, terminal, ledger.managerTerm)) {
    return false;
  }
  if (!isLedgerRosterShape(ledger.members, { mode, allowEmpty: terminal })) {
    return false;
  }
  if (!isLedgerTailShape(ledger)) {
    return false;
  }
  return mode === 'forum' ? isForumLedgerShape(ledger) : isManagedLedgerShape(ledger, terminal);
}

/* 终态台账（设计 §3.4：status∈{completed,terminated} 必须 manager:null 且无残留窗口）。
 * 反向判据在形态校验器里：非终态必须 manager 非空，终态 status 配非空 manager 按损坏拒收。
 * 任期判定与快照比较共用本函数，不得另立终态词表（单一权威源）。 */
export function isTerminalLedger(ledger) {
  if (!isPlainObject(ledger) || !isTerminalStatus(ledger.status)) {
    return false;
  }
  return ledger.manager === null && ledger.managerWindow === undefined;
}

/* 席位名单（共享名单的唯一形态）：{instanceId,sessionId,identityName,role,state:'member',joinSeq,joinedAt}；
 * 唯一性键 (instanceId,sessionId)——同机多会话各自成席；managed 要求 joinSeq、forum 可省。 */
export function isLedgerRosterShape(members, { mode = DEFAULT_COLLAB_MODE, allowEmpty = false } = {}) {
  if (!isRosterSizeShape(members, allowEmpty)) {
    return false;
  }
  const seen = new Set();
  let lastJoinSeq = 0;
  for (const entry of members) {
    if (!isSeatMemberShape(entry, mode)) {
      return false;
    }
    if (mode === DEFAULT_COLLAB_MODE) {
      /* joinSeq 单调不减（设计 §2.5/§6.3）：严格递减是损坏；相等允许（分区期间重复序号，按席位破平）。 */
      if (entry.joinSeq < lastJoinSeq) {
        return false;
      }
      lastJoinSeq = entry.joinSeq;
    }
    const key = `${entry.instanceId}\u0000${entry.sessionId}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
  }
  return true;
}

function isRosterSizeShape(members, allowEmpty) {
  if (!Array.isArray(members)) {
    return false;
  }
  const minSize = allowEmpty ? 0 : 1;
  return members.length >= minSize && members.length <= MAX_ACTIVE_SEATS;
}

function isSeatMemberShape(entry, mode) {
  if (!isSeatIdentityShape(entry)) {
    return false;
  }
  /* forum 无站长（D10）：中继/发起人只记在 manager 字段，名单行不得出现 role=manager。 */
  if (mode !== DEFAULT_COLLAB_MODE && entry.role !== 'member') {
    return false;
  }
  if (!ROLES.includes(entry.role) || entry.state !== 'member') {
    return false;
  }
  if (!isOptionalSeqValue(entry.joinSeq)) {
    return false;
  }
  if (mode === DEFAULT_COLLAB_MODE && entry.joinSeq === undefined) {
    return false;
  }
  return isTimestamp(entry.joinedAt);
}

function isSeatIdentityShape(entry) {
  return isPlainObject(entry)
    && isIdLike(entry.instanceId)
    && isIdLike(entry.sessionId)
    && isIdentityName(entry.identityName);
}

function isOptionalSeqValue(value) {
  return value === undefined || isSeqValue(value);
}

function isTerminalStatus(status) {
  return status === 'completed' || status === 'terminated';
}

function isManagedLedgerShape(ledger, terminal) {
  if (!isSeqValue(ledger.joinSeqNext)) {
    return false;
  }
  if (ledger.manager === null) {
    return terminal && !ledger.members.some((entry) => entry.role === 'manager');
  }
  /* 终态 status 必须 manager:null（设计 §3.4）：终态 + 非空 manager 是损坏，不得当活跃台账受理。 */
  if (terminal || !isManagerSeatShape(ledger.manager) || ledger.manager.term !== ledger.managerTerm) {
    return false;
  }
  return managerRowMatches(ledger);
}

function isManagerSeatShape(manager) {
  return isPlainObject(manager)
    && isIdLike(manager.instanceId)
    && isIdLike(manager.sessionId)
    && isIdentityName(manager.identityName)
    && isSeqValue(manager.term);
}

function managerRowMatches(ledger) {
  const rows = ledger.members.filter((entry) => entry.role === 'manager');
  if (rows.length !== 1) {
    return false;
  }
  const row = rows[0];
  return row.instanceId === ledger.manager.instanceId
    && row.sessionId === ledger.manager.sessionId
    && row.identityName === ledger.manager.identityName;
}

/* forum：manager 字段可作中继/发起人记录（D10），名单行不带 joinSeq；无站长更替 ⇒ 不接受 managerWindow。 */
function isForumLedgerShape(ledger) {
  if (ledger.managerWindow !== undefined) {
    return false;
  }
  if (ledger.joinSeqNext !== undefined && !isSeqValue(ledger.joinSeqNext)) {
    return false;
  }
  return ledger.manager === undefined || ledger.manager === null || isForumManagerShape(ledger.manager);
}

function isForumManagerShape(manager) {
  if (!isPlainObject(manager) || !isIdLike(manager.instanceId) || !isIdentityName(manager.identityName)) {
    return false;
  }
  if (manager.sessionId !== undefined && !isIdLike(manager.sessionId)) {
    return false;
  }
  return manager.term === undefined || isSeqValue(manager.term);
}

function isManagerWindowShape(window, terminal, managerTerm) {
  if (window === undefined) {
    return true;
  }
  if (terminal) {
    return false;
  }
  /* 窗口由 auto 变更在「新任期」上开启（§2A.5③：managerWindow.windowBaseTerm = 变更后的 managerTerm）；
   * 更高 term 的变更会关闭旧窗口——陈旧窗口（base < term）一律按损坏拒收。 */
  return isPlainObject(window)
    && isSeqValue(window.windowBaseTerm)
    && window.windowBaseTerm === managerTerm
    && isTimestamp(window.windowEndsAt);
}

function isSeqValue(value) {
  return Number.isInteger(value) && value >= 1 && value <= MAX_MANAGER_TERM;
}

function isLedgerTailShape(ledger) {
  if (!Array.isArray(ledger.board) || !ledger.board.every(isBoardEntryShape)) {
    return false;
  }
  if (!isModeShape(ledger)) {
    return false;
  }
  if (!isTimestamp(ledger.createdAt) || !isTimestamp(ledger.updatedAt)) {
    return false;
  }
  if (ledger.endedAt !== undefined && !isTimestamp(ledger.endedAt)) {
    return false;
  }
  /* 讨论的成立时刻（首个他方 join 的落账时刻，可选字段——managed 台账不携带）。 */
  if (ledger.establishedAt !== undefined && !isTimestamp(ledger.establishedAt)) {
    return false;
  }
  return isFrozenMarksShape(ledger);
}

/* 冻结标记（可选字段，旧数据缺省）：frozenAt = 进入冻结的时刻（48 小时无裁定提示的计时起点）；
 * frozenFrom = 冻结前状态（解除冻结「回冻结前状态」的依据）。 */
function isFrozenMarksShape(record) {
  if (record.frozenAt !== undefined && !isTimestamp(record.frozenAt)) {
    return false;
  }
  return record.frozenFrom === undefined || FROZEN_FROM_STATES.includes(record.frozenFrom);
}

/* 模式字段（可选，旧数据缺省）：缺省按 managed 解释（读取侧宽容）；出现即须为词表内取值
 * ——脏值拒绝，不做清洗（与本文件「形态不符一律拒绝」同一思路）。 */
function isModeShape(record) {
  return record.mode === undefined || isCollabMode(record.mode);
}

/* 本地参与记录（member.json）：role 与 state 是本地视角；decision 缺省 null（旧字段缺失兼容）。
 * roster = 邀请阶段定格的名单（冲突交集判据的成员侧数据源；成员侧不逐次随台账更新——判据只
 * 需要「本机与谁同行」这一事实，定格名单在协作存续期不变化到影响判据）。 */
export function isMemberRecordShape(record) {
  if (!isPlainObject(record)) {
    return false;
  }
  if (!isIdLike(record.collabId) || !isIdentityName(record.name)) {
    return false;
  }
  if (!ROLES.includes(record.role)) {
    return false;
  }
  if (!isCollabState(record.state) && record.state !== LOCAL_LEFT_STATE) {
    return false;
  }
  if (!isPeerShape(record.manager) || !isEndpointsShape(record.endpoints)) {
    return false;
  }
  if (!isRosterShape(record.roster)) {
    return false;
  }
  return isMemberMarksShape(record);
}

function isRosterShape(roster) {
  if (!Array.isArray(roster) || roster.length < 1 || roster.length > MAX_ACTIVE_SEATS) {
    return false;
  }
  return roster.every((entry) => isPlainObject(entry) && isIdLike(entry.instanceId) && isIdentityName(entry.identityName));
}

/* 快照（snapshot.json）：结构 + 内嵌台账形态（digest 的重算比对属接收方职责）。 */
export function isSnapshotShape(snapshot) {
  if (!isPlainObject(snapshot)) {
    return false;
  }
  if (!Number.isInteger(snapshot.version) || snapshot.version < 1) {
    return false;
  }
  if (typeof snapshot.digest !== 'string' || !DIGEST_PATTERN.test(snapshot.digest)) {
    return false;
  }
  if (!isTimestamp(snapshot.receivedAt) || !isPeerShape(snapshot.from)) {
    return false;
  }
  return isLedgerShape(snapshot.ledger);
}

/* 快照受理排序（设计 §2A.2 / §2A.10）：按 (managerTerm, version) 字典序；同 term 不同 manager 是分叉，
 * 不比较 version（A8/A12）；同 term/version/manager 幂等（A7/A13）。入参可为快照（{ledger}）或台账本身。
 * 形态非法返回 ok:false，由调用方按「无法判定」处置（不猜顺序）。 */
export function compareSnapshot(left, right) {
  const a = ledgerStateOf(left);
  const b = ledgerStateOf(right);
  if (a === null || b === null) {
    return { ok: false, reason: '快照形态非法（需 managerTerm/version；终态 status 配 manager:null，非终态配席位 manager）', order: 0, conflict: false, idempotent: false };
  }
  if (a.term !== b.term) {
    return { ok: true, order: a.term > b.term ? 1 : -1, conflict: false, idempotent: false };
  }
  if (a.managerKey !== b.managerKey) {
    return { ok: true, order: 0, conflict: true, idempotent: false };
  }
  if (a.version !== b.version) {
    return { ok: true, order: a.version > b.version ? 1 : -1, conflict: false, idempotent: false };
  }
  return { ok: true, order: 0, conflict: false, idempotent: true };
}

function ledgerStateOf(value) {
  if (!isPlainObject(value)) {
    return null;
  }
  const ledger = isPlainObject(value.ledger) ? value.ledger : value;
  if (!isSnapshotHeadShape(ledger)) {
    return null;
  }
  const managerKey = snapshotManagerKeyOf(ledger);
  return managerKey === null ? null : { term: ledger.managerTerm, version: ledger.version, managerKey };
}

function isSnapshotHeadShape(ledger) {
  return isSeqValue(ledger.managerTerm) && Number.isInteger(ledger.version) && ledger.version >= 1;
}

/* 终态台账允许 manager:null（D17）：空 manager 键参与同 term 比较（双方 null 比 version/幂等，
 * 一方 null 一方非 null → 冲突），不得因终态而拒绝排序；非终态空 manager 与「终态 status 配席位
 * manager」都是损坏，返回 null 由调用方按无法判定处置。 */
function snapshotManagerKeyOf(ledger) {
  if (ledger.manager === null) {
    return isTerminalLedger(ledger) ? '' : null;
  }
  if (isTerminalStatus(ledger.status) || !isSeatRefLike(ledger.manager)) {
    return null;
  }
  return `${ledger.manager.instanceId}\u0000${ledger.manager.sessionId}`;
}

function isSeatRefLike(manager) {
  return isPlainObject(manager) && isIdLike(manager.instanceId) && isIdLike(manager.sessionId);
}

function isLedgerHeadShape(ledger) {
  if (!Number.isInteger(ledger.version) || ledger.version < 1) {
    return false;
  }
  if (!isSeqValue(ledger.managerTerm)) {
    return false;
  }
  if (!isIdLike(ledger.collabId)) {
    return false;
  }
  if (!isIdentityName(ledger.name)) {
    return false;
  }
  if (!isPresentationText(ledger.topic, MAX_TOPIC_CHARS)) {
    return false;
  }
  return isCollabState(ledger.status);
}

function isBoardEntryShape(entry) {
  if (!isPlainObject(entry)) {
    return false;
  }
  if (!isIdLike(entry.entryId) || !isTimestamp(entry.ts)) {
    return false;
  }
  if (!isPeerShape(entry.from) || !BOARD_KINDS.includes(entry.kind)) {
    return false;
  }
  return typeof entry.text === 'string' && entry.text.trim() !== '' && entry.text.length <= MAX_MESSAGE_TEXT_CHARS;
}

function isMemberMarksShape(record) {
  if (!isModeShape(record) || !isMemberTimestampsShape(record)) {
    return false;
  }
  if (!DECISIONS.includes(record.decision ?? null)) {
    return false;
  }
  if (!isForumMemberMarksShape(record)) {
    return false;
  }
  return isFrozenMarksShape(record);
}

/* 邀请簿记与归档时刻（可选字段，出现即须为时间戳）。 */
function isMemberTimestampsShape(record) {
  if (record.invitedAt !== undefined && !isTimestamp(record.invitedAt)) {
    return false;
  }
  if (record.expiresAt !== undefined && !isTimestamp(record.expiresAt)) {
    return false;
  }
  return record.archivedAt === undefined || isTimestamp(record.archivedAt);
}

/* 讨论专用可选字段（旧记录缺省）：topic = 邀请/元状态学得的主题（成员侧发起邀请的取数面）；
 * forumMeta = 学得的讨论元状态时刻（成立/结束/创建）；syncCursor = 专用同步游标（只由拉取推进）；
 * originator = 发起人实例标识（= 中继归属；随邀请载荷 / bundle 元状态学得，身份对形态）。 */
function isForumMemberMarksShape(record) {
  if (record.topic !== undefined && !isPresentationText(record.topic, MAX_TOPIC_CHARS)) {
    return false;
  }
  if (record.originator !== undefined && !isPeerShape(record.originator)) {
    return false;
  }
  if (!isForumMetaShape(record.forumMeta)) {
    return false;
  }
  return isSyncCursorShape(record.syncCursor);
}

function isForumMetaShape(meta) {
  if (meta === undefined) {
    return true;
  }
  if (!isPlainObject(meta)) {
    return false;
  }
  return ['createdAt', 'establishedAt', 'endedAt'].every((field) => meta[field] === undefined || isTimestamp(meta[field]));
}

/* 同步游标（可选字段，旧记录缺省）：{ ts, postId } 复合位置或 null（空游标 = 全量拉取起点）。 */
function isSyncCursorShape(cursor) {
  if (cursor === undefined || cursor === null) {
    return true;
  }
  if (!isPlainObject(cursor)) {
    return false;
  }
  return isTimestamp(cursor.ts) && typeof cursor.postId === 'string' && ID_PATTERN.test(cursor.postId);
}

function isEndpointsShape(endpoints) {
  if (!isPlainObject(endpoints)) {
    return false;
  }
  for (const [instanceId, endpoint] of Object.entries(endpoints)) {
    if (typeof instanceId !== 'string' || !ID_PATTERN.test(instanceId) || !isEndpointShape(endpoint)) {
      return false;
    }
  }
  return true;
}

function isEndpointShape(endpoint) {
  if (!isPlainObject(endpoint)) {
    return false;
  }
  if (typeof endpoint.address !== 'string' || endpoint.address === '') {
    return false;
  }
  return isPort(endpoint.port);
}

/* 身份对 / 时间戳判据（导出：讨论元状态的学习面与加载面共用同一权威——学习面若宽于加载面，
 * 网络数据会被学入并持久化，重启时整条协作记录按坏数据被跳过且无自愈）。 */
export function isPeerShape(peer) {
  return isPlainObject(peer) && isIdLike(peer.instanceId) && isIdentityName(peer.identityName);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIdLike(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

export function isTimestamp(value) {
  return typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value));
}
