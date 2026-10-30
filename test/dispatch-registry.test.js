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

test('scan：排除 master 自身，返回名字 / kind / role / status / claimedBy / claimable', (t) => {
  const node = makeDispatchNode(t);
  const created = node.service.create({ mode: 'dispatch', name: '扫描', sessionId: 'master-1' });
  const scanned = node.service.dispatch.scan({ sessionId: 'master-1' });
  assert.equal(scanned.ok, true);
  assert.equal(scanned.dispatchId, created.collabId);
  assert.equal(scanned.sessions.some((entry) => entry.sessionId === 'master-1'), false);
  const human = scanned.sessions.find((entry) => entry.sessionId === 'human-1');
  assert.deepEqual(human, {
    sessionId: 'human-1', name: 'human', kind: 'interactive', entrypoint: 'cli',
    role: 'none', status: 'idle', claimedBy: null, claimable: true,
  });
});

test('scan claimable 判定表：交互式（文件在档）或 role=slave 为 true；非交互无角色与 role=master 为 false；文件 mtime 陈旧不影响', (t) => {
  const node = makeDispatchNode(t);
  node.meta.set('other-master', { sessionId: 'other-master', role: 'master', name: 'other', kind: 'interactive', entrypoint: 'cli', status: 'idle', metaUpdatedAt: node.now() });
  node.service.create({ mode: 'dispatch', name: '判定表', sessionId: 'master-1' });
  const fresh = node.service.dispatch.scan({ sessionId: 'master-1' });
  const byId = Object.fromEntries(fresh.sessions.map((entry) => [entry.sessionId, entry]));
  assert.equal(byId['human-1'].claimable, true, '交互式＝可收编');
  assert.equal(byId['worker-1'].claimable, true, 'role=slave ＝可收编（免确认绑定）');
  assert.equal(byId['headless-1'].claimable, false, '非交互无角色＝不可收编');
  assert.equal(byId['other-master'].claimable, false, 'role=master 即使交互式也不可收编（预检必拒）');
  // 文件 mtime 陈旧（Claude Code 空闲不触文件）不再影响可收编——存活由桥连接性把关，kind 只看在档
  node.meta.get('human-1').metaUpdatedAt = 1;
  const stale = node.service.dispatch.scan({ sessionId: 'master-1' });
  assert.equal(stale.sessions.find((entry) => entry.sessionId === 'human-1').claimable, true, '元数据陈旧的在档交互式仍可收编');
  // 文件完全不在档（metaUpdatedAt=0，如子代理桥）依旧失败关闭
  node.meta.get('human-1').metaUpdatedAt = 0;
  const missing = node.service.dispatch.scan({ sessionId: 'master-1' });
  assert.equal(missing.sessions.find((entry) => entry.sessionId === 'human-1').claimable, false, '文件不在档＝不可收编');
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
