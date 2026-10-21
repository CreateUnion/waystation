import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir } from './helpers.js';
import { collabDir } from '../src/paths.js';
import { ledgerDigest } from '../src/collab/store.js';
import { handleEvent } from '../src/collab/events.js';
import { confirmHandover, handover } from '../src/collab/handover.js';
import { applyManagerFreeze, clearFreezeReason, clearManagerFreeze, m5RuntimeOf, noteSeatClosed, persistFreezeReason, sweepSeatGrace, takeOver } from '../src/collab/takeover.js';

/* M5 接线（设计 §2A/§3.2）：任期受理、auto 追赶门、快照生产端、presence 直连/中继、
 * 离席留痕、自动/显式移交与手动接管。夹具直接构造共享态与席位表，不经协议层形态预检。 */

const COLLAB = 'collab-m5';
const NOW = Date.now();
const iso = (ms = NOW) => new Date(ms).toISOString();
let seq = 0;

function ledgerOf({ term = 1, version = 10, manager = { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' }, members = [], window = undefined, mode = 'managed', status = 'active' } = {}) {
  const rows = [
    { ...manager, role: 'manager', state: 'member', joinSeq: 1, joinedAt: iso() },
    ...members.map((member, index) => ({ role: 'member', state: 'member', joinSeq: index + 2, joinedAt: iso(), ...member })),
  ];
  return {
    version,
    managerTerm: term,
    joinSeqNext: rows.length + 1,
    collabId: COLLAB,
    name: '项目',
    topic: '主题',
    mode,
    status,
    manager: { ...manager, term },
    members: rows,
    board: [],
    events: [],
    createdAt: iso(),
    updatedAt: iso(),
    ...(window === undefined ? {} : { managerWindow: window }),
  };
}

function seatOf(sessionId, role = 'member', joinSeq = 2) {
  return {
    version: 1,
    sessionId,
    role,
    state: 'member',
    joinSeq,
    joinedAt: iso(),
    muted: false,
    unverified: false,
    bridgeId: null,
    staged: [],
    inbox: [],
    seen: new Set(),
    stagedDropped: 0,
  };
}

function memberRecordOf(manager) {
  return {
    collabId: COLLAB,
    role: 'member',
    name: '项目',
    topic: '主题',
    mode: 'managed',
    state: 'active',
    decision: 'approved',
    manager: { instanceId: manager.instanceId, identityName: manager.identityName },
    roster: [],
    endpoints: {},
    invitedAt: iso(),
    expiresAt: iso(NOW + 3600000),
  };
}

function localOf(options = {}) {
  const ledger = options.ledger ?? ledgerOf();
  const manager = ledger.manager ?? { instanceId: 'inst-a', identityName: '甲' };
  const role = options.role ?? 'member';
  return {
    collabId: COLLAB,
    role,
    ledger: role === 'manager' ? ledger : null,
    member: localMemberOf(options.member, role, manager),
    endpoints: new Map(options.endpoints ?? []),
    snapshot: role === 'manager' ? null : snapshotOf(ledger, manager),
    seats: new Map((options.seats ?? []).map((seat) => [seat.sessionId, seat])),
    suspended: null,
    staleManagerId: null,
    mute: { clear: () => {} },
    handshakeUnresolved: false,
  };
}

function localMemberOf(member, role, manager) {
  if (member !== null && member !== undefined) {
    return member;
  }
  const record = memberRecordOf(manager);
  return role === 'manager' ? { ...record, role: 'manager' } : record;
}

function snapshotOf(ledger, manager) {
  return {
    version: ledger.version,
    digest: ledgerDigest(ledger),
    receivedAt: iso(),
    from: { instanceId: manager.instanceId, identityName: manager.identityName },
    ledger,
  };
}

function stateOf(t, local, overrides = {}) {
  const dir = makeTempDir(t);
  const sent = [];
  const notified = [];
  const clock = { now: NOW };
  const state = {
    ...stateBaseOf(dir, sent),
    config: configOf(overrides.config),
    self: { instanceId: 'inst-self', identityName: '本机', port: 17321 },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    counters: {},
    knownHosts: { remember: () => {} },
    notify: (frame) => notified.push(frame),
    collabs: new Map([[COLLAB, local]]),
    handshakeReplyTimeoutMs: 1,
    clock: () => clock.now,
    ...(overrides.state ?? {}),
  };
  return { state, sent, notified, dir, clock };
}

function stateBaseOf(dir, sent) {
  return {
    dataDir: dir,
    send: (message) => {
      sent.push(message);
      return { ok: true, msgId: `msg-out-${sent.length}` };
    },
    probes: new Map(),
    handshakeWatch: new Map(),
    pendingViews: new Map(),
    effectiveTakeovers: new Map(),
    takeovers: new Map(),
    rearmedTakeovers: new Map(),
    awaitingTakeovers: new Map(),
    relayedOrigins: new Map(),
    joinReplays: new Map(),
    relayDown: new Set(),
  };
}

function configOf(overrides = {}) {
  return {
    managerProbeIntervalMs: 1000,
    managerLossTimeoutMs: 300000,
    sessionTakeoverWindowMs: 60000,
    sessionSeatTimeoutMs: 300000,
    seatPresenceIntervalMs: 30000,
    sessionSeatGraceMs: 1000,
    handoverConfirmTimeoutMs: 120000,
    dialTimeoutMs: 5000,
    ...(overrides ?? {}),
  };
}

function frameOf(type, payload, from = { instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' }) {
  seq++;
  return { v: 1, cap: 2, type, msgId: `msg-${seq}`, collabId: COLLAB, from: { port: 17321, ...from }, ts: iso(), payload };
}

function changeOf({ via, term, version, manager, prevManager, offerId, windowEndsAt, windowBaseTerm, authorizedAt }) {
  return {
    event: 'manager-changed',
    via,
    term,
    version,
    manager,
    prevManager,
    ...(offerId === undefined ? {} : { offerId }),
    ...(windowEndsAt === undefined ? {} : { windowEndsAt }),
    ...(windowBaseTerm === undefined ? {} : { windowBaseTerm }),
    ...(authorizedAt === undefined ? {} : { authorizedAt }),
    effectiveAt: iso(),
    endpoint: { address: '10.0.0.2', port: 17321 },
    digest: 'a'.repeat(64),
  };
}

test('A1 显式移交变更：来源为现任站长、term+1、version 更高 → 采纳并拉快照、不开窗', async (t) => {
  const local = localOf({ seats: [seatOf('sess-self')] });
  const { state, sent } = stateOf(t, local);
  const payload = changeOf({
    via: 'handover', term: 2, version: 11,
    manager: { instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' },
    prevManager: { instanceId: 'inst-a', sessionId: 'sess-a' },
    offerId: 'offer-1',
  });
  await handleEvent(state, frameOf('notice', payload, { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' }), { remoteAddress: '10.0.0.1' });
  assert.equal(local.member.manager.instanceId, 'inst-b');
  assert.equal(m5RuntimeOf(state).termState.get(COLLAB).managerTerm, 2);
  assert.equal(m5RuntimeOf(state).managerWindowBaseAt.has(COLLAB), false, '显式移交不开窗');
  assert.ok(sent.some((entry) => entry.type === 'snapshot' && entry.payload.kind === 'request'), '采纳后向新站长拉快照');
});

test('A2 auto 有本地 auto-offer → 采纳并开窗；无本地 offer → 拒收并请求快照', async (t) => {
  const member = { instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' };
  const offer = { event: 'auto-offer', offerId: 'offer-auto', prevManager: { instanceId: 'inst-a', sessionId: 'sess-a' }, target: member, baseTerm: 1, version: 10, expiresAt: iso(NOW + 60000) };
  const accepted = localOf({ seats: [seatOf('sess-self')] });
  const harness = stateOf(t, accepted);
  await handleEvent(harness.state, frameOf('notice', offer, { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' }), { remoteAddress: '10.0.0.1' });
  await handleEvent(harness.state, frameOf('notice', changeOf({
    via: 'auto', term: 2, version: 11, manager: member,
    prevManager: { instanceId: 'inst-a', sessionId: 'sess-a' }, offerId: 'offer-auto',
    windowEndsAt: iso(NOW + 60000), authorizedAt: iso(),
  }), member), { remoteAddress: '10.0.0.2' });
  assert.equal(accepted.member.manager.instanceId, 'inst-b');
  assert.equal(m5RuntimeOf(harness.state).managerWindowBaseAt.has(COLLAB), true, 'auto 开窗');

  const rejected = localOf({ seats: [seatOf('sess-self')] });
  const harness2 = stateOf(t, rejected);
  await handleEvent(harness2.state, frameOf('notice', changeOf({
    via: 'auto', term: 2, version: 11, manager: member,
    prevManager: { instanceId: 'inst-a', sessionId: 'sess-a' }, offerId: 'offer-missing',
    windowEndsAt: iso(NOW + 60000), authorizedAt: iso(),
  }), member), { remoteAddress: '10.0.0.2' });
  assert.equal(rejected.member.manager.instanceId, 'inst-a', '无本地 offer 不得改任期');
  assert.ok(harness2.sent.some((entry) => entry.type === 'snapshot'), '拒收后请求快照走对表');
});

test('A8 同 term 不同 manager → 冻结 manager-fork 并停写', async (t) => {
  const local = localOf({
    ledger: ledgerOf({ term: 2, version: 12, manager: { instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' } }),
    seats: [seatOf('sess-self')],
  });
  const { state } = stateOf(t, local);
  await handleEvent(state, frameOf('notice', changeOf({
    via: 'takeover', term: 2, version: 13,
    manager: { instanceId: 'inst-c', sessionId: 'sess-c', identityName: '丙' },
    prevManager: { instanceId: 'inst-b', sessionId: 'sess-b' },
    windowBaseTerm: 2, authorizedAt: iso(),
  }), { instanceId: 'inst-c', sessionId: 'sess-c', identityName: '丙' }), { remoteAddress: '10.0.0.3' });
  assert.equal(m5RuntimeOf(state).frozen.get(COLLAB), 'manager-fork');
  assert.notEqual(local.suspended, null, '冻结即停写');
});

test('A4 手动接管：站长不可达证据齐备 → 采纳并解除 manager-offline', async (t) => {
  const local = localOf({
    ledger: ledgerOf({ term: 2, version: 12, members: [{ instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' }] }),
    seats: [seatOf('sess-self')],
    endpoints: [],
  });
  const { state, dir } = stateOf(t, local);
  mkdirSync(collabDir(dir, COLLAB), { recursive: true });
  writeFileSync(join(collabDir(dir, COLLAB), 'carrier.json'), JSON.stringify({ format: 'session-seats', version: 1, collabId: COLLAB, name: '项目', topic: '主题', mode: 'managed', endpoints: {}, snapshotVersion: 1, createdAt: iso() }), 'utf8');
  applyManagerFreeze(state, COLLAB, 'manager-offline');
  m5RuntimeOf(state).managerEvidenceAt.set(COLLAB, NOW - 400000);
  await handleEvent(state, frameOf('notice', changeOf({
    via: 'takeover-manual', term: 3, version: 13,
    manager: { instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' },
    prevManager: { instanceId: 'inst-a', sessionId: 'sess-a' }, authorizedAt: iso(),
  }), { instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' }), { remoteAddress: '10.0.0.2' });
  assert.equal(local.member.manager.instanceId, 'inst-b');
  assert.equal(m5RuntimeOf(state).frozen.has(COLLAB), false, '受理后解除 manager-offline');
  const carrier = JSON.parse(readFileSync(join(collabDir(dir, COLLAB), 'carrier.json'), 'utf8'));
  assert.equal(Object.hasOwn(carrier, 'freezeReason'), false, '接管成功后清除冻结原因');
  assert.equal(local.member.freezeReason, undefined);
});

test('快照生产端：应答携 managerTerm / managerWindow / events（出站预检不再拒收）', async (t) => {
  const window = { windowBaseTerm: 1, windowEndsAt: iso(NOW + 60000) };
  const local = localOf({ role: 'manager', ledger: ledgerOf({ window }), seats: [seatOf('sess-a', 'manager', 1)], endpoints: [['inst-b', { address: '10.0.0.7', port: 17321 }]] });
  const { state, sent } = stateOf(t, local);
  await handleEvent(state, frameOf('snapshot', { kind: 'request', managerTerm: 1, version: 10, purpose: 'catchup' }), { remoteAddress: '10.0.0.9' });
  const answer = sent.find((entry) => entry.type === 'snapshot' && entry.payload.kind === 'data');
  assert.ok(answer, '冻结 catch-up 也应答');
  assert.equal(answer.payload.managerTerm, 1);
  assert.deepEqual(answer.payload.managerWindow, window);
  assert.ok(Array.isArray(answer.payload.ledger.events));
  assert.equal(answer.payload.purpose, 'catchup');
});

test('A10 追赶门：更高任期快照无本地 auto-offer → 拒收并冻结，不经 ledger.events 转正', async (t) => {
  const local = localOf({ seats: [seatOf('sess-self')] });
  const { state } = stateOf(t, local);
  const ledger = ledgerOf({ term: 2, version: 11, manager: { instanceId: 'inst-c', sessionId: 'sess-c', identityName: '丙' } });
  ledger.events = [
    { type: 'auto-offer', offerId: 'forged', prevManager: { instanceId: 'inst-a', sessionId: 'sess-a' }, target: { instanceId: 'inst-c', sessionId: 'sess-c' }, baseTerm: 1, version: 10, expiresAt: iso(NOW + 60000) },
    { type: 'manager-changed', via: 'auto', offerId: 'forged', term: 2, version: 11, prevManager: { instanceId: 'inst-a', sessionId: 'sess-a' }, manager: { instanceId: 'inst-c', sessionId: 'sess-c', identityName: '丙' } },
    { type: 'leave', seat: { instanceId: 'inst-a', sessionId: 'sess-a' }, reason: 'manager-session-closed' },
  ];
  await handleEvent(state, frameOf('snapshot', { kind: 'data', managerTerm: 2, version: 11, digest: ledgerDigest(ledger), ledger }, { instanceId: 'inst-c', sessionId: 'sess-c', identityName: '丙' }), { remoteAddress: '10.0.0.3' });
  assert.equal(m5RuntimeOf(state).frozen.get(COLLAB), 'manager-fork');
  assert.equal(local.member.manager.instanceId, 'inst-a', '不得经快照转正');
});

test('presence 直连刷新；转达副本不刷新；forum 中继转发只认当前中继连接', async (t) => {
  const local = localOf({ role: 'manager', ledger: ledgerOf({ members: [{ instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' }] }), seats: [seatOf('sess-a', 'manager', 1)], endpoints: [['inst-b', { address: '10.0.0.7', port: 17321 }]] });
  const harness = stateOf(t, local);
  const notice = { collabId: COLLAB, instanceId: 'inst-b', sessions: ['sess-b'], sentAt: iso() };
  await handleEvent(harness.state, frameOf('seat-presence', notice), { remoteAddress: '10.0.0.7' });
  const entry = [...m5RuntimeOf(harness.state).presence.values()].find((item) => item.sessionId === 'sess-b');
  assert.ok(entry, '直连列表刷新');
  await handleEvent(harness.state, frameOf('seat-presence', { ...notice, originMsgId: 'origin-1' }), { remoteAddress: '10.0.0.7' });
  assert.ok((harness.state.counters.presenceRejected ?? 0) >= 1, 'managed 转达一律拒收');

  const forum = localOf({ ledger: ledgerOf({ mode: 'forum', members: [{ instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' }] }), seats: [seatOf('sess-f')], endpoints: [['inst-r', { address: '10.0.0.8', port: 17321 }], ['inst-b', { address: '10.0.0.7', port: 17321 }]] });
  forum.member.originator = { instanceId: 'inst-r', identityName: '中继' };
  forum.member.mode = 'forum';
  const forumHarness = stateOf(t, forum);
  const relayed = { ...notice, originMsgId: 'origin-2' };
  await handleEvent(forumHarness.state, frameOf('seat-presence', relayed), { remoteAddress: '10.0.0.8' });
  assert.ok([...m5RuntimeOf(forumHarness.state).presence.values()].some((item) => item.sessionId === 'sess-b'), '当前中继转发的列表按原发机器刷新');
  const before = forumHarness.state.counters.presenceRejected ?? 0;
  await handleEvent(forumHarness.state, frameOf('seat-presence', { ...notice, originMsgId: 'origin-3' }), { remoteAddress: '10.0.0.7' });
  assert.equal(forumHarness.state.counters.presenceRejected ?? 0, before + 1, '非中继连接转达拒收');
  harness.state.monoClock = () => 424242;
  await handleEvent(harness.state, frameOf('seat-presence', { ...notice, sessions: ['sess-b'] }), { remoteAddress: '10.0.0.7' });
  const monoEntry = [...m5RuntimeOf(harness.state).presence.values()].find((item) => item.sessionId === 'sess-b');
  assert.equal(monoEntry.lastSeenAt, 424242, 'presence 用单调钟，不混墙钟');
});

test('离席：名单行按席位键移除、departed.jsonl 追加、名单通告发出', async (t) => {
  const local = localOf({ role: 'manager', ledger: ledgerOf({ members: [{ instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' }, { instanceId: 'inst-c', sessionId: 'sess-c', identityName: '丙' }] }), seats: [seatOf('sess-a', 'manager', 1)], endpoints: [['inst-c', { address: '10.0.0.3', port: 17321 }]] });
  const { state, sent, dir } = stateOf(t, local);
  await handleEvent(state, frameOf('leave', {}, { instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' }), { remoteAddress: '10.0.0.7' });
  assert.equal(local.ledger.members.some((row) => row.sessionId === 'sess-b'), false);
  const departed = readFileSync(join(collabDir(dir, COLLAB), 'departed.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(departed.at(-1).sessionId, 'sess-b');
  assert.ok(departed.at(-1).reason.length > 0);
  assert.ok(sent.some((entry) => entry.type === 'notice' && entry.payload.event === 'roster'));
});

test('冻结原因持久化到载体（M7 只读展示面）', async (t) => {
  const local = localOf({ role: 'manager', ledger: ledgerOf(), seats: [seatOf('sess-a', 'manager', 1)] });
  const { state, dir } = stateOf(t, local);
  const carrier = { format: 'session-seats', version: 1, collabId: COLLAB, name: '项目', topic: '主题', mode: 'managed', endpoints: {}, snapshotVersion: 1, createdAt: iso() };
  mkdirSync(collabDir(dir, COLLAB), { recursive: true });
  writeFileSync(join(collabDir(dir, COLLAB), 'carrier.json'), JSON.stringify(carrier), 'utf8');
  applyManagerFreeze(state, COLLAB, 'manager-offline');
  const onDisk = JSON.parse(readFileSync(join(collabDir(dir, COLLAB), 'carrier.json'), 'utf8'));
  assert.equal(onDisk.freezeReason, 'manager-offline');
  clearManagerFreeze(state, COLLAB);
  const cleared = JSON.parse(readFileSync(join(collabDir(dir, COLLAB), 'carrier.json'), 'utf8'));
  assert.equal(Object.hasOwn(cleared, 'freezeReason'), false, '解除冻结必须清除载体原因');
  assert.equal(local.freezeReason, undefined);
  persistFreezeReason(state, COLLAB, '');
  const again = JSON.parse(readFileSync(join(collabDir(dir, COLLAB), 'carrier.json'), 'utf8'));
  assert.equal(Object.hasOwn(again, 'freezeReason'), false, '空值不得写入载体');
  clearFreezeReason(state, COLLAB);
});

test('宽限到期：站长会话关闭 → auto-offer 广播 + offer 定向发出并停写', async (t) => {
  const local = localOf({
    role: 'manager',
    ledger: ledgerOf({ members: [{ instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' }] }),
    seats: [seatOf('sess-a', 'manager', 1), seatOf('sess-b', 'member', 2)],
    endpoints: [['inst-b', { address: '10.0.0.7', port: 17321 }]],
  });
  const { state, sent } = stateOf(t, local);
  noteSeatClosed(state, COLLAB, 'sess-a', NOW);
  sweepSeatGrace(state, NOW + 2000);
  assert.ok(sent.some((entry) => entry.type === 'notice' && entry.payload.event === 'auto-offer'), 'auto-offer 已广播');
  const offer = sent.find((entry) => entry.type === 'handover' && entry.payload.kind === 'offer');
  assert.ok(offer, 'offer 已定向发出');
  assert.equal(offer.to.instanceId, 'inst-b');
  assert.equal(offer.payload.baseTerm, 1);
  assert.ok(offer.payload.offerId);
  assert.ok(local.suspended !== null, '等待期停写');
});

test('auto 目标侧：匹配本地 auto-offer → 自动接受并由目标签发 via=auto（含窗口）', async (t) => {
  const manager = { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' };
  const selfRow = { instanceId: 'inst-self', sessionId: 'sess-b', identityName: '乙' };
  const ledger = ledgerOf({ manager, members: [selfRow] });
  const local = localOf({ seats: [seatOf('sess-b')], endpoints: [['inst-a', { address: '10.0.0.1', port: 17321 }]], ledger });
  const harness = stateOf(t, local);
  const offerId = 'offer-auto-1';
  const expiresAt = iso(NOW + 120000);
  await handleEvent(harness.state, frameOf('notice', { event: 'auto-offer', offerId, prevManager: { instanceId: 'inst-a', sessionId: 'sess-a' }, target: selfRow, baseTerm: 1, version: 10, expiresAt }, { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' }), { remoteAddress: '10.0.0.1' });
  await handleEvent(harness.state, frameOf('handover', { kind: 'offer', offerId, baseTerm: 1, version: 10, digest: ledgerDigest(ledger), ledger, endpoints: {}, expiresAt }, { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' }), { remoteAddress: '10.0.0.1' });
  assert.equal(local.role, 'manager');
  assert.equal(local.ledger.manager.instanceId, 'inst-self');
  assert.equal(local.ledger.managerTerm, 2);
  assert.equal(local.ledger.version, 11);
  assert.equal(local.ledger.managerWindow.windowBaseTerm, 2);
  assert.ok(harness.sent.some((entry) => entry.type === 'handover' && entry.payload.kind === 'accept'));
  const change = harness.sent.find((entry) => entry.type === 'notice' && entry.payload.event === 'manager-changed');
  assert.ok(change, '新站长签发 manager-changed');
  assert.equal(change.payload.via, 'auto');
  assert.equal(change.payload.offerId, offerId);
  assert.ok(change.payload.windowEndsAt);
  assert.ok(change.payload.digest);
});

test('显式移交：offer 字段齐全；迟到 accept 拒绝；按时 accept 完成并降级', async (t) => {
  const local = localOf({
    role: 'manager',
    ledger: ledgerOf({ members: [{ instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' }] }),
    seats: [seatOf('sess-a', 'manager', 1)],
    endpoints: [['inst-b', { address: '10.0.0.7', port: 17321 }]],
  });
  const harness = stateOf(t, local);
  harness.state.probe = async () => ({ reachable: true });
  const first = await handover(harness.state, { collabId: COLLAB, target: 'inst-b', targetSessionId: 'sess-b' });
  assert.equal(first.ok, true);
  const offer = harness.sent.find((entry) => entry.type === 'handover' && entry.payload.kind === 'offer');
  for (const field of ['offerId', 'baseTerm', 'version', 'digest', 'ledger', 'endpoints', 'expiresAt']) {
    assert.ok(offer.payload[field] !== undefined, `offer 必填字段 ${field}`);
  }
  harness.clock.now = NOW + 200000;
  await handleEvent(harness.state, frameOf('handover', { kind: 'accept', offerId: first.offerId, baseTerm: 1, version: 10, digest: ledgerDigest(local.ledger) }, { instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' }), { remoteAddress: '10.0.0.7' });
  assert.equal(local.role, 'manager', '迟到 accept 不得完成移交');
  assert.ok(harness.sent.some((entry) => entry.type === 'handover' && entry.payload.kind === 'reject' && entry.payload.reason === 'expired'));

  harness.clock.now = NOW;
  const fresh = localOf({
    role: 'manager',
    ledger: ledgerOf({ members: [{ instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' }] }),
    seats: [seatOf('sess-a', 'manager', 1)],
    endpoints: [['inst-b', { address: '10.0.0.7', port: 17321 }]],
  });
  const second = stateOf(t, fresh);
  second.state.probe = async () => ({ reachable: true });
  const again = await handover(second.state, { collabId: COLLAB, target: 'inst-b', targetSessionId: 'sess-b' });
  await handleEvent(second.state, frameOf('handover', { kind: 'accept', offerId: again.offerId, baseTerm: 1, version: 10, digest: ledgerDigest(fresh.ledger) }, { instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' }), { remoteAddress: '10.0.0.7' });
  assert.equal(fresh.role, 'member', '确认后旧站长降级');
  const changed = second.sent.find((entry) => entry.type === 'notice' && entry.payload.event === 'manager-changed');
  assert.equal(changed.payload.via, 'handover');
  assert.equal(changed.payload.term, 2);
  assert.equal(changed.payload.offerId, again.offerId);
});

test('显式移交目标侧：用 offer 台账重算最终台账并校验 digest → 目标提升为站长', async (t) => {
  const manager = { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' };
  const targetSeat = { instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' };
  const ledger = ledgerOf({ manager, members: [targetSeat] });
  const source = localOf({ role: 'manager', ledger: structuredClone(ledger), seats: [seatOf('sess-a', 'manager', 1)], endpoints: [['inst-b', { address: '10.0.0.2', port: 17322 }]] });
  const sourceHarness = stateOf(t, source);
  Object.assign(sourceHarness.state.self, { instanceId: 'inst-a', identityName: '甲' });
  sourceHarness.state.probe = async () => ({ reachable: true });
  const offered = await handover(sourceHarness.state, { collabId: COLLAB, target: 'inst-b', targetSessionId: 'sess-b' });
  const offerPayload = sourceHarness.sent.find((entry) => entry.type === 'handover' && entry.payload.kind === 'offer').payload;

  const target = localOf({ seats: [seatOf('sess-b')], endpoints: [[manager.instanceId, { address: '10.0.0.1', port: 17321 }]], ledger: structuredClone(ledger) });
  const targetHarness = stateOf(t, target);
  Object.assign(targetHarness.state.self, { instanceId: 'inst-b', identityName: '乙', port: 17322 });
  await handleEvent(targetHarness.state, frameOf('handover', offerPayload, { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' }), { remoteAddress: '10.0.0.1' });
  const challenge = confirmHandover(targetHarness.state, { collabId: COLLAB, sessionId: 'sess-b', offerId: offered.offerId });
  assert.equal(challenge.needsUserConfirmation, true);
  const accepted = confirmHandover(targetHarness.state, { collabId: COLLAB, sessionId: 'sess-b', offerId: offered.offerId, token: challenge.token });
  assert.equal(accepted.accepted, true);
  const acceptPayload = targetHarness.sent.find((entry) => entry.type === 'handover' && entry.payload.kind === 'accept').payload;

  await handleEvent(sourceHarness.state, frameOf('handover', acceptPayload, targetSeat), { remoteAddress: '10.0.0.2' });
  const change = sourceHarness.sent.find((entry) => entry.type === 'notice' && entry.payload.event === 'manager-changed');
  assert.ok(change, '旧站长签发 manager-changed');
  await handleEvent(targetHarness.state, frameOf('notice', change.payload, { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' }), { remoteAddress: '10.0.0.1' });
  assert.equal(target.role, 'manager');
  assert.equal(target.ledger.manager.sessionId, 'sess-b');
  assert.equal(target.ledger.managerTerm, 2);
  assert.equal(target.ledger.version, 11);
  assert.equal(source.role, 'member');
});

test('手动接管：先握手取最高、挑战令牌二段式、以最高台账为基准 +1、无窗口', async (t) => {
  const ledger = ledgerOf({ members: [{ instanceId: 'inst-self', sessionId: 'sess-self', identityName: '本机' }] });
  const local = localOf({ seats: [seatOf('sess-self')], endpoints: [['inst-a', { address: '10.0.0.1', port: 17321 }]], ledger });
  const harness = stateOf(t, local);
  m5RuntimeOf(harness.state).managerEvidenceAt.set(COLLAB, NOW - 400000);
  const challenge = await takeOver(harness.state, { collabId: COLLAB, sessionId: 'sess-self' });
  assert.equal(challenge.ok, true);
  assert.equal(challenge.needsUserConfirmation, true);
  assert.ok(challenge.token);
  const done = await takeOver(harness.state, { collabId: COLLAB, sessionId: 'sess-self', token: challenge.token });
  assert.equal(done.ok, true, done.message);
  assert.equal(local.role, 'manager');
  assert.equal(local.ledger.managerTerm, 2);
  assert.equal(local.ledger.manager.sessionId, 'sess-self');
  assert.equal(local.ledger.managerWindow, undefined, '手动接管不开窗');
  const changed = harness.sent.find((entry) => entry.type === 'notice' && entry.payload.event === 'manager-changed');
  assert.equal(changed.payload.via, 'takeover-manual');
});

test('终态快照（manager:null）：同 term 现任站长签发 → 本地只读终态，不抛错', async (t) => {
  const local = localOf({ seats: [seatOf('sess-self')] });
  const { state } = stateOf(t, local);
  const terminal = ledgerOf();
  terminal.version = 11;
  terminal.status = 'completed';
  terminal.manager = null;
  terminal.members = [];
  await handleEvent(state, frameOf('snapshot', { kind: 'data', managerTerm: 1, version: 11, digest: ledgerDigest(terminal), ledger: terminal }, { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' }), { remoteAddress: '10.0.0.1' });
  assert.equal(local.member.state, 'completed');
  assert.equal(local.snapshot.ledger.manager, null, '本地只读终态');
  assert.equal(m5RuntimeOf(state).frozen.has(COLLAB), false);
});

test('终态恢复：本地终态 + 本地 auto-offer 授权 → 更高 term 权威台账可覆盖；非法来源/同 term 拒绝', async (t) => {
  const managerA = { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' };
  const managerC = { instanceId: 'inst-c', sessionId: 'sess-c', identityName: '丙' };
  const local = localOf({ seats: [seatOf('sess-self')], endpoints: [[managerC.instanceId, { address: '10.0.0.3', port: 17321 }]] });
  const harness = stateOf(t, local);
  const terminal = ledgerOf({ manager: managerA });
  terminal.version = 11;
  terminal.status = 'completed';
  terminal.manager = null;
  terminal.members = [];
  await handleEvent(harness.state, frameOf('snapshot', { kind: 'data', managerTerm: 1, version: 11, digest: ledgerDigest(terminal), ledger: terminal }, managerA), { remoteAddress: '10.0.0.1' });
  assert.equal(local.member.state, 'completed');

  await handleEvent(harness.state, frameOf('notice', {
    event: 'auto-offer', offerId: 'offer-recover', prevManager: { instanceId: 'inst-a', sessionId: 'sess-a' },
    target: { instanceId: 'inst-c', sessionId: 'sess-c' }, baseTerm: 1, version: 11, expiresAt: iso(NOW + 60000),
  }, managerC), { remoteAddress: '10.0.0.3' });
  const recovery = ledgerOf({ term: 2, version: 12, manager: managerC });
  await handleEvent(harness.state, frameOf('snapshot', { kind: 'data', managerTerm: 2, version: 12, digest: ledgerDigest(recovery), ledger: recovery }, managerC), { remoteAddress: '10.0.0.3' });
  assert.equal(local.member.manager.instanceId, 'inst-c', '经本地 auto-offer 授权的终态恢复');
  assert.equal(local.member.state, 'active');

  const other = localOf({ seats: [seatOf('sess-self')] });
  const otherHarness = stateOf(t, other);
  await handleEvent(otherHarness.state, frameOf('snapshot', { kind: 'data', managerTerm: 1, version: 11, digest: ledgerDigest(terminal), ledger: terminal }, managerA), { remoteAddress: '10.0.0.1' });
  const forged = ledgerOf({ term: 2, version: 12, manager: { instanceId: 'inst-d', sessionId: 'sess-d', identityName: '丁' } });
  await handleEvent(otherHarness.state, frameOf('snapshot', { kind: 'data', managerTerm: 2, version: 12, digest: ledgerDigest(forged), ledger: forged }, { instanceId: 'inst-d', sessionId: 'sess-d', identityName: '丁' }), { remoteAddress: '10.0.0.4' });
  assert.equal(other.member.manager.instanceId, 'inst-a', '非法来源不得恢复权威台账');
  assert.equal(m5RuntimeOf(otherHarness.state).frozen.has(COLLAB), false, '终态恢复失败只拒收计数，不冻结');

  const sameTerm = ledgerOf({ term: 1, version: 12, manager: managerA });
  await handleEvent(otherHarness.state, frameOf('snapshot', { kind: 'data', managerTerm: 1, version: 12, digest: ledgerDigest(sameTerm), ledger: sameTerm }, managerA), { remoteAddress: '10.0.0.1' });
  assert.equal(other.member.manager.instanceId, 'inst-a', '同 term 无受理记录不得覆盖终态');
});

test('M4 接线：invite 登记挂起邀请、approve 携 inviteId 转加入域、快照含本席清 unverified', async (t) => {
  const calls = { invite: [], approval: [] };
  const local = localOf({ seats: [seatOf('sess-self')] });
  const harness = stateOf(t, local, {
    state: {
      join: {
        handleInviteFrame: (frame) => {
          calls.invite.push(frame.payload.inviteId);
          return { ok: true };
        },
        handleInviteApproval: (frame) => {
          calls.approval.push(frame.payload.inviteId);
          return { ok: true, action: 'joining' };
        },
      },
    },
  });
  await handleEvent(harness.state, frameOf('invite', {
    inviteId: 'inv-1', members: [{ instanceId: 'inst-a', identityName: '甲' }], name: '项目', topic: '主题', mode: 'managed',
  }, { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' }), { remoteAddress: '10.0.0.1' });
  assert.deepEqual(calls.invite, ['inv-1']);

  const manager = localOf({ role: 'manager', seats: [seatOf('sess-a', 'manager', 1)] });
  const managerHarness = stateOf(t, manager, {
    state: { join: { handleInviteApproval: (frame) => { calls.approval.push(frame.payload.inviteId); return { ok: true, action: 'joining' }; } } },
  });
  await handleEvent(managerHarness.state, frameOf('approve', { inviteId: 'inv-2' }, { instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' }), { remoteAddress: '10.0.0.2' });
  assert.deepEqual(calls.approval, ['inv-2']);

  const unverifiedSeat = { ...seatOf('sess-self'), unverified: true };
  const memberLedger = ledgerOf({ members: [{ instanceId: 'inst-self', sessionId: 'sess-self', identityName: '本机' }] });
  const unverified = localOf({ seats: [unverifiedSeat], ledger: memberLedger });
  const unverifiedHarness = stateOf(t, unverified);
  const next = ledgerOf({ version: 11, members: [{ instanceId: 'inst-self', sessionId: 'sess-self', identityName: '本机' }] });
  await handleEvent(unverifiedHarness.state, frameOf('snapshot', { kind: 'data', managerTerm: 1, version: 11, digest: ledgerDigest(next), ledger: next }, { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' }), { remoteAddress: '10.0.0.1' });
  assert.equal(unverified.seats.get('sess-self').unverified, false, '快照含本席即清除 unverified');
});

test('sync 两件套：应答帧携 fromSessionId（0.2.0 帧身份）', async (t) => {
  const ledger = ledgerOf({ mode: 'forum', members: [{ instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' }] });
  const local = localOf({ ledger, seats: [seatOf('sess-f')], endpoints: [['inst-b', { address: '10.0.0.7', port: 17321 }]] });
  local.member.mode = 'forum';
  local.member.syncCursor = null;
  local.posts = { entries: () => [] };
  local.members = { events: () => [], fold: () => [{ instanceId: 'inst-self', identityName: '本机' }], includes: () => true, latestEventOf: () => null };
  const harness = stateOf(t, local);
  let direct = null;
  harness.state.sendDirect = (message) => {
    direct = message;
    return { ok: true, msgId: 'direct-1' };
  };
  await handleEvent(harness.state, frameOf('history-request', { after: null, summary: { authors: [] } }, { instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' }), { remoteAddress: '10.0.0.7' });
  assert.ok(direct, 'bundle 已发出');
  assert.equal(direct.type, 'history-bundle');
  assert.equal(direct.fromSessionId, 'sess-f');
});
