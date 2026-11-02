import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDispatchNode } from './helpers/dispatch.js';
import { DEFAULT_TASK_STALE_MS, taskStaleMsOf } from '../src/dispatch-config.js';

/* 问题 6-A：任务超时提醒（config.dispatch.task_stale_ms，默认 30 分钟）。
 * sweep 对 assigned / active 且最后进度超时的任务向调度长投一次 dispatch-task-stale；
 * 同一任务只提醒一次，有新 progress 才清位；不改任务状态、不自动失败。 */

/* master_timeout_ms 拉到 1 小时：长跨度推进时间时不触发调度长心跳待接管。 */
function setup(t, config = {}) {
  const node = makeDispatchNode(t, { config: { dispatch: { master_timeout_ms: 3600000, ...config } } });
  const created = node.service.create({ mode: 'dispatch', name: '超时', sessionId: 'master-1' });
  assert.equal(created.ok, true, String(created.message));
  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1'] });
  return { node, collabId: created.collabId };
}

function staleNotices(node) {
  return node.notices.filter((entry) => entry.payload?.event === 'dispatch-task-stale');
}

test('默认 30 分钟：assigned/active 任务超时向调度长投一次 dispatch-task-stale', async (t) => {
  const { node, collabId } = setup(t);
  await node.service.dispatch.send({
    collabId, sessionId: 'master-1', type: 'task', toSessionIds: ['worker-1'], taskId: 't1', text: '跑测试',
  });
  node.advance(30 * 60 * 1000 - 1);
  node.service.dispatch.sweep(node.now());
  assert.equal(staleNotices(node).length, 0, '未到阈值不提醒');

  node.advance(1);
  node.service.dispatch.sweep(node.now());
  const notices = staleNotices(node);
  assert.equal(notices.length, 1, '到阈值提醒一次');
  assert.equal(notices[0].payload.targetSessionId, 'master-1');
  assert.match(notices[0].payload.text, /t1/);
  assert.match(notices[0].payload.text, /worker-1/);
  assert.match(notices[0].payload.text, /跑测试/);

  node.service.dispatch.sweep(node.now());
  node.advance(60 * 1000);
  node.service.dispatch.sweep(node.now());
  assert.equal(staleNotices(node).length, 1, '同一任务只提醒一次');
});

test('新 progress 清位：再次超过阈值后可再次提醒', async (t) => {
  const { node, collabId } = setup(t, { task_stale_ms: 60000 });
  await node.service.dispatch.send({
    collabId, sessionId: 'master-1', type: 'task', toSessionIds: ['worker-1'], taskId: 't1', text: '开工',
  });
  node.advance(60000);
  node.service.dispatch.sweep(node.now());
  assert.equal(staleNotices(node).length, 1);
  const record = node.service.dispatch.dispatches.get(collabId);
  assert.equal(record.tasks.get('t1').staleNotified, true);

  await node.service.dispatch.send({
    collabId, sessionId: 'worker-1', type: 'progress', taskId: 't1', text: '做到一半',
  });
  assert.equal(record.tasks.get('t1').staleNotified, false, '新 progress 清 staleNotified');
  node.service.dispatch.sweep(node.now());
  assert.equal(staleNotices(node).length, 1, '刚有 progress 不重复提醒');

  node.advance(60000);
  node.service.dispatch.sweep(node.now());
  assert.equal(staleNotices(node).length, 2, '再次超时可再次提醒');
  assert.match(staleNotices(node)[1].payload.text, /做到一半/, '提醒含最后进度摘要');
});

test('完成 / 失败的任务不提醒；提醒不改任务状态', async (t) => {
  const { node, collabId } = setup(t, { task_stale_ms: 60000 });
  await node.service.dispatch.send({
    collabId, sessionId: 'master-1', type: 'task', toSessionIds: ['worker-1'], taskId: 'done-1', text: '任务一',
  });
  await node.service.dispatch.send({
    collabId, sessionId: 'worker-1', type: 'result', taskId: 'done-1', text: '完成',
  });
  await node.service.dispatch.send({
    collabId, sessionId: 'master-1', type: 'task', toSessionIds: ['worker-1'], taskId: 'failed-1', text: '任务二',
  });
  await node.service.dispatch.send({
    collabId, sessionId: 'worker-1', type: 'error', taskId: 'failed-1', text: '失败',
  });
  await node.service.dispatch.send({
    collabId, sessionId: 'master-1', type: 'task', toSessionIds: ['worker-1'], taskId: 'active-1', text: '任务三',
  });
  await node.service.dispatch.send({
    collabId, sessionId: 'worker-1', type: 'progress', taskId: 'active-1', text: '进行中',
  });
  node.advance(60000);
  node.service.dispatch.sweep(node.now());
  const notices = staleNotices(node);
  assert.equal(notices.length, 1, '只提醒在途任务');
  assert.match(notices[0].payload.text, /active-1/);
  assert.doesNotMatch(notices[0].payload.text, /done-1/);
  assert.doesNotMatch(notices[0].payload.text, /failed-1/);
  const record = node.service.dispatch.dispatches.get(collabId);
  assert.equal(record.tasks.get('active-1').status, 'active', '提醒不改变任务状态');
  assert.equal(record.tasks.get('done-1').status, 'done');
});

test('配置 task_stale_ms 覆盖默认值；非法值回落默认 30 分钟', async (t) => {
  const { node, collabId } = setup(t, { task_stale_ms: 60000 });
  await node.service.dispatch.send({
    collabId, sessionId: 'master-1', type: 'task', toSessionIds: ['worker-1'], taskId: 't1', text: 'x',
  });
  node.advance(59999);
  node.service.dispatch.sweep(node.now());
  assert.equal(staleNotices(node).length, 0);
  node.advance(1);
  node.service.dispatch.sweep(node.now());
  assert.equal(staleNotices(node).length, 1);

  assert.equal(taskStaleMsOf({}), DEFAULT_TASK_STALE_MS);
  assert.equal(taskStaleMsOf({ dispatch: { task_stale_ms: 60000 } }), 60000);
  assert.equal(taskStaleMsOf({ dispatch: { task_stale_ms: 86400000 } }), 86400000);
  assert.equal(taskStaleMsOf({ dispatch: { task_stale_ms: 59999 } }), DEFAULT_TASK_STALE_MS);
  assert.equal(taskStaleMsOf({ dispatch: { task_stale_ms: 86400001 } }), DEFAULT_TASK_STALE_MS);
  assert.equal(taskStaleMsOf({ dispatch: { task_stale_ms: '60000' } }), DEFAULT_TASK_STALE_MS);
});

test('非法 task_stale_ms 在实际 sweep 中按默认 30 分钟生效', async (t) => {
  const { node, collabId } = setup(t, { task_stale_ms: 1000 });
  await node.service.dispatch.send({
    collabId, sessionId: 'master-1', type: 'task', toSessionIds: ['worker-1'], taskId: 't1', text: 'x',
  });
  node.advance(60000);
  node.service.dispatch.sweep(node.now());
  assert.equal(staleNotices(node).length, 0, '非法配置不得把阈值降成 1 秒');
});
