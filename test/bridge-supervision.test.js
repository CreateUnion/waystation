import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { makeTempDir, pickFreePort, waitFor } from './helpers.js';
import { IPC_VERSION, createIpcClient, createIpcServer, endpointFor } from '../src/core/ipc.js';
import { startCore } from '../src/core/main.js';
import { coreJsonPath, runDir } from '../src/paths.js';
import { killGuarded, probeEndpointPresence } from '../src/core/stop-guard.js';
import { createCoreLink } from '../src/bridge/ipc-client.js';
import { createBridgeRuntime } from '../src/bridge/main.js';

/* 桥监督判别测试（设计 §2.6 硬杀防护链／§3.3 崩溃矩阵）：stop-guard 五分支与 pid 复用防护、
 * 崩溃→重生→重注册链（快速重试上界→慢速转换）、僵尸核硬杀冷启、降级上报、桥运行时接线、
 * 核心侧桥断开清理（注册删除＋两触发挂点）。全部临时根（makeTempDir），不触碰真实
 * ~/.waystation、不占站点端口段——IPC 端点走管道/套接字文件，核心 LAN 端口取临时空闲端口。 */

const TOKEN = 'supervision-test-token-0123456789ab';
const CALL_TIMEOUT_SMALL = 150;

function quietLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function staleIso(ageMs = 60000) {
  return new Date(Date.now() - ageMs).toISOString();
}

function freshIso() {
  return new Date().toISOString();
}

/* core.json 夹具（身份置 null＝锁创建时的真形态）。 */
function recordOf(home, overrides = {}) {
  return {
    v: 1,
    ipcV: IPC_VERSION,
    appVersion: '0.1.0',
    pid: process.pid,
    endpoint: endpointFor(home),
    token: TOKEN,
    identity: null,
    port: 7500,
    startedAt: freshIso(),
    status: 'ready',
    startupDeadline: new Date(Date.now() + 15000).toISOString(),
    heartbeatAt: freshIso(),
    ...overrides,
  };
}

function writeRecordFile(home, overrides = {}) {
  mkdirSync(runDir(home), { recursive: true });
  writeFileSync(coreJsonPath(home), JSON.stringify(recordOf(home, overrides), null, 2) + '\n');
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/* 保活假进程：只占 pid（记录里指认的「核心进程」），不监听任何端点。 */
function spawnIdleChild(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' });
  t.after(() => {
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch {
      // 已退出
    }
  });
  return child;
}

/* 僵尸核假进程：监听端点（内核侧照收连接）但不对 hello 应答——「进程活、事件循环卡死」的形态。 */
function spawnZombieListener(t, endpoint) {
  const code = 'import net from "node:net";'
    + ' const server = net.createServer(() => {});'
    + ' server.listen(process.env.WS_T7_ENDPOINT);'
    + ' setInterval(() => {}, 60000);';
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, WS_T7_ENDPOINT: endpoint },
    stdio: 'ignore',
  });
  t.after(() => {
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch {
      // 已退出
    }
  });
  return child;
}

async function waitEndpointOpen(endpoint) {
  await waitFor(async () => (await probeEndpointPresence(endpoint, 200)) === 'open', { timeoutMs: 5000 });
}

/* —— 桩核心（IPC 层真实服务端）与冷启模拟器 —— */

function welcomeFixture(home) {
  return ({ bridges }) => ({
    type: 'welcome',
    ok: true,
    v: IPC_VERSION,
    app: '0.1.0',
    corePid: process.pid,
    dataDir: home,
    identity: { instanceId: 'inst-supervision', identityName: 'lfxue' },
    port: 7500,
    net: { available: true, degraded: false },
    persistent: false,
    bridges,
  });
}

async function startStubCore(t, home, { onFrame = null, onClose = null } = {}) {
  const server = createIpcServer({
    dataDir: home,
    token: TOKEN,
    welcomeOf: welcomeFixture(home),
    log: quietLog(),
    onFrame: onFrame ?? (() => {}),
    onClose: onClose ?? (() => {}),
  });
  t.after(() => server.close());
  await server.start();
  return server;
}

function spawnRecorder() {
  const calls = [];
  const spawnFn = (command, args, options) => {
    const child = new EventEmitter();
    child.pid = 91000 + calls.length;
    child.unref = () => {};
    calls.push({ command, args, options });
    return child;
  };
  return { calls, spawnFn };
}

/* 冷启模拟器：spawn 被调用后延迟写 core.json 并起桩核心（模拟被冷启核心的落盘与监听效应）；
 * replyText 非空时，新起桩核心对 call 帧回该文本（重生后接续转发面的断言用）。 */
function coldStartSim(t, home, { delayMs = 10, recordOverrides = {}, replyText = null } = {}) {
  const recorder = spawnRecorder();
  /** @type {any} */
  let latest = null;
  const spawnFn = (command, args, options) => {
    const child = recorder.spawnFn(command, args, options);
    setTimeout(async () => {
      writeRecordFile(home, recordOverrides);
      latest = await startStubCore(t, home, {
        onFrame: replyText === null ? null : (frame, record) => {
          if (frame.type === 'call') {
            latest.send(record, { type: 'result', id: frame.id, content: [{ type: 'text', text: replyText }] });
          }
        },
      });
    }, delayMs);
    return child;
  };
  return { calls: recorder.calls, spawnFn, latestServer: () => latest };
}

function linkFor(home, spawnFn, overrides = {}) {
  return createCoreLink({
    dataDir: home,
    env: { WAYSTATION_HOME: home, CLAUDE_CODE_SESSION_ID: 'session-supervision-1' },
    app: '0.1.0',
    bridgeId: 'bridge-supervision',
    sessionId: 'session-supervision-1',
    log: quietLog(),
    spawn: spawnFn,
    waitMs: 3000,
    pollMs: 25,
    slowRetryMs: 200,
    callTimeoutMs: CALL_TIMEOUT_SMALL,
    ...overrides,
  });
}

/* —— stop-guard：五分支 —— */

test('stop-guard：killed（真信号＋端点确认消失）→ 同 pid 再调即 already-once（单次闸）', { timeout: 15000 }, async (t) => {
  const home = makeTempDir(t);
  const child = spawnIdleChild(t);
  const startedAt = '2026-10-15T09:00:00.000Z';
  writeRecordFile(home, { pid: child.pid, startedAt, heartbeatAt: staleIso() });
  const args = {
    coreJsonPath: coreJsonPath(home),
    endpoint: endpointFor(home),
    pid: child.pid,
    startedAt,
    probe: async () => (isAlive(child.pid) ? 'open' : 'gone'),
  };
  assert.equal(await killGuarded(args), 'killed');
  await waitFor(() => !isAlive(child.pid), { timeoutMs: 3000 });
  assert.equal(await killGuarded(args), 'already-once', '本进程已对同 pid 杀过一次（不重复杀）');
});

test('stop-guard：进程已不在且端点消失 → endpoint-gone；描述符缺失两侧口径', { timeout: 15000 }, async (t) => {
  const home = makeTempDir(t);
  const dead = spawnSync(process.execPath, ['-e', '']);
  const startedAt = '2026-10-15T09:00:00.000Z';
  writeRecordFile(home, { pid: dead.pid, startedAt, heartbeatAt: staleIso() });
  const kills = [];
  const base = { coreJsonPath: coreJsonPath(home), endpoint: endpointFor(home), pid: dead.pid, startedAt, kill: (pid) => kills.push(pid) };
  assert.equal(await killGuarded({ ...base, probe: async () => 'gone' }), 'endpoint-gone');
  assert.equal(await killGuarded({ ...base, probe: async () => 'open' }), 'verification-failed', '进程已不在而端点仍在＝归属不可证');
  const missing = { coreJsonPath: coreJsonPath(makeTempDir(t)), endpoint: endpointFor(home), pid: 999001, startedAt, kill: (pid) => kills.push(pid) };
  assert.equal(await killGuarded({ ...missing, probe: async () => 'gone' }), 'endpoint-gone', '无锁可对证但端点已消失');
  assert.equal(await killGuarded({ ...missing, probe: async () => 'open' }), 'verification-failed', '无锁可对证而端点仍在');
  assert.equal(kills.length, 0, '不杀路径一律未发信号');
});

test('stop-guard：pid 复用防护——复读对证不过 → verification-failed、不杀（无关进程存活）', { timeout: 15000 }, async (t) => {
  const home = makeTempDir(t);
  const child = spawnIdleChild(t);
  writeRecordFile(home, { pid: child.pid, startedAt: '2026-10-15T00:00:00.000Z', heartbeatAt: staleIso() });
  const kills = [];
  let probed = false;
  const result = await killGuarded({
    coreJsonPath: coreJsonPath(home),
    endpoint: endpointFor(home),
    pid: child.pid,
    startedAt: '2026-10-15T09:00:00.000Z',
    probe: async () => {
      probed = true;
      return 'gone';
    },
    kill: (pid) => kills.push(pid),
  });
  assert.equal(result, 'verification-failed', '描述符内容与判定时不一致（pid 复用形态）');
  assert.equal(kills.length, 0, '不杀');
  assert.equal(probed, false, '先对证后动作：校验不过连探测都不做');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(isAlive(child.pid), true, '无关进程未被误杀');
});

test('stop-guard：判别器——自动落链心跳新鲜 → not-eligible；显式授权放行但慢启动窗口不越', { timeout: 15000 }, async (t) => {
  const home = makeTempDir(t);
  const child = spawnIdleChild(t);
  const startedAt = '2026-10-15T09:00:00.000Z';
  const probes = [];
  const kills = [];
  const seams = { probe: async (target) => (probes.push(target), 'gone'), kill: (pid, signal) => kills.push({ pid, signal }) };
  writeRecordFile(home, { pid: child.pid, startedAt, heartbeatAt: freshIso() });
  const base = { coreJsonPath: coreJsonPath(home), endpoint: endpointFor(home), pid: child.pid, startedAt, ...seams };
  assert.equal(await killGuarded(base), 'not-eligible', '自动落链须自有证据（心跳未停）');
  assert.equal(await killGuarded({ ...base, allowOnce: true }), 'killed', '显式授权不必再等心跳超期');
  assert.deepEqual(kills, [{ pid: child.pid, signal: 'SIGKILL' }]);
  assert.equal(probes.length, 1, 'not-eligible 不做端点核实');
  const child2 = spawnIdleChild(t);
  writeRecordFile(home, { status: 'starting', pid: child2.pid, startedAt, heartbeatAt: freshIso(), startupDeadline: new Date(Date.now() + 60000).toISOString() });
  const starting = await killGuarded({ ...base, pid: child2.pid, allowOnce: true });
  assert.equal(starting, 'not-eligible', '慢启动窗口（心跳新鲜且截止期未过）显式授权亦不越');
  assert.equal(kills.length, 1);
});

test('stop-guard：判别器第三相——IPC 版本拒绝实证（换代场景）放行；慢启动窗口仍不越', { timeout: 15000 }, async (t) => {
  const home = makeTempDir(t);
  const fake = spawnIdleChild(t);
  const startedAt = '2026-10-15T09:00:00.000Z';
  const kills = [];
  writeRecordFile(home, { pid: fake.pid, startedAt, heartbeatAt: freshIso() });
  const base = {
    coreJsonPath: coreJsonPath(home),
    endpoint: endpointFor(home),
    pid: fake.pid,
    startedAt,
    probe: async () => 'gone',
    kill: (pid, signal) => kills.push({ pid, signal }),
  };
  assert.equal(await killGuarded(base), 'not-eligible', '无证据无授权：心跳新鲜即拒绝');
  assert.equal(await killGuarded({ ...base, versionRejected: true }), 'killed', '版本拒绝实证放行（换代场景，信号与端点确认照走）');
  assert.deepEqual(kills, [{ pid: fake.pid, signal: 'SIGKILL' }]);
  const fake2 = spawnIdleChild(t);
  writeRecordFile(home, { status: 'starting', pid: fake2.pid, startedAt, heartbeatAt: freshIso(), startupDeadline: new Date(Date.now() + 60000).toISOString() });
  assert.equal(await killGuarded({ ...base, pid: fake2.pid, versionRejected: true }), 'not-eligible', '慢启动窗口不越（实证亦不越）');
  assert.equal(kills.length, 1);
  assert.equal(isAlive(fake.pid), true, '全程未真实杀进程（桩构造）');
});

test('stop-guard：杀后端点未消失 → verification-failed（确认不过不冷启；信号不发第二遍）', { timeout: 15000 }, async (t) => {
  const home = makeTempDir(t);
  const child = spawnIdleChild(t);
  const startedAt = '2026-10-15T09:00:00.000Z';
  writeRecordFile(home, { pid: child.pid, startedAt, heartbeatAt: staleIso() });
  const kills = [];
  const args = {
    coreJsonPath: coreJsonPath(home),
    endpoint: endpointFor(home),
    pid: child.pid,
    startedAt,
    probe: async () => 'open',
    kill: (pid, signal) => kills.push({ pid, signal }),
    confirmMs: 60,
    confirmPollMs: 10,
  };
  assert.equal(await killGuarded(args), 'verification-failed');
  assert.equal(kills.length, 1, '信号恰发一次');
  assert.equal(await killGuarded(args), 'already-once', '确认失败也算已记录（不连环杀）');
});

test('stop-guard：边界与防御分支——入参校验、不可解析描述符、信号失败、探测异常', { timeout: 15000 }, async (t) => {
  const home = makeTempDir(t);
  const base = { coreJsonPath: coreJsonPath(home), endpoint: endpointFor(home), pid: 999501, startedAt: 'T-judged' };
  await assert.rejects(() => killGuarded(null), /缺少入参/);
  await assert.rejects(() => killGuarded({ ...base, coreJsonPath: '' }), /coreJsonPath/);
  await assert.rejects(() => killGuarded({ ...base, endpoint: '' }), /endpoint/);
  await assert.rejects(() => killGuarded({ ...base, startedAt: '' }), /startedAt/);
  await assert.rejects(() => killGuarded({ ...base, pid: 0 }), /合法 pid/);
  mkdirSync(runDir(home), { recursive: true });
  writeFileSync(coreJsonPath(home), '{ not json');
  assert.equal(await killGuarded(base), 'verification-failed', '描述符不可解析＝对证无法成立');
  assert.equal(await killGuarded({ ...base, coreJsonPath: coreJsonPath(makeTempDir(t)), probe: async () => { throw new Error('探测异常'); } }), 'verification-failed', '探测未完成按「仍在」保守处置');
  assert.equal(await probeEndpointPresence('', 50), 'open', '端点形态不可连（连接构造抛错）同样按「仍在」');
  const child = spawnIdleChild(t);
  writeRecordFile(home, { pid: child.pid, startedAt: 'T-judged', heartbeatAt: staleIso() });
  const killE = (code) => () => {
    throw Object.assign(new Error(code), { code });
  };
  assert.equal(await killGuarded({ ...base, pid: child.pid, probe: async () => 'gone', kill: killE('ESRCH') }), 'endpoint-gone', '信号时进程已不在');
  assert.equal(await killGuarded({ ...base, pid: child.pid, probe: async () => 'gone', kill: killE('EPERM') }), 'verification-failed', '信号发不出＝不杀');
  assert.equal(isAlive(child.pid), true);
});

/* —— 桥监督：崩溃→重生→重注册（快速上界→慢速转换） —— */

test('监督：核心崩（pid 死＋连接断开）→ 桥判陈旧冷启 → 重注册（reborn 外送）', { timeout: 20000 }, async (t) => {
  const home = makeTempDir(t);
  writeRecordFile(home);
  const server = await startStubCore(t, home);
  const sim = coldStartSim(t, home, { replyText: '重生后应答' });
  const registered = [];
  const link = linkFor(home, sim.spawnFn, { onRegistered: (_welcome, meta) => registered.push(meta) });
  t.after(() => link.close());
  assert.equal((await link.ensureCore()).ok, true);
  const dead = spawnSync(process.execPath, ['-e', '']);
  writeRecordFile(home, { pid: dead.pid, status: 'ready' });
  await server.close();
  await waitFor(() => link.state.registered === false, { timeoutMs: 3000 });
  await waitFor(() => link.state.registered, { timeoutMs: 8000 });
  assert.equal(link.state.registered, true, '重生流自动恢复注册');
  assert.equal(sim.calls.length, 1, '恰恰冷启一次');
  assert.deepEqual(registered.map((meta) => meta.reborn), [false, true], '第二次注册标注为重生后重注册');
  assert.ok(link.state.rapidRetries >= 1, '重生走快速重试');
  const called = await link.call('ws_ping', {});
  assert.deepEqual(called, { ok: true, result: { content: [{ type: 'text', text: '重生后应答' }] } }, '重生后转发照常');
});

test('监督：快速重试上界 3 次/10 分钟——第 4 次断连转慢速；窗口滑过再断连恢复快速', { timeout: 20000 }, async (t) => {
  const home = makeTempDir(t);
  let offset = 0;
  const now = () => Date.now() + offset;
  writeRecordFile(home, { heartbeatAt: new Date(now()).toISOString() });
  const server = await startStubCore(t, home);
  const link = linkFor(home, spawnRecorder().spawnFn, { fastRetryMs: 30, slowRetryMs: 700, now });
  t.after(() => link.close());
  assert.equal((await link.ensureCore()).ok, true);
  for (let round = 1; round <= 3; round++) {
    server.listBridges()[0].close();
    await waitFor(() => link.state.registered === false);
    await waitFor(() => link.state.registered === true, { timeoutMs: 3000 });
    assert.equal(link.state.rapidRetries, round, `第 ${round} 次重走快速重试`);
  }
  server.listBridges()[0].close();
  await waitFor(() => link.state.registered === false);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(link.state.registered, false, '第 4 次断连转慢速（慢速间隔 700ms 未到）');
  assert.equal(link.state.rapidRetries, 3, '上界已用尽、不再计数');
  offset += 11 * 60 * 1000;
  writeRecordFile(home, { heartbeatAt: new Date(now()).toISOString() });
  await waitFor(() => link.state.registered === true, { timeoutMs: 3000 });
  server.listBridges()[0].close();
  await waitFor(() => link.state.registered === false);
  await waitFor(() => link.state.registered === true, { timeoutMs: 3000 });
  assert.equal(link.state.rapidRetries, 1, '窗口滑过（>10 分钟）后重新给快速额度');
});

/* —— 桥监督：僵尸核硬杀冷启 / 判别器不通过不杀 / 降级上报 —— */

test('监督：僵尸核（进程活、端点应连不应答、心跳停）→ 硬杀防护链 → 冷启 → 注册', { timeout: 20000 }, async (t) => {
  const home = makeTempDir(t);
  const zombie = spawnZombieListener(t, endpointFor(home));
  await waitEndpointOpen(endpointFor(home));
  writeRecordFile(home, { pid: zombie.pid, startedAt: '2026-10-15T09:00:00.000Z', heartbeatAt: staleIso() });
  const sim = coldStartSim(t, home);
  const link = linkFor(home, sim.spawnFn, { handshakeTimeoutMs: 150, waitMs: 5000 });
  t.after(() => link.close());
  const outcome = await link.ensureCore();
  assert.equal(outcome.ok, true, '硬杀后冷启的新核接管');
  await waitFor(() => !isAlive(zombie.pid), { timeoutMs: 3000 });
  assert.equal(sim.calls.length, 1);
});

test('监督：判别器不通过不杀（心跳新鲜：ready 不应答与 starting 窗口都不杀不冷启）', { timeout: 20000 }, async (t) => {
  const home = makeTempDir(t);
  const fake = spawnIdleChild(t);
  const kills = [];
  const silent = net.createServer((socket) => {
    socket.on('error', () => {});
  });
  await new Promise((resolve) => {
    silent.listen(endpointFor(home), resolve);
  });
  t.after(() => silent.close());
  writeRecordFile(home, { pid: fake.pid, heartbeatAt: freshIso() });
  const link = linkFor(home, spawnRecorder().spawnFn, {
    waitMs: 500,
    handshakeTimeoutMs: 120,
    guardOptions: { kill: (pid, signal) => kills.push({ pid, signal }) },
  });
  t.after(() => link.close());
  const noAnswer = await link.ensureCore();
  assert.equal(noAnswer.ok, false, '核心活着但不应答＝按不可达收口（不杀、不冷启）');
  assert.equal(kills.length, 0);
  assert.equal(isAlive(fake.pid), true);
  writeRecordFile(home, { status: 'starting', pid: fake.pid, heartbeatAt: freshIso(), startupDeadline: new Date(Date.now() + 60000).toISOString() });
  const window = await link.ensureCore();
  assert.equal(window.ok, false);
  assert.equal(window.kind, 'starting', '等待窗口不冷启');
  assert.equal(kills.length, 0);
  assert.equal(isAlive(fake.pid), true);
});

test('监督：防护链入口异常 → 按链不可用降级上报（不杀、不冷启）', { timeout: 20000 }, async (t) => {
  const home = makeTempDir(t);
  const fake = spawnIdleChild(t);
  writeRecordFile(home, { pid: fake.pid, startedAt: '2026-10-15T09:00:00.000Z', heartbeatAt: staleIso() });
  const recorder = spawnRecorder();
  const link = linkFor(home, recorder.spawnFn, { slowRetryMs: 10000, guardOptions: { pid: -1 } });
  t.after(() => link.close());
  const degraded = await link.ensureCore();
  assert.equal(degraded.ok, false);
  assert.match(degraded.message, /防护链不可用/);
  assert.match(degraded.message, /已尝试重启核心/);
  assert.equal(recorder.calls.length, 0);
  assert.equal(isAlive(fake.pid), true);
});

test('监督：重生尝试失败也按快速重试节奏——额度用尽后转慢速', { timeout: 20000 }, async (t) => {
  const home = makeTempDir(t);
  writeRecordFile(home, { heartbeatAt: freshIso() });
  const server = await startStubCore(t, home);
  const link = linkFor(home, spawnRecorder().spawnFn, { fastRetryMs: 30, slowRetryMs: 10000, waitMs: 200, pollMs: 25 });
  t.after(() => link.close());
  assert.equal((await link.ensureCore()).ok, true);
  await server.close();
  await waitFor(() => link.state.registered === false);
  await waitFor(() => link.state.rapidRetries === 3, { timeoutMs: 8000 });
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(link.state.rapidRetries, 3, '额度用尽后不再计数（转慢速）');
  assert.equal(link.state.registered, false);
});

test('监督：已有在途重试时不重复计快速额度（去重口径一致）', { timeout: 20000 }, async (t) => {
  const home = makeTempDir(t);
  writeRecordFile(home, { heartbeatAt: freshIso() });
  const server = await startStubCore(t, home);
  const link = linkFor(home, spawnRecorder().spawnFn, { fastRetryMs: 5000, slowRetryMs: 10000, waitMs: 200, pollMs: 25 });
  t.after(() => link.close());
  assert.equal((await link.ensureCore()).ok, true);
  await server.close();
  await waitFor(() => link.state.registered === false);
  assert.equal(link.state.rapidRetries, 1);
  const failed = await link.call('ws_ping', {});
  assert.equal(failed.ok, false, '重生尝试失败按不可达收口');
  assert.equal(link.state.rapidRetries, 1, '在途重试计时器仍在：本次失败不再计额');
});

test('监督：硬杀链校验不过 → 降级上报（文案带「已尝试重启核心」）；重试走单次闸不重复杀', { timeout: 20000 }, async (t) => {
  const home = makeTempDir(t);
  const fake = spawnIdleChild(t);
  writeRecordFile(home, { pid: fake.pid, startedAt: '2026-10-15T09:00:00.000Z', heartbeatAt: staleIso() });
  const kills = [];
  const recorder = spawnRecorder();
  const link = linkFor(home, recorder.spawnFn, {
    slowRetryMs: 10000,
    guardOptions: { kill: (pid, signal) => kills.push({ pid, signal }), probe: async () => 'open' },
  });
  t.after(() => link.close());
  const degraded = await link.ensureCore();
  assert.equal(degraded.ok, false);
  assert.match(degraded.message, /已尝试重启核心/, '设计 §3.3 会话可见文案');
  assert.match(degraded.message, /硬杀防护链未通过/);
  const second = await link.ensureCore();
  assert.equal(second.ok, false);
  assert.match(second.message, /不重复杀/);
  assert.equal(kills.length, 1, '信号恰发一次（单次闸跨轮次生效）');
  assert.equal(recorder.calls.length, 0, '校验不过不冷启');
  assert.equal(isAlive(fake.pid), true);
});

/* —— 桥监督：在途调用兜底期限（核心活着但该调用无应答不得无限挂） —— */

test('监督：在途 call 超出桥侧兜底期限 → 明确超时文案；连接不受影响、后续调用照常', { timeout: 20000 }, async (t) => {
  const home = makeTempDir(t);
  writeRecordFile(home);
  let dropNext = true;
  const server = await startStubCore(t, home, {
    onFrame: (frame, record) => {
      if (frame.type === 'call' && dropNext) {
        dropNext = false;
        return;   // 收下不回：核心活着而该调用无应答的形态
      }
      if (frame.type === 'call') {
        server.send(record, { type: 'result', id: frame.id, content: [{ type: 'text', text: '第二次应答' }] });
      }
    },
  });
  const link = linkFor(home, spawnRecorder().spawnFn, { callTimeoutMs: 120 });
  t.after(() => link.close());
  assert.equal((await link.ensureCore()).ok, true);
  const timedOut = await link.call('ws_status', {});
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.kind, 'timeout');
  assert.match(timedOut.message, /超时/);
  assert.equal(link.state.registered, true, '超时只收口该调用，不动连接');
  const later = await link.call('ws_ping', {});
  assert.deepEqual(later, { ok: true, result: { content: [{ type: 'text', text: '第二次应答' }] } });
});

test('监督：等待预算为硬期限——只接不说的端点下仍按预算收口（不叠加连接 5s/握手 10s）', { timeout: 20000 }, async (t) => {
  const home = makeTempDir(t);
  writeRecordFile(home, { heartbeatAt: freshIso() });
  const silent = net.createServer((socket) => {
    socket.on('error', () => {});
  });
  await new Promise((resolve) => {
    silent.listen(endpointFor(home), resolve);
  });
  t.after(() => silent.close());
  const link = linkFor(home, spawnRecorder().spawnFn, { waitMs: 300, pollMs: 25 });
  t.after(() => link.close());
  const started = Date.now();
  const outcome = await link.ensureCore();
  const elapsed = Date.now() - started;
  assert.equal(outcome.ok, false);
  assert.ok(elapsed < 2000, `预算 300ms 一档收口（实际 ${elapsed}ms——未钳制时为连接 5s＋握手 10s 叠加）`);
});

/* —— 桥运行时接线：崩溃→重生→重注册链经组合根成立 —— */

test('运行时：崩溃→重生→重注册链（registry 转发与 push 接线在重生后照常）', { timeout: 20000 }, async (t) => {
  const home = makeTempDir(t);
  writeRecordFile(home);
  const server = await startStubCore(t, home);
  const sim = coldStartSim(t, home, { replyText: '来自核心' });
  const link = linkFor(home, sim.spawnFn);
  const logs = [];
  const delivered = [];
  const runtime = createBridgeRuntime({
    env: { WAYSTATION_HOME: home, CLAUDE_CODE_SESSION_ID: 'session-supervision-1' },
    dataDir: home,
    log: { info: (message, meta) => logs.push({ message, meta }), warn: () => {}, error: () => {} },
    writer: { deliver: async (text) => (delivered.push(text), { ok: true }) },
    link,
  });
  t.after(() => runtime.close());
  assert.equal((await runtime.link.ensureCore()).ok, true);
  const dead = spawnSync(process.execPath, ['-e', '']);
  writeRecordFile(home, { pid: dead.pid, status: 'ready' });
  await server.close();
  await waitFor(() => runtime.link.state.registered === false, { timeoutMs: 3000 });
  await waitFor(() => runtime.link.state.registered, { timeoutMs: 8000 });
  const result = await runtime.registry.call('ws_ping', {});
  assert.deepEqual(result, { content: [{ type: 'text', text: '来自核心' }] }, '重生后 registry 转发照常');
  const core = sim.latestServer();
  core.send(core.listBridges()[0], { type: 'push', pushId: 'push-1', text: '重生后注入', collabId: 'c1', frameType: 'message' });
  await waitFor(() => delivered.length >= 1, { timeoutMs: 3000 });
  assert.deepEqual(delivered, ['重生后注入'], 'push 经注入写面照常接线');
});

test('运行时：重注册 stderr 诊断行（初次注册与重生后重注册）', { timeout: 20000 }, async (t) => {
  const home = makeTempDir(t);
  writeRecordFile(home);
  const server = await startStubCore(t, home);
  const sim = coldStartSim(t, home);
  const logs = [];
  const runtime = createBridgeRuntime({
    env: { WAYSTATION_HOME: home, CLAUDE_CODE_SESSION_ID: 'session-supervision-1' },
    dataDir: home,
    log: { info: (message, meta) => logs.push({ message, meta }), warn: () => {}, error: () => {} },
    writer: { deliver: async () => ({ ok: true }) },
    link: linkFor(home, sim.spawnFn),
  });
  t.after(() => runtime.close());
  await runtime.link.ensureCore();
  server.listBridges()[0].close();
  await waitFor(() => logs.length >= 2, { timeoutMs: 3000 });
  assert.deepEqual(logs.map((entry) => entry.message), ['核心已注册', '核心重生后重注册（连接已接续）']);
  assert.equal(logs[0].meta.corePid, process.pid);
});

/* —— 核心侧桥断开清理（Step 5 接线）：删注册＋两触发挂点 —— */

async function connectBridgeToCore(home, sessionId) {
  const token = JSON.parse(readFileSync(coreJsonPath(home), 'utf8')).token;
  const client = createIpcClient({
    dataDir: home,
    hello: { app: '0.1.0', token, bridgeId: `bridge-${sessionId}`, sessionId },
    log: quietLog(),
  });
  const welcome = await client.connect();
  return { client, welcome };
}

async function closeBridgeClient(client) {
  client.send({ type: 'bye', reason: 'session-end' });
  await client.close();
}

/* 注册表删除的公开观测面：注册表计数（onCountChange）驱动宽限窗——末桥退场计数归零即在设定期限后
 * 有序收尾退出；`bridges.remove` 缺失时计数不归零、本断言不会通过。注册表原语的单元覆盖在
 * core-lifecycle 既有用例，本处补的是「经真 IPC 断开→注册表→宽限」的组合路径。 */
async function waitGraceExit(core) {
  const outcome = await Promise.race([
    core.whenExited().then(() => 'exited'),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 5000)),
  ]);
  assert.equal(outcome, 'exited', '末桥退场后按宽限有序退出（注册表计数归零的公开面）');
}

test('核心侧桥断开清理：连接面随断开下行＋两触发挂点按序外送＋终态宽限退出（注册表删除的公开面）', { timeout: 30000 }, async (t) => {
  const home = makeTempDir(t);
  writeFileSync(`${home}/config.json`, JSON.stringify({ port: await pickFreePort() }));
  const drops = [];
  const sleeps = [];
  const started = await startCore({
    env: { ...process.env, WAYSTATION_HOME: home, NODE_TEST_CONTEXT: '1', WAYSTATION_TEST_GRACE_MS: '1000' },
    onBridgeSessionFileDrop: (record) => drops.push(record.sessionId),
    onBridgeBindingsSleep: (record) => sleeps.push(record.sessionId),
  });
  assert.equal(started.ok, true, started.message);
  const clients = [];
  t.after(async () => {
    for (const client of clients) {
      await client.close().catch(() => {});
    }
    await started.core.stop();
  });
  const a = await connectBridgeToCore(home, 'sp-a');
  clients.push(a.client);
  assert.equal(a.welcome.bridges, 1, '连接面在线桥数（IPC 连接表口径）');
  const b = await connectBridgeToCore(home, 'sp-b');
  clients.push(b.client);
  assert.equal(b.welcome.bridges, 2);
  await closeBridgeClient(a.client);
  await waitFor(() => drops.length === 1);
  assert.deepEqual(drops, ['sp-a'], '断开触发会话状态文件删除挂点');
  assert.deepEqual(sleeps, ['sp-a'], '断开触发绑定休眠挂点');
  const c = await connectBridgeToCore(home, 'sp-c');
  clients.push(c.client);
  assert.equal(c.welcome.bridges, 2, '甲断开已从连接表下行（在线＝乙＋丙）');
  await closeBridgeClient(b.client);
  await closeBridgeClient(c.client);
  await waitFor(() => drops.length === 3);
  assert.deepEqual(drops, ['sp-a', 'sp-b', 'sp-c']);
  assert.deepEqual(sleeps, ['sp-a', 'sp-b', 'sp-c']);
  await waitGraceExit(started.core);
});
