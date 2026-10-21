import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  bringSessionOnline,
  injectionsOf,
  injectionTextsOf,
  linkSessionNodes,
  startSessionNode,
  targetOf,
  waitForInjection,
} from './helpers/session-participants.js';
import { waitFor } from './helpers.js';

/* 邀请的真实链路：站长建协作 → 对端收到邀请 → 同意门（确认挑战）→ 两段式入席。
 * 长操作声明：两节点进程内运行、邀请与确认均走真实回环 TCP；通常 < 20s，单用例超时上限 60s。 */

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

async function createCollab(manager, member, name, extraTarget = {}) {
  const created = await manager.service.create({
    name,
    topic: `${name} 主题`,
    targets: [targetOf(member, extraTarget)],
    mode: 'managed',
    sessionId: 'seat-manager',
  });
  assert.equal(created.ok, true, String(created.message));
  return created.collabId;
}

async function approveWithConsent(member, collabId, sessionId) {
  const first = await member.service.approve({ collabId, approve: true, sessionId });
  if (first.needsUserConfirmation !== true) {
    return first;
  }
  return member.service.approve({ collabId, approve: true, sessionId, confirmToken: first.confirmToken });
}

function inviteArrived(node, sessionId) {
  return injectionsOf(node, sessionId).some((entry) => entry.type === 'invite');
}

/* 受邀会话收到的邀请（真实链路；准入缺陷时为空——断言前给有界等窗，不无界等待）。 */
async function waitInviteOrNull(node, sessionId) {
  return waitForInjection(node, sessionId, (list) => list.some((entry) => entry.type === 'invite'), { timeoutMs: 5000 }).catch(() => null);
}

test('指名邀请：只有目标会话收到邀请，同机其他会话一条不投', { timeout: TIMEOUT_MS }, async (t) => {
  const { manager, member } = await startPair(t);
  const collabId = await createCollab(manager, member, '指名邀请', { targetSessionId: 'seat-b2' });
  await waitInviteOrNull(member, 'seat-b2');
  assert.equal(inviteArrived(member, 'seat-b2'), true, '目标会话应收到邀请（受邀未入席会话可注入）');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(injectionTextsOf(member, 'seat-b1').length, 0, '非目标会话不得收到邀请');
  const listed = member.service.list().collabs.find((entry) => entry.collabId === collabId);
  assert.ok(listed !== undefined, '受邀会话可读取待回应邀请');
});

test('受邀会话申请入席：两段式成席，重复同意不产生第二个席位', { timeout: TIMEOUT_MS }, async (t) => {
  const { manager, member } = await startPair(t);
  const collabId = await createCollab(manager, member, '同意入席', { targetSessionId: 'seat-b2' });
  await deliverInviteDirect(member, manager, collabId, '同意入席', { targetSessionId: 'seat-b2' });
  assert.equal((await approveWithConsent(member, collabId, 'seat-b2')).ok, true);
  await joinByRequest(manager, member, collabId, 'seat-b2');
  const again = await member.service.approve({ collabId, approve: true, sessionId: 'seat-b2' });
  assert.equal(again.ok, true, '同一会话重复同意按幂等处置');
  const seats = member.service.listLocalSeats(collabId).filter((seat) => seat.sessionId === 'seat-b2' && seat.state === 'member');
  assert.equal(seats.length, 1, '同会话只能接受一次（不得重复成席）');
});

test('受邀机两个会话各自申请：同机多席按会话计，互不挤占', { timeout: TIMEOUT_MS }, async (t) => {
  const { manager, member } = await startPair(t);
  const collabId = await createCollab(manager, member, '同机多席');
  await deliverInviteDirect(member, manager, collabId, '同机多席');
  await joinByRequest(manager, member, collabId, 'seat-b1');
  await joinByRequest(manager, member, collabId, 'seat-b2');
  const seats = member.service.listLocalSeats(collabId).filter((seat) => seat.state === 'member').map((seat) => seat.sessionId).sort();
  assert.deepEqual(seats, ['seat-b1', 'seat-b2'], '同机两个会话各自成席');
});

async function joinByRequest(manager, member, collabId, sessionId) {
  const requested = await member.service.join.request({ collabId, sessionId });
  assert.equal(requested.ok, true, String(requested.message));
  await waitFor(() => manager.service.join.pendingJoinsOf(collabId).some((record) => record.sessionId === sessionId) ? true : null, { timeoutMs: 5000 });
  const approved = await manager.service.join.approve({ collabId, sessionId, approve: true, approvedBy: 'seat-manager', managerSessionId: 'seat-manager' });
  assert.equal(approved.ok, true, String(approved.message));
  await waitFor(() => member.service.localSeatOf(collabId, sessionId)?.state === 'member' ? true : null, { timeoutMs: 8000 });
  await waitFor(() => manager.service.view({ collabId }).then((view) => view.ledger?.members?.some((seat) => seat.sessionId === sessionId) ? true : null), { timeoutMs: 8000 });
}

test('不指名邀请：同机两个会话各自成席（一机多席按会话计）', { timeout: TIMEOUT_MS }, async (t) => {
  const { manager, member } = await startPair(t);
  const collabId = await createCollab(manager, member, '不指名邀请');
  await waitInviteOrNull(member, 'seat-b1');
  await waitInviteOrNull(member, 'seat-b2');
  assert.equal(inviteArrived(member, 'seat-b1') && inviteArrived(member, 'seat-b2'), true, '不指名邀请应投目标机全部活跃会话');
  assert.equal((await approveWithConsent(member, collabId, 'seat-b1')).ok, true);
  assert.equal((await approveWithConsent(member, collabId, 'seat-b2')).ok, true);
  await waitFor(() => {
    const seats = member.service.listLocalSeats(collabId).filter((seat) => seat.state === 'member');
    return seats.length === 2 ? true : null;
  }, { timeoutMs: 15000 });
});

/* 准入缺陷（邀请载荷的 members 只含发起人、目标在 targets 中）当前会拒收真实邀请；
 * 本用例只在受邀侧直接走消费面，验证下游同意门与两段式入席本身可用——
 * 与上用例的准入失败分开归因，避免一个缺陷掩盖后半段链路的结论。 */
async function deliverInviteDirect(member, manager, collabId, name, { targetSessionId } = {}) {
  const payload = {
    name,
    topic: `${name} 主题`,
    mode: 'managed',
    members: [{ instanceId: manager.self.instanceId, sessionId: 'seat-manager', identityName: manager.self.identityName }],
    targets: [{ instanceId: member.self.instanceId, ...(targetSessionId ? { targetSessionId } : {}) }],
    ...(targetSessionId ? { targetSessionId } : {}),
  };
  await member.service.hooks.consume({
    v: 1,
    cap: 2,
    type: 'invite',
    msgId: randomUUID(),
    collabId,
    from: { instanceId: manager.self.instanceId, sessionId: 'seat-manager', identityName: manager.self.identityName, port: manager.port },
    ts: new Date().toISOString(),
    payload,
  }, { remoteAddress: '127.0.0.1' });
}
