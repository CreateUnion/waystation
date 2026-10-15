import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireCoreLock, createArbiter, createBridgeRegistry, createEndpointProbe, createGraceWindow,
  createOwnedHeartbeat, createWaitingLifetime, lifecycleParams, probeEndpoint, readCoreRecord,
  readPersistentCore, reclaimStaleLock, removeOwnCoreRecord, sameCoreRecord, sameProcessRecord,
  startHeartbeat,
} from '../src/core/lifecycle.js';
import { IPC_VERSION, createIpcClient, createIpcServer } from '../src/core/ipc.js';
import { startCore } from '../src/core/main.js';
import { makeTempDir, pickFreePort, repoRoot, waitFor, waitForRebindable } from './helpers.js';

/* 生命周期层用例（设计 §2.3 取锁仲裁／§3.2 宽限／§3.4 常驻／§6.1 端口语义）：
 * 仲裁与宽限全部经进程内构造（时钟/活性/端点反证均可注入），进程级用例只覆盖接线后的端到端形态。
 * 测试一律临时根（WAYSTATION_HOME 语义由夹具承载），绝不触碰真实数据根；端口一律高位动态取用。 */

const CORE_ENTRY = join(repoRoot, 'bin', 'waystation-core.js');
const CORE_FILE = join('run', 'core.json');
const TOKEN = 'a1'.repeat(32);

/* 进程收尾模式与 core-startup.test.js 同口径：收尾钩子先于 makeTempDir 的删除钩子注册。 */
const cleanupByTest = new WeakMap();
function cleanupOf(t) {
  let cleanup = cleanupByTest.get(t);
  if (cleanup === undefined) {
    cleanup = { children: [], stops: [] };
    cleanupByTest.set(t, cleanup);
    t.after(async () => {
      for (const stop of cleanup.stops) {
        await stop();
      }
      for (const child of cleanup.children) {
        await killChild(child);
      }
    });
  }
  return cleanup;
}

async function killChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
}

function makeLifecycleHome(t) {
  cleanupOf(t);
  return makeTempDir(t);
}

const allChildren = [];
after(async () => {
  const leaked = [];
  for (const child of allChildren) {
    if (child.exitCode === null && child.signalCode === null) {
      leaked.push(child.pid);
      await killChild(child);
    }
  }
  assert.deepEqual(leaked, [], `核心进程未被用例收尾：${leaked.join(',')}——已兜底强制关闭，检查用例清理`);
});

/* 可控时钟：仲裁的观测间隔走单调钟、心跳新鲜判据走墙钟——skip() 只跳墙钟（模拟系统睡眠/时钟跳变）。 */
function createFakeClock() {
  const state = { mono: 1000, wall: Date.now() };
  return {
    now: () => state.mono,
    wallNow: () => state.wall,
    advance(ms) {
      state.mono += ms;
      state.wall += ms;
    },
    skipWall(ms) {
      state.wall += ms;
    },
  };
}

function coreRecordOf(overrides = {}) {
  const startedAt = new Date(Date.now() - 1000).toISOString();
  return {
    v: 1,
    ipcV: IPC_VERSION,
    appVersion: '0.1.0',
    pid: 4000,
    endpoint: '\\\\?\\pipe\\waystation-deadbeef',
    token: TOKEN,
    identity: null,
    port: 19000,
    startedAt,
    status: 'starting',
    startupDeadline: new Date(Date.parse(startedAt) + 15000).toISOString(),
    heartbeatAt: new Date().toISOString(),
    ...overrides,
  };
}

function writeCoreJson(home, overrides) {
  mkdirSync(join(home, 'run'), { recursive: true });
  const path = join(home, CORE_FILE);
  writeFileSync(path, JSON.stringify(coreRecordOf(overrides), null, 2) + '\n');
  return path;
}

function makeArbiter(home, options = {}) {
  const clock = options.clock ?? createFakeClock();
  return {
    clock,
    arbiter: createArbiter({
      corePath: join(home, CORE_FILE),
      now: clock.now,
      wallNow: clock.wallNow,
      isAlive: options.isAlive ?? (() => true),
      probe: options.probe ?? (async () => 'reachable'),
      params: { judgeMs: options.judgeMs ?? 1500, pollMs: options.pollMs ?? 100 },
      log: null,
    }),
  };
}

/* —— 注入缝参数 —— */

test('lifecycleParams：生效闸（未开闸回落内建）；开闸按范围解析；形态不合按未注入', () => {
  const closed = lifecycleParams({ WAYSTATION_TEST_HEARTBEAT_MS: '200' });
  assert.equal(closed.heartbeatMs, 5000, '未开闸（无 NODE_TEST_CONTEXT）不生效');
  const open = lifecycleParams({
    NODE_TEST_CONTEXT: 'x',
    WAYSTATION_TEST_HEARTBEAT_MS: '200',
    WAYSTATION_TEST_GRACE_MS: '800',
  });
  assert.equal(open.heartbeatMs, 200);
  assert.equal(open.graceMs, 800);
  assert.equal(open.judgeMs, 15000, '未注入判死阈值＝max(3×心跳, 15s) 下界');
  assert.equal(open.startupDelayMs, 0, '拉长启动未注入＝0（生产恒 0）');
  const malformed = lifecycleParams({ NODE_TEST_CONTEXT: 'x', WAYSTATION_TEST_HEARTBEAT_MS: 'abc' });
  assert.equal(malformed.heartbeatMs, 5000, '形态不合按未注入（不静默改用近似值）');
});

/* —— 锁步与对证原语 —— */

test('acquireCoreLock：独占创建；EEXIST 按已有锁拒绝；EACCES/EROFS 直接报错（不读不判不清理）', async (t) => {
  const home = makeLifecycleHome(t);
  const corePath = join(home, CORE_FILE);
  const first = acquireCoreLock({ dataDir: home, record: coreRecordOf() });
  assert.deepEqual(first, { ok: true });
  assert.equal(readFileSync(corePath, 'utf8').includes(TOKEN), true, '锁文件应写入运行描述符');
  const second = acquireCoreLock({ dataDir: home, record: coreRecordOf({ token: 'b2'.repeat(32) }) });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'already-exists');
  assert.equal(readCoreRecord(corePath).record.token, TOKEN, 'EEXIST 分支不得改写既有锁');
  // 平台性 errno（Windows 无 EACCES/EROFS 常态）：以注入桩驱动分级判定
  for (const code of ['EACCES', 'EROFS']) {
    const outcome = acquireCoreLock({
      dataDir: home,
      record: coreRecordOf(),
      createExclusive: () => {
        const error = new Error(code);
        error.code = code;
        throw error;
      },
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, 'data-dir-unwritable', `${code} 应直接报错`);
    assert.ok(outcome.message.includes(code), outcome.message);
  }
});

test('锁对证原语：token/startedAt 与 pid/startedAt 两组字段（判死复校与迁出重验各用一组）', () => {
  const mine = coreRecordOf();
  assert.equal(sameCoreRecord(mine, { ...mine }), true);
  assert.equal(sameCoreRecord(mine, { ...mine, startedAt: new Date().toISOString() }), false);
  assert.equal(sameCoreRecord(mine, { ...mine, token: 'c3'.repeat(32) }), false);
  assert.equal(sameProcessRecord(mine, { ...mine, token: 'c3'.repeat(32) }), true, 'pid/startedAt 组不看 token');
  assert.equal(sameProcessRecord(mine, { ...mine, pid: mine.pid + 1 }), false);
  assert.equal(sameProcessRecord(mine, null), false);
  assert.equal(sameCoreRecord(mine, null), false);
});

test('removeOwnCoreRecord：锁仍为自己→删除；被继任者重写→保留；文件缺失→无事', async (t) => {
  const home = makeLifecycleHome(t);
  const corePath = join(home, CORE_FILE);
  const mine = coreRecordOf();
  acquireCoreLock({ dataDir: home, record: mine });
  const warns = [];
  removeOwnCoreRecord({ corePath, mine, log: { warn: (message) => warns.push(message) } });
  assert.equal(existsSync(corePath), false, '自己的锁正常退出应删除');
  removeOwnCoreRecord({ corePath, mine, log: { warn: (message) => warns.push(message) } });
  assert.equal(warns.length, 0, '文件缺失按无事处理');
  acquireCoreLock({ dataDir: home, record: mine });
  writeFileSync(corePath, JSON.stringify({ ...mine, startedAt: new Date(Date.now() + 1000).toISOString() }) + '\n');
  removeOwnCoreRecord({ corePath, mine, log: { warn: (message) => warns.push(message) } });
  assert.equal(existsSync(corePath), true, '对证不符必须保留（防删掉继任者的锁）');
  assert.equal(warns.length, 1);
});

test('reclaimStaleLock：内容未变→原子 rename 独占清理；继任者重写→拒绝；源缺失→gone', async (t) => {
  const home = makeLifecycleHome(t);
  const corePath = join(home, CORE_FILE);
  const stale = coreRecordOf({ pid: 2 ** 30 });
  acquireCoreLock({ dataDir: home, record: stale });
  const outcome = reclaimStaleLock({ corePath, expected: stale, log: null });
  assert.equal(outcome.ok, true);
  assert.equal(existsSync(corePath), false, '清理后原名不应存在');
  assert.equal(existsSync(outcome.stalePath), true, '原锁以 stale 副本留证');
  assert.match(outcome.stalePath, /core\.json\.stale-[0-9a-f]+$/);
  assert.equal(readCoreRecord(corePath).reason, 'missing');
  acquireCoreLock({ dataDir: home, record: stale });
  const changed = reclaimStaleLock({ corePath, expected: { ...stale, token: 'd4'.repeat(32) }, log: null });
  assert.deepEqual(changed, { ok: false, reason: 'changed' }, '判定后锁被重写必须拒绝删除');
  assert.equal(existsSync(corePath), true);
  writeFileSync(corePath, '{ not json');
  const unreadable = reclaimStaleLock({ corePath, expected: null, log: null });
  assert.equal(unreadable.ok, true, '不可解析且 expected 为空时允许清理（陈旧判据由调用方给出）');
  const gone = reclaimStaleLock({ corePath, expected: null, log: null });
  assert.deepEqual(gone, { ok: false, reason: 'gone' });
});

/* —— 仲裁四分支与判死收紧 —— */

test('仲裁 a：pid 已死→判陈旧并原子清理（stale 副本落盘）', async (t) => {
  const home = makeLifecycleHome(t);
  writeCoreJson(home, { pid: 2 ** 30 });
  const { arbiter } = makeArbiter(home, { isAlive: () => false });
  const outcome = await arbiter.poll();
  assert.equal(outcome.kind, 'cleared');
  assert.equal(outcome.staleReason, 'pid-dead');
  assert.equal(existsSync(join(home, CORE_FILE)), false);
});

test('仲裁 a：JSON 不可解析（mtime 陈旧＝真残留）→判陈旧清理（不静默删除：先 rename 留证）', async (t) => {
  const home = makeLifecycleHome(t);
  mkdirSync(join(home, 'run'), { recursive: true });
  const corePath = join(home, CORE_FILE);
  writeFileSync(corePath, '{ half written');
  const past = new Date(Date.now() - 60000);
  utimesSync(corePath, past, past);
  const { arbiter } = makeArbiter(home);
  const outcome = await arbiter.poll();
  assert.equal(outcome.kind, 'cleared');
  assert.equal(outcome.staleReason, 'unreadable');
  assert.match(outcome.stalePath, /core\.json\.stale-/);
});

test('半写锁窗口豁免：空 core.json＋mtime 新近→不清、下一轮再读', async (t) => {
  const home = makeLifecycleHome(t);
  mkdirSync(join(home, 'run'), { recursive: true });
  const corePath = join(home, CORE_FILE);
  writeFileSync(corePath, '');
  const { arbiter } = makeArbiter(home);
  const outcome = await arbiter.poll();
  assert.equal(outcome.kind, 'wait');
  assert.equal(outcome.reason, 'settling', '独占创建与内容写入之间的半写窗口不得判陈旧');
  assert.equal(existsSync(corePath), true, '锁不得被清理');
});

test('半写窗口收敛：空 core.json＋mtime 陈旧→照常原子清理（防真残留滞留）', async (t) => {
  const home = makeLifecycleHome(t);
  mkdirSync(join(home, 'run'), { recursive: true });
  const corePath = join(home, CORE_FILE);
  writeFileSync(corePath, '');
  const past = new Date(Date.now() - 60000);
  utimesSync(corePath, past, past);
  const { arbiter } = makeArbiter(home);
  const outcome = await arbiter.poll();
  assert.equal(outcome.kind, 'cleared');
  assert.equal(outcome.staleReason, 'unreadable');
  assert.equal(existsSync(corePath), false);
});

test('仲裁 b：starting＋心跳新鲜→等待（不删不抢；启动窗口内端点不可连不构成陈旧判据）', async (t) => {
  const home = makeLifecycleHome(t);
  writeCoreJson(home, { status: 'starting' });
  const { arbiter } = makeArbiter(home, { probe: async () => 'unreachable' });
  const outcome = await arbiter.poll();
  assert.equal(outcome.kind, 'wait');
  assert.equal(outcome.reason, 'starting');
  assert.equal(existsSync(join(home, CORE_FILE)), true, '等待分支不得触碰锁');
});

test('仲裁 b：waiting＋心跳新鲜→等待（无启动截止期，不参与截止期判死）', async (t) => {
  const home = makeLifecycleHome(t);
  writeCoreJson(home, { status: 'waiting', startupDeadline: undefined });
  const { arbiter } = makeArbiter(home);
  assert.equal((await arbiter.poll()).kind, 'wait');
});

test('仲裁 c：ready＋端点反证可连→让位（running）；不可连→occupied 保守退出', async (t) => {
  const home = makeLifecycleHome(t);
  writeCoreJson(home, { status: 'ready' });
  const reachable = makeArbiter(home, { probe: async () => 'reachable' });
  const running = await reachable.arbiter.poll();
  assert.equal(running.kind, 'running');
  assert.equal(running.via, 'probe');
  const unreachable = makeArbiter(home, { probe: async () => 'unreachable' });
  const occupied = await unreachable.arbiter.poll();
  assert.equal(occupied.kind, 'occupied');
  assert.equal(occupied.reason, 'endpoint-unreachable');
  const unavailable = makeArbiter(home, { probe: async () => 'unavailable' });
  const noProbe = await unavailable.arbiter.poll();
  assert.equal(noProbe.kind, 'occupied');
  assert.equal(noProbe.reason, 'probe-unavailable');
  assert.equal(existsSync(join(home, CORE_FILE)), true, 'occupied 分支不得触碰锁');
});

test('仲裁 d：超期先观察（间隔不足不判死），连续两次独立观测＋端点不可连→判死清理', async (t) => {
  const home = makeLifecycleHome(t);
  writeCoreJson(home, { status: 'ready', heartbeatAt: new Date(Date.now() - 60000).toISOString() });
  const { arbiter, clock } = makeArbiter(home, { probe: async () => 'unreachable', judgeMs: 1500 });
  const first = await arbiter.poll();
  assert.equal(first.kind, 'wait');
  assert.equal(first.reason, 'observe', '第一次超期观测只登记候选');
  clock.advance(800);
  assert.equal((await arbiter.poll()).reason, 'observe', '间隔不足判死阈值不得清理');
  clock.advance(900);
  const final = await arbiter.poll();
  assert.equal(final.kind, 'cleared');
  assert.equal(final.staleReason, 'judged-dead');
  assert.equal(existsSync(join(home, CORE_FILE)), false);
});

test('仲裁 d：starting 超 startupDeadline 进候选（截止期超期与心跳超期同为候选条件）', async (t) => {
  const home = makeLifecycleHome(t);
  writeCoreJson(home, {
    status: 'starting',
    startedAt: new Date(Date.now() - 40000).toISOString(),
    startupDeadline: new Date(Date.now() - 25000).toISOString(),
    heartbeatAt: new Date().toISOString(),
  });
  const { arbiter, clock } = makeArbiter(home, { probe: async () => 'unreachable', judgeMs: 1000 });
  assert.equal((await arbiter.poll()).reason, 'observe');
  clock.advance(1100);
  const outcome = await arbiter.poll();
  assert.equal(outcome.kind, 'cleared');
});

test('仲裁 d：超期但端点反证可连→降活不判死（候选状态重置）', async (t) => {
  const home = makeLifecycleHome(t);
  writeCoreJson(home, { status: 'ready', heartbeatAt: new Date(Date.now() - 60000).toISOString() });
  const { arbiter, clock } = makeArbiter(home, { probe: async () => 'reachable', judgeMs: 1000 });
  assert.equal((await arbiter.poll()).reason, 'observe');
  clock.advance(1100);
  const alive = await arbiter.poll();
  assert.equal(alive.kind, 'running');
  assert.equal(alive.via, 'alive', '端点可连＝活核：降活而非判死');
  assert.equal(existsSync(join(home, CORE_FILE)), true);
});

test('仲裁 e：判定后锁被继任者重写→清理前复校拒绝（保留继任者的锁）', async (t) => {
  const home = makeLifecycleHome(t);
  writeCoreJson(home, { status: 'ready', heartbeatAt: new Date(Date.now() - 60000).toISOString() });
  const { arbiter, clock } = makeArbiter(home, { probe: async () => 'unreachable', judgeMs: 1000 });
  assert.equal((await arbiter.poll()).reason, 'observe');
  clock.advance(1100);
  // 两次观测之间锁被重写（token 变化、且心跳仍处超期态）：候选快照与现状不符
  writeFileSync(join(home, CORE_FILE), JSON.stringify(coreRecordOf({
    status: 'ready',
    token: 'e5'.repeat(32),
    heartbeatAt: new Date(Date.now() - 60000).toISOString(),
  })) + '\n');
  const outcome = await arbiter.poll();
  assert.equal(outcome.kind, 'wait');
  assert.equal(outcome.reason, 'changed');
  assert.equal(existsSync(join(home, CORE_FILE)), true, '内容已变必须保留');
});

test('睡眠恢复：墙钟大跳变＋单调钟原位→不判死；唤醒后心跳恢复→候选解除', async (t) => {
  const home = makeLifecycleHome(t);
  writeCoreJson(home, { status: 'ready', heartbeatAt: new Date(Date.now() - 60000).toISOString() });
  const { arbiter, clock } = makeArbiter(home, { probe: async () => 'reachable', judgeMs: 1500 });
  assert.equal((await arbiter.poll()).reason, 'observe');
  // 系统睡眠 16 小时：墙钟跳过、单调钟只走 50ms——观测间隔按单调钟计，不得判死
  clock.skipWall(16 * 3600 * 1000);
  clock.advance(50);
  const woken = await arbiter.poll();
  assert.equal(woken.reason, 'observe', '睡眠唤醒不得因墙钟跳变累计观测间隔');
  // 唤醒后核心心跳恢复（活核自证）：候选解除、回到等待/让位判定
  clock.advance(1500);
  writeFileSync(join(home, CORE_FILE), JSON.stringify(coreRecordOf({
    status: 'ready',
    heartbeatAt: new Date(clock.wallNow()).toISOString(),
  })) + '\n');
  const recovered = await arbiter.poll();
  assert.equal(recovered.kind, 'running');
  assert.equal(recovered.via, 'probe');
  assert.equal(existsSync(join(home, CORE_FILE)), true, '活核不得被偷锁');
});

test('createArbiter：选项校验（缺时钟/活性/反证/参数一律拒绝构造）', () => {
  const base = {
    corePath: 'unused',
    now: () => 0,
    wallNow: () => 0,
    isAlive: () => true,
    probe: async () => 'reachable',
    params: { judgeMs: 1000, pollMs: 100 },
  };
  assert.throws(() => createArbiter({ ...base, now: undefined }), TypeError);
  assert.throws(() => createArbiter({ ...base, wallNow: null }), TypeError);
  assert.throws(() => createArbiter({ ...base, isAlive: null }), TypeError);
  assert.throws(() => createArbiter({ ...base, probe: undefined }), TypeError);
  assert.throws(() => createArbiter({ ...base, params: { judgeMs: 1.5, pollMs: 100 } }), TypeError);
  assert.throws(() => createArbiter({ ...base, params: null }), TypeError);
});

test('仲裁 d：端点反证探测器抛异常→按探测未完成处理（宁可不杀）', async (t) => {
  const home = makeLifecycleHome(t);
  writeCoreJson(home, { status: 'ready', heartbeatAt: new Date(Date.now() - 60000).toISOString() });
  const { arbiter, clock } = makeArbiter(home, {
    probe: async () => {
      throw new Error('探测器内部错误');
    },
    judgeMs: 1000,
  });
  assert.equal((await arbiter.poll()).reason, 'observe');
  clock.advance(1100);
  const outcome = await arbiter.poll();
  assert.equal(outcome.kind, 'occupied');
  assert.equal(outcome.reason, 'probe-unavailable');
  assert.equal(existsSync(join(home, CORE_FILE)), true, '探测未完成不得判死');
});

/* —— 心跳原语 —— */

test('startHeartbeat：按间隔周期触发 tick；stop 后停止', async () => {
  let ticks = 0;
  const heartbeat = startHeartbeat({ intervalMs: 30, onTick: () => { ticks++; } });
  await waitFor(() => ticks >= 2, { timeoutMs: 2000 });
  heartbeat.stop();
  const settled = ticks;
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(ticks, settled, 'stop 后不得再触发');
});

/* —— 心跳所有权对证 —— */

function makeOwnedHeartbeat(home, mine) {
  const counters = { writes: 0, lost: 0 };
  const heartbeat = createOwnedHeartbeat({
    corePath: join(home, CORE_FILE),
    mine,
    write: () => {
      counters.writes++;
    },
    onLost: () => {
      counters.lost++;
    },
    log: null,
  });
  return { heartbeat, counters };
}

test('心跳所有权对证：仍持锁→照常写（多轮 tick）', async (t) => {
  const home = makeLifecycleHome(t);
  const mine = coreRecordOf();
  acquireCoreLock({ dataDir: home, record: mine });
  const { heartbeat, counters } = makeOwnedHeartbeat(home, mine);
  heartbeat.tick();
  heartbeat.tick();
  heartbeat.tick();
  assert.equal(counters.writes, 3, '正常窗口照常写');
  assert.equal(counters.lost, 0);
  assert.equal(heartbeat.lost(), false);
});

test('心跳所有权对证：锁被继任者重建→停写＋失锁即退（不覆写继任者描述符）', async (t) => {
  const home = makeLifecycleHome(t);
  const mine = coreRecordOf();
  const corePath = join(home, CORE_FILE);
  acquireCoreLock({ dataDir: home, record: mine });
  const { heartbeat, counters } = makeOwnedHeartbeat(home, mine);
  heartbeat.tick();
  assert.equal(counters.writes, 1);
  writeFileSync(corePath, JSON.stringify(coreRecordOf({ token: 'b2'.repeat(32) })) + '\n');
  heartbeat.tick();
  assert.equal(counters.writes, 1, '失锁后不得再写（不覆写继任者描述符）');
  assert.equal(counters.lost, 1, '失锁即退通道恰触发一次');
  heartbeat.tick();
  assert.equal(counters.lost, 1, '失锁后不再重复触发');
  assert.equal(readCoreRecord(corePath).record.token, 'b2'.repeat(32), '继任者描述符未被触碰');
});

test('心跳所有权对证：锁缺失（外部清理）＝失锁同判（保守让位）', async (t) => {
  const home = makeLifecycleHome(t);
  const mine = coreRecordOf();
  acquireCoreLock({ dataDir: home, record: mine });
  const { heartbeat, counters } = makeOwnedHeartbeat(home, mine);
  rmSync(join(home, CORE_FILE), { force: true });
  heartbeat.tick();
  assert.equal(counters.writes, 0, '锁不可证时不得写（不得无锁重建运行描述符）');
  assert.equal(counters.lost, 1);
});

/* —— 宽限管理 —— */

test('宽限电平补充：桥数 0 立即起计时→到期回调恰一次；cancel 幂等', async () => {
  let expired = 0;
  const grace = createGraceWindow({ graceMs: 80, persistent: false, onExpire: () => { expired++; }, log: null });
  grace.noteBridgeCount(0);
  assert.equal(grace.pending(), true);
  await waitFor(() => expired === 1, { timeoutMs: 2000 });
  assert.equal(grace.pending(), false);
  grace.cancel();
  grace.cancel();
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(expired, 1, '到期恰一次、cancel 幂等');
});

test('宽限：新桥到达清零；再归零重新计时', async () => {
  let expired = 0;
  const grace = createGraceWindow({ graceMs: 150, persistent: false, onExpire: () => { expired++; }, log: null });
  grace.noteBridgeCount(0);
  await new Promise((resolve) => setTimeout(resolve, 60));
  grace.noteBridgeCount(1);
  assert.equal(grace.pending(), false);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(expired, 0, '宽限内新桥到达清零后不得到期');
  grace.noteBridgeCount(0);
  await waitFor(() => expired === 1, { timeoutMs: 2000 });
});

test('宽限：常驻模式不因末桥退场起计时', async () => {
  let expired = 0;
  const grace = createGraceWindow({ graceMs: 60, persistent: true, onExpire: () => { expired++; }, log: null });
  grace.noteBridgeCount(1);
  grace.noteBridgeCount(0);
  assert.equal(grace.pending(), false);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(expired, 0);
});

/* —— 桥注册表 —— */

function fakeBridgeRecord(bridgeId, sessionId, closed) {
  return {
    connId: bridgeId,
    bridgeId,
    sessionId,
    close: () => closed.push(bridgeId),
  };
}

test('桥注册表：注册/移除/计数与列表；remove 幂等', () => {
  const counts = [];
  const registry = createBridgeRegistry({ onCountChange: (count) => counts.push(count), log: null });
  const first = fakeBridgeRecord('bridge-1', 'session-a', []);
  const second = fakeBridgeRecord('bridge-2', 'session-b', []);
  registry.register(first);
  registry.register(second);
  assert.equal(registry.count(), 2);
  assert.deepEqual(registry.list().map((entry) => entry.bridgeId), ['bridge-1', 'bridge-2']);
  registry.remove(first);
  registry.remove(first);
  assert.equal(registry.count(), 1, 'remove 幂等');
  assert.deepEqual(counts, [1, 2, 1]);
});

test('桥注册表：同 sessionId 新桥顶替旧桥（断开旧连接、删旧注册；计数不抖动）', () => {
  const counts = [];
  const closed = [];
  const superseded = [];
  const registry = createBridgeRegistry({
    onCountChange: (count) => counts.push(count),
    onSupersede: (entry) => superseded.push(entry.bridgeId),
    log: null,
  });
  const old = fakeBridgeRecord('bridge-old', 'session-a', closed);
  registry.register(old);
  const fresh = fakeBridgeRecord('bridge-new', 'session-a', closed);
  registry.register(fresh);
  assert.equal(registry.count(), 1, '顶替为净替换：计数不得出现 0');
  assert.deepEqual(closed, ['bridge-old'], '旧连接必须被断开');
  assert.deepEqual(superseded, ['bridge-old']);
  assert.deepEqual(counts, [1, 1], '顶替只有一次计数通知（不先减后加）');
  assert.equal(registry.find('session-a').bridgeId, 'bridge-new');
  const anon = fakeBridgeRecord('bridge-anon', null, closed);
  registry.register(anon);
  assert.equal(registry.count(), 2, '无 sessionId 的桥不参与顶替');
});

/* 会话视图（ws_list_hosts 本机段的数据源）：会话集＝带会话标识的注册桥，按注册序；
 * 客户端字段只取注册记录里现成的（缺失如实为空值），无标识的桥不构成可指名的终端。 */
function fakeClientRecord(bridgeId, sessionId, client = {}) {
  return {
    connId: bridgeId,
    bridgeId,
    sessionId,
    app: '0.1.0',
    platform: 'win32',
    pid: 4242,
    close: () => {},
    ...client,
  };
}

test('桥注册表·会话视图：形态与零桥边界（空集合）；随注册/退场/顶替实时变化', () => {
  const registry = createBridgeRegistry({ log: null });
  assert.deepEqual(registry.sessions(), [], '零桥：空集合（计数由调用方从集合长度得出）');
  const first = fakeClientRecord('bridge-1', 'session-a');
  registry.register(first);
  assert.deepEqual(registry.sessions(), [{ sessionId: 'session-a', bridgeId: 'bridge-1', app: '0.1.0', platform: 'win32', pid: 4242 }]);
  const second = fakeClientRecord('bridge-2', 'session-b', { app: undefined, platform: undefined, pid: undefined });
  registry.register(second);
  assert.deepEqual(
    registry.sessions()[1],
    { sessionId: 'session-b', bridgeId: 'bridge-2', app: null, platform: null, pid: null },
    '客户端字段缺失时如实为空值（不伪造、不省略字段）',
  );
  registry.register(fakeClientRecord('bridge-anon', null));
  assert.equal(registry.sessions().length, 2, '无会话标识的桥不入会话集（口径同会话状态写面：不进任何会话文件）');
  registry.register(fakeClientRecord('bridge-1b', 'session-a'));
  assert.deepEqual(registry.sessions().map((entry) => entry.bridgeId), ['bridge-2', 'bridge-1b'], '同会话顶替：视图只留当前桥');
  registry.remove(second);
  assert.deepEqual(registry.sessions().map((entry) => entry.sessionId), ['session-a'], '桥退场：会话实时移出');
});

/* —— persistentCore 读取 —— */

test('persistentCore：缺省 false 静默；显式 true/false；非法值 warn 一次并回落 false', async (t) => {
  const home = makeLifecycleHome(t);
  const warns = [];
  const warn = (message) => warns.push(message);
  assert.equal(readPersistentCore({ dataDir: home, warn }), false, '无配置文件按缺省 false 静默');
  writeFileSync(join(home, 'config.json'), JSON.stringify({ persistentCore: true }));
  assert.equal(readPersistentCore({ dataDir: home, warn }), true);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ persistentCore: false }));
  assert.equal(readPersistentCore({ dataDir: home, warn }), false);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ persistentCore: 'yes' }));
  assert.equal(readPersistentCore({ dataDir: home, warn }), false);
  assert.equal(warns.length, 1, '非法值恰告警一次');
  writeFileSync(join(home, 'config.json'), '{ broken');
  assert.equal(readPersistentCore({ dataDir: home, warn }), false);
  assert.equal(warns.length, 2, '不可读同样告警（不静默）');
});

/* —— waiting 维持与迁出重验 —— */

test('waiting 寿命上界：注入短值到期回调；stop 后取消', async () => {
  let expired = 0;
  const lifetime = createWaitingLifetime({ maxMs: 60, onExpire: () => { expired++; }, log: null });
  lifetime.start();
  await waitFor(() => expired === 1, { timeoutMs: 2000 });
  const stopped = createWaitingLifetime({ maxMs: 60, onExpire: () => { expired++; }, log: null });
  stopped.start();
  stopped.stop();
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(expired, 1, 'stop 后不得到期');
});

test('waiting 迁出前重验锁：pid/startedAt 被顶替→失锁即退判据成立', () => {
  const mine = coreRecordOf({ status: 'waiting' });
  assert.equal(sameProcessRecord(mine, { ...mine }), true, '仍是自己的锁：可迁出');
  assert.equal(sameProcessRecord(mine, { ...mine, startedAt: new Date(Date.now() + 5000).toISOString() }), false, '被顶替：退');
  assert.equal(sameProcessRecord(mine, { ...mine, pid: mine.pid + 1 }), false);
});

/* —— 端点反证（真 IPC 往返） —— */

async function startFakeCore(home, token) {
  const server = createIpcServer({
    dataDir: home,
    token,
    welcomeOf: ({ bridges }) => ({
      type: 'welcome',
      ok: true,
      v: IPC_VERSION,
      app: '0.1.0',
      corePid: process.pid,
      dataDir: home,
      identity: { instanceId: 'fake-core-instance', identityName: 'fake-core' },
      port: 19000,
      net: { available: false, degraded: true },
      persistent: false,
      bridges,
    }),
    log: null,
  });
  await server.start();
  return server;
}

test('probeEndpoint：真 IPC 往返可连＝reachable；服务关闭＝unreachable；错 token 仍证明对端活着', async (t) => {
  const home = makeLifecycleHome(t);
  const server = await startFakeCore(home, TOKEN);
  assert.equal(await probeEndpoint({ dataDir: home, token: TOKEN, appVersion: '0.1.0', timeoutMs: 3000, log: null }), 'reachable');
  assert.equal(await probeEndpoint({ dataDir: home, token: 'ff'.repeat(32), appVersion: '0.1.0', timeoutMs: 3000, log: null }), 'reachable', '认证被拒也说明核心在服务');
  await server.close();
  assert.equal(await probeEndpoint({ dataDir: home, token: TOKEN, appVersion: '0.1.0', timeoutMs: 1500, log: null }), 'unreachable');
});

test('createEndpointProbe：探测异常按不可用处理（不得被判死依据）', async () => {
  const probe = createEndpointProbe({ dataDir: join(tmpdir(), 'waystation-probe-void'), appVersion: '0.1.0', timeoutMs: 500, log: null });
  assert.equal(await probe({ token: TOKEN }), 'unreachable', '端点不存在：连接期即拒绝');
  assert.equal(await probe({ token: undefined }), 'unavailable', '形态不合（无 token）：按探测未完成处理');
});

/* —— 进程级：接线后的端到端形态 —— */

function spawnCore(t, home, extraEnv = {}) {
  const cleanup = cleanupOf(t);
  const child = spawn(process.execPath, [CORE_ENTRY], {
    cwd: repoRoot,
    env: { ...process.env, NODE_TEST_CONTEXT: 'core-lifecycle-test', WAYSTATION_HOME: home, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  cleanup.children.push(child);
  allChildren.push(child);
  const streams = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk) => { streams.stdout += chunk; });
  child.stderr.on('data', (chunk) => { streams.stderr += chunk; });
  return { child, streams };
}

function writeCoreConfig(home, extra = {}) {
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({ scanWindowMs: 300, dialTimeoutMs: 1500, probeTimeoutMs: 300, viewerAutoOpen: false, ...extra }),
  );
}

function readCoreJson(home) {
  return JSON.parse(readFileSync(join(home, CORE_FILE), 'utf8'));
}

async function waitCoreReady(home, timeoutMs = 20000) {
  return waitFor(() => {
    try {
      const record = readCoreJson(home);
      return record.status === 'ready' ? record : false;
    } catch {
      return false;
    }
  }, { timeoutMs });
}

function waitExit(child, timeoutMs = 20000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

test('取锁启动窗口：并发第二/第三核心等待、不删锁重建；首核就绪后让位退出 0', { timeout: 60000 }, async (t) => {
  const home = makeLifecycleHome(t);
  writeCoreConfig(home, { port: await pickFreePort() });
  const followerEnv = {
    WAYSTATION_TEST_HEARTBEAT_MS: '200',
    WAYSTATION_TEST_ARBITRATION_POLL_MS: '150',
    WAYSTATION_TEST_JUDGE_THRESHOLD_MS: '1000',
  };
  const first = spawnCore(t, home, { WAYSTATION_TEST_STARTUP_DELAY_MS: '5000', WAYSTATION_TEST_HEARTBEAT_MS: '200' });
  await waitFor(() => existsSync(join(home, CORE_FILE)), { timeoutMs: 10000 });
  const before = readCoreJson(home);
  assert.equal(before.status, 'starting', '拉长启动制造「pid 活、端点未监听」窗口');
  const second = spawnCore(t, home, followerEnv);
  const third = spawnCore(t, home, followerEnv);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  assert.equal(second.child.exitCode, null, '启动窗口内第二核心应等待而非退出/清理');
  assert.equal(third.child.exitCode, null, '启动窗口内第三核心同样等待');
  const during = readCoreJson(home);
  assert.equal(during.token, before.token, '等待期锁不得被触碰（红证：把端点不可连判为陈旧的实现会删锁重建）');
  assert.equal(during.startedAt, before.startedAt);
  assert.ok(Date.parse(during.heartbeatAt) > Date.parse(before.heartbeatAt), 'starting 期心跳照刷（等待接管态同此机制）');
  await waitCoreReady(home);
  const exitedSecond = await waitExit(second.child, 20000);
  const exitedThird = await waitExit(third.child, 20000);
  assert.notEqual(exitedSecond, null, '首核就绪后第二核心应判定让位');
  assert.notEqual(exitedThird, null, '首核就绪后第三核心应判定让位');
  assert.equal(exitedSecond.code, 0, '已有核心在服务：让位退出 0');
  assert.equal(exitedThird.code, 0);
  assert.ok(second.streams.stderr.includes('不清理'), `stderr 应说明不抢占：${second.streams.stderr}`);
  assert.equal(first.child.exitCode, null, '终态恰一核心存活');
  assert.equal(readCoreJson(home).token, before.token, '存活核心的锁未被触碰');
});

test('陈旧锁进程级：pid 死→原子清理后接管启动（stale 副本留证）', { timeout: 30000 }, async (t) => {
  const home = makeLifecycleHome(t);
  writeCoreConfig(home, { port: await pickFreePort() });
  const dead = writeCoreJson(home, { pid: 2 ** 30, status: 'starting' });
  assert.equal(existsSync(dead), true);
  const { child } = spawnCore(t, home, { WAYSTATION_TEST_HEARTBEAT_MS: '200' });
  const record = await waitCoreReady(home);
  assert.equal(record.pid, child.pid, '清理陈旧锁后本进程接管');
  const staleFiles = readdirSync(join(home, 'run')).filter((name) => name.startsWith('core.json.stale-'));
  assert.equal(staleFiles.length, 1, '陈旧锁以 stale 副本留证');
});

test('occupied 进程级：锁在（pid 活）但端点不可连→保守退出 1、不清理不抢占', { timeout: 30000 }, async (t) => {
  const home = makeLifecycleHome(t);
  writeCoreConfig(home, { port: await pickFreePort() });
  writeCoreJson(home, { pid: process.pid, status: 'ready', heartbeatAt: new Date().toISOString() });
  const run = spawnSync(process.execPath, [CORE_ENTRY], {
    cwd: repoRoot,
    env: { ...process.env, NODE_TEST_CONTEXT: 'core-lifecycle-test', WAYSTATION_HOME: home },
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(run.status, 1, '无法确认既有核心可服务：拒绝服务');
  assert.ok(run.stderr.includes('不清理'), `stderr 应说明不抢占：${run.stderr}`);
  assert.equal(readCoreJson(home).token, TOKEN, '锁不得被触碰');
});

test('取锁阶段数据根不可用：run/ 被文件占→直接拒绝（不读不判不清理）', { timeout: 30000 }, async (t) => {
  const home = makeLifecycleHome(t);
  writeCoreConfig(home, { port: await pickFreePort() });
  writeFileSync(join(home, 'run'), 'not a directory\n');
  const result = await startCore({ env: { ...process.env, WAYSTATION_HOME: home } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'data-dir-unwritable');
  assert.equal(result.exitCode, 1);
  assert.equal(existsSync(join(home, CORE_FILE)), false, '拒绝路径不落盘运行描述符');
});

test('取锁阶段陈旧锁清理后接管（进程内）：pid 死→隔离留证→本进程成为核心', { timeout: 30000 }, async (t) => {
  const home = makeLifecycleHome(t);
  writeCoreConfig(home, { port: await pickFreePort() });
  writeCoreJson(home, { pid: 2 ** 30, status: 'starting' });
  const result = await startCore({ env: { ...process.env, WAYSTATION_HOME: home } });
  assert.equal(result.ok, true, '判陈旧清理后本进程应取锁成功');
  cleanupOf(t).stops.push(() => result.core.stop());
  const record = readCoreJson(home);
  assert.equal(record.pid, process.pid, '锁已由本进程重建');
  assert.equal(record.status, 'ready');
  assert.equal(readdirSync(join(home, 'run')).filter((name) => name.startsWith('core.json.stale-')).length, 1, '陈旧锁以 stale 副本留证');
});

test('心跳失锁即退（进程内）：锁被继任者重建→核心有序退出 0、不覆写不误删继任者锁', { timeout: 30000 }, async (t) => {
  const home = makeLifecycleHome(t);
  writeCoreConfig(home, { port: await pickFreePort() });
  const result = await startCore({
    env: { ...process.env, WAYSTATION_HOME: home, WAYSTATION_TEST_HEARTBEAT_MS: '200' },
  });
  assert.equal(result.ok, true);
  cleanupOf(t).stops.push(() => result.core.stop());
  await waitCoreReady(home);
  const corePath = join(home, CORE_FILE);
  const successor = { ...readCoreJson(home), token: 'c3'.repeat(32), startedAt: new Date(Date.now() + 5000).toISOString() };
  writeFileSync(corePath, JSON.stringify(successor, null, 2) + '\n');
  const exited = await Promise.race([
    result.core.whenExited(),
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 8000);
      timer.unref?.();
    }),
  ]);
  assert.equal(exited, 0, `失锁即退应有序退出 0：${exited}`);
  const finalRecord = readCoreJson(home);
  assert.equal(finalRecord.token, 'c3'.repeat(32), '继任者锁未被覆写');
  assert.equal(finalRecord.startedAt, successor.startedAt, '继任者锁未被删除/改写');
});

test('宽限进程级：无桥→宽限到期有序退出 0 并删锁；宽限内新桥到达不退出', { timeout: 60000 }, async (t) => {
  const home = makeLifecycleHome(t);
  const port = await pickFreePort();
  writeCoreConfig(home, { port });
  const { child } = spawnCore(t, home, { WAYSTATION_TEST_GRACE_MS: '1200', WAYSTATION_TEST_HEARTBEAT_MS: '200' });
  const record = await waitCoreReady(home);
  const client = createIpcClient({
    dataDir: home,
    hello: { app: '0.1.0', token: record.token, bridgeId: 'bridge-grace-hold' },
    log: null,
  });
  await client.connect();
  await new Promise((resolve) => setTimeout(resolve, 2400));
  assert.equal(child.exitCode, null, '宽限内注册的桥使计时清零：不得退出');
  await client.close();
  const exited = await waitExit(child, 20000);
  assert.notEqual(exited, null, '末桥退场后宽限到期应退出');
  assert.equal(exited.code, 0, '有序收尾退出码 0');
  assert.equal(existsSync(join(home, CORE_FILE)), false, '有序收尾删除运行描述符');
  await waitForRebindable(record.port);
});

test('常驻进程级：persistentCore=true→末桥退场后不退出（显式停止收尾）', { timeout: 60000 }, async (t) => {
  const home = makeLifecycleHome(t);
  writeCoreConfig(home, { port: await pickFreePort(), persistentCore: true });
  const { child } = spawnCore(t, home, { WAYSTATION_TEST_GRACE_MS: '300', WAYSTATION_TEST_HEARTBEAT_MS: '200' });
  await waitCoreReady(home);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(child.exitCode, null, '常驻模式不因末桥退场（含从未有桥）退出');
  const record = readCoreJson(home);
  assert.equal(record.status, 'ready');
  await killChild(child);
});
