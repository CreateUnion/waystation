import { randomUUID } from 'node:crypto';
import { DIGEST_PATTERN, ID_PATTERN, MAX_COLLAB_MEMBERS, MAX_MESSAGE_TEXT_CHARS, MAX_TOPIC_CHARS, isIdentityName, isPresentationText } from '../net/protocol.js';

/* 协作实例模型（设计 §6/§11）：状态集、迁移表与本地记录形态校验。
 * 本地协作文件（member.json / 台账行 / 快照）是外部输入——手改与旧数据都可能出现；
 * 形态不符一律拒绝，不做清洗（与路径层 / 协议层同一思路）。 */

export const COLLAB_STATES = ['proposed', 'active', 'frozen', 'completed', 'terminated'];
export const LOCAL_LEFT_STATE = 'left';
/* 归档态：不再接受协作域写与消息（快照 / 通告 / 结束 / 退出等只读与幂等类除外，门控在协作层） */
export const ARCHIVED_STATES = ['completed', 'terminated', 'left'];
/* 同名冲突判据的参与状态集（设计 §6：不同名、或机器相同但项目不同都不算冲突） */
export const CONFLICT_STATES = ['proposed', 'active', 'frozen'];
/* 协作域边界常量（服务内多模块共用；上界防失控，取值按人机协作量级）：待回应邀请上限、
 * 本机参与协作上限、任务板上限、邀请限频记录表容量。 */
export const MAX_PENDING_INVITES = 16;
export const MAX_LOCAL_COLLABS = 64;
export const MAX_BOARD_ENTRIES = 200;
export const INVITE_THROTTLE_TABLE_MAX = 64;

const MEMBER_STATES = ['invited', 'approved', 'declined', 'withdrawn', 'member', 'left'];
const ROLES = ['manager', 'member'];
const DECISIONS = [null, 'approved', 'declined', 'withdrawn'];
const BOARD_KINDS = ['progress', 'note'];
/* 状态迁移表（设计 §11 状态流转的机器化；裁定流程归后续治理里程碑，本表是其调用面） */
const TRANSITIONS = /** @type {Record<string, string[]>} */ ({
  proposed: ['active', 'frozen', 'terminated'],
  active: ['frozen', 'completed'],
  frozen: ['proposed', 'active', 'completed', 'terminated'],
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

export function canTransition(from, to) {
  const allowed = TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
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
  if (!isTimestamp(ledger.createdAt) || !isTimestamp(ledger.updatedAt)) {
    return false;
  }
  return ledger.endedAt === undefined || isTimestamp(ledger.endedAt);
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
  if (record.invitedAt !== undefined && !isTimestamp(record.invitedAt)) {
    return false;
  }
  if (record.expiresAt !== undefined && !isTimestamp(record.expiresAt)) {
    return false;
  }
  if (!DECISIONS.includes(record.decision ?? null)) {
    return false;
  }
  return record.archivedAt === undefined || isTimestamp(record.archivedAt);
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
  return Number.isInteger(endpoint.port) && endpoint.port >= 1 && endpoint.port <= 65535;
}

function isPeerShape(peer) {
  return isPlainObject(peer) && isIdLike(peer.instanceId) && isIdentityName(peer.identityName);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIdLike(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function isTimestamp(value) {
  return typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value));
}
