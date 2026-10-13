import { randomUUID } from 'node:crypto';
import { DEFAULT_COLLAB_MODE, DIGEST_PATTERN, ID_PATTERN, MAX_COLLAB_MEMBERS, MAX_MESSAGE_TEXT_CHARS, MAX_TOPIC_CHARS, isCollabMode, isIdentityName, isPort, isPresentationText } from '../net/protocol.js';

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
/* 讨论参与者上限（设计 §9，邀请侧软约束）：成员表 ≥16 拒绝发起新邀请、创建 targets ≤15
 *（含发起人共 16）；join / 合并不设限（保收敛）、协议层名单硬顶 MAX_COLLAB_MEMBERS 照旧。 */
export const MAX_FORUM_MEMBERS = 16;

const MEMBER_STATES = ['invited', 'approved', 'declined', 'withdrawn', 'member', 'left'];
const ROLES = ['manager', 'member'];
const DECISIONS = [null, 'approved', 'declined', 'withdrawn'];
const BOARD_KINDS = ['progress', 'note'];
/* 状态迁移表（设计 §11 状态流转的机器化；裁定流程归治理里程碑，本表是其调用面） */
const TRANSITIONS = /** @type {Record<string, string[]>} */ ({
  proposed: ['active', 'frozen', 'terminated'],
  active: ['frozen', 'completed'],
  frozen: ['proposed', 'active', 'completed', 'terminated'],
  completed: [],
  terminated: [],
});

/* 讨论模式的迁移表（四态去冻结，设计 §3/§4）：冻结态不可达、冻结规程不适用。
 * 与 managed 表的差异只有冻结面——其余边同形，收敛/终态语义两模式一致。 */
const FORUM_TRANSITIONS = /** @type {Record<string, string[]>} */ ({
  proposed: ['active', 'terminated'],
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

/* 台账对象形态（单一权威形态的校验面）：字段逐一校验；校验通过的对象可参与 digest 计算。 */
export function isLedgerShape(ledger) {
  if (!isPlainObject(ledger) || !isLedgerHeadShape(ledger)) {
    return false;
  }
  if (!isPeerShape(ledger.manager)) {
    return false;
  }
  if (!isLedgerRosterShape(ledger.members)) {
    return false;
  }
  return isLedgerTailShape(ledger);
}

function isLedgerRosterShape(members) {
  return Array.isArray(members)
    && members.length >= 1
    && members.length <= MAX_COLLAB_MEMBERS
    && members.every(isLedgerMemberShape);
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
  if (!Array.isArray(roster) || roster.length < 1 || roster.length > MAX_COLLAB_MEMBERS) {
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

function isLedgerHeadShape(ledger) {
  if (!Number.isInteger(ledger.version) || ledger.version < 1) {
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

function isLedgerMemberShape(entry) {
  if (!isPlainObject(entry)) {
    return false;
  }
  if (!isIdLike(entry.instanceId) || !isIdentityName(entry.identityName)) {
    return false;
  }
  if (!ROLES.includes(entry.role) || !MEMBER_STATES.includes(entry.state)) {
    return false;
  }
  return isTimestamp(entry.joinedAt);
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
