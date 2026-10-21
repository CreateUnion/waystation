import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { appendLine, writeJsonAtomic } from '../storage.js';
import { autoOfferFilePath, collabDir, collabRunDir, departedFilePath, ensureDir, managerPendingFilePath } from '../paths.js';
import { newMsgId } from '../net/protocol.js';
import { isArchived } from './model.js';
import {
  archiveLocalSeatsOfState, currentManagerIdOf, isLocalArchivedState, localModeOf, localRosterOf, localStateOf, localVersionOf,
  persistMember, persistSnapshot, removeLocalSeat,
} from './local.js';
import { forgetMuteBaselinesOfCollab } from './mute.js';
import { checkFrozenDeadlines } from './freeze.js';
import { adoptNewManager, endpointFor, governanceTargets, notifyLocal, promoteToManager, relayGovernance, sendTo, sendToRoster } from './outgoing.js';
import { appendLedger, ledgerDigest } from './store.js';
import {
  applyDirectFrame, applySeatPresence, autoSuccessorCandidates, createPresenceTable, expireSeats, isReachable,
} from './presence.js';
import { clearManagerWindow, managerWindowRemaining } from './term.js';

/* 任期内核的运行时接线（设计 §2A/§3.2）：presence 周期与离席判定、站长失联冻结、会话宽限离席、
 * 会话关闭自动移交、手动/窗口接管。纯判决在 term.js / presence.js；本模块把判决接到台账、
 * 发送面与本地文件。所有定时器 unref，异常隔离为计数与告警。 */

export const TAKEOVER_PROBE_INTERVAL_MS = 2000;
export const HANDSHAKE_REPLY_TIMEOUT_MS = 5000;
/* 手动/窗口接管的一次性挑战时限：超时须重新发起并重新对表。 */
export const TAKE_OVER_CHALLENGE_TTL_MS = 120000;
export const SEAT_GRACE_MARGIN_MS = 10000;
const DEFAULT_TAKEOVER_WINDOW_MS = 60000;
const DEFAULT_MANAGER_LOSS_MS = 300000;
const DEFAULT_SEAT_TIMEOUT_MS = 300000;
const DEFAULT_SEAT_GRACE_MS = 60000;
const DEFAULT_HANDOVER_CONFIRM_MS = 120000;
const DEFAULT_PRESENCE_INTERVAL_MS = 30000;
const DEFAULT_DIAL_MS = 5000;
/* 启动对表的补发节律与上限：站点端口就位通常在一拍内，上限只防启动失败路径无限重试。 */
const HANDSHAKE_RETRY_MS = 250;
const HANDSHAKE_RETRY_LIMIT = 20;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function seatKey(collabId, instanceId, sessionId) {
  return `${collabId}\u0000${instanceId}\u0000${sessionId}`;
}

function nowMs(state) {
  return typeof state.clock === 'function' ? state.clock() : Date.now();
}

/* presence 用单调钟（超时判定不得被墙钟回拨/前跳影响）；term 的窗口仍用墙钟。 */
function monoNow(state) {
  return typeof state.monoClock === 'function' ? state.monoClock() : performance.now();
}

function bump(state, key) {
  state.counters[key] = (state.counters[key] ?? 0) + 1;
}

function positiveMs(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/* 接线期运行时容器（惰性挂载在服务 state 上；服务装配不感知本模块）。 */
export function m5RuntimeOf(state) {
  if (state.m5Runtime === undefined) {
    const runtime = {
      presence: createPresenceTable(),
      presenceTimer: null,
      autoOffers: new Map(),         // collabId → Map(offerId → offer)
      autoPending: new Map(),        // 原站长核在途 auto offer
      autoAcceptTimers: new Map(),
      managerPending: new Map(),     // 已收 accept 未收签发的只读等待
      acceptedManagers: new Map(),   // collabId → {term,manager,source}
      handshakeResponses: new Map(), // collabId → Map(instanceId → {term,version,manager,seat})
      managerEvidenceAt: new Map(),
      frozen: new Map(),             // collabId → manager-offline/manager-pending/manager-fork（三态，域外值按活跃）
      frozenFrom: new Map(),         // 冻结前的成员本地状态（解除时恢复）
      handoverTargets: new Map(),
      pendingHandovers: new Map(),   // 显式移交在途（原站长侧）
      handoverOffers: new Map(),     // 目标侧 open/accepted 记录
      challenges: new Map(),         // 一次性确认令牌
      closedSeats: new Map(),        // 宽限计时的会话关闭记录
      resends: new Map(),            // D15 重发记录
      departures: new Set(),
      managerWindowBaseAt: new Map(),
    };
    runtime.departed = (collabId, seat) => runtime.departures.has(seatKey(collabId, seat.instanceId, seat.sessionId));
    state.m5Runtime = runtime;
  }
  return state.m5Runtime;
}

/* —— 台账任期面归一（兼容尚未迁移的旧台账；不改写数据面） —— */

export function ledgerTermOf(ledger) {
  return Number.isInteger(ledger?.managerTerm) && ledger.managerTerm >= 1 ? ledger.managerTerm : 1;
}

export function managerSeatOfLedger(state, local) {
  const adopted = adoptedManagerSeatOf(state, local);
  if (adopted !== undefined) {
    return adopted;
  }
  const raw = managerRawOf(local);
  if (!isManagerRaw(raw)) {
    return null;
  }
  return managerSeatWithSession(state, local, raw);
}

/* 已采纳的任期状态（events 的 termState 覆盖层）领先于本地台账/快照时，它就是本机当前站长。
 * 成员采纳 manager-changed 后快照尚未拉回时，只看 snapshot 会继续把旧站长当现任（来源判定、
 * 陈旧 offer 受理都会跟着错）。返回 undefined＝覆盖层不领先，走本地台账/快照。 */
function adoptedManagerSeatOf(state, local) {
  const adopted = adoptedTermStateOf(state, local);
  if (adopted === undefined || !managerOverrideAhead(adopted, local)) {
    return undefined;
  }
  if (adopted.manager === null) {
    return null;
  }
  return managerSeatOfAdopted(state, local, adopted);
}

function adoptedTermStateOf(state, local) {
  const adopted = m5RuntimeOf(state).termState?.get?.(local.collabId);
  return isPlainObject(adopted) && Number.isInteger(adopted.managerTerm) ? adopted : undefined;
}

function managerOverrideAhead(adopted, local) {
  const ledger = managerRawLedgerOf(local);
  const ledgerTerm = ledgerTermOf(ledger);
  const ledgerVersion = Number.isInteger(ledger?.version) ? ledger.version : 0;
  const adoptedVersion = Number.isInteger(adopted.version) ? adopted.version : 0;
  return adopted.managerTerm > ledgerTerm
    || (adopted.managerTerm === ledgerTerm && adoptedVersion > ledgerVersion);
}

function managerSeatOfAdopted(state, local, adopted) {
  if (!isManagerRaw(adopted.manager)) {
    return undefined;
  }
  const sessionId = adoptedSessionIdOf(state, local, adopted.manager);
  if (typeof sessionId !== 'string' || sessionId === '') {
    return null;
  }
  return managerSeatFrom(adopted.manager, sessionId, adopted.managerTerm);
}

function adoptedSessionIdOf(state, local, manager) {
  if (typeof manager.sessionId === 'string' && manager.sessionId !== '') {
    return manager.sessionId;
  }
  return seatSessionOfInstance(state, local, manager.instanceId);
}

/* 本机权威 (term,version)：termState 覆盖层领先时以它为准——握手与对表必须报同一对值，
 * 否则「新 manager + 旧 term」会被对端按同 term 不同 manager 判成分叉。 */
function adoptedPairOf(state, local) {
  const ledger = local.role === 'manager' ? local.ledger : local.snapshot?.ledger;
  const ledgerTerm = ledgerTermOf(ledger);
  const ledgerVersion = Number.isInteger(ledger?.version) ? ledger.version : 0;
  const adopted = adoptedTermStateOf(state, local);
  if (adopted !== undefined && managerOverrideAhead(adopted, local)) {
    return {
      term: adopted.managerTerm,
      version: Number.isInteger(adopted.version) ? adopted.version : ledgerVersion,
    };
  }
  return { term: ledgerTerm, version: ledgerVersion };
}

function managerRawOf(local) {
  const ledger = local.role === 'manager' ? local.ledger : local.snapshot?.ledger;
  return ledger?.manager ?? local.member?.manager ?? null;
}

function managerSeatWithSession(state, local, raw) {
  const sessionId = raw.sessionId ?? seatSessionOfInstance(state, local, raw.instanceId);
  if (typeof sessionId !== 'string' || sessionId === '') {
    return null;
  }
  return managerSeatFrom(raw, sessionId, ledgerTermOf(managerRawLedgerOf(local)));
}

function managerRawLedgerOf(local) {
  return local.role === 'manager' ? local.ledger : local.snapshot?.ledger;
}

function isManagerRaw(raw) {
  return isPlainObject(raw) && typeof raw.instanceId === 'string';
}

function managerSeatFrom(raw, sessionId, term) {
  return {
    instanceId: raw.instanceId,
    sessionId,
    identityName: typeof raw.identityName === 'string' && raw.identityName !== '' ? raw.identityName : raw.instanceId,
    term: Number.isInteger(raw.term) ? raw.term : term,
  };
}

/* 旧台账缺 sessionId 时的补位：名单行 → 本机席位（仅当实例就是本机）。 */
function seatSessionOfInstance(state, local, instanceId) {
  const row = localRosterOf(local).find((entry) => entry.instanceId === instanceId && typeof entry.sessionId === 'string');
  if (row !== undefined) {
    return row.sessionId;
  }
  if (instanceId !== state.self.instanceId) {
    return undefined;
  }
  for (const seat of local.seats?.values?.() ?? []) {
    if (seat.state === 'member') {
      return seat.sessionId;
    }
  }
  return undefined;
}

export function localSeatsOf(local) {
  if (local.seats instanceof Map && local.seats.size > 0) {
    return [...local.seats.values()].filter((seat) => seat.state === 'member');
  }
  return [];
}

export function isLocalSeat(local, sessionId) {
  return localSeatsOf(local).some((seat) => seat.sessionId === sessionId);
}

/* presence 签发席位：managed 站长机固定站长席位；其余取本机活跃席位中 sessionId 码位序最小者。 */
export function presenceSignerOf(local) {
  const seats = localSeatsOf(local);
  if (seats.length === 0) {
    return null;
  }
  if (localModeOf(local) !== 'forum' && local.role === 'manager') {
    return seats.find((seat) => seat.role === 'manager') ?? seats[0];
  }
  return [...seats].sort((left, right) => (left.sessionId < right.sessionId ? -1 : 1))[0];
}

/* —— 离席留痕与冻结原因持久化（设计 §6/§6.2；服务启动/装配处调用） —— */

export function appendDeparted(state, collabId, record) {
  try {
    ensureDir(collabDir(state.dataDir, collabId));
    appendLine(departedFilePath(state.dataDir, collabId), {
      instanceId: record.instanceId,
      sessionId: record.sessionId ?? null,
      reason: record.reason,
      term: record.term ?? null,
      at: record.at ?? new Date().toISOString(),
    });
    m5RuntimeOf(state).departures.add(seatKey(collabId, record.instanceId, record.sessionId));
    bump(state, 'departedAppended');
    return true;
  } catch (error) {
    bump(state, 'departedFailures');
    state.log.warn('离席留痕写入失败（已忽略）', { collabId, reason: error.message });
    return false;
  }
}

/* 冻结原因落载体（观察窗只读展示面）；展示字段不改台账形态，故不写台账行。
 * 空值/非字符串按「清除」处理——不得把 null/'' 写进任意一侧（否则会遮蔽另一侧的有效值）。 */
export function persistFreezeReason(state, collabId, reason) {
  const local = state.collabs.get(collabId);
  if (local === undefined) {
    return false;
  }
  if (typeof reason !== 'string' || reason === '') {
    return clearFreezeReason(state, collabId);
  }
  local.freezeReason = reason;
  if (local.member !== null && typeof local.member === 'object') {
    local.member.freezeReason = reason;
    persistMember(state, local);
  }
  return writeCarrierFreezeReason(state, collabId, reason);
}

/* 解除冻结/恢复/接管成功时清除冻结原因（载体与成员记录两侧；台账字段由观察窗读侧兜底）。 */
export function clearFreezeReason(state, collabId) {
  const local = state.collabs.get(collabId);
  if (local === undefined) {
    return false;
  }
  delete local.freezeReason;
  if (local.member !== null && typeof local.member === 'object') {
    if (local.member.freezeReason !== undefined) {
      delete local.member.freezeReason;
      persistMember(state, local);
    }
  }
  return writeCarrierFreezeReason(state, collabId, null);
}

function writeCarrierFreezeReason(state, collabId, reason) {
  try {
    const path = join(collabDir(state.dataDir, collabId), 'carrier.json');
    const carrier = JSON.parse(readFileSync(path, 'utf8'));
    if (!isPlainObject(carrier)) {
      return false;
    }
    const next = { ...carrier };
    if (reason === null) {
      delete next.freezeReason;
    } else {
      next.freezeReason = reason;
    }
    writeJsonAtomic(path, next);
    return true;
  } catch (error) {
    bump(state, 'freezeReasonPersistFailures');
    state.log.warn('冻结原因写入载体失败（已忽略）', { collabId, reason: error.message });
    return false;
  }
}

/* 冻结是任期面事实，不是协作状态机迁移：内存态 + 载体 + 写闸（不改台账 status）。 */
export function applyManagerFreeze(state, collabId, reason) {
  const local = state.collabs.get(collabId);
  if (local === undefined) {
    return false;
  }
  const runtime = m5RuntimeOf(state);
  if (runtime.frozen.has(collabId)) {
    return false;
  }
  runtime.frozen.set(collabId, reason);
  freezeMemberState(local, runtime, collabId);
  persistFreezeReason(state, collabId, reason);
  suspendLocal(state, local, reason, null);
  /* 冻结是「保持只读直到收敛」：既有停写截止时间（显式/自动移交的 expiresAt+拨号）不得在
   * 冻结期间到期解挂——manager-pending 尤其只能等签发帧或更高任期。 */
  if (local.suspended !== null) {
    local.suspended.deadline = null;
  }
  bump(state, 'managerFreezes');
  state.log.warn('站长任期冻结——停写并等待收敛', { collabId, reason });
  notifyLocal(state, local, freezeNoticeOf(reason));
  return true;
}

/* 成员侧同时进入 frozen（入站白名单由门控按本地状态生效）；站长侧只停写，不改台账状态机。 */
function freezeMemberState(local, runtime, collabId) {
  if (local.role === 'manager' || local.member === null || typeof local.member !== 'object') {
    return;
  }
  runtime.frozenFrom.set(collabId, local.member.state);
  local.member.state = 'frozen';
}

function freezeNoticeOf(reason) {
  if (reason === 'manager-fork') {
    return '任期分叉：本机已停写，等待更高任期的台账或本机用户裁定。';
  }
  if (reason === 'manager-pending') {
    return '自动移交已被接受，等待新站长签发站长变更——本机只读，不换目标、不恢复写。';
  }
  return '站长席位失联：协作冻结停写，可由本机用户确认后手动接管（ws_take_over）。';
}

export function freezeOnManagerOffline(state, collabId) {
  return applyManagerFreeze(state, collabId, 'manager-offline');
}

export function managerFrozenOf(state, collabId) {
  return m5RuntimeOf(state).frozen.get(collabId) ?? null;
}

export function clearManagerFreeze(state, collabId) {
  const runtime = m5RuntimeOf(state);
  const local = state.collabs.get(collabId);
  runtime.frozen.delete(collabId);
  if (local === undefined) {
    return;
  }
  clearFreezeReason(state, collabId);
  if (local.member !== null && local.member.state === 'frozen') {
    local.member.state = runtime.frozenFrom.get(collabId) ?? 'active';
    persistMember(state, local);
  }
  runtime.frozenFrom.delete(collabId);
  if (local.suspended !== null && ['manager-offline', 'manager-pending', 'manager-fork'].includes(local.suspended.reason)) {
    resumeLocal(state, local, 'term-converged');
  }
}

/* —— 暂停与恢复（收敛等待的写闸）—— */

export function suspendLocal(state, local, reason, deadline = null) {
  if (local.suspended !== null) {
    return;
  }
  local.suspended = { reason, since: new Date().toISOString(), deadline };
  bump(state, 'suspensions');
  state.log.warn('协作对外写已暂停（等待收敛）', { collabId: local.collabId, reason });
}

export function resumeLocal(state, local, reason) {
  if (local.suspended === null) {
    return;
  }
  local.suspended = null;
  if (!m5RuntimeOf(state).frozen.has(local.collabId)) {
    clearFreezeReason(state, local.collabId);
  }
  bump(state, 'resumptions');
  state.log.info('协作对外写已恢复', { collabId: local.collabId, reason });
}

function checkSuspensionDeadlines(state, now) {
  const frozen = m5RuntimeOf(state).frozen;
  for (const local of state.collabs.values()) {
    if (local.suspended === null || local.suspended.deadline === null) {
      continue;
    }
    if (frozen.has(local.collabId)) {
      continue;   // 冻结态只读是收敛前提：不得因停写计时到期而提前恢复
    }
    if (now >= local.suspended.deadline) {
      bump(state, 'suspensionExpired');
      resumeLocal(state, local, '在途流程超时未收敛（死信防护）');
    }
  }
}

/* —— 探测定时器：失联判定 + 冻结时限 + presence 周期 —— */

export function startLiveness(state) {
  if (state.probeTimer !== null) {
    return;
  }
  state.probeTimer = setInterval(() => {
    runProbeTick(state);
  }, state.config.managerProbeIntervalMs);
  if (typeof state.probeTimer.unref === 'function') {
    state.probeTimer.unref();
  }
  startPresenceTicker(state);
  runProbeTick(state);
}

export function stopLiveness(state) {
  if (state.probeTimer !== null) {
    clearInterval(state.probeTimer);
    state.probeTimer = null;
  }
  stopPresenceTicker(state);
}

export function startPresenceTicker(state) {
  const runtime = m5RuntimeOf(state);
  if (runtime.presenceTimer !== null) {
    return;
  }
  runLifecycleRestore(state);
  runtime.presenceTimer = setInterval(() => {
    runPresenceTick(state);
  }, positiveMs(state.config.seatPresenceIntervalMs, DEFAULT_PRESENCE_INTERVAL_MS));
  if (typeof runtime.presenceTimer.unref === 'function') {
    runtime.presenceTimer.unref();
  }
}

/* 启动恢复（契约 §2A.1/§6.2）：本模块恢复 auto-offer/manager-pending；目标侧 offer 与
 * handover-pending 由 handover 注册的恢复面处理——避免 takeover→handover 的模块环。 */
const lifecycleRestorers = [];

export function registerLifecycleRestorer(restorer) {
  if (typeof restorer === 'function' && !lifecycleRestorers.includes(restorer)) {
    lifecycleRestorers.push(restorer);
  }
}

function runLifecycleRestore(state) {
  const runtime = m5RuntimeOf(state);
  if (runtime.lifecycleRestored === true) {
    return;
  }
  runtime.lifecycleRestored = true;
  for (const collabId of state.collabs.keys()) {
    try {
      restoreAutoTransferState(state, collabId);
    } catch (error) {
      bump(state, 'eventFailures');
      state.log.warn('生命周期恢复异常（已隔离）', { collabId, reason: error?.message });
    }
  }
  for (const restorer of lifecycleRestorers) {
    try {
      restorer(state);
    } catch (error) {
      bump(state, 'eventFailures');
      state.log.warn('交接恢复异常（已隔离）', { reason: error?.message });
    }
  }
}

export function stopPresenceTicker(state) {
  const runtime = m5RuntimeOf(state);
  if (runtime.presenceTimer !== null) {
    clearInterval(runtime.presenceTimer);
    runtime.presenceTimer = null;
  }
  clearTimerMap(runtime.autoAcceptTimers);
  clearTimerMap(runtime.syncWatch);
  clearTimerMap(runtime.handshakeRetryTimers);
  runtime.handshakeRetries?.clear?.();
}

function clearTimerMap(timers) {
  for (const timer of timers?.values?.() ?? []) {
    clearTimeout(timer);
  }
  timers?.clear?.();
}

export function runProbeTick(state) {
  try {
    const now = nowMs(state);
    checkFrozenDeadlines(state, now);
    checkSuspensionDeadlines(state, now);
    for (const local of state.collabs.values()) {
      maybeProbeManager(state, local);
    }
  } catch (error) {
    state.log.error('探测定时器异常（已隔离，不退出进程）', { reason: error.message });
  }
}

function maybeProbeManager(state, local) {
  if (typeof state.probe !== 'function' || local.role === 'manager' || localModeOf(local) === 'forum') {
    return;
  }
  if (isArchived(localStateOf(local))) {
    return;
  }
  const probeState = probeStateOf(state, local.collabId);
  if (probeState.inFlight) {
    return;
  }
  const manager = managerSeatOfLedger(state, local);
  const endpoint = manager === null ? undefined : endpointFor(state, local, manager.instanceId);
  if (endpoint === undefined) {
    bump(state, 'probeSkippedNoEndpoint');
    return;
  }
  probeState.inFlight = true;
  bump(state, 'probeAttempts');
  probePeer(state, endpoint)
    .then((result) => {
      applyProbeResult(state, local, probeState, result);
    })
    .catch((error) => {
      state.log.warn('探测任务异常（已隔离）', { collabId: local.collabId, reason: error.message });
    })
    .finally(() => {
      probeState.inFlight = false;
    });
}

function probeStateOf(state, collabId) {
  let held = state.probes.get(collabId);
  if (held === undefined) {
    held = { failSince: null, offline: false, inFlight: false };
    state.probes.set(collabId, held);
  }
  return held;
}

export async function probePeer(state, endpoint) {
  try {
    return await state.probe(endpoint.address, endpoint.port);
  } catch (error) {
    return { reachable: false, reason: error.message };
  }
}

function applyProbeResult(state, local, probeState, result) {
  if (result.reachable === true) {
    bump(state, 'probeSuccesses');
    const wasOffline = probeState.offline;
    probeState.failSince = null;
    probeState.offline = false;
    if (wasOffline) {
      bump(state, 'managerRecovered');
      state.log.info('站长恢复应答（判定解除）', { collabId: local.collabId });
      runHandshake(state, { collabId: local.collabId });
    }
    return;
  }
  bump(state, 'probeFailures');
  /* 失联判定同一时钟域：探测失败累计与 managerEvidenceAt 都用单调钟，墙钟前跳/回拨
   * 不得让一次失败就冻结或让判定长期不生效。 */
  const now = monoNow(state);
  if (probeState.failSince === null) {
    probeState.failSince = now;
  }
  if (!probeState.offline && now - probeState.failSince >= managerLossMs(state)) {
    probeState.offline = true;
    bump(state, 'managerOffline');
    state.log.warn('连续探测失败达判定时限——站长失联', { collabId: local.collabId, reason: result.reason });
    freezeOnManagerOffline(state, local.collabId);
  }
}

export function managerLossTimeoutMsOf(state) {
  return positiveMs(state.config.managerLossTimeoutMs ?? state.config.managerOfflineMs, DEFAULT_MANAGER_LOSS_MS);
}
function managerLossMs(state) {
  return managerLossTimeoutMsOf(state);
}

function dialTimeoutMs(state) {
  return positiveMs(state.config.dialTimeoutMs, DEFAULT_DIAL_MS);
}

function seatTimeoutMs(state) {
  return positiveMs(state.config.sessionSeatTimeoutMs, DEFAULT_SEAT_TIMEOUT_MS);
}

function seatGraceMs(state) {
  return positiveMs(state.config.sessionSeatGraceMs ?? state.seatGraceMs, DEFAULT_SEAT_GRACE_MS);
}

function takeoverWindowMs(state) {
  return positiveMs(state.config.sessionTakeoverWindowMs ?? state.config.takeoverWindowMs, DEFAULT_TAKEOVER_WINDOW_MS);
}

function handoverConfirmMs(state) {
  return positiveMs(state.config.handoverConfirmTimeoutMs ?? state.handoverConfirmTimeoutMs, DEFAULT_HANDOVER_CONFIRM_MS);
}

/* —— presence 周期与离席判定 —— */

export function runPresenceTick(state) {
  try {
    const wallNow = nowMs(state);
    const mono = monoNow(state);
    sendPresenceSweep(state, wallNow);
    sweepPresenceExpiry(state, mono);
    sweepSeatGrace(state, wallNow);
    checkManagerLoss(state, mono);
    resendPendingChanges(state, wallNow);
  } catch (error) {
    state.log.error('席位心跳定时器异常（已隔离）', { reason: error.message });
  }
}

function sendPresenceSweep(state, now) {
  for (const local of state.collabs.values()) {
    if (isLocalArchivedState(local)) {
      continue;
    }
    const signer = presenceSignerOf(local);
    if (signer !== null) {
      sendPresenceFor(state, local, signer, now);
    }
  }
}

/* 一机一帧：managed 成员只发站长机；站长发全体成员机；forum 成员发中继、中继发其余成员。 */
function sendPresenceFor(state, local, signer, now) {
  const payload = {
    collabId: local.collabId,
    instanceId: state.self.instanceId,
    sessions: localSeatsOf(local).map((seat) => seat.sessionId),
    sentAt: new Date(now).toISOString(),
  };
  for (const instanceId of presenceTargetsOf(state, local)) {
    const endpoint = endpointFor(state, local, instanceId);
    if (endpoint === undefined) {
      bump(state, 'presenceSkippedNoEndpoint');
      continue;
    }
    /* 心跳即发即弃（设计 §5.6）：不走可靠出箱，失败只计数不重试排队。 */
    const sent = sendPresenceOnce(state, local, instanceId, endpoint, payload, signer);
    if (sent === true) {
      bump(state, 'presenceSent');
    }
  }
}

function sendPresenceOnce(state, local, instanceId, endpoint, payload, signer) {
  if (typeof state.sendDirect === 'function') {
    const result = state.sendDirect({
      collabId: local.collabId,
      to: { instanceId, address: endpoint.address, port: endpoint.port },
      type: 'seat-presence',
      payload,
      fromSessionId: signer.sessionId,
    });
    return result.ok === true;
  }
  return sendTo(state, local.collabId, instanceId, endpoint, 'seat-presence', payload, { fromSessionId: signer.sessionId }).ok === true;
}

function presenceTargetsOf(state, local) {
  const ids = new Set();
  if (localModeOf(local) === 'forum') {
    const relay = relayInstanceOf(state, local);
    if (relay === null || relay === state.self.instanceId) {
      for (const entry of localRosterOf(local)) {
        ids.add(entry.instanceId);
      }
    } else {
      ids.add(relay);
    }
  } else if (local.role === 'manager') {
    for (const entry of localRosterOf(local)) {
      ids.add(entry.instanceId);
    }
  } else {
    const manager = managerSeatOfLedger(state, local);
    if (manager !== null) {
      ids.add(manager.instanceId);
    }
  }
  ids.delete(state.self.instanceId);
  return [...ids];
}

function relayInstanceOf(state, local) {
  if (localModeOf(local) !== 'forum') {
    return null;
  }
  if (local.role === 'manager') {
    return state.self.instanceId;
  }
  return local.member?.originator?.instanceId ?? null;
}

/* 列表级刷新只由 seat-presence 触发；直连协作帧另行刷新。两者都要求传输对端证据。 */
export function handleSeatPresenceFrame(state, frame, meta) {
  const local = state.collabs.get(frame.collabId);
  if (local === undefined) {
    bump(state, 'presenceUnknownCollab');
    return;
  }
  const peer = transportPeerOf(meta);
  const notice = frame.payload;
  const now = monoNow(state);
  const result = applySeatPresence(m5RuntimeOf(state).presence, notice, now, {
    peerInstanceId: peer,
    mode: localModeOf(local),
    relayPeerInstanceId: peer,
    currentRelayPeerInstanceId: relayInstanceOf(state, local),
  });
  if (result.reason !== undefined) {
    bump(state, 'presenceRejected');
    return;
  }
  bump(state, 'presenceListsIn');
  noteManagerEvidenceFromList(state, local, notice, now);
  relayForumPresence(state, local, frame, notice);
}

/* forum：中继把成员的原始心跳转发给其余成员（from 保持原发机器），接收侧按 originMsgId +
 * 当前中继连接放行（设计 §2A.9）。转达副本不再二次转发（防环）。 */
function relayForumPresence(state, local, frame, notice) {
  if (!isPresenceRelayable(state, local, notice)) {
    return;
  }
  const originMsgId = typeof frame.msgId === 'string' ? frame.msgId : '';
  if (originMsgId === '') {
    return;
  }
  const relayed = forwardPresenceToPeers(state, local, frame, notice, originMsgId);
  if (relayed > 0) {
    bump(state, 'presenceRelayed');
  }
}

function isPresenceRelayable(state, local, notice) {
  if (localModeOf(local) !== 'forum' || relayInstanceOf(state, local) !== state.self.instanceId) {
    return false;
  }
  return typeof notice.originMsgId !== 'string' || notice.originMsgId === '';
}

function forwardPresenceToPeers(state, local, frame, notice, originMsgId) {
  let relayed = 0;
  for (const entry of localRosterOf(local)) {
    if (!isPresenceForwardTarget(state, frame, entry)) {
      continue;
    }
    const endpoint = endpointFor(state, local, entry.instanceId);
    if (endpoint === undefined) {
      continue;
    }
    const sent = sendTo(state, local.collabId, entry.instanceId, endpoint, 'seat-presence', { ...notice, originMsgId }, {
      from: frame.from,
      fromSessionId: frame.from.sessionId,
    });
    if (sent.ok === true) {
      relayed++;
    }
  }
  return relayed;
}

function isPresenceForwardTarget(state, frame, entry) {
  return entry.instanceId !== state.self.instanceId && entry.instanceId !== frame.from.instanceId;
}

/* 直连协作帧刷新（转达副本不刷新由 presence 表判定）；只刷新该帧的发送席位。 */
export function noteDirectFramePresence(state, frame, meta) {
  const local = state.collabs.get(frame.collabId);
  if (local === undefined || frame.type === 'seat-presence') {
    return;
  }
  const peer = transportPeerOf(meta);
  const now = monoNow(state);
  const result = applyDirectFrame(m5RuntimeOf(state).presence, frame, now, { peerInstanceId: peer });
  if (result.refreshed === true) {
    bump(state, 'presenceDirectRefreshed');
    noteManagerEvidence(state, local, frame.from?.instanceId, now);
  }
}

/* 传输对端实例必须由连接层给出（meta.peerInstanceId，设计 §2A.9「只信直连」）；
 * 不得取帧内 from，也不得按地址反查——两者都会让发送方自证身份（fail-closed）。 */
function transportPeerOf(meta) {
  return typeof meta?.peerInstanceId === 'string' && meta.peerInstanceId !== '' ? meta.peerInstanceId : null;
}

function noteManagerEvidence(state, local, instanceId, now) {
  const manager = managerSeatOfLedger(state, local);
  if (manager !== null && instanceId === manager.instanceId) {
    m5RuntimeOf(state).managerEvidenceAt.set(local.collabId, now);
  }
}

function noteManagerEvidenceFromList(state, local, notice, now) {
  if (localModeOf(local) !== 'managed') {
    return;
  }
  const manager = managerSeatOfLedger(state, local);
  if (manager !== null && notice.instanceId === manager.instanceId && notice.sessions.includes(manager.sessionId)) {
    m5RuntimeOf(state).managerEvidenceAt.set(local.collabId, now);
  }
}

function sweepPresenceExpiry(state, monoNowMs) {
  const expired = expireSeats(m5RuntimeOf(state).presence, monoNowMs, seatTimeoutMs(state));
  for (const entry of expired) {
    const local = state.collabs.get(entry.collabId);
    if (local !== undefined) {
      handleExpiredSeat(state, local, entry, nowMs(state));
    }
  }
}

function handleExpiredSeat(state, local, entry, now) {
  appendDeparted(state, local.collabId, {
    instanceId: entry.instanceId,
    sessionId: entry.sessionId,
    reason: 'session-timeout',
    term: ledgerTermOf(local.ledger ?? local.snapshot?.ledger),
    at: new Date(now).toISOString(),
  });
  bump(state, 'seatsExpired');
  if (localModeOf(local) === 'forum') {
    expireForumSeat(state, local, entry);
    return;
  }
  if (local.role === 'manager') {
    removeExpiredRemoteSeat(state, local, entry);
  }
}

/* forum 中继席位超时：合成「中继已离席」的路由降级（不代写他人 leave）。 */
function expireForumSeat(state, local, entry) {
  if (entry.instanceId !== relayInstanceOf(state, local)) {
    return;
  }
  state.relayDown.add(local.collabId);
  bump(state, 'relayPresenceDeparted');
}

/* 远端席位超时：站长核移除名单行、写名单事件并刷新快照（设计 §3.2）。 */
function removeExpiredRemoteSeat(state, local, entry) {
  const row = local.ledger.members.find((member) => member.instanceId === entry.instanceId
    && (member.sessionId === undefined || member.sessionId === entry.sessionId));
  if (row === undefined || row.role === 'manager') {
    return;
  }
  const applied = mutateRoster(state, local, (ledger) => {
    ledger.members = ledger.members.filter((member) => member !== row);
    ledger.events = appendEvent(ledger, rosterLeaveEventOf(row, 'presence-timeout', ledger));
  });
  if (applied !== null) {
    releaseJoiningOf(state, local.collabId, row.sessionId);
    bump(state, 'seatsRemovedRemote');
    /* 移除与广播同属站长核义务（设计 §3.2）：只落台账不发名单通告，其余成员会长期保留
     * 已离席行，直到下一次快照或重新对表。 */
    broadcastRosterRefresh(state, local);
  }
}

/* 席位移除生命周期收尾：未确认的两段式 joining 记录不得跨离席残留。 */
function releaseJoiningOf(state, collabId, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    return;
  }
  try {
    state.join?.releaseJoining?.(collabId, sessionId);
  } catch (error) {
    bump(state, 'eventFailures');
    state.log.warn('未确认入席记录释放失败（已隔离）', { collabId, sessionId, reason: error?.message });
  }
}

function appendEvent(ledger, event) {
  return [...(Array.isArray(ledger.events) ? ledger.events : []), event];
}

function rosterLeaveEventOf(row, reason, ledger) {
  return {
    type: 'leave',
    seat: { instanceId: row.instanceId, sessionId: row.sessionId, identityName: row.identityName },
    reason,
    term: ledgerTermOf(ledger),
    at: new Date().toISOString(),
  };
}

/* 台账写：暂停/冻结期间不写。 */
function mutateRoster(state, local, apply) {
  if (local.suspended !== null) {
    bump(state, 'mutationSuspended');
    return null;
  }
  apply(local.ledger);
  local.ledger.version++;
  local.ledger.updatedAt = new Date().toISOString();
  try {
    ensureDir(collabDir(state.dataDir, local.collabId));
    appendLedger(state.dataDir, local.ledger);
  } catch (error) {
    state.log.warn('台账写入失败（内存态继续）', { collabId: local.collabId, reason: error.message });
  }
  return local.ledger;
}

/* —— 站长失联判定与冻结 —— */

function checkManagerLoss(state, now) {
  for (const local of state.collabs.values()) {
    if (local.role === 'manager' || localModeOf(local) === 'forum' || isLocalArchivedState(local)) {
      continue;
    }
    const runtime = m5RuntimeOf(state);
    if (runtime.frozen.has(local.collabId)) {
      continue;
    }
    const manager = managerSeatOfLedger(state, local);
    if (manager === null || manager.instanceId === state.self.instanceId) {
      continue;
    }
    if (now - lastManagerEvidence(state, local, now) >= managerLossMs(state)) {
      freezeOnManagerOffline(state, local.collabId);
    }
  }
}

/* 进程刚启动/从未收到站长直连帧：以启动时刻（单调钟）起算，避免重启即冻结。
 * managerEvidenceAt 只存单调钟读数——presence 与直连帧写入同一域，墙钟读数绝不混入。 */
function lastManagerEvidence(state, local, now) {
  const runtime = m5RuntimeOf(state);
  const seen = runtime.managerEvidenceAt.get(local.collabId);
  if (Number.isFinite(seen) && seen > 0) {
    return seen;
  }
  runtime.managerEvidenceAt.set(local.collabId, now);
  return now;
}

/* —— 会话宽限与离席（桥注销时由服务层调用 noteSeatClosed） —— */

export function noteSeatClosed(state, collabId, sessionId, at = null) {
  const local = state.collabs.get(collabId);
  if (local === undefined) {
    return false;
  }
  const seat = local.seats?.get?.(sessionId);
  if (seat === undefined || seat.state !== 'member') {
    return false;
  }
  m5RuntimeOf(state).closedSeats.set(seatKey(collabId, state.self.instanceId, sessionId), { sessionId, closedAt: at ?? nowMs(state) });
  bump(state, 'seatClosedNoted');
  return true;
}

export function noteSeatReopened(state, collabId, sessionId) {
  return m5RuntimeOf(state).closedSeats.delete(seatKey(collabId, state.self.instanceId, sessionId));
}

export function sweepSeatGrace(state, now = nowMs(state)) {
  const runtime = m5RuntimeOf(state);
  for (const [key, record] of [...runtime.closedSeats.entries()]) {
    const local = state.collabs.get(key.split('\u0000')[0]);
    /* 宽限期内同会话重连即取消离席（设计 §3.2）：席位重新持有桥即视为重开，宽限不再计时。 */
    if (seatReopenedInGrace(local, record.sessionId)) {
      if (local !== undefined) {
        noteSeatReopened(state, local.collabId, record.sessionId);
      } else {
        runtime.closedSeats.delete(key);
      }
      continue;
    }
    if (now - record.closedAt < seatGraceMs(state)) {
      continue;
    }
    runtime.closedSeats.delete(key);
    closeSeatAfterGrace(state, local, record.sessionId, now);
  }
}

function seatReopenedInGrace(local, sessionId) {
  if (local === undefined) {
    return false;
  }
  const seat = local.seats?.get?.(sessionId);
  return seat !== undefined && typeof seat.bridgeId === 'string' && seat.bridgeId !== '';
}

function closeSeatAfterGrace(state, local, sessionId, now) {
  if (local === undefined) {
    return;
  }
  const seat = local.seats?.get?.(sessionId);
  if (seat === undefined || seat.state !== 'member') {
    return;
  }
  const managerSeat = localModeOf(local) === 'managed' && local.role === 'manager' && seat.role === 'manager';
  if (managerSeat) {
    closeManagerSeat(state, local, seat, now);
    return;
  }
  closeMemberSeat(state, local, seat, now);
}

/* 站长会话关闭（机器在线）：宽限到期后按 joinSeq 选可达成员自动移交；无成员则写终态。 */
function closeManagerSeat(state, local, seat, now) {
  appendDeparted(state, local.collabId, {
    instanceId: state.self.instanceId,
    sessionId: seat.sessionId,
    reason: 'manager-session-closed',
    term: ledgerTermOf(local.ledger),
    at: new Date(now).toISOString(),
  });
  const others = local.ledger.members.filter((member) => member.role !== 'manager');
  /* 席位保留到移交发帧之后：闭塞的站长席位仍是本机唯一可签发的身份（fromSessionId），
   * 先移除会让 auto-offer/变更广播因无席位署名而被发送面拒绝。 */
  if (others.length > 0) {
    autoTransfer(state, { collabId: local.collabId, managerSessionId: seat.sessionId });
  }
  removeLocalSeat(local, seat.sessionId, { persist: true, dataDir: state.dataDir });
  /* 台账仍在本机时角色以台账为准：席位缓存退出不得让本机提前变成员。 */
  local.role = 'manager';
  if (others.length === 0) {
    completeTerminalCollab(state, local);
  }
}

/* 成员会话关闭：作者广播 leave；managed 站长核移除名单行并刷新快照。 */
function closeMemberSeat(state, local, seat, now) {
  removeLocalSeat(local, seat.sessionId, { persist: true, dataDir: state.dataDir });
  appendDeparted(state, local.collabId, {
    instanceId: state.self.instanceId,
    sessionId: seat.sessionId,
    reason: 'session-closed',
    term: ledgerTermOf(local.ledger ?? local.snapshot?.ledger),
    at: new Date(now).toISOString(),
  });
  if (localModeOf(local) === 'forum') {
    leaveClosedForumSeat(state, local, seat, now);
    return;
  }
  leaveClosedManagedSeat(state, local, seat);
}

function leaveClosedManagedSeat(state, local, seat) {
  if (local.role !== 'manager') {
    informManagerOfLeave(state, local, seat);
    if (localSeatsOf(local).length === 0 && managerUnreachable(state, local)) {
      /* 站长离线且本机最后一人离席：写本地只读终态副本（设计 §3.4），不冒充权威台账。 */
      writeLocalTerminalCopy(state, local);
      return;
    }
    clearLocalParticipation(state, local);
    return;
  }
  const row = local.ledger.members.find((member) => member.instanceId === state.self.instanceId
    && (member.sessionId === undefined || member.sessionId === seat.sessionId));
  if (row !== undefined) {
    mutateRoster(state, local, (ledger) => {
      ledger.members = ledger.members.filter((member) => member !== row);
      ledger.events = appendEvent(ledger, rosterLeaveEventOf(row, 'session-closed', ledger));
    });
    releaseJoiningOf(state, local.collabId, seat.sessionId);
  }
  broadcastRosterRefresh(state, local);
  if (localSeatsOf(local).length === 0 && !hasManagerRow(local.ledger)) {
    completeTerminalCollab(state, local);
  }
}

function informManagerOfLeave(state, local, seat) {
  const manager = managerSeatOfLedger(state, local);
  if (manager === null || manager.instanceId === state.self.instanceId) {
    return;
  }
  const endpoint = endpointFor(state, local, manager.instanceId);
  if (endpoint !== undefined) {
    sendTo(state, local.collabId, manager.instanceId, endpoint, 'leave', {}, { fromSessionId: seat.sessionId });
  }
}

function leaveClosedForumSeat(state, local, seat, now) {
  const event = emitForumLeaveEvent(state, local, now);
  if (event !== null) {
    broadcastForumLeave(state, local, event, seat);
  }
  if (localSeatsOf(local).length === 0) {
    clearLocalParticipation(state, local);
  }
}

function emitForumLeaveEvent(state, local, now) {
  if (local.members?.apply === undefined) {
    return null;
  }
  const event = {
    eventId: newMsgId(),
    kind: 'leave',
    instanceId: state.self.instanceId,
    identityName: state.self.identityName,
    ts: new Date(now).toISOString(),
  };
  return local.members.apply(event) === 'added' ? event : null;
}

function broadcastForumLeave(state, local, event, seat) {
  for (const entry of localRosterOf(local)) {
    if (entry.instanceId === state.self.instanceId) {
      continue;
    }
    const endpoint = endpointFor(state, local, entry.instanceId);
    if (endpoint !== undefined) {
      sendTo(state, local.collabId, entry.instanceId, endpoint, 'leave', { eventId: event.eventId, ts: event.ts }, { fromSessionId: seat.sessionId });
    }
  }
}

function clearLocalParticipation(state, local) {
  if (local.member !== null && typeof local.member === 'object') {
    local.member.state = 'left';
    local.member.archivedAt = new Date().toISOString();
    persistMember(state, local);
  }
  /* 只清进程内静音基线：本机可能还有同协作的其他活跃席位，不能归档全部席位。 */
  forgetMuteBaselinesOfCollab(state, local.collabId);
  bump(state, 'localSeatsLeft');
}

function broadcastRosterRefresh(state, local) {
  for (const entry of local.ledger.members) {
    const endpoint = entry.instanceId === state.self.instanceId ? undefined : endpointFor(state, local, entry.instanceId);
    if (endpoint !== undefined) {
      sendTo(state, local.collabId, entry.instanceId, endpoint, 'notice', { event: 'roster', version: local.ledger.version });
    }
  }
}

function hasManagerRow(ledger) {
  return ledger.members.some((member) => member.role === 'manager');
}

/* 成员核的本地只读终态副本（设计 §3.4）：站长已离线、最后一人离席时写 snapshot.json，
 * 名单清空、manager:null、managerTerm 保留、version+1、localTerminal:true；不写共享权威台账。
 * 更高 term 的权威台账到达时由快照受理面覆盖。 */
export function writeLocalTerminalCopy(state, local) {
  const source = local.snapshot?.ledger ?? local.ledger;
  if (!isPlainObject(source)) {
    return false;
  }
  const terminal = structuredClone(source);
  terminal.status = 'completed';
  terminal.members = [];
  terminal.manager = null;
  terminal.version = (Number.isInteger(terminal.version) ? terminal.version : 1) + 1;
  terminal.updatedAt = new Date().toISOString();
  terminal.endedAt = terminal.updatedAt;
  terminal.localTerminal = true;
  delete terminal.managerWindow;
  local.snapshot = {
    version: terminal.version,
    digest: ledgerDigest(terminal),
    receivedAt: terminal.updatedAt,
    from: { instanceId: state.self.instanceId, identityName: state.self.identityName },
    ledger: terminal,
  };
  persistSnapshot(state, local);
  if (local.member !== null && typeof local.member === 'object') {
    local.member.state = 'completed';
    local.member.archivedAt = terminal.updatedAt;
    persistMember(state, local);
  }
  /* 本地终态与 end 帧入口同口径：归档本机席位（退出注入与静音聚合）并清静音基线。 */
  archiveLocalSeatsOfState(state, local);
  forgetMuteBaselinesOfCollab(state, local.collabId);
  bump(state, 'localTerminalCopies');
  state.log.info('站长离线且最后一人离席——已写本地只读终态副本', { collabId: local.collabId });
  return true;
}

/* 最后一人离席：终态空名单、manager:null、managerTerm 保留、version+1（D17）。 */
function completeTerminalCollab(state, local) {
  if (local.role !== 'manager' || local.ledger === null) {
    return false;
  }
  mutateRoster(state, local, (ledger) => {
    ledger.status = 'completed';
    ledger.endedAt = new Date().toISOString();
    ledger.members = [];
    ledger.manager = null;
    delete ledger.managerWindow;
  });
  local.member = { ...(local.member ?? {}), state: 'completed', archivedAt: new Date().toISOString() };
  persistMember(state, local);
  broadcastEndNotice(state, local);
  bump(state, 'collabsCompletedBySeats');
  return true;
}

function broadcastEndNotice(state, local) {
  for (const [instanceId, endpoint] of local.endpoints) {
    if (instanceId !== state.self.instanceId) {
      sendTo(state, local.collabId, instanceId, endpoint, 'end', {});
    }
  }
}

/* —— 自动移交（原站长核发起；新站长签发，设计 §2A.5） —— */

export function autoTransfer(state, { collabId, managerSessionId, successorSeat = null }) {
  const local = state.collabs.get(collabId);
  const rejection = autoTransferRejection(state, local, managerSessionId);
  if (rejection !== null) {
    return { ok: false, reason: rejection };
  }
  const prevManager = managerSeatOfLedger(state, local);
  const target = successorSeat ?? pickAutoSuccessor(state, local, prevManager);
  if (target === null) {
    return noSuccessorOutcome(state, local);
  }
  return dispatchAutoOffer(state, local, prevManager, target);
}

function autoTransferRejection(state, local, managerSessionId) {
  if (local === undefined || local.role !== 'manager' || local.ledger === null) {
    return 'not-manager';
  }
  if (local.suspended !== null || local.ledger.status !== 'active') {
    return 'not-writable';
  }
  const prevManager = managerSeatOfLedger(state, local);
  if (prevManager === null) {
    return 'manager-seat-mismatch';
  }
  return managerSessionId === undefined || prevManager.sessionId === managerSessionId ? null : 'manager-seat-mismatch';
}

function noSuccessorOutcome(state, local) {
  if (local.ledger.members.filter((member) => member.role !== 'manager').length === 0) {
    completeTerminalCollab(state, local);
    return { ok: true, completed: true };
  }
  freezeOnManagerOffline(state, local.collabId);
  notifyLocal(state, local, '站长会话已关闭且无可达接手者：本机只读，等待其余成员手动接管。');
  return { ok: false, reason: 'no-successor' };
}

/* 目标：除旧站长外的活跃席位，按 (joinSeq,sessionId) 升序，仅取可达者（§2A.5）。 */
function pickAutoSuccessor(state, local, prevManager) {
  const runtime = m5RuntimeOf(state);
  return candidateSeatsOf(state, local, runtime, prevManager, null)[0] ?? null;
}

function candidateSeatsOf(state, local, runtime, prevManager, excluded) {
  const seats = local.ledger.members
    .filter((member) => member.role !== 'manager')
    .map((member) => ({
      instanceId: member.instanceId,
      sessionId: member.sessionId,
      identityName: member.identityName,
      joinSeq: member.joinSeq,
      role: member.role,
    }));
  return autoSuccessorCandidates(runtime.presence, seats, {
    collabId: local.collabId,
    prevManager,
    now: monoNow(state),
    timeoutMs: seatTimeoutMs(state),
    /* 同机席位不需要网络端点：自动移交走核内旁路（设计 §2A.5 的「机器仍在线」含同机多会话）。 */
    hasEndpoint: (seat) => seat.instanceId === state.self.instanceId || endpointFor(state, local, seat.instanceId) !== undefined,
    departed: (seat) => runtime.departed(local.collabId, seat),
  }).filter((seat) => excluded === null || !sameSeat(seat, excluded));
}

function dispatchAutoOffer(state, local, prevManager, target) {
  const runtime = m5RuntimeOf(state);
  if (local.role !== 'manager' || local.ledger === null) {
    return { ok: false, reason: 'not-manager' };
  }
  const endpoint = target.instanceId === state.self.instanceId ? undefined : endpointFor(state, local, target.instanceId);
  if (target.instanceId !== state.self.instanceId && endpoint === undefined) {
    return { ok: false, reason: 'target-unreachable' };
  }
  const ledger = structuredClone(local.ledger);
  const offerId = randomUUID();
  const now = nowMs(state);
  const expiresAt = new Date(now + handoverConfirmMs(state)).toISOString();
  const offer = {
    offerId,
    auto: true,
    prevManager,
    target: { instanceId: target.instanceId, sessionId: target.sessionId ?? '' },
    baseTerm: ledgerTermOf(ledger),
    version: ledger.version,
    digest: ledgerDigest(ledger),
    ledger,
    endpoints: Object.fromEntries(local.endpoints),
    expiresAt,
    expiresAtMs: Date.parse(expiresAt),
  };
  runtime.autoPending.set(local.collabId, offer);
  broadcastAutoOffer(state, local, offer);
  persistAutoOffer(state, local, offer);
  suspendLocal(state, local, 'handover-pending', offer.expiresAtMs + dialTimeoutMs(state));
  armAutoAcceptDeadline(state, local, offer);
  if (target.instanceId === state.self.instanceId) {
    deliverAutoOfferLocally(state, local, offer, target);
  } else {
    sendAutoOfferFrame(state, local, offer, target, endpoint);
  }
  bump(state, 'autoOffersSent');
  return { ok: true, offerId, expiresAt, target, message: '自动移交提议已发出，等待目标接受' };
}

/* 同机目标：把 offer 直接交给本核的目标侧自动接受（不经过网络与用户消息注入）。
 * handover.js 在加载时注册该处理面——避免 takeover→handover 的模块环。 */
/** @type {null | ((state: any, local: any, offer: any, target: any) => void)} */
let localAutoOfferHandler = null;

export function registerLocalAutoOfferHandler(handler) {
  localAutoOfferHandler = typeof handler === 'function' ? handler : null;
}

function deliverAutoOfferLocally(state, local, offer, target) {
  if (localAutoOfferHandler === null) {
    /* 目标侧处理面未接线：保留 autoPending 与停写，等超时顺延。 */
    bump(state, 'autoLocalDeliverySkipped');
    return;
  }
  localAutoOfferHandler(state, local, offer, target);
}

function broadcastAutoOffer(state, local, offer) {
  const payload = {
    event: 'auto-offer',
    offerId: offer.offerId,
    prevManager: { instanceId: offer.prevManager.instanceId, sessionId: offer.prevManager.sessionId },
    target: { instanceId: offer.target.instanceId, sessionId: offer.target.sessionId },
    baseTerm: offer.baseTerm,
    version: offer.version,
    expiresAt: offer.expiresAt,
  };
  sendToRoster(state, local, 'notice', payload);
}

function persistAutoOffer(state, local, offer) {
  try {
    ensureDir(collabRunDir(state.dataDir, local.collabId));
    writeJsonAtomic(autoOfferFilePath(state.dataDir, local.collabId), {
      offerId: offer.offerId,
      collabId: local.collabId,
      prevManager: offer.prevManager,
      target: offer.target,
      baseTerm: offer.baseTerm,
      version: offer.version,
      digest: offer.digest,
      expiresAt: offer.expiresAt,
      at: new Date().toISOString(),
    });
  } catch (error) {
    bump(state, 'autoOfferPersistFailures');
    state.log.warn('auto-offer 副本写入失败（已忽略）', { collabId: local.collabId, reason: error.message });
  }
}

function sendAutoOfferFrame(state, local, offer, target, endpoint) {
  const payload = {
    kind: 'offer',
    offerId: offer.offerId,
    baseTerm: offer.baseTerm,
    version: offer.version,
    digest: offer.digest,
    ledger: offer.ledger,
    endpoints: Object.fromEntries(local.endpoints),
    expiresAt: offer.expiresAt,
    auto: true,
  };
  const signer = presenceSignerOf(local);
  sendTo(state, local.collabId, target.instanceId, endpoint, 'handover', payload, {
    fromSessionId: signer?.sessionId,
    ...(typeof target.sessionId === 'string' && target.sessionId !== '' ? { toSessions: [target.sessionId] } : {}),
  });
}

/* 自动接受上界 = dialTimeoutMs（设计 §2A.5）：超时恢复写并顺延下一位。 */
function armAutoAcceptDeadline(state, local, offer) {
  const runtime = m5RuntimeOf(state);
  const prior = runtime.autoAcceptTimers.get(local.collabId);
  if (prior !== undefined) {
    clearTimeout(prior);
  }
  const wait = Math.min(dialTimeoutMs(state), Math.max(0, offer.expiresAtMs - nowMs(state)));
  const timer = setTimeout(() => {
    runtime.autoAcceptTimers.delete(local.collabId);
    try {
      onAutoAcceptTimeout(state, local);
    } catch (error) {
      bump(state, 'eventFailures');
      state.log.error('自动接受超时处理异常（已隔离）', { collabId: local.collabId, reason: error.message });
    }
  }, wait);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  runtime.autoAcceptTimers.set(local.collabId, timer);
}

function onAutoAcceptTimeout(state, local) {
  const runtime = m5RuntimeOf(state);
  const pending = runtime.autoPending.get(local.collabId);
  if (pending === undefined || runtime.managerPending.has(local.collabId)) {
    return;
  }
  runtime.autoPending.delete(local.collabId);
  bump(state, 'autoAcceptTimeouts');
  runtime.autoOffers.get(local.collabId)?.delete?.(pending.offerId);
  /* 已降级/被更高任期取代的核不得再顺延：只清理残留并保持只读。 */
  if (local.role !== 'manager' || local.ledger === null) {
    runtime.autoOffers.delete(local.collabId);
    return;
  }
  resumeLocal(state, local, 'auto-accept-timeout');
  retryAutoTransfer(state, local, pending.target);
}

function retryAutoTransfer(state, local, failedTarget) {
  const prevManager = managerSeatOfLedger(state, local);
  if (prevManager === null || local.role !== 'manager' || local.ledger === null) {
    return;
  }
  const candidates = candidateSeatsOf(state, local, m5RuntimeOf(state), prevManager, failedTarget);
  if (candidates.length === 0) {
    noSuccessorOutcome(state, local);
    return;
  }
  dispatchAutoOffer(state, local, prevManager, candidates[0]);
}

function sameSeat(left, right) {
  return isPlainObject(left) && isPlainObject(right)
    && left.instanceId === right.instanceId
    && left.sessionId === right.sessionId;
}

/* 原站长核收到 accept：只读等待新站长签发（不恢复写、不换目标）。 */
export function markManagerPending(state, local, offer) {
  const runtime = m5RuntimeOf(state);
  runtime.managerPending.set(local.collabId, { ...offer, at: nowMs(state) });
  runtime.autoPending.delete(local.collabId);
  const timer = runtime.autoAcceptTimers.get(local.collabId);
  if (timer !== undefined) {
    clearTimeout(timer);
    runtime.autoAcceptTimers.delete(local.collabId);
  }
  persistManagerPending(state, local, offer);
  applyManagerFreeze(state, local.collabId, 'manager-pending');
  bump(state, 'managerPending');
}

function persistManagerPending(state, local, offer) {
  try {
    ensureDir(collabRunDir(state.dataDir, local.collabId));
    writeJsonAtomic(managerPendingFilePath(state.dataDir, local.collabId), {
      offerId: offer.offerId,
      collabId: local.collabId,
      target: offer.target,
      baseTerm: offer.baseTerm,
      version: offer.version,
      digest: offer.digest,
      expiresAt: offer.expiresAt,
      at: new Date().toISOString(),
    });
  } catch (error) {
    bump(state, 'managerPendingPersistFailures');
    state.log.warn('manager-pending 标记写入失败（已忽略）', { collabId: local.collabId, reason: error.message });
  }
}

/* 采纳新任期时的自动移交收尾：残留的 autoPending/定时器/auto-offer 记录必须一并清掉，
 * 否则降级核上的 5s 定时器会对空台账重试（旧实现直接抛 TypeError），或 autoInFlight 永久阻塞手动接管。 */
export function clearAutoTransferState(state, collabId) {
  const runtime = m5RuntimeOf(state);
  runtime.autoPending.delete(collabId);
  runtime.managerPending.delete(collabId);
  runtime.autoOffers.delete(collabId);
  const timer = runtime.autoAcceptTimers.get(collabId);
  if (timer !== undefined) {
    clearTimeout(timer);
    runtime.autoAcceptTimers.delete(collabId);
  }
  removeLifecycleFile(autoOfferFilePath(state.dataDir, collabId), state, 'autoOfferRecoveryCleanup');
  removeLifecycleFile(managerPendingFilePath(state.dataDir, collabId), state, 'managerPendingRecoveryCleanup');
}

function removeLifecycleFile(path, state, counter) {
  try {
    rmSync(path, { force: true });
  } catch (error) {
    bump(state, counter);
    state.log.warn('生命周期文件清理失败（已忽略）', { path, reason: error.message });
  }
}

function readLifecycleFile(path, state, counter) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    bump(state, counter);
    return null;
  }
}

/* 启动恢复（契约 §2A.1/§6.2）：原站长核的 manager-pending 与 auto-offer 副本在重启后继续生效；
 * 过期/形态不符/任期已推进的记录删除并计数。冻结与只读等待必须一并恢复，否则重启即双主。 */
export function restoreAutoTransferState(state, collabId) {
  const local = state.collabs.get(collabId);
  if (local === undefined || local.role !== 'manager' || local.ledger === null) {
    return;
  }
  restoreManagerPendingOf(state, local);
  if (m5RuntimeOf(state).managerPending.has(collabId)) {
    return;   // 已接受未签发：只读等待，不再重发 offer
  }
  restoreAutoOfferOf(state, local);
}

function restoreManagerPendingOf(state, local) {
  const collabId = local.collabId;
  const raw = readLifecycleFile(managerPendingFilePath(state.dataDir, collabId), state, 'managerPendingRecovery');
  if (!isPlainObject(raw) || raw.collabId !== collabId || typeof raw.offerId !== 'string') {
    return;
  }
  const valid = Date.parse(raw.expiresAt) > nowMs(state)
    && raw.baseTerm === ledgerTermOf(local.ledger)
    && isPlainObject(raw.target);
  if (!valid) {
    removeLifecycleFile(managerPendingFilePath(state.dataDir, collabId), state, 'managerPendingRecoveryExpired');
    return;
  }
  m5RuntimeOf(state).managerPending.set(collabId, { ...raw, at: nowMs(state) });
  applyManagerFreeze(state, collabId, 'manager-pending');
  bump(state, 'managerPendingRestored');
}

function restoreAutoOfferOf(state, local) {
  const collabId = local.collabId;
  const raw = readLifecycleFile(autoOfferFilePath(state.dataDir, collabId), state, 'autoOfferRecovery');
  if (!isPlainObject(raw) || raw.collabId !== collabId) {
    return;
  }
  const offer = restorableAutoOfferOf(state, local, raw);
  if (offer === null) {
    removeLifecycleFile(autoOfferFilePath(state.dataDir, collabId), state, 'autoOfferRecoveryExpired');
    return;
  }
  m5RuntimeOf(state).autoPending.set(collabId, offer);
  suspendLocal(state, local, 'handover-pending', offer.expiresAtMs + dialTimeoutMs(state));
  armAutoAcceptDeadline(state, local, offer);
  bump(state, 'autoOfferRestored');
}

function restorableAutoOfferOf(state, local, raw) {
  if (typeof raw.offerId !== 'string' || !isPlainObject(raw.target)) {
    return null;
  }
  const offer = {
    offerId: raw.offerId,
    auto: true,
    prevManager: managerSeatOfLedger(state, local),
    target: raw.target,
    baseTerm: raw.baseTerm,
    version: raw.version,
    digest: raw.digest,
    ledger: local.ledger,
    expiresAt: raw.expiresAt,
    expiresAtMs: Date.parse(raw.expiresAt),
  };
  if (offer.prevManager === null || offer.baseTerm !== ledgerTermOf(local.ledger) || !(offer.expiresAtMs > nowMs(state))) {
    return null;
  }
  return offer;
}

/* —— D15 重发：站长变更未 ack 前按 presence 节律重发（定向 prevManager + 已端点成员）。 —— */

export function rememberPendingChange(state, collabId, entry) {
  const now = nowMs(state);
  m5RuntimeOf(state).resends.set(collabId, { ...entry, sentAt: now, startedAt: now, attempts: 1, acked: new Set() });
}

function resendPendingChanges(state, now) {
  const runtime = m5RuntimeOf(state);
  for (const [collabId, entry] of [...runtime.resends.entries()]) {
    if (now - entry.sentAt < positiveMs(state.config.seatPresenceIntervalMs, DEFAULT_PRESENCE_INTERVAL_MS)) {
      continue;
    }
    const local = state.collabs.get(collabId);
    if (local === undefined) {
      runtime.resends.delete(collabId);
      continue;
    }
    if (managerChangeSuperseded(state, local, entry)) {
      runtime.resends.delete(collabId);
      continue;
    }
    entry.sentAt = now;
    entry.attempts++;
    resendManagerChanged(state, local, entry);
    if (resendSettled(state, local, entry, now)) {
      runtime.resends.delete(collabId);
    }
  }
}

/* 更高任期已在本地落地：旧变更不再有转发价值。 */
function managerChangeSuperseded(state, local, entry) {
  const localTerm = ledgerTermOf(local.ledger ?? local.snapshot?.ledger);
  return Number.isInteger(entry.payload?.term) && localTerm > entry.payload.term;
}

/* 重发至少持续 managerLossTimeoutMs（覆盖失联判定窗口，重启的旧站长才可能重新收到）；
 * 之后只有「已知端点目标全部 ack」才停——不设固定尝试次数上限（D15：直到 ack 或被更高任期取代）。 */
function resendSettled(state, local, entry, now) {
  const startedAt = Number.isFinite(entry.startedAt) ? entry.startedAt : entry.sentAt;
  if (now - startedAt < managerLossTimeoutMsOf(state)) {
    return false;
  }
  const targets = resendTargetsOf(state, local, entry);
  if (targets.length === 0) {
    return true;
  }
  return targets.every((instanceId) => entry.acked?.has?.(instanceId) === true);
}

function resendTargetsOf(state, local, entry) {
  const targets = new Set();
  if (isPlainObject(entry.prevManager) && endpointFor(state, local, entry.prevManager.instanceId) !== undefined) {
    targets.add(entry.prevManager.instanceId);
  }
  for (const member of local.ledger?.members ?? []) {
    if (member.instanceId !== state.self.instanceId && endpointFor(state, local, member.instanceId) !== undefined) {
      targets.add(member.instanceId);
    }
  }
  return [...targets];
}

function resendManagerChanged(state, local, entry) {
  const targets = new Map();
  if (isPlainObject(entry.prevManager)) {
    targets.set(entry.prevManager.instanceId, entry.prevManager);
  }
  for (const member of local.ledger?.members ?? []) {
    targets.set(member.instanceId, member);
  }
  for (const [instanceId, member] of targets) {
    if (instanceId === state.self.instanceId) {
      continue;
    }
    const endpoint = endpointFor(state, local, instanceId);
    if (endpoint === undefined) {
      continue;
    }
    sendTo(state, local.collabId, instanceId, endpoint, 'notice', entry.payload, {
      fromSessionId: entry.fromSessionId,
      ...(member?.sessionId === undefined ? {} : { toSessions: [member.sessionId] }),
    });
  }
}

/* —— 握手（启动 / 网络恢复 / 治理通告后的对表） —— */

export function runHandshake(state, options = {}) {
  const scope = options.collabId === undefined
    ? [...state.collabs.values()]
    : [state.collabs.get(options.collabId)].filter((local) => local !== undefined);
  for (const local of scope) {
    if (isLocalArchivedState(local) || localModeOf(local) === 'forum') {
      continue;
    }
    handshakeOne(state, local);
  }
}

function handshakeOne(state, local) {
  const payload = handshakePayload(state, local, false);
  if (payload === null) {
    return;
  }
  if (local.role === 'manager') {
    const sent = sendToRoster(state, local, 'notice', payload);
    state.counters.handshakesSent = (state.counters.handshakesSent ?? 0) + sent;
    /* 本机旁路也计入 sendToRoster 的 sent；没有任何远端端点时对表无从发生，直接按未解析处理。 */
    if (!hasRemoteHandshakeTarget(state, local)) {
      markHandshakeUnresolved(state, local);
      return;
    }
    armHandshakeWatch(state, local, sent > 0);
    /* 启动即对表可能早于本机站点端口就位（入队被拒、sent=0）：没有重试就会永久停在旧任期。
     * 在这里做有界补发，等发送面可用后再对表一次。 */
    if (sent === 0) {
      scheduleHandshakeRetry(state, local);
      return;
    }
    clearHandshakeRetry(state, local);
    return;
  }
  const manager = managerSeatOfLedger(state, local);
  if (manager === null) {
    return;
  }
  const endpoint = endpointFor(state, local, manager.instanceId);
  if (endpoint === undefined) {
    return;
  }
  const result = sendTo(state, local.collabId, manager.instanceId, endpoint, 'notice', payload);
  if (result.ok === true) {
    state.counters.handshakesSent = (state.counters.handshakesSent ?? 0) + 1;
  }
  armHandshakeWatch(state, local, result.ok === true);
}

/* 发送面未就位时的一次性补发（有界，避免启动失败路径无限重试）。 */
function scheduleHandshakeRetry(state, local) {
  const runtime = m5RuntimeOf(state);
  if (!(runtime.handshakeRetries instanceof Map)) {
    runtime.handshakeRetries = new Map();
  }
  const attempts = runtime.handshakeRetries.get(local.collabId) ?? 0;
  if (attempts >= HANDSHAKE_RETRY_LIMIT) {
    runtime.handshakeRetries.delete(local.collabId);
    return;
  }
  const prior = runtime.handshakeRetryTimers?.get?.(local.collabId);
  if (prior !== undefined) {
    clearTimeout(prior);
  }
  if (!(runtime.handshakeRetryTimers instanceof Map)) {
    runtime.handshakeRetryTimers = new Map();
  }
  runtime.handshakeRetries.set(local.collabId, attempts + 1);
  const timer = setTimeout(() => {
    runtime.handshakeRetryTimers.delete(local.collabId);
    handshakeOne(state, local);
  }, HANDSHAKE_RETRY_MS);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  runtime.handshakeRetryTimers.set(local.collabId, timer);
}

function clearHandshakeRetry(state, local) {
  const runtime = m5RuntimeOf(state);
  runtime.handshakeRetries?.delete?.(local.collabId);
  const timer = runtime.handshakeRetryTimers?.get?.(local.collabId);
  if (timer !== undefined) {
    clearTimeout(timer);
    runtime.handshakeRetryTimers.delete(local.collabId);
  }
}

function hasRemoteHandshakeTarget(state, local) {
  return (local.ledger?.members ?? []).some((member) => member.instanceId !== state.self.instanceId
    && endpointFor(state, local, member.instanceId) !== undefined);
}

function handshakePayload(state, local, reply) {
  const manager = managerSeatOfLedger(state, local);
  if (localVersionOf(local) === null) {
    return null;
  }
  const pair = adoptedPairOf(state, local);
  const signer = presenceSignerOf(local);
  return {
    event: 'handshake',
    role: local.role,
    managerTerm: pair.term,
    version: pair.version,
    manager: manager === null ? null : { instanceId: manager.instanceId, sessionId: manager.sessionId, identityName: manager.identityName },
    ...managerEndpointPayloadOf(state, local, manager),
    takeover: null,
    reply,
    ...(signer === null ? {} : { sessionId: signer.sessionId }),
  };
}

function managerEndpointPayloadOf(state, local, manager) {
  if (manager === null || manager.instanceId === state.self.instanceId) {
    return {};
  }
  const endpoint = endpointFor(state, local, manager.instanceId);
  return endpoint === undefined ? {} : { managerEndpoint: { address: endpoint.address, port: endpoint.port } };
}

function armHandshakeWatch(state, local, sent) {
  if (sent !== true) {
    return;
  }
  const held = state.handshakeWatch.get(local.collabId);
  if (held !== undefined) {
    clearTimeout(held.timer);
  }
  const timer = setTimeout(() => {
    state.handshakeWatch.delete(local.collabId);
    markHandshakeUnresolved(state, local);
  }, state.handshakeReplyTimeoutMs);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  state.handshakeWatch.set(local.collabId, { timer });
}

function markHandshakeUnresolved(state, local) {
  bump(state, 'handshakeUnresolved');
  if (local.role === 'manager') {
    suspendLocal(state, local, 'handshake-unresolved');
  } else {
    local.handshakeUnresolved = true;
  }
  state.log.warn('握手无法对表（无人在线）——转只读保守运行', { collabId: local.collabId, role: local.role });
  notifyLocal(state, local, '握手未能对表（无人在线）——本机已转只读保守运行，接通后再定位。');
}

function clearHandshakeWatch(state, local) {
  const held = state.handshakeWatch.get(local.collabId);
  if (held !== undefined) {
    clearTimeout(held.timer);
    state.handshakeWatch.delete(local.collabId);
    state.counters.handshakeResolved = (state.counters.handshakeResolved ?? 0) + 1;
  }
}

export async function handleHandshake(state, frame) {
  const local = state.collabs.get(frame.collabId);
  if (local === undefined || frame.from.instanceId === state.self.instanceId || isLocalArchivedState(local)) {
    return;
  }
  bump(state, 'handshakesIn');
  clearHandshakeWatch(state, local);
  if (local.suspended !== null && local.suspended.reason === 'handshake-unresolved') {
    resumeLocal(state, local, 'handshake-contacted');
  }
  local.handshakeUnresolved = false;
  recordHandshakeResponse(state, local, frame);
  noteManagerChangeAck(state, local, frame);
  evaluateRemoteHandshake(state, local, frame);
  if (frame.payload.reply !== true) {
    sendHandshakeReply(state, local, frame);
  }
}

function recordHandshakeResponse(state, local, frame) {
  const responses = m5RuntimeOf(state).handshakeResponses.get(local.collabId) ?? new Map();
  responses.set(frame.from.instanceId, {
    term: frame.payload.managerTerm,
    version: frame.payload.version,
    manager: frame.payload.manager,
    endpoint: frame.payload.managerEndpoint,
    seat: { instanceId: frame.from.instanceId, sessionId: frame.from.sessionId },
    at: monoNow(state),
  });
  m5RuntimeOf(state).handshakeResponses.set(local.collabId, responses);
}

/* D15 的 ack 面：对端以回帧（reply=true）报出同一站长与不低于变更的任期，即视为已收到。 */
function noteManagerChangeAck(state, local, frame) {
  if (frame.payload?.reply !== true) {
    return;
  }
  const entry = m5RuntimeOf(state).resends.get(local.collabId);
  if (entry === undefined || !(entry.acked instanceof Set) || !Number.isInteger(entry.payload?.term)) {
    return;
  }
  if (!Number.isInteger(frame.payload.managerTerm) || frame.payload.managerTerm < entry.payload.term) {
    return;
  }
  if (!sameSeat(frame.payload.manager, entry.payload.manager)) {
    return;
  }
  entry.acked.add(frame.from.instanceId);
}

function sendHandshakeReply(state, local, frame) {
  const endpoint = endpointFor(state, local, frame.from.instanceId);
  if (endpoint === undefined) {
    return;
  }
  const payload = handshakePayload(state, local, true);
  if (payload !== null) {
    sendTo(state, local.collabId, frame.from.instanceId, endpoint, 'notice', payload, { fromSessionId: payload.sessionId });
  }
}

function evaluateRemoteHandshake(state, local, frame) {
  const remote = frame.payload;
  const localTerm = ledgerTermOf(local.ledger ?? local.snapshot?.ledger);
  if (remote.managerTerm > localTerm) {
    requestSnapshotFrom(state, local, frame.from.instanceId, 'catchup');
    return;
  }
  if (remote.managerTerm < localTerm) {
    return;
  }
  evaluateSameTermHandshake(state, local, frame, remote);
}

function evaluateSameTermHandshake(state, local, frame, remote) {
  const localManager = managerSeatOfLedger(state, local);
  if (remote.manager !== null && localManager !== null && remote.manager.sessionId !== localManager.sessionId) {
    applyManagerFreeze(state, local.collabId, 'manager-fork');
    return;
  }
  if (Number.isInteger(remote.version) && remote.version > (localVersionOf(local) ?? 0)) {
    requestSnapshotFrom(state, local, frame.from.instanceId, 'catchup');
    return;
  }
  if (local.role !== 'manager' && remote.role === 'manager' && remote.manager !== null) {
    adoptKnownManager(state, local, remote);
  }
}

function adoptKnownManager(state, local, remote) {
  if (currentManagerIdOf(local) === remote.manager.instanceId) {
    return;
  }
  adoptNewManager(state, local, { instanceId: remote.manager.instanceId, identityName: remote.manager.identityName }, remote.version);
  bump(state, 'managerAdoptedByHandshake');
}

/* 快照请求一律是台账追赶：缺省携 purpose:'catchup'（§7.1 据此放行冻结态成员应答）；
 * 接线层（events 的 request-snapshot 动作）不传 purpose，也必须落到 catchup 上。
 * 请求成功即登记选中来源，供受理侧在本请求上下文内放宽「名单成员」判据（名单陈旧面）。 */
/** @param {string|null} [purpose] */
export function requestSnapshotFrom(state, local, instanceId, purpose = 'catchup') {
  const endpoint = endpointFor(state, local, instanceId);
  if (endpoint === undefined) {
    return false;
  }
  const pair = adoptedPairOf(state, local);
  const payload = {
    kind: 'request',
    managerTerm: pair.term,
    version: pair.version >= 1 ? pair.version : 1,
    ...(purpose === null ? {} : { purpose }),
  };
  const signer = presenceSignerOf(local);
  const sent = sendTo(state, local.collabId, instanceId, endpoint, 'snapshot', payload, { fromSessionId: signer?.sessionId }).ok === true;
  if (sent && purpose === 'catchup') {
    rememberCatchupSource(state, local, instanceId);
  }
  return sent;
}

/* 追赶来源登记：termCtxOf 目前只把 acceptedManager 透传给任期判决，故选择结果挂在该记录上
 * （合并已有字段，不覆盖更高 term 的受理记录）。选择按机器实例——应答会话可与握手会话不同。 */
function rememberCatchupSource(state, local, instanceId) {
  const runtime = m5RuntimeOf(state);
  const seat = runtime.handshakeResponses.get(local.collabId)?.get(instanceId)?.seat;
  const selection = { instanceId };
  if (isPlainObject(seat) && typeof seat.sessionId === 'string' && seat.sessionId !== '') {
    selection.sessionId = seat.sessionId;
  }
  for (const map of [runtime.acceptedManagers, runtime.acceptedManagerMap]) {
    if (!(map instanceof Map)) {
      continue;
    }
    const existing = map.get(local.collabId);
    map.set(local.collabId, { ...(isPlainObject(existing) ? existing : {}), catchupSource: selection });
  }
}

/* —— 接管（窗口内 takeover / 站长不可达 takeover-manual，设计 §2A.6/§2A.7） —— */

/** @param {any} input */
export async function takeOver(state, input = {}) {
  const { collabId, sessionId, token } = input;
  const local = state.collabs.get(collabId);
  if (local === undefined) {
    return { ok: false, message: '本机没有该协作（先 ws_list_collabs）' };
  }
  const rejection = takeoverRejection(state, local, sessionId);
  if (rejection !== null) {
    return { ok: false, message: rejection };
  }
  return takeOverWithChallenge(state, local, sessionId, token);
}

function takeOverWithChallenge(state, local, sessionId, token) {
  const runtime = m5RuntimeOf(state);
  const challenge = runtime.challenges.get(challengeKey(local.collabId, sessionId));
  if (token === undefined || token === null) {
    return beginTakeOver(state, local, sessionId);
  }
  if (challenge === undefined || !challengeValid(challenge, token, nowMs(state))) {
    return { ok: false, message: '确认令牌无效或已过期——请重新调用 ws_take_over（首次只签发挑战）' };
  }
  runtime.challenges.delete(challengeKey(local.collabId, sessionId));
  return finishTakeOver(state, local, sessionId, challenge);
}

function challengeKey(collabId, sessionId) {
  return `${collabId}\u0000${sessionId}`;
}

function challengeValid(challenge, token, now) {
  return typeof token === 'string' && token === challenge.token && now <= challenge.deadline;
}

function takeoverRejection(state, local, sessionId) {
  if (local.role === 'manager') {
    return '本机就是该协作的站长——无需接管';
  }
  if (isArchived(localStateOf(local))) {
    return '协作已结束（或已退出）——不可接管';
  }
  if (!isLocalSeat(local, sessionId)) {
    return '调用会话不是本机在该协作的活跃席位——不可接管（先入席）';
  }
  if (local.snapshot === null) {
    return '本机无快照——无从恢复台账，接管不可行（先与现任站长完成一次对表）';
  }
  const frozen = managerFrozenOf(state, local.collabId);
  if (frozen === 'manager-fork' || frozen === 'manager-pending') {
    return `本机处于 ${frozen} 冻结——不可发起接管（等待收敛或人工裁定）`;
  }
  if (typeof state.send !== 'function') {
    return '本机未接线发送能力——接管不可行';
  }
  return null;
}

export function unexpiredAutoInFlight(state, local) {
  const runtime = m5RuntimeOf(state);
  const now = nowMs(state);
  const pending = runtime.autoPending.get(local.collabId) ?? runtime.managerPending.get(local.collabId);
  if (pending !== undefined && (pending.expiresAt === undefined || Date.parse(pending.expiresAt) > now)) {
    return true;
  }
  const offers = runtime.autoOffers.get(local.collabId);
  if (offers === undefined) {
    return false;
  }
  for (const offer of offers.values()) {
    if (Date.parse(offer.expiresAt) > now && offer.baseTerm >= ledgerTermOf(local.snapshot?.ledger)) {
      return true;
    }
  }
  return false;
}

async function beginTakeOver(state, local, sessionId) {
  const takeoverGate = manualTakeoverGate(state, local);
  if (takeoverGate !== null) {
    return { ok: false, message: takeoverGate };
  }
  const collected = await collectHighest(state, local);
  if (collected.ok !== true) {
    return { ok: false, message: collected.message };
  }
  const highest = collected.highest;
  const localPair = adoptedPairOf(state, local);
  const localTerm = localPair.term;
  const localVersion = localPair.version;
  if (highest.term > localTerm) {
    requestSnapshotFrom(state, local, highest.seat.instanceId, 'catchup');
    return { ok: false, message: `可达成员的任期为 ${highest.term}（高于本机 ${localTerm}）——已请求快照，请采纳后再发起接管` };
  }
  if (highest.term === localTerm && highest.version > localVersion) {
    /* 同 term 版本落后同样是追赶：必须携 purpose，否则冻结态成员按 §7.1 不应答。 */
    requestSnapshotFrom(state, local, highest.seat.instanceId, 'catchup');
    return { ok: false, message: `可达成员的台账版本 ${highest.version} 高于本机——已请求快照，请采纳后再发起接管` };
  }
  const token = randomUUID();
  m5RuntimeOf(state).challenges.set(challengeKey(local.collabId, sessionId), {
    token,
    deadline: nowMs(state) + TAKE_OVER_CHALLENGE_TTL_MS,
    highest,
    sessionId,
  });
  return {
    ok: true,
    needsUserConfirmation: true,
    token,
    message: '接管需本机用户确认：确认后携同一 token 重试；窗口内接管会关闭当前 1 分钟窗口。',
  };
}

async function collectHighest(state, local) {
  const runtime = m5RuntimeOf(state);
  runtime.handshakeResponses.delete(local.collabId);
  sendHandshakeSweep(state, local);
  await waitMs(positiveMs(state.handshakeReplyTimeoutMs, HANDSHAKE_REPLY_TIMEOUT_MS));
  const responses = runtime.handshakeResponses.get(local.collabId) ?? new Map();
  const external = [...responses.values()].filter((entry) => entry.seat?.instanceId !== state.self.instanceId);
  /* 设计 §2A.7②（仅手动接管）：最高 term 的站长可达即放弃接管。窗口内接管（§2A.6）是
   * 用户纠错通道，与站长是否可达无关——同一句可达性检查不得把两条路径一起拦下。 */
  const manager = managerSeatOfLedger(state, local);
  const windowOnly = windowRemainingOf(state, local) > 0;
  if (!windowOnly && manager !== null && external.some((entry) => entry.seat?.instanceId === manager.instanceId)) {
    requestSnapshotFrom(state, local, manager.instanceId, 'catchup');
    return { ok: false, message: '现任站长经握手应答可达——放弃接管，已请求快照对表' };
  }
  /* 设计 §2A.7③：名单里还有其他成员却全部无应答 → 拒绝接管并上报，不得用本机旧台账宣告
   * term+1（会与真实更高任期分叉）。名单只剩本机与失联站长时，本机快照即最高已知 pair，
   * 允许以它为基准接管——否则「站长整机断电、只剩一名成员」的核心场景永远无法恢复。 */
  if (memberWitnessesOf(local, external).length === 0 && hasOtherMemberSeats(local, state)) {
    return {
      ok: false,
      message: '与其他可达成员对表失败（零应答）——按设计不得以本机旧台账接管；请先恢复联系或改用显式移交',
    };
  }
  const own = ownHighestOf(state, local);
  const highest = external.reduce((best, entry) => (compareHighest(best, entry) >= 0 ? best : entry), own);
  if (!Number.isInteger(highest.term)) {
    return { ok: false, message: '无法与可达成员对表（无应答）——接管不可行' };
  }
  return { ok: true, highest };
}

function hasOtherMemberSeats(local, state) {
  const ledger = local.snapshot?.ledger ?? local.ledger;
  return (ledger?.members ?? []).some((member) => member.role !== 'manager' && member.instanceId !== state.self.instanceId);
}

/* 对表见证：应答机器必须是在册的非站长成员机器——未知机器的应答不得充当「其他成员」证据。 */
function memberWitnessesOf(local, external) {
  const ledger = local.snapshot?.ledger ?? local.ledger;
  const memberInstances = new Set((ledger?.members ?? [])
    .filter((member) => member.role !== 'manager')
    .map((member) => member.instanceId));
  return external.filter((entry) => memberInstances.has(entry.seat?.instanceId));
}

function ownHighestOf(state, local) {
  const pair = adoptedPairOf(state, local);
  return {
    term: pair.term,
    version: pair.version,
    manager: managerSeatOfLedger(state, local),
    seat: { instanceId: state.self.instanceId, sessionId: presenceSignerOf(local)?.sessionId },
  };
}

function compareHighest(left, right) {
  if (left.term !== right.term) {
    return left.term - right.term;
  }
  return left.version - right.version;
}

/* 接管对表的握手目标面（设计 §2A.6②/§2A.7①）：协作名单内的在册实例 ∪ 本协作端点表已知者。
 * 星型拓扑下成员之间没有协作内端点，只有站点级 known-hosts 记录——逐目标经 endpointFor 解析
 * （端点表优先、known-hosts 兜底）才能让成员彼此对表。只查点名的实例，不遍历 known-hosts：
 * 那份清单含本站见过的无关主机，泛扫会把接管变成对它们的探测放大面。 */
function handshakeTargetsOf(state, local) {
  const targets = new Set();
  for (const entry of localRosterOf(local)) {
    if (entry.instanceId !== state.self.instanceId) {
      targets.add(entry.instanceId);
    }
  }
  for (const instanceId of local.endpoints.keys()) {
    if (instanceId !== state.self.instanceId) {
      targets.add(instanceId);
    }
  }
  return targets;
}

function sendHandshakeSweep(state, local) {
  const payload = handshakePayload(state, local, false);
  if (payload === null) {
    return;
  }
  for (const instanceId of handshakeTargetsOf(state, local)) {
    const endpoint = endpointFor(state, local, instanceId);
    if (endpoint !== undefined) {
      sendTo(state, local.collabId, instanceId, endpoint, 'notice', payload, { fromSessionId: payload.sessionId });
    }
  }
}

function waitMs(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  });
}

/* 握手应答是比 presence 更直接的达证据：现任站长机器在本轮对表中应答过，就不满足
 * 「站长不可达」前提（确认挑战有效期内也可能收到新的握手，须在生效前复查）。 */
function managerAnsweredHandshake(state, local) {
  const manager = managerSeatOfLedger(state, local);
  if (manager === null) {
    return false;
  }
  const answered = m5RuntimeOf(state).handshakeResponses.get(local.collabId)?.get(manager.instanceId);
  if (answered === undefined) {
    return false;
  }
  /* 应答会留在映射里供他处查询；只有仍在失联判定时限内的应答才算「现在可达」。 */
  if (!Number.isFinite(answered.at)) {
    return true;
  }
  return monoNow(state) - answered.at <= managerLossMs(state);
}

/* 本地已有的失联判定：冻结三态之外，探测结论（state.probes.offline）在冻结被快照受理清除后
 * 仍然有效，直到一次成功探测——否则名单刷新解除 manager-offline 会让「完全没见过站长 presence」
 * 被误判成可达。 */
function managerKnownOffline(state, local) {
  const runtime = m5RuntimeOf(state);
  return runtime.frozen.get(local.collabId) === 'manager-offline'
    || state.probes?.get?.(local.collabId)?.offline === true;
}

/* 站长可达性：本地冻结/失联超时为不可达；否则以 endpoint + presence 新鲜度为证据。 */
export function managerUnreachable(state, local) {
  const runtime = m5RuntimeOf(state);
  if (managerKnownOffline(state, local)) {
    return true;
  }
  const manager = managerSeatOfLedger(state, local);
  if (manager === null || manager.instanceId === state.self.instanceId) {
    return manager === null;
  }
  const endpoint = endpointFor(state, local, manager.instanceId);
  if (endpoint === undefined) {
    return true;
  }
  const now = monoNow(state);
  const seen = runtime.managerEvidenceAt.get(local.collabId);
  if (Number.isFinite(seen) && now - seen >= managerLossMs(state)) {
    return true;
  }
  return isReachable(runtime.presence, { collabId: local.collabId, instanceId: manager.instanceId, sessionId: manager.sessionId }, {
    hasEndpoint: true,
    now,
    timeoutMs: seatTimeoutMs(state),
    departed: runtime.departed(local.collabId, manager),
  }) !== true;
}

/* 生效前复查前提：窗口内接管不受限；手动接管要求站长仍不可达（握手应答即达证据）。 */
function takeoverPremiseRejection(state, local) {
  if (windowRemainingOf(state, local) > 0) {
    return null;
  }
  if (managerAnsweredHandshake(state, local)) {
    return '现任站长刚应答了握手（可达）——放弃接管，先对表收敛';
  }
  return managerUnreachable(state, local) ? null : '现任站长已恢复可达——放弃接管，先对表收敛';
}

/* 手动/窗口接管的生效写入（设计 §2A.6⑤/§2A.7⑤）：以最高台账为基准、移除失联站长、无新窗。 */
async function finishTakeOver(state, local, sessionId, challenge) {
  const premise = takeoverPremiseRejection(state, local);
  if (premise !== null) {
    return { ok: false, message: premise };
  }
  const base = ledgerBaseOf(local);
  if (base === null) {
    return { ok: false, message: '本机无可用台账——先向可达成员取快照' };
  }
  if (base.version < challenge.highest.version) {
    return { ok: false, message: '本机台账落后于可达成员——已请求快照，请采纳后再重试' };
  }
  const seat = local.seats?.get(sessionId);
  const row = base.ledger.members.find((member) => member.instanceId === state.self.instanceId
    && (member.sessionId === undefined || member.sessionId === sessionId));
  if (row === undefined || seat === undefined) {
    return { ok: false, message: '本机席位不在台账——请先重新入席后再接管' };
  }
  const via = viaOf(state, local);
  const authorizedAt = new Date(nowMs(state)).toISOString();
  const finalLedger = buildTakeOverLedger(state, local, base.ledger, sessionId, via, authorizedAt);
  if (finalLedger === null) {
    return { ok: false, message: '接管台账构建失败（席位形态不符）' };
  }
  promoteTakeOver(state, local, finalLedger, via, authorizedAt);
  bump(state, via === 'takeover' ? 'takeoversWindow' : 'takeoversManual');
  return { ok: true, message: `接管已生效：本机成为站长（${via}，任期 ${finalLedger.managerTerm}）` };
}

/* 手动接管前提（窗口内接管不受此限）：无在途 auto、站长不可达。 */
function manualTakeoverGate(state, local) {
  if (windowRemainingOf(state, local) > 0) {
    return null;
  }
  if (unexpiredAutoInFlight(state, local)) {
    return '存在未结束的自动移交——不得与在途 auto 竞争（等待签发或超时）';
  }
  return managerUnreachable(state, local) ? null : '现任站长仍可达——不满足接管前提（等待失联判定或使用显式移交）';
}

function viaOf(state, local) {
  return windowRemainingOf(state, local) > 0 ? 'takeover' : 'takeover-manual';
}

function windowRemainingOf(state, local) {
  /* 快照未到时以已采纳的任期状态为窗口基准（否则窗口接管会被误当成手动接管）。 */
  const window = m5RuntimeOf(state).termState?.get(local.collabId)?.managerWindow ?? local.snapshot?.ledger?.managerWindow;
  if (window === undefined) {
    return 0;
  }
  return managerWindowRemaining(window, nowMs(state), {
    sessionTakeoverWindowMs: takeoverWindowMs(state),
    baseAt: m5RuntimeOf(state).managerWindowBaseAt.get(local.collabId),
  });
}

function ledgerBaseOf(local) {
  if (local.snapshot === null || !isPlainObject(local.snapshot.ledger)) {
    return null;
  }
  return { ledger: structuredClone(local.snapshot.ledger), version: local.snapshot.version };
}

function buildTakeOverLedger(state, local, base, sessionId, via, authorizedAt) {
  const manager = managerSeatOfLedger(state, local);
  if (manager === null) {
    return null;
  }
  const ledger = structuredClone(base);
  ledger.managerTerm = ledgerTermOf(ledger) + 1;
  ledger.version = (ledger.version ?? 1) + 1;
  ledger.updatedAt = new Date().toISOString();
  /* 窗口接管只降级旧站长、保留其席位；手动接管移除失联站长席位（设计 §2A.6⑤/§2A.7⑤）。 */
  if (via === 'takeover') {
    demoteManagerRowIn(ledger, manager);
  } else {
    ledger.members = ledger.members.filter((member) => !isSameManagerRow(member, manager));
    ledger.events = appendEvent(ledger, {
      type: 'leave',
      seat: manager,
      reason: 'manager-lost',
      term: ledger.managerTerm,
      at: authorizedAt,
    });
  }
  if (!promoteSelfRowIn(ledger, state, sessionId)) {
    return null;
  }
  ledger.events = appendEvent(ledger, {
    type: 'manager-changed',
    via,
    term: ledger.managerTerm,
    version: ledger.version,
    prevManager: manager,
    manager: ledger.manager,
    authorizedAt,
  });
  return clearManagerWindow(ledger);
}

function promoteSelfRowIn(ledger, state, sessionId) {
  const selfRow = ledger.members.find((member) => member.instanceId === state.self.instanceId
    && (member.sessionId === undefined || member.sessionId === sessionId));
  if (selfRow === undefined) {
    return false;
  }
  selfRow.role = 'manager';
  selfRow.sessionId = sessionId;
  selfRow.identityName = state.self.identityName;
  selfRow.state = 'member';
  ledger.manager = { instanceId: state.self.instanceId, sessionId, identityName: state.self.identityName, term: ledger.managerTerm };
  return true;
}

function demoteManagerRowIn(ledger, manager) {
  const row = ledger.members.find((member) => isSameManagerRow(member, manager));
  if (row !== undefined) {
    row.role = 'member';
    row.state = 'member';
  }
}

function isSameManagerRow(member, manager) {
  return member.role === 'manager'
    && member.instanceId === manager.instanceId
    && (member.sessionId === undefined || member.sessionId === manager.sessionId);
}

function promoteTakeOver(state, local, ledger, via, authorizedAt) {
  const prevManager = managerSeatOfLedger(state, local);
  /* 变更必须先于快照入队（设计 §2A.6⑤）：promoteToManager 会给全体成员推新任期快照，
   * 新站长若在成员收到 manager-changed 之前先收到该快照，A10 会把「无授权证据的更高 term
   * 快照」拒收并冻结 manager-fork——窗口内接管因此永远收敛不了。 */
  const payload = managerChangedPayloadOf(state, ledger, via, authorizedAt, prevManager);
  broadcastManagerChanged(state, local, payload, { sessionId: ledger.manager.sessionId }, prevManager);
  promoteToManager(state, local, ledger);
  clearManagerFreeze(state, local.collabId);
  const signer = managerSeatOfLedger(state, local);
  rememberPendingChange(state, local.collabId, { payload, prevManager, fromSessionId: signer?.sessionId });
  m5RuntimeOf(state).acceptedManagers.set(local.collabId, {
    term: ledger.managerTerm,
    manager: ledger.manager,
    source: { instanceId: state.self.instanceId, sessionId: signer?.sessionId },
  });
  m5RuntimeOf(state).managerWindowBaseAt.delete(local.collabId);
}

function managerChangedPayloadOf(state, ledger, via, authorizedAt, prevManager) {
  const manager = ledger.manager;
  return {
    event: 'manager-changed',
    manager: { instanceId: manager.instanceId, sessionId: manager.sessionId, identityName: manager.identityName },
    term: ledger.managerTerm,
    version: ledger.version,
    via,
    prevManager: prevManager === null ? manager : { instanceId: prevManager.instanceId, sessionId: prevManager.sessionId },
    effectiveAt: authorizedAt,
    ...(via === 'takeover' ? { windowBaseTerm: ledger.managerTerm - 1, authorizedAt } : { authorizedAt }),
    endpoint: selfEndpointOf(state),
    digest: ledgerDigest(ledger),
  };
}

/* 自报端点：服务/工具层可在 state.selfEndpoint 注入真实对外地址；缺省用回环地址（同机测试/手动接管兜底）。 */
function selfEndpointOf(state) {
  if (isPlainObject(state.selfEndpoint) && typeof state.selfEndpoint.address === 'string') {
    return { address: state.selfEndpoint.address, port: state.selfEndpoint.port ?? state.self.port };
  }
  if (typeof state.self?.address === 'string' && state.self.address !== '') {
    return { address: state.self.address, port: state.self.port };
  }
  return { address: '127.0.0.1', port: state.self.port };
}

function broadcastManagerChanged(state, local, payload, signer, prevManager) {
  for (const member of managerChangeTargetsOf(local, prevManager).values()) {
    if (member.instanceId === state.self.instanceId) {
      continue;
    }
    const endpoint = endpointFor(state, local, member.instanceId);
    if (endpoint === undefined) {
      continue;
    }
    sendTo(state, local.collabId, member.instanceId, endpoint, 'notice', payload, {
      fromSessionId: signer?.sessionId,
      ...recipientOptionsOf(member),
    });
  }
}

/* 变更先于提升发送：成员核此时还没有本地台账，名册取最近快照（含旧站长与其余成员）。 */
function managerChangeTargetsOf(local, prevManager) {
  const roster = local.ledger?.members ?? local.snapshot?.ledger?.members ?? [];
  const targets = new Map(roster.map((member) => [member.instanceId, member]));
  if (isPlainObject(prevManager) && !targets.has(prevManager.instanceId)) {
    targets.set(prevManager.instanceId, prevManager);
  }
  return targets;
}

function recipientOptionsOf(entry) {
  return entry.sessionId === undefined ? {} : { toSessions: [entry.sessionId] };
}

/* 兼容观测帧（takeover-init）：v4 不再由它产生任期变更，仅保留接收/转达以免旧对端重试被钉死。 */
export async function handleTakeoverInit(state, frame) {
  const local = state.collabs.get(frame.collabId);
  if (local === undefined || frame.from.instanceId === state.self.instanceId) {
    return;
  }
  bump(state, 'takeoversIn');
  if (frame.payload.kind === 'cancel' && local.suspended !== null && local.suspended.reason === 'takeover-inflight') {
    resumeLocal(state, local, '在途抢接中止');
  }
  relayTakeoverFrame(state, local, frame);
}

function relayTakeoverFrame(state, local, frame) {
  state.counters.takeoversRelayed = (state.counters.takeoversRelayed ?? 0) + relayGovernance(state, frame, governanceTargets(state, local));
}

export async function handleTakeover(state, frame) {
  const local = state.collabs.get(frame.collabId);
  if (local === undefined || frame.from.instanceId === state.self.instanceId) {
    return;
  }
  bump(state, 'takeoverFramesIn');
  relayTakeoverFrame(state, local, frame);
}

export function presenceSnapshot(state, collabId) {
  const result = {};
  for (const entry of m5RuntimeOf(state).presence.values()) {
    if (entry.collabId === collabId) {
      result[seatKey(collabId, entry.instanceId, entry.sessionId)] = {
        lastSeenAt: entry.lastSeenAt,
        lastPresenceListAt: entry.lastPresenceListAt,
      };
    }
  }
  return result;
}
