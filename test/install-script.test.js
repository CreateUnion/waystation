import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir, repoRoot } from './helpers.js';

/* bash 探测：Windows 走 git-bash、Linux 天然可用；不可用则用例跳过（.ps1 臂由主控在真机上跑）。
 * 脚本经 HOME 指向临时目录 + dry-run 运行——只读检测与打印，不触碰真实家目录。 */
const bashProbe = spawnSync('bash', ['-c', 'exit 0']);
const bashAvailable = bashProbe.error === undefined && bashProbe.status === 0;

function runInstallScript(t, args) {
  const home = makeTempDir(t);
  const result = spawnSync('bash', [join(repoRoot, 'scripts', 'install.sh'), ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, HOME: home.replace(/\\/g, '/') },
  });
  return { home, result };
}

test('安装脚本 --dry-run：打印斜杠命令步骤、HOME 下零写入', (t) => {
  if (!bashAvailable) {
    t.skip('bash 不可用（Windows 需 git-bash；.ps1 臂由主控真机验证）');
    return;
  }
  const { home, result } = runInstallScript(t, ['--dry-run']);
  assert.equal(result.status, 0, `退出码非 0；stderr：${result.stderr}`);
  assert.ok(result.stdout.includes('斜杠命令'), '安装流程应含斜杠命令步骤');
  assert.equal(existsSync(join(home, '.claude')), false, 'dry-run 不得创建 ~/.claude');
  assert.equal(existsSync(join(home, '.waystation')), false, 'dry-run 不得创建安装目录');
});

test('卸载脚本 --uninstall --dry-run：打印斜杠命令步骤、零写入', (t) => {
  if (!bashAvailable) {
    t.skip('bash 不可用（Windows 需 git-bash；.ps1 臂由主控真机验证）');
    return;
  }
  const { home, result } = runInstallScript(t, ['--uninstall', '--dry-run']);
  assert.equal(result.status, 0, `退出码非 0；stderr：${result.stderr}`);
  assert.ok(result.stdout.includes('斜杠命令'), '卸载流程应含斜杠命令步骤');
  assert.equal(existsSync(join(home, '.claude')), false, 'dry-run 不得创建 ~/.claude');
  assert.equal(existsSync(join(home, '.waystation')), false, 'dry-run 不得创建安装目录');
});
