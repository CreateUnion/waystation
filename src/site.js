import { randomUUID } from 'node:crypto';
import dgram from 'node:dgram';
import { readFileSync, readdirSync } from 'node:fs';
import net from 'node:net';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { CONFIG_FILE_NAME, DATA_DIR_ENV, SESSIONS_DIR_NAME, resolveDataDir, siteDataDir } from './paths.js';
import { SESSION_STATUS_STALE_MS } from './session-status.js';
import { PROTOCOL_VERSION, isPort, validateProbeAck } from './net/protocol.js';

/* 站点域（设计 §13 多站点，模型 A）：一台机器上的每个驿站进程 = 一个站点——
 * 独立数据目录 + 独立站点实例标识 + 独立 LAN 端口。本模块含「锚点与槽位数学」与
 * 槽位解析（resolveSite：取锁探测、占用者双证据分类、显式端口接管）。
 * 「默认端口」为内置常量：各端一致、不随任何配置变化——它是广播锚点与槽位段的基准
 * （发布前登记见设计 §18；数值的唯一权威源即本文件，config 的默认值引用它）。 */
export const ANCHOR_PORT = 7321;
export const SLOT_COUNT = 8;

/** 槽位 k（1..SLOT_COUNT）的默认端口：锚点起的连续段，槽位 1 = 锚点本身。
 * 非法槽位一律抛错（与路径层同思路：不做清洗，让编程错误当场显形）。 */
export function slotDefaultPort(slot) {
  if (!Number.isInteger(slot) || slot < 1 || slot > SLOT_COUNT) {
    throw new TypeError(`槽位非法（应为 1–${SLOT_COUNT} 的整数）：${String(slot)}`);
  }
  return ANCHOR_PORT + slot - 1;
}

/* 占用者探测总预算的模块默认值：与 config.probeTimeoutMs 的默认一致。resolveSite 先于配置载入
 * （数据目录由解析结果决定），故以本模块默认值为准、测试经 options.probeTimeoutMs 注入；
 * 运行期 stack 的占用探测以 config.probeTimeoutMs 为准（数值的配置权威源在 config.buildDefaults）。 */
export const OCCUPIER_PROBE_TIMEOUT_MS = 1000;

/**
 * 站点槽位解析（设计 §13 多站点规程）：决定本站点用哪个数据目录与哪个 LAN 端口——必须先于组件构造
 * （组件要拿端口）、也先于配置载入（数据目录决定读哪份 config.json）。
 * 四种结局：槽位模式 / 显式数据目录模式，各含成功与降级两类；永不抛出（失败以 { ok:false, reason, message } 返回，
 * 由组合根降级启动——进程继续作为本地 MCP 服务）。唯一的写动作（显式目录首跑端口写回）由组合根执行：
 * 本函数只以 writeBackPort 标记提请。
 * options.segmentBase / options.mainDir 为测试注入缝（生产一律缺省：锚点 / resolveDataDir(env)），不是配置面。
 */
/**
 * @typedef {{ ok: true, mode: 'slot' | 'explicit', dataDir: string, slot: number | null, port: number, takeover: boolean, writeBackPort: boolean }
 *   | { ok: false, reason: 'takeover-taken' | 'anchor-taken' | 'segment-exhausted' | 'bind-failed', message: string }} SiteResult
 */

/**
 * @param {{ env?: Record<string, string | undefined>, warn?: (message: string) => void, probeTimeoutMs?: number, segmentBase?: number, mainDir?: string }} [options]
 * @returns {Promise<SiteResult>}
 */
export async function resolveSite(options = {}) {
  const env = options.env ?? process.env;
  const warn = options.warn ?? defaultWarn;
  const probeTimeoutMs = options.probeTimeoutMs ?? OCCUPIER_PROBE_TIMEOUT_MS;
  const segmentBase = options.segmentBase ?? ANCHOR_PORT;
  const explicitDir = typeof env[DATA_DIR_ENV] === 'string' && env[DATA_DIR_ENV].trim() !== '';
  if (explicitDir) {
    return resolveExplicitDir(resolveDataDir(env), { warn, probeTimeoutMs, segmentBase });
  }
  return resolveSlotSite(options.mainDir ?? resolveDataDir(env), { warn, probeTimeoutMs, segmentBase });
}

/* 槽位模式（默认数据目录）：从槽位 1 起逐槽搜索「取锁成功」的最低槽位。
 * 被占槽位的分类：合法驿站 → 顺延；无关程序 → 槽位 1 报错降级（不递增、不静默离开广播锚点）、
 * 槽位 k≥2 跳过；接管槽位被任何占用者占 → 一律顺延（占则跳——多终端不被单个被占端口钉死）。
 * 「显式端口被任何占用者占 → 报错降级」的字面语义落在显式数据目录模式与绑定竞态（本模式无此分支：
 * 槽位不被本终端取得即站点不成立，转向下一槽位是搜索语义而非站点改端口）。 */
/**
 * @param {string} mainDir
 * @param {{ warn: (message: string) => void, probeTimeoutMs: number, segmentBase: number }} options
 * @returns {Promise<SiteResult>}
 */
async function resolveSlotSite(mainDir, options) {
  for (let slot = 1; slot <= SLOT_COUNT; slot++) {
    const dir = slot === 1 ? mainDir : siteDataDir(mainDir, slot);
    const defaultPort = options.segmentBase + slot - 1;
    const explicitPort = explicitPortOf(dir, defaultPort);
    const port = explicitPort ?? defaultPort;
    const acquired = await tryAcquirePort({ port });
    if (acquired.ok) {
      return { ok: true, mode: 'slot', dataDir: dir, slot, port, takeover: explicitPort !== null, writeBackPort: false };
    }
    if (acquired.reason === 'bind-error') {
      return { ok: false, reason: 'bind-failed', message: `端口 ${port} 监听失败（${acquired.error.message}）——局域网功能不可用` };
    }
    /* 接管槽位被占（驿站或其他占用者）：该槽位按搜索跳过（占则跳）——但用户显式配置失效不得静默，向 warn 通道留痕；
     * 顺延不检查占用者类别（多开不被单个被占端口钉死），留痕覆盖两类占用。 */
    if (explicitPort !== null) {
      options.warn(`配置的端口 ${explicitPort} 被占用——该站点按槽位搜索顺延（config.json 中的 port 未生效）`);
      continue;
    }
    if ((await probeStation({ port, probeTimeoutMs: options.probeTimeoutMs, warn: options.warn })).station) {
      continue;   // 槽位在用（运行中的站点）：顺延——多终端的正常路径
    }
    if (slot === 1) {
      return {
        ok: false,
        reason: 'anchor-taken',
        message: `默认端口 ${defaultPort} 被其他程序占用——无显式配置时不自动递增（不静默离开广播锚点）；请释放该端口，或改用显式数据目录（WAYSTATION_HOME）固定站点目录`,
      };
    }
  }
  return {
    ok: false,
    reason: 'segment-exhausted',
    message: `端口段 ${options.segmentBase}–${options.segmentBase + SLOT_COUNT - 1} 的 ${SLOT_COUNT} 个槽位均不可用——本地功能可用，依赖局域网的工具暂不可用；释放端口或减少同机终端数后重启`,
  };
}

/* 显式数据目录（WAYSTATION_HOME）：目录固定、不参与槽位分配。
 * 有显式 port（任何合法值）→ 固定该端口：被任何占用者占 → 报错降级（不递增、不静默改——设计字面语义）；
 * 无显式 port → 首跑取端口段中最低空闲，以 writeBackPort 提请组合根写回（合并进首跑配置落盘、先于生效落盘）。 */
/**
 * @param {string} dir
 * @param {{ warn: (message: string) => void, probeTimeoutMs: number, segmentBase: number }} options
 * @returns {Promise<SiteResult>}
 */
async function resolveExplicitDir(dir, options) {
  const explicitPort = rawPortOf(dir);
  if (explicitPort !== null) {
    const acquired = await tryAcquirePort({ port: explicitPort });
    if (acquired.ok) {
      return { ok: true, mode: 'explicit', dataDir: dir, slot: null, port: explicitPort, takeover: true, writeBackPort: false };
    }
    if (acquired.reason === 'bind-error') {
      return { ok: false, reason: 'bind-failed', message: `端口 ${explicitPort} 监听失败（${acquired.error.message}）——局域网功能不可用` };
    }
    return {
      ok: false,
      reason: 'takeover-taken',
      message: `显式端口 ${explicitPort} 被占用——已按 config.json 的显式端口固定：不自动改端口、不递增槽位；请释放该端口或修改 config.json 的 port`,
    };
  }
  for (let offset = 0; offset < SLOT_COUNT; offset++) {
    const port = options.segmentBase + offset;
    const acquired = await tryAcquirePort({ port });
    if (acquired.ok) {
      return { ok: true, mode: 'explicit', dataDir: dir, slot: null, port, takeover: false, writeBackPort: true };
    }
    if (acquired.reason === 'bind-error') {
      return { ok: false, reason: 'bind-failed', message: `端口 ${port} 监听失败（${acquired.error.message}）——局域网功能不可用` };
    }
  }
  return {
    ok: false,
    reason: 'segment-exhausted',
    message: `端口段 ${options.segmentBase}–${options.segmentBase + SLOT_COUNT - 1} 均不可用——本地功能可用，依赖局域网的工具暂不可用；释放端口后重启`,
  };
}

/* 槽位目录的显式端口判定：「端口值等于槽位默认端口视同未配置」（含历史版本首跑写入的默认值——
 * 多终端自动顺延不被它卡死）；读失败 / 损坏 / 非法值同样按未配置（与 loadConfig 的回落口径一致）。 */
function explicitPortOf(dir, defaultPort) {
  const port = rawPortOf(dir);
  if (port === null) {
    return null;
  }
  return port === defaultPort ? null : port;
}

/* 原始端口读取：只认「文件存在、JSON 可解析、根为对象、port 为 1–65535 整数」的情形。 */
function rawPortOf(dir) {
  /** @type {unknown} */
  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync(join(dir, CONFIG_FILE_NAME), 'utf8'));
  } catch {
    // 不存在 / 不可读 / 损坏与「形状不符」共用下方出口：都按未配置处理
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const port = /** @type {Record<string, unknown>} */ (parsed).port;
  if (!isPort(port)) {
    return null;
  }
  return port;
}

/* 取锁：UDP 与 TCP 同号都要能独占绑定（端口即槽位占用锁——绑定成功 = 取得槽位，无需额外锁文件）。
 * 取得后立即释放：真实监听由网络组件在引导完成后建立。释放与组件绑定之间有毫秒级竞态窗口——
 * 竞态由「组件绑定失败 → 占用者分类」兜底（设计如实记录的残余：极端并发退化为本终端会话期降级，重启即恢复）。
 * 导出形态（tryAcquirePort）供核心的端口阶段做「绑定包装」的空闲自证：先在占用者面前自证端口空闲、
 * 再把绑定交给组件——占用者形态（含只占 TCP 的程序）在触达组件前就被拦下，组件不被推进
 * 「已关闭不可复用」态（一次性生命周期，见 src/net/stack.js 的 components-closed 语义）。 */
export async function tryAcquirePort({ port }) {
  const udp = dgram.createSocket({ type: 'udp4', reuseAddr: false });
  try {
    await bindUdp(udp, port, '0.0.0.0');
  } catch (error) {
    closeSocketQuietly(udp);
    return acquireFailure(error);
  }
  const tcp = net.createServer();
  try {
    await listenTcp(tcp, port, '0.0.0.0');
  } catch (error) {
    closeSocketQuietly(udp);
    return acquireFailure(error);
  }
  await new Promise((resolve) => { tcp.close(resolve); });
  closeSocketQuietly(udp);
  return { ok: true };
}

function acquireFailure(error) {
  return error.code === 'EADDRINUSE'
    ? { ok: false, reason: 'in-use', error }
    : { ok: false, reason: 'bind-error', error };
}

async function bindUdp(socket, port, address) {
  return /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind({ port, address, exclusive: true }, () => {
      socket.removeListener('error', reject);
      resolve();
    });
  }));
}

async function listenTcp(server, port, address) {
  return /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port, host: address }, () => {
      server.removeListener('error', reject);
      resolve();
    });
  }));
}

function closeSocketQuietly(socket) {
  try {
    socket.close();
  } catch {
    // 未绑定成功的套接字无需关闭
  }
}

/** 对端身份（探测应答携带的 instanceId + identityName 对）。 */
/** @typedef {{ instanceId: string, identityName: string }} PeerIdentity */
/** 探测命中（应答者的站点端口与其身份）。 */
/** @typedef {{ port: number, peer: PeerIdentity }} ProbeHit */

/* 探测会话（复用探针套接字——设计 §6.1 周期重探的落点）：同一会话内的全部 UDP 探测共用一个套接字
 * 与一份对端可见的探测身份。运行中的旧站点会把探测来源记进自己的已知主机清单（键＝「地址:来源端口」，
 * 见 net/discovery.js 的探测应答路径）——逐轮新建套接字＝逐轮给旧站点添陌生条目（30s 一轮、60 分钟
 * 等待上界内可累积上百条）；会话化后来源键恒定，清单只被覆写、不堆叠。
 * 单次探测（槽位解析的占用者分类）以「建会话→探→关」形态走同一实现；惰性建套接字。 */
/**
 * @param {{ warn?: (message: string) => void, bindSocket?: () => Promise<import('node:dgram').Socket> }} [options]
 *   bindSocket 为测试注入缝（构造「建立失败→下一轮复位重建」的行为面；生产缺省＝临时端口独占绑定）
 */
export function createProbeSession({ warn = defaultWarn, bindSocket = bindTransientSocket } = {}) {
  /** @type {{ socket: import('node:dgram').Socket | null, socketPromise: Promise<import('node:dgram').Socket | null> | null,
   *   warned: boolean, closed: boolean, probe: Buffer | null, waiters: Set<{ deliver: (hit: ProbeHit) => void }>,
   *   warn: (message: string) => void, bindSocket: () => Promise<import('node:dgram').Socket> }} */
  const state = { socket: null, socketPromise: null, warned: false, closed: false, probe: null, waiters: new Set(), warn, bindSocket };
  return {
    /** 单端口双证据探测：UDP 半预算（覆盖「UDP 已绑、TCP 未绑」的并发启动窗口）→ TCP 剩余预算。 */
    probeStation: (options) => sessionProbeStation(state, options),
    /** 端口段 probe-ack 扫描：单窗口收齐（一次发全段，不与端口数相乘）。 */
    scanSegment: (options) => sessionScanSegment(state, options),
    close: () => sessionClose(state),
  };
}

/* 单端口探测（会话形态）。 */
async function sessionProbeStation(state, { port, probeTimeoutMs = OCCUPIER_PROBE_TIMEOUT_MS }) {
  const deadline = Date.now() + probeTimeoutMs;
  const udp = await sessionUdpEvidence(state, { port, budgetMs: Math.max(1, Math.floor(probeTimeoutMs / 2)) });
  if (udp.hit) {
    return { station: true, peer: udp.peer };
  }
  const tcp = await tcpEvidence({ port, budgetMs: Math.max(1, deadline - Date.now()), warn: state.warn });
  return { station: tcp.hit, peer: tcp.peer };
}

/* 段扫（会话形态）：全段而非只探目标端口——旧站点可能顺延到段内别端口；只走 UDP probe-ack
 * （本探测的对象是「运行中的旧站点」，其 UDP 面必绑〔取锁语义的一半〕；目标端口的 TCP 面
 * 另由单端口双证据覆盖）；窗口按全预算等齐、不提前结算（要收齐段内全部应答者）。 */
async function sessionScanSegment(state, { segmentBase = ANCHOR_PORT, count = SLOT_COUNT, probeTimeoutMs = OCCUPIER_PROBE_TIMEOUT_MS } = {}) {
  const socket = await sessionSocket(state);
  if (socket === null) {
    return [];
  }
  const ports = [];
  for (let offset = 0; offset < count; offset++) {
    ports.push(segmentBase + offset);
  }
  const waiter = createCollectWaiter(ports);
  state.waiters.add(waiter);
  try {
    for (const port of ports) {
      socket.send(/** @type {Buffer} */ (state.probe), port, '127.0.0.1', () => {});
    }
    await withinWindow(probeTimeoutMs, new Promise(() => {}));
    return waiter.collected();
  } finally {
    state.waiters.delete(waiter);
  }
}

/* 单端口 UDP 证据（会话形态）：发 probe、在预算内等首条匹配 probe-ack（短路语义与单次探测一致）。 */
async function sessionUdpEvidence(state, { port, budgetMs }) {
  const socket = await sessionSocket(state);
  if (socket === null) {
    return noEvidence();
  }
  const waiter = createFirstHitWaiter([port]);
  state.waiters.add(waiter);
  try {
    socket.send(/** @type {Buffer} */ (state.probe), port, '127.0.0.1', () => {});
    const hit = await withinWindow(budgetMs, waiter.promise);
    return hit === null ? noEvidence() : { hit: true, peer: hit.peer };
  } finally {
    state.waiters.delete(waiter);
  }
}

/* 会话探针套接字（惰性建、单实例）：并发首探共用同一个建立 Promise（双建会泄漏一个套接字——
 * 它不在关闭面上，会拖住进程退出）。发出的一次性随机标识即对端看到的探测身份（会话内恒定）。 */
function sessionSocket(state) {
  if (state.closed) {
    return Promise.resolve(null);
  }
  if (state.socketPromise === null) {
    state.socketPromise = openProbeSocket(state);
  }
  return state.socketPromise;
}

/* 建立失败**按轮复位**（一次失败不得让端口道整会话失明：探测器在等待/降级期长驻，端口道是它的主判据）——
 * 复位后下一轮重试；失败告警每会话一次（会话寿命长，失败不逐轮刷屏）。 */
async function openProbeSocket(state) {
  /** @type {import('node:dgram').Socket | null} */
  let socket = null;
  try {
    socket = await state.bindSocket();
  } catch (error) {
    warnOnce(state, `占用者探测的临时套接字建立失败（${error.message}），按无应答处理（下一轮重试）`);
  }
  if (socket === null) {
    state.socketPromise = null;
    return null;
  }
  if (state.closed) {
    closeSocketQuietly(socket);   // 建立期间被关闭：不留会话外套接字
    return null;
  }
  // 目标端口无 UDP 监听时，ICMP 端口不可达可能在套接字上异步反映为错误——它只意味着「无应答」，
  // 不改变证据结论（吞掉并保持等待窗口语义；不作为拒绝或告警，避免探测路径自身噪音）。
  socket.on('error', () => {});
  socket.on('message', (buffer, rinfo) => dispatchProbeAck(state, buffer, rinfo));
  state.probe = Buffer.from(JSON.stringify({
    v: PROTOCOL_VERSION,
    type: 'probe',
    instanceId: randomUUID(),
    identityName: hostname(),
  }));
  state.socket = socket;
  return socket;
}

/* 生产缺省的套接字工厂：临时端口独占绑定（失败即关本地半成品并把错误交回会话）。 */
async function bindTransientSocket() {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: false });
  try {
    await bindUdp(socket, 0, '0.0.0.0');
  } catch (error) {
    closeSocketQuietly(socket);
    throw error;
  }
  return socket;
}

function warnOnce(state, message) {
  if (state.warned) {
    return;
  }
  state.warned = true;
  state.warn(message);
}

/* 应答分派：校验不过的应答不是证据；站点端口以应答字段为准（校验器保证：存在则合法）、缺失回退
 * 数据报来源端口（与发现层同口径）；投给所有端口集合包含该应答者的等待者（并发窗口互不串台）。 */
function dispatchProbeAck(state, buffer, rinfo) {
  const datagram = parseDatagram(buffer);
  if (datagram === null || !validateProbeAck(datagram).ok) {
    return;
  }
  const hit = { port: isPort(datagram.port) ? datagram.port : rinfo.port, peer: peerOf(datagram) };
  for (const waiter of state.waiters) {
    waiter.deliver(hit);
  }
}

/* 首条命中即结算的等待者（单端口证据：应答先到就短路，不等满窗口）。 */
function createFirstHitWaiter(ports) {
  const wanted = new Set(ports);
  /** @type {((hit: ProbeHit) => void) | null} */
  let resolve = null;
  const promise = new Promise((r) => { resolve = r; });
  return {
    promise,
    deliver: (hit) => {
      if (wanted.has(hit.port) && resolve !== null) {
        const done = resolve;
        resolve = null;
        done(hit);
      }
    },
  };
}

/* 窗口内收齐的等待者（段扫：只累计、不提前结算）。 */
function createCollectWaiter(ports) {
  const wanted = new Set(ports);
  const collected = new Map();
  return {
    collected: () => [...collected].map(([port, peer]) => ({ port, peer })),
    deliver: (hit) => {
      if (wanted.has(hit.port)) {
        collected.set(hit.port, hit.peer);
      }
    },
  };
}

/* 等待窗口：hitPromise 先到即以其结果结算，否则窗口到期返回 null；定时器在本函数内清理，不残留
 * （泄漏的定时器会拖住进程退出）。caller 传永不结算的 promise＝纯等窗口到期（段扫的收齐形态）。 */
async function withinWindow(budgetMs, hitPromise) {
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  try {
    return await Promise.race([
      hitPromise,
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), Math.max(1, Math.ceil(budgetMs))); }),
    ]);
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

function sessionClose(state) {
  state.closed = true;
  if (state.socket !== null) {
    closeSocketQuietly(state.socket);
    state.socket = null;
  }
}

/* 单端口双证据探测（一次性会话形态——槽位解析等单次消费点用；等待接管循环用 createProbeSession 复用套接字）。 */
/**
 * @param {{ port: number, probeTimeoutMs?: number, warn?: (message: string) => void }} options
 * @returns {Promise<{ station: boolean, peer: PeerIdentity | null }>}
 */
export async function probeStation({ port, probeTimeoutMs = OCCUPIER_PROBE_TIMEOUT_MS, warn = defaultWarn }) {
  const session = createProbeSession({ warn });
  try {
    return await session.probeStation({ port, probeTimeoutMs });
  } finally {
    session.close();
  }
}

/* 端口段应答扫描（一次性会话形态；段基与段长为注入缝，生产缺省 = 内置锚点段）。 */
/**
 * @param {{ segmentBase?: number, count?: number, probeTimeoutMs?: number, warn?: (message: string) => void }} [options]
 * @returns {Promise<Array<{ port: number, peer: PeerIdentity }>>}
 */
export async function probeSegmentStations({ segmentBase = ANCHOR_PORT, count = SLOT_COUNT, probeTimeoutMs = OCCUPIER_PROBE_TIMEOUT_MS, warn = defaultWarn } = {}) {
  const session = createProbeSession({ warn });
  try {
    return await session.scanSegment({ segmentBase, count, probeTimeoutMs });
  } finally {
    session.close();
  }
}

/* TCP 证据：拨号 + 在共享预算内等 pong（发两次——第二次覆盖「已绑定、回程帧处理器尚未接线」的启动瞬间）。
 * 任一合法 pong = 证据（连同对端身份）；拨号失败/超时 = 无证据（按无应答处理，由调用方与 UDP 证据合成结论）。 */
async function tcpEvidence({ port, budgetMs, warn }) {
  /** @type {import('node:net').Socket | null} */
  let socket = null;
  try {
    socket = await dialTcp({ port, timeoutMs: budgetMs });
    return await waitPongReply(socket, budgetMs);
  } catch (error) {
    warn(`占用者探测的 TCP 证据失败（${error.message}），按无应答处理`);
    return noEvidence();
  } finally {
    if (socket !== null) {
      socket.destroy();
    }
  }
}

/* 等 pong：首轮用一半剩余预算，未应答则重发一次、二轮用尽剩余预算（本轮等待上界 = 全预算）；
 * 返回是否收到与本轮 ping 匹配的合法 pong（及 pong 携带的对端身份）。等待定时器在本函数内清理，
 * 不残留（泄漏的定时器会拖住进程退出）。 */
async function waitPongReply(socket, budgetMs) {
  /** @type {ReturnType<typeof setTimeout> | null} */
  let waitTimer = null;
  const deadline = Date.now() + budgetMs;
  try {
    socket.on('error', () => {});
    const replyTo = randomUUID();
    const ping = pingFrame(replyTo);
    const answered = pongWatcher(socket, replyTo);
    const wait = (ms) => new Promise((resolve) => {
      waitTimer = setTimeout(() => resolve(noEvidence()), Math.max(1, Math.ceil(ms)));
    });
    socket.write(ping);
    const first = await Promise.race([answered, wait((deadline - Date.now()) / 2)]);
    if (first.hit) {
      return first;
    }
    if (waitTimer !== null) {
      clearTimeout(waitTimer);   // 首轮以「连接关闭」而非计时器结束：清掉挂起的定时器，不残留下半轮
    }
    socket.write(ping);
    return await Promise.race([answered, wait(deadline - Date.now())]);
  } finally {
    if (waitTimer !== null) {
      clearTimeout(waitTimer);
    }
  }
}

/* 逐行消费到达数据，命中与本轮 ping 匹配的合法 pong 即 resolve(证据)；连接关闭 resolve(无证据)。 */
function pongWatcher(socket, replyTo) {
  let received = '';
  return new Promise((resolve) => {
    socket.on('data', (chunk) => {
      received += chunk.toString('utf8');
      let index = received.indexOf('\n');
      while (index !== -1) {
        const line = received.slice(0, index);
        received = received.slice(index + 1);
        if (isPongFor(line, replyTo)) {
          resolve({ hit: true, peer: pongPeerOf(line) });
          return;
        }
        index = received.indexOf('\n');
      }
    });
    socket.on('close', () => resolve(noEvidence()));
  });
}

/* 探测用 ping 帧（身份为一次性随机标识 + 主机名；必须过对端协议校验，故字段齐全）。 */
function pingFrame(replyTo) {
  return JSON.stringify({
    v: PROTOCOL_VERSION,
    type: 'ping',
    msgId: replyTo,
    from: { instanceId: randomUUID(), identityName: hostname() },
    ts: new Date().toISOString(),
  }) + '\n';
}

function dialTcp({ port, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const onError = (error) => {
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`拨号超时（${timeoutMs}ms）`));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.removeListener('error', onError);
      resolve(socket);
    });
    socket.once('error', onError);
  });
}

function isPongFor(line, replyTo) {
  try {
    const frame = JSON.parse(line);
    return frame !== null && typeof frame === 'object' && frame.type === 'pong' && frame.replyTo === replyTo;
  } catch {
    return false;
  }
}

/* pong 携带的对端身份（from 字段）：身份只作附加信息——「合法 pong」的判据保持「类型 + replyTo 匹配」
 * 不变，缺少或非法的 from 不改变驿站占用结论，只是身份取不到（同族判据的宽严口径与发现层一致）。 */
function pongPeerOf(line) {
  try {
    return peerOf(JSON.parse(line).from);
  } catch {
    return null;
  }
}

/* 无命中证据（等待超时/拨号失败/套接字建立失败共用）。 */
function noEvidence() {
  return { hit: false, peer: null };
}

/* 从带身份字段的对象提取对端身份：只认「两个字段都是字符串」——
 * probe-ack 经协议校验后必成立；pong 的 from 未过校验，故此处逐个字段实判。 */
function peerOf(source) {
  if (source === null || typeof source !== 'object') {
    return null;
  }
  const fields = /** @type {Record<string, unknown>} */ (source);
  if (typeof fields.instanceId !== 'string' || typeof fields.identityName !== 'string') {
    return null;
  }
  return { instanceId: fields.instanceId, identityName: fields.identityName };
}

function parseDatagram(buffer) {
  /** @type {unknown} */
  let parsed = null;
  try {
    parsed = JSON.parse(buffer.toString('utf8'));
  } catch {
    // 解析失败与「解析结果非对象」共用下方出口：都归 null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return /** @type {Record<string, unknown>} */ (parsed);
}

/* ── 同根判别（等待接管循环，设计 §2.3/§6.1）─────────────────────────────────────────
 * 两道探测任一命中即「同根旧站点」（身份锚统一 = instanceId 吻合）：①端口段 probe-ack 命中本根身份
 * （probeSegmentStations / probeStation 采集；全段而非只探目标端口——防旧站点顺延到别端口时漏判）；
 * ②数据面命中 sessions/ 下本根新鲜旧形态会话状态文件（旧站点可能不持任何端口——锚点被无关程序占时
 * 它走报错降级、本地照常写盘，端口探测对其失明，本道是「同根＝活跃写者」的第二道防线）。
 * 判据拆成「纯函数面」（不触网不读盘：身份比对、条目判据、三分类）与「一次目录扫描」
 * （findSameRootSessions）——等待接管循环每轮重试时据此重新分类。 */

/* 同根身份判据（设计 §6.1「与本根吻合」的裁定落实）：**instanceId 吻合即命中**——两道探测同此口径。
 * instanceId 是同一数据根的裁决字段（同一数据根 = 同一 instance-id 文件）且终身不可变；
 * identityName 只作记录与诊断，不单独构成命中相——同机/跨机不同根的默认身份名相同（都是主机名），
 * 仅凭它会误判合法别根。身份名被改过的旧站点由本判据覆盖（不因改名漏判）。 */
/**
 * @param {PeerIdentity | null} peer
 * @param {{ instanceId: string | null, identityName: string } | null} own 本根身份（只读读取，缺失即 null 锚）
 * @returns {boolean}
 */
export function isSameRootPeer(peer, own) {
  if (peer === null || own === null) {
    return false;
  }
  /* 实判对端 instanceId 为字符串：防「两侧都缺该字段」（undefined === undefined）误判同根。 */
  return typeof peer.instanceId === 'string' && peer.instanceId === own.instanceId;
}

/* 会话状态文件的旧形态判据（设计 §2.3-②，裁定落实）：旧版站点写 site.mode ∈ {slot, explicit}；
 * **site === null 同属旧形态**——站点解析失败的报错降级旧站点写 null 且照常刷盘
 * （恰是数据面第二道防线的动机场景：它不持任何端口，端口探测对其失明）；新核写 'single'，
 * 按「非旧形态」显式排除，新核自身的写入不构成误命中。
 * 身份锚 = instanceId，且两侧都须是字符串（无身份以 null 表征，不得以 undefined 表达——
 * 否则「锚缺失＋条目缺字段」会 fail-open 放行）；新鲜判据 = updatedAt 落在陈旧窗口内，
 * 边界含端点（与状态栏读取端的 `<=` 同口径）；时间戳缺失/非法按不新鲜处理。 */
const OLD_FORM_SITE_MODES = new Set(['slot', 'explicit']);

/**
 * @param {unknown} entry 会话状态文件条目（外部输入：逐字段实判）
 * @param {{ instanceId: string | null, now?: number, freshMs?: number }} options 身份锚 = instanceId（与端口道同口径）
 * @returns {boolean}
 */
export function isSameRootSessionEntry(entry, { instanceId, now = Date.now(), freshMs = SESSION_STATUS_STALE_MS }) {
  if (entry === null || typeof entry !== 'object' || typeof instanceId !== 'string') {
    return false;
  }
  const fields = /** @type {Record<string, unknown>} */ (entry);
  if (fields.instanceId !== instanceId || !isOldFormSite(fields.site)) {
    return false;
  }
  const updatedAt = Date.parse(typeof fields.updatedAt === 'string' ? fields.updatedAt : '');
  return Number.isFinite(updatedAt) && now - updatedAt <= freshMs;
}

/* 旧形态站点字段：mode ∈ {slot, explicit}，或整字段为 null（报错降级的旧站点）。 */
function isOldFormSite(site) {
  if (site === null) {
    return true;
  }
  if (typeof site !== 'object') {
    return false;
  }
  const mode = /** @type {Record<string, unknown>} */ (site).mode;
  return typeof mode === 'string' && OLD_FORM_SITE_MODES.has(mode);
}

/* 数据面探测：<mainDir>/sessions/ 下命中「本根新鲜旧形态」的会话状态文件条目（无该目录/不可读 = 无命中）。
 * 读取面即状态栏读取端同一份文件形态；解析失败与形态不符的条目按无命中处理——探测只认可信证据
 * （与外部输入校验基线同口径：校验不过不采信，也不抛出）。 */
/**
 * @param {{ mainDir: string, instanceId: string | null, now?: number, freshMs?: number }} options 身份锚 = instanceId（与端口道同口径；null＝无身份，一律不命中）
 * @returns {Array<Record<string, unknown>>}
 */
export function findSameRootSessions({ mainDir, instanceId, now = Date.now(), freshMs = SESSION_STATUS_STALE_MS }) {
  const dir = join(mainDir, SESSIONS_DIR_NAME);
  /** @type {string[] | null} */
  let fileNames = null;
  try {
    fileNames = readdirSync(dir);
  } catch {
    // 目录不存在与不可读同判：无命中
  }
  if (fileNames === null) {
    return [];
  }
  const matched = [];
  for (const name of fileNames) {
    if (!name.endsWith('.json')) {
      continue;
    }
    const entry = readSessionEntry(join(dir, name));
    if (entry !== null && isSameRootSessionEntry(entry, { instanceId, now, freshMs })) {
      matched.push(entry);
    }
  }
  return matched;
}

function readSessionEntry(file) {
  /** @type {unknown} */
  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // 不存在/不可读/损坏：都不是「活跃写者」的证据（与「解析结果非对象」共用下方出口）
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return /** @type {Record<string, unknown>} */ (parsed);
}

/* 占用者三分类（设计 §6.1 的 ①无关程序 / ②合法别根驿站 / ③同根驿站）：等待接管循环每轮重试的
 * 分类判据。纯函数——证据由探测原语采集，本函数不触网不读盘。同根优先于一切：两道任一命中即
 * same-root；本根证据全无时，目标端口的合法驿站应答才归 other-station（别根），其余归 unrelated。 */
/**
 * @param {{ own: { instanceId: string | null, identityName: string },
 *   target?: { station: boolean, peer: PeerIdentity | null } | null,
 *   segment?: Array<{ port: number, peer: PeerIdentity }>,
 *   sessions?: unknown[] }} evidence
 * @returns {'same-root' | 'other-station' | 'unrelated'}
 */
export function classifyOccupant({ own, target = null, segment = [], sessions = [] }) {
  const peers = segment.map((hit) => hit.peer);
  if (target !== null && target.peer !== null) {
    peers.push(target.peer);   // 目标端口的双证据身份同属同根判据面（只应答 TCP 的同根旧站点走这里）
  }
  if (peers.some((peer) => isSameRootPeer(peer, own)) || sessions.length > 0) {
    return 'same-root';
  }
  return target !== null && target.station ? 'other-station' : 'unrelated';
}

// 站点解析在日志系统就绪之前运行——stderr 是任何时刻都合法的告警通道（与 config.js 同惯例）
function defaultWarn(message) {
  console.error(`waystation: ${message}`);
}
