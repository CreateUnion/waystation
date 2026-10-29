import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyRegisterUpdate } from '../src/core/main.js';

/* register-update 的核心侧归口（纯 helper）：身份只认已认证连接记录，帧内身份字段不得改投；
 * role/masterName 是启动期环境，注册后不可改写；其余元数据出现即覆盖（null 可清回未知）。 */

function recordFixture(overrides = {}) {
  return {
    connId: 1,
    bridgeId: 'bridge-a',
    sessionId: 'session-a',
    role: 'slave',
    masterName: 'boss',
    name: 'old',
    kind: 'interactive',
    entrypoint: 'cli',
    status: 'idle',
    metaUpdatedAt: 1,
    ...overrides,
  };
}

function stateFixture() {
  const refreshes = [];
  return { state: { sessionStatus: { refresh: () => refreshes.push('refresh') } }, refreshes };
}

test('register-update：身份取连接记录，帧内 sessionId/bridgeId 不得改投；role/masterName 不可改写', () => {
  const record = recordFixture();
  const { state, refreshes } = stateFixture();
  applyRegisterUpdate(state, {
    type: 'register-update',
    sessionId: 'session-b',
    bridgeId: 'bridge-evil',
    role: 'master',
    masterName: 'evil',
    name: 'new',
    kind: 'bg',
    entrypoint: 'sdk-cli',
    status: 'busy',
    metaUpdatedAt: 99,
  }, record);
  assert.equal(record.sessionId, 'session-a', '归属仍取连接记录');
  assert.equal(record.bridgeId, 'bridge-a', 'bridgeId 不被帧改写');
  assert.equal(record.role, 'slave', 'role 只来自 hello 启动期环境');
  assert.equal(record.masterName, 'boss', 'masterName 只来自 hello 启动期环境');
  assert.deepEqual(
    [record.name, record.kind, record.entrypoint, record.status, record.metaUpdatedAt],
    ['new', 'bg', 'sdk-cli', 'busy', 99],
  );
  assert.deepEqual(refreshes, ['refresh'], '元数据变化触发会话状态刷新');
});

test('register-update：帧内出现的字段才覆盖，null 可把消失的信息清回未知', () => {
  const record = recordFixture({ name: 'keep', kind: 'bg', entrypoint: 'cli', status: 'idle', metaUpdatedAt: 7 });
  const { state } = stateFixture();
  applyRegisterUpdate(state, { type: 'register-update', entrypoint: null, status: null }, record);
  assert.deepEqual(
    [record.name, record.kind, record.entrypoint, record.status, record.metaUpdatedAt],
    ['keep', 'bg', null, null, 7],
  );
});

test('register-update：无会话标识的连接记录不接收（不刷新）', () => {
  const record = recordFixture({ sessionId: null });
  const { state, refreshes } = stateFixture();
  applyRegisterUpdate(state, { type: 'register-update', name: 'x' }, record);
  assert.equal(record.name, 'old');
  applyRegisterUpdate(state, { type: 'register-update', name: 'x' }, null);
  assert.deepEqual(refreshes, []);
});
