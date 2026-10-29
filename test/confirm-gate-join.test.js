import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bringSessionOnline, linkSessionNodes, startSessionNode, targetOf,
} from './helpers/session-participants.js';
import { waitFor } from './helpers.js';

const TIMEOUT_MS = 60000;

test('join off：本机申请自动批准，申请人 join-confirm 自动走完整条入席', { timeout: TIMEOUT_MS }, async (t) => {
  const manager = await startSessionNode(t, { identityName: '甲机', online: ['seat-manager'] });
  const member = await startSessionNode(t, { identityName: '乙机', online: ['seat-b1'] });
  linkSessionNodes(manager, member);
  await bringSessionOnline(manager, 'seat-manager');
  await bringSessionOnline(member, 'seat-b1');

  const created = await manager.service.create({
    name: '自动批准', topic: '自动批准主题',
    targets: [targetOf(member)], mode: 'managed', sessionId: 'seat-manager',
  });
  assert.equal(created.ok, true, String(created.message));
  const set = manager.service.setConfirmGate({
    action: 'set', gate: 'join', requireConfirmation: false, scope: 'session', sessionId: 'seat-manager',
  });
  assert.equal(set.ok, true);
  await waitFor(
    () => member.service.list().collabs.some((entry) => entry.collabId === created.collabId),
    { timeoutMs: 8000 },
  );

  const requested = await member.service.join.request({
    collabId: created.collabId, sessionId: 'seat-b1',
  });
  assert.equal(requested.ok, true, String(requested.message));
  const grant = await waitFor(
    () => manager.sentFrames.find((frame) => frame.type === 'join-grant') ?? null,
    { timeoutMs: 8000 },
  );
  assert.ok(grant, '站长应自动签发 grant');
  const confirm = await waitFor(
    () => member.sentFrames.find((frame) => frame.type === 'join-confirm') ?? null,
    { timeoutMs: 8000 },
  );
  assert.ok(confirm, '申请人核心应自动发 join-confirm');
  /* join-confirm 跨网络到达站长侧、台账写入异步落定：成席断言须轮询等待收敛（非放宽）。 */
  const view = await waitFor(async () => {
    const current = await manager.service.view({ collabId: created.collabId });
    return current.ledger.members.some((seat) => seat.sessionId === 'seat-b1') ? current : null;
  }, { timeoutMs: 8000 });
  assert.ok(view.ledger.members.some((seat) => seat.sessionId === 'seat-b1'));
});

test('join off：站长桥离线时仍自动批准（本设计的取舍）', { timeout: TIMEOUT_MS }, async (t) => {
  const manager = await startSessionNode(t, { identityName: '甲机', online: ['seat-manager'] });
  const member = await startSessionNode(t, { identityName: '乙机', online: ['seat-b1'] });
  linkSessionNodes(manager, member);
  await bringSessionOnline(manager, 'seat-manager');
  await bringSessionOnline(member, 'seat-b1');
  const created = await manager.service.create({
    name: '离线自动批准', topic: '离线主题', targets: [targetOf(member)],
    mode: 'managed', sessionId: 'seat-manager',
  });
  manager.service.setConfirmGate({
    action: 'set', gate: 'join', requireConfirmation: false, scope: 'session', sessionId: 'seat-manager',
  });
  await waitFor(
    () => member.service.list().collabs.some((entry) => entry.collabId === created.collabId),
    { timeoutMs: 8000 },
  );
  /* 只关桥绑定，不删站长席位：managerSessionOf 仍取得到。 */
  manager.service.unregisterBridgeEntry('seat-manager', null);
  const requested = await member.service.join.request({ collabId: created.collabId, sessionId: 'seat-b1' });
  assert.equal(requested.ok, true, String(requested.message));
  const grant = await waitFor(
    () => manager.sentFrames.find((frame) => frame.type === 'join-grant') ?? null,
    { timeoutMs: 8000 },
  );
  assert.ok(grant, '站长桥离线时仍按设置自动批准');
  /* 通知在批准 Promise 收尾后注入：与 grant 帧不保证同一拍，轮询等一行。 */
  const notices = await waitFor(
    () => manager.notices.filter((frame) => String(frame.payload?.text ?? '').includes('自动批准')),
    { timeoutMs: 8000 },
  );
  assert.equal(notices.length >= 1, true, '自动批准应注入一行通知');
});
