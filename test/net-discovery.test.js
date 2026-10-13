import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { networkInterfaces } from 'node:os';
import {
  DISCOVERY_REPLY_MIN_INTERVAL_MS,
  JOIN_KNOCK_RETRY_COUNT,
  JOIN_KNOCK_RETRY_INTERVAL_MS,
  JOIN_KNOCK_WINDOW_MS,
  broadcastTargets,
  createDiscovery,
  fitJoinAckDatagram,
} from '../src/net/discovery.js';
import { createKnownHosts } from '../src/net/known-hosts.js';
import { MAX_COLLAB_COUNT } from '../src/net/protocol.js';
import { makeTempDir, pickFreePort, waitFor } from './helpers.js';

const SELF_A = { instanceId: 'aaaaaaaa-0000-4000-8000-000000000001', identityName: '主机甲' };
const SELF_B = { instanceId: 'bbbbbbbb-0000-4000-8000-000000000002', identityName: '主机乙' };

function quietLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

async function startNode(t, { self, bindAddress, collabCount = 0, port, segmentBase, onJoinKnock = null, knockOptions = {} }) {
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
    onJoinKnock,
    ...knockOptions,
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

/* —— 主动加入（设计 §5.6）：敲门 / 应答的收发、限流、合并与体积预算 —— */

/* 压缩后的敲门时程（生产值见 discovery.js 顶部常量）：窗口覆盖重发时程、应答限流跨重发——
 * 与生产三者的相对关系一致，用例才具备判别力。 */
const KNOCK_TIMINGS = { joinKnockRetryCount: 2, joinKnockRetryIntervalMs: 60, joinKnockWindowMs: 300, joinKnockReplyMinIntervalMs: 600 };

/* 成员侧命中回调的固定应答载荷（形态 = 协作层 handleJoinKnock 的返回项）。 */
const JOIN_REPLY = {
  collabId: 'collab-1',
  name: '联调讨论',
  topic: '发布联调',
  memberCount: 3,
  originator: { instanceId: 'inst-org', identityName: '发起人' },
};

/* 伪敲门对端：收到敲门后按序数决定是否应答（replyOnOrdinal=false 恒不应答）；应答回指收到敲门的 knockId。 */
function startKnockPeer(t, { port, address, replyOnOrdinal = 1, overrides = {} }) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: false });
  t.after(() => socket.close());
  const peer = { knocksReceived: 0 };
  socket.on('message', (buffer, rinfo) => {
    const knock = JSON.parse(buffer.toString('utf8'));
    if (knock.type !== 'join-knock') {
      return;
    }
    peer.knocksReceived++;
    if (peer.knocksReceived !== replyOnOrdinal) {
      return;
    }
    const ack = Buffer.from(JSON.stringify({
      v: 1,
      type: 'join-ack',
      instanceId: SELF_B.instanceId,
      identityName: '主机乙',
      knockId: knock.knockId,
      collabId: 'collab-1',
      name: '联调讨论',
      topic: '发布联调',
      memberCount: 3,
      originator: { instanceId: 'inst-org', identityName: '发起人' },
      port,
      ...overrides,
    }));
    socket.send(ack, rinfo.port, rinfo.address);
  });
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind({ port, address, exclusive: true }, () => resolve(peer));
  });
}

/* 裸对端：绑定回环、收集收到的全部数据报（供「不应答 / 应答形态」类断言）。 */
async function startRawPeer(t) {
  const raw = dgram.createSocket('udp4');
  t.after(() => raw.close());
  const received = [];
  raw.on('message', (buffer) => received.push(JSON.parse(buffer.toString('utf8'))));
  await new Promise((resolve, reject) => {
    raw.once('error', reject);
    raw.bind({ port: 0, address: '127.0.0.1' }, resolve);
  });
  return { raw, received };
}

test('敲门与应答（单播兜底实测）：成员命中自动应答、应答按讨论合并为一行、重发被限流不放大', { timeout: 15000 }, async (t) => {
  const portA = await pickFreePort();
  const portB = await pickFreePort();
  const knocksSeen = [];
  const a = await startNode(t, { self: SELF_A, bindAddress: '127.0.0.1', port: portA, knockOptions: KNOCK_TIMINGS });
  const b = await startNode(t, { self: SELF_B, bindAddress: '127.0.0.2', port: portB, onJoinKnock: (knock) => { knocksSeen.push(knock); return [JOIN_REPLY]; }, knockOptions: KNOCK_TIMINGS });
  a.knownHosts.remember({ address: '127.0.0.2', port: portB });
  const replies = await a.node.requestJoin({ name: '联调讨论' });
  assert.equal(knocksSeen.length, 1, '首个敲门即被处理；后续重发应落在应答限流窗内不再触发命中处理');
  assert.equal(knocksSeen[0].instanceId, SELF_A.instanceId);
  assert.equal(knocksSeen[0].identityName, '主机甲');
  assert.equal(knocksSeen[0].name, '联调讨论');
  assert.equal(knocksSeen[0].address, '127.0.0.1', '命中回调携申请人来源端点（放行时作 ws_invite 目标）');
  assert.equal(knocksSeen[0].port, portA);
  assert.match(knocksSeen[0].knockId, /^[0-9a-f-]{32,40}$/);
  assert.deepEqual(replies, [{
    collabId: 'collab-1',
    name: '联调讨论',
    topic: '发布联调',
    memberCount: 3,
    originator: { instanceId: 'inst-org', identityName: '发起人' },
    topicTruncated: false,
    nameTruncated: false,
    responder: { instanceId: SELF_B.instanceId, identityName: '主机乙', address: '127.0.0.2', port: portB },
    replies: 1,
  }]);
  assert.ok(a.node.stats().joinKnocksSent >= 3, `敲门应少量重发（1+${JOIN_KNOCK_RETRY_COUNT} 发），实际 ${a.node.stats().joinKnocksSent}`);
  assert.equal(a.node.stats().joinRepliesIn, 1);
  assert.equal(b.node.stats().joinRepliesAnswered, 1, '重发落在限流窗内：一次申请只放大为一份应答');
  assert.ok(b.node.stats().joinKnocksThrottled >= 1, '被限流的重发应计数留痕');
  assert.equal(b.node.stats().probesAnswered, 0, '敲门不触探测面');
});

test('敲门重发覆盖首包丢失：伪对端只答第二发，应答按 knockId 回指本次敲门被采信', { timeout: 15000 }, async (t) => {
  const portA = await pickFreePort();
  const portB = await pickFreePort();
  const a = await startNode(t, { self: SELF_A, bindAddress: '127.0.0.1', port: portA, knockOptions: KNOCK_TIMINGS });
  const peer = await startKnockPeer(t, { port: portB, address: '127.0.0.2', replyOnOrdinal: 2 });
  a.knownHosts.remember({ address: '127.0.0.2', port: portB });
  const replies = await a.node.requestJoin({ name: '联调讨论' });
  assert.ok(peer.knocksReceived >= 2, `首包丢失应由重发覆盖，实际收到 ${peer.knocksReceived} 发`);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].collabId, 'collab-1');
  assert.equal(a.node.stats().joinRepliesIn, 1, 'knockId 相符的应答被采信');
});

test('敲门应答限流（同源最小间隔）：窗口内再次敲门不放大为二次应答', { timeout: 15000 }, async (t) => {
  const portA = await pickFreePort();
  const portB = await pickFreePort();
  const timings = { joinKnockRetryCount: 0, joinKnockRetryIntervalMs: 10, joinKnockWindowMs: 200, joinKnockReplyMinIntervalMs: 1500 };
  const a = await startNode(t, { self: SELF_A, bindAddress: '127.0.0.1', port: portA, knockOptions: timings });
  const b = await startNode(t, { self: SELF_B, bindAddress: '127.0.0.2', port: portB, onJoinKnock: () => [JOIN_REPLY], knockOptions: timings });
  a.knownHosts.remember({ address: '127.0.0.2', port: portB });
  const first = await a.node.requestJoin({ name: '联调讨论' });
  const second = await a.node.requestJoin({ name: '联调讨论' });
  assert.equal(first.length, 1);
  assert.deepEqual(second, [], '限流窗内的再敲不应答（申请人不做重试风暴，成员也不被放大）');
  assert.equal(b.node.stats().joinRepliesAnswered, 1);
  assert.ok(b.node.stats().joinKnocksThrottled >= 1);
});

test('无讨论面（onJoinKnock 缺省）：敲门不应答；探测面行为零变化（probe-ack 不含敲门字段）', { timeout: 15000 }, async (t) => {
  const portB = await pickFreePort();
  await startNode(t, { self: SELF_B, bindAddress: '127.0.0.2', port: portB });
  const { raw, received } = await startRawPeer(t);
  const knock = Buffer.from(JSON.stringify({ v: 1, type: 'join-knock', instanceId: SELF_A.instanceId, identityName: '主机甲', knockId: 'knock-1', name: '联调讨论' }));
  raw.send(knock, portB, '127.0.0.2');
  await new Promise((resolve) => setTimeout(resolve, 300));
  raw.send(Buffer.from(JSON.stringify({ v: 1, type: 'probe', instanceId: SELF_A.instanceId, identityName: '主机甲' })), portB, '127.0.0.2');
  await waitFor(() => received.length >= 1);
  assert.equal(received[0].type, 'probe-ack', '敲门不触发探测应答、探测仍走原路（兼容面零变化）');
  assert.equal('knockId' in received[0], false);
  assert.equal(received[0].collabCount, 0);
});

test('非法敲门：超体积 / 坏字段 / 版本不符——拒绝、计数、不应答', { timeout: 15000 }, async (t) => {
  const portB = await pickFreePort();
  const b = await startNode(t, { self: SELF_B, bindAddress: '127.0.0.2', port: portB, onJoinKnock: () => [JOIN_REPLY] });
  const { raw, received } = await startRawPeer(t);
  const knockWith = (overrides) => Buffer.from(JSON.stringify({ v: 1, type: 'join-knock', instanceId: SELF_A.instanceId, identityName: '主机甲', knockId: 'knock-1', name: '联调讨论', ...overrides }));
  raw.send(Buffer.alloc(600, 0x61), portB, '127.0.0.2');
  raw.send(knockWith({ knockId: '../x' }), portB, '127.0.0.2');
  raw.send(knockWith({ name: '甲\n乙' }), portB, '127.0.0.2');
  raw.send(knockWith({ v: 2 }), portB, '127.0.0.2');
  await waitFor(() => b.node.stats().rejected.invalid >= 3);
  await waitFor(() => b.node.stats().rejected.oversize >= 1);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(received, [], '非法敲门不得触发应答（命中回调也不应被调用）');
  assert.equal(b.node.stats().joinRepliesAnswered, 0);
});

test('非法加入应答：拒绝并计数、不并入在途收集', { timeout: 15000 }, async (t) => {
  const portA = await pickFreePort();
  const portB = await pickFreePort();
  const timings = { joinKnockRetryCount: 0, joinKnockRetryIntervalMs: 10, joinKnockWindowMs: 250, joinKnockReplyMinIntervalMs: 600 };
  const a = await startNode(t, { self: SELF_A, bindAddress: '127.0.0.1', port: portA, knockOptions: timings });
  await startKnockPeer(t, { port: portB, address: '127.0.0.2', overrides: { memberCount: 0 } });
  a.knownHosts.remember({ address: '127.0.0.2', port: portB });
  const replies = await a.node.requestJoin({ name: '联调讨论' });
  assert.deepEqual(replies, []);
  assert.ok(a.node.stats().rejected.invalid >= 1, '非法应答拒绝并计数');
  assert.equal(a.node.stats().joinRepliesIn, 0, '校验失败不得进入应答计数（与探测应答同口径：先校验后计数）');
});

test('自答排除：敲自己的门不触发命中处理；自己实例标识的应答不采信', { timeout: 15000 }, async (t) => {
  const portA = await pickFreePort();
  let hitCount = 0;
  const timings = { joinKnockRetryCount: 0, joinKnockRetryIntervalMs: 10, joinKnockWindowMs: 250, joinKnockReplyMinIntervalMs: 600 };
  const a = await startNode(t, { self: SELF_A, bindAddress: '127.0.0.1', port: portA, onJoinKnock: () => { hitCount++; return [JOIN_REPLY]; }, knockOptions: timings });
  a.knownHosts.remember({ address: '127.0.0.1', port: portA });
  const first = await a.node.requestJoin({ name: '联调讨论' });
  assert.deepEqual(first, []);
  assert.equal(hitCount, 0, '自答排除先于命中处理');
  assert.ok(a.node.stats().selfObserved >= 1);
  assert.equal(a.node.stats().joinRepliesAnswered, 0);
  const { raw } = await startRawPeer(t);
  const pending = a.node.requestJoin({ name: '联调讨论' });
  await new Promise((resolve) => setTimeout(resolve, 60));
  raw.send(Buffer.from(JSON.stringify({
    v: 1, type: 'join-ack', instanceId: SELF_A.instanceId, identityName: '主机甲', knockId: 'knock-x',
    collabId: 'collab-1', name: '联调讨论', topic: '发布联调', memberCount: 3,
    originator: { instanceId: 'inst-org', identityName: '发起人' },
  })), portA, '127.0.0.1');
  const second = await pending;
  assert.deepEqual(second, []);
  assert.equal(a.node.stats().joinRepliesIn, 1, '应答计数先于自答排除（同探测应答口径）');
  assert.ok(a.node.stats().selfObserved >= 1);
});

test('应答合并：同讨论多成员合一行计数、同名不同讨论各占一行（按名与标识排序）', { timeout: 15000 }, async (t) => {
  const portA = await pickFreePort();
  const portB = await pickFreePort();
  const portC = await pickFreePort();
  const portD = await pickFreePort();
  const a = await startNode(t, { self: SELF_A, bindAddress: '127.0.0.1', port: portA, knockOptions: KNOCK_TIMINGS });
  await startKnockPeer(t, { port: portB, address: '127.0.0.2' });
  await startKnockPeer(t, { port: portC, address: '127.0.0.3' });
  await startKnockPeer(t, { port: portD, address: '127.0.0.4', overrides: { collabId: 'collab-2' } });
  a.knownHosts.remember({ address: '127.0.0.2', port: portB });
  a.knownHosts.remember({ address: '127.0.0.3', port: portC });
  a.knownHosts.remember({ address: '127.0.0.4', port: portD });
  const replies = await a.node.requestJoin({ name: '联调讨论' });
  assert.deepEqual(replies.map((row) => [row.collabId, row.replies]), [['collab-1', 2], ['collab-2', 1]], '同讨论合并计数；不同讨论各占一行；按（名，标识）稳定排序');
  assert.equal(replies[0].responder.address, '127.0.0.2', '首份应答的来源即该行的应答者端点');
});

test('fitJoinAckDatagram：先截主题、仍超再截名称；UTF-8 安全、标注截断、固定字段不可截；截到无可截则拒发', () => {
  const small = {
    v: 1, type: 'join-ack', instanceId: 'inst-b', identityName: '主机乙', knockId: 'knock-1', port: 7321,
    collabId: 'collab-1', name: '联调讨论', topic: '发布联调', memberCount: 3,
    originator: { instanceId: 'inst-org', identityName: '发起人' },
  };
  assert.deepEqual(fitJoinAckDatagram(small), small, '预算内原样返回');
  const longTopic = '题'.repeat(200);
  const fittedTopic = fitJoinAckDatagram({ ...small, topic: longTopic });
  assert.ok(Buffer.byteLength(JSON.stringify(fittedTopic)) <= 512);
  assert.equal(fittedTopic.topicTruncated, true);
  assert.equal(fittedTopic.nameTruncated === true, false, '主题尚可容纳时不得动名称');
  assert.equal(fittedTopic.name, '联调讨论');
  assert.equal(fittedTopic.collabId, 'collab-1');
  assert.equal(fittedTopic.memberCount, 3);
  assert.deepEqual(fittedTopic.originator, { instanceId: 'inst-org', identityName: '发起人' });
  assert.ok(fittedTopic.topic.length > 0 && fittedTopic.topic.length < 200);
  assert.ok(longTopic.startsWith(fittedTopic.topic), '截断 = 前缀（不重排原文）');
  assert.equal(Buffer.from(fittedTopic.topic, 'utf8').toString('utf8'), fittedTopic.topic, 'UTF-8 安全：不得切出半个字符');
  const longIds = { instanceId: 'e'.repeat(36), identityName: 'e'.repeat(36), knockId: 'k'.repeat(36), collabId: 'c'.repeat(36), originator: { instanceId: 'o'.repeat(36), identityName: 'o'.repeat(36) } };
  const longName = '名'.repeat(64);
  const fittedName = fitJoinAckDatagram({ ...small, ...longIds, name: longName, topic: '题'.repeat(200) });
  assert.ok(Buffer.byteLength(JSON.stringify(fittedName)) <= 512);
  assert.equal(fittedName.topic, '', '主题截空后仍超：主题归空（带标注）再截名称');
  assert.equal(fittedName.topicTruncated, true);
  assert.equal(fittedName.nameTruncated, true);
  assert.ok(fittedName.name.length > 0 && fittedName.name.length < 64);
  assert.ok(longName.startsWith(fittedName.name));
  assert.equal(fittedName.collabId, 'c'.repeat(36), '不可截字段保持完整（加入后对表补齐由接收侧承担）');
  const hopeless = fitJoinAckDatagram({ ...small, ...longIds, identityName: '甲'.repeat(64), originator: { instanceId: 'o'.repeat(36), identityName: '乙'.repeat(64) }, name: longName, topic: '题'.repeat(200) });
  assert.equal(hopeless, null, '身份与标识撑爆信封：宁可不答（绝不发超限数据报、绝不截不可截字段）');
});

test('敲门应答的体积预算在线上生效：超长主题截断后仍可达（整形而非被拒），截到无可截则不发并计数', { timeout: 15000 }, async (t) => {
  const portA = await pickFreePort();
  const portB = await pickFreePort();
  const portC = await pickFreePort();
  const longTopic = '题'.repeat(200);
  const a = await startNode(t, { self: SELF_A, bindAddress: '127.0.0.1', port: portA, knockOptions: KNOCK_TIMINGS });
  await startNode(t, { self: SELF_B, bindAddress: '127.0.0.2', port: portB, onJoinKnock: () => [{ ...JOIN_REPLY, topic: longTopic }], knockOptions: KNOCK_TIMINGS });
  const bigSelf = { instanceId: 'cccccccc-0000-4000-8000-000000000003', identityName: '丙'.repeat(64) };
  const c = await startNode(t, { self: bigSelf, bindAddress: '127.0.0.3', port: portC, onJoinKnock: () => [{ ...JOIN_REPLY, topic: longTopic, name: '名'.repeat(64) }], knockOptions: KNOCK_TIMINGS });
  a.knownHosts.remember({ address: '127.0.0.2', port: portB });
  a.knownHosts.remember({ address: '127.0.0.3', port: portC });
  const replies = await a.node.requestJoin({ name: '联调讨论' });
  assert.equal(replies.length, 1, '可截断的应答整形后送达；不可截的应答不占结果面');
  assert.equal(replies[0].responder.port, portB);
  assert.equal(replies[0].topicTruncated, true);
  assert.equal(replies[0].topic.length < 200, true);
  assert.ok(longTopic.startsWith(replies[0].topic));
  assert.equal(c.node.stats().joinRepliesSkipped, 1, '截到无可截：放弃发送并计数留痕（绝不发超限数据报）');
  assert.equal(c.node.stats().joinRepliesAnswered, 0);
});

test('敲门参数与常量：非法讨论名抛 TypeError；生产窗口覆盖重发时程且应答限流跨重发', { timeout: 15000 }, async (t) => {
  const port = await pickFreePort();
  const a = await startNode(t, { self: SELF_A, bindAddress: '127.0.0.1', port });
  await assert.rejects(a.node.requestJoin({ name: '甲\n乙' }), TypeError);
  await assert.rejects(a.node.requestJoin({ name: '' }), TypeError);
  await assert.rejects(a.node.requestJoin({}), TypeError);
  assert.equal(JOIN_KNOCK_RETRY_COUNT, 2, '少量重发：1+2 发');
  assert.ok(JOIN_KNOCK_WINDOW_MS >= JOIN_KNOCK_RETRY_INTERVAL_MS * (JOIN_KNOCK_RETRY_COUNT + 1), '收答窗口覆盖重发时程（末次重发仍有收条时间）');
});
