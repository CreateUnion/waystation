import { readFileSync, renameSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { ANCHOR_PORT } from '../site.js';
import { writeJsonAtomic } from '../storage.js';

export const KNOWN_HOSTS_FILE_NAME = 'known-hosts.json';
export const MAX_KNOWN_HOSTS = 64;

/* 本文件的字符串字段只做「本地文件不荒唐」的存储级底线校验；
 * 线上协议的严格校验在 protocol.js——两层目的不同，边界可以不同。 */
const MAX_TEXT_CHARS = 128;
const STORAGE_VERSION = 2;

/* 已知主机清单（设计 §5，模型 A）：单播兜底扫描的目标来源 = 历史见过的「地址:端口」。
 * 探测来源与扫描应答都会写入它——广播单向盲区（实测：桥接 VM→宿主广播未达、单播可达）靠它反向补偿；
 * 同机多站点各占「地址:端口」一条，键即该组合。
 * 存储 1→2 版：旧条目（键=地址、无 port）按锚点端口解释——旧版站点全部取默认端口，默认配置下语义等价；
 * 不引入文件级迁移（下一次写入即 v2 形态）。
 * 写入失败只告警不抛出：清单是发现辅助，丢失不得影响主流程（健壮性硬性要求）。 */
export function createKnownHosts({ dataDir, log }) {
  const state = {
    file: join(dataDir, KNOWN_HOSTS_FILE_NAME),
    log,
    hosts: new Map(),   // 键 = 「地址:端口」
    counters: { invalidEntries: 0, writeFailures: 0, remembered: 0 },
  };
  loadFromDisk(state);
  return {
    list: () => listOf(state),
    targets: () => targetsOf(state),
    remember: (entry) => remember(state, entry),
    stats: () => ({ ...state.counters, entries: state.hosts.size }),
  };
}

/* 按最近见过时间降序——扫描列表与单播兜底都优先最近活跃的地址 */
function listOf(state) {
  return [...state.hosts.values()].sort((left, right) => Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt));
}

/* 单播兜底的目标解析（择新口径）：按实例标识去重、取 lastSeenAt 最新条目——
 * 同一站点换地址/换端口后的历史残留只取最近活跃的一条；实例标识未知（空串）的条目按「地址:端口」各自保留，
 * 不是同一站点的证据不合并（宁可多发一个探测，不可漏掉一个可达目标）。 */
function targetsOf(state) {
  const newest = new Map();
  for (const entry of state.hosts.values()) {
    const key = entry.instanceId !== '' ? entry.instanceId : keyOf(entry);
    const held = newest.get(key);
    if (held === undefined || Date.parse(entry.lastSeenAt) > Date.parse(held.lastSeenAt)) {
      newest.set(key, entry);
    }
  }
  return [...newest.values()].map((entry) => ({ address: entry.address, port: entry.port }));
}

function keyOf(entry) {
  return `${entry.address}:${entry.port}`;
}

function loadFromDisk(state) {
  /** @type {string | null} */
  let raw = null;
  try {
    raw = readFileSync(state.file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      state.log.warn('已知主机清单读取失败，按空清单起步', { reason: error.message });
    }
  }
  if (raw === null) {
    return;   // 文件不存在（或不可读，已留痕）：按空清单起步
  }
  const parsed = parseJson(raw);
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.hosts)) {
    quarantine(state);
    return;
  }
  for (const entry of parsed.hosts) {
    const checked = validateEntry(entry);
    if (checked === null) {
      state.counters.invalidEntries++;
      continue;
    }
    state.hosts.set(keyOf(checked), checked);
  }
  // 载入同样受上限约束：超限文件（手改/旧版本残留）在起步时即按最近时间收敛，与 remember 同一淘汰口径
  evictOverflow(state);
}

/* 损坏文件保留 .corrupt- 副本后按空清单起步：副本是排查依据，避免「静默清零」丢证据。 */
function quarantine(state) {
  const backup = `${state.file}.corrupt-${Date.now()}`;
  try {
    renameSync(state.file, backup);
    state.log.warn('已知主机清单损坏，已保留副本、按空清单起步', { backup });
  } catch (error) {
    state.log.warn('已知主机清单损坏且保留副本失败，按空清单起步', { reason: error.message });
  }
}

function remember(state, entry) {
  const { address, port, instanceId, identityName } = entry;
  if (typeof address !== 'string' || isIP(address) === 0 || !isPort(port)) {
    state.counters.invalidEntries++;
    state.log.warn('忽略非法来源地址或端口（不入清单）', { address: String(address), port: String(port) });
    return;
  }
  state.counters.remembered++;
  const stored = {
    address,
    port,
    instanceId: boundedText(instanceId),
    identityName: boundedText(identityName),
    lastSeenAt: new Date().toISOString(),
  };
  state.hosts.delete(keyOf(stored));
  state.hosts.set(keyOf(stored), stored);
  evictOverflow(state);
  persist(state);
}

function evictOverflow(state) {
  while (state.hosts.size > MAX_KNOWN_HOSTS) {
    let oldestKey = '';
    let oldestSeen = Number.POSITIVE_INFINITY;   // 找最小时间戳：初值取 +∞ 保证首轮必被取代
    for (const entry of state.hosts.values()) {
      const seen = Date.parse(entry.lastSeenAt);
      if (seen < oldestSeen) {
        oldestSeen = seen;
        oldestKey = keyOf(entry);
      }
    }
    state.hosts.delete(oldestKey);
  }
}

function persist(state) {
  try {
    writeJsonAtomic(state.file, { version: STORAGE_VERSION, hosts: [...state.hosts.values()] });
  } catch (error) {
    state.counters.writeFailures++;
    state.log.warn('已知主机清单写入失败（内存态继续可用）', { reason: error.message });
  }
}

function validateEntry(entry) {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return null;
  }
  if (typeof entry.address !== 'string' || isIP(entry.address) === 0) {
    return null;
  }
  /* 缺 port = v1 旧条目：按锚点端口解释；有 port 但非法 = 损坏条目（拒绝优于猜测）。 */
  const port = entry.port === undefined ? ANCHOR_PORT : entry.port;
  if (!isPort(port)) {
    return null;
  }
  const lastSeenAt = typeof entry.lastSeenAt === 'string' && !Number.isNaN(Date.parse(entry.lastSeenAt))
    ? entry.lastSeenAt
    : new Date(0).toISOString();
  return {
    address: entry.address,
    port,
    instanceId: boundedText(entry.instanceId),
    identityName: boundedText(entry.identityName),
    lastSeenAt,
  };
}

function isPort(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

function boundedText(value) {
  return typeof value === 'string' && value.length <= MAX_TEXT_CHARS ? value : '';
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
