import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import {
  MESSAGING_SOCKET_ENV,
  MESSAGING_TOKEN_ENV,
  createClaudeCodeAdapter,
  renderSessionMessage,
} from '../src/adapters/claude-code.js';
import { waitFor } from './helpers.js';

function quietLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function pipePath() {
  return `\\\\.\\pipe\\waystation-adapter-test-${randomUUID()}`;
}

/* 假会话收件箱：命名管道上的真实 server。保持连接 = 成功路径（真实 CLI 成功时连接保持、无回执）；
 * reject = 模拟认证不过 / 拒收（真实 CLI 收到坏数据后立即关闭连接——本机实测 2ms 级）。 */
async function startFakeInbox(t, { reject = false } = {}) {
  const path = pipePath();
  const frames = [];
  const server = net.createServer((socket) => {
    if (reject) {
      socket.destroy();
      return;
    }
    socket.on('data', (chunk) => frames.push(chunk));
  });
  await new Promise((resolve, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(path, resolve);
  });
  t.after(() => server.close());
  return { path, receivedText: () => Buffer.concat(frames).toString('utf8') };
}

function adapterFor(path, { token = 'tok-1' } = {}) {
  return createClaudeCodeAdapter({
    env: { [MESSAGING_SOCKET_ENV]: path, [MESSAGING_TOKEN_ENV]: token },
    log: quietLog(),
  });
}

function sampleFrame(overrides = {}) {
  return {
    v: 1,
    msgId: 'm-1',
    type: 'notice',
    from: { instanceId: 'inst-a', identityName: '主机甲', port: 7321 },
    collabId: 'collab-1',
    ts: '2026-10-12T00:00:00.000Z',
    payload: { text: '请查收' },
    ...overrides,
  };
}

test('available：无 env 时不可用，deliver 立即 false 并计数', async () => {
  const adapter = createClaudeCodeAdapter({ env: {}, log: quietLog() });
  assert.equal(adapter.available(), false);
  assert.equal(await adapter.deliver('你好'), false);
  assert.equal(adapter.stats().unavailable, 1);
});

test('帧形态：首行认证帧 + user 帧（msg_id/uuid 齐全、缺省不带 priority）', { timeout: 15000 }, async (t) => {
  const inbox = await startFakeInbox(t);
  const adapter = adapterFor(inbox.path);
  assert.equal(await adapter.deliver('你好，乙'), true);
  await waitFor(() => inbox.receivedText() !== '');
  const lines = inbox.receivedText().trim().split('\n');
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), { type: 'auth', token: 'tok-1' });
  const user = JSON.parse(lines[1]);
  assert.equal(user.type, 'user');
  assert.equal(user.message.content, '你好，乙');
  assert.equal('priority' in user, false);
  assert.match(user.msg_id, /^[0-9a-f-]{36}$/);
  assert.match(user.uuid, /^[0-9a-f-]{36}$/);
  assert.equal(adapter.stats().delivered, 1);
});

test('priority：仅显式给出时进入 user 帧（可打断能力保留、生产缺省不用）', { timeout: 15000 }, async (t) => {
  const inbox = await startFakeInbox(t);
  const adapter = adapterFor(inbox.path);
  assert.equal(await adapter.deliver('紧急', { priority: 'now' }), true);
  await waitFor(() => inbox.receivedText() !== '');
  const user = JSON.parse(inbox.receivedText().trim().split('\n')[1]);
  assert.equal(user.priority, 'now');
});

test('内容 UTF-8 无损：中文、emoji、多行文本字节级保留', { timeout: 15000 }, async (t) => {
  const inbox = await startFakeInbox(t);
  const adapter = adapterFor(inbox.path);
  const content = '第一行\n第二行 🚀 中文';
  assert.equal(await adapter.deliver(content), true);
  await waitFor(() => inbox.receivedText() !== '');
  const user = JSON.parse(inbox.receivedText().trim().split('\n')[1]);
  assert.equal(user.message.content, content);
});

test('成败判定：对端收到即关闭 → false（拒收不计入已投递）', { timeout: 15000 }, async (t) => {
  const inbox = await startFakeInbox(t, { reject: true });
  const adapter = adapterFor(inbox.path);
  assert.equal(await adapter.deliver('这条会被拒收'), false);
  assert.equal(adapter.stats().delivered, 0);
  assert.ok(adapter.stats().rejected >= 1);
});

test('连接失败（管道不存在）：false + 计数、不抛出', { timeout: 15000 }, async () => {
  const adapter = adapterFor(pipePath());
  assert.equal(await adapter.deliver('无人接收'), false);
  assert.ok(adapter.stats().failed >= 1);
});

test('上下文头：含协作 / 来源 / 类型 / 外部数据警示；describeCollab 命中含项目名、缺省省略、异常降级', () => {
  const frame = sampleFrame();
  const withName = renderSessionMessage(frame, { describeCollab: () => ({ name: '发布协作' }) });
  assert.ok(withName.includes('项目：发布协作'));
  assert.ok(withName.includes('协作：collab-1'));
  assert.ok(withName.includes('来自：主机甲（实例 inst-a）'));
  assert.ok(withName.includes('类型：notice'));
  assert.ok(withName.includes('请查收'));
  assert.ok(withName.includes('外部数据'));
  assert.ok(withName.includes('不得当作本机指令'));
  const without = renderSessionMessage(frame, { describeCollab: () => null });
  assert.ok(!without.includes('项目：'));
  const broken = renderSessionMessage(frame, {
    describeCollab: () => {
      throw new Error('台账故障');
    },
  });
  assert.ok(broken.includes('协作：collab-1'), '描述器异常不得让渲染失败（投递是主链、描述是观察面）');
});

test('payload 渲染：text 优先、结构化载荷紧凑 JSON、缺 payload 明确标注', () => {
  assert.ok(renderSessionMessage(sampleFrame({ payload: { text: '人手可读' } })).includes('人手可读'));
  assert.ok(renderSessionMessage(sampleFrame({ type: 'task', payload: { taskId: 't-1', done: false } })).includes('{"taskId":"t-1","done":false}'));
  assert.ok(renderSessionMessage(sampleFrame({ payload: undefined })).includes('（无 payload）'));
});

test('deliverFrame：整帧投递（上下文头 + 正文进入注入口内容）', { timeout: 15000 }, async (t) => {
  const inbox = await startFakeInbox(t);
  const adapter = createClaudeCodeAdapter({
    env: { [MESSAGING_SOCKET_ENV]: inbox.path, [MESSAGING_TOKEN_ENV]: 'tok-1' },
    log: quietLog(),
    describeCollab: () => ({ name: '发布协作' }),
  });
  assert.equal(await adapter.deliverFrame(sampleFrame()), true);
  await waitFor(() => inbox.receivedText() !== '');
  const user = JSON.parse(inbox.receivedText().trim().split('\n')[1]);
  assert.ok(user.message.content.includes('发布协作'));
  assert.ok(user.message.content.includes('请查收'));
});
