import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { COLLABS_DIR_NAME, CONFIG_FILE_NAME, SESSIONS_DIR_NAME, SITES_DIR_NAME, resolveDataDir } from './paths.js';
import { INSTANCE_ID_FILE } from './instance-id.js';
import { SLOT_COUNT } from './site.js';
import { readCoreStatus, stopCore as defaultStopCore, stopOutcomeSettled } from './core-cli.js';

/* `waystation purge-data` 子命令：清空数据目录下的一切协作数据，只保留身份与安装面。
 * 保留清单（默认布局与自定义 WAYSTATION_HOME 同一套算法）：config.json、instance-id、app/、
 * bin/，以及 sites/<槽位>/ 下的同名身份二件套；顶层保留判定一律按名字、与条目类型无关
 * （符号链接 / junction 也原样保留），win32 下名字比对大小写不敏感——盘上以非规范大小写命名的
 * 条目应用照常可用，漏判等于删活身份。删除面取保留清单的补集——未来新增的文件 / 目录名
 * 自动归入删除面，故计划必须一次算清、预览与执行共用（预览即列全）。
 * 数据目录位置只由 resolveDataDir(env) 解析（不接受参数覆盖）；路径层与内容形态两道守卫
 * 与 uninstall 共用（本模块导出，uninstall.js 改用之）——uninstall --purge-data 是整目录
 * 删除（卸载场景不适用保留清单），两者只共享守卫、不共享删除面。
 * 输出走 stdout：它是 CLI 的用户输出通道、不参与 MCP 服务路径（stdout 纪律扫描对该文件显式
 * 豁免，见 test/stdout-discipline.test.js 的豁免清单）；bin 只在 purge-data 分支动态导入本模块。
 * 家目录与平台经注入缝：单测不触真实家目录、可注入 platform 在任意宿主上验证两种名字比对语义。 */

const USAGE_LINES = [
  '用法：',
  '  waystation purge-data        预览：列出将删除与保留的内容，不改动任何东西',
  '  waystation purge-data --yes  执行清理（保留身份与安装面，其余全部删除；不可恢复）',
  '',
  '（数据目录按 WAYSTATION_HOME 环境变量解析，默认 ~/.waystation；不接受参数覆盖。）',
  '（执行前先停止本机核心；核心拒绝停止时拒绝清理。）',
];

/* 保留清单的两个名字组：身份二件套与安装面都按名字判定，与条目类型无关（同名目录 / 链接也保留
 * ——宁留勿删：删除是危险方向，条目只在确定不属保留清单时才进删除面）。 */
const IDENTITY_FILE_NAMES = [CONFIG_FILE_NAME, INSTANCE_ID_FILE];
const INSTALL_DIR_NAMES = ['app', 'bin'];

/* 保留判定的名字比对：win32 文件系统大小写不敏感——盘上以非规范大小写命名的条目（如 Config.json、
 * App）应用照常可用，保留判定必须同样认到，否则会删掉仍生效的身份 / 安装面；其余平台按字节精确比对。 */
function matchesRetainedName(name, expected, platform) {
  if (platform === 'win32') {
    return name.toLowerCase() === expected.toLowerCase();
  }
  return name === expected;
}

function isRetainedName(name, names, platform) {
  return names.some((expected) => matchesRetainedName(name, expected, platform));
}

/* 内容形态判据的标记名（单一权威：判定与提示文案共用）。 */
const DATA_DIR_MARKER_NAMES = [CONFIG_FILE_NAME, COLLABS_DIR_NAME, SESSIONS_DIR_NAME];

/** @param {string[]} argv */
export function parsePurgeArgs(argv) {
  /** @type {{ execute: boolean, help: boolean, unknown: string[] }} */
  const options = { execute: false, help: false, unknown: [] };
  for (const arg of argv) {
    if (arg === '--yes') {
      options.execute = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      options.unknown.push(arg);
    }
  }
  return options;
}

/* 路径层守卫：文件系统根与用户家目录本身一律拒绝——purge-data 与 uninstall --purge-data 共用；
 * 两个命令的删除面不同，但「什么位置绝不能删」是同一件事。 */
export function purgePathRefusal(resolved, home) {
  if (resolve(resolved, '..') === resolved) {
    return `疑似文件系统根：${resolved}`;
  }
  if (resolved === resolve(home)) {
    return `用户家目录本身：${resolved}`;
  }
  return null;
}

/* 内容形态判据：config.json / collabs / sessions 任一存在即认作驿站数据目录——防
 * WAYSTATION_HOME 指向任意目录时「一次输入换一次灭顶删除」。调用方在删除前评估。 */
export function looksLikeStationDataDir(resolved) {
  return DATA_DIR_MARKER_NAMES.some((name) => existsSync(join(resolved, name)));
}

/**
 * @param {{ argv?: string[], env?: Record<string, string | undefined>, home?: string,
 *   platform?: NodeJS.Platform,
 *   stopCore?: (options: { env: Record<string, string | undefined>, allowForceOnWaiting: boolean }) => Promise<{ outcome: string, message: string }> }} [options]
 */
export async function runPurgeCli({ argv = [], env = process.env, home = homedir(), platform = process.platform, stopCore = defaultStopCore } = {}) {
  guardBrokenPipe();
  const options = parsePurgeArgs(argv);
  const argExit = preflightArgs(options);
  if (argExit !== null) {
    return argExit;
  }
  const checked = checkDataDir(resolveDataDir(env), home);
  if (!checked.ok) {
    write(checked.message);
    return checked.code;
  }
  return runPurgePipeline(options, checked.dataDir, { env, platform, stopCore });
}

/* 守卫通过后的执行链：先停核心 → 算计划（读不出即整体拒绝）→ 预览或执行。 */
async function runPurgePipeline(options, dataDir, { env, platform, stopCore }) {
  const stopExit = await handleCoreFirst(options, { env, stopCore });
  if (stopExit !== null) {
    return stopExit;
  }
  const plan = planPurgeOrRefuse(dataDir, platform);
  if (plan === null) {
    return 1;
  }
  return previewOrApply(options, plan);
}

/* 先停核心：核心持有被删目录会让旧进程继续写/持句柄（卸载面已确立同族先例）。预览只做只读探测
 * 与提示；执行先停核心、停不住即拒绝清理（等待核走清数据面的授权通道直接终止——它是零写驻留态）。 */
async function handleCoreFirst(options, { env, stopCore }) {
  if (!options.execute) {
    const status = readCoreStatus({ env });
    if (status.kind === 'healthy' || status.kind === 'zombie') {
      write(`注意：检测到核心在运行（pid ${status.record.pid}）——执行时将先停止核心；核心拒绝停止时将拒绝清理。`);
    }
    return null;
  }
  const result = await stopCore({ env, allowForceOnWaiting: true });
  write(`先停核心：${result.message}`);
  if (stopOutcomeSettled(result.outcome)) {
    return null;
  }
  write('拒绝清理：核心未能停止——请按上面的指引处理后重跑（未做任何改动）。');
  return 1;
}

/* 参数前置：--help / 未知参数先于一切文件系统动作处理；返回退出码，null = 参数无误、继续。 */
function preflightArgs(options) {
  if (options.help) {
    write(USAGE_LINES.join('\n'));
    return 0;
  }
  if (options.unknown.length > 0) {
    write(`未知参数：${options.unknown.join('、')}`);
    write(USAGE_LINES.join('\n'));
    return 1;
  }
  return null;
}

/* 预览或执行由 --yes 决定：预览只列计划、零写动作；执行逐条尽力删除、失败按条记账后折算退出码。 */
function previewOrApply(options, plan) {
  if (!options.execute) {
    reportPreview(plan);
    return 0;
  }
  const failures = applyPurge(plan);
  reportApplied(plan, failures);
  return failures.length > 0 ? 1 : 0;
}

/* 守卫（预览与执行同一判据，且先于任何删除动作）：路径层拒绝文件系统根 / 家目录本身；
 * 内容形态防 WAYSTATION_HOME 指向任意目录；目录不存在按「无事可做」跳过、非错误。 */
function checkDataDir(dataDir, home) {
  const resolved = resolve(dataDir);
  const refusal = purgePathRefusal(resolved, home);
  if (refusal !== null) {
    return { ok: false, code: 1, message: `拒绝清理：${refusal}`, dataDir: resolved };
  }
  if (!existsSync(resolved)) {
    return { ok: false, code: 0, message: `数据目录不存在，跳过：${resolved}`, dataDir: resolved };
  }
  const shape = DATA_DIR_MARKER_NAMES.join(' / ');
  if (!looksLikeStationDataDir(resolved)) {
    return { ok: false, code: 1, message: `拒绝清理：目录内容不像驿站数据目录（无 ${shape}）：${resolved}`, dataDir: resolved };
  }
  return { ok: true, code: 0, message: '', dataDir: resolved };
}

/* 计划阶段全程只读：读不到就无法按补集算法核清删除面（如 sites/ 读不出就无法逐个保住槽位
 * 身份）——宁可整体拒绝，不做部分动作。失败打印明确错误并返回 null（调用方按拒绝处理）。 */
function planPurgeOrRefuse(dataDir, platform) {
  try {
    return planPurge(dataDir, platform);
  } catch (error) {
    write(`拒绝清理：目录读取失败（未做任何改动）：${error?.message ?? String(error)}`);
    return null;
  }
}

/* 清理计划：一次算清、预览与执行共用（预览因此必然列全删除面）；条目按名字排序，输出稳定可读。
 * 顶层保留判定按名字、与条目类型无关（名字匹配即保留）；sites/ 是唯一要下钻的保留目录，且只有
 * 真目录（非符号链接 / junction）才下钻——链接指向的目标在数据目录树之外，删除面不穿出链接。 */
function planPurge(dataDir, platform) {
  const retained = [];
  const removable = [];
  for (const entry of sortByName(readdirSync(dataDir, { withFileTypes: true }))) {
    const absolutePath = join(dataDir, entry.name);
    if (isRetainedName(entry.name, IDENTITY_FILE_NAMES, platform) || isRetainedName(entry.name, INSTALL_DIR_NAMES, platform)) {
      retained.push(entry.isDirectory() ? `${entry.name}/` : entry.name);
    } else if (matchesRetainedName(entry.name, SITES_DIR_NAME, platform)) {
      retained.push(entry.isDirectory() ? `${entry.name}/` : entry.name);
      if (entry.isDirectory()) {
        planSitesDir(absolutePath, entry.name, retained, removable, platform);
      }
    } else {
      removable.push(describeEntry(absolutePath, entry.name));
    }
  }
  return { dataDir, retained, removable };
}

/* sites/ 下的槽位目录判定与 siteDataDir 的生成口径对齐（String(整数槽位)、2..SLOT_COUNT）：
 * 形态不符的条目不当作槽位、整条归入删除面（不猜、不越界删）；合法槽位目录只留身份二件套、
 * 其余子项逐个列入删除面——槽位目录本身保留，故自身也进保留清单（预览两个面都要列全）。 */
function planSitesDir(sitesPath, sitesName, retained, removable, platform) {
  for (const entry of sortByName(readdirSync(sitesPath, { withFileTypes: true }))) {
    const slotPath = join(sitesPath, entry.name);
    if (!entry.isDirectory() || slotNumberFor(entry.name) === null) {
      removable.push(describeEntry(slotPath, `${sitesName}/${entry.name}`));
      continue;
    }
    retained.push(`${sitesName}/${entry.name}/`);
    for (const child of sortByName(readdirSync(slotPath, { withFileTypes: true }))) {
      const childPath = join(slotPath, child.name);
      const display = `${sitesName}/${entry.name}/${child.name}`;
      if (isRetainedName(child.name, IDENTITY_FILE_NAMES, platform)) {
        retained.push(child.isDirectory() ? `${display}/` : display);
      } else {
        removable.push(describeEntry(childPath, display));
      }
    }
  }
}

/** @param {import('node:fs').Dirent[]} entries */
function sortByName(entries) {
  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

/* 槽位目录名：数字串且为规范形态（排除前导零）、槽位段内；其余一律不认。 */
function slotNumberFor(name) {
  if (!/^\d+$/.test(name) || name !== String(Number(name))) {
    return null;
  }
  const slot = Number(name);
  return slot >= 2 && slot <= SLOT_COUNT ? slot : null;
}

/* 删除面条目的展示口径：目录给「直接子项数」（协作条目数 / 会话文件数即由此读得）+ 递归字节，
 * 文件给自身字节。计量只统计常规文件、不跟随符号链接（防穿出数据目录或成环）。 */
function describeEntry(absolutePath, display) {
  const stats = measureTree(absolutePath);
  return { path: display, absolutePath, isDir: stats.isDir, entries: stats.entries, bytes: stats.bytes };
}

function measureTree(absolutePath) {
  const stats = statOrNull(absolutePath);
  if (stats === null) {
    return { isDir: false, entries: 0, bytes: 0 };   // 计划与执行之间条目消失：按零计
  }
  if (!stats.isDirectory()) {
    return { isDir: false, entries: 0, bytes: stats.isFile() ? stats.size : 0 };
  }
  const children = readChildrenOrNull(absolutePath);
  if (children === null) {
    return { isDir: true, entries: 0, bytes: 0 };
  }
  let bytes = 0;
  for (const child of children) {
    bytes += measureTree(join(absolutePath, child.name)).bytes;
  }
  return { isDir: true, entries: children.length, bytes };
}

/** @param {string} absolutePath @returns {import('node:fs').Stats | null} */
function statOrNull(absolutePath) {
  try {
    return lstatSync(absolutePath);
  } catch {
    return null;
  }
}

/** @param {string} absolutePath @returns {import('node:fs').Dirent[] | null} */
function readChildrenOrNull(absolutePath) {
  try {
    return readdirSync(absolutePath, { withFileTypes: true });
  } catch {
    return null;
  }
}

/* 执行删除：逐条尽力删除、失败逐条记账（不中断其余）——删除面是保留清单的补集，
 * 单条失败（占用 / 权限）不影响其余数据的清理。 */
function applyPurge(plan) {
  const failures = [];
  for (const entry of plan.removable) {
    try {
      rmSync(entry.absolutePath, { recursive: true, force: true });
    } catch (error) {
      failures.push({ path: entry.path, message: error?.message ?? String(error) });
    }
  }
  return failures;
}

function reportPreview(plan) {
  write('=== waystation 数据清理（预览：只列出计划，不改动任何东西）===');
  write(`数据目录：${plan.dataDir}`);
  reportRetained(plan.retained);
  if (plan.removable.length === 0) {
    write('将删除：无（已是干净状态——只剩保留清单内的内容）');
  } else {
    write('将删除：');
    let totalBytes = 0;
    for (const entry of plan.removable) {
      totalBytes += entry.bytes;
      write(`  ${entry.path}${entryDetail(entry)}`);
    }
    write(`  合计 ${plan.removable.length} 处，${formatBytes(totalBytes)}`);
  }
  write('确认执行请加 --yes（此操作不可恢复）。');
}

function reportApplied(plan, failures) {
  write('=== waystation 数据清理 ===');
  write(`数据目录：${plan.dataDir}`);
  reportRetained(plan.retained);
  const failed = new Map(failures.map((item) => [item.path, item.message]));
  if (plan.removable.length === 0) {
    write('已删除：无（已是干净状态——只剩保留清单内的内容）');
  } else {
    write('删除结果：');
    for (const entry of plan.removable) {
      if (failed.has(entry.path)) {
        write(`  删除失败：${entry.path}——${failed.get(entry.path)}`);
      } else {
        write(`  已删除：${entry.path}${entryDetail(entry)}`);
      }
    }
  }
  write(failed.size > 0 ? `完成，但有 ${failed.size} 处删除失败——请按上面的路径手工处理或重跑。` : '完成：身份与安装面按清单保留。');
}

function reportRetained(retained) {
  write('保留（身份与安装面）：');
  if (retained.length === 0) {
    write('  （无——数据目录里没有身份 / 安装面文件）');
    return;
  }
  for (const name of retained) {
    write(`  ${name}`);
  }
}

function entryDetail(entry) {
  return entry.isDir ? `（${entry.entries} 个子项，${formatBytes(entry.bytes)}）` : `（${formatBytes(entry.bytes)}）`;
}

/* 尺寸展示三档（B / KB / MB）：驿站数据目录的体量远小于 GB 档，不设更多档位。 */
function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
