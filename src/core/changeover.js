import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/* 换代协议（设计 §5 全协议：五行判定、首个 replace 仲裁、等待新核、replacer 收尾、no-progress）
 * ——核心与桥共同消费的单一权威：五行判定表与等待新核状态机集中于此，消费方（lifecycle/main
 * 的接线、ipc-client 的接线）只做帧收发、进程探测与定时器驱动。
 * 版本权威＝安装树（写死）：换代判定比较「将 spawn 的目标版本」（读 <app>/package.json）与
 * 「运行核心版本」（welcome.app），不比桥自身内存版本——否则「桥内存新、磁盘旧」会形成无终止的
 * 替换环。ipcV 不随 app 自动递增（人工 +1，纪律进编码规范）。
 * 模块边界：除版本读取原语外不碰 IO；硬杀防护链（stop-guard）与端点/pid 观测由消费方注入。 */

/* —— 数值（设计 §5 钉死；消费方以构造参数注入，非文档面配置） —— */

/* 等待新核截止期（§5.3）：超时＝换代失败收场（降级上报，不周期重试换代）。 */
export const WAITING_DEADLINE_MS = 30_000;
/* replacer 等旧核释放端点/退场的窗口（§5.2 步 4）：到期未退场走硬杀防护链。 */
export const REPLACER_RELEASE_DEADLINE_MS = 10_000;
/* 硬杀之后的沉降期（§5.2 步 4）：仍不消失＝换代失败。 */
export const REPLACER_SETTLE_MS = 2000;
/* no-progress 终止轮次（§5.2 步 7）：连续两轮换代后仍未达目标即停止。 */
export const NO_PROGRESS_ROUNDS = 2;

/* —— 文案（设计钉死的两句原文＋本模块定的帧文案） —— */

/* 换代期在途调用的回执文案（§5.3）：不自动重试（可能有副作用）。 */
export const INFLIGHT_MESSAGE = '核心换代中（约数秒），请重试；数据未丢';
/* 旧桥遇新核的降级文案（§5.1 行四）：不半懂运行。 */
export const VERSION_DOWNGRADE_MESSAGE = '驿站已升级，请重开会话加载新版本';
/* shutting-down 期 replace 回执与握手回执的文案（帧表要求 message 必填，文案本模块定）。 */
export const REPLACING_MESSAGE = '核心正在换代，请等待新核就绪';

/* app 版本形态：与 IPC 帧校验同形态（三段数字＋可选预发布后缀）——换代判定的读数来自
 * package.json，两处形态变更须同步（帧校验在 ipc.js）。 */
const APP_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/* —— 版本读取与比较（基准＝安装树） —— */

/**
 * 读安装树目标版本（版本权威＝安装树，设计 §5.1）：解析 <appRoot>/package.json 的 version。
 * 读数失败不抛——结论对象承载（调用方按「换代判定不可得」降级；严禁以桥内存版本顶替）。
 * @param {{ appRoot: string, readFile?: (path: string, encoding: 'utf8') => string }} options
 * @returns {{ ok: true, version: string } | { ok: false, reason: 'unreadable' | 'broken', message: string }}
 */
export function readTargetAppVersion({ appRoot, readFile = readFileSync }) {
  if (typeof appRoot !== 'string' || appRoot === '') {
    throw new TypeError('readTargetAppVersion 缺少 appRoot');
  }
  const path = join(appRoot, 'package.json');
  const read = tryReadText(path, readFile);
  if (read.ok === false) {
    return { ok: false, reason: 'unreadable', message: `安装树版本不可读：${path}（${read.detail}）` };
  }
  const version = versionFieldOf(read.text);
  if (version === null) {
    return { ok: false, reason: 'broken', message: `安装树版本不可用（JSON 坏或 version 形态非法）：${path}` };
  }
  return { ok: true, version };
}

/* 文件读取失败只返回结论（不抛）：分级由调用方按 errno/形态给出。 */
function tryReadText(path, readFile) {
  try {
    return { ok: true, text: readFile(path, 'utf8') };
  } catch (error) {
    return { ok: false, detail: error.code ?? error.message };
  }
}

function versionFieldOf(text) {
  try {
    const meta = JSON.parse(text);
    const version = meta !== null && typeof meta === 'object' && !Array.isArray(meta) ? meta.version : undefined;
    return typeof version === 'string' && APP_VERSION_PATTERN.test(version) ? version : null;
  } catch {
    return null;
  }
}

/**
 * 版本先后（-1/0/1）：三段数字逐一比较；三段相同则发行版＞预发布，两个预发布按字典序——
 * 本判定只服务「目标 vs 运行」的先后，不做完整 semver 标识符比较（预发布后缀在 0.x 开发期
 * 使用，比较精度不承重）。
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareAppVersions(a, b) {
  const left = splitAppVersion(a);
  const right = splitAppVersion(b);
  if (left === null) {
    throw new TypeError(`版本形态非法：${String(a)}`);
  }
  if (right === null) {
    throw new TypeError(`版本形态非法：${String(b)}`);
  }
  for (let index = 0; index < left.numbers.length; index++) {
    if (left.numbers[index] !== right.numbers[index]) {
      return left.numbers[index] < right.numbers[index] ? -1 : 1;
    }
  }
  return comparePreRelease(left.pre, right.pre);
}

function splitAppVersion(version) {
  if (typeof version !== 'string' || !APP_VERSION_PATTERN.test(version)) {
    return null;
  }
  const dash = version.indexOf('-');
  const core = dash === -1 ? version : version.slice(0, dash);
  return { numbers: core.split('.').map(Number), pre: dash === -1 ? null : version.slice(dash + 1) };
}

function comparePreRelease(left, right) {
  if (left === right) {
    return 0;
  }
  if (left === null) {
    return 1;
  }
  if (right === null) {
    return -1;
  }
  return left < right ? -1 : 1;
}

/* —— 五行判定（设计 §5.1，写死） —— */

/**
 * 五行判定：入参即判定基准（安装树目标版本、运行核心版本、双侧 ipcV）——桥内存版本不参与，
 * 「桥内存新、磁盘旧」因此不构成替换环。结论动作：service＝直接服务（行一/行三，行三另立
 * 判词表达「装回旧版即终止」）；replace＝桥发起强制换代（行二/行五）；downgrade＝旧桥降级文案
 * （行四；核心侧同判由 IPC 层的 welcome 拒绝承担）。
 * ipcV 相同时才消费 runningApp（welcome.app）；ipcV 不同时不消费（行四/行五只看方向，方向取自
 * 版本拒绝帧携的核心 ipcV——拒绝路径没有 welcome，runningApp 传 null 即可）。
 * @param {{ targetApp: string, runningApp: string | null, ipcVBridge: number, ipcVCore: number }} input
 * @returns {{ action: 'serve' | 'replace' | 'downgrade', verdict: string, message?: string }}
 */
export function decideChangeover({ targetApp, runningApp, ipcVBridge, ipcVCore }) {
  assertIpcVersion(ipcVBridge, 'ipcVBridge');
  assertIpcVersion(ipcVCore, 'ipcVCore');
  if (ipcVBridge === ipcVCore) {
    return sameProtocolVerdict(targetApp, runningApp);
  }
  if (ipcVCore > ipcVBridge) {
    return { action: 'downgrade', verdict: 'bridge-outdated', message: VERSION_DOWNGRADE_MESSAGE };
  }
  return { action: 'replace', verdict: 'core-outdated' };
}

/** @returns {{ action: 'serve' | 'replace', verdict: string }} */
function sameProtocolVerdict(targetApp, runningApp) {
  const order = compareAppVersions(targetApp, runningApp);
  if (order === 0) {
    return { action: 'serve', verdict: 'same-version' };
  }
  if (order > 0) {
    return { action: 'replace', verdict: 'target-newer' };
  }
  return { action: 'serve', verdict: 'target-older' };
}

function assertIpcVersion(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`decideChangeover 的 ${label} 须为正整数`);
  }
}

/* —— 核心侧：首个 replace 仲裁（设计 §5.2 步 2，写死） —— */

/**
 * 首个 replace 仲裁（仲裁上收核心，无桥侧锁）：首个 replace 定 replacer 并进 shutting-down，
 * 此后一律回 {ok:false, code:'replacing'}。回执形态＝welcome 拒绝帧——帧表中唯一带 ok/code 的
 * 回执形态（帧契约本模块不改）。判决后由消费方执行：广播 core-restarting、有序收尾（等待面按
 * 既有 closeService 语义中止）。replace 帧已过 IPC 层校验（reason 词表、wantApp 必填性在彼处）。
 * @param {{ deadlineMs?: number, now?: () => number }} [options]
 * @returns {any}
 */
export function createReplaceArbiter({ deadlineMs = REPLACER_RELEASE_DEADLINE_MS, now = Date.now } = {}) {
  /** @type {{ phase: string, replacer: any }} */
  const state = { phase: 'serving', replacer: null };
  return {
    phase: () => state.phase,
    replacer: () => (state.replacer === null ? null : { ...state.replacer }),
    /** shutting-down 期的握手回执（welcome{ok:false,code:'replacing'}）；服务期无此回执（null）。 */
    refusalFrame: () => (state.phase === 'shutting-down' ? replacingRefusalFrame() : null),
    /** 首个 replace → {ok:true, broadcast}；其后 → {ok:false, frame}（code:'replacing'）。 */
    onReplace: (frame) => admitReplace(state, frame, deadlineMs, now),
  };
}

/** @returns {any} */
function admitReplace(state, frame, deadlineMs, now) {
  if (state.phase === 'shutting-down') {
    return { ok: false, frame: replacingRefusalFrame() };
  }
  const bridgeId = typeof frame?.bridgeId === 'string' ? frame.bridgeId : '';
  if (bridgeId === '') {
    throw new TypeError('replace 缺少发起桥标识（bridgeId）');
  }
  const targetApp = typeof frame.wantApp === 'string' && frame.wantApp !== '' ? frame.wantApp : null;
  state.phase = 'shutting-down';
  state.replacer = { bridgeId, reason: frame.reason, targetApp, at: now() };
  return { ok: true, broadcast: coreRestartingFrame({ reason: frame.reason, replacerBridgeId: bridgeId, targetApp, deadlineMs }) };
}

/* targetApp 为 manual 停止（CLI 通道）时不带——帧字段可选。 */
function coreRestartingFrame({ reason, replacerBridgeId, targetApp, deadlineMs }) {
  const frame = { type: 'core-restarting', reason, replacerBridgeId, deadlineMs };
  if (targetApp !== null) {
    frame.targetApp = targetApp;
  }
  return frame;
}

function replacingRefusalFrame() {
  return { type: 'welcome', ok: false, code: 'replacing', message: REPLACING_MESSAGE };
}

/* —— 桥侧：等待新核状态机（设计 §5.3，写死） —— */

const WAITING_TRIGGERS = ['core-restarting', 'replacing-refusal'];

/**
 * 等待新核状态机：进入＝收到 core-restarting 广播或被回 code:'replacing'；退出＝core.json 世代
 * （startedAt）变化或新核 welcome；截止期超时＝换代失败收场（降级上报、不周期重试换代——终态
 * 保持）。等待期间禁止主动冷启（coldStartAllowed 恒 false，防与 replacer 争锁）；超时后交标准
 * 获取路径按「core.json 缺失/超期 → 冷启」接续（replacer 崩的接续点，§5.2 步 6）。
 * 广播对全桥可见：replacer 自身收广播时不进等待态（接线以 replacerBridgeId 与自身 bridgeId
 * 比对区分）——本状态机只管等待方。
 * @param {{ deadlineMs?: number, now?: () => number }} [options]
 * @returns {any}
 */
export function createWaitingForNewCore({ deadlineMs = WAITING_DEADLINE_MS, now = Date.now } = {}) {
  const state = { phase: 'idle', trigger: null, replacerBridgeId: null, targetApp: null, baseline: null, deadlineMs, deadlineAt: 0, record: null };
  return {
    view: () => ({ ...state }),
    enter: (options) => enterWaiting(state, options, now),
    /** @param {any} record 当前 core.json 记录（缺失＝null）。 */
    observe: (record) => {
      if (state.phase === 'idle') {
        throw new Error('等待新核状态机未进入（先调 enter）');
      }
      state.record = record ?? null;
      if (state.phase === 'waiting') {
        advanceWaiting(state, now);
      }
      return waitingConclusion(state);
    },
    onWelcome: () => {
      state.phase = 'registered';
      return waitingConclusion(state);
    },
  };
}

/**
 * @param {any} state
 * @param {{ trigger: string, replacerBridgeId?: string | null, targetApp?: string | null, generation?: string | null }} options
 * @param {() => number} now
 */
function enterWaiting(state, { trigger, replacerBridgeId = null, targetApp = null, generation = null }, now) {
  if (!WAITING_TRIGGERS.includes(trigger)) {
    throw new TypeError(`等待新核的进入触发须为 ${WAITING_TRIGGERS.join('/')}`);
  }
  if (state.phase !== 'idle') {
    // 终态不复活（「不周期重试换代」的机内保证）：新一轮换代应新建实例
    throw new Error(`等待新核状态机已进入（当前阶段 ${state.phase}）——新一轮换代请新建实例`);
  }
  state.phase = 'waiting';
  state.trigger = trigger;
  state.replacerBridgeId = replacerBridgeId;
  state.targetApp = targetApp;
  state.baseline = generation;
  state.deadlineAt = now() + state.deadlineMs;
  state.record = null;
  return waitingConclusion(state);
}

function advanceWaiting(state, now) {
  const generation = generationOf(state.record);
  if (generation !== null && generation !== state.baseline) {
    state.phase = 'new-core';
    return;
  }
  if (now() >= state.deadlineAt) {
    state.phase = 'timeout';
  }
}

function generationOf(record) {
  return record !== null && typeof record === 'object' && typeof record.startedAt === 'string' ? record.startedAt : null;
}

/* 结论形态：coldStartAllowed 只表达「等待期禁止主动冷启」这一条不变量；超时＝等待态解除，
 * 冷启与否交标准获取路径按 core.json 缺失/超期判定（§5.2 步 6 的接续点）。 */
function waitingConclusion(state) {
  const conclusion = { state: state.phase, record: state.record, coldStartAllowed: state.phase === 'timeout' };
  if (state.phase === 'timeout') {
    const seconds = Math.round(state.deadlineMs / 1000);
    conclusion.message = `核心换代等待超时（${seconds} 秒内未见到新核心）；已按换代失败收场，不再自动重试换代`;
  }
  return conclusion;
}

/* —— 桥侧 replacer：收尾序列（设计 §5.2 步 4） —— */

/**
 * replacer 收尾序列：等旧核释放端点/退场 ≤releaseMs → 到期走硬杀防护链（stop-guard.js 的
 * killGuarded——killed/endpoint-gone 进沉降复核，verification-failed/not-eligible/already-once
 * ＝宁可不杀、直接降级）→ 再等 settleMs 沉降 → 确认端点消失才 spawn（防护链步③）；仍不消失＝
 * 换代失败降级（文案含 pid 与端点）。观测（端点反证/pid 活性）与硬杀调用由消费方接线注入。
 * 两条入口共用本序列：①replace 已受理（旧核答应收尾，等它主动退场＝缺省 releaseMs）；
 * ②直连替换（ipcV 不兼容、旧核不会主动退场——以版本拒绝实证走硬杀）传 releaseMs: 0，
 * 首次 observe 即进 hard-kill 阶段。
 * @param {{ pid: number, endpoint?: string | null, releaseMs?: number, settleMs?: number, now?: () => number }} options
 * @returns {any}
 */
export function createReplacerFlight(options) {
  const { pid, endpoint = null, releaseMs = REPLACER_RELEASE_DEADLINE_MS, settleMs = REPLACER_SETTLE_MS, now = Date.now } = options;
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new TypeError('createReplacerFlight 缺少旧核 pid');
  }
  const state = { phase: 'release-wait', deadlineAt: now() + releaseMs, settleAt: 0 };
  const context = { pid, endpoint, settleMs };
  return {
    phase: () => state.phase,
    /** observed.released＝旧核已退场（端点释放或 pid 消失，接线判据）。 */
    observe: (observed) => observeRelease(state, context, observed ?? {}, now),
    /** conclusion 取 stop-guard.js killGuarded 的结论枚举。 */
    onKillResult: (conclusion) => applyKillResult(state, context, conclusion, now),
    /** settled.gone＝端点消失的复核结果（防护链步③）。 */
    onSettled: (settled) => applySettled(state, context, settled ?? {}),
  };
}

function observeRelease(state, context, { released }, now) {
  if (state.phase !== 'release-wait') {
    return { step: state.phase };
  }
  if (released === true) {
    state.phase = 'spawn';
    return { step: 'spawn' };
  }
  if (now() >= state.deadlineAt) {
    state.phase = 'hard-kill';
    return { step: 'hard-kill', pid: context.pid, endpoint: context.endpoint };
  }
  return { step: 'await-release', deadlineAt: state.deadlineAt };
}

function applyKillResult(state, context, conclusion, now) {
  if (state.phase !== 'hard-kill') {
    return { step: state.phase };
  }
  if (conclusion === 'killed' || conclusion === 'endpoint-gone') {
    state.phase = 'settle';
    state.settleAt = now() + context.settleMs;
    return { step: 'settle', untilAt: state.settleAt };
  }
  state.phase = 'failure';
  return { step: 'failure', message: killRefusedMessage(context, conclusion) };
}

function applySettled(state, context, { gone }) {
  if (state.phase !== 'settle') {
    return { step: state.phase };
  }
  if (gone === true) {
    state.phase = 'spawn';
    return { step: 'spawn' };
  }
  state.phase = 'failure';
  return { step: 'failure', message: changeoverFailureMessage(context) };
}

function endpointSuffix({ endpoint }) {
  return typeof endpoint === 'string' && endpoint !== '' ? `，端点 ${endpoint}` : '';
}

function changeoverFailureMessage(context) {
  return `核心换代失败（pid ${context.pid} 未退出${endpointSuffix(context)}）；请人工处置（旧核继续服务或全机不可用）`;
}

function killRefusedMessage(context, conclusion) {
  return `核心换代失败：硬杀防护链未通过（${conclusion}），未杀旧核（pid ${context.pid}${endpointSuffix(context)}）；请人工处置`;
}

/* —— 桥侧：no-progress 轮次台账（设计 §5.2 步 7；计数存储选型＝桥侧内存台账，登记于报告） —— */

/**
 * no-progress 轮次台账：连续两轮换代后运行核心仍未达目标 → 停止＋降级上报（admitReplace 收口
 * 第三轮）；目标达到或目标版本变化即复位。降级方向闭环（§5.1 行五）：重 spawn 后「目标＝运行
 * 且 ipcV 仍不兼容」→ 判停（不再换代）。台账随桥进程存在——截断的是「同一桥的换代自激循环」；
 * 跨会话清零属人为重开（边界登记于报告）。
 * @param {{ maxRounds?: number }} [options]
 * @returns {any}
 */
export function createChangeoverLedger({ maxRounds = NO_PROGRESS_ROUNDS } = {}) {
  const state = { target: null, rounds: 0, stopped: false, stopReason: null };
  return {
    view: () => ({ ...state }),
    admitReplace: (targetApp) => admitRound(state, targetApp, maxRounds),
    noteRoundResult: (observation) => noteResult(state, observation, maxRounds),
  };
}

function admitRound(state, targetApp, maxRounds) {
  if (typeof targetApp !== 'string' || targetApp === '') {
    throw new TypeError('admitReplace 缺少目标版本');
  }
  resetForTarget(state, targetApp);
  if (state.stopped || state.rounds >= maxRounds) {
    stopLedger(state, state.stopReason ?? 'no-progress');
    // 拒绝文案随停因分流：stalled（协议不兼容闭环）与 no-progress（轮次耗尽）各有其说
    return { ok: false, reason: 'no-progress', message: state.stopReason === 'stalled' ? stalledMessage(targetApp) : noProgressMessage(targetApp) };
  }
  state.rounds += 1;
  return { ok: true, round: state.rounds };
}

function noteResult(state, { targetApp, runningApp, ipcVBridge, ipcVCore }, maxRounds) {
  resetForTarget(state, targetApp);
  if (compareAppVersions(runningApp, targetApp) < 0) {
    if (state.rounds < maxRounds) {
      return { status: 'retry' };
    }
    stopLedger(state, 'no-progress');
    return { status: 'no-progress', message: noProgressMessage(targetApp, runningApp) };
  }
  if (ipcVBridge === ipcVCore) {
    // 目标达到＝本轮结束：轮次与停因一并归零（「连续两轮」口径＝连续失败）
    state.rounds = 0;
    state.stopped = false;
    state.stopReason = null;
    return { status: 'reached' };
  }
  if (state.rounds === 0) {
    return { status: 'retry' };
  }
  stopLedger(state, 'stalled');
  return { status: 'stalled', message: stalledMessage(targetApp) };
}

function stopLedger(state, reason) {
  state.stopped = true;
  state.stopReason = reason;
}

function resetForTarget(state, targetApp) {
  if (targetApp !== state.target) {
    state.target = targetApp;
    state.rounds = 0;
    state.stopped = false;
    state.stopReason = null;
  }
}

function noProgressMessage(targetApp, runningApp = null) {
  const detail = runningApp === null ? `目标 ${targetApp}` : `运行 ${runningApp}，目标 ${targetApp}`;
  return `连续两轮换代后运行核心版本仍未达目标（${detail}）；停止换代，请人工处置`;
}

function stalledMessage(targetApp) {
  return `换代无法达成协议兼容（目标＝运行＝${targetApp}，ipcV 仍不兼容）；停止换代，请重开会话加载新版本或人工处置`;
}
