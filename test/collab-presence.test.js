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

function listNotice(instanceId, sessions, sentAt = NOW) {
  return { collabId: COLLAB, instanceId, sessions, sentAt: iso(sentAt) };
}

function applyList(table, notice, now, extra = {}) {
  return applySeatPresence(table, notice, now, { peerInstanceId: notice?.instanceId, ...extra });
}

function applyDirect(table, frame, now, extra = {}) {
  return applyDirectFrame(table, frame, now, { peerInstanceId: frame?.from?.instanceId, ...extra });
}

test('createPresenceTable：空表', () => {
  const table = createPresenceTable();
  assert.ok(table instanceof Map);
  assert.equal(table.size, 0);
});

test('applySeatPresence：只刷新列表内席位，同机未列席位标 unlisted', () => {
  const table = createPresenceTable();
  applyList(table, listNotice('inst-a', ['session-a', 'session-a2']), NOW);
  applyList(table, listNotice('inst-b', ['session-b']), NOW);
  assert.deepEqual(listOf(table).sort(), ['inst-a/session-a', 'inst-a/session-a2', 'inst-b/session-b']);
  const later = NOW + 30000;
  const result = applyList(table, listNotice('inst-a', ['session-a'], later), later);
  assert.deepEqual(result.refreshed, [{ instanceId: 'inst-a', sessionId: 'session-a' }]);
  assert.deepEqual(result.unlisted, [{ instanceId: 'inst-a', sessionId: 'session-a2' }]);
  assert.equal(presenceOf(table, 'inst-a', 'session-a').lastSeenAt, later);
  assert.equal(presenceOf(table, 'inst-a', 'session-a2').lastSeenAt, NOW);
  assert.equal(presenceOf(table, 'inst-a', 'session-a2').unlisted, true);
  assert.equal(presenceOf(table, 'inst-b', 'session-b').lastSeenAt, NOW);
});

test('applySeatPresence：重新列出的 unlisted 席位恢复可达', () => {
  const table = createPresenceTable();
  applyList(table, listNotice('inst-a', ['session-a', 'session-a2']), NOW);
  applyList(table, listNotice('inst-a', ['session-a']), NOW + 1000);
  assert.equal(presenceOf(table, 'inst-a', 'session-a2').unlisted, true);
  applyList(table, listNotice('inst-a', ['session-a2']), NOW + 2000);
  assert.equal(presenceOf(table, 'inst-a', 'session-a2').unlisted, false);
  assert.equal(presenceOf(table, 'inst-a', 'session-a2').lastSeenAt, NOW + 2000);
});

test('applySeatPresence：其它协作与其它机器的席位不受影响；空列表/非法形态忽略', () => {
  const table = createPresenceTable();
  applyList(table, listNotice('inst-a', ['session-a']), NOW);
  applyList(table, { ...listNotice('inst-a', ['session-a']), collabId: 'collab-2' }, NOW);
  const result = applyList(table, listNotice('inst-a', ['session-other']), NOW + 1000);
  assert.deepEqual(result.unlisted, [{ instanceId: 'inst-a', sessionId: 'session-a' }]);
  const other = [...table.values()].filter((entry) => entry.collabId === 'collab-2');
  assert.equal(other.length, 1);
  assert.equal(other[0].unlisted, false);
  assert.equal(applyList(table, listNotice('inst-b', []), NOW).refreshed.length, 0);
  assert.equal(applyList(table, null, NOW).refreshed.length, 0);
});

test('applySeatPresence：传输对端必须等于原发机器；缺 peer 证据 fail-closed', () => {
  const table = createPresenceTable();
  const notice = listNotice('inst-a', ['session-a']);
  assert.equal(applySeatPresence(table, notice, NOW).reason, 'peer-missing');
  assert.equal(applySeatPresence(table, notice, NOW, { peerInstanceId: 'inst-b' }).reason, 'peer-mismatch');
  assert.equal(table.size, 0);
  assert.deepEqual(applyList(table, notice, NOW).refreshed, [{ instanceId: 'inst-a', sessionId: 'session-a' }]);
});

test('applySeatPresence：forum 只放行当前中继转发的列表（真实 payload 形态）', () => {
  const table = createPresenceTable();
  const notice = { ...listNotice('inst-a', ['session-a']), payload: { originMsgId: 'origin-1' } };
  const rejected = applyList(table, notice, NOW, {
    peerInstanceId: 'inst-r',
    mode: 'managed',
    relayPeerInstanceId: 'inst-r',
    currentRelayPeerInstanceId: 'inst-r',
  });
  assert.equal(rejected.refreshed.length, 0);
  assert.equal(rejected.reason, 'relay-rejected');
  const oldRelay = applyList(table, notice, NOW, {
    peerInstanceId: 'inst-old',
    mode: 'forum',
    relayPeerInstanceId: 'inst-old',
    currentRelayPeerInstanceId: 'inst-r',
  });
  assert.equal(oldRelay.reason, 'relay-rejected');
  assert.equal(table.size, 0);
  const wrongPeer = applyList(table, notice, NOW, {
    peerInstanceId: 'inst-other',
    mode: 'forum',
    relayPeerInstanceId: 'inst-r',
    currentRelayPeerInstanceId: 'inst-r',
  });
  assert.equal(wrongPeer.reason, 'peer-mismatch');
  const currentRelay = applyList(table, notice, NOW, {
    peerInstanceId: 'inst-r',
    mode: 'forum',
    relayPeerInstanceId: 'inst-r',
    currentRelayPeerInstanceId: 'inst-r',
  });
  assert.deepEqual(currentRelay.refreshed, [{ instanceId: 'inst-a', sessionId: 'session-a' }]);
  assert.equal(presenceOf(table, 'inst-a', 'session-a').lastSeenAt, NOW);
});

test('applyDirectFrame：直连来源刷新，payload / 顶层 originMsgId 的转达帧不刷新', () => {
  const table = createPresenceTable();
  const direct = { collabId: COLLAB, from: { instanceId: 'inst-a', sessionId: 'session-a' }, at: NOW };
  assert.equal(applyDirect(table, direct, NOW).refreshed, true);
  assert.equal(presenceOf(table, 'inst-a', 'session-a').lastSeenAt, NOW);
  const later = NOW + 5000;
  const payloadRelay = {
    collabId: COLLAB,
    from: { instanceId: 'inst-a', sessionId: 'session-a' },
    at: later,
    payload: { originMsgId: 'msg-origin-1' },
  };
  assert.equal(applyDirect(table, payloadRelay, later).reason, 'relayed');
  const topRelay = { ...payloadRelay, payload: {}, originMsgId: 'msg-origin-2' };
  assert.equal(applyDirect(table, topRelay, later).reason, 'relayed');
  assert.equal(presenceOf(table, 'inst-a', 'session-a').lastSeenAt, NOW);
  assert.equal(applyDirect(table, {
    collabId: COLLAB,
    from: { instanceId: 'inst-b', sessionId: 'session-b' },
  }, later).refreshed, true);
});

test('applyDirectFrame：传输对端不等于 from.instanceId 或缺 peer → 拒绝', () => {
  const table = createPresenceTable();
  const frame = { collabId: COLLAB, from: { instanceId: 'inst-a', sessionId: 'session-a' }, at: NOW };
  assert.equal(applyDirectFrame(table, frame, NOW).reason, 'peer-missing');
  assert.equal(applyDirect(table, frame, NOW, { peerInstanceId: 'inst-b' }).reason, 'peer-mismatch');
  assert.equal(table.size, 0);
});

test('applyDirectFrame：lastSeenAt 只用本地接收时刻，远端未来时间不延长超时', () => {
  const table = createPresenceTable();
  const frame = {
    collabId: COLLAB,
    from: { instanceId: 'inst-a', sessionId: 'session-a' },
    at: NOW + 1e12,
  };
  applyDirect(table, frame, NOW);
  const entry = presenceOf(table, 'inst-a', 'session-a');
  assert.equal(entry.lastSeenAt, NOW);
  assert.equal(entry.reportedAt, NOW + 1e12);
  assert.equal(isReachable(table, { collabId: COLLAB, instanceId: 'inst-a', sessionId: 'session-a' }, {
    now: NOW + TIMEOUT,
    timeoutMs: TIMEOUT,
    hasEndpoint: true,
  }), false);
});

test('applyDirectFrame：不清除 unlisted，列表重新包含才恢复', () => {
  const table = createPresenceTable();
  applyList(table, listNotice('inst-a', ['session-a', 'session-a2']), NOW);
  applyList(table, listNotice('inst-a', ['session-a']), NOW + 1000);
  assert.equal(presenceOf(table, 'inst-a', 'session-a2').unlisted, true);
  applyDirect(table, { collabId: COLLAB, from: { instanceId: 'inst-a', sessionId: 'session-a2' } }, NOW + 2000);
  assert.equal(presenceOf(table, 'inst-a', 'session-a2').unlisted, true);
  assert.equal(isReachable(table, { collabId: COLLAB, instanceId: 'inst-a', sessionId: 'session-a2' }, {
    now: NOW + 2000,
    timeoutMs: TIMEOUT,
    hasEndpoint: true,
  }), false);
  applyList(table, listNotice('inst-a', ['session-a', 'session-a2']), NOW + 3000);
  assert.equal(presenceOf(table, 'inst-a', 'session-a2').unlisted, false);
});

test('applyDirectFrame：非法来源不写入、不抛异常', () => {
  const table = createPresenceTable();
  assert.doesNotThrow(() => applyDirect(table, null, NOW));
  assert.equal(applyDirect(table, null, NOW).refreshed, false);
  assert.equal(applyDirect(table, { collabId: COLLAB, from: null }, NOW).refreshed, false);
  assert.equal(table.size, 0);
});

test('expireSeats：超时项保留为 tombstone 且只返回一次，刷新后恢复', () => {
  const table = createPresenceTable();
  applyList(table, listNotice('inst-a', ['session-a']), NOW);
  applyList(table, listNotice('inst-b', ['session-b']), NOW + 1000);
  assert.deepEqual(expireSeats(table, NOW + TIMEOUT - 1, TIMEOUT), []);
  assert.deepEqual(expireSeats(table, NOW + TIMEOUT), [], '缺 timeout 不判离');
  assert.equal(presenceOf(table, 'inst-a', 'session-a').expired, false);
  const expired = expireSeats(table, NOW + TIMEOUT, TIMEOUT);
  assert.deepEqual(expired.map((entry) => entry.sessionId), ['session-a']);
  assert.equal(presenceOf(table, 'inst-a', 'session-a').expired, true);
  assert.deepEqual(expireSeats(table, NOW + TIMEOUT + 1, TIMEOUT), []);
  assert.equal(isReachable(table, { collabId: COLLAB, instanceId: 'inst-a', sessionId: 'session-a' }, {
    now: NOW + TIMEOUT + 1,
    timeoutMs: TIMEOUT,
    hasEndpoint: true,
  }), false);
  applyList(table, listNotice('inst-a', ['session-a']), NOW + TIMEOUT + 2);
  assert.equal(presenceOf(table, 'inst-a', 'session-a').expired, false);
});

test('isReachable：端点/超时证据缺失按不可达，unlisted/expired/超时为不可达', () => {
  const table = createPresenceTable();
  const absent = { collabId: COLLAB, instanceId: 'inst-a', sessionId: 'session-a' };
  assert.equal(isReachable(table, absent, { now: NOW, timeoutMs: TIMEOUT, hasEndpoint: true }), true);
  assert.equal(isReachable(table, absent, { now: NOW, timeoutMs: TIMEOUT, hasEndpoint: false }), false);
  assert.equal(isReachable(table, absent, { now: NOW, timeoutMs: TIMEOUT }), false);
  assert.equal(isReachable(table, absent, { now: NOW, hasEndpoint: true }), false);
  assert.equal(isReachable(table, absent, { now: NOW, timeoutMs: TIMEOUT, hasEndpoint: true, departed: true }), false);
  applyList(table, listNotice('inst-a', ['session-a']), NOW);
  assert.equal(isReachable(table, absent, { now: NOW + 1000, timeoutMs: TIMEOUT, hasEndpoint: true }), true);
  assert.equal(isReachable(table, absent, { now: NOW + TIMEOUT, timeoutMs: TIMEOUT, hasEndpoint: true }), false);
  applyList(table, listNotice('inst-a', ['session-other']), NOW + 2000);
  assert.equal(isReachable(table, absent, { now: NOW + 2000, timeoutMs: TIMEOUT, hasEndpoint: true }), false);
});

test('autoSuccessorCandidates：按 joinSeq/sessionId 排序，排除旧站长、manager 角色与不可达', () => {
  const table = createPresenceTable();
  applyList(table, listNotice('inst-a', ['session-a', 'session-c', 'session-u']), NOW);
  applyList(table, listNotice('inst-a', ['session-a', 'session-c']), NOW + 1000);
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

test('autoSuccessorCandidates：departed、超时与缺失端点过滤；空名单/缺 collabId 返回空', () => {
  const table = createPresenceTable();
  applyList(table, listNotice('inst-a', ['session-stale']), NOW);
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
    hasEndpoint: true,
    departed: (value) => value.sessionId === 'session-departed',
  });
  assert.deepEqual(candidates.map((value) => value.sessionId), ['session-ok']);
  const noEndpoint = autoSuccessorCandidates(table, seats, {
    collabId: COLLAB,
    now: NOW,
    timeoutMs: TIMEOUT,
    hasEndpoint: false,
  });
  assert.deepEqual(noEndpoint, []);
  assert.deepEqual(autoSuccessorCandidates(table, [], { collabId: COLLAB, now: NOW }), []);
  assert.deepEqual(autoSuccessorCandidates(table, null, { collabId: COLLAB, now: NOW }), []);
  assert.deepEqual(autoSuccessorCandidates(table, [seat('inst-a', 'session-a', 1)], { now: NOW }), []);
});
