import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import dgram from 'node:dgram';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { makeTempDir, pickFreePort, repoRoot, waitFor } from './helpers.js';

const INDEX_ENTRY = join(repoRoot, 'src', 'index.js');
const BIN_ENTRY = join(repoRoot, 'bin', 'waystation.js');
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// 用 SDK 官方 client 真实握手——能握手成功即同时证明 stdout 未被任何日志污染
async function connectClient(t, entry, home, extraConfig = {}) {
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({ scanWindowMs: 300, dialTimeoutMs: 1500, ...extraConfig }),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: repoRoot,
    env: { ...process.env, WAYSTATION_HOME: home },
  });
  const client = new Client({ name: 'waystation-m2-test', version: '0.0.0' });
  t.after(async () => {
    try {
      await client.close();
    } catch {
      // 用例中已显式关闭：忽略重复关闭
    }
  });
  await client.connect(transport);
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
    const clientA = await connectClient(t, INDEX_ENTRY, makeTempDir(t), { port });
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
  const home = makeTempDir(t);
  const port = await pickFreePort();
  const client = await connectClient(t, INDEX_ENTRY, home, { port });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), ['ws_status', 'ws_list_hosts', 'ws_ping', 'ws_delivery_status', 'ws_check_inbox']);
  const status = await fetchStatus(client);
  assert.equal(status.name, 'waystation');
  assert.equal(status.version, '0.1.0');
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
  // WAYSTATION_HOME + 预写 port = 显式接管站点（站点块随状态输出，供多站点排障）
  assert.deepEqual(status.site, { mode: 'explicit', slot: null, port, takeover: true });
  assert.equal(existsSync(join(home, 'config.json')), true);
  assert.equal(existsSync(join(home, 'instance-id')), true);
  assert.equal(existsSync(join(home, 'logs', 'waystation.log')), true);
  assert.equal(existsSync(join(home, 'collabs')), true);
  const saved = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
  assert.equal(saved.port, port);
});

test('机器实例标识：跨进程重启不变（持久化生效）', { timeout: 30000 }, async (t) => {
  const home = makeTempDir(t);
  const first = await connectClient(t, INDEX_ENTRY, home, { port: await pickFreePort() });
  const firstStatus = await fetchStatus(first);
  await first.close();
  const second = await connectClient(t, INDEX_ENTRY, home, { port: await pickFreePort() });
  const secondStatus = await fetchStatus(second);
  assert.match(secondStatus.instanceId, UUID_PATTERN);
  assert.equal(secondStatus.instanceId, firstStatus.instanceId);
});

test('bin 入口与 src/index.js 等价可用', { timeout: 30000 }, async (t) => {
  const home = makeTempDir(t);
  const client = await connectClient(t, BIN_ENTRY, home, { port: await pickFreePort() });
  const status = await fetchStatus(client);
  assert.equal(status.name, 'waystation');
});

test('数据目录不可写：启动自检拒绝服务（退出码 1 + stderr 明确报错 + stdout 零输出）', { timeout: 30000 }, (t) => {
  const home = makeTempDir(t);
  const blocker = join(home, 'blocker.txt');
  writeFileSync(blocker, 'not a directory\n');
  const run = spawnSync(process.execPath, [INDEX_ENTRY], {
    cwd: repoRoot,
    env: { ...process.env, WAYSTATION_HOME: join(blocker, 'nested') },
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(run.status, 1);
  assert.ok(run.stderr.includes('拒绝服务'), `stderr 应含「拒绝服务」，实际：${run.stderr}`);
  assert.equal(run.stdout, '');
});

test('ws_list_hosts：扫描可用、排除自答（自播自答不产生条目）', { timeout: 30000 }, async (t) => {
  const home = makeTempDir(t);
  const port = await pickFreePort();
  const client = await connectClient(t, INDEX_ENTRY, home, { port });
  const status = await fetchStatus(client);
  const called = await client.callTool({ name: 'ws_list_hosts', arguments: {} });
  assert.equal(called.isError, undefined);
  const hosts = JSON.parse(called.content[0].text);
  assert.ok(Array.isArray(hosts));
  assert.equal(hosts.some((host) => host.instanceId === status.instanceId), false, '排除自答');
});

test('ws_ping：自环可达（同端口监听服务自身）、不可达地址与非法地址', { timeout: 30000 }, async (t) => {
  const home = makeTempDir(t);
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

test('ws_delivery_status：无已发消息返回空数组', { timeout: 30000 }, async (t) => {
  const home = makeTempDir(t);
  const client = await connectClient(t, INDEX_ENTRY, home, { port: await pickFreePort() });
  const called = await client.callTool({ name: 'ws_delivery_status', arguments: {} });
  assert.deepEqual(JSON.parse(called.content[0].text), []);
});

test('端口占用一：显式端口被另一驿站站点占 → 降级、takeover-taken 文案、LAN 工具明确报错', { timeout: 40000 }, async (t) => {
  const { port, clientA } = await startExplicitPortStation(t);
  assert.equal((await fetchStatus(clientA)).net.available, true);
  const clientB = await connectClient(t, INDEX_ENTRY, makeTempDir(t), { port });
  const statusB = await fetchStatus(clientB);
  assert.equal(statusB.net.available, false);
  assert.equal(statusB.net.reason, 'takeover-taken');
  assert.ok(statusB.net.message.includes('不自动改端口'));
  const listed = await clientB.callTool({ name: 'ws_list_hosts', arguments: {} });
  assert.equal(listed.isError, true);
  assert.ok(listed.content[0].text.includes('不自动改端口'));
  const probed = await clientB.callTool({ name: 'ws_ping', arguments: { address: '127.0.0.1', port } });
  assert.equal(probed.isError, true);
});

test('端口占用二：显式端口被无关程序占 → 同一降级结论（不区分占用者）', { timeout: 40000 }, async (t) => {
  const port = await startPortOccupier(t);
  const client = await connectClient(t, INDEX_ENTRY, makeTempDir(t), { port });
  const status = await fetchStatus(client);
  assert.equal(status.net.available, false);
  assert.equal(status.net.reason, 'takeover-taken');
  assert.ok(status.net.message.includes('不自动改端口'));
  assert.ok(status.net.message.includes('config.json'));
  const listed = await client.callTool({ name: 'ws_list_hosts', arguments: {} });
  assert.equal(listed.isError, true);
  assert.ok(listed.content[0].text.includes('不自动改端口'));
  const probed = await client.callTool({ name: 'ws_ping', arguments: { address: '127.0.0.1', port } });
  assert.equal(probed.isError, true);
});

test('ws_check_inbox：进程级读取收件流水（未投递消息的会话主动查出口）', { timeout: 30000 }, async (t) => {
  const home = makeTempDir(t);
  const client = await connectClient(t, INDEX_ENTRY, home, { port: await pickFreePort() });
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

test('会话关闭（stdin 关闭）→ 进程退出（退出码 0）并释放 TCP/UDP 端口', { timeout: 30000 }, async (t) => {
  const home = makeTempDir(t);
  const port = await pickFreePort();
  writeFileSync(join(home, 'config.json'), JSON.stringify({ scanWindowMs: 300, dialTimeoutMs: 1500, port }));
  const child = spawn(process.execPath, [INDEX_ENTRY], {
    cwd: repoRoot,
    env: { ...process.env, WAYSTATION_HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  });
  await waitPortListening(port);
  child.stdin.end();
  const exitResult = await waitProcessExit(child, 8000);
  assert.notEqual(exitResult, null, `stdin 关闭后 8 秒进程未退出（疑似仍持端口 ${port}）；stderr：${stderr}`);
  assert.equal(exitResult.code, 0);
  assert.equal(exitResult.signal, null);
  await assertPortRebindable(port);
});
