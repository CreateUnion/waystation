import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  AUTO_OFFER_FILE_NAME,
  BINDINGS_FILE_NAME,
  CARRIER_FILE_NAME,
  COLLABS_DIR_NAME,
  CORE_JSON_FILE_NAME,
  DEPARTED_FILE_NAME,
  HANDOVER_OFFERS_FILE_NAME,
  HANDOVER_PENDING_FILE_NAME,
  INVITES_FILE_NAME,
  LOGS_DIR_NAME,
  MANAGER_PENDING_FILE_NAME,
  PENDING_INVITES_FILE_NAME,
  RECOVERY_FILE_NAME,
  RUN_DIR_NAME,
  SEATS_DIR_NAME,
  autoOfferFilePath,
  bindingsFilePath,
  carrierFilePath,
  collabDir,
  collabFilePath,
  coreJsonPath,
  departedFilePath,
  ensureDir,
  handoverOffersFilePath,
  handoverPendingFilePath,
  invitesFilePath,
  managerPendingFilePath,
  pendingInvitesFilePath,
  recoveryFilePath,
  resolveDataDir,
  resolveLogDir,
  runDir,
  seatFilePath,
  sessionFilePath,
  siteDataDir,
} from '../src/paths.js';
import { makeTempDir } from './helpers.js';

test('resolveDataDir：无环境变量时默认 ~/.waystation', () => {
  assert.equal(resolveDataDir({}), join(homedir(), '.waystation'));
  assert.equal(resolveDataDir({ WAYSTATION_HOME: '   ' }), join(homedir(), '.waystation'));
});

test('resolveDataDir：WAYSTATION_HOME 优先且完成规范化', () => {
  assert.equal(resolveDataDir({ WAYSTATION_HOME: 'ws-data' }), resolve('ws-data'));
  assert.equal(resolveDataDir({ WAYSTATION_HOME: '  ws-data  ' }), resolve('ws-data'));
});

test('resolveLogDir：默认 <dataDir>/logs，相对配置值以 dataDir 为锚（不随 CWD 漂移）', () => {
  const dataDir = resolve('data-home');
  assert.equal(resolveLogDir(dataDir, ''), join(dataDir, LOGS_DIR_NAME));
  assert.equal(resolveLogDir(dataDir, undefined), join(dataDir, LOGS_DIR_NAME));
  assert.equal(resolveLogDir(dataDir, 'my-logs'), join(dataDir, 'my-logs'));
  const absolute = resolve('absolute-logs');
  assert.equal(resolveLogDir(dataDir, absolute), absolute);
});

test('ensureDir：递归创建且幂等', (t) => {
  const nested = join(makeTempDir(t), 'a', 'b', 'c');
  ensureDir(nested);
  assert.equal(statSync(nested).isDirectory(), true);
  ensureDir(nested);
  assert.equal(statSync(nested).isDirectory(), true);
});

test('目录名常量：collabs 为每协作目录的父级（设计 §15）', () => {
  assert.equal(COLLABS_DIR_NAME, 'collabs');
});

test('collabDir：协作目录按 collabId 拼接（每协作一个目录）', (t) => {
  const dir = makeTempDir(t);
  assert.equal(collabDir(dir, 'collab-1'), join(dir, COLLABS_DIR_NAME, 'collab-1'));
});

test('collabDir：非法 collabId 一律抛错——路径穿越的硬边界', () => {
  for (const bad of ['../evil', 'a/b', 'a.b', '', 'x'.repeat(65), 'has space', 123, null]) {
    assert.throws(() => collabDir('/data-root', bad), /collabId 非法/);
  }
});

test('collabFilePath：协作目录内的具名文件', (t) => {
  const dir = makeTempDir(t);
  assert.equal(
    collabFilePath(dir, 'collab-1', 'outbox.jsonl'),
    join(dir, COLLABS_DIR_NAME, 'collab-1', 'outbox.jsonl'),
  );
});

test('collabFilePath：非法 fileName 段一律抛 TypeError——与 collabId 同一硬边界', () => {
  for (const bad of ['../evil', 'a/b', 'a\\b', '..', '.', 'C:x', 'outbox.', '', 123, null]) {
    assert.throws(() => collabFilePath('/data-root', 'collab-1', bad), {
      name: 'TypeError',
      message: /fileName 非法/,
    });
  }
});

test('siteDataDir：槽位 2 及以后映射到 <主目录>/sites/<k>', (t) => {
  const dir = makeTempDir(t);
  assert.equal(siteDataDir(dir, 2), join(dir, 'sites', '2'));
  assert.equal(siteDataDir(dir, 8), join(dir, 'sites', '8'));
});

test('siteDataDir：槽位 1（主目录）与非法值抛 TypeError——不做清洗', (t) => {
  const dir = makeTempDir(t);
  for (const slot of [1, 0, -1, '2', 2.5, null]) {
    assert.throws(() => siteDataDir(dir, slot), TypeError, String(slot));
  }
});

test('sessionFilePath：非法会话标识抛出，合法拼接主数据目录 sessions/ 下', () => {
  assert.throws(() => sessionFilePath('/data', '../evil'), /sessionId 非法/);
  assert.throws(() => sessionFilePath('/data', ''), /sessionId 非法/);
  assert.throws(() => sessionFilePath('/data', 42), /sessionId 非法/);
  assert.equal(sessionFilePath('/data', 'session-abc-1'), join('/data', 'sessions', 'session-abc-1.json'));
});

test('run/ 常量：运行态目录与核心锁/绑定表文件（设计 §2.3/§6.1）', (t) => {
  const dir = makeTempDir(t);
  assert.equal(RUN_DIR_NAME, 'run');
  assert.equal(CORE_JSON_FILE_NAME, 'core.json');
  assert.equal(BINDINGS_FILE_NAME, 'bindings.json');
  assert.equal(runDir(dir), join(dir, 'run'));
  assert.equal(coreJsonPath(dir), join(dir, 'run', 'core.json'));
  assert.equal(bindingsFilePath(dir), join(dir, 'run', 'bindings.json'));
});

test('新协作文件：carrier / seats / 邀请 / 交接 / 离席历史 / 恢复标记（设计 §6.2）', (t) => {
  const dir = makeTempDir(t);
  const collab = join(dir, COLLABS_DIR_NAME, 'collab-1');
  assert.equal(CARRIER_FILE_NAME, 'carrier.json');
  assert.equal(SEATS_DIR_NAME, 'seats');
  assert.equal(INVITES_FILE_NAME, 'invites.json');
  assert.equal(PENDING_INVITES_FILE_NAME, 'pending-invites.json');
  assert.equal(HANDOVER_OFFERS_FILE_NAME, 'handover-offers.json');
  assert.equal(DEPARTED_FILE_NAME, 'departed.jsonl');
  assert.equal(RECOVERY_FILE_NAME, 'recovery.json');
  assert.equal(carrierFilePath(dir, 'collab-1'), join(collab, 'carrier.json'));
  assert.equal(seatFilePath(dir, 'collab-1', 'session-a'), join(collab, 'seats', 'session-a.json'));
  assert.equal(invitesFilePath(dir, 'collab-1'), join(collab, 'invites.json'));
  assert.equal(pendingInvitesFilePath(dir, 'collab-1'), join(collab, 'pending-invites.json'));
  assert.equal(handoverOffersFilePath(dir, 'collab-1'), join(collab, 'handover-offers.json'));
  assert.equal(departedFilePath(dir, 'collab-1'), join(collab, 'departed.jsonl'));
  assert.equal(recoveryFilePath(dir, 'collab-1'), join(collab, 'recovery.json'));
});

test('新 run/ 文件：auto-offer / manager-pending / handover-pending 落在协作目录 run/ 下', (t) => {
  const dir = makeTempDir(t);
  const run = join(dir, COLLABS_DIR_NAME, 'collab-1', RUN_DIR_NAME);
  assert.equal(AUTO_OFFER_FILE_NAME, 'auto-offer.json');
  assert.equal(MANAGER_PENDING_FILE_NAME, 'manager-pending.json');
  assert.equal(HANDOVER_PENDING_FILE_NAME, 'handover-pending.json');
  assert.equal(autoOfferFilePath(dir, 'collab-1'), join(run, 'auto-offer.json'));
  assert.equal(managerPendingFilePath(dir, 'collab-1'), join(run, 'manager-pending.json'));
  assert.equal(handoverPendingFilePath(dir, 'collab-1'), join(run, 'handover-pending.json'));
});

test('新路径构造：collabId / sessionId 非法一律抛错——路径穿越硬边界不放宽', (t) => {
  const dir = makeTempDir(t);
  assert.throws(() => carrierFilePath(dir, '../evil'), /collabId 非法/);
  assert.throws(() => seatFilePath(dir, 'collab-1', '../evil'), /sessionId 非法/);
  assert.throws(() => seatFilePath(dir, 'collab-1', ''), /sessionId 非法/);
  assert.throws(() => autoOfferFilePath(dir, 'a/b'), /collabId 非法/);
});
