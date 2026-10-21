import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { makeTempDir, repoRoot, waitFor } from './helpers.js';

const VIEWER = join(repoRoot, 'scripts', 'collab-viewer.js');
const COLLAB_ID = 'collab-view-1';
/* 查看器轮询周期（500ms）的两倍上限：等一次轮询落地，超时留足慢机器余量。 */
const WAIT = { timeoutMs: 8000, intervalMs: 50 };

/* 查看器子进程收尾：与 statusline.test.js 同一理由与同一模式——收尾钩子按注册序执行，
 * 必须先等子进程退出、后删临时目录，否则删除撞上存活进程的写盘会在钩子链中跳杀进程、
 * 泄漏的子进程把 runner 拖进永不退出的等待。 */
const childrenByTest = new WeakMap();
const viewerChildren = [];

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

/* 短超时兜底：q 请退后这么久仍未退（卡在未预期状态）才强杀——强杀不落 V8 覆盖数据，
 * 只留给异常路径。 */
const STOP_GRACE_MS = 2000;

/* 收尾：先送 q 请其优雅退出（等 exit）——正常退出路径才让子进程把覆盖数据落盘，覆盖率采集
 * 才是完整读数（此前一律强杀，覆盖数字被系统性低估）；q 请退带短超时兜底 SIGKILL。 */
async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = new Promise((resolve) => child.once('exit', resolve));
  if (child.exitCode !== null || child.signalCode !== null) {
    return;   // 检查与监听注册之间已退出：on exit 已错过，按已退出处理
  }
  try {
    child.stdin?.on('error', () => {});
    child.stdin?.write('q');
  } catch {
    // stdin 不可写（无管道 / 已关闭）：跳过请退，转等退出 + 兜底强杀
  }
  const killer = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS);
  await exited;
  clearTimeout(killer);
}

function makeStationDir(t) {
  cleanupRegistryOf(t);
  return makeTempDir(t);
}

function registerChild(t, child) {
  cleanupRegistryOf(t).push(child);
  viewerChildren.push(child);
}

after(() => {
  const leakedPids = [];
  for (const child of viewerChildren) {
    if (child.exitCode === null && child.signalCode === null) {
      leakedPids.push(child.pid);
      child.kill('SIGKILL');
    }
  }
  assert.equal(leakedPids.length, 0, `查看器进程未被用例收尾（收尾钩子被跳过？）：${leakedPids.join(',')}——已兜底强制杀灭，检查用例清理`);
});

/* —— 夹具 —— */

function collabPath(home, fileName) {
  return join(home, 'collabs', COLLAB_ID, fileName);
}

function appendJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(value) + '\n');
}

function postOf(index, overrides = {}) {
  return {
    entryId: `post-entry-${index}`,
    seq: index,
    ts: new Date().toISOString(),
    from: { instanceId: 'inst-author', identityName: '主机甲' },
    kind: 'reply',
    text: `帖子正文 ${index}`,
    ...overrides,
  };
}

function memberEventOf({ eventId, kind, instanceId, identityName }) {
  return { eventId, kind, instanceId, identityName, ts: new Date().toISOString() };
}

function ledgerOf(overrides = {}) {
  const now = new Date().toISOString();
  return {
    version: 1,
    collabId: COLLAB_ID,
    name: '架构讨论',
    topic: '讨论查看器',
    status: 'active',
    mode: 'forum',
    manager: { instanceId: 'inst-author', identityName: '主机甲' },
    members: [{ instanceId: 'inst-author', identityName: '主机甲', role: 'manager', state: 'member', joinedAt: now }],
    board: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function memberRecordOf(overrides = {}) {
  const now = new Date().toISOString();
  return {
    collabId: COLLAB_ID,
    name: '架构讨论',
    role: 'member',
    state: 'active',
    manager: { instanceId: 'inst-author', identityName: '主机甲' },
    endpoints: {},
    roster: [{ instanceId: 'inst-author', identityName: '主机甲' }],
    invitedAt: now,
    expiresAt: now,
    decision: null,
    ...overrides,
  };
}

/* 数据齐备的讨论目录：帖 1..count、甲 join、本机参与记录（member 席位默认，manager 席位另带台账）。 */
function seedCollab(home, { posts = 1, seat = 'member' } = {}) {
  for (let index = 1; index <= posts; index++) {
    appendJson(collabPath(home, 'posts.jsonl'), postOf(index));
  }
  appendJson(collabPath(home, 'members.jsonl'), memberEventOf({ eventId: 'ev-join-a', kind: 'join', instanceId: 'inst-author', identityName: '主机甲' }));
  mkdirSync(dirname(collabPath(home, 'member.json')), { recursive: true });
  writeFileSync(collabPath(home, 'member.json'), JSON.stringify(memberRecordOf(seat === 'manager' ? { role: 'manager' } : {})));
  if (seat === 'manager') {
    appendJson(collabPath(home, 'ledger.jsonl'), ledgerOf());
  }
}

/* —— 运行器 —— */

function startViewer(t, { home, args = [COLLAB_ID] }) {
  const child = spawn(process.execPath, [VIEWER, ...args], {
    cwd: repoRoot,
    env: { ...process.env, WAYSTATION_HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  registerChild(t, child);
  const transcript = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk) => {
    transcript.stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk) => {
    transcript.stderr += chunk.toString('utf8');
  });
  return {
    child,
    out: () => transcript.stdout,
    err: () => transcript.stderr,
    lines: () => transcript.stdout.split('\n').filter((line) => line !== ''),
    postLines: () => transcript.stdout.split('\n').filter((line) => /^\d{2}:\d{2}:\d{2}/.test(line)),
    waitForText: (text) => waitFor(() => (transcript.stdout.includes(text) ? true : null), WAIT),
    countOf: (text) => transcript.stdout.split(text).length - 1,
  };
}

function runViewerToExit(t, { home, args }) {
  const child = spawn(process.execPath, [VIEWER, ...args], {
    cwd: repoRoot,
    env: { ...process.env, WAYSTATION_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  registerChild(t, child);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

function exitOf(child) {
  if (child.exitCode !== null) {
    return Promise.resolve(child.exitCode);
  }
  return new Promise((resolve) => child.once('exit', (code) => resolve(code)));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* 数据目录全量快照（路径 + 字节内容）：零写盘判别的比对基准。 */
function treeSnapshot(root) {
  const items = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        items.push({ path: relative(root, full), content: readFileSync(full).toString('base64') });
      }
    }
  };
  walk(root);
  return items;
}

/* —— 用例 —— */

test('启动：横幅一行＋既有帖回放（时间戳与正文两栏、默认无作者）', async (t) => {
  const home = makeStationDir(t);
  seedCollab(home, { posts: 2 });
  const viewer = startViewer(t, { home });
  await viewer.waitForText('帖子正文 2');
  const lines = viewer.lines();
  assert.equal(lines[0], '【架构讨论】进行中 ｜ 1 人');
  const postLine = lines.find((line) => line.endsWith('帖子正文 1'));
  assert.match(postLine, /^\d{2}:\d{2}:\d{2} {2}帖子正文 1$/);
  assert.equal(postLine.includes('主机甲'), false, '默认不呈现作者');
  assert.equal(viewer.countOf('帖子正文 1'), 1);
});

test('增量：追加一条帖 → 只多出一行新帖，既有行不重放', async (t) => {
  const home = makeStationDir(t);
  seedCollab(home, { posts: 1 });
  const viewer = startViewer(t, { home });
  await viewer.waitForText('帖子正文 1');
  const linesBefore = viewer.lines().length;
  appendJson(collabPath(home, 'posts.jsonl'), postOf(2));
  await viewer.waitForText('帖子正文 2');
  assert.equal(viewer.countOf('帖子正文 1'), 1, '既有行不重放');
  assert.equal(viewer.lines().length, linesBefore + 1);
});

test('--author：时间戳与正文之间加身份名列', async (t) => {
  const home = makeStationDir(t);
  seedCollab(home, { posts: 1 });
  const viewer = startViewer(t, { home, args: [COLLAB_ID, '--author'] });
  await viewer.waitForText('帖子正文 1');
  const postLine = viewer.lines().find((line) => line.endsWith('帖子正文 1'));
  assert.match(postLine, /^\d{2}:\d{2}:\d{2} {2}主机甲 {2}帖子正文 1$/);
});

test('截断：印回卷提示并自卷首重放（重读新文件全卷、后续增量不受影响）', async (t) => {
  const home = makeStationDir(t);
  seedCollab(home, { posts: 2 });
  const viewer = startViewer(t, { home });
  await viewer.waitForText('帖子正文 2');
  // 文件被整体改写（截断到更小）：只剩帖 1 与一条短新帖——回卷后应只呈现新文件的实际内容
  writeFileSync(collabPath(home, 'posts.jsonl'), `${JSON.stringify(postOf(1))}\n${JSON.stringify(postOf(9, { text: '短帖' }))}\n`);
  await viewer.waitForText('短帖');
  assert.ok(viewer.out().includes('被截断'), '回卷提示一行');
  assert.equal(viewer.countOf('帖子正文 1'), 2, '卷首重放：新文件里的帖 1 再现一次');
  assert.equal(viewer.countOf('帖子正文 2'), 1, '被改写掉的帖不复活');
  appendJson(collabPath(home, 'posts.jsonl'), postOf(10, { text: '回卷后的追加帖' }));
  await viewer.waitForText('回卷后的追加帖');
});

test('半行：补全前不渲染、UTF-8 多字节跨界安全（无替换符）', async (t) => {
  const home = makeStationDir(t);
  seedCollab(home, { posts: 0 });
  const viewer = startViewer(t, { home });
  await viewer.waitForText('【架构讨论】');
  const lineBytes = Buffer.from(`${JSON.stringify(postOf(2, { text: '跨字节安全' }))}\n`, 'utf8');
  const splitAt = lineBytes.indexOf(Buffer.from('跨', 'utf8')) + 1;   // 恰切在首字节之后：一个三字节字符被拆开
  appendFileSync(collabPath(home, 'posts.jsonl'), lineBytes.subarray(0, splitAt));
  await sleep(1200);
  assert.equal(viewer.out().includes('跨字节安全'), false, '半行不成行、不渲染');
  appendFileSync(collabPath(home, 'posts.jsonl'), lineBytes.subarray(splitAt));
  await viewer.waitForText('跨字节安全');
  assert.equal(viewer.out().includes('�'), false, '多字节字符跨界不得解出替换符');
});

test('坏行：跳过不崩、后续行照常', async (t) => {
  const home = makeStationDir(t);
  seedCollab(home, { posts: 1 });
  appendFileSync(collabPath(home, 'posts.jsonl'), '{oops not json\n');
  appendFileSync(collabPath(home, 'posts.jsonl'), '{"entryId":"not-a-post"}\n');
  const viewer = startViewer(t, { home });
  await viewer.waitForText('帖子正文 1');
  await viewer.waitForText('跳过一条无法解析的记录行');
  assert.equal(viewer.child.exitCode, null, '坏行不导致崩溃');
  assert.equal(viewer.countOf('跳过一条无法解析的记录行'), 2, '两条坏行各计一次');
  appendJson(collabPath(home, 'posts.jsonl'), postOf(2));
  await viewer.waitForText('帖子正文 2');
});

test('帖正文：控制 / 格式类字符剥除（C1 与双向重排），ZWJ emoji 组合保留', async (t) => {
  const home = makeStationDir(t);
  seedCollab(home, { posts: 0 });
  const viewer = startViewer(t, { home });
  await viewer.waitForText('【架构讨论】');
  appendJson(collabPath(home, 'posts.jsonl'), postOf(2, { text: 'A\u202eB\u009bC' }));
  await viewer.waitForText('ABC');   // 剥除后剩语义词——重排符 / C1 控制符不得夹带呈现
  appendJson(collabPath(home, 'posts.jsonl'), postOf(3, { text: '组合 👨\u200d👩\u200d👧' }));
  await viewer.waitForText('👨\u200d👩\u200d👧');   // ZWJ 成串的表情序列整体保留
  assert.equal(viewer.out().includes('\u202e'), false, '双向重排符（RLO）不得进输出');
  assert.equal(viewer.out().includes('\u009b'), false, 'C1 控制符（CSI）不得进输出');
});

test('成员事件：系统行（身份名/方向/现人数）、不产生帖行、横幅只印一次', async (t) => {
  const home = makeStationDir(t);
  seedCollab(home, { posts: 1 });
  const viewer = startViewer(t, { home });
  await viewer.waitForText('帖子正文 1');
  const postLinesBefore = viewer.postLines().length;
  appendJson(collabPath(home, 'members.jsonl'), memberEventOf({ eventId: 'ev-join-b', kind: 'join', instanceId: 'inst-peer-b', identityName: '主机乙' }));
  await viewer.waitForText('主机乙 加入（现 2 人）');
  appendJson(collabPath(home, 'members.jsonl'), memberEventOf({ eventId: 'ev-leave-a', kind: 'leave', instanceId: 'inst-author', identityName: '主机甲' }));
  await viewer.waitForText('主机甲 退出（现 1 人）');
  assert.equal(viewer.postLines().length, postLinesBefore, '成员事件不产生帖行');
  assert.equal(viewer.countOf('【架构讨论】'), 1, '横幅只印一次');
});

test('成员流坏行：回放与增量均印跳过提示（与帖流同一提示）', async (t) => {
  const home = makeStationDir(t);
  seedCollab(home, { posts: 1 });
  appendFileSync(collabPath(home, 'members.jsonl'), '{oops not json\n');
  const viewer = startViewer(t, { home });
  await viewer.waitForText('帖子正文 1');
  await viewer.waitForText('跳过一条无法解析的记录行');
  assert.equal(viewer.countOf('跳过一条无法解析的记录行'), 1, '回放期坏行留痕一次');
  assert.equal(viewer.countOf('主机甲 加入'), 0, '回放期成员行不印（既有语义）');
  appendFileSync(collabPath(home, 'members.jsonl'), '{"eventId":"not-an-event"}\n');
  await waitFor(() => (viewer.countOf('跳过一条无法解析的记录行') === 2 ? true : null), WAIT);
  assert.equal(viewer.countOf('跳过一条无法解析的记录行'), 2, '增量期坏行再留痕一次');
});

test('元状态：名称/状态变化各印一行系统行（站长席读台账）', async (t) => {
  const home = makeStationDir(t);
  seedCollab(home, { posts: 1, seat: 'manager' });
  const viewer = startViewer(t, { home });
  await viewer.waitForText('帖子正文 1');
  assert.equal(viewer.lines()[0], '【架构讨论】进行中 ｜ 1 人');
  appendJson(collabPath(home, 'ledger.jsonl'), ledgerOf({ version: 2, name: '架构讨论二' }));
  await viewer.waitForText('名称：架构讨论二');
  appendJson(collabPath(home, 'ledger.jsonl'), ledgerOf({ version: 3, name: '架构讨论二', status: 'completed' }));
  await viewer.waitForText('状态：已结束');
});

test('旧台账：0.1.x 形态按旧判据读取（不因 0.2.0 校验器收严整段判坏）', async (t) => {
  const home = makeStationDir(t);
  seedCollab(home, { posts: 1, seat: 'manager' });
  const viewer = startViewer(t, { home });
  await viewer.waitForText('帖子正文 1');
  assert.equal(viewer.lines()[0], '【架构讨论】进行中 ｜ 1 人');
  assert.equal(viewer.countOf('跳过一条无法解析的记录行'), 0);
  appendJson(collabPath(home, 'ledger.jsonl'), ledgerOf({ version: 2, name: '旧台账改名' }));
  await viewer.waitForText('名称：旧台账改名');
});

test('台账流坏行：回放与增量均印跳过提示（原恒静默面）', async (t) => {
  const home = makeStationDir(t);
  seedCollab(home, { posts: 1, seat: 'manager' });
  appendFileSync(collabPath(home, 'ledger.jsonl'), '{oops not json\n');
  const viewer = startViewer(t, { home });
  await viewer.waitForText('帖子正文 1');
  await viewer.waitForText('跳过一条无法解析的记录行');
  assert.equal(viewer.countOf('跳过一条无法解析的记录行'), 1, '回放期坏行留痕一次');
  appendFileSync(collabPath(home, 'ledger.jsonl'), '{"version":"nope"}\n');
  await waitFor(() => (viewer.countOf('跳过一条无法解析的记录行') === 2 ? true : null), WAIT);
  assert.equal(viewer.countOf('跳过一条无法解析的记录行'), 2, '增量期坏行再留痕一次');
});

test('站长席位已退出：名取台账（对齐 localNameOf）、态取 left（对齐 localStateOf）', async (t) => {
  const home = makeStationDir(t);
  seedCollab(home, { posts: 1, seat: 'manager' });
  writeFileSync(collabPath(home, 'member.json'), JSON.stringify(memberRecordOf({ role: 'manager', state: 'left', name: '记录名甲' })));
  writeFileSync(collabPath(home, 'ledger.jsonl'), `${JSON.stringify(ledgerOf({ name: '台账名乙' }))}\n`);
  const viewer = startViewer(t, { home });
  await viewer.waitForText('帖子正文 1');
  assert.equal(viewer.lines()[0], '【台账名乙】已退出 ｜ 1 人');
});

test('中途消失：标注暂缺并等待，恢复后自卷首重读', async (t) => {
  const home = makeStationDir(t);
  seedCollab(home, { posts: 1 });
  const viewer = startViewer(t, { home });
  await viewer.waitForText('帖子正文 1');
  rmSync(collabPath(home, 'posts.jsonl'));
  await viewer.waitForText('posts.jsonl 暂缺（等待恢复）');
  assert.equal(viewer.child.exitCode, null, '消失不导致退出');
  writeFileSync(collabPath(home, 'posts.jsonl'), `${JSON.stringify(postOf(1))}\n${JSON.stringify(postOf(2))}\n`);
  await viewer.waitForText('posts.jsonl 已恢复，自卷首重读');
  await viewer.waitForText('帖子正文 2');
  assert.equal(viewer.countOf('帖子正文 1'), 2, '恢复后卷首重读');
});

test('暂停：p 后新帖不输出、恢复补齐暂停期内容', async (t) => {
  const home = makeStationDir(t);
  seedCollab(home, { posts: 1 });
  const viewer = startViewer(t, { home });
  await viewer.waitForText('帖子正文 1');
  viewer.child.stdin.write('p');
  await viewer.waitForText('已暂停');
  appendJson(collabPath(home, 'posts.jsonl'), postOf(2));
  await sleep(1200);
  assert.equal(viewer.out().includes('帖子正文 2'), false, '暂停期不输出新数据');
  viewer.child.stdin.write('p');
  await viewer.waitForText('帖子正文 2');
  assert.ok(viewer.out().includes('已恢复'));
});

test('退出：q 与 Ctrl+C 字节均正常退出（码 0）', async (t) => {
  const home = makeStationDir(t);
  seedCollab(home, { posts: 1 });
  const first = startViewer(t, { home });
  await first.waitForText('帖子正文 1');
  const firstExit = exitOf(first.child);
  first.child.stdin.write('q');
  assert.equal(await firstExit, 0);
  const second = startViewer(t, { home });
  await second.waitForText('帖子正文 1');
  const secondExit = exitOf(second.child);
  second.child.stdin.write('\u0003');
  assert.equal(await secondExit, 0);
});

test('参数错误：缺 collabId / 未知选项 / 非法 collabId / 多余参数 → usage 到 stderr、退出码非 0', async (t) => {
  const home = makeStationDir(t);
  const cases = [[], ['--bogus'], ['../evil'], [COLLAB_ID, 'extra'], [COLLAB_ID, '--unknown']];
  for (const args of cases) {
    const run = await runViewerToExit(t, { home, args });
    assert.notEqual(run.code, 0, `args=[${args.join(' ')}] 应非 0 退出`);
    assert.ok(run.stderr.includes('用法'), `args=[${args.join(' ')}] 应输出用法到 stderr`);
    assert.equal(run.stdout, '', `args=[${args.join(' ')}] 不得写 stdout`);
  }
});

test('数据未就绪：横幅如实标注并持续等待，数据出现后补齐', async (t) => {
  const home = makeStationDir(t);
  const viewer = startViewer(t, { home });
  await viewer.waitForText(`【数据未就绪】${COLLAB_ID}`);
  assert.ok(viewer.out().includes('成员未知'));
  assert.equal(viewer.child.exitCode, null, '未就绪不退出、持续等待');
  seedCollab(home, { posts: 1 });
  await viewer.waitForText('数据已就绪：架构讨论');
  await viewer.waitForText('帖子正文 1');
});

test('数据晚就位：首读内容恰好一次——缺席标记不误触发次拍重置（帖 / 成员 / 台账三面）', async (t) => {
  const home = makeStationDir(t);
  const viewer = startViewer(t, { home });
  await viewer.waitForText(`【数据未就绪】${COLLAB_ID}`);
  seedCollab(home, { posts: 1, seat: 'manager' });
  await viewer.waitForText('帖子正文 1');
  await sleep(1200);   // 跨过首读后的两拍轮询：误重置若存在即发生在此窗口
  assert.equal(viewer.countOf('帖子正文 1'), 1, '晚就位首读帖不重印');
  assert.equal(viewer.countOf('主机甲 加入'), 1, '成员系统行恰好一次');
  assert.equal(viewer.countOf('已恢复'), 0, '无「已恢复」误提示（成员 / 台账面同受修）');
  assert.equal(viewer.child.exitCode, null, '持续等待、不退出');
});

test('零写盘：运行前后数据目录逐文件字节 diff 为空（半写尾行也不得被修复）', async (t) => {
  const home = makeStationDir(t);
  seedCollab(home, { posts: 2, seat: 'manager' });
  appendFileSync(collabPath(home, 'posts.jsonl'), '{"entryId":"half-written-by-crash"');
  const before = treeSnapshot(home);
  const viewer = startViewer(t, { home });
  await viewer.waitForText('帖子正文 2');
  await sleep(700);   // 至少跑过一拍轮询
  await stopChild(viewer.child);
  assert.deepEqual(treeSnapshot(home), before, '查看器对数据目录零写入');
});
