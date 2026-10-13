import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSessionStatusWriter } from '../src/session-status.js';
import { sessionFilePath } from '../src/paths.js';
import { makeTempDir, pickFreePort, repoRoot, waitFor } from './helpers.js';

function quietLog() {
  const entries = [];
  return {
    entries,
    log: { info: (message, fields) => entries.push({ level: 'info', message, fields }), error: () => {}, warn: (message, fields) => entries.push({ level: 'warn', message, fields }) },
  };
}

function sampleSnapshot(overrides = {}) {
  return {
    instanceId: 'inst-self',
    identityName: '本机',
    site: { mode: 'slot', slot: 1, port: 17321, takeover: false },
    port: 17321,
    collabs: [{ collabId: 'collab-1', name: '联调项目', state: 'active', role: 'manager', memberCount: 3 }],
    ...overrides,
  };
}

function makeWriter(t, options = {}) {
  const dir = makeTempDir(t);
  const { entries, log } = quietLog();
  const writer = createSessionStatusWriter({
    mainDataDir: dir,
    sessionId: 'session-abc-1',
    collect: () => sampleSnapshot(),
    log,
    heartbeatMs: 60000,
    now: () => new Date('2026-10-13T00:00:00.000Z'),
    ...options,
  });
  return { dir, entries, writer };
}

test('start：立即写入会话状态文件（字段完整、落在主数据目录 sessions/ 下）', (t) => {
  const { dir, writer } = makeWriter(t);
  writer.start();
  const payload = JSON.parse(readFileSync(sessionFilePath(dir, 'session-abc-1'), 'utf8'));
  assert.equal(payload.v, 1);
  assert.equal(payload.sessionId, 'session-abc-1');
  assert.equal(payload.instanceId, 'inst-self');
  assert.equal(payload.identityName, '本机');
  assert.deepEqual(payload.site, { mode: 'slot', slot: 1, port: 17321, takeover: false });
  assert.equal(payload.port, 17321);
  assert.equal(payload.pid, process.pid);
  assert.equal(payload.updatedAt, '2026-10-13T00:00:00.000Z');
  assert.deepEqual(payload.collabs, sampleSnapshot().collabs);
  assert.equal(writer.stats().writes, 1);
  writer.close();
});

test('周期心跳：按注入节律刷新（新协作随快照进入文件）', async (t) => {
  const dir = makeTempDir(t);
  const { log } = quietLog();
  let round = 0;
  const writer = createSessionStatusWriter({
    mainDataDir: dir,
    sessionId: 'session-hb-1',
    collect: () => sampleSnapshot({ collabs: round === 0 ? [] : [{ collabId: 'collab-9', name: '新协作', state: 'proposed', role: 'member', memberCount: 2 }] }),
    log,
    heartbeatMs: 25,
    now: () => new Date(1700000000000 + round * 1000),
  });
  writer.start();
  const file = sessionFilePath(dir, 'session-hb-1');
  round = 1;
  await waitFor(() => {
    const payload = JSON.parse(readFileSync(file, 'utf8'));
    return payload.collabs.length === 1 && payload.collabs[0].name === '新协作' ? true : null;
  }, { timeoutMs: 3000, intervalMs: 10 });
  writer.close();
});

test('close：删除文件并停表（不再复写）、幂等可重入', async (t) => {
  const { dir, writer } = makeWriter(t, { heartbeatMs: 20, now: () => new Date() });
  writer.start();
  const file = sessionFilePath(dir, 'session-abc-1');
  assert.equal(existsSync(file), true);
  writer.close();
  assert.equal(existsSync(file), false);
  const writesAfterClose = writer.stats().writes;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(existsSync(file), false, '停表后不再复写');
  assert.equal(writer.stats().writes, writesAfterClose);
  writer.close();
});

test('会话标识缺失或非法：不落盘、计数跳过（info 留痕，非每次告警）', (t) => {
  const dir = makeTempDir(t);
  for (const [sessionId, label] of [[undefined, '缺失'], ['bad id!', '非法字符'], ['', '空串']]) {
    const { entries, log } = quietLog();
    const writer = createSessionStatusWriter({ mainDataDir: dir, sessionId, collect: () => sampleSnapshot(), log, heartbeatMs: 60000, now: () => new Date() });
    writer.start();
    writer.refresh();
    writer.close();
    assert.equal(writer.stats().active, false, label);
    assert.equal(writer.stats().skipped, 1, label);
    assert.equal(entries.some((entry) => entry.level === 'info' && entry.message.includes('会话状态文件未启用')), true, label);
  }
  assert.deepEqual(readdirSync(dir), [], '不落任何文件');
});

test('采集异常：隔离为计数与告警、不抛出、不产生文件', (t) => {
  const { dir, entries, writer } = makeWriter(t, { collect: () => { throw new Error('采集失败'); } });
  writer.refresh();
  assert.equal(writer.stats().collectFailures, 1);
  assert.equal(entries.some((entry) => entry.message.includes('会话状态快照收集失败')), true);
  assert.equal(existsSync(sessionFilePath(dir, 'session-abc-1')), false);
  writer.close();
});

test('写入失败：sessions 路径被同名文件占位 → 计数告警、不抛出（健壮性）', (t) => {
  const dir = makeTempDir(t);
  writeFileSync(join(dir, 'sessions'), '占位');
  const { entries, log } = quietLog();
  const writer = createSessionStatusWriter({ mainDataDir: dir, sessionId: 'session-eacces-1', collect: () => sampleSnapshot(), log, heartbeatMs: 60000, now: () => new Date() });
  writer.refresh();
  assert.equal(writer.stats().writeFailures, 1);
  assert.equal(entries.some((entry) => entry.message.includes('会话状态文件写入失败')), true);
  writer.close();
});

test('进程级：会话标识经环境注入 → 文件出现且字段正确；stdin 关闭 → 进程退出并清除文件', { timeout: 30000 }, async (t) => {
  const home = makeTempDir(t);
  const port = await pickFreePort();
  writeFileSync(join(home, 'config.json'), JSON.stringify({ port, scanWindowMs: 300, dialTimeoutMs: 1500 }));
  const sessionId = 'session-process-1';
  const child = spawn(process.execPath, [join(repoRoot, 'src', 'index.js')], {
    cwd: repoRoot,
    env: { ...process.env, WAYSTATION_HOME: home, CLAUDE_CODE_SESSION_ID: sessionId },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => {
    child.kill('SIGKILL');
  });
  const file = sessionFilePath(home, sessionId);
  await waitFor(() => (existsSync(file) ? true : null), { timeoutMs: 15000 });
  const payload = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(payload.sessionId, sessionId);
  assert.equal(payload.port, port);
  assert.deepEqual(payload.collabs, []);
  child.stdin.end();
  const exit = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 15000);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  assert.deepEqual(exit, { code: 0, signal: null });
  assert.equal(existsSync(file), false, '会话关闭即离线：状态文件随进程收尾清除');
});
