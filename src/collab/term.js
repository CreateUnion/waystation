/* 任期内核（设计 §2A.2 / §2A.10）：站长变更与快照的受理判决。
 * 纯逻辑：只读 state/ctx、返回 {accepted,nextState,freezeReason,actions,reason}，不写盘、不发帧。
 *
 * state 只含共享台账的任期面：{managerTerm, manager:{instanceId,sessionId,identityName,term}|null, version, managerWindow?}。
 * 冻结态、auto-offer 记录、名单/可达性等外部证据经 ctx 传入——判决与证据收集分开，便于在 PC 上单测。
 * 返回的 actions 是接线层要执行的动作：adopt / request-snapshot / open-window / close-window /
 * clear-freeze / freeze / report / handshake / ack / ack-snapshot-stored / store-pending-catchup / count-reject。 */

/* 快照排序判据在名单内核已实现（按 (managerTerm,version)；同 term 不同 manager 报冲突）；
 * 任期模块复用同一实现，避免两份排序逻辑分叉。 */
export { compareSnapshot } from './model.js';

const MAX_MANAGER_TERM = 2147483647;
const CHANGE_VIAS = ['handover', 'auto', 'takeover', 'takeover-manual'];
const AUTO_CATCHUP_LEAVE_REASONS = ['manager-lost', 'manager-session-closed'];
const MANAGER_FORK = 'manager-fork';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRef(value) {
  return isPlainObject(value)
    && typeof value.instanceId === 'string' && value.instanceId !== ''
    && typeof value.sessionId === 'string' && value.sessionId !== '';
}

function isPeer(value) {
  return isRef(value) && typeof value.identityName === 'string' && value.identityName !== '';
}

function isTerm(value) {
  return Number.isInteger(value) && value >= 1 && value <= MAX_MANAGER_TERM;
}

function isVersion(value) {
  return Number.isInteger(value) && value >= 1;
}

function timeOf(value) {
  return typeof value === 'string' ? Date.parse(value) : Number.NaN;
}

function sameSeat(left, right) {
  return isRef(left) && isRef(right)
    && left.instanceId === right.instanceId
    && left.sessionId === right.sessionId;
}

function isWindowShape(window) {
  return isPlainObject(window)
    && isTerm(window.windowBaseTerm)
    && Number.isFinite(timeOf(window.windowEndsAt));
}

function isStateShape(state) {
  if (!isPlainObject(state) || !isTerm(state.managerTerm) || !isVersion(state.version)) {
    return false;
  }
  return state.manager === null || isPeer(state.manager);
}

function isChangeShape(frame) {
  if (!isPlainObject(frame) || !CHANGE_VIAS.includes(frame.via)) {
    return false;
  }
  if (!isTerm(frame.term) || !isVersion(frame.version) || !isPeer(frame.manager) || !isRef(frame.prevManager)) {
    return false;
  }
  if (typeof frame.digest !== 'string' || frame.digest === '') {
    return false;
  }
  return isPlainObject(frame.endpoint) && Number.isFinite(timeOf(frame.effectiveAt));
}

function sourceOf(frame, ctx) {
  if (isRef(frame.from)) {
    return frame.from;
  }
  return isRef(ctx.from) ? ctx.from : null;
}

function accepted(nextState, reason, actions) {
  return { accepted: true, nextState, actions, reason };
}

function rejected(state, reason, extra = {}) {
  const { actions = ['count-reject'], ...rest } = extra;
  return { accepted: false, nextState: state, actions, reason, ...rest };
}

function idempotent(state, reason, actions) {
  return { accepted: false, nextState: state, actions, reason, idempotent: true };
}

/* 冻结只作为判决结果返回：状态形态不含冻结字段，由接线层把 freezeReason 落到协作共享态。 */
function frozen(state, reason) {
  return { accepted: false, nextState: state, actions: ['freeze', 'report'], reason, freezeReason: MANAGER_FORK };
}

/* manager-pending 在目标签发 auto 帧到达时解除；manager-fork 只能靠更高 term 对表或用户裁定。 */
function freezeNote(ctx) {
  const cleared = ctx.localFrozen === 'manager-offline' || ctx.localFrozen === 'manager-pending';
  return cleared ? ['clear-freeze'] : [];
}

function adoptActions(state, extras = []) {
  const actions = ['adopt', 'request-snapshot'];
  if (state.managerWindow !== undefined) {
    actions.push('close-window');
  }
  for (const extra of extras) {
    if (!actions.includes(extra)) {
      actions.push(extra);
    }
  }
  return actions;
}

function managerSeatOf(seat, term) {
  return {
    instanceId: seat.instanceId,
    sessionId: seat.sessionId,
    identityName: seat.identityName,
    term,
  };
}

function stateFromChange(frame, window) {
  return {
    managerTerm: frame.term,
    manager: managerSeatOf(frame.manager, frame.term),
    version: frame.version,
    ...(window === undefined ? {} : { managerWindow: window }),
  };
}

function snapshotNextState(snapshot) {
  return {
    managerTerm: snapshot.managerTerm,
    manager: managerSeatOf(snapshot.manager, snapshot.managerTerm),
    version: snapshot.version,
    ...(snapshot.managerWindow === undefined ? {} : { managerWindow: { ...snapshot.managerWindow } }),
  };
}

function snapshotStateOf(frame) {
  if (!isPlainObject(frame) || !isPlainObject(frame.ledger)) {
    return null;
  }
  const ledger = frame.ledger;
  if (!snapshotLedgerHeadMatches(ledger, frame)) {
    return null;
  }
  const window = ledger.managerWindow === undefined ? frame.managerWindow : ledger.managerWindow;
  if (window !== undefined && !isWindowShape(window)) {
    return null;
  }
  return {
    managerTerm: ledger.managerTerm,
    manager: ledger.manager,
    version: ledger.version,
    ...(window === undefined ? {} : { managerWindow: { ...window } }),
  };
}

function snapshotLedgerHeadMatches(ledger, frame) {
  if (!isTerm(ledger.managerTerm) || !isVersion(ledger.version) || !isPeer(ledger.manager)) {
    return false;
  }
  return ledger.managerTerm === frame.managerTerm && ledger.version === frame.version;
}

export function acceptManagerChange(state, frame, ctx = {}) {
  if (isPlainObject(frame) && (frame.kind === 'data' || isPlainObject(frame.ledger))) {
    return acceptSnapshot(state, frame, ctx);
  }
  return acceptChange(state, frame, ctx);
}

function acceptChange(state, frame, ctx) {
  if (!isStateShape(state) || !isChangeShape(frame)) {
    return rejected(state, 'frame-invalid');
  }
  const relation = changeTermRelation(state, frame, ctx);
  if (relation !== null) {
    return relation;
  }
  const precheck = changePrecheck(state, frame, ctx);
  if (precheck !== null) {
    return precheck;
  }
  return acceptByVia(state, frame, ctx);
}

function changeTermRelation(state, frame, ctx) {
  if (frame.term < state.managerTerm) {
    return rejected(state, 'term-behind');
  }
  if (frame.term === state.managerTerm) {
    return acceptSameTerm(state, frame);
  }
  if (frame.term > state.managerTerm + 1) {
    return acceptTermGap(state, frame, ctx);
  }
  return null;
}

function changePrecheck(state, frame, ctx) {
  if (state.manager === null) {
    return rejected(state, 'no-local-manager');
  }
  const frozenBlock = changeFrozenBlock(state, frame, ctx);
  if (frozenBlock !== null) {
    return frozenBlock;
  }
  if (sourceOf(frame, ctx) === null) {
    return rejected(state, 'source-missing');
  }
  if (frame.version <= state.version) {
    return rejected(state, 'version-not-newer');
  }
  if (!sameSeat(frame.prevManager, state.manager)) {
    return frozen(state, 'prev-manager-mismatch');
  }
  if (sameSeat(frame.manager, frame.prevManager)) {
    return rejected(state, 'manager-unchanged');
  }
  return null;
}

/* 分叉冻结不接受单一 term+1 变更（双方轮流向 +1 竞争），只等更高 term 对表或用户裁定；
 * manager-pending 只等目标签发的那一帧 auto，其它来源的同 term 竞争一律拒收（设计 §2A.3）。 */
function changeFrozenBlock(state, frame, ctx) {
  if (ctx.localFrozen === 'manager-fork') {
    return rejected(state, 'frozen-manager-fork');
  }
  if (ctx.localFrozen === 'manager-pending' && frame.via !== 'auto') {
    return rejected(state, 'frozen-manager-pending');
  }
  return null;
}

/* 同 term 同 manager 是幂等回执；帧 version 更高说明本地名单落后，顺带向来源补拉快照。 */
function acceptSameTerm(state, frame) {
  if (sameSeat(frame.manager, state.manager)) {
    const actions = frame.version > state.version ? ['ack', 'request-snapshot'] : ['ack'];
    return idempotent(state, 'idempotent', actions);
  }
  return frozen(state, 'same-term-manager-conflict');
}

function acceptTermGap(state, frame, ctx) {
  if (ctx.syncExpired === true) {
    return frozen(state, 'term-gap-sync-timeout');
  }
  return rejected(state, 'term-gap', { actions: ['handshake', 'request-snapshot'], needsSync: true });
}

function acceptByVia(state, frame, ctx) {
  switch (frame.via) {
    case 'handover': {
      return acceptHandover(state, frame, ctx);
    }
    case 'auto': {
      return acceptAuto(state, frame, ctx);
    }
    case 'takeover': {
      return acceptTakeover(state, frame, ctx);
    }
    case 'takeover-manual': {
      return acceptTakeoverManual(state, frame, ctx);
    }
    default: {
      return rejected(state, 'via-unsupported');
    }
  }
}

function acceptHandover(state, frame, ctx) {
  if (!sameSeat(sourceOf(frame, ctx), state.manager)) {
    return frozen(state, 'handover-source-mismatch');
  }
  if (typeof frame.offerId !== 'string' || frame.offerId === '') {
    return rejected(state, 'offer-missing');
  }
  return accepted(stateFromChange(frame), 'handover-accepted', adoptActions(state, freezeNote(ctx)));
}

function acceptAuto(state, frame, ctx) {
  if (!sameSeat(sourceOf(frame, ctx), frame.manager)) {
    return frozen(state, 'auto-source-not-manager');
  }
  if (typeof frame.offerId !== 'string' || frame.offerId === '') {
    return rejected(state, 'offer-missing');
  }
  if (!Number.isFinite(timeOf(frame.windowEndsAt))) {
    return rejected(state, 'window-missing');
  }
  if (!hasMatchingAutoOffer(ctx, frame)) {
    return rejected(state, 'auto-offer-missing');
  }
  const window = { windowBaseTerm: frame.term, windowEndsAt: frame.windowEndsAt };
  const actions = ['adopt', 'open-window', 'request-snapshot', ...freezeNote(ctx)];
  return accepted(stateFromChange(frame, window), 'auto-accepted', actions);
}

function acceptTakeover(state, frame, ctx) {
  if (!isMemberSource(ctx, sourceOf(frame, ctx))) {
    return frozen(state, 'source-not-member');
  }
  if (frame.windowBaseTerm !== state.managerTerm) {
    return rejected(state, 'window-base-mismatch');
  }
  if (state.managerWindow === undefined || state.managerWindow.windowBaseTerm !== state.managerTerm) {
    return rejected(state, 'window-missing', { actions: ['request-snapshot'] });
  }
  if (!Number.isFinite(timeOf(frame.authorizedAt))) {
    return rejected(state, 'authorized-at-missing');
  }
  if (!windowAcceptsTakeover(state.managerWindow, frame.authorizedAt, ctx.now)) {
    return rejected(state, 'window-closed');
  }
  return accepted(stateFromChange(frame), 'takeover-accepted', adoptActions(state, freezeNote(ctx)));
}

function acceptTakeoverManual(state, frame, ctx) {
  const blockReason = manualBlockReason(ctx);
  if (blockReason !== null) {
    return rejected(state, blockReason);
  }
  if (!isMemberSource(ctx, sourceOf(frame, ctx))) {
    return frozen(state, 'source-not-member');
  }
  if (!Number.isFinite(timeOf(frame.authorizedAt))) {
    return rejected(state, 'authorized-at-missing');
  }
  if (ctx.managerReachable === true) {
    return rejected(state, 'manager-reachable');
  }
  return accepted(
    stateFromChange(frame),
    'takeover-manual-accepted',
    adoptActions(state, freezeNote(ctx)),
  );
}

/* 手动接管的前提是站长不可达，但「本地已冻结」不是受理前提（设计 §2A.7）：
 * 这里只拦未解决的 auto 在途，避免与另一个 term+1 竞争；分叉/等待态由公共门控处理。 */
function manualBlockReason(ctx) {
  if (ctx.autoInFlight === true || hasUnexpiredAutoOffer(ctx)) {
    return 'auto-in-flight';
  }
  return null;
}

function isMemberSource(ctx, source) {
  if (!isRef(source)) {
    return false;
  }
  if (typeof ctx.isMemberSeat === 'function') {
    return ctx.isMemberSeat(source) === true;
  }
  if (Array.isArray(ctx.memberSeats)) {
    return ctx.memberSeats.some((seat) => sameSeat(seat, source));
  }
  return true;
}

function windowAcceptsTakeover(window, authorizedAt, now) {
  const endsAt = timeOf(window.windowEndsAt);
  const nowMs = Number.isFinite(now) ? now : Date.now();
  if (nowMs < endsAt) {
    return true;
  }
  const authorizedAtMs = timeOf(authorizedAt);
  return Number.isFinite(authorizedAtMs) && authorizedAtMs <= endsAt;
}

function acceptSnapshot(state, frame, ctx) {
  const snapshot = snapshotStateOf(frame);
  if (!isStateShape(state) || snapshot === null) {
    return rejected(state, 'frame-invalid');
  }
  if (snapshot.managerTerm < state.managerTerm) {
    return rejected(state, 'term-behind');
  }
  if (snapshot.managerTerm === state.managerTerm) {
    return acceptSameTermSnapshot(state, snapshot);
  }
  const frozenResult = snapshotFrozenResult(state, snapshot, ctx);
  if (frozenResult !== null) {
    return frozenResult;
  }
  return acceptHigherSnapshot(state, snapshot, frame, ctx);
}

function acceptSameTermSnapshot(state, snapshot) {
  if (!sameSeat(snapshot.manager, state.manager)) {
    return frozen(state, 'snapshot-same-term-conflict');
  }
  if (snapshot.version < state.version) {
    return rejected(state, 'version-behind');
  }
  if (snapshot.version === state.version) {
    return idempotent(state, 'snapshot-idempotent', ['ack-snapshot-stored']);
  }
  return accepted(snapshotNextState(snapshot), 'snapshot-version-accepted', ['adopt']);
}

function snapshotFrozenResult(state, snapshot, ctx) {
  switch (ctx.localFrozen) {
    case 'manager-offline': {
      return acceptOfflineCatchup(state, snapshot, ctx);
    }
    case 'manager-fork': {
      return acceptForkedCatchup(state, snapshot, ctx);
    }
    case 'manager-pending': {
      return rejected(state, 'frozen-manager-pending');
    }
    default: {
      return null;
    }
  }
}

function acceptOfflineCatchup(state, snapshot, ctx) {
  if (matchesHandshakeHighest(snapshot, ctx.handshakeHighest)) {
    return accepted(snapshotNextState(snapshot), 'snapshot-catchup-accepted', ['adopt', 'clear-freeze']);
  }
  return frozen(state, 'snapshot-catchup-mismatch');
}

function matchesHandshakeHighest(snapshot, highest) {
  return isPlainObject(highest)
    && highest.term === snapshot.managerTerm
    && highest.version === snapshot.version
    && sameSeat(highest.manager, snapshot.manager);
}

function acceptForkedCatchup(state, snapshot, ctx) {
  const evidence = ctx.authorizedEvidence;
  const authorized = isPlainObject(evidence)
    && (evidence.via === 'takeover' || evidence.via === 'takeover-manual')
    && Number.isFinite(timeOf(evidence.authorizedAt));
  if (authorized) {
    return accepted(snapshotNextState(snapshot), 'snapshot-authorized-accepted', ['adopt', 'clear-freeze']);
  }
  return rejected(state, 'frozen-manager-fork');
}

function acceptHigherSnapshot(state, snapshot, frame, ctx) {
  const source = sourceOf(frame, ctx);
  if (sameSeat(source, state.manager)) {
    return accepted(snapshotNextState(snapshot), 'snapshot-manager-accepted', ['adopt']);
  }
  if (isAcceptedManagerSeat(ctx.acceptedManager, snapshot)) {
    return accepted(snapshotNextState(snapshot), 'snapshot-accepted-manager-accepted', ['adopt']);
  }
  if (ctx.suspended === 'handover-pending' && sameSeat(source, snapshot.manager)) {
    return accepted(snapshotNextState(snapshot), 'snapshot-handover-accepted', ['adopt']);
  }
  if (hasAutoCatchupEvidence(state, snapshot, source, ctx)) {
    return accepted(snapshotNextState(snapshot), 'snapshot-auto-catchup-accepted', ['adopt']);
  }
  return pendingOrFrozenSnapshot(state, snapshot, source, ctx);
}

function isAcceptedManagerSeat(value, snapshot) {
  return isPlainObject(value)
    && value.term === snapshot.managerTerm
    && sameSeat(value.manager, snapshot.manager);
}

/* 离线错过 auto-offer 的追赶路径（设计 §2A.2 A10）：来源必须是快照内新站长，
 * 且 auto-offer、via=auto 的 manager-changed、旧站长 leave 三证据互相印证，缺一拒收。 */
function hasAutoCatchupEvidence(state, snapshot, source, ctx) {
  if (!sameSeat(source, snapshot.manager)) {
    return false;
  }
  const { offer, change, leave } = ctx.autoCatchup ?? {};
  if (!isPlainObject(offer) || !isPlainObject(change) || !isPlainObject(leave)) {
    return false;
  }
  return autoChangeMatchesOffer(offer, change, state, snapshot)
    && sameSeat(leave, state.manager)
    && AUTO_CATCHUP_LEAVE_REASONS.includes(leave.reason);
}

function autoChangeMatchesOffer(offer, change, state, snapshot) {
  return change.via === 'auto'
    && change.offerId === offer.offerId
    && change.term === snapshot.managerTerm
    && sameSeat(change.prevManager, state.manager)
    && sameSeat(change.prevManager, offer.prevManager)
    && sameSeat(change.manager, snapshot.manager)
    && sameSeat(offer.target, snapshot.manager);
}

/* 活跃态收到未受理来源的更高 term 快照：term=本地+1 且来源自称新站长时先暂存等变更；
 * 来源已有被拒变更或等待超时则冻结，绝不「经快照转正」（设计 §2A.2 A10 取舍）。 */
function pendingOrFrozenSnapshot(state, snapshot, source, ctx) {
  if (isRef(ctx.rejectedChangeFrom) && sameSeat(ctx.rejectedChangeFrom, source)) {
    return frozen(state, 'snapshot-after-rejected-change');
  }
  if (snapshot.managerTerm === state.managerTerm + 1 && sameSeat(source, snapshot.manager)) {
    if (ctx.pendingCatchupExpired === true) {
      return frozen(state, 'snapshot-catchup-timeout');
    }
    return rejected(state, 'snapshot-awaiting-change', {
      actions: ['store-pending-catchup'],
      pendingCatchup: true,
    });
  }
  return frozen(state, 'snapshot-untrusted-higher-term');
}

function autoOffersOf(ctx) {
  if (Array.isArray(ctx.autoOffers)) {
    return ctx.autoOffers;
  }
  return isPlainObject(ctx.autoOffer) ? [ctx.autoOffer] : [];
}

function hasMatchingAutoOffer(ctx, frame) {
  return autoOffersOf(ctx).some((offer) => matchesAutoOffer(offer, frame, ctx.now));
}

function hasUnexpiredAutoOffer(ctx) {
  const nowMs = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  return autoOffersOf(ctx).some((offer) => timeOf(offer?.expiresAt) > nowMs);
}

export function makeAutoOffer(input) {
  if (!isPlainObject(input) || typeof input.offerId !== 'string' || input.offerId === '') {
    return null;
  }
  if (!isRef(input.prevManager) || !isRef(input.target)) {
    return null;
  }
  if (!isTerm(input.baseTerm) || !isVersion(input.version) || !Number.isFinite(timeOf(input.expiresAt))) {
    return null;
  }
  return {
    offerId: input.offerId,
    prevManager: { instanceId: input.prevManager.instanceId, sessionId: input.prevManager.sessionId },
    target: { instanceId: input.target.instanceId, sessionId: input.target.sessionId },
    baseTerm: input.baseTerm,
    version: input.version,
    expiresAt: input.expiresAt,
  };
}

export function matchesAutoOffer(offer, frame, now) {
  if (!isPlainObject(offer) || !isPlainObject(frame)) {
    return false;
  }
  if (offer.offerId !== frame.offerId) {
    return false;
  }
  if (!sameSeat(offer.prevManager, frame.prevManager) || !sameSeat(offer.target, frame.manager)) {
    return false;
  }
  if (offer.baseTerm + 1 !== frame.term) {
    return false;
  }
  return !isOfferExpired(offer, now);
}

function isOfferExpired(offer, now) {
  const endsAt = timeOf(offer.expiresAt);
  if (!Number.isFinite(endsAt)) {
    return true;
  }
  const nowMs = Number.isFinite(now) ? now : Date.now();
  return nowMs >= endsAt;
}

export function setManagerWindow(state, window) {
  return { ...state, managerWindow: { ...window } };
}

export function clearManagerWindow(state) {
  const next = { ...state };
  delete next.managerWindow;
  return next;
}

export function managerWindowRemaining(window, now) {
  const endsAt = isWindowShape(window) ? timeOf(window.windowEndsAt) : Number.NaN;
  if (!Number.isFinite(endsAt) || !Number.isFinite(now)) {
    return 0;
  }
  return Math.max(0, endsAt - now);
}
