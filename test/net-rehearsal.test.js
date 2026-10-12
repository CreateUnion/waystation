import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DISCOVERY_REPLY_MIN_INTERVAL_MS } from '../src/net/discovery.js';
import { makeTempDir, pickFreePort, repoRoot, waitFor } from './helpers.js';

const FIXTURE = join(repoRoot, 'test', 'fixtures', 'net-node.mjs');

/* 本机双进程预演（跨机的本机近似）：两个真实进程、真实套接字、回环双地址同端口。
 * 单播兜底的目标地址正是这样喂进「已知主机清单」的——与生产路径同一机制（PoC 实测：
 * 广播单向盲区正是靠清单里的地址反向补偿）。 */
async function startNode(t, { identityName, bindAddress, port, knownPeers = [], dataDir: reusedDir }) {
  const dataDir = reusedDir ?? makeTempDir(t);   // 复用数据目录 = 同一实例标识（跨重启场景）
  writeNodeConfig(dataDir, { identityName, port });
  const child = spawn(process.execPath, [FIXTURE, JSON.stringify({ dataDir, port, bindAddress, knownPeers })], {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const node = { child, pending: [], ready: null, stderr: '' };
  wireNodeOutput(node);
  attachCommand(node);
  t.after(() => {
    child.kill();
  });
  await waitFor(() => node.ready !== null, { timeoutMs: 10000 });
  return node;
}

/* 预演节点的配置：随机高位端口 + 加速参数（扫描窗口 / 重传节律 / 调度周期），压缩整轮预演的等待时间。 */
function writeNodeConfig(dataDir, { identityName, port }) {
  writeFileSync(
    join(dataDir, 'config.json'),
    JSON.stringify({
      identityName,
      port,
      scanWindowMs: 300,
      retryIntervalMs: 200,
      retrySlowIntervalMs: 300,
      retryFastCount: 2,
      dispatchTickMs: 40,
      dialTimeoutMs: 1000,
    }),
  );
}

/* 绑定子进程输出：stderr 累积留证；stdout 每行 JSON——ready 事件单独收存，其余应答交给等待中的命令。 */
function wireNodeOutput(node) {
  node.child.stderr.on('data', (chunk) => {
    node.stderr += chunk.toString();
  });
  createInterface({ input: node.child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    if (message.event === 'ready') {
      node.ready = message;
      return;
    }
    const waiter = node.pending.shift();
    if (waiter !== undefined) {
      waiter(message);
    }
  });
}

/* 命令接口：一行 JSON 一条命令，应答与请求按序配对（已退出的节点立刻以 stderr 明细拒绝）。 */
function attachCommand(node) {
  node.command = (payload) => new Promise((resolve, reject) => {
    if (node.child.exitCode !== null) {
      reject(new Error(`节点已退出（code=${node.child.exitCode}）：${node.stderr}`));
      return;
    }
    node.pending.push(resolve);
    node.child.stdin.write(JSON.stringify(payload) + '\n');
  });
}

/* 启动自介会刷新对端的同源应答限流窗口：双节点同时启动时，双方启动自介（探测）与紧随的互扫探测
 * 来自同一「地址:端口」，立即扫描会被对端按设计吞掉（同源窗口内不再应答）——settle 等待窗口过期，
 * 使互扫断言不依赖启动时序；产品行为不变（限流窗口自愈，人类尺度无感）。 */
const PAIR_SETTLE_MS = DISCOVERY_REPLY_MIN_INTERVAL_MS + 100;   // 窗口 + 余量

function startPair(t, port) {
  const ready = Promise.all([
    startNode(t, { identityName: '主机甲', bindAddress: '127.0.0.1', port, knownPeers: [{ address: '127.0.0.2', port }] }),
    startNode(t, { identityName: '主机乙', bindAddress: '127.0.0.2', port, knownPeers: [{ address: '127.0.0.1', port }] }),
  ]);
  return ready.then(async ([a, b]) => {
    await new Promise((resolve) => setTimeout(resolve, PAIR_SETTLE_MS));
    return { a, b };
  });
}

test('互扫可见（身份正确）+ ping 双向与不可达', { timeout: 40000 }, async (t) => {
  const port = await pickFreePort();
  const { a, b } = await startPair(t, port);
  const listedByA = await a.command({ cmd: 'list_hosts' });
  const peerSeenByA = listedByA.hosts.find((host) => host.instanceId === b.ready.instanceId);
  assert.ok(peerSeenByA, `甲应扫到乙，实际清单：${JSON.stringify(listedByA.hosts)}`);
  assert.equal(peerSeenByA.identityName, '主机乙');
  assert.equal(peerSeenByA.endpoints[0].address, '127.0.0.2', '首选地址 = 首个应答来源地址');
  assert.equal(peerSeenByA.endpoints[0].port, port, '首选端点端口 = 应答来源端口（双方同端口）');
  const listedByB = await b.command({ cmd: 'list_hosts' });
  const peerSeenByB = listedByB.hosts.find((host) => host.instanceId === a.ready.instanceId);
  assert.ok(peerSeenByB, '乙应扫到甲');
  assert.equal(peerSeenByB.identityName, '主机甲');
  const pingedByA = await a.command({ cmd: 'ping', address: '127.0.0.2', port });
  assert.equal(pingedByA.reachable, true);
  assert.ok(Number.isInteger(pingedByA.rttMs));
  const pingedByB = await b.command({ cmd: 'ping', address: '127.0.0.1', port });
  assert.equal(pingedByB.reachable, true);
  const dead = await a.command({ cmd: 'ping', address: '127.0.0.3', port });
  assert.equal(dead.reachable, false);
});

test('消息可靠往返：A 发 B 收，会话投递成功后 A 侧见第三档', { timeout: 40000 }, async (t) => {
  const port = await pickFreePort();
  const { a, b } = await startPair(t, port);
  const sent = await a.command({
    cmd: 'send',
    collabId: 'rehearsal-1',
    to: { instanceId: b.ready.instanceId, address: '127.0.0.2', port },
    payload: { text: '你好，乙' },
  });
  assert.equal(sent.ok, true);
  assert.equal(sent.tier, 'queued');
  const received = await waitFor(async () => {
    const inbox = await b.command({ cmd: 'inbox', collabId: 'rehearsal-1' });
    return inbox.messages.find((message) => message.msgId === sent.msgId);
  }, { timeoutMs: 15000 });
  assert.equal(received.from.instanceId, a.ready.instanceId);
  assert.equal(received.payload.text, '你好，乙');
  const delivered = await waitFor(async () => {
    const status = await a.command({ cmd: 'status', collabId: 'rehearsal-1' });
    const row = status.rows.find((candidate) => candidate.msgId === sent.msgId);
    return row !== undefined && row.tier === 'session' ? row : null;
  }, { timeoutMs: 15000 });
  assert.equal(delivered.expired, false);
  assert.ok(delivered.ackedAt !== null);
  assert.ok(delivered.deliveredAt !== null);
  // 乙的回报条目必须经甲的 ack 离开队头——否则乙→甲该单元后续消息会被永久阻塞
  const reportDrained = await waitFor(async () => {
    const status = await b.command({ cmd: 'status', collabId: 'rehearsal-1' });
    return status.rows.length >= 1 && status.rows.every((row) => row.tier !== 'queued') ? status : null;
  }, { timeoutMs: 15000 });
  assert.ok(reportDrained.rows.length >= 1);
});

test('第二档语义：对端会话写入失败 → 维持「已到对方驿站」', { timeout: 40000 }, async (t) => {
  const port = await pickFreePort();
  const { a, b } = await startPair(t, port);
  await b.command({ cmd: 'set_writer', ok: false });
  const sent = await a.command({
    cmd: 'send',
    collabId: 'rehearsal-2',
    to: { instanceId: b.ready.instanceId, address: '127.0.0.2', port },
    payload: { text: '写不进去' },
  });
  await waitFor(async () => {
    const inbox = await b.command({ cmd: 'inbox', collabId: 'rehearsal-2' });
    return inbox.messages.some((message) => message.msgId === sent.msgId);
  }, { timeoutMs: 15000 });
  const row = await waitFor(async () => {
    const status = await a.command({ cmd: 'status', collabId: 'rehearsal-2' });
    const candidate = status.rows.find((entry) => entry.msgId === sent.msgId);
    return candidate !== undefined && candidate.tier === 'at-peer' ? candidate : null;
  }, { timeoutMs: 15000 });
  await new Promise((resolve) => setTimeout(resolve, 700));   // 多个重试周期后仍维持第二档
  const again = await a.command({ cmd: 'status', collabId: 'rehearsal-2' });
  assert.equal(again.rows.find((entry) => entry.msgId === sent.msgId).tier, 'at-peer');
  assert.equal(row.deliveredAt, null);
});

test('离线排队 + 补投 + 保序：对端未启动时排队，启动后按发送序送达', { timeout: 60000 }, async (t) => {
  const port = await pickFreePort();
  const bDir = makeTempDir(t);
  // 先起一次乙取实例标识与地址归属，再让它退出——重启时复用数据目录（实例标识不变）
  const probe = await startNode(t, { identityName: '主机乙', bindAddress: '127.0.0.2', port, dataDir: bDir });
  const peerId = probe.ready.instanceId;
  await probe.command({ cmd: 'exit' });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const a = await startNode(t, { identityName: '主机甲', bindAddress: '127.0.0.1', port, knownPeers: [{ address: '127.0.0.2', port }] });
  const sentIds = [];
  const messages = ['第一封', '第二封', '第三封'];
  for (const text of messages) {
    const sent = await a.command({ cmd: 'send', collabId: 'rehearsal-3', to: { instanceId: peerId, address: '127.0.0.2', port }, payload: { text } });
    assert.equal(sent.ok, true);
    assert.equal(sent.tier, 'queued', '对方离线：当场返回已排队');
    sentIds.push(sent.msgId);
  }
  await new Promise((resolve) => setTimeout(resolve, 700));
  const queued = await a.command({ cmd: 'status', collabId: 'rehearsal-3' });
  assert.ok(queued.rows.every((row) => row.tier === 'queued' && row.expired === false), '对方离线期间全部保持已排队');
  const b = await startNode(t, { identityName: '主机乙', bindAddress: '127.0.0.2', port, dataDir: bDir, knownPeers: [{ address: '127.0.0.1', port }] });
  assert.equal(b.ready.instanceId, peerId, '同一数据目录重启后实例标识不变');
  const received = await waitFor(async () => {
    const inbox = await b.command({ cmd: 'inbox', collabId: 'rehearsal-3' });
    return inbox.messages.length === messages.length ? inbox.messages : null;
  }, { timeoutMs: 20000 });
  assert.deepEqual(received.map((message) => message.payload.text), messages, '补投顺序 = 发送顺序（FIFO 保序）');
  assert.deepEqual(received.map((message) => message.msgId), sentIds);
  await waitFor(async () => {
    const status = await a.command({ cmd: 'status', collabId: 'rehearsal-3' });
    return status.rows.every((row) => row.tier === 'session');
  }, { timeoutMs: 20000 });
});

test('重启收敛（故障注入）：强杀不丢队列，以原数据目录重建后补投至终态', { timeout: 60000 }, async (t) => {
  const port = await pickFreePort();
  const aDir = makeTempDir(t);
  const bDir = makeTempDir(t);
  // 先起一次乙取实例标识，再让它退出——重启时复用数据目录（实例标识不变），仍是「同一个乙」
  const probe = await startNode(t, { identityName: '主机乙', bindAddress: '127.0.0.2', port, dataDir: bDir });
  const peerId = probe.ready.instanceId;
  await probe.command({ cmd: 'exit' });
  await new Promise((resolve) => setTimeout(resolve, 200));
  // 乙不在线时甲发消息：离线入队（落盘承诺）——随后甲进程被强杀，队列只靠磁盘幸存
  const a1 = await startNode(t, { identityName: '主机甲', bindAddress: '127.0.0.1', port, knownPeers: [{ address: '127.0.0.2', port }], dataDir: aDir });
  const sent = await a1.command({
    cmd: 'send',
    collabId: 'restart-1',
    to: { instanceId: peerId, address: '127.0.0.2', port },
    payload: { text: '重启前寄出' },
  });
  assert.equal(sent.ok, true);
  assert.equal(sent.tier, 'queued', '对端离线：当场返回已排队');
  const a1Exited = new Promise((resolve) => a1.child.on('exit', resolve));
  a1.child.kill('SIGKILL');   // 故障注入：进程被强杀（重启收敛验证的是队列落盘，不是优雅退出）
  await a1Exited;
  // 乙上线；甲以原数据目录重建 → 续投至乙的会话，甲侧推进到第三档
  const b = await startNode(t, { identityName: '主机乙', bindAddress: '127.0.0.2', port, dataDir: bDir });
  const a2 = await startNode(t, { identityName: '主机甲', bindAddress: '127.0.0.1', port, knownPeers: [{ address: '127.0.0.2', port }], dataDir: aDir });
  assert.equal(a2.ready.instanceId, a1.ready.instanceId, '同一数据目录重建后实例标识不变');
  const received = await waitFor(async () => {
    const inbox = await b.command({ cmd: 'inbox', collabId: 'restart-1' });
    return inbox.messages.find((message) => message.msgId === sent.msgId) ?? null;
  }, { timeoutMs: 20000 });
  assert.equal(received.payload.text, '重启前寄出', '强杀重启后队列不丢：消息补投到乙');
  const delivered = await waitFor(async () => {
    const status = await a2.command({ cmd: 'status', collabId: 'restart-1' });
    const row = status.rows.find((candidate) => candidate.msgId === sent.msgId);
    return row !== undefined && row.tier === 'session' ? row : null;
  }, { timeoutMs: 20000 });
  assert.equal(delivered.expired, false, '续投收敛：重启后仍完成全链路至第三档');
});

test('exit 干净退出（真实进程生命周期收尾）', { timeout: 40000 }, async (t) => {
  const port = await pickFreePort();
  const a = await startNode(t, { identityName: '主机甲', bindAddress: '127.0.0.1', port });
  const exitCode = new Promise((resolve) => a.child.on('exit', resolve));
  const closed = await a.command({ cmd: 'exit' });
  assert.equal(closed.ok, true);
  assert.equal(await exitCode, 0);
});
