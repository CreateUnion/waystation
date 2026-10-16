import { readFileSync, renameSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { isPort } from './protocol.js';
import { shortSessionId } from '../util/short-id.js';
import { ANCHOR_PORT } from '../site.js';
import { writeJsonAtomic } from '../storage.js';

export const KNOWN_HOSTS_FILE_NAME = 'known-hosts.json';
export const MAX_KNOWN_HOSTS = 64;
/* 每个条目的会话短码上限：会话段是「顺带可见性」（清单不承载权威列表），
 * 超限截断保证条目与整文件体积皆有界。 */
export const MAX_KNOWN_SESSIONS = 32;

/* 本文件的字符串字段只做「本地文件不荒唐」的存储级底线校验；
 * 线上协议的严格校验在 protocol.js——两层目的不同，边界可以不同。 */
const MAX_TEXT_CHARS = 128;
const STORAGE_VERSION = 3;

/* 落盘节流窗口（模块私有）：协作域逐帧的端点学习会走到 remember——同键的 lastSeenAt 刷新
 * 按窗口合并写盘（内存态仍逐帧新鲜、择新排序不受影响）；新键（新站点）立即落盘，
 * 保证崩溃重启不至于丢掉刚认识的目标。清单是发现辅助、写失败可容忍，窗口内合并的代价可接受。 */
const PERSIST_MIN_INTERVAL_MS = 5000;

/* 已知主机清单（设计 §5，模型 A）：单播兜底扫描的目标来源 = 历史见过的「地址:端口」。
 * 探测来源与扫描应答都会写入它——广播单向盲区（实测：桥接 VM→宿主广播未达、单播可达）靠它反向补偿；
 * 同机多站点各占「地址:端口」一条，键即该组合。
 * 存储 1→2 版：旧条目（键=地址、无 port）按锚点端口解释——旧版站点全部取默认端口，默认配置下语义等价。
 * 存储 2→3 版：条目增可选 `sessions`（对端活跃会话短码，见会话级管理设计 §1）——旧条目缺字段＝未知，
 * 与「对端报了零会话」（空数组）是两个语义，不混同；不引入文件级迁移（下一次写入即 v3 形态）。
 * 写入失败只告警不抛出：清单是发现辅助，丢失不得影响主流程（健壮性硬性要求）。 */
export function createKnownHosts({ dataDir, log, persistMinIntervalMs = PERSIST_MIN_INTERVAL_MS }) {
  const state = {
    file: join(dataDir, KNOWN_HOSTS_FILE_NAME),
    log,
    persistMinIntervalMs,
    lastPersistMs: 0,
    hosts: new Map(),   // 键 = 「地址:端口」
    counters: { invalidEntries: 0, writeFailures: 0, remembered: 0 },
  };
  loadFromDisk(state);
  return {
    list: () => listOf(state),
    targets: () => targetsOf(state),
    remember: (entry) => remember(state, entry),
    lookup: (instanceId) => lookup(state, instanceId),
    stats: () => ({ ...state.counters, entries: state.hosts.size }),
  };
}

/* 按最近见过时间降序——扫描列表与单播兜底都优先最近活跃的地址 */
function listOf(state) {
  return [...state.hosts.values()].sort((left, right) => Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt));
}

/* 按站点实例标识取最近地址（治理转达 / 抢接广播的跨协作寻址回退面）：未见过返回 null。
 * 清单是站点级全局视野（含其他协作学到的地址）——跨协作的治理触达由此闭合。 */
function lookup(state, instanceId) {
  if (typeof instanceId !== 'string' || instanceId === '') {
    return null;
  }
  const entry = listOf(state).find((candidate) => candidate.instanceId === instanceId);
  return entry === undefined ? null : { address: entry.address, port: entry.port };
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
  const { address, port, instanceId, identityName, sessions: sessionInput } = entry;
  if (typeof address !== 'string' || isIP(address) === 0 || !isPort(port)) {
    state.counters.invalidEntries++;
    state.log.warn('忽略非法来源地址或端口（不入清单）', { address: String(address), port: String(port) });
    return;
  }
  state.counters.remembered++;
  /** @type {{ address: string, port: number, instanceId: string, identityName: string, lastSeenAt: string, sessions?: string[] }} */
  const stored = {
    address,
    port,
    instanceId: boundedText(instanceId),
    identityName: boundedText(identityName),
    lastSeenAt: new Date().toISOString(),
  };
  const sessions = boundedSessions(sessionInput);
  if (sessions !== null) {
    stored.sessions = sessions;   // 未知（null）则字段缺席：重载后仍是未知（不臆断成零会话）
  }
  const key = keyOf(stored);
  const isNewKey = !state.hosts.has(key);
  state.hosts.delete(key);
  state.hosts.set(key, stored);
  evictOverflow(state);
  if (isNewKey || Date.now() - state.lastPersistMs >= state.persistMinIntervalMs) {
    persist(state);
  }
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
    state.lastPersistMs = Date.now();
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
  /** @type {{ address: string, port: number, instanceId: string, identityName: string, lastSeenAt: string, sessions?: string[] }} */
  const checked = {
    address: entry.address,
    port,
    instanceId: boundedText(entry.instanceId),
    identityName: boundedText(entry.identityName),
    lastSeenAt: storedLastSeenAt(entry.lastSeenAt),
  };
  const sessions = boundedSessions(entry.sessions);
  if (sessions !== null) {
    checked.sessions = sessions;
  }
  return checked;
}

/* 时间戳读取：认不出即归零时刻（条目仍有效——时间只影响排序与淘汰，不值得为一枚坏时间戳丢掉整条地址） */
function storedLastSeenAt(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : new Date(0).toISOString();
}

/* 会话段的形态底线：数组即短码化并截断（对外一律短码——短码化是唯一权威的呈现加工）；
 * 非数组＝未知（返回 null，调用方整段不落），未知与「零会话」（空数组）是两个语义，不混同。 */
function boundedSessions(value) {
  if (!Array.isArray(value)) {
    return null;
  }
  const codes = [];
  for (const item of value) {
    if (typeof item !== 'string' || item === '') {
      continue;   // 非字符串与空串不入清单：对端整形的良心不由本层假设
    }
    codes.push(shortSessionId(item));
    if (codes.length >= MAX_KNOWN_SESSIONS) {
      break;
    }
  }
  return codes;
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
