import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { writeJsonAtomic } from '../storage.js';
import { collabDir, ensureDir, handoverOffersFilePath, handoverPendingFilePath } from '../paths.js';
import { isPort } from '../net/protocol.js';
import { isLedgerShape } from './model.js';
import { currentManagerIdOf, isLocalArchivedState, localRosterOf, localStateOf, persistSnapshot } from './local.js';
import { ledgerDigest } from './store.js';
import { applyEndpoint, downgradeToMember, endpointFor, notifyLocal, promoteToManager, sendTo, sendToSeats } from './outgoing.js';
import { probePeer } from './takeover.js';
import {
  clearManagerFreeze, ledgerTermOf, localSeatsOf, m5RuntimeOf, managerSeatOfLedger, markManagerPending, presenceSignerOf, rememberPendingChange,
} from './takeover.js';

/* 显式移交（设计 §2A.4）与自动接受（§2A.5 目标侧）：
 * - 显式：offer 只记录不提升；目标用户确认（一次性令牌）后回 accept；旧站长收到 accept 后原子写
 *   manager-changed 并降级；迟到 accept 一律拒绝。
 * - 自动：目标核收到匹配 auto-offer 的 offer 后自动接受、以自己名义签发 via=auto 并开 1 分钟窗口。 */

const DEFAULT_HANDOVER_CONFIRM_MS = 120000;
const DEFAULT_WINDOW_MS = 60000;
const CHALLENGE_TTL_MS = 120000;
const OFFER_STATE_OPEN = 'open';
const OFFER_STATE_ACCEPTED = 'accepted';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bump(state, key) {
  state.counters[key] = (state.counters[key] ?? 0) + 1;
}

function nowMs(state) {
  return typeof state.clock === 'function' ? state.clock() : Date.now();
}

function handoverConfirmMs(state) {
  return positiveMs(state.config?.handoverConfirmTimeoutMs ?? state.handoverConfirmTimeoutMs, DEFAULT_HANDOVER_CONFIRM_MS);
}

function positiveMs(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function windowMs(state) {
  return positiveMs(state.config?.sessionTakeoverWindowMs, DEFAULT_WINDOW_MS);
}

function sameSeat(left, right) {
  return isPlainObject(left) && isPlainObject(right)
    && left.instanceId === right.instanceId
    && left.sessionId === right.sessionId;
}

/* —— 显式移交发起（旧站长侧） —— */

/** @param {any} input */
export async function handover(state, input = {}) {
  const { collabId, target, targetSessionId, sessionId } = input;
  const local = state.collabs.get(collabId);
  if (local === undefined) {
    return { ok: false, message: '本机没有该协作（先 ws_list_collabs）' };
  }
  const rejection = handoverRejection(state, local, target);
  if (rejection !== null) {
    return { ok: false, message: rejection };
  }
  const targetSeat = resolveTargetSeat(state, local, target, targetSessionId);
  if (targetSeat === null) {
    return { ok: false, message: '目标席位无法确定（需活跃成员；同机多席请给 targetSessionId）' };
  }
  const endpointRejection = await targetReachabilityRejection(state, local, targetSeat);
  if (endpointRejection !== null) {
    return { ok: false, message: endpointRejection };
  }
  const manager = managerSeatOfLedger(state, local);
  const signerSessionId = manager?.sessionId ?? sessionId;
  const offer = buildOffer(state, local, targetSeat);
  storePendingHandover(state, local, offer, { auto: false });
  const sent = await sendToSeats(state, {
    collabId,
    fromSessionId: signerSessionId,
    type: 'handover',
    payload: offerPayloadOf(state, local, offer),
    targets: [{ instanceId: targetSeat.instanceId, sessionId: targetSeat.sessionId }],
  });
  if (sent.ok !== true) {
    clearPendingHandover(state, local);
    return { ok: false, message: `移交提议入队失败：${sent.reason ?? '未知原因'}` };
  }
  return {
    ok: true,
    offerId: offer.offerId,
    expiresAt: offer.expiresAt,
    message: `已发出移交提议，等待目标确认（offerId ${offer.offerId}，${handoverConfirmMs(state) / 1000}s 内有效）`,
  };
}

function handoverRejection(state, local, target) {
  if (local.role !== 'manager') {
    return '只有站长席位可以移交';
  }
  if (local.suspended !== null) {
    return '协作对外写已暂停（收敛等待中）——暂不可移交';
  }
  if (local.ledger.status !== 'active') {
    return '移交要求协作处于进行中（提议中可直接撤回；冻结中先裁定）';
  }
  if (typeof target !== 'string' || target.trim() === '') {
    return 'target 非法：需要成员的实例标识（取自 ws_view_ledger 的名单）';
  }
  return null;
}

function resolveTargetSeat(state, local, targetId, targetSessionId) {
  const rows = local.ledger.members.filter((member) => member.instanceId === targetId && member.role !== 'manager');
  if (typeof targetSessionId === 'string' && targetSessionId !== '') {
    return rows.find((member) => member.sessionId === targetSessionId) ?? null;
  }
  return rows.length === 1 ? rows[0] : null;
}

async function targetReachabilityRejection(state, local, targetSeat) {
  if (targetSeat.instanceId === state.self.instanceId) {
    return targetSeat.sessionId === undefined ? '目标会话未知（同机移交需要 targetSessionId）' : null;
  }
  const endpoint = endpointFor(state, local, targetSeat.instanceId);
  if (endpoint === undefined) {
    return '目标端点未知——请先扫描或等对方联系后再移交';
  }
  if (typeof state.probe !== 'function') {
    return null;
  }
  const result = await probePeer(state, endpoint);
  if (result.reachable !== true) {
    bump(state, 'handoverRejected');
    return '目标离线——交接要求目标在线（应急：用 ws_take_over 走抢接）';
  }
  return null;
}

function buildOffer(state, local, targetSeat) {
  const ledger = ensureTermFields(structuredClone(local.ledger));
  const now = nowMs(state);
  return {
    offerId: randomUUID(),
    baseTerm: ledgerTermOf(ledger),
    version: ledger.version,
    digest: ledgerDigest(ledger),
    ledger,
    endpoints: Object.fromEntries(local.endpoints),
    expiresAt: new Date(now + handoverConfirmMs(state)).toISOString(),
    expiresAtMs: now + handoverConfirmMs(state),
    target: { instanceId: targetSeat.instanceId, sessionId: targetSeat.sessionId, identityName: targetSeat.identityName },
    from: managerSeatOfLedger(state, local),
  };
}

/* 旧台账（M2 未迁移）缺 managerTerm/joinSeqNext 时补齐只读字段：offer 台账是接收侧的基准副本。 */
function ensureTermFields(ledger) {
  if (!Number.isInteger(ledger.managerTerm)) {
    ledger.managerTerm = 1;
  }
  if (!Number.isInteger(ledger.joinSeqNext)) {
    ledger.joinSeqNext = Math.max(2, ...ledger.members.map((member) => (Number.isInteger(member.joinSeq) ? member.joinSeq + 1 : 2)));
  }
  if (isPlainObject(ledger.manager) && ledger.manager.term === undefined) {
    ledger.manager.term = ledger.managerTerm;
  }
  return ledger;
}

function offerPayloadOf(state, local, offer) {
  return {
    kind: 'offer',
    offerId: offer.offerId,
    baseTerm: offer.baseTerm,
    version: offer.version,
    digest: offer.digest,
    ledger: offer.ledger,
    endpoints: offer.endpoints,
    expiresAt: offer.expiresAt,
    ...(offer.auto === true ? { auto: true } : {}),
  };
}

function storePendingHandover(state, local, offer, { auto }) {
  const runtime = m5RuntimeOf(state);
  const pending = { ...offer, auto };
  runtime.pendingHandovers.set(local.collabId, pending);
  runtime.handoverTargets.set(local.collabId, offer.target);
  suspendForHandover(state, local, offer.expiresAtMs);
  persistPendingHandover(state, local, pending);
  armHandoverExpiry(state, local, pending);
  bump(state, 'handoverOffered');
}

function suspendForHandover(state, local, expiresAtMs) {
  if (local.suspended !== null) {
    return;
  }
  local.suspended = { reason: 'handover-pending', since: new Date().toISOString(), deadline: expiresAtMs + positiveMs(state.config?.dialTimeoutMs, 5000) };
  bump(state, 'suspensions');
}

function persistPendingHandover(state, local, pending) {
  try {
    ensureDir(collabDir(state.dataDir, local.collabId));
    writeJsonAtomic(handoverPendingFilePath(state.dataDir, local.collabId), {
      offerId: pending.offerId,
      collabId: local.collabId,
      target: pending.target,
      baseTerm: pending.baseTerm,
      version: pending.version,
      digest: pending.digest,
      expiresAt: pending.expiresAt,
    });
  } catch (error) {
    bump(state, 'handoverPersistFailures');
    state.log.warn('移交在途记录写入失败（已忽略）', { collabId: local.collabId, reason: error.message });
  }
}

function armHandoverExpiry(state, local, pending) {
  const runtime = m5RuntimeOf(state);
  const prior = runtime.handoverTargets.get(`${local.collabId}\u0000timer`);
  if (prior !== undefined) {
    clearTimeout(prior);
  }
  const timer = setTimeout(() => {
    runtime.handoverTargets.delete(`${local.collabId}\u0000timer`);
    onHandoverExpired(state, local, pending.offerId);
  }, Math.max(0, pending.expiresAtMs - nowMs(state)));
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  runtime.handoverTargets.set(`${local.collabId}\u0000timer`, timer);
}

function onHandoverExpired(state, local, offerId) {
  const runtime = m5RuntimeOf(state);
  const pending = runtime.pendingHandovers.get(local.collabId);
  if (pending === undefined || pending.offerId !== offerId || runtime.managerPending.has(local.collabId)) {
    return;
  }
  clearPendingHandover(state, local);
  bump(state, 'handoverTimeouts');
  notifyLocal(state, local, '移交提议在时限内未被确认——本次移交作废，可重新发起。');
}

function clearPendingHandover(state, local) {
  const runtime = m5RuntimeOf(state);
  runtime.pendingHandovers.delete(local.collabId);
  runtime.handoverTargets.delete(local.collabId);
  const timer = runtime.handoverTargets.get(`${local.collabId}\u0000timer`);
  if (timer !== undefined) {
    clearTimeout(timer);
    runtime.handoverTargets.delete(`${local.collabId}\u0000timer`);
  }
  rmPendingFile(state, local);
  resumeAfterHandover(state, local);
}

function resumeAfterHandover(state, local) {
  if (local.suspended !== null && local.suspended.reason === 'handover-pending') {
    local.suspended = null;
    bump(state, 'resumptions');
  }
}

function rmPendingFile(state, local) {
  try {
    rmSync(handoverPendingFilePath(state.dataDir, local.collabId), { force: true });
  } catch {
    // 删除失败不影响内存收口：重启后按过期作废
  }
}

/* —— 移交报文接收 —— */

export async function handleHandover(state, frame) {
  const local = state.collabs.get(frame.collabId);
  if (local === undefined) {
    return;
  }
  const payload = frame.payload;
  if (payload.kind === 'offer') {
    handleOffer(state, local, frame);
    return;
  }
  if (payload.kind === 'accept') {
    handleAccept(state, local, frame);
    return;
  }
  if (payload.kind === 'reject') {
    handleReject(state, local, frame);
  }
}

/* 目标侧：只校验并记录，绝不自行提升（设计 §2A.4 目标侧①）。 */
function handleOffer(state, local, frame) {
  const rejection = offerRejection(state, local, frame);
  if (rejection !== null) {
    sendHandoverReject(state, local, frame, rejection);
    return;
  }
  const record = offerRecordOf(frame);
  const stored = storeOfferRecord(state, local, record);
  if (stored === null) {
    sendHandoverReject(state, local, frame, 'version-changed');
    return;
  }
  const autoOffer = matchingAutoOffer(state, local, record.offerId);
  if (autoOffer !== null) {
    autoAcceptOffer(state, local, record, autoOffer);
    return;
  }
  notifyLocal(state, local, `收到站长移交提议（offerId ${record.offerId}）：如接受，请用 ws_handover 携 offerId 确认（先签发挑战令牌）。`);
}

function offerRejection(state, local, frame) {
  if (local.role === 'manager') {
    return '本机已是站长';
  }
  if (isLocalArchivedState(local)) {
    return '本机该协作已归档';
  }
  if (frame.from.instanceId !== currentManagerIdOf(local)) {
    return 'manager-changed';
  }
  if (localStateOf(local) === 'frozen' || m5RuntimeOf(state).frozen.get(local.collabId) === 'manager-fork') {
    return 'rejected';
  }
  const payload = frame.payload;
  if (ledgerTermOf(payload.ledger) !== payload.baseTerm) {
    return 'version-changed';
  }
  if (payload.expiresAt === undefined || Date.parse(payload.expiresAt) <= nowMs(state)) {
    return 'expired';
  }
  if (!offerSelfConsistent(payload)) {
    return 'version-changed';
  }
  return null;
}

function offerSelfConsistent(payload) {
  const ledger = payload.ledger;
  if (!isPlainObject(ledger) || !Number.isInteger(ledger.version) || ledger.version !== payload.version) {
    return false;
  }
  if (typeof payload.digest !== 'string' || ledgerDigest(ledger) !== payload.digest) {
    return false;
  }
  return isPlainObject(payload.endpoints) && Object.values(payload.endpoints).every((endpoint) => isEndpointShape(endpoint));
}

function isEndpointShape(endpoint) {
  return isPlainObject(endpoint) && typeof endpoint.address === 'string' && endpoint.address !== '' && isPort(endpoint.port);
}

function offerRecordOf(frame) {
  const payload = frame.payload;
  return {
    offerId: payload.offerId,
    baseTerm: payload.baseTerm,
    version: payload.version,
    digest: payload.digest,
    ledger: payload.ledger,
    endpoints: payload.endpoints,
    expiresAt: payload.expiresAt,
    expiresAtMs: Date.parse(payload.expiresAt),
    from: { instanceId: frame.from.instanceId, sessionId: frame.from.sessionId, identityName: frame.from.identityName },
    state: OFFER_STATE_OPEN,
  };
}

function storeOfferRecord(state, local, record) {
  if (!isOfferLedgerAdoptable(local, record.ledger)) {
    return null;
  }
  const runtime = m5RuntimeOf(state);
  const offers = runtime.handoverOffers.get(local.collabId) ?? new Map();
  offers.set(record.offerId, record);
  runtime.handoverOffers.set(local.collabId, offers);
  learnOfferedEndpoints(state, local, record);
  persistOfferRecords(state, local);
  bump(state, 'handoverOffersStored');
  return record;
}

/* 目标侧接受基准：本机无台账时 offer 台账即基准；本地台账 term 更高则不采纳。 */
function isOfferLedgerAdoptable(local, ledger) {
  if (!isLedgerShape(ledger)) {
    return false;
  }
  if (local.snapshot === null) {
    return true;
  }
  return ledgerTermOf(ledger) >= ledgerTermOf(local.snapshot.ledger);
}

function learnOfferedEndpoints(state, local, record) {
  const names = new Map(localRosterOf(local).map((entry) => [entry.instanceId, entry.identityName]));
  for (const [instanceId, endpoint] of Object.entries(record.endpoints)) {
    if (!isEndpointShape(endpoint)) {
      continue;
    }
    applyEndpoint(state, local, { instanceId, identityName: names.get(instanceId) ?? '' }, endpoint.address, endpoint.port);
  }
}

function persistOfferRecords(state, local) {
  const offers = [...(m5RuntimeOf(state).handoverOffers.get(local.collabId)?.values() ?? [])]
    .map((record) => ({
      offerId: record.offerId,
      collabId: local.collabId,
      baseTerm: record.baseTerm,
      version: record.version,
      digest: record.digest,
      ledger: record.ledger,
      endpoints: record.endpoints,
      from: record.from,
      expiresAt: record.expiresAt,
      state: record.state,
    }));
  try {
    ensureDir(collabDir(state.dataDir, local.collabId));
    writeJsonAtomic(handoverOffersFilePath(state.dataDir, local.collabId), { version: 1, offers });
  } catch (error) {
    bump(state, 'handoverPersistFailures');
    state.log.warn('移交提议记录写入失败（已忽略）', { collabId: local.collabId, reason: error.message });
  }
}

function sendHandoverReject(state, local, frame, reason) {
  const endpoint = endpointFor(state, local, frame.from.instanceId);
  if (endpoint === undefined) {
    return;
  }
  sendTo(state, local.collabId, frame.from.instanceId, endpoint, 'handover', {
    kind: 'reject',
    offerId: frame.payload.offerId,
    reason,
  }, { fromSessionId: localSignerSessionOf(state, local) });
}

function localSignerSessionOf(state, local) {
  return presenceSignerOf(local)?.sessionId;
}

/* 目标确认（设计 §9 一次性挑战令牌）：首调只签发挑战，携令牌重试才回 accept。 */
/** @param {any} input */
export function confirmHandover(state, input = {}) {
  const { collabId, sessionId, offerId, token } = input;
  const local = state.collabs.get(collabId);
  if (local === undefined) {
    return { ok: false, message: '本机没有该协作' };
  }
  const record = m5RuntimeOf(state).handoverOffers.get(collabId)?.get(offerId);
  const rejection = confirmRejection(state, local, record, sessionId);
  if (rejection !== null) {
    return { ok: false, message: rejection };
  }
  if (token === undefined || token === null) {
    return issueConfirmChallenge(state, collabId, offerId, sessionId);
  }
  const challenge = m5RuntimeOf(state).challenges.get(confirmKey(collabId, offerId, sessionId));
  if (challenge === undefined || challenge.token !== token || nowMs(state) > challenge.deadline) {
    return { ok: false, message: '确认令牌无效或已过期——请重新发起确认' };
  }
  m5RuntimeOf(state).challenges.delete(confirmKey(collabId, offerId, sessionId));
  return sendOfferAccept(state, local, record, sessionId);
}

function confirmRejection(state, local, record, sessionId) {
  if (record === undefined || record.state !== OFFER_STATE_OPEN) {
    return '没有该待确认的移交提议（可能已过期或已处置）';
  }
  if (record.expiresAtMs <= nowMs(state)) {
    return '移交提议已过期（迟到确认一律拒绝）';
  }
  return isLocalSeatId(local, sessionId) ? null : '确认会话不是本机在该协作的活跃席位';
}

function confirmKey(collabId, offerId, sessionId) {
  return `${collabId}\u0000${offerId}\u0000${sessionId}`;
}

function issueConfirmChallenge(state, collabId, offerId, sessionId) {
  const challenge = randomUUID();
  m5RuntimeOf(state).challenges.set(confirmKey(collabId, offerId, sessionId), {
    token: challenge,
    deadline: nowMs(state) + CHALLENGE_TTL_MS,
  });
  return { ok: true, needsUserConfirmation: true, token: challenge, offerId, message: '需用户确认：携同一 token 重试即回执接受。' };
}

function isLocalSeatId(local, sessionId) {
  return localSeatsOf(local).some((seat) => seat.sessionId === sessionId);
}

function sendOfferAccept(state, local, record, sessionId) {
  const endpoint = endpointFor(state, local, record.from.instanceId);
  if (endpoint === undefined) {
    return { ok: false, message: '移交方端点未知——无法回执' };
  }
  const sent = sendTo(state, local.collabId, record.from.instanceId, endpoint, 'handover', {
    kind: 'accept',
    offerId: record.offerId,
    baseTerm: record.baseTerm,
    version: record.version,
    digest: record.digest,
    confirm: true,
  }, { fromSessionId: sessionId });
  if (sent.ok !== true) {
    return { ok: false, message: `接受回执入队失败：${sent.reason ?? '未知原因'}` };
  }
  record.state = OFFER_STATE_ACCEPTED;
  persistOfferRecords(state, local);
  bump(state, 'handoverAccepted');
  return { ok: true, accepted: true, offerId: record.offerId, message: '已回执接受；等待现任站长签发站长变更。' };
}

/* —— auto-offer 广播接收与目标侧自动接受（设计 §2A.5） —— */

export function handleAutoOffer(state, frame) {
  const local = state.collabs.get(frame.collabId);
  if (local === undefined) {
    return;
  }
  const runtime = m5RuntimeOf(state);
  const offers = runtime.autoOffers.get(local.collabId) ?? new Map();
  offers.set(frame.payload.offerId, { ...frame.payload, receivedAt: nowMs(state) });
  runtime.autoOffers.set(local.collabId, offers);
  pruneAutoOffers(state, local);
  bump(state, 'autoOffersIn');
  const record = runtime.handoverOffers.get(local.collabId)?.get(frame.payload.offerId);
  if (record !== undefined && record.state === OFFER_STATE_OPEN) {
    autoAcceptOffer(state, local, record, frame.payload);
  }
}

function pruneAutoOffers(state, local) {
  const offers = m5RuntimeOf(state).autoOffers.get(local.collabId);
  if (offers === undefined) {
    return;
  }
  const now = nowMs(state);
  for (const [offerId, offer] of [...offers.entries()]) {
    if (Date.parse(offer.expiresAt) <= now) {
      offers.delete(offerId);
    }
  }
}

function matchingAutoOffer(state, local, offerId) {
  const offer = m5RuntimeOf(state).autoOffers.get(local.collabId)?.get(offerId);
  if (offer === undefined || offer.target.instanceId !== state.self.instanceId) {
    return null;
  }
  return Date.parse(offer.expiresAt) > nowMs(state) ? offer : null;
}

/* 目标核自动接受：校验席位/任期/摘要/匹配 auto-offer；写记录 → 回 accept → 以自己名义签发 change。 */
function autoAcceptOffer(state, local, record, autoOffer) {
  const rejection = autoAcceptRejection(state, local, record, autoOffer);
  if (rejection !== null) {
    bump(state, 'autoAcceptRejected');
    return false;
  }
  record.state = OFFER_STATE_ACCEPTED;
  persistOfferRecords(state, local);
  sendAutoAcceptReceipt(state, local, record);
  signAutoChange(state, local, record, autoOffer);
  return true;
}

function autoAcceptRejection(state, local, record, autoOffer) {
  if (autoOffer.prevManager === undefined || record.from.instanceId !== autoOffer.prevManager.instanceId) {
    return 'prev-manager-mismatch';
  }
  if (record.expiresAtMs <= nowMs(state)) {
    return 'expired';
  }
  if (targetSeatOf(local, autoOffer) === undefined) {
    return 'target-seat-missing';
  }
  return record.ledger.members.some((member) => member.instanceId === state.self.instanceId) ? null : 'target-not-in-roster';
}

function targetSeatOf(local, autoOffer) {
  const seats = localSeatsOf(local);
  if (typeof autoOffer.target.sessionId === 'string' && autoOffer.target.sessionId !== '') {
    return seats.find((entry) => entry.sessionId === autoOffer.target.sessionId);
  }
  return seats.length === 1 ? seats[0] : undefined;
}

function sendAutoAcceptReceipt(state, local, record) {
  const endpoint = endpointFor(state, local, record.from.instanceId);
  if (endpoint === undefined) {
    return;
  }
  const signer = presenceSignerOf(local);
  sendTo(state, local.collabId, record.from.instanceId, endpoint, 'handover', {
    kind: 'accept',
    offerId: record.offerId,
    baseTerm: record.baseTerm,
    version: record.version,
    digest: record.digest,
    confirm: true,
  }, { fromSessionId: signer?.sessionId });
}

/* 新站长签发 via=auto：最终台账 = offer 台账 + auto-offer 事件 + 移除旧站长 + 提升自己 + 开窗。 */
function signAutoChange(state, local, record, autoOffer) {
  const seat = targetSeatOf(local, autoOffer);
  if (seat === undefined) {
    bump(state, 'autoChangeBuildFailures');
    return;
  }
  const finalLedger = buildAutoLedger(state, local, record, autoOffer, seat.sessionId);
  if (finalLedger === null) {
    bump(state, 'autoChangeBuildFailures');
    return;
  }
  promoteToManager(state, local, finalLedger);
  clearManagerFreeze(state, local.collabId);
  const payload = autoChangePayloadOf(state, local, finalLedger, record);
  broadcastAutoChange(state, local, payload, seat.sessionId);
  rememberPendingChange(state, local.collabId, {
    payload,
    prevManager: record.ledger.manager,
    fromSessionId: seat.sessionId,
  });
  m5RuntimeOf(state).acceptedManagers.set(local.collabId, {
    term: finalLedger.managerTerm,
    manager: finalLedger.manager,
    source: { instanceId: state.self.instanceId, sessionId: seat.sessionId },
  });
  m5RuntimeOf(state).managerWindowBaseAt.set(local.collabId, nowMs(state));
  bump(state, 'autoChangesSigned');
}

function buildAutoLedger(state, local, record, autoOffer, sessionId) {
  const ledger = ensureTermFields(structuredClone(record.ledger));
  const baseTerm = ledgerTermOf(ledger);
  const baseVersion = ledger.version;
  const prevManager = isPlainObject(ledger.manager) ? ledger.manager : record.from;
  const selfRow = ledger.members.find((member) => member.instanceId === state.self.instanceId
    && (member.sessionId === undefined || member.sessionId === sessionId));
  if (selfRow === undefined || baseTerm !== record.baseTerm) {
    return null;
  }
  ledger.members = ledger.members.filter((member) => !(member.role === 'manager'
    && member.instanceId === prevManager.instanceId
    && (member.sessionId === undefined || member.sessionId === prevManager.sessionId)));
  selfRow.role = 'manager';
  selfRow.sessionId = sessionId;
  selfRow.identityName = state.self.identityName;
  selfRow.state = 'member';
  ledger.managerTerm = baseTerm + 1;
  ledger.version = baseVersion + 1;
  ledger.updatedAt = new Date().toISOString();
  ledger.manager = { instanceId: state.self.instanceId, sessionId, identityName: state.self.identityName, term: ledger.managerTerm };
  const effectiveAt = new Date(nowMs(state)).toISOString();
  const windowEndsAt = new Date(nowMs(state) + windowMs(state)).toISOString();
  ledger.managerWindow = { windowBaseTerm: ledger.managerTerm, windowEndsAt };
  ledger.events = appendAutoEvents(ledger, autoOffer, record, prevManager, ledger.manager, effectiveAt);
  return ledger;
}

function appendAutoEvents(ledger, autoOffer, record, prevManager, manager, effectiveAt) {
  const events = Array.isArray(ledger.events) ? [...ledger.events] : [];
  events.push({
    type: 'auto-offer',
    offerId: autoOffer.offerId,
    prevManager: { instanceId: prevManager.instanceId, sessionId: prevManager.sessionId },
    target: { instanceId: manager.instanceId, sessionId: manager.sessionId },
    baseTerm: record.baseTerm,
    version: record.version,
    expiresAt: autoOffer.expiresAt,
    at: effectiveAt,
  });
  events.push({
    type: 'leave',
    seat: { instanceId: prevManager.instanceId, sessionId: prevManager.sessionId, identityName: prevManager.identityName },
    reason: 'manager-session-closed',
    term: ledger.managerTerm,
    at: effectiveAt,
  });
  events.push({
    type: 'manager-changed',
    via: 'auto',
    offerId: autoOffer.offerId,
    term: ledger.managerTerm,
    version: ledger.version,
    prevManager: { instanceId: prevManager.instanceId, sessionId: prevManager.sessionId },
    manager: { instanceId: manager.instanceId, sessionId: manager.sessionId, identityName: manager.identityName },
    at: effectiveAt,
  });
  return events;
}

function autoChangePayloadOf(state, local, ledger, record) {
  return {
    event: 'manager-changed',
    manager: { instanceId: ledger.manager.instanceId, sessionId: ledger.manager.sessionId, identityName: ledger.manager.identityName },
    term: ledger.managerTerm,
    version: ledger.version,
    via: 'auto',
    prevManager: { instanceId: record.ledger.manager.instanceId, sessionId: record.ledger.manager.sessionId },
    offerId: record.offerId,
    windowEndsAt: ledger.managerWindow.windowEndsAt,
    effectiveAt: new Date(nowMs(state)).toISOString(),
    endpoint: selfEndpointOf(state),
    digest: ledgerDigest(ledger),
  };
}

function broadcastAutoChange(state, local, payload, sessionId) {
  const targets = new Map();
  for (const member of local.ledger?.members ?? []) {
    targets.set(member.instanceId, member);
  }
  const prev = payload.prevManager;
  if (!targets.has(prev.instanceId)) {
    targets.set(prev.instanceId, { instanceId: prev.instanceId, sessionId: prev.sessionId });
  }
  for (const [instanceId, member] of targets) {
    if (instanceId === state.self.instanceId) {
      continue;
    }
    const endpoint = endpointFor(state, local, instanceId);
    if (endpoint === undefined) {
      continue;
    }
    sendTo(state, local.collabId, instanceId, endpoint, 'notice', payload, {
      fromSessionId: sessionId,
      ...(member?.sessionId === undefined ? {} : { toSessions: [member.sessionId] }),
    });
  }
}

function selfEndpointOf(state) {
  if (isPlainObject(state.selfEndpoint) && typeof state.selfEndpoint.address === 'string') {
    return { address: state.selfEndpoint.address, port: state.selfEndpoint.port ?? state.self.port };
  }
  if (typeof state.self?.address === 'string' && state.self.address !== '') {
    return { address: state.self.address, port: state.self.port };
  }
  return { address: '127.0.0.1', port: state.self.port };
}

/* —— 旧站长侧：接受/拒绝回执 —— */

function handleAccept(state, local, frame) {
  const runtime = m5RuntimeOf(state);
  const pending = runtime.pendingHandovers.get(local.collabId);
  if (pending === undefined) {
    bump(state, 'lateHandoverAccepts');
    return;
  }
  if (!sameSeat({ instanceId: frame.from.instanceId, sessionId: frame.from.sessionId }, pending.target)) {
    bump(state, 'eventMismatch');
    return;
  }
  if (pending.expiresAtMs <= nowMs(state)) {
    sendHandoverReject(state, local, frame, 'expired');
    clearPendingHandover(state, local);
    bump(state, 'handoverTimeouts');
    return;
  }
  if (!acceptMatchesLedger(state, local, pending, frame.payload)) {
    sendHandoverReject(state, local, frame, 'version-changed');
    clearPendingHandover(state, local);
    return;
  }
  if (pending.auto === true) {
    markManagerPending(state, local, pending);
    bump(state, 'autoAcceptReceived');
    return;
  }
  completeExplicitHandover(state, local, pending);
}

function acceptMatchesLedger(state, local, pending, payload) {
  return payload.offerId === pending.offerId
    && payload.baseTerm === pending.baseTerm
    && payload.version === local.ledger.version
    && payload.digest === ledgerDigest(local.ledger);
}

function completeExplicitHandover(state, local, pending) {
  const effectiveAt = new Date(nowMs(state)).toISOString();
  const built = buildExplicitLedger(state, local, pending, effectiveAt);
  if (built === null) {
    sendHandoverRejectForPending(state, local, pending, 'version-changed');
    clearPendingHandover(state, local);
    return;
  }
  const signer = managerSeatOfLedger(state, local);
  broadcastExplicitChange(state, local, built.payload, signer?.sessionId);
  saveSnapshotCopy(state, local, built.ledger);
  clearPendingHandoverInPlace(state, local);
  downgradeToMember(state, local, { instanceId: pending.target.instanceId, identityName: pending.target.identityName }, built.ledger.version);
  rememberPendingChange(state, local.collabId, {
    payload: built.payload,
    prevManager: built.prevManager,
    fromSessionId: signer?.sessionId,
  });
  bump(state, 'handoverCompleted');
  notifyLocal(state, local, `移交完成：站长已变更为「${pending.target.identityName}」——本机已转协作者。`);
}

function buildExplicitLedger(state, local, pending, effectiveAt) {
  const ledger = ensureTermFields(structuredClone(local.ledger));
  const prevManager = { ...ledger.manager };
  const targetRow = ledger.members.find((member) => member.instanceId === pending.target.instanceId
    && member.sessionId === pending.target.sessionId);
  if (targetRow === undefined) {
    return null;
  }
  demoteManagerRow(ledger, prevManager);
  targetRow.role = 'manager';
  targetRow.state = 'member';
  ledger.managerTerm = pending.baseTerm + 1;
  ledger.version = (ledger.version ?? 1) + 1;
  ledger.updatedAt = effectiveAt;
  ledger.manager = { instanceId: targetRow.instanceId, sessionId: targetRow.sessionId, identityName: targetRow.identityName, term: ledger.managerTerm };
  delete ledger.managerWindow;
  ledger.events = [
    ...(Array.isArray(ledger.events) ? ledger.events : []),
    { type: 'manager-changed', via: 'handover', offerId: pending.offerId, term: ledger.managerTerm, version: ledger.version, prevManager, manager: ledger.manager, at: effectiveAt },
  ];
  const payload = explicitChangePayloadOf(state, local, ledger, pending, prevManager, effectiveAt);
  return { ledger, payload, prevManager };
}

function demoteManagerRow(ledger, prevManager) {
  const row = ledger.members.find((member) => member.role === 'manager'
    && member.instanceId === prevManager.instanceId
    && (member.sessionId === undefined || member.sessionId === prevManager.sessionId));
  if (row !== undefined) {
    row.role = 'member';
  }
}

function explicitChangePayloadOf(state, local, ledger, pending, prevManager, effectiveAt) {
  return {
    event: 'manager-changed',
    manager: { instanceId: ledger.manager.instanceId, sessionId: ledger.manager.sessionId, identityName: ledger.manager.identityName },
    term: ledger.managerTerm,
    version: ledger.version,
    via: 'handover',
    prevManager: { instanceId: prevManager.instanceId, sessionId: prevManager.sessionId },
    offerId: pending.offerId,
    effectiveAt,
    endpoint: targetEndpointOf(state, local, ledger.manager),
    digest: ledgerDigest(ledger),
  };
}

function targetEndpointOf(state, local, manager) {
  const endpoint = endpointFor(state, local, manager.instanceId);
  return endpoint === undefined ? { address: '127.0.0.1', port: state.self.port } : { address: endpoint.address, port: endpoint.port };
}

function broadcastExplicitChange(state, local, payload, sessionId) {
  for (const member of local.ledger.members) {
    if (member.instanceId === state.self.instanceId) {
      continue;
    }
    const endpoint = endpointFor(state, local, member.instanceId);
    if (endpoint !== undefined) {
      sendTo(state, local.collabId, member.instanceId, endpoint, 'notice', payload, {
        fromSessionId: sessionId,
        ...(member.sessionId === undefined ? {} : { toSessions: [member.sessionId] }),
      });
    }
  }
}

/* 采纳前保留只读副本：降级会删除台账文件，快照文件即只读副本（设计 §2A.8③）。 */
function saveSnapshotCopy(state, local, ledger) {
  local.snapshot = {
    version: ledger.version,
    digest: ledgerDigest(ledger),
    receivedAt: new Date().toISOString(),
    from: { instanceId: state.self.instanceId, identityName: state.self.identityName },
    ledger: structuredClone(ledger),
  };
  persistSnapshot(state, local);
}

function clearPendingHandoverInPlace(state, local) {
  const runtime = m5RuntimeOf(state);
  runtime.pendingHandovers.delete(local.collabId);
  runtime.handoverTargets.delete(local.collabId);
  const timer = runtime.handoverTargets.get(`${local.collabId}\u0000timer`);
  if (timer !== undefined) {
    clearTimeout(timer);
    runtime.handoverTargets.delete(`${local.collabId}\u0000timer`);
  }
  rmPendingFile(state, local);
  if (local.suspended !== null && local.suspended.reason === 'handover-pending') {
    local.suspended = null;
  }
}

function sendHandoverRejectForPending(state, local, pending, reason) {
  const endpoint = endpointFor(state, local, pending.target.instanceId);
  if (endpoint === undefined) {
    return;
  }
  sendTo(state, local.collabId, pending.target.instanceId, endpoint, 'handover', {
    kind: 'reject',
    offerId: pending.offerId,
    reason,
  }, { fromSessionId: localSignerSessionOf(state, local), ...(pending.target.sessionId === undefined ? {} : { toSessions: [pending.target.sessionId] }) });
}

function handleReject(state, local, frame) {
  const runtime = m5RuntimeOf(state);
  const pending = runtime.pendingHandovers.get(local.collabId);
  if (pending === undefined || pending.offerId !== frame.payload.offerId) {
    return;
  }
  if (!sameSeat({ instanceId: frame.from.instanceId, sessionId: frame.from.sessionId }, pending.target)) {
    return;
  }
  clearPendingHandover(state, local);
  bump(state, 'handoverRejected');
  notifyLocal(state, local, `对方拒绝移交：${frame.payload.reason ?? '未说明'}`);
}

/* 旧导出的「完成」面保留：供测试与外部按 accept 直接收口（仅显式移交）。 */
export function completeHandover(state, local, accept) {
  const pending = m5RuntimeOf(state).pendingHandovers.get(local.collabId);
  if (pending === undefined || local.role !== 'manager' || local.ledger === null) {
    return false;
  }
  if (accept.offerId !== undefined && accept.offerId !== pending.offerId) {
    return false;
  }
  if (accept.version !== local.ledger.version || accept.digest !== ledgerDigest(local.ledger)) {
    return false;
  }
  completeExplicitHandover(state, local, pending);
  return true;
}

export { handoverConfirmMs };
export const HANDOVER_CONFIRM_TIMEOUT_MS = 120000;

/* 目标侧收到 via=handover 的签发帧：用 offer 台账按同一确定性规则重算最终台账，校验 digest 一致后
 * 提升为站长（设计 §2A.4④）。返回 false = 本机不是该 offer 的目标，交任期受理表继续判定。 */
export function adoptHandoverAsTarget(state, local, change) {
  if (change.via !== 'handover' || local.role === 'manager') {
    return false;
  }
  const record = m5RuntimeOf(state).handoverOffers.get(local.collabId)?.get(change.offerId);
  if (!handoverChangeMatches(record, change)) {
    return false;
  }
  const ledger = recomputeHandoverLedger(record, state, change);
  if (ledger === null || ledgerDigest(ledger) !== change.digest) {
    bump(state, 'handoverDigestMismatch');
    return false;
  }
  promoteToManager(state, local, ledger);
  clearManagerFreeze(state, local.collabId);
  m5RuntimeOf(state).acceptedManagers.set(local.collabId, {
    term: ledger.managerTerm,
    manager: ledger.manager,
    source: { instanceId: state.self.instanceId, sessionId: ledger.manager.sessionId },
  });
  m5RuntimeOf(state).managerWindowBaseAt.delete(local.collabId);
  bump(state, 'handoverTargetsPromoted');
  notifyLocal(state, local, `移交已生效：本机已成为站长（任期 ${ledger.managerTerm}）。`);
  return true;
}

function handoverChangeMatches(record, change) {
  if (record === undefined || record.state !== OFFER_STATE_ACCEPTED) {
    return false;
  }
  if (!sameSeat(change.from, record.from)) {
    return false;
  }
  return change.term === record.baseTerm + 1 && change.version === record.version + 1;
}

function recomputeHandoverLedger(record, state, change) {
  const ledger = ensureTermFields(structuredClone(record.ledger));
  const prevManager = ledger.manager;
  const selfRow = ledger.members.find((member) => member.instanceId === state.self.instanceId
    && (member.sessionId === undefined || member.sessionId === change.manager.sessionId));
  if (selfRow === undefined) {
    return null;
  }
  demoteManagerRow(ledger, prevManager);
  selfRow.role = 'manager';
  selfRow.state = 'member';
  ledger.managerTerm = record.baseTerm + 1;
  ledger.version = record.version + 1;
  ledger.updatedAt = change.effectiveAt;
  ledger.manager = { instanceId: selfRow.instanceId, sessionId: selfRow.sessionId, identityName: selfRow.identityName, term: ledger.managerTerm };
  delete ledger.managerWindow;
  ledger.events = [
    ...(Array.isArray(ledger.events) ? ledger.events : []),
    { type: 'manager-changed', via: 'handover', offerId: record.offerId, term: ledger.managerTerm, version: ledger.version, prevManager, manager: ledger.manager, at: change.effectiveAt },
  ];
  return ledger;
}
