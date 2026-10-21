import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDispatch } from '../src/net/dispatch.js';
import { COLLAB_CAPABILITY, newMsgId } from '../src/net/protocol.js';
import { makeTempDir, waitFor } from './helpers.js';

const SELF = { instanceId: 'inst-self', identityName: '本机', port: 7321 };

function testConfig(overrides = {}) {
  return {
    port: 7321,
    retryIntervalMs: 60,
    retrySlowIntervalMs: 120,
    retryFastCount: 2,
    queueMaxPerCollab: 100,
    messageTtlMs: 600000,
    dispatchTickMs: 20,
    dialTimeoutMs: 150,
    ...overrides,
  };
}

function createFakeConnection(address) {
  const frames = [];
  let frameListener = null;
  let closeListener = null;
  return {
    remoteAddress: address,
    frames,
    send(frame) {
      frames.push(frame);
    },
    onFrame(callback) {
      frameListener = callback;
    },
    onClose(callback) {
      closeListener = callback;
    },
    close() {
      if (closeListener !== null) {
        closeListener();
      }
    },
    receive(frame) {
      return frameListener === null ? undefined : frameListener(frame);
    },
  };
}

function createFakeTransport() {
  const dials = [];
  const connections = [];
  return {
    dials,
    connections,
    setFrameHandler() {},
    stats: () => ({ fake: true }),
    dial({ address, port }) {
      dials.push({ address, port });
      const connection = createFakeConnection(address);
      connections.push(connection);
      return Promise.resolve(connection);
    },
  };
}

function makeDispatch(t, overrides = {}) {
  const dataDir = makeTempDir(t);
  const transport = overrides.transport ?? createFakeTransport();
  const dispatch = createDispatch({
    dataDir,
    config: testConfig(overrides.config),
    transport,
    self: SELF,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  return { dispatch, dataDir, transport };
}

function target(overrides = {}) {
  return {
    collabId: 'collab-1',
    to: { instanceId: 'inst-b', address: '127.0.0.2', port: 7321 },
    type: 'reply',
    payload: { text: '你好' },
    fromSessionId: 'sess-self',
    toSessions: ['sess-b1', 'sess-b2'],
    ...overrides,
  };
}

test('send：协作域帧盖章 cap=2 与 from.sessionId，toSessions 随帧上线', { timeout: 15000 }, async (t) => {
  const { dispatch, transport } = makeDispatch(t);
  const sent = dispatch.send(target());
  assert.equal(sent.ok, true);
  dispatch.start();
  t.after(() => dispatch.stop());
  await waitFor(() => transport.connections[0]?.frames.length === 1);
  const frame = transport.connections[0].frames[0];
  assert.equal(frame.cap, COLLAB_CAPABILITY);
  assert.equal(frame.from.sessionId, 'sess-self');
  assert.deepEqual(frame.toSessions, ['sess-b1', 'sess-b2']);
  assert.equal(frame.msgId, sent.msgId);
});

test('send：协作域帧缺少 from.sessionId 受理面拒绝（不建队头）', { timeout: 15000 }, async (t) => {
  const { dispatch } = makeDispatch(t);
  const rejected = dispatch.send(target({ fromSessionId: undefined }));
  assert.equal(rejected.ok, false);
  assert.ok(rejected.reason.includes('sessionId'), rejected.reason);
  assert.equal(dispatch.deliveryStatus({ msgId: 'anything' }).length, 0);
});

test('send：一机两席仍是一条机器级 outbox 条目、一个 msgId', { timeout: 15000 }, async (t) => {
  const { dispatch } = makeDispatch(t);
  const sent = dispatch.send(target());
  assert.equal(sent.ok, true);
  const rows = dispatch.deliveryStatus({ msgId: sent.msgId });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].toInstanceId, 'inst-b');
  assert.deepEqual(rows[0].toSessions, ['sess-b1', 'sess-b2']);
  assert.equal(rows[0].fromSessionId, 'sess-self');
  assert.equal(dispatch.deliveryStatusOf(sent.msgId).msgId, sent.msgId);
});

test('outbox 终态：ack 只到 at-peer，收到机器级回报才到 session', { timeout: 15000 }, async (t) => {
  const { dispatch, transport } = makeDispatch(t);
  const sent = dispatch.send(target());
  dispatch.start();
  t.after(() => dispatch.stop());
  await waitFor(() => transport.connections[0]?.frames.length === 1);

  dispatch.onAck(sent.msgId);
  assert.equal(dispatch.deliveryStatusOf(sent.msgId).tier, 'at-peer');
  assert.equal(dispatch.deliveryStatusOf(sent.msgId).expired, false);

  dispatch.onDeliveryReport({ refMsgId: sent.msgId, tier: 'session' });
  assert.equal(dispatch.deliveryStatusOf(sent.msgId).tier, 'session');
  assert.ok(dispatch.deliveryStatusOf(sent.msgId).deliveredAt !== null);
});

test('重复回报幂等：同一 refMsgId 再次回报不改变终态、不重复计数', { timeout: 15000 }, async (t) => {
  const { dispatch } = makeDispatch(t);
  const sent = dispatch.send(target());
  dispatch.onDeliveryReport({ refMsgId: sent.msgId, tier: 'session' });
  const before = dispatch.deliveryStatusOf(sent.msgId);
  const result = dispatch.onDeliveryReport({ refMsgId: sent.msgId, tier: 'session' });
  const after = dispatch.deliveryStatusOf(sent.msgId);
  assert.deepEqual(after, before);
  assert.equal(result, undefined, 'onDeliveryReport 无返回值；重复回报不重复推进');
  assert.equal(dispatch.stats().deliveredTotal, 1);
});

test('send：toSessions 非法直接拒绝（不入队、不建队头）', { timeout: 15000 }, async (t) => {
  const { dispatch } = makeDispatch(t);
  for (const toSessions of [[], ['bad id!'], 'sess-a', [1]]) {
    const rejected = dispatch.send(target({ toSessions }));
    assert.equal(rejected.ok, false, JSON.stringify(toSessions));
    assert.ok(rejected.reason.includes('toSessions'), rejected.reason);
  }
  assert.equal(dispatch.stats().sendsRejected, 4);
});

test('sendDirect：同样携带 cap=2、from.sessionId 与 toSessions', { timeout: 15000 }, async (t) => {
  const { dispatch, transport } = makeDispatch(t);
  const sent = dispatch.sendDirect(target({ type: 'post', payload: { post: { postId: 'p-1', seq: 1, kind: 'reply', text: '你好' } } }));
  assert.equal(sent.ok, true);
  await waitFor(() => transport.connections[0]?.frames.length === 1);
  const frame = transport.connections[0].frames[0];
  assert.equal(frame.cap, COLLAB_CAPABILITY);
  assert.equal(frame.from.sessionId, 'sess-self');
  assert.deepEqual(frame.toSessions, ['sess-b1', 'sess-b2']);
});

test('deliveryStatusOf：未知 msgId 返回 null，不抛错', { timeout: 15000 }, async (t) => {
  const { dispatch } = makeDispatch(t);
  assert.equal(dispatch.deliveryStatusOf(newMsgId()), null);
});
