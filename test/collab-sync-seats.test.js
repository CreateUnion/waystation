import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDir } from './helpers.js';
import { createMembersStore } from '../src/collab/members.js';
import { activateForumIfNeeded, ownJoinEventOf, settleJoinConvergence } from '../src/collab/sync.js';

/* join 收敛判定的席位口径（设计 §2.2/§4.5/§5.1）：讨论的成员是会话——「对端表里有没有我」必须
 * 按 (instanceId, sessionId) 判定。同机另一会话的 join 既不能顶替本会话的确认，也不能被当成
 * 本会话的事件重播（否则 A 的 join 由 B 署名重发，对端把两个会话的历史记串）。
 * 旧事件（0.1.x，无 sessionId）退回实例口径——既有档案仍可读，但不越过席位行。 */

const COLLAB_ID = 'collab-seats';
const SELF = { instanceId: 'inst-self', identityName: '本机', port: 17321 };
const PEER = { instanceId: 'inst-peer', identityName: '对端', port: 17322 };
const SESS_A = 'sess-a';
const SESS_B = 'sess-b';

function quietLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

/* 成员事件形态与线上一致：sessionId 只在真的有会话标识时携带（旧事件缺席位键）。 */
function eventOf(kind, { eventId, instanceId = SELF.instanceId, sessionId, ts }) {
  const event = { eventId, kind, instanceId, identityName: '本机', ts };
  if (typeof sessionId === 'string') {
    event.sessionId = sessionId;
  }
  return event;
}

function makeLocal(t, { events = [], seats = [] } = {}) {
  const dir = makeTempDir(t);
  const members = createMembersStore({ dataDir: dir, collabId: COLLAB_ID, log: quietLog() });
  for (const event of events) {
    members.apply(event);
  }
  return {
    collabId: COLLAB_ID,
    role: 'member',
    ledger: null,
    member: { mode: 'forum', state: 'active', name: '席位讨论' },
    members,
    endpoints: new Map([[PEER.instanceId, { address: '127.0.0.1', port: PEER.port }]]),
    seats: new Map(seats.map((seat) => [seat.sessionId, { role: 'member', state: 'member', muted: false, unverified: false, ...seat }])),
  };
}

/* 服务状态的最小面：重播走真实 startJoinReplay（outgoing.js），只把发送与计数接到夹具上。
 * 重播间隔置空 = 每一轮只发一次、不留定时器（断言的是「重播了谁」，不是节律）。 */
function makeState({ dataDir = null } = {}) {
  const sent = [];
  const state = {
    self: { ...SELF },
    dataDir,
    collabs: new Map(),
    joinReplays: new Map(),
    joinReplayIntervalsMs: [],
    counters: {},
    log: quietLog(),
    send: (message) => {
      sent.push(message);
      return { ok: true, msgId: `q-${sent.length}` };
    },
  };
  return { state, sent };
}

/* 同机双会话：A 先加入、B 后加入（B 的 join 是实例内最新事件——旧判定正是据此刻顶替 A）。 */
function dualSeatEvents() {
  return [
    eventOf('join', { eventId: 'a-join', sessionId: SESS_A, ts: '2026-10-21T00:00:00.000Z' }),
    eventOf('join', { eventId: 'b-join', sessionId: SESS_B, ts: '2026-10-21T00:00:01.000Z' }),
  ];
}

test('ownJoinEventOf：同实例另一会话的 join 不算本会话的 join', (t) => {
  const local = makeLocal(t, { events: dualSeatEvents(), seats: [{ sessionId: SESS_A, joinSeq: 1 }, { sessionId: SESS_B, joinSeq: 2 }] });
  assert.equal(ownJoinEventOf(local, SELF.instanceId, SESS_A)?.eventId, 'a-join', 'A 的 join 事件按席位取到（不是 B 的）');
  assert.equal(ownJoinEventOf(local, SELF.instanceId, SESS_B)?.eventId, 'b-join', 'B 的 join 事件按席位取到');
});

test('ownJoinEventOf：旧事件无 sessionId 时按实例兜底（既有档案可读）', (t) => {
  const local = makeLocal(t, {
    events: [eventOf('join', { eventId: 'legacy-join', ts: '2026-10-13T00:00:00.000Z' })],
  });
  assert.equal(ownJoinEventOf(local, SELF.instanceId, SESS_A)?.eventId, 'legacy-join', '本会话没有席位级事件 → 退回实例级旧事件');
});

test('收敛证据按席位：对端表只有同实例 B 的 join，不使 A 收敛', (t) => {
  const local = makeLocal(t, { events: dualSeatEvents(), seats: [{ sessionId: SESS_A, joinSeq: 1 }, { sessionId: SESS_B, joinSeq: 2 }] });
  const { state, sent } = makeState();
  const peerMembers = [eventOf('join', { eventId: 'b-join', sessionId: SESS_B, ts: '2026-10-21T00:00:01.000Z' })];
  settleJoinConvergence(state, local, { members: peerMembers });
  assert.equal(sent.length, 1, '对端未确认本会话 → 重播（B 的 join 不是 A 的确认证据）');
  assert.equal(sent[0].payload.eventId, 'a-join', '重播的是 A 自己的事件');
  assert.equal(sent[0].fromSessionId, SESS_A, '重播由事件作者会话署名（不由 B 代签）');
  assert.equal(local.joinConfirmed, false, '未收敛的确认位如实为假');
});

test('收敛证据按席位：对端表含 A 自己的 join → 收敛且停止重播', (t) => {
  const local = makeLocal(t, { events: dualSeatEvents(), seats: [{ sessionId: SESS_A, joinSeq: 1 }, { sessionId: SESS_B, joinSeq: 2 }] });
  const { state, sent } = makeState();
  const peerMembers = [
    eventOf('join', { eventId: 'a-join', sessionId: SESS_A, ts: '2026-10-21T00:00:00.000Z' }),
    eventOf('join', { eventId: 'b-join', sessionId: SESS_B, ts: '2026-10-21T00:00:01.000Z' }),
  ];
  settleJoinConvergence(state, local, { members: peerMembers });
  assert.equal(sent.length, 0, '两个会话都被对端确认 → 不重播');
  assert.equal(local.joinConfirmed, true, '确认位成立');
});

test('旧实例行不顶替席位行：对端已有本机席位行时，无 sessionId 的旧行不算 A 的确认', (t) => {
  const local = makeLocal(t, { events: dualSeatEvents(), seats: [{ sessionId: SESS_A, joinSeq: 1 }, { sessionId: SESS_B, joinSeq: 2 }] });
  const { state, sent } = makeState();
  const peerMembers = [
    eventOf('join', { eventId: 'legacy-join', ts: '2026-10-13T00:00:00.000Z' }),
    eventOf('join', { eventId: 'b-join', sessionId: SESS_B, ts: '2026-10-21T00:00:01.000Z' }),
  ];
  settleJoinConvergence(state, local, { members: peerMembers });
  assert.equal(sent.length, 1, '对端按席位折叠时，旧实例行不能把 A 判成已确认');
  assert.equal(sent[0].payload.eventId, 'a-join');
  assert.equal(sent[0].fromSessionId, SESS_A);
});

test('旧事件兜底：对端只有实例级旧行、本机只有旧事件 → 按实例收敛', (t) => {
  const local = makeLocal(t, {
    events: [eventOf('join', { eventId: 'legacy-join', ts: '2026-10-13T00:00:00.000Z' })],
  });
  const { state, sent } = makeState();
  settleJoinConvergence(state, local, { members: [eventOf('join', { eventId: 'legacy-join', ts: '2026-10-13T00:00:00.000Z' })] });
  assert.equal(sent.length, 0, '旧档案（整表按实例折叠）仍能确认');
  assert.equal(local.joinConfirmed, true);
});

test('一个会话离席不吞掉另一会话的重播：A 离席后重播的是 B 自己的事件', (t) => {
  const local = makeLocal(t, {
    events: [
      eventOf('join', { eventId: 'a-join', sessionId: SESS_A, ts: '2026-10-21T00:00:00.000Z' }),
      eventOf('join', { eventId: 'b-join', sessionId: SESS_B, ts: '2026-10-21T00:00:01.000Z' }),
      eventOf('leave', { eventId: 'a-leave', sessionId: SESS_A, ts: '2026-10-21T00:00:02.000Z' }),
    ],
    seats: [{ sessionId: SESS_A, joinSeq: 1 }, { sessionId: SESS_B, joinSeq: 2 }],
  });
  const { state, sent } = makeState();
  settleJoinConvergence(state, local, { members: [] });
  assert.equal(sent.length, 1, 'B 仍未确认 → 重播');
  assert.equal(sent[0].payload.eventId, 'b-join', '重播的只能是 B 的 join（A 已离席）');
  assert.equal(sent[0].fromSessionId, SESS_B, '重播署名 B 的席位');
});

/* —— 讨论成立边沿（proposed→active）的席位口径 —— */

/* 发起人侧（管理核）的最小面：台账 + 成员事件 + 席位表。mutateLedger 的停写判据读
 * local.suspended（null = 未挂起）；台账/成员落盘经 state.dataDir（失败只计数，不影响判定）。 */
function makeManagerLocal(t, { events = [], seats = [] } = {}) {
  const dir = makeTempDir(t);
  const members = createMembersStore({ dataDir: dir, collabId: COLLAB_ID, log: quietLog() });
  for (const event of events) {
    members.apply(event);
  }
  return {
    collabId: COLLAB_ID,
    role: 'manager',
    ledger: { mode: 'forum', status: 'proposed', version: 0, name: '席位讨论', topic: '议题', createdAt: '2026-10-21T00:00:00.000Z', members: [] },
    suspended: null,
    member: { mode: 'forum', state: 'active', name: '席位讨论' },
    members,
    endpoints: new Map(),
    seats: new Map(seats.map((seat) => [seat.sessionId, { state: 'member', muted: false, unverified: false, ...seat }])),
  };
}

test('讨论成立：同机第二会话入席即成立（发起人自己席位之外算他人加入）', (t) => {
  const local = makeManagerLocal(t, {
    events: [
      eventOf('join', { eventId: 'a-join', sessionId: SESS_A, ts: '2026-10-21T00:00:00.000Z' }),
      eventOf('join', { eventId: 'b-join', sessionId: SESS_B, ts: '2026-10-21T00:00:05.000Z' }),
    ],
    seats: [{ sessionId: SESS_A, role: 'manager', joinSeq: 1 }, { sessionId: SESS_B, role: 'member', joinSeq: 2 }],
  });
  const { state } = makeState({ dataDir: makeTempDir(t) });
  assert.equal(activateForumIfNeeded(state, local), true, '同机会话 B 入席 → 讨论成立');
  assert.equal(local.ledger.status, 'active');
  assert.equal(local.ledger.establishedAt, '2026-10-21T00:00:05.000Z', '成立时刻取他方（B）join 的 ts');
});

test('讨论成立：发起人自己的重复 join 事件不激活', (t) => {
  const local = makeManagerLocal(t, {
    events: [
      eventOf('join', { eventId: 'a-join-1', sessionId: SESS_A, ts: '2026-10-21T00:00:00.000Z' }),
      eventOf('join', { eventId: 'a-join-2', sessionId: SESS_A, ts: '2026-10-21T00:00:03.000Z' }),
    ],
    seats: [{ sessionId: SESS_A, role: 'manager', joinSeq: 1 }],
  });
  const { state } = makeState({ dataDir: makeTempDir(t) });
  assert.equal(activateForumIfNeeded(state, local), false, '同一席位的事件重放不构成「首个加入者」');
  assert.equal(local.ledger.status, 'proposed');
});

test('讨论成立：远端席位入席仍激活（排除面只针对发起人自己的席位）', (t) => {
  const local = makeManagerLocal(t, {
    events: [
      eventOf('join', { eventId: 'a-join', sessionId: SESS_A, ts: '2026-10-21T00:00:00.000Z' }),
      eventOf('join', { eventId: 'p-join', instanceId: PEER.instanceId, sessionId: 'sess-p', ts: '2026-10-21T00:00:07.000Z' }),
    ],
    seats: [{ sessionId: SESS_A, role: 'manager', joinSeq: 1 }],
  });
  const { state } = makeState({ dataDir: makeTempDir(t) });
  assert.equal(activateForumIfNeeded(state, local), true);
  assert.equal(local.ledger.establishedAt, '2026-10-21T00:00:07.000Z');
});

test('讨论成立：旧档案（事件无 sessionId）按实例兜底', (t) => {
  const legacySelf = eventOf('join', { eventId: 'legacy-self', ts: '2026-10-13T00:00:00.000Z' });
  const legacyPeer = eventOf('join', { eventId: 'legacy-peer', instanceId: PEER.instanceId, ts: '2026-10-13T00:00:09.000Z' });
  const onlySelf = makeManagerLocal(t, { events: [legacySelf] });
  const selfState = makeState({ dataDir: makeTempDir(t) });
  assert.equal(activateForumIfNeeded(selfState.state, onlySelf), false, '只有本机旧事件：不成立（整机即发起人）');
  const withPeer = makeManagerLocal(t, { events: [legacySelf, legacyPeer] });
  const peerState = makeState({ dataDir: makeTempDir(t) });
  assert.equal(activateForumIfNeeded(peerState.state, withPeer), true, '远端旧事件按实例算他方加入');
  assert.equal(withPeer.ledger.establishedAt, '2026-10-13T00:00:09.000Z');
});
