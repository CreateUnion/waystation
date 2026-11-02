import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDispatchNode } from './helpers/dispatch.js';
import { sendMessageTool } from '../src/tools/collab.js';

/* 问题 2-B：结构化报告 report（仅 dispatch 的 progress / result）。
 * 带 report 时 text 可为空，正文由 report 渲染；report 进入投递文本与任务表 lastProgress。 */

function setup(t) {
  const node = makeDispatchNode(t);
  const created = node.service.create({ mode: 'dispatch', name: '报告', sessionId: 'master-1' });
  assert.equal(created.ok, true, String(created.message));
  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1'] });
  return { node, collabId: created.collabId };
}

function payloadOf(result) {
  return JSON.parse(result.content[0].text);
}

test('progress 带 report 且 text 为空：正文按 report 渲染并投递', async (t) => {
  const { node, collabId } = setup(t);
  const report = { summary: '接口层完成', done: ['实现 A', '实现 B'], blockers: ['等待评审'], next: ['联调'] };
  const sent = await node.service.dispatch.send({
    collabId, sessionId: 'worker-1', type: 'progress', taskId: 't1', text: '', report,
  });
  assert.equal(sent.ok, true, String(sent.message ?? ''));
  const frame = node.notices.find((entry) => entry.payload?.taskId === 't1');
  assert.ok(frame, '必须投递');
  assert.match(frame.payload.text, /摘要：接口层完成/);
  assert.match(frame.payload.text, /已完成：/);
  assert.match(frame.payload.text, /实现 A/);
  assert.match(frame.payload.text, /受阻：/);
  assert.match(frame.payload.text, /等待评审/);
  assert.match(frame.payload.text, /下一步：/);
  assert.match(frame.payload.text, /联调/);
  assert.deepEqual(frame.payload.report, report, '结构化报告原样进入投递帧');
  const task = node.service.dispatch.dispatches.get(collabId).tasks.get('t1');
  assert.equal(task.lastProgress, '接口层完成', 'report.summary 进入任务表最后进度摘要');
  assert.equal(task.status, 'active');
});

test('result 带 report 且省略 text：接受并渲染', async (t) => {
  const { node, collabId } = setup(t);
  const sent = await node.service.dispatch.send({
    collabId, sessionId: 'worker-1', type: 'result', taskId: 't2',
    report: { summary: '完成', done: ['X'] },
  });
  assert.equal(sent.ok, true, String(sent.message ?? ''));
  const frame = node.notices.find((entry) => entry.payload?.taskId === 't2');
  assert.match(frame.payload.text, /摘要：完成/);
  assert.match(frame.payload.text, /- X/);
});

test('text 与 report 同时给出：正文同时包含两者', async (t) => {
  const { node, collabId } = setup(t);
  await node.service.dispatch.send({
    collabId, sessionId: 'worker-1', type: 'progress', text: '补充说明', report: { summary: '摘要' },
  });
  const frame = node.notices.find((entry) => entry.payload?.text.includes('补充说明'));
  assert.ok(frame);
  assert.match(frame.payload.text, /补充说明/);
  assert.match(frame.payload.text, /摘要：摘要/);
});

test('report 仅限 progress / result：task / error / 缺省 task 均拒绝（report-not-allowed）', async (t) => {
  const { node, collabId } = setup(t);
  const report = { summary: '不该允许' };
  for (const overrides of [
    { type: 'task', text: 'x' },
    { type: 'error', text: 'x' },
    { text: 'x' },   // master 缺省 type＝task
  ]) {
    const rejected = await node.service.dispatch.send({
      collabId, sessionId: 'master-1', toSessionIds: ['worker-1'], report, ...overrides,
    });
    assert.equal(rejected.ok, false, JSON.stringify(overrides));
    assert.equal(rejected.code, 'report-not-allowed', JSON.stringify(overrides));
  }
  const slaveDefaultResult = await node.service.dispatch.send({
    collabId, sessionId: 'worker-1', text: '', report: { summary: '组员缺省 result 合法' },
  });
  assert.equal(slaveDefaultResult.ok, true, '组员缺省 type＝result，允许 report');
});

test('带 report 时 text 为空串或省略均可；不带 report 时 text 仍必填', async (t) => {
  const { node, collabId } = setup(t);
  assert.equal((await node.service.dispatch.send({
    collabId, sessionId: 'worker-1', type: 'progress', text: '', report: { summary: '空串' },
  })).ok, true);
  assert.equal((await node.service.dispatch.send({
    collabId, sessionId: 'worker-1', type: 'progress', report: { summary: '省略' },
  })).ok, true);
  const empty = await node.service.dispatch.send({
    collabId, sessionId: 'worker-1', type: 'progress', text: '   ',
  });
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'invalid-message-text');
});

test('report 形态校验：非对象 / 未知键 / 超长 / 超项 / 空报告均拒绝（invalid-report）', async (t) => {
  const { node, collabId } = setup(t);
  const cases = [
    'not-an-object',
    null,
    [],
    { summary: 'x', extra: true },
    { summary: 'x'.repeat(201) },
    { done: ['x'.repeat(201)] },
    { done: Array.from({ length: 21 }, () => 'x') },
    { done: [1] },
    {},
    { summary: '   ' },
  ];
  for (const report of cases) {
    const rejected = await node.service.dispatch.send({
      collabId, sessionId: 'worker-1', type: 'progress', text: '', report,
    });
    assert.equal(rejected.ok, false, JSON.stringify(report));
    assert.equal(rejected.code, 'invalid-report', JSON.stringify(report));
  }
  const emptyButText = await node.service.dispatch.send({
    collabId, sessionId: 'worker-1', type: 'progress', text: '正文', report: {},
  });
  assert.equal(emptyButText.code, 'invalid-report', '空报告即使有 text 也拒绝（形态不合法）');
});

test('managed / forum 使用 report 明确拒绝（报告只属于 dispatch），不静默忽略', async () => {
  const result = await sendMessageTool().handler(
    { collabId: 'c1', text: '正文', report: { summary: 'x' } },
    { collab: { dispatch: { isDispatch: () => false }, send: async () => ({ ok: true }) }, sessionId: 's1' },
  );
  assert.equal(result.isError, true);
  assert.equal(payloadOf(result).code, 'report-not-allowed');
});

test('工具层 dispatch：report 与显式非法 type 组合先拒绝（report-not-allowed）', async (t) => {
  const { node, collabId } = setup(t);
  const result = await sendMessageTool().handler(
    { collabId, text: 'x', type: 'task', report: { summary: 'x' } },
    { collab: node.service, sessionId: 'master-1' },
  );
  assert.equal(result.isError, true);
  assert.equal(payloadOf(result).code, 'report-not-allowed');
});

test('工具层 dispatch：report 形态错误返回 invalid-report', async (t) => {
  const { node, collabId } = setup(t);
  const result = await sendMessageTool().handler(
    { collabId, text: '', type: 'progress', report: { done: 'not-array' } },
    { collab: node.service, sessionId: 'worker-1' },
  );
  assert.equal(result.isError, true);
  assert.equal(payloadOf(result).code, 'invalid-report');
});

test('工具层 dispatch：report-only（text 为空串）可发送并渲染', async (t) => {
  const { node, collabId } = setup(t);
  const result = await sendMessageTool().handler(
    { collabId, text: '', type: 'progress', taskId: 't-tool', report: { summary: '工具层报告', next: ['继续'] } },
    { collab: node.service, sessionId: 'worker-1' },
  );
  assert.equal(result.isError, undefined);
  assert.equal(payloadOf(result).ok, true);
  const frame = node.notices.find((entry) => entry.payload?.taskId === 't-tool');
  assert.match(frame.payload.text, /工具层报告/);
  assert.match(frame.payload.text, /继续/);
});
