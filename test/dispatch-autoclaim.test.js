import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDispatchNode } from './helpers/dispatch.js';

function createAuto(node, autoClaim) {
  const created = node.service.create({ mode: 'dispatch', name: '自动收编', sessionId: 'master-1', autoClaim });
  assert.equal(created.ok, true, String(created.message ?? ''));
  return created;
}

function boundIds(node) {
  const status = node.service.dispatch.status();
  return new Set((status.dispatch?.slaves ?? []).map((slave) => slave.sessionId));
}

test('autoClaim 创建即收编：可绑定的全部入编（slave + 门 off 的交互式），门开交互式与非交互跳过', (t) => {
  const node = makeDispatchNode(t, { config: { dispatchClaimConfirmation: false } });
  createAuto(node, true);
  const bound = boundIds(node);
  assert.equal(bound.has('worker-1'), true, 'role=slave 直接入编');
  assert.equal(bound.has('human-1'), true, '门 off 的交互式直接入编');
  assert.equal(bound.has('headless-1'), false, '非交互无角色不入编');
  assert.equal(bound.has('master-1'), false, 'master 自身不入编');
});

test('autoClaim 门开（默认）时：只收 slave，交互式不得被定时器弹确认', (t) => {
  const node = makeDispatchNode(t);
  createAuto(node, true);
  const bound = boundIds(node);
  assert.equal(bound.has('worker-1'), true);
  assert.equal(bound.has('human-1'), false, '门开时定时器不得触发确认注入');
  const prompts = node.notices.filter((frame) => frame.payload?.event === 'dispatch-claim');
  assert.equal(prompts.length, 0, 'autoClaim 路径不得签发收编确认提示');
});

test('autoClaim 定时扫描：迟到会话在 sweep 时入编；无 autoClaim 不自动收编', (t) => {
  const node = makeDispatchNode(t, { config: { dispatchClaimConfirmation: false } });
  createAuto(node, true);
  node.meta.set('late-1', { sessionId: 'late-1', role: 'none', name: 'late', kind: 'interactive', entrypoint: 'cli', status: 'idle', metaUpdatedAt: node.now() });
  node.service.dispatch.sweep(node.now());
  assert.equal(boundIds(node).has('late-1'), true, '新会话在下一拍入编');

  const plain = makeDispatchNode(t, { config: { dispatchClaimConfirmation: false } });
  createAuto(plain, false);
  plain.meta.set('late-2', { sessionId: 'late-2', role: 'none', name: 'late2', kind: 'interactive', entrypoint: 'cli', status: 'idle', metaUpdatedAt: plain.now() });
  plain.service.dispatch.sweep(plain.now());
  assert.equal(boundIds(plain).has('late-2'), false, '未开 autoClaim 保持手动收编语义');
});

test('autoClaim 移除面：slave 桥断开（注册表移除）超宽限由既有清扫移除，不再吸回', (t) => {
  const node = makeDispatchNode(t, { config: { dispatchClaimConfirmation: false, sessionSeatGraceMs: 1000 } });
  createAuto(node, true);
  assert.equal(boundIds(node).has('worker-1'), true);
  // 真实断开序：closeBridgeEntry 先 bridges.remove（离开 listSessionIds），noteBridgeClosed 记宽限
  node.meta.delete('worker-1');
  node.service.dispatch.noteBridgeClosed('worker-1', node.now());
  node.service.dispatch.sweep(node.now() + 1001);
  assert.equal(boundIds(node).has('worker-1'), false, '离线 slave 超宽限自动移除且不被 autoClaim 吸回');
});
