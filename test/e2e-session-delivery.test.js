import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  bringSessionOffline,
  bringSessionOnline,
  feedSessionFrame,
  injectionsOf,
  linkSessionNodes,
  seedSessionCollab,
  startSessionNode,
} from './helpers/session-participants.js';
import { waitFor } from './helpers.js';

/* 机器级投递（D11）的真实链路：outbox 排队 → 对端 ack → 会话注入回报（终态 session）；
 * 本机席位明细（injected / staged）；零成功回报仍携原发件会话（不得生成缺 from.sessionId 的帧）。
 * 长操作声明：两节点进程内运行、等待投递收敛，通常 < 10s；单用例超时上限 45s。 */

const COLLAB_ID = 'collab-delivery';
const TIMEOUT_MS = 45000;
const MANAGER = { instanceId: 'inst-dlv-mgr', sessionId: 'seat-manager', identityName: '甲机' };
const MEMBER = { instanceId: 'inst-dlv-mem', sessionId: 'seat-b1', identityName: '乙机' };

const ROSTER = [
  { instanceId: MANAGER.instanceId, sessionId: MANAGER.sessionId, identityName: MANAGER.identityName, role: 'manager', joinSeq: 1 },
  { instanceId: MEMBER.instanceId, sessionId: 'seat-b1', identityName: MEMBER.identityName, role: 'member', joinSeq: 2 },
  { instanceId: MEMBER.instanceId, sessionId: 'seat-b2', identityName: MEMBER.identityName, role: 'member', joinSeq: 3 },
];

function seedManager(home) {
  seedSessionCollab(home, COLLAB_ID, {
    name: '投递协作',
    manager: MANAGER,
    members: ROSTER,
    seats: [{ sessionId: MANAGER.sessionId, role: 'manager', joinSeq: 1 }],
  });
}

function seedMember(home) {
  seedSessionCollab(home, COLLAB_ID, {
    name: '投递协作',
    manager: MANAGER,
    members: ROSTER,
    snapshotFrom: MANAGER.instanceId,
    seats: [
      { sessionId: 'seat-b1', role: 'member', joinSeq: 2 },
      { sessionId: 'seat-b2', role: 'member', joinSeq: 3 },
    ],
    member: {
      collabId: COLLAB_ID,
      name: '投递协作',
      topic: '投递协作 主题',
      role: 'member',
      state: 'active',
      manager: { instanceId: MANAGER.instanceId, sessionId: MANAGER.sessionId, identityName: MANAGER.identityName },
      endpoints: {},
      roster: ROSTER,
      mode: 'managed',
      decision: 'approved',
    },
  });
}

async function startPair(t) {
  const manager = await startSessionNode(t, {
    instanceId: MANAGER.instanceId,
    identityName: MANAGER.identityName,
    seed: seedManager,
    online: [MANAGER.sessionId],
    config: { retryIntervalMs: 200, dispatchTickMs: 30, retryFastCount: 20 },
  });
  const member = await startSessionNode(t, {
    instanceId: MEMBER.instanceId,
    identityName: MEMBER.identityName,
    seed: seedMember,
    online: ['seat-b1', 'seat-b2'],
  });
  linkSessionNodes(manager, member);
  await bringSessionOnline(manager, MANAGER.sessionId);
  await bringSessionOnline(member, 'seat-b1');
  await bringSessionOnline(member, 'seat-b2');
  return { manager, member };
}

function reportOf(node) {
  return node.sentFrames.find((frame) => frame.type === 'delivery-status');
}

test('机器级 outbox：排队 → 对端 ack → 会话注入回报达终态 session', { timeout: TIMEOUT_MS }, async (t) => {
  const { manager, member } = await startPair(t);
  const sent = await manager.service.send({ collabId: COLLAB_ID, text: '机器级投递', sessionId: MANAGER.sessionId });
  assert.equal(sent.ok, true, String(sent.message));
  await waitFor(() => manager.dispatch.deliveryStatus({ msgId: sent.msgId }).some((row) => row.tier === 'session') ? true : null, { timeoutMs: 10000 });
  const row = manager.dispatch.deliveryStatus({ msgId: sent.msgId }).find((entry) => entry.type === 'reply');
  assert.equal(row.tier, 'session', '机器级终态 = 已投进对方会话');
  assert.equal(row.toInstanceId, MEMBER.instanceId);
  assert.equal(row.fromSessionId, MANAGER.sessionId, '出站条目保留发件会话');
  assert.deepEqual(row.toSessions, ['seat-b1', 'seat-b2'], '一帧携目标机全部活跃席位');
  assert.ok(injectionsOf(member, 'seat-b1').some((entry) => entry.payload?.text === '机器级投递'));
  assert.ok(injectionsOf(member, 'seat-b2').some((entry) => entry.payload?.text === '机器级投递'));
});

test('本机席位明细：在席 injected、离线 staged，重连后补投', { timeout: TIMEOUT_MS }, async (t) => {
  const { manager, member } = await startPair(t);
  await bringSessionOffline(member, 'seat-b2');
  const sent = await manager.service.send({ collabId: COLLAB_ID, text: '一席离线', sessionId: MANAGER.sessionId });
  assert.equal(sent.ok, true, String(sent.message));
  await waitFor(() => member.inbound.localSeatDeliveryOf(sent.msgId, 'seat-b1').status === 'injected' ? true : null, { timeoutMs: 10000 });
  const staged = member.inbound.localSeatDeliveryOf(sent.msgId, 'seat-b2');
  assert.equal(staged.status, 'staged', '离线席位进暂存而非丢弃');
  const before = injectionsOf(member, 'seat-b2').length;
  await bringSessionOnline(member, 'seat-b2');
  await waitFor(() => injectionsOf(member, 'seat-b2').length > before ? true : null, { timeoutMs: 5000 });
  assert.ok(injectionsOf(member, 'seat-b2').some((entry) => entry.payload?.text === '一席离线'), '重连补投');
});

test('零成功回报：仍携原消息的出站发件会话（不得缺 from.sessionId）', { timeout: TIMEOUT_MS }, async (t) => {
  const { manager, member } = await startPair(t);
  await bringSessionOffline(member, 'seat-b1');
  await bringSessionOffline(member, 'seat-b2');
  const sent = await manager.service.send({ collabId: COLLAB_ID, text: '全席离线', sessionId: MANAGER.sessionId });
  assert.equal(sent.ok, true, String(sent.message));
  await waitFor(() => reportOf(member) !== undefined ? true : null, { timeoutMs: 10000 });
  const report = reportOf(member);
  assert.equal(report.from?.sessionId, MANAGER.sessionId, '零成功时签发席位回退到原帧 from.sessionId');
  assert.equal(report.payload?.refMsgId, sent.msgId);
  const rows = manager.dispatch.deliveryStatus({ msgId: sent.msgId });
  await waitFor(() => rows.some((row) => row.type === 'reply' && row.tier === 'session') || rows.some((row) => row.type === 'reply' && row.tier === 'acked') ? true : null, { timeoutMs: 5000 });
});

test('本机席位明细：toSessions 里不在可注入面的目标按 dropped 隔离', { timeout: TIMEOUT_MS }, async (t) => {
  const { member } = await startPair(t);
  const msgId = randomUUID();
  await feedSessionFrame(member, {
    v: 1,
    cap: 2,
    type: 'reply',
    msgId,
    collabId: COLLAB_ID,
    from: { instanceId: MANAGER.instanceId, sessionId: MANAGER.sessionId, identityName: MANAGER.identityName, port: 24500 },
    ts: new Date().toISOString(),
    payload: { text: '含坏目标' },
    toSessions: ['seat-b1', 'seat-ghost'],
  });
  await waitFor(() => member.inbound.localSeatDeliveryOf(msgId, 'seat-b1').status === 'injected' ? true : null, { timeoutMs: 5000 });
  const dropped = member.inbound.localSeatDeliveryOf(msgId, 'seat-ghost');
  assert.equal(dropped.status, 'dropped', '不可注入目标按坏目标隔离');
  assert.equal(dropped.complete, true);
});
