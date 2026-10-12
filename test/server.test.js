import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { makeTempDir, pickFreePort, repoRoot } from './helpers.js';

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

test('stdio 骨架：进程可起、ws_status 可调、网络层就绪、首跑落盘数据目录', { timeout: 30000 }, async (t) => {
  const home = makeTempDir(t);
  const port = await pickFreePort();
  const client = await connectClient(t, INDEX_ENTRY, home, { port });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), ['ws_status', 'ws_list_hosts', 'ws_ping', 'ws_delivery_status']);
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
  const selfPing = JSON.parse((await client.callTool({ name: 'ws_ping', arguments: { address: '127.0.0.1' } })).content[0].text);
  assert.equal(selfPing.reachable, true);
  assert.ok(Number.isInteger(selfPing.rttMs));
  // 不可达样本取 TEST-NET-1（RFC 5737 文档保留段，不可路由）：本机监听在 0.0.0.0 通配地址上，
  // 回环别名（如 127.0.0.3）会被自己的通配监听接住，不能当「不可达」用
  const dead = JSON.parse((await client.callTool({ name: 'ws_ping', arguments: { address: '192.0.2.1' } })).content[0].text);
  assert.equal(dead.reachable, false);
  const bad = await client.callTool({ name: 'ws_ping', arguments: { address: 'not-an-ip' } });
  assert.equal(bad.isError, true);
});

test('ws_delivery_status：无已发消息返回空数组', { timeout: 30000 }, async (t) => {
  const home = makeTempDir(t);
  const client = await connectClient(t, INDEX_ENTRY, home, { port: await pickFreePort() });
  const called = await client.callTool({ name: 'ws_delivery_status', arguments: {} });
  assert.deepEqual(JSON.parse(called.content[0].text), []);
});

test('端口占用一：本机已有驿站 → 降级、local-instance 文案、LAN 工具明确报错', { timeout: 40000 }, async (t) => {
  const port = await pickFreePort();
  const clientA = await connectClient(t, INDEX_ENTRY, makeTempDir(t), { port });
  assert.equal((await fetchStatus(clientA)).net.available, true);
  const clientB = await connectClient(t, INDEX_ENTRY, makeTempDir(t), { port });
  const statusB = await fetchStatus(clientB);
  assert.equal(statusB.net.available, false);
  assert.equal(statusB.net.reason, 'local-instance');
  assert.ok(statusB.net.message.includes('本机已有驿站'));
  const listed = await clientB.callTool({ name: 'ws_list_hosts', arguments: {} });
  assert.equal(listed.isError, true);
  assert.ok(listed.content[0].text.includes('本机已有驿站'));
  const probed = await clientB.callTool({ name: 'ws_ping', arguments: { address: '127.0.0.1' } });
  assert.equal(probed.isError, true);
});

test('端口占用二：无关程序占用 → 降级、port-taken 文案与改端口指引', { timeout: 40000 }, async (t) => {
  const port = await pickFreePort();
  const held = new Set();
  const occupier = createServer((socket) => {
    held.add(socket);
    socket.on('close', () => held.delete(socket));
  });
  await new Promise((resolve) => occupier.listen({ port, host: '0.0.0.0' }, resolve));
  t.after(async () => {
    for (const socket of held) {
      socket.destroy();
    }
    await new Promise((resolve) => occupier.close(resolve));
  });
  const client = await connectClient(t, INDEX_ENTRY, makeTempDir(t), { port });
  const status = await fetchStatus(client);
  assert.equal(status.net.available, false);
  assert.equal(status.net.reason, 'port-taken');
  assert.ok(status.net.message.includes('被其他程序占用'));
  assert.ok(status.net.message.includes('config.json'));
});
