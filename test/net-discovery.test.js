import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { DISCOVERY_REPLY_MIN_INTERVAL_MS, broadcastTargets, createDiscovery } from '../src/net/discovery.js';
import { createKnownHosts } from '../src/net/known-hosts.js';
import { MAX_COLLAB_COUNT } from '../src/net/protocol.js';
import { makeTempDir, pickFreePort, waitFor } from './helpers.js';

const SELF_A = { instanceId: 'aaaaaaaa-0000-4000-8000-000000000001', identityName: '主机甲' };
const SELF_B = { instanceId: 'bbbbbbbb-0000-4000-8000-000000000002', identityName: '主机乙' };

function quietLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

async function startNode(t, { self, bindAddress, collabCount = 0, port, segmentBase }) {
  const dataDir = makeTempDir(t);
  const knownHosts = createKnownHosts({ dataDir, log: quietLog() });
  const node = createDiscovery({
    port,
    bindAddress,
    instanceId: self.instanceId,
    identityName: self.identityName,
    getCollabCount: () => collabCount,
    knownHosts,
    log: quietLog(),
    segmentBase,
  });
  await node.start();
  t.after(() => node.close());
  return { node, knownHosts };
}

/* 伪对端：绑定到指定回环地址与发现端口，收到探测后以固定实例标识回发应答（delayMs 模拟稍晚应答）。
 * 两个真实节点写不出同一实例标识——「同实例多地址合并」只能靠伪对端构造。
 * ackPort 缺省 = 绑定端口（今版站点自报端口形态）；null = 应答不带端口字段（旧实现形态）。
 * probesReceived 暴露收到的探测计数，供启动自介用例断言。 */
function startFakePeer(t, { port, address, delayMs = 0, ackPort }) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: false });
  t.after(() => socket.close());
  const peer = { probesReceived: 0 };
  socket.on('message', (buffer, rinfo) => {
    if (JSON.parse(buffer.toString('utf8')).type !== 'probe') {
      return;
    }
    peer.probesReceived++;
    const ack = Buffer.from(JSON.stringify({
      v: 1,
      type: 'probe-ack',
      instanceId: SELF_B.instanceId,
      identityName: '主机乙',
      collabCount: 2,
      ...(ackPort === null ? {} : { port: ackPort ?? port }),
    }));
    setTimeout(() => socket.send(ack, rinfo.port, rinfo.address), delayMs);
  });
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind({ port, address, exclusive: true }, () => resolve(peer));
  });
}

test('broadcastTargets：逐卡定向广播地址（跳过内网 / IPv6 / /32 / 缺掩码，去重）', () => {
  const interfaces = {
    WLAN: [
      { family: 'IPv4', address: '192.168.0.125', netmask: '255.255.255.0', internal: false },
      { family: 'IPv6', address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', internal: false },
    ],
    USB网卡: [{ family: 'IPv4', address: '192.168.2.222', netmask: '255.255.255.0', internal: false }],
    同子网第二卡: [{ family: 'IPv4', address: '192.168.0.200', netmask: '255.255.255.0', internal: false }],
    回环: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true }],
    点对点: [{ family: 'IPv4', address: '10.9.9.9', netmask: '255.255.255.255', internal: false }],
    缺掩码: [{ family: 'IPv4', address: '10.8.8.8', netmask: undefined, internal: false }],
    十六位掩码: [{ family: 'IPv4', address: '172.16.5.7', netmask: '255.255.0.0', internal: false }],
  };
  assert.deepEqual(broadcastTargets(interfaces).sort(), ['172.16.255.255', '192.168.0.255', '192.168.2.255']);
});

test('双实例互扫：清单单播兜底可达、身份与参与协作数正确、排除自答', { timeout: 15000 }, async (t) => {
  const port = await pickFreePort();
  const a = await startNode(t, { self: SELF_A, bindAddress: '127.0.0.1', port });
  await startNode(t, { self: SELF_B, bindAddress: '127.0.0.2', port, collabCount: 3 });
  a.knownHosts.remember({ address: '127.0.0.2', port });
  const hosts = await a.node.scan({ windowMs: 300 });
  assert.equal(hosts.length, 1);
  assert.equal(hosts[0].instanceId, SELF_B.instanceId);
  assert.equal(hosts[0].identityName, '主机乙');
  assert.equal(hosts[0].collabCount, 3);
  assert.deepEqual(hosts[0].endpoints, [{ address: '127.0.0.2', port }]);
  assert.ok(!Number.isNaN(Date.parse(hosts[0].lastSeenAt)));
});

test('排除自答：清单含自身地址时扫描结果为空并计数', { timeout: 15000 }, async (t) => {
  const port = await pickFreePort();
  const a = await startNode(t, { self: SELF_A, bindAddress: '127.0.0.1', port });
  a.knownHosts.remember({ address: '127.0.0.1', port });
  const hosts = await a.node.scan({ windowMs: 200 });
  assert.deepEqual(hosts, []);
  assert.ok(a.node.stats().selfObserved >= 1);
});

test('探测来源入清单：B 收到 A 的探测后记住 A 的地址（广播盲区反向补偿）', { timeout: 15000 }, async (t) => {
  const port = await pickFreePort();
  const a = await startNode(t, { self: SELF_A, bindAddress: '127.0.0.1', port });
  const b = await startNode(t, { self: SELF_B, bindAddress: '127.0.0.2', port });
  a.knownHosts.remember({ address: '127.0.0.2', port });
  await a.node.scan({ windowMs: 200 });
  assert.deepEqual(b.knownHosts.targets(), [{ address: '127.0.0.1', port }]);
});

test('扫描应答更新清单：登记对方实例标识与身份名', { timeout: 15000 }, async (t) => {
  const port = await pickFreePort();
  const a = await startNode(t, { self: SELF_A, bindAddress: '127.0.0.1', port });
  await startNode(t, { self: SELF_B, bindAddress: '127.0.0.2', port });
  a.knownHosts.remember({ address: '127.0.0.2', port });
  await a.node.scan({ windowMs: 200 });
  const recorded = a.knownHosts.list().find((entry) => entry.address === '127.0.0.2');
  assert.equal(recorded.instanceId, SELF_B.instanceId);
  assert.equal(recorded.identityName, '主机乙');
});

test('同实例多地址：按实例标识合并为一条、首选地址 = 首个应答来源', { timeout: 15000 }, async (t) => {
  const port = await pickFreePort();
  const a = await startNode(t, { self: SELF_A, bindAddress: '127.0.0.1', port });
  a.knownHosts.remember({ address: '127.0.0.2', port });
  a.knownHosts.remember({ address: '127.0.0.3', port });
  await startFakePeer(t, { port, address: '127.0.0.2' });
  await startFakePeer(t, { port, address: '127.0.0.3', delayMs: 120 });
  const hosts = await a.node.scan({ windowMs: 400 });
  assert.equal(hosts.length, 1, '同一实例标识的多个地址必须合并为一条');
  assert.deepEqual(hosts[0].endpoints, [{ address: '127.0.0.2', port }, { address: '127.0.0.3', port }], '数组序 = 接收序：首个应答来源即首选地址');
});

test('非法数据报：超体积 / 坏 JSON / 非法字段 / 版本不符——全部拒绝并计数、不应答', { timeout: 15000 }, async (t) => {
  const port = await pickFreePort();
  const a = await startNode(t, { self: SELF_A, bindAddress: '127.0.0.1', port });
  const raw = dgram.createSocket('udp4');
  t.after(() => raw.close());
  const sendToA = (payload) => new Promise((resolve) => {
    raw.send(payload, port, '127.0.0.1', () => resolve());
  });
  await sendToA(Buffer.alloc(600, 0x61));
  await sendToA(Buffer.from('{oops'));
  await sendToA(Buffer.from(JSON.stringify({ v: 1, type: 'probe', instanceId: '../x', identityName: '甲' })));
  await sendToA(Buffer.from(JSON.stringify({ v: 2, type: 'probe', instanceId: SELF_B.instanceId, identityName: '乙' })));
  await waitFor(() => a.node.stats().datagramsIn >= 4);
  const counters = a.node.stats();
  assert.equal(counters.rejected.oversize, 1);
  assert.equal(counters.rejected.malformed, 1);
  assert.equal(counters.rejected.invalid, 2);
  assert.equal(counters.probesAnswered, 0);
});

test('同源最小间隔：首个应答后立即连发的两包被限流、清单只记入一次', { timeout: 15000 }, async (t) => {
  const port = await pickFreePort();
  const b = await startNode(t, { self: SELF_B, bindAddress: '127.0.0.2', port });
  const raw = dgram.createSocket('udp4');
  t.after(() => raw.close());
  const acks = [];
  raw.on('message', (buffer) => acks.push(JSON.parse(buffer.toString('utf8'))));
  await new Promise((resolve, reject) => {
    raw.once('error', reject);
    raw.bind({ port: 0, address: '127.0.0.1' }, resolve);
  });
  const probe = Buffer.from(JSON.stringify({ v: 1, type: 'probe', instanceId: SELF_A.instanceId, identityName: '主机甲' }));
  raw.send(probe, port, '127.0.0.2');
  await waitFor(() => acks.length >= 1);   // 等首个应答（窗口起算）后立即连发两包：必落在同一限流窗内
  raw.send(probe, port, '127.0.0.2');
  raw.send(probe, port, '127.0.0.2');
  await waitFor(() => b.node.stats().rateLimited >= 2);
  await new Promise((resolve) => setTimeout(resolve, DISCOVERY_REPLY_MIN_INTERVAL_MS + 100));
  assert.equal(acks.length, 1, `限流窗内只应应答一次，实际应答 ${acks.length} 次`);
  assert.equal(b.node.stats().probesAnswered, 1);
  assert.equal(b.knownHosts.stats().remembered, 1, '同源窗口内的重复探测不再重复记入清单（防水风暴）');
});

test('同源窗口过期后恢复：再次探测重新应答并重新记入清单', { timeout: 15000 }, async (t) => {
  const port = await pickFreePort();
  const b = await startNode(t, { self: SELF_B, bindAddress: '127.0.0.2', port });
  const raw = dgram.createSocket('udp4');
  t.after(() => raw.close());
  const acks = [];
  raw.on('message', (buffer) => acks.push(JSON.parse(buffer.toString('utf8'))));
  await new Promise((resolve, reject) => {
    raw.once('error', reject);
    raw.bind({ port: 0, address: '127.0.0.1' }, resolve);
  });
  const probe = Buffer.from(JSON.stringify({ v: 1, type: 'probe', instanceId: SELF_A.instanceId, identityName: '主机甲' }));
  raw.send(probe, port, '127.0.0.2');
  await waitFor(() => acks.length >= 1);
  await new Promise((resolve) => setTimeout(resolve, DISCOVERY_REPLY_MIN_INTERVAL_MS + 100));
  raw.send(probe, port, '127.0.0.2');
  await waitFor(() => acks.length >= 2);
  assert.equal(b.node.stats().probesAnswered, 2, '窗口过期后同源探测应重新应答');
  assert.equal(b.knownHosts.stats().remembered, 2, '窗口过期后同源探测应重新记入清单一次');
});

test('伪造应答洪泛：同源连发 ack 只记入清单一次、其余计入限流（与探测路径同一张表）', { timeout: 15000 }, async (t) => {
  const port = await pickFreePort();
  const b = await startNode(t, { self: SELF_B, bindAddress: '127.0.0.2', port });
  const raw = dgram.createSocket('udp4');
  t.after(() => raw.close());
  await new Promise((resolve, reject) => {
    raw.once('error', reject);
    raw.bind({ port: 0, address: '127.0.0.1' }, resolve);
  });
  const ack = Buffer.from(JSON.stringify({ v: 1, type: 'probe-ack', instanceId: SELF_A.instanceId, identityName: '主机甲', collabCount: 2 }));
  for (let index = 0; index < 6; index++) {
    raw.send(ack, port, '127.0.0.2');
  }
  await waitFor(() => b.node.stats().probeResponses >= 6);
  const stats = b.node.stats();
  assert.equal(b.knownHosts.stats().remembered, 1, '同源窗口内只应记入清单一次（不放大为整文件原子写）');
  const recorded = b.knownHosts.targets();
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].address, '127.0.0.1');
  assert.ok(stats.rateLimited >= 5, `窗口内的其余应答应计入限流，实际 ${stats.rateLimited}`);
});

test('应答 collabCount 值域：超上限钳制、非整数归一为 0（与对端入站校验对称）', { timeout: 15000 }, async (t) => {
  const port = await pickFreePort();
  let collabCount = MAX_COLLAB_COUNT + 5;
  const node = createDiscovery({
    port,
    bindAddress: '127.0.0.2',
    instanceId: SELF_B.instanceId,
    identityName: SELF_B.identityName,
    getCollabCount: () => collabCount,
    knownHosts: createKnownHosts({ dataDir: makeTempDir(t), log: quietLog() }),
    log: quietLog(),
  });
  await node.start();
  t.after(() => node.close());
  const raw = dgram.createSocket('udp4');
  t.after(() => raw.close());
  const acks = [];
  raw.on('message', (buffer) => acks.push(JSON.parse(buffer.toString('utf8'))));
  await new Promise((resolve, reject) => {
    raw.once('error', reject);
    raw.bind({ port: 0, address: '127.0.0.1' }, resolve);
  });
  const probe = Buffer.from(JSON.stringify({ v: 1, type: 'probe', instanceId: SELF_A.instanceId, identityName: '主机甲' }));
  raw.send(probe, port, '127.0.0.2');
  await waitFor(() => acks.length >= 1);
  assert.equal(acks[0].collabCount, MAX_COLLAB_COUNT, '超过协议上限应钳制，而不是原样发出被对端拒收');
  collabCount = 1.5;
  await new Promise((resolve) => setTimeout(resolve, DISCOVERY_REPLY_MIN_INTERVAL_MS + 100));
  raw.send(probe, port, '127.0.0.2');
  await waitFor(() => acks.length >= 2);
  assert.equal(acks[1].collabCount, 0, '非整数应归一为 0');
});

test('scan 参数校验：非法 windowMs 抛 TypeError（编程错误快速暴露）', { timeout: 15000 }, async (t) => {
  const port = await pickFreePort();
  const a = await startNode(t, { self: SELF_A, bindAddress: '127.0.0.1', port });
  await assert.rejects(a.node.scan({ windowMs: 0 }), TypeError);
  await assert.rejects(a.node.scan({}), TypeError);
});

test('close 释放绑定：同地址端口可再次绑定，且重复 close 幂等', { timeout: 15000 }, async (t) => {
  const port = await pickFreePort();
  const first = await startNode(t, { self: SELF_A, bindAddress: '127.0.0.1', port });
  await first.node.close();
  await first.node.close();
  const second = await startNode(t, { self: SELF_B, bindAddress: '127.0.0.1', port });
  const hosts = await second.node.scan({ windowMs: 100 });
  assert.deepEqual(hosts, []);
});

test('close 后语义：bound 复位，start/scan 拒绝而非挂起（一次性生命周期）', { timeout: 15000 }, async (t) => {
  const port = await pickFreePort();
  const a = await startNode(t, { self: SELF_A, bindAddress: '127.0.0.1', port });
  a.knownHosts.remember({ address: '127.0.0.2', port });   // 保证 close 后的扫描至少有一个发送目标，拒绝行为确定
  assert.equal(a.node.stats().bound, true);
  await a.node.close();
  assert.equal(a.node.stats().bound, false, 'close 后 bound 必须复位，状态面不得展示失效的绑定');
  await assert.rejects(a.node.scan({ windowMs: 50 }), 'close 后 scan 应拒绝而非挂起');
  await assert.rejects(a.node.start(), 'close 后 start 应拒绝而非挂起');
});

test('同地址同端口二次绑定：EADDRINUSE（独占绑定是端口占用规程的前提）', { timeout: 15000 }, async (t) => {
  const port = await pickFreePort();
  const first = await startNode(t, { self: SELF_A, bindAddress: '127.0.0.1', port });
  const second = createDiscovery({
    port,
    bindAddress: '127.0.0.1',
    instanceId: SELF_B.instanceId,
    identityName: SELF_B.identityName,
    getCollabCount: () => 0,
    knownHosts: createKnownHosts({ dataDir: makeTempDir(t), log: quietLog() }),
    log: quietLog(),
  });
  await assert.rejects(second.start(), (error) => error.code === 'EADDRINUSE');
  await second.close();
  await first.node.close();
});

/* —— 模型 A：段扫 / 自介 / 端口回带 / 节流键 / 洪泛边界 —— */

test('段扫 + 同机多站点互扫（广播投递实测）：base+1 的非默认端口站点被 base 上的扫描发现', { timeout: 20000 }, async (t) => {
  const broadcasts = broadcastTargets(networkInterfaces());
  if (broadcasts.length === 0) {
    t.skip('本机无可用定向广播接口——同机广播投递无法在本环境实测');
    return;
  }
  const base = await pickFreePort();
  const a = await startNode(t, { self: SELF_A, bindAddress: '0.0.0.0', port: base, segmentBase: base });
  const b = await startNode(t, { self: SELF_B, bindAddress: '0.0.0.0', port: base + 1, segmentBase: base });
  const hosts = await a.node.scan({ windowMs: 600 });
  const peer = hosts.find((entry) => entry.instanceId === SELF_B.instanceId);
  assert.ok(peer, `同机广播（段内 base+1）互扫应可见，实际：${JSON.stringify(hosts)}`);
  assert.equal(peer.endpoints[0].port, base + 1, '端点端口来自应答 port 字段（非扫描方端口）');
  assert.ok(b.knownHosts.targets().some((entry) => entry.port === base), '乙记录了甲的探测来源（地址:端口）');
});

test('跨机非默认端口互见（回环双地址）：单播学习 + 段扫探测双向收敛', { timeout: 20000 }, async (t) => {
  const base = await pickFreePort();
  const a = await startNode(t, { self: SELF_A, bindAddress: '127.0.0.1', port: base, segmentBase: base });
  const b = await startNode(t, { self: SELF_B, bindAddress: '127.0.0.2', port: base + 1, segmentBase: base });
  b.knownHosts.remember({ address: '127.0.0.1', port: base, instanceId: SELF_A.instanceId, identityName: '主机甲' });
  const seenByB = await b.node.scan({ windowMs: 400 });
  assert.equal(seenByB.length, 1, '乙经清单单播触达甲（非默认端口 base+1 → base）');
  assert.equal(seenByB[0].endpoints[0].port, base);
  a.knownHosts.remember({ address: '127.0.0.2', port: base + 1, instanceId: SELF_B.instanceId, identityName: '主机乙' });
  const seenByA = await a.node.scan({ windowMs: 400 });
  assert.equal(seenByA.length, 1, '甲经清单单播触达乙的槽位端口 base+1');
  assert.equal(seenByA[0].endpoints[0].port, base + 1);
});

test('晚启动机器：启动自介使先启动方零动作掌握后启动者', { timeout: 20000 }, async (t) => {
  const base = await pickFreePort();
  const a = await startNode(t, { self: SELF_A, bindAddress: '127.0.0.1', port: base, segmentBase: base });
  const b = await startNode(t, { self: SELF_B, bindAddress: '127.0.0.2', port: base + 1, segmentBase: base });
  assert.equal(a.knownHosts.targets().some((entry) => entry.address === '127.0.0.2'), false, '自介前甲对乙一无所知');
  /* 回环地址发不出真实广播：本用例以「乙的清单已含甲」为前提（等价于乙曾见过甲——正常老化清单的常态），
   * 自介经清单单播触达甲；段广播路径由同机广播用例与 M7 真机覆盖，不在本环境的承诺面内。 */
  b.knownHosts.remember({ address: '127.0.0.1', port: base, instanceId: SELF_A.instanceId, identityName: '主机甲' });
  b.node.announce();
  await waitFor(() => a.knownHosts.targets().some((entry) => entry.address === '127.0.0.2' && entry.port === base + 1), { timeoutMs: 5000 });
  assert.equal(a.knownHosts.targets().find((entry) => entry.address === '127.0.0.2').port, base + 1, '自介使甲零动作掌握乙（地址:端口）');
  const seen = await a.node.scan({ windowMs: 300 });
  assert.equal(seen[0]?.instanceId, SELF_B.instanceId, '掌握之后甲的扫描即单播直达乙');
});

test('启动自介：同目标集发送、不收集应答、close 后不抛（失败只告警）', { timeout: 15000 }, async (t) => {
  const base = await pickFreePort();
  const a = await startNode(t, { self: SELF_A, bindAddress: '127.0.0.1', port: base, segmentBase: base });
  const fake = await startFakePeer(t, { port: base + 2, address: '127.0.0.1' });
  a.knownHosts.remember({ address: '127.0.0.1', port: base + 2, instanceId: SELF_B.instanceId, identityName: '主机乙' });
  a.node.announce();
  await waitFor(() => fake.probesReceived >= 1, { timeoutMs: 3000 });
  assert.equal(a.node.stats().selfIntroductions, 1);
  assert.equal(a.node.stats().scanning, 0, '自介不建收集器');
  await a.node.close();
  assert.doesNotThrow(() => a.node.announce(), 'close 后的自介失败只告警（不得抛出）');
});

test('探测来源入清单：端口取数据报来源端口', { timeout: 15000 }, async (t) => {
  const base = await pickFreePort();
  const a = await startNode(t, { self: SELF_A, bindAddress: '127.0.0.1', port: base, segmentBase: base });
  const b = await startNode(t, { self: SELF_B, bindAddress: '127.0.0.2', port: base + 1, segmentBase: base });
  b.knownHosts.remember({ address: '127.0.0.1', port: base, instanceId: SELF_A.instanceId, identityName: '主机甲' });
  await b.node.scan({ windowMs: 200 });
  assert.deepEqual(a.knownHosts.targets(), [{ address: '127.0.0.2', port: base + 1 }], '甲的探测来源 = 乙的槽位端口');
});

test('应答端口回带：以 port 字段为准（字段与来源端口不一致时）', { timeout: 15000 }, async (t) => {
  const base = await pickFreePort();
  const a = await startNode(t, { self: SELF_A, bindAddress: '127.0.0.1', port: base, segmentBase: base });
  await startFakePeer(t, { port: base + 1, address: '127.0.0.2', ackPort: base + 4 });
  a.knownHosts.remember({ address: '127.0.0.2', port: base + 1, instanceId: SELF_B.instanceId, identityName: '主机乙' });
  const hosts = await a.node.scan({ windowMs: 300 });
  assert.equal(hosts[0].endpoints[0].port, base + 4, '字段存在则以字段为准（站点自报端口）');
  assert.ok(a.knownHosts.targets().some((entry) => entry.port === base + 4));
});

test('应答缺 port：回退数据报来源端口（旧实现兼容）', { timeout: 15000 }, async (t) => {
  const base = await pickFreePort();
  const a = await startNode(t, { self: SELF_A, bindAddress: '127.0.0.1', port: base, segmentBase: base });
  await startFakePeer(t, { port: base + 1, address: '127.0.0.2', ackPort: null });
  a.knownHosts.remember({ address: '127.0.0.2', port: base + 1, instanceId: SELF_B.instanceId, identityName: '主机乙' });
  const hosts = await a.node.scan({ windowMs: 300 });
  assert.equal(hosts[0].endpoints[0].port, base + 1, '缺字段时回退来源端口');
});

test('节流键「地址:端口」：同 IP 不同来源端口互不吞；同源窗口内重复被限', { timeout: 15000 }, async (t) => {
  const base = await pickFreePort();
  const b = await startNode(t, { self: SELF_B, bindAddress: '127.0.0.2', port: base, segmentBase: base });
  const acksBySource = new Map();
  const raws = [];
  for (let index = 0; index < 3; index++) {
    const raw = dgram.createSocket('udp4');
    raws.push(raw);
    await new Promise((resolve, reject) => {
      raw.once('error', reject);
      raw.bind({ port: 0, address: '127.0.0.1' }, resolve);
    });
    acksBySource.set(index, 0);
    raw.on('message', () => acksBySource.set(index, acksBySource.get(index) + 1));
    const probe = Buffer.from(JSON.stringify({ v: 1, type: 'probe', instanceId: `${SELF_A.instanceId}-${index}`, identityName: `来源${index}` }));
    raw.send(probe, base, '127.0.0.2');
    if (index === 0) {
      raw.send(probe, base, '127.0.0.2');   // 同一来源紧邻两发：必落在同一 250ms 限流窗口内（同步连发，间隔 µs 级）
    }
  }
  t.after(() => raws.forEach((raw) => raw.close()));
  await waitFor(() => b.node.stats().probesAnswered >= 3, { timeoutMs: 5000 });
  await waitFor(() => b.node.stats().rateLimited >= 1, { timeoutMs: 3000 });
  assert.equal(acksBySource.get(0), 1, '同源窗口内的第二发不被应答');
  assert.equal(acksBySource.get(1), 1);
  assert.equal(acksBySource.get(2), 1);
  assert.equal(b.node.stats().probesAnswered, 3, '三个来源各获一次应答（互不吞）');
  assert.equal(b.knownHosts.stats().remembered, 3, '三来源各记入一次（写次数随来源数增长）');
});

test('伪造洪泛边界（M8 计量）：写次数随「来源数」而非「包数」增长', { timeout: 15000 }, async (t) => {
  const base = await pickFreePort();
  const b = await startNode(t, { self: SELF_B, bindAddress: '127.0.0.2', port: base, segmentBase: base });
  const raw = dgram.createSocket('udp4');
  t.after(() => raw.close());
  await new Promise((resolve, reject) => {
    raw.once('error', reject);
    raw.bind({ port: 0, address: '127.0.0.1' }, resolve);
  });
  const probe = Buffer.from(JSON.stringify({ v: 1, type: 'probe', instanceId: SELF_A.instanceId, identityName: '主机甲' }));
  for (let index = 0; index < 20; index++) {
    raw.send(probe, base, '127.0.0.2');
  }
  await waitFor(() => b.node.stats().datagramsIn >= 20, { timeoutMs: 5000 });
  assert.equal(b.knownHosts.stats().remembered, 1, '单源 20 连发只写一次清单（整文件原子写不被放大）');
  assert.ok(b.node.stats().rateLimited >= 19);
  assert.equal(b.knownHosts.stats().entries, 1);
});
