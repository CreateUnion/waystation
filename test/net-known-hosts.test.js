import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KNOWN_HOSTS_FILE_NAME, MAX_KNOWN_HOSTS, createKnownHosts } from '../src/net/known-hosts.js';
import { makeTempDir } from './helpers.js';

function makeHosts(t, { dataDir } = {}) {
  const dir = dataDir ?? makeTempDir(t);
  const warnings = [];
  const log = { info: () => {}, error: () => {}, warn: (message, fields) => warnings.push({ message, fields }) };
  const hosts = createKnownHosts({ dataDir: dir, log });
  return { dir, hosts, warnings };
}

test('清单缺失：空起步，list/targets 为空', (t) => {
  const { hosts } = makeHosts(t);
  assert.deepEqual(hosts.list(), []);
  assert.deepEqual(hosts.targets(), []);
  assert.equal(hosts.stats().entries, 0);
});

test('remember：落盘为 version+hosts 形态，targets 可读', (t) => {
  const { dir, hosts } = makeHosts(t);
  hosts.remember({ address: '192.168.0.140', port: 7321, instanceId: 'inst-b', identityName: '主机乙' });
  assert.deepEqual(hosts.targets().map((entry) => entry.address), ['192.168.0.140']);
  const onDisk = JSON.parse(readFileSync(join(dir, KNOWN_HOSTS_FILE_NAME), 'utf8'));
  assert.equal(onDisk.version, 2);
  assert.equal(onDisk.hosts.length, 1);
  assert.equal(onDisk.hosts[0].address, '192.168.0.140');
  assert.equal(onDisk.hosts[0].identityName, '主机乙');
  assert.ok(!Number.isNaN(Date.parse(onDisk.hosts[0].lastSeenAt)));
});

test('同地址重复 remember：单条目、身份更新、lastSeenAt 刷新', (t) => {
  const { hosts } = makeHosts(t);
  hosts.remember({ address: '10.0.0.9', port: 7321, instanceId: 'inst-1', identityName: '旧名' });
  const before = hosts.list()[0].lastSeenAt;
  hosts.remember({ address: '10.0.0.9', port: 7321, instanceId: 'inst-1', identityName: '新名' });
  assert.equal(hosts.list().length, 1);
  assert.equal(hosts.list()[0].identityName, '新名');
  assert.ok(Date.parse(hosts.list()[0].lastSeenAt) >= Date.parse(before));
});

test('非法地址：忽略、计数、不落盘', (t) => {
  const { hosts } = makeHosts(t);
  for (const bad of ['abc', '1.2.3', '192.168.0.1/24', 123, undefined]) {
    hosts.remember({ address: bad, port: 7321 });
  }
  assert.deepEqual(hosts.targets(), []);
  assert.equal(hosts.stats().invalidEntries, 5);
});

test('超过上限：淘汰最旧（按 lastSeenAt）', (t) => {
  const dir = makeTempDir(t);
  const seeded = Array.from({ length: MAX_KNOWN_HOSTS }, (_, index) => ({
    address: `10.1.${Math.floor(index / 250)}.${index % 250}`,
    port: 20 + index,
    instanceId: '',
    identityName: '',
    lastSeenAt: new Date(1700000000000 + index * 1000).toISOString(),
  }));
  writeFileSync(join(dir, KNOWN_HOSTS_FILE_NAME), JSON.stringify({ version: 2, hosts: seeded }));
  const { hosts } = makeHosts(t, { dataDir: dir });
  assert.equal(hosts.stats().entries, MAX_KNOWN_HOSTS);
  hosts.remember({ address: '172.16.0.1', port: 7321 });
  assert.equal(hosts.stats().entries, MAX_KNOWN_HOSTS);
  assert.ok(hosts.targets().map((entry) => entry.address).includes('172.16.0.1'));
  assert.ok(!hosts.targets().map((entry) => entry.address).includes('10.1.0.0'), '应淘汰 lastSeenAt 最旧的条目');
});

test('载入超过上限：按最近时间裁剪（与 remember 淘汰口径一致）', (t) => {
  const dir = makeTempDir(t);
  const total = MAX_KNOWN_HOSTS + 6;
  const seeded = Array.from({ length: total }, (_, index) => ({
    address: `10.2.${Math.floor(index / 250)}.${index % 250}`,
    port: 20 + index,
    instanceId: '',
    identityName: '',
    lastSeenAt: new Date(1700000000000 + index * 1000).toISOString(),
  }));
  writeFileSync(join(dir, KNOWN_HOSTS_FILE_NAME), JSON.stringify({ version: 2, hosts: seeded }));
  const { hosts } = makeHosts(t, { dataDir: dir });
  assert.equal(hosts.stats().entries, MAX_KNOWN_HOSTS);
  assert.ok(hosts.targets().map((entry) => entry.address).includes('10.2.0.69'), '最新的条目应保留');
  assert.ok(!hosts.targets().map((entry) => entry.address).includes('10.2.0.5'), '最旧的 6 条应在载入时被裁剪');
});

test('文件损坏：保留 .corrupt- 副本、空清单起步并告警', (t) => {
  const dir = makeTempDir(t);
  writeFileSync(join(dir, KNOWN_HOSTS_FILE_NAME), '{oops');
  const { hosts, warnings } = makeHosts(t, { dataDir: dir });
  assert.deepEqual(hosts.list(), []);
  const backups = readdirSync(dir).filter((name) => name.startsWith(`${KNOWN_HOSTS_FILE_NAME}.corrupt-`));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(dir, backups[0]), 'utf8'), '{oops');
  assert.ok(warnings.some((entry) => entry.message.includes('损坏')));
});

test('文件内条目非法：跳过并计数（地址缺失/非法、字段超长置空）', (t) => {
  const dir = makeTempDir(t);
  writeFileSync(
    join(dir, KNOWN_HOSTS_FILE_NAME),
    JSON.stringify({
      version: 1,
      hosts: [
        { address: '10.0.0.1', instanceId: 'x'.repeat(200), identityName: 'ok', lastSeenAt: '2026-01-01T00:00:00.000Z' },
        { address: 'not-an-ip' },
        { nope: true },
        'string-entry',
      ],
    }),
  );
  const { hosts } = makeHosts(t, { dataDir: dir });
  assert.deepEqual(hosts.targets().map((entry) => entry.address), ['10.0.0.1']);
  assert.equal(hosts.list()[0].instanceId, '');
  assert.equal(hosts.stats().invalidEntries, 3);
});

test('写盘失败：不抛出、计数、内存态继续可用', (t) => {
  const missingDir = join(makeTempDir(t), 'not-created-yet');
  const warnings = [];
  const hosts = createKnownHosts({
    dataDir: missingDir,
    log: { info: () => {}, error: () => {}, warn: (message) => warnings.push(message) },
  });
  hosts.remember({ address: '10.7.7.7', port: 7321, instanceId: 'inst-7', identityName: '主机七' });
  assert.deepEqual(hosts.targets().map((entry) => entry.address), ['10.7.7.7']);
  assert.ok(hosts.stats().writeFailures >= 1);
  assert.ok(warnings.some((message) => message.includes('写入失败')));
});

test('list：按最近见过时间降序', (t) => {
  const dir = makeTempDir(t);
  writeFileSync(
    join(dir, KNOWN_HOSTS_FILE_NAME),
    JSON.stringify({
      version: 1,
      hosts: [
        { address: '10.0.0.1', instanceId: '', identityName: '', lastSeenAt: '2026-01-01T00:00:00.000Z' },
        { address: '10.0.0.2', instanceId: '', identityName: '', lastSeenAt: '2026-06-01T00:00:00.000Z' },
      ],
    }),
  );
  const { hosts } = makeHosts(t, { dataDir: dir });
  assert.deepEqual(hosts.list().map((entry) => entry.address), ['10.0.0.2', '10.0.0.1']);
});

test('键「地址:端口」：同地址不同端口是两条独立条目', (t) => {
  const { dir, hosts } = makeHosts(t);
  hosts.remember({ address: '10.0.0.9', port: 7321, instanceId: 'inst-a', identityName: '甲' });
  hosts.remember({ address: '10.0.0.9', port: 7322, instanceId: 'inst-b', identityName: '乙' });
  assert.equal(hosts.stats().entries, 2);
  const onDisk = JSON.parse(readFileSync(join(dir, KNOWN_HOSTS_FILE_NAME), 'utf8'));
  assert.equal(onDisk.version, 2);
  assert.deepEqual(onDisk.hosts.map((entry) => entry.port).sort(), [7321, 7322]);
});

test('v1 旧文件迁移：无 port 条目按锚点端口解释、载入即服从上限', (t) => {
  const dir = makeTempDir(t);
  writeFileSync(join(dir, KNOWN_HOSTS_FILE_NAME), JSON.stringify({
    version: 1,
    hosts: [{ address: '10.0.0.1', instanceId: 'inst-a', identityName: '甲', lastSeenAt: '2026-01-01T00:00:00.000Z' }],
  }));
  const { hosts } = makeHosts(t, { dataDir: dir });
  assert.deepEqual(hosts.targets(), [{ address: '10.0.0.1', port: 7321 }]);
  // 下一次写入即 v2 形态
  hosts.remember({ address: '10.0.0.2', port: 7322, instanceId: 'inst-b', identityName: '乙' });
  const onDisk = JSON.parse(readFileSync(join(dir, KNOWN_HOSTS_FILE_NAME), 'utf8'));
  assert.equal(onDisk.version, 2);
  assert.ok(onDisk.hosts.every((entry) => Number.isInteger(entry.port)));
});

test('remember：缺 port 或 port 非法 → 计数拒绝、不入清单', (t) => {
  const { hosts } = makeHosts(t);
  hosts.remember({ address: '10.0.0.9', instanceId: 'inst-a' });
  hosts.remember({ address: '10.0.0.9', port: 0, instanceId: 'inst-a' });
  hosts.remember({ address: '10.0.0.9', port: 70000, instanceId: 'inst-a' });
  hosts.remember({ address: '10.0.0.9', port: '7321', instanceId: 'inst-a' });
  assert.equal(hosts.stats().entries, 0);
  assert.equal(hosts.stats().invalidEntries, 4);
});

test('targets 择新：同一实例标识取 lastSeenAt 最新条目（换地址/换端口的历史残留只取一份）', (t) => {
  const dir = makeTempDir(t);
  writeFileSync(join(dir, KNOWN_HOSTS_FILE_NAME), JSON.stringify({
    version: 2,
    hosts: [
      { address: '10.0.0.1', port: 7321, instanceId: 'inst-same', identityName: '甲', lastSeenAt: '2026-01-01T00:00:00.000Z' },
      { address: '10.0.0.2', port: 7324, instanceId: 'inst-same', identityName: '甲', lastSeenAt: '2026-06-01T00:00:00.000Z' },
    ],
  }));
  const { hosts } = makeHosts(t, { dataDir: dir });
  assert.equal(hosts.list().length, 2, 'list 保留全部原始条目（诊断口径）');
  assert.deepEqual(hosts.targets(), [{ address: '10.0.0.2', port: 7324 }], '单播目标按实例择新');
});

test('targets：实例标识缺失的条目按「地址:端口」各自保留（不臆断同源）', (t) => {
  const { hosts } = makeHosts(t);
  hosts.remember({ address: '10.0.0.1', port: 7321 });
  hosts.remember({ address: '10.0.0.1', port: 7322 });
  assert.deepEqual(hosts.targets(), [
    { address: '10.0.0.1', port: 7321 },
    { address: '10.0.0.1', port: 7322 },
  ]);
});

test('文件内条目 port 非法：跳过并计数（拒绝优于猜测）', (t) => {
  const dir = makeTempDir(t);
  writeFileSync(join(dir, KNOWN_HOSTS_FILE_NAME), JSON.stringify({
    version: 2,
    hosts: [
      { address: '10.0.0.1', port: 65536, lastSeenAt: '2026-01-01T00:00:00.000Z' },
      { address: '10.0.0.2', port: 'x', lastSeenAt: '2026-01-01T00:00:00.000Z' },
      { address: '10.0.0.3', port: 7321, lastSeenAt: '2026-01-01T00:00:00.000Z' },
    ],
  }));
  const { hosts } = makeHosts(t, { dataDir: dir });
  assert.deepEqual(hosts.targets(), [{ address: '10.0.0.3', port: 7321 }]);
  assert.equal(hosts.stats().invalidEntries, 2);
});

test('lookup：按实例标识取最近地址（治理跨协作寻址回退面）；未见过 / 空参返回 null', (t) => {
  const { hosts } = makeHosts(t);
  assert.equal(hosts.lookup('inst-x'), null);
  assert.equal(hosts.lookup(''), null);
  hosts.remember({ address: '10.0.0.9', port: 7321, instanceId: 'inst-x', identityName: '主机X' });
  assert.deepEqual(hosts.lookup('inst-x'), { address: '10.0.0.9', port: 7321 });
});

test('落盘节流：同键刷新按窗口合并（内存即时、磁盘滞后）、新键立即落盘', (t) => {
  const dir = makeTempDir(t);
  const log = { info: () => {}, error: () => {}, warn: () => {} };
  const hosts = createKnownHosts({ dataDir: dir, log, persistMinIntervalMs: 60000 });
  hosts.remember({ address: '10.0.0.9', port: 7321, instanceId: 'inst-a', identityName: '甲' });
  assert.equal(JSON.parse(readFileSync(join(dir, KNOWN_HOSTS_FILE_NAME), 'utf8')).hosts.length, 1, '新键立即落盘');
  hosts.remember({ address: '10.0.0.9', port: 7321, instanceId: 'inst-a', identityName: '甲改名' });
  assert.equal(hosts.list()[0].identityName, '甲改名', '内存态即时更新（择新排序不受节流影响）');
  assert.equal(JSON.parse(readFileSync(join(dir, KNOWN_HOSTS_FILE_NAME), 'utf8')).hosts[0].identityName, '甲', '窗口内磁盘保持前一版');
  hosts.remember({ address: '10.0.0.10', port: 7321, instanceId: 'inst-b', identityName: '乙' });
  const onDisk = JSON.parse(readFileSync(join(dir, KNOWN_HOSTS_FILE_NAME), 'utf8'));
  assert.deepEqual(onDisk.hosts.map((entry) => entry.address).sort(), ['10.0.0.10', '10.0.0.9'], '新键落盘时带出窗口内的同键更新');
  assert.equal(onDisk.hosts.find((entry) => entry.address === '10.0.0.9').identityName, '甲改名', '带出的是内存最新版（非窗口前的旧版）');

  const immediateDir = makeTempDir(t);
  const immediate = createKnownHosts({ dataDir: immediateDir, log, persistMinIntervalMs: 0 });
  immediate.remember({ address: '10.0.0.9', port: 7321, instanceId: 'inst-a', identityName: '甲' });
  immediate.remember({ address: '10.0.0.9', port: 7321, instanceId: 'inst-a', identityName: '甲改名' });
  assert.equal(JSON.parse(readFileSync(join(immediateDir, KNOWN_HOSTS_FILE_NAME), 'utf8')).hosts[0].identityName, '甲改名', '窗口注入 0 = 每次都落盘（既有直测口径）');
});
