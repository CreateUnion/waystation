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

/* 端口探测候选段与尝试上限（模块私有）：[10000, 20000) 在系统临时端口区（Windows 实测 49152–65535；
 * Linux 默认 32768–60999）之外，且避开 1–1023 保留段与站点槽位段 7321–7328。 */
const PORT_PROBE_MIN = 10000;
const PORT_PROBE_MAX = 20000;
const PORT_PROBE_ATTEMPTS = 30;

/** 取一个此刻空闲的端口：需要真实监听的测试用（避开默认端口 7321、站点槽位段与系统临时端口区）。
 * 为什么不用「绑 0 端口拿系统临时端口」：临时端口分配是机器级顺序游标，并行全量测试下其它进程的
 * 外向连接可在「探测释放 → 用例实际绑定」的窗口内取走该端口——按设计降级（端口被占 → 局域网
 * 不可用）会被误判成用例红。候选段内随机试绑（UDP+TCP 同号，与站点实际占用面一致）；连续失败
 * （候选段被本机服务大面积长占）回退临时端口法兜底。注意「取到即空闲」只对端口本身成立，不蕴含
 * 其邻位保持空闲——依赖邻位空闲的断言须按容差口径写或做守卫式重试（详见 test/site.test.js 头注）。 */
export async function pickFreePort() {
  for (let attempt = 0; attempt < PORT_PROBE_ATTEMPTS; attempt++) {
    const port = PORT_PROBE_MIN + Math.floor(Math.random() * (PORT_PROBE_MAX - PORT_PROBE_MIN));
    if (await canBindPort(port)) {
      return port;
    }
  }
  return pickEphemeralPort();
}

/* 回退路径：绑 0 端口取系统临时端口（旧法）。候选段整体不可用时沿用——探测窗口竞态可能重现，
 * 只作可用性兜底；用例侧的守卫式重试（site.test.js）覆盖此残余。 */
async function pickEphemeralPort() {
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
    if (base + size - 1 > 65535) {
      continue;   // 段尾越界（游标贴近动态端口范围顶端）：不试绑——越界端口会让 bind 同步抛错
    }
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
