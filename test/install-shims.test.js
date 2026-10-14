import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyShims, planShims, removeShims, runCli } from '../src/install-shims.js';
import { makeTempDir, repoRoot } from './helpers.js';

const MODULE_ENTRY = join(repoRoot, 'src', 'install-shims.js');

/* 三件套内容规格（测试侧独立抄写一遍——模块改了这里不跟着改就红）。 */
const CMD_CONTENT = '@echo off\r\nnode "%~dp0..\\app\\scripts\\ws-viewer.js" %*\r\n';
const VBS_RUN_LINE = 'shell.Run "cmd /c node """ & scriptPath & """ >> ""%TEMP%\\ws-view.log"" 2>&1", 0, False';
const POSIX_CONTENT = '#!/bin/sh\nexec node "$HOME/.waystation/app/scripts/ws-viewer.js" "$@"\n';

function winSpecs(home) {
  return planShims({ platform: 'win32', home });
}

function posixSpecs(home) {
  return planShims({ platform: 'linux', home });
}

function findSpec(specs, suffix) {
  const spec = specs.find((entry) => entry.path.endsWith(suffix));
  assert.ok(spec, `计划中缺少 ${suffix}：${specs.map((entry) => entry.path).join('、')}`);
  return spec;
}

/* 纯 ASCII 判据：逐字节（UTF-8 编码下任一非 ASCII 字符必产生 >0x7F 的字节），不用控制字符正则
 * （eslint no-control-regex 拦截）。 */
function assertPureAscii(content, label) {
  const offenders = [...Buffer.from(content, 'utf8')].filter((byte) => byte > 0x7f);
  assert.deepEqual(offenders, [], `${label} 必须纯 ASCII（越界字节：${offenders.length} 个）`);
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

test('计划：按平台只落自己的启动器；三件套内容与家目录无关、落点正确', (t) => {
  const home = makeTempDir(t);
  const win = winSpecs(home);
  const posix = posixSpecs(home);
  assert.deepEqual(win.map((entry) => entry.kind), ['cmd', 'vbs'], 'Windows 计划恰为 cmd/vbs 两件套');
  assert.deepEqual(posix.map((entry) => entry.kind), ['posix'], 'POSIX 计划恰为包装一件');
  assert.equal(findSpec(win, 'ws-view.cmd').path, join(home, '.waystation', 'bin', 'ws-view.cmd'));
  assert.equal(findSpec(win, 'ws-view.vbs').path, join(home, '.waystation', 'bin', 'ws-view.vbs'));
  assert.equal(findSpec(posix, 'ws-view').path, join(home, '.local', 'bin', 'ws-view'));
});

test('内容：cmd 精确（ASCII＋CRLF＋相对定位）；posix shebang＋exec（LF）；vbs 纯 ASCII＋引号双写', (t) => {
  const home = makeTempDir(t);
  const cmd = findSpec(winSpecs(home), 'ws-view.cmd');
  assert.equal(cmd.content, CMD_CONTENT, 'cmd 内容逐字符对齐规格');
  assertPureAscii(cmd.content, 'cmd 内容');
  assert.equal(cmd.content.includes('%~dp0..\\app\\scripts\\ws-viewer.js'), true, '相对定位安装目录，不写死绝对路径');
  assert.equal(cmd.content.includes(home), false, '内容不得内嵌家目录路径');

  const wrapper = findSpec(posixSpecs(home), 'ws-view');
  assert.equal(wrapper.content, POSIX_CONTENT);
  assert.equal(wrapper.content.includes('\r'), false, 'POSIX 包装用 LF');
  assert.equal(wrapper.executable, true, 'POSIX 包装标记需要执行位');
  assert.equal(cmd.executable, false);

  const vbs = findSpec(winSpecs(home), 'ws-view.vbs');
  assertPureAscii(vbs.content, 'vbs 内容');
  assert.ok(vbs.content.includes('WScript.ScriptFullName'), '路径必须自派生');
  assert.ok(vbs.content.includes('GetParentFolderName') && vbs.content.includes('BuildPath'), '自派生用 FSO 组合出相对路径');
  assert.ok(vbs.content.includes('"..\\app\\scripts\\ws-viewer.js"'), '目标脚本相对路径');
  assert.ok(vbs.content.includes('%TEMP%') && vbs.content.includes('ws-view.log'), '输出追加到 %TEMP%\\ws-view.log');
  assert.ok(vbs.content.includes('>>'), '日志用追加重定向');
  assert.ok(vbs.content.includes(VBS_RUN_LINE), 'Run 行：引号双写＋窗口模式 0＋不等待，逐字符对齐规格');
});

test('apply：三件套落盘（内容逐字节一致；vbs 落盘字节全 ≤0x7F；POSIX 有执行位）', (t) => {
  const home = makeTempDir(t);
  const files = [...winSpecs(home), ...posixSpecs(home)];
  const applied = applyShims(files);
  assert.deepEqual(applied.failures, []);
  assert.deepEqual(applied.written.sort(), files.map((entry) => entry.path).sort());

  const cmdPath = join(home, '.waystation', 'bin', 'ws-view.cmd');
  assert.equal(readFileSync(cmdPath, 'utf8'), CMD_CONTENT);
  const vbsBytes = readFileSync(join(home, '.waystation', 'bin', 'ws-view.vbs'));
  assert.ok(vbsBytes.every((byte) => byte <= 0x7f), 'vbs 落盘逐字节 ≤0x7F');
  const wrapperPath = join(home, '.local', 'bin', 'ws-view');
  assert.equal(readFileSync(wrapperPath, 'utf8'), POSIX_CONTENT);
  if (process.platform === 'win32') {
    /* Windows 无 POSIX 执行位可断言（chmod 只映射只读属性）——执行位语义由 POSIX 平台用例覆盖 */
    return;
  }
  assert.notEqual(statSync(wrapperPath).mode & 0o111, 0, 'POSIX 包装有执行位');
});

test('remove：三件套逐文件删除、幂等（不存在算成功）', (t) => {
  const home = makeTempDir(t);
  const files = [...winSpecs(home), ...posixSpecs(home)];
  applyShims(files);
  const first = removeShims({ home });
  assert.deepEqual(first.failures, []);
  assert.equal(first.entries.filter((entry) => entry.status === 'removed').length, 3);
  for (const entry of files) {
    assert.equal(existsSync(entry.path), false, `应已删除：${entry.path}`);
  }
  const second = removeShims({ home });
  assert.deepEqual(second.failures, []);
  assert.equal(second.entries.every((entry) => entry.status === 'absent'), true, '再删 = 不存在算成功（幂等）');
});

test('dry-run：零写入只打印（安装与移除都只给计划）', (t) => {
  const home = makeTempDir(t);
  const preview = runWithCapture(() => runCli(['install', '--home', home, '--dry-run']));
  assert.equal(preview.code, 0);
  assert.match(preview.output, /将安装：.*ws-view/);
  assert.equal(existsSync(join(home, '.waystation')), false, 'dry-run 不得创建安装目录');
  assert.equal(existsSync(join(home, '.local')), false, 'dry-run 不得创建 .local');

  const installed = runWithCapture(() => runCli(['install', '--home', home]));
  assert.equal(installed.code, 0);
  assert.match(installed.output, /已安装：.*ws-view/);
  for (const entry of planShims({ home })) {
    assert.equal(existsSync(entry.path), true, `真跑后应存在：${entry.path}`);
  }
  const removePreview = runWithCapture(() => runCli(['remove', '--home', home, '--dry-run']));
  assert.equal(removePreview.code, 0);
  assert.match(removePreview.output, /将删除：.*ws-view/);
  for (const entry of planShims({ home })) {
    assert.equal(existsSync(entry.path), true, '移除 dry-run 不得删文件');
  }
});

test('参数校验：未知子命令/未知参数/缺 --home/缺取值 一律退出码 1 并打印用法', (t) => {
  const home = makeTempDir(t);
  const empty = runWithCapture(() => runCli([]));
  assert.equal(empty.code, 1);
  assert.ok(empty.output.includes('未知子命令'));
  assert.ok(empty.output.includes('用法：'));
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
  assert.equal(existsSync(join(home, '.waystation')), false, '参数错误不得有任何写入');
});

test('home 含空格：产物内容不内嵌家目录、引号结构正确；apply/remove 照常工作', (t) => {
  const home = join(makeTempDir(t), 'way station home');
  mkdirSync(home, { recursive: true });
  const cmd = findSpec(winSpecs(home), 'ws-view.cmd');
  const vbs = findSpec(winSpecs(home), 'ws-view.vbs');
  assert.equal(cmd.path, join(home, '.waystation', 'bin', 'ws-view.cmd'), '落点带空格路径原样');
  assert.equal(cmd.content, CMD_CONTENT, 'cmd 引号在运行期包裹路径（内容与家目录无关）');
  assert.ok(vbs.content.includes('""" & scriptPath & """'), 'vbs 以双写引号包裹运行期路径');
  const applied = applyShims(winSpecs(home));
  assert.deepEqual(applied.failures, []);
  assert.equal(readFileSync(cmd.path, 'utf8'), CMD_CONTENT);
  const removed = removeShims({ home });
  assert.deepEqual(removed.failures, []);
  assert.equal(existsSync(cmd.path), false);
});

test('执行期逐文件记账：写入失败与删除失败都不中断其余', (t) => {
  const home = makeTempDir(t);
  /* 家目录下的 .waystation 是文件 → 两件套的目标目录建不出来，两次写入必失败（逐文件记账为两条） */
  writeFileSync(join(home, '.waystation'), '占位文件\n');
  const applied = applyShims(winSpecs(home));
  assert.equal(applied.written.length, 0);
  assert.equal(applied.failures.length, 2);
  assert.ok(applied.failures.every((line) => line.startsWith('写入失败：')), applied.failures.join('；'));

  const removeHome = makeTempDir(t);
  applyShims(posixSpecs(removeHome));
  const wrapperPath = join(removeHome, '.local', 'bin', 'ws-view');
  rmSync(wrapperPath);
  mkdirSync(wrapperPath);
  const removed = removeShims({ home: removeHome });
  assert.equal(removed.failures.length, 1);
  assert.ok(removed.failures[0].startsWith(`删除失败：${wrapperPath}`));
  assert.equal(removed.entries.find((entry) => entry.path === wrapperPath).status, 'failed');
});

test('进程级：spawn node 直跑模块（install --dry-run 退出码 0；未知子命令退出码 1）', (t) => {
  const home = makeTempDir(t);
  const spawnCli = (args) => spawnSync(process.execPath, [MODULE_ENTRY, ...args], { encoding: 'utf8' });
  const install = spawnCli(['install', '--home', home, '--dry-run']);
  assert.equal(install.status, 0, `stderr：${install.stderr}`);
  assert.match(install.stdout, /将安装：.*ws-view/);
  assert.equal(existsSync(join(home, '.waystation')), false);
  const bogus = spawnCli(['frobnicate']);
  assert.equal(bogus.status, 1);
  assert.ok(bogus.stdout.includes('未知子命令'));
});
