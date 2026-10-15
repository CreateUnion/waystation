import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { IPC_VERSION, createIpcServer, endpointFor } from '../src/core/ipc.js';
import { coreJsonPath } from '../src/paths.js';
import { parseCoreArgs, readCoreStatus, runCoreCli, stopCore } from '../src/core-cli.js';
import { makeTempDir, repoRoot } from './helpers.js';

/* `waystation core status|stop` 的判别测试（CLI 契约面）：全部临时根＋桩 core.json，绝不触碰真实
 * ~/.waystation、不占用站点端口段。正常停止路径起桩 IPC 服务端做真端点往返（断言帧与退出判定）；
 * 硬杀分支注入防护链桩——共享件（src/core/stop-guard.js）由独立任务交付，本文件只验消费契约：
 * 调用参数（coreJsonPath/endpoint/pid/startedAt/allowOnce）与结论枚举到文案/退出码的映射。
 * CLI 输出经 write 注入缝取回（改全局 stdout 会把测试运行器自身的输出截进捕获缓冲）。 */

const BIN_ENTRY = join(repoRoot, 'bin', 'waystation.js');
const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';

function silentLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

/* 收尾钩子先于 makeTempDir 的删除钩子注册（node:test 按注册序执行）：先关服务、后删目录，
 * 避免 Windows 下删除撞上存活句柄。 */
function cleanupOf(t) {
  const fns = [];
  t.after(async () => {
    for (const fn of fns) {
      try {
        await fn();
      } catch {
        // 已关闭/已释放：重复收尾不影响断言面
      }
    }
  });
  return (fn) => fns.push(fn);
}

/* 运行描述符夹具：字段面与核心侧 createCoreRecord 同形（pid 取本进程＝「活核」；心跳新鲜）。 */
function coreRecordOf(home, overrides = {}) {
  const startedAt = new Date(Date.now() - 1000).toISOString();
  return {
    v: 1,
    ipcV: IPC_VERSION,
    appVersion: '0.1.0',
    pid: process.pid,
    endpoint: endpointFor(home),
    token: TOKEN,
    identity: { instanceId: 'inst-stop', identityName: 'tester' },
    port: 19000,
    startedAt,
    status: 'ready',
    startupDeadline: new Date(Date.parse(startedAt) + 15000).toISOString(),
    heartbeatAt: new Date().toISOString(),
    ...overrides,
  };
}

function writeCoreJson(home, overrides = {}) {
  mkdirSync(join(home, 'run'), { recursive: true });
  const record = coreRecordOf(home, overrides);
  writeFileSync(coreJsonPath(home), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/* 桩核心：真 IPC 服务端（端点/认证/帧校验全走生产件）；缺省 onReplace 删运行描述符模拟
 * 「收下停止请求并有序退出」，可注入为「收下但不退出」（换一条出口等待超时路径）。 */
async function startStubCore(cleanup, home, { token = TOKEN, onReplace } = {}) {
  const replaces = [];
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
      identity: { instanceId: 'inst-stop', identityName: 'tester' },
      port: 19000,
      net: { available: true, degraded: false },
      persistent: false,
      bridges,
    }),
    onFrame: (frame) => {
      if (frame.type !== 'replace') {
        return;
      }
      replaces.push(frame);
      (onReplace ?? (() => rmSync(coreJsonPath(home), { force: true })))();
    },
    log: silentLog(),
  });
  cleanup(() => server.close());
  await server.start();
  return { server, replaces };
}

/* 记录型防护链桩：按构造结论应答，留全部入参供断言（消费契约面）。 */
function recordingGuard(result = 'killed') {
  const calls = [];
  const killGuarded = async (request) => {
    calls.push(request);
    return result;
  };
  return { calls, killGuarded };
}

/* CLI 调用＋输出捕获：经 write 注入缝，不动全局 stdout。 */
async function runCli(argv, options = {}) {
  const lines = [];
  const code = await runCoreCli({ argv, ...options, write: (text) => lines.push(text) });
  return { code, output: lines.join('\n') };
}

/* 停止出口等待的短值注入缝（生效闸 NODE_TEST_CONTEXT 由模块内 testNumber 统一把关）。 */
function fastStopEnv(home) {
  return {
    WAYSTATION_HOME: home,
    NODE_TEST_CONTEXT: 'core-cli-test',
    WAYSTATION_TEST_CORE_STOP_EXIT_MS: '300',
    WAYSTATION_TEST_CORE_STOP_POLL_MS: '50',
  };
}

/* 测试自起的空转假进程（绝不指向真实驿站进程）：给防护链接真用例提供可杀/可保的「核心 pid」。 */
function spawnDummyCore(cleanup) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  cleanup(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
  });
  return child;
}

async function waitExit(child) {
  if (child.exitCode === null && child.signalCode === null) {
    await once(child, 'exit');
  }
}

test('参数解析：子命令 / --force / 帮助 / 未知参数收集', () => {
  assert.deepEqual(parseCoreArgs(['status']), { command: 'status', force: false, help: false, unknown: [] });
  assert.deepEqual(parseCoreArgs(['stop', '--force']), { command: 'stop', force: true, help: false, unknown: [] });
  assert.equal(parseCoreArgs(['--help']).help, true);
  assert.deepEqual(parseCoreArgs(['stop', 'extra']).unknown, ['extra']);
  assert.deepEqual(parseCoreArgs(['frobnicate']).unknown, ['frobnicate']);
});

test('core：缺子命令 → 用法＋退出 1；--help → 退出 0 且列出两个子命令', async () => {
  const empty = await runCli([]);
  assert.equal(empty.code, 1);
  assert.ok(empty.output.includes('core status') && empty.output.includes('core stop'), empty.output);
  const help = await runCli(['--help']);
  assert.equal(help.code, 0);
  assert.ok(help.output.includes('core stop --force'), help.output);
  const bogus = await runCli(['stop', '--bogus']);
  assert.equal(bogus.code, 1);
  assert.ok(bogus.output.includes('未知参数：--bogus'), bogus.output);
  const statusForce = await runCli(['status', '--force']);
  assert.equal(statusForce.code, 1);
  assert.ok(statusForce.output.includes('--force 只适用于 core stop'), statusForce.output);
});

test('core status：未运行与健康两形态（心跳新鲜、含 pid/端口/心跳行）', async (t) => {
  const home = makeTempDir(t);
  const absent = await runCli(['status'], { env: { WAYSTATION_HOME: home } });
  assert.equal(absent.code, 0, absent.output);
  assert.ok(absent.output.includes('核心：未运行'), absent.output);
  assert.equal(readCoreStatus({ env: { WAYSTATION_HOME: home } }).kind, 'absent');

  const record = writeCoreJson(home, { status: 'ready' });
  const healthy = await runCli(['status'], { env: { WAYSTATION_HOME: home } });
  assert.equal(healthy.code, 0, healthy.output);
  assert.ok(healthy.output.includes('核心：运行中（status=ready）'), healthy.output);
  assert.ok(healthy.output.includes(`  pid：${record.pid}`), healthy.output);
  assert.ok(healthy.output.includes('  端口：19000'), healthy.output);
  assert.ok(healthy.output.includes('  心跳：'), healthy.output);
  assert.ok(healthy.output.includes(`  版本：0.1.0（IPC v${IPC_VERSION}）`), healthy.output);
  assert.equal(readCoreStatus({ env: { WAYSTATION_HOME: home } }).kind, 'healthy');
});

test('core status：等待接管（waiting）如实呈现 statusDetail、退出 0', async (t) => {
  const home = makeTempDir(t);
  const detail = '检测到同根旧版会话运行中（pid 4242），请先关闭它；关闭后自动接管';
  writeCoreJson(home, { status: 'waiting', statusDetail: detail });
  const { code, output } = await runCli(['status'], { env: { WAYSTATION_HOME: home } });
  assert.equal(code, 0, output);
  assert.ok(output.includes('核心：等待接管'), output);
  assert.ok(output.includes(detail), output);
  assert.equal(readCoreStatus({ env: { WAYSTATION_HOME: home } }).kind, 'healthy', '心跳新鲜等待核属活核');
});

test('core status：僵尸 / 残留描述符 / 不可解析三异常形态 → 退出 1', async (t) => {
  const zombieHome = makeTempDir(t);
  writeCoreJson(zombieHome, { status: 'ready', heartbeatAt: new Date(Date.now() - 60000).toISOString() });
  const zombie = await runCli(['status'], { env: { WAYSTATION_HOME: zombieHome } });
  assert.equal(zombie.code, 1, zombie.output);
  assert.ok(zombie.output.includes('疑似僵尸'), zombie.output);
  assert.equal(readCoreStatus({ env: { WAYSTATION_HOME: zombieHome } }).kind, 'zombie');

  const staleHome = makeTempDir(t);
  writeCoreJson(staleHome, { pid: 2 ** 30 });
  const stale = await runCli(['status'], { env: { WAYSTATION_HOME: staleHome } });
  assert.equal(stale.code, 1, stale.output);
  assert.ok(stale.output.includes('残留运行描述符'), stale.output);
  assert.equal(readCoreStatus({ env: { WAYSTATION_HOME: staleHome } }).kind, 'stale');

  const brokenHome = makeTempDir(t);
  mkdirSync(join(brokenHome, 'run'), { recursive: true });
  writeFileSync(coreJsonPath(brokenHome), '{oops\n');
  const broken = await runCli(['status'], { env: { WAYSTATION_HOME: brokenHome } });
  assert.equal(broken.code, 1, broken.output);
  assert.ok(broken.output.includes('不可解析'), broken.output);
  assert.equal(readCoreStatus({ env: { WAYSTATION_HOME: brokenHome } }).kind, 'unreadable');

  /* 可解析但形态不合（缺对证字段）同样按不可解析处置：运行描述符不可用即不得猜。 */
  const shapeHome = makeTempDir(t);
  mkdirSync(join(shapeHome, 'run'), { recursive: true });
  writeFileSync(coreJsonPath(shapeHome), `${JSON.stringify({ pid: 1 })}\n`);
  const shape = await runCli(['status'], { env: { WAYSTATION_HOME: shapeHome } });
  assert.equal(shape.code, 1, shape.output);
  assert.equal(readCoreStatus({ env: { WAYSTATION_HOME: shapeHome } }).kind, 'unreadable');
  const shapeStop = await runCli(['stop'], { env: { WAYSTATION_HOME: shapeHome } });
  assert.equal(shapeStop.code, 1, shapeStop.output);
  assert.ok(shapeStop.output.includes('人工检查'), shapeStop.output);
});

test('core stop：无核心 / 残留描述符 → 退出 0、防护链不参与', async (t) => {
  const home = makeTempDir(t);
  const guard = recordingGuard();
  const absent = await runCli(['stop'], { env: { WAYSTATION_HOME: home }, killGuarded: guard.killGuarded });
  assert.equal(absent.code, 0, absent.output);
  assert.ok(absent.output.includes('无需停止'), absent.output);

  writeCoreJson(home, { pid: 2 ** 30 });
  const stale = await runCli(['stop'], { env: { WAYSTATION_HOME: home }, killGuarded: guard.killGuarded });
  assert.equal(stale.code, 0, stale.output);
  assert.ok(stale.output.includes('残留运行描述符'), stale.output);
  assert.equal(guard.calls.length, 0, '无活核路径不得触碰防护链');
});

test('core stop 正常路径：桩核心收到 replace{reason:manual} 并退出 → 退出 0、防护链未调用', async (t) => {
  const cleanup = cleanupOf(t);
  const home = makeTempDir(t);
  writeCoreJson(home, { status: 'ready' });
  const { replaces } = await startStubCore(cleanup, home);
  const guard = recordingGuard();
  const { code, output } = await runCli(['stop'], { env: { WAYSTATION_HOME: home }, killGuarded: guard.killGuarded });
  assert.equal(code, 0, output);
  assert.deepEqual(replaces.map((frame) => frame.reason), ['manual'], '停止通道＝replace 帧（reason=manual）');
  assert.ok(output.includes('已停止核心'), output);
  assert.ok(output.includes('经 IPC 有序退出'), output);
  assert.equal(existsSync(coreJsonPath(home)), false, '桩核心按停止请求清理了运行描述符');
  assert.equal(guard.calls.length, 0, '有序路径不得触碰防护链');
});

test('core stop 僵尸：端点不可达＋心跳超期 → 自动落防护链（allowOnce=false）、参数逐项对证', async (t) => {
  const home = makeTempDir(t);
  const record = writeCoreJson(home, { status: 'ready', heartbeatAt: new Date(Date.now() - 60000).toISOString() });
  const guard = recordingGuard('killed');
  const { code, output } = await runCli(['stop'], { env: { WAYSTATION_HOME: home }, killGuarded: guard.killGuarded });
  assert.equal(code, 0, output);
  assert.equal(guard.calls.length, 1);
  assert.deepEqual(guard.calls[0], {
    coreJsonPath: coreJsonPath(home),
    endpoint: record.endpoint,
    pid: record.pid,
    startedAt: record.startedAt,
    allowOnce: false,
  });
  assert.ok(output.includes('已终止核心'), output);
  assert.ok(output.includes('硬杀防护链'), output);
});

test('core stop：防护链结论映射——endpoint-gone 视为已停（0）；其余三拒绝结论退出 1 带指引', async (t) => {
  const home = makeTempDir(t);
  writeCoreJson(home, { heartbeatAt: new Date(Date.now() - 60000).toISOString() });
  const env = { WAYSTATION_HOME: home };
  const gone = recordingGuard('endpoint-gone');
  const goneRun = await runCli(['stop'], { env, killGuarded: gone.killGuarded });
  assert.equal(goneRun.code, 0, goneRun.output);
  assert.ok(goneRun.output.includes('端点已消失'), goneRun.output);

  const cases = [
    ['not-eligible', '判据不通过'],
    ['verification-failed', '复读校验'],
    ['already-once', '一次'],
  ];
  for (const [result, anchor] of cases) {
    const stub = recordingGuard(result);
    const run = await runCli(['stop', '--force'], { env, killGuarded: stub.killGuarded });
    assert.equal(run.code, 1, `${result}：${run.output}`);
    assert.ok(run.output.includes('未终止') && run.output.includes(anchor), `${result} 文案：${run.output}`);
    assert.ok(run.output.includes(`pid ${process.pid}`), '拒绝文案带 pid 供人工处置');
  }
  const broken = await runCli(['stop'], {
    env,
    killGuarded: async () => {
      throw new Error('共享件缺位');
    },
  });
  assert.equal(broken.code, 1, broken.output);
  assert.ok(broken.output.includes('未终止') && broken.output.includes('人工'), broken.output);
});

test('core stop：核心收下 replace 后进程消失（未清理运行描述符）→ 仍判已停止', async (t) => {
  const cleanup = cleanupOf(t);
  const home = makeTempDir(t);
  const victim = spawnDummyCore(cleanup);
  writeCoreJson(home, { pid: victim.pid, status: 'ready' });
  await startStubCore(cleanup, home, {
    onReplace: () => {
      victim.kill('SIGKILL');
    },
  });
  const guard = recordingGuard();
  const { code, output } = await runCli(['stop'], { env: fastStopEnv(home), killGuarded: guard.killGuarded });
  assert.equal(code, 0, output);
  assert.ok(output.includes('经 IPC 有序退出'), output);
  assert.equal(guard.calls.length, 0, 'pid 消失即判退场，不落防护链');
});

test('core stop --force：核心收下 replace 却不退出 → 出口等待超时后走防护链（allowOnce=true）；无 --force 亦自动落链（false）', async (t) => {
  const cleanup = cleanupOf(t);
  const home = makeTempDir(t);
  writeCoreJson(home, { status: 'ready' });
  const { replaces } = await startStubCore(cleanup, home, { onReplace: () => {} });
  const guard = recordingGuard('killed');
  const env = fastStopEnv(home);
  const forced = await runCli(['stop', '--force'], { env, killGuarded: guard.killGuarded });
  assert.equal(forced.code, 0, forced.output);
  assert.equal(guard.calls.length, 1);
  assert.equal(guard.calls[0].allowOnce, true, '--force 显式授权硬杀');
  const plain = await runCli(['stop'], { env, killGuarded: guard.killGuarded });
  assert.equal(plain.code, 0, plain.output);
  assert.equal(guard.calls.length, 2);
  assert.equal(guard.calls[1].allowOnce, false, '自动落链不带显式授权');
  assert.equal(replaces.length, 2, '两条路径都先经 IPC 尝试有序停止');
});

test('core stop waiting：无 --force 拒绝且不落防护链；--force 凭描述符对证走防护链（allowOnce=true）', async (t) => {
  const home = makeTempDir(t);
  writeCoreJson(home, { status: 'waiting', statusDetail: '同根旧版会话运行中' });
  const guard = recordingGuard('killed');
  const env = { WAYSTATION_HOME: home };
  const plain = await runCli(['stop'], { env, killGuarded: guard.killGuarded });
  assert.equal(plain.code, 1, plain.output);
  assert.ok(plain.output.includes('等待接管') && plain.output.includes('--force'), plain.output);
  assert.equal(guard.calls.length, 0, '未授权不得触碰防护链');
  assert.equal(existsSync(coreJsonPath(home)), true, '拒绝路径零动作');

  const forced = await runCli(['stop', '--force'], { env, killGuarded: guard.killGuarded });
  assert.equal(forced.code, 0, forced.output);
  assert.equal(guard.calls.length, 1);
  assert.equal(guard.calls[0].allowOnce, true);
});

test('stopCore：清数据面通道对等待核直接授权硬杀；一般调用返回 refused 结论文案', async (t) => {
  const home = makeTempDir(t);
  writeCoreJson(home, { status: 'waiting' });
  const guard = recordingGuard('killed');
  const env = { WAYSTATION_HOME: home };
  const refused = await stopCore({ env, killGuarded: guard.killGuarded });
  assert.equal(refused.outcome, 'refused');
  assert.equal(guard.calls.length, 0);
  const teardown = await stopCore({ env, allowForceOnWaiting: true, killGuarded: guard.killGuarded });
  assert.equal(teardown.outcome, 'stopped');
  assert.equal(guard.calls.length, 1);
  assert.equal(guard.calls[0].allowOnce, true);
});

test('core stop：认证失败（描述符 token 与核心不符）无 --force 拒绝不杀；--force 走防护链', async (t) => {
  const cleanup = cleanupOf(t);
  const home = makeTempDir(t);
  writeCoreJson(home, { token: 'wrong-token-0000000000' });
  await startStubCore(cleanup, home);
  const guard = recordingGuard('killed');
  const env = { WAYSTATION_HOME: home };
  const plain = await runCli(['stop'], { env, killGuarded: guard.killGuarded });
  assert.equal(plain.code, 1, plain.output);
  assert.ok(plain.output.includes('认证失败'), plain.output);
  assert.equal(guard.calls.length, 0, '认证失败未获授权不得杀');
  const forced = await runCli(['stop', '--force'], { env, killGuarded: guard.killGuarded });
  assert.equal(forced.code, 0, forced.output);
  assert.equal(guard.calls.length, 1);
  assert.equal(guard.calls[0].allowOnce, true);
});

test('core stop：停止期间描述符被换代重写 → 拒绝重试（退出 1、不落防护链）', async (t) => {
  const cleanup = cleanupOf(t);
  const home = makeTempDir(t);
  writeCoreJson(home, { status: 'ready' });
  await startStubCore(cleanup, home, {
    onReplace: () => {
      writeCoreJson(home, { status: 'ready', startedAt: new Date(Date.now() + 5000).toISOString() });
    },
  });
  const guard = recordingGuard();
  const env = fastStopEnv(home);
  const { code, output } = await runCli(['stop'], { env, killGuarded: guard.killGuarded });
  assert.equal(code, 1, output);
  assert.ok(output.includes('换代') && output.includes('重试'), output);
  assert.equal(guard.calls.length, 0);
});

test('接真防护链（共享件）：僵尸自动落链杀真进程 / 等待核 --force 同通道 / 心跳新鲜核不误杀', { timeout: 60000 }, async (t) => {
  const cleanup = cleanupOf(t);
  const home = makeTempDir(t);
  const env = { WAYSTATION_HOME: home };
  /* 僵尸：心跳停＋端点无监听 → 自动落链（allowOnce 缺省）→ 防护链杀真进程并确认端点消失。 */
  const zombie = spawnDummyCore(cleanup);
  writeCoreJson(home, { pid: zombie.pid, status: 'ready', heartbeatAt: new Date(Date.now() - 60000).toISOString() });
  const auto = await runCli(['stop'], { env });
  assert.equal(auto.code, 0, auto.output);
  assert.ok(auto.output.includes('已终止核心'), auto.output);
  await waitExit(zombie);
  assert.notEqual(zombie.exitCode ?? zombie.signalCode, null, '僵尸假进程应已被防护链终止');

  /* 等待核 --force：allowOnce 显式授权（不等心跳超期）→ 同通道终止。 */
  const waiter = spawnDummyCore(cleanup);
  writeCoreJson(home, { pid: waiter.pid, status: 'waiting', heartbeatAt: new Date().toISOString() });
  const forced = await runCli(['stop', '--force'], { env });
  assert.equal(forced.code, 0, forced.output);
  assert.ok(forced.output.includes('已终止核心'), forced.output);
  await waitExit(waiter);

  /* 心跳新鲜的活核（无 --force）：判别器不通过 → 不杀、降级上报，假进程必须活着（宁可不杀）。 */
  const keeper = spawnDummyCore(cleanup);
  writeCoreJson(home, { pid: keeper.pid, status: 'ready', heartbeatAt: new Date().toISOString() });
  const refused = await runCli(['stop'], { env: { WAYSTATION_HOME: home, NODE_TEST_CONTEXT: 'core-cli-test', WAYSTATION_TEST_CORE_STOP_EXIT_MS: '200' } });
  assert.equal(refused.code, 1, refused.output);
  assert.ok(refused.output.includes('未终止'), refused.output);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(keeper.exitCode, null, '心跳新鲜的活核不得被自动落链误杀');
});

test('进程级：bin 分派 core status|stop（无核心）→ 退出 0；core --help 与顶层帮助列出子命令', { timeout: 60000 }, (t) => {
  const home = makeTempDir(t);
  const env = { ...process.env, WAYSTATION_HOME: home };
  const run = (args) => spawnSync(process.execPath, [BIN_ENTRY, ...args], { cwd: repoRoot, env, encoding: 'utf8', timeout: 20000 });
  const status = run(['core', 'status']);
  assert.equal(status.status, 0, status.stderr);
  assert.ok(status.stdout.includes('核心：未运行'), status.stdout);
  const stop = run(['core', 'stop']);
  assert.equal(stop.status, 0, stop.stderr);
  assert.ok(stop.stdout.includes('无需停止'), stop.stdout);
  const help = run(['core', '--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.ok(help.stdout.includes('core stop --force'), help.stdout);
  const top = run(['--help']);
  assert.equal(top.status, 0, top.stderr);
  assert.ok(top.stderr.includes('core status'), '顶层帮助应列出 core 子命令');
  assert.ok(top.stderr.includes('purge-data'), '顶层帮助既有子命令不回归');
});
