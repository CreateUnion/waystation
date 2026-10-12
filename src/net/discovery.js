import dgram from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { MAX_COLLAB_COUNT, MAX_DATAGRAM_BYTES, PROTOCOL_VERSION, validateProbe, validateProbeAck } from './protocol.js';

export const DISCOVERY_REPLY_MIN_INTERVAL_MS = 250;
const MAX_THROTTLED_SOURCES = 64;

/* 定向广播地址计算：按接口逐卡收发，不依赖全局广播路由（设计 §5）。
 * 取 ip | ~netmask；无广播意义的场合（/32、缺掩码、IPv6、内网接口）跳过；同网段多网卡自动去重。 */
export function broadcastTargets(interfaces) {
  const targets = new Set();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      const target = broadcastOf(entry);
      if (target !== null) {
        targets.add(target);
      }
    }
  }
  return [...targets];
}

/* UDP 发现（设计 §5）：会话期间在全部网卡监听、按接口逐卡收发、应答探测；
 * 扫描 = 广播 + 已知主机单播兜底，窗口内收应答、按实例标识去重合并。
 * 入站校验基线：每次数据报都过体积/解析/字段校验，失败拒绝并计数（设计 §10）。
 * 独占绑定（reuseAddr 关闭）是「本机已有驿站」检测成立的前提——第二实例必须拿到 EADDRINUSE。
 * 生命周期一次性（start → scan* → close），调用时序由装配层保证：close 后套接字已关闭，
 * 再次 start/scan 会以套接字错误失败（吵闹而非挂起）——失败即安全网，不属可依赖的语义。 */
export function createDiscovery({ port, bindAddress = '0.0.0.0', instanceId, identityName, getCollabCount, knownHosts, log }) {
  const state = {
    port,
    bindAddress,
    instanceId,
    identityName,
    getCollabCount,
    knownHosts,
    log,
    socket: dgram.createSocket({ type: 'udp4', reuseAddr: false }),
    counters: {
      datagramsIn: 0,
      probesAnswered: 0,
      probeResponses: 0,
      selfObserved: 0,
      rateLimited: 0,
      sendFailures: 0,
      rejected: { oversize: 0, malformed: 0, invalid: 0 },
    },
    collectors: new Set(),
    lastSourceAt: new Map(),   // 同源最小间隔记账：探测应答限流与两路入站的清单落盘节流共用一张表
    bound: false,
    closed: false,
  };
  state.socket.on('message', (buffer, rinfo) => {
    onDatagram(state, buffer, rinfo);
  });
  state.socket.on('error', (error) => {
    log.warn('发现套接字错误（不退出进程）', { reason: error.message });
  });
  return {
    start: () => start(state),
    close: () => close(state),
    scan: (options) => scan(state, options),
    stats: () => statsOf(state),
  };
}

function start(state) {
  // resolve 无参调用：显式 Promise<void> 让类型检查接受 0 参 resolve
  return /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
    state.socket.once('error', reject);
    state.socket.bind({ port: state.port, address: state.bindAddress, exclusive: true }, () => {
      state.socket.removeListener('error', reject);
      state.socket.setBroadcast(true);
      state.bound = true;
      resolve();
    });
  }));
}

async function close(state) {
  if (state.closed) {
    return;
  }
  state.closed = true;
  if (!state.bound) {
    try {
      state.socket.close();
    } catch {
      // 未绑定成功的套接字无需关闭
    }
    return;
  }
  // resolve 作为 0 参回调交给 socket.close：显式 Promise<void> 让类型检查接受「无参 resolve」
  await /** @type {Promise<void>} */ (new Promise((resolve) => {
    state.socket.close(resolve);
  }));
  state.bound = false;   // 绑定事实随关闭归位：状态面不得继续展示已失效的绑定
}

function statsOf(state) {
  return { ...state.counters, rejected: { ...state.counters.rejected }, bound: state.bound, scanning: state.collectors.size };
}

function onDatagram(state, buffer, rinfo) {
  state.counters.datagramsIn++;
  if (buffer.length > MAX_DATAGRAM_BYTES) {
    state.counters.rejected.oversize++;
    state.log.warn('发现报文超体积上限，拒绝', { from: rinfo.address, bytes: buffer.length });
    return;
  }
  const parsed = parseObject(buffer);
  if (parsed === 'malformed') {
    state.counters.rejected.malformed++;
    state.log.warn('发现报文不是合法 JSON 对象，拒绝', { from: rinfo.address });
    return;
  }
  if (parsed.type === 'probe') {
    handleProbe(state, parsed, rinfo);
    return;
  }
  if (parsed.type === 'probe-ack') {
    handleResponse(state, parsed, rinfo);
    return;
  }
  state.counters.rejected.invalid++;
  state.log.warn('未知发现报文类型，拒绝', { from: rinfo.address, type: String(parsed.type) });
}

function handleProbe(state, datagram, rinfo) {
  const checked = validateProbe(datagram);
  if (!checked.ok) {
    state.counters.rejected.invalid++;
    state.log.warn('探测报文校验失败，拒绝', { from: rinfo.address, reason: checked.reason });
    return;
  }
  if (datagram.instanceId === state.instanceId) {
    state.counters.selfObserved++;
    return;   // 排除自答：自己的探测（含单播到自己）不回应、不入清单
  }
  /* 同源最小间隔：窗口内同来源的探测不再应答、也不重复记入清单——
   * 伪造探测洪泛不放大为「清单整文件原子落盘」的写风暴（扫描只需一个应答即去重合并）。 */
  if (!withinMinInterval(state, rinfo.address)) {
    state.counters.rateLimited++;
    return;
  }
  // 探测来源也是「历史见过地址」：广播单向盲区里对方能广播过来、我们回不去——记下它，下次扫描单播补上
  state.knownHosts.remember({ address: rinfo.address, instanceId: datagram.instanceId, identityName: datagram.identityName });
  sendDatagram(state, buildProbeAck(state), rinfo.port, rinfo.address, 'probe-ack');
  state.counters.probesAnswered++;
}

/* 同源最小间隔记账（唯一机制）：窗口内返回 false，窗口外刷新时间戳并放行。
 * 刷新的键移到 Map 尾部、淘汰取首键 —— 表按「最近刷新」维护且容量有界；
 * 首个包必然放行（表无记录时差值为「当前时间-0」）——合法扫描的首个探测/应答必经此路。 */
function withinMinInterval(state, address) {
  const now = Date.now();
  if (now - (state.lastSourceAt.get(address) ?? 0) < DISCOVERY_REPLY_MIN_INTERVAL_MS) {
    return false;
  }
  state.lastSourceAt.delete(address);
  state.lastSourceAt.set(address, now);
  if (state.lastSourceAt.size > MAX_THROTTLED_SOURCES) {
    state.lastSourceAt.delete(state.lastSourceAt.keys().next().value);
  }
  return true;
}

function handleResponse(state, datagram, rinfo) {
  const checked = validateProbeAck(datagram);
  if (!checked.ok) {
    state.counters.rejected.invalid++;
    state.log.warn('扫描应答校验失败，拒绝', { from: rinfo.address, reason: checked.reason });
    return;
  }
  state.counters.probeResponses++;
  if (datagram.instanceId === state.instanceId) {
    state.counters.selfObserved++;
    return;
  }
  /* 同源节流同样罩住应答来源的清单写入：伪造应答洪泛与伪造探测洪泛共用同一张表，同样不放大为
   * 整文件原子写的风暴。扫描合并不受限（内存态）：同一实例多地址的合并依赖逐应答处理。 */
  if (withinMinInterval(state, rinfo.address)) {
    state.knownHosts.remember({ address: rinfo.address, instanceId: datagram.instanceId, identityName: datagram.identityName });
  } else {
    state.counters.rateLimited++;
  }
  for (const collector of state.collectors) {
    mergeResponse(collector, datagram, rinfo.address);
  }
}

function mergeResponse(collector, datagram, address) {
  const entry = collector.get(datagram.instanceId) ?? {
    instanceId: datagram.instanceId,
    identityName: datagram.identityName,
    addresses: [],
    collabCount: 0,
    lastSeenAt: '',
  };
  if (!entry.addresses.includes(address)) {
    entry.addresses.push(address);   // 首选地址 = 首个应答来源地址（数组序即接收序）
  }
  entry.identityName = datagram.identityName;
  entry.collabCount = datagram.collabCount;
  entry.lastSeenAt = new Date().toISOString();
  collector.set(datagram.instanceId, entry);
}

function buildProbeAck(state) {
  return Buffer.from(JSON.stringify({
    v: PROTOCOL_VERSION,
    type: 'probe-ack',
    instanceId: state.instanceId,
    identityName: state.identityName,
    collabCount: currentCollabCount(state),
  }));
}

/* 报数值域与对端入站校验（protocol.js）对称：超上限钳制、非整数/负数归 0——
 * 上游给出越界值不得让对端以「collabCount 非法」拒收本端应答。 */
function currentCollabCount(state) {
  try {
    const count = state.getCollabCount();
    if (Number.isInteger(count) && count >= 0) {
      return Math.min(count, MAX_COLLAB_COUNT);
    }
    return 0;
  } catch (error) {
    state.log.warn('参与协作数取值失败，按 0 应答', { reason: error.message });
    return 0;
  }
}

function sendDatagram(state, buffer, targetPort, targetAddress, kind) {
  state.socket.send(buffer, targetPort, targetAddress, (error) => {
    if (error) {
      state.counters.sendFailures++;
      state.log.warn('发现报文发送失败', { kind, address: targetAddress, reason: error.message });
    }
  });
}

async function scan(state, { windowMs }) {
  if (!Number.isInteger(windowMs) || windowMs < 1 || windowMs > 60000) {
    throw new TypeError('scan 需要合法的 windowMs（1–60000 毫秒）');
  }
  const collector = new Map();
  state.collectors.add(collector);
  try {
    const targets = new Set([...broadcastTargets(networkInterfaces()), ...state.knownHosts.addresses()]);
    const probe = Buffer.from(JSON.stringify({ v: PROTOCOL_VERSION, type: 'probe', instanceId: state.instanceId, identityName: state.identityName }));
    for (const address of targets) {
      sendDatagram(state, probe, state.port, address, 'probe');
    }
    await new Promise((resolve) => setTimeout(resolve, windowMs));
  } finally {
    state.collectors.delete(collector);
  }
  return [...collector.values()].sort(compareHosts);
}

function broadcastOf(entry) {
  if (entry === null || typeof entry !== 'object' || entry.family !== 'IPv4' || entry.internal === true) {
    return null;
  }
  if (typeof entry.address !== 'string' || typeof entry.netmask !== 'string') {
    return null;
  }
  const address = ipToInt(entry.address);
  const mask = ipToInt(entry.netmask);
  if (address === null || mask === null) {
    return null;
  }
  const broadcast = intToIp((address | (~mask >>> 0)) >>> 0);
  return broadcast === entry.address ? null : broadcast;
}

/* IPv4 与 32 位整数互转（位运算把四段字节打包；>>> 0 归一到无符号） */
function ipToInt(text) {
  const parts = text.split('.').map(Number);
  if (parts.length !== 4 || !parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    return null;
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function intToIp(value) {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

/** @returns {Record<string, unknown> | 'malformed'} */
function parseObject(buffer) {
  /** @type {unknown} */
  let parsed = null;
  try {
    parsed = JSON.parse(buffer.toString('utf8'));
  } catch {
    // 解析失败与「解析结果非对象」共用出口：都归 'malformed'
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'malformed';
  }
  return /** @type {Record<string, unknown>} */ (parsed);
}

function compareHosts(left, right) {
  return left.identityName.localeCompare(right.identityName, 'zh-Hans-CN')
    || left.instanceId.localeCompare(right.instanceId);
}
