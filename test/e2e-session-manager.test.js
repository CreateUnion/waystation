import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { carrierFilePath } from '../src/paths.js';
import {
  bringSessionOnline,
  feedSessionFrame,
  linkSessionNodes,
  seedSessionCollab,
  startSessionNode,
} from './helpers/session-participants.js';
import { waitFor } from './helpers.js';

/* 站长交接的真实链路：auto-offer + 新站长签发（旧站长降级、开窗）、同 term 分叉冻结与本地裁定、
 * 站长会话关闭的自动移交、整机离线冻结后的手动接管。
 * 长操作声明：冻结用例按缩小后的失联时限（300ms）等待，自动移交按 400ms 宽限等待；
 * 单用例超时上限 60s，禁止无界等待。 */

const TIMEOUT_MS = 60000;
const COLLAB_ID = 'collab-manager';
const MANAGER = { instanceId: 'inst-mgr', sessionId: 'seat-manager', identityName: '甲机' };
const MEMBER = { instanceId: 'inst-mem', sessionId: 'seat-member', identityName: '乙机' };
const RIVAL = { instanceId: 'inst-rival', sessionId: 'seat-rival', identityName: '丙机' };

function seedLedgerNode(home, { term = 1, version = 3 } = {}) {
  const members = [
    { instanceId: MANAGER.instanceId, sessionId: MANAGER.sessionId, identityName: MANAGER.identityName, role: 'manager', joinSeq: 1 },
    { instanceId: MEMBER.instanceId, sessionId: MEMBER.sessionId, identityName: MEMBER.identityName, role: 'member', joinSeq: 2 },
  ];
  seedSessionCollab(home, COLLAB_ID, {
    name: '交接协作',
    managerTerm: term,
    version,
    manager: MANAGER,
    members,
    snapshotFrom: MANAGER.instanceId,
    seats: [{ sessionId: MANAGER.sessionId, role: 'manager', joinSeq: 1 }],
  });
  return members;
}

function seedMemberOnly(home, { term = 1, version = 3 } = {}) {
  const members = [
    { instanceId: MANAGER.instanceId, sessionId: MANAGER.sessionId, identityName: MANAGER.identityName, role: 'manager', joinSeq: 1 },
    { instanceId: MEMBER.instanceId, sessionId: MEMBER.sessionId, identityName: MEMBER.identityName, role: 'member', joinSeq: 2 },
  ];
  seedSessionCollab(home, COLLAB_ID, {
    name: '交接协作',
    managerTerm: term,
    version,
    manager: MANAGER,
    members,
    snapshotFrom: MANAGER.instanceId,
    seats: [{ sessionId: MEMBER.sessionId, role: 'member', joinSeq: 2 }],
    member: {
      collabId: COLLAB_ID,
      name: '交接协作',
      topic: '交接协作 主题',
      role: 'member',
      state: 'active',
      manager: { instanceId: MANAGER.instanceId, sessionId: MANAGER.sessionId, identityName: MANAGER.identityName },
      endpoints: {},
      roster: members,
      mode: 'managed',
      decision: 'approved',
    },
  });
}

function autoOfferFrame() {
  return noticeFrame('notice', {
    event: 'auto-offer',
    offerId: 'offer-auto-1',
    prevManager: { instanceId: MANAGER.instanceId, sessionId: MANAGER.sessionId },
    target: { instanceId: MEMBER.instanceId, sessionId: MEMBER.sessionId },
    baseTerm: 1,
    version: 3,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  }, MEMBER);
}

function autoChangeFrame() {
  return noticeFrame('notice', {
    event: 'manager-changed',
    via: 'auto',
    offerId: 'offer-auto-1',
    term: 2,
    version: 4,
    prevManager: { instanceId: MANAGER.instanceId, sessionId: MANAGER.sessionId },
    manager: { instanceId: MEMBER.instanceId, sessionId: MEMBER.sessionId, identityName: MEMBER.identityName },
    effectiveAt: new Date().toISOString(),
    windowEndsAt: new Date(Date.now() + 60000).toISOString(),
    endpoint: { address: '127.0.0.1', port: 24001 },
    digest: 'a'.repeat(64),
  }, MEMBER);
}

function noticeFrame(type, payload, from) {
  return {
    v: 1,
    cap: 2,
    type,
    msgId: randomUUID(),
    collabId: COLLAB_ID,
    from: { ...from, port: 24000 },
    ts: new Date().toISOString(),
    payload,
  };
}

async function viewOf(node) {
  const viewed = await node.service.view({ collabId: COLLAB_ID });
  return viewed.ledger ?? null;
}

/* 冻结原因落载体（供观察窗只读展示）：运行态不暴露独立字段，按落盘事实断言。 */
function freezeReasonOf(node) {
  try {
    return JSON.parse(readFileSync(carrierFilePath(node.home, COLLAB_ID), 'utf8')).freezeReason ?? null;
  } catch {
    return null;
  }
}

test('新站长签发 via=auto：旧站长受理、旧站长席位降级并开窗', { timeout: TIMEOUT_MS }, async (t) => {
  const manager = await startSessionNode(t, {
    instanceId: MANAGER.instanceId,
    identityName: MANAGER.identityName,
    seed: (home) => seedLedgerNode(home),
    online: [MANAGER.sessionId],
  });
  await bringSessionOnline(manager, MANAGER.sessionId);
  await feedSessionFrame(manager, autoOfferFrame());
  await waitFor(() => manager.service.stats().autoOffersIn === 1 ? true : null, { timeoutMs: 3000 });
  await feedSessionFrame(manager, autoChangeFrame());
  await waitFor(() => manager.service.stats().managerDowngrades === 1 ? true : null, { timeoutMs: 3000 });
  const seat = manager.service.localSeatOf(COLLAB_ID, MANAGER.sessionId);
  assert.equal(seat.role, 'member', '旧站长席位降级');
  const viewed = await manager.service.view({ collabId: COLLAB_ID });
  assert.equal(viewed.source, 'snapshot', '降级后旧站长只读本地快照（不再写权威台账）');
  assert.equal(viewed.archived, false, '降级不等于归档');
});

test('同 term 分叉：冻结 manager-fork，本地裁定 terminate 只归档本方（不合并、不广播合并）', { timeout: TIMEOUT_MS }, async (t) => {
  const member = await startSessionNode(t, {
    instanceId: MEMBER.instanceId,
    identityName: MEMBER.identityName,
    seed: (home) => seedMemberOnly(home, { term: 2, version: 5 }),
    online: [MEMBER.sessionId],
  });
  await bringSessionOnline(member, MEMBER.sessionId);
  await feedSessionFrame(member, noticeFrame('notice', {
    event: 'manager-changed',
    via: 'handover',
    offerId: 'offer-rival',
    term: 2,
    version: 6,
    prevManager: { instanceId: MANAGER.instanceId, sessionId: MANAGER.sessionId },
    manager: { instanceId: RIVAL.instanceId, sessionId: RIVAL.sessionId, identityName: RIVAL.identityName },
    effectiveAt: new Date().toISOString(),
    endpoint: { address: '127.0.0.1', port: 24002 },
    digest: 'b'.repeat(64),
  }, RIVAL));
  await waitFor(() => freezeReasonOf(member) === 'manager-fork' ? true : null, { timeoutMs: 3000 });
  const decided = await member.service.decide({ collabId: COLLAB_ID, choice: 'terminate' });
  assert.equal(decided.ok, true, String(decided.message));
  const ledger = await viewOf(member);
  assert.equal(ledger.status, 'terminated', '终止后本方只读归档');
  assert.equal(member.sentFrames.some((frame) => frame.type === 'decision'), false, '本地归档不广播合并');
});

test('站长会话关闭：宽限后自动移交，新站长以自己名义签发 via=auto', { timeout: TIMEOUT_MS }, async (t) => {
  const config = { sessionSeatGraceMs: 400, seatPresenceIntervalMs: 100, managerProbeIntervalMs: 100, managerLossTimeoutMs: 30000 };
  const manager = await startSessionNode(t, {
    instanceId: MANAGER.instanceId,
    identityName: MANAGER.identityName,
    seed: (home) => seedLedgerNode(home),
    online: [MANAGER.sessionId],
    config,
  });
  const member = await startSessionNode(t, {
    instanceId: MEMBER.instanceId,
    identityName: MEMBER.identityName,
    seed: (home) => seedMemberOnly(home),
    online: [MEMBER.sessionId],
    config,
  });
  linkSessionNodes(manager, member);
  manager.service.start();
  member.service.start();
  await bringSessionOnline(manager, MANAGER.sessionId);
  await bringSessionOnline(member, MEMBER.sessionId);
  await bringSessionOfflineBridge(manager);
  const ledger = await waitFor(() => member.service.view({ collabId: COLLAB_ID }).then((view) => {
    const current = view.ledger;
    return current?.managerTerm === 2 && current.manager?.sessionId === MEMBER.sessionId ? current : null;
  }), { timeoutMs: 12000 });
  assert.equal(ledger.manager.instanceId, MEMBER.instanceId);
});

async function bringSessionOfflineBridge(node) {
  node.online.delete(MANAGER.sessionId);
  return node.service.unregisterBridgeEntry(MANAGER.sessionId, `bridge-${MANAGER.sessionId}`);
}

test('整机离线：成员冻结 manager-offline，用户确认后手动接管成功', { timeout: TIMEOUT_MS }, async (t) => {
  const member = await startSessionNode(t, {
    instanceId: MEMBER.instanceId,
    identityName: MEMBER.identityName,
    seed: (home) => seedMemberOnly(home),
    online: [MEMBER.sessionId],
    config: { seatPresenceIntervalMs: 100, managerProbeIntervalMs: 100, managerLossTimeoutMs: 300, sessionSeatTimeoutMs: 30000 },
  });
  await bringSessionOnline(member, MEMBER.sessionId);
  member.service.start();
  await waitFor(() => freezeReasonOf(member) === 'manager-offline' ? true : null, { timeoutMs: 5000 });
  const first = await member.service.takeOver({ collabId: COLLAB_ID, sessionId: MEMBER.sessionId });
  assert.equal(first.needsUserConfirmation, true, String(first.message));
  const confirmed = await member.service.takeOver({ collabId: COLLAB_ID, sessionId: MEMBER.sessionId, token: first.token });
  assert.equal(confirmed.ok, true, String(confirmed.message));
  const ledger = await viewOf(member);
  assert.equal(ledger.managerTerm, 2, '接管推进任期');
  assert.equal(ledger.manager.sessionId, MEMBER.sessionId, '接管方成为新站长');
});
