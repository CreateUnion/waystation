import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir } from './helpers.js';
import { collabDir } from '../src/paths.js';
import { ledgerDigest } from '../src/collab/store.js';
import { handleEvent } from '../src/collab/events.js';
import { confirmHandover, handover } from '../src/collab/handover.js';
import {
  applyManagerFreeze, autoTransfer, clearFreezeReason, clearManagerFreeze, m5RuntimeOf, noteSeatClosed, persistFreezeReason,
  runPresenceTick, runProbeTick, sweepSeatGrace, takeOver,
} from '../src/collab/takeover.js';
import { rejectHandover, restoreM5State } from '../src/collab/handover.js';

/* M5 接线（设计 §2A/§3.2）：任期受理、auto 追赶门、快照生产端、presence 直连/中继、
 * 离席留痕、自动/显式移交与手动接管。夹具直接构造共享态与席位表，不经协议层形态预检。 */

/* 接管对表等待面用 unref 定时器（生产语义：会话关闭即退出）；本文件有「无外部事件」的等待轮次，
 * 须有外部定时器托住事件循环，否则 runner 判循环已空而取消用例。 */
const keepAlive = setInterval(() => {}, 20);
after(() => {
  clearInterval(keepAlive);
});

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
    snapshot: options.snapshot === null || role === 'manager' ? null : snapshotOf(ledger, manager),
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
  const mono = { now: 1000 };
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
    monoClock: () => mono.now,
    ...(overrides.state ?? {}),
  };
  return { state, sent, notified, dir, clock, mono };
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
  m5RuntimeOf(state).managerEvidenceAt.set(COLLAB, 1000 - 400000);
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
  await handleEvent(harness.state, frameOf('seat-presence', notice), { remoteAddress: '10.0.0.7', peerInstanceId: 'inst-b' });
  const entry = [...m5RuntimeOf(harness.state).presence.values()].find((item) => item.sessionId === 'sess-b');
  assert.ok(entry, '直连列表刷新');
  await handleEvent(harness.state, frameOf('seat-presence', { ...notice, originMsgId: 'origin-1' }), { remoteAddress: '10.0.0.7', peerInstanceId: 'inst-b' });
  assert.ok((harness.state.counters.presenceRejected ?? 0) >= 1, 'managed 转达一律拒收');

  const forum = localOf({ ledger: ledgerOf({ mode: 'forum', members: [{ instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' }] }), seats: [seatOf('sess-f')], endpoints: [['inst-r', { address: '10.0.0.8', port: 17321 }], ['inst-b', { address: '10.0.0.7', port: 17321 }]] });
  forum.member.originator = { instanceId: 'inst-r', identityName: '中继' };
  forum.member.mode = 'forum';
  const forumHarness = stateOf(t, forum);
  const relayed = { ...notice, originMsgId: 'origin-2' };
  await handleEvent(forumHarness.state, frameOf('seat-presence', relayed), { remoteAddress: '10.0.0.8', peerInstanceId: 'inst-r' });
  assert.ok([...m5RuntimeOf(forumHarness.state).presence.values()].some((item) => item.sessionId === 'sess-b'), '当前中继转发的列表按原发机器刷新');
  const before = forumHarness.state.counters.presenceRejected ?? 0;
  await handleEvent(forumHarness.state, frameOf('seat-presence', { ...notice, originMsgId: 'origin-3' }), { remoteAddress: '10.0.0.7', peerInstanceId: 'inst-b' });
  assert.equal(forumHarness.state.counters.presenceRejected ?? 0, before + 1, '非中继连接转达拒收');
  harness.state.monoClock = () => 424242;
  await handleEvent(harness.state, frameOf('seat-presence', { ...notice, sessions: ['sess-b'] }), { remoteAddress: '10.0.0.7', peerInstanceId: 'inst-b' });
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

test('手动接管：零应答拒绝；有成员应答时挑战令牌二段式、以最高台账为基准 +1、无窗口', async (t) => {
  const ledger = ledgerOf({ members: [
    { instanceId: 'inst-self', sessionId: 'sess-self', identityName: '本机' },
    { instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' },
  ] });
  const local = localOf({ seats: [seatOf('sess-self')], endpoints: [['inst-a', { address: '10.0.0.1', port: 17321 }]], ledger });
  const harness = stateOf(t, local);
  m5RuntimeOf(harness.state).managerEvidenceAt.set(COLLAB, harness.mono.now - 400000);
  const zeroAck = await takeOver(harness.state, { collabId: COLLAB, sessionId: 'sess-self' });
  assert.equal(zeroAck.ok, false, '尚有其他成员却零应答：不得用本机旧台账宣告接管');
  assert.ok(zeroAck.message.includes('零应答'), zeroAck.message);

  const pending = takeOver(harness.state, { collabId: COLLAB, sessionId: 'sess-self' });
  m5RuntimeOf(harness.state).handshakeResponses.set(COLLAB, new Map([['inst-a', {
    term: 1,
    version: 10,
    manager: { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' },
    seat: { instanceId: 'inst-a', sessionId: 'sess-a' },
  }]]));
  const challenge = await pending;
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
  }, managerA), { remoteAddress: '10.0.0.1' });
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

test('A5/A9/A11/A12/A14 接线：前提不成立拒收、低 term 拒收、同 term 名单快照受理与分叉冻结', async (t) => {
  const managerB = { instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' };
  const managerC = { instanceId: 'inst-c', sessionId: 'sess-c', identityName: '丙' };
  const base = localOf({ seats: [seatOf('sess-self')], ledger: ledgerOf({ members: [managerC] }) });
  const baseHarness = stateOf(t, base);
  await handleEvent(baseHarness.state, frameOf('notice', changeOf({
    via: 'takeover', term: 2, version: 11, manager: managerC,
    prevManager: { instanceId: 'inst-a', sessionId: 'sess-a' }, windowBaseTerm: 1, authorizedAt: iso(),
  }), managerC), { remoteAddress: '10.0.0.3' });
  assert.equal(base.member.manager.instanceId, 'inst-a', 'A5：无本地窗口基准的 takeover 拒收');
  assert.equal(baseHarness.state.counters.termRejects, 1);

  const behindLedger = ledgerOf({ term: 2, version: 12, manager: managerB });
  const behind = localOf({ seats: [seatOf('sess-self')], ledger: behindLedger });
  const behindHarness = stateOf(t, behind);
  await handleEvent(behindHarness.state, frameOf('notice', changeOf({
    via: 'handover', term: 1, version: 11, manager: managerC,
    prevManager: { instanceId: 'inst-a', sessionId: 'sess-a' }, offerId: 'offer-a9',
  }), { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' }), { remoteAddress: '10.0.0.1' });
  assert.equal(behind.member.manager.instanceId, 'inst-b', 'A9：低 term 变更拒收');
  assert.equal(behindHarness.state.counters.termRejects, 1);

  const nextLedger = ledgerOf({ term: 2, version: 13, manager: managerB });
  await handleEvent(behindHarness.state, frameOf('snapshot', { kind: 'data', managerTerm: 2, version: 13, digest: ledgerDigest(nextLedger), ledger: nextLedger }, managerB), { remoteAddress: '10.0.0.2' });
  assert.equal(behind.snapshot.version, 13, 'A11：同 term 同 manager 的更高 version 快照受理');

  const olderLedger = ledgerOf({ term: 1, version: 99, manager: managerB });
  await handleEvent(behindHarness.state, frameOf('snapshot', { kind: 'data', managerTerm: 1, version: 99, digest: ledgerDigest(olderLedger), ledger: olderLedger }, managerB), { remoteAddress: '10.0.0.2' });
  assert.equal(behind.snapshot.version, 13, 'A14：低 term 快照拒收');

  const forkLedger = ledgerOf({ term: 2, version: 14, manager: managerC });
  await handleEvent(behindHarness.state, frameOf('snapshot', { kind: 'data', managerTerm: 2, version: 14, digest: ledgerDigest(forkLedger), ledger: forkLedger }, managerC), { remoteAddress: '10.0.0.3' });
  assert.equal(m5RuntimeOf(behindHarness.state).frozen.get(COLLAB), 'manager-fork', 'A12：同 term 不同 manager 的快照冻结');
  assert.equal(behind.snapshot.version, 13, '分叉快照不得按高 version 采纳');
});

test('C1 时钟域：合法 seat-presence 后墙钟前跳不冻结；单调钟超时才冻结', async (t) => {
  const local = localOf({ seats: [seatOf('sess-self')], endpoints: [['inst-a', { address: '10.0.0.1', port: 17321 }]] });
  const harness = stateOf(t, local);
  await handleEvent(harness.state, frameOf('seat-presence', { collabId: COLLAB, instanceId: 'inst-a', sessions: ['sess-a'], sentAt: iso() }, { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' }), { remoteAddress: '10.0.0.1', peerInstanceId: 'inst-a' });
  assert.equal(m5RuntimeOf(harness.state).managerEvidenceAt.get(COLLAB), harness.mono.now, 'manager 证据写单调钟');
  harness.clock.now = NOW + 10 * 60 * 1000;
  harness.mono.now += 1000;
  runPresenceTick(harness.state);
  assert.equal(m5RuntimeOf(harness.state).frozen.has(COLLAB), false, '墙钟前跳不得冻结（presence 只与同域比较）');
  harness.mono.now += 400000;
  runPresenceTick(harness.state);
  assert.equal(m5RuntimeOf(harness.state).frozen.get(COLLAB), 'manager-offline', '单调钟超过失联时限才冻结');
});

test('I5/C1 同机自动继任：宽限到期后同机席位被选中并提升（不依赖网络端点）', async (t) => {
  const ledger = ledgerOf({ members: [{ instanceId: 'inst-self', sessionId: 'sess-b', identityName: '乙' }] });
  const local = localOf({ role: 'manager', ledger, seats: [seatOf('sess-a', 'manager', 1), seatOf('sess-b')], endpoints: [] });
  const harness = stateOf(t, local);
  noteSeatClosed(harness.state, COLLAB, 'sess-a', harness.clock.now);
  sweepSeatGrace(harness.state, harness.clock.now + 2000);
  assert.equal(local.role, 'manager');
  assert.equal(local.ledger.manager.sessionId, 'sess-b', '同机继任者被提升');
  assert.equal(local.ledger.managerTerm, 2);
  assert.ok(local.ledger.managerWindow, '自动移交开 1 分钟窗口');
  assert.equal(local.seats.get('sess-b').role, 'manager');
  assert.equal(local.seats.get('sess-a'), undefined, '旧站长席位已移除');
});

test('C2 首份快照：无基线成员收到站长自洽快照 → 落库、清 unverified；伪造来源仍拒收', async (t) => {
  const manager = { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' };
  const memberRow = { instanceId: 'inst-self', sessionId: 'sess-self', identityName: '本机' };
  const ledger = ledgerOf({ manager, members: [memberRow] });
  const seat = { ...seatOf('sess-self'), unverified: true };
  const local = localOf({ seats: [seat], snapshot: null, endpoints: [['inst-a', { address: '10.0.0.1', port: 17321 }]] });
  const harness = stateOf(t, local);
  await handleEvent(harness.state, frameOf('snapshot', { kind: 'data', managerTerm: 1, version: 10, digest: ledgerDigest(ledger), ledger }, manager), { remoteAddress: '10.0.0.1' });
  assert.ok(local.snapshot, '首份快照落库');
  assert.equal(harness.state.counters.snapshotBaselineAdopted, 1);
  assert.equal(local.seats.get('sess-self').unverified, false, '快照含本席即清 unverified');
  assert.equal(local.member.state, 'active');

  const otherSeat = { ...seatOf('sess-self'), unverified: true };
  const other = localOf({ seats: [otherSeat], snapshot: null });
  const otherHarness = stateOf(t, other);
  await handleEvent(otherHarness.state, frameOf('snapshot', { kind: 'data', managerTerm: 1, version: 10, digest: ledgerDigest(ledger), ledger }, { instanceId: 'inst-d', sessionId: 'sess-d', identityName: '丁' }), { remoteAddress: '10.0.0.4' });
  assert.equal(other.snapshot, null, '非邀请/批准记录中的站长不得建立基线');
  assert.ok((otherHarness.state.counters.snapshotCorrupt ?? 0) >= 1);
});

test('C3 伪造 auto-offer + 自签 auto → 拒绝（offer 来源必须是本地现任站长）', async (t) => {
  const attacker = { instanceId: 'inst-c', sessionId: 'sess-c', identityName: '丙' };
  const local = localOf({ seats: [seatOf('sess-self')] });
  const harness = stateOf(t, local);
  await handleEvent(harness.state, frameOf('notice', {
    event: 'auto-offer', offerId: 'forged-offer', prevManager: { instanceId: 'inst-a', sessionId: 'sess-a' },
    target: attacker, baseTerm: 1, version: 10, expiresAt: iso(NOW + 60000),
  }, attacker), { remoteAddress: '10.0.0.3' });
  assert.equal((harness.state.counters.autoOfferRejected ?? 0), 1, '非现任站长签发的 auto-offer 丢弃');
  assert.equal(m5RuntimeOf(harness.state).autoOffers.size, 0);
  await handleEvent(harness.state, frameOf('notice', changeOf({
    via: 'auto', term: 2, version: 11, manager: attacker,
    prevManager: { instanceId: 'inst-a', sessionId: 'sess-a' }, offerId: 'forged-offer',
    windowEndsAt: iso(NOW + 60000), authorizedAt: iso(),
  }), attacker), { remoteAddress: '10.0.0.3' });
  assert.equal(local.member.manager.instanceId, 'inst-a', '自签 auto 不得改朝换代');
  assert.equal(m5RuntimeOf(harness.state).frozen.has(COLLAB), false);
});

test('C4/C6 陈旧 handover offer 与冻结/auto 在途的 takeover-manual 均不得绕过受理表', async (t) => {
  const target = { instanceId: 'inst-self', sessionId: 'sess-self', identityName: '本机' };
  const oldLedger = ledgerOf();
  const currentLedger = ledgerOf({ term: 2, version: 12, manager: { instanceId: 'inst-c', sessionId: 'sess-c', identityName: '丙' }, members: [target] });
  const local = localOf({ seats: [seatOf('sess-self')], ledger: currentLedger });
  const harness = stateOf(t, local);
  const record = {
    offerId: 'offer-old', baseTerm: 1, version: 10, digest: ledgerDigest(oldLedger), ledger: oldLedger,
    from: { instanceId: 'inst-a', sessionId: 'sess-a' }, target, state: 'accepted', expiresAt: iso(NOW + 60000),
  };
  m5RuntimeOf(harness.state).handoverOffers.set(COLLAB, new Map([[record.offerId, record]]));
  await handleEvent(harness.state, frameOf('notice', changeOf({
    via: 'handover', term: 2, version: 11, manager: target,
    prevManager: { instanceId: 'inst-a', sessionId: 'sess-a' }, offerId: 'offer-old',
  }), { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' }), { remoteAddress: '10.0.0.1' });
  assert.equal(local.role, 'member', '陈旧 offer 不得直接提升目标');
  assert.equal(local.snapshot.ledger.manager.instanceId, 'inst-c', '本地任期不被降回');

  const managerLedger = ledgerOf({ members: [{ instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' }] });
  const managerLocal = localOf({ role: 'manager', ledger: managerLedger, seats: [seatOf('sess-a', 'manager', 1)] });
  const managerHarness = stateOf(t, managerLocal);
  m5RuntimeOf(managerHarness.state).autoPending.set(COLLAB, {
    offerId: 'auto-live', prevManager: { instanceId: 'inst-a', sessionId: 'sess-a' },
    target: { instanceId: 'inst-b', sessionId: 'sess-b' }, baseTerm: 1, version: 10, expiresAt: iso(NOW + 60000),
  });
  await handleEvent(managerHarness.state, frameOf('notice', changeOf({
    via: 'takeover-manual', term: 2, version: 11, manager: { instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' },
    prevManager: { instanceId: 'inst-a', sessionId: 'sess-a' }, authorizedAt: iso(),
  }), { instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' }), { remoteAddress: '10.0.0.2' });
  assert.equal(managerLocal.role, 'manager', 'auto 在途时旧站长不被第三方接管');
  assert.equal(managerLocal.ledger.managerTerm, 1);
});

test('C5 同机显式移交：offer 落核内、confirm 找到、完成后目标席位升站长、旧站长降 member', async (t) => {
  const ledger = ledgerOf({ manager: { instanceId: 'inst-self', sessionId: 'sess-a', identityName: '本机' }, members: [{ instanceId: 'inst-self', sessionId: 'sess-b', identityName: '乙' }] });
  const local = localOf({ role: 'manager', ledger, seats: [seatOf('sess-a', 'manager', 1), seatOf('sess-b')], endpoints: [] });
  const harness = stateOf(t, local);
  const offered = await handover(harness.state, { collabId: COLLAB, target: 'inst-self', targetSessionId: 'sess-b' });
  assert.equal(offered.ok, true, offered.message);
  assert.ok(m5RuntimeOf(harness.state).handoverOffers.get(COLLAB)?.get(offered.offerId), '同机 offer 落核内记录');
  const challenge = confirmHandover(harness.state, { collabId: COLLAB, sessionId: 'sess-b', offerId: offered.offerId });
  assert.equal(challenge.needsUserConfirmation, true);
  const accepted = confirmHandover(harness.state, { collabId: COLLAB, sessionId: 'sess-b', offerId: offered.offerId, token: challenge.token });
  assert.equal(accepted.accepted, true, accepted.message);
  assert.equal(local.role, 'manager');
  assert.equal(local.ledger.manager.sessionId, 'sess-b', '目标席位升为站长');
  assert.equal(local.ledger.managerTerm, 2);
  assert.equal(local.seats.get('sess-b').role, 'manager');
  assert.equal(local.seats.get('sess-a').role, 'member', '旧站长降为成员（不删行）');
  assert.equal(local.ledger.members.some((row) => row.sessionId === 'sess-a'), true);
  assert.equal(m5RuntimeOf(harness.state).pendingHandovers.has(COLLAB), false);
  assert.equal(local.suspended, null, '完成即恢复写');
});

test('C5 同机显式移交拒绝：rejectHandover 作废记录并解挂', async (t) => {
  const ledger = ledgerOf({ manager: { instanceId: 'inst-self', sessionId: 'sess-a', identityName: '本机' }, members: [{ instanceId: 'inst-self', sessionId: 'sess-b', identityName: '乙' }] });
  const local = localOf({ role: 'manager', ledger, seats: [seatOf('sess-a', 'manager', 1), seatOf('sess-b')], endpoints: [] });
  const harness = stateOf(t, local);
  const offered = await handover(harness.state, { collabId: COLLAB, target: 'inst-self', targetSessionId: 'sess-b' });
  const rejected = rejectHandover(harness.state, { collabId: COLLAB, sessionId: 'sess-b', offerId: offered.offerId, reason: 'rejected' });
  assert.equal(rejected.ok, true, rejected.message);
  assert.equal(m5RuntimeOf(harness.state).pendingHandovers.has(COLLAB), false);
  assert.equal(local.suspended, null, '拒绝后恢复写');
});

test('I1 采纳 auto 后清理 autoPending/定时器；迟到定时器不再抛异常', async (t) => {
  const member = { instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' };
  const ledger = ledgerOf({ members: [member] });
  const local = localOf({ role: 'manager', ledger, seats: [seatOf('sess-a', 'manager', 1)], endpoints: [['inst-b', { address: '10.0.0.7', port: 17321 }]] });
  const harness = stateOf(t, local, { config: { dialTimeoutMs: 5 } });
  const dispatched = autoTransfer(harness.state, { collabId: COLLAB, managerSessionId: 'sess-a' });
  assert.equal(dispatched.ok, true, JSON.stringify(dispatched));
  assert.equal(m5RuntimeOf(harness.state).autoPending.size, 1);
  await handleEvent(harness.state, frameOf('notice', changeOf({
    via: 'auto', term: 2, version: 11, manager: member,
    prevManager: { instanceId: 'inst-a', sessionId: 'sess-a' }, offerId: dispatched.offerId,
    windowEndsAt: iso(NOW + 60000), authorizedAt: iso(),
  }), member), { remoteAddress: '10.0.0.7' });
  assert.equal(local.role, 'member', '旧站长降级');
  assert.equal(m5RuntimeOf(harness.state).autoPending.size, 0);
  assert.equal(m5RuntimeOf(harness.state).autoAcceptTimers.size, 0, '定时器已清理');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(harness.state.counters.eventFailures ?? 0, 0, '清理后的迟到定时器不得抛异常/计数');
});

test('I2 重启恢复：manager-pending 恢复冻结与只读；handover offer 恢复后可继续确认', async (t) => {
  const manager = { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' };
  const ledger = ledgerOf({ manager, members: [{ instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' }] });
  const local = localOf({ role: 'manager', ledger, seats: [seatOf('sess-a', 'manager', 1)] });
  const harness = stateOf(t, local);
  mkdirSync(join(collabDir(harness.dir, COLLAB), 'run'), { recursive: true });
  writeFileSync(join(collabDir(harness.dir, COLLAB), 'run', 'manager-pending.json'), JSON.stringify({
    offerId: 'offer-pending', collabId: COLLAB, target: { instanceId: 'inst-b', sessionId: 'sess-b' },
    baseTerm: 1, version: 10, digest: 'd'.repeat(64), expiresAt: iso(NOW + 60000), at: iso(),
  }), { encoding: 'utf8', flag: 'w' });
  restoreM5State(harness.state);
  assert.equal(m5RuntimeOf(harness.state).managerPending.has(COLLAB), true);
  assert.equal(m5RuntimeOf(harness.state).frozen.get(COLLAB), 'manager-pending');
  assert.equal(local.suspended.reason, 'manager-pending');
  assert.equal(local.suspended.deadline, null, '冻结期停写无到期解挂');
  harness.clock.now = NOW + 10 * 60 * 1000;
  runProbeTick(harness.state);
  assert.notEqual(local.suspended, null, '125s/到期不得恢复写');

  const memberLocal = localOf({ seats: [seatOf('sess-self')], endpoints: [['inst-a', { address: '10.0.0.1', port: 17321 }]] });
  const memberHarness = stateOf(t, memberLocal);
  mkdirSync(collabDir(memberHarness.dir, COLLAB), { recursive: true });
  writeFileSync(join(collabDir(memberHarness.dir, COLLAB), 'handover-offers.json'), JSON.stringify({
    version: 1,
    offers: [{
      offerId: 'offer-restored', collabId: COLLAB, baseTerm: 1, version: 10, digest: ledgerDigest(ledger),
      ledger, endpoints: {}, from: { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' },
      expiresAt: iso(NOW + 60000), state: 'open',
    }],
  }), 'utf8');
  restoreM5State(memberHarness.state);
  const challenge = confirmHandover(memberHarness.state, { collabId: COLLAB, sessionId: 'sess-self', offerId: 'offer-restored' });
  assert.equal(challenge.needsUserConfirmation, true, '恢复的未过期 offer 可继续确认');
});

test('I3 A6 term 跳跃：执行 handshake 并在失联时限内不能同步 → 冻结 manager-fork', async (t) => {
  const rival = { instanceId: 'inst-c', sessionId: 'sess-c', identityName: '丙' };
  const local = localOf({ seats: [seatOf('sess-self')], endpoints: [['inst-a', { address: '10.0.0.1', port: 17321 }]] });
  const harness = stateOf(t, local, { config: { managerLossTimeoutMs: 20 } });
  await handleEvent(harness.state, frameOf('notice', changeOf({
    via: 'takeover', term: 3, version: 13, manager: rival,
    prevManager: { instanceId: 'inst-a', sessionId: 'sess-a' }, windowBaseTerm: 1, authorizedAt: iso(),
  }), rival), { remoteAddress: '10.0.0.3' });
  assert.ok(harness.sent.some((entry) => entry.type === 'notice' && entry.payload.event === 'handshake'), 'A6 先握手对表');
  assert.equal(m5RuntimeOf(harness.state).frozen.has(COLLAB), false);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(m5RuntimeOf(harness.state).frozen.get(COLLAB), 'manager-fork', '同步超时按 A6 冻结');
});

test('I4 分叉授权证据：更高 term takeover 被拒后，匹配快照可收敛并解除冻结', async (t) => {
  const rival = { instanceId: 'inst-c', sessionId: 'sess-c', identityName: '丙' };
  const local = localOf({ seats: [seatOf('sess-self')] });
  const harness = stateOf(t, local);
  await handleEvent(harness.state, frameOf('notice', changeOf({
    via: 'takeover-manual', term: 3, version: 13, manager: rival,
    prevManager: { instanceId: 'inst-a', sessionId: 'sess-a' }, authorizedAt: iso(),
  }), rival), { remoteAddress: '10.0.0.3' });
  assert.equal(harness.state.counters.authorizedEvidenceRecorded, 1, '拒绝时记录可绑定证据');
  await handleEvent(harness.state, frameOf('notice', changeOf({
    via: 'handover', term: 1, version: 11, manager: { instanceId: 'inst-d', sessionId: 'sess-d', identityName: '丁' },
    prevManager: { instanceId: 'inst-a', sessionId: 'sess-a' }, offerId: 'offer-fork',
  }), { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' }), { remoteAddress: '10.0.0.1' });
  assert.equal(m5RuntimeOf(harness.state).frozen.get(COLLAB), 'manager-fork', '同 term 冲突冻结');
  const recovery = ledgerOf({ term: 3, version: 13, manager: rival });
  await handleEvent(harness.state, frameOf('snapshot', { kind: 'data', managerTerm: 3, version: 13, digest: ledgerDigest(recovery), ledger: recovery }, rival), { remoteAddress: '10.0.0.3' });
  assert.equal(local.member.manager.instanceId, 'inst-c', '携授权证据的匹配快照收敛');
  assert.equal(m5RuntimeOf(harness.state).frozen.has(COLLAB), false);
});

test('I11 终态采纳（站长分支）：席位降级、保留只读终态，重启不再以站长复活', async (t) => {
  const local = localOf({ role: 'manager', seats: [seatOf('sess-a', 'manager', 1)] });
  const harness = stateOf(t, local);
  const terminal = ledgerOf();
  terminal.version = 11;
  terminal.status = 'completed';
  terminal.manager = null;
  terminal.members = [];
  await handleEvent(harness.state, frameOf('snapshot', { kind: 'data', managerTerm: 1, version: 11, digest: ledgerDigest(terminal), ledger: terminal }, { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' }), { remoteAddress: '10.0.0.1' });
  assert.equal(local.role, 'member', '不再以站长身份持有');
  assert.equal(local.ledger, null);
  assert.equal(local.snapshot.ledger.manager, null, '本地只读终态副本');
  assert.equal(local.seats.get('sess-a').role, 'member', '席位缓存同步降级');
  assert.equal(local.member.state, 'completed');
});

test('同机移交：targetSessionId 接受短码精确匹配；短码歧义拒绝', async (t) => {
  const ledger = ledgerOf({ manager: { instanceId: 'inst-self', sessionId: 'sess-aaaa1111', identityName: '本机' }, members: [
    { instanceId: 'inst-self', sessionId: 'sess-bbbb2222', identityName: '乙' },
    { instanceId: 'inst-self', sessionId: 'sess-bbbb3333', identityName: '丙' },
    { instanceId: 'inst-self', sessionId: 'sess-cccc2222', identityName: '丁' },
  ] });
  const local = localOf({
    role: 'manager',
    ledger,
    seats: [seatOf('sess-aaaa1111', 'manager', 1), seatOf('sess-bbbb2222', 2), seatOf('sess-bbbb3333', 3), seatOf('sess-cccc2222', 4)],
    endpoints: [],
  });
  const harness = stateOf(t, local);
  const ambiguous = await handover(harness.state, { collabId: COLLAB, target: 'inst-self', targetSessionId: 'sess-bbb' });
  assert.equal(ambiguous.ok, false, '同短码多命中拒绝');
  const matched = await handover(harness.state, { collabId: COLLAB, target: 'inst-self', targetSessionId: 'sess-ccc' });
  assert.equal(matched.ok, true, '短码精确命中唯一席位');
  assert.equal(m5RuntimeOf(harness.state).handoverOffers.get(COLLAB).get(matched.offerId).target.sessionId, 'sess-cccc2222');
});

test('成员侧最后一人离席（站长不可达）→ 本地只读终态副本 localTerminal', async (t) => {
  const local = localOf({ seats: [seatOf('sess-self')], endpoints: [] });
  const harness = stateOf(t, local, { config: { sessionSeatGraceMs: 1 } });
  noteSeatClosed(harness.state, COLLAB, 'sess-self', harness.clock.now);
  sweepSeatGrace(harness.state, harness.clock.now + 2000);
  assert.equal(local.member.state, 'completed');
  assert.equal(local.snapshot.ledger.localTerminal, true);
  assert.deepEqual(local.snapshot.ledger.members, []);
  assert.equal(local.snapshot.ledger.manager, null);
  assert.equal(local.snapshot.ledger.managerTerm, 1);
  assert.equal(local.snapshot.ledger.version, 11);
});

test('冲突检出面透传 sessionId（合流邀请可指名到会话）', async (t) => {
  const local = localOf({ seats: [seatOf('sess-self')] });
  local.member.roster = [{ instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' }];
  const harness = stateOf(t, local);
  const freezeFrame = {
    ...frameOf('freeze', {
      name: '项目',
      members: [
        { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' },
        { instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' },
      ],
      reason: '同名冲突',
    }, { instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' }),
    collabId: 'collab-peer',
  };
  await handleEvent(harness.state, freezeFrame, { remoteAddress: '10.0.0.2' });
  assert.equal(local.conflictRival.name, '项目');
  assert.equal(local.conflictRival.members[0].sessionId, 'sess-a', '冲突检出保留席位键');
  assert.equal(local.conflictRival.members[1].sessionId, 'sess-b');
});

test('I12 席位移除调用 releaseJoining（M4 生命周期义务）', async (t) => {
  const calls = [];
  const local = localOf({ role: 'manager', ledger: ledgerOf({ members: [{ instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' }] }), seats: [seatOf('sess-a', 'manager', 1)] });
  const harness = stateOf(t, local, { state: { join: { releaseJoining: (collabId, sessionId) => calls.push([collabId, sessionId]) } } });
  await handleEvent(harness.state, frameOf('leave', {}, { instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' }), { remoteAddress: '10.0.0.7' });
  assert.deepEqual(calls, [[COLLAB, 'sess-b']]);
});

test('I7 forum presence 经中继转发：originMsgId 保留、from 保持原发机器', async (t) => {
  const ledger = ledgerOf({ mode: 'forum', members: [{ instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' }] });
  const local = localOf({ ledger, seats: [seatOf('sess-f')], endpoints: [['inst-c', { address: '10.0.0.3', port: 17321 }]] });
  local.member.mode = 'forum';
  local.member.originator = { instanceId: 'inst-self', identityName: '本机' };
  local.member.roster = [
    { instanceId: 'inst-self', identityName: '本机' },
    { instanceId: 'inst-b', identityName: '乙' },
    { instanceId: 'inst-c', identityName: '丙' },
  ];
  const harness = stateOf(t, local);
  await handleEvent(harness.state, frameOf('seat-presence', { collabId: COLLAB, instanceId: 'inst-b', sessions: ['sess-b'], sentAt: iso() }, { instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' }), { remoteAddress: '10.0.0.7', peerInstanceId: 'inst-b' });
  const relayed = harness.sent.find((entry) => entry.type === 'seat-presence' && entry.to.instanceId === 'inst-c');
  assert.ok(relayed, '中继转发给其余成员');
  assert.ok(relayed.payload.originMsgId, '转发副本带 originMsgId');
  assert.equal(relayed.from.instanceId, 'inst-b', 'from 保持原发机器');
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
