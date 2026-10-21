import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DIGEST_PATTERN, ID_PATTERN, MAX_COLLAB_MEMBERS, MAX_TOPIC_CHARS, isCollabMode, isIdentityName, isPort, isPresentationText } from '../net/protocol.js';
import { PENDING_INVITES_FILE_NAME, SEATS_DIR_NAME } from '../paths.js';
import { writeJsonAtomic } from '../storage.js';
import { CARRIER_FILE_NAME, CARRIER_FORMAT_INVITE_STUB, readCarrier, readCarrierFormat } from './carrier.js';
import { MEMBERS_FILE_NAME } from './members.js';
import { MIGRATION_FILE_NAME, RECOVERY_FILE_NAME, isMigrationShape, loadMigration, loadRecovery, readMigration, readRecovery } from './migration.js';
import { LEDGER_FILE_NAME, MEMBER_FILE_NAME, SNAPSHOT_FILE_NAME } from './store.js';

/* 存量（0.1.x）协作的只读面（设计 §8）：旧目录以 member.json 为本地参与记录、台账形态也没有
 * sessionId/joinSeq/managerTerm。0.2.0 把它们整目录归档为只读 legacy，不做迁移改写——
 * 因此本文件的判据与读取器自带「旧形态」校验，不复用会随 0.2.0 改形的 model.js/members.js 校验器。
 * 读取面零写盘：台账尾部半行只忽略，绝不截断（截断修复属存储写面）。 */

const LOCAL_LEFT_STATE = 'left';
const LEGACY_ROLES = ['manager', 'member'];
const LEGACY_MEMBER_STATES = ['invited', 'approved', 'declined', 'withdrawn', 'member', 'left'];
const LEGACY_COLLAB_STATES = ['proposed', 'active', 'frozen', 'completed', 'terminated'];

export const DEFAULT_LEGACY_REASON = 'legacy-format';

/** legacy 判据（设计 §8）：有旧 member.json，且 carrier 没有新形态 format 标记，且无
 * migration/recovery 标记。缺 carrier 且无 member.json 的目录不自动判 legacy（按损坏另处理）。
 * 已写 migration.json 的目录不再算「待迁移 legacy」，但仍是可读档案（见 isLegacyReadable）。 */
export function isLegacyCollab(dir) {
  return isLegacyReadable(dir) && readMigration(dir) === null;
}

/* 可读档案面：未迁移的旧目录与已归档旧目录都可读（归档后即使 member.json 被清理，
 * 只要 migration 标记与台账/快照还在就仍能展示）；新形态目录与半写恢复目录不可读。 */
function isLegacyReadable(dir) {
  if (readCarrierFormat(dir) !== null) {
    return false;
  }
  if (readRecovery(dir) !== null) {
    return false;
  }
  if (existsSync(join(dir, MEMBER_FILE_NAME))) {
    return true;
  }
  return readMigration(dir) !== null
    && (existsSync(join(dir, LEDGER_FILE_NAME)) || existsSync(join(dir, SNAPSHOT_FILE_NAME)));
}

/** 目录形态分类：写门与启动扫描共用同一次判定（避免多处各自拼判据后分叉）。
 * kind ∈ missing | empty | session-seats | invite-stub | legacy | archived-legacy | recovery | corrupt。
 * corrupt 含：carrier 不可读、无任何已识别标记的非空目录、标记文件不可读。 */
export function classifyCollabDir(dir) {
  const recovery = loadRecovery(dir);
  if (recovery.status === 'ok') {
    return { kind: 'recovery', detail: RECOVERY_FILE_NAME };
  }
  const migration = loadMigration(dir);
  if (migration.status === 'ok') {
    return { kind: 'archived-legacy', detail: MIGRATION_FILE_NAME };
  }
  const carrier = readCarrier(dir);
  if (carrier.status === 'corrupt') {
    return { kind: 'corrupt', detail: CARRIER_FILE_NAME };
  }
  const markerBroken = isBrokenMarker(recovery) || isBrokenMarker(migration);
  if (carrier.status === 'ok') {
    return markerBroken ? { kind: 'corrupt', detail: 'marker' } : carrierKind(dir, carrier.carrier);
  }
  if (existsSync(join(dir, MEMBER_FILE_NAME))) {
    return { kind: 'legacy', detail: MEMBER_FILE_NAME };
  }
  if (markerBroken) {
    return { kind: 'corrupt', detail: 'marker' };
  }
  if (existsSync(join(dir, PENDING_INVITES_FILE_NAME))) {
    return { kind: 'invite-stub', detail: PENDING_INVITES_FILE_NAME };
  }
  return emptyOrUnknownKind(dir);
}

function isBrokenMarker(marker) {
  return marker.status === 'corrupt' || marker.status === 'unreadable';
}

function carrierKind(dir, carrier) {
  if (carrier.format === CARRIER_FORMAT_INVITE_STUB) {
    return { kind: 'invite-stub', detail: CARRIER_FILE_NAME };
  }
  return sessionSeatsWritten(dir)
    ? { kind: 'session-seats', detail: CARRIER_FILE_NAME }
    : { kind: 'recovery', detail: 'carrier-without-ledger' };
}

/* 会话级成员目录只有 carrier ＋ seats/（＋ snapshot.json）——共享台账只由站长写，
 * 不能拿「无台账」判半写。判据限定「成员记录 role=member 且已有参与面证据」：
 * 站长目录丢了台账仍必须判半写只读（不得沿用旧正判定），成员目录才有席位/快照无台账的合法形态。 */
function sessionSeatsWritten(dir) {
  if (ledgerWritten(dir)) {
    return true;
  }
  return memberRoleOf(dir) === 'member' && (seatsWritten(dir) || existsSync(join(dir, SNAPSHOT_FILE_NAME)));
}

/* 只取角色作判档线索；形态校验归加载面（本文件不复用新形态校验器）。 */
function memberRoleOf(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, MEMBER_FILE_NAME), 'utf8'))?.role ?? null;
  } catch {
    return null;
  }
}

function seatsWritten(dir) {
  try {
    return readdirSync(join(dir, SEATS_DIR_NAME)).length > 0;
  } catch {
    return false;
  }
}

/* 零字节台账按「尚未落」处理：非终态的合法台账至少有一行（状态/名单），空文件只能是半写。 */
function ledgerWritten(dir) {
  try {
    return statSync(join(dir, LEDGER_FILE_NAME)).size > 0;
  } catch {
    return false;
  }
}

function emptyOrUnknownKind(dir) {
  try {
    return readdirSync(dir).length === 0
      ? { kind: 'empty' }
      : { kind: 'corrupt', detail: 'unmarked-directory' };
  } catch (error) {
    return error.code === 'ENOENT'
      ? { kind: 'missing' }
      : { kind: 'corrupt', detail: 'unreadable-directory' };
  }
}

/** 写门（设计 §6.4）：legacy、已归档 legacy、半写新协作、损坏目录一律拒绝写。
 * 内存标记（legacy/recovery）优先——启动迁移在内存里保留判定，文件标记只是重启后的证据。
 * 返回值不抛出：调用方按 reason 转成工具错误/入站拒绝计数。 */
export function assertWritable(collabDir, options = {}) {
  if (options.legacy === true) {
    return { ok: false, reason: 'legacy', detail: 'memory-flag' };
  }
  if (options.recovery === true) {
    return { ok: false, reason: 'recovery', detail: 'memory-flag' };
  }
  const classification = classifyCollabDir(collabDir);
  if (classification.kind === 'legacy' || classification.kind === 'archived-legacy') {
    return { ok: false, reason: 'legacy', detail: classification.detail };
  }
  if (classification.kind === 'recovery') {
    return { ok: false, reason: 'recovery', detail: classification.detail };
  }
  if (classification.kind === 'corrupt') {
    return { ok: false, reason: 'corrupt', detail: classification.detail };
  }
  return { ok: true };
}

/** 归档标记：原子写 migration.json，幂等（已有合规标记且目录仍是可读档案时不重写）；
 * 失败只告警并返回失败结果，调用方继续按只读处理（失败安全），不改写旧台账。 */
export function markLegacyCompleted(collabDir, options = {}) {
  const existing = readMigration(collabDir);
  if (existing !== null) {
    if (isLegacyReadable(collabDir)) {
      return { ok: true, record: existing, written: false };
    }
    return { ok: false, record: null, written: false, error: new Error('目录有 migration.json 但不是可读的 legacy 档案，拒绝按归档处理') };
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
  const roster = foldLegacyMemberEvents(events).map((entry) => ({
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
    if (parsed === null || !isLegacyMemberEventShape(parsed)) {
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

/* 0.1.x 成员事件判据与折叠（与 members.js 的现行校验器分开：未来给事件加 sessionId 等必填字段时，
 * 旧归档仍应按旧形状可读）。 */
function isLegacyMemberEventShape(entry) {
  if (!isPlainObject(entry) || !isId(entry.eventId)) {
    return false;
  }
  if (entry.kind !== 'join' && entry.kind !== 'leave') {
    return false;
  }
  return isId(entry.instanceId) && isIdentityName(entry.identityName) && isTimestamp(entry.ts);
}

function foldLegacyMemberEvents(events) {
  const latest = new Map();
  for (const event of events) {
    const held = latest.get(event.instanceId);
    if (held === undefined || compareLegacyEvents(event, held) > 0) {
      latest.set(event.instanceId, event);
    }
  }
  const members = [];
  for (const event of latest.values()) {
    if (event.kind === 'join') {
      members.push({ instanceId: event.instanceId, identityName: event.identityName });
    }
  }
  return members.sort((left, right) => (left.instanceId < right.instanceId ? -1 : 1));
}

function compareLegacyEvents(left, right) {
  const byTs = Date.parse(left.ts) - Date.parse(right.ts);
  if (byTs !== 0) {
    return byTs;
  }
  if (left.eventId === right.eventId) {
    return 0;
  }
  return left.eventId < right.eventId ? -1 : 1;
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
  if (!isLegacySnapshotShape(loaded)) {
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

/* 0.2.0 专属字段出现即拒绝：混合目录里不能把新台账行当旧档案的最后状态。 */
function isLegacyLedgerTail(ledger) {
  if (ledger.managerTerm !== undefined || ledger.joinSeqNext !== undefined || ledger.managerWindow !== undefined) {
    return false;
  }
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
  if (entry === null || entry === undefined) {
    return false;
  }
  if (entry.sessionId !== undefined || entry.joinSeq !== undefined) {
    return false;
  }
  return isPlainObject(entry)
    && isId(entry.instanceId)
    && isIdentityName(entry.identityName)
    && LEGACY_ROLES.includes(entry.role)
    && LEGACY_MEMBER_STATES.includes(entry.state)
    && isTimestamp(entry.joinedAt);
}

function isLegacySnapshotShape(snapshot) {
  if (!isPlainObject(snapshot) || snapshot.managerTerm !== undefined || snapshot.managerWindow !== undefined) {
    return false;
  }
  if (!Number.isInteger(snapshot.version) || snapshot.version < 1) {
    return false;
  }
  if (typeof snapshot.digest !== 'string' || !DIGEST_PATTERN.test(snapshot.digest)) {
    return false;
  }
  if (!isTimestamp(snapshot.receivedAt) || !isLegacyPeer(snapshot.from)) {
    return false;
  }
  return isLegacyLedger(snapshot.ledger);
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

/** 旧台账判据（供观察窗/脚本的旧形态只读分支复用）：0.2.0 台账行会被显式拒绝。 */
export function isLegacyLedgerRow(ledger) {
  return isLegacyLedger(ledger);
}

/* 旧版对端帧与旧协作写路径的拒绝计数（函数级，接线归运行时与出站投递层）：设计 §6.4 的 legacyInboundRejected
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
