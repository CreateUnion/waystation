import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { DISCOVERY_REPLY_MIN_INTERVAL_MS, broadcastTargets, createDiscovery } from '../src/net/discovery.js';
import { createKnownHosts } from '../src/net/known-hosts.js';
import { makeTempDir, pickFreePort, waitFor } from './helpers.js';

const SELF_A = { instanceId: 'aaaaaaaa-0000-4000-8000-000000000001', identityName: '主机甲' };
const SELF_B = { instanceId: 'bbbbbbbb-0000-4000-8000-000000000002', identityName: '主机乙' };

function quietLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

async function startNode(t, { self, bindAddress, collabCount = 0, port }) {
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
  });
  await node.start();
  t.after(() => node.close());
  return { node, knownHosts };
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
  a.knownHosts.remember({ address: '127.0.0.2' });
  const hosts = await a.node.scan({ windowMs: 300 });
  assert.equal(hosts.length, 1);
  assert.equal(hosts[0].instanceId, SELF_B.instanceId);
  assert.equal(hosts[0].identityName, '主机乙');
  assert.equal(hosts[0].collabCount, 3);
  assert.deepEqual(hosts[0].addresses, ['127.0.0.2']);
  assert.ok(!Number.isNaN(Date.parse(hosts[0].lastSeenAt)));
});

test('排除自答：清单含自身地址时扫描结果为空并计数', { timeout: 15000 }, async (t) => {
  const port = await pickFreePort();
  const a = await startNode(t, { self: SELF_A, bindAddress: '127.0.0.1', port });
  a.knownHosts.remember({ address: '127.0.0.1' });
  const hosts = await a.node.scan({ windowMs: 200 });
  assert.deepEqual(hosts, []);
  assert.ok(a.node.stats().selfObserved >= 1);
});

test('探测来源入清单：B 收到 A 的探测后记住 A 的地址（广播盲区反向补偿）', { timeout: 15000 }, async (t) => {
  const port = await pickFreePort();
  const a = await startNode(t, { self: SELF_A, bindAddress: '127.0.0.1', port });
  const b = await startNode(t, { self: SELF_B, bindAddress: '127.0.0.2', port });
  a.knownHosts.remember({ address: '127.0.0.2' });
  await a.node.scan({ windowMs: 200 });
  assert.deepEqual(b.knownHosts.addresses(), ['127.0.0.1']);
});

test('扫描应答更新清单：登记对方实例标识与身份名', { timeout: 15000 }, async (t) => {
  const port = await pickFreePort();
  const a = await startNode(t, { self: SELF_A, bindAddress: '127.0.0.1', port });
  await startNode(t, { self: SELF_B, bindAddress: '127.0.0.2', port });
  a.knownHosts.remember({ address: '127.0.0.2' });
  await a.node.scan({ windowMs: 200 });
  const recorded = a.knownHosts.list().find((entry) => entry.address === '127.0.0.2');
  assert.equal(recorded.instanceId, SELF_B.instanceId);
  assert.equal(recorded.identityName, '主机乙');
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
