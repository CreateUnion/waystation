import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeDispatchNode } from './helpers/dispatch.js';
import { makeTempDir } from './helpers.js';
import { sendMessageTool } from '../src/tools/collab.js';

/* 问题 5-A / 5-C：evidence（仅 dispatch result）与 acceptance（仅 dispatch task）。
 * 不强制 evidence（无证据的 result 仍接受）；两者随任务表持久化进 state.json（v1 增量字段，版本不升）。 */

function setup(t, options = {}) {
  const node = makeDispatchNode(t, options);
  const created = node.service.create({ mode: 'dispatch', name: '证据', sessionId: 'master-1' });
  assert.equal(created.ok, true, String(created.message));
  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1'] });
  return { node, collabId: created.collabId };
}

function payloadOf(result) {
  return JSON.parse(result.content[0].text);
}

const EVIDENCE = {
  commit: 'abc1234',
  tests: { pass: 10, fail: 0, command: 'npm test' },
  artifacts: ['dist/waystation.js'],
  gates: ['lint', 'typecheck'],
};

test('task 带 acceptance：随任务投递、存入任务表并持久化', async (t) => {
  const dataDir = makeTempDir(t);
  const { node, collabId } = setup(t, { dataDir, config: { dispatch: { persist: true } } });
  const acceptance = ['npm run lint', 'node --test test/dispatch-*.test.js'];
  const sent = await node.service.dispatch.send({
    collabId, sessionId: 'master-1', type: 'task', toSessionIds: ['worker-1'], taskId: 't1', text: '做实现', acceptance,
  });
  assert.equal(sent.ok, true, String(sent.message ?? ''));
  const frame = node.notices.find((entry) => entry.payload?.taskId === 't1');
  assert.ok(frame);
  assert.match(frame.payload.text, /验收标准/);
  assert.match(frame.payload.text, /npm run lint/);
  assert.deepEqual(frame.payload.acceptance, acceptance, '验收标准随帧投递');
  const task = node.service.dispatch.dispatches.get(collabId).tasks.get('t1');
  assert.deepEqual(task.acceptance, acceptance);
  const persisted = JSON.parse(readFileSync(join(dataDir, 'dispatch', 'state.json'), 'utf8'));
  assert.deepEqual(persisted.dispatch.tasks[0].acceptance, acceptance);
  assert.equal(persisted.v, 1, 'schema 版本不升');
});

test('result 带 evidence：接受、原样展示给调度长、存入 evidenceRef 并持久化', async (t) => {
  const dataDir = makeTempDir(t);
  const { node, collabId } = setup(t, { dataDir, config: { dispatch: { persist: true } } });
  await node.service.dispatch.send({
    collabId, sessionId: 'master-1', type: 'task', toSessionIds: ['worker-1'], taskId: 't1', text: '实现',
    acceptance: ['npm test'],
  });
  const sent = await node.service.dispatch.send({
    collabId, sessionId: 'worker-1', type: 'result', taskId: 't1', text: '完成', evidence: EVIDENCE,
  });
  assert.equal(sent.ok, true, String(sent.message ?? ''));
  const frame = node.notices.find((entry) => entry.payload?.taskId === 't1' && entry.payload?.targetSessionId === 'master-1');
  assert.ok(frame);
  assert.match(frame.payload.text, /证据/);
  assert.match(frame.payload.text, /abc1234/);
  assert.match(frame.payload.text, /10 通过/);
  assert.match(frame.payload.text, /0 失败/);
  assert.match(frame.payload.text, /npm test/);
  assert.deepEqual(frame.payload.evidence, EVIDENCE, '证据原样进入投递帧');
  const task = node.service.dispatch.dispatches.get(collabId).tasks.get('t1');
  assert.equal(task.status, 'done');
  assert.deepEqual(task.evidenceRef, EVIDENCE);

  const persisted = JSON.parse(readFileSync(join(dataDir, 'dispatch', 'state.json'), 'utf8'));
  const persistedTask = persisted.dispatch.tasks.find((entry) => entry.taskId === 't1');
  assert.deepEqual(persistedTask.evidenceRef, EVIDENCE);
  assert.deepEqual(persistedTask.acceptance, ['npm test']);
});

test('核心重启恢复：acceptance / evidenceRef 从 state.json 读回（旧文件缺字段按空）', async (t) => {
  const dataDir = makeTempDir(t);
  const first = setup(t, { dataDir, config: { dispatch: { persist: true } } });
  await first.node.service.dispatch.send({
    collabId: first.collabId, sessionId: 'master-1', type: 'task', toSessionIds: ['worker-1'],
    taskId: 't1', text: '实现', acceptance: ['npm test'],
  });
  await first.node.service.dispatch.send({
    collabId: first.collabId, sessionId: 'worker-1', type: 'result', taskId: 't1', text: '完成', evidence: EVIDENCE,
  });

  const restarted = makeDispatchNode(t, {
    dataDir, now: first.node.now(), config: { dispatch: { persist: true } }, meta: [...first.node.meta],
  });
  const task = restarted.service.dispatch.dispatches.get(first.collabId).tasks.get('t1');
  assert.deepEqual(task.acceptance, ['npm test']);
  assert.deepEqual(task.evidenceRef, EVIDENCE);
});

test('evidence 仅限 result：progress / task / error 明确拒绝（evidence-not-allowed）', async (t) => {
  const { node, collabId } = setup(t);
  for (const overrides of [
    { sessionId: 'worker-1', type: 'progress', text: 'x' },
    { sessionId: 'master-1', type: 'task', toSessionIds: ['worker-1'], text: 'x' },
    { sessionId: 'worker-1', type: 'error', text: 'x' },
  ]) {
    const rejected = await node.service.dispatch.send({ collabId, evidence: EVIDENCE, ...overrides });
    assert.equal(rejected.ok, false, JSON.stringify(overrides));
    assert.equal(rejected.code, 'evidence-not-allowed', JSON.stringify(overrides));
  }
});

test('acceptance 仅限 task：progress / result / error 明确拒绝（acceptance-not-allowed）', async (t) => {
  const { node, collabId } = setup(t);
  for (const overrides of [
    { sessionId: 'worker-1', type: 'progress', text: 'x' },
    { sessionId: 'worker-1', type: 'result', text: 'x' },
    { sessionId: 'worker-1', type: 'error', text: 'x' },
  ]) {
    const rejected = await node.service.dispatch.send({ collabId, acceptance: ['标准'], ...overrides });
    assert.equal(rejected.ok, false, JSON.stringify(overrides));
    assert.equal(rejected.code, 'acceptance-not-allowed', JSON.stringify(overrides));
  }
});

test('evidence 形态逐项校验：非法形态返回 invalid-evidence', async (t) => {
  const { node, collabId } = setup(t);
  const cases = [
    'bad',
    null,
    [],
    {},
    { commit: '' },
    { commit: 123 },
    { commit: 'a'.repeat(129) },
    { commit: 'ok', extra: true },
    { tests: 'yes' },
    { tests: { pass: 1 } },
    { tests: { pass: '1', fail: 0 } },
    { tests: { pass: -1, fail: 0 } },
    { tests: { pass: 1, fail: 0, extra: true } },
    { tests: { pass: 1, fail: 0, command: '' } },
    { artifacts: 'dist' },
    { artifacts: [''] },
    { artifacts: [1] },
    { artifacts: Array.from({ length: 21 }, () => 'a') },
    { gates: [{}] },
  ];
  for (const evidence of cases) {
    const rejected = await node.service.dispatch.send({
      collabId, sessionId: 'worker-1', type: 'result', text: '完成', evidence,
    });
    assert.equal(rejected.ok, false, JSON.stringify(evidence));
    assert.equal(rejected.code, 'invalid-evidence', JSON.stringify(evidence));
  }
});

test('acceptance 形态校验：非数组 / 空项 / 非字符串 / 超 20 项返回 invalid-acceptance', async (t) => {
  const { node, collabId } = setup(t);
  const cases = ['bad', null, [], ['ok', ''], [1], Array.from({ length: 21 }, () => 'a')];
  for (const acceptance of cases) {
    const rejected = await node.service.dispatch.send({
      collabId, sessionId: 'master-1', type: 'task', toSessionIds: ['worker-1'], text: 'x', acceptance,
    });
    assert.equal(rejected.ok, false, JSON.stringify(acceptance));
    assert.equal(rejected.code, 'invalid-acceptance', JSON.stringify(acceptance));
  }
});

test('不强制证据：result 不带 evidence 仍接受', async (t) => {
  const { node, collabId } = setup(t);
  const sent = await node.service.dispatch.send({
    collabId, sessionId: 'worker-1', type: 'result', taskId: 't1', text: '完成（纯调研，无测试产物）',
  });
  assert.equal(sent.ok, true);
  assert.equal(node.service.dispatch.dispatches.get(collabId).tasks.get('t1').evidenceRef, null);
});

test('managed / forum 使用 evidence / acceptance 明确拒绝（不静默忽略）', async () => {
  for (const [field, value, code] of [
    ['evidence', EVIDENCE, 'evidence-not-allowed'],
    ['acceptance', ['npm test'], 'acceptance-not-allowed'],
  ]) {
    const result = await sendMessageTool().handler(
      { collabId: 'c1', text: '正文', [field]: value },
      { collab: { dispatch: { isDispatch: () => false }, send: async () => ({ ok: true }) }, sessionId: 's1' },
    );
    assert.equal(result.isError, true, field);
    assert.equal(payloadOf(result).code, code, field);
  }
});

test('工具层 dispatch：task 带 acceptance / result 带 evidence 可发送', async (t) => {
  const { node, collabId } = setup(t);
  const task = await sendMessageTool().handler(
    { collabId, text: '实现', type: 'task', toSessionIds: ['worker-1'], taskId: 't-tool', acceptance: ['npm test'] },
    { collab: node.service, sessionId: 'master-1' },
  );
  assert.equal(task.isError, undefined);
  const result = await sendMessageTool().handler(
    { collabId, text: '完成', type: 'result', taskId: 't-tool', evidence: EVIDENCE },
    { collab: node.service, sessionId: 'worker-1' },
  );
  assert.equal(result.isError, undefined);
  const taskFrame = node.notices.find((entry) => entry.payload?.taskId === 't-tool' && entry.payload?.targetSessionId === 'worker-1');
  assert.match(taskFrame.payload.text, /验收标准/);
  assert.match(taskFrame.payload.text, /npm test/);
  const resultFrame = node.notices.find((entry) => entry.payload?.taskId === 't-tool' && entry.payload?.targetSessionId === 'master-1');
  assert.match(resultFrame.payload.text, /证据/);
  assert.deepEqual(node.service.dispatch.dispatches.get(collabId).tasks.get('t-tool').evidenceRef, EVIDENCE);
});

test('工具层 dispatch：evidence / acceptance 与显式非法 type 组合先拒绝', async (t) => {
  const { node, collabId } = setup(t);
  const evidenceOnTask = await sendMessageTool().handler(
    { collabId, text: 'x', type: 'task', evidence: EVIDENCE },
    { collab: node.service, sessionId: 'master-1' },
  );
  assert.equal(payloadOf(evidenceOnTask).code, 'evidence-not-allowed');
  const acceptanceOnResult = await sendMessageTool().handler(
    { collabId, text: 'x', type: 'result', acceptance: ['npm test'] },
    { collab: node.service, sessionId: 'worker-1' },
  );
  assert.equal(payloadOf(acceptanceOnResult).code, 'acceptance-not-allowed');
});
