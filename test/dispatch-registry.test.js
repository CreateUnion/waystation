import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeDispatchNode } from './helpers/dispatch.js';

test('创建：只有 WAYSTATION_ROLE=master 的会话能创建；一个核心只允许一个 dispatch', (t) => {
  const node = makeDispatchNode(t);
  const denied = node.service.create({ mode: 'dispatch', name: 'dispatch', sessionId: 'human-1' });
  assert.equal(denied.ok, false, '无 master 角色的人工会话不能创建');
  const created = node.service.create({ mode: 'dispatch', name: 'dispatch', sessionId: 'master-1' });
  assert.equal(created.ok, true, String(created.message));
  assert.equal(created.mode, 'dispatch');
  assert.equal(created.ephemeral, true);
  const second = node.service.create({ mode: 'dispatch', name: 'again', sessionId: 'master-1' });
  assert.equal(second.ok, false, '同一核心只允许一个 dispatch');
});

test('创建：纯内存，不进 state.collabs，不写 collabs/ 目录', (t) => {
  const node = makeDispatchNode(t);
  const created = node.service.create({ mode: 'dispatch', name: '纯内存', sessionId: 'master-1' });
  assert.equal(created.ok, true, String(created.message));
  assert.equal(node.service.list().collabs.some((entry) => entry.collabId === created.collabId && entry.mode === 'dispatch'), true);
  assert.equal(existsSync(join(node.dataDir, 'collabs', created.collabId)), false, 'dispatch 不得建协作目录');
  const collabsDir = join(node.dataDir, 'collabs');
  assert.deepEqual(existsSync(collabsDir) ? readdirSync(collabsDir).filter((name) => name === created.collabId) : [], []);
});

test('scan：排除 master 自身，返回名字 / kind / role / status / claimedBy', (t) => {
  const node = makeDispatchNode(t);
  const created = node.service.create({ mode: 'dispatch', name: '扫描', sessionId: 'master-1' });
  const scanned = node.service.dispatch.scan({ sessionId: 'master-1' });
  assert.equal(scanned.ok, true);
  assert.equal(scanned.dispatchId, created.collabId);
  assert.equal(scanned.sessions.some((entry) => entry.sessionId === 'master-1'), false);
  const human = scanned.sessions.find((entry) => entry.sessionId === 'human-1');
  assert.deepEqual(human, {
    sessionId: 'human-1', name: 'human', kind: 'interactive', entrypoint: 'cli',
    role: 'none', status: 'idle', claimedBy: null,
  });
});

test('describe / view / status：dispatch 不退化为讨论、不造空台账', (t) => {
  const node = makeDispatchNode(t);
  const created = node.service.create({ mode: 'dispatch', name: '描述', topic: '主题', sessionId: 'master-1' });
  assert.deepEqual(node.service.describe(created.collabId), {
    collabId: created.collabId, name: '描述', mode: 'dispatch', ephemeral: true, topic: '主题',
  });
  const view = node.service.view({ collabId: created.collabId });
  assert.equal(view.ok, true);
  assert.equal(view.mode, 'dispatch');
  assert.equal(view.ephemeral, true);
  assert.match(view.message, /不保存历史/);
  assert.equal(node.service.dispatch.status().dispatch.collabId, created.collabId);
  assert.equal(node.service.dispatch.isDispatch(created.collabId), true);
});
