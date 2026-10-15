import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { MESSAGING_SOCKET_ENV, MESSAGING_TOKEN_ENV } from '../src/adapters/claude-code.js';
import { createSessionWriter } from '../src/bridge/session-writer.js';
import { waitFor } from './helpers.js';

/* 桥注入写面的判别测试：回执桶映射（成功→ok；失败→rejected/failed/unavailable，timeout 只属
 * IPC 等待层不在此混桶）、观察窗语义沿用、串行投递下的分桶归属。桩 socket 与适配器既有断言同口径。 */

function quietLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function pipePath() {
  return `\\\\.\\pipe\\waystation-bridge-writer-test-${randomUUID()}`;
}

/* 假会话收件箱（命名管道上的真实 server）：保持连接 = 成功路径（真实 CLI 成功时连接保持、无回执）；
 * reject = 收到即断（认证不过 / 拒收）；closeAfterMs = 收数据后延时断（观察窗内被关）。 */
async function startFakeInbox(t, { reject = false, closeAfterMs = null } = {}) {
  const path = pipePath();
  const frames = [];
  const server = net.createServer((socket) => {
    if (reject) {
      socket.destroy();
      return;
    }
    socket.on('data', (chunk) => {
      frames.push(chunk);
      if (closeAfterMs !== null) {
        setTimeout(() => socket.destroy(), closeAfterMs);
      }
    });
  });
  await new Promise((resolve, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(path, resolve);
  });
  t.after(() => server.close());
  return { path, receivedText: () => Buffer.concat(frames).toString('utf8') };
}

function writerFor(path, { token = 'tok-bridge', settleMs = undefined, connectTimeoutMs = undefined } = {}) {
  return createSessionWriter({
    env: { [MESSAGING_SOCKET_ENV]: path, [MESSAGING_TOKEN_ENV]: token },
    log: quietLog(),
    settleMs,
    connectTimeoutMs,
  });
}

test('成功投递：回执 ok、收件箱收到认证帧+user 帧、文本原样（多行中文）', { timeout: 15000 }, async (t) => {
  const inbox = await startFakeInbox(t);
  const writer = writerFor(inbox.path);
  const content = '第一行\n第二行：注入原文 🚀';
  assert.deepEqual(await writer.deliver(content), { ok: true });
  await waitFor(() => inbox.receivedText() !== '');
  const lines = inbox.receivedText().trim().split('\n');
  assert.deepEqual(JSON.parse(lines[0]), { type: 'auth', token: 'tok-bridge' });
  assert.equal(JSON.parse(lines[1]).message.content, content);
  assert.equal(writer.stats().delivered, 1);
});

test('对端拒收（收到即断）：回执 reason=rejected，不计已投递', { timeout: 15000 }, async (t) => {
  const inbox = await startFakeInbox(t, { reject: true });
  const writer = writerFor(inbox.path);
  assert.deepEqual(await writer.deliver('这条会被拒收'), { ok: false, reason: 'rejected' });
  assert.equal(writer.stats().delivered, 0);
});

test('观察窗内被对端关闭：rejected（观察窗语义沿用）', { timeout: 15000 }, async (t) => {
  const inbox = await startFakeInbox(t, { closeAfterMs: 10 });
  const writer = writerFor(inbox.path, { settleMs: 120 });
  assert.deepEqual(await writer.deliver('窗口内被关'), { ok: false, reason: 'rejected' });
});

test('连接失败（管道不存在）：回执 reason=failed', { timeout: 15000 }, async () => {
  const writer = writerFor(pipePath());
  assert.deepEqual(await writer.deliver('无人接收'), { ok: false, reason: 'failed' });
});

test('连接/写入期限超时：reason=failed（本地期限，不与对端拒收混桶）', { timeout: 15000 }, async (t) => {
  /* 桩传输挂起写入、分类逻辑全走生产代码（与适配器层既有断言同一手法） */
  const realConnect = net.connect;
  const fakeSocket = {
    on() {},
    once(event, callback) {
      if (event === 'connect') {
        setImmediate(callback);
      }
    },
    write() {},
    destroy() {},
  };
  net.connect = () => fakeSocket;
  t.after(() => {
    net.connect = realConnect;
  });
  const writer = writerFor(pipePath(), { connectTimeoutMs: 30 });
  assert.deepEqual(await writer.deliver('挂起探测'), { ok: false, reason: 'failed' });
});

test('注入口未配置（env 缺 socket）：回执 reason=unavailable，且不建连', { timeout: 15000 }, async () => {
  const writer = createSessionWriter({ env: {}, log: quietLog() });
  assert.equal(writer.available(), false);
  assert.deepEqual(await writer.deliver('无注入口'), { ok: false, reason: 'unavailable' });
});

test('并发投递串行化：两次投递的分桶归属不串扰', { timeout: 15000 }, async (t) => {
  const inbox = await startFakeInbox(t);
  const writer = writerFor(inbox.path);
  const both = await Promise.all([writer.deliver('甲'), writer.deliver('乙')]);
  assert.deepEqual(both, [{ ok: true }, { ok: true }]);
  assert.equal(writer.stats().delivered, 2);
  await waitFor(() => inbox.receivedText().split('\n').length >= 5);
});

test('并发异桶失败：串行链下桶归属不串扰（一笔拒收、一笔连接挂起取 failed）', { timeout: 15000 }, async (t) => {
  const inbox = await startFakeInbox(t, { reject: true });
  const realConnect = net.connect;
  let connects = 0;
  net.connect = (...args) => {
    connects++;
    if (connects === 1) {
      return realConnect(...args);
    }
    return {
      on() {},
      once(event, callback) {
        if (event === 'connect') {
          setImmediate(callback);
        }
      },
      write() {},
      destroy() {},
    };
  };
  t.after(() => {
    net.connect = realConnect;
  });
  /* 两笔的落账区间必须真交叠，用例才有判别力：「甲」的 rejected++ 在观察窗收口时落账（settleMs≈120ms），
   * 「乙」的本地连接期限须更晚收口（400ms）——串行链缺席时，乙的 before/after 会跨过甲的增量，
   * bucketOf 的 rejected 先命中就把乙误判成 rejected。 */
  const writer = writerFor(inbox.path, { settleMs: 120, connectTimeoutMs: 400 });
  const both = await Promise.all([writer.deliver('甲（收件箱拒收）'), writer.deliver('乙（连接挂起）')]);
  assert.deepEqual(both, [{ ok: false, reason: 'rejected' }, { ok: false, reason: 'failed' }], '先落账者记 rejected、后者按自身增量记 failed');
  assert.equal(writer.stats().rejected, 1);
  assert.equal(writer.stats().failed, 1);
});

test('失败后队列继续可用：连续两次拒收均为 rejected', { timeout: 15000 }, async (t) => {
  const inbox = await startFakeInbox(t, { reject: true });
  const writer = writerFor(inbox.path);
  assert.deepEqual(await writer.deliver('一'), { ok: false, reason: 'rejected' });
  assert.deepEqual(await writer.deliver('二'), { ok: false, reason: 'rejected' });
  assert.equal(writer.stats().rejected, 2);
});
