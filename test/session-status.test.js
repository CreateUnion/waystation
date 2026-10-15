import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSessionStatusWriter, isIndicatedCollab } from '../src/session-status.js';
import { coreJsonPath, sessionFilePath } from '../src/paths.js';
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

test('归档条目不进指示面：归档与非归档混合清单 → 文件 collabs 仅保留非归档', (t) => {
  /* 与组合根收集接线同形：谓词过滤后进快照，断言落在指示面（文件 collabs）。
   * 该行为此前无任何断言（过滤内联于组合根，无独立观测面），本用例即其锁点——谓词判反即红。 */
  const entries = [
    { collabId: 'collab-active', name: '联调项目', state: 'active', role: 'manager', memberCount: 3, archived: false },
    { collabId: 'collab-completed', name: '已结束项目', state: 'completed', role: 'manager', memberCount: 3, archived: true },
    { collabId: 'collab-left', name: '已退出项目', state: 'left', role: 'member', memberCount: 2, archived: true },
  ];
  const { dir, writer } = makeWriter(t, {
    collect: () => sampleSnapshot({ collabs: entries.filter(isIndicatedCollab) }),
  });
  writer.refresh();
  const payload = JSON.parse(readFileSync(sessionFilePath(dir, 'session-abc-1'), 'utf8'));
  assert.deepEqual(payload.collabs, [entries[0]]);
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

test('close 后刷新与启动：终态守卫——不复活文件、不产生新写入、active 报停用', (t) => {
  const { dir, writer } = makeWriter(t);
  writer.start();
  const file = sessionFilePath(dir, 'session-abc-1');
  assert.equal(existsSync(file), true);
  writer.close();
  const writesAfterClose = writer.stats().writes;
  writer.refresh();
  writer.start();
  assert.equal(existsSync(file), false, 'close 为终态：其后 refresh / start 不复活文件');
  assert.equal(writer.stats().writes, writesAfterClose, '不产生新写入');
  assert.equal(writer.stats().active, false, 'close 后 active 报停用');
});

test('关闭删文件失败：路径被目录占位 → 告警不抛出、占位物原样保留', (t) => {
  const { dir, entries, writer } = makeWriter(t);
  const file = sessionFilePath(dir, 'session-abc-1');
  mkdirSync(file, { recursive: true });
  writer.close();
  assert.equal(entries.some((entry) => entry.level === 'warn' && entry.message.includes('会话状态文件清除失败')), true);
  assert.equal(existsSync(file), true, '删除失败不重试、不清空（读取端按时间判陈旧兜底）');
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

/* 站点收尾（单核形态）：node:test 的收尾钩子按注册序执行，而临时目录的删除钩子由 makeTempDir 在其
 * 调用点先行注册——「先杀桥进程、再收核、后删目录」要求收尾钩子抢在删除钩子之前注册（与
 * server.test.js 同一模式），否则删除撞上存活核心的写盘抛错会跳过其后全部钩子（含杀进程）——
 * 泄漏的子进程拖住文件进程永不退出，runner 无限等待该文件（整轮运行冻结）。
 * 收核晚于桥退出：桥存活时杀核会触发桥督视重生（孤儿核心）。 */
const cleanupByTest = new WeakMap();
const stationChildren = [];   // 文件级兜底：本文件启动过的全部站点（桥）进程

function isProcessAlive(pid) {
  if (pid === null) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/* 按 core.json 收核（桥已退场后用；无描述符/已退出＝核心已自行收尾，静默无事）。 */
function killCoreOf(home) {
  try {
    const record = JSON.parse(readFileSync(coreJsonPath(home), 'utf8'));
    if (Number.isInteger(record.pid) && isProcessAlive(record.pid)) {
      process.kill(record.pid, 'SIGKILL');
    }
  } catch {
    // 无描述符：核心已自行退出
  }
}

function cleanupRegistryOf(t) {
  let cleanup = cleanupByTest.get(t);
  if (cleanup === undefined) {
    cleanup = { children: [], homes: [] };
    cleanupByTest.set(t, cleanup);
    t.after(async () => {
      for (const child of cleanup.children) {
        await stopChild(child);
      }
      for (const home of cleanup.homes) {
        killCoreOf(home);
      }
    });
  }
  return cleanup;
}

/* 强杀并等 exit 落地；已退出的进程无操作。 */
async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
}

/* 站点数据目录：收尾钩子先于 makeTempDir 的删除钩子注册（见上）；目录登记进本用例收尾（收核）。 */
function makeStationDir(t) {
  const cleanup = cleanupRegistryOf(t);
  const dir = makeTempDir(t);
  cleanup.homes.push(dir);
  return dir;
}

/* 新起的站点进程登记进用例清单与文件清单（用例收尾强杀；文件末兜底查漏）。 */
function registerChild(t, child) {
  cleanupRegistryOf(t).children.push(child);
  stationChildren.push(child);
}

/* 文件级兜底：任何收尾钩子被跳过（如钩子抛错）都会留下存活的站点进程——此处强制杀灭并响亮失败，
 * 绝不让泄漏把整轮运行拖进永不退出的等待（正常路径全部已杀，兜底无事可做）。 */
after(() => {
  const leakedPids = [];
  for (const child of stationChildren) {
    if (child.exitCode === null && child.signalCode === null) {
      leakedPids.push(child.pid);
      child.kill('SIGKILL');
    }
  }
  assert.equal(leakedPids.length, 0, `站点进程未被用例收尾（收尾钩子被跳过？）：${leakedPids.join(',')}——已兜底强制杀灭，检查用例清理`);
});

/* 成员记录磁盘夹具（会话状态文件的模式标签来自真实载入路径）：mode 缺省不写 = 旧版记录形态。 */
function writeMemberFixture(home, { collabId, name, mode }) {
  const now = new Date().toISOString();
  const record = {
    collabId,
    role: 'member',
    state: 'proposed',
    name,
    manager: { instanceId: 'inst-a', identityName: '主机甲' },
    roster: [{ instanceId: 'inst-a', identityName: '主机甲' }, { instanceId: 'inst-self', identityName: '本机' }],
    endpoints: {},
    invitedAt: now,
    expiresAt: new Date(Date.parse(now) + 86400000).toISOString(),
    decision: null,
  };
  if (mode !== undefined) {
    record.mode = mode;
  }
  mkdirSync(join(home, 'collabs', collabId), { recursive: true });
  writeFileSync(join(home, 'collabs', collabId, 'member.json'), JSON.stringify(record));
}

/* 绑定表磁盘夹具（单核写面按绑定归属过滤会话文件的 collabs：绑定源＝run/bindings.json）。
 * entries＝[collabId, sessionId] 对：归属可跨会话（负例＝绑到别的会话）。 */
function writeBindingsFixture(home, entries) {
  const now = new Date().toISOString();
  const bindings = Object.fromEntries(entries.map(([collabId, sessionId], index) => [collabId, {
    sessionId,
    bridgeId: `bridge-fixture-${index + 1}`,
    boundAt: now,
    origin: 'join',
  }]));
  mkdirSync(join(home, 'run'), { recursive: true });
  writeFileSync(join(home, 'run', 'bindings.json'), JSON.stringify(bindings));
}

test('进程级：讨论参与随模式标签进入会话状态文件（缺 mode 的旧记录按 managed 解释；单核写面按绑定归属）', { timeout: 30000 }, async (t) => {
  const home = makeStationDir(t);
  const port = await pickFreePort();
  // viewerAutoOpen: false——起站夹具不拉起真实观察窗（配置驱动的主保障）
  writeFileSync(join(home, 'config.json'), JSON.stringify({ port, scanWindowMs: 300, dialTimeoutMs: 1500, viewerAutoOpen: false }));
  writeMemberFixture(home, { collabId: 'collab-forum-fx', name: '联调讨论', mode: 'forum' });
  writeMemberFixture(home, { collabId: 'collab-legacy-fx', name: '联调项目' });
  /* 负例：第三条协作在册（成员文件在场）但绑定归属另一会话——不得进入本会话文件 */
  writeMemberFixture(home, { collabId: 'collab-other-fx', name: '别会话项目' });
  const sessionId = 'session-forum-fx';
  writeBindingsFixture(home, [
    ['collab-forum-fx', sessionId],
    ['collab-legacy-fx', sessionId],
    ['collab-other-fx', 'session-other-fx'],
  ]);
  const child = spawn(process.execPath, [join(repoRoot, 'src', 'index.js')], {
    cwd: repoRoot,
    env: { ...process.env, WAYSTATION_HOME: home, CLAUDE_CODE_SESSION_ID: sessionId, WAYSTATION_TEST_GRACE_MS: '1500' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  registerChild(t, child);
  const file = sessionFilePath(home, sessionId);
  await waitFor(() => (existsSync(file) ? true : null), { timeoutMs: 15000 });
  const payload = JSON.parse(readFileSync(file, 'utf8'));
  const byId = Object.fromEntries(payload.collabs.map((entry) => [entry.collabId, entry]));
  assert.equal(payload.collabs.length, 2, '绑定归属本会话的两条协作进入文件（per-session 过滤）');
  assert.equal(byId['collab-other-fx'], undefined, '绑到别会话的协作被过滤（负例）');
  assert.equal(byId['collab-forum-fx'].mode, 'forum', '讨论条目带模式标签');
  assert.equal(byId['collab-forum-fx'].state, 'proposed');
  /* 讨论的成员数 = 折叠成员表（成员事件并集折叠）——夹具只有名单、没有成员事件 → 0 人。 */
  assert.equal(byId['collab-forum-fx'].memberCount, 0);
  assert.equal(byId['collab-legacy-fx'].mode, 'managed', '缺 mode 的旧记录按 managed 解释');
  child.stdin.end();
  const exit = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 15000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  assert.equal(exit, 0);
});

test('进程级：会话标识经环境注入 → 核心为注册桥写文件（字段正确）；stdin 关闭 → 桥退出 0 且核心删文件', { timeout: 30000 }, async (t) => {
  const home = makeStationDir(t);
  const port = await pickFreePort();
  // viewerAutoOpen: false——同起站夹具纪律
  writeFileSync(join(home, 'config.json'), JSON.stringify({ port, scanWindowMs: 300, dialTimeoutMs: 1500, viewerAutoOpen: false }));
  const sessionId = 'session-process-1';
  const child = spawn(process.execPath, [join(repoRoot, 'src', 'index.js')], {
    cwd: repoRoot,
    env: { ...process.env, WAYSTATION_HOME: home, CLAUDE_CODE_SESSION_ID: sessionId, WAYSTATION_TEST_GRACE_MS: '1500' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  registerChild(t, child);
  const file = sessionFilePath(home, sessionId);
  await waitFor(() => (existsSync(file) ? true : null), { timeoutMs: 15000 });
  const payload = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(payload.sessionId, sessionId);
  assert.equal(payload.port, port);
  assert.deepEqual(payload.collabs, []);
  assert.equal(payload.site.mode, 'single', '核心写面的站点形态恒 single');
  assert.notEqual(payload.pid, child.pid, '文件由核心写（桥不写数据根）');
  child.stdin.end();
  const exit = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 15000);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  assert.deepEqual(exit, { code: 0, signal: null });
  /* 桥断开 = 会话关闭：核心删除该会话状态文件（写面在核心，删除随断开通知——等待时序） */
  await waitFor(() => (existsSync(file) ? null : true), { timeoutMs: 10000 });
  assert.equal(existsSync(file), false, '桥断开后由核心清除会话状态文件（会话关闭即离线）');
});
