import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { INSTANCE_ID_FILE, loadOrCreateInstanceId } from '../src/instance-id.js';
import { makeTempDir } from './helpers.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('首次调用：生成 UUID 并持久化', (t) => {
  const dir = makeTempDir(t);
  const id = loadOrCreateInstanceId(dir);
  assert.match(id, UUID_PATTERN);
  assert.equal(readFileSync(join(dir, INSTANCE_ID_FILE), 'utf8').trim(), id);
});

test('后续调用：重复读取同一标识，不再生成', (t) => {
  const dir = makeTempDir(t);
  const first = loadOrCreateInstanceId(dir);
  const second = loadOrCreateInstanceId(dir);
  assert.equal(second, first);
});

test('既有文件值优先（人工放置 / 前次会话遗留）', (t) => {
  const dir = makeTempDir(t);
  writeFileSync(join(dir, INSTANCE_ID_FILE), 'c0ffee00-0000-4000-8000-000000000000\n');
  assert.equal(loadOrCreateInstanceId(dir), 'c0ffee00-0000-4000-8000-000000000000');
});

test('空文件：补写新标识并持久化（创建后未写入完成的现场）', (t) => {
  const dir = makeTempDir(t);
  writeFileSync(join(dir, INSTANCE_ID_FILE), '   \n');
  const id = loadOrCreateInstanceId(dir);
  assert.match(id, UUID_PATTERN);
  assert.equal(readFileSync(join(dir, INSTANCE_ID_FILE), 'utf8').trim(), id);
});

test('数据目录不存在：抛出（调用方先建目录——启动序列先 ensureDir 再取标识）', (t) => {
  const missing = join(makeTempDir(t), 'missing');
  assert.throws(() => loadOrCreateInstanceId(missing), (error) => error.code === 'ENOENT');
});
