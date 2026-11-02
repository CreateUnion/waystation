import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ID_PATTERN, MAX_TOPIC_CHARS, isIdentityName, isPresentationText } from '../net/protocol.js';
import { errorOf } from '../util/errors.js';
import { matchSessionByToken, shortSessionId } from '../util/short-id.js';
import { dispatchStateFilePath } from '../paths.js';
import {
  dispatchStatePathOf, masterTimeoutMsOf, messageLimitsOf, persistEnabledOf, requireAckDefaultOf,
  resourceGuardConfigOf, retentionConfigOf, taskStaleMsOf,
} from '../dispatch-config.js';
import {
  renderAcceptance, renderEvidence, renderReport, validateAcceptance, validateEvidence, validateReport,
} from './dispatch-fields.js';
import { freeMemMBOf as systemFreeMemMBOf } from '../host-resources.js';
import {
  DISPATCH_TASK_SUMMARY_MAX, REPLACED_MASTER_MAX, loadDispatchState, migrateDispatchState, quarantineDispatchState,
  removeDispatchState, resolveDispatchStatePath, saveDispatchState,
} from './dispatch-store.js';
import { gateValueOf } from './confirm-gate.js';

/* dispatch 域：与 managed / forum 同级的第三种模式，但不进 state.collabs、不写任何协作文件。
 * 运行态全部在 state.dispatches（Map<collabId, record>）；编排状态（组员 / 任务表 / 调度长心跳）
 * 可持久化到单独的 dispatch/state.json（dispatch-store.js；persist=false 退回纯内存），
 * 消息流水仍不落盘。消息投递经注入的 notify（routing.notify），不碰 LAN 出站队列 / 本机席位注入 / inbox 落盘。 */

export const DISPATCH_MESSAGE_TYPES = ['task', 'progress', 'result', 'error'];
export const DISPATCH_QUEUE_MAX = 256;
export const DISPATCH_CLAIM_TTL_MS = 10 * 60 * 1000;
export const DISPATCH_ACK_TTL_MS = 10 * 60 * 1000;
export const DISPATCH_MEMBER_EVENT_DEBOUNCE_MS = 500;
/* 任务表容量上限：完成项按保留期裁剪；在途任务不被自动清理，达到上限后拒绝新 taskId
 * （防止无限增长的持久面；1000 与单机编排量级匹配）。 */
export const DISPATCH_TASK_MAX = 1000;
const DISPATCH_TASK_DONE_STATUSES = new Set(['done', 'failed']);
const HOUR_MS = 60 * 60 * 1000;
/* 旧 master 被接管后的明确拒绝（单一文案源）。 */
const TAKEN_OVER_MESSAGE = '本会话已被接管——dispatch 的调度长已换届；请勿再按原调度长身份操作（新调度长可用 ws_status / ws_list_collabs 确认）';
/* 收编纪律单一权威源：~/.waystation/dispatch-rules.md（markdown 分节，每条一句话）。
 * 收编低频，通知发出时实时读文件——改完即热生效，无需 reload 命令。缺失/为空时回退内置兜底
 * 纪律（与 dispatch-rules.md 保持逐条同步，新装机开箱即得完整纪律），并向 master 知会一次
 * （每 record 只提醒一次，防刷屏）。改纪律先改文件、再同步本常量。
 * 内容仍由 slave 模型执行——核心只机制化"要求"的携带，不机制化"内容"本身。 */
export const DISPATCH_RULES_FILE_NAME = 'dispatch-rules.md';
export const DISPATCH_RULES_FALLBACK = [
  '# 调度（dispatch）全员纪律（内置兜底版，与 dispatch-rules.md 逐条同步；新装机请创建该文件，改完即热生效）',
  '',
  '1. 主动上报：任务推进中主动向调度长汇报进展与结果，不静默（ws_send_message 本协作即回）。',
  '2. 收编状态汇报：被收编后立即向调度长汇报当前状态——在做什么、已完成什么、有无卡点待裁定。',
  '3. 人工选择清单：先发调度（dispatch）消息知会调度长（选项概要+时限）转呈用户拍板，等 2 分钟无回传再弹窗兜底；确定用户正在本机交互可直接弹窗。',
  '4. 权限弹窗豁免：权限类允许/拒绝弹窗不适用远程拍板（安全机制不可代批），被拒照实上报原因。',
  '5. 已验证坑即入册：有实测证据的坑当轮写入项目知识库（现象-根因-修复-预防），不等批量指令。',
  '6. 全量汇报禁拦截：会话间消息禁止静默拦截或选择性省略，任何到达消息都要如实上报（组员报调度长，调度长转呈用户）。',
  '7. 待批独立成条：需用户拍板的事项独立成条正式提请（事项+事实清单+「现在等你决定」），不附带在进度汇报里，不自行压后审批节奏。',
  '8. 结构化回报：progress 用 ws_send_message 的 report（summary/done/blockers/next）；result 必须带 evidence（commit/tests/artifacts/gates），无证据按未完成处理；消息超长会被拒——长内容写文件，消息只发摘要+路径。',
].join('\n');
/* 桥断开宽限（与席位宽限同源配置，缺省与 service 的 DEFAULT_SEAT_GRACE_MS 对齐）。 */
const DISPATCH_GRACE_MS = 60 * 1000;

export function createDispatchDomain(deps) {
  const { state, now = Date.now } = deps;
  const sessionMetaOf = deps.sessionMetaOf ?? (() => null);
  const listSessionIds = deps.listSessionIds ?? (() => []);
  const metaOf = (sessionId) => normalizeMeta(sessionMetaOf(sessionId), sessionId);
  /* 交互式判定只看「会话文件在档 + kind=interactive」：文件 mtime 的 5 分钟新鲜度上限
   * 已移除——Claude Code 不持续触碰会话文件，空闲数分钟的真实会话会被误判不可收编
   * （2026-10-30 实测：活跃会话被判 claimable=false）。活没活由桥连接性把关（注册表
   * 只含已连桥，断开即出列），文件新鲜度不承担存活判定。 */
  const isInteractiveOf = (meta) => meta !== null
    && meta.kind === 'interactive'
    && meta.metaUpdatedAt > 0;
  const masterDispatchOf = (sessionId) => masterDispatchOfIn(state, sessionId);
  const dispatchOf = (sessionId) => dispatchOfIn(state, sessionId, masterDispatchOf);
  /* 注入面运行期容器：notify 是唯一投递出口（未注入＝队列兜底，绝不静默丢弃），
   * log 只记投递异常与队列溢出，config 提供可选的容量参数（缺省用本模块常量）。 */
  const runtime = {
    state,
    config: deps.config ?? {},
    dataDir: typeof deps.dataDir === 'string' && deps.dataDir.length > 0 ? deps.dataDir : null,
    log: deps.log ?? null,
    notify: typeof deps.notify === 'function' ? deps.notify : null,
    deliverSeat: typeof deps.deliverSeat === 'function' ? deps.deliverSeat : null,
    /* 资源提醒的实测内存入口（单测可注入；生产缺省读 node:os）。 */
    freeMemMBOf: freeMemProbeOf(deps),
    now,
    metaOf,
    isInteractiveOf,
    masterDispatchOf,
    dispatchOf,
    listSessionIds,
    persistence: {
      enabled: false,
      degraded: false,
      statePath: /** @type {string | null} */ (null),
      warned: false,
    },
  };
  runtime.persistence = createPersistence(runtime);
  restoreDispatchIn(runtime);
  return dispatchApiOf(runtime);
}

function freeMemProbeOf(deps) {
  return typeof deps.freeMemMBOf === 'function' ? deps.freeMemMBOf : systemFreeMemMBOf;
}

/* 持久化运行面：enabled＝配置总开关；degraded＝写失败后本进程内永久降级；
 * statePath＝解析后的绝对路径（null＝未启用/不可解析）。 */
function createPersistence(runtime) {
  if (!persistEnabledOf(runtime.config)) {
    return { enabled: false, degraded: false, statePath: null, warned: false };
  }
  if (runtime.dataDir === null) {
    runtime.log?.warn?.('dispatch 持久化已启用但数据目录缺失——降级为纯内存', {});
    return { enabled: false, degraded: true, statePath: null, warned: true };
  }
  const statePath = statePathFor(runtime);
  logMigration(runtime, statePath);
  return { enabled: true, degraded: false, statePath, warned: false };
}

function statePathFor(runtime) {
  try {
    return resolveDispatchStatePath(runtime.dataDir, dispatchStatePathOf(runtime.config));
  } catch (error) {
    runtime.log?.warn?.('dispatch.state_path 非法——回退默认位置', { reason: error?.message });
    return dispatchStateFilePath(runtime.dataDir);
  }
}

function logMigration(runtime, statePath) {
  const migrated = migrateDispatchState({ dataDir: runtime.dataDir, statePath, now: runtime.now() });
  if (!migrated.ok) {
    runtime.log?.warn?.('调度状态文件位置迁移失败（继续使用配置位置）', { reason: migrated.reason, statePath });
    return;
  }
  if (migrated.changed) {
    runtime.log?.info?.('调度状态文件已迁移', { mode: migrated.mode, statePath });
  }
}

function persistenceReadable(runtime) {
  const persistence = runtime.persistence;
  return persistence !== undefined && persistence.enabled && persistence.statePath !== null;
}

/* 写盘：仅在持久化启用且未降级时执行；失败告警一次并永久降级（编排继续，不阻塞）。
 * 写前裁剪已完成任务（保留期），保证文件不随长寿命 dispatch 无限增长。 */
function persistNow(runtime, record) {
  const persistence = runtime.persistence;
  if (!persistenceReadable(runtime) || persistence.degraded) {
    return false;
  }
  if (record !== null && record !== undefined) {
    pruneTasksIn(runtime, record, runtime.now());
  }
  try {
    saveDispatchState(persistence.statePath, record, { now: runtime.now() });
    return true;
  } catch (error) {
    degradePersistence(runtime, error);
    return false;
  }
}

function degradePersistence(runtime, error) {
  const persistence = runtime.persistence;
  persistence.degraded = true;
  if (persistence.warned) {
    return;
  }
  persistence.warned = true;
  runtime.log?.warn?.('调度状态持久化失败——本进程内降级为纯内存（编排继续）', {
    statePath: persistence.statePath, reason: error?.message,
  });
}

/* 删除持久面（正常结束 / 超期残留）：删除失败只告警，不影响内存收尾。 */
function removePersistedState(runtime, reason) {
  if (!persistenceReadable(runtime)) {
    return;
  }
  try {
    removeDispatchState(runtime.persistence.statePath);
  } catch (error) {
    runtime.log?.warn?.('调度状态文件删除失败', { reason, error: error?.message, statePath: runtime.persistence.statePath });
  }
}

/* 启动恢复：读状态文件 → 校验 → master 在线判定 → 进入内存域。
 * 核心启动时桥尚未注册（metaOf 为空），因此通常先落为 pending-takeover；master 桥重连后
 * noteBridgeOnline 会刷新心跳并恢复 active。 */
function restoreDispatchIn(runtime) {
  if (!persistenceReadable(runtime)) {
    return;
  }
  const record = restoredRecordFrom(runtime);
  if (record === null) {
    return;
  }
  const status = isSessionOnline(runtime, record.masterSessionId) ? 'active' : 'pending-takeover';
  const changedStatus = record.status !== status;
  applyRestoredStatus(record, status, runtime);
  const pruned = pruneTasksIn(runtime, record, runtime.now());
  if (status === 'pending-takeover' && isStalePending(record, runtime)) {
    discardStaleRestored(runtime, record);
    return;
  }
  runtime.state.dispatches.set(record.collabId, record);
  broadcastRestored(runtime, record);
  if (changedStatus || pruned) {
    persistNow(runtime, record);
  }
}

function restoredRecordFrom(runtime) {
  const loaded = loadDispatchState(runtime.persistence.statePath);
  if (loaded.ok === true) {
    return loaded.record;
  }
  if (loaded.corrupt === true) {
    const quarantined = quarantineDispatchState(runtime.persistence.statePath, runtime.now());
    runtime.log?.warn?.('调度状态文件损坏——按无状态启动', {
      reason: loaded.reason, quarantined, statePath: runtime.persistence.statePath,
    });
  } else if (loaded.unreadable === true) {
    runtime.log?.warn?.('调度状态文件不可读——按无状态启动（本进程仍可写）', {
      reason: loaded.reason, statePath: runtime.persistence.statePath,
    });
  }
  return null;
}

function applyRestoredStatus(record, status, runtime) {
  record.status = status;
  if (status !== 'active') {
    return;
  }
  record.masterLostAt = null;
  record.masterLastSeenAt = Math.max(record.masterLastSeenAt, runtime.now());
}

function discardStaleRestored(runtime, record) {
  removePersistedState(runtime, 'stale-pending');
  runtime.log?.warn?.('调度状态残留超期（待接管且心跳超过保留期）——已删除，不恢复', {
    collabId: record.collabId,
    masterLastSeenAt: isoOf(record.masterLastSeenAt),
    retentionHours: retentionConfigOf(runtime.config).dispatch_hours,
  });
}

function isSessionOnline(runtime, sessionId) {
  const meta = runtime.metaOf(sessionId);
  return meta !== null && meta.online === true;
}

function isStalePending(record, runtime) {
  const hours = retentionConfigOf(runtime.config).dispatch_hours;
  return hours === 0 || runtime.now() - record.masterLastSeenAt > hours * HOUR_MS;
}

function broadcastRestored(runtime, record) {
  if (record.status === 'active') {
    for (const slaveSessionId of record.slaves.keys()) {
      sendNotice(
        runtime, record, slaveSessionId,
        `dispatch「${record.name}」已恢复（调度长：${record.masterName}）；组员与任务表保留`,
        'dispatch-restored',
      );
    }
    return;
  }
  for (const slaveSessionId of record.slaves.keys()) {
    sendNotice(
      runtime, record, slaveSessionId,
      `dispatch「${record.name}」已恢复为待接管：调度长「${record.masterName}」当前不在线；组员与任务表保留，新调度长可接管`,
      'dispatch-takeover-pending',
    );
  }
}

function isoOf(ms) {
  return new Date(ms).toISOString();
}

/* 域入口表：读面（list / status / isDispatch）＋写面（create / claim / send / end / leave / sweep）——
 * 全部经 runtime 取注入面，闭包不直接捕获 deps。 */
function dispatchApiOf(runtime) {
  const { state, now, metaOf, isInteractiveOf, masterDispatchOf, dispatchOf } = runtime;
  return {
    dispatches: state.dispatches,
    metaOf,
    isInteractiveOf,
    masterDispatchOf,
    dispatchOf,
    create: (input) => {
      const created = createDispatchIn(runtime, input);
      if (created.ok && created.autoClaim) {
        autoClaimPassIn(runtime, runtime.state.dispatches.get(created.collabId));
      }
      return created;
    },
    scan: (input) => scanSessionsIn(runtime, input),
    claim: (input) => claimSessionsIn(runtime, input),
    approve: (input) => approveClaimIn(runtime, input),
    release: (input) => releaseSlaveIn(runtime, input),
    reloadRules: (input) => reloadRulesIn(runtime, input),
    send: (input) => sendMessageIn(runtime, input),
    end: (input) => endDispatchIn(runtime, input),
    leave: (input) => leaveDispatchIn(runtime, input),
    noteActivity: (sessionId, at = now()) => noteActivityIn(runtime, sessionId, at),
    noteBridgeOnline: (sessionId) => noteBridgeOnlineIn(runtime, sessionId),
    noteBridgeClosed: (sessionId, at = now()) => noteBridgeClosedIn(runtime, sessionId, at),
    sweep: (at = now()) => sweepDispatchesIn(runtime, at),
    list: () => listDispatchesIn(runtime),
    describe: (collabId) => describeDispatchIn(state, collabId),
    view: (collabId) => viewDispatchIn(runtime, collabId),
    status: () => statusOfDispatches(runtime),
    persistStatus: () => ({
      enabled: runtime.persistence.enabled,
      degraded: runtime.persistence.degraded,
      statePath: runtime.persistence.statePath,
    }),
    isDispatch: (collabId) => state.dispatches.has(collabId),
  };
}

/* 会话元数据归一（桥上报的原始记录 → dispatch 域内形状）：名字非法时用会话短码兜底
 * （不是完整 sessionId——全量标识适合定位、不适合展示）。 */
function normalizeMeta(raw, sessionId) {
  if (!isMetaRecord(raw)) {
    return null;
  }
  return {
    sessionId,
    name: metaNameOf(raw, sessionId),
    kind: kindOf(raw.kind),
    entrypoint: textOrNull(raw.entrypoint),
    status: textOrNull(raw.status),
    role: roleOf(raw.role),
    masterName: isIdentityName(raw.masterName) ? raw.masterName.trim() : null,
    metaUpdatedAt: Number.isFinite(raw.metaUpdatedAt) ? raw.metaUpdatedAt : 0,
    online: raw.online !== false,
  };
}

function isMetaRecord(value) {
  return value !== null && value !== undefined && typeof value === 'object';
}

function metaNameOf(raw, sessionId) {
  return isIdentityName(raw.name) ? raw.name.trim() : shortSessionId(sessionId);
}

function textOrNull(value) {
  return typeof value === 'string' ? value : null;
}

/* kind 词表保留三态：交互式（可确认）与无头 bg（无人可确认）必须可区分，
 * 只有未知 / 缺失才回退 unknown——把 bg 吞成 unknown 会让拒绝理由失真。 */
function kindOf(value) {
  if (value === 'interactive' || value === 'bg') {
    return value;
  }
  return 'unknown';
}

function roleOf(value) {
  return value === 'master' || value === 'slave' ? value : 'none';
}

function masterDispatchOfIn(state, sessionId) {
  for (const record of state.dispatches.values()) {
    if (record.masterSessionId === sessionId) {
      return record;
    }
  }
  return null;
}

function dispatchOfIn(state, sessionId, masterDispatchOf) {
  const master = masterDispatchOf(sessionId);
  if (master !== null) {
    return master;
  }
  for (const record of state.dispatches.values()) {
    if (record.slaves.has(sessionId)) {
      return record;
    }
  }
  return null;
}

/* autoClaim：创建即扫描收编一次，之后随 presence 节拍的 sweep 持续补收新会话；可绑定判定与
 * claim 成功路径同口径（slave / 门 off 的交互式）——门开着的交互式会话绝不替人弹确认。
 * 移除面不新增机制：slave 桥断开超宽限由既有 sweepGraceOf 自动移除并通告。 */
function createDispatchIn(runtime, { name, topic, sessionId, autoClaim }) {
  const { state, metaOf, now } = runtime;
  const meta = metaOf(sessionId);
  if (meta === null || meta.role !== 'master') {
    return errorOf('dispatch-master-required', 'dispatch 只能由启动期 WAYSTATION_ROLE=master 的会话创建——工具参数与聊天内容不能声明 master 角色');
  }
  if (!isIdentityName(name)) {
    return errorOf('invalid-dispatch-name', 'dispatch 名称非法：需要 1–64 字符且不含控制字符');
  }
  if (topic !== undefined && topic !== null && !isPresentationText(topic, MAX_TOPIC_CHARS)) {
    return errorOf('invalid-topic', `dispatch 主题非法：需要不超过 ${MAX_TOPIC_CHARS} 字符`);
  }
  if (state.dispatches.size > 0) {
    return createOrTakeoverDispatch(runtime, [...state.dispatches.values()][0], { sessionId, meta });
  }
  const collabId = randomUUID();
  const record = newDispatchRecord({ collabId, name, topic, sessionId, autoClaim }, meta, now());
  state.dispatches.set(collabId, record);
  persistNow(runtime, record);
  return createdDispatchResult(record, runtime);
}

function newDispatchRecord({ collabId, name, topic, sessionId, autoClaim }, meta, at) {
  return {
    collabId,
    mode: 'dispatch',
    ephemeral: true,
    name: name.trim(),
    topic: typeof topic === 'string' && topic.trim() !== '' ? topic.trim() : null,
    masterSessionId: sessionId,
    masterName: meta.name,
    autoClaim: autoClaim === true,
    status: 'active',
    createdAt: new Date(at).toISOString(),
    masterLastSeenAt: at,
    masterLostAt: null,
    replacedMasterSessionIds: new Set(),
    rulesMissingWarned: false,
    slaves: new Map(),
    tasks: new Map(),
    claims: new Map(),
    queues: new Map(),
    /* 用户消息的补投截止（target → epoch ms）：宽限期到仍未补投即 drop 并向调度长回报；
     * 控制通知（join/leave 等）不设截止，沿用既有宽限/释放回收。 */
    queueDeadlines: new Map(),
    /* requireAck 的待确认账（msgId → 记录）：delivered/queued 均登记，收到目标会话 ack 或超时收口。 */
    pendingAcks: new Map(),
    grace: new Map(),
    pendingEvents: [],
    eventTimer: null,
  };
}

function createdDispatchResult(record, runtime) {
  return {
    ok: true,
    collabId: record.collabId,
    mode: 'dispatch',
    ephemeral: true,
    persisted: persistenceActive(runtime),
    name: record.name,
    topic: record.topic,
    autoClaim: record.autoClaim,
  };
}

function persistenceActive(runtime) {
  const persistence = runtime.persistence;
  return persistence !== undefined && persistence.enabled && !persistence.degraded;
}

/* 已有 dispatch 时的 create 判定：同 master 幂等拒绝 / 旧 master 禁止夺回 / 未超时拒绝 /
 * 心跳超时则原地换届（保留 collabId、name/topic、slave 列表与任务表）。 */
function createOrTakeoverDispatch(runtime, existing, { sessionId, meta }) {
  if (existing.masterSessionId === sessionId) {
    return errorOf('dispatch-already-created', '本会话已是该 dispatch 的调度长——一个核心同一时刻只允许一个 dispatch');
  }
  if (isReplacedMasterOf(existing, sessionId)) {
    return takenOverResult();
  }
  const remaining = masterTimeoutMsOf(runtime.config) - (runtime.now() - existing.masterLastSeenAt);
  if (remaining > 0) {
    return errorOf(
      'dispatch-master-active',
      `现有 dispatch 的调度长「${existing.masterName}」仍活跃（心跳超时还需约 ${Math.ceil(remaining / 1000)}s）——不能接管`,
    );
  }
  return takeOverDispatchIn(runtime, existing, { sessionId, meta });
}

function takeOverDispatchIn(runtime, existing, { sessionId, meta }) {
  const previousMasterSessionId = existing.masterSessionId;
  const previousMasterName = existing.masterName;
  const previousOnline = runtime.metaOf(previousMasterSessionId)?.online === true;
  applyTakeoverState(existing, { sessionId, masterName: meta.name, now: runtime.now(), previousMasterSessionId });
  notifyTakeoverParties(runtime, existing, { previousMasterSessionId, previousMasterName, previousOnline, sessionId });
  persistNow(runtime, existing);
  return takeoverResult(runtime, existing, previousMasterSessionId, previousMasterName);
}

function applyTakeoverState(existing, { sessionId, masterName, now, previousMasterSessionId }) {
  existing.masterSessionId = sessionId;
  existing.masterName = masterName;
  existing.status = 'active';
  existing.masterLastSeenAt = now;
  existing.masterLostAt = null;
  const replaced = [...(existing.replacedMasterSessionIds ?? []), previousMasterSessionId];
  existing.replacedMasterSessionIds = new Set(replaced.slice(-REPLACED_MASTER_MAX));
  existing.claims.clear();
  existing.grace.delete(previousMasterSessionId);
  existing.queues.delete(previousMasterSessionId);
}

function notifyTakeoverParties(runtime, existing, { previousMasterSessionId, previousMasterName, previousOnline, sessionId }) {
  const summary = `调度长已换届：原调度长「${previousMasterName}」→ 新调度长「${existing.masterName}」；组员与任务表原样移交`;
  for (const slaveSessionId of existing.slaves.keys()) {
    sendNotice(runtime, existing, slaveSessionId, summary, 'dispatch-takeover');
  }
  if (previousOnline) {
    /* 旧 master 已不属于 dispatch：不走待补投队列（dispatchOf 找不到它，队列永远不会 flush），
     * 在线时直接投一条明确通知。 */
    notifyOnce(runtime, noticeFrame(runtime, existing, previousMasterSessionId, TAKEN_OVER_MESSAGE, 'dispatch-taken-over'));
  }
  sendNotice(
    runtime, existing, sessionId,
    `已接管 dispatch「${existing.name}」（调度长：${previousMasterName} → ${existing.masterName}）；组员 ${existing.slaves.size} 人、任务 ${existing.tasks.size} 项原样移交`,
    'dispatch-takeover-accepted',
  );
}

function takeoverResult(runtime, existing, previousMasterSessionId, previousMasterName) {
  return {
    ok: true,
    collabId: existing.collabId,
    mode: 'dispatch',
    ephemeral: true,
    persisted: persistenceActive(runtime),
    name: existing.name,
    topic: existing.topic,
    autoClaim: existing.autoClaim,
    takeover: true,
    previousMasterSessionId,
    previousMasterName,
    slaveCount: existing.slaves.size,
    taskCount: existing.tasks.size,
  };
}

/* 纪律包读取：dispatch-rules.md 实时读（收编低频，现读天然最新）；缺失/为空回退内置最简纪律。 */
function dispatchRulesOf(runtime) {
  if (runtime.dataDir === null) {
    return { text: DISPATCH_RULES_FALLBACK, missing: true };
  }
  let text = '';
  try {
    text = readFileSync(join(runtime.dataDir, DISPATCH_RULES_FILE_NAME), 'utf8').trim();
  } catch {
    /* 读取失败按缺失处理，沿用初始空值走兜底 */
  }
  return text.length > 0 ? { text, missing: false } : { text: DISPATCH_RULES_FALLBACK, missing: true };
}

/* 收编通知正文 = 前缀 + 纪律包全文；文件缺失时回退并向 master 知会一次（每 record 只提醒一次）。 */
function claimNoticeTextOf(runtime, record, prefix) {
  const rules = dispatchRulesOf(runtime);
  if (rules.missing && record.rulesMissingWarned !== true) {
    record.rulesMissingWarned = true;
    sendNotice(
      runtime,
      record,
      record.masterSessionId,
      `收编纪律文件缺失（~/.waystation/${DISPATCH_RULES_FILE_NAME}），本次已回退内置最简纪律——请创建该文件（markdown 分节，每条一句话），改完即热生效`,
      'dispatch-rules-missing',
    );
  }
  return `${prefix}\n${rules.text}`;
}

/* 纪律重载广播（master 专用）：实时重读 dispatch-rules.md，向全体在编成员广播最新纪律包——
 * 改纪律文件对已收编会话也立即生效，无需重建。广播带内容版本号（sha256 前 8 位）+时间戳，
 * 便于会话识别新旧；文件缺失时按内置最简纪律广播并在结果中如实标注 rulesMissing。 */
function reloadRulesIn(runtime, { sessionId }) {
  const { record, refusal } = masterRecordOf(runtime, sessionId);
  if (record === null) {
    return refusal;
  }
  const rules = dispatchRulesOf(runtime);
  const version = rulesVersionOf(rules.text);
  const stamp = new Date(runtime.now()).toISOString();
  const text = `【纪律更新 v${version} ${stamp}】以下为最新全员纪律（来源 ~/.waystation/${DISPATCH_RULES_FILE_NAME}，收到后以此覆盖本地旧认知）：\n${rules.text}`;
  let notified = 0;
  for (const slaveSessionId of record.slaves.keys()) {
    sendNotice(runtime, record, slaveSessionId, text, 'dispatch-rules-updated');
    notified += 1;
  }
  return { ok: true, dispatchId: record.collabId, version, rulesMissing: rules.missing, notified };
}

function rulesVersionOf(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8);
}

/* 一轮自动收编：跳过 master 自身 / 已绑定 / 有在途确认申请 / 预检不过的目标；
 * 只直绑免确认可绑定的（slave，或 claim 门 off 的交互式）——门开时保持沉默。 */
function autoClaimPassIn(runtime, record) {
  const { metaOf, listSessionIds } = runtime;
  for (const target of listSessionIds()) {
    if (target === record.masterSessionId || record.slaves.has(target)) {
      continue;
    }
    if ([...record.claims.values()].some((entry) => entry.targetSessionId === target)) {
      continue;
    }
    const meta = metaOf(target);
    if (meta === null) {
      continue;
    }
    if (claimPrecheckOf(record, record.masterSessionId, meta, target) !== null) {
      continue;
    }
    const bindable = meta.role === 'slave'
      || (runtime.isInteractiveOf(meta) && gateValueOf(runtime.state, target, 'claim').effectiveValue === false);
    if (bindable) {
      bindSlave(runtime, record, meta);
      sendNotice(
        runtime,
        record,
        meta.sessionId,
        claimNoticeTextOf(
          runtime,
          record,
          `已按本机设置自动同意 master「${record.masterName}」的收编（要退出用 ws_leave_collab）。`,
        ),
        'dispatch-claim-auto',
      );
    }
  }
}

/* scan 判定与 claim 判定同口径：claimable = role=slave（免确认绑定）或交互式元数据新鲜。
 * 不可收编条目仍列出（如实呈现本机注册面），由 claimable 字段引导 master 认领正确目标。 */
function scanSessionsIn(runtime, { sessionId }) {
  const { metaOf, listSessionIds, isInteractiveOf } = runtime;
  const { record, refusal } = masterRecordOf(runtime, sessionId);
  if (record === null) {
    return scanLostResult(refusal);
  }
  const sessions = [];
  for (const target of listSessionIds()) {
    if (target === sessionId) {
      continue;
    }
    const meta = metaOf(target);
    if (meta === null) {
      continue;
    }
    /* 只列可收编目标：role=slave 或交互式（会话文件在档）。不可收编条目（其他 master、
     * 无会话文件的子代理桥、非交互无角色）不列出——scan 是 master 的收编视野，不是注册表全量。 */
    if (meta.role === 'master' || !(meta.role === 'slave' || isInteractiveOf(meta))) {
      continue;
    }
    sessions.push({
      sessionId: target,
      /* 稳定标识：派发以短码为准；name 会随 Claude Code 重命名 / 重启变化，只作提示。 */
      sessionCode: shortSessionId(target),
      name: meta.name,
      kind: meta.kind,
      entrypoint: meta.entrypoint,
      role: meta.role,
      status: meta.status,
      claimedBy: record.slaves.has(target) ? record.masterSessionId : null,
      claimable: true,
    });
  }
  return { ok: true, dispatchId: record.collabId, sessions };
}

function scanLostResult(refusal) {
  const lost = refusal ?? dispatchLost();
  return lost.code === 'dispatch-lost'
    ? { ...lost, message: 'dispatch 不存在（可能已结束或核心已重启）——请重新创建' }
    : lost;
}

function listDispatchesIn(runtime) {
  return [...runtime.state.dispatches.values()].map((record) => ({
    collabId: record.collabId,
    name: record.name,
    mode: 'dispatch',
    ephemeral: true,
    persisted: persistenceActive(runtime),
    status: record.status,
    topic: record.topic,
    masterSessionId: record.masterSessionId,
    slaveCount: record.slaves.size,
    taskCount: record.tasks.size,
    createdAt: record.createdAt,
  }));
}

function describeDispatchIn(state, collabId) {
  const record = state.dispatches.get(collabId);
  if (record === undefined) {
    return null;
  }
  return { collabId, name: record.name, mode: 'dispatch', ephemeral: true, topic: record.topic };
}

function viewDispatchIn(runtime, collabId) {
  const record = runtime.state.dispatches.get(collabId);
  if (record === undefined) {
    return errorOf('dispatch-lost', '本机没有该 dispatch（可能已结束或核心已重启）');
  }
  const persisted = persistenceActive(runtime);
  return {
    ok: true, collabId, mode: 'dispatch', ephemeral: true, persisted, status: record.status,
    message: `dispatch 不保存历史：无消息台账、无帖、无收件流水、无观察窗回放；编排状态（组员 / 任务表 / 心跳）${persisted ? '已持久化，核心重启可恢复' : '仅在本进程内存中'}`,
  };
}

function statusOfDispatches(runtime) {
  const records = [...runtime.state.dispatches.values()];
  if (records.length === 0) {
    return { ok: true, dispatch: null, persisted: persistenceActive(runtime) };
  }
  const record = records[0];
  return {
    ok: true,
    dispatch: {
      collabId: record.collabId,
      name: record.name,
      status: record.status,
      masterSessionId: record.masterSessionId,
      masterSessionCode: shortSessionId(record.masterSessionId),
      masterLastSeenAt: isoOf(record.masterLastSeenAt),
      slaves: [...record.slaves.values()].map((slave) => ({
        sessionId: slave.sessionId,
        sessionCode: shortSessionId(slave.sessionId),
        name: slave.name,
        kind: slave.kind,
      })),
      taskCount: record.tasks.size,
    },
    persisted: persistenceActive(runtime),
  };
}

/* —— 收编判定（claim / approve / release）与通知投递 —— */

function dispatchLost() {
  return errorOf('dispatch-lost', 'dispatch 不存在（可能已结束或核心已重启）');
}

/* 旧调度长被换届后的明确拒绝：比 dispatch-lost 多一个稳定 code，便于恢复方识别「不是丢了，
 * 而是被接管了」。 */
function takenOverResult() {
  return errorOf('dispatch-taken-over', TAKEN_OVER_MESSAGE);
}

function isReplacedMasterOf(record, sessionId) {
  return record?.replacedMasterSessionIds?.has?.(sessionId) === true;
}

function takenOverRecordOf(state, sessionId) {
  for (const record of state.dispatches.values()) {
    if (isReplacedMasterOf(record, sessionId)) {
      return record;
    }
  }
  return null;
}

/* 当前 master 记录 / 明确拒绝二选一：旧 master 得到 dispatch-taken-over，其余得到 dispatch-lost。 */
function masterRecordOf(runtime, sessionId) {
  const record = runtime.masterDispatchOf(sessionId);
  if (record !== null) {
    return { record, refusal: null };
  }
  return { record: null, refusal: takenOverRecordOf(runtime.state, sessionId) === null ? dispatchLost() : takenOverResult() };
}

function rejectedClaim(sessionId, reason, code = 'claim-rejected') {
  const error = errorOf(code, reason);
  return { sessionId, status: 'rejected', code: error.code, reason, hint: error.hint };
}

function claimSessionsIn(runtime, { sessionId, sessionIds }) {
  const { record, refusal } = masterRecordOf(runtime, sessionId);
  if (record === null) {
    return refusal;
  }
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
    return errorOf('invalid-session-ids', 'sessionIds 非法：需要非空数组');
  }
  const results = [];
  for (const targetSessionId of [...new Set(sessionIds)]) {
    results.push(claimTargetOf(runtime, record, sessionId, targetSessionId));
  }
  return { ok: true, dispatchId: record.collabId, results, warnings: claimWarningsOf(runtime, record) };
}

/* #14 资源感知（建议型）：只生成提醒，不改收编结果。两项各按实测值判定：
 * 空闲内存严格小于 min_free_mem_mb；当前组员数达到（≥）max_slaves。 */
function claimWarningsOf(runtime, record) {
  const guard = resourceGuardConfigOf(runtime.config);
  if (!guard.enabled) {
    return [];
  }
  const warnings = [];
  const freeMemMB = probeFreeMemMB(runtime);
  if (freeMemMB !== null && freeMemMB < guard.min_free_mem_mb) {
    warnings.push(
      `空闲内存 ${freeMemMB} MB 低于 dispatch.resource_guard.min_free_mem_mb（${guard.min_free_mem_mb} MB）`
      + '——建议先释放不用的会话或关闭不用的 worker（仅警告，不拒绝本次收编）',
    );
  }
  if (record.slaves.size >= guard.max_slaves) {
    warnings.push(
      `当前组员数 ${record.slaves.size} 已达 dispatch.resource_guard.max_slaves（${guard.max_slaves}）`
      + '——建议先释放不用的组员或关闭不用的 worker（仅警告，不拒绝本次收编）',
    );
  }
  return warnings;
}

function probeFreeMemMB(runtime) {
  try {
    const value = runtime.freeMemMBOf();
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/* 会话标识解析（完整标识或短码）：候选集内的精确匹配；零命中 / 歧义 / 非法一律 null。
 * 候选先去重——同一会话同时出现在 grace 与 slaves 时，重复条目会把短码误判成歧义。 */
function resolveSessionToken(candidates, token) {
  return matchSessionByToken([...new Set(candidates)].map((sessionId) => ({ sessionId })), token);
}

function resolveRegisteredSession(runtime, token) {
  return resolveSessionToken(runtime.listSessionIds(), token);
}

/* 单目标判定表：预检（在线 / 身份 / 已绑定 / 白名单）→ 直接绑定 / 待确认 / 拒绝。
 * 目标标识接受完整 sessionId 或短码（sessionCode）：先在本机注册表精确解析，零命中/歧义
 * 一律按「指定会话不在场」处置，与短码工具的既有口径一致。 */
function claimTargetOf(runtime, record, masterSessionId, targetToken) {
  const targetSessionId = resolveRegisteredSession(runtime, targetToken);
  if (targetSessionId === null) {
    /* 已绑定组员的桥断开后注册表不再列出、但在宽限期内仍在 record.slaves——这属于桥陈旧，
     * 与「从未注册过 / 目标不存在」分开给码，修复动作不同（重连桥 vs 核对目标）。 */
    const stale = resolveSessionToken([...record.grace.keys(), ...record.slaves.keys()], targetToken);
    return stale === null
      ? rejectedClaim(targetToken, '本机会话不在线或不可见（不在本机注册表）', 'session-not-visible')
      : rejectedClaim(stale, '本机会话的桥连接已断或已过期（仍在宽限期内）', 'bridge-stale');
  }
  const target = runtime.metaOf(targetSessionId);
  const precheck = claimPrecheckOf(record, masterSessionId, target, targetSessionId);
  if (precheck !== null) {
    return precheck;
  }
  if (target.role === 'slave') {
    bindSlave(runtime, record, target);
    return { sessionId: targetSessionId, status: 'bound' };
  }
  if (runtime.isInteractiveOf(target)) {
    /* claim 门 off（与邀请 / 加入门同族的第三道门）：收编免人工确认——直接绑定并注入
     * 知情通知，不进 pending（本机设置已表态，master 手动 claim 与 autoClaim 同待遇）。 */
    if (gateValueOf(runtime.state, targetSessionId, 'claim').effectiveValue === false) {
      bindSlave(runtime, record, target);
      sendNotice(
        runtime,
        record,
        targetSessionId,
        claimNoticeTextOf(
          runtime,
          record,
          `已按本机设置自动同意 master「${record.masterName}」的收编（要退出用 ws_leave_collab）。`,
        ),
        'dispatch-claim-auto',
      );
      return { sessionId: targetSessionId, status: 'bound' };
    }
    return pendingClaimOf(runtime, record, masterSessionId, targetSessionId);
  }
  return rejectedClaim(targetSessionId, '非交互式会话且未带 WAYSTATION_ROLE=slave——没有人可确认（可收编目标在 ws_dispatch_scan 中标 claimable: true）');
}

/* 返回非 null 即终局（拒绝或已绑定），null 表示继续按角色 / 交互性分流。 */
function claimPrecheckOf(record, masterSessionId, target, targetSessionId) {
  if (target === null) {
    return rejectedClaim(targetSessionId, '本机会话不在线或不可见（不在本机注册表）', 'session-not-visible');
  }
  if (target.online !== true) {
    return rejectedClaim(targetSessionId, '本机会话的桥连接已断或已过期（在线标记为假）', 'bridge-stale');
  }
  if (target.sessionId === masterSessionId || target.role === 'master') {
    return rejectedClaim(targetSessionId, '不能收编 master 自身或其他 master 会话');
  }
  if (record.slaves.has(targetSessionId)) {
    return { sessionId: targetSessionId, status: 'bound' };
  }
  if (target.masterName !== null && target.masterName !== record.masterName) {
    return rejectedClaim(targetSessionId, `该会话只接受 master「${target.masterName}」`);
  }
  return null;
}

/* 交互式首签：登记待确认申请并向目标注入提示（目标会话的模型转述给本机用户）。 */
function pendingClaimOf(runtime, record, masterSessionId, targetSessionId) {
  const claimId = randomUUID();
  record.claims.set(claimId, {
    claimId,
    targetSessionId,
    masterSessionId,
    expiresAt: runtime.now() + DISPATCH_CLAIM_TTL_MS,
    token: undefined,
  });
  sendNotice(
    runtime,
    record,
    targetSessionId,
    claimNoticeTextOf(
      runtime,
      record,
      `master「${record.masterName}」请求收编本会话，允许吗？确认请调用 ws_dispatch_approve { claimId: "${claimId}", approve: true }\n批准后适用收编纪律：`,
    ),
    'dispatch-claim',
  );
  return { sessionId: targetSessionId, status: 'pending', claimId };
}

function approveClaimIn(runtime, { sessionId, claimId, approve, confirmToken }) {
  const found = claimOf(runtime.state, claimId);
  if (found === null) {
    return errorOf('claim-not-found', '收编申请不存在、已过期或已处置');
  }
  const { record, claim } = found;
  const refusal = claimRefusalOf(runtime, record, claim, sessionId, approve);
  if (refusal !== null) {
    return refusal;
  }
  if (approve === false) {
    return rejectPendingClaim(runtime, record, claimId);
  }
  /* 收编确认门（与邀请 / 加入门同族的第三道门）：目标会话的生效值为 off 时跳过令牌挑战
   * 直接绑定，仍注入一行知情通知（谁收编了你）；拒绝路径不受门影响。 */
  if (gateValueOf(runtime.state, sessionId, 'claim').effectiveValue === false) {
    const bound = bindApprovedClaim(runtime, record, claimId, sessionId);
    if (bound.ok) {
      sendNotice(
        runtime,
        record,
        sessionId,
        `已按本机设置自动同意 master「${record.masterName}」的收编（要退出用 ws_leave_collab）`,
        'dispatch-claim-auto',
      );
    }
    return bound;
  }
  const tokenRefusal = confirmTokenRefusalOf(runtime, record, claim, confirmToken);
  if (tokenRefusal !== null) {
    return tokenRefusal;
  }
  return bindApprovedClaim(runtime, record, claimId, sessionId);
}

/* 身份 / 时效 / 取值形态三判：拒绝直接给出终局结果；通过返回 null。 */
function claimRefusalOf(runtime, record, claim, sessionId, approve) {
  if (claim.targetSessionId !== sessionId) {
    return errorOf('claim-not-yours', '只有被收编的目标会话可以确认该申请');
  }
  if (runtime.now() >= claim.expiresAt) {
    record.claims.delete(claim.claimId);
    return errorOf('claim-expired', '收编申请已超时——请让 master 重新发起');
  }
  if (approve !== true && approve !== false) {
    return errorOf('invalid-approve', 'approve 须为布尔值');
  }
  return null;
}

/* 拒绝是即时终局：释放申请并通知 master（拒绝不需要确认令牌）。 */
function rejectPendingClaim(runtime, record, claimId) {
  record.claims.delete(claimId);
  sendNotice(runtime, record, record.masterSessionId, `已拒绝 master「${record.masterName}」的收编请求`, 'dispatch-claim-rejected');
  return { ok: true, approved: false };
}

/* 一次性确认令牌：首次 approve:true 只签发不绑定；令牌只对目标会话有效，
 * 绑定时随申请一起删除（单次使用），令牌自身也有与申请相同的 10 分钟时限。 */
function confirmTokenRefusalOf(runtime, record, claim, confirmToken) {
  if (typeof confirmToken !== 'string' || confirmToken === '') {
    const token = randomUUID();
    claim.token = { value: token, expiresAt: runtime.now() + DISPATCH_CLAIM_TTL_MS };
    return {
      ok: false,
      needsUserConfirmation: true,
      confirmToken: token,
      summary: `master「${record.masterName}」请求收编本会话——这是模型转述的确认，不是带外硬人工门；请向本机用户确认后携令牌重试`,
    };
  }
  if (claim.token === undefined || claim.token.value !== confirmToken || claim.token.expiresAt <= runtime.now()) {
    return errorOf('confirm-token-invalid', '确认令牌无效或已过期——请重新发起');
  }
  return null;
}

function bindApprovedClaim(runtime, record, claimId, sessionId) {
  const target = runtime.metaOf(sessionId);
  if (target === null) {
    return errorOf('session-not-visible', '目标会话已不在本机注册表内——请让 master 重新发起');
  }
  record.claims.delete(claimId);
  /* 加入事件统一由 bindSlave 入去抖队列——这里不再直发，避免同一成员被通知两次。 */
  bindSlave(runtime, record, target);
  return { ok: true, approved: true, bound: true, sessionId };
}

function releaseSlaveIn(runtime, { sessionId, targetSessionId }) {
  const { record, refusal } = masterRecordOf(runtime, sessionId);
  if (record === null) {
    return refusal;
  }
  const resolved = resolveSessionToken(record.slaves.keys(), targetSessionId);
  const slave = resolved === null ? undefined : record.slaves.get(resolved);
  if (slave === undefined) {
    return errorOf('session-not-in-dispatch', '该会话不在本 dispatch 内');
  }
  record.slaves.delete(resolved);
  sendNotice(runtime, record, resolved, 'master 已释放本会话——dispatch 收编结束', 'dispatch-released');
  /* 释放后该会话不再属于本 dispatch（dispatchOf 也找不到它），待补投队列再无人 flush：
   * 连刚排入的释放通知一起回收，避免内存滞留。主调用的通知走 master 队列，不受影响。
   * 待确认账同步收口：目标已不可达，不能让它按超时静默挂着。 */
  dropTargetQueue(runtime, record, resolved, '目标已被释放');
  /* 先把窗口内待发的加入事件送出去，保证 master 看到的顺序是「加入在前、离席在后」。 */
  flushMemberEvents(runtime, record);
  sendNotice(runtime, record, sessionId, `已释放「${slave.name}」`, 'dispatch-member-left');
  persistNow(runtime, record);
  return { ok: true, sessionId: resolved };
}

/* —— 消息（不落盘，仅任务摘要进状态文件）与桥生命周期 —— */

/* 发送：master 可定向或广播给已收编 slave，slave 只能回 master（省略 toSessionIds 即回 master）。
 * 投递优先走 runtime.deliverSeat（等 bridge delivered 回执，确认真正投进目标会话）；缺省回落
 * runtime.notify 的同步受理语义。失败入按目标分桶的有界队列，桥重连（noteBridgeOnline）补投。
 * requireAck 仅 dispatch 的 task（调度长→组员）：登记待确认账并额外通知调度长。
 * 消息不落盘、不经 LAN 出站队列、不做本机席位注入——这是 dispatch 与 managed / forum 的根本差异。 */
async function sendMessageIn(runtime, {
  collabId, sessionId, text, type, toSessionIds, taskId, requireAck, ackFor, report, evidence, acceptance,
}) {
  const record = runtime.state.dispatches.get(collabId);
  if (record === undefined) {
    return dispatchLost();
  }
  if (isReplacedMasterOf(record, sessionId)) {
    return takenOverResult();
  }
  const sender = runtime.metaOf(sessionId);
  if (sender === null) {
    return errorOf('session-not-visible', '调用会话不在本机注册表内——本会话的桥可能已断开');
  }
  if (ackFor !== undefined) {
    return ackOnlyIn(runtime, record, sessionId, {
      ackFor, text, type, toSessionIds, taskId, requireAck, report, evidence, acceptance,
    });
  }
  const targets = sendTargetsOf(record, sessionId, toSessionIds);
  if (targets.error !== undefined) {
    return targets.error;
  }
  const message = messageOf(record, { text, type, taskId, sessionId, requireAck, report, evidence, acceptance }, sender, runtime.config);
  if (message.error !== undefined) {
    return message.error;
  }
  const taskUpdate = recordTaskStateIn(runtime, record, message.value, targets.value);
  if (taskUpdate.error !== undefined) {
    return taskUpdate.error;
  }
  const delivered = deliverMessage(runtime, record, targets.value, message.value);
  /* 关键节点写盘：只有带 taskId 的消息改变任务表；普通聊天不触发 IO。 */
  if (message.value.taskId !== null) {
    persistNow(runtime, record);
  }
  return delivered;
}

/* 任务表状态机（task / progress / result / error + taskId）：
 *   task → assigned（重新派发保留 createdAt、清 completedAt）
 *   progress → active；result → done；error → failed（后两者记 completedAt）
 * master 的消息按目标归属（单目标即该目标；广播保留原归属），slave 的消息归属发送者。
 * 任务表满时先裁完成项，仍满则拒绝新 taskId（在途任务不自动清理）。 */
function recordTaskStateIn(runtime, record, message, targets) {
  if (message.taskId === null) {
    return { error: undefined };
  }
  const existing = record.tasks.get(message.taskId);
  if (existing === undefined && record.tasks.size >= DISPATCH_TASK_MAX) {
    pruneTasksIn(runtime, record, runtime.now());
    if (record.tasks.size >= DISPATCH_TASK_MAX) {
      return { error: errorOf('task-table-full', `任务表已满（上限 ${DISPATCH_TASK_MAX}）——请先完成 / 清理在途任务，或换一个 taskId`) };
    }
  }
  const at = runtime.now();
  const senderIsMaster = message.fromSessionId === record.masterSessionId;
  const defaultAssignee = targets.length === 1 ? targets[0] : (existing?.assigneeSessionId ?? null);
  const next = taskAfterMessage({
    taskId: message.taskId,
    messageType: message.messageType,
    summary: message.summary,
    assigneeSessionId: senderIsMaster ? defaultAssignee : message.fromSessionId,
    existing,
    at,
    acceptance: message.acceptance,
    evidence: message.evidence,
  });
  record.tasks.set(message.taskId, next);
  return { error: undefined };
}

function taskAfterMessage({
  taskId, messageType, summary, assigneeSessionId, existing, at, acceptance, evidence,
}) {
  const lastProgress = summary.trim().slice(0, DISPATCH_TASK_SUMMARY_MAX);
  const base = taskBaseOf({ taskId, assigneeSessionId, existing, at });
  if (messageType === 'task') {
    return taskAssignedAfter(base, { assigneeSessionId, lastProgress, acceptance });
  }
  if (messageType === 'progress') {
    return { ...base, assigneeSessionId, status: 'active', lastProgress, staleNotified: false, completedAt: null };
  }
  return taskClosedAfter(base, { messageType, assigneeSessionId, lastProgress, evidence, at });
}

function taskBaseOf({ taskId, assigneeSessionId, existing, at }) {
  return existing === undefined
    ? {
      taskId, status: 'assigned', assigneeSessionId, lastProgress: null,
      acceptance: [], evidenceRef: null, staleNotified: false,
      createdAt: at, updatedAt: at, completedAt: null,
    }
    : { ...existing, assigneeSessionId: existing.assigneeSessionId ?? assigneeSessionId, updatedAt: at };
}

function taskAssignedAfter(base, { assigneeSessionId, lastProgress, acceptance }) {
  return {
    ...base,
    assigneeSessionId,
    status: 'assigned',
    lastProgress,
    acceptance: acceptance ?? base.acceptance ?? [],
    staleNotified: false,
    completedAt: null,
  };
}

function taskClosedAfter(base, { messageType, assigneeSessionId, lastProgress, evidence, at }) {
  const completed = messageType === 'result';
  return {
    ...base,
    assigneeSessionId,
    status: completed ? 'done' : 'failed',
    lastProgress,
    evidenceRef: completed ? (evidence ?? null) : (base.evidenceRef ?? null),
    completedAt: at,
  };
}

/* 完成项按 dispatch_hours 裁剪；未完成（assigned / active）永不清理。返回是否有变动。 */
function pruneTasksIn(runtime, record, at) {
  const hours = retentionConfigOf(runtime.config).dispatch_hours;
  const cutoff = at - hours * HOUR_MS;
  let changed = false;
  for (const [taskId, task] of [...record.tasks]) {
    if (!DISPATCH_TASK_DONE_STATUSES.has(task.status)) {
      continue;
    }
    const completedAt = Number.isFinite(task.completedAt) ? task.completedAt : task.updatedAt;
    const expired = hours === 0 || (Number.isFinite(completedAt) && completedAt <= cutoff);
    if (expired) {
      record.tasks.delete(taskId);
      changed = true;
    }
  }
  return changed;
}

/* 正文 / 类型 / taskId / 结构化字段 / 长度 / ack 的判定与出站文本组装。slave 的回复带 @来源——
 * master 收到的是多条 slave 消息混流，纯文本无法区分说话者。requireAck 只允许调度长的 task：
 * 其他组合静默忽略会造出「要了确认却没有确认」的假象，必须明确拒绝。 */
function messageOf(record, input, sender, config) {
  const messageType = messageTypeOf(record, input.type, input.sessionId);
  const rejection = messageRejectionOf(record, input, messageType);
  if (rejection !== null) {
    return { error: rejection };
  }
  const body = composeMessageBody(input, messageType);
  const lengthRejection = messageLengthRejectionOf(config, messageType, body);
  if (lengthRejection !== null) {
    return { error: lengthRejection };
  }
  const outbound = input.sessionId === record.masterSessionId ? body : `@${sender.name} ${body}`;
  return {
    value: {
      messageType,
      taskId: input.taskId ?? null,
      outbound,
      /* A 的任务表以正文摘要维护 lastProgress；B 的消息面不含 text 字段，这里显式保留。 */
      text: body,
      summary: messageSummaryOf(input, body),
      report: input.report ?? null,
      evidence: input.evidence ?? null,
      acceptance: input.acceptance ?? null,
      fromSessionId: input.sessionId,
      fromSessionName: sender.name,
      requireAck: resolveRequireAck(record, input, messageType, config),
    },
  };
}

function messageRejectionOf(record, input, messageType) {
  const { text, type, taskId, sessionId, requireAck, report, evidence, acceptance } = input;
  if (requireAck !== undefined && typeof requireAck !== 'boolean') {
    return errorOf('invalid-require-ack', 'requireAck 非法：需要布尔值');
  }
  const textRejection = textInputRejectionOf(text, report);
  if (textRejection !== null) {
    return textRejection;
  }
  if (type !== undefined && !DISPATCH_MESSAGE_TYPES.includes(type)) {
    return errorOf('invalid-message-type', `type 非法：dispatch 可取值为 ${DISPATCH_MESSAGE_TYPES.join(' / ')}`);
  }
  if (taskId !== undefined && !isDispatchTaskId(taskId)) {
    return errorOf('invalid-task-id', 'taskId 非法：需要 1–64 字符的非空白字符串');
  }
  const structuredRejection = structuredFieldRejectionOf({ report, evidence, acceptance, messageType });
  if (structuredRejection !== null) {
    return structuredRejection;
  }
  return requireAckRejectionOf(record, { requireAck, sessionId, type });
}

/* 不带 report 时 text 维持必填语义；带 report 时 text 可为空/省略，正文由 report 渲染。 */
function textInputRejectionOf(text, report) {
  if (report !== undefined) {
    return text === undefined || typeof text === 'string'
      ? null
      : errorOf('invalid-message-text', 'text 非法：需要字符串（带 report 时可省略或为空串）');
  }
  if (typeof text !== 'string' || text.trim() === '') {
    return errorOf('invalid-message-text', 'text 非法：需要非空白字符串');
  }
  return null;
}

/* 三个结构化字段的适用范围互不相同：report → progress/result，evidence → result，
 * acceptance → task。用错类型/模式一律明确拒绝，不静默忽略。 */
function structuredFieldRejectionOf({ report, evidence, acceptance, messageType }) {
  return reportRejectionOf(report, messageType)
    ?? evidenceRejectionOf(evidence, messageType)
    ?? acceptanceRejectionOf(acceptance, messageType);
}

function reportRejectionOf(report, messageType) {
  if (report === undefined) {
    return null;
  }
  if (messageType !== 'progress' && messageType !== 'result') {
    return errorOf('report-not-allowed', 'report 仅适用于 dispatch 的 progress / result 消息');
  }
  const checked = validateReport(report);
  return checked.ok ? null : errorOf('invalid-report', `report 非法：${checked.reason}`);
}

function evidenceRejectionOf(evidence, messageType) {
  if (evidence === undefined) {
    return null;
  }
  if (messageType !== 'result') {
    return errorOf('evidence-not-allowed', 'evidence 仅适用于 dispatch 的 result 消息');
  }
  const checked = validateEvidence(evidence);
  return checked.ok ? null : errorOf('invalid-evidence', `evidence 非法：${checked.reason}`);
}

function acceptanceRejectionOf(acceptance, messageType) {
  if (acceptance === undefined) {
    return null;
  }
  if (messageType !== 'task') {
    return errorOf('acceptance-not-allowed', 'acceptance 仅适用于 dispatch 的 task 消息');
  }
  const checked = validateAcceptance(acceptance);
  return checked.ok ? null : errorOf('invalid-acceptance', `acceptance 非法：${checked.reason}`);
}

/* 投递正文：显式 text + report 渲染 + task 的验收标准 + result 的证据，段间空行分隔。 */
function composeMessageBody(input, messageType) {
  const sections = [];
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (text !== '') {
    sections.push(text);
  }
  if (input.report !== undefined) {
    sections.push(renderReport(input.report));
  }
  if (input.acceptance !== undefined && messageType === 'task') {
    sections.push(renderAcceptance(input.acceptance));
  }
  if (input.evidence !== undefined && messageType === 'result') {
    sections.push(renderEvidence(input.evidence));
  }
  return sections.join('\n\n');
}

/* 任务表的最后进度摘要：结构化报告优先用 summary（一句话），否则退回正文（截断由任务表负责）。 */
function messageSummaryOf(input, body) {
  const summary = input.report?.summary;
  return typeof summary === 'string' && summary.trim() !== '' ? summary.trim() : body;
}

/* 长度上限按最终投递正文计（report / acceptance / evidence 渲染后同样受限），防止结构化字段绕过限制。 */
function messageLengthRejectionOf(config, messageType, body) {
  const limits = messageLimitsOf(config);
  const limit = messageType === 'progress'
    ? limits.progress
    : (messageType === 'result' ? limits.result : limits.text);
  if (body.length <= limit) {
    return null;
  }
  return errorOf(
    'message-too-long',
    `${messageType} 消息超过长度上限 ${limit} 字符（当前 ${body.length}）——请把长内容写文件，消息里只发摘要 + 文件路径`,
  );
}

/* requireAck 缺省值：显式值优先；未给时只有调度长的 task 才按配置默认值处理（默认 false 保持兼容）。 */
function resolveRequireAck(record, input, messageType, config) {
  if (input.requireAck !== undefined) {
    return input.requireAck === true;
  }
  return requireAckDefaultOf(config)
    && input.sessionId === record.masterSessionId
    && messageType === 'task';
}

function messageTypeOf(record, type, sessionId) {
  if (type !== undefined) {
    return type;
  }
  return sessionId === record.masterSessionId ? 'task' : 'result';
}

function requireAckRejectionOf(record, { requireAck, sessionId, type }) {
  if (requireAck !== true) {
    return null;
  }
  const masterTask = sessionId === record.masterSessionId && messageTypeOf(record, type, sessionId) === 'task';
  return masterTask ? null : errorOf('require-ack-not-allowed', 'requireAck 仅适用于调度长发出的 task 消息');
}

function isDispatchTaskId(taskId) {
  return typeof taskId === 'string' && taskId.trim() !== '' && taskId.length <= 64;
}

/* 投递循环（async：deliverSeat 要等 bridge 回执）：成功即送达；失败入按目标分桶的有界队列
 * （桥重连补投），不静默丢弃。返回逐目标 delivery 与既有 delivered/queued 计数。 */
async function deliverMessage(runtime, record, targets, message) {
  const results = [];
  for (const target of targets) {
    const frame = messageFrameOf(runtime, record, target, message);
    const delivered = await deliverOnce(runtime, frame, target, record.collabId);
    results.push(delivered
      ? deliveredEntryFrame(runtime, target, frame, record, message)
      : queuedEntryFrame(runtime, record, target, frame, message));
  }
  return messageResultOf(record, targets, results, message.requireAck);
}

/* 单目标帧：在既有通知帧上补 dispatch 消息面；requireAck 时在正文末尾追加回执指引
 * （目标模型看不到帧 msgId，必须在文本里给出可直接照抄的调用）。 */
function messageFrameOf(runtime, record, target, message) {
  const frame = noticeFrame(runtime, record, target, message.outbound, 'dispatch-message');
  frame.payload.messageType = message.messageType;
  frame.payload.taskId = message.taskId;
  frame.payload.fromSessionId = message.fromSessionId;
  frame.payload.fromSessionName = message.fromSessionName;
  if (message.report !== null) {
    frame.payload.report = message.report;
  }
  if (message.evidence !== null) {
    frame.payload.evidence = message.evidence;
  }
  if (message.acceptance !== null) {
    frame.payload.acceptance = message.acceptance;
  }
  if (message.requireAck) {
    frame.payload.requireAck = true;
    frame.payload.text = `${message.outbound}\n\n[需确认] 收到请回执：ws_send_message { collabId: "${record.collabId}", text: "收到", ackFor: "${frame.msgId}" }`;
  }
  return frame;
}

/* 单目标投递：有异步投递面就等它（bridge 回执），否则回落既有同步 notify。 */
async function deliverOnce(runtime, frame, target, collabId) {
  if (runtime.deliverSeat === null) {
    return notifyOnce(runtime, frame);
  }
  try {
    return (await runtime.deliverSeat(frame, target)) === true;
  } catch (error) {
    runtime.log?.warn?.('dispatch 消息投递异常（转入待补投队列）', {
      collabId, targetSessionId: target, reason: error?.message,
    });
    return false;
  }
}

function deliveredEntryFrame(runtime, target, frame, record, message) {
  if (message.requireAck) {
    registerPendingAck(runtime, record, target, frame, message, 'delivered');
  }
  return { sessionId: target, status: 'delivered', msgId: frame.msgId };
}

/* 入队并为该目标设定补投截止（首次入队时确定；宽限内桥重连会由 noteBridgeOnline 补投）。 */
function queuedEntryFrame(runtime, record, target, frame, message) {
  const deadline = queueDeadlineOf(runtime, record, target);
  enqueue(runtime, record, target, frame);
  if (message.requireAck) {
    registerPendingAck(runtime, record, target, frame, message, 'queued');
  }
  return { sessionId: target, status: 'queued', msgId: frame.msgId, queuedUntil: new Date(deadline).toISOString() };
}

function queueDeadlineOf(runtime, record, target) {
  const known = record.queueDeadlines.get(target);
  if (known !== undefined) {
    return known;
  }
  const grace = record.grace.get(target);
  const deadline = Number.isInteger(grace) ? Math.max(grace, runtime.now()) : runtime.now() + graceMsOf(runtime.config);
  record.queueDeadlines.set(target, deadline);
  return deadline;
}

function registerPendingAck(runtime, record, target, frame, message, deliveryState) {
  record.pendingAcks.set(frame.msgId, {
    ackFor: frame.msgId,
    targetSessionId: target,
    masterSessionId: record.masterSessionId,
    taskId: message.taskId,
    excerpt: excerptOf(message.outbound),
    deliveryState,
    createdAt: runtime.now(),
    deadline: runtime.now() + ackTtlOf(runtime.config),
  });
}

function ackTtlOf(config) {
  const value = config?.dispatchAckTtlMs;
  return Number.isInteger(value) && value > 0 ? value : DISPATCH_ACK_TTL_MS;
}

function excerptOf(text, max = 60) {
  const flat = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/* 发送结果：既有字段（delivered/queued/targets）原样保留，新增 delivery 汇总与逐目标明细。 */
function messageResultOf(record, targets, results, requireAck) {
  const counts = countDelivery(results);
  const ack = requireAck
    ? { required: true, state: 'pending', pending: results.filter((entry) => entry.status !== 'failed').map((entry) => entry.msgId) }
    : undefined;
  return {
    ok: true,
    dispatchId: record.collabId,
    delivered: counts.delivered,
    queued: counts.queued,
    targets,
    delivery: {
      state: overallDeliveryStateOf(counts, results.length),
      ...counts,
      targets: results,
      ...(ack === undefined ? {} : { ack }),
    },
  };
}

function countDelivery(results) {
  const counts = { delivered: 0, queued: 0, failed: 0 };
  for (const entry of results) {
    if (entry.status === 'delivered' || entry.status === 'queued' || entry.status === 'failed') {
      counts[entry.status]++;
    }
  }
  return counts;
}

/* 归并状态：全 delivered / 全 failed / 无 delivered 且无 failed（全 queued）/ 其余 partial。 */
function overallDeliveryStateOf(counts, total) {
  if (total > 0 && counts.delivered === total) {
    return 'delivered';
  }
  if (total > 0 && counts.failed === total) {
    return 'failed';
  }
  if (counts.delivered === 0 && counts.failed === 0) {
    return 'queued';
  }
  return 'partial';
}

/* ackFor 是独立回执动作（服务层同口径）：形态必须合法，且不得与消息发送字段混用。 */
function ackOnlyIn(runtime, record, sessionId, {
  ackFor, text, type, toSessionIds, taskId, requireAck, report, evidence, acceptance,
}) {
  if (typeof ackFor !== 'string' || !ID_PATTERN.test(ackFor)) {
    return errorOf('invalid-ack-for', 'ackFor 非法：需要消息标识（1–64 位字母数字与连字符）');
  }
  if (type !== undefined || toSessionIds !== undefined || taskId !== undefined || requireAck !== undefined
    || report !== undefined || evidence !== undefined || acceptance !== undefined) {
    return errorOf(
      'ack-for-conflict',
      'ackFor 回执不能与 type / toSessionIds / taskId / requireAck / report / evidence / acceptance 同时使用',
    );
  }
  return ackMessageIn(runtime, record, sessionId, ackFor, text);
}

/* 目标会话回执：ackFor 必须命中待确认账且回执者就是被投递目标；成功即向调度长另行通知。 */
function ackMessageIn(runtime, record, sessionId, ackFor, text) {
  const pending = record.pendingAcks.get(ackFor);
  if (pending === undefined) {
    return errorOf('ack-not-found', 'ackFor 无对应的待确认消息（可能已确认、已超时或标识有误）');
  }
  if (pending.targetSessionId !== sessionId) {
    return errorOf('ack-not-yours', '只有该消息的目标会话可以确认（ackFor 与调用会话不匹配）');
  }
  record.pendingAcks.delete(ackFor);
  const sender = runtime.metaOf(sessionId);
  const name = sender?.name ?? sessionId;
  const note = typeof text === 'string' ? text.trim() : '';
  const task = pending.taskId === null ? '消息' : `任务 ${pending.taskId}`;
  sendNotice(
    runtime,
    record,
    record.masterSessionId,
    `「${name}」已确认收到${task}（${ackFor}）${note === '' ? '' : `：${note}`}（原文：${pending.excerpt}）`,
    'dispatch-ack',
  );
  return { ok: true, dispatchId: record.collabId, acked: true, ackFor, taskId: pending.taskId };
}

/* 路由判定：返回 { value: targets } 或 { error }。master 定向到非成员 / slave 越权回复 /
 * 非成员发送都必须如实拒绝——静默丢消息比拒绝更难排查。 */
function sendTargetsOf(record, sessionId, toSessionIds) {
  const refusal = toSessionIdsRefusalOf(toSessionIds);
  if (refusal !== null) {
    return { error: refusal };
  }
  return sessionId === record.masterSessionId
    ? masterTargetsOf(record, toSessionIds)
    : slaveTargetsOf(record, sessionId, toSessionIds);
}

/* toSessionIds 形状：未给＝按绑定路由（master 广播 / slave 回 master）；显式给出时必须是非空
 * 字符串数组——空数组既不等于「省略」也不该落到误导性的「目标不在 dispatch 内」判定。 */
function toSessionIdsRefusalOf(toSessionIds) {
  if (toSessionIds === undefined) {
    return null;
  }
  if (!Array.isArray(toSessionIds) || toSessionIds.length === 0) {
    return errorOf('invalid-session-ids', 'toSessionIds 非法：需要非空字符串数组（省略即按绑定路由）');
  }
  return toSessionIds.every((id) => typeof id === 'string' && id.trim() !== '')
    ? null
    : errorOf('invalid-session-ids', 'toSessionIds 非法：需要非空字符串数组');
}

/* 显式目标接受完整 sessionId 或短码（sessionCode）：逐个解析到唯一在册会话；
 * 任一目标无法唯一解析即整单拒绝——静默跳过会让调用方误以为已送达。 */
function resolveTargetsOrNull(candidates, tokens) {
  const resolved = [];
  for (const token of new Set(tokens)) {
    const sessionId = resolveSessionToken(candidates, token);
    if (sessionId === null) {
      return { error: errorOf('target-not-in-dispatch', `目标会话不在本 dispatch 内：${token}`) };
    }
    resolved.push(sessionId);
  }
  return { value: [...new Set(resolved)] };
}

function masterTargetsOf(record, toSessionIds) {
  if (toSessionIds === undefined || toSessionIds.length === 0) {
    const broadcast = [...record.slaves.keys()];
    return broadcast.length === 0
      ? { error: errorOf('dispatch-empty', 'dispatch 内没有已收编的 slave') }
      : { value: broadcast };
  }
  return resolveTargetsOrNull(record.slaves.keys(), toSessionIds);
}

function slaveTargetsOf(record, sessionId, toSessionIds) {
  if (!record.slaves.has(sessionId)) {
    return { error: errorOf('not-dispatch-member', '本会话不是该 dispatch 的成员') };
  }
  if (Array.isArray(toSessionIds) && toSessionIds.length > 0) {
    const resolved = toSessionIds.length === 1
      ? resolveSessionToken([record.masterSessionId], toSessionIds[0])
      : null;
    if (resolved !== record.masterSessionId) {
      return { error: errorOf('slave-target-refused', 'slave 只能回复 master，不能给其他 slave 发消息') };
    }
  }
  return { value: [record.masterSessionId] };
}

/* 结束（master 专属）：先向每个 slave 与 master 发结束通知，再从内存域删除整条记录并删除
 * 持久面（队列 / 任务表随之回收）。旧 master 已被接管时返回明确拒绝。 */
function endDispatchIn(runtime, { collabId, sessionId }) {
  const record = runtime.state.dispatches.get(collabId);
  if (record === undefined) {
    return dispatchLost();
  }
  if (record.masterSessionId !== sessionId) {
    return isReplacedMasterOf(record, sessionId)
      ? takenOverResult()
      : errorOf('dispatch-master-required', '只有 master 可以结束 dispatch');
  }
  endDispatch(runtime, record, 'master-ended');
  return { ok: true, collabId };
}

function endDispatch(runtime, record, reason) {
  for (const sessionId of [...record.slaves.keys()]) {
    sendNotice(runtime, record, sessionId, `dispatch「${record.name}」已结束（${reason}）`, 'dispatch-ended');
  }
  sendNotice(runtime, record, record.masterSessionId, `dispatch「${record.name}」已结束`, 'dispatch-ended');
  clearTimeout(record.eventTimer);
  runtime.state.dispatches.delete(record.collabId);
  removePersistedState(runtime, reason);
}

/* 退出（slave 专属）：只移除自己并通知 master；master 退出即「结束」，必须走 ws_end_collab。 */
function leaveDispatchIn(runtime, { collabId, sessionId }) {
  const record = runtime.state.dispatches.get(collabId);
  if (record === undefined) {
    return dispatchLost();
  }
  if (record.masterSessionId === sessionId) {
    return errorOf('dispatch-master-cannot-leave', 'master 不能被 leave——结束请用 ws_end_collab');
  }
  if (isReplacedMasterOf(record, sessionId)) {
    return takenOverResult();
  }
  const slave = record.slaves.get(sessionId);
  if (slave === undefined) {
    return errorOf('not-dispatch-member', '本会话不在该 dispatch 内');
  }
  record.slaves.delete(sessionId);
  dropTargetQueue(runtime, record, sessionId, '目标已退出');
  flushMemberEvents(runtime, record);
  sendNotice(runtime, record, record.masterSessionId, `「${slave.name}」已退出 dispatch`, 'dispatch-member-left');
  persistNow(runtime, record);
  return { ok: true, collabId };
}

/* 桥重连：master 注册即刷新心跳（可能撤销待接管），并撤销宽限、补投断连期间排队的通知。 */
function noteBridgeOnlineIn(runtime, sessionId) {
  const record = runtime.dispatchOf(sessionId);
  if (record === null) {
    return;
  }
  record.grace.delete(sessionId);
  if (record.masterSessionId === sessionId) {
    noteActivityIn(runtime, sessionId, runtime.now());
  }
  flushQueue(runtime, record, sessionId);
}

/* 桥断开：登记宽限截止时刻；master 宽限到期只标记待接管（不再直接结束 dispatch），
 * slave 超时由 sweep 移除。 */
function noteBridgeClosedIn(runtime, sessionId, at) {
  const record = runtime.dispatchOf(sessionId);
  if (record === null) {
    return;
  }
  record.grace.set(sessionId, at + graceMsOf(runtime.config));
}

function graceMsOf(config) {
  const value = config?.sessionSeatGraceMs;
  return Number.isInteger(value) && value >= 0 ? value : DISPATCH_GRACE_MS;
}

/* 心跳刷新（任意 ws 工具调用 / 桥重连）：只更新 master 的心跳；从 pending-takeover 恢复时
 * 广播一次「调度恢复」并写盘。active 状态的普通心跳不写盘（避免 IO 放大）。 */
function noteActivityIn(runtime, sessionId, at) {
  const record = runtime.masterDispatchOf(sessionId);
  if (record === null) {
    return { ok: false, code: 'dispatch-lost' };
  }
  record.masterLastSeenAt = Math.max(record.masterLastSeenAt, at);
  if (record.status === 'pending-takeover') {
    resumeDispatchIn(runtime, record);
  }
  return { ok: true, dispatchId: record.collabId, status: record.status };
}

function resumeDispatchIn(runtime, record) {
  record.status = 'active';
  record.masterLostAt = null;
  for (const sessionId of record.slaves.keys()) {
    sendNotice(
      runtime, record, sessionId,
      `调度长「${record.masterName}」已恢复心跳——dispatch「${record.name}」继续执行（组员与任务表保留）`,
      'dispatch-resumed',
    );
  }
  persistNow(runtime, record);
}

function markPendingTakeover(runtime, record, at, reason) {
  if (record.status === 'pending-takeover') {
    return false;
  }
  record.status = 'pending-takeover';
  record.masterLostAt = at;
  record.grace.delete(record.masterSessionId);
  const timeoutSeconds = Math.round(masterTimeoutMsOf(runtime.config) / 1000);
  const detail = reason === 'master-disconnected'
    ? `调度长「${record.masterName}」已断开超过宽限`
    : `调度长「${record.masterName}」心跳超时（${timeoutSeconds}s 无 ws 工具调用）`;
  for (const sessionId of record.slaves.keys()) {
    sendNotice(
      runtime, record, sessionId,
      `${detail}——调度暂停，组员与任务表保留；新调度长可调用 ws_create_collab 接管，原调度长恢复调用可继续`,
      'dispatch-takeover-pending',
    );
  }
  if (runtime.metaOf(record.masterSessionId)?.online === true) {
    sendNotice(
      runtime, record, record.masterSessionId,
      `你的调度长心跳已超时（${timeoutSeconds}s 无 ws 工具调用）——继续调用任意 ws 工具可恢复，否则其他 master 会话可接管（组员与任务表保留）`,
      'dispatch-takeover-pending',
    );
  }
  persistNow(runtime, record);
  return true;
}

/* 清扫（presence 节拍驱动）：master 心跳超时 → 待接管；过期收编申请 + 桥断开宽限超时。
 * 核心重启后内存账从状态文件恢复；状态文件之外的运行态（claim / grace / 队列）不恢复。 */
function sweepDispatchesIn(runtime, at) {
  for (const record of [...runtime.state.dispatches.values()]) {
    if (!runtime.state.dispatches.has(record.collabId)) {
      continue;
    }
    ensureRuntimeMaps(record);
    maybeMarkMasterPending(runtime, record, at);
    sweepClaimsOf(runtime, record, at);
    sweepQueuesOf(runtime, record, at);
    sweepAcksOf(runtime, record, at);
    sweepStaleTasksOf(runtime, record, at);
    sweepGraceOf(runtime, record, at);
    if (record.status === 'active' && record.autoClaim) {
      autoClaimPassIn(runtime, record);
    }
  }
}

/* 运行态 Map 容错：正常记录由创建 / 恢复路径保证是 Map；旧文件或测试桩缺省时补空 Map
 * （这两本账的语义就是 Map，不用数组兜底）。 */
function ensureRuntimeMaps(record) {
  if (!(record.queueDeadlines instanceof Map)) {
    record.queueDeadlines = new Map();
  }
  if (!(record.pendingAcks instanceof Map)) {
    record.pendingAcks = new Map();
  }
}

function maybeMarkMasterPending(runtime, record, at) {
  if (record.status !== 'active') {
    return;
  }
  if (at - record.masterLastSeenAt < masterTimeoutMsOf(runtime.config)) {
    return;
  }
  markPendingTakeover(runtime, record, at, 'heartbeat-timeout');
}

/* 宽限超时：master 超时＝标记待接管（保留组员 / 任务表，不再直接结束）；slave 超时先移除再
 * 统一通告。单个超时保持既有直发 member-left（同步语义）；同一节拍多个超时合并成一条成员事件，
 * 避免一次清扫刷屏。 */
function sweepGraceOf(runtime, record, at) {
  const expired = [];
  let changed = false;
  for (const [sessionId, deadline] of [...record.grace]) {
    if (deadline > at) {
      continue;
    }
    if (sessionId === record.masterSessionId) {
      markPendingTakeover(runtime, record, at, 'master-disconnected');
      break;
    }
    const slave = record.slaves.get(sessionId);
    record.slaves.delete(sessionId);
    dropTargetQueue(runtime, record, sessionId, '宽限超时离席');
    expired.push(slave?.name ?? sessionId);
    changed = true;
  }
  notifyGraceTimeouts(runtime, record, expired);
  if (changed) {
    persistNow(runtime, record);
  }
}

/* 补投超时（宽限截止已到）：丢弃该目标队列并向调度长如实回报条数——队列不会无限滞留。 */
function sweepQueuesOf(runtime, record, at) {
  for (const [target, deadline] of [...record.queueDeadlines]) {
    if (deadline > at) {
      continue;
    }
    const dropped = record.queues.get(target)?.length ?? 0;
    dropQueueOnly(runtime, record, target, '补投超时');
    if (dropped > 0) {
      sendNotice(
        runtime,
        record,
        record.masterSessionId,
        `「${targetNameOf(record, target)}」的消息补投超时（${dropped} 条未送达，宽限截止）`,
        'dispatch-delivery-timeout',
      );
    }
  }
}

/* 待确认超时：requireAck 的条目超过 TTL 仍未回执，收口并通知调度长（不静默挂着）。 */
function sweepAcksOf(runtime, record, at) {
  for (const [msgId, pending] of [...record.pendingAcks]) {
    if (pending.deadline > at) {
      continue;
    }
    record.pendingAcks.delete(msgId);
    sendNotice(
      runtime,
      record,
      record.masterSessionId,
      `任务消息超时未确认：${msgId}${pending.taskId === null ? '' : `（任务 ${pending.taskId}）`}——目标 ${targetNameOf(record, pending.targetSessionId)}`,
      'dispatch-ack-timeout',
    );
  }
}

/* 任务超时提醒（问题 6-A）：assigned / active 且最后进度距今 ≥ task_stale_ms 的任务，
 * 向调度长投一次 dispatch-task-stale（含 taskId / 负责会话 / 最后进度摘要）。
 * 同一任务只提醒一次（staleNotified），有新 progress 时由任务状态机清位；不改任务状态、不自动失败。 */
function sweepStaleTasksOf(runtime, record, at) {
  const staleMs = taskStaleMsOf(runtime.config);
  for (const task of record.tasks.values()) {
    if (isStaleTaskCandidate(task, at, staleMs)) {
      notifyStaleTask(runtime, record, task, at);
    }
  }
}

function isStaleTaskCandidate(task, at, staleMs) {
  if (!isOpenTaskStatus(task.status)) {
    return false;
  }
  if (task.staleNotified === true) {
    return false;
  }
  const last = Number.isFinite(task.updatedAt) ? task.updatedAt : task.createdAt;
  return Number.isFinite(last) && at - last >= staleMs;
}

function isOpenTaskStatus(status) {
  return status === 'assigned' || status === 'active';
}

function notifyStaleTask(runtime, record, task, at) {
  task.staleNotified = true;
  const last = Number.isFinite(task.updatedAt) ? task.updatedAt : task.createdAt;
  const minutes = Math.floor((at - last) / 60000);
  sendNotice(
    runtime,
    record,
    record.masterSessionId,
    `任务超时无进展：${task.taskId}（负责会话：${staleAssigneeOf(record, task)}）——最后进度：${staleProgressOf(task)}（已 ${minutes} 分钟无 progress）`,
    'dispatch-task-stale',
  );
}

function staleAssigneeOf(record, task) {
  if (task.assigneeSessionId === null || task.assigneeSessionId === undefined) {
    return '未指派';
  }
  return targetNameOf(record, task.assigneeSessionId);
}

function staleProgressOf(task) {
  return typeof task.lastProgress === 'string' && task.lastProgress !== '' ? task.lastProgress : '（无）';
}

/* 目标队列回收：只清队列、补投截止与待确认账（不碰 grace/成员关系——宽限超时后仍由
 * sweepGraceOf 收口）；待确认账同步作废并向调度长回报。 */
function dropQueueOnly(runtime, record, target, reason) {
  record.queues.delete(target);
  record.queueDeadlines.delete(target);
  expirePendingAcksOfTarget(runtime, record, target, reason);
}

/* 目标退场（释放/退出/宽限超时）：队列三本账 + 宽限一起清。 */
function dropTargetQueue(runtime, record, target, reason) {
  dropQueueOnly(runtime, record, target, reason);
  record.grace.delete(target);
}

function expirePendingAcksOfTarget(runtime, record, target, reason) {
  for (const [msgId, pending] of [...record.pendingAcks]) {
    if (pending.targetSessionId !== target) {
      continue;
    }
    record.pendingAcks.delete(msgId);
    sendNotice(
      runtime,
      record,
      record.masterSessionId,
      `任务消息未确认（${reason}）：${msgId}${pending.taskId === null ? '' : `（任务 ${pending.taskId}）`}`,
      'dispatch-ack-timeout',
    );
  }
}

function targetNameOf(record, targetSessionId) {
  return record.slaves.get(targetSessionId)?.name ?? targetSessionId;
}

function notifyGraceTimeouts(runtime, record, expired) {
  if (expired.length === 0) {
    return;
  }
  /* 先送窗口内待发的加入事件：成员先加入后超时，顺序不得倒置。 */
  flushMemberEvents(runtime, record);
  if (expired.length === 1) {
    sendNotice(runtime, record, record.masterSessionId, `「${expired[0]}」宽限超时离席`, 'dispatch-member-left');
    return;
  }
  for (const name of expired) {
    queueMemberEvent(runtime, record, `「${name}」宽限超时离席`);
  }
}

function sweepClaimsOf(runtime, record, at) {
  for (const [claimId, claim] of [...record.claims]) {
    if (claim.expiresAt > at) {
      continue;
    }
    record.claims.delete(claimId);
    sendNotice(runtime, record, record.masterSessionId, `收编申请已超时：${claim.targetSessionId}`, 'dispatch-claim-expired');
  }
}

/* 绑定收尾：登记 slave、清宽限标记，并把断连期间排队的通知补投（notify 恢复后即可达）。
 * 加入事件入 500ms 去抖队列（批量收编时合并成一条），不再逐成员直发。 */
function bindSlave(runtime, record, meta) {
  record.slaves.set(meta.sessionId, {
    sessionId: meta.sessionId, name: meta.name, kind: meta.kind, role: meta.role, boundAt: runtime.now(),
  });
  record.grace.delete(meta.sessionId);
  flushQueue(runtime, record, meta.sessionId);
  queueMemberEvent(runtime, record, `「${meta.name}」已加入`);
  persistNow(runtime, record);
}

/* 成员事件去抖：同一 500ms 窗口内的加入 / 批量离席文本合并成一条 dispatch-member-event 投给 master。
 * 定时器 unref，不拖住进程；dispatch 结束时由 endDispatch 清除。离席的单个事件仍走既有直发
 * （Task 2/5 的同步口径），但投递前会 flush 本队列，保证「先加入、后离席」的顺序。 */
function queueMemberEvent(runtime, record, text) {
  record.pendingEvents.push(text);
  if (record.eventTimer !== null) {
    return;
  }
  const timer = setTimeout(() => {
    record.eventTimer = null;
    flushMemberEvents(runtime, record);
  }, DISPATCH_MEMBER_EVENT_DEBOUNCE_MS);
  timer.unref?.();
  record.eventTimer = timer;
}

function flushMemberEvents(runtime, record) {
  if (record.pendingEvents.length === 0) {
    return;
  }
  if (record.eventTimer !== null) {
    clearTimeout(record.eventTimer);
    record.eventTimer = null;
  }
  const text = record.pendingEvents.join('；');
  record.pendingEvents.length = 0;
  sendNotice(runtime, record, record.masterSessionId, text, 'dispatch-member-event');
}

function claimOf(state, claimId) {
  for (const record of state.dispatches.values()) {
    const claim = record.claims.get(claimId);
    if (claim !== undefined) {
      return { record, claim };
    }
  }
  return null;
}

function noticeFrame(runtime, record, targetSessionId, text, event) {
  return {
    v: 1,
    type: 'notice',
    msgId: randomUUID(),
    from: { instanceId: runtime.state.self.instanceId, identityName: record.name, sessionId: record.masterSessionId },
    collabId: record.collabId,
    ts: new Date(runtime.now()).toISOString(),
    payload: { event, text, targetSessionId },
  };
}

/* 投递出口：notify 返回 true 才算送达；未注入 / 返回 false / 抛异常一律转入待补投队列，
 * 不得静默丢失（核心的 notify 在桥重连后仍可 flush）。 */
function sendNotice(runtime, record, targetSessionId, text, event) {
  const frame = noticeFrame(runtime, record, targetSessionId, text, event);
  if (notifyOnce(runtime, frame)) {
    return;
  }
  enqueue(runtime, record, targetSessionId, frame);
}

function notifyOnce(runtime, frame) {
  if (runtime.notify === null) {
    return false;
  }
  try {
    return runtime.notify(frame) === true;
  } catch (error) {
    runtime.log?.warn?.('dispatch 通知投递异常（转入待补投队列）', {
      collabId: frame.collabId, targetSessionId: frame.payload?.targetSessionId, reason: error?.message,
    });
    return false;
  }
}

function enqueue(runtime, record, targetSessionId, frame) {
  const queue = record.queues.get(targetSessionId) ?? [];
  if (queue.length >= queueLimitOf(runtime.config)) {
    noteDroppedFrame(runtime, record, queue.shift());
    runtime.state.counters.dispatchQueueDropped = (runtime.state.counters.dispatchQueueDropped ?? 0) + 1;
    runtime.log?.warn?.('dispatch 通知队列已满，丢弃最旧一条', { collabId: record.collabId, targetSessionId });
  }
  queue.push(frame);
  record.queues.set(targetSessionId, queue);
}

/* 队列溢出丢弃的帧：若它在待确认账里，立即作废并如实通知调度长（不能等 TTL 假装还在等）。 */
function noteDroppedFrame(runtime, record, frame) {
  const pending = record.pendingAcks.get(frame.msgId);
  if (pending === undefined) {
    return;
  }
  record.pendingAcks.delete(frame.msgId);
  sendNotice(
    runtime,
    record,
    record.masterSessionId,
    `任务消息未确认（待补投队列溢出，已丢弃）：${frame.msgId}`,
    'dispatch-ack-timeout',
  );
}

/* 通知队列容量：缺省用本模块常量；配置可经 dispatchQueueMax 收紧 / 放宽（未知键原样保留在生效配置）。 */
function queueLimitOf(config) {
  const limit = config?.dispatchQueueMax;
  return Number.isInteger(limit) && limit > 0 ? limit : DISPATCH_QUEUE_MAX;
}

function flushQueue(runtime, record, targetSessionId) {
  const queue = record.queues.get(targetSessionId);
  if (queue === undefined) {
    return;
  }
  const deadline = record.queueDeadlines.get(targetSessionId);
  if (deadline !== undefined && runtime.now() > deadline) {
    dropQueueOnly(runtime, record, targetSessionId, '补投超时');
    return;
  }
  while (queue.length > 0 && notifyOnce(runtime, queue[0])) {
    noteQueuedAckDelivered(record, queue.shift());
  }
  if (queue.length === 0) {
    record.queues.delete(targetSessionId);
    record.queueDeadlines.delete(targetSessionId);
  }
}

/* 补投成功：待确认账从 queued 推进到 delivered（ack 超时仍按原截止收口）。 */
function noteQueuedAckDelivered(record, frame) {
  const pending = record.pendingAcks.get(frame.msgId);
  if (pending !== undefined) {
    pending.deliveryState = 'delivered';
  }
}
