import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import net from 'node:net';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  classifyOccupant, createProbeSession, findSameRootSessions, isSameRootPeer, isSameRootSessionEntry,
  probeSegmentStations, probeStation,
} from '../src/site.js';
import { DISCOVERY_DISABLE_ENV } from '../src/net/discovery.js';
import { PROTOCOL_VERSION, validateProbe } from '../src/net/protocol.js';
import { CONFIG_FILE_NAME, RUN_DIR_NAME, coreJsonPath, sessionFilePath } from '../src/paths.js';
import { INSTANCE_ID_FILE } from '../src/instance-id.js';
import { startCore } from '../src/core/main.js';
import { makeTempDir, pickFreePort, pickFreeSegment, waitFor, waitForRebindable } from './helpers.js';

/* 端口等待接管循环的用例面（设计 §6.1/§2.3/§9.1-⑤）：前半＝桩侧面（探测原语的身份面、同根判别的
 * 纯判据、假应答者与数据面夹具）；后半＝接线段（核心进程内起的 waiting 驻留与迁出、迁出前重验锁、
 * ①② 降级服务与自动接管、寿命上界）。
 * 红证形态（各注册在对应用例的断言消息里）：只按「目标端口是合法驿站」归类的实现会把同根判成
 * 别根（降级服务＝与同根旧站点并行双写）；只看端口的实现会漏判「不持任何端口、仅数据面活跃」
 * 的旧站点、也会在数据面仍命中时误判可迁出——本文件用夹具把这三条判据钉在断言上。
 * 端口纪律：一律 pickFreePort / pickFreeSegment 取段外空闲端口，不触碰真实站点段 7321–7328；
 * 数据根一律临时目录（makeTempDir），不触碰真实 ~/.waystation。 */

const PROBE_TIMEOUT_MS = 200;   // 用例注入的短预算：探测按参数窗口结算，不等模块默认的 1s

const OWN = { instanceId: 'root-instance-1', identityName: 'lanfeng' };
const OTHER = { instanceId: 'other-instance-9', identityName: 'lanfeng-2' };
/* 跨根同名：身份名与本根相同、instanceId 不同——默认身份名都是主机名时的真实形态，不得误判同根。 */
const SAME_NAME_OTHER = { instanceId: 'other-instance-9', identityName: OWN.identityName };
const quietWarn = () => {};

function closeQuietly(handle) {
  try {
    handle.close();
  } catch {
    // 未绑定成功或已关闭：无需再关
  }
}

/* 独占绑定一个 UDP 端口并登记收尾（绑不上即抛：环境碰撞响亮失败，不静默换端口——
 * 用例断言的对象必须是自己的夹具绑上的那个）。 */
async function openUdp(t, port) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: false });
  t.after(() => closeQuietly(socket));
  try {
    await new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.bind({ port, address: '0.0.0.0', exclusive: true }, resolve);
    });
  } catch (error) {
    closeQuietly(socket);
    throw error;
  }
  return socket;
}

/* 假应答者（UDP 面）：收 probe 以合法 probe-ack 应答，携带注入的对端身份
 * （probes 收集收到的探测报文；sources 收集来源端口——探测会话套接字复用的观察面）。 */
async function startUdpResponder(t, { port, peer, probes = [], sources = [] }) {
  const socket = await openUdp(t, port);
  socket.on('message', (buffer, rinfo) => {
    const datagram = JSON.parse(buffer.toString('utf8'));
    probes.push(datagram);
    sources.push(rinfo.port);
    if (datagram.type !== 'probe') {
      return;
    }
    const ack = Buffer.from(JSON.stringify({
      v: PROTOCOL_VERSION, type: 'probe-ack', instanceId: peer.instanceId, identityName: peer.identityName, collabCount: 0, port,
    }));
    socket.send(ack, rinfo.port, rinfo.address);
  });
  return socket;
}

/* 静默占用者（无关程序形态）：独占绑 UDP、不作任何应答——它与驿站的区别只在「是否应答」。 */
function startSilentSquatter(t, port) {
  return openUdp(t, port);
}

/* 假应答者（TCP 面）：收合法 ping 以合法 pong 应答（from = 注入身份；peer 为 null 则省略 from）——
 * 覆盖「UDP 面让位」的占用形态与「pong 缺身份」的宽容口径。 */
async function startTcpResponder(t, { port, peer }) {
  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        respondPing(socket, line, peer);
      }
    });
    socket.on('error', () => {});
  });
  t.after(() => closeQuietly(server));
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ port, host: '0.0.0.0' }, resolve);
    });
  } catch (error) {
    closeQuietly(server);
    throw error;
  }
  return server;
}

function respondPing(socket, line, peer) {
  try {
    const frame = JSON.parse(line);
    if (frame === null || typeof frame !== 'object' || frame.type !== 'ping') {
      return;
    }
    const pong = { v: PROTOCOL_VERSION, type: 'pong', msgId: 'pong-1', replyTo: frame.msgId, ts: new Date().toISOString() };
    if (peer !== null) {
      pong.from = { instanceId: peer.instanceId, identityName: peer.identityName };
    }
    socket.write(JSON.stringify(pong) + '\n');
  } catch {
    // 非协议行忽略（证据导向：只对合法 ping 应答）
  }
}

/* 非法应答者：对 probe 回一个过不了协议校验的 probe-ack（缺 collabCount）——校验不通过的应答不是证据。 */
async function startInvalidAckResponder(t, { port }) {
  const socket = await openUdp(t, port);
  socket.on('message', (buffer, rinfo) => {
    const datagram = JSON.parse(buffer.toString('utf8'));
    if (datagram.type !== 'probe') {
      return;
    }
    const ack = Buffer.from(JSON.stringify({ v: PROTOCOL_VERSION, type: 'probe-ack', instanceId: 'peer-invalid', identityName: '对端' }));
    socket.send(ack, rinfo.port, rinfo.address);
  });
  return socket;
}

/* 数据面夹具：在数据根的 sessions/ 下写一条会话状态文件（形态与状态栏写入端一致）。
 * instanceId 即身份锚（旧版写入端 v1 形态本就携带该字段），identityName 只作呈现。 */
function writeSessionFile(mainDir, { sessionId, instanceId, identityName = '对端驿站', site, updatedAt }) {
  const file = sessionFilePath(mainDir, sessionId);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({
    v: 1, sessionId, instanceId, identityName, site, port: 7100, pid: 4242, updatedAt, collabs: [],
  }));
  return file;
}

test('probeStation：UDP probe-ack 应答 → 判合法驿站并带回对端身份', async (t) => {
  const port = await pickFreePort();
  const probes = [];
  await startUdpResponder(t, { port, peer: OWN, probes });
  const evidence = await probeStation({ port, probeTimeoutMs: PROBE_TIMEOUT_MS, warn: quietWarn });
  assert.deepEqual(evidence, { station: true, peer: OWN });
  const probe = await waitFor(() => probes[0] ?? null, { timeoutMs: 3000 });
  assert.equal(validateProbe(probe).ok, true, JSON.stringify(probe));   // 探测报文过协议校验（入站面同口径）
});

test('probeStation：只应答 TCP 的占用者 → 身份取自 pong 的 from', async (t) => {
  const port = await pickFreePort();
  await startTcpResponder(t, { port, peer: OTHER });
  const evidence = await probeStation({ port, probeTimeoutMs: 300, warn: quietWarn });
  assert.equal(evidence.station, true);
  assert.deepEqual(evidence.peer, OTHER);
});

test('probeStation：静默占用者 → 无驿站证据（身份为空）', async (t) => {
  const port = await pickFreePort();
  await startSilentSquatter(t, port);
  const evidence = await probeStation({ port, probeTimeoutMs: PROBE_TIMEOUT_MS, warn: quietWarn });
  assert.deepEqual(evidence, { station: false, peer: null });
});

test('probeStation：pong 缺 from 的应答仍算驿站证据（身份为空的宽容口径）', async (t) => {
  const port = await pickFreePort();
  await startTcpResponder(t, { port, peer: null });
  const evidence = await probeStation({ port, probeTimeoutMs: 300, warn: quietWarn });
  assert.deepEqual(evidence, { station: true, peer: null });
});

test('探测原语：过不了协议校验的 probe-ack 不构成证据（外部输入基线）', async (t) => {
  const port = await pickFreePort();
  await startInvalidAckResponder(t, { port });
  assert.deepEqual(
    await probeStation({ port, probeTimeoutMs: PROBE_TIMEOUT_MS, warn: quietWarn }),
    { station: false, peer: null },
  );
  const found = await probeSegmentStations({ segmentBase: port, count: 1, probeTimeoutMs: PROBE_TIMEOUT_MS, warn: quietWarn });
  assert.deepEqual(found, []);
});

test('probeSegmentStations：全段扫描收齐段内应答者（含目标端口之外的端口）', async (t) => {
  const base = await pickFreeSegment();
  const probes = [];
  await startUdpResponder(t, { port: base + 2, peer: OWN, probes });
  await startUdpResponder(t, { port: base + 5, peer: OTHER });
  const found = await probeSegmentStations({ segmentBase: base, count: 8, probeTimeoutMs: 300, warn: quietWarn });
  assert.ok(found.some((hit) => hit.port === base + 2 && isSameRootPeer(hit.peer, OWN)), JSON.stringify(found));
  assert.ok(found.some((hit) => hit.port === base + 5 && isSameRootPeer(hit.peer, OTHER)), JSON.stringify(found));
  for (const hit of found) {
    assert.ok(hit.port >= base && hit.port <= base + 7, JSON.stringify(hit));
  }
  const probe = await waitFor(() => probes[0] ?? null, { timeoutMs: 3000 });
  assert.equal(validateProbe(probe).ok, true, JSON.stringify(probe));
});

/* 全静默段的验收口径：新取的段基窗口仍可能被并行的伪驿站夹具落进——换新段基重试；
 * 重试仍有应答者才交断言判红（确定性缺陷不被掩盖）。 */
test('probeSegmentStations：全段静默 → 空结果（单窗口结算，不抛出）', async () => {
  let found = [];
  for (let round = 0; round < 4; round++) {
    const base = await pickFreeSegment();
    found = await probeSegmentStations({ segmentBase: base, count: 8, probeTimeoutMs: PROBE_TIMEOUT_MS, warn: quietWarn });
    if (found.length === 0) {
      return;
    }
  }
  assert.deepEqual(found, []);
});

test('isSameRootPeer：instanceId 吻合即同根；identityName 只作呈现、不单独构成命中', () => {
  assert.equal(isSameRootPeer(OWN, OWN), true);
  assert.equal(isSameRootPeer({ ...OWN, instanceId: 'other' }, OWN), false, '跨根同名（身份名相同、instanceId 不同）：不得判同根');
  assert.equal(isSameRootPeer({ ...OWN, identityName: '改过名' }, OWN), true, '身份名被改过的同根旧站点：instanceId 吻合即命中');
  assert.equal(isSameRootPeer(null, OWN), false);
  assert.equal(isSameRootPeer(OWN, null), false);
});

test('isSameRootSessionEntry：身份锚 instanceId + 旧形态 + 新鲜（陈旧窗口内）才算命中', () => {
  const now = Date.now();
  const entry = (patch) => ({ instanceId: OWN.instanceId, identityName: OWN.identityName, site: { mode: 'slot', slot: 1 }, updatedAt: new Date(now - 1000).toISOString(), ...patch });
  const check = (value) => isSameRootSessionEntry(value, { instanceId: OWN.instanceId, now });
  assert.equal(check(entry({})), true);
  assert.equal(check(entry({ site: { mode: 'explicit', slot: null } })), true);
  assert.equal(check(entry({ site: null })), true, '报错降级的旧站点写 site:null 且照常刷盘：同属旧形态（第二道防线的动机场景）');
  assert.equal(check(entry({ site: { mode: 'single', slot: null } })), false, '新核自己的写入（site.mode=single）不构成命中');
  assert.equal(check(entry({ site: 'slot' })), false, 'site 形态不合（非对象非 null）：不采信');
  assert.equal(check(entry({ updatedAt: new Date(now - 21000).toISOString() })), false, '陈旧条目不是活跃写者');
  assert.equal(check(entry({ instanceId: 'other-root' })), false, '跨根同名（身份名相同、instanceId 不同）：不得命中');
  assert.equal(check(entry({ identityName: '改过名' })), true, '身份名被改过的同根旧站点：instanceId 吻合即命中');
  assert.equal(check(entry({ updatedAt: 'not-a-time' })), false, '时间戳缺失或非法按不新鲜处理');
  assert.equal(check(null), false);
  assert.equal(check([entry({})]), false);
});

test('同根判据的 fail-open 守卫：锚缺失一律不命中（null 表征无身份；undefined 不得放行）', () => {
  const now = Date.now();
  const entry = { instanceId: OWN.instanceId, identityName: OWN.identityName, site: { mode: 'slot', slot: 1 }, updatedAt: new Date(now - 1000).toISOString() };
  assert.equal(isSameRootPeer({}, {}), false, '两侧同缺 instanceId：不得判同根');
  assert.equal(isSameRootPeer({ identityName: 'x' }, { instanceId: undefined, identityName: 'x' }), false);
  assert.equal(isSameRootSessionEntry(entry, { instanceId: null, now }), false, '无身份（null 锚）：不得命中');
  assert.equal(isSameRootSessionEntry(entry, { instanceId: undefined, now }), false, 'undefined 锚：不得 fail-open');
  assert.equal(isSameRootSessionEntry({ ...entry, instanceId: undefined }, { instanceId: OWN.instanceId, now }), false, '条目缺 instanceId 字段：不得命中');
});

test('新鲜判据的边界与读取端同口径：恰在陈旧窗口端点算新鲜（`<=`）', () => {
  const now = Date.now();
  const atBoundary = { instanceId: OWN.instanceId, identityName: OWN.identityName, site: { mode: 'slot', slot: 1 }, updatedAt: new Date(now - 20000).toISOString() };
  assert.equal(isSameRootSessionEntry(atBoundary, { instanceId: OWN.instanceId, now }), true, '恰在端点：与状态栏读取端 `<=` 一致');
  assert.equal(isSameRootSessionEntry({ ...atBoundary, updatedAt: new Date(now - 20001).toISOString() }, { instanceId: OWN.instanceId, now }), false);
});

test('探测会话：周期重探复用同一个探针套接字（来源端口恒定，不堆叠旧站点的已知主机条目）', async (t) => {
  const base = await pickFreeSegment();
  const probes = [];
  const sources = [];
  await startUdpResponder(t, { port: base + 1, peer: OWN, probes, sources });
  const session = createProbeSession({ warn: quietWarn });
  try {
    const first = await session.scanSegment({ segmentBase: base, count: 8, probeTimeoutMs: PROBE_TIMEOUT_MS });
    const second = await session.scanSegment({ segmentBase: base, count: 8, probeTimeoutMs: PROBE_TIMEOUT_MS });
    assert.ok(first.some((hit) => hit.port === base + 1), JSON.stringify(first));
    assert.ok(second.some((hit) => hit.port === base + 1), JSON.stringify(second));
    await waitFor(() => sources.length >= 2, { timeoutMs: 3000 });
    assert.equal(new Set(sources).size, 1, `同会话跨轮探测的来源端口应恒定，实际：${JSON.stringify(sources)}`);
  } finally {
    session.close();
  }
});

/* 单会话内的临时端口绑定（测试侧套接字工厂——会话的失败/重试行为面由注入的 factory 构造）。 */
async function bindEphemeralUdp() {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: false });
  try {
    await new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.bind({ port: 0, address: '0.0.0.0', exclusive: true }, resolve);
    });
  } catch (error) {
    closeQuietly(socket);
    throw error;
  }
  return socket;
}

test('探测会话：套接字建立失败按轮复位重建（一次失败不得让端口道整会话失明）', async (t) => {
  const base = await pickFreeSegment();
  await startUdpResponder(t, { port: base + 1, peer: OWN });
  let bindCalls = 0;
  const session = createProbeSession({
    warn: quietWarn,
    bindSocket: async () => {
      bindCalls += 1;
      if (bindCalls === 1) {
        throw new Error('注入的建立失败');
      }
      return bindEphemeralUdp();
    },
  });
  try {
    const failed = await session.scanSegment({ segmentBase: base, count: 8, probeTimeoutMs: PROBE_TIMEOUT_MS });
    assert.deepEqual(failed, [], '建立失败的轮次按无应答处理（本轮无命中）');
    const recovered = await session.scanSegment({ segmentBase: base, count: 8, probeTimeoutMs: PROBE_TIMEOUT_MS });
    assert.ok(recovered.some((hit) => hit.port === base + 1), `下一轮应复位重建并恢复端口道：${JSON.stringify(recovered)}`);
    assert.equal(bindCalls, 2, '复位后恰重建一次');
  } finally {
    session.close();
  }
});

test('findSameRootSessions：只认本根新鲜旧形态条目（跨根同名/陈旧/新形态/损坏一概不采信）', async (t) => {
  const dir = makeTempDir(t);
  const fresh = new Date(Date.now() - 1000).toISOString();
  const stale = new Date(Date.now() - 21000).toISOString();
  writeSessionFile(dir, { sessionId: 'session-own', instanceId: OWN.instanceId, site: { mode: 'slot', slot: 1 }, updatedAt: fresh });
  writeSessionFile(dir, { sessionId: 'session-degraded', instanceId: OWN.instanceId, site: null, updatedAt: fresh });
  writeSessionFile(dir, { sessionId: 'session-other-root', instanceId: 'other-root', identityName: OWN.identityName, site: { mode: 'slot', slot: 1 }, updatedAt: fresh });
  writeSessionFile(dir, { sessionId: 'session-stale', instanceId: OWN.instanceId, site: { mode: 'slot', slot: 1 }, updatedAt: stale });
  writeSessionFile(dir, { sessionId: 'session-new', instanceId: OWN.instanceId, site: { mode: 'single', slot: null }, updatedAt: fresh });
  writeFileSync(sessionFilePath(dir, 'session-corrupt'), '{ 不是 JSON');
  writeFileSync(join(dirname(sessionFilePath(dir, 'session-own')), 'readme.txt'), '非会话文件（sessions/ 下的其它产物）');
  const matched = findSameRootSessions({ mainDir: dir, instanceId: OWN.instanceId });
  assert.deepEqual(matched.map((entry) => entry.sessionId).sort(), ['session-degraded', 'session-own'], JSON.stringify(matched));
});

test('findSameRootSessions：无 sessions 目录 → 空结果（不抛出）', async (t) => {
  const dir = makeTempDir(t);
  assert.deepEqual(findSameRootSessions({ mainDir: dir, instanceId: OWN.instanceId }), []);
});

test('classifyOccupant：端口段命中本根 → 同根（目标端口是别根驿站或无关程序都照样同根）', () => {
  const targetOther = { station: true, peer: OTHER };
  assert.equal(
    classifyOccupant({ own: OWN, target: targetOther, segment: [{ port: 7322, peer: OTHER }, { port: 7323, peer: OWN }] }),
    'same-root',
    '红证形态：只按「目标端口是合法驿站」归类的实现会得 other-station → 降级服务＝与同根旧站点并行双写',
  );
  assert.equal(
    classifyOccupant({ own: OWN, target: { station: false, peer: null }, segment: [{ port: 7324, peer: OWN }] }),
    'same-root',
    '红证形态：只按目标端口分类的实现会得 unrelated → 照常 ready＝并行双写',
  );
});

test('classifyOccupant：数据面命中本根 → 同根（端口面无任何证据）', () => {
  assert.equal(
    classifyOccupant({ own: OWN, target: { station: false, peer: null }, sessions: [{ sessionId: 's' }] }),
    'same-root',
    '红证形态：只看端口的实现会得 unrelated → 照常 ready＝与降级运行的旧站点并行双写',
  );
});

test('classifyOccupant：本根证据全无时 → 别根驿站 / 无关程序两分；目标端口的本根身份也构成同根', () => {
  assert.equal(classifyOccupant({ own: OWN, target: { station: true, peer: OTHER } }), 'other-station');
  assert.equal(
    classifyOccupant({ own: OWN, target: { station: true, peer: SAME_NAME_OTHER }, segment: [{ port: 7325, peer: SAME_NAME_OTHER }] }),
    'other-station',
    '跨根同名（身份名相同、instanceId 不同）：不得判同根（命中相只看 instanceId）',
  );
  assert.equal(classifyOccupant({ own: OWN, target: { station: false, peer: null } }), 'unrelated');
  assert.equal(classifyOccupant({ own: OWN }), 'unrelated');
  assert.equal(classifyOccupant({ own: OWN, target: { station: true, peer: OWN } }), 'same-root', '只应答 TCP 的同根旧站点：端口身份即同根证据');
});

test('同根判别（端到端夹具）：假应答者退场、数据面仍命中 → 仍判同根（迁出条件的完整性）', async (t) => {
  const dir = makeTempDir(t);
  const base = await pickFreeSegment();
  const responder = await startUdpResponder(t, { port: base + 1, peer: OWN });
  writeSessionFile(dir, { sessionId: 'session-live', instanceId: OWN.instanceId, site: { mode: 'slot', slot: 1 }, updatedAt: new Date().toISOString() });
  const sessions = findSameRootSessions({ mainDir: dir, instanceId: OWN.instanceId });
  const occupied = await probeSegmentStations({ segmentBase: base, count: 8, probeTimeoutMs: PROBE_TIMEOUT_MS, warn: quietWarn });
  assert.equal(sessions.length, 1, JSON.stringify(sessions));
  assert.ok(occupied.some((hit) => hit.port === base + 1 && isSameRootPeer(hit.peer, OWN)), JSON.stringify(occupied));
  assert.equal(classifyOccupant({ own: OWN, target: null, segment: occupied, sessions }), 'same-root', '两道任一命中即同根');
  responder.close();
  await waitForRebindable(base + 1);
  const after = await probeSegmentStations({ segmentBase: base, count: 8, probeTimeoutMs: PROBE_TIMEOUT_MS, warn: quietWarn });
  assert.ok(!after.some((hit) => isSameRootPeer(hit.peer, OWN)), '假应答者退场后端口面不再命中本根');
  assert.equal(
    classifyOccupant({ own: OWN, target: null, segment: after, sessions }),
    'same-root',
    '数据面仍命中：不得判可服务（只看端口的实现会迁出＝并行双写）',
  );
});

/* ── 接线段：核心进程内起的 waiting 驻留/迁出与 ①② 降级服务 ─────────────────────────────
 * 夹具＝临时数据根（显式根：WAYSTATION_HOME＋config.json 显式端口）＋预置 instance-id（同根旧站点
 * 在跑时该文件必已存在——身份锚取自它）＋假应答者/静默占位者。注入缝经 env 传入（NODE_TEST_CONTEXT
 * 是生效闸）：周期重试与探测预算取短值，测试窗口内可见多次重试。 */

const CORE_PEER = { instanceId: 'core-instance-aaaa', identityName: 'lanfeng-core' };

/* 核心数据根：临时根＋显式端口配置＋预置实例标识。 */
function makeCoreRoot(t, port) {
  const root = makeTempDir(t);
  writeFileSync(join(root, CONFIG_FILE_NAME), JSON.stringify({ port, identityName: CORE_PEER.identityName }));
  writeFileSync(join(root, INSTANCE_ID_FILE), `${CORE_PEER.instanceId}\n`);
  return root;
}

/* 核心环境：显式根＋注入缝。段基缝（WAYSTATION_TEST_ANCHOR_PORT）必注入——同根探测的段扫与端口解析
 * 的锚点同源（核心的 detector.segmentBase = 注入锚点）：不注入＝每轮重探真实站点段 7321–7328，
 * 会给本机在跑的真站写入探针来源（端口纪律面）。段基取段外空闲八连段；同根探测与周期重试按短值结算。 */
function coreEnvOf(root, segmentBase, extra = {}) {
  return {
    ...process.env,
    WAYSTATION_HOME: root,
    NODE_TEST_CONTEXT: '1',
    WAYSTATION_TEST_ANCHOR_PORT: String(segmentBase),
    WAYSTATION_TEST_PORT_RETRY_MS: '150',
    WAYSTATION_TEST_PORT_PROBE_TIMEOUT_MS: '100',
    WAYSTATION_TEST_HEARTBEAT_MS: '200',
    ...extra,
  };
}

function readCoreJson(root) {
  return JSON.parse(readFileSync(coreJsonPath(root), 'utf8'));
}

/* 数据面快照（run/ 豁免面除外）：相对路径 → 「目录」或「大小:mtimeMs」——零写断言的比对面。 */
function dataPlaneSnapshot(root) {
  const entries = new Map();
  const walk = (dir, rel) => {
    for (const dirent of readdirSync(dir, { withFileTypes: true })) {
      if (dirent.name === RUN_DIR_NAME) {
        continue;   // run/ 是等待接管态的豁免面（core.json 心跳与凭据必需）
      }
      const childRel = rel === '' ? dirent.name : `${rel}/${dirent.name}`;
      const child = join(dir, dirent.name);
      if (dirent.isDirectory()) {
        entries.set(`${childRel}/`, 'dir');
        walk(child, childRel);
      } else {
        const info = statSync(child);
        entries.set(childRel, `${info.size}:${info.mtimeMs}`);
      }
    }
  };
  walk(root, '');
  return entries;
}

/* 只占 TCP 端口的无关程序：这是组件的危险形态——UDP 半绑定会成功、TCP 半失败，组件「同生共死」
 * 撤下监听，此后 start 恒 components-closed（恢复途径＝重建组件，组合根职责）。 */
async function startTcpOnlySquatter(t, port) {
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
  });
  t.after(() => closeQuietly(server));
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ port, host: '0.0.0.0' }, resolve);
    });
  } catch (error) {
    closeQuietly(server);
    throw error;
  }
  return server;
}

test('同根（端口道）→ 驻留 waiting：数据面零写、不服务、指引在 statusDetail；旧站退场 → 自动迁出 ready', { timeout: 30000 }, async (t) => {
  const port = await pickFreePort();
  const root = makeCoreRoot(t, port);
  const responder = await startUdpResponder(t, { port, peer: CORE_PEER });
  const before = dataPlaneSnapshot(root);
  const started = await startCore({ env: coreEnvOf(root, await pickFreeSegment()) });
  t.after(() => started.core.stop());
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(started.core.status(), 'waiting', '同根命中：驻留等待接管态');
  assert.equal(started.core.net, null, 'waiting 不建组件（自检/身份/注册表/IPC 全不执行＝零写落点）');
  const waiting = readCoreJson(root);
  assert.equal(waiting.status, 'waiting');
  assert.equal('startupDeadline' in waiting, false, 'waiting 无启动截止期（僵尸判定由心跳承担）');
  assert.ok(String(waiting.statusDetail).includes('请先关闭'), waiting.statusDetail);
  assert.deepEqual(dataPlaneSnapshot(root), before, '等待接管态数据面零写（除 run/ 豁免面外一律无写）');
  const beat = waiting.heartbeatAt;
  await waitFor(() => readCoreJson(root).heartbeatAt !== beat, { timeoutMs: 5000 });   // waiting 期心跳照刷
  responder.close();
  await waitForRebindable(port);
  await waitFor(() => readCoreJson(root).status === 'ready', { timeoutMs: 15000 });
  assert.equal(readCoreJson(root).statusDetail, undefined, '迁出后不残留 waiting 文案');
  const evidence = await probeStation({ port, probeTimeoutMs: 300, warn: quietWarn });
  assert.equal(evidence.station, true, '迁出后核心接管端口（LAN 起）');
  assert.equal(evidence.peer?.instanceId, CORE_PEER.instanceId, '端口上的应答者就是本核');
});

test('同根（数据面：旧站点不持任何端口）→ waiting；会话文件消失 → 迁出 ready', { timeout: 30000 }, async (t) => {
  const port = await pickFreePort();
  const root = makeCoreRoot(t, port);
  writeSessionFile(root, { sessionId: 'session-old', instanceId: CORE_PEER.instanceId, site: { mode: 'slot', slot: 1 }, updatedAt: new Date().toISOString() });
  const started = await startCore({ env: coreEnvOf(root, await pickFreeSegment()) });
  t.after(() => started.core.stop());
  assert.equal(started.core.status(), 'waiting', '端口全空、仅数据面命中：第二道防线生效');
  assert.ok(String(readCoreJson(root).statusDetail).includes('pid 4242'), `数据面条目带 pid：${readCoreJson(root).statusDetail}`);
  rmSync(sessionFilePath(root, 'session-old'));
  await waitFor(() => readCoreJson(root).status === 'ready', { timeoutMs: 15000 });
  assert.equal(started.core.net.status().available, true, '迁出后 LAN 正常起');
});

test('迁出前重验锁：等待期被顶替 → 失锁即退（不迁出、继任者记录原样）', { timeout: 30000 }, async (t) => {
  const port = await pickFreePort();
  const root = makeCoreRoot(t, port);
  const responder = await startUdpResponder(t, { port, peer: CORE_PEER });
  const started = await startCore({ env: coreEnvOf(root, await pickFreeSegment(), { WAYSTATION_TEST_HEARTBEAT_MS: '60000' }) });
  t.after(() => started.core.stop());
  assert.equal(started.core.status(), 'waiting');
  const impostor = {
    v: 1, ipcV: 1, appVersion: '0.0.1', pid: 999999, endpoint: 'placeholder', token: 'impostor-token',
    identity: null, port, startedAt: new Date().toISOString(), status: 'starting',
    startupDeadline: new Date().toISOString(), heartbeatAt: new Date().toISOString(),
  };
  writeFileSync(coreJsonPath(root), JSON.stringify(impostor));   // 构造「被顶替」
  responder.close();
  await waitForRebindable(port);
  assert.equal(await started.core.whenExited(), 0, '失锁即退：让位退出 0');
  assert.deepEqual(readCoreJson(root), impostor, '继任者的运行描述符不得被改写或删除');
});

test('① 无关程序占用端口 → 降级服务（ready＋指引）；占用者退场 → 自动接管（net 恢复、文案清除）', { timeout: 30000 }, async (t) => {
  const port = await pickFreePort();
  const root = makeCoreRoot(t, port);
  const squatter = await startSilentSquatter(t, port);
  /* 本用例的前提是「发现层 UDP 端口被占」：发现隔离开关会让发现层根本不绑定套接字，
   * 占用因此不成立（核心会正常 ready）。临时关闭该开关；锚点段取空闲段，不触达真实站点段。 */
  const savedDiscoveryFlag = process.env[DISCOVERY_DISABLE_ENV];
  delete process.env[DISCOVERY_DISABLE_ENV];
  t.after(() => {
    if (savedDiscoveryFlag === undefined) {
      delete process.env[DISCOVERY_DISABLE_ENV];
    } else {
      process.env[DISCOVERY_DISABLE_ENV] = savedDiscoveryFlag;
    }
  });
  const started = await startCore({ env: coreEnvOf(root, await pickFreeSegment()) });
  t.after(() => started.core.stop());
  assert.equal(started.core.status(), 'ready', '①② 降级服务：核心照常 ready，本地工具照常');
  assert.equal(started.core.net.status().available, false, 'LAN 面不可用（degraded）');
  const degraded = readCoreJson(root);
  assert.ok(String(degraded.statusDetail).includes('无关程序'), degraded.statusDetail);
  assert.ok(String(degraded.statusDetail).includes('自动接管'), degraded.statusDetail);
  squatter.close();
  await waitForRebindable(port);
  await waitFor(() => started.core.net.status().available === true, { timeoutMs: 15000 });
  assert.equal(readCoreJson(root).statusDetail, undefined, '占用者退场后自动接管：降级文案清除（无状态迁移）');
  const evidence = await probeStation({ port, probeTimeoutMs: 300, warn: quietWarn });
  assert.equal(evidence.peer?.instanceId, CORE_PEER.instanceId, '接管后端口上的应答者就是本核');
});

test('迁出判定（裁定支路）：同根证据消失而端口被无关程序占 → 降级服务，不卡 waiting；占用者退场 → 重建组件后接管', { timeout: 40000 }, async (t) => {
  const port = await pickFreePort();
  const root = makeCoreRoot(t, port);
  writeSessionFile(root, { sessionId: 'session-old', instanceId: CORE_PEER.instanceId, site: null, updatedAt: new Date().toISOString() });
  const squatter = await startTcpOnlySquatter(t, port);   // 只占 TCP：占用者自始在场，退场时点完全可控
  const started = await startCore({ env: coreEnvOf(root, await pickFreeSegment()) });
  t.after(() => started.core.stop());
  assert.equal(started.core.status(), 'waiting', '驻留判定只看两道证据（端口被占不妨碍进 waiting）');
  rmSync(sessionFilePath(root, 'session-old'));
  await waitFor(() => readCoreJson(root).status === 'ready', { timeoutMs: 15000 });
  assert.equal(started.core.net.status().available, false, '证据消失但端口被占：走 ①② 降级服务（不卡 waiting、不硬等）');
  assert.ok(String(readCoreJson(root).statusDetail).includes('占用'), readCoreJson(root).statusDetail);
  squatter.close();
  await waitForRebindable(port);
  await waitFor(() => started.core.net.status().available === true, { timeoutMs: 20000 });
  assert.equal(readCoreJson(root).statusDetail, undefined, '占用者退场：组件重建后接管成功（免重启恢复）');
});

test('段基缝核对：同根旧站点顺延在段内别端口（不在目标端口）→ 仍进 waiting（全段探测）', { timeout: 30000 }, async (t) => {
  const port = await pickFreePort();   // 核心端口：空着（同根证据只可能来自段内别端口的扫描）
  const root = makeCoreRoot(t, port);
  const base = await pickFreeSegment();
  const responder = await startUdpResponder(t, { port: base + 3, peer: CORE_PEER });
  const started = await startCore({ env: coreEnvOf(root, base) });
  t.after(() => started.core.stop());
  assert.equal(started.core.status(), 'waiting', '全段探测命中本根身份：核心不得进 ready');
  assert.ok(String(readCoreJson(root).statusDetail).includes('请先关闭'), readCoreJson(root).statusDetail);
  responder.close();
});

test('waiting 寿命上界（注入短值）→ 自行退出 0 并删运行描述符（对证）', { timeout: 30000 }, async (t) => {
  const port = await pickFreePort();
  const root = makeCoreRoot(t, port);
  const responder = await startUdpResponder(t, { port, peer: CORE_PEER });
  const started = await startCore({ env: coreEnvOf(root, await pickFreeSegment(), { WAYSTATION_TEST_WAITING_MAX_MS: '400' }) });
  t.after(() => started.core.stop());
  assert.equal(started.core.status(), 'waiting');
  assert.equal(await started.core.whenExited(), 0, '寿命到期：自行退出（退出码 0）');
  assert.equal(existsSync(coreJsonPath(root)), false, '退出前对自己的运行描述符对证后删除');
  responder.close();
});
