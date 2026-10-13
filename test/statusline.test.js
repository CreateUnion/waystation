import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir, repoRoot } from './helpers.js';

const STATUSLINE = join(repoRoot, 'scripts', 'statusline.js');

/* 以子进程真跑脚本：stdin 送状态栏 JSON、WAYSTATION_HOME 指向临时目录——测的是端到端契约
 * （解析、命中、渲染、空输出），不是内部函数。 */
function runStatusline(t, { input, home }) {
  const child = spawn(process.execPath, [STATUSLINE], {
    cwd: repoRoot,
    env: { ...process.env, WAYSTATION_HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
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
  child.stdin.end(input);
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

function writeSessionFile(home, sessionId, payload) {
  mkdirSync(join(home, 'sessions'), { recursive: true });
  writeFileSync(join(home, 'sessions', `${sessionId}.json`), JSON.stringify(payload));
}

function sessionFileOf(overrides = {}) {
  return {
    v: 1,
    sessionId: 'session-abc-1',
    instanceId: 'inst-self',
    identityName: '本机',
    site: { mode: 'slot', slot: 1, port: 17321, takeover: false },
    port: 17321,
    pid: process.pid,
    updatedAt: new Date().toISOString(),
    collabs: [{ collabId: 'collab-1', name: '联调项目', state: 'active', role: 'manager', memberCount: 3 }],
    ...overrides,
  };
}

test('新鲜文件：单协作渲染为一行指示（角色与人数）', async (t) => {
  const home = makeTempDir(t);
  writeSessionFile(home, 'session-abc-1', sessionFileOf());
  const run = await runStatusline(t, { input: JSON.stringify({ hook_event_name: 'Status', session_id: 'session-abc-1' }), home });
  assert.equal(run.code, 0);
  assert.equal(run.stderr, '');
  assert.equal(run.stdout, '协作中：联调项目（驿丞，3 人）');
});

test('多协作：以 ｜ 连接、非进行中状态带标注（冻结 / 待同意）', async (t) => {
  const home = makeTempDir(t);
  writeSessionFile(home, 'session-abc-1', sessionFileOf({
    collabs: [
      { collabId: 'collab-1', name: '项目甲', state: 'frozen', role: 'member', memberCount: 2 },
      { collabId: 'collab-2', name: '项目乙', state: 'proposed', role: 'member', memberCount: 2 },
    ],
  }));
  const run = await runStatusline(t, { input: JSON.stringify({ session_id: 'session-abc-1' }), home });
  assert.equal(run.stdout, '协作中：项目甲（协作者，冻结，2 人） ｜ 项目乙（协作者，待同意，2 人）');
});

test('无该会话文件：空输出、退出码 0、不写 stderr', async (t) => {
  const home = makeTempDir(t);
  const run = await runStatusline(t, { input: JSON.stringify({ session_id: 'session-none' }), home });
  assert.equal(run.code, 0);
  assert.equal(run.stdout, '');
  assert.equal(run.stderr, '');
});

test('文件陈旧（超过陈旧阈值）：空输出（崩溃残留不显示）', async (t) => {
  const home = makeTempDir(t);
  writeSessionFile(home, 'session-abc-1', sessionFileOf({ updatedAt: new Date(Date.now() - 60000).toISOString() }));
  const run = await runStatusline(t, { input: JSON.stringify({ session_id: 'session-abc-1' }), home });
  assert.equal(run.code, 0);
  assert.equal(run.stdout, '');
});

test('文件损坏（非 JSON）：空输出、不抛出', async (t) => {
  const home = makeTempDir(t);
  mkdirSync(join(home, 'sessions'), { recursive: true });
  writeFileSync(join(home, 'sessions', 'session-abc-1.json'), '{oops');
  const run = await runStatusline(t, { input: JSON.stringify({ session_id: 'session-abc-1' }), home });
  assert.equal(run.code, 0);
  assert.equal(run.stdout, '');
  assert.equal(run.stderr, '');
});

test('输入守卫：无 session_id / 非法 session_id（路径穿越形态）→ 空输出', async (t) => {
  const home = makeTempDir(t);
  const noId = await runStatusline(t, { input: JSON.stringify({ hook_event_name: 'Status' }), home });
  assert.equal(noId.code, 0);
  assert.equal(noId.stdout, '');
  const traversal = await runStatusline(t, { input: JSON.stringify({ session_id: '../../evil' }), home });
  assert.equal(traversal.code, 0);
  assert.equal(traversal.stdout, '');
  const brokenInput = await runStatusline(t, { input: 'not json at all', home });
  assert.equal(brokenInput.code, 0);
  assert.equal(brokenInput.stdout, '');
});

test('写通道：读端提前关闭（EPIPE）→ 退出码 0、不写 stderr', async (t) => {
  const home = makeTempDir(t);
  writeSessionFile(home, 'session-abc-1', sessionFileOf());
  const child = spawn(process.execPath, [STATUSLINE], {
    cwd: repoRoot,
    env: { ...process.env, WAYSTATION_HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => {
    child.kill('SIGKILL');
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  child.stdout.destroy();   // 先关读端再送 stdin：脚本读完输入才写输出，写入时读端必已关闭
  child.stdin.end(JSON.stringify({ session_id: 'session-abc-1' }));
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (childCode) => resolve(childCode));
  });
  assert.equal(code, 0);
  assert.equal(stderr, '');
});
