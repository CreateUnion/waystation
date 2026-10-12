import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDispatch } from '../src/net/dispatch.js';
import { createNetStack } from '../src/net/stack.js';
import { makeTempDir } from './helpers.js';

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

function makeStack(t, { discovery, transport, dispatch, inbound, log, probeTimeoutMs = 50 } = {}) {
  const logs = [];
  const logger = log ?? {
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
    log: logger,
    probeTimeoutMs,
  });
  return { stack, logs };
}

/* 在途等待定时器计数：用于断言错误路径不残留定时器（泄漏的 Timeout 会挂住进程退出） */
function countTimeouts() {
  return process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length;
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

test('降级态：deliveryStatus 惰性载入历史队列（未 start 也能查；查询不触发调度）', { timeout: 15000 }, async (t) => {
  const dataDir = makeTempDir(t);
  const config = { port: 17321, dispatchTickMs: 20, dialTimeoutMs: 100, retryIntervalMs: 60, retrySlowIntervalMs: 120, retryFastCount: 2, queueMaxPerCollab: 100, messageTtlMs: 600000 };
  const log = { info: () => {}, warn: () => {}, error: () => {} };
  const writer = createDispatch({ dataDir, config, transport: createFakeTransport(), self: SELF, log });
  const sent = writer.send({ collabId: 'collab-1', to: { instanceId: 'inst-b', address: '127.0.0.2' }, type: 'notice', payload: { text: '离线排队' } });
  assert.equal(sent.ok, true, '写入方未 start 也受理入队（离线排队语义）');
  const discovery = createFakeDiscovery({
    start: async () => {
      throw Object.assign(new Error('address in use'), { code: 'EADDRINUSE' });
    },
  });
  const dials = [];
  const transport = createFakeTransport({
    dial: async ({ address, port }) => {
      dials.push({ address, port });
      throw Object.assign(new Error('连接被拒'), { code: 'ECONNREFUSED' });
    },
  });
  const dispatch = createDispatch({ dataDir, config, transport, self: SELF, log });
  const { stack } = makeStack(t, { discovery, transport, dispatch });
  const idle = stack.deliveryStatus({ msgId: sent.msgId });
  assert.equal(idle.length, 1, 'stack.start 都没调过也能看到落盘的历史队列');
  const bind = await stack.start();   // 绑定失败 → 降级分支：dispatch 始终未 start
  assert.equal(bind.ok, false);
  assert.equal(bind.reason, 'port-taken');
  const dialsAfterStart = dials.length;   // 开始时占用探测拨过一次；此后不应再有拨号
  const rows = stack.deliveryStatus({ msgId: sent.msgId });
  assert.equal(rows.length, 1, '降级态（调度器未启动）deliveryStatus 仍可见历史队列');
  assert.equal(rows[0].tier, 'queued');
  await new Promise((resolve) => setTimeout(resolve, 80));   // 数个 tick 的窗口
  assert.equal(dials.length, dialsAfterStart, '查询不得触发调度（无拨号）');
  assert.equal(stack.status().counters.dispatch.deliveryFailures, 0, '查询不得产生投递副作用');
  assert.equal(stack.status().counters.dispatch.attempts, 0);
  t.after(() => stack.close());
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

test('close：等待 dispatch.stop() 落地后再关闭其余组件（拨号收口）', { timeout: 15000 }, async (t) => {
  let releaseStop = null;
  const dispatch = createFakeDispatch({
    stop: () => new Promise((resolve) => {
      releaseStop = resolve;
    }),
  });
  const transport = createFakeTransport();
  const inbound = createFakeInbound();
  const { stack } = makeStack(t, { dispatch, transport, inbound });
  await stack.start();
  const closing = stack.close();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(typeof releaseStop, 'function', 'stop 已被调用');
  assert.ok(!inbound.calls.includes('stop'), 'stop 未落地前不得继续关闭其余组件');
  assert.ok(!transport.calls.includes('close'));
  releaseStop();
  await closing;
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

test('降级（未 close 组件）后可重试：绑定条件修复后再次 start 成功', { timeout: 15000 }, async (t) => {
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

test('TCP 分支失败后重试：明确「需重建」语义（组件已随关闭销毁，不误报 bind-failed）', { timeout: 15000 }, async (t) => {
  const discovery = createFakeDiscovery();
  const transport = createFakeTransport({
    listen: async () => {
      throw Object.assign(new Error('address in use'), { code: 'EADDRINUSE' });
    },
  });
  const { stack } = makeStack(t, { discovery, transport });
  const first = await stack.start();
  assert.equal(first.reason, 'port-taken');
  assert.deepEqual(discovery.calls, ['start', 'close'], 'TCP 失败分支已撤下 discovery');
  const second = await stack.start();
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'components-closed');
  assert.ok(second.message.includes('需重建'), '重试返回「需重建」语义而非绑定失败文案');
  assert.ok(!second.message.includes('监听失败'));
  assert.deepEqual(discovery.calls, ['start', 'close'], '重试不再触达已关闭的组件');
  assert.equal(stack.status().reason, 'components-closed');
  t.after(() => stack.close());
});

test('close() 之后再 start()：明确「需重建」语义（组件一次性生命周期）', { timeout: 15000 }, async (t) => {
  const discovery = createFakeDiscovery();
  const { stack } = makeStack(t, { discovery });
  await stack.start();
  await stack.close();
  const retried = await stack.start();
  assert.equal(retried.ok, false);
  assert.equal(retried.reason, 'components-closed');
  assert.ok(retried.message.includes('需重建'));
  assert.equal(stack.status().available, false);
  assert.equal(stack.status().reason, 'components-closed');
  assert.equal(discovery.calls.filter((call) => call === 'start').length, 1, '重试不再触达已关闭的组件');
});

test('接线失败（组件抛错）：隔离为 wiring-failed 并撤下监听，不 reject 直穿', { timeout: 15000 }, async (t) => {
  const discovery = createFakeDiscovery();
  const transport = createFakeTransport({
    setFrameHandler() {
      throw new Error('接线器拒绝');
    },
  });
  const { stack } = makeStack(t, { discovery, transport });
  const result = await stack.start();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'wiring-failed');
  assert.ok(result.message.includes('接线器拒绝'));
  assert.ok(result.message.includes('需重建'));
  assert.ok(transport.calls.includes('close'), '接线失败同生共死：撤下已建立的监听');
  assert.ok(discovery.calls.includes('close'));
  assert.equal(stack.status().available, false);
  const retried = await stack.start();
  assert.equal(retried.reason, 'components-closed', '撤下即销毁：此后重试按组件已关闭语义');
  t.after(() => stack.close());
});

test('就绪日志写失败不改变启动结果（成功段异常隔离）', { timeout: 15000 }, async (t) => {
  const log = {
    info: () => {
      throw new Error('日志通道故障');
    },
    warn: () => {},
    error: () => {},
  };
  const { stack } = makeStack(t, { log });
  const result = await stack.start();
  assert.deepEqual(result, { ok: true });
  assert.equal(stack.status().available, true);
  t.after(() => stack.close());
});

test('listHosts / pingHost：可用路径的组件 rejection 收敛为错误形态（不直穿）', { timeout: 15000 }, async (t) => {
  const discovery = createFakeDiscovery({
    scan: async () => {
      throw new Error('套接字未运行');
    },
  });
  const dispatch = createFakeDispatch({
    ping: async () => {
      throw new Error('拨号建立失败');
    },
  });
  const { stack } = makeStack(t, { discovery, dispatch });
  await stack.start();
  const listed = await stack.listHosts();
  assert.equal(listed.ok, false);
  assert.ok(listed.message.includes('套接字未运行'));
  const probed = await stack.pingHost({ address: '127.0.0.1' });
  assert.equal(probed.ok, false);
  assert.ok(probed.message.includes('拨号建立失败'));
  t.after(() => stack.close());
});

test('占用探测：拨号与 pong 等待共享总预算（不再各自满额等待）', { timeout: 15000 }, async (t) => {
  const probeTimeoutMs = 200;
  const discovery = createFakeDiscovery({
    start: async () => {
      throw Object.assign(new Error('address in use'), { code: 'EADDRINUSE' });
    },
  });
  const transport = createFakeTransport({
    dial: async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));   // 拨号耗掉大部分预算
      return { remoteAddress: '127.0.0.1', send() {}, onFrame() {}, onClose() {}, close() {} };
    },
  });
  const { stack } = makeStack(t, { discovery, transport, probeTimeoutMs });
  const startedAt = Date.now();
  const result = await stack.start();
  const elapsedMs = Date.now() - startedAt;
  assert.equal(result.reason, 'port-taken');
  assert.ok(elapsedMs >= 150, '拨号延迟确已发生（测试非空转）');
  assert.ok(elapsedMs < 300, `总耗时 ${elapsedMs}ms 应显著低于「拨号 150ms + pong 各 200ms」的旧行为`);
  t.after(() => stack.close());
});

test('占用探测：ping 写失败 → port-taken，且不残留等待定时器', { timeout: 15000 }, async (t) => {
  const discovery = createFakeDiscovery({
    start: async () => {
      throw Object.assign(new Error('address in use'), { code: 'EADDRINUSE' });
    },
  });
  const transport = createFakeTransport({
    dial: async () => ({
      remoteAddress: '127.0.0.1',
      send() {
        throw new Error('write EPIPE');
      },
      onFrame() {},
      onClose() {},
      close() {},
    }),
  });
  const { stack } = makeStack(t, { discovery, transport, probeTimeoutMs: 5000 });
  const before = countTimeouts();
  const result = await stack.start();
  assert.equal(result.reason, 'port-taken');
  assert.ok(countTimeouts() <= before, `写失败路径不得残留等待定时器（before=${before} after=${countTimeouts()}）`);
  t.after(() => stack.close());
});

test('占用探测：「已绑定未接线」窗口内首次 ping 被丢弃 → 重发后按 local-instance 分类', { timeout: 15000 }, async (t) => {
  const discovery = createFakeDiscovery({
    start: async () => {
      throw Object.assign(new Error('address in use'), { code: 'EADDRINUSE' });
    },
  });
  let pings = 0;
  const transport = createFakeTransport({
    dial: async () => {
      let listener = null;
      return {
        remoteAddress: '127.0.0.1',
        send(frame) {
          pings += 1;
          if (pings === 2 && listener !== null) {
            listener({ v: 1, type: 'pong', msgId: 'pong-2', replyTo: frame.msgId, from: { instanceId: 'inst-a', identityName: '主机甲' }, ts: new Date().toISOString() });
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
  const { stack } = makeStack(t, { discovery, transport, probeTimeoutMs: 100 });
  const before = countTimeouts();
  const result = await stack.start();
  assert.equal(result.reason, 'local-instance', '窗口内丢帧由重发覆盖，不再误判为无关程序占用');
  assert.equal(pings, 2);
  assert.ok(countTimeouts() <= before, `应答路径同样不得残留等待定时器（before=${before} after=${countTimeouts()}）`);
  t.after(() => stack.close());
});
