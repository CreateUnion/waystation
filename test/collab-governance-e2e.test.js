import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { INSTANCE_ID_FILE } from '../src/instance-id.js';
import { coreJsonPath } from '../src/paths.js';
import { makeTempDir, pickFreePort, repoRoot, testDiscoveryOffEnv, waitFor, waitForRebindable } from './helpers.js';
import { seedSessionCollab } from './helpers/session-participants.js';

const INDEX_ENTRY = join(repoRoot, 'src', 'index.js');

/* 治理验收预演（真实组合根 × 2 + 假会话收件箱）：显式交接、失联抢接与离线拒绝走 ws_* 工具面全链。
 *
 * 夹具形态（consume-only）：两站以**预置协作目录**启动（carrier(session-seats) + 新台账 + seats/）——
 * 本文件不经 create/invite/join 的产品路径，只覆盖 ws_handover / ws_take_over 工具链与离线拒绝；
 * 创建/邀请/加入由 e2e-session-invites 等套件覆盖。
 *
 * 用例调整（设计依据）：
 * - 「失联抢接 + 原站长重启握手降级」：服务层 takeOver 已改为成员席位可发起（managerOnly:false），
 *   降级后旧站长保留只读台账副本；本用例恢复运行。
 * - 「旧席位台账已清理」断言：§2A.4③ 要求保留本地只读副本；主交接用例断言快照副本存在。
 *
 * 发现隔离：临时核心经 testDiscoveryOffEnv 关闭真实 LAN 广播/探测（WAYSTATION_TEST_DISABLE_DISCOVERY），
 * 启动后还以 ws_status 硬断言核心进程实际读到开关（disabled=true、未绑定 UDP、无扫描）。 */

/* 会话标识：同数据根稳定（重开站点＝原会话重连，绑定恢复活跃）；不同数据根互异。 */
const sessionIdsByHome = new Map();

function sessionIdFor(home) {
  if (!sessionIdsByHome.has(home)) {
    sessionIdsByHome.set(home, `session-gov-${sessionIdsByHome.size + 1}`);
  }
  return sessionIdsByHome.get(home);
}

/* 预置实例标识：协作台账的站长/成员席位必须指向真实实例——先写 instance-id 再起核心。 */
function seedInstanceId(home, instanceId) {
  writeFileSync(join(home, INSTANCE_ID_FILE), instanceId, 'utf8');
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

/* 文件级兜底：任何收尾钩子被跳过（如钩子抛错）都会留下未关闭的站点——强制关闭并响亮失败。 */
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

/* 治理节奏：短探测 / 短宽限；0.2.0 配置键（managerLossTimeoutMs；takeoverWindowMs 语义退役）。 */
function writeStationConfig(home, port, identityName, extra = {}) {
  writeFileSync(join(home, 'config.json'), JSON.stringify({
    identityName,
    port,
    scanWindowMs: 300,
    dialTimeoutMs: 1500,
    dispatchTickMs: 100,
    retryIntervalMs: 200,
    retryFastCount: 100,
    messageTtlMs: 3600000,
    /* 0.2.0 配置下界（config.js）：低于下界的值会整组回落到产品默认，夹具必须给合法值——
     * 失联判定最快 30s，因此本文件的失联用例按 30s+ 等待。 */
    managerProbeIntervalMs: 200,
    managerLossTimeoutMs: 30000,
    sessionTakeoverWindowMs: 60000,
    sessionSeatGraceMs: 5000,
    sessionSeatTimeoutMs: 30000,
    seatPresenceIntervalMs: 5000,
    handoverConfirmTimeoutMs: 15000,
    joinConfirmTtlMs: 10000,
    ...extra,
    viewerAutoOpen: false,
  }));
}

async function startStation(t, { home, inbox }) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [INDEX_ENTRY],
    cwd: repoRoot,
    env: testDiscoveryOffEnv({
      WAYSTATION_HOME: home,
      CLAUDE_CODE_SESSION_ID: sessionIdFor(home),
      CLAUDE_CODE_MESSAGING_SOCKET: inbox.path,
      CLAUDE_CODE_MESSAGING_TOKEN: inbox.token,
      WAYSTATION_TEST_GRACE_MS: '1200',
    }),
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

/* 发现隔离硬断言：ws_status 由核心进程应答，disabled=true 证明子进程真的收到隔离开关；
 * bound=false / scanning=0 证明没有 UDP 绑定与扫描轮次（静态 env 传递链不再作为唯一依据）。 */
async function assertDiscoveryIsolated(client) {
  const status = await callTool(client, 'ws_status', { view: 'full' });
  assert.equal(status.isError, false, String(status.payload));
  const discovery = status.payload.net?.counters?.discovery;
  assert.ok(discovery !== undefined, 'ws_status 暴露发现层状态');
  assert.equal(discovery.disabled, true, '核心进程读到发现隔离开关（子进程环境传递到位）');
  assert.equal(discovery.bound, false, '发现层未绑定 UDP');
  assert.equal(discovery.scanning, 0, '发现层无扫描轮次');
}

/* —— 预置双站协作（A 站长 / B 成员） —— */

const COLLAB = 'collab-gov-e2e';
const INST_A = 'inst-gov-a';
const INST_B = 'inst-gov-b';

function membersOf(homeA, homeB) {
  return [
    { instanceId: INST_A, sessionId: sessionIdFor(homeA), identityName: '治理甲', role: 'manager', joinSeq: 1 },
    { instanceId: INST_B, sessionId: sessionIdFor(homeB), identityName: '治理乙', role: 'member', joinSeq: 2 },
  ];
}

function seedHomes(homeA, homeB, portA, portB) {
  seedInstanceId(homeA, INST_A);
  seedInstanceId(homeB, INST_B);
  const endpoints = {
    [INST_A]: { address: '127.0.0.1', port: portA },
    [INST_B]: { address: '127.0.0.1', port: portB },
  };
  const common = {
    name: '治理项目',
    status: 'active',
    managerTerm: 1,
    version: 3,
    manager: { instanceId: INST_A, sessionId: sessionIdFor(homeA), identityName: '治理甲' },
    members: membersOf(homeA, homeB),
    endpoints,
    snapshotFrom: INST_A,
  };
  seedSessionCollab(homeA, COLLAB, {
    ...common,
    seats: [{ sessionId: sessionIdFor(homeA), role: 'manager', joinSeq: 1 }],
  });
  seedSessionCollab(homeB, COLLAB, {
    ...common,
    seats: [{ sessionId: sessionIdFor(homeB), role: 'member', joinSeq: 2 }],
    member: {
      collabId: COLLAB,
      name: '治理项目',
      topic: '治理项目 主题',
      role: 'member',
      state: 'active',
      manager: { instanceId: INST_A, sessionId: sessionIdFor(homeA), identityName: '治理甲' },
      endpoints,
      roster: membersOf(homeA, homeB),
      mode: 'managed',
      decision: 'approved',
    },
  });
}

async function startStudio(t, extraConfig = {}) {
  const homeA = makeStationDir(t);
  const homeB = makeStationDir(t);
  const portA = await pickFreePort();
  const portB = await pickFreePort();
  const inboxA = await startFakeSessionInbox(t);
  const inboxB = await startFakeSessionInbox(t);
  writeStationConfig(homeA, portA, '治理甲', extraConfig);
  writeStationConfig(homeB, portB, '治理乙', extraConfig);
  seedHomes(homeA, homeB, portA, portB);
  const a = await startStation(t, { home: homeA, port: portA, inbox: inboxA });
  const b = await startStation(t, { home: homeB, port: portB, inbox: inboxB });
  for (const client of [a, b]) {
    await waitFor(async () => {
      const listed = (await callTool(client, 'ws_list_collabs')).payload.collabs;
      const entry = listed.find((candidate) => candidate.collabId === COLLAB);
      return entry !== undefined && entry.state === 'active' ? true : null;
    }, { timeoutMs: 20000 });
    await assertDiscoveryIsolated(client);
  }
  return { homeA, homeB, portA, portB, inboxA, inboxB, a, b };
}

function roleOf(listed, collabId) {
  return listed.collabs.find((entry) => entry.collabId === collabId)?.role ?? null;
}

function parseChallenge(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/* 目标侧确认一次：offer 尚未到达→null（重试）；挑战→携令牌确认。
 * 首调必须是挑战：若工具退化为一次调用直接确认，这里持续返回 null，用例按超时红暴露回归。 */
async function confirmOfferOnTarget(client, offerId) {
  const challenge = await callTool(client, 'ws_handover', { collabId: COLLAB, offerId });
  if (challenge.isError !== true) {
    return null;
  }
  const parsed = parseChallenge(challenge.payload);
  if (parsed?.needsUserConfirmation !== true) {
    return null;
  }
  const confirmed = await callTool(client, 'ws_handover', { collabId: COLLAB, offerId, confirmToken: parsed.confirmToken });
  return confirmed.isError === true ? null : confirmed;
}

test('治理验收：显式交接（ws_handover 两段式确认，旧站长降级、快照副本保留）', { timeout: 120000 }, async (t) => {
  const studio = await startStudio(t);
  const { a, b, homeA } = studio;
  const handed = await callTool(a, 'ws_handover', {
    collabId: COLLAB,
    target: INST_B,
    targetSessionId: sessionIdFor(studio.homeB),
  });
  assert.equal(handed.isError, false, String(handed.payload));
  assert.ok(handed.payload.offerId, '站长发起即返回 offerId（不阻塞等待确认）');

  /* 目标侧确认：首次只签发挑战，用户确认后携 confirmToken 重试。offer 经网络到达后才可确认。 */
  const accepted = await waitFor(() => confirmOfferOnTarget(b, handed.payload.offerId), { timeoutMs: 30000 });

  assert.equal(accepted.isError, false, String(accepted.payload));
  await waitFor(async () => {
    const listedB = (await callTool(b, 'ws_list_collabs')).payload.collabs;
    return roleOf({ collabs: listedB }, COLLAB) === 'manager' ? true : null;
  }, { timeoutMs: 30000 });
  await waitFor(async () => {
    const listedA = (await callTool(a, 'ws_list_collabs')).payload.collabs;
    return roleOf({ collabs: listedA }, COLLAB) === 'member' ? true : null;
  }, { timeoutMs: 30000 });

  const bLedger = await callTool(b, 'ws_view_ledger', { collabId: COLLAB });
  assert.equal(bLedger.payload.ledger.manager.instanceId, INST_B);
  assert.equal(bLedger.payload.ledger.managerTerm, 2);
  assert.equal(existsSync(join(homeA, 'collabs', COLLAB, 'snapshot.json')), true, '旧站长保留只读快照副本');
});

/* 失联抢接全链：关闭并收掉原站长核心 → B 按探测判失联 → 成员会话发起 ws_take_over（挑战 + 令牌）→ B 成为站长。 */
test('治理验收：失联抢接（ws_take_over 全链，成员会话发起）', { timeout: 120000 }, async (t) => {
  const studio = await startStudio(t);
  const { a, b, homeA, portA } = studio;
  await a.close();
  /* 模拟原站长整机离线：桥退场后核心可能按存续宽限继续监听——显式收核再等端口释放。 */
  killCoreOf(homeA);
  await waitForRebindable(portA, { timeoutMs: 15000 });
  await waitFor(async () => {
    const listed = (await callTool(b, 'ws_list_collabs')).payload.collabs;
    const entry = listed.find((candidate) => candidate.collabId === COLLAB);
    return entry !== undefined && entry.managerOffline === true ? true : null;
  }, { timeoutMs: 45000 });
  const verdict = await callTool(b, 'ws_take_over', { collabId: COLLAB });
  assert.equal(verdict.isError, true, '首次调用只签发确认挑战');
  const challenge = parseChallenge(verdict.payload);
  assert.equal(challenge?.needsUserConfirmation, true, String(verdict.payload));
  assert.equal(typeof challenge.confirmToken, 'string');
  const applied = await callTool(b, 'ws_take_over', { collabId: COLLAB, confirmToken: challenge.confirmToken });
  assert.equal(applied.isError, false, String(applied.payload));
  const bLedger = await callTool(b, 'ws_view_ledger', { collabId: COLLAB });
  assert.equal(bLedger.payload.ledger.manager.instanceId, INST_B, '接管生效：新站长为 B');
  assert.equal(bLedger.payload.ledger.managerTerm, 2, '任期 +1');
  const listedB = (await callTool(b, 'ws_list_collabs')).payload.collabs;
  assert.equal(roleOf({ collabs: listedB }, COLLAB), 'manager');
});

/* 旧站长重启降级：§2A.8⑥ 要求重启后按 handshake 学到更高任期并向新站长取快照采纳。
 * 授权链绑定「快照来源机器本人的直连 handshake 应答」与其报告的 term/manager/managerEndpoint；
 * D15 定向重发持续到 ack 或被更高任期取代（时长不低于失联判定窗口）。 */
test('治理验收：原站长重启握手降级（旧站长按更高任期退回成员）', { timeout: 120000 }, async (t) => {
  const studio = await startStudio(t);
  const { a, b, homeA, portA, inboxA } = studio;
  await a.close();
  killCoreOf(homeA);
  await waitForRebindable(portA, { timeoutMs: 15000 });
  await waitFor(async () => {
    const listed = (await callTool(b, 'ws_list_collabs')).payload.collabs;
    const entry = listed.find((candidate) => candidate.collabId === COLLAB);
    return entry !== undefined && entry.managerOffline === true ? true : null;
  }, { timeoutMs: 45000 });
  const verdict = await callTool(b, 'ws_take_over', { collabId: COLLAB });
  assert.equal(verdict.isError, true);
  const challenge = parseChallenge(verdict.payload);
  await callTool(b, 'ws_take_over', { collabId: COLLAB, confirmToken: challenge.confirmToken });
  const a2 = await startStation(t, { home: homeA, port: portA, inbox: inboxA });
  await waitFor(async () => {
    const listed = (await callTool(a2, 'ws_list_collabs')).payload.collabs;
    return roleOf({ collabs: listed }, COLLAB) === 'member' ? true : null;
  }, { timeoutMs: 30000, intervalMs: 250 });
  const bStatus = await callTool(b, 'ws_status', { view: 'full' });
  assert.equal(bStatus.payload.collab.handshakesIn >= 1, true, '可达 peer（B）应答了重启站长的握手');
  await assertDiscoveryIsolated(a2);
});

test('治理验收：交接目标离线 → 明确拒绝并指引（在线校验经即时探测通道）', { timeout: 120000 }, async (t) => {
  const studio = await startStudio(t);
  const { a, b, portB, homeB } = studio;
  await b.close();
  killCoreOf(homeB);
  await waitForRebindable(portB, { timeoutMs: 30000 });
  const handed = await callTool(a, 'ws_handover', {
    collabId: COLLAB,
    target: INST_B,
    targetSessionId: sessionIdFor(homeB),
  });
  assert.equal(handed.isError, true);
  assert.ok(handed.payload.includes('离线'), String(handed.payload));
  assert.ok(handed.payload.includes('ws_take_over'), '应急指引');
  const aListed = (await callTool(a, 'ws_list_collabs')).payload.collabs;
  assert.equal(roleOf({ collabs: aListed }, COLLAB), 'manager', '未完成移交：席位保持');
});
