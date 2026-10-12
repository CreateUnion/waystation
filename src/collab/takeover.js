import { isArchived } from './model.js';
import { currentManagerIdOf, isLocalArchivedState, localNameOf, localRosterOf, localStateOf, localVersionOf } from './local.js';
import { checkFrozenDeadlines } from './freeze.js';
import {
  adoptNewManager, downgradeToMember, endpointFor, governanceTargets, notifyLocal, promoteToManager, relayGovernance, requestCurrentView, sendMergeOffer, sendTo, sendToRoster,
} from './outgoing.js';
import { ledgerDigest } from './store.js';

/* 失联判定、握手与抢接规程（设计 §9）：
 * - 失联判定：成员侧对现任驿丞周期探测（TCP 拨入 + ping/pong），连续失败累计达标判失联；
 *   判定只吃探测结果、与投递队列解耦（排队不作为可达性证据）；
 * - 握手（常驻机制）：启动 / 网络恢复 / 治理通告后对表——角色、版本、在途或生效抢接；
 * - 抢接：收集窗口 + 并发让位 + 人确认 + 生效广播 + 收敛兜底（与合流衔接）。
 * 定时器与等待面随服务 close 收口；一切异常隔离为计数与告警，绝不穿出。 */

/* 窗口内探测节律（模块默认值；服务注入缝可覆盖）：收集窗口 30s 内需多轮探测以及时识别假失联
 * （原驿丞复活）。 */
export const TAKEOVER_PROBE_INTERVAL_MS = 2000;
/* 握手回帧等待上限（模块默认值；服务注入缝可覆盖）：超过即判「无法对表」——管理席位转只读保守运行。 */
export const HANDSHAKE_REPLY_TIMEOUT_MS = 5000;

function probeStateOf(state, collabId) {
  let held = state.probes.get(collabId);
  if (held === undefined) {
    held = { failSince: null, offline: false, inFlight: false };
    state.probes.set(collabId, held);
  }
  return held;
}

/* 探测定时器：周期驱动探针 + 冻结时限检查 + 暂停截止检查。start 幂等；close 清理。 */
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
  runProbeTick(state);
}

export function stopLiveness(state) {
  if (state.probeTimer !== null) {
    clearInterval(state.probeTimer);
    state.probeTimer = null;
  }
}

export function runProbeTick(state) {
  try {
    const now = Date.now();
    checkFrozenDeadlines(state, now);
    checkSuspensionDeadlines(state, now);
    for (const local of state.collabs.values()) {
      maybeProbeManager(state, local);
    }
  } catch (error) {
    state.log.error('探测定时器异常（已隔离，不退出进程）', { reason: error.message });
  }
}

/* 成员侧对现任驿丞的周期探测：只在存活协作、端点已知、无在途探测时发起。 */
function maybeProbeManager(state, local) {
  if (typeof state.probe !== 'function' || local.role === 'manager') {
    return;
  }
  const stateName = localStateOf(local);
  if (isArchived(stateName)) {
    return;
  }
  const probeState = probeStateOf(state, local.collabId);
  if (probeState.inFlight) {
    return;
  }
  const endpoint = local.endpoints.get(local.member.manager.instanceId);
  if (endpoint === undefined) {
    return;
  }
  probeState.inFlight = true;
  state.counters.probeAttempts++;
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

/* 探测出口（注入的 probe；使用点统一包一层——异常一律归「不可达」）。 */
export async function probePeer(state, endpoint) {
  try {
    return await state.probe(endpoint.address, endpoint.port);
  } catch (error) {
    return { reachable: false, reason: error.message };
  }
}

function applyProbeResult(state, local, probeState, result) {
  if (result.reachable === true) {
    state.counters.probeSuccesses++;
    const wasOffline = probeState.offline;
    probeState.failSince = null;
    probeState.offline = false;
    if (wasOffline) {
      state.counters.managerRecovered++;
      state.log.info('管理者恢复应答（判定解除）', { collabId: local.collabId });
      runHandshake(state, { collabId: local.collabId });   // 网络恢复即对表
    }
    return;
  }
  state.counters.probeFailures++;
  const now = Date.now();
  if (probeState.failSince === null) {
    probeState.failSince = now;
  }
  if (!probeState.offline && now - probeState.failSince >= state.config.managerOfflineMs) {
    probeState.offline = true;
    state.counters.managerOffline++;
    state.log.warn('连续探测失败达判定时限——管理者失联', { collabId: local.collabId, reason: result.reason });
    notifyLocal(state, local, `对协作「${localNameOf(local)}」的管理者连续探测失败——如确认对方失联，可用 ws_take_over 发起抢接。`);
  }
}

/* —— 暂停与恢复（收敛等待的写闸）—— */

export function suspendLocal(state, local, reason, deadline = null) {
  if (local.suspended !== null) {
    return;
  }
  local.suspended = { reason, since: new Date().toISOString(), deadline };
  state.counters.suspensions++;
  state.log.warn('协作对外写已暂停（等待收敛）', { collabId: local.collabId, reason });
}

export function resumeLocal(state, local, reason) {
  if (local.suspended === null) {
    return;
  }
  local.suspended = null;
  state.counters.resumptions++;
  state.log.info('协作对外写已恢复', { collabId: local.collabId, reason });
}

function checkSuspensionDeadlines(state, now) {
  for (const local of state.collabs.values()) {
    if (local.suspended === null || local.suspended.deadline === null) {
      continue;
    }
    if (now >= local.suspended.deadline) {
      state.counters.suspensionExpired++;
      resumeLocal(state, local, '在途抢接超时未收敛（死信防护）');
    }
  }
}

/* —— 握手（启动 / 网络恢复 / 治理通告后的对表）—— */

export function runHandshake(state, options = {}) {
  const scope = options.collabId === undefined
    ? [...state.collabs.values()]
    : [state.collabs.get(options.collabId)].filter((local) => local !== undefined);
  for (const local of scope) {
    if (isLocalArchivedState(local)) {
      continue;
    }
    handshakeOne(state, local);
  }
}

function handshakeOne(state, local) {
  const payload = handshakePayload(state, local, false);
  if (local.role === 'manager') {
    const sent = sendToRoster(state, local, 'notice', payload);
    state.counters.handshakesSent += sent;
    armHandshakeWatch(state, local, sent > 0);
    return;
  }
  const endpoint = local.endpoints.get(local.member.manager.instanceId);
  if (endpoint === undefined) {
    return;
  }
  const result = sendTo(state, local.collabId, local.member.manager.instanceId, endpoint, 'notice', payload);
  if (result.ok === true) {
    state.counters.handshakesSent++;
  }
  armHandshakeWatch(state, local, result.ok === true);
}

function handshakePayload(state, local, reply) {
  return {
    event: 'handshake',
    role: local.role,
    version: localVersionOf(local),
    takeover: takeoverViewOf(state, local.collabId),
    reply,
  };
}

/* 本机可见的抢接视图（在途或生效；生效优先）——握手载荷与抢接汇总的共用读法。 */
export function takeoverViewOf(state, collabId) {
  const effective = state.effectiveTakeovers.get(collabId);
  if (effective !== undefined) {
    return { phase: 'effective', candidate: { ...effective.candidate }, baseVersion: effective.baseVersion };
  }
  const record = state.takeovers.get(collabId);
  if (record !== undefined) {
    return { phase: 'inflight', candidate: { ...record.candidate }, baseVersion: record.baseVersion };
  }
  return null;
}

/* 握手回帧等待：发出后可对表者应答即算接触；租约内无任何回帧且端点名册非空 → 无法对表。 */
function armHandshakeWatch(state, local, sent) {
  if (sent !== true) {
    return;   // 无在册端点（或全部入队失败）：无从对表，不置保守态
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
  state.counters.handshakeUnresolved++;
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
    state.counters.handshakeResolved++;
  }
}

/* 握手到达：先做接触判定（解除本机挂起），再评估对端状态，最后按需回一帧（回帧不再被回）。 */
export async function handleHandshake(state, frame) {
  const local = state.collabs.get(frame.collabId);
  if (local === undefined || frame.from.instanceId === state.self.instanceId || isLocalArchivedState(local)) {
    return;
  }
  state.counters.handshakesIn++;
  clearHandshakeWatch(state, local);
  if (local.suspended !== null && local.suspended.reason === 'handshake-unresolved') {
    resumeLocal(state, local, 'handshake-contacted');
  }
  local.handshakeUnresolved = false;
  evaluateRemoteHandshake(state, local, frame);
  if (frame.payload.reply !== true) {
    sendHandshakeReply(state, local, frame);
  }
}

function sendHandshakeReply(state, local, frame) {
  const endpoint = local.endpoints.get(frame.from.instanceId);
  if (endpoint === undefined) {
    return;
  }
  sendTo(state, local.collabId, frame.from.instanceId, endpoint, 'notice', handshakePayload(state, local, true));
}

function evaluateRemoteHandshake(state, local, frame) {
  const remote = frame.payload;
  const takeover = remote.takeover ?? null;
  if (local.role === 'manager') {
    /* 只对他方记录动作：成员回帧会把「生效抢接者就是本机」写进视图——自身记录是对表确认，
     * 视为继续（否则新驿丞会被自己的记录降级、删掉台账）。 */
    if (takeover !== null && takeover.candidate.instanceId !== state.self.instanceId) {
      if (takeover.phase === 'effective') {
        convergeOnReplaced(state, local, takeover.candidate, takeover.baseVersion);
        return;
      }
      suspendLocal(state, local, 'takeover-inflight', Date.now() + state.config.takeoverWindowMs);
      return;
    }
    return;   // 情形①：仍是驿丞且无在途或已生效的他方抢接（含自身记录）——继续
  }
  evaluateRemoteAsMember(state, local, frame, remote, takeover);
}

function evaluateRemoteAsMember(state, local, frame, remote, takeover) {
  if (takeover !== null && takeover.candidate.instanceId !== state.self.instanceId) {
    if (takeover.phase === 'effective') {
      convergeMemberOnEffective(state, local, takeover.candidate, takeover.baseVersion);
    }
    return;
  }
  if (remote.role === 'manager') {
    adoptNewManager(state, local, { instanceId: frame.from.instanceId, identityName: frame.from.identityName }, remote.version);
    const mine = localVersionOf(local);
    if (remote.version !== null && (mine === null || remote.version > mine)) {
      requestCurrentView(state, local);   // 常规对表：同步现任视图
    }
  }
}

/* —— 抢接（发起 / 汇总 / 让位 / 人确认 / 生效）—— */

/* 优先序全序（设计 §9 步骤 2/5）：版本高者优先；同版本按站点实例标识码位序小者优先。
 * 返回值 >0 = left 胜；<0 = right 胜；0 = 同一候选。 */
export function comparePriority(left, right) {
  if (left.baseVersion !== right.baseVersion) {
    return left.baseVersion - right.baseVersion;
  }
  if (left.candidate.instanceId === right.candidate.instanceId) {
    return 0;
  }
  return left.candidate.instanceId < right.candidate.instanceId ? 1 : -1;
}

export async function takeOver(state, { collabId, confirm }) {
  const local = state.collabs.get(collabId);
  if (local === undefined) {
    return { ok: false, message: '本机没有该协作（先 ws_list_collabs）' };
  }
  if (confirm === true || confirm === false) {
    return resolveTakeoverConfirm(state, local, confirm);
  }
  return beginTakeover(state, local);
}

function beginTakeover(state, local) {
  const rejection = takeoverRejection(state, local);
  if (rejection !== null) {
    return { ok: false, message: rejection };
  }
  const managerPeer = { instanceId: local.member.manager.instanceId, identityName: local.member.manager.identityName };
  const baseVersion = local.snapshot.version;
  /** @type {{ phase: string, candidate: { instanceId: string, identityName: string }, baseVersion: number,
   *   windowEndsAt: number, rivals: Map<string, any>, timer: any, resolveWindow: ((verdict: object) => void) | null }} */
  const record = {
    phase: 'collecting',
    candidate: { instanceId: state.self.instanceId, identityName: state.self.identityName },
    baseVersion,
    windowEndsAt: Date.now() + state.config.takeoverWindowMs,
    rivals: new Map(),
    timer: null,
    resolveWindow: null,
  };
  state.takeovers.set(local.collabId, record);
  state.counters.takeoversInitiated++;
  const verdict = new Promise((resolve) => {
    record.resolveWindow = resolve;
  });
  broadcastAnnounce(state, local, record, managerPeer);
  startTakeoverWindow(state, local, record);
  return verdict;
}

function takeoverRejection(state, local) {
  if (local.role === 'manager') {
    return '本机就是该协作的管理者——无需抢接';
  }
  if (isArchived(localStateOf(local))) {
    return '协作已结束（或已退出）——不可抢接';
  }
  if (local.snapshot === null) {
    return '本机无快照——无从恢复台账，抢接不可行（先与现任驿丞完成一次对表）';
  }
  if (typeof state.probe !== 'function') {
    return '本机未接线探测能力——抢接不可行';
  }
  if (state.takeovers.has(local.collabId) || state.rearmedTakeovers.has(local.collabId)) {
    return '本机已有在途抢接——先等待其结论';
  }
  if (state.effectiveTakeovers.has(local.collabId)) {
    return '该协作已有生效抢接（驿丞已为他人）——先对表收敛';
  }
  const probeState = probeStateOf(state, local.collabId);
  if (probeState.offline !== true) {
    return '现任驿丞未被判定失联——请等待探测判定（连续失败累计达标）后再试';
  }
  return null;
}

function broadcastAnnounce(state, local, record, managerPeer) {
  const windowEndsAt = new Date(record.windowEndsAt).toISOString();
  sendToRoster(state, local, 'takeover-init', { kind: 'announce', manager: managerPeer, baseVersion: record.baseVersion, windowEndsAt });
}

/* 收集窗口：自广播起算（窗口时长已在窗口结束时点固化）——窗口内持续探测原驿丞，
 * 应答即中止（假失联）；窗口止后按优先序判定。 */
function startTakeoverWindow(state, local, record) {
  const tick = async () => {
    if (state.takeovers.get(local.collabId) !== record) {
      return;
    }
    const endpoint = local.endpoints.get(local.member.manager.instanceId);
    if (endpoint === undefined) {
      abortTakeover(state, local, record, '管理者端点未知——抢接中止');
      return;
    }
    const result = await probePeer(state, endpoint);
    if (state.takeovers.get(local.collabId) !== record) {
      return;
    }
    if (result.reachable === true) {
      abortTakeover(state, local, record, '原驿丞恢复应答——抢接中止（假失联）');
      return;
    }
    if (Date.now() >= record.windowEndsAt) {
      finishWindow(state, local, record);
      return;
    }
    /* 窗口定时器保持引用（不 unref）：收集窗口是工具调用的等待链一环——事件循环须留存至结论
     * （与快照等待面同一口径）；结论产出后即清理。 */
    record.timer = setTimeout(() => {
      tick().catch((error) => {
        abortTakeover(state, local, record, `窗口探测异常：${error.message}`);
      });
    }, Math.max(1, Math.min(state.takeoverProbeIntervalMs, record.windowEndsAt - Date.now())));
  };
  tick().catch((error) => {
    abortTakeover(state, local, record, `窗口探测异常：${error.message}`);
  });
}

function finishWindow(state, local, record) {
  /* 让位判定必须与自身比较：窗口内到达时严格更高者已即时让位，仍在册者均为更低优先——
   * 不得无条件让位（确定性优先序由「版本高者、同版本实例标识小者」全序钉死）。 */
  const blocker = highestRival(record);
  if (blocker !== null && comparePriority(blocker, { candidate: record.candidate, baseVersion: record.baseVersion }) > 0) {
    yieldNow(state, local, record, blocker);
    return;
  }
  state.takeovers.delete(local.collabId);
  record.phase = 'awaiting-confirm';
  state.takeovers.set(local.collabId, record);
  state.counters.takeoversAwaiting++;
  notifyLocal(state, local, `抢接收集窗口结束：本机为最高优先候选（基准版本 ${record.baseVersion}）。经本机人确认后调用 ws_take_over（confirm: true）生效；放弃请用 confirm: false。`);
  record.resolveWindow?.({
    ok: true,
    phase: 'awaiting-confirm',
    baseVersion: record.baseVersion,
    message: '收集窗口结束：本机为最高优先候选——经本机人确认后调用 ws_take_over（confirm: true）生效；放弃请用 confirm: false。',
  });
}

function highestRival(record) {
  /** @type {any} */
  let best = null;
  for (const rival of record.rivals.values()) {
    if (best === null || comparePriority(rival, best) > 0) {
      best = rival;
    }
  }
  return best;
}

/* 让位（窗口内遇更高优先意图 / 窗口结束判定为负）：中止本机窗口、广播取消、记下让位对象——
 * 对方后续放弃（取消帧到达）时由顺位机制重新给予确认机会。 */
function yieldNow(state, local, record, blocker) {
  if (record.timer !== null) {
    clearTimeout(record.timer);
  }
  state.takeovers.delete(local.collabId);
  state.counters.takeoversYielded++;
  sendToRoster(state, local, 'takeover-init', { kind: 'cancel', reason: `让位给更高优先候选（${blocker.candidate.identityName}）` });
  state.awaitingTakeovers.set(local.collabId, { blockerId: blocker.candidate.instanceId, baseVersion: record.baseVersion });
  state.log.info('抢接让位', { collabId: local.collabId, blocker: blocker.candidate.instanceId });
  record.resolveWindow?.({ ok: false, message: `已让位给更高优先的候选「${blocker.candidate.identityName}」（基准版本 ${blocker.baseVersion}）` });
}

function abortTakeover(state, local, record, reason) {
  if (record.timer !== null) {
    clearTimeout(record.timer);
  }
  state.takeovers.delete(local.collabId);
  state.counters.takeoversAborted++;
  sendToRoster(state, local, 'takeover-init', { kind: 'cancel', reason });
  state.log.warn('抢接中止', { collabId: local.collabId, reason });
  record.resolveWindow?.({ ok: false, message: reason });
}

/* 人确认分支：confirm=false 放弃（广播取消，被让位者由此获得顺位）；confirm=true 生效前最后探测后生效。 */
async function resolveTakeoverConfirm(state, local, confirm) {
  const record = state.takeovers.get(local.collabId);
  const rearmed = state.rearmedTakeovers.get(local.collabId);
  if (record === undefined && rearmed === undefined) {
    return { ok: false, message: '没有待确认的抢接——先调用 ws_take_over 发起' };
  }
  /* 收集窗口未结束不可确认：越窗确认会跳过汇总与让位判定（历史拒绝口径的守卫）。 */
  if (record !== undefined && record.phase !== 'awaiting-confirm') {
    return { ok: false, message: '收集窗口尚未结束——请等待窗口结论后再确认' };
  }
  if (confirm === false) {
    if (record !== undefined && record.timer !== null) {
      clearTimeout(record.timer);
    }
    state.takeovers.delete(local.collabId);
    state.rearmedTakeovers.delete(local.collabId);
    sendToRoster(state, local, 'takeover-init', { kind: 'cancel', reason: '候选放弃' });
    state.counters.takeoversAborted++;
    return { ok: true, message: '已放弃抢接并广播取消（顺位候选会收到重排机会）。' };
  }
  const baseVersion = record !== undefined ? record.baseVersion : rearmed.baseVersion;
  return finalizeTakeover(state, local, baseVersion);
}

async function finalizeTakeover(state, local, baseVersion) {
  const endpoint = local.endpoints.get(local.member.manager.instanceId);
  const probeResult = endpoint === undefined ? { reachable: false } : await probePeer(state, endpoint);
  if (probeResult.reachable === true) {
    state.takeovers.delete(local.collabId);
    state.rearmedTakeovers.delete(local.collabId);
    sendToRoster(state, local, 'takeover-init', { kind: 'cancel', reason: '原驿丞恢复应答——抢接中止（生效前最后探测）' });
    state.counters.takeoversAborted++;
    return { ok: false, message: '生效前最后探测：原驿丞恢复应答——抢接中止' };
  }
  /* 生效取生效时台账真值：收集窗口内可能收到更新的快照（版本漂移）——生效帧、优先序比较与
   * 恢复台账同源，不沿用发起时宣布的旧基准（错值会污染对立抢接判定与合流递交的基准面）。 */
  const appliedVersion = local.snapshot === null ? baseVersion : local.snapshot.version;
  const effective = state.effectiveTakeovers.get(local.collabId);
  if (effective !== undefined && effective.candidate.instanceId !== state.self.instanceId) {
    const mine = { candidate: { instanceId: state.self.instanceId, identityName: state.self.identityName }, baseVersion: appliedVersion };
    if (comparePriority(effective, mine) > 0) {
      state.takeovers.delete(local.collabId);
      state.rearmedTakeovers.delete(local.collabId);
      convergeOnReplaced(state, local, effective.candidate, effective.baseVersion);
      return { ok: false, message: `已有更高优先的生效抢接（候选「${effective.candidate.identityName}」）——本机让位` };
    }
  }
  if (local.snapshot === null) {
    return { ok: false, message: '本机无快照——无从恢复台账，抢接不可行' };
  }
  state.takeovers.delete(local.collabId);
  state.rearmedTakeovers.delete(local.collabId);
  state.awaitingTakeovers.delete(local.collabId);
  applyTakeover(state, local, appliedVersion);
  return { ok: true, message: `抢接已生效：本机成为驿丞（基准版本 ${appliedVersion}）` };
}

/* 生效：从本机快照恢复（manager 换为本机、updatedAt 刷新、版本保持基准值——版本号跨抢接延续不重置），
 * 承担管理席位，向全体广播 takeover（治理类豁免过期与上限，重试直至送达——离线者恢复后让位）。 */
function applyTakeover(state, local, baseVersion) {
  const ledger = structuredClone(local.snapshot.ledger);
  ledger.manager = { instanceId: state.self.instanceId, identityName: state.self.identityName };
  ledger.updatedAt = new Date().toISOString();
  promoteToManager(state, local, ledger);
  const candidate = { instanceId: state.self.instanceId, identityName: state.self.identityName };
  const digest = ledgerDigest(ledger);
  state.effectiveTakeovers.set(local.collabId, { candidate, baseVersion, digest });
  sendToRoster(state, local, 'takeover', { baseVersion, digest });
  state.counters.takeoversEffective++;
  state.log.warn('抢接生效——本机承担驿丞席位', { collabId: local.collabId, baseVersion });
  notifyLocal(state, local, `抢接已生效：本机已成为协作「${localNameOf(local)}」的驿丞（基准版本 ${baseVersion}）。`);
}

/* 生效通告补发（端点学习点消费）：本机即记录中的新驿丞时，向新学得端点的名册成员补发一次
 * takeover——「未入队即无重试」的盲区由此收窄；帧幂等（接收侧按版本收敛）。 */
export function resendEffectiveTakeover(state, local, instanceId) {
  const effective = state.effectiveTakeovers.get(local.collabId);
  if (effective === undefined || effective.candidate.instanceId !== state.self.instanceId) {
    return;
  }
  if (instanceId === state.self.instanceId || typeof effective.digest !== 'string') {
    return;
  }
  const inRoster = localRosterOf(local).some((entry) => entry.instanceId === instanceId);
  const endpoint = inRoster ? local.endpoints.get(instanceId) : undefined;
  if (endpoint === undefined) {
    return;
  }
  const result = sendTo(state, local.collabId, instanceId, endpoint, 'takeover', { baseVersion: effective.baseVersion, digest: effective.digest });
  if (result.ok === true) {
    state.counters.takeoverResends++;
  }
}

/* —— 抢接报文接收 —— */

export async function handleTakeoverInit(state, frame) {
  const local = state.collabs.get(frame.collabId);
  if (local === undefined || frame.from.instanceId === state.self.instanceId) {
    return;
  }
  const payload = frame.payload;
  if (payload.kind === 'announce') {
    handleAnnounce(state, local, frame, payload);
    return;
  }
  if (payload.kind === 'report') {
    handleReport(state, local, frame, payload);
    return;
  }
  if (payload.kind === 'cancel') {
    handleGovernanceCancel(state, local, frame);
  }
}

function handleAnnounce(state, local, frame, payload) {
  const currentManagerId = currentManagerIdOf(local);
  if (payload.manager.instanceId !== currentManagerId) {
    state.log.warn('抢接意图针对的驿丞与本地记录不符（过期通告，忽略）', { collabId: local.collabId, claimed: payload.manager.instanceId });
    return;
  }
  state.counters.takeoversIn++;
  const candidate = { instanceId: frame.from.instanceId, identityName: frame.from.identityName };
  const rival = { candidate, baseVersion: payload.baseVersion };
  const record = state.takeovers.get(local.collabId);
  if (record !== undefined) {
    record.rivals.set(candidate.instanceId, rival);
    if (comparePriority(rival, { candidate: record.candidate, baseVersion: record.baseVersion }) > 0) {
      yieldNow(state, local, record, rival);
    }
  } else if (state.effectiveTakeovers.has(local.collabId)) {
    // 已有生效抢接：在途意图按过期处理（新驿丞在位，无需再抢）
  } else if (local.role === 'manager') {
    suspendLocal(state, local, 'takeover-inflight', Date.now() + state.config.takeoverWindowMs + state.takeoverProbeIntervalMs);
  }
  relayTakeoverInit(state, local, frame);
  sendReport(state, local, candidate);
}

/* 定向回执：报告本机版本与本机可见的抢接视图（候选由此汇总他方意图与版本）。 */
function sendReport(state, local, candidate) {
  const endpoint = endpointFor(state, local, candidate.instanceId);
  if (endpoint === undefined) {
    return;
  }
  sendTo(state, local.collabId, candidate.instanceId, endpoint, 'takeover-init', {
    kind: 'report',
    version: localVersionOf(local),
    takeover: takeoverViewOf(state, local.collabId),
  });
}

function handleReport(state, local, frame, payload) {
  state.counters.takeoversReportsIn++;
  const record = state.takeovers.get(local.collabId);
  if (record === undefined || payload.takeover === null) {
    state.log.warn('收到不属于本机在途抢接的汇总报告（忽略；如属他方在途，等待其通告）', { collabId: local.collabId, from: frame.from.instanceId });
    return;
  }
  const rival = { candidate: { ...payload.takeover.candidate }, baseVersion: payload.takeover.baseVersion };
  record.rivals.set(rival.candidate.instanceId, rival);
  if (comparePriority(rival, { candidate: record.candidate, baseVersion: record.baseVersion }) > 0) {
    yieldNow(state, local, record, rival);
  }
}

/* 取消（假失联恢复 / 让位 / 放弃）：管理席位侧解除在途挂起；被让位者获得顺位机会。 */
function handleGovernanceCancel(state, local, frame) {
  state.counters.takeoversCancelsIn++;
  if (local.role === 'manager' && local.suspended !== null && local.suspended.reason === 'takeover-inflight') {
    resumeLocal(state, local, '在途抢接中止');
  }
  const waiting = state.awaitingTakeovers.get(local.collabId);
  if (waiting !== undefined && waiting.blockerId === frame.from.instanceId) {
    state.awaitingTakeovers.delete(local.collabId);
    state.rearmedTakeovers.set(local.collabId, { baseVersion: waiting.baseVersion });
    notifyLocal(state, local, `顺位轮到你（原优先候选已放弃，基准版本 ${waiting.baseVersion}）——如要继续，调用 ws_take_over（confirm: true）；放弃请用 confirm: false。`);
    return;
  }
  const record = state.takeovers.get(local.collabId);
  if (record !== undefined) {
    record.rivals.delete(frame.from.instanceId);
  }
}

export async function handleTakeover(state, frame) {
  const local = state.collabs.get(frame.collabId);
  if (local === undefined || frame.from.instanceId === state.self.instanceId) {
    return;
  }
  const payload = frame.payload;
  const candidate = { instanceId: frame.from.instanceId, identityName: frame.from.identityName };
  const incoming = { candidate, baseVersion: payload.baseVersion };
  const held = state.effectiveTakeovers.get(local.collabId);
  state.counters.takeoversIn++;
  if (held !== undefined && held.candidate.instanceId !== candidate.instanceId) {
    if (comparePriority(incoming, held) <= 0) {
      state.counters.takeoverSuperseded++;
      state.log.warn('收到弱优先的并存生效抢接（以既有为准，仅转达）', { collabId: local.collabId, incoming: candidate.instanceId });
      relayTakeover(state, local, frame);
      return;
    }
    state.effectiveTakeovers.set(local.collabId, incoming);
  } else {
    state.effectiveTakeovers.set(local.collabId, incoming);
  }
  relayTakeover(state, local, frame);
  applyTakeoverNews(state, local, incoming);
}

/* 生效通告的本地处置（设计 §9 步骤 4）：停写 → 版本核对 → 合流或降级；成员侧换引用同步视图。 */
function applyTakeoverNews(state, local, incoming) {
  if (local.role === 'manager') {
    convergeOnReplaced(state, local, incoming.candidate, incoming.baseVersion);
    return;
  }
  convergeMemberOnEffective(state, local, incoming.candidate, incoming.baseVersion);
}

/* 被替换 / 让位的收敛内核（步骤 4；握手情形③与抢接接收共用）：本地版本高于基准 → 先合流递交，
 * 再降级为协作者并提示本机人（分区期间的超出部分交由现任驿丞的人裁定）。 */
export function convergeOnReplaced(state, local, candidate, baseVersion) {
  const localVersion = localVersionOf(local);
  if (localVersion !== null && localVersion > baseVersion) {
    if (sendMergeOffer(state, local, candidate, baseVersion).ok === true) {
      state.counters.mergeOffersSent++;
    }
  }
  const name = localNameOf(local);
  downgradeToMember(state, local, candidate);
  state.counters.takeoverDowngrades++;
  state.log.warn('本机让位——已降级为协作者', { collabId: local.collabId, newManager: candidate.instanceId, baseVersion });
  notifyLocal(state, local, `本机已被替换：协作「${name}」的驿丞现为「${candidate.identityName}」；本机已降为协作者。`);
}

/* 成员侧收到生效抢接 / 驿丞变更：同步成员记录（内部已含陈旧队列重定向与视图拉取）。 */
function convergeMemberOnEffective(state, local, candidate, baseVersion) {
  adoptNewManager(state, local, candidate, baseVersion);
  const mine = localVersionOf(local);
  if (mine !== null && mine > baseVersion) {
    if (sendMergeOffer(state, local, candidate, baseVersion).ok === true) {
      state.counters.mergeOffersSent++;
    }
  }
  requestCurrentView(state, local);
}

/* 转达（设计 §9 步骤 1/5）：收到者向其他在线参与者转达（沿用原 msgId、每节点只转一次）。 */
function relayTakeoverInit(state, local, frame) {
  state.counters.takeoversRelayed += relayGovernance(state, frame, governanceTargets(state, local));
}

function relayTakeover(state, local, frame) {
  state.counters.takeoversRelayed += relayGovernance(state, frame, governanceTargets(state, local));
}
