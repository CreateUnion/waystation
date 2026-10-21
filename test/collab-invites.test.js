import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  JOINING_TTL_MS,
  JOIN_DENY_REASONS,
  PENDING_INVITE_CAPACITY,
  createInvitesBook,
  createJoiningRegistry,
  createPendingInvites,
  joinDenyReasonOf,
} from '../src/collab/invites.js';
import { PROTOCOL_VERSION, validateMessage } from '../src/net/protocol.js';

/* 邀请与两段式入席的纯逻辑面：发起侧邀请簿记、目标机挂起邀请、站长的 joining 准入台账。
 * 全部为内存态（不写盘、不发帧），时间经注入时钟推进，故 TTL / 过期 / 容量淘汰都可确定复现。
 * 恢复面分别用 list() 快照与设计形态的 joins.json 记录喂回新实例，验证重启后判定等价。 */

const NOW = 1_000_000;
const COLLAB = 'collab-1';

function clockFrom(start = NOW) {
  const ref = { value: start };
  return { ref, now: () => ref.value, set: (value) => { ref.value = value; } };
}

function bookAt(start = NOW) {
  const clock = clockFrom(start);
  return { clock, book: createInvitesBook({ now: clock.now }) };
}

function pendingAt(start = NOW, options = {}) {
  const clock = clockFrom(start);
  return { clock, pending: createPendingInvites({ now: clock.now, ...options }) };
}

function joiningAt(start = NOW, options = {}) {
  const clock = clockFrom(start);
  return { clock, joining: createJoiningRegistry({ now: clock.now, joiningTtlMs: 1000, ...options }) };
}

function pendingRecord(overrides = {}) {
  return {
    inviteId: 'inv-1',
    collabId: COLLAB,
    fromManager: { instanceId: 'inst-m', sessionId: 'session-m1' },
    expiresAt: NOW + 1000,
    ...overrides,
  };
}

function joinInput(overrides = {}) {
  return {
    collabId: COLLAB,
    instanceId: 'inst-a',
    sessionId: 'session-a1',
    managerTerm: 1,
    grantVersion: 1,
    activeSeats: 0,
    ...overrides,
  };
}

/* confirm 的必填参数从记录派生（managerTerm/instanceId），避免用例把缺省值正例化。 */
function confirmArgs(joining, joinId, overrides = {}) {
  const record = joining.get(joinId);
  return {
    instanceId: record === null ? 'inst-a' : record.instanceId,
    managerTerm: record === null ? 1 : record.managerTerm,
    activeSeats: 0,
    ...overrides,
  };
}

function pendingGet(pending, inviteId, collabId = COLLAB) {
  return pending.get({ collabId, inviteId });
}

function consume(pending, inviteId, sessionId, overrides = {}) {
  return pending.consumeForSession({ collabId: COLLAB, inviteId, sessionId, ...overrides });
}

function withdraw(pending, inviteId, collabId = COLLAB) {
  return pending.withdrawPending({ collabId, inviteId });
}

function matchFor(pending, sessionId, overrides = {}) {
  return pending.matchPendingForSession({ collabId: COLLAB, sessionId, ...overrides });
}

const A = { instanceId: 'inst-a', sessionId: 'session-a1' };
const B = { instanceId: 'inst-a', sessionId: 'session-b2' };

/* —— 发起侧邀请簿记 —— */

test('openInvite：生成 open 记录，目标/时刻/TTL 落账，非法参数拒绝', () => {
  const { book } = bookAt();
  const opened = book.openInvite({ targetInstanceId: 'inst-a', ttl: 1000 });
  assert.equal(opened.ok, true);
  assert.match(opened.inviteId, /^inv-/);
  assert.equal(opened.expiresAt, NOW + 1000);
  const [record] = book.list();
  assert.deepEqual(record.targets, [{ instanceId: 'inst-a' }]);
  assert.deepEqual([record.createdAt, record.state, record.acceptedSessions], [NOW, 'open', []]);
  assert.equal('declinedSessions' in record, false, '拒绝记录只进内存，不进 invites 形态');
  const named = book.openInvite({ targetInstanceId: 'inst-a', targetSessionId: 'session-a1', ttl: 50 });
  assert.deepEqual(book.get(named.inviteId).targets, [{ instanceId: 'inst-a', targetSessionId: 'session-a1' }]);
  for (const bad of [
    {},
    { targetInstanceId: 'bad id', ttl: 1000 },
    { targetInstanceId: 'inst-a', ttl: 0 },
    { targetInstanceId: 'inst-a', ttl: '1000' },
    { targetInstanceId: 'inst-a', targetSessionId: 'x/y', ttl: 1000 },
  ]) {
    assert.equal(book.openInvite(bad).ok, false);
  }
  assert.equal(book.list().length, 2);
});

test('matchInvite：指名邀请只认目标机器与目标会话，过期/未知拒绝', () => {
  const { clock, book } = bookAt();
  const { inviteId } = book.openInvite({ targetInstanceId: 'inst-a', targetSessionId: 'session-a1', ttl: 1000 });
  assert.equal(book.matchInvite(inviteId, A).ok, true);
  assert.equal(book.matchInvite(inviteId, B).reason, 'session-mismatch');
  assert.equal(book.matchInvite(inviteId, { instanceId: 'inst-b', sessionId: 'session-a1' }).reason, 'target-mismatch');
  assert.equal(book.matchInvite('inv-nope', A).reason, 'unknown');
  clock.set(NOW + 1000);
  assert.equal(book.matchInvite(inviteId, A).reason, 'expired');
});

test('matchInvite：已接受/已拒绝的会话不可再匹配，他人不受影响', () => {
  const { book } = bookAt();
  const unnamed = book.openInvite({ targetInstanceId: 'inst-a', ttl: 1000 });
  assert.equal(book.acceptInvite(unnamed.inviteId, A).ok, true);
  assert.equal(book.matchInvite(unnamed.inviteId, A).reason, 'already-accepted');
  assert.equal(book.matchInvite(unnamed.inviteId, B).ok, true);
  const named = book.openInvite({ targetInstanceId: 'inst-a', targetSessionId: 'session-a1', ttl: 1000 });
  assert.equal(book.declineInvite(named.inviteId, A).ok, true);
  assert.equal(book.matchInvite(named.inviteId, A).reason, 'already-declined');
  assert.equal(book.matchInvite(named.inviteId, B).reason, 'session-mismatch');
});

test('acceptInvite：不指名邀请每会话独立成席，同会话重复接受幂等', () => {
  const { book } = bookAt();
  const { inviteId } = book.openInvite({ targetInstanceId: 'inst-a', ttl: 1000 });
  assert.equal(book.acceptInvite(inviteId, A).ok, true);
  assert.equal(book.acceptInvite(inviteId, B).ok, true);
  const record = book.get(inviteId);
  assert.deepEqual([record.state, record.acceptedSessions], ['open', [A, B]]);
  const repeat = book.acceptInvite(inviteId, A);
  assert.deepEqual([repeat.ok, repeat.idempotent, book.get(inviteId).acceptedSessions.length], [true, true, 2]);
  assert.equal(book.matchInvite(inviteId, { instanceId: 'inst-a', sessionId: 'session-c3' }).ok, true);
});

test('acceptInvite：指名邀请只有目标会话可接受，接受后整条关闭', () => {
  const { book } = bookAt();
  const { inviteId } = book.openInvite({ targetInstanceId: 'inst-a', targetSessionId: 'session-a1', ttl: 1000 });
  assert.equal(book.acceptInvite(inviteId, B).reason, 'session-mismatch');
  const accepted = book.acceptInvite(inviteId, A);
  assert.deepEqual([accepted.ok, book.get(inviteId).state], [true, 'closed']);
  assert.deepEqual([book.acceptInvite(inviteId, A).idempotent, book.acceptInvite(inviteId, B).reason], [true, 'session-mismatch']);
  assert.equal(book.acceptInvite(inviteId, { instanceId: 'inst-b', sessionId: 'session-a1' }).reason, 'target-mismatch');
});

test('declineInvite：只影响本会话，不指名邀请仍可被他人接受', () => {
  const { book } = bookAt();
  const { inviteId } = book.openInvite({ targetInstanceId: 'inst-a', ttl: 1000 });
  assert.equal(book.declineInvite(inviteId, A).ok, true);
  assert.equal(book.get(inviteId).state, 'open');
  assert.equal(book.matchInvite(inviteId, A).reason, 'already-declined');
  assert.equal(book.matchInvite(inviteId, B).ok, true);
  assert.equal(book.acceptInvite(inviteId, A).reason, 'already-declined');
  assert.equal(book.acceptInvite(inviteId, B).ok, true);
  assert.equal(book.declineInvite(inviteId, A).idempotent, true);
  const named = book.openInvite({ targetInstanceId: 'inst-a', targetSessionId: 'session-a1', ttl: 1000 });
  book.declineInvite(named.inviteId, A);
  assert.equal(book.get(named.inviteId).state, 'closed');
  assert.equal(book.acceptInvite(named.inviteId, A).reason, 'already-declined');
});

test('withdrawInvite：撤回后不可接受，重复撤回幂等，已关闭不可撤回', () => {
  const { book } = bookAt();
  const { inviteId } = book.openInvite({ targetInstanceId: 'inst-a', ttl: 1000 });
  assert.equal(book.withdrawInvite(inviteId).ok, true);
  assert.equal(book.get(inviteId).state, 'withdrawn');
  assert.equal(book.matchInvite(inviteId, A).reason, 'withdrawn');
  assert.equal(book.acceptInvite(inviteId, A).reason, 'withdrawn');
  assert.equal(book.withdrawInvite(inviteId).idempotent, true);
  assert.equal(book.withdrawInvite('inv-nope').reason, 'unknown');
  const named = book.openInvite({ targetInstanceId: 'inst-a', targetSessionId: 'session-a1', ttl: 1000 });
  book.acceptInvite(named.inviteId, A);
  assert.equal(book.withdrawInvite(named.inviteId).reason, 'closed');
});

test('expireInvites：清除到期记录，未到期保留', () => {
  const { clock, book } = bookAt();
  const short = book.openInvite({ targetInstanceId: 'inst-a', ttl: 100 });
  const long = book.openInvite({ targetInstanceId: 'inst-a', ttl: 10_000 });
  clock.set(NOW + 100);
  assert.deepEqual(book.expireInvites(), { expired: 1, inviteIds: [short.inviteId] });
  assert.deepEqual(book.list().map((record) => record.inviteId), [long.inviteId]);
  assert.equal(book.matchInvite(short.inviteId, A).reason, 'unknown');
  assert.equal(book.matchInvite(long.inviteId, A).ok, true);
});

test('邀请操作失败不落账（失败回滚）', () => {
  const { clock, book } = bookAt();
  const { inviteId } = book.openInvite({ targetInstanceId: 'inst-a', targetSessionId: 'session-a1', ttl: 1000 });
  assert.equal(book.acceptInvite(inviteId, B).reason, 'session-mismatch');
  assert.deepEqual(book.get(inviteId).acceptedSessions, []);
  clock.set(NOW + 1000);
  assert.equal(book.acceptInvite(inviteId, A).reason, 'expired');
  assert.deepEqual([book.get(inviteId).state, book.get(inviteId).acceptedSessions], ['open', []]);
});

test('邀请簿记恢复：open/closed 与已接受席位跨重启等价', () => {
  const { book } = bookAt();
  const unnamed = book.openInvite({ targetInstanceId: 'inst-a', ttl: 10_000 });
  book.acceptInvite(unnamed.inviteId, A);
  const named = book.openInvite({ targetInstanceId: 'inst-a', targetSessionId: 'session-a1', ttl: 10_000 });
  book.acceptInvite(named.inviteId, A);
  const snapshot = book.list();
  const reloaded = createInvitesBook({ now: () => NOW });
  assert.deepEqual(reloaded.restore(snapshot), { ok: true, restored: 2, rejected: 0 });
  assert.deepEqual(reloaded.list(), snapshot);
  assert.equal(reloaded.matchInvite(unnamed.inviteId, B).ok, true);
  assert.equal(reloaded.matchInvite(unnamed.inviteId, A).reason, 'already-accepted');
  assert.equal(reloaded.matchInvite(named.inviteId, A).reason, 'already-accepted');
  assert.equal(reloaded.matchInvite('inv-nope', A).reason, 'unknown');
  assert.deepEqual(reloaded.restore([{ bad: true }]), { ok: true, restored: 0, rejected: 1 });
  assert.deepEqual(reloaded.list(), []);
});

test('join-deny reason：内部原因只映射到协议层同一词表', () => {
  const frameOf = (reason) => ({
    v: PROTOCOL_VERSION,
    cap: 2,
    type: 'join-deny',
    msgId: 'msg-1',
    from: { instanceId: 'inst-m', sessionId: 'session-m1', identityName: '站长', port: 17001 },
    collabId: COLLAB,
    ts: new Date(NOW).toISOString(),
    payload: { joinId: 'join-1', reason },
  });
  assert.deepEqual(JOIN_DENY_REASONS, ['expired', 'aborted', 'manager-changed', 'capacity']);
  for (const reason of JOIN_DENY_REASONS) {
    assert.equal(validateMessage(frameOf(reason)).ok, true, `协议层应接受 ${reason}`);
    assert.equal(joinDenyReasonOf(reason), reason);
  }
  assert.equal(validateMessage(frameOf('bogus')).ok, false, '协议层拒绝词表外原因');
  for (const reason of ['unknown', 'invalid', 'target-mismatch', 'session-mismatch', 'already-accepted', 'closed']) {
    assert.equal(joinDenyReasonOf(reason), 'aborted');
  }
});

/* —— 目标机挂起邀请 —— */

test('applyPendingInvite：登记形态与同键重复帧去重', () => {
  const { pending } = pendingAt();
  const applied = pending.applyPendingInvite(pendingRecord());
  assert.equal(applied.ok, true);
  assert.equal(applied.duplicate, false);
  assert.deepEqual(pending.list(), [{
    inviteId: 'inv-1',
    collabId: COLLAB,
    fromManager: { instanceId: 'inst-m', sessionId: 'session-m1' },
    targetSessionId: null,
    expiresAt: NOW + 1000,
    state: 'open',
    acceptedSessions: [],
  }]);
  const duplicate = pending.applyPendingInvite(pendingRecord({ expiresAt: NOW + 5000 }));
  assert.deepEqual([duplicate.duplicate, pending.list().length, pending.list()[0].expiresAt], [true, 1, NOW + 5000]);
  pending.applyPendingInvite(pendingRecord({ targetSessionId: 'session-a1' }));
  pending.applyPendingInvite(pendingRecord({ targetSessionId: 'session-b2' }));
  assert.equal(pending.list().length, 3);
  assert.equal(pending.stats().duplicates, 1);
});

test('applyPendingInvite：非法记录与已过期记录拒绝', () => {
  const { pending } = pendingAt();
  for (const bad of [
    {},
    pendingRecord({ inviteId: 'bad id' }),
    pendingRecord({ collabId: '' }),
    pendingRecord({ fromManager: {} }),
    pendingRecord({ fromManager: { instanceId: 'inst-m', sessionId: 'bad id' } }),
    pendingRecord({ targetSessionId: 'bad id' }),
    pendingRecord({ expiresAt: 'soon' }),
  ]) {
    assert.equal(pending.applyPendingInvite(bad).ok, false);
  }
  assert.equal(pending.applyPendingInvite(pendingRecord({ expiresAt: NOW })).reason, 'expired');
  assert.equal(pending.list().length, 0);
});

test('matchPendingForSession：指名精确、不指名对所有会话可见', () => {
  const { pending } = pendingAt();
  pending.applyPendingInvite(pendingRecord());
  pending.applyPendingInvite(pendingRecord({ inviteId: 'inv-2', targetSessionId: 'session-a1' }));
  pending.applyPendingInvite(pendingRecord({ inviteId: 'inv-3', targetSessionId: 'session-b2' }));
  const forA = matchFor(pending, 'session-a1');
  assert.deepEqual(forA.map((record) => record.inviteId).sort(), ['inv-1', 'inv-2']);
  const forB = matchFor(pending, 'session-b2');
  assert.deepEqual(forB.map((record) => record.inviteId).sort(), ['inv-1', 'inv-3']);
  assert.deepEqual(matchFor(pending, 'session-a1', { inviteId: 'inv-3' }), []);
  assert.deepEqual(matchFor(pending, 'session-a1', { collabId: 'collab-x' }), []);
  assert.deepEqual(matchFor(pending, 'bad id'), []);
  assert.deepEqual(pending.matchPendingForSession({ sessionId: 'session-a1' }), [], 'collabId 必填');
});

test('matchPendingForSession：已接受/已拒绝/已过期/已撤回不匹配', () => {
  const { clock, pending } = pendingAt();
  pending.applyPendingInvite(pendingRecord({ inviteId: 'inv-acc' }));
  pending.applyPendingInvite(pendingRecord({ inviteId: 'inv-dec' }));
  pending.applyPendingInvite(pendingRecord({ inviteId: 'inv-exp', expiresAt: NOW + 100 }));
  pending.applyPendingInvite(pendingRecord({ inviteId: 'inv-wd' }));
  consume(pending, 'inv-acc', 'session-a1');
  consume(pending, 'inv-dec', 'session-a1', { declined: true });
  withdraw(pending, 'inv-wd');
  clock.set(NOW + 100);
  assert.deepEqual(matchFor(pending, 'session-a1'), []);
  assert.deepEqual(matchFor(pending, 'session-b2').map((record) => record.inviteId).sort(),
    ['inv-acc', 'inv-dec']);
});

test('consumeForSession：不指名首 accept 不消费整条，指名邀请 accept 消费整条', () => {
  const { pending } = pendingAt();
  pending.applyPendingInvite(pendingRecord());
  const first = consume(pending, 'inv-1', 'session-a1');
  assert.deepEqual([first.ok, first.accepted, first.consumed], [true, true, false]);
  assert.deepEqual([pendingGet(pending, 'inv-1').state, pendingGet(pending, 'inv-1').acceptedSessions], ['open', ['session-a1']]);
  const second = consume(pending, 'inv-1', 'session-b2');
  assert.deepEqual([second.consumed, pendingGet(pending, 'inv-1').acceptedSessions.length], [false, 2]);
  const repeat = consume(pending, 'inv-1', 'session-a1');
  assert.deepEqual([repeat.ok, repeat.idempotent, pendingGet(pending, 'inv-1').acceptedSessions.length], [true, true, 2]);
  pending.applyPendingInvite(pendingRecord({ inviteId: 'inv-2', targetSessionId: 'session-a1' }));
  assert.equal(consume(pending, 'inv-2', 'session-b2').reason, 'target-mismatch');
  assert.deepEqual([consume(pending, 'inv-2', 'session-a1').consumed, pendingGet(pending, 'inv-2').state], [true, 'consumed']);
});

test('consumeForSession：指名 decline 消费整条，不指名 decline 只排除本会话', () => {
  const { pending } = pendingAt();
  pending.applyPendingInvite(pendingRecord());
  const declined = consume(pending, 'inv-1', 'session-a1', { declined: true });
  assert.deepEqual([declined.ok, declined.consumed, pendingGet(pending, 'inv-1').state], [true, false, 'open']);
  assert.deepEqual(matchFor(pending, 'session-a1'), []);
  assert.equal(matchFor(pending, 'session-b2').length, 1);
  pending.applyPendingInvite(pendingRecord({ inviteId: 'inv-2', targetSessionId: 'session-a1' }));
  assert.deepEqual([consume(pending, 'inv-2', 'session-a1', { declined: true }).consumed,
    pendingGet(pending, 'inv-2').state, pendingGet(pending, 'inv-2').acceptedSessions], [true, 'consumed', []]);
});

test('consumeForSession：反向决定拒绝，非法 declined 值拒绝', () => {
  const { pending } = pendingAt();
  pending.applyPendingInvite(pendingRecord({ inviteId: 'inv-acc' }));
  pending.applyPendingInvite(pendingRecord({ inviteId: 'inv-dec' }));
  consume(pending, 'inv-acc', 'session-a1');
  consume(pending, 'inv-dec', 'session-a1', { declined: true });
  assert.equal(consume(pending, 'inv-acc', 'session-a1', { declined: true }).reason, 'already-accepted');
  assert.equal(consume(pending, 'inv-dec', 'session-a1').reason, 'already-declined');
  assert.equal(consume(pending, 'inv-dec', 'session-b2', { declined: 'yes' }).reason, 'invalid');
  assert.equal(consume(pending, 'inv-dec', 'session-b2', { declined: 1 }).reason, 'invalid');
  assert.deepEqual(pendingGet(pending, 'inv-dec').acceptedSessions, []);
});

test('consumeForSession：过期优先于幂等返回', () => {
  const { clock, pending } = pendingAt();
  pending.applyPendingInvite(pendingRecord());
  consume(pending, 'inv-1', 'session-a1');
  clock.set(NOW + 1000);
  assert.equal(consume(pending, 'inv-1', 'session-a1').reason, 'expired');
  assert.equal(pendingGet(pending, 'inv-1').state, 'expired');
});

test('pending 协作限定：consume/withdraw/get 不串台', () => {
  const { pending } = pendingAt();
  pending.applyPendingInvite(pendingRecord({ collabId: 'collab-2' }));
  assert.equal(consume(pending, 'inv-1', 'session-a1').reason, 'collab-mismatch');
  assert.equal(withdraw(pending, 'inv-1').reason, 'collab-mismatch');
  assert.equal(pendingGet(pending, 'inv-1'), null);
  assert.equal(matchFor(pending, 'session-a1', { collabId: 'collab-2' }).length, 1);
  assert.equal(consume(pending, 'inv-1', 'session-a1', { collabId: 'collab-2' }).ok, true);
});

test('expirePending/withdrawPending/pruneTerminal：生命周期与清理', () => {
  const { clock, pending } = pendingAt();
  pending.applyPendingInvite(pendingRecord({ inviteId: 'inv-exp', expiresAt: NOW + 100 }));
  pending.applyPendingInvite(pendingRecord({ inviteId: 'inv-open' }));
  clock.set(NOW + 100);
  assert.deepEqual(pending.expirePending(), { expired: 1, inviteIds: ['inv-exp'] });
  assert.equal(pendingGet(pending, 'inv-exp').state, 'expired');
  assert.equal(consume(pending, 'inv-exp', 'session-a1').reason, 'expired');
  assert.deepEqual(withdraw(pending, 'inv-open'), { ok: true, withdrawn: 1 });
  assert.equal(pendingGet(pending, 'inv-open').state, 'withdrawn');
  assert.deepEqual(withdraw(pending, 'inv-nope'), { ok: true, withdrawn: 0 });
  assert.deepEqual(pending.pruneTerminal(), { pruned: 1, inviteIds: ['inv-exp'] });
  assert.equal(pendingGet(pending, 'inv-open').state, 'withdrawn', '未到期终态保留供观察');
  clock.set(NOW + 1000);
  assert.deepEqual(pending.pruneTerminal(), { pruned: 1, inviteIds: ['inv-open'] });
  assert.deepEqual(pending.list(), []);
  assert.equal(pending.stats().pruned, 2);
});

test('pending 容量：缺省 64，全部 open 时淘汰最早过期者并计数', () => {
  const { pending } = pendingAt();
  assert.equal(PENDING_INVITE_CAPACITY, 64);
  for (let index = 0; index < 64; index++) {
    pending.applyPendingInvite(pendingRecord({ inviteId: `inv-${index}`, expiresAt: NOW + 1000 + index }));
  }
  const applied = pending.applyPendingInvite(pendingRecord({ inviteId: 'inv-new', expiresAt: NOW + 10_000 }));
  assert.deepEqual([applied.ok, applied.evicted, applied.evictedState], [true, 'inv-0', 'open']);
  assert.equal(pending.list().length, 64);
  assert.equal(pendingGet(pending, 'inv-0'), null);
  assert.equal(pendingGet(pending, 'inv-new').state, 'open');
  assert.equal(pending.stats().dropped, 1);
  pending.applyPendingInvite(pendingRecord({ inviteId: 'inv-new', expiresAt: NOW + 20_000 }));
  assert.deepEqual([pending.list().length, pending.stats().dropped], [64, 1]);
});

test('pending 容量：先淘汰终态，不丢有效 open 邀请', () => {
  const { pending } = pendingAt(NOW, { capacity: 2 });
  pending.applyPendingInvite(pendingRecord({ inviteId: 'inv-dead', targetSessionId: 'session-a1', expiresAt: NOW + 9000 }));
  consume(pending, 'inv-dead', 'session-a1');
  pending.applyPendingInvite(pendingRecord({ inviteId: 'inv-live', expiresAt: NOW + 100 }));
  const applied = pending.applyPendingInvite(pendingRecord({ inviteId: 'inv-new', expiresAt: NOW + 5000 }));
  assert.deepEqual([applied.evicted, applied.evictedState], ['inv-dead', 'consumed']);
  assert.equal(pendingGet(pending, 'inv-live').state, 'open');
  assert.deepEqual([pending.stats().dropped, pending.stats().reclaimed], [0, 1]);
});

test('pending 消费失败不落账（失败回滚）', () => {
  const { clock, pending } = pendingAt();
  pending.applyPendingInvite(pendingRecord({ targetSessionId: 'session-a1' }));
  assert.equal(consume(pending, 'inv-1', 'session-b2').reason, 'target-mismatch');
  assert.deepEqual([pendingGet(pending, 'inv-1').state, pendingGet(pending, 'inv-1').acceptedSessions], ['open', []]);
  assert.equal(consume(pending, 'inv-nope', 'session-a1').reason, 'unknown');
  clock.set(NOW + 1000);
  assert.equal(consume(pending, 'inv-1', 'session-a1').reason, 'expired');
  assert.deepEqual([pendingGet(pending, 'inv-1').state, pendingGet(pending, 'inv-1').acceptedSessions], ['expired', []]);
});

test('pending 重放：consume/withdraw 后重复邀请帧不复活记录', () => {
  const { pending } = pendingAt();
  pending.applyPendingInvite(pendingRecord({ targetSessionId: 'session-a1' }));
  consume(pending, 'inv-1', 'session-a1');
  const replay = pending.applyPendingInvite(pendingRecord({ targetSessionId: 'session-a1' }));
  assert.deepEqual([replay.duplicate, pendingGet(pending, 'inv-1').state], [true, 'consumed']);
  pending.applyPendingInvite(pendingRecord({ inviteId: 'inv-2' }));
  withdraw(pending, 'inv-2');
  const withdrawnReplay = pending.applyPendingInvite(pendingRecord({ inviteId: 'inv-2' }));
  assert.deepEqual([withdrawnReplay.duplicate, pendingGet(pending, 'inv-2').state], [true, 'withdrawn']);
});

test('pending 恢复：终态与已接受会话跨重启保留', () => {
  const { clock, pending } = pendingAt();
  pending.applyPendingInvite(pendingRecord({ inviteId: 'inv-open' }));
  pending.applyPendingInvite(pendingRecord({ inviteId: 'inv-acc' }));
  pending.applyPendingInvite(pendingRecord({ inviteId: 'inv-exp', expiresAt: NOW + 100 }));
  consume(pending, 'inv-acc', 'session-a1');
  clock.set(NOW + 100);
  pending.expirePending();
  const snapshot = pending.list();
  const reloaded = createPendingInvites({ now: () => NOW + 100 });
  assert.deepEqual(reloaded.restore(snapshot), { ok: true, restored: 3, rejected: 0 });
  assert.deepEqual(reloaded.list(), snapshot);
  assert.deepEqual(pendingGet(reloaded, 'inv-acc').acceptedSessions, ['session-a1'], '已接受会话随记录恢复');
  assert.deepEqual(matchFor(reloaded, 'session-a1').map((record) => record.inviteId), ['inv-open']);
  assert.deepEqual(matchFor(reloaded, 'session-a2').map((record) => record.inviteId).sort(),
    ['inv-acc', 'inv-open'], '不指名邀请的其余席位仍可补投');
  assert.deepEqual(reloaded.restore([{ bad: true }]), { ok: true, restored: 0, rejected: 1 });
});

test('pending 恢复：超容量按终态优先/最早过期裁剪，重复键与坏字段拒收', () => {
  const source = pendingAt().pending;
  source.applyPendingInvite(pendingRecord({ inviteId: 'inv-a', expiresAt: NOW + 1000 }));
  source.applyPendingInvite(pendingRecord({ inviteId: 'inv-b', expiresAt: NOW + 100 }));
  source.applyPendingInvite(pendingRecord({ inviteId: 'inv-c', expiresAt: NOW + 5000 }));
  const records = source.list();
  records.push({ ...records[0] });
  const reloaded = createPendingInvites({ now: () => NOW, capacity: 2 });
  assert.deepEqual(reloaded.restore(records, { capacity: 2 }), { ok: true, restored: 2, rejected: 2 });
  assert.deepEqual(reloaded.list().map((record) => record.inviteId).sort(), ['inv-a', 'inv-c']);
  assert.deepEqual([reloaded.stats().dropped, reloaded.stats().reclaimed], [1, 0]);
  assert.deepEqual(reloaded.restore([records[0], { ...records[0] }], { capacity: 2 }), { ok: true, restored: 1, rejected: 1 });
  assert.equal(reloaded.restore([{ ...records[0], expiresAt: 'soon' }], { capacity: 2 }).rejected, 1);
});

test('pending 重放：expire 后重复邀请帧不复活记录', () => {
  const { clock, pending } = pendingAt();
  pending.applyPendingInvite(pendingRecord({ expiresAt: NOW + 100 }));
  clock.set(NOW + 100);
  pending.expirePending();
  const staleReplay = pending.applyPendingInvite(pendingRecord({ expiresAt: NOW + 100 }));
  assert.deepEqual([staleReplay.ok, staleReplay.reason], [false, 'expired']);
  const replay = pending.applyPendingInvite(pendingRecord({ expiresAt: NOW + 5000 }));
  assert.deepEqual([replay.duplicate, pendingGet(pending, 'inv-1').state], [true, 'expired'], '重放不把终态翻回 open');
  assert.deepEqual(matchFor(pending, 'session-a1'), []);
});

/* —— 两段式入席（joining） —— */

test('beginJoining：建立 joining 记录与 TTL，参数非法拒绝', () => {
  const { joining } = joiningAt();
  const begun = joining.beginJoining(joinInput());
  assert.equal(begun.ok, true);
  assert.match(begun.joinId, /^join-/);
  assert.equal(begun.expiresAt, NOW + 1000);
  assert.deepEqual(joining.get(begun.joinId), {
    joinId: begun.joinId,
    collabId: COLLAB,
    instanceId: 'inst-a',
    sessionId: 'session-a1',
    managerTerm: 1,
    grantVersion: 1,
    requestedAt: NOW,
    expiresAt: NOW + 1000,
    confirmed: false,
    confirmedAt: null,
  });
  const defaultTtl = createJoiningRegistry({ now: () => NOW }).beginJoining(joinInput({ sessionId: 'session-b2' }));
  assert.equal(defaultTtl.expiresAt, NOW + JOINING_TTL_MS);
  for (const bad of [
    {},
    joinInput({ collabId: 'bad id' }),
    joinInput({ managerTerm: 0 }),
    joinInput({ grantVersion: -1 }),
    joinInput({ activeSeats: -1 }),
    joinInput({ activeSeats: 1.5 }),
    joinInput({ activeSeats: undefined }),
  ]) {
    assert.equal(joining.beginJoining(bad).reason, 'invalid');
  }
  assert.equal(joining.list().length, 1);
});

test('beginJoining：同 (collabId,sessionId) 复用记录并换新 joinId', () => {
  const { joining } = joiningAt();
  const first = joining.beginJoining(joinInput());
  const second = joining.beginJoining(joinInput({ managerTerm: 2, grantVersion: 5 }));
  assert.deepEqual([second.reused, second.previousJoinId, second.joinId === first.joinId], [true, first.joinId, false]);
  assert.equal(joining.list().length, 1);
  assert.equal(joining.get(second.joinId).managerTerm, 2);
  assert.equal(joining.confirmJoining(first.joinId, 'session-a1', confirmArgs(joining, first.joinId)).reason, 'unknown');
  assert.equal(joining.confirmJoining(second.joinId, 'session-a1', confirmArgs(joining, second.joinId)).member, true);
});

test('beginJoining：跨实例同 sessionId 不得覆盖在途 grant', () => {
  const { joining } = joiningAt();
  const first = joining.beginJoining(joinInput({ instanceId: 'inst-a' }));
  assert.equal(joining.beginJoining(joinInput({ instanceId: 'inst-b' })).reason, 'instance-mismatch');
  assert.equal(joining.get(first.joinId).instanceId, 'inst-a');
  assert.equal(joining.confirmJoining(first.joinId, 'session-a1', confirmArgs(joining, first.joinId)).member, true);
});

test('beginJoining：同 sessionId 跨协作互不影响', () => {
  const { joining } = joiningAt();
  const first = joining.beginJoining(joinInput({ collabId: 'collab-1' }));
  const second = joining.beginJoining(joinInput({ collabId: 'collab-2' }));
  assert.notEqual(first.joinId, second.joinId);
  assert.equal(joining.find('collab-1', 'session-a1').joinId, first.joinId);
  assert.equal(joining.find('collab-2', 'session-a1').joinId, second.joinId);
});

test('beginJoining 容量：在途上限封顶，同键刷新不占新位', () => {
  const { joining } = joiningAt(NOW, { maxJoining: 2 });
  joining.beginJoining(joinInput({ sessionId: 'session-a1' }));
  joining.beginJoining(joinInput({ sessionId: 'session-b2' }));
  assert.equal(joining.beginJoining(joinInput({ sessionId: 'session-c3' })).reason, 'capacity');
  const refreshed = joining.beginJoining(joinInput({ sessionId: 'session-a1' }));
  assert.equal(refreshed.reused, true);
  joining.abortJoining(refreshed.joinId);
  assert.equal(joining.beginJoining(joinInput({ sessionId: 'session-c3' })).ok, true);
});

test('beginJoining 容量：活跃席位满拒绝，未满放行', () => {
  const { joining } = joiningAt();
  assert.equal(joining.beginJoining(joinInput({ activeSeats: 32 })).reason, 'capacity');
  assert.equal(joining.beginJoining(joinInput({ sessionId: 'session-b2', activeSeats: 31 })).ok, true);
  assert.equal(joining.list().length, 1);
});

test('confirmJoining：member 幂等，term/instance 绑定，grantVersion 不参与拒绝', () => {
  const { joining } = joiningAt();
  const { joinId } = joining.beginJoining(joinInput({ managerTerm: 2, grantVersion: 10 }));
  assert.equal(joining.confirmJoining(joinId, 'session-b2', confirmArgs(joining, joinId)).reason, 'session-mismatch');
  assert.equal(joining.confirmJoining(joinId, 'session-a1', confirmArgs(joining, joinId, { instanceId: 'inst-b' })).reason, 'instance-mismatch');
  assert.equal(joining.confirmJoining(joinId, 'session-a1', confirmArgs(joining, joinId, { managerTerm: 1 })).reason, 'manager-changed');
  assert.equal(joining.get(joinId).confirmed, false);
  assert.equal(joining.confirmJoining(joinId, 'session-a1', confirmArgs(joining, joinId)).member, true);
  assert.equal(joining.get(joinId).confirmed, true);
  const repeat = joining.confirmJoining(joinId, 'session-a1', confirmArgs(joining, joinId));
  assert.deepEqual([repeat.member, repeat.idempotent], [true, true]);
  assert.equal(joining.confirmJoining(joinId, 'session-a1', confirmArgs(joining, joinId, { managerTerm: 1 })).reason,
    'manager-changed', '幂等路径不绕过任期校验');
});

test('confirmJoining：managerTerm/activeSeats 必填（fail-closed）', () => {
  const { joining } = joiningAt();
  const { joinId } = joining.beginJoining(joinInput());
  assert.equal(joining.confirmJoining(joinId, 'session-a1', { instanceId: 'inst-a', activeSeats: 0 }).reason, 'invalid');
  assert.equal(joining.confirmJoining(joinId, 'session-a1', { managerTerm: 1, activeSeats: 0 }).reason, 'invalid');
  assert.equal(joining.confirmJoining(joinId, 'session-a1', { instanceId: 'inst-a', managerTerm: 1 }).reason, 'invalid');
  assert.equal(joining.get(joinId).confirmed, false);
  assert.equal(joining.confirmJoining(joinId, 'session-a1', confirmArgs(joining, joinId)).member, true);
});

test('confirmJoining 容量：活跃席位满拒绝且保留 joining，可重试', () => {
  const { joining } = joiningAt();
  const { joinId } = joining.beginJoining(joinInput());
  assert.equal(joining.confirmJoining(joinId, 'session-a1', confirmArgs(joining, joinId, { activeSeats: 32 })).reason, 'capacity');
  assert.equal(joining.get(joinId).confirmed, false);
  assert.equal(joining.confirmJoining(joinId, 'session-a1', confirmArgs(joining, joinId, { activeSeats: 31 })).member, true);
  assert.equal(joining.abortJoining(joinId).reason, 'already-member');
});

test('confirmJoining：名单已含本席（alreadyMember）时跳过容量，非法值拒绝', () => {
  const { joining } = joiningAt();
  const first = joining.beginJoining(joinInput({ sessionId: 'session-a1' }));
  const retried = joining.confirmJoining(first.joinId, 'session-a1', { instanceId: 'inst-a', managerTerm: 1, alreadyMember: true });
  assert.equal(retried.member, true, '名单已写入但 confirm 未执行：无需 activeSeats');
  const second = joining.beginJoining(joinInput({ sessionId: 'session-b2' }));
  assert.equal(joining.confirmJoining(second.joinId, 'session-b2', confirmArgs(joining, second.joinId, { alreadyMember: 'yes' })).reason, 'invalid');
  assert.equal(joining.confirmJoining(second.joinId, 'session-b2', confirmArgs(joining, second.joinId, { activeSeats: 32 })).reason, 'capacity');
  assert.equal(joining.confirmJoining(second.joinId, 'session-b2', confirmArgs(joining, second.joinId, { alreadyMember: true, activeSeats: 32 })).member, true);
});

test('unconfirmJoining：名单写入失败可回滚后重试', () => {
  const { joining } = joiningAt();
  const { joinId } = joining.beginJoining(joinInput());
  assert.deepEqual([joining.unconfirmJoining(joinId).unconfirmed, joining.get(joinId).confirmed], [false, false]);
  joining.confirmJoining(joinId, 'session-a1', confirmArgs(joining, joinId));
  const rolled = joining.unconfirmJoining(joinId);
  assert.deepEqual([rolled.ok, rolled.unconfirmed, joining.get(joinId).confirmed], [true, true, false]);
  assert.equal(joining.confirmJoining(joinId, 'session-a1', confirmArgs(joining, joinId)).member, true);
  assert.equal(joining.unconfirmJoining('join-nope').reason, 'unknown');
});

test('releaseJoining：离席释放后同键可再入席', () => {
  const { joining } = joiningAt();
  const first = joining.beginJoining(joinInput());
  joining.confirmJoining(first.joinId, 'session-a1', confirmArgs(joining, first.joinId));
  assert.equal(joining.beginJoining(joinInput()).reason, 'already-member');
  const released = joining.releaseJoining(COLLAB, 'session-a1');
  assert.deepEqual([released.released, released.record.joinId], [true, first.joinId]);
  assert.equal(joining.find(COLLAB, 'session-a1'), null);
  const second = joining.beginJoining(joinInput({ managerTerm: 2 }));
  assert.equal(second.ok, true);
  assert.notEqual(second.joinId, first.joinId);
  assert.deepEqual([joining.releaseJoining(COLLAB, 'session-a1').released, joining.releaseJoining(COLLAB, 'session-a1').released], [true, false]);
  joining.beginJoining(joinInput({ sessionId: 'session-b2' }));
  assert.equal(joining.releaseJoining(COLLAB, 'session-b2').released, true);
  assert.equal(joining.stats().aborted, 2, '未确认记录释放计入 aborted');
});

test('abortJoining：作废未确认记录并回传身份，未知/已确认拒绝', () => {
  const { joining } = joiningAt();
  const { joinId } = joining.beginJoining(joinInput());
  const aborted = joining.abortJoining(joinId, 'withdrawn');
  assert.deepEqual([aborted.ok, aborted.reason, aborted.record.joinId, aborted.record.sessionId], [true, 'withdrawn', joinId, 'session-a1']);
  assert.equal(joining.get(joinId), null);
  assert.equal(joining.confirmJoining(joinId, 'session-a1', confirmArgs(joining, joinId)).reason, 'unknown');
  assert.equal(joining.abortJoining(joinId).reason, 'unknown');
  const member = joining.beginJoining(joinInput());
  joining.confirmJoining(member.joinId, 'session-a1', confirmArgs(joining, member.joinId));
  assert.equal(joining.abortJoining(member.joinId).reason, 'already-member');
});

test('expireJoining：未确认超时清除并回传身份，已确认保留', () => {
  const { clock, joining } = joiningAt(NOW, { joiningTtlMs: 100 });
  const kept = joining.beginJoining(joinInput({ sessionId: 'session-a1' }));
  joining.confirmJoining(kept.joinId, 'session-a1', confirmArgs(joining, kept.joinId));
  const dropped = joining.beginJoining(joinInput({ sessionId: 'session-b2' }));
  clock.set(NOW + 100);
  const expired = joining.expireJoining();
  assert.deepEqual([expired.expired, expired.joinIds], [1, [dropped.joinId]]);
  assert.deepEqual([expired.records[0].joinId, expired.records[0].sessionId], [dropped.joinId, 'session-b2']);
  assert.equal(joining.get(dropped.joinId), null);
  assert.equal(joining.get(kept.joinId).confirmed, true);
  const fresh = joining.beginJoining(joinInput({ sessionId: 'session-c3' }));
  clock.set(NOW + 300);
  assert.equal(joining.confirmJoining(fresh.joinId, 'session-c3', confirmArgs(joining, fresh.joinId)).reason, 'expired');
  assert.equal(joining.get(fresh.joinId), null);
});

test('invalidateForManagerChange：未确认作废并回传身份，已确认保留', () => {
  const { joining } = joiningAt();
  const confirmed = joining.beginJoining(joinInput({ sessionId: 'session-a1', managerTerm: 1 }));
  joining.confirmJoining(confirmed.joinId, 'session-a1', confirmArgs(joining, confirmed.joinId));
  const oldTerm = joining.beginJoining(joinInput({ sessionId: 'session-b2', managerTerm: 1 }));
  const newTerm = joining.beginJoining(joinInput({ sessionId: 'session-c3', managerTerm: 2 }));
  const result = joining.invalidateForManagerChange(2);
  assert.deepEqual(result.aborted, [oldTerm.joinId]);
  assert.deepEqual([result.abortedRecords[0].joinId, result.abortedRecords[0].sessionId], [oldTerm.joinId, 'session-b2']);
  assert.deepEqual(result.kept, [confirmed.joinId]);
  assert.equal(joining.get(newTerm.joinId).confirmed, false);
  assert.equal(joining.confirmJoining(oldTerm.joinId, 'session-b2', confirmArgs(joining, oldTerm.joinId)).reason, 'unknown');
  assert.equal(joining.confirmJoining(newTerm.joinId, 'session-c3', confirmArgs(joining, newTerm.joinId)).member, true);
  assert.equal(joining.confirmJoining(confirmed.joinId, 'session-a1', confirmArgs(joining, confirmed.joinId)).member, true);
});

test('invalidateForManagerChange：不带 term 时作废全部未确认记录', () => {
  const { joining } = joiningAt();
  const first = joining.beginJoining(joinInput({ sessionId: 'session-a1' }));
  const second = joining.beginJoining(joinInput({ sessionId: 'session-b2' }));
  const kept = joining.beginJoining(joinInput({ sessionId: 'session-c3' }));
  joining.confirmJoining(kept.joinId, 'session-c3', confirmArgs(joining, kept.joinId));
  const result = joining.invalidateForManagerChange();
  assert.deepEqual([...result.aborted].sort(), [first.joinId, second.joinId].sort());
  assert.deepEqual(result.kept, [kept.joinId]);
  assert.deepEqual(joining.list().map((record) => record.joinId), [kept.joinId]);
});

test('joining 恢复：pendingJoins 只含未确认记录，confirmed 不以 joins.json 复活', () => {
  const { joining } = joiningAt();
  const confirmed = joining.beginJoining(joinInput({ sessionId: 'session-a1' }));
  joining.confirmJoining(confirmed.joinId, 'session-a1', confirmArgs(joining, confirmed.joinId));
  const pendingJoin = joining.beginJoining(joinInput({ sessionId: 'session-b2' }));
  const persisted = joining.pendingJoins();
  assert.deepEqual(persisted, [{
    joinId: pendingJoin.joinId,
    instanceId: 'inst-a',
    sessionId: 'session-b2',
    managerTerm: 1,
    grantVersion: 1,
    requestedAt: NOW,
    expiresAt: NOW + 1000,
  }], 'joins.json 只写未确认 joining，字段按设计形态');
  const reloaded = createJoiningRegistry({ now: () => NOW });
  assert.deepEqual(reloaded.restore(persisted, { collabId: COLLAB }), { ok: true, restored: 1, rejected: 0 });
  assert.equal(reloaded.find(COLLAB, 'session-a1'), null, '已确认席位以共享名单为准');
  assert.equal(reloaded.find(COLLAB, 'session-b2').joinId, pendingJoin.joinId);
  assert.equal(reloaded.confirmJoining(pendingJoin.joinId, 'session-b2', confirmArgs(reloaded, pendingJoin.joinId)).member, true);
  assert.equal(reloaded.restore([], {}).reason, 'invalid', 'collabId 必填');
});

test('joining 恢复：设计形态 raw 记录（无 collabId/confirmed）可直接导入', () => {
  const registry = createJoiningRegistry({ now: () => NOW });
  const raw = {
    joinId: 'join-raw',
    instanceId: 'inst-a',
    sessionId: 'session-a1',
    managerTerm: 2,
    grantVersion: 4,
    requestedAt: NOW,
    expiresAt: NOW + 1000,
  };
  assert.deepEqual(registry.restore([raw], { collabId: COLLAB }), { ok: true, restored: 1, rejected: 0 });
  assert.deepEqual(registry.find(COLLAB, 'session-a1'), { ...raw, collabId: COLLAB, confirmed: false, confirmedAt: null });
  assert.equal(registry.restore([{ ...raw, confirmed: true }], { collabId: COLLAB }).rejected, 1);
  assert.equal(registry.restore([{ ...raw, collabId: 'collab-2' }], { collabId: COLLAB }).rejected, 1);
});

test('joining 恢复：重复键/坏字段拒收，超容量保留最新 grant', () => {
  const registry = createJoiningRegistry({ now: () => NOW, maxJoining: 2 });
  const base = { instanceId: 'inst-a', managerTerm: 1, grantVersion: 1, expiresAt: NOW + 1000 };
  const records = [
    { joinId: 'join-1', sessionId: 'session-a1', requestedAt: NOW + 1, ...base },
    { joinId: 'join-2', sessionId: 'session-b2', requestedAt: NOW + 2, ...base },
    { joinId: 'join-3', sessionId: 'session-c3', requestedAt: NOW + 3, ...base },
  ];
  const result = registry.restore(records, { collabId: COLLAB, maxJoining: 2 });
  assert.deepEqual([result.restored, result.rejected], [2, 1]);
  assert.equal(registry.find(COLLAB, 'session-a1'), null, '裁剪最早 requestedAt');
  assert.equal(registry.find(COLLAB, 'session-c3').joinId, 'join-3');
  assert.deepEqual(registry.restore([records[1], { ...records[1], joinId: 'join-9' }], { collabId: COLLAB }),
    { ok: true, restored: 1, rejected: 1 });
  assert.equal(registry.restore([{ ...records[0], managerTerm: 0 }], { collabId: COLLAB }).rejected, 1);
});

test('find/release/rejoin 面：非法参数与未登记席位', () => {
  const { joining } = joiningAt();
  const { joinId } = joining.beginJoining(joinInput());
  assert.equal(joining.find(COLLAB, 'session-a1').joinId, joinId);
  assert.equal(joining.find('bad id', 'session-a1'), null);
  assert.equal(joining.find(COLLAB, 'bad id'), null);
  assert.equal(joining.releaseJoining('bad id', 'session-a1').reason, 'invalid');
  assert.deepEqual(joining.releaseJoining(COLLAB, 'session-b2'), { ok: true, released: false, record: null });
});

test('joining 失败不落账：begin/confirm 失败均不改记录', () => {
  const { joining } = joiningAt();
  assert.equal(joining.beginJoining(joinInput({ managerTerm: 0 })).reason, 'invalid');
  assert.equal(joining.list().length, 0);
  const { joinId } = joining.beginJoining(joinInput());
  assert.equal(joining.confirmJoining(joinId, 'session-b2', confirmArgs(joining, joinId)).reason, 'session-mismatch');
  assert.deepEqual([joining.get(joinId).confirmed, joining.list().length], [false, 1]);
  assert.equal(joining.invalidateForManagerChange(0).reason, 'invalid');
  assert.equal(joining.list().length, 1);
});
