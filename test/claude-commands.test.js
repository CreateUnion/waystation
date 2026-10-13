import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MANAGED_MARKER,
  applyInstallCommands,
  applyRemoveCommands,
  commandsDirFor,
  planInstallCommands,
  planRemoveCommands,
  runCli,
} from '../src/claude-commands.js';
import { makeTempDir, repoRoot } from './helpers.js';

const MODULE_ENTRY = join(repoRoot, 'src', 'claude-commands.js');

/* 受管命令样本：frontmatter + 标记行 + 正文（与随仓库分发的真实文件同形）。 */
function managedCommand(label) {
  return `---\ndescription: ${label}\n---\n${MANAGED_MARKER}\n${label} 正文\n`;
}

/* 捕获模块写到 process.stdout 的输出（模块输出是安装脚本消费的契约面，用真通道验）。 */
function runWithCapture(run) {
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    const code = run();
    return { code, output: chunks.join('') };
  } finally {
    process.stdout.write = original;
  }
}

/* 临时源目录：写入给定文件集（缺省 = 两个受管命令样本——夹具自成一体，不随仓库源集合份数变动）。 */
function makeSourceDir(t, files = { 'ws-collab.md': managedCommand('collab'), 'ws-list.md': managedCommand('list') }) {
  const sourceDir = join(makeTempDir(t), 'claude-commands');
  mkdirSync(sourceDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(sourceDir, name), content);
  }
  return sourceDir;
}

function makeCommandsDir(home, files) {
  const commandsDir = commandsDirFor(home);
  mkdirSync(commandsDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(commandsDir, name), content);
  }
  return commandsDir;
}

test('仓库命令源：五个文件存在且带受管标记（防源集合与标记漂移）', () => {
  for (const name of ['ws-collab.md', 'ws-discuss.md', 'ws-list.md', 'ws-mute.md', 'ws-purge.md']) {
    const filePath = join(repoRoot, 'scripts', 'claude-commands', name);
    assert.equal(existsSync(filePath), true, `缺少命令源文件：${name}`);
    const text = readFileSync(filePath, 'utf8');
    assert.ok(text.startsWith('---'), `${name} 应以 frontmatter 开头`);
    assert.ok(text.includes(MANAGED_MARKER), `${name} 应带受管标记`);
  }
});

test('install：首次写入（含建目录），重跑覆盖幂等', (t) => {
  const home = makeTempDir(t);
  const sourceDir = makeSourceDir(t);
  const first = runWithCapture(() => runCli(['install', '--home', home, '--source', sourceDir]));
  assert.equal(first.code, 0);
  assert.ok(first.output.includes('目录不存在，已创建'));
  assert.ok(first.output.includes('已安装：ws-collab.md'));
  assert.ok(first.output.includes('已安装：ws-list.md'));
  assert.equal(readFileSync(join(commandsDirFor(home), 'ws-collab.md'), 'utf8'), managedCommand('collab'));
  const second = runWithCapture(() => runCli(['install', '--home', home, '--source', sourceDir]));
  assert.equal(second.code, 0);
  assert.ok(second.output.includes('已更新：ws-collab.md'));
  assert.ok(second.output.includes('已更新：ws-list.md'));
  assert.equal(readFileSync(join(commandsDirFor(home), 'ws-list.md'), 'utf8'), managedCommand('list'));
});

test('install：同名非受管文件跳过不覆盖（内容不动）', (t) => {
  const home = makeTempDir(t);
  const sourceDir = makeSourceDir(t, { 'ws-list.md': managedCommand('list') });
  const manual = '手工副本，无标记\n';
  makeCommandsDir(home, { 'ws-list.md': manual });
  const { code, output } = runWithCapture(() => runCli(['install', '--home', home, '--source', sourceDir]));
  assert.equal(code, 0);
  assert.ok(output.includes('同名非受管文件未覆盖（如系旧手工副本，请手工删除后重跑，或手工替换）：ws-list.md'));
  assert.equal(readFileSync(join(commandsDirFor(home), 'ws-list.md'), 'utf8'), manual, '非受管文件不得被覆盖');
});

test('install：陈旧受管命令清理，外来文件保留', (t) => {
  const home = makeTempDir(t);
  const sourceDir = makeSourceDir(t);
  const commandsDir = makeCommandsDir(home, { 'ws-old.md': managedCommand('old'), 'note.md': '用户自己的说明\n' });
  const { code, output } = runWithCapture(() => runCli(['install', '--home', home, '--source', sourceDir]));
  assert.equal(code, 0);
  assert.ok(output.includes('已清理陈旧受管命令：ws-old.md'));
  assert.equal(existsSync(join(commandsDir, 'ws-old.md')), false);
  assert.equal(existsSync(join(commandsDir, 'note.md')), true, '无标记的异名文件一律不动');
});

test('install：陈旧清理失败逐文件记账（失败项不列入已清理）', (t) => {
  const home = makeTempDir(t);
  const sourceDir = makeSourceDir(t);
  const commandsDir = makeCommandsDir(home, { 'ws-old.md': managedCommand('old') });
  const plan = planInstallCommands({ home, sourceDir });
  assert.equal(plan.stale.length, 1);
  /* 计划后把待清理目标换成同名目录使删除必失败：目录在扫描期被 isFile 过滤，只能计划后注入。 */
  rmSync(join(commandsDir, 'ws-old.md'));
  mkdirSync(join(commandsDir, 'ws-old.md'));
  const applied = applyInstallCommands(plan);
  assert.deepEqual(applied.cleaned, [], '清理失败的条目不得计入已清理名单');
  assert.ok(
    applied.failures.some((line) => line.startsWith('清理失败：ws-old.md')),
    `failures 应含清理失败记账：${applied.failures.join('；')}`,
  );
});

test('install 输出：陈旧清理失败时只打印失败行、不打印「已清理」', (t) => {
  if (process.platform === 'win32') {
    /* Windows 没有单次调用内可复现的 unlink 失败注入（只读属性会被强删的 chmod 重试化解），
     * 执行层记账由上一个用例覆盖；本用例在 POSIX（CI）跑，直接验输出层不误报。 */
    t.skip('Windows 无单次调用内可复现的删除失败注入；输出层断言在 POSIX 跑');
    return;
  }
  const home = makeTempDir(t);
  const sourceDir = makeSourceDir(t);
  const commandsDir = makeCommandsDir(home, { 'ws-old.md': managedCommand('old') });
  /* POSIX 下 unlink 取决于父目录写权限——撤掉写权限，清理必失败（比换成目录更贴近真实故障）。 */
  chmodSync(commandsDir, 0o555);
  try {
    const { code, output } = runWithCapture(() => runCli(['install', '--home', home, '--source', sourceDir]));
    assert.equal(code, 1, `失败应计入退出码；输出：${output}`);
    assert.ok(output.includes('清理失败：ws-old.md'), `应打印清理失败行：${output}`);
    assert.ok(!output.includes('已清理陈旧受管命令：ws-old.md'), `清理失败不得打印「已清理」：${output}`);
  } finally {
    chmodSync(commandsDir, 0o755);
  }
});

test('install --dry-run：目录缺失 → 打印将创建/将安装、目录不创建', (t) => {
  const home = makeTempDir(t);
  const sourceDir = makeSourceDir(t);
  const { code, output } = runWithCapture(() => runCli(['install', '--home', home, '--source', sourceDir, '--dry-run']));
  assert.equal(code, 0);
  assert.ok(output.includes('目录不存在，将创建'));
  assert.ok(output.includes('将安装：ws-collab.md'));
  assert.equal(existsSync(join(home, '.claude')), false, 'dry-run 不得创建目录');
});

test('install --dry-run：将跳过/将清理同口径计算、零变更', (t) => {
  const home = makeTempDir(t);
  const sourceDir = makeSourceDir(t, { 'ws-list.md': managedCommand('list') });
  const commandsDir = makeCommandsDir(home, { 'ws-list.md': '手工副本\n', 'ws-old.md': managedCommand('old') });
  const before = readdirSync(commandsDir).sort();
  const { code, output } = runWithCapture(() => runCli(['install', '--home', home, '--source', sourceDir, '--dry-run']));
  assert.equal(code, 0);
  assert.ok(output.includes('将跳过——同名非受管文件未覆盖'));
  assert.ok(output.includes('将清理陈旧受管命令：ws-old.md'));
  assert.deepEqual(readdirSync(commandsDir).sort(), before, 'dry-run 零写入');
});

test('remove：仅删带标记文件（无标记一律不动）；再删为「无受管文件，跳过」', (t) => {
  const home = makeTempDir(t);
  const commandsDir = makeCommandsDir(home, { 'ws-list.md': managedCommand('list'), 'manual.md': '手工文件\n' });
  const first = runWithCapture(() => runCli(['remove', '--home', home]));
  assert.equal(first.code, 0);
  assert.ok(first.output.includes(`已删除：${join(commandsDir, 'ws-list.md')}`));
  assert.equal(existsSync(join(commandsDir, 'ws-list.md')), false);
  assert.equal(existsSync(join(commandsDir, 'manual.md')), true, '无标记文件一律不动');
  const second = runWithCapture(() => runCli(['remove', '--home', home]));
  assert.equal(second.code, 0);
  assert.ok(second.output.includes('无受管文件，跳过'));
});

test('remove：目录不存在 → 打印「不存在，跳过」、退出码 0', (t) => {
  const home = makeTempDir(t);
  const { code, output } = runWithCapture(() => runCli(['remove', '--home', home]));
  assert.equal(code, 0);
  assert.ok(output.includes(`不存在，跳过：${join(home, '.claude', 'commands')}`));
});

test('remove --dry-run：只打印将删除、文件仍在', (t) => {
  const home = makeTempDir(t);
  const commandsDir = makeCommandsDir(home, { 'ws-collab.md': managedCommand('collab') });
  const { code, output } = runWithCapture(() => runCli(['remove', '--home', home, '--dry-run']));
  assert.equal(code, 0);
  assert.ok(output.includes(`将删除：${join(commandsDir, 'ws-collab.md')}`));
  assert.equal(existsSync(join(commandsDir, 'ws-collab.md')), true);
});

test('执行期失败逐文件记账：写入失败与删除失败都不中断其余（failures 计数）', (t) => {
  const home = makeTempDir(t);
  const sourceDir = makeSourceDir(t, { 'ws-list.md': managedCommand('list') });
  const installPlan = planInstallCommands({ home, sourceDir });
  rmSync(join(sourceDir, 'ws-list.md'));
  const installResult = applyInstallCommands(installPlan);
  assert.equal(installResult.failures.length, 1);
  assert.ok(installResult.failures[0].startsWith('写入失败：ws-list.md'));
  const removeHome = makeTempDir(t);
  const commandsDir = makeCommandsDir(removeHome, { 'ws-list.md': managedCommand('list') });
  const removePlan = planRemoveCommands({ home: removeHome });
  rmSync(join(commandsDir, 'ws-list.md'));
  mkdirSync(join(commandsDir, 'ws-list.md'));
  const removeResult = applyRemoveCommands(removePlan);
  assert.equal(removeResult.failures.length, 1);
  assert.ok(removeResult.failures[0].startsWith('删除失败：ws-list.md'));
});

test('参数校验：未知子命令/未知参数/缺 --home/缺取值/缺 --source 一律退出码 1', (t) => {
  const home = makeTempDir(t);
  const sourceDir = makeSourceDir(t);
  const empty = runWithCapture(() => runCli([]));
  assert.equal(empty.code, 1);
  assert.ok(empty.output.includes('未知子命令'));
  const bogus = runWithCapture(() => runCli(['frobnicate', '--home', home]));
  assert.equal(bogus.code, 1);
  assert.ok(bogus.output.includes('未知子命令：frobnicate'));
  const unknownArg = runWithCapture(() => runCli(['install', '--home', home, '--bogus']));
  assert.equal(unknownArg.code, 1);
  assert.ok(unknownArg.output.includes('未知参数：--bogus'));
  const noHome = runWithCapture(() => runCli(['remove']));
  assert.equal(noHome.code, 1);
  assert.ok(noHome.output.includes('缺少 --home'));
  const noValue = runWithCapture(() => runCli(['install', '--home']));
  assert.equal(noValue.code, 1);
  assert.ok(noValue.output.includes('--home 缺少取值'));
  const noSource = runWithCapture(() => runCli(['install', '--home', home]));
  assert.equal(noSource.code, 1);
  assert.ok(noSource.output.includes('缺少 --source'));
  assert.equal(existsSync(join(sourceDir, 'ws-collab.md')), true, '参数错误不得改动源目录');
});

test('install：源目录不存在 → 错误行、退出码 1（安装脚本据此给手工指引）', (t) => {
  const home = makeTempDir(t);
  const { code, output } = runWithCapture(() => runCli(['install', '--home', home, '--source', join(home, 'missing')]));
  assert.equal(code, 1);
  assert.ok(output.includes('错误：'));
  assert.ok(output.includes('命令源目录不存在'));
});

test('进程级：spawn node 直跑模块（install 退出码 0；remove 目录缺失退出码 0；未知子命令退出码 1）', (t) => {
  const home = makeTempDir(t);
  const sourceDir = makeSourceDir(t);
  const spawnCli = (args) => spawnSync(process.execPath, [MODULE_ENTRY, ...args], { encoding: 'utf8' });
  const install = spawnCli(['install', '--home', home, '--source', sourceDir]);
  assert.equal(install.status, 0, `stderr：${install.stderr}`);
  assert.ok(install.stdout.includes('已安装：ws-collab.md'));
  assert.equal(readFileSync(join(commandsDirFor(home), 'ws-collab.md'), 'utf8'), managedCommand('collab'));
  const missingHome = makeTempDir(t);
  const remove = spawnCli(['remove', '--home', missingHome]);
  assert.equal(remove.status, 0, `stderr：${remove.stderr}`);
  assert.ok(remove.stdout.includes('不存在，跳过'));
  const bogus = spawnCli(['frobnicate', '--home', home]);
  assert.equal(bogus.status, 1);
  assert.ok(bogus.stdout.includes('未知子命令'));
});
