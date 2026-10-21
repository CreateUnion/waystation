import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendMessage, sendToSeats, sendGovernance, deliveryStatusOf } from '../src/collab/outgoing.js';

const SELF = { instanceId: 'inst-self', identityName: '本机', port: 7321 };

function seat(sessionId, extra = {}) {
  return { sessionId, role: 'member', state: 'member', joinSeq: 1, muted: false, unverified: false, ...extra };
}

function rosterRow(instanceId, sessionId, role = 'member') {
  return { instanceId, sessionId, identityName: instanceId, role, state: 'member', joinSeq: 1, joinedAt: '2026-10-21T00:00:00.000Z' };
}

function makeState({ role = 'manager', seats, roster, endpoints = {}, counters = {} } = {}) {
  const sent = [];
  const injected = [];
  const local = {
    collabId: 'collab-1',
    role,
    suspended: null,
    member: {
      state: 'active',
      manager: { instanceId: role === 'manager' ? SELF.instanceId : 'inst-a', sessionId: role === 'manager' ? 'sess-self' : 'sess-mgr' },
      roster,
    },
    ledger: { status: 'active', members: roster, name: '项目', topic: '主题', mode: 'managed' },
    endpoints: new Map(Object.entries(endpoints)),
    seats: new Map(seats.map((entry) => [entry.sessionId, entry])),
    counter: { count: () => 0 },
    posts: { size: () => 0 },
  };
  const state = {
    self: SELF,
    collabs: new Map([['collab-1', local]]),
    counters: { messagesSent: 0, sendFailures: 0, ...counters },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    send: (message) => {
      sent.push(message);
      return { ok: true, msgId: `msg-${message.to.instanceId}`, tier: 'queued' };
    },
    injectLocalSeat: async (collabId, sessionId, frame) => {
      injected.push({ collabId, sessionId, frame });
      return { ok: true, delivered: true };
    },
  };
  return { state, local, sent, injected };
}

const ROSTER = [
  rosterRow('inst-self', 'sess-self', 'manager'),
  rosterRow('inst-self', 'sess-local2'),
  rosterRow('inst-b', 'sess-b1'),
  rosterRow('inst-b', 'sess-b2'),
  rosterRow('inst-c', 'sess-c1'),
];

const ENDPOINTS = {
  'inst-b': { address: '127.0.0.2', port: 7321 },
  'inst-c': { address: '127.0.0.3', port: 7321 },
};

test('站长群发：按机器分组，一机一帧并携 toSessions；同机其他席位走本机旁路', async () => {
  const { state, sent, injected } = makeState({ seats: [seat('sess-self', { role: 'manager' })], roster: ROSTER, endpoints: ENDPOINTS });
  const result = await sendMessage(state, { collabId: 'collab-1', text: '你好', sessionId: 'sess-self' });

  assert.equal(result.ok, true);
  assert.deepEqual(sent.map((message) => message.to.instanceId).sort(), ['inst-b', 'inst-c'], '远端机器各一帧');
  const toB = sent.find((message) => message.to.instanceId === 'inst-b');
  assert.deepEqual(toB.toSessions, ['sess-b1', 'sess-b2']);
  assert.equal(toB.fromSessionId, 'sess-self');
  assert.deepEqual(sent.find((message) => message.to.instanceId === 'inst-c').toSessions, ['sess-c1']);
  assert.deepEqual(injected.map((entry) => entry.sessionId), ['sess-local2'], '同机其他席位走旁路，不给发送会话自己投递');
  assert.equal(injected[0].frame.from.sessionId, 'sess-self');
  assert.deepEqual(result.to.sort(), ['inst-b', 'inst-c', 'inst-self']);
});

test('本机旁路：目标全在本机时不调用 dispatch.send，逐席调用 injectLocalSeat', async () => {
  const { state, sent, injected } = makeState({
    seats: [seat('sess-self', { role: 'manager' }), seat('sess-local2')],
    roster: [rosterRow('inst-self', 'sess-self', 'manager'), rosterRow('inst-self', 'sess-local2')],
  });
  const result = await sendToSeats(state, {
    collabId: 'collab-1',
    fromSessionId: 'sess-self',
    type: 'reply',
    payload: { text: '本机' },
    targets: [{ instanceId: 'inst-self', sessionId: 'sess-local2' }],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(sent, [], '本机目标不得走网络发送');
  assert.deepEqual(injected.map((entry) => entry.sessionId), ['sess-local2']);
  assert.equal(result.results[0].local, true);
  assert.equal(typeof result.results[0].msgId, 'string');
});

test('发送会话校验：非本机席位 / joining / unverified 一律拒绝', async () => {
  const seats = [seat('sess-self', { role: 'manager' }), seat('sess-join', { state: 'joining' }), seat('sess-unverified', { unverified: true })];
  const { state, sent, injected } = makeState({ seats, roster: ROSTER, endpoints: ENDPOINTS });
  for (const fromSessionId of ['sess-foreign', 'sess-join', 'sess-unverified', undefined]) {
    const result = await sendToSeats(state, {
      collabId: 'collab-1', fromSessionId, type: 'reply', payload: { text: 'x' },
      targets: [{ instanceId: 'inst-b', sessionId: 'sess-b1' }],
    });
    assert.equal(result.ok, false, String(fromSessionId));
    assert.ok(result.reason.includes('发送会话') || result.reason.includes('fromSessionId'), result.reason);
  }
  assert.deepEqual(sent, []);
  assert.deepEqual(injected, []);
});

test('定向 toSessionId：短码精确匹配，只发该席位；歧义 / 无匹配 / 缺 to 一律拒绝', async () => {
  const roster = [
    rosterRow('inst-self', 'sess-self', 'manager'),
    rosterRow('inst-b', 'sess0001aaaa'),
    rosterRow('inst-b', 'sess0002bbbb'),
    rosterRow('inst-b', 'sess0001cccc'),
  ];
  const { state, sent } = makeState({ seats: [seat('sess-self', { role: 'manager' })], roster, endpoints: ENDPOINTS });

  const exact = await sendMessage(state, { collabId: 'collab-1', text: '定向', to: 'inst-b', toSessionId: 'sess0002', sessionId: 'sess-self' });
  assert.equal(exact.ok, true);
  assert.deepEqual(sent.at(-1).toSessions, ['sess0002bbbb']);

  const full = await sendMessage(state, { collabId: 'collab-1', text: '定向', to: 'inst-b', toSessionId: 'sess0001aaaa', sessionId: 'sess-self' });
  assert.equal(full.ok, true);
  assert.deepEqual(sent.at(-1).toSessions, ['sess0001aaaa'], '完整会话标识按精确相等');

  const ambiguous = await sendMessage(state, { collabId: 'collab-1', text: '定向', to: 'inst-b', toSessionId: 'sess0001', sessionId: 'sess-self' });
  assert.equal(ambiguous.ok, false);
  assert.ok(ambiguous.message.includes('歧义'), ambiguous.message);

  const missing = await sendMessage(state, { collabId: 'collab-1', text: '定向', to: 'inst-b', toSessionId: 'nosuch01', sessionId: 'sess-self' });
  assert.equal(missing.ok, false);
  assert.equal(missing.message.includes('无匹配') || missing.message.includes('歧义'), true);

  const noMachine = await sendMessage(state, { collabId: 'collab-1', text: '定向', toSessionId: 'sess0002', sessionId: 'sess-self' });
  assert.equal(noMachine.ok, false);
  assert.ok(noMachine.message.includes('同时给出'), noMachine.message);
});

test('成员→站长：只能定向站长所在机器；定向其他机器拒绝', async () => {
  const roster = [
    rosterRow('inst-a', 'sess-mgr', 'manager'),
    rosterRow('inst-b', 'sess-b1'),
    rosterRow('inst-self', 'sess-mem'),
  ];
  const { state, sent } = makeState({
    role: 'member',
    seats: [seat('sess-mem')],
    roster,
    endpoints: { 'inst-a': { address: '127.0.0.10', port: 7321 }, ...ENDPOINTS },
  });
  const allowed = await sendMessage(state, { collabId: 'collab-1', text: '给站长', to: 'inst-a', toSessionId: 'sess-mgr', sessionId: 'sess-mem' });
  assert.equal(allowed.ok, true);
  assert.deepEqual(sent.at(-1).toSessions, ['sess-mgr']);

  const rejected = await sendMessage(state, { collabId: 'collab-1', text: '越级', to: 'inst-b', sessionId: 'sess-mem' });
  assert.equal(rejected.ok, false);
  assert.ok(rejected.message.includes('站长'), rejected.message);
});

test('sendGovernance：与 sendToSeats 同分组语义，按机器返回 msgId', async () => {
  const { state, sent } = makeState({ seats: [seat('sess-self', { role: 'manager' })], roster: ROSTER, endpoints: ENDPOINTS });
  const result = await sendGovernance(state, {
    collabId: 'collab-1',
    fromSessionId: 'sess-self',
    type: 'freeze',
    payload: { name: '项目', members: ROSTER },
    targets: [{ instanceId: 'inst-b', sessionId: 'sess-b1' }, { instanceId: 'inst-b', sessionId: 'sess-b2' }],
  });
  assert.equal(result.ok, true);
  assert.equal(sent.length, 1, '同机两席一帧');
  assert.deepEqual(sent[0].toSessions, ['sess-b1', 'sess-b2']);
  assert.equal(result.results[0].msgId, 'msg-inst-b');
});

test('deliveryStatusOf：委托发送调度器的机器级行；未接线返回 null', async () => {
  const { state } = makeState({ seats: [seat('sess-self', { role: 'manager' })], roster: ROSTER, endpoints: ENDPOINTS });
  assert.equal(deliveryStatusOf(state, 'msg-1'), null);
  state.deliveryStatusOf = (msgId) => ({ msgId, tier: 'session' });
  assert.deepEqual(deliveryStatusOf(state, 'msg-1'), { msgId: 'msg-1', tier: 'session' });
});
