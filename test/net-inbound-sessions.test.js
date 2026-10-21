import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COLLABS_DIR_NAME } from '../src/paths.js';
import { COLLAB_CAPABILITY, MAX_ACTIVE_SEATS, newMsgId, validateMessage } from '../src/net/protocol.js';
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

test('toSessions/指名短码：唯一短码先解析为全量标识再扇出，歧义短码原样丢弃', async (t) => {
  const seats = [seat('abcd1234-one'), seat('abcd1234-two'), seat('zzzz9999-solo')];
  const unique = makeInbound(t, { seats });
  unique.inbound.onFrame(createFakeConnection(), frame({ toSessions: ['zzzz9999'] }));
  await waitFor(() => reportsOf(unique.dispatch).length === 1);
  assert.deepEqual(unique.inject.calls.map((call) => call.sessionId), ['zzzz9999-solo']);

  const ambiguous = makeInbound(t, { seats });
  ambiguous.inbound.onFrame(createFakeConnection(), frame({ toSessions: ['abcd1234'] }));
  await waitFor(() => reportsOf(ambiguous.dispatch).length === 1);
  assert.deepEqual(ambiguous.inject.calls, [], '歧义短码不得放大投递');
  assert.equal(ambiguous.inbound.stats().fanoutDropped, 1);

  const named = makeInbound(t, { seats });
  named.inbound.onFrame(createFakeConnection(), frame({ type: 'invite', payload: { targetSessionId: 'zzzz9999' } }));
  await waitFor(() => reportsOf(named.dispatch).length === 1);
  assert.deepEqual(named.inject.calls.map((call) => call.sessionId), ['zzzz9999-solo']);
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

test('邀请准入：members 只含发起人、targets 含目标机 → 受理并只投指名会话', async (t) => {
  const gateState = gateStateOf();
  const { inbound, dispatch, inject } = makeInbound(t, {
    hooks: { admit: (gateFrame) => decideAdmission(gateState, gateFrame, { remoteAddress: '127.0.0.2' }) },
  });
  const invitation = frame({
    type: 'invite',
    payload: {
      name: '联调项目',
      topic: '发布联调',
      members: [{ instanceId: 'inst-peer', sessionId: 'sess-peer', identityName: '主机乙' }],
      targets: [{ instanceId: SELF.instanceId, targetSessionId: 'sess-b1' }],
      targetSessionId: 'sess-b1',
    },
  });
  assert.equal(validateMessage(invitation).ok, true, '真实邀请帧须过协议校验');
  inbound.onFrame(createFakeConnection(), invitation);
  await waitFor(() => reportsOf(dispatch).length === 1);
  assert.equal(inbound.stats().rejected.admission, 0, 'targets 含本机即准入，不要求 members 含本机');
  assert.deepEqual(inject.calls.map((call) => call.sessionId), ['sess-b1'], '指名邀请只投目标会话');
});

test('邀请准入：无 targets 的旧版邀请按 members 含本机受理；members 不含本机则拒', async (t) => {
  const gateState = gateStateOf();
  const { inbound, dispatch, inject } = makeInbound(t, {
    hooks: { admit: (gateFrame) => decideAdmission(gateState, gateFrame, { remoteAddress: '127.0.0.3' }) },
  });
  const legacy = frame({
    type: 'invite',
    payload: {
      name: '联调项目',
      topic: '发布联调',
      members: [
        { instanceId: 'inst-peer', sessionId: 'sess-peer', identityName: '主机乙' },
        { instanceId: SELF.instanceId, sessionId: 'sess-b1', identityName: SELF.identityName },
      ],
    },
  });
  inbound.onFrame(createFakeConnection(), legacy);
  await waitFor(() => reportsOf(dispatch).length === 1);
  assert.equal(inbound.stats().rejected.admission, 0, '旧版名单判据：members 含本机即受理');
  assert.deepEqual(inject.calls.map((call) => call.sessionId), ['sess-b1', 'sess-b2']);

  const missingSelf = frame({
    type: 'invite',
    msgId: newMsgId(),
    payload: {
      name: '联调项目',
      topic: '发布联调',
      members: [{ instanceId: 'inst-peer', sessionId: 'sess-peer', identityName: '主机乙' }],
    },
  });
  const connection = createFakeConnection();
  inbound.onFrame(connection, missingSelf);
  await waitFor(() => gateState.counters.invitesRejected === 1);
  assert.deepEqual(connection.sent, [], '无 targets 且名单不含本机：不确认');
  assert.equal(inject.calls.length, 2, '拒绝帧不注入任何席位');
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

test('seat-presence：consume 声明不投会话即抑制注入（机器级心跳不进会话）', async (t) => {
  const { inbound, dispatch, inject } = makeInbound(t, {
    hooks: { consume: () => ({ sessionDeliver: false }) },
  });
  const connection = createFakeConnection();
  const presence = frame({ type: 'seat-presence', payload: { instanceId: 'inst-peer', at: Date.now(), sessions: ['sess-peer'] } });
  inbound.onFrame(connection, presence);
  await waitFor(() => inbound.stats().accepted === 1);

  assert.equal(connection.sent.filter((entry) => entry.type === 'ack').length, 1, '心跳照常确认');
  assert.deepEqual(inject.calls, [], '不得把心跳注入任何会话');
  assert.equal(inbound.stats().sessionSuppressed >= 1, true);
  await waitFor(() => reportsOf(dispatch).length === 1);
});

test('seat-presence：forum 准入白名单放行（讨论心跳不被类型语义拒）', () => {
  const local = { collabId: 'collab-1', role: 'member', member: { state: 'active', mode: 'forum' } };
  const state = gateStateOf({ collabs: new Map([['collab-1', local]]) });
  const decision = decideAdmission(state, frame({ type: 'seat-presence', payload: { instanceId: 'inst-peer' } }), {});
  assert.equal(decision.ok, true, decision.reason);
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

test('钩子 meta：peerInstanceId 只取连接层盖章，帧内伪造 from 不自证', async (t) => {
  const seen = [];
  const { inbound } = makeInbound(t, {
    hooks: { consume: (_frame, meta) => { seen.push(meta); } },
  });
  const stamped = createFakeConnection('127.0.0.9');
  stamped.peerInstanceId = 'inst-b';
  inbound.onFrame(stamped, frame());
  await waitFor(() => seen.length === 1);
  assert.equal(seen[0].remoteAddress, '127.0.0.9');
  assert.equal(seen[0].peerInstanceId, 'inst-b', '连接层身份优先，不采信帧内 inst-peer');

  const unstamped = createFakeConnection('127.0.0.10');
  inbound.onFrame(unstamped, frame({ msgId: newMsgId(), from: { instanceId: 'inst-impostor', identityName: '冒名者', port: 7321, sessionId: 'sess-x' } }));
  await waitFor(() => seen.length === 2);
  assert.equal(seen[1].remoteAddress, '127.0.0.10');
  assert.equal('peerInstanceId' in seen[1], false, '连接层未给身份时省略（下游 fail-closed），不得用帧内 from 补');
});

/* 准入门夹具：只摆本族判定读取的字段（申请台账 / 本机协作 / 各计数与时限）。 */
function gateStateOf({ applications = [], collabs = new Map(), pendingJoins = [], ttlMs = 60000 } = {}) {
  return {
    self: SELF,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    counters: { joinDecisionsRejected: 0, joinRequestsRejected: 0, unknownCollab: 0, invitesRejected: 0 },
    collabs,
    joinRequestWindow: new Map(),
    inviteWindow: new Map(),
    inviteMinIntervalMs: 0,
    joinRequestTtlMs: ttlMs,
    joinApplications: { list: () => applications },
    pendingJoinsOf: () => pendingJoins,
  };
}

function applicationOf(overrides = {}) {
  return {
    collabId: 'collab-1',
    sessionId: 'sess-b1',
    managerInstanceId: 'inst-peer',
    msgId: 'invite-accept-1',
    sentAt: Date.now(),
    ...overrides,
  };
}

function joinGrantOf(overrides = {}) {
  return frame({
    type: 'join-grant',
    payload: {
      joinId: 'join-1',
      sessionId: 'sess-b1',
      manager: { instanceId: 'inst-peer', sessionId: 'sess-peer', identityName: '主机乙' },
      managerTerm: 1,
      version: 2,
    },
    ...overrides,
  });
}

function joiningLocalOf({ joinId = 'join-1', managerInstanceId = 'inst-peer', sessionId = 'sess-b1' } = {}) {
  const local = {
    collabId: 'collab-1',
    role: 'member',
    member: { state: 'active', manager: { instanceId: managerInstanceId, identityName: '主机乙' } },
    seats: new Map([[sessionId, { sessionId, role: 'member', state: 'member', unverified: true, joinId }]]),
  };
  return new Map([['collab-1', local]]);
}

test('joinId 式 grant：无本机申请 / 无入席记录一律拒——未知 collab 不建目录、不 ack、不落盘、不注入', async (t) => {
  const gateState = gateStateOf();
  const { inbound, dir, dispatch, inject } = makeInbound(t, {
    hooks: { admit: (gateFrame) => decideAdmission(gateState, gateFrame, {}) },
  });
  const connection = createFakeConnection();
  inbound.onFrame(connection, joinGrantOf());
  await waitFor(() => gateState.counters.joinDecisionsRejected === 1);

  assert.deepEqual(connection.sent, [], '无本地权威证据的回执不确认');
  assert.deepEqual(inject.calls, [], '不得注入任何席位（不得把未知 collab 注入两席）');
  assert.equal(reportsOf(dispatch).length, 0, '不得产生终态回报');
  assert.equal(inbound.stats().accepted, 0);
  assert.throws(() => readInbox(dir), '不得为未知 collabId 建目录落盘');

  const deny = frame({ type: 'join-deny', payload: { joinId: 'join-1', reason: 'expired' } });
  inbound.onFrame(connection, deny);
  await waitFor(() => gateState.counters.joinDecisionsRejected === 2);
  assert.deepEqual(connection.sent, [], '未知 collab 的 join-deny 同样不确认');
  assert.throws(() => readInbox(dir));
});

test('joinId 式 grant：本机待处理申请匹配（collab+站长实例+申请人会话）才受理并落盘投递', async (t) => {
  const gateState = gateStateOf({ applications: [applicationOf()] });
  const { inbound, dir, dispatch, inject } = makeInbound(t, {
    hooks: { admit: (gateFrame) => decideAdmission(gateState, gateFrame, {}) },
  });
  const connection = createFakeConnection();
  const grant = joinGrantOf();
  inbound.onFrame(connection, grant);
  await waitFor(() => reportsOf(dispatch).length === 1);

  assert.equal(connection.sent.filter((entry) => entry.type === 'ack').length, 1, '匹配申请的回执确认');
  assert.deepEqual(inject.calls.map((call) => call.sessionId), ['sess-b1', 'sess-b2']);
  assert.equal(readInbox(dir).at(-1).payload.joinId, 'join-1');
  assert.equal(gateState.counters.joinDecisionsRejected, 0);
});

test('joinId 式 grant：已签发的入席记录（同 joinId）是重复副本的本地凭据', async (t) => {
  const gateState = gateStateOf({ collabs: joiningLocalOf() });
  const { inbound, dispatch } = makeInbound(t, {
    hooks: { admit: (gateFrame) => decideAdmission(gateState, gateFrame, {}) },
  });
  inbound.onFrame(createFakeConnection(), joinGrantOf());
  await waitFor(() => reportsOf(dispatch).length === 1);
  assert.equal(gateState.counters.joinDecisionsRejected, 0);
});

test('joinId 式 grant：自报本机来源的远端帧不得借用站长侧待批准台账（仅核内旁路认）', () => {
  const state = gateStateOf({ pendingJoins: [{ instanceId: SELF.instanceId, sessionId: 'sess-b1', requestedAt: Date.now() }] });
  const grant = joinGrantOf({
    from: { instanceId: SELF.instanceId, identityName: SELF.identityName, port: 7321, sessionId: 'sess-local' },
  });
  assert.equal(decideAdmission(state, grant, { remoteAddress: '10.0.0.9' }).ok, false, '远端自报 from=本机不得借用站长侧台账');
  assert.equal(state.counters.joinDecisionsRejected, 1);
  assert.equal(decideAdmission(state, grant, { remoteAddress: 'local' }).ok, true, '核内旁路（remoteAddress=local）才认待批准台账');
});

test('joinId 式回执：冒名站长 / 过期申请 / 会话不符 / 异 joinId 入席记录一律拒并计数', () => {
  const cases = [
    { name: '冒名站长（申请指向 inst-peer）', state: gateStateOf({ applications: [applicationOf()] }), grant: joinGrantOf({ from: { instanceId: 'inst-impostor', identityName: '冒名者', port: 7321, sessionId: 'sess-x' } }) },
    { name: '申请已过期', state: gateStateOf({ applications: [applicationOf({ sentAt: Date.now() - 60001 })] }), grant: joinGrantOf() },
    { name: '申请人会话不符', state: gateStateOf({ applications: [applicationOf({ sessionId: 'sess-other' })] }), grant: joinGrantOf() },
    { name: '入席记录 joinId 不符', state: gateStateOf({ collabs: joiningLocalOf({ joinId: 'join-other' }) }), grant: joinGrantOf() },
    { name: '入席记录的站长不符', state: gateStateOf({ collabs: joiningLocalOf({ managerInstanceId: 'inst-other' }) }), grant: joinGrantOf() },
  ];
  for (const { name, state, grant } of cases) {
    const rejected = decideAdmission(state, grant, {});
    assert.equal(rejected.ok, false, name);
    assert.equal(state.counters.joinDecisionsRejected, 1, name);
  }
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

/* —— 并发重复帧（C1）与重启一致性（I1/I2 入站侧） —— */

test('并发重复帧：同一 msgId 经两条连接同时到达时扇出单飞，每席只注入一次、outcomes 无脏键', { timeout: 15000 }, async (t) => {
  const calls = [];
  const injector = {
    async inject(collabId, sessionId, frame) {
      calls.push({ collabId, sessionId, msgId: frame.msgId });
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { ok: true, delivered: true };
    },
  };
  const { inbound, dir, dispatch } = makeInbound(t, { injector });
  const sent = frame({ toSessions: ['sess-b1', 'sess-b2'] });
  inbound.onFrame(createFakeConnection('127.0.0.2'), sent);
  inbound.onFrame(createFakeConnection('127.0.0.3'), sent);
  await waitFor(() => inbound.localSeatDeliveryOf(sent.msgId, 'sess-b1').status === 'injected'
    && inbound.localSeatDeliveryOf(sent.msgId, 'sess-b2').status === 'injected');
  await waitFor(() => reportsOf(dispatch).length >= 1);
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.deepEqual(calls.map((call) => call.sessionId).sort(), ['sess-b1', 'sess-b2'], '每席只注入一次');
  assert.equal(calls.every((call) => call.msgId === sent.msgId), true);
  const record = readInbox(dir).filter((entry) => entry.msgId === sent.msgId).at(-1);
  assert.deepEqual(Object.keys(record.fanout.outcomes).sort(), ['sess-b1', 'sess-b2'], 'outcomes 键集合等于目标集');
  assert.equal(Object.keys(record.fanout.outcomes).includes('undefined'), false, '不得产生 undefined 键');
  assert.deepEqual(record.fanout.done.sort(), ['sess-b1', 'sess-b2']);
  assert.deepEqual(record.fanout.pending, []);
  assert.equal(record.fanout.complete, true);
});

/* 可控的异步闸门与微任务排空：并发窗口由用例显式放行，不靠 sleep 赌时序。 */
function deferredOf() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function drainMicrotasks(turns = 60) {
  for (let index = 0; index < turns; index++) {
    await Promise.resolve();
  }
}

test('并发重复帧：consume 未返回前到达的重复帧不得抢先扇出（抑制在途窗口）', { timeout: 15000 }, async (t) => {
  const consumeGate = deferredOf();
  const { inbound, dir, dispatch, inject, gateCalls } = makeInbound(t, {
    hooks: {
      consume: async () => {
        await consumeGate.promise;
        return { sessionDeliver: false, wasInjected: true };
      },
    },
  });
  const sent = frame({ type: 'post', payload: { postId: 'post-dedup-window', kind: 'text', text: '去重帖' }, toSessions: ['sess-b1', 'sess-b2'] });
  inbound.onFrame(createFakeConnection('127.0.0.2'), sent);
  inbound.onFrame(createFakeConnection('127.0.0.3'), sent);
  await waitFor(() => inbound.stats().duplicates === 1);
  await drainMicrotasks();

  assert.deepEqual(gateCalls, [], '首份副本 consume 未返回时，重复帧不得进入扇出（静音栅栏也不得触达）');
  assert.deepEqual(inject.calls, [], '抑制裁定前不得注入任何席位');

  consumeGate.resolve();
  await waitFor(() => reportsOf(dispatch).length >= 2);
  assert.deepEqual(inject.calls, [], 'consume 声明抑制后整帧不注入');
  const record = readInbox(dir).filter((entry) => entry.msgId === sent.msgId).at(-1);
  assert.deepEqual(record.fanout.pending, []);
  assert.deepEqual(record.fanout.done, []);
  assert.deepEqual(record.fanout.outcomes, {}, '抑制帧不留下任何注入结果');
  assert.equal(record.fanout.complete, true);
});

test('并发重复帧：consume 返回后只扇出一轮，注入结果全部落账', { timeout: 15000 }, async (t) => {
  const consumeGate = deferredOf();
  const { inbound, dir, dispatch, inject, gateCalls } = makeInbound(t, {
    hooks: {
      consume: async () => {
        await consumeGate.promise;
        return {};
      },
    },
  });
  const sent = frame({ toSessions: ['sess-b1', 'sess-b2'] });
  inbound.onFrame(createFakeConnection('127.0.0.2'), sent);
  inbound.onFrame(createFakeConnection('127.0.0.3'), sent);
  await waitFor(() => inbound.stats().duplicates === 1);
  await drainMicrotasks();
  assert.deepEqual(gateCalls, [], 'consume 未返回前不得开始扇出');
  assert.deepEqual(inject.calls, [], 'consume 未返回前不得注入');

  consumeGate.resolve();
  await waitFor(() => reportsOf(dispatch).length >= 1);
  await waitFor(() => inbound.localSeatDeliveryOf(sent.msgId, 'sess-b1').status === 'injected'
    && inbound.localSeatDeliveryOf(sent.msgId, 'sess-b2').status === 'injected');
  await drainMicrotasks();
  assert.deepEqual(inject.calls.map((call) => call.sessionId).sort(), ['sess-b1', 'sess-b2'], '每席只注入一次');
  const record = readInbox(dir).filter((entry) => entry.msgId === sent.msgId).at(-1);
  assert.deepEqual(Object.keys(record.fanout.outcomes).sort(), ['sess-b1', 'sess-b2'], '注入结果全部落账');
  assert.deepEqual(record.fanout.pending, []);
  assert.equal(record.fanout.complete, true);
});

test('checkInbox 重启一致性：seatMode 扇出多行折叠为每 msgId 一条，进程内与重启后逐字段相等', { timeout: 15000 }, async (t) => {
  const dir = makeTempDir(t);
  const first = makeInbound(t, { dataDir: dir, seats: [seat('sess-b1'), seat('sess-b2')] });
  const sent = frame({ toSessions: ['sess-b1', 'sess-b2'] });
  first.inbound.onFrame(createFakeConnection(), sent);
  await waitFor(() => reportsOf(first.dispatch).length === 1);
  await waitFor(() => first.inbound.localSeatDeliveryOf(sent.msgId, 'sess-b2').status === 'injected');
  const before = first.inbound.checkInbox({ collabId: 'collab-1' });
  assert.ok(readInbox(dir).length >= 4, '扇出进度为同一 msgId 追加多行');

  const restarted = makeInbound(t, { dataDir: dir });
  const after = restarted.inbound.checkInbox({ collabId: 'collab-1' });
  assert.deepEqual(after, before, '同一查询在进程内与重启后结果一致');
  assert.equal(after.total, 1, '同一 msgId 不得因多行被重复计数');
});

test('localSeatDeliveryOf 重启后按需载盘：未载入的收件流水也给出收件席明细', { timeout: 15000 }, async (t) => {
  const dir = makeTempDir(t);
  const first = makeInbound(t, { dataDir: dir, seats: [seat('sess-b1')] });
  const sent = frame({ toSessions: ['sess-b1'] });
  first.inbound.onFrame(createFakeConnection(), sent);
  await waitFor(() => first.inbound.localSeatDeliveryOf(sent.msgId, 'sess-b1').status === 'injected');

  /* 新实例未接收任何帧（state.boxes 为空）——查询必须自行折叠载入盘上收件流水。 */
  const restarted = makeInbound(t, { dataDir: dir });
  const detail = restarted.inbound.localSeatDeliveryOf(sent.msgId, 'sess-b1');
  assert.equal(detail.collabId, 'collab-1');
  assert.equal(detail.status, 'injected');
  assert.equal(detail.complete, true);
  assert.deepEqual(restarted.inbound.localSeatDeliveryOf('msg-unknown-1', 'sess-b1'), {
    collabId: null, msgId: 'msg-unknown-1', sessionId: 'sess-b1', status: 'unknown', complete: false,
  });
  assert.throws(() => restarted.inbound.localSeatDeliveryOf('', 'sess-b1'), TypeError);
});

/* —— 本机投递账必须经收件盒写入（append 与 seen 一致） —— */

test('本机投递账：已载入的收件盒立即看到写入行，重启前后 checkInbox 逐字段一致', { timeout: 15000 }, async (t) => {
  const dir = makeTempDir(t);
  const first = makeInbound(t, { dataDir: dir, seats: [seat('sess-b1'), seat('sess-b2')] });
  first.inbound.onFrame(createFakeConnection(), frame({ toSessions: ['sess-b1', 'sess-b2'] }));
  await waitFor(() => reportsOf(first.dispatch).length === 1);

  const local = frame({ msgId: 'msg-local-visible', payload: { text: '本机旁路' } });
  assert.equal(first.inbound.noteLocalDelivery({ collabId: 'collab-1', sessionId: 'sess-b1', frame: local, outcome: 'injected' }), true);
  const before = first.inbound.checkInbox({ collabId: 'collab-1' });
  assert.equal(before.total, 2, '已载入的收件盒必须包含本机投递行');
  assert.equal(before.messages.some((record) => record.msgId === 'msg-local-visible'), true);
  const visible = first.inbound.checkInbox({ collabId: 'collab-1', sessionId: 'sess-b1' });
  assert.equal(visible.messages.some((record) => record.msgId === 'msg-local-visible'), true, '目标席位可见');
  const hidden = first.inbound.checkInbox({ collabId: 'collab-1', sessionId: 'sess-b2' });
  assert.equal(hidden.messages.some((record) => record.msgId === 'msg-local-visible'), false, '非目标席位不可见');
  assert.equal(first.inbound.localSeatDeliveryOf('msg-local-visible', 'sess-b1').status, 'injected');

  const restarted = makeInbound(t, { dataDir: dir });
  assert.deepEqual(restarted.inbound.checkInbox({ collabId: 'collab-1' }), before, '进程内与重启后逐字段一致');
});

test('本机投递账：同一 msgId 的多席写入合并为一份快照，后写胜口径不丢前席结果', async (t) => {
  const dir = makeTempDir(t);
  const first = makeInbound(t, { dataDir: dir, seats: [] });
  const local = frame({ msgId: 'msg-local-two-seats', payload: { text: '双席' } });
  assert.equal(first.inbound.noteLocalDelivery({ collabId: 'collab-1', sessionId: 'sess-b1', frame: local, outcome: 'injected' }), true);
  assert.equal(first.inbound.noteLocalDelivery({ collabId: 'collab-1', sessionId: 'sess-b2', frame: local, outcome: 'staged' }), true);
  const inbox = first.inbound.checkInbox({ collabId: 'collab-1' });
  assert.equal(inbox.total, 1);
  assert.deepEqual(Object.keys(inbox.messages[0].fanout.outcomes).sort(), ['sess-b1', 'sess-b2']);
  assert.equal(inbox.messages[0].fanout.complete, true);

  const restarted = makeInbound(t, { dataDir: dir });
  assert.equal(restarted.inbound.localSeatDeliveryOf('msg-local-two-seats', 'sess-b1').status, 'injected');
  assert.equal(restarted.inbound.localSeatDeliveryOf('msg-local-two-seats', 'sess-b2').status, 'staged');
  assert.deepEqual(restarted.inbound.checkInbox({ collabId: 'collab-1' }), inbox, '折叠后与进程内一致');
});

test('本机投递账：入站扇出注入不另写本机账（受理记录已由扇出循环维护）', { timeout: 15000 }, async (t) => {
  let made = null;
  const injector = {
    async inject(collabId, sessionId, frame) {
      /* 模拟服务注入口：每次注入都会回调本机投递账写面。 */
      made.inbound.noteLocalDelivery({ collabId, sessionId, frame, outcome: 'injected' });
      return { ok: true, delivered: true };
    },
  };
  made = makeInbound(t, { injector });
  const sent = frame({ toSessions: ['sess-b1', 'sess-b2'] });
  made.inbound.onFrame(createFakeConnection(), sent);
  await waitFor(() => reportsOf(made.dispatch).length === 1);
  assert.equal(made.inbound.localSeatDeliveryOf(sent.msgId, 'sess-b2').status, 'injected');

  const lines = readInbox(made.dir).filter((entry) => entry.msgId === sent.msgId);
  assert.equal(lines.some((entry) => entry.local === true), false, '不得为入站受理记录另写本机账快照');
  assert.deepEqual(Object.keys(lines.at(-1).fanout.outcomes).sort(), ['sess-b1', 'sess-b2']);
  assert.deepEqual(lines.at(-1).fanout.pending, []);
  assert.equal(lines.at(-1).fanout.complete, true);
});

test('本机投递账：入站记录老化触发压实后仍在，重启后收件席明细仍 injected', { timeout: 15000 }, async (t) => {
  const dir = makeTempDir(t);
  const config = { messageTtlMs: 1000 };
  const first = makeInbound(t, { dataDir: dir, config, seats: [seat('sess-b1')] });
  first.inbound.onFrame(createFakeConnection(), frame({ toSessions: ['sess-b1'] }));
  first.inbound.onFrame(createFakeConnection('127.0.0.3'), frame({ toSessions: ['sess-b1'] }));
  await waitFor(() => reportsOf(first.dispatch).length === 2);
  /* 时效语义本身依赖真实时间：等过保留期，让下一次受理的剪枝把这些入站记录移出窗口。 */
  await new Promise((resolve) => setTimeout(resolve, config.messageTtlMs + 100));

  const local = frame({ msgId: 'msg-local-compacted', payload: { text: '压实前写入' } });
  assert.equal(first.inbound.noteLocalDelivery({ collabId: 'collab-1', sessionId: 'sess-b1', frame: local, outcome: 'injected' }), true);
  assert.equal(readInbox(dir).some((line) => line.msgId === 'msg-local-compacted'), true, '写入即落盘');
  first.inbound.onFrame(createFakeConnection('127.0.0.4'), frame({ toSessions: ['sess-b1'] }));
  await waitFor(() => reportsOf(first.dispatch).length === 3);

  assert.equal(readInbox(dir).some((line) => line.msgId === 'msg-local-compacted'), true, '压实重写不得删除本机投递行');
  const restarted = makeInbound(t, { dataDir: dir, config });
  assert.equal(restarted.inbound.localSeatDeliveryOf('msg-local-compacted', 'sess-b1').status, 'injected', '重启后明细仍可查');
  assert.equal(restarted.inbound.checkInbox({ collabId: 'collab-1' }).messages.some((record) => record.msgId === 'msg-local-compacted'), true);
});
