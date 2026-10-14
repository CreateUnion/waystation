import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { makeTempDir, pickFreePort, repoRoot, waitFor, waitForRebindable } from './helpers.js';
import { rootDigest } from '../src/viewer/launch.js';
import { COLLABS_DIR_NAME, CONFIG_FILE_NAME } from '../src/paths.js';
import { POSTS_FILE_NAME } from '../src/collab/posts.js';
import { MEMBERS_FILE_NAME } from '../src/collab/members.js';
import { LEDGER_FILE_NAME, MEMBER_FILE_NAME } from '../src/collab/store.js';
import { COUNTER_FILE_NAME } from '../src/collab/counter.js';
import { INBOX_FILE_NAME } from '../src/net/inbound.js';
import { OUTBOX_FILE_NAME } from '../src/net/outbox.js';

/* 观察窗组合根（scripts/ws-viewer.js）的端到端判别用例：spawn 真脚本、临时 WAYSTATION_HOME、
 * 显式 --port（pickFreePort 取位，绝不绑 7330–7339 默认段与站点段 7321–7328）。
 *
 * 纪律（写死）：
 * - 全部 spawn 强制 --no-open：开窗与真实 Edge 绝不进入自动化测试的真实执行路径（开窗计划与
 *   openWindow 的判别面在 viewer-launch.test.js 的注入桩里）；
 * - 子进程收尾＝stdin 送 q 优雅退出（覆盖率落盘的前提）→超时 SIGKILL 兜底→文件级泄漏断言；
 * - --stop 真停用例断言原进程已退出即可：Windows 下 --stop 为硬终止（Node 在 Windows 不投递
 *   SIGTERM 处理器），被杀进程不落覆盖率属预期。 */

const VIEWER = join(repoRoot, 'scripts', 'ws-viewer.js');
const WAIT = { timeoutMs: 8000, intervalMs: 50 };

/* 与 collab-viewer.test.js 同一收尾纪律：收尾钩子按注册序执行，必须先等子进程退出、后删
 * 临时目录；q 请退带短超时兜底 SIGKILL（强杀不落 V8 覆盖数据，只留给异常路径）。 */
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

const STOP_GRACE_MS = 2000;

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try {
    child.stdin?.on('error', () => {});
    child.stdin?.write('q');
  } catch {
    // stdin 不可写（无管道/已关闭）：跳过请退，转等退出＋兜底强杀
  }
  const killer = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS);
  await exited;
  clearTimeout(killer);
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
  assert.equal(leakedPids.length, 0, `观察窗进程未被用例收尾（收尾钩子被跳过？）：${leakedPids.join(',')}——已兜底强制杀灭，检查用例清理`);
});

/* —— 运行器 —— */

function spawnViewer(t, { home, args }) {
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
    waitForText: (text) => waitFor(() => (transcript.stdout.includes(text) ? true : null), WAIT),
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
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(child.exitCode);
  }
  return new Promise((resolve) => child.once('exit', (code) => resolve(code)));
}

const READY_PATTERN = /^观察窗已就绪：http:\/\/127\.0\.0\.1:(\d+)\/（协作与讨论 (\d+) 台）$/;

function readyLineOf(transcript) {
  return transcript.split('\n').find((line) => line.startsWith('观察窗已就绪：')) ?? null;
}

async function waitForReady(viewer, expectedPort) {
  try {
    await waitFor(() => readyLineOf(viewer.out()), WAIT);
  } catch {
    throw new Error(`等待就绪行超时（exitCode=${viewer.child.exitCode}，signal=${viewer.child.signalCode}）stdout=${JSON.stringify(viewer.out())} stderr=${JSON.stringify(viewer.err())}`);
  }
  const matched = READY_PATTERN.exec(readyLineOf(viewer.out()));
  assert.ok(matched !== null, `就绪行格式不符：${JSON.stringify(readyLineOf(viewer.out()))}`);
  assert.equal(Number(matched[1]), expectedPort);
  return { port: Number(matched[1]), count: Number(matched[2]) };
}

async function fetchJson(url) {
  const response = await fetch(url);
  assert.equal(response.status, 200, `GET ${url}`);
  return response.json();
}

/* —— 夹具 —— */

const T0 = '2026-10-14T10:00:00.000Z';

function tsPlus(offsetMs) {
  return new Date(Date.parse(T0) + offsetMs).toISOString();
}

/* 夹具路径：本文件的夹具全在主根——sites/<k> 面由数据层/服务层单测覆盖，e2e 场景不铺第二根；
 * 真需要时再按 viewer-server.test.js 的同名 helper 先例补 root 分支。 */
function collabDirIn(home, collabId) {
  return join(home, COLLABS_DIR_NAME, collabId);
}

function writeFiles(dir, files) {
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
}

function jsonl(...values) {
  return values.map((value) => `${JSON.stringify(value)}\n`).join('');
}

function postOf(index) {
  const constants = {
    1: { kind: 'task', text: '普通一条' },
    2: { kind: 'reply', text: '正文含 **粗体** 与 `代码`' },
    3: { kind: 'issue', text: '<script>alert(1)</script>' },
  };
  const preset = constants[index] ?? { kind: 'reply', text: `帖子 ${index}` };
  return {
    entryId: `post-${index}`,
    seq: index,
    ts: tsPlus(index * 1000),
    from: { instanceId: 'inst-a', identityName: '甲机' },
    ...preset,
  };
}

function memberRecord(over = {}) {
  return {
    collabId: 'c-1',
    name: '讨论甲',
    role: 'manager',
    state: 'active',
    manager: { instanceId: 'mgr-1', identityName: '甲机' },
    endpoints: {},
    roster: [{ instanceId: 'mgr-1', identityName: '甲机' }],
    ...over,
  };
}

function memberEvent(over = {}) {
  return { eventId: 'ev-1', kind: 'join', instanceId: 'inst-a', identityName: '甲机', ts: T0, ...over };
}

function ledgerOf(over = {}) {
  return {
    version: 1,
    collabId: 'c-managed',
    name: '协作甲',
    topic: '主题甲',
    status: 'active',
    manager: { instanceId: 'mgr-1', identityName: '甲机' },
    members: [
      { instanceId: 'mgr-1', identityName: '甲机', role: 'manager', state: 'member', joinedAt: T0 },
      { instanceId: 'inst-b', identityName: '乙机', role: 'member', state: 'member', joinedAt: T0 },
    ],
    board: [],
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

function inboxRow(over = {}) {
  return {
    v: 1,
    type: 'reply',
    msgId: 'msg-in-1',
    from: { instanceId: 'inst-b', identityName: '乙机', port: 7000 },
    collabId: 'c-managed',
    ts: T0,
    payload: { text: '收到' },
    receivedAt: T0,
    ...over,
  };
}

function outboxRow(over = {}) {
  return {
    msgId: 'msg-out-1',
    collabId: 'c-managed',
    to: { instanceId: 'inst-b', address: '127.0.0.1', port: 7000 },
    type: 'reply',
    payload: { text: '发出' },
    governance: false,
    state: 'queued',
    attempts: 0,
    createdAt: T0,
    nextAttemptAt: 0,
    ...over,
  };
}

/* 讨论夹具：posts 条完整帖（默认三条：普通/粗体与行内代码/HTML 注入尝试）＋成员事件＋参与
 * 记录；tailWithoutNewline 追加一条无换行收尾的帖行——半写尾行夹具（读侧不计入，且零写盘闸
 * 要求它保持原字节、不被任何「修复」回写）。 */
function writeForumFixture(home, collabId, { posts = 3, tailWithoutNewline = false } = {}) {
  const lines = [];
  for (let index = 1; index <= posts; index++) {
    lines.push(`${JSON.stringify(postOf(index))}\n`);
  }
  const postsText = tailWithoutNewline ? lines.join('') + JSON.stringify(postOf(posts + 1)) : lines.join('');
  writeFiles(collabDirIn(home, collabId), {
    [POSTS_FILE_NAME]: postsText,
    [MEMBERS_FILE_NAME]: jsonl(memberEvent()),
    [MEMBER_FILE_NAME]: JSON.stringify(memberRecord({ mode: 'forum', collabId })),
  });
}

/* 协作夹具（管理席位）：台账两行（一条迁移）＋累计收到＋收/发各一条内容消息。 */
function writeManagedFixture(home, collabId) {
  writeFiles(collabDirIn(home, collabId), {
    [MEMBER_FILE_NAME]: JSON.stringify(memberRecord({ mode: 'managed', collabId, name: '协作甲' })),
    [LEDGER_FILE_NAME]: jsonl(
      ledgerOf({ collabId }),
      ledgerOf({ collabId, status: 'frozen', updatedAt: tsPlus(1000) }),
    ),
    [COUNTER_FILE_NAME]: JSON.stringify({ v: 1, messageCount: 7 }),
    [INBOX_FILE_NAME]: jsonl(inboxRow({ collabId })),
    [OUTBOX_FILE_NAME]: jsonl(outboxRow({ collabId })),
  });
}

/* 数据目录全量快照（路径→字节）：零写盘判别的比对基准。 */
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

test('全端点走查：就绪行取 URL → health 自家形态 → collabs → feed 渲染与转义 → meta', async (t) => {
  const home = makeTempDir(t);
  writeForumFixture(home, 'c-forum');
  writeManagedFixture(home, 'c-managed');
  writeFileSync(join(home, CONFIG_FILE_NAME), `${JSON.stringify({ identityName: '本机甲' })}\n`);
  const port = await pickFreePort();
  const viewer = spawnViewer(t, { home, args: ['--no-open', '--port', String(port)] });
  const ready = await waitForReady(viewer, port);
  assert.equal(ready.count, 2, '就绪行协作数＝目录事实');

  const health = await fetchJson(`http://127.0.0.1:${port}/api/health`);
  assert.equal(health.app, 'waystation-viewer');
  assert.equal(health.v, 1);
  assert.equal(typeof health.pid, 'number');
  assert.equal(health.root, rootDigest(home), 'health 根摘要＝数据根规范化哈希');

  const collabs = await fetchJson(`http://127.0.0.1:${port}/api/collabs`);
  assert.deepEqual(collabs.collabs.map((entry) => entry.id).sort(), ['c-forum', 'c-managed']);

  const feed = await fetchJson(`http://127.0.0.1:${port}/api/collab/main/c-forum/feed`);
  assert.equal(feed.rows.length, 3);
  assert.ok(feed.rows.find((row) => row.id === 'post-2@inst-a').html.includes('<strong>粗体</strong>'), 'Markdown 粗体在服务端渲染');
  const injected = feed.rows.find((row) => row.id === 'post-3@inst-a');
  assert.ok(injected.html.includes('&lt;script&gt;'), 'HTML 注入尝试被转义');
  assert.equal(injected.html.includes('<script>'), false);

  const meta = await fetchJson(`http://127.0.0.1:${port}/api/collab/main/c-forum/meta`);
  assert.equal(meta.name, '讨论甲');
  assert.equal(meta.state, 'active');
  assert.equal(meta.mode, 'forum');
  assert.equal(meta.count, 3);
});

test('零写盘硬闸：半写尾行＋损坏 config 夹具，全端点走查后逐文件字节零差异', async (t) => {
  const home = makeTempDir(t);
  writeForumFixture(home, 'c-forum', { posts: 2, tailWithoutNewline: true });
  writeManagedFixture(home, 'c-managed');
  writeFileSync(join(home, CONFIG_FILE_NAME), '{损坏的 JSON');
  const before = treeSnapshot(home);

  const port = await pickFreePort();
  const viewer = spawnViewer(t, { home, args: ['--no-open', '--port', String(port)] });
  await waitForReady(viewer, port);
  const paths = [
    '/', '/app.js', '/style.css', '/api/health', '/api/collabs',
    '/api/collab/main/c-forum/feed', '/api/collab/main/c-forum/meta',
    '/api/collab/main/c-managed/feed', '/api/collab/main/c-managed/meta',
  ];
  for (const path of paths) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    assert.equal(response.status, 200, path);
    await response.arrayBuffer();
  }

  const feed = await fetchJson(`http://127.0.0.1:${port}/api/collab/main/c-forum/feed`);
  assert.equal(feed.rows.length, 2, '无换行收尾的尾行不计入帖流');
  assert.equal(feed.skipped, 0, '尾行残段不算坏行');
  const managedFeed = await fetchJson(`http://127.0.0.1:${port}/api/collab/main/c-managed/feed`);
  assert.equal(managedFeed.rows.find((row) => row.direction === 'out').fromName, '本机', '损坏 config 回退本机名，不触发修复写盘');

  await stopChild(viewer.child);
  assert.equal(await exitOf(viewer.child), 0, 'q 通道优雅退出');
  assert.deepEqual(treeSnapshot(home), before, '观察窗运行期不得写入/新增/改动数据根任何字节');
});

test('--port 命中自家＋--no-open：第二个进程打印地址退出 0，第一个照常服务', async (t) => {
  const home = makeTempDir(t);
  writeForumFixture(home, 'c-forum');
  const port = await pickFreePort();
  const first = spawnViewer(t, { home, args: ['--no-open', '--port', String(port)] });
  await waitForReady(first, port);
  const healthBefore = await fetchJson(`http://127.0.0.1:${port}/api/health`);

  const second = await runViewerToExit(t, { home, args: ['--no-open', '--port', String(port)] });
  assert.equal(second.code, 0);
  assert.match(second.stdout, new RegExp(`观察窗已在运行：http://127\\.0\\.0\\.1:${port}/`));
  assert.equal(second.stdout.includes('已就绪'), false, '不给已在跑的端口再起服务');
  assert.equal(second.stderr, '');

  const healthAfter = await fetchJson(`http://127.0.0.1:${port}/api/health`);
  assert.equal(healthAfter.pid, healthBefore.pid, '第一个进程未受影响');
  assert.equal(first.child.exitCode, null, '第一个进程仍存活');
});

/* —— --focus（定位开窗：自动开窗拉起时的详情页入口） —— */

test('--focus：未跑→起服务后打印含 hash 的详情页地址（--no-open），端点可用、q 收尾', async (t) => {
  const home = makeTempDir(t);
  writeForumFixture(home, 'c-forum');
  const port = await pickFreePort();
  const viewer = spawnViewer(t, { home, args: ['--focus', 'main/c-forum', '--no-open', '--port', String(port)] });
  const line = await waitFor(() => readyLineOf(viewer.out()), WAIT);
  assert.ok(
    line.includes(`http://127.0.0.1:${port}/#/c/main/c-forum`),
    `就绪行应含详情页地址（含 hash）：${JSON.stringify(line)}`,
  );
  assert.match(line, /（协作与讨论 1 台）$/);

  const health = await fetchJson(`http://127.0.0.1:${port}/api/health`);
  assert.equal(health.root, rootDigest(home));
  const meta = await fetchJson(`http://127.0.0.1:${port}/api/collab/main/c-forum/meta`);
  assert.equal(meta.name, '讨论甲', '目标协作页的数据面照常可用');

  await stopChild(viewer.child);
  assert.equal(await exitOf(viewer.child), 0, 'q 通道优雅退出');
  assert.equal(viewer.err(), '');
});

test('--focus：同根在跑 → 只打印含 hash 地址、退出 0，不再起服务', async (t) => {
  const home = makeTempDir(t);
  writeForumFixture(home, 'c-forum');
  const port = await pickFreePort();
  const first = spawnViewer(t, { home, args: ['--no-open', '--port', String(port)] });
  await waitForReady(first, port);

  const second = await runViewerToExit(t, { home, args: ['--focus', 'main/c-forum', '--no-open', '--port', String(port)] });
  assert.equal(second.code, 0);
  assert.match(second.stdout, new RegExp(`观察窗已在运行：http://127\\.0\\.0\\.1:${port}/#/c/main/c-forum`));
  assert.equal(second.stdout.includes('已就绪'), false, '不给已在跑的端口再起服务');
  assert.equal(second.stderr, '');
  assert.equal(first.child.exitCode, null, '第一个进程仍存活');
});

test('viewerAutoOpen=false 不影响手开：脚本照常起服务并打印含 hash 地址', async (t) => {
  const home = makeTempDir(t);
  writeForumFixture(home, 'c-forum');
  writeFileSync(join(home, CONFIG_FILE_NAME), `${JSON.stringify({ viewerAutoOpen: false })}\n`);
  const port = await pickFreePort();
  const viewer = spawnViewer(t, { home, args: ['--focus', 'main/c-forum', '--no-open', '--port', String(port)] });
  const line = await waitFor(() => readyLineOf(viewer.out()), WAIT);
  assert.ok(line.includes(`http://127.0.0.1:${port}/#/c/main/c-forum`), '手开不吃开关（开关只作用于自动拉起）');
  await stopChild(viewer.child);
  assert.equal(await exitOf(viewer.child), 0);
});

test('--focus：与 --stop 组合、root 越界、id 非法、缺值 → 用法错误退出码 2', async (t) => {
  const home = makeTempDir(t);
  const cases = [
    ['--focus', 'main/c-1', '--stop'],
    ['--focus', 'main'],
    ['--focus', 's9/c-1'],
    ['--focus', 's1/c-1'],
    ['--focus', 'main/c-1/../../x'],
    ['--focus'],
  ];
  for (const args of cases) {
    const result = await runViewerToExit(t, { home, args });
    assert.equal(result.code, 2, `参数 [${args.join(' ')}] 应判用法错误`);
    assert.match(result.stderr, /用法：/);
    assert.equal(result.stdout, '');
  }
});

/* —— detached 存活（机器代证：短命父进程 spawn 后退出，子进程仍在） —— */

/* 短命父进程代码：走 launch.js 的拉起出口（生产 spawn 选项＋unref），参数换成测试口径
 * （--no-open 纪律＋注入端口）；随后父进程不主动结束——只靠事件循环自然收敛，unref 未生效
 * （子进程句柄拖住循环）即永不退出、用例超时。 */
const DETACHED_PARENT_CODE = `Promise.all([import(process.argv[1]), import('node:child_process')]).then(([launch, childProcess]) => {
  launch.openViewerWindow({
    ref: null,
    dataDir: process.argv[3],
    siteMode: 'explicit',
    slot: null,
    scriptPath: process.argv[2],
    log: { warn: () => {} },
    env: {},
    spawnFn: (command, args, options) => childProcess.spawn(command, [...args, '--no-open', '--port', process.argv[4]], options),
  });
});`;

/* 等健康面应答（子进程就绪判定）：连接拒绝/未就绪返回 null 继续轮询。 */
async function waitHealth(port) {
  return waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      return response.status === 200 ? response.json() : null;
    } catch {
      return null;
    }
  }, WAIT);
}

test('detached 存活：短命父进程 spawn 后退出，观察窗仍应答 health；--stop 收尾', { timeout: 30000 }, async (t) => {
  const home = makeTempDir(t);
  writeForumFixture(home, 'c-forum');
  writeFileSync(join(home, CONFIG_FILE_NAME), `${JSON.stringify({ viewerAutoOpen: true })}\n`);
  const port = await pickFreePort();
  /* 兜底收尾：用例中途失败时也不留下 detached 子进程（正常路径已 --stop，二次 stop 输出
   * 「未发现运行中的观察窗」仍码 0）。同步子进程＋超时上界：收尾钩子内不再注册收尾面，
   * dataDir 只作根摘要输入，目录即便已删也不影响停止判定。 */
  t.after(() => {
    spawnSync(process.execPath, [VIEWER, '--stop', '--port', String(port)], {
      cwd: repoRoot,
      env: { ...process.env, WAYSTATION_HOME: home },
      stdio: 'ignore',
      timeout: 10000,
    });
  });
  const launchUrl = new URL('../src/viewer/launch.js', import.meta.url).href;
  const parent = spawn(process.execPath, ['-e', DETACHED_PARENT_CODE, launchUrl, VIEWER, home, String(port)], {
    cwd: repoRoot,
    env: { ...process.env, WAYSTATION_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let parentErr = '';
  parent.stderr.on('data', (chunk) => {
    parentErr += chunk.toString('utf8');
  });
  const parentExit = await new Promise((resolve, reject) => {
    parent.once('error', reject);
    parent.once('exit', (code) => resolve(code));
  });
  assert.equal(parentExit, 0, `短命父进程应自然退出（unref 未拖住事件循环）；stderr=${JSON.stringify(parentErr)}`);

  const health = await waitHealth(port);
  assert.equal(health.app, 'waystation-viewer', '父进程退出后子进程仍应答');
  assert.equal(health.root, rootDigest(home), '子进程按 WAYSTATION_HOME 定根（显式模式继承）');

  const stopped = await runViewerToExit(t, { home, args: ['--stop', '--port', String(port)] });
  assert.equal(stopped.code, 0, `--stop 收尾应成功：${JSON.stringify(stopped.stdout)}${JSON.stringify(stopped.stderr)}`);
  assert.match(stopped.stdout, /已停止/);
  await waitForRebindable(port);
});

test('q 双字节单块：shutdown 单点化防双触发（server.close 非幂等），仍优雅退出 0', async (t) => {
  const home = makeTempDir(t);
  writeForumFixture(home, 'c-forum');
  const port = await pickFreePort();
  const viewer = spawnViewer(t, { home, args: ['--no-open', '--port', String(port)] });
  await waitForReady(viewer, port);
  viewer.child.stdin.write('qq');   // 同一数据块两个 q：第二个命中单点保护，不得触发第二次 close
  assert.equal(await exitOf(viewer.child), 0);
  assert.equal(viewer.err(), '', '重复触发不得漏出错误的关停噪声');
});

test('--stop 真停：输出已停止行退出 0，原进程退出、端口释放、同端口重起成功', async (t) => {
  const home = makeTempDir(t);
  writeForumFixture(home, 'c-forum');
  const port = await pickFreePort();
  const viewer = spawnViewer(t, { home, args: ['--no-open', '--port', String(port)] });
  await waitForReady(viewer, port);
  const health = await fetchJson(`http://127.0.0.1:${port}/api/health`);

  const stopped = await runViewerToExit(t, { home, args: ['--stop', '--port', String(port)] });
  assert.equal(stopped.code, 0);
  const matched = /^已停止（端口 (\d+)，pid (\d+)）$/m.exec(stopped.stdout);
  assert.ok(matched !== null, `停止输出不符：${JSON.stringify(stopped.stdout)}`);
  assert.equal(Number(matched[1]), port);
  assert.equal(Number(matched[2]), health.pid);

  await exitOf(viewer.child);
  assert.ok(viewer.child.exitCode !== null || viewer.child.signalCode !== null, '原进程已被终止（Windows 下为硬终止）');
  await waitForRebindable(port);

  const restarted = spawnViewer(t, { home, args: ['--no-open', '--port', String(port)] });
  await waitForReady(restarted, port);
});

test('显式 --port 被别根观察窗占据：报错退出 2，不误认自家', async (t) => {
  const homeA = makeTempDir(t);
  const homeB = makeTempDir(t);
  writeForumFixture(homeA, 'c-forum');
  writeForumFixture(homeB, 'c-forum');
  const port = await pickFreePort();
  const viewerA = spawnViewer(t, { home: homeA, args: ['--no-open', '--port', String(port)] });
  await waitForReady(viewerA, port);
  const healthBefore = await fetchJson(`http://127.0.0.1:${port}/api/health`);

  const viewerB = await runViewerToExit(t, { home: homeB, args: ['--no-open', '--port', String(port)] });
  assert.equal(viewerB.code, 2);
  assert.match(viewerB.stderr, /属于另一数据根的观察窗或他人进程/);
  assert.equal(viewerB.stdout, '');

  const healthAfter = await fetchJson(`http://127.0.0.1:${port}/api/health`);
  assert.equal(healthAfter.pid, healthBefore.pid, '同根观察窗不受影响');
});

test('用法错误：--port 取值非法或未知选项→stderr 用法＋退出码 2', async (t) => {
  const home = makeTempDir(t);
  const badPort = await runViewerToExit(t, { home, args: ['--port', 'abc'] });
  assert.equal(badPort.code, 2);
  assert.match(badPort.stderr, /^用法：node scripts\/ws-viewer\.js \[--focus <root>\/<id>\] \[--port N\] \[--no-open\] \[--stop\]$/m);
  assert.equal(badPort.stdout, '');

  const outOfRange = await runViewerToExit(t, { home, args: ['--port', '70000'] });
  assert.equal(outOfRange.code, 2);

  const unknown = await runViewerToExit(t, { home, args: ['--oops'] });
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /用法：/);
});

test('--stop 未发现：空闲端口→未发现运行中的观察窗，退出 0', async (t) => {
  const home = makeTempDir(t);
  const port = await pickFreePort();
  const result = await runViewerToExit(t, { home, args: ['--stop', '--port', String(port)] });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /未发现运行中的观察窗/);
  assert.equal(result.stderr, '');
});
