import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkWritableDir } from '../src/selfcheck.js';
import { makeTempDir } from './helpers.js';

test('目录可写：ok=true 且探针文件已清理', (t) => {
  const dir = makeTempDir(t);
  const check = checkWritableDir(dir);
  assert.equal(check.ok, true);
  assert.equal(check.message, '');
  assert.deepEqual(readdirSync(dir), []);
});

test('路径穿过普通文件（模拟目录不可用）：ok=false 且报错含目录与建议', (t) => {
  const dir = makeTempDir(t);
  const blocker = join(dir, 'blocker.txt');
  writeFileSync(blocker, 'not a directory');
  const check = checkWritableDir(join(blocker, 'nested'));
  assert.equal(check.ok, false);
  assert.ok(check.message.includes('无法写入'));
  assert.ok(check.message.includes('请检查'));
});
