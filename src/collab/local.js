import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_COLLAB_MODE, ID_PATTERN, MAX_ACTIVE_SEATS } from '../net/protocol.js';
import { SEATS_DIR_NAME, collabDir, ensureDir, seatFilePath } from '../paths.js';
import { writeJsonAtomic } from '../storage.js';
import { appendLedger, ensureCollabDir, loadMember, saveMember, saveSnapshot } from './store.js';
import { isArchived, isTimestamp } from './model.js';
import { newMemberEventId } from './members.js';

/* 本地协作态与持久化的共享原语（服务内多模块共用）：状态读法（manager 记录〔协作＝站长、讨论＝发起人〕
 * 以台账为权威、成员以本地记录为权威）与「只计数告警、绝不抛出」的写盘包装（健壮性硬性要求——
 * 写盘失败不得让协作事件处理或消息主链中断）。写包装统一先确保协作目录存在（写路径自足）。 */

/* —— 本机席位（设计 §1.2/§6.2）：seats/<sessionId>.json 是席位态的持久面，seats Map 是运行面 —— */

export const SEAT_FILE_VERSION = 1;
export const SEAT_ROLES = ['manager', 'member'];
export const SEAT_STATES = ['joining', 'member'];

/* 席位文件形态：字段语义与本地参与记录分开——席位只回答「本机会话在这个协作里是谁、到哪一步」。
 * 形态不符一律跳过（不删除、不清洗，随协作目录保留为排查证据）。 */
export function isSeatShape(record) {
  return isSeatHeadShape(record)
    && isSeatRoleStateShape(record)
    && isSeatTimeShape(record)
    && isSeatFlagsShape(record)
    && isSeatIdsShape(record)
    && isSeatMemberComplete(record);
}

function isSeatHeadShape(record) {
  return isPlainObject(record) && isIdLike(record.sessionId) && record.version === SEAT_FILE_VERSION;
}

function isSeatRoleStateShape(record) {
  return SEAT_ROLES.includes(record.role) && SEAT_STATES.includes(record.state);
}

/* 已收敛的席位必须能回答「第几位、何时入席」；joining 阶段与 member(unverified) 由加入域
 * 先落记录，序号与入席时刻要等含本席的快照到达后才回填——两段式期间允许缺省。 */
function isSeatMemberComplete(record) {
  if (record.state !== 'member' || record.unverified === true) {
    return true;
  }
  return isSeatSeqValue(record.joinSeq) && isTimestamp(record.joinedAt);
}

function isSeatTimeShape(record) {
  return isOptionalTimestamp(record.joinedAt) && isOptionalTimestamp(record.archivedAt);
}

function isSeatFlagsShape(record) {
  return isOptionalBoolean(record.muted) && isOptionalBoolean(record.unverified);
}

function isSeatIdsShape(record) {
  return isOptionalSeatSeq(record.joinSeq)
    && isOptionalSeatSeq(record.grantVersion)
    && (record.joinId === undefined || isIdLike(record.joinId));
}

function isOptionalSeatSeq(value) {
  return value === undefined || isSeatSeqValue(value);
}

function isSeatSeqValue(value) {
  return Number.isInteger(value) && value >= 1;
}

function isOptionalTimestamp(value) {
  return value === undefined || isTimestamp(value);
}

function isOptionalBoolean(value) {
  return value === undefined || typeof value === 'boolean';
}

/* 落盘形态只含席位事实：bridgeId/暂存/inbox 是核内运行态，不写入席位文件（设计 §1.2/§6.2）。 */
function seatFileOf(seat) {
  const record = {
    version: SEAT_FILE_VERSION,
    sessionId: seat.sessionId,
    role: seat.role,
    state: seat.state,
    muted: seat.muted === true,
  };
  if (Number.isInteger(seat.joinSeq)) {
    record.joinSeq = seat.joinSeq;
  }
  if (typeof seat.joinedAt === 'string') {
    record.joinedAt = seat.joinedAt;
  }
  if (seat.unverified === true) {
    record.unverified = true;
  }
  if (typeof seat.joinId === 'string') {
    record.joinId = seat.joinId;
  }
  if (Number.isInteger(seat.grantVersion)) {
    record.grantVersion = seat.grantVersion;
  }
  if (typeof seat.archivedAt === 'string') {
    record.archivedAt = seat.archivedAt;
  }
  return record;
}

/* 运行态席位：文件字段 + 桥注册与投递面（暂存/inbox/去重集），后者不落盘。 */
function runtimeSeatOf(record) {
  return {
    ...record,
    muted: record.muted === true,
    unverified: record.unverified === true,
    bridgeId: null,
    staged: [],
    inbox: [],
    seen: new Set(),
    deliveryOutcomes: new Map(),
    flushing: false,
    stagedDropped: 0,
  };
}

/** 读一个协作目录下的全部席位文件：坏文件跳过并计数（不删除不清洗）。
 * 上限只约束非归档席位：归档席位是历史保留（设计 §2.5/§10），长寿命讨论累计超过上限时
 * 不得把仍在活跃的席位挤出加载面——归档席位照常载入，但不占活跃名额。 */
export function loadSeats(dataDir, collabId) {
  const seats = new Map();
  let corrupt = 0;
  let active = 0;
  for (const entry of readSeatDirents(dataDir, collabId)) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }
    const sessionId = entry.name.slice(0, -'.json'.length);
    if (!ID_PATTERN.test(sessionId)) {
      corrupt++;
      continue;
    }
    const record = readSeatFile(join(seatDirOf(dataDir, collabId), entry.name));
    if (record === null || record.sessionId !== sessionId) {
      corrupt++;
      continue;
    }
    const archived = isSeatArchived(record);
    if (!archived && active >= MAX_ACTIVE_SEATS) {
      corrupt++;
      continue;
    }
    if (!archived) {
      active++;
    }
    seats.set(sessionId, runtimeSeatOf(record));
  }
  return { seats, corrupt };
}

function seatDirOf(dataDir, collabId) {
  return join(collabDir(dataDir, collabId), SEATS_DIR_NAME);
}

/** @returns {import('node:fs').Dirent[]} */
function readSeatDirents(dataDir, collabId) {
  try {
    return readdirSync(seatDirOf(dataDir, collabId), { withFileTypes: true });
  } catch {
    return [];
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIdLike(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function readSeatFile(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return isSeatShape(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 席位落盘（整档替换）：写失败向上抛，由服务层按「只计数不断链」处置。 */
export function saveSeat(dataDir, collabId, seat) {
  const record = seatFileOf(seat);
  if (!isSeatShape(record)) {
    throw new TypeError('席位文件形态非法，拒绝写入');
  }
  ensureDir(seatDirOf(dataDir, collabId));
  writeJsonAtomic(seatFilePath(dataDir, collabId, seat.sessionId), record);
}

/** 席位文件删除（离席/结束的唯一删除面）：文件不存在不算失败。 */
export function removeSeatFile(dataDir, collabId, sessionId) {
  try {
    rmSync(seatFilePath(dataDir, collabId, sessionId), { force: true });
    return true;
  } catch {
    return false;
  }
}

/* 契约面（M2 → 全体）：只给席位事实，不暴露暂存/inbox 运行态。 */
export function seatViewOf(seat) {
  return {
    sessionId: seat.sessionId,
    role: seat.role,
    state: seat.state,
    joinSeq: Number.isInteger(seat.joinSeq) ? seat.joinSeq : null,
    muted: seat.muted === true,
    unverified: seat.unverified === true,
    archived: isSeatArchived(seat),
  };
}

/* 归档席位（契约 §8 的 archivedAt）：终态保留历史，不再参与注入、静音聚合与活跃判定。
 * 席位的 state 只有 joining/member 两态（持久化格式冻结），归档语义单独由时间戳承载。 */
export function isSeatArchived(seat) {
  return typeof seat?.archivedAt === 'string' && seat.archivedAt !== '';
}

/* 终态归档本机全部席位（结束 / 撤回）：写 archivedAt 并落盘，不删除席位文件。
 * 写失败只计数留痕（重启后会被当作活跃席位读取），不阻断终态处理。 */
export function archiveLocalSeatsOfState(state, local) {
  const before = local.seatPersistFailures ?? 0;
  const at = new Date().toISOString();
  const archived = [];
  for (const seat of seatsOfLocal(local).values()) {
    if (isSeatArchived(seat)) {
      continue;
    }
    seat.archivedAt = at;
    archived.push(seat.sessionId);
    saveSeatQuietly(local, state.dataDir, seat);
  }
  if ((local.seatPersistFailures ?? 0) > before) {
    state.log.warn('席位归档写入失败（重启后可能仍按活跃席位读取）', {
      collabId: local.collabId,
      reason: local.lastSeatPersistError,
    });
  }
  return archived;
}

/* 退役静音 store 的兼容句柄（单向空实现）：freeze / sync / takeover 的清理钩子尚未迁出，
 * 这些调用点只调用 clear()。新代码不得经它读写静音态——席位文件的 muted 是唯一权威（契约 §8）。 */
export function retiredMuteHandle() {
  return {
    clear: () => {},
    isMuted: () => false,
    setMuted: () => ({ wasMuted: false, baseline: null }),
    stats: () => ({ muted: false, baseline: null }),
  };
}

/* 席位容器（兼容面）：旧写点（createCollab 等尚未迁移的路径）构造的 local 不带 seats——按需初始化。 */
export function seatsOfLocal(local) {
  if (!(local.seats instanceof Map)) {
    local.seats = new Map();
  }
  return local.seats;
}

export function listLocalSeatsOf(local) {
  return [...seatsOfLocal(local).values()].map(seatViewOf);
}

export function localSeatOfLocal(local, sessionId) {
  return typeof sessionId === 'string' ? (seatsOfLocal(local).get(sessionId) ?? null) : null;
}

/* 站长席位派生：角色只认席位（local.role 是派生缓存，不再是独立事实来源）。 */
export function managerSeatOfLocal(local) {
  for (const seat of seatsOfLocal(local).values()) {
    if (seat.role === 'manager' && seat.state === 'member') {
      return seat;
    }
  }
  return null;
}

export function hasActiveSeat(local) {
  for (const seat of seatsOfLocal(local).values()) {
    if (seat.state === 'member' && !isSeatArchived(seat)) {
      return true;
    }
  }
  return false;
}

/* 主席位（兼容面用）：站长席位优先，其次按 joinSeq/sessionId 取最早者。 */
export function primarySeatOf(local) {
  const manager = managerSeatOfLocal(local);
  if (manager !== null) {
    return manager;
  }
  const ordered = [...seatsOfLocal(local).values()].sort(compareSeatOrder);
  return ordered[0] ?? null;
}

function compareSeatOrder(left, right) {
  const leftSeq = Number.isInteger(left.joinSeq) ? left.joinSeq : Number.MAX_SAFE_INTEGER;
  const rightSeq = Number.isInteger(right.joinSeq) ? right.joinSeq : Number.MAX_SAFE_INTEGER;
  if (leftSeq !== rightSeq) {
    return leftSeq - rightSeq;
  }
  return left.sessionId < right.sessionId ? -1 : 1;
}

/** 角色派生：有席位即从席位派生（有站长席＝manager），无席位时退回兼容成员记录。 */
export function deriveLocalRole(local) {
  if (seatsOfLocal(local).size === 0) {
    return local.member?.role ?? 'member';
  }
  return managerSeatOfLocal(local) !== null ? 'manager' : 'member';
}

/** 席位变化后同步派生缓存（旧模块仍读 local.role；M3/M5 迁完后它只作兼容读面）。 */
export function syncLocalRole(local) {
  local.role = deriveLocalRole(local);
}

/* 席位插入/合并：不存在时按运行态完整形态新建（Map.get 未命中是 undefined——用 null 判定会让
 * 新席位缺 seen/staged/inbox/bridgeId，首次注入即抛异常）。新席位同时绑定该会话当前桥。 */
export function upsertLocalSeat(local, seat, { persist = false, dataDir = null, bridgeId = null } = {}) {
  const existing = seatsOfLocal(local).get(seat.sessionId);
  const next = nextSeatOf(existing, seat, bridgeId);
  seatsOfLocal(local).set(seat.sessionId, next);
  syncLocalRole(local);
  if (persist && dataDir !== null) {
    saveSeatQuietly(local, dataDir, next);
  }
  return next;
}

function nextSeatOf(existing, seat, bridgeId) {
  const held = existing !== undefined ? { ...existing, ...seat } : runtimeSeatOf(seat);
  /* 显式给出的桥标识必须落到合并结果上：席位在桥注册之后才建立（受邀同意、席位重建）
   * 时，核心已经记下该会话的桥，但合并分支若忽略入参，席位就会保持 bridgeId=null，
   * 内容帧只能进暂存等下一次重连。空值不覆盖既有绑定（调用方未给≠桥已失效）。 */
  if (typeof bridgeId === 'string' && bridgeId !== '') {
    held.bridgeId = bridgeId;
  }
  return held;
}

function saveSeatQuietly(local, dataDir, seat) {
  try {
    saveSeat(dataDir, local.collabId, seat);
  } catch (error) {
    local.seatPersistFailures = (local.seatPersistFailures ?? 0) + 1;
    local.lastSeatPersistError = error.message;
  }
}

/* 席位角色迁移原语（站长转移）：角色只认席位，转移必须同时改席位与派生缓存，
 * 否则后续 syncLocalRole 会把 local.role 改回旧值。 */
export function setLocalSeatRole(local, sessionId, role) {
  if (!SEAT_ROLES.includes(role)) {
    return null;
  }
  const seat = localSeatOfLocal(local, sessionId);
  if (seat === null) {
    return null;
  }
  seat.role = role;
  syncLocalRole(local);
  return seat;
}

/* 席位移除：返回是否曾存在与该席丢弃的暂存帧数（判离席丢弃要计数）与文件删除结果
 * （删不掉时重启会「复活」席位——调用方必须留痕）。 */
export function removeLocalSeat(local, sessionId, { persist = false, dataDir = null } = {}) {
  const seat = seatsOfLocal(local).get(sessionId);
  const existed = seatsOfLocal(local).delete(sessionId);
  const stagedDropped = seat === undefined ? 0 : seat.staged.length;
  syncLocalRole(local);
  let fileRemoved = true;
  if (existed && persist && dataDir !== null) {
    fileRemoved = removeSeatFile(dataDir, local.collabId, sessionId);
  }
  const outcome = { existed, stagedDropped, fileRemoved };
  /* 移除钩子（服务层挂接）：判离席计数、删除失败留痕、未确认入席记录释放——所有移除路径
   * （离席/结束/心跳超时）都走本函数，钩子保证这些收尾不因调用方不同而漏做。 */
  try {
    local.onSeatRemoved?.(sessionId, outcome);
  } catch {
    // 钩子是附属收尾：失败不得反向影响已完成的移除
  }
  return outcome;
}

/* 状态读法：manager 记录（协作＝站长、讨论＝发起人）以台账为权威；「已退出」是成员记录的本地终态，
 * 对**讨论的发起人**同样可达（发起人可退出——退出即放弃结束权，设计 §6）。
 * 有席位表时按席位看待：同机一席退出不得把另一席归档——成员记录是整机兼容面，
 * 只在没有任何活跃席位时才把它当作本机状态。 */
export function localStateOf(local) {
  const seats = seatsOfLocal(local);
  if (seats.size > 0) {
    return seatBackedStateOf(local);
  }
  if (local.role === 'manager' && local.member?.state !== 'left') {
    return local.ledger?.status ?? 'proposed';
  }
  return local.member?.state ?? 'member';
}

function seatBackedStateOf(local) {
  if (managerSeatOfLocal(local) !== null && local.ledger !== null) {
    return local.ledger.status;
  }
  if (!hasActiveSeat(local)) {
    return local.member?.state ?? 'member';
  }
  return local.member?.state === 'left' ? 'active' : (local.member?.state ?? 'member');
}

/* 模式读法（两侧视角统一）：manager 记录取台账、成员取本地记录；缺省 managed（旧数据兼容，
 * 创建时定死不可变——本函数是全部模式判定的单一入口）。 */
export function localModeOf(local) {
  const raw = local.role === 'manager' ? local.ledger?.mode : local.member?.mode;
  return raw ?? DEFAULT_COLLAB_MODE;
}

export function isLocalArchivedState(local) {
  return isArchived(localStateOf(local));
}

export function localNameOf(local) {
  return local.role === 'manager' ? local.ledger?.name : local.member?.name;
}

export function localRosterOf(local) {
  if (local.role === 'manager') {
    return local.ledger?.members ?? [];
  }
  return local.member?.roster ?? [];
}

/* 讨论的当前成员表 = 成员事件日志按事件折叠（设计 §5.4；每成员取自身最新事件、join 者入表）。
 * 这是讨论模式成员语义的单一取数面：邀请名额判定、帖扇出、控制事件广播都经它——
 * managed 的 roster/台账名单不再是讨论成员关系的权威（被拒/被撤回者不占名额、退出者即时出表）。 */
export function foldedMembersOf(local) {
  return local.members.fold().map(withSessionSeatOf);
}

/* 折叠结果的席位键标注（设计 D13/§10）：折叠产出已携 sessionId 时原样保留（同机多会话各一行）；
 * 旧事件没有席位键时保持**实例级**并显式标注来源——同一个实例最近的会话不代表这条历史属于它，
 * 用 latestEventOf 补键会把旧实例历史误配到当前会话（邀请载荷/冲突匹配面错误归属）。
 * 缺席位键的行在组协议名单时按「无席位」跳过，不伪造条目。 */
function withSessionSeatOf(member) {
  if (typeof member.sessionId === 'string' && member.sessionId !== '') {
    return member;
  }
  return { ...member, sessionId: null, seatScope: 'instance' };
}

/* 讨论的群体可达面（控制事件广播 / 对表候选 / 拉取应答准入的共用成员集）：
 * 折叠成员表 ∪ 邀请者引用 ∪ 端点表已知者（除本机）。
 * 端点表是邀请随带的寻址信息的落点（设计 §5.1「被邀者据此取得入群所需的成员与寻址信息」）——
 * 新成员刚加入时折叠表只有自己，可达面若只到邀请者，邀请者离线即把成员钉成孤点：join 达不到
 * 其余成员、回填无从发起、对全员不可见；端点表已知者即从邀请面可寻址的成员/受邀者，
 * 端点未知者由对方主动联系或后续对表补学（跳过不阻塞其余目标）。 */
export function forumReachIdsOf(local, selfId) {
  const ids = new Set();
  for (const member of local.members.fold()) {
    ids.add(member.instanceId);
  }
  if (local.role === 'member' && typeof local.member?.manager?.instanceId === 'string') {
    ids.add(local.member.manager.instanceId);
  }
  for (const instanceId of local.endpoints.keys()) {
    ids.add(instanceId);
  }
  ids.delete(selfId);
  return [...ids];
}

/* 本机是否已在折叠成员表内（讨论的「已加入」判据：发帖与发 join 重播的前置）。
 * 讨论成员粒度＝会话（D2）：给了 sessionId 时只认同一 (instanceId, sessionId) 的 join 事件，
 * 同机另一个会话在席不代表本会话在席；只有该实例的历史事件完全没有席位键时（旧数据）
 * 才退回实例判据。不给 sessionId 的机器级调用（如敲门应答）保持实例口径。 */
export function selfJoinedOf(local, selfId, sessionId = null) {
  const folded = local.members.fold();
  if (typeof sessionId === 'string' && sessionId !== '') {
    const scoped = folded.filter((member) => member.instanceId === selfId
      && typeof member.sessionId === 'string' && member.sessionId !== '');
    if (scoped.length > 0) {
      return scoped.some((member) => member.sessionId === sessionId);
    }
    return folded.some((member) => member.instanceId === selfId);
  }
  return folded.some((member) => member.instanceId === selfId);
}

/* 讨论的中继（= 发起人）身份读法（设计 §5.2/§9.1）：发起人本机即中继；成员取本地记录里
 * 随邀请载荷 / bundle 元状态学得的 originator（与「邀请者引用」member.manager 是不同字段
 * ——邀请者≠发起人，中继归属不得由邀请者推断）。未知返回 null——投递按降级直投处理。 */
export function relayPeerOf(local, self) {
  if (localModeOf(local) === 'forum' && local.role === 'manager') {
    return { instanceId: self.instanceId, identityName: self.identityName };
  }
  const originator = local.member?.originator;
  if (originator !== undefined && typeof originator.instanceId === 'string') {
    return { instanceId: originator.instanceId, identityName: originator.identityName };
  }
  return null;
}

/* 发起人是否已放弃中继职责（设计 §5.2/§9.1：发起人退出＝永久放弃 → 直投兜底）。
 * 判据 = 本机成员事件集里该发起人最近一条事件为 leave；事件未到 / 从未见过该实例 → false
 * （不臆断，按可达处理——新加入者在成员事件收敛前也须照常经中继）。 */
export function relayDepartedOf(local, relayId) {
  const latest = local.members.latestEventOf(relayId);
  return latest !== null && latest.kind === 'leave';
}

/* 主题读法（两侧视角统一）：manager 记录取台账、成员取本地记录（邀请载荷/对表元状态写入）。 */
export function localTopicOf(local) {
  const raw = local.role === 'manager' ? local.ledger?.topic : local.member?.topic;
  return typeof raw === 'string' ? raw : null;
}

/** 本机自播成员事件（设计 §5.4/§5.5）：join/leave 由成员本人发出——事件时刻取该作者的
 * 单调基线（帖子与事件共用：与帖子序同源、跨重启落盘）。
 * 返回事件（已并入本地日志）或 null（形态异常/重复——新事件 id 不会重复）。
 * @param {any} state
 * @param {any} local
 * @param {'join' | 'leave'} kind
 * @param {string | null} [sessionId]
 */
export function emitOwnMemberEvent(state, local, kind, sessionId = null) {
  const event = {
    eventId: newMemberEventId(),
    kind,
    instanceId: state.self.instanceId,
    identityName: state.self.identityName,
    ts: allocateOwnEventStamp(state, local),
  };
  /* 席位键随事件广播：讨论成员粒度是会话，邀请载荷与名单折叠都按 (instanceId, sessionId)
   * 校验；缺字段的事件在折叠后无法定位到具体会话。 */
  if (typeof sessionId === 'string' && sessionId !== '') {
    event.sessionId = sessionId;
  }
  return local.members.apply(event) === 'added' ? event : null;
}

/* 作者局部单调 ts 分配：以本机已落盘的帖子 + 成员事件的最大 ts 为基线，回拨时取基线 + 1ms。 */
function allocateOwnEventStamp(state, local) {
  const postTs = local.posts.ownBaseline(state.self.instanceId).ts;
  const eventTs = local.members.baselineTsOf(state.self.instanceId);
  const postMs = typeof postTs === 'string' ? Date.parse(postTs) : Number.NEGATIVE_INFINITY;
  const eventMs = typeof eventTs === 'string' ? Date.parse(eventTs) : Number.NEGATIVE_INFINITY;
  const baseMs = Math.max(postMs, eventMs);
  const nowMs = Date.now();
  const stampMs = Number.isFinite(baseMs) ? Math.max(baseMs + 1, nowMs) : nowMs;
  return new Date(stampMs).toISOString();
}

/* 本机持有的当前汇报版本：manager 记录取台账版本；成员取最近一次校验通过的快照版本（无快照为 null）。
 * 抢接优先序与合流判定都以它为「本机版本」口径。 */
export function localVersionOf(local) {
  if (local.role === 'manager') {
    return local.ledger?.version ?? null;
  }
  return local.snapshot === null ? null : local.snapshot.version;
}

/* 现任 manager 标识（两侧视角统一读法）。 */
export function currentManagerIdOf(local) {
  if (local.role === 'manager') {
    return local.ledger?.manager?.instanceId ?? null;
  }
  return local.member?.manager?.instanceId ?? null;
}

/* 成员记录整写（服务侧唯一咽喉）：写前把**路由面字段**从盘上合并回来——指名邀请的
 * targetSessionId 与挂起登记 pendingInvites 由核心路由面直写 member.json（判据与补投都读它），
 * 内存记录不含这两项，整写会静默抹掉（挂起邀请永不再补投）。合并口径＝文件显式给了就以文件
 * 为准（路由面是这两个字段的唯一写者：登记、刷新与摘除都由它做），同时补学回内存记录——
 * 此后本会话的整写不再丢；文件没有该字段（旧记录）则保留内存值。 */
export function persistMember(state, local) {
  try {
    ensureCollabDir(state.dataDir, local.collabId);
    mergeRoutingMarks(state, local);
    saveMember(state.dataDir, local.member);
  } catch (error) {
    state.counters.persistFailures++;
    state.log.warn('成员记录写入失败（内存态继续）', { collabId: local.collabId, reason: error.message });
  }
}

/* 路由面字段的合并（见 persistMember）：读不出 / 形态不符一律原样（不拿坏数据覆盖内存态）。 */
function mergeRoutingMarks(state, local) {
  const onDisk = loadMember(state.dataDir, local.collabId);
  if (onDisk === null || local.member === null || typeof local.member !== 'object') {
    return;
  }
  for (const field of ['targetSessionId', 'pendingInvites']) {
    if (onDisk[field] !== undefined) {
      local.member[field] = onDisk[field];
    }
  }
}

export function persistLedger(state, local) {
  try {
    ensureCollabDir(state.dataDir, local.collabId);
    appendLedger(state.dataDir, local.ledger);
  } catch (error) {
    state.counters.persistFailures++;
    state.log.warn('台账写入失败（内存态继续）', { collabId: local.collabId, reason: error.message });
  }
}

export function persistSnapshot(state, local) {
  if (local.snapshot === null) {
    return;
  }
  try {
    ensureCollabDir(state.dataDir, local.collabId);
    saveSnapshot(state.dataDir, local.collabId, local.snapshot);
  } catch (error) {
    state.counters.persistFailures++;
    state.log.warn('快照写入失败（内存态继续）', { collabId: local.collabId, reason: error.message });
  }
}

export function rememberKnownHost(state, entry) {
  try {
    state.knownHosts.remember(entry);
  } catch (error) {
    state.counters.persistFailures++;
    state.log.warn('已知主机清单更新失败（已忽略）', { reason: error.message });
  }
}

/* 由台账状态映射成员侧本地状态（席位转移——接管 / 移交 / 抢接降级——的共用量规）：
 * 成员记录是本地视角，其 state 取当前公开状态的映射；left 是成员本地终态、不由映射产生。 */
export function memberStateFor(status) {
  if (status === 'completed' || status === 'terminated') {
    return status;
  }
  if (status === 'frozen') {
    return 'frozen';
  }
  if (status === 'active') {
    return 'active';
  }
  return 'proposed';
}

/* 冻结前状态的兜底推测（旧数据缺 frozenFrom 标记时）：成员侧已回应过邀请即视为 active，
 * 未回应视为 proposed；站长侧存在非邀请态成员即视为 active，否则 proposed。 */
export function inferredFrozenFrom(local) {
  if (local.role === 'manager') {
    const settled = local.ledger.members.some((entry) => entry.role !== 'manager' && entry.state !== 'invited' && entry.state !== 'left');
    return settled ? 'active' : 'proposed';
  }
  const decision = local.member.decision ?? null;
  return decision === 'approved' || decision === 'withdrawn' ? 'active' : 'proposed';
}
