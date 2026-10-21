import { collabDir } from '../paths.js';
import { listLocalCollabIds, loadLedger, loadMember, loadSnapshot, quarantineLedger } from './store.js';
import { isArchived, withDefaultMode } from './model.js';
import { CARRIER_FORMAT_SESSION_SEATS, readCarrier, readCarrierFormat, writeCarrier } from './carrier.js';
import { assertWritable, classifyCollabDir, createLegacyRejectionCounter, markLegacyCompleted, readLegacyCollab } from './legacy.js';
import { writeRecovery } from './migration.js';
import {
  hasActiveSeat, listLocalSeatsOf, loadSeats, localSeatOfLocal, managerSeatOfLocal, seatsOfLocal,
  removeLocalSeat, syncLocalRole, upsertLocalSeat,
} from './local.js';
import { createPostsStore } from './posts.js';
import { createMembersStore } from './members.js';
import { createCounterStore, notifyIndicatorChange } from './counter.js';
import { createMuteStore, muteSuppresses } from './mute.js';
import { createInjectedStore } from './injected.js';
import { createJoinsStore } from './joins.js';
import { grantInviteWaiver } from './consent.js';
import { JOIN_REQUEST_RETRY_MAX_MS, JOIN_REQUEST_RETRY_MS, JOIN_REQUEST_TTL_MS, createJoinDomain, resolveJoinTarget } from './join.js';
import { ID_PATTERN, POST_KINDS } from '../net/protocol.js';
import { shortSessionId } from '../util/short-id.js';
import { decideAdmission, SYNC_REQUEST_MAX, SYNC_REQUEST_WINDOW_MS } from './gate.js';
import { handleEvent } from './events.js';
import { localModeOf, localNameOf, localRosterOf, localStateOf, localTopicOf, persistLedger } from './local.js';
import { applyRelayedReport, approveInvite, contentCountOf, countLiveCollabs, createCollab, endCollab, handleJoinKnock, inviteMembers, leaveCollab, notifyLocal, sendMessage, viewLedger, withdrawInvite } from './outgoing.js';
import { JOIN_REPLAY_INTERVALS_MS, SYNC_MAX_REQUESTS_PER_CYCLE, SYNC_MAX_SOURCES_PER_CYCLE, SYNC_REPLY_TIMEOUT_MS, SYNC_SOFT_BUNDLE_BYTES, SYNC_TAIL_POSTS, SYNC_TAIL_WINDOW_MS, runSyncCycle, runSyncSweep, startSyncEngine, stopSyncEngine, triggerSync } from './sync.js';
import { HANDSHAKE_REPLY_TIMEOUT_MS, TAKEOVER_PROBE_INTERVAL_MS, runHandshake, startLiveness, stopLiveness, takeOver } from './takeover.js';
import { decide, decideMergeOffer } from './freeze.js';
import { HANDOVER_CONFIRM_TIMEOUT_MS, handover } from './handover.js';

/* 协作服务（协作核心与治理的门面）：注册表加载与恢复、公共 API、接收管线钩子
 * （admit / consume / sessionGate / sessionDelivered）装配、探测定时器与握手生命周期、
 * 抢接 / 裁定 / 移交的等待面、计数器。
 * 钩子、事件与定时器路径一律不抛出（健壮性硬性要求）——异常隔离为计数与告警。
 * 依赖全部经参数注入（send = dispatch.send；probe = dispatch.ping；reassign = dispatch.reassignPeer；
 * notify = 会话注入面；knownHosts 供「协作参与者地址」一源接入）。 */

const LEDGER_FETCH_TIMEOUT_MS = 3000;
const INVITE_MIN_INTERVAL_MS = 1000;

/* 席位宽限与本地暂存（设计 §3.2/§5.5/§11）：配置权威在 config；缺省值与配置默认一致，
 * 便于不构造完整配置的既有单测路径。 */
const DEFAULT_SEAT_GRACE_MS = 60000;
const DEFAULT_STAGED_PER_SEAT = 100;
const DEFAULT_STAGED_PER_COLLAB = 500;
/* 核心空闲退出必须晚于席位宽限：先完成离席广播/标记再退出（设计 §3.2）。 */
export const SEAT_GRACE_MARGIN_MS = 10000;
/* 席位 inbox 只保留近期投递事实（运行态观测面；落盘 inbox.jsonl 归 M3）。 */
const SEAT_INBOX_MAX = 200;

/**
 * @param {{ dataDir: string, config: any, self: any, send: (message: object) => any, knownHosts: any, log: any,
 *   probe?: ((address: string, port: number) => Promise<{ reachable: boolean, rttMs?: number, reason?: string }>) | null,
 *   reassign?: ((payload: object) => { ok: boolean, moved?: number, reason?: string }) | null,
 *   notify?: ((frame: object) => unknown) | null,
 *   deliverSeat?: ((frame: object, seat: any) => Promise<boolean> | boolean) | null,
 *   sendDirect?: ((message: object) => { ok: boolean, msgId?: string, tier?: string, reason?: string }) | null,
 *   onIndicatorChange?: (() => void) | null,
 *   openViewer?: ((ref: { root: string | null, id: string }) => unknown) | null,
 *   viewerRoot?: string | null,
 *   ledgerFetchTimeoutMs?: number, inviteMinIntervalMs?: number, takeoverProbeIntervalMs?: number,
 *   handshakeReplyTimeoutMs?: number, handoverConfirmTimeoutMs?: number,
 *   pullReplyTimeoutMs?: number, syncMaxRequestsPerCycle?: number, syncMaxSourcesPerCycle?: number,
 *   syncSoftBundleBytes?: number, syncTailPosts?: number, syncTailWindowMs?: number,
 *   syncPeerPicker?: ((context: { collabId: string, candidates: string[] }) => string[] | null) | null,
 *   syncRequestWindowMs?: number, syncRequestMax?: number, joinReplayIntervalsMs?: number[],
 *   bindings?: { set: (collabId: string, binding: object) => unknown, get: (collabId: string) => any,
 *     entries: () => Array<[string, any]> } | null,
 *   bridgeIdOf?: ((sessionId: string) => string | null) | null,
 *   requestJoin?: ((options: object) => Promise<any>) | null,
 *   requestJoinResolve?: ((options: object) => Promise<any>) | null,
 *   joinRequestRetryMs?: number, joinRequestRetryMaxMs?: number, now?: () => number }} options
 */
export function createCollabService(options) {
  const state = /** @type {any} */ (buildState(options));
  /* 出站/入站模块（M3）经 state 直取的本机旁路面：与 API 同源，避免两套注入入口。 */
  state.injectLocalSeat = (collabId, sessionId, frame) => injectLocalSeatOf(state, collabId, sessionId, frame);
  state.listLocalSeats = (collabId) => {
    const local = state.collabs.get(collabId);
    return local === undefined ? [] : listLocalSeatsOf(local);
  };
  state.join = createJoinDomain({
    state,
    send: joinSenderOf(state),
    openViewer: state.openViewer,
    log: state.log,
    now: state.clock,
  });
  loadRegistry(state);
  return apiOf(state);
}

/* 加入域的发送面（设计 §2）：直投优先——申请与回执不进 outbox 长队列（申请时限短于队列保留期，
 * 且重发轮由加入域按短节律自理）。直投面未注入＝发送面缺失（加入域如实报错，不静默改走长队列）。 */
function joinSenderOf(state) {
  return typeof state.sendDirect === 'function' ? state.sendDirect : null;
}

function buildState(options) {
  return {
    ...coreStateOf(options),
    ...syncStateOf(options),
    ...joinStateOf(options),
    ...seatStateOf(options),
    ...runtimeMaps(),
    join: /** @type {any} */ (null),   // 加入域实例（构造步挂上；形态由加入域自定）
    onIndicatorChange: options.onIndicatorChange ?? null,
    probeTimer: null,
    syncTimer: null,
    started: false,
    counters: emptyCounters(),
  };
}

/* 席位运行态（设计 §1.2）：宽限/暂存上限、桥注册表（sessionId → bridgeId）、旧协作与只读目录视图。 */
function seatStateOf(options) {
  return {
    seatGraceMs: options.config?.sessionSeatGraceMs ?? DEFAULT_SEAT_GRACE_MS,
    stagedMaxPerSeat: options.config?.stagedMaxPerSeat ?? DEFAULT_STAGED_PER_SEAT,
    stagedMaxPerCollab: options.config?.stagedMaxPerCollab ?? DEFAULT_STAGED_PER_COLLAB,
    /* 本机旁路的交付适配器（组合根接入注入路由；未注入＝只能暂存，重连补投时再交付）。 */
    deliverSeat: pickOption(options, 'deliverSeat', null),
    sessionBridges: new Map(),   // sessionId → 当前桥标识（邀请补投与桥注册面共用）
    legacyViews: new Map(),      // collabId → readLegacyCollab 摘要（只读）
    readonlyCollabs: new Map(),  // collabId → { reason }（recovery / 半写）
    writableCollabs: new Set(),  // 已判定可写的协作（只读是终态；避免每帧重复读标记文件）
    legacyRejections: createLegacyRejectionCounter(),
    stagedSeq: 0,   // 暂存到达序（跨席位「丢最旧」的判据）
  };
}

/* 既有面状态（缺省值见各模块顶部常量：ledger/invite/takeover/handover 超时）。 */
function coreStateOf(options) {
  return {
    dataDir: options.dataDir,
    config: options.config,
    self: options.self,
    send: options.send,
    sendDirect: options.sendDirect ?? null,
    knownHosts: options.knownHosts,
    log: options.log,
    probe: options.probe ?? null,
    reassign: options.reassign ?? null,
    notify: options.notify ?? null,
    /* 观察窗自动打开（触发 A）：组合根注入的拉起钩子与本站点根（观察窗 URL 里的 main/s<k>）——
     * 钩子不抛出、开关在钩子出口内现读；本层只传 ref＝{ root, id }。 */
    openViewer: pickOption(options, 'openViewer', null),
    viewerRoot: pickOption(options, 'viewerRoot', null),
    ledgerFetchTimeoutMs: options.ledgerFetchTimeoutMs ?? LEDGER_FETCH_TIMEOUT_MS,
    inviteMinIntervalMs: options.inviteMinIntervalMs ?? INVITE_MIN_INTERVAL_MS,
    takeoverProbeIntervalMs: options.takeoverProbeIntervalMs ?? TAKEOVER_PROBE_INTERVAL_MS,
    handshakeReplyTimeoutMs: options.handshakeReplyTimeoutMs ?? HANDSHAKE_REPLY_TIMEOUT_MS,
    handoverConfirmTimeoutMs: options.handoverConfirmTimeoutMs ?? HANDOVER_CONFIRM_TIMEOUT_MS,
  };
}

/* 讨论对表与 join 重播面的构造选项（数值默认见 sync.js / gate.js 常量；测试经选项收敛）。 */
function syncStateOf(options) {
  return {
    pullReplyTimeoutMs: pickOption(options, 'pullReplyTimeoutMs', SYNC_REPLY_TIMEOUT_MS),
    syncMaxRequestsPerCycle: pickOption(options, 'syncMaxRequestsPerCycle', SYNC_MAX_REQUESTS_PER_CYCLE),
    syncMaxSourcesPerCycle: pickOption(options, 'syncMaxSourcesPerCycle', SYNC_MAX_SOURCES_PER_CYCLE),
    syncSoftBundleBytes: pickOption(options, 'syncSoftBundleBytes', SYNC_SOFT_BUNDLE_BYTES),
    syncTailPosts: pickOption(options, 'syncTailPosts', SYNC_TAIL_POSTS),
    syncTailWindowMs: pickOption(options, 'syncTailWindowMs', SYNC_TAIL_WINDOW_MS),
    syncPeerPicker: pickOption(options, 'syncPeerPicker', null),
    syncRequestWindowMs: pickOption(options, 'syncRequestWindowMs', SYNC_REQUEST_WINDOW_MS),
    syncRequestMax: pickOption(options, 'syncRequestMax', SYNC_REQUEST_MAX),
    joinReplayIntervalsMs: pickOption(options, 'joinReplayIntervalsMs', JOIN_REPLAY_INTERVALS_MS),
  };
}

function pickOption(options, key, fallback) {
  return options[key] ?? fallback;
}

/* 加入域（会话级加入）的构造选项：申请时限（配置权威在 config，缺省同邀请时限）、重发节律、
 * 网络注入面（按名解析 / 敲门原语——组合根以闭包接入，运行期才触达）、核心绑定表与桥查取面、
 * 时钟（时限与记录时刻共用同一基准）。 */
function joinStateOf(options) {
  return {
    joinRequestTtlMs: options.config?.joinRequestTtlMs ?? JOIN_REQUEST_TTL_MS,
    joinRequestRetryMs: pickOption(options, 'joinRequestRetryMs', JOIN_REQUEST_RETRY_MS),
    joinRequestRetryMaxMs: pickOption(options, 'joinRequestRetryMaxMs', JOIN_REQUEST_RETRY_MAX_MS),
    bindings: pickOption(options, 'bindings', null),
    bridgeIdOf: pickOption(options, 'bridgeIdOf', null),
    requestJoin: pickOption(options, 'requestJoin', null),
    requestJoinResolve: pickOption(options, 'requestJoinResolve', null),
    clock: pickOption(options, 'now', Date.now),
  };
}

/* 运行期容器（注册表 / 限频 / 转达集 / 等待面 / 抢接与握手 / 对表与 join 重播状态）。 */
function runtimeMaps() {
  return {
    collabs: new Map(),
    inviteWindow: new Map(),
    relayedOrigins: new Map(),
    pendingViews: new Map(),   // 值 = 该协作的等待面列表
    probes: new Map(),
    takeovers: new Map(),
    rearmedTakeovers: new Map(),
    awaitingTakeovers: new Map(),
    effectiveTakeovers: new Map(),
    handshakeWatch: new Map(),
    pendingHandovers: new Map(),
    syncWaiters: new Map(),    // 键 = collabId + 对端实例标识 → 拉取应答等待面
    syncActive: new Set(),     // 在途对表的 collabId（tick 与触发面互不叠加）
    syncRotations: new Map(),  // collabId → 对端轮换游标
    joinReplays: new Map(),    // collabId → { timer, attempts }（join 未收敛重播）
    syncRequestWindow: new Map(),   // 来源地址 → 窗口内请求时刻（请求类入站限流）
    joinRequestWindow: new Map(),   // 来源地址 → 上次受理时刻（加入申请的入站限频，与邀请限频相互独立）
    relayDown: new Set(),      // 中继降级态的 collabId 集（探测不可达置位；恢复检测清除）
    inviteConsent: { challenges: new Map(), waivers: new Map() },   // 邀请决定确认门（挑战 / 一次性豁免，纯内存态）
  };
}

function apiOf(state) {
  return {
    hooks: {
      admit: (frame, meta) => gateFrame(state, frame, meta),
      consume: (frame, meta) => consumeFrame(state, frame, meta),
      sessionGate: (frame, meta) => sessionGateFrame(state, frame, meta),
      sessionDelivered: (frame) => noteSessionDelivered(state, frame),
    },
    start: () => startService(state),
    handshake: (options) => runHandshake(state, options ?? {}),
    takeOver: (input) => forumGovernanceRejection(state, input?.collabId) ?? guardedWrite(state, input?.collabId, () => takeOver(state, input)),
    decide: (input) => forumGovernanceRejection(state, input?.collabId) ?? guardedWrite(state, input?.collabId, () => decide(state, input)),
    decideMerge: (input) => forumGovernanceRejection(state, input?.collabId) ?? guardedWrite(state, input?.collabId, () => decideMergeOffer(state, input)),
    handover: (input) => forumGovernanceRejection(state, input?.collabId) ?? guardedWrite(state, input?.collabId, () => handover(state, input)),
    list: (input) => listCollabs(state, input),
    indicators: () => indicators(state),
    create: (input) => createNow(state, input),
    invite: (input) => guardedWrite(state, input?.collabId, () => inviteMembers(state, input)),
    joinKnock: (knock) => handleJoinKnock(state, knock),   // 发现层注入面（UDP 敲门命中 → 成员侧应答与本机放行提示）
    joinResolve: (input) => resolveJoinTarget(state, input ?? {}),   // 发现层注入面（按名解析的命中回调，组合根接入）
    join: joinApiOf(state),   // 会话级加入的处置面（工具层落点）
    approve: (input) => guardedWrite(state, input?.collabId, () => approveNow(state, input)),
    allowNextInvite: (input) => guardedWrite(state, input?.collabId, () => allowNextInviteOf(state, input)),
    relayReport: (input) => applyRelayedReport(state, input),   // 网层回报注入面（转达副本达第三档 → 译回原作者）
    withdraw: (input) => guardedWrite(state, input?.collabId, () => withdrawInvite(state, input)),
    send: (input) => guardedWrite(state, input?.collabId, () => sendMessage(state, input)),
    end: (input) => guardedWrite(state, input?.collabId, () => endNow(state, input)),
    leave: (input) => guardedWrite(state, input?.collabId, () => leaveNow(state, input)),
    setMute: (input) => guardedWrite(state, input?.collabId, () => setMuteNow(state, input)),
    view: (input) => viewLedger(state, input),
    describe: (collabId) => describeCollab(state, collabId),
    count: () => countLiveCollabs(state),
    sync: (input) => syncNow(state, input),
    stats: () => statsOf(state),
    close: () => closeService(state),
    ...seatApiOf(state),
  };
}

/* 席位运行面（契约 M2 → M3/M4/M5/M6/M7）：读席位、本机旁路注入、桥注册、核心存续。
 * 全部异常隔离为结果对象——席位面是投递主链的基础设施，不得让单次坏输入穿出。 */
function seatApiOf(state) {
  return {
    listLocalSeats: (collabId) => {
      const local = state.collabs.get(collabId);
      return local === undefined ? [] : listLocalSeatsOf(local);
    },
    localSeatOf: (collabId, sessionId) => {
      const local = state.collabs.get(collabId);
      const seat = local === undefined ? null : localSeatOfLocal(local, sessionId);
      return seat === null ? null : seatViewOfPublic(seat);
    },
    managerSeatOf: (collabId) => {
      const local = state.collabs.get(collabId);
      const seat = local === undefined ? null : managerSeatOfLocal(local);
      return seat === null ? null : seatViewOfPublic(seat);
    },
    injectLocalSeat: (collabId, sessionId, frame) => injectLocalSeatOf(state, collabId, sessionId, frame),
    ensureCoreLifetimeForSeats: () => requiredSeatLifetimeOf(state),
    registerBridgeEntry: (sessionId, bridgeId) => registerBridgeNow(state, sessionId, bridgeId),
    unregisterBridgeEntry: (sessionId, bridgeId = null) => unregisterBridgeNow(state, sessionId, bridgeId),
    seatsForRouting: (collabId) => seatsForRoutingOf(state, collabId),
    seatForRouting: (collabId, sessionId) => {
      const local = state.collabs.get(collabId);
      const seat = local === undefined ? null : localSeatOfLocal(local, sessionId);
      return seat === null ? null : seat;
    },
    seatsOfSession: (sessionId) => seatsOfSession(state, sessionId),
    isWritable: (collabId) => writableVerdictOf(state, collabId).ok,
  };
}

/* 对外席位视图（契约字段）：不暴露暂存/inbox/去重集等运行态。 */
function seatViewOfPublic(seat) {
  return {
    sessionId: seat.sessionId,
    role: seat.role,
    state: seat.state,
    joinSeq: Number.isInteger(seat.joinSeq) ? seat.joinSeq : null,
    muted: seat.muted === true,
    unverified: seat.unverified === true,
  };
}

/* 会话级加入的处置面（工具层落点）：request＝发起加入（协作申请 / 讨论直连或敲门）、approve＝
 * 站长批准 / 拒绝、pendingJoinsOf 与 isGranted＝数据面与判据面（后者供核心 adopt 收紧注入）。 */
function joinApiOf(state) {
  return {
    request: (input) => guardedWrite(state, input?.collabId, () => joinRequestNow(state, input)),
    approve: (input) => guardedWrite(state, input?.collabId, () => joinApproveNow(state, input)),
    pendingJoinsOf: (collabId) => state.join.pendingJoinsOf(collabId),
    isGranted: (collabId, sessionId) => state.join.isGranted(collabId, sessionId),
  };
}

/* 加入域两个入口的席位收尾（M2 兼容桥）：加入/获准成功即补本地席位，使注入来源从绑定表切到席位后
 * 真实流程仍可达。两段式 joining 由 M4 接管，这里只登记「已成立」的席位。 */
function joinRequestNow(state, input) {
  const result = state.join.request(input);
  if (result?.ok === true && result.joined === true && validSessionId(input?.sessionId) && typeof result.collabId === 'string') {
    ensureSeatAfterJoin(state, result.collabId, input.sessionId, 'member');
  }
  return result;
}

function joinApproveNow(state, input) {
  const result = state.join.approve(input);
  if (result?.ok === true && (result.joined === true || result.member === true) && validSessionId(input?.sessionId) && typeof input?.collabId === 'string') {
    ensureSeatAfterJoin(state, input.collabId, input.sessionId, 'member');
  }
  return result;
}

/* 门控包装：异常隔离为拒绝（与准入钩子「异常按未通过归类」的既有语义一致）。 */
function gateFrame(state, frame, meta) {
  try {
    const refusal = readonlyInboundRefusal(state, frame?.collabId);
    return refusal ?? decideAdmission(state, frame, meta);
  } catch (error) {
    state.counters.gateFailures++;
    return { ok: false, reason: `协作门控异常：${error?.message ?? '未知原因'}` };
  }
}

/* 入站写门（设计 §6.4 H-I9）：legacy / 半写目录收到协作域帧一律拒绝并计数，不写 inbox/邀请。 */
function readonlyInboundRefusal(state, collabId) {
  const verdict = writableVerdictOf(state, collabId);
  if (verdict.ok) {
    return null;
  }
  state.legacyRejections.noteInbound();
  return { ok: false, reason: readonlyInboundMessageOf(verdict.reason) };
}

function readonlyInboundMessageOf(reason) {
  if (reason === 'legacy') {
    return '旧版协作只读——拒绝协作域帧';
  }
  if (reason === 'corrupt') {
    return '该协作目录已损坏（只读）——拒绝协作域帧';
  }
  return '该协作目录只读（半写/恢复态）——拒绝协作域帧';
}

/* 治理工具对讨论的拒绝面（设计 §6/§7「一律拒绝」）：四入口（裁定 / 合流裁定 / 移交 / 抢接）
 * 共用同一判据与同一文案——讨论无冻结、无席位，该治理面在讨论模式不可达。返回 null =
 * 非讨论实例（managed 与未知 collabId），照旧走各自实现（拦截只针对 discussion）。 */
function forumGovernanceRejection(state, collabId) {
  const local = state.collabs.get(collabId);
  if (local === undefined || localModeOf(local) !== 'forum') {
    return null;
  }
  return { ok: false, message: '讨论模式无此操作：讨论没有冻结 / 裁定 / 移交 / 抢接（该能力仅协作者（managed）模式可用）' };
}

/* 事件包装：异常隔离为计数与告警——协作事件绝不因内部错误穿出接收管线（健壮性硬性要求）。
 * 返回值透传（讨论的帖去重栅栏经它声明「不重复注入会话」；异常归 undefined = 保持照旧注入）。 */
async function consumeFrame(state, frame, meta) {
  try {
    state.counters.eventsHandled++;
    noteContentMessage(state, frame);
    const consumed = await handleEvent(state, frame, meta);
    return consumed === undefined ? joinFrameResult(state, frame) : consumed;
  } catch (error) {
    state.counters.eventFailures++;
    state.log.error('协作事件处理异常（已隔离）', { type: frame?.type, collabId: frame?.collabId, reason: error?.message });
    return undefined;
  }
}

/* 会话级加入的三帧分派（设计 §2）：事件面先行——端点学习（入站帧的来源地址与端口记入协作端点表）
 * 是站长侧回执寻址的取数来源，故先走既有事件面再落本域。三帧都只写本地态 / 直投回执，
 * 异常由消费面统一隔离（同事件面口径）。 */
function joinFrameResult(state, frame) {
  if (frame.type === 'join-request') {
    return state.join.handleJoinRequest(frame);
  }
  if (frame.type === 'join-grant') {
    return state.join.handleJoinGrant(frame);
  }
  if (frame.type === 'join-deny') {
    return state.join.handleJoinDeny(frame);
  }
  return undefined;
}

/* 静音栅栏的判定面（sessionGate 钩子）：判定归服务域（本层掌握模式与静音态），
 * 接收管线只采信 { suppress: true }。异常隔离为不抑制——栅栏是附属机制，判定失败按照旧注入。 */
/** @param {any} meta 接收管线的逐席上下文（meta.sessionId＝收件席位） */
function sessionGateFrame(state, frame, meta = null) {
  try {
    return { suppress: suppressForSeat(state, frame, meta?.sessionId) };
  } catch (error) {
    state.counters.sessionGateFailures++;
    state.log.warn('静音栅栏判定异常（按照旧注入）', { type: frame?.type, collabId: frame?.collabId, reason: error?.message });
    return null;
  }
}

/* 静音判定（设计 §5.4）：有席位表时按收件席位逐条判定，只有内容类（post 与 POST_KINDS）受静音影响；
 * 治理/邀请/离席等一律豁免。无席位表退回旧静音文件（兼容面，单布尔）。 */
function suppressForSeat(state, frame, sessionId) {
  const local = state.collabs.get(frame?.collabId);
  if (local === undefined || seatsOfLocal(local).size === 0) {
    return muteSuppresses(state, frame);
  }
  if (frame.type !== 'post' && !POST_KINDS.includes(frame.type)) {
    return false;
  }
  const seatId = typeof sessionId === 'string' ? sessionId : soleSeatSessionId(local);
  const seat = typeof seatId === 'string' ? localSeatOfLocal(local, seatId) : null;
  return seat?.muted === true;
}

/* 已注入事实的记真面（sessionDelivered 钩子）：只记帖——吸收路径的终态回执以该标记为前件
 * （（作者, postId）曾实际注入会话）；其余类型无标记面（join 的回执语义不依赖标记）。
 * 标记写失败只留痕（injected store 内部处理），不改变投递已成功的事实。 */
function noteSessionDelivered(state, frame) {
  if (frame.type !== 'post') {
    return;
  }
  const local = state.collabs.get(frame.collabId);
  const postId = frame.payload?.post?.postId;
  if (local === undefined || typeof postId !== 'string') {
    return;
  }
  local.injected.mark(frame.from.instanceId, postId);
}

/* 内容类入站消息计数（状态栏「N 条」的口径：累计收到的六类内容消息）：消费钩子每帧至多一次、
 * 去重命中的重复副本到不了这里——在消费面记账即天然「去重后各计一次」。判据用协议层 POST_KINDS
 * 六类（设计 §5.7 内容类词表，与帖子类型徽标、ws_send_message 类型面同一权威）：治理 / 控制类
 * （notice / freeze / decision 等）不入计数；讨论实例的计数面是帖子列表，而帖帧类型（post）
 * 不在六类内、天然不落此账。计数先于事件处理：消息已被受理（落盘 + ack）即是「收到」，
 * 事件处理内部失败不撤销到站事实。 */
function noteContentMessage(state, frame) {
  const local = state.collabs.get(frame.collabId);
  if (local === undefined || localModeOf(local) === 'forum') {
    return;
  }
  if (!POST_KINDS.includes(frame.type)) {
    return;
  }
  local.counter.increment();
}

/* 服务启动（组合根在 net.start 成功后调用；降级不调用）：探测定时器 + 启动握手（managed 收敛机制）
 * + 讨论对表引擎（周期 tick，anti-entropy）。幂等；不调用 start 的服务无定时器——
 * 既有单测路径零变化（对表可由 syncNow 直接驱动）。 */
function startService(state) {
  if (state.started) {
    return;
  }
  state.started = true;
  startLiveness(state);
  startSyncEngine(state);
  runHandshake(state);
}

/* 注册表加载：collabs/ 目录逐协作恢复（成员记录或载体文件、台账 / 快照 / 席位可选）；
 * 旧形态（0.1.x）由 M8 判据归档为只读、半写目录按 recovery 只读；单条失败只计数跳过，
 * 不阻塞进程（坏数据不得让服务起不来）。 */
function loadRegistry(state) {
  for (const collabId of listLocalCollabIds(state.dataDir)) {
    try {
      loadOneEntry(state, collabId);
    } catch (error) {
      state.counters.loadFailures++;
      state.log.warn('协作加载失败（跳过该条）', { collabId, reason: error.message });
    }
  }
}

function loadOneEntry(state, collabId) {
  const dir = collabDir(state.dataDir, collabId);
  const kind = classifyCollabDir(dir).kind;
  if (kind === 'legacy' || kind === 'archived-legacy') {
    recordLegacyCollab(state, collabId, dir);
    return;
  }
  if (kind === 'missing' || kind === 'empty' || kind === 'invite-stub') {
    return;
  }
  if (kind === 'recovery' || kind === 'corrupt') {
    recordReadonlyEntry(state, collabId, dir, kind);
    return;
  }
  state.collabs.set(collabId, loadOne(state, collabId));
}

/* 只读目录（半写 / 损坏）：半写写 recovery.json 留证；损坏只置内存标记（不改写坏数据）。 */
function recordReadonlyEntry(state, collabId, dir, kind) {
  if (kind === 'recovery') {
    writeRecovery(dir, { reason: 'carrier-without-ledger' });
    state.readonlyCollabs.set(collabId, { reason: 'recovery' });
    state.counters.recoveryCollabs++;
    return;
  }
  state.readonlyCollabs.set(collabId, { reason: 'corrupt' });
  state.counters.corruptCollabs++;
}

/* 旧协作启动归档（设计 §8）：写 migration.json 标记只读，不改写旧台账；摘要供列表/观察窗只读展示。
 * 标记写失败仍按只读处理（失败安全）。 */
function recordLegacyCollab(state, collabId, dir) {
  markLegacyCompleted(dir, { warn: (message) => state.log.warn(message) });
  state.legacyViews.set(collabId, readLegacyCollab(dir) ?? legacyFallbackSummary(collabId));
  state.counters.legacyCollabs++;
}

/* 载入兼容：缺 mode 的旧记录按 managed 解释（读取侧宽容、写入侧写全——对照 port 缺省先例；
 * 就地补缺省值，后续落盘即写全）。快照内嵌台账不做补写（其 digest 与内容自洽，改动会破坏一致性）。
 * 新形态目录可能只有 carrier 而无 member.json：兼容成员记录由载体与主席位派生，只作旧模块的读面。 */
function loadOne(state, collabId) {
  const carrier = readCarrier(collabDir(state.dataDir, collabId));
  const member = loadMember(state.dataDir, collabId) ?? memberFromCarrier(state, collabId, carrier.carrier);
  if (member === null) {
    throw new Error('缺少可用的成员记录（member.json）与载体文件（carrier.json）');
  }
  withDefaultMode(member);
  const loadedSeats = loadSeats(state.dataDir, collabId);
  noteSeatLoad(state, collabId, loadedSeats.corrupt);
  const local = {
    collabId,
    role: member.role,
    ledger: null,
    member,
    seats: loadedSeats.seats,
    endpoints: new Map(Object.entries(member.endpoints)),
    snapshot: loadSnapshot(state.dataDir, collabId),
    posts: createPostsStore({ dataDir: state.dataDir, collabId, log: state.log, onChange: () => notifyIndicatorChange(state) }),
    members: createMembersStore({ dataDir: state.dataDir, collabId, log: state.log, onChange: () => notifyIndicatorChange(state) }),
    counter: createCounterStore({ dataDir: state.dataDir, collabId, log: state.log, onChange: () => notifyIndicatorChange(state) }),
    mute: createMuteStore({ dataDir: state.dataDir, collabId, log: state.log }),
    injected: createInjectedStore({ dataDir: state.dataDir, collabId, log: state.log }),
    suspended: null,
    staleManagerId: null,
  };
  syncLocalRole(local);
  if (local.role === 'manager') {
    local.ledger = recoverLedger(state, collabId, local);
  }
  return local;
}

function noteSeatLoad(state, collabId, corrupt) {
  if (corrupt <= 0) {
    return;
  }
  state.counters.seatFileCorrupt += corrupt;
  state.log.warn('席位文件形态不符（跳过该条，不删除不清洗）', { collabId, count: corrupt });
}

/* 兼容成员记录（新形态目录无 member.json 时）：字段取自 carrier 与主席位，只供尚未迁移的旧模块读。
 * 席位态的角色派生优先（loadOne 的 syncLocalRole 会覆盖 role）。 */
function memberFromCarrier(state, collabId, carrier) {
  if (carrier === null) {
    return null;
  }
  const manager = carrier.manager ?? { instanceId: state.self.instanceId, identityName: state.self.identityName };
  return {
    collabId,
    name: carrier.name,
    role: 'member',
    state: 'active',
    manager: { instanceId: manager.instanceId, identityName: manager.identityName },
    endpoints: carrier.endpoints ?? {},
    roster: [{ instanceId: manager.instanceId, identityName: manager.identityName }],
    mode: carrier.mode,
    decision: null,
    topic: carrier.topic,
  };
}

/* 站长席位台账的加载与损坏重建（设计 §13：保留损坏副本、从最近快照重建并提示差异）：
 * 快照优先（版本明确）、成员记录骨架兜底；重建结果立即回写（台账流落新首行），来源计数留痕。 */
function recoverLedger(state, collabId, local) {
  const loaded = loadLedger(state.dataDir, collabId);
  if (loaded.ledger !== null) {
    return withDefaultMode(loaded.ledger);
  }
  if (loaded.corrupt) {
    state.counters.ledgerCorrupt++;
    quarantineLedger(state.dataDir, collabId);
  }
  const rebuilt = ledgerFromSource(local, collabId);
  local.ledger = rebuilt.ledger;
  state.counters.ledgerRebuilt++;
  state.log.warn('台账不可用，已重建（损坏副本保留在协作目录）', { collabId, source: rebuilt.source });
  persistLedger(state, local);
  return rebuilt.ledger;
}

function ledgerFromSource(local, collabId) {
  if (local.snapshot !== null) {
    /* 浅拷贝：补 mode 缺省不得回写快照内嵌台账（其 digest 与内容自洽，就地改动会破坏一致性）。 */
    const fromSnapshot = local.snapshot.ledger;
    return { source: 'snapshot', ledger: { ...fromSnapshot, mode: fromSnapshot.mode ?? local.member?.mode } };
  }
  const now = new Date().toISOString();
  const manager = local.member?.manager ?? { instanceId: '', identityName: '' };
  const sessionId = sessionIdOfManagerSeat(local) ?? fallbackSessionIdOf(manager.instanceId);
  return {
    source: 'member',
    ledger: {
      version: 1,
      collabId,
      name: local.member?.name ?? '',
      topic: '（台账损坏重建——主题待确认）',
      mode: local.member?.mode,
      status: 'proposed',
      managerTerm: 1,
      joinSeqNext: 2,
      manager: { instanceId: manager.instanceId, sessionId, identityName: manager.identityName, term: 1 },
      members: [{ instanceId: manager.instanceId, sessionId, identityName: manager.identityName, role: 'manager', state: 'member', joinSeq: 1, joinedAt: now }],
      board: [],
      createdAt: now,
      updatedAt: now,
    },
  };
}

function sessionIdOfManagerSeat(local) {
  const seat = managerSeatOfLocal(local);
  return seat === null ? null : seat.sessionId;
}

/* 台账重建的兜底会话标识：实例标识本身满足标识形态，仅在没有任何席位时使用（旧数据路径）。 */
function fallbackSessionIdOf(instanceId) {
  return ID_PATTERN.test(instanceId) ? instanceId : 'rebuilt-session';
}

/* 本机参与清单（ws_list_collabs 的数据面）：状态取本地权威；expired = 提议中且未回应且已过
 * 有效期（仅标注，不改状态——设计 §6 的「过期不算拒绝」）。
 * 治理面读数：managerOffline（成员侧失联判定）、frozenUnresolved（冻结超时已提示一次）、
 * suspended（收敛等待中的写暂停）、handshakeUnresolved（成员侧握手未能对表——只读保守运行）。
 * 会话视角（可选调用者 sessionId）：sessionGranted / sessionBound 按调用会话逐条判定——两本
 * 记录各司其职（获准＝权限台账、绑定＝路由绑定表），本层只取数不判决。 */
function listCollabs(state, input) {
  const now = Date.now();
  const caller = callerSessionOf(state, input);
  const collabs = [];
  for (const local of state.collabs.values()) {
    collabs.push(listEntryOf(state, local, now, caller));
  }
  for (const [collabId, summary] of state.legacyViews) {
    collabs.push(legacyListEntryOf(collabId, summary));
  }
  return { collabs };
}

/* 旧协作的只读列表项（设计 §10）：状态按 completed 展示，内容取自 M8 只读读取器。 */
function legacyListEntryOf(collabId, summary) {
  return {
    collabId,
    name: summary.name ?? null,
    role: null,
    mode: summary.mode ?? 'managed',
    state: 'completed',
    version: null,
    memberCount: summary.memberCount ?? 0,
    muted: false,
    archived: true,
    legacy: true,
    readOnly: true,
    sourceState: summary.sourceState ?? null,
    managerOffline: false,
    frozenUnresolved: false,
    suspended: false,
    handshakeUnresolved: false,
    decision: null,
    invitedAt: null,
    expiresAt: null,
    expired: false,
    sessionGranted: false,
    sessionBound: false,
    pendingJoins: [],
  };
}

/* 调用会话视角：无会话标识（桥缺会话环境变量）＝没有视角，字段如实判否。
 * 席位集一次现取、全体条目共用（一次列表一次真相）——绑定表不再参与视图。 */
function callerSessionOf(state, input) {
  const sessionId = typeof input?.sessionId === 'string' && input.sessionId !== '' ? input.sessionId : null;
  return sessionId === null ? null : { sessionId, boundIds: seatCollabIdsOf(state, sessionId) };
}

function seatCollabIdsOf(state, sessionId) {
  return new Set(seatsOfSession(state, sessionId).map((seat) => seat.collabId));
}

/* 观察面读数（状态栏消息数）：讨论 = 本机全量副本帖数（含回填帖）、协作 = 累计收到的内容消息数。
 * 独立于 ws_list_collabs 的清单面（工具载荷零变化）——会话状态文件的收集闭包按 collabId 分别
 * 取清单与读数再合并。 */
function indicators(state) {
  const readings = [];
  for (const local of state.collabs.values()) {
    readings.push({
      collabId: local.collabId,
      msgCount: localModeOf(local) === 'forum' ? local.posts.size() : local.counter.count(),
    });
  }
  return readings;
}

/* 成员数读数：讨论 = 折叠成员表（成员事件并集折叠——被拒/被撤回者不占名额、退出者即时出表，
 * 与邀请名额判据同一权威）；managed = 台账/定格名单（既有口径不变）。 */
function memberCountOf(local) {
  if (localModeOf(local) === 'forum') {
    return local.members.fold().length;
  }
  return localRosterOf(local).length;
}

/* 静音按席位聚合（设计 §5.4/§10）：有席位读席位、无席位退回旧静音文件（兼容面）。 */
function mutedOf(local) {
  if (seatsOfLocal(local).size === 0) {
    return local.mute.isMuted();
  }
  return listLocalSeatsOf(local).some((seat) => seat.muted);
}

function listEntryOf(state, local, now, caller) {
  const stateName = localStateOf(local);
  const probeState = state.probes.get(local.collabId);
  return {
    collabId: local.collabId,
    name: localNameOf(local),
    role: local.role,
    mode: localModeOf(local),
    state: stateName,
    version: local.role === 'manager' ? local.ledger.version : (local.snapshot === null ? null : local.snapshot.version),
    memberCount: memberCountOf(local),
    muted: mutedOf(local),
    archived: isArchived(stateName),
    managerOffline: local.role === 'manager' ? false : (probeState?.offline === true),
    frozenUnresolved: local.freezeDeadlineNotified === true,
    suspended: local.suspended !== null,
    handshakeUnresolved: local.handshakeUnresolved === true,
    ...inviteViewOf(local, now),
    ...sessionViewOf(state, local, caller),
    ...pendingJoinsViewOf(state, local),
  };
}

/* 待批准面（设计 §2/§6，站长侧）：条目 = {instanceId, identityName?, sessionId 短码, requestedAt}。
 * 会话标识对外只给短码（对外表示一律短码）；身份名缺省即省略（未携名者按短码呈现）。
 * 取数走加入域的存活面（过期待批准按申请时限剪除）；成员机恒空——待批准面只属站长。
 * 取数面异常按空面处置（清单不因附属机制失败而失败）。 */
function pendingJoinsViewOf(state, local) {
  if (local.role !== 'manager' || typeof state.pendingJoinsOf !== 'function') {
    return { pendingJoins: [] };
  }
  try {
    return { pendingJoins: state.pendingJoinsOf(local.collabId).map(pendingJoinView) };
  } catch (error) {
    state.counters.loadFailures++;
    state.log.warn('待批准面取数失败（按空面继续）', { collabId: local.collabId, reason: error.message });
    return { pendingJoins: [] };
  }
}

function pendingJoinView(record) {
  const view = { instanceId: record.instanceId, sessionId: shortSessionId(record.sessionId), requestedAt: record.requestedAt };
  if (typeof record.identityName === 'string') {
    view.identityName = record.identityName;
  }
  return view;
}

/* 本会话字段（设计 §6）：获准＝本会话在本机获准台账（joins.json 的 approvals）里，绑定＝绑定表
 * 当前指向本会话。获准台账现建现读（只消费判据、不写）：批准后下一次列表即见，缓存会陈旧。
 * 判据要全量会话标识——短码是展示面的表示，不做前缀匹配。 */
function sessionViewOf(state, local, caller) {
  if (caller === null) {
    return { sessionGranted: false, sessionBound: false };
  }
  const joins = createJoinsStore({ dataDir: state.dataDir, collabId: local.collabId, log: state.log });
  return { sessionGranted: joins.isGranted(caller.sessionId), sessionBound: caller.boundIds.has(local.collabId) };
}

/* 邀请视图（成员侧）：决策 / 有效期与过期标注（仅标注、不改状态——设计 §6 的「过期不算拒绝」）；
 * 站长席位给空面。 */
function inviteViewOf(local, now) {
  if (local.role !== 'member') {
    return { decision: null, invitedAt: null, expiresAt: null, expired: false };
  }
  const decision = local.member.decision ?? null;
  const invitedAt = local.member.invitedAt ?? null;
  const expiresAt = local.member.expiresAt ?? null;
  const expiresAtMs = typeof expiresAt === 'string' ? Date.parse(expiresAt) : Number.NaN;
  const pending = local.member.state === 'proposed' && decision === null;
  return { decision, invitedAt, expiresAt, expired: pending && Number.isFinite(expiresAtMs) && now > expiresAtMs };
}

/* 适配器描述器（上下文头项目名与模式）：本机已知协作的名称与模式；未知返回 null（头行退化为「身份名 时间戳」）。 */
function describeCollab(state, collabId) {
  const local = state.collabs.get(collabId);
  if (local === undefined) {
    return null;
  }
  return { name: localNameOf(local), mode: localModeOf(local) };
}

function statsOf(state) {
  const byState = {};
  for (const local of state.collabs.values()) {
    const stateName = localStateOf(local);
    byState[stateName] = (byState[stateName] ?? 0) + 1;
  }
  return { collabs: state.collabs.size, byState, ...state.counters, ...state.legacyRejections.read() };
}

/* 邀请回应的驱动面（讨论）：同意即加入后立即起一轮回填对表（复用周期对表的同一入口）——
 * 新人不必等下一个周期节拍（默认 60s）才看到历史。让出到微任务边界再起：本机这一回合的外发
 * 次序为 join 自播先、对表请求后（应答方准入按「请求方在成员表内」把关——请求先到会被拒）。
 * 点头前先过指名判定（指名邀请只有该会话能点头）。 */
/* 一次性邀请确认豁免（用户明确表示「下一次邀请无需确认」时由工具面登记；核心重启即失效）。 */
function allowNextInviteOf(state, input) {
  const sessionId = typeof input?.sessionId === 'string' && input.sessionId !== '' ? input.sessionId : null;
  if (sessionId === null) {
    return { ok: false, message: '无会话标识——无法登记邀请确认豁免' };
  }
  grantInviteWaiver(state, { sessionId });
  return { ok: true, note: '已登记一次性豁免：下一次同意 / 拒绝邀请将直接生效（消耗后失效；核心重启亦失效）' };
}

function approveNow(state, input) {
  const refusal = namedInviteRefusalOf(state, input);
  if (refusal !== null) {
    return refusal;
  }
  const result = approveInvite(state, input);
  if (result.ok === true && result.joined === true) {
    const local = state.collabs.get(input?.collabId);
    if (local !== undefined) {
      settleKnockedSession(state, local);
      queueMicrotask(() => {
        triggerSync(state, local, { reason: 'join-decided' });
      });
    }
  }
  return result;
}

/* 敲门登记的本会话接线（讨论「加入后本会话接线」的收口）：同意门的写点（放行者席位）在 handler
 * 之后才落，故本步以宏任务让位——登记在册的请求会话最终持席（放行者即请求会话时＝幂等重写）。
 * 无登记 / 非讨论 / 计时器不可用一律空转（既有行为不变）；计时器不阻止进程退出。 */
function settleKnockedSession(state, local) {
  const bind = () => {
    try {
      state.join.bindKnockedSession(local);
    } catch (error) {
      state.counters.eventFailures++;
      state.log.warn('敲门会话接线异常（已隔离）', { collabId: local.collabId, reason: error?.message });
    }
  };
  if (typeof setTimeout !== 'function') {
    bind();
    return;
  }
  const timer = setTimeout(bind, 0);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
}

/* 指名邀请的点头判定（「会话级加入」点名落点三）：member.json 的 targetSessionId 定格「只有该
 * 会话能点头」——其余会话（含无会话标识的调用）即使拿到邀请也拒，指引走 ws_join。判据读取成
 * 员记录文件（指名标记的写入方是核心路由面，内存记录可能尚未载入该字段），读不出退回内存记录；
 * 目标按短码定格时用唯一前缀匹配（与接收侧同一口径）。null＝无指名 / 未指名：交既有路径。
 * 调用者会话标识取自输入（工具面穿 context.sessionId；caller.sessionId 形态一并接受）。 */
function namedInviteRefusalOf(state, input) {
  const collabId = input?.collabId;
  const local = state.collabs.get(collabId);
  if (local === undefined) {
    return null;   // 未知协作：交既有路径如实拒（不在此另立文案）
  }
  const target = namedInviteTargetOf(state, collabId, local);
  if (target === null) {
    return null;
  }
  if (targetSessionMatches(target, callerSessionIdOf(input))) {
    learnInviteTarget(local, target);   // 点名已核对：补学进内存记录（后续整写不抹掉它）
    return null;
  }
  return {
    ok: false,
    message: `该邀请指定给了别的会话（${shortSessionId(target)}）——只有该会话能点头；本会话要跟进请走 ws_join 申请`,
  };
}

/* 指名标记的取数：成员记录文件优先（标记的写入方是核心路由面，内存记录可能尚未载入），
 * 读不出退回内存记录；两者都无（或空串）返 null＝未指名。 */
function namedInviteTargetOf(state, collabId, local) {
  const record = loadMember(state.dataDir, collabId);
  const target = typeof record?.targetSessionId === 'string' ? record.targetSessionId : local.member?.targetSessionId;
  return typeof target === 'string' && target !== '' ? target : null;
}

/* 点头会话与指名的比对：全标识精确命中，短码（对外表示）唯一前缀命中。 */
function targetSessionMatches(target, sessionId) {
  return sessionId !== null && (sessionId === target || sessionId.startsWith(target));
}

/* 内存成员记录补学（记录文件有而内存态无的指名标记）：成员记录随后会被整写（回应落地等），
 * 不补学就会在第一次整写时被抹掉——点名随即失效。 */
function learnInviteTarget(local, target) {
  if (local.member !== null && typeof local.member === 'object' && local.member.targetSessionId === undefined) {
    local.member.targetSessionId = target;
  }
}

/* 调用者会话标识（点头判据的比对面）：工具面穿 context.sessionId（平铺形态，与 ws_list_collabs
 * 同款）；路由面调用者可给 caller.sessionId。均缺＝无会话标识（无从核对指名）。 */
function callerSessionIdOf(input) {
  const flat = typeof input?.sessionId === 'string' && input.sessionId !== '' ? input.sessionId : null;
  if (flat !== null) {
    return flat;
  }
  const nested = input?.caller?.sessionId;
  return typeof nested === 'string' && nested !== '' ? nested : null;
}

/* 对表驱动入口（显式触发面；周期 tick 走 startSyncEngine 的定时器）：省略 collabId = 全量扫一轮
 * （fire-and-forget）；给定 collabId = 单实例一轮（返回本轮结果——确定性测试的判据面）。 */
async function syncNow(state, input = {}) {
  const { collabId, ...options } = input ?? {};
  if (collabId === undefined) {
    runSyncSweep(state, { reason: 'manual', ...options });
    return { ok: true, scope: 'all' };
  }
  const local = state.collabs.get(collabId);
  if (local === undefined) {
    return { ok: false, message: '本机没有该讨论（collabId 不存在）——先看 ws_list_collabs' };
  }
  return runSyncCycle(state, local, { reason: 'manual', ...options });
}

/* 静音开关的驱动面（ws_set_mute；纯本地行为开关：无外发帧、不广播——对端无感）。
 * 校验：muted 须布尔（工具层同校验，此处仍是权威面——直调 API 的路径同样要挡）、collabId 须本机存在。
 * 取消时（真翻转）经 notifyLocal 投一行错过内容摘要——N = 当前累计 − 基线（基线随静音状态文件持久，
 * 跨重启不丢）；累计面：讨论 = 帖子列表 size（含回填帖）、协作 = 内容消息计数（与状态栏读数同一取数面）。
 * 基线缺失（设静音时为旧数据 / 累计面不可用）时摘要降级为不带 N 的表述——宁可不给数、不给错数。
 * 静音态同属指示面（清单行与状态栏 🔇 标记都读它）：切换后即时触发观察面刷新，不等心跳。 */
function setMuteNow(state, input) {
  const collabId = input?.collabId;
  const muted = input?.muted;
  if (typeof muted !== 'boolean') {
    return { ok: false, message: 'muted 须为布尔值（true 进入静音 / false 取消静音）' };
  }
  const local = state.collabs.get(collabId);
  if (local === undefined) {
    return { ok: false, message: '本机没有该协作（collabId 不存在）——先看 ws_list_collabs' };
  }
  if (seatsOfLocal(local).size > 0) {
    return setSeatMuteNow(state, local, input, muted);
  }
  const countNow = contentCountOf(local);
  const before = local.mute.setMuted(muted, contentCountOf(local));
  notifyIndicatorChange(state);
  if (muted === false && before.wasMuted) {
    notifyLocal(state, local, resumeNoticeText(local, countNow, before.baseline));
  }
  return { ok: true, collabId, muted };
}

/* 无显式调用会话时的兼容取数：本机恰一席＝该席（多席必须显式，M6 工具面穿 sessionId）。 */
function soleSeatSessionId(local) {
  const seats = [...seatsOfLocal(local).values()];
  return seats.length === 1 ? seats[0].sessionId : null;
}

/* 席位级静音（设计 §5.4）：只改调用会话自己的席位并落盘；无该席拒绝（不静默改他人/整机）。 */
function setSeatMuteNow(state, local, input, muted) {
  const sessionId = typeof input?.sessionId === 'string' ? input.sessionId : soleSeatSessionId(local);
  const seat = typeof sessionId === 'string' ? localSeatOfLocal(local, sessionId) : null;
  if (seat === null) {
    return { ok: false, message: '本会话在该协作没有席位——静音按会话设置，不能改其他会话' };
  }
  const countNow = contentCountOf(local);
  const wasMuted = seat.muted === true;
  seat.muted = muted;
  try {
    upsertLocalSeat(local, seat, { persist: true, dataDir: state.dataDir });
  } catch (error) {
    state.counters.seatPersistFailures++;
    state.log.warn('席位静音写入失败（内存态继续）', { collabId: local.collabId, sessionId, reason: error.message });
  }
  notifyIndicatorChange(state);
  if (muted === false && wasMuted) {
    notifyLocal(state, local, resumeNoticeText(local, countNow, null));
  }
  return { ok: true, collabId: local.collabId, muted };
}

/* 取消静音的摘要文案（设计 §5.7）：讨论与协作各一句，直达补看工具名（讨论另点查看器——经查看器
 * 补看即浏览帖子列表；讨论的补看面是台账视图工具，协作的补看面是收件箱工具）。 */
function resumeNoticeText(local, countNow, baseline) {
  const delta = baseline === null ? null : Math.max(0, countNow - baseline);
  if (localModeOf(local) === 'forum') {
    const head = delta === null ? '静音期间本讨论可能有新内容' : `静音期间本讨论新增 ${delta} 条`;
    return `${head}——静音期与回填内容不进注入，经查看器/ws_view_ledger 补看`;
  }
  const head = delta === null ? '静音期间本协作可能有新内容' : `静音期间本协作新增 ${delta} 条`;
  return `${head}——经 ws_check_inbox 补看`;
}

/* —— 席位运行面（设计 §1.2/§3.2/§5.2/§5.5/§6.4） —— */

function validSessionId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function validCollabId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

/* 写门（设计 §6.4）：服务入口的单一 assertWritable。运行期已知协作只挡 recovery 标记——
 * legacy 只可能来自启动判定（热路径上的旧 member.json 目录可能是本进程刚建立的邀请落点，
 * 不能按 legacy 误拦）；未知协作才整档询问 M8 的 assertWritable。 */
function writableVerdictOf(state, collabId) {
  if (!validCollabId(collabId)) {
    return { ok: true };
  }
  if (state.legacyViews.has(collabId)) {
    return { ok: false, reason: 'legacy' };
  }
  if (state.readonlyCollabs.has(collabId)) {
    return { ok: false, reason: state.readonlyCollabs.get(collabId).reason };
  }
  if (state.writableCollabs.has(collabId)) {
    return { ok: true };
  }
  const dir = collabDir(state.dataDir, collabId);
  if (state.collabs.has(collabId)) {
    return knownCollabVerdict(state, collabId, dir);
  }
  const verdict = assertWritable(dir);
  if (!verdict.ok) {
    rememberReadonly(state, collabId, verdict);
  } else {
    state.writableCollabs.add(collabId);
  }
  return verdict;
}

/* 运行期已载入的协作：只挡 recovery/corrupt（legacy 的目录可能是本进程刚建立的邀请落点，
 * 由启动判定负责，不在热路径上误拦）。 */
function knownCollabVerdict(state, collabId, dir) {
  const kind = classifyCollabDir(dir).kind;
  if (kind === 'corrupt') {
    state.readonlyCollabs.set(collabId, { reason: 'corrupt' });
    return { ok: false, reason: 'corrupt' };
  }
  if (kind === 'recovery') {
    state.readonlyCollabs.set(collabId, { reason: 'recovery' });
    return { ok: false, reason: 'recovery' };
  }
  state.writableCollabs.add(collabId);
  return { ok: true };
}

function rememberReadonly(state, collabId, verdict) {
  if (verdict.reason === 'recovery') {
    state.readonlyCollabs.set(collabId, { reason: 'recovery' });
    state.counters.recoveryCollabs++;
  } else if (verdict.reason === 'corrupt') {
    state.readonlyCollabs.set(collabId, { reason: 'corrupt' });
    state.counters.corruptCollabs++;
  } else if (verdict.reason === 'legacy') {
    const summary = readLegacyCollab(collabDir(state.dataDir, collabId));
    state.legacyViews.set(collabId, summary ?? legacyFallbackSummary(collabId));
    state.counters.legacyCollabs++;
  }
}

function legacyFallbackSummary(collabId) {
  return { legacy: true, readOnly: true, collabId, name: null, topic: null, mode: 'managed', state: 'completed', memberCount: 0, roster: [], warnings: [] };
}

function guardedWrite(state, collabId, run) {
  const verdict = writableVerdictOf(state, collabId);
  if (verdict.ok) {
    return run();
  }
  state.legacyRejections.noteWrite();
  return { ok: false, message: readonlyWriteMessageOf(verdict.reason) };
}

function readonlyWriteMessageOf(reason) {
  if (reason === 'legacy') {
    return '该协作是旧版（0.1.x）协作，已归档为只读——不能写入；请新建协作';
  }
  if (reason === 'corrupt') {
    return '该协作目录已损坏（只读）——不能写入；请手工检查或归档';
  }
  return '该协作目录处于半写/恢复态（只读）——不能写入；请手工归档或重新创建';
}

/* 新建的成功收尾：席位登记（本机席位态的唯一写点之一）＋载体文件。
 * 设计 §8 要求 carrier 先于台账；createCollab 属 M3 且内部直接落台账，本层只能在其后补写
 * （崩窗见任务笔记 ISSUE-M2-1，待 M3 提供前置钩子）。 */
function createNow(state, input) {
  const result = createCollab(state, input);
  if (result?.ok !== true) {
    return result;
  }
  const local = state.collabs.get(result.collabId);
  if (local !== undefined) {
    registerCreatorSeat(state, local, input);
    ensureCarrierOf(state, local, input);
  }
  return result;
}

function registerCreatorSeat(state, local, input) {
  if (!validSessionId(input?.sessionId)) {
    return;
  }
  upsertLocalSeat(local, creatorSeatOf(input.sessionId), { persist: true, dataDir: state.dataDir });
}

function creatorSeatOf(sessionId) {
  return {
    version: 1,
    sessionId,
    role: 'manager',
    state: 'member',
    joinSeq: 1,
    joinedAt: new Date().toISOString(),
    muted: true,
    unverified: false,
  };
}

function ensureCarrierOf(state, local, input) {
  const dir = collabDir(state.dataDir, local.collabId);
  if (readCarrierFormat(dir) !== null) {
    return;
  }
  const carrier = carrierOf(state, local, input);
  try {
    writeCarrier(dir, carrier);
  } catch (error) {
    state.counters.persistFailures++;
    state.log.warn('载体文件写入失败（新协作仍可运行）', { collabId: local.collabId, reason: error.message });
  }
}

function carrierOf(state, local, input) {
  const carrier = carrierBaseOf(local);
  addCarrierManager(state, local, carrier, input);
  addCarrierOriginator(local, carrier);
  return carrier;
}

function carrierBaseOf(local) {
  return {
    format: CARRIER_FORMAT_SESSION_SEATS,
    version: 1,
    collabId: local.collabId,
    name: localNameOf(local) ?? '',
    topic: localTopicOf(local) ?? '',
    mode: localModeOf(local),
    endpoints: Object.fromEntries(local.endpoints ?? []),
    snapshotVersion: local.ledger?.version ?? local.snapshot?.version ?? 0,
    createdAt: new Date().toISOString(),
  };
}

function addCarrierManager(state, local, carrier, input) {
  const sessionId = managerSeatOfLocal(local)?.sessionId ?? input?.sessionId;
  if (!validSessionId(sessionId)) {
    return;
  }
  carrier.manager = {
    instanceId: state.self.instanceId,
    sessionId,
    identityName: state.self.identityName,
    term: local.ledger?.managerTerm ?? 1,
  };
}

function addCarrierOriginator(local, carrier) {
  const originator = local.member?.originator;
  if (localModeOf(local) !== 'forum' || originator === undefined) {
    return;
  }
  const sessionId = originator.sessionId ?? carrier.manager?.sessionId;
  if (validSessionId(sessionId)) {
    carrier.originator = { ...originator, sessionId };
  }
}

/* 离开/结束的席位清理：成功结果之后执行（离席广播与标记由 M5 负责，本层只维护本机席位态）。 */
function leaveNow(state, input) {
  const result = leaveCollab(state, input);
  if (result?.ok === true && validSessionId(input?.sessionId)) {
    removeSeatOf(state, input.collabId, input.sessionId);
  }
  return result;
}

function endNow(state, input) {
  const result = endCollab(state, input);
  if (result?.ok === true) {
    removeAllSeatsOf(state, input?.collabId);
  }
  return result;
}

function removeSeatOf(state, collabId, sessionId) {
  const local = state.collabs.get(collabId);
  if (local !== undefined) {
    removeLocalSeat(local, sessionId, { persist: true, dataDir: state.dataDir });
  }
}

function removeAllSeatsOf(state, collabId) {
  const local = state.collabs.get(collabId);
  if (local === undefined) {
    return;
  }
  for (const sessionId of [...seatsOfLocal(local).keys()]) {
    removeLocalSeat(local, sessionId, { persist: true, dataDir: state.dataDir });
  }
}

function ensureSeatAfterJoin(state, collabId, sessionId, role) {
  const local = state.collabs.get(collabId);
  if (local === undefined || localSeatOfLocal(local, sessionId) !== null) {
    return;
  }
  const seat = {
    version: 1,
    sessionId,
    role,
    state: 'member',
    joinSeq: joinSeqOf(local, sessionId),
    joinedAt: new Date().toISOString(),
    muted: true,
    unverified: false,
  };
  upsertLocalSeat(local, seat, { persist: true, dataDir: state.dataDir });
}

function joinSeqOf(local, sessionId) {
  const row = (local.ledger?.members ?? []).find((entry) => entry.sessionId === sessionId);
  if (Number.isInteger(row?.joinSeq)) {
    return row.joinSeq;
  }
  return seatsOfLocal(local).size + 1;
}

/* 本机旁路（设计 §1.2/§5.2/§5.3）：目标席位在本机时直接写该席位 inbox/暂存并交桥，不经 dispatch.send。
 * 同机多席各自去重（键 msgId）、各自暂存；发送会话不给自己投递。 */
async function injectLocalSeatOf(state, collabId, sessionId, frame) {
  const prepared = seatForInjection(state, collabId, sessionId);
  if (prepared.ok !== true) {
    return prepared.result;
  }
  const { local, seat } = prepared;
  if (frame?.from?.sessionId === sessionId) {
    state.counters.seatSelfSkipped++;
    return { ok: true, skipped: 'self' };
  }
  const msgId = typeof frame?.msgId === 'string' ? frame.msgId : null;
  if (msgId !== null && seat.seen.has(msgId)) {
    state.counters.seatDuplicates++;
    return { ok: true, duplicate: true };
  }
  noteSeatInbox(seat, frame, msgId);
  if (await deliverToSeatNow(state, seat, frame)) {
    state.counters.seatsInjected++;
    return { ok: true, delivered: true };
  }
  stageSeatFrame(state, local, seat, frame);
  return { ok: true, staged: true };
}

/* 注入前置（形态/席位/可注入性）：返回 {ok:true, local, seat} 或 {ok:false, result}。 */
function seatForInjection(state, collabId, sessionId) {
  if (!validSessionId(sessionId)) {
    return { ok: false, result: { ok: false, reason: 'bad-session' } };
  }
  const local = state.collabs.get(collabId);
  if (local === undefined) {
    return { ok: false, result: { ok: false, reason: 'unknown-collab' } };
  }
  const seat = localSeatOfLocal(local, sessionId);
  if (seat === null) {
    return { ok: false, result: { ok: false, reason: 'no-seat' } };
  }
  if (seat.state !== 'member' && seat.state !== 'joining') {
    return { ok: false, result: { ok: false, reason: 'seat-not-injectable' } };
  }
  return { ok: true, local, seat };
}

async function deliverToSeatNow(state, seat, frame) {
  if (seat.bridgeId === null || typeof state.deliverSeat !== 'function') {
    return false;
  }
  try {
    const delivered = await state.deliverSeat(frame, seat);
    if (delivered === true) {
      return true;
    }
  } catch (error) {
    state.log.warn('本机席位交付异常（转暂存）', { collabId: frame?.collabId, sessionId: seat.sessionId, reason: error?.message });
  }
  state.counters.seatDeliverFailures++;
  return false;
}

/* 席位 inbox 只作运行态投递事实（去重键 msgId；落盘 inbox.jsonl 归 M3）。 */
function noteSeatInbox(seat, frame, msgId) {
  if (msgId !== null) {
    seat.seen.add(msgId);
  }
  seat.inbox.push({ msgId, type: frame?.type ?? null, fromSessionId: frame?.from?.sessionId ?? null, at: new Date().toISOString() });
  while (seat.inbox.length > SEAT_INBOX_MAX) {
    const evicted = seat.inbox.shift();
    if (typeof evicted?.msgId === 'string') {
      seat.seen.delete(evicted.msgId);
    }
  }
}

/* 暂存（设计 §5.5）：宽限内断连的席位帧进内存，同 sessionId 重连补投；超限丢最旧并计数。 */
function stageSeatFrame(state, local, seat, frame) {
  state.stagedSeq++;
  seat.staged.push({ frame, seq: state.stagedSeq });
  while (seat.staged.length > state.stagedMaxPerSeat) {
    seat.staged.shift();
    seat.stagedDropped++;
    state.counters.seatStagedDropped++;
  }
  while (stagedCountOf(local) > state.stagedMaxPerCollab) {
    dropOldestStaged(state, local);
  }
  state.counters.seatsStaged++;
}

function stagedCountOf(local) {
  let total = 0;
  for (const seat of seatsOfLocal(local).values()) {
    total += seat.staged.length;
  }
  return total;
}

/* 丢最旧：比较各席位暂存队首的到达序，跨席位取全局最早者（不按 Map 迭代序误丢）。 */
function dropOldestStaged(state, local) {
  /** @type {any} */
  let oldest = null;
  for (const seat of seatsOfLocal(local).values()) {
    if (seat.staged.length === 0) {
      continue;
    }
    if (oldest === null || seat.staged[0].seq < oldest.staged[0].seq) {
      oldest = seat;
    }
  }
  if (oldest === null) {
    return;
  }
  oldest.staged.shift();
  oldest.stagedDropped++;
  state.counters.seatStagedDropped++;
}

/* 桥注册/注销（设计 §3.2）：注册即绑定该会话在本机全部协作的席位并补投暂存（按到达序）。 */
async function registerBridgeNow(state, sessionId, bridgeId) {
  if (!validSessionId(sessionId) || typeof bridgeId !== 'string' || bridgeId === '') {
    return { ok: false, reason: 'bad-bridge' };
  }
  state.sessionBridges.set(sessionId, bridgeId);
  let seats = 0;
  let flushed = 0;
  for (const local of state.collabs.values()) {
    const seat = localSeatOfLocal(local, sessionId);
    if (seat === null) {
      continue;
    }
    seat.bridgeId = bridgeId;
    seats++;
    flushed += await flushStagedOf(state, seat);
  }
  state.counters.seatBridgeRegistrations++;
  return { ok: true, seats, flushed };
}

async function flushStagedOf(state, seat) {
  let flushed = 0;
  while (seat.staged.length > 0) {
    const frame = seat.staged[0].frame;
    if (!await deliverToSeatNow(state, seat, frame)) {
      break;
    }
    seat.staged.shift();
    flushed++;
  }
  return flushed;
}

function unregisterBridgeNow(state, sessionId, bridgeId) {
  if (!validSessionId(sessionId)) {
    return { ok: false, reason: 'bad-session' };
  }
  if (bridgeId === null || state.sessionBridges.get(sessionId) === bridgeId) {
    state.sessionBridges.delete(sessionId);
  }
  let cleared = 0;
  for (const local of state.collabs.values()) {
    const seat = localSeatOfLocal(local, sessionId);
    if (seat === null || (bridgeId !== null && seat.bridgeId !== bridgeId)) {
      continue;
    }
    seat.bridgeId = null;
    cleared++;
  }
  return { ok: true, cleared };
}

/* 核心存续（设计 §3.2）：存在活跃席位时，空闲退出不早于 max(核心宽限, 席位宽限 + 10s)。
 * 本函数只给出「席位侧下界」，核心宽限由组合根取较大者。 */
function requiredSeatLifetimeOf(state) {
  for (const local of state.collabs.values()) {
    if (hasActiveSeat(local)) {
      return state.seatGraceMs + SEAT_GRACE_MARGIN_MS;
    }
  }
  return 0;
}

/* 路由面席位视图：注入链的唯一来源（绑定表退出注入面）。 */
function seatsForRoutingOf(state, collabId) {
  const local = state.collabs.get(collabId);
  if (local === undefined) {
    return [];
  }
  return [...seatsOfLocal(local).values()].map((seat) => ({
    sessionId: seat.sessionId,
    role: seat.role,
    state: seat.state,
    unverified: seat.unverified === true,
    bridgeId: seat.bridgeId,
  }));
}

function seatsOfSession(state, sessionId) {
  const seats = [];
  for (const local of state.collabs.values()) {
    const seat = localSeatOfLocal(local, sessionId);
    if (seat !== null) {
      seats.push({ collabId: local.collabId, ...seatViewOfPublic(seat) });
    }
  }
  return seats;
}

/* 收尾：定时器、等待面与在途流程统一解挂（闸门、快照拉取、握手观察、抢接窗口、移交回执、
 * 对表等待面与 join 重播）。 */
function closeService(state) {
  stopLiveness(state);
  stopSyncEngine(state);
  for (const held of state.pendingViews.values()) {
    for (const waiter of held) {
      clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
  }
  state.pendingViews.clear();
  for (const held of state.handshakeWatch.values()) {
    clearTimeout(held.timer);
  }
  state.handshakeWatch.clear();
  for (const record of state.takeovers.values()) {
    if (record.timer !== null) {
      clearTimeout(record.timer);
    }
    record.resolveWindow?.({ ok: false, message: '服务已关闭——抢接流程中止' });
  }
  state.takeovers.clear();
  state.rearmedTakeovers.clear();
  state.awaitingTakeovers.clear();
  for (const held of state.pendingHandovers.values()) {
    clearTimeout(held.timer);
    held.resolve(null);
  }
  state.pendingHandovers.clear();
}

function emptyCounters() {
  return {
    ...emptyFlowCounters(),
    ...emptyGuardCounters(),
    ...emptyGovernanceCounters(),
    ...emptySyncCounters(),
    ...emptySeatCounters(),
  };
}

/* 席位运行计数（本机旁路/暂存/桥注册/只读目录观测面）。 */
function emptySeatCounters() {
  return {
    seatsInjected: 0,
    seatsStaged: 0,
    seatDuplicates: 0,
    seatSelfSkipped: 0,
    seatDeliverFailures: 0,
    seatStagedDropped: 0,
    seatBridgeRegistrations: 0,
    seatFileCorrupt: 0,
    seatPersistFailures: 0,
    legacyCollabs: 0,
    recoveryCollabs: 0,
    corruptCollabs: 0,
  };
}

/* 讨论的对表与成员收敛计数（拉取 / 真对账 / 成员事件 / 重播）。 */
function emptySyncCounters() {
  return {
    syncCycles: 0,
    syncFailures: 0,
    syncRequestsSent: 0,
    syncRequestsRejected: 0,
    syncRequestsThrottled: 0,
    syncBundlesSent: 0,
    syncBundlesIn: 0,
    syncSegments: 0,
    syncMismatches: 0,
    syncRollbacks: 0,
    syncPostsBackfilled: 0,
    syncPostsRejected: 0,
    forumMetaRejected: 0,     // 学习面拒绝的坏元状态字段数（与加载面同判据——网络坏值不落盘）
    syncEventsIn: 0,
    syncTerminalsIn: 0,
    syncNoPeer: 0,
    syncNoAnswer: 0,
    syncSendSkipped: 0,
    syncBundleSkipped: 0,
    forumJoinsIn: 0,
    forumJoinDuplicates: 0,
    forumJoinsOut: 0,
    forumLeavesIn: 0,
    forumLeavesOut: 0,
    forumEstablished: 0,
    forumBroadcastSkipped: 0,
    joinReplays: 0,
  };
}

/* 流程计数（建协 / 回应 / 生命周期 / 台账联动）。 */
function emptyFlowCounters() {
  return {
    collabsCreated: 0,
    invitesSent: 0,
    invitesReceived: 0,
    invitesRejected: 0,
    joinRequestsRejected: 0,  // 加入申请三查的拒绝数（自邀 / 同源限频 / 待批准上限）
    joinDecisionsRejected: 0, // 加入回执与本机申请台账不匹配（含已过期）的拒绝数
    decisionsSent: 0,
    approvalsIn: 0,
    declinesIn: 0,
    established: 0,
    establishedIn: 0,
    withdrawn: 0,
    terminatedIn: 0,
    ended: 0,
    endedIn: 0,
    left: 0,
    leftIn: 0,
    topicsIn: 0,
    progressIn: 0,
    noticesIn: 0,
    eventMismatch: 0,
    postsSent: 0,
    postsIn: 0,
    postsDuplicated: 0,
    postRejected: 0,
    postFanoutSkipped: 0,
    ...emptyRelayCounters(),
    ...emptyJoinKnockCounters(),
  };
}

/* 中继路径与转达面计数（中继 / 降级 / 转达 / 聚合捎回）。 */
function emptyRelayCounters() {
  return {
    relayPostsSent: 0,        // 成员经中继提交的帖数（中继路径态）
    relayDegradedPosts: 0,    // 降级直投的帖数（降级态）
    relayDegrades: 0,         // 进入降级态次数（探测不可达 / 中继端点未知置位）
    relayRecoveries: 0,       // 恢复中继路径次数（后台恢复检测）
    relayEndpointUnknown: 0,  // 中继端点未知的降级次数（发起人标识已学但端点缺）
    relaySubmissionsIn: 0,    // 收到的投稿数（中继侧，首发入列时计）
    relaySubmissionsRejected: 0,   // 转达面拒绝的非成员投稿数（只拒转达，帖照常受理）
    relayRedistributed: 0,    // 转达处理的帖数（每（作者, postId）至多一次）
    relayFanoutSkipped: 0,    // 转达时端点未知跳过的目标数
    relayReportSent: 0,       // 聚合捎回：译回原作者的第三档回报帧数
    relayReportSkipped: 0,    // 聚合捎回：原作者端点未知跳过数
    relayReportFailed: 0,     // 聚合捎回：入队失败 / 异常数
  };
}

/* 敲门命中的两个计数（成员侧，设计 §5.6），独立成块以维持各计数块的行数上限。 */
function emptyJoinKnockCounters() {
  return {
    joinKnockMatches: 0,      // 敲门命中本机讨论实例数
    joinKnockAckSkipped: 0,   // 命中但本地元数据不全、未发应答数（提示照发）
  };
}

/* 门控与存储计数（冻结 / 丢弃 / 快照 / 健壮性观测面）。 */
function emptyGuardCounters() {
  return {
    freezeDetected: 0,
    freezeApplied: 0,
    freezeRelayed: 0,
    freezeUnmatched: 0,
    forumGovernanceIgnored: 0,
    forumTypeRejected: 0,     // 讨论实例收到 managed 专属类型的入站拒绝数（冻结面隔离）
    lateDropped: 0,
    rejectedFrozen: 0,
    unknownCollab: 0,
    boardEvicted: 0,
    ledgerMutations: 0,
    ledgerCorrupt: 0,
    ledgerRebuilt: 0,
    snapshotSent: 0,
    snapshotSkipped: 0,
    snapshotStored: 0,
    snapshotCorrupt: 0,
    snapshotStale: 0,
    snapshotReceipts: 0,
    snapshotFromNonManager: 0,
    messagesSent: 0,
    sendFailures: 0,
    eventsHandled: 0,
    eventFailures: 0,
    gateFailures: 0,
    sessionGateFailures: 0,
    indicatorChangeFailures: 0,
    loadFailures: 0,
    bindingsCorrupt: 0,       // 读取绑定表遇损坏的留痕（列表会话视角现读——核心加载之后的再次指认面）
    persistFailures: 0,
  };
}

/* 治理与韧性计数（失联 / 握手 / 抢接 / 裁定 / 合流 / 移交 / 提示与队列重定向）。 */
function emptyGovernanceCounters() {
  return {
    ...emptyLinkCounters(),
    ...emptyAdjudicationCounters(),
  };
}

/* 链路与收敛计数（失联判定 / 握手 / 暂停 / 抢接 / 席位变更与队列重定向）。 */
function emptyLinkCounters() {
  return {
    probeAttempts: 0,
    probeSuccesses: 0,
    probeFailures: 0,
    probeSkippedNoEndpoint: 0,
    managerOffline: 0,
    managerRecovered: 0,
    endpointRejected: 0,
    handshakesSent: 0,
    handshakesIn: 0,
    handshakeUnresolved: 0,
    handshakeResolved: 0,
    suspensions: 0,
    resumptions: 0,
    suspensionExpired: 0,
    mutationSuspended: 0,
    takeoversInitiated: 0,
    takeoversIn: 0,
    takeoversRelayed: 0,
    takeoversYielded: 0,
    takeoversAborted: 0,
    takeoversAwaiting: 0,
    takeoversEffective: 0,
    takeoversReportsIn: 0,
    takeoversCancelsIn: 0,
    takeoverSuperseded: 0,
    takeoverDowngrades: 0,
    takeoverResends: 0,
    queueRetargeted: 0,
    queueStaleKept: 0,
    rosterSkipped: 0,
    managerChangedIn: 0,
    downgrades: 0,
    notificationsSent: 0,
    notificationsDropped: 0,
  };
}

/* 裁定计数（冻结裁定 / 解冻 / 合流递交 / 移交）。 */
function emptyAdjudicationCounters() {
  return {
    freezeDecisionsOut: 0,
    freezeDecisionsIn: 0,
    freezeIntentsIn: 0,
    freezeDecisionConflicts: 0,
    freezeTerminatedLocal: 0,
    unfreezesIn: 0,
    freezeUnresolved: 0,
    mergeOffersSent: 0,
    mergeRequestsIn: 0,
    mergeAdopted: 0,
    mergeDiscarded: 0,
    mergeOutcomesIn: 0,
    mergeCorrupt: 0,
    mergeInviteSkipped: 0,
    handoverOffered: 0,
    handoverAccepted: 0,
    handoverCompleted: 0,
    handoverRejected: 0,
    handoverTimeouts: 0,
  };
}
