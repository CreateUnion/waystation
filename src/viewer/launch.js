/* 观察窗启动链的纯函数层：端口探针与归属判定、Edge 定位与开窗命令计划、停止（--stop）。
 * 全部副作用经参数注入（fetch / spawn / kill / sleep / exists），组合根（scripts/ws-viewer.js）
 * 装配真实实现，单测注入桩——本模块不进 spawn 测试的真实执行路径。
 *
 * rootDigest 的唯一定义在 server.js（health 字段、端口自发现与停止匹配三处共用）；本模块只
 * 再导出，不复制实现，防止口径漂移。 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

export { rootDigest } from './server.js';

/* 默认端口段：基址 7330、顺序试探 10 个（设计 §4.2 裁定）——在站点槽位段 7321–7328 之外且
 * 留 7329 作缓冲、低于 Windows 动态端口区（49152 起）、避开常见开发端口。 */
export const DEFAULT_VIEWER_PORT = 7330;
export const PORT_TRIES = 10;
/* health 探测超时（计划 §3）：连接拒绝即时返回，超时只在对方受理却不应答时发生——观察窗的
 * 读取是同步全文件读，负载下事件循环可能短暂繁忙，留足余量防自家实例被误判成「他人」。 */
const HEALTH_TIMEOUT_MS = 800;
/* --stop 在 kill 后等待端口释放的上限（计划 §3）：超时即释放复验失败，如实上报而非默认成功。 */
export const STOP_RELEASE_WAIT_MS = 3000;
/* 释放轮询周期：kill 到端口真正释放通常只需几毫秒，100ms 粒度在 3s 窗口内留 30 次机会，
 * 兼顾及时性与探测开销。 */
const STOP_POLL_INTERVAL_MS = 100;
/* 释放复验的最大轮数＝窗口/周期（按轮数而非挂钟计时：测试注入 sleep 时推进确定、不依赖真实时钟）。 */
const STOP_POLL_ATTEMPTS = STOP_RELEASE_WAIT_MS / STOP_POLL_INTERVAL_MS;
/* Edge 应用模式窗口尺寸（设计 §4.3）。 */
const APP_WINDOW_SIZE = '1280,900';

/* health 应答里的自家标识：与 server.js 的 app 字段约定一致（该模块不导出该常量，此处是
 * 唯一使用方，变更时两处同改）。 */
const VIEWER_APP_NAME = 'waystation-viewer';
const EDGE_EXE_NAME = 'msedge.exe';

/**
 * 探测某端口的观察窗健康面：GET http://127.0.0.1:<port>/api/health。
 * 应答是自家 app 且 JSON 可解才返回应答对象；连接拒绝/超时/坏 JSON/他人服务一律 null——
 * 调用方（归属判定与启动协商）对「不是自家观察窗」与「探测失败」同一处置。
 * @param {{ port: number, timeoutMs?: number, fetchFn?: typeof fetch }} options
 * @returns {Promise<{ app: string, v: number, pid: number, root: string } | null>}
 */
export async function probeViewer({ port, timeoutMs = HEALTH_TIMEOUT_MS, fetchFn = globalThis.fetch }) {
  try {
    const response = await fetchFn(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const health = await response.json();
    return health !== null && typeof health === 'object' && health.app === VIEWER_APP_NAME ? health : null;
  } catch {
    return null;
  }
}

/**
 * 端口被占时的归属判定：探测命中且数据根摘要一致＝自家同根（'ours'，即已在跑的同一观察窗）；
 * 其余（别根的观察窗 / 他人进程 / 探测超时）＝'other'。
 * @param {{ port: number, digest: string, probe?: (options: { port: number }) => Promise<{ root?: string } | null> }} options
 * @returns {Promise<'ours' | 'other'>}
 */
export async function classifyBusyPort({ port, digest, probe = probeViewer }) {
  const health = await probe({ port });
  return health !== null && health.root === digest ? 'ours' : 'other';
}

/* Edge 候选路径（设计 §4.3 定位顺序）：程序目录 x86 → x64 → PATH 各目录下的 msedge.exe。 */
function edgeCandidatesOf(env) {
  const candidates = [];
  const programFiles32 = env['ProgramFiles(x86)'];
  if (programFiles32) {
    candidates.push(win32.join(programFiles32, 'Microsoft', 'Edge', 'Application', EDGE_EXE_NAME));
  }
  const programFiles = env.ProgramFiles;
  if (programFiles) {
    candidates.push(win32.join(programFiles, 'Microsoft', 'Edge', 'Application', EDGE_EXE_NAME));
  }
  for (const dir of String(env.PATH ?? '').split(';')) {
    if (dir !== '') {
      candidates.push(win32.join(dir, EDGE_EXE_NAME));
    }
  }
  return candidates;
}

/**
 * 定位 Edge：仅 Windows 有候选链；POSIX 恒 null（走 open/xdg-open）。exists 注入——单测不碰
 * 真实文件系统。
 * @param {{ platform: string, env: Record<string, string | undefined>, exists?: (path: string) => boolean }} options
 * @returns {string | null}
 */
export function locateEdge({ platform, env, exists = existsSync }) {
  if (platform !== 'win32') {
    return null;
  }
  for (const candidate of edgeCandidatesOf(env)) {
    if (exists(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * 开窗命令计划（平台分支）：win 有 Edge 用 --app 应用模式开；win 无 Edge 降级默认浏览器；
 * macOS 用 open、其余 POSIX 用 xdg-open。cmd 与 args 分离，供 spawn(cmd, args) 直用。
 * @param {{ platform: string, url: string, edgePath?: string | null }} options
 * @returns {{ cmd: string, args: string[] }}
 */
export function buildOpenCommand({ platform, url, edgePath }) {
  if (platform === 'win32') {
    return edgePath
      ? { cmd: edgePath, args: [`--app=${url}`, `--window-size=${APP_WINDOW_SIZE}`] }
      : { cmd: 'cmd', args: ['/c', 'start', '', url] };
  }
  return platform === 'darwin' ? { cmd: 'open', args: [url] } : { cmd: 'xdg-open', args: [url] };
}

/**
 * 开窗：分离进程、忽略 stdio，随即 unref。spawn 同步异常返回 false（调用方只告警不退出）；
 * 异步启动失败（ENOENT 等以 'error' 事件上报）无法经返回值表达，吞掉防未处理事件崩进程——
 * 服务照常运行，地址已打印，可手动打开。
 * @param {{ plan: { cmd: string, args: string[] }, spawnFn?: typeof spawn }} options
 * @returns {boolean}
 */
export function openWindow({ plan, spawnFn = spawn }) {
  try {
    const child = spawnFn(plan.cmd, plan.args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/* 默认节拍（生产用真实定时器；单测注入以同步推进）。 */
function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

/* kill 后轮询至端口释放（探测返回 null）：窗口内未释放＝false——「发过 kill」不等于「已停止」，
 * 复验失败要如实上报（进程没死、或另有进程接手了端口）。 */
async function waitForPortRelease({ port, probe, sleep }) {
  for (let attempt = 0; attempt < STOP_POLL_ATTEMPTS; attempt++) {
    await sleep(STOP_POLL_INTERVAL_MS);
    if (await probe({ port }) === null) {
      return true;
    }
  }
  return false;
}

/* 按端口序找出同根实例（多实例只取首个）：探测命中且同根后复探一次确认同 pid——缩 pid 复用
 * 窗口，复探不一致（或已消失）即视作换了进程、跳过继续扫。 */
async function findSameRootViewer({ candidatePorts, digest, probe }) {
  for (const port of candidatePorts) {
    const health = await probe({ port });
    if (health === null || health.root !== digest) {
      continue;
    }
    const confirmed = await probe({ port });
    if (confirmed === null || confirmed.pid !== health.pid) {
      continue;
    }
    return { port, pid: confirmed.pid };
  }
  return null;
}

/**
 * 停止运行中的观察窗：找到首个同根实例→kill→复验端口释放。
 * 别根/他人跳过；全无命中＝{stopped:false}；kill 抛错或释放复验失败＝{stopped:false, reason}
 * （调用方按失败上报）。
 * @param {{ candidatePorts: number[], digest: string, probe?: (options: { port: number }) => Promise<{ root: string, pid: number } | null>, kill?: (pid: number) => void, sleep?: (ms: number) => Promise<void> }} options
 * @returns {Promise<{ stopped: boolean, port?: number, pid?: number, reason?: string }>}
 */
export async function stopViewer({ candidatePorts, digest, probe = probeViewer, kill = process.kill, sleep = delay }) {
  const target = await findSameRootViewer({ candidatePorts, digest, probe });
  if (target === null) {
    return { stopped: false };
  }
  try {
    kill(target.pid);
  } catch (error) {
    return { stopped: false, reason: `终止进程 ${target.pid} 失败：${error.message}` };
  }
  if (await waitForPortRelease({ port: target.port, probe, sleep })) {
    return { stopped: true, port: target.port, pid: target.pid };
  }
  return { stopped: false, port: target.port, pid: target.pid, reason: `进程 ${target.pid} 已终止但端口 ${target.port} 在 ${STOP_RELEASE_WAIT_MS}ms 内未释放` };
}
