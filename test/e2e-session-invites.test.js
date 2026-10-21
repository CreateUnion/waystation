import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { invitesFilePath, joinsFilePath, pendingInvitesFilePath } from '../src/paths.js';
import {
  bringSessionOnline,
  closeSessionNode,
  injectionsOf,
  linkSessionNodes,
  makeTempRoot,
  startSessionNode,
  targetOf,
  waitForInjection,
} from './helpers/session-participants.js';
import { waitFor, waitForRebindable } from './helpers.js';

/* 邀请的真实链路（设计 §4）：站长建协作 → 邀请经真实回环 TCP 进入受邀核的 inbound
 * （准入 → 写门 → pending-invites 落盘 → 扇出注入）→ 受邀会话 acceptInvite 携 inviteId
 * → 站长签发 join-grant → 受邀核 join-confirm → 站长写名单并回快照。
 * 断言覆盖 inviteId、from.sessionId、到站帧与落盘文件；不经 hooks.consume 绕过管线。
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

/* 0.2.0 邀请入口（M4）：生成 inviteId ＋ invites.json 簿记，再经 sendDirect 投目标机。 */
async function sendInvite(manager, collabId, member, targetSessionId) {
  const invited = await manager.service.join.createInvite({
    collabId,
    managerSessionId: 'seat-manager',
    targetInstanceId: member.self.instanceId,
    ...(targetSessionId === undefined ? {} : { targetSessionId }),
  });
  assert.equal(invited.ok, true, String(invited.message));
  assert.match(String(invited.inviteId), /^inv-/, '邀请必须生成 inviteId');
  return invited;
}

function invitesOf(node, sessionId) {
  return injectionsOf(node, sessionId).filter((entry) => entry.type === 'invite');
}

function waitInviteOrNull(node, sessionId, predicate = () => true) {
  return waitForInjection(node, sessionId, (list) => list.some((entry) => entry.type === 'invite' && predicate(entry)), { timeoutMs: 8000 })
    .catch(() => null);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function readJsonOrNull(file) {
  try {
    return readJson(file);
  } catch {
    return null;
  }
}

test('指名邀请：邀请帧携 inviteId / from.sessionId，只投目标会话且落盘登记', { timeout: TIMEOUT_MS }, async (t) => {
  const { manager, member } = await startPair(t);
  const collabId = await createCollab(manager, member, '指名邀请', { targetSessionId: 'seat-b2' });
  const invited = await sendInvite(manager, collabId, member, 'seat-b2');
  await waitInviteOrNull(member, 'seat-b2', (entry) => entry.payload?.inviteId === invited.inviteId);
  const arrived = invitesOf(member, 'seat-b2').find((entry) => entry.payload?.inviteId === invited.inviteId);
  assert.ok(arrived !== undefined, '目标会话应收到携 inviteId 的邀请（受邀未入席会话可注入）');
  assert.equal(arrived.frame.from.sessionId, 'seat-manager', '邀请帧必须携发件会话');
  assert.equal(arrived.frame.from.instanceId, manager.self.instanceId);
  assert.deepEqual(arrived.payload.targets, [{ instanceId: member.self.instanceId, targetSessionId: 'seat-b2' }], 'targets 描述目标机器与指名会话');
  assert.ok(arrived.payload.members.some((seat) => seat.instanceId === manager.self.instanceId && seat.sessionId === 'seat-manager'), 'members 含发起人席位（席位键形态）');
  assert.equal(arrived.payload.members.some((seat) => seat.instanceId === member.self.instanceId), false, '受邀未入席者不在 members');

  const book = readJson(invitesFilePath(manager.home, collabId));
  const record = book.invites.find((entry) => entry.inviteId === invited.inviteId);
  assert.ok(record !== undefined, 'invites.json 登记邀请记录');
  assert.deepEqual(record.targets, [{ instanceId: member.self.instanceId, targetSessionId: 'seat-b2' }]);
  assert.equal(record.state, 'open');

  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(invitesOf(member, 'seat-b1').length, 0, '非目标会话不得收到指名的 0.2.0 邀请');
});

test('受邀会话 acceptInvite：inviteId → approve → join-grant → join-confirm 两段式成席', { timeout: TIMEOUT_MS }, async (t) => {
  const { manager, member } = await startPair(t);
  const collabId = await createCollab(manager, member, '同意入席', { targetSessionId: 'seat-b2' });
  const invited = await sendInvite(manager, collabId, member, 'seat-b2');
  await waitInviteOrNull(member, 'seat-b2', (entry) => entry.payload?.inviteId === invited.inviteId);

  const managerRosterBefore = await manager.service.view({ collabId });
  assert.equal(managerRosterBefore.ledger.members.some((seat) => seat.sessionId === 'seat-b2'), false, '接受前不在共享名单');

  const accepted = await member.service.join.acceptInvite({ collabId, inviteId: invited.inviteId, sessionId: 'seat-b2' });
  assert.equal(accepted.ok, true, String(accepted.message));
  assert.equal(accepted.inviteId, invited.inviteId);

  const grant = await waitFor(() => manager.sentFrames.find((frame) => frame.type === 'join-grant'
    && frame.payload?.joinId !== undefined) ?? null, { timeoutMs: 8000 });
  assert.equal(grant.from?.sessionId ?? grant.fromSessionId, 'seat-manager', 'join-grant 由站长席位签发');
  assert.deepEqual(grant.toSessions, ['seat-b2']);

  const confirm = await waitFor(() => member.sentFrames.find((frame) => frame.type === 'join-confirm'
    && frame.payload?.joinId === grant.payload.joinId) ?? null, { timeoutMs: 8000 });
  assert.equal(confirm.from?.sessionId ?? confirm.fromSessionId, 'seat-b2', 'join-confirm 由申请人会话签发');

  await waitFor(async () => {
    const view = await manager.service.view({ collabId });
    return view.ledger?.members.some((seat) => seat.instanceId === member.self.instanceId && seat.sessionId === 'seat-b2') ? true : null;
  }, { timeoutMs: 8000 });
  await waitFor(() => member.service.localSeatOf(collabId, 'seat-b2')?.unverified === false ? true : null, { timeoutMs: 8000 });
  const seat = member.service.localSeatOf(collabId, 'seat-b2');
  assert.equal(seat.state, 'member');
  assert.equal(seat.role, 'member');

  const book = readJson(invitesFilePath(manager.home, collabId));
  const record = book.invites.find((entry) => entry.inviteId === invited.inviteId);
  assert.ok(record.acceptedSessions.some((entry) => entry.sessionId === 'seat-b2'), '已 joined 的会话登记到 acceptedSessions');
  assert.deepEqual(readJson(joinsFilePath(manager.home, collabId)).pendingJoins, [], '已确认席位不残留在 joins.json');

  const again = await member.service.join.acceptInvite({ collabId, inviteId: invited.inviteId, sessionId: 'seat-b2' });
  assert.equal(again.ok, true, '重复同意按幂等处置');
  const seats = member.service.listLocalSeats(collabId).filter((entry) => entry.sessionId === 'seat-b2');
  assert.equal(seats.length, 1, '同会话只能成席一次');
  const roster = (await manager.service.view({ collabId })).ledger.members.filter((entry) => entry.sessionId === 'seat-b2');
  assert.equal(roster.length, 1, '站长名单同样只有一行');
});

test('受邀机两个会话各自同意：同一不指名 inviteId 产出两席，互不挤占', { timeout: TIMEOUT_MS }, async (t) => {
  const { manager, member } = await startPair(t);
  const collabId = await createCollab(manager, member, '同机多席');
  const invited = await sendInvite(manager, collabId, member);
  await waitInviteOrNull(member, 'seat-b1', (entry) => entry.payload?.inviteId === invited.inviteId);
  await waitInviteOrNull(member, 'seat-b2', (entry) => entry.payload?.inviteId === invited.inviteId);
  assert.equal(invitesOf(member, 'seat-b1').some((entry) => entry.payload?.inviteId === invited.inviteId), true);
  assert.equal(invitesOf(member, 'seat-b2').some((entry) => entry.payload?.inviteId === invited.inviteId), true);

  for (const sessionId of ['seat-b1', 'seat-b2']) {
    const accepted = await member.service.join.acceptInvite({ collabId, inviteId: invited.inviteId, sessionId });
    assert.equal(accepted.ok, true, String(accepted.message));
  }
  await waitFor(async () => {
    const view = await manager.service.view({ collabId });
    const sessions = view.ledger?.members.map((seat) => seat.sessionId) ?? [];
    return sessions.includes('seat-b1') && sessions.includes('seat-b2') ? true : null;
  }, { timeoutMs: 10000 });
  await waitFor(() => member.service.listLocalSeats(collabId).filter((seat) => seat.state === 'member' && seat.unverified !== true).length === 2 ? true : null, { timeoutMs: 10000 });

  const ledger = (await manager.service.view({ collabId })).ledger;
  const rows = ledger.members.filter((seat) => ['seat-b1', 'seat-b2'].includes(seat.sessionId));
  assert.deepEqual(rows.map((seat) => seat.sessionId).sort(), ['seat-b1', 'seat-b2']);
  assert.equal(new Set(rows.map((seat) => seat.joinSeq)).size, 2, '两席各自分配入席序号');
  const book = readJson(invitesFilePath(manager.home, collabId));
  const record = book.invites.find((entry) => entry.inviteId === invited.inviteId);
  assert.deepEqual(record.acceptedSessions.map((entry) => entry.sessionId).sort(), ['seat-b1', 'seat-b2']);
});

test('目标会话离线：邀请落 pending-invites，核重启后仍可接受并入席', { timeout: TIMEOUT_MS }, async (t) => {
  const manager = await startSessionNode(t, { identityName: '甲机', online: ['seat-manager'] });
  /* 数据根由用例持有：首个节点关停时不能删除它，重启节点要接着用同一份盘上状态。 */
  const home = makeTempRoot(t);
  let member = await startSessionNode(t, { home, identityName: '乙机', online: ['seat-b1'] });
  linkSessionNodes(manager, member);
  await bringSessionOnline(manager, 'seat-manager');
  await bringSessionOnline(member, 'seat-b1');
  const port = member.port;

  const collabId = await createCollab(manager, member, '离线补投');
  const invited = await sendInvite(manager, collabId, member, 'seat-b2');
  const pendingFile = pendingInvitesFilePath(home, collabId);
  await waitFor(() => {
    const book = readJsonOrNull(pendingFile);
    return book?.invites?.some((entry) => entry.inviteId === invited.inviteId) ? true : null;
  }, { timeoutMs: 8000 });
  assert.equal(invitesOf(member, 'seat-b2').length, 0, '离线会话本次没有注入');

  const instanceId = member.self.instanceId;
  await closeSessionNode(member);
  await waitForRebindable(port);
  member = await startSessionNode(t, { home, port, identityName: '乙机', instanceId, online: ['seat-b1'] });
  const restored = member.service.join.pendingInvitesFor({ collabId, sessionId: 'seat-b2', inviteId: invited.inviteId });
  assert.equal(restored.length, 1, '挂起邀请随 pending-invites.json 恢复（桥注册补投的登记面）');
  assert.equal(restored[0].inviteId, invited.inviteId);

  await bringSessionOnline(member, 'seat-b1');
  /* C-1：重启后 invite-stub 不参与注册表加载，但工具面（service.approve）必须仍能接受——
   * 同意门保留：首次调用签挑战，携 confirmToken 重试才生效。 */
  const challenge = await member.service.approve({ collabId, inviteId: invited.inviteId, sessionId: 'seat-b2', approve: true });
  assert.equal(challenge.needsUserConfirmation, true, JSON.stringify(challenge));
  const accepted = await member.service.approve({
    collabId, inviteId: invited.inviteId, sessionId: 'seat-b2', approve: true, confirmToken: challenge.confirmToken,
  });
  assert.equal(accepted.ok, true, String(accepted.message));
  await waitFor(async () => {
    const view = await manager.service.view({ collabId });
    return view.ledger?.members.some((seat) => seat.sessionId === 'seat-b2') ? true : null;
  }, { timeoutMs: 10000 });
  await waitFor(() => member.service.localSeatOf(collabId, 'seat-b2')?.unverified === false ? true : null, { timeoutMs: 10000 });
});

/* —— C-1 / I-2：重启后的拒绝与撤回闭环 —— */

test('重启后拒绝邀请：service.approve(approve:false) 关闭发起侧记录且不建席', { timeout: TIMEOUT_MS }, async (t) => {
  const manager = await startSessionNode(t, { identityName: '甲机', online: ['seat-manager'] });
  const home = makeTempRoot(t);
  let member = await startSessionNode(t, { home, identityName: '乙机', online: ['seat-b1'] });
  linkSessionNodes(manager, member);
  await bringSessionOnline(manager, 'seat-manager');
  await bringSessionOnline(member, 'seat-b1');
  const port = member.port;

  const collabId = await createCollab(manager, member, '重启拒绝');
  const invited = await sendInvite(manager, collabId, member, 'seat-b2');
  await waitFor(() => {
    const book = readJsonOrNull(pendingInvitesFilePath(home, collabId));
    return book?.invites?.some((entry) => entry.inviteId === invited.inviteId) ? true : null;
  }, { timeoutMs: 8000 });

  const instanceId = member.self.instanceId;
  await closeSessionNode(member);
  await waitForRebindable(port);
  member = await startSessionNode(t, { home, port, identityName: '乙机', instanceId, online: ['seat-b1'] });
  await bringSessionOnline(member, 'seat-b1');

  const challenge = await member.service.approve({ collabId, inviteId: invited.inviteId, sessionId: 'seat-b2', approve: false, reason: '暂不参与' });
  assert.equal(challenge.needsUserConfirmation, true, JSON.stringify(challenge));
  const declined = await member.service.approve({
    collabId, inviteId: invited.inviteId, sessionId: 'seat-b2', approve: false, reason: '暂不参与', confirmToken: challenge.confirmToken,
  });
  assert.equal(declined.ok, true, String(declined.message));
  assert.equal(declined.declined, true);

  await waitFor(() => {
    const record = readJson(invitesFilePath(manager.home, collabId)).invites.find((entry) => entry.inviteId === invited.inviteId);
    return record?.state === 'closed' ? true : null;
  }, { timeoutMs: 8000 });
  assert.equal(member.service.localSeatOf(collabId, 'seat-b2'), null, '拒绝不建席');
  const roster = (await manager.service.view({ collabId })).ledger?.members ?? [];
  assert.equal(roster.some((seat) => seat.sessionId === 'seat-b2'), false, '共享名单不含被拒会话');
});

test('撤回邀请：目标端挂起记录转 withdrawn，之后不可再接受（I-2）', { timeout: TIMEOUT_MS }, async (t) => {
  const { manager, member } = await startPair(t);
  const collabId = await createCollab(manager, member, '撤回闭环');
  const invited = await sendInvite(manager, collabId, member, 'seat-b2');
  await waitInviteOrNull(member, 'seat-b2', (entry) => entry.payload?.inviteId === invited.inviteId);
  await waitFor(() => {
    const book = readJsonOrNull(pendingInvitesFilePath(member.home, collabId));
    return book?.invites?.some((entry) => entry.inviteId === invited.inviteId) ? true : null;
  }, { timeoutMs: 8000 });

  const withdrawn = await manager.service.join.withdrawInvite({ collabId, managerSessionId: 'seat-manager', inviteId: invited.inviteId });
  assert.equal(withdrawn.ok, true, String(withdrawn.message));
  await waitFor(() => {
    const record = readJson(pendingInvitesFilePath(member.home, collabId)).invites.find((entry) => entry.inviteId === invited.inviteId);
    return record?.state === 'withdrawn' ? true : null;
  }, { timeoutMs: 8000 });
  const record = readJson(invitesFilePath(manager.home, collabId)).invites.find((entry) => entry.inviteId === invited.inviteId);
  assert.equal(record.state, 'withdrawn', '发起侧记录同样关闭');

  const accepted = await member.service.join.acceptInvite({ collabId, inviteId: invited.inviteId, sessionId: 'seat-b2' });
  assert.equal(accepted.ok, false, '已撤回的邀请不可再接受');
});
