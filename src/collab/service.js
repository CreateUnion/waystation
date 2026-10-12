import { listLocalCollabIds, loadLedger, loadMember, loadSnapshot, quarantineLedger } from './store.js';
import { isArchived } from './model.js';
import { decideAdmission } from './gate.js';
import { handleEvent } from './events.js';
import { localNameOf, localRosterOf, localStateOf, persistLedger } from './local.js';
import { approveInvite, countLiveCollabs, createCollab, endCollab, leaveCollab, sendMessage, viewLedger, withdrawInvite } from './outgoing.js';

/* 协作服务（协作核心的门面）：注册表加载与恢复、公共 API、接收管线钩子（admit / consume）装配、
 * 计数器与生命周期。钩子与事件路径一律不抛出（健壮性硬性要求）——异常隔离为计数与告警。
 * 依赖全部经参数注入（send = dispatch.send；knownHosts 供「协作参与者地址」一源接入）。 */

const LEDGER_FETCH_TIMEOUT_MS = 3000;
const INVITE_MIN_INTERVAL_MS = 1000;

/**
 * @param {{ dataDir: string, config: any, self: any, send: (message: object) => any, knownHosts: any, log: any, ledgerFetchTimeoutMs?: number, inviteMinIntervalMs?: number }} options
 */
export function createCollabService({ dataDir, config, self, send, knownHosts, log, ledgerFetchTimeoutMs = LEDGER_FETCH_TIMEOUT_MS, inviteMinIntervalMs = INVITE_MIN_INTERVAL_MS }) {
  const state = {
    dataDir,
    config,
    self,
    send,
    knownHosts,
    log,
    ledgerFetchTimeoutMs,
    inviteMinIntervalMs,
    collabs: new Map(),
    inviteWindow: new Map(),
    relayedOrigins: new Map(),
    pendingViews: new Map(),
    counters: emptyCounters(),
  };
  loadRegistry(state);
  return {
    hooks: {
      admit: (frame, meta) => gateFrame(state, frame, meta),
      consume: (frame, meta) => consumeFrame(state, frame, meta),
    },
    list: () => listCollabs(state),
    create: (input) => createCollab(state, input),
    approve: (input) => approveInvite(state, input),
    withdraw: (input) => withdrawInvite(state, input),
    send: (input) => sendMessage(state, input),
    end: (input) => endCollab(state, input),
    leave: (input) => leaveCollab(state, input),
    view: (input) => viewLedger(state, input),
    describe: (collabId) => describeCollab(state, collabId),
    count: () => countLiveCollabs(state),
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

/* 事件包装：异常隔离为计数与告警——协作事件绝不因内部错误穿出接收管线（健壮性硬性要求）。 */
async function consumeFrame(state, frame, meta) {
  try {
    state.counters.eventsHandled++;
    await handleEvent(state, frame, meta);
  } catch (error) {
    state.counters.eventFailures++;
    state.log.error('协作事件处理异常（已隔离）', { type: frame?.type, collabId: frame?.collabId, reason: error?.message });
  }
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

function loadOne(state, collabId) {
  const member = loadMember(state.dataDir, collabId);
  if (member === null) {
    throw new Error('缺少可用的成员记录（member.json）');
  }
  const local = {
    collabId,
    role: member.role,
    ledger: null,
    member,
    endpoints: new Map(Object.entries(member.endpoints)),
    snapshot: loadSnapshot(state.dataDir, collabId),
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
    return loaded.ledger;
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
    return { source: 'snapshot', ledger: local.snapshot.ledger };
  }
  const now = new Date().toISOString();
  return {
    source: 'member',
    ledger: {
      version: 1,
      collabId,
      name: local.member.name,
      topic: '（台账损坏重建——主题待确认）',
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
 * 有效期（仅标注，不改状态——设计 §6 的「过期不算拒绝」）。 */
function listCollabs(state) {
  const now = Date.now();
  const collabs = [];
  for (const local of state.collabs.values()) {
    collabs.push(listEntryOf(local, now));
  }
  return { collabs };
}

function listEntryOf(local, now) {
  const stateName = localStateOf(local);
  return {
    collabId: local.collabId,
    name: localNameOf(local),
    role: local.role,
    state: stateName,
    version: local.role === 'manager' ? local.ledger.version : (local.snapshot === null ? null : local.snapshot.version),
    memberCount: localRosterOf(local).length,
    archived: isArchived(stateName),
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

/* 适配器描述器（上下文头「项目：」行）：本机已知协作的名称；未知返回 null（该行省略）。 */
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

function closeService(state) {
  for (const pending of state.pendingViews.values()) {
    clearTimeout(pending.timer);
    pending.resolve(null);
  }
  state.pendingViews.clear();
}

function emptyCounters() {
  return {
    ...emptyFlowCounters(),
    ...emptyGuardCounters(),
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
  };
}

/* 门控与存储计数（冻结 / 丢弃 / 快照 / 健壮性观测面）。 */
function emptyGuardCounters() {
  return {
    freezeDetected: 0,
    freezeApplied: 0,
    freezeRelayed: 0,
    freezeUnmatched: 0,
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
    messagesSent: 0,
    sendFailures: 0,
    eventsHandled: 0,
    eventFailures: 0,
    gateFailures: 0,
    loadFailures: 0,
    persistFailures: 0,
  };
}
