import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDispatchNode } from './helpers/dispatch.js';
import { sendMessageTool } from '../src/tools/collab.js';
import { DEFAULT_REQUIRE_ACK_DEFAULT, requireAckDefaultOf } from '../src/dispatch-config.js';

/* 问题 6-B：config.dispatch.require_ack_default（默认 false）。
 * true 时调度长发出的 task 未显式给 requireAck 按 true 处理；显式 false 仍可关闭。 */

function setup(t, config = {}) {
  const node = makeDispatchNode(t, { config });
  const created = node.service.create({ mode: 'dispatch', name: '回执默认', sessionId: 'master-1' });
  assert.equal(created.ok, true, String(created.message));
  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1'] });
  return { node, collabId: created.collabId };
}

function sendTask(node, collabId, overrides = {}) {
  return node.service.dispatch.send({
    collabId, sessionId: 'master-1', type: 'task', toSessionIds: ['worker-1'], text: '任务', taskId: 't1', ...overrides,
  });
}

test('默认 false：调度长 task 未显式要求时不登记待确认', async (t) => {
  const { node, collabId } = setup(t);
  const sent = await sendTask(node, collabId);
  assert.equal(sent.ok, true);
  assert.equal(sent.delivery.ack, undefined);
  const frame = node.notices.find((entry) => entry.payload?.taskId === 't1');
  assert.equal(frame.payload.requireAck, undefined);
  assert.doesNotMatch(frame.payload.text, /需确认/);
});

test('require_ack_default=true：未显式给 requireAck 的调度长 task 按 true 处理', async (t) => {
  const { node, collabId } = setup(t, { dispatch: { require_ack_default: true } });
  const sent = await sendTask(node, collabId);
  assert.equal(sent.delivery.ack.required, true);
  assert.equal(sent.delivery.ack.state, 'pending');
  const frame = node.notices.find((entry) => entry.payload?.taskId === 't1');
  assert.equal(frame.payload.requireAck, true);
  assert.match(frame.payload.text, /需确认/);
  assert.match(frame.payload.text, /ackFor/);
});

test('require_ack_default=true 时显式 false 仍可关闭；非 task / 组员消息不受影响', async (t) => {
  const { node, collabId } = setup(t, { dispatch: { require_ack_default: true } });
  const explicitOff = await sendTask(node, collabId, { requireAck: false });
  assert.equal(explicitOff.delivery.ack, undefined, '显式 false 覆盖默认值');

  const progress = await node.service.dispatch.send({
    collabId, sessionId: 'master-1', type: 'progress', toSessionIds: ['worker-1'], text: '进度', taskId: 't2',
  });
  assert.equal(progress.delivery.ack, undefined, '默认只作用于 task');

  const slaveResult = await node.service.dispatch.send({
    collabId, sessionId: 'worker-1', type: 'result', taskId: 't2', text: '完成',
  });
  assert.equal(slaveResult.delivery.ack, undefined, '组员消息不要求回执');
});

test('工具层 dispatch：require_ack_default=true 时 task 走默认回执', async (t) => {
  const { node, collabId } = setup(t, { dispatch: { require_ack_default: true } });
  const result = await sendMessageTool().handler(
    { collabId, text: '任务', type: 'task', toSessionIds: ['worker-1'], taskId: 't-tool' },
    { collab: node.service, sessionId: 'master-1' },
  );
  assert.equal(result.isError, undefined);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.delivery.ack.required, true);
});

test('requireAckDefaultOf：缺失 / 非法回落 false，仅显式 true 生效', () => {
  assert.equal(DEFAULT_REQUIRE_ACK_DEFAULT, false);
  assert.equal(requireAckDefaultOf({}), false);
  assert.equal(requireAckDefaultOf({ dispatch: { require_ack_default: true } }), true);
  assert.equal(requireAckDefaultOf({ dispatch: { require_ack_default: false } }), false);
  for (const value of ['true', 1, null, {}]) {
    assert.equal(requireAckDefaultOf({ dispatch: { require_ack_default: value } }), false, JSON.stringify(value));
  }
});
