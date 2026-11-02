import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { makeTempDir, repoRoot } from './helpers.js';

/* bash 探测：Windows 走 git-bash、Linux 天然可用；不可用则用例跳过（.ps1 臂由主控在真机上跑）。
 * claude 桩：dry-run 路径只对 claude 做存在性判定（command -v）、不会真正执行它，桩只需能被找到；
 * PATH 前插桩目录把「未装 claude CLI」分支换成「已装」分支，让安装的 5/6 与卸载的 2/5 真走到
 * 命令行模块——这样断言的是模块计划专属输出（受管文件名），而不是两条臂无条件都打印的通用文案。
 * 脚本经 HOME 指向临时目录 + dry-run 运行——只读检测与打印，不触碰真实家目录。 */
const bashProbe = spawnSync('bash', ['-c', 'exit 0']);
const bashAvailable = bashProbe.error === undefined && bashProbe.status === 0;

/* PowerShell -File 探测：ps1 沙箱用例的前置条件（非 win32 / 无 PowerShell / 执行策略禁跑本地脚本
 * 一律跳过——受限宿主不得让该用例假红）。 */
const powershellAvailable = powershellFileRuns();

function powershellFileRuns() {
  if (process.platform !== 'win32') {
    return false;
  }
  const probeDir = mkdtempSync(join(tmpdir(), 'waystation-ps1-probe-'));
  try {
    const probePath = join(probeDir, 'probe.ps1');
    writeFileSync(probePath, 'exit 0\n');
    const probe = spawnSync('powershell', ['-NoProfile', '-File', probePath], { encoding: 'utf8', timeout: 30000 });
    return probe.error === undefined && probe.status === 0;
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}

const MANAGED_MARKER = '<!-- waystation-managed-command -->';

function makeClaudeStub(t) {
  const binDir = join(makeTempDir(t), 'stub-bin');
  mkdirSync(binDir, { recursive: true });
  const stubPath = join(binDir, 'claude');
  writeFileSync(stubPath, '#!/bin/sh\nexit 0\n');
  chmodSync(stubPath, 0o755);
  return binDir;
}

function runInstallScript(t, args, home = makeTempDir(t), extraEnv = {}) {
  const stubDir = makeClaudeStub(t);
  const result = spawnSync('bash', [join(repoRoot, 'install', 'install.sh'), ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    /* 上限兜底：真实执行路径若挂住（如误选旧入口读 stdin），以失败收场而不是把测试进程拖死。 */
    timeout: 60000,
    env: {
      ...process.env,
      HOME: home.replace(/\\/g, '/'),
      PATH: `${stubDir}${delimiter}${process.env.PATH}`,
      ...extraEnv,
    },
  });
  return { home, result };
}

test('安装脚本 --dry-run：5/6 走到命令行模块（含六个受管文件名）、HOME 下零写入', (t) => {
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
  /* 单核口径：端口指引为「显式值或锚点、无槽位段」（旧槽位文案不得残留）；升级换代指引进首检清单。 */
  assert.ok(result.stdout.includes('锚点端口'), `端口指引应为单核口径：${result.stdout}`);
  assert.ok(result.stdout.includes('无槽位段'), `端口指引应注明无槽位段：${result.stdout}`);
  assert.ok(!result.stdout.includes('槽位 1 可用'), `旧槽位文案不得残留：${result.stdout}`);
  assert.ok(result.stdout.includes('升级后重开会话即自动换代'), `应打印升级换代指引：${result.stdout}`);
  assert.ok(result.stdout.includes('升级期间避免新建会话'), `应打印升级窗口纪律：${result.stdout}`);
  /* 核心入口随 bin/ 整目录拷贝：dry-run 打印整目录拷贝项；源文件存在是「自动随行」的前提。 */
  assert.ok(result.stdout.includes('将清理并重新拷贝：bin/'), `dry-run 应按整目录拷贝 bin/：${result.stdout}`);
  assert.equal(existsSync(join(repoRoot, 'bin', 'waystation-core.js')), true, '核心入口就位于 bin/（无需改拷贝清单）');
  assert.equal(existsSync(join(home, '.claude')), false, 'dry-run 不得创建 ~/.claude');
  assert.equal(existsSync(join(home, '.waystation')), false, 'dry-run 不得创建安装目录');
});

test('安装脚本源：两平台文案点（端口单核口径 / 升级指引 / 卸载先停核）＋bin/ 整目录拷贝面', () => {
  const shText = readFileSync(join(repoRoot, 'install', 'install.sh'), 'utf8');
  const psText = readFileSync(join(repoRoot, 'install', 'install.ps1'), 'utf8');
  assert.ok(shText.includes('cp -R "${REPO_ROOT}/bin"'), 'sh 臂按整目录拷贝 bin/（核心入口自动随行）');
  assert.ok(psText.includes("@('bin', 'src')"), 'ps1 臂按整目录拷贝 bin/ 与 src/（核心入口自动随行）');
  for (const [name, text] of [['install.sh', shText], ['install.ps1', psText]]) {
    assert.ok(text.includes('无槽位段'), `${name}：端口指引应为单核口径（端口＝显式值或锚点、无槽位段）`);
    assert.ok(!text.includes('export const SLOT_COUNT'), `${name}：不应再读 SLOT_COUNT（槽位退役）`);
    assert.ok(text.includes('升级后重开会话即自动换代') && text.includes('升级期间避免新建会话'), `${name}：升级指引与窗口纪律`);
    assert.ok(text.includes('core stop'), `${name}：卸载臂应先停核心`);
    assert.ok(text.includes('拒绝'), `${name}：核心拒停的拒绝语义文案`);
    assert.ok(text.includes('每会话站点'), `${name}：停核范围边界应点明（旧版每会话站点进程不在步骤内）`);
  }
  /* 停核入口＝脚本自身树优先（源码口径钉住；功能面由下一条集成用例钉住）：安装副本可能是旧版、
   * 不理解 core 子命令——误拉起服务会导致交互挂起 / stdin EOF 假绿。 */
  assert.ok(shText.includes('local entry="${REPO_ROOT}/bin/waystation.js"'), 'sh 臂停核入口应优先脚本自身树');
  assert.ok(shText.includes('core stop </dev/null'), 'sh 臂停核调用应接 /dev/null，屏蔽交互读流');
  assert.ok(shText.includes('timeout 30 node'), 'sh 臂停核调用应有 30s 上限兜底');
  const psEntry = psText.indexOf('$repoEntry = Join-Path $RepoRoot');
  const psAppEntry = psText.indexOf('$appEntry = Join-Path $AppDir');
  assert.ok(psEntry >= 0 && psAppEntry > psEntry, 'ps1 臂停核入口应优先脚本自身树（AppDir 仅作回退）');
  assert.ok(psText.includes('$proc.StandardInput.Close()'), 'ps1 臂停核调用应关闭 stdin，屏蔽交互读流');
  assert.ok(psText.includes('WaitForExit(30000)'), 'ps1 臂停核调用应有 30s 上限兜底');
  /* install.ps1 必须保留 UTF-8 BOM：PS 5.1 对无 BOM 文件按系统 ANSI 读，中文注释会被解码成乱码字节、
   * 可能把注释行错拼进代码；抽取该脚本函数做重放验证的工具链同样依赖 BOM 前提。 */
  assert.equal(readFileSync(join(repoRoot, 'install', 'install.ps1')).subarray(0, 3).toString('hex'), 'efbbbf', 'install.ps1 须保留 UTF-8 BOM');
});

test('卸载脚本 --uninstall --dry-run：先停核心（1/6）、3/6 走到命令行模块（将删除 + 受管文件名）、零写入', (t) => {
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
  assert.ok(result.stdout.includes('[1/6] 停止核心') && result.stdout.includes('将停止核心'), `卸载臂第 1 步应为先停核心：${result.stdout}`);
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

test('卸载臂停核入口（集成）：旧版安装副本在场时不优先选用——脚本树入口作答、旧副本零调用（不挂起/不假绿）', (t) => {
  if (!bashAvailable) {
    t.skip('bash 不可用（Windows 需 git-bash；.ps1 臂由主控真机验证）');
    return;
  }
  const home = makeTempDir(t);
  const dataDir = makeTempDir(t);   // WAYSTATION_HOME：停核对证目标（空根＝无核心，退出 0 放行）
  /* 旧版安装副本桩：被选用即写标记、打印旧版行、随后等 stdin EOF 退出 1——「旧版入口把子命令误当
   * 服务拉起」的等价行为。若实现回退为「AppDir 优先」：旧版行进输出、标记落盘、卸载以 1 收场，
   * 本用例三条断言同时红（且 spawnSync 上限兜住挂起变体）。 */
  const legacyDir = join(home, '.waystation', 'app', 'bin');
  mkdirSync(legacyDir, { recursive: true });
  const markerPath = join(home, 'legacy-entry-invoked');
  writeFileSync(join(legacyDir, 'waystation.js'), [
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(markerPath)}, 'invoked');`,
    "console.log('LEGACY-ENTRY-INVOKED');",
    "process.stdin.on('data', () => {});",
    'process.stdin.on("end", () => process.exit(1));',
  ].join('\n'));
  const { result } = runInstallScript(t, ['--uninstall'], home, { WAYSTATION_HOME: dataDir });
  assert.equal(result.status, 0, `退出码非 0（旧副本被选用会在此以 1 收场）；stdout：${result.stdout}`);
  assert.ok(result.stdout.includes('无核心在运行'), `停核应由脚本树入口作答（无核跳过）：${result.stdout}`);
  assert.ok(!result.stdout.includes('LEGACY-ENTRY-INVOKED'), '旧版安装副本不得被调用');
  assert.equal(existsSync(markerPath), false, '旧版安装副本零调用（标记文件不得出现）');
  assert.equal(existsSync(join(home, '.waystation', 'app')), false, '停核通过后卸载照常继续（安装目录已删）');
});

/* 旧版安装副本桩（ps1 臂同款）：被选用即写标记、打印旧版行、等 stdin、EOF 退 1——「旧版入口把 core
 * 子命令误当服务拉起」两变体（交互挂起 / stdin EOF 假绿）的统一等价行为。 */
function writeLegacyEntryStub(home) {
  const legacyDir = join(home, '.waystation', 'app', 'bin');
  mkdirSync(legacyDir, { recursive: true });
  const markerPath = join(home, 'legacy-entry-invoked');
  writeFileSync(join(legacyDir, 'waystation.js'), [
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(markerPath)}, 'invoked');`,
    "console.log('LEGACY-ENTRY-INVOKED');",
    "process.stdin.on('data', () => {});",
    'process.stdin.on("end", () => process.exit(1));',
  ].join('\n'));
  return markerPath;
}

/* claude CLI 桩（.cmd 形态）：PowerShell 命令发现按 PATHEXT，无扩展名的桩不解析——本桩只服务 ps1 臂，
 * 让 2/6 走「已装」分支且绝不真跑 claude（未命中时走「未找到 claude CLI」提示分支，同样无害）。 */
function makeClaudeCmdStub(t) {
  const binDir = join(makeTempDir(t), 'stub-bin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, 'claude.cmd'), '@echo off\r\nexit /b 0\r\n');
  return binDir;
}

/* ps1 卸载臂沙箱跑：$HOME 经 USERPROFILE/HOMEDRIVE/HOMEPATH 重定向到临时根——PS 5.1 的 $HOME 是只读
 * 变量（不可赋值），但子进程的 $HOME 由这三个环境变量派生（审查实证 2026-10-15：重定向后真跑
 * -Uninstall 只写临时根、真实家目录零触碰）。PATH 前置 claude 桩目录。 */
function runPs1Uninstall({ home, dataDir, stubDir }) {
  return spawnSync('powershell', ['-NoProfile', '-File', join(repoRoot, 'install', 'install.ps1'), '-Uninstall'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 120000,
    env: {
      ...process.env,
      USERPROFILE: home,
      HOMEDRIVE: home.slice(0, 2),
      HOMEPATH: home.slice(2),
      WAYSTATION_HOME: dataDir,
      PATH: `${stubDir}${delimiter}${process.env.PATH}`,
    },
  });
}

test('卸载臂（ps1 沙箱实跑）：旧版安装副本在场不优先选用、退出 0、删除面不出临时根', (t) => {
  if (!powershellAvailable) {
    t.skip('PowerShell 不可用或执行策略禁跑本地脚本（非 win32 / 受限宿主天然跳过）');
    return;
  }
  const home = makeTempDir(t);
  const dataDir = makeTempDir(t);   // WAYSTATION_HOME：停核对证目标（空根＝无核心，退出 0 放行）
  const markerPath = writeLegacyEntryStub(home);
  mkdirSync(join(home, '.claude', 'commands'), { recursive: true });
  writeFileSync(join(home, '.claude', 'commands', 'ws-list.md'), `---\ndescription: list\n---\n${MANAGED_MARKER}\n正文\n`);
  /* 真实家目录零触碰断言取稳定面（真实安装入口的存在性）：真实 profile 的 .claude.json 由并发运行
   * 的会话/代理持续改写，哈希比对会假红；「删除面不出临时根」由下方逐行包含断言正面承担。 */
  const realAppEntry = join(homedir(), '.waystation', 'app', 'bin', 'waystation.js');
  const realInstalledBefore = existsSync(realAppEntry);

  const result = runPs1Uninstall({ home, dataDir, stubDir: makeClaudeCmdStub(t) });

  assert.equal(result.status, 0, `退出码非 0（旧副本被选用会在此以 1 收场）；stdout：${result.stdout}\nstderr：${result.stderr}`);
  assert.ok(result.stdout.includes('无核心在运行'), `停核应由脚本树入口作答（无核跳过）：${result.stdout}`);
  assert.ok(!result.stdout.includes('LEGACY-ENTRY-INVOKED'), '旧版安装副本不得被调用');
  assert.equal(existsSync(markerPath), false, '旧版安装副本零调用（标记文件不得出现）');
  assert.equal(existsSync(join(home, '.waystation', 'app')), false, '停核通过后卸载照常继续（安装目录已删）');
  const pathLines = result.stdout.split('\n').filter((line) => line.startsWith('    已删除：') || line.startsWith('    不存在，跳过：'));
  assert.ok(pathLines.length > 0, `卸载臂应有删除/跳过行：${result.stdout}`);
  for (const line of pathLines) {
    assert.ok(line.toLowerCase().includes(home.toLowerCase()), `删除目标必须落在临时家目录内（重定向未生效即红）：${line}`);
  }
  assert.equal(existsSync(realAppEntry), realInstalledBefore, '真实家目录安装面不得被沙箱跑触碰');
});
