import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { participantsStateOf } from '../src/net/known-hosts.js';
import { startSessionNode } from './helpers/session-participants.js';
import { waitFor } from './helpers.js';

/* 能力闸门与证据分级：旧对端（缺 participants）拒绝协作、未知先探测、直连探测可把已知支持
 * 降级为不支持、扫描/自介的缺字段只继承。
 * 长操作声明：不需要 UDP 的用例在进程内直接驱动；真实单播探测用例受 LAN 隔离闸控制（默认跳过），
 * 单用例超时上限 30s。 */

const TIMEOUT_MS = 30000;
const LAN_ENABLED = process.env.WAYSTATION_LAN_E2E === '1';
const LAN_SKIP = LAN_ENABLED ? false : 'LAN 发现隔离未就绪：真实 UDP 探测用例默认跳过（设置 WAYSTATION_LAN_E2E=1 启用）';

const PEER = { instanceId: 'inst-cap-peer', identityName: '对端机', address: '127.0.0.1', port: 24100 };

async function startGateNode(t) {
  return startSessionNode(t, { identityName: '本机', online: ['seat-manager'] });
}

function rememberPeer(node, participants, source = 'scan') {
  node.knownHosts.remember({
    address: PEER.address,
    port: PEER.port,
    instanceId: PEER.instanceId,
    identityName: PEER.identityName,
    participants,
    source,
  });
}

function targetOfPeer() {
  return { instanceId: PEER.instanceId, identityName: PEER.identityName, address: PEER.address, port: PEER.port };
}

test('能力三态：2 = 支持、0 = 不支持、缺字段 = 未知（非法值按未知）', () => {
  assert.equal(participantsStateOf({ participants: 2 }), 'supported');
  assert.equal(participantsStateOf({ participants: 0 }), 'unsupported');
  assert.equal(participantsStateOf({}), 'unknown');
  assert.equal(participantsStateOf({ participants: 'two' }), 'unknown');
  assert.equal(participantsStateOf(null), 'unknown');
});

test('缺字段继承：扫描不带 participants 不覆盖已知支持态；直连探测 0 可降级', { timeout: TIMEOUT_MS }, async (t) => {
  const node = await startGateNode(t);
  rememberPeer(node, 2, 'scan');
  assert.equal(node.knownHosts.participantsOf(PEER.instanceId), 2);
  node.knownHosts.remember({ address: PEER.address, port: PEER.port, instanceId: PEER.instanceId, identityName: PEER.identityName, source: 'scan' });
  assert.equal(node.knownHosts.participantsOf(PEER.instanceId), 2, '扫描缺字段只继承，不降级');
  node.knownHosts.remember({ address: PEER.address, port: PEER.port, instanceId: PEER.instanceId, identityName: PEER.identityName, participants: 0, source: 'probe' });
  assert.equal(node.knownHosts.participantsOf(PEER.instanceId), 0, '直连探测证据可降级');
  const listed = node.knownHosts.list().find((entry) => entry.instanceId === PEER.instanceId);
  assert.equal(participantsStateOf(listed), 'unsupported');
  assert.equal(listed.source, 'probe', '降级结论标注来源');
});

test('能力闸门：已知不支持的对端拒绝建立协作 / 邀请（旧节点不支持会话级席位）', { timeout: TIMEOUT_MS }, async (t) => {
  const node = await startGateNode(t);
  rememberPeer(node, 0, 'probe');
  const created = await node.service.create({
    name: '旧节点协作',
    topic: '能力闸门',
    targets: [targetOfPeer()],
    mode: 'managed',
    sessionId: 'seat-manager',
  });
  assert.equal(created.ok, false, '已知不支持的对端不得进入协作');
  assert.match(String(created.message), /不支持|旧版|旧节点/, String(created.message));
});

test('能力闸门：未知对端先探测再判定（不得直接按支持协作）', { timeout: TIMEOUT_MS }, async (t) => {
  const node = await startGateNode(t);
  node.knownHosts.remember({
    address: PEER.address,
    port: PEER.port,
    instanceId: PEER.instanceId,
    identityName: PEER.identityName,
    source: 'scan',
  });
  const created = await node.service.create({
    name: '未知对端协作',
    topic: '能力闸门',
    targets: [targetOfPeer()],
    mode: 'managed',
    sessionId: 'seat-manager',
  });
  assert.equal(created.ok, false, '未知能力不得直接建立协作——先单播探测');
  assert.match(String(created.message), /未知|探测|不支持/, String(created.message));
});

/* 真实单播探测（无广播）：对端发现面应答 probe-ack 携 participants:2；
 * 旧对端只回应答不带字段 → 2→0 降级。默认跳过，隔离闸就绪后设 WAYSTATION_LAN_E2E=1 运行。 */
test('真实双节点：未知 → 单播探测 → 支持；旧对端缺字段 → 2→0 降级', { timeout: TIMEOUT_MS, skip: LAN_SKIP }, async (t) => {
  const peer = await startSessionNode(t, { instanceId: PEER.instanceId, identityName: PEER.identityName, discovery: true });
  const prober = await startSessionNode(t, { instanceId: 'inst-cap-prober', identityName: '探测机', discovery: true });
  prober.knownHosts.remember({ address: '127.0.0.1', port: peer.port, instanceId: PEER.instanceId, identityName: PEER.identityName, source: 'scan' });
  const supported = await prober.discovery.probeCapability({ instanceId: PEER.instanceId, address: '127.0.0.1', port: peer.port, timeoutMs: 500 });
  assert.equal(supported.capability, 'supported', JSON.stringify(supported));
  assert.equal(prober.knownHosts.participantsOf(PEER.instanceId), 2);

  const oldPort = await startOldPeer(t);
  prober.knownHosts.remember({ address: '127.0.0.1', port: oldPort, instanceId: 'inst-old-peer', identityName: '旧机', participants: 2, source: 'scan' });
  const downgraded = await prober.discovery.probeCapability({ address: '127.0.0.1', port: oldPort, instanceId: 'inst-old-peer', timeoutMs: 500 });
  assert.equal(downgraded.capability, 'unsupported', JSON.stringify(downgraded));
  assert.equal(prober.knownHosts.participantsOf('inst-old-peer'), 0, '直连探测可把已知支持降级');
});

/* 旧对端应答桩：只回一条不带 participants 的 probe-ack（版本号形态合法）。 */
async function startOldPeer(t) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: false });
  socket.on('message', (buffer, rinfo) => {
    const frame = parseJson(buffer);
    if (frame === null || frame.type !== 'probe') {
      return;
    }
    const reply = { v: 1, type: 'probe-ack', instanceId: 'inst-old-peer', identityName: '旧机', port: socket.address().port, sessions: [] };
    socket.send(Buffer.from(JSON.stringify(reply)), rinfo.port, rinfo.address);
  });
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind({ port: 0, address: '127.0.0.1', exclusive: true }, resolve);
  });
  t.after(() => socket.close());
  return socket.address().port;
}

function parseJson(buffer) {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  }
}

test('探测结论与清单同源：探测返回前已写入 known-hosts', { timeout: TIMEOUT_MS, skip: LAN_SKIP }, async (t) => {
  const peer = await startSessionNode(t, { instanceId: PEER.instanceId, identityName: PEER.identityName, discovery: true });
  const prober = await startSessionNode(t, { instanceId: 'inst-cap-prober-2', identityName: '探测机', discovery: true });
  await prober.discovery.probeCapability({ instanceId: PEER.instanceId, address: '127.0.0.1', port: peer.port, timeoutMs: 500 });
  await waitFor(() => prober.knownHosts.participantsOf(PEER.instanceId) === 2 ? true : null, { timeoutMs: 1000 });
});
