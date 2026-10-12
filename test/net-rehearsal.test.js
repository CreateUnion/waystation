import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DISCOVERY_REPLY_MIN_INTERVAL_MS } from '../src/net/discovery.js';
import { makeTempDir, pickFreePort, pickFreeSegment, repoRoot, waitFor } from './helpers.js';

const FIXTURE = join(repoRoot, 'test', 'fixtures', 'net-node.mjs');

/* 假会话收件箱：命名管道上的真实 server——适配器端到端预演的目标（成功路径保持连接、reject 路径即时销毁，
 * 与真实 CLI 的两种表现同一形态）。 */
async function startFakeSessionInbox(t, { reject = false } = {}) {
  const path = `\\\\.\\pipe\\waystation-rehearsal-${randomUUID()}`;
  const chunks = [];
  const server = net.createServer((socket) => {
    if (reject) {
      socket.destroy();
      return;
    }
    socket.on('data', (chunk) => chunks.push(chunk));
  });
  await new Promise((resolve, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(path, resolve);
  });
  t.after(() => server.close());
  return { path, receivedText: () => Buffer.concat(chunks).toString('utf8') };
}

/* 站点进程的统一收尾：node:test 的 after 钩子按注册序执行，而临时目录的删除钩子由 makeTempDir 在其
 * 调用点先行注册——「先终止站点并等其退出、后删目录」要求收尾钩子先于任何 makeTempDir 注册，否则删除
 * 会与存活站点的写盘（collabs/*、日志）并发，Windows 下 rmdir 撞上新写入即 ENOTEMPTY 假红。
 * 每个测试实例一份节点清单（WeakMap 随测试上下文回收），钩子只注册一次。 */
const nodesByTest = new WeakMap();

function cleanupRegistryOf(t) {
  let nodes = nodesByTest.get(t);
  if (nodes === undefined) {
    nodes = [];
    nodesByTest.set(t, nodes);
    t.after(async () => {
      for (const node of nodes) {
        await stopNode(node);
      }
    });
  }
  return nodes;
}

/* 进程已退出（含被强杀）则无操作；否则终止并等 exit 落地——等完才轮到目录删除钩子。 */
async function stopNode(node) {
  const child = node.child;
  if (child === null || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await exited;
}

/* 复用目录的用例（离线补投 / 重启收敛）建目录也走这里：收尾钩子必须抢在 makeTempDir 的删除钩子前注册。 */
function makeNodeDir(t) {
  cleanupRegistryOf(t);
  return makeTempDir(t);
}

/* 本机双进程预演（跨机的本机近似）：两个真实进程、真实套接字、回环双地址同端口。
 * 单播兜底的目标地址正是这样喂进「已知主机清单」的——与生产路径同一机制（PoC 实测：
 * 广播单向盲区正是靠清单里的地址反向补偿）。 */
async function startNode(t, { identityName, bindAddress, port, knownPeers = [], dataDir: reusedDir, adapter = false, env = {} }) {
  const node = { child: null, pending: [], ready: null, stderr: '' };
  cleanupRegistryOf(t).push(node);   // 先登记收尾（见 nodesByTest 注释），再让 makeTempDir 注册删除
  const dataDir = reusedDir ?? makeTempDir(t);   // 复用数据目录 = 同一实例标识（跨重启场景）
  writeNodeConfig(dataDir, { identityName, port });
  node.child = spawn(process.execPath, [FIXTURE, JSON.stringify({ dataDir, bindAddress, knownPeers, adapter })], {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  wireNodeOutput(node);
  attachCommand(node);
  await waitFor(() => node.ready !== null, { timeoutMs: 10000 });
  assert.equal(node.ready.bind.ok, true, JSON.stringify(node.ready.bind));
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
    const timer = setTimeout(() => {
      reject(new Error(`节点命令超时（10s）：${JSON.stringify(payload)}；stderr：${node.stderr}`));
    }, 10000);
    node.pending.push((message) => {
      clearTimeout(timer);
      resolve(message);
    });
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
  await new Promise((resolve) => setTimeout(resolve, 700));   // 该条目已 ack、不再处于重试集：浸泡验证的是档位稳定（不被误翻为第三档、不被误过期）
  const again = await a.command({ cmd: 'status', collabId: 'rehearsal-2' });
  assert.equal(again.rows.find((entry) => entry.msgId === sent.msgId).tier, 'at-peer');
  assert.equal(row.deliveredAt, null);
});

test('离线排队 + 补投 + 保序：对端未启动时排队，启动后按发送序送达', { timeout: 60000 }, async (t) => {
  const port = await pickFreePort();
  const bDir = makeNodeDir(t);
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
  const aDir = makeNodeDir(t);
  const bDir = makeNodeDir(t);
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

test('多站点同机预演：同地址两节点（端口 P 与 P+1）按站点端口独立投递', { timeout: 40000 }, async (t) => {
  const port = await pickFreeSegment(2);   // 两站点占相邻端口：整段取（pickFreePort 只保证单端口空闲，邻位不保证）
  const a = await startNode(t, { identityName: '主机甲', bindAddress: '127.0.0.1', port });
  const b = await startNode(t, { identityName: '主机乙', bindAddress: '127.0.0.1', port: port + 1, knownPeers: [{ address: '127.0.0.1', port }] });
  const sent = await a.command({
    cmd: 'send',
    collabId: 'rehearsal-multi',
    to: { instanceId: b.ready.instanceId, address: '127.0.0.1', port: port + 1 },
    payload: { text: '按站点端口投递' },
  });
  assert.equal(sent.ok, true);
  const received = await waitFor(async () => {
    const inbox = await b.command({ cmd: 'check_inbox', collabId: 'rehearsal-multi' });
    return inbox.result.messages.find((message) => message.msgId === sent.msgId) ?? null;
  }, { timeoutMs: 15000 });
  assert.equal(received.payload.text, '按站点端口投递');
  await waitFor(async () => {
    const status = await a.command({ cmd: 'status', collabId: 'rehearsal-multi' });
    const row = status.rows.find((candidate) => candidate.msgId === sent.msgId);
    return row !== undefined && row.tier === 'session' ? row : null;
  }, { timeoutMs: 15000 });
});

test('适配器端到端：乙经注入口投进假收件箱（内容含上下文头），甲侧推进第三档', { timeout: 40000 }, async (t) => {
  const port = await pickFreePort();
  const inbox = await startFakeSessionInbox(t);
  const a = await startNode(t, { identityName: '主机甲', bindAddress: '127.0.0.1', port });
  const b = await startNode(t, {
    identityName: '主机乙',
    bindAddress: '127.0.0.2',
    port,
    knownPeers: [{ address: '127.0.0.1', port }],
    adapter: true,
    env: { CLAUDE_CODE_MESSAGING_SOCKET: inbox.path, CLAUDE_CODE_MESSAGING_TOKEN: 'tok-1' },
  });
  const sent = await a.command({
    cmd: 'send',
    collabId: 'rehearsal-adapter',
    to: { instanceId: b.ready.instanceId, address: '127.0.0.2', port },
    payload: { text: '请查收' },
  });
  assert.equal(sent.ok, true);
  await waitFor(() => inbox.receivedText().includes('请查收'), { timeoutMs: 15000 });
  assert.ok(inbox.receivedText().includes('【驿站｜另一会话发来的协作消息】'), '注入内容含上下文头');
  assert.ok(inbox.receivedText().includes('协作：rehearsal-adapter'));
  await waitFor(async () => {
    const status = await a.command({ cmd: 'status', collabId: 'rehearsal-adapter' });
    const row = status.rows.find((candidate) => candidate.msgId === sent.msgId);
    return row !== undefined && row.tier === 'session' ? row : null;
  }, { timeoutMs: 15000 });
});

test('适配器拒收：注入口关闭 → 甲维持第二档（不误报第三档）', { timeout: 40000 }, async (t) => {
  const port = await pickFreePort();
  const inbox = await startFakeSessionInbox(t, { reject: true });
  const a = await startNode(t, { identityName: '主机甲', bindAddress: '127.0.0.1', port });
  const b = await startNode(t, {
    identityName: '主机乙',
    bindAddress: '127.0.0.2',
    port,
    knownPeers: [{ address: '127.0.0.1', port }],
    adapter: true,
    env: { CLAUDE_CODE_MESSAGING_SOCKET: inbox.path, CLAUDE_CODE_MESSAGING_TOKEN: 'tok-1' },
  });
  const sent = await a.command({
    cmd: 'send',
    collabId: 'rehearsal-reject',
    to: { instanceId: b.ready.instanceId, address: '127.0.0.2', port },
    payload: { text: '这条会被拒收' },
  });
  assert.equal(sent.ok, true);
  await waitFor(async () => {
    const status = await a.command({ cmd: 'status', collabId: 'rehearsal-reject' });
    const row = status.rows.find((candidate) => candidate.msgId === sent.msgId);
    return row !== undefined && row.tier === 'at-peer' ? row : null;
  }, { timeoutMs: 15000 });
  await new Promise((resolve) => setTimeout(resolve, 700));   // 该条目已 ack、不在重试集：浸泡验证档位稳定
  const again = await a.command({ cmd: 'status', collabId: 'rehearsal-reject' });
  assert.equal(again.rows.find((candidate) => candidate.msgId === sent.msgId).tier, 'at-peer');
});
