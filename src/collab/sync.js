import { MAX_FRAME_BYTES, MAX_TOPIC_CHARS, isPresentationText } from '../net/protocol.js';
import { isPostEntryShape, displayOrderOf } from './posts.js';
import { foldedMembersOf, forumReachIdsOf, isLocalArchivedState, localModeOf, localNameOf, persistMember, primarySeatOf, selfJoinedOf } from './local.js';
import { applyEndpoint, checkRelayRecovery, endpointFor, mutateLedger, notifyLocal, startJoinReplay, stopJoinReplay, stopJoinReplays } from './outgoing.js';
import { foldMemberEvents } from './members.js';
import { isPeerShape, isTimestamp } from './model.js';

/* 讨论模式的拉取机制（真对账）与成员收敛（设计 §5.3/§5.4/§5.5）：
 * - 同步游标只由拉取推进（直投到位的帖只进本地列表、不动游标——漏段不会被游标跳过）；
 * - 尾部重叠窗口（辅助）负责近端/尾部竞态的快速自愈，中段漏段由真对账（作者粒度摘要比对 +
 *   有界回退重拉）承担；
 * - 成员关系以事件集并集收敛，join 未收敛前递增间隔重播（对表自愈），元状态单调推进、终态吸收。
 * 拉取两件套归控制事件类：经直投通道（短重试、非持久落盘）——无应答即换源或下轮 tick，不泛化豁免。 */

/* 参数（设计委派项，计划 §4 落定；数值集中定义并注释理由）：
 * 尾部窗口取宽（两口径满足其一即纳入）；单帧软阈 = 1 MiB 硬顶之半（为元状态/事件集/端点表留余量）。 */
export const SYNC_TAIL_POSTS = 20;
export const SYNC_TAIL_WINDOW_MS = 5 * 60 * 1000;
export const SYNC_SOFT_BUNDLE_BYTES = MAX_FRAME_BYTES / 2;
/* 请求-应答等待窗与同节拍有界次数（回退重拉 + 分段续拉共用同一预算，余量交下轮 tick）。
 * 预算 2 与入站限流（同源 10s 内 2 次，gate.js）对齐——超出者在接收侧被拒（即「无应答」），
 * 只会白白耗尽本轮：大段回填按 2 段/轮推进，跨 tick 续拉至追平。 */
export const SYNC_REPLY_TIMEOUT_MS = 5000;
export const SYNC_MAX_REQUESTS_PER_CYCLE = 2;
export const SYNC_MAX_SOURCES_PER_CYCLE = 3;
/* join 未收敛重播的递增间隔（有界 5 次；每轮对表仍未收敛则重新起一轮——防风暴同时保自愈）。 */
export const JOIN_REPLAY_INTERVALS_MS = [2000, 4000, 8000, 16000, 32000];
/* 对表节拍的兜底值（与 config.buildDefaults 的 forumSyncIntervalMs 默认一致；配置权威在 config，
 * 此处兜住「构造面只给部分配置」的夹具路径——缺省不得落成 setInterval 的 1ms 自旋）。 */
export const SYNC_INTERVAL_FALLBACK_MS = 60000;

/* —— 引擎生命周期 —— */

/* 周期对表（anti-entropy，默认 60s 可配）：启动即扫一轮（进程启动触发面），此后按节拍扫。
 * 定时器不阻止进程退出（会话关闭即退出是产品语义）。 */
export function startSyncEngine(state) {
  if (state.syncTimer !== null) {
    return;
  }
  state.syncTimer = setInterval(() => {
    runSyncSweep(state, { reason: 'tick' });
  }, state.config.forumSyncIntervalMs ?? SYNC_INTERVAL_FALLBACK_MS);
  if (typeof state.syncTimer.unref === 'function') {
    state.syncTimer.unref();
  }
  runSyncSweep(state, { reason: 'startup' });
}

export function stopSyncEngine(state) {
  if (state.syncTimer !== null) {
    clearInterval(state.syncTimer);
    state.syncTimer = null;
  }
  for (const waiter of state.syncWaiters.values()) {
    clearTimeout(waiter.timer);
    waiter.resolve(null);
  }
  state.syncWaiters.clear();
  stopJoinReplays(state);
}

/* 全量扫一轮（触发面统一入口）：逐个讨论实例起火（fire-and-forget，异常隔离为计数与告警）。 */
export function runSyncSweep(state, options = {}) {
  for (const local of [...state.collabs.values()]) {
    if (localModeOf(local) !== 'forum' || isLocalArchivedState(local)) {
      continue;
    }
    triggerSync(state, local, options);
  }
}

export function triggerSync(state, local, options = {}) {
  runSyncCycle(state, local, options).catch((error) => {
    state.counters.syncFailures++;
    state.log.warn('对表任务异常（已隔离）', { collabId: local.collabId, reason: error?.message });
  });
}

/* 一轮对表（单个讨论）：中继恢复检测（降级态下顺带探测）→ 选取对端序 → 逐个拉取；
 * 一个源拉通即收（换源重试的有界形态）。同一实例同时只跑一轮（tick 与 join/leave 触发面
 * 互不叠加）；只对已加入（自播过 join）的讨论运行——受邀待回应 / 已拒绝者不是成员，拉取请求
 * 必被应答方按成员面拒绝，只会空耗请求预算并污染对方的拒绝计数（异常信号不被常态请求淹没）。 */
export async function runSyncCycle(state, local, options = {}) {
  if (localModeOf(local) !== 'forum' || isLocalArchivedState(local)) {
    return { ok: false, reason: 'not-applicable' };
  }
  if (!selfJoinedOf(local, state.self.instanceId)) {
    return { ok: false, reason: 'not-joined' };
  }
  if (state.syncActive.has(local.collabId)) {
    return { ok: false, reason: 'already-running' };
  }
  /* 在途置位先于恢复检测的 await：检测（探测）有等待窗，置位若排在它后面，窗口内并发触发的
   * 第二轮会绕过 already-running 判定、与在途轮次叠加（try/finally 覆盖含检测在内的全部返回分支）。 */
  state.syncActive.add(local.collabId);
  try {
    if (state.relayDown.has(local.collabId)) {
      /* 恢复检测只在降级态下挂上——非降级时不入此分支，本轮对表的既有次序（同步前奏直进拉取）不变。
       * 检测不改变本轮拉取结论（异常已在其内隔离）。 */
      await checkRelayRecovery(state, local);
    }
    const candidates = syncCandidatesOf(state, local, options);
    if (candidates.length === 0) {
      state.counters.syncNoPeer++;
      nudgeJoinReplay(state, local);   // 拉取无从发起 = 未确认：重播面照走（递增间隔有界）
      return { ok: false, reason: 'no-peer' };
    }
    const sources = pickSources(state, local, candidates, options);
    state.counters.syncCycles++;
    for (const sourceId of sources) {
      const outcome = await pullFrom(state, local, sourceId, options);
      if (outcome.ok === true) {
        return outcome;
      }
    }
    nudgeJoinReplay(state, local);   // 拉取被拒 / 超时视同未确认：计入重播判据（设计 §5.4）
    return { ok: false, reason: 'no-answer' };
  } finally {
    state.syncActive.delete(local.collabId);
  }
}

/* 未确认面下的重播续接：本机已加入（自播过 join）、尚未被任何对端表确认、且无重播在跑时，
 * 重新起一轮递增间隔有界重播（防幽灵成员——「拉取被拒/超时视同未确认」的落点）。 */
function nudgeJoinReplay(state, local) {
  if (localModeOf(local) !== 'forum' || local.role !== 'member' || local.joinConfirmed === true) {
    return;
  }
  const seats = localJoinSeatsOf(local, state.self.instanceId);
  if (seats.length > 0) {
    startJoinReplay(state, local, seats[0].event, seats[0].sessionId ?? undefined);
  }
}

/* 候选对端：群体可达面（折叠成员表 ∪ 邀请者引用 ∪ 端点表已知者，见 local.forumReachIdsOf）——
 * 设计 §5.3「向任一在场成员发 history-request」的落点：新成员在折叠表未收敛、对端事件未拉回时
 * 仍能按邀请随带的端点表发起对表；只保留端点已知者（可达性近似——端点未知者由对方主动联系或
 * 后续对表补学）。options.sources 为定向回拉（应答后的补面），不扩面。 */
function syncCandidatesOf(state, local, options) {
  if (Array.isArray(options.sources)) {
    const ids = new Set(options.sources);
    ids.delete(state.self.instanceId);
    return [...ids].filter((id) => endpointFor(state, local, id) !== undefined);
  }
  return forumReachIdsOf(local, state.self.instanceId).filter((id) => endpointFor(state, local, id) !== undefined);
}

/* 对端序：默认按候选稳定序轮换（避免固定单一对端造成「洞持有者互不碰面」的漏检）；
 * 注入缝（构造注入或单轮 options）返回完整优先序——确定性测试用固定序列。 */
function pickSources(state, local, candidates, options) {
  const picker = typeof options.syncPeerPicker === 'function' ? options.syncPeerPicker : state.syncPeerPicker;
  const picked = typeof picker === 'function'
    ? picker({ collabId: local.collabId, candidates: [...candidates] })
    : rotateCandidates(state, local.collabId, candidates);
  const ordered = Array.isArray(picked) ? picked : candidates;
  return ordered.filter((id) => candidates.includes(id)).slice(0, options.maxSources ?? state.syncMaxSourcesPerCycle);
}

function rotateCandidates(state, collabId, candidates) {
  const sorted = [...candidates].sort();
  const start = (state.syncRotations.get(collabId) ?? 0) % sorted.length;
  state.syncRotations.set(collabId, (start + 1) % sorted.length);
  return [...sorted.slice(start), ...sorted.slice(0, start)];
}

/* 向一个源拉取：请求-应答循环（分段续拉 + 摘要不一致的有界回退重拉共用同一请求预算）。 */
async function pullFrom(state, local, sourceId, options) {
  const endpoint = endpointFor(state, local, sourceId);
  if (endpoint === undefined) {
    return { ok: false, reason: 'endpoint-unknown' };
  }
  const cycle = { backfilled: 0 };
  const outcome = await runPullLoop(state, local, sourceId, endpoint, options, cycle);
  if (cycle.backfilled > 0) {
    notifyLocal(state, local, `讨论「${localNameOf(local)}」已回填 ${cycle.backfilled} 帖（拉取通道静默入列，见 ws_view_ledger 本地视图）`);
  }
  return outcome;
}

async function runPullLoop(state, local, sourceId, endpoint, options, cycle) {
  const limit = options.maxRequests ?? state.syncMaxRequestsPerCycle;
  let after = options.startAfter !== undefined ? options.startAfter : (local.member.syncCursor ?? null);
  for (let sent = 0; sent < limit; sent++) {
    const answer = await requestBundle(state, local, sourceId, endpoint, after);
    if (answer === null) {
      state.counters.syncNoAnswer++;
      return { ok: false, reason: 'no-answer', sourceId };
    }
    cycle.backfilled += answer.merge.backfilled;
    const payload = answer.frame.payload;
    if (payload.more === true) {
      state.counters.syncSegments++;
      after = payload.nextAfter;
      continue;
    }
    const plan = rollbackPlanOf(local.posts.entries(), payload.summary);
    if (plan.needed === false) {
      return { ok: true, sourceId };
    }
    state.counters.syncMismatches++;
    state.counters.syncRollbacks++;
    state.log.warn('真对账摘要不一致——回退重拉', { collabId: local.collabId, sourceId, fromBeginning: plan.start === null });
    after = plan.start;
  }
  return { ok: true, partial: true, sourceId };
}

/* 单次请求-应答：注册等待面 → 直投发请求 → 等应答（超时或直投未受理都归「无应答」，不再重试该源）。 */
function requestBundle(state, local, sourceId, endpoint, after) {
  return new Promise((resolve) => {
    const key = waiterKeyOf(local.collabId, sourceId);
    const timer = setTimeout(() => {
      settleSyncWaiter(state, key, null);
    }, state.pullReplyTimeoutMs);
    if (typeof timer.unref === 'function') {
      timer.unref();   // 等待面不阻止进程退出（会话关闭即退出是产品语义）
    }
    state.syncWaiters.set(key, { timer, resolve });
    if (sendHistoryRequest(state, local, sourceId, endpoint, after).ok !== true) {
      settleSyncWaiter(state, key, null);
    }
  });
}

function sendHistoryRequest(state, local, sourceId, endpoint, after) {
  if (typeof state.sendDirect !== 'function') {
    state.counters.syncSendSkipped++;
    return { ok: false, reason: '直投面不可用（发送注入缺失）' };
  }
  const result = state.sendDirect({
    collabId: local.collabId,
    to: { instanceId: sourceId, address: endpoint.address, port: endpoint.port },
    type: 'history-request',
    payload: { after: after ?? null, summary: summaryOf(local.posts.entries()) },
    fromSessionId: syncSignerSessionOf(local),
  });
  if (result.ok === true) {
    state.counters.syncRequestsSent++;
  }
  return result;
}

/* 拉取两件套的发送席位（0.2.0 帧必须携 from.sessionId）：本机在该讨论的活跃席位，
 * 无席位表的历史夹具返回 undefined（由 dispatch 预检如实拒绝，不伪造身份）。 */
function syncSignerSessionOf(local) {
  return primarySeatOf(local)?.sessionId;
}

function waiterKeyOf(collabId, sourceId) {
  return `${collabId}\u0000${sourceId}`;
}

function settleSyncWaiter(state, key, value) {
  const waiter = state.syncWaiters.get(key);
  if (waiter === undefined) {
    return false;
  }
  state.syncWaiters.delete(key);
  clearTimeout(waiter.timer);
  waiter.resolve(value);
  return true;
}

/* —— 接收侧：两件套 —— */

/* 拉取请求应答（设计 §5.3）：把当前副本（增量段 + 尾部窗口 + 元状态 + 成员事件集 + 端点表 +
 * 对表交换面）回给请求方。归档后仍应答（只读回填通道不因归档关闭——gate 已放行且校验成员面）。
 * 对表双向：请求方摘要与本机摘要比对，本机所缺（对端有而本机无）则起一次定向回退重拉。 */
export function handleHistoryRequest(state, frame) {
  const local = state.collabs.get(frame.collabId);
  if (local === undefined || localModeOf(local) !== 'forum') {
    return undefined;
  }
  answerHistoryRequest(state, local, frame);
  return { sessionDeliver: false };   // 拉取通道帧不进会话注入（设计 §5.3 呈现口径）
}

function answerHistoryRequest(state, local, frame) {
  const endpoint = endpointFor(state, local, frame.from.instanceId);
  if (endpoint === undefined) {
    state.counters.syncBundleSkipped++;
    return;
  }
  if (typeof state.sendDirect !== 'function') {
    state.counters.syncSendSkipped++;
    return;
  }
  const payload = buildBundle(state, local, frame.payload);
  const sent = state.sendDirect({
    collabId: local.collabId,
    to: { instanceId: frame.from.instanceId, address: endpoint.address, port: endpoint.port },
    type: 'history-bundle',
    payload,
    fromSessionId: syncSignerSessionOf(local),
  });
  if (sent.ok === true) {
    state.counters.syncBundlesSent++;
  }
  const plan = rollbackPlanOf(local.posts.entries(), frame.payload.summary);
  if (plan.needed) {
    state.counters.syncMismatches++;
    triggerSync(state, local, { sources: [frame.from.instanceId], startAfter: plan.start });
  }
}

/* 拉取应答到达：合并（幂等并集/去重）→ 唤醒等待面 → join 收敛判定（对表自愈）。
 * 未经请求的迟到副本同样合并（增量吸收无害；游标只升）；在途轮次的汇总行由轮次收口，
 * 非在途到达的回填在此补一行（呈现口径：拉取帖始终不进会话、只汇总）。 */
export function handleHistoryBundle(state, frame) {
  const local = state.collabs.get(frame.collabId);
  if (local === undefined || localModeOf(local) !== 'forum') {
    return undefined;
  }
  const merge = mergeBundle(state, local, frame.payload);
  state.counters.syncBundlesIn++;
  const awaited = settleSyncWaiter(state, waiterKeyOf(frame.collabId, frame.from.instanceId), { frame, merge });
  if (!awaited && merge.backfilled > 0) {
    notifyLocal(state, local, `讨论「${localNameOf(local)}」已回填 ${merge.backfilled} 帖（拉取通道静默入列，见 ws_view_ledger 本地视图）`);
  }
  settleJoinConvergence(state, local, frame.payload);
  return { sessionDeliver: false };
}

/* 拉取到位合并：端点学习 → 成员事件并集 → 帖子增量与尾部窗口按（作者, postId）去重入列 →
 * 同步游标只由增量段推进（尾部窗口不推——偏移过大的尾部不把中段缺口跳过）→ 元状态单调合并。 */
function mergeBundle(state, local, payload) {
  mergeBundleMembers(state, local, payload.members);
  learnBundleEndpoints(state, local, payload.endpoints);
  const backfilled = appendBundlePosts(state, local, payload.posts) + appendBundlePosts(state, local, payload.overlap);
  advanceSyncCursor(state, local, payload.posts);
  mergeForumMeta(state, local, payload.meta);
  return { backfilled };
}

/* 席位键随成员事件落盘：来源携 sessionId 时如实带上（讨论的成员＝会话，折叠与邀请载荷都按
 * 席位键取人）；缺失时不编造——旧事件按实例折叠，既有档案照常可读（设计 §10）。
 * 取的是事件/帧自带的席位，不是转发者的：对表 bundle 里含着其他实例署名的历史事件。 */
function seatSessionFieldOf(source) {
  return typeof source?.sessionId === 'string' && source.sessionId !== '' ? { sessionId: source.sessionId } : {};
}

function mergeBundleMembers(state, local, events) {
  for (const event of events) {
    const outcome = local.members.apply({
      eventId: event.eventId,
      kind: event.kind,
      instanceId: event.instanceId,
      ...seatSessionFieldOf(event),
      identityName: event.identityName,
      ts: event.ts,
    });
    if (outcome === 'added') {
      state.counters.syncEventsIn++;
    }
  }
  if (local.role === 'manager') {
    activateForumIfNeeded(state, local);
  }
}

/* 端点学习：身份名尽力取（成员事件集先合并——多数端点的身份此时已可知）；缺名不拒（寻址不受影响）。 */
function learnBundleEndpoints(state, local, endpoints) {
  const identities = new Map(foldedMembersOf(local).map((member) => [member.instanceId, member.identityName]));
  for (const [instanceId, endpoint] of Object.entries(endpoints)) {
    if (instanceId === state.self.instanceId) {
      continue;
    }
    try {
      applyEndpoint(state, local, { instanceId, identityName: identities.get(instanceId) ?? '' }, endpoint.address, endpoint.port);
    } catch (error) {
      state.counters.endpointRejected++;
      state.log.warn('拉取端点学习失败（已忽略）', { collabId: local.collabId, instanceId, reason: error.message });
    }
  }
}

function appendBundlePosts(state, local, posts) {
  let added = 0;
  for (const post of posts) {
    if (appendBundledPost(state, local, post)) {
      added++;
    }
  }
  return added;
}

function appendBundledPost(state, local, post) {
  const entry = {
    entryId: post.postId,
    seq: post.seq,
    ts: post.ts,
    from: { instanceId: post.from.instanceId, identityName: post.from.identityName },
    kind: post.kind,
    text: post.text,
  };
  if (!isPostEntryShape(entry)) {
    state.counters.syncPostsRejected++;
    return false;
  }
  if (local.posts.append(entry) !== true) {
    return false;   // 重复副本按（作者, postId）吸收
  }
  state.counters.syncPostsBackfilled++;
  return true;
}

/* 同步游标推进：只取增量段的最大 (ts, postId)（尾部窗口/直投到位都不推游标）；只升不降。 */
function advanceSyncCursor(state, local, posts) {
  let cursor = local.member.syncCursor ?? null;
  let changed = false;
  for (const post of posts) {
    if (cursor === null || comparePosition(post.ts, post.postId, cursor.ts, cursor.postId) > 0) {
      cursor = { ts: post.ts, postId: post.postId };
      changed = true;
    }
  }
  if (!changed) {
    return;
  }
  local.member.syncCursor = cursor;
  persistMember(state, local);
}

/* 元状态合并（设计 §5.3 底部）：单调推进、终态吸收、终态时刻取最早。
 * 发起人侧的台账是元状态的权威面，不从 bundle 合并（陈旧/伪造副本不得回翻本机状态）；
 * 未加入的受邀者不是讨论成员，不随对表改变邀请态（其状态处置走邀请链路）。 */
function mergeForumMeta(state, local, meta) {
  if (!isPlainObject(meta) || local.role === 'manager') {
    return;
  }
  if (!foldedMembersOf(local).some((member) => member.instanceId === state.self.instanceId)) {
    return;
  }
  let changed = mergeForumFacts(state, local, meta);
  if (mergeForumState(state, local, meta.state)) {
    changed = true;
  }
  if (changed) {
    persistMember(state, local);
  }
}

/* 元状态学习的逐字段判据 = 加载面同一权威（model.isPeerShape / model.isTimestamp /
 * protocol.isPresentationText——端口与协作层的形态底线本就是同一套）：不满足不学入、不改写并
 * 计数。为什么必须与加载面同口径：学习面若宽于加载面，一帧可达面内的 bundle 就能把坏值学入并
 * 持久化，重启时该协作整条记录被按坏数据跳过（loadFailures），而「只补不覆」使坏值粘性不可
 * 自愈——网络数据不得成为「重启即跳过」的源头。 */
function mergeForumFacts(state, local, meta) {
  let changed = false;
  if (local.member.topic === undefined && meta.topic !== undefined) {
    if (isPresentationText(meta.topic, MAX_TOPIC_CHARS)) {
      local.member.topic = meta.topic;
      changed = true;
    } else {
      state.counters.forumMetaRejected++;
    }
  }
  if (learnForumOriginator(state, local, meta)) {
    changed = true;
  }
  if (mergeForumStamps(state, local, meta)) {
    changed = true;
  }
  return changed;
}

/* 成立/结束时刻的单调合并（取更早者——终态时刻取最早的既有口径）；坏时间戳不学入并计数。 */
function mergeForumStamps(state, local, meta) {
  const learned = { ...(local.member.forumMeta ?? {}) };
  let changed = false;
  for (const field of ['createdAt', 'establishedAt', 'endedAt']) {
    const value = meta[field];
    if (value === undefined) {
      continue;
    }
    if (!isTimestamp(value)) {
      state.counters.forumMetaRejected++;
      continue;
    }
    if (learned[field] === undefined || value < learned[field]) {
      learned[field] = value;
      changed = true;
    }
  }
  if (changed && Object.keys(learned).length > 0) {
    local.member.forumMeta = learned;
  }
  return changed;
}

/* 发起人实例标识（中继归属）只补不覆：发起人恒不随讨论变——已学得者不被后续来源改写；
 * 迟到成员与敲门入群者经 bundle 元状态补学中继归属（设计 §5.3 携带面）。形态与加载面同判据
 * （isPeerShape）；自指值（instanceId === self）拒绝——发起人恒为他人他机，自指只可能来自
 * 伪造或损坏，学入会让本机把自己当中继。 */
function learnForumOriginator(state, local, meta) {
  const originator = meta.originator;
  if (local.member.originator !== undefined || originator === undefined) {
    return false;
  }
  if (!isPeerShape(originator) || originator.instanceId === state.self.instanceId) {
    state.counters.forumMetaRejected++;
    return false;
  }
  local.member.originator = { instanceId: originator.instanceId, identityName: originator.identityName };
  return true;
}

/* 状态单调推进 + 终态吸收：completed/terminated 为吸收态（任何来源不得回退到先前状态）。 */
function mergeForumState(state, local, metaState) {
  const current = local.member.state;
  if (isLocalArchivedState(local)) {
    return false;
  }
  if (metaState === 'completed' || metaState === 'terminated') {
    local.member.state = metaState;
    if (local.member.archivedAt === undefined) {
      local.member.archivedAt = new Date().toISOString();
    }
    /* 与 end 帧入口（handleEnd）同口径：本地转归档即清静音——不清则重入
     * （receiveRepeatInvite 复用既有记录）时带着幽灵静音，用户从未对重入后的协作设过静音。 */
    local.mute.clear();
    stopJoinReplay(state, local);
    state.counters.syncTerminalsIn++;
    state.log.info('经对表学到讨论终态——本地转归档', { collabId: local.collabId, state: metaState });
    return true;
  }
  if (metaState === 'active' && current === 'proposed') {
    local.member.state = 'active';
    return true;
  }
  return false;
}

/* —— 成员事件接收与收敛 —— */

/* join 到达（设计 §5.4）：事件并入（同 id 重放幂等——重播副本不再重复通知会话）；
 * 发起人侧首个他方 join 令讨论转「进行中」；到达即触发一轮对表（触发面）。 */
export function applyIncomingJoin(state, frame) {
  const local = state.collabs.get(frame.collabId);
  if (local === undefined || localModeOf(local) !== 'forum' || frame.from.instanceId === state.self.instanceId) {
    return undefined;
  }
  const outcome = local.members.apply({
    eventId: frame.payload.eventId,
    kind: 'join',
    instanceId: frame.from.instanceId,
    ...seatSessionFieldOf(frame.from),
    identityName: frame.from.identityName,
    ts: frame.payload.ts,
  });
  if (outcome === 'duplicate') {
    state.counters.forumJoinDuplicates++;
    return { sessionDeliver: false };   // 未收敛重播的重复副本：并集幂等，不重复注入
  }
  if (outcome === 'added') {
    state.counters.forumJoinsIn++;
    state.log.info('成员加入事件（讨论）', { collabId: frame.collabId, instanceId: frame.from.instanceId });
  }
  if (local.role === 'manager') {
    activateForumIfNeeded(state, local);
  }
  triggerSync(state, local, { reason: 'join-arrival' });
  return undefined;
}

/* leave 到达（讨论）：事件并入 + 触发对表。缺事件字段（版本不一致）的 leave 忽略并计数。 */
export function applyIncomingLeave(state, local, frame) {
  if (frame.from.instanceId === state.self.instanceId) {
    return;
  }
  if (typeof frame.payload?.eventId !== 'string') {
    state.counters.eventMismatch++;
    state.log.warn('讨论的 leave 帧缺成员事件字段（忽略——讨论要求参与者同版本）', { collabId: local.collabId });
    return;
  }
  const outcome = local.members.apply({
    eventId: frame.payload.eventId,
    kind: 'leave',
    instanceId: frame.from.instanceId,
    ...seatSessionFieldOf(frame.from),
    identityName: frame.from.identityName,
    ts: frame.payload.ts,
  });
  if (outcome === 'added') {
    state.counters.forumLeavesIn++;
    state.log.info('成员退出事件（讨论）', { collabId: local.collabId, instanceId: frame.from.instanceId });
  }
  triggerSync(state, local, { reason: 'leave-arrival' });
}

/* 发起人侧：首个他方 join 使讨论由「提议中」转「进行中」（设计 §5.1 个别加入制；
 * 发起人自身的创建即入表不构成该边——它是「第一个」成员，不是「首个加入者」）。
 * 成立时刻 = 他方 join 事件的最早 ts（确定性——与到达序无关）。
 * 「他方」按席位判（设计 §2.2）：同机另一会话是独立成员，它的入席也算首个加入者。 */
export function activateForumIfNeeded(state, local) {
  if (local.role !== 'manager' || local.ledger.status !== 'proposed') {
    return false;
  }
  const events = local.members.events().filter((event) => isOtherJoinEventOf(event, state.self.instanceId, initiatorSessionOf(local)));
  if (events.length === 0) {
    return false;
  }
  const establishedAt = earliestTsOf(events);
  mutateLedger(state, local, (ledger) => {
    ledger.status = 'active';
    if (ledger.establishedAt === undefined) {
      ledger.establishedAt = establishedAt;
    }
  });
  local.member.state = 'active';
  persistMember(state, local);
  state.counters.forumEstablished++;
  state.log.info('讨论成立（首个成员加入）', { collabId: local.collabId, establishedAt });
  return true;
}

/* 发起人自己的席位：本机站长席（forum 里 role=manager 即发起人记录）优先，无角色标记时按入席序
 * 取最早席；无席位表的历史夹具返回 null——整机即发起人，退回实例判据。 */
function initiatorSessionOf(local) {
  return primarySeatOf(local)?.sessionId ?? null;
}

/* 「他方 join」：讨论成员是会话（设计 §2.2/§4.5）——发起人自己席位之外的会话入席才算他人加入，
 * 同机另一会话的 join 不能因为「同实例」被吞掉。事件带 sessionId 时按 (instanceId, sessionId) 判；
 * 旧事件无 sessionId 时退回实例判据（本机的旧事件视为发起人自己的，既有档案判定不变）。 */
function isOtherJoinEventOf(event, selfId, initiatorSessionId) {
  if (event.kind !== 'join') {
    return false;
  }
  if (initiatorSessionId === null || !isSeatSessionOf(event)) {
    return event.instanceId !== selfId;
  }
  return event.instanceId !== selfId || event.sessionId !== initiatorSessionId;
}

/* join 收敛判定（设计 §5.4 对表自愈）：判据 = 对表**拉回**的成员表（对端事件集折叠后）含
 * **本会话自己的席位**——本机折叠表恒含自己，不能作确认；同实例其他会话的 join 也不是本会话的
 * 确认证据（成员＝会话，设计 §2.2）。对端的表不含 → 递增间隔有界重播（join 重播豁免 TTL/上限），
 * 重播只重播本会话自己的事件并由该会话署名——同机另一会话代签会把两个会话的历史记串。
 * joinConfirmed 为运行期确认位（本机已加入的席位对照对端表全部成立）：未确认时拉取失败/
 * 无从发起也照走重播（nudgeJoinReplay）。 */
export function settleJoinConvergence(state, local, bundlePayload) {
  if (localModeOf(local) !== 'forum' || local.role !== 'member' || isLocalArchivedState(local)) {
    return;   // 已归档（结束/退出）：不再重播
  }
  const seats = localJoinSeatsOf(local, state.self.instanceId);
  if (seats.length === 0) {
    return;
  }
  const peerMembers = foldMemberEvents(bundlePayload.members ?? []);
  const pending = seats.filter((seat) => !peerKnowsSeatOf(peerMembers, state.self.instanceId, seat.sessionId));
  if (pending.length === 0) {
    local.joinConfirmed = true;
    stopJoinReplay(state, local);
    return;
  }
  local.joinConfirmed = false;
  startJoinReplay(state, local, pending[0].event, pending[0].sessionId ?? undefined);
}

/* 本机在讨论里处于 join 态的席位（每席取自身最新事件）；席位级事件存在时旧实例级事件不参与
 * 判定——同机其他会话的事件不得被当成本会话的 join。整份档案都是旧事件（无 sessionId）时才
 * 退回实例级判定，保留既有档案的自愈能力。按会话标识排序：多席都未确认时重播对象稳定。 */
function localJoinSeatsOf(local, selfId) {
  const { seats, legacy } = ownSeatEventsOf(local, selfId);
  if (seats.size === 0) {
    return legacy !== null && legacy.kind === 'join' ? [{ sessionId: null, event: legacy }] : [];
  }
  return [...seats.entries()]
    .filter(([, event]) => event.kind === 'join')
    .map(([sessionId, event]) => ({ sessionId, event }))
    .sort((left, right) => (left.sessionId < right.sessionId ? -1 : 1));
}

/* 本机事件按席位归并（与成员折叠同一分组规则：sessionId 在场即席位键，缺省归入旧实例级）。
 * 「最新」用作者内事件序（时刻 → 事件 id 兜底），与折叠表取同一条，避免两处各判一个结论。 */
function ownSeatEventsOf(local, selfId) {
  const seats = new Map();
  /** @type {any} 旧实例级事件（无 sessionId）：只在档案里没有席位级事件时参与判定 */
  let legacy = null;
  for (const event of local.members.events()) {
    if (event.instanceId !== selfId) {
      continue;
    }
    if (isSeatSessionOf(event)) {
      const held = seats.get(event.sessionId);
      if (held === undefined || compareSeatEvent(event, held) > 0) {
        seats.set(event.sessionId, event);
      }
      continue;
    }
    if (legacy === null || compareSeatEvent(event, legacy) > 0) {
      legacy = event;
    }
  }
  return { seats, legacy };
}

function isSeatSessionOf(event) {
  return typeof event.sessionId === 'string' && event.sessionId !== '';
}

/* 作者内事件序：先时刻、后事件 id（与 members 折叠的比较键一致）。 */
function compareSeatEvent(left, right) {
  const byTs = Date.parse(left.ts) - Date.parse(right.ts);
  if (byTs !== 0) {
    return byTs;
  }
  if (left.eventId === right.eventId) {
    return 0;
  }
  return left.eventId < right.eventId ? -1 : 1;
}

/* 对端折叠表是否已含本席位：按 (instanceId, sessionId) 精确匹配，同实例其他会话的行不算。
 * 旧实例级行（无 sessionId）只在两种情形作确认证据：本机自己也只有旧事件（sessionId 为 null），
 * 或对端表里完全没有本机的席位行（旧档案整表按实例折叠）。对端已按席位折叠时，旧实例行不得
 * 顶替本会话——否则同机另一会话的旧历史会把本会话判成已确认，重播提前停掉即成幽灵成员。 */
function peerKnowsSeatOf(peerMembers, instanceId, sessionId) {
  let legacy = false;
  let seatRows = 0;
  for (const member of peerMembers) {
    if (member?.instanceId !== instanceId) {
      continue;
    }
    if (typeof member.sessionId !== 'string' || member.sessionId === '') {
      legacy = true;
      continue;
    }
    seatRows++;
    if (member.sessionId === sessionId) {
      return true;
    }
  }
  return legacy && (sessionId === null || seatRows === 0);
}

/* 指定会话在本机成员事件集里的最新 join 事件（最新为 leave 或该会话从未加入 → null）。
 * 该会话没有自己的事件时，仅当档案里完全没有席位级事件才退回实例级旧事件（旧档案可读）；
 * 同实例其他会话的 join 无论如何都不是本会话的 join。 */
export function ownJoinEventOf(local, selfId, sessionId = null) {
  const { seats, legacy } = ownSeatEventsOf(local, selfId);
  const own = sessionId === null ? null : (seats.get(sessionId) ?? null);
  const latest = own ?? (seats.size === 0 ? legacy : null);
  return latest !== null && latest.kind === 'join' ? latest : null;
}

/* —— 拉取应答的组装（应答侧） —— */

/* 组装应答体：增量段（after 之后、按 (ts, postId) 排他）+ 尾部窗口（末段携带）+ 对表交换面
 * （本机同步游标与摘要）+ 元状态 + 成员事件集 + 端点表 + 分段续拉面（more / nextAfter）。 */
function buildBundle(state, local, request) {
  const ordered = displayOrderOf(local.posts.entries());
  const after = request.after ?? null;
  const increment = ordered.filter((entry) => after === null || comparePosition(entry.ts, entry.entryId, after.ts, after.postId) > 0);
  const segment = cutSegment(state, increment);
  const overlap = segment.more ? [] : tailWindowOf(ordered, state.syncTailPosts, state.syncTailWindowMs);
  const payload = {
    cursor: local.member.syncCursor ?? null,
    summary: summaryOf(ordered),
    more: segment.more,
    posts: segment.posts,
    overlap: overlap.map(wirePostOf),
    meta: forumMetaOf(state, local),
    members: local.members.events(),
    endpoints: Object.fromEntries(local.endpoints),
  };
  if (segment.more) {
    payload.nextAfter = positionOf(segment.posts[segment.posts.length - 1]);
  }
  return payload;
}

/* 分段（软阈 512 KiB）：至少含一帖（单帖远小于阈值——保证续拉前进）；more = 还有后续段。 */
function cutSegment(state, increment) {
  const posts = [];
  let bytes = 0;
  let index = 0;
  while (index < increment.length) {
    const wire = wirePostOf(increment[index]);
    const size = Buffer.byteLength(JSON.stringify(wire));
    if (posts.length > 0 && bytes + size > state.syncSoftBundleBytes) {
      break;
    }
    posts.push(wire);
    bytes += size;
    index++;
  }
  return { posts, more: index < increment.length };
}

/* 尾部重叠窗口（辅助）：最近 W 帖与最近 5 分钟两口径**取宽**（满足其一即纳入）——近端竞态自愈。 */
function tailWindowOf(ordered, maxPosts, windowMs) {
  if (ordered.length === 0) {
    return [];
  }
  const latestMs = Date.parse(ordered[ordered.length - 1].ts);
  const cutoffIndex = Math.max(0, ordered.length - maxPosts);
  return ordered.filter((entry, index) => index >= cutoffIndex || latestMs - Date.parse(entry.ts) <= windowMs);
}

function wirePostOf(entry) {
  return {
    from: { instanceId: entry.from.instanceId, identityName: entry.from.identityName },
    postId: entry.entryId,
    seq: entry.seq,
    ts: entry.ts,
    kind: entry.kind,
    text: entry.text,
  };
}

function positionOf(wirePost) {
  return { ts: wirePost.ts, postId: wirePost.postId };
}

/* 讨论元状态（bundle 携带面）：状态/项目名/主题/发起人实例标识（中继归属）/成立事实与时刻/
 * 结束时刻。成员侧状态为 'left' 时不携带 state（本地终态不是讨论状态——不误导对端）；
 * 发起人标识本机未知时不携带（不臆造；对端保持「中继未知」的原状）。 */
function forumMetaOf(state, local) {
  if (local.role === 'manager') {
    return managerMetaOf(state, local);
  }
  const meta = { name: local.member.name };
  if (['proposed', 'active', 'completed', 'terminated'].includes(local.member.state)) {
    meta.state = local.member.state;
  }
  if (typeof local.member.topic === 'string') {
    meta.topic = local.member.topic;
  }
  if (isPlainObject(local.member.originator)) {
    meta.originator = { instanceId: local.member.originator.instanceId, identityName: local.member.originator.identityName };
  }
  const learned = local.member.forumMeta ?? {};
  for (const field of ['createdAt', 'establishedAt', 'endedAt']) {
    if (learned[field] !== undefined) {
      meta[field] = learned[field];
    }
  }
  return meta;
}

function managerMetaOf(state, local) {
  const meta = {
    state: local.ledger.status,
    name: local.ledger.name,
    topic: local.ledger.topic,
    createdAt: local.ledger.createdAt,
    originator: { instanceId: state.self.instanceId, identityName: state.self.identityName },
  };
  const derived = local.ledger.establishedAt ?? earliestOtherJoinTs(state, local);
  if (derived !== null) {
    meta.establishedAt = derived;
  }
  if (local.ledger.endedAt !== undefined) {
    meta.endedAt = local.ledger.endedAt;
  }
  return meta;
}

/* 成立时刻的取数面与 activateForumIfNeeded 同一「他方」判据：两处若各用一套，发起人侧对
 * 成立时刻与成立边沿会给出互相矛盾的结论（同机会话入席只算一处成立）。 */
function earliestOtherJoinTs(state, local) {
  const events = local.members.events().filter((event) => isOtherJoinEventOf(event, state.self.instanceId, initiatorSessionOf(local)));
  return events.length === 0 ? null : earliestTsOf(events);
}

function earliestTsOf(events) {
  let earliest = events[0].ts;
  for (const event of events) {
    if (event.ts < earliest) {
      earliest = event.ts;
    }
  }
  return earliest;
}

/* —— 作者粒度摘要与回退起点（真对账的判据面；导出供单测判别） —— */

/* 摘要 = 每作者计数 + 作者内已见序号集（范围内联编码）。同一帖子集合折叠出同一摘要（完备）；
 * 序号是作者内权威序（§5.2），故摘要比对等价于「集合面」比对（同位异 postId 的内容级伪造
 * 不在判据射程——诚实模型，如实披露）。 */
export function summaryOf(entries) {
  const seqsByAuthor = new Map();
  for (const entry of entries) {
    const authorId = entry.from.instanceId;
    if (!seqsByAuthor.has(authorId)) {
      seqsByAuthor.set(authorId, new Set());
    }
    seqsByAuthor.get(authorId).add(entry.seq);
  }
  const authors = [...seqsByAuthor.keys()].sort().map((instanceId) => {
    const seqs = [...seqsByAuthor.get(instanceId)].sort((left, right) => left - right);
    return { instanceId, count: seqs.length, seqs: rangesOf(seqs) };
  });
  return { authors };
}

function rangesOf(sortedSeqs) {
  const ranges = [];
  for (const seq of sortedSeqs) {
    const last = ranges[ranges.length - 1];
    if (last !== undefined && seq === last[1] + 1) {
      last[1] = seq;
      continue;
    }
    ranges.push([seq, seq]);
  }
  return ranges;
}

/* 回退计划：对端摘要里「对端有而本机缺」的最小序号 = 该粒度上最早的不一致处；
 * 重拉起点 = 本机持有的、该粒度小于它且最大的序号落点（排他游标语义——它之后的全部帖都覆盖）。
 * 定位不到（缺的是对方首条 / 本机没有更早的该作者帖）→ start = null = 整粒度重拉（退化形态明示）。
 * needed = 本机是否需要重拉（本机领先于对端时无须动作——对方会从别处拉到）。 */
export function rollbackPlanOf(entries, summary) {
  if (!isPlainObject(summary) || !Array.isArray(summary.authors)) {
    return { needed: false, start: null };
  }
  const mineByAuthor = positionsByAuthorOf(entries);
  const candidates = [];
  for (const author of summary.authors) {
    const mine = mineByAuthor.get(author.instanceId) ?? new Map();
    const earliestMissing = smallestSeqMissingFrom(mine, author.seqs ?? []);
    if (earliestMissing === null) {
      continue;
    }
    candidates.push(latestPositionBefore(mine, earliestMissing));
  }
  if (candidates.length === 0) {
    return { needed: false, start: null };
  }
  return { needed: true, start: earliestOfPositions(candidates) };
}

function positionsByAuthorOf(entries) {
  const byAuthor = new Map();
  for (const entry of entries) {
    const authorId = entry.from.instanceId;
    if (!byAuthor.has(authorId)) {
      byAuthor.set(authorId, new Map());
    }
    byAuthor.get(authorId).set(entry.seq, { ts: entry.ts, postId: entry.entryId });
  }
  return byAuthor;
}

/* 对端范围内最早一个本机缺的序号：逐段升序扫描，段内首个缺失即止（while 扫描上界 = 本机已见数 + 1）。 */
function smallestSeqMissingFrom(mine, ranges) {
  for (const range of ranges) {
    for (let seq = range[0]; seq <= range[1]; seq++) {
      if (!mine.has(seq)) {
        return seq;
      }
    }
  }
  return null;
}

function latestPositionBefore(mine, beforeSeq) {
  let bestSeq = null;
  for (const seq of mine.keys()) {
    if (seq < beforeSeq && (bestSeq === null || seq > bestSeq)) {
      bestSeq = seq;
    }
  }
  return bestSeq === null ? null : mine.get(bestSeq);
}

/* 取最早起点：null（从头发起）早于任何位置。 */
function earliestOfPositions(candidates) {
  let best = candidates[0];
  for (const candidate of candidates) {
    if (best === null) {
      break;
    }
    if (candidate === null || comparePosition(candidate.ts, candidate.postId, best.ts, best.postId) < 0) {
      best = candidate;
    }
  }
  return best;
}

/* (ts, postId) 复合位置比较（排他游标语义的判据）：先时刻、后 postId 序兜底。 */
export function comparePosition(tsA, idA, tsB, idB) {
  const byTs = Date.parse(tsA) - Date.parse(tsB);
  if (byTs !== 0) {
    return byTs;
  }
  if (idA === idB) {
    return 0;
  }
  return idA < idB ? -1 : 1;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
