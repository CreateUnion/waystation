import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KNOWN_HOSTS_FILE_NAME, MAX_KNOWN_HOSTS, MAX_KNOWN_SESSIONS, createKnownHosts, participantsStateOf } from '../src/net/known-hosts.js';
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
  assert.equal(onDisk.version, 4);
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
  assert.equal(onDisk.version, 4);
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
  assert.equal(Object.hasOwn(hosts.list()[0], 'sessions'), false, 'v1 条目无会话字段＝未知');
  // 下一次写入即 v3 形态
  hosts.remember({ address: '10.0.0.2', port: 7322, instanceId: 'inst-b', identityName: '乙' });
  const onDisk = JSON.parse(readFileSync(join(dir, KNOWN_HOSTS_FILE_NAME), 'utf8'));
  assert.equal(onDisk.version, 4);
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

test('remember 存会话短码：短码化（前 8 字符）＋有界截断；缺字段＝未知、空数组如实在场', (t) => {
  const { dir, hosts } = makeHosts(t);
  hosts.remember({ address: '10.0.0.1', port: 7321, sessions: ['9f8e7d6c5b4a3210', 'ab12cd34ef56'] });
  assert.deepEqual(hosts.list()[0].sessions, ['9f8e7d6c', 'ab12cd34'], '对外一律短码（全量标识不落清单）');
  hosts.remember({ address: '10.0.0.2', port: 7321, sessions: [] });
  assert.deepEqual(hosts.list().find((entry) => entry.address === '10.0.0.2').sessions, [], '对端报了零会话＝空数组在场（与「没报」区分）');
  hosts.remember({ address: '10.0.0.3', port: 7321 });
  assert.equal(Object.hasOwn(hosts.list().find((entry) => entry.address === '10.0.0.3'), 'sessions'), false, '没报会话＝未知：不改写成空数组');
  const many = Array.from({ length: MAX_KNOWN_SESSIONS + 8 }, (_, index) => `s${String(index).padStart(7, '0')}-full`);
  hosts.remember({ address: '10.0.0.4', port: 7321, sessions: many });
  const bounded = hosts.list().find((entry) => entry.address === '10.0.0.4').sessions;
  assert.equal(bounded.length, MAX_KNOWN_SESSIONS, '超限截断（会话段是顺带可见性，不承载无界列表）');
  assert.deepEqual(bounded, many.slice(0, MAX_KNOWN_SESSIONS).map((id) => id.slice(0, 8)));
  const onDisk = JSON.parse(readFileSync(join(dir, KNOWN_HOSTS_FILE_NAME), 'utf8'));
  assert.deepEqual(onDisk.hosts.find((entry) => entry.address === '10.0.0.1').sessions, ['9f8e7d6c', 'ab12cd34'], '短码原样落盘');
  assert.equal(Object.hasOwn(onDisk.hosts.find((entry) => entry.address === '10.0.0.3'), 'sessions'), false, '未知不落字段（重载后仍是未知）');
});

test('清单载入：旧条目（无会话字段）兼容为未知；带字段条目短码化并截断；非法形态按未知', (t) => {
  const dir = makeTempDir(t);
  writeFileSync(join(dir, KNOWN_HOSTS_FILE_NAME), JSON.stringify({
    version: 2,
    hosts: [
      { address: '10.0.0.1', port: 7321, lastSeenAt: '2026-01-01T00:00:00.000Z' },
      { address: '10.0.0.2', port: 7321, lastSeenAt: '2026-01-01T00:00:00.000Z', sessions: ['9f8e7d6c5b4a3210', 'ab12cd34ef56'] },
      { address: '10.0.0.3', port: 7321, lastSeenAt: '2026-01-01T00:00:00.000Z', sessions: 'not-an-array' },
      { address: '10.0.0.4', port: 7321, lastSeenAt: '2026-01-01T00:00:00.000Z', sessions: Array.from({ length: MAX_KNOWN_SESSIONS + 5 }, (_, index) => `t${String(index).padStart(7, '0')}`) },
    ],
  }));
  const { hosts } = makeHosts(t, { dataDir: dir });
  const byAddress = new Map(hosts.list().map((entry) => [entry.address, entry]));
  assert.equal(Object.hasOwn(byAddress.get('10.0.0.1'), 'sessions'), false, '旧版本条目缺字段＝未知（兼容读取，不臆断零会话）');
  assert.deepEqual(byAddress.get('10.0.0.2').sessions, ['9f8e7d6c', 'ab12cd34'], '载入同样短码化');
  assert.equal(Object.hasOwn(byAddress.get('10.0.0.3'), 'sessions'), false, '非法形态按未知（不臆断）');
  assert.equal(byAddress.get('10.0.0.4').sessions.length, MAX_KNOWN_SESSIONS, '载入亦服从上限（手改 / 旧版残留同口径）');
  assert.equal(hosts.stats().invalidEntries, 0, '会话段形态宽容：条目本身仍有效（存储级底线只管条目骨架）');
});

test('先应答后探测：探测态 remember（无会话字段）继承既有短码，不抹掉已存会话', (t) => {
  const dir = makeTempDir(t);
  /* 立即落盘（窗口注入 0）：本用例要断言「继承值也进磁盘」，默认 5s 节流会让磁盘停在首版 */
  const hosts = createKnownHosts({ dataDir: dir, log: { info: () => {}, error: () => {}, warn: () => {} }, persistMinIntervalMs: 0 });
  hosts.remember({ address: '10.0.0.9', port: 7321, instanceId: 'inst-a', identityName: '甲', sessions: ['9f8e7d6c5b4a3210', 'ab12cd34ef56'] });
  hosts.remember({ address: '10.0.0.9', port: 7321, instanceId: 'inst-a', identityName: '甲' });   // 探测 / 启动自介路径：不带该字段
  assert.deepEqual(hosts.list()[0].sessions, ['9f8e7d6c', 'ab12cd34'], '缺字段＝这份没报（不是「零会话」），继承既有短码');
  assert.equal(hosts.stats().remembered, 2, '继承同样是一次真实写入（身份与 lastSeenAt 照常刷新）');
  hosts.remember({ address: '10.0.0.9', port: 7321, instanceId: 'inst-a', identityName: '甲', sessions: [] });
  assert.deepEqual(hosts.list()[0].sessions, [], '明确申报零会话（空数组）＝覆盖');
  hosts.remember({ address: '10.0.0.9', port: 7321, instanceId: 'inst-a', identityName: '甲', sessions: ['9f8e7d6c5b4a3210'] });
  assert.deepEqual(hosts.list()[0].sessions, ['9f8e7d6c'], '重新申报（短码变了）＝覆盖');
  hosts.remember({ address: '10.0.0.9', port: 7321, instanceId: 'inst-a', identityName: '甲', sessions: 'not-an-array' });
  assert.deepEqual(hosts.list()[0].sessions, ['9f8e7d6c'], '无法整形＝这份没有可用情报，保留已知（与「未报」同一处置——取舍见报告）');
  const onDisk = JSON.parse(readFileSync(join(dir, KNOWN_HOSTS_FILE_NAME), 'utf8'));
  assert.deepEqual(onDisk.hosts[0].sessions, ['9f8e7d6c'], '继承值落盘（重载不丢）');
});

test('会话段继承限同实例：同键（地址:端口）换主时不继承上一台的短码', (t) => {
  const dir = makeTempDir(t);
  const hosts = createKnownHosts({ dataDir: dir, log: { info: () => {}, error: () => {}, warn: () => {} }, persistMinIntervalMs: 0 });
  hosts.remember({ address: '10.0.0.9', port: 7321, instanceId: 'inst-a', identityName: '甲', sessions: ['9f8e7d6c5b4a3210'] });
  hosts.remember({ address: '10.0.0.9', port: 7321, instanceId: 'inst-b', identityName: '乙' });   // 同键换主：探测态（不带会话字段）
  assert.equal(Object.hasOwn(hosts.list()[0], 'sessions'), false, '键碰撞下不继承（上一台的短码不是这一台的情报）');
  hosts.remember({ address: '10.0.0.10', port: 7321, instanceId: 'inst-a', identityName: '甲', sessions: ['9f8e7d6c5b4a3210'] });
  hosts.remember({ address: '10.0.0.10', port: 7321, instanceId: 'inst-a', identityName: '甲' });   // 同键同实例：探测态照旧继承
  assert.deepEqual(hosts.list().find((entry) => entry.address === '10.0.0.10').sessions, ['9f8e7d6c'], '同实例的探测态仍继承既有短码（回归：守卫不误伤）');
});

test('无既有会话段的条目：探测态 remember 不臆造空数组（继承不越界为「零会话」）', (t) => {
  const { hosts } = makeHosts(t);
  hosts.remember({ address: '10.0.0.9', port: 7321, instanceId: 'inst-a', identityName: '甲' });
  hosts.remember({ address: '10.0.0.9', port: 7321, instanceId: 'inst-a', identityName: '甲改名' });
  assert.equal(Object.hasOwn(hosts.list()[0], 'sessions'), false, '从没报过＝未知，连续探测也不改写成空数组');
});

test('会话段与全量标识混入：只采字符串短码，非字符串项剔除', (t) => {
  const { hosts } = makeHosts(t);
  hosts.remember({ address: '10.0.0.1', port: 7321, sessions: ['9f8e7d6c5b4a3210', 42, null, '', 'ab12cd34ef56'] });
  assert.deepEqual(hosts.list()[0].sessions, ['9f8e7d6c', 'ab12cd34'], '非字符串与空串不入清单（对端整形的良心不由本层假设）');
});

test('remember 存 participants：2＝支持、0＝不支持、缺字段＝未知；未报继承、已确立支持态不被旧版应答降级', (t) => {
  const { dir, hosts } = makeHosts(t);
  hosts.remember({ address: '10.0.0.1', port: 7321, instanceId: 'inst-a', participants: 2 });
  assert.equal(hosts.list()[0].participants, 2);
  hosts.remember({ address: '10.0.0.1', port: 7321, instanceId: 'inst-a' });   // 探测 / 启动自介：不携能力
  assert.equal(hosts.list()[0].participants, 2, '未报字段＝这份没有情报，继承已知（探测不得抹掉能力）');
  hosts.remember({ address: '10.0.0.1', port: 7321, instanceId: 'inst-a', participants: 0 });   // 旧版应答缺字段
  assert.equal(hosts.list()[0].participants, 2, '缺字段的旧版应答不推翻已确立的支持态（不覆盖已知）');
  hosts.remember({ address: '10.0.0.2', port: 7321, instanceId: 'inst-b', participants: 0 });
  assert.equal(hosts.list().find((entry) => entry.address === '10.0.0.2').participants, 0, '从未支持过的旧版对端＝不支持');
  hosts.remember({ address: '10.0.0.2', port: 7321, instanceId: 'inst-b', participants: 2 });
  assert.equal(hosts.list().find((entry) => entry.address === '10.0.0.2').participants, 2, '升级后重新申报支持＝覆盖不支持');
  hosts.remember({ address: '10.0.0.3', port: 7321, instanceId: 'inst-c' });
  assert.equal(Object.hasOwn(hosts.list().find((entry) => entry.address === '10.0.0.3'), 'participants'), false, '从未报过＝未知（不臆造不支持）');
  hosts.remember({ address: '10.0.0.3', port: 7321, instanceId: 'inst-c', participants: '2' });
  assert.equal(Object.hasOwn(hosts.list().find((entry) => entry.address === '10.0.0.3'), 'participants'), false, '非法形态按未知；条目本身仍有效');
  const onDisk = JSON.parse(readFileSync(join(dir, KNOWN_HOSTS_FILE_NAME), 'utf8'));
  assert.equal(onDisk.version, 4, '存储版本升 4');
  assert.equal(onDisk.hosts.find((entry) => entry.address === '10.0.0.1').participants, 2, '能力随清单落盘');
  assert.equal(Object.hasOwn(onDisk.hosts.find((entry) => entry.address === '10.0.0.3'), 'participants'), false, '未知不落字段（重载后仍是未知）');
});

test('participants 继承限同实例：同键换主时上一台的能力不落到新实例', (t) => {
  const { hosts } = makeHosts(t);
  hosts.remember({ address: '10.0.0.9', port: 7321, instanceId: 'inst-a', participants: 2 });
  hosts.remember({ address: '10.0.0.9', port: 7321, instanceId: 'inst-b' });   // 换主后的探测
  assert.equal(Object.hasOwn(hosts.list()[0], 'participants'), false, '键碰撞下不继承（上一台的能力不是这一台的）');
  hosts.remember({ address: '10.0.0.10', port: 7321, instanceId: 'inst-a', participants: 2 });
  hosts.remember({ address: '10.0.0.10', port: 7321, instanceId: 'inst-a' });
  assert.equal(hosts.list().find((entry) => entry.address === '10.0.0.10').participants, 2, '同实例未报仍继承（守卫不误伤）');
});

test('v4 载入：participants 2/0 原样保留、非法值与缺字段按未知；下一次写入即 v4 形态', (t) => {
  const dir = makeTempDir(t);
  writeFileSync(join(dir, KNOWN_HOSTS_FILE_NAME), JSON.stringify({
    version: 4,
    hosts: [
      { address: '10.0.0.1', port: 7321, instanceId: 'i1', identityName: '甲', lastSeenAt: '2026-01-01T00:00:00.000Z', participants: 2 },
      { address: '10.0.0.2', port: 7321, instanceId: 'i2', identityName: '乙', lastSeenAt: '2026-01-01T00:00:00.000Z', participants: 0 },
      { address: '10.0.0.3', port: 7321, instanceId: 'i3', identityName: '丙', lastSeenAt: '2026-01-01T00:00:00.000Z', participants: 1 },
      { address: '10.0.0.4', port: 7321, instanceId: 'i4', identityName: '丁', lastSeenAt: '2026-01-01T00:00:00.000Z' },
    ],
  }));
  const { hosts } = makeHosts(t, { dataDir: dir });
  const byAddress = new Map(hosts.list().map((entry) => [entry.address, entry]));
  assert.equal(byAddress.get('10.0.0.1').participants, 2);
  assert.equal(byAddress.get('10.0.0.2').participants, 0, '不支持态随清单载入');
  assert.equal(Object.hasOwn(byAddress.get('10.0.0.3'), 'participants'), false, '非法值按未知（条目仍有效）');
  assert.equal(Object.hasOwn(byAddress.get('10.0.0.4'), 'participants'), false, '旧条目缺字段＝未知');
  assert.equal(hosts.stats().invalidEntries, 0, '能力字段形态宽容：条目骨架有效即保留');
  hosts.remember({ address: '10.0.0.5', port: 7321 });
  const onDisk = JSON.parse(readFileSync(join(dir, KNOWN_HOSTS_FILE_NAME), 'utf8'));
  assert.equal(onDisk.version, 4);
  assert.equal(onDisk.hosts.find((entry) => entry.address === '10.0.0.1').participants, 2, '重写保留已载入的能力');
});

test('participantsStateOf / participantsOf：三态映射与按实例取最近值', (t) => {
  assert.equal(participantsStateOf({ participants: 2 }), 'supported');
  assert.equal(participantsStateOf({ participants: 0 }), 'unsupported');
  assert.equal(participantsStateOf({}), 'unknown');
  assert.equal(participantsStateOf(null), 'unknown');
  const { hosts } = makeHosts(t);
  assert.equal(hosts.participantsOf('inst-x'), undefined);
  assert.equal(hosts.participantsOf(''), undefined);
  hosts.remember({ address: '10.0.0.1', port: 7321, instanceId: 'inst-x', participants: 0 });
  hosts.remember({ address: '10.0.0.2', port: 7321, instanceId: 'inst-y', participants: 2 });
  assert.equal(hosts.participantsOf('inst-x'), 0);
  assert.equal(hosts.participantsOf('inst-y'), 2);
  hosts.remember({ address: '10.0.0.3', port: 7321, instanceId: 'inst-x', participants: 2 });
  assert.equal(hosts.participantsOf('inst-x'), 2, '同一实例多地址：一处确认支持即整机支持');
});
