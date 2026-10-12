import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { makeTempDir, repoRoot } from './helpers.js';

const INDEX_ENTRY = join(repoRoot, 'src', 'index.js');
const BIN_ENTRY = join(repoRoot, 'bin', 'waystation.js');
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// 用 SDK 官方 client 真实握手——能握手成功即同时证明 stdout 未被任何日志污染
async function connectClient(t, entry, home) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: repoRoot,
    env: { ...process.env, WAYSTATION_HOME: home },
  });
  const client = new Client({ name: 'waystation-m1-test', version: '0.0.0' });
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

test('stdio 骨架：进程可起、ws_status 可调、首跑落盘数据目录', { timeout: 30000 }, async (t) => {
  const home = makeTempDir(t);
  const client = await connectClient(t, INDEX_ENTRY, home);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), ['ws_status']);
  const status = await fetchStatus(client);
  assert.equal(status.name, 'waystation');
  assert.equal(status.version, '0.1.0');
  assert.match(status.instanceId, UUID_PATTERN);
  assert.ok(status.identityName.length > 0);
  assert.equal(status.dataDir, resolve(home));
  assert.equal(status.logDir, join(resolve(home), 'logs'));
  assert.equal(status.configFile, join(resolve(home), 'config.json'));
  assert.equal(status.port, 7321);
  assert.equal(status.node, process.version);
  assert.ok(Number.isInteger(status.pid));
  assert.ok(!Number.isNaN(Date.parse(status.startedAt)));
  assert.equal(existsSync(join(home, 'config.json')), true);
  assert.equal(existsSync(join(home, 'instance-id')), true);
  assert.equal(existsSync(join(home, 'logs', 'waystation.log')), true);
  assert.equal(existsSync(join(home, 'collabs')), true);
  const saved = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
  assert.equal(saved.port, 7321);
  assert.equal(saved.logMaxFiles, 5);
});

test('机器实例标识：跨进程重启不变（持久化生效）', { timeout: 30000 }, async (t) => {
  const home = makeTempDir(t);
  const first = await connectClient(t, INDEX_ENTRY, home);
  const firstStatus = await fetchStatus(first);
  await first.close();
  const second = await connectClient(t, INDEX_ENTRY, home);
  const secondStatus = await fetchStatus(second);
  assert.match(secondStatus.instanceId, UUID_PATTERN);
  assert.equal(secondStatus.instanceId, firstStatus.instanceId);
});

test('bin 入口与 src/index.js 等价可用', { timeout: 30000 }, async (t) => {
  const home = makeTempDir(t);
  const client = await connectClient(t, BIN_ENTRY, home);
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
