import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* 斜杠命令随安装分发的唯一权威：目标目录定位、受管标记判定、安装/删除计划与执行。
 * 两个安装脚本与 waystation uninstall 只做调用与打印，不在脚本里复刻「哪些文件受管」的判断。
 * 输出走 stdout：它是本模块的用户/脚本输出通道，不参与 MCP 服务路径——本模块只 import node
 * 内置模块，服务路径（src/index.js）不引用它（stdout 纪律扫描对该文件显式豁免，见
 * test/stdout-discipline.test.js 的豁免清单）。家目录一律经参数传入，模块自身绝不隐式触碰
 * 真实 ~/.claude——测试全部走临时目录。 */

/* 受管标记：独立一行，落在 frontmatter 之后、正文首行——放正文可保证不影响 frontmatter 解析。 */
export const MANAGED_MARKER = '<!-- waystation-managed-command -->';

const USAGE_LINES = [
  '用法：',
  '  node src/claude-commands.js install --home <home> --source <dir> [--dry-run]',
  '  node src/claude-commands.js remove --home <home> [--dry-run]',
];

/* 目标目录 = 用户级 Claude Code 命令目录（平面摆放，不递归）。 */
export function commandsDirFor(home) {
  return join(home, '.claude', 'commands');
}

/**
 * 安装计划：按源集合逐个定动作并找出目标目录里的陈旧受管文件。只读——dry-run 与真实执行共用同一份计划。
 * @param {{ home: string, sourceDir: string, dryRun?: boolean }} options
 */
export function planInstallCommands({ home, sourceDir, dryRun = false }) {
  const commandsDir = commandsDirFor(home);
  const dirExists = existsSync(commandsDir);
  const sources = readSourceCommands(sourceDir);
  const sourceNames = new Set(sources.map((entry) => entry.fileName));
  const files = sources.map((entry) => {
    const targetPath = join(commandsDir, entry.fileName);
    return { ...entry, targetPath, action: installActionFor(targetPath) };
  });
  const stale = dirExists ? listManagedFiles(commandsDir).filter((entry) => !sourceNames.has(entry.fileName)) : [];
  return { dryRun, commandsDir, dirExists, files, stale };
}

/**
 * 执行安装计划（dry-run 零写入；目录缺失先创建）。逐文件进行：个别文件写入/清理失败不中断其余，
 * 汇总进 failures 由调用方处置（退出码与手工指引）。
 * @param {ReturnType<typeof planInstallCommands>} plan
 */
export function applyInstallCommands(plan) {
  /** @type {{ createdDir: boolean, written: string[], cleaned: string[], failures: string[] }} */
  const applied = { createdDir: false, written: [], cleaned: [], failures: [] };
  if (plan.dryRun) {
    return applied;
  }
  if (!plan.dirExists) {
    mkdirSync(plan.commandsDir, { recursive: true });
    applied.createdDir = true;
  }
  for (const entry of plan.files) {
    if (entry.action === 'skip') {
      continue;
    }
    try {
      copyFileSync(entry.sourcePath, entry.targetPath);
      applied.written.push(entry.fileName);
    } catch (error) {
      applied.failures.push(`写入失败：${entry.fileName}——${error?.message}`);
    }
  }
  for (const entry of plan.stale) {
    try {
      rmSync(entry.targetPath, { force: true });
      applied.cleaned.push(entry.fileName);
    } catch (error) {
      applied.failures.push(`清理失败：${entry.fileName}——${error?.message}`);
    }
  }
  return applied;
}

/**
 * 删除计划：目标目录下带受管标记的 *.md（无标记文件一律不动；目录缺失即空计划）。
 * @param {{ home: string, dryRun?: boolean }} options
 */
export function planRemoveCommands({ home, dryRun = false }) {
  const commandsDir = commandsDirFor(home);
  const dirExists = existsSync(commandsDir);
  const files = dirExists ? listManagedFiles(commandsDir) : [];
  return { dryRun, commandsDir, dirExists, files };
}

/**
 * 执行删除计划（dry-run 零写入）。逐文件进行：个别删除失败不中断其余。
 * @param {ReturnType<typeof planRemoveCommands>} plan
 */
export function applyRemoveCommands(plan) {
  /** @type {{ removed: string[], failures: string[] }} */
  const applied = { removed: [], failures: [] };
  if (plan.dryRun || !plan.dirExists) {
    return applied;
  }
  for (const entry of plan.files) {
    try {
      rmSync(entry.targetPath, { force: true });
      applied.removed.push(entry.fileName);
    } catch (error) {
      applied.failures.push(`删除失败：${entry.fileName}——${error?.message}`);
    }
  }
  return applied;
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
  const plan = planInstallCommands(options);
  const applied = applyInstallCommands(plan);
  reportInstall(plan, applied);
  return applied.failures.length > 0 ? 1 : 0;
}

function runRemoveCommand(options) {
  const plan = planRemoveCommands(options);
  const applied = applyRemoveCommands(plan);
  reportRemove(plan, applied);
  return applied.failures.length > 0 ? 1 : 0;
}

/* 参数解析：--home/--source 必须带取值且 home 必填——绝不隐式回落真实家目录（防误触）。 */
function parseCliArgs(argv) {
  /** @type {{ command: string, home: string, sourceDir: string, dryRun: boolean, error: string | null }} */
  const options = { command: argv[0] ?? '', home: '', sourceDir: '', dryRun: false, error: null };
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
  validateCliArgs(options);
  return options;
}

/* 单个参数归并进 options：--dry-run 不消费后继；--home/--source 消费下一参数为取值（返回消费个数）。 */
function readCliArg(options, argv, index) {
  const arg = argv[index];
  if (arg === '--dry-run') {
    options.dryRun = true;
    return 0;
  }
  if (arg !== '--home' && arg !== '--source') {
    options.error = `未知参数：${arg}`;
    return 0;
  }
  const value = argv[index + 1] ?? '';
  if (value === '' || value.startsWith('--')) {
    options.error = `${arg} 缺少取值`;
    return 0;
  }
  if (arg === '--home') {
    options.home = value;
  } else {
    options.sourceDir = value;
  }
  return 1;
}

function validateCliArgs(options) {
  if (options.home === '') {
    options.error = '缺少 --home（目标家目录）';
  } else if (options.command === 'install' && options.sourceDir === '') {
    options.error = '缺少 --source（命令源目录）';
  }
}

/* 目标不存在 → 新装；已存在且带受管标记 → 覆盖；否则视为用户自有文件，跳过不覆盖。 */
function installActionFor(targetPath) {
  if (!existsSync(targetPath)) {
    return 'install';
  }
  return hasManagedMarker(readFileSync(targetPath, 'utf8')) ? 'update' : 'skip';
}

/* 源集合 = 源目录下的 *.md（按文件名排序，输出与动作顺序稳定）；目录缺失属调用方装配错误，响亮抛出。 */
function readSourceCommands(sourceDir) {
  if (!existsSync(sourceDir)) {
    throw new Error(`命令源目录不存在：${sourceDir}`);
  }
  return readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => ({ fileName: entry.name, sourcePath: join(sourceDir, entry.name) }))
    .sort((left, right) => left.fileName.localeCompare(right.fileName));
}

/* 目标目录里的受管文件（平面扫描、不递归——命令目录按 Claude Code 的平面约定摆放）。 */
function listManagedFiles(commandsDir) {
  return readdirSync(commandsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => ({ fileName: entry.name, targetPath: join(commandsDir, entry.name) }))
    .filter((entry) => hasManagedMarker(readFileSync(entry.targetPath, 'utf8')))
    .sort((left, right) => left.fileName.localeCompare(right.fileName));
}

function hasManagedMarker(content) {
  return content.split('\n').some((line) => line.trim() === MANAGED_MARKER);
}

function reportInstall(plan, applied) {
  if (!plan.dirExists) {
    write(plan.dryRun ? `目录不存在，将创建：${plan.commandsDir}` : `目录不存在，已创建：${plan.commandsDir}`);
  }
  for (const entry of plan.files) {
    const line = installEntryLine(entry, plan, applied);
    if (line !== null) {
      write(line);
    }
  }
  for (const entry of plan.stale) {
    if (!plan.dryRun && !applied.cleaned.includes(entry.fileName)) {
      continue;   // 清理失败的条目由 failures 行承担，不误报「已清理」
    }
    write(`${plan.dryRun ? '将' : '已'}清理陈旧受管命令：${entry.fileName}`);
  }
  for (const failure of applied.failures) {
    write(failure);
  }
}

/* 计划条目 → 输出行；写入失败的条目由 failures 行承担，返回 null 不误报「已安装」。 */
function installEntryLine(entry, plan, applied) {
  if (entry.action === 'skip') {
    const notice = `同名非受管文件未覆盖（如系旧手工副本，请手工删除后重跑，或手工替换）：${entry.fileName}`;
    return plan.dryRun ? `将跳过——${notice}` : notice;
  }
  if (!plan.dryRun && !applied.written.includes(entry.fileName)) {
    return null;
  }
  const verb = entry.action === 'install' ? '安装' : '更新';
  return `${plan.dryRun ? '将' : '已'}${verb}：${entry.fileName}`;
}

function reportRemove(plan, applied) {
  if (!plan.dirExists) {
    write(`不存在，跳过：${plan.commandsDir}`);
    return;
  }
  if (plan.files.length === 0) {
    write(`无受管文件，跳过：${plan.commandsDir}`);
    return;
  }
  for (const entry of plan.files) {
    if (plan.dryRun) {
      write(`将删除：${entry.targetPath}`);
    } else if (applied.removed.includes(entry.fileName)) {
      write(`已删除：${entry.targetPath}`);
    }
  }
  for (const failure of applied.failures) {
    write(failure);
  }
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
