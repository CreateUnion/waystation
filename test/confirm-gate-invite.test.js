import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bringSessionOnline, injectionsOf, linkSessionNodes, startSessionNode, targetOf,
} from './helpers/session-participants.js';
import { waitFor } from './helpers.js';

const TIMEOUT_MS = 60000;

async function startPair(t) {
  const manager = await startSessionNode(t, { identityName: '甲机', online: ['seat-manager'] });
  const member = await startSessionNode(t, { identityName: '乙机', online: ['seat-b1', 'seat-b2'] });
  linkSessionNodes(manager, member);
  await bringSessionOnline(manager, 'seat-manager');
  await bringSessionOnline(member, 'seat-b1');
  await bringSessionOnline(member, 'seat-b2');
  return { manager, member };
}

test('invite off：指名邀请在投递成功后自动同意并走完两段式入席', { timeout: TIMEOUT_MS }, async (t) => {
  const { manager, member } = await startPair(t);
  const set = member.service.setConfirmGate({
    action: 'set', gate: 'invite', requireConfirmation: false, scope: 'session', sessionId: 'seat-b2',
  });
  assert.equal(set.ok, true);
  const created = await manager.service.create({
    name: '自动同意', topic: '自动同意主题',
    targets: [targetOf(member, { targetSessionId: 'seat-b2' })],
    mode: 'managed', sessionId: 'seat-manager',
  });
  assert.equal(created.ok, true, String(created.message));
  const invited = await manager.service.join.createInvite({
    collabId: created.collabId, managerSessionId: 'seat-manager',
    targetInstanceId: member.self.instanceId, targetSessionId: 'seat-b2',
  });
  assert.equal(invited.ok, true, String(invited.message));
  const confirm = await waitFor(
    () => member.sentFrames.find((frame) => frame.type === 'join-confirm') ?? null,
    { timeoutMs: 8000 },
  );
  assert.ok(confirm, '自动同意后应以 seat-b2 身份发出 join-confirm');
  const view = await waitFor(async () => {
    const current = await manager.service.view({ collabId: created.collabId });
    return current.ledger.members.some((seat) => seat.sessionId === 'seat-b2') ? current : null;
  }, { timeoutMs: 8000 });
  assert.ok(view.ledger.members.some((seat) => seat.sessionId === 'seat-b2'), '最终成席');
});

test('invite off：注册补投让出握手期——登记时离线、10ms 后上线仍自动同意', { timeout: TIMEOUT_MS }, async (t) => {
  const { manager, member } = await startPair(t);
  member.service.setConfirmGate({
    action: 'set', gate: 'invite', requireConfirmation: false, scope: 'session', sessionId: 'seat-b2',
  });
  member.online.delete('seat-b2');
  member.service.unregisterBridgeEntry('seat-b2', 'bridge-seat-b2');
  const created = await manager.service.create({
    name: '握手让位自动同意', topic: '握手让位主题',
    targets: [targetOf(member, { targetSessionId: 'seat-b2' })],
    mode: 'managed', sessionId: 'seat-manager',
  });
  const invited = await manager.service.join.createInvite({
    collabId: created.collabId, managerSessionId: 'seat-manager',
    targetInstanceId: member.self.instanceId, targetSessionId: 'seat-b2',
  });
  assert.equal(invited.ok, true, String(invited.message));
  /* 先确认邀请已到达并登记（离线投不出去）：注册补投才是本用例的唯一投递机会。 */
  await waitFor(() => member.service.join.pendingInvitesFor({ collabId: created.collabId, sessionId: 'seat-b2' }).length > 0);
  assert.equal(member.sentFrames.some((frame) => frame.type === 'approve'), false, '离线时不得提前同意');
  const registering = member.service.registerBridgeEntry('seat-b2', 'bridge-seat-b2');
  await new Promise((resolve) => setTimeout(resolve, 10));
  member.online.add('seat-b2');
  await registering;
  const approve = await waitFor(
    () => member.sentFrames.find((frame) => frame.type === 'approve') ?? null,
    { timeoutMs: 8000 },
  );
  assert.ok(approve, '注册让出 welcome 后补投成功，才自动同意');
});

test('invite off：短码指名同样自动同意（与完整标识同一匹配口径）', { timeout: TIMEOUT_MS }, async (t) => {
  const memberSession = 'seat-b2-long';   // 短码 seat-b2- 与完整标识不同，才能判别匹配口径
  const manager = await startSessionNode(t, { identityName: '甲机', online: ['seat-manager'] });
  const member = await startSessionNode(t, { identityName: '乙机', online: [memberSession] });
  linkSessionNodes(manager, member);
  await bringSessionOnline(manager, 'seat-manager');
  await bringSessionOnline(member, memberSession);
  /* 先让建协首邀（完整标识、同意门默认开启）投达，再关同意门：本用例的自动同意只能由
   * 随后那条短码指名的邀请触发，避免被首邀的全量标识命中掩盖口径问题。 */
  const created = await manager.service.create({
    name: '短码自动同意', topic: '短码主题',
    targets: [targetOf(member, { targetSessionId: memberSession })],
    mode: 'managed', sessionId: 'seat-manager',
  });
  assert.equal(created.ok, true, String(created.message));
  await waitFor(() => injectionsOf(member, memberSession).some((entry) => entry.type === 'invite'));
  const set = member.service.setConfirmGate({
    action: 'set', gate: 'invite', requireConfirmation: false, scope: 'session', sessionId: memberSession,
  });
  assert.equal(set.ok, true);
  assert.equal(member.sentFrames.some((frame) => frame.type === 'join-confirm'), false, '首邀未被自动同意');
  const invited = await manager.service.join.createInvite({
    collabId: created.collabId, managerSessionId: 'seat-manager',
    targetInstanceId: member.self.instanceId, targetSessionId: 'seat-b2-',
  });
  assert.equal(invited.ok, true, String(invited.message));
  const confirm = await waitFor(
    () => member.sentFrames.find((frame) => frame.type === 'join-confirm') ?? null,
    { timeoutMs: 8000 },
  );
  assert.ok(confirm, '短码指名到本会话的邀请应自动同意并走完两段式入席');
});

test('invite off：不指名邀请仍人工，不自动同意', { timeout: TIMEOUT_MS }, async (t) => {
  const { manager, member } = await startPair(t);
  member.service.setConfirmGate({
    action: 'set', gate: 'invite', requireConfirmation: false, scope: 'session', sessionId: 'seat-b1',
  });
  const created = await manager.service.create({
    name: '不指名', topic: '不指名主题', targets: [targetOf(member)],
    mode: 'managed', sessionId: 'seat-manager',
  });
  assert.equal(created.ok, true, String(created.message));
  const invited = await manager.service.join.createInvite({
    collabId: created.collabId, managerSessionId: 'seat-manager',
    targetInstanceId: member.self.instanceId,
  });
  assert.equal(invited.ok, true, String(invited.message));
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(member.sentFrames.some((frame) => frame.type === 'approve'), false, '不指名邀请不得自动同意');
});

test('invite off：离线指名邀请补投后才自动同意（staged / 挂起补投不算提前同意）', { timeout: TIMEOUT_MS }, async (t) => {
  const { manager, member } = await startPair(t);
  member.service.setConfirmGate({
    action: 'set', gate: 'invite', requireConfirmation: false, scope: 'session', sessionId: 'seat-b2',
  });
  member.online.delete('seat-b2');
  member.service.unregisterBridgeEntry('seat-b2', 'bridge-seat-b2');
  const created = await manager.service.create({
    name: '补投自动同意', topic: '补投主题',
    targets: [targetOf(member, { targetSessionId: 'seat-b2' })],
    mode: 'managed', sessionId: 'seat-manager',
  });
  const invited = await manager.service.join.createInvite({
    collabId: created.collabId, managerSessionId: 'seat-manager',
    targetInstanceId: member.self.instanceId, targetSessionId: 'seat-b2',
  });
  assert.equal(invited.ok, true, String(invited.message));
  assert.equal(member.sentFrames.some((frame) => frame.type === 'approve'), false, '离线时不得提前同意');
  await bringSessionOnline(member, 'seat-b2');
  const approve = await waitFor(
    () => member.sentFrames.find((frame) => frame.type === 'approve') ?? null,
    { timeoutMs: 8000 },
  );
  assert.ok(approve, '补投到目标会话后才自动同意');
});
