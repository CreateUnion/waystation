import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ledgerDigest } from '../src/collab/store.js';
import { feedSessionFrame, seedSessionCollab, startSessionNode } from './helpers/session-participants.js';
import { waitFor } from './helpers.js';

/* 终态快照权威（回归 Critical）：任意成员发 term+1 / manager:null 的终态快照必须拒绝，
 * 只有本地现任站长（同 term）或经受理的更高 term 新站长签发的终态可被采纳。
 * 长操作声明：单节点进程内运行，通常 < 5s；单用例超时上限 30s。 */

const TIMEOUT_MS = 30000;
const COLLAB_ID = 'collab-terminal';
const MANAGER = { instanceId: 'inst-term-mgr', sessionId: 'seat-manager', identityName: '甲机' };
const MEMBER = { instanceId: 'inst-term-mem', sessionId: 'seat-member', identityName: '乙机' };
const ATTACKER = { instanceId: 'inst-term-atk', sessionId: 'seat-attacker', identityName: '丙机' };

const ROSTER = [
  { instanceId: MANAGER.instanceId, sessionId: MANAGER.sessionId, identityName: MANAGER.identityName, role: 'manager', joinSeq: 1 },
  { instanceId: MEMBER.instanceId, sessionId: MEMBER.sessionId, identityName: MEMBER.identityName, role: 'member', joinSeq: 2 },
  { instanceId: ATTACKER.instanceId, sessionId: ATTACKER.sessionId, identityName: ATTACKER.identityName, role: 'member', joinSeq: 3 },
];

function seedMemberNode(home) {
  seedSessionCollab(home, COLLAB_ID, {
    name: '终态权威',
    manager: MANAGER,
    members: ROSTER,
    snapshotFrom: MANAGER.instanceId,
    seats: [{ sessionId: MEMBER.sessionId, role: 'member', joinSeq: 2 }],
    member: {
      collabId: COLLAB_ID,
      name: '终态权威',
      topic: '终态权威 主题',
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

function terminalLedger(term = 2) {
  return {
    version: 4,
    collabId: COLLAB_ID,
    name: '终态权威',
    topic: '终态权威 主题',
    mode: 'managed',
    status: 'completed',
    managerTerm: term,
    joinSeqNext: 2,
    manager: null,
    members: [],
    board: [],
    createdAt: new Date(Date.parse('2026-10-21T00:00:00.000Z')).toISOString(),
    updatedAt: new Date(Date.parse('2026-10-21T00:01:00.000Z')).toISOString(),
  };
}

function terminalSnapshotFrame(from, term = 2) {
  const ledger = terminalLedger(term);
  return {
    v: 1,
    cap: 2,
    type: 'snapshot',
    msgId: randomUUID(),
    collabId: COLLAB_ID,
    from: { instanceId: from.instanceId, sessionId: from.sessionId, identityName: from.identityName, port: 24400 },
    ts: new Date().toISOString(),
    payload: { kind: 'data', managerTerm: term, version: 4, digest: ledgerDigest(ledger), ledger },
  };
}

async function startMember(t) {
  const node = await startSessionNode(t, {
    instanceId: MEMBER.instanceId,
    identityName: MEMBER.identityName,
    seed: seedMemberNode,
    online: [MEMBER.sessionId],
  });
  await node.service.registerBridgeEntry(MEMBER.sessionId, `bridge-${MEMBER.sessionId}`);
  return node;
}

async function assertStillActive(node) {
  const view = await node.service.view({ collabId: COLLAB_ID });
  assert.equal(view.ledger?.status, 'active', '终态快照被拒：本地台账不得转终态');
  assert.equal(view.ledger?.manager?.sessionId, MANAGER.sessionId, '站长不得被 manager:null 覆盖');
  assert.equal(view.ledger?.members?.length, 3, '名单不得被清空');
  assert.notEqual(node.service.stats().terminalAdoptions, 1, '不得记终态采纳');
}

test('成员发 term+1 / manager:null 终态快照：拒绝且不改本地状态', { timeout: TIMEOUT_MS }, async (t) => {
  const node = await startMember(t);
  await feedSessionFrame(node, terminalSnapshotFrame(ATTACKER));
  await new Promise((resolve) => setTimeout(resolve, 100));
  await assertStillActive(node);
});

test('同 term 非站长发终态快照：同样拒绝（来源权威不足）', { timeout: TIMEOUT_MS }, async (t) => {
  const node = await startMember(t);
  await feedSessionFrame(node, terminalSnapshotFrame(ATTACKER, 1));
  await new Promise((resolve) => setTimeout(resolve, 100));
  await assertStillActive(node);
});

test('现任站长签发终态快照：受理为本地只读终态（正向对照）', { timeout: TIMEOUT_MS }, async (t) => {
  const node = await startMember(t);
  await feedSessionFrame(node, terminalSnapshotFrame(MANAGER, 1));
  await waitFor(() => node.service.stats().terminalAdoptions === 1 ? true : null, { timeoutMs: 3000 });
  const stored = await node.service.view({ collabId: COLLAB_ID });
  assert.equal(stored.archived, true, '管理员签发的终态被采纳后只读');
  const listed = node.service.list().collabs.find((entry) => entry.collabId === COLLAB_ID);
  assert.equal(listed?.state, 'completed', '本地状态转终态');
});
