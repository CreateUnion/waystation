import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { MAX_FRAME_BYTES, newMsgId } from '../src/net/protocol.js';
import { MAX_INBOUND_CONNECTIONS, createTransport } from '../src/net/transport.js';
import { pickFreePort, waitFor } from './helpers.js';

function quietLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function notice(text) {
  return { v: 1, msgId: newMsgId(), type: 'notice', from: { instanceId: 'inst-a', identityName: '主机甲' }, collabId: 'collab-1', ts: new Date().toISOString(), payload: { text } };
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

test('拨号 + 帧往返：监听侧处理器收到完整帧与来源地址', { timeout: 15000 }, async (t) => {
  const received = [];
  const { transport, port } = await listenTransport(t, (connection, frame) => {
    received.push({ frame, remoteAddress: connection.remoteAddress });
  });
  const connection = await transport.dial({ address: '127.0.0.1', port, timeoutMs: 2000 });
  t.after(() => connection.close());
  connection.send(notice('第一条'));
  await waitFor(() => received.length === 1);
  assert.equal(received[0].frame.type, 'notice');
  assert.equal(received[0].frame.payload.text, '第一条');
  assert.equal(received[0].remoteAddress, '127.0.0.1');
});

test('分片帧：一行分两次写入仍只回调一次', { timeout: 15000 }, async (t) => {
  const received = [];
  const { port } = await listenTransport(t, (connection, frame) => received.push(frame));
  const socket = await rawConnect(t, port);
  const line = JSON.stringify(notice('分片'));
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
  socket.write(JSON.stringify(notice('一')) + '\n' + JSON.stringify(notice('二')) + '\n');
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

test('拨号连接的收帧与关闭回调：对端关闭时触发 onClose', { timeout: 15000 }, async (t) => {
  const { transport, port } = await listenTransport(t, () => {});
  const connection = await transport.dial({ address: '127.0.0.1', port, timeoutMs: 2000 });
  const frames = [];
  let closed = false;
  connection.onFrame((frame) => frames.push(frame));
  connection.onClose(() => {
    closed = true;
  });
  connection.send(notice('触发对端回执'));
  assert.equal(frames.length, 0);
  connection.close();
  await waitFor(() => closed);
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
  socket.write(JSON.stringify(notice('一')) + '\n');
  socket.write(JSON.stringify(notice('二')) + '\n');
  await waitFor(() => handled === 2);
});

test('close 释放监听：端口可再次绑定', { timeout: 15000 }, async (t) => {
  const { transport, port } = await listenTransport(t, () => {});
  await transport.close();
  const second = createTransport({ port, bindAddress: '127.0.0.1', log: quietLog() });
  await second.listen();
  await second.close();
});
