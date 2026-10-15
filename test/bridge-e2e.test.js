import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { makeTempDir, pickFreePort, repoRoot, waitFor } from './helpers.js';
import { coreJsonPath } from '../src/paths.js';
import { startCore } from '../src/core/main.js';
import { TOOL_SPECS } from '../src/tools/specs.js';

/* 端到端（真进程）：1 桥＋1 核——MCP 握手（tools/list 不依赖核心即答）、ws_status 核心应答、
 * call/result 载荷等价（同一核心的直调 handler 与经桥 IPC 往返的结构化等值，设计 §9.1-7）、
 * 桥入口（src/index.js 薄壳 / bin/waystation.js）等价可用。
 * 全部临时根（WAYSTATION_HOME）＋高位端口。
 * 收尾纪律（与其余四份测试同一模式）：用例收尾钩子（关桥 → 等桥退场 → 收核）必须抢在
 * makeTempDir 的删除钩子前注册——否则删除与仍写盘的核并发，且按 core.json 收核会因目录已删
 * 而静默失效；文件级兜底强制关闭并响亮失败，绝不让泄漏拖住整轮运行。 */

const INDEX_ENTRY = join(repoRoot, 'src', 'index.js');
const BIN_ENTRY = join(repoRoot, 'bin', 'waystation.js');

function writeStationConfig(home, port) {
  writeFileSync(join(home, 'config.json'), JSON.stringify({ port, scanWindowMs: 300, dialTimeoutMs: 1500, viewerAutoOpen: false }));
}

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

/* 按 core.json 收核（桥已退场后的残留清理；核心已正常退出＝无描述符，静默无事）。
 * 自身 pid 护栏：进程内起站的用例里 core.json 记的就是本测试进程——不得自杀（进程内核由
 * 用例自己的 stop 回调收尾）。 */
function killCoreProcess(home) {
  try {
    const record = JSON.parse(readFileSync(coreJsonPath(home), 'utf8'));
    if (Number.isInteger(record.pid) && record.pid !== process.pid && isProcessAlive(record.pid)) {
      process.kill(record.pid, 'SIGKILL');
    }
  } catch {
    // 无描述符：核心已自行退出
  }
}

/* 用例级收尾清单（钩子只注册一次、先于任何 makeTempDir 的删除钩子）：关桥 → 等桥退场（未退强杀）
 * → 按 core.json 收子进程核 → 进程内核 stop 回调（最后跑：桥已死，无重生之虞）。 */
const cleanupByTest = new WeakMap();

function cleanupOf(t) {
  let cleanup = cleanupByTest.get(t);
  if (cleanup === undefined) {
    cleanup = { closes: [], stops: [], pids: [], homes: [] };
    cleanupByTest.set(t, cleanup);
    t.after(async () => {
      for (const close of cleanup.closes) {
        try {
          await close();
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
        killCoreProcess(home);
      }
      for (const stop of cleanup.stops) {
        try {
          await stop();
        } catch {
          // 停站失败不改变收尾结论（临时目录照常删除）
        }
      }
    });
  }
  return cleanup;
}

/* 用例数据根：收尾钩子先于 makeTempDir 的删除钩子注册（见头注纪律）。 */
function makeE2eHome(t) {
  const cleanup = cleanupOf(t);
  const home = makeTempDir(t);
  cleanup.homes.push(home);
  stationHomes.push(home);
  return home;
}

/* 起桥（SDK stdio 客户端连入口进程）；返回 client 与桥进程 pid 捕获器。 */
async function startBridgeClient(t, entry, home) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: repoRoot,
    env: { ...process.env, WAYSTATION_HOME: home, WAYSTATION_TEST_GRACE_MS: '1500' },
  });
  stationTransports.push(transport);   // 文件级兜底纳管
  const client = new Client({ name: 'bridge-e2e-test', version: '0.0.0' });
  const cleanup = cleanupOf(t);
  cleanup.closes.push(() => client.close());
  await client.connect(transport);
  const bridgePid = transport.pid ?? null;
  cleanup.pids.push(bridgePid);
  return { client, bridgePidOf: () => bridgePid };
}

/* 文件级兜底：任何收尾钩子被跳过（如钩子抛错）都会留下未关闭的桥进程——强制关闭并响亮失败，
 * 绝不让泄漏把整轮运行拖进永不退出的等待（正常路径全部已收，兜底无事可做）。 */
const stationTransports = [];
const stationHomes = [];

after(async () => {
  const leakedPids = [];
  for (const transport of stationTransports) {
    if (transport.pid !== null) {
      leakedPids.push(transport.pid);
      try {
        await transport.close();
      } catch (error) {
        console.error(`[测试收尾] 兜底关闭桥失败：pid=${transport.pid}（${error.message}）`);
      }
    }
  }
  for (const pid of leakedPids) {
    if (isProcessAlive(pid)) {
      process.kill(pid, 'SIGKILL');
    }
  }
  for (const home of stationHomes) {
    killCoreProcess(home);
  }
  assert.equal(leakedPids.length, 0, `桥进程未被用例收尾（收尾钩子被跳过？）：${leakedPids.join(',')}——已兜底强制关闭，检查用例清理`);
});

async function callToolJson(client, name, args = {}) {
  const called = await client.callTool({ name, arguments: args });
  assert.equal(called.isError, undefined, `工具 ${name} 不应报错：${called.content[0].text}`);
  return JSON.parse(called.content[0].text);
}

test('e2e：1 桥＋1 核（spawn 真进程）——MCP 握手、ws_status 核心应答、冷启的核落盘就绪', { timeout: 60000 }, async (t) => {
  const home = makeE2eHome(t);
  const port = await pickFreePort();
  writeStationConfig(home, port);
  const { client } = await startBridgeClient(t, INDEX_ENTRY, home);
  /* tools/list 不依赖核心即答：握手后立即取得全量目录（此刻核心至多仍在冷启） */
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), TOOL_SPECS.map((spec) => spec.name));
  const status = await callToolJson(client, 'ws_status');
  const record = JSON.parse(readFileSync(coreJsonPath(home), 'utf8'));
  /* 核心应答判据：载荷带 core 字段（桥合成差错载荷只有 core.available:false，无 pid/app/endpoint）；
   * core.pid 与 core.json 的真子进程 pid 对证（不与载荷 pid 自比——同源同表达式恒真） */
  assert.equal(status.ok, true);
  assert.equal(status.name, 'waystation');
  assert.deepEqual(status.site, { mode: 'single', slot: null, port, takeover: false });
  assert.equal(status.core.pid, record.pid, 'core.pid 与冷启核心的真进程 pid 一致');
  assert.equal(status.core.app, JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version, 'core.app 与安装树版本一致');
  assert.equal(typeof status.core.endpoint, 'string');
  assert.equal('available' in status.core, false, '核心应答载荷不设 available 子字段');
  assert.equal(record.status, 'ready');
  assert.equal(record.port, port);
  assert.equal(isProcessAlive(record.pid), true, '冷启的核心进程在场');
  assert.equal(record.identity === null, false, 'ready 时身份已补写');
});

test('e2e：bin 入口等价可用（bin/waystation.js 与 src/index.js 同形态）', { timeout: 60000 }, async (t) => {
  const home = makeE2eHome(t);
  const port = await pickFreePort();
  writeStationConfig(home, port);
  const { client } = await startBridgeClient(t, BIN_ENTRY, home);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 19);
  const status = await callToolJson(client, 'ws_status');
  assert.equal(status.name, 'waystation');
  assert.equal(status.site.mode, 'single');
  const record = JSON.parse(readFileSync(coreJsonPath(home), 'utf8'));
  assert.equal(status.core.pid, record.pid, 'bin 入口形态下核心应答且 pid 与真进程一致');
});

function writeMemberFixture(home, collabId, name) {
  const now = new Date().toISOString();
  const record = {
    collabId,
    role: 'member',
    state: 'proposed',
    name,
    manager: { instanceId: 'inst-a', identityName: '主机甲' },
    roster: [{ instanceId: 'inst-a', identityName: '主机甲' }],
    endpoints: {},
    invitedAt: now,
    expiresAt: new Date(Date.parse(now) + 86400000).toISOString(),
    decision: null,
  };
  mkdirSync(join(home, 'collabs', collabId), { recursive: true });
  writeFileSync(join(home, 'collabs', collabId, 'member.json'), JSON.stringify(record));
}

function writeInboxFixture(home, collabId) {
  const now = new Date().toISOString();
  const record = {
    msgId: 'msg-1',
    type: 'notice',
    from: { instanceId: 'inst-a', identityName: '主机甲', port: 7321 },
    collabId,
    ts: now,
    receivedAt: now,
    payload: { text: '主动查可见' },
  };
  writeFileSync(join(home, 'collabs', collabId, 'inbox.jsonl'), JSON.stringify(record) + '\n');
}

/* 载荷等价：核心在测试进程内起站（真实组合根＋真 IPC 服务端），桥为真进程接入同一核心——
 * 「直调 handler」＝该核心的 registry.call（与 BASE 的直调同一入口），「经桥」＝MCP → 桥 → IPC
 * 往返；同一夹具下两者 JSON 解析后结构等值（deepEqual——非原始字节比对）。收尾＝关桥 → 等桥
 * 退场 → 进程内核 stop（经用例收尾清单，先于目录删除）。 */
test('e2e：call/result 载荷等价——同核直调 handler 与经桥 IPC 往返结构等值', { timeout: 60000 }, async (t) => {
  const home = makeE2eHome(t);
  const port = await pickFreePort();
  writeStationConfig(home, port);
  writeMemberFixture(home, 'collab-1', '联调项目');
  writeInboxFixture(home, 'collab-1');
  const started = await startCore({ env: { ...process.env, WAYSTATION_HOME: home } });
  assert.equal(started.ok, true, JSON.stringify(started));
  const core = started.core;
  cleanupOf(t).stops.push(() => core.stop());
  const { client, bridgePidOf } = await startBridgeClient(t, INDEX_ENTRY, home);
  const status = await callToolJson(client, 'ws_status');
  assert.equal(status.core.pid, process.pid, '桥接入的是本测试进程内的核心（无冷启）');
  for (const [name, args] of [['ws_check_inbox', { collabId: 'collab-1' }], ['ws_list_collabs', {}]]) {
    const roundTrip = await callToolJson(client, name, args);
    const direct = await core.registry.call(name, args, core.context);
    assert.equal(direct.isError, undefined);
    assert.deepEqual(roundTrip, JSON.parse(direct.content[0].text), `${name} 载荷经 IPC 往返与直调结构等值`);
  }
  assert.equal((await callToolJson(client, 'ws_check_inbox', { collabId: 'collab-1' })).messages[0].payload.text, '主动查可见');
  await client.close();
  await waitFor(() => !isProcessAlive(bridgePidOf()), { timeoutMs: 10000 });
  const record = JSON.parse(readFileSync(coreJsonPath(home), 'utf8'));
  assert.equal(record.status, 'ready', '桥退场后进程内核仍就绪（随用例收尾 stop 停止）');
});
