import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createBridgeRuntime, createForwardingRegistry, createStderrLog } from '../src/bridge/main.js';
import { TOOL_SPECS } from '../src/tools/specs.js';
import { makeTempDir, repoRoot, waitFor } from './helpers.js';

/* 桥组合根的判别测试：转发 registry（list 不依赖核心即答、call 转发载荷原样）、
 * 核心不可达时的 ws_status 差错合成（唯一登记例外）与 push→注入写入→delivered 回执映射。 */

function quietLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function stubLink(overrides = {}) {
  const link = {
    sent: [],
    pushHandler: null,
    setPushHandler(handler) {
      link.pushHandler = handler;
    },
    ensureCore: async () => ({ ok: true }),
    call: async () => ({ ok: true, result: { content: [{ type: 'text', text: 'ok' }] } }),
    sendDelivered: (frame) => {
      link.sent.push(frame);
      return true;
    },
    close: async () => {},
    state: { registered: false, welcome: null, lastFailure: null },
  };
  return Object.assign(link, overrides);
}

test('tools/list 数据源＝规格单一权威（顺序与内容一致；返回浅拷贝不共享数组）', () => {
  const registry = createForwardingRegistry({ link: stubLink(), version: '0.1.0', app: '/app' });
  const listed = registry.list();
  assert.equal(listed.length, 27);
  assert.deepEqual(listed.map((tool) => tool.name), TOOL_SPECS.map((tool) => tool.name), '注册序与规格一致');
  assert.deepEqual(listed, TOOL_SPECS, '条目内容与规格逐字段相同');
  const again = registry.list();
  assert.notEqual(listed, again, '每次返回新数组');
  listed.pop();
  assert.equal(registry.list().length, 27, '调用方变异不污染规格');
});

test('dispatch 能力位：已注册旧核未宣告 dispatch 时拒绝 ws_dispatch_*，不转发', async () => {
  const calls = [];
  const link = stubLink({
    call: async (name, args) => {
      calls.push([name, args]);
      return { ok: true, result: { content: [{ type: 'text', text: 'ok' }] } };
    },
  });
  link.state.welcome = { app: '0.2.2' };
  const registry = createForwardingRegistry({ link });
  for (const name of ['ws_dispatch_scan', 'ws_dispatch_claim', 'ws_dispatch_approve', 'ws_dispatch_release']) {
    const refused = await registry.call(name, {});
    assert.equal(refused.isError, true, `${name} 在旧核心上必须拒绝`);
    assert.match(refused.content[0].text, /核心版本不支持 dispatch/);
  }
  assert.deepEqual(calls, [], '能力位缺失时不得转发到核心');
});

test('dispatch 能力位：冷启 / 重连由 ensureCore 注册后宣告 dispatch，照常转发', async () => {
  const calls = [];
  const link = stubLink({
    call: async (name, args) => {
      calls.push([name, args]);
      return { ok: true, result: { content: [{ type: 'text', text: 'ok' }] } };
    },
  });
  assert.equal(link.state.welcome, null, '前置：调用前尚未注册（冷启 / 重连）');
  link.ensureCore = async () => {
    link.state.welcome = { dispatch: 1 };
    return { ok: true };
  };
  const registry = createForwardingRegistry({ link });
  const forwarded = await registry.call('ws_dispatch_scan', { sessionIds: ['s-1'] });
  assert.equal(forwarded.isError, undefined, '不得把「核心还没起」误诊成「核心版本不支持」');
  assert.deepEqual(calls, [['ws_dispatch_scan', { sessionIds: ['s-1'] }]], '能力位在场时原样转发');
});

test('dispatch 能力位：核心不可达走既有差错文案，不误报不支持 dispatch', async () => {
  const calls = [];
  const link = stubLink({
    ensureCore: async () => ({ ok: false, kind: 'unreachable', message: '核心无应答或重启中，请重试' }),
    call: async (name, args) => {
      calls.push([name, args]);
      return { ok: true, result: { content: [{ type: 'text', text: 'ok' }] } };
    },
  });
  const result = await createForwardingRegistry({ link }).call('ws_dispatch_scan', {});
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, '核心无应答或重启中，请重试', '不可达走核心差错文案');
  assert.doesNotMatch(result.content[0].text, /不支持 dispatch/);
  assert.deepEqual(calls, [], '不可达时不转发');
});

test('核心不可达的 ws_status 合成：core.available=false＋reason＋桥来源静态信息，其余字段省略', async () => {
  const message = '检测到同根旧版会话运行中（pid 4242），请先关闭它；关闭后自动接管';
  const link = stubLink({ ensureCore: async () => ({ ok: false, kind: 'waiting', message }) });
  const registry = createForwardingRegistry({ link, version: '9.9.9', app: 'E:\\app-root' });
  const result = await registry.call('ws_status', {});
  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0].text);
  assert.deepEqual(Object.keys(payload), ['core', 'bridge'], '差错载荷只含 core 与 bridge 两块');
  assert.deepEqual(payload.core, { available: false, reason: message }, 'reason 取分类文案（等待态即 statusDetail）');
  assert.deepEqual(payload.bridge, { version: '9.9.9', app: 'E:\\app-root' }, '静态信息来源＝桥');
});

test('核心不可达的其余工具：纯文本错误文案（含明确指引）', async () => {
  const link = stubLink({ ensureCore: async () => ({ ok: false, kind: 'unreachable', message: '核心无应答或重启中，请重试' }) });
  const registry = createForwardingRegistry({ link });
  for (const name of ['ws_list_hosts', 'ws_check_inbox', 'ws_ping']) {
    const result = await registry.call(name, {});
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, '核心无应答或重启中，请重试');
  }
});

test('核心应答：call 转发 {tool,args} 且结果载荷原样（含 isError）', async () => {
  const called = [];
  const reply = { content: [{ type: 'text', text: '来自核心' }], isError: true };
  const link = stubLink({
    call: async (tool, args) => {
      called.push({ tool, args });
      return { ok: true, result: reply };
    },
  });
  const registry = createForwardingRegistry({ link });
  const result = await registry.call('ws_ping', { address: '127.0.0.1' });
  assert.deepEqual(result, reply);
  assert.deepEqual(called, [{ tool: 'ws_ping', args: { address: '127.0.0.1' } }]);
});

test('转发阶段失败（换代中）：文案进入错误结果（含指引）', async () => {
  const link = stubLink({ call: async () => ({ ok: false, kind: 'replacing', message: '核心换代中（约数秒），请重试；数据未丢' }) });
  const registry = createForwardingRegistry({ link });
  const other = await registry.call('ws_list_collabs', {});
  assert.equal(other.isError, true);
  assert.match(other.content[0].text, /换代/);
  const status = await registry.call('ws_status', {});
  assert.match(JSON.parse(status.content[0].text).core.reason, /换代/);
});

test('桥运行时：push 经注入写入映射 delivered 回执（成功不带 reason、失败带桶）', { timeout: 15000 }, async () => {
  const writer = { deliver: async (text) => (text === '好的' ? { ok: true } : { ok: false, reason: 'rejected' }) };
  const link = stubLink();
  createBridgeRuntime({ env: {}, dataDir: '/nonexistent-root', log: quietLog(), writer, link });
  assert.equal(typeof link.pushHandler, 'function', 'push 处理器已接线');
  link.pushHandler({ type: 'push', pushId: 'push-1', text: '好的', collabId: 'collab-1', frameType: 'message' });
  await waitFor(() => link.sent.length >= 1);
  assert.deepEqual(link.sent[0], { type: 'delivered', pushId: 'push-1', ok: true });
  link.pushHandler({ type: 'push', pushId: 'push-2', text: '被拒的', collabId: 'collab-1', frameType: 'message' });
  await waitFor(() => link.sent.length >= 2);
  assert.deepEqual(link.sent[1], { type: 'delivered', pushId: 'push-2', ok: false, reason: 'rejected' });
});

test('桥运行时：dataDir 取数据根解析；关闭转发到连接件', async () => {
  let closed = 0;
  const link = stubLink({ close: async () => { closed++; } });
  const runtime = createBridgeRuntime({
    env: { WAYSTATION_HOME: 'E:\\tmp\\bridge-home' },
    log: quietLog(),
    writer: { deliver: async () => ({ ok: true }) },
    link,
  });
  assert.equal(runtime.dataDir, 'E:\\tmp\\bridge-home');
  assert.equal(runtime.registry.list().length, 27);
  await runtime.close();
  assert.equal(closed, 1);
});

test('桥运行时：会话元数据变化经 sendRegisterUpdate 外送，close 一并停 watcher', async (t) => {
  const root = makeTempDir(t);
  const dir = join(root, 'sessions');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, '1.json');
  writeFileSync(file, JSON.stringify({ sessionId: 'sess-meta', name: 'before', kind: 'interactive' }));
  const updates = [];
  let closed = 0;
  const link = stubLink({
    sendRegisterUpdate: (meta) => {
      updates.push(meta);
      return true;
    },
    close: async () => { closed++; },
  });
  t.mock.timers.enable({ apis: ['setInterval'] });
  const runtime = createBridgeRuntime({
    env: { CLAUDE_CONFIG_DIR: root, CLAUDE_CODE_SESSION_ID: 'sess-meta' },
    log: quietLog(),
    writer: { deliver: async () => ({ ok: true }) },
    link,
  });
  writeFileSync(file, JSON.stringify({ sessionId: 'sess-meta', name: 'after', kind: 'interactive' }));
  t.mock.timers.tick(5000);
  assert.equal(updates.at(-1)?.name, 'after', '文件变化经 watcher 外送（5s 周期）');
  await runtime.close();
  assert.equal(closed, 1, '关闭转发到连接件');
  const reported = updates.length;
  t.mock.timers.tick(5000);
  assert.equal(updates.length, reported, '关闭后 watcher 不再上报');
});

test('重注册时补发断连期间变化的最新会话元数据', async (t) => {
  const root = makeTempDir(t);
  const dir = join(root, 'sessions');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, '1.json');
  writeFileSync(file, JSON.stringify({ sessionId: 'sess-meta', name: 'before', kind: 'interactive' }));
  const updates = [];
  const link = stubLink({
    setRegisteredHandler(handler) {
      link.registeredHandler = handler;
    },
    sendRegisterUpdate: (meta) => {
      updates.push(meta);
      return true;
    },
  });
  const runtime = createBridgeRuntime({
    env: { CLAUDE_CONFIG_DIR: root, CLAUDE_CODE_SESSION_ID: 'sess-meta' },
    log: quietLog(),
    writer: { deliver: async () => ({ ok: true }) },
    link,
    sessionMetaWatcher: false,
  });
  writeFileSync(file, JSON.stringify({ sessionId: 'sess-meta', name: 'after', kind: 'interactive' }));
  link.registeredHandler({ corePid: 1 }, { reborn: true });
  assert.equal(updates.at(-1)?.name, 'after', '注册后现读最新元数据补发（hello 快照不覆盖断连期变化）');
  await runtime.close();
});

test('注入写面不可用：桥启动即告警（既有组合根「适配器不可用」告警的接续）', async () => {
  const logs = [];
  const link = stubLink();
  createBridgeRuntime({
    env: {},
    dataDir: '/nonexistent-root',
    log: { info: () => {}, warn: (message, meta) => logs.push({ message, meta }), error: () => {} },
    writer: { available: () => false, deliver: async () => ({ ok: false, reason: 'unavailable' }) },
    link,
  });
  assert.equal(logs.length, 1);
  assert.match(logs[0].message, /会话投递适配器不可用/);
  assert.match(logs[0].message, /主动查/, '降级去向如实（会话主动查）');
});

test('注入写面可用时不告警（available() 为真）', async () => {
  const logs = [];
  const link = stubLink();
  createBridgeRuntime({
    env: {},
    dataDir: '/nonexistent-root',
    log: { info: () => {}, warn: (message) => logs.push(message), error: () => {} },
    writer: { available: () => true, deliver: async () => ({ ok: true }) },
    link,
  });
  assert.deepEqual(logs, []);
});

test('桥运行时默认装配：真实连接件（数据根随环境）＋push 处理器已接线', async () => {
  const runtime = createBridgeRuntime({
    env: { WAYSTATION_HOME: 'E:\\tmp\\bridge-default-home', CLAUDE_CODE_SESSION_ID: 'session-default-1' },
    log: quietLog(),
    writer: { deliver: async () => ({ ok: true }) },
    sessionMetaWatcher: false,   // 不读开发机真实 ~/.claude
  });
  assert.equal(runtime.dataDir, 'E:\\tmp\\bridge-default-home');
  assert.equal(typeof runtime.link.ensureCore, 'function');
  assert.equal(typeof runtime.link.setPushHandler, 'function');
  assert.equal(runtime.link.state.registered, false);
  await runtime.close();   // 未连接：直接关停不挂死
});

test('push 注入写入内部错误：捕获留痕、不回执（核心按未注入处置）', { timeout: 15000 }, async () => {
  const logs = [];
  const writer = { deliver: async () => { throw new Error('写入内部错误'); } };
  const link = stubLink();
  createBridgeRuntime({
    env: {},
    dataDir: '/nonexistent-root',
    log: { info: () => {}, warn: (message, meta) => logs.push({ message, meta }), error: () => {} },
    writer,
    link,
  });
  link.pushHandler({ type: 'push', pushId: 'push-9', text: 'x', collabId: 'collab-1', frameType: 'message' });
  await waitFor(() => logs.length >= 1);
  assert.match(logs[0].message, /注入写入失败/);
  assert.equal(link.sent.length, 0, '失败路径不发回执');
});

test('stderr 日志面：warn/error 带桥前缀与结构化元数据（不写文件、不碰 stdout）', () => {
  const captured = [];
  const original = console.error;
  console.error = (...args) => captured.push(args.join(' '));
  try {
    const log = createStderrLog();
    log.warn('测试告警', { a: 1 });
    log.error('测试错误');
  } finally {
    console.error = original;
  }
  assert.equal(captured.length, 2);
  assert.match(captured[0], /waystation-bridge: 测试告警/);
  assert.match(captured[0], /\{"a":1\}/);
  assert.match(captured[1], /waystation-bridge: 测试错误/);
});

/* 进程级冒烟：真实桥进程（stdio MCP）——MCP 初始化与 tools/list 不依赖核心即答；
 * 核心启动失败的降级文案（空显式根未配 port → 核心拒绝启动、退出码 1）；
 * stdin 关闭 → 桥退场（进程消失）。真实核 e2e（1 桥＋1 核、call/result 等价）待核心接线就位后补跑。 */
test('进程级：MCP 立即可答、核心启动失败降级文案、stdin 关闭即退场', { timeout: 40000 }, async (t) => {
  const home = makeTempDir(t);
  const claudeConfig = makeTempDir(t);
  const mainUrl = pathToFileURL(fileURLToPath(new URL('../src/bridge/main.js', import.meta.url))).href;
  const code = `import { startBridge } from ${JSON.stringify(mainUrl)};\nawait startBridge();`;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--input-type=module', '-e', code],
    cwd: repoRoot,
    env: {
      ...process.env, WAYSTATION_HOME: home, CLAUDE_CONFIG_DIR: claudeConfig, CLAUDE_CODE_SESSION_ID: 'session-bridge-proc-1',
    },
  });
  let childPid = null;
  t.after(async () => {
    await transport.close().catch(() => {});
    if (childPid !== null) {
      try {
        process.kill(childPid, 'SIGKILL');
      } catch {
        // 已退出：无需清理
      }
    }
  });
  const client = new Client({ name: 'bridge-proc-test', version: '0.0.0' });
  await client.connect(transport);
  childPid = transport.pid ?? null;
  const { tools } = await client.listTools();
  assert.equal(tools.length, 27, 'tools/list 不依赖核心即答');
  const called = await client.callTool({ name: 'ws_status', arguments: {} });
  assert.equal(called.isError, true);
  const payload = JSON.parse(called.content[0].text);
  assert.deepEqual(Object.keys(payload), ['core', 'bridge']);
  assert.equal(payload.core.available, false);
  assert.ok(payload.core.reason.length > 0, '降级文案非空（退出码归因）');
  assert.equal(typeof payload.bridge.version, 'string');
  await client.close();
  await waitFor(() => !isProcessAlive(childPid), { timeoutMs: 8000 });
});

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
