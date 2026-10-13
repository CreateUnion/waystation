import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { makeTempDir, pickFreePort, repoRoot, waitFor, waitForRebindable } from './helpers.js';

const INDEX_ENTRY = join(repoRoot, 'src', 'index.js');

/* 假会话收件箱：命名管道上的真实 server（成功路径保持连接、无回执）——
 * 与真适配器的两种表现同一形态；每个站点一份（重开站点用新管道）。 */
async function startFakeSessionInbox(t) {
  const path = `\\\\.\\pipe\\waystation-m4-e2e-${randomUUID()}`;
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

/* 站点进程的统一收尾：node:test 的 after 钩子按注册序执行，而临时目录的删除钩子由 makeTempDir 在其
 * 调用点先行注册——「先关客户端并等站点退出、后删目录」要求收尾钩子先于任何 makeTempDir 注册，否则删除
 * 会与存活站点的写盘（collabs/*、日志）并发，Windows 下 rmdir 撞上新建文件即 ENOTEMPTY 假红。
 * 每个测试实例一份客户端清单（WeakMap 随测试上下文回收），钩子只注册一次。 */
const clientsByTest = new WeakMap();

function cleanupRegistryOf(t) {
  let clients = clientsByTest.get(t);
  if (clients === undefined) {
    clients = [];
    clientsByTest.set(t, clients);
    t.after(async () => {
      for (const client of clients) {
        await closeStation(client);
      }
    });
  }
  return clients;
}

/* 客户端已关（含用例中显式关闭）则忽略重复关闭；否则关闸并等站点进程退出——等完才轮到目录删除钩子。 */
async function closeStation(client) {
  try {
    await client.close();
  } catch {
    // 用例中已显式关闭：忽略重复关闭
  }
}

/* 站点数据目录：收尾钩子必须抢在 makeTempDir 的删除钩子前注册（见上）；目录登记进文件级兜底。 */
function makeStationDir(t) {
  cleanupRegistryOf(t);
  const dir = makeTempDir(t);
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

/* 真实组合根 + 假会话收件箱 + SDK 客户端：与生产装配同参（唯一差异 = 消息套接字指向假收件箱）。
 * 端口与数据目录经预写配置 + WAYSTATION_HOME 注入（显式目录模式，与 server.test.js 同法）。 */
async function startStation(t, { home, port, inbox }) {
  writeFileSync(join(home, 'config.json'), JSON.stringify({ port, scanWindowMs: 300, dialTimeoutMs: 1500, dispatchTickMs: 100, retryIntervalMs: 200, retryFastCount: 100, messageTtlMs: 3600000 }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [INDEX_ENTRY],
    cwd: repoRoot,
    env: { ...process.env, WAYSTATION_HOME: home, CLAUDE_CODE_MESSAGING_SOCKET: inbox.path, CLAUDE_CODE_MESSAGING_TOKEN: inbox.token },
  });
  stationTransports.push(transport);   // 文件级兜底纳管：收尾钩子被跳过时由文件末尾统一关闭
  const client = new Client({ name: 'waystation-m4-e2e', version: '0.0.0' });
  cleanupRegistryOf(t).push(client);   // 清单先于 connect：启动中途失败的站点也纳管
  await client.connect(transport);
  return client;
}

async function callTool(client, name, args = {}) {
  const called = await client.callTool({ name, arguments: args });
  const text = called.content[0].text;
  return { isError: called.isError === true, payload: called.isError === true ? text : JSON.parse(text) };
}

async function listCollabs(client) {
  return (await callTool(client, 'ws_list_collabs')).payload.collabs;
}

async function createCollab(client, target, { name, topic }) {
  const called = await callTool(client, 'ws_create_collab', { name, topic, targets: [target] });
  assert.equal(called.isError, false, String(called.payload));
  return called.payload.collabId;
}

async function waitState(client, collabId, state) {
  await waitFor(async () => {
    const listed = await listCollabs(client);
    return listed.some((entry) => entry.collabId === collabId && entry.state === state) ? true : null;
  }, { timeoutMs: 20000 });
}

async function startTemporaryStudio(t, { name, topic }) {
  const homeA = makeStationDir(t);
  const homeB = makeStationDir(t);
  const portA = await pickFreePort();
  const portB = await pickFreePort();
  const inboxA = await startFakeSessionInbox(t);
  const inboxB = await startFakeSessionInbox(t);
  const a = await startStation(t, { home: homeA, port: portA, inbox: inboxA });
  const b = await startStation(t, { home: homeB, port: portB, inbox: inboxB });
  const statusB = (await callTool(b, 'ws_status')).payload;
  const collabId = await createCollab(a, { instanceId: statusB.instanceId, identityName: statusB.identityName, address: '127.0.0.1', port: portB }, { name, topic });
  await waitFor(async () => {
    const listed = await listCollabs(b);
    return listed.some((entry) => entry.collabId === collabId) ? true : null;
  }, { timeoutMs: 20000 });
  return { homeA, homeB, portA, portB, inboxA, inboxB, a, b, collabId };
}

test('验收预演：邀请→同意→对话→看台账（双真实实例全流程）', { timeout: 120000 }, async (t) => {
  const made = await startTemporaryStudio(t, { name: '联调项目', topic: '发布联调' });
  const { homeB, inboxA, inboxB, a, b, collabId } = made;
  await waitFor(() => (inboxB.receivedText().includes('联调项目') ? true : null), { timeoutMs: 20000 });
  const inviteText = inboxB.receivedText();
  assert.ok(inviteText.includes('【驿站｜另一会话发来的协作消息】'));
  assert.ok(inviteText.includes('项目：联调项目'), '描述器接线：本地记录建立后上下文头含项目名');
  assert.equal((await callTool(b, 'ws_approve_invite', { collabId, approve: true })).isError, false);
  await waitState(a, collabId, 'active');
  await waitState(b, collabId, 'active');
  const preSendLength = inboxB.receivedText().length;   // 对话消息的增量边界：断言只锚发送后新增的帧
  const sent = await callTool(a, 'ws_send_message', { collabId, text: '请查收联调事项' });
  assert.equal(sent.isError, false, String(sent.payload));
  assert.equal(sent.payload.results[0].ok, true, '目标在册：消息已受理入队');
  await waitFor(() => (inboxB.receivedText().includes('请查收联调事项') ? true : null), { timeoutMs: 20000 });
  const chatFrame = inboxB.receivedText().slice(preSendLength).split('【驿站｜另一会话发来的协作消息】').find((part) => part.includes('请查收联调事项'));
  assert.ok(chatFrame !== undefined && chatFrame.includes(`协作：${collabId}`), '对话消息自身的上下文头含协作标识');
  /* 档位真值（设计 §10 三档）：对方会话收到后投递回报回传，本侧档位由 queued 推进到 session */
  await waitFor(async () => {
    const row = (await callTool(a, 'ws_delivery_status', { msgId: sent.payload.msgId })).payload.rows[0];
    return row !== undefined && row.tier === 'session' ? true : null;
  }, { timeoutMs: 20000 });
  assert.equal((await callTool(b, 'ws_send_message', { collabId, text: '收到，开始处理' })).isError, false);
  await waitFor(() => (inboxA.receivedText().includes('收到，开始处理') ? true : null), { timeoutMs: 20000 });
  const viewed = await callTool(b, 'ws_view_ledger', { collabId });
  assert.equal(viewed.payload.source, 'live');
  assert.equal(viewed.payload.ledger.status, 'active');
  assert.equal(viewed.payload.ledger.members.length, 2);
  /* 文件级证据：成员记录定格、快照与收件流水落盘（各机终态数据本地保留的基础） */
  const collabDir = join(homeB, 'collabs', collabId);
  const member = JSON.parse(readFileSync(join(collabDir, 'member.json'), 'utf8'));
  assert.equal(member.decision, 'approved');
  assert.equal(member.state, 'active');
  assert.equal(existsSync(join(collabDir, 'snapshot.json')), true);
  assert.equal(existsSync(join(collabDir, 'inbox.jsonl')), true);
});

test('验收预演：拒绝不走自动建立；整条撤回使双方终止', { timeout: 120000 }, async (t) => {
  const made = await startTemporaryStudio(t, { name: '拒收项目', topic: '主题' });
  const { a, b, collabId } = made;
  assert.equal((await callTool(b, 'ws_approve_invite', { collabId, approve: false, reason: '人手不足' })).isError, false);
  await waitFor(async () => {
    const viewed = await callTool(a, 'ws_view_ledger', { collabId });
    const member = viewed.payload.ledger.members.find((entry) => entry.role === 'member');
    return member !== undefined && member.state === 'declined' ? true : null;
  }, { timeoutMs: 20000 });
  const state = (await listCollabs(a)).find((entry) => entry.collabId === collabId).state;
  assert.equal(state, 'proposed', '全部拒绝保持提议中（不自动建立、不自动终止）');
  assert.equal((await callTool(a, 'ws_withdraw_invite', { collabId })).isError, false);
  await waitState(b, collabId, 'terminated');
  await waitState(a, collabId, 'terminated');
});

test('验收预演：离线续投（乙关会话 → 排队 → 重开续投至第三档）', { timeout: 180000 }, async (t) => {
  const made = await startTemporaryStudio(t, { name: '续投项目', topic: '主题' });
  const { homeB, portB, a, b, collabId } = made;
  assert.equal((await callTool(b, 'ws_approve_invite', { collabId, approve: true })).isError, false);
  await waitState(a, collabId, 'active');
  await waitState(b, collabId, 'active');
  await b.close();
  await waitForRebindable(portB);
  const sent = await callTool(a, 'ws_send_message', { collabId, text: '离线期间的事项' });
  assert.equal(sent.isError, false, String(sent.payload));
  assert.equal(sent.payload.results[0].ok, true, '对方离线但端点已知：消息仍被受理入队');
  const queued = await callTool(a, 'ws_delivery_status', { msgId: sent.payload.msgId });
  assert.equal(queued.payload.rows[0].tier, 'queued', '对方离线：维持在排队档，不误报');
  const inboxB2 = await startFakeSessionInbox(t);
  const b2 = await startStation(t, { home: homeB, port: portB, inbox: inboxB2 });
  await waitState(b2, collabId, 'active');
  await waitFor(() => (inboxB2.receivedText().includes('离线期间的事项') ? true : null), { timeoutMs: 60000 });
  await waitFor(async () => {
    const row = (await callTool(a, 'ws_delivery_status', { msgId: sent.payload.msgId })).payload.rows[0];
    return row !== undefined && row.tier === 'session' ? true : null;
  }, { timeoutMs: 30000 });
});

test('验收预演：结束与终态门控（通告投递、双侧拒绝、归档可读）', { timeout: 120000 }, async (t) => {
  const made = await startTemporaryStudio(t, { name: '收尾项目', topic: '主题' });
  const { inboxB, a, b, collabId } = made;
  assert.equal((await callTool(b, 'ws_approve_invite', { collabId, approve: true })).isError, false);
  await waitState(a, collabId, 'active');
  await waitState(b, collabId, 'active');
  assert.equal((await callTool(a, 'ws_end_collab', { collabId })).isError, false);
  await waitState(b, collabId, 'completed');
  await waitFor(() => (inboxB.receivedText().includes('类型：end') ? true : null), { timeoutMs: 20000 });
  assert.equal((await callTool(a, 'ws_send_message', { collabId, text: '结束后发送' })).isError, true);
  assert.equal((await callTool(b, 'ws_send_message', { collabId, text: '结束后发送' })).isError, true);
  assert.equal((await callTool(a, 'ws_end_collab', { collabId })).isError, true, '重复结束拒绝');
  const archivedView = await callTool(b, 'ws_view_ledger', { collabId });
  assert.equal(archivedView.payload.archived, true);
  assert.equal(archivedView.payload.ledger.status, 'completed');
});

test('验收预演：管理者离线 → 读快照回退并标注可能非最新', { timeout: 120000 }, async (t) => {
  const made = await startTemporaryStudio(t, { name: '回退项目', topic: '主题' });
  const { homeB, portA, a, b, collabId } = made;
  assert.equal((await callTool(b, 'ws_approve_invite', { collabId, approve: true })).isError, false);
  await waitState(b, collabId, 'active');
  await waitFor(() => (existsSync(join(homeB, 'collabs', collabId, 'snapshot.json')) ? true : null), { timeoutMs: 20000 });
  await a.close();
  await waitForRebindable(portA);
  const viewed = await callTool(b, 'ws_view_ledger', { collabId });
  assert.equal(viewed.payload.source, 'snapshot');
  assert.ok(viewed.payload.note.includes('可能非最新'));
  assert.equal(viewed.payload.ledger.status, 'active');
});
