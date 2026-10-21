import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createIpcClient } from '../src/core/ipc.js';
import { startCore } from '../src/core/main.js';
import { DISCOVERY_DISABLE_ENV } from '../src/net/discovery.js';
import { coreJsonPath } from '../src/paths.js';
import { makeTempDir, pickFreePort, waitFor } from './helpers.js';

/* 核心组合根的接线补面（in-process 形态）：
 * ①取锁仲裁的两条陈旧判定路径（损坏锁文件的陈旧清理、活 pid＋心跳超期的判死清理）——
 *   main.js 的仲裁器装配与告警通道由此触达；
 * ②发现层敲门命中 → 协作面应答 → join-ack 回发的整链（onJoinKnock 注入面）。
 * 收尾钩子先于 makeTempDir 的删除钩子注册（存活核心写盘与目录删除相撞会假红）。 */

const CORE_FILE = join('run', 'core.json');
const TOKEN = 'a1'.repeat(32);

function makeCoreHome(t) {
  const stops = [];
  t.after(async () => {
    for (const stop of stops) {
      await stop();
    }
  });
  const home = makeTempDir(t);
  return { home, addStop: (stop) => stops.push(stop) };
}

function writeCoreConfig(home, extra = {}) {
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({ scanWindowMs: 300, dialTimeoutMs: 1500, probeTimeoutMs: 300, viewerAutoOpen: false, ...extra }),
  );
}

/* 线上数据报是外部输入：坏 JSON 按非本面输入忽略，不打断接收循环。 */
function parseJsonOrNull(buffer) {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  }
}

/* 能力探测应答者：建协前核心会向目标单播 probe，缺 participants 的应答会被判「不支持」而拒绝建协。
 * 该对端声明 participants:2，模拟同版的建协目标。 */
async function startCapablePeer(t, { port, instanceId, identityName }) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: false });
  t.after(() => {
    try {
      socket.close();
    } catch {
      // 未绑定成功或已关闭：无需再关
    }
  });
  socket.on('message', (buffer, rinfo) => {
    const datagram = parseJsonOrNull(buffer);
    if (datagram?.type !== 'probe') {
      return;
    }
    const ack = Buffer.from(JSON.stringify({
      v: 1, type: 'probe-ack', instanceId, identityName, collabCount: 0, port, participants: 2,
    }));
    socket.send(ack, rinfo.port, rinfo.address);
  });
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind({ port, address: '0.0.0.0' }, resolve);
  });
  return socket;
}

/* 本用例的整链依赖真实 UDP（能力单播探测与敲门应答都经发现层套接字）。发现隔离开关会让
 * 发现层完全不绑定、能力探测恒为未知，故启动核心前临时关闭；锚点段取空闲段，不触达真实站点段。 */
function withDiscoveryEnabled(t) {
  const saved = process.env[DISCOVERY_DISABLE_ENV];
  delete process.env[DISCOVERY_DISABLE_ENV];
  t.after(() => {
    if (saved === undefined) {
      delete process.env[DISCOVERY_DISABLE_ENV];
    } else {
      process.env[DISCOVERY_DISABLE_ENV] = saved;
    }
  });
}

/* 敲门方：UDP 套接字发送 join-knock，等待应答回发（应答按来源地址与端口寻址），返回收到的 join-ack。 */
async function sendKnockAndAwaitAck(t, { port, knockId, name }) {
  const socket = dgram.createSocket('udp4');
  t.after(() => socket.close());
  await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
  const received = [];
  socket.on('message', (buffer) => {
    const datagram = parseJsonOrNull(buffer);
    if (datagram !== null) {
      received.push(datagram);
    }
  });
  const knock = Buffer.from(JSON.stringify({
    v: 1, type: 'join-knock', instanceId: 'inst-knock', identityName: '敲门者', knockId, name,
  }));
  await new Promise((resolve, reject) => socket.send(knock, port, '127.0.0.1', (error) => (error ? reject(error) : resolve())));
  await waitFor(() => (received.some((item) => item.type === 'join-ack') ? true : null), { timeoutMs: 5000 });
  return received.find((item) => item.type === 'join-ack');
}

function coreRecordOf(overrides = {}) {
  const startedAt = new Date(Date.now() - 300000).toISOString();
  return {
    v: 1,
    ipcV: 1,
    appVersion: '0.1.0',
    pid: 2 ** 30,
    endpoint: process.platform === 'win32' ? '\\\\?\\pipe\\waystation-deadbeef' : '/tmp/waystation-deadbeef.sock',
    token: TOKEN,
    identity: null,
    port: 19000,
    startedAt,
    status: 'starting',
    startupDeadline: new Date(Date.parse(startedAt) + 15000).toISOString(),
    heartbeatAt: new Date(Date.now() - 300000).toISOString(),
    ...overrides,
  };
}

function writeCoreJson(home, content) {
  mkdirSync(join(home, 'run'), { recursive: true });
  const path = join(home, CORE_FILE);
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
  return path;
}

function spawnCoreEnv(home, extra = {}) {
  return { ...process.env, WAYSTATION_HOME: home, ...extra };
}

async function startCoreOnTempRoot(t, home, extraEnv = {}) {
  writeCoreConfig(home, { port: await pickFreePort() });
  const started = await startCore({ env: spawnCoreEnv(home, extraEnv) });
  assert.equal(started.ok, true, started.message ?? '核心启动');
  t.after(() => started.core.stop());
  return JSON.parse(readFileSync(coreJsonPath(home), 'utf8'));
}

function bridgeClientFor(home, record, { bridgeId, sessionId }) {
  const frames = [];
  const client = createIpcClient({
    dataDir: home,
    hello: { app: record.appVersion, token: record.token, bridgeId, sessionId },
    onFrame: (frame) => frames.push(frame),
  });
  return { client, frames };
}

async function callAndWait(entry, tool, args) {
  const id = randomUUID();
  entry.client.send({ type: 'call', id, tool, args });
  await waitFor(() => entry.frames.some((frame) => frame.type === 'result' && frame.id === id), { timeoutMs: 10000 });
  return JSON.parse(entry.frames.find((frame) => frame.type === 'result' && frame.id === id).content[0].text);
}

test('取锁仲裁·损坏锁文件的陈旧清理：照常启动且旧锁以 stale 副本留证', { timeout: 30000 }, async (t) => {
  const { home, addStop } = makeCoreHome(t);
  writeCoreConfig(home, { port: await pickFreePort() });
  const path = writeCoreJson(home, '{ 不是合法 JSON');
  const past = new Date(Date.now() - 600000);
  utimesSync(path, past, past);   // 陈旧 mtime：损坏文件按真残留处置（不作半写窗口豁免）
  const started = await startCore({ env: spawnCoreEnv(home) });
  assert.equal(started.ok, true, started.message ?? '陈旧锁清理后应接管启动');
  addStop(() => started.core.stop());
  const record = JSON.parse(readFileSync(coreJsonPath(home), 'utf8'));
  assert.equal(record.pid, process.pid, '锁已由本进程重建');
  assert.equal(record.status, 'ready');
  assert.equal(readdirSync(join(home, 'run')).filter((name) => name.startsWith('core.json.stale-')).length, 1, '损坏锁以 stale 副本留证');
});

test('取锁仲裁·活 pid＋心跳超期的判死清理：连续观测后接管启动', { timeout: 30000 }, async (t) => {
  const { home, addStop } = makeCoreHome(t);
  writeCoreConfig(home, { port: await pickFreePort() });
  /* pid 取本进程（活着）：判死只能由「心跳超期＋端点反证不可连＋连续两次独立观测」达成。 */
  writeCoreJson(home, coreRecordOf({ pid: process.pid }));
  const started = await startCore({
    env: spawnCoreEnv(home, {
      WAYSTATION_TEST_ARBITRATION_POLL_MS: '10',
      WAYSTATION_TEST_JUDGE_THRESHOLD_MS: '10',
      WAYSTATION_TEST_PROBE_TIMEOUT_MS: '200',
    }),
  });
  assert.equal(started.ok, true, started.message ?? '判死清理后应接管启动');
  addStop(() => started.core.stop());
  const record = JSON.parse(readFileSync(coreJsonPath(home), 'utf8'));
  assert.equal(record.pid, process.pid);
  assert.equal(record.status, 'ready');
  assert.notEqual(record.startedAt, coreRecordOf().startedAt, '运行描述符为本进程新建（世代已换代）');
});

test('发现层敲门整链：UDP 敲门命中讨论 → 会话提示 → join-ack 回发（含 collabId）', { timeout: 60000 }, async (t) => {
  const { home } = makeCoreHome(t);
  const peerPort = await pickFreePort();
  await startCapablePeer(t, { port: peerPort, instanceId: 'inst-peer', identityName: '对端' });
  withDiscoveryEnabled(t);
  const record = await startCoreOnTempRoot(t, home);
  const entry = bridgeClientFor(home, record, { bridgeId: 'bridge-knock', sessionId: 'session-knock' });
  t.after(() => entry.client.close().catch(() => {}));
  await entry.client.connect();
  const created = await callAndWait(entry, 'ws_create_collab', {
    name: '敲门讨论',
    topic: '议题',
    mode: 'forum',
    targets: [{ instanceId: 'inst-peer', identityName: '对端', address: '127.0.0.1', port: peerPort }],
  });
  assert.equal(created.ok, true, created.message ?? JSON.stringify(created));
  const knockId = randomUUID();
  const ack = await sendKnockAndAwaitAck(t, { port: record.port, knockId, name: '敲门讨论' });
  assert.equal(ack.knockId, knockId, '应答回带敲门标识（请求-应答对账）');
  assert.equal(ack.collabId, created.collabId, '应答指向命中的讨论实例');
  assert.equal(ack.name, '敲门讨论');
  assert.equal(ack.memberCount >= 1, true);
});
