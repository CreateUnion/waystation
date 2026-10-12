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
 * check 返回真值即返回它；超时抛错（信息含超时值，便于定位假红来源）。 */
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
