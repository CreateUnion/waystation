/* 任期内核（设计 §2A.2 / §2A.6 / §2A.10）：站长变更与快照的受理判决。
 * 纯逻辑：只读 state/ctx、返回 {accepted,nextState,freezeReason,actions,reason}，不写盘、不发帧。
 *
 * state 只含共享台账的任期面：{managerTerm, manager:{instanceId,sessionId,identityName,term}|null, version, managerWindow?}。
 * 入参帧须先过协议层形态校验；本模块只做受理语义判定。
 *
 * ctx 接线契约（缺省一律按拒绝/不采纳处理，防止接线漏传导致 fail-open）：
 * - now：本地毫秒时刻，窗口与超时比较；缺省 Date.now()。
 * - localFrozen：null | manager-offline | manager-pending | manager-fork；缺省视为活跃。
 * - memberSeats 或 isMemberSeat：A3/A4 与 offline catch-up 的成员资格；缺省 → source-not-member。
 * - managerReachable:false / managerDeparted:true：A4 站长不可达证据；缺省 → manager-reachability-unknown。
 *   只有探测完成/已判离席才可传，不得把该字段的缺省值当成 false 传入。
 * - autoOffers / autoOffer：A2 本地 offer 记录；缺省 → auto-offer-missing 并请求快照走 A10。
 * - autoInFlight：A4 未解决 auto 在途；缺省 false。
 * - pendingOfferId / pendingTarget：manager-pending 正在等待的 offer/目标；缺省 → pending-offer-mismatch。
 * - acceptedManager：{term,manager,source}——本核按 A1–A4 采纳过的更高 term manager；source 为受理该变更的
 *   签发席位。只用于更高 term 快照 catch-up，且快照来源必须等于 source；同 term 快照不认该记录。
 * - handshakeHighest：{term,version,manager}——本轮 handshake 最高 pair；offline catch-up 缺省 → 冻结。
 * - authorizedEvidence：{via,authorizedAt,term,manager}——fork 收敛证据，必须绑定快照；缺省/不匹配 → 保持冻结。
 * - pendingCatchupExpired / rejectedChangeFrom：快照先到的超时/已拒变更证据；缺省保持 pending（接线须在超时后置位）。
 * - suspended / handoverTarget：显式移交等待中的目标席位；缺省 → 不按 handover-pending 受理。
 * - windowBaseAt：本地开窗生效时刻（§2A.6 收敛基准）；缺省退回绝对 endsAt 并封顶。
 * - sessionTakeoverWindowMs / windowSkewMs：窗口配置；缺省 60000 / 10000。
 * - ledgerDigestOf(ledger) 或 digestVerified:true：快照完整性唯一入口；digestVerified 只能由已重算 digest 的接线置位。
 * - from：快照入口的传输对端席位（帧无 from 时）；manager-changed 必须自带 from。
 * - syncExpired：A6 对表超时。
 * 快照的 auto 追赶三证据只从 frame.ledger.events 读取（auto-offer、via=auto 的 manager-changed、旧站长 leave），
 * 不接受外部 ctx 拼装；事件形态见 hasAutoCatchupEvidence。
 *
 * 返回的 actions 由接线层执行：adopt / request-snapshot / open-window / close-window / clear-freeze /
 * freeze / report / handshake / ack / ack-snapshot-stored / store-pending-catchup / count-reject。 */

import { isManagerTerm } from '../net/protocol.js';

/* 快照排序判据在名单内核已实现（按 (managerTerm,version)；同 term 不同 manager 报冲突）；
 * 任期模块复用同一出口，避免两份排序逻辑分叉。 */
export { compareSnapshot } from './model.js';

const isTerm = isManagerTerm;
const CHANGE_VIAS = ['handover', 'auto', 'takeover', 'takeover-manual'];
const AUTO_CATCHUP_LEAVE_REASON = 'manager-session-closed';
const MANAGER_FORK = 'manager-fork';
const DEFAULT_WINDOW_MS = 60000;
const DEFAULT_WINDOW_SKEW_MS = 10000;

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

function isVersion(value) {
  return Number.isInteger(value) && value >= 1;
}

function timeOf(value) {
  return typeof value === 'string' ? Date.parse(value) : Number.NaN;
}

function nowOf(ctx) {
  return Number.isFinite(ctx.now) ? ctx.now : Date.now();
}

/* 调用方既可能传 ctx（sessionTakeoverWindowMs），也可能传 helper 选项（windowMs）；
 * 两个名字都认，避免配置窗口 >60s 时被静默回落成默认值。 */
function windowMsOf(options) {
  const direct = Number.isFinite(options.windowMs) ? options.windowMs : undefined;
  const configured = Number.isFinite(options.sessionTakeoverWindowMs) ? options.sessionTakeoverWindowMs : undefined;
  const value = direct === undefined ? configured : direct;
  return value !== undefined && value > 0 ? value : DEFAULT_WINDOW_MS;
}

function skewMsOf(options) {
  const direct = Number.isFinite(options.skewMs) ? options.skewMs : undefined;
  const configured = Number.isFinite(options.windowSkewMs) ? options.windowSkewMs : undefined;
  const value = direct === undefined ? configured : direct;
  return value !== undefined && value >= 0 ? value : DEFAULT_WINDOW_SKEW_MS;
}

function sameSeat(left, right) {
  return isRef(left) && isRef(right)
    && left.instanceId === right.instanceId
    && left.sessionId === right.sessionId;
}

/* 时间戳按毫秒比较：协议接受多种可解析格式，同一时刻的不同序列化不应判成分叉。 */
function sameWindow(left, right) {
  return isPlainObject(left) && isPlainObject(right)
    && left.windowBaseTerm === right.windowBaseTerm
    && Number.isFinite(timeOf(left.windowEndsAt))
    && timeOf(left.windowEndsAt) === timeOf(right.windowEndsAt);
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
  return isChangeSeatShape(frame) && isChangeEvidenceShape(frame);
}

function isChangeSeatShape(frame) {
  return isTerm(frame.term) && isVersion(frame.version) && isPeer(frame.manager)
    && isRef(frame.prevManager) && isRef(frame.from);
}

function isChangeEvidenceShape(frame) {
  return typeof frame.digest === 'string' && frame.digest !== ''
    && isPlainObject(frame.endpoint) && Number.isFinite(timeOf(frame.effectiveAt));
}

function sourceOf(frame, ctx) {
  if (isRef(frame.from)) {
    return frame.from;
  }
  return isRef(ctx.from) ? ctx.from : null;
}

function accepted(nextState, reason, actions, extra = {}) {
  return { accepted: true, nextState, actions, reason, ...extra };
}

function rejected(state, reason, extra = {}) {
  const { actions = ['count-reject'], ...rest } = extra;
  return { accepted: false, nextState: state, actions, reason, ...rest };
}

function idempotent(state, reason, actions) {
  return { accepted: false, nextState: state, actions, reason, idempotent: true };
}

/* 冻结只作为判决结果返回：状态形态不含冻结字段，由接线层把 freezeReason 落到协作共享态。
 * 冻结结论同时是「拒收」，故 actions 带上计数（A5 要求「拒收并计数」）。 */
function frozen(state, reason) {
  return { accepted: false, nextState: state, actions: ['count-reject', 'freeze', 'report'], reason, freezeReason: MANAGER_FORK };
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
    manager: snapshot.manager === null ? null : managerSeatOf(snapshot.manager, snapshot.managerTerm),
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
  const window = ledger.managerWindow;
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
  if (!isTerm(ledger.managerTerm) || !isVersion(ledger.version)) {
    return false;
  }
  if (ledger.manager !== null && !isPeer(ledger.manager)) {
    return false;
  }
  return ledger.managerTerm === frame.managerTerm && ledger.version === frame.version;
}

/* 帧窗口与台账窗口必须同源：design §2A.1 要求 managerWindow 与帧一致，
 * 不一致按损坏拒收；只在一侧出现同样视为损坏，不能拿帧窗口去补台账。 */
function snapshotWindowCorrupt(frame) {
  const ledgerWindow = frame.ledger.managerWindow;
  const frameWindow = frame.managerWindow;
  if (ledgerWindow === undefined && frameWindow === undefined) {
    return false;
  }
  if (ledgerWindow === undefined || frameWindow === undefined) {
    return true;
  }
  return !sameWindow(ledgerWindow, frameWindow);
}

/* 快照携带的窗口同样受 1 分钟纠错窗约束：远期 windowEndsAt 视为损坏，
 * 防止「同 term 快照不改 term 但把窗口挪到远期」。 */
function snapshotWindowProblem(snapshot, ctx) {
  if (snapshot.managerWindow === undefined) {
    return null;
  }
  const endsAt = timeOf(snapshot.managerWindow.windowEndsAt);
  return endsAt - nowOf(ctx) > windowMsOf(ctx) + skewMsOf(ctx) ? 'snapshot-window-invalid' : null;
}

/* 快照完整性（设计 §2A.1/A1）：digest 由接收方重算，纯判定层只接受显式验证结果；
 * 未提供验证器/未标记已验证的台账不得采纳（fail-closed）。 */
function snapshotDigestVerified(frame, ctx) {
  if (ctx.digestVerified === true) {
    return true;
  }
  if (typeof ctx.ledgerDigestOf !== 'function') {
    return false;
  }
  return ctx.ledgerDigestOf(frame.ledger) === frame.digest;
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
  if (state.manager === null) {
    return rejected(state, 'no-local-manager');
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
  const frozenBlock = changeFrozenBlock(state, frame, ctx);
  if (frozenBlock !== null) {
    return frozenBlock;
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
 * manager-pending 只接受本核在等的那一份 auto offer/目标，不得换目标（设计 §2A.5⑤）。 */
function changeFrozenBlock(state, frame, ctx) {
  if (ctx.localFrozen === 'manager-fork') {
    return rejected(state, 'frozen-manager-fork');
  }
  if (ctx.localFrozen === 'manager-pending') {
    if (frame.via !== 'auto') {
      return rejected(state, 'frozen-manager-pending');
    }
    if (!matchesPendingOffer(frame, ctx)) {
      return rejected(state, 'pending-offer-mismatch');
    }
  }
  return null;
}

function matchesPendingOffer(frame, ctx) {
  const hasOfferId = typeof ctx.pendingOfferId === 'string' && ctx.pendingOfferId !== '';
  const hasTarget = isRef(ctx.pendingTarget);
  if (!hasOfferId && !hasTarget) {
    return false;
  }
  if (hasOfferId && frame.offerId !== ctx.pendingOfferId) {
    return false;
  }
  return !hasTarget || sameSeat(frame.manager, ctx.pendingTarget);
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
    if (ctx.localFrozen === 'manager-pending') {
      return rejected(state, 'manager-pending-timeout', { actions: ['report'] });
    }
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
  const windowProblem = autoWindowProblem(frame, ctx);
  if (windowProblem !== null) {
    return rejected(state, windowProblem);
  }
  if (!hasMatchingAutoOffer(ctx, frame)) {
    /* 没收到 auto-offer 的节点不凭本帧改任期：拉快照走 A10 台账追赶（设计 A2 的回退面）。 */
    return rejected(state, 'auto-offer-missing', { actions: ['count-reject', 'request-snapshot'] });
  }
  const window = { windowBaseTerm: frame.term, windowEndsAt: frame.windowEndsAt };
  const remaining = managerWindowRemaining(window, nowOf(ctx), {
    windowMs: windowMsOf(ctx),
    skewMs: skewMsOf(ctx),
    baseAt: timeOf(frame.effectiveAt),
  });
  const actions = ['adopt', 'open-window', 'request-snapshot', ...freezeNote(ctx)];
  return accepted(stateFromChange(frame, window), 'auto-accepted', actions, { windowRemaining: remaining });
}

/* 签发者给出的窗口不得超过配置时长 + 允许偏斜；远期 windowEndsAt 一律按坏帧拒收，
 * 否则「1 分钟纠错窗」会被签发者任意延长（设计 §2A.6）。 */
function autoWindowProblem(frame, ctx) {
  const effectiveAt = timeOf(frame.effectiveAt);
  const endsAt = timeOf(frame.windowEndsAt);
  if (!Number.isFinite(endsAt)) {
    return 'window-missing';
  }
  if (endsAt <= effectiveAt) {
    return 'window-invalid';
  }
  if (effectiveAt > nowOf(ctx) + skewMsOf(ctx)) {
    return 'window-invalid';
  }
  return endsAt - effectiveAt > windowMsOf(ctx) + skewMsOf(ctx) ? 'window-invalid' : null;
}

function acceptTakeover(state, frame, ctx) {
  const source = sourceOf(frame, ctx);
  if (!sameSeat(source, frame.manager)) {
    return frozen(state, 'takeover-source-not-manager');
  }
  if (!isMemberSource(ctx, source)) {
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
  if (!windowAcceptsTakeover(state.managerWindow, frame.authorizedAt, ctx)) {
    return rejected(state, 'window-closed');
  }
  return accepted(stateFromChange(frame), 'takeover-accepted', adoptActions(state, freezeNote(ctx)));
}

function acceptTakeoverManual(state, frame, ctx) {
  const source = sourceOf(frame, ctx);
  if (!sameSeat(source, frame.manager)) {
    return frozen(state, 'takeover-manual-source-not-manager');
  }
  const blockReason = manualBlockReason(state, ctx);
  if (blockReason !== null) {
    return rejected(state, blockReason);
  }
  if (!isMemberSource(ctx, source)) {
    return frozen(state, 'source-not-member');
  }
  if (!Number.isFinite(timeOf(frame.authorizedAt))) {
    return rejected(state, 'authorized-at-missing');
  }
  if (ctx.managerReachable === true) {
    return rejected(state, 'manager-reachable');
  }
  if (!managerDownEvidence(ctx)) {
    return rejected(state, 'manager-reachability-unknown');
  }
  return accepted(
    stateFromChange(frame),
    'takeover-manual-accepted',
    adoptActions(state, freezeNote(ctx)),
  );
}

/* 手动接管的前提是站长不可达（本地冻结、探测不可达或已判离席），「本地已冻结」不是受理前提。
 * 可达性证据缺失时拒绝（fail-closed），由接线层补探测后再发起。 */
function managerDownEvidence(ctx) {
  return ctx.managerReachable === false || ctx.managerDeparted === true || ctx.localFrozen === 'manager-offline';
}

/* 只拦与当前任期相关、尚未过期的 auto 在途；上一任期残留的 offer 不阻塞手动接管。 */
function manualBlockReason(state, ctx) {
  if (ctx.autoInFlight === true || hasUnexpiredAutoOffer(state, ctx)) {
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
  return false;
}

/* §2A.6：窗口以签发时长为本，偏移按事件时刻收敛；回拨/远期窗口都不得延长纠错窗。
 * baseAt 由接线层取自签发帧 effectiveAt（或本地开窗时刻）；缺失时退回绝对 endsAt 并封顶。 */
function windowAcceptsTakeover(window, authorizedAt, ctx) {
  const endsAt = timeOf(window.windowEndsAt);
  const nowMs = nowOf(ctx);
  const windowMs = windowMsOf(ctx);
  const skewMs = skewMsOf(ctx);
  const remaining = managerWindowRemaining(window, nowMs, {
    windowMs,
    skewMs,
    baseAt: ctx.windowBaseAt,
  });
  if (remaining > 0 && endsAt - nowMs <= windowMs + skewMs) {
    return true;
  }
  const authorizedAtMs = timeOf(authorizedAt);
  return Number.isFinite(authorizedAtMs)
    && authorizedAtMs <= endsAt
    && authorizedAtMs <= nowMs + skewMs
    && endsAt - authorizedAtMs <= windowMs + skewMs;
}

function acceptSnapshot(state, frame, ctx) {
  const snapshot = snapshotStateOf(frame);
  if (!isStateShape(state) || snapshot === null) {
    return rejected(state, 'frame-invalid');
  }
  const precheck = snapshotPrecheck(state, frame, snapshot, ctx);
  if (precheck !== null) {
    return precheck;
  }
  if (snapshot.manager === null) {
    return acceptTerminalSnapshot(state, snapshot, frame, ctx);
  }
  if (state.manager === null) {
    return rejected(state, 'no-local-manager');
  }
  return acceptNonTerminalSnapshot(state, snapshot, frame, ctx);
}

function snapshotPrecheck(state, frame, snapshot, ctx) {
  if (snapshotWindowCorrupt(frame)) {
    return rejected(state, 'snapshot-corrupt');
  }
  if (!snapshotDigestVerified(frame, ctx)) {
    return rejected(state, 'digest-unverified');
  }
  const windowProblem = snapshotWindowProblem(snapshot, ctx);
  return windowProblem === null ? null : rejected(state, windowProblem);
}

function acceptNonTerminalSnapshot(state, snapshot, frame, ctx) {
  if (snapshot.managerTerm < state.managerTerm) {
    return rejected(state, 'term-behind');
  }
  if (snapshot.managerTerm === state.managerTerm) {
    return acceptSameTermSnapshot(state, snapshot, frame, ctx);
  }
  const frozenResult = snapshotFrozenResult(state, snapshot, frame, ctx);
  if (frozenResult !== null) {
    return frozenResult;
  }
  return acceptHigherSnapshot(state, snapshot, frame, ctx);
}

/* 终态台账（manager:null）允许参与收敛（设计 §3.4 / D17）：本地活跃时只接受 term+1 且来源为成员，
 * 本地已终态时按 version 幂等/推进；同 term 活跃→终态视为分叉，不做静默改写。 */
function acceptTerminalSnapshot(state, snapshot, frame, ctx) {
  if (snapshot.managerTerm < state.managerTerm) {
    return rejected(state, 'term-behind');
  }
  if (snapshot.managerTerm === state.managerTerm) {
    if (state.manager !== null) {
      return frozen(state, 'snapshot-same-term-conflict');
    }
    return terminalVersionResult(state, snapshot);
  }
  if (state.manager === null) {
    return terminalVersionResult(state, snapshot);
  }
  if (snapshot.managerTerm !== state.managerTerm + 1) {
    return frozen(state, 'snapshot-untrusted-higher-term');
  }
  if (!isMemberSource(ctx, sourceOf(frame, ctx))) {
    return rejected(state, 'source-not-member');
  }
  const actions = state.managerWindow === undefined ? ['adopt'] : ['adopt', 'close-window'];
  return accepted(terminalNextState(snapshot), 'snapshot-terminal-accepted', actions);
}

function terminalVersionResult(state, snapshot) {
  if (snapshot.version < state.version) {
    return rejected(state, 'version-behind');
  }
  if (snapshot.version === state.version) {
    return idempotent(state, 'snapshot-idempotent', ['ack-snapshot-stored']);
  }
  return accepted(terminalNextState(snapshot), 'snapshot-terminal-accepted', ['adopt']);
}

function terminalNextState(snapshot) {
  return { managerTerm: snapshot.managerTerm, manager: null, version: snapshot.version };
}

/* 同 term 快照只允许现任站长 / 已受理过的新站长签发；窗口以本地为准：
 * 快照未带窗口时保留本地窗口，快照窗口与本地不同视为台账分叉，绝不静默改写（A11/A12）。 */
function acceptSameTermSnapshot(state, snapshot, frame, ctx) {
  const frozenBlock = sameTermSnapshotFrozen(state, ctx);
  if (frozenBlock !== null) {
    return frozenBlock;
  }
  if (!sameSeat(snapshot.manager, state.manager)) {
    return frozen(state, 'snapshot-same-term-conflict');
  }
  if (!sameTermSnapshotSourceAllowed(state, frame, ctx)) {
    return rejected(state, 'snapshot-source-not-manager');
  }
  const windowResult = sameTermWindowOf(state, snapshot);
  if (windowResult.conflict) {
    return frozen(state, 'snapshot-window-conflict');
  }
  if (snapshot.version < state.version) {
    return rejected(state, 'version-behind');
  }
  if (snapshot.version === state.version) {
    return idempotent(state, 'snapshot-idempotent', ['ack-snapshot-stored']);
  }
  return accepted(sameTermSnapshotState(state, snapshot, windowResult.window), 'snapshot-version-accepted', ['adopt']);
}

function sameTermSnapshotFrozen(state, ctx) {
  if (ctx.localFrozen === 'manager-fork') {
    return rejected(state, 'frozen-manager-fork');
  }
  if (ctx.localFrozen === 'manager-pending') {
    return rejected(state, 'frozen-manager-pending');
  }
  return null;
}

/* 同 term 名单快照只认现任站长席位（offline 冻结时按 §7.1 放行名单成员做 catch-up）；
 * 不接受 acceptedManager 之类的历史授权——同 term 的高 version 必须由当前站长自己签发。 */
function sameTermSnapshotSourceAllowed(state, frame, ctx) {
  const source = sourceOf(frame, ctx);
  if (sameSeat(source, state.manager)) {
    return true;
  }
  if (ctx.localFrozen === 'manager-offline') {
    return isMemberSource(ctx, source);
  }
  return false;
}

function sameTermWindowOf(state, snapshot) {
  const local = state.managerWindow;
  if (local === undefined) {
    return { window: undefined, conflict: false };
  }
  if (snapshot.managerWindow === undefined) {
    return { window: local, conflict: false };
  }
  if (sameWindow(local, snapshot.managerWindow)) {
    return { window: local, conflict: false };
  }
  return { window: undefined, conflict: true };
}

function sameTermSnapshotState(state, snapshot, window) {
  return {
    managerTerm: state.managerTerm,
    manager: { ...state.manager },
    version: snapshot.version,
    ...(window === undefined ? {} : { managerWindow: { ...window } }),
  };
}

function snapshotFrozenResult(state, snapshot, frame, ctx) {
  switch (ctx.localFrozen) {
    case 'manager-offline': {
      return acceptOfflineCatchup(state, snapshot, frame, ctx);
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

function acceptOfflineCatchup(state, snapshot, frame, ctx) {
  if (!isMemberSource(ctx, sourceOf(frame, ctx))) {
    return rejected(state, 'source-not-member');
  }
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

/* 分叉冻结只接受能收敛到快照本身的授权证据：证据的 term/manager 必须与快照一致，
 * 不能拿一份陈旧或别处的授权去解锁另一份快照（设计 §2A.10 不变量 5）。 */
function acceptForkedCatchup(state, snapshot, ctx) {
  if (authorizedEvidenceMatches(ctx.authorizedEvidence, snapshot)) {
    return accepted(snapshotNextState(snapshot), 'snapshot-authorized-accepted', ['adopt', 'clear-freeze']);
  }
  return rejected(state, 'frozen-manager-fork');
}

function authorizedEvidenceMatches(evidence, snapshot) {
  return isPlainObject(evidence)
    && (evidence.via === 'takeover' || evidence.via === 'takeover-manual')
    && Number.isFinite(timeOf(evidence.authorizedAt))
    && evidence.term === snapshot.managerTerm
    && sameSeat(evidence.manager, snapshot.manager);
}

function acceptHigherSnapshot(state, snapshot, frame, ctx) {
  const source = sourceOf(frame, ctx);
  if (sameSeat(source, state.manager)) {
    return accepted(snapshotNextState(snapshot), 'snapshot-manager-accepted', ['adopt']);
  }
  if (isAcceptedManagerSeat(ctx.acceptedManager, snapshot, source)) {
    return accepted(snapshotNextState(snapshot), 'snapshot-accepted-manager-accepted', ['adopt']);
  }
  if (handoverPendingMatches(ctx, source, snapshot)) {
    return accepted(snapshotNextState(snapshot), 'snapshot-handover-accepted', ['adopt']);
  }
  if (hasAutoCatchupEvidence(state, snapshot, source, frame)) {
    return accepted(snapshotNextState(snapshot), 'snapshot-auto-catchup-accepted', ['adopt']);
  }
  return pendingOrFrozenSnapshot(state, snapshot, source, ctx);
}

/* acceptedManager 必须绑定来源席位：记录里没有 source 或来源不符一律不认，
 * 防止任意成员借历史记录给同 term/更高 term 快照背书。 */
function isAcceptedManagerSeat(value, snapshot, source) {
  return isPlainObject(value)
    && value.term === snapshot.managerTerm
    && sameSeat(value.manager, snapshot.manager)
    && isRef(value.source)
    && sameSeat(value.source, source);
}

/* 显式移交等待中只向在途 offer 的目标取台账；来源/快照 manager 都必须等于该目标。 */
function handoverPendingMatches(ctx, source, snapshot) {
  const target = handoverPendingTarget(ctx);
  return target !== null && sameSeat(source, target) && sameSeat(snapshot.manager, target);
}

function handoverPendingTarget(ctx) {
  if (ctx.suspended === 'handover-pending') {
    return isRef(ctx.handoverTarget) ? ctx.handoverTarget : null;
  }
  if (isPlainObject(ctx.suspended) && ctx.suspended.state === 'handover-pending') {
    return isRef(ctx.suspended.target) ? ctx.suspended.target : null;
  }
  return null;
}

/* 离线错过 auto-offer 的追赶路径（设计 §2A.2 A10）：三证据必须来自快照台账自身
 * （frame.ledger.events，随 digest 一起受完整性校验），不能由外部 ctx 拼装：
 * auto-offer 的 baseTerm/prevManager/target、via=auto 的 manager-changed、旧站长 leave/manager-session-closed。
 * 同时要求任期连续（快照 term=本地+1），term 跳变交由 handshake 对表。 */
function hasAutoCatchupEvidence(state, snapshot, source, frame) {
  if (snapshot.managerTerm !== state.managerTerm + 1) {
    return false;
  }
  if (!sameSeat(source, snapshot.manager)) {
    return false;
  }
  const events = ledgerEventsOf(frame);
  const offer = events.find((event) => eventTypeOf(event) === 'auto-offer'
    && autoOfferEventMatches(event, state, snapshot));
  if (offer === undefined) {
    return false;
  }
  const change = events.find((event) => eventTypeOf(event) === 'manager-changed'
    && autoChangeEventMatches(event, state, snapshot, offer));
  if (change === undefined) {
    return false;
  }
  return events.some((event) => leaveEventMatches(event, state.manager));
}

function ledgerEventsOf(frame) {
  const events = isPlainObject(frame.ledger) ? frame.ledger.events : undefined;
  return Array.isArray(events) ? events : [];
}

function eventTypeOf(event) {
  return isPlainObject(event) ? (event.type ?? event.event) : undefined;
}

function autoOfferEventMatches(event, state, snapshot) {
  return event.baseTerm === state.managerTerm
    && sameSeat(event.prevManager, state.manager)
    && sameSeat(event.target, snapshot.manager);
}

function autoChangeEventMatches(event, state, snapshot, offer) {
  return event.via === 'auto'
    && event.offerId === offer.offerId
    && event.term === snapshot.managerTerm
    && sameSeat(event.prevManager, state.manager)
    && sameSeat(event.manager, snapshot.manager);
}

function leaveEventMatches(event, seat) {
  if (!isPlainObject(event) || event.reason !== AUTO_CATCHUP_LEAVE_REASON) {
    return false;
  }
  return sameSeat(isPlainObject(event.seat) ? event.seat : event, seat);
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

function hasUnexpiredAutoOffer(state, ctx) {
  const nowMs = nowOf(ctx);
  return autoOffersOf(ctx).some((offer) => timeOf(offer?.expiresAt) > nowMs
    && offer.baseTerm === state.managerTerm
    && sameSeat(offer.prevManager, state.manager));
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
  return nowOf({ now }) >= endsAt;
}

export function setManagerWindow(state, window) {
  return { ...state, managerWindow: { ...window } };
}

export function clearManagerWindow(state) {
  const next = { ...state };
  delete next.managerWindow;
  return next;
}

/* 剩余时长：给了 baseAt 就按 §2A.6 的 elapsed clamp 公式；否则退回绝对 endsAt。
 * 两条路径都封顶 windowMs + skew，墙钟回拨不能把剩余窗口拉长到超过一个纠错窗。 */
export function managerWindowRemaining(window, now, options = {}) {
  if (!isWindowShape(window) || !Number.isFinite(now)) {
    return 0;
  }
  const windowMs = windowMsOf(options);
  const skewMs = skewMsOf(options);
  const endsAt = timeOf(window.windowEndsAt);
  const byEnd = Math.max(0, endsAt - now);
  const baseAt = Number.isFinite(options.baseAt) ? options.baseAt : Number.NaN;
  if (Number.isFinite(baseAt)) {
    const elapsed = Math.min(Math.max(now - baseAt, 0), windowMs + skewMs);
    return Math.min(Math.max(0, windowMs - elapsed), byEnd);
  }
  return Math.min(byEnd, windowMs + skewMs);
}
