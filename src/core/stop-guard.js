import net from 'node:net';
import { lifecycleParams, pidIsAlive, readCoreRecord, sameProcessRecord } from './lifecycle.js';

/* 硬杀防护链（设计 §2.6，写死）：对「进程活、事件循环卡死」的核心执行硬杀前的唯一入口。
 * 链序：①判别器（自动落链须自有证据：core.json 超期／心跳停；显式授权或 IPC 版本拒绝实证放开该
 * 证据要求，但慢启动窗口都不越——排除慢启动误杀）→②杀前复读 core.json 与判定时对证
 * （pid/startedAt，防杀继任者）→③杀后确认端点消失（才允许冷启）→④本进程对同一 pid 仅单次
 * （记在真正发出终止信号时）→⑤校验不过→不杀、降级上报（宁可不杀）。
 *
 * 消费方与用法（契约稳定，门面文案由消费方映射）：
 * - 桥监督（src/bridge/ipc-client.js）：僵尸判定后按运行描述符的 pid/startedAt 调用；allowOnce 缺省
 *   （自动落链）；killed／endpoint-gone 才冷启，其余降级上报。
 * - CLI（src/core-cli.js 的 core stop／--force）：凭运行描述符对证后调用；--force 与「清数据面对
 *   等待核的授权」映射为 allowOnce:true（显式授权不必再等心跳超期，但慢启动窗口与其余各关照走）。
 * - 换代（replacer 直连替换）：以本桥 hello 收到 welcome{ok:false,code:'version'} 的实证映射为
 *   versionRejected:true——对端自证为版本不兼容的驿站核心；复读对证、端点确认与单次闸照走。
 *
 * 返回结论（字符串枚举）：
 * - killed：终止信号已发且端点确认消失——可冷启／视为已停；
 * - endpoint-gone：进程已不在（含发信号时才发现已退出的竞态）且端点已消失——可冷启／视为已停；
 * - verification-failed：任一校验环节未过（描述符缺失而端点仍在／不可解析／内容已变／杀后端点仍在）
 *   ——不杀、降级上报；
 * - not-eligible：判别器不过（自动落链无自有证据，或显式授权仍处慢启动窗口）——不杀；
 * - already-once：本进程此前已对同 pid 发出过一次终止信号——不重复杀。
 *
 * 残余风险（设计 §2.6 如实登记）：pid 复用窗口只被复读对证与端点确认收窄、未消除（同机同用户信任
 * 边界内的已知窄窗）；端点归属无法在进程面核验（IPC 层拿不到对端进程凭据——回落登记），继任者占用
 * 同一端点的情形由「复读对证 + 杀后确认」拦下，仍余毫秒级竞窗。 */

export const KILL_CONFIRM_MS = 5000;           // 杀后端点消失确认窗口（设计只钉「确认后才冷启」，数值实现期校准）
export const KILL_CONFIRM_POLL_MS = 100;       // 确认轮询间隔
export const ENDPOINT_PROBE_TIMEOUT_MS = 500;  // 端点占位探测期限（本机管道/套接字连接为毫秒级）

/* 单次闸（④）：进程级记账——桥＝一进程，天然落实「每桥对同 pid 仅单次」；CLI 每次调用是新进程，
 * 天然单次。只记「真正发出过终止信号」的 pid：校验不过而未杀的不占额，避免把「宁可不杀」的
 * 拒绝固化成永久拒绝。 */
const killedPids = new Set();

/**
 * @param {{ coreJsonPath: string, endpoint: string, pid: number, startedAt: string,
 *   allowOnce?: boolean, versionRejected?: boolean,
 *   env?: Record<string, string | undefined>, now?: () => number,
 *   probe?: (endpoint: string) => Promise<'open' | 'gone'>, probeTimeoutMs?: number,
 *   kill?: (pid: number, signal: string) => void, signal?: string,
 *   sleep?: (ms: number) => Promise<void>, confirmMs?: number, confirmPollMs?: number }} options
 * @returns {Promise<'killed' | 'endpoint-gone' | 'verification-failed' | 'not-eligible' | 'already-once'>}
 */
export async function killGuarded(options) {
  const params = guardParams(options);
  if (killedPids.has(params.pid)) {
    return 'already-once';
  }
  return runVerifiedChain(params);
}

async function runVerifiedChain(params) {
  const read = readCoreRecord(params.coreJsonPath);
  if (!read.ok) {
    return unverifiableOutcome(params, read.reason);
  }
  if (!sameProcessRecord({ pid: params.pid, startedAt: params.startedAt }, read.record)) {
    return 'verification-failed';
  }
  if (!eligible(params, read.record)) {
    return 'not-eligible';
  }
  return killPhase(params);
}

/* 描述符缺失/不可解析的收口：缺失且端点已消失＝本就已退场（允许冷启的一侧）；端点仍在＝无锁可
 * 对证（不杀）；不可解析＝对证无法成立（不杀）。 */
async function unverifiableOutcome(params, reason) {
  if (reason !== 'missing') {
    return 'verification-failed';
  }
  return noKillOutcome(params);
}

async function killPhase(params) {
  if (!pidIsAlive(params.pid)) {
    return noKillOutcome(params);
  }
  const signal = sendTermination(params);
  if (signal === 'gone') {
    return noKillOutcome(params);
  }
  if (signal === 'failed') {
    return 'verification-failed';
  }
  return (await waitEndpointGone(params)) ? 'killed' : 'verification-failed';
}

function guardParams(options) {
  const fields = guardFieldsOf(options);
  return {
    ...fields,
    allowOnce: options.allowOnce === true,
    versionRejected: options.versionRejected === true,
    judgeMs: lifecycleParams(options.env ?? process.env).judgeMs,
    now: pickFunction(options.now, Date.now),
    probe: pickFunction(options.probe, (target) => probeEndpointPresence(target, options.probeTimeoutMs)),
    kill: pickFunction(options.kill, (target, signal) => process.kill(target, signal)),
    sleep: pickFunction(options.sleep, delayFor),
    confirmMs: pickInteger(options.confirmMs, KILL_CONFIRM_MS),
    confirmPollMs: pickInteger(options.confirmPollMs, KILL_CONFIRM_POLL_MS),
    signal: pickText(options.signal, 'SIGKILL'),
  };
}

function guardFieldsOf(options) {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('killGuarded 缺少入参');
  }
  requireText(options.coreJsonPath, 'killGuarded 缺少 coreJsonPath');
  requireText(options.endpoint, 'killGuarded 缺少 endpoint');
  requireText(options.startedAt, 'killGuarded 缺少 startedAt（对证字段）');
  if (!Number.isInteger(options.pid) || options.pid <= 0) {
    throw new TypeError('killGuarded 缺少合法 pid（正整数）');
  }
  return { coreJsonPath: options.coreJsonPath, endpoint: options.endpoint, pid: options.pid, startedAt: options.startedAt };
}

function requireText(value, message) {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(message);
  }
}

function pickFunction(value, fallback) {
  return typeof value === 'function' ? value : fallback;
}

function pickInteger(value, fallback) {
  return Number.isInteger(value) ? value : fallback;
}

function pickText(value, fallback) {
  return typeof value === 'string' && value !== '' ? value : fallback;
}

function delayFor(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ①判别器：心跳鲜度与启动截止期判据与核心取锁仲裁（`lifecycle.createArbiter` 的判死面）同式——
 * heartbeatAt 不可解析＝不新鲜（墙钟比较的 NaN 语义）。三支：自动落链须自有证据（超期/心跳停）；
 * 显式授权（allowOnce）或 IPC 版本拒绝实证（versionRejected）放开证据要求。共同例外＝慢启动窗口
 * （starting 且心跳新鲜、截止期未过）一律不越——「排除慢启动误杀」是判别器的第一要义（宁可不杀）。 */
function eligible(params, record) {
  const beatFresh = heartbeatFresh(params, record);
  const overdue = startupOverdue(params, record);
  if (record.status === 'starting' && beatFresh && !overdue) {
    return false;
  }
  return params.allowOnce || params.versionRejected || !beatFresh || overdue;
}

function heartbeatFresh(params, record) {
  return params.now() - Date.parse(record.heartbeatAt ?? '') < params.judgeMs;
}

function startupOverdue(params, record) {
  return record.status === 'starting' && Date.parse(record.startupDeadline ?? '') <= params.now();
}

/* ③不杀路径的收口：端点消失＝已退场（可冷启）；端点仍在＝归属不可证（不冷启）。 */
async function noKillOutcome(params) {
  return (await probeSafely(params)) === 'gone' ? 'endpoint-gone' : 'verification-failed';
}

/* 终止信号失败归因：ESRCH＝进程已不在（转端点核实）；EPERM 等其余错误＝宁可不杀。 */
function sendTermination(params) {
  try {
    params.kill(params.pid, params.signal);
    killedPids.add(params.pid);
    return 'signalled';
  } catch (error) {
    return error?.code === 'ESRCH' ? 'gone' : 'failed';
  }
}

async function waitEndpointGone(params) {
  const deadline = params.now() + params.confirmMs;
  for (;;) {
    if ((await probeSafely(params)) === 'gone') {
      return true;
    }
    if (params.now() >= deadline) {
      return false;
    }
    await params.sleep(params.confirmPollMs);
  }
}

/* 探测未完成（抛错）按「仍在」保守处置——「宁可不杀」的一侧。 */
async function probeSafely(params) {
  try {
    return await params.probe(params.endpoint);
  } catch {
    return 'open';
  }
}

/* 端点占位探测：本处问的是「端点名还在不在」，不是「核心在不在服务」——故不走应用层往返
 * （卡死核的内核侧排队会让应用层探测得到「不可达」，与「端点已消失」混淆）。连接未决按「仍在」
 * 保守处置。 */
export function probeEndpointPresence(endpoint, timeoutMs = ENDPOINT_PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    /** @type {any} */
    let socket = null;
    const finish = (outcome) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket?.destroy?.();
      resolve(outcome);
    };
    const timer = setTimeout(() => finish('open'), timeoutMs);
    try {
      socket = net.connect(endpoint);
    } catch {
      finish('open');
      return;
    }
    socket.on('connect', () => finish('open'));
    socket.on('error', () => finish('gone'));
  });
}
