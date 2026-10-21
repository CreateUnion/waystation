import dgram from 'node:dgram';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { ANCHOR_PORT, SLOT_COUNT } from '../site.js';
import { shortSessionId } from '../util/short-id.js';
import { MAX_COLLAB_COUNT, MAX_DATAGRAM_BYTES, PARTICIPANTS_CAPABILITY, PROTOCOL_VERSION, fitJoinResolveAck, isIdentityName, isPort, newMsgId, supportsParticipants, validateJoinAck, validateJoinKnock, validateJoinResolve, validateJoinResolveAck, validateProbe, validateProbeAck, withParticipantsCapability } from './protocol.js';

export const DISCOVERY_REPLY_MIN_INTERVAL_MS = 250;
const MAX_THROTTLED_SOURCES = 64;

/* 主动加入（设计 §5.6，工具 ws_request_join）的敲门与应答参数：发现类数据报——可丢、可重、无认证。
 * 敲门总量 = 1 + JOIN_KNOCK_RETRY_COUNT（「少量重发」覆盖单包丢失）；收答窗口自首发起算、覆盖重发时程，
 * 末次重发仍有收条时间；应答限流窗口大于重发总时程——重发不放大为多份应答与提示
 * （限流只抑制「已有同源记录」的后续包；首包丢失时无记录，重发照常命中）。
 * 全部为本地可调参数（非协议常量）：对端行为不依赖本组数值。 */
export const JOIN_KNOCK_RETRY_COUNT = 2;
export const JOIN_KNOCK_RETRY_INTERVAL_MS = 1000;
export const JOIN_KNOCK_WINDOW_MS = 3500;
export const JOIN_KNOCK_REPLY_MIN_INTERVAL_MS = 2500;

/* 按名解析（单播问答，会话级管理设计 §2）的缺省收答窗口：单播直达而非广播扫描，一次问答即足；
 * 窗口内少量重发覆盖单包丢失，发程落在窗口内。 */
export const JOIN_RESOLVE_TIMEOUT_MS = 1500;

/* 单播能力探测（会话级参与者设计 §7.2）的缺省收答窗口：只发一条单播、不重发——
 * 窗口内无应答即「未知」，由调用方决定是否再试；探测不进协作队列。 */
export const CAPABILITY_PROBE_TIMEOUT_MS = 800;

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
 * 段扫是「非默认端口站点两两互见」的闭合机制：只靠应答携带端口 + 探测学习只能闭合到星型（实测结论）。
 * 入站校验基线：每次数据报都过体积/解析/字段校验，失败拒绝并计数（设计 §10）。
 * 独占绑定（reuseAddr 关闭）是槽位取锁语义成立的前提——第二实例必须拿到 EADDRINUSE。
 * segmentBase 为测试注入缝（生产一律缺省 = 内置锚点，不构成配置面）：段内端口即 [segmentBase, segmentBase+7]。
 * 主动加入另有一组注入缝：onJoinKnock = 命中处理回调（协作层注入——发现层不 import 协作层，
 * 分层纪律经注入解除）；joinKnock* 四个时程参数为测试注入缝（生产一律缺省 = 内置值）。
 * 会话级可见性同款注入：activeSessions = 本机活跃终端取值器（注册桥的会话视图——探测应答的
 * `sessions` 短码由此产出）；onJoinResolve = 按名解析的命中处理回调（缺省 = 本机无讨论面，不应答）。
 * 生命周期一次性（start → scan / announce / requestJoin / requestJoinResolve → close），调用时序由装配层保证：
 * close 后套接字已关闭，再次 start/scan/announce/requestJoin* 会以套接字错误失败（吵闹而非挂起）——
 * 失败即安全网，不属可依赖的语义。 */
export function createDiscovery(options) {
  const state = discoveryStateOf(options);
  state.socket.on('message', (buffer, rinfo) => {
    onDatagram(state, buffer, rinfo);
  });
  state.socket.on('error', (error) => {
    state.log.warn('发现套接字错误（不退出进程）', { reason: error.message });
  });
  return {
    start: () => start(state),
    close: () => close(state),
    scan: (options) => scan(state, options),
    announce: () => announce(state),
    requestJoin: (options) => requestJoin(state, options),
    requestJoinResolve: (options) => requestJoinResolve(state, options),
    probeCapability: (options) => probeCapability(state, options),
    stats: () => statsOf(state),
  };
}

/* 计数器初值（与状态构造分离：状态面只管装配，计量面单独成表便于逐路核对）。 */
function initialCounters() {
  return {
    datagramsIn: 0,
    probesAnswered: 0,
    probeResponses: 0,
    probeSessionsDropped: 0,
    probeRepliesSkipped: 0,
    selfObserved: 0,
    rateLimited: 0,
    sendFailures: 0,
    selfIntroductions: 0,
    joinKnocksSent: 0,
    joinRepliesIn: 0,
    joinRepliesAnswered: 0,
    joinRepliesSkipped: 0,
    joinKnocksThrottled: 0,
    joinResolveRequestsSent: 0,
    joinResolveRequestsIn: 0,
    joinResolveRepliesAnswered: 0,
    joinResolveRepliesSkipped: 0,
    joinResolveRequestsThrottled: 0,
    joinResolveRepliesIn: 0,
    capabilityProbesSent: 0,
    rejected: { oversize: 0, malformed: 0, invalid: 0 },
  };
}

/* 发现层状态构造：注入缝、套接字、限流表与计数器一次性定格，与行为函数分离。 */
function discoveryStateOf({
  port, bindAddress = '0.0.0.0', instanceId, identityName, getCollabCount, knownHosts, log, segmentBase = ANCHOR_PORT,
  onJoinKnock = null, onJoinResolve = null,
  activeSessions = () => [],
  joinKnockWindowMs = JOIN_KNOCK_WINDOW_MS,
  joinKnockRetryCount = JOIN_KNOCK_RETRY_COUNT,
  joinKnockRetryIntervalMs = JOIN_KNOCK_RETRY_INTERVAL_MS,
  joinKnockReplyMinIntervalMs = JOIN_KNOCK_REPLY_MIN_INTERVAL_MS,
}) {
  return {
    port, bindAddress, instanceId, identityName, getCollabCount, knownHosts, log, segmentBase,
    onJoinKnock, onJoinResolve, activeSessions,
    joinKnockWindowMs, joinKnockRetryCount, joinKnockRetryIntervalMs, joinKnockReplyMinIntervalMs,
    socket: dgram.createSocket({ type: 'udp4', reuseAddr: false }),
    counters: initialCounters(),
    collectors: new Set(),
    joinCollectors: new Set(),
    resolveCollectors: new Set(),
    capabilityCollectors: new Set(),
    /* 四张限流表（各管一路的风暴，键 = 来源「地址:端口」）：
     * probeReplyAt 只管「探测应答的风暴」——仅由收到的探测记账，收 ack 不得抑制本应发出的探测应答；
     * joinReplyAt 只管「敲门应答的风暴」——仅由收到的敲门记账；伪造敲门不放大为应答与本机会话提示；
     * resolveReplyAt 只管「解析应答的风暴」——仅由收到的解析请求记账（单播定向问答，沿探测应答的最小间隔口径）；
     * writeThrottleAt 管「清单整文件原子写的风暴」——探测器与应答两路入站共用同一张表，
     * 伪造探测与伪造应答交替同样不放大写频。 */
    probeReplyAt: new Map(), joinReplyAt: new Map(), resolveReplyAt: new Map(), writeThrottleAt: new Map(),
    bound: false,
    closed: false,
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
  if (parsed.type === 'join-knock') {
    handleJoinKnock(state, parsed, rinfo);
    return;
  }
  if (parsed.type === 'join-ack') {
    handleJoinAck(state, parsed, rinfo);
    return;
  }
  if (parsed.type === 'join-resolve') {
    handleJoinResolve(state, parsed, rinfo);
    return;
  }
  if (parsed.type === 'join-resolve-ack') {
    handleJoinResolveAck(state, parsed, rinfo);
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
  // 探测不带 participants：这是「没有情报」而不是「不支持」，交 known-hosts 继承旧值。
  rememberThrottled(state, datagram, rinfo, { address: rinfo.address, port: rinfo.port }, undefined);
  answerProbe(state, rinfo);
}

/* 探测应答回发：应答体先过体积整形（设计 §5.6 硬规则）——超限弃会话段保整包（可见性是顺带面，
 * 探测的可达性才是本面契约）；整形到无可截则弃整份并计数留痕（绝不发超限数据报）。 */
function answerProbe(state, rinfo) {
  const ack = buildProbeAck(state);
  const fitted = fitProbeAckDatagram(ack);
  if (fitted === null) {
    state.counters.probeRepliesSkipped++;
    state.log.warn('扫描应答超体积预算且不可再截，放弃该份', { instanceId: state.instanceId });
    return;
  }
  if (!Object.hasOwn(fitted, 'sessions')) {
    state.counters.probeSessionsDropped++;
    state.log.warn('扫描应答超体积预算：弃会话字段保整包（宁缺勿超）', { instanceId: state.instanceId });
  }
  sendDatagram(state, Buffer.from(JSON.stringify(fitted)), rinfo.port, rinfo.address, 'probe-ack');
  state.counters.probesAnswered++;
}

/* 同源最小间隔记账（四张表共用同一实现；间隔按路传参）：键 = 来源「地址:端口」——同机多站点互为合法
 * 不同源，不被互相的窗口吞掉。
 * 代价如实记录：同一 IP 每张表各可占 MAX_THROTTLED_SOURCES 个表项（防护评估见计量用例）。
 * 窗口内返回 false，窗口外刷新时间戳并放行；刷新的键移到 Map 尾部、淘汰取首键——表按「最近刷新」维护且容量有界；
 * 首个包必然放行（表无记录时差值为「当前时间-0」）——合法扫描的首个探测/应答、首次敲门必经此路。 */
function withinMinInterval(table, rinfo, minIntervalMs = DISCOVERY_REPLY_MIN_INTERVAL_MS) {
  const key = `${rinfo.address}:${rinfo.port}`;
  const now = Date.now();
  if (now - (table.get(key) ?? 0) < minIntervalMs) {
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
 * 被节流的写入同样计入 rateLimited（入站校验基线的「忽略必须留痕」）。
 * participants 由调用方按数据报语义给出：应答缺字段＝0（旧版/不支持）；探测请求＝undefined（无情报，继承旧值）。 */
function rememberThrottled(state, datagram, rinfo, endpoint, participants) {
  if (!withinMinInterval(state.writeThrottleAt, rinfo)) {
    state.counters.rateLimited++;
    return;
  }
  state.knownHosts.remember({
    address: endpoint.address,
    port: endpoint.port,
    instanceId: datagram.instanceId,
    identityName: datagram.identityName,
    /* 会话段是探测应答的加法字段：探测自身不带该字段（否则 undefined）＝清单记「未知」——
     * 探测请求与探测应答的会话真相不混同（探测来源只证明「这台机器在此」）。 */
    sessions: datagram.sessions,
    participants,
  });
}

/* 应答类数据报的能力观测：带 2＝支持；缺字段＝旧版/不支持（响应存在即证据，区别于「没有响应」）。 */
function participantsOfResponse(datagram) {
  return supportsParticipants(datagram) ? PARTICIPANTS_CAPABILITY : 0;
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
  rememberThrottled(state, datagram, rinfo, endpoint, participantsOfResponse(datagram));
  for (const collector of state.collectors) {
    mergeResponse(collector, datagram, endpoint, state);
  }
  for (const collector of state.capabilityCollectors) {
    mergeCapabilityResponse(collector, datagram, endpoint);
  }
}

function mergeResponse(collector, datagram, endpoint, state) {
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
  mergeSessions(entry, datagram);
  mergeParticipants(entry, datagram, state);
  collector.set(datagram.instanceId, entry);
}

/* 会话段合并（扫描结果面，会话级管理设计 §1）：只采字符串短码——协议校验不覆盖该加法字段，
 * 本地形态底线在此把关（非字符串项剔除、一律短码化），列表不长于一份数据报的携带量。
 * 对端这份没报（旧版实现 / 超限弃字段）不改写已知值：丢一份 ≠ 对方没有会话。 */
function mergeSessions(entry, datagram) {
  if (!Array.isArray(datagram.sessions)) {
    return;
  }
  entry.sessions = datagram.sessions
    .filter((code) => typeof code === 'string' && code !== '')
    .map((code) => shortSessionId(code));
}

/* 能力段合并（扫描结果面，会话级协作设计 §7.2）：响应带 2＝支持；缺字段＝旧版/不支持。
 * 与 sessions 同一继承纪律：本窗口已学到的支持态、或清单里已知的支持态不被后到的缺字段应答抹掉
 * （「不覆盖已知」）；两处都没有可继承的值，才把「响应存在但缺字段」记为不支持。
 * 不支持不继承反向：对端升级后重新申报 2 即覆盖。 */
function mergeParticipants(entry, datagram, state) {
  if (supportsParticipants(datagram)) {
    entry.participants = PARTICIPANTS_CAPABILITY;
    return;
  }
  const known = entry.participants ?? state.knownHosts.participantsOf(datagram.instanceId);
  entry.participants = known === PARTICIPANTS_CAPABILITY ? known : 0;
}

/* —— 主动加入（设计 §5.6）：成员侧敲门处理与申请人侧应答收集 —— */

/* 敲门处理（成员侧）：校验 → 排除自答 → 应答限流（同源最小间隔；伪造敲门不放大为应答与本机会话提示，
 * 与探测应答的分工同款：本表只由敲门记账）→ 逐命中讨论回发 join-ack。
 * 命中解析经注入回调（缺省 = 本机无讨论面，不应答）；回调异常隔离为空结果（应答是附属机制，
 * 不得让异常穿出数据报处理）。 */
function handleJoinKnock(state, datagram, rinfo) {
  const checked = validateJoinKnock(datagram);
  if (!checked.ok) {
    state.counters.rejected.invalid++;
    state.log.warn('敲门报文校验失败，拒绝', { from: rinfo.address, reason: checked.reason });
    return;
  }
  if (datagram.instanceId === state.instanceId) {
    state.counters.selfObserved++;
    return;   // 排除自答：自己的敲门（含单播到自己）不处理、不提示
  }
  if (!withinMinInterval(state.joinReplyAt, rinfo, state.joinKnockReplyMinIntervalMs)) {
    state.counters.joinKnocksThrottled++;
    return;
  }
  for (const reply of resolveJoinKnock(state, datagram, rinfo)) {
    sendJoinAck(state, datagram, rinfo, reply);
  }
}

/* 命中解析（协作层经注入承担：命中哪些讨论、本机提示文案、应答载荷内容）；返回值只取数组形态，
 * 其余一律按「无命中」——注入面不信任上游形态。 */
function resolveJoinKnock(state, datagram, rinfo) {
  if (typeof state.onJoinKnock !== 'function') {
    return [];
  }
  try {
    const replies = state.onJoinKnock(knockOf(datagram, rinfo));
    return Array.isArray(replies) ? replies : [];
  } catch (error) {
    state.log.warn('敲门命中处理异常（已隔离）', { from: rinfo.address, reason: error.message });
    return [];
  }
}

/* 命中入参移交面：申请人身份、来源端点（放行时作 ws_invite 目标）、报送标识与能力。
 * 能力随敲门移交：成员侧在放行/应答前即可判断申请人是否支持会话级协作（旧版敲门缺字段＝不支持）。 */
function knockOf(datagram, rinfo) {
  return {
    instanceId: datagram.instanceId,
    identityName: datagram.identityName,
    address: rinfo.address,
    port: rinfo.port,
    knockId: datagram.knockId,
    name: datagram.name,
    participants: participantsOfResponse(datagram),
  };
}

/* 应答回发（按来源地址与数据报来源端口寻址——同 probe-ack 的端口口径）：应答体先过体积整形
 * （设计 §5.6 硬规则）；整形到无可截则放弃该份并计数留痕（绝不发超限数据报）。 */
function sendJoinAck(state, knock, rinfo, reply) {
  const datagram = fitJoinAckDatagram(withParticipantsCapability({
    v: PROTOCOL_VERSION,
    type: 'join-ack',
    instanceId: state.instanceId,
    identityName: state.identityName,
    knockId: knock.knockId,
    port: state.port,
    collabId: reply.collabId,
    name: reply.name,
    topic: reply.topic,
    memberCount: reply.memberCount,
    originator: { instanceId: reply.originator.instanceId, identityName: reply.originator.identityName },
  }));
  if (datagram === null) {
    state.counters.joinRepliesSkipped++;
    state.log.warn('加入应答超体积预算且不可再截，放弃该份', { collabId: String(reply.collabId) });
    return;
  }
  sendDatagram(state, Buffer.from(JSON.stringify(datagram)), rinfo.port, rinfo.address, 'join-ack');
  state.counters.joinRepliesAnswered++;
}

/* 体积预算（设计 §5.6 硬规则）：序列化后 ≤ MAX_DATAGRAM_BYTES（含信封）——先截主题、仍超再截名称；
 * UTF-8 安全（按码位切，绝不切出半个字符）且标注截断；collabId / 成员数 / 发起人标识不可截。
 * 截到头（主题与名称皆空）仍超预算（身份与标识本身撑爆信封）→ 返回 null，放弃该份应答；
 * 完整值由申请人在加入后经正式通道对表补齐——截断只是敲门应答的可达性妥协，不承载权威数据。 */
export function fitJoinAckDatagram(datagram) {
  if (fitsDatagramBudget(datagram)) {
    return datagram;
  }
  const topicFit = fitJoinTopicTruncation(datagram);
  if (topicFit !== null) {
    return topicFit;
  }
  return fitJoinNameTruncation(datagram);
}

function fitsDatagramBudget(datagram) {
  return Buffer.byteLength(JSON.stringify(datagram)) <= MAX_DATAGRAM_BYTES;
}

/* 主题截断：逐码位从长到短取最大可发送前缀（前缀字节长随长度不减，降序试即最优）；命中即返回。
 * 截到空仍超预算则交给名称截断（空值同样带标注）。 */
function fitJoinTopicTruncation(datagram) {
  const points = [...datagram.topic];
  for (let keep = points.length - 1; keep >= 0; keep--) {
    const candidate = { ...datagram, topic: prefixText(points, keep), topicTruncated: true };
    if (fitsDatagramBudget(candidate)) {
      return candidate;
    }
  }
  return null;
}

/* 名称截断（主题已定为空串）：同前缀法；到空仍超则返回 null（上层放弃发送）。 */
function fitJoinNameTruncation(datagram) {
  const points = [...datagram.name];
  for (let keep = points.length - 1; keep >= 0; keep--) {
    const candidate = { ...datagram, topic: '', topicTruncated: true, name: prefixText(points, keep), nameTruncated: true };
    if (fitsDatagramBudget(candidate)) {
      return candidate;
    }
  }
  return null;
}

function prefixText(points, keep) {
  return points.slice(0, keep).join('').trim();
}

/* 应答处理（申请人侧）：校验 → 计数 → 排除自答 → 并入在途收集面（只认 knockId 相符的收集面：
 * 迟到的旧应答不进新申请的结果；同一讨论去重合并、重复份只计数）。 */
function handleJoinAck(state, datagram, rinfo) {
  const checked = validateJoinAck(datagram);
  if (!checked.ok) {
    state.counters.rejected.invalid++;
    state.log.warn('加入应答校验失败，拒绝', { from: rinfo.address, reason: checked.reason });
    return;
  }
  state.counters.joinRepliesIn++;
  if (datagram.instanceId === state.instanceId) {
    state.counters.selfObserved++;
    return;
  }
  for (const collector of state.joinCollectors) {
    mergeJoinAck(collector, datagram, rinfo);
  }
}

function mergeJoinAck(collector, datagram, rinfo) {
  if (collector.knockId !== datagram.knockId) {
    return;
  }
  const held = collector.entries.get(datagram.collabId);
  if (held !== undefined) {
    held.replies++;   // 去重合并（重发 × 多成员）：结果逐讨论一份
    return;
  }
  collector.entries.set(datagram.collabId, {
    collabId: datagram.collabId,
    name: datagram.name,
    topic: datagram.topic,
    memberCount: datagram.memberCount,
    originator: { instanceId: datagram.originator.instanceId, identityName: datagram.originator.identityName },
    topicTruncated: datagram.topicTruncated === true,
    nameTruncated: datagram.nameTruncated === true,
    participants: participantsOfResponse(datagram),
    responder: { instanceId: datagram.instanceId, identityName: datagram.identityName, address: rinfo.address, port: datagram.port ?? rinfo.port },
    replies: 1,
  });
}

/* —— 按名解析（会话级管理设计 §2）：单播问答「谁在 <讨论名> 讨论」 —— */

/* 解析请求处理（被问者侧）：校验 → 应答限流（同源最小间隔；伪造请求不放大为应答风暴，
 * 与探测应答同口径——单播定向问答无重发时程顾虑，无需敲门那张长窗表）→ 命中解析经注入回调
 * （缺省 = 本机无讨论面，不应答）→ 按解析结果回发单播应答。
 * 不排除自答：请求不自报身份（单播问答按来源地址回发），被问者无从判别来源是不是本机——
 * 自答由申请侧的应答处理按 instanceId 滤除（一次回发的浪费是「问答无需先互认」的代价）。 */
function handleJoinResolve(state, datagram, rinfo) {
  const checked = validateJoinResolve(datagram);
  if (!checked.ok) {
    state.counters.rejected.invalid++;
    state.log.warn('解析请求校验失败，拒绝', { from: rinfo.address, reason: checked.reason });
    return;
  }
  state.counters.joinResolveRequestsIn++;
  if (!withinMinInterval(state.resolveReplyAt, rinfo)) {
    state.counters.joinResolveRequestsThrottled++;
    return;
  }
  const reply = resolveLocally(state, datagram, rinfo);
  if (reply === null) {
    return;   // 无讨论面：不应答（沿敲门先例——「本机没有解析面」不是「没有这个讨论」）
  }
  sendJoinResolveAck(state, datagram, rinfo, reply);
}

/* 命中解析（协作层经注入承担：按名匹配本机在册协作、「同名多义」判否等语义都在那一侧）；
 * 返回值只取对象形态，其余一律按「无应答」——注入面不信任上游形态（命中回调抛错同样隔离）。 */
function resolveLocally(state, datagram, rinfo) {
  if (typeof state.onJoinResolve !== 'function') {
    return null;
  }
  try {
    const reply = state.onJoinResolve({ name: datagram.name, address: rinfo.address, port: rinfo.port, resolveId: datagram.resolveId });
    return reply !== null && typeof reply === 'object' && !Array.isArray(reply) ? reply : null;
  } catch (error) {
    state.log.warn('解析命中处理异常（已隔离）', { from: rinfo.address, reason: error.message });
    return null;
  }
}

/* 解析应答回发：命中与未命中各有形态（未命中极简——不得携讨论面字段，带即被对端按自相矛盾拒收）；
 * 应答体先过协议层的整形（先弃名称、仍超弃整份），再自校验一遍才发：
 * 注入面给出的非法形态（如坏 collabId）不得变成一份自家就会拒收的数据报。 */
function sendJoinResolveAck(state, request, rinfo, reply) {
  const fitted = fitJoinResolveAck(buildJoinResolveAck(state, request, reply));
  if (fitted === null || !validateJoinResolveAck(fitted).ok) {
    state.counters.joinResolveRepliesSkipped++;
    state.log.warn('解析应答不可发（超体积预算或注入面形态非法），放弃该份', { from: rinfo.address });
    return;
  }
  sendDatagram(state, Buffer.from(JSON.stringify(fitted)), rinfo.port, rinfo.address, 'join-resolve-ack');
  state.counters.joinResolveRepliesAnswered++;
}

function buildJoinResolveAck(state, request, reply) {
  const ack = withParticipantsCapability({
    v: PROTOCOL_VERSION,
    type: 'join-resolve-ack',
    instanceId: state.instanceId,
    identityName: state.identityName,
    port: state.port,
    resolveId: request.resolveId,
    found: reply.found === true,
  });
  if (!ack.found) {
    return ack;   // 未命中极简：不带讨论面字段（未命中却点名是自相矛盾的断言）
  }
  ack.collabId = reply.collabId;
  if (isIdentityName(reply.name)) {
    ack.name = reply.name;   // 名称可省（整形可弃）：完整讨论名由申请人加入后经正式通道对表补齐
  }
  return ack;
}

/* 解析应答处理（申请人侧）：校验 → 计数 → 排除自答 → 并入在途收集面（只认 resolveId 相符的收集面：
 * 迟到的旧应答不进新解析的结果）。 */
function handleJoinResolveAck(state, datagram, rinfo) {
  const checked = validateJoinResolveAck(datagram);
  if (!checked.ok) {
    state.counters.rejected.invalid++;
    state.log.warn('解析应答校验失败，拒绝', { from: rinfo.address, reason: checked.reason });
    return;
  }
  state.counters.joinResolveRepliesIn++;
  if (datagram.instanceId === state.instanceId) {
    state.counters.selfObserved++;
    return;
  }
  for (const collector of state.resolveCollectors) {
    mergeJoinResolveAck(collector, datagram, rinfo);
  }
}

/* 应答并入：命中优先于未命中——重发之间对端的在册面可能变化，后到的命中比先前的未命中更接近真相；
 * 已记命中则后续份不再改写（首个命中即结果），重发造成的重复份只计数留痕。 */
function mergeJoinResolveAck(collector, datagram, rinfo) {
  if (collector.resolveId !== datagram.resolveId) {
    return;
  }
  collector.replies++;
  const reply = {
    found: datagram.found === true,
    participants: participantsOfResponse(datagram),
    responder: { instanceId: datagram.instanceId, identityName: datagram.identityName, address: rinfo.address, port: datagram.port ?? rinfo.port },
  };
  if (reply.found) {
    reply.collabId = datagram.collabId;
    if (datagram.name !== undefined) {
      reply.name = datagram.name;   // 对端整形可弃名：缺席即「未携名」，不臆造
    }
  }
  if (collector.reply === null || (reply.found && !collector.reply.found)) {
    collector.reply = reply;
  }
}

/* 按名解析（申请人侧；加入面与工具调用的落点）：向指定驿站单播询问「谁在 <讨论名> 讨论」、
 * 窗口内收应答（resolveId 相符才采信）；窗口关闭后返回结果对象或 null。
 * null = 「对方没答」（不可达 / 丢包），与 found:false（「对方答了：没有这个讨论」）是两回事——
 * 调用方按各自语义处置（无应答如实报错、未命中另寻他路）。
 * 目标地址与端口是寻址信息（来自扫描结果 / 清单），形态在启程前把关：不发畸形载荷、不做无谓的收答等待。 */
async function requestJoinResolve(state, input = {}) {
  const target = resolveTargetOf(input);
  const timeoutMs = resolveTimeoutOf(input);
  /** @type {{ resolveId: string, reply: Record<string, unknown> | null, replies: number }} */
  const collector = { resolveId: newMsgId(), reply: null, replies: 0 };
  state.resolveCollectors.add(collector);
  try {
    await sendResolveRequests(state, collector.resolveId, target, timeoutMs);
  } finally {
    state.resolveCollectors.delete(collector);
  }
  return collector.reply === null ? null : { ...collector.reply, replies: collector.replies };
}

/* 询问面参数把关（讨论名 / 目标地址 / 目标端口）：非法即抛 TypeError（编程错误快速暴露）。 */
function resolveTargetOf(input) {
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  if (!isIdentityName(name)) {
    throw new TypeError(`requestJoinResolve 需要合法的讨论名（≤64 字符、不含不可见字符的呈现文本），实际：${JSON.stringify(input?.name)}`);
  }
  if (typeof input.address !== 'string' || isIP(input.address) === 0) {
    throw new TypeError(`requestJoinResolve 需要 IP 字面量目标地址（不做域名解析），实际：${JSON.stringify(input.address)}`);
  }
  if (!isPort(input.port)) {
    throw new TypeError(`requestJoinResolve 需要 1–65535 的整数目标端口，实际：${JSON.stringify(input.port)}`);
  }
  return { name, address: input.address, port: input.port };
}

function resolveTimeoutOf(input) {
  const timeoutMs = input.timeoutMs === undefined ? JOIN_RESOLVE_TIMEOUT_MS : input.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
    throw new TypeError(`requestJoinResolve 需要合法的 timeoutMs（1–60000 毫秒），实际：${JSON.stringify(input.timeoutMs)}`);
  }
  return timeoutMs;
}

/* 请求发程：单播直达（不广播——名字只给被问的那一台），窗口对半分成两段、每段各发一发
 * （少量重发覆盖单包丢失；重发时程大于应答限流窗，首答丢失时重发仍能唤起应答）。 */
async function sendResolveRequests(state, resolveId, target, timeoutMs) {
  const request = Buffer.from(JSON.stringify({ v: PROTOCOL_VERSION, type: 'join-resolve', resolveId, name: target.name }));
  const firstLeg = Math.floor(timeoutMs / 2);
  const legs = [firstLeg, timeoutMs - firstLeg];
  for (const legMs of legs) {
    sendDatagram(state, request, target.port, target.address, 'join-resolve');
    state.counters.joinResolveRequestsSent++;
    await sleep(legMs);
  }
}

/* —— 单播能力探测（会话级参与者设计 §7.2）：复用 probe/probe-ack 数据报族 —— */

/* 对一台已知主机发一次单播探测、窗口内收应答，把能力的「未知」收敛为支持 / 不支持。
 * 不新增数据报类型：旧版对端不认识新类型会静默丢弃，「不支持」就永远观测不到；旧版对端照常应答
 * probe，只是缺 participants——缺失本身就是「旧版」的证据（三态判定的入口在此）。
 * 应答同时走常规入站路径（清单写入与扫描合并口径一致），本函数只负责收集与判定；
 * 单发不重发，窗口内无应答＝未知，是否再试由调用方决定。探测不进协作队列。 */
async function probeCapability(state, input = {}) {
  const target = capabilityTargetOf(input);
  const timeoutMs = capabilityTimeoutOf(input);
  /** @type {{ target: { address: string, port: number, instanceId: string | null }, reply: Record<string, unknown> | null, wake: (() => void) | null }} */
  const collector = { target, reply: null, wake: null };
  state.capabilityCollectors.add(collector);
  try {
    sendDatagram(state, probeDatagram(state), target.port, target.address, 'capability-probe');
    state.counters.capabilityProbesSent++;
    await waitForCapabilityReply(collector, timeoutMs);
  } finally {
    state.capabilityCollectors.delete(collector);
  }
  return collector.reply ?? { capability: 'unknown', responder: null };
}

function waitForCapabilityReply(collector, timeoutMs) {
  if (collector.reply !== null) {
    return Promise.resolve();
  }
  // JSDoc 提示：显式 Promise<void> 让类型检查接受无参 resolve（同 close 的写法）
  return /** @type {Promise<void>} */ (new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    collector.wake = () => {
      clearTimeout(timer);
      resolve();
    };
  }));
}

/* 应答与探测目标的匹配：单播只送达被问的那一台，按来源地址即可归户；调用方给了实例标识则再核一遍
 * （地址复用/同机多站点下防止把别的实例的能力记到目标头上）。端口不参与匹配——站点自报端口可能
 * 与清单里的历史端口不同，应答字段已由常规路径并入端点。 */
function mergeCapabilityResponse(collector, datagram, endpoint) {
  if (collector.reply !== null || endpoint.address !== collector.target.address) {
    return;
  }
  if (collector.target.instanceId !== null && datagram.instanceId !== collector.target.instanceId) {
    return;
  }
  collector.reply = {
    capability: supportsParticipants(datagram) ? 'supported' : 'unsupported',
    responder: { instanceId: datagram.instanceId, identityName: datagram.identityName, address: endpoint.address, port: endpoint.port },
  };
  collector.wake?.();
}

/* 目标与窗口形态在启程前把关（同按名解析口径）：非法即抛 TypeError，不发畸形载荷、不做无谓收答等待。 */
function capabilityTargetOf(input) {
  if (typeof input?.address !== 'string' || isIP(input.address) === 0) {
    throw new TypeError(`probeCapability 需要 IP 字面量目标地址（不做域名解析），实际：${JSON.stringify(input?.address)}`);
  }
  if (!isPort(input.port)) {
    throw new TypeError(`probeCapability 需要 1–65535 的整数目标端口，实际：${JSON.stringify(input.port)}`);
  }
  const instanceId = input.instanceId;
  if (instanceId !== undefined && (typeof instanceId !== 'string' || instanceId === '')) {
    throw new TypeError(`probeCapability 的 instanceId 须为非空字符串，实际：${JSON.stringify(instanceId)}`);
  }
  return { address: input.address, port: input.port, instanceId: instanceId ?? null };
}

function capabilityTimeoutOf(input) {
  const timeoutMs = input.timeoutMs === undefined ? CAPABILITY_PROBE_TIMEOUT_MS : input.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
    throw new TypeError(`probeCapability 需要合法的 timeoutMs（1–60000 毫秒），实际：${JSON.stringify(input.timeoutMs)}`);
  }
  return timeoutMs;
}

/* 扫描应答体（会话级可见性，设计 §1）：恒携 `sessions`（本机活跃终端短码列表——零会话如实报空数组，
 * 「报了零」与「没报」对接收侧是两回事）与 `participants:2`（会话级参与者能力，设计 §7.2）；
 * 其余字段与旧实现逐字一致（旧对端按加法字段忽略）。
 * 体积整形交 answerProbe（超限先弃会话段，能力字段保留）。 */
function buildProbeAck(state) {
  return withParticipantsCapability({
    v: PROTOCOL_VERSION,
    type: 'probe-ack',
    instanceId: state.instanceId,
    identityName: state.identityName,
    collabCount: currentCollabCount(state),
    port: state.port,
    sessions: currentSessions(state),
  });
}

/* 本机活跃终端短码（注册桥经注入的取值器现取——发现层不 import 注册表）。
 * 取值失败按零会话应答：会话段是顺带可见性，取值异常不得让探测面停摆。 */
function currentSessions(state) {
  try {
    const sessions = state.activeSessions();
    if (!Array.isArray(sessions)) {
      return [];
    }
    return sessions
      .map((entry) => shortSessionId(entry?.sessionId))
      .filter((code) => code !== '');
  } catch (error) {
    state.log.warn('活跃会话取值失败，按零会话应答', { reason: error.message });
    return [];
  }
}

/* 扫描应答的体积整形（设计 §5.6 硬规则：序列化后 ≤ MAX_DATAGRAM_BYTES 含信封）：
 * 预算内原样；超限先弃 `sessions` 整字段（可见性让步于整包可达——宁缺勿超，由调用方计一数留痕）；
 * 弃到信封本身仍超（身份与端口横向撑爆，合规输入不可达）返回 null，由调用方弃发。 */
export function fitProbeAckDatagram(datagram) {
  if (fitsDatagramBudget(datagram)) {
    return datagram;
  }
  const withoutSessions = { ...datagram };
  delete withoutSessions.sessions;
  return fitsDatagramBudget(withoutSessions) ? withoutSessions : null;
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

/* 敲门（申请人侧；ws_request_join 的落点）：向「广播地址 × 槽位段 + 已知主机单播」发送敲门、
 * 少量重发防单包丢失，窗口内收应答并按讨论合并；窗口关闭后返回清单（无应答 = 空清单——
 * 「无应答」的统一提示由工具层承载，不作错误、不自动重试）。
 * 讨论名先过形态判据（发现类广播把名字播给全网——不发畸形载荷）；非法即抛 TypeError（编程错误快速暴露）。 */
async function requestJoin(state, input = {}) {
  const name = input?.name;
  const wanted = typeof name === 'string' ? name.trim() : '';
  if (!isIdentityName(wanted)) {
    throw new TypeError(`requestJoin 需要合法的讨论名（≤64 字符、不含不可见字符的呈现文本），实际：${JSON.stringify(name)}`);
  }
  const collector = { knockId: newMsgId(), entries: new Map() };
  state.joinCollectors.add(collector);
  try {
    await sendKnocks(state, wanted, collector.knockId);
  } finally {
    state.joinCollectors.delete(collector);
  }
  return [...collector.entries.values()].sort(compareJoinReplies);
}

async function sendKnocks(state, name, knockId) {
  const knock = Buffer.from(JSON.stringify(withParticipantsCapability({
    v: PROTOCOL_VERSION,
    type: 'join-knock',
    instanceId: state.instanceId,
    identityName: state.identityName,
    knockId,
    name,
  })));
  const rounds = state.joinKnockRetryCount + 1;
  for (let round = 0; round < rounds; round++) {
    for (const target of outboundTargets(state)) {
      sendDatagram(state, knock, target.port, target.address, 'join-knock');
      state.counters.joinKnocksSent++;
    }
    if (round < rounds - 1) {
      await sleep(state.joinKnockRetryIntervalMs);
    }
  }
  await sleep(Math.max(0, state.joinKnockWindowMs - state.joinKnockRetryIntervalMs * (rounds - 1)));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compareJoinReplies(left, right) {
  return left.name.localeCompare(right.name, 'zh-Hans-CN')
    || left.collabId.localeCompare(right.collabId);
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
