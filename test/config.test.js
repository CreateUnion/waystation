import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { CONFIG_FILE_NAME, buildDefaults, loadConfig, saveConfig } from '../src/config.js';
import { MAX_IDENTITY_NAME_CHARS, isIdentityName } from '../src/net/protocol.js';
import { makeTempDir } from './helpers.js';

test('文件缺失：返回默认值且 created=true', (t) => {
  const dir = makeTempDir(t);
  const { config, created } = loadConfig(dir);
  assert.equal(created, true);
  assert.equal(config.identityName, hostname());
  assert.equal(config.port, 7321);
  assert.equal(config.offlineQueue, true);
  assert.equal(config.autoDeliver, true);
  assert.equal(config.logDir, '');
  assert.equal(config.logMaxBytes, 1048576);
  assert.equal(config.logMaxFiles, 5);
  assert.equal(config.probeTimeoutMs, 1000);
  assert.equal(config.inviteTtlMs, 24 * 60 * 60 * 1000);
  assert.equal(config.managerProbeIntervalMs, 30000);
  assert.equal(config.managerOfflineMs, 120000);
  assert.equal(config.takeoverWindowMs, 30000);
  assert.equal(config.freezeUnresolvedMs, 48 * 60 * 60 * 1000);
  assert.equal(config.forumSyncIntervalMs, 60000);
});

test('buildDefaults：标识名取传入主机名，形状完整', () => {
  const defaults = buildDefaults('主机甲');
  assert.deepEqual(Object.keys(defaults).sort(), [
    'autoDeliver',
    'dialTimeoutMs',
    'dispatchTickMs',
    'forumSyncIntervalMs',
    'freezeUnresolvedMs',
    'identityName',
    'inviteTtlMs',
    'logDir',
    'logMaxBytes',
    'logMaxFiles',
    'managerOfflineMs',
    'managerProbeIntervalMs',
    'messageTtlMs',
    'offlineQueue',
    'port',
    'probeTimeoutMs',
    'queueMaxPerCollab',
    'retryFastCount',
    'retryIntervalMs',
    'retrySlowIntervalMs',
    'scanWindowMs',
    'takeoverWindowMs',
  ]);
  assert.equal(defaults.identityName, '主机甲');
});

test('saveConfig + loadConfig：往返保持取值且 created=false', (t) => {
  const dir = makeTempDir(t);
  const { config } = loadConfig(dir);
  config.identityName = '工位机';
  config.port = 17321;
  saveConfig(dir, config);
  const reloaded = loadConfig(dir);
  assert.equal(reloaded.created, false);
  assert.equal(reloaded.config.identityName, '工位机');
  assert.equal(reloaded.config.port, 17321);
});

test('文件损坏：保留副本、按默认值重建并告警', (t) => {
  const dir = makeTempDir(t);
  writeFileSync(join(dir, CONFIG_FILE_NAME), '{oops');
  const warnings = [];
  const { config, created } = loadConfig(dir, { warn: (message) => warnings.push(message) });
  assert.equal(created, true);
  assert.equal(config.port, 7321);
  const backups = readdirSync(dir).filter((name) => name.startsWith(`${CONFIG_FILE_NAME}.corrupt-`));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(dir, backups[0]), 'utf8'), '{oops');
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('配置文件损坏'));
});

test('根节点非对象：同样走损坏保留路径', (t) => {
  const dir = makeTempDir(t);
  writeFileSync(join(dir, CONFIG_FILE_NAME), '[1,2,3]');
  const warnings = [];
  const { created } = loadConfig(dir, { warn: (message) => warnings.push(message) });
  assert.equal(created, true);
  assert.ok(warnings[0].includes('配置文件损坏'));
  const backups = readdirSync(dir).filter((name) => name.startsWith(`${CONFIG_FILE_NAME}.corrupt-`));
  assert.equal(backups.length, 1);
});

test('已知字段类型非法：该项回落默认值并告警，其余保留', (t) => {
  const dir = makeTempDir(t);
  writeFileSync(
    join(dir, CONFIG_FILE_NAME),
    JSON.stringify({ identityName: '自定义名', port: 'abc', offlineQueue: 'yes', logMaxFiles: 9999 }),
  );
  const warnings = [];
  const { config, created } = loadConfig(dir, { warn: (message) => warnings.push(message) });
  assert.equal(created, false);
  assert.equal(config.identityName, '自定义名');
  assert.equal(config.port, 7321);
  assert.equal(config.offlineQueue, true);
  assert.equal(config.logMaxFiles, 5);
  assert.equal(warnings.length, 3);
  assert.ok(warnings.every((message) => message.includes('无效')));
});

test('未知字段：原样保留，重写不丢（前向兼容）', (t) => {
  const dir = makeTempDir(t);
  writeFileSync(join(dir, CONFIG_FILE_NAME), JSON.stringify({ futureFeature: { enabled: true } }));
  const { config } = loadConfig(dir);
  assert.deepEqual(config.futureFeature, { enabled: true });
  saveConfig(dir, config);
  const onDisk = JSON.parse(readFileSync(join(dir, CONFIG_FILE_NAME), 'utf8'));
  assert.deepEqual(onDisk.futureFeature, { enabled: true });
});

test('保留名键（toString/constructor/__proto__）：按未知字段处理、不抛、不污染原型', (t) => {
  const dir = makeTempDir(t);
  writeFileSync(
    join(dir, CONFIG_FILE_NAME),
    '{"toString": 123, "constructor": "x", "__proto__": {"polluted": true}}',
  );
  const warnings = [];
  const { config } = loadConfig(dir, { warn: (message) => warnings.push(message) });
  assert.equal(config.toString, 123);
  assert.equal(config.constructor, 'x');
  assert.equal(Object.hasOwn(config, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(config), Object.prototype);
  assert.equal({}.polluted, undefined);
  assert.equal(config.port, 7321);
  assert.deepEqual(warnings, []);
});

test('网络与消息参数默认值（设计 §5/§10 明文默认）', (t) => {
  const dir = makeTempDir(t);
  const { config } = loadConfig(dir);
  assert.equal(config.scanWindowMs, 2000);
  assert.equal(config.retryIntervalMs, 10000);
  assert.equal(config.retrySlowIntervalMs, 60000);
  assert.equal(config.retryFastCount, 3);
  assert.equal(config.queueMaxPerCollab, 500);
  assert.equal(config.messageTtlMs, 604800000);
  assert.equal(config.dispatchTickMs, 1000);
  assert.equal(config.dialTimeoutMs, 5000);
});

test('identityName 超长（>64 字符）：回落默认并告警', (t) => {
  const dir = makeTempDir(t);
  writeFileSync(join(dir, CONFIG_FILE_NAME), JSON.stringify({ identityName: 'x'.repeat(65) }));
  const warnings = [];
  const { config } = loadConfig(dir, { warn: (message) => warnings.push(message) });
  assert.equal(config.identityName, hostname());
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('identityName'));
});

test('网络参数类型或范围非法：逐项回落默认并告警', (t) => {
  const dir = makeTempDir(t);
  writeFileSync(
    join(dir, CONFIG_FILE_NAME),
    JSON.stringify({ retryIntervalMs: -1, queueMaxPerCollab: 'many', scanWindowMs: 0 }),
  );
  const warnings = [];
  const { config } = loadConfig(dir, { warn: (message) => warnings.push(message) });
  assert.equal(config.retryIntervalMs, 10000);
  assert.equal(config.queueMaxPerCollab, 500);
  assert.equal(config.scanWindowMs, 2000);
  assert.equal(warnings.length, 3);
});

test('buildDefaults：槽位感知默认（身份名后缀与端口段）', () => {
  assert.deepEqual(buildDefaults('主机甲', { slot: 3 }), {
    ...buildDefaults('主机甲'),
    identityName: '主机甲-3',
    port: 7323,
  });
  assert.equal(buildDefaults('主机甲', { slot: 1 }).identityName, '主机甲');
  assert.equal(buildDefaults('主机甲', { slot: 1 }).port, 7321);
  assert.equal(buildDefaults('主机甲').port, 7321);
  for (const slot of [0, 9, '2', 2.5]) {
    assert.throws(() => buildDefaults('主机甲', { slot }), TypeError, String(slot));
  }
});

test('buildDefaults：长主机名的默认身份名按上限截断（槽位后缀优先保留）', () => {
  /* 主机名可长到让「主机名-<k>」越过身份名上限（单标签上限 63 字符，加后缀即 65）——
   * 越界默认值会让该站点全部出站帧被协议预检拒（LAN 整站不可用），故派生时截断主机名部分。 */
  const boundaryHost = 'x'.repeat(MAX_IDENTITY_NAME_CHARS - 1);   // 63 字符：加「-2」即 65，必须截断
  const derived = buildDefaults(boundaryHost, { slot: 2 }).identityName;
  assert.ok(derived.length <= MAX_IDENTITY_NAME_CHARS, `${derived.length} 字符`);
  assert.ok(derived.endsWith('-2'), '槽位后缀优先保留');
  assert.equal(isIdentityName(derived), true, derived);
  assert.equal(boundaryHost.startsWith(derived.slice(0, -2)), true, '主机名部分原样前缀');

  const longHost = 'y'.repeat(MAX_IDENTITY_NAME_CHARS + 8);   // 主机名本身即越界：任何派生都必须落回上限内
  for (const options of [{}, { slot: 1 }, { slot: 8 }]) {
    const name = buildDefaults(longHost, options).identityName;
    assert.ok(name.length <= MAX_IDENTITY_NAME_CHARS, `${JSON.stringify(options)} → ${name.length} 字符`);
    assert.equal(isIdentityName(name), true, name);
  }
  assert.equal(buildDefaults('主机甲', { slot: 3 }).identityName, '主机甲-3', '常规长度不受截断影响');
});

test('loadConfig：defaults 参数指定站点默认（槽位目录首跑）', (t) => {
  const dir = makeTempDir(t);
  const { config, created } = loadConfig(dir, { defaults: buildDefaults('主机甲', { slot: 2 }) });
  assert.equal(created, true);
  assert.equal(config.identityName, '主机甲-2');
  assert.equal(config.port, 7322);
});

test('identityName 白名单：配置值含控制字符 / 零宽字符 → 回落默认并告警', (t) => {
  const dir = makeTempDir(t);
  writeFileSync(join(dir, CONFIG_FILE_NAME), JSON.stringify({ identityName: '甲\u0007乙' }));
  const warnings = [];
  const { config, identityDefaulted } = loadConfig(dir, { warn: (message) => warnings.push(message) });
  assert.equal(config.identityName, hostname());
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('identityName'));
  assert.equal(identityDefaulted, false, '非法非空值不是「未设置」：照旧告警回落、不带提示标志');
});

test('identityName 未设置（缺文件 / null / 空串 / 纯空白）：无告警、identityDefaulted=true、生效值=默认机器名', (t) => {
  const cases = [
    { raw: null, created: true, label: '缺文件' },
    { raw: { identityName: null }, created: false, label: 'null' },
    { raw: { identityName: '' }, created: false, label: '空串' },
    { raw: { identityName: '   ' }, created: false, label: '纯空白' },
  ];
  for (const item of cases) {
    const dir = makeTempDir(t);
    if (item.raw !== null) {
      writeFileSync(join(dir, CONFIG_FILE_NAME), JSON.stringify(item.raw));
    }
    const warnings = [];
    const { config, created, identityDefaulted } = loadConfig(dir, { warn: (message) => warnings.push(message) });
    assert.equal(created, item.created, item.label);
    assert.equal(identityDefaulted, true, item.label);
    assert.deepEqual(warnings, [], `${item.label}：未设置不应告警`);
    assert.equal(config.identityName, hostname(), item.label);
  }
});

test('identityName 有值（合法 / 非法非空）：identityDefaulted=false，不触发一次性提示', (t) => {
  const valid = makeTempDir(t);
  writeFileSync(join(valid, CONFIG_FILE_NAME), JSON.stringify({ identityName: '工位机' }));
  const okLoad = loadConfig(valid);
  assert.equal(okLoad.identityDefaulted, false);
  assert.equal(okLoad.config.identityName, '工位机');
  for (const raw of [{ identityName: 'x'.repeat(65) }, { identityName: '甲\u0007乙' }, { identityName: 123 }, { identityName: [] }]) {
    const dir = makeTempDir(t);
    writeFileSync(join(dir, CONFIG_FILE_NAME), JSON.stringify(raw));
    const warnings = [];
    const { config, identityDefaulted } = loadConfig(dir, { warn: (message) => warnings.push(message) });
    assert.equal(identityDefaulted, false, JSON.stringify(raw));
    assert.equal(warnings.length, 1, JSON.stringify(raw));
    assert.ok(warnings[0].includes('identityName'), JSON.stringify(raw));
    assert.equal(config.identityName, hostname(), JSON.stringify(raw));
  }
});

test('identityName 未设置 + 槽位默认（defaults 注入）：identityDefaulted=true、生效值=槽位默认名', (t) => {
  const dir = makeTempDir(t);
  writeFileSync(join(dir, CONFIG_FILE_NAME), JSON.stringify({ identityName: '' }));
  const { config, identityDefaulted } = loadConfig(dir, { defaults: buildDefaults('主机甲', { slot: 2 }) });
  assert.equal(identityDefaulted, true);
  assert.equal(config.identityName, '主机甲-2');
  const fresh = makeTempDir(t);
  assert.equal(loadConfig(fresh, { defaults: buildDefaults('主机甲', { slot: 3 }) }).identityDefaulted, true, '字段缺失同样按未设置处理');
});

test('probeTimeoutMs：范围非法回落默认并告警', (t) => {
  const dir = makeTempDir(t);
  writeFileSync(join(dir, CONFIG_FILE_NAME), JSON.stringify({ probeTimeoutMs: 10 }));
  const warnings = [];
  const { config } = loadConfig(dir, { warn: (message) => warnings.push(message) });
  assert.equal(config.probeTimeoutMs, 1000);
  assert.equal(warnings.length, 1);
});

test('inviteTtlMs：默认 24 小时、越界回落默认并告警', (t) => {
  assert.equal(buildDefaults('主机甲').inviteTtlMs, 24 * 60 * 60 * 1000);
  const dir = makeTempDir(t);
  writeFileSync(join(dir, CONFIG_FILE_NAME), JSON.stringify({ inviteTtlMs: 10 }));
  const warnings = [];
  const { config } = loadConfig(dir, { warn: (message) => warnings.push(message) });
  assert.equal(config.inviteTtlMs, 24 * 60 * 60 * 1000);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('inviteTtlMs'));
});

test('managerProbeIntervalMs：默认 30 秒、越界回落默认并告警', (t) => {
  assert.equal(buildDefaults('主机甲').managerProbeIntervalMs, 30000);
  const dir = makeTempDir(t);
  writeFileSync(join(dir, CONFIG_FILE_NAME), JSON.stringify({ managerProbeIntervalMs: 99 }));
  const warnings = [];
  const { config } = loadConfig(dir, { warn: (message) => warnings.push(message) });
  assert.equal(config.managerProbeIntervalMs, 30000);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('managerProbeIntervalMs'));
});

test('managerOfflineMs：默认 2 分钟、越界回落默认并告警', (t) => {
  assert.equal(buildDefaults('主机甲').managerOfflineMs, 120000);
  const dir = makeTempDir(t);
  writeFileSync(join(dir, CONFIG_FILE_NAME), JSON.stringify({ managerOfflineMs: 100 }));
  const warnings = [];
  const { config } = loadConfig(dir, { warn: (message) => warnings.push(message) });
  assert.equal(config.managerOfflineMs, 120000);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('managerOfflineMs'));
});

test('takeoverWindowMs：默认 30 秒、越界回落默认并告警', (t) => {
  assert.equal(buildDefaults('主机甲').takeoverWindowMs, 30000);
  const dir = makeTempDir(t);
  writeFileSync(join(dir, CONFIG_FILE_NAME), JSON.stringify({ takeoverWindowMs: 0 }));
  const warnings = [];
  const { config } = loadConfig(dir, { warn: (message) => warnings.push(message) });
  assert.equal(config.takeoverWindowMs, 30000);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('takeoverWindowMs'));
});

test('freezeUnresolvedMs：默认 48 小时、越界回落默认并告警', (t) => {
  assert.equal(buildDefaults('主机甲').freezeUnresolvedMs, 48 * 60 * 60 * 1000);
  const dir = makeTempDir(t);
  writeFileSync(join(dir, CONFIG_FILE_NAME), JSON.stringify({ freezeUnresolvedMs: 1000 }));
  const warnings = [];
  const { config } = loadConfig(dir, { warn: (message) => warnings.push(message) });
  assert.equal(config.freezeUnresolvedMs, 48 * 60 * 60 * 1000);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('freezeUnresolvedMs'));
});
