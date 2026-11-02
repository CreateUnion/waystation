import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDispatchNode } from './helpers/dispatch.js';
import { DEFAULT_MESSAGE_LIMITS_CONFIG, messageLimitsOf } from '../src/dispatch-config.js';

/* 问题 2-A：dispatch 消息长度上限（config.dispatch.message_limits）。
 * 超限拒绝（message-too-long，不截断、不静默丢弃）；仅 dispatch 生效。 */

function setup(t, config = {}) {
  const node = makeDispatchNode(t, { config });
  const created = node.service.create({ mode: 'dispatch', name: '长度', sessionId: 'master-1' });
  assert.equal(created.ok, true, String(created.message));
  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1'] });
  return { node, collabId: created.collabId };
}

function send(node, collabId, overrides = {}) {
  return node.service.dispatch.send({
    collabId, sessionId: 'master-1', type: 'progress', toSessionIds: ['worker-1'], ...overrides,
  });
}

test('默认上限：progress 800 / result 3000 / 其他类型 text 4000；边界值接受、超一格拒绝', async (t) => {
  const { node, collabId } = setup(t);

  assert.equal((await send(node, collabId, { text: 'p'.repeat(800) })).ok, true, 'progress 800 可发');
  const progress = await send(node, collabId, { text: 'p'.repeat(801) });
  assert.equal(progress.ok, false);
  assert.equal(progress.code, 'message-too-long');
  assert.match(progress.message, /801/);
  assert.match(progress.message, /800/);

  assert.equal((await send(node, collabId, { type: 'result', text: 'r'.repeat(3000) })).ok, true, 'result 3000 可发');
  const result = await send(node, collabId, { type: 'result', text: 'r'.repeat(3001) });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'message-too-long');

  assert.equal((await send(node, collabId, { type: 'error', text: 'e'.repeat(4000) })).ok, true, '其他类型 4000 可发');
  const other = await send(node, collabId, { type: 'error', text: 'e'.repeat(4001) });
  assert.equal(other.ok, false);
  assert.equal(other.code, 'message-too-long');
});

test('超限提示写文件后发摘要 + 路径，且不投递、不落任务表', async (t) => {
  const { node, collabId } = setup(t);
  const before = node.notices.length;
  const rejected = await send(node, collabId, { text: 'x'.repeat(801), taskId: 't-long' });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'message-too-long');
  assert.match(rejected.hint, /文件/);
  assert.match(rejected.hint, /路径/);
  assert.equal(node.notices.length, before, '超限消息不得投递');
  assert.equal(node.service.dispatch.dispatches.get(collabId).tasks.has('t-long'), false, '超限消息不得改变任务表');
});

test('配置覆盖：合法的 message_limits 逐项生效', async (t) => {
  const { node, collabId } = setup(t, {
    dispatch: { message_limits: { progress: 100, result: 200, text: 300 } },
  });
  assert.equal((await send(node, collabId, { text: 'p'.repeat(100) })).ok, true);
  assert.equal((await send(node, collabId, { text: 'p'.repeat(101) })).code, 'message-too-long');
  assert.equal((await send(node, collabId, { type: 'result', text: 'r'.repeat(200) })).ok, true);
  assert.equal((await send(node, collabId, { type: 'result', text: 'r'.repeat(201) })).code, 'message-too-long');
  assert.equal((await send(node, collabId, { type: 'error', text: 'e'.repeat(300) })).ok, true);
  assert.equal((await send(node, collabId, { type: 'error', text: 'e'.repeat(301) })).code, 'message-too-long');
});

test('配置非法：逐项回落默认值（64–20000 之外的整数也回落）', () => {
  assert.deepEqual(messageLimitsOf({}), DEFAULT_MESSAGE_LIMITS_CONFIG);
  assert.deepEqual(
    messageLimitsOf({ dispatch: { message_limits: { progress: 10, result: 'x', text: 500 } } }),
    { progress: 800, result: 3000, text: 500 },
    '非法项各自回落，合法项保留',
  );
  assert.deepEqual(
    messageLimitsOf({ dispatch: { message_limits: { progress: 64, result: 20000, text: 4000 } } }),
    { progress: 64, result: 20000, text: 4000 },
    '边界值合法',
  );
  assert.deepEqual(
    messageLimitsOf({ dispatch: { message_limits: 'on' } }),
    DEFAULT_MESSAGE_LIMITS_CONFIG,
    '整段类型错回落默认',
  );
});
