import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNetStack } from '../src/net/stack.js';

const SELF = { instanceId: 'inst-self', identityName: '本机' };

function createFakeDiscovery(overrides = {}) {
  const calls = [];
  return {
    calls,
    start: async () => {
      calls.push('start');
    },
    close: async () => {
      calls.push('close');
    },
    scan: async ({ windowMs }) => {
      calls.push(`scan:${windowMs}`);
      return [{ instanceId: 'inst-b', identityName: '主机乙', addresses: ['127.0.0.2'], collabCount: 0, lastSeenAt: new Date().toISOString() }];
    },
    stats: () => ({ discovery: true }),
    ...overrides,
  };
}

function createFakeTransport(overrides = {}) {
  const calls = [];
  let frameHandler = null;
  return {
    calls,
    getFrameHandler: () => frameHandler,
    setFrameHandler(handler) {
      frameHandler = handler;
      calls.push('setFrameHandler');
    },
    listen: async () => {
      calls.push('listen');
    },
    close: async () => {
      calls.push('close');
    },
    dial: async () => {
      throw Object.assign(new Error('连接被拒'), { code: 'ECONNREFUSED' });
    },
    stats: () => ({ transport: true }),
    ...overrides,
  };
}

function createFakeDispatch(overrides = {}) {
  const calls = [];
  return {
    calls,
    setClientFrameRouter(router) {
      calls.push('setClientFrameRouter');
      this.router = router;
    },
    start() {
      calls.push('start');
    },
    stop() {
      calls.push('stop');
    },
    send: (message) => ({ ok: true, msgId: 'msg-1', tier: 'queued', message }),
    deliveryStatus: () => [],
    ping: async ({ address }) => ({ reachable: false, reason: `不可达：${address}` }),
    stats: () => ({ dispatch: true }),
    ...overrides,
  };
}

function createFakeInbound() {
  const calls = [];
  return {
    calls,
    onFrame: () => {
      calls.push('onFrame');
    },
    start: () => {
      calls.push('start');
    },
    stop: () => {
      calls.push('stop');
    },
    stats: () => ({ inbound: true }),
  };
}

function makeStack(t, { discovery, transport, dispatch, inbound, probeTimeoutMs = 50 } = {}) {
  const logs = [];
  const log = {
    info: (message) => logs.push({ level: 'info', message }),
    warn: (message, fields) => logs.push({ level: 'warn', message, fields }),
    error: (message, fields) => logs.push({ level: 'error', message, fields }),
  };
  const stack = createNetStack({
    discovery: discovery ?? createFakeDiscovery(),
    transport: transport ?? createFakeTransport(),
    dispatch: dispatch ?? createFakeDispatch(),
    inbound: inbound ?? createFakeInbound(),
    port: 17321,
    self: SELF,
    scanWindowMs: 250,
    log,
    probeTimeoutMs,
  });
  return { stack, logs };
}

test('start 成功：按序启动、接线注入、可用', { timeout: 15000 }, async (t) => {
  const discovery = createFakeDiscovery();
  const transport = createFakeTransport();
  const dispatch = createFakeDispatch();
  const inbound = createFakeInbound();
  const { stack } = makeStack(t, { discovery, transport, dispatch, inbound });
  const result = await stack.start();
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(discovery.calls, ['start']);
  assert.deepEqual(transport.calls, ['listen', 'setFrameHandler']);
  assert.equal(transport.getFrameHandler(), inbound.onFrame);
  assert.deepEqual(dispatch.calls, ['setClientFrameRouter', 'start']);
  assert.equal(dispatch.router, inbound.onFrame);
  assert.deepEqual(inbound.calls, ['start']);
  assert.equal(stack.status().available, true);
  t.after(() => stack.close());
});

test('UDP 绑定失败 + 占用者应答 pong → local-instance（文案可区分、降级）', { timeout: 15000 }, async (t) => {
  const discovery = createFakeDiscovery({
    start: async () => {
      throw Object.assign(new Error('address in use'), { code: 'EADDRINUSE' });
    },
  });
  const transport = createFakeTransport({
    dial: async () => {
      let listener = null;
      return {
        remoteAddress: '127.0.0.1',
        send(frame) {
          if (listener !== null && frame.type === 'ping') {
            listener({ v: 1, type: 'pong', msgId: 'pong-1', replyTo: frame.msgId, from: { instanceId: 'inst-a', identityName: '主机甲' }, ts: new Date().toISOString() });
          }
        },
        onFrame(callback) {
          listener = callback;
        },
        onClose() {},
        close() {},
      };
    },
  });
  const { stack } = makeStack(t, { discovery, transport });
  const result = await stack.start();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'local-instance');
  assert.ok(result.message.includes('本机已有驿站'));
  assert.ok(!transport.calls.includes('listen'), '绑定失败后不得再建立 TCP 监听');
  assert.equal(stack.status().available, false);
});

test('UDP 绑定失败 + 占用者沉默 → port-taken（改端口指引）', { timeout: 15000 }, async (t) => {
  const discovery = createFakeDiscovery({
    start: async () => {
      throw Object.assign(new Error('address in use'), { code: 'EADDRINUSE' });
    },
  });
  const transport = createFakeTransport({
    dial: async () => ({ remoteAddress: '127.0.0.1', send() {}, onFrame() {}, onClose() {}, close() {} }),
  });
  const { stack } = makeStack(t, { discovery, transport });
  const result = await stack.start();
  assert.equal(result.reason, 'port-taken');
  assert.ok(result.message.includes('被其他程序占用'));
  assert.ok(result.message.includes('config.json'));
});

test('UDP 绑定失败 + 探测拨号被拒 → port-taken', { timeout: 15000 }, async (t) => {
  const discovery = createFakeDiscovery({
    start: async () => {
      throw Object.assign(new Error('address in use'), { code: 'EADDRINUSE' });
    },
  });
  const { stack } = makeStack(t, { discovery });
  const result = await stack.start();
  assert.equal(result.reason, 'port-taken');
});

test('非 EADDRINUSE 的绑定失败 → bind-failed（原文进 message）', { timeout: 15000 }, async (t) => {
  const discovery = createFakeDiscovery({
    start: async () => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    },
  });
  const { stack } = makeStack(t, { discovery });
  const result = await stack.start();
  assert.equal(result.reason, 'bind-failed');
  assert.ok(result.message.includes('permission denied'));
});

test('TCP 监听失败（UDP 成功）→ 撤下 discovery 后分类', { timeout: 15000 }, async (t) => {
  const discovery = createFakeDiscovery();
  const transport = createFakeTransport({
    listen: async () => {
      throw Object.assign(new Error('address in use'), { code: 'EADDRINUSE' });
    },
  });
  const { stack } = makeStack(t, { discovery, transport });
  const result = await stack.start();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'port-taken');
  assert.ok(discovery.calls.includes('close'));
});

test('降级行为：LAN 工具返回明确错误文本；send 仍受理；deliveryStatus 可用', { timeout: 15000 }, async (t) => {
  const discovery = createFakeDiscovery({
    start: async () => {
      throw Object.assign(new Error('address in use'), { code: 'EADDRINUSE' });
    },
  });
  const dispatch = createFakeDispatch();
  const { stack } = makeStack(t, { discovery, dispatch });
  const bind = await stack.start();
  const listed = await stack.listHosts();
  assert.equal(listed.ok, false);
  assert.equal(listed.message, bind.message);
  const probed = await stack.pingHost({ address: '127.0.0.1' });
  assert.equal(probed.ok, false);
  assert.equal(probed.message, bind.message);
  const sent = stack.send({ collabId: 'collab-1', to: { instanceId: 'inst-b', address: '127.0.0.2' }, type: 'notice' });
  assert.equal(sent.ok, true, '降级时发送仍受理入队（离线排队语义）');
  assert.deepEqual(stack.deliveryStatus({}), []);
  assert.ok(!dispatch.calls.includes('start'), '降级时调度器不启动（不对外投递）');
});

test('pingHost：地址非法 → 明确错误；可用时透传探测结果', { timeout: 15000 }, async (t) => {
  const { stack } = makeStack(t);
  await stack.start();
  t.after(() => stack.close());
  const bad = await stack.pingHost({ address: 'hostname-not-ip' });
  assert.equal(bad.ok, false);
  assert.ok(bad.message.includes('地址非法'));
  const probed = await stack.pingHost({ address: '127.0.0.9' });
  assert.equal(probed.ok, true);
  assert.equal(probed.reachable, false);
});

test('listHosts：透传扫描窗口与结果', { timeout: 15000 }, async (t) => {
  const discovery = createFakeDiscovery();
  const { stack } = makeStack(t, { discovery });
  await stack.start();
  t.after(() => stack.close());
  const listed = await stack.listHosts();
  assert.equal(listed.ok, true);
  assert.equal(listed.hosts[0].identityName, '主机乙');
  assert.ok(discovery.calls.includes('scan:250'), '扫描窗口来自装配参数');
});

test('status：聚合四个组件计数与降级字段', { timeout: 15000 }, async (t) => {
  const { stack } = makeStack(t);
  await stack.start();
  t.after(() => stack.close());
  const status = stack.status();
  assert.equal(status.available, true);
  assert.equal(status.reason, null);
  assert.equal(status.port, 17321);
  assert.deepEqual(status.counters, { discovery: { discovery: true }, transport: { transport: true }, dispatch: { dispatch: true }, inbound: { inbound: true } });
});

test('close：四组件关闭；组件抛错不阻断其余（幂等）', { timeout: 15000 }, async (t) => {
  const discovery = createFakeDiscovery({
    close: async () => {
      throw new Error('关闭失败');
    },
  });
  const transport = createFakeTransport();
  const dispatch = createFakeDispatch();
  const inbound = createFakeInbound();
  const { stack } = makeStack(t, { discovery, transport, dispatch, inbound });
  await stack.start();
  await stack.close();
  await stack.close();
  assert.ok(dispatch.calls.includes('stop'));
  assert.ok(inbound.calls.includes('stop'));
  assert.ok(transport.calls.includes('close'));
});

test('start 幂等：重复调用不重启组件', { timeout: 15000 }, async (t) => {
  const discovery = createFakeDiscovery();
  const { stack } = makeStack(t, { discovery });
  await stack.start();
  t.after(() => stack.close());
  await stack.start();
  assert.deepEqual(discovery.calls, ['start']);
});

test('降级后可重试：绑定条件修复后再次 start 成功', { timeout: 15000 }, async (t) => {
  let failNext = true;
  const discovery = createFakeDiscovery({
    start: async () => {
      if (failNext) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      discovery.calls.push('start-ok');
    },
  });
  const { stack } = makeStack(t, { discovery });
  const first = await stack.start();
  assert.equal(first.ok, false);
  assert.equal(stack.status().available, false);
  failNext = false;
  const second = await stack.start();
  assert.equal(second.ok, true);
  assert.equal(stack.status().available, true);
  t.after(() => stack.close());
});
