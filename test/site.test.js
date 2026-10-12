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

/* 段基与邻位端口的实测事实：Windows 的临时端口分配是**机器级顺序游标**——pickFreePort() 取走游标位
 * base 后，base+1、base+2… 就是接下来会发给任何进程的端口（本机实测：出站连接、外部设备的长连接
 * 都会落进 base 的邻位）。故「base 取到即空闲」不蕴含「base 的邻位在整个用例窗口内保持空闲」，
 * 用例按三类写法消化该环境噪音（不放松任何行为不变式）：
 * ① 顺延类断言按容差口径：ok + 槽号下限 + 「port = 段基 + 槽号 - 1」「dataDir = sites/<槽号>」自洽——
 *    槽位不可取得即跳过是设计行为，锁死具体槽号会把正确行为判红；
 * ② 结果形态可被环境噪音伪造的用例用 withSegmentBase 的 accept 口径守卫：setup 绑定撞外部占用者、
 *    或结果落成 segment-exhausted / 未命中最低空闲（段基窗口被外部分配整段吞掉）→ 换段基重跑；
 *    重试仍不通过才交断言判红（确定性缺陷不被掩盖）；
 * ③ 段满类 setup 同样走 withSegmentBase：绑定撞上外部占用者（EADDRINUSE）即按环境碰撞整段重来。
 * 占 base 自身的 setup 不需守卫：游标取走 base 后已越过它，外部分配落在 base 的邻位而非 base。
 * 生产不受影响：真实槽位段 7321–7328 在动态端口范围（本机实测 49152–65535）之外。 */

/* 句柄静默关闭：未绑定成功 / 已关闭的句柄再关会抛（ERR_SOCKET_DGRAM_NOT_RUNNING / ERR_SERVER_NOT_RUNNING）——
 * 环境碰撞重试会先收摊再重来，收尾路径不得因二次关闭把用例判红。 */
function closeQuietly(handle) {
  try {
    handle.close();
  } catch {
    // 未绑定成功或已关闭：无需再关
  }
}

/* 环境碰撞判定：setup 绑定撞上外部占用者（机器级游标把外部分配送进段基窗口）——换段基重来即可；
 * 其余错误（含断言失败）一律原样抛出，不掩盖实现缺陷。 */
function isEnvironmentCollision(error) {
  return error.code === 'EADDRINUSE';
}

/* 换段基重跑整个组合步骤：run(base) 的 setup 撞上外部占用者（EADDRINUSE）即判环境碰撞重来；
 * accept(result) 为假时同样换新段基重跑（用于结果形态可被环境噪音伪造的用例）。重试仍不通过才把
 * 最后一次结果交回——断言照常判红，确定性缺陷不被掩盖；全轮次都是碰撞则按响亮错误抛出。 */
async function withSegmentBase(run, { rounds = 4, accept = () => true } = {}) {
  let outcome = null;
  for (let round = 0; round < rounds; round++) {
    const base = await pickFreePort();
    try {
      outcome = await run(base);
    } catch (error) {
      if (!isEnvironmentCollision(error)) {
        throw error;
      }
      continue;
    }
    await new Promise((resolve) => setImmediate(resolve));   // 先派发挂起的探测回执事件，验收判定（归因）才看得到
    if (accept(outcome)) {
      return outcome;
    }
  }
  if (outcome === null) {
    throw new Error(`withSegmentBase：连续 ${rounds} 轮段基窗口被外部占用者碰撞（端口环境异常）`);
  }
  return outcome;
}

/* 顺延类用例的验收口径：ok 即通过；以下失败判为环境噪音、换段基重跑——
 * ① segment-exhausted：段基窗口被外部分配整段吞掉；
 * ② anchor-taken 且占位者确实收到过探测：回执丢失/迟到（负载下判定预算内的调度抖动），非实现问题。
 * 未收到探测的 anchor-taken、bind-failed 等与实现缺陷同形，不重试（照常交断言判红）。 */
function acceptsDeferredResolution(outcome) {
  if (outcome.site.ok === true) {
    return true;
  }
  if (outcome.site.reason === 'segment-exhausted') {
    return true;
  }
  return outcome.site.reason === 'anchor-taken' && (outcome.probes?.length ?? 0) > 0;
}

/* 「段内最低空闲」用例的验收口径：命中「跳过被占的 base、取 base+1」才通过——base+1 是游标下一位、
 * 随时可能被外部占用者占住（未命中即换段基重跑；占用者可能在事后归因前就消失，故不做归因）。
 * 重试仍不命中才交断言判红：确定性缺陷（每次都取错）必然被判红。 */
function pickedLowestFree(outcome) {
  return outcome.site.ok === true && outcome.site.port === outcome.base + 1;
}

/* 静默占位者：独占绑定 UDP 端口但不作任何应答（无关程序的形态——它与驿站的区别只在「是否应答」）。 */
async function startSilentSquatter(t, port) {
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

/* 伪驿站占位者：独占绑定 UDP 端口，收到合法 probe 以合法 probe-ack 应答（可注入「应答时携带的端口」）——
 * 与真实驿站的 UDP 证据面一致（先绑 UDP、不建 TCP——正是「UDP 已绑、TCP 未绑」窗口的构造）。 */
async function startStationSquatter(t, { port, identityName = '占位驿站', probes = [] }) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: false });
  t.after(() => closeQuietly(socket));
  socket.on('message', (buffer, rinfo) => {
    const datagram = JSON.parse(buffer.toString('utf8'));
    probes.push(datagram);
    if (datagram.type !== 'probe') {
      return;
    }
    const ack = Buffer.from(JSON.stringify({ v: PROTOCOL_VERSION, type: 'probe-ack', instanceId: 'squatter-1', identityName, collabCount: 0, port }));
    socket.send(ack, rinfo.port, rinfo.address);
  });
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

test('resolveSite：槽位 1 被驿站占 → 顺延下一空闲槽位（sites/<槽号> 目录）', async (t) => {
  const mainDir = makeTempDir(t);
  const { base, site } = await withSegmentBase(async (base) => {
    const probes = [];
    await startStationSquatter(t, { port: base, probes });
    return { base, probes, site: await resolveSite({ env: {}, mainDir, segmentBase: base, warn: quietWarn, probeTimeoutMs: 600 }) };
  }, { accept: acceptsDeferredResolution });
  assert.equal(site.ok, true);
  assert.ok(site.slot >= 2, '槽位 1 在用（合法驿站应答）：必须顺延');
  assert.equal(site.port, base + site.slot - 1);
  assert.equal(site.dataDir, join(mainDir, 'sites', String(site.slot)));
});

test('resolveSite：[UDP 已绑、TCP 未绑] 窗口 → UDP 证据即判驿站占用、顺延', async (t) => {
  const mainDir = makeTempDir(t);
  const { base, site } = await withSegmentBase(async (base) => {
    const probes = [];
    await startStationSquatter(t, { port: base, probes });   // 只绑 UDP、无 TCP 监听：并发启动的抢占窗口
    return { base, probes, site: await resolveSite({ env: {}, mainDir, segmentBase: base, warn: quietWarn, probeTimeoutMs: 600 }) };
  }, { accept: acceptsDeferredResolution });
  assert.equal(site.ok, true, 'UDP 证据未被采信会得到 anchor-taken（槽位 1 判无关程序）');
  assert.ok(site.slot >= 2, 'TCP 无应答不得掩盖 UDP 正证');
  assert.equal(site.port, base + site.slot - 1);
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
  const { base, site } = await withSegmentBase(async (base) => {
    const probes = [];
    await startStationSquatter(t, { port: base, probes });
    await startSilentSquatter(t, base + 1);
    return { base, probes, site: await resolveSite({ env: {}, mainDir, segmentBase: base, warn: quietWarn, probeTimeoutMs: 600 }) };
  }, { accept: acceptsDeferredResolution });
  assert.equal(site.ok, true);
  assert.ok(site.slot >= 3, '槽位 1（驿站）与槽位 2（无关程序）都不可取得：必须继续顺延');
  assert.equal(site.port, base + site.slot - 1);
});

test('resolveSite：接管槽位被驿站占 → 占则跳（顺延，不报错）', async (t) => {
  const mainDir = makeTempDir(t);
  const { base, site } = await withSegmentBase(async (base) => {
    writeFileSync(join(mainDir, CONFIG_FILE_NAME), JSON.stringify({ port: base + 5 }));
    await startStationSquatter(t, { port: base + 5 });
    return { base, site: await resolveSite({ env: {}, mainDir, segmentBase: base, warn: quietWarn, probeTimeoutMs: 600 }) };
  }, { accept: acceptsDeferredResolution });
  assert.equal(site.ok, true);
  assert.ok(site.slot >= 2, '接管槽位（显式端口）被占：占则跳——顺延、不报错');
  assert.equal(site.port, base + site.slot - 1);
});

test('resolveSite：接管槽位被无关程序占 → 同样顺延（接管端口与其它槽位默认端口碰撞的占则跳口径）', async (t) => {
  const mainDir = makeTempDir(t);
  const warnings = [];
  const { base, site } = await withSegmentBase(async (base) => {
    writeFileSync(join(mainDir, CONFIG_FILE_NAME), JSON.stringify({ port: base + 4 }));
    await startSilentSquatter(t, base + 4);
    return {
      base,
      site: await resolveSite({ env: {}, mainDir, segmentBase: base, warn: (message) => warnings.push(message), probeTimeoutMs: 200 }),
    };
  }, { accept: acceptsDeferredResolution });
  assert.equal(site.ok, true);
  assert.ok(site.slot >= 2, '接管槽位（显式端口）被占：占则跳——顺延、不报错');
  assert.equal(site.port, base + site.slot - 1);
  /* 判别主锚点取 warn 内容：该路径必发「显式配置失效」留痕（比槽号更强，且免于邻位端口噪音）。 */
  assert.ok(
    warnings.some((message) => message.includes(String(base + 4)) && message.includes('未生效')),
    `接管端口失效必须有 warn 留痕，实际：${JSON.stringify(warnings)}`,
  );
});

test('resolveSite：8 个槽位全被驿站占 → segment-exhausted（降级不退出）', async (t) => {
  const mainDir = makeTempDir(t);
  const { base, site } = await withSegmentBase(async (base) => {
    for (let offset = 0; offset < SLOT_COUNT; offset++) {
      await startStationSquatter(t, { port: base + offset });
    }
    return { base, site: await resolveSite({ env: {}, mainDir, segmentBase: base, warn: quietWarn, probeTimeoutMs: 200 }) };
  });
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
  const { base, site } = await withSegmentBase(async (base) => {
    await startSilentSquatter(t, base);
    return { base, site: await resolveSite({ env: { WAYSTATION_HOME: dir }, segmentBase: base, warn: quietWarn, probeTimeoutMs: 200 }) };
  }, { accept: pickedLowestFree });
  assert.equal(site.ok, true);
  assert.equal(site.mode, 'explicit');
  assert.equal(site.port, base + 1, '段内最低空闲：base 被占、应取 base+1');
  assert.equal(site.writeBackPort, true);
});

test('resolveSite：显式数据目录 + 无 port + 段满 → segment-exhausted', async (t) => {
  const dir = makeTempDir(t);
  const { site } = await withSegmentBase(async (base) => {
    for (let offset = 0; offset < SLOT_COUNT; offset++) {
      await startSilentSquatter(t, base + offset);
    }
    return { base, site: await resolveSite({ env: { WAYSTATION_HOME: dir }, segmentBase: base, warn: quietWarn, probeTimeoutMs: 200 }) };
  });
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
  /* 接管端口另取一次 pickFreePort：自持且已被游标越过（外部分配落在它的邻位，不会再落到它自己），
   * 与段基窗口无关——避免把「取段内最低空闲」的邻居噪音混进该用例。 */
  const takeoverPort = await pickFreePort();
  writeFileSync(join(mainDir, CONFIG_FILE_NAME), JSON.stringify({ port: takeoverPort }));
  const takeover = await resolveSite({ env: {}, mainDir, segmentBase: base, warn: quietWarn, probeTimeoutMs: 200 });
  assert.equal(takeover.ok, true);
  assert.equal(takeover.slot, 1);
  assert.equal(takeover.port, takeoverPort);
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
  const { base, site } = await withSegmentBase(async (base) => {
    await startTcpStationSquatter(t, { port: base });   // UDP 面让位：UDP 证据必不成立，结论只能来自 TCP 证据
    return { base, site: await resolveSite({ env: {}, mainDir, segmentBase: base, warn: quietWarn, probeTimeoutMs: 600 }) };
  }, { accept: acceptsDeferredResolution });
  assert.equal(site.ok, true, 'TCP 证据未被采信会得到 anchor-taken（槽位 1 判无关程序）');
  assert.ok(site.slot >= 2, 'TCP 证据单独成立：判驿站占用并顺延');
  assert.equal(site.port, base + site.slot - 1);
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
  const warnings = [];
  const { base, site } = await withSegmentBase(async (base) => {
    writeFileSync(join(mainDir, CONFIG_FILE_NAME), JSON.stringify({ port: base + 5 }));
    await startStationSquatter(t, { port: base + 5 });
    return {
      base,
      site: await resolveSite({ env: {}, mainDir, segmentBase: base, warn: (message) => warnings.push(message), probeTimeoutMs: 600 }),
    };
  }, { accept: acceptsDeferredResolution });
  assert.equal(site.ok, true);
  assert.ok(site.slot >= 2, '接管端口被占：该站点按槽位搜索顺延');
  assert.equal(site.port, base + site.slot - 1);
  assert.ok(
    warnings.some((message) => message.includes(String(base + 5)) && message.includes('未生效')),
    `接管端口失效必须有 warn 留痕，实际：${JSON.stringify(warnings)}`,
  );
});
