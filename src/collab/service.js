import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { saveConfig } from '../config.js';
import { PENDING_INVITES_FILE_NAME, SEATS_DIR_NAME, collabDir, collabFilePath } from '../paths.js';
import { appendLine } from '../storage.js';
import {
  LEDGER_FILE_NAME, MEMBER_FILE_NAME, SNAPSHOT_FILE_NAME, listLocalCollabIds, loadLedger, loadMember, loadSnapshot, quarantineLedger,
} from './store.js';
import { isArchived, withDefaultMode } from './model.js';
import { CARRIER_FORMAT_SESSION_SEATS, readCarrier, readCarrierFormat, writeCarrier } from './carrier.js';
import { assertWritable, classifyCollabDir, createLegacyRejectionCounter, markLegacyCompleted, readLegacyCollab } from './legacy.js';
import { writeRecovery } from './migration.js';
import {
  archiveLocalSeatsOfState, hasActiveSeat, isSeatArchived, listLocalSeatsOf, loadSeats, localSeatOfLocal,
  managerSeatOfLocal, retiredMuteHandle, seatsOfLocal,
  removeLocalSeat, setLocalSeatRole, seatViewOf, syncLocalRole, upsertLocalSeat,
} from './local.js';
import { INBOX_FILE_NAME } from '../net/inbound.js';
import { createPostsStore } from './posts.js';
import { createMembersStore } from './members.js';
import { createCounterStore, notifyIndicatorChange } from './counter.js';
import { forgetMuteBaseline, forgetMuteBaselinesOfCollab, rememberMuteBaselineIfAbsent, takeMuteBaseline } from './mute.js';
import { createInjectedStore } from './injected.js';
import { createJoinsStore } from './joins.js';
import { consumeInviteChallenge, consumeInviteWaiver, grantInviteWaiver, issueInviteChallenge } from './consent.js';
import {
  clearSessionGate, confirmGateOverCap, consumeConfirmToken, createConfirmGateState, gateConfigKey, gateValueOf,
  issueConfirmToken, markConfirmGateClosed, markConfirmGateOpen, pruneConfirmGates, queueConfirmGateNotice,
  setSessionGate, takeConfirmGateNotices,
} from './confirm-gate.js';
import { JOIN_REQUEST_RETRY_MAX_MS, JOIN_REQUEST_RETRY_MS, JOIN_REQUEST_TTL_MS, createJoinDomain, resolveJoinTarget } from './join.js';
import { createDispatchDomain } from './dispatch.js';
import { ID_PATTERN, POST_KINDS } from '../net/protocol.js';
import { matchSessionByToken, shortSessionId } from '../util/short-id.js';
import { decideAdmission, frozenWriteRefusalOf, managerFreezeReasonOf, SYNC_REQUEST_MAX, SYNC_REQUEST_WINDOW_MS } from './gate.js';
import { handleEvent, maybeEstablish } from './events.js';
import { localModeOf, localNameOf, localRosterOf, localStateOf, localTopicOf, persistLedger, persistMember } from './local.js';
import {
  applyRelayedReport, approveInvite, contentCountOf, countLiveCollabs, createCollab, deliveryStatusOf as outgoingDeliveryStatusOf, endCollab,
  handleJoinKnock, inviteMembers, leaveCollab, localSeatDeliveryOf as outgoingLocalSeatDeliveryOf, notifyLocal, sendMessage, targetsRejectionOf,
  viewLedger, withdrawInvite,
} from './outgoing.js';
import { JOIN_REPLAY_INTERVALS_MS, SYNC_MAX_REQUESTS_PER_CYCLE, SYNC_MAX_SOURCES_PER_CYCLE, SYNC_REPLY_TIMEOUT_MS, SYNC_SOFT_BUNDLE_BYTES, SYNC_TAIL_POSTS, SYNC_TAIL_WINDOW_MS, runSyncCycle, runSyncSweep, startSyncEngine, stopSyncEngine, triggerSync } from './sync.js';
import {
  HANDSHAKE_REPLY_TIMEOUT_MS, LEDGER_FROZEN_REASON, TAKEOVER_PROBE_INTERVAL_MS, autoTransfer, clearFreezeReason,
  freezeOnManagerOffline, m5RuntimeOf, noteSeatClosed, presenceSnapshot, runHandshake, startLiveness, stopLiveness, takeOver,
} from './takeover.js';
import { decide, decideMergeOffer } from './freeze.js';
import { HANDOVER_CONFIRM_TIMEOUT_MS, confirmHandover, handover, rejectHandover } from './handover.js';

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
/* 席位 inbox 只保留近期投递事实（运行态观测面；落盘 inbox.jsonl 归出站/入站层）。 */
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
 *   probeCapability?: ((options: object) => Promise<any>) | null,
 *   pendingOutboundOf?: ((query: object) => any[]) | null,
 *   onSessionRebound?: ((sessionId: string) => void) | null,
 *   joinRequestRetryMs?: number, joinRequestRetryMaxMs?: number, now?: () => number,
 *   deliveryStatusOf?: ((msgId: string) => any) | null,
 *   localSeatDeliveryOf?: ((msgId: string, sessionId: string) => any) | null,
 *   noteLocalDelivery?: ((entry: { collabId: string, sessionId: string, frame: object, outcome: string }) => unknown) | null,
 *   selfEndpoint?: { address: string, port?: number } | null,
 *   monoClock?: (() => number) | null }} options
 */
export function createCollabService(options) {
  const state = /** @type {any} */ (buildState(options));
  /* 出站/入站层经 state 直取的本机旁路面：与 API 同源，避免两套注入入口。 */
  state.injectLocalSeat = (collabId, sessionId, frame) => injectLocalSeatOf(state, collabId, sessionId, frame);
  state.listLocalSeats = (collabId) => {
    const local = state.collabs.get(collabId);
    return local === undefined ? [] : listLocalSeatsOf(local);
  };
  /* 投递查询面（出站/入站层 → 工具面）：本机旁路的席位明细优先取内存事实，未命中再委托接收管线的落盘账；
   * 组合根以闭包注入（IPC 监听步才构造），运行期再触达。 */
  state.inboundLocalSeatDeliveryOf = pickOption(options, 'localSeatDeliveryOf', null);
  /* 本机投递账的写面（接收核收件盒）：查询面与写面必须落在同一个盒子里，否则运行期写入对本进程不可见。 */
  state.inboundNoteLocalDelivery = pickOption(options, 'noteLocalDelivery', null);
  state.deliveryStatusOf = pickOption(options, 'deliveryStatusOf', null);
  state.localSeatDeliveryOf = (msgId, sessionId) => localSeatDeliveryOfOf(state, msgId, sessionId);
  state.join = createJoinDomain({
    state,
    send: joinSenderOf(state),
    openViewer: state.openViewer,
    log: state.log,
    now: state.clock,
  });
  /* 加入域自动批准成功后的通知面（通知注入与有界队列归服务层：加入域只管判定与批准）。 */
  state.onJoinAutoApproved = (event) => noteJoinAutoApproved(state, event);
  /* dispatch 内存域（设计 §4）：与 managed / forum 同级但不进注册表、不写协作文件；
   * 会话元数据与在册会话清单由组合根经桥注册面注入（未注入＝单测/降级，域内如实给空）。 */
  state.dispatchDomain = createDispatchDomain({
    state,
    config: options.config,
    log: state.log,
    now: state.clock,
    notify: (frame) => state.notify?.(frame) ?? false,
    sessionMetaOf: pickOption(options, 'sessionMetaOf', () => null),
    listSessionIds: pickOption(options, 'listSessionIds', () => []),
  });
  loadRegistry(state);
  return apiOf(state);
}

/* 加入域的发送面（设计 §2）：直投优先——申请与回执不进 outbox 长队列（申请时限短于队列保留期，
 * 且重发轮由加入域按短节律自理）。直投面未注入＝发送面缺失（加入域如实报错，不静默改走长队列）。 */
function joinSenderOf(state) {
  return typeof state.sendDirect === 'function' ? state.sendDirect : null;
}

/* 能力闸门（设计 §7.2；契约要求闸门落服务层）：邀请 / 申请 / 建协作前要求目标支持会话级协作。
 * 已知支持不重复探测（省一次往返）；已知不支持直接拒绝；未知先单播探测一次，仍未知按未知拒绝。
 * probeCapability 未注入（单测/降级）时不设闸——生产组合根恒定注入。 */
const CAPABILITY_SUPPORTED = 2;

async function capabilityRefusalOfTargets(state, targets) {
  if (typeof state.probeCapability !== 'function') {
    return null;
  }
  for (const target of Array.isArray(targets) ? targets : []) {
    const refusal = await capabilityRefusalOfTarget(state, target);
    if (refusal !== null) {
      return refusal;
    }
  }
  return null;
}

async function capabilityRefusalOfTarget(state, target) {
  const instanceId = typeof target?.instanceId === 'string' ? target.instanceId : null;
  if (instanceId === null) {
    return null;
  }
  const knownRefusal = knownCapabilityRefusalOf(state, instanceId);
  if (knownRefusal !== undefined) {
    return knownRefusal;
  }
  const probe = await probeCapabilitySafely(state, target, instanceId);
  return probeCapabilityRefusalOf(probe, instanceId);
}

/* 探测是外部输入：异常按「无法确认目标能力」归结果（fail-closed），不得穿出调用链。 */
async function probeCapabilitySafely(state, target, instanceId) {
  try {
    return await state.probeCapability({
      address: target.address,
      port: target.port,
      instanceId,
    });
  } catch (error) {
    state.counters.capabilityProbeFailures++;
    state.log.warn('能力探测异常（按无法确认拒绝）', { instanceId, reason: error?.message });
    return { capability: 'probe-failed', reason: error?.message ?? null };
  }
}

/* undefined＝未观测过（需探测）；null＝已知支持；对象＝已知不支持。 */
function knownCapabilityRefusalOf(state, instanceId) {
  const known = state.knownHosts?.participantsOf?.(instanceId);
  if (known === CAPABILITY_SUPPORTED) {
    return null;
  }
  return known === 0 ? unsupportedCapabilityRefusalOf(instanceId) : undefined;
}

function probeCapabilityRefusalOf(probe, instanceId) {
  if (probe?.capability === 'supported') {
    return null;
  }
  if (probe?.capability === 'unsupported') {
    return unsupportedCapabilityRefusalOf(instanceId);
  }
  if (probe?.capability === 'probe-failed') {
    return {
      ok: false,
      message: `无法确认目标驿站（${instanceId}）支持会话级协作（探测异常：${probe.reason ?? '未知原因'}）——请确认对方为 0.2.0+ 且在线后重试`,
    };
  }
  return { ok: false, message: `无法确认目标驿站（${instanceId}）支持会话级协作——请确认对方为 0.2.0+ 且在线后重试` };
}

function unsupportedCapabilityRefusalOf(instanceId) {
  return { ok: false, message: `目标驿站（${instanceId}）版本不支持会话级协作（需 0.2.0+）——无法邀请 / 申请 / 建协作` };
}

/* 加入域的邀请入口（ws_invite 的实际落点）不经过 outgoing 的 inviteMembers 闸门：
 * 服务层按同一判据补一次（已知支持放行 / 已知不支持拒绝 / 未知先探测一次）。
 * 邀请输入只携目标实例，端点由协作端点表或已知主机清单解析。 */
function createInviteWithCapability(state, input) {
  if (typeof state.probeCapability !== 'function') {
    return state.join.createInvite(input);
  }
  return (async () => {
    const refusal = await capabilityRefusalOfTargets(state, capabilityTargetsOfInvite(state, input));
    return refusal ?? state.join.createInvite(input);
  })();
}

function capabilityTargetsOfInvite(state, input) {
  const instanceId = input?.targetInstanceId;
  if (typeof instanceId !== 'string' || instanceId === '' || instanceId === state.self.instanceId) {
    return [];
  }
  const endpoint = inviteTargetEndpointOf(state, input?.collabId, instanceId);
  return [{ instanceId, address: endpoint?.address, port: endpoint?.port }];
}

function inviteTargetEndpointOf(state, collabId, instanceId) {
  const local = state.collabs.get(collabId);
  return local?.endpoints?.get?.(instanceId) ?? state.knownHosts?.lookup?.(instanceId);
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
    readonlyCollabs: new Map(),  // collabId → { reason }（recovery / 半写 / 站长席位缺失）
    legacyRejections: createLegacyRejectionCounter(),
    stagedSeq: 0,   // 暂存到达序（跨席位「丢最旧」的判据）
    stagedBySeat: new Map(),            // 协作+席位 → 暂存中的 msgId 集（判离席丢弃时落事实）
    droppedLocalDeliveries: new Map(),  // 席位+msgId → {collabId}（已丢弃的暂存事实，有界内存）
    /* 静音摘要基线（collabId + sessionId → 累计读数）：进程内，不落盘（契约 §8）；
     * 重启后为空 → 取消静音按既有降级文案（不带 N）。 */
    muteBaselines: new Map(),
    /* 本轮 leave 帧 msgId（进程内，不落盘）：核心退出冲刷时用于留痕与待发判定。 */
    stopLeaveMsgIds: new Set(),
    /* 邀请落点失败的帧标识（进程内）：sessionGate 据此抑制注入——该邀请已不可接受，
     * 注入只会让用户看到一条无法回应的待办。 */
    failedInviteFrames: new Set(),
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
    selfEndpoint: pickOption(options, 'selfEndpoint', null),
    monoClock: pickOption(options, 'monoClock', null),
    knownHosts: options.knownHosts,
    /* 待发出站查询面（组合根注入 dispatch 的只读查询）：核心退出对账只取数，不私接 net 内部结构。 */
    pendingOutboundOf: pickOption(options, 'pendingOutboundOf', null),
    /* 桥注册证据注入面（核心重启对账）：注册即回调，异常隔离不阻断绑定主链。 */
    onSessionRebound: pickOption(options, 'onSessionRebound', null),
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
    /* 显式兼容旁路：仅供尚未穿会话标识的旧调用方/旧夹具；生产组合根不得设置。
     * 默认关闭时，managed 且有席位表的治理写缺 sessionId 一律拒绝（防冒充其他会话）。 */
    legacySessionlessWrites: options.legacySessionlessWrites === true,
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
    probeCapability: pickOption(options, 'probeCapability', null),
    clock: pickOption(options, 'now', Date.now),
  };
}

/* 运行期容器（注册表 / 限频 / 转达集 / 等待面 / 抢接与握手 / 对表与 join 重播状态）。 */
function runtimeMaps() {
  return {
    collabs: new Map(),
    dispatches: new Map(),   // dispatch 内存域（与 collabs 平行：不落盘、不进注册表）
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
    inviteConsent: { challenges: new Map(), waivers: new Map(), autoAccept: new Set() },   // 邀请决定确认门（挑战 / 一次性豁免 / 会话级免同意，纯内存态）
    confirmGates: createConfirmGateState(),   // 确认门会话覆盖 / 永久令牌 / 自动批准通知（纯内存态）
  };
}

function apiOf(state) {
  return {
    hooks: hooksApiOf(state),
    start: () => startService(state),
    handshake: (options) => runHandshake(state, options ?? {}),
    /* 接管是成员侧动作（设计 §2A.6/§2A.7）：活跃成员席位即可发起，A3/A4 受理门与确认令牌另管。 */
    takeOver: (input) => forumGovernanceRejection(state, input?.collabId)
      ?? seatGovernedWrite(state, input, () => takeOver(state, input), { managerOnly: false, allowFrozen: true }),
    decide: (input) => decideApiOf(state, input),
    decideMerge: (input) => forumGovernanceRejection(state, input?.collabId)
      ?? seatGovernedWrite(state, input, () => withFreezeCleared(state, input?.collabId, () => decideMergeOffer(state, input)), { allowFrozen: true }),
    handover: (input) => forumGovernanceRejection(state, input?.collabId) ?? seatGovernedWrite(state, input, () => handover(state, input)),
    list: (input) => listCollabs(state, input),
    indicators: () => indicators(state),
    create: (input) => createNow(state, input),
    ...dispatchApiOf(state),
    invite: (input) => seatGovernedWrite(state, input, () => inviteWithCapability(state, input)),
    joinKnock: (knock) => handleJoinKnock(state, knock),   // 发现层注入面（UDP 敲门命中 → 成员侧应答与本机放行提示）
    joinResolve: (input) => resolveJoinTarget(state, input ?? {}),   // 发现层注入面（按名解析的命中回调，组合根接入）
    join: joinApiOf(state),   // 会话级加入的处置面（工具层落点）
    approve: (input) => guardedWrite(state, input?.collabId, () => approveNow(state, input)),
    allowNextInvite: (input) => guardedWrite(state, input?.collabId, () => allowNextInviteOf(state, input)),
    setConfirmGate: (input) => setConfirmGateOf(state, input),
    relayReport: (input) => applyRelayedReport(state, input),   // 网层回报注入面（转达副本达第三档 → 译回原作者）
    withdraw: (input) => seatGovernedWrite(state, input, () => withdrawInvite(state, input)),
    setMute: (input) => guardedWrite(state, input?.collabId, () => setMuteNow(state, input)),
    ...lifecycleApiOf(state),
    describe: (collabId) => describeCollab(state, collabId),
    /* 本机旁路的机器级账在出站层（发送核写入）：查询必须先看它，再回落到注入的发送调度器查询。
     * 不先查本机账时，纯本机消息根本没有 outbox 行（ws_delivery_status 返回空行集）。 */
    deliveryStatusOf: (msgId) => outgoingDeliveryStatusOf(state, msgId),
    localSeatDeliveryOf: (msgId, sessionId) => outgoingLocalSeatDeliveryOf(state, msgId, sessionId),
    /* 核心退出对账面（只读）：本轮席位移除 / leave 帧计数 + 仍在 outbox 的待发 leave msgId。 */
    stopLeaveState: () => stopLeaveStateOf(state),
    sync: (input) => syncNow(state, input),
    stats: () => statsOf(state),
    close: () => closeService(state),
    ...seatApiOf(state),
  };
}

/* dispatch 域入口（独立成组：与协作生命周期无关，避免 apiOf 超长）。
 * view 先按 dispatch 分流——它没有台账，落到 viewLedger 会造出空台账或误报未知协作。 */
function dispatchApiOf(state) {
  return {
    dispatch: state.dispatchDomain,
    /* dispatch 是纯内存域：不进 state.collabs，走既有写门会因「本机没有该协作」误拒——
     * 发送 / 结束 / 退出先按 isDispatch 分流，判定与投递全在 dispatch 域内。 */
    send: (input) => state.dispatchDomain.isDispatch(input?.collabId)
      ? state.dispatchDomain.send(input)
      : guardedWrite(state, input?.collabId, () => sendMessage(state, input)),
    end: (input) => state.dispatchDomain.isDispatch(input?.collabId)
      ? state.dispatchDomain.end(input)
      : seatGovernedWrite(state, input, () => endNow(state, input), { allowFrozen: true }),
    leave: (input) => state.dispatchDomain.isDispatch(input?.collabId)
      ? state.dispatchDomain.leave(input)
      : guardedWrite(state, input?.collabId, () => leaveNow(state, input), { allowFrozen: true }),
    view: (input) => state.dispatchDomain.isDispatch(input?.collabId)
      ? state.dispatchDomain.view(input.collabId)
      : viewLedger(state, input),
    count: () => countLiveCollabs(state) + state.dispatches.size,
  };
}

/* 冻结裁定入口：任期分叉的工具出口（设计 §2A.3）——terminate 只归档本方分支，成员席同样可执行；
 * 其余冻结裁定仍按站长制授权，不得借 terminate 越权。 */
function decideApiOf(state, input) {
  return forumGovernanceRejection(state, input?.collabId)
    ?? seatGovernedWrite(state, input, () => withFreezeCleared(state, input?.collabId, () => decide(state, input)), {
      allowFrozen: true,
      managerOnly: input?.choice !== 'terminate' || managerFreezeReasonOf(state, input?.collabId) !== 'manager-fork',
    });
}

function hooksApiOf(state) {
  return {
    admit: (frame, meta) => gateFrame(state, frame, meta),
    consume: (frame, meta) => consumeFrame(state, frame, meta),
    sessionGate: (frame, meta) => sessionGateFrame(state, frame, meta),
    sessionDelivered: (frame) => noteSessionDelivered(state, frame),
  };
}

/* 生命周期与交接面（生命周期层 → 工具面）：目标侧确认、冻结判定/解除、presence 视图与自动移交。 */
function lifecycleApiOf(state) {
  return {
    confirmHandover: (input) => guardedWrite(state, input?.collabId, () => confirmHandover(state, input)),
    rejectHandover: (input) => guardedWrite(state, input?.collabId, () => rejectHandover(state, input)),
    freezeOnManagerOffline: (collabId) => freezeOnManagerOffline(state, collabId),
    presenceSnapshot: (collabId) => presenceSnapshot(state, collabId),
    autoTransfer: (input) => forumGovernanceRejection(state, input?.collabId)
      ?? seatGovernedWrite(state, { ...input, sessionId: input?.managerSessionId }, () => autoTransfer(state, input)),
    noteSeatClosed: (collabId, sessionId, at = null) => noteSeatClosed(state, collabId, sessionId, at),
    clearFreezeReason: (collabId) => clearFreezeReason(state, collabId),
  };
}

/* 席位运行面（运行时 → 出站/加入/生命周期/工具/观察窗）：读席位、本机旁路注入、桥注册、核心存续。
 * 全部异常隔离为结果对象——席位面是投递主链的基础设施，不得让单次坏输入穿出。 */
function seatApiOf(state) {
  return {
    listLocalSeats: (collabId) => {
      const local = state.collabs.get(collabId);
      return local === undefined ? [] : listLocalSeatsOf(local);
    },
    /* 入站可注入目标（设计 §5.2）：本机活跃席位 ∪ 邀请目标（桥注册面）。邀请帧不受席位过滤——
     * 受邀会话尚未入席时没有席位文件，注入面按注册桥放行；其他帧仍只认席位。 */
    listInjectableTargets: (collabId) => listInjectableTargetsOf(state, collabId),
    localSeatOf: (collabId, sessionId) => {
      const local = state.collabs.get(collabId);
      const seat = local === undefined ? null : localSeatOfLocal(local, sessionId);
      return seat === null ? null : seatViewOf(seat);
    },
    managerSeatOf: (collabId) => {
      const local = state.collabs.get(collabId);
      const seat = local === undefined ? null : managerSeatOfLocal(local);
      return seat === null ? null : seatViewOf(seat);
    },
    /* 站长转移的席位角色迁移（移交/接管调用）：同时改席位与派生缓存并落盘。 */
    setSeatRole: (collabId, sessionId, role) => {
      const local = state.collabs.get(collabId);
      const seat = local === undefined ? null : setLocalSeatRole(local, sessionId, role);
      if (seat === null) {
        return { ok: false, reason: 'no-seat' };
      }
      return persistSeatOf(state, local, sessionId) ? { ok: true } : { ok: false, reason: 'persist-failed' };
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
    isWritable: (collabId) => writableVerdictOf(state, collabId).ok && frozenWriteRefusalOf(state, collabId) === null,
  };
}

/* 对外席位视图的单一权威在 local.js（seatViewOf）：服务层不另造一份字段表。 */

/* 会话级加入的处置面（工具层落点）：request＝发起加入（协作申请 / 讨论直连或敲门）、approve＝
 * 站长批准 / 拒绝、pendingJoinsOf 与 isGranted＝数据面与判据面（后者供核心 adopt 收紧注入）。 */
function joinApiOf(state) {
  return {
    request: (input) => guardedWrite(state, input?.collabId, () => joinRequestNow(state, input)),
    /* 批准权按批准者席位判定（input.sessionId 是申请人会话，不能拿它当授权对象）。 */
    approve: (input) => approveGovernedOf(state, input),
    pendingJoinsOf: (collabId) => state.join.pendingJoinsOf(collabId),
    isGranted: (collabId, sessionId) => state.join.isGranted(collabId, sessionId),
    /* 邀请簿记面（加入域 → 工具面）：邀请由站长会话发起/撤回，接受与确认由目标会话发起。 */
    createInvite: (input) => seatGovernedWrite(state, { ...input, sessionId: input?.managerSessionId }, () => createInviteWithCapability(state, input)),
    /* 建协首邀的簿记面（出站层 → 加入域）：不在工具面，写前校验由加入域按站长席位完成。 */
    openInitialInvite: (input) => state.join.openInitialInvite(input),
    withdrawInitialInvite: (input) => state.join.withdrawInitialInvite(input),
    withdrawInvite: (input) => seatGovernedWrite(state, { ...input, sessionId: input?.managerSessionId }, () => state.join.withdrawInvite(input)),
    /* 按目标撤回（工具面 target 参数）：0.2.0 协作的邀请在途态只在 invites.json。 */
    withdrawInviteByTarget: (input) => seatGovernedWrite(state, { ...input, sessionId: input?.managerSessionId }, () => state.join.withdrawInviteByTarget(input)),
    acceptInvite: (input) => guardedWrite(state, input?.collabId, () => state.join.acceptInvite(input)),
    /* 签名与加入域契约一致：confirmJoining(joinId, sessionId, {instanceId,managerTerm,activeSeats?})。 */
    confirmJoining: (joinId, sessionId, input) => guardedWrite(state, input?.collabId, () => state.join.confirmJoining(joinId, sessionId, input)),
    pendingJoiningProjection: (collabId) => state.join.pendingJoiningProjection(collabId),
    pendingInvitesFor: (input) => state.join.pendingInvitesFor(input),
  };
}

/* 批准入口的席位授权对象是批准者会话；批准者标识缺失/非法时交给加入域给出具体 approvedBy 错误
 * （不得先被席位门吞成「无会话标识」），但仍过写门。 */
function approveGovernedOf(state, input) {
  if (!validSessionId(input?.approvedBy)) {
    return guardedWrite(state, input?.collabId, () => joinApproveNow(state, input));
  }
  return seatGovernedWrite(state, { ...input, sessionId: input.approvedBy }, () => joinApproveNow(state, input));
}

/* 加入域两个入口的席位收尾（服务层兼容桥）：加入域以 bound（本机接线）/seated（申请人已在册）
 * 表达结果，旧 joined/member 键已不再返回——按实际返回形态收口，否则条件恒假、入席后没有本机席位。 */
function joinRequestNow(state, input) {
  if (typeof state.probeCapability === 'function' && input?.target !== undefined) {
    return joinRequestWithCapability(state, input);
  }
  return joinRequestSync(state, input);
}

async function joinRequestWithCapability(state, input) {
  const refusal = await capabilityRefusalOfTargets(state, [input.target]);
  if (refusal !== null) {
    return refusal;
  }
  return joinRequestSync(state, input);
}

function joinRequestSync(state, input) {
  return withJoinResult(state.join.request(input), (result) => {
    if (result?.ok === true && result.bound === true) {
      ensureSeatAfterJoin(state, result.collabId, result.sessionId ?? input?.sessionId, 'member');
    }
    return result;
  });
}

/* 加入域入口有的返回 Promise（request）、有的同步（approve）；席位收尾两种都要接上。 */
function withJoinResult(result, apply) {
  if (result !== null && typeof result?.then === 'function') {
    return result.then(apply);
  }
  return apply(result);
}

function joinApproveNow(state, input) {
  /* 工具面以 approvedBy 记批准者；0.2.0 两段式入口要求 managerSessionId——同一身份两种键名，
   * 在此归一（旧批准台账路径仍读 approvedBy）。 */
  const managerSessionId = input?.managerSessionId ?? input?.approvedBy;
  return withJoinResult(state.join.approve({ ...input, managerSessionId }), (result) => {
    if (result?.ok === true && result.bound === true) {
      ensureSeatAfterJoin(state, result.collabId ?? input?.collabId, result.sessionId, 'member');
    }
    return result;
  });
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

/* 入站写门（设计 §6.4）：legacy / 半写目录收到协作域帧一律拒绝并计数，不写 inbox/邀请。 */
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
    /* 加入域的三帧处理已异步化（直投发确认要等 resolve）：必须 await 到结果再回给接收管线，
     * 否则服务层的席位收尾与建立判定恒不执行。 */
    return consumed === undefined ? await joinFrameResult(state, frame) : consumed;
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
    return joinGrantResult(state, frame);
  }
  if (frame.type === 'join-deny') {
    return state.join.handleJoinDeny(frame);
  }
  if (frame.type === 'join-confirm') {
    return joinConfirmResult(state, frame);
  }
  return undefined;
}

async function joinGrantResult(state, frame) {
  const result = await state.join.handleJoinGrant(frame);
  /* 批准回执到达＝申请人会话获准：补本机席位，seatMode 的注入面才看得见它。 */
  if (result?.ok === true) {
    ensureSeatAfterJoin(state, frame.collabId, result.sessionId ?? frame.payload?.sessionId, 'member');
  }
  return result;
}

async function joinConfirmResult(state, frame) {
  const result = await state.join.handleJoinConfirm(frame);
  /* 确认写名单后由建立判定推进 proposed→active（建立规则）。 */
  const local = state.collabs.get(frame.collabId);
  if (result?.action === 'join-confirmed' && local !== undefined) {
    maybeEstablish(state, local);
  }
  return result;
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

/* 静音判定（设计 §5.4）：按收件席位逐条判定，只有内容类（post 与 POST_KINDS）受静音影响。
 * 治理 / 结束 / 邀请 / 快照 / 待办类帧在任何兜底之前直接放行——静音只做内容类减法；
 * 静音权威是席位文件的 muted（旧 mute.json 不再读取，无「协作级兜底」）。
 * 归档席位不参与注入，自然也不抑制（其收件面已退出活跃判定）。 */
function suppressForSeat(state, frame, sessionId) {
  if (isFailedInviteFrameOf(state, frame)) {
    return true;
  }
  if (!isContentFrameOf(frame)) {
    return false;
  }
  const local = state.collabs.get(frame?.collabId);
  if (local === undefined) {
    return false;
  }
  const seatId = typeof sessionId === 'string' ? sessionId : soleSeatSessionId(local);
  const seat = typeof seatId === 'string' ? localSeatOfLocal(local, seatId) : null;
  return seat !== null && seat.muted === true && !isSeatArchived(seat);
}

/* 落点失败的邀请已不可接受：不投会话（无用户提示好过一条死待办）。成功后清除标记由事件面做。 */
function isFailedInviteFrameOf(state, frame) {
  return frame?.type === 'invite' && state.failedInviteFrames instanceof Set
    && typeof frame.msgId === 'string' && state.failedInviteFrames.has(frame.msgId);
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
  /* 邀请/在途入席的生命周期清扫挂到既有 presence 节拍（takeover.runPresenceTick）：
   * 不新增定时器；清扫只触碰本机三本账，异常隔离不影响心跳。 */
  state.joinLifecycleSweep = () => {
    /* dispatch 宽限清扫搭同一节拍（不新增定时器）；纯内存域，重启即空。 */
    state.dispatchDomain?.sweep?.(state.clock());
    pruneConfirmGates(state, state.clock());
    if (confirmGateOverCap(state)) {
      state.log.warn('确认门会话覆盖超过上限（在线会话不淘汰）', {
        size: state.confirmGates.sessions.size,
        max: 256,
      });
    }
    sweepJoinLifecycle(state).catch((error) => {
      state.counters.eventFailures++;
      state.log.warn('邀请生命周期清扫异常（已隔离）', { reason: error?.message });
    });
  };
  state.joinLifecycleSweep();
}

/* 周期清扫（设计 §4.1/§4.2/§4.4.8）：过期挂起邀请置 expired、过期邀请记录整体移除、
 * 终态挂起记录按保留窗清理、未确认 grant 超时作废并回 join-deny(expired)。 */
async function sweepJoinLifecycle(state) {
  const join = state.join;
  if (typeof join !== 'object' || join === null) {
    return;
  }
  const at = Date.now();
  join.expirePendingInvites?.(at);
  join.expireInvites?.(at);
  join.pruneTerminalPending?.(at);
  await join.expireJoining?.(at);
}

/* 注册表加载：collabs/ 目录逐协作恢复（成员记录或载体文件、台账 / 快照 / 席位可选）；
 * 旧形态（0.1.x）由迁移判据归档为只读、半写目录按 recovery 只读；单条失败只计数跳过，
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
  const local = loadOne(state, collabId);
  state.collabs.set(collabId, local);
  restoreManagerFreezeRuntime(state, collabId);
}

/* 只读目录（半写 / 损坏）：半写写 recovery.json 留证；损坏只置内存标记（不改写坏数据）。 */
function recordReadonlyEntry(state, collabId, dir, kind) {
  if (kind === 'recovery') {
    const written = writeRecovery(dir, { reason: 'carrier-without-ledger' });
    if (written?.ok !== true) {
      /* 标记写失败：进程内继续按只读处理，但重启后可能失去只读证据——必须留痕。 */
      state.counters.persistFailures++;
      state.log.warn('恢复标记写入失败（本次仍按只读处理）', { collabId, reason: written?.reason ?? '未知原因' });
    }
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
  const recoveredSeat = recoverManagerSeatOf(state, carrier.carrier, loadedSeats.seats);
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
    /* 退役静音 store 的句柄：仅供尚未迁出的清理调用点（freeze/sync/takeover）使用；
     * 本模块不读写 mute.json，静音权威是席位文件的 muted。 */
    mute: retiredMuteHandle(),
    injected: createInjectedStore({ dataDir: state.dataDir, collabId, log: state.log }),
    suspended: null,
    staleManagerId: null,
  };
  applyCarrierFreezeReason(local, carrier.carrier);
  if (recoveredSeat !== null) {
    state.counters.seatRecoveredFromCarrier++;
    state.log.warn('站长席位文件缺失/损坏：按载体记录恢复内存席位（不重写损坏文件）', { collabId, sessionId: recoveredSeat.sessionId });
    upsertLocalSeat(local, recoveredSeat, { bridgeId: state.sessionBridges.get(recoveredSeat.sessionId) ?? null });
  }
  attachSeatRemovalHook(state, local);
  syncLocalRole(local);
  if (local.role === 'manager') {
    local.ledger = recoverLedger(state, collabId, local);
  }
  return local;
}

/* 所有席位移除路径（服务离席/结束、心跳超时与会话关闭直接调 removeLocalSeat）共用同一收尾。 */
function attachSeatRemovalHook(state, local) {
  if (local === null || typeof local !== 'object') {
    return;
  }
  local.onSeatRemoved = (sessionId, outcome) => noteSeatRemoval(state, local.collabId, sessionId, outcome);
}

/* 重启恢复冻结（设计 §2A.3/§6.2）：冻结原因是任期面事实，运行态容器随进程丢失；
 * 载体是权威写入面，重启后必须回填，否则站长侧「不改台账 status」的停写判据会失效。
 * 载入阶段先按原值回填本地记录；注册表登记后再由 gate 的三态词表校验并入运行态。 */
function applyCarrierFreezeReason(local, carrier) {
  const raw = carrier?.freezeReason;
  if (typeof raw !== 'string' || raw === '') {
    return;
  }
  local.freezeReason = raw;
  if (local.member !== null && typeof local.member === 'object') {
    /* 台账传播标记描述成员状态的来源，任期冻结只是叠加的停写原因：重启回填不得覆盖它，
     * 否则 authoritative active 台账到达后成员无法恢复（设计 §2A.2 C4）。 */
    if (local.member.freezeReason !== LEDGER_FROZEN_REASON) {
      local.member.freezeReason = raw;
    }
  }
}

function restoreManagerFreezeRuntime(state, collabId) {
  const local = state.collabs.get(collabId);
  if (local?.freezeReason === undefined) {
    return;
  }
  const reason = managerFreezeReasonOf(state, collabId);
  if (reason === null) {
    delete local.freezeReason;
    if (local.member !== null && typeof local.member === 'object' && local.member.freezeReason !== LEDGER_FROZEN_REASON) {
      /* 台账传播标记不随无效/缺失的任期原因一起清掉：成员仍须等 authoritative active 台账恢复。 */
      delete local.member.freezeReason;
    }
    return;
  }
  m5RuntimeOf(state).frozen.set(collabId, reason);
  /* 成员侧与运行态冻结同步（站长侧只停写，不改台账状态机——设计 §2A.3）。 */
  if (local.role === 'member' && local.member !== null && local.member.state !== 'left') {
    local.member.state = 'frozen';
  }
}

/* 站长席位文件丢失时的恢复判据（设计 §6.3/§1.1）：只有载体明确写「本站长就是本机」时才恢复，
 * sessionId 必须来自载体——绝不用 instanceId 伪造一个不存在的会话席位。 */
function recoverManagerSeatOf(state, carrier, seats) {
  for (const seat of seats.values()) {
    if (seat.role === 'manager' && seat.state === 'member') {
      return null;
    }
  }
  const manager = carrier?.manager;
  if (manager === undefined || manager === null || manager.instanceId !== state.self.instanceId || !validSessionId(manager.sessionId)) {
    return null;
  }
  return {
    version: 1,
    sessionId: manager.sessionId,
    role: 'manager',
    state: 'member',
    joinSeq: 1,
    joinedAt: new Date().toISOString(),
    muted: false,
    unverified: false,
  };
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
  if (rebuilt.ledger === null) {
    /* 无法确定站长会话标识：不得用 instanceId 伪造 sessionId（会造出一个不存在的席位）。
     * 失败安全——保留空台账并按只读处理，等人工修复席位文件。 */
    state.counters.ledgerRebuildBlocked++;
    state.readonlyCollabs.set(collabId, { reason: 'corrupt' });
    state.log.warn('台账不可用且无合法站长会话标识——按只读处理（不得伪造席位）', { collabId });
    return null;
  }
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
  const sessionId = sessionIdOfManagerSeat(local);
  if (sessionId === null) {
    return { source: 'none', ledger: null };
  }
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
  appendInviteStubEntries(state, collabs, caller);
  /* dispatch 条目与协作同列（纯内存）：agent 可见面不区分两种容器，模式字段即分派依据。 */
  collabs.push(...state.dispatchDomain.list());
  return { collabs };
}

/* 仅挂起邀请的目录（invite-stub）重启后不参与注册表加载；清单仍需让本会话看到待回应邀请
 * 与 inviteId（设计 §9）——否则核心重启后用户拿不到可回应的定位键。 */
function appendInviteStubEntries(state, collabs, caller) {
  const known = new Set(collabs.map((entry) => entry.collabId));
  for (const collabId of listLocalCollabIds(state.dataDir)) {
    if (known.has(collabId) || state.legacyViews.has(collabId)) {
      continue;
    }
    const kind = classifyCollabDir(collabDir(state.dataDir, collabId)).kind;
    if (kind !== 'invite-stub') {
      continue;
    }
    const entry = inviteStubListEntryOf(state, collabId, caller);
    if (entry !== null) {
      collabs.push(entry);
    }
  }
}

function inviteStubListEntryOf(state, collabId, caller) {
  const pendingInvites = pendingInvitesOf(state, collabId, caller);
  if (pendingInvites.length === 0) {
    return null;
  }
  const carrier = readCarrier(collabDir(state.dataDir, collabId)).carrier;
  if (carrier === null) {
    return null;
  }
  return {
    collabId,
    name: carrier.name ?? collabId,
    role: 'member',
    mode: carrier.mode ?? 'managed',
    state: 'proposed',
    version: null,
    memberCount: 0,
    seatCount: 0,
    muted: false,
    archived: false,
    managerOffline: false,
    frozenUnresolved: false,
    suspended: false,
    handshakeUnresolved: false,
    decision: null,
    invitedAt: carrier.createdAt ?? null,
    expiresAt: pendingInvites[0].expiresAt,
    expired: pendingInvites.every((invite) => invite.expired),
    sessionGranted: false,
    sessionBound: false,
    pendingJoins: [],
    pendingInvites,
  };
}

/* 旧协作的只读列表项（设计 §10）：状态按 completed 展示，内容取自迁移只读读取器。 */
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
    pendingInvites: [],
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

/* 成员数读数：讨论 = 本机席位＋远端席位（与观察窗同源的席位口径，设计 §10）；
 * managed = 台账/定格名单（既有口径不变）。 */
function memberCountOf(state, local) {
  if (localModeOf(local) === 'forum') {
    return forumSeatCountOf(state, local);
  }
  return localRosterOf(local).length;
}

/* 讨论人数按席位计：本机活跃席位 + 成员事件折叠出的远端席位。本机行按会话标识排除，
 * 无会话标识的旧事件按实例排除（仅在本机确有席位时）——否则同机双席会重复计数。 */
function forumSeatCountOf(state, local) {
  const localSeats = listLocalSeatsOf(local);
  const localIds = new Set(localSeats.map((seat) => seat.sessionId));
  const remote = activeForumSeatEventsOf(local)
    .filter((event) => !isOwnForumEvent(state, event, localIds, localSeats.length > 0));
  return localSeats.length + remote.length;
}

/* 按席位键（实例 + 会话）取最新事件，只有最新仍为 join 者才算在席（leave 后不得残留）。 */
function activeForumSeatEventsOf(local) {
  const latest = new Map();
  for (const event of local.members.events()) {
    const key = forumSeatKeyOf(event);
    const held = latest.get(key);
    if (held === undefined || compareForumEvents(event, held) > 0) {
      latest.set(key, event);
    }
  }
  return [...latest.values()].filter((event) => event.kind === 'join');
}

function forumSeatKeyOf(event) {
  const sessionId = typeof event.sessionId === 'string' && event.sessionId !== '' ? event.sessionId : null;
  return sessionId === null ? event.instanceId : `${event.instanceId}/${sessionId}`;
}

function compareForumEvents(left, right) {
  const byTs = Date.parse(left.ts) - Date.parse(right.ts);
  if (byTs !== 0) {
    return byTs;
  }
  if (left.eventId === right.eventId) {
    return 0;
  }
  return left.eventId < right.eventId ? -1 : 1;
}

function isOwnForumEvent(state, event, localIds, hasLocalSeats) {
  if (typeof event.sessionId === 'string' && event.sessionId !== '') {
    return localIds.has(event.sessionId);
  }
  return hasLocalSeats && event.instanceId === state.self.instanceId;
}

/* 静音按席位聚合（设计 §5.4/§10）：只统计活跃席位——归档席位是历史，不参与静音展示。 */
function mutedOf(local) {
  return listLocalSeatsOf(local).some((seat) => seat.muted && seat.archived !== true);
}

function listEntryOf(state, local, now, caller) {
  const stateName = localStateOf(local);
  const probeState = state.probes.get(local.collabId);
  const freezeReason = freezeReasonOfLocal(local);
  const seatCount = memberCountOf(state, local);
  return {
    collabId: local.collabId,
    name: localNameOf(local),
    role: local.role,
    mode: localModeOf(local),
    state: stateName,
    version: local.role === 'manager' ? (local.ledger?.version ?? null) : (local.snapshot === null ? null : local.snapshot.version),
    memberCount: seatCount,
    /* 席位口径人数（讨论 = 本机席位 + 远端席位；managed = 名单行）：供观察窗/状态栏同源取数。 */
    seatCount,
    muted: mutedOf(local),
    /* 条目顶层冻结原因（工具/状态栏契约字段）；sessions.freezeReason 保留兼容。 */
    ...(freezeReason === null ? {} : { freezeReason }),
    /* 本机席位表（状态栏按会话呈现的唯一来源）：身份名取本机展示名，会话标识保持全量——
     * 状态栏侧按短码精确匹配本会话。冻结原因随 sessions 下发（只读展示面）。 */
    sessions: sessionsViewOf(state, local),
    archived: isArchived(stateName),
    managerOffline: local.role === 'manager' ? false : (probeState?.offline === true),
    frozenUnresolved: local.freezeDeadlineNotified === true,
    suspended: local.suspended !== null,
    handshakeUnresolved: local.handshakeUnresolved === true,
    ...inviteViewOf(local, now),
    ...sessionViewOf(state, local, caller),
    ...pendingJoinsViewOf(state, local),
    pendingInvites: pendingInvitesOf(state, local.collabId, caller),
  };
}

/* 待回应邀请（本会话可见面）：inviteId 是回应工具的定位键，必须随清单下发。
 * 取数面异常按空面处置（清单不因附属机制失败而失败）。 */
function pendingInvitesOf(state, collabId, caller) {
  if (caller === null || typeof state.join?.pendingInviteList !== 'function') {
    return [];
  }
  try {
    return state.join.pendingInviteList({ collabId, sessionId: caller.sessionId });
  } catch (error) {
    state.counters.loadFailures++;
    state.log.warn('待回应邀请取数失败（按空面继续）', { collabId, reason: error.message });
    return [];
  }
}

/* 状态栏会话视图：本机席位表 + 冻结原因（只读展示面；无冻结原因时省略字段）。 */
function sessionsViewOf(state, local) {
  const view = { localSeats: localSeatEntriesOf(state, local) };
  const freezeReason = freezeReasonOfLocal(local);
  if (freezeReason !== null) {
    view.freezeReason = freezeReason;
  }
  return view;
}

function freezeReasonOfLocal(local) {
  const reason = local.freezeReason ?? local.member?.freezeReason ?? local.ledger?.freezeReason;
  /* 'ledger' 是成员状态的来源标记，不是任期三态词表里的停写原因：展示面按「无原因」输出
   * （冻结本身已由状态呈现），避免把内部标记原样透给用户。 */
  return typeof reason === 'string' && reason.trim() !== '' && reason.trim() !== LEDGER_FROZEN_REASON ? reason.trim() : null;
}

/* 状态栏席位视图：本机活跃席位的稳定字段集（不暴露暂存/inbox 等运行态）。
 * 归档席位（终态历史）不在此面——状态栏的「协作中」判定以活跃席位为准。 */
function localSeatEntriesOf(state, local) {
  return listLocalSeatsOf(local)
    .filter((seat) => seat.archived !== true)
    .map((seat) => ({
      sessionId: seat.sessionId,
      identityName: state.self.identityName,
      role: seat.role,
      state: seat.state,
      joinSeq: seat.joinSeq,
      muted: seat.muted === true,
    }));
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
  /* dispatch 先判：它不在 state.collabs 里，但同样是本机已知容器（上下文头项目名与模式）。 */
  const dispatched = state.dispatchDomain.describe(collabId);
  if (dispatched !== null) {
    return dispatched;
  }
  const local = state.collabs.get(collabId);
  if (local === undefined) {
    return null;
  }
  return { name: localNameOf(local), mode: localModeOf(local) };
}

/* 核心退出对账面（只读）：计数取自本轮运行态，待发列表经注入的 dispatch 查询现取——
 * 跨轮残留的 outbox leave 同样可见（重启补发的判据）。查询面未注入时如实返回空列表。 */
function stopLeaveStateOf(state) {
  const pending = typeof state.pendingOutboundOf === 'function'
    ? state.pendingOutboundOf({ type: 'leave' })
    : [];
  return {
    removedSeats: state.counters.seatRemovals,
    leaveFramesSent: state.counters.leaveFramesSent,
    leaveMsgIds: [...state.stopLeaveMsgIds],
    pendingLeaveMsgIds: pending.map((row) => row.msgId),
  };
}

function statsOf(state) {
  const byState = {};
  for (const local of state.collabs.values()) {
    const stateName = localStateOf(local);
    byState[stateName] = (byState[stateName] ?? 0) + 1;
  }
  return { collabs: state.collabs.size, dispatchCount: state.dispatches.size, byState, ...state.counters, ...state.legacyRejections.read() };
}

/* 邀请回应的驱动面（讨论）：同意即加入后立即起一轮回填对表（复用周期对表的同一入口）——
 * 新人不必等下一个周期节拍（默认 60s）才看到历史。让出到微任务边界再起：本机这一回合的外发
 * 次序为 join 自播先、对表请求后（应答方准入按「请求方在成员表内」把关——请求先到会被拒）。
 * 点头前先过指名判定（指名邀请只有该会话能点头）。 */
/* 邀请确认豁免（工具面登记；核心重启即失效）：缺省 once＝一次性；session＝本会话持续免同意；
 * off＝关闭持续豁免；status＝查询。拒绝邀请始终走确认门——会话级开关只免「同意」。 */
function allowNextInviteOf(state, input) {
  const sessionId = typeof input?.sessionId === 'string' && input.sessionId !== '' ? input.sessionId : null;
  if (sessionId === null) {
    return { ok: false, message: '无会话标识——无法登记邀请确认豁免' };
  }
  return applyInviteWaiverMode(state, sessionId, input?.mode ?? 'once');
}

function applyInviteWaiverMode(state, sessionId, mode) {
  if (mode === 'once') {
    grantInviteWaiver(state, { sessionId });
    return { ok: true, enabled: false, note: '已登记一次性豁免：下一次同意 / 拒绝邀请将直接生效（消耗后失效；核心重启亦失效）' };
  }
  if (mode === 'session') {
    setSessionGate(state, sessionId, 'invite', false, state.clock());
    return { ok: true, enabled: true, note: '已开启会话级免确认：本会话同意邀请将直接生效（拒绝仍需确认）；会话结束、核心重启或用 off 关闭' };
  }
  if (mode === 'off') {
    setSessionGate(state, sessionId, 'invite', true, state.clock());
    return { ok: true, enabled: false, note: '已关闭会话级免确认：同意邀请恢复逐条确认' };
  }
  if (mode === 'status') {
    const enabled = gateValueOf(state, sessionId, 'invite').effectiveValue === false;
    return { ok: true, enabled, note: enabled ? '会话级免确认已开启（只免同意；拒绝仍需确认）' : '会话级免确认未开启' };
  }
  return { ok: false, message: `mode 非法（可取值：once / session / off / status）：${String(mode)}` };
}

function approveNow(state, input) {
  /* 邀请回应必须由具体会话发起：无会话同意会把 invite-stub 升级为 session-seats 却写不出席位，
   * 目录随后被判「carrier 无台账」永久只读。拒绝必须在任何载体升级 / 目录写入之前。 */
  if (!validSessionId(input?.sessionId)) {
    return {
      ok: false,
      message: '缺少调用会话标识（sessionId）——同意 / 拒绝邀请必须由具体会话发起；无会话不产生机器级回应，也不会改写协作目录',
    };
  }
  const refusal = namedInviteRefusalOf(state, input);
  if (refusal !== null) {
    return refusal;
  }
  /* 0.2.0 两段式：带 inviteId 的同意走加入域的邀请接受（校验邀请簿记 → 签发 join-grant）；
   * 带 inviteId 的拒绝同样走加入域（消费挂起邀请 ＋ 补发 decline 帧）——旧 approveInvite 只做
   * 机器级「回应已记录」，不认会话级邀请簿记，会把拒绝误判为「不在待回应邀请状态」。 */
  if (isSeatInviteDecision(input)) {
    return seatInviteDecisionOf(state, input);
  }
  return approveLegacyOf(state, input);
}

function seatInviteDecisionOf(state, input) {
  return input.approve === true ? acceptSeatInviteNow(state, input) : declineSeatInviteNow(state, input);
}

/* 旧路径的同意收尾：升级讨论落点并按需要触发一轮回填对表；拒绝或无加入不触发。 */
function approveLegacyOf(state, input) {
  const result = approveInvite(state, input);
  if (result.ok === true && result.joined === true) {
    const local = state.collabs.get(input?.collabId);
    if (local !== undefined) {
      upgradeJoinedCarrierOf(state, local, input?.sessionId);
      settleKnockedSession(state, local, input?.sessionId);
      queueMicrotask(() => {
        triggerSync(state, local, { reason: 'join-decided' });
      });
    }
  }
  return result;
}

/* 讨论同意即入席：落点从 invite-stub 升级为 session-seats（设计 §4.2）。升级归加入域，
 * 本层只在同意成功后触发；失败只计数告警——下一步的重启会把未升级的讨论按占位跳过，
 * 因此必须留痕而不是静默。 */
function upgradeJoinedCarrierOf(state, local, sessionId) {
  if (typeof state.join?.ensureJoinedCarrier !== 'function') {
    return;
  }
  try {
    state.join.ensureJoinedCarrier(local.collabId, sessionId);
  } catch (error) {
    state.counters.eventFailures++;
    state.log.warn('讨论落点载体升级异常（已隔离）', { collabId: local.collabId, reason: error?.message });
  }
}

/* 席位邀请的决定（0.2.0 两段式）：邀请簿记校验与 join-grant 签发在加入域；本层只保留
 * 用户确认门（与旧路径同一份一次性挑战/豁免）并接席位收尾。带 inviteId 的布尔决定
 * （同意 / 拒绝）都走加入域；非布尔真值保留旧路径语义。 */
function isSeatInviteDecision(input) {
  return typeof input?.inviteId === 'string' && input.inviteId !== ''
    && (input.approve === true || input.approve === false);
}

async function acceptSeatInviteNow(state, input) {
  const local = state.collabs.get(input?.collabId);
  if (local === undefined) {
    return acceptSeatInviteWithoutLocalOf(state, input);
  }
  const consent = inviteAcceptanceConsentOf(state, {
    collabId: local.collabId, sessionId: input.sessionId, confirmToken: input.confirmToken, approve: input.approve,
    invite: inviteSummaryOfLocal(local),
  });
  if (consent !== null) {
    return consent;
  }
  const result = await state.join.acceptInvite({ collabId: input.collabId, inviteId: input.inviteId, sessionId: input.sessionId });
  if (result?.ok === true && result.bound === true) {
    ensureSeatAfterJoin(state, result.collabId ?? input.collabId, result.sessionId ?? input.sessionId, 'member');
  }
  return result;
}

/* 重启后的邀请落点：invite-stub 不参与注册表加载（设计 §4.2：首次真正入席才升级），
 * 但挂起邀请仍在盘上——本地无参与记录时照样走加入域（邀请簿记是唯一权威），
 * 只在挂起记录确实不存在时才退回旧路径的「本机没有该协作」错误面。 */
async function acceptSeatInviteWithoutLocalOf(state, input) {
  /* 已接受过的记录不再由 pendingInvitesFor 冒泡：重复接受（approve/grant 丢帧或重启后重试）
   * 必须仍进入加入域，由 alreadyAcceptedInviteOf 决定幂等或重发 approve。 */
  const pending = pendingInviteRecordOf(state, input) ?? acceptedInviteRecordOf(state, input);
  if (pending === null) {
    return approveInvite(state, input);
  }
  const consent = inviteAcceptanceConsentOf(state, {
    collabId: input.collabId, sessionId: input.sessionId, confirmToken: input.confirmToken, approve: input.approve,
    invite: pendingInviteSummaryOf(state, pending),
  });
  if (consent !== null) {
    return consent;
  }
  const result = await state.join.acceptInvite({ collabId: input.collabId, inviteId: input.inviteId, sessionId: input.sessionId });
  if (result?.ok === true && result.bound === true) {
    ensureSeatAfterJoin(state, result.collabId ?? input.collabId, result.sessionId ?? input.sessionId, 'member');
  }
  return result;
}

/* 席位邀请的拒绝：与同意共用同一份一次性挑战 / 豁免（拒绝同样是有后果的用户决定）；拒绝不产生
 * 席位，故不做载体升级与对表触发，只把本地拒绝与 decline 帧交给加入域。
 * 重启后本地无记录同样以挂起邀请为准（拒绝也要能经工具面送达发起侧）。 */
async function declineSeatInviteNow(state, input) {
  const local = state.collabs.get(input?.collabId);
  const pending = local === undefined ? pendingInviteRecordOf(state, input) : null;
  if (local === undefined && pending === null) {
    return { ok: false, message: '本机没有该协作（collabId 不存在）——无从拒绝该邀请' };
  }
  const consent = inviteAcceptanceConsentOf(state, {
    collabId: input.collabId, sessionId: input.sessionId, confirmToken: input.confirmToken, approve: input.approve,
    invite: local === undefined ? pendingInviteSummaryOf(state, pending) : inviteSummaryOfLocal(local),
  });
  if (consent !== null) {
    return consent;
  }
  return state.join.declineInvite({
    collabId: input.collabId, inviteId: input.inviteId, sessionId: input.sessionId, reason: input.reason,
  });
}

function pendingInviteRecordOf(state, input) {
  if (!canLookupPendingInviteOf(state, input)) {
    return null;
  }
  try {
    return state.join.pendingInvitesFor({ collabId: input.collabId, sessionId: input.sessionId, inviteId: input.inviteId })[0] ?? null;
  } catch (error) {
    state.counters.loadFailures++;
    state.log.warn('挂起邀请取数失败（按无记录处置）', { collabId: input?.collabId, reason: error?.message });
    return null;
  }
}

function canLookupPendingInviteOf(state, input) {
  return typeof state.join?.pendingInvitesFor === 'function'
    && typeof input?.inviteId === 'string' && typeof input?.sessionId === 'string';
}

/* 已接受记录的原始取数（不受「已接受」过滤）：给重复接受一条仍能进入加入域的路。 */
function acceptedInviteRecordOf(state, input) {
  if (typeof state.join?.acceptedInvite !== 'function' || !canLookupPendingInviteOf(state, input)) {
    return null;
  }
  try {
    return state.join.acceptedInvite({ collabId: input.collabId, sessionId: input.sessionId, inviteId: input.inviteId });
  } catch (error) {
    state.counters.loadFailures++;
    state.log.warn('已接受邀请取数失败（按无记录处置）', { collabId: input?.collabId, reason: error?.message });
    return null;
  }
}

/* 挂起记录没有展示名，名称/主题取邀请落点载体（邀请到达时已定格）。 */
function pendingInviteSummaryOf(state, pending) {
  const carrier = readCarrier(collabDir(state.dataDir, pending.collabId)).carrier;
  const manager = pending.fromManager;
  const managerName = carrier?.manager?.instanceId === manager.instanceId
    ? carrier.manager.identityName
    : manager.instanceId;
  return {
    collabId: pending.collabId,
    name: carrierFieldOf(carrier, 'name', pending.collabId),
    mode: carrierFieldOf(carrier, 'mode', 'managed'),
    topic: carrierFieldOf(carrier, 'topic', null),
    manager: { instanceId: manager.instanceId, identityName: managerName },
    invitedAt: carrierFieldOf(carrier, 'createdAt', null),
    expiresAt: new Date(pending.expiresAt).toISOString(),
  };
}

function carrierFieldOf(carrier, key, fallback) {
  const value = carrier?.[key];
  return value === undefined || value === null ? fallback : value;
}

function inviteAcceptanceConsentOf(state, { collabId, sessionId, confirmToken, approve, invite }) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    return null;
  }
  if (approve === true && gateValueOf(state, sessionId, 'invite').effectiveValue === false) {
    return null;   // 会话级免确认只免「同意」：拒绝始终是有后果的用户决定
  }
  if (consumeInviteWaiver(state, { sessionId }) || consumeInviteChallenge(state, { sessionId, collabId, token: confirmToken })) {
    return null;
  }
  return {
    ok: false,
    needsUserConfirmation: true,
    confirmToken: issueInviteChallenge(state, { sessionId, collabId }),
    invite,
    message: `${approve === false ? '拒绝' : '同意'}邀请需要用户明确确认：请把邀请信息转述给用户，取得明确同意后携带 confirmToken 重试；若用户明确表示下一次无需确认，可先用 ws_allow_next_invite 登记一次性豁免（mode=once），或按用户要求开启会话级免同意（mode=session）`,
  };
}

function inviteSummaryOfLocal(local) {
  const manager = local.member?.manager;
  return {
    collabId: local.collabId,
    name: localNameOf(local),
    mode: localModeOf(local),
    topic: local.member?.topic ?? null,
    manager: manager === undefined ? null : { instanceId: manager.instanceId, identityName: manager.identityName },
    invitedAt: local.member?.invitedAt ?? null,
    expiresAt: local.member?.expiresAt ?? null,
  };
}

/* 敲门登记的本会话接线（讨论「加入后本会话接线」的收口）：同意门的写点（放行者席位）在 handler
 * 之后才落，故本步以宏任务让位——登记在册的请求会话最终持席（放行者即请求会话时＝幂等重写）。
 * acceptedSessionId 是本次点头的会话：加入域据此拒绝替「未同意的敲门者」建席（防幽灵席位）。
 * 无登记 / 非讨论 / 计时器不可用一律空转（既有行为不变）；计时器不阻止进程退出。 */
function settleKnockedSession(state, local, acceptedSessionId = null) {
  const bind = () => {
    try {
      const sessionId = state.join.bindKnockedSession(local, acceptedSessionId);
      if (typeof sessionId === 'string') {
        ensureSeatAfterJoin(state, local.collabId, sessionId, 'member');
      }
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
 * 目标按完整标识全等或 8 位短码全等匹配（matchSessionByToken，不做前缀展开）。null＝无指名 /
 * 未指名：交既有路径。
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

/* 点头会话与指名的比对：完整标识全等 / 8 位短码全等（精确匹配，不做前缀展开）。
 * 与邀请记录、接收侧共用 matchSessionByToken 的同一口径，避免同一短码在不同面判出不同结果。 */
function targetSessionMatches(target, sessionId) {
  return sessionId !== null && (sessionId === target || matchSessionByToken([{ sessionId }], target) === sessionId);
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
 * 取消时（真翻转）经 notifyLocal 投一行错过内容摘要——N = 当前累计 − 基线（基线进程内按席位记录，
 * 不落盘；进程重启后缺失即降级）；累计面：讨论 = 帖子列表 size（含回填帖）、
 * 协作 = 内容消息计数（与状态栏读数同一取数面）。
 * 基线缺失（重启 / 累计面不可用）时摘要降级为不带 N 的表述——宁可不给数、不给错数。
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
  /* 静音只改「本会话席位」：无会话标识的调用不猜唯一席位（设计 §5.4）——仅显式兼容开关放行。 */
  if (!validSessionId(input?.sessionId) && state.legacySessionlessWrites !== true) {
    return { ok: false, message: '缺少调用会话标识（sessionId）——静音按会话席位设置，不能按整机或唯一席位推断' };
  }
  if (seatsOfLocal(local).size === 0) {
    /* 静音按会话席位：无席位（受邀未同意 / 旧路径）没有可改的对象。mute.json 已退役——
     * 只由旧协作读取面只读回退，新代码不再写（设计 §5.4/§6.2）。 */
    return { ok: false, message: '本会话在该协作尚未入席——静音按会话席位设置，入席后重试' };
  }
  return setSeatMuteNow(state, local, input, muted);
}

/* 无显式调用会话时的兼容取数：本机恰一席＝该席（多席必须显式；工具面已穿会话标识）。 */
function soleSeatSessionId(local) {
  const seats = [...seatsOfLocal(local).values()];
  return seats.length === 1 ? seats[0].sessionId : null;
}

/* 席位级静音（设计 §5.4）：只改调用会话自己的席位并落盘；无该席拒绝（不静默改他人/整机）。
 * 静音窗口基线记录在进程内（按 collabId + sessionId）：设静音时记当下累计，重复设静音不重置；
 * 取消时算差值并删除基线。基线缺失（进程重启 / 计数取不到）时摘要降级为不带 N 的文案。
 * 归档席位只供历史查看，不再是静音操作的对象。 */
function setSeatMuteNow(state, local, input, muted) {
  const sessionId = typeof input?.sessionId === 'string' ? input.sessionId : soleSeatSessionId(local);
  const seat = typeof sessionId === 'string' ? localSeatOfLocal(local, sessionId) : null;
  if (seat === null) {
    return { ok: false, message: '本会话在该协作没有席位——静音按会话设置，不能改其他会话' };
  }
  if (isSeatArchived(seat)) {
    return { ok: false, message: '该协作已归档——席位仅作历史查看，不能再改静音' };
  }
  const countNow = contentCountOf(local);
  const wasMuted = seat.muted === true;
  if (muted === true) {
    rememberMuteBaselineIfAbsent(state, local.collabId, sessionId, countNow);
  }
  const baseline = muted === false ? takeMuteBaseline(state, local.collabId, sessionId) : null;
  seat.muted = muted;
  persistSeatOf(state, local, sessionId);
  notifyIndicatorChange(state);
  if (muted === false && wasMuted) {
    notifyLocal(state, local, resumeNoticeText(local, countNow, baseline));
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

/* 写门（设计 §6.4）：服务入口的单一 assertWritable。**每次写/入站前重新判档**——
 * 一次正判定不是永久事实：运行中台账被清空、carrier 被删都可能把目录变成 recovery/corrupt，
 * 缓存放行会让写门在端到端路径上失效。判定只读几个小文件，量级可接受。 */
function writableVerdictOf(state, collabId) {
  if (!validCollabId(collabId)) {
    return { ok: true };
  }
  if (state.legacyViews.has(collabId)) {
    return { ok: false, reason: 'legacy' };
  }
  const dir = collabDir(state.dataDir, collabId);
  const kind = classifyCollabDir(dir).kind;
  /* 内存只读标记与文件标记同等权威（设计 §6.4）：目录判档可能仍是 session-seats
   * （carrier＋seats 都在），但台账不可用/无法重建的标记只在内存——不得只凭目录放行。
   * 只有本机台账确实恢复（站长侧 ledger 非空）且目录仍是 session-seats 才清除标记。 */
  const memoryVerdict = state.readonlyCollabs.get(collabId);
  if (memoryVerdict !== undefined) {
    if (!readonlyMemoryClearedOf(state, collabId, kind)) {
      return { ok: false, reason: memoryVerdict.reason };
    }
  }
  const legacyVerdict = legacyWriteVerdictOf(state, collabId, dir, kind);
  if (legacyVerdict !== null) {
    return legacyVerdict;
  }
  if (kind === 'recovery') {
    rememberReadonly(state, collabId, { ok: false, reason: 'recovery' });
    return { ok: false, reason: 'recovery' };
  }
  if (kind === 'corrupt') {
    rememberReadonly(state, collabId, { ok: false, reason: 'corrupt' });
    return { ok: false, reason: 'corrupt' };
  }
  /* 目录已恢复可写：清掉此前记下的只读标记，避免一次瞬时坏态永久锁死该协作。 */
  state.readonlyCollabs.delete(collabId);
  return assertWritable(dir);
}

/* legacy 判定：本进程刚落地的邀请目录在载体尚未写成时会短暂只剩 member.json——
 * 它在启动判定里不可能以 legacy 出现（启动时 legacy 目录不会进 state.collabs），故仅对
 * 「明确的邀请落点」放行；任何已有席位/快照证据的成员目录或站长目录一律按 legacy 拒绝
 * （fail-closed：运行中丢了 carrier 的真实成员目录不得被当成邀请落点）。
 * 返回 null＝不是 legacy 类判定。 */
function legacyWriteVerdictOf(state, collabId, dir, kind) {
  if (kind !== 'legacy' && kind !== 'archived-legacy') {
    return null;
  }
  if (state.collabs.has(collabId) && isInviteLandingDir(dir)) {
    return { ok: true };
  }
  rememberReadonly(state, collabId, { ok: false, reason: 'legacy' });
  return { ok: false, reason: 'legacy' };
}

/* 邀请落点形态（收紧）：成员角色（role=member）的成员记录 ＋ 挂起邀请 ＋ 无共享台账，
 * 且尚无席位 / 快照证据——两段式 grant 会先写 seats/ 再收确认，所以「有席位目录」只能说明
 * 这是已经真正入席过的成员目录（运行中丢了 carrier），必须按 legacy 拒绝。
 * 站长目录（role=manager）同样不在放行面内。 */
function isInviteLandingDir(dir) {
  if (!existsSync(join(dir, MEMBER_FILE_NAME)) || existsSync(join(dir, LEDGER_FILE_NAME))) {
    return false;
  }
  if (existsSync(join(dir, SEATS_DIR_NAME)) || existsSync(join(dir, SNAPSHOT_FILE_NAME))) {
    return false;
  }
  if (!existsSync(join(dir, PENDING_INVITES_FILE_NAME))) {
    return false;
  }
  return memberRoleOfDir(dir) === 'member';
}

/* 只取成员记录的角色作落点线索（形态校验归加载面；读不出即不放行）。 */
function memberRoleOfDir(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, MEMBER_FILE_NAME), 'utf8'))?.role ?? null;
  } catch {
    return null;
  }
}

/* 内存只读标记的复核：目录回到 session-seats 且本机台账可用才可解除（失败安全）。
 * 成员侧没有台账（ledger 恒 null），目录形态与席位证据成立即可；站长侧必须有台账。 */
function readonlyMemoryClearedOf(state, collabId, kind) {
  if (kind !== 'session-seats') {
    return false;
  }
  const local = state.collabs.get(collabId);
  if (local === undefined) {
    return false;
  }
  if (local.role !== 'member' && local.ledger === null) {
    return false;
  }
  state.readonlyCollabs.delete(collabId);
  return true;
}

function rememberReadonly(state, collabId, verdict) {
  if (verdict.reason === 'recovery') {
    if (!state.readonlyCollabs.has(collabId)) {
      state.counters.recoveryCollabs++;
    }
    state.readonlyCollabs.set(collabId, { reason: 'recovery' });
  } else if (verdict.reason === 'corrupt') {
    if (!state.readonlyCollabs.has(collabId)) {
      state.counters.corruptCollabs++;
    }
    state.readonlyCollabs.set(collabId, { reason: 'corrupt' });
  } else if (verdict.reason === 'legacy' && !state.legacyViews.has(collabId)) {
    const summary = readLegacyCollab(collabDir(state.dataDir, collabId));
    state.legacyViews.set(collabId, summary ?? legacyFallbackSummary(collabId));
    state.counters.legacyCollabs++;
  }
}

function legacyFallbackSummary(collabId) {
  return { legacy: true, readOnly: true, collabId, name: null, topic: null, mode: 'managed', state: 'completed', memberCount: 0, roster: [], warnings: [] };
}

function guardedWrite(state, collabId, run, { allowFrozen = false } = {}) {
  const frozen = frozenWriteRefusalOf(state, collabId);
  if (!allowFrozen && frozen !== null) {
    return { ok: false, message: frozen };
  }
  const verdict = writableVerdictOf(state, collabId);
  if (verdict.ok) {
    return run();
  }
  state.legacyRejections.noteWrite();
  return { ok: false, message: readonlyWriteMessageOf(verdict.reason) };
}

/* 裁定成功后清除冻结原因（冻结已解除/终结；载体与成员记录同步清理）。 */
function withFreezeCleared(state, collabId, run) {
  const result = run();
  if (result?.ok === true && typeof collabId === 'string') {
    clearFreezeReason(state, collabId);
  }
  return result;
}

/* 治理写按**调用席位**授权（设计 §3.4/§5.1「站长＝会话」）：同机成员席不得 end/invite/裁定/移交。
 * 缺显式会话标识默认拒绝；仅构造选项 legacySessionlessWrites 可供尚未穿参的旧调用方显式开启兼容。
 * 讨论无站长语义、无席位表的历史路径不在此层拦截。 */
function seatGovernedWrite(state, input, run, options = {}) {
  return guardedWrite(state, input?.collabId, () => seatAuthRefusalOf(state, input, options) ?? run(), options);
}

function seatAuthRefusalOf(state, input, { key = 'sessionId', managerOnly = true } = {}) {
  const subject = seatAuthSubjectOf(state, input, key);
  if (subject === null) {
    return null;
  }
  if (subject.refusal !== undefined) {
    return subject.refusal;
  }
  return seatRoleRefusalOf(subject.seat, managerOnly);
}

/* 授权对象：本机已知、managed、有席位表时必须有显式会话标识——没有标识就没有可核对席位，
 * 不得按整机或「唯一席位」推断（绕过工具面的调用方同样收口）。显式兼容旁路由构造选项开启，
 * 仅供旧调用方/旧夹具；讨论无站长、旧路径无席位仍返回 null＝不在此层拦截。 */
function seatAuthSubjectOf(state, input, key) {
  const local = state.collabs.get(input?.collabId);
  if (local === undefined || localModeOf(local) === 'forum' || seatsOfLocal(local).size === 0) {
    return null;
  }
  const sessionId = input?.[key];
  if (!validSessionId(sessionId)) {
    if (state.legacySessionlessWrites === true) {
      return null;
    }
    return { refusal: { ok: false, message: '本会话无会话标识（CLAUDE_CODE_SESSION_ID 缺失）——不能执行协作治理操作；请重开会话或检查客户端环境' } };
  }
  return { seat: localSeatOfLocal(local, sessionId) };
}

function seatRoleRefusalOf(seat, managerOnly) {
  if (seat === null) {
    return { ok: false, message: '本会话在该协作没有席位——不能代替其他会话执行该操作' };
  }
  if (seat.state !== 'member') {
    return { ok: false, message: '本会话尚未入席（joining / unverified）——不能执行该操作' };
  }
  if (managerOnly && seat.role !== 'manager') {
    return { ok: false, message: '只有站长席位可以执行该操作——成员会话请让站长处理' };
  }
  return null;
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

/* 新建的成功收尾：席位登记（本机席位态的唯一写点之一）＋载体兜底。
 * 无会话标识不得创建（设计 §1.1）：没有站长席位就没有可派生的站长，邀请与注入全部失效。
 * carrier-first 与成员/台账硬前置归 createCollab（出站层）：carrier 先写，成员/台账写失败即
 * 中止创建；本层只在出站层成功后补登创建者席位，并兜底检查载体（缺失时写 recovery 标记，
 * 不留「无 carrier、有 member.json」的目录，否则重启会被判 legacy 永久归档）。 */
function createNow(state, input) {
  /* dispatch 是纯内存建域，与 LAN 目标无关：必须先于能力探测分流——生产组合根恒定注入
   * probeCapability，先走探测会拿空 targets 空等两轮并被误拒。 */
  const dispatched = createDispatchNow(state, input);
  if (dispatched !== null) {
    return dispatched;
  }
  if (typeof state.probeCapability === 'function') {
    return createNowWithCapability(state, input);
  }
  return createNowSync(state, input);
}

/* dispatch 创建分支（createNow 与 createNowSync 共用同一判据）：非 dispatch 返回 null 交回原路径；
 * dispatch 不接受 targets（首建后由 master 用 ws_dispatch_claim 收编），且必须有会话标识。 */
function createDispatchNow(state, input) {
  if (input?.mode !== 'dispatch') {
    return null;
  }
  if (input.targets !== undefined) {
    return { ok: false, message: 'dispatch 模式不接受 targets——首建后由 master 用 ws_dispatch_claim 收编' };
  }
  if (!validSessionId(input?.sessionId)) {
    return { ok: false, message: '本会话无会话标识（CLAUDE_CODE_SESSION_ID 缺失）——不得创建 dispatch；请重开会话或检查客户端环境' };
  }
  return state.dispatchDomain.create(input);
}

async function createNowWithCapability(state, input) {
  if (!validSessionId(input?.sessionId)) {
    return { ok: false, message: '本会话无会话标识（CLAUDE_CODE_SESSION_ID 缺失）——不得创建协作；请重开会话或检查客户端环境' };
  }
  /* 目标形态先行（含「不能包含本机」）：本机目标的自探测会被自身实例应答面丢弃，先跑闸门只会
   * 空等两轮探测再报「无法确认目标支持会话级协作」——误导性错误。 */
  const targetsRejection = targetsRejectionOf(input?.targets, state.self.instanceId);
  if (targetsRejection !== null) {
    return { ok: false, message: targetsRejection };
  }
  const refusal = await capabilityRefusalOfTargets(state, input?.targets);
  if (refusal !== null) {
    return refusal;
  }
  return createNowSync(state, input);
}

function createNowSync(state, input) {
  if (!validSessionId(input?.sessionId)) {
    return { ok: false, message: '本会话无会话标识（CLAUDE_CODE_SESSION_ID 缺失）——不得创建协作；请重开会话或检查客户端环境' };
  }
  /* 防御直调（createNow 已先分流）：dispatch 永不落到 createCollab（那会写协作目录）。 */
  const dispatched = createDispatchNow(state, input);
  if (dispatched !== null) {
    return dispatched;
  }
  const result = createCollab(state, input);
  if (result?.ok !== true) {
    return result;
  }
  const local = state.collabs.get(result.collabId);
  if (local !== undefined) {
    registerCreatorSeat(state, local, input);
    noteLedgerReadback(state, result.collabId);
    if (!ensureCarrierOf(state, local, input)) {
      return carrierFailureResult(state, result.collabId);
    }
  }
  return result;
}

/* 创建后台账读回自检（跨属主集成面）：台账写入形态尚未切到当前形态时，本层先把
 * 「重启后读不回」这件事变成可见计数，而不是等下一次重启把台账判损坏。 */
function noteLedgerReadback(state, collabId) {
  const loaded = loadLedger(state.dataDir, collabId);
  if (loaded.ledger === null) {
    state.counters.createLedgerUnreadable++;
    state.log.warn('新建协作的台账读回失败（重启将判损坏，待台账写面完成迁移）', { collabId });
  }
}

function carrierFailureResult(state, collabId) {
  const dir = collabDir(state.dataDir, collabId);
  const recovery = writeRecovery(dir, { reason: 'carrier-write-failed' });
  state.readonlyCollabs.set(collabId, { reason: 'recovery' });
  state.collabs.delete(collabId);
  if (recovery?.ok !== true) {
    state.counters.persistFailures++;
    state.log.warn('载体写入失败的恢复标记也未能落盘（目录仍按只读处理）', { collabId });
  }
  return {
    ok: false,
    collabId,
    message: '协作目录已建立但载体文件写入失败——该目录已标记为恢复态（只读）；请检查磁盘后重新创建（ws_create_collab）',
  };
}

/* 增邀同样过能力闸门（讨论邀请目标机器亦需 0.2.0）；未注入探测面时保持同步旧路径。 */
function inviteWithCapability(state, input) {
  if (typeof state.probeCapability !== 'function') {
    return inviteMembers(state, input);
  }
  return (async () => {
    const refusal = await capabilityRefusalOfTargets(state, input?.targets);
    return refusal ?? inviteMembers(state, input);
  })();
}

function registerCreatorSeat(state, local, input) {
  if (!validSessionId(input?.sessionId)) {
    return;
  }
  const before = local.seatPersistFailures ?? 0;
  upsertLocalSeat(local, creatorSeatOf(input.sessionId), {
    persist: true,
    dataDir: state.dataDir,
    bridgeId: state.sessionBridges.get(input.sessionId) ?? null,
  });
  noteSeatPersistOutcome(state, local, before);
}

/* 席位落盘结果上报（upsertLocalSeat 内部吞掉写失败，外层 catch 永不触发——错误计数必须从这里
 * 回流到服务计数，否则 stats().seatPersistFailures 恒为 0，写失败不可见）。 */
function noteSeatPersistOutcome(state, local, before) {
  const after = local.seatPersistFailures ?? 0;
  if (after > before) {
    state.counters.seatPersistFailures += after - before;
    state.log.warn('席位写入失败（内存态继续）', { collabId: local.collabId, reason: local.lastSeatPersistError ?? '未知原因' });
    return false;
  }
  return true;
}

/* 单席落盘（静音/角色/入席共用）：席位运行态已在内存，落盘失败只计数告警。 */
function persistSeatOf(state, local, sessionId) {
  const seat = localSeatOfLocal(local, sessionId);
  if (seat === null) {
    return false;
  }
  const before = local.seatPersistFailures ?? 0;
  upsertLocalSeat(local, seat, { persist: true, dataDir: state.dataDir });
  return noteSeatPersistOutcome(state, local, before);
}

function creatorSeatOf(sessionId) {
  return {
    version: 1,
    sessionId,
    role: 'manager',
    state: 'member',
    joinSeq: 1,
    joinedAt: new Date().toISOString(),
    muted: false,
    unverified: false,
  };
}

/* 返回是否已落 carrier：失败不静默——目录若留下「有 member.json 无 carrier」，重启会被判 legacy
 * 并永久归档（设计 §8 判据），调用方必须按恢复态收口。 */
function ensureCarrierOf(state, local, input) {
  const dir = collabDir(state.dataDir, local.collabId);
  if (readCarrierFormat(dir) !== null) {
    return true;
  }
  const carrier = carrierOf(state, local, input);
  try {
    writeCarrier(dir, carrier);
    return true;
  } catch (error) {
    state.counters.persistFailures++;
    state.log.warn('载体文件写入失败（按恢复态收口）', { collabId: local.collabId, reason: error.message });
    return false;
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

/* 离开/结束的席位清理：成功结果之后执行（离席广播与标记由生命周期层负责，本层只维护本机席位态）。
 * 离席按席位处理：同机另一成员席仍活跃时，整机兼容记录不得被标成 left（localStateOf 已按席位读）。 */
function leaveNow(state, input) {
  const local = state.collabs.get(input?.collabId);
  if (local === undefined) {
    return leaveCollab(state, input);
  }
  const refusal = leaveRefusalOf(local, input?.sessionId);
  if (refusal !== null) {
    return refusal;
  }
  const seat = localSeatOfLocal(local, input.sessionId);
  const previousMemberState = local.member?.state ?? null;
  const managerLeave = managerLeaveRefusalOf(state, local, seat, input);
  if (managerLeave !== null) {
    return managerLeave;
  }
  const result = runWithSeatRole(local, seat, () => leaveCollab(state, input));
  if (result?.ok === true) {
    removeSeatOf(state, input.collabId, input.sessionId);
    restoreMachineMemberState(state, local, previousMemberState);
  }
  return result;
}

/* 成员记录是整机兼容面：一席离席把整机标 left 会连带归档同机其余席位（outgoing 另有直接读
 * member.state 的守卫）。仍有活跃席位时恢复离席前的整机态并落盘。 */
function restoreMachineMemberState(state, local, previousState) {
  if (previousState === null || previousState === 'left' || !hasActiveSeat(local)) {
    return;
  }
  local.member.state = previousState;
  persistMember(state, local);
}

function leaveRefusalOf(local, sessionId) {
  if (!validSessionId(sessionId)) {
    return { ok: false, message: '无会话标识——离席按会话进行，请从本会话发起' };
  }
  if (localSeatOfLocal(local, sessionId) === null && seatsOfLocal(local).size > 0) {
    return { ok: false, message: '本会话在该协作没有席位——不能代替其他会话离席' };
  }
  return null;
}

/* 站长席可离席（设计 §3.4）：先触发自动移交（生命周期层）；无接手者＝直接终态，移交失败＝如实拒绝，
 * 不让旧站长征询半途消失。 */
function managerLeaveRefusalOf(state, local, seat, input) {
  if (!isManagerLeaving(local, seat)) {
    return null;
  }
  const transfer = autoTransfer(state, { collabId: input.collabId, managerSessionId: input.sessionId });
  if (transfer?.completed === true) {
    removeSeatOf(state, input.collabId, input.sessionId);
    return { ok: true, completed: true, message: '最后一名成员离席——协作已结束' };
  }
  return transferRefusalOf(transfer);
}

function isManagerLeaving(local, seat) {
  if (seat === null || seat.role !== 'manager' || local.role !== 'manager') {
    return false;
  }
  return localModeOf(local) !== 'forum';
}

function transferRefusalOf(transfer) {
  if (transfer?.ok === true) {
    return null;
  }
  return { ok: false, message: `站长离席需先自动移交（${transfer?.reason ?? '无可用接手者'}）——稍后重试或先结束协作` };
}

/* 同机尚有站长席时 local.role 是 manager；成员/站长席离席都不能被整机角色拦下
 * （outgoing 的「站长席位不可退出」是整机口径，本层按席位重新表述）。 */
function runWithSeatRole(local, seat, run) {
  const machineRole = local.role;
  if (seat !== null && machineRole === 'manager' && (seat.role === 'member' || seat.role === 'manager')) {
    local.role = 'member';
  }
  try {
    return run();
  } finally {
    local.role = machineRole;
  }
}

function endNow(state, input) {
  const result = endCollab(state, input);
  if (result?.ok === true) {
    archiveAllSeatsOf(state, input?.collabId);
  }
  return result;
}

/* 终态归档本机席位（设计 §3.4 / 契约 §8）：保留席位文件并写 archivedAt——删除属用户数据删除，
 * 不在终态路径做。归档后席位退出注入、静音聚合与状态栏活跃判定。 */
function archiveAllSeatsOf(state, collabId) {
  const local = state.collabs.get(collabId);
  if (local === undefined) {
    return;
  }
  archiveLocalSeatsOfState(state, local);
  forgetMuteBaselinesOfCollab(state, collabId);
}

function removeSeatOf(state, collabId, sessionId) {
  const local = state.collabs.get(collabId);
  if (local === undefined) {
    return;
  }
  const outcome = removeLocalSeat(local, sessionId, { persist: true, dataDir: state.dataDir });
  noteSeatRemoval(state, local.collabId, sessionId, outcome);
}

/* 席位移除留痕：判离席丢弃的暂存计数；席位文件删不掉时重启会「复活」席位（台账已无该席），
 * 只 warn 不静默。 */
function noteSeatRemoval(state, collabId, sessionId, outcome) {
  if (!outcome.existed) {
    return;
  }
  /* 显式离席路径会经 removeLocalSeat 钩子与 removeSeatOf 各调一次本函数（同一 outcome 对象）：
   * 按 outcome 去重，席位移除计数不得重复累加。 */
  if (outcome.countedSeatRemoval !== true) {
    outcome.countedSeatRemoval = true;
    state.counters.seatRemovals = (state.counters.seatRemovals ?? 0) + 1;
  }
  forgetMuteBaseline(state, collabId, sessionId);
  if (outcome.stagedDropped > 0) {
    state.counters.seatStagedDropped += outcome.stagedDropped;
    noteStagedDroppedOnRemoval(state, collabId, sessionId);
  }
  if (outcome.fileRemoved !== true) {
    state.counters.seatFileRemoveFailures++;
    state.log.warn('席位文件删除失败（重启可能复活该席位）', { collabId, sessionId });
  }
  /* 离席/席位移除必须释放未确认的两段式记录（加入域契约）：否则同键再次入席被旧 joining 挡住。 */
  try {
    state.join?.releaseJoining?.(collabId, sessionId);
  } catch (error) {
    state.counters.eventFailures++;
    state.log.warn('未确认入席记录释放失败（已隔离）', { collabId, sessionId, reason: error?.message });
  }
}

function ensureSeatAfterJoin(state, collabId, sessionId, role) {
  const local = state.collabs.get(collabId);
  if (local === undefined || !validSessionId(sessionId) || localSeatOfLocal(local, sessionId) !== null) {
    return null;
  }
  const before = local.seatPersistFailures ?? 0;
  const seat = upsertLocalSeat(local, {
    version: 1,
    sessionId,
    role,
    state: 'member',
    joinSeq: joinSeqOf(local, sessionId),
    joinedAt: new Date().toISOString(),
    muted: false,
    unverified: false,
  }, {
    persist: true,
    dataDir: state.dataDir,
    bridgeId: state.sessionBridges.get(sessionId) ?? null,
  });
  noteSeatPersistOutcome(state, local, before);
  return seat;
}

function joinSeqOf(local, sessionId) {
  const row = (local.ledger?.members ?? []).find((entry) => entry.sessionId === sessionId);
  if (Number.isInteger(row?.joinSeq)) {
    return row.joinSeq;
  }
  return seatsOfLocal(local).size + 1;
}

/* 本机旁路（设计 §1.2/§5.2/§5.3）：目标席位在本机时直接写该席位 inbox/暂存并交桥，不经 dispatch.send。
 * 同机多席各自去重（键 msgId）、各自暂存；发送会话不给自己投递。
 * 邀请帧例外：受邀会话可能还没有席位文件（首帧白名单），按桥注册面直投；其余帧无席位即拒绝。 */
async function injectLocalSeatOf(state, collabId, sessionId, frame) {
  /* 同机两段式回执走核内接收面（设计 §4.4「同机走核内旁路」）：join-grant/deny/confirm 是
   * 协议帧，由本核的加入域处理，而不是作为用户消息投进会话。 */
  if (LOCAL_PROTOCOL_FRAME_TYPES.has(frame?.type)) {
    return receiveLocalProtocolFrame(state, collabId, frame);
  }
  const prepared = seatForInjection(state, collabId, sessionId, frame);
  if (prepared.ok !== true) {
    return prepared.result;
  }
  return injectPreparedSeat(state, collabId, sessionId, prepared, frame);
}

async function injectPreparedSeat(state, collabId, sessionId, prepared, frame) {
  const { local, seat } = prepared;
  if (frame?.from?.sessionId === sessionId) {
    state.counters.seatSelfSkipped++;
    return { ok: true, skipped: 'self' };
  }
  if (seat.virtual === true) {
    return injectVirtualInvite(state, collabId, seat, frame);
  }
  const msgId = typeof frame?.msgId === 'string' ? frame.msgId : null;
  if (msgId !== null && seat.seen.has(msgId)) {
    state.counters.seatDuplicates++;
    return { ok: true, duplicate: true };
  }
  return injectSeatedFrame(state, collabId, local, seat, frame, msgId);
}

/* 同机协议帧（两段式入席）：不投用户会话，交核内准入与加入域处置。 */
const LOCAL_PROTOCOL_FRAME_TYPES = new Set(['join-grant', 'join-deny', 'join-confirm', 'snapshot']);

async function receiveLocalProtocolFrame(state, collabId, frame) {
  const sessionId = frame?.from?.sessionId ?? null;
  const admitted = await gateFrame(state, frame, { remoteAddress: 'local', sessionId });
  if (admitted?.ok !== true) {
    return { ok: false, reason: admitted?.reason ?? 'admission-rejected' };
  }
  /* 端点学习只认网络来源：本机注入的帧不是对端可达证据，meta 不携 remoteAddress，
   * 否则成员记录里的站长端点会被覆盖成「local」，后续直投以非法地址被拒。 */
  await consumeFrame(state, frame, { sessionId });
  state.counters.seatsInjected++;
  return { ok: true, delivered: true };
}

/* 投递事实面：只对「指名到本会话」且本会话 invite 门为 off 的邀请自动同意。
 * 三个成功点覆盖在线直投、席位暂存补投、挂起邀请补投；staged 不算投递，因此不在这里触发。
 * 内部签发并立即消费一次性挑战，复用 approveNow 的完整同意 / 入席 / 账号收尾路径。 */
async function maybeAutoAcceptInviteOf(state, collabId, sessionId, frame) {
  if (frame?.type !== 'invite' || !isNamedInviteForSessionOf(state, frame, sessionId)) {
    return;
  }
  if (gateValueOf(state, sessionId, 'invite').effectiveValue !== false) {
    return;
  }
  if (!await autoAcceptInviteNowOf(state, collabId, sessionId, frame)) {
    return;
  }
  notifyAutoAcceptedInviteOf(state, collabId, sessionId);
}

/* 同意本体：签发并消费一次性挑战，异常与失败只留痕——自动同意不得打断投递主链。 */
async function autoAcceptInviteNowOf(state, collabId, sessionId, frame) {
  const confirmToken = issueInviteChallenge(state, { sessionId, collabId });
  try {
    const result = await guardedWrite(state, collabId, () => approveNow(state, {
      collabId, sessionId, inviteId: inviteIdOfFrame(frame), approve: true, confirmToken,
    }));
    if (result?.ok === true) {
      return true;
    }
    state.log.warn('自动同意邀请失败（保持待回应）', { collabId, sessionId, reason: result?.message });
  } catch (error) {
    state.counters.eventFailures++;
    state.log.warn('自动同意邀请异常（已隔离）', { collabId, sessionId, reason: error?.message });
  }
  return false;
}

function inviteIdOfFrame(frame) {
  const inviteId = frame?.payload?.inviteId;
  return typeof inviteId === 'string' && inviteId !== '' ? inviteId : undefined;
}

function notifyAutoAcceptedInviteOf(state, collabId, sessionId) {
  const local = state.collabs.get(collabId);
  const name = local === undefined ? collabId : localNameOf(local);
  notifyLocal(state, local ?? { collabId }, `已按设置自动同意邀请：${name}`, { targetSessionId: sessionId });
}

/* 自动批准通知：站长桥在线直投；离线进有界队列（64），注册时按 sessionId 补投。
 * 队列满只计 dropped，不阻塞批准主链。 */
function noteJoinAutoApproved(state, { collabId, managerSessionId, applicantName }) {
  const local = state.collabs.get(collabId);
  const name = local === undefined ? collabId : localNameOf(local);
  const text = `已按设置自动批准加入申请：${applicantName} → ${name}`;
  const delivered = notifyLocal(state, local ?? { collabId }, text, { targetSessionId: managerSessionId });
  if (delivered === false) {
    const queued = queueConfirmGateNotice(state, { sessionId: managerSessionId, collabId, text });
    if (!queued) {
      state.counters.autoApprovalNoticesDropped = (state.counters.autoApprovalNoticesDropped ?? 0) + 1;
    }
  }
}

function flushConfirmGateNoticesOf(state, sessionId) {
  for (const notice of takeConfirmGateNotices(state, sessionId)) {
    const local = state.collabs.get(notice.collabId) ?? { collabId: notice.collabId };
    notifyLocal(state, local, notice.text, { targetSessionId: sessionId });
  }
}

/* 指名判定要兼容两种帧形态：在线邀请写 payload.targetSessionId；挂起补投只写
 * payload.targets[].targetSessionId（replayInviteFrameOf）。不指名邀请没有 targetSessionId，
 * 一律不自动同意。目标值与投递面 / 点头面共用 matchSessionByToken 的同一口径：完整标识或
 * 8 位短码都算指名到本会话（短码在接收侧已换成全量标识，但帧载荷仍保留原 token）。 */
function isNamedInviteForSessionOf(state, frame, sessionId) {
  const namedToSession = (token) => matchSessionByToken([{ sessionId }], token) === sessionId;
  if (namedToSession(frame?.payload?.targetSessionId)) {
    return true;
  }
  const targets = frame?.payload?.targets;
  return Array.isArray(targets) && targets.some((target) =>
    namedToSession(target?.targetSessionId)
    && (target.instanceId === undefined || target.instanceId === state.self.instanceId));
}

/* 有席位目标的注入：先记运行态事实，桥在线直投、离线/补投中入暂存；两种结果都写本机投递账。 */
async function injectSeatedFrame(state, collabId, local, seat, frame, msgId) {
  noteSeatInbox(seat, frame, msgId);
  /* 补投进行中新到的帧先入暂存队尾：否则它会被直接交付，越过尚未补投的旧帧（乱序）。 */
  if (seat.flushing !== true && await deliverToSeatNow(state, seat, frame)) {
    state.counters.seatsInjected++;
    noteSeatOutcome(seat, msgId, 'injected');
    noteLocalDelivery(state, collabId, seat.sessionId, frame, 'injected');
    await maybeAutoAcceptInviteOf(state, collabId, seat.sessionId, frame);
    return { ok: true, delivered: true };
  }
  stageSeatFrame(state, local, seat, frame);
  noteLocalDelivery(state, collabId, seat.sessionId, frame, 'staged');
  return { ok: true, staged: true };
}

/* 邀请的无席位直投：受邀会话的桥在线即交付；离线不暂存（没有席位可挂），由加入域的挂起邀请
 * 在目标注册时补投。 */
async function injectVirtualInvite(state, collabId, seat, frame) {
  if (await deliverToSeatNow(state, seat, frame)) {
    state.counters.seatsInjected++;
    noteLocalDelivery(state, collabId, seat.sessionId, frame, 'injected');
    await maybeAutoAcceptInviteOf(state, collabId, seat.sessionId, frame);
    return { ok: true, delivered: true };
  }
  return { ok: false, reason: 'seat-offline' };
}

/* 注入前置（形态/席位/可注入性）：返回 {ok:true, local, seat} 或 {ok:false, result}。
 * virtual 席位＝邀请帧的桥注册目标（无席位文件，只用 sessionId/bridgeId 交付）。 */
function seatForInjection(state, collabId, sessionId, frame) {
  if (!validSessionId(sessionId)) {
    return { ok: false, result: { ok: false, reason: 'bad-session' } };
  }
  if (inviteTargetMismatchOf(frame, sessionId)) {
    return { ok: false, result: { ok: false, reason: 'not-invite-target' } };
  }
  const local = state.collabs.get(collabId);
  const seat = local === undefined ? null : localSeatOfLocal(local, sessionId);
  if (seat !== null) {
    return injectableSeatOf(local, seat, frame);
  }
  const bridgeId = inviteBridgeTargetOf(state, sessionId, frame);
  if (bridgeId !== null) {
    return { ok: true, local: local ?? null, seat: { sessionId, bridgeId, virtual: true } };
  }
  return { ok: false, result: { ok: false, reason: local === undefined ? 'unknown-collab' : 'no-seat' } };
}

function injectableSeatOf(local, seat, frame) {
  if (seat.state !== 'member' && seat.state !== 'joining') {
    return { ok: false, result: { ok: false, reason: 'seat-not-injectable' } };
  }
  /* 归档席位只退出**内容类**注入：终态/控制帧（end/leave/withdraw 等）仍需送达本会话——
   * 归档由 consume 在投递前完成，若在这里一并拒绝，结束通告本身就会被吞掉。 */
  if (isSeatArchived(seat) && isContentFrameOf(frame)) {
    return { ok: false, result: { ok: false, reason: 'seat-archived' } };
  }
  return { ok: true, local, seat };
}

function isContentFrameOf(frame) {
  return frame?.type === 'post' || POST_KINDS.includes(frame?.type);
}

/* 反向首帧白名单（设计 §5.1/§4.4）：邀请与两段式回执可投尚未入席的会话——接收者按桥注册面放行；
 * 其余类型无席位一律拒绝（不得把帧投给非参与者）。 */
const BRIDGE_FIRST_FRAME_TYPES = new Set(['invite', 'join-grant', 'join-deny']);

function inviteBridgeTargetOf(state, sessionId, frame) {
  if (!BRIDGE_FIRST_FRAME_TYPES.has(frame?.type)) {
    return null;
  }
  const bridgeId = state.sessionBridges.get(sessionId);
  return typeof bridgeId === 'string' && bridgeId !== '' ? bridgeId : null;
}

/* 指名邀请只投目标会话（短码与完整标识都按精确匹配，不做前缀展开）：发送侧不知道目标机
 * 有哪些会话，接收侧逐席判定，非目标席按坏目标隔离。0.2.0 的目标写在 targets[] 里，
 * 仅在缺 targets 时回退旧版顶层 targetSessionId。 */
function inviteTargetMismatchOf(frame, sessionId) {
  if (frame?.type !== 'invite') {
    return false;
  }
  const named = namedInviteTargetsOf(frame);
  if (named === null) {
    return false;
  }
  if (named.some((token) => typeof token !== 'string')) {
    return true;
  }
  return !named.some((token) => matchSessionByToken([{ sessionId }], token) === sessionId);
}

/* 指名目标集合：targets[] 中带 targetSessionId 的项优先（没有这类项＝不指名）；
 * 旧版载荷才读顶层 targetSessionId。 */
function namedInviteTargetsOf(frame) {
  const targets = frame?.payload?.targets;
  if (Array.isArray(targets)) {
    const named = targets
      .map((target) => target?.targetSessionId)
      .filter((token) => token !== undefined && token !== null && token !== '');
    return named.length === 0 ? null : named;
  }
  const token = frame?.payload?.targetSessionId;
  return token === undefined || token === null || token === '' ? null : [token];
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

/* 席位 inbox 只作运行态投递事实（去重键 msgId）；落盘投递账见 noteLocalDelivery。 */
function noteSeatInbox(seat, frame, msgId) {
  if (msgId !== null) {
    seat.seen.add(msgId);
  }
  seat.inbox.push({ msgId, type: frame?.type ?? null, fromSessionId: frame?.from?.sessionId ?? null, at: new Date().toISOString() });
  while (seat.inbox.length > SEAT_INBOX_MAX) {
    const evicted = seat.inbox.shift();
    if (typeof evicted?.msgId === 'string') {
      forgetSeatMessage(seat, evicted.msgId);
    }
  }
}

/* 去重与投递事实的回收：同一条事实只留最近 SEAT_INBOX_MAX 条。 */
function forgetSeatMessage(seat, msgId) {
  seat.seen.delete(msgId);
  seat.deliveryOutcomes?.delete(msgId);
}

function noteSeatOutcome(seat, msgId, outcome) {
  if (msgId !== null && seat.deliveryOutcomes instanceof Map) {
    seat.deliveryOutcomes.set(msgId, outcome);
  }
}

/* 暂存（设计 §5.5）：宽限内断连的席位帧进内存，同 sessionId 重连补投；超限丢最旧并计数。
 * 丢帧必须同时释放 msgId 去重：否则发送方重试同一 msgId 会被判 duplicate（出站层计为成功），消息永久丢失。 */
function stageSeatFrame(state, local, seat, frame) {
  state.stagedSeq++;
  seat.staged.push({ frame, seq: state.stagedSeq });
  rememberStagedOf(state, local.collabId, seat.sessionId, frame?.msgId);
  while (seat.staged.length > state.stagedMaxPerSeat) {
    dropStagedFrame(state, local, seat, seat.staged.shift());
  }
  while (stagedCountOf(local) > state.stagedMaxPerCollab) {
    dropOldestStaged(state, local);
  }
  state.counters.seatsStaged++;
}

/* 丢帧必须同时释放 msgId 去重（允许重投），但仍要留下「到过且被丢弃」的事实——查询面要能区分
 * 「从未到达」（unknown）与「判离席/超限丢弃」（dropped，设计 §5.3 明细取值）。 */
function dropStagedFrame(state, local, seat, entry) {
  seat.stagedDropped++;
  state.counters.seatStagedDropped++;
  const msgId = entry?.frame?.msgId;
  if (typeof msgId === 'string') {
    forgetSeatMessage(seat, msgId);
    forgetStagedOf(state, local.collabId, seat.sessionId, msgId);
    noteSeatDropped(state, local.collabId, seat.sessionId, msgId);
  }
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
  dropStagedFrame(state, local, oldest, oldest.staged.shift());
}

/* 暂存索引（collabId+sessionId → msgId 集）：席位被移除时其暂存帧由席位层整体丢弃，
 * 服务层必须仍能为这些 msgId 落「丢弃」事实——所以暂存事实在服务层单独跟一份索引。 */
const STAGED_INDEX_SEP = '\u0000';
const DROPPED_LOCAL_MAX = 512;

function stagedIndexKeyOf(collabId, sessionId) {
  return `${collabId}${STAGED_INDEX_SEP}${sessionId}`;
}

function stagedIndexOf(state) {
  if (!(state.stagedBySeat instanceof Map)) {
    state.stagedBySeat = new Map();
  }
  return state.stagedBySeat;
}

function rememberStagedOf(state, collabId, sessionId, msgId) {
  if (typeof msgId !== 'string' || !validSessionId(sessionId)) {
    return;
  }
  const index = stagedIndexOf(state);
  const key = stagedIndexKeyOf(collabId, sessionId);
  const held = index.get(key) ?? new Set();
  held.add(msgId);
  index.set(key, held);
}

function forgetStagedOf(state, collabId, sessionId, msgId) {
  if (typeof msgId !== 'string') {
    return;
  }
  const index = stagedIndexOf(state);
  const key = stagedIndexKeyOf(collabId, sessionId);
  const held = index.get(key);
  if (held === undefined) {
    return;
  }
  held.delete(msgId);
  if (held.size === 0) {
    index.delete(key);
  }
}

/* 丢弃事实（sessionId+msgId → collabId）：有界内存、插入序淘汰；只服务查询面，
 * 不影响去重（丢弃后同 msgId 仍可重投，成功注入会以更新的席位事实覆盖查询结果）。 */
function droppedLocalKeyOf(sessionId, msgId) {
  return `${sessionId}${STAGED_INDEX_SEP}${msgId}`;
}

function noteSeatDropped(state, collabId, sessionId, msgId) {
  if (typeof msgId !== 'string' || !validSessionId(sessionId)) {
    return;
  }
  if (!(state.droppedLocalDeliveries instanceof Map)) {
    state.droppedLocalDeliveries = new Map();
  }
  const ledger = state.droppedLocalDeliveries;
  const key = droppedLocalKeyOf(sessionId, msgId);
  ledger.delete(key);
  ledger.set(key, { collabId });
  while (ledger.size > DROPPED_LOCAL_MAX) {
    ledger.delete(ledger.keys().next().value);
  }
}

function droppedLocalFactOf(state, msgId, sessionId) {
  const ledger = state.droppedLocalDeliveries;
  if (!(ledger instanceof Map)) {
    return null;
  }
  return ledger.get(droppedLocalKeyOf(sessionId, msgId)) ?? null;
}

/* 席位移除：把该席仍在暂存中的帧事实转为「丢弃」（席位层已整体丢弃这些帧）。 */
function noteStagedDroppedOnRemoval(state, collabId, sessionId) {
  const index = stagedIndexOf(state);
  const key = stagedIndexKeyOf(collabId, sessionId);
  const held = index.get(key);
  if (held === undefined) {
    return;
  }
  index.delete(key);
  for (const msgId of held) {
    noteSeatDropped(state, collabId, sessionId, msgId);
  }
}

/* 桥注册/注销（设计 §3.2）：注册即绑定该会话在本机全部协作的席位并补投暂存（按到达序）。
 * 补投期间席位保持 flushing：新帧先入暂存队尾，补投完成后再按同一队列出队（不乱序）。 */
async function registerBridgeNow(state, sessionId, bridgeId) {
  if (!validSessionId(sessionId) || typeof bridgeId !== 'string' || bridgeId === '') {
    return { ok: false, reason: 'bad-bridge' };
  }
  /* 重连即撤销宽限：先清已过期的宽限条目，避免陈旧宽限被这次注册「复活」成在线态
   * （过期＝会话覆盖应随之清除，不得因迟到的重连保留）。 */
  pruneConfirmGates(state, state.clock());
  markConfirmGateOpen(state, sessionId);
  state.sessionBridges.set(sessionId, bridgeId);
  noteSessionRebound(state, sessionId);
  const { seats, pendingSeats } = bindRegisteredSeatsOf(state, sessionId, bridgeId);
  /* 注册回执（welcome）由核心在 onRegister 回调返回后才写出发送（core/ipc.js registerBridge：
   * 先回调、后 sendToConn）；桥在握手完成前拒非 welcome 帧（「握手期收到 push」）。这里让出一拍，
   * 等 welcome 已在线路上后再 flush dispatch 队列 / 暂存席位 / 挂起邀请——否则帧被拒却已按
   * 「已送达 / 已补投」记账（dispatch 队列出队后不再重试，自动同意也不会再触发）。 */
  await seatFlushDelay();
  /* 让出期内该会话可能已断开或被新桥顶替：注销路径会清桥登记并给 dispatch 起宽限，后到的注册
   * 会改写 sessionBridges。此时本注册已是过期续体——尤其 noteBridgeOnline 会删掉断开方刚登记的
   * 宽限（宽限内用户主动断开被误判为在线，slave 永不释放 / master 永不结束）。补投与通知归
   * 当前注册或断开路径所有，这里直接收手；markConfirmGateOpen / prune 已在让出前完成，不回滚。 */
  if (state.sessionBridges.get(sessionId) !== bridgeId) {
    return { ok: false, reason: 'bridge-superseded' };
  }
  /* 桥重连撤销 dispatch 宽限并补投断连期间排队的通知（dispatch 域未创建＝降级，跳过）。 */
  state.dispatchDomain?.noteBridgeOnline?.(sessionId);
  let flushed = 0;
  for (const { local, seat } of pendingSeats) {
    flushed += await flushStagedOf(state, local, seat);
  }
  state.counters.seatBridgeRegistrations++;
  const invites = await replayPendingInvitesOnRegisterOf(state, sessionId);
  flushConfirmGateNoticesOf(state, sessionId);
  return { ok: true, seats, flushed, invites: invites.delivered };
}

/* 注册的同步段：把该会话在本机各协作的席位绑定到新桥，并标出有暂存的待补投席位。
 * 暂存席位在让出一拍前就标 flushing——期间新到的帧入队尾，补投仍按到达序推进（不乱序）。 */
function bindRegisteredSeatsOf(state, sessionId, bridgeId) {
  let seats = 0;
  const pendingSeats = [];
  for (const local of state.collabs.values()) {
    const seat = localSeatOfLocal(local, sessionId);
    if (seat === null) {
      continue;
    }
    seat.bridgeId = bridgeId;
    seats++;
    if (seat.staged.length > 0) {
      seat.flushing = true;
      pendingSeats.push({ local, seat });
    }
  }
  return { seats, pendingSeats };
}

/* 桥注册回调（附属面）：核心重启对账据此认定「宽限内重绑过」；注入面异常不得影响注册主链。 */
function noteSessionRebound(state, sessionId) {
  if (typeof state.onSessionRebound !== 'function') {
    return;
  }
  try {
    state.onSessionRebound(sessionId);
  } catch (error) {
    state.counters.eventFailures++;
    state.log.warn('桥注册回调异常（已隔离）', { sessionId, reason: error?.message });
  }
}

/* 注册补投之二（设计 §4.2）：本机挂起邀请按簿记语义重投给刚注册的会话——指名精确匹配、
 * 不指名匹配全部。协作范围取「已加载协作 ∪ 盘上协作目录」：邀请占位目录（invite-stub）
 * 重启后不参与注册表加载，只在盘上，补投必须仍然找得到它。补投是附属面，异常只计数告警。 */
async function replayPendingInvitesOnRegisterOf(state, sessionId) {
  if (typeof state.join?.replayPendingInvites !== 'function') {
    return { delivered: 0 };
  }
  const collabIds = [...new Set([...state.collabs.keys(), ...listLocalCollabIds(state.dataDir)])];
  try {
    return await state.join.replayPendingInvites(sessionId, collabIds, (collabId, target, frame) =>
      injectLocalSeatOf(state, collabId, target, frame));
  } catch (error) {
    state.counters.pendingInviteReplayFailures = (state.counters.pendingInviteReplayFailures ?? 0) + 1;
    state.log.warn('挂起邀请补投异常（已隔离——注册不受影响）', { sessionId, reason: error?.message });
    return { delivered: 0 };
  }
}

/* 桥握手让位（毫秒级）：每次注册付一次，覆盖 dispatch 队列 / 暂存席位 / 挂起邀请的全部补投面
 * （原「仅暂存席位才延迟」并在这里，避免同一注册回合重复等待）。 */
function seatFlushDelay() {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

async function flushStagedOf(state, local, seat) {
  seat.flushing = true;
  let flushed = 0;
  try {
    while (seat.staged.length > 0) {
      const entry = seat.staged[0];
      if (!await deliverToSeatNow(state, seat, entry.frame)) {
        break;
      }
      seat.staged.shift();
      flushed++;
      forgetStagedOf(state, local.collabId, seat.sessionId, entry.frame?.msgId);
      noteSeatOutcome(seat, entry.frame?.msgId ?? null, 'injected');
      noteLocalDelivery(state, entry.frame?.collabId, seat.sessionId, entry.frame, 'injected');
      await maybeAutoAcceptInviteOf(state, local.collabId, seat.sessionId, entry.frame);
    }
  } finally {
    seat.flushing = false;
  }
  return flushed;
}

/* 本机旁路的落盘投递账（设计 §5.3 第 4 条）：与接收核同一 inbox.jsonl 形态，键 (msgId,sessionId)。
 * 写入必须经接收核的收件盒（append 与 seen 同步）：直接 append 会绕过已载入的盒子，
 * 运行期查询看不到该行，压实按内存投影重写时还会把它删掉。
 * 写面未注入（不构造接收核的单测装配）时退回直写，保持既有行为；写失败只计数留痕，不改变注入事实。 */
function noteLocalDelivery(state, collabId, sessionId, frame, outcome) {
  if (!validCollabId(collabId) || frame === null || typeof frame?.msgId !== 'string') {
    return;
  }
  if (typeof state.inboundNoteLocalDelivery === 'function') {
    try {
      state.inboundNoteLocalDelivery({ collabId, sessionId, frame, outcome });
    } catch (error) {
      state.counters.localDeliveryLedgerFailures++;
      state.log.warn('本机投递账写入失败（注入事实仍成立）', { collabId, msgId: frame.msgId, sessionId, reason: error?.message });
    }
    return;
  }
  const record = {
    ...frame,
    receivedAt: new Date().toISOString(),
    fanout: { pending: [], done: [sessionId], dropped: [], outcomes: { [sessionId]: outcome }, complete: true },
    local: true,
  };
  try {
    appendLine(collabFilePath(state.dataDir, collabId, INBOX_FILE_NAME), record);
  } catch (error) {
    state.counters.localDeliveryLedgerFailures++;
    state.log.warn('本机投递账写入失败（注入事实仍成立）', { collabId, msgId: frame.msgId, sessionId, reason: error.message });
  }
}

/* 本机投递明细查询：内存席位事实优先（暂存中/已注入），未命中再问接收管线的落盘扇出面。 */
function localSeatDeliveryOfOf(state, msgId, sessionId) {
  if (typeof msgId !== 'string' || msgId === '' || !validSessionId(sessionId)) {
    throw new TypeError('localSeatDeliveryOf 需要合法的 msgId 与 sessionId');
  }
  for (const local of state.collabs.values()) {
    const seat = localSeatOfLocal(local, sessionId);
    if (seat === null) {
      continue;
    }
    const outcome = seat.deliveryOutcomes instanceof Map ? seat.deliveryOutcomes.get(msgId) : undefined;
    if (outcome !== undefined) {
      return { collabId: local.collabId, msgId, sessionId, status: outcome, complete: outcome !== 'staged' };
    }
    if (seat.staged.some((entry) => entry.frame?.msgId === msgId)) {
      return { collabId: local.collabId, msgId, sessionId, status: 'staged', complete: false };
    }
  }
  return fallbackSeatStatusOf(state, msgId, sessionId);
}

/* 席位事实未命中时的回落：先看「到过且被丢弃」的有界事实，再委托接收管线的落盘扇出面。 */
function fallbackSeatStatusOf(state, msgId, sessionId) {
  const dropped = droppedLocalFactOf(state, msgId, sessionId);
  if (dropped !== null) {
    return { collabId: dropped.collabId, msgId, sessionId, status: 'dropped', complete: true };
  }
  if (typeof state.inboundLocalSeatDeliveryOf === 'function') {
    return state.inboundLocalSeatDeliveryOf(msgId, sessionId);
  }
  return { collabId: null, msgId, sessionId, status: 'unknown', complete: false };
}

/* 入站可注入目标（设计 §5.2）：本机席位 ∪ 邀请目标（已注册桥但尚无席位）。
 * 非邀请帧仍由注入面按席位拒绝，虚拟条目只服务邀请首帧。 */
function listInjectableTargetsOf(state, collabId) {
  const local = state.collabs.get(collabId);
  /* 归档席位仍留在目标集：终态/控制帧（end/leave/withdraw 等）由 consume 先行处置后再投递，
   * 必须在注入面可达；内容类由 injectableSeatOf 按 seat-archived 拒绝。 */
  const targets = local === undefined ? [] : listLocalSeatsOf(local);
  const seated = new Set(targets.map((seat) => seat.sessionId));
  for (const [sessionId, bridgeId] of state.sessionBridges) {
    if (seated.has(sessionId)) {
      continue;
    }
    targets.push({ sessionId, role: 'member', state: 'joining', joinSeq: null, muted: false, unverified: true, archived: false, bridgeId });
  }
  return targets;
}

/* 桥注销的绑定面：该桥是当前桥（或强制注销）才删除；宽限计时只挂给「删除后仍无当前桥」
 * 的情形——条件在删除后读，旧桥迟到断开不得给新桥打宽限。 */
function unregisterSessionBridgeOf(state, sessionId, bridgeId) {
  if (bridgeId === null || state.sessionBridges.get(sessionId) === bridgeId) {
    state.sessionBridges.delete(sessionId);
  }
  if (bridgeId === null || state.sessionBridges.get(sessionId) === undefined) {
    markConfirmGateClosed(state, sessionId, state.clock());
  }
}

/* dispatch 宽限与 confirm-gate 同一条件：桥清理后仍无当前桥才算断开——
 * 旧桥迟到断开不得给新桥打宽限。 */
function noteDispatchBridgeClosedOf(state, sessionId) {
  if (state.sessionBridges.get(sessionId) === undefined) {
    state.dispatchDomain?.noteBridgeClosed?.(sessionId, state.clock());
  }
}

function unregisterBridgeNow(state, sessionId, bridgeId) {
  if (!validSessionId(sessionId)) {
    return { ok: false, reason: 'bad-session' };
  }
  unregisterSessionBridgeOf(state, sessionId, bridgeId);
  noteDispatchBridgeClosedOf(state, sessionId);
  let cleared = 0;
  for (const local of state.collabs.values()) {
    const seat = localSeatOfLocal(local, sessionId);
    if (seat === null || (bridgeId !== null && seat.bridgeId !== bridgeId)) {
      continue;
    }
    seat.bridgeId = null;
    cleared++;
    /* 桥断开＝席位会话结束起点（宽限计时/自动移交判据）。 */
    try {
      noteSeatClosed(state, local.collabId, sessionId);
    } catch (error) {
      state.counters.eventFailures++;
      state.log.warn('席位断开记账异常（已隔离）', { collabId: local.collabId, sessionId, reason: error?.message });
    }
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
  return [...seatsOfLocal(local).values()]
    .filter((seat) => !isSeatArchived(seat))
    .map((seat) => ({
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
    if (seat !== null && !isSeatArchived(seat)) {
      seats.push({ collabId: local.collabId, ...seatViewOf(seat) });
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
    seatRemovals: 0,      // 本轮本机席位移除数（所有 removeLocalSeat 路径经同一钩子，去重计数）
    seatBridgeRegistrations: 0,
    seatFileCorrupt: 0,
    seatPersistFailures: 0,
    seatFileRemoveFailures: 0,
    seatRecoveredFromCarrier: 0,
    createLedgerUnreadable: 0,
    localDeliveryLedgerFailures: 0,
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
    leaveFramesSent: 0,   // 本轮入队的 leave 帧数（核心退出冲刷的触发信号）
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
    ledgerRebuildBlocked: 0,
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
    capabilityProbeFailures: 0,
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

/* 确认门工具面（2026-10-29）：set/status/clear。临时值只改内存；永久值先写 config.json，
 * 写成功后改内存——不得出现「内存已改、盘上没改」。persistent 的 set/clear 首次只发令牌。 */
function setConfirmGateOf(state, rawInput) {
  const input = rawInput ?? {};
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
  if (sessionId === '') {
    return { ok: false, message: '无会话标识——无法定位本会话的确认门' };
  }
  const gate = input.gate ?? 'both';
  const refusal = confirmGateArgsRefusalOf(input, gate);
  if (refusal !== null) {
    return refusal;
  }
  const scope = input.scope ?? 'session';
  if (input.action === 'status') {
    /* 状态读面同时是宽限清理点：桥断开后超过宽限的会话覆盖必须在下一次查询时消失，
     * 否则「临时免确认」会因无人清扫而长期滞留。 */
    pruneConfirmGates(state, state.clock());
    return confirmGateStatusOf(state, sessionId, gate);
  }
  if (input.action === 'set') {
    return setConfirmGateValueOf(state, {
      sessionId, gate, value: input.requireConfirmation, scope, confirmToken: input.confirmToken,
    });
  }
  return clearConfirmGateValueOf(state, { sessionId, gate, scope, confirmToken: input.confirmToken });
}

/* 参数形态的单一校验面（入参已归一为非空对象）：错误文案与判定顺序即对外契约
 * （action → gate → both → scope → 布尔值）。 */
function confirmGateArgsRefusalOf(input, gate) {
  const action = input.action;
  if (!['set', 'status', 'clear'].includes(action)) {
    return { ok: false, message: `action 非法（可取值：set / status / clear）：${String(action)}` };
  }
  const gateRefusal = confirmGateGateRefusalOf(gate);
  if (gateRefusal !== null) {
    return gateRefusal;
  }
  if (action === 'status') {
    return null;
  }
  return action === 'set' ? confirmGateSetArgsRefusalOf(input, gate) : confirmGateClearArgsRefusalOf(input, gate);
}

function confirmGateGateRefusalOf(gate) {
  if (gate !== 'invite' && gate !== 'join' && gate !== 'claim' && gate !== 'both' && gate !== 'all') {
    return { ok: false, message: `gate 非法（可取值：invite / join / claim / both / all）：${String(gate)}` };
  }
  return null;
}

function confirmGateBothRefusal() {
  return { ok: false, message: 'set / clear 必须指定 gate（invite / join / claim）——各门的方向与风险不同，不合并设置' };
}

function confirmGateScopeRefusalOf(scope) {
  if (scope !== 'session' && scope !== 'persistent') {
    return { ok: false, message: `scope 非法（可取值：session / persistent）：${String(scope)}` };
  }
  return null;
}

function confirmGateSetArgsRefusalOf(input, gate) {
  if (gate === 'both' || gate === 'all') {
    return confirmGateBothRefusal();
  }
  const scopeRefusal = confirmGateScopeRefusalOf(input.scope ?? 'session');
  if (scopeRefusal !== null) {
    return scopeRefusal;
  }
  if (typeof input.requireConfirmation !== 'boolean') {
    return { ok: false, message: 'requireConfirmation 非法：set 需要布尔值（true＝需要人工确认，false＝免确认）' };
  }
  return null;
}

function confirmGateClearArgsRefusalOf(input, gate) {
  if (gate === 'both' || gate === 'all') {
    return confirmGateBothRefusal();
  }
  return confirmGateScopeRefusalOf(input.scope ?? 'session');
}

function confirmGateStatusOf(state, sessionId, gate) {
  const keys = gate === 'all'
    ? ['invite', 'join', 'claim']
    : gate === 'both' ? ['invite', 'join'] : [gate];
  const gates = {};
  for (const key of keys) {
    gates[key] = gateValueOf(state, sessionId, key);
  }
  return { ok: true, gates };
}

function setConfirmGateValueOf(state, { sessionId, gate, value, scope, confirmToken }) {
  if (scope === 'persistent') {
    const tokenResult = requireConfirmTokenOf(state, { sessionId, action: 'set', gate, value, confirmToken });
    if (tokenResult !== null) {
      return tokenResult;
    }
    const next = { ...state.config, [gateConfigKey(gate)]: value };
    try {
      saveConfig(state.dataDir, next);
    } catch (error) {
      return { ok: false, message: `写 config.json 失败（未改内存）：${error?.message ?? '未知原因'}` };
    }
    state.config[gateConfigKey(gate)] = value;
    clearSessionGate(state, sessionId, gate);
  } else {
    setSessionGate(state, sessionId, gate, value, state.clock());
  }
  return { ok: true, gate, scope, ...gateValueOf(state, sessionId, gate) };
}

function clearConfirmGateValueOf(state, { sessionId, gate, scope, confirmToken }) {
  if (scope === 'persistent') {
    const tokenResult = requireConfirmTokenOf(state, { sessionId, action: 'clear', gate, value: undefined, confirmToken });
    if (tokenResult !== null) {
      return tokenResult;
    }
    const next = { ...state.config };
    delete next[gateConfigKey(gate)];
    try {
      saveConfig(state.dataDir, next);
    } catch (error) {
      return { ok: false, message: `写 config.json 失败（未改内存）：${error?.message ?? '未知原因'}` };
    }
    state.config[gateConfigKey(gate)] = true;
    clearSessionGate(state, sessionId, gate);
  } else {
    clearSessionGate(state, sessionId, gate);
  }
  return { ok: true, gate, scope, ...gateValueOf(state, sessionId, gate) };
}

/* 永久设置的确认令牌：首次只签发并返回摘要；携令牌重试才返回 null（放行）。 */
function requireConfirmTokenOf(state, { sessionId, action, gate, value, confirmToken }) {
  if (typeof confirmToken === 'string' && confirmToken !== '') {
    if (!consumeConfirmToken(state, { sessionId, action, gate, value, token: confirmToken, now: state.clock() })) {
      return { ok: false, message: '确认令牌无效、已过期或与本次操作不匹配——请重新发起' };
    }
    return null;
  }
  const token = issueConfirmToken(state, { sessionId, action, gate, value, now: state.clock() });
  const verb = action === 'set'
    ? (value === false ? '关闭' : '开启')
    : '清除';
  return {
    ok: false,
    needsUserConfirmation: true,
    confirmToken: token,
    summary: `将对本机所有会话${verb}「${gate === 'invite' ? '邀请人工确认' : '加入申请人工批准'}」——这是整机级设置，需用户明确同意后携令牌重试`,
  };
}
