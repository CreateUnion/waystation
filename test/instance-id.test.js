import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { INSTANCE_ID_FILE, loadOrCreateInstanceId } from '../src/instance-id.js';
import { makeTempDir, repoRoot } from './helpers.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/* 与实现约定的锁目录名（见 src/instance-id.js 空文件恢复段的锁方案） */
const LOCK_DIR_NAME = 'instance-id.lock';
/* 陈旧锁用例：把锁目录 mtime 拨到远早于实现设定的陈旧阈值之前 */
const STALE_LOCK_AGE_MS = 60000;

/* 并发用例参数：同一时刻放闸的子进程数 × 重复试数。
 * 现实现（普通写 + 回读）实测单试分叉率随并发数陡升（2 进程约 36%、4 进程约 98%），
 * 4 进程 × 3 试几乎必然至少一试触发；修复后（锁方案）实测 0/500 试违反。 */
const RACE_CHILDREN = 4;
const RACE_TRIALS = 3;
const RACE_READY_TIMEOUT_MS = 15000;
const RACE_CHILD_TIMEOUT_MS = 20000;

/* 子进程脚本：先就绪、再等放闸（同起点），调用被测实现并把返回值写 stdout。
 * 返回值经管道交给父用例——不污染测试运行器自身的 stdout。 */
const RACE_CHILD_SCRIPT = `
const [implUrl, dir, ready, gate] = process.argv.slice(1);
const { writeFileSync, existsSync } = await import('node:fs');
const { loadOrCreateInstanceId } = await import(implUrl);
writeFileSync(ready, '1');
const deadline = Date.now() + ${RACE_READY_TIMEOUT_MS};
while (!existsSync(gate)) {
  if (Date.now() > deadline) {
    process.exit(3);
  }
}
try {
  const id = loadOrCreateInstanceId(dir);
  process.stdout.write(id);
} catch (error) {
  process.stderr.write(String(error && error.stack));
  process.exit(1);
}
`;

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

test('空文件现场并发首跑：所有进程返回值相同且等于磁盘终值', async (t) => {
  const dir = makeTempDir(t);
  const file = join(dir, INSTANCE_ID_FILE);
  const srcUrl = pathToFileURL(join(repoRoot, 'src', 'instance-id.js')).href;
  for (let trial = 0; trial < RACE_TRIALS; trial++) {
    writeFileSync(file, '   \n');
    const ids = await runRaceTrial(dir, srcUrl, trial);
    const disk = readFileSync(file, 'utf8').trim();
    assert.equal(new Set(ids).size, 1, `试 ${trial}：并发返回值不一致 ${JSON.stringify(ids)}`);
    assert.equal(ids[0], disk, `试 ${trial}：返回值与磁盘终值不一致 ${JSON.stringify(ids)} vs ${disk}`);
  }
});

test('陈旧锁自愈：崩溃残留的锁目录被清理并继续完成恢复', (t) => {
  const dir = makeTempDir(t);
  const lockDir = join(dir, LOCK_DIR_NAME);
  mkdirSync(lockDir);
  const staleTime = new Date(Date.now() - STALE_LOCK_AGE_MS);
  utimesSync(lockDir, staleTime, staleTime);
  writeFileSync(join(dir, INSTANCE_ID_FILE), '   \n');
  const id = loadOrCreateInstanceId(dir);
  assert.match(id, UUID_PATTERN);
  assert.equal(readFileSync(join(dir, INSTANCE_ID_FILE), 'utf8').trim(), id);
  assert.equal(existsSync(lockDir), false);
});

async function runRaceTrial(dir, srcUrl, trial) {
  const gate = join(dir, `race-gate-${trial}`);
  const racers = [];
  try {
    for (let index = 0; index < RACE_CHILDREN; index++) {
      racers.push(startRacer(srcUrl, dir, gate, index, trial));
    }
    for (const racer of racers) {
      if (!await waitForReady(racer, RACE_READY_TIMEOUT_MS)) {
        throw new Error(`试 ${trial}：子进程 ${racer.index} 未在限时内就绪（提前退出或超时）`);
      }
    }
    writeFileSync(gate, '');
    const results = await Promise.all(racers.map((racer) => racer.exit));
    for (const result of results) {
      if (result.code !== 0) {
        throw new Error(`试 ${trial}：子进程异常退出 code=${result.code} ${result.err.slice(0, 400)}`);
      }
    }
    return results.map((result) => result.out.trim());
  } catch (error) {
    for (const racer of racers) {
      racer.child.kill();
    }
    throw error;
  }
}

function startRacer(srcUrl, dir, gate, index, trial) {
  const readyPath = join(dir, `race-ready-${trial}-${index}`);
  const child = spawn(process.execPath, ['--input-type=module', '-e', RACE_CHILD_SCRIPT, srcUrl, dir, readyPath, gate], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { err += chunk; });
  const killer = setTimeout(() => { child.kill(); }, RACE_CHILD_TIMEOUT_MS);
  const exit = new Promise((resolve) => {
    child.on('close', (code) => {
      clearTimeout(killer);
      resolve({ code, out, err });
    });
  });
  return { child, index, readyPath, exit };
}

async function waitForReady(racer, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (existsSync(racer.readyPath)) {
      return true;
    }
    if (racer.child.exitCode !== null) {
      return false;
    }
    if (Date.now() > deadline) {
      return false;
    }
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
}
