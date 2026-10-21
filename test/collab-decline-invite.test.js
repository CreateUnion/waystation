import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPendingInvites } from '../src/collab/invites.js';

/* 挂起邀请的会话级拒绝（设计 §4.3「拒绝 = 本条不参与」）：纯逻辑面不写盘、不发帧；
 * 拒绝只进内存 declines，指名记录整条 consumed，不指名记录只挡本会话。 */

const NOW = 1_000_000;
const COLLAB = 'collab-1';

function pendingAt(start = NOW) {
  const clock = { value: start };
  return { clock, pending: createPendingInvites({ now: () => clock.value }) };
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

function decline(pending, inviteId, sessionId, overrides = {}) {
  return pending.declineForSession({ collabId: COLLAB, inviteId, sessionId, ...overrides });
}

function matchFor(pending, sessionId, overrides = {}) {
  return pending.matchPendingForSession({ collabId: COLLAB, sessionId, ...overrides });
}

test('declineForSession：指名拒绝消费整条，返回结论且不再补投本会话', () => {
  const { pending } = pendingAt();
  pending.applyPendingInvite(pendingRecord({ targetSessionId: 'session-a1' }));
  const declined = decline(pending, 'inv-1', 'session-a1', { reason: '本轮不参加' });
  assert.deepEqual([declined.ok, declined.declined, declined.consumed, declined.idempotent], [true, true, true, false]);
  assert.equal(pending.get({ collabId: COLLAB, inviteId: 'inv-1' }).state, 'consumed');
  assert.deepEqual(matchFor(pending, 'session-a1'), [], '拒绝后不再补投本会话');
  assert.equal(pending.stats().declined, 1);
  assert.equal('declined' in pending.list()[0], false, '拒绝记录不进挂起邀请形态');
});

test('declineForSession：不指名拒绝只挡本会话，他人仍可接受', () => {
  const { pending } = pendingAt();
  pending.applyPendingInvite(pendingRecord());
  const declined = decline(pending, 'inv-1', 'session-a1');
  assert.deepEqual([declined.ok, declined.consumed], [true, false]);
  assert.equal(pending.get({ collabId: COLLAB, inviteId: 'inv-1' }).state, 'open');
  assert.deepEqual(matchFor(pending, 'session-a1'), []);
  assert.equal(matchFor(pending, 'session-b2').length, 1);
  const accepted = pending.consumeForSession({ collabId: COLLAB, inviteId: 'inv-1', sessionId: 'session-b2', now: NOW });
  assert.equal(accepted.ok, true);
  assert.equal(pending.consumeForSession({ collabId: COLLAB, inviteId: 'inv-1', sessionId: 'session-a1', now: NOW }).reason,
    'already-declined', '拒绝过的会话不得反转');
});

test('declineForSession：重复拒绝幂等，不重复计数', () => {
  const { pending } = pendingAt();
  pending.applyPendingInvite(pendingRecord({ targetSessionId: 'session-a1' }));
  assert.equal(decline(pending, 'inv-1', 'session-a1').idempotent, false);
  const repeat = decline(pending, 'inv-1', 'session-a1');
  assert.deepEqual([repeat.ok, repeat.declined, repeat.consumed, repeat.idempotent], [true, true, true, true]);
  assert.equal(pending.stats().declined, 1);
});

test('declineForSession：先接后拒不覆盖已成事实', () => {
  const { pending } = pendingAt();
  pending.applyPendingInvite(pendingRecord({ targetSessionId: 'session-a1' }));
  assert.equal(pending.consumeForSession({ collabId: COLLAB, inviteId: 'inv-1', sessionId: 'session-a1', now: NOW }).ok, true);
  const flip = decline(pending, 'inv-1', 'session-a1');
  assert.equal(flip.ok, false);
  assert.equal(flip.reason, 'already-accepted');
  assert.deepEqual(pending.get({ collabId: COLLAB, inviteId: 'inv-1' }).acceptedSessions, ['session-a1']);
  assert.equal(pending.stats().declined, 0);
});

test('declineForSession：过期优先于幂等，记录转 expired', () => {
  const { clock, pending } = pendingAt();
  pending.applyPendingInvite(pendingRecord());
  decline(pending, 'inv-1', 'session-a1');
  clock.value = NOW + 1000;
  assert.equal(decline(pending, 'inv-1', 'session-a1').reason, 'expired');
  assert.equal(pending.get({ collabId: COLLAB, inviteId: 'inv-1' }).state, 'expired');
});

test('declineForSession：目标/协作/形态不符如实拒绝且不落拒绝账', () => {
  const { pending } = pendingAt();
  pending.applyPendingInvite(pendingRecord({ targetSessionId: 'session-b2' }));
  pending.applyPendingInvite(pendingRecord({ inviteId: 'inv-2', collabId: 'collab-2' }));
  assert.equal(decline(pending, 'inv-1', 'session-a1').reason, 'target-mismatch');
  assert.equal(decline(pending, 'inv-2', 'session-a1').reason, 'collab-mismatch');
  assert.equal(decline(pending, 'inv-missing', 'session-a1').reason, 'unknown');
  assert.equal(decline(pending, 'inv-1').reason, 'invalid');
  assert.equal(decline(pending, 'bad id', 'session-a1').reason, 'invalid');
  assert.equal(pending.stats().declined, 0);
  assert.equal(matchFor(pending, 'session-b2').length, 1, '不匹配的拒绝不影响目标会话');
  assert.equal(pending.matchPendingForSession({ collabId: 'collab-2', sessionId: 'session-a1' }).length, 1);
});

test('declineForSession：已撤回记录不可再拒绝', () => {
  const { pending } = pendingAt();
  pending.applyPendingInvite(pendingRecord());
  assert.equal(pending.withdrawPending({ collabId: COLLAB, inviteId: 'inv-1' }).ok, true);
  assert.equal(decline(pending, 'inv-1', 'session-a1').reason, 'withdrawn');
});
