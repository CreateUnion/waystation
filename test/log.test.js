import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LOG_FILE_NAME, createLogger } from '../src/log.js';
import { makeTempDir, repoRoot } from './helpers.js';

test('info 写入 JSONL 行：含 ts/level/msg 与自定义数据', (t) => {
  const dir = makeTempDir(t);
  const log = createLogger({ logDir: dir, maxBytes: 1048576, maxFiles: 5 });
  log.info('启动完成', { port: 7321 });
  const line = JSON.parse(readFileSync(join(dir, LOG_FILE_NAME), 'utf8').trim());
  assert.equal(line.level, 'info');
  assert.equal(line.msg, '启动完成');
  assert.equal(line.port, 7321);
  assert.ok(!Number.isNaN(Date.parse(line.ts)));
});

test('按大小轮转：保留当前文件 + maxFiles 份归档，单文件有界', (t) => {
  const dir = makeTempDir(t);
  const log = createLogger({ logDir: dir, maxBytes: 512, maxFiles: 2 });
  for (let index = 0; index < 300; index++) {
    log.info(`轮转测试第 ${index} 条`, { index });
  }
  const base = join(dir, LOG_FILE_NAME);
  assert.equal(existsSync(base), true);
  assert.equal(existsSync(`${base}.1`), true);
  assert.equal(existsSync(`${base}.2`), true);
  assert.equal(existsSync(`${base}.3`), false);
  for (const file of [base, `${base}.1`, `${base}.2`]) {
    // 上限 + 单行最大长度：轮转在写前判定，单行跨越阈值是允许的
    assert.ok(statSync(file).size <= 512 + 256, `${file} 超过轮转上限`);
  }
});

test('日志目录不可用：不抛异常、不产生日志文件、warn/error 仍到 stderr', (t) => {
  const dir = makeTempDir(t);
  const blocker = join(dir, 'blocker.txt');
  writeFileSync(blocker, 'not a directory');
  const brokenDir = join(blocker, 'nested');
  const log = createLogger({ logDir: brokenDir, maxBytes: 512, maxFiles: 2 });
  const stderrLines = [];
  const originalError = console.error;
  console.error = (...args) => {
    stderrLines.push(args.join(' '));
  };
  try {
    log.info('被吞掉');
    log.warn('stderr 兜底仍工作');
    log.error('同上');
  } finally {
    console.error = originalError;
  }
  assert.equal(existsSync(brokenDir), false);
  assert.equal(stderrLines.length, 2);
  assert.ok(stderrLines[0].includes('stderr 兜底仍工作'));
  assert.ok(stderrLines[1].includes('同上'));
});

test('stdout 纪律：日志只进文件与 stderr，stdout 保持为空', (t) => {
  const dir = makeTempDir(t);
  const script = `
import { createLogger } from ${JSON.stringify(pathToFileURL(join(repoRoot, 'src', 'log.js')).href)};
const log = createLogger({ logDir: process.argv[1], maxBytes: 1048576, maxFiles: 5 });
log.info('探针 info');
log.warn('探针 warn');
log.error('探针 error');
`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script, dir], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, '');
  assert.ok(run.stderr.includes('探针 warn'));
  assert.ok(run.stderr.includes('探针 error'));
  assert.ok(!run.stderr.includes('探针 info'));
  const lines = readFileSync(join(dir, LOG_FILE_NAME), 'utf8').trim().split('\n');
  assert.equal(lines.length, 3);
});
