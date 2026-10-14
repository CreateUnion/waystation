/* 人类观察窗的组合根入口：参数解析（--port / --no-open / --stop）、端口协商、就绪行、开窗
 * 与退出通道。启动链的判定（探针 / 归属 / 开窗计划 / 停止）都在 src/viewer/launch.js 的
 * 注入式函数里，本文件只做接线与输出。
 *
 * 退出通道单点化：stdin 的 q 字节与 POSIX 信号共用同一个 shutdown——server.close 非幂等
 * （重复调用 reject ERR_SERVER_NOT_RUNNING），双触发必须挡在单点之前。Windows 下 --stop 是
 * 硬终止：Node 在 Windows 不投递 SIGTERM 处理器，进程被直接结束、没有优雅退出机会
 * （平台差异由设计 §4.1 写明）。 */

import {
  buildOpenCommand,
  classifyBusyPort,
  DEFAULT_VIEWER_PORT,
  locateEdge,
  openWindow,
  PORT_TRIES,
  rootDigest,
  stopViewer,
} from '../src/viewer/launch.js';
import { INDEX_HTML, APP_JS, STYLE_CSS } from '../src/viewer/assets.js';
import { createViewerData } from '../src/viewer/data.js';
import { startViewerServer } from '../src/viewer/server.js';
import { resolveDataDir } from '../src/paths.js';

const USAGE = '用法：node scripts/ws-viewer.js [--port N] [--no-open] [--stop]';
/* 用户可见故障统一退出码 2（用法错误、端口不可得、kill 失败——设计 §4.1/§4.2）。 */
const EXIT_ERROR = 2;
/* q 字节（ASCII 0x71）＝e2e 收尾的优雅退出通道；只认显式字节，EOF/关闭不触发退出
 * （双击启动等无 stdin 场景不受影响）。 */
const QUIT_BYTE = 0x71;
const MAX_PORT = 65535;

/* 端口值：十进制正整数 1–65535；其余（含缺值 undefined、带符号、超界）＝null → 用法错误。 */
function parsePortValue(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    return null;
  }
  const port = Number(value);
  return port >= 1 && port <= MAX_PORT ? port : null;
}

/* 参数解析：三开关，未知选项/位置参数/--port 取值非法 → null（调用方按用法错误处置——
 * 用户显式调用的程序，错误必须可见）。重复 --port 以最后一个为准。 */
function parseArgs(args) {
  const options = { port: null, noOpen: false, stop: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--no-open') {
      options.noOpen = true;
    } else if (arg === '--stop') {
      options.stop = true;
    } else if (arg === '--port') {
      const port = parsePortValue(args[index + 1]);
      if (port === null) {
        return null;
      }
      options.port = port;
      index++;
    } else {
      return null;
    }
  }
  return options;
}

/* 候选端口：显式 --port 为单端口（不做范围试探）；否则默认段 7330 起 10 个。 */
function candidatePortsOf(options) {
  if (options.port !== null) {
    return [options.port];
  }
  return Array.from({ length: PORT_TRIES }, (_, offset) => DEFAULT_VIEWER_PORT + offset);
}

function viewerUrlOf(port) {
  return `http://127.0.0.1:${port}/`;
}

function openBrowser({ url }) {
  const platform = process.platform;
  const plan = buildOpenCommand({ platform, url, edgePath: locateEdge({ platform, env: process.env }) });
  if (!openWindow({ plan })) {
    console.error(`自动开窗失败，请手动打开：${url}`);
  }
}

function reportReady({ port, data, noOpen }) {
  console.log(`观察窗已就绪：${viewerUrlOf(port)}（协作与讨论 ${data.listCollabs().collabs.length} 台）`);
  if (!noOpen) {
    openBrowser({ url: viewerUrlOf(port) });
  }
}

/* 已在跑（同根同端口）分支：不再起服务，只打印地址（--no-open）或再开一个窗。 */
function reportRunning({ port, noOpen }) {
  console.log(`观察窗已在运行：${viewerUrlOf(port)}`);
  if (!noOpen) {
    openBrowser({ url: viewerUrlOf(port) });
  }
}

/* 端口协商（顺序 bind，不做先探后绑——避免 TOCTOU）：成功→{kind:'started'}；
 * EADDRINUSE→health 判定三分支：自家同根＝已在跑（{kind:'running'}）；显式端口遇别根/他人
 * 报错退出失败；默认段遇他人试下一端口。段内全占＝失败。 */
async function negotiatePort({ dataDir, log, data, assets, digest, options }) {
  for (const port of candidatePortsOf(options)) {
    try {
      const server = await startViewerServer({ dataDir, log, port, data, assets });
      return { kind: 'started', server };
    } catch (error) {
      if (error.code !== 'EADDRINUSE') {
        console.error(`监听端口 ${port} 失败：${error.message}`);
        return { kind: 'failed' };
      }
      if (await classifyBusyPort({ port, digest }) === 'ours') {
        return { kind: 'running', port };
      }
      if (options.port !== null) {
        console.error(`端口 ${port} 属于另一数据根的观察窗或他人进程`);
        return { kind: 'failed' };
      }
    }
  }
  console.error(`端口段 ${DEFAULT_VIEWER_PORT}–${DEFAULT_VIEWER_PORT + PORT_TRIES - 1} 全部被占用，无法启动观察窗`);
  return { kind: 'failed' };
}

/* 退出通道单点化：q 字节与 POSIX 信号共用同一 shutdown，双触发被 shuttingDown 挡下。
 * close 收敛后以码 0 显式退出——stdin 与 server 都占着事件循环，不显式退出进程不会自行结束。 */
function wireShutdown(server) {
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    server.close().then(() => process.exit(0), () => process.exit(0));
  };
  try {
    process.stdin.on('data', (chunk) => {
      for (const byte of chunk) {
        if (byte === QUIT_BYTE) {
          shutdown();
        }
      }
    });
    process.stdin.on('error', () => {});
    process.stdin.resume();
  } catch {
    // stdin 不可用（无管道/已关闭）：q 通道缺席，服务照常运行，其余退出通道不受影响
  }
  if (process.platform !== 'win32') {
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
}

async function runLaunch({ dataDir, options }) {
  const digest = rootDigest(dataDir);
  const log = { warn: (...args) => console.error(...args) };
  const data = createViewerData({ dataDir, log });
  const assets = { INDEX_HTML, APP_JS, STYLE_CSS };
  const outcome = await negotiatePort({ dataDir, log, data, assets, digest, options });
  if (outcome.kind === 'failed') {
    process.exitCode = EXIT_ERROR;
    return;
  }
  if (outcome.kind === 'running') {
    reportRunning({ port: outcome.port, noOpen: options.noOpen });
    return;
  }
  reportReady({ port: outcome.server.port, data, noOpen: options.noOpen });
  wireShutdown(outcome.server);
}

async function runStop({ dataDir, options }) {
  const result = await stopViewer({ candidatePorts: candidatePortsOf(options), digest: rootDigest(dataDir) });
  if (result.stopped) {
    console.log(`已停止（端口 ${result.port}，pid ${result.pid}）`);
    return;
  }
  if (result.reason !== undefined) {
    console.error(result.reason);
    process.exitCode = EXIT_ERROR;
    return;
  }
  console.log('未发现运行中的观察窗');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options === null) {
    console.error(USAGE);
    process.exitCode = EXIT_ERROR;
    return;
  }
  const dataDir = resolveDataDir(process.env);
  if (options.stop) {
    await runStop({ dataDir, options });
    return;
  }
  await runLaunch({ dataDir, options });
}

main().catch((error) => {
  console.error(`观察窗启动失败：${error.message}`);
  process.exitCode = EXIT_ERROR;
});
