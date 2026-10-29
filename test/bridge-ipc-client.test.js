import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { makeTempDir, pickFreePort, repoRoot, waitFor } from './helpers.js';
import { IPC_VERSION, createIpcServer, endpointFor } from '../src/core/ipc.js';
import { coreJsonPath, runDir } from '../src/paths.js';
import { createCoreLink } from '../src/bridge/ipc-client.js';

/* 桥连接件的判别测试（四态判据写死）：桩 core.json ＋桩核心（IPC 层真实服务端）。
 * 全部临时根（makeTempDir），不触碰真实 ~/.waystation、不占站点端口段——端点走管道/套接字文件。 */

const TOKEN = 'bridge-test-token-0123456789abcdef';

/* 假核 app 版本桩：桩核 welcome.app（运行核心版本读数）与桥的换代判定读数（targetAppVersion）同源。
 * 换代判定比「安装树目标版本 vs 运行核心版本」——缺省安装树读数随 package.json 版本迁移，会误判
 * target-newer 进换代窗口；判定前提「目标≤运行」须在测试内自洽，换代用例另行显式注入目标版本。 */
const STUB_APP_VERSION = '0.1.0';

function quietLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

/* core.json 夹具：identity 置 null（锁创建时身份未就绪的真形态——读取方必须容忍）。 */
function recordFixture(dataDir, overrides = {}) {
  return {
    v: 1,
    ipcV: IPC_VERSION,
    appVersion: STUB_APP_VERSION,
    pid: process.pid,
    endpoint: endpointFor(dataDir),
    token: TOKEN,
    identity: null,
    port: 7500,
    startedAt: new Date().toISOString(),
    status: 'ready',
    startupDeadline: new Date(Date.now() + 15000).toISOString(),
    heartbeatAt: new Date().toISOString(),
    ...overrides,
  };
}

function writeRecord(dataDir, overrides = {}) {
  mkdirSync(runDir(dataDir), { recursive: true });
  writeFileSync(coreJsonPath(dataDir), JSON.stringify(recordFixture(dataDir, overrides), null, 2) + '\n');
}

function welcomeFixture(dataDir) {
  return ({ bridges }) => ({
    type: 'welcome',
    ok: true,
    v: IPC_VERSION,
    app: STUB_APP_VERSION,
    corePid: process.pid,
    dataDir,
    identity: { instanceId: 'inst-boot', identityName: 'lfxue' },
    port: 7500,
    net: { available: true, degraded: false },
    persistent: false,
    bridges,
  });
}

function refusal(code, message, v = undefined) {
  return () => ({ type: 'welcome', ok: false, code, message, ...(v === undefined ? {} : { v }) });
}

/* 桩核心：IPC 层真实服务端（监听端点、认证、帧往返全走生产代码）。bye 属 IPC 层自理帧
 * （不进 onFrame，onClose 以 reason:'bye' 表达正常退场）——退场断言经 onClose 观察。 */
async function startStubCore(t, home, { token = TOKEN, welcome = null, onFrame = null, onClose = null } = {}) {
  const server = createIpcServer({
    dataDir: home,
    token,
    welcomeOf: welcome ?? welcomeFixture(home),
    log: quietLog(),
    onFrame: onFrame ?? (() => {}),
    onClose: onClose ?? (() => {}),
  });
  t.after(() => server.close());
  await server.start();
  return server;
}

/* spawn 记录器：伪子进程 = EventEmitter ＋ unref（事件面与真实 ChildProcess 相同的最小集合）。 */
function spawnRecorder() {
  const calls = [];
  const spawnFn = (command, args, options) => {
    const child = new EventEmitter();
    child.pid = 90000 + calls.length;
    child.unref = () => {};
    calls.push({ command, args, options, child });
    return child;
  };
  return { calls, spawnFn };
}

function linkFor(home, spawnFn, overrides = {}) {
  return createCoreLink({
    dataDir: home,
    env: { WAYSTATION_HOME: home, CLAUDE_CODE_SESSION_ID: 'session-bridge-1', CLAUDE_CODE_MESSAGING_TOKEN: 'tok-secret' },
    app: STUB_APP_VERSION,
    // 换代判定读数桩：与桩核 welcome.app 同源（缺省现读安装树会随 package.json 版本迁移误判）
    targetAppVersion: STUB_APP_VERSION,
    bridgeId: 'bridge-under-test',
    sessionId: 'session-bridge-1',
    log: quietLog(),
    spawn: spawnFn,
    waitMs: 1500,
    pollMs: 25,
    waitingPollMs: 100,
    slowRetryMs: 200,
    ...overrides,
  });
}

/* 冷启模拟器：spawn 被调用后延迟写 core.json（并可同时起桩核心），模拟核心进程的落盘效应。
 * welcome/onFrame 可注入（换代轮次的新核复用本件：新核仍是旧版本 → 驱动闭环/连续轮次）。 */
function coldStartSimulator(t, home, { recordOverrides = {}, startCore = true, delayMs = 10, welcome = null, onFrame = null } = {}) {
  const recorder = spawnRecorder();
  const spawnFn = (command, args, options) => {
    const child = recorder.spawnFn(command, args, options);
    setTimeout(async () => {
      writeRecord(home, recordOverrides);
      if (startCore) {
        await startStubCore(t, home, { welcome, onFrame });
      }
    }, delayMs);
    return child;
  };
  return { calls: recorder.calls, spawnFn };
}

test('四态·无文件：冷启 spawn（detached/剥离会话私有环境）→ 桩核心就绪 → 注册成功', { timeout: 15000 }, async (t) => {
  const home = makeTempDir(t);
  const sim = coldStartSimulator(t, home);
  const link = linkFor(home, sim.spawnFn, { waitMs: 3000 });
  t.after(() => link.close());
  const outcome = await link.ensureCore();
  assert.equal(outcome.ok, true);
  assert.equal(link.state.registered, true);
  assert.equal(sim.calls.length, 1, '恰冷启一次');
  const call = sim.calls[0];
  assert.equal(call.command, process.execPath);
  assert.match(call.args[0].replaceAll('\\', '/'), /\/bin\/waystation-core\.js$/);
  assert.equal(call.options.detached, true);
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.stdio, 'ignore');
  assert.equal(call.options.env.WAYSTATION_HOME, home, '数据根随环境继承');
  assert.equal('CLAUDE_CODE_SESSION_ID' in call.options.env, false, '会话私有变量显式剔除');
  assert.equal('CLAUDE_CODE_MESSAGING_TOKEN' in call.options.env, false, '会话凭据不出桥进程');
});

test('hello 携启动期会话元数据：注册记录的 role/name/kind 等来自 hello', { timeout: 15000 }, async (t) => {
  const home = makeTempDir(t);
  writeRecord(home);
  const server = await startStubCore(t, home);
  const link = linkFor(home, () => {
    throw new Error('描述符就绪时不应冷启');
  }, {
    role: 'slave', masterName: 'boss', name: 'worker', kind: 'bg', entrypoint: 'cli', status: 'idle', metaUpdatedAt: 123,
  });
  t.after(() => link.close());
  const outcome = await link.ensureCore();
  assert.equal(outcome.ok, true);
  const [record] = server.listBridges();
  assert.deepEqual(
    [record.role, record.masterName, record.name, record.kind, record.entrypoint, record.status, record.metaUpdatedAt],
    ['slave', 'boss', 'worker', 'bg', 'cli', 'idle', 123],
  );
});

test('四态·无文件且 spawn 失败：cold-start-failed（含 errno）→ 后台慢速重试、关闭后停止', { timeout: 15000 }, async (t) => {
  const home = makeTempDir(t);
  let attempts = 0;
  const spawnFn = () => {
    attempts++;
    throw Object.assign(new Error('spawn 失败'), { code: 'ENOENT' });
  };
  const link = linkFor(home, spawnFn, { waitMs: 200 });
  t.after(() => link.close());
  const outcome = await link.ensureCore();
  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, 'cold-start-failed');
  assert.match(outcome.message, /ENOENT/);
  await waitFor(() => attempts >= 2, { timeoutMs: 3000 });
  await link.close();
  const atClose = attempts;
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(attempts, atClose, '关闭后不再重试');
});

test('四态·冷启超时（无 core.json）：启动超时文案＋退出码，不挂死', { timeout: 15000 }, async (t) => {
  const home = makeTempDir(t);
  const recorder = spawnRecorder();
  const spawnFn = (command, args, options) => {
    const child = recorder.spawnFn(command, args, options);
    setTimeout(() => child.emit('exit', 1), 20);
    return child;
  };
  const link = linkFor(home, spawnFn, { waitMs: 250, slowRetryMs: 10000 });
  t.after(() => link.close());
  const outcome = await link.ensureCore();
  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, 'cold-start-failed');
  assert.match(outcome.message, /启动超时|退出码/);
});

test('四态·冷启后核心写 startupError：失败文案取 core.json.startupError（不等待截止期）', { timeout: 15000 }, async (t) => {
  const home = makeTempDir(t);
  const sim = coldStartSimulator(t, home, {
    recordOverrides: { status: 'starting', startupError: '启动自检失败，拒绝服务：日志目录不可用' },
    startCore: false,
  });
  const link = linkFor(home, sim.spawnFn, { waitMs: 3000, slowRetryMs: 10000 });
  t.after(() => link.close());
  const outcome = await link.ensureCore();
  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, 'startup-failed');
  assert.equal(outcome.message, '核心启动失败：启动自检失败，拒绝服务：日志目录不可用');
});

test('四态·starting 未超截止期：不冷启、轮询至就绪后注册', { timeout: 15000 }, async (t) => {
  const home = makeTempDir(t);
  const recorder = spawnRecorder();
  writeRecord(home, { status: 'starting', startupDeadline: new Date(Date.now() + 5000).toISOString() });
  const link = linkFor(home, recorder.spawnFn, { waitMs: 4000 });
  t.after(() => link.close());
  const pending = link.ensureCore();
  setTimeout(async () => {
    writeRecord(home, { status: 'ready' });
    await startStubCore(t, home);
  }, 200);
  const outcome = await pending;
  assert.equal(outcome.ok, true);
  assert.equal(recorder.calls.length, 0, '等待窗口内不得冷启（不偷锁）');
});

test('四态·starting 超截止期：启动失败文案（无 startupError 时为超时文案），不冷启', { timeout: 15000 }, async (t) => {
  const home = makeTempDir(t);
  const recorder = spawnRecorder();
  writeRecord(home, { status: 'starting', startupDeadline: new Date(Date.now() - 1000).toISOString() });
  const link = linkFor(home, recorder.spawnFn, { waitMs: 500, slowRetryMs: 10000 });
  t.after(() => link.close());
  const outcome = await link.ensureCore();
  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, 'startup-failed');
  assert.match(outcome.message, /启动超时|截止期/);
  assert.equal(recorder.calls.length, 0);
});

test('四态·waiting：立即回报（文案取 statusDetail）、不冷启；核转 ready 后后台轮询接上', { timeout: 15000 }, async (t) => {
  const home = makeTempDir(t);
  const recorder = spawnRecorder();
  const detail = '检测到同根旧版会话运行中（pid 4242），请先关闭它；关闭后自动接管';
  writeRecord(home, { status: 'waiting', statusDetail: detail });
  const link = linkFor(home, recorder.spawnFn, { waitMs: 3000 });
  t.after(() => link.close());
  const started = Date.now();
  const outcome = await link.ensureCore();
  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, 'waiting');
  assert.equal(outcome.message, detail);
  assert.ok(Date.now() - started < 500, 'waiting 分支立即回报（不等待、不冷启）');
  assert.equal(recorder.calls.length, 0);
  writeRecord(home, { status: 'ready' });
  await startStubCore(t, home);
  await waitFor(() => link.state.registered, { timeoutMs: 3000 });
});

test('四态·waiting 但 pid 已死：判陈旧 → 冷启（重生流；旧行为「不冷启」已随监督落地替换）', { timeout: 15000 }, async (t) => {
  const home = makeTempDir(t);
  const sim = coldStartSimulator(t, home);
  const dead = spawnSync(process.execPath, ['-e', '']);
  writeRecord(home, { status: 'waiting', pid: dead.pid });
  const link = linkFor(home, sim.spawnFn, { waitMs: 3000 });
  t.after(() => link.close());
  const outcome = await link.ensureCore();
  assert.equal(outcome.ok, true, '冷启的新核接管（陈旧锁由核心侧仲裁清理）');
  assert.equal(sim.calls.length, 1, '判陈旧恰冷启一次');
});

test('四态·waiting 但心跳过期（进程活）：判僵尸 → 硬杀防护链 → 冷启', { timeout: 15000 }, async (t) => {
  const home = makeTempDir(t);
  const sim = coldStartSimulator(t, home);
  const kills = [];
  writeRecord(home, { status: 'waiting', heartbeatAt: new Date(Date.now() - 60000).toISOString() });
  const link = linkFor(home, sim.spawnFn, {
    waitMs: 3000,
    guardOptions: { kill: (pid, signal) => kills.push({ pid, signal }) },
  });
  t.after(() => link.close());
  const outcome = await link.ensureCore();
  assert.equal(outcome.ok, true);
  assert.equal(kills.length, 1, '硬杀防护链恰杀一次');
  assert.equal(kills[0].pid, process.pid);
  assert.equal(kills[0].signal, 'SIGKILL');
  assert.equal(sim.calls.length, 1, '链过后冷启一次');
});

test('四态·replacing：等待新核文案、不冷启', { timeout: 15000 }, async (t) => {
  const home = makeTempDir(t);
  const recorder = spawnRecorder();
  writeRecord(home, { status: 'ready' });
  await startStubCore(t, home, { welcome: refusal('replacing', '核心正在换代') });
  const link = linkFor(home, recorder.spawnFn, { waitMs: 500, slowRetryMs: 10000 });
  t.after(() => link.close());
  const outcome = await link.ensureCore();
  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, 'replacing');
  assert.match(outcome.message, /换代/);
  assert.equal(recorder.calls.length, 0);
});

test('四态·version：降级文案要求重开会话（终态，不冷启）', { timeout: 15000 }, async (t) => {
  const home = makeTempDir(t);
  const recorder = spawnRecorder();
  writeRecord(home, { status: 'ready' });
  await startStubCore(t, home, { welcome: refusal('version', '驿站版本不兼容') });
  const link = linkFor(home, recorder.spawnFn, { waitMs: 500 });
  t.after(() => link.close());
  const outcome = await link.ensureCore();
  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, 'version');
  assert.match(outcome.message, /重开会话/);
  assert.equal(recorder.calls.length, 0);
});

test('其余·ready 且心跳新鲜但端点不存在：无应答文案、不冷启（非陈旧——陈旧判定按心跳与 pid 判活）', { timeout: 15000 }, async (t) => {
  const home = makeTempDir(t);
  const recorder = spawnRecorder();
  writeRecord(home, { status: 'ready' });
  const link = linkFor(home, recorder.spawnFn, { waitMs: 300, slowRetryMs: 10000 });
  t.after(() => link.close());
  const outcome = await link.ensureCore();
  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, 'unreachable');
  assert.match(outcome.message, /无应答/);
  assert.equal(recorder.calls.length, 0, '非陈旧描述符不冷启');
});

test('陈旧·ready 残骸（pid 死＋心跳超期）：判陈旧 → 冷启（重生流）', { timeout: 15000 }, async (t) => {
  const home = makeTempDir(t);
  const sim = coldStartSimulator(t, home);
  const dead = spawnSync(process.execPath, ['-e', '']);
  writeRecord(home, { status: 'ready', pid: dead.pid, heartbeatAt: new Date(Date.now() - 55000).toISOString() });
  const link = linkFor(home, sim.spawnFn, { waitMs: 3000 });
  t.after(() => link.close());
  const outcome = await link.ensureCore();
  assert.equal(outcome.ok, true, '崩溃核残骸 → 冷启新核并注册');
  assert.equal(sim.calls.length, 1);
});

test('其余·core.json 不可解析：判陈旧 → 冷启（不可解析的锁由核心侧仲裁隔离清理）', { timeout: 15000 }, async (t) => {
  const home = makeTempDir(t);
  const sim = coldStartSimulator(t, home);
  mkdirSync(runDir(home), { recursive: true });
  writeFileSync(coreJsonPath(home), '{ not json');
  const link = linkFor(home, sim.spawnFn, { waitMs: 3000 });
  t.after(() => link.close());
  const outcome = await link.ensureCore();
  assert.equal(outcome.ok, true);
  assert.equal(sim.calls.length, 1, '不可解析描述符恰冷启一次');
});

test('握手超时：桩核心接受连接但不应答 → 无应答收口', { timeout: 15000 }, async (t) => {
  const home = makeTempDir(t);
  writeRecord(home, { status: 'ready' });
  const sockets = new Set();
  const silent = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
  });
  await new Promise((resolve, rejectPromise) => {
    silent.once('error', rejectPromise);
    silent.listen(endpointFor(home), resolve);
  });
  t.after(() => {
    for (const socket of sockets) {
      socket.destroy();
    }
    silent.close();
  });
  const recorder = spawnRecorder();
  const link = linkFor(home, recorder.spawnFn, { waitMs: 800, handshakeTimeoutMs: 150, slowRetryMs: 10000 });
  t.after(() => link.close());
  const outcome = await link.ensureCore();
  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, 'unreachable');
  assert.equal(recorder.calls.length, 0);
});

test('转发：call→result 载荷原样、push 分发、delivered 回发、close 发 bye', { timeout: 15000 }, async (t) => {
  const home = makeTempDir(t);
  writeRecord(home, { status: 'ready' });
  const received = [];
  const closeReasons = [];
  const server = await startStubCore(t, home, {
    onFrame: (frame, record) => {
      received.push(frame);
      if (frame.type === 'call') {
        server.send(record, { type: 'result', id: frame.id, content: [{ type: 'text', text: '原样回传' }] });
      }
    },
    onClose: (_record, info) => {
      closeReasons.push(info.reason);
    },
  });
  const link = linkFor(home, spawnRecorder().spawnFn);
  t.after(() => link.close());
  assert.equal((await link.ensureCore()).ok, true);
  let pushed = null;
  link.setPushHandler((frame) => {
    pushed = frame;
  });
  const result = await link.call('ws_status', { a: 1 });
  assert.deepEqual(result, { ok: true, result: { content: [{ type: 'text', text: '原样回传' }] } });
  const callFrame = received.find((frame) => frame.type === 'call');
  assert.match(callFrame.id, /^[0-9a-f-]{36}$/);
  assert.equal(callFrame.tool, 'ws_status');
  assert.deepEqual(callFrame.args, { a: 1 });
  server.send(server.listBridges()[0], { type: 'push', pushId: 'push-1', text: '注入文本', collabId: 'collab-1', frameType: 'message' });
  await waitFor(() => pushed !== null);
  assert.equal(pushed.text, '注入文本');
  link.sendDelivered({ type: 'delivered', pushId: 'push-1', ok: false, reason: 'rejected' });
  await waitFor(() => received.some((frame) => frame.type === 'delivered'));
  assert.deepEqual(received.find((frame) => frame.type === 'delivered'), { type: 'delivered', pushId: 'push-1', ok: false, reason: 'rejected' });
  await link.close();
  await waitFor(() => closeReasons.includes('bye'), { timeoutMs: 3000 });
  assert.deepEqual(closeReasons, ['bye'], '正常退场帧在断开前刷出（核心侧识别为 bye 而非 peer）');
});

test('在途调用因核心断开收口；后台重试自动重连；关闭后调用以 closed 收口', { timeout: 15000 }, async (t) => {
  const home = makeTempDir(t);
  writeRecord(home, { status: 'ready' });
  let dropNext = true;
  const server = await startStubCore(t, home, {
    onFrame: (frame, record) => {
      if (frame.type === 'call' && dropNext) {
        dropNext = false;
        record.close();
      }
    },
  });
  const link = linkFor(home, spawnRecorder().spawnFn, { slowRetryMs: 150 });
  t.after(() => link.close());
  assert.equal((await link.ensureCore()).ok, true);
  const result = await link.call('ws_status', {});
  assert.equal(result.ok, false);
  assert.match(result.message, /无应答或重启中/);
  await waitFor(() => link.state.registered, { timeoutMs: 3000 });
  assert.equal(server.listBridges().length, 1, '后台重试重连后恰一个注册桥');
  await link.close();
  const closed = await link.call('ws_status', {});
  assert.equal(closed.ok, false);
  assert.equal(closed.kind, 'closed');
});

test('冷启并发去重：同桥并发调用恰冷启一次', { timeout: 15000 }, async (t) => {
  const home = makeTempDir(t);
  const sim = coldStartSimulator(t, home);
  const link = linkFor(home, sim.spawnFn, { waitMs: 3000 });
  t.after(() => link.close());
  const [first, second] = await Promise.all([link.ensureCore(), link.ensureCore()]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(sim.calls.length, 1);
});

test('构造校验：缺 dataDir/app 抛 TypeError（接线错误早失败）', () => {
  assert.throws(() => createCoreLink({ app: '0.1.0' }), /缺少 dataDir/);
  assert.throws(() => createCoreLink({ dataDir: '/no-app' }), /缺少 app/);
});

test('描述符异常形态·非对象 JSON：不可解析＝陈旧 → 冷启（坏 JSON 与非对象同出口）', { timeout: 15000 }, async (t) => {
  const home = makeTempDir(t);
  const sim = coldStartSimulator(t, home);
  mkdirSync(runDir(home), { recursive: true });
  writeFileSync(coreJsonPath(home), '[]');
  const link = linkFor(home, sim.spawnFn, { waitMs: 3000 });
  t.after(() => link.close());
  const broken = await link.ensureCore();
  assert.equal(broken.ok, true);
  assert.equal(sim.calls.length, 1);
});

test('描述符异常形态·缺凭据（pid 活、心跳新鲜）：不冷启、按不可达收口', { timeout: 15000 }, async (t) => {
  const home = makeTempDir(t);
  const recorder = spawnRecorder();
  writeRecord(home, { token: '' });
  const link = linkFor(home, recorder.spawnFn, { waitMs: 200, slowRetryMs: 10000 });
  t.after(() => link.close());
  const noToken = await link.ensureCore();
  assert.equal(noToken.kind, 'unreachable');
  assert.match(noToken.message, /凭据/);
  assert.equal(recorder.calls.length, 0, '缺凭据不构成陈旧判据——不冷启');
});

test('waiting 但 pid 非法：判陈旧（pid 不可判活）→ 冷启', { timeout: 15000 }, async (t) => {
  const home = makeTempDir(t);
  const sim = coldStartSimulator(t, home);
  writeRecord(home, { status: 'waiting', pid: -1 });
  const link = linkFor(home, sim.spawnFn, { waitMs: 3000 });
  t.after(() => link.close());
  const outcome = await link.ensureCore();
  assert.equal(outcome.ok, true);
  assert.equal(sim.calls.length, 1, '非法 pid 与 pid 死同口径（与取锁仲裁的 isAlive 判据一致）');
});

test('关停期间在途等待：关闭即收口（closed）、不冷启也不挂死', { timeout: 15000 }, async (t) => {
  const home = makeTempDir(t);
  const recorder = spawnRecorder();
  writeRecord(home, { status: 'starting', startupDeadline: new Date(Date.now() + 60000).toISOString() });
  const link = linkFor(home, recorder.spawnFn, { waitMs: 60000, pollMs: 50 });
  t.after(() => link.close());
  const pending = link.ensureCore();
  await new Promise((resolve) => setTimeout(resolve, 60));
  await link.close();
  const outcome = await pending;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, 'closed');
  assert.equal(recorder.calls.length, 0);
});

test('换代广播接续位：core-restarting 帧经钩子外送', { timeout: 15000 }, async (t) => {
  const home = makeTempDir(t);
  writeRecord(home, { status: 'ready' });
  const server = await startStubCore(t, home);
  const seen = [];
  const link = linkFor(home, spawnRecorder().spawnFn, { onCoreRestarting: (frame) => seen.push(frame) });
  t.after(() => link.close());
  assert.equal((await link.ensureCore()).ok, true);
  server.send(server.listBridges()[0], { type: 'core-restarting', reason: 'version-mismatch', replacerBridgeId: 'bridge-x', deadlineMs: 10000 });
  await waitFor(() => seen.length >= 1);
  assert.equal(seen[0].deadlineMs, 10000);
});

test('结果面：isError 原样透传；未知 id 的 result 被忽略且连接不受影响', { timeout: 15000 }, async (t) => {
  const home = makeTempDir(t);
  writeRecord(home, { status: 'ready' });
  const server = await startStubCore(t, home, {
    onFrame: (frame, record) => {
      if (frame.type === 'call') {
        server.send(record, { type: 'result', id: frame.id, content: [{ type: 'text', text: '失败文案' }], isError: true });
      }
    },
  });
  const link = linkFor(home, spawnRecorder().spawnFn);
  t.after(() => link.close());
  assert.equal((await link.ensureCore()).ok, true);
  const result = await link.call('ws_ping', {});
  assert.deepEqual(result, { ok: true, result: { content: [{ type: 'text', text: '失败文案' }], isError: true } });
  server.send(server.listBridges()[0], { type: 'result', id: 'no-such-call', content: [] });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(link.state.registered, true, '未知 id 的 result 被忽略、连接不受影响');
});

test('sendDelivered：未注册（未连接）时返回 false', { timeout: 15000 }, async (t) => {
  const home = makeTempDir(t);
  const link = linkFor(home, spawnRecorder().spawnFn);
  t.after(() => link.close());
  assert.equal(link.sendDelivered({ type: 'delivered', pushId: 'push-1', ok: true }), false);
});

test('冷启 spawn 异步失败（error 事件）：失败归因取 errno', { timeout: 15000 }, async (t) => {
  const home = makeTempDir(t);
  const recorder = spawnRecorder();
  const spawnFn = (command, args, options) => {
    const child = recorder.spawnFn(command, args, options);
    setTimeout(() => child.emit('error', Object.assign(new Error('spawn EACCES'), { code: 'EACCES' })), 10);
    return child;
  };
  const link = linkFor(home, spawnFn, { waitMs: 250, slowRetryMs: 10000 });
  t.after(() => link.close());
  const outcome = await link.ensureCore();
  assert.equal(outcome.kind, 'cold-start-failed');
  assert.match(outcome.message, /EACCES/);
});

test('冷启进程静默未就绪（无事件、无退出码）：启动超时文案', { timeout: 15000 }, async (t) => {
  const home = makeTempDir(t);
  const link = linkFor(home, spawnRecorder().spawnFn, { waitMs: 200, slowRetryMs: 10000 });
  t.after(() => link.close());
  const outcome = await link.ensureCore();
  assert.equal(outcome.kind, 'cold-start-failed');
  assert.match(outcome.message, /启动超时/);
});

/* —— 换代协议接线（B 段：判定/发起/等待新核/直连替换/台账） —— */

/* 旧核「有序退出」模拟：关服务（端点消失）＋删运行描述符（与核心收尾同形）。 */
async function exitOldCore(server, home) {
  await server.close();
  rmSync(coreJsonPath(home), { force: true });
}

/* 换代桩核的应答面：收 replace → 广播 core-restarting（replacerBridgeId＝发起桥）→ 有序退出。 */
function acceptReplace(holder, home, frames) {
  return (frame, record) => {
    if (frame.type !== 'replace') {
      return;
    }
    frames.push(frame);
    holder.server.send(record, { type: 'core-restarting', reason: 'version-mismatch', replacerBridgeId: 'bridge-under-test', deadlineMs: 10000, targetApp: frame.wantApp });
    holder.closing = exitOldCore(holder.server, home);
  };
}

/* 换代全场景桩：每代桩核共用同一应答面；spawn 等旧核关净（端点释放）后落新描述符并起下一代
 * （换代后新核＝版本 nextAppVersion；缺省同旧版本——驱动连续轮次/闭环）。 */
function changeoverHarness(t, home, { appVersion = '0.0.9', nextAppVersion = null } = {}) {
  const holder = { server: null, closing: null };
  const frames = [];
  const recorder = spawnRecorder();
  const welcomeOf = (version) => ({ bridges }) => ({ ...welcomeFixture(home)({ bridges }), app: version });
  const onFrame = acceptReplace(holder, home, frames);
  const start = async (welcome) => {
    writeRecord(home, { status: 'ready' });
    holder.server = await startStubCore(t, home, { welcome, onFrame });
  };
  const spawnFn = (command, args, options) => {
    const child = recorder.spawnFn(command, args, options);
    setTimeout(async () => {
      await holder.closing;
      writeRecord(home);
      await start(welcomeOf(nextAppVersion ?? appVersion));
    }, 10);
    return child;
  };
  return { frames, calls: recorder.calls, spawnFn, start: () => start(welcomeOf(appVersion)) };
}

/* 活体假旧核：真子进程（长眠）——与父进程不同的 pid，避免撞进程级单次闸的既有记账。 */
function liveFakeCore(t) {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  return child.pid;
}

/* 真核进程（进程级用例用）：临时根＋显式配置端口起 bin 入口，等 ready 返回运行描述符。 */
async function spawnRealCore(t, home) {
  const port = await pickFreePort();
  writeFileSync(join(home, 'config.json'), JSON.stringify({ port, scanWindowMs: 300, dialTimeoutMs: 1500, probeTimeoutMs: 300, viewerAutoOpen: false }));
  const child = spawn(process.execPath, [join(repoRoot, 'bin', 'waystation-core.js')], {
    env: { ...process.env, NODE_TEST_CONTEXT: 'bridge-ipc-client-test', WAYSTATION_HOME: home },
    stdio: 'ignore',
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  });
  const record = await waitFor(() => {
    try {
      const parsed = JSON.parse(readFileSync(coreJsonPath(home), 'utf8'));
      return parsed.status === 'ready' ? parsed : false;
    } catch {
      return false;
    }
  }, { timeoutMs: 15000 });
  return { child, record, port };
}

test('换代·行二：目标＞运行 → 发 replace（wantApp＝安装树读数）→ 广播回自身 → 收尾重 spawn 注册', { timeout: 15000 }, async (t) => {
  const home = makeTempDir(t);
  const harness = changeoverHarness(t, home, { nextAppVersion: '0.1.0' }); // 换代后新核＝目标版本
  await harness.start();
  const link = linkFor(home, harness.spawnFn, { targetAppVersion: '0.1.0', waitMs: 3000 });
  t.after(() => link.close());
  assert.equal((await link.ensureCore()).ok, true);
  await waitFor(() => harness.frames.length === 1, { timeoutMs: 5000 });
  assert.equal(harness.frames[0].reason, 'version-mismatch');
  assert.equal(harness.frames[0].wantApp, '0.1.0', 'wantApp＝安装树目标版本（不比桥内存版本）');
  // 新核（目标版本）就位 → 收尾 → 标准路径 spawn → 注册（目标已达＝不再换代）
  await waitFor(() => link.state.registered === true && link.changeoverState().pendingRound === null, { timeoutMs: 8000 });
  assert.equal(harness.calls.length, 1, '恰重 spawn 一次（spawn 交标准获取路径，无双 spawn）');
  assert.equal(harness.frames.length, 1, '目标达到后不再发起换代（轮次复位）');
  assert.equal(link.changeoverState().ledger.stopped, false);
});

test('换代·no-progress：连续两轮未达目标 → 第三轮不发起＋降级上报（台账截断）', { timeout: 15000 }, async (t) => {
  const home = makeTempDir(t);
  const harness = changeoverHarness(t, home);
  await harness.start();
  const link = linkFor(home, harness.spawnFn, { targetAppVersion: '0.1.0', waitMs: 3000, slowRetryMs: 200 });
  t.after(() => link.close());
  assert.equal((await link.ensureCore()).ok, true);
  await waitFor(() => (link.changeoverState().notice ?? '').includes('连续两轮'), { timeoutMs: 12000 });
  assert.equal(harness.frames.length, 2, '恰两轮 replace——第三轮被台账收口');
  assert.equal(link.changeoverState().ledger.stopped, true);
  assert.equal(harness.calls.length, 2);
});

test('换代·行五直连替换：版本拒绝实证硬杀 → 重 spawn 后仍不兼容 → 台账判停（不循环）', { timeout: 15000 }, async (t) => {
  const home = makeTempDir(t);
  const fakePid = liveFakeCore(t);
  writeRecord(home, { status: 'ready', pid: fakePid });
  const kills = [];
  const server = await startStubCore(t, home, { welcome: refusal('version', '驿站版本不兼容', 1) });
  const sim = coldStartSimulator(t, home, { welcome: refusal('version', '驿站版本不兼容', 1), recordOverrides: { pid: fakePid } });
  const link = linkFor(home, sim.spawnFn, {
    ipcV: 2, targetAppVersion: '0.1.0', waitMs: 3000, slowRetryMs: 10000, changeoverSettleMs: 10,
    guardOptions: { kill: (pid, signal) => { kills.push({ pid, signal }); void exitOldCore(server, home); }, probe: async () => 'gone' },
  });
  t.after(() => link.close());
  const outcome = await link.ensureCore();
  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, 'replacing', '在途调用立即回报换代文案（不自动重试）');
  assert.match(outcome.message, /换代中/);
  await waitFor(() => kills.length === 1, { timeoutMs: 5000 });
  assert.equal(kills[0].pid, fakePid, '版本拒绝实证相：判别器放行硬杀（描述符所指旧核）');
  await waitFor(() => (link.changeoverState().notice ?? '').includes('ipcV'), { timeoutMs: 8000 });
  assert.equal(kills.length, 1, '重 spawn 后仍不兼容 → 台账判停，未再杀（不循环）');
  assert.equal(link.changeoverState().ledger.stopped, true);
});

test('换代·行四：核心 ipcV 更高 → 用户面降级文案、不杀不冷启（文案分层）', { timeout: 15000 }, async (t) => {
  const home = makeTempDir(t);
  writeRecord(home, { status: 'ready' });
  const recorder = spawnRecorder();
  const kills = [];
  await startStubCore(t, home, { welcome: refusal('version', '驿站版本不兼容', IPC_VERSION + 1) });
  const link = linkFor(home, recorder.spawnFn, {
    targetAppVersion: '0.1.0', waitMs: 500, slowRetryMs: 10000,
    guardOptions: { kill: (pid, signal) => kills.push({ pid, signal }) },
  });
  t.after(() => link.close());
  const outcome = await link.ensureCore();
  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, 'version');
  assert.equal(outcome.message, '驿站已升级，请重开会话加载新版本', '用户面文案＝设计行四原文（帧 message 只作诊断面）');
  assert.equal(kills.length, 0);
  assert.equal(recorder.calls.length, 0, '旧桥不换代、不冷启');
});

test('换代·等待新核：收广播进等待（不冷启）→ 世代变化接新核；在途调用立即回报', { timeout: 15000 }, async (t) => {
  const home = makeTempDir(t);
  writeRecord(home, { status: 'ready' });
  const recorder = spawnRecorder();
  const server = await startStubCore(t, home);
  const link = linkFor(home, recorder.spawnFn, { waitMs: 800, slowRetryMs: 10000 });
  t.after(() => link.close());
  assert.equal((await link.ensureCore()).ok, true);
  server.send(server.listBridges()[0], { type: 'core-restarting', reason: 'version-mismatch', replacerBridgeId: 'bridge-other', deadlineMs: 10000, targetApp: '0.1.0' });
  await waitFor(() => link.changeoverState().waiting === true, { timeoutMs: 3000 });
  const during = await link.call('ws_status', {});
  assert.equal(during.ok, false);
  assert.equal(during.kind, 'replacing');
  assert.equal(during.message, '核心换代中（约数秒），请重试；数据未丢');
  assert.equal(recorder.calls.length, 0, '等待期禁止主动冷启');
  // 新核世代就位：新描述符（新 startedAt）＋新桩核
  await exitOldCore(server, home);
  writeRecord(home);
  await startStubCore(t, home);
  await waitFor(() => link.changeoverState().waiting === false && link.state.registered === true, { timeoutMs: 8000 });
  assert.equal(recorder.calls.length, 0, '全程未冷启（新一代由 replacer 负责）');
});

test('换代·注册后回执：welcome{ok:false,code:replacing} → 转等待新核（不冷启）', { timeout: 15000 }, async (t) => {
  const home = makeTempDir(t);
  writeRecord(home, { status: 'ready' });
  const recorder = spawnRecorder();
  const server = await startStubCore(t, home);
  const link = linkFor(home, recorder.spawnFn, { waitMs: 800, slowRetryMs: 10000 });
  t.after(() => link.close());
  assert.equal((await link.ensureCore()).ok, true);
  // 迟到的 replace 被核心回以 replacing（注册后回执＝并发换代时本桥的承接位）：必须转等待新核
  server.send(server.listBridges()[0], { type: 'welcome', ok: false, code: 'replacing', message: '核心正在换代，请等待新核就绪' });
  await waitFor(() => link.changeoverState().waiting === true, { timeoutMs: 3000 });
  const during = await link.call('ws_status', {});
  assert.equal(during.ok, false);
  assert.equal(during.kind, 'replacing');
  assert.equal(during.message, '核心换代中（约数秒），请重试；数据未丢');
  assert.equal(recorder.calls.length, 0, '等待期禁止主动冷启');
});

test('换代·安装树根按模块位置派生：缺省目标读数＝仓库 package.json 版本', { timeout: 15000 }, async (t) => {
  const home = makeTempDir(t);
  const repoVersion = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;
  const harness = changeoverHarness(t, home, { appVersion: '0.0.1' });
  await harness.start();
  const link = linkFor(home, harness.spawnFn, { waitMs: 3000, targetAppVersion: null }); // 目标读数显式置空＝走缺省安装树路径；appRoot 不注入
  t.after(() => link.close());
  assert.equal(resolve(link.changeoverState().appRoot), resolve(repoRoot), '安装树根＝模块位置派生的仓库根');
  assert.equal((await link.ensureCore()).ok, true);
  await waitFor(() => harness.frames.length === 1, { timeoutMs: 5000 });
  assert.equal(harness.frames[0].wantApp, repoVersion);
});

test('换代·等待超时：截止期到 → 换代失败降级上报＋交标准路径（老核照常接回）', { timeout: 15000 }, async (t) => {
  const home = makeTempDir(t);
  writeRecord(home, { status: 'ready' });
  const recorder = spawnRecorder();
  const server = await startStubCore(t, home);
  const link = linkFor(home, recorder.spawnFn, { waitMs: 800, slowRetryMs: 100, changeoverWaitMs: 80 });
  t.after(() => link.close());
  assert.equal((await link.ensureCore()).ok, true);
  server.send(server.listBridges()[0], { type: 'core-restarting', reason: 'version-mismatch', replacerBridgeId: 'bridge-other', deadlineMs: 10000, targetApp: '0.1.0' });
  await waitFor(() => (link.changeoverState().notice ?? '').includes('换代等待超时'), { timeoutMs: 5000 });
  // 解禁后交标准获取路径：老核仍在服务 → 接回注册
  await waitFor(() => link.state.registered === true && link.changeoverState().waiting === false, { timeoutMs: 5000 });
  assert.equal(recorder.calls.length, 0, '等待期与解禁初期都不冷启（老核可用）');
});

test('换代·目标读数不可得：降级上报、不换代（不以桥内存版本顶替）', { timeout: 15000 }, async (t) => {
  const home = makeTempDir(t);
  const bare = makeTempDir(t); // 无 package.json 的「安装树」——读数失败
  writeRecord(home, { status: 'ready' });
  const harness = changeoverHarness(t, home);
  await harness.start();
  const link = linkFor(home, harness.spawnFn, { appRoot: bare, targetAppVersion: null, waitMs: 3000 });
  t.after(() => link.close());
  assert.equal((await link.ensureCore()).ok, true);
  await waitFor(() => (link.changeoverState().notice ?? '').includes('换代判定不可得'), { timeoutMs: 3000 });
  assert.equal(harness.frames.length, 0, '读数失败不换代（不得以桥内存版本顶替）');
});

test('换代·单次闸（模块级 Set）拦同 pid 第二次终止信号：第二桥等价物转 already-once 降级', { timeout: 15000 }, async (t) => {
  const home = makeTempDir(t);
  const fakePid = liveFakeCore(t);
  writeRecord(home, { status: 'ready', pid: fakePid });
  const kills = [];
  const lines = [];
  const log = { info: () => {}, warn: (message, meta) => lines.push(`${message} ${JSON.stringify(meta ?? {})}`), error: () => {} };
  await startStubCore(t, home, { welcome: refusal('version', '驿站版本不兼容', 1) });
  const guardOptions = { kill: (pid, signal) => kills.push({ pid, signal }), probe: async () => 'gone' };
  const options = { ipcV: 2, targetAppVersion: '0.1.0', waitMs: 300, slowRetryMs: 10000, changeoverSettleMs: 10, guardOptions, log };
  const first = linkFor(home, spawnRecorder().spawnFn, options);
  t.after(() => first.close());
  assert.equal((await first.ensureCore()).kind, 'replacing');
  await waitFor(() => kills.length === 1, { timeoutMs: 5000 });
  assert.equal(kills[0].pid, fakePid);
  // 第二桥等价物（同进程内的第二个连接件；生产＝各自进程）遇同一冻结的旧核：单次闸拦第二次信号。
  // 如实口径：单次闸＝模块级 Set（本进程记账）——生产中每桥独立进程 ⟹ 按进程记账即按桥记账；
  // 真跨进程面（两桥各自进程）并入期终 e2e。
  const second = linkFor(home, spawnRecorder().spawnFn, options);
  t.after(() => second.close());
  assert.equal((await second.ensureCore()).kind, 'replacing');
  await waitFor(() => lines.some((line) => line.includes('already-once')), { timeoutMs: 5000 });
  assert.equal(kills.length, 1, '本进程已对同 pid 发过信号：第二次不再投递（模块级单次闸）');
  assert.match(second.changeoverState().notice, /ipcV/, '随后台账判停（重 spawn 后仍不兼容＝不循环）');
});

/* —— 换代·进程级（真核；含判别力红证的靶面） —— */

test('换代·进程级④a：真核换代中第二桥进等待、不冷启（窗口内 spawn 计数恒 0）', { timeout: 30000 }, async (t) => {
  const home = makeTempDir(t);
  await spawnRealCore(t, home);
  const spawnB = spawnRecorder();
  // 第二桥独立 bridgeId＋sessionId（同 sessionId 会被核心注册表按「新桥顶替旧桥」关掉——那是另一语义）
  const linkB = linkFor(home, spawnB.spawnFn, { bridgeId: 'bridge-second-b', sessionId: 'session-second-b', waitMs: 800, slowRetryMs: 100 });
  t.after(() => linkB.close());
  assert.equal((await linkB.ensureCore()).ok, true);
  // 桥 A（replacer 等价物）：注入更高目标版本 → 真核受理 replace → 广播 → 有序收尾退出
  const spawnA = spawnRecorder();
  const linkA = linkFor(home, spawnA.spawnFn, { targetAppVersion: '9.9.9', waitMs: 3000, slowRetryMs: 100 });
  t.after(() => linkA.close());
  assert.equal((await linkA.ensureCore()).ok, true);
  await waitFor(() => linkB.changeoverState().waiting === true, { timeoutMs: 8000 });
  await new Promise((resolve) => setTimeout(resolve, 250)); // 窗口内持续观察
  assert.equal(spawnB.calls.length, 0, '第二桥在换代窗口内不冷启（防与 replacer 争锁）');
  const during = await linkB.call('ws_status', {});
  assert.equal(during.kind, 'replacing');
  assert.equal(during.message, '核心换代中（约数秒），请重试；数据未丢');
});

test('换代·进程级④b：真核直连替换＝版本拒绝实证→真硬杀→真 spawn→台账判停（不循环）', { timeout: 30000 }, async (t) => {
  const home = makeTempDir(t);
  const old = await spawnRealCore(t, home);
  const spawned = [];
  const spawnFn = (command, args, options) => {
    const child = spawn(command, args, options);
    spawned.push(child);
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    });
    return child;
  };
  // 桥的 ipcV 注入为 2（＞真核的 1）：真核回 welcome{ok:false,code:'version',v:1}——拒绝帧携 v 的端到端面
  const link = linkFor(home, spawnFn, { ipcV: 2, targetAppVersion: '0.1.0', waitMs: 1500, slowRetryMs: 200, changeoverSettleMs: 50 });
  t.after(() => link.close());
  const outcome = await link.ensureCore();
  assert.equal(outcome.kind, 'replacing', '核心 ipcV 更低 → 直连替换（在途调用立即回报，不自动重试）');
  // 真硬杀：判别器「版本拒绝实证」相放行 → stop-guard 真信号路径。
  // 旧核本在该路径上只会被杀死（无自退理由）——进程终止即硬杀生效；Windows 的信号呈现在退出码面
  await waitFor(() => old.child.exitCode !== null || old.child.signalCode !== null, { timeoutMs: 10000 });
  assert.ok(old.child.exitCode !== null || old.child.signalCode !== null, '旧核经硬杀防护链终止');
  // 判别力主断言＝判停通知（自激实现下「恰一次 spawn」会被轮询窗口瞬态满足——故先等判停、再数稳定态）
  await waitFor(() => (link.changeoverState().notice ?? '').includes('ipcV'), { timeoutMs: 15000 });
  assert.equal(spawned.length, 1, '判停后稳定态：恰真 spawn 一次（不再 kill/spawn）');
  assert.equal(link.changeoverState().ledger.stopped, true, '台账判停（连续两轮预算/闭环）');
});
