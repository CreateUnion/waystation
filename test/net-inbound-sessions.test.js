import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COLLABS_DIR_NAME } from '../src/paths.js';
import { COLLAB_CAPABILITY, MAX_ACTIVE_SEATS, newMsgId } from '../src/net/protocol.js';
import { INBOX_FILE_NAME, createInbound } from '../src/net/inbound.js';
import { decideAdmission } from '../src/collab/gate.js';
import { makeTempDir, waitFor } from './helpers.js';

const SELF = { instanceId: 'inst-self', identityName: '本机', port: 7321 };

function createFakeDispatch() {
  const calls = { acks: [], reports: [], sends: [] };
  return {
    calls,
    resolvePong: () => false,
    onAck: (msgId) => calls.acks.push(msgId),
    onDeliveryReport: (payload) => calls.reports.push(payload),
    send: (message) => {
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

function seat(sessionId, state = 'member', extra = {}) {
  return { sessionId, role: 'member', state, joinSeq: 1, muted: false, unverified: false, ...extra };
}

/* 席位注入口的默认替身：记录每次调用，按 map 返回结果（缺省已注入）。 */
function makeInjector(outcomes = {}) {
  const calls = [];
  return {
    calls,
    async inject(collabId, sessionId, frame) {
      calls.push({ collabId, sessionId, msgId: frame.msgId, payload: frame.payload, type: frame.type });
      const outcome = outcomes[sessionId];
      if (typeof outcome === 'function') {
        return outcome(collabId, sessionId, frame);
      }
      return outcome ?? { ok: true, delivered: true };
    },
  };
}

function makeInbound(t, { seats = [seat('sess-b1'), seat('sess-b2')], injector, gate, dataDir, config, hooks = {} } = {}) {
  const dir = dataDir ?? makeTempDir(t);
  const dispatch = createFakeDispatch();
  const inject = injector ?? makeInjector();
  const gateCalls = [];
  const gateHook = gate ?? (() => ({ suppress: false }));
  const inbound = createInbound({
    dataDir: dir,
    config: config ?? { messageTtlMs: 600000 },
    self: SELF,
    dispatch,
    hooks: {
      admit: () => ({ ok: true }),
      listSeats: () => seats,
      injectSeat: (collabId, sessionId, frame) => inject.inject(collabId, sessionId, frame),
      sessionGate: (frame, meta) => {
        gateCalls.push({ type: frame.type, sessionId: meta.sessionId });
        return gateHook(frame, meta.sessionId);
      },
      ...hooks,
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  return { inbound, dir, dispatch, inject, gateCalls };
}

function frame(overrides = {}) {
  return {
    v: 1,
    cap: COLLAB_CAPABILITY,
    msgId: newMsgId(),
    type: 'reply',
    from: { instanceId: 'inst-peer', identityName: '主机乙', port: 7321, sessionId: 'sess-peer' },
    collabId: 'collab-1',
    ts: new Date().toISOString(),
    payload: { text: '你好' },
    ...overrides,
  };
}

function readInbox(dir, collabId = 'collab-1') {
  return readFileSync(join(dir, COLLABS_DIR_NAME, collabId, INBOX_FILE_NAME), 'utf8')
    .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function reportsOf(dispatch) {
  return dispatch.calls.sends.filter((message) => message.type === 'delivery-status');
}

test('toSessions：一机两席只注入列表内席位，回报仍是一条机器级 delivery-status', async (t) => {
  const { inbound, dispatch, inject } = makeInbound(t);
  const connection = createFakeConnection();
  const sent = frame({ toSessions: ['sess-b1', 'sess-b2'] });
  inbound.onFrame(connection, sent);
  await waitFor(() => reportsOf(dispatch).length === 1);

  assert.deepEqual(inject.calls.map((call) => call.sessionId), ['sess-b1', 'sess-b2']);
  assert.equal(connection.sent.filter((entry) => entry.type === 'ack').length, 1, '一帧只回一次传输 ack');
  const reports = reportsOf(dispatch);
  assert.equal(reports.length, 1, '机器级回报只有一条');
  assert.deepEqual(reports[0].payload, { refMsgId: sent.msgId, tier: 'session' });
  assert.equal(reports[0].collabId, 'collab-1');
});

test('toSessions：只投列表内席位；列表中的非本机目标丢弃并计数，不把整帧投给其他席位', async (t) => {
  const { inbound, dir, dispatch, inject } = makeInbound(t);
  inbound.onFrame(createFakeConnection(), frame({ toSessions: ['sess-b1', 'sess-remote'] }));
  await waitFor(() => reportsOf(dispatch).length === 1);

  assert.deepEqual(inject.calls.map((call) => call.sessionId), ['sess-b1']);
  assert.equal(inbound.stats().fanoutDropped, 1);
  const records = readInbox(dir);
  assert.deepEqual(records.at(-1).fanout.dropped, ['sess-remote']);
});

test('缺省 toSessions：按本机活跃席位扇出（joining 席位不投；邀请帧例外不按活跃过滤）', async (t) => {
  const seats = [seat('sess-b1'), seat('sess-b2'), seat('sess-join', 'joining')];
  const { inbound, dispatch, inject } = makeInbound(t, { seats });
  inbound.onFrame(createFakeConnection(), frame());
  await waitFor(() => reportsOf(dispatch).length === 1);
  assert.deepEqual(inject.calls.map((call) => call.sessionId), ['sess-b1', 'sess-b2']);

  const second = makeInjector();
  const invite = makeInbound(t, { seats, injector: second });
  invite.inbound.onFrame(createFakeConnection(), frame({ type: 'invite', payload: { targets: [] } }));
  await waitFor(() => reportsOf(invite.dispatch).length === 1);
  assert.deepEqual(second.calls.map((call) => call.sessionId), ['sess-b1', 'sess-b2', 'sess-join']);
});

test('重复帧：已完成的席位跳过，未完成席位补扇出并重发机器级回报（幂等）', async (t) => {
  let failed = false;
  const injector = makeInjector({
    'sess-b2': () => {
      if (!failed) {
        failed = true;
        throw new Error('桥暂不可用');
      }
      return { ok: true, delivered: true };
    },
  });
  const { inbound, dispatch } = makeInbound(t, { injector });
  const duplicate = frame({ toSessions: ['sess-b1', 'sess-b2'] });
  inbound.onFrame(createFakeConnection(), duplicate);
  await waitFor(() => inbound.stats().duplicates === 0 && inbound.stats().accepted === 1);
  await waitFor(() => injector.calls.length >= 2);

  const firstPass = injector.calls.map((call) => call.sessionId);
  assert.deepEqual(firstPass, ['sess-b1', 'sess-b2'], '首轮：b1 成功后 b2 失败（保留待补）');
  assert.equal(inbound.localSeatDeliveryOf(duplicate.msgId, 'sess-b2').status, 'pending');
  assert.equal(reportsOf(dispatch).length, 1, '首轮已有成功席位：机器级回报照发');

  inbound.onFrame(createFakeConnection(), duplicate);
  await waitFor(() => reportsOf(dispatch).length === 2);
  assert.deepEqual(injector.calls.map((call) => call.sessionId), ['sess-b1', 'sess-b2', 'sess-b2'], '重复帧只补未完成席位');
  assert.equal(inbound.stats().duplicates, 1);
  assert.equal(inbound.stats().fanoutResumed, 1);
  assert.equal(inbound.localSeatDeliveryOf(duplicate.msgId, 'sess-b1').status, 'injected');
  assert.equal(inbound.localSeatDeliveryOf(duplicate.msgId, 'sess-b2').status, 'injected');
});

test('暂存：本机桥离线由注入面暂存，按成功扇出计并回报；席位明细可查 staged', async (t) => {
  const injector = makeInjector({ 'sess-b1': { ok: true, staged: true } });
  const { inbound, dispatch } = makeInbound(t, { seats: [seat('sess-b1')], injector });
  const sent = frame({ toSessions: ['sess-b1'] });
  inbound.onFrame(createFakeConnection(), sent);
  await waitFor(() => reportsOf(dispatch).length === 1);
  assert.equal(inbound.stats().fanoutStaged, 1);
  assert.equal(inbound.localSeatDeliveryOf(sent.msgId, 'sess-b1').status, 'staged');
  assert.equal(inbound.checkInbox({ collabId: 'collab-1', sessionId: 'sess-b1' }).total, 1);
  assert.equal(inbound.checkInbox({ collabId: 'collab-1', sessionId: 'sess-b2' }).total, 0, '非目标席位不可见');
});

test('逐席静音：同机一站长一成员时按收件席位分别判定', async (t) => {
  const seats = [seat('sess-mgr', 'member', { role: 'manager' }), seat('sess-mem')];
  const { inbound, dispatch, inject, gateCalls } = makeInbound(t, {
    seats,
    gate: (frame, sessionId) => ({ suppress: sessionId === 'sess-mem' }),
  });
  inbound.onFrame(createFakeConnection(), frame({ toSessions: ['sess-mgr', 'sess-mem'] }));
  await waitFor(() => reportsOf(dispatch).length === 1);

  assert.deepEqual(gateCalls.map((call) => call.sessionId), ['sess-mgr', 'sess-mem']);
  assert.deepEqual(inject.calls.map((call) => call.sessionId), ['sess-mgr'], '静音席位不注入、未静音席位照常注入');
  assert.equal(inbound.stats().fanoutGated, 1);
  assert.equal(inbound.localSeatDeliveryOf(inbound.checkInbox({ collabId: 'collab-1' }).messages[0].msgId, 'sess-mem').status, 'gated');
});

test('治理事件豁免静音：invite / leave / end / freeze / manager-changed 不调用静音栅栏', async (t) => {
  const { inbound, gateCalls } = makeInbound(t, {
    gate: () => ({ suppress: true }),
  });
  const types = [
    { type: 'invite', payload: { targets: [] } },
    { type: 'leave', payload: {} },
    { type: 'end', payload: {} },
    { type: 'freeze', payload: { name: 'x', members: [] } },
    { type: 'notice', payload: { event: 'manager-changed' } },
    { type: 'notice', payload: { event: 'auto-offer' } },
  ];
  for (const override of types) {
    inbound.onFrame(createFakeConnection(), frame({ ...override, msgId: newMsgId() }));
  }
  await waitFor(() => inbound.stats().accepted === types.length);
  assert.deepEqual(gateCalls, [], '治理事件不受静音抑制');
});

test('from.sessionId：cap=2 协作帧缺失或非法即拒收（不落盘、不 ack）', async (t) => {
  const { inbound, dir, dispatch, inject } = makeInbound(t);
  const missing = frame();
  delete missing.from.sessionId;
  const malformed = frame({ from: { ...missing.from, sessionId: 'bad id!' } });
  const connection = createFakeConnection();
  inbound.onFrame(connection, missing);
  inbound.onFrame(connection, malformed);
  await waitFor(() => inbound.stats().fromSessionRejected === 2);

  assert.deepEqual(connection.sent, [], '未通过帧身份校验：不 ack');
  assert.equal(inject.calls.length, 0);
  assert.equal(dispatch.calls.reports.length, 0);
  assert.throws(() => readInbox(dir));
});

test('写门：只读目录（legacy / recovery / corrupt）的入站帧拒绝并计数，不落盘不 ack', async (t) => {
  const { inbound, dir, inject } = makeInbound(t, {
    hooks: { assertWritable: () => ({ ok: false, reason: 'corrupt' }) },
  });
  const connection = createFakeConnection();
  inbound.onFrame(connection, frame());
  await waitFor(() => inbound.stats().readonlyInboundRejected === 1);
  assert.deepEqual(connection.sent, []);
  assert.equal(inject.calls.length, 0);
  assert.throws(() => readInbox(dir));

  const { inbound: throwing } = makeInbound(t, {
    hooks: { assertWritable: () => { throw new Error('写门不可用'); } },
  });
  throwing.onFrame(createFakeConnection(), frame());
  await waitFor(() => throwing.stats().readonlyInboundRejected === 1, { timeoutMs: 3000 });
});

test('传输帧豁免：ping/pong/ack 的 from 不需要 sessionId', async (t) => {
  const { inbound } = makeInbound(t);
  const connection = createFakeConnection();
  inbound.onFrame(connection, { v: 1, type: 'ping', msgId: newMsgId(), from: { instanceId: 'inst-peer', identityName: '乙' }, ts: new Date().toISOString() });
  await waitFor(() => connection.sent.length === 1);
  assert.equal(connection.sent[0].type, 'pong');
  assert.equal(inbound.stats().fromSessionRejected, 0);
});

test('checkInbox：按调用会话过滤（目标席位可见，机器级治理提示对全席可见）', async (t) => {
  const { inbound, dispatch } = makeInbound(t);
  inbound.onFrame(createFakeConnection(), frame({ toSessions: ['sess-b1'] }));
  await waitFor(() => reportsOf(dispatch).length === 1);
  inbound.onFrame(createFakeConnection(), frame({ type: 'freeze', payload: { name: 'x', members: [] } }));
  await waitFor(() => inbound.stats().accepted === 2);

  assert.equal(inbound.checkInbox({ collabId: 'collab-1' }).total, 2);
  assert.equal(inbound.checkInbox({ collabId: 'collab-1', sessionId: 'sess-b1' }).total, 2, '席位列内的消息 + 机器级治理提示');
  assert.equal(inbound.checkInbox({ collabId: 'collab-1', sessionId: 'sess-b2' }).total, 1, '只有机器级治理提示');
  assert.throws(() => inbound.checkInbox({ collabId: 'collab-1', sessionId: 'bad id!' }), TypeError);
});

test('toSessions 坏输入整帧拒绝：不 ack、不落盘、不注入，绝不回落为全席广播', async (t) => {
  const { inbound, dir, inject } = makeInbound(t);
  const connection = createFakeConnection();
  const tooMany = Array.from({ length: MAX_ACTIVE_SEATS + 1 }, (_value, index) => `sess-${index}`);
  const samples = ['sess-b1', [], tooMany, [{ sessionId: 'sess-b1' }], [42]];
  for (const toSessions of samples) {
    inbound.onFrame(connection, frame({ toSessions }));
  }
  await waitFor(() => inbound.stats().toSessionsRejected === samples.length);

  assert.deepEqual(connection.sent, [], '坏 toSessions 不确认');
  assert.equal(inject.calls.length, 0, '坏 toSessions 不得退化为按活跃席位扇出');
  assert.equal(inbound.stats().fanoutSeats, 0);
  assert.throws(() => readInbox(dir), '不落盘');
});

test('指名邀请只投目标会话：同机其他席位不注入；未入席目标经可注入目标面可收', async (t) => {
  const seats = [seat('sess-b1'), seat('sess-b2')];
  const { inbound, dispatch, inject } = makeInbound(t, { seats });
  inbound.onFrame(createFakeConnection(), frame({
    type: 'invite',
    payload: { targetSessionId: 'sess-b2', targets: [{ instanceId: 'inst-self', targetSessionId: 'sess-b2' }] },
  }));
  await waitFor(() => reportsOf(dispatch).length === 1);
  assert.deepEqual(inject.calls.map((call) => call.sessionId), ['sess-b2'], '指名邀请只投目标会话');

  const pending = makeInjector();
  const pendingInbound = makeInbound(t, {
    seats: [seat('sess-b1')],
    injector: pending,
    hooks: { listInjectableTargets: () => [{ sessionId: 'sess-new' }] },
  });
  pendingInbound.inbound.onFrame(createFakeConnection(), frame({
    type: 'invite',
    msgId: newMsgId(),
    payload: { targetSessionId: 'sess-new' },
  }));
  await waitFor(() => reportsOf(pendingInbound.dispatch).length === 1);
  assert.deepEqual(pending.calls.map((call) => call.sessionId), ['sess-new'], '受邀未入席会话仍可注入');
});

test('无名邀请且无任何可注入目标：fail-closed 丢弃并计数，不广播', async (t) => {
  const { inbound, dispatch, inject } = makeInbound(t, { seats: [] });
  const sent = frame({ type: 'invite', payload: { targets: [{ instanceId: 'inst-self' }] } });
  inbound.onFrame(createFakeConnection(), sent);
  await waitFor(() => reportsOf(dispatch).length === 1);

  assert.equal(inbound.stats().inviteTargetsUnavailable, 1);
  assert.deepEqual(inject.calls, []);
  const report = reportsOf(dispatch)[0];
  assert.equal(report.from.sessionId, sent.from.sessionId, '零成功回报携原消息的签发席位');
});

test('零成功扇出仍发机器级终态回报：from.sessionId 取原帧发送席位（历史身份）', async (t) => {
  const injector = makeInjector({
    'sess-b1': { ok: false, reason: '桥不可用' },
    'sess-b2': { ok: false, reason: '桥不可用' },
  });
  const { inbound, dispatch } = makeInbound(t, { injector });
  const sent = frame({ toSessions: ['sess-b1', 'sess-b2'] });
  inbound.onFrame(createFakeConnection(), sent);
  await waitFor(() => reportsOf(dispatch).length === 1);

  const report = reportsOf(dispatch)[0];
  assert.equal(report.type, 'delivery-status');
  assert.deepEqual(report.payload, { refMsgId: sent.msgId, tier: 'session' });
  assert.equal(report.from.sessionId, sent.from.sessionId, '零成功不得生成无 sessionId 的回报');
  assert.equal(inbound.stats().fanoutDropped, 2);
});

test('仅暂存（无实际注入）时回报签发席位取原帧发件席位；有注入时取注入席位', async (t) => {
  const stagedOnly = makeInbound(t, {
    seats: [seat('sess-b1')],
    injector: makeInjector({ 'sess-b1': { ok: true, staged: true } }),
  });
  const stagedFrame = frame({ toSessions: ['sess-b1'] });
  stagedOnly.inbound.onFrame(createFakeConnection(), stagedFrame);
  await waitFor(() => reportsOf(stagedOnly.dispatch).length === 1);
  const stagedReport = reportsOf(stagedOnly.dispatch)[0];
  assert.equal(stagedOnly.inbound.localSeatDeliveryOf(stagedFrame.msgId, 'sess-b1').status, 'staged');
  assert.equal(stagedReport.from.sessionId, stagedFrame.from.sessionId, '仅暂存不得用暂存席签发回报');

  const mixed = makeInbound(t, {
    seats: [seat('sess-b1'), seat('sess-b2')],
    injector: makeInjector({ 'sess-b2': { ok: true, staged: true } }),
  });
  const mixedFrame = frame({ toSessions: ['sess-b1', 'sess-b2'] });
  mixed.inbound.onFrame(createFakeConnection(), mixedFrame);
  await waitFor(() => reportsOf(mixed.dispatch).length === 1);
  assert.equal(reportsOf(mixed.dispatch)[0].from.sessionId, 'sess-b1', '有实际注入时用首个注入席位签发');
});

test('吸收重复（帖去重命中）同样发零成功终态回报，携原帧签发席位', async (t) => {
  const { inbound, dispatch } = makeInbound(t, {
    hooks: { consume: () => ({ sessionDeliver: false, wasInjected: true }) },
  });
  const sent = frame({ type: 'post', payload: { post: { postId: 'p-1', seq: 1, kind: 'reply', text: '帖' } } });
  inbound.onFrame(createFakeConnection(), sent);
  await waitFor(() => reportsOf(dispatch).length === 1);

  const report = reportsOf(dispatch)[0];
  assert.deepEqual(report.payload, { refMsgId: sent.msgId, tier: 'session' });
  assert.equal(report.from.sessionId, sent.from.sessionId);
});

test('重复帧载荷不一致：拒绝补扇出并计数；一致的重放复用已存载荷补投', async (t) => {
  let failed = false;
  const injector = makeInjector({
    'sess-b2': () => {
      if (!failed) {
        failed = true;
        throw new Error('桥暂不可用');
      }
      return { ok: true, delivered: true };
    },
  });
  const { inbound } = makeInbound(t, { injector });
  const original = frame({ toSessions: ['sess-b1', 'sess-b2'], payload: { text: 'A' } });
  inbound.onFrame(createFakeConnection(), original);
  await waitFor(() => injector.calls.length >= 2);
  assert.equal(inbound.localSeatDeliveryOf(original.msgId, 'sess-b2').status, 'pending');

  inbound.onFrame(createFakeConnection(), { ...original, payload: { text: 'B' } });
  await waitFor(() => inbound.stats().duplicateMismatch === 1);
  assert.deepEqual(injector.calls.map((call) => call.sessionId), ['sess-b1', 'sess-b2'], '不一致的重复帧不补扇出');

  inbound.onFrame(createFakeConnection(), { ...original, payload: { text: 'A' } });
  await waitFor(() => inbound.stats().fanoutResumed === 1 && injector.calls.length === 3);
  assert.equal(injector.calls.at(-1).payload.text, 'A', '补投使用 inbox 已存载荷，而非重复帧载荷');
  assert.equal(inbound.localSeatDeliveryOf(original.msgId, 'sess-b2').status, 'injected');
});

test('钩子 meta：携带来源地址与传输对端实例标识（frame.from.instanceId）', async (t) => {
  const seen = [];
  const { inbound } = makeInbound(t, {
    hooks: { consume: (_frame, meta) => { seen.push(meta); } },
  });
  inbound.onFrame(createFakeConnection('127.0.0.9'), frame());
  await waitFor(() => seen.length === 1);
  assert.equal(seen[0].remoteAddress, '127.0.0.9');
  assert.equal(seen[0].peerInstanceId, 'inst-peer');
});

test('入站分派：joinId 式 join-grant/join-deny 通过准入并落盘投递；缺 joinId/reqMsgId 拒绝', async (t) => {
  const gateState = { counters: { joinDecisionsRejected: 0 } };
  const { inbound, dir, dispatch, inject } = makeInbound(t, {
    hooks: { admit: (frame) => decideAdmission(gateState, frame, {}) },
  });
  const connection = createFakeConnection();
  const grant = frame({
    type: 'join-grant',
    payload: { joinId: 'join-1', sessionId: 'sess-b1', manager: { instanceId: 'inst-peer', sessionId: 'sess-peer', identityName: '主机乙' }, managerTerm: 1, version: 2 },
  });
  inbound.onFrame(connection, grant);
  await waitFor(() => reportsOf(dispatch).length === 1);
  assert.equal(connection.sent.filter((entry) => entry.type === 'ack').length, 1, 'joinId 式回执被受理并确认');
  assert.deepEqual(inject.calls.map((call) => call.sessionId), ['sess-b1', 'sess-b2']);
  assert.equal(readInbox(dir).at(-1).payload.joinId, 'join-1');

  const invalid = frame({ type: 'join-deny', payload: { reason: 'expired' } });
  inbound.onFrame(connection, invalid);
  await waitFor(() => gateState.counters.joinDecisionsRejected === 1);
  assert.equal(connection.sent.filter((entry) => entry.type === 'ack').length, 1, '缺凭据的回执不确认');
});

test('指名邀请的 targetSessionId 非法：整帧拒绝并计数（不得退化为不指名邀请）', async (t) => {
  const { inbound, dir, dispatch, inject } = makeInbound(t);
  const connection = createFakeConnection();
  inbound.onFrame(connection, frame({ type: 'invite', payload: { targetSessionId: { bad: true } } }));
  await waitFor(() => inbound.stats().inviteTargetRejected === 1);

  assert.deepEqual(connection.sent, []);
  assert.deepEqual(inject.calls, []);
  assert.equal(reportsOf(dispatch).length, 0);
  assert.throws(() => readInbox(dir));
});
