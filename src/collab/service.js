import { listLocalCollabIds, loadLedger, loadMember, loadSnapshot, quarantineLedger } from './store.js';
import { isArchived, withDefaultMode } from './model.js';
import { createPostsStore } from './posts.js';
import { createMembersStore } from './members.js';
import { createCounterStore, notifyIndicatorChange } from './counter.js';
import { POST_KINDS } from '../net/protocol.js';
import { decideAdmission, SYNC_REQUEST_MAX, SYNC_REQUEST_WINDOW_MS } from './gate.js';
import { handleEvent } from './events.js';
import { localModeOf, localNameOf, localRosterOf, localStateOf, persistLedger } from './local.js';
import { applyRelayedReport, approveInvite, countLiveCollabs, createCollab, endCollab, inviteMembers, leaveCollab, sendMessage, viewLedger, withdrawInvite } from './outgoing.js';
import { JOIN_REPLAY_INTERVALS_MS, SYNC_MAX_REQUESTS_PER_CYCLE, SYNC_MAX_SOURCES_PER_CYCLE, SYNC_REPLY_TIMEOUT_MS, SYNC_SOFT_BUNDLE_BYTES, SYNC_TAIL_POSTS, SYNC_TAIL_WINDOW_MS, runSyncCycle, runSyncSweep, startSyncEngine, stopSyncEngine, triggerSync } from './sync.js';
import { HANDSHAKE_REPLY_TIMEOUT_MS, TAKEOVER_PROBE_INTERVAL_MS, runHandshake, startLiveness, stopLiveness, takeOver } from './takeover.js';
import { decide, decideMergeOffer } from './freeze.js';
import { HANDOVER_CONFIRM_TIMEOUT_MS, handover } from './handover.js';

/* 协作服务（协作核心与治理的门面）：注册表加载与恢复、公共 API、接收管线钩子（admit / consume）装配、
 * 探测定时器与握手生命周期、抢接 / 裁定 / 移交的等待面、计数器。
 * 钩子、事件与定时器路径一律不抛出（健壮性硬性要求）——异常隔离为计数与告警。
 * 依赖全部经参数注入（send = dispatch.send；probe = dispatch.ping；reassign = dispatch.reassignPeer；
 * notify = 会话注入面；knownHosts 供「协作参与者地址」一源接入）。 */

const LEDGER_FETCH_TIMEOUT_MS = 3000;
const INVITE_MIN_INTERVAL_MS = 1000;

/**
 * @param {{ dataDir: string, config: any, self: any, send: (message: object) => any, knownHosts: any, log: any,
 *   probe?: ((address: string, port: number) => Promise<{ reachable: boolean, rttMs?: number, reason?: string }>) | null,
 *   reassign?: ((payload: object) => { ok: boolean, moved?: number, reason?: string }) | null,
 *   notify?: ((frame: object) => unknown) | null,
 *   sendDirect?: ((message: object) => { ok: boolean, msgId?: string, tier?: string, reason?: string }) | null,
 *   onIndicatorChange?: (() => void) | null,
 *   ledgerFetchTimeoutMs?: number, inviteMinIntervalMs?: number, takeoverProbeIntervalMs?: number,
 *   handshakeReplyTimeoutMs?: number, handoverConfirmTimeoutMs?: number,
 *   pullReplyTimeoutMs?: number, syncMaxRequestsPerCycle?: number, syncMaxSourcesPerCycle?: number,
 *   syncSoftBundleBytes?: number, syncTailPosts?: number, syncTailWindowMs?: number,
 *   syncPeerPicker?: ((context: { collabId: string, candidates: string[] }) => string[] | null) | null,
 *   syncRequestWindowMs?: number, syncRequestMax?: number, joinReplayIntervalsMs?: number[] }} options
 */
export function createCollabService(options) {
  const state = buildState(options);
  loadRegistry(state);
  return apiOf(state);
}

function buildState(options) {
  return {
    ...coreStateOf(options),
    ...syncStateOf(options),
    ...runtimeMaps(),
    onIndicatorChange: options.onIndicatorChange ?? null,
    probeTimer: null,
    syncTimer: null,
    started: false,
    counters: emptyCounters(),
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
    relayDown: new Set(),      // 中继降级态的 collabId 集（探测不可达置位；恢复检测清除）
  };
}

function apiOf(state) {
  return {
    hooks: {
      admit: (frame, meta) => gateFrame(state, frame, meta),
      consume: (frame, meta) => consumeFrame(state, frame, meta),
    },
    start: () => startService(state),
    handshake: (options) => runHandshake(state, options ?? {}),
    takeOver: (input) => takeOver(state, input),
    decide: (input) => decide(state, input),
    decideMerge: (input) => decideMergeOffer(state, input),
    handover: (input) => handover(state, input),
    list: () => listCollabs(state),
    indicators: () => indicators(state),
    create: (input) => createCollab(state, input),
    invite: (input) => inviteMembers(state, input),
    approve: (input) => approveNow(state, input),
    relayReport: (input) => applyRelayedReport(state, input),   // 网层回报注入面（转达副本达第三档 → 译回原作者）
    withdraw: (input) => withdrawInvite(state, input),
    send: (input) => sendMessage(state, input),
    end: (input) => endCollab(state, input),
    leave: (input) => leaveCollab(state, input),
    view: (input) => viewLedger(state, input),
    describe: (collabId) => describeCollab(state, collabId),
    count: () => countLiveCollabs(state),
    sync: (input) => syncNow(state, input),
    stats: () => statsOf(state),
    close: () => closeService(state),
  };
}

/* 门控包装：异常隔离为拒绝（与准入钩子「异常按未通过归类」的既有语义一致）。 */
function gateFrame(state, frame, meta) {
  try {
    return decideAdmission(state, frame, meta);
  } catch (error) {
    state.counters.gateFailures++;
    return { ok: false, reason: `协作门控异常：${error?.message ?? '未知原因'}` };
  }
}

/* 事件包装：异常隔离为计数与告警——协作事件绝不因内部错误穿出接收管线（健壮性硬性要求）。
 * 返回值透传（讨论的帖去重栅栏经它声明「不重复注入会话」；异常归 undefined = 保持照旧注入）。 */
async function consumeFrame(state, frame, meta) {
  try {
    state.counters.eventsHandled++;
    noteContentMessage(state, frame);
    return await handleEvent(state, frame, meta);
  } catch (error) {
    state.counters.eventFailures++;
    state.log.error('协作事件处理异常（已隔离）', { type: frame?.type, collabId: frame?.collabId, reason: error?.message });
    return undefined;
  }
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

/* 注册表加载：collabs/ 目录逐协作恢复（成员记录必需、台账 / 快照可选）；单条加载失败只计数跳过，
 * 不阻塞进程（坏数据不得让服务起不来）。 */
function loadRegistry(state) {
  for (const collabId of listLocalCollabIds(state.dataDir)) {
    try {
      state.collabs.set(collabId, loadOne(state, collabId));
    } catch (error) {
      state.counters.loadFailures++;
      state.log.warn('协作加载失败（跳过该条）', { collabId, reason: error.message });
    }
  }
}

/* 载入兼容：缺 mode 的旧记录按 managed 解释（读取侧宽容、写入侧写全——对照 port 缺省先例；
 * 就地补缺省值，后续落盘即写全）。快照内嵌台账不做补写（其 digest 与内容自洽，改动会破坏一致性）。 */
function loadOne(state, collabId) {
  const member = loadMember(state.dataDir, collabId);
  if (member === null) {
    throw new Error('缺少可用的成员记录（member.json）');
  }
  withDefaultMode(member);
  const local = {
    collabId,
    role: member.role,
    ledger: null,
    member,
    endpoints: new Map(Object.entries(member.endpoints)),
    snapshot: loadSnapshot(state.dataDir, collabId),
    posts: createPostsStore({ dataDir: state.dataDir, collabId, log: state.log, onChange: () => notifyIndicatorChange(state) }),
    members: createMembersStore({ dataDir: state.dataDir, collabId, log: state.log, onChange: () => notifyIndicatorChange(state) }),
    counter: createCounterStore({ dataDir: state.dataDir, collabId, log: state.log, onChange: () => notifyIndicatorChange(state) }),
    suspended: null,
    staleManagerId: null,
  };
  if (local.role === 'manager') {
    local.ledger = recoverLedger(state, collabId, local);
  }
  return local;
}

/* 管理席位台账的加载与损坏重建（设计 §13：保留损坏副本、从最近快照重建并提示差异）：
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
    return { source: 'snapshot', ledger: { ...fromSnapshot, mode: fromSnapshot.mode ?? local.member.mode } };
  }
  const now = new Date().toISOString();
  return {
    source: 'member',
    ledger: {
      version: 1,
      collabId,
      name: local.member.name,
      topic: '（台账损坏重建——主题待确认）',
      mode: local.member.mode,
      status: 'proposed',
      manager: { instanceId: local.member.manager.instanceId, identityName: local.member.manager.identityName },
      members: [{ instanceId: local.member.manager.instanceId, identityName: local.member.manager.identityName, role: 'manager', state: 'member', joinedAt: now }],
      board: [],
      createdAt: now,
      updatedAt: now,
    },
  };
}

/* 本机参与清单（ws_list_collabs 的数据面）：状态取本地权威；expired = 提议中且未回应且已过
 * 有效期（仅标注，不改状态——设计 §6 的「过期不算拒绝」）。
 * 治理面读数：managerOffline（成员侧失联判定）、frozenUnresolved（冻结超时已提示一次）、
 * suspended（收敛等待中的写暂停）、handshakeUnresolved（成员侧握手未能对表——只读保守运行）。 */
function listCollabs(state) {
  const now = Date.now();
  const collabs = [];
  for (const local of state.collabs.values()) {
    collabs.push(listEntryOf(state, local, now));
  }
  return { collabs };
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

function listEntryOf(state, local, now) {
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
    archived: isArchived(stateName),
    managerOffline: local.role === 'manager' ? false : (probeState?.offline === true),
    frozenUnresolved: local.freezeDeadlineNotified === true,
    suspended: local.suspended !== null,
    handshakeUnresolved: local.handshakeUnresolved === true,
    ...inviteViewOf(local, now),
  };
}

/* 邀请视图（成员侧）：决策 / 有效期与过期标注（仅标注、不改状态——设计 §6 的「过期不算拒绝」）；
 * 管理席位给空面。 */
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

/* 适配器描述器（上下文头项目名）：本机已知协作的名称；未知返回 null（头行退化为「身份名 时间戳」）。 */
function describeCollab(state, collabId) {
  const local = state.collabs.get(collabId);
  if (local === undefined) {
    return null;
  }
  return { name: localNameOf(local) };
}

function statsOf(state) {
  const byState = {};
  for (const local of state.collabs.values()) {
    const stateName = localStateOf(local);
    byState[stateName] = (byState[stateName] ?? 0) + 1;
  }
  return { collabs: state.collabs.size, byState, ...state.counters };
}

/* 邀请回应的驱动面（讨论）：同意即加入后立即起一轮回填对表（复用周期对表的同一入口）——
 * 新人不必等下一个周期节拍（默认 60s）才看到历史。让出到微任务边界再起：本机这一回合的外发
 * 次序为 join 自播先、对表请求后（应答方准入按「请求方在成员表内」把关——请求先到会被拒）。 */
function approveNow(state, input) {
  const result = approveInvite(state, input);
  if (result.ok === true && result.joined === true) {
    const local = state.collabs.get(input?.collabId);
    if (local !== undefined) {
      queueMicrotask(() => {
        triggerSync(state, local, { reason: 'join-decided' });
      });
    }
  }
  return result;
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

/* 门控与存储计数（冻结 / 丢弃 / 快照 / 健壮性观测面）。 */
function emptyGuardCounters() {
  return {
    freezeDetected: 0,
    freezeApplied: 0,
    freezeRelayed: 0,
    freezeUnmatched: 0,
    forumGovernanceIgnored: 0,
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
    indicatorChangeFailures: 0,
    loadFailures: 0,
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
