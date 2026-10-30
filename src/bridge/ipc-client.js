import { randomUUID } from 'node:crypto';
import { spawn as spawnChild } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { IPC_CONNECT_TIMEOUT_MS, IPC_HANDSHAKE_TIMEOUT_MS, IPC_VERSION, createIpcClient, endpointFor } from '../core/ipc.js';
import { lifecycleParams, pidIsAlive } from '../core/lifecycle.js';
import { killGuarded, probeEndpointPresence } from '../core/stop-guard.js';
import {
  INFLIGHT_MESSAGE, REPLACER_RELEASE_DEADLINE_MS, VERSION_DOWNGRADE_MESSAGE,
  createChangeoverLedger, createReplacerFlight, createWaitingForNewCore, decideChangeover, readTargetAppVersion,
} from '../core/changeover.js';
import { coreJsonPath } from '../paths.js';

/* 桥→核心的探测、连接、冷启与监督（设计 §3.1 冷启流程／§3.3 崩溃矩阵／§8 降级矩阵）。
 * 分类序（每轮探测，写死）：
 * - core.json 不存在或不可解析 → 判陈旧 → 冷启（不可解析的锁由被冷启核心的仲裁清理）；
 * - 启动失败已落 startupError → 按启动失败收口（不等截止期，也不冷启——防崩溃环反复 spawn）；
 * - pid 死/非法 → 判陈旧（重生流：核心崩后残留描述符的自愈入口）→ 冷启；
 * - pid 活但心跳停 → 僵尸核心 → 硬杀防护链（stop-guard 共享件）：链全过才冷启，校验不过＝降级
 *   上报、不冷启（宁可不杀）；
 * - starting（未超 startupDeadline）或 waiting（pid 活＋心跳新鲜）→ 等待（不冷启、不偷锁——陈旧锁
 *   的清理与取锁仲裁归核心侧）；
 * - welcome 回 code:'replacing' → 等待新核（换代协议见下）；
 * - 其余 → 连接尝试；失败按「核心启动失败/重连」收口，不阻塞会话。
 * 换代协议（设计 §5；判定/状态机/台账出自 core/changeover.js——单一权威）：注册后按
 * 「安装树目标版本 vs 运行核心版本」判定——目标＞运行＝发 replace 起换代（本桥即 replacer）；
 * 目标≤运行＝直接服务（含「装回旧版不换代」）。握手被 version 拒绝时以拒绝帧携带的核心 ipcV
 * 定方向（ipc.js 透传为 error.coreV）：核心更高＝旧桥降级文案；核心更低＝直连替换（旧核不会主动
 * 退场——版本拒绝实证走硬杀防护链后 spawn 安装树入口）。等待新核态（收 core-restarting 广播或
 * 被回 code:'replacing'）期间禁止主动冷启（ensureCore 直接以「换代中」文案收口）；30s 截止＝
 * 换代失败收场，随后交标准获取路径。换代轮次由桥侧台账截断（连续两轮未达目标即停止）——
 * stop-guard 的「同 pid 单次」闸是进程级，不跨代 pid/不跨桥，跨轮截断只能由台账承担。
 * 重生流（设计 §3.3）：连接断开 → 立刻按上述分类序重探（判陈旧即冷启）；快速重试上界 3 次/10 分钟，
 * 其后转 60s 慢速重试（不风暴）；重生成功后重注册经 onRegistered 钩子外送（绑定恢复/会话状态文件
 * 重建在核心侧）。单次连接归 IPC 层（createIpcClient，桥每次连接现读 core.json 的 token）；
 * 本模块持有分类序、重试节奏、冷启 spawn 与 pending 调用表。桥不写文件日志——诊断经注入的 log 走 stderr。 */

/* 缺省节奏（设计 S5 数值族）：单次等待预算＝握手上限 10s（首个工具调用等待上限的落点，连接与
 * 握手期限被预算钳制为硬期限）；探测轮询 300ms；waiting 态后台轮询 5s（核转 ready 后尽快接上）；
 * 其余失败后台慢速重试 60s。 */
export const CORE_WAIT_BUDGET_MS = 10000;
export const CORE_POLL_MS = 300;
export const WAITING_POLL_MS = 5000;
export const SLOW_RETRY_MS = 60000;
/* 重生流的快速重试（设计 §3.3）：断开即抢修，重试间隔 0＝下一拍立刻发起；上界 3 次/10 分钟压风暴
 * （数值为设计写死的计数与窗口；间隔 0 为实现选择）。 */
export const FAST_RETRY_MS = 0;
export const RAPID_RETRY_MAX = 3;
export const RAPID_RETRY_WINDOW_MS = 10 * 60 * 1000;
/* bye 帧发出后到断开之间的刷出窗口：断开前把正常退场帧交给内核缓冲，避免被销毁丢弃。 */
export const BYE_FLUSH_MS = 20;
/* 工具调用的桥侧兜底期限（防御纵深）：核心「每次 call 必回 result」之外，核心活着但该次调用无应答
 * 时 MCP 面不得无限挂起。口径＝核心侧执行安全期限（> 合法长等待上界＋余量，≈660s）＋30s 余量——
 * 桥侧必须长于核心侧，否则会抢在核心的安全期限前把仍在执行的调用误收口。 */
export const CALL_RESULT_BACKSTOP_MS = 690000;

/* 冷启入口：按本模块位置相对解析（安装树整目录拷贝 bin/src，同路径代码恒为最近一次安装版本），
 * 不依赖 PATH/CWD。 */
const CORE_ENTRY_PATH = fileURLToPath(new URL('../../bin/waystation-core.js', import.meta.url));
/* 安装树根（换代判定的目标版本读数基准）：同样按模块位置上溯——用 cwd 或桥内记忆会重现
 * 「桥内存新、磁盘旧」的无终止替换环（设计 §5.1 的版本权威纪律）。 */
const APP_ROOT_PATH = fileURLToPath(new URL('../../', import.meta.url));

/**
 * @param {any} [options]
 */
export function createCoreLink(options = {}) {
  const state = buildLinkState(options);
  return {
    state: state.view,
    ensureCore: () => ensureCore(state),
    call: (tool, args) => callTool(state, tool, args),
    sendDelivered: (frame) => sendDelivered(state, frame),
    sendRegisterUpdate: (meta) => sendRegisterUpdate(state, meta),
    setPushHandler: (handler) => {
      state.pushHandler = handler;
    },
    setRegisteredHandler: (handler) => {
      state.onRegistered = handler;
    },
    /* 换代面（诊断与测试观察窗）：等待/收尾在途、台账读数、最近一次降级上报、判定基准读数面。 */
    changeoverState: () => ({
      waiting: state.changeover.waiting !== null,
      flight: state.changeover.flight !== null,
      pendingRound: state.changeover.pendingRound,
      ledger: state.changeover.ledger.view(),
      notice: state.changeover.lastNotice,
      appRoot: state.appRoot,
      targetAppVersion: state.targetAppVersion,
      ipcV: state.ipcV,
    }),
    close: () => closeLink(state),
  };
}

function buildLinkState(options) {
  assertLinkOptions(options);
  const env = options.env ?? process.env;
  return {
    dataDir: options.dataDir,
    env,
    log: options.log ?? null,
    app: options.app,
    bridgeId: options.bridgeId ?? randomUUID(),
    sessionId: options.sessionId,
    // 启动期会话元数据快照（hello 上报）；register-update 的变化由 bridge/main 的 watcher 外送
    sessionMeta: sessionMetaOf(options),
    coreEntry: options.coreEntry ?? CORE_ENTRY_PATH,
    spawnFn: options.spawn ?? spawnChild,
    sessionIdProbe: options.sessionIdProbe ?? null,
    ...changeoverSettingsOf(options),
    changeover: buildChangeoverState(),
    ...timingOf(options),
    // 心跳新鲜阈值＝核心侧判死阈值（≥3×刷新间隔且 ≥15s，lifecycle.js 的 lifecycleParams 单一权威）
    judgeMs: lifecycleParams(env).judgeMs,
    // 硬杀防护链的注入缝（测试/校准）：透传给 stop-guard 的构造参数
    guardOptions: options.guardOptions ?? null,
    onCoreRestarting: options.onCoreRestarting ?? null,
    onRegistered: options.onRegistered ?? null,
    pushHandler: null,
    client: null,
    registered: false,
    welcome: null,
    pending: new Map(),
    inFlight: null,
    retryTimer: null,
    delays: new Set(),
    spawnInfo: null,
    closed: false,
    lastFailure: null,
    rebirth: false,
    rapidAttempts: [],
    view: { registered: false, welcome: null, lastFailure: null, rebirth: false, rapidRetries: 0 },
  };
}

/* 启动期会话元数据快照：字段缺省保持 undefined（helloFrameOf 只上非 undefined 字段——
 * 非 Claude 客户端与旧测试路径不必制造空字段）。 */
function sessionMetaOf(options) {
  return {
    role: options.role,
    masterName: options.masterName,
    name: options.name,
    kind: options.kind,
    entrypoint: options.entrypoint,
    status: options.status,
    metaUpdatedAt: options.metaUpdatedAt,
  };
}

function assertLinkOptions(options) {
  if (typeof options.dataDir !== 'string' || options.dataDir === '') {
    throw new TypeError('createCoreLink 缺少 dataDir');
  }
  if (typeof options.app !== 'string' || options.app === '') {
    throw new TypeError('createCoreLink 缺少 app（hello.app 版本形态）');
  }
}

/* 换代设置的注入缝（测试/校准）：安装树根、目标版本读数、本桥 ipcV、收尾期限。 */
function changeoverSettingsOf(options) {
  return {
    appRoot: options.appRoot ?? APP_ROOT_PATH,
    targetAppVersion: options.targetAppVersion ?? null,
    ipcV: options.ipcV ?? IPC_VERSION,
    changeoverReleaseMs: options.changeoverReleaseMs,
    changeoverSettleMs: options.changeoverSettleMs,
    changeoverWaitMs: options.changeoverWaitMs,
  };
}

/* 换代子状态：台账（连续两轮截断）＋等待新核机＋replacer 收尾机＋轮次/降级留痕。 */
function buildChangeoverState() {
  return { ledger: createChangeoverLedger(), waiting: null, flight: null, replacingAt: null, pendingRound: null, replacement: null, lastNotice: null };
}

/* 换代窗口：等待新核／收尾在途，或已发 replace 而未定（收尾前的空档——标准路径抢跑冷启会造成
 * 双 spawn）；空档以上界（replacer 释放期限）封顶，过期即解禁交标准路径自愈。 */
function changeoverWindow(state) {
  if (state.changeover.waiting !== null || state.changeover.flight !== null) {
    return true;
  }
  const at = state.changeover.replacingAt;
  return at !== null && state.now() - at <= REPLACER_RELEASE_DEADLINE_MS;
}

/* 节奏与期限（测试注入缝）：等待预算 / 轮询 / 慢速与快速重试 / 单次连接与握手期限。 */
function timingOf(options) {
  return {
    now: options.now ?? Date.now,
    waitMs: options.waitMs ?? CORE_WAIT_BUDGET_MS,
    pollMs: options.pollMs ?? CORE_POLL_MS,
    waitingPollMs: options.waitingPollMs ?? WAITING_POLL_MS,
    slowRetryMs: options.slowRetryMs ?? SLOW_RETRY_MS,
    fastRetryMs: typeof options.fastRetryMs === 'number' ? options.fastRetryMs : FAST_RETRY_MS,
    callTimeoutMs: options.callTimeoutMs ?? CALL_RESULT_BACKSTOP_MS,
    connectTimeoutMs: options.connectTimeoutMs,
    handshakeTimeoutMs: options.handshakeTimeoutMs,
  };
}

function syncView(state) {
  state.view.registered = state.registered;
  state.view.welcome = state.welcome;
  state.view.lastFailure = state.lastFailure;
  state.view.rebirth = state.rebirth;
  state.view.rapidRetries = state.rapidAttempts.length;
  state.view.notice = state.changeover.lastNotice;
}

/* —— 四态判定与冷启 —— */

function ensureCore(state) {
  if (state.closed) {
    return Promise.resolve({ ok: false, kind: 'closed', message: '桥已关闭' });
  }
  if (changeoverWindow(state)) {
    // 换代窗口（等待新核／replacer 收尾在途／已发 replace 的空档）：禁止主动冷启（防与 replacer
    // 争锁、防双 spawn）——在途调用立即回报「换代中」，不自动重试（可能有副作用，设计 §5.3）。
    // 判在注册态之前：换代广播后旧连接可能仍 registered，此时的新调用不得再蹬旧核（可能挂死）
    return Promise.resolve({ ok: false, kind: 'replacing', message: INFLIGHT_MESSAGE });
  }
  if (state.registered) {
    return Promise.resolve({ ok: true });
  }
  if (state.inFlight !== null) {
    return state.inFlight;
  }
  const run = doEnsure(state)
    .catch((error) => settleFailure(state, { kind: 'unreachable', message: `核心连接失败（内部错误：${error.message}）`, retryMs: state.slowRetryMs }))
    .finally(() => {
      state.inFlight = null;
    });
  state.inFlight = run;
  return run;
}

async function doEnsure(state) {
  const budgetEnd = state.now() + state.waitMs;
  const flow = { coldStartIssued: false, budgetEnd };
  for (;;) {
    if (state.closed) {
      return settleFailure(state, { kind: 'closed', message: '桥已关闭', retryMs: null });
    }
    const step = await probeStep(state, flow);
    if (step.kind === 'ok') {
      return { ok: true };
    }
    if (step.kind === 'fail') {
      return settleFailure(state, step.failure);
    }
    if (state.now() >= budgetEnd) {
      return settleFailure(state, step.timeoutFailure ?? coldStartTimeoutFailure(state));
    }
    await delay(state, state.pollMs);
  }
}

/* 一轮探测（分类序见模块头）：判陈旧 → 冷启；pid 活而心跳停 → 硬杀防护链；starting/waiting 按窗口
 * 与判活等待；其余交连接尝试。返回 'ok'（已注册）/ 'fail'（终态失败）/ 'wait'（预算内继续轮询；
 * timeoutFailure 为预算耗尽时的收口）。 */
async function probeStep(state, flow) {
  const probe = readCoreRecord(state.dataDir);
  if (probe.missing || probe.broken) {
    return coldStartStep(state, flow);
  }
  const record = probe.record;
  if (typeof record.startupError === 'string' && record.startupError !== '') {
    return { kind: 'fail', failure: startupFailed(state, record.startupError) };
  }
  const liveness = await livenessStep(state, flow, record);
  return liveness ?? connectStep(state, record, flow);
}

/* 存活面分类：pid 死/非法＝陈旧描述符（崩溃残留，重生流的自愈入口）→ 冷启；pid 活而心跳停＝僵尸
 * → 硬杀防护链；否则交常规分类（返回 null）。 */
async function livenessStep(state, flow, record) {
  if (!pidIsAlive(record.pid)) {
    return coldStartStep(state, flow);
  }
  if (heartbeatFresh(state, record)) {
    return null;
  }
  return zombieStep(state, flow, record);
}

async function connectStep(state, record, flow) {
  const gate = classifyForWait(state, record);
  if (gate.action === 'fail') {
    return { kind: 'fail', failure: gate.failure };
  }
  if (gate.action === 'sleep') {
    return { kind: 'wait', timeoutFailure: gate.timeoutFailure };
  }
  const attempt = await connectOnce(state, record, flow);
  if (attempt.ok) {
    return { kind: 'ok' };
  }
  return attempt.fatal ? { kind: 'fail', failure: attempt.failure } : { kind: 'wait', timeoutFailure: attempt.failure };
}

/* 冷启步（每 ensureCore 轮次至多 spawn 一次）：判陈旧后的统一出口——描述符缺失/不可解析、pid 死/
 * 非法、硬杀防护链确认退场后都走这里。不可解析的陈旧锁由被冷启核心的取锁仲裁清理（对证 null 的
 * 隔离路径），桥不删不抢。 */
async function coldStartStep(state, flow) {
  if (!flow.coldStartIssued) {
    const refusal = await assertNotServiceSession(state);
    if (refusal !== null) {
      return { kind: 'fail', failure: { kind: 'service-session', message: `核心冷启被拒：${refusal}`, retryMs: state.slowRetryMs } };
    }
    flow.coldStartIssued = true;
    const issued = issueColdStart(state);
    if (!issued.ok) {
      return { kind: 'fail', failure: { kind: 'cold-start-failed', message: issued.message, retryMs: state.slowRetryMs } };
    }
  }
  return { kind: 'wait', timeoutFailure: null };
}

/* 服务上下文守卫（Windows）：Session 0 里冷启的核心，其默认命名管道 ACL 会拒绝一切用户会话桥的
 * 拨号（EPERM 锁死全场；2026-10-31 真机事故：cc-connect 服务树内的桥冷启了 Session 0 核心，
 * 交互会话全部拨不进）。服务上下文一律不冷启——等用户会话桥把核心启起来后正常附着
 * （Session 0 拨 Session 1 的管道无碍，白天长期验证）。 */
async function assertNotServiceSession(state) {
  if (process.platform !== 'win32') {
    return null;
  }
  /* 会话号在桥进程生命周期内不变：探测一次按进程记忆化（探测走一次性 powershell，反复拉起太贵）。 */
  if (state.serviceSession === undefined) {
    const probe = state.sessionIdProbe ?? defaultSessionIdProbe;
    try {
      state.serviceSession = (await probe()) === 0;
    } catch {
      state.serviceSession = false;
    }
  }
  if (!state.serviceSession) {
    return null;
  }
  return '当前环境为服务上下文（Session 0）：在此冷启的核心，其管道会拒绝用户会话桥连接（EPERM）。请先在任一用户会话中把核心启动起来（任意 Claude 会话调用任一 ws_* 工具即可触发冷启），本桥随后自动附着';
}

export function defaultSessionIdProbe() {
  return new Promise((resolve) => {
    /* 冷启极低频，一次性 powershell 探测本进程会话号；失败/超时按非服务上下文处理（不挡冷启）。 */
    const child = spawnChild('powershell.exe', [
      '-NoProfile', '-NoLogo', '-Command', `(Get-Process -Id ${process.pid}).SessionId`,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve(1);
    }, 3000);
    child.stdout?.on('data', (chunk) => { out += chunk; });
    child.once('error', () => {
      clearTimeout(timer);
      resolve(1);
    });
    child.once('exit', () => {
      clearTimeout(timer);
      const value = Number.parseInt(out.trim(), 10);
      resolve(Number.isFinite(value) ? value : 1);
    });
  });
}

/* 僵尸核心（pid 活、心跳停）：硬杀防护链（stop-guard 共享件）——链全过才冷启；校验不过＝降级上报、
 * 不冷启（宁可不杀）。会话可见面＝工具错误文案带「已尝试重启核心」（设计 §3.3）。 */
async function zombieStep(state, flow, record) {
  const conclusion = await runKillChain(state, record);
  if (conclusion === 'killed' || conclusion === 'endpoint-gone') {
    return coldStartStep(state, flow);
  }
  return { kind: 'fail', failure: zombieDegradedFailure(state, conclusion) };
}

/* 硬杀防护链（stop-guard 共享件）：僵尸核心与换代 replacer 共用；versionRejected＝「本桥以
 * hello 收到过 welcome{ok:false,code:'version'}」的实证（换代直连替换的判别器相），僵尸路径为 false。 */
async function runKillChain(state, plan) {
  try {
    const conclusion = await killGuarded({
      coreJsonPath: coreJsonPath(state.dataDir),
      endpoint: endpointFor(state.dataDir),
      pid: plan.pid,
      startedAt: plan.startedAt,
      versionRejected: plan.versionRejected === true,
      ...(state.guardOptions ?? {}),
    });
    state.log?.warn?.('硬杀防护链结论', { conclusion, pid: plan.pid });
    return conclusion;
  } catch (error) {
    state.log?.warn?.('硬杀防护链不可用（不杀、降级上报）', { reason: error?.message });
    return 'chain-error';
  }
}

const ZOMBIE_DEGRADE_REASONS = {
  'not-eligible': '判别器不通过（心跳未停）',
  'verification-failed': '复读对证或端点确认没有通过',
  'already-once': '本桥此前已对同 pid 尝试过一次硬杀（不重复杀）',
  'chain-error': '防护链不可用',
};

function zombieDegradedFailure(state, conclusion) {
  const reason = ZOMBIE_DEGRADE_REASONS[conclusion] ?? String(conclusion);
  return {
    kind: 'unreachable',
    message: `核心无应答：已尝试重启核心（硬杀防护链未通过：${reason}），后台将继续重试`,
    retryMs: state.slowRetryMs,
  };
}

/* 记录分类（pid 已判活、心跳已判新鲜）：starting 未超截止期＝等待窗口（睡眠重探，不冷启）；
 * 超期＝启动失败（不冷启——慢启动核可能仍在推进，代其冷启会引发双核竞逐）；waiting＝等待接管
 * 文案（立即回报，不等待）；其余交连接尝试。 */
function classifyForWait(state, record) {
  if (record.status === 'starting') {
    return startingGate(state, record);
  }
  if (record.status === 'waiting') {
    return { action: 'fail', failure: { kind: 'waiting', message: waitingDetailOf(record), retryMs: state.waitingPollMs } };
  }
  return { action: 'connect' };
}

function startupFailed(state, startupError) {
  return { kind: 'startup-failed', message: `核心启动失败：${startupError}`, retryMs: state.slowRetryMs };
}

function startingGate(state, record) {
  const deadline = Date.parse(record.startupDeadline ?? '');
  if (Number.isFinite(deadline) && state.now() < deadline) {
    return { action: 'sleep', timeoutFailure: { kind: 'starting', message: '核心启动中（等待超时），请稍后重试', retryMs: state.slowRetryMs } };
  }
  return { action: 'fail', failure: startupFailed(state, '超过启动截止期仍未就绪') };
}

/* 等待文案取 core.json.statusDetail（核心写入的处置指引）；缺省用设计钉死的同根旧站点指引语。 */
function waitingDetailOf(record) {
  return typeof record.statusDetail === 'string' && record.statusDetail !== ''
    ? record.statusDetail
    : '检测到同根旧版会话运行中，请先关闭它；关闭后自动接管';
}

/* 心跳新鲜判据：与核心侧取锁仲裁同式（judgeMs＝≥3×刷新间隔且 ≥15s，lifecycle.js 单一权威）；
 * heartbeatAt 不可解析时 NaN 比较为假＝不新鲜（与仲裁的 wallNow 比较同语义）。 */
function heartbeatFresh(state, record) {
  return state.now() - Date.parse(record.heartbeatAt ?? '') < state.judgeMs;
}

/* 单次连接尝试：现读记录里的 token → connect → hello → welcome。失败分类：
 * version（降级文案、终态）与 replacing/shutting-down（等待新核接续位）不参与预算内重试；
 * auth/errno/超时在预算内重试（核心可能正在完成启动或已换代重写描述符）。 */
async function connectOnce(state, record, flow) {
  const token = typeof record.token === 'string' && record.token !== '' ? record.token : null;
  if (token === null) {
    return { ok: false, fatal: false, failure: { kind: 'unreachable', message: '核心无应答：运行描述符缺少凭据（描述符可能不完整）', retryMs: state.slowRetryMs } };
  }
  const client = createClientFor(state, record, token, flow);
  try {
    const welcome = await client.connect();
    return await finalizeRegistration(state, client, welcome);
  } catch (error) {
    await client.close();
    return classifyConnectError(state, error);
  }
}

function createClientFor(state, record, token, flow) {
  const budgeted = budgetTimeouts(state, flow);
  /** @type {any} */
  let client = null;
  client = createIpcClient({
    dataDir: state.dataDir,
    hello: {
      app: state.app, v: state.ipcV, token, bridgeId: state.bridgeId, sessionId: state.sessionId, ...state.sessionMeta,
    },
    onFrame: (frame) => {
      if (state.client === client) {
        handleFrame(state, frame);
      }
    },
    onStuck: () => handleConnectionLoss(state, client),
    onClose: () => handleConnectionLoss(state, client),
    log: state.log ?? undefined,
    connectTimeoutMs: budgeted.connectTimeoutMs,
    handshakeTimeoutMs: budgeted.handshakeTimeoutMs,
  });
  return client;
}

/* 注册收口：重生流在成功注册时退出，重注册经 onRegistered 钩子外送（绑定恢复/会话状态文件重建
 * 在核心侧——本处只做触发）。 */
async function finalizeRegistration(state, client, welcome) {
  if (state.closed) {
    await client.close();
    return { ok: false, fatal: true, failure: { kind: 'closed', message: '桥已关闭', retryMs: null } };
  }
  state.client = client;
  state.registered = true;
  state.welcome = welcome;
  const reborn = state.rebirth;
  state.rebirth = false;
  state.lastFailure = null;
  state.changeover.replacingAt = null;
  state.changeover.replacement = null;
  syncView(state);
  state.onRegistered?.(welcome, { reborn });
  const stopped = noteRoundIfAny(state, { runningApp: welcome.app, ipcVBridge: state.ipcV, ipcVCore: welcome.v });
  if (stopped === false) {
    evaluateChangeover(state, welcome);
  }
  return { ok: true };
}

/* 连接与握手期限被本次等待预算钳制为硬期限：设计口径是「首个工具调用等待 ≤10s」，而连接期限 5s
 * 与握手期限 10s 叠加会越界（预算原先只在循环间隙检查）。 */
function budgetTimeouts(state, flow) {
  const remaining = Math.max(1, flow.budgetEnd - state.now());
  return {
    connectTimeoutMs: Math.min(state.connectTimeoutMs ?? IPC_CONNECT_TIMEOUT_MS, remaining),
    handshakeTimeoutMs: Math.min(state.handshakeTimeoutMs ?? IPC_HANDSHAKE_TIMEOUT_MS, remaining),
  };
}

function classifyConnectError(state, error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (code === 'replacing' || code === 'shutting-down') {
    // 换代窗口内的握手拒绝：转等待新核态（禁止主动冷启），在途调用按「换代中」文案立即回报
    enterWaiting(state, { trigger: 'replacing-refusal', replacerBridgeId: null, targetApp: null });
    return { ok: false, fatal: true, failure: { kind: 'replacing', message: INFLIGHT_MESSAGE, retryMs: state.slowRetryMs } };
  }
  if (code === 'version') {
    return versionRefusalOutcome(state, error);
  }
  const reason = code === 'auth' ? '认证未通过，描述符可能已更换' : (code === '' ? '连接失败' : code);
  return { ok: false, fatal: false, failure: { kind: 'unreachable', message: `核心无应答（${reason}）`, retryMs: state.slowRetryMs } };
}

/* —— 已注册连接：帧分发、调用表与断连收口 —— */

function handleFrame(state, frame) {
  if (frame.type === 'result') {
    settlePending(state, frame);
    return;
  }
  if (frame.type === 'push') {
    state.pushHandler?.(frame);
    return;
  }
  if (frame.type === 'core-restarting') {
    handleCoreRestarting(state, frame);
    return;
  }
  if (frame.type === 'welcome' && frame.ok === false && (frame.code === 'replacing' || frame.code === 'shutting-down')) {
    // 注册后回执（迟到的 replace 被回 code:'replacing'，或核心已进 shutting-down）：转等待新核
    enterWaiting(state, { trigger: 'replacing-refusal', replacerBridgeId: null, targetApp: null });
  }
}

/* 换代广播对全桥可见：本桥是 replacer（广播带回自身 bridgeId）→ 走收尾（等旧核退场/硬杀后
 * spawn）；其余桥 → 等待新核态。 */
function handleCoreRestarting(state, frame) {
  state.log?.warn?.('核心广播换代中', { replacer: frame.replacerBridgeId, deadlineMs: frame.deadlineMs });
  state.onCoreRestarting?.(frame);
  const targetApp = typeof frame.targetApp === 'string' ? frame.targetApp : null;
  if (frame.replacerBridgeId === state.bridgeId) {
    startReplacementForSelf(state, { targetApp });
    return;
  }
  enterWaiting(state, { trigger: 'core-restarting', replacerBridgeId: frame.replacerBridgeId ?? null, targetApp });
}

function settlePending(state, frame) {
  const entry = state.pending.get(frame.id);
  if (entry === undefined) {
    return;
  }
  state.pending.delete(frame.id);
  clearTimeout(entry.timer);
  const result = { content: frame.content };
  if (frame.isError === true) {
    result.isError = true;
  }
  entry.resolve({ ok: true, result });
}

/* 工具调用转发：在途调用带桥侧兜底期限（核心「每次 call 必回 result」之外的防御纵深——核心活着
 * 但该调用无应答时不得让 MCP 面无限挂起）。期限取核心侧安全期限（CALL_SAFETY_DEADLINE_MS≈660s，
 * routing.js）之上加 30s 余量＝CALL_RESULT_BACKSTOP_MS：期限内送达的 result 照常收口，超限按明确
 * 文案收口（桥侧必须长于核心侧，否则会抢在核心的安全期限前把仍在执行的调用误收口）。 */
async function callTool(state, tool, args) {
  const ensured = await ensureCore(state);
  if (!ensured.ok) {
    return ensured;
  }
  const id = randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!state.pending.delete(id)) {
        return;
      }
      state.log?.warn?.('工具调用超出桥侧兜底期限（按超时收口，连接不动）', { tool, timeoutMs: state.callTimeoutMs });
      resolve({ ok: false, kind: 'timeout', message: `工具调用超时（核心在 ${Math.round(state.callTimeoutMs / 1000)}s 内未回结果）——请稍后重试` });
    }, state.callTimeoutMs);
    state.pending.set(id, { resolve, timer });
    const sent = state.client?.send({ type: 'call', id, tool, args }) ?? false;
    if (!sent) {
      state.pending.delete(id);
      clearTimeout(timer);
      resolve({ ok: false, kind: 'unreachable', message: '核心连接已断开，请重试' });
    }
  });
}

function sendDelivered(state, frame) {
  const client = state.client;
  if (client === null) {
    return false;
  }
  return client.send(frame);
}

/* 会话元数据变化上报：未注册/无连接时静默丢弃（下一次 hello 仍携启动期快照）；
 * 只外送变化字段，身份与会话归属由核心按连接记录判定（帧内不认 sessionId/bridgeId）。 */
function sendRegisterUpdate(state, meta) {
  if (!state.registered || state.client === null || meta === null || typeof meta !== 'object') {
    return false;
  }
  return state.client.send({ ...meta, type: 'register-update' });
}

/* 连接断开（含卡死判定与对端关闭）：清注册态、在途调用统一收口、进重生流（判陈旧后冷启）。
 * 断开即刻重探（快速重试上界 3 次/10 分钟，其后 60s 慢速——不风暴）。 */
function handleConnectionLoss(state, client) {
  if (state.closed || state.client !== client) {
    return;
  }
  state.client = null;
  state.registered = false;
  state.welcome = null;
  state.rebirth = true;
  state.log?.warn?.('核心连接断开（重生流：判陈旧后冷启）');
  const failure = { kind: 'unreachable', message: '核心无应答或重启中，请重试', retryMs: null };
  state.lastFailure = failure;
  syncView(state);
  rejectPending(state, failure);
  scheduleRetry(state, rapidRetryDelay(state));
}

function rejectPending(state, failure) {
  for (const entry of state.pending.values()) {
    clearTimeout(entry.timer);
    entry.resolve({ ok: false, kind: failure.kind, message: failure.message });
  }
  state.pending.clear();
}

async function closeLink(state) {
  if (state.closed) {
    return;
  }
  state.closed = true;
  if (state.retryTimer !== null) {
    clearTimeout(state.retryTimer);
    state.retryTimer = null;
  }
  releaseDelays(state);
  const client = state.client;
  state.client = null;
  state.registered = false;
  state.welcome = null;
  syncView(state);
  if (client !== null) {
    client.send({ type: 'bye', reason: 'session-end' });
    await delay(state, BYE_FLUSH_MS);
    await client.close();
  }
  rejectPending(state, { kind: 'closed', message: '桥已关闭' });
}

/* —— 换代协议接线（判定/状态机/台账出自 core/changeover.js——单一权威） —— */

/* 目标版本读数：注入缝优先（测试/校准）；缺省现读安装树。读数失败＝换代判定不可得——降级，
 * 严禁以桥内存版本顶替（否则「桥内存新、磁盘旧」形成无终止替换环）。 */
function targetVersionOf(state) {
  if (typeof state.targetAppVersion === 'string' && state.targetAppVersion !== '') {
    return { ok: true, version: state.targetAppVersion };
  }
  const read = readTargetAppVersion({ appRoot: state.appRoot });
  return read.ok === true ? { ok: true, version: read.version } : { ok: false, message: `换代判定不可得：${read.message}` };
}

/* 降级上报：桥不写文件日志（stderr 唯一可见面）＋视图留痕（工具/状态可读）。 */
function reportDegrade(state, message) {
  state.changeover.lastNotice = message;
  state.log?.warn?.('换代降级上报', { message });
  syncView(state);
}

/* 轮次结果回填：一轮换代完成后的观察点。返回 true＝台账判停（no-progress/stalled），调用方
 * 不再换代（降级上报已在内部完成）。 */
function noteRoundIfAny(state, observation) {
  const round = state.changeover.pendingRound;
  if (round === null) {
    return false;
  }
  state.changeover.pendingRound = null;
  const status = state.changeover.ledger.noteRoundResult({ targetApp: round.targetApp, ...observation });
  if (status.status === 'no-progress' || status.status === 'stalled') {
    reportDegrade(state, status.message);
    return true;
  }
  return false;
}

/* 注册成功后的换代判定：welcome 是运行核心版本的权威读数（app/v）。 */
function evaluateChangeover(state, welcome) {
  const target = targetVersionOf(state);
  if (target.ok === false) {
    reportDegrade(state, target.message);
    return;
  }
  const verdict = decideChangeover({ targetApp: target.version, runningApp: welcome.app, ipcVBridge: state.ipcV, ipcVCore: welcome.v });
  if (verdict.action === 'downgrade') {
    reportDegrade(state, verdict.message);
    return;
  }
  if (verdict.action === 'replace') {
    requestReplacement(state, target.version);
  }
}

/* 发起强制换代：目标＞运行（本桥即 replacer）——发 replace 后核心广播回自身 bridgeId 时走收尾。 */
function requestReplacement(state, targetApp) {
  const admitted = state.changeover.ledger.admitReplace(targetApp);
  if (admitted.ok === false) {
    reportDegrade(state, admitted.message);
    return;
  }
  state.changeover.pendingRound = { targetApp };
  state.changeover.replacingAt = state.now();
  state.changeover.replacement = replacementSnapshotOf(state);
  const sent = state.client?.send({ type: 'replace', reason: 'version-mismatch', wantApp: targetApp }) ?? false;
  state.log?.warn?.('发起强制换代（replace 已发）', { targetApp, sent });
}

/* 版本拒绝（ipcV 不兼容）：判定方向取拒绝帧携带的核心 ipcV（ipc.js 透传为 error.coreV）。
 * 核心更高＝旧桥降级（设计行四原文文案——帧 message 只作诊断面）；核心更低＝直连替换（行五）。
 * 判定不可得（安装树读数失败／拒绝帧不带 v 的旧核）＝降级，不脑补方向。 */
function versionRefusalOutcome(state, error) {
  const target = targetVersionOf(state);
  if (target.ok === false) {
    reportDegrade(state, target.message);
    return { ok: false, fatal: true, failure: { kind: 'version', message: target.message, retryMs: null } };
  }
  const coreV = Number.isInteger(error?.coreV) ? error.coreV : null;
  if (coreV === null) {
    reportDegrade(state, '核心拒绝帧未携带 ipcV（旧核）：换代方向不可判——按降级处置');
    return { ok: false, fatal: true, failure: { kind: 'version', message: VERSION_DOWNGRADE_MESSAGE, retryMs: null } };
  }
  // 重 spawn 后再次被拒：目标＝运行（本轮 spawn 自安装树）——运行版本按目标取，交给台账判闭环
  if (noteRoundIfAny(state, { runningApp: target.version, ipcVBridge: state.ipcV, ipcVCore: coreV })) {
    return { ok: false, fatal: true, failure: { kind: 'changeover-stopped', message: state.changeover.lastNotice, retryMs: null } };
  }
  const verdict = decideChangeover({ targetApp: target.version, runningApp: null, ipcVBridge: state.ipcV, ipcVCore: coreV });
  if (verdict.action === 'downgrade') {
    reportDegrade(state, verdict.message);
    return { ok: false, fatal: true, failure: { kind: 'version', message: VERSION_DOWNGRADE_MESSAGE, retryMs: null } };
  }
  return startDirectReplacement(state, target.version);
}

/* 直连替换（行五执行路径）：旧核不会主动退场——以版本拒绝实证走硬杀防护链 → 端点确认 → spawn
 * 安装树入口 → 标准路径接续握手注册。台账先收口（预算耗尽＝no-progress → 降级上报、不 kill）；
 * 必须由台账截断的理由：stop-guard 的「同 pid 单次」闸是进程级、每桥各自记账——不跨代 pid、
 * 不跨桥；跨轮/跨桥的截断器是本台账（进程面由核心锁仲裁收敛）。 */
function startDirectReplacement(state, targetApp) {
  const admitted = state.changeover.ledger.admitReplace(targetApp);
  if (admitted.ok === false) {
    reportDegrade(state, admitted.message);
    return { ok: false, fatal: true, failure: { kind: 'changeover-stopped', message: admitted.message, retryMs: null } };
  }
  state.changeover.pendingRound = { targetApp };
  state.changeover.replacingAt = state.now();
  const plan = replacementSnapshotOf(state);
  if (plan === null) {
    // 无旧核可杀（描述符已消失）：交标准获取路径（缺失/pid 死 → 冷启）
    state.changeover.replacingAt = null;
    void ensureCore(state).catch(noop);
  } else {
    state.changeover.replacement = plan;
    startFlight(state, { pid: plan.pid, startedAt: plan.startedAt, direct: true, versionRejected: true });
  }
  return { ok: false, fatal: true, failure: { kind: 'replacing', message: INFLIGHT_MESSAGE, retryMs: state.slowRetryMs } };
}

/* replacer 自身（本桥 replace 被受理，核心开始收尾）：等旧核退场 ≤10s——到期走硬杀防护链。
 * 旧核身份取发起时的快照（核心收尾会删 core.json——现场读会读到后继者或落空，误杀面在此）。 */
function startReplacementForSelf(state, { targetApp }) {
  if (state.changeover.flight !== null) {
    return;
  }
  state.changeover.pendingRound ??= targetApp === null ? null : { targetApp };
  const plan = state.changeover.replacement;
  if (plan === null) {
    // 发起时无描述符可对证（旧核已消失）：解禁交标准获取路径（缺失/pid 死 → 冷启）
    state.changeover.replacingAt = null;
    void ensureCore(state).catch(noop);
    return;
  }
  startFlight(state, { pid: plan.pid, startedAt: plan.startedAt, direct: false, versionRejected: false });
}

/* 旧核身份快照（pid/startedAt）：发起换代时即取——核心收尾删描述符后现场已不可读。 */
function replacementSnapshotOf(state) {
  const probe = readCoreRecord(state.dataDir);
  const record = probe.record ?? null;
  return record !== null && Number.isInteger(record.pid) ? { pid: record.pid, startedAt: record.startedAt } : null;
}

function startFlight(state, plan) {
  if (state.changeover.flight !== null) {
    return; // 幂等：广播与拒绝两条来路可能同帧到达
  }
  state.changeover.flight = createReplacerFlight({
    pid: plan.pid,
    endpoint: endpointFor(state.dataDir),
    releaseMs: plan.direct === true ? 0 : state.changeoverReleaseMs,
    settleMs: state.changeoverSettleMs,
    now: state.now,
  });
  state.log?.warn?.('replacer 收尾开始（等旧核退场；超时走硬杀防护链）', { pid: plan.pid, direct: plan.direct === true });
  void runFlight(state, state.changeover.flight, plan);
}

/* 收尾序列：等退场（direct 路径首观测即硬杀）→ 硬杀防护链 → 沉降期确认端点消失才 spawn。
 * spawn 交标准获取路径（记录缺失/pid 死 → 冷启）——不在此处直接 spawn，防与标准路径双 spawn。 */
async function runFlight(state, flight, plan) {
  for (;;) {
    if (state.closed || state.changeover.flight !== flight) {
      return;
    }
    const step = flight.observe({ released: await releaseObserved(state, plan) });
    if (step.step === 'spawn') {
      return finishFlight(state, null);
    }
    if (step.step === 'await-release') {
      await delay(state, state.pollMs);
      continue;
    }
    if (step.step === 'hard-kill') {
      const after = flight.onKillResult(await runKillChain(state, plan));
      if (after.step === 'failure') {
        return finishFlight(state, after.message);
      }
      await delay(state, Math.max(0, after.untilAt - state.now()));
      continue;
    }
    const settled = flight.onSettled({ gone: await releaseObserved(state, plan) });
    return finishFlight(state, settled.step === 'spawn' ? null : settled.message);
  }
}

/* 旧核退场观测：pid 消失或端点消失（raw 占位探测——问的是「端点名还在不在」）。 */
async function releaseObserved(state, plan) {
  if (!pidIsAlive(plan.pid)) {
    return true;
  }
  return (await probeEndpointPresence(endpointFor(state.dataDir))) === 'gone';
}

/* 收尾收口：清收尾态（notice 非空＝失败降级上报）→ 标准获取路径接续（老核活着照常接回；
 * 已死/描述符缺失按陈旧判据冷启）。 */
function finishFlight(state, notice) {
  state.changeover.flight = null;
  state.changeover.replacingAt = null;
  state.changeover.replacement = null;
  if (notice !== null) {
    reportDegrade(state, notice);
  }
  void ensureCore(state).catch(noop);
}

/* 等待新核态（非 replacer 桥）：禁止主动冷启（ensureCore 等待期直接以「换代中」文案收口）；
 * 退出＝core.json 世代变化或新核 welcome；30s 截止＝换代失败收场（降级上报），随后交标准获取
 * 路径按「缺失/超期 → 冷启」接续（replacer 崩的接续点，设计 §5.2 步 6）。 */
function enterWaiting(state, { trigger, replacerBridgeId, targetApp }) {
  if (state.changeover.waiting !== null || state.closed) {
    return;
  }
  const machine = createWaitingForNewCore({ deadlineMs: state.changeoverWaitMs, now: state.now });
  const probe = readCoreRecord(state.dataDir);
  machine.enter({ trigger, replacerBridgeId, targetApp, generation: probe.record?.startedAt ?? null });
  state.changeover.waiting = machine;
  state.log?.warn?.('进入等待新核态（不冷启，等新核就绪）', { trigger, replacerBridgeId });
  void runWaitingLoop(state, machine);
}

async function runWaitingLoop(state, machine) {
  for (;;) {
    if (state.closed || state.changeover.waiting !== machine) {
      return;
    }
    const conclusion = machine.observe(readCoreRecord(state.dataDir).record ?? null);
    if (conclusion.state === 'waiting') {
      await delay(state, state.pollMs);
      continue;
    }
    state.changeover.waiting = null;
    state.changeover.replacingAt = null;
    if (conclusion.state === 'timeout') {
      reportDegrade(state, conclusion.message);
    }
    void ensureCore(state).catch(noop);
    return;
  }
}

/* —— 后台节奏（重生流快速重试 / waiting 快轮询 / 其余慢速重试）与可中断睡眠 —— */

function settleFailure(state, failure) {
  state.lastFailure = failure;
  if (failure.kind !== 'waiting') {
    state.log?.warn?.('核心不可达', { kind: failure.kind, message: failure.message });
  }
  syncView(state);
  scheduleRetry(state, retryDelayOf(state, failure));
  return { ok: false, kind: failure.kind, message: failure.message };
}

/* 重试间隔：重生流中的一般失败走快速重试（受 3 次/10 分钟上界约束）；waiting 轮询与终态各自照旧
 * （waiting 不是重生动作，不占快速额度）。 */
function retryDelayOf(state, failure) {
  if (failure.retryMs === null || !state.rebirth || failure.kind === 'waiting') {
    return failure.retryMs;
  }
  return rapidRetryDelay(state);
}

/* 快速重试窗口：时间戳滑动、成功重注册不清零——10 分钟内反复崩＝风暴，超上界转 60s 慢速，
 * 此后不再计数（每次调用都按慢速给间隔）。已有在途重试时不占额度（与 scheduleRetry 的去重口径
 * 一致——重复请求不消耗快速次数）。 */
function rapidRetryDelay(state) {
  if (state.retryTimer !== null) {
    return state.fastRetryMs;
  }
  const now = state.now();
  state.rapidAttempts = state.rapidAttempts.filter((at) => now - at < RAPID_RETRY_WINDOW_MS);
  if (state.rapidAttempts.length >= RAPID_RETRY_MAX) {
    return state.slowRetryMs;
  }
  state.rapidAttempts.push(now);
  syncView(state);
  return state.fastRetryMs;
}

/* 计时器不作 unref：单次 ensureCore 的轮询与后台重试是「活的等待」，unref 会在无其它句柄时
 * 被事件循环判为空转而中断等待；进程退出的保障是 close() 清计时器（会话结束必走此路径）。 */
function scheduleRetry(state, retryMs) {
  if (retryMs === null || state.closed || state.retryTimer !== null) {
    return;
  }
  state.retryTimer = setTimeout(() => {
    state.retryTimer = null;
    void ensureCore(state).catch(noop);
  }, retryMs);
}

/** @returns {Promise<void>} */
function delay(state, ms) {
  return new Promise((resolve) => {
    /** @type {{ timer: ReturnType<typeof setTimeout> | null, resolve: () => void }} */
    const entry = { timer: null, resolve };
    entry.timer = setTimeout(() => {
      state.delays.delete(entry);
      resolve();
    }, ms);
    state.delays.add(entry);
  });
}

function releaseDelays(state) {
  for (const entry of state.delays) {
    clearTimeout(entry.timer);
    entry.resolve();
  }
  state.delays.clear();
}

function noop() {}

/* —— 描述符读取与冷启 —— */

/* run/core.json 读取（桥对其只读）：缺失 / 不可解析与不可读共用出口；identity 可能为 null
 * （锁创建先于身份步，身份值以 welcome 应答为准）——读取方不得假设其有值。 */
function readCoreRecord(dataDir) {
  const outcome = readRecordText(dataDir);
  if (outcome.kind !== 'text') {
    return { missing: outcome.kind === 'missing', broken: outcome.kind === 'broken' };
  }
  return parseRecordText(outcome.text);
}

function readRecordText(dataDir) {
  try {
    return { kind: 'text', text: readFileSync(coreJsonPath(dataDir), 'utf8') };
  } catch (error) {
    return { kind: error.code === 'ENOENT' ? 'missing' : 'broken' };
  }
}

function parseRecordText(text) {
  try {
    const record = JSON.parse(text);
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      return { broken: true };
    }
    return { record };
  } catch {
    return { broken: true };
  }
}

/* 冷启 spawn（设计 §3.1-3/4）：detached＋windowsHide＋stdio ignore＋unref；入口按模块位置相对解析；
 * 环境显式剔除会话私有变量（核心不该看到会话凭据），数据根等其余变量原样继承。 */
function issueColdStart(state) {
  const childEnv = {};
  for (const [key, value] of Object.entries(state.env)) {
    if (!key.startsWith('CLAUDE_CODE_')) {
      childEnv[key] = value;
    }
  }
  try {
    const child = state.spawnFn(process.execPath, [state.coreEntry], { detached: true, windowsHide: true, stdio: 'ignore', env: childEnv });
    const info = { exitCode: null, spawnError: null };
    state.spawnInfo = info;
    child.once?.('error', (error) => {
      info.spawnError = error;
    });
    child.once?.('exit', (code) => {
      info.exitCode = code;
    });
    child.unref?.();
    return { ok: true };
  } catch (error) {
    return { ok: false, message: `核心冷启失败：无法启动核心进程（${error.code ?? error.message}）` };
  }
}

/* 冷启超时的失败归因：原因优先取 core.json.startupError；其次 spawn errno；
 * run/ 不可写时 startupError 也写不进——如实退化到退出码，最后才是超时本身。 */
function coldStartTimeoutFailure(state) {
  const probe = readCoreRecord(state.dataDir);
  const startupError = probe.record?.startupError;
  if (typeof startupError === 'string' && startupError !== '') {
    return { kind: 'startup-failed', message: `核心启动失败：${startupError}`, retryMs: state.slowRetryMs };
  }
  const info = state.spawnInfo;
  if (info !== null && info.spawnError !== null) {
    return { kind: 'cold-start-failed', message: `核心冷启失败：无法启动核心进程（${info.spawnError.code ?? info.spawnError.message}）`, retryMs: state.slowRetryMs };
  }
  if (info !== null && info.exitCode !== null) {
    return { kind: 'cold-start-failed', message: `核心启动失败：核心进程已退出（退出码 ${info.exitCode}）——原因不可得（run/ 不可写时 startupError 也写不进）`, retryMs: state.slowRetryMs };
  }
  return { kind: 'cold-start-failed', message: `核心启动失败：启动超时（${Math.round(state.waitMs / 1000)} 秒内未就绪）`, retryMs: state.slowRetryMs };
}
