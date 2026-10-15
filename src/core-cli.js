import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { coreJsonPath, resolveDataDir } from './paths.js';
import { createIpcClient } from './core/ipc.js';
import { lifecycleParams, pidIsAlive, readCoreRecord, sameProcessRecord, testNumber } from './core/lifecycle.js';

/* `waystation core` 子命令（设计 §3.4 停止面、§2.3 等待接管态退出③）：
 * status＝读运行描述符输出三形态——运行中（心跳新鲜）/ 疑似僵尸（进程存活、心跳停）/ 等待接管
 * （一等状态，如实呈现 statusDetail）；stop 四分支——
 *   正常：经 IPC 发 replace{reason:'manual'} 让核心有序退出（帧型与原因词表承 IPC 层冻结口径）；
 *   僵尸：IPC 无应答或收下请求未按时退出 → 自动落硬杀防护链（共享件 src/core/stop-guard.js，
 *         本模块只消费、不复制防护链实现）；
 *   --force：显式授权硬杀（映射为防护链 allowOnce），判据/复读校验/端点消失确认仍由防护链执行；
 *   等待接管核：不监听 IPC，凭运行描述符对证（status=waiting＋pid/startedAt）经防护链终止——
 *         仅 --force 或调用方显式授权（清数据面通道）时放行，否则拒绝并给指引。
 * 本模块只读 run/core.json 与经 IPC 发一帧，不写任何数据面文件；由 bin 动态导入（服务路径不加载），
 * 也被 uninstall / purge-data 的「先停核心」步骤消费（同一实现，不复制判据）。
 * 输出走 stdout：CLI 子命令模块的用户输出通道，同 uninstall / purge-data 先例
 * （stdout 纪律扫描豁免清单）；家目录/数据根一律经 env 注入，模块绝不隐式触碰真实 ~/.waystation。 */

const APP_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/* 停止链各期限（实现期可校准）：出口等待＝replace 已发后等核心收尾（换代广播给的是 10s 量级）；
 * 连接/握手期限取短值——本命令面向「核心不健康」场景，快速失败后交防护链判定，不长时间挂起。 */
const STOP_EXIT_WAIT_MS = 10000;
const STOP_POLL_MS = 100;
const STOP_CONNECT_TIMEOUT_MS = 2000;
const STOP_HANDSHAKE_TIMEOUT_MS = 3000;

/* 跨进程测试注入缝（与核心侧同族纪律：仅 NODE_TEST_CONTEXT 在场时读取，形态/范围不合按未注入）。 */
const SEAM_EXIT_WAIT = 'WAYSTATION_TEST_CORE_STOP_EXIT_MS';
const SEAM_POLL = 'WAYSTATION_TEST_CORE_STOP_POLL_MS';
const SEAM_CONNECT = 'WAYSTATION_TEST_CORE_STOP_CONNECT_MS';
const SEAM_HANDSHAKE = 'WAYSTATION_TEST_CORE_STOP_HANDSHAKE_MS';

/* 停止客户端的桥标识前缀：与真实会话桥区分（核心日志一眼可辨来源），且满足桥标识形态判据。 */
const STOP_BRIDGE_PREFIX = 'cli-stop-';
/* 「心跳刚刚」的展示阈值（纯展示、不参与任何判据）：心跳按秒级周期刷新，低于一格周期显示秒数没有信息量。 */
const JUST_NOW_MS = 1500;
/* 停止成功的三结论（清数据面与本命令共用判据）：已停 / 本无核心 / 残留描述符——均可继续。 */
const SETTLED_OUTCOMES = new Set(['stopped', 'absent', 'stale']);

/** 停止结论是否可继续后续动作（uninstall / purge-data 的「先停核心」共用判据，单一权威）。 */
export function stopOutcomeSettled(outcome) {
  return SETTLED_OUTCOMES.has(outcome);
}

const USAGE_LINES = [
  '用法：',
  '  waystation core status        查看本机核心状态（未运行 / 运行中 / 等待接管 / 异常僵尸）',
  '  waystation core stop          停止本机核心：经 IPC 有序退出；IPC 无应答（僵尸）自动落硬杀防护链',
  '  waystation core stop --force  显式授权硬杀（防护链判据、复读校验、端点消失确认照走；校验不过不杀）',
  '',
  '（核心＝每个数据根的常驻驿站进程；数据根按 WAYSTATION_HOME 解析，默认 ~/.waystation。）',
];

/** @param {string[]} argv */
export function parseCoreArgs(argv) {
  /** @type {{ command: string, force: boolean, help: boolean, unknown: string[] }} */
  const options = { command: '', force: false, help: false, unknown: [] };
  for (const arg of argv) {
    if (arg === '--force') {
      options.force = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (options.command === '' && (arg === 'status' || arg === 'stop')) {
      options.command = arg;
    } else {
      options.unknown.push(arg);
    }
  }
  return options;
}

/**
 * `waystation core` 入口：解析→校验→分派。killGuarded 为防护链注入缝（缺省按需加载共享件）；
 * write 为输出注入缝（缺省真实 stdout 通道），单测经它取 CLI 契约面而不改全局 stdout。
 * @param {{ argv?: string[], env?: Record<string, string | undefined>,
 *   killGuarded?: ((request: any) => Promise<string>) | null, write?: (text: string) => void }} [options]
 */
export async function runCoreCli({ argv = [], env = process.env, killGuarded = null, write = defaultWrite } = {}) {
  guardBrokenPipe();
  const options = parseCoreArgs(argv);
  if (options.help) {
    write(USAGE_LINES.join('\n'));
    return 0;
  }
  const invalid = invalidArgsMessage(options);
  if (invalid !== null) {
    write(invalid);
    write(USAGE_LINES.join('\n'));
    return 1;
  }
  if (options.command === 'status') {
    return runCoreStatus(env, write);
  }
  return runCoreStop({ env, force: options.force, killGuarded, write });
}

function invalidArgsMessage(options) {
  if (options.command === '') {
    return '缺少子命令（仅支持 status / stop）';
  }
  if (options.unknown.length > 0) {
    return `未知参数：${options.unknown.join('、')}`;
  }
  if (options.force && options.command !== 'stop') {
    return '--force 只适用于 core stop';
  }
  return null;
}

function runCoreStatus(env, write) {
  const status = readCoreStatus({ env });
  for (const line of statusLines(status)) {
    write(line);
  }
  return status.kind === 'healthy' || status.kind === 'absent' ? 0 : 1;
}

async function runCoreStop({ env, force, killGuarded, write }) {
  const result = await stopCore({ env, force, killGuarded });
  write(result.message);
  return stopOutcomeSettled(result.outcome) ? 0 : 1;
}

/**
 * 读核心状态（只读，不写任何文件）：absent＝无运行描述符；unreadable＝读不到或形态不合；
 * stale＝pid 已不在（残留描述符）；healthy/zombie＝pid 活的健康/心跳超期二分；waiting 由记录
 * 的 status 字段如实承载（经 statusLines 呈现，仍是 healthy/zombie 二分的声音）。
 * @param {{ env?: Record<string, string | undefined> }} [options]
 */
export function readCoreStatus({ env = process.env } = {}) {
  const dataDir = resolveDataDir(env);
  const corePath = coreJsonPath(dataDir);
  const read = readCoreRecord(corePath);
  if (!read.ok) {
    const kind = read.reason === 'missing' ? 'absent' : 'unreadable';
    return { kind, dataDir, corePath, record: null, heartbeatAgeMs: null };
  }
  if (!recordUsable(read.record)) {
    return { kind: 'unreadable', dataDir, corePath, record: null, heartbeatAgeMs: null };
  }
  return classifyRecord(read.record, { dataDir, corePath, env });
}

/* 活核二分（心跳新鲜阈值与判死阈值同族，取生命周期层单一权威）：心跳旧不旧是墙钟事实。 */
function classifyRecord(record, { dataDir, corePath, env }) {
  const heartbeatAgeMs = heartbeatAgeOf(record);
  if (!pidIsAlive(record.pid)) {
    return { kind: 'stale', dataDir, corePath, record, heartbeatAgeMs };
  }
  const fresh = heartbeatAgeMs !== null && heartbeatAgeMs < lifecycleParams(env).judgeMs;
  return { kind: fresh ? 'healthy' : 'zombie', dataDir, corePath, record, heartbeatAgeMs };
}

function heartbeatAgeOf(record) {
  const age = Date.now() - Date.parse(record.heartbeatAt);
  return Number.isFinite(age) ? age : null;
}

/* 可用性判据：停止链需要的每个字段都在（pid/端点/token/启动时刻/状态）——缺任一即无法对证，
 * 按不可解析处理（不猜、不部分使用）。 */
function recordUsable(record) {
  return isPlainRecord(record)
    && Number.isInteger(record.pid) && record.pid > 0
    && isNonEmptyString(record.endpoint)
    && isNonEmptyString(record.token)
    && isNonEmptyString(record.startedAt)
    && isNonEmptyString(record.status);
}

function isPlainRecord(record) {
  return record !== null && typeof record === 'object' && !Array.isArray(record);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value !== '';
}

function statusLines(status) {
  if (status.kind === 'absent') {
    return ['核心：未运行（无 run/core.json）', `  数据根：${status.dataDir}`];
  }
  if (status.kind === 'unreadable') {
    return ['核心：异常（运行描述符不可解析或形态不合）', `  路径：${status.corePath}`];
  }
  return [statusHeadLine(status), ...recordDetailLines(status)];
}

function statusHeadLine(status) {
  const record = status.record;
  if (status.kind === 'stale') {
    return `核心：异常（残留运行描述符：pid ${record.pid} 已不在）`;
  }
  if (status.kind === 'zombie') {
    const stopped = status.heartbeatAgeMs === null ? '心跳时间不可解析' : `心跳已停 ${formatAge(status.heartbeatAgeMs)}`;
    return `核心：异常（疑似僵尸：进程存活、${stopped}）`;
  }
  if (record.status === 'waiting') {
    return '核心：等待接管（status=waiting——不监听 IPC、数据面零写；关闭同根旧版会话后自动接管）';
  }
  return `核心：运行中（status=${record.status}）`;
}

function recordDetailLines(status) {
  const record = status.record;
  const lines = [];
  if (typeof record.statusDetail === 'string' && record.statusDetail !== '') {
    lines.push(`  说明：${record.statusDetail}`);
  }
  lines.push(`  pid：${record.pid}`);
  lines.push(`  心跳：${record.heartbeatAt}（${status.heartbeatAgeMs === null ? '时间不可解析' : formatAge(status.heartbeatAgeMs)}）`);
  lines.push(`  端口：${record.port ?? '未知'}`);
  lines.push(`  端点：${record.endpoint}`);
  lines.push(`  版本：${record.appVersion ?? '未知'}（IPC v${record.ipcV ?? '未知'}）`);
  lines.push(`  数据根：${status.dataDir}`);
  return lines;
}

function formatAge(ageMs) {
  return ageMs < JUST_NOW_MS ? '刚刚' : `${Math.round(ageMs / 1000)}s 前`;
}

/**
 * 停止核心（uninstall / purge-data 的「先停核心」亦消费本函数）：
 *   outcome ∈ stopped（已停）/ absent（本无核心）/ stale（残留描述符）/ refused（有活核但未获授权或
 *   防护链判据不通过——调用方应拒绝继续删除）/ failed（不可解析或防护链不可用——同上应停手）。
 * force＝显式授权硬杀；allowForceOnWaiting＝调用方（清数据面）对等待核的单独授权通道。
 * @param {{ env?: Record<string, string | undefined>, force?: boolean, allowForceOnWaiting?: boolean,
 *   killGuarded?: ((request: any) => Promise<string>) | null }} [options]
 */
export async function stopCore(options = {}) {
  const env = options.env ?? process.env;
  const force = options.force === true;
  const allowForceOnWaiting = options.allowForceOnWaiting === true;
  const status = readCoreStatus({ env });
  if (status.kind === 'absent') {
    return { outcome: 'absent', message: '无核心在运行（无 run/core.json）——无需停止', dataDir: status.dataDir, record: null };
  }
  if (status.kind === 'unreadable') {
    return { outcome: 'failed', message: `运行描述符不可解析或形态不合，无法定位核心：${status.corePath}——请人工检查后处理`, dataDir: status.dataDir, record: null };
  }
  if (status.kind === 'stale') {
    return { outcome: 'stale', message: `残留运行描述符（pid ${status.record.pid} 已不在）——无需停止（下次核心启动会清理陈旧锁）`, dataDir: status.dataDir, record: status.record };
  }
  const params = stopParams(env);
  if (status.record.status === 'waiting') {
    return stopWaitingCore({ status, force, allowForceOnWaiting, killGuarded: options.killGuarded });
  }
  return stopRunningCore({ status, force, killGuarded: options.killGuarded, params });
}

/* 等待接管核不监听 IPC：有序通道不可达——只有「凭描述符对证后直接终止」一条主动路径
 * （设计 §3.4 裁定），且该核为零写驻留态，终止无数据风险。 */
async function stopWaitingCore({ status, force, allowForceOnWaiting, killGuarded }) {
  if (!force && !allowForceOnWaiting) {
    return {
      outcome: 'refused',
      message: '核心处于等待接管态（status=waiting，不监听 IPC，无法经 IPC 停止）：请先关闭同根旧版会话（核会自动接管或退出），或运行 waystation core stop --force 直接终止',
      dataDir: status.dataDir,
      record: status.record,
    };
  }
  const killed = await killViaGuard({ status, allowOnce: true, killGuarded });
  return { ...killed, dataDir: status.dataDir, record: status.record };
}

/* 活核：先走有序通道（IPC replace/manual 等核心收尾）；通道不可用或未按时收尾时，交防护链判定
 * 是否允许硬杀——自动落链不带显式授权（allowOnce=false），--force 才带（allowOnce=true）。 */
async function stopRunningCore({ status, force, killGuarded, params }) {
  const attempt = await stopViaIpc({ status, params });
  if (attempt.kind === 'stopped') {
    return { outcome: 'stopped', message: `已停止核心（pid ${status.record.pid}，经 IPC 有序退出）`, dataDir: status.dataDir, record: status.record };
  }
  if (attempt.kind === 'superseded') {
    return { outcome: 'failed', message: '停止期间核心被换代重写（新核心已接管）——请重试', dataDir: status.dataDir, record: status.record };
  }
  if (attempt.kind === 'refused' && !force) {
    return { outcome: 'refused', message: attempt.message, dataDir: status.dataDir, record: status.record };
  }
  const killed = await killViaGuard({ status, allowOnce: force, killGuarded });
  return { ...killed, dataDir: status.dataDir, record: status.record };
}

/* 有序停止通道：连接端点→hello 认证→发 replace{reason:'manual'}→以「描述符消失/易主或 pid 死亡」
 * 为完成判据（期限经注入缝）。连接被拒分两类：核心已在关闭中（replacing/shutting-down）＝等它退出；
 * 凭据/版本不符＝拒绝（未授权硬杀时不落防护链）。 */
async function stopViaIpc({ status, params }) {
  const client = createIpcClient({
    dataDir: status.dataDir,
    hello: {
      app: APP_VERSION,
      token: status.record.token,
      bridgeId: `${STOP_BRIDGE_PREFIX}${randomBytes(4).toString('hex')}`,
    },
    connectTimeoutMs: params.connectTimeoutMs,
    handshakeTimeoutMs: params.handshakeTimeoutMs,
    log: null,
  });
  /** @type {any} */
  let failure = null;
  try {
    await client.connect();
  } catch (error) {
    failure = error;
  }
  if (failure === null) {
    client.send({ type: 'replace', reason: 'manual' });
  }
  await closeQuietly(client);
  const alreadyStopping = failure?.code === 'replacing' || failure?.code === 'shutting-down';
  if (failure !== null && !alreadyStopping) {
    return ipcConnectFailureOf(failure);
  }
  const waited = await waitCoreGone({ status, params });
  if (waited === 'gone') {
    return { kind: 'stopped' };
  }
  if (waited === 'superseded') {
    return { kind: 'superseded' };
  }
  return { kind: 'unreachable', reason: 'no-exit' };
}

/* 连接期失败的分类：凭据/版本不符＝拒绝（不自动升格为硬杀）；其余（超时、端点不可达等）＝
 * 不可达——交调用方决定是否落防护链。 */
function ipcConnectFailureOf(error) {
  if (error?.code === 'auth') {
    return { kind: 'refused', message: '未停止：IPC 认证失败（核心凭据与运行描述符不符——可能刚被换代重写）——请重试' };
  }
  if (error?.code === 'version') {
    return { kind: 'refused', message: '未停止：IPC 版本不兼容（运行核心与当前 CLI 版本不一致）——请重开会话完成换代，或加 --force 授权硬杀' };
  }
  return { kind: 'unreachable', reason: String(error?.code ?? error?.message ?? 'unknown') };
}

/* 完成判据：描述符消失或 pid 死亡＝已退场（gone）；描述符被继任者重写＝易主（superseded）；
 * 期限到仍原样＝timeout（调用方据此落防护链）。 */
async function waitCoreGone({ status, params }) {
  const deadline = Date.now() + params.exitWaitMs;
  for (;;) {
    const current = readCoreRecord(status.corePath);
    if (!current.ok) {
      return 'gone';
    }
    if (!sameProcessRecord(status.record, current.record)) {
      return 'superseded';
    }
    if (!pidIsAlive(status.record.pid)) {
      return 'gone';
    }
    if (Date.now() >= deadline) {
      return 'timeout';
    }
    await sleep(params.pollMs);
  }
}

/* 硬杀防护链消费面（共享件，本模块不复制其实现）：入参＝防护链契约的五个字段；
 * allowOnce 由「--force 显式授权 / 清数据面对等待核的授权」映射而来。结论→文案见下。 */
async function killViaGuard({ status, allowOnce, killGuarded }) {
  try {
    const kill = killGuarded ?? (await loadSharedKillGuarded());
    const result = await kill({
      coreJsonPath: status.corePath,
      endpoint: status.record.endpoint,
      pid: status.record.pid,
      startedAt: status.record.startedAt,
      allowOnce,
    });
    return guardResultOf(result, status.record, allowOnce);
  } catch (error) {
    return { outcome: 'failed', message: `未终止：硬杀防护链不可用（${error?.message ?? String(error)}）——请人工检查 pid ${status.record.pid}` };
  }
}

function guardResultOf(result, record, allowOnce) {
  if (result === 'killed') {
    return { outcome: 'stopped', message: `已终止核心（pid ${record.pid}，硬杀防护链已确认端点消失）` };
  }
  if (result === 'endpoint-gone') {
    return { outcome: 'stopped', message: `核心端点已消失（pid ${record.pid} 已不在或已退出）` };
  }
  if (result === 'verification-failed') {
    return { outcome: 'failed', message: `未终止：硬杀防护链复读校验不过（pid ${record.pid} 的运行描述符已被改写——可能刚被换代）——请重试` };
  }
  if (result === 'not-eligible') {
    /* 此处对「IPC 已收下有序停止请求却未在期限内退出」不单独分档：核侧换代执行面接线前，健康核会走
     * 这条路径（判据不通过＝宁可不杀，正确侧），接线后该窗口自然消失——换代接线复核时再看是否要分档文案。 */
    const advice = allowOnce ? '' : '——如需强制停止可加 --force';
    return { outcome: 'refused', message: `未终止：硬杀防护链判据不通过（核心可能仍在启动或正常应答${advice}）——请人工检查 pid ${record.pid}` };
  }
  if (result === 'already-once') {
    return { outcome: 'refused', message: `未终止：该 pid 的硬杀已被防护链记录过一次——请人工检查 pid ${record.pid}` };
  }
  return { outcome: 'failed', message: `未终止：硬杀防护链返回未知结论（${String(result)}）——请人工检查 pid ${record.pid}` };
}

/* 防护链按需加载：共享件缺位时以明确文案收场（未终止＋人工指引），绝不退化为自实现杀进程。 */
async function loadSharedKillGuarded() {
  const shared = await import('./core/stop-guard.js');
  return shared.killGuarded;
}

function stopParams(env) {
  return {
    exitWaitMs: testNumber(env, SEAM_EXIT_WAIT, 10, 600000) ?? STOP_EXIT_WAIT_MS,
    pollMs: testNumber(env, SEAM_POLL, 10, 60000) ?? STOP_POLL_MS,
    connectTimeoutMs: testNumber(env, SEAM_CONNECT, 100, 60000) ?? STOP_CONNECT_TIMEOUT_MS,
    handshakeTimeoutMs: testNumber(env, SEAM_HANDSHAKE, 100, 60000) ?? STOP_HANDSHAKE_TIMEOUT_MS,
  };
}

async function closeQuietly(client) {
  try {
    await client.close();
  } catch {
    // 关闭失败不改变停止结论（对端可能已先断开）
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultWrite(text) {
  process.stdout.write(`${text}\n`);
}

/* 输出被截断（如管道到 head）时 stdout 的 EPIPE 默认冒泡为未捕获异常——CLI 输出属尽力而为，
 * 管道断开按正常结束处理；按监听器身份幂等，重复调用不叠加。 */
function onStdoutError(error) {
  if (error?.code === 'EPIPE') {
    process.exit(0);
  }
}

function guardBrokenPipe() {
  if (!process.stdout.listeners('error').includes(onStdoutError)) {
    process.stdout.on('error', onStdoutError);
  }
}
