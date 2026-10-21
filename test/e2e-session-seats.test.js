import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  bringSessionOnline,
  feedSessionFrame,
  injectionTextsOf,
  linkSessionNodes,
  seedSessionCollab,
  startSessionNode,
  waitForInjection,
} from './helpers/session-participants.js';

/* 同机双席（真实回环网络链路）：一台机器上的两个会话各自收发、互不串席；
 * 跨机一帧按 toSessions 在本机扇出；定向 toSessionId 只投目标席位。
 * 长操作声明：本文件启动两个进程内节点（真实 TCP 帧链路）并等待消息收敛，通常 < 15s；
 * 单用例超时上限 60s，禁止无界等待。 */

const COLLAB_ID = 'collab-same-machine';
const TIMEOUT_MS = 60000;
const MANAGER_INSTANCE = 'inst-manager-machine';
const MEMBER_INSTANCE = 'inst-member-machine';
const MEMBER_SEATS = ['seat-peer-a', 'seat-peer-b'];

const ROSTER = [
  { instanceId: MANAGER_INSTANCE, sessionId: 'seat-manager', identityName: '甲机', role: 'manager', joinSeq: 1 },
  { instanceId: MANAGER_INSTANCE, sessionId: 'seat-helper', identityName: '甲机', role: 'member', joinSeq: 2 },
  { instanceId: MEMBER_INSTANCE, sessionId: 'seat-peer-a', identityName: '乙机', role: 'member', joinSeq: 3 },
  { instanceId: MEMBER_INSTANCE, sessionId: 'seat-peer-b', identityName: '乙机', role: 'member', joinSeq: 4 },
];

function seedManagerNode(home) {
  seedSessionCollab(home, COLLAB_ID, {
    name: '同机双席',
    managerTerm: 1,
    version: 2,
    manager: { instanceId: MANAGER_INSTANCE, sessionId: 'seat-manager', identityName: '甲机' },
    members: ROSTER,
    seats: [
      { sessionId: 'seat-manager', role: 'manager', joinSeq: 1 },
      { sessionId: 'seat-helper', role: 'member', joinSeq: 2 },
    ],
  });
}

function seedMemberNode(home) {
  seedSessionCollab(home, COLLAB_ID, {
    name: '同机双席',
    managerTerm: 1,
    version: 2,
    manager: { instanceId: MANAGER_INSTANCE, sessionId: 'seat-manager', identityName: '甲机' },
    members: ROSTER,
    snapshotFrom: MANAGER_INSTANCE,
    endpoints: {},
    seats: [
      { sessionId: 'seat-peer-a', role: 'member', joinSeq: 3 },
      { sessionId: 'seat-peer-b', role: 'member', joinSeq: 4 },
    ],
    member: {
      collabId: COLLAB_ID,
      name: '同机双席',
      topic: '同机双席 主题',
      role: 'member',
      state: 'active',
      manager: { instanceId: MANAGER_INSTANCE, sessionId: 'seat-manager', identityName: '甲机' },
      endpoints: {},
      roster: ROSTER,
      mode: 'managed',
      decision: 'approved',
    },
  });
}

async function readLedger(node, collabId) {
  const viewed = await node.service.view({ collabId });
  assert.equal(viewed.ok, true, String(viewed.message));
  return viewed.ledger;
}

async function startDuo(t) {
  const manager = await startSessionNode(t, {
    instanceId: MANAGER_INSTANCE,
    identityName: '甲机',
    seed: seedManagerNode,
    online: ['seat-manager', 'seat-helper'],
  });
  const member = await startSessionNode(t, {
    instanceId: MEMBER_INSTANCE,
    identityName: '乙机',
    seed: seedMemberNode,
    online: MEMBER_SEATS,
  });
  linkSessionNodes(manager, member);
  await bringSessionOnline(manager, 'seat-manager');
  await bringSessionOnline(manager, 'seat-helper');
  for (const sessionId of MEMBER_SEATS) {
    await bringSessionOnline(member, sessionId);
  }
  return { manager, member };
}

test('同机双席：站长发往成员机的一帧携全部目标席位并在本机扇出', { timeout: TIMEOUT_MS }, async (t) => {
  const { manager, member } = await startDuo(t);
  const sent = await manager.service.send({ collabId: COLLAB_ID, text: '全员通告', sessionId: 'seat-manager' });
  assert.equal(sent.ok, true, String(sent.message));
  await waitForInjection(member, 'seat-peer-a', (list) => list.some((entry) => entry.payload?.text === '全员通告'));
  await waitForInjection(member, 'seat-peer-b', (list) => list.some((entry) => entry.payload?.text === '全员通告'));
  const messageFrames = manager.sentFrames.filter((frame) => frame.type === 'reply');
  assert.equal(messageFrames.length, 1, '同一台机器只发一帧（按机器分组）');
  assert.deepEqual(messageFrames[0].toSessions, [...MEMBER_SEATS], '一帧携目标机全部活跃席位');
});

test('同机双席：入站一帧携 toSessions 本机扇出，定向集合只投所列席位', { timeout: TIMEOUT_MS }, async (t) => {
  const { manager, member } = await startDuo(t);
  const broadcast = wireReply(member, ['seat-manager', 'seat-helper'], '一帧双席');
  await feedSessionFrame(manager, broadcast);
  await waitForInjection(manager, 'seat-manager', (list) => list.some((entry) => entry.payload?.text === '一帧双席'));
  await waitForInjection(manager, 'seat-helper', (list) => list.some((entry) => entry.payload?.text === '一帧双席'));

  const directed = wireReply(member, ['seat-helper'], '定向助手席');
  await feedSessionFrame(manager, directed);
  await waitForInjection(manager, 'seat-helper', (list) => list.some((entry) => entry.payload?.text === '定向助手席'));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(injectionTextsOf(manager, 'seat-manager').includes('定向助手席'), false, '不在 toSessions 的席位不投');
});

function wireReply(sender, toSessions, text) {
  return {
    v: 1,
    cap: 2,
    type: 'reply',
    msgId: randomUUID(),
    collabId: COLLAB_ID,
    from: { instanceId: sender.self.instanceId, sessionId: 'seat-peer-a', identityName: sender.self.identityName, port: sender.port },
    ts: new Date().toISOString(),
    payload: { text },
    toSessions,
  };
}

test('同机双席：定向 toSessionId 只投目标席，另一席不串收', { timeout: TIMEOUT_MS }, async (t) => {
  const { manager, member } = await startDuo(t);
  const sent = await manager.service.send({ collabId: COLLAB_ID, text: '只给乙席', to: MEMBER_INSTANCE, toSessionId: 'seat-peer-b', sessionId: 'seat-helper' });
  assert.equal(sent.ok, true, String(sent.message));
  await waitForInjection(member, 'seat-peer-b', (list) => list.some((entry) => entry.payload?.text === '只给乙席'));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(injectionTextsOf(member, 'seat-peer-a').includes('只给乙席'), false, '非目标席位不投（不按机器级扩散）');
});

test('同机双席：两席各自发出，对端按发件席记账且互不串席', { timeout: TIMEOUT_MS }, async (t) => {
  const { manager, member } = await startDuo(t);
  assert.equal((await manager.service.send({ collabId: COLLAB_ID, text: '站长席发言', sessionId: 'seat-manager' })).ok, true);
  assert.equal((await manager.service.send({ collabId: COLLAB_ID, text: '助手席发言', sessionId: 'seat-helper' })).ok, true);
  await waitForInjection(member, 'seat-peer-a', (list) => list.some((entry) => entry.payload?.text === '助手席发言'));
  await waitForInjection(member, 'seat-peer-b', (list) => list.some((entry) => entry.payload?.text === '助手席发言'));
  const inboxA = member.inbound.checkInbox({ collabId: COLLAB_ID, sessionId: 'seat-peer-a', limit: 50 });
  const inboxB = member.inbound.checkInbox({ collabId: COLLAB_ID, sessionId: 'seat-peer-b', limit: 50 });
  assert.equal(inboxA.total, 2, '甲席收件流水只含发给它的两条');
  assert.equal(inboxB.total, 2, '乙席收件流水同样各一份');
  const ledger = await readLedger(member, COLLAB_ID);
  assert.deepEqual(ledger.members.map((seat) => seat.sessionId).sort(), ['seat-helper', 'seat-manager', 'seat-peer-a', 'seat-peer-b']);
});

test('同机双席：一席离席后另一席保留并照常收发', { timeout: TIMEOUT_MS }, async (t) => {
  const { manager, member } = await startDuo(t);
  const left = await manager.service.leave({ collabId: COLLAB_ID, sessionId: 'seat-helper' });
  assert.equal(left.ok, true, String(left.message));
  assert.equal(manager.service.listLocalSeats(COLLAB_ID).some((seat) => seat.sessionId === 'seat-helper'), false);
  assert.equal(manager.service.listLocalSeats(COLLAB_ID).some((seat) => seat.sessionId === 'seat-manager'), true);
  const sent = await manager.service.send({ collabId: COLLAB_ID, text: '站长席仍在线', sessionId: 'seat-manager' });
  assert.equal(sent.ok, true, String(sent.message));
  await waitForInjection(member, 'seat-peer-a', (list) => list.some((entry) => entry.payload?.text === '站长席仍在线'));
});
