import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDispatch } from '../src/net/dispatch.js';
import { createTransport } from '../src/net/transport.js';
import { newMsgId } from '../src/net/protocol.js';
import { makeTempDir, pickFreePort, waitFor } from './helpers.js';

/* 对端重启后的发送恢复（§2A.8⑥ 旧站长回归、D15 重发）：连接池不得继续复用已死连接，
 * 单元退避不得让「重发」在 FIFO 队头后面空等一轮慢退避——两者都会让重启端收不到治理帧。 */

const SELF = { instanceId: 'inst-self', identityName: '本机', port: 7329 };
const PEER = 'inst-peer';

function testConfig(overrides = {}) {
  return {
    port: 7329,
    retryIntervalMs: 50,
    retrySlowIntervalMs: 60000,
    retryFastCount: 2,
    queueMaxPerCollab: 100,
    messageTtlMs: 600000,
    dispatchTickMs: 20,
    dialTimeoutMs: 200,
    ...overrides,
  };
}

function quietLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

/* 假连接：open 决定 isOpen；halfOpen 模拟「socket 未销毁但已无对端」——write 看起来成功、帧实际丢失。 */
function createFakeConnection(address) {
  let closeListener = null;
  const connection = {
    remoteAddress: address,
    frames: [],
    closed: false,
    open: true,
    halfOpen: false,
    writeResult: true,
    send(frame) {
      if (!connection.open || connection.writeResult === false) {
        return false;
      }
      connection.frames.push(frame);
      return true;
    },
    onFrame() {},
    onClose(callback) {
      closeListener = callback;
    },
    close() {
      if (connection.closed) {
        return;
      }
      connection.closed = true;
      connection.open = false;
      closeListener?.();
    },
    isOpen() {
      return connection.open && !connection.halfOpen;
    },
  };
  return connection;
}

function createFakeTransport() {
  const state = { failDials: false, failNextWrite: false };
  const dials = [];
  const connections = [];
  return {
    dials,
    connections,
    setDialFails(value) {
      state.failDials = value;
    },
    failNextWrite() {
      state.failNextWrite = true;
    },
    setFrameHandler() {},
    stats: () => ({ fake: true }),
    dial({ address, port }) {
      dials.push({ address, port });
      if (state.failDials) {
        return Promise.reject(Object.assign(new Error('连接被拒'), { code: 'ECONNREFUSED' }));
      }
      const connection = createFakeConnection(address);
      if (state.failNextWrite) {
        state.failNextWrite = false;
        connection.writeResult = false;
      }
      connections.push(connection);
      return Promise.resolve(connection);
    },
  };
}

function makeDispatch(t, { transport = createFakeTransport(), config = testConfig(), direct = {} } = {}) {
  const dispatch = createDispatch({
    dataDir: makeTempDir(t),
    config,
    transport,
    self: SELF,
    log: quietLog(),
    ...direct,
  });
  t.after(() => dispatch.stop());
  return { dispatch, transport };
}

function target(overrides = {}) {
  return {
    collabId: 'collab-r',
    to: { instanceId: PEER, address: '127.0.0.2', port: 7321 },
    type: 'reply',
    payload: { text: '你好' },
    fromSessionId: 'sess-self',
    ...overrides,
  };
}

function tierOf(dispatch, msgId) {
  return dispatch.deliveryStatus({ msgId })[0]?.tier ?? null;
}

test('对端静默失效：池内半开连接不复用，下一次投递重新拨号并送达', { timeout: 15000 }, async (t) => {
  const transport = createFakeTransport();
  const { dispatch } = makeDispatch(t, { transport });
  const first = dispatch.send(target({ payload: { text: '一' } }));
  dispatch.start();
  await waitFor(() => transport.connections.length === 1 && transport.connections[0].frames.length === 1);

  /* 对端已死但 'close' 事件尚未落地：连接还在池里、write 看起来成功——只能靠池内连接自证失效。 */
  transport.connections[0].halfOpen = true;
  const second = dispatch.send(target({ payload: { text: '二' } }));
  await waitFor(() => transport.dials.length === 2, { timeoutMs: 1000 });
  assert.equal(transport.connections[1].frames[0].msgId, first.msgId, '队头在新连接上重发');
  assert.equal(dispatch.stats().staleConnections >= 1, true, '失效连接被丢弃并计数');

  dispatch.onAck(first.msgId);
  await waitFor(() => transport.connections[1].frames.length === 2, { timeoutMs: 1000 });
  assert.equal(transport.connections[1].frames[1].msgId, second.msgId);
  dispatch.onAck(second.msgId);
  assert.equal(tierOf(dispatch, second.msgId), 'at-peer');
});

test('写入失败：连接立即移出池并计数，下一次尝试重拨', { timeout: 15000 }, async (t) => {
  const transport = createFakeTransport();
  transport.failNextWrite();
  const { dispatch } = makeDispatch(t, { transport });
  const sent = dispatch.send(target());
  dispatch.start();
  await waitFor(() => dispatch.stats().deliveryFailures >= 1, { timeoutMs: 1000 });
  assert.equal(transport.connections[0].closed, true, '写失败的连接必须关闭（移出池）');
  assert.equal(transport.connections[0].frames.length, 0, '写失败的帧没有写出');
  await waitFor(() => transport.connections.length === 2, { timeoutMs: 2000 });
  assert.equal(transport.connections[1].frames[0].msgId, sent.msgId, '重拨后在同一连接上重发');
  dispatch.onAck(sent.msgId);
  assert.equal(tierOf(dispatch, sent.msgId), 'at-peer');
});

test('唤醒限频：高频入队不把慢退避退化成每 tick 一拨（唤醒配额按 retryIntervalMs 计）', { timeout: 15000 }, async (t) => {
  const transport = createFakeTransport();
  transport.setDialFails(true);
  const { dispatch } = makeDispatch(t, {
    transport,
    config: testConfig({ retryIntervalMs: 50, retrySlowIntervalMs: 60000, retryFastCount: 1, dispatchTickMs: 10 }),
  });
  dispatch.send(target({ payload: { text: '队头' } }));
  dispatch.start();
  await waitFor(() => transport.dials.length === 2, { timeoutMs: 2000 });   // 首投＋一次快退避
  const baseline = transport.dials.length;

  /* 300ms 内每 10ms 入队一次（30 次）：无限频时每次入队都把队头拨回当下，tick=10ms 最多约 30 拨；
   * 限频后每 retryIntervalMs（50ms）至多一次，期望约 6 次。 */
  for (let index = 0; index < 30; index++) {
    dispatch.send(target({ payload: { text: `连发${index}` } }));
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const during = transport.dials.length - baseline;
  assert.ok(during <= 8, `唤醒限频：300ms 内拨号约 6 次，实际 ${during}`);
  assert.ok(during >= 1, '间隔外的新入队仍能唤醒队头');

  /* 配额在间隔后刷新：再等过一个 retryIntervalMs 的单次入队应能触发一次新拨号。 */
  await new Promise((resolve) => setTimeout(resolve, 60));
  const beforeRefresh = transport.dials.length;
  dispatch.send(target({ payload: { text: '刷新' } }));
  await waitFor(() => transport.dials.length > beforeRefresh, { timeoutMs: 1000 });
  assert.equal(transport.dials.length, beforeRefresh + 1);
});

test('长退避期间新入队：唤醒单元立即重拨，重发不被队头退避挡在后面', { timeout: 15000 }, async (t) => {
  const transport = createFakeTransport();
  transport.setDialFails(true);
  const { dispatch } = makeDispatch(t, { transport });
  const first = dispatch.send(target({ payload: { text: '一' } }));
  dispatch.start();
  await waitFor(() => transport.dials.length === 3, { timeoutMs: 2000 });   // 2 次快退避后转慢退避
  const row = dispatch.deliveryStatus({ msgId: first.msgId })[0];
  assert.equal(row.attempts >= 3, true);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(transport.dials.length, 3, '慢退避期内不得每 tick 重拨');

  /* 对端重启：业务层照常重发（D15 节律）。新入队＝「现在再试一次」，队头退避必须被拨回当下。 */
  transport.setDialFails(false);
  const second = dispatch.send(target({ payload: { text: '二' } }));
  await waitFor(() => transport.dials.length === 4, { timeoutMs: 1000 });
  assert.equal(transport.connections[0].frames[0].msgId, first.msgId);
  dispatch.onAck(first.msgId);
  await waitFor(() => transport.connections[0].frames.length === 2, { timeoutMs: 1000 });
  assert.equal(transport.connections[0].frames[1].msgId, second.msgId);
});

test('端点漂移：改投新端点后不复用旧端点的池内连接', { timeout: 15000 }, async (t) => {
  const transport = createFakeTransport();
  /* 长重传间隔：把「端点漂移触发的重拨」与「未 ack 的按节律重拨」区分开。 */
  const { dispatch } = makeDispatch(t, { transport, config: testConfig({ retryIntervalMs: 5000, retrySlowIntervalMs: 6000 }), direct: { directRetryIntervalMs: 5000 } });
  const direct = dispatch.sendDirect(target({ type: 'reply', payload: { text: '在场' } }));
  assert.equal(direct.ok, true, String(direct.reason));
  await waitFor(() => transport.dials.length === 1 && transport.connections[0].frames.length === 1);

  /* 直投占着旧端点连接（等 ack），队列条目随即被改投到新端点：旧连接不得再被写。 */
  const queued = dispatch.send(target({ payload: { text: '改投' } }));
  const moved = dispatch.reassignPeer({ collabId: 'collab-r', fromInstanceId: PEER, to: { instanceId: PEER, address: '127.0.0.3', port: 7322 } });
  assert.equal(moved.moved, 1);
  dispatch.start();
  await waitFor(() => transport.dials.length === 2, { timeoutMs: 1000 });
  assert.deepEqual(transport.dials[1], { address: '127.0.0.3', port: 7322 });
  assert.equal(transport.connections[1].frames[0].msgId, queued.msgId);
  dispatch.onAck(queued.msgId);
  assert.equal(tierOf(dispatch, queued.msgId), 'at-peer');
});

test('对端进程重启：同端口重新监听后重拨并送达', { timeout: 20000 }, async (t) => {
  const port = await pickFreePort();
  const a1 = createTransport({ port, bindAddress: '127.0.0.1', log: quietLog() });
  t.after(() => a1.close());
  const received = { a1: [], a2: [] };
  const ackAll = (sink) => (connection, frame) => {
    if (frame.type === 'ack') {
      return;
    }
    sink.push(frame.msgId);
    connection.send({ v: 1, type: 'ack', msgId: newMsgId(), ackFor: frame.msgId, from: { instanceId: PEER, identityName: '对端', port }, ts: new Date().toISOString() });
  };
  a1.setFrameHandler(ackAll(received.a1));
  await a1.listen();

  const transport = createTransport({ port: 7329, bindAddress: '127.0.0.1', log: quietLog() });
  t.after(() => transport.close());
  const { dispatch } = makeDispatch(t, { transport });
  dispatch.setClientFrameRouter((connection, frame) => {
    if (frame.type === 'ack') {
      dispatch.onAck(frame.ackFor);
    }
  });
  dispatch.start();

  const first = dispatch.send(target({ to: { instanceId: PEER, address: '127.0.0.1', port } }));
  await waitFor(() => tierOf(dispatch, first.msgId) === 'at-peer');

  /* 原端整机退出：监听与连接一起消失（等同核心被强杀后的端口释放）。 */
  await a1.close();
  await waitFor(() => dispatch.stats().connections === 0, { timeoutMs: 2000 });

  /* 离线期间继续投递：拨号失败按退避计数，队头转入慢退避。 */
  const second = dispatch.send(target({ to: { instanceId: PEER, address: '127.0.0.1', port }, payload: { text: '二' } }));
  await waitFor(() => dispatch.stats().deliveryFailures >= 3, { timeoutMs: 3000 });

  /* 重启端在同一端口重新监听；业务层下一次重发必须把它叫醒并重拨到同一端点。 */
  const a2 = createTransport({ port, bindAddress: '127.0.0.1', log: quietLog() });
  t.after(() => a2.close());
  a2.setFrameHandler(ackAll(received.a2));
  await a2.listen();
  const third = dispatch.send(target({ to: { instanceId: PEER, address: '127.0.0.1', port }, payload: { text: '三' } }));

  await waitFor(() => received.a2.includes(second.msgId) && received.a2.includes(third.msgId), { timeoutMs: 5000 });
  assert.equal(tierOf(dispatch, second.msgId), 'at-peer');
  assert.equal(tierOf(dispatch, third.msgId), 'at-peer');
});
