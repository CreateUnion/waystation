import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { COLLABS_DIR_NAME, LOGS_DIR_NAME, collabDir, collabFilePath, resolveDataDir, resolveLogDir, ensureDir, sessionFilePath, siteDataDir } from '../src/paths.js';
import { makeTempDir } from './helpers.js';

test('resolveDataDir：无环境变量时默认 ~/.waystation', () => {
  assert.equal(resolveDataDir({}), join(homedir(), '.waystation'));
  assert.equal(resolveDataDir({ WAYSTATION_HOME: '   ' }), join(homedir(), '.waystation'));
});

test('resolveDataDir：WAYSTATION_HOME 优先且完成规范化', () => {
  assert.equal(resolveDataDir({ WAYSTATION_HOME: 'ws-data' }), resolve('ws-data'));
  assert.equal(resolveDataDir({ WAYSTATION_HOME: '  ws-data  ' }), resolve('ws-data'));
});

test('resolveLogDir：默认 <dataDir>/logs，相对配置值以 dataDir 为锚（不随 CWD 漂移）', () => {
  const dataDir = resolve('data-home');
  assert.equal(resolveLogDir(dataDir, ''), join(dataDir, LOGS_DIR_NAME));
  assert.equal(resolveLogDir(dataDir, undefined), join(dataDir, LOGS_DIR_NAME));
  assert.equal(resolveLogDir(dataDir, 'my-logs'), join(dataDir, 'my-logs'));
  const absolute = resolve('absolute-logs');
  assert.equal(resolveLogDir(dataDir, absolute), absolute);
});

test('ensureDir：递归创建且幂等', (t) => {
  const nested = join(makeTempDir(t), 'a', 'b', 'c');
  ensureDir(nested);
  assert.equal(statSync(nested).isDirectory(), true);
  ensureDir(nested);
  assert.equal(statSync(nested).isDirectory(), true);
});

test('目录名常量：collabs 为每协作目录的父级（设计 §15）', () => {
  assert.equal(COLLABS_DIR_NAME, 'collabs');
});

test('collabDir：协作目录按 collabId 拼接（每协作一个目录）', (t) => {
  const dir = makeTempDir(t);
  assert.equal(collabDir(dir, 'collab-1'), join(dir, COLLABS_DIR_NAME, 'collab-1'));
});

test('collabDir：非法 collabId 一律抛错——路径穿越的硬边界', () => {
  for (const bad of ['../evil', 'a/b', 'a.b', '', 'x'.repeat(65), 'has space', 123, null]) {
    assert.throws(() => collabDir('/data-root', bad), /collabId 非法/);
  }
});

test('collabFilePath：协作目录内的具名文件', (t) => {
  const dir = makeTempDir(t);
  assert.equal(
    collabFilePath(dir, 'collab-1', 'outbox.jsonl'),
    join(dir, COLLABS_DIR_NAME, 'collab-1', 'outbox.jsonl'),
  );
});

test('collabFilePath：非法 fileName 段一律抛 TypeError——与 collabId 同一硬边界', () => {
  for (const bad of ['../evil', 'a/b', 'a\\b', '..', '.', 'C:x', 'outbox.', '', 123, null]) {
    assert.throws(() => collabFilePath('/data-root', 'collab-1', bad), {
      name: 'TypeError',
      message: /fileName 非法/,
    });
  }
});

test('siteDataDir：槽位 2 及以后映射到 <主目录>/sites/<k>', (t) => {
  const dir = makeTempDir(t);
  assert.equal(siteDataDir(dir, 2), join(dir, 'sites', '2'));
  assert.equal(siteDataDir(dir, 8), join(dir, 'sites', '8'));
});

test('siteDataDir：槽位 1（主目录）与非法值抛 TypeError——不做清洗', (t) => {
  const dir = makeTempDir(t);
  for (const slot of [1, 0, -1, '2', 2.5, null]) {
    assert.throws(() => siteDataDir(dir, slot), TypeError, String(slot));
  }
});

test('sessionFilePath：非法会话标识抛出，合法拼接主数据目录 sessions/ 下', () => {
  assert.throws(() => sessionFilePath('/data', '../evil'), /sessionId 非法/);
  assert.throws(() => sessionFilePath('/data', ''), /sessionId 非法/);
  assert.throws(() => sessionFilePath('/data', 42), /sessionId 非法/);
  assert.equal(sessionFilePath('/data', 'session-abc-1'), join('/data', 'sessions', 'session-abc-1.json'));
});
