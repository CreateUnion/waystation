import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function readJson(name) {
  return JSON.parse(readFileSync(join(repoRoot, name), 'utf8'));
}

test('package.json：npm 包骨架字段齐备', () => {
  const pkg = readJson('package.json');
  assert.equal(pkg.name, 'waystation');
  assert.equal(pkg.version, '0.1.0');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.engines.node, '>=20');
  assert.equal(pkg.bin.waystation, 'bin/waystation.js');
  assert.equal(pkg.scripts.test, 'node --test "test/**/*.test.js"');
  assert.deepEqual(Object.keys(pkg.dependencies), ['@modelcontextprotocol/sdk']);
  // 开发依赖恰为工具链五项：eslint（风格与 stdout 纪律）、@eslint/js（推荐规则集）、globals（运行环境变量集）、
  // typescript 与 @types/node（类型检查）；版本由 npm 解析为当前稳定版，只断言键集合与 semver 形态
  assert.deepEqual(Object.keys(pkg.devDependencies).sort(), ['@eslint/js', '@types/node', 'eslint', 'globals', 'typescript']);
  for (const range of Object.values(pkg.devDependencies)) {
    assert.match(range, /^[\^~]?\d+\.\d+\.\d+/);
  }
});

test('package-lock.json：根版本与 package.json 保持一致，且依赖版本未被波及', () => {
  const pkg = readJson('package.json');
  const lock = readJson('package-lock.json');
  assert.equal(lock.name, 'waystation');
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  // 防「全局替换 1.0.0 → 0.1.0」的产物污染：这两个依赖自身的版本恰为 1.0.0，必须原样（与 resolved/integrity 绑定）
  assert.equal(lock.packages['node_modules/json-schema-traverse'].version, '1.0.0');
  assert.equal(lock.packages['node_modules/unpipe'].version, '1.0.0');
});

test('bin/waystation.js：存在且带 node shebang', () => {
  const binPath = join(repoRoot, 'bin', 'waystation.js');
  assert.equal(existsSync(binPath), true);
  const firstLine = readFileSync(binPath, 'utf8').split('\n')[0];
  assert.equal(firstLine, '#!/usr/bin/env node');
});
