import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir, repoRoot } from './helpers.js';

const STATUSLINE = join(repoRoot, 'scripts', 'statusline.js');

/* 状态栏子进程收尾：node:test 的收尾钩子按注册序执行，而临时目录的删除钩子由 makeTempDir 在其调用点
 * 先行注册——「先等子进程退出、后删目录」要求收尾钩子抢在删除钩子之前注册（与 server.test.js 同一
 * 模式），否则删除撞上存活进程的写盘抛错会跳过其后全部钩子（含杀进程）——泄漏的子进程拖住文件进程
 * 永不退出，runner 无限等待该文件（整轮运行冻结）。 */
const childrenByTest = new WeakMap();
const statuslineChildren = [];   // 文件级兜底：本文件启动过的全部状态栏进程

function cleanupRegistryOf(t) {
  let children = childrenByTest.get(t);
  if (children === undefined) {
    children = [];
    childrenByTest.set(t, children);
    t.after(async () => {
      for (const child of children) {
        await stopChild(child);
      }
    });
  }
  return children;
}

/* 强杀并等 exit 落地；已退出的进程无操作——收尾路径不因二次处理把用例判红。 */
async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
}

/* 数据目录：收尾钩子先于 makeTempDir 的删除钩子注册（见上）。 */
function makeStationDir(t) {
  cleanupRegistryOf(t);
  return makeTempDir(t);
}

/* 新起的子进程登记进用例清单与文件清单（用例收尾强杀；文件末兜底查漏）。 */
function registerChild(t, child) {
  cleanupRegistryOf(t).push(child);
  statuslineChildren.push(child);
}

/* 文件级兜底：任何收尾钩子被跳过（如钩子抛错）都会留下存活的子进程——此处强制杀灭并响亮失败，
 * 绝不让泄漏把整轮运行拖进永不退出的等待（正常路径全部已杀，兜底无事可做）。 */
after(() => {
  const leakedPids = [];
  for (const child of statuslineChildren) {
    if (child.exitCode === null && child.signalCode === null) {
      leakedPids.push(child.pid);
      child.kill('SIGKILL');
    }
  }
  assert.equal(leakedPids.length, 0, `状态栏进程未被用例收尾（收尾钩子被跳过？）：${leakedPids.join(',')}——已兜底强制杀灭，检查用例清理`);
});

/* 以子进程真跑脚本：stdin 送状态栏 JSON、WAYSTATION_HOME 指向临时目录——测的是端到端契约
 * （解析、命中、渲染、空输出），不是内部函数。 */
function runStatusline(t, { input, home }) {
  const child = spawn(process.execPath, [STATUSLINE], {
    cwd: repoRoot,
    env: { ...process.env, WAYSTATION_HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  registerChild(t, child);
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
  const home = makeStationDir(t);
  writeSessionFile(home, 'session-abc-1', sessionFileOf());
  const run = await runStatusline(t, { input: JSON.stringify({ hook_event_name: 'Status', session_id: 'session-abc-1' }), home });
  assert.equal(run.code, 0);
  assert.equal(run.stderr, '');
  assert.equal(run.stdout, '协作中：联调项目（驿丞，3 人）');
});

test('多协作：以 ｜ 连接、非进行中状态带标注（冻结 / 待同意）', async (t) => {
  const home = makeStationDir(t);
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
  const home = makeStationDir(t);
  const run = await runStatusline(t, { input: JSON.stringify({ session_id: 'session-none' }), home });
  assert.equal(run.code, 0);
  assert.equal(run.stdout, '');
  assert.equal(run.stderr, '');
});

test('文件陈旧（超过陈旧阈值）：空输出（崩溃残留不显示）', async (t) => {
  const home = makeStationDir(t);
  writeSessionFile(home, 'session-abc-1', sessionFileOf({ updatedAt: new Date(Date.now() - 60000).toISOString() }));
  const run = await runStatusline(t, { input: JSON.stringify({ session_id: 'session-abc-1' }), home });
  assert.equal(run.code, 0);
  assert.equal(run.stdout, '');
});

test('文件损坏（非 JSON）：空输出、不抛出', async (t) => {
  const home = makeStationDir(t);
  mkdirSync(join(home, 'sessions'), { recursive: true });
  writeFileSync(join(home, 'sessions', 'session-abc-1.json'), '{oops');
  const run = await runStatusline(t, { input: JSON.stringify({ session_id: 'session-abc-1' }), home });
  assert.equal(run.code, 0);
  assert.equal(run.stdout, '');
  assert.equal(run.stderr, '');
});

test('输入守卫：无 session_id / 非法 session_id（路径穿越形态）→ 空输出', async (t) => {
  const home = makeStationDir(t);
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
  const home = makeStationDir(t);
  writeSessionFile(home, 'session-abc-1', sessionFileOf());
  const child = spawn(process.execPath, [STATUSLINE], {
    cwd: repoRoot,
    env: { ...process.env, WAYSTATION_HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  registerChild(t, child);
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
