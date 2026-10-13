import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MANAGED_MARKER } from '../src/claude-commands.js';
import { defaultRunCommand, parseUninstallArgs, runUninstallCli } from '../src/uninstall.js';
import { makeTempDir, repoRoot } from './helpers.js';

const BIN_ENTRY = join(repoRoot, 'bin', 'waystation.js');

/* 记录型假命令执行器：默认成功；按 command 全串注入响应（missing = 可执行不存在）。 */
function recordingRunner(responses = {}) {
  const calls = [];
  const runner = (command, args) => {
    const key = [command, ...args].join(' ');
    calls.push(key);
    return responses[key] ?? { ok: true, code: 0, output: '', missing: false };
  };
  return { calls, runner };
}

/* 捕获模块写到 process.stdout 的输出（模块输出是 CLI 契约面，用真通道验）。 */
async function runWithCapture(run) {
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    const code = await run();
    return { code, output: chunks.join('') };
  } finally {
    process.stdout.write = original;
  }
}

/* 「已安装」现场：**安装面按 HOME 布局**（<home>/.waystation 的 app 与 bin shim）、**数据目录另位**
 * （WAYSTATION_HOME 指向 <home>/data，含 config.json 以过 purge 内容形态检查）——全部删除面落在
 * 临时目录内，绝不触碰真实家目录。命令目录含一个受管命令与一个外来文件：删除面只应命中前者。 */
function makeInstalledHome(t) {
  const home = makeTempDir(t);
  const installDir = join(home, '.waystation');
  const dataDir = join(home, 'data');
  const commandsDir = join(home, '.claude', 'commands');
  mkdirSync(join(installDir, 'app', 'src'), { recursive: true });
  writeFileSync(join(installDir, 'app', 'src', 'index.js'), '// 占位');
  mkdirSync(join(installDir, 'bin'), { recursive: true });
  writeFileSync(join(installDir, 'bin', 'waystation.cmd'), '@echo off');
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  writeFileSync(join(home, '.local', 'bin', 'waystation'), '#!/bin/sh');
  mkdirSync(commandsDir, { recursive: true });
  writeFileSync(join(commandsDir, 'ws-list.md'), `---\ndescription: 列表\n---\n${MANAGED_MARKER}\n正文\n`);
  writeFileSync(join(commandsDir, 'note.md'), '用户手工文件\n');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'config.json'), '{}');
  return { home, installDir, dataDir, commandsDir };
}

test('参数解析：三开关组合与未知参数收集', () => {
  assert.deepEqual(parseUninstallArgs([]), { dryRun: false, purgeData: false, help: false, unknown: [] });
  assert.deepEqual(parseUninstallArgs(['--dry-run', '--purge-data']), { dryRun: true, purgeData: true, help: false, unknown: [] });
  const bad = parseUninstallArgs(['--bogus', 'extra']);
  assert.deepEqual(bad.unknown, ['--bogus', 'extra']);
});

test('默认命令执行器：真实进程映射（成功 / 非零退出 / 可执行缺失绝不抛出）', () => {
  const ok = defaultRunCommand(process.execPath, ['-e', 'process.exit(0)']);
  assert.equal(ok.ok, true);
  assert.equal(ok.missing, false);
  const failed = defaultRunCommand(process.execPath, ['-e', 'process.stderr.write("boom"); process.exit(2)']);
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 2);
  assert.equal(failed.output, 'boom', 'stderr 汇入 output 并去除首尾空白');
  const missing = defaultRunCommand('waystation-definitely-missing-command', []);
  assert.equal(missing.ok, false);
  assert.equal(missing.code, null);
  assert.equal(missing.missing, true, '可执行缺失映射为 missing（承载「未找到 claude CLI」UX 分支）');
});

test('dry-run：只打印、不执行命令、不删任何文件', async (t) => {
  const { home, installDir, dataDir, commandsDir } = makeInstalledHome(t);
  const { calls, runner } = recordingRunner();
  const { code, output } = await runWithCapture(() => runUninstallCli({ argv: ['--dry-run'], env: { WAYSTATION_HOME: dataDir }, runCommand: runner, home }));
  assert.equal(code, 0);
  assert.equal(calls.length, 0);
  assert.ok(output.includes('将执行：claude mcp remove -s user waystation'));
  assert.ok(output.includes('斜杠命令'));
  assert.ok(output.includes(`将删除：${join(commandsDir, 'ws-list.md')}`));
  assert.equal(existsSync(join(installDir, 'app')), true);
  assert.equal(existsSync(join(installDir, 'bin', 'waystation.cmd')), true);
  assert.equal(existsSync(join(commandsDir, 'ws-list.md')), true, 'dry-run 不删受管斜杠命令');
});

test('真实路径：注销注册、删两平台 shim 与安装目录、数据目录保留（安装面按 HOME 布局）', async (t) => {
  const { home, installDir, dataDir, commandsDir } = makeInstalledHome(t);
  const { calls, runner } = recordingRunner();
  const { code, output } = await runWithCapture(() => runUninstallCli({ argv: [], env: { WAYSTATION_HOME: dataDir }, runCommand: runner, home }));
  assert.equal(code, 0);
  assert.deepEqual(calls, ['claude mcp remove -s user waystation']);
  assert.ok(output.includes('已注销：waystation'));
  assert.ok(output.includes('2/5 删除斜杠命令'));
  assert.equal(existsSync(join(commandsDir, 'ws-list.md')), false, '受管斜杠命令随卸载删除');
  assert.equal(existsSync(join(commandsDir, 'note.md')), true, '无标记文件一律不动');
  assert.equal(existsSync(join(installDir, 'app')), false);
  assert.equal(existsSync(join(installDir, 'bin', 'waystation.cmd')), false);
  assert.equal(existsSync(join(home, '.local', 'bin', 'waystation')), false, 'Linux shim 同删');
  assert.equal(existsSync(dataDir), true, '数据目录默认保留（WAYSTATION_HOME 另位不受安装面清理影响）');
});

test('无 claude CLI：手工步骤提示、不失败退出（退出码 0）', async (t) => {
  const { home, installDir, dataDir } = makeInstalledHome(t);
  const runner = () => ({ ok: false, code: null, output: 'spawn claude ENOENT', missing: true });
  const { code, output } = await runWithCapture(() => runUninstallCli({ argv: [], env: { WAYSTATION_HOME: dataDir }, runCommand: runner, home }));
  assert.equal(code, 0);
  assert.ok(output.includes('未找到 claude CLI'));
  assert.ok(output.includes('claude mcp remove -s user waystation'));
  assert.equal(existsSync(join(installDir, 'app')), false, '无 claude CLI 不影响其余清理面');
});

test('--purge-data：数据目录一并删除（家目录不受影响）', async (t) => {
  const { home, dataDir } = makeInstalledHome(t);
  const { runner } = recordingRunner();
  const { code } = await runWithCapture(() => runUninstallCli({ argv: ['--purge-data'], env: { WAYSTATION_HOME: dataDir }, runCommand: runner, home }));
  assert.equal(code, 0);
  assert.equal(existsSync(dataDir), false);
  assert.equal(existsSync(home), true, '家目录绝不在删除面内');
});

test('--purge-data 守卫：家目录本身 / 非数据目录内容形态 → 拒绝（退出码 1、不删）', async (t) => {
  const { runner } = recordingRunner();
  const home = makeTempDir(t);
  const asHome = await runWithCapture(() => runUninstallCli({ argv: ['--purge-data'], env: { WAYSTATION_HOME: home }, runCommand: runner, home }));
  assert.equal(asHome.code, 1);
  assert.ok(asHome.output.includes('拒绝删除'));
  assert.ok(asHome.output.includes('用户家目录本身'));
  const plainDir = makeTempDir(t);
  writeFileSync(join(plainDir, 'note.txt'), 'x');
  const alien = await runWithCapture(() => runUninstallCli({ argv: ['--purge-data'], env: { WAYSTATION_HOME: plainDir }, runCommand: runner, home }));
  assert.equal(alien.code, 1);
  assert.ok(alien.output.includes('不像驿站数据目录'));
  assert.equal(existsSync(plainDir), true, '内容形态不符：整目录原样保留');
});

/* 守卫按监听器身份幂等：重复调用不叠加；监听被移除后按身份重装（旧式一次性布尔守卫此处不会重装）。 */
test('EPIPE 守卫：按监听器身份幂等（重复调用不叠加、被移除后重装）', async (t) => {
  const home = makeTempDir(t);
  const { runner } = recordingRunner();
  const dryRun = () => runWithCapture(() => runUninstallCli({ argv: ['--dry-run'], env: { WAYSTATION_HOME: home }, runCommand: runner, home }));
  await dryRun();
  const guard = process.stdout.listeners('error').find((fn) => fn.name === 'onStdoutError');
  assert.ok(guard, '调用后守卫可按具名函数身份辨认');
  const installed = process.stdout.listenerCount('error');
  await dryRun();
  await dryRun();
  assert.equal(process.stdout.listenerCount('error'), installed, '重复调用不叠加监听器');
  process.stdout.removeListener('error', guard);
  await dryRun();
  assert.equal(process.stdout.listenerCount('error'), installed, '监听被移除后按身份重装（数量复原）');
});

/* bin 子进程收尾：node:test 的收尾钩子按注册序执行，而临时目录的删除钩子由 makeTempDir 在其调用点
 * 先行注册——「先等子进程退出、后删目录」要求收尾钩子抢在删除钩子之前注册（与 server.test.js 同一
 * 模式），否则删除撞上存活进程的写盘抛错会跳过其后全部钩子（含杀进程）——泄漏的子进程拖住文件进程
 * 永不退出，runner 无限等待该文件（整轮运行冻结）。 */
const childrenByTest = new WeakMap();
const binChildren = [];   // 文件级兜底：本文件启动过的全部 bin 子进程

function cleanupRegistryOf(t) {
  let children = childrenByTest.get(t);
  if (children === undefined) {
    children = [];
    childrenByTest.set(t, children);
    t.after(async () => {
      for (const child of children) {
        await stopChild(child);
      }
    });
  }
  return children;
}

/* 强杀并等 exit 落地；已退出的进程无操作——收尾路径不因二次处理把用例判红。 */
async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
}

/* 数据目录：收尾钩子先于 makeTempDir 的删除钩子注册（见上）。 */
function makeStationDir(t) {
  cleanupRegistryOf(t);
  return makeTempDir(t);
}

/* 新起的子进程登记进用例清单与文件清单（用例收尾强杀；文件末兜底查漏）。 */
function registerChild(t, child) {
  cleanupRegistryOf(t).push(child);
  binChildren.push(child);
}

/* 文件级兜底：任何收尾钩子被跳过（如钩子抛错）都会留下存活的子进程——此处强制杀灭并响亮失败，
 * 绝不让泄漏把整轮运行拖进永不退出的等待（正常路径全部已杀，兜底无事可做）。 */
after(() => {
  const leakedPids = [];
  for (const child of binChildren) {
    if (child.exitCode === null && child.signalCode === null) {
      leakedPids.push(child.pid);
      child.kill('SIGKILL');
    }
  }
  assert.equal(leakedPids.length, 0, `bin 子进程未被用例收尾（收尾钩子被跳过？）：${leakedPids.join(',')}——已兜底强制杀灭，检查用例清理`);
});

test('进程级：bin 分派 uninstall --dry-run（退出码 0）；未知参数 → 退出码 1', { timeout: 20000 }, async (t) => {
  const home = makeStationDir(t);
  const run = (args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN_ENTRY, ...args], {
      cwd: repoRoot,
      env: { ...process.env, WAYSTATION_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    registerChild(t, child);
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stdout }));
  });
  const preview = await run(['uninstall', '--dry-run']);
  assert.equal(preview.code, 0);
  assert.ok(preview.stdout.includes('waystation 卸载（dry-run'));
  const bad = await run(['uninstall', '--bogus']);
  assert.equal(bad.code, 1);
  assert.ok(bad.stdout.includes('未知参数'));
});
