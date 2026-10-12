import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
  const client = new Client({ name: 'waystation-m4-e2e', version: '0.0.0' });
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
  const homeA = makeTempDir(t);
  const homeB = makeTempDir(t);
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
  const sent = await callTool(a, 'ws_send_message', { collabId, text: '请查收联调事项' });
  assert.equal(sent.payload.tier, 'queued');
  await waitFor(() => (inboxB.receivedText().includes('请查收联调事项') ? true : null), { timeoutMs: 20000 });
  assert.ok(inboxB.receivedText().includes(`协作：${collabId}`));
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
  assert.equal(sent.payload.tier, 'queued');
  const queued = await callTool(a, 'ws_delivery_status', { msgId: sent.payload.msgId });
  assert.equal(queued.payload[0].tier, 'queued', '对方离线：维持在排队档，不误报');
  const inboxB2 = await startFakeSessionInbox(t);
  const b2 = await startStation(t, { home: homeB, port: portB, inbox: inboxB2 });
  await waitState(b2, collabId, 'active');
  await waitFor(() => (inboxB2.receivedText().includes('离线期间的事项') ? true : null), { timeoutMs: 60000 });
  await waitFor(async () => {
    const row = (await callTool(a, 'ws_delivery_status', { msgId: sent.payload.msgId })).payload[0];
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
