import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_HEARTBEAT_MS, DEFAULT_HEARTBEAT_TIMEOUT_MS, HEARTBEAT_ENV,
  createHeartbeatLoop, heartbeatSettingsOf,
} from '../src/bridge/heartbeat.js';
import { createBridgeRuntime } from '../src/bridge/main.js';
import { waitFor } from './helpers.js';

/* 桥常驻心跳的参数与循环判别：默认 10s、可关闭（WAYSTATION_BRIDGE_HEARTBEAT=0）、非法值回落默认；
 * 循环串行、异常隔离、stop 后不再触发。link.heartbeat 的 ping/超时语义由 bridge-supervision 的
 * 真 IPC 用例承载。 */

function quietLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

test('心跳参数：默认 10s / 30s，0 与 false/off/no 关闭，正整数可调，非法回落默认', () => {
  assert.deepEqual(heartbeatSettingsOf({}), { intervalMs: DEFAULT_HEARTBEAT_MS, timeoutMs: DEFAULT_HEARTBEAT_TIMEOUT_MS });
  for (const value of ['0', 'false', 'FALSE', 'off', 'no']) {
    assert.equal(heartbeatSettingsOf({ [HEARTBEAT_ENV]: value }).intervalMs, 0, `${value} 关闭心跳`);
  }
  assert.equal(heartbeatSettingsOf({ [HEARTBEAT_ENV]: '250' }).intervalMs, 250);
  assert.equal(heartbeatSettingsOf({}, { heartbeatMs: 0 }).intervalMs, 0, '构造选项可关闭');
  assert.equal(heartbeatSettingsOf({}, { heartbeatTimeoutMs: 123 }).timeoutMs, 123);
  assert.equal(heartbeatSettingsOf({ WAYSTATION_BRIDGE_HEARTBEAT_TIMEOUT_MS: '456' }).timeoutMs, 456);
  const invalid = heartbeatSettingsOf({ [HEARTBEAT_ENV]: 'abc' });
  assert.equal(invalid.intervalMs, DEFAULT_HEARTBEAT_MS);
  assert.equal(invalid.invalidValue, 'abc');
});

test('心跳循环：串行执行、stop 后不再触发、连接件异常不外溢', async () => {
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const warnings = [];
  const link = {
    heartbeat: async () => {
      calls++;
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active--;
      if (calls === 2) {
        throw new Error('连接件内部错误');
      }
      return { ok: true };
    },
  };
  const loop = createHeartbeatLoop({
    link,
    log: { info: () => {}, warn: (message) => warnings.push(message), error: () => {} },
    intervalMs: 5,
    timeoutMs: 10,
  });
  loop.start();
  await waitFor(() => calls >= 3, { timeoutMs: 1000 });
  loop.stop();
  const stopped = calls;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(calls, stopped, 'stop 后不再触发');
  assert.equal(maxActive, 1, '上一拍完成才排下一拍（不叠加）');
  assert.ok(warnings.some((message) => /心跳监督异常/.test(message)), '异常隔离并留痕');
});

test('心跳循环：replacing / closed 属预期态不告警，其余失败告警', async () => {
  const outcomes = [
    { ok: false, kind: 'replacing' },
    { ok: false, kind: 'closed' },
    { ok: false, kind: 'heartbeat-timeout', message: '无应答' },
  ];
  const warnings = [];
  let index = 0;
  const link = { heartbeat: async () => outcomes[Math.min(index++, outcomes.length - 1)] };
  const loop = createHeartbeatLoop({
    link,
    log: { info: () => {}, warn: (message) => warnings.push(message), error: () => {} },
    intervalMs: 10000,
  });
  await loop.tick();
  await loop.tick();
  assert.deepEqual(warnings, [], '换代/关闭属预期态');
  await loop.tick();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /心跳监督未恢复连接/);
  loop.stop();
});

test('心跳循环：重连成功输出 info 诊断（reconnected=true）', async () => {
  const infos = [];
  const link = { heartbeat: async () => ({ ok: true, reconnected: true }) };
  const loop = createHeartbeatLoop({
    link,
    log: { info: (message) => infos.push(message), warn: () => {}, error: () => {} },
    intervalMs: 10000,
  });
  await loop.tick();
  loop.stop();
  assert.equal(infos.length, 1);
  assert.match(infos[0], /重连成功/);
});

test('心跳循环：连接件无 heartbeat 方法时静默空转（旧/桩连接件兼容）', async () => {
  const loop = createHeartbeatLoop({ link: {}, intervalMs: 5 });
  await loop.tick();
  loop.stop();
});

test('桥运行时：WAYSTATION_BRIDGE_HEARTBEAT=0 不启心跳，默认启用且可手动驱动', async () => {
  let beats = 0;
  const link = () => ({
    setPushHandler: () => {},
    setRegisteredHandler: () => {},
    sendRegisterUpdate: () => true,
    ensureCore: async () => ({ ok: true }),
    heartbeat: async () => {
      beats++;
      return { ok: true };
    },
    call: async () => ({ ok: true, result: { content: [] } }),
    sendDelivered: () => true,
    close: async () => {},
    state: { registered: false, welcome: null, lastFailure: null },
  });
  const disabled = createBridgeRuntime({
    env: { [HEARTBEAT_ENV]: '0' },
    dataDir: '/heartbeat-disabled',
    log: quietLog(),
    writer: { deliver: async () => ({ ok: true }) },
    link: link(),
    sessionMetaWatcher: false,
  });
  assert.equal(disabled.heartbeat, null, '=0 关闭');
  await disabled.close();

  const enabled = createBridgeRuntime({
    env: { [HEARTBEAT_ENV]: '5' },
    dataDir: '/heartbeat-enabled',
    log: quietLog(),
    writer: { deliver: async () => ({ ok: true }) },
    link: link(),
    sessionMetaWatcher: false,
  });
  assert.notEqual(enabled.heartbeat, null, '正整数启用');
  await enabled.heartbeat.tick();
  assert.equal(beats, 1);
  await enabled.close();
});
