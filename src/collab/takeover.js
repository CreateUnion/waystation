import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendLine, writeJsonAtomic } from '../storage.js';
import { autoOfferFilePath, collabDir, departedFilePath, ensureDir, managerPendingFilePath } from '../paths.js';
import { newMsgId } from '../net/protocol.js';
import { isArchived } from './model.js';
import {
  currentManagerIdOf, isLocalArchivedState, localModeOf, localRosterOf, localStateOf, localVersionOf, persistMember, removeLocalSeat,
} from './local.js';
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
const HANDSHAKE_RESEND_LIMIT = 20;

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

/* 接线期运行时容器（惰性挂载在服务 state 上；M2 的 state 构造不感知本模块）。 */
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

/* —— 台账任期面归一（兼容 M2 尚未迁移的旧台账；不改写数据面） —— */

export function ledgerTermOf(ledger) {
  return Number.isInteger(ledger?.managerTerm) && ledger.managerTerm >= 1 ? ledger.managerTerm : 1;
}

export function managerSeatOfLedger(state, local) {
  const raw = managerRawOf(local);
  if (!isManagerRaw(raw)) {
    return null;
  }
  return managerSeatWithSession(state, local, raw);
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

/* —— 离席留痕与冻结原因持久化（设计 §6/§6.2；M2 启动/装配处调用） —— */

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

/* 冻结原因落载体（M7 只读展示面）；展示字段不改台账形态，故不写台账行。
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

/* 解除冻结/恢复/接管成功时清除冻结原因（载体与成员记录两侧；台账字段由 M7 读侧兜底）。 */
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
  for (const local of state.collabs.values()) {
    if (local.suspended === null || local.suspended.deadline === null) {
      continue;
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
  runtime.presenceTimer = setInterval(() => {
    runPresenceTick(state);
  }, positiveMs(state.config.seatPresenceIntervalMs, DEFAULT_PRESENCE_INTERVAL_MS));
  if (typeof runtime.presenceTimer.unref === 'function') {
    runtime.presenceTimer.unref();
  }
}

export function stopPresenceTicker(state) {
  const runtime = m5RuntimeOf(state);
  if (runtime.presenceTimer !== null) {
    clearInterval(runtime.presenceTimer);
    runtime.presenceTimer = null;
  }
  for (const timer of runtime.autoAcceptTimers.values()) {
    clearTimeout(timer);
  }
  runtime.autoAcceptTimers.clear();
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
  const now = nowMs(state);
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

function managerLossMs(state) {
  return positiveMs(state.config.managerLossTimeoutMs ?? state.config.managerOfflineMs, DEFAULT_MANAGER_LOSS_MS);
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
    const now = nowMs(state);
    sendPresenceSweep(state, now);
    sweepPresenceExpiry(state, monoNow(state));
    sweepSeatGrace(state, now);
    checkManagerLoss(state, now);
    resendPendingChanges(state, now);
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
    const sent = sendTo(state, local.collabId, instanceId, endpoint, 'seat-presence', payload, { fromSessionId: signer.sessionId });
    if (sent.ok === true) {
      bump(state, 'presenceSent');
    }
  }
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
  const peer = transportPeerOf(state, local, meta);
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
}

/* 直连协作帧刷新（转达副本不刷新由 presence 表判定）；只刷新该帧的发送席位。 */
export function noteDirectFramePresence(state, frame, meta) {
  const local = state.collabs.get(frame.collabId);
  if (local === undefined || frame.type === 'seat-presence') {
    return;
  }
  const peer = transportPeerOf(state, local, meta);
  const now = monoNow(state);
  const result = applyDirectFrame(m5RuntimeOf(state).presence, frame, now, { peerInstanceId: peer });
  if (result.refreshed === true) {
    bump(state, 'presenceDirectRefreshed');
  }
  noteManagerEvidence(state, local, frame.from?.instanceId, now);
}

/* 传输对端实例：优先注入的 meta.peerInstanceId（M3 后续提供）；否则按已知端点地址反查。
 * 查不到即 null——presence 侧按 fail-closed 拒收（不拿帧内 from 自证）。 */
function transportPeerOf(state, local, meta) {
  if (typeof meta?.peerInstanceId === 'string' && meta.peerInstanceId !== '') {
    return meta.peerInstanceId;
  }
  const address = typeof meta?.remoteAddress === 'string' ? meta.remoteAddress : '';
  if (address === '') {
    return null;
  }
  for (const [instanceId, endpoint] of local.endpoints) {
    if (instanceId !== state.self.instanceId && endpoint.address === address) {
      return instanceId;
    }
  }
  return null;
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
    bump(state, 'seatsRemovedRemote');
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

/* 进程刚启动/从未收到站长直连帧：以启动时刻起算，避免重启即冻结。 */
function lastManagerEvidence(state, local, now) {
  const runtime = m5RuntimeOf(state);
  const seen = runtime.managerEvidenceAt.get(local.collabId);
  if (Number.isFinite(seen) && seen > 0) {
    return seen;
  }
  runtime.managerEvidenceAt.set(local.collabId, now);
  return now;
}

/* —— 会话宽限与离席（M2 在桥注销时调用 noteSeatClosed） —— */

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
    if (now - record.closedAt < seatGraceMs(state)) {
      continue;
    }
    runtime.closedSeats.delete(key);
    closeSeatAfterGrace(state, state.collabs.get(key.split('\u0000')[0]), record.sessionId, now);
  }
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
  removeLocalSeat(local, seat.sessionId, { persist: true, dataDir: state.dataDir });
  /* 台账仍在本机时角色以台账为准：席位缓存退出不得让本机提前变成员，
   * 否则自动移交与签发路径会读不到本地台账（席位态只是缓存）。 */
  local.role = 'manager';
  appendDeparted(state, local.collabId, {
    instanceId: state.self.instanceId,
    sessionId: seat.sessionId,
    reason: 'manager-session-closed',
    term: ledgerTermOf(local.ledger),
    at: new Date(now).toISOString(),
  });
  const others = local.ledger.members.filter((member) => member.role !== 'manager');
  if (others.length === 0) {
    completeTerminalCollab(state, local);
    return;
  }
  autoTransfer(state, { collabId: local.collabId, managerSessionId: seat.sessionId });
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
  local.mute?.clear?.();
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
    now: nowMs(state),
    timeoutMs: seatTimeoutMs(state),
    hasEndpoint: (seat) => endpointFor(state, local, seat.instanceId) !== undefined,
    departed: (seat) => runtime.departed(local.collabId, seat),
  }).filter((seat) => excluded === null || !sameSeat(seat, excluded));
}

function dispatchAutoOffer(state, local, prevManager, target) {
  const runtime = m5RuntimeOf(state);
  const endpoint = endpointFor(state, local, target.instanceId);
  if (endpoint === undefined) {
    return { ok: false, reason: 'target-unreachable' };
  }
  const ledger = structuredClone(local.ledger);
  const offerId = randomUUID();
  const now = nowMs(state);
  const expiresAt = new Date(now + handoverConfirmMs(state)).toISOString();
  const offer = {
    offerId,
    prevManager,
    target: { instanceId: target.instanceId, sessionId: target.sessionId ?? '' },
    baseTerm: ledgerTermOf(ledger),
    version: ledger.version,
    digest: ledgerDigest(ledger),
    ledger,
    expiresAt,
    expiresAtMs: Date.parse(expiresAt),
  };
  runtime.autoPending.set(local.collabId, offer);
  broadcastAutoOffer(state, local, offer);
  persistAutoOffer(state, local, offer);
  sendAutoOfferFrame(state, local, offer, target, endpoint);
  suspendLocal(state, local, 'handover-pending', offer.expiresAtMs + positiveMs(state.config.dialTimeoutMs, DEFAULT_DIAL_MS));
  armAutoAcceptDeadline(state, local, offer);
  bump(state, 'autoOffersSent');
  return { ok: true, offerId, expiresAt, target, message: '自动移交提议已发出，等待目标接受' };
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
    ensureDir(collabDir(state.dataDir, local.collabId));
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
  const wait = Math.min(positiveMs(state.config.dialTimeoutMs, DEFAULT_DIAL_MS), Math.max(0, offer.expiresAtMs - nowMs(state)));
  const timer = setTimeout(() => {
    runtime.autoAcceptTimers.delete(local.collabId);
    onAutoAcceptTimeout(state, local);
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
  resumeLocal(state, local, 'auto-accept-timeout');
  runtime.autoOffers.get(local.collabId)?.delete?.(pending.offerId);
  retryAutoTransfer(state, local, pending.target);
}

function retryAutoTransfer(state, local, failedTarget) {
  const prevManager = managerSeatOfLedger(state, local);
  if (prevManager === null) {
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
    ensureDir(collabDir(state.dataDir, local.collabId));
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

/* —— D15 重发：站长变更未 ack 前按 presence 节律重发（定向 prevManager + 已端点成员）。 —— */

export function rememberPendingChange(state, collabId, entry) {
  m5RuntimeOf(state).resends.set(collabId, { ...entry, sentAt: nowMs(state), attempts: 1 });
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
    entry.sentAt = now;
    entry.attempts++;
    resendManagerChanged(state, local, entry);
    if (entry.attempts > HANDSHAKE_RESEND_LIMIT) {
      runtime.resends.delete(collabId);
    }
  }
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
    armHandshakeWatch(state, local, sent > 0);
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

function handshakePayload(state, local, reply) {
  const manager = managerSeatOfLedger(state, local);
  const version = localVersionOf(local);
  if (version === null) {
    return null;
  }
  const signer = presenceSignerOf(local);
  return {
    event: 'handshake',
    role: local.role,
    managerTerm: ledgerTermOf(local.ledger ?? local.snapshot?.ledger),
    version,
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
  });
  m5RuntimeOf(state).handshakeResponses.set(local.collabId, responses);
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
    requestSnapshotFrom(state, local, frame.from.instanceId);
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

/** @param {string|null} [purpose] */
export function requestSnapshotFrom(state, local, instanceId, purpose = null) {
  const endpoint = endpointFor(state, local, instanceId);
  if (endpoint === undefined) {
    return false;
  }
  const payload = {
    kind: 'request',
    managerTerm: ledgerTermOf(local.ledger ?? local.snapshot?.ledger),
    version: localVersionOf(local) ?? 1,
    ...(purpose === null ? {} : { purpose }),
  };
  const signer = presenceSignerOf(local);
  return sendTo(state, local.collabId, instanceId, endpoint, 'snapshot', payload, { fromSessionId: signer?.sessionId }).ok === true;
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

function unexpiredAutoInFlight(state, local) {
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
  const localTerm = ledgerTermOf(local.snapshot?.ledger);
  const localVersion = localVersionOf(local) ?? 0;
  if (highest.term > localTerm) {
    requestSnapshotFrom(state, local, highest.seat.instanceId, 'catchup');
    return { ok: false, message: `可达成员的任期为 ${highest.term}（高于本机 ${localTerm}）——已请求快照，请采纳后再发起接管` };
  }
  if (highest.term === localTerm && highest.version > localVersion) {
    requestSnapshotFrom(state, local, highest.seat.instanceId);
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
  const own = ownHighestOf(state, local);
  const highest = [...responses.values()].reduce((best, entry) => (compareHighest(best, entry) >= 0 ? best : entry), own);
  if (!Number.isInteger(highest.term)) {
    return { ok: false, message: '无法与可达成员对表（无应答）——接管不可行' };
  }
  return { ok: true, highest };
}

function ownHighestOf(state, local) {
  return {
    term: ledgerTermOf(local.snapshot?.ledger),
    version: localVersionOf(local) ?? 0,
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

function sendHandshakeSweep(state, local) {
  const payload = handshakePayload(state, local, false);
  if (payload === null) {
    return;
  }
  for (const [instanceId, endpoint] of local.endpoints) {
    if (instanceId !== state.self.instanceId) {
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

/* 站长可达性：本地冻结/失联超时为不可达；否则以 endpoint + presence 新鲜度为证据。 */
export function managerUnreachable(state, local) {
  const runtime = m5RuntimeOf(state);
  if (runtime.frozen.get(local.collabId) === 'manager-offline') {
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
  const now = nowMs(state);
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

/* 手动/窗口接管的生效写入（设计 §2A.6⑤/§2A.7⑤）：以最高台账为基准、移除失联站长、无新窗。 */
async function finishTakeOver(state, local, sessionId, challenge) {
  const windowOnly = windowRemainingOf(state, local) > 0;
  if (!windowOnly && !managerUnreachable(state, local)) {
    return { ok: false, message: '现任站长已恢复可达——放弃接管，先对表收敛' };
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
  const window = local.snapshot?.ledger?.managerWindow;
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
  ledger.members = ledger.members.filter((member) => !isSameManagerRow(member, manager));
  const selfRow = ledger.members.find((member) => member.instanceId === state.self.instanceId
    && (member.sessionId === undefined || member.sessionId === sessionId));
  if (selfRow === undefined) {
    return null;
  }
  selfRow.role = 'manager';
  selfRow.sessionId = sessionId;
  selfRow.identityName = state.self.identityName;
  selfRow.state = 'member';
  ledger.manager = { instanceId: state.self.instanceId, sessionId, identityName: state.self.identityName, term: ledger.managerTerm };
  ledger.events = appendEvent(ledger, {
    type: 'leave',
    seat: manager,
    reason: via === 'takeover' ? 'takeover' : 'manager-lost',
    term: ledger.managerTerm,
    at: authorizedAt,
  });
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

function isSameManagerRow(member, manager) {
  return member.role === 'manager'
    && member.instanceId === manager.instanceId
    && (member.sessionId === undefined || member.sessionId === manager.sessionId);
}

function promoteTakeOver(state, local, ledger, via, authorizedAt) {
  const prevManager = managerSeatOfLedger(state, local);
  promoteToManager(state, local, ledger);
  clearManagerFreeze(state, local.collabId);
  const signer = managerSeatOfLedger(state, local);
  const payload = managerChangedPayloadOf(state, ledger, via, authorizedAt, prevManager);
  broadcastManagerChanged(state, local, payload, signer, prevManager);
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

/* 自报端点：M2/M6 可在 state.selfEndpoint 注入真实对外地址；缺省用回环地址（同机测试/手动接管兜底）。 */
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
  const targets = new Map((local.ledger?.members ?? []).map((member) => [member.instanceId, member]));
  if (isPlainObject(prevManager) && !targets.has(prevManager.instanceId)) {
    targets.set(prevManager.instanceId, prevManager);
  }
  for (const member of targets.values()) {
    if (member.instanceId === state.self.instanceId) {
      continue;
    }
    const endpoint = endpointFor(state, local, member.instanceId);
    if (endpoint === undefined) {
      continue;
    }
    sendTo(state, local.collabId, member.instanceId, endpoint, 'notice', payload, {
      fromSessionId: signer?.sessionId,
      ...(member.sessionId === undefined ? {} : { toSessions: [member.sessionId] }),
    });
  }
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
