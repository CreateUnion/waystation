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

test('显式空 toSessionIds / 空白元素拒绝；省略才按绑定路由', (t) => {
  const { node, collabId } = setup(t);
  assert.equal(node.service.dispatch.send({ collabId, sessionId: 'master-1', text: 'x', toSessionIds: [] }).ok, false, '空数组不等于省略');
  assert.equal(node.service.dispatch.send({ collabId, sessionId: 'master-1', text: 'x', toSessionIds: [' '] }).ok, false, '空白会话标识拒绝');
  assert.equal(node.service.dispatch.send({ collabId, sessionId: 'master-1', text: 'x', toSessionIds: ['worker-1'] }).ok, true);
});

test('release 释放后会回收该会话的待补投队列', (t) => {
  const node = makeDispatchNode(t, { notifyResult: false });
  const created = node.service.create({ mode: 'dispatch', name: '释放', sessionId: 'master-1' });
  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1'] });
  node.service.dispatch.send({ collabId: created.collabId, sessionId: 'master-1', text: '排队', toSessionIds: ['worker-1'] });
  const record = node.service.dispatch.dispatches.get(created.collabId);
  assert.equal(record.queues.has('worker-1'), true, '前置：通知失败已入队');
  node.service.dispatch.release({ sessionId: 'master-1', targetSessionId: 'worker-1' });
  assert.equal(record.queues.has('worker-1'), false, '释放后队列回收');
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

test('桥注册补投在 welcome 之后：握手期 notify 未恢复也不出队丢失', async (t) => {
  const node = makeDispatchNode(t, { notifyResult: false });
  const created = node.service.create({ mode: 'dispatch', name: '握手重连', sessionId: 'master-1' });
  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1'] });
  const sent = node.service.dispatch.send({ collabId: created.collabId, sessionId: 'master-1', text: '握手后排', toSessionIds: ['worker-1'] });
  assert.equal(sent.queued, 1, '前置：notify 失败已入待补投队列');
  /* 注册回合内（welcome 尚未写出）notify 仍会失败——若此刻 flush 会出队并按送达记账；
   * 10ms 后恢复等价于「welcome 已写出、桥可收 push」。 */
  setTimeout(() => node.setNotifyResult(true), 10);
  await node.service.registerBridgeEntry('worker-1', 'bridge-worker-1');
  assert.equal(node.notices.some((entry) => entry.payload?.text === '握手后排'), true, '注册让出握手期后队列应补投成功');
  assert.equal(node.service.dispatch.dispatches.get(created.collabId).queues.has('worker-1'), false, '补投成功后待补投队列清空');
});
