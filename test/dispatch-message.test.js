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

test('master 定向 task：payload 携 targetSessionId / taskId / 来源名', async (t) => {
  const { node, collabId } = setup(t);
  const sent = await node.service.dispatch.send({
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

test('slave 省略 toSessionIds 回 master，并带 @来源；slave 不能发给其他 slave', async (t) => {
  const { node, collabId } = setup(t);
  const reply = await node.service.dispatch.send({ collabId, sessionId: 'worker-1', text: '完成', type: 'result', taskId: 'task-1' });
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.targets, ['master-1']);
  const frame = node.notices.find((entry) => entry.payload?.targetSessionId === 'master-1' && entry.payload?.text.includes('完成'));
  assert.ok(frame);
  assert.match(frame.payload.text, /^@worker-1 /);
  const bad = await node.service.dispatch.send({ collabId, sessionId: 'worker-1', text: 'x', toSessionIds: ['human-1'] });
  assert.equal(bad.ok, false);
});

test('非 dispatch 成员 / 非法 type / 超长 taskId 拒绝', async (t) => {
  const { node, collabId } = setup(t);
  assert.equal((await node.service.dispatch.send({ collabId, sessionId: 'headless-1', text: 'x' })).ok, false);
  assert.equal((await node.service.dispatch.send({ collabId, sessionId: 'master-1', text: 'x', type: 'freeze' })).ok, false);
  assert.equal((await node.service.dispatch.send({ collabId, sessionId: 'master-1', text: 'x', taskId: 'x'.repeat(65) })).ok, false);
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

test('显式空 toSessionIds / 空白元素拒绝；省略才按绑定路由', async (t) => {
  const { node, collabId } = setup(t);
  assert.equal((await node.service.dispatch.send({ collabId, sessionId: 'master-1', text: 'x', toSessionIds: [] })).ok, false, '空数组不等于省略');
  assert.equal((await node.service.dispatch.send({ collabId, sessionId: 'master-1', text: 'x', toSessionIds: [' '] })).ok, false, '空白会话标识拒绝');
  assert.equal((await node.service.dispatch.send({ collabId, sessionId: 'master-1', text: 'x', toSessionIds: ['worker-1'] })).ok, true);
});

test('release 释放后会回收该会话的待补投队列', async (t) => {
  const node = makeDispatchNode(t, { notifyResult: false });
  const created = node.service.create({ mode: 'dispatch', name: '释放', sessionId: 'master-1' });
  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1'] });
  await node.service.dispatch.send({ collabId: created.collabId, sessionId: 'master-1', text: '排队', toSessionIds: ['worker-1'] });
  const record = node.service.dispatch.dispatches.get(created.collabId);
  assert.equal(record.queues.has('worker-1'), true, '前置：通知失败已入队');
  node.service.dispatch.release({ sessionId: 'master-1', targetSessionId: 'worker-1' });
  assert.equal(record.queues.has('worker-1'), false, '释放后队列回收');
});

test('通知失败时进有界队列，重连 flush', async (t) => {
  const node = makeDispatchNode(t, { notifyResult: false });
  const created = node.service.create({ mode: 'dispatch', name: '队列', sessionId: 'master-1' });
  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1'] });
  const sent = await node.service.dispatch.send({ collabId: created.collabId, sessionId: 'master-1', text: '先排队', toSessionIds: ['worker-1'] });
  assert.equal(sent.queued, 1);
  node.setNotifyResult(true);
  node.service.dispatch.noteBridgeOnline('worker-1');
  assert.equal(node.notices.some((entry) => entry.payload?.text === '先排队'), true);
});

test('delivery：逐目标 delivered / queued 与宽限截止（既有 delivered/queued 计数不变）', async (t) => {
  let online = false;
  const node = makeDispatchNode(t, { deliverDispatch: async () => online });
  const created = node.service.create({ mode: 'dispatch', name: '送达态', sessionId: 'master-1' });
  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1'] });
  const queued = await node.service.dispatch.send({ collabId: created.collabId, sessionId: 'master-1', text: '暂存', toSessionIds: ['worker-1'] });
  assert.equal(queued.delivered, 0);
  assert.equal(queued.queued, 1, '既有计数沿用');
  assert.equal(queued.delivery.state, 'queued');
  const target = queued.delivery.targets[0];
  assert.equal(target.sessionId, 'worker-1');
  assert.equal(target.status, 'queued');
  assert.equal(typeof target.msgId, 'string');
  assert.ok(Number.isFinite(Date.parse(target.queuedUntil)), '暂存必须给出宽限截止');
  const record = node.service.dispatch.dispatches.get(created.collabId);
  assert.equal(record.queueDeadlines.has('worker-1'), true, '补投截止已登记（sweep 可收口）');

  online = true;
  node.service.dispatch.noteBridgeOnline('worker-1');
  const delivered = await node.service.dispatch.send({ collabId: created.collabId, sessionId: 'master-1', text: '直达', toSessionIds: ['worker-1'] });
  assert.equal(delivered.delivery.state, 'delivered');
  assert.deepEqual(delivered.delivery.targets[0], {
    sessionId: 'worker-1', status: 'delivered', msgId: delivered.delivery.targets[0].msgId,
  });
});

test('requireAck：登记待确认、文本带回执指引、目标会话 ackFor 后另行通知调度长', async (t) => {
  const fired = [];
  const node = makeDispatchNode(t, { deliverDispatch: async (frame) => (fired.push(frame), true) });
  const created = node.service.create({ mode: 'dispatch', name: '确认', sessionId: 'master-1' });
  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1', 'human-1'] });
  const sent = await node.service.dispatch.send({
    collabId: created.collabId, sessionId: 'master-1', text: '跑测试', type: 'task', toSessionIds: ['worker-1'], taskId: 't-1', requireAck: true,
  });
  assert.equal(sent.delivery.state, 'delivered');
  assert.deepEqual(sent.delivery.ack, { required: true, state: 'pending', pending: [sent.delivery.targets[0].msgId] });
  const msgId = sent.delivery.targets[0].msgId;
  const frame = fired.find((entry) => entry.payload?.taskId === 't-1');
  assert.match(frame.payload.text, /ackFor/);
  assert.ok(frame.payload.text.includes(msgId), '回执指引携带本条 msgId');

  const acked = await node.service.dispatch.send({ collabId: created.collabId, sessionId: 'worker-1', text: '收到', ackFor: msgId });
  assert.equal(acked.ok, true);
  assert.equal(acked.acked, true);
  const notice = node.notices.find((entry) => entry.payload?.event === 'dispatch-ack');
  assert.ok(notice, '调度长收到另行通知');
  assert.equal(notice.payload.targetSessionId, 'master-1');
  assert.match(notice.payload.text, /已确认收到/);
  assert.equal((await node.service.dispatch.send({ collabId: created.collabId, sessionId: 'worker-1', text: '收到', ackFor: msgId })).ok, false, '重复确认拒绝');
});

test('requireAck：越权确认 / 非 task / 非调度长要求确认均拒绝；超时由 sweep 通知调度长', async (t) => {
  const node = makeDispatchNode(t, { deliverDispatch: async () => true, config: { dispatchAckTtlMs: 100 } });
  const created = node.service.create({ mode: 'dispatch', name: '确认边界', sessionId: 'master-1' });
  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1', 'human-1'] });
  const sent = await node.service.dispatch.send({
    collabId: created.collabId, sessionId: 'master-1', text: '任务', type: 'task', toSessionIds: ['worker-1'], requireAck: true,
  });
  const msgId = sent.delivery.targets[0].msgId;
  assert.equal((await node.service.dispatch.send({ collabId: created.collabId, sessionId: 'human-1', text: '不是我', ackFor: msgId })).ok, false, '非目标会话不能确认');
  assert.equal((await node.service.dispatch.send({ collabId: created.collabId, sessionId: 'worker-1', text: 'x', type: 'progress', requireAck: true })).ok, false, 'requireAck 只限 task');
  assert.equal((await node.service.dispatch.send({ collabId: created.collabId, sessionId: 'worker-1', text: 'x', type: 'task', requireAck: true })).ok, false, '组员不能要求调度长确认');
  assert.equal((await node.service.dispatch.send({ collabId: created.collabId, sessionId: 'master-1', text: 'x', requireAck: 'yes' })).ok, false, 'requireAck 形态非法');

  node.advance(101);
  node.service.dispatch.sweep(node.now());
  const timeout = node.notices.find((entry) => entry.payload?.event === 'dispatch-ack-timeout' && entry.payload?.text.includes(msgId));
  assert.ok(timeout, '超时后通知调度长（不静默挂着）');
});

test('requireAck：暂存消息补投成功后仍可确认', async (t) => {
  let online = false;
  const node = makeDispatchNode(t, { deliverDispatch: async () => online });
  const created = node.service.create({ mode: 'dispatch', name: '暂存确认', sessionId: 'master-1' });
  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1'] });
  const sent = await node.service.dispatch.send({
    collabId: created.collabId, sessionId: 'master-1', text: '暂存任务', type: 'task', toSessionIds: ['worker-1'], requireAck: true,
  });
  assert.equal(sent.delivery.state, 'queued');
  assert.deepEqual(sent.delivery.ack.pending, [sent.delivery.targets[0].msgId], '暂存也登记待确认（补投后目标即可回执）');
  online = true;
  node.service.dispatch.noteBridgeOnline('worker-1');
  const record = node.service.dispatch.dispatches.get(created.collabId);
  assert.equal(record.pendingAcks.get(sent.delivery.targets[0].msgId)?.deliveryState, 'delivered', '补投成功推进为 delivered');
  const acked = await node.service.dispatch.send({ collabId: created.collabId, sessionId: 'worker-1', text: '收到', ackFor: sent.delivery.targets[0].msgId });
  assert.equal(acked.acked, true);
});

test('delivery：同一目标多条暂存共用首个宽限截止；sweep 超期丢弃并回报', async (t) => {
  const node = makeDispatchNode(t, { deliverDispatch: async () => false });
  const created = node.service.create({ mode: 'dispatch', name: '暂存截止', sessionId: 'master-1' });
  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1'] });
  const first = await node.service.dispatch.send({ collabId: created.collabId, sessionId: 'master-1', text: '一', toSessionIds: ['worker-1'] });
  node.advance(10);
  const second = await node.service.dispatch.send({ collabId: created.collabId, sessionId: 'master-1', text: '二', toSessionIds: ['worker-1'] });
  assert.equal(first.delivery.targets[0].queuedUntil, second.delivery.targets[0].queuedUntil, '共用首个补投截止');
  node.advance(2000);
  node.service.dispatch.sweep(node.now());
  assert.ok(node.notices.find((entry) => entry.payload?.event === 'dispatch-delivery-timeout'), '超期丢弃如实回报');
  const record = node.service.dispatch.dispatches.get(created.collabId);
  assert.equal(record.queues.has('worker-1'), false);
  assert.equal(record.queueDeadlines.has('worker-1'), false);
});

test('requireAck：目标释放 / 补投队列溢出 / 补投超时都会收口待确认并回报', async (t) => {
  const node = makeDispatchNode(t, { deliverDispatch: async () => false, config: { dispatchQueueMax: 1 } });
  const created = node.service.create({ mode: 'dispatch', name: '确认收口', sessionId: 'master-1' });
  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1'] });
  const first = await node.service.dispatch.send({ collabId: created.collabId, sessionId: 'master-1', text: '一', type: 'task', toSessionIds: ['worker-1'], requireAck: true });
  const firstMsg = first.delivery.targets[0].msgId;
  /* 队列上限 1：第二条入队挤掉第一条，第一条的待确认账必须立即作废并回报。 */
  await node.service.dispatch.send({ collabId: created.collabId, sessionId: 'master-1', text: '二', type: 'task', toSessionIds: ['worker-1'], requireAck: true });
  assert.ok(node.notices.find((entry) => entry.payload?.event === 'dispatch-ack-timeout' && entry.payload?.text.includes(firstMsg)), '溢出丢弃回报');

  const second = await node.service.dispatch.send({ collabId: created.collabId, sessionId: 'master-1', text: '三', type: 'task', toSessionIds: ['worker-1'], requireAck: true });
  node.service.dispatch.release({ sessionId: 'master-1', targetSessionId: 'worker-1' });
  assert.ok(node.notices.find((entry) => entry.payload?.event === 'dispatch-ack-timeout' && entry.payload?.text.includes(second.delivery.targets[0].msgId)), '目标释放回报');
});

test('requireAck：补投成功前超期 → 丢弃队列并回报待确认超时', async (t) => {
  const node = makeDispatchNode(t, { deliverDispatch: async () => false });
  const created = node.service.create({ mode: 'dispatch', name: '补投超时确认', sessionId: 'master-1' });
  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1'] });
  const sent = await node.service.dispatch.send({ collabId: created.collabId, sessionId: 'master-1', text: '任务', type: 'task', toSessionIds: ['worker-1'], requireAck: true });
  const msgId = sent.delivery.targets[0].msgId;
  node.advance(2000);
  node.service.dispatch.noteBridgeOnline('worker-1');
  assert.ok(node.notices.find((entry) => entry.payload?.event === 'dispatch-ack-timeout' && entry.payload?.text.includes(msgId)), '超期回报');
});

test('delivery：投递面抛异常 → 按暂存处理（不丢消息），不谎报 delivered', async (t) => {
  const node = makeDispatchNode(t, { deliverDispatch: async () => { throw new Error('投递面异常'); } });
  const created = node.service.create({ mode: 'dispatch', name: '投递异常', sessionId: 'master-1' });
  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1'] });
  const sent = await node.service.dispatch.send({ collabId: created.collabId, sessionId: 'master-1', text: 'x', toSessionIds: ['worker-1'] });
  assert.equal(sent.delivery.state, 'queued');
  assert.equal(sent.queued, 1);
});

test('ackFor：服务层形态与字段混用校验（工具层之外的纵深防御）', async (t) => {
  const node = makeDispatchNode(t);
  const created = node.service.create({ mode: 'dispatch', name: '确认校验', sessionId: 'master-1' });
  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1'] });
  assert.equal((await node.service.dispatch.send({ collabId: created.collabId, sessionId: 'worker-1', text: 'x', ackFor: 'bad id!' })).ok, false);
  assert.equal((await node.service.dispatch.send({ collabId: created.collabId, sessionId: 'worker-1', text: 'x', ackFor: 'msg-1', type: 'result' })).ok, false);
  assert.equal((await node.service.dispatch.send({ collabId: created.collabId, sessionId: 'worker-1', text: 'x', ackFor: 'msg-1', taskId: 't-1' })).ok, false);
});

test('桥注册补投在 welcome 之后：握手期 notify 未恢复也不出队丢失', async (t) => {
  const node = makeDispatchNode(t, { notifyResult: false });
  const created = node.service.create({ mode: 'dispatch', name: '握手重连', sessionId: 'master-1' });
  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1'] });
  const sent = await node.service.dispatch.send({ collabId: created.collabId, sessionId: 'master-1', text: '握手后排', toSessionIds: ['worker-1'] });
  assert.equal(sent.queued, 1, '前置：notify 失败已入待补投队列');
  /* 注册回合内（welcome 尚未写出）notify 仍会失败——若此刻 flush 会出队并按送达记账；
   * 10ms 后恢复等价于「welcome 已写出、桥可收 push」。 */
  setTimeout(() => node.setNotifyResult(true), 10);
  await node.service.registerBridgeEntry('worker-1', 'bridge-worker-1');
  assert.equal(node.notices.some((entry) => entry.payload?.text === '握手后排'), true, '注册让出握手期后队列应补投成功');
  assert.equal(node.service.dispatch.dispatches.get(created.collabId).queues.has('worker-1'), false, '补投成功后待补投队列清空');
});
