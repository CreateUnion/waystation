import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DISCOVERY_REPLY_MIN_INTERVAL_MS } from '../src/net/discovery.js';
import { makeTempDir, pickFreePort, pickFreeSegment, repoRoot, waitFor, waitForRebindable } from './helpers.js';

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

/* 复用目录的用例（离线补投 / 重启收敛）建目录也走这里：收尾钩子必须抢在 makeTempDir 的删除钩子前注册；
 * 目录一并登记进文件级兜底（删除钩子被跳过时由文件末清理残留）。 */
function makeNodeDir(t) {
  cleanupRegistryOf(t);
  const dir = makeTempDir(t);
  rehearsalDirs.push(dir);
  return dir;
}

/* 文件级兜底：任何收尾钩子被跳过（如钩子抛错）都会留下存活的预演节点——强制杀灭并响亮失败，绝不让
 * 泄漏把整轮运行拖进永不退出的等待；顺带清理可能因删除钩子被跳过而残留的临时目录（正常路径两处
 * 都无事可做）。 */
const rehearsalNodes = [];
const rehearsalDirs = [];

after(async () => {
  const leakedPids = [];
  for (const node of rehearsalNodes) {
    const child = node.child;
    if (child !== null && child.exitCode === null && child.signalCode === null) {
      leakedPids.push(child.pid);
      child.kill('SIGKILL');
    }
  }
  for (const dir of rehearsalDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      console.error(`[测试收尾] 兜底清理临时目录失败：${dir}（${error.code}）`);
    }
  }
  assert.equal(leakedPids.length, 0, `预演节点未被用例收尾（收尾钩子被跳过？）：${leakedPids.join(',')}——已兜底强制杀灭，检查用例清理`);
});

/* 本机双进程预演（跨机的本机近似）：两个真实进程、真实套接字、回环双地址同端口。
 * 单播兜底的目标地址正是这样喂进「已知主机清单」的——与生产路径同一机制（PoC 实测：
 * 广播单向盲区正是靠清单里的地址反向补偿）。 */
async function spawnNode(t, { identityName, bindAddress, port, knownPeers = [], dataDir: reusedDir, adapter = false, env = {}, collab = true, config = {} }) {
  const node = { child: null, pending: [], ready: null, stderr: '' };
  cleanupRegistryOf(t).push(node);   // 先登记收尾（见 nodesByTest 注释），再让 makeTempDir 注册删除
  const dataDir = reusedDir ?? makeNodeDir(t);   // 复用数据目录 = 同一实例标识（跨重启场景）
  writeNodeConfig(dataDir, { identityName, port, ...config });
  node.child = spawn(process.execPath, [FIXTURE, JSON.stringify({ dataDir, bindAddress, knownPeers, adapter, collab })], {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  rehearsalNodes.push(node);
  wireNodeOutput(node);
  attachCommand(node);
  await waitFor(() => node.ready !== null, { timeoutMs: 10000 });
  return node;
}

/* 单节点启动：即刻断言绑定成功。组守卫的重放轮一律走 spawnNode，绑定断言由守卫在收束轮统一执行。 */
async function startNode(t, options) {
  const node = await spawnNode(t, options);
  assert.equal(node.ready.bind.ok, true, JSON.stringify(node.ready.bind));
  return node;
}

const GROUP_SETUP_ATTEMPTS = 3;

/* 端口环境碰撞判定：取端口（探测后即刻释放）到子进程实际绑定的窗口里，端口可能被并行运行的其它
 * 测试文件/外部程序抢占——绑定竞态分类把无应答的占用者报为 port-taken、把另一预演节点（应答合法
 * pong）报为 occupied-by-station，两者都属环境碰撞；bind-failed 等其余 reason 与实现缺陷同形，不重试
 * （照常交断言判红）。 */
function isPortCollision(node) {
  return node.ready.bind.ok === false
    && (node.ready.bind.reason === 'port-taken' || node.ready.bind.reason === 'occupied-by-station');
}

/* 组级端口守卫：取段与整组节点启动收进同一重放单元（口径同 site.test.js 的 withSegmentBase 与
 * server.test.js 的端口 setup 守卫）——组内任一节点绑定撞上环境碰撞即收摊换新段重放整组；重试用尽
 * 把最后一轮结果原样交回，由绑定断言判红（确定性缺陷不被掩盖，守卫只吸收环境碰撞）。
 * startNodes(port) 返回该组全部节点：组内先启后停的探针也要在内，重放时一并收摊。 */
async function startNodesGuarded(t, size, startNodes) {
  for (let round = 0; ; round++) {
    const port = size > 1 ? await pickFreeSegment(size) : await pickFreePort();
    const nodes = await startNodes(port);
    const collided = nodes.some(isPortCollision);
    if (!collided || round === GROUP_SETUP_ATTEMPTS - 1) {
      for (const node of nodes) {
        assert.equal(node.ready.bind.ok, true, JSON.stringify(node.ready.bind));
      }
      return { port, nodes };
    }
    for (const node of nodes) {
      await stopNode(node);
    }
  }
}

/* 预演节点的配置：随机高位端口 + 加速参数（扫描窗口 / 重传节律 / 调度周期），压缩整轮预演的等待时间；
 * 用例可经 config 逐项透传覆盖（如拉高快重传次数加速离线续投）。 */
function writeNodeConfig(dataDir, { identityName, port, ...overrides }) {
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
      ...overrides,
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

/* 同端口双节点（回环双地址各占一端；重放轮用 spawnNode，绑定断言由组守卫在收束轮执行）。 */
function spawnPairNodes(t, port, { collab = true } = {}) {
  return Promise.all([
    spawnNode(t, { identityName: '主机甲', bindAddress: '127.0.0.1', port, knownPeers: [{ address: '127.0.0.2', port }], collab }),
    spawnNode(t, { identityName: '主机乙', bindAddress: '127.0.0.2', port, knownPeers: [{ address: '127.0.0.1', port }], collab }),
  ]);
}

/* 同地址相邻端口双节点（a 占段基、b 占段基+1，b 的已知主机指向 a）。 */
function spawnAdjacentPairNodes(t, port, { collab = true } = {}) {
  return Promise.all([
    spawnNode(t, { identityName: '主机甲', bindAddress: '127.0.0.1', port, collab }),
    spawnNode(t, { identityName: '主机乙', bindAddress: '127.0.0.1', port: port + 1, knownPeers: [{ address: '127.0.0.1', port }], collab }),
  ]);
}

/* 双节点就绪并等限流窗口过期后交回（等待放在守卫收束后——重放轮不重复等待）。 */
async function startPairGuarded(t, { collab = true } = {}) {
  const { port, nodes } = await startNodesGuarded(t, 1, (startPort) => spawnPairNodes(t, startPort, { collab }));
  const [a, b] = nodes;
  await new Promise((resolve) => setTimeout(resolve, PAIR_SETTLE_MS));
  return { port, a, b };
}

/* 「先起探针乙取实例标识并退出 → 再起甲」的启动序（离线补投 / 重启收敛共用；探针与甲同属一个重放
 * 单元——任一节点绑定被环境抢走即换段重放整组，重启时复用数据目录 = 实例标识不变）。 */
async function startProbeThenNodeOne(t, { probeDir, nodeADir }) {
  return startNodesGuarded(t, 1, async (startPort) => {
    const probe = await spawnNode(t, { identityName: '主机乙', bindAddress: '127.0.0.2', port: startPort, dataDir: probeDir, collab: false });
    await probe.command({ cmd: 'exit' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const a = await spawnNode(t, { identityName: '主机甲', bindAddress: '127.0.0.1', port: startPort, knownPeers: [{ address: '127.0.0.2', port: startPort }], dataDir: nodeADir, collab: false });
    return [probe, a];
  });
}

/* 相邻三连端口三节点（a 占段基，乙丙的已知主机指向 a）。 */
function spawnTriadNodes(t, port, config = {}) {
  return Promise.all([
    spawnNode(t, { identityName: '主机甲', bindAddress: '127.0.0.1', port, config }),
    spawnNode(t, { identityName: '主机乙', bindAddress: '127.0.0.1', port: port + 1, knownPeers: [{ address: '127.0.0.1', port }], config }),
    spawnNode(t, { identityName: '主机丙', bindAddress: '127.0.0.1', port: port + 2, knownPeers: [{ address: '127.0.0.1', port }], config }),
  ]);
}

test('互扫可见（身份正确）+ ping 双向与不可达', { timeout: 40000 }, async (t) => {
  const { port, a, b } = await startPairGuarded(t);
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
  const { port, a, b } = await startPairGuarded(t, { collab: false });
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
  const { port, a, b } = await startPairGuarded(t, { collab: false });
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
  const bDir = makeNodeDir(t);
  // 先起一次乙取实例标识与地址归属，再让它退出——重启时复用数据目录（实例标识不变）
  const { port, nodes: [probe, a] } = await startProbeThenNodeOne(t, { probeDir: bDir });
  const peerId = probe.ready.instanceId;
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
  const b = await startNode(t, { identityName: '主机乙', bindAddress: '127.0.0.2', port, dataDir: bDir, knownPeers: [{ address: '127.0.0.1', port }], collab: false });
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
  const aDir = makeNodeDir(t);
  const bDir = makeNodeDir(t);
  // 先起一次乙取实例标识，再让它退出——重启时复用数据目录（实例标识不变），仍是「同一个乙」
  const { port, nodes: [probe, a1] } = await startProbeThenNodeOne(t, { probeDir: bDir, nodeADir: aDir });
  const peerId = probe.ready.instanceId;
  // 乙不在线时甲发消息：离线入队（落盘承诺）——随后甲进程被强杀，队列只靠磁盘幸存
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
  const b = await startNode(t, { identityName: '主机乙', bindAddress: '127.0.0.2', port, dataDir: bDir, collab: false });
  const a2 = await startNode(t, { identityName: '主机甲', bindAddress: '127.0.0.1', port, knownPeers: [{ address: '127.0.0.2', port }], dataDir: aDir, collab: false });
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
  const { nodes: [a] } = await startNodesGuarded(t, 1, async (startPort) => [
    await spawnNode(t, { identityName: '主机甲', bindAddress: '127.0.0.1', port: startPort }),
  ]);
  const exitCode = new Promise((resolve) => a.child.on('exit', resolve));
  const closed = await a.command({ cmd: 'exit' });
  assert.equal(closed.ok, true);
  assert.equal(await exitCode, 0);
});

test('多站点同机预演：同地址两节点（端口 P 与 P+1）按站点端口独立投递', { timeout: 40000 }, async (t) => {
  // 两站点占相邻端口：整段取（pickFreePort 只保证单端口空闲，邻位不保证）
  const { port, nodes: [a, b] } = await startNodesGuarded(t, 2, (startPort) => spawnAdjacentPairNodes(t, startPort, { collab: false }));
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
  const inbox = await startFakeSessionInbox(t);
  const { port, nodes: [a, b] } = await startNodesGuarded(t, 1, async (startPort) => [
    await spawnNode(t, { identityName: '主机甲', bindAddress: '127.0.0.1', port: startPort, collab: false }),
    await spawnNode(t, {
      identityName: '主机乙',
      bindAddress: '127.0.0.2',
      port: startPort,
      knownPeers: [{ address: '127.0.0.1', port: startPort }],
      adapter: true,
      env: { CLAUDE_CODE_MESSAGING_SOCKET: inbox.path, CLAUDE_CODE_MESSAGING_TOKEN: 'tok-1' },
      collab: false,
    }),
  ]);
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
  const inbox = await startFakeSessionInbox(t, { reject: true });
  const { port, nodes: [a, b] } = await startNodesGuarded(t, 1, async (startPort) => [
    await spawnNode(t, { identityName: '主机甲', bindAddress: '127.0.0.1', port: startPort, collab: false }),
    await spawnNode(t, {
      identityName: '主机乙',
      bindAddress: '127.0.0.2',
      port: startPort,
      knownPeers: [{ address: '127.0.0.1', port: startPort }],
      adapter: true,
      env: { CLAUDE_CODE_MESSAGING_SOCKET: inbox.path, CLAUDE_CODE_MESSAGING_TOKEN: 'tok-1' },
      collab: false,
    }),
  ]);
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

test('协作预演：建协全流程（邀请→同意→建立→对话→看台账）', { timeout: 60000 }, async (t) => {
  // 两站点占相邻端口：整段取（pickFreePort 只保证单端口空闲，邻位不保证）
  const { port, nodes: [a, b] } = await startNodesGuarded(t, 2, (startPort) => spawnAdjacentPairNodes(t, startPort));
  const created = await a.command({
    cmd: 'create_collab',
    name: '联调项目',
    topic: '发布联调',
    targets: [{ instanceId: b.ready.instanceId, identityName: '主机乙', address: '127.0.0.1', port: port + 1 }],
  });
  assert.equal(created.ok, true);
  assert.equal(created.invited.length, 1);
  const collabId = created.collabId;
  await waitFor(async () => {
    const listed = await b.command({ cmd: 'list_collabs' });
    return listed.collabs.some((entry) => entry.collabId === collabId && entry.state === 'proposed');
  }, { timeoutMs: 15000 });
  const approved = await b.command({ cmd: 'approve_invite', collabId, approve: true });
  assert.equal(approved.ok, true);
  assert.equal(approved.decision, 'approved');
  await waitFor(async () => {
    const listed = await a.command({ cmd: 'list_collabs' });
    return listed.collabs.some((entry) => entry.collabId === collabId && entry.state === 'active');
  }, { timeoutMs: 15000 });
  await waitFor(async () => {
    const listed = await b.command({ cmd: 'list_collabs' });
    return listed.collabs.some((entry) => entry.collabId === collabId && entry.state === 'active');
  }, { timeoutMs: 15000 });
  const sent = await a.command({ cmd: 'send_message', collabId, text: '请查收联调事项', type: 'reply' });
  assert.equal(sent.ok, true);
  const ledger = await b.command({ cmd: 'view_ledger', collabId });
  assert.equal(ledger.source, 'live');
  assert.equal(ledger.ledger.status, 'active');
  assert.equal(ledger.ledger.members.length, 2);
});

test('协作预演：同名并发冲突（三节点双冻结 + 广播）', { timeout: 90000 }, async (t) => {
  // 三站点占三连端口：整段取
  const { port, nodes: [a, b, c] } = await startNodesGuarded(t, 3, (startPort) => spawnTriadNodes(t, startPort));
  const first = await a.command({ cmd: 'create_collab', name: '重名项目', topic: '甲发起的联调', targets: [{ instanceId: b.ready.instanceId, identityName: '主机乙', address: '127.0.0.1', port: port + 1 }] });
  assert.equal(first.ok, true);
  await waitFor(async () => {
    const listed = await b.command({ cmd: 'list_collabs' });
    return listed.collabs.some((entry) => entry.collabId === first.collabId && entry.state === 'proposed');
  }, { timeoutMs: 15000 });
  const approved = await b.command({ cmd: 'approve_invite', collabId: first.collabId, approve: true });
  assert.equal(approved.ok, true);
  await waitFor(async () => {
    const listed = await a.command({ cmd: 'list_collabs' });
    return listed.collabs.some((entry) => entry.collabId === first.collabId && entry.state === 'active');
  }, { timeoutMs: 15000 });
  const rival = await c.command({ cmd: 'create_collab', name: '重名项目', topic: '丙发起的联调', targets: [{ instanceId: b.ready.instanceId, identityName: '主机乙', address: '127.0.0.1', port: port + 1 }] });
  assert.equal(rival.ok, true);
  await waitFor(async () => {
    const listed = await a.command({ cmd: 'list_collabs' });
    return listed.collabs.some((entry) => entry.collabId === first.collabId && entry.state === 'frozen');
  }, { timeoutMs: 30000 });
  await waitFor(async () => {
    const listed = await c.command({ cmd: 'list_collabs' });
    return listed.collabs.some((entry) => entry.collabId === rival.collabId && entry.state === 'frozen');
  }, { timeoutMs: 30000 });
  const bListed = await b.command({ cmd: 'list_collabs' });
  assert.equal(bListed.collabs.find((entry) => entry.collabId === first.collabId).state, 'frozen');
  assert.equal(bListed.collabs.find((entry) => entry.collabId === rival.collabId).state, 'frozen');
  const stats = await b.command({ cmd: 'collab_stats' });
  assert.equal(stats.stats.freezeDetected >= 1, true);
});

test('协作预演：撤回（single 定格 withdrawn → all 整条终止）', { timeout: 60000 }, async (t) => {
  const { port, nodes: [a, b] } = await startNodesGuarded(t, 2, (startPort) => spawnAdjacentPairNodes(t, startPort));
  const created = await a.command({ cmd: 'create_collab', name: '撤回项目', topic: '主题', targets: [{ instanceId: b.ready.instanceId, identityName: '主机乙', address: '127.0.0.1', port: port + 1 }] });
  await waitFor(async () => {
    const listed = await b.command({ cmd: 'list_collabs' });
    return listed.collabs.some((entry) => entry.collabId === created.collabId);
  }, { timeoutMs: 15000 });
  const single = await a.command({ cmd: 'withdraw_invite', collabId: created.collabId, target: b.ready.instanceId });
  assert.equal(single.ok, true);
  await waitFor(async () => {
    const listed = await b.command({ cmd: 'list_collabs' });
    return listed.collabs.some((entry) => entry.collabId === created.collabId && entry.decision === 'withdrawn');
  }, { timeoutMs: 15000 });
  const all = await a.command({ cmd: 'withdraw_invite', collabId: created.collabId });
  assert.equal(all.ok, true);
  await waitFor(async () => {
    const listed = await b.command({ cmd: 'list_collabs' });
    return listed.collabs.some((entry) => entry.collabId === created.collabId && entry.state === 'terminated' && entry.archived === true);
  }, { timeoutMs: 15000 });
});

test('协作预演：离线续投（乙离线期间排队、重开后续投并推进第三档）', { timeout: 90000 }, async (t) => {
  const nodeConfig = { retryIntervalMs: 200, retryFastCount: 100 };
  const dirA = makeNodeDir(t);
  const dirB = makeNodeDir(t);
  const { port, nodes: [a, b] } = await startNodesGuarded(t, 2, async (startPort) => [
    await spawnNode(t, { identityName: '主机甲', bindAddress: '127.0.0.1', port: startPort, dataDir: dirA, config: nodeConfig }),
    await spawnNode(t, { identityName: '主机乙', bindAddress: '127.0.0.1', port: startPort + 1, knownPeers: [{ address: '127.0.0.1', port: startPort }], dataDir: dirB, config: nodeConfig }),
  ]);
  const created = await a.command({ cmd: 'create_collab', name: '续投项目', topic: '主题', targets: [{ instanceId: b.ready.instanceId, identityName: '主机乙', address: '127.0.0.1', port: port + 1 }] });
  await waitFor(async () => {
    const listed = await b.command({ cmd: 'list_collabs' });
    return listed.collabs.some((entry) => entry.collabId === created.collabId && entry.state === 'proposed');
  }, { timeoutMs: 15000 });
  const approved = await b.command({ cmd: 'approve_invite', collabId: created.collabId, approve: true });
  assert.equal(approved.ok, true);
  await waitFor(async () => {
    const listed = await a.command({ cmd: 'list_collabs' });
    return listed.collabs.some((entry) => entry.collabId === created.collabId && entry.state === 'active');
  }, { timeoutMs: 15000 });
  await b.command({ cmd: 'exit' });
  await waitForRebindable(port + 1);
  const sent = await a.command({ cmd: 'send_message', collabId: created.collabId, text: '乙离线期间的消息' });
  assert.equal(sent.ok, true);
  assert.equal(sent.tier, 'queued');
  const b2 = await startNode(t, { identityName: '主机乙', bindAddress: '127.0.0.1', port: port + 1, knownPeers: [{ address: '127.0.0.1', port }], dataDir: dirB, config: nodeConfig });
  await waitFor(async () => {
    const status = await a.command({ cmd: 'status', collabId: created.collabId });
    const row = status.rows.find((candidate) => candidate.msgId === sent.msgId);
    return row !== undefined && row.tier === 'session' ? row : null;
  }, { timeoutMs: 30000 });
  const listed = await b2.command({ cmd: 'list_collabs' });
  assert.equal(listed.collabs.find((entry) => entry.collabId === created.collabId).state, 'active');
});

test('协作预演：结束后迟到消息丢弃并计数 + 服务层门控拒绝', { timeout: 60000 }, async (t) => {
  const { port, nodes: [a, b] } = await startNodesGuarded(t, 2, (startPort) => spawnAdjacentPairNodes(t, startPort));
  const created = await a.command({ cmd: 'create_collab', name: '收尾项目', topic: '主题', targets: [{ instanceId: b.ready.instanceId, identityName: '主机乙', address: '127.0.0.1', port: port + 1 }] });
  await waitFor(async () => {
    const listed = await b.command({ cmd: 'list_collabs' });
    return listed.collabs.some((entry) => entry.collabId === created.collabId && entry.state === 'proposed');
  }, { timeoutMs: 15000 });
  const approved = await b.command({ cmd: 'approve_invite', collabId: created.collabId, approve: true });
  assert.equal(approved.ok, true);
  await waitFor(async () => {
    const listed = await a.command({ cmd: 'list_collabs' });
    return listed.collabs.some((entry) => entry.collabId === created.collabId && entry.state === 'active');
  }, { timeoutMs: 15000 });
  await waitFor(async () => {
    const listed = await b.command({ cmd: 'list_collabs' });
    return listed.collabs.some((entry) => entry.collabId === created.collabId && entry.state === 'active');
  }, { timeoutMs: 15000 });
  const ended = await a.command({ cmd: 'end_collab', collabId: created.collabId });
  assert.equal(ended.ok, true);
  await waitFor(async () => {
    const listed = await b.command({ cmd: 'list_collabs' });
    return listed.collabs.some((entry) => entry.collabId === created.collabId && entry.state === 'completed');
  }, { timeoutMs: 15000 });
  const gated = await b.command({ cmd: 'send_message', collabId: created.collabId, text: '结束后发送' });
  assert.equal(gated.ok, false);
  const late = await a.command({
    cmd: 'send',
    collabId: created.collabId,
    to: { instanceId: b.ready.instanceId, address: '127.0.0.1', port: port + 1 },
    type: 'reply',
    payload: { text: '迟到的直投帧' },
  });
  assert.equal(late.ok, true, '底层直投绕过服务门控——用于造迟到帧');
  await waitFor(async () => {
    const stats = await b.command({ cmd: 'collab_stats' });
    return stats.stats.lateDropped >= 1;
  }, { timeoutMs: 15000 });
});

test('协作预演：管理者离线 → view_ledger 回退快照并标注可能非最新', { timeout: 90000 }, async (t) => {
  const { port, nodes: [a, b] } = await startNodesGuarded(t, 2, (startPort) => spawnAdjacentPairNodes(t, startPort));
  const created = await a.command({ cmd: 'create_collab', name: '回退项目', topic: '主题', targets: [{ instanceId: b.ready.instanceId, identityName: '主机乙', address: '127.0.0.1', port: port + 1 }] });
  await waitFor(async () => {
    const listed = await b.command({ cmd: 'list_collabs' });
    return listed.collabs.some((entry) => entry.collabId === created.collabId && entry.state === 'proposed');
  }, { timeoutMs: 15000 });
  const approved = await b.command({ cmd: 'approve_invite', collabId: created.collabId, approve: true });
  assert.equal(approved.ok, true);
  await waitFor(async () => {
    const listed = await b.command({ cmd: 'list_collabs' });
    return listed.collabs.some((entry) => entry.collabId === created.collabId && entry.state === 'active');
  }, { timeoutMs: 15000 });
  await waitFor(async () => {
    const viewed = await b.command({ cmd: 'view_ledger', collabId: created.collabId });
    return viewed.source === 'live' ? viewed : null;
  }, { timeoutMs: 15000 });
  await a.command({ cmd: 'exit' });
  await waitForRebindable(port);
  const viewed = await b.command({ cmd: 'view_ledger', collabId: created.collabId });
  assert.equal(viewed.ok, true);
  assert.equal(viewed.source, 'snapshot');
  assert.ok(viewed.note.includes('可能非最新'));
});

/* —— 治理与韧性预演（本机近似；真实分区 / 双物理机归 M7）—— */

/* 治理场景配置：短探测节律与短窗口压缩等待；治理帧与普通帧都走快速重试节律。 */
const GOVERNANCE_CONFIG = {
  managerProbeIntervalMs: 100,
  managerOfflineMs: 300,
  takeoverWindowMs: 600,
  dispatchTickMs: 40,
  retryIntervalMs: 200,
  retrySlowIntervalMs: 300,
  retryFastCount: 100,
  dialTimeoutMs: 1000,
  scanWindowMs: 300,
};

async function waitCollabState(node, collabId, wanted) {
  return waitFor(async () => {
    const result = await node.command({ cmd: 'list_collabs' });
    const entry = result.collabs.find((candidate) => candidate.collabId === collabId);
    return entry !== undefined && entry.state === wanted ? entry : null;
  }, { timeoutMs: 20000 });
}

async function waitManagerOffline(node, collabId) {
  await waitFor(async () => {
    const listed = await node.command({ cmd: 'list_collabs' });
    const entry = listed.collabs.find((candidate) => candidate.collabId === collabId);
    return entry !== undefined && entry.managerOffline === true;
  }, { timeoutMs: 20000 });
}

/* 等邀请到达并同意（多节点编排的公共步骤）。 */
async function approveInto(node, collabId) {
  await waitFor(async () => {
    const listed = await node.command({ cmd: 'list_collabs' });
    return listed.collabs.some((entry) => entry.collabId === collabId);
  }, { timeoutMs: 15000 });
  assert.equal((await node.command({ cmd: 'approve_invite', collabId, approve: true })).ok, true);
}

/* 三节点编排（并发抢接用）：节点已由组守卫启动，这里先建乙丙协作接上彼此端点，再建甲管理的三人主协作。 */
async function buildGovernedTriad(t, { a, b, c, port }) {
  const y = await c.command({ cmd: 'create_collab', name: '接线项目', topic: '主题', targets: [{ instanceId: b.ready.instanceId, identityName: '主机乙', address: '127.0.0.1', port: port + 1 }] });
  await approveInto(b, y.collabId);
  await waitCollabState(c, y.collabId, 'active');
  await waitCollabState(b, y.collabId, 'active');
  const x = await a.command({ cmd: 'create_collab', name: '并发项目', topic: '主题', targets: [
    { instanceId: b.ready.instanceId, identityName: '主机乙', address: '127.0.0.1', port: port + 1 },
    { instanceId: c.ready.instanceId, identityName: '主机丙', address: '127.0.0.1', port: port + 2 },
  ] });
  assert.equal(x.ok, true);
  await approveInto(b, x.collabId);
  await approveInto(c, x.collabId);
  await waitCollabState(a, x.collabId, 'active');
  await waitCollabState(b, x.collabId, 'active');
  await waitCollabState(c, x.collabId, 'active');
  return x.collabId;
}

/* 相邻端口双成员节点启动（建立协作的前半段）：a 占段基、b 占段基+1；options.dataDirA 供重启复用目录的场景。 */
function spawnEstablishPairNodes(t, port, config, options = {}) {
  return Promise.all([
    spawnNode(t, { identityName: '主机甲', bindAddress: '127.0.0.1', port, dataDir: options.dataDirA, config }),
    spawnNode(t, { identityName: '主机乙', bindAddress: '127.0.0.1', port: port + 1, knownPeers: [{ address: '127.0.0.1', port }], config }),
  ]);
}

/* 双成员达成（甲管理、乙同意、建立并推过快照）。 */
async function establishPairWith(t, { a, b, port, name }) {
  const created = await a.command({ cmd: 'create_collab', name, topic: '主题', targets: [{ instanceId: b.ready.instanceId, identityName: '主机乙', address: '127.0.0.1', port: port + 1 }] });
  assert.equal(created.ok, true);
  await waitFor(async () => {
    const listed = await b.command({ cmd: 'list_collabs' });
    return listed.collabs.some((entry) => entry.collabId === created.collabId);
  }, { timeoutMs: 15000 });
  assert.equal((await b.command({ cmd: 'approve_invite', collabId: created.collabId, approve: true })).ok, true);
  await waitCollabState(a, created.collabId, 'active');
  await waitCollabState(b, created.collabId, 'active');
  return created.collabId;
}

test('治理预演：显式交接全链（先确认后删除；受让方承担席位）', { timeout: 120000 }, async (t) => {
  const dirA = makeNodeDir(t);
  const { port, nodes: [a, b] } = await startNodesGuarded(t, 2, (startPort) => spawnEstablishPairNodes(t, startPort, GOVERNANCE_CONFIG, { dataDirA: dirA }));
  const collabId = await establishPairWith(t, { a, b, port, name: '交接项目' });
  const handed = await a.command({ cmd: 'handover', collabId, target: b.ready.instanceId });
  assert.equal(handed.ok, true, JSON.stringify(handed));
  assert.ok(handed.message.includes('移交完成'));
  const aEntry = await waitCollabState(a, collabId, 'active');
  const bEntry = await waitCollabState(b, collabId, 'active');
  assert.equal(aEntry.role, 'member');
  assert.equal(bEntry.role, 'manager');
  const bView = await b.command({ cmd: 'view_ledger', collabId });
  assert.equal(bView.source, 'local');
  assert.equal(bView.ledger.manager.instanceId, b.ready.instanceId);
  assert.equal(existsSync(join(dirA, 'collabs', collabId, 'ledger.jsonl')), false, '先确认后删除：旧席位台账已清理');
  assert.equal(existsSync(join(dirA, 'collabs', collabId, 'snapshot.json')), true, '成员备份保留');
});

test('治理预演：失联抢接全链 + 原驿丞重启握手降级', { timeout: 180000 }, async (t) => {
  const dirA = makeNodeDir(t);
  const { port, nodes: [a, b] } = await startNodesGuarded(t, 2, (startPort) => spawnEstablishPairNodes(t, startPort, GOVERNANCE_CONFIG, { dataDirA: dirA }));
  const collabId = await establishPairWith(t, { a, b, port, name: '抢接项目' });
  await a.command({ cmd: 'exit' });
  await waitForRebindable(port);
  await waitManagerOffline(b, collabId);
  const verdict = await b.command({ cmd: 'take_over', collabId });
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
  assert.equal(verdict.phase, 'awaiting-confirm');
  const applied = await b.command({ cmd: 'take_over_confirm', collabId });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  const bManaged = await waitCollabState(b, collabId, 'active');
  assert.equal(bManaged.role, 'manager');
  const bView = await b.command({ cmd: 'view_ledger', collabId });
  assert.equal(bView.ledger.manager.instanceId, b.ready.instanceId);
  assert.equal(bView.ledger.version, verdict.baseVersion, '基准版本延续（不重置）');
  /* 原驿丞重启：启动握手 / 补投的通告识出已被替换 → 降级为协作者并清理台账 */
  const a2 = await startNode(t, { identityName: '主机甲', bindAddress: '127.0.0.1', port, dataDir: dirA, knownPeers: [{ address: '127.0.0.1', port: port + 1 }], config: GOVERNANCE_CONFIG });
  const aEntry = await waitFor(async () => {
    const listed = await a2.command({ cmd: 'list_collabs' });
    const entry = listed.collabs.find((candidate) => candidate.collabId === collabId);
    return entry !== undefined && entry.role === 'member' ? entry : null;
  }, { timeoutMs: 20000 });
  assert.equal(aEntry.role, 'member');
  const aStats = await a2.command({ cmd: 'collab_stats' });
  assert.equal(aStats.stats.takeoverDowngrades >= 1, true, '降级计数留痕');
  assert.equal(existsSync(join(dirA, 'collabs', collabId, 'ledger.jsonl')), false, '降级即清理本地台账');
});

test('治理预演：假失联中止（窗口内原驿丞复活 → 抢接中止）', { timeout: 120000 }, async (t) => {
  const config = { ...GOVERNANCE_CONFIG, takeoverWindowMs: 4000 };
  const { port, nodes: [a, b] } = await startNodesGuarded(t, 2, (startPort) => spawnEstablishPairNodes(t, startPort, config));
  const collabId = await establishPairWith(t, { a, b, port, name: '假失联项目' });
  await a.command({ cmd: 'exit' });
  await waitForRebindable(port);
  await waitManagerOffline(b, collabId);
  const pending = b.command({ cmd: 'take_over', collabId });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const a2 = await startNode(t, { identityName: '主机甲', bindAddress: '127.0.0.1', port, knownPeers: [{ address: '127.0.0.1', port: port + 1 }], config });
  const verdict = await pending;
  assert.equal(verdict.ok, false, JSON.stringify(verdict));
  assert.ok(verdict.message.includes('中止'));
  const bEntry = (await b.command({ cmd: 'list_collabs' })).collabs.find((entry) => entry.collabId === collabId);
  assert.equal(bEntry.role, 'member', '中止不让位');
  const bStats = await b.command({ cmd: 'collab_stats' });
  const aStats = await a2.command({ cmd: 'collab_stats' });
  assert.equal(bStats.stats.takeoversAborted >= 1, true);
  assert.equal(aStats.stats.takeoverDowngrades, 0, '原驿丞未被替换');
});

test('治理预演：并发抢接（互见让位、确定性单一胜者、败方收敛）', { timeout: 180000 }, async (t) => {
  const config = { ...GOVERNANCE_CONFIG, takeoverWindowMs: 1500 };
  const { port, nodes: [a, b, c] } = await startNodesGuarded(t, 3, (startPort) => spawnTriadNodes(t, startPort, config));
  const collabId = await buildGovernedTriad(t, { a, b, c, port });
  await a.command({ cmd: 'exit' });
  await waitForRebindable(port);
  await waitManagerOffline(b, collabId);
  await waitManagerOffline(c, collabId);
  const [verdictB, verdictC] = await Promise.all([
    b.command({ cmd: 'take_over', collabId }),
    c.command({ cmd: 'take_over', collabId }),
  ]);
  const winnerIsB = b.ready.instanceId < c.ready.instanceId;
  const winnerVerdict = winnerIsB ? verdictB : verdictC;
  const loserVerdict = winnerIsB ? verdictC : verdictB;
  assert.equal(winnerVerdict.phase, 'awaiting-confirm', JSON.stringify(winnerVerdict));
  assert.equal(loserVerdict.ok, false, JSON.stringify(loserVerdict));
  assert.ok(loserVerdict.message.includes('让位'));
  const winnerNode = winnerIsB ? b : c;
  const loserNode = winnerIsB ? c : b;
  const confirmed = await winnerNode.command({ cmd: 'take_over_confirm', collabId });
  assert.equal(confirmed.ok, true, JSON.stringify(confirmed));
  const winnerEntry = await waitCollabState(winnerNode, collabId, 'active');
  assert.equal(winnerEntry.role, 'manager');
  const loserView = await waitFor(async () => {
    const viewed = await loserNode.command({ cmd: 'view_ledger', collabId });
    return viewed.ok === true && viewed.ledger.manager.instanceId === winnerNode.ready.instanceId ? viewed : null;
  }, { timeoutMs: 20000 });
  assert.equal(loserView.ledger.manager.instanceId, winnerNode.ready.instanceId, '败方收敛到新驿丞视图');
});

test('治理预演：离线错过通告 → 恢复后送达即让位（治理豁免过期）', { timeout: 180000 }, async (t) => {
  const dirA = makeNodeDir(t);
  const config = { ...GOVERNANCE_CONFIG, messageTtlMs: 1000 };
  const { port, nodes: [a, b] } = await startNodesGuarded(t, 2, (startPort) => spawnEstablishPairNodes(t, startPort, config, { dataDirA: dirA }));
  const collabId = await establishPairWith(t, { a, b, port, name: '让位项目' });
  await a.command({ cmd: 'exit' });
  await waitForRebindable(port);
  await waitManagerOffline(b, collabId);
  const verdict = await b.command({ cmd: 'take_over', collabId });
  assert.equal(verdict.phase, 'awaiting-confirm');
  assert.equal((await b.command({ cmd: 'take_over_confirm', collabId })).ok, true);
  /* 超保留期浸泡：治理通告（takeover）豁免过期，仍留在队列等待送达 */
  await new Promise((resolve) => setTimeout(resolve, 1300));
  const rows = await b.command({ cmd: 'status', collabId });
  const takeoverRow = rows.rows.find((row) => row.type === 'takeover');
  assert.equal(takeoverRow !== undefined, true, 'takeover 通告在队列中');
  assert.equal(takeoverRow.expired, false, '治理类豁免过期');
  assert.equal(takeoverRow.tier, 'queued', '离线者未送达，等待恢复');
  const a2 = await startNode(t, { identityName: '主机甲', bindAddress: '127.0.0.1', port, dataDir: dirA, knownPeers: [{ address: '127.0.0.1', port: port + 1 }], config });
  const aEntry = await waitFor(async () => {
    const listed = await a2.command({ cmd: 'list_collabs' });
    const entry = listed.collabs.find((candidate) => candidate.collabId === collabId);
    return entry !== undefined && entry.role === 'member' ? entry : null;
  }, { timeoutMs: 30000 });
  assert.equal(aEntry.role, 'member', '通告送达即让位降级');
});

test('治理预演：同名冲突双冻结 → 人裁定合并 → 三方收敛', { timeout: 180000 }, async (t) => {
  const config = GOVERNANCE_CONFIG;
  const { port, nodes: [a, b, c] } = await startNodesGuarded(t, 3, (startPort) => spawnTriadNodes(t, startPort, config));
  const x = await a.command({ cmd: 'create_collab', name: '合并项目', topic: '主题', targets: [{ instanceId: b.ready.instanceId, identityName: '主机乙', address: '127.0.0.1', port: port + 1 }] });
  await waitFor(async () => {
    const listed = await b.command({ cmd: 'list_collabs' });
    return listed.collabs.some((entry) => entry.collabId === x.collabId);
  }, { timeoutMs: 15000 });
  assert.equal((await b.command({ cmd: 'approve_invite', collabId: x.collabId, approve: true })).ok, true);
  await waitCollabState(a, x.collabId, 'active');
  await waitCollabState(b, x.collabId, 'active');
  const y = await c.command({ cmd: 'create_collab', name: '合并项目', topic: '主题', targets: [{ instanceId: b.ready.instanceId, identityName: '主机乙', address: '127.0.0.1', port: port + 1 }] });
  assert.equal(y.ok, true);
  await waitCollabState(a, x.collabId, 'frozen');
  await waitCollabState(c, y.collabId, 'frozen');
  await waitFor(async () => {
    const listed = await b.command({ cmd: 'list_collabs' });
    const first = listed.collabs.find((entry) => entry.collabId === x.collabId);
    const rival = listed.collabs.find((entry) => entry.collabId === y.collabId);
    return first !== undefined && rival !== undefined && first.state === 'frozen' && rival.state === 'frozen' ? true : null;
  }, { timeoutMs: 20000 });
  const merged = await a.command({ cmd: 'decide', collabId: x.collabId, choice: 'merge' });
  assert.equal(merged.ok, true, JSON.stringify(merged));
  const aEntry = await waitCollabState(a, x.collabId, 'active');
  assert.equal(aEntry.role, 'manager');
  await waitFor(async () => {
    const listed = await b.command({ cmd: 'list_collabs' });
    const first = listed.collabs.find((entry) => entry.collabId === x.collabId);
    const rival = listed.collabs.find((entry) => entry.collabId === y.collabId);
    return first !== undefined && rival !== undefined && first.state === 'active' && rival.state === 'terminated' ? true : null;
  }, { timeoutMs: 20000 });
  await waitCollabState(c, y.collabId, 'terminated');
});
