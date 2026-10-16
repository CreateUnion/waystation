import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCoreRoot, startCore } from '../src/core/main.js';
import { createIpcClient } from '../src/core/ipc.js';
import { ANCHOR_PORT } from '../src/site.js';
import { makeTempDir, pickFreePort, repoRoot, waitFor, waitForRebindable } from './helpers.js';

const CORE_ENTRY = join(repoRoot, 'bin', 'waystation-core.js');
const CORE_FILE = join('run', 'core.json');
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/* 工具名清单（注册面冻结口径）：与既有会话组合根注册的 21 个工具逐字一致——核心持有注册表，
 * 本用例把「21 个 handler 全数注册」钉成断言。 */
const TOOL_NAMES = ['ws_status', 'ws_list_hosts', 'ws_ping', 'ws_delivery_status', 'ws_check_inbox', 'ws_list_collabs', 'ws_create_collab', 'ws_approve_invite', 'ws_withdraw_invite', 'ws_view_ledger', 'ws_send_message', 'ws_set_mute', 'ws_leave_collab', 'ws_end_collab', 'ws_invite', 'ws_request_join', 'ws_join', 'ws_approve_join', 'ws_decide', 'ws_handover', 'ws_take_over'];
const PORT_SETUP_ATTEMPTS = 3;

/* 核心进程收尾（与 server.test.js 同一模式）：收尾钩子必须先于 makeTempDir 的删除钩子注册——
 * 存活核心的并发写盘与目录删除在 Windows 下相撞会抛错，而钩子抛出会跳过其后全部钩子，
 * 泄漏的子进程会拖住整轮测试永不退出。 */
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

/* 杀灭并等进程真正退出：kill 只投递信号——不等退出会让兜底断言在「正在死」的进程上误报。 */
async function killChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
}

// 核心数据根：收尾钩子先于 makeTempDir 的删除钩子注册（见上）
function makeCoreHome(t) {
  cleanupOf(t);
  return makeTempDir(t);
}

/* 文件级兜底：收尾钩子被跳过会留下未关闭的核心进程——强制杀灭并响亮失败（与 server.test.js 同口径）。 */
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

/* 测试配置面：观察窗不拉起、网络预算取小值；端口由各用例显式给出（单根语义下测试根必须显式配端口）。
 * NODE_TEST_CONTEXT 随 spawn 显式传递——跨进程注入缝的生效闸（测试数值只在该闸下被读取）。 */
function writeCoreConfig(home, extra = {}) {
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({ scanWindowMs: 300, dialTimeoutMs: 1500, probeTimeoutMs: 300, viewerAutoOpen: false, ...extra }),
  );
}

function spawnCore(t, home, extraEnv = {}, cwd = repoRoot) {
  const cleanup = cleanupOf(t);
  const child = spawn(process.execPath, [CORE_ENTRY], {
    cwd,
    env: { ...process.env, NODE_TEST_CONTEXT: 'core-startup-test', WAYSTATION_HOME: home, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  cleanup.children.push(child);
  allChildren.push(child);
  const streams = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk) => {
    streams.stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    streams.stderr += chunk;
  });
  return { child, streams };
}

function readCoreJson(home) {
  return JSON.parse(readFileSync(join(home, CORE_FILE), 'utf8'));
}

/* 就绪判据：运行描述符出现且状态为 ready（原子替换下读取偶尔撞上半写文件——按未就绪重试）。 */
async function waitCoreReady(home, timeoutMs = 15000) {
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
    const timer = setTimeout(() => {
      resolve(null);
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

/* 进程内起核（spawn 之外的第二支证据面：直接驱动启动函数，验证句柄与正常退出）。
 * 探测取端口与实际绑定存在竞态窗口：被环境抢占即降级——守卫式重试换端口重取（确定性缺陷照常暴露）。
 * 成功即把 stop 挂进收尾（先停核、后删目录；重复 stop 幂等）。 */
async function startCoreReady(t, prepare) {
  for (let attempt = 0; attempt < PORT_SETUP_ATTEMPTS; attempt++) {
    const result = await startCore(await prepare(attempt));
    if (!result.ok) {
      throw new Error(`核心启动被拒：${result.message}`);
    }
    if (result.core.net.status().available) {
      cleanupOf(t).stops.push(() => result.core.stop());
      return result;
    }
    await result.core.stop();
  }
  throw new Error(`核心连续 ${PORT_SETUP_ATTEMPTS} 次未能监听选中端口（疑似确定性缺陷）`);
}

// 进程内用例的环境面：显式根走 WAYSTATION_HOME；测试进程带 NODE_TEST_CONTEXT（注入缝生效闸）
function coreEnv(home) {
  return { ...process.env, WAYSTATION_HOME: home };
}

/* 运行描述符的整体形态断言（就绪时）：字段齐全、时间戳自洽、端点按平台派生。 */
function assertReadyRecord(record, { home, port, pid }) {
  assert.equal(record.status, 'ready');
  assert.ok(Number.isInteger(record.v) && record.v >= 1, `v 应为文件形态版本：${record.v}`);
  assert.ok(Number.isInteger(record.ipcV) && record.ipcV >= 1, `ipcV 应为帧协议版本：${record.ipcV}`);
  assert.equal(record.appVersion, JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version);
  assert.equal(record.pid, pid);
  assert.equal(record.port, port);
  assert.ok(typeof record.token === 'string' && record.token.length >= 16, 'token 应为非空凭据串');
  assert.match(record.identity.instanceId, UUID_PATTERN);
  assert.ok(record.identity.identityName.length > 0, '身份名应为非空串');
  assert.ok(!Number.isNaN(Date.parse(record.startedAt)), 'startedAt 应为 ISO 时间');
  assert.equal(Date.parse(record.startupDeadline) - Date.parse(record.startedAt), 15000, '启动截止期＝startedAt+15s');
  if (process.platform === 'win32') {
    assert.match(record.endpoint, /^\\\\\.\\pipe\\waystation-[0-9a-f]{8}$/, 'Windows 端点为根摘要派生的管道名');
  } else {
    assert.equal(record.endpoint, join(home, 'run', 'core.sock'), 'POSIX 端点为数据根内的套接字文件');
  }
}

test('核心启动到 ready：core.json 字段齐全＋心跳周期刷新（显式根＋高位端口 spawn）', { timeout: 30000 }, async (t) => {
  const home = makeCoreHome(t);
  const port = await pickFreePort();
  writeCoreConfig(home, { port });
  // 工作目录取系统临时目录：入口与端点解析只依模块位置，不依赖 CWD（桥以 detached spawn 起核）
  const { child } = spawnCore(t, home, { WAYSTATION_TEST_HEARTBEAT_MS: '200' }, tmpdir());
  const record = await waitCoreReady(home);
  assertReadyRecord(record, { home, port, pid: child.pid });
  assert.equal(child.exitCode, null, '就绪后核心应存活（无宽限退出语义前的稳定态）');
  const firstHeartbeat = record.heartbeatAt;
  await waitFor(() => {
    try {
      return Date.parse(readCoreJson(home).heartbeatAt) > Date.parse(firstHeartbeat);
    } catch {
      return false;
    }
  }, { timeoutMs: 5000 });
});

test('单根解析：主根未显式 port 取锚点（含注入缝生效闸与显式值优先）', async (t) => {
  const mainRoot = makeCoreHome(t);
  const seam = { NODE_TEST_CONTEXT: 'core-startup-test', WAYSTATION_TEST_ANCHOR_PORT: '19001' };
  // 未开闸：内建锚点；「主根（默认路径）」由伪造默认根指向临时目录——不碰真实 ~/.waystation
  assert.deepEqual(resolveCoreRoot({ env: {}, mainDir: mainRoot }), { ok: true, dataDir: mainRoot, port: ANCHOR_PORT, portSource: 'anchor' });
  // 开闸：注入锚点生效（锚点值经 env 缝可覆写）
  assert.equal(resolveCoreRoot({ env: seam, mainDir: mainRoot }).port, 19001);
  // 非法/越界注入值按未注入处理（回落内建锚点）
  assert.equal(resolveCoreRoot({ env: { NODE_TEST_CONTEXT: 'x', WAYSTATION_TEST_ANCHOR_PORT: 'abc' }, mainDir: mainRoot }).port, ANCHOR_PORT);
  assert.equal(resolveCoreRoot({ env: { NODE_TEST_CONTEXT: 'x', WAYSTATION_TEST_ANCHOR_PORT: '0' }, mainDir: mainRoot }).port, ANCHOR_PORT);
  // 显式 port 以显式值为准（注入锚点不覆盖显式配置）
  writeCoreConfig(mainRoot, { port: 19002 });
  assert.deepEqual(resolveCoreRoot({ env: seam, mainDir: mainRoot }), { ok: true, dataDir: mainRoot, port: 19002, portSource: 'config' });
});

test('单根解析：显式根未显式 port 拒绝启动（不静默取端口）', async (t) => {
  const root = makeCoreHome(t);
  const refusal = resolveCoreRoot({ env: { WAYSTATION_HOME: root } });
  assert.equal(refusal.ok, false);
  assert.ok(refusal.message.includes('拒绝启动'), refusal.message);
  assert.ok(refusal.message.includes('port'), refusal.message);
  // 开闸注入锚点也不改结论：显式根不静默取端口
  assert.equal(resolveCoreRoot({ env: { WAYSTATION_HOME: root, NODE_TEST_CONTEXT: 'x', WAYSTATION_TEST_ANCHOR_PORT: '19003' } }).ok, false);
  // 显式根显式配 port：以显式值为准
  writeCoreConfig(root, { port: 19004 });
  assert.deepEqual(resolveCoreRoot({ env: { WAYSTATION_HOME: root } }), { ok: true, dataDir: root, port: 19004, portSource: 'config' });
  // 损坏 / 非法的 port 一律按未配置处理：显式根同样拒绝（不兜底、不猜值）
  writeFileSync(join(root, 'config.json'), '{ not json');
  assert.equal(resolveCoreRoot({ env: { WAYSTATION_HOME: root } }).ok, false);
  writeCoreConfig(root, { port: 70000 });
  assert.equal(resolveCoreRoot({ env: { WAYSTATION_HOME: root } }).ok, false);
});

test('显式根未配端口：进程拒绝启动＋指引（不落盘、不静默取端口）', { timeout: 30000 }, (t) => {
  const home = makeCoreHome(t);
  const run = spawnSync(process.execPath, [CORE_ENTRY], {
    cwd: repoRoot,
    env: { ...process.env, NODE_TEST_CONTEXT: 'core-startup-test', WAYSTATION_HOME: home },
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(run.status, 1);
  assert.ok(run.stderr.includes('拒绝启动'), `stderr 应含拒绝指引，实际：${run.stderr}`);
  assert.ok(run.stderr.includes('port'), `stderr 应指向 port 配置，实际：${run.stderr}`);
  assert.equal(run.stdout, '');
  assert.equal(existsSync(join(home, CORE_FILE)), false, '拒绝启动不得落盘运行描述符');
});

test('启动自检失败：原因写入 core.json 的 startupError＋退出码 1', { timeout: 30000 }, async (t) => {
  const home = makeCoreHome(t);
  const blocker = join(home, 'blocker.txt');
  writeFileSync(blocker, 'not a directory\n');
  writeCoreConfig(home, { port: await pickFreePort(), logDir: join(blocker, 'logs') });
  const { child, streams } = spawnCore(t, home);
  const exited = await waitExit(child, 20000);
  assert.notEqual(exited, null, `自检失败后进程未退出；stderr：${streams.stderr}`);
  assert.equal(exited.code, 1);
  assert.ok(streams.stderr.includes('拒绝服务'), `stderr 应含拒绝服务，实际：${streams.stderr}`);
  const record = readCoreJson(home);
  assert.equal(record.status, 'starting', '失败发生在就绪之前：文件保留启动态供桥读原因');
  assert.ok(String(record.startupError).includes('日志目录'), `startupError 应含失败原因，实际：${record.startupError}`);
  assert.equal(record.pid, child.pid);
});

test('启动自检失败（进程内）：协作目录不可用 → 拒绝服务＋startupError 留痕', { timeout: 30000 }, async (t) => {
  const home = makeCoreHome(t);
  writeCoreConfig(home, { port: await pickFreePort() });
  writeFileSync(join(home, 'collabs'), 'not a directory\n');
  const result = await startCore({ env: coreEnv(home) });
  assert.equal(result.ok, false, '协作目录不可用应拒绝启动');
  assert.ok(result.message.includes('协作目录不可用'), result.message);
  assert.ok(String(readCoreJson(home).startupError).includes('协作目录不可用'), '原因须留在运行描述符');
});

/* 无关程序占位：TCP 先手监听选中端口（listen 撞 EADDRINUSE ＝ 被环境抢先，换端口重试）。 */
async function holdPortWithUnrelatedServer(t) {
  for (let attempt = 0; attempt < PORT_SETUP_ATTEMPTS; attempt++) {
    const port = await pickFreePort();
    const held = new Set();
    const occupier = createServer((socket) => {
      held.add(socket);
      socket.on('close', () => held.delete(socket));
    });
    const bound = await new Promise((resolve) => {
      occupier.once('error', () => resolve(false));
      occupier.listen({ port, host: '0.0.0.0' }, () => resolve(true));
    });
    if (!bound) {
      continue;
    }
    t.after(async () => {
      for (const socket of held) {
        socket.destroy();
      }
      await new Promise((resolve) => occupier.close(resolve));
    });
    return port;
  }
  throw new Error(`占位 server 连续 ${PORT_SETUP_ATTEMPTS} 次未能监听选中端口（疑似确定性缺陷）`);
}

test('LAN 降级：端口被无关程序占 → 照常 ready＋降级态记录（完整循环另验）', { timeout: 30000 }, async (t) => {
  const home = makeCoreHome(t);
  const port = await holdPortWithUnrelatedServer(t);
  writeCoreConfig(home, { port });
  const { child } = spawnCore(t, home);
  const record = await waitCoreReady(home);
  assert.equal(record.status, 'ready', 'LAN 降级不阻断本地服务面');
  assert.ok(String(record.statusDetail).includes(String(port)), `降级态应含占用端口：${record.statusDetail}`);
  assert.ok(String(record.statusDetail).includes('占用'), `降级态应说明占用：${record.statusDetail}`);
  assert.equal(child.exitCode, null);
});

test('LAN 降级（进程内）：就绪照常、服务句柄呈现 net 不可用', { timeout: 30000 }, async (t) => {
  const home = makeCoreHome(t);
  const port = await holdPortWithUnrelatedServer(t);
  writeCoreConfig(home, { port });
  const result = await startCore({ env: coreEnv(home) });
  assert.equal(result.ok, true);
  cleanupOf(t).stops.push(() => result.core.stop());
  const net = result.core.net.status();
  assert.equal(net.available, false, 'LAN 降级：网络面不可用');
  assert.equal(net.port, port);
  assert.ok(net.message.includes('占用'), net.message);
  assert.equal(readCoreJson(home).status, 'ready', '降级不改变就绪结论（本地工具照常）');
});

/* 取锁仲裁接线后的口径（生命周期层四分支协议）：既有核心 ready 且端点反证可连＝已有核心在服务，
 * 第二核心让位退出 0（原「不清理不抢占即退出 1」为仲裁落地前的过渡语义）。 */
test('已有核心锁：第二进程不清理不抢占（已有核心在服务：让位退出 0）', { timeout: 30000 }, async (t) => {
  const home = makeCoreHome(t);
  writeCoreConfig(home, { port: await pickFreePort() });
  spawnCore(t, home);
  const record = await waitCoreReady(home);
  const second = spawnSync(process.execPath, [CORE_ENTRY], {
    cwd: repoRoot,
    env: { ...process.env, NODE_TEST_CONTEXT: 'core-startup-test', WAYSTATION_HOME: home },
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(second.status, 0, '已有核心在服务（pid 活、端点可连）：让位退出 0');
  assert.ok(second.stderr.includes('不清理'), `stderr 应说明不抢占锁，实际：${second.stderr}`);
  const after = readCoreJson(home);
  assert.equal(after.token, record.token, '既有锁不得被第二进程触碰');
  assert.equal(after.startedAt, record.startedAt);
});

test('core.json 创建与正常退出删除（进程内）＋令牌轮换＋失锁不删', { timeout: 30000 }, async (t) => {
  const home = makeCoreHome(t);
  const prepare = async () => {
    const port = await pickFreePort();
    writeCoreConfig(home, { port });
    return { env: { ...coreEnv(home), WAYSTATION_TEST_HEARTBEAT_MS: '200' } };
  };
  const first = await startCoreReady(t, prepare);
  const corePath = join(home, CORE_FILE);
  assertReadyRecord(readCoreJson(home), { home, port: first.core.port, pid: process.pid });
  assert.deepEqual(first.core.registry.list().map((tool) => tool.name), TOOL_NAMES, '21 个处理器全数注册');
  const firstHeartbeat = readCoreJson(home).heartbeatAt;
  await waitFor(() => Date.parse(readCoreJson(home).heartbeatAt) > Date.parse(firstHeartbeat), { timeoutMs: 5000 });
  const firstToken = readCoreJson(home).token;
  await first.core.stop();
  assert.equal(existsSync(corePath), false, '正常退出须删除运行描述符');
  await waitForRebindable(first.core.port);
  const second = await startCoreReady(t, prepare);
  assert.notEqual(readCoreJson(home).token, firstToken, 'token 每次核心启动轮换');
  // 失锁对证：运行描述符被继任者重写（startedAt 变化）→ 收尾不删它（防删掉继任者的锁）
  writeFileSync(corePath, JSON.stringify({ ...readCoreJson(home), startedAt: new Date(Date.now() + 1000).toISOString() }) + '\n');
  await second.core.stop();
  assert.equal(existsSync(corePath), true, '锁非自己所有时不得删除');
  assert.ok(readFileSync(join(home, 'logs', 'waystation.log'), 'utf8').includes('保留不删'), '失锁保留应留痕');
  rmSync(corePath, { force: true });
});

test('主根分支启动：未显式 port 取注入锚点、锚点不写入配置（进程内）', { timeout: 30000 }, async (t) => {
  const mainRoot = makeCoreHome(t);
  // 预写配置（无 port ＋ 一个非法字段）：一并验证「非法字段告警回落、不阻断启动」
  writeCoreConfig(mainRoot, { scanWindowMs: 5 });
  let anchor = 0;
  const prepare = async () => {
    anchor = await pickFreePort();
    const env = { ...process.env, NODE_TEST_CONTEXT: 'core-startup-test', WAYSTATION_TEST_ANCHOR_PORT: String(anchor) };
    delete env.WAYSTATION_HOME;   // 伪造默认根（mainDir 注入）＝主根分支；不碰真实 ~/.waystation
    return { env, mainDir: mainRoot };
  };
  const result = await startCoreReady(t, prepare);
  assert.equal(result.core.port, anchor, '未显式 port 取注入锚点');
  assertReadyRecord(readCoreJson(mainRoot), { home: mainRoot, port: anchor, pid: process.pid });
  const saved = JSON.parse(readFileSync(join(mainRoot, 'config.json'), 'utf8'));
  assert.equal(Object.hasOwn(saved, 'port'), false, '锚点属缺省语义：不得写进配置文件变成显式固定');
  assert.equal(saved.scanWindowMs, 2000, '非法字段告警后回落默认值（启动照常）');
  assert.ok(saved.identityName.length > 0, '首跑应落盘生效身份名');
  assert.equal(readCoreJson(mainRoot).identity.identityName, saved.identityName);
});

/* —— 换代受理（replace 仲裁接线＋shutting-down 窗口＋有序收尾；进程级） —— */

/* 换代桥（原始 IPC 客户端）：只做握手/发帧/收帧——服务端面走生产代码，桥侧件不参与。 */
async function connectBridge(t, home, token, bridgeId) {
  const frames = [];
  const client = createIpcClient({
    dataDir: home,
    hello: { app: '0.1.0', token, bridgeId },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    onFrame: (frame) => frames.push(frame),
  });
  t.after(() => client.close());
  await client.connect();
  return { client, frames };
}

test('换代受理（进程级）：首个 replace → 广播 core-restarting → 有序收尾（退出 0＋core.json 删）', { timeout: 30000 }, async (t) => {
  const home = makeCoreHome(t);
  const port = await pickFreePort();
  writeCoreConfig(home, { port });
  // 收尾前留 300ms 观察窗（测试缝）：广播可被稳定观察；生产恒 0
  const { child } = spawnCore(t, home, { WAYSTATION_TEST_CHANGEOVER_DELAY_MS: '300' }, tmpdir());
  const record = await waitCoreReady(home);
  const { client, frames } = await connectBridge(t, home, record.token, 'bridge-replacer-x');
  assert.equal(client.send({ type: 'replace', reason: 'version-mismatch', wantApp: '0.1.0' }), true);
  const broadcast = await waitFor(() => frames.find((frame) => frame.type === 'core-restarting'), { timeoutMs: 5000 });
  assert.equal(broadcast.replacerBridgeId, 'bridge-replacer-x', '广播带发起桥标识（其余桥据此进等待态）');
  assert.equal(broadcast.reason, 'version-mismatch');
  assert.equal(broadcast.targetApp, '0.1.0');
  assert.equal(broadcast.deadlineMs, 10000, 'deadlineMs＝replacer 释放窗口（设计 §5.2 步 2）');
  const exited = await waitExit(child);
  assert.deepEqual(exited, { code: 0, signal: null }, '换代＝有序收尾后退出 0（重启由 replacer 桥负责）');
  assert.equal(existsSync(join(home, CORE_FILE)), false, 'core.json 已删（桥按缺失/超时判陈旧）');
});

test('换代窗口（进程级）：并发第二个 replace 回 replacing；新握手同拒（客户端侧不注册）', { timeout: 30000 }, async (t) => {
  const home = makeCoreHome(t);
  const port = await pickFreePort();
  writeCoreConfig(home, { port });
  const { child } = spawnCore(t, home, { WAYSTATION_TEST_CHANGEOVER_DELAY_MS: '1500' }, tmpdir());
  const record = await waitCoreReady(home);
  const first = await connectBridge(t, home, record.token, 'bridge-replacer-a');
  const second = await connectBridge(t, home, record.token, 'bridge-second-b');
  assert.equal(first.client.send({ type: 'replace', reason: 'version-mismatch', wantApp: '0.1.0' }), true);
  await waitFor(() => first.frames.some((frame) => frame.type === 'core-restarting'), { timeoutMs: 5000 });

  // 并发换代：第二桥的 replace 不再受理，回 welcome{ok:false,code:'replacing'}（拒绝帧形态＝T8 裁定①）
  assert.equal(second.client.send({ type: 'replace', reason: 'version-mismatch', wantApp: '0.1.0' }), true);
  const refusal = await waitFor(() => second.frames.find((frame) => frame.type === 'welcome'), { timeoutMs: 5000 });
  assert.equal(refusal.ok, false);
  assert.equal(refusal.code, 'replacing');

  // 窗口期新连接握手同样被拒（welcomeOf 先查换代席）；注：服务端先走注册事件再发拒绝帧，
  // 客户端侧不注册——迟到桥的会话文件/观察窗记账副作用见报告 §13.6-M-A2
  const late = createIpcClient({
    dataDir: home,
    hello: { app: '0.1.0', token: record.token, bridgeId: 'bridge-late-c' },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  t.after(() => late.close());
  await assert.rejects(late.connect(), (error) => error.code === 'replacing');
  const exited = await waitExit(child);
  assert.deepEqual(exited, { code: 0, signal: null });
});
