import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { MANAGED_MARKER, applyRemoveCommands, planRemoveCommands } from './claude-commands.js';
import { removeShims } from './install-shims.js';
import { looksLikeStationDataDir, purgePathRefusal } from './purge.js';
import { resolveDataDir } from './paths.js';
import { readCoreStatus, stopCore as defaultStopCore, stopOutcomeSettled } from './core-cli.js';

/* `waystation uninstall` 子命令（设计「安装与配置」节的卸载命令形态）：先停核心（有核心在跑且
 * 拒停即拒绝卸载——否则残留 detached 核心持有已删目录，与观察窗启动器残留同族）→ 注销 MCP 注册 →
 * 移除随装的斜杠命令 → 删除可执行 shim → 尽力删除安装目录 → 数据目录默认保留（--purge-data 才删）。
 * **安装面与数据目录可能不同位**：两安装脚本恒把 app/shim 装到 <HOME>/.waystation 布局
 * （不读 WAYSTATION_HOME），数据目录则经 resolveDataDir 解析（尊重 WAYSTATION_HOME）——
 * 故 app/shim 按安装布局定位、purge 目标按数据目录解析（见 runUninstallCli 与 USAGE）。
 * 与安装脚本的 --uninstall / -Uninstall 开关在默认布局下等价共存（脚本不读 WAYSTATION_HOME，
 * 自定义数据目录场景以本命令为准；脚本整目录删除更直接；本命令从安装副本内运行时删除自身目录
 * 可能失败——失败原样给手动指引，不重试、不吞错）。
 * 输出走 stdout：它是 CLI 的用户输出通道、不参与 MCP 服务路径（stdout 纪律扫描对该文件显式豁免，
 * 见 test/stdout-discipline.test.js 的豁免清单）；bin 只在 uninstall 分支动态导入本模块。
 * 命令执行与家目录经注入缝：单测不触真实 claude CLI 与真实家目录。 */

const USAGE_LINES = [
  '用法：',
  '  waystation uninstall              卸载（先停核心，再注销 MCP 注册、移除斜杠命令、删可执行与安装目录；保留数据目录）',
  '  waystation uninstall --purge-data 连数据目录一起删除（含全部协作数据）',
  '  waystation uninstall --dry-run    预览：只打印将执行的动作，不改动任何文件与系统设置',
  '',
  '（默认布局下与安装脚本的 --uninstall / -Uninstall 开关等价；自定义 WAYSTATION_HOME 时以本命令为准，脚本不读该变量。）',
  '（安装面按 HOME 布局定位：<HOME>/.waystation 与 ~/.local/bin；数据目录按 WAYSTATION_HOME 环境变量解析。）',
];

export function parseUninstallArgs(argv) {
  /** @type {{ dryRun: boolean, purgeData: boolean, help: boolean, unknown: string[] }} */
  const options = { dryRun: false, purgeData: false, help: false, unknown: [] };
  for (const arg of argv) {
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--purge-data') {
      options.purgeData = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      options.unknown.push(arg);
    }
  }
  return options;
}

/**
 * @param {{ argv?: string[], env?: Record<string, string | undefined>, home?: string,
 *   runCommand?: (command: string, args: string[]) => { ok: boolean, code: number | null, output: string, missing: boolean },
 *   stopCore?: (options: { env: Record<string, string | undefined> }) => Promise<{ outcome: string, message: string }> }} [options]
 */
export async function runUninstallCli({ argv = [], env = process.env, home = homedir(), runCommand = defaultRunCommand, stopCore = defaultStopCore } = {}) {
  guardBrokenPipe();
  const parsed = parseUninstallArgs(argv);
  if (parsed.help) {
    write(`${USAGE_LINES.join('\n')}\n`);
    return 0;
  }
  if (parsed.unknown.length > 0) {
    write(`未知参数：${parsed.unknown.join('、')}\n${USAGE_LINES.join('\n')}\n`);
    return 1;
  }
  return runUninstallSteps(parsed, { env, home, runCommand, stopCore });
}

/* 卸载步骤链（逐条打印进度与结果）：停核被拒即在此停手，其余步骤不执行。 */
async function runUninstallSteps(parsed, { env, home, runCommand, stopCore }) {
  const dataDir = resolveDataDir(env);
  /* 安装面恒按 HOME 布局（两安装脚本都装到 <HOME>/.waystation，不读 WAYSTATION_HOME）——
   * 与数据目录可能不同位（WAYSTATION_HOME 显式场景）：app/shim 找安装布局、purge 走数据目录。 */
  const installDir = join(home, '.waystation');
  write(parsed.dryRun ? '=== waystation 卸载（dry-run：只打印，不改动）===' : '=== waystation 卸载 ===');
  const refusal = await stopCoreStep(parsed, { env, stopCore });
  if (refusal !== null) {
    return refusal;
  }
  removeRegistration(parsed, runCommand);
  removeCommands(parsed, home);
  removeExecutables(parsed, installDir, home);
  removeAppDir(parsed, join(installDir, 'app'));
  return handleDataDir(parsed, dataDir, home);
}

/* 步骤 1/6：先停核心（无核心跳过）。拒停即在上一步停手——删除安装目录会留下持有已删目录的
 * detached 核心；dry-run 只做只读探测并把结果如实告知（执行时才真正停核心）。 */
async function stopCoreStep(parsed, { env, stopCore }) {
  write('1/6 停止核心');
  if (parsed.dryRun) {
    const status = readCoreStatus({ env });
    if (status.kind === 'absent' || status.kind === 'stale') {
      write('    当前无核心运行，将跳过（若执行时有核心在跑会先停止它）');
    } else if (status.kind === 'unreadable') {
      write('    运行描述符不可解析——执行时停核心将失败并据此拒绝卸载');
    } else if (status.record.status === 'waiting') {
      /* 等待核不监听 IPC，无授权时停核必被拒——预览即点明，免得用户执行时才撞上 */
      write(`    检测到等待接管核（pid ${status.record.pid}，status=waiting）——执行时停核将被拒绝；请先运行 waystation core stop --force`);
    } else {
      write(`    检测到核心运行中（pid ${status.record.pid}）——执行时将先停止核心；核心拒绝停止时将拒绝卸载`);
    }
    write('    （范围＝单核形态的核心；升级窗口里旧版「每会话站点」进程请先关闭旧会话）');
    return null;
  }
  const result = await stopCore({ env });
  write(`    ${result.message}`);
  if (stopOutcomeSettled(result.outcome)) {
    return null;
  }
  write('    拒绝卸载：请先按上面的指引停止核心后重跑（waystation core stop --force 可强制处理）；未做任何改动');
  return 1;
}

function removeRegistration(parsed, runCommand) {
  write('2/6 注销 MCP 注册（claude mcp remove -s user waystation）');
  if (parsed.dryRun) {
    write('    将执行：claude mcp remove -s user waystation（未注册时该命令报错，属预期）');
    return;
  }
  const removed = runCommand('claude', ['mcp', 'remove', '-s', 'user', 'waystation']);
  if (removed.missing) {
    write('    未找到 claude CLI；如以后需要，可手工执行：claude mcp remove -s user waystation');
    return;
  }
  if (removed.ok) {
    write('    已注销：waystation');
    return;
  }
  write(`    未注销（多为本来就没注册）：${String(removed.output).split('\n')[0]}`);
}

/* 斜杠命令是安装时写入用户级命令目录的受管文件——删除面只认受管标记（判定与删除动作都落在
 * src/claude-commands.js 的单一权威），用户自放的同名/异名文件一律不动；目录读取异常不中断
 * 卸载，给手工指引后继续其余清理。 */
function removeCommands(parsed, home) {
  write('3/6 删除斜杠命令');
  try {
    const plan = planRemoveCommands({ home, dryRun: parsed.dryRun });
    if (!plan.dirExists) {
      write(`    不存在，跳过：${plan.commandsDir}`);
      return;
    }
    if (plan.files.length === 0) {
      write(`    无受管文件，跳过：${plan.commandsDir}`);
      return;
    }
    const removed = applyRemoveCommands(plan);
    for (const entry of plan.files) {
      if (parsed.dryRun) {
        write(`    将删除：${entry.targetPath}`);
      } else if (removed.removed.includes(entry.fileName)) {
        write(`    已删除：${entry.targetPath}`);
      }
    }
    for (const failure of removed.failures) {
      write(`    ${failure}`);
    }
  } catch (error) {
    write(`    失败：${error?.message}——请手动删除 ~/.claude/commands/ 下带 ${MANAGED_MARKER} 标记的文件`);
  }
}

/* 两平台安装脚本的可执行放置点都在候选内：Windows shim 在 <HOME>/.waystation/bin 下、Linux shim 在家目录 .local/bin。 */
function removeExecutables(parsed, installDir, home) {
  write('4/6 删除可执行');
  const shims = [join(installDir, 'bin', 'waystation.cmd'), join(home, '.local', 'bin', 'waystation')];
  for (const shim of shims) {
    if (parsed.dryRun) {
      write(`    将删除（若存在）：${shim}`);
      continue;
    }
    if (!existsSync(shim)) {
      write(`    不存在，跳过：${shim}`);
      continue;
    }
    try {
      rmSync(shim, { force: true });
      write(`    已删除：${shim}`);
    } catch (error) {
      write(`    删除失败：${error?.message}——请手动删除：${shim}`);
    }
  }
  removeViewerShims(parsed, home);
}

/* 观察窗三件套（ws-view.cmd / ws-view.vbs / ~/.local/bin/ws-view）：移除规格与安装面同一权威
 * （src/install-shims.js 的 removeShims），此处只消费结果、不复制路径清单；三件套一并清理，
 * 与上面两个主 shim 的两平台口径一致。逐文件记账：单文件失败不中断其余（失败行承担详情，
 * 不误报「已删除」）。 */
function removeViewerShims(parsed, home) {
  try {
    const viewer = removeShims({ home, dryRun: parsed.dryRun });
    for (const entry of viewer.entries) {
      if (entry.status === 'planned') {
        write(`    将删除：${entry.path}`);
      } else if (entry.status === 'removed') {
        write(`    已删除：${entry.path}`);
      } else if (entry.status === 'absent') {
        write(`    不存在，跳过：${entry.path}`);
      }
    }
    for (const failure of viewer.failures) {
      write(`    ${failure}`);
    }
  } catch (error) {
    write(`    失败：${error?.message}——请手动删除 ~/.waystation/bin 与 ~/.local/bin 下的 ws-view 启动器`);
  }
}

/* 删除自身安装目录：从安装副本内运行时可能被占用（如 Windows 文件锁）——失败给手动指引。 */
function removeAppDir(parsed, appDir) {
  write('5/6 删除安装目录');
  if (parsed.dryRun) {
    write(`    将删除：${appDir}`);
    return;
  }
  if (!existsSync(appDir)) {
    write(`    不存在，跳过：${appDir}`);
    return;
  }
  try {
    rmSync(appDir, { recursive: true, force: true });
    write(`    已删除：${appDir}`);
  } catch (error) {
    write(`    删除失败（可能正被使用）：${error?.message}`);
    write(`    请手动删除：${appDir}`);
  }
}

function handleDataDir(parsed, dataDir, home) {
  write('6/6 数据目录');
  if (!parsed.purgeData) {
    write(`    按默认保留（含协作数据）：${dataDir}`);
    write('    如确认不再需要，加 --purge-data 重跑即可删除');
    return 0;
  }
  /* 守卫（三重，含 dry-run 预检——预览与真实执行同一判据）：数据目录位置由 HOME / WAYSTATION_HOME
   * 派生、不接受子命令参数覆盖；路径层与「内容形态」判据与 purge-data 共用（src/purge.js 的
   * purgePathRefusal / looksLikeStationDataDir）——WAYSTATION_HOME 指向任意目录时，
   * 防「一次输入换一次灭顶删除」；脚本侧守卫要求路径以 .waystation 结尾，为更严的对照面。
   * 注意：本命令是整目录删除（卸载场景不适用保留清单），删除面与 purge-data 不同。 */
  const resolved = resolve(dataDir);
  const pathRefusal = purgePathRefusal(resolved, home);
  if (pathRefusal !== null) {
    write(`    拒绝删除：${pathRefusal}`);
    return 1;
  }
  if (!existsSync(resolved)) {
    write(`    不存在，跳过：${resolved}`);
    return 0;
  }
  if (!looksLikeStationDataDir(resolved)) {
    write(`    拒绝删除：目录内容不像驿站数据目录（无 config.json / collabs / sessions）：${resolved}`);
    return 1;
  }
  if (parsed.dryRun) {
    write(`    将删除：${resolved}（含全部协作数据）`);
    return 0;
  }
  try {
    rmSync(resolved, { recursive: true, force: true });
    write(`    已删除：${resolved}（含全部协作数据）`);
    return 0;
  } catch (error) {
    write(`    删除失败：${error?.message}——请手动删除：${resolved}`);
    return 1;
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

/* 默认命令执行器：同步执行、只以退出码与输出为准（spawn 失败折算为 missing / 错误文本，绝不抛出）。
 * 导出供单测直测真实进程映射（missing 分支承载「未找到 claude CLI」UX，注入执行器的用例覆盖不到它）。 */
export function defaultRunCommand(command, args) {
  try {
    const result = spawnSync(command, args, { encoding: 'utf8' });
    if (result.error) {
      return { ok: false, code: null, output: result.error.message, missing: (/** @type {NodeJS.ErrnoException} */ (result.error)).code === 'ENOENT' };
    }
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    return { ok: result.status === 0, code: result.status, output, missing: false };
  } catch (error) {
    return { ok: false, code: null, output: error?.message ?? '未知错误', missing: false };
  }
}
