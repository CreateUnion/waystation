import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { makeTempDir, repoRoot } from './helpers.js';

/* bash 探测：Windows 走 git-bash、Linux 天然可用；不可用则用例跳过（.ps1 臂由主控在真机上跑）。
 * claude 桩：dry-run 路径只对 claude 做存在性判定（command -v）、不会真正执行它，桩只需能被找到；
 * PATH 前插桩目录把「未装 claude CLI」分支换成「已装」分支，让安装的 5/6 与卸载的 2/5 真走到
 * 命令行模块——这样断言的是模块计划专属输出（受管文件名），而不是两条臂无条件都打印的通用文案。
 * 脚本经 HOME 指向临时目录 + dry-run 运行——只读检测与打印，不触碰真实家目录。 */
const bashProbe = spawnSync('bash', ['-c', 'exit 0']);
const bashAvailable = bashProbe.error === undefined && bashProbe.status === 0;

const MANAGED_MARKER = '<!-- waystation-managed-command -->';

function makeClaudeStub(t) {
  const binDir = join(makeTempDir(t), 'stub-bin');
  mkdirSync(binDir, { recursive: true });
  const stubPath = join(binDir, 'claude');
  writeFileSync(stubPath, '#!/bin/sh\nexit 0\n');
  chmodSync(stubPath, 0o755);
  return binDir;
}

function runInstallScript(t, args, home = makeTempDir(t)) {
  const stubDir = makeClaudeStub(t);
  const result = spawnSync('bash', [join(repoRoot, 'scripts', 'install.sh'), ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home.replace(/\\/g, '/'),
      PATH: `${stubDir}${delimiter}${process.env.PATH}`,
    },
  });
  return { home, result };
}

test('安装脚本 --dry-run：5/6 走到命令行模块（含五个受管文件名）、HOME 下零写入', (t) => {
  if (!bashAvailable) {
    t.skip('bash 不可用（Windows 需 git-bash；.ps1 臂由主控真机验证）');
    return;
  }
  const { home, result } = runInstallScript(t, ['--dry-run']);
  assert.equal(result.status, 0, `退出码非 0；stderr：${result.stderr}`);
  assert.ok(result.stdout.includes('斜杠命令'), '安装流程应含斜杠命令步骤');
  assert.ok(
    result.stdout.includes('ws-collab') && result.stdout.includes('ws-discuss') && result.stdout.includes('ws-list')
      && result.stdout.includes('ws-mute') && result.stdout.includes('ws-purge') && result.stdout.includes('ws-view.md'),
    `应打印模块安装计划（六个受管文件名）：${result.stdout}`,
  );
  assert.ok(result.stdout.includes('scripts/ws-viewer.js'), `dry-run 应打印 ws-viewer.js 拷贝：${result.stdout}`);
  assert.match(
    result.stdout,
    /观察窗启动器：[\s\S]*将安装：[^\n]*ws-view/,
    `应打印启动器安装计划（观察窗启动器标签之后、经 install-shims 调用）：${result.stdout}`,
  );
  assert.equal(existsSync(join(home, '.claude')), false, 'dry-run 不得创建 ~/.claude');
  assert.equal(existsSync(join(home, '.waystation')), false, 'dry-run 不得创建安装目录');
});

test('卸载脚本 --uninstall --dry-run：2/5 走到命令行模块（将删除 + 受管文件名）、零写入', (t) => {
  if (!bashAvailable) {
    t.skip('bash 不可用（Windows 需 git-bash；.ps1 臂由主控真机验证）');
    return;
  }
  const home = makeTempDir(t);
  const commandsDir = join(home, '.claude', 'commands');
  mkdirSync(commandsDir, { recursive: true });
  const managedPath = join(commandsDir, 'ws-list.md');
  writeFileSync(managedPath, `---\ndescription: list\n---\n${MANAGED_MARKER}\n正文\n`);
  const { result } = runInstallScript(t, ['--uninstall', '--dry-run'], home);
  assert.equal(result.status, 0, `退出码非 0；stderr：${result.stderr}`);
  assert.ok(result.stdout.includes('斜杠命令'), '卸载流程应含斜杠命令步骤');
  assert.ok(
    result.stdout.includes('将删除') && result.stdout.includes('ws-list.md'),
    `应打印模块删除计划（将删除 + 受管文件名）：${result.stdout}`,
  );
  assert.ok(
    result.stdout.includes(`不存在，跳过：${join(home, '.waystation', 'bin', 'ws-view.cmd')}`)
      && result.stdout.includes(`不存在，跳过：${join(home, '.waystation', 'bin', 'ws-view.vbs')}`)
      && result.stdout.includes(`不存在，跳过：${join(home, '.local', 'bin', 'ws-view')}`),
    `卸载臂应经 install-shims 列出观察窗三件套：${result.stdout}`,
  );
  assert.equal(existsSync(managedPath), true, 'dry-run 不得删除受管命令');
  assert.equal(existsSync(join(home, '.waystation')), false, 'dry-run 不得创建安装目录');
});
