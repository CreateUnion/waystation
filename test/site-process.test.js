import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { makeTempDir, pickFreeSegment, repoRoot, waitForRebindable } from './helpers.js';

const FIXTURE = join(repoRoot, 'test', 'fixtures', 'site-resolve.mjs');

/* 常驻解析进程（hold: true 时夹具持锁并以合法 probe-ack 应答）：等首行结果，保持进程存活。 */
function startResolve(t, args) {
  const child = spawn(process.execPath, [FIXTURE, JSON.stringify(args)], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    child.kill('SIGKILL');
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const result = new Promise((resolve, reject) => {
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const line = stdout.trim().split('\n')[0];
      if (line !== '') {
        resolve(JSON.parse(line));
      }
    });
    child.on('exit', () => reject(new Error(`解析夹具提前退出（stderr=${stderr}）`)));
  });
  return { child, result };
}

/* 强杀一个常驻解析进程并等其退出落地（端口随之释放）。 */
function stopResolve(child) {
  const exited = new Promise((resolve) => child.on('exit', resolve));
  child.kill('SIGKILL');
  return exited;
}

/* 一次性解析进程：等其自然退出后取结果（真进程、真套接字——取锁与双证据都在内核资源上发生）。 */
function runResolve(t, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FIXTURE, JSON.stringify(args)], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => {
      child.kill('SIGKILL');
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', () => {
      const lines = stdout.trim().split('\n');
      const line = lines[lines.length - 1] ?? '';
      if (line === '') {
        reject(new Error(`解析夹具无输出：stderr=${stderr}`));
        return;
      }
      resolve(JSON.parse(line));
    });
  });
}

test('并发启动竞争（进程级）：先启动者占据槽位 1，后启动者自动顺延下一空闲槽位', { timeout: 30000 }, async (t) => {
  const mainDir = makeTempDir(t);
  const base = await pickFreeSegment();   // 八连空闲段基：段内相邻端口不得被系统临时端口等占用（槽位号漂移类假红的根因）
  const first = startResolve(t, { mainDir, segmentBase: base, hold: true });
  const firstResult = await first.result;
  assert.equal(firstResult.ok, true);
  assert.equal(firstResult.slot, 1);
  assert.equal(firstResult.port, base);
  const second = await runResolve(t, { mainDir, segmentBase: base });
  assert.equal(second.ok, true);
  /* 顺延语义 = 跳过被占槽位、取下一空闲；段内相邻端口在测试窗口内可能被系统临时端口等临时占用，
   * 此时顺延到 3 亦属设计内正确行为——断言锁定「发生了顺延且槽号/端口/目录自洽」，不锁死具体槽号。 */
  assert.ok(second.slot >= 2, '槽位 1 的占用者持有合法驿站应答：后启动者必须顺延（≥2）');
  assert.equal(second.port, base + second.slot - 1);
  assert.equal(second.dataDir, join(mainDir, 'sites', String(second.slot)));
  await stopResolve(first.child);
});

test('崩溃 → 新终端抢占 → 自愈序列（进程级）：抢占者继承站点身份，自愈者改取下一空闲槽位', { timeout: 40000 }, async (t) => {
  const mainDir = makeTempDir(t);
  const base = await pickFreeSegment();
  const first = startResolve(t, { mainDir, segmentBase: base, hold: true });
  const firstResult = await first.result;
  assert.equal(firstResult.slot, 1);
  assert.equal(firstResult.dataDir, mainDir);
  await stopResolve(first.child);   // 故障注入：原终端崩溃（强杀）——端口随进程退出释放
  await waitForRebindable(base);    // 实测 SIGKILL 后端口 1–4ms 即可重绑：轮询至可重绑，替代固定 sleep（定值会打偏）
  const reclaimee = startResolve(t, { mainDir, segmentBase: base, hold: true });
  const reclaimed = await reclaimee.result;
  assert.equal(reclaimed.slot, 1, '原终端崩溃后：槽位 1 空闲，新终端就近取得同一槽位与目录');
  assert.equal(reclaimed.dataDir, mainDir);
  assert.equal(reclaimed.instanceId, firstResult.instanceId, '同一数据目录 = 同一站点实例标识（身份被继承）');
  const healed = await runResolve(t, { mainDir, segmentBase: base });
  assert.equal(healed.ok, true);
  /* 同用例 1：自愈者必须改取「≥2 的下一空闲槽位」，但不锁死具体槽号（相邻端口临时被占 → 顺延属设计内）。 */
  assert.ok(healed.slot >= 2, '原会话自愈重启：原槽位已被抢占，改取下一空闲槽位（≥2）');
  assert.equal(healed.port, base + healed.slot - 1);
  assert.equal(healed.dataDir, join(mainDir, 'sites', String(healed.slot)));
  assert.notEqual(healed.instanceId, firstResult.instanceId, '新目录 = 新站点实例标识');
  await stopResolve(reclaimee.child);
});
