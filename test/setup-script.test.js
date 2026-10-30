import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTempDir, repoRoot } from './helpers.js';

/* setup.ps1 的 ps1 臂：仅 win32 且 powershell -File 可跑；否则整文件跳过（不得假红）。
 * 用 -HomeDir 指向临时目录伪造安装态（未装/低版本/同版/损坏），用 WAYSTATION_TEST_SETUP
 * 隔离真机 cc-connect 服务。dry-run 用例断言零写入；真实写入用例（Task 3 起）落在临时
 * HomeDir 内，不触碰真机。 */
const powershellAvailable = (function powershellFileRuns() {
  if (process.platform !== 'win32') {
    return false;
  }
  const probeDir = mkdtempSync(join(tmpdir(), 'ws-setup-probe-'));
  try {
    const probePath = join(probeDir, 'probe.ps1');
    writeFileSync(probePath, 'exit 0\n');
    const probe = spawnSync('powershell', ['-NoProfile', '-File', probePath], { encoding: 'utf8', timeout: 30000 });
    return probe.error === undefined && probe.status === 0;
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
})();

function bundledVersion() {
  return JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;
}

function writeInstalledVersion(home, version) {
  const appDir = join(home, '.waystation', 'app');
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(appDir, 'package.json'), JSON.stringify({ name: 'waystation', version }), 'utf8');
}

function runSetup(t, { args = [], home = makeTempDir(t), seam = '1' } = {}) {
  /* 运行前快照：零写入断言按「运行前后目录树逐项相等」判定——比按名单过滤更强，
   * 且不会被用例自己预置的安装态夹具（.waystation\app\package.json）误判成写入。 */
  const entriesBefore = readdirSync(home, { recursive: true }).sort();
  const result = spawnSync(
    'powershell',
    ['-NoProfile', '-File', join(repoRoot, 'scripts', 'setup.ps1'), '-HomeDir', home, ...args],
    {
      encoding: 'utf8',
      timeout: 120000,
      env: { ...process.env, WAYSTATION_TEST_SETUP: seam },
    },
  );
  return { home, result, entriesBefore };
}

function assertDryRunNoWrite(home, entriesBefore) {
  const entriesAfter = readdirSync(home, { recursive: true }).sort();
  assert.deepEqual(entriesAfter, entriesBefore, `dry-run 零写入被破坏：${entriesAfter.join(', ')}`);
}

test('未安装：dry-run 报告全新安装且零写入', (t) => {
  if (!powershellAvailable) { t.skip('powershell -File 不可用'); return; }
  const { home, result, entriesBefore } = runSetup(t, { args: ['-DryRun'] });
  assert.equal(result.status, 0, `退出码非 0；stderr：${result.stderr}`);
  assert.ok(result.stdout.includes('全新安装'), `应报告全新安装：${result.stdout}`);
  assertDryRunNoWrite(home, entriesBefore);
});

test('已装低版本：dry-run 报告询问更新并给出两方版本号', (t) => {
  if (!powershellAvailable) { t.skip('powershell -File 不可用'); return; }
  const home = makeTempDir(t);
  writeInstalledVersion(home, '0.0.1');
  const { result, entriesBefore } = runSetup(t, { args: ['-DryRun'], home });
  assert.equal(result.status, 0, `退出码非 0；stderr：${result.stderr}`);
  assert.ok(result.stdout.includes('是否更新'), `应报告更新询问：${result.stdout}`);
  assert.ok(result.stdout.includes('0.0.1'), `应含已装版本号：${result.stdout}`);
  assert.ok(result.stdout.includes(bundledVersion()), `应含安装包版本号：${result.stdout}`);
  assertDryRunNoWrite(home, entriesBefore);
});

test('已装同版本：dry-run 报告已是最新并跳过', (t) => {
  if (!powershellAvailable) { t.skip('powershell -File 不可用'); return; }
  const home = makeTempDir(t);
  writeInstalledVersion(home, bundledVersion());
  const { result, entriesBefore } = runSetup(t, { args: ['-DryRun'], home });
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes('已是最新'), `应报告已是最新：${result.stdout}`);
  assert.ok(!result.stdout.includes('是否更新'), '同版本不应询问更新');
  assertDryRunNoWrite(home, entriesBefore);
});

test('已装更高版本：dry-run 同样报告已是最新（不降级）', (t) => {
  if (!powershellAvailable) { t.skip('powershell -File 不可用'); return; }
  const home = makeTempDir(t);
  writeInstalledVersion(home, '9.9.9');
  const { result, entriesBefore } = runSetup(t, { args: ['-DryRun'], home });
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes('已是最新'));
  assertDryRunNoWrite(home, entriesBefore);
});

test('已装版本不可解析：dry-run 报告重装询问', (t) => {
  if (!powershellAvailable) { t.skip('powershell -File 不可用'); return; }
  const home = makeTempDir(t);
  writeInstalledVersion(home, 'abc');
  const { result, entriesBefore } = runSetup(t, { args: ['-DryRun'], home });
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes('重装'), `应报告重装询问：${result.stdout}`);
  assertDryRunNoWrite(home, entriesBefore);
});

test('cc-connect 未检测到（nocc 缝）：打印缺失提醒', (t) => {
  if (!powershellAvailable) { t.skip('powershell -File 不可用'); return; }
  const { result } = runSetup(t, { args: ['-DryRun'], seam: 'nocc' });
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes('未检测到 cc-connect'), `应打印缺失提醒：${result.stdout}`);
  assert.ok(result.stdout.includes('多会话控制'), `提醒应说明多会话控制不可用：${result.stdout}`);
});

test('cc-connect 已检测到（伪造 config 命中存在信号）：不打印缺失提醒', (t) => {
  if (!powershellAvailable) { t.skip('powershell -File 不可用'); return; }
  const home = makeTempDir(t);
  const ccDir = join(home, '.cc-connect');
  mkdirSync(ccDir, { recursive: true });
  writeFileSync(join(ccDir, 'config.toml'), '[[projects]]\nname = "demo"\n', 'utf8');
  const { result } = runSetup(t, { args: ['-DryRun'], home, seam: '1' });
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes('已检测到 cc-connect'), `应打印已检测到：${result.stdout}`);
  assert.ok(!result.stdout.includes('未检测到 cc-connect'), '不应打印缺失提醒');
});

const MINIMAL_CONFIG = [
  '[projects.agent.options]',
  'work_dir = "E:/demo"',
  'mode = "default"',
  '',
].join('\n');

function writeCcConfig(home, text) {
  const ccDir = join(home, '.cc-connect');
  mkdirSync(ccDir, { recursive: true });
  writeFileSync(join(ccDir, 'config.toml'), text, 'utf8');
}

function readCcConfig(home) {
  return readFileSync(join(home, '.cc-connect', 'config.toml'), 'utf8');
}

function listBackups(home) {
  const ccDir = join(home, '.cc-connect');
  try {
    return readdirSync(ccDir).filter((name) => name.includes('.bak-setup-'));
  } catch {
    return [];
  }
}

test('注入：最小 config 实际写入三键、创建备份、退出码 2（服务项待手动）', (t) => {
  if (!powershellAvailable) { t.skip('powershell -File 不可用'); return; }
  const home = makeTempDir(t);
  writeCcConfig(home, MINIMAL_CONFIG);
  const { result } = runSetup(t, { home, seam: '1' });
  const text = readCcConfig(home);
  assert.ok(text.includes('allowed_tools = ['), `应注入 allowed_tools：${text}`);
  assert.ok(text.includes('mcp__waystation__ws_dispatch_claim'), '白名单应含 ws_dispatch_claim');
  assert.ok(text.includes('mcp__waystation__ws_dispatch_rules_reload'), '白名单应含 ws_dispatch_rules_reload');
  assert.ok(!text.includes('ws_dispatch_approve'), '白名单刻意不含 ws_dispatch_approve');
  assert.ok(text.includes('append_system_prompt = """你是 waystation dispatch master'), '应注入 dispatch 规则');
  const expectedWorkDir = join(home, '.waystation', 'app').replace(/\\/g, '/');
  assert.ok(text.includes(`work_dir = "${expectedWorkDir}"`), `work_dir 应指向 waystation 安装目录：${text}`);
  assert.ok(!text.includes('E:/demo'), '既有 work_dir 应被替换为安装目录');
  assert.equal(listBackups(home).length, 1, '应恰创建一个备份');
  assert.ok(result.stdout.includes('已注入并备份'), `应报告注入：${result.stdout}`);
  /* Task 4 恢复完整断言 */
  assert.equal(result.status, 2, `注入成功但服务缺席应记待手动项（退出码 2）；stderr：${result.stderr}`);
});

test('幂等：第二遍全部跳过、不新增备份、内容不变', (t) => {
  if (!powershellAvailable) { t.skip('powershell -File 不可用'); return; }
  const home = makeTempDir(t);
  writeCcConfig(home, MINIMAL_CONFIG);
  runSetup(t, { home, seam: '1' });
  const afterFirst = readCcConfig(home);
  const backupsAfterFirst = listBackups(home);
  const second = runSetup(t, { home, seam: '1' });
  assert.ok(second.result.stdout.includes('已配置，跳过'), `第二遍应逐项跳过：${second.result.stdout}`);
  assert.equal(listBackups(home).length, backupsAfterFirst.length, '第二遍不得新增备份');
  assert.equal(readCcConfig(home), afterFirst, '第二遍不得改内容');
});

test('段界防线：多行字符串未闭合的段放弃合并、文件不变', (t) => {
  if (!powershellAvailable) { t.skip('powershell -File 不可用'); return; }
  const home = makeTempDir(t);
  const tricky = [
    '[projects.agent.options]',
    'work_dir = "E:/x"',
    'append_system_prompt = """第一行',
    '[projects.agent.options]',
    '第三行"""',
    'allowed_tools = [',
    '  "mcp__waystation__ws_status",',
    ']',
    '',
  ].join('\n');
  writeCcConfig(home, tricky);
  const before = readCcConfig(home);
  const { result } = runSetup(t, { home, seam: '1' });
  assert.equal(readCcConfig(home), before, '防线触发时文件必须原样');
  assert.ok(result.stdout.includes('放弃该段自动合并'), `应报告放弃合并：${result.stdout}`);
});

test('无 options 段：不盲改、文件不变、报告结构未知', (t) => {
  if (!powershellAvailable) { t.skip('powershell -File 不可用'); return; }
  const home = makeTempDir(t);
  writeCcConfig(home, '[[projects]]\nname = "demo"\n');
  const before = readCcConfig(home);
  const { result } = runSetup(t, { home, seam: '1' });
  assert.equal(readCcConfig(home), before, '结构未知时文件必须原样');
  assert.ok(result.stdout.includes('[projects.agent.options]'), `应报告缺段：${result.stdout}`);
});

test('多项目：两个 options 段各注入一份', (t) => {
  if (!powershellAvailable) { t.skip('powershell -File 不可用'); return; }
  const home = makeTempDir(t);
  writeCcConfig(home, [
    '[[projects]]',
    'name = "a"',
    '',
    '[projects.agent.options]',
    'work_dir = "E:/a"',
    '',
    '[[projects]]',
    'name = "b"',
    '',
    '[projects.agent.options]',
    'work_dir = "E:/b"',
    '',
  ].join('\n'));
  const { result } = runSetup(t, { home, seam: '1' });
  const text = readCcConfig(home);
  assert.equal((text.match(/allowed_tools = \[/g) || []).length, 2, `两段各注入 allowed_tools：${text}`);
  assert.equal((text.match(/append_system_prompt = """你是 waystation dispatch master/g) || []).length, 2, '两段各注入规则');
  const expectedWorkDirLine = `work_dir = "${join(home, '.waystation', 'app').replace(/\\/g, '/')}"`;
  assert.equal(text.split(expectedWorkDirLine).length - 1, 2, `两段 work_dir 均指向安装目录：${text}`);
  assert.ok(!text.includes('E:/a') && !text.includes('E:/b'), '旧 work_dir 应被替换');
  assert.ok(result.stdout.includes('已注入并备份'));
});

test('服务缺席（缝=1）：真实运行打印手动指引并记待手动项', (t) => {
  if (!powershellAvailable) { t.skip('powershell -File 不可用'); return; }
  const home = makeTempDir(t);
  writeCcConfig(home, MINIMAL_CONFIG);
  const { result } = runSetup(t, { home, seam: '1' });
  assert.ok(result.stdout.includes('未以 Windows 服务运行'), `应报告服务缺席：${result.stdout}`);
  assert.ok(result.stdout.includes('WAYSTATION_ROLE=master'), `应给出手动内容：${result.stdout}`);
  assert.ok(result.stdout.includes('待手动事项'), `汇总应列待手动项：${result.stdout}`);
  assert.equal(result.status, 2);
});

test('服务缺席 + 已全部配置：幂等重跑仍只报服务一项待手动', (t) => {
  if (!powershellAvailable) { t.skip('powershell -File 不可用'); return; }
  const home = makeTempDir(t);
  writeCcConfig(home, MINIMAL_CONFIG);
  runSetup(t, { home, seam: '1' });
  const second = runSetup(t, { home, seam: '1' });
  assert.equal(second.result.status, 2);
  assert.ok(second.result.stdout.includes('已配置，跳过'), 'config 项应跳过');
  assert.equal((second.result.stdout.match(/待手动事项/g) || []).length, 1, '只汇总一次待手动清单');
});

test('缺失提醒分支：退出码 0（未检测到 cc-connect 不算待手动）', (t) => {
  if (!powershellAvailable) { t.skip('powershell -File 不可用'); return; }
  const { result } = runSetup(t, { seam: 'nocc' });
  assert.equal(result.status, 0, `缺失提醒不是待手动项；stderr：${result.stderr}`);
  assert.ok(result.stdout.includes('智能安装完成'));
});
