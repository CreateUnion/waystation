import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { pickFreePort, repoRoot, waitFor } from './helpers.js';
import { coreJsonPath } from '../src/paths.js';

/* 复现探针（问题 7）：真桥进程 + 真核心进程——桥注册后 SIGKILL 核心，零工具调用观察
 * 桥是否自动重连、新核是否拿到重注册（sessions/<sessionId>.json 的 pid 换为新核心 pid）。
 * 三桥用例是 2026-11-01 事故的直接形态；修复前实测约 61s（多桥并发冷启 + core.json
 * rename EPERM + startupError 阻断），修复后应在秒级。
 * 收尾顺序写死：先关桥客户端并等桥进程退场，再按 core.json 收核心，最后删临时目录——
 * 桥仍活着时杀核会被它冷启回来，目录先删则核的写盘与删除竞态。 */

const SESSION_ID = 'session-repro-reconnect';
const INDEX_ENTRY = join(repoRoot, 'src', 'index.js');

function writeStationConfig(home, port) {
  writeFileSync(join(home, 'config.json'), JSON.stringify({ port }));
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function sessionFileOf(home, sessionId = SESSION_ID) {
  return join(home, 'sessions', `${sessionId}.json`);
}

/* 复现专用数据根：收尾钩子只注册一次，内部按「关桥 → 等桥退场 → 收核 → 删目录」顺序执行。 */
function makeReproHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'waystation-repro-'));
  const clients = [];
  const bridgePids = [];
  t.after(async () => {
    for (const client of clients) {
      await client.close().catch(() => {});
    }
    for (const pid of bridgePids) {
      await waitFor(() => !isAlive(pid), { timeoutMs: 8000, intervalMs: 50 }).catch(() => {});
      if (isAlive(pid)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // 已退出
        }
      }
    }
    const record = readJson(coreJsonPath(home));
    if (record !== null && Number.isInteger(record.pid) && isAlive(record.pid)) {
      try {
        process.kill(record.pid, 'SIGKILL');
      } catch {
        // 已退出
      }
    }
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { home, clients, bridgePids };
}

async function startBridgeProbe(harness, sessionId) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [INDEX_ENTRY],
    cwd: repoRoot,
    env: {
      ...process.env,
      WAYSTATION_HOME: harness.home,
      CLAUDE_CODE_SESSION_ID: sessionId,
      WAYSTATION_TEST_DISABLE_DISCOVERY: '1',
    },
  });
  const client = new Client({ name: `repro-${sessionId}`, version: '0.0.0' });
  harness.clients.push(client);
  await client.connect(transport);
  /* connect 才真正 spawn 桥进程：pid 必须在 connect 之后取（之前恒为 null，收尾会漏杀）。 */
  if (transport.pid !== null) {
    harness.bridgePids.push(transport.pid);
  }
  /* 触发一次核心冷启与注册（真实使用中 MCP 初始化后也会发生首个工具调用；探针需先有「已连核心」态）。 */
  const status = await client.callTool({ name: 'ws_status', arguments: {} });
  assert.equal(status.isError, undefined, status.content?.[0]?.text);
  return client;
}

async function waitForReadyCore(home) {
  return waitFor(() => {
    const record = readJson(coreJsonPath(home));
    return record !== null && record.status === 'ready' ? record : null;
  }, { timeoutMs: 30000 });
}

async function waitForSessionsOnPid(home, sessionIds, pid) {
  await waitFor(() => sessionIds.every((id) => readJson(sessionFileOf(home, id))?.pid === pid), { timeoutMs: 15000 });
}

/* 三桥恢复轮询：记录每个会话首次被新核重写的耗时。 */
async function waitForAllReregistered(home, sessionIds, oldPid, tiedAt, recovered) {
  await waitFor(() => {
    const record = readJson(coreJsonPath(home));
    if (record === null || !isAlive(record.pid) || record.pid === oldPid) {
      return false;
    }
    for (const id of sessionIds) {
      if (!recovered.has(id) && readJson(sessionFileOf(home, id))?.pid === record.pid) {
        recovered.set(id, Date.now() - tiedAt);
      }
    }
    return recovered.size === sessionIds.length;
  }, { timeoutMs: 90000, intervalMs: 10 });
}

function reportRecovery(home, sessionIds, recovered) {
  const finalRecord = readJson(coreJsonPath(home));
  console.log(`[三桥复现] 结果：${JSON.stringify({ elapsedMs: Object.fromEntries(recovered), corePid: finalRecord?.pid })}`);
  for (const id of sessionIds) {
    if (!recovered.has(id)) {
      console.log(`[三桥复现] 未恢复：${id} session=${JSON.stringify(readJson(sessionFileOf(home, id)))}`);
    }
  }
}

test('复现：三桥同时在线——核心 SIGKILL 后零工具调用各自重连计时', { timeout: 120000 }, async (t) => {
  const harness = makeReproHome(t);
  writeStationConfig(harness.home, await pickFreePort());
  const sessionIds = ['session-repro-a', 'session-repro-b', 'session-repro-c'];
  for (const sessionId of sessionIds) {
    await startBridgeProbe(harness, sessionId);
  }
  const oldPid = (await waitForReadyCore(harness.home)).pid;
  await waitForSessionsOnPid(harness.home, sessionIds, oldPid);
  console.log(`[三桥复现] 三桥注册完成：core pid=${oldPid}`);

  const tiedAt = Date.now();
  process.kill(oldPid, 'SIGKILL');
  console.log(`[三桥复现] 已 SIGKILL 核心 pid=${oldPid}`);
  const recovered = new Map();
  try {
    await waitForAllReregistered(harness.home, sessionIds, oldPid, tiedAt, recovered);
  } finally {
    reportRecovery(harness.home, sessionIds, recovered);
  }
  assert.equal(recovered.size, sessionIds.length, '三桥都应在零工具调用下完成新核重注册');
  for (const [sessionId, elapsed] of recovered) {
    assert.ok(elapsed < 15000, `${sessionId} 恢复耗时 ${elapsed}ms 必须 < 15s（修复前实测约 61s）`);
  }
});

async function waitForSingleReregistration(home, oldPid, tiedAt) {
  let sawDown = false;
  let newCorePid = null;
  let reregisteredAt = null;
  try {
    await waitFor(() => {
      const record = readJson(coreJsonPath(home));
      if (record === null || record.pid === oldPid || !isAlive(record.pid)) {
        sawDown = true;
        return false;
      }
      newCorePid = record.pid;
      if (readJson(sessionFileOf(home))?.pid === newCorePid) {
        reregisteredAt = Date.now();
        return true;
      }
      return false;
    }, { timeoutMs: 60000, intervalMs: 10 });
  } finally {
    const elapsed = reregisteredAt === null ? null : reregisteredAt - tiedAt;
    console.log(`[复现] ${JSON.stringify({ sawDown, newCorePid, reregisteredAt, elapsedMs: elapsed })}`);
  }
  return reregisteredAt;
}

test('复现：核心 SIGKILL 后空闲桥零工具调用自动重连计时', { timeout: 90000 }, async (t) => {
  const harness = makeReproHome(t);
  writeStationConfig(harness.home, await pickFreePort());
  await startBridgeProbe(harness, SESSION_ID);
  const oldPid = (await waitForReadyCore(harness.home)).pid;
  assert.equal(isAlive(oldPid), true);
  await waitForSessionsOnPid(harness.home, [SESSION_ID], oldPid);
  console.log(`[复现] 初始注册完成：core pid=${oldPid}`);

  const tiedAt = Date.now();
  process.kill(oldPid, 'SIGKILL');
  console.log(`[复现] 已 SIGKILL 核心 pid=${oldPid}，开始零工具调用计时`);
  const reregisteredAt = await waitForSingleReregistration(harness.home, oldPid, tiedAt);
  assert.notEqual(reregisteredAt, null, '桥应在零工具调用下完成新核重注册');
  assert.ok(reregisteredAt - tiedAt < 10000, `单桥恢复耗时 ${reregisteredAt - tiedAt}ms 必须 < 10s`);
});
