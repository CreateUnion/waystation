import { isIP } from 'node:net';
import { PROTOCOL_VERSION, newMsgId } from './protocol.js';

export const OCCUPIER_PROBE_TIMEOUT_MS = 1000;

/* 网络装配（组合根的一员）：把注入的发现 / 传输 / 调度 / 接收四组件接线、按序启动、
 * 分类绑定失败并降级（设计 §13 端口占用规程），聚合状态供诊断工具。
 * 组件以注入方式传入（本模块不 import 任何组件）：组合根负责构造，接线与生命周期归本模块——
 * 「接收管线的回程帧要走调度、调度的拨号帧要走接收管线」的循环依赖在此一处解除。
 * 降级不退出进程：进程继续作为该会话的本地 MCP 服务，LAN 工具返回明确错误文本（一机一会话规程）。 */
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
  try {
    await state.discovery.start();
  } catch (error) {
    return markUnavailable(state, await classify(state, error), error);
  }
  try {
    await state.transport.listen();
  } catch (error) {
    await closeQuietly(state, state.discovery);   // 两个绑定同生共死：只有半个 LAN 监听比没有更糟
    return markUnavailable(state, await classify(state, error), error);
  }
  state.transport.setFrameHandler(state.inbound.onFrame);
  state.dispatch.setClientFrameRouter(state.inbound.onFrame);
  state.dispatch.start();
  state.inbound.start();
  state.available = true;
  state.reason = null;
  state.message = '';
  state.started = true;   // 只有成功才置位：降级不是终局——绑定条件修复后允许重试 start
  state.log.info('局域网监听已就绪', { port: state.port });
  return { ok: true };
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
}

async function listHosts(state) {
  if (!state.available) {
    return { ok: false, message: state.message };
  }
  return { ok: true, hosts: await state.discovery.scan({ windowMs: state.scanWindowMs }) };
}

async function pingHost(state, { address }) {
  if (!state.available) {
    return { ok: false, message: state.message };
  }
  if (typeof address !== 'string' || isIP(address) === 0) {
    return { ok: false, message: '地址非法：需要 IPv4/IPv6 字面量（不做域名解析）' };
  }
  return { ok: true, ...(await state.dispatch.ping({ address, port: state.port })) };
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
  try {
    connection = await state.transport.dial({ address: '127.0.0.1', port: state.port, timeoutMs: state.probeTimeoutMs });
    const replyTo = newMsgId();
    const pong = new Promise((resolve) => {
      const waitTimer = setTimeout(() => resolve(false), state.probeTimeoutMs);
      connection.onFrame((frame) => {
        if (frame.type === 'pong' && frame.replyTo === replyTo) {
          clearTimeout(waitTimer);
          resolve(true);
        }
      });
    });
    connection.send({ v: PROTOCOL_VERSION, type: 'ping', msgId: replyTo, from: state.self, ts: new Date().toISOString() });
    return (await pong) ? 'local-instance' : 'port-taken';
  } catch {
    return 'port-taken';
  } finally {
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
