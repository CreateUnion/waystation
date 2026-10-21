import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  JOINING_TTL_MS,
  PENDING_INVITE_CAPACITY,
  createInvitesBook,
  createJoiningRegistry,
  createPendingInvites,
} from '../src/collab/invites.js';

/* 邀请与两段式入席的纯逻辑面：发起侧邀请簿记、目标机挂起邀请、站长的 joining 准入台账。
 * 全部为内存态（不写盘、不发帧），时间经注入时钟推进，故 TTL / 过期 / 容量淘汰都可确定复现。 */

const NOW = 1_000_000;

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
    collabId: 'collab-1',
    fromManager: { instanceId: 'inst-m', sessionId: 'session-m1' },
    expiresAt: NOW + 1000,
    ...overrides,
  };
}

function joinInput(overrides = {}) {
  return {
    collabId: 'collab-1',
    instanceId: 'inst-a',
    sessionId: 'session-a1',
    managerTerm: 1,
    grantVersion: 1,
    ...overrides,
  };
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

/* —— 目标机挂起邀请 —— */

test('applyPendingInvite：登记形态与同键重复帧去重', () => {
  const { pending } = pendingAt();
  const applied = pending.applyPendingInvite(pendingRecord());
  assert.equal(applied.ok, true);
  assert.equal(applied.duplicate, false);
  assert.deepEqual(pending.list(), [{
    inviteId: 'inv-1',
    collabId: 'collab-1',
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
  const forA = pending.matchPendingForSession({ sessionId: 'session-a1' });
  assert.deepEqual(forA.map((record) => record.inviteId).sort(), ['inv-1', 'inv-2']);
  const forB = pending.matchPendingForSession({ sessionId: 'session-b2' });
  assert.deepEqual(forB.map((record) => record.inviteId).sort(), ['inv-1', 'inv-3']);
  assert.deepEqual(pending.matchPendingForSession({ sessionId: 'session-a1', inviteId: 'inv-3' }), []);
  assert.deepEqual(pending.matchPendingForSession({ sessionId: 'session-a1', collabId: 'collab-x' }), []);
  assert.deepEqual(pending.matchPendingForSession({ sessionId: 'bad id' }), []);
});

test('matchPendingForSession：已接受/已拒绝/已过期/已撤回不匹配', () => {
  const { clock, pending } = pendingAt();
  pending.applyPendingInvite(pendingRecord({ inviteId: 'inv-acc' }));
  pending.applyPendingInvite(pendingRecord({ inviteId: 'inv-dec' }));
  pending.applyPendingInvite(pendingRecord({ inviteId: 'inv-exp', expiresAt: NOW + 100 }));
  pending.applyPendingInvite(pendingRecord({ inviteId: 'inv-wd' }));
  pending.consumeForSession({ inviteId: 'inv-acc', sessionId: 'session-a1' });
  pending.consumeForSession({ inviteId: 'inv-dec', sessionId: 'session-a1', declined: true });
  pending.withdrawPending('inv-wd');
  clock.set(NOW + 100);
  const forA = pending.matchPendingForSession({ sessionId: 'session-a1' });
  assert.deepEqual(forA, []);
  assert.deepEqual(pending.matchPendingForSession({ sessionId: 'session-b2' }).map((record) => record.inviteId).sort(),
    ['inv-acc', 'inv-dec']);
});

test('consumeForSession：不指名首 accept 不消费整条，指名邀请 accept 消费整条', () => {
  const { pending } = pendingAt();
  pending.applyPendingInvite(pendingRecord());
  const first = pending.consumeForSession({ inviteId: 'inv-1', sessionId: 'session-a1' });
  assert.deepEqual([first.ok, first.accepted, first.consumed], [true, true, false]);
  assert.deepEqual([pending.get('inv-1').state, pending.get('inv-1').acceptedSessions], ['open', ['session-a1']]);
  const second = pending.consumeForSession({ inviteId: 'inv-1', sessionId: 'session-b2' });
  assert.deepEqual([second.consumed, pending.get('inv-1').acceptedSessions.length], [false, 2]);
  const repeat = pending.consumeForSession({ inviteId: 'inv-1', sessionId: 'session-a1' });
  assert.deepEqual([repeat.ok, repeat.idempotent, pending.get('inv-1').acceptedSessions.length], [true, true, 2]);
  pending.applyPendingInvite(pendingRecord({ inviteId: 'inv-2', targetSessionId: 'session-a1' }));
  assert.equal(pending.consumeForSession({ inviteId: 'inv-2', sessionId: 'session-b2' }).reason, 'target-mismatch');
  assert.deepEqual([pending.consumeForSession({ inviteId: 'inv-2', sessionId: 'session-a1' }).consumed,
    pending.get('inv-2').state], [true, 'consumed']);
});

test('consumeForSession：指名 decline 消费整条，不指名 decline 只排除本会话', () => {
  const { pending } = pendingAt();
  pending.applyPendingInvite(pendingRecord());
  const declined = pending.consumeForSession({ inviteId: 'inv-1', sessionId: 'session-a1', declined: true });
  assert.deepEqual([declined.ok, declined.consumed, pending.get('inv-1').state], [true, false, 'open']);
  assert.deepEqual(pending.matchPendingForSession({ sessionId: 'session-a1' }), []);
  assert.equal(pending.matchPendingForSession({ sessionId: 'session-b2' }).length, 1);
  pending.applyPendingInvite(pendingRecord({ inviteId: 'inv-2', targetSessionId: 'session-a1' }));
  assert.deepEqual([pending.consumeForSession({ inviteId: 'inv-2', sessionId: 'session-a1', declined: true }).consumed,
    pending.get('inv-2').state, pending.get('inv-2').acceptedSessions], [true, 'consumed', []]);
});

test('expirePending/withdrawPending：状态转换与匹配面', () => {
  const { clock, pending } = pendingAt();
  pending.applyPendingInvite(pendingRecord({ inviteId: 'inv-exp', expiresAt: NOW + 100 }));
  pending.applyPendingInvite(pendingRecord({ inviteId: 'inv-open' }));
  clock.set(NOW + 100);
  assert.deepEqual(pending.expirePending(), { expired: 1, inviteIds: ['inv-exp'] });
  assert.equal(pending.get('inv-exp').state, 'expired');
  assert.equal(pending.consumeForSession({ inviteId: 'inv-exp', sessionId: 'session-a1' }).reason, 'expired');
  assert.deepEqual(pending.withdrawPending('inv-open'), { ok: true, withdrawn: 1 });
  assert.equal(pending.get('inv-open').state, 'withdrawn');
  assert.deepEqual(pending.matchPendingForSession({ sessionId: 'session-a1' }), []);
  assert.deepEqual(pending.withdrawPending('inv-nope'), { ok: true, withdrawn: 0 });
});

test('pending 容量：缺省 64，超限淘汰最早过期者并计数，不丢最新', () => {
  const { pending } = pendingAt();
  assert.equal(PENDING_INVITE_CAPACITY, 64);
  for (let index = 0; index < 64; index++) {
    pending.applyPendingInvite(pendingRecord({ inviteId: `inv-${index}`, expiresAt: NOW + 1000 + index }));
  }
  const applied = pending.applyPendingInvite(pendingRecord({ inviteId: 'inv-new', expiresAt: NOW + 10_000 }));
  assert.deepEqual([applied.ok, applied.evicted], [true, 'inv-0']);
  assert.equal(pending.list().length, 64);
  assert.equal(pending.get('inv-0'), null);
  assert.equal(pending.get('inv-new').state, 'open');
  assert.equal(pending.stats().dropped, 1);
  pending.applyPendingInvite(pendingRecord({ inviteId: 'inv-new', expiresAt: NOW + 20_000 }));
  assert.deepEqual([pending.list().length, pending.stats().dropped], [64, 1]);
});

test('pending 容量：淘汰按最早过期而非最旧插入', () => {
  const { pending } = pendingAt(NOW, { capacity: 2 });
  pending.applyPendingInvite(pendingRecord({ inviteId: 'inv-late', expiresAt: NOW + 9000 }));
  pending.applyPendingInvite(pendingRecord({ inviteId: 'inv-early', expiresAt: NOW + 100 }));
  const applied = pending.applyPendingInvite(pendingRecord({ inviteId: 'inv-new', expiresAt: NOW + 5000 }));
  assert.equal(applied.evicted, 'inv-early');
  assert.deepEqual(pending.list().map((record) => record.inviteId).sort(), ['inv-late', 'inv-new']);
});

test('pending 消费失败不落账（失败回滚）', () => {
  const { clock, pending } = pendingAt();
  pending.applyPendingInvite(pendingRecord({ targetSessionId: 'session-a1' }));
  assert.equal(pending.consumeForSession({ inviteId: 'inv-1', sessionId: 'session-b2' }).reason, 'target-mismatch');
  assert.deepEqual([pending.get('inv-1').state, pending.get('inv-1').acceptedSessions], ['open', []]);
  assert.equal(pending.consumeForSession({ inviteId: 'inv-nope', sessionId: 'session-a1' }).reason, 'unknown');
  clock.set(NOW + 1000);
  assert.equal(pending.consumeForSession({ inviteId: 'inv-1', sessionId: 'session-a1' }).reason, 'expired');
  assert.deepEqual([pending.get('inv-1').state, pending.get('inv-1').acceptedSessions], ['expired', []]);
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
    collabId: 'collab-1',
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
  assert.equal(joining.confirmJoining(first.joinId, 'session-a1', { managerTerm: 2 }).reason, 'unknown');
  assert.equal(joining.confirmJoining(second.joinId, 'session-a1', { managerTerm: 2 }).member, true);
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

test('confirmJoining：member 幂等，managerTerm 不符拒绝，grantVersion 不参与拒绝', () => {
  const { joining } = joiningAt();
  const { joinId } = joining.beginJoining(joinInput({ managerTerm: 2, grantVersion: 10 }));
  assert.equal(joining.confirmJoining(joinId, 'session-b2').reason, 'session-mismatch');
  assert.equal(joining.confirmJoining(joinId, 'session-a1', { managerTerm: 1 }).reason, 'manager-changed');
  assert.equal(joining.get(joinId).confirmed, false);
  assert.equal(joining.confirmJoining(joinId, 'session-a1', { managerTerm: 2, version: 99 }).member, true);
  assert.equal(joining.get(joinId).confirmed, true);
  const repeat = joining.confirmJoining(joinId, 'session-a1', { managerTerm: 1 });
  assert.deepEqual([repeat.member, repeat.idempotent], [true, true]);
});

test('confirmJoining 容量：活跃席位满拒绝且保留 joining，可重试', () => {
  const { joining } = joiningAt();
  const { joinId } = joining.beginJoining(joinInput());
  assert.equal(joining.confirmJoining(joinId, 'session-a1', { activeSeats: 32 }).reason, 'capacity');
  assert.equal(joining.get(joinId).confirmed, false);
  assert.equal(joining.confirmJoining(joinId, 'session-a1', { activeSeats: 31 }).member, true);
  assert.equal(joining.abortJoining(joinId).reason, 'already-member');
});

test('abortJoining：作废未确认记录，未知/已确认拒绝', () => {
  const { joining } = joiningAt();
  const { joinId } = joining.beginJoining(joinInput());
  const aborted = joining.abortJoining(joinId, 'withdrawn');
  assert.deepEqual([aborted.ok, aborted.reason], [true, 'withdrawn']);
  assert.equal(joining.get(joinId), null);
  assert.equal(joining.confirmJoining(joinId, 'session-a1').reason, 'unknown');
  assert.equal(joining.abortJoining(joinId).reason, 'unknown');
  const member = joining.beginJoining(joinInput());
  joining.confirmJoining(member.joinId, 'session-a1');
  assert.equal(joining.abortJoining(member.joinId).reason, 'already-member');
});

test('expireJoining：未确认超时清除，已确认跨越 TTL 保留', () => {
  const { clock, joining } = joiningAt(NOW, { joiningTtlMs: 100 });
  const kept = joining.beginJoining(joinInput({ sessionId: 'session-a1' }));
  joining.confirmJoining(kept.joinId, 'session-a1');
  const dropped = joining.beginJoining(joinInput({ sessionId: 'session-b2' }));
  clock.set(NOW + 100);
  assert.deepEqual(joining.expireJoining(), { expired: 1, joinIds: [dropped.joinId] });
  assert.equal(joining.get(dropped.joinId), null);
  assert.equal(joining.get(kept.joinId).confirmed, true);
  const fresh = joining.beginJoining(joinInput({ sessionId: 'session-c3' }));
  clock.set(NOW + 300);
  assert.equal(joining.confirmJoining(fresh.joinId, 'session-c3').reason, 'expired');
  assert.equal(joining.get(fresh.joinId), null);
});

test('invalidateForManagerChange：未确认作废、已确认保留，按新 term 过滤', () => {
  const { joining } = joiningAt();
  const confirmed = joining.beginJoining(joinInput({ sessionId: 'session-a1', managerTerm: 1 }));
  joining.confirmJoining(confirmed.joinId, 'session-a1');
  const oldTerm = joining.beginJoining(joinInput({ sessionId: 'session-b2', managerTerm: 1 }));
  const newTerm = joining.beginJoining(joinInput({ sessionId: 'session-c3', managerTerm: 2 }));
  const result = joining.invalidateForManagerChange(2);
  assert.deepEqual(result.aborted, [oldTerm.joinId]);
  assert.deepEqual(result.kept, [confirmed.joinId]);
  assert.equal(joining.get(newTerm.joinId).confirmed, false);
  assert.equal(joining.confirmJoining(oldTerm.joinId, 'session-b2').reason, 'unknown');
  assert.equal(joining.confirmJoining(newTerm.joinId, 'session-c3', { managerTerm: 2 }).member, true);
  assert.equal(joining.confirmJoining(confirmed.joinId, 'session-a1').member, true);
});

test('invalidateForManagerChange：不带 term 时作废全部未确认记录', () => {
  const { joining } = joiningAt();
  const first = joining.beginJoining(joinInput({ sessionId: 'session-a1' }));
  const second = joining.beginJoining(joinInput({ sessionId: 'session-b2' }));
  const kept = joining.beginJoining(joinInput({ sessionId: 'session-c3' }));
  joining.confirmJoining(kept.joinId, 'session-c3');
  const result = joining.invalidateForManagerChange();
  assert.deepEqual([...result.aborted].sort(), [first.joinId, second.joinId].sort());
  assert.deepEqual(result.kept, [kept.joinId]);
  assert.deepEqual(joining.list().map((record) => record.joinId), [kept.joinId]);
});

test('joining 失败不落账：begin/confirm 失败均不改记录', () => {
  const { joining } = joiningAt();
  assert.equal(joining.beginJoining(joinInput({ managerTerm: 0 })).reason, 'invalid');
  assert.equal(joining.list().length, 0);
  const { joinId } = joining.beginJoining(joinInput());
  assert.equal(joining.confirmJoining(joinId, 'session-b2').reason, 'session-mismatch');
  assert.deepEqual([joining.get(joinId).confirmed, joining.list().length], [false, 1]);
  assert.equal(joining.invalidateForManagerChange(0).reason, 'invalid');
  assert.equal(joining.list().length, 1);
});
