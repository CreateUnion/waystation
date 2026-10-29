import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import dgram from 'node:dgram';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig } from '../src/config.js';
import { coreJsonPath } from '../src/paths.js';
import { makeTempDir, pickFreePort, repoRoot, waitFor, waitForRebindable } from './helpers.js';

const INDEX_ENTRY = join(repoRoot, 'src', 'index.js');
const BIN_ENTRY = join(repoRoot, 'bin', 'waystation.js');
const CORE_ENTRY = join(repoRoot, 'bin', 'waystation-core.js');
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/* 显式会话标识（ws_check_inbox 按会话过滤：无标识明确拒绝）；不依赖运行环境的
 * CLAUDE_CODE_SESSION_ID。 */
const CHECK_INBOX_SESSION_ID = 'session-server-check-inbox';

/* 站点收尾（单核形态）：node:test 的收尾钩子按注册序执行，而临时目录的删除钩子由 makeTempDir 在其
 * 调用点先行注册——「先关桥、再收核、后删目录」要求本收尾钩子抢在删除钩子之前注册（与
 * collab-e2e.test.js 同一模式），否则删除会与存活核心的并发写盘（sessions/、known-hosts.json、日志、
 * 心跳）相撞在 Windows 下抛错；而钩子一旦抛错，其后所有钩子（含站点关闭）全部被跳过——泄漏的子进程
 * 拖住测试进程永不退出，runner 会无限等待该文件（整轮运行冻结）。
 * 收核必须晚于「桥进程退出」：桥仍存活时杀核会触发桥督视重生（孤儿核心）。 */
const stationCleanupByTest = new WeakMap();

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

function stationCleanupOf(t) {
  let cleanup = stationCleanupByTest.get(t);
  if (cleanup === undefined) {
    cleanup = { clients: [], pids: [], homes: [] };
    stationCleanupByTest.set(t, cleanup);
    t.after(async () => {
      for (const client of cleanup.clients) {
        try {
          await client.close();
        } catch {
          // 用例中已显式关闭：忽略重复关闭
        }
      }
      for (const pid of cleanup.pids) {
        try {
          await waitFor(() => !isProcessAlive(pid), { timeoutMs: 8000, intervalMs: 50 });
        } catch {
          // 桥未按预期退场：下方强杀兜底
        }
        if (isProcessAlive(pid)) {
          process.kill(pid, 'SIGKILL');
        }
      }
      for (const home of cleanup.homes) {
        killCoreOf(home);
      }
    });
  }
  return cleanup;
}

/* 站点数据目录：收尾钩子先于 makeTempDir 的删除钩子注册（见上）；目录登记进本用例收尾（收核）。 */
function makeStationHome(t) {
  const cleanup = stationCleanupOf(t);
  const home = makeTempDir(t);
  cleanup.homes.push(home);
  return home;
}

/* 文件级兜底：任何收尾钩子被跳过（如钩子抛错）都会留下未关闭的站点进程——此处强制关闭并响亮失败，
 * 绝不让泄漏把整轮运行拖进永不退出的等待（正常路径所有站点已在用例收尾时关闭，兜底无事可做）。 */
const stationTransports = [];
const stationChildren = [];

after(async () => {
  const leakedPids = [];
  for (const transport of stationTransports) {
    if (transport.pid !== null) {
      leakedPids.push(transport.pid);
      try {
        await transport.close();
      } catch (error) {
        /* 兜底自身不得中断：close 抛错也要继续走到子进程强杀与响亮断言，
         * 否则恰在需要兜底的场景里恢复「静默泄漏」 */
        console.error(`[测试收尾] 兜底关闭站点失败：pid=${transport.pid}（${error.message}）`);
      }
    }
  }
  for (const child of stationChildren) {
    if (child.exitCode === null && child.signalCode === null) {
      leakedPids.push(child.pid);
      child.kill('SIGKILL');
    }
  }
  assert.equal(leakedPids.length, 0, `站点进程未被用例收尾（收尾钩子被跳过？）：${leakedPids.join(',')}——已兜底强制关闭，检查用例清理`);
});

// 用 SDK 官方 client 真实握手——能握手成功即同时证明 stdout 未被任何日志污染
// viewerAutoOpen：起站夹具统一关闭自动开窗（测试不拉起真实观察窗；配置驱动、任何运行器下成立）
// WAYSTATION_TEST_GRACE_MS：短宽限注入（NODE_TEST_CONTEXT 生效闸随 node --test 在场）——
// 会话关后核心按短宽限退场，测试收尾不再等满 60s；收核仍按 core.json pid 显式执行。
async function connectClient(t, entry, home, extraConfig = {}, sessionId = null) {
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({ scanWindowMs: 300, dialTimeoutMs: 1500, ...extraConfig, viewerAutoOpen: false }),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: repoRoot,
    env: {
      ...process.env,
      WAYSTATION_HOME: home,
      WAYSTATION_TEST_GRACE_MS: '1500',
      ...(sessionId === null ? {} : { CLAUDE_CODE_SESSION_ID: sessionId }),
    },
  });
  const client = new Client({ name: 'waystation-m2-test', version: '0.0.0' });
  const cleanup = stationCleanupOf(t);
  stationTransports.push(transport);
  cleanup.clients.push(client);   // 纳管先于 connect：启动中途失败的站点也收尾
  await client.connect(transport);
  cleanup.pids.push(transport.pid ?? null);
  return client;
}

async function fetchStatus(client) {
  const called = await client.callTool({ name: 'ws_status', arguments: {} });
  return JSON.parse(called.content[0].text);
}

// 就绪判据：TCP 拨入成功 = transport 已进入监听（正常监听态，排除降级）
async function waitPortListening(port) {
  await waitFor(() => new Promise((resolve) => {
    const probe = connect({ host: '127.0.0.1', port });
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => {
      probe.destroy();
      resolve(false);
    });
  }), { timeoutMs: 15000 });
}

// 等进程退出；超时返回 null（由调用方断言报错，避免测试挂起占用后续用例时间）
function waitProcessExit(child, timeoutMs) {
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

// 真探针：连接尝试的结果（true＝端口仍被某进程监听）——与「进程存活」代理互补的直接证据
function probeConnect(port) {
  return new Promise((resolve) => {
    const probe = connect({ host: '127.0.0.1', port });
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => {
      probe.destroy();
      resolve(false);
    });
  });
}

// 端口释尽核验：进程持有的两个监听口（TCP 帧通道 / UDP 发现）都能重新独占绑定
async function assertPortRebindable(port) {
  const tcp = createServer();
  await new Promise((resolve, reject) => {
    tcp.once('error', reject);
    tcp.listen({ port, host: '0.0.0.0' }, resolve);
  });
  await new Promise((resolve) => tcp.close(resolve));
  const udp = dgram.createSocket({ type: 'udp4', reuseAddr: false });
  await new Promise((resolve, reject) => {
    udp.once('error', reject);
    udp.bind({ port, address: '0.0.0.0', exclusive: true }, resolve);
  });
  await new Promise((resolve) => udp.close(resolve));
}

/* 探测取端口与实际绑定之间存在窗口（探测后即刻释放，环境流量可在此期间抢走该端口）：
 * 占用类用例的 setup 实行守卫式重试——起步即被环境抢占（站点降级 / 占位监听报错）时换端口重取；
 * 重试耗尽即判红（确定性缺陷照常暴露，守卫只吸收环境碰撞）。 */
const PORT_SETUP_ATTEMPTS = 3;

/* 端口占用一的前半段：起一个在显式端口上成功监听的站点（unavailable = 被环境抢占，换端口重试）。 */
async function startExplicitPortStation(t) {
  for (let attempt = 0; attempt < PORT_SETUP_ATTEMPTS; attempt++) {
    const port = await pickFreePort();
    const clientA = await connectClient(t, INDEX_ENTRY, makeStationHome(t), { port });
    if ((await fetchStatus(clientA)).net.available) {
      return { port, clientA };
    }
    await clientA.close();
  }
  throw new Error(`站点连续 ${PORT_SETUP_ATTEMPTS} 次未能监听选中端口（疑似确定性缺陷）`);
}

/* 端口占用二的前半段：占位 server 先手监听显式端口（listen 撞 EADDRINUSE = 被环境抢先，换端口重试）。 */
async function startPortOccupier(t) {
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

test('stdio 骨架：进程可起、ws_status 可调、网络层就绪、数据目录初始化（instance-id/logs/collabs）+ 预写配置读取生效', { timeout: 30000 }, async (t) => {
  const home = makeStationHome(t);
  const port = await pickFreePort();
  const client = await connectClient(t, INDEX_ENTRY, home, { port });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), ['ws_status', 'ws_list_hosts', 'ws_ping', 'ws_delivery_status', 'ws_check_inbox', 'ws_list_collabs', 'ws_create_collab', 'ws_approve_invite', 'ws_allow_next_invite', 'ws_set_confirm_gate', 'ws_dispatch_scan', 'ws_dispatch_claim', 'ws_dispatch_approve', 'ws_dispatch_release', 'ws_withdraw_invite', 'ws_view_ledger', 'ws_send_message', 'ws_set_mute', 'ws_leave_collab', 'ws_end_collab', 'ws_invite', 'ws_request_join', 'ws_join', 'ws_approve_join', 'ws_decide', 'ws_handover', 'ws_take_over']);
  const status = await fetchStatus(client);
  assert.equal(status.name, 'waystation');
  assert.equal(status.version, JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version, 'ws_status 版本与包版本一致');
  assert.match(status.instanceId, UUID_PATTERN);
  assert.ok(status.identityName.length > 0);
  assert.equal(status.dataDir, resolve(home));
  assert.equal(status.logDir, join(resolve(home), 'logs'));
  assert.equal(status.configFile, join(resolve(home), 'config.json'));
  assert.equal(status.port, port);
  assert.equal(status.node, process.version);
  assert.ok(Number.isInteger(status.pid));
  assert.ok(!Number.isNaN(Date.parse(status.startedAt)));
  assert.equal(status.net.available, true);
  assert.equal(status.net.reason, null);
  assert.equal(status.net.port, port);
  // 协作服务随组合根接线：状态块含协作计数（新装整机零协作）
  assert.deepEqual(status.collab.byState, {});
  assert.equal(status.collab.collabs, 0);
  // 单核形态（设计 §2.5）：site 恒 { mode:'single', slot:null, port, takeover:false }
  assert.deepEqual(status.site, { mode: 'single', slot: null, port, takeover: false });
  // 核心应答判据：载荷带 core 字段（桥合成的差错载荷只有 core.available:false，无 pid/app/endpoint）；
  // core.pid 与 core.json 的真核心进程 pid 对证（不与载荷 pid 自比——同源同表达式恒真，无判别力）
  const coreRecord = JSON.parse(readFileSync(coreJsonPath(home), 'utf8'));
  assert.equal(status.core.pid, coreRecord.pid, 'core.pid 与核心真进程 pid 一致');
  assert.equal(isProcessAlive(coreRecord.pid), true, '核心进程在场');
  assert.equal(status.core.app, JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version, 'core.app 与安装树版本一致');
  assert.equal(typeof status.core.endpoint, 'string');
  assert.equal(existsSync(join(home, 'config.json')), true);
  assert.equal(existsSync(join(home, 'instance-id')), true);
  assert.equal(existsSync(join(home, 'logs', 'waystation.log')), true);
  assert.equal(existsSync(join(home, 'collabs')), true);
  const saved = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
  assert.equal(saved.port, port);
  // 预写配置没写身份名 = 未设置：本会话载荷带一次性提示，生效的默认机器名已补写落盘；
  // 回读即「有值」——下一会话不再触发提示（一次性语义的落盘侧证据）
  assert.ok(status.identityHint.includes(status.identityName), `身份提示需含生效值：${status.identityHint}`);
  assert.equal(saved.identityName, status.identityName);
  assert.equal(loadConfig(home).identityDefaulted, false);
});

test('机器实例标识：跨进程重启不变（持久化生效）', { timeout: 30000 }, async (t) => {
  const home = makeStationHome(t);
  const first = await connectClient(t, INDEX_ENTRY, home, { port: await pickFreePort() });
  const firstStatus = await fetchStatus(first);
  await first.close();
  const second = await connectClient(t, INDEX_ENTRY, home, { port: await pickFreePort() });
  const secondStatus = await fetchStatus(second);
  assert.match(secondStatus.instanceId, UUID_PATTERN);
  assert.equal(secondStatus.instanceId, firstStatus.instanceId);
});

test('bin 入口与 src/index.js 等价可用', { timeout: 30000 }, async (t) => {
  const home = makeStationHome(t);
  const client = await connectClient(t, BIN_ENTRY, home, { port: await pickFreePort() });
  const status = await fetchStatus(client);
  assert.equal(status.name, 'waystation');
});

test('数据目录不可用：核心启动自检拒绝服务（退出码 1＋stderr 明确报错＋stdout 零输出）；桥侧工具即时报错（原因取 startupError）', { timeout: 30000 }, async (t) => {
  const home = makeStationHome(t);
  const port = await pickFreePort();
  // 协作目录被文件占位 = 数据目录内容不可用（拒绝服务语义与既有「数据目录不可写」同面）；
  // 端口显式配置：拒绝发生在自检步（而非「显式根未配端口」的前置拒绝）
  writeFileSync(join(home, 'config.json'), JSON.stringify({ port, scanWindowMs: 300, dialTimeoutMs: 1500, viewerAutoOpen: false }));
  writeFileSync(join(home, 'collabs'), 'not a directory\n');
  const coreRun = spawnSync(process.execPath, [CORE_ENTRY], {
    cwd: repoRoot,
    env: { ...process.env, WAYSTATION_HOME: home, WAYSTATION_TEST_GRACE_MS: '1500' },
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(coreRun.status, 1, `核心入口应拒绝服务退出 1；stderr：${coreRun.stderr}`);
  assert.ok(coreRun.stderr.includes('拒绝服务'), `stderr 应含「拒绝服务」，实际：${coreRun.stderr}`);
  assert.equal(coreRun.stdout, '');
  // 桥全链：核心拒服 → 工具错误文案取 core.json.startupError（原因可得性：本例 run/ 可写，原因在场）
  const client = await connectClient(t, INDEX_ENTRY, home, { port });
  const called = await client.callTool({ name: 'ws_status', arguments: {} });
  assert.equal(called.isError, true);
  const payload = JSON.parse(called.content[0].text);
  assert.deepEqual(Object.keys(payload), ['core', 'bridge']);
  assert.equal(payload.core.available, false);
  assert.ok(payload.core.reason.includes('协作目录不可用'), `reason 应取 startupError 原文，实际：${payload.core.reason}`);
  const record = JSON.parse(readFileSync(coreJsonPath(home), 'utf8'));
  assert.equal(typeof record.startupError, 'string');
  assert.ok(record.startupError.includes('拒绝服务') || record.startupError.includes('协作目录不可用'));
});

test('ws_list_hosts：扫描可用、排除自答（自播自答不产生条目）', { timeout: 30000 }, async (t) => {
  const home = makeStationHome(t);
  const port = await pickFreePort();
  const client = await connectClient(t, INDEX_ENTRY, home, { port });
  const status = await fetchStatus(client);
  const called = await client.callTool({ name: 'ws_list_hosts', arguments: {} });
  assert.equal(called.isError, undefined);
  const payload = JSON.parse(called.content[0].text);
  assert.equal(payload.ok, true);
  assert.equal(payload.hosts.some((host) => host.instanceId === status.instanceId), false, '排除自答');
});

test('ws_ping：自环可达（同端口监听服务自身）、不可达地址与非法地址', { timeout: 30000 }, async (t) => {
  const home = makeStationHome(t);
  const port = await pickFreePort();
  const client = await connectClient(t, INDEX_ENTRY, home, { port });
  const selfPing = JSON.parse((await client.callTool({ name: 'ws_ping', arguments: { address: '127.0.0.1', port } })).content[0].text);
  assert.equal(selfPing.reachable, true);
  assert.ok(Number.isInteger(selfPing.rttMs));
  // 不可达样本取 TEST-NET-1（RFC 5737 文档保留段，不可路由）：本机监听在 0.0.0.0 通配地址上，
  // 回环别名（如 127.0.0.3）会被自己的通配监听接住，不能当「不可达」用
  const dead = JSON.parse((await client.callTool({ name: 'ws_ping', arguments: { address: '192.0.2.1', port } })).content[0].text);
  assert.equal(dead.reachable, false);
  const bad = await client.callTool({ name: 'ws_ping', arguments: { address: 'not-an-ip', port } });
  assert.equal(bad.isError, true);
});

test('ws_delivery_status：无已发消息返回空行集', { timeout: 30000 }, async (t) => {
  const home = makeStationHome(t);
  const client = await connectClient(t, INDEX_ENTRY, home, { port: await pickFreePort() });
  const called = await client.callTool({ name: 'ws_delivery_status', arguments: {} });
  assert.deepEqual(JSON.parse(called.content[0].text), { ok: true, rows: [], reportRows: 0 });
});

test('端口占用一：显式端口被另一驿站占 → ② 降级服务（ready＋net.degraded＋分类文案），LAN 工具明确报错', { timeout: 40000 }, async (t) => {
  const { port, clientA } = await startExplicitPortStation(t);
  assert.equal((await fetchStatus(clientA)).net.available, true);
  const homeB = makeStationHome(t);
  const clientB = await connectClient(t, INDEX_ENTRY, homeB, { port });
  const statusB = await fetchStatus(clientB);
  /* 降级服务态（设计 §6.1-②）：核心照常 ready（ws_status 由核心应答，core.pid 在场＝非等待接管态）；
   * 单核形态 site 不退回 null，LAN 降级经 net 表达；分类文案落 core.json.statusDetail（T5 新语义）。 */
  assert.equal(statusB.net.available, false);
  assert.equal(statusB.net.reason, 'occupied-by-station');
  /* degraded 由 net.available 同源推导（status.js）——此处固化「降级服务态带 degraded 标注」的契约在场 */
  assert.equal('degraded' in statusB.core, true, '降级服务态：core 字段带 degraded 标注');
  assert.equal(statusB.site.mode, 'single');
  const record = JSON.parse(readFileSync(coreJsonPath(homeB), 'utf8'));
  assert.equal(statusB.core.pid, record.pid, '降级服务＝核心照常应答（pid 与真进程一致）');
  assert.equal(record.status, 'ready');
  assert.ok(record.statusDetail.includes('本机另有驿站'), `statusDetail 应为别根占用分类文案，实际：${record.statusDetail}`);
  assert.ok(record.statusDetail.includes('自动接管'), '指引含释放后自动接管');
  const listed = await clientB.callTool({ name: 'ws_list_hosts', arguments: {} });
  assert.equal(listed.isError, true);
  assert.ok(listed.content[0].text.includes(String(port)), 'LAN 工具错误文案含端口号');
  const probed = await clientB.callTool({ name: 'ws_ping', arguments: { address: '127.0.0.1', port } });
  assert.equal(probed.isError, true);
});

test('端口占用二：显式端口被无关程序占 → ① 降级服务（分类文案指向无关程序），LAN 工具明确报错', { timeout: 40000 }, async (t) => {
  const home = makeStationHome(t);   // 站点收尾钩子先于占位收尾钩子注册：占位收尾抛错也不跳过站点关闭（钩子跳过语义）
  const port = await startPortOccupier(t);
  const client = await connectClient(t, INDEX_ENTRY, home, { port });
  const status = await fetchStatus(client);
  assert.equal(status.net.available, false);
  assert.equal(status.net.reason, 'port-taken');
  /* degraded 由 net.available 同源推导（status.js）——此处固化「降级服务态带 degraded 标注」的契约在场 */
  assert.equal('degraded' in status.core, true, '降级服务态：core 字段带 degraded 标注');
  assert.equal(status.site.mode, 'single');
  const record = JSON.parse(readFileSync(coreJsonPath(home), 'utf8'));
  assert.equal(status.core.pid, record.pid, '降级服务＝核心照常应答（pid 与真进程一致）');
  assert.equal(record.status, 'ready');
  assert.ok(record.statusDetail.includes('无关程序'), `statusDetail 应为无关程序分类文案，实际：${record.statusDetail}`);
  const listed = await client.callTool({ name: 'ws_list_hosts', arguments: {} });
  assert.equal(listed.isError, true);
  assert.ok(listed.content[0].text.includes(String(port)), 'LAN 工具错误文案含端口号');
  const probed = await client.callTool({ name: 'ws_ping', arguments: { address: '127.0.0.1', port } });
  assert.equal(probed.isError, true);
});

test('ws_check_inbox：进程级读取收件流水（未投递消息的会话主动查出口）', { timeout: 30000 }, async (t) => {
  const home = makeStationHome(t);
  const client = await connectClient(t, INDEX_ENTRY, home, { port: await pickFreePort() }, CHECK_INBOX_SESSION_ID);
  mkdirSync(join(home, 'collabs', 'collab-1'), { recursive: true });
  const record = {
    msgId: 'msg-1',
    type: 'notice',
    from: { instanceId: 'inst-a', identityName: '主机甲', port: 7321 },
    collabId: 'collab-1',
    ts: new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    payload: { text: '主动查可见' },
  };
  writeFileSync(join(home, 'collabs', 'collab-1', 'inbox.jsonl'), JSON.stringify(record) + '\n');
  const called = await client.callTool({ name: 'ws_check_inbox', arguments: { collabId: 'collab-1' } });
  assert.equal(called.isError, undefined);
  const result = JSON.parse(called.content[0].text);
  assert.equal(result.total, 1);
  assert.equal(result.messages[0].payload.text, '主动查可见');
  const bad = await client.callTool({ name: 'ws_check_inbox', arguments: { collabId: 'bad id!' } });
  assert.equal(bad.isError, true);
});

test('会话关闭（stdin 关闭）：桥退出码 0；核心按宽限窗退场后释放 TCP/UDP 端口（单核新语义）', { timeout: 40000 }, async (t) => {
  /* 裸子进程的收尾钩子同样必须抢在 makeTempDir 删除钩子前注册（否则删除钩子抛错会跳过它）；
   * 注册时 child 尚未创建，经引用回填 */
  let child = null;
  t.after(() => {
    if (child !== null && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  });
  const home = makeStationHome(t);
  const port = await pickFreePort();
  // viewerAutoOpen: false——同起站夹具纪律（不拉起观察窗）；短宽限注入使核心在可观察窗内退场
  writeFileSync(join(home, 'config.json'), JSON.stringify({ scanWindowMs: 300, dialTimeoutMs: 1500, port, viewerAutoOpen: false }));
  child = spawn(process.execPath, [INDEX_ENTRY], {
    cwd: repoRoot,
    env: { ...process.env, WAYSTATION_HOME: home, WAYSTATION_TEST_GRACE_MS: '2000' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  stationChildren.push(child);   // 文件级兜底纳管：收尾钩子被跳过时由文件末尾统一杀灭
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  await waitPortListening(port);
  child.stdin.end();
  const exitResult = await waitProcessExit(child, 8000);
  assert.notEqual(exitResult, null, `stdin 关闭后 8 秒桥进程未退出；stderr：${stderr}`);
  assert.equal(exitResult.code, 0);
  assert.equal(exitResult.signal, null);
  /* 单核语义（设计 §3.2）：桥退场 ≠ 端口释放——核心仍在宽限窗内（描述符在场、进程存活）；
   * 并以真探针断言端口此刻仍被监听（进程存活代理之外的直接证据） */
  const record = JSON.parse(readFileSync(coreJsonPath(home), 'utf8'));
  assert.equal(isProcessAlive(record.pid), true, '宽限窗内核心仍在（端口未释放）');
  assert.equal(await probeConnect(port), true, '宽限窗内端口仍被监听（真探针）');
  /* 宽限到期：核心有序收尾（退出码 0）并释放端口——真探针：连接应失败；TCP 帧通道 + UDP 发现
   * 都能重新独占绑定 */
  await waitForRebindable(port, { timeoutMs: 15000 });
  assert.equal(await probeConnect(port), false, '释放后连接应被拒绝（真探针）');
  await assertPortRebindable(port);
});

test('ws_list_collabs：新装返回空清单（协作工具面已接线）', { timeout: 30000 }, async (t) => {
  const home = makeStationHome(t);
  const client = await connectClient(t, INDEX_ENTRY, home, { port: await pickFreePort() });
  const called = await client.callTool({ name: 'ws_list_collabs', arguments: {} });
  assert.equal(called.isError, undefined);
  assert.deepEqual(JSON.parse(called.content[0].text), { ok: true, collabs: [] });
});

test('ws_create_collab：参数非法 → isError（不建立任何协作）', { timeout: 30000 }, async (t) => {
  const home = makeStationHome(t);
  const client = await connectClient(t, INDEX_ENTRY, home, { port: await pickFreePort() });
  const bad = await client.callTool({ name: 'ws_create_collab', arguments: { name: '项目', topic: '主题', targets: [] } });
  assert.equal(bad.isError, true);
  const listed = await client.callTool({ name: 'ws_list_collabs', arguments: {} });
  assert.deepEqual(JSON.parse(listed.content[0].text), { ok: true, collabs: [] });
});

test('ws_view_ledger / ws_send_message：未知协作 → isError（明确提示）', { timeout: 30000 }, async (t) => {
  const home = makeStationHome(t);
  const client = await connectClient(t, INDEX_ENTRY, home, { port: await pickFreePort() });
  const viewed = await client.callTool({ name: 'ws_view_ledger', arguments: { collabId: 'collab-none' } });
  assert.equal(viewed.isError, true);
  assert.ok(viewed.content[0].text.includes('没有该协作'));
  const sent = await client.callTool({ name: 'ws_send_message', arguments: { collabId: 'collab-none', text: '你好' } });
  assert.equal(sent.isError, true);
});

test('治理工具：未知协作的裁定 / 移交 / 抢接 → isError（明确提示，不触达网络）', { timeout: 30000 }, async (t) => {
  const home = makeStationHome(t);
  const client = await connectClient(t, INDEX_ENTRY, home, { port: await pickFreePort() });
  const decided = await client.callTool({ name: 'ws_decide', arguments: { collabId: 'collab-none', choice: 'keep' } });
  assert.equal(decided.isError, true);
  assert.ok(decided.content[0].text.includes('没有该协作'));
  const handed = await client.callTool({ name: 'ws_handover', arguments: { collabId: 'collab-none', target: 'inst-b', targetSessionId: 'session-none' } });
  assert.equal(handed.isError, true);
  assert.ok(handed.content[0].text.includes('没有该协作'));
  const taken = await client.callTool({ name: 'ws_take_over', arguments: { collabId: 'collab-none' } });
  assert.equal(taken.isError, true);
  assert.ok(taken.content[0].text.includes('没有该协作'));
  const badChoice = await client.callTool({ name: 'ws_decide', arguments: { collabId: 'collab-none' } });
  assert.equal(badChoice.isError, true, '两形态均缺 → 参数级错误');
  assert.ok(badChoice.content[0].text.includes('一种形态'));
});
