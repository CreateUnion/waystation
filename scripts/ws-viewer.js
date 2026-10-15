/* 人类观察窗的组合根入口：参数解析（--focus / --port / --no-open / --stop）、启动协商接线、就绪行、
 * 开窗与退出通道。启动链的判定（探针 / 归属 / 端口协商 / 开窗计划 / 停止）都在 src/viewer/launch.js
 * 的注入式函数里，本文件只做接线与输出。
 *
 * 退出通道单点化：stdin 的 q 字节与 POSIX 信号共用同一个 shutdown——server.close 非幂等
 * （重复调用 reject ERR_SERVER_NOT_RUNNING），双触发必须挡在单点之前。Windows 下 --stop 是
 * 硬终止：Node 在 Windows 不投递 SIGTERM 处理器，进程被直接结束、没有优雅退出机会
 * （平台差异由设计 §4.1 写明）。 */

import {
  buildOpenCommand,
  DEFAULT_VIEWER_PORT,
  locateEdge,
  negotiateViewerPort,
  openWindow,
  PORT_TRIES,
  rootDigest,
  stopViewer,
} from '../src/viewer/launch.js';
import { INDEX_HTML, APP_JS, STYLE_CSS } from '../src/viewer/assets.js';
import { createViewerData } from '../src/viewer/data.js';
import { startViewerServer } from '../src/viewer/server.js';
import { ID_PATTERN } from '../src/net/protocol.js';
import { resolveDataDir } from '../src/paths.js';

const USAGE = '用法：node scripts/ws-viewer.js [--focus <root>/<id>] [--port N] [--no-open] [--stop]';
/* 用户可见故障统一退出码 2（用法错误、端口不可得、kill 失败——设计 §4.1/§4.2）。 */
const EXIT_ERROR = 2;
/* q 字节（ASCII 0x71）＝e2e 收尾的优雅退出通道；只认显式字节，EOF/关闭不触发退出
 * （双击启动等无 stdin 场景不受影响）。 */
const QUIT_BYTE = 0x71;
const MAX_PORT = 65535;
/* --focus 的 root 白名单（main｜s<2..8>——槽位 1 即 main，槽位上限 8）：URL 只由受控取值拼接。 */
const FOCUS_ROOT_PATTERN = /^(main|s[2-8])$/;

/* 端口值：十进制正整数 1–65535；其余（含缺值 undefined、带符号、超界）＝null → 用法错误。 */
function parsePortValue(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    return null;
  }
  const port = Number(value);
  return port >= 1 && port <= MAX_PORT ? port : null;
}

/* --focus 取值 `<root>/<id>` 的形态校验：root 白名单＋id 过 ID_PATTERN（与协作面路由同一权威）。
 * 非法＝null → 用法错误：URL 只由受控取值拼接。 */
function parseFocusValue(value) {
  const slash = typeof value === 'string' ? value.indexOf('/') : -1;
  if (slash < 0) {
    return null;
  }
  const root = value.slice(0, slash);
  const id = value.slice(slash + 1);
  if (!FOCUS_ROOT_PATTERN.test(root) || !ID_PATTERN.test(id)) {
    return null;
  }
  return { root, id };
}

/* 参数解析：四开关，未知选项/位置参数/--port、--focus 取值非法 → null（调用方按用法错误处置——
 * 用户显式调用的程序，错误必须可见）。重复 --port/--focus 以最后一个为准；--focus 与 --stop
 * 语义互斥（停止不涉及定位）→ 同按用法错误。 */
function parseArgs(args) {
  const options = { port: null, noOpen: false, stop: false, focus: null };
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
    } else if (arg === '--focus') {
      const focus = parseFocusValue(args[index + 1]);
      if (focus === null) {
        return null;
      }
      options.focus = focus;
      index++;
    } else {
      return null;
    }
  }
  if (options.focus !== null && options.stop) {
    return null;
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

/* 打开的地址：带 --focus 时指向该协作详情页（含 hash），否则列表页。 */
function viewerUrlOf(port, focus) {
  const base = `http://127.0.0.1:${port}/`;
  return focus === null ? base : `${base}#/c/${focus.root}/${focus.id}`;
}

function openBrowser({ url }) {
  const platform = process.platform;
  const plan = buildOpenCommand({ platform, url, edgePath: locateEdge({ platform, env: process.env }) });
  if (!openWindow({ plan })) {
    console.error(`自动开窗失败，请手动打开：${url}`);
  }
}

function reportReady({ port, data, noOpen, focus }) {
  const url = viewerUrlOf(port, focus);
  console.log(`观察窗已就绪：${url}（协作与讨论 ${data.listCollabs().collabs.length} 台）`);
  if (!noOpen) {
    openBrowser({ url });
  }
}

/* 已在跑（同根，段内命中）分支：不再起服务，只打印该实例的地址（--no-open）或再开一个窗。 */
function reportRunning({ port, noOpen, focus }) {
  const url = viewerUrlOf(port, focus);
  console.log(`观察窗已在运行：${url}`);
  if (!noOpen) {
    openBrowser({ url });
  }
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

/* —— 启动 / 停止 —— */

/* 启动：失败文案由协商层随 outcome 一并给出（分支知识不下放组合根），本处负责打印与退出码——
 * 用户显式调用的程序，错误必须可见。 */
async function runLaunch({ dataDir, options }) {
  const digest = rootDigest(dataDir);
  const log = { warn: (...args) => console.error(...args) };
  const data = createViewerData({ dataDir, log });
  const assets = { INDEX_HTML, APP_JS, STYLE_CSS };
  const outcome = await negotiateViewerPort({
    candidatePorts: candidatePortsOf(options),
    explicitPort: options.port !== null,
    digest,
    startServer: (port) => startViewerServer({ dataDir, log, port, data, assets }),
  });
  if (outcome.kind === 'failed') {
    console.error(outcome.reason);
    process.exitCode = EXIT_ERROR;
    return;
  }
  if (outcome.kind === 'running') {
    reportRunning({ port: outcome.port, noOpen: options.noOpen, focus: options.focus });
    return;
  }
  reportReady({ port: outcome.server.port, data, noOpen: options.noOpen, focus: options.focus });
  wireShutdown(outcome.server);
}

/* 停止：n=1 保持既有单实例文案逐字节不变（设计 §4.1 与 README 已写死该行形态），n≥2 汇总清单。 */
async function runStop({ dataDir, options }) {
  const result = await stopViewer({ candidatePorts: candidatePortsOf(options), digest: rootDigest(dataDir) });
  if (result.stopped) {
    if (result.ports.length === 1) {
      console.log(`已停止（端口 ${result.ports[0]}，pid ${result.pids[0]}）`);
    } else {
      console.log(`已停止（${result.ports.length} 个：端口 ${result.ports.join('/')}）`);
    }
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
