import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
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
  for (const kept of ['  config.json', '  instance-id', '  app/', '  bin/', '  sites/2/config.json', '  sites/2/instance-id']) {
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
  for (const gone of ['collabs', 'sessions', 'logs', 'known-hosts.json', 'instance-id.lock', 'outbox']) {
    assert.equal(existsSync(join(dataDir, gone)), false, `应删除：${gone}`);
  }
  for (const name of ['abc', '02', '9', 'readme.txt']) {
    assert.equal(existsSync(join(dataDir, 'sites', name)), false, `非槽位条目整条删除：sites/${name}`);
  }
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
