import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { COLLABS_DIR_NAME } from '../src/paths.js';
import { newMsgId } from '../src/net/protocol.js';
import { INBOX_FILE_NAME, createInbound } from '../src/net/inbound.js';
import { makeTempDir, waitFor } from './helpers.js';

const SELF = { instanceId: 'inst-self', identityName: '本机' };
const PEER = { instanceId: 'inst-peer', identityName: '主机乙' };

function createFakeDispatch() {
  const calls = { acks: [], reports: [], pongs: [], sends: [] };
  let pongResult = false;
  return {
    calls,
    setPongResult(value) {
      pongResult = value;
    },
    resolvePong(frame) {
      calls.pongs.push(frame.replyTo);
      return pongResult;
    },
    onAck(msgId) {
      calls.acks.push(msgId);
    },
    onDeliveryReport(payload) {
      calls.reports.push(payload);
    },
    send(message) {
      calls.sends.push(message);
      return { ok: true, msgId: 'report-msg', tier: 'queued' };
    },
  };
}

function createFakeConnection(remoteAddress = '127.0.0.2') {
  const sent = [];
  return {
    remoteAddress,
    sent,
    send(frame) {
      sent.push(frame);
    },
  };
}

function makeInbound(t, { dataDir, hooks, dispatch, config, log: logOverride } = {}) {
  const dir = dataDir ?? makeTempDir(t);
  const logs = [];
  const log = logOverride ?? {
    info: () => {},
    warn: (message, fields) => logs.push({ level: 'warn', message, fields }),
    error: (message, fields) => logs.push({ level: 'error', message, fields }),
  };
  const fakeDispatch = dispatch ?? createFakeDispatch();
  const inbound = createInbound({
    dataDir: dir,
    config: config ?? { messageTtlMs: 600000 },
    self: SELF,
    dispatch: fakeDispatch,
    hooks: hooks ?? { admit: () => ({ ok: true }) },
    log,
  });
  return { inbound, dir, logs, dispatch: fakeDispatch };
}

/* 协作域帧的 from 携带端口（构造侧必填）：投递回报按 from.port 回拨（转达副本例外：仅沿
 * 原连接原路——见转达帧回执用例）。
 * PEER 本体保持无端口——ping/pong/ack 等传输类帧不涉回报寻址。 */
function messageFrame(overrides = {}) {
  return {
    v: 1,
    msgId: newMsgId(),
    type: 'notice',
    from: { ...PEER, port: 7321 },
    collabId: 'collab-1',
    ts: new Date().toISOString(),
    payload: { text: '你好' },
    ...overrides,
  };
}

function inboxPath(dir, collabId = 'collab-1') {
  return join(dir, COLLABS_DIR_NAME, collabId, INBOX_FILE_NAME);
}

function readInbox(dir, collabId) {
  return readFileSync(inboxPath(dir, collabId), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('ping：回 pong（replyTo 正确、from=本机），不落盘', async (t) => {
  const { inbound, dir } = makeInbound(t);
  const connection = createFakeConnection();
  inbound.onFrame(connection, { v: 1, type: 'ping', msgId: newMsgId(), from: PEER, ts: new Date().toISOString() });
  await waitFor(() => connection.sent.length === 1);
  const pong = connection.sent[0];
  assert.equal(pong.type, 'pong');
  assert.equal(pong.from.instanceId, SELF.instanceId);
  assert.equal(inbound.stats().pingsAnswered, 1);
  assert.throws(() => readInbox(dir));
});

test('pong：转交 dispatch.resolvePong；未匹配计数', async (t) => {
  const { inbound, dispatch } = makeInbound(t);
  const connection = createFakeConnection();
  dispatch.setPongResult(true);
  inbound.onFrame(connection, { v: 1, type: 'pong', msgId: newMsgId(), replyTo: 'some-ping', from: PEER, ts: new Date().toISOString() });
  await waitFor(() => dispatch.calls.pongs.length === 1);
  dispatch.setPongResult(false);
  inbound.onFrame(connection, { v: 1, type: 'pong', msgId: newMsgId(), replyTo: 'other-ping', from: PEER, ts: new Date().toISOString() });
  await waitFor(() => inbound.stats().pongsUnmatched === 1);
});

test('ack：转交 dispatch.onAck(ackFor)', async (t) => {
  const { inbound, dispatch } = makeInbound(t);
  inbound.onFrame(createFakeConnection(), { v: 1, type: 'ack', msgId: newMsgId(), ackFor: 'msg-77', from: PEER, ts: new Date().toISOString() });
  await waitFor(() => dispatch.calls.acks.length === 1);
  assert.deepEqual(dispatch.calls.acks, ['msg-77']);
});

test('delivery-status：应用回报（转交 onDeliveryReport）后回 ack，不落盘不投会话', async (t) => {
  const { inbound, dir, dispatch } = makeInbound(t);
  const connection = createFakeConnection();
  const frame = {
    v: 1, type: 'delivery-status', msgId: newMsgId(), from: PEER, collabId: 'collab-1',
    ts: new Date().toISOString(), payload: { refMsgId: 'msg-88', tier: 'session' },
  };
  inbound.onFrame(connection, frame);
  await waitFor(() => dispatch.calls.reports.length === 1);
  assert.deepEqual(dispatch.calls.reports, [{ refMsgId: 'msg-88', tier: 'session' }]);
  await waitFor(() => inbound.stats().acksSent === 1);
  assert.deepEqual(connection.sent.map((sent) => sent.type), ['ack'], '回报以链路确认收敛——不产生针对回报的回报');
  assert.equal(connection.sent[0].ackFor, frame.msgId);
  assert.equal(inbound.stats().reportsIn, 1);
  assert.throws(() => readInbox(dir), '回报不落盘 inbox（无会话投递语义）');
  assert.deepEqual(dispatch.calls.sends, [], '回报不投会话、不产生新发送');
});

test('delivery-status：应用回报抛错仍回 ack（隔离异常，不让对端队头滞留）', async (t) => {
  const dispatch = createFakeDispatch();
  dispatch.onDeliveryReport = () => {
    throw new Error('回报应用故障');
  };
  const { inbound, logs } = makeInbound(t, { dispatch });
  const connection = createFakeConnection();
  inbound.onFrame(connection, {
    v: 1, type: 'delivery-status', msgId: newMsgId(), from: PEER, collabId: 'collab-1',
    ts: new Date().toISOString(), payload: { refMsgId: 'msg-99', tier: 'session' },
  });
  await waitFor(() => inbound.stats().reportFailures === 1);
  assert.deepEqual(connection.sent.map((sent) => sent.type), ['ack'], 'ack 是递归终端：应用失败也不改变它的发出');
  assert.equal(inbound.stats().reportsIn, 1);
  assert.ok(logs.some((entry) => entry.message.includes('投递回报应用异常')), '隔离必须留痕');
});

test('协作消息：先落盘再 ack，钩子按 consume → deliver 顺序执行', async (t) => {
  const events = [];
  const { inbound, dir } = makeInbound(t, {
    hooks: {
      admit: () => ({ ok: true }),
      consume: (frame) => events.push(`consume:${frame.msgId}`),
      deliverToSession: (frame) => {
        events.push(`deliver:${frame.msgId}`);
        return true;
      },
    },
  });
  const connection = createFakeConnection();
  const frame = messageFrame();
  inbound.onFrame(connection, frame);
  await waitFor(() => events.length === 2);
  assert.deepEqual(connection.sent.map((sent) => sent.type), ['ack']);
  assert.equal(connection.sent[0].ackFor, frame.msgId);
  assert.deepEqual(events, [`consume:${frame.msgId}`, `deliver:${frame.msgId}`]);
  const stored = readInbox(dir);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].msgId, frame.msgId);
  assert.equal(stored[0].payload.text, '你好');
  assert.ok(!Number.isNaN(Date.parse(stored[0].receivedAt)));
});

test('投递成功：回报 delivery-status（目标=来源地址、载荷=原 msgId + session）', async (t) => {
  const { inbound, dispatch } = makeInbound(t, {
    hooks: { admit: () => ({ ok: true }), deliverToSession: () => true },
  });
  const connection = createFakeConnection('127.0.0.7');
  const frame = messageFrame();
  inbound.onFrame(connection, frame);
  await waitFor(() => dispatch.calls.sends.length === 1);
  assert.deepEqual(dispatch.calls.sends[0], {
    collabId: 'collab-1',
    to: { instanceId: PEER.instanceId, address: '127.0.0.7', port: 7321 },
    type: 'delivery-status',
    payload: { refMsgId: frame.msgId, tier: 'session' },
  });
});

test('投递成功但回报入队失败：维持第二档（告警、不计 reportsSent、消息留在流水）', async (t) => {
  const dispatch = createFakeDispatch();
  dispatch.send = () => ({ ok: false, reason: '该协作待投队列已满' });
  const { inbound, dir, logs } = makeInbound(t, {
    dispatch,
    hooks: { admit: () => ({ ok: true }), deliverToSession: () => true },
  });
  const connection = createFakeConnection();
  const frame = messageFrame();
  inbound.onFrame(connection, frame);
  await waitFor(() => logs.some((entry) => entry.message.includes('投递回报入队失败')));
  assert.equal(inbound.stats().sessionDelivered, 1);
  assert.equal(inbound.stats().reportsSent, 0, '未入队不算发出');
  assert.deepEqual(connection.sent.map((sent) => sent.type), ['ack'], '回报失败不回退链路确认');
  assert.deepEqual(readInbox(dir).map((entry) => entry.msgId), [frame.msgId], '消息留在收件流水（第二档）');
});

test('投递失败（返回 false / 抛错）：不发回报、仍 ack（维持第二档）', async (t) => {
  const { inbound, dispatch, logs } = makeInbound(t, {
    hooks: {
      admit: () => ({ ok: true }),
      deliverToSession: () => {
        throw new Error('适配器故障');
      },
    },
  });
  const connection = createFakeConnection();
  inbound.onFrame(connection, messageFrame());
  await waitFor(() => connection.sent.length === 1);
  await waitFor(() => logs.some((entry) => entry.message.includes('会话投递钩子异常')));
  assert.deepEqual(dispatch.calls.sends, []);
  assert.equal(connection.sent[0].type, 'ack');
});

test('准入拒绝：不落盘、不 ack、计数与告警留痕', async (t) => {
  const { inbound, dir, logs } = makeInbound(t, { hooks: { admit: () => ({ ok: false, reason: '本机无此协作' }) } });
  const connection = createFakeConnection();
  inbound.onFrame(connection, messageFrame());
  await waitFor(() => inbound.stats().rejected.admission === 1);
  assert.deepEqual(connection.sent, []);
  assert.throws(() => readInbox(dir));
  assert.ok(logs.some((entry) => entry.message.includes('未通过准入')));
});

test('准入钩子异常：归类为准入拒绝（计数 + 留痕、不落盘、不 ack）', async (t) => {
  const { inbound, dir, logs } = makeInbound(t, {
    hooks: {
      admit: () => {
        throw new Error('台账故障');
      },
    },
  });
  const connection = createFakeConnection();
  inbound.onFrame(connection, messageFrame());
  await waitFor(() => inbound.stats().rejected.admission === 1);
  assert.deepEqual(connection.sent, [], '拒绝方向不变：不确认');
  assert.throws(() => readInbox(dir));
  assert.equal(inbound.stats().hookFailures, 0, '钩子异常在此按准入语义归类，不重复计入 hookFailures');
  assert.ok(
    logs.some((entry) => entry.message.includes('未通过准入') && entry.fields.reason.includes('台账故障')),
    '异常原因必须进告警：台账故障时消息会全部丢弃，观测面不得同时失效'
  );
});

test('钩子缺省（未注入）：协作消息按安全默认被拒，不产生副作用', async (t) => {
  const { inbound, dispatch } = makeInbound(t, { hooks: {} });
  const connection = createFakeConnection();
  inbound.onFrame(connection, messageFrame());
  await waitFor(() => inbound.stats().rejected.admission === 1);
  assert.deepEqual(connection.sent, []);
  assert.deepEqual(dispatch.calls.sends, []);
});

test('重复 msgId：重发 ack、不重复落盘、不重发回报', async (t) => {
  const { inbound, dir, dispatch } = makeInbound(t, {
    hooks: { admit: () => ({ ok: true }), deliverToSession: () => true },
  });
  const connection = createFakeConnection();
  const frame = messageFrame();
  inbound.onFrame(connection, frame);
  await waitFor(() => dispatch.calls.sends.length === 1);
  inbound.onFrame(connection, frame);
  await waitFor(() => inbound.stats().duplicates === 1);
  assert.deepEqual(connection.sent.map((sent) => sent.type), ['ack', 'ack']);
  assert.equal(connection.sent[1].ackFor, frame.msgId);
  assert.equal(readInbox(dir).length, 1);
  assert.equal(dispatch.calls.sends.length, 1, '重复投递不重发回报');
  assert.equal(inbound.stats().acksSent, 2, '重复路径发出的 ack 与正常路径同口径计数');
});

test('重复 msgId：consume 钩子只回调一次（受理后的去重语义）', async (t) => {
  /* 计数面（状态栏消息数）依赖这条管线性质：consume 每帧至多一次，去重命中不再回调——
   * 在 consume 里记账即天然「去重后各计一次」。 */
  const consumed = [];
  const { inbound } = makeInbound(t, {
    hooks: { admit: () => ({ ok: true }), consume: (frame) => { consumed.push(frame.msgId); }, deliverToSession: () => true },
  });
  const connection = createFakeConnection();
  const frame = messageFrame();
  inbound.onFrame(connection, frame);
  await waitFor(() => consumed.length === 1);
  inbound.onFrame(connection, frame);
  await waitFor(() => inbound.stats().duplicates === 1);
  assert.equal(consumed.length, 1, '重复副本不再触发 consume');
  assert.deepEqual(consumed, [frame.msgId]);
});

/* 静音栅栏与注入标记（讨论模式 §5.7）的接收管线面：本层不掌握模式与静音态，只认服务钩子的
 * 声明（sessionGate 的 { suppress: true } / consume 的 wasInjected 前件）。 */

/* 吸收路径用例的构造：consume 声明 { sessionDeliver: false, ... }，观察终态回执与投递面。 */
async function absorbedCase(t, type, consumed) {
  const deliveries = [];
  const { inbound, dispatch } = makeInbound(t, {
    hooks: {
      admit: () => ({ ok: true }),
      consume: () => consumed,
      deliverToSession: (frame) => { deliveries.push(frame.msgId); return true; },
    },
  });
  const connection = createFakeConnection();
  const frame = messageFrame({ type });
  inbound.onFrame(connection, frame);
  await waitFor(() => inbound.stats().sessionSuppressed === 1);
  return { inbound, dispatch, deliveries, frame };
}

test('静音栅栏（sessionGate）：suppress 帧不投递、不回报；落盘与 ack 照旧（只做减法）', async (t) => {
  const { inbound, dir, dispatch } = makeInbound(t, {
    hooks: { admit: () => ({ ok: true }), sessionGate: () => ({ suppress: true }), deliverToSession: () => true },
  });
  const connection = createFakeConnection();
  const frame = messageFrame();
  inbound.onFrame(connection, frame);
  await waitFor(() => inbound.stats().sessionGated === 1);
  assert.equal(inbound.stats().sessionDelivered, 0, '被抑制帧不进会话');
  assert.deepEqual(dispatch.calls.sends, [], '被抑制帧不发终态回报（发送侧维持第二档）');
  assert.deepEqual(connection.sent.map((sent) => sent.type), ['ack'], '链路口径不变：照常 ack');
  assert.deepEqual(readInbox(dir).map((entry) => entry.msgId), [frame.msgId], '抑制不落差别：照常落盘');
});

test('静音栅栏放行：未声明 suppress（{} / null / 钩子缺省）一律照旧投递', async (t) => {
  const delivered = [];
  let gateResult = {};
  const { inbound } = makeInbound(t, {
    hooks: { admit: () => ({ ok: true }), sessionGate: () => gateResult, deliverToSession: (frame) => { delivered.push(frame.msgId); return true; } },
  });
  inbound.onFrame(createFakeConnection(), messageFrame());
  await waitFor(() => delivered.length === 1);
  gateResult = null;
  inbound.onFrame(createFakeConnection(), messageFrame());
  await waitFor(() => delivered.length === 2);
  assert.equal(inbound.stats().sessionGated, 0);
  assert.equal(inbound.stats().sessionDelivered, 2);
});

test('静音栅栏异常：计入 hookFailures 并照旧投递（栅栏是附属机制，判定失败不改变注入）', async (t) => {
  const delivered = [];
  const { inbound, logs } = makeInbound(t, {
    hooks: {
      admit: () => ({ ok: true }),
      sessionGate: () => { throw new Error('静音判定故障'); },
      deliverToSession: (frame) => { delivered.push(frame.msgId); return true; },
    },
  });
  inbound.onFrame(createFakeConnection(), messageFrame());
  await waitFor(() => delivered.length === 1);
  assert.equal(inbound.stats().hookFailures, 1);
  assert.equal(inbound.stats().sessionDelivered, 1, '异常 → 按照旧注入');
  assert.ok(logs.some((entry) => entry.message.includes('接收钩子异常')), '异常必须留痕');
});

test('投递成功路径顺序：投递 → sessionDelivered 记真通知 → 终态回报（先记真后回报）', async (t) => {
  const order = [];
  const dispatch = createFakeDispatch();
  const send = dispatch.send;
  dispatch.send = (message) => { order.push('report'); return send(message); };
  const { inbound } = makeInbound(t, {
    dispatch,
    hooks: {
      admit: () => ({ ok: true }),
      deliverToSession: () => { order.push('deliver'); return true; },
      sessionDelivered: () => { order.push('delivered-notice'); },
    },
  });
  inbound.onFrame(createFakeConnection(), messageFrame());
  await waitFor(() => order.length === 3);
  assert.deepEqual(order, ['deliver', 'delivered-notice', 'report'], '标记落定必须发生在终态回报之前');
});

test('吸收路径终态回执（帖支）：wasInjected 为真才回报；假 / 缺失不回报（维持第二档）', async (t) => {
  const hit = await absorbedCase(t, 'post', { sessionDeliver: false, wasInjected: true });
  await waitFor(() => hit.dispatch.calls.sends.length === 1);
  assert.equal(hit.dispatch.calls.sends[0].payload.refMsgId, hit.frame.msgId);
  assert.equal(hit.dispatch.calls.sends[0].payload.tier, 'session');
  assert.deepEqual(hit.deliveries, [], '吸收路径不重复注入');
  const miss = await absorbedCase(t, 'post', { sessionDeliver: false, wasInjected: false });
  const missing = await absorbedCase(t, 'post', { sessionDeliver: false });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(miss.dispatch.calls.sends, [], '未注入过：不回报终态');
  assert.deepEqual(missing.dispatch.calls.sends, [], '前件缺失（旧声明）：不回报终态');
  assert.deepEqual(miss.deliveries, [], '不注入');
});

test('join 通道吸收路径维持现状：重复副本仍回报终态（不受帖支前件约束）', async (t) => {
  const made = await absorbedCase(t, 'join', { sessionDeliver: false });
  await waitFor(() => made.dispatch.calls.sends.length === 1);
  assert.equal(made.dispatch.calls.sends[0].payload.refMsgId, made.frame.msgId);
  assert.deepEqual(made.deliveries, [], '不重复注入');
});

test('去重窗口：保留期内的记录参与去重；超窗视为新消息', async (t) => {
  const dir = makeTempDir(t);
  mkdirSync(join(dir, COLLABS_DIR_NAME, 'collab-1'), { recursive: true });
  const oldFrame = messageFrame();
  const freshFrame = messageFrame();
  writeFileSync(inboxPath(dir), [
    JSON.stringify({ ...oldFrame, receivedAt: new Date(Date.now() - 700000).toISOString() }),
    JSON.stringify({ ...freshFrame, receivedAt: new Date().toISOString() }),
  ].join('\n') + '\n');
  const { inbound } = makeInbound(t, { dataDir: dir, config: { messageTtlMs: 600000 } });
  const connection = createFakeConnection();
  inbound.onFrame(connection, oldFrame);
  await waitFor(() => connection.sent.length === 1);
  assert.equal(inbound.stats().accepted, 1, '超窗的同 msgId 视为新消息');
  inbound.onFrame(connection, freshFrame);
  await waitFor(() => inbound.stats().duplicates === 1);
  // 载入即压实一次（出窗行被吸收）：3 = 载入后压实的 1 行（freshFrame）+ 新受理的 oldFrame
  assert.equal(readInbox(dir).length, 2);
});

test('去重窗口运行期生效：超窗同 msgId 视为新消息（与载入路径同一口径）', async (t) => {
  const { inbound, dir } = makeInbound(t, {
    config: { messageTtlMs: 50 },
    hooks: { admit: () => ({ ok: true }) },
  });
  const connection = createFakeConnection();
  const frame = messageFrame();
  inbound.onFrame(connection, frame);
  await waitFor(() => inbound.stats().accepted === 1);
  await new Promise((resolve) => setTimeout(resolve, 110));   // 等首条出窗（窗口 50ms）
  inbound.onFrame(connection, frame);
  await waitFor(() => inbound.stats().accepted === 2);
  assert.equal(inbound.stats().duplicates, 0, '出窗后不再判重');
  assert.equal(readInbox(dir).length, 2, '重投按新消息落盘');
  assert.deepEqual(connection.sent.map((sent) => sent.type), ['ack', 'ack']);
});

test('去重窗口剪枝：seen 与收件流水不随历史总量增长（超窗记录被吸收）', async (t) => {
  const { inbound, dir } = makeInbound(t, {
    config: { messageTtlMs: 50 },
    hooks: { admit: () => ({ ok: true }) },
  });
  const connection = createFakeConnection();
  let accepted = 0;
  for (let round = 0; round < 4; round++) {
    for (let index = 0; index < 5; index++) {
      accepted++;
      inbound.onFrame(connection, messageFrame({ payload: { text: `第${round}轮-${index}` } }));
    }
    await waitFor(() => inbound.stats().accepted === accepted);   // 同连接串行：一批投完再等
    await new Promise((resolve) => setTimeout(resolve, 110));     // 等本批全部出窗
  }
  inbound.onFrame(connection, messageFrame({ payload: { text: '收尾' } }));
  await waitFor(() => inbound.stats().accepted === accepted + 1);
  assert.equal(inbound.stats().seen, 1, '20 条历史记录的判重项全部剪掉，只剩窗口内的这一条');
  const lines = readInbox(dir).length;
  assert.ok(lines <= 2, `收件流水被重写为窗口投影（历史 20 条已吸收，实测 ${lines} 行）`);
  assert.equal(inbound.stats().duplicates, 0);
});

test('去重窗口载入失败（存储不可用）：计数留痕后置空继续，不把处理打成异常', async (t) => {
  const dir = makeTempDir(t);
  mkdirSync(inboxPath(dir), { recursive: true });   // 以目录占据流水文件路径：读取失败（EISDIR，双平台一致）
  const { inbound, logs } = makeInbound(t, { dataDir: dir });
  const connection = createFakeConnection();
  inbound.onFrame(connection, messageFrame());
  await waitFor(() => logs.some((entry) => entry.message.includes('收件流水读取失败')));
  assert.ok(inbound.stats().persistFailures >= 1);
  await waitFor(() => logs.some((entry) => entry.message.includes('入站消息落盘失败')));
  assert.deepEqual(connection.sent, [], '存储不可用即不承诺：不发 ack');
});

test('落盘失败（存储不可用）：不 ack、计数与留痕（两平台可达）', async (t) => {
  const dir = makeTempDir(t);
  mkdirSync(join(dir, COLLABS_DIR_NAME), { recursive: true });
  writeFileSync(join(dir, COLLABS_DIR_NAME, 'collab-1'), 'blocker');   // 以同名文件挡住协作目录
  const { inbound, logs } = makeInbound(t, { dataDir: dir });
  const connection = createFakeConnection();
  inbound.onFrame(connection, messageFrame());
  // 存储不可用的错误码两平台不同（同名文件下的读写：Windows 报 ENOENT、Linux 报 ENOTDIR），
  // 断言口径取「至少计数 1 次 + 留痕含词样」，不锁具体次数与错误码
  await waitFor(() => inbound.stats().persistFailures >= 1);
  assert.deepEqual(connection.sent, [], '未落盘不承诺：不发 ack');
  assert.ok(logs.some((entry) => entry.message.includes('落盘失败')), '拒绝路径必须计数留痕（不允许静默）');
});

test('同连接串行：慢钩子下第二帧等第一帧处理完（保序）', async (t) => {
  const events = [];
  let releaseFirst = null;
  const { inbound, dir } = makeInbound(t, {
    hooks: {
      admit: () => ({ ok: true }),
      deliverToSession: (frame) => {
        events.push(`deliver:${frame.payload.text}`);
        if (frame.payload.text === '一') {
          return new Promise((resolve) => {
            releaseFirst = () => resolve(true);
          });
        }
        return true;
      },
    },
  });
  const connection = createFakeConnection();
  inbound.onFrame(connection, messageFrame({ payload: { text: '一' } }));
  await waitFor(() => releaseFirst !== null);
  inbound.onFrame(connection, messageFrame({ payload: { text: '二' } }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(events, ['deliver:一']);
  releaseFirst();
  await waitFor(() => events.length === 2);
  assert.deepEqual(events, ['deliver:一', 'deliver:二']);
  assert.deepEqual(readInbox(dir).map((entry) => entry.payload.text), ['一', '二']);
});

test('链级兜底：处理器与日志双抛错都不逃逸（进程不退、计数、后续帧继续）', async (t) => {
  // 日志可注入：生产 logger 全路径自吞异常，此处模拟「日志本身抛错」——隔离带自己的日志也在被兜底之列
  const throwingLog = {
    info: () => {},
    warn: () => {},
    error: () => {
      throw new Error('日志盘故障');
    },
  };
  const { inbound } = makeInbound(t, {
    log: throwingLog,
    hooks: {
      admit: () => ({ ok: true }),
      consume: () => {
        throw new Error('钩子故障');
      },
    },
  });
  const connection = createFakeConnection();
  inbound.onFrame(connection, messageFrame());
  await waitFor(() => inbound.stats().frameFailures === 1);
  assert.equal(inbound.stats().hookFailures, 1, '内层隔离先记钩子异常；随后日志异常升级到链级兜底');
  assert.deepEqual(connection.sent.map((sent) => sent.type), ['ack'], 'ack 在钩子执行之前已发出');
  inbound.onFrame(connection, { v: 1, type: 'ping', msgId: newMsgId(), from: PEER, ts: new Date().toISOString() });
  await waitFor(() => connection.sent.length === 2);
  assert.equal(connection.sent[1].type, 'pong', '链未进入 rejected 态：后续帧照常处理');
});

test('stats：计数齐备', async (t) => {
  const { inbound } = makeInbound(t, { hooks: { admit: () => ({ ok: true }), deliverToSession: () => true } });
  const connection = createFakeConnection();
  inbound.onFrame(connection, messageFrame());
  await waitFor(() => inbound.stats().accepted === 1);
  const counters = inbound.stats();
  assert.equal(counters.acksSent, 1);
  assert.equal(counters.sessionDelivered, 1);
  assert.equal(counters.reportsSent, 1);
  assert.equal(counters.collabs, 1);
});

test('from.port 缺失：投递回报沿原连接原路回执（不发起新拨号、不猜端口）', { timeout: 15000 }, async (t) => {
  const { inbound, dispatch } = makeInbound(t, {
    hooks: { admit: () => ({ ok: true }), deliverToSession: () => true },
  });
  const connection = createFakeConnection('127.0.0.7');
  const frame = messageFrame({ from: { instanceId: PEER.instanceId, identityName: PEER.identityName } });
  inbound.onFrame(connection, frame);
  await waitFor(() => connection.sent.some((sent) => sent.type === 'delivery-status'));
  assert.deepEqual(dispatch.calls.sends, [], '缺端口不得发起新拨号');
  const report = connection.sent.find((sent) => sent.type === 'delivery-status');
  assert.deepEqual(report.payload, { refMsgId: frame.msgId, tier: 'session' });
  assert.equal(report.collabId, 'collab-1');
  assert.equal(inbound.stats().reportsSent, 1);
});

test('from.port 缺失且原路回执写失败：告警计数、不抛出（维持第二档）', { timeout: 15000 }, async (t) => {
  const { inbound, logs } = makeInbound(t, {
    hooks: { admit: () => ({ ok: true }), deliverToSession: () => true },
  });
  const connection = createFakeConnection();
  connection.send = (frame) => {
    if (frame.type === 'delivery-status') {
      throw new Error('连接已断');
    }
  };
  const frame = messageFrame({ from: { instanceId: PEER.instanceId, identityName: PEER.identityName } });
  inbound.onFrame(connection, frame);
  await waitFor(() => inbound.stats().reportFailures === 1);
  assert.ok(logs.some((entry) => entry.message.includes('原路回执失败')));
  assert.equal(inbound.stats().reportsSent, 0);
});

test('转达帧回执：回报仅沿原连接原路——不按原发者 from.port 新拨号（错位寻址 / 杂散重试条目的来源）', { timeout: 15000 }, async (t) => {
  const { inbound, dispatch } = makeInbound(t, {
    hooks: { admit: () => ({ ok: true }), deliverToSession: () => true },
  });
  const connection = createFakeConnection('127.0.0.7');   // 转达者的来源地址：与原发者地址无关
  const origin = { instanceId: 'inst-origin', identityName: '主机丙', port: 7321 };
  const frame = messageFrame({ from: origin, payload: { text: '转达副本', originMsgId: 'msg-origin-1' } });
  inbound.onFrame(connection, frame);
  await waitFor(() => connection.sent.some((sent) => sent.type === 'delivery-status'));
  assert.deepEqual(dispatch.calls.sends, [], '转达副本不得按 from.port 向原发者新拨号（错位寻址与错位队列条目的来源）');
  const report = connection.sent.find((sent) => sent.type === 'delivery-status');
  assert.deepEqual(report.payload, { refMsgId: frame.msgId, tier: 'session' });
  assert.equal(inbound.stats().reportsSent, 1);
});

test('admit 异步钩子：async 实现正常通过（契约硬化——不再被误判为全量拒绝）', { timeout: 15000 }, async (t) => {
  const { inbound, dir } = makeInbound(t, {
    hooks: {
      admit: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { ok: true };
      },
      deliverToSession: () => false,
    },
  });
  const connection = createFakeConnection();
  const frame = messageFrame();
  inbound.onFrame(connection, frame);
  await waitFor(() => connection.sent.length === 1);
  assert.equal(connection.sent[0].type, 'ack');
  assert.deepEqual(readInbox(dir).map((entry) => entry.msgId), [frame.msgId], '异步准入通过：消息落盘');
});

test('admit 异步钩子：async 拒绝路径计数与告警', { timeout: 15000 }, async (t) => {
  const { inbound, dir, logs } = makeInbound(t, {
    hooks: {
      admit: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { ok: false, reason: '台账无此协作' };
      },
    },
  });
  const connection = createFakeConnection();
  inbound.onFrame(connection, messageFrame());
  await waitFor(() => inbound.stats().rejected.admission === 1);
  assert.deepEqual(connection.sent, []);
  assert.throws(() => readInbox(dir));
  assert.ok(logs.some((entry) => entry.message.includes('台账无此协作')));
});

test('checkInbox：返回窗口投影（total/returned/最近 limit 条、按到达序）', { timeout: 15000 }, async (t) => {
  const { inbound } = makeInbound(t, {
    hooks: { admit: () => ({ ok: true }), deliverToSession: () => false },
  });
  const sentIds = [];
  for (let index = 0; index < 3; index++) {
    const frame = messageFrame({ payload: { text: `第${index}条` } });
    sentIds.push(frame.msgId);
    inbound.onFrame(createFakeConnection(), frame);
    await waitFor(() => inbound.stats().accepted === index + 1);
  }
  const all = inbound.checkInbox({ collabId: 'collab-1' });
  assert.equal(all.total, 3);
  assert.equal(all.returned, 3);
  assert.deepEqual(all.messages.map((entry) => entry.msgId), sentIds);
  const page = inbound.checkInbox({ collabId: 'collab-1', limit: 2 });
  assert.equal(page.total, 3);
  assert.equal(page.returned, 2);
  assert.deepEqual(page.messages.map((entry) => entry.msgId), sentIds.slice(1), '取最近 N 条、保持到达序');
});

test('checkInbox：窗口口径一致——已载入 box 与重启后文件投影对出窗记录同判', { timeout: 15000 }, async (t) => {
  const config = { messageTtlMs: 200 };
  const { inbound, dir } = makeInbound(t, {
    config,
    hooks: { admit: () => ({ ok: true }), deliverToSession: () => false },
  });
  inbound.onFrame(createFakeConnection(), messageFrame());
  await waitFor(() => inbound.stats().accepted === 1);
  assert.equal(inbound.checkInbox({ collabId: 'collab-1' }).total, 1, '窗口内：记录应可见');
  await new Promise((resolve) => setTimeout(resolve, 300));   // 等记录出窗（窗口 200ms）
  /* 重启后投影：同一数据目录新建接收管线（判重盒为空）→ 查询走文件读取分支。 */
  const restarted = makeInbound(t, { dataDir: dir, config, hooks: { admit: () => ({ ok: true }) } }).inbound;
  const inProcess = inbound.checkInbox({ collabId: 'collab-1' });
  const afterRestart = restarted.checkInbox({ collabId: 'collab-1' });
  assert.equal(inProcess.total, 0, '出窗记录：已载入 box 路径不得返回');
  assert.deepEqual(inProcess, afterRestart, '同一数据目录：两条路径对出窗记录同判');
});

test('checkInbox：limit 越界与 collabId 非法抛 TypeError（默认 50 / 上限 500）', { timeout: 15000 }, async (t) => {
  const { inbound } = makeInbound(t);
  assert.throws(() => inbound.checkInbox({ collabId: 'collab-1', limit: 0 }), TypeError);
  assert.throws(() => inbound.checkInbox({ collabId: 'collab-1', limit: 501 }), TypeError);
  assert.throws(() => inbound.checkInbox({ collabId: 'collab-1', limit: 1.5 }), TypeError);
  assert.throws(() => inbound.checkInbox({ collabId: '../evil' }), TypeError);
  assert.throws(() => inbound.checkInbox({}), TypeError);
});

test('checkInbox：未载入协作的只读读取（不建目录、不建判重盒）', { timeout: 15000 }, async (t) => {
  const { inbound, dir } = makeInbound(t);
  const empty = inbound.checkInbox({ collabId: 'collab-9' });
  assert.deepEqual(empty, { collabId: 'collab-9', total: 0, returned: 0, messages: [] });
  assert.equal(existsSync(join(dir, COLLABS_DIR_NAME, 'collab-9')), false, '读路径不得给未载入协作造目录副作用');
  assert.equal(inbound.stats().collabs, 0);
});

test('checkInbox：读失败（路径为目录）抛错并计数留痕（不得静默返回空）', { timeout: 15000 }, async (t) => {
  const { inbound, dir, logs } = makeInbound(t);
  mkdirSync(inboxPath(dir, 'collab-1'), { recursive: true });   // EISDIR 的双平台构造：把 inbox.jsonl 做成目录
  assert.throws(() => inbound.checkInbox({ collabId: 'collab-1' }));
  assert.ok(inbound.stats().persistFailures >= 1);
  assert.ok(logs.some((entry) => entry.message.includes('收件流水读取失败')));
});

test('钩子 meta：admit 与 consume 均收到连接来源地址', { timeout: 15000 }, async (t) => {
  const metas = { admit: [], consume: [] };
  const { inbound } = makeInbound(t, {
    hooks: {
      admit: (frame, meta) => {
        metas.admit.push(meta);
        return { ok: true };
      },
      consume: (frame, meta) => {
        metas.consume.push(meta);
      },
      deliverToSession: () => false,
    },
  });
  const connection = createFakeConnection('127.0.0.7');
  inbound.onFrame(connection, messageFrame());
  await waitFor(() => inbound.stats().accepted === 1);
  assert.deepEqual(metas.admit, [{ remoteAddress: '127.0.0.7' }]);
  assert.deepEqual(metas.consume, [{ remoteAddress: '127.0.0.7' }]);
});

test('钩子 meta：连接无来源地址时为空串（不抛出）', { timeout: 15000 }, async (t) => {
  const metas = [];
  const { inbound } = makeInbound(t, {
    hooks: {
      admit: (frame, meta) => {
        metas.push(meta);
        return { ok: true };
      },
      deliverToSession: () => false,
    },
  });
  const connection = createFakeConnection();
  delete connection.remoteAddress;
  inbound.onFrame(connection, messageFrame());
  await waitFor(() => inbound.stats().accepted === 1);
  assert.deepEqual(metas, [{ remoteAddress: '' }]);
});

test('查询路径：收件流水残缺记录留痕（warn，与载入路径同口径）', (t) => {
  const { inbound, dir, logs } = makeInbound(t);
  const now = new Date().toISOString();
  mkdirSync(join(dir, COLLABS_DIR_NAME, 'collab-corrupt'), { recursive: true });
  writeFileSync(inboxPath(dir, 'collab-corrupt'), `{"msgId":"m-1","receivedAt":"${now}"}\n{oops\n`);
  const records = inbound.checkInbox({ collabId: 'collab-corrupt', limit: 10 });
  assert.equal(records.total, 1, '残缺行不计：可解析条目照常返回');
  assert.equal(logs.some((entry) => entry.level === 'warn' && entry.message.includes('残缺记录')), true, '查询路径同样留痕');
});
