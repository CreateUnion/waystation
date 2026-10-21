import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyDirectFrame,
  applySeatPresence,
  autoSuccessorCandidates,
  createPresenceTable,
  expireSeats,
  isReachable,
} from '../src/collab/presence.js';

const NOW = Date.parse('2026-10-21T10:00:00.000Z');
const COLLAB = 'collab-1';
const TIMEOUT = 300000;

function iso(ms) {
  return new Date(ms).toISOString();
}

function seat(instanceId, sessionId, joinSeq, role = 'member') {
  return { instanceId, sessionId, joinSeq, role };
}

function presenceOf(table, instanceId, sessionId) {
  return [...table.values()].find((entry) => entry.instanceId === instanceId && entry.sessionId === sessionId);
}

function listOf(table) {
  return [...table.values()].map((entry) => `${entry.instanceId}/${entry.sessionId}`);
}

test('createPresenceTable：空表', () => {
  const table = createPresenceTable();
  assert.ok(table instanceof Map);
  assert.equal(table.size, 0);
});

test('applySeatPresence：只刷新列表内席位，同机未列席位标 unlisted', () => {
  const table = createPresenceTable();
  applySeatPresence(
    table,
    { collabId: COLLAB, instanceId: 'inst-a', sessions: ['session-a', 'session-a2'], sentAt: iso(NOW) },
    NOW,
  );
  applySeatPresence(
    table,
    { collabId: COLLAB, instanceId: 'inst-b', sessions: ['session-b'], sentAt: iso(NOW) },
    NOW,
  );
  assert.deepEqual(listOf(table).sort(), ['inst-a/session-a', 'inst-a/session-a2', 'inst-b/session-b']);
  const later = NOW + 30000;
  const result = applySeatPresence(
    table,
    { collabId: COLLAB, instanceId: 'inst-a', sessions: ['session-a'], sentAt: iso(later) },
    later,
  );
  assert.deepEqual(result.refreshed, [{ instanceId: 'inst-a', sessionId: 'session-a' }]);
  assert.deepEqual(result.unlisted, [{ instanceId: 'inst-a', sessionId: 'session-a2' }]);
  assert.equal(presenceOf(table, 'inst-a', 'session-a').lastSeenAt, later);
  assert.equal(presenceOf(table, 'inst-a', 'session-a').lastPresenceListAt, later);
  assert.equal(presenceOf(table, 'inst-a', 'session-a2').lastSeenAt, NOW);
  assert.equal(presenceOf(table, 'inst-a', 'session-a2').unlisted, true);
  assert.equal(presenceOf(table, 'inst-b', 'session-b').lastSeenAt, NOW);
  assert.equal(presenceOf(table, 'inst-b', 'session-b').unlisted, false);
});

test('applySeatPresence：重新列出的 unlisted 席位恢复可达', () => {
  const table = createPresenceTable();
  applySeatPresence(table, { collabId: COLLAB, instanceId: 'inst-a', sessions: ['session-a', 'session-a2'], sentAt: iso(NOW) }, NOW);
  applySeatPresence(table, { collabId: COLLAB, instanceId: 'inst-a', sessions: ['session-a'], sentAt: iso(NOW) }, NOW + 1000);
  assert.equal(presenceOf(table, 'inst-a', 'session-a2').unlisted, true);
  applySeatPresence(table, { collabId: COLLAB, instanceId: 'inst-a', sessions: ['session-a2'], sentAt: iso(NOW) }, NOW + 2000);
  assert.equal(presenceOf(table, 'inst-a', 'session-a2').unlisted, false);
  assert.equal(presenceOf(table, 'inst-a', 'session-a2').lastSeenAt, NOW + 2000);
});

test('applySeatPresence：其它协作与其它机器的席位不受影响', () => {
  const table = createPresenceTable();
  applySeatPresence(table, { collabId: COLLAB, instanceId: 'inst-a', sessions: ['session-a'], sentAt: iso(NOW) }, NOW);
  applySeatPresence(table, { collabId: 'collab-2', instanceId: 'inst-a', sessions: ['session-a'], sentAt: iso(NOW) }, NOW);
  const result = applySeatPresence(table, { collabId: COLLAB, instanceId: 'inst-a', sessions: ['session-other'], sentAt: iso(NOW) }, NOW + 1000);
  assert.deepEqual(result.unlisted, [{ instanceId: 'inst-a', sessionId: 'session-a' }]);
  const other = [...table.values()].filter((entry) => entry.collabId === 'collab-2');
  assert.equal(other.length, 1);
  assert.equal(other[0].unlisted, false);
  assert.equal(other[0].lastSeenAt, NOW);
});

test('applyDirectFrame：直连来源刷新，转达帧（originMsgId）不刷新', () => {
  const table = createPresenceTable();
  const direct = { collabId: COLLAB, from: { instanceId: 'inst-a', sessionId: 'session-a' }, at: NOW };
  const first = applyDirectFrame(table, direct, NOW);
  assert.equal(first.refreshed, true);
  assert.equal(presenceOf(table, 'inst-a', 'session-a').lastSeenAt, NOW);
  const later = NOW + 5000;
  const relayed = {
    collabId: COLLAB,
    from: { instanceId: 'inst-a', sessionId: 'session-a' },
    at: later,
    originMsgId: 'msg-origin-1',
  };
  const second = applyDirectFrame(table, relayed, later);
  assert.equal(second.refreshed, false);
  assert.equal(second.reason, 'relayed');
  assert.equal(presenceOf(table, 'inst-a', 'session-a').lastSeenAt, NOW);
  const fresh = { collabId: COLLAB, from: { instanceId: 'inst-b', sessionId: 'session-b' }, at: later };
  const third = applyDirectFrame(table, fresh, later);
  assert.equal(third.refreshed, true);
  assert.equal(presenceOf(table, 'inst-b', 'session-b').lastSeenAt, later);
});

test('applyDirectFrame：非法来源不写入、不抛异常', () => {
  const table = createPresenceTable();
  assert.doesNotThrow(() => applyDirectFrame(table, null, NOW));
  assert.equal(applyDirectFrame(table, null, NOW).refreshed, false);
  assert.equal(applyDirectFrame(table, { collabId: COLLAB, from: null }, NOW).refreshed, false);
  assert.equal(table.size, 0);
});

test('expireSeats：按 lastSeenAt 超时删除并返回被删席位', () => {
  const table = createPresenceTable();
  applySeatPresence(table, { collabId: COLLAB, instanceId: 'inst-a', sessions: ['session-a'], sentAt: iso(NOW) }, NOW);
  applySeatPresence(table, { collabId: COLLAB, instanceId: 'inst-b', sessions: ['session-b'], sentAt: iso(NOW) }, NOW + 1000);
  const early = expireSeats(table, NOW + TIMEOUT - 1, TIMEOUT);
  assert.deepEqual(early, []);
  assert.equal(table.size, 2);
  const expired = expireSeats(table, NOW + TIMEOUT, TIMEOUT);
  assert.deepEqual(expired.map((entry) => entry.sessionId), ['session-a']);
  assert.equal(table.size, 1);
  assert.equal(presenceOf(table, 'inst-b', 'session-b') !== undefined, true);
});

test('isReachable：无记录按端点可达，有记录看 unlisted 与超时', () => {
  const table = createPresenceTable();
  const absent = { collabId: COLLAB, instanceId: 'inst-a', sessionId: 'session-a' };
  assert.equal(isReachable(table, absent, { now: NOW, timeoutMs: TIMEOUT }), true);
  assert.equal(isReachable(table, absent, { now: NOW, timeoutMs: TIMEOUT, hasEndpoint: false }), false);
  assert.equal(isReachable(table, absent, { now: NOW, timeoutMs: TIMEOUT, departed: true }), false);
  applySeatPresence(table, { collabId: COLLAB, instanceId: 'inst-a', sessions: ['session-a'], sentAt: iso(NOW) }, NOW);
  const present = { ...absent };
  assert.equal(isReachable(table, present, { now: NOW + 1000, timeoutMs: TIMEOUT }), true);
  assert.equal(isReachable(table, present, { now: NOW + TIMEOUT, timeoutMs: TIMEOUT }), false);
  assert.equal(isReachable(table, present, { now: NOW + 1000, timeoutMs: TIMEOUT, departed: true }), false);
  applySeatPresence(table, { collabId: COLLAB, instanceId: 'inst-a', sessions: ['session-other'], sentAt: iso(NOW) }, NOW + 2000);
  assert.equal(isReachable(table, present, { now: NOW + 2000, timeoutMs: TIMEOUT }), false);
});

test('autoSuccessorCandidates：按 joinSeq/sessionId 排序，排除旧站长、manager 角色与不可达', () => {
  const table = createPresenceTable();
  applySeatPresence(
    table,
    { collabId: COLLAB, instanceId: 'inst-a', sessions: ['session-a', 'session-c', 'session-u'], sentAt: iso(NOW) },
    NOW,
  );
  applySeatPresence(table, { collabId: COLLAB, instanceId: 'inst-a', sessions: ['session-a', 'session-c'], sentAt: iso(NOW) }, NOW + 1000);
  const seats = [
    seat('inst-a', 'session-a', 6),
    seat('inst-a', 'session-c', 5),
    seat('inst-a', 'session-u', 0),
    seat('inst-a', 'session-m', 0, 'manager'),
    seat('inst-b', 'session-x', 3),
    seat('inst-b', 'session-y', 2, 'manager'),
    seat('inst-b', 'session-b', 4),
    seat('inst-c', 'session-z', 1),
    seat('inst-a', 'session-b', 2),
  ];
  const candidates = autoSuccessorCandidates(table, seats, {
    collabId: COLLAB,
    prevManager: { instanceId: 'inst-b', sessionId: 'session-y' },
    now: NOW + 1000,
    timeoutMs: TIMEOUT,
    hasEndpoint: (value) => value.instanceId !== 'inst-c',
  });
  assert.deepEqual(candidates.map((value) => `${value.instanceId}/${value.sessionId}`), [
    'inst-a/session-b',
    'inst-b/session-x',
    'inst-b/session-b',
    'inst-a/session-c',
    'inst-a/session-a',
  ]);
});

test('autoSuccessorCandidates：departed 过滤与已判离席/超时候选', () => {
  const table = createPresenceTable();
  applySeatPresence(table, { collabId: COLLAB, instanceId: 'inst-a', sessions: ['session-stale'], sentAt: iso(NOW) }, NOW);
  const seats = [
    seat('inst-a', 'session-stale', 1),
    seat('inst-a', 'session-departed', 2),
    seat('inst-a', 'session-ok', 3),
  ];
  const candidates = autoSuccessorCandidates(table, seats, {
    collabId: COLLAB,
    prevManager: null,
    now: NOW + TIMEOUT + 1,
    timeoutMs: TIMEOUT,
    departed: (value) => value.sessionId === 'session-departed',
  });
  assert.deepEqual(candidates.map((value) => value.sessionId), ['session-ok']);
});

test('autoSuccessorCandidates：空名单与缺失 collabId 返回空数组', () => {
  const table = createPresenceTable();
  assert.deepEqual(autoSuccessorCandidates(table, [], { collabId: COLLAB, now: NOW }), []);
  assert.deepEqual(autoSuccessorCandidates(table, null, { collabId: COLLAB, now: NOW }), []);
  assert.deepEqual(autoSuccessorCandidates(table, [seat('inst-a', 'session-a', 1)], { now: NOW }), []);
});
