import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { MAX_FRAME_BYTES, newMsgId, withCollabCapability } from '../src/net/protocol.js';
import { MAX_INBOUND_CONNECTIONS, createTransport } from '../src/net/transport.js';
import { pickFreePort, waitFor } from './helpers.js';

function quietLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

/* 协作域帧（0.2.0）：除传输类帧外根节点必须带 cap=2，from 必须带签发会话标识——
 * 缺任一项都会在入站校验阶段被判坏帧并关连接，到不了帧处理器。 */
function collabFrame(text) {
  return withCollabCapability({
    v: 1,
    msgId: newMsgId(),
    type: 'reply',
    from: { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '主机甲' },
    collabId: 'collab-1',
    ts: new Date().toISOString(),
    payload: { text },
  });
}

async function listenTransport(t, onFrame) {
  const port = await pickFreePort();
  const transport = createTransport({ port, bindAddress: '127.0.0.1', log: quietLog() });
  if (onFrame !== undefined) {
    transport.setFrameHandler(onFrame);
  }
  await transport.listen();
  t.after(() => transport.close());
  return { transport, port };
}

/** 裸 TCP 客户端：用于精确控制分片、写坏帧等传输层边界 */
function rawConnect(t, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
    t.after(() => socket.destroy());
  });
}

/** 裸 TCP 服务端：扮演拨号侧的对端（本端主动关闭 / 对端关闭两类路径都要能摆布） */
async function rawServer(t) {
  const server = net.createServer();
  await new Promise((resolve) => {
    server.listen({ port: 0, host: '127.0.0.1' }, resolve);
  });
  t.after(() => server.close());
  const accepted = new Promise((resolve) => server.once('connection', resolve));
  return { port: server.address().port, accepted };
}

test('拨号 + 帧往返：监听侧处理器收到完整帧与来源地址', { timeout: 15000 }, async (t) => {
  const received = [];
  const { transport, port } = await listenTransport(t, (connection, frame) => {
    received.push({ frame, remoteAddress: connection.remoteAddress });
  });
  const connection = await transport.dial({ address: '127.0.0.1', port, timeoutMs: 2000 });
  t.after(() => connection.close());
  connection.send(collabFrame('第一条'));
  await waitFor(() => received.length === 1);
  assert.equal(received[0].frame.type, 'reply');
  assert.equal(received[0].frame.payload.text, '第一条');
  assert.equal(received[0].remoteAddress, '127.0.0.1');
});

test('分片帧：一行分两次写入仍只回调一次', { timeout: 15000 }, async (t) => {
  const received = [];
  const { port } = await listenTransport(t, (connection, frame) => received.push(frame));
  const socket = await rawConnect(t, port);
  const line = JSON.stringify(collabFrame('分片'));
  socket.write(line.slice(0, 10));
  await new Promise((resolve) => setTimeout(resolve, 30));
  socket.write(line.slice(10) + '\n');
  await waitFor(() => received.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(received.length, 1);
});

test('粘包：一次写入两行按顺序回调两次', { timeout: 15000 }, async (t) => {
  const received = [];
  const { port } = await listenTransport(t, (connection, frame) => received.push(frame.payload.text));
  const socket = await rawConnect(t, port);
  socket.write(JSON.stringify(collabFrame('一')) + '\n' + JSON.stringify(collabFrame('二')) + '\n');
  await waitFor(() => received.length === 2);
  assert.deepEqual(received, ['一', '二']);
});

test('超限帧：计数并关闭连接', { timeout: 15000 }, async (t) => {
  const { transport, port } = await listenTransport(t, () => {});
  const socket = await rawConnect(t, port);
  const closed = new Promise((resolve) => socket.on('close', resolve));
  socket.write('x'.repeat(MAX_FRAME_BYTES + 10) + '\n');
  await closed;
  await waitFor(() => transport.stats().oversizedFrames === 1);
});

test('未成帧数据超限：计数并关闭连接', { timeout: 15000 }, async (t) => {
  const { transport, port } = await listenTransport(t, () => {});
  const socket = await rawConnect(t, port);
  const closed = new Promise((resolve) => socket.on('close', resolve));
  socket.write('y'.repeat(MAX_FRAME_BYTES + 10));
  await closed;
  await waitFor(() => transport.stats().oversizedFrames === 1);
});

test('坏帧（非 JSON / 非对象）：计数并关闭连接', { timeout: 15000 }, async (t) => {
  const { transport, port } = await listenTransport(t, () => {});
  const first = await rawConnect(t, port);
  const firstClosed = new Promise((resolve) => first.on('close', resolve));
  first.write('{oops\n');
  await firstClosed;
  const second = await rawConnect(t, port);
  const secondClosed = new Promise((resolve) => second.on('close', resolve));
  second.write('42\n');
  await secondClosed;
  await waitFor(() => transport.stats().protocolViolations === 2);
});

test('坏帧后的同 chunk 合法行：不投递（连接已死，短路）', { timeout: 15000 }, async (t) => {
  const received = [];
  const { transport, port } = await listenTransport(t, (connection, frame) => received.push(frame));
  const socket = await rawConnect(t, port);
  const closed = new Promise((resolve) => socket.on('close', resolve));
  socket.write('{oops\n' + JSON.stringify(collabFrame('紧随坏帧')) + '\n');
  await closed;
  assert.equal(transport.stats().protocolViolations, 1);
  assert.equal(received.length, 0);
});

test('超限行后的同 chunk 合法行：不投递（连接已死，短路）', { timeout: 15000 }, async (t) => {
  const received = [];
  const { transport, port } = await listenTransport(t, (connection, frame) => received.push(frame));
  const socket = await rawConnect(t, port);
  const closed = new Promise((resolve) => socket.on('close', resolve));
  socket.write('x'.repeat(MAX_FRAME_BYTES + 10) + '\n' + JSON.stringify(collabFrame('紧随超限')) + '\n');
  await closed;
  assert.equal(transport.stats().oversizedFrames, 1);
  assert.equal(received.length, 0);
});

test('非法 UTF-8 字节：按坏帧计数并关闭连接（不静默替换投递）', { timeout: 15000 }, async (t) => {
  const received = [];
  const { transport, port } = await listenTransport(t, (connection, frame) => received.push(frame));
  const socket = await rawConnect(t, port);
  const closed = new Promise((resolve) => socket.on('close', resolve));
  const frame = JSON.stringify(collabFrame('X'));   // ASCII 占位字符，便于按字节定位替换点
  const at = frame.indexOf('X');
  socket.write(Buffer.concat([
    Buffer.from(frame.slice(0, at)),
    Buffer.from([0xff, 0xfe]),                 // 非法字节：解码会被替换成 U+FFFD，JSON 本身仍可解析
    Buffer.from(frame.slice(at + 1) + '\n'),
  ]));
  await closed;
  assert.equal(transport.stats().protocolViolations, 1);
  assert.equal(transport.stats().framesIn, 0);
  assert.equal(received.length, 0);
});

test('入站连接超上限：拒绝新连接并计数', { timeout: 20000 }, async (t) => {
  const { transport, port } = await listenTransport(t, () => {});
  const held = [];
  for (let index = 0; index < MAX_INBOUND_CONNECTIONS; index++) {
    held.push(await rawConnect(t, port));
  }
  await waitFor(() => transport.stats().activeInbound === MAX_INBOUND_CONNECTIONS);
  const rejected = await rawConnect(t, port);
  const closed = new Promise((resolve) => rejected.on('close', resolve));
  await closed;
  assert.ok(transport.stats().rejectedConnections >= 1);
  for (const socket of held) {
    socket.destroy();
  }
});

test('拨号被拒（无监听者）：以 error.code 拒绝', { timeout: 15000 }, async (t) => {
  const { transport } = await listenTransport(t, () => {});
  const port = await pickFreePort();
  await assert.rejects(transport.dial({ address: '127.0.0.1', port, timeoutMs: 2000 }), (error) => error.code === 'ECONNREFUSED');
});

test('拨号超时：连接悬挂时到点拒绝并计数', { timeout: 15000 }, async (t) => {
  const { transport } = await listenTransport(t, () => {});
  const originalConnect = net.connect;
  net.connect = () => new net.Socket();   // 永不连通的替身：验证超时分支（用例结束后还原）
  t.after(() => {
    net.connect = originalConnect;
  });
  const port = await pickFreePort();
  await assert.rejects(
    transport.dial({ address: '127.0.0.1', port, timeoutMs: 50 }),
    /拨号超时/,
  );
  assert.equal(transport.stats().dialTimeouts, 1);
});

test('拨号参数非法：以 TypeError 拒绝（不静默发出坏连接）', { timeout: 15000 }, async (t) => {
  const { transport } = await listenTransport(t, () => {});
  await assert.rejects(transport.dial({ address: '', port: 70000, timeoutMs: 0 }), TypeError);
});

test('拨号连接：本地 close 触发 onClose，监听侧不回帧', { timeout: 15000 }, async (t) => {
  const { transport, port } = await listenTransport(t, () => {});
  const connection = await transport.dial({ address: '127.0.0.1', port, timeoutMs: 2000 });
  const frames = [];
  let closed = false;
  connection.onFrame((frame) => frames.push(frame));
  connection.onClose(() => {
    closed = true;
  });
  connection.send(collabFrame('触发对端回执'));
  assert.equal(frames.length, 0);
  connection.close();
  await waitFor(() => closed);
});

test('拨号连接：对端 FIN（destroy）触发本端 onClose', { timeout: 15000 }, async (t) => {
  const { transport } = await listenTransport(t, () => {});
  const { port: peerPort, accepted } = await rawServer(t);
  const connection = await transport.dial({ address: '127.0.0.1', port: peerPort, timeoutMs: 2000 });
  let closed = false;
  connection.onClose(() => {
    closed = true;
  });
  const peerSocket = await accepted;
  peerSocket.destroy();
  await waitFor(() => closed);
});

test('transport.close 级联关闭拨号连接：本端 onClose 触发、对端见关闭、之后写入不达', { timeout: 15000 }, async (t) => {
  const { transport } = await listenTransport(t, () => {});
  const { port: peerPort, accepted } = await rawServer(t);
  const connection = await transport.dial({ address: '127.0.0.1', port: peerPort, timeoutMs: 2000 });
  let closed = false;
  connection.onClose(() => {
    closed = true;
  });
  const peerSocket = await accepted;
  const peerReceived = [];
  peerSocket.on('data', (chunk) => peerReceived.push(chunk));
  const peerClosed = new Promise((resolve) => peerSocket.on('close', resolve));
  await transport.close();
  await waitFor(() => closed);
  await peerClosed;
  connection.send(collabFrame('关闭之后'));   // 已销毁 socket：静默空写，不抛
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(peerReceived.length, 0);
});

test('帧处理器抛错：连接不被拖垮，后续帧仍到达', { timeout: 15000 }, async (t) => {
  let handled = 0;
  const { port } = await listenTransport(t, () => {
    handled++;
    if (handled === 1) {
      throw new Error('处理器内部错误');
    }
  });
  const socket = await rawConnect(t, port);
  socket.write(JSON.stringify(collabFrame('一')) + '\n');
  socket.write(JSON.stringify(collabFrame('二')) + '\n');
  await waitFor(() => handled === 2);
});

test('close 等待连接收尾：返回时 activeInbound 已归零', { timeout: 15000 }, async (t) => {
  const { transport, port } = await listenTransport(t, () => {});
  for (let index = 0; index < 3; index++) {
    await rawConnect(t, port);
  }
  await waitFor(() => transport.stats().activeInbound === 3);
  await transport.close();
  assert.equal(transport.stats().activeInbound, 0);
  assert.equal(transport.stats().listening, false);
});

test('listen 幂等：二次调用空操作，close 后同端口可重绑', { timeout: 15000 }, async (t) => {
  const { transport, port } = await listenTransport(t, () => {});
  await transport.listen();
  assert.equal(transport.stats().listening, true);
  const socket = await rawConnect(t, port);   // 首个监听仍在服务：二次 listen 未顶掉它
  socket.destroy();
  await transport.close();
  const second = createTransport({ port, bindAddress: '127.0.0.1', log: quietLog() });
  await second.listen();
  await second.close();
});

test('close 释放监听：端口可再次绑定', { timeout: 15000 }, async (t) => {
  const { transport, port } = await listenTransport(t, () => {});
  await transport.close();
  const second = createTransport({ port, bindAddress: '127.0.0.1', log: quietLog() });
  await second.listen();
  await second.close();
});

test('并发 listen（同 tick 两次）：恰一次真实绑定；close 后端口可重绑（server 引用不被覆盖）', { timeout: 15000 }, async () => {
  const port = await pickFreePort();
  const transport = createTransport({ port, log: quietLog() });
  const results = await Promise.allSettled([transport.listen(), transport.listen()]);
  const fulfilled = results.filter((result) => result.status === 'fulfilled');
  const rejected = results.filter((result) => result.status === 'rejected');
  assert.equal(fulfilled.length, 1, '恰一次取得绑定');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, 'EADDRINUSE', '并发败者以端口占用落败（不得静默共存）');
  await transport.close();
  const again = createTransport({ port, log: quietLog() });
  await again.listen();   // 旧实现下 server 引用被败者覆盖 → 真正绑定的监听泄漏、端口不可重绑
  await again.close();
});

test('listen 失败可重试：失败不改变监听状态、不登记 server', { timeout: 15000 }, async (t) => {
  const port = await pickFreePort();
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen({ port, host: '0.0.0.0' }, resolve));
  t.after(() => blocker.close());
  const transport = createTransport({ port, log: quietLog() });
  await assert.rejects(transport.listen(), (error) => error.code === 'EADDRINUSE');
  assert.equal(transport.stats().listening, false, '失败不得留下「已监听」状态');
  await new Promise((resolve) => blocker.close(resolve));
  await transport.listen();   // 条件修复后首次失败仍可重试（组件一次性生命周期语义的起点）
  t.after(() => transport.close());
  assert.equal(transport.stats().listening, true);
});

test('close 后完成的拨号：入池即销毁（不给无主连接留活口）', { timeout: 15000 }, async (t) => {
  const peer = net.createServer();
  await new Promise((resolve) => peer.listen({ port: 0, host: '127.0.0.1' }, resolve));
  t.after(() => peer.close());
  const peerPort = peer.address().port;
  const liveSockets = new Set();
  peer.on('connection', (socket) => {
    liveSockets.add(socket);
    socket.on('close', () => liveSockets.delete(socket));
  });
  const transport = createTransport({ port: 0, log: quietLog() });
  await transport.close();
  const connection = await transport.dial({ address: '127.0.0.1', port: peerPort, timeoutMs: 1000 });
  assert.equal(transport.stats().closedConnections, 1);
  await waitFor(() => liveSockets.size === 0, { timeoutMs: 3000 });   // 对端观察到即时断开：连接确已被销毁
  connection.close();
});

test('close 后的入站连接（已关闭守卫路径）：activeInbound 同样归零', { timeout: 15000 }, async (t) => {
  /* 竞态窗口：连接已被派发到 'connection' 事件、而 close 先落地——onInboundSocket 已加计数，
   * attach 却走「已关闭」守卫提前返回（不登记 'close' 处理）——守卫路径必须把计数补回。
   * 拦截 createServer 的监听回调直接驱动该路径：事件循环时序无法稳定复现，手工驱动才是确定性复现。 */
  const originalCreateServer = net.createServer;
  let acceptConnection = null;
  net.createServer = (listener) => {
    acceptConnection = listener;
    return originalCreateServer(listener);
  };
  t.after(() => {
    net.createServer = originalCreateServer;
  });
  const { transport } = await listenTransport(t, () => {});
  await transport.close();
  acceptConnection(new net.Socket());
  assert.equal(transport.stats().activeInbound, 0, '守卫路径吞掉的计数必须补回');
  assert.equal(transport.stats().closedConnections, 1);
});

test('close 后 listen：明确拒绝（一次性生命周期），不造「僵尸监听」', { timeout: 15000 }, async (t) => {
  const port = await pickFreePort();
  const transport = createTransport({ port, bindAddress: '127.0.0.1', log: quietLog() });
  t.after(() => transport.close());   // 防御性收口：修复回退时僵尸监听会挂住整个测试进程（挂起即证据本身）
  await transport.listen();
  await transport.close();
  await assert.rejects(transport.listen(), /已关闭/);
  assert.equal(transport.stats().listening, false, '拒绝路径不得留下「已监听」状态');
  const rebind = net.createServer();   // close 的端口释放语义不因拒绝路径回退：新组件仍可绑定
  await new Promise((resolve) => rebind.listen({ port, host: '127.0.0.1' }, resolve));
  await new Promise((resolve) => rebind.close(resolve));
});
