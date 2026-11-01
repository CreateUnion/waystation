import { execFileSync } from 'node:child_process';
import { freemem, totalmem } from 'node:os';

/* #14 资源感知的只读探测面：内存取 node:os（跨平台、零依赖）；进程数没有 Node 内置 API，
 * 按平台读系统进程清单（Windows tasklist / POSIX ps）。这是诊断辅助数据，不是资源裁决器：
 * 探测失败一律计零并继续，绝不阻断 ws_status / 收编主链。
 *
 * 进程清单有子进程开销，短时缓存 5 秒：ws_status 与 claim 常在同一轮操作里连续调用，
 * 不值得为同一份清单反复拉进程表。缓存只影响计数新鲜度，不影响内存实测值。 */

const MIB = 1024 * 1024;
const PROCESS_LIST_TIMEOUT_MS = 3000;
const PROCESS_LIST_CACHE_MS = 5000;
/* 进程名归类：claude / node 本体与其带分隔符的变体（如 claude.exe、claude-code、node.exe）；
 * 不把 claudia / node_exporter 之类同前缀无关进程算进来。 */
const CLAUDE_PROCESS_NAME = /^claude(?:$|[-.])/;
const NODE_PROCESS_NAME = /^node(?:$|[-.])/;

let processListCache = { at: Number.NEGATIVE_INFINITY, value: '' };

/** 空闲内存 MB（取整）：dispatch 资源阈值与状态面共用。 */
export function freeMemMBOf(freememFn = freemem) {
  return Math.round(freememFn() / MIB);
}

/**
 * host.resources 的单一产出点。
 * options 全部可注入（单测 / 确定性阈值用例）；生产调用不带参数，走真实 os 与进程清单。
 * @param {{
 *   freeMemBytesOf?: () => number,
 *   totalMemBytesOf?: () => number,
 *   processList?: string,
 * }} [options]
 */
export function hostResourcesOf(options = {}) {
  const freeMemBytesOf = options.freeMemBytesOf ?? freemem;
  const totalMemBytesOf = options.totalMemBytesOf ?? totalmem;
  const counts = parseProcessListing(options.processList ?? cachedProcessList(), process.platform);
  return {
    freeMemMB: Math.round(freeMemBytesOf() / MIB),
    totalMemMB: Math.round(totalMemBytesOf() / MIB),
    claudeProcs: counts.claudeProcs,
    nodeProcs: counts.nodeProcs,
  };
}

/**
 * 进程清单纯解析：Windows tasklist CSV 取第一列镜像名；POSIX ps 的 comm 取 basename。
 * 空行 / 缺字段 / 无法识别的行一律跳过。
 * @param {string | null | undefined} listing
 * @param {NodeJS.Platform} [platform]
 */
export function parseProcessListing(listing, platform = process.platform) {
  const counts = { claudeProcs: 0, nodeProcs: 0 };
  for (const line of String(listing ?? '').split(/\r?\n/)) {
    const name = processNameOf(line, platform);
    if (CLAUDE_PROCESS_NAME.test(name)) {
      counts.claudeProcs++;
    } else if (NODE_PROCESS_NAME.test(name)) {
      counts.nodeProcs++;
    }
  }
  return counts;
}

function processNameOf(line, platform) {
  const text = line.trim();
  if (text === '') {
    return '';
  }
  return basenameOf(platform === 'win32' ? windowsImageNameOf(text) : text).toLowerCase();
}

function windowsImageNameOf(line) {
  const quoted = /^"([^"]+)"/.exec(line);
  return quoted === null ? line.split(',')[0] : quoted[1];
}

function basenameOf(value) {
  const segments = value.split(/[\\/]/);
  return segments[segments.length - 1].replace(/\.exe$/i, '');
}

function cachedProcessList() {
  const now = Date.now();
  if (now - processListCache.at < PROCESS_LIST_CACHE_MS) {
    return processListCache.value;
  }
  const value = readProcessList();
  processListCache = { at: now, value };
  return value;
}

function readProcessList() {
  const isWindows = process.platform === 'win32';
  try {
    return execFileSync(
      isWindows ? 'tasklist' : 'ps',
      isWindows ? ['/FO', 'CSV', '/NH'] : ['-A', '-o', 'comm='],
      { encoding: 'utf8', timeout: PROCESS_LIST_TIMEOUT_MS, windowsHide: true },
    );
  } catch {
    return '';
  }
}
