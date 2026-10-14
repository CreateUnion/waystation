import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* 观察窗启动器（ws-view）三件套的单源生成与移除：`<home>/.waystation/bin/ws-view.cmd`（终端入口）、
 * `ws-view.vbs`（双击静默启动）与 `<home>/.local/bin/ws-view`（POSIX 短包装）。两个安装脚本与
 * 卸载面（waystation uninstall、两安装脚本的卸载臂）只做调用与输出转发，不在脚本里复刻
 * 「生成什么、放哪里、删哪些」的判断。
 *
 * 为什么单源：同一份启动器规格要被四条安装/移除路径消费，分散实现必然漂移——vbs 的
 * 「纯 ASCII＋路径自派生」约束尤其易在编辑中被顺手破坏（中文注释、绝对路径都会混进来）。
 *
 * 平台口径：安装按平台只落自己形态的启动器（Windows 两件套 / POSIX 包装），避免在对侧平台
 * 留下用不上的文件；移除则三件套一并处理（跨平台残留一次清干净，与既有主 shim 的两平台口径一致）。
 *
 * vbs 约束的由来：双击启动时读不到安装进程的环境（WAYSTATION_HOME），且安装目录可随家目录
 * 迁移——故路径一律由 WScript.ScriptFullName 自派生、不写死绝对路径，脚本输出无控制台可看，
 * 统一追加到 %TEMP%\ws-view.log（「双击没反应」时的排查入口，README 有述）——文件保持纯 ASCII，
 * 避免代码页差异在非中文系统上读出乱码。
 *
 * 输出走 stdout：它是本模块的用户/脚本输出通道（安装脚本经进程调用逐行转发），模块只 import
 * node 内置模块、不参与 MCP 服务路径（stdout 纪律扫描对该文件显式豁免，见
 * test/stdout-discipline.test.js 的豁免清单）。家目录一律经参数传入，绝不隐式触碰真实
 * ~/.waystation 与 ~/.local——测试全部走临时目录。 */

const USAGE_LINES = [
  '用法：',
  '  node src/install-shims.js install --home <home> [--dry-run]',
  '  node src/install-shims.js remove --home <home> [--dry-run]',
];

/* win cmd：终端用户入口（可见日志）。%~dp0 = 本 .cmd 所在目录（含尾反斜杠）——相对指向安装目录、
 * 不写死绝对路径；@echo off 防命令行回显。CRLF＋纯 ASCII 沿 Windows 惯例。 */
const CMD_LINES = [
  '@echo off',
  'node "%~dp0..\\app\\scripts\\ws-viewer.js" %*',
];

/* win vbs：双击启动、无控制台窗口（Run 第二参 0 = 隐藏窗口、第三参 False = 不等待）。
 * 内嵌引号按 VBScript 规则双写（""），命令串内再按 Windows 命令行规则用引号包裹路径。
 * 注释行同为 ASCII（纯 ASCII 约束见文件头）。 */
const VBS_LINES = [
  "' waystation ws-view launcher: double-click to start the local viewer without a console window.",
  "' The script path derives from this file location; output is appended to %TEMP%\\ws-view.log.",
  'Option Explicit',
  'Dim fso, shell, scriptDir, scriptPath',
  'Set fso = CreateObject("Scripting.FileSystemObject")',
  'Set shell = CreateObject("WScript.Shell")',
  'scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)',
  'scriptPath = fso.BuildPath(scriptDir, "..\\app\\scripts\\ws-viewer.js")',
  'shell.Run "cmd /c node """ & scriptPath & """ >> ""%TEMP%\\ws-view.log"" 2>&1", 0, False',
];

/* POSIX 短包装：exec 把进程让给 node（信号与退出码直通）；LF 行尾。 */
const POSIX_LINES = [
  '#!/bin/sh',
  'exec node "$HOME/.waystation/app/scripts/ws-viewer.js" "$@"',
];

/* 三件套内容规格：与家目录无关（win 两件套路径由启动器运行时自派生/相对定位，POSIX 包装读
 * $HOME），home 只决定落点。kind 供按平台筛选，executable 供 apply 决定是否补执行位。 */
function shimSpecs(home) {
  return [
    { kind: 'cmd', path: join(home, '.waystation', 'bin', 'ws-view.cmd'), content: `${CMD_LINES.join('\r\n')}\r\n`, executable: false },
    { kind: 'vbs', path: join(home, '.waystation', 'bin', 'ws-view.vbs'), content: `${VBS_LINES.join('\r\n')}\r\n`, executable: false },
    { kind: 'posix', path: join(home, '.local', 'bin', 'ws-view'), content: `${POSIX_LINES.join('\n')}\n`, executable: true },
  ];
}

/**
 * 安装计划：按平台给出要生成的启动器。dry-run 与真跑共用同一份计划。
 * @param {{ platform?: NodeJS.Platform, home: string }} options
 */
export function planShims({ platform = process.platform, home }) {
  const wantedKinds = platform === 'win32' ? ['cmd', 'vbs'] : ['posix'];
  return shimSpecs(home).filter((spec) => wantedKinds.includes(spec.kind));
}

/**
 * 执行安装计划（dry-run 零写入；目录缺失先创建）。逐文件进行：个别文件写入失败不中断其余，
 * 汇总进 failures 由调用方处置（退出码与手工指引）。
 * @param {ReturnType<typeof planShims>} files
 * @param {{ dryRun?: boolean }} [options]
 */
export function applyShims(files, { dryRun = false } = {}) {
  /** @type {{ written: string[], failures: string[] }} */
  const applied = { written: [], failures: [] };
  if (dryRun) {
    return applied;
  }
  for (const file of files) {
    try {
      mkdirSync(dirname(file.path), { recursive: true });
      writeFileSync(file.path, file.content);
      if (file.executable) {
        chmodSync(file.path, 0o755);
      }
      applied.written.push(file.path);
    } catch (error) {
      applied.failures.push(`写入失败：${file.path}——${error?.message}`);
    }
  }
  return applied;
}

/**
 * 移除三件套（逐文件删除；不存在算成功——幂等）。dry-run 只给出计划不改动。三件套都在清单内：
 * 另一平台的残留一并清掉（与既有主 shim 的两平台口径一致）。
 * @param {{ home: string, dryRun?: boolean }} options
 * @returns {{ entries: Array<{ path: string, status: string }>, failures: string[] }}
 */
export function removeShims({ home, dryRun = false }) {
  const entries = [];
  const failures = [];
  for (const file of shimSpecs(home)) {
    if (!existsSync(file.path)) {
      entries.push({ path: file.path, status: 'absent' });
    } else if (dryRun) {
      entries.push({ path: file.path, status: 'planned' });
    } else {
      try {
        rmSync(file.path, { force: true });
        entries.push({ path: file.path, status: 'removed' });
      } catch (error) {
        entries.push({ path: file.path, status: 'failed' });
        failures.push(`删除失败：${file.path}——${error?.message}`);
      }
    }
  }
  return { entries, failures };
}

/** 脚本入口（install / remove；输出中文人话行到 stdout）。退出码 0 = 正常（含「无操作」），1 = 参数或执行失败。
 * @param {string[]} argv */
export function runCli(argv) {
  guardBrokenPipe();
  const options = parseCliArgs(argv);
  if (options.error !== null) {
    write(options.error);
    write(USAGE_LINES.join('\n'));
    return 1;
  }
  try {
    return options.command === 'install' ? runInstallCommand(options) : runRemoveCommand(options);
  } catch (error) {
    write(`错误：${error?.message ?? String(error)}`);
    return 1;
  }
}

function runInstallCommand(options) {
  const files = planShims({ home: options.home });
  const applied = applyShims(files, { dryRun: options.dryRun });
  for (const file of files) {
    if (options.dryRun) {
      write(`将安装：${file.path}`);
    } else if (applied.written.includes(file.path)) {
      write(`已安装：${file.path}`);
    }
  }
  for (const failure of applied.failures) {
    write(failure);
  }
  return applied.failures.length > 0 ? 1 : 0;
}

function runRemoveCommand(options) {
  const result = removeShims({ home: options.home, dryRun: options.dryRun });
  for (const entry of result.entries) {
    const line = removeEntryLine(entry);
    if (line !== null) {
      write(line);
    }
  }
  for (const failure of result.failures) {
    write(failure);
  }
  return result.failures.length > 0 ? 1 : 0;
}

/* 删除结果 → 输出行；失败条目由 failures 行承担详情，返回 null 不误报「已删除」。 */
function removeEntryLine(entry) {
  if (entry.status === 'planned') {
    return `将删除：${entry.path}`;
  }
  if (entry.status === 'removed') {
    return `已删除：${entry.path}`;
  }
  if (entry.status === 'absent') {
    return `不存在，跳过：${entry.path}`;
  }
  return null;
}

/* 参数解析：--home 必须带取值且必填——绝不隐式回落真实家目录（防误触）。 */
function parseCliArgs(argv) {
  /** @type {{ command: string, home: string, dryRun: boolean, error: string | null }} */
  const options = { command: argv[0] ?? '', home: '', dryRun: false, error: null };
  if (options.command !== 'install' && options.command !== 'remove') {
    options.error = `未知子命令：${options.command === '' ? '(缺省)' : options.command}`;
    return options;
  }
  for (let index = 1; index < argv.length; index += 1) {
    index += readCliArg(options, argv, index);
    if (options.error !== null) {
      return options;
    }
  }
  if (options.home === '') {
    options.error = '缺少 --home（目标家目录）';
  }
  return options;
}

/* 单个参数归并进 options：--dry-run 不消费后继；--home 消费下一参数为取值（返回消费个数）。 */
function readCliArg(options, argv, index) {
  const arg = argv[index];
  if (arg === '--dry-run') {
    options.dryRun = true;
    return 0;
  }
  if (arg !== '--home') {
    options.error = `未知参数：${arg}`;
    return 0;
  }
  const value = argv[index + 1] ?? '';
  if (value === '' || value.startsWith('--')) {
    options.error = `${arg} 缺少取值`;
    return 0;
  }
  options.home = value;
  return 1;
}

function write(text) {
  process.stdout.write(`${text}\n`);
}

/* 输出被截断（如管道到 head）时 stdout 的 EPIPE 默认冒泡为未捕获异常——CLI 输出属尽力而为，
 * 管道断开按正常结束处理；按监听器身份幂等，重复调用不叠加。 */
function onStdoutError(error) {
  if (error?.code === 'EPIPE') {
    process.exit(0);
  }
}

function guardBrokenPipe() {
  if (!process.stdout.listeners('error').includes(onStdoutError)) {
    process.stdout.on('error', onStdoutError);
  }
}

const invokedAsMain = resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url);
if (invokedAsMain) {
  process.exitCode = runCli(process.argv.slice(2));
}
