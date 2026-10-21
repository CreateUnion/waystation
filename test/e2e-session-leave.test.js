import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bringSessionOffline,
  bringSessionOnline,
  linkSessionNodes,
  seedSessionCollab,
  startSessionNode,
  waitForInjection,
} from './helpers/session-participants.js';
import { waitFor } from './helpers.js';

/* 离席的真实链路：显式离席（成员→站长）、会话关闭宽限（桥断开→宽限到期→通知）、
 * 最后一人离席的本地终态。长操作声明：宽限用例按缩小后的宽限（400ms）等待，
 * 文件内单用例超时上限 45s，禁止无界等待。 */

const COLLAB_ID = 'collab-leave';
const TIMEOUT_MS = 45000;

function rosterOfManager() {
  return [
    { instanceId: 'inst-leave-manager', sessionId: 'seat-manager', identityName: '甲机', role: 'manager', joinSeq: 1 },
    { instanceId: 'inst-leave-member', sessionId: 'seat-member', identityName: '乙机', role: 'member', joinSeq: 2 },
  ];
}

function seedManagerNode(home) {
  seedSessionCollab(home, COLLAB_ID, {
    name: '离席协作',
    manager: { instanceId: 'inst-leave-manager', sessionId: 'seat-manager', identityName: '甲机' },
    members: rosterOfManager(),
    seats: [{ sessionId: 'seat-manager', role: 'manager', joinSeq: 1 }],
  });
}

function seedMemberNode(home) {
  seedSessionCollab(home, COLLAB_ID, {
    name: '离席协作',
    manager: { instanceId: 'inst-leave-manager', sessionId: 'seat-manager', identityName: '甲机' },
    members: rosterOfManager(),
    snapshotFrom: 'inst-leave-manager',
    seats: [{ sessionId: 'seat-member', role: 'member', joinSeq: 2 }],
    member: {
      collabId: COLLAB_ID,
      name: '离席协作',
      topic: '离席协作 主题',
      role: 'member',
      state: 'active',
      manager: { instanceId: 'inst-leave-manager', sessionId: 'seat-manager', identityName: '甲机' },
      endpoints: {},
      roster: rosterOfManager(),
      mode: 'managed',
      decision: 'approved',
    },
  });
}

async function startPair(t, config = {}) {
  const manager = await startSessionNode(t, {
    instanceId: 'inst-leave-manager',
    identityName: '甲机',
    seed: seedManagerNode,
    online: ['seat-manager'],
    config,
  });
  const member = await startSessionNode(t, {
    instanceId: 'inst-leave-member',
    identityName: '乙机',
    seed: seedMemberNode,
    online: ['seat-member'],
    config,
  });
  linkSessionNodes(manager, member);
  await bringSessionOnline(manager, 'seat-manager');
  await bringSessionOnline(member, 'seat-member');
  /* 端点学习预热：真实链路里任何已受理帧都会教会成员站长的地址:端口（成员记录的端点表）——
   * 显式离席的 leave 帧依赖该端点，不能靠夹具手填端口。 */
  assert.equal((await manager.service.send({ collabId: COLLAB_ID, text: '链路预热', sessionId: 'seat-manager' })).ok, true);
  await waitForInjection(member, 'seat-member', (list) => list.some((entry) => entry.payload?.text === '链路预热'));
  return { manager, member };
}

test('显式离席：成员离席后站长名单移除该席，成员本机归档', { timeout: TIMEOUT_MS }, async (t) => {
  const { manager, member } = await startPair(t);
  const left = await member.service.leave({ collabId: COLLAB_ID, sessionId: 'seat-member' });
  assert.equal(left.ok, true, String(left.message));
  assert.equal(left.delivered, true, '站长端点已学到：离席必须发 leave 帧（不可达时才按心跳收敛）');
  await waitFor(() => manager.service.view({ collabId: COLLAB_ID }).then((view) => view.ledger?.members.some((seat) => seat.sessionId === 'seat-member') === false ? true : null), { timeoutMs: 8000 });
  const memberView = await member.service.view({ collabId: COLLAB_ID });
  assert.equal(memberView.archived, true, '离席方本机归档只读');
});

test('会话关闭：桥断开后宽限到期，本机席位与对端名单同步移除并通知', { timeout: TIMEOUT_MS }, async (t) => {
  const { manager, member } = await startPair(t, {
    sessionSeatGraceMs: 400,
    seatPresenceIntervalMs: 100,
    managerProbeIntervalMs: 100,
    sessionSeatTimeoutMs: 30000,
  });
  manager.service.start();
  member.service.start();
  assert.equal(member.service.listLocalSeats(COLLAB_ID).length, 1, '宽限起点：席位仍在');
  await bringSessionOffline(member, 'seat-member');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(member.service.listLocalSeats(COLLAB_ID).length, 1, '宽限内席位保留（宽限尚未到期）');
  await waitFor(() => member.service.listLocalSeats(COLLAB_ID).length === 0 ? true : null, { timeoutMs: 6000 });
  await waitFor(() => manager.service.view({ collabId: COLLAB_ID }).then((view) => view.ledger?.members.some((seat) => seat.sessionId === 'seat-member') === false ? true : null), { timeoutMs: 6000 });
});

test('最后一人离席：本地终态 completed（空名单、manager:null）', { timeout: TIMEOUT_MS }, async (t) => {
  const solo = await startSessionNode(t, {
    instanceId: 'inst-last-seat',
    identityName: '独席机',
    seed: seedSoloNode,
    online: ['seat-solo'],
  });
  await bringSessionOnline(solo, 'seat-solo');
  const left = await solo.service.leave({ collabId: 'collab-last-seat', sessionId: 'seat-solo' });
  assert.equal(left.ok, true, String(left.message));
  await waitFor(() => solo.service.view({ collabId: 'collab-last-seat' }).then((view) => {
    const ledger = view.ledger;
    return ledger?.status === 'completed' && Array.isArray(ledger.members) && ledger.members.length === 0 && ledger.manager === null ? true : null;
  }), { timeoutMs: 8000 });
});

function seedSoloNode(home) {
  const manager = { instanceId: 'inst-absent-manager', sessionId: 'seat-absent', identityName: '远端站长' };
  const members = [
    { instanceId: manager.instanceId, sessionId: manager.sessionId, identityName: manager.identityName, role: 'manager', joinSeq: 1 },
    { instanceId: 'inst-last-seat', sessionId: 'seat-solo', identityName: '独席机', role: 'member', joinSeq: 2 },
  ];
  seedSessionCollab(home, 'collab-last-seat', {
    name: '最后一人',
    manager,
    members,
    snapshotFrom: manager.instanceId,
    seats: [{ sessionId: 'seat-solo', role: 'member', joinSeq: 2 }],
    member: {
      collabId: 'collab-last-seat',
      name: '最后一人',
      topic: '最后一人 主题',
      role: 'member',
      state: 'active',
      manager: { instanceId: manager.instanceId, sessionId: manager.sessionId, identityName: manager.identityName },
      endpoints: {},
      roster: members,
      mode: 'managed',
      decision: 'approved',
    },
  });
}
