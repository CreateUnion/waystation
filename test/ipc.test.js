import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { makeTempDir, waitFor } from './helpers.js';
import {
  FRAME_TYPES, HEARTBEAT_PING_MS, IPC_MAX_FRAME_BYTES, IPC_VERSION, PEER_TIMEOUT_MS,
  createFrameDecoder, createIpcClient, createIpcServer, encodeIpcFrame, endpointFor,
  endpointsOf, ensureRunDir, newIpcToken, prepareEndpoint, transportModeOf, validateIpcFrame,
} from '../src/core/ipc.js';
import { runDir } from '../src/paths.js';
import { rootDigest } from '../src/util/digest.js';

/* 本文件是 IPC 层（核心↔桥共用契约）的判别测试：帧编解码与逐字段校验、首帧认证、
 * 心跳与卡死判定、端点与权限、Windows 管道实测。全部临时根（makeTempDir），
 * 不触碰真实 ~/.waystation、不占用站点端口段。 */

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';

function silentLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

/* 收尾钩子先于 makeTempDir 的删除钩子注册（node:test 收尾按注册序执行）：
 * 先关服务/连接、后删目录，避免 Windows 下删除撞上存活句柄。 */
function cleanupOf(t) {
  const fns = [];
  t.after(async () => {
    for (const fn of fns) {
      try {
        await fn();
      } catch {
        // 已关闭/已释放：重复收尾不影响断言面
      }
    }
  });
  return (fn) => {
    fns.push(fn);
  };
}

function helloFrame(overrides = {}) {
  return {
    type: 'hello',
    v: IPC_VERSION,
    app: '0.1.0',
    token: TOKEN,
    bridgeId: 'bridge-1',
    sessionId: 'session-1',
    pid: 4321,
    platform: 'win32',
    ...overrides,
  };
}

/* 无 sessionId 的 hello（非 Claude 客户端形态）：清键而非置 undefined——JSON 往返丢 undefined 字段。 */
function helloFrameNoSession(overrides = {}) {
  const frame = helloFrame(overrides);
  delete frame.sessionId;
  return frame;
}

function welcomeFixture(dataDir) {
  return ({ bridges }) => ({
    type: 'welcome',
    ok: true,
    v: IPC_VERSION,
    app: '0.1.0',
    corePid: process.pid,
    dataDir,
    identity: { instanceId: 'inst-0001', identityName: 'lfxue' },
    port: 7323,
    net: { available: true, degraded: false },
    persistent: false,
    bridges,
  });
}

function startServer(cleanup, dataDir, overrides = {}) {
  const server = createIpcServer({
    dataDir,
    token: TOKEN,
    welcomeOf: welcomeFixture(dataDir),
    log: silentLog(),
    ...overrides,
  });
  cleanup(() => server.close());
  return server;
}

/* 受控客户端（多处客户端用例共用）：默认 hello 字段（app/token）＋收尾注册。 */
function startClient(cleanup, dataDir, helloOverrides = {}, hooks = {}) {
  const client = createIpcClient({
    dataDir,
    hello: { app: '0.1.0', token: TOKEN, ...helloOverrides },
    log: silentLog(),
    ...hooks,
  });
  cleanup(() => client.close());
  return client;
}

/* 原始连接：绕过 createIpcClient 直接看线上字节（认证回执的逐字节比对需要）。
 * 对端断开后的写错误（EPIPE 等）不属于断言面——错误监听吞掉。 */
async function connectRaw(endpoint) {
  const socket = net.connect(endpoint);
  socket.on('error', () => {});
  const collected = { text: '', closed: false };
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    collected.text += chunk;
  });
  socket.on('close', () => {
    collected.closed = true;
  });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  return { socket, collected };
}

/* 桩核心（客户端侧用例）：接受连接、按脚本应答，不经过 createIpcServer。 */
async function startStubCore(cleanup, endpoint, onFrame) {
  const sockets = new Set();
  const closed = [];
  const stub = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
      closed.push(1);
    });
    socket.on('error', () => {});
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line !== '' && line !== '\r') {
          onFrame(JSON.parse(line), socket);
        }
        index = buffer.indexOf('\n');
      }
    });
  });
  await new Promise((resolve, reject) => {
    stub.once('error', reject);
    stub.listen(endpoint, resolve);
  });
  cleanup(() => new Promise((resolve) => {
    for (const socket of sockets) {
      socket.destroy();
    }
    stub.close(() => resolve());
  }));
  return { closedCount: () => closed.length };
}

function writeLine(socket, frame) {
  socket.write(encodeIpcFrame(frame));
}

function restoreEnv(key, value) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

/* 认证阶段一次原始尝试：连接→写首帧→等断开→回读线上字节（回执比对用）。 */
async function rawAuthAttempt(cleanup, endpoint, frameOrRaw) {
  const { socket, collected } = await connectRaw(endpoint);
  cleanup(() => socket.destroy());
  if (typeof frameOrRaw === 'string') {
    socket.write(frameOrRaw);
  } else {
    writeLine(socket, frameOrRaw);
  }
  await waitFor(() => collected.closed, { timeoutMs: 10000 });
  return collected.text;
}

/* 认证成功路径的原始读取：注册后连接保持，等 welcome 行到达即主动断开（rawAuthAttempt
 * 依赖服务端断开，只适用于拒绝路径）。 */
async function rawWelcomeOver(cleanup, endpoint, frame) {
  const { socket, collected } = await connectRaw(endpoint);
  cleanup(() => socket.destroy());
  writeLine(socket, frame);
  await waitFor(() => collected.text.includes('\n'), { timeoutMs: 10000 });
  socket.destroy();
  return collected.text;
}

/* —— 端点与凭据 —— */

test('endpointFor：POSIX 为 <root>/run/core.sock；Windows 为 \\\\.\\pipe\\waystation-<rootDigest 8hex>', (t) => {
  const root = makeTempDir(t);
  for (const platform of ['linux', 'darwin']) {
    const posix = endpointFor(root, platform);
    assert.equal(basename(posix), 'core.sock');
    assert.equal(dirname(posix), runDir(root), `${platform} 端点须落 <root>/run/`);
  }
  const windows = endpointFor(root, 'win32');
  assert.equal(windows, `\\\\.\\pipe\\waystation-${rootDigest(root)}`, '摘要复用 rootDigest（不另派生）');
  assert.match(windows, /^\\\\\.\\pipe\\waystation-[0-9a-f]{8}$/);
  const other = makeTempDir(t);
  assert.notEqual(endpointFor(other, 'win32'), windows, '不同数据根不得共用端点（多根隔离）');
});

/* —— TCP loopback 监听（服务上下文跨会话可达） —— */

test('TCP 监听：start() 返回 127.0.0.1 的 ephemeral 端口，且该端点可完成 hello 认证', async (t) => {
  const cleanup = cleanupOf(t);
  const root = makeTempDir(t);
  const server = startServer(cleanup, root);
  const started = await server.start();

  assert.equal(started.tcp.host, '127.0.0.1', '只绑 IPv4 环回（禁 localhost 与 0.0.0.0）');
  assert.ok(Number.isInteger(started.tcp.port) && started.tcp.port > 0, 'ephemeral 端口须回填');
  assert.ok(started.tcp.port < 7321 || started.tcp.port > 7328, '不得占用站点锚点段 7321–7328');

  const bytes = await rawWelcomeOver(cleanup, started.tcp, helloFrame());
  const receipt = JSON.parse(bytes);
  assert.equal(receipt.ok, true, 'TCP 端点与管道共用同一认证面');
  assert.equal(server.listBridges().length, 1);
  assert.equal(server.listBridges()[0].bridgeId, 'bridge-1');
});

test('TCP 监听：错误 token 走同一认证回执（不泄漏差异）', async (t) => {
  const cleanup = cleanupOf(t);
  const root = makeTempDir(t);
  const server = startServer(cleanup, root);
  const started = await server.start();

  const bytes = await rawAuthAttempt(cleanup, started.tcp, helloFrame({ token: 'wrong-token' }));

  assert.equal(JSON.parse(bytes).code, 'auth');
  assert.equal(server.listBridges().length, 0);
  assert.equal(server.state.authFailures, 1);
});

test('TCP 监听：与原端点并存（旧桥仍可连原端点）', async (t) => {
  const cleanup = cleanupOf(t);
  const root = makeTempDir(t);
  const server = startServer(cleanup, root);
  const started = await server.start();

  assert.equal(started.endpoint, endpointFor(root), '返回的 endpoint 保持旧语义');
  assert.notEqual(started.tcp, null);
  const bytes = await rawWelcomeOver(cleanup, endpointFor(root), helloFrame({ bridgeId: 'bridge-legacy' }));
  assert.equal(JSON.parse(bytes).ok, true, '双监听：旧端点在新核上照常可用');
});

test('newIpcToken：64 hex、每次轮换不同', () => {
  const first = newIpcToken();
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.notEqual(first, newIpcToken());
});

test('rootDigest：平台折叠分支全覆盖——win32 折叠大小写、POSIX 不折叠（平台注入，零产品代码改动）', (t) => {
  const root = makeTempDir(t);
  const upper = root.toUpperCase();
  assert.notEqual(upper, root, '临时根路径含字母，大小写变体可构造');
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  t.after(() => {
    if (original === undefined) {
      delete process.platform;
    } else {
      Object.defineProperty(process, 'platform', original);
    }
  });
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  assert.equal(rootDigest(upper), rootDigest(root), 'win32：同一目录的大小写变体得同摘要（根匹配依赖）');
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  assert.notEqual(rootDigest(upper), rootDigest(root), 'POSIX：大小写不同即不同路径、不同摘要');
});

test('run/：ensureRunDir 返回目录路径；无法保证 0700 时告警（平台注入覆盖告警分支）', (t) => {
  const root = makeTempDir(t);
  const warnings = [];
  const log = { ...silentLog(), warn: (message, fields) => warnings.push({ message, fields }) };
  const dir = ensureRunDir(root, { log });
  assert.equal(dir, runDir(root));
  assert.equal(statSync(dir).isDirectory(), true);

  warnings.length = 0;
  assert.equal(ensureRunDir(root, { log, platform: 'linux' }), runDir(root), '幂等');
  if (process.platform === 'win32') {
    assert.equal(warnings.length, 1, '本机无法保证 0700——告警必须如实触发（该前提不成立时 token 不构成秘密）');
  } else {
    assert.equal(warnings.length, 0, '显式 0700 创建成功后不告警');
  }
});

/* —— 帧编解码 —— */

const CANONICAL_FRAMES = [
  helloFrame(),
  helloFrameNoSession(),
  {
    type: 'welcome', ok: true, v: IPC_VERSION, app: '0.1.0', corePid: 99, dataDir: '/data/root',
    identity: { instanceId: 'inst-1', identityName: 'lfxue' }, port: 7323,
    net: { available: false, degraded: true }, persistent: true, bridges: 3,
  },
  { type: 'welcome', ok: false, code: 'auth', message: '认证失败' },
  { type: 'call', id: 'call-1', tool: 'ws_status', args: {} },
  { type: 'result', id: 'call-1', content: [{ type: 'text', text: 'ok' }] },
  { type: 'result', id: 'call-2', content: [], isError: true },
  { type: 'push', pushId: 'push-1', text: '头\n正文\n尾', collabId: 'collab-1', frameType: 'user' },
  { type: 'delivered', pushId: 'push-1', ok: true },
  { type: 'delivered', pushId: 'push-1', ok: false, reason: 'timeout' },
  { type: 'replace', reason: 'version-mismatch', wantApp: '0.2.0' },
  { type: 'replace', reason: 'manual' },
  { type: 'core-restarting', reason: 'version-mismatch', replacerBridgeId: 'bridge-1', targetApp: '0.2.0', deadlineMs: 10000 },
  { type: 'register-update', role: 'slave', name: 'worker', kind: 'bg', status: 'idle', metaUpdatedAt: 1 },
  { type: 'ping' },
  { type: 'pong' },
  { type: 'bye', reason: 'session-end' },
  { type: 'bye', reason: 'replace' },
];

test('帧往返：规范帧逐类型经 encode→解码→校验后与原文逐字段等价', () => {
  assert.deepEqual(
    [...new Set(CANONICAL_FRAMES.map((frame) => frame.type))].sort(),
    [...FRAME_TYPES].sort(),
    '12 种帧类型均须有规范帧与校验器（新增类型须同步本用例）',
  );
  const frames = [];
  const refusals = [];
  const decoder = createFrameDecoder({ onFrame: (frame) => frames.push(frame), onRefuse: (reason) => refusals.push(reason) });
  decoder.push(Buffer.from(CANONICAL_FRAMES.map((frame) => encodeIpcFrame(frame)).join(''), 'utf8'));
  assert.deepEqual(refusals, []);
  assert.equal(frames.length, CANONICAL_FRAMES.length);
  CANONICAL_FRAMES.forEach((source, index) => {
    const checked = validateIpcFrame(frames[index]);
    assert.equal(checked.ok, true, `第 ${index} 帧应通过校验：${JSON.stringify(source)}`);
    assert.deepEqual(checked.frame, source);
  });
});

test('帧往返：encode 是稳定的一行 JSON + \\n', () => {
  const frame = { type: 'call', id: 'call-9', tool: 'ws_status', args: { collabId: 'c1' } };
  assert.equal(encodeIpcFrame(frame), `${JSON.stringify(frame)}\n`);
});

test('帧校验：根节点与类型 —— 非对象/未知类型一律拒', () => {
  for (const bad of [null, undefined, 42, 'hello', [{ type: 'ping' }]]) {
    assert.equal(validateIpcFrame(bad).ok, false, String(bad));
  }
  assert.equal(validateIpcFrame({ type: 'wat' }).ok, false);
  assert.equal(validateIpcFrame({}).ok, false);
});

const BAD_ID_FORMS = ['../evil', 'a/b', 'a\\b', 'a.b', '', 'x'.repeat(65), 'has space', '中文', 42, null];

test('帧校验：bridgeId/sessionId 过 ID_PATTERN 同族（路径拼接注入形态一律拒、不清洗）', () => {
  for (const bad of BAD_ID_FORMS) {
    assert.equal(validateIpcFrame(helloFrame({ bridgeId: bad })).ok, false, `bridgeId=${String(bad)}`);
    assert.equal(validateIpcFrame(helloFrame({ sessionId: bad })).ok, false, `sessionId=${String(bad)}`);
  }
  assert.equal(validateIpcFrame(helloFrameNoSession()).ok, true, 'sessionId 可缺省（非 Claude 客户端）');
});

test('帧校验：hello 逐字段形态判据（v/pid/app/platform/token）', () => {
  const cases = [
    ['v', 0], ['v', 1.5], ['v', '1'],
    ['app', '1.2'], ['app', 'v1.2.3'], ['app', '1.2.3.4'], ['app', '1.2.x'], ['app', 123],
    ['pid', 0], ['pid', -1], ['pid', 1.5], ['pid', '42'],
    ['platform', 'freebsd'], ['platform', 'Win32'], ['platform', 1],
    ['token', ''], ['token', 42], ['token', null],
  ];
  for (const [field, value] of cases) {
    assert.equal(validateIpcFrame(helloFrame({ [field]: value })).ok, false, `${field}=${String(value)} 应被拒`);
  }
  for (const field of ['v', 'app', 'pid', 'platform', 'token']) {
    const frame = helloFrame();
    delete frame[field];
    assert.equal(validateIpcFrame(frame).ok, false, `${field} 缺失应被拒`);
  }
  assert.equal(validateIpcFrame(helloFrame({ app: '1.2.3-rc1' })).ok, true, '三段数字＋可选预发布后缀属 x.y.z 形态');
});

test('帧校验：字符串长度上界按字节计（512B），超限拒', () => {
  assert.equal(validateIpcFrame(helloFrame({ token: 'x'.repeat(512) })).ok, true);
  assert.equal(validateIpcFrame(helloFrame({ token: 'x'.repeat(513) })).ok, false);
  assert.equal(validateIpcFrame(helloFrame({ token: '中'.repeat(171) })).ok, false, '171 个多字节字符＝513 字节，超限');
  assert.equal(validateIpcFrame(helloFrame({ token: '中'.repeat(170) })).ok, true);
});

test('帧校验：welcome 双分支（ok:true 全字段 / ok:false 的 code 词表）', () => {
  const ok = welcomeFixture('/data')({ bridges: 1 });
  assert.equal(validateIpcFrame(ok).ok, true);
  const missingIdentity = { ...ok };
  delete missingIdentity.identity;
  assert.equal(validateIpcFrame(missingIdentity).ok, false);
  assert.equal(validateIpcFrame({ ...ok, net: { available: true } }).ok, false, 'net 须含 available 与 degraded 布尔');
  assert.equal(validateIpcFrame({ ...ok, net: { available: true, degraded: 'no' } }).ok, false);
  assert.equal(validateIpcFrame({ ...ok, app: '0.1' }).ok, false);
  assert.equal(validateIpcFrame({ ...ok, bridges: -1 }).ok, false);
  for (const code of ['auth', 'version', 'replacing', 'shutting-down']) {
    assert.equal(validateIpcFrame({ type: 'welcome', ok: false, code, message: '拒绝' }).ok, true, code);
  }
  assert.equal(validateIpcFrame({ type: 'welcome', ok: false, code: 'nope', message: '拒绝' }).ok, false);
  assert.equal(validateIpcFrame({ type: 'welcome', ok: false, code: 'auth' }).ok, false, 'message 必填');
  assert.equal(validateIpcFrame({ type: 'welcome', ok: 'yes', v: 1 }).ok, false);
  // version 拒绝帧可携核心 ipcV（v）：可选字段，形态仍须正整数
  assert.equal(validateIpcFrame({ type: 'welcome', ok: false, code: 'version', v: IPC_VERSION, message: '拒绝' }).ok, true);
  assert.equal(validateIpcFrame({ type: 'welcome', ok: false, code: 'version', v: 0, message: '拒绝' }).ok, false);
  assert.equal(validateIpcFrame({ type: 'welcome', ok: false, code: 'version', v: '2', message: '拒绝' }).ok, false);
});

test('帧校验：call/result 形态（args 交各工具 schema、结果载荷零改动）', () => {
  assert.equal(validateIpcFrame({ type: 'call', id: 'c1', tool: 'ws_status', args: {} }).ok, true);
  assert.equal(validateIpcFrame({ type: 'call', id: 'c1', tool: 'ws_status' }).ok, false, 'args 必填');
  assert.equal(validateIpcFrame({ type: 'call', id: 'c1', tool: 'ws_status', args: [] }).ok, false);
  assert.equal(validateIpcFrame({ type: 'call', id: '', tool: 'ws_status', args: {} }).ok, false);
  assert.equal(validateIpcFrame({ type: 'call', id: '../x', tool: 'ws_status', args: {} }).ok, false, '相关标识与协作域标识同族');
  assert.equal(validateIpcFrame({ type: 'result', id: 'c1', content: [{ type: 'text', text: 'x' }] }).ok, true);
  assert.equal(validateIpcFrame({ type: 'result', id: 'c1', content: {} }).ok, false);
  assert.equal(validateIpcFrame({ type: 'result', id: 'c1', content: [], isError: 'yes' }).ok, false);
});

test('帧校验：push 的 text 不受 512B 短文本界（帧上限承重），标识字段照界', () => {
  const longText = '正文'.repeat(4000);
  assert.equal(validateIpcFrame({ type: 'push', pushId: 'p1', text: longText, collabId: 'collab-1', frameType: 'user' }).ok, true);
  assert.equal(validateIpcFrame({ type: 'push', pushId: '../p', text: 'x', collabId: 'collab-1', frameType: 'user' }).ok, false);
  assert.equal(validateIpcFrame({ type: 'push', pushId: 'p1', text: 42, collabId: 'collab-1', frameType: 'user' }).ok, false);
  assert.equal(validateIpcFrame({ type: 'push', pushId: 'p1', text: 'x', collabId: '../c', frameType: 'user' }).ok, false);
  assert.equal(validateIpcFrame({ type: 'push', pushId: 'p1', text: 'x', collabId: 'collab-1' }).ok, false);
});

test('帧校验：delivered 词表（reason 仅在失败时出现；timeout 只属 IPC 层）', () => {
  assert.equal(validateIpcFrame({ type: 'delivered', pushId: 'p1', ok: true }).ok, true);
  assert.equal(validateIpcFrame({ type: 'delivered', pushId: 'p1', ok: false, reason: 'rejected' }).ok, true);
  assert.equal(validateIpcFrame({ type: 'delivered', pushId: 'p1', ok: false, reason: 'timeout' }).ok, true);
  assert.equal(validateIpcFrame({ type: 'delivered', pushId: 'p1', ok: false }).ok, false, '失败必须给 reason');
  assert.equal(validateIpcFrame({ type: 'delivered', pushId: 'p1', ok: false, reason: 'nope' }).ok, false);
  assert.equal(validateIpcFrame({ type: 'delivered', pushId: 'p1', ok: true, reason: 'failed' }).ok, false, '成功不得带 reason');
  assert.equal(validateIpcFrame({ type: 'delivered', pushId: 'p1', ok: 'yes' }).ok, false);
});

test('帧校验：replace/core-restarting/bye 词表与条件字段', () => {
  assert.equal(validateIpcFrame({ type: 'replace', reason: 'version-mismatch', wantApp: '0.2.0' }).ok, true);
  assert.equal(validateIpcFrame({ type: 'replace', reason: 'version-mismatch' }).ok, false, '换代请求必须给 wantApp');
  assert.equal(validateIpcFrame({ type: 'replace', reason: 'manual' }).ok, true, '手动停止走 replace、无需 wantApp');
  assert.equal(validateIpcFrame({ type: 'replace', reason: 'nope' }).ok, false);
  assert.equal(
    validateIpcFrame({ type: 'core-restarting', reason: 'manual', replacerBridgeId: 'bridge-1', deadlineMs: 10000 }).ok,
    true,
  );
  assert.equal(validateIpcFrame({ type: 'core-restarting', reason: 'version-mismatch', replacerBridgeId: 'bridge-1' }).ok, false, 'deadlineMs 必填（帧表无问号）');
  assert.equal(validateIpcFrame({ type: 'core-restarting', reason: 'nope', replacerBridgeId: 'b', deadlineMs: 1 }).ok, false);
  assert.equal(validateIpcFrame({ type: 'core-restarting', reason: 'manual', replacerBridgeId: 'b', deadlineMs: -1 }).ok, false);
  assert.equal(validateIpcFrame({ type: 'core-restarting', reason: 'manual', deadlineMs: 1 }).ok, false);
  for (const reason of ['session-end', 'replace']) {
    assert.equal(validateIpcFrame({ type: 'bye', reason }).ok, true);
  }
  assert.equal(validateIpcFrame({ type: 'bye', reason: 'nope' }).ok, false);
  assert.equal(validateIpcFrame({ type: 'bye' }).ok, false);
});

test('帧校验：ping/pong 无字段要求；额外字段忽略（前向兼容）', () => {
  assert.equal(validateIpcFrame({ type: 'ping' }).ok, true);
  assert.equal(validateIpcFrame({ type: 'pong' }).ok, true);
  assert.equal(validateIpcFrame({ type: 'ping', note: 'x' }).ok, true);
});

test('帧校验：welcome 与条件字段的残留形态分支逐项拒', () => {
  const ok = welcomeFixture('/data')({ bridges: 1 });
  assert.equal(validateIpcFrame({ ...ok, port: 0 }).ok, false);
  assert.equal(validateIpcFrame({ ...ok, persistent: 'yes' }).ok, false);
  assert.equal(validateIpcFrame({ ...ok, identity: { instanceId: '../x', identityName: 'lfxue' } }).ok, false);
  assert.equal(validateIpcFrame({ ...ok, identity: { instanceId: 'inst-1', identityName: '坏\u0000名' } }).ok, false);
  assert.equal(validateIpcFrame({ type: 'replace', reason: 'manual', wantApp: '1.2' }).ok, false);
  assert.equal(validateIpcFrame({ type: 'core-restarting', reason: 'manual', replacerBridgeId: 'b', deadlineMs: 1, targetApp: '1.2' }).ok, false);
  assert.equal(validateIpcFrame({ type: 'call', id: 'c1', tool: 42, args: {} }).ok, false);
  assert.equal(validateIpcFrame({ type: 'delivered', pushId: '../p', ok: true }).ok, false);
});

/* —— 解码器（NDJSON 切分与超长拒帧） —— */

test('解码器：粘连帧/跨块半行/CRLF/空行/畸形 JSON 后照常续解', () => {
  const frames = [];
  const refusals = [];
  const decoder = createFrameDecoder({ onFrame: (frame) => frames.push(frame), onRefuse: (reason) => refusals.push(reason) });
  decoder.push(Buffer.from('{"type":"ping"}\n{"type":"po', 'utf8'));
  decoder.push(Buffer.from('ng"}\r\n\n{not json}\n{"type":"pong"}\n', 'utf8'));
  assert.deepEqual(frames, [{ type: 'ping' }, { type: 'pong' }, { type: 'pong' }]);
  assert.deepEqual(refusals, ['malformed']);
});

test('解码器：多字节字符跨块切分不碎（字节级切分、帧边界处解码）', () => {
  const frames = [];
  const decoder = createFrameDecoder({ onFrame: (frame) => frames.push(frame), onRefuse: () => {} });
  const line = Buffer.from(encodeIpcFrame({ type: 'push', pushId: 'p1', text: '中文混合', collabId: 'c1', frameType: 'user' }), 'utf8');
  const boundary = line.indexOf(Buffer.from('中', 'utf8')) + 1;
  decoder.push(line.subarray(0, boundary));
  decoder.push(line.subarray(boundary));
  assert.deepEqual(frames, [{ type: 'push', pushId: 'p1', text: '中文混合', collabId: 'c1', frameType: 'user' }]);
});

test('解码器：超长行拒帧一次并丢弃至行尾，其后帧照常解析；流尾半行按畸形拒', () => {
  const refusals = [];
  const decoder = createFrameDecoder({ onFrame: () => {}, onRefuse: (reason) => refusals.push(reason), maxBytes: 1024 });
  decoder.push(Buffer.from('x'.repeat(5000), 'utf8'));
  assert.deepEqual(refusals, ['oversize']);
  decoder.push(Buffer.from('\n{"type":"ping"}\n', 'utf8'));
  assert.deepEqual(refusals, ['oversize'], '同一超长帧只计一次');

  const single = [];
  const oneChunk = createFrameDecoder({ onFrame: (frame) => single.push(frame), onRefuse: (reason) => refusals.push(reason), maxBytes: 1024 });
  oneChunk.push(Buffer.from('y'.repeat(5000) + '\n{"type":"pong"}\n', 'utf8'));
  assert.deepEqual(refusals, ['oversize', 'oversize']);
  assert.deepEqual(single, [{ type: 'pong' }]);

  const truncated = createFrameDecoder({ onFrame: () => {}, onRefuse: (reason) => refusals.push(reason), maxBytes: 1024 });
  truncated.push(Buffer.from('{"type":"pi', 'utf8'));
  truncated.end();
  assert.deepEqual(refusals, ['oversize', 'oversize', 'malformed'], '流结束时的半行按畸形拒帧');
});

/* —— 首帧认证（真实管道） —— */

test('认证：错 token 与缺 token 回执逐字节一致，且立即断开、不注册', async (t) => {
  const cleanup = cleanupOf(t);
  const root = makeTempDir(t);
  const server = startServer(cleanup, root);
  await server.start();
  const endpoint = endpointFor(root);

  const wrongBytes = await rawAuthAttempt(cleanup, endpoint, helloFrame({ token: 'wrong-token' }));
  const missingToken = helloFrame();
  delete missingToken.token;
  const absentBytes = await rawAuthAttempt(cleanup, endpoint, missingToken);

  assert.equal(wrongBytes, absentBytes, '错/缺 token 不得回不同回执（不泄漏差异）');
  const receipt = JSON.parse(wrongBytes);
  assert.equal(receipt.type, 'welcome');
  assert.equal(receipt.ok, false);
  assert.equal(receipt.code, 'auth');
  /* 回执为固定最小形态：逐字节比对是「认证对认证」，两侧同加字段不可检出——此处正向断言
   * 缺字段面（v/app/dataDir 等一律不得出现，版本信息不泄漏给未认证对端）。 */
  assert.equal('v' in receipt, false, '认证回执不得携带 v（版本不得泄漏给未认证对端）');
  assert.deepEqual(Object.keys(receipt).sort(), ['code', 'message', 'ok', 'type'], '认证回执不得增设任何字段');
  assert.equal(server.listBridges().length, 0, '认证未过不得注册');
  assert.equal(server.state.authFailures, 2);
});

test('认证：非法 hello 形态（正确 token）与错 token 同一回执（判据顺序不泄漏）', async (t) => {
  const cleanup = cleanupOf(t);
  const root = makeTempDir(t);
  const server = startServer(cleanup, root);
  await server.start();
  const endpoint = endpointFor(root);

  const wrongBytes = await rawAuthAttempt(cleanup, endpoint, helloFrame({ token: 'wrong-token' }));
  const badShapeBytes = await rawAuthAttempt(cleanup, endpoint, helloFrame({ bridgeId: '../evil' }));

  assert.equal(badShapeBytes, wrongBytes, '形态失败不得暴露「token 已通过」');
  assert.equal(server.listBridges().length, 0);
  assert.equal(server.state.authFailures, 2);
  assert.equal(server.state.invalidFrames, 1);
});

test('认证：首帧非 hello（合法 call）拒帧计数、同一回执、不注册', async (t) => {
  const cleanup = cleanupOf(t);
  const root = makeTempDir(t);
  const server = startServer(cleanup, root);
  await server.start();

  const bytes = await rawAuthAttempt(cleanup, endpointFor(root), { type: 'call', id: 'call-1', tool: 'ws_status', args: {} });

  assert.equal(JSON.parse(bytes).code, 'auth');
  assert.equal(server.listBridges().length, 0);
  assert.equal(server.state.invalidFrames, 1);
  assert.equal(server.state.refusedFrames, 1);
});

test('认证：ipcV 不符 → welcome{ok:false, code:version}，不注册（版本判定在形态层之上）', async (t) => {
  const cleanup = cleanupOf(t);
  const root = makeTempDir(t);
  const server = startServer(cleanup, root);
  await server.start();

  const bytes = await rawAuthAttempt(cleanup, endpointFor(root), helloFrame({ v: IPC_VERSION + 1 }));

  const receipt = JSON.parse(bytes);
  assert.equal(receipt.ok, false);
  assert.equal(receipt.code, 'version');
  assert.equal(receipt.v, IPC_VERSION, '拒绝帧携核心自身 ipcV——桥侧换代方向判定（行四/行五）的唯一通道');
  assert.equal(server.state.versionMismatches, 1);
  assert.equal(server.state.authFailures, 0, '版本不符不归认证失败');
  assert.equal(server.listBridges().length, 0);
});

test('认证：超长 hello（>1MiB）→ 拒帧＋计数＋不注册＋断开（长度上界在认证之前）', async (t) => {
  const cleanup = cleanupOf(t);
  const root = makeTempDir(t);
  const server = startServer(cleanup, root);
  await server.start();

  const bytes = await rawAuthAttempt(cleanup, endpointFor(root), 'x'.repeat(IPC_MAX_FRAME_BYTES + 4096));

  assert.equal(server.state.oversizeFrames, 1);
  assert.equal(server.state.refusedFrames, 1);
  assert.equal(server.listBridges().length, 0, '超长 hello 不得注册');
  assert.equal(JSON.parse(bytes).code, 'auth');
});

test('认证：通过 → welcome（字段齐全）＋注册（listBridges 携 hello 身份）', async (t) => {
  const cleanup = cleanupOf(t);
  const root = makeTempDir(t);
  const server = startServer(cleanup, root);
  await server.start();
  const client = createIpcClient({
    dataDir: root,
    hello: { app: '0.1.0', token: TOKEN, bridgeId: 'bridge-x', sessionId: 'session-x' },
    log: silentLog(),
  });
  cleanup(() => client.close());

  const welcome = await client.connect();
  assert.equal(welcome.ok, true);
  assert.equal(welcome.v, IPC_VERSION);
  assert.equal(welcome.dataDir, root);
  assert.equal(welcome.bridges, 1);
  assert.deepEqual(welcome.net, { available: true, degraded: false });
  const bridges = server.listBridges();
  assert.equal(bridges.length, 1);
  assert.equal(bridges[0].bridgeId, 'bridge-x');
  assert.equal(bridges[0].sessionId, 'session-x');
  assert.equal(bridges[0].pid, process.pid, '客户端默认上报自身 pid');
  assert.equal(server.state.authFailures, 0);
  assert.equal(server.state.refusedFrames, 0);
});

/* —— 注册后的分发与拒绝 —— */

test('注册后：未知类型/方向错/形态不合 → 拒帧计数但连接保持（后续合法帧仍达 onFrame）', async (t) => {
  const cleanup = cleanupOf(t);
  const root = makeTempDir(t);
  const received = [];
  const server = startServer(cleanup, root, { onFrame: (frame, record) => received.push({ frame, record }) });
  await server.start();
  const client = createIpcClient({
    dataDir: root,
    hello: { app: '0.1.0', token: TOKEN, bridgeId: 'bridge-2' },
    log: silentLog(),
  });
  cleanup(() => client.close());
  await client.connect();

  client.send({ type: 'wat' });
  client.send({ type: 'push', pushId: 'p1', text: 'x', collabId: 'c1', frameType: 'user' });
  client.send({ type: 'call', id: 'call-bad', tool: 'ws_status' });
  client.send({ type: 'call', id: 'call-good', tool: 'ws_status', args: {} });

  await waitFor(() => received.length === 1);
  assert.equal(received[0].frame.id, 'call-good');
  assert.equal(received[0].record.bridgeId, 'bridge-2');
  assert.equal(server.state.refusedFrames, 3);
  assert.equal(server.listBridges().length, 1, '拒帧不得牵连注册');
});

test('register-update：合法字段到达业务面，未知 role 拒帧且连接保持', async (t) => {
  const cleanup = cleanupOf(t);
  const root = makeTempDir(t);
  const received = [];
  const server = startServer(cleanup, root, { onFrame: (frame, record) => received.push({ frame, record }) });
  await server.start();
  const client = startClient(cleanup, root, { bridgeId: 'bridge-meta', sessionId: 'session-meta' });
  await client.connect();

  client.send({ type: 'register-update', role: 'slave', name: 'worker', kind: 'bg', status: 'idle', metaUpdatedAt: 1 });
  await waitFor(() => received.some((entry) => entry.frame.type === 'register-update' && entry.frame.role === 'slave'));
  assert.equal(received.at(-1).record.bridgeId, 'bridge-meta');

  client.send({ type: 'register-update', role: 'root' });
  client.send({ type: 'call', id: 'call-after', tool: 'ws_status', args: {} });
  await waitFor(() => received.some((entry) => entry.frame.id === 'call-after'));
  assert.equal(received.some((entry) => entry.frame.type === 'register-update' && entry.frame.role === 'root'), false);
  assert.equal(server.listBridges().length, 1, '拒帧不得牵连注册');
});

test('E2E：hello→welcome→call/result→push/delivered→core-restarting→bye 全链（真实管道）', async (t) => {
  const cleanup = cleanupOf(t);
  const root = makeTempDir(t);
  const serverFrames = [];
  const clientFrames = [];
  const closes = [];
  const server = startServer(cleanup, root, {
    onFrame: (frame, record) => serverFrames.push({ frame, record }),
    onClose: (record, info) => closes.push({ record, info }),
  });
  const started = await server.start();
  assert.equal(started.endpoint, endpointFor(root));

  const client = startClient(cleanup, root, { bridgeId: 'bridge-e2e', sessionId: 'session-e2e' }, {
    onFrame: (frame) => clientFrames.push(frame),
  });
  const welcome = await client.connect();
  assert.equal(welcome.bridges, 1);
  const [record] = server.listBridges();

  client.send({ type: 'call', id: 'call-1', tool: 'ws_status', args: {} });
  await waitFor(() => serverFrames.length === 1);
  assert.equal(serverFrames[0].frame.tool, 'ws_status');
  assert.equal(serverFrames[0].record.bridgeId, 'bridge-e2e');

  record.send({ type: 'result', id: 'call-1', content: [{ type: 'text', text: 'ok' }] });
  await waitFor(() => clientFrames.length === 1);
  assert.deepEqual(clientFrames[0], { type: 'result', id: 'call-1', content: [{ type: 'text', text: 'ok' }] });

  server.broadcast({ type: 'push', pushId: 'push-1', text: '头\n正文\n尾', collabId: 'collab-1', frameType: 'user' });
  await waitFor(() => clientFrames.length === 2);
  assert.equal(clientFrames[1].type, 'push');

  client.send({ type: 'delivered', pushId: 'push-1', ok: false, reason: 'rejected' });
  await waitFor(() => serverFrames.length === 2);
  assert.equal(serverFrames[1].frame.reason, 'rejected');

  server.broadcast({ type: 'core-restarting', reason: 'version-mismatch', replacerBridgeId: 'bridge-e2e', deadlineMs: 10000 });
  await waitFor(() => clientFrames.length === 3);
  assert.equal(clientFrames[2].type, 'core-restarting');

  client.send({ type: 'bye', reason: 'session-end' });
  await waitFor(() => closes.length === 1);
  assert.equal(closes[0].info.reason, 'bye');
  await waitFor(() => server.listBridges().length === 0, { timeoutMs: 3000 });
});

test('服务端：向已关闭/未知记录发送返回 false；无桥广播返回 0', async (t) => {
  const cleanup = cleanupOf(t);
  const root = makeTempDir(t);
  const server = startServer(cleanup, root);
  await server.start();
  assert.equal(server.broadcast({ type: 'ping' }), 0, '无桥时广播为 0');

  const client = startClient(cleanup, root, { bridgeId: 'bridge-send' });
  await client.connect();
  const [record] = server.listBridges();
  assert.equal(server.send(record, { type: 'ping' }), true);
  assert.equal(server.send({ connId: 99999 }, { type: 'ping' }), false, '未知记录发送失败');

  record.close();
  assert.equal(server.send(record, { type: 'ping' }), false, '已 destroy 未及摘除：发送走「连接已关闭」早退分支');
  await waitFor(() => server.listBridges().length === 0);
  assert.equal(server.send(record, { type: 'ping' }), false, '已关闭记录发送失败');
  assert.equal(server.broadcast({ type: 'ping' }), 0);
});

test('客户端：注册后收到方向不符帧/畸形帧/超长帧 → 拒帧计数，连接保持', async (t) => {
  const cleanup = cleanupOf(t);
  const root = makeTempDir(t);
  const received = [];
  let stubSocket = null;
  await startStubCore(cleanup, endpointFor(root), (frame, socket) => {
    stubSocket = socket;
    if (frame.type === 'hello') {
      socket.write(encodeIpcFrame(welcomeFixture(root)({ bridges: 1 })));
    }
  });
  const client = startClient(cleanup, root, { bridgeId: 'bridge-refuse' }, { onFrame: (frame) => received.push(frame) });
  await client.connect();

  stubSocket.write('{not json}\n');
  stubSocket.write('y'.repeat(IPC_MAX_FRAME_BYTES + 16));
  stubSocket.write('\n');
  stubSocket.write(encodeIpcFrame({ type: 'call', id: 'c1', tool: 'ws_status', args: {} }));
  stubSocket.write(encodeIpcFrame({ type: 'push', pushId: 'push-1', text: 'x', collabId: 'collab-1', frameType: 'user' }));

  await waitFor(() => received.length === 1);
  assert.equal(received[0].type, 'push', '拒帧不得阻断其后合法帧');
  assert.equal(client.state.malformedFrames, 1);
  assert.equal(client.state.oversizeFrames, 1);
  assert.equal(client.state.invalidFrames, 1);
  assert.equal(client.state.stuckPeers, 0);
});

test('服务端：注册后收到畸形/超长帧 → 只计数、不断连、不摘注册（其后合法帧照达 onFrame）', async (t) => {
  const cleanup = cleanupOf(t);
  const root = makeTempDir(t);
  const received = [];
  const server = startServer(cleanup, root, { onFrame: (frame, record) => received.push({ frame, record }) });
  await server.start();

  const { socket, collected } = await connectRaw(endpointFor(root));
  cleanup(() => socket.destroy());
  writeLine(socket, helloFrame({ bridgeId: 'bridge-bad-frames' }));
  await waitFor(() => server.listBridges().length === 1);

  socket.write('{not json}\n');
  socket.write('z'.repeat(IPC_MAX_FRAME_BYTES + 16));
  socket.write('\n');
  writeLine(socket, { type: 'call', id: 'call-after', tool: 'ws_status', args: {} });

  await waitFor(() => received.length === 1);
  assert.equal(received[0].frame.id, 'call-after', '拒帧不得阻断其后合法帧');
  assert.equal(server.state.malformedFrames, 1);
  assert.equal(server.state.oversizeFrames, 1);
  assert.equal(server.state.authFailures, 0, '注册后的拒帧不归认证失败');
  assert.equal(server.listBridges().length, 1, '注册后的拒帧不得断连/摘注册');
  assert.equal(collected.closed, false);
});

/* —— 心跳与卡死判定 —— */

test('心跳：服务端判卡死（注入时钟）——静默对端被断开并计 stuck', async (t) => {
  const cleanup = cleanupOf(t);
  const root = makeTempDir(t);
  let fakeNow = 1_000_000;
  const stuck = [];
  const server = startServer(cleanup, root, {
    heartbeat: { pingIntervalMs: 20, peerTimeoutMs: 60, now: () => fakeNow },
    onStuck: (record) => stuck.push(record),
  });
  await server.start();

  const { socket, collected } = await connectRaw(endpointFor(root));
  cleanup(() => socket.destroy());
  writeLine(socket, helloFrame({ bridgeId: 'bridge-quiet' }));
  await waitFor(() => server.listBridges().length === 1);

  fakeNow += 10_000;
  await waitFor(() => server.state.stuckPeers === 1);
  await waitFor(() => collected.closed);
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0].bridgeId, 'bridge-quiet');
  assert.equal(server.listBridges().length, 0);
});

test('心跳：客户端判卡死（注入时钟）——静默核心超时后触发 onStuck 并断开', async (t) => {
  const cleanup = cleanupOf(t);
  const root = makeTempDir(t);
  let fakeNow = 5_000_000;
  const stub = await startStubCore(cleanup, endpointFor(root), (frame, socket) => {
    if (frame.type === 'hello') {
      socket.write(encodeIpcFrame(welcomeFixture(root)({ bridges: 1 })));
    }
  });
  const stuck = [];
  const client = createIpcClient({
    dataDir: root,
    hello: { app: '0.1.0', token: TOKEN, bridgeId: 'bridge-silent-core' },
    heartbeat: { pingIntervalMs: 20, peerTimeoutMs: 60, now: () => fakeNow },
    onStuck: () => stuck.push(1),
    log: silentLog(),
  });
  cleanup(() => client.close());
  await client.connect();

  fakeNow += 10_000;
  await waitFor(() => stuck.length === 1);
  assert.equal(client.state.stuckPeers, 1);
  await waitFor(() => stub.closedCount() === 1, { timeoutMs: 3000 });
});

test('心跳：ping/pong 自动应答——活跃连接跨多个判死窗口不判卡死', async (t) => {
  const cleanup = cleanupOf(t);
  const root = makeTempDir(t);
  const server = startServer(cleanup, root, { heartbeat: { pingIntervalMs: 15, peerTimeoutMs: 80 } });
  await server.start();
  const client = createIpcClient({
    dataDir: root,
    hello: { app: '0.1.0', token: TOKEN, bridgeId: 'bridge-alive' },
    heartbeat: { pingIntervalMs: 15, peerTimeoutMs: 80 },
    log: silentLog(),
  });
  cleanup(() => client.close());
  await client.connect();

  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(server.state.stuckPeers, 0, '双侧自动 pong 应维持存活（400ms > 5×判死窗口）');
  assert.equal(client.state.stuckPeers, 0);
  assert.equal(server.listBridges().length, 1);
});

test('心跳：默认数值为 10s ping / 30s 卡死判据（设计 §2.4 草案值）', () => {
  assert.equal(HEARTBEAT_PING_MS, 10_000);
  assert.equal(PEER_TIMEOUT_MS, 30_000);
});

test('注入闸：NODE_TEST_CONTEXT 在场才读 WAYSTATION_TEST_*（闸关侧不生效／闸开侧生效——双向）', async (t) => {
  const cleanup = cleanupOf(t);
  const root = makeTempDir(t);
  const priorContext = process.env.NODE_TEST_CONTEXT;
  const priorPing = process.env.WAYSTATION_TEST_IPC_PING_MS;
  const priorTimeout = process.env.WAYSTATION_TEST_IPC_PEER_TIMEOUT_MS;
  t.after(() => {
    restoreEnv('NODE_TEST_CONTEXT', priorContext);
    restoreEnv('WAYSTATION_TEST_IPC_PING_MS', priorPing);
    restoreEnv('WAYSTATION_TEST_IPC_PEER_TIMEOUT_MS', priorTimeout);
  });
  /* 两个注入值同给：只给判死窗口时 tick 仍是默认 10s、窗口内根本无判定发生——断言会恒真、
   * 任何闸门变异都不可检出（该问题正是复评 N-1）。 */
  process.env.WAYSTATION_TEST_IPC_PING_MS = '20';
  process.env.WAYSTATION_TEST_IPC_PEER_TIMEOUT_MS = '60';

  /* 闸关侧：NODE_TEST_CONTEXT 不在场 → env 整组不生效（tick 仍是 10s、判死窗口仍是 30s）。 */
  const gated = createGatedServer(cleanup, root);
  await gated.start();
  const quiet = await connectRaw(endpointFor(root));
  cleanup(() => quiet.socket.destroy());
  writeLine(quiet.socket, helloFrame({ bridgeId: 'bridge-gate-off' }));
  await waitFor(() => gated.listBridges().length === 1);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(gated.state.stuckPeers, 0, '闸关：20ms/60ms 的注入值不得生效（任一被读即会在 500ms 内出 stuck）');
  assert.equal(quiet.collected.closed, false);
  await gated.close();

  /* 闸开侧：同一组注入值当即生效（静默对端 + 真钟——未走环境变量时默认窗口 30s，必红）。 */
  assert.notEqual(process.env.NODE_TEST_CONTEXT, undefined, '闸开侧以测试运行器在场为前提');
  const live = startServer(cleanup, root);
  await live.start();
  const silent = await connectRaw(endpointFor(root));
  cleanup(() => silent.socket.destroy());
  writeLine(silent.socket, helloFrame({ bridgeId: 'bridge-gate-on' }));
  await waitFor(() => live.listBridges().length === 1);
  await waitFor(() => live.state.stuckPeers === 1, { timeoutMs: 3000 });
  await waitFor(() => silent.collected.closed, { timeoutMs: 3000 });
});

/* 闸关侧构造：闸在构造期读取——在构造窗口内临时摘除 NODE_TEST_CONTEXT，随即还原。 */
function createGatedServer(cleanup, dataDir) {
  const saved = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    return startServer(cleanup, dataDir);
  } finally {
    restoreEnv('NODE_TEST_CONTEXT', saved);
  }
}

/* —— 端点、权限与陈旧清理 —— */

test('权限（POSIX）：run/ 0700、core.sock 0600，umask 022/077 干扰下仍成立', { skip: process.platform === 'win32' ? 'Windows 无 POSIX mode 语义（如实标注）：本机以「端点语义替代」用例承载，权限断言由 CI（ubuntu）执行' : false }, async (t) => {
  const cleanup = cleanupOf(t);
  const root = makeTempDir(t);
  for (const umask of [0o022, 0o077]) {
    const prior = process.umask(umask);
    try {
      const dir = ensureRunDir(root, { log: silentLog() });
      assert.equal(statSync(dir).mode & 0o777, 0o700, `umask ${umask.toString(8)} 下 run/ 仍须 0700`);
      const server = startServer(cleanup, root);
      const { endpoint } = await server.start();
      assert.equal(statSync(endpoint).mode & 0o777, 0o600, `umask ${umask.toString(8)} 下 core.sock 仍须 0600`);
      await server.close();
    } finally {
      process.umask(prior);
    }
  }
});

test('权限（Windows 语义替代）：run/ 创建、端点为管道、同名二次监听 EADDRINUSE、关闭后释放', { skip: process.platform !== 'win32' ? '本用例固化 Windows 管道生命周期语义（POSIX 由 CI 执行 core.sock 断言）' : false }, async (t) => {
  const cleanup = cleanupOf(t);
  const root = makeTempDir(t);
  const first = startServer(cleanup, root);
  const started = await first.start();
  assert.match(started.endpoint, /^\\\\\.\\pipe\\waystation-[0-9a-f]{8}$/);
  assert.equal(statSync(runDir(root)).isDirectory(), true);

  const second = createIpcServer({ dataDir: root, token: TOKEN, welcomeOf: welcomeFixture(root), log: silentLog() });
  await assert.rejects(second.start(), (error) => error.code === 'EADDRINUSE', '同一数据根不得并行两个服务端');
  await second.close();

  await first.close();
  const third = startServer(cleanup, root);
  const restarted = await third.start();
  assert.equal(restarted.endpoint, started.endpoint, '服务关闭后端点名释放、可重听（管道随进程消失）');
});

test('陈旧清理（POSIX）：prepareEndpoint 解除 socket 残余、清理后重听成功', { skip: process.platform === 'win32' ? 'Windows 管道随进程消失、无残余（如实标注：残余清理分支不可在本机执行，由 CI 承载）' : false }, async (t) => {
  const cleanup = cleanupOf(t);
  const root = makeTempDir(t);
  const server = startServer(cleanup, root);
  const { endpoint } = await server.start();
  assert.equal(statSync(endpoint).isSocket(), true);
  await server.close();
  assert.equal(prepareEndpoint(root), true, '残留 socket 文件应被清理');
  assert.equal(existsSync(endpoint), false);
  const again = startServer(cleanup, root);
  await again.start();
});

test('陈旧清理（Windows 语义替代）：无残余可清（恒 false），清理语义由「关闭后重听成功」表达', (t) => {
  const root = makeTempDir(t);
  assert.equal(prepareEndpoint(root), false, 'run/ 尚不存在时无残余');
  mkdirSync(runDir(root), { recursive: true });
  assert.equal(prepareEndpoint(root, 'linux'), false, '目录在而无 socket 文件');
});

/* —— B1 首验证据固化 —— */

test('B1 首验固化（Windows）：管道服务端对端身份面不可得——Node 面新增对端凭据 API 时本用例转红、提示重估', { skip: process.platform !== 'win32' ? 'Windows 管道对端凭据面（POSIX 侧同结论：Node 核心面不暴露 SO_PEERCRED，证据见任务报告）' : false }, async (t) => {
  const cleanup = cleanupOf(t);
  const root = makeTempDir(t);
  const endpoint = endpointFor(root);
  const observed = [];
  const server = net.createServer((socket) => observed.push(socket));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, resolve);
  });
  cleanup(() => new Promise((resolve) => {
    for (const socket of observed) {
      socket.destroy();
    }
    server.close(() => resolve());
  }));
  const client = net.connect(endpoint);
  client.on('error', () => {});
  cleanup(() => client.destroy());
  await new Promise((resolve) => client.once('connect', resolve));
  const peer = await waitFor(() => (observed.length === 1 ? observed[0] : null));

  assert.equal(peer.remoteAddress, undefined);
  assert.equal(peer.remotePort, undefined);
  assert.equal(peer.remoteFamily, undefined);
  /* 枚举断言（宽于固定名单）：实例自有属性与原型上任何匹配 peer|cred|pid 的新面孔都转红——
   * Node 将来以别的名字暴露对端凭据（如 getPeerPid/peerCred）时不得静默通过。 */
  const ownMatches = Object.getOwnPropertyNames(peer).filter((name) => /peer|cred|pid/i.test(name));
  const protoMatches = Object.getOwnPropertyNames(Object.getPrototypeOf(peer)).filter((name) => /peer|cred|pid/i.test(name));
  assert.deepEqual(ownMatches, [], '实例自有属性不得出现对端凭据面');
  assert.deepEqual(protoMatches, ['_getpeername'], '原型上仅内部 _getpeername；出现新成员须立即重估「回落 A」');
  assert.deepEqual(peer._getpeername(), {}, '内部 getpeername 对管道连接返回空对象（无对端地址/身份）');
  assert.equal(peer._handle.fd, -1, '句柄无真实 fd——拿不到可调 Win32 GetNamedPipeClientProcessId 的句柄');
  assert.deepEqual(
    Object.getOwnPropertyNames(process.binding('pipe_wrap')).sort(),
    ['Pipe', 'PipeConnectWrap', 'constants'],
    'pipe_wrap 绑定面出现新成员须立即重估「回落 A」',
  );
});

/* —— 客户端连接失败面 —— */

test('客户端：welcome ok:false → connect() 以对应 code 拒绝（认证/版本/换代/关停四码透传）', async (t) => {
  const cleanup = cleanupOf(t);
  const root = makeTempDir(t);
  let code = 'version';
  await startStubCore(cleanup, endpointFor(root), (frame, socket) => {
    if (frame.type === 'hello') {
      socket.write(encodeIpcFrame({ type: 'welcome', ok: false, code, message: '拒绝' }));
    }
  });
  for (const expected of ['version', 'auth', 'replacing', 'shutting-down']) {
    code = expected;
    const client = createIpcClient({
      dataDir: root,
      hello: { app: '0.1.0', token: TOKEN, bridgeId: `bridge-${expected}` },
      log: silentLog(),
    });
    await assert.rejects(client.connect(), (error) => {
      assert.equal(error.code, expected);
      return true;
    });
    await client.close();
  }
});

test('客户端：version 拒绝帧的核心 ipcV 透传为 error.coreV（换代方向判定输入）', async (t) => {
  const cleanup = cleanupOf(t);
  const root = makeTempDir(t);
  await startStubCore(cleanup, endpointFor(root), (frame, socket) => {
    if (frame.type === 'hello') {
      socket.write(encodeIpcFrame({ type: 'welcome', ok: false, code: 'version', v: 2, message: '驿站已升级，请重开会话加载新版本' }));
    }
  });
  const client = createIpcClient({
    dataDir: root,
    hello: { app: '0.1.0', token: TOKEN, bridgeId: 'bridge-version-probe' },
    log: silentLog(),
  });
  await assert.rejects(client.connect(), (error) => {
    assert.equal(error.code, 'version');
    assert.equal(error.coreV, 2);
    return true;
  });
  await client.close();
});

test('客户端：端点缺失（无核心）→ connect() 以 ENOENT 拒绝', async (t) => {
  const root = makeTempDir(t);
  const client = createIpcClient({
    dataDir: root,
    hello: { app: '0.1.0', token: TOKEN, bridgeId: 'bridge-none' },
    log: silentLog(),
  });
  await assert.rejects(client.connect(), (error) => {
    assert.equal(error.code, 'ENOENT');
    return true;
  });
  await client.close();
});

test('多根隔离：两个数据根各自起服务，客户端各连各的不串线', async (t) => {
  const cleanup = cleanupOf(t);
  const rootA = makeTempDir(t);
  const rootB = makeTempDir(t);
  const serverA = startServer(cleanup, rootA);
  const serverB = startServer(cleanup, rootB);
  await serverA.start();
  await serverB.start();
  const clientA = createIpcClient({
    dataDir: rootA,
    hello: { app: '0.1.0', token: TOKEN, bridgeId: 'bridge-a' },
    log: silentLog(),
  });
  const clientB = createIpcClient({
    dataDir: rootB,
    hello: { app: '0.1.0', token: TOKEN, bridgeId: 'bridge-b' },
    log: silentLog(),
  });
  cleanup(() => clientA.close());
  cleanup(() => clientB.close());
  await clientA.connect();
  await clientB.connect();
  assert.deepEqual(serverA.listBridges().map((record) => record.bridgeId), ['bridge-a']);
  assert.deepEqual(serverB.listBridges().map((record) => record.bridgeId), ['bridge-b']);
});

test('IPC 端点选择：auto 优先 TCP 并回退旧端点；pipe / tcp 强制；非法值按 auto', () => {
  const dataDir = 'C:/tmp/ws-ipc-endpoints';
  const legacy = endpointFor(dataDir);
  const tcp = { host: '127.0.0.1', port: 55017 };
  const record = { ipc: { tcp } };
  assert.deepEqual(endpointsOf({ dataDir, record, transport: 'auto' }), { primary: tcp, fallback: legacy, kind: 'tcp' });
  assert.deepEqual(endpointsOf({ dataDir, record, transport: 'pipe' }), { primary: legacy, fallback: null, kind: 'legacy' });
  assert.deepEqual(endpointsOf({ dataDir, record, transport: 'tcp' }), { primary: tcp, fallback: null, kind: 'tcp' });
  assert.deepEqual(endpointsOf({ dataDir, record: {}, transport: 'auto' }), { primary: legacy, fallback: null, kind: 'legacy' });
  assert.deepEqual(endpointsOf({ dataDir, record, transport: 'bogus' }), { primary: tcp, fallback: legacy, kind: 'tcp' });
  assert.deepEqual(
    endpointsOf({ dataDir, record: { ipc: { tcp: { host: '10.0.0.1', port: 1 } } }, transport: 'auto' }),
    { primary: legacy, fallback: null, kind: 'legacy' },
    'TCP 环回端点只接受 127.0.0.1',
  );
  assert.deepEqual(
    endpointsOf({ dataDir, record: { ipc: { tcp: { host: '127.0.0.1', port: 0 } } }, transport: 'auto' }),
    { primary: legacy, fallback: null, kind: 'legacy' },
    '非法端口忽略',
  );
});

test('transportModeOf：仅 auto / tcp / pipe 生效，非法或缺失按 auto', () => {
  assert.equal(transportModeOf({ WAYSTATION_IPC_TRANSPORT: 'tcp' }), 'tcp');
  assert.equal(transportModeOf({ WAYSTATION_IPC_TRANSPORT: ' PIPE ' }), 'pipe');
  assert.equal(transportModeOf({ WAYSTATION_IPC_TRANSPORT: 'auto' }), 'auto');
  assert.equal(transportModeOf({ WAYSTATION_IPC_TRANSPORT: 'bogus' }), 'auto');
  assert.equal(transportModeOf({}), 'auto');
  assert.equal(transportModeOf(null), 'auto');
});
