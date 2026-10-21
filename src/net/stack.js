import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { OCCUPIER_PROBE_TIMEOUT_MS } from '../site.js';
import { ID_PATTERN, PROTOCOL_VERSION, isIdentityName, isPort, newMsgId } from './protocol.js';

/* 组件已被 close 后重试 start 的固定结论：一次性生命周期下重试不可能成功，恢复途径是重建组件（组合根职责） */
const COMPONENTS_CLOSED = {
  reason: 'components-closed',
  message: '网络组件已关闭且不可复用——需重建组件后重试（正常恢复路径为重启进程）',
};

/* 网络装配（组合根的一员）：把注入的发现 / 传输 / 调度 / 接收四组件接线、按序启动、
 * 分类绑定失败并降级（设计 §13 端口占用规程），聚合状态供诊断工具。
 * 组件以注入方式传入（本模块不 import 任何组件）：组合根负责构造，接线与生命周期归本模块——
 * 「接收管线的回程帧要走调度、调度的拨号帧要走接收管线」的循环依赖在此一处解除。
 * 降级不退出进程：进程继续作为该会话的本地 MCP 服务，LAN 工具返回明确错误文本（多站点模型下
 * 为站点级降级——只影响本进程的 LAN 面，同机其他站点不受影响）。
 * start() 永不拒绝：任何失败都以 {ok:false, reason, message} 返回。reason ∈ occupied-by-station / port-taken /
 * bind-failed（绑定分类）、wiring-failed（接线失败，已撤下监听）、components-closed（组件已随关闭销毁）；
 * 站点解析已判不可用（degraded 入参）时直接以解析结论降级、不触达组件。
 * 重试语义（组件一次性生命周期）：组件未被 close 时（首次启动尝试失败）可重试；
 * 一旦有组件被 close（TCP 失败分支撤下 discovery、close()），重试返回 components-closed——
 * 恢复途径是重建组件（组合根职责），进程重启是正常恢复路径。 */
/**
 * @param {{ discovery: any, transport: any, dispatch: any, inbound: any, port: number, self: any, scanWindowMs: number, log: any, probeTimeoutMs?: number, degraded?: { reason: string, message: string } | null }} options
 */
export function createNetStack({ discovery, transport, dispatch, inbound, port, self, scanWindowMs, log, probeTimeoutMs = OCCUPIER_PROBE_TIMEOUT_MS, degraded = null }) {
  const state = {
    discovery,
    transport,
    dispatch,
    inbound,
    port,
    self,
    scanWindowMs,
    log,
    probeTimeoutMs,
    degraded,
    available: false,
    reason: null,
    message: '',
    started: false,
    componentsClosed: false,
  };
  return {
    start: () => start(state),
    close: () => close(state),
    listHosts: () => listHosts(state),
    pingHost: (options) => pingHost(state, options),
    requestJoin: (options) => requestJoin(state, options ?? {}),
    requestJoinResolve: (options) => requestJoinResolve(state, options ?? {}),
    probeCapability: (options) => probeCapability(state, options ?? {}),
    send: (message) => state.dispatch.send(message),
    deliveryStatus: (query) => state.dispatch.deliveryStatus(query ?? {}),
    checkInbox: (query) => state.inbound.checkInbox(query),
    status: () => statusOf(state),
  };
}

/* 前置阻断结论（不触达组件的两类「不可启动」）：组件已销毁 / 站点解析判定不可用。
 * 返回带归类与错误对象的结论，null 表示可继续启动。 */
function blockedReasonOf(state) {
  if (state.componentsClosed) {
    /* 组件已被 close（一次性生命周期）：重试不可能成功，也不是绑定失败——已关闭套接字的错误
     * （如 ERR_SOCKET_DGRAM_NOT_RUNNING）不得误分类为 bind-failed，直接给出「需重建」结论 */
    return { classified: COMPONENTS_CLOSED, error: new Error('组件已关闭') };
  }
  if (state.degraded !== null) {
    /* 站点解析已判不可用（槽位段耗尽 / 锚点被无关程序占 / 显式端口被占）：绑定必然失败，
     * 不再触达组件——直接以解析结论降级（进程继续作为本地 MCP 服务，LAN 工具返回该文案）。 */
    return { classified: state.degraded, error: new Error('站点解析判定不可用') };
  }
  return null;
}

async function start(state) {
  if (state.started) {
    return { ok: true };
  }
  const blocked = blockedReasonOf(state);
  if (blocked !== null) {
    return markUnavailable(state, blocked.classified, blocked.error);
  }
  try {
    await state.discovery.start();
  } catch (error) {
    return markUnavailable(state, await classify(state, error), error);
  }
  announceQuietly(state);   // 自介：UDP 监听就绪即发（不等 TCP）——设计 §5
  try {
    await state.transport.listen();
  } catch (error) {
    await closeQuietly(state, state.discovery);   // 两个绑定同生共死：只有半个 LAN 监听比没有更糟
    state.componentsClosed = true;                // 撤下即销毁：组件不可复用，此后重试不可能成功
    return markUnavailable(state, await classify(state, error), error);
  }
  try {
    state.transport.setFrameHandler(state.inbound.onFrame);
    state.dispatch.setClientFrameRouter(state.inbound.onFrame);
    state.dispatch.start();
    state.inbound.start();
  } catch (error) {
    return tearDownWiring(state, error);
  }
  state.available = true;
  state.reason = null;
  state.message = '';
  state.started = true;   // 只有成功才置位：首次启动尝试失败（未 close 组件）后可重试，见 componentsClosed
  try {
    state.log.info('局域网监听已就绪', { port: state.port });
  } catch {
    /* 日志不属启动关键路径：写失败不得改变「已就绪」结论 */
  }
  return { ok: true };
}

/* 接线失败：先停调度（在途拨号收口——transport.close 兜不住 close 前未连上的拨号 socket），
 * 再同生共死撤下两个监听。dispatch.stop 的异常不得掩盖原始接线错误——各自兜底后以原错误收口。 */
async function tearDownWiring(state, error) {
  try {
    await state.dispatch.stop();
  } catch (stopError) {
    state.log.warn('接线失败后的调度停止异常（已忽略）', { reason: stopError.message });
  }
  await closeQuietly(state, state.transport);
  await closeQuietly(state, state.discovery);
  state.componentsClosed = true;
  return markUnavailable(state, {
    reason: 'wiring-failed',
    message: `局域网组件接线失败（${error.message}）——已撤下监听，需重建组件后重试`,
  }, error);
}

async function close(state) {
  try {
    await state.dispatch.stop();   // stop 返回 promise：等到在途拨号收口落地后再关闭其余组件
  } catch (error) {
    state.log.error('调度停止异常（继续关闭其余组件）', { reason: error.message });
  }
  try {
    state.inbound.stop();
  } catch (error) {
    state.log.error('接收停止异常（继续关闭其余组件）', { reason: error.message });
  }
  await closeQuietly(state, state.transport);
  await closeQuietly(state, state.discovery);
  state.available = false;
  state.started = false;
  state.componentsClosed = true;   // 组件已销毁：start 不可能成功（一次性生命周期），恢复须重建组件
}

async function listHosts(state) {
  if (!state.available) {
    return { ok: false, message: state.message };
  }
  try {
    const interfaces = networkInterfaces();
    const hosts = (await state.discovery.scan({ windowMs: state.scanWindowMs }))
      .map((host) => ({ ...host, sameMachine: host.endpoints.some((endpoint) => isLocalAddress(endpoint.address, interfaces)) }));
    return { ok: true, hosts };
  } catch (error) {
    return { ok: false, message: `主机列表扫描失败：${error.message}` };
  }
}

/* 同机判定：地址属本机接口表（os.networkInterfaces）或回环段（127.0.0.0/8——只有本机可达，
 * 探测应答与单播兜底都可能以回环地址呈现同机实例）即同机，用于给扫描条目加「同机」标注。
 * 自身实例不靠本判定排除（那一层按实例标识在发现层完成）：这里标的是同一台机器上的其他
 * 数据根实例——它们是合法协作对象，不得被任何地址过滤掉，只如实标注。
 * 接口表经注入缝（单测喂表，生产现取）；地址缺失/非法一律 false（标注是呈现面，不改变清单本身）。 */
export function isLocalAddress(address, interfaces = networkInterfaces()) {
  if (typeof address !== 'string' || address === '') {
    return false;
  }
  if (address.startsWith('127.')) {
    return true;
  }
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry?.address === address) {
        return true;
      }
    }
  }
  return false;
}

async function pingHost(state, { address, port }) {
  if (!state.available) {
    return { ok: false, message: state.message };
  }
  if (typeof address !== 'string' || isIP(address) === 0) {
    return { ok: false, message: '地址非法：需要 IPv4/IPv6 字面量（不做域名解析）' };
  }
  if (!isPort(port)) {
    return { ok: false, message: '端口非法：需要 1–65535 的整数（端口来源以扫描列表为准）' };
  }
  try {
    return { ok: true, ...(await state.dispatch.ping({ address, port })) };
  } catch (error) {
    return { ok: false, message: `主机探测失败：${error.message}` };
  }
}

/* 主动加入敲门（设计 §5.6；工具 ws_request_join 的落点）：讨论名形态在启程前把关——发现类广播会把
 * 名字播给全网，不发畸形载荷、也不做无谓的收答等待；无应答 = 空清单（统一「无应答」提示由工具层
 * 承载；不作错误、不自动重试）。 */
async function requestJoin(state, { name }) {
  if (!state.available) {
    return { ok: false, message: state.message };
  }
  const wanted = typeof name === 'string' ? name.trim() : '';
  if (!isIdentityName(wanted)) {
    return { ok: false, message: '讨论名非法：需要 ≤64 字符、不含换行 / 不可见字符的呈现文本（同身份名判据）' };
  }
  try {
    return { ok: true, replies: await state.discovery.requestJoin({ name: wanted }) };
  } catch (error) {
    return { ok: false, message: `主动加入敲门失败：${error.message}` };
  }
}

/* 按名解析（会话级管理设计 §2；加入域与工具面的落点）：向指定驿站单播问「谁在 <讨论名> 讨论」。
 * 讨论名与目标端点（来自扫描列表 / 已知主机清单）在启程前把关——不发畸形载荷、也不做无谓的收答等待；
 * reply 为 null = 窗口内没有应答（不可达 / 丢包），与「答了未命中」（found:false）是两回事，
 * 由调用方按各自语义处置（统一文案由工具层承载）。 */
async function requestJoinResolve(state, { name, address, port, instanceId, timeoutMs }) {
  if (!state.available) {
    return { ok: false, message: state.message };
  }
  const wanted = typeof name === 'string' ? name.trim() : '';
  if (!isIdentityName(wanted)) {
    return { ok: false, message: '讨论名非法：需要 ≤64 字符、不含换行 / 不可见字符的呈现文本（同身份名判据）' };
  }
  if (typeof address !== 'string' || isIP(address) === 0) {
    return { ok: false, message: '目标地址非法：需要 IPv4/IPv6 字面量（不做域名解析）' };
  }
  if (!isPort(port)) {
    return { ok: false, message: '目标端口非法：需要 1–65535 的整数（端口来源以扫描列表为准）' };
  }
  const instanceError = instanceIdErrorOf(instanceId);
  if (instanceError !== null) {
    return { ok: false, message: instanceError };
  }
  try {
    /* instanceId 是对端归户证据（同机多实例时只采信该实例的应答），原样透传给发现面。 */
    return { ok: true, reply: await state.discovery.requestJoinResolve({ name: wanted, address, port, ...(instanceId === undefined ? {} : { instanceId }), timeoutMs }) };
  } catch (error) {
    return { ok: false, message: `按名解析失败：${error.message}` };
  }
}

/* 能力单播探测（发现面 → 工具面）：未知先探测的闸门在服务层，工具层只经此转调；
 * instanceId 同按名解析——给了就只认该实例的应答，不做来源地址归户。 */
async function probeCapability(state, { address, port, instanceId, timeoutMs }) {
  if (!state.available) {
    return { ok: false, message: state.message };
  }
  if (typeof address !== 'string' || isIP(address) === 0) {
    return { ok: false, message: '目标地址非法：需要 IPv4/IPv6 字面量（不做域名解析）' };
  }
  if (!isPort(port)) {
    return { ok: false, message: '目标端口非法：需要 1–65535 的整数（端口来源以扫描列表为准）' };
  }
  const instanceError = instanceIdErrorOf(instanceId);
  if (instanceError !== null) {
    return { ok: false, message: instanceError };
  }
  try {
    const result = await state.discovery.probeCapability({ address, port, ...(instanceId === undefined ? {} : { instanceId }), ...(timeoutMs === undefined ? {} : { timeoutMs }) });
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, message: `能力探测失败：${error.message}` };
  }
}

/* 可选实例标识的形态把关（两条单播面共用）：没给＝不按实例归户；给了但形态坏不得静默忽略。
 * 判据与协议标识（ID_PATTERN）同一口径：形态不符的标识永远匹配不上任何应答，收口在启程前。 */
function instanceIdErrorOf(instanceId) {
  if (instanceId === undefined) {
    return null;
  }
  if (typeof instanceId !== 'string' || !ID_PATTERN.test(instanceId)) {
    return '目标实例标识非法：需要 1–64 位字母数字与连字符（或省略）';
  }
  return null;
}

function statusOf(state) {
  return {
    available: state.available,
    reason: state.reason,
    message: state.message,
    port: state.port,
    counters: {
      discovery: state.discovery.stats(),
      transport: state.transport.stats(),
      dispatch: state.dispatch.stats(),
      inbound: state.inbound.stats(),
    },
  };
}

/* 占用者分类（设计 §13 的绑定竞态路径）：拨本机端口发 ping——应答合法 pong = 端口被其他驿站站点占用
 * （本终端在一次槽位竞选中落败：不换槽位，重启本终端即自动改取下一空闲槽位）；其余一律按无关程序占用
 * （指引释放端口或改站点 config.json 的 port——端口按站点独立，无「全网同步」之说）。 */
async function classify(state, error) {
  if (error.code !== 'EADDRINUSE') {
    return { reason: 'bind-failed', message: `端口 ${state.port} 监听失败（${error.message}）——局域网功能不可用` };
  }
  const occupier = await probeOccupier(state);
  if (occupier === 'station') {
    return {
      reason: 'occupied-by-station',
      message: `端口 ${state.port} 在启动瞬间被其他驿站站点占用（并发启动竞争）——本进程不建立局域网监听；重启本终端可自动改取下一空闲槽位`,
    };
  }
  return {
    reason: 'port-taken',
    message: `端口 ${state.port} 被其他程序占用，无法建立局域网监听——请释放该端口，或在站点数据目录的 config.json 中修改 port 后重启`,
  };
}

async function probeOccupier(state) {
  /* 连接句柄按接口消费（形状由注入的 transport 定义）：显式 any 让类型检查接受收窄与 finally 关闭 */
  /** @type {any} */
  let connection = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let waitTimer = null;
  const deadline = Date.now() + state.probeTimeoutMs;   // 预算共享：拨号与 pong 等待共用同一 deadline，合计不超过 probeTimeoutMs
  try {
    connection = await state.transport.dial({ address: '127.0.0.1', port: state.port, timeoutMs: state.probeTimeoutMs });
    const replyTo = newMsgId();
    let answered = false;
    /** @type {Promise<void>} */
    const pongArrived = new Promise((resolve) => {
      connection.onFrame((frame) => {
        if (frame.type === 'pong' && frame.replyTo === replyTo) {
          answered = true;
          resolve();
        }
      });
    });
    const waitPong = (ms) => new Promise((resolve) => {
      waitTimer = setTimeout(resolve, ms);
    });
    const ping = { v: PROTOCOL_VERSION, type: 'ping', msgId: replyTo, from: state.self, ts: new Date().toISOString() };
    /* 发两次：第二次覆盖「占用者已 bind、回程帧处理器尚未接线」的启动瞬间（该窗口内帧被丢弃），
     * 使本机驿站实例的启动窗口收敛回「驿站占」分类；首次只等半个剩余预算，留一半给重发 */
    connection.send(ping);
    await Promise.race([pongArrived, waitPong(Math.max(1, Math.ceil((deadline - Date.now()) / 2)))]);
    if (!answered) {
      connection.send(ping);
      await Promise.race([pongArrived, waitPong(Math.max(1, deadline - Date.now()))]);
    }
    return answered ? 'station' : 'unrelated';
  } catch {
    return 'unrelated';
  } finally {
    if (waitTimer !== null) {
      clearTimeout(waitTimer);
    }
    if (connection !== null) {
      connection.close();
    }
  }
}

function markUnavailable(state, classified, error) {
  state.available = false;
  state.reason = classified.reason;
  state.message = classified.message;
  state.log.warn(classified.message, { reason: classified.reason, error: error.message });
  return { ok: false, reason: classified.reason, message: classified.message };
}

async function closeQuietly(state, component) {
  try {
    await component.close();
  } catch (error) {
    state.log.warn('组件关闭异常（已忽略）', { reason: error.message });
  }
}

/* 启动自介（设计 §5）：UDP 监听就绪即发、不等待 TCP。announce 内部已兜底不抛出；
 * 这里再包一层是双保险——自介失败绝不改变启动结论（它是发现辅助、不是启动关键路径）。 */
function announceQuietly(state) {
  try {
    state.discovery.announce();
  } catch (error) {
    state.log.warn('启动自介异常（已忽略）', { reason: error.message });
  }
}
