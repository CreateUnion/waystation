import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeDispatchNode } from './helpers/dispatch.js';
import { makeTempDir } from './helpers.js';

/* 调度长接管（问题 3）：心跳超时后允许新 master 原地换届；旧 master 恢复即被明确拒绝；
 * 任务表与组员原样移交；宽限到期不再直接结束 dispatch。 */

const OTHER_MASTER = {
  sessionId: 'master-2', role: 'master', name: '二号', kind: 'interactive', entrypoint: 'cli', status: 'idle', metaUpdatedAt: 0,
};

function makeNode(t, options = {}) {
  const node = makeDispatchNode(t, {
    config: { dispatch: { persist: false, master_timeout_ms: 180000 }, ...(options.config ?? {}) },
    ...options,
  });
  node.meta.set('master-2', { ...OTHER_MASTER, metaUpdatedAt: node.now() });
  return node;
}

function createDispatch(node, name = '接管') {
  const created = node.service.create({ mode: 'dispatch', name, sessionId: 'master-1' });
  assert.equal(created.ok, true, String(created.message ?? ''));
  return created;
}

test('心跳未超时：新 master 创建被拒，给出剩余等待时间', (t) => {
  const node = makeNode(t);
  createDispatch(node);
  node.advance(179999);
  const refused = node.service.create({ mode: 'dispatch', name: '抢班', sessionId: 'master-2' });
  assert.equal(refused.ok, false);
  assert.match(String(refused.message), /调度长.*活跃|剩余/);
});

test('心跳超时：新 master 原地接管，collabId / 组员 / 任务表原样移交', (t) => {
  const node = makeNode(t);
  const created = createDispatch(node, '换届');
  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1'] });
  node.service.dispatch.send({
    collabId: created.collabId, sessionId: 'master-1', text: '在途任务', type: 'task', toSessionIds: ['worker-1'], taskId: 't1',
  });
  node.advance(180001);

  const taken = node.service.create({ mode: 'dispatch', name: '新名字', sessionId: 'master-2' });
  assert.equal(taken.ok, true, String(taken.message ?? ''));
  assert.equal(taken.takeover, true);
  assert.equal(taken.collabId, created.collabId, '原地换届不新建 collabId');
  assert.equal(taken.name, '换届', '保留原 dispatch 名称');
  assert.equal(taken.previousMasterSessionId, 'master-1');
  const record = node.service.dispatch.dispatches.get(created.collabId);
  assert.equal(record.masterSessionId, 'master-2');
  assert.equal(record.masterName, '二号');
  assert.equal(record.status, 'active');
  assert.equal(record.slaves.has('worker-1'), true, '组员原样移交');
  assert.equal(record.tasks.get('t1').status, 'assigned', '任务表原样移交');
  assert.equal(
    node.notices.some((frame) => frame.payload?.event === 'dispatch-takeover' && frame.payload?.targetSessionId === 'worker-1'),
    true,
    '组员收到换届通知',
  );
  assert.equal(
    node.notices.some((frame) => frame.payload?.event === 'dispatch-taken-over' && frame.payload?.targetSessionId === 'master-1'),
    true,
    '旧调度长收到明确通知',
  );
});

test('旧 master 恢复后发消息 / 再创建：明确拒绝并提示已被接管', (t) => {
  const node = makeNode(t);
  const created = createDispatch(node);
  node.advance(180001);
  assert.equal(node.service.create({ mode: 'dispatch', name: '新', sessionId: 'master-2' }).ok, true);

  const oldSend = node.service.dispatch.send({ collabId: created.collabId, sessionId: 'master-1', text: '还在吗' });
  assert.equal(oldSend.ok, false);
  assert.equal(oldSend.code, 'dispatch-taken-over');
  assert.match(String(oldSend.message), /已被接管/);
  const oldCreate = node.service.create({ mode: 'dispatch', name: '夺回', sessionId: 'master-1' });
  assert.equal(oldCreate.ok, false);
  assert.equal(oldCreate.code, 'dispatch-taken-over');
  assert.match(String(oldCreate.message), /已被接管/);
  const oldClaim = node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1'] });
  assert.equal(oldClaim.ok, false);
  assert.equal(oldClaim.code, 'dispatch-taken-over');
});

test('待接管期旧 master 恢复心跳：回到 active，新 master 不得接管', (t) => {
  const node = makeNode(t);
  createDispatch(node);
  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1'] });
  node.advance(180001);
  node.service.dispatch.sweep(node.now());
  let record = [...node.service.dispatch.dispatches.values()][0];
  assert.equal(record.status, 'pending-takeover');
  assert.equal(
    node.notices.some((frame) => frame.payload?.event === 'dispatch-takeover-pending' && frame.payload?.targetSessionId === 'master-1'),
    true,
    '待接管时通知调度长与组员',
  );

  node.service.dispatch.noteActivity('master-1', node.now());
  record = [...node.service.dispatch.dispatches.values()][0];
  assert.equal(record.status, 'active', '心跳恢复即撤销待接管');
  assert.equal(
    node.notices.some((frame) => frame.payload?.event === 'dispatch-resumed' && frame.payload?.targetSessionId === 'worker-1'),
    true,
    '恢复后向组员通告',
  );
  const refused = node.service.create({ mode: 'dispatch', name: '抢班', sessionId: 'master-2' });
  assert.equal(refused.ok, false);
});

test('master 宽限到期：标记待接管并保留 dispatch，不再直接结束', (t) => {
  const node = makeNode(t);
  const created = createDispatch(node, '失联');
  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1'] });
  node.service.dispatch.noteBridgeClosed('master-1');
  node.advance(1100);
  node.service.dispatch.sweep(node.now());
  const record = node.service.dispatch.dispatches.get(created.collabId);
  assert.ok(record, '宽限到期不得删除 dispatch');
  assert.equal(record.status, 'pending-takeover');
  assert.equal(record.slaves.has('worker-1'), true);
  assert.equal(
    node.notices.some((frame) => frame.payload?.event === 'dispatch-ended'),
    false,
    '不得再向组员发结束通知',
  );
});

test('接管后结束：新 master 可正常结束并删除状态文件', (t) => {
  const dataDir = makeTempDir(t);
  const node = makeDispatchNode(t, {
    dataDir,
    config: { dispatch: { persist: true, master_timeout_ms: 180000 } },
  });
  node.meta.set('master-2', { ...OTHER_MASTER, metaUpdatedAt: node.now() });
  const created = createDispatch(node);
  node.advance(180001);
  assert.equal(node.service.create({ mode: 'dispatch', name: '新', sessionId: 'master-2' }).ok, true);
  const ended = node.service.dispatch.end({ collabId: created.collabId, sessionId: 'master-2' });
  assert.equal(ended.ok, true);
  assert.equal(existsSync(join(dataDir, 'dispatch', 'state.json')), false, '正常结束删状态文件');
});
