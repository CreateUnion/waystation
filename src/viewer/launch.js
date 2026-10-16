/* 观察窗启动链的纯函数层：端口探针与归属判定、启动协商（同根预扫＋顺序 bind）、Edge 定位与开窗
 * 命令计划、停止（--stop）、自动开窗——站点根映射、spawn 计划构造、开关现读、触发时拉起与启动判定。
 * 全部副作用经参数注入（fetch / spawn / kill / sleep / exists / readFile / startServer），组合根
 * （scripts/ws-viewer.js 与 src/index.js）装配真实实现，单测注入桩。
 *
 * rootDigest 的唯一定义在中立模块 util/digest.js（health 字段、端口自发现、停止匹配与核心的
 * IPC 端点命名共用同一函数）；本模块只再导出，不复制实现，防止口径漂移。 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { CONFIG_FILE_NAME } from '../paths.js';

export { rootDigest } from '../util/digest.js';

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

/**
 * 按端口序找出**首个**同根实例（「在跑」判定与停止循环共用；停全部由调用方循环收敛）：探测命中
 * 且同根后复探一次确认同 pid——缩 pid 复用窗口，复探不一致、已消失或缺 pid（无从确认同一进程）
 * 即视作换过了、跳过继续扫。
 * @param {{ candidatePorts: number[], digest: string, probe?: (options: { port: number }) => Promise<{ root?: string, pid?: number } | null> }} options
 * @returns {Promise<{ port: number, pid: number } | null>}
 */
export async function findSameRootViewer({ candidatePorts, digest, probe = probeViewer }) {
  for (const port of candidatePorts) {
    const health = await probe({ port });
    if (health === null || health.root !== digest) {
      continue;
    }
    const confirmed = await probe({ port });
    if (confirmed === null || confirmed.pid === undefined || confirmed.pid !== health.pid) {
      continue;
    }
    return { port, pid: confirmed.pid };
  }
  return null;
}

/* —— 启动协商（手动启动路径：先段级同根预扫、后 bind 兜底） —— */

/**
 * 启动协商：先做段级同根预扫（快路径），未命中才走顺序 bind；bind 的 EADDRINUSE 归属判定保留
 * 为竞态兜底。
 *
 * 预扫要解决什么：设计（安静默认设计 §3.2）承诺「同根观察窗服务已跑→只开窗」，只看 bind 结果
 * 做不到——同根实例可能已在段内更高位运行（其启动时低位被占、顺序 bind 顺延过），低位腾空后的
 * 新调用直接 bind 成功，就会起出第二个同根服务。
 *
 * 两层的边界：预扫命中即判 running、不再 bind（没有「探到空闲→稍后绑定」的竞态面）；预扫未命中
 * 不等于端口空闲——候选端口归谁仍以 bind 结果为准（bind 成功即起服务；EADDRINUSE 再探 health
 * 判定归属），承接预扫到 bind 之间状态变化的窗口。
 *
 * 代价：启动多出每候选一次 health 探测——本地回环上空闲端口的连接拒绝即时返回，常见场景只是
 * 几次即时的探针；只有被「受理却不应答」的进程占着的候选才会耗到探测超时。
 * @param {{ candidatePorts: number[], explicitPort: boolean, digest: string, probe?: (options: { port: number }) => Promise<{ root?: string, pid?: number } | null>, startServer: (port: number) => Promise<{ port: number, close: () => Promise<void> }> }} options
 * @returns {Promise<{ kind: 'started', server: { port: number, close: () => Promise<void> } } | { kind: 'running', port: number } | { kind: 'failed', reason: string }>}
 */
export async function negotiateViewerPort({ candidatePorts, explicitPort, digest, probe = probeViewer, startServer }) {
  const running = await findSameRootViewer({ candidatePorts, digest, probe });
  if (running !== null) {
    return { kind: 'running', port: running.port };
  }
  for (const port of candidatePorts) {
    try {
      const server = await startServer(port);
      return { kind: 'started', server };
    } catch (error) {
      if (error.code !== 'EADDRINUSE') {
        return { kind: 'failed', reason: `监听端口 ${port} 失败：${error.message}` };
      }
    }
    if (await classifyBusyPort({ port, digest, probe }) === 'ours') {
      return { kind: 'running', port };
    }
    if (explicitPort) {
      return { kind: 'failed', reason: `端口 ${port} 属于另一数据根的观察窗或他人进程` };
    }
  }
  return { kind: 'failed', reason: `端口段 ${DEFAULT_VIEWER_PORT}–${DEFAULT_VIEWER_PORT + PORT_TRIES - 1} 全部被占用，无法启动观察窗` };
}

/**
 * 停止运行中的观察窗（停全部同根）：循环「找首个同根实例→kill→复验端口释放」直至段内无同根
 * 命中；同根实例不多于候选端口数，轮数上限取候选数（防「kill 后同根立刻再现」类异常下死循环）。
 * 别根/他人跳过；成功＝{stopped:true, ports, pids}（按停止顺序成对）；全无命中＝{stopped:false}；
 * kill 抛错或释放复验失败＝{stopped:false, reason}（此前停掉的不回滚，失败如实上报）。
 * @param {{ candidatePorts: number[], digest: string, probe?: (options: { port: number }) => Promise<{ root: string, pid: number } | null>, kill?: (pid: number) => void, sleep?: (ms: number) => Promise<void> }} options
 * @returns {Promise<{ stopped: true, ports: number[], pids: number[] } | { stopped: false, port?: number, pid?: number, reason?: string }>}
 */
export async function stopViewer({ candidatePorts, digest, probe = probeViewer, kill = process.kill, sleep = delay }) {
  const ports = [];
  const pids = [];
  for (let round = 0; round < candidatePorts.length; round++) {
    const target = await findSameRootViewer({ candidatePorts, digest, probe });
    if (target === null) {
      break;
    }
    try {
      kill(target.pid);
    } catch (error) {
      return { stopped: false, reason: `终止进程 ${target.pid} 失败：${error.message}` };
    }
    if (!(await waitForPortRelease({ port: target.port, probe, sleep }))) {
      return { stopped: false, port: target.port, pid: target.pid, reason: `进程 ${target.pid} 已终止但端口 ${target.port} 在 ${STOP_RELEASE_WAIT_MS}ms 内未释放` };
    }
    ports.push(target.port);
    pids.push(target.pid);
  }
  if (ports.length === 0) {
    return { stopped: false };
  }
  return { stopped: true, ports, pids };
}

/* —— 自动开窗：触发 A/B 的构造与出口 —— */

/* 触发 B「进行中」状态集，按角色写死（设计 §3.2）：站长侧 = 尚未归档的全部状态——自己创建的
 * 协作在等对方同意（proposed）期间开新会话照样拉起；成员侧 = 已入席——受邀未同意不弹，防与
 * 「防每会话被弹」的意图相抵。 */
const MANAGER_IN_PROGRESS_STATES = ['proposed', 'active', 'frozen'];
const MEMBER_IN_PROGRESS_STATES = ['active', 'frozen'];

/* viewerAutoOpen 的字段名（config.json，每根一份；缺省/缺失＝true 静默、非法＝true＋warn）。 */
const AUTO_OPEN_KEY = 'viewerAutoOpen';

/**
 * 站点根在观察窗 URL 里的名字（设计 §3.2 的根映射）：显式数据目录与槽位 1 = 主根 main（槽位 1
 * 即主数据目录本身）；槽位 k≥2 = s<k>；站点解析降级（无站点信息）也记 main——main 是观察窗
 * 进程自己数据根的名字，降级时该根即站点活动目录（显式目录降级时子进程继承 WAYSTATION_HOME，
 * 无该变量时即主目录；见 buildViewerSpawn 的 env 三支）。
 * @param {{ siteMode?: string | null, slot?: number | null }} options
 * @returns {string}
 */
export function viewerRootOf({ siteMode, slot }) {
  return siteMode === 'slot' && typeof slot === 'number' && Number.isInteger(slot) && slot >= 2 ? `s${slot}` : 'main';
}

/**
 * 观察窗拉起的 spawn 计划（纯构造；真实 spawn 在 openViewerWindow）。命令＝当前 node 可执行
 * 文件＋脚本绝对路径——入口按安装布局解析，不依赖 PATH 与工作目录。
 * env 三支（设计 §3.2）：显式数据目录与站点解析降级（无站点信息）都不改写 env——两态的站点
 * 活动目录都由 WAYSTATION_HOME 决定（降级时是显式目录、无该变量时即主目录），子进程必须与父
 * 进程解析同址（观察窗根契约＝站点数据根）；仅槽位模式删除该变量——槽位模式下它必空（解析见
 * 非空即走显式分支，删与不删等价），保留删除是一道防线：绝不注入槽位目录，否则观察窗根错位、
 * 与其他槽位窗口互为「他人」。
 * ref＝{ root, id }：root 为观察窗内的站点根（调用方注入值优先，缺省按站点模式推导，两径同源
 * 同值）；id 缺省＝列表页（不带 --focus）。
 * @param {{ siteMode?: string | null, slot?: number | null, ref?: { root?: string | null, id?: string | null } | null, scriptPath: string }} options
 * @returns {{ command: string, args: string[], env: Record<string, string | undefined>, options: { detached: boolean, windowsHide: boolean, stdio: 'ignore' } }}
 */
export function buildViewerSpawn({ siteMode, slot, ref, scriptPath }) {
  const root = typeof ref?.root === 'string' && ref.root !== '' ? ref.root : viewerRootOf({ siteMode, slot });
  const id = ref?.id ?? null;
  const args = typeof id === 'string' && id !== '' ? [scriptPath, '--focus', `${root}/${id}`] : [scriptPath];
  /* 子进程环境恒由 process.env 派生（openViewerWindow 的注入 env 只作测试上下文闸、不参与此处
   * 组装——生产两者同源：出口 env 缺省即 process.env；经该缝传环境不会改到这里）。 */
  const env = { ...process.env };
  if (siteMode === 'slot') {
    delete env.WAYSTATION_HOME;
  }
  return { command: process.execPath, args, env, options: { detached: true, windowsHide: true, stdio: 'ignore' } };
}

/**
 * viewerAutoOpen 现读（设计 §3.4）：纯 JSON.parse＋类型判定，不落任何写副作用——禁用 loadConfig
 * （其损坏分支会把原文件改名重建，自动开窗钩子不得触发写盘）。缺失（无文件）与缺省（无字段）
 * 都按默认 true **静默**处理（沿 config.js 既有样式：缺省不告警）；只有值非法（非布尔）或文件
 * 存在但读不出/解析不了才 warn 一次。显式 false 才关闭（触发 A/B 全关，手开不受影响）。
 * @param {{ dataDir: string, warn: (message: string) => void, readFile?: (path: string, encoding: 'utf8') => string }} options
 * @returns {boolean}
 */
export function readViewerAutoOpen({ dataDir, warn, readFile = readFileSync }) {
  try {
    const parsed = JSON.parse(readFile(join(dataDir, CONFIG_FILE_NAME), 'utf8'));
    const value = parsed?.[AUTO_OPEN_KEY];
    if (value === undefined || value === true) {
      return true;
    }
    if (value === false) {
      return false;
    }
    warn('viewerAutoOpen 值非法（非布尔），按默认开启处理');
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return true;
    }
    warn(`viewerAutoOpen 不可读（${error.message}），按默认开启处理`);
    return true;
  }
}

/**
 * 触发 B 的「进行中」筛选：遍历注册表条目按角色/状态判定（localStateOf 读出的状态）。
 * 不用 countLiveCollabs——它只给计数、口径含成员侧 proposed，与按角色写死的判定相反。
 * @param {Array<{ collabId: string, role: string, state: string }> | null | undefined} entries
 * @returns {Array<{ collabId: string, role: string, state: string }>}
 */
export function inProgressCollabsOf(entries) {
  const inProgress = [];
  for (const entry of entries ?? []) {
    const states = entry.role === 'manager' ? MANAGER_IN_PROGRESS_STATES : MEMBER_IN_PROGRESS_STATES;
    if (states.includes(entry.state)) {
      inProgress.push(entry);
    }
  }
  return inProgress;
}

/**
 * 触发时拉起观察窗（触发 A/B 的公共出口）：开关现读（每次触发重新读 config.json——改文件后
 * 下一次触发即生效）；分离 spawn（detached＋windowsHide＋stdio ignore）＋unref（不阻塞服务
 * 退出）；spawn 启动失败 / 非零退出 → log.warn 留痕、用户侧无感（静默降级，不影响协作本体）。
 * 函数绝不抛出——调用点零负担。
 * 测试上下文（node --test 注入 NODE_TEST_CONTEXT、并随环境继承到组合根）一律不真开窗：以真实
 * 组合根创建协作的端到端测试若照常拉起，会给开发机弹出一批浏览器窗口并遗留 detached 观察窗进程
 * （env 注入缝让真实 spawn 路径仍可测）。生产环境无此变量，不经此闸。
 * @param {{ ref?: { root?: string | null, id?: string | null } | null, dataDir: string, siteMode?: string | null, slot?: number | null, scriptPath: string, log: { warn: (...args: any[]) => void }, spawnFn?: typeof spawn, env?: Record<string, string | undefined> }} options
 * @returns {{ opened: boolean, reason?: string }}
 */
export function openViewerWindow({ ref, dataDir, siteMode, slot, scriptPath, log, spawnFn = spawn, env = process.env }) {
  try {
    if (typeof env.NODE_TEST_CONTEXT === 'string') {
      log.warn('测试上下文（NODE_TEST_CONTEXT）：跳过观察窗自动打开');
      return { opened: false, reason: 'test-context' };
    }
    if (readViewerAutoOpen({ dataDir, warn: (message) => log.warn(message) }) === false) {
      return { opened: false, reason: 'auto-open-off' };
    }
    const plan = buildViewerSpawn({ siteMode, slot, ref, scriptPath });
    const child = spawnFn(plan.command, plan.args, { ...plan.options, env: plan.env });
    child.on('error', (error) => log.warn('观察窗拉起失败（已静默降级）', { reason: error.message }));
    child.on('exit', (code) => {
      if (code !== null && code !== 0) {
        log.warn('观察窗进程异常退出（已静默降级）', { code });
      }
    });
    child.unref();
    return { opened: true };
  } catch (error) {
    log.warn('观察窗拉起异常（已静默降级）', { reason: error?.message });
    return { opened: false, reason: 'error' };
  }
}

/* 本会话绑定集（合成判定的第一步）：合法即原样成集；参数非法（缺失/非数组）按空集处理＋warn 一次
 * ——fail-safe 取「宁不弹」（安静是安全侧），空集经出口既有短路返回 {opened:false, reason:'none'}。 */
function boundSetOf(boundCollabIds, log) {
  if (!Array.isArray(boundCollabIds)) {
    log.warn('触发 B 缺绑定集参数（按空集处理——不拉起）', { reason: 'boundCollabIds 非法' });
    return new Set();
  }
  return new Set(boundCollabIds);
}

/**
 * 新会话启动时的观察窗拉起（触发 B）：判定面＝**本会话绑定面**（源＝2026-10-16 会话级暴露设计）——
 * 本会话绑定的协作 ∩ 进行中（进行中按角色写死，见 inProgressCollabsOf）——0 个不做（新会话无绑定
 * 即此支）；同根观察窗已在跑（默认端口段探测＋根摘要比对；别根/他人一律视为未在跑）不重复弹；未在
 * 跑则恰 1 个开其详情页、≥2 开列表页。绑定过滤与进行中过滤在本出口内一处合成，调用点只取数、不
 * 判决（判据分叉即缺陷）。
 * 判定时点＝桥注册即时、每 sessionId 每核一次：同核内重连/顶替/重生重注册不重判，核换代/重启后
 * 重注册即重判；判定不区分绑定活跃/休眠（那是注入路由的派生状态，与判定面无关）。
 * 绑定集非法（缺失/非数组）按空集处理＋warn 一次：宁不弹——安静是安全侧。绝不抛出，失败静默降级
 * （探测异常同走告警出口）。
 * @param {{ collabs: Array<{ collabId: string, role: string, state: string }> | null | undefined, boundCollabIds: string[], root: string, digest: string, dataDir: string, siteMode?: string | null, slot?: number | null, scriptPath: string, log: { warn: (...args: any[]) => void }, probe?: (options: { port: number }) => Promise<{ root?: string, pid?: number } | null>, spawnFn?: typeof spawn, env?: Record<string, string | undefined> }} options
 * @returns {Promise<{ opened: boolean, reason?: string }>}
 */
export async function openViewerOnStart({ collabs, boundCollabIds, root, digest, dataDir, siteMode, slot, scriptPath, log, probe = probeViewer, spawnFn = spawn, env = process.env }) {
  try {
    const bound = boundSetOf(boundCollabIds, log);
    const inProgress = inProgressCollabsOf((collabs ?? []).filter((entry) => bound.has(entry.collabId)));
    if (inProgress.length === 0) {
      return { opened: false, reason: 'none' };
    }
    const candidatePorts = Array.from({ length: PORT_TRIES }, (_, offset) => DEFAULT_VIEWER_PORT + offset);
    if (await findSameRootViewer({ candidatePorts, digest, probe }) !== null) {
      return { opened: false, reason: 'running' };
    }
    const ref = inProgress.length === 1 ? { root, id: inProgress[0].collabId } : null;
    return openViewerWindow({ ref, dataDir, siteMode, slot, scriptPath, log, spawnFn, env });
  } catch (error) {
    log.warn('观察窗启动拉起异常（已静默降级）', { reason: error?.message });
    return { opened: false, reason: 'error' };
  }
}
