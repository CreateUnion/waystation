import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DISPATCH_MEMBER_EVENT_DEBOUNCE_MS } from '../src/collab/dispatch.js';
import { makeDispatchNode } from './helpers/dispatch.js';

/* 成员事件去抖窗口是真实定时器（与假 now 无关），测试按窗口 + 余量等待。 */
function pastDebounce() {
  return new Promise((resolve) => setTimeout(resolve, DISPATCH_MEMBER_EVENT_DEBOUNCE_MS + 150));
}

test('master 断开宽限内保留；超时后进入待接管、slave 收到通知（不再直接结束）', (t) => {
  const node = makeDispatchNode(t);
  const created = node.service.create({ mode: 'dispatch', name: '宽限', sessionId: 'master-1' });
  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1'] });
  node.service.dispatch.noteBridgeClosed('master-1');
  node.advance(500);
  node.service.dispatch.sweep(node.now());
  assert.equal(node.service.dispatch.status().dispatch.collabId, created.collabId);
  node.advance(600);
  node.service.dispatch.sweep(node.now());
  const record = node.service.dispatch.dispatches.get(created.collabId);
  assert.equal(record.status, 'pending-takeover');
  assert.equal(node.notices.some((entry) => entry.payload?.event === 'dispatch-takeover-pending'), true);
  assert.equal(node.notices.some((entry) => entry.payload?.event === 'dispatch-ended'), false);
});

test('slave 断开宽限内重连保留；超时移除并通知 master', (t) => {
  const node = makeDispatchNode(t);
  node.service.create({ mode: 'dispatch', name: 'slave 宽限', sessionId: 'master-1' });
  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1'] });
  node.service.dispatch.noteBridgeClosed('worker-1');
  node.advance(500);
  node.service.dispatch.noteBridgeOnline('worker-1');
  node.service.dispatch.sweep(node.now());
  assert.equal(node.service.dispatch.status().dispatch.slaves.length, 1);
  node.service.dispatch.noteBridgeClosed('worker-1');
  node.advance(1100);
  node.service.dispatch.sweep(node.now());
  assert.equal(node.service.dispatch.status().dispatch.slaves.length, 0);
  assert.equal(node.notices.some((entry) => entry.payload?.event === 'dispatch-member-left'), true);
});

test('核心重启：新服务实例的 state.dispatches 为空，工具返回 dispatch-lost', (t) => {
  const node = makeDispatchNode(t);
  const created = node.service.create({ mode: 'dispatch', name: '重启', sessionId: 'master-1' });
  const restarted = makeDispatchNode(t, { now: node.now() });
  assert.equal(restarted.service.dispatch.status().dispatch, null);
  const lost = restarted.service.dispatch.scan({ sessionId: 'master-1' });
  assert.equal(lost.code, 'dispatch-lost');
  assert.equal(restarted.service.dispatch.isDispatch(created.collabId), false);
});

test('服务桥注册/注销接线：注销登记宽限，注册撤销宽限且不丢收编成员', async (t) => {
  const node = makeDispatchNode(t);
  const created = node.service.create({ mode: 'dispatch', name: '接线', sessionId: 'master-1' });
  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1'] });
  const record = node.service.dispatch.dispatches.get(created.collabId);
  node.service.unregisterBridgeEntry('worker-1');
  assert.equal(record.grace.has('worker-1'), true, '桥注销必须登记宽限');
  await node.service.registerBridgeEntry('worker-1', 'bridge-1');
  assert.equal(record.grace.has('worker-1'), false, '宽限内重连必须撤销宽限');
  node.service.unregisterBridgeEntry('worker-1', 'bridge-1');
  assert.equal(record.grace.has('worker-1'), true, '当前桥注销重新登记宽限');
  assert.equal(node.service.dispatch.status().dispatch.slaves.length, 1, '宽限不等于立即释放成员');
});

test('注册让出期内断开：迟到续体不得撤销宽限或补投队列，宽限后正常移除', async (t) => {
  const node = makeDispatchNode(t, { notifyResult: false });
  const created = node.service.create({ mode: 'dispatch', name: '窗口断连', sessionId: 'master-1' });
  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1'] });
  const record = node.service.dispatch.dispatches.get(created.collabId);
  node.service.dispatch.send({ collabId: created.collabId, sessionId: 'master-1', text: '断连排队', toSessionIds: ['worker-1'] });
  assert.equal(record.queues.has('worker-1'), true, '前置：通知失败已入待补投队列');
  const registering = node.service.registerBridgeEntry('worker-1', 'bridge-window');
  node.service.unregisterBridgeEntry('worker-1', 'bridge-window');
  assert.equal(record.grace.has('worker-1'), true, '断开即刻登记宽限');
  const late = await registering;
  assert.equal(late.ok, false, '让出期内被断开的注册续体不得收手为成功');
  assert.equal(late.reason, 'bridge-superseded');
  assert.equal(record.grace.has('worker-1'), true, '迟到续体不得撤销断开方登记的宽限（否则 slave 永不释放）');
  assert.equal(record.queues.has('worker-1'), true, '迟到续体不得补投断连期间的队列');
  node.advance(1100);
  node.service.dispatch.sweep(node.now());
  assert.equal(
    node.service.dispatch.status().dispatch.slaves.some((slave) => slave.sessionId === 'worker-1'),
    false,
    '宽限超时后 slave 正常移除',
  );
  assert.equal(record.queues.has('worker-1'), false, '宽限超时回收待补投队列');
});

test('服务 presence 清扫接线：start 的清扫节拍把超时 master 标为待接管', (t) => {
  const node = makeDispatchNode(t);
  const created = node.service.create({ mode: 'dispatch', name: '节拍', sessionId: 'master-1' });
  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1'] });
  node.service.unregisterBridgeEntry('master-1');
  node.advance(1100);
  node.service.start();
  assert.equal(
    node.service.dispatch.dispatches.get(created.collabId)?.status,
    'pending-takeover',
    'presence 节拍须驱动 dispatch.sweep',
  );
  assert.equal(node.notices.some((entry) => entry.payload?.event === 'dispatch-takeover-pending'), true);
  node.service.close();
});

test('成员事件去抖：500ms 内的加入事件合并为一条 dispatch-member-event', async (t) => {
  const node = makeDispatchNode(t);
  node.service.create({ mode: 'dispatch', name: '事件', sessionId: 'master-1' });
  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1', 'human-1'] });
  const claimId = node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['human-1'] }).results[0].claimId;
  const first = node.service.dispatch.approve({ sessionId: 'human-1', claimId, approve: true });
  node.service.dispatch.approve({ sessionId: 'human-1', claimId, approve: true, confirmToken: first.confirmToken });
  assert.equal(
    node.notices.some((entry) => entry.payload?.event === 'dispatch-member-joined'),
    false,
    '加入事件不得再直发单条通知（否则与合并事件重复）',
  );
  await pastDebounce();
  const merged = node.notices.filter((entry) => entry.payload?.event === 'dispatch-member-event');
  assert.equal(merged.length, 1, '同一个去抖窗口只合并出一条成员事件');
  assert.match(merged[0].payload.text, /「worker-1」已加入/);
  assert.match(merged[0].payload.text, /「human」已加入/);
  assert.equal(merged[0].payload.targetSessionId, 'master-1');
});

test('多个 slave 同批宽限超时：合并为一条成员事件，不逐条直发', async (t) => {
  const node = makeDispatchNode(t, {
    meta: [['worker-2', {
      sessionId: 'worker-2', role: 'slave', name: 'worker-2', kind: 'bg', entrypoint: 'sdk-cli', status: 'idle', metaUpdatedAt: 1000,
    }]],
  });
  node.service.create({ mode: 'dispatch', name: '批量', sessionId: 'master-1' });
  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1', 'worker-2'] });
  node.service.dispatch.noteBridgeClosed('worker-1');
  node.service.dispatch.noteBridgeClosed('worker-2');
  node.advance(1100);
  node.service.dispatch.sweep(node.now());
  assert.equal(node.service.dispatch.status().dispatch.slaves.length, 0);
  assert.equal(
    node.notices.some((entry) => entry.payload?.event === 'dispatch-member-left'),
    false,
    '同批超时走合并事件，不逐条直发 member-left',
  );
  await pastDebounce();
  const merged = node.notices.filter(
    (entry) => entry.payload?.event === 'dispatch-member-event' && entry.payload.text.includes('宽限超时'),
  );
  assert.equal(merged.length, 1, '同批超时合并为一条');
  assert.match(merged[0].payload.text, /「worker-1」宽限超时离席/);
  assert.match(merged[0].payload.text, /「worker-2」宽限超时离席/);
});
