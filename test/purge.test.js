import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, parse, resolve } from 'node:path';
import { parsePurgeArgs, purgePathRefusal, runPurgeCli } from '../src/purge.js';
import { makeTempDir, repoRoot } from './helpers.js';

const BIN_ENTRY = join(repoRoot, 'bin', 'waystation.js');

/* 捕获模块写到 process.stdout 的输出（模块输出是 CLI 契约面，用真通道验）。 */
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

/* 递归快照（相对路径 + 形态 + 字节）：预览零变更的逐项证据。 */
function snapshotTree(root) {
  const entries = [];
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const stats = lstatSync(full);
      entries.push(`${rel} ${stats.isDirectory() ? 'dir' : `file:${stats.size}`}`);
      if (entry.isDirectory()) {
        walk(full, rel);
      }
    }
  };
  walk(root, '');
  return entries.sort();
}

/* 驿站数据目录现场：身份二件套 + 安装面 + 协作/会话/日志/已知主机/锁残留 + 槽位目录
 * （合法槽位含身份二件套与数据；无身份文件的合法槽位；非数字 / 前导零 / 越界槽位名目录 +
 * 槽位层散落文件；outbox 模拟「未来新增名字」）——覆盖保留清单逐项与补集删除面。 */
function makeStationDataDir(t) {
  const dataDir = makeTempDir(t);
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ identityName: '测试站' }));
  writeFileSync(join(dataDir, 'instance-id'), 'id-main\n');
  mkdirSync(join(dataDir, 'app', 'src'), { recursive: true });
  writeFileSync(join(dataDir, 'app', 'src', 'index.js'), '// 安装面\n');
  mkdirSync(join(dataDir, 'bin'), { recursive: true });
  writeFileSync(join(dataDir, 'bin', 'waystation.cmd'), '@echo off\n');
  mkdirSync(join(dataDir, 'collabs', 'collab-1'), { recursive: true });
  writeFileSync(join(dataDir, 'collabs', 'collab-1', 'ledger.jsonl'), '{"v":1}\n');
  writeFileSync(join(dataDir, 'collabs', 'collab-1', 'snapshot.json'), '{}\n');
  mkdirSync(join(dataDir, 'collabs', 'collab-2'), { recursive: true });
  writeFileSync(join(dataDir, 'collabs', 'collab-2', 'member.json'), '{}\n');
  mkdirSync(join(dataDir, 'sessions'), { recursive: true });
  writeFileSync(join(dataDir, 'sessions', 'session-1.json'), '{}\n');
  writeFileSync(join(dataDir, 'sessions', 'session-2.json'), '{}\n');
  mkdirSync(join(dataDir, 'logs'), { recursive: true });
  writeFileSync(join(dataDir, 'logs', 'waystation.log'), 'x'.repeat(2048));
  mkdirSync(join(dataDir, 'instance-id.lock'), { recursive: true });
  writeFileSync(join(dataDir, 'known-hosts.json'), '[]\n');
  mkdirSync(join(dataDir, 'outbox'), { recursive: true });
  writeFileSync(join(dataDir, 'outbox', 'leftover.jsonl'), '{}\n');
  writeFileSync(join(dataDir, 'outbox', 'big.bin'), 'x'.repeat(1024 * 1024 + 512 * 1024));
  mkdirSync(join(dataDir, 'sites', '2', 'logs'), { recursive: true });
  writeFileSync(join(dataDir, 'sites', '2', 'config.json'), JSON.stringify({ port: 7322 }));
  writeFileSync(join(dataDir, 'sites', '2', 'instance-id'), 'id-slot2\n');
  writeFileSync(join(dataDir, 'sites', '2', 'logs', 'old.log'), 'x\n');
  mkdirSync(join(dataDir, 'sites', '3'), { recursive: true });
  writeFileSync(join(dataDir, 'sites', '3', 'instance-id.lock'), 'stale\n');
  writeFileSync(join(dataDir, 'sites', 'readme.txt'), '散落文件\n');
  for (const name of ['abc', '02', '9']) {
    mkdirSync(join(dataDir, 'sites', name), { recursive: true });
    writeFileSync(join(dataDir, 'sites', name, 'foo.txt'), 'x\n');
  }
  return dataDir;
}

test('参数解析：--yes / --help 开关与未知参数收集', () => {
  assert.deepEqual(parsePurgeArgs(['--yes']), { execute: true, help: false, unknown: [] });
  assert.deepEqual(parsePurgeArgs(['--help']), { execute: false, help: true, unknown: [] });
  assert.deepEqual(parsePurgeArgs(['--bogus', 'extra']), { execute: false, help: false, unknown: ['--bogus', 'extra'] });
});

test('预览（裸 purge-data）：列出将删除与保留清单与计数、零变更、退出码 0', (t) => {
  const dataDir = makeStationDataDir(t);
  const home = makeTempDir(t);
  const before = snapshotTree(dataDir);
  const { code, output } = runWithCapture(() => runPurgeCli({ argv: [], env: { WAYSTATION_HOME: dataDir }, home }));
  assert.equal(code, 0, output);
  assert.ok(output.includes('数据清理（预览'), output);
  const lines = output.split('\n');
  for (const kept of ['  config.json', '  instance-id', '  app/', '  bin/', '  sites/', '  sites/2/', '  sites/2/config.json', '  sites/2/instance-id', '  sites/3/']) {
    assert.ok(lines.includes(kept), `保留清单应含精确行 ${JSON.stringify(kept)}：\n${output}`);
  }
  for (const gone of [
    'collabs（2 个子项', 'sessions（2 个子项', 'logs（1 个子项', 'known-hosts.json', 'instance-id.lock（0 个子项',
    'outbox（2 个子项', 'sites/abc（1 个子项', 'sites/02', 'sites/9', 'sites/readme.txt', 'sites/2/logs（1 个子项', 'sites/3/instance-id.lock',
  ]) {
    assert.ok(output.includes(gone), `删除面应含 ${gone}：\n${output}`);
  }
  assert.ok(output.includes('1.5 MB'), `删除面合计应含尺寸：\n${output}`);
  assert.ok(output.includes('确认执行请加 --yes'));
  assert.deepEqual(snapshotTree(dataDir), before, '预览必须零变更');
  assert.equal(existsSync(join(dataDir, 'collabs', 'collab-1', 'ledger.jsonl')), true);
});

test('--yes：保留清单逐项存活、其余全消失、槽位目录只保两文件', (t) => {
  const dataDir = makeStationDataDir(t);
  const home = makeTempDir(t);
  const { code, output } = runWithCapture(() => runPurgeCli({ argv: ['--yes'], env: { WAYSTATION_HOME: dataDir }, home }));
  assert.equal(code, 0, output);
  assert.ok(output.includes('已删除：collabs'), output);
  for (const kept of ['config.json', 'instance-id', join('app', 'src', 'index.js'), join('bin', 'waystation.cmd'), join('sites', '2', 'config.json'), join('sites', '2', 'instance-id')]) {
    assert.equal(existsSync(join(dataDir, kept)), true, `应保留：${kept}`);
  }
  assert.equal(existsSync(dataDir), true, '数据目录本身保留');
  assert.deepEqual(readdirSync(join(dataDir, 'sites', '2')).sort(), ['config.json', 'instance-id'], '槽位目录只留身份二件套');
  assert.deepEqual(readdirSync(join(dataDir, 'sites', '3')), [], '无身份文件的合法槽位目录：内容清空、目录保留');
  assert.ok(output.includes('  sites/3/'), `执行报告的保留清单也应列出存活的空槽位目录：\n${output}`);
  for (const gone of ['collabs', 'sessions', 'logs', 'known-hosts.json', 'instance-id.lock', 'outbox']) {
    assert.equal(existsSync(join(dataDir, gone)), false, `应删除：${gone}`);
  }
  for (const name of ['abc', '02', '9', 'readme.txt']) {
    assert.equal(existsSync(join(dataDir, 'sites', name)), false, `非槽位条目整条删除：sites/${name}`);
  }
});

/* 顶层保留判定按名字、与条目类型无关；win32 下名字比对大小写不敏感——盘上以 Config.json / App /
 * Sites 这类非规范大小写命名时应用照常可用（win32 文件系统大小写不敏感），漏判即删活身份。
 * 经注入 platform 在任意宿主上双向验证两种语义，不依赖运行平台。 */
test('保留判定：注入 win32 时大小写变体仍是保留面（含槽位内二件套），槽位内其余数据照删', (t) => {
  const dataDir = makeTempDir(t);
  writeFileSync(join(dataDir, 'Config.json'), '{}\n');
  writeFileSync(join(dataDir, 'Instance-id'), 'id-main\n');
  mkdirSync(join(dataDir, 'App', 'src'), { recursive: true });
  writeFileSync(join(dataDir, 'App', 'src', 'index.js'), '// 安装面\n');
  mkdirSync(join(dataDir, 'Bin'), { recursive: true });
  mkdirSync(join(dataDir, 'collabs', 'collab-x'), { recursive: true });
  writeFileSync(join(dataDir, 'collabs', 'collab-x', 'ledger.jsonl'), '{}\n');
  mkdirSync(join(dataDir, 'Sites', '2', 'logs'), { recursive: true });
  writeFileSync(join(dataDir, 'Sites', '2', 'Config.json'), '{}\n');
  writeFileSync(join(dataDir, 'Sites', '2', 'Instance-id'), 'id-slot2\n');
  writeFileSync(join(dataDir, 'Sites', '2', 'logs', 'old.log'), 'x\n');

  const env = { WAYSTATION_HOME: dataDir };
  const home = makeTempDir(t);
  const preview = runWithCapture(() => runPurgeCli({ argv: [], env, home, platform: 'win32' }));
  assert.equal(preview.code, 0, preview.output);
  const lines = preview.output.split('\n');
  for (const kept of ['  Config.json', '  Instance-id', '  App/', '  Bin/', '  Sites/', '  Sites/2/', '  Sites/2/Config.json', '  Sites/2/Instance-id']) {
    assert.ok(lines.includes(kept), `win32 判定应保留精确行 ${JSON.stringify(kept)}：\n${preview.output}`);
  }
  assert.ok(preview.output.includes('collabs（1 个子项'), `协作数据仍入删除面：\n${preview.output}`);
  assert.ok(preview.output.includes('Sites/2/logs（1 个子项'), `槽位内非身份内容仍入删除面：\n${preview.output}`);

  const applied = runWithCapture(() => runPurgeCli({ argv: ['--yes'], env, home, platform: 'win32' }));
  assert.equal(applied.code, 0, applied.output);
  for (const kept of ['Config.json', 'Instance-id', join('App', 'src', 'index.js'), join('Sites', '2', 'Config.json'), join('Sites', '2', 'Instance-id')]) {
    assert.equal(existsSync(join(dataDir, kept)), true, `win32 判定应保留：${kept}`);
  }
  assert.equal(existsSync(join(dataDir, 'collabs')), false, '协作数据应删除');
  assert.equal(existsSync(join(dataDir, 'Sites', '2', 'logs')), false, '槽位内非身份内容应删除');
  assert.deepEqual(readdirSync(join(dataDir, 'Sites', '2')).sort(), ['Config.json', 'Instance-id']);
});

test('保留判定：注入非 win32（linux）时大小写变体不保留——精确比对、整条入删除面', (t) => {
  const dataDir = makeTempDir(t);
  writeFileSync(join(dataDir, 'Config.json'), '{}\n');
  writeFileSync(join(dataDir, 'Instance-id'), 'id-main\n');
  mkdirSync(join(dataDir, 'App', 'src'), { recursive: true });
  mkdirSync(join(dataDir, 'Sites', '2'), { recursive: true });
  mkdirSync(join(dataDir, 'collabs'), { recursive: true });

  const preview = runWithCapture(() => runPurgeCli({ argv: [], env: { WAYSTATION_HOME: dataDir }, home: makeTempDir(t), platform: 'linux' }));
  assert.equal(preview.code, 0, preview.output);
  const lines = preview.output.split('\n');
  assert.ok(lines.includes('  （无——数据目录里没有身份 / 安装面文件）'), `精确比对下不应有任何保留项：\n${preview.output}`);
  for (const gone of ['Config.json（', 'Instance-id（', 'App（1 个子项', 'Sites（1 个子项']) {
    assert.ok(preview.output.includes(gone), `删除面应含 ${gone}：\n${preview.output}`);
  }
});

/* 顶层 app / sites 为链接形态：按名字保留、链接原样不动、不下钻——链接目标在数据目录树之外，
 * 删除面不穿出链接。win32 用 junction（免特权），其余平台用目录符号链接；建不出链接则跳过。 */
test('顶层 app / sites 为链接：按名字保留、原样不动、目标不被下钻清理', (t) => {
  const dataDir = makeTempDir(t);
  const targetRoot = makeTempDir(t);
  const appTarget = join(targetRoot, 'app-target');
  const sitesTarget = join(targetRoot, 'sites-target');
  mkdirSync(join(appTarget, 'src'), { recursive: true });
  writeFileSync(join(appTarget, 'src', 'index.js'), '// 安装面副本\n');
  mkdirSync(join(sitesTarget, '2', 'logs'), { recursive: true });
  writeFileSync(join(sitesTarget, '2', 'config.json'), '{}\n');
  writeFileSync(join(sitesTarget, '2', 'logs', 'old.log'), 'x\n');
  writeFileSync(join(dataDir, 'config.json'), '{}\n');
  mkdirSync(join(dataDir, 'collabs'), { recursive: true });
  writeFileSync(join(dataDir, 'collabs', 'x.jsonl'), '{}\n');
  try {
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    symlinkSync(appTarget, join(dataDir, 'app'), linkType);
    symlinkSync(sitesTarget, join(dataDir, 'sites'), linkType);
  } catch (error) {
    t.skip(`宿主无法创建目录链接（${error?.message}）；链接形态的保留语义在可建链接的平台验证`);
    return;
  }

  const env = { WAYSTATION_HOME: dataDir };
  const preview = runWithCapture(() => runPurgeCli({ argv: [], env, home: makeTempDir(t) }));
  assert.equal(preview.code, 0, preview.output);
  const lines = preview.output.split('\n');
  assert.ok(lines.includes('  app'), `链接形态 app 应入保留清单：\n${preview.output}`);
  assert.ok(lines.includes('  sites'), `链接形态 sites 应入保留清单：\n${preview.output}`);

  const applied = runWithCapture(() => runPurgeCli({ argv: ['--yes'], env, home: makeTempDir(t) }));
  assert.equal(applied.code, 0, applied.output);
  assert.equal(lstatSync(join(dataDir, 'app')).isSymbolicLink(), true, '链接本身原样保留');
  assert.equal(lstatSync(join(dataDir, 'sites')).isSymbolicLink(), true, '链接本身原样保留');
  assert.equal(existsSync(join(appTarget, 'src', 'index.js')), true);
  assert.equal(existsSync(join(sitesTarget, '2', 'config.json')), true);
  assert.equal(existsSync(join(sitesTarget, '2', 'logs', 'old.log')), true, '链接目标不被下钻清理');
  assert.equal(existsSync(join(dataDir, 'collabs')), false, '其余条目照常按补集删除');
});

/* 目录不可读：计划阶段读取失败 → 拒绝执行（退出码 1、零改动、不裸栈崩溃）。注入方案：POSIX
 * 权限位——目录给「仅执行」权限时按名 stat 可用（形态判据过）、枚举必败，正好只打中计划阶段的
 * readdirSync。Windows 的目录权限没有「列目录」与「按名访问」之分（同一 ACL 位），构造不出
 * 「判据可过、枚举失败」的目录，故 win32 跳过、由 Linux 覆盖；root 下权限位不生效（容器场景）同样跳过。 */
test('计划阶段目录不可读：拒绝执行、退出码 1、零改动（POSIX 权限位注入；win32 / root 跳过）', (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    t.skip('需 POSIX 权限位且非 root：Windows 无「列目录 / 按名访问」权限之分，root 下 chmod 不生效');
    return;
  }
  const dataDir = makeTempDir(t);
  writeFileSync(join(dataDir, 'config.json'), '{}\n');
  chmodSync(dataDir, 0o111);
  try {
    const run = runWithCapture(() => runPurgeCli({ argv: ['--yes'], env: { WAYSTATION_HOME: dataDir }, home: makeTempDir(t) }));
    assert.equal(run.code, 1, run.output);
    assert.ok(run.output.includes('拒绝清理：目录读取失败') && run.output.includes('未做任何改动'), run.output);
  } finally {
    chmodSync(dataDir, 0o755);
  }
  assert.equal(existsSync(join(dataDir, 'config.json')), true, '拒绝执行：零改动');

  const sitesDir = makeTempDir(t);
  writeFileSync(join(sitesDir, 'config.json'), '{}\n');
  mkdirSync(join(sitesDir, 'collabs'), { recursive: true });
  mkdirSync(join(sitesDir, 'sites', '2'), { recursive: true });
  writeFileSync(join(sitesDir, 'sites', '2', 'config.json'), '{}\n');
  chmodSync(join(sitesDir, 'sites'), 0o000);
  try {
    const run = runWithCapture(() => runPurgeCli({ argv: ['--yes'], env: { WAYSTATION_HOME: sitesDir }, home: makeTempDir(t) }));
    assert.equal(run.code, 1, run.output);
    assert.ok(run.output.includes('拒绝清理：目录读取失败'), run.output);
  } finally {
    chmodSync(join(sitesDir, 'sites'), 0o755);
  }
  assert.equal(existsSync(join(sitesDir, 'collabs')), true, 'sites/ 读不出即整体拒绝：协作数据未动');
  assert.equal(existsSync(join(sitesDir, 'sites', '2', 'config.json')), true);
});

test('守卫：家目录本身 / 非驿站形态 → 拒绝（退出码 1、零删除）；不存在 → 跳过（退出码 0）', (t) => {
  const home = makeTempDir(t);
  writeFileSync(join(home, '重要文件.txt'), '别删我\n');
  const asHome = runWithCapture(() => runPurgeCli({ argv: ['--yes'], env: { WAYSTATION_HOME: home }, home }));
  assert.equal(asHome.code, 1);
  assert.ok(asHome.output.includes('拒绝清理') && asHome.output.includes('用户家目录本身'), asHome.output);
  assert.equal(existsSync(join(home, '重要文件.txt')), true);

  const plainDir = makeTempDir(t);
  writeFileSync(join(plainDir, 'note.txt'), 'x');
  const alien = runWithCapture(() => runPurgeCli({ argv: [], env: { WAYSTATION_HOME: plainDir }, home: makeTempDir(t) }));
  assert.equal(alien.code, 1);
  assert.ok(alien.output.includes('不像驿站数据目录'), alien.output);
  assert.equal(existsSync(join(plainDir, 'note.txt')), true, '内容形态不符：目录原样保留');

  const missing = join(makeTempDir(t), 'not-created');
  const absent = runWithCapture(() => runPurgeCli({ argv: ['--yes'], env: { WAYSTATION_HOME: missing }, home: makeTempDir(t) }));
  assert.equal(absent.code, 0);
  assert.ok(absent.output.includes('不存在，跳过'));
});

test('纯函数守卫：文件系统根 / 家目录本身（删除前判据，不触文件系统）', () => {
  const root = parse(process.cwd()).root;
  assert.ok(purgePathRefusal(resolve(root), join(root, 'home-ish')).includes('疑似文件系统根'));
  const home = join(root, 'Users', 'someone');
  assert.equal(purgePathRefusal(join(home, '.waystation'), home), null);
  assert.ok(purgePathRefusal(resolve(home), home).includes('用户家目录本身'));
});

test('--help：用法与退出码 0；未知参数：用法与退出码 1（零改动）', (t) => {
  const dataDir = makeStationDataDir(t);
  const help = runWithCapture(() => runPurgeCli({ argv: ['--help'], env: { WAYSTATION_HOME: dataDir }, home: makeTempDir(t) }));
  assert.equal(help.code, 0);
  assert.ok(help.output.includes('waystation purge-data --yes'));
  const bad = runWithCapture(() => runPurgeCli({ argv: ['--purge-data'], env: { WAYSTATION_HOME: dataDir }, home: makeTempDir(t) }));
  assert.equal(bad.code, 1);
  assert.ok(bad.output.includes('未知参数：--purge-data'));
  assert.equal(existsSync(join(dataDir, 'collabs')), true, '参数错误不得改动任何东西');
});

test('边界：仅数据（无身份/安装面）与仅身份（无删除面）——文案分支与零风险行为', (t) => {
  const onlyData = makeTempDir(t);
  mkdirSync(join(onlyData, 'collabs', 'collab-x'), { recursive: true });
  writeFileSync(join(onlyData, 'collabs', 'collab-x', 'ledger.jsonl'), '{}\n');
  const dataRun = runWithCapture(() => runPurgeCli({ argv: [], env: { WAYSTATION_HOME: onlyData }, home: makeTempDir(t) }));
  assert.equal(dataRun.code, 0, dataRun.output);
  assert.ok(dataRun.output.includes('（无——数据目录里没有身份 / 安装面文件）'), dataRun.output);

  const onlyIdentity = makeTempDir(t);
  writeFileSync(join(onlyIdentity, 'config.json'), '{}\n');
  const identityRun = runWithCapture(() => runPurgeCli({ argv: ['--yes'], env: { WAYSTATION_HOME: onlyIdentity }, home: makeTempDir(t) }));
  assert.equal(identityRun.code, 0, identityRun.output);
  assert.ok(identityRun.output.includes('已删除：无（已是干净状态'), identityRun.output);
  assert.equal(existsSync(join(onlyIdentity, 'config.json')), true);
});

/* 进程级：spawn node 直跑 bin（沙箱 HOME / USERPROFILE + WAYSTATION_HOME 全部指向临时目录——
 * 即使实现有缺陷也碰不到真实家目录）。 */
test('进程级：bin 分派 purge-data（预览退出 0 零变更、--yes 生效、未知参数退出 1），沙箱 HOME 零风险', { timeout: 30000 }, (t) => {
  const dataDir = makeStationDataDir(t);
  const sandboxHome = makeTempDir(t);
  const env = { ...process.env, WAYSTATION_HOME: dataDir, HOME: sandboxHome, USERPROFILE: sandboxHome };
  const run = (args) => spawnSync(process.execPath, [BIN_ENTRY, ...args], { cwd: repoRoot, env, encoding: 'utf8' });
  const preview = run(['purge-data']);
  assert.equal(preview.status, 0, preview.stderr);
  assert.ok(preview.stdout.includes('将删除：'));
  assert.equal(existsSync(join(dataDir, 'collabs')), true, '预览零变更');

  const applied = run(['purge-data', '--yes']);
  assert.equal(applied.status, 0, applied.stderr);
  assert.ok(applied.stdout.includes('已删除：collabs'));
  assert.equal(existsSync(join(dataDir, 'collabs')), false);
  assert.equal(existsSync(join(dataDir, 'config.json')), true);
  assert.equal(existsSync(join(dataDir, 'app', 'src', 'index.js')), true);
  assert.equal(existsSync(dataDir), true);

  const bad = run(['purge-data', '--bogus']);
  assert.equal(bad.status, 1);
  assert.ok(bad.stdout.includes('未知参数'));

  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.ok(help.stderr.includes('purge-data'), '顶层帮助列出子命令');
});
