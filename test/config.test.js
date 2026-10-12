import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { CONFIG_FILE_NAME, buildDefaults, loadConfig, saveConfig } from '../src/config.js';
import { makeTempDir } from './helpers.js';

test('文件缺失：返回默认值且 created=true', (t) => {
  const dir = makeTempDir(t);
  const { config, created } = loadConfig(dir);
  assert.equal(created, true);
  assert.equal(config.identityName, hostname());
  assert.equal(config.port, 7321);
  assert.equal(config.offlineQueue, true);
  assert.equal(config.autoDeliver, true);
  assert.equal(config.logDir, '');
  assert.equal(config.logMaxBytes, 1048576);
  assert.equal(config.logMaxFiles, 5);
});

test('buildDefaults：标识名取传入主机名，形状完整', () => {
  const defaults = buildDefaults('主机甲');
  assert.deepEqual(Object.keys(defaults).sort(), [
    'autoDeliver',
    'dialTimeoutMs',
    'dispatchTickMs',
    'identityName',
    'logDir',
    'logMaxBytes',
    'logMaxFiles',
    'messageTtlMs',
    'offlineQueue',
    'port',
    'queueMaxPerCollab',
    'retryFastCount',
    'retryIntervalMs',
    'retrySlowIntervalMs',
    'scanWindowMs',
  ]);
  assert.equal(defaults.identityName, '主机甲');
});

test('saveConfig + loadConfig：往返保持取值且 created=false', (t) => {
  const dir = makeTempDir(t);
  const { config } = loadConfig(dir);
  config.identityName = '工位机';
  config.port = 17321;
  saveConfig(dir, config);
  const reloaded = loadConfig(dir);
  assert.equal(reloaded.created, false);
  assert.equal(reloaded.config.identityName, '工位机');
  assert.equal(reloaded.config.port, 17321);
});

test('文件损坏：保留副本、按默认值重建并告警', (t) => {
  const dir = makeTempDir(t);
  writeFileSync(join(dir, CONFIG_FILE_NAME), '{oops');
  const warnings = [];
  const { config, created } = loadConfig(dir, { warn: (message) => warnings.push(message) });
  assert.equal(created, true);
  assert.equal(config.port, 7321);
  const backups = readdirSync(dir).filter((name) => name.startsWith(`${CONFIG_FILE_NAME}.corrupt-`));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(dir, backups[0]), 'utf8'), '{oops');
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('配置文件损坏'));
});

test('根节点非对象：同样走损坏保留路径', (t) => {
  const dir = makeTempDir(t);
  writeFileSync(join(dir, CONFIG_FILE_NAME), '[1,2,3]');
  const warnings = [];
  const { created } = loadConfig(dir, { warn: (message) => warnings.push(message) });
  assert.equal(created, true);
  assert.ok(warnings[0].includes('配置文件损坏'));
  const backups = readdirSync(dir).filter((name) => name.startsWith(`${CONFIG_FILE_NAME}.corrupt-`));
  assert.equal(backups.length, 1);
});

test('已知字段类型非法：该项回落默认值并告警，其余保留', (t) => {
  const dir = makeTempDir(t);
  writeFileSync(
    join(dir, CONFIG_FILE_NAME),
    JSON.stringify({ identityName: '自定义名', port: 'abc', offlineQueue: 'yes', logMaxFiles: 9999 }),
  );
  const warnings = [];
  const { config, created } = loadConfig(dir, { warn: (message) => warnings.push(message) });
  assert.equal(created, false);
  assert.equal(config.identityName, '自定义名');
  assert.equal(config.port, 7321);
  assert.equal(config.offlineQueue, true);
  assert.equal(config.logMaxFiles, 5);
  assert.equal(warnings.length, 3);
  assert.ok(warnings.every((message) => message.includes('无效')));
});

test('未知字段：原样保留，重写不丢（前向兼容）', (t) => {
  const dir = makeTempDir(t);
  writeFileSync(join(dir, CONFIG_FILE_NAME), JSON.stringify({ futureFeature: { enabled: true } }));
  const { config } = loadConfig(dir);
  assert.deepEqual(config.futureFeature, { enabled: true });
  saveConfig(dir, config);
  const onDisk = JSON.parse(readFileSync(join(dir, CONFIG_FILE_NAME), 'utf8'));
  assert.deepEqual(onDisk.futureFeature, { enabled: true });
});

test('保留名键（toString/constructor/__proto__）：按未知字段处理、不抛、不污染原型', (t) => {
  const dir = makeTempDir(t);
  writeFileSync(
    join(dir, CONFIG_FILE_NAME),
    '{"toString": 123, "constructor": "x", "__proto__": {"polluted": true}}',
  );
  const warnings = [];
  const { config } = loadConfig(dir, { warn: (message) => warnings.push(message) });
  assert.equal(config.toString, 123);
  assert.equal(config.constructor, 'x');
  assert.equal(Object.hasOwn(config, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(config), Object.prototype);
  assert.equal({}.polluted, undefined);
  assert.equal(config.port, 7321);
  assert.deepEqual(warnings, []);
});

test('网络与消息参数默认值（设计 §5/§10 明文默认）', (t) => {
  const dir = makeTempDir(t);
  const { config } = loadConfig(dir);
  assert.equal(config.scanWindowMs, 2000);
  assert.equal(config.retryIntervalMs, 10000);
  assert.equal(config.retrySlowIntervalMs, 60000);
  assert.equal(config.retryFastCount, 3);
  assert.equal(config.queueMaxPerCollab, 500);
  assert.equal(config.messageTtlMs, 604800000);
  assert.equal(config.dispatchTickMs, 1000);
  assert.equal(config.dialTimeoutMs, 5000);
});

test('identityName 超长（>64 字符）：回落默认并告警', (t) => {
  const dir = makeTempDir(t);
  writeFileSync(join(dir, CONFIG_FILE_NAME), JSON.stringify({ identityName: 'x'.repeat(65) }));
  const warnings = [];
  const { config } = loadConfig(dir, { warn: (message) => warnings.push(message) });
  assert.equal(config.identityName, hostname());
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('identityName'));
});

test('网络参数类型或范围非法：逐项回落默认并告警', (t) => {
  const dir = makeTempDir(t);
  writeFileSync(
    join(dir, CONFIG_FILE_NAME),
    JSON.stringify({ retryIntervalMs: -1, queueMaxPerCollab: 'many', scanWindowMs: 0 }),
  );
  const warnings = [];
  const { config } = loadConfig(dir, { warn: (message) => warnings.push(message) });
  assert.equal(config.retryIntervalMs, 10000);
  assert.equal(config.queueMaxPerCollab, 500);
  assert.equal(config.scanWindowMs, 2000);
  assert.equal(warnings.length, 3);
});
