import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { invitesFilePath } from '../src/paths.js';
import { createCollabService } from '../src/collab/service.js';
import {
  bringSessionOnline,
  injectionsOf,
  linkSessionNodes,
  sessionNodeConfig,
  startSessionNode,
  targetOf,
  waitForInjection,
} from './helpers/session-participants.js';
import { makeTempDir, waitFor } from './helpers.js';

/* 既有协作的 ws_invite 邀请簿记（设计 §4.1/§4.4）：managed 增邀必须与建协首邀走同一条两段式
 * 链路——帧携 inviteId、站长机 invites.json 有 open 记录、目标机登记挂起邀请，受邀会话才能用
 * ws_approve_invite（acceptInvite）入席；发送失败撤回记录，不留可接受的 open 记录。
 * 同名冲突检测的候选面必须并入邀请目标（events.js 收到邀请时的目标机器），否则被邀成员侧
 * 检不出与既有协作的参与者交集，冻结不会发生。
 * 长操作声明：多节点用例走真实回环 TCP，通常 < 30s，单用例超时上限 90s。 */

const TIMEOUT_MS = 90000;

const SELF = { instanceId: 'inst-self', identityName: '本机', port: 7321 };
const REMOTE_B = { instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.2', port: 17321 };
const REMOTE_C = { instanceId: 'inst-c', identityName: '主机丙', address: '127.0.0.3', port: 17322 };
const REMOTE_D = { instanceId: 'inst-d', identityName: '主机丁', address: '127.0.0.4', port: 17323 };
const MANAGER_SESSION = 'seat-manager';

function quietLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function invitesBookOf(home, collabId) {
  const file = invitesFilePath(home, collabId);
  return existsSync(file) ? readJson(file) : null;
}

/* 进程内服务夹具：真实 service，发送面可切换成败（建协首邀成功后再让增邀失败）。 */
function makeService(t) {
  const dir = makeTempDir(t);
  const sent = [];
  let failInvites = false;
  const service = createCollabService({
    dataDir: dir,
    config: sessionNodeConfig({ inviteTtlMs: 120000 }),
    self: SELF,
    send: (message) => {
      sent.push(message);
      if (failInvites && message.type === 'invite') {
        return { ok: false, reason: '模拟入队失败' };
      }
      return { ok: true, msgId: `msg-${sent.length}` };
    },
    sendDirect: (message) => {
      sent.push(message);
      return { ok: true, msgId: `direct-${sent.length}` };
    },
    knownHosts: { remember: () => {}, lookup: () => undefined },
    notify: () => true,
    deliverSeat: () => true,
    log: quietLog(),
    syncPeerPicker: () => [],
    inviteMinIntervalMs: 0,
  });
  return {
    dir,
    service,
    sent,
    failInvites: (value) => {
      failInvites = value;
    },
  };
}

async function startTriad(t) {
  const manager = await startSessionNode(t, { identityName: '甲机', online: ['seat-manager'] });
  const member = await startSessionNode(t, { identityName: '乙机', online: ['seat-b1'] });
  const target = await startSessionNode(t, { identityName: '丙机', online: ['seat-c1'] });
  linkSessionNodes(manager, member);
  linkSessionNodes(manager, target);
  linkSessionNodes(member, target);
  await bringSessionOnline(manager, 'seat-manager');
  await bringSessionOnline(member, 'seat-b1');
  await bringSessionOnline(target, 'seat-c1');
  return { manager, member, target };
}

async function createTargeting(manager, targetNode, name) {
  const created = await manager.service.create({
    name,
    topic: `${name} 主题`,
    targets: [targetOf(targetNode)],
    mode: 'managed',
    sessionId: MANAGER_SESSION,
  });
  assert.equal(created.ok, true, String(created.message));
  assert.equal(created.invited[0].ok, true, String(created.invited[0].reason));
  return created;
}

async function acceptInitialInvite(manager, member, created, sessionId) {
  const inviteId = created.invited[0].inviteId;
  assert.match(String(inviteId), /^inv-/, '首邀携 inviteId');
  await waitForInjection(
    member,
    sessionId,
    (list) => list.find((item) => item.type === 'invite' && item.payload?.inviteId === inviteId) ?? null,
    { timeoutMs: 8000 },
  );
  const accepted = await member.service.join.acceptInvite({ collabId: created.collabId, inviteId, sessionId });
  assert.equal(accepted.ok, true, String(accepted.message));
  await waitFor(async () => {
    const view = await manager.service.view({ collabId: created.collabId });
    return view.ledger?.members.some((seat) => seat.sessionId === sessionId) ? true : null;
  }, { timeoutMs: 10000 });
}

function assertSentInviteBooked(made, created, entry) {
  const frame = made.sent.find((message) => message.type === 'invite' && message.to?.instanceId === REMOTE_C.instanceId);
  assert.ok(frame !== undefined, '邀请帧照常发出');
  assert.equal(frame.payload.inviteId, entry.inviteId, '邀请载荷携同一 inviteId');
  const record = invitesBookOf(made.dir, created.collabId).invites.find((row) => row.inviteId === entry.inviteId);
  assert.ok(record !== undefined, 'invites.json 登记增邀记录');
  assert.equal(record.state, 'open');
  assert.deepEqual(record.targets, [{ instanceId: REMOTE_C.instanceId }]);
}

async function assertUnsentInviteWithdrawn(made, created) {
  const failed = await made.service.invite({
    collabId: created.collabId,
    targets: [REMOTE_D],
    sessionId: MANAGER_SESSION,
  });
  assert.equal(failed.ok, true, String(failed.message), '单目标失败不吞已发出的事实');
  assert.equal(failed.invited[0].ok, false, '发送失败如实回报');
  assert.match(String(failed.invited[0].reason), /模拟入队失败/);
  const failedId = failed.invited[0].inviteId;
  assert.match(String(failedId), /^inv-/, '失败条目仍可追溯尝试过的邀请键');
  const book = invitesBookOf(made.dir, created.collabId);
  assert.equal(book.invites.find((row) => row.inviteId === failedId).state, 'withdrawn', '发送失败撤回记录');
  assert.deepEqual(
    book.invites.filter((row) => row.state === 'open' && row.targets.some((target) => target.instanceId === REMOTE_D.instanceId)),
    [],
    '发送失败不得留下可接受的 open 记录',
  );
}

test('既有协作增邀：managed 逐目标开邀请记录、帧携 inviteId，发送失败撤回记录', { timeout: TIMEOUT_MS }, async (t) => {
  const made = makeService(t);
  const created = made.service.create({
    name: '既有协作增邀',
    topic: '既有协作增邀主题',
    targets: [REMOTE_B],
    mode: 'managed',
    sessionId: MANAGER_SESSION,
  });
  assert.equal(created.ok, true, String(created.message));
  assert.match(String(created.invited[0].inviteId), /^inv-/, '建协首邀已有簿记前置');

  const invited = await made.service.invite({
    collabId: created.collabId,
    targets: [REMOTE_C],
    sessionId: MANAGER_SESSION,
  });
  assert.equal(invited.ok, true, String(invited.message));
  const entry = invited.invited[0];
  assert.equal(entry.ok, true, String(entry.reason));
  assert.match(String(entry.inviteId), /^inv-/, '既有协作增邀必须生成 inviteId（两段式同意的校验键）');
  assert.equal(typeof entry.expiresAt, 'number', '返回条目携有效期');
  assertSentInviteBooked(made, created, entry);

  made.failInvites(true);
  await assertUnsentInviteWithdrawn(made, created);
});

/* 目标机侧闭环：邀请到达 + 挂起登记 + acceptInvite 两段式 + 站长簿记登记已接受。 */
async function acceptInvitedTarget(manager, target, created, inviteId) {
  const arrived = await waitForInjection(
    target,
    'seat-c1',
    (list) => list.find((item) => item.type === 'invite' && item.payload?.inviteId === inviteId) ?? null,
    { timeoutMs: 8000 },
  );
  assert.equal(arrived.frame.from.sessionId, MANAGER_SESSION, '增邀由站长席位签发');
  const pending = await waitFor(() => (
    target.service.join.pendingInvitesFor({ collabId: created.collabId, sessionId: 'seat-c1', inviteId }).length === 1
      ? true
      : null
  ), { timeoutMs: 8000 });
  assert.equal(pending, true, '目标机挂起邀请登记（补投与同意门的校验键）');
  assert.equal(injectionsOf(target, 'seat-c1').some((item) => item.type === 'invite'), true);

  const accepted = await target.service.join.acceptInvite({ collabId: created.collabId, inviteId, sessionId: 'seat-c1' });
  assert.equal(accepted.ok, true, String(accepted.message));
  assert.equal(accepted.inviteId, inviteId);
  await waitFor(async () => {
    const view = await manager.service.view({ collabId: created.collabId });
    const sessions = view.ledger?.members.map((seat) => seat.sessionId) ?? [];
    return sessions.includes('seat-b1') && sessions.includes('seat-c1') ? true : null;
  }, { timeoutMs: 10000 });
  const record = invitesBookOf(manager.home, created.collabId).invites.find((row) => row.inviteId === inviteId);
  assert.deepEqual(
    record.acceptedSessions,
    [{ instanceId: target.self.instanceId, sessionId: 'seat-c1' }],
    '成席后登记已接受',
  );
}

test('既有协作增邀：目标机挂起登记，acceptInvite(inviteId) 经两段式成席', { timeout: TIMEOUT_MS }, async (t) => {
  const { manager, member, target } = await startTriad(t);
  const created = await createTargeting(manager, member, '既有协作增邀入席');
  await acceptInitialInvite(manager, member, created, 'seat-b1');

  const invited = await manager.service.invite({
    collabId: created.collabId,
    targets: [targetOf(target)],
    sessionId: MANAGER_SESSION,
  });
  assert.equal(invited.ok, true, String(invited.message));
  const entry = invited.invited[0];
  assert.equal(entry.ok, true, String(entry.reason));
  assert.match(String(entry.inviteId), /^inv-/);
  await acceptInvitedTarget(manager, target, created, entry.inviteId);
});

test('同名冲突：邀请目标并入候选面，被邀成员冻结并传播到双方', { timeout: TIMEOUT_MS }, async (t) => {
  const { manager, member, target } = await startTriad(t);
  const first = await createTargeting(manager, member, '重名项目');
  await acceptInitialInvite(manager, member, first, 'seat-b1');

  const rival = await managerAgnosticCreate(target, member, '重名项目');
  assert.notEqual(rival.collabId, first.collabId, '同名不同协作');
  assert.equal(rival.invited[0].ok, true, String(rival.invited[0].reason));

  await waitFor(() => {
    const listed = member.service.list().collabs;
    const firstEntry = listed.find((entry) => entry.collabId === first.collabId);
    const rivalEntry = listed.find((entry) => entry.collabId === rival.collabId);
    return firstEntry?.state === 'frozen' && rivalEntry?.state === 'frozen' ? true : null;
  }, { timeoutMs: 15000 });
  await waitFor(() => manager.service.list().collabs.find((entry) => entry.collabId === first.collabId)?.state === 'frozen' ? true : null, { timeoutMs: 15000 });
  await waitFor(() => target.service.list().collabs.find((entry) => entry.collabId === rival.collabId)?.state === 'frozen' ? true : null, { timeoutMs: 15000 });
  assert.ok(member.service.stats().freezeDetected >= 1, '被邀成员侧检出冲突');
});

test('讨论发帖：发送席位必须显式且为本机活跃席位，拒绝时不产生帧', { timeout: TIMEOUT_MS }, async (t) => {
  const made = makeService(t);
  const created = made.service.create({
    name: '讨论发帖席位',
    topic: '讨论发帖席位主题',
    targets: [REMOTE_B],
    mode: 'forum',
    sessionId: MANAGER_SESSION,
  });
  assert.equal(created.ok, true, String(created.message));
  made.sent.length = 0;

  const anonymous = await made.service.send({ collabId: created.collabId, text: '没有会话标识' });
  assert.equal(anonymous.ok, false, '缺少发送会话必须拒绝（不得误报中继降级）');
  assert.match(String(anonymous.message), /缺少发送会话标识/);
  assert.equal(made.sent.some((message) => message.type === 'post'), false, '拒绝时不产生帖帧');

  const impersonated = await made.service.send({ collabId: created.collabId, text: '冒名会话', sessionId: 'seat-x' });
  assert.equal(impersonated.ok, false, '非本机席位不得代为发帖');
  assert.match(String(impersonated.message), /不在本机席位表|非本机成员|尚未加入该讨论/);
  assert.equal(made.sent.some((message) => message.type === 'post'), false, '冒名拒绝同样不产生帧');
  const view = await made.service.view({ collabId: created.collabId });
  assert.deepEqual(view.posts, [], '拒绝不得在本地帖列表留下半写条目');

  const accepted = await made.service.send({ collabId: created.collabId, text: '合法席位发言', sessionId: MANAGER_SESSION });
  assert.equal(accepted.ok, true, String(accepted.message));
  assert.equal(typeof accepted.postId, 'string', '合法席位照常发帖');
  assert.equal(accepted.route, 'fanout', '本机即中继时直接扇出');
});

/* 丙机建同名协作（目标＝乙机）：与既有协作同路径，只是换发起方。 */
async function managerAgnosticCreate(node, targetNode, name) {
  const created = await node.service.create({
    name,
    topic: `${name} 主题（丙）`,
    targets: [targetOf(targetNode)],
    mode: 'managed',
    sessionId: 'seat-c1',
  });
  assert.equal(created.ok, true, String(created.message));
  return created;
}
