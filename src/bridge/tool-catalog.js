import { statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { TOOL_SPECS } from '../tools/specs.js';

/* 桥的工具目录热刷新（已开会话无需 /mcp 重连）：
 * 桥进程由 MCP 客户端托管，进程自身的代码无法安全自重启；但工具目录（name / description /
 * inputSchema）是 MCP 客户端唯一可见的契约面。安装树 specs.js 在核心换代 / 重装后变化时，
 * 本模块按文件 mtime+size（或核心 welcome.app 与桥版本不同时强制）重新 import 新目录，
 * 桥的 registry.list() 随即返回新目录，并由 MCP 层发 tools/list_changed 通知客户端重拉。
 *
 * 边界：只热刷新「目录数据」；桥进程的行为代码仍是启动时的版本。桥是薄转发件，核心功能
 * 在核侧——目录刷新已覆盖会话可见面；桥行为代码的升级仍需重开会话。 */

const DEFAULT_SPECS_URL = new URL('../tools/specs.js', import.meta.url);

/** @param {any} [options] */
export function createToolCatalog(options = {}) {
  const url = normalizeUrl(options.specsUrl ?? DEFAULT_SPECS_URL);
  const log = options.log ?? null;
  const load = options.load ?? loadSpecsModule;
  const stampOf = options.stampOf ?? fileStampOf;
  let specs = options.initialSpecs ?? TOOL_SPECS;
  let stamp = options.initialStamp ?? stampOf(url);
  return {
    list: () => specs,
    stamp: () => stamp,
    /** @param {{ force?: boolean }} [refreshOptions] */
    refresh: (refreshOptions = {}) => refreshCatalog({
      url, log, load, stampOf, force: refreshOptions.force === true,
      current: () => ({ specs, stamp }),
      commit: (nextSpecs, nextStamp) => { specs = nextSpecs; stamp = nextStamp; },
    }),
  };
}

async function refreshCatalog({ url, log, load, stampOf, force, current, commit }) {
  const nextStamp = stampOf(url);
  if (nextStamp === null) {
    return { changed: false, reason: 'missing' };
  }
  if (shouldSkipRefresh({ force, nextStamp, currentStamp: current().stamp })) {
    return { changed: false };
  }
  const loaded = await loadCatalogSafely({ url, nextStamp, load, log });
  if (loaded.ok === false) {
    return { changed: false, reason: loaded.reason };
  }
  if (!validSpecs(loaded.value)) {
    log?.warn?.('桥工具目录形态非法，继续使用旧目录', { entries: Array.isArray(loaded.value) ? loaded.value.length : null });
    return { changed: false, reason: 'invalid' };
  }
  /* 内容未变（例如同版本重装、核心换代但目录一致）：只推进时间戳，不替换、不通知客户端。 */
  if (sameSpecs(loaded.value, current().specs)) {
    commit(current().specs, nextStamp);
    return { changed: false };
  }
  commit(loaded.value, nextStamp);
  return { changed: true };
}

function sameSpecs(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function shouldSkipRefresh({ force, nextStamp, currentStamp }) {
  return force !== true && sameStamp(nextStamp, currentStamp);
}

async function loadCatalogSafely({ url, nextStamp, load, log }) {
  try {
    return { ok: true, value: await load(url, nextStamp) };
  } catch (error) {
    log?.warn?.('桥工具目录载入失败，继续使用旧目录', { reason: error?.message ?? String(error) });
    return { ok: false, reason: 'load-failed' };
  }
}

/* 动态导入带缓存破坏参数：Node 的 ESM 缓存按 URL 全串区分，同一文件换 query 即重新求值。 */
async function loadSpecsModule(url, stamp) {
  const fresh = new URL(url.href);
  fresh.searchParams.set('v', `${Math.round(stamp.mtimeMs)}-${stamp.size}`);
  const module = await import(fresh.href);
  return module.TOOL_SPECS;
}

function fileStampOf(url) {
  try {
    const stat = statSync(url);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

function sameStamp(a, b) {
  return b !== null && a.mtimeMs === b.mtimeMs && a.size === b.size;
}

/* 新目录只做形态校验（工具名唯一、描述与 schema 齐备）——内容由 specs.js 的冻结测试守护。 */
function validSpecs(specs) {
  if (!Array.isArray(specs) || specs.length === 0) {
    return false;
  }
  const names = new Set();
  for (const spec of specs) {
    if (!validSpecEntry(spec, names)) {
      return false;
    }
    names.add(spec.name);
  }
  return true;
}

function validSpecEntry(spec, names) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    return false;
  }
  if (typeof spec.name !== 'string' || spec.name === '' || names.has(spec.name)) {
    return false;
  }
  if (typeof spec.description !== 'string') {
    return false;
  }
  return spec.inputSchema !== null && typeof spec.inputSchema === 'object' && !Array.isArray(spec.inputSchema);
}

function normalizeUrl(value) {
  return value instanceof URL ? value : pathToFileURL(String(value));
}
