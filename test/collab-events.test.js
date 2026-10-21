import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir } from './helpers.js';
import { collabDir } from '../src/paths.js';
import { ledgerDigest } from '../src/collab/store.js';
import { isLedgerShape } from '../src/collab/model.js';
import { createInjectionRouter } from '../src/core/routing.js';
import { handleEvent } from '../src/collab/events.js';
import { confirmHandover, handover } from '../src/collab/handover.js';
import { applyFreezeLocally, approveInvite, leaveCollab } from '../src/collab/outgoing.js';
import { classifyCollabDir } from '../src/collab/legacy.js';
import { readCarrier } from '../src/collab/carrier.js';
import {
  applyManagerFreeze, autoTransfer, clearFreezeReason, clearManagerFreeze, managerUnreachable, m5RuntimeOf, noteSeatClosed,
  openManagerCatchupWindow, persistFreezeReason, runHandshake, runPresenceTick, runProbeTick, sweepSeatGrace, takeOver,
} from '../src/collab/takeover.js';
import { rejectHandover, restoreM5State } from '../src/collab/handover.js';
import { decide } from '../src/collab/freeze.js';

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
    joinReplayIntervalsMs: [10, 20],
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
  const local = localOf({ role: 'manager', ledger: ledgerOf({ window, members: [{ instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' }] }), seats: [seatOf('sess-a', 'manager', 1)], endpoints: [['inst-b', { address: '10.0.0.7', port: 17321 }]] });
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

test('C2 handshake 来源不在名单：应答不记录、不请求快照，自报更高任期快照不得转正', async (t) => {
  const local = localOf({ seats: [seatOf('sess-self')] });
  const harness = stateOf(t, local);
  const intruder = { instanceId: 'inst-x', sessionId: 'sess-x', identityName: '外机' };
  const handshake = {
    event: 'handshake', role: 'manager', managerTerm: 2, version: 11,
    manager: intruder, takeover: null, reply: false,
  };
  await handleEvent(harness.state, frameOf('notice', handshake, intruder), { remoteAddress: '10.0.0.9' });
  assert.equal(m5RuntimeOf(harness.state).handshakeResponses.get(COLLAB)?.size ?? 0, 0, '名单外握手不写入应答');
  assert.ok((harness.state.counters.handshakeUnlistedReplies ?? 0) >= 1, '名单外请求只回自己的 pair，不采信');
  assert.equal(harness.sent.some((entry) => entry.type === 'snapshot' && entry.payload.kind === 'request'), false, '不向名单外主机请求快照');

  const next = ledgerOf({ term: 2, version: 11, manager: intruder, members: [{ instanceId: 'inst-self', sessionId: 'sess-self', identityName: '本机' }] });
  await handleEvent(harness.state, frameOf('snapshot', {
    kind: 'data', managerTerm: 2, version: 11, digest: ledgerDigest(next), ledger: next,
  }, intruder), { remoteAddress: '10.0.0.9' });
  assert.equal(local.member.manager.instanceId, 'inst-a', '未受理的 manager 不得经快照转正');
  assert.equal(m5RuntimeOf(harness.state).frozen.get(COLLAB), 'manager-fork');
});

test('C2 旧站长重启：旧名单成员的直连握手 + 一致快照仍可降级采纳', async (t) => {
  const managerA = { instanceId: 'inst-self', sessionId: 'sess-a', identityName: '本机' };
  const managerB = { instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' };
  const base = ledgerOf({ term: 1, version: 10, manager: managerA, members: [managerB] });
  const local = localOf({ role: 'manager', ledger: base, seats: [seatOf('sess-a', 'manager', 1)], endpoints: [['inst-b', { address: '10.0.0.2', port: 17321 }]] });
  const harness = stateOf(t, local);
  /* 旧站长重启的追赶证据只在启动追赶窗口内成立（设计 §2A.2）。 */
  openManagerCatchupWindow(harness.state, COLLAB);
  await handleEvent(harness.state, frameOf('notice', {
    event: 'handshake', role: 'manager', managerTerm: 2, version: 11, manager: managerB, takeover: null, reply: true,
  }, managerB), { remoteAddress: '10.0.0.2' });
  assert.equal(m5RuntimeOf(harness.state).handshakeResponses.get(COLLAB)?.get('inst-b')?.term, 2);
  assert.equal(m5RuntimeOf(harness.state).acceptedManagers.get(COLLAB), undefined, '判决前不得写受理记录');
  const next = ledgerOf({ term: 2, version: 11, manager: managerB, members: [{ instanceId: 'inst-self', sessionId: 'sess-a', identityName: '本机' }] });
  await handleEvent(harness.state, frameOf('snapshot', {
    kind: 'data', managerTerm: 2, version: 11, digest: ledgerDigest(next), ledger: next,
  }, managerB), { remoteAddress: '10.0.0.2' });
  assert.equal(local.role, 'member', '旧站长按更高任期退回成员');
  assert.equal(local.member.manager.instanceId, 'inst-b');
  assert.equal(m5RuntimeOf(harness.state).frozen.has(COLLAB), false);
});

test('R2 在位站长（启动窗口已过）：在册成员自报高 term + 同内容快照不得降级/删台账', async (t) => {
  const managerA = { instanceId: 'inst-self', sessionId: 'sess-a', identityName: '本机' };
  const memberB = { instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' };
  const base = ledgerOf({ term: 1, version: 10, manager: managerA, members: [memberB] });
  const local = localOf({ role: 'manager', ledger: base, seats: [seatOf('sess-a', 'manager', 1)], endpoints: [['inst-b', { address: '10.0.0.2', port: 17321 }]] });
  const harness = stateOf(t, local);
  runHandshake(harness.state, { collabId: COLLAB });
  harness.mono.now += 300001;   // 超过 managerLossTimeoutMs（300000）：启动追赶窗口已关
  await handleEvent(harness.state, frameOf('notice', {
    event: 'handshake', role: 'manager', managerTerm: 99, version: 99, manager: memberB, takeover: null, reply: false,
  }, memberB), { remoteAddress: '10.0.0.2' });
  const next = ledgerOf({ term: 99, version: 99, manager: memberB, members: [managerA] });
  await handleEvent(harness.state, frameOf('snapshot', {
    kind: 'data', managerTerm: 99, version: 99, digest: ledgerDigest(next), ledger: next,
  }, memberB), { remoteAddress: '10.0.0.2' });
  assert.equal(local.role, 'manager', '窗口外不得据此降级在位站长');
  assert.equal(local.ledger.manager.instanceId, 'inst-self', '在位站长台账不得被替换');
  assert.equal(m5RuntimeOf(harness.state).frozen.get(COLLAB), 'manager-fork', '无授权更高任期快照按分叉冻结');
  assert.equal(m5RuntimeOf(harness.state).acceptedManagers.get(COLLAB), undefined, '不写受理记录');
});

test('R2 窗口内但快照来源不是本轮最高 pair：不得据此降级在位站长', async (t) => {
  const managerA = { instanceId: 'inst-self', sessionId: 'sess-a', identityName: '本机' };
  const memberB = { instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' };
  const memberC = { instanceId: 'inst-c', sessionId: 'sess-c', identityName: '丙' };
  const base = ledgerOf({ term: 1, version: 10, manager: managerA, members: [memberB, memberC] });
  const local = localOf({
    role: 'manager', ledger: base, seats: [seatOf('sess-a', 'manager', 1)],
    endpoints: [['inst-b', { address: '10.0.0.2', port: 17321 }], ['inst-c', { address: '10.0.0.3', port: 17321 }]],
  });
  const harness = stateOf(t, local);
  openManagerCatchupWindow(harness.state, COLLAB);
  await handleEvent(harness.state, frameOf('notice', {
    event: 'handshake', role: 'manager', managerTerm: 2, version: 11, manager: memberB, takeover: null, reply: false,
  }, memberB), { remoteAddress: '10.0.0.2' });
  await handleEvent(harness.state, frameOf('notice', {
    event: 'handshake', role: 'manager', managerTerm: 3, version: 12, manager: memberC, takeover: null, reply: false,
  }, memberC), { remoteAddress: '10.0.0.3' });
  const fromB = ledgerOf({ term: 2, version: 11, manager: memberB, members: [managerA] });
  await handleEvent(harness.state, frameOf('snapshot', {
    kind: 'data', managerTerm: 2, version: 11, digest: ledgerDigest(fromB), ledger: fromB,
  }, memberB), { remoteAddress: '10.0.0.2' });
  assert.equal(local.role, 'manager', '非最高 pair 来源不构成追赶证据');
  assert.equal(local.ledger.manager.instanceId, 'inst-self');
  assert.equal(m5RuntimeOf(harness.state).frozen.get(COLLAB), 'manager-fork');
});

test('C2 旧站长重启：快照来源不在旧名单时握手证据不成立（仍冻结）', async (t) => {
  const managerA = { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' };
  const managerB = { instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' };
  const stranger = { instanceId: 'inst-x', sessionId: 'sess-x', identityName: '外机' };
  const base = ledgerOf({ term: 1, version: 10, manager: managerA, members: [managerB] });
  const local = localOf({ role: 'manager', ledger: base, seats: [seatOf('sess-a', 'manager', 1)] });
  const harness = stateOf(t, local);
  await handleEvent(harness.state, frameOf('notice', {
    event: 'handshake', role: 'manager', managerTerm: 2, version: 11, manager: stranger, takeover: null, reply: true,
  }, stranger), { remoteAddress: '10.0.0.9' });
  assert.equal(m5RuntimeOf(harness.state).handshakeResponses.get(COLLAB)?.size ?? 0, 0);
  const next = ledgerOf({ term: 2, version: 11, manager: stranger, members: [{ instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' }] });
  await handleEvent(harness.state, frameOf('snapshot', {
    kind: 'data', managerTerm: 2, version: 11, digest: ledgerDigest(next), ledger: next,
  }, stranger), { remoteAddress: '10.0.0.9' });
  assert.equal(local.role, 'manager', '名单外来源不得触发降级');
  assert.equal(m5RuntimeOf(harness.state).frozen.get(COLLAB), 'manager-fork');
});

test('C2 frozen(manager-offline)：名单外握手 + 快照不得解除冻结', async (t) => {
  const local = localOf({ seats: [seatOf('sess-self')] });
  const harness = stateOf(t, local);
  applyManagerFreeze(harness.state, COLLAB, 'manager-offline');
  const intruder = { instanceId: 'inst-x', sessionId: 'sess-x', identityName: '外机' };
  await handleEvent(harness.state, frameOf('notice', {
    event: 'handshake', role: 'manager', managerTerm: 2, version: 11, manager: intruder, takeover: null, reply: true,
  }, intruder), { remoteAddress: '10.0.0.9' });
  const next = ledgerOf({ term: 2, version: 11, manager: intruder, members: [{ instanceId: 'inst-self', sessionId: 'sess-self', identityName: '本机' }] });
  await handleEvent(harness.state, frameOf('snapshot', {
    kind: 'data', managerTerm: 2, version: 11, digest: ledgerDigest(next), ledger: next,
  }, intruder), { remoteAddress: '10.0.0.9' });
  assert.equal(m5RuntimeOf(harness.state).frozen.get(COLLAB), 'manager-offline', '冻结不被名单外快照解除');
  assert.equal(local.member.manager.instanceId, 'inst-a');
});

test('C3 窗口已关的 takeover 帧不构成 fork 收敛证据', async (t) => {
  const managerA = { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' };
  const managerB = { instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' };
  const managerC = { instanceId: 'inst-c', sessionId: 'sess-c', identityName: '丙' };
  const local = localOf({
    ledger: ledgerOf({
      term: 1, version: 10, manager: managerA,
      members: [{ instanceId: 'inst-c', sessionId: 'sess-c', identityName: '丙' }],
      window: { windowBaseTerm: 1, windowEndsAt: iso(NOW - 1000) },
    }),
    seats: [seatOf('sess-self')],
  });
  const harness = stateOf(t, local);
  await handleEvent(harness.state, frameOf('notice', changeOf({
    via: 'takeover', term: 1, version: 11, manager: managerB, prevManager: managerA,
    windowBaseTerm: 1, authorizedAt: iso(),
  }), managerB), { remoteAddress: '10.0.0.2' });
  assert.equal(m5RuntimeOf(harness.state).frozen.get(COLLAB), 'manager-fork');
  await handleEvent(harness.state, frameOf('notice', changeOf({
    via: 'takeover', term: 2, version: 12, manager: managerC, prevManager: managerA,
    windowBaseTerm: 1, authorizedAt: iso(),
  }), managerC), { remoteAddress: '10.0.0.3' });
  assert.equal(m5RuntimeOf(harness.state).authorizedEvidenceMap?.get(COLLAB), undefined, '窗口已关的帧不得成为证据');

  const next = ledgerOf({ term: 2, version: 12, manager: managerC, members: [{ instanceId: 'inst-self', sessionId: 'sess-self', identityName: '本机' }] });
  await handleEvent(harness.state, frameOf('snapshot', {
    kind: 'data', managerTerm: 2, version: 12, digest: ledgerDigest(next), ledger: next,
  }, managerC), { remoteAddress: '10.0.0.3' });
  assert.equal(m5RuntimeOf(harness.state).frozen.get(COLLAB), 'manager-fork', '分叉不得被洗白的证据解除');
});

test('C3 非成员来源的 takeover 帧不构成 fork 收敛证据', async (t) => {
  const managerA = { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' };
  const managerB = { instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' };
  const stranger = { instanceId: 'inst-x', sessionId: 'sess-x', identityName: '外机' };
  const local = localOf({
    ledger: ledgerOf({
      term: 1, version: 10, manager: managerA,
      members: [{ instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' }],
      window: { windowBaseTerm: 1, windowEndsAt: iso(NOW + 60000) },
    }),
    seats: [seatOf('sess-self')],
  });
  const harness = stateOf(t, local);
  await handleEvent(harness.state, frameOf('notice', changeOf({
    via: 'takeover', term: 1, version: 11, manager: managerB, prevManager: managerA,
    windowBaseTerm: 1, authorizedAt: iso(),
  }), managerB), { remoteAddress: '10.0.0.2' });
  assert.equal(m5RuntimeOf(harness.state).frozen.get(COLLAB), 'manager-fork');
  await handleEvent(harness.state, frameOf('notice', changeOf({
    via: 'takeover', term: 2, version: 12, manager: stranger, prevManager: managerA,
    windowBaseTerm: 1, authorizedAt: iso(),
  }), stranger), { remoteAddress: '10.0.0.3' });
  assert.equal(m5RuntimeOf(harness.state).authorizedEvidenceMap?.get(COLLAB), undefined, '非成员来源不得成为证据');
  const next = ledgerOf({ term: 2, version: 12, manager: stranger, members: [{ instanceId: 'inst-self', sessionId: 'sess-self', identityName: '本机' }] });
  await handleEvent(harness.state, frameOf('snapshot', {
    kind: 'data', managerTerm: 2, version: 12, digest: ledgerDigest(next), ledger: next,
  }, stranger), { remoteAddress: '10.0.0.3' });
  assert.equal(m5RuntimeOf(harness.state).frozen.get(COLLAB), 'manager-fork');
});

test('C3 有效证据仍收敛分叉，但快照必须由证据签发者送达', async (t) => {
  const managerA = { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' };
  const managerB = { instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' };
  const managerC = { instanceId: 'inst-c', sessionId: 'sess-c', identityName: '丙' };
  const managerD = { instanceId: 'inst-d', sessionId: 'sess-d', identityName: '丁' };
  const local = localOf({
    ledger: ledgerOf({
      term: 1, version: 10, manager: managerA,
      members: [managerB, managerC, managerD],
      window: { windowBaseTerm: 1, windowEndsAt: iso(NOW + 60000) },
    }),
    seats: [seatOf('sess-self')],
  });
  const harness = stateOf(t, local);
  await handleEvent(harness.state, frameOf('notice', changeOf({
    via: 'takeover', term: 1, version: 11, manager: managerB, prevManager: managerA,
    windowBaseTerm: 1, authorizedAt: iso(),
  }), managerB), { remoteAddress: '10.0.0.2' });
  assert.equal(m5RuntimeOf(harness.state).frozen.get(COLLAB), 'manager-fork');
  await handleEvent(harness.state, frameOf('notice', changeOf({
    via: 'takeover', term: 2, version: 12, manager: managerC, prevManager: managerA,
    windowBaseTerm: 1, authorizedAt: iso(),
  }), managerC), { remoteAddress: '10.0.0.3' });
  const evidence = m5RuntimeOf(harness.state).authorizedEvidenceMap?.get(COLLAB);
  assert.equal(evidence?.source?.instanceId, 'inst-c', '证据绑定签发席位');

  const next = ledgerOf({ term: 2, version: 12, manager: managerC, members: [{ instanceId: 'inst-self', sessionId: 'sess-self', identityName: '本机' }] });
  await handleEvent(harness.state, frameOf('snapshot', {
    kind: 'data', managerTerm: 2, version: 12, digest: ledgerDigest(next), ledger: next,
  }, managerD), { remoteAddress: '10.0.0.4' });
  assert.equal(m5RuntimeOf(harness.state).frozen.get(COLLAB), 'manager-fork', '他机转交的同内容快照不解锁');

  await handleEvent(harness.state, frameOf('snapshot', {
    kind: 'data', managerTerm: 2, version: 12, digest: ledgerDigest(next), ledger: next,
  }, managerC), { remoteAddress: '10.0.0.3' });
  assert.equal(m5RuntimeOf(harness.state).frozen.has(COLLAB), false, '证据签发者本人送达即收敛');
  assert.equal(local.member.manager.instanceId, 'inst-c');
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

test('presence 在 accepted 连接（无 peerInstanceId）上按端点地址作直连证据，并刷新站长证据', async (t) => {
  const local = localOf({
    seats: [seatOf('sess-self')],
    endpoints: [['inst-a', { address: '10.0.0.1', port: 17321 }]],
  });
  const harness = stateOf(t, local);
  const notice = { collabId: COLLAB, instanceId: 'inst-a', sessions: ['sess-a'], sentAt: iso() };
  await handleEvent(harness.state, frameOf('seat-presence', notice, { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' }), { remoteAddress: '10.0.0.1' });
  const entry = [...m5RuntimeOf(harness.state).presence.values()].find((item) => item.instanceId === 'inst-a' && item.sessionId === 'sess-a');
  assert.ok(entry, 'accepted 连接按远端地址匹配已知端点后刷新');
  assert.equal(m5RuntimeOf(harness.state).managerEvidenceAt.get(COLLAB), 1000, '站长列表刷新计入失联证据');

  const rejected = stateOf(t, localOf({
    seats: [seatOf('sess-self')],
    endpoints: [['inst-a', { address: '10.0.0.1', port: 17321 }]],
  }));
  await handleEvent(rejected.state, frameOf('seat-presence', notice, { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' }), { remoteAddress: '10.0.0.9' });
  assert.equal([...m5RuntimeOf(rejected.state).presence.values()].length, 0, '地址不符不得刷新');
  assert.ok((rejected.state.counters.presenceRejected ?? 0) >= 1);
});

test('探测成功计入站长可达证据：站长在线时成员不被误冻结', async (t) => {
  const local = localOf({
    seats: [seatOf('sess-self')],
    endpoints: [['inst-a', { address: '10.0.0.1', port: 17321 }]],
  });
  const { state, mono } = stateOf(t, local);
  m5RuntimeOf(state).managerEvidenceAt.set(COLLAB, 1000);
  mono.now = 1000 + 400000;   // 已超 managerLossTimeoutMs
  state.probe = async () => ({ reachable: true });
  runProbeTick(state);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(m5RuntimeOf(state).managerEvidenceAt.get(COLLAB), mono.now, '探测成功刷新失联证据');
  runPresenceTick(state);
  assert.equal(m5RuntimeOf(state).frozen.has(COLLAB), false, '探测成功即站长可达，不冻结');
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
  m5RuntimeOf(harness.state).handshakeResponses.set(COLLAB, new Map([['inst-b', {
    term: 1,
    version: 10,
    manager: { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' },
    seat: { instanceId: 'inst-b', sessionId: 'sess-b' },
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

test('I5/C1 同机自动继任：宽限到期后同机席位被选中并提升（不依赖网络端点），超时后不自毁', async (t) => {
  const ledger = ledgerOf({ members: [
    { instanceId: 'inst-self', sessionId: 'sess-b', identityName: '乙' },
    { instanceId: 'inst-c', sessionId: 'sess-c', identityName: '丙' },
  ] });
  const local = localOf({
    role: 'manager',
    ledger,
    seats: [seatOf('sess-a', 'manager', 1), seatOf('sess-b')],
    endpoints: [['inst-c', { address: '10.0.0.3', port: 17321 }]],
  });
  const harness = stateOf(t, local, { config: { dialTimeoutMs: 5 } });
  noteSeatClosed(harness.state, COLLAB, 'sess-a', harness.clock.now);
  sweepSeatGrace(harness.state, harness.clock.now + 2000);
  assert.equal(local.role, 'manager');
  assert.equal(local.ledger.manager.sessionId, 'sess-b', '同机继任者被提升');
  assert.equal(local.ledger.managerTerm, 2);
  assert.ok(local.ledger.managerWindow, '自动移交开 1 分钟窗口');
  assert.equal(local.seats.get('sess-b').role, 'manager');
  assert.equal(local.seats.get('sess-a'), undefined, '旧站长席位已移除');
  assert.equal(m5RuntimeOf(harness.state).autoPending.has(COLLAB), false, '本机签发成功即清自动移交在途');
  assert.equal(m5RuntimeOf(harness.state).autoAcceptTimers.size, 0, '自动接受定时器已清理');
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(local.ledger.status, 'active', '定时器到期后协作不得被写成就绪终态');
  assert.equal(local.ledger.manager.sessionId, 'sess-b', '过期定时器不得再漂移管理权');
  assert.equal(harness.sent.some((entry) => entry.type === 'handover' && entry.payload.kind === 'offer' && entry.to?.instanceId === 'inst-c'), false, '不得再向下一人发 offer');
  assert.equal(harness.state.counters.autoAcceptTimeouts ?? 0, 0, '已收口的自动移交不再计超时');
  assert.equal(harness.state.counters.collabsCompletedBySeats ?? 0, 0, '不得把刚接管的协作写成 completed');
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

test('C2a 首份快照的台账本身冻结：本地同名冲突冻结不被解除（设计 §2A.3）', async (t) => {
  const manager = { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' };
  const memberRow = { instanceId: 'inst-self', sessionId: 'sess-self', identityName: '本机' };
  const ledger = ledgerOf({ manager, members: [memberRow], version: 11, status: 'frozen' });
  const local = localOf({ seats: [seatOf('sess-self')], snapshot: null, endpoints: [['inst-a', { address: '10.0.0.1', port: 17321 }]] });
  Object.assign(local.member, { state: 'frozen', frozenAt: iso(), frozenFrom: 'active' });
  const harness = stateOf(t, local);
  await handleEvent(harness.state, frameOf('snapshot', { kind: 'data', managerTerm: 1, version: 11, digest: ledgerDigest(ledger), ledger }, manager), { remoteAddress: '10.0.0.1' });
  assert.equal(local.snapshot?.version, 11, '首份冻结态快照照常落库');
  assert.equal(local.member.state, 'frozen', '权威台账是冻结态：只能确认冻结，不得翻回 active');
});

test('C2b 同 term 更高 version 快照受理：只清任期冻结，冲突冻结保留（设计 §2A.3）', async (t) => {
  const manager = { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' };
  const memberRow = { instanceId: 'inst-self', sessionId: 'sess-self', identityName: '本机' };
  const baseline = ledgerOf({ manager, members: [memberRow], version: 10 });
  const local = localOf({ ledger: baseline, seats: [seatOf('sess-self')], endpoints: [['inst-a', { address: '10.0.0.1', port: 17321 }]] });
  Object.assign(local.member, { state: 'frozen', frozenAt: iso(), frozenFrom: 'active' });
  const harness = stateOf(t, local);
  const next = ledgerOf({ manager, members: [memberRow], version: 11, status: 'frozen' });
  await handleEvent(harness.state, frameOf('snapshot', { kind: 'data', managerTerm: 1, version: 11, digest: ledgerDigest(next), ledger: next }, manager), { remoteAddress: '10.0.0.1' });
  assert.equal(local.snapshot?.version, 11, 'A11：同 term 同 manager 的更高 version 快照受理');
  assert.equal(local.member.state, 'frozen', '采纳快照不得把检出侧的冲突冻结静默翻回 active');
});

test('C4 共享台账 active、本机同名冲突冻结：manager-changed 与 active 快照都不得解除', async (t) => {
  const manager = { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' };
  const memberRow = { instanceId: 'inst-self', sessionId: 'sess-self', identityName: '本机' };
  const nextManager = { instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' };
  const baseline = ledgerOf({ manager, members: [memberRow], version: 10 });
  const local = localOf({ ledger: baseline, seats: [seatOf('sess-self')], endpoints: [['inst-a', { address: '10.0.0.1', port: 17321 }]] });
  Object.assign(local.member, { state: 'frozen', frozenAt: iso(), frozenFrom: 'active' });
  const harness = stateOf(t, local);
  await handleEvent(harness.state, frameOf('notice', changeOf({
    via: 'handover', term: 2, version: 11, manager: nextManager,
    prevManager: { instanceId: 'inst-a', sessionId: 'sess-a' }, offerId: 'offer-c4',
  }), manager), { remoteAddress: '10.0.0.1' });
  assert.equal(local.member.state, 'frozen', 'manager-changed（无台账）不得解除冲突冻结');
  assert.equal(local.member.manager.instanceId, 'inst-b', '站长引用照常更新');

  const activeNext = ledgerOf({ manager: nextManager, members: [memberRow], version: 12 });
  await handleEvent(harness.state, frameOf('snapshot', {
    kind: 'data', managerTerm: 2, version: 12, digest: ledgerDigest(activeNext), ledger: activeNext,
  }, nextManager), { remoteAddress: '10.0.0.2' });
  assert.equal(local.member.state, 'frozen', 'status=active 的更高 version 快照不得解除冲突冻结');
});

test('C4 活跃成员收到冻结态权威台账：本地收敛为 frozen（保留 frozenFrom）', async (t) => {
  const manager = { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' };
  const memberRow = { instanceId: 'inst-self', sessionId: 'sess-self', identityName: '本机' };
  const baseline = ledgerOf({ manager, members: [memberRow], version: 10 });
  const local = localOf({ ledger: baseline, seats: [seatOf('sess-self')], endpoints: [['inst-a', { address: '10.0.0.1', port: 17321 }]] });
  const harness = stateOf(t, local);
  const frozenLedger = ledgerOf({ manager, members: [memberRow], version: 11, status: 'frozen' });
  await handleEvent(harness.state, frameOf('snapshot', {
    kind: 'data', managerTerm: 1, version: 11, digest: ledgerDigest(frozenLedger), ledger: frozenLedger,
  }, manager), { remoteAddress: '10.0.0.1' });
  assert.equal(local.member.state, 'frozen', '权威台账冻结态传播到活跃成员');
  assert.equal(local.member.frozenFrom, 'active');
  assert.ok(local.member.frozenAt);
});

test('R1 台账传播的 frozen → authoritative active 快照：成员恢复 active 并清冻结标记', async (t) => {
  const manager = { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' };
  const memberRow = { instanceId: 'inst-self', sessionId: 'sess-self', identityName: '本机' };
  const baseline = ledgerOf({ manager, members: [memberRow], version: 10 });
  const local = localOf({ ledger: baseline, seats: [seatOf('sess-self')], endpoints: [['inst-a', { address: '10.0.0.1', port: 17321 }]] });
  const harness = stateOf(t, local);
  const frozenLedger = ledgerOf({ manager, members: [memberRow], version: 11, status: 'frozen' });
  await handleEvent(harness.state, frameOf('snapshot', {
    kind: 'data', managerTerm: 1, version: 11, digest: ledgerDigest(frozenLedger), ledger: frozenLedger,
  }, manager), { remoteAddress: '10.0.0.1' });
  assert.equal(local.member.state, 'frozen', '冻结台账先把成员收敛为 frozen');
  assert.equal(local.member.freezeReason, 'ledger', '台账传播冻结带可区分标记');

  /* manager-changed 可能不携台账：不得把它当作 authoritative active 解冻依据。 */
  const nextManager = { instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' };
  await handleEvent(harness.state, frameOf('notice', changeOf({
    via: 'handover', term: 2, version: 12, manager: nextManager,
    prevManager: { instanceId: 'inst-a', sessionId: 'sess-a' }, offerId: 'offer-r1',
  }), manager), { remoteAddress: '10.0.0.1' });
  assert.equal(local.member.state, 'frozen', '未携台账的 manager-changed 不得解除台账传播冻结');
  assert.equal(local.member.freezeReason, 'ledger');

  const activeLedger = ledgerOf({ term: 2, version: 13, manager: nextManager, members: [memberRow] });
  await handleEvent(harness.state, frameOf('snapshot', {
    kind: 'data', managerTerm: 2, version: 13, digest: ledgerDigest(activeLedger), ledger: activeLedger,
  }, nextManager), { remoteAddress: '10.0.0.2' });
  assert.equal(local.snapshot?.version, 13, 'authoritative active 快照受理');
  assert.equal(local.member.state, 'active', '权威台账回 active 时成员必须恢复（设计 §2A.2 C4）');
  assert.equal(local.member.freezeReason, undefined, '台账传播冻结标记清除');
  assert.equal(local.member.frozenAt, undefined);
  assert.equal(local.member.frozenFrom, undefined);
});

test('C6 同机两会话同名但席位不相交：冻结帧不得误命中另一条协作', async (t) => {
  const seatOne = { instanceId: 'inst-i1', sessionId: 'sess-1', identityName: 'S1' };
  const seatTwo = { instanceId: 'inst-i1', sessionId: 'sess-2', identityName: 'S2' };
  const first = localOf({ seats: [seatOf('sess-self-1')] });
  Object.assign(first, { collabId: 'collab-one', member: { ...first.member, collabId: 'collab-one', name: '同名项目', roster: [seatOne] } });
  const second = localOf({ seats: [seatOf('sess-self-2')] });
  Object.assign(second, { collabId: 'collab-two', member: { ...second.member, collabId: 'collab-two', name: '同名项目', roster: [seatTwo] } });
  const harness = stateOf(t, first);
  harness.state.collabs.set('collab-two', second);
  const freeze = frameOf('freeze', { name: '同名项目', reason: '同名冲突', members: [seatOne] }, seatOne);
  freeze.collabId = 'collab-one';
  await handleEvent(harness.state, freeze, { remoteAddress: '10.0.0.1' });
  assert.equal(first.member.state, 'frozen', '席位相交的副本被冻结');
  assert.equal(second.member.state, 'active', '同 instanceId 的另一会话（席位不相交）不得被误冻结');
  assert.equal(second.conflictRival, undefined);
});

test('C6 裁定/解冻按席位键作用：同机另一会话的同名协作不被误解冻', async (t) => {
  const seatOne = { instanceId: 'inst-i1', sessionId: 'sess-1', identityName: 'S1' };
  const seatTwo = { instanceId: 'inst-i1', sessionId: 'sess-2', identityName: 'S2' };
  const first = localOf({ seats: [seatOf('sess-self-1')] });
  Object.assign(first, { collabId: 'collab-one', member: { ...first.member, collabId: 'collab-one', name: '同名项目', state: 'frozen', roster: [seatOne] } });
  const second = localOf({ seats: [seatOf('sess-self-2')] });
  Object.assign(second, { collabId: 'collab-two', member: { ...second.member, collabId: 'collab-two', name: '同名项目', state: 'frozen', roster: [seatTwo] } });
  const harness = stateOf(t, first);
  harness.state.collabs.set('collab-two', second);
  const decision = frameOf('decision', {
    choice: 'terminate', name: '同名项目', members: [seatOne], collabId: 'collab-one', executed: true,
  }, seatOne);
  decision.collabId = 'collab-one';
  await handleEvent(harness.state, decision, { remoteAddress: '10.0.0.1' });
  assert.equal(first.member.state, 'terminated', '目标副本按裁定终止');
  assert.equal(second.member.state, 'frozen', '席位不相交的同名副本不得被误解冻/终止');

  const unfreeze = frameOf('unfreeze', { name: '同名项目', members: [seatOne], reason: '保持两条' }, seatOne);
  unfreeze.collabId = 'collab-one';
  second.member.state = 'frozen';
  await handleEvent(harness.state, unfreeze, { remoteAddress: '10.0.0.1' });
  assert.equal(second.member.state, 'frozen', '解冻不得波及席位不相交的副本');
});

test('R7 合并裁定的本机并条按席位键：同机另一会话的同名协作不得被误终止', (t) => {
  const seatOne = { instanceId: 'inst-i1', sessionId: 'sess-1', identityName: 'S1' };
  const seatTwo = { instanceId: 'inst-i1', sessionId: 'sess-2', identityName: 'S2' };
  const ledger = ledgerOf({
    manager: seatOne,
    members: [{ instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' }],
  });
  ledger.name = '同名项目';
  ledger.status = 'frozen';
  ledger.frozenFrom = 'active';
  const winner = localOf({
    role: 'manager', ledger, seats: [seatOf('sess-1', 'manager', 1)],
    endpoints: [['inst-b', { address: '10.0.0.2', port: 17321 }]],
  });
  const other = localOf({ seats: [seatOf('sess-2')] });
  Object.assign(other, {
    collabId: 'collab-two',
    member: { ...other.member, collabId: 'collab-two', name: '同名项目', roster: [seatTwo] },
  });
  const harness = stateOf(t, winner);
  harness.state.collabs.set('collab-two', other);
  const result = decide(harness.state, { collabId: COLLAB, choice: 'merge' });
  assert.equal(result.ok, true, result.message);
  assert.equal(winner.ledger.status, 'active', '保留条按合并解冻');
  assert.equal(other.member.state, 'active', '席位不相交的同机另一会话不得被并入终止');
  assert.equal(other.member.archivedAt, undefined);
  assert.ok(harness.sent.some((entry) => entry.type === 'decision' && entry.payload?.choice === 'merge'), '合并裁定照常广播');
});

test('C5 end 签发者校验：非现任站长不得归档本机协作', async (t) => {
  const local = localOf({ seats: [seatOf('sess-self')] });
  const harness = stateOf(t, local);
  await handleEvent(harness.state, frameOf('end', {}, { instanceId: 'inst-x', sessionId: 'sess-x', identityName: '外机' }), { remoteAddress: '10.0.0.9' });
  assert.equal(local.member.state, 'active', '冒名 end 不得归档');
  assert.ok((harness.state.counters.endRejected ?? 0) >= 1);
  await handleEvent(harness.state, frameOf('end', {}, { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' }), { remoteAddress: '10.0.0.1' });
  assert.equal(local.member.state, 'completed', '现任站长签发照常归档');
});

test('C5 冻结/裁定/解冻签发者校验：名单外或冒名在册席位均拒收', async (t) => {
  const local = localOf({ seats: [seatOf('sess-self')] });
  Object.assign(local.member, { roster: [{ instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' }] });
  const harness = stateOf(t, local);
  const members = [{ instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' }, { instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' }];

  await handleEvent(harness.state, frameOf('freeze', { name: '项目', reason: '同名冲突', members }, { instanceId: 'inst-x', sessionId: 'sess-x', identityName: '外机' }), { remoteAddress: '10.0.0.9' });
  assert.equal(local.member.state, 'active', '名单外冻结帧不得生效');
  assert.ok((harness.state.counters.freezeRejected ?? 0) >= 1);

  applyFreezeLocally(harness.state, local, '同名冲突');
  local.conflictRival = { name: '项目', members, managerInstanceId: 'inst-a' };
  await handleEvent(harness.state, frameOf('decision', {
    choice: 'terminate', name: '项目', members, collabId: 'collab-rival', executed: true,
  }, { instanceId: 'inst-x', sessionId: 'sess-x', identityName: '外机' }), { remoteAddress: '10.0.0.9' });
  assert.equal(local.member.state, 'frozen', '名单外裁定不得终止本机');

  await handleEvent(harness.state, frameOf('decision', {
    choice: 'terminate', name: '项目', members, collabId: 'collab-rival', executed: true,
  }, { instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' }), { remoteAddress: '10.0.0.2' });
  assert.equal(local.member.state, 'frozen', '非站长/非对端站长的在册席位不得冒名裁定');
  assert.ok((harness.state.counters.decisionRejected ?? 0) >= 2);

  await handleEvent(harness.state, frameOf('unfreeze', { name: '项目', members, reason: '保持两条' }, { instanceId: 'inst-x', sessionId: 'sess-x', identityName: '外机' }), { remoteAddress: '10.0.0.9' });
  assert.equal(local.member.state, 'frozen', '名单外解冻不得生效');
  assert.ok((harness.state.counters.unfreezeRejected ?? 0) >= 1);

  await handleEvent(harness.state, frameOf('decision', {
    choice: 'terminate', name: '项目', members, collabId: 'collab-rival', executed: true,
  }, { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' }), { remoteAddress: '10.0.0.1' });
  assert.equal(local.member.state, 'active', '对端现任站长裁定照常执行（本方解除冻结）');
});

test('I1 终态快照采纳：归档本机席位（与 end 同口径）', async (t) => {
  const manager = { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' };
  const local = localOf({ seats: [seatOf('sess-self')], endpoints: [['inst-a', { address: '10.0.0.1', port: 17321 }]] });
  const harness = stateOf(t, local);
  const terminal = ledgerOf({ manager, version: 11, status: 'completed' });
  terminal.manager = null;
  terminal.members = [];
  await handleEvent(harness.state, frameOf('snapshot', {
    kind: 'data', managerTerm: 1, version: 11, digest: ledgerDigest(terminal), ledger: terminal,
  }, manager), { remoteAddress: '10.0.0.1' });
  assert.equal(local.member.state, 'completed');
  assert.equal(typeof local.seats.get('sess-self').archivedAt, 'string', '终态快照必须归档本机席位');
});

test('I2 单人 managed 协作重启：无人可对表也不得永久 handshake-unresolved', (t) => {
  const soloManager = { instanceId: 'inst-self', sessionId: 'sess-a', identityName: '本机' };
  const solo = localOf({ role: 'manager', ledger: ledgerOf({ manager: soloManager }), seats: [seatOf('sess-a', 'manager', 1)] });
  const soloHarness = stateOf(t, solo);
  runHandshake(soloHarness.state, { collabId: COLLAB });
  assert.equal(solo.suspended, null, '单人协作跳过未解析挂起');
  assert.equal(solo.handshakeUnresolved, false);

  const multi = localOf({
    role: 'manager',
    ledger: ledgerOf({ manager: soloManager, members: [{ instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' }] }),
    seats: [seatOf('sess-a', 'manager', 1)],
  });
  const multiHarness = stateOf(t, multi);
  runHandshake(multiHarness.state, { collabId: COLLAB });
  assert.equal(multi.suspended?.reason, 'handshake-unresolved', '有远端成员但无端点仍按未解析挂起');
});

test('I3 显式移交在途时站长会话关闭：到期后补发自动移交', async (t) => {
  const manager = { instanceId: 'inst-self', sessionId: 'sess-a', identityName: '本机' };
  const memberB = { instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' };
  const local = localOf({
    role: 'manager',
    ledger: ledgerOf({ manager, members: [memberB] }),
    seats: [seatOf('sess-a', 'manager', 1)],
    endpoints: [['inst-b', { address: '10.0.0.2', port: 17321 }]],
  });
  const harness = stateOf(t, local, { config: { handoverConfirmTimeoutMs: 30 } });
  const issued = await handover(harness.state, { collabId: COLLAB, target: 'inst-b', targetSessionId: 'sess-b', sessionId: 'sess-a' });
  assert.equal(issued.ok, true, issued.message);
  assert.equal(local.suspended?.reason, 'handover-pending');
  noteSeatClosed(harness.state, COLLAB, 'sess-a');
  harness.mono.now = 1000 + 1001;
  sweepSeatGrace(harness.state);
  assert.equal(m5RuntimeOf(harness.state).pendingManagerClosures.has(COLLAB), true, '写闸抑制时记录待办');
  assert.equal(local.seats.has('sess-a'), true, '待办期间保留签发席位');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(m5RuntimeOf(harness.state).pendingManagerClosures.has(COLLAB), false, '收口后待办清除');
  assert.equal(harness.sent.some((entry) => entry.type === 'notice' && entry.payload?.event === 'auto-offer'), true, '显式移交到期后补发自动移交');
  assert.equal(local.seats.has('sess-a'), false, '补做后移除已关闭的站长席位');
});

test('R3 handshake-unresolved + 站长会话关闭 + 恢复联系：补做自动移交', async (t) => {
  const manager = { instanceId: 'inst-self', sessionId: 'sess-a', identityName: '本机' };
  const memberB = { instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' };
  const local = localOf({
    role: 'manager',
    ledger: ledgerOf({ manager, members: [memberB] }),
    seats: [seatOf('sess-a', 'manager', 1)],
  });
  const harness = stateOf(t, local);
  runHandshake(harness.state, { collabId: COLLAB });
  assert.equal(local.suspended?.reason, 'handshake-unresolved', '无端点成员时启动握手未解析');
  noteSeatClosed(harness.state, COLLAB, 'sess-a');
  harness.mono.now = 1000 + 1001;
  sweepSeatGrace(harness.state);
  assert.equal(m5RuntimeOf(harness.state).pendingManagerClosures.has(COLLAB), true, '挂起期间记录待办并保留席位');
  assert.equal(local.seats.has('sess-a'), true);

  /* 恢复联系：成员握手到达，端点学习解除 handshake-unresolved，待办必须在恢复面被唤醒。 */
  await handleEvent(harness.state, frameOf('notice', {
    event: 'handshake', role: 'member', managerTerm: 1, version: 10,
    manager: { instanceId: 'inst-self', sessionId: 'sess-a', identityName: '本机' }, takeover: null, reply: true,
  }, memberB), { remoteAddress: '10.0.0.2' });
  assert.equal(m5RuntimeOf(harness.state).pendingManagerClosures.has(COLLAB), false, '恢复联系后待办必须被唤醒');
  assert.equal(local.seats.has('sess-a'), false, '待办补做后移除已关闭的站长席位');
  assert.equal(harness.sent.some((entry) => entry.type === 'notice' && entry.payload?.event === 'auto-offer'), true, '补做自动移交并广播 auto-offer');
});

test('I5 席位宽限用单调钟：墙钟前跳不提前判离', (t) => {
  const local = localOf({ seats: [seatOf('sess-self')], endpoints: [['inst-a', { address: '10.0.0.1', port: 17321 }]] });
  const harness = stateOf(t, local);
  noteSeatClosed(harness.state, COLLAB, 'sess-self');
  harness.clock.now += 600000;   // 墙钟前跳 10 分钟
  sweepSeatGrace(harness.state);
  assert.equal(local.seats.has('sess-self'), true, '墙钟前跳不得提前判离');
  harness.mono.now = 1000 + 1001;   // 单调钟超过宽限（1000ms）
  sweepSeatGrace(harness.state);
  assert.equal(local.seats.has('sess-self'), false, '单调钟超时才判离');
});

test('I6 D15 重发跳过已 ack 目标', async (t) => {
  const manager = { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' };
  const local = localOf({
    role: 'manager',
    ledger: ledgerOf({ members: [
      { instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' },
      { instanceId: 'inst-c', sessionId: 'sess-c', identityName: '丙' },
    ] }),
    seats: [seatOf('sess-a', 'manager', 1)],
    endpoints: [
      ['inst-a', { address: '10.0.0.1', port: 17321 }],
      ['inst-b', { address: '10.0.0.2', port: 17321 }],
      ['inst-c', { address: '10.0.0.3', port: 17321 }],
    ],
  });
  const harness = stateOf(t, local);
  harness.mono.now = 100000;
  m5RuntimeOf(harness.state).resends.set(COLLAB, {
    payload: { event: 'manager-changed', term: 2, version: 11, manager: { instanceId: 'inst-self', sessionId: 'sess-self', identityName: '本机' } },
    prevManager: manager,
    fromSessionId: 'sess-a',
    sentAt: 0,
    startedAt: 0,
    attempts: 1,
    acked: new Set(['inst-b']),
  });
  runPresenceTick(harness.state);
  const resends = harness.sent.filter((entry) => entry.type === 'notice' && entry.payload?.event === 'manager-changed');
  assert.equal(resends.some((entry) => entry.to?.instanceId === 'inst-b'), false, '已 ack 目标不再重发');
  assert.equal(resends.some((entry) => entry.to?.instanceId === 'inst-c'), true, '未 ack 目标继续重发');
});

test('I7 站长同 term 回归：探测成功 / 握手应答解除 manager-offline 冻结', async (t) => {
  const local = localOf({ seats: [seatOf('sess-self')], endpoints: [['inst-a', { address: '10.0.0.1', port: 17321 }]] });
  local.member.roster = [{ instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' }];
  const harness = stateOf(t, local);
  applyManagerFreeze(harness.state, COLLAB, 'manager-offline');
  harness.state.probe = async () => ({ reachable: true });
  runProbeTick(harness.state);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(m5RuntimeOf(harness.state).frozen.has(COLLAB), false, '探测应答即站长可达，解除冻结');

  const second = localOf({ seats: [seatOf('sess-self')] });
  second.member.roster = [{ instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' }];
  const secondHarness = stateOf(t, second);
  applyManagerFreeze(secondHarness.state, COLLAB, 'manager-offline');
  await handleEvent(secondHarness.state, frameOf('notice', {
    event: 'handshake', role: 'manager', managerTerm: 1, version: 10,
    manager: { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' }, takeover: null, reply: true,
  }, { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' }), { remoteAddress: '10.0.0.1' });
  assert.equal(m5RuntimeOf(secondHarness.state).frozen.has(COLLAB), false, '同 term 站长握手应答解除 manager-offline');
});

test('I8 站长直连帧清除陈旧探测离线结论，不按不可达受理', async (t) => {
  const manager = { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' };
  const local = localOf({
    seats: [seatOf('sess-self')],
    endpoints: [['inst-a', { address: '10.0.0.1', port: 17321 }]],
  });
  local.member.roster = [{ ...manager }];
  const harness = stateOf(t, local);
  harness.state.probes.set(COLLAB, { failSince: 1, offline: true, inFlight: false });
  await handleEvent(harness.state, frameOf('notice', { event: 'roster', version: 10 }, manager), { remoteAddress: '10.0.0.1' });
  assert.equal(harness.state.probes.get(COLLAB).offline, false, '站长直连帧清除陈旧离线结论');
  assert.equal(managerUnreachable(harness.state, local), false);
});

test('I9 快照请求应答校验请求者来源：名单外主机不得拉取台账', async (t) => {
  const local = localOf({
    role: 'manager',
    ledger: ledgerOf({ members: [{ instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' }] }),
    seats: [seatOf('sess-a', 'manager', 1)],
    endpoints: [['inst-b', { address: '10.0.0.2', port: 17321 }]],
  });
  const harness = stateOf(t, local);
  await handleEvent(harness.state, frameOf('snapshot', { kind: 'request', managerTerm: 1, version: 10, purpose: 'catchup' }, { instanceId: 'inst-x', sessionId: 'sess-x', identityName: '外机' }), { remoteAddress: '10.0.0.9' });
  assert.equal(harness.sent.some((entry) => entry.type === 'snapshot' && entry.payload.kind === 'data'), false, '名单外请求不应答');
  await handleEvent(harness.state, frameOf('snapshot', { kind: 'request', managerTerm: 1, version: 10, purpose: 'catchup' }, { instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' }), { remoteAddress: '10.0.0.2' });
  assert.equal(harness.sent.some((entry) => entry.type === 'snapshot' && entry.payload.kind === 'data'), true, '名单成员照常应答');
});

test('I10 窗口判定不回退陈旧快照：已采纳更高任期无窗口时按手动接管', async (t) => {
  const manager = { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' };
  const selfRow = { instanceId: 'inst-self', sessionId: 'sess-self', identityName: '本机' };
  const local = localOf({
    ledger: ledgerOf({
      term: 2, version: 10, manager,
      members: [selfRow],
      window: { windowBaseTerm: 2, windowEndsAt: iso(NOW + 60000) },
    }),
    seats: [seatOf('sess-self')],
  });
  const harness = stateOf(t, local);
  const runtime = m5RuntimeOf(harness.state);
  runtime.termState = new Map([[COLLAB, { managerTerm: 3, manager: { ...manager }, version: 11 }]]);
  runtime.challenges.set(`${COLLAB}\u0000sess-self`, {
    token: 'tok-i10',
    deadline: NOW + 1000,
    highest: { term: 2, version: 10, manager },
    sessionId: 'sess-self',
  });
  const result = await takeOver(harness.state, { collabId: COLLAB, sessionId: 'sess-self', token: 'tok-i10' });
  assert.equal(result.ok, true, result.message);
  const changes = local.ledger.events.filter((event) => event.type === 'manager-changed');
  assert.equal(changes.at(-1)?.via, 'takeover-manual', '陈旧快照窗口不得把手动接管误判为窗口接管');
});

test('C3 伪造 auto-offer + 自签 auto → 拒收；随后的更高任期快照按 A10 拒收并冻结', async (t) => {
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
  /* 设计 A2/A10：无本地匹配 auto-offer 的更高任期证据一律拒收并冻结——不得经快照台账转正。 */
  const forgedLedger = ledgerOf({ term: 2, version: 11, manager: attacker });
  await handleEvent(harness.state, frameOf('snapshot', {
    kind: 'data', managerTerm: 2, version: 11, digest: ledgerDigest(forgedLedger), ledger: forgedLedger,
  }, attacker), { remoteAddress: '10.0.0.3' });
  assert.equal(m5RuntimeOf(harness.state).frozen.get(COLLAB), 'manager-fork', '无本地 offer 的更高任期证据按 A10 冻结');
  assert.equal(local.member.manager.instanceId, 'inst-a', '冻结态不改现任站长');
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
  const managerRows = local.ledger.members.filter((row) => row.role === 'manager');
  assert.equal(managerRows.length, 1, '台账有且仅有一行 manager');
  assert.equal(managerRows[0].sessionId, 'sess-b', 'manager 行按席位键精确匹配目标会话');
  assert.equal(local.ledger.members.find((row) => row.sessionId === 'sess-a').role, 'member', '同实例旧站长行降为 member');
  assert.equal(isLedgerShape(local.ledger), true, '同机移交后台账形态合法');
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

/* 远端站长经真实事件管线送达的 offer（空 endpoints 表示端点尚未学习）。 */
function handoverOfferFrameOf(ledger, endpoints = {}) {
  return frameOf('handover', {
    kind: 'offer',
    offerId: 'offer-remote',
    baseTerm: ledger.managerTerm,
    version: ledger.version,
    digest: ledgerDigest(ledger),
    ledger,
    endpoints,
    expiresAt: iso(NOW + 60000),
  }, { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' });
}

test('C5 远端显式移交拒绝：移交方端点未知 → 明确失败并计数，记录保留可重试', async (t) => {
  const local = localOf({ seats: [seatOf('sess-self')] });
  const harness = stateOf(t, local);
  const offer = handoverOfferFrameOf(ledgerOf());
  await handleEvent(harness.state, offer);
  const rejected = rejectHandover(harness.state, { collabId: COLLAB, sessionId: 'sess-self', offerId: offer.payload.offerId, reason: 'rejected' });
  assert.equal(rejected.ok, false, '未送达的回执不得报成功');
  assert.equal(rejected.reason, 'endpoint-unknown');
  assert.match(rejected.message, /端点未知/);
  assert.equal(harness.state.counters.handoverRejectFailures, 1);
  assert.equal(harness.sent.length, 0, '端点未知时不得发帧');
  const record = m5RuntimeOf(harness.state).handoverOffers.get(COLLAB).get(offer.payload.offerId);
  assert.equal(record.state, 'open', '回执未送达时保留 offer 以便重试');
  local.endpoints.set('inst-a', { address: '10.0.0.1', port: 17321 });
  const retried = rejectHandover(harness.state, { collabId: COLLAB, sessionId: 'sess-self', offerId: offer.payload.offerId, reason: 'rejected' });
  assert.equal(retried.ok, true, retried.message);
  assert.equal(harness.sent.length, 1, '端点可知后重试回执成功');
});

test('C5 远端显式移交拒绝：回执入队失败 → 明确失败并计数', async (t) => {
  const local = localOf({ seats: [seatOf('sess-self')] });
  local.endpoints.set('inst-a', { address: '10.0.0.1', port: 17321 });
  const attempts = [];
  const harness = stateOf(t, local, {
    state: {
      send: (message) => {
        attempts.push(message);
        return { ok: false, reason: '发送队列已满' };
      },
    },
  });
  const offer = handoverOfferFrameOf(ledgerOf());
  await handleEvent(harness.state, offer);
  const rejected = rejectHandover(harness.state, { collabId: COLLAB, sessionId: 'sess-self', offerId: offer.payload.offerId, reason: 'rejected' });
  assert.equal(rejected.ok, false, '入队失败不得报成功');
  assert.equal(rejected.reason, 'send-failed');
  assert.match(rejected.message, /发送队列已满/);
  assert.equal(harness.state.counters.handoverRejectFailures, 1);
  assert.equal(attempts.length, 1);
  const record = m5RuntimeOf(harness.state).handoverOffers.get(COLLAB).get(offer.payload.offerId);
  assert.equal(record.state, 'open', '入队失败时保留 offer 以便重试');
});

test('C5 远端显式移交拒绝：回执入队成功 → 成功并作废记录', async (t) => {
  const local = localOf({ seats: [seatOf('sess-self')], endpoints: [['inst-a', { address: '10.0.0.1', port: 17321 }]] });
  const harness = stateOf(t, local);
  const offer = handoverOfferFrameOf(ledgerOf());
  await handleEvent(harness.state, offer);
  const rejected = rejectHandover(harness.state, { collabId: COLLAB, sessionId: 'sess-self', offerId: offer.payload.offerId, reason: 'rejected' });
  assert.equal(rejected.ok, true, rejected.message);
  const record = m5RuntimeOf(harness.state).handoverOffers.get(COLLAB).get(offer.payload.offerId);
  assert.equal(record.state, 'rejected');
  const frame = harness.sent.find((entry) => entry.type === 'handover');
  assert.equal(frame.payload.kind, 'reject');
  assert.equal(frame.payload.reason, 'rejected');
  assert.equal(frame.to.instanceId, 'inst-a');
  assert.equal(frame.fromSessionId, 'sess-self');
  assert.equal(harness.state.counters.handoverRejectedOut, 1);
  assert.equal(harness.state.counters.handoverRejectFailures ?? 0, 0);
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
  const local = localOf({
    ledger: ledgerOf({ members: [rival] }),
    seats: [seatOf('sess-self')],
  });
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

/* —— 真实路由归属、任期基线、自动移交 accept 与手动接管证据 —— */

function routingHarnessOf(t) {
  const dir = makeTempDir(t);
  const out = [];
  const entries = [];
  const registry = {
    register(record) {
      const entry = { bridgeId: record.bridgeId, sessionId: record.sessionId ?? null, record };
      entries.push(entry);
      return entry;
    },
    remove(record) {
      const index = entries.findIndex((entry) => entry.record === record);
      if (index >= 0) {
        entries.splice(index, 1);
      }
    },
    count: () => entries.length,
    list: () => [...entries],
    find: (sessionId) => entries.find((entry) => entry.sessionId === sessionId) ?? null,
  };
  const router = createInjectionRouter({
    dataDir: dir,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    describeCollab: () => ({ name: '项目', mode: 'managed' }),
  });
  router.load();
  router.attach({
    registry,
    ipc: {
      send: (record, frame) => {
        out.push({ record, frame });
        return true;
      },
    },
  });
  return { router, registry, out };
}

function bridgeOf(bridgeId, sessionId) {
  return { connId: bridgeId, bridgeId, sessionId, send: () => {} };
}

test('C5 同机显式移交：目标会话经真实路由面收到 offerId（不再投给发起会话）', async (t) => {
  const ledger = ledgerOf({ manager: { instanceId: 'inst-self', sessionId: 'sess-a', identityName: '本机' }, members: [{ instanceId: 'inst-self', sessionId: 'sess-b', identityName: '乙' }] });
  const local = localOf({ role: 'manager', ledger, seats: [seatOf('sess-a', 'manager', 1), seatOf('sess-b')], endpoints: [] });
  const harness = stateOf(t, local);
  const { router, registry, out } = routingHarnessOf(t);
  registry.register(bridgeOf('bridge-a', 'sess-a'));
  registry.register(bridgeOf('bridge-b', 'sess-b'));
  harness.state.notify = (frame) => router.notify(frame);
  const offered = await router.runCall(
    { bridgeId: 'bridge-a', sessionId: 'sess-a', notices: [] },
    () => handover(harness.state, { collabId: COLLAB, target: 'inst-self', targetSessionId: 'sess-b' }),
  );
  assert.equal(offered.ok, true, offered.message);
  const pushes = out.filter((entry) => entry.frame.type === 'push');
  const targetPush = pushes.find((entry) => entry.record.bridgeId === 'bridge-b');
  assert.ok(targetPush, '目标会话收到带 offerId 的本机提示');
  assert.ok(targetPush.frame.text.includes(offered.offerId), '提示文本含 offerId');
  assert.equal(pushes.some((entry) => entry.record.bridgeId === 'bridge-a'), false, '不再投给发起会话');
  for (const entry of pushes) {
    router.settleDelivered({ type: 'delivered', pushId: entry.frame.pushId, ok: true });
  }
  const challenge = confirmHandover(harness.state, { collabId: COLLAB, sessionId: 'sess-b', offerId: offered.offerId });
  assert.equal(challenge.needsUserConfirmation, true, '目标会话可凭收到的 offerId 继续确认');
});

/* 目标侧按 offer 台账重算的最终台账摘要（adoptHandoverAsTarget 的 digest 校验基准）。 */
function handoverChangeDigestOf(record, change) {
  const ledger = structuredClone(record.ledger);
  const prevManager = ledger.manager;
  const selfRow = ledger.members.find((member) => member.instanceId === 'inst-self'
    && (member.sessionId === undefined || member.sessionId === change.manager.sessionId));
  const managerRow = ledger.members.find((member) => member.role === 'manager'
    && member.instanceId === prevManager.instanceId
    && (member.sessionId === undefined || member.sessionId === prevManager.sessionId));
  managerRow.role = 'member';
  selfRow.role = 'manager';
  selfRow.state = 'member';
  ledger.managerTerm = record.baseTerm + 1;
  ledger.version = record.version + 1;
  ledger.updatedAt = change.effectiveAt;
  ledger.manager = { instanceId: selfRow.instanceId, sessionId: selfRow.sessionId, identityName: selfRow.identityName, term: ledger.managerTerm };
  delete ledger.managerWindow;
  ledger.events = [
    ...(Array.isArray(ledger.events) ? ledger.events : []),
    { type: 'manager-changed', via: 'handover', offerId: record.offerId, term: ledger.managerTerm, version: ledger.version, prevManager, manager: ledger.manager, at: change.effectiveAt },
  ];
  return ledgerDigest(ledger);
}

test('C4 任期基线：已采纳 termState 领先快照时，陈旧 accepted offer 不得降回并顶替现任站长', async (t) => {
  const managerA = { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' };
  const managerC = { instanceId: 'inst-c', sessionId: 'sess-c', identityName: '丙' };
  const target = { instanceId: 'inst-self', sessionId: 'sess-self', identityName: '本机' };
  const staleLedger = ledgerOf({ term: 1, version: 10, manager: managerA, members: [target, managerC] });
  const local = localOf({ seats: [seatOf('sess-self')], ledger: staleLedger, endpoints: [] });
  const harness = stateOf(t, local);
  local.member.manager = { instanceId: 'inst-c', identityName: '丙' };
  m5RuntimeOf(harness.state).termState = new Map([[COLLAB, {
    managerTerm: 3,
    manager: { ...managerC },
    version: 30,
  }]]);
  const record = {
    offerId: 'offer-stale', baseTerm: 1, version: 10, digest: ledgerDigest(staleLedger), ledger: staleLedger,
    from: { instanceId: 'inst-a', sessionId: 'sess-a' }, target, state: 'accepted', expiresAt: iso(NOW + 60000),
  };
  m5RuntimeOf(harness.state).handoverOffers.set(COLLAB, new Map([[record.offerId, record]]));
  const changePayload = {
    event: 'manager-changed', via: 'handover', term: 2, version: 11, manager: target,
    prevManager: { instanceId: 'inst-a', sessionId: 'sess-a' }, offerId: 'offer-stale',
    effectiveAt: iso(), endpoint: { address: '10.0.0.1', port: 17321 },
  };
  changePayload.digest = handoverChangeDigestOf(record, changePayload);
  await handleEvent(harness.state, frameOf('notice', changePayload, { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' }), { remoteAddress: '10.0.0.1' });
  assert.equal(local.role, 'member', '陈旧 offer 不得提升目标');
  assert.equal(local.snapshot.ledger.manager.instanceId, 'inst-a', '本地快照不被改写');
  assert.equal(local.member.manager.instanceId, 'inst-c', '已采纳的现任站长不被降回');
  assert.equal(harness.state.counters.handoverTargetsPromoted ?? 0, 0, '未走受让提升旁路');
});

/* 自动移交走到「目标已 accept、旧站长进入 manager-pending」的夹具（两候选成员，首位 inst-b）。 */
async function autoAcceptPendingOf(t) {
  const ledger = ledgerOf({ members: [
    { instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' },
    { instanceId: 'inst-c', sessionId: 'sess-c', identityName: '丙' },
  ] });
  const local = localOf({
    role: 'manager',
    ledger,
    seats: [seatOf('sess-a', 'manager', 1)],
    endpoints: [['inst-b', { address: '10.0.0.7', port: 17321 }], ['inst-c', { address: '10.0.0.8', port: 17321 }]],
  });
  const harness = stateOf(t, local, { config: { dialTimeoutMs: 5 } });
  const dispatched = autoTransfer(harness.state, { collabId: COLLAB, managerSessionId: 'sess-a' });
  assert.equal(dispatched.ok, true, JSON.stringify(dispatched));
  assert.equal(dispatched.target.instanceId, 'inst-b', '按 joinSeq 取首位候选');
  await handleEvent(harness.state, frameOf('handover', {
    kind: 'accept', offerId: dispatched.offerId, baseTerm: 1, version: 10, digest: ledgerDigest(ledger), confirm: true,
  }, { instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' }), { remoteAddress: '10.0.0.7' });
  return { local, harness, dispatched };
}

test('C5 自动移交 accept：进入 manager-pending，定时器到期不顺延下一人', async (t) => {
  const { local, harness } = await autoAcceptPendingOf(t);
  assert.equal(harness.state.counters.autoAcceptReceived ?? 0, 1, 'auto accept 不得被当迟到丢弃');
  assert.equal(m5RuntimeOf(harness.state).managerPending.has(COLLAB), true, '已收 accept 未收签发 → manager-pending');
  assert.equal(m5RuntimeOf(harness.state).frozen.get(COLLAB), 'manager-pending');
  assert.equal(['handover-pending', 'manager-pending'].includes(local.suspended.reason), true, '停写原因升级为等待签发');
  assert.equal(local.suspended.deadline, null, 'pending 等待无到期解挂');
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(harness.sent.filter((entry) => entry.type === 'handover' && entry.payload.kind === 'offer').length, 1, '超时不得顺延下一候选');
  assert.equal(harness.state.counters.autoAcceptTimeouts ?? 0, 0, '已收 accept 不计自动接受超时');
  assert.equal(local.ledger.managerTerm, 1, '旧站长任期不变');
  assert.notEqual(local.suspended, null, '到期后仍只读等待');
});

test('C5 manager-pending：伪造接管拒收，重启按生产写盘记录恢复', async (t) => {
  const { local, harness, dispatched } = await autoAcceptPendingOf(t);
  await handleEvent(harness.state, frameOf('notice', changeOf({
    via: 'takeover-manual', term: 2, version: 11,
    manager: { instanceId: 'inst-c', sessionId: 'sess-c', identityName: '丙' },
    prevManager: { instanceId: 'inst-a', sessionId: 'sess-a' }, authorizedAt: iso(),
  }), { instanceId: 'inst-c', sessionId: 'sess-c', identityName: '丙' }), { remoteAddress: '10.0.0.8' });
  await handleEvent(harness.state, frameOf('notice', changeOf({
    via: 'auto', term: 2, version: 11,
    manager: { instanceId: 'inst-c', sessionId: 'sess-c', identityName: '丙' },
    prevManager: { instanceId: 'inst-a', sessionId: 'sess-a' }, offerId: 'forged-auto',
    windowEndsAt: iso(NOW + 60000), authorizedAt: iso(),
  }), { instanceId: 'inst-c', sessionId: 'sess-c', identityName: '丙' }), { remoteAddress: '10.0.0.8' });
  assert.equal(local.role, 'manager', 'pending 期间不被第三方顶替');
  assert.equal(local.ledger.manager.sessionId, 'sess-a', '同 term 双主攻击不得改写台账');
  assert.equal(m5RuntimeOf(harness.state).frozen.get(COLLAB), 'manager-pending', '冻结不被单一 +1 变更解除');

  const pendingFile = join(collabDir(harness.dir, COLLAB), 'run', 'manager-pending.json');
  const onDisk = JSON.parse(readFileSync(pendingFile, 'utf8'));
  assert.equal(onDisk.offerId, dispatched.offerId, 'manager-pending 由生产路径落盘');
  const runtime = m5RuntimeOf(harness.state);
  runtime.managerPending.delete(COLLAB);
  runtime.frozen.delete(COLLAB);
  runtime.frozenFrom.delete(COLLAB);
  local.suspended = null;
  restoreM5State(harness.state);
  assert.equal(runtime.managerPending.has(COLLAB), true, '重启按写盘记录恢复 manager-pending');
  assert.equal(runtime.frozen.get(COLLAB), 'manager-pending');
  assert.equal(local.suspended.reason, 'manager-pending');
  assert.equal(local.suspended.deadline, null);
});

test('探测失联计时用单调钟：墙钟前跳不冻结，单调钟超时才冻结', async (t) => {
  const local = localOf({ seats: [seatOf('sess-self')], endpoints: [['inst-a', { address: '10.0.0.1', port: 17321 }]] });
  const harness = stateOf(t, local, { config: { managerLossTimeoutMs: 1000 } });
  harness.state.probe = async () => ({ reachable: false, reason: '超时' });
  runProbeTick(harness.state);
  await new Promise((resolve) => setTimeout(resolve, 10));
  harness.clock.now = NOW + 10 * 60 * 1000;
  harness.mono.now += 500;
  runProbeTick(harness.state);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(m5RuntimeOf(harness.state).frozen.has(COLLAB), false, '墙钟前跳不得触发探测失联冻结');
  harness.mono.now += 1000;
  runProbeTick(harness.state);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(m5RuntimeOf(harness.state).frozen.get(COLLAB), 'manager-offline', '单调钟超过失联时限才冻结');
});

test('A4 手动接管：站长本人应答不构成其他成员见证；挑战期内站长应答即放弃接管', async (t) => {
  const ledger = ledgerOf({ members: [
    { instanceId: 'inst-self', sessionId: 'sess-self', identityName: '本机' },
    { instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' },
  ] });
  const local = localOf({ seats: [seatOf('sess-self')], endpoints: [['inst-a', { address: '10.0.0.1', port: 17321 }]], ledger });
  const harness = stateOf(t, local);
  m5RuntimeOf(harness.state).managerEvidenceAt.set(COLLAB, harness.mono.now - 400000);
  const pending = takeOver(harness.state, { collabId: COLLAB, sessionId: 'sess-self' });
  m5RuntimeOf(harness.state).handshakeResponses.set(COLLAB, new Map([['inst-a', {
    term: 1, version: 10,
    manager: { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' },
    seat: { instanceId: 'inst-a', sessionId: 'sess-a' },
  }]]));
  const managerOnly = await pending;
  assert.equal(managerOnly.ok, false, '站长本人应答不得充当成员见证');
  assert.match(managerOnly.message, /可达|放弃接管/);

  const second = takeOver(harness.state, { collabId: COLLAB, sessionId: 'sess-self' });
  m5RuntimeOf(harness.state).handshakeResponses.set(COLLAB, new Map([['inst-b', {
    term: 1, version: 10,
    manager: { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' },
    seat: { instanceId: 'inst-b', sessionId: 'sess-b' },
  }]]));
  const challenge = await second;
  assert.equal(challenge.ok, true, challenge.message);
  m5RuntimeOf(harness.state).handshakeResponses.set(COLLAB, new Map([['inst-a', {
    term: 1, version: 10,
    manager: { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' },
    seat: { instanceId: 'inst-a', sessionId: 'sess-a' },
  }]]));
  const done = await takeOver(harness.state, { collabId: COLLAB, sessionId: 'sess-self', token: challenge.token });
  assert.equal(done.ok, false, '确认前站长已应答可达 → 放弃接管');
  assert.match(done.message, /应答|可达/);
  assert.equal(local.role, 'member');
});

test('C6 手动接管负例：frozen(manager-pending)/frozen(manager-fork) 一律拒绝', async (t) => {
  for (const reason of ['manager-pending', 'manager-fork']) {
    const local = localOf({ seats: [seatOf('sess-self')], endpoints: [] });
    const harness = stateOf(t, local);
    applyManagerFreeze(harness.state, COLLAB, reason);
    const verdict = await takeOver(harness.state, { collabId: COLLAB, sessionId: 'sess-self' });
    assert.equal(verdict.ok, false, `${reason} 下不得发起手动接管`);
    assert.ok(verdict.message.includes(reason), verdict.message);
    assert.equal(local.role, 'member');
  }
});

test('A3 窗口内接管不因站长应答而放弃（与手动接管的可达性前提分离）', async (t) => {
  const window = { windowBaseTerm: 1, windowEndsAt: iso(NOW + 60000) };
  const ledger = ledgerOf({ term: 1, version: 10, window, members: [
    { instanceId: 'inst-self', sessionId: 'sess-self', identityName: '本机' },
    { instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' },
  ] });
  const local = localOf({
    seats: [seatOf('sess-self')],
    ledger,
    endpoints: [['inst-a', { address: '10.0.0.1', port: 17321 }], ['inst-b', { address: '10.0.0.2', port: 17321 }]],
  });
  const harness = stateOf(t, local);
  const pending = takeOver(harness.state, { collabId: COLLAB, sessionId: 'sess-self' });
  m5RuntimeOf(harness.state).handshakeResponses.set(COLLAB, new Map([
    ['inst-a', { term: 1, version: 10, manager: { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' }, seat: { instanceId: 'inst-a', sessionId: 'sess-a' } }],
    ['inst-b', { term: 1, version: 10, manager: { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' }, seat: { instanceId: 'inst-b', sessionId: 'sess-b' } }],
  ]));
  const challenge = await pending;
  assert.equal(challenge.ok, true, challenge.message);
  const done = await takeOver(harness.state, { collabId: COLLAB, sessionId: 'sess-self', token: challenge.token });
  assert.equal(done.ok, true, done.message);
  assert.equal(local.ledger.manager.sessionId, 'sess-self');
  assert.equal(local.ledger.managerWindow, undefined);
  assert.equal(harness.sent.find((entry) => entry.payload?.event === 'manager-changed')?.payload.via, 'takeover');
});

test('宽限期内同会话重连 → 宽限到期不离席、名单行保留', async (t) => {
  const ledger = ledgerOf({ members: [{ instanceId: 'inst-self', sessionId: 'sess-b', identityName: '乙' }] });
  const local = localOf({ role: 'manager', ledger, seats: [seatOf('sess-a', 'manager', 1), seatOf('sess-b')], endpoints: [] });
  const harness = stateOf(t, local, { config: { sessionSeatGraceMs: 1000 } });
  noteSeatClosed(harness.state, COLLAB, 'sess-b', harness.clock.now);
  local.seats.get('sess-b').bridgeId = 'bridge-reopened';
  sweepSeatGrace(harness.state, harness.clock.now + 2000);
  assert.notEqual(local.seats.get('sess-b'), undefined, '席位对象保留（未按关闭收尾）');
  assert.equal(local.ledger.members.some((row) => row.sessionId === 'sess-b'), true, '共享名单行保留');
  assert.equal(m5RuntimeOf(harness.state).closedSeats.size, 0, '重开即清宽限计时');
});

test('站长核上的成员席位离席 → 移除共享名单行并广播 roster', async (t) => {
  const ledger = ledgerOf({ members: [
    { instanceId: 'inst-self', sessionId: 'sess-b', identityName: '乙' },
    { instanceId: 'inst-c', sessionId: 'sess-c', identityName: '丙' },
  ] });
  const local = localOf({
    role: 'manager',
    ledger,
    seats: [seatOf('sess-a', 'manager', 1), seatOf('sess-b')],
    endpoints: [['inst-c', { address: '10.0.0.3', port: 17321 }]],
  });
  const harness = stateOf(t, local);
  /* 服务层按席位切换角色后调用（站长核上成员席位离席）。 */
  local.role = 'member';
  const result = leaveCollab(harness.state, { collabId: COLLAB, sessionId: 'sess-b' });
  local.role = 'manager';
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(local.ledger.members.some((row) => row.sessionId === 'sess-b'), false, '共享名单行由站长核移除');
  const roster = harness.sent.find((entry) => entry.type === 'notice' && entry.payload?.event === 'roster');
  assert.ok(roster, '名单变更广播给其余成员');
  assert.equal(roster.to.instanceId, 'inst-c');
  assert.equal(roster.payload.version, local.ledger.version);
});

test('manager-changed 受理后向其余成员转达（from 保持原发席位）', async (t) => {
  const ledger = ledgerOf({ members: [{ instanceId: 'inst-c', sessionId: 'sess-c', identityName: '丙' }] });
  const local = localOf({ seats: [seatOf('sess-self')], ledger, endpoints: [['inst-c', { address: '10.0.0.3', port: 17321 }]] });
  const harness = stateOf(t, local);
  await handleEvent(harness.state, frameOf('notice', changeOf({
    via: 'handover', term: 2, version: 11,
    manager: { instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' },
    prevManager: { instanceId: 'inst-a', sessionId: 'sess-a' }, offerId: 'offer-relay',
  }), { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' }), { remoteAddress: '10.0.0.1' });
  const relayed = harness.sent.find((entry) => entry.type === 'notice' && entry.payload?.event === 'manager-changed' && entry.to?.instanceId === 'inst-c');
  assert.ok(relayed, '受理的站长变更转发给其余成员');
  assert.ok(relayed.payload.originMsgId, '转达帧带 originMsgId');
  assert.equal(relayed.from.instanceId, 'inst-a', 'from 保持原发席位');
  assert.equal(relayed.payload.manager.instanceId, 'inst-b');
});

test('旧站长重启降级：直连 handshake 绑定的更高任期快照被采纳；无应答证据仍拒收冻结', async (t) => {
  const managerA = { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' };
  const managerB = { instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙' };
  const base = ledgerOf({ term: 1, version: 10, manager: managerA, members: [managerB] });
  const local = localOf({ role: 'manager', ledger: base, seats: [seatOf('sess-a', 'manager', 1)], endpoints: [['inst-b', { address: '10.0.0.2', port: 17321 }]] });
  const harness = stateOf(t, local);
  openManagerCatchupWindow(harness.state, COLLAB);
  m5RuntimeOf(harness.state).handshakeResponses.set(COLLAB, new Map([['inst-b', {
    term: 2, version: 11, manager: { ...managerB }, seat: { instanceId: 'inst-b', sessionId: 'sess-b' },
  }]]));
  const next = ledgerOf({ term: 2, version: 11, manager: managerB, members: [{ instanceId: 'inst-self', sessionId: 'sess-self', identityName: '本机' }] });
  await handleEvent(harness.state, frameOf('snapshot', {
    kind: 'data', managerTerm: 2, version: 11, digest: ledgerDigest(next), ledger: next,
  }, managerB), { remoteAddress: '10.0.0.2' });
  assert.equal(local.role, 'member', '旧站长按更高任期退回成员');
  assert.equal(local.member.manager.instanceId, 'inst-b');
  assert.equal(local.snapshot.ledger.managerTerm, 2, '快照台账成为新基线');
  assert.equal(local.snapshot.ledger.manager.instanceId, 'inst-b');
  assert.equal(m5RuntimeOf(harness.state).frozen.has(COLLAB), false);

  const bare = localOf({ role: 'manager', ledger: base, seats: [seatOf('sess-a', 'manager', 1)], endpoints: [['inst-b', { address: '10.0.0.2', port: 17321 }]] });
  const bareHarness = stateOf(t, bare);
  await handleEvent(bareHarness.state, frameOf('snapshot', {
    kind: 'data', managerTerm: 2, version: 11, digest: ledgerDigest(next), ledger: next,
  }, managerB), { remoteAddress: '10.0.0.2' });
  assert.equal(bare.role, 'manager', '无握手应答证据不得凭快照降级');
  assert.equal(m5RuntimeOf(bareHarness.state).frozen.get(COLLAB), 'manager-fork');
});

test('首份快照采纳：回填成员名/主题并把 proposed 提升为 active', async (t) => {
  const manager = { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲' };
  const ledger = ledgerOf({ manager, members: [{ instanceId: 'inst-self', sessionId: 'sess-self', identityName: '本机' }] });
  ledger.name = '真实项目名';
  ledger.topic = '真实主题';
  const local = localOf({ seats: [seatOf('sess-self')], snapshot: null });
  local.member.name = COLLAB;
  local.member.topic = undefined;
  local.member.state = 'proposed';
  const harness = stateOf(t, local);
  await handleEvent(harness.state, frameOf('snapshot', {
    kind: 'data', managerTerm: 1, version: 10, digest: ledgerDigest(ledger), ledger,
  }, manager), { remoteAddress: '10.0.0.1' });
  assert.equal(local.member.name, '真实项目名', '成员名按台账回填');
  assert.equal(local.member.topic, '真实主题');
  assert.equal(local.member.state, 'active', 'proposed 在采纳快照后转 active');
});

test('讨论邀请接受：invite-stub 载体升级为 session-seats，重启判档不再隐藏参与', async (t) => {
  const forumMember = {
    ...memberRecordOf({ instanceId: 'inst-a', identityName: '甲' }),
    role: 'member',
    state: 'proposed',
    decision: null,
    mode: 'forum',
    name: '讨论甲',
    topic: '议题',
    manager: { instanceId: 'inst-a', identityName: '甲' },
  };
  const local = localOf({ member: forumMember, seats: [seatOf('sess-self')], ledger: ledgerOf({ mode: 'forum' }) });
  local.member = forumMember;
  local.ledger = null;
  local.snapshot = null;
  local.posts = { size: () => 0, ownBaseline: () => ({ ts: null }) };
  local.members = { apply: () => 'added', baselineTsOf: () => null, events: () => [], fold: () => [], includes: () => true };
  local.mute = { setMuted: () => ({ wasMuted: false }), clear: () => {} };
  const harness = stateOf(t, local);
  harness.state.joinReplayIntervalsMs = [10, 20];
  const dir = collabDir(harness.dir, COLLAB);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'carrier.json'), JSON.stringify({
    format: 'invite-stub', version: 1, collabId: COLLAB, name: '讨论甲', topic: '议题', mode: 'forum',
    endpoints: {}, snapshotVersion: 0, createdAt: iso(),
  }), 'utf8');
  const result = approveInvite(harness.state, { collabId: COLLAB, approve: true });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.joined, true);
  const carrier = readCarrier(dir).carrier;
  assert.equal(carrier.format, 'session-seats', '接受后升级为真正入席的载体形态');
  assert.equal(carrier.mode, 'forum');
  assert.equal(carrier.snapshotVersion, 0);
  assert.equal(classifyCollabDir(dir).kind, 'session-seats', '重启判档不再按邀请占位跳过');
});
