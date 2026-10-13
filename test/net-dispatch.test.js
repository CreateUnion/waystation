import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync } from 'node:fs';
import { createDispatch } from '../src/net/dispatch.js';
import { newMsgId } from '../src/net/protocol.js';
import { OUTBOX_FILE_NAME } from '../src/net/outbox.js';
import { collabDir, collabFilePath, ensureDir } from '../src/paths.js';
import { makeTempDir, waitFor } from './helpers.js';

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
    closed: false,
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
      if (!this.closed) {
        this.closed = true;
        if (closeListener !== null) {
          closeListener();
        }
      }
    },
    receive(frame) {
      return frameListener === null ? undefined : frameListener(frame);
    },
  };
}

/* 拨号失败注入（两种口径共用一份计数）：setNextDialFails 常开（用例自行复位）、failDials 按次递减。 */
function createDialFailures() {
  let sticky = false;
  let remaining = 0;
  return {
    stickyOn(value) {
      sticky = value;
    },
    setCount(count) {
      remaining = count;
    },
    due() {
      if (!sticky && remaining === 0) {
        return false;
      }
      if (remaining > 0) {
        remaining--;
      }
      return true;
    },
  };
}

function createFakeTransport() {
  const failures = createDialFailures();
  let deferred = null;   // 挂起拨号：构造「stop / ack / 重入检查与在途拨号并发」的时间窗口
  const dials = [];
  const connections = [];
  return {
    dials,
    connections,
    setNextDialFails(value) {
      failures.stickyOn(value);
    },
    failDials(count) {
      failures.setCount(count);
    },
    deferNextDial() {
      const gate = {};
      gate.completed = new Promise((resolve) => {
        gate.release = resolve;
      });
      deferred = gate;
      return gate;
    },
    setFrameHandler() {},
    stats: () => ({ fake: true }),
    dial({ address, port }) {
      dials.push({ address, port });
      if (failures.due()) {
        return Promise.reject(Object.assign(new Error('连接被拒'), { code: 'ECONNREFUSED' }));
      }
      const connection = createFakeConnection(address);
      connections.push(connection);
      if (deferred !== null) {
        const gate = deferred;
        deferred = null;
        return gate.completed.then(() => connection);
      }
      return Promise.resolve(connection);
    },
  };
}

function makeDispatch(t, { transport, config, self, direct } = {}) {
  const dataDir = makeTempDir(t);
  const logs = [];
  const log = {
    info: () => {},
    warn: (message, fields) => logs.push({ level: 'warn', message, fields }),
    error: (message, fields) => logs.push({ level: 'error', message, fields }),
  };
  const dispatch = createDispatch({
    dataDir,
    config: config ?? testConfig(),
    transport: transport ?? createFakeTransport(),
    self: self ?? { instanceId: 'inst-self', identityName: '本机', port: 7321 },
    log,
    ...(direct ?? {}),
  });
  return { dispatch, dataDir, logs, log };
}

function target(overrides = {}) {
  return { collabId: 'collab-1', to: { instanceId: 'inst-b', address: '127.0.0.2', port: 7321 }, type: 'reply', payload: { text: '你好' }, ...overrides };
}

test('send：当场返回「已排队」，调度 tick 后帧写出（信封字段齐全）', { timeout: 15000 }, async (t) => {
  const transport = createFakeTransport();
  const { dispatch } = makeDispatch(t, { transport });
  t.after(() => dispatch.stop());
  const sent = dispatch.send(target());
  assert.equal(sent.ok, true);
  assert.equal(sent.tier, 'queued');
  dispatch.start();
  await waitFor(() => transport.connections[0]?.frames.length === 1);
  const frame = transport.connections[0].frames[0];
  assert.equal(frame.v, 1);
  assert.equal(frame.msgId, sent.msgId);
  assert.equal(frame.type, 'reply');
  assert.equal(frame.collabId, 'collab-1');
  assert.deepEqual(frame.from, { instanceId: 'inst-self', identityName: '本机', port: 7321 });
  assert.equal(frame.payload.text, '你好');
});

test('单元 FIFO：前一条 ack 前不投下一条', { timeout: 15000 }, async (t) => {
  const transport = createFakeTransport();
  // 长重传间隔：本用例只验证单元 FIFO 的队头阻塞——排除重传（重拨换连接）对断言目标的干扰
  const { dispatch } = makeDispatch(t, { transport, config: testConfig({ retryIntervalMs: 5000, retrySlowIntervalMs: 6000 }) });
  t.after(() => dispatch.stop());
  const first = dispatch.send(target({ payload: { text: '一' } }));
  const second = dispatch.send(target({ payload: { text: '二' } }));
  dispatch.start();
  await waitFor(() => transport.connections[0]?.frames.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(transport.connections[0].frames.length, 1);
  dispatch.onAck(first.msgId);
  await waitFor(() => transport.connections[0].frames.length === 2);
  assert.equal(transport.connections[0].frames[1].msgId, second.msgId);
});

test('三档推进：queued → at-peer（ack）→ session（回报）', { timeout: 15000 }, async (t) => {
  const transport = createFakeTransport();
  const { dispatch } = makeDispatch(t, { transport });
  t.after(() => dispatch.stop());
  const sent = dispatch.send(target());
  dispatch.start();
  await waitFor(() => transport.connections[0]?.frames.length === 1);
  assert.equal(dispatch.deliveryStatus({ msgId: sent.msgId })[0].tier, 'queued');
  dispatch.onAck(sent.msgId);
  const acked = dispatch.deliveryStatus({ msgId: sent.msgId })[0];
  assert.equal(acked.tier, 'at-peer');
  assert.ok(acked.ackedAt !== null);
  dispatch.onDeliveryReport({ refMsgId: sent.msgId, tier: 'session' });
  const delivered = dispatch.deliveryStatus({ msgId: sent.msgId })[0];
  assert.equal(delivered.tier, 'session');
  assert.ok(delivered.deliveredAt !== null);
});

test('重传节律：无 ack 时按 retryIntervalMs 重试，重试必重拨', { timeout: 15000 }, async (t) => {
  const transport = createFakeTransport();
  const { dispatch } = makeDispatch(t, { transport });
  t.after(() => dispatch.stop());
  const sent = dispatch.send(target());
  dispatch.start();
  await waitFor(() => transport.connections.length === 1);
  await waitFor(() => transport.connections.length === 2, { timeoutMs: 1000 });   // 60ms 后重试
  assert.ok(transport.connections[0].closed, '重试必须关闭旧连接（半开连接检测）');
  assert.equal(transport.connections[1].frames.length, 1);
  assert.equal(transport.connections[1].frames[0].msgId, sent.msgId);
  const row = dispatch.deliveryStatus({ msgId: sent.msgId })[0];
  assert.ok(row.attempts >= 2);
});

test('拨号失败：按节律退避重试（不每 tick 重拨），恢复后送达', { timeout: 15000 }, async (t) => {
  const transport = createFakeTransport();
  transport.setNextDialFails(true);
  const { dispatch } = makeDispatch(t, { transport });
  t.after(() => dispatch.stop());
  const sent = dispatch.send(target());
  dispatch.start();
  await waitFor(() => transport.dials.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 50));   // 2–3 个 tick（20ms）内不得再拨（退避 60ms）
  assert.equal(transport.dials.length, 1, '失败尝试必须计入退避，不能每 tick 重拨');
  transport.setNextDialFails(false);
  await waitFor(() => transport.connections.length >= 1, { timeoutMs: 2000 });
  assert.equal(transport.connections[0].frames[0].msgId, sent.msgId);
});

test('连接复用：同单元连续两条复用同一连接；单元清空后回收', { timeout: 15000 }, async (t) => {
  const transport = createFakeTransport();
  // 长重传间隔：验证未 ack 阶段同一连接被复用——排除重传（重拨换连接）的干扰
  const { dispatch } = makeDispatch(t, { transport, config: testConfig({ retryIntervalMs: 5000, retrySlowIntervalMs: 6000 }) });
  t.after(() => dispatch.stop());
  const first = dispatch.send(target({ payload: { text: '一' } }));
  const second = dispatch.send(target({ payload: { text: '二' } }));
  dispatch.start();
  await waitFor(() => transport.connections.length === 1 && transport.connections[0].frames.length === 1);
  dispatch.onAck(first.msgId);
  await waitFor(() => transport.connections[0].frames.length === 2);
  assert.equal(transport.connections.length, 1, '同一单元应复用连接');
  dispatch.onAck(second.msgId);
  await waitFor(() => transport.connections[0].closed);
});

test('不同对端并行：两单元各自独立投递，互不阻塞', { timeout: 15000 }, async (t) => {
  const transport = createFakeTransport();
  const { dispatch } = makeDispatch(t, { transport });
  t.after(() => dispatch.stop());
  dispatch.send(target({ to: { instanceId: 'inst-b', address: '127.0.0.2', port: 7321 } }));
  dispatch.send(target({ to: { instanceId: 'inst-c', address: '127.0.0.3', port: 7321 } }));
  dispatch.start();
  await waitFor(() => transport.connections.length === 2);
  assert.deepEqual(transport.connections.map((connection) => connection.remoteAddress).sort(), ['127.0.0.2', '127.0.0.3']);
});

test('ping：pong 回程测出 RTT；无应答按超时不可达', { timeout: 15000 }, async (t) => {
  const transport = createFakeTransport();
  const { dispatch } = makeDispatch(t, { transport });
  // 拨号连接的回程帧经 clientFrameRouter 转交（生产路径由装配层注入 inbound.onFrame；此处接最小路由）
  dispatch.setClientFrameRouter((_connection, frame) => dispatch.resolvePong(frame));
  const pinging = dispatch.ping({ address: '127.0.0.1', port: 7321 });
  await waitFor(() => transport.connections.length === 1);
  const pingFrame = transport.connections[0].frames[0];
  assert.equal(pingFrame.type, 'ping');
  transport.connections[0].receive({ v: 1, type: 'pong', msgId: newMsgId(), replyTo: pingFrame.msgId, from: { instanceId: 'inst-b', identityName: '主机乙' }, ts: new Date().toISOString() });
  const echoed = await pinging;
  assert.equal(echoed.reachable, true);
  assert.ok(Number.isInteger(echoed.rttMs));
  assert.ok(transport.connections[0].closed, '探测连接用后即关');
  const silent = await dispatch.ping({ address: '127.0.0.9', port: 7321 });
  assert.equal(silent.reachable, false);
  assert.ok(silent.reason.includes('超时'));
});

test('resolvePong：未知 replyTo 返回 false 并计数', { timeout: 15000 }, async (t) => {
  const transport = createFakeTransport();
  const { dispatch } = makeDispatch(t, { transport });
  assert.equal(dispatch.resolvePong({ replyTo: newMsgId() }), false);
  assert.equal(dispatch.stats().pongsUnknown, 1);
});

test('未知 ack / 未知回报：计数并忽略，不抛', { timeout: 15000 }, async (t) => {
  const transport = createFakeTransport();
  const { dispatch } = makeDispatch(t, { transport });
  dispatch.onAck(newMsgId());
  dispatch.onDeliveryReport({ refMsgId: newMsgId(), tier: 'session' });
  assert.equal(dispatch.stats().acksUnknown, 1);
  assert.equal(dispatch.stats().reportsUnknown, 1);
});

test('重启续投：重开调度器后未完成条目继续投递（队列与连接重新建立）', { timeout: 15000 }, async (t) => {
  const transport = createFakeTransport();
  const { dispatch, dataDir } = makeDispatch(t, { transport });
  const sent = dispatch.send(target());
  dispatch.stop();   // 未投递即中止（模拟进程重启）
  assert.equal(transport.connections.length, 0);
  const revived = createDispatch({ dataDir, config: testConfig(), transport, self: { instanceId: 'inst-self', identityName: '本机' }, log: { info: () => {}, warn: () => {}, error: () => {} } });
  t.after(() => revived.stop());
  revived.start();   // 协作目录在 start() 内加载——先启动再查询，才是真实使用序
  assert.equal(revived.deliveryStatus({ msgId: sent.msgId })[0].tier, 'queued');
  await waitFor(() => transport.connections.length >= 1);
  assert.equal(transport.connections[0].frames[0].msgId, sent.msgId);
});

test('deliveryStatus 惰性载入：未 start 也能查到落盘的历史队列（只加载、不调度）', { timeout: 15000 }, async (t) => {
  const dataDir = makeTempDir(t);
  const self = { instanceId: 'inst-self', identityName: '本机', port: 7321 };
  const log = { info: () => {}, warn: () => {}, error: () => {} };
  const writer = createDispatch({ dataDir, config: testConfig(), transport: createFakeTransport(), self, log });
  const sent = writer.send(target());
  assert.equal(sent.ok, true, '未 start 也受理入队（离线排队语义）');
  const transport = createFakeTransport();
  const reader = createDispatch({ dataDir, config: testConfig(), transport, self, log });
  t.after(() => reader.stop());
  const first = reader.deliveryStatus({ msgId: sent.msgId });   // 未 start 直接查询
  assert.equal(first.length, 1, '落盘的历史队列必须在查询时可见（降级态不丢可见性）');
  assert.equal(first[0].tier, 'queued');
  assert.equal(reader.deliveryStatus({ msgId: sent.msgId }).length, 1, '重复查询幂等（不重复载入、不重复计行）');
  await new Promise((resolve) => setTimeout(resolve, 80));   // 数个 tick 的窗口：查询若启动了调度即会在此拨号
  assert.equal(transport.dials.length, 0, '查询不得启动调度（无 tick、无拨号）');
  assert.equal(transport.connections.length, 0);
  reader.start();   // start 后行为不变：未完成条目照常续投
  await waitFor(() => transport.connections.length >= 1 && transport.connections[0].frames.length === 1);
  assert.equal(transport.connections[0].frames[0].msgId, sent.msgId);
});

test('过期：超保留期的未完成条目在调度中被标记 expired 并告警（提示发送方）', { timeout: 15000 }, async (t) => {
  const transport = createFakeTransport();
  transport.setNextDialFails(true);
  const { dispatch, logs } = makeDispatch(t, { transport, config: testConfig({ messageTtlMs: 1500 }) });
  t.after(() => dispatch.stop());
  const sent = dispatch.send(target());
  dispatch.start();
  await waitFor(() => dispatch.deliveryStatus({ msgId: sent.msgId })[0].expired, { timeoutMs: 4000 });
  assert.ok(logs.some((entry) => entry.message.includes('过期')));
});

test('send 参数非法 / 目标为本机：拒绝（不产生队列条目）', { timeout: 15000 }, async (t) => {
  const transport = createFakeTransport();
  const { dispatch } = makeDispatch(t, { transport });
  assert.equal(dispatch.send({ collabId: '../x', to: { instanceId: 'inst-b', address: '127.0.0.2', port: 7321 }, type: 'notice' }).ok, false);
  assert.equal(dispatch.send({ collabId: 'collab-1', to: { instanceId: 'inst-b', address: 'hostname', port: 7321 }, type: 'notice' }).ok, false);
  assert.equal(dispatch.send({ collabId: 'collab-1', to: { instanceId: 'inst-b', address: '127.0.0.2', port: 7321 }, type: '编造类型' }).ok, false);
  assert.equal(dispatch.send({ collabId: 'collab-1', to: { instanceId: 'inst-self', address: '127.0.0.1', port: 7321 }, type: 'notice' }).ok, false);
  assert.equal(dispatch.deliveryStatus({}).length, 0);
});

test('send 拒绝传输类帧（ping/pong/ack）：即时通道不入队（防「永不 ack 的队头」）', { timeout: 15000 }, async (t) => {
  const transport = createFakeTransport();
  const { dispatch } = makeDispatch(t, { transport });
  for (const type of ['ping', 'pong', 'ack']) {
    const rejected = dispatch.send(target({ type }));
    assert.equal(rejected.ok, false, type);
    assert.ok(rejected.reason.includes('传输类'), type);
  }
  assert.equal(dispatch.deliveryStatus({}).length, 0, '拒绝不产生队列条目');
});

test('回报以 ack 收敛：条目推进至 at-peer 且单元队头释放（后续消息不被阻塞）', { timeout: 15000 }, async (t) => {
  const transport = createFakeTransport();
  // 长重传间隔：断言以「同一连接上的后续帧」为准——排除重传（重拨换连接）的干扰
  const { dispatch } = makeDispatch(t, { transport, config: testConfig({ retryIntervalMs: 5000, retrySlowIntervalMs: 6000 }) });
  t.after(() => dispatch.stop());
  const report = dispatch.send(target({ type: 'delivery-status', payload: { refMsgId: newMsgId(), tier: 'session' } }));
  const followUp = dispatch.send(target());
  assert.equal(report.ok, true, '回报走可靠性机制（入队）');
  dispatch.start();
  await waitFor(() => transport.connections[0]?.frames.length === 1);
  assert.equal(transport.connections[0].frames[0].type, 'delivery-status');
  dispatch.onAck(report.msgId);   // 对方驿站对回报帧的链路确认
  assert.equal(dispatch.deliveryStatus({ msgId: report.msgId })[0].tier, 'at-peer', '回报条目离开 queued（不再作为队头重传）');
  await waitFor(() => transport.connections[0].frames.length === 2);
  assert.equal(transport.connections[0].frames[1].msgId, followUp.msgId, '队头释放：该单元后续消息照常投递');
});

test('stats：计数齐备（投递/确认/回报/拒绝）', { timeout: 15000 }, async (t) => {
  const transport = createFakeTransport();
  const { dispatch } = makeDispatch(t, { transport });
  t.after(() => dispatch.stop());
  const sent = dispatch.send(target());
  dispatch.start();
  await waitFor(() => transport.connections[0]?.frames.length === 1);
  dispatch.onAck(sent.msgId);
  dispatch.onDeliveryReport({ refMsgId: sent.msgId, tier: 'session' });
  const counters = dispatch.stats();
  assert.equal(counters.attempts, 1);
  assert.equal(counters.ackedTotal, 1);
  assert.equal(counters.deliveredTotal, 1);
  assert.equal(counters.collabs, 1);
});

test('stop 与在途拨号并发：发送截止（不发帧）、连接收口关闭、stop resolve 后无残留', { timeout: 15000 }, async (t) => {
  const transport = createFakeTransport();
  const { dispatch } = makeDispatch(t, { transport });
  t.after(() => dispatch.stop());
  const sent = dispatch.send(target());
  const gate = transport.deferNextDial();
  dispatch.start();
  await waitFor(() => transport.dials.length === 1);
  const stopping = dispatch.stop();   // 停止时拨号仍在途
  gate.release();                     // 停止之后拨号才完成
  await stopping;                     // stop resolve 即代表收口完成
  assert.equal(transport.connections.length, 1);
  assert.equal(transport.connections[0].frames.length, 0, 'stop 后不得发帧（发送截止点）');
  assert.equal(transport.connections[0].closed, true, '停止后完成的拨号必须被关闭（不留无主 socket）');
  assert.equal(dispatch.deliveryStatus({ msgId: sent.msgId })[0].tier, 'queued', '未发送的条目保持可续投');
  await new Promise((resolve) => setTimeout(resolve, 80));   // 数个 tick 的窗口
  assert.equal(transport.dials.length, 1, '停止后不得再拨号（无残留调度）');
  assert.equal(transport.connections[0].frames.length, 0, '停止后不得再投递');
});

test('stop 与 ping 在途拨号并发：探测中止、不发探测帧、连接关闭', { timeout: 15000 }, async (t) => {
  const transport = createFakeTransport();
  const { dispatch } = makeDispatch(t, { transport });
  t.after(() => dispatch.stop());
  const gate = transport.deferNextDial();
  const pinging = dispatch.ping({ address: '127.0.0.1', port: 7321 });
  await waitFor(() => transport.dials.length === 1);
  const stopping = dispatch.stop();
  gate.release();
  await stopping;
  const outcome = await pinging;
  assert.equal(outcome.reachable, false);
  assert.equal(transport.connections[0].frames.length, 0, '停止后不得发探测帧');
  assert.equal(transport.connections[0].closed, true);
});

test('stop 与拨号失败并发：停止期间的拨号失败不计尝试、不计投递失败（与成功拨号对称）', { timeout: 15000 }, async (t) => {
  const transport = createFakeTransport();
  const { dispatch } = makeDispatch(t, { transport });
  t.after(() => dispatch.stop());
  const sent = dispatch.send(target());
  let failDial = null;
  transport.dial = () => new Promise((resolve, reject) => {
    failDial = () => reject(Object.assign(new Error('连接被拒'), { code: 'ECONNREFUSED' }));
  });
  dispatch.start();
  await waitFor(() => failDial !== null);
  const stopping = dispatch.stop();   // 停止时拨号仍在途
  failDial();                          // 停止之后拨号才失败
  await stopping;
  const row = dispatch.deliveryStatus({ msgId: sent.msgId })[0];
  assert.equal(row.tier, 'queued');
  assert.equal(row.attempts, 0, '停止期间的拨号失败不得计尝试');
  assert.equal(dispatch.stats().deliveryFailures, 0, '停止期间的拨号失败不得计入投递失败');
});

test('send 校验 payload：非对象 / 超体积 / 无法序列化一律拒绝且不入队', { timeout: 15000 }, async (t) => {
  const transport = createFakeTransport();
  const { dispatch } = makeDispatch(t, { transport });
  for (const payload of ['文本', 42, [], null, true]) {
    const rejected = dispatch.send(target({ payload }));
    assert.equal(rejected.ok, false, String(payload));
    assert.ok(rejected.reason.includes('payload'), String(payload));
  }
  const oversize = dispatch.send(target({ payload: { blob: 'x'.repeat(2 * 1024 * 1024) } }));
  assert.equal(oversize.ok, false);
  assert.ok(oversize.reason.includes('上限'));
  const circular = {};
  circular.self = circular;
  const unserializable = dispatch.send(target({ payload: circular }));
  assert.equal(unserializable.ok, false);
  assert.ok(unserializable.reason.includes('序列化'));
  assert.equal(dispatch.deliveryStatus({}).length, 0, '拒绝不产生任何队列条目');
});

test('send 校验 payload：toJSON 序列化后变标量同样拒绝（预检以上线形态为准）', { timeout: 15000 }, async (t) => {
  const transport = createFakeTransport();
  const { dispatch } = makeDispatch(t, { transport });
  const sneaky = { toJSON: () => 'x' };
  const rejected = dispatch.send(target({ payload: sneaky }));
  assert.equal(rejected.ok, false, 'toJSON 会把上线载荷改写成标量：受理即造出必被对端拒收的队头');
  assert.ok(rejected.reason.includes('payload'));
  assert.equal(dispatch.deliveryStatus({}).length, 0, '拒绝不产生队列条目');
  const reshaped = { toJSON: () => ({ text: '重写' }) };
  assert.equal(dispatch.send(target({ payload: reshaped })).ok, true, '序列化后仍是 plain object：上线形态合法，照常受理');
});

test('投递 await 期间条目被 ack：不发帧、不计尝试（复查条目状态）', { timeout: 15000 }, async (t) => {
  const transport = createFakeTransport();
  const { dispatch } = makeDispatch(t, { transport });
  t.after(() => dispatch.stop());
  const sent = dispatch.send(target());
  const gate = transport.deferNextDial();
  dispatch.start();
  await waitFor(() => transport.dials.length === 1);
  dispatch.onAck(sent.msgId);   // 拨号在途时对端确认到达
  assert.equal(dispatch.deliveryStatus({ msgId: sent.msgId })[0].tier, 'at-peer');
  gate.release();
  await waitFor(() => transport.connections[0].closed === true);
  assert.equal(transport.connections[0].frames.length, 0, '已 ack 的条目不得再发一帧');
  assert.equal(dispatch.deliveryStatus({ msgId: sent.msgId })[0].attempts, 0, '未发送的投递不计尝试');
  assert.equal(dispatch.stats().attempts, 0);
});

test('start 幂等：重复 start 不叠挂 interval，stop 后无残留投递', { timeout: 15000 }, async (t) => {
  const transport = createFakeTransport();
  const { dispatch } = makeDispatch(t, { transport });
  t.after(() => dispatch.stop());
  dispatch.send(target());
  dispatch.start();
  await waitFor(() => transport.connections.length === 1 && transport.connections[0].frames.length === 1);
  dispatch.start();   // 重复 start：不得再叠挂一个 interval
  dispatch.stop();
  const dialsAtStop = transport.dials.length;
  const framesAtStop = transport.connections[0].frames.length;
  await new Promise((resolve) => setTimeout(resolve, 200));   // 重传节律（60ms）的数倍窗口：叠挂的 interval 会在此投递
  assert.equal(transport.dials.length, dialsAtStop, 'stop 后不得再拨号（无残留调度）');
  assert.equal(transport.connections.length, 1, 'stop 后不得再建连接');
  assert.equal(transport.connections[0].frames.length, framesAtStop, 'stop 后不得再发帧');
});

test('tick 异常隔离：调度循环内异常被捕获记录，调度继续运行（不退出进程）', { timeout: 15000 }, async (t) => {
  const transport = createFakeTransport();
  // 长重传间隔 + 短保留期：让「过期后回收连接」成为首投之后的第一次关连接，注入的异常正落在这个 tick 上
  const { dispatch, logs } = makeDispatch(t, { transport, config: testConfig({ messageTtlMs: 300, retryIntervalMs: 5000, retrySlowIntervalMs: 6000 }) });
  t.after(() => dispatch.stop());
  dispatch.send(target());
  dispatch.start();
  await waitFor(() => transport.connections.length === 1 && transport.connections[0].frames.length === 1);
  const originalClose = transport.connections[0].close;
  let throwPending = true;
  transport.connections[0].close = function () {
    if (throwPending) {
      throwPending = false;
      throw new Error('注入：连接关闭异常');
    }
    originalClose.call(this);
  };
  await waitFor(() => logs.some((entry) => entry.level === 'error' && entry.message.includes('调度循环异常')), { timeoutMs: 4000 });
  const followUp = dispatch.send(target({ to: { instanceId: 'inst-c', address: '127.0.0.3', port: 7321 }, payload: { text: '丙' } }));
  await waitFor(() => transport.connections.length === 2 && transport.connections[1].frames.length === 1, { timeoutMs: 2000 });
  assert.equal(transport.connections[1].frames[0].msgId, followUp.msgId, '异常被隔离：后续 tick 照常投递');
});

test('inFlight 重入守卫：单元投递在途时 tick 不重复拨号（一次只投一条）', { timeout: 15000 }, async (t) => {
  const transport = createFakeTransport();
  // 长重传间隔：把「在途窗口内的重复调度」与「按节律的重传」区分开
  const { dispatch } = makeDispatch(t, { transport, config: testConfig({ retryIntervalMs: 5000, retrySlowIntervalMs: 6000 }) });
  t.after(() => dispatch.stop());
  const sent = dispatch.send(target());
  const gate = transport.deferNextDial();
  dispatch.start();
  await waitFor(() => transport.dials.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 80));   // 数个 tick（20ms）：在途单元必须被跳过
  assert.equal(transport.dials.length, 1, '投递在途时不得重复拨号');
  gate.release();
  await waitFor(() => transport.connections[0]?.frames.length === 1);
  assert.equal(transport.connections.length, 1);
  assert.equal(transport.connections[0].frames[0].msgId, sent.msgId);
});

test('索引回收：条目被队列回收后不再出现在状态查询，重建后的索引照常归属', { timeout: 15000 }, async (t) => {
  const transport = createFakeTransport();
  transport.setNextDialFails(true);   // 不投递：只观察队列的过期与回收
  const { dispatch } = makeDispatch(t, { transport, config: testConfig({ messageTtlMs: 200 }) });
  t.after(() => dispatch.stop());
  const first = dispatch.send(target({ payload: { text: '一' } }));
  dispatch.start();
  await waitFor(() => dispatch.deliveryStatus({ msgId: first.msgId })[0]?.expired, { timeoutMs: 4000 });
  // 治理类条目豁免过期：回收事件发生时它仍存活，用于验证重建后的归属查找
  const second = dispatch.send(target({ type: 'freeze', payload: { name: '项目', members: [{ instanceId: 'inst-a', identityName: '主机甲' }, { instanceId: 'inst-b', identityName: '主机乙' }] } }));
  assert.equal(second.ok, true);
  await waitFor(() => dispatch.deliveryStatus({ msgId: first.msgId }).length === 0, { timeoutMs: 5000 });
  dispatch.onAck(second.msgId);
  assert.equal(dispatch.deliveryStatus({ msgId: second.msgId })[0].tier, 'at-peer');
});

test('send：to.port 缺失 / 非法 → 统一参数拒绝、不入队', { timeout: 15000 }, async (t) => {
  const { dispatch } = makeDispatch(t);
  t.after(() => dispatch.stop());
  const variants = [undefined, 0, 65536, '7321', 1.5];
  for (const port of variants) {
    const sent = dispatch.send({ collabId: 'collab-1', to: { instanceId: 'inst-b', address: '127.0.0.2', port }, type: 'reply', payload: { text: 'x' } });
    assert.equal(sent.ok, false, String(port));
    assert.ok(sent.reason.includes('to.port'), sent.reason);
  }
  assert.equal(dispatch.stats().sendsRejected, variants.length);
  assert.equal(dispatch.stats().collabs, 0, '未受理不得创建协作队列');
});

test('终帧预检：类型专属字段不符（delivery-status 的 refMsgId 形态）→ 受理面拒绝', { timeout: 15000 }, async (t) => {
  const { dispatch } = makeDispatch(t);
  t.after(() => dispatch.stop());
  const bad = dispatch.send({
    collabId: 'collab-1',
    to: { instanceId: 'inst-b', address: '127.0.0.2', port: 7321 },
    type: 'delivery-status',
    payload: { refMsgId: 'not a valid id!', tier: 'session' },
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.reason.includes('对端必拒收'), bad.reason);
  const good = dispatch.send({
    collabId: 'collab-1',
    to: { instanceId: 'inst-b', address: '127.0.0.2', port: 7321 },
    type: 'delivery-status',
    payload: { refMsgId: 'msg-1', tier: 'session' },
  });
  assert.equal(good.ok, true, '合法形态不被误杀');
});

test('拨号端口 = 条目 to.port（多站点下拨错端口即投递失败）', { timeout: 15000 }, async (t) => {
  const transport = createFakeTransport();
  const { dispatch } = makeDispatch(t, { transport });
  t.after(() => dispatch.stop());
  dispatch.send({ collabId: 'collab-1', to: { instanceId: 'inst-b', address: '127.0.0.2', port: 17321 }, type: 'reply', payload: { text: 'x' } });
  dispatch.start();
  await waitFor(() => transport.dials.length >= 1);
  assert.deepEqual(transport.dials[0], { address: '127.0.0.2', port: 17321 });
});

test('帧 from 携带端口（构造侧必填）', { timeout: 15000 }, async (t) => {
  const transport = createFakeTransport();
  const { dispatch } = makeDispatch(t, { transport, self: { instanceId: 'inst-self', identityName: '本机', port: 17322 } });
  t.after(() => dispatch.stop());
  dispatch.send(target());
  dispatch.start();
  await waitFor(() => transport.connections[0]?.frames.length === 1);
  assert.equal(transport.connections[0].frames[0].from.port, 17322);
});

test('旧队列记录续投：拨号回退锚点端口（缺 port 记录按默认端口解释）', { timeout: 15000 }, async (t) => {
  const transport = createFakeTransport();
  const dataDir = makeTempDir(t);
  const collabId = 'collab-1';
  ensureDir(collabDir(dataDir, collabId));
  const legacy = {
    msgId: 'msg-legacy', collabId, to: { instanceId: 'inst-b', address: '127.0.0.2' }, type: 'reply', payload: { text: '旧' },
    governance: false, state: 'queued', attempts: 0, createdAt: new Date().toISOString(), nextAttemptAt: 0,   // 时间戳取当下：硬编码旧日期会被保留期在首个 tick 即判过期，拨号永不发生
  };
  appendFileSync(collabFilePath(dataDir, collabId, OUTBOX_FILE_NAME), JSON.stringify(legacy) + '\n');
  const logs = [];
  const log = { info: () => {}, warn: (m, f) => logs.push({ m, f }), error: (m, f) => logs.push({ m, f }) };
  const dispatch = createDispatch({ dataDir, config: testConfig(), transport, self: { instanceId: 'inst-self', identityName: '本机', port: 7321 }, log });
  t.after(() => dispatch.stop());
  dispatch.start();
  await waitFor(() => transport.dials.length >= 1, { timeoutMs: 5000 });
  assert.equal(transport.dials[0].port, 7321, '旧记录无 port：按锚点端口续投');
});

test('send：自身 from.port 非法 → 受理面拒绝（构造侧必填的守卫）', { timeout: 15000 }, async (t) => {
  const { dispatch } = makeDispatch(t, { self: { instanceId: 'inst-self', identityName: '本机', port: 0 } });
  t.after(() => dispatch.stop());
  const sent = dispatch.send(target());
  assert.equal(sent.ok, false);
  assert.ok(sent.reason.includes('from.port'), sent.reason);
  assert.equal(dispatch.stats().sendsRejected, 1);
  assert.equal(dispatch.stats().collabs, 0, '未受理不得创建协作队列');
});

test('reassignPeer：把发往旧对端的未确认条目改投新对端（查询面可见、其余单元不动）', { timeout: 15000 }, async (t) => {
  const { dispatch } = makeDispatch(t);
  t.after(() => dispatch.stop());
  const first = dispatch.send(target());
  const second = dispatch.send(target({ collabId: 'collab-2', to: { instanceId: 'inst-x', address: '127.0.0.9', port: 7330 } }));
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  const moved = dispatch.reassignPeer({ collabId: 'collab-1', fromInstanceId: 'inst-b', to: { instanceId: 'inst-c', address: '127.0.0.3', port: 7322 } });
  assert.deepEqual(moved, { ok: true, moved: 1 });
  const rows = dispatch.deliveryStatus({ collabId: 'collab-1' });
  assert.equal(rows[0].toInstanceId, 'inst-c');
  assert.equal(dispatch.deliveryStatus({ collabId: 'collab-2' })[0].toInstanceId, 'inst-x', '其他单元不动');
});

test('reassignPeer：参数形态逐拒；无该协作队列按零条成功', { timeout: 15000 }, async (t) => {
  const { dispatch } = makeDispatch(t);
  t.after(() => dispatch.stop());
  const cases = [
    { collabId: '../x', fromInstanceId: 'inst-b', to: { instanceId: 'inst-c', address: '127.0.0.3', port: 7322 } },
    { collabId: 'collab-1', fromInstanceId: 'bad id!', to: { instanceId: 'inst-c', address: '127.0.0.3', port: 7322 } },
    { collabId: 'collab-1', fromInstanceId: 'inst-b', to: { instanceId: 'inst-c', address: 'not-an-ip', port: 7322 } },
    { collabId: 'collab-1', fromInstanceId: 'inst-b', to: { instanceId: 'inst-c', address: '127.0.0.3', port: 70000 } },
  ];
  for (const payload of cases) {
    assert.equal(dispatch.reassignPeer(payload).ok, false, JSON.stringify(payload).slice(0, 60));
  }
  assert.deepEqual(dispatch.reassignPeer({ collabId: 'collab-none', fromInstanceId: 'inst-b', to: { instanceId: 'inst-c', address: '127.0.0.3', port: 7322 } }), { ok: true, moved: 0 });
});

test('send：携带原发身份（治理转达）时投递帧 from 为原发者，且原发身份随队列重启续投保留', { timeout: 15000 }, async (t) => {
  const transport = createFakeTransport();
  const { dispatch, dataDir } = makeDispatch(t, { transport });
  const originFrom = { instanceId: 'inst-c', identityName: '主机丙', port: 7321 };
  const sent = dispatch.send(target({ type: 'takeover-init', payload: { kind: 'cancel', reason: '让位' }, from: originFrom }));
  assert.equal(sent.ok, true, sent.reason);
  dispatch.stop();   // 未投递即中止：原发身份须随队列条目持久化，重启续投不改写
  const revived = createDispatch({ dataDir, config: testConfig(), transport, self: { instanceId: 'inst-self', identityName: '本机', port: 7321 }, log: { info: () => {}, warn: () => {}, error: () => {} } });
  t.after(() => revived.stop());
  revived.start();
  await waitFor(() => transport.connections.length >= 1 && transport.connections[0].frames.length === 1);
  const frame = transport.connections[0].frames[0];
  assert.equal(frame.msgId, sent.msgId);
  assert.deepEqual(frame.from, originFrom, '转达帧的原发身份在重启续投后仍保留');
});

/* —— 直投（讨论模式帖通道）：不落队列、短重试、短时投递记录 —— */

function directTarget(overrides = {}) {
  return {
    collabId: 'collab-f',
    to: { instanceId: 'inst-b', address: '127.0.0.2', port: 7321 },
    type: 'post',
    payload: { post: { postId: 'post-1', seq: 1, kind: 'reply', text: '你好' } },
    ...overrides,
  };
}

/* 直投参数快节律（测试收敛）：60ms 等待窗 / 间隔。 */
function directOptions(overrides = {}) {
  return { directRetryIntervalMs: 60, directMaxAttempts: 3, ...overrides };
}

test('sendDirect：即时投出（不落队列）、帧 ts 随帖携带、ack 推进 at-peer、回报推进 session', { timeout: 15000 }, async (t) => {
  const transport = createFakeTransport();
  const { dispatch, dataDir } = makeDispatch(t, { transport, direct: directOptions() });
  t.after(() => dispatch.stop());
  const ts = new Date(Date.now() - 1000).toISOString();   // 帖的落盘 ts（帧 ts 随帖携带；落在保留窗内）
  const sent = dispatch.sendDirect(directTarget({ createdAt: ts }));
  assert.equal(sent.ok, true);
  assert.equal(typeof sent.msgId, 'string');
  const early = dispatch.deliveryStatus({ msgId: sent.msgId })[0];
  assert.equal(early.tier, 'inflight', '受理即登记短时记录（直投中）');
  await waitFor(() => transport.connections[0]?.frames.length === 1);
  const frame = transport.connections[0].frames[0];
  assert.equal(frame.msgId, sent.msgId);
  assert.equal(frame.type, 'post');
  assert.equal(frame.collabId, 'collab-f');
  assert.equal(frame.ts, ts, '帧 ts 随帖携带（作者侧强制单调的落盘 ts）');
  assert.equal(frame.payload.post.text, '你好');
  assert.deepEqual(frame.from, { instanceId: 'inst-self', identityName: '本机', port: 7321 });
  assert.equal(existsSync(collabFilePath(dataDir, 'collab-f', OUTBOX_FILE_NAME)), false, '直投不落持久队列');
  dispatch.onAck(sent.msgId);
  const acked = dispatch.deliveryStatus({ msgId: sent.msgId })[0];
  assert.equal(acked.tier, 'at-peer');
  assert.equal(acked.toInstanceId, 'inst-b');
  assert.ok(acked.ackedAt !== null);
  assert.equal(acked.note, null);
  dispatch.onAck(sent.msgId);
  assert.equal(dispatch.deliveryStatus({ msgId: sent.msgId })[0].tier, 'at-peer', '重复确认幂等');
  dispatch.onDeliveryReport({ refMsgId: sent.msgId, tier: 'session' });
  const delivered = dispatch.deliveryStatus({ msgId: sent.msgId })[0];
  assert.equal(delivered.tier, 'session');
  assert.ok(delivered.deliveredAt !== null);
  dispatch.onDeliveryReport({ refMsgId: sent.msgId, tier: 'session' });
  assert.equal(dispatch.deliveryStatus({ msgId: sent.msgId })[0].tier, 'session', '重复回报幂等');
  assert.equal(dispatch.stats().directAcked >= 1, true);
  assert.equal(dispatch.stats().directSession >= 1, true);
});

test('sendDirect：会话回报先于 ack 观测到达——直接进第三档（ackedAt 按同一时刻记）', { timeout: 15000 }, async (t) => {
  const transport = createFakeTransport();
  const { dispatch } = makeDispatch(t, { transport, direct: directOptions() });
  t.after(() => dispatch.stop());
  const sent = dispatch.sendDirect(directTarget({ to: { instanceId: 'inst-e', address: '127.0.0.5', port: 7321 } }));
  dispatch.onDeliveryReport({ refMsgId: sent.msgId, tier: 'session' });
  const upgraded = dispatch.deliveryStatus({ msgId: sent.msgId })[0];
  assert.equal(upgraded.tier, 'session', '会话回报蕴含驿站已确认（先 ack 后回报）');
  assert.ok(upgraded.ackedAt !== null, 'ack 未被本机观测到时按同一时刻记');
  dispatch.onDeliveryReport({ refMsgId: sent.msgId, tier: 'session' });
  assert.equal(dispatch.deliveryStatus({ msgId: sent.msgId })[0].tier, 'session', '重复回报幂等');
});

test('sendDirect：拨号失败按短节律重试并重拨、恢复后送达；尝试计数含失败', { timeout: 15000 }, async (t) => {
  const transport = createFakeTransport();
  transport.failDials(2);
  const { dispatch } = makeDispatch(t, { transport, direct: directOptions() });
  t.after(() => dispatch.stop());
  const sent = dispatch.sendDirect(directTarget());
  await waitFor(() => transport.connections.length === 1, { timeoutMs: 3000 });
  assert.equal(transport.dials.length, 3, '两次失败 + 一次成功');
  const row = dispatch.deliveryStatus({ msgId: sent.msgId })[0];
  assert.equal(row.attempts, 3, '拨号失败也计一次尝试');
  assert.ok(row.reason.includes('拨号失败'), '失败原因如实登记');
  dispatch.onAck(sent.msgId);
  const settled = dispatch.deliveryStatus({ msgId: sent.msgId })[0];
  assert.equal(settled.tier, 'at-peer');
  assert.equal(settled.reason, null, '投达后清掉历史失败原因');
});

test('sendDirect：无 ack 即重试（重拨）；尝试耗尽收尾为未达（待对表）且不再重试', { timeout: 15000 }, async (t) => {
  const transport = createFakeTransport();
  const { dispatch } = makeDispatch(t, { transport, direct: directOptions({ directMaxAttempts: 2 }) });
  t.after(() => dispatch.stop());
  const sent = dispatch.sendDirect(directTarget());
  await waitFor(() => transport.connections.length === 2, { timeoutMs: 3000 });
  assert.ok(transport.connections[0].closed, '重试必重拨（半开连接检测口径）');
  assert.equal(transport.connections[0].frames[0].msgId, sent.msgId);
  assert.equal(transport.connections[1].frames[0].msgId, sent.msgId);
  await waitFor(() => dispatch.deliveryStatus({ msgId: sent.msgId })[0].tier === 'undelivered', { timeoutMs: 3000 });
  const row = dispatch.deliveryStatus({ msgId: sent.msgId })[0];
  assert.equal(row.attempts, 2);
  assert.equal(row.expired, false);
  assert.ok(row.note.includes('待对表'));
  assert.ok(row.reason.includes('超时'));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(transport.connections.length, 2, '尝试耗尽后不再重试（不逐帖承诺送达）');
});

test('sendDirect：迟到 ack 把未达升级为已投达（如实呈现、不回退）', { timeout: 15000 }, async (t) => {
  const transport = createFakeTransport();
  const { dispatch } = makeDispatch(t, { transport, direct: directOptions({ directMaxAttempts: 1 }) });
  t.after(() => dispatch.stop());
  const sent = dispatch.sendDirect(directTarget());
  await waitFor(() => dispatch.deliveryStatus({ msgId: sent.msgId })[0].tier === 'undelivered', { timeoutMs: 3000 });
  dispatch.onAck(sent.msgId);
  const row = dispatch.deliveryStatus({ msgId: sent.msgId })[0];
  assert.equal(row.tier, 'at-peer', '等待面收尾后到达的确认：真实送达不得呈现为未达');
  assert.equal(row.note, null);
});

test('sendDirect：调度器停止即在途直投收尾为未达、不再重试', { timeout: 15000 }, async (t) => {
  const transport = createFakeTransport();
  const { dispatch } = makeDispatch(t, { transport, direct: directOptions() });
  const sent = dispatch.sendDirect(directTarget());
  await waitFor(() => transport.connections[0]?.frames.length === 1);
  await dispatch.stop();
  await waitFor(() => dispatch.deliveryStatus({ msgId: sent.msgId })[0].tier === 'undelivered', { timeoutMs: 2000 });
  const row = dispatch.deliveryStatus({ msgId: sent.msgId })[0];
  assert.ok(row.reason.includes('停止'));
});

test('sendDirect：参数与终帧预检逐拒（传输类 / 本机 / 未知类型 / 帧不合协议），拒绝不拨号不登记', { timeout: 15000 }, async (t) => {
  const transport = createFakeTransport();
  const { dispatch } = makeDispatch(t, { transport, direct: directOptions() });
  t.after(() => dispatch.stop());
  const cases = [
    directTarget({ type: 'ping' }),
    directTarget({ to: { instanceId: 'inst-self', address: '127.0.0.1', port: 7321 } }),
    directTarget({ type: '未知' }),
    directTarget({ payload: { text: '缺帖形态' } }),
    directTarget({ to: { instanceId: 'inst-b', address: 'not-an-ip', port: 7321 } }),
    { collabId: 'bad id!', to: { instanceId: 'inst-b', address: '127.0.0.2', port: 7321 }, type: 'post', payload: { post: { postId: 'p1', seq: 1, kind: 'reply', text: 'x' } } },
  ];
  for (const input of cases) {
    const rejected = dispatch.sendDirect(input);
    assert.equal(rejected.ok, false, JSON.stringify(input).slice(0, 80));
    assert.equal(typeof rejected.reason, 'string', JSON.stringify(input).slice(0, 80));
  }
  assert.deepEqual(dispatch.deliveryStatus({}), [], '拒绝路径不登记投递记录');
  assert.equal(transport.dials.length, 0);
  assert.equal(dispatch.stats().directRejected, 6);
  const brokenPort = makeDispatch(t, { transport: createFakeTransport(), direct: directOptions(), self: { instanceId: 'inst-self', identityName: '本机', port: 0 } });
  const rejected = brokenPort.dispatch.sendDirect(directTarget());
  assert.equal(rejected.ok, false);
  assert.ok(rejected.reason.includes('from.port'), rejected.reason);
});

test('sendDirect：投递记录按保留窗剪枝、按容量淘汰最旧；collabId 过滤生效', { timeout: 15000 }, async (t) => {
  const transport = createFakeTransport();
  const { dispatch } = makeDispatch(t, { transport, direct: directOptions({ directRecordTtlMs: 100, directRecordMax: 2 }) });
  t.after(() => dispatch.stop());
  const first = dispatch.sendDirect(directTarget());
  const second = dispatch.sendDirect(directTarget({ to: { instanceId: 'inst-c', address: '127.0.0.3', port: 7321 } }));
  const third = dispatch.sendDirect(directTarget({ collabId: 'collab-g', to: { instanceId: 'inst-d', address: '127.0.0.4', port: 7321 } }));
  assert.deepEqual(dispatch.deliveryStatus({ msgId: first.msgId }), [], '容量 2：最旧记录被淘汰');
  assert.deepEqual(dispatch.deliveryStatus({ collabId: 'collab-f' }).map((row) => row.msgId), [second.msgId]);
  assert.equal(dispatch.deliveryStatus({ collabId: 'collab-g' })[0].msgId, third.msgId, 'collabId 过滤逐记录生效');
  assert.equal(dispatch.stats().directRecords, 2);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(dispatch.deliveryStatus({ collabId: 'collab-f' }), [], '超保留窗的记录从查询面消失（短时记录）');
});

test('sendDirect：重试间隙收到确认即收尾——不再重发（等待面之外的确认路径）', { timeout: 15000 }, async (t) => {
  const transport = createFakeTransport();
  const { dispatch } = makeDispatch(t, { transport, direct: directOptions({ directRetryIntervalMs: 300 }) });
  t.after(() => dispatch.stop());
  const sent = dispatch.sendDirect(directTarget());
  await waitFor(() => transport.connections[0]?.frames.length === 1);
  await waitFor(() => (dispatch.deliveryStatus({ msgId: sent.msgId })[0].reason ?? '').includes('超时'), { timeoutMs: 2000 });
  dispatch.onAck(sent.msgId);   // 等待窗超时之后、下一次尝试之前：确认在重试间隙到达
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(transport.connections.length, 1, '确认已收：不再重拨重发');
  assert.equal(dispatch.deliveryStatus({ msgId: sent.msgId })[0].tier, 'at-peer');
});

test('sendDirect：拨号在途时调度器停止——不发帧、收尾为未达（发送截止点）', { timeout: 15000 }, async (t) => {
  const transport = createFakeTransport();
  const { dispatch } = makeDispatch(t, { transport, direct: directOptions() });
  const gate = transport.deferNextDial();
  const sent = dispatch.sendDirect(directTarget());
  await waitFor(() => transport.dials.length === 1);
  const stopping = dispatch.stop();
  gate.release();
  await stopping;
  await waitFor(() => dispatch.deliveryStatus({ msgId: sent.msgId })[0].tier === 'undelivered', { timeoutMs: 2000 });
  assert.equal(transport.connections[0].frames.length, 0, '停止后完成的拨号不发帧');
  assert.ok(transport.connections[0].closed, '拨号收口就地关闭（不留无主连接）');
});

test('sendDirect：同对端两条并发——连接复用、活动计数正确收敛；队列 ack 不误关在途直投的连接', { timeout: 15000 }, async (t) => {
  const transport = createFakeTransport();
  const { dispatch } = makeDispatch(t, { transport, direct: directOptions({ directRetryIntervalMs: 2000 }) });
  t.after(() => dispatch.stop());
  dispatch.start();   // 启 tick：空闲连接回收在跑，直投连接不得被误关
  const first = dispatch.sendDirect(directTarget());
  const second = dispatch.sendDirect(directTarget({ payload: { post: { postId: 'post-2', seq: 2, kind: 'reply', text: '第二条' } } }));
  await waitFor(() => transport.connections.length === 1 && transport.connections[0].frames.length === 2);
  assert.equal(transport.dials.length, 1, '并发同单元共享同一次拨号（不双拨）');
  const queued = dispatch.send({ collabId: 'collab-f', to: { instanceId: 'inst-b', address: '127.0.0.2', port: 7321 }, type: 'reply', payload: { text: '排队消息' } });
  await waitFor(() => transport.connections[0].frames.length === 3);
  dispatch.onAck(queued.msgId);   // 队列 ack 触发的空闲回收：同对端仍有在途直投 → 连接保留
  assert.equal(transport.connections[0].closed, false);
  dispatch.onAck(first.msgId);
  assert.equal(transport.connections[0].closed, false, '另一条直投仍在途');
  dispatch.onAck(second.msgId);
  await waitFor(() => transport.connections[0].closed, { timeoutMs: 2000 });   // 直投清零 + 队列无待投 → tick 回收
  assert.equal(dispatch.deliveryStatus({ collabId: 'collab-f' }).length, 3);
});
