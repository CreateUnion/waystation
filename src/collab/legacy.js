import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ID_PATTERN, MAX_COLLAB_MEMBERS, MAX_TOPIC_CHARS, isCollabMode, isIdentityName, isPort, isPresentationText } from '../net/protocol.js';
import { writeJsonAtomic } from '../storage.js';
import { CARRIER_FORMAT_SESSION_SEATS, readCarrierFormat } from './carrier.js';
import { foldMemberEvents, isMemberEventShape } from './members.js';
import { MIGRATION_FILE_NAME, RECOVERY_FILE_NAME, isMigrationShape, readMigration, readRecovery } from './migration.js';

/* 存量（0.1.x）协作的只读面（设计 §8）：旧目录以 member.json 为本地参与记录、台账形态也没有
 * sessionId/joinSeq/managerTerm。0.2.0 把它们整目录归档为只读 legacy，不做迁移改写——
 * 因此本文件的判据与读取器必须自带「旧形态」校验，不能复用会随 0.2.0 改形的 model.js 校验器。
 * 读取面零写盘：台账尾部半行只忽略，绝不截断（截断修复属存储写面）。 */

const MEMBER_FILE_NAME = 'member.json';
const SNAPSHOT_FILE_NAME = 'snapshot.json';
const LEDGER_FILE_NAME = 'ledger.jsonl';
const MEMBERS_FILE_NAME = 'members.jsonl';
const LOCAL_LEFT_STATE = 'left';
const LEGACY_ROLES = ['manager', 'member'];
const LEGACY_MEMBER_STATES = ['invited', 'approved', 'declined', 'withdrawn', 'member', 'left'];
const LEGACY_COLLAB_STATES = ['proposed', 'active', 'frozen', 'completed', 'terminated'];

export const DEFAULT_LEGACY_REASON = 'legacy-format';

/** legacy 判据（设计 §8）：有旧 member.json，且 carrier 没有新形态 format 标记，且无
 * migration/recovery 标记。缺 carrier 且无 member.json 的目录不自动判 legacy（按损坏另处理）。
 * 已写 migration.json 的目录不再算「待迁移 legacy」，但仍是可读档案（见 legacyReadable）。 */
export function isLegacyCollab(dir) {
  return isLegacyReadable(dir) && readMigration(dir) === null;
}

/* 可读档案面：未迁移的旧目录与已归档旧目录都可读；新形态目录与半写恢复目录不可读。 */
function isLegacyReadable(dir) {
  if (readCarrierFormat(dir) !== null) {
    return false;
  }
  if (readRecovery(dir) !== null) {
    return false;
  }
  return existsSync(join(dir, MEMBER_FILE_NAME));
}

/** 写门（设计 §6.4）：legacy、半写新协作、已有 recovery 标记的目录一律拒绝写。
 * 内存标记（legacy/recovery）优先——启动迁移在内存里保留判定，文件标记只是重启后的证据。
 * 返回值不抛出：调用方按 reason 转成工具错误/入站拒绝计数。 */
export function assertWritable(collabDir, options = {}) {
  if (options.legacy === true) {
    return { ok: false, reason: 'legacy', detail: 'memory-flag' };
  }
  if (options.recovery === true) {
    return { ok: false, reason: 'recovery', detail: 'memory-flag' };
  }
  if (readMigration(collabDir) !== null) {
    return { ok: false, reason: 'legacy', detail: MIGRATION_FILE_NAME };
  }
  if (readRecovery(collabDir) !== null) {
    return { ok: false, reason: 'recovery', detail: RECOVERY_FILE_NAME };
  }
  if (isHalfCreated(collabDir)) {
    return { ok: false, reason: 'recovery', detail: 'carrier-without-ledger' };
  }
  if (isLegacyCollab(collabDir)) {
    return { ok: false, reason: 'legacy', detail: 'member.json' };
  }
  return { ok: true };
}

/* 半写：新形态标记已落、台账未落。invite-stub 无台账属合法形态，不在此列（设计 §8）。 */
function isHalfCreated(dir) {
  return readCarrierFormat(dir) === CARRIER_FORMAT_SESSION_SEATS && !existsSync(join(dir, LEDGER_FILE_NAME));
}

/** 归档标记：原子写 migration.json，幂等（已有合规标记不重写）；失败只告警并返回失败结果，
 * 调用方继续按只读处理（失败安全），不改写旧台账。 */
export function markLegacyCompleted(collabDir, options = {}) {
  const existing = readMigration(collabDir);
  if (existing !== null) {
    return { ok: true, record: existing, written: false };
  }
  if (!isLegacyCollab(collabDir)) {
    return { ok: false, record: null, written: false, error: new Error('目录不是 legacy 形态，拒绝写 migration.json') };
  }
  const record = {
    legacy: true,
    archivedAt: options.now ?? new Date().toISOString(),
    reason: options.reason ?? DEFAULT_LEGACY_REASON,
  };
  if (!isMigrationShape(record)) {
    return { ok: false, record: null, written: false, error: new TypeError('migration.json 形态入参非法，拒绝写入') };
  }
  try {
    writeJsonAtomic(join(collabDir, MIGRATION_FILE_NAME), record);
  } catch (error) {
    const warn = typeof options.warn === 'function' ? options.warn : defaultWarn;
    warn(`[waystation] legacy 归档标记写入失败，继续按只读处理：${collabDir}（${error.message}）`);
    return { ok: false, record: null, written: false, error };
  }
  return { ok: true, record, written: true };
}

/** 只读摘要（列表/观察窗）：state 按设计显示为 completed；最后已知状态留在 sourceState。
 * 台账末条合法行优先，其次快照台账，最后成员记录的定格名单。非旧形态目录返回 null。 */
export function readLegacyCollab(dir) {
  if (!isLegacyReadable(dir)) {
    return null;
  }
  const warnings = [];
  const member = readLegacyMember(dir, warnings);
  const snapshotLedger = readLegacySnapshot(dir, warnings);
  const ledger = readLastLegacyLedger(dir, warnings);
  const summary = legacySummary(dir, member, ledger ?? snapshotLedger, warnings);
  return applyForumRoster(summary, dir, warnings);
}

/* 讨论的当前成员表来自成员事件折叠（旧 member.json 的 roster 只是邀请定格名单）。 */
function applyForumRoster(summary, dir, warnings) {
  if (summary.mode !== 'forum') {
    return summary;
  }
  const events = readLegacyMemberEvents(dir, warnings);
  if (events.length === 0) {
    return summary;
  }
  const roster = foldMemberEvents(events).map((entry) => ({
    instanceId: entry.instanceId,
    identityName: entry.identityName,
    role: null,
    state: null,
  }));
  return { ...summary, roster, memberCount: roster.length };
}

function readLegacyMemberEvents(dir, warnings) {
  const text = readTextFile(join(dir, MEMBERS_FILE_NAME), warnings, MEMBERS_FILE_NAME);
  if (text === undefined) {
    return [];
  }
  const events = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    const parsed = parseJsonOrNull(line);
    if (parsed === null || !isMemberEventShape(parsed)) {
      skipped += 1;
      continue;
    }
    events.push(parsed);
  }
  if (skipped > 0) {
    warnings.push(`members.jsonl 有 ${skipped} 行不是合法成员事件，已跳过（只读不修复）`);
  }
  return events;
}

function legacySummary(dir, member, current, warnings) {
  const roster = rosterOf(current, member);
  return {
    legacy: true,
    readOnly: true,
    state: 'completed',
    ...legacyIdentity(dir, member, current),
    ...legacySeatField(member, current),
    memberCount: roster.length,
    roster,
    archivedAt: archivedAtOf(readMigration(dir)),
    warnings,
  };
}

function legacyIdentity(dir, member, current) {
  return {
    collabId: sourceField(current, member, 'collabId') ?? basename(dir),
    name: sourceField(current, member, 'name') ?? null,
    topic: sourceField(current, member, 'topic') ?? null,
    mode: member?.mode ?? current?.mode ?? 'managed',
  };
}

function legacySeatField(member, current) {
  return {
    sourceState: sourceField(current, member, 'status') ?? member?.state ?? null,
    role: member?.role ?? null,
    manager: sourceField(current, member, 'manager') ?? null,
  };
}

/* 摘要取数：台账/快照优先、成员记录兜底；都没有时返回 undefined（调用方决定回退值）。 */
function sourceField(current, member, field) {
  if (current !== null && current[field] !== undefined) {
    return current[field];
  }
  if (member === null) {
    return undefined;
  }
  return member[field];
}

function archivedAtOf(migration) {
  return migration === null ? null : migration.archivedAt;
}

function rosterOf(ledger, member) {
  if (ledger !== null) {
    return ledger.members.map((entry) => ({
      instanceId: entry.instanceId,
      identityName: entry.identityName,
      role: entry.role,
      state: entry.state,
    }));
  }
  if (member !== null) {
    return member.roster.map((entry) => ({ instanceId: entry.instanceId, identityName: entry.identityName, role: null, state: null }));
  }
  return [];
}

function readLegacyMember(dir, warnings) {
  const loaded = readJsonFile(join(dir, MEMBER_FILE_NAME), warnings, MEMBER_FILE_NAME);
  if (loaded === undefined || loaded === null) {
    return null;
  }
  if (!isLegacyMemberRecord(loaded)) {
    warnings.push('member.json 形态不符（旧判据），已忽略');
    return null;
  }
  return loaded;
}

function readLegacySnapshot(dir, warnings) {
  const loaded = readJsonFile(join(dir, SNAPSHOT_FILE_NAME), warnings, SNAPSHOT_FILE_NAME);
  if (loaded === undefined || loaded === null) {
    return null;
  }
  if (!isPlainObject(loaded) || !isLegacyLedger(loaded.ledger)) {
    warnings.push('snapshot.json 形态不符（旧判据），已忽略');
    return null;
  }
  return loaded.ledger;
}

function readTextFile(filePath, warnings, label) {
  try {
    return readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      warnings.push(`${label} 读取失败（${error.code ?? error.message}）`);
    }
    return undefined;
  }
}

/* 读取结果 undefined=缺失、null=存在但解析失败；两种都返回 null 给调用方，解析失败已留告警。 */
function readJsonFile(filePath, warnings, label) {
  const text = readTextFile(filePath, warnings, label);
  if (text === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    warnings.push(`${label} 解析失败（按缺失处理）`);
    return null;
  }
}

function readLastLegacyLedger(dir, warnings) {
  const text = readTextFile(join(dir, LEDGER_FILE_NAME), warnings, 'ledger.jsonl');
  if (text === undefined) {
    return null;
  }
  let last = null;
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    const parsed = parseJsonOrNull(line);
    if (parsed === null || !isLegacyLedger(parsed)) {
      skipped += 1;
      continue;
    }
    last = parsed;
  }
  if (skipped > 0) {
    warnings.push(`ledger.jsonl 有 ${skipped} 行不是合法旧台账，已跳过（只读不修复）`);
  }
  return last;
}

function parseJsonOrNull(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/* —— 旧形态校验（0.1.x）：与 model.js 的 0.2.0 形态刻意分开，避免新校验器收严后读不出档案 —— */

function isLegacyMemberRecord(record) {
  if (!isPlainObject(record) || !isLegacyMemberHead(record)) {
    return false;
  }
  if (!isLegacyMemberBody(record)) {
    return false;
  }
  return isLegacyMemberExtras(record);
}

function isLegacyMemberHead(record) {
  return isId(record.collabId)
    && isIdentityName(record.name)
    && LEGACY_ROLES.includes(record.role)
    && (LEGACY_COLLAB_STATES.includes(record.state) || record.state === LOCAL_LEFT_STATE);
}

function isLegacyMemberBody(record) {
  return isLegacyPeer(record.manager) && isLegacyEndpoints(record.endpoints) && isLegacyRoster(record.roster);
}

function isLegacyMemberExtras(record) {
  if (record.mode !== undefined && !isCollabMode(record.mode)) {
    return false;
  }
  return record.topic === undefined || isPresentationText(record.topic, MAX_TOPIC_CHARS);
}

function isLegacyRoster(roster) {
  if (!Array.isArray(roster) || roster.length < 1 || roster.length > MAX_COLLAB_MEMBERS) {
    return false;
  }
  return roster.every((entry) => isPlainObject(entry) && isId(entry.instanceId) && isIdentityName(entry.identityName));
}

function isLegacyLedger(ledger) {
  if (!isPlainObject(ledger) || !isLegacyLedgerHead(ledger)) {
    return false;
  }
  if (!isLegacyPeer(ledger.manager) || !isLegacyMemberRows(ledger.members)) {
    return false;
  }
  return isLegacyLedgerTail(ledger);
}

function isLegacyLedgerHead(ledger) {
  return Number.isInteger(ledger.version)
    && ledger.version >= 1
    && isId(ledger.collabId)
    && isIdentityName(ledger.name)
    && isPresentationText(ledger.topic, MAX_TOPIC_CHARS)
    && LEGACY_COLLAB_STATES.includes(ledger.status);
}

function isLegacyLedgerTail(ledger) {
  if (!Array.isArray(ledger.board) || !isTimestamp(ledger.createdAt) || !isTimestamp(ledger.updatedAt)) {
    return false;
  }
  return ledger.mode === undefined || isCollabMode(ledger.mode);
}

function isLegacyMemberRows(members) {
  if (!Array.isArray(members) || members.length < 1 || members.length > MAX_COLLAB_MEMBERS) {
    return false;
  }
  return members.every(isLegacyMemberRow);
}

function isLegacyMemberRow(entry) {
  return isPlainObject(entry)
    && isId(entry.instanceId)
    && isIdentityName(entry.identityName)
    && LEGACY_ROLES.includes(entry.role)
    && LEGACY_MEMBER_STATES.includes(entry.state)
    && isTimestamp(entry.joinedAt);
}

function isLegacyPeer(peer) {
  return isPlainObject(peer) && isId(peer.instanceId) && isIdentityName(peer.identityName);
}

function isLegacyEndpoints(endpoints) {
  if (!isPlainObject(endpoints)) {
    return false;
  }
  for (const [instanceId, endpoint] of Object.entries(endpoints)) {
    if (!isId(instanceId) || !isEndpointShape(endpoint)) {
      return false;
    }
  }
  return true;
}

function isEndpointShape(endpoint) {
  if (!isPlainObject(endpoint) || typeof endpoint.address !== 'string' || endpoint.address === '') {
    return false;
  }
  return isPort(endpoint.port);
}

/* 旧版对端帧与旧协作写路径的拒绝计数（函数级，接线归 M2/M3）：设计 §6.4 的 legacyInboundRejected
 * 与写门拒绝共用同一累计面，便于诊断「对端旧版仍在发帧」与「写被门挡下」。 */
export function createLegacyRejectionCounter() {
  let inbound = 0;
  let write = 0;
  return {
    noteInbound(count = 1) {
      inbound = accumulate(inbound, count, 'inbound');
      return inbound;
    },
    noteWrite(count = 1) {
      write = accumulate(write, count, 'write');
      return write;
    },
    read() {
      return { legacyInboundRejected: inbound, legacyWriteRejected: write };
    },
  };
}

function accumulate(current, count, label) {
  if (!Number.isInteger(count) || count < 1) {
    throw new TypeError(`拒绝计数增量非法（${label}）：${String(count)}`);
  }
  return current + count;
}

function defaultWarn(message) {
  console.error(message);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function isTimestamp(value) {
  return typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value));
}
