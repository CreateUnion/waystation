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

test('清单缺失：空起步，list/addresses 为空', (t) => {
  const { hosts } = makeHosts(t);
  assert.deepEqual(hosts.list(), []);
  assert.deepEqual(hosts.addresses(), []);
  assert.equal(hosts.stats().entries, 0);
});

test('remember：落盘为 version+hosts 形态，addresses 可读', (t) => {
  const { dir, hosts } = makeHosts(t);
  hosts.remember({ address: '192.168.0.140', instanceId: 'inst-b', identityName: '主机乙' });
  assert.deepEqual(hosts.addresses(), ['192.168.0.140']);
  const onDisk = JSON.parse(readFileSync(join(dir, KNOWN_HOSTS_FILE_NAME), 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.hosts.length, 1);
  assert.equal(onDisk.hosts[0].address, '192.168.0.140');
  assert.equal(onDisk.hosts[0].identityName, '主机乙');
  assert.ok(!Number.isNaN(Date.parse(onDisk.hosts[0].lastSeenAt)));
});

test('同地址重复 remember：单条目、身份更新、lastSeenAt 刷新', (t) => {
  const { hosts } = makeHosts(t);
  hosts.remember({ address: '10.0.0.9', instanceId: 'inst-1', identityName: '旧名' });
  const before = hosts.list()[0].lastSeenAt;
  hosts.remember({ address: '10.0.0.9', instanceId: 'inst-1', identityName: '新名' });
  assert.equal(hosts.list().length, 1);
  assert.equal(hosts.list()[0].identityName, '新名');
  assert.ok(Date.parse(hosts.list()[0].lastSeenAt) >= Date.parse(before));
});

test('非法地址：忽略、计数、不落盘', (t) => {
  const { hosts } = makeHosts(t);
  for (const bad of ['abc', '1.2.3', '192.168.0.1/24', 123, undefined]) {
    hosts.remember({ address: bad });
  }
  assert.deepEqual(hosts.addresses(), []);
  assert.equal(hosts.stats().invalidEntries, 5);
});

test('超过上限：淘汰最旧（按 lastSeenAt）', (t) => {
  const dir = makeTempDir(t);
  const seeded = Array.from({ length: MAX_KNOWN_HOSTS }, (_, index) => ({
    address: `10.1.${Math.floor(index / 250)}.${index % 250}`,
    instanceId: '',
    identityName: '',
    lastSeenAt: new Date(1700000000000 + index * 1000).toISOString(),
  }));
  writeFileSync(join(dir, KNOWN_HOSTS_FILE_NAME), JSON.stringify({ version: 1, hosts: seeded }));
  const { hosts } = makeHosts(t, { dataDir: dir });
  assert.equal(hosts.stats().entries, MAX_KNOWN_HOSTS);
  hosts.remember({ address: '172.16.0.1' });
  assert.equal(hosts.stats().entries, MAX_KNOWN_HOSTS);
  assert.ok(hosts.addresses().includes('172.16.0.1'));
  assert.ok(!hosts.addresses().includes('10.1.0.0'), '应淘汰 lastSeenAt 最旧的条目');
});

test('载入超过上限：按最近时间裁剪（与 remember 淘汰口径一致）', (t) => {
  const dir = makeTempDir(t);
  const total = MAX_KNOWN_HOSTS + 6;
  const seeded = Array.from({ length: total }, (_, index) => ({
    address: `10.2.${Math.floor(index / 250)}.${index % 250}`,
    instanceId: '',
    identityName: '',
    lastSeenAt: new Date(1700000000000 + index * 1000).toISOString(),
  }));
  writeFileSync(join(dir, KNOWN_HOSTS_FILE_NAME), JSON.stringify({ version: 1, hosts: seeded }));
  const { hosts } = makeHosts(t, { dataDir: dir });
  assert.equal(hosts.stats().entries, MAX_KNOWN_HOSTS);
  assert.ok(hosts.addresses().includes('10.2.0.69'), '最新的条目应保留');
  assert.ok(!hosts.addresses().includes('10.2.0.5'), '最旧的 6 条应在载入时被裁剪');
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
  assert.deepEqual(hosts.addresses(), ['10.0.0.1']);
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
  hosts.remember({ address: '10.7.7.7', instanceId: 'inst-7', identityName: '主机七' });
  assert.deepEqual(hosts.addresses(), ['10.7.7.7']);
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
