import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDispatchNode } from './helpers/dispatch.js';
import { createCollabTool, sendMessageTool, viewLedgerTool } from '../src/tools/collab.js';
import { checkInboxTool } from '../src/tools/check-inbox.js';
import { deliveryStatusTool } from '../src/tools/delivery-status.js';

function contextOf(node, sessionId) {
  return { collab: node.service, sessionId, net: { checkInbox: () => ({ rows: [] }), deliveryStatus: () => [] } };
}

test('ws_send_message：dispatch 接受 toSessionIds / taskId / result', async (t) => {
  const node = makeDispatchNode(t);
  const created = node.service.create({ mode: 'dispatch', name: '工具', sessionId: 'master-1' });
  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1'] });
  const result = await sendMessageTool().handler({
    collabId: created.collabId, text: '执行', type: 'task', toSessionIds: ['worker-1'], taskId: 't-1',
  }, contextOf(node, 'master-1'));
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /"delivered": 1/);
  const empty = await sendMessageTool().handler({
    collabId: created.collabId, text: 'x', toSessionIds: [],
  }, contextOf(node, 'master-1'));
  assert.equal(empty.isError, true, '显式空数组不等于省略');
  assert.match(empty.content[0].text, /toSessionIds 非法/);
});

test('ws_send_message：requireAck 走工具面，目标会话用 ackFor 回执', async (t) => {
  const node = makeDispatchNode(t);
  const created = node.service.create({ mode: 'dispatch', name: '工具确认', sessionId: 'master-1' });
  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1'] });
  const sent = await sendMessageTool().handler({
    collabId: created.collabId, text: '任务', type: 'task', toSessionIds: ['worker-1'], requireAck: true,
  }, contextOf(node, 'master-1'));
  assert.equal(sent.isError, undefined);
  const payload = JSON.parse(sent.content[0].text);
  assert.equal(payload.delivery.ack.required, true);
  const msgId = payload.delivery.ack.pending[0];
  const acked = await sendMessageTool().handler({
    collabId: created.collabId, text: '收到', ackFor: msgId,
  }, contextOf(node, 'worker-1'));
  assert.equal(acked.isError, undefined);
  assert.equal(JSON.parse(acked.content[0].text).acked, true);
  const badShape = await sendMessageTool().handler({
    collabId: created.collabId, text: 'x', ackFor: 'bad id!',
  }, contextOf(node, 'worker-1'));
  assert.equal(badShape.isError, true);
  assert.match(badShape.content[0].text, /ackFor 非法/);
});

test('ws_send_message：非 dispatch 拒绝 toSessionIds / taskId 与 ack 字段', async () => {
  const context = { collab: { dispatch: { isDispatch: () => false } }, sessionId: 'master-1', net: {} };
  const toSessionIds = await sendMessageTool().handler({ collabId: 'collab-managed', text: 'x', toSessionIds: ['worker-1'], taskId: 't-1' }, context);
  assert.equal(toSessionIds.isError, true);
  assert.match(toSessionIds.content[0].text, /只用于 dispatch/);
  const ack = await sendMessageTool().handler({ collabId: 'collab-managed', text: 'x', requireAck: true }, context);
  assert.equal(ack.isError, true);
  assert.match(ack.content[0].text, /只用于 dispatch/);
});

test('ws_send_message：非 dispatch 拒绝 toSessionIds / taskId（既有口径）', async () => {
  const result = await sendMessageTool().handler({
    collabId: 'collab-managed', text: 'x', toSessionIds: ['worker-1'], taskId: 't-1',
  }, { collab: { dispatch: { isDispatch: () => false } }, sessionId: 'master-1', net: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /只用于 dispatch/);
});

test('dispatch 的 check_inbox / delivery_status / view_ledger 返回明确空结果', async (t) => {
  const node = makeDispatchNode(t);
  const created = node.service.create({ mode: 'dispatch', name: '工具', sessionId: 'master-1' });
  const inbox = await checkInboxTool().handler({ collabId: created.collabId }, contextOf(node, 'master-1'));
  assert.match(inbox.content[0].text, /不保存收件历史/);
  const delivery = await deliveryStatusTool().handler({ collabId: created.collabId }, contextOf(node, 'master-1'));
  assert.match(delivery.content[0].text, /无持久投递账/);
  const ledger = await viewLedgerTool().handler({ collabId: created.collabId }, contextOf(node, 'master-1'));
  assert.match(ledger.content[0].text, /不保存历史/);
});

test('ws_create_collab：dispatch 的 autoClaim 透传服务层（工具层不得吞参）', async (t) => {
  const node = makeDispatchNode(t, { config: { dispatchClaimConfirmation: false } });
  const result = await createCollabTool().handler({
    name: '透传', mode: 'dispatch', autoClaim: true,
  }, contextOf(node, 'master-1'));
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /"autoClaim": true/);
  const bound = node.service.dispatch.status().dispatch.slaves.map((slave) => slave.sessionId);
  assert.deepEqual(bound.sort(), ['human-1', 'worker-1'], '创建即自动收编一轮');
});
