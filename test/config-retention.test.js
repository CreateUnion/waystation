import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_FILE_NAME, buildDefaults, loadConfig, saveConfig } from '../src/config.js';
import { DEFAULT_RESOURCE_GUARD_CONFIG, resourceGuardConfigOf } from '../src/dispatch-config.js';
import { makeTempDir } from './helpers.js';

/* 嵌套配置（任务书 §5.2/§5.3/§5.4）：dispatch.persist / dispatch.state_path /
 * dispatch.master_timeout_ms 与 retention.*——默认值、校验回落、未知键保留、往返。 */

test('buildDefaults：dispatch / retention 默认值齐全', () => {
  const defaults = buildDefaults('主机甲');
  assert.deepEqual(defaults.dispatch, {
    persist: true,
    state_path: '',
    master_timeout_ms: 180000,
    resource_guard: {
      enabled: true,
      min_free_mem_mb: 2048,
      max_slaves: 8,
    },
  });
  assert.deepEqual(defaults.retention, {
    dispatch_hours: 24,
    collabs_days: 30,
    logs_days: 14,
    cleanup_interval_h: 6,
    dry_run: false,
  });
});

test('loadConfig：合法嵌套值生效，未知嵌套键原样保留并可写回', (t) => {
  const dir = makeTempDir(t);
  writeFileSync(join(dir, CONFIG_FILE_NAME), JSON.stringify({
    dispatch: { persist: false, state_path: 'custom/state.json', master_timeout_ms: 60000, future: { x: 1 } },
    retention: { dispatch_hours: 48, collabs_days: 7, logs_days: 3, cleanup_interval_h: 12, dry_run: true, future: 'keep' },
  }), 'utf8');
  const warnings = [];
  const { config } = loadConfig(dir, { warn: (message) => warnings.push(message) });
  assert.deepEqual(warnings, []);
  assert.equal(config.dispatch.persist, false);
  assert.equal(config.dispatch.state_path, 'custom/state.json');
  assert.equal(config.dispatch.master_timeout_ms, 60000);
  assert.deepEqual(config.dispatch.future, { x: 1 });
  assert.equal(config.retention.dispatch_hours, 48);
  assert.equal(config.retention.collabs_days, 7);
  assert.equal(config.retention.logs_days, 3);
  assert.equal(config.retention.cleanup_interval_h, 12);
  assert.equal(config.retention.dry_run, true);
  assert.equal(config.retention.future, 'keep');

  saveConfig(dir, config);
  const reloaded = loadConfig(dir).config;
  assert.deepEqual(reloaded.dispatch, config.dispatch);
  assert.deepEqual(reloaded.retention, config.retention);
});

test('loadConfig：非法嵌套值逐项回落默认并告警，不拒绝启动', (t) => {
  const dir = makeTempDir(t);
  writeFileSync(join(dir, CONFIG_FILE_NAME), JSON.stringify({
    dispatch: { persist: 'yes', master_timeout_ms: 1 },
    retention: { dispatch_hours: -1, collabs_days: 99999, logs_days: 1.5, cleanup_interval_h: 0, dry_run: 'no' },
  }), 'utf8');
  const warnings = [];
  const { config } = loadConfig(dir, { warn: (message) => warnings.push(message) });
  assert.equal(config.dispatch.persist, true);
  assert.equal(config.dispatch.master_timeout_ms, 180000);
  assert.equal(config.retention.dispatch_hours, 24);
  assert.equal(config.retention.collabs_days, 30);
  assert.equal(config.retention.logs_days, 14);
  assert.equal(config.retention.cleanup_interval_h, 6);
  assert.equal(config.retention.dry_run, false);
  assert.equal(warnings.length, 7, `七个非法项各告警一次：${warnings.join(' | ')}`);
});

test('dispatch.state_path：拒绝 .. 路径段（/ 与 \\ 两种分隔符），绝对路径允许', (t) => {
  const dir = makeTempDir(t);
  const warnings = [];
  writeFileSync(join(dir, CONFIG_FILE_NAME), JSON.stringify({
    dispatch: { state_path: '../escape/state.json' },
  }), 'utf8');
  const first = loadConfig(dir, { warn: (message) => warnings.push(message) }).config;
  assert.equal(first.dispatch.state_path, '', '含 .. 的路径回落默认');
  assert.equal(warnings.length, 1);

  const warningsBackslash = [];
  writeFileSync(join(dir, CONFIG_FILE_NAME), JSON.stringify({
    dispatch: { state_path: 'a\\..\\b\\state.json' },
  }), 'utf8');
  const second = loadConfig(dir, { warn: (message) => warningsBackslash.push(message) }).config;
  assert.equal(second.dispatch.state_path, '');
  assert.equal(warningsBackslash.length, 1);

  const absolute = join(dir, 'absolute-state.json');
  writeFileSync(join(dir, CONFIG_FILE_NAME), JSON.stringify({ dispatch: { state_path: absolute } }), 'utf8');
  assert.equal(loadConfig(dir).config.dispatch.state_path, absolute, '绝对路径允许');
});

test('dispatch / retention 顶层值类型错：整组回落默认并告警', (t) => {
  const dir = makeTempDir(t);
  writeFileSync(join(dir, CONFIG_FILE_NAME), JSON.stringify({ dispatch: 'on', retention: [1, 2] }), 'utf8');
  const warnings = [];
  const { config } = loadConfig(dir, { warn: (message) => warnings.push(message) });
  assert.deepEqual(config.dispatch, buildDefaults('主机甲').dispatch);
  assert.deepEqual(config.retention, buildDefaults('主机甲').retention);
  assert.equal(warnings.length, 2);
});

test('旧配置没有嵌套键：读取时补默认值，写回后文件含完整嵌套结构', (t) => {
  const dir = makeTempDir(t);
  writeFileSync(join(dir, CONFIG_FILE_NAME), JSON.stringify({ identityName: '旧配置', port: 7321 }), 'utf8');
  const { config } = loadConfig(dir);
  saveConfig(dir, config);
  const raw = JSON.parse(readFileSync(join(dir, CONFIG_FILE_NAME), 'utf8'));
  assert.deepEqual(raw.dispatch, config.dispatch);
  assert.deepEqual(raw.retention, config.retention);
});

test('dispatch.resource_guard：合法子键生效、未知子键保留、写回往返不丢', (t) => {
  const dir = makeTempDir(t);
  writeFileSync(join(dir, CONFIG_FILE_NAME), JSON.stringify({
    dispatch: {
      resource_guard: { enabled: false, min_free_mem_mb: 512, max_slaves: 4, future: { keep: true } },
    },
  }), 'utf8');
  const warnings = [];
  const { config } = loadConfig(dir, { warn: (message) => warnings.push(message) });
  assert.deepEqual(warnings, []);
  assert.deepEqual(config.dispatch.resource_guard, {
    enabled: false,
    min_free_mem_mb: 512,
    max_slaves: 4,
    future: { keep: true },
  });
  saveConfig(dir, config);
  assert.deepEqual(loadConfig(dir).config.dispatch.resource_guard, config.dispatch.resource_guard);
});

test('dispatch.resource_guard：非法子键逐项回落默认并各告警一次，未知子键保留', (t) => {
  const dir = makeTempDir(t);
  writeFileSync(join(dir, CONFIG_FILE_NAME), JSON.stringify({
    dispatch: { resource_guard: { enabled: 'yes', min_free_mem_mb: 255, max_slaves: 65, future: 1 } },
  }), 'utf8');
  const warnings = [];
  const { config } = loadConfig(dir, { warn: (message) => warnings.push(message) });
  assert.deepEqual(config.dispatch.resource_guard, {
    enabled: DEFAULT_RESOURCE_GUARD_CONFIG.enabled,
    min_free_mem_mb: DEFAULT_RESOURCE_GUARD_CONFIG.min_free_mem_mb,
    max_slaves: DEFAULT_RESOURCE_GUARD_CONFIG.max_slaves,
    future: 1,
  });
  assert.equal(warnings.length, 3, `三个非法项各告警一次：${warnings.join(' | ')}`);
  assert.ok(warnings.some((message) => message.includes('dispatch.resource_guard.enabled')));
  assert.ok(warnings.some((message) => message.includes('dispatch.resource_guard.min_free_mem_mb')));
  assert.ok(warnings.some((message) => message.includes('dispatch.resource_guard.max_slaves')));
});

test('dispatch.resource_guard：范围边界值合法', (t) => {
  const dir = makeTempDir(t);
  writeFileSync(join(dir, CONFIG_FILE_NAME), JSON.stringify({
    dispatch: { resource_guard: { min_free_mem_mb: 256, max_slaves: 1 } },
  }), 'utf8');
  const warnings = [];
  const { config } = loadConfig(dir, { warn: (message) => warnings.push(message) });
  assert.deepEqual(warnings, []);
  assert.equal(config.dispatch.resource_guard.min_free_mem_mb, 256);
  assert.equal(config.dispatch.resource_guard.max_slaves, 1);

  writeFileSync(join(dir, CONFIG_FILE_NAME), JSON.stringify({
    dispatch: { resource_guard: { min_free_mem_mb: 65536, max_slaves: 64 } },
  }), 'utf8');
  const upperWarnings = [];
  const upper = loadConfig(dir, { warn: (message) => upperWarnings.push(message) }).config;
  assert.deepEqual(upperWarnings, []);
  assert.equal(upper.dispatch.resource_guard.min_free_mem_mb, 65536);
  assert.equal(upper.dispatch.resource_guard.max_slaves, 64);
});

test('dispatch.resource_guard 整段类型错：整组回落默认并告警一次', (t) => {
  const dir = makeTempDir(t);
  writeFileSync(join(dir, CONFIG_FILE_NAME), JSON.stringify({
    dispatch: { resource_guard: 'on' },
  }), 'utf8');
  const warnings = [];
  const { config } = loadConfig(dir, { warn: (message) => warnings.push(message) });
  assert.deepEqual(config.dispatch.resource_guard, DEFAULT_RESOURCE_GUARD_CONFIG);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('dispatch.resource_guard'));
});

test('resourceGuardConfigOf：缺失 / 非法逐项回落，合法值原样生效', () => {
  assert.deepEqual(resourceGuardConfigOf({}), DEFAULT_RESOURCE_GUARD_CONFIG);
  assert.deepEqual(resourceGuardConfigOf({ dispatch: { resource_guard: null } }), DEFAULT_RESOURCE_GUARD_CONFIG);
  assert.deepEqual(resourceGuardConfigOf({
    dispatch: { resource_guard: { enabled: false, min_free_mem_mb: 1, max_slaves: 999 } },
  }), { enabled: false, min_free_mem_mb: DEFAULT_RESOURCE_GUARD_CONFIG.min_free_mem_mb, max_slaves: DEFAULT_RESOURCE_GUARD_CONFIG.max_slaves });
  assert.deepEqual(resourceGuardConfigOf({
    dispatch: { resource_guard: { enabled: false, min_free_mem_mb: 256, max_slaves: 64 } },
  }), { enabled: false, min_free_mem_mb: 256, max_slaves: 64 });
});
