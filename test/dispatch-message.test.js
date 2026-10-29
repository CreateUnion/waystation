import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDispatchNode } from './helpers/dispatch.js';

function setup(t) {
  const node = makeDispatchNode(t);
  const created = node.service.create({ mode: 'dispatch', name: '消息', sessionId: 'master-1' });
  assert.equal(created.ok, true, String(created.message));
  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1', 'human-1'] });
  const human = node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['human-1'] }).results[0];
  if (human.status === 'pending') {
    const first = node.service.dispatch.approve({ sessionId: 'human-1', claimId: human.claimId, approve: true });
    node.service.dispatch.approve({ sessionId: 'human-1', claimId: human.claimId, approve: true, confirmToken: first.confirmToken });
  }
  return { node, collabId: created.collabId };
}

test('master 定向 task：payload 携 targetSessionId / taskId / 来源名', (t) => {
  const { node, collabId } = setup(t);
  const sent = node.service.dispatch.send({
    collabId, sessionId: 'master-1', text: '跑一下测试', type: 'task', toSessionIds: ['worker-1'], taskId: 'task-1',
  });
  assert.equal(sent.ok, true);
  assert.equal(sent.delivered, 1);
  const frame = node.notices.find((entry) => entry.payload?.targetSessionId === 'worker-1' && entry.payload?.taskId === 'task-1');
  assert.ok(frame, '必须经本机 notify 投递');
  assert.equal(frame.payload.messageType, 'task');
  assert.equal(frame.payload.fromSessionName, 'master');
  assert.match(frame.payload.text, /跑一下测试/);
});

test('slave 省略 toSessionIds 回 master，并带 @来源；slave 不能发给其他 slave', (t) => {
  const { node, collabId } = setup(t);
  const reply = node.service.dispatch.send({ collabId, sessionId: 'worker-1', text: '完成', type: 'result', taskId: 'task-1' });
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.targets, ['master-1']);
  const frame = node.notices.find((entry) => entry.payload?.targetSessionId === 'master-1' && entry.payload?.text.includes('完成'));
  assert.ok(frame);
  assert.match(frame.payload.text, /^@worker-1 /);
  const bad = node.service.dispatch.send({ collabId, sessionId: 'worker-1', text: 'x', toSessionIds: ['human-1'] });
  assert.equal(bad.ok, false);
});

test('非 dispatch 成员 / 非法 type / 超长 taskId 拒绝', (t) => {
  const { node, collabId } = setup(t);
  assert.equal(node.service.dispatch.send({ collabId, sessionId: 'headless-1', text: 'x' }).ok, false);
  assert.equal(node.service.dispatch.send({ collabId, sessionId: 'master-1', text: 'x', type: 'freeze' }).ok, false);
  assert.equal(node.service.dispatch.send({ collabId, sessionId: 'master-1', text: 'x', taskId: 'x'.repeat(65) }).ok, false);
});

test('end 清空 dispatch 并通知全员；leave 只移除自己', (t) => {
  const { node, collabId } = setup(t);
  const leave = node.service.dispatch.leave({ collabId, sessionId: 'worker-1' });
  assert.equal(leave.ok, true);
  assert.equal(node.service.dispatch.status().dispatch.slaves.some((slave) => slave.sessionId === 'worker-1'), false);
  const ended = node.service.dispatch.end({ collabId, sessionId: 'master-1' });
  assert.equal(ended.ok, true);
  assert.equal(node.service.dispatch.status().dispatch, null);
  assert.equal(node.notices.some((entry) => entry.payload?.event === 'dispatch-ended'), true);
});

test('通知失败时进有界队列，重连 flush', (t) => {
  const node = makeDispatchNode(t, { notifyResult: false });
  const created = node.service.create({ mode: 'dispatch', name: '队列', sessionId: 'master-1' });
  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1'] });
  const sent = node.service.dispatch.send({ collabId: created.collabId, sessionId: 'master-1', text: '先排队', toSessionIds: ['worker-1'] });
  assert.equal(sent.queued, 1);
  node.setNotifyResult(true);
  node.service.dispatch.noteBridgeOnline('worker-1');
  assert.equal(node.notices.some((entry) => entry.payload?.text === '先排队'), true);
});
