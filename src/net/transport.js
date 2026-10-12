import net from 'node:net';
import { MAX_FRAME_BYTES, parseFrame } from './protocol.js';

export const MAX_INBOUND_CONNECTIONS = 64;
const NEWLINE = 0x0a;

/* TCP 帧通道（设计 §5/§10）：发送方拨入接收方驿站、按需建立、可复用。
 * 帧 = 一行 JSON（NDJSON）；超限 / 非法 UTF-8 / 不可解析 / 非对象 → 计数 + 关连接（入站校验基线）。
 * 本层只管「连接与帧」；消息语义（类型路由、ack、去重、保序）在接收管线与发送调度。
 * setFrameHandler 经 setter 注入：组合根在构造时无法解「接收管线与发送调度的循环依赖」；
 * 未接线时帧只计数丢弃，不关连接（装配完成后才开始收帧属正常路径）。 */
export function createTransport({ port, bindAddress = '0.0.0.0', log }) {
  const state = {
    port,
    bindAddress,
    log,
    counters: {
      inboundTotal: 0,
      activeInbound: 0,
      rejectedConnections: 0,
      framesIn: 0,
      framesOut: 0,
      droppedFrames: 0,
      oversizedFrames: 0,
      protocolViolations: 0,
      socketErrors: 0,
      dialTotal: 0,
      dialFailures: 0,
      dialTimeouts: 0,
    },
    sockets: new Set(),
    frameHandler: null,
    server: null,
    listening: false,
  };
  return {
    /** 监听入站端口；失败向上抛（含 error.code，由装配侧分类）；已在监听时重复调用为空操作。
     * 不新建 server、不覆盖引用——装配侧降级重试会再次调用本方法，覆盖引用会让 close() 关错对象、端口泄漏。 */
    listen: () => listen(state),
    /** 关闭全部监听与拨号连接（两个方向都在内）：停止接受新连接、销毁本层造出的每个 socket，
     * 并等各连接 'close' 事件落地后才 resolve——返回即代表连接计数已归零。可重复调用。 */
    close: () => close(state),
    dial: (options) => dial(state, options),
    setFrameHandler: (handler) => {
      state.frameHandler = handler;
    },
    stats: () => ({ ...state.counters, listening: state.listening }),
  };
}

function listen(state) {
  if (state.listening) {
    return Promise.resolve();
  }
  // resolve 无参调用：显式 Promise<void> 让类型检查接受 0 参 resolve
  return /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
    state.server = net.createServer((socket) => {
      onInboundSocket(state, socket);
    });
    state.server.once('error', reject);
    state.server.listen({ port: state.port, host: state.bindAddress }, () => {
      state.server.removeListener('error', reject);
      state.server.on('error', (error) => {
        state.counters.socketErrors++;
        state.log.warn('监听套接字错误（不退出进程）', { reason: error.message });
      });
      state.listening = true;
      resolve();
    });
  }));
}

/* 关闭全部监听与拨号连接：停监听、销毁连接集合里的每个 socket，再等各自的 'close' 事件落地。
 * 只等 server 的 'close' 不够——server drain 先于被销毁 socket 的事件，连接计数会滞后于本函数的返回。 */
async function close(state) {
  state.listening = false;
  const server = state.server;
  state.server = null;
  const closing = [...state.sockets].map((socket) => new Promise((resolve) => {
    socket.once('close', resolve);
    socket.destroy();
  }));
  if (server !== null && server.listening) {
    // resolve 无参调用：显式 Promise<void> 让类型检查接受 0 参 resolve
    await /** @type {Promise<void>} */ (new Promise((resolve) => {
      server.close(() => {
        resolve();
      });
    }));
  }
  await Promise.all(closing);
}

function dial(state, { address, port: targetPort, timeoutMs }) {
  const legal = typeof address === 'string' && address !== ''
    && Number.isInteger(targetPort) && targetPort >= 1 && targetPort <= 65535
    && Number.isInteger(timeoutMs) && timeoutMs >= 1;
  if (!legal) {
    return Promise.reject(new TypeError('dial 参数非法（address / port / timeoutMs）'));
  }
  state.counters.dialTotal++;
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: address, port: targetPort });
    const timer = setTimeout(() => {
      state.counters.dialTimeouts++;
      socket.destroy();
      reject(new Error(`拨号超时（${timeoutMs}ms）：${address}:${targetPort}`));
    }, timeoutMs);
    const onError = (error) => {
      clearTimeout(timer);
      state.counters.dialFailures++;
      reject(error);
    };
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.removeListener('error', onError);
      resolve(attach(state, socket, false));
    });
    socket.once('error', onError);
  });
}

function onInboundSocket(state, socket) {
  state.counters.inboundTotal++;
  if (state.counters.activeInbound >= MAX_INBOUND_CONNECTIONS) {
    state.counters.rejectedConnections++;
    state.log.warn('入站连接超上限，拒绝', { limit: MAX_INBOUND_CONNECTIONS });
    socket.destroy();
    return;
  }
  state.counters.activeInbound++;
  const connection = attach(state, socket, true);
  connection.onFrame((frame) => {
    dispatchFrame(state, connection, frame);
  });
}

function dispatchFrame(state, connection, frame) {
  if (state.frameHandler === null) {
    state.counters.droppedFrames++;
    state.log.warn('帧处理器未接线，帧被丢弃');
    return;
  }
  state.counters.framesIn++;
  try {
    const result = state.frameHandler(connection, frame);
    if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
      result.catch((error) => {
        state.log.error('帧处理异常（异步）', { reason: error.message });
      });
    }
  } catch (error) {
    state.log.error('帧处理异常（不拖垮连接）', { reason: error.message });
  }
}

function attach(state, socket, countsAsInbound) {
  const connection = createConnection(socket, state.counters);
  let buffered = Buffer.alloc(0);
  state.sockets.add(socket);   // 监听与拨号连接同池：close() 对两个方向都负责回收
  socket.on('data', (chunk) => {
    buffered = consumeLines(state, socket, connection, Buffer.concat([buffered, chunk]));
  });
  socket.on('error', (error) => {
    state.counters.socketErrors++;
    state.log.warn('连接出错（帧通道）', { reason: error.message });
  });
  socket.on('close', () => {
    if (countsAsInbound) {
      state.counters.activeInbound--;
    }
    state.sockets.delete(socket);   // 集合成员恒为「'close' 未落地」的连接
    connection.notifyClose();
  });
  return connection;
}

/* 逐行消费缓冲，返回剩余缓冲。坏帧或未成帧超限会关闭连接并返回空缓冲：
 * 「计数 + 关连接」之后，同一 chunk 的后续行不再被解析投递（连接语义上已死）。 */
function consumeLines(state, socket, connection, buffered) {
  let rest = buffered;
  let index = rest.indexOf(NEWLINE);
  while (index !== -1) {
    const line = rest.subarray(0, index);
    rest = rest.subarray(index + 1);
    if (line.length > MAX_FRAME_BYTES) {
      state.counters.oversizedFrames++;
      state.log.warn('帧超体积上限，关闭连接', { bytes: line.length, limit: MAX_FRAME_BYTES });
      socket.destroy();
      return Buffer.alloc(0);
    }
    if (!handleLine(state, connection, line)) {
      return Buffer.alloc(0);
    }
    index = rest.indexOf(NEWLINE);
  }
  if (rest.length > MAX_FRAME_BYTES) {
    state.counters.oversizedFrames++;
    state.log.warn('未成帧数据超体积上限，关闭连接', { bytes: rest.length });
    socket.destroy();
    return Buffer.alloc(0);
  }
  return rest;
}

/* 解析一行帧并投递；返回 false 表示连接已因坏帧关闭（调用方必须停止本 chunk 的后续行）。
 * 非法 UTF-8 字节与「不可解析」同语义：解码后再编码与原字节不等，说明含替换或截断的字节——
 * 静默替换成 U+FFFD 等于把破坏的字节当别的字符接受，属入站校验基线禁止的静默接受。 */
function handleLine(state, connection, line) {
  const text = line.toString('utf8');
  const parsed = parseFrame(text);
  if (!parsed.ok || !Buffer.from(text, 'utf8').equals(line)) {
    state.counters.protocolViolations++;
    state.log.warn('帧校验失败，关闭连接', {
      reason: parsed.ok ? '帧含非法 UTF-8 字节序列' : parsed.reason,
    });
    connection.close();
    return false;
  }
  connection.deliver(parsed.frame);
  return true;
}

/* 连接句柄：send 只做「序列化 + 一行写入」，写失败交给 socket error 通道；
 * deliver 在未注册帧回调时计数丢弃（拨号连接在注册前先收帧的窗口）。 */
function createConnection(socket, counters) {
  /** @type {null | ((frame: object) => void)} */
  let frameSink = null;
  /** @type {null | (() => void)} */
  let closeListener = null;
  return {
    remoteAddress: typeof socket.remoteAddress === 'string' ? socket.remoteAddress : '',
    send(frame) {
      counters.framesOut++;
      /* 对端已关闭（FIN）或本地已销毁的 socket 上 write 是静默丢弃：Node 流语义，不走 'error' 事件；
       * 只有真实在途失败（如 RST）才落到 socket error 计数。死对端检测以 onClose / 'close' 事件为准。 */
      socket.write(JSON.stringify(frame) + '\n');
    },
    onFrame(callback) {
      frameSink = callback;
    },
    onClose(callback) {
      closeListener = callback;
    },
    close() {
      socket.destroy();
    },
    deliver(frame) {
      if (frameSink === null) {
        counters.droppedFrames++;
        return;
      }
      frameSink(frame);
    },
    notifyClose() {
      if (closeListener !== null) {
        closeListener();
      }
    },
  };
}
