import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { collabDir, invitesFilePath, seatFilePath } from '../src/paths.js';
import { isLedgerShape, isTerminalLedger } from '../src/collab/model.js';
import { loadLedger } from '../src/collab/store.js';
import {
  bringSessionOnline,
  linkSessionNodes,
  startSessionNode,
  targetOf,
  waitForInjection,
} from './helpers/session-participants.js';
import { waitFor } from './helpers.js';

/* 未建立的 proposed managed 协作的取消路径（设计 §3.4 裁定）：创建者会话用 ws_end_collab 结束
 * 尚未建立的协作——本地台账转 terminated（manager:null 的终态形态）、撤回全部 open 邀请记录、
 * 向已知邀请目标广播 end；不删除协作目录或用户数据。已建立的协作仍走既有 completed 语义，
 * 非创建者会话一律拒绝。
 * 长操作声明：两节点用例走真实回环 TCP，通常 < 30s，单用例超时上限 90s。 */

const TIMEOUT_MS = 90000;
const MANAGER_SESSION = 'seat-manager';

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

async function startPair(t) {
  const manager = await startSessionNode(t, { identityName: '甲机', online: [MANAGER_SESSION, 'seat-intruder'] });
  const member = await startSessionNode(t, { identityName: '乙机', online: ['seat-b1'] });
  linkSessionNodes(manager, member);
  await bringSessionOnline(manager, MANAGER_SESSION);
  await bringSessionOnline(manager, 'seat-intruder');
  await bringSessionOnline(member, 'seat-b1');
  return { manager, member };
}

async function createTargeting(manager, member, name) {
  const created = await manager.service.create({
    name,
    topic: `${name} 主题`,
    targets: [targetOf(member)],
    mode: 'managed',
    sessionId: MANAGER_SESSION,
  });
  assert.equal(created.ok, true, String(created.message));
  assert.equal(created.invited[0].ok, true, String(created.invited[0].reason));
  return created;
}

async function waitInviteArrived(member, created) {
  const inviteId = created.invited[0].inviteId;
  assert.match(String(inviteId), /^inv-/);
  await waitForInjection(
    member,
    'seat-b1',
    (list) => list.find((item) => item.type === 'invite' && item.payload?.inviteId === inviteId) ?? null,
    { timeoutMs: 8000 },
  );
}

test('proposed 协作：创建者 end 成功、终态落盘、邀请全部撤回、目标收到 end', { timeout: TIMEOUT_MS }, async (t) => {
  const { manager, member } = await startPair(t);
  const created = await createTargeting(manager, member, '未建立取消');
  await waitInviteArrived(member, created);

  const intruder = await manager.service.end({ collabId: created.collabId, sessionId: 'seat-intruder' });
  assert.equal(intruder.ok, false, '非创建者会话不得结束该协作');
  const before = await manager.service.view({ collabId: created.collabId });
  assert.equal(before.ledger.status, 'proposed', '被拒的 end 不改台账');

  const ended = await manager.service.end({ collabId: created.collabId, sessionId: MANAGER_SESSION });
  assert.equal(ended.ok, true, String(ended.message));

  const loaded = loadLedger(manager.home, created.collabId);
  assert.equal(loaded.corrupt, false, '终态台账必须可读回');
  assert.equal(loaded.ledger.status, 'terminated', 'proposed 取消转 terminated（不是 completed）');
  assert.equal(loaded.ledger.manager, null, '终态必须 manager:null');
  assert.equal(Object.hasOwn(loaded.ledger, 'managerWindow'), false, '终态不得残留接管窗口');
  assert.equal(loaded.ledger.members.some((seat) => seat.role === 'manager'), false, '名单不得残留站长行');
  assert.equal(isTerminalLedger(loaded.ledger), true, '终态判据成立');
  assert.equal(isLedgerShape(loaded.ledger), true, '终态台账过形态校验');

  const book = readJson(invitesFilePath(manager.home, created.collabId));
  assert.deepEqual(book.invites.filter((record) => record.state === 'open'), [], '全部 open 邀请记录已撤回');
  assert.equal(book.invites.length, 1, '邀请记录保留为撤回态（留痕，不删用户数据）');
  assert.equal(book.invites[0].state, 'withdrawn');

  await waitFor(() => (
    member.service.list().collabs.find((entry) => entry.collabId === created.collabId)?.state === 'completed'
      ? true
      : null
  ), { timeoutMs: 10000 });
  assert.equal(existsSync(collabDir(manager.home, created.collabId)), true, '协作目录不得删除');
  assert.equal(existsSync(seatFilePath(manager.home, created.collabId, MANAGER_SESSION)), true, '席位文件保留（归档而非删除）');
});

test('已建立协作：end 仍按既有语义转 completed（不受 proposed 取消路径影响）', { timeout: TIMEOUT_MS }, async (t) => {
  const { manager, member } = await startPair(t);
  const created = await createTargeting(manager, member, '已建立结束');
  const inviteId = created.invited[0].inviteId;
  await waitInviteArrived(member, created);
  const accepted = await member.service.join.acceptInvite({ collabId: created.collabId, inviteId, sessionId: 'seat-b1' });
  assert.equal(accepted.ok, true, String(accepted.message));
  await waitFor(async () => {
    const view = await manager.service.view({ collabId: created.collabId });
    return view.ledger?.members.some((seat) => seat.sessionId === 'seat-b1') ? true : null;
  }, { timeoutMs: 10000 });

  const ended = await manager.service.end({ collabId: created.collabId, sessionId: MANAGER_SESSION });
  assert.equal(ended.ok, true, String(ended.message));

  const loaded = loadLedger(manager.home, created.collabId);
  assert.equal(loaded.corrupt, false);
  assert.equal(loaded.ledger.status, 'completed', '已建立协作沿用 completed');
  assert.equal(loaded.ledger.manager, null);
  await waitFor(() => (
    member.service.list().collabs.find((entry) => entry.collabId === created.collabId)?.state === 'completed'
      ? true
      : null
  ), { timeoutMs: 10000 });
});
