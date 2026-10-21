import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createCollab, deliveryStatusOf, endCollab, localSeatDeliveryOf, pushSnapshot, requestCurrentView, sendGovernance, sendMessage, sendToRoster, sendToSeats } from '../src/collab/outgoing.js';
import { isLedgerShape } from '../src/collab/model.js';
import { loadLedger } from '../src/collab/store.js';
import { seatFilePath } from '../src/paths.js';
import { COLLAB_CAPABILITY, PROTOCOL_VERSION, newMsgId, validateMessage, withCollabCapability } from '../src/net/protocol.js';
import { makeTempDir, waitFor } from './helpers.js';

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
    mute: { clear: () => {} },
  };
  const state = {
    self: SELF,
    collabs: new Map([['collab-1', local]]),
    joinReplays: new Map(),
    counters: { messagesSent: 0, sendFailures: 0, ended: 0, ...counters },
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
  assert.equal(injected[0].frame.cap, COLLAB_CAPABILITY, '本机注入帧同样经 withCollabCapability 盖 cap=2');
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

test('sendMessage：同机多席缺 sessionId 拒绝（不再兜底站长）；单席位可无歧义签名', async () => {
  const multi = makeState({ seats: [seat('sess-self', { role: 'manager' }), seat('sess-other')], roster: ROSTER, endpoints: ENDPOINTS });
  const rejected = await sendMessage(multi.state, { collabId: 'collab-1', text: '冒名' });
  assert.equal(rejected.ok, false);
  assert.ok(rejected.message.includes('fromSessionId') || rejected.message.includes('发送会话'), rejected.message);
  assert.deepEqual(multi.sent, []);
  assert.deepEqual(multi.injected, []);

  const single = makeState({ seats: [seat('sess-self', { role: 'manager' })], roster: ROSTER, endpoints: ENDPOINTS });
  const sent = await sendMessage(single.state, { collabId: 'collab-1', text: '单席' });
  assert.equal(sent.ok, true);
  assert.equal(single.sent[0].fromSessionId, 'sess-self');
});

test('本机旁路：静音席位不注入但计入受理；投递账可查（deliveryStatusOf/localSeatDeliveryOf）', async () => {
  const { state, local, injected } = makeState({
    seats: [seat('sess-self', { role: 'manager' }), seat('sess-local2', { muted: true })],
    roster: [rosterRow('inst-self', 'sess-self', 'manager'), rosterRow('inst-self', 'sess-local2')],
  });
  const result = await sendMessage(state, { collabId: 'collab-1', text: '本机静音', sessionId: 'sess-self' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(injected, [], '静音席位不注入');
  const localGroup = result.results.find((entry) => entry.local === true);
  assert.equal(localGroup.results[0].status, 'gated');

  const row = deliveryStatusOf(state, result.msgId);
  assert.equal(row.tier, 'session', '本机旁路机器级终态立即成立');
  assert.deepEqual(row.toSessions, ['sess-local2']);
  assert.equal(row.fromSessionId, 'sess-self');
  assert.deepEqual(localSeatDeliveryOf(state, result.msgId, 'sess-local2'), {
    collabId: 'collab-1', msgId: result.msgId, sessionId: 'sess-local2', status: 'gated', complete: true,
  });
  assert.equal(local, state.collabs.get('collab-1'));
});

test('本机旁路：未静音席位注入成功后投递账为 injected', async () => {
  const { state, injected } = makeState({
    seats: [seat('sess-self', { role: 'manager' }), seat('sess-local2')],
    roster: [rosterRow('inst-self', 'sess-self', 'manager'), rosterRow('inst-self', 'sess-local2')],
  });
  const result = await sendMessage(state, { collabId: 'collab-1', text: '本机', sessionId: 'sess-self' });
  assert.equal(result.ok, true);
  assert.deepEqual(injected.map((entry) => entry.sessionId), ['sess-local2']);
  assert.equal(localSeatDeliveryOf(state, result.msgId, 'sess-local2').status, 'injected');
  assert.equal(deliveryStatusOf(state, result.msgId).deliveredAt !== null, true);
});

test('成员定向：只能落在站长席位；指名站长机上其他成员席位拒绝', async () => {
  const roster = [
    rosterRow('inst-a', 'sess-mgr', 'manager'),
    rosterRow('inst-a', 'sess-peer'),
    rosterRow('inst-self', 'sess-mem'),
  ];
  const { state, sent } = makeState({
    role: 'member',
    seats: [seat('sess-mem')],
    roster,
    endpoints: { 'inst-a': { address: '127.0.0.10', port: 7321 } },
  });
  const toPeer = await sendMessage(state, { collabId: 'collab-1', text: '越权', to: 'inst-a', toSessionId: 'sess-peer', sessionId: 'sess-mem' });
  assert.equal(toPeer.ok, false);
  assert.ok(toPeer.message.includes('站长席位'), toPeer.message);
  assert.deepEqual(sent, []);

  const toManager = await sendMessage(state, { collabId: 'collab-1', text: '给站长', to: 'inst-a', toSessionId: 'sess-mgr', sessionId: 'sess-mem' });
  assert.equal(toManager.ok, true);
  assert.deepEqual(sent.at(-1).toSessions, ['sess-mgr']);
});

test('部分机器发送失败：逐机器原因随结果返回，不被 ok:true 吞掉', async () => {
  const { state } = makeState({
    seats: [seat('sess-self', { role: 'manager' })],
    roster: [rosterRow('inst-self', 'sess-self', 'manager'), rosterRow('inst-b', 'sess-b1'), rosterRow('inst-c', 'sess-c1')],
    endpoints: { 'inst-b': { address: '127.0.0.2', port: 7321 } },
  });
  const result = await sendMessage(state, { collabId: 'collab-1', text: '广播', sessionId: 'sess-self' });
  assert.equal(result.ok, true);
  const failed = result.results.find((entry) => entry.instanceId === 'inst-c');
  assert.equal(failed.ok, false);
  assert.ok(failed.reason.includes('端点未知'), failed.reason);
  assert.deepEqual(result.failed, [{ instanceId: 'inst-c', reason: '端点未知（先扫描或等对方联系）' }]);
  assert.deepEqual(result.to, ['inst-b']);
});

test('sendToRoster：本机其他席位走旁路注入，远端一帧一机', async () => {
  const { state, local, sent, injected } = makeState({
    seats: [seat('sess-self', { role: 'manager' }), seat('sess-local2')],
    roster: [rosterRow('inst-self', 'sess-self', 'manager'), rosterRow('inst-self', 'sess-local2'), rosterRow('inst-b', 'sess-b1')],
    endpoints: ENDPOINTS,
  });
  const count = sendToRoster(state, local, 'freeze', { name: '项目', members: [] });
  assert.equal(count, 2, '本机组 + 远端组');
  await waitFor(() => injected.length === 1);
  assert.deepEqual(injected.map((entry) => entry.sessionId), ['sess-local2']);
  assert.deepEqual(sent.map((message) => message.to.instanceId), ['inst-b']);
  assert.equal(sent[0].fromSessionId, 'sess-self');
});

test('建协：创建者席位先落盘；新台账通过形态校验并可重载；首邀携 sessionId 与席位名单', async (t) => {
  const dir = makeTempDir(t);
  const { state, sent } = makeCreateState(dir);
  const result = createCollab(state, {
    name: '项目',
    topic: '主题',
    mode: 'managed',
    sessionId: 'sess-creator',
    targets: [{ instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.2', port: 7321, targetSessionId: 'sess-b1' }],
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const local = state.collabs.get(result.collabId);
  assert.equal(isLedgerShape(local.ledger), true);
  assert.deepEqual(local.ledger.members.map((entry) => entry.state), ['member'], '受邀行不得进共享名单');
  assert.equal(local.ledger.manager.sessionId, 'sess-creator');
  assert.equal(local.ledger.managerTerm, 1);
  assert.equal(local.ledger.joinSeqNext, 2);
  assert.equal(existsSync(seatFilePath(dir, result.collabId, 'sess-creator')), true, '创建者席位先于首邀落盘');
  assert.equal(loadLedger(dir, result.collabId).ledger.manager.sessionId, 'sess-creator', '落盘台账可重载');

  assert.equal(sent.length, 1);
  assert.equal(sent[0].fromSessionId, 'sess-creator');
  assert.equal(sent[0].payload.members[0].sessionId, 'sess-creator', '邀请名单须携席位标识');
  assert.deepEqual(sent[0].payload.targets, [{ instanceId: 'inst-b', targetSessionId: 'sess-b1' }]);
  const wire = withCollabCapability({
    v: PROTOCOL_VERSION,
    msgId: newMsgId(),
    type: 'invite',
    from: { ...SELF, sessionId: 'sess-creator' },
    collabId: result.collabId,
    ts: new Date().toISOString(),
    payload: sent[0].payload,
  });
  assert.equal(validateMessage(wire).ok, true, JSON.stringify(validateMessage(wire)));
});

test('建协缺 sessionId：拒绝创建（无标识不得创建）', (t) => {
  const { state } = makeCreateState(makeTempDir(t));
  const result = createCollab(state, { name: '项目', topic: '主题', targets: [] });
  assert.equal(result.ok, false);
  assert.ok(result.message.includes('sessionId'), result.message);
});

test('快照出站：data 帧携 managerTerm/managerWindow；request 帧携请求方基线，均过协议预检', async () => {
  const window = { windowBaseTerm: 1, windowEndsAt: '2026-10-21T00:10:00.000Z' };
  const ledger = ledgerOf({ version: 3, managerWindow: window });
  const { state, local, sent } = makeState({
    seats: [seat('sess-self', { role: 'manager' })],
    roster: ledger.members,
    endpoints: { ...ENDPOINTS, 'inst-a': { address: '127.0.0.10', port: 7321 } },
  });
  local.ledger = ledger;
  pushSnapshot(state, local);
  const data = sent.find((message) => message.type === 'snapshot');
  assert.equal(data.payload.kind, 'data');
  assert.equal(data.payload.managerTerm, 1);
  assert.equal(data.payload.version, 3);
  assert.deepEqual(data.payload.managerWindow, window);
  assert.equal(data.fromSessionId, 'sess-self');
  assert.equal(validateMessage(snapshotWire('collab-1', 'sess-self', data.payload)).ok, true);

  local.role = 'member';
  local.member.manager = { instanceId: 'inst-a', identityName: '主机甲' };
  local.snapshot = { ledger, version: 3 };
  requestCurrentView(state, local);
  const request = sent.filter((message) => message.type === 'snapshot').at(-1);
  assert.deepEqual(request.payload, { kind: 'request', managerTerm: 1, version: 3 });
  assert.equal(validateMessage(snapshotWire('collab-1', 'sess-self', request.payload)).ok, true);
});

test('end：终态台账 manager:null、无站长行/窗口；终态快照与 end 通告仍发原成员', () => {
  const ledger = ledgerOf({ version: 3 });
  const { state, local, sent } = makeState({
    seats: [seat('sess-self', { role: 'manager' })],
    roster: ledger.members,
    endpoints: ENDPOINTS,
  });
  local.ledger = ledger;
  const result = endCollab(state, { collabId: 'collab-1' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(local.ledger.status, 'completed');
  assert.equal(local.ledger.manager, null, '终态必须 manager:null');
  assert.equal(local.ledger.members.some((entry) => entry.role === 'manager'), false, '名单不得残留站长行');
  assert.equal(Object.hasOwn(local.ledger, 'managerWindow'), false, '终态不得携接管窗口');
  assert.equal(isLedgerShape(local.ledger), true, '终态台账须过形态校验');
  assert.ok(sent.some((message) => message.type === 'snapshot'), '终态快照先发');
  assert.ok(sent.some((message) => message.type === 'end' && message.to.instanceId === 'inst-b'), 'end 通告仍达原成员');
});

function snapshotWire(collabId, sessionId, payload) {
  return withCollabCapability({
    v: PROTOCOL_VERSION,
    msgId: newMsgId(),
    type: 'snapshot',
    from: { ...SELF, sessionId },
    collabId,
    ts: new Date().toISOString(),
    payload,
  });
}

function ledgerOf({ version = 1, managerWindow } = {}) {
  const now = '2026-10-21T00:00:00.000Z';
  return {
    version,
    collabId: 'collab-1',
    name: '项目',
    topic: '主题',
    mode: 'managed',
    status: 'active',
    managerTerm: 1,
    manager: { instanceId: SELF.instanceId, sessionId: 'sess-self', identityName: SELF.identityName, term: 1 },
    joinSeqNext: 2,
    members: [
      { instanceId: SELF.instanceId, sessionId: 'sess-self', identityName: SELF.identityName, role: 'manager', state: 'member', joinSeq: 1, joinedAt: now },
      { instanceId: 'inst-b', sessionId: 'sess-b1', identityName: '主机乙', role: 'member', state: 'member', joinSeq: 2, joinedAt: now },
    ],
    board: [],
    createdAt: now,
    updatedAt: now,
    ...(managerWindow === undefined ? {} : { managerWindow }),
  };
}

/* 建协用例的状态：空 collabs、可落盘的 dataDir 与最小计数/存储依赖。 */
function makeCreateState(dataDir) {
  const sent = [];
  const state = {
    dataDir,
    self: SELF,
    collabs: new Map(),
    counters: { collabsCreated: 0, invitesSent: 0, messagesSent: 0, sendFailures: 0, persistFailures: 0 },
    knownHosts: { remember: () => {} },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    send: (message) => {
      sent.push(message);
      return { ok: true, msgId: `msg-${message.to.instanceId}`, tier: 'queued' };
    },
  };
  return { state, sent };
}
