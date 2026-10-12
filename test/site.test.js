import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import net from 'node:net';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ANCHOR_PORT, SLOT_COUNT, slotDefaultPort, resolveSite } from '../src/site.js';
import { CONFIG_FILE_NAME } from '../src/paths.js';
import { PROTOCOL_VERSION, validateProbe } from '../src/net/protocol.js';
import { makeTempDir, pickFreePort, waitFor } from './helpers.js';

test('端口锚点：内置常量与槽位段形状', () => {
  assert.equal(ANCHOR_PORT, 7321);
  assert.equal(SLOT_COUNT, 8);
  assert.equal(slotDefaultPort(1), 7321);
  assert.equal(slotDefaultPort(8), 7328);
});

test('slotDefaultPort：非法槽位抛 TypeError', () => {
  for (const slot of [0, 9, '1', 1.5, null]) {
    assert.throws(() => slotDefaultPort(slot), TypeError, String(slot));
  }
});

const quietWarn = () => {};

/* 端口基准取 pickFreePort（仓库既有约定：随机高位、用完即验）；段内相邻端口不逐一预探——
 * 若被并发测试占用，相关用例以显式失败响亮暴露（EADDRINUSE / 断言不符），不静默。 */

/* 静默占位者：独占绑定 UDP 端口但不作任何应答（无关程序的形态——它与驿站的区别只在「是否应答」）。 */
async function startSilentSquatter(t, port) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: false });
  t.after(() => socket.close());
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.bind({ port, address: '0.0.0.0', exclusive: true }, resolve); });
  return socket;
}

/* 伪驿站占位者：独占绑定 UDP 端口，收到合法 probe 以合法 probe-ack 应答（可注入「应答时携带的端口」）——
 * 与真实驿站的 UDP 证据面一致（先绑 UDP、不建 TCP——正是「UDP 已绑、TCP 未绑」窗口的构造）。 */
async function startStationSquatter(t, { port, identityName = '占位驿站', probes = [] }) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: false });
  t.after(() => socket.close());
  socket.on('message', (buffer, rinfo) => {
    const datagram = JSON.parse(buffer.toString('utf8'));
    probes.push(datagram);
    if (datagram.type !== 'probe') {
      return;
    }
    const ack = Buffer.from(JSON.stringify({ v: PROTOCOL_VERSION, type: 'probe-ack', instanceId: 'squatter-1', identityName, collabCount: 0, port }));
    socket.send(ack, rinfo.port, rinfo.address);
  });
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.bind({ port, address: '0.0.0.0', exclusive: true }, resolve); });
  return socket;
}

/* 只绑 TCP 的伪驿站占位者：接受拨号并对合法 ping 回合法 pong（UDP 面让位）——
 * 「TCP 证据单独成立」路径的行为证据（该路径的定位正是占用者「已绑、回程帧处理器尚未接线」的启动瞬间）。 */
async function startTcpStationSquatter(t, { port }) {
  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => {
      let rest = chunk.toString('utf8');
      let index = rest.indexOf('\n');
      while (index !== -1) {
        const line = rest.slice(0, index);
        rest = rest.slice(index + 1);
        try {
          const frame = JSON.parse(line);
          if (frame !== null && typeof frame === 'object' && frame.type === 'ping') {
            socket.write(JSON.stringify({
              v: PROTOCOL_VERSION,
              type: 'pong',
              msgId: 'pong-1',
              replyTo: frame.msgId,
              from: { instanceId: 'squatter-tcp', identityName: 'TCP占位驿站' },
              ts: new Date().toISOString(),
            }) + '\n');
          }
        } catch {
          // 非协议行忽略（证据导向：只对合法 ping 应答）
        }
        index = rest.indexOf('\n');
      }
    });
    socket.on('error', () => {});
  });
  t.after(() => server.close());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ port, host: '0.0.0.0' }, resolve); });
  return server;
}

test('resolveSite：槽位 1 空闲 → 取槽位 1（主数据目录 + 槽位默认端口）', async (t) => {
  const mainDir = makeTempDir(t);
  const base = await pickFreePort();
  const site = await resolveSite({ env: {}, mainDir, segmentBase: base, warn: quietWarn, probeTimeoutMs: 200 });
  assert.equal(site.ok, true);
  assert.equal(site.mode, 'slot');
  assert.equal(site.slot, 1);
  assert.equal(site.port, base);
  assert.equal(site.dataDir, mainDir);
  assert.equal(site.takeover, false);
  assert.equal(site.writeBackPort, false);
});

test('resolveSite：槽位 1 被驿站占 → 顺延槽位 2（sites/2 目录）', async (t) => {
  const mainDir = makeTempDir(t);
  const base = await pickFreePort();
  await startStationSquatter(t, { port: base });
  const site = await resolveSite({ env: {}, mainDir, segmentBase: base, warn: quietWarn, probeTimeoutMs: 300 });
  assert.equal(site.ok, true);
  assert.equal(site.slot, 2);
  assert.equal(site.port, base + 1);
  assert.equal(site.dataDir, join(mainDir, 'sites', '2'));
});

test('resolveSite：[UDP 已绑、TCP 未绑] 窗口 → UDP 证据即判驿站占用、顺延', async (t) => {
  const mainDir = makeTempDir(t);
  const base = await pickFreePort();
  await startStationSquatter(t, { port: base });   // 只绑 UDP、无 TCP 监听：并发启动的抢占窗口
  const site = await resolveSite({ env: {}, mainDir, segmentBase: base, warn: quietWarn, probeTimeoutMs: 300 });
  assert.equal(site.slot, 2, 'TCP 无应答不得掩盖 UDP 正证');
});

test('resolveSite：槽位 1 被无关程序占 → anchor-taken 报错降级（不递增）', async (t) => {
  const mainDir = makeTempDir(t);
  const base = await pickFreePort();
  await startSilentSquatter(t, base);
  const site = await resolveSite({ env: {}, mainDir, segmentBase: base, warn: quietWarn, probeTimeoutMs: 200 });
  assert.equal(site.ok, false);
  assert.equal(site.reason, 'anchor-taken');
  assert.ok(site.message.includes('不自动递增'));
  assert.ok(site.message.includes(String(base)));
});

test('resolveSite：槽位 k≥2 被无关程序占 → 跳过该槽位', async (t) => {
  const mainDir = makeTempDir(t);
  const base = await pickFreePort();
  await startStationSquatter(t, { port: base });
  await startSilentSquatter(t, base + 1);
  const site = await resolveSite({ env: {}, mainDir, segmentBase: base, warn: quietWarn, probeTimeoutMs: 250 });
  assert.equal(site.ok, true);
  assert.equal(site.slot, 3);
  assert.equal(site.port, base + 2);
});

test('resolveSite：接管槽位被驿站占 → 占则跳（顺延，不报错）', async (t) => {
  const mainDir = makeTempDir(t);
  const base = await pickFreePort();
  writeFileSync(join(mainDir, CONFIG_FILE_NAME), JSON.stringify({ port: base + 5 }));
  await startStationSquatter(t, { port: base + 5 });
  const site = await resolveSite({ env: {}, mainDir, segmentBase: base, warn: quietWarn, probeTimeoutMs: 300 });
  assert.equal(site.ok, true);
  assert.equal(site.slot, 2);
  assert.equal(site.port, base + 1);
});

test('resolveSite：接管槽位被无关程序占 → 同样顺延（接管端口与其它槽位默认端口碰撞的占则跳口径）', async (t) => {
  const mainDir = makeTempDir(t);
  const base = await pickFreePort();
  writeFileSync(join(mainDir, CONFIG_FILE_NAME), JSON.stringify({ port: base + 4 }));
  await startSilentSquatter(t, base + 4);
  const site = await resolveSite({ env: {}, mainDir, segmentBase: base, warn: quietWarn, probeTimeoutMs: 200 });
  assert.equal(site.ok, true);
  assert.equal(site.slot, 2);
});

test('resolveSite：8 个槽位全被驿站占 → segment-exhausted（降级不退出）', async (t) => {
  const mainDir = makeTempDir(t);
  const base = await pickFreePort();
  for (let offset = 0; offset < 8; offset++) {
    await startStationSquatter(t, { port: base + offset });
  }
  const site = await resolveSite({ env: {}, mainDir, segmentBase: base, warn: quietWarn, probeTimeoutMs: 200 });
  assert.equal(site.ok, false);
  assert.equal(site.reason, 'segment-exhausted');
  assert.ok(site.message.includes(`${base}–${base + 7}`));
});

test('resolveSite：显式数据目录 + 显式 port（空闲）→ 固定该端口、无写回', async (t) => {
  const dir = makeTempDir(t);
  const port = await pickFreePort();
  writeFileSync(join(dir, CONFIG_FILE_NAME), JSON.stringify({ port }));
  const site = await resolveSite({ env: { WAYSTATION_HOME: dir }, warn: quietWarn, probeTimeoutMs: 200 });
  assert.equal(site.ok, true);
  assert.equal(site.mode, 'explicit');
  assert.equal(site.slot, null);
  assert.equal(site.port, port);
  assert.equal(site.takeover, true);
  assert.equal(site.writeBackPort, false);
});

test('resolveSite：显式数据目录 + 显式 port 被占 → takeover-taken（不递增、不静默改）', async (t) => {
  const dir = makeTempDir(t);
  const port = await pickFreePort();
  writeFileSync(join(dir, CONFIG_FILE_NAME), JSON.stringify({ port }));
  await startSilentSquatter(t, port);
  const site = await resolveSite({ env: { WAYSTATION_HOME: dir }, warn: quietWarn, probeTimeoutMs: 200 });
  assert.equal(site.ok, false);
  assert.equal(site.reason, 'takeover-taken');
  assert.ok(site.message.includes('不自动改端口'));
});

test('resolveSite：显式数据目录 + 无 port → 取段内最低空闲并标记写回', async (t) => {
  const dir = makeTempDir(t);
  const base = await pickFreePort();
  await startSilentSquatter(t, base);
  const site = await resolveSite({ env: { WAYSTATION_HOME: dir }, segmentBase: base, warn: quietWarn, probeTimeoutMs: 200 });
  assert.equal(site.ok, true);
  assert.equal(site.mode, 'explicit');
  assert.equal(site.port, base + 1);
  assert.equal(site.writeBackPort, true);
});

test('resolveSite：显式数据目录 + 无 port + 段满 → segment-exhausted', async (t) => {
  const dir = makeTempDir(t);
  const base = await pickFreePort();
  for (let offset = 0; offset < 8; offset++) {
    await startSilentSquatter(t, base + offset);
  }
  const site = await resolveSite({ env: { WAYSTATION_HOME: dir }, segmentBase: base, warn: quietWarn, probeTimeoutMs: 200 });
  assert.equal(site.ok, false);
  assert.equal(site.reason, 'segment-exhausted');
});

test('resolveSite：端口值等于槽位默认端口 → 视同未配置（takeover=false，历史默认值不卡顺延）', async (t) => {
  const mainDir = makeTempDir(t);
  const base = await pickFreePort();
  writeFileSync(join(mainDir, CONFIG_FILE_NAME), JSON.stringify({ port: base }));
  const auto = await resolveSite({ env: {}, mainDir, segmentBase: base, warn: quietWarn, probeTimeoutMs: 200 });
  assert.equal(auto.ok, true);
  assert.equal(auto.takeover, false, '等于槽位默认端口 = 未配置');
  writeFileSync(join(mainDir, CONFIG_FILE_NAME), JSON.stringify({ port: base + 5 }));
  const takeover = await resolveSite({ env: {}, mainDir, segmentBase: base, warn: quietWarn, probeTimeoutMs: 200 });
  assert.equal(takeover.ok, true);
  assert.equal(takeover.slot, 1);
  assert.equal(takeover.port, base + 5);
  assert.equal(takeover.takeover, true);
});

test('resolveSite：占用者探测发出的 probe 报文通过协议校验（含身份名白名单）', async (t) => {
  const mainDir = makeTempDir(t);
  const base = await pickFreePort();
  const probes = [];
  await startStationSquatter(t, { port: base, probes });
  await resolveSite({ env: {}, mainDir, segmentBase: base, warn: quietWarn, probeTimeoutMs: 300 });
  const received = await waitFor(() => (probes.length > 0 ? probes[0] : null), { timeoutMs: 3000 });
  assert.equal(validateProbe(received).ok, true, JSON.stringify(received));
  assert.equal(received.type, 'probe');
  assert.match(received.instanceId, /^[0-9a-f-]{36}$/);
});

test('resolveSite：占用者只绑 TCP、UDP 让位 → TCP 证据（合法 pong）判驿站占用、顺延', async (t) => {
  const mainDir = makeTempDir(t);
  const base = await pickFreePort();
  await startTcpStationSquatter(t, { port: base });   // UDP 面让位：UDP 证据必不成立，结论只能来自 TCP 证据
  const site = await resolveSite({ env: {}, mainDir, segmentBase: base, warn: quietWarn, probeTimeoutMs: 400 });
  assert.equal(site.ok, true);
  assert.equal(site.slot, 2, 'TCP 证据单独成立：判驿站占用并顺延（误判无关程序会得到 anchor-taken）');
  assert.equal(site.port, base + 1);
});

test('resolveSite：非 EADDRINUSE 的绑定失败 → bind-failed（立即报错，不落入占用分类）', async (t) => {
  const mainDir = makeTempDir(t);
  /* 触发方式：段基准取 65535（合法边界端口），槽位 2 的默认端口即 65536（越界）——
   * 槽位 1 用驿站占位者占住，使搜索前进到槽位 2，绑定越界端口在 UDP 侧即抛 ERR_SOCKET_BAD_PORT
   * （非 EADDRINUSE），走 bind-error → bind-failed 分支（生产锚点段不会出现越界端口，此为分支专用触发）。 */
  await startStationSquatter(t, { port: 65535 });
  const site = await resolveSite({ env: {}, mainDir, segmentBase: 65535, warn: quietWarn, probeTimeoutMs: 300 });
  assert.equal(site.ok, false);
  assert.equal(site.reason, 'bind-failed');
  assert.ok(site.message.includes('监听失败'), site.message);
});

test('resolveSite：接管槽位被占而顺延 → warn 留痕（显式配置失效不静默）', async (t) => {
  const mainDir = makeTempDir(t);
  const base = await pickFreePort();
  writeFileSync(join(mainDir, CONFIG_FILE_NAME), JSON.stringify({ port: base + 5 }));
  await startStationSquatter(t, { port: base + 5 });
  const warnings = [];
  const site = await resolveSite({
    env: {},
    mainDir,
    segmentBase: base,
    warn: (message) => warnings.push(message),
    probeTimeoutMs: 300,
  });
  assert.equal(site.ok, true);
  assert.equal(site.slot, 2);
  assert.ok(
    warnings.some((message) => message.includes(String(base + 5)) && message.includes('未生效')),
    `接管端口失效必须有 warn 留痕，实际：${JSON.stringify(warnings)}`,
  );
});
