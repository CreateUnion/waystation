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
