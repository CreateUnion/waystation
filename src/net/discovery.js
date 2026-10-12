import dgram from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { ANCHOR_PORT, SLOT_COUNT } from '../site.js';
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

/* UDP 发现（设计 §5，模型 A）：会话期间在全部网卡监听、按接口逐卡收发、应答探测；
 * 扫描 = 「每个广播地址 × 槽位段逐端口」的探测 + 已知主机清单单播兜底（「地址:端口」），
 * 窗口内收应答、按实例标识去重合并（端点 = 地址:端口）。
 * 段扫是「非默认端口站点两两互见」的闭合机制：只靠应答携带端口 + 探测学习只闭合到星型（C1 评审实证）。
 * 入站校验基线：每次数据报都过体积/解析/字段校验，失败拒绝并计数（设计 §10）。
 * 独占绑定（reuseAddr 关闭）是槽位取锁语义成立的前提——第二实例必须拿到 EADDRINUSE。
 * segmentBase 为测试注入缝（生产一律缺省 = 内置锚点，不构成配置面）：段内端口即 [segmentBase, segmentBase+7]。
 * 生命周期一次性（start → scan / announce → close），调用时序由装配层保证：close 后套接字已关闭，
 * 再次 start/scan/announce 会以套接字错误失败（吵闹而非挂起）——失败即安全网，不属可依赖的语义。 */
export function createDiscovery({ port, bindAddress = '0.0.0.0', instanceId, identityName, getCollabCount, knownHosts, log, segmentBase = ANCHOR_PORT }) {
  const state = {
    port,
    bindAddress,
    instanceId,
    identityName,
    getCollabCount,
    knownHosts,
    log,
    segmentBase,
    socket: dgram.createSocket({ type: 'udp4', reuseAddr: false }),
    counters: {
      datagramsIn: 0,
      probesAnswered: 0,
      probeResponses: 0,
      selfObserved: 0,
      rateLimited: 0,
      sendFailures: 0,
      selfIntroductions: 0,
      rejected: { oversize: 0, malformed: 0, invalid: 0 },
    },
    collectors: new Set(),
    /* 两张限流表（探测与应答的防护分工）：
     * probeReplyAt 只管「探测应答的风暴」——仅由收到的探测记账，收 ack 不得抑制本应发出的探测应答；
     * writeThrottleAt 管「清单整文件原子写的风暴」——两路入站共用同一张表，伪造探测与伪造应答交替同样不放大写频。
     * 键 = 来源「地址:端口」。 */
    probeReplyAt: new Map(), writeThrottleAt: new Map(),
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
    announce: () => announce(state),
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

/* 出站目标集（扫描与启动自介共用）：每个广播地址 × 槽位段逐端口各一个 + 清单单播（「地址:端口」）。
 * 键去重防重发——同一目标（如清单命中广播网段）只发一次。 */
function outboundTargets(state) {
  const targets = new Map();
  for (const broadcast of broadcastTargets(networkInterfaces())) {
    for (let offset = 0; offset < SLOT_COUNT; offset++) {
      const port = state.segmentBase + offset;
      targets.set(`${broadcast}:${port}`, { address: broadcast, port });
    }
  }
  for (const entry of state.knownHosts.targets()) {
    targets.set(`${entry.address}:${entry.port}`, entry);
  }
  return [...targets.values()];
}

function probeDatagram(state) {
  return Buffer.from(JSON.stringify({ v: PROTOCOL_VERSION, type: 'probe', instanceId: state.instanceId, identityName: state.identityName }));
}

/* 启动自介（设计 §5）：UDP 监听就绪即发（不等 TCP）、与扫描同目标集、不收集应答、
 * 发送失败只告警不重试、每次进程启动各发一次（含崩溃自愈重启）。
 * 作用：段内监听者即时把本站点（地址:端口）记入清单——先启动方零动作即掌握后启动者。 */
function announce(state) {
  try {
    const probe = probeDatagram(state);
    for (const target of outboundTargets(state)) {
      sendDatagram(state, probe, target.port, target.address, 'announce');
    }
    state.counters.selfIntroductions++;
  } catch (error) {
    state.log.warn('启动自介发送异常（只告警不重试）', { reason: error.message });
  }
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
  /* 应答限流：窗口内同来源的探测不再应答（伪造探测洪泛不放大为应答风暴）。
   * 与清单写节流分属两张表：本表只由探测记账，收到的应答不抑制本端应答。 */
  if (!withinMinInterval(state.probeReplyAt, rinfo)) {
    state.counters.rateLimited++;
    return;
  }
  // 探测来源也是「历史见过地址」：广播单向盲区里对方能广播过来、我们回不去——记下它，下次扫描单播补上。
  // 端口取数据报来源端口（站点数据报恒出自其监听套接字——探测报文本身不带端口字段）。
  rememberThrottled(state, datagram, rinfo, { address: rinfo.address, port: rinfo.port });
  sendDatagram(state, buildProbeAck(state), rinfo.port, rinfo.address, 'probe-ack');
  state.counters.probesAnswered++;
}

/* 同源最小间隔记账（两张表共用同一实现）：键 = 来源「地址:端口」——同机多站点互为合法不同源，不被互相的窗口吞掉。
 * 代价如实记录：同一 IP 每张表各可占 MAX_THROTTLED_SOURCES 个表项（防护评估见计量用例）。
 * 窗口内返回 false，窗口外刷新时间戳并放行；刷新的键移到 Map 尾部、淘汰取首键——表按「最近刷新」维护且容量有界；
 * 首个包必然放行（表无记录时差值为「当前时间-0」）——合法扫描的首个探测/应答必经此路。 */
function withinMinInterval(table, rinfo) {
  const key = `${rinfo.address}:${rinfo.port}`;
  const now = Date.now();
  if (now - (table.get(key) ?? 0) < DISCOVERY_REPLY_MIN_INTERVAL_MS) {
    return false;
  }
  table.delete(key);
  table.set(key, now);
  if (table.size > MAX_THROTTLED_SOURCES) {
    table.delete(table.keys().next().value);
  }
  return true;
}

/* 清单写入的唯一入口（防「整文件原子写」风暴）：探测与应答两路共用同一张节流表——同源 250ms 内最多落盘一次；
 * 被节流的写入同样计入 rateLimited（入站校验基线的「忽略必须留痕」）。 */
function rememberThrottled(state, datagram, rinfo, endpoint) {
  if (!withinMinInterval(state.writeThrottleAt, rinfo)) {
    state.counters.rateLimited++;
    return;
  }
  state.knownHosts.remember({ address: endpoint.address, port: endpoint.port, instanceId: datagram.instanceId, identityName: datagram.identityName });
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
  /* 站点端口以应答字段为准（校验器保证：存在则合法）；缺失回退数据报来源端口（旧实现应答的宽容缺省）。 */
  const endpoint = { address: rinfo.address, port: datagram.port ?? rinfo.port };
  /* 清单写节流（与探测路径共用同一张表）：伪造应答洪泛不放大为整文件原子写的风暴。
   * 扫描合并不受限（内存态）：同一实例多地址的合并依赖逐应答处理。 */
  rememberThrottled(state, datagram, rinfo, endpoint);
  for (const collector of state.collectors) {
    mergeResponse(collector, datagram, endpoint);
  }
}

function mergeResponse(collector, datagram, endpoint) {
  const entry = collector.get(datagram.instanceId) ?? {
    instanceId: datagram.instanceId,
    identityName: datagram.identityName,
    endpoints: [],
    collabCount: 0,
    lastSeenAt: '',
  };
  if (!entry.endpoints.some((held) => held.address === endpoint.address && held.port === endpoint.port)) {
    entry.endpoints.push(endpoint);   // 首选端点 = 首个应答来源（数组序即接收序）
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
    port: state.port,
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
    const probe = probeDatagram(state);
    for (const target of outboundTargets(state)) {
      sendDatagram(state, probe, target.port, target.address, 'probe');
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
