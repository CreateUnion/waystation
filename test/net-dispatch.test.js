import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDispatch } from '../src/net/dispatch.js';
import { newMsgId } from '../src/net/protocol.js';
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

function createFakeTransport() {
  let nextDialFails = false;
  let deferred = null;   // 挂起拨号：构造「stop / ack / 重入检查与在途拨号并发」的时间窗口
  const dials = [];
  const connections = [];
  return {
    dials,
    connections,
    setNextDialFails(value) {
      nextDialFails = value;
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
      if (nextDialFails) {
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

function makeDispatch(t, { transport, config, self } = {}) {
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
    self: self ?? { instanceId: 'inst-self', identityName: '本机' },
    log,
  });
  return { dispatch, dataDir, logs, log };
}

function target(overrides = {}) {
  return { collabId: 'collab-1', to: { instanceId: 'inst-b', address: '127.0.0.2' }, type: 'notice', payload: { text: '你好' }, ...overrides };
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
  assert.equal(frame.type, 'notice');
  assert.equal(frame.collabId, 'collab-1');
  assert.deepEqual(frame.from, { instanceId: 'inst-self', identityName: '本机' });
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
  dispatch.send(target({ to: { instanceId: 'inst-b', address: '127.0.0.2' } }));
  dispatch.send(target({ to: { instanceId: 'inst-c', address: '127.0.0.3' } }));
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
  assert.equal(dispatch.send({ collabId: '../x', to: { instanceId: 'inst-b', address: '127.0.0.2' }, type: 'notice' }).ok, false);
  assert.equal(dispatch.send({ collabId: 'collab-1', to: { instanceId: 'inst-b', address: 'hostname' }, type: 'notice' }).ok, false);
  assert.equal(dispatch.send({ collabId: 'collab-1', to: { instanceId: 'inst-b', address: '127.0.0.2' }, type: '编造类型' }).ok, false);
  assert.equal(dispatch.send({ collabId: 'collab-1', to: { instanceId: 'inst-self', address: '127.0.0.1' }, type: 'notice' }).ok, false);
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
  const followUp = dispatch.send(target({ to: { instanceId: 'inst-c', address: '127.0.0.3' }, payload: { text: '丙' } }));
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
  const second = dispatch.send(target({ payload: { text: '二' }, type: 'freeze' }));
  assert.equal(second.ok, true);
  await waitFor(() => dispatch.deliveryStatus({ msgId: first.msgId }).length === 0, { timeoutMs: 5000 });
  dispatch.onAck(second.msgId);
  assert.equal(dispatch.deliveryStatus({ msgId: second.msgId })[0].tier, 'at-peer');
});
