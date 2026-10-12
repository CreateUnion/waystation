import dgram from 'node:dgram';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('..', import.meta.url));

// 每个用例独立的临时目录，用例结束自动清理——测试绝不触碰真实 ~/.waystation
export function makeTempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'waystation-test-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** 到期限轮询：等网络 I/O 与定时调度收敛用——固定 sleep 在慢机器上假红、快机器上白等。
 * check 返回真值即返回它；超时抛错（信息含超时值，便于定位假红来源）。
 * 超时抛 Error，消息形如「waitFor 超时（<timeoutMs>ms）：条件未满足」；check 自身抛错立即传播，不重试。 */
export async function waitFor(check, { timeoutMs = 5000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) {
      return value;
    }
    if (Date.now() >= deadline) {
      throw new Error(`waitFor 超时（${timeoutMs}ms）：条件未满足`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** 取一个此刻空闲的高位端口：需要真实监听的测试用（避开默认端口 7321 与系统保留段）。
 * 「关闭探测」与「真正监听」之间有毫秒级窗口，理论上可能被并发测试抢走——
 * 此时测试会以显式 EADDRINUSE 失败，而不是静默错测。 */
export async function pickFreePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen({ port: 0, host: '127.0.0.1' }, resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve) => {
    probe.close(resolve);
  });
  return port;
}

/** 取一段 [base..base+size-1] 八连空闲端口（槽位段测试基准）：逐端口试绑（UDP+TCP 同号）成功后释放；
 * 任一不可绑即整体重取，最多 attempts 次。单端口空闲不等于整段可用——系统临时端口区的其它套接字
 * （以及同工序的探针/回执 socket）随时可能占用段内相邻端口，直接拿 pickFreePort 当段基会造成「槽位号漂移」类假红。 */
export async function pickFreeSegment(size = 8, attempts = 20) {
  for (let round = 0; round < attempts; round++) {
    const base = await pickFreePort();
    if (await isRangeFree(base, size)) {
      return base;
    }
  }
  throw new Error(`pickFreeSegment：连续 ${attempts} 次未取到 ${size} 连空闲端口段（端口环境异常）`);
}

/** 轮询至某端口可重新独占绑定（UDP+TCP 同号）——进程退出到端口可绑实测 1–4ms，固定 sleep 会在慢环境打偏；
 * 超时由 waitFor 抛错（失败响亮，不静默继续）。 */
export async function waitForRebindable(port, { timeoutMs = 3000 } = {}) {
  await waitFor(async () => canBindPort(port), { timeoutMs });
}

/* 端口可独占绑定（UDP+TCP 同号）后立即释放；任一步失败即 false。 */
async function canBindPort(port) {
  const udp = dgram.createSocket({ type: 'udp4', reuseAddr: false });
  const udpOk = await new Promise((resolve) => {
    udp.once('error', () => resolve(false));
    udp.bind({ port, address: '0.0.0.0', exclusive: true }, () => resolve(true));
  });
  try {
    udp.close();
  } catch {
    // 未绑定成功：无需关闭
  }
  if (!udpOk) {
    return false;
  }
  const tcp = createServer();
  const tcpOk = await new Promise((resolve) => {
    tcp.once('error', () => resolve(false));
    tcp.listen({ port, host: '0.0.0.0' }, () => resolve(true));
  });
  if (tcpOk) {
    await new Promise((resolve) => tcp.close(resolve));
  } else {
    try {
      tcp.close();
    } catch {
      // 未监听成功：无需关闭
    }
  }
  return tcpOk;
}

async function isRangeFree(base, size) {
  for (let offset = 0; offset < size; offset++) {
    if (!(await canBindPort(base + offset))) {
      return false;
    }
  }
  return true;
}
