import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

function messageFrame(overrides = {}) {
  return {
    v: 1,
    msgId: newMsgId(),
    type: 'notice',
    from: PEER,
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
    to: { instanceId: PEER.instanceId, address: '127.0.0.7' },
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
