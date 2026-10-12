import { isIP } from 'node:net';
import { PROTOCOL_VERSION, newMsgId } from './protocol.js';

export const OCCUPIER_PROBE_TIMEOUT_MS = 1000;

/* 组件已被 close 后重试 start 的固定结论：一次性生命周期下重试不可能成功，恢复途径是重建组件（组合根职责） */
const COMPONENTS_CLOSED = {
  reason: 'components-closed',
  message: '网络组件已关闭且不可复用——需重建组件后重试（正常恢复路径为重启进程）',
};

/* 网络装配（组合根的一员）：把注入的发现 / 传输 / 调度 / 接收四组件接线、按序启动、
 * 分类绑定失败并降级（设计 §13 端口占用规程），聚合状态供诊断工具。
 * 组件以注入方式传入（本模块不 import 任何组件）：组合根负责构造，接线与生命周期归本模块——
 * 「接收管线的回程帧要走调度、调度的拨号帧要走接收管线」的循环依赖在此一处解除。
 * 降级不退出进程：进程继续作为该会话的本地 MCP 服务，LAN 工具返回明确错误文本（一机一会话规程）。
 * start() 永不拒绝：任何失败都以 {ok:false, reason, message} 返回。reason ∈ local-instance / port-taken /
 * bind-failed（绑定分类）、wiring-failed（接线失败，已撤下监听）、components-closed（组件已随关闭销毁）。
 * 重试语义（组件一次性生命周期）：组件未被 close 时（首次启动尝试失败）可重试；
 * 一旦有组件被 close（TCP 失败分支撤下 discovery、close()），重试返回 components-closed——
 * 恢复途径是重建组件（组合根职责），进程重启是正常恢复路径。 */
export function createNetStack({ discovery, transport, dispatch, inbound, port, self, scanWindowMs, log, probeTimeoutMs = OCCUPIER_PROBE_TIMEOUT_MS }) {
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
    send: (message) => state.dispatch.send(message),
    deliveryStatus: (query) => state.dispatch.deliveryStatus(query ?? {}),
    status: () => statusOf(state),
  };
}

async function start(state) {
  if (state.started) {
    return { ok: true };
  }
  if (state.componentsClosed) {
    /* 组件已被 close（一次性生命周期）：重试不可能成功，也不是绑定失败——已关闭套接字的错误
     * （如 ERR_SOCKET_DGRAM_NOT_RUNNING）不得误分类为 bind-failed，直接给出「需重建」结论 */
    return markUnavailable(state, COMPONENTS_CLOSED, new Error('组件已关闭'));
  }
  try {
    await state.discovery.start();
  } catch (error) {
    return markUnavailable(state, await classify(state, error), error);
  }
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

/* 接线失败：同生共死撤下两个监听并置「组件已销毁」，给出「需重建」结论（不把异常直穿给调用方） */
async function tearDownWiring(state, error) {
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
    state.dispatch.stop();
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
    return { ok: true, hosts: await state.discovery.scan({ windowMs: state.scanWindowMs }) };
  } catch (error) {
    return { ok: false, message: `主机列表扫描失败：${error.message}` };
  }
}

async function pingHost(state, { address }) {
  if (!state.available) {
    return { ok: false, message: state.message };
  }
  if (typeof address !== 'string' || isIP(address) === 0) {
    return { ok: false, message: '地址非法：需要 IPv4/IPv6 字面量（不做域名解析）' };
  }
  try {
    return { ok: true, ...(await state.dispatch.ping({ address, port: state.port })) };
  } catch (error) {
    return { ok: false, message: `主机探测失败：${error.message}` };
  }
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

/* 占用者分类（设计 §13）：拨本机端口发一个 ping——应答合法 pong = 本机已有驿站（一机一会话）；
 * 其余（拒连 / 沉默 / 非本协议）一律按无关程序占用处置，文案给改端口指引。 */
async function classify(state, error) {
  if (error.code !== 'EADDRINUSE') {
    return { reason: 'bind-failed', message: `端口 ${state.port} 监听失败（${error.message}）——局域网功能不可用` };
  }
  const occupier = await probeOccupier(state);
  if (occupier === 'local-instance') {
    return {
      reason: 'local-instance',
      message: `本机已有驿站会话在监听端口 ${state.port}——本进程不建立局域网监听（一机一会话的既定行为），依赖局域网的工具暂不可用`,
    };
  }
  return {
    reason: 'port-taken',
    message: `端口 ${state.port} 被其他程序占用，无法建立局域网监听——请在数据目录的 config.json 中修改 port（改动需全网同步）后重启`,
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
     * 使本机驿站实例的启动窗口收敛回 local-instance 语义；首次只等半个剩余预算，留一半给重发 */
    connection.send(ping);
    await Promise.race([pongArrived, waitPong(Math.max(1, Math.ceil((deadline - Date.now()) / 2)))]);
    if (!answered) {
      connection.send(ping);
      await Promise.race([pongArrived, waitPong(Math.max(1, deadline - Date.now()))]);
    }
    return answered ? 'local-instance' : 'port-taken';
  } catch {
    return 'port-taken';
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
