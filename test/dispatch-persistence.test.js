import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeDispatchNode } from './helpers/dispatch.js';
import { makeTempDir } from './helpers.js';
import { loadDispatchState } from '../src/collab/dispatch-store.js';

/* 调度持久化（问题 1/19）：关键节点落盘、重启恢复、损坏/不可写降级、位置迁移、任务表保留期。
 * 文件位置默认 <dataDir>/dispatch/state.json。 */

const statePathOf = (dataDir) => join(dataDir, 'dispatch', 'state.json');

function readState(dataDir) {
  return JSON.parse(readFileSync(statePathOf(dataDir), 'utf8'));
}

function createDispatch(node, name = '持久化') {
  const created = node.service.create({ mode: 'dispatch', name, sessionId: 'master-1' });
  assert.equal(created.ok, true, String(created.message ?? ''));
  return created;
}

test('创建 / 收编 / 任务状态变化落盘；新实例同数据根恢复 slave 与任务表', async (t) => {
  const dataDir = makeTempDir(t);
  const node = makeDispatchNode(t, { dataDir, config: { dispatch: { persist: true } } });
  const created = createDispatch(node);
  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1'] });
  await node.service.dispatch.send({
    collabId: created.collabId, sessionId: 'master-1', text: '跑接口层', type: 'task', toSessionIds: ['worker-1'], taskId: 't1',
  });
  await node.service.dispatch.send({
    collabId: created.collabId, sessionId: 'worker-1', text: '接口层已完成', type: 'progress', taskId: 't1',
  });

  const persisted = readState(dataDir);
  assert.equal(persisted.v, 1);
  assert.equal(persisted.dispatch.collabId, created.collabId);
  assert.equal(persisted.dispatch.masterSessionId, 'master-1');
  assert.equal(persisted.dispatch.status, 'active');
  assert.deepEqual(persisted.dispatch.slaves.map((slave) => slave.sessionId), ['worker-1']);
  assert.equal(persisted.dispatch.tasks.length, 1);
  assert.equal(persisted.dispatch.tasks[0].taskId, 't1');
  assert.equal(persisted.dispatch.tasks[0].status, 'active');
  assert.equal(persisted.dispatch.tasks[0].assigneeSessionId, 'worker-1');
  assert.match(persisted.dispatch.tasks[0].lastProgress, /接口层已完成/);

  const restarted = makeDispatchNode(t, {
    dataDir, now: node.now(), config: { dispatch: { persist: true } }, meta: [...node.meta],
  });
  const status = restarted.service.dispatch.status().dispatch;
  assert.equal(status.collabId, created.collabId);
  assert.equal(status.masterSessionId, 'master-1');
  assert.deepEqual(status.slaves.map((slave) => slave.sessionId), ['worker-1']);
  const record = restarted.service.dispatch.dispatches.get(created.collabId);
  assert.equal(record.tasks.get('t1').status, 'active', '任务表随状态文件恢复');
  assert.equal(restarted.notices.some((frame) => frame.payload?.event === 'dispatch-restored'), true, '恢复后向成员广播');
});

test('dispatch.persist=false：不读不写，重启后 dispatch 为空', (t) => {
  const dataDir = makeTempDir(t);
  const node = makeDispatchNode(t, { dataDir, config: { dispatch: { persist: false } } });
  const created = createDispatch(node, '纯内存');
  assert.equal(existsSync(statePathOf(dataDir)), false, '关闭持久化不得创建状态文件');
  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1'] });
  assert.equal(existsSync(statePathOf(dataDir)), false);

  const restarted = makeDispatchNode(t, { dataDir, config: { dispatch: { persist: false } } });
  assert.equal(restarted.service.dispatch.status().dispatch, null);
  assert.equal(restarted.service.dispatch.isDispatch(created.collabId), false);
});

test('状态文件损坏：隔离为 .corrupt-*，服务正常启动并可新建 dispatch', (t) => {
  const dataDir = makeTempDir(t);
  mkdirSync(join(dataDir, 'dispatch'), { recursive: true });
  writeFileSync(statePathOf(dataDir), '{not-json', 'utf8');
  const node = makeDispatchNode(t, { dataDir, config: { dispatch: { persist: true } } });
  const created = createDispatch(node, '损坏后新建');
  assert.equal(created.ok, true);
  const quarantined = readdirSync(join(dataDir, 'dispatch')).filter((name) => name.startsWith('state.json.corrupt-'));
  assert.equal(quarantined.length, 1, '损坏文件须保留副本');
  assert.equal(
    node.logs.some((entry) => entry.level === 'warn' && entry.message.includes('调度状态文件损坏')),
    true,
    '损坏须告警',
  );
});

test('状态文件形态不符（版本 / 字段非法）：同样隔离降级，不部分恢复', (t) => {
  const dataDir = makeTempDir(t);
  mkdirSync(join(dataDir, 'dispatch'), { recursive: true });
  writeFileSync(statePathOf(dataDir), JSON.stringify({ v: 99, dispatch: { collabId: 'x' } }), 'utf8');
  const node = makeDispatchNode(t, { dataDir, config: { dispatch: { persist: true } } });
  assert.equal(node.service.dispatch.status().dispatch, null);
  const created = createDispatch(node, '版本不回退');
  assert.equal(created.ok, true);
});

test('不可写降级：父路径被文件占住时创建 / 收编仍成功，持久化降级且只告警', (t) => {
  const dataDir = makeTempDir(t);
  writeFileSync(join(dataDir, 'blocker'), 'not a directory', 'utf8');
  const node = makeDispatchNode(t, {
    dataDir,
    config: { dispatch: { persist: true, state_path: 'blocker/state.json' } },
  });
  const created = createDispatch(node, '不可写');
  assert.equal(created.ok, true);
  const claimed = node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1'] });
  assert.equal(claimed.ok, true, '持久化失败不得阻塞编排');
  assert.equal(node.service.dispatch.persistStatus().degraded, true);
  const warnings = node.logs.filter((entry) => entry.level === 'warn' && entry.message.includes('调度状态持久化'));
  assert.equal(warnings.length, 1, '写失败只告警一次');
});

test('位置迁移：默认文件存在且配置新位置为空 → 自动迁移', (t) => {
  const dataDir = makeTempDir(t);
  const first = makeDispatchNode(t, { dataDir, config: { dispatch: { persist: true } } });
  const created = createDispatch(first, '迁移');
  const custom = join(dataDir, 'custom', 'dispatch-state.json');
  assert.equal(existsSync(custom), false);

  const migrated = makeDispatchNode(t, {
    dataDir, now: first.now(),
    config: { dispatch: { persist: true, state_path: 'custom/dispatch-state.json' } },
  });
  assert.equal(existsSync(custom), true, '旧位置文件迁到新位置');
  assert.equal(existsSync(statePathOf(dataDir)), false, '迁移后旧位置不再保留');
  assert.equal(migrated.service.dispatch.status().dispatch.collabId, created.collabId);
});

test('位置迁移：两边都有 → 新位置优先，旧文件归档', (t) => {
  const dataDir = makeTempDir(t);
  const first = makeDispatchNode(t, { dataDir, config: { dispatch: { persist: true } } });
  const created = createDispatch(first, '新位置优先');
  const customDir = join(dataDir, 'custom');
  mkdirSync(customDir, { recursive: true });
  copyFileSync(statePathOf(dataDir), join(customDir, 'dispatch-state.json'));

  const node = makeDispatchNode(t, {
    dataDir, now: first.now(),
    config: { dispatch: { persist: true, state_path: 'custom/dispatch-state.json' } },
  });
  assert.equal(node.service.dispatch.status().dispatch.collabId, created.collabId);
  assert.equal(existsSync(statePathOf(dataDir)), false, '旧文件须移出原位');
  assert.equal(
    readdirSync(join(dataDir, 'dispatch')).some((name) => name.startsWith('state.json.archived-')),
    true,
    '旧文件归档保留',
  );
});

test('任务表保留期：已完成任务超过 dispatch_hours 后在下一次写盘时裁剪，未完成保留', async (t) => {
  const dataDir = makeTempDir(t);
  const node = makeDispatchNode(t, {
    dataDir,
    config: { dispatch: { persist: true }, retention: { dispatch_hours: 1 } },
  });
  const created = createDispatch(node);
  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1'] });
  await node.service.dispatch.send({
    collabId: created.collabId, sessionId: 'master-1', text: '旧任务', type: 'task', toSessionIds: ['worker-1'], taskId: 'old-task',
  });
  await node.service.dispatch.send({
    collabId: created.collabId, sessionId: 'worker-1', text: '旧任务完成', type: 'result', taskId: 'old-task',
  });
  node.advance(2 * 60 * 60 * 1000);
  await node.service.dispatch.send({
    collabId: created.collabId, sessionId: 'master-1', text: '新任务', type: 'task', toSessionIds: ['worker-1'], taskId: 'new-task',
  });
  const tasks = readState(dataDir).dispatch.tasks;
  assert.deepEqual(tasks.map((task) => task.taskId), ['new-task'], '超期完成项被裁剪，未完成项保留');
});

test('恢复时 master 不在线：落为待接管；master 桥重连后恢复 active 并广播', (t) => {
  const dataDir = makeTempDir(t);
  const first = makeDispatchNode(t, { dataDir, config: { dispatch: { persist: true } } });
  const created = createDispatch(first, '待接管恢复');
  first.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1'] });

  const restarted = makeDispatchNode(t, {
    dataDir,
    now: first.now() + 60 * 1000,
    metaPreset: false,
    config: { dispatch: { persist: true } },
  });
  const record = restarted.service.dispatch.dispatches.get(created.collabId);
  assert.equal(record.status, 'pending-takeover', '核心刚启动、桥未注册 → 待接管');
  assert.equal(record.slaves.has('worker-1'), true);

  restarted.meta.set('master-1', {
    sessionId: 'master-1', role: 'master', name: 'master', kind: 'interactive', entrypoint: 'cli', status: 'idle', metaUpdatedAt: restarted.now(),
  });
  restarted.service.dispatch.noteBridgeOnline('master-1');
  assert.equal(record.status, 'active', 'master 桥重连即恢复');
  assert.equal(
    restarted.notices.some((frame) => frame.payload?.event === 'dispatch-resumed' && frame.payload?.targetSessionId === 'worker-1'),
    true,
    '恢复后向组员广播',
  );
});

test('启动残留：待接管且 masterLastSeenAt 超过 dispatch_hours → 删除状态文件、不恢复', (t) => {
  const dataDir = makeTempDir(t);
  const node = makeDispatchNode(t, { dataDir, config: { dispatch: { persist: true }, retention: { dispatch_hours: 1 } } });
  createDispatch(node, '残留');
  const file = statePathOf(dataDir);
  const state = JSON.parse(readFileSync(file, 'utf8'));
  state.dispatch.status = 'pending-takeover';
  state.dispatch.masterLastSeenAt = new Date(0).toISOString();
  writeFileSync(file, JSON.stringify(state), 'utf8');

  const restarted = makeDispatchNode(t, {
    dataDir,
    now: 3 * 60 * 60 * 1000,
    metaPreset: false,
    config: { dispatch: { persist: true }, retention: { dispatch_hours: 1 } },
  });
  assert.equal(restarted.service.dispatch.status().dispatch, null, '超期待接管残留不得恢复');
  assert.equal(existsSync(file), false, '超期残留状态文件删除');
});

test('恢复 v1 状态文件：运行态 Map 缺省即空 Map（queueDeadlines / pendingAcks）', (t) => {
  const dataDir = makeTempDir(t);
  mkdirSync(join(dataDir, 'dispatch'), { recursive: true });
  writeFileSync(statePathOf(dataDir), JSON.stringify(v1StateWithoutRuntimeMaps()), 'utf8');

  const loaded = loadDispatchState(statePathOf(dataDir));
  assert.equal(loaded.ok, true, String(loaded.reason ?? ''));
  assert.equal(loaded.record.queueDeadlines instanceof Map, true, 'queueDeadlines 须恢复为空 Map');
  assert.equal(loaded.record.pendingAcks instanceof Map, true, 'pendingAcks 须恢复为空 Map');
  assert.equal(loaded.record.queueDeadlines.size, 0);
  assert.equal(loaded.record.pendingAcks.size, 0);
});

test('回归：0.2.6 状态文件恢复后 presence 节拍 sweep 不得抛异常', (t) => {
  const dataDir = makeTempDir(t);
  const first = makeDispatchNode(t, { dataDir, config: { dispatch: { persist: true } } });
  const created = createDispatch(first, '崩溃回归');
  first.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1'] });

  const restarted = makeDispatchNode(t, {
    dataDir, now: first.now(), config: { dispatch: { persist: true } }, meta: [...first.meta],
  });
  const record = restarted.service.dispatch.dispatches.get(created.collabId);
  assert.ok(record, '状态文件须恢复为内存记录');
  try {
    /* 真实启动路径：service.start 的 presence 节拍即刻驱动 dispatch.sweep。 */
    assert.doesNotThrow(() => restarted.service.start(), '恢复记录的 sweep 不得抛异常');
    assert.doesNotThrow(() => restarted.service.dispatch.sweep(restarted.now()));
  } finally {
    restarted.service.close();
  }
});

/** 0.2.6 写出的 v1 记录：不含内存态 queueDeadlines / pendingAcks。 */
function v1StateWithoutRuntimeMaps() {
  const at = new Date(1000).toISOString();
  return {
    v: 1,
    savedAt: at,
    dispatch: {
      collabId: '11111111-1111-4111-8111-111111111111',
      name: '旧版调度',
      topic: null,
      status: 'active',
      autoClaim: false,
      createdAt: at,
      masterSessionId: 'master-1',
      masterName: 'master',
      masterLastSeenAt: at,
      masterLostAt: null,
      replacedMasterSessionIds: [],
      slaves: [{ sessionId: 'worker-1', name: 'worker-1', kind: 'bg', role: 'slave', boundAt: at }],
      tasks: [],
    },
  };
}

test('普通消息（无 taskId）不触发写盘', async (t) => {
  const dataDir = makeTempDir(t);
  const node = makeDispatchNode(t, { dataDir, config: { dispatch: { persist: true } } });
  const created = createDispatch(node);
  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1'] });
  const before = readFileSync(statePathOf(dataDir), 'utf8');
  await node.service.dispatch.send({
    collabId: created.collabId, sessionId: 'master-1', text: '普通消息', toSessionIds: ['worker-1'],
  });
  assert.equal(readFileSync(statePathOf(dataDir), 'utf8'), before, '无 taskId 的消息不改变持久面');
});
