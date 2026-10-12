import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
