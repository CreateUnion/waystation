import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { carrierFilePath, collabFilePath, departedFilePath } from '../src/paths.js';
import {
  bringSessionOffline,
  bringSessionOnline,
  closeSessionNode,
  linkSessionNodes,
  makeTempRoot,
  seedSessionCollab,
  startSessionNode,
  waitForInjection,
} from './helpers/session-participants.js';
import { waitFor, waitForRebindable } from './helpers.js';

/* 离席的真实链路：显式离席（成员→站长）、会话关闭宽限（桥断开→宽限到期→名单移除与留痕）、
 * 同 sessionId 宽限内重开、最后一人离席的本地终态副本（含重启后仍可见）。
 * 长操作声明：宽限用例按缩小后的宽限（400–800ms）等待，文件内单用例超时上限 45s，禁止无界等待。 */

const COLLAB_ID = 'collab-leave';
const SOLO_COLLAB_ID = 'collab-last-seat';
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

test('显式离席：成员离席后站长名单移除该席，离席帧携席位并写入 departed', { timeout: TIMEOUT_MS }, async (t) => {
  const { manager, member } = await startPair(t);
  const left = await member.service.leave({ collabId: COLLAB_ID, sessionId: 'seat-member' });
  assert.equal(left.ok, true, String(left.message));
  assert.equal(left.delivered, true, '站长端点已学到：离席必须发 leave 帧（不可达时才按心跳收敛）');
  const frame = member.sentFrames.find((entry) => entry.type === 'leave');
  assert.equal(frame.fromSessionId ?? frame.from?.sessionId, 'seat-member', 'leave 由离席席位本人签发');
  await waitFor(() => manager.service.view({ collabId: COLLAB_ID }).then((view) => view.ledger?.members.some((seat) => seat.sessionId === 'seat-member') === false ? true : null), { timeoutMs: 8000 });
  await waitFor(() => {
    const lines = readFileSync(departedFilePath(manager.home, COLLAB_ID), 'utf8').trim().split('\n').filter(Boolean);
    return lines.some((line) => JSON.parse(line).sessionId === 'seat-member') ? true : null;
  }, { timeoutMs: 3000 });
  const memberView = await member.service.view({ collabId: COLLAB_ID });
  assert.equal(memberView.archived, true, '离席方本机归档只读');
});

test('会话关闭：宽限到期后本机席位与对端名单同步移除并留痕', { timeout: TIMEOUT_MS }, async (t) => {
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
  await waitFor(() => {
    try {
      return readFileSync(departedFilePath(member.home, COLLAB_ID), 'utf8').includes('"session-closed"') ? true : null;
    } catch {
      return null;
    }
  }, { timeoutMs: 3000 });
});

test('同 sessionId 宽限内重开：席位保留，宽限到期不误判离席', { timeout: TIMEOUT_MS }, async (t) => {
  const { manager, member } = await startPair(t, {
    sessionSeatGraceMs: 800,
    seatPresenceIntervalMs: 100,
    managerProbeIntervalMs: 100,
    sessionSeatTimeoutMs: 30000,
  });
  manager.service.start();
  member.service.start();
  await bringSessionOffline(member, 'seat-member');
  const reopened = await bringSessionOnline(member, 'seat-member');
  assert.equal(reopened.ok, true, '同 sessionId 重开按桥注册恢复');
  /* 等待超过原宽限：宽限计时必须被重开清除，席位与站长名单都不得被移除。 */
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(member.service.listLocalSeats(COLLAB_ID).some((seat) => seat.sessionId === 'seat-member'), true, '重开后席位保留');
  const view = await manager.service.view({ collabId: COLLAB_ID });
  assert.equal(view.ledger?.members.some((seat) => seat.sessionId === 'seat-member'), true, '站长名单不得移除重开的席位');
  assert.equal(member.sentFrames.some((entry) => entry.type === 'leave'), false, '重开不广播离席');
});

test('最后一人离席（站长已离线）：本地终态副本 completed，核重启后仍可见', { timeout: TIMEOUT_MS }, async (t) => {
  const solo = await startSoloNode(t);
  await waitFor(() => freezeReasonOf(solo) === 'manager-offline' ? true : null, { timeoutMs: 5000 });
  const before = readSnapshot(solo);
  await bringSessionOffline(solo, 'seat-solo');
  const terminal = await waitFor(() => {
    const snapshot = readSnapshot(solo);
    return snapshot?.ledger?.localTerminal === true ? snapshot.ledger : null;
  }, { timeoutMs: 6000 });
  assertTerminalLedger(terminal, before.ledger);
  assert.equal((await solo.service.view({ collabId: SOLO_COLLAB_ID })).ledger?.status, 'completed');
  await assertTerminalSurvivesRestart(t, solo);
});

async function startSoloNode(t) {
  const solo = await startSessionNode(t, {
    home: makeTempRoot(t),
    instanceId: 'inst-last-seat',
    identityName: '独席机',
    seed: seedSoloNode,
    online: ['seat-solo'],
    config: {
      sessionSeatGraceMs: 400,
      seatPresenceIntervalMs: 100,
      managerProbeIntervalMs: 100,
      managerLossTimeoutMs: 300,
      sessionSeatTimeoutMs: 30000,
    },
  });
  await bringSessionOnline(solo, 'seat-solo');
  solo.service.start();
  return solo;
}

function assertTerminalLedger(terminal, before) {
  assert.equal(terminal.status, 'completed');
  assert.deepEqual(terminal.members, [], '终态名单清空');
  assert.equal(terminal.manager, null, '终态 manager:null');
  assert.equal(terminal.managerTerm, before.managerTerm, 'managerTerm 保留最后值');
  assert.equal(terminal.version, before.version + 1, '版本仍递增一次');
}

async function assertTerminalSurvivesRestart(t, solo) {
  const { home, port } = solo;
  await closeSessionNode(solo);
  await waitForRebindable(port);
  const restarted = await startSessionNode(t, { home, port, instanceId: 'inst-last-seat', identityName: '独席机', online: [] });
  const view = await restarted.service.view({ collabId: SOLO_COLLAB_ID });
  assert.equal(view.ledger?.status, 'completed', '重启仍显示 completed');
  assert.equal(view.ledger?.localTerminal, true);
  assert.deepEqual(view.ledger?.members, []);
  assert.equal(view.ledger?.manager, null);
}

function freezeReasonOf(node) {
  try {
    return JSON.parse(readFileSync(carrierFilePath(node.home, SOLO_COLLAB_ID), 'utf8')).freezeReason ?? null;
  } catch {
    return null;
  }
}

function readSnapshot(node) {
  try {
    return JSON.parse(readFileSync(collabFilePath(node.home, SOLO_COLLAB_ID, 'snapshot.json'), 'utf8'));
  } catch {
    return null;
  }
}

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
