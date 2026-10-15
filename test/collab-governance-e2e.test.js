import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { coreJsonPath } from '../src/paths.js';
import { makeTempDir, pickFreePort, repoRoot, waitFor, waitForRebindable } from './helpers.js';

const INDEX_ENTRY = join(repoRoot, 'src', 'index.js');

/* 会话标识：同数据根稳定（重开站点＝原会话重连，绑定恢复活跃）；不同数据根互异。 */
const sessionIdsByHome = new Map();

function sessionIdFor(home) {
  if (!sessionIdsByHome.has(home)) {
    sessionIdsByHome.set(home, `session-gov-${sessionIdsByHome.size + 1}`);
  }
  return sessionIdsByHome.get(home);
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

/* 治理验收预演（真实组合根 × 2 + 假会话收件箱）：交接 / 抢接与握手降级 / 离线拒绝，
 * 走 ws_* 工具面全链——本机近似（真双机归 M7）。
 * Linux 侧命名管道路径语义与本套件同型挂账（协作核心 e2e 的既有口径——Linux 全量归 M7/CI）。 */

/* 假会话收件箱：命名管道上的真实 server（与 collab-e2e 同一形态）。 */
async function startFakeSessionInbox(t) {
  const path = `\\\\.\\pipe\\waystation-m5-e2e-${randomUUID()}`;
  const chunks = [];
  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => chunks.push(chunk));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  t.after(() => server.close());
  return { path, token: `tok-${randomUUID()}`, receivedText: () => Buffer.concat(chunks).toString('utf8') };
}

/* 站点收尾（单核形态）：先关桥并等桥退场、再收核、后删目录（钩子注册序先于 makeTempDir，见 collab-e2e 注）；
 * 收核晚于桥退出：桥存活时杀核会触发桥督视重生（孤儿核心）。 */
const clientsByTest = new WeakMap();

function cleanupRegistryOf(t) {
  let cleanup = clientsByTest.get(t);
  if (cleanup === undefined) {
    cleanup = { clients: [], pids: [], dirs: [] };
    clientsByTest.set(t, cleanup);
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
      for (const dir of cleanup.dirs) {
        killCoreOf(dir);
      }
    });
  }
  return cleanup;
}

function makeStationDir(t) {
  const cleanup = cleanupRegistryOf(t);
  const dir = makeTempDir(t);
  cleanup.dirs.push(dir);
  stationDirs.push(dir);
  return dir;
}

/* 文件级兜底：任何收尾钩子被跳过（如钩子抛错）都会留下未关闭的站点——强制关闭并响亮失败，绝不让
 * 泄漏把整轮运行拖进永不退出的等待；顺带清理可能因删除钩子被跳过而残留的临时目录（正常路径两处
 * 都无事可做）。 */
const stationTransports = [];
const stationDirs = [];

after(async () => {
  const leakedPids = [];
  for (const transport of stationTransports) {
    if (transport.pid !== null) {
      leakedPids.push(transport.pid);
      try {
        await transport.close();
      } catch (error) {
        /* 兜底自身不得中断：close 抛错也要继续走到目录清理与响亮断言 */
        console.error(`[测试收尾] 兜底关闭站点失败：pid=${transport.pid}（${error.message}）`);
      }
    }
  }
  for (const dir of stationDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      console.error(`[测试收尾] 兜底清理临时目录失败：${dir}（${error.code}）`);
    }
  }
  assert.equal(leakedPids.length, 0, `站点进程未被用例收尾（收尾钩子被跳过？）：${leakedPids.join(',')}——已兜底强制关闭，检查用例清理`);
});

/* 治理节奏：短探测 / 短窗口（探针与窗口节律压到秒级以内；行为语义与默认定案一致）。
 * 显式端口写死：测试要按可预期端口寻址——显式目录首跑会自动取段内最低空闲并写回，端口不确定。
 * viewerAutoOpen 关闭：起站夹具不拉起真实观察窗（配置驱动的主保障；置展开之后，不可被 extra 改写）。 */
function writeStationConfig(home, port, extra = {}) {
  writeFileSync(join(home, 'config.json'), JSON.stringify({
    port,
    scanWindowMs: 300,
    dialTimeoutMs: 1500,
    dispatchTickMs: 100,
    retryIntervalMs: 200,
    retryFastCount: 100,
    messageTtlMs: 3600000,
    managerProbeIntervalMs: 100,
    managerOfflineMs: 300,
    takeoverWindowMs: 1500,
    ...extra,
    viewerAutoOpen: false,
  }));
}

async function startStation(t, { home, inbox }) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [INDEX_ENTRY],
    cwd: repoRoot,
    env: {
      ...process.env,
      WAYSTATION_HOME: home,
      CLAUDE_CODE_SESSION_ID: sessionIdFor(home),
      CLAUDE_CODE_MESSAGING_SOCKET: inbox.path,
      CLAUDE_CODE_MESSAGING_TOKEN: inbox.token,
      WAYSTATION_TEST_GRACE_MS: '1200',
    },
  });
  stationTransports.push(transport);   // 文件级兜底纳管：收尾钩子被跳过时由文件末尾统一关闭
  const cleanup = cleanupRegistryOf(t);
  const client = new Client({ name: 'waystation-m5-e2e', version: '0.0.0' });
  cleanup.clients.push(client);
  await client.connect(transport);
  cleanup.pids.push(transport.pid ?? null);
  return client;
}

async function callTool(client, name, args = {}) {
  const called = await client.callTool({ name, arguments: args });
  const text = called.content[0].text;
  return { isError: called.isError === true, payload: called.isError === true ? text : JSON.parse(text) };
}

async function createAndApprove(t, { a, b, portB }) {
  const statusB = (await callTool(b, 'ws_status')).payload;
  const created = await callTool(a, 'ws_create_collab', { name: '治理项目', topic: '主题', targets: [{ instanceId: statusB.instanceId, identityName: statusB.identityName, address: '127.0.0.1', port: portB }] });
  assert.equal(created.isError, false, String(created.payload));
  const collabId = created.payload.collabId;
  await waitFor(async () => {
    const listed = (await callTool(b, 'ws_list_collabs')).payload.collabs;
    return listed.some((entry) => entry.collabId === collabId) ? true : null;
  }, { timeoutMs: 20000 });
  assert.equal((await callTool(b, 'ws_approve_invite', { collabId, approve: true })).isError, false);
  for (const client of [a, b]) {
    await waitFor(async () => {
      const listed = (await callTool(client, 'ws_list_collabs')).payload.collabs;
      return listed.some((entry) => entry.collabId === collabId && entry.state === 'active') ? true : null;
    }, { timeoutMs: 20000 });
  }
  return { collabId };
}

async function startStudio(t, extraConfig = {}) {
  const homeA = makeStationDir(t);
  const homeB = makeStationDir(t);
  const portA = await pickFreePort();
  const portB = await pickFreePort();
  const inboxA = await startFakeSessionInbox(t);
  const inboxB = await startFakeSessionInbox(t);
  writeStationConfig(homeA, portA, extraConfig);
  writeStationConfig(homeB, portB, extraConfig);
  const a = await startStation(t, { home: homeA, port: portA, inbox: inboxA });
  const b = await startStation(t, { home: homeB, port: portB, inbox: inboxB });
  const { collabId } = await createAndApprove(t, { a, b, portB });
  return { homeA, homeB, portA, portB, inboxA, inboxB, a, b, collabId };
}

test('治理验收：显式交接（ws_handover 全链，先确认后删除）', { timeout: 120000 }, async (t) => {
  const studio = await startStudio(t);
  const { a, b, homeA, collabId } = studio;
  const statusB = (await callTool(b, 'ws_status')).payload;
  const handed = await callTool(a, 'ws_handover', { collabId, target: statusB.instanceId });
  assert.equal(handed.isError, false, String(handed.payload));
  assert.ok(handed.payload.message.includes('移交完成'));
  const bListed = (await callTool(b, 'ws_list_collabs')).payload.collabs.find((entry) => entry.collabId === collabId);
  assert.equal(bListed.role, 'manager');
  const aListed = (await callTool(a, 'ws_list_collabs')).payload.collabs.find((entry) => entry.collabId === collabId);
  assert.equal(aListed.role, 'member');
  assert.equal(existsSync(join(homeA, 'collabs', collabId, 'ledger.jsonl')), false, '旧席位台账已清理');
  const bLedger = await callTool(b, 'ws_view_ledger', { collabId });
  assert.equal(bLedger.payload.source, 'local');
  assert.equal(bLedger.payload.ledger.manager.instanceId, statusB.instanceId);
});

test('治理验收：失联抢接（ws_take_over 全链）+ 原驿丞重启握手降级', { timeout: 180000 }, async (t) => {
  const studio = await startStudio(t);
  const { a, b, homeA, portA, inboxA, collabId } = studio;
  const statusA = (await callTool(a, 'ws_status')).payload;
  await a.close();
  await waitForRebindable(portA);
  await waitFor(async () => {
    const listed = (await callTool(b, 'ws_list_collabs')).payload.collabs;
    const entry = listed.find((candidate) => candidate.collabId === collabId);
    return entry !== undefined && entry.managerOffline === true ? true : null;
  }, { timeoutMs: 30000 });
  const verdict = await callTool(b, 'ws_take_over', { collabId });
  assert.equal(verdict.isError, false, String(verdict.payload));
  assert.equal(verdict.payload.phase, 'awaiting-confirm');
  const applied = await callTool(b, 'ws_take_over', { collabId, confirm: true });
  assert.equal(applied.isError, false, String(applied.payload));
  const bListed = (await callTool(b, 'ws_list_collabs')).payload.collabs.find((entry) => entry.collabId === collabId);
  assert.equal(bListed.role, 'manager');
  const bLedger = await callTool(b, 'ws_view_ledger', { collabId });
  assert.equal(bLedger.payload.ledger.manager.instanceId, (await callTool(b, 'ws_status')).payload.instanceId);
  assert.equal(bLedger.payload.ledger.version, verdict.payload.baseVersion, '版本跨抢接延续');
  /* 原驿丞重启：握手 / 通告送达识出已被替换 → 降级 */
  const a2 = await startStation(t, { home: homeA, port: portA, inbox: inboxA });
  await waitFor(async () => {
    const listed = (await callTool(a2, 'ws_list_collabs')).payload.collabs;
    const entry = listed.find((candidate) => candidate.collabId === collabId);
    return entry !== undefined && entry.role === 'member' ? true : null;
  }, { timeoutMs: 30000 });
  const aStats = (await callTool(a2, 'ws_status')).payload.collab;
  assert.equal(aStats.takeoverDowngrades >= 1, true, '降级计数留痕');
  assert.equal(existsSync(join(homeA, 'collabs', collabId, 'ledger.jsonl')), false, '降级即清理本地台账');
  assert.equal(statusA.instanceId.length > 0, true);
});

test('治理验收：交接目标离线 → 明确拒绝并指引（在线校验经即时探测通道）', { timeout: 120000 }, async (t) => {
  const studio = await startStudio(t);
  const { a, b, portB, collabId } = studio;
  const statusB = (await callTool(b, 'ws_status')).payload;
  await b.close();
  await waitForRebindable(portB);
  const handed = await callTool(a, 'ws_handover', { collabId, target: statusB.instanceId });
  assert.equal(handed.isError, true);
  assert.ok(handed.payload.includes('离线'), String(handed.payload));
  assert.ok(handed.payload.includes('ws_take_over'), '应急指引');
  const aListed = (await callTool(a, 'ws_list_collabs')).payload.collabs.find((entry) => entry.collabId === collabId);
  assert.equal(aListed.role, 'manager', '未完成移交：席位保持');
});
