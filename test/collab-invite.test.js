import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeTempDir, pickFreePort, waitFor } from './helpers.js';
import { coreJsonPath, invitesFilePath, pendingInvitesFilePath } from '../src/paths.js';
import { createIpcClient } from '../src/core/ipc.js';
import { startCore } from '../src/core/main.js';
import { newCollabId } from '../src/collab/model.js';
/* 真核在本进程内启动：发现层读 process.env，startCore({env}) 的局部环境不覆盖它；
 * 进程级设置保证本文件起的核心不扫描/广播真实局域网（node:test 每个文件独立进程）。 */
process.env.WAYSTATION_TEST_DISABLE_DISCOVERY = '1';
import {
  bringSessionOffline,
  bringSessionOnline,
  feedSessionFrame,
  injectionTextsOf,
  injectionsOf,
  linkSessionNodes,
  startSessionNode,
  waitForInjection,
} from './helpers/session-participants.js';

/* 会话级邀请与挂起补投的判别面（0.2.0 语义）：邀请按 inviteId 簿记、指名按 targets 精确投递、
 * 点头由邀请记录校验；0.1.x 的 member.json 挂起登记与前缀短码已退役。挂起补投的现行形态是
 * 席位暂存（桥离线时帧进该席暂存，同会话重连按到达序补投）。夹具复用进程内双节点装配
 * （真 service / dispatch / transport / inbound，仅桥投递为记录面），逐用例走真实链路：
 * create → createInvite → acceptInvite → join-grant → join-confirm → 名单/席位收敛。 */

const GHOST = { instanceId: 'inst-ghost', identityName: '幽灵机', address: '127.0.0.1', port: 1 };
const MANAGER_SESSION = 'seat-manager';

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function inviteFramesOf(node, sessionId) {
  return injectionsOf(node, sessionId).filter((entry) => entry.type === 'invite');
}

async function waitInviteFrame(node, sessionId, inviteId) {
  await waitForInjection(node, sessionId, (list) => list.some((entry) => entry.type === 'invite'
    && entry.payload?.inviteId === inviteId));
  return inviteFramesOf(node, sessionId).find((entry) => entry.payload?.inviteId === inviteId);
}

/* 双节点：站长机甲、成员机乙；乙的在线会话按用例给（离线目标不注册桥）。 */
async function startPair(t, memberSessions = ['seat-b1', 'seat-b2']) {
  const manager = await startSessionNode(t, { identityName: '甲机', online: [MANAGER_SESSION] });
  const member = await startSessionNode(t, { identityName: '乙机', online: memberSessions });
  linkSessionNodes(manager, member);
  await bringSessionOnline(manager, MANAGER_SESSION);
  for (const sessionId of memberSessions) {
    await bringSessionOnline(member, sessionId);
  }
  return { manager, member };
}

/* 建协作时不把成员机放进首邀目标：首邀走旧发送面（无 inviteId），本文件判别的指名/挂起
 * 邀请由加入域的 createInvite 单独签发。 */
async function createManaged(manager, name = '指名项目') {
  const created = await manager.service.create({
    name,
    topic: `${name} 主题`,
    targets: [GHOST],
    mode: 'managed',
    sessionId: MANAGER_SESSION,
  });
  assert.equal(created.ok, true, String(created.message));
  return created.collabId;
}

async function inviteMember(manager, member, collabId, targetSessionId) {
  const invited = await manager.service.join.createInvite({
    collabId,
    managerSessionId: MANAGER_SESSION,
    targetInstanceId: member.self.instanceId,
    ...(targetSessionId === undefined ? {} : { targetSessionId }),
  });
  assert.equal(invited.ok, true, String(invited.message));
  return invited;
}

/* 受邀会话接受并按真实两段式收敛到 member（join-grant → join-confirm → 快照清 unverified）。 */
async function acceptAndSettle(member, collabId, inviteId, sessionId) {
  const accepted = await member.service.join.acceptInvite({ collabId, inviteId, sessionId });
  assert.equal(accepted.ok, true, String(accepted.message));
  await waitFor(() => {
    const seat = member.service.localSeatOf(collabId, sessionId);
    return seat?.state === 'member' && seat?.unverified === false ? true : null;
  }, { timeoutMs: 8000 });
  return member.service.localSeatOf(collabId, sessionId);
}

async function ledgerOf(manager, collabId) {
  const viewed = await manager.service.view({ collabId });
  assert.equal(viewed.ok, true, String(viewed.message));
  return viewed.ledger;
}

test('指名邀请：只投目标会话的桥，非目标零注入；帧携 inviteId / targets / from.sessionId；目标机落挂起簿记', async (t) => {
  const { manager, member } = await startPair(t);
  const collabId = await createManaged(manager);
  const invited = await inviteMember(manager, member, collabId, 'seat-b2');
  const arrived = await waitInviteFrame(member, 'seat-b2', invited.inviteId);

  assert.equal(inviteFramesOf(member, 'seat-b1').length, 0, '非指名会话不投（不广播、不猜接收者）');
  assert.equal(arrived.frame.from.sessionId, MANAGER_SESSION, '邀请帧必须携发件席位');
  assert.deepEqual(arrived.payload.targets, [{ instanceId: member.self.instanceId, targetSessionId: 'seat-b2' }], 'targets 描述目标机器与指名会话');
  assert.ok(arrived.payload.members.some((seat) => seat.sessionId === MANAGER_SESSION), 'members 按席位键携带发起人');
  assert.equal(arrived.payload.members.some((seat) => seat.sessionId === 'seat-b2'), false, '受邀未入席者不在 members 内');

  const book = readJson(invitesFilePath(manager.home, collabId));
  const record = book.invites.find((entry) => entry.inviteId === invited.inviteId);
  assert.equal(record.state, 'open', '站长侧邀请簿记登记 open 记录');
  assert.deepEqual(record.targets, [{ instanceId: member.self.instanceId, targetSessionId: 'seat-b2' }]);
  const pending = readJson(pendingInvitesFilePath(member.home, collabId));
  assert.ok(pending.invites.some((entry) => entry.inviteId === invited.inviteId && entry.targetSessionId === 'seat-b2'), '目标机挂起邀请落独立簿记');
});

test('短码精确匹配：8 位短码歧义拒绝、非短码前缀不展开；都不猜接收者', async (t) => {
  const { manager, member } = await startPair(t, ['sess-abcd-target', 'sess-abcd-other']);
  const collabId = await createManaged(manager);

  const prefixed = await inviteMember(manager, member, collabId, 'sess-abcd');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(inviteFramesOf(member, 'sess-abcd-target').length, 0, '9 位前缀不是短码：不按前缀展开投递');
  assert.equal(inviteFramesOf(member, 'sess-abcd-other').length, 0);
  const pending = member.service.join.pendingInvitesFor({ collabId, sessionId: 'sess-abcd', inviteId: prefixed.inviteId });
  assert.equal(pending.length, 1, '未命中的完整 token 原样挂起（等待同名会话，不猜）');

  const ambiguous = await inviteMember(manager, member, collabId, 'sess-abc');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(inviteFramesOf(member, 'sess-abcd-target').length, 0, '歧义短码不投任一命中会话');
  assert.equal(inviteFramesOf(member, 'sess-abcd-other').length, 0);
  assert.deepEqual(member.service.join.pendingInvitesFor({ collabId, sessionId: 'sess-abcd-target', inviteId: ambiguous.inviteId }), [], '歧义短码不登记挂起（不回落原 token）');
});

test('目标会话离线：只登记 pending-invites 与 invite-stub 载体，不投任何桥', async (t) => {
  const { manager, member } = await startPair(t, ['seat-b1']);
  const collabId = await createManaged(manager);
  const invited = await inviteMember(manager, member, collabId, 'seat-b2');

  await waitFor(() => member.service.join.pendingInvitesFor({ collabId, sessionId: 'seat-b2', inviteId: invited.inviteId }).length === 1 ? true : null);
  assert.equal(inviteFramesOf(member, 'seat-b1').length, 0, '同机其他在线会话不得代收指名邀请');
  assert.equal(inviteFramesOf(member, 'seat-b2').length, 0, '离线目标本次没有注入');
  const record = member.service.join.pendingInvitesFor({ collabId, sessionId: 'seat-b2', inviteId: invited.inviteId })[0];
  assert.equal(record.targetSessionId, 'seat-b2', '指名随挂起记录定格');
  assert.equal(record.fromManager.sessionId, MANAGER_SESSION, '邀请来源席位随记录留存');
  const carrier = readJson(join(member.home, 'collabs', collabId, 'carrier.json'));
  assert.equal(carrier.format, 'invite-stub', '仅挂起邀请的目录标记为邀请占位，不写台账');
  assert.equal(existsSync(join(member.home, 'collabs', collabId, 'ledger.jsonl')), false);
});

test('席位暂存补投（D11）：桥离线时帧进暂存，同会话重连按到达序补投且只投一次', async (t) => {
  const { manager, member } = await startPair(t, ['seat-b1']);
  const collabId = await createManaged(manager);
  const invited = await inviteMember(manager, member, collabId, 'seat-b1');
  await waitInviteFrame(member, 'seat-b1', invited.inviteId);
  await acceptAndSettle(member, collabId, invited.inviteId, 'seat-b1');
  assert.equal((await member.service.setMute({ collabId, sessionId: 'seat-b1', muted: false })).ok, true);
  await bringSessionOffline(member, 'seat-b1');

  const first = await manager.service.send({ collabId, text: '离线期间事项一', sessionId: MANAGER_SESSION });
  const second = await manager.service.send({ collabId, text: '离线期间事项二', sessionId: MANAGER_SESSION });
  assert.equal(first.ok, true, String(first.message));
  assert.equal(second.ok, true, String(second.message));
  const msgId = first.results[0].msgId;
  const tierOf = () => manager.dispatch.deliveryStatus({ msgId })[0]?.tier;
  await waitFor(() => member.service.localSeatDeliveryOf(msgId, 'seat-b1').status === 'staged' ? true : null);
  await waitFor(() => tierOf() === 'session' ? true : null);
  assert.equal(injectionTextsOf(member, 'seat-b1').includes('离线期间事项一'), false, '桥离线：不注入，先进暂存');

  await bringSessionOnline(member, 'seat-b1');
  await waitFor(() => injectionTextsOf(member, 'seat-b1').includes('离线期间事项二') ? true : null);
  const texts = injectionTextsOf(member, 'seat-b1').filter((text) => text.startsWith('离线期间事项'));
  assert.deepEqual(texts, ['离线期间事项一', '离线期间事项二'], '补投按到达序，不越队');
  assert.equal(member.service.localSeatDeliveryOf(msgId, 'seat-b1').status, 'injected', '补投后席位明细转已注入');
  assert.equal(tierOf(), 'session', '机器级终态在暂存时已成立（D11 边界）');
});

test('挂起邀请簿记与成员记录分离：无关入站帧的端点学习不抹掉挂起邀请', async (t) => {
  const { manager, member } = await startPair(t, ['seat-b1']);
  const collabId = await createManaged(manager);
  const invited = await inviteMember(manager, member, collabId, 'seat-b2');
  await waitFor(() => member.service.join.pendingInvitesFor({ collabId, sessionId: 'seat-b2' }).length === 1 ? true : null);

  const touched = {
    v: 1,
    cap: 2,
    type: 'reply',
    msgId: `msg-touch-${randomUUID()}`,
    collabId,
    from: { instanceId: manager.self.instanceId, sessionId: MANAGER_SESSION, identityName: '甲机', port: manager.port + 1 },
    ts: new Date().toISOString(),
    payload: { text: '旁路帧' },
  };
  const acks = await feedSessionFrame(member, touched);
  assert.equal(acks.length, 1, '旁路帧过准入并回 ack（端点学习触发成员记录整写）');
  const memberFile = readJson(join(member.home, 'collabs', collabId, 'member.json'));
  assert.equal(memberFile.endpoints[manager.self.instanceId].port, manager.port + 1, '端点已学得（整写确实发生）');
  assert.equal(member.service.join.pendingInvitesFor({ collabId, sessionId: 'seat-b2', inviteId: invited.inviteId }).length, 1, '整写后挂起邀请仍在（独立文件不被成员记录覆盖）');
});

test('指名点头：只有目标会话能接受；异会话与无会话标识一律拒且不产生席位', async (t) => {
  const { manager, member } = await startPair(t);
  const collabId = await createManaged(manager);
  const invited = await inviteMember(manager, member, collabId, 'seat-b2');
  await waitInviteFrame(member, 'seat-b2', invited.inviteId);

  const wrong = await member.service.join.acceptInvite({ collabId, inviteId: invited.inviteId, sessionId: 'seat-b1' });
  assert.equal(wrong.ok, false, '异会话接受：拒');
  assert.match(wrong.message, /不属于本会话/, '如实说明邀请与哪个会话匹配');
  const sessionless = await member.service.join.acceptInvite({ collabId, inviteId: invited.inviteId });
  assert.equal(sessionless.ok, false, '无会话标识：无从核对指名，拒');

  const seat = await acceptAndSettle(member, collabId, invited.inviteId, 'seat-b2');
  assert.equal(seat.joinSeq, 2);
  assert.equal(member.service.localSeatOf(collabId, 'seat-b1'), null, '异会话没有席位');
  const ledger = await ledgerOf(manager, collabId);
  assert.deepEqual(ledger.members.map((row) => row.sessionId), [MANAGER_SESSION, 'seat-b2'], '共享名单只含同意会话');
});

test('不指名邀请：同机两会话各自成席；讨论无邀请簿记、不生成 inviteId', async (t) => {
  const { manager, member } = await startPair(t);
  const collabId = await createManaged(manager);
  const invited = await inviteMember(manager, member, collabId);
  await waitInviteFrame(member, 'seat-b1', invited.inviteId);
  await waitInviteFrame(member, 'seat-b2', invited.inviteId);

  for (const sessionId of ['seat-b1', 'seat-b2']) {
    await acceptAndSettle(member, collabId, invited.inviteId, sessionId);
  }
  const ledger = await ledgerOf(manager, collabId);
  const rows = ledger.members.filter((row) => ['seat-b1', 'seat-b2'].includes(row.sessionId));
  assert.deepEqual(rows.map((row) => row.sessionId).sort(), ['seat-b1', 'seat-b2'], '两个会话各自成席');
  assert.equal(new Set(rows.map((row) => row.joinSeq)).size, 2, '各席分配独立入席序号');

  const forum = await manager.service.create({
    name: '探讨', topic: '议题', targets: [GHOST], mode: 'forum', sessionId: MANAGER_SESSION,
  });
  assert.equal(forum.ok, true, String(forum.message));
  const refused = await manager.service.join.createInvite({
    collabId: forum.collabId, managerSessionId: MANAGER_SESSION, targetInstanceId: member.self.instanceId,
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'forum-no-invite', '讨论不生成、不返回 inviteId（D18）');
});

test('退役：挂起邀请的投出失败重置 / 非目标注册 / 过期处置（0.1.x member.json 登记面）', { skip: '0.1.x 的 member.json pendingInvites 生命周期已退役；替代覆盖：test/collab-join-wiring.test.js「pending-invites：过期/未知/形态坏一律拒」「pending-invites：登记/补投匹配」与 test/collab-service-seats.test.js「暂存上限丢最旧」' }, () => {});

test('退役：挂起补投的并发写回合并（0.1.x 路由面读改写）', { skip: '0.1.x 桥注册补投的读改写合并已退役；0.2.0 补投改按席位暂存顺序收敛；替代覆盖：test/collab-service-seats.test.js「补投进行中新帧入队尾」与「暂存上限丢最旧」' }, () => {});

/* —— 真核装配：组合根桥注册面与接收管线 —— */

function bridgeClientFor(home, record, { bridgeId, sessionId }) {
  const frames = [];
  const client = createIpcClient({
    dataDir: home,
    hello: { app: record.appVersion, token: record.token, bridgeId, sessionId },
    onFrame: (frame) => {
      frames.push(frame);
      if (frame.type === 'push') {
        client.send({ type: 'delivered', pushId: frame.pushId, ok: true });
      }
    },
    onClose: () => {},
  });
  return { client, frames };
}

function namedInviteFrame(collabId, inviteId, targetInstanceId, targetSessionId, name = '真核项目') {
  return {
    v: 1,
    cap: 2,
    type: 'invite',
    msgId: `msg-${randomUUID()}`,
    from: { instanceId: 'inst-peer', sessionId: 'session-peer', identityName: '对端', port: 17400 },
    collabId,
    ts: new Date().toISOString(),
    payload: {
      name,
      topic: '主题',
      mode: 'managed',
      inviteId,
      targets: [{ instanceId: targetInstanceId, targetSessionId }],
      members: [{ instanceId: 'inst-peer', sessionId: 'session-peer', identityName: '对端' }],
    },
  };
}

/* 真 TCP 探针：一行协作域帧走完整接收管线（准入 → 落盘 → 消费 → 扇出）。 */
function sendInboundFrame(port, frame) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(`${JSON.stringify(frame)}\n`);
    });
    socket.once('error', () => resolve(false));
    socket.once('data', () => {
      socket.end();
      resolve(true);
    });
    socket.setTimeout(4000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

test('真核装配：指名邀请投到目标桥、旁观桥零投；离线目标只落挂起；异会话接受被拒', { timeout: 90000 }, async (t) => {
  const home = makeTempDir(t);
  const port = await pickFreePort();
  writeFileSync(join(home, 'config.json'), JSON.stringify({ port, identityName: '本机' }, null, 2));
  const started = await startCore({ env: { ...process.env, WAYSTATION_HOME: home, WAYSTATION_TEST_DISABLE_DISCOVERY: '1' } });
  assert.equal(started.ok, true, started.message ?? '核心启动');
  t.after(() => started.core.stop());
  assert.deepEqual((await started.core.net.listHosts()).hosts, [], '发现隔离闸生效：扫描不出网');
  const record = JSON.parse(readFileSync(coreJsonPath(home), 'utf8'));
  const selfId = record.identity.instanceId;

  const watcher = bridgeClientFor(home, record, { bridgeId: 'bridge-w', sessionId: 'session-watch' });
  const target = bridgeClientFor(home, record, { bridgeId: 'bridge-t', sessionId: 'session-target' });
  t.after(() => watcher.client.close());
  t.after(() => target.client.close());
  await watcher.client.connect();
  await target.client.connect();

  const collabId = newCollabId();
  const inviteId = `inv-${randomUUID()}`;
  assert.equal(await sendInboundFrame(port, namedInviteFrame(collabId, inviteId, selfId, 'session-target')), true, '邀请经真接收管线受理（ack 回程）');
  await waitFor(() => target.frames.some((frame) => frame.type === 'push' && frame.collabId === collabId) ? true : null, { timeoutMs: 15000 });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(watcher.frames.some((frame) => frame.type === 'push'), false, '旁观会话不投');
  const pendingFile = pendingInvitesFilePath(home, collabId);
  await waitFor(() => existsSync(pendingFile) && readJson(pendingFile).invites
    .some((entry) => entry.inviteId === inviteId) ? true : null, { timeoutMs: 10000 });

  const offlineCollabId = newCollabId();
  const offlineId = `inv-${randomUUID()}`;
  await new Promise((resolve) => setTimeout(resolve, 1100));   // 同源邀请限频 1s
  assert.equal(await sendInboundFrame(port, namedInviteFrame(offlineCollabId, offlineId, selfId, 'session-offline', '真核离线项目')), true);
  const offlinePending = pendingInvitesFilePath(home, offlineCollabId);
  await waitFor(() => existsSync(offlinePending) && readJson(offlinePending).invites
    .some((entry) => entry.targetSessionId === 'session-offline') ? true : null, { timeoutMs: 10000 });
  assert.equal(target.frames.some((frame) => frame.type === 'push' && frame.collabId === offlineCollabId), false, '离线目标不投任何桥');

  const wrong = await started.core.context.collab.join.acceptInvite({ collabId, inviteId, sessionId: 'session-watch' });
  assert.equal(wrong.ok, false, '异会话接受：拒（邀请记录按指名会话校验）');
  assert.match(wrong.message, /不属于本会话/);
});
