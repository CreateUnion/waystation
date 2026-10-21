import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir } from './helpers.js';
import {
  DEFAULT_RECOVERY_REASON,
  HALF_CREATED_STATE,
  MIGRATION_FILE_NAME,
  RECOVERY_FILE_NAME,
  isMigrationShape,
  isRecoveryShape,
  loadMigration,
  loadRecovery,
  readMigration,
  readRecovery,
  recoveryPath,
  writeRecovery,
} from '../src/collab/migration.js';
import { assertWritable, markLegacyCompleted } from '../src/collab/legacy.js';
import { writeCarrier } from '../src/collab/carrier.js';

const TS = '2026-10-21T08:00:00.000Z';

function collabDirOf(t) {
  const dir = join(makeTempDir(t), 'collab-1');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function sessionSeatsCarrier(overrides = {}) {
  return {
    format: 'session-seats',
    version: 1,
    collabId: 'collab-1',
    name: '联调项目',
    topic: '发布联调',
    mode: 'managed',
    endpoints: {},
    snapshotVersion: 1,
    createdAt: TS,
    ...overrides,
  };
}

function legacyMemberRecord() {
  return {
    collabId: 'collab-1',
    role: 'manager',
    state: 'active',
    name: '旧协作',
    manager: { instanceId: 'inst-a', identityName: '主机甲' },
    roster: [{ instanceId: 'inst-a', identityName: '主机甲' }],
    endpoints: { 'inst-a': { address: '127.0.0.1', port: 17321 } },
    decision: null,
  };
}

test('migration/recovery 形态：字段齐备才通过，半写不得冒充 legacy', () => {
  assert.equal(isMigrationShape({ legacy: true, archivedAt: TS, reason: 'legacy-format' }), true);
  assert.equal(isMigrationShape({ legacy: false, archivedAt: TS, reason: 'legacy-format' }), false);
  assert.equal(isMigrationShape({ legacy: true, archivedAt: 'bad', reason: 'legacy-format' }), false);
  assert.equal(isMigrationShape({ legacy: true, archivedAt: TS, reason: '' }), false);

  assert.equal(isRecoveryShape({ state: HALF_CREATED_STATE, at: TS, reason: DEFAULT_RECOVERY_REASON }), true);
  assert.equal(isRecoveryShape({ state: 'other', at: TS, reason: DEFAULT_RECOVERY_REASON }), false);
  assert.equal(isRecoveryShape({ state: HALF_CREATED_STATE, at: TS, reason: '' }), false);
  /* 半写是「新目录未完成」，不是旧协作归档：legacy 标记不得用于 recovery。 */
  assert.equal(isRecoveryShape({ legacy: true, archivedAt: TS, reason: 'legacy-format' }), false);
});

test('migration/recovery 读取：缺失或损坏一律 null，不抛出', (t) => {
  const dir = collabDirOf(t);
  assert.equal(readMigration(dir), null);
  assert.equal(readRecovery(dir), null);

  writeFileSync(join(dir, MIGRATION_FILE_NAME), '{ broken');
  writeFileSync(join(dir, RECOVERY_FILE_NAME), JSON.stringify({ state: 'half-created' }));
  assert.equal(readMigration(dir), null);
  assert.equal(readRecovery(dir), null);
});

test('writeRecovery：原子写半写标记，幂等且保留首次时刻', (t) => {
  const dir = collabDirOf(t);
  const first = writeRecovery(dir, { now: '2026-10-21T08:00:00.000Z', reason: 'carrier-without-ledger' });
  assert.deepEqual(first, {
    ok: true,
    written: true,
    record: { state: HALF_CREATED_STATE, at: '2026-10-21T08:00:00.000Z', reason: 'carrier-without-ledger' },
  });
  assert.deepEqual(readRecovery(dir), first.record);

  const second = writeRecovery(dir, { now: '2026-10-21T09:00:00.000Z', reason: 'other' });
  assert.equal(second.ok, true);
  assert.equal(second.written, false);
  assert.deepEqual(second.record, first.record);
  assert.equal(recoveryPath(dir), join(dir, RECOVERY_FILE_NAME));
});

test('writeRecovery：写失败返回失败结果而不抛出（调用方继续只读）', (t) => {
  const root = makeTempDir(t);
  const dir = join(root, 'not-created-yet');
  const result = writeRecovery(dir, { now: TS, reason: 'carrier-without-ledger' });
  assert.equal(result.ok, false);
  assert.equal(result.written, false);
  assert.equal(result.record, null);
  assert.ok(result.error instanceof Error);
});

test('assertWritable：空目录、缺失目录、正常新形态与邀请占位允许写', (t) => {
  const root = makeTempDir(t);
  assert.deepEqual(assertWritable(join(root, 'absent')), { ok: true });

  const empty = join(root, 'empty');
  mkdirSync(empty);
  assert.deepEqual(assertWritable(empty), { ok: true });

  const full = join(root, 'full');
  writeCarrier(full, sessionSeatsCarrier());
  writeFileSync(join(full, 'ledger.jsonl'), '{"version":1}\n');
  assert.deepEqual(assertWritable(full), { ok: true });

  const stub = join(root, 'stub');
  writeCarrier(stub, sessionSeatsCarrier({ format: 'invite-stub', snapshotVersion: 0 }));
  assert.deepEqual(assertWritable(stub), { ok: true });

  const pending = join(root, 'pending');
  mkdirSync(pending);
  writeFileSync(join(pending, 'pending-invites.json'), '{}');
  assert.deepEqual(assertWritable(pending), { ok: true }, '仅挂起邀请的目录不判损坏');
});

test('assertWritable：legacy/recovery/半写目录一律拒绝', (t) => {
  const root = makeTempDir(t);

  const half = join(root, 'half');
  writeCarrier(half, sessionSeatsCarrier());
  const halfResult = assertWritable(half);
  assert.equal(halfResult.ok, false);
  assert.equal(halfResult.reason, 'recovery');

  const legacy = join(root, 'legacy');
  mkdirSync(legacy);
  writeFileSync(join(legacy, 'member.json'), JSON.stringify(legacyMemberRecord()));
  const legacyResult = assertWritable(legacy);
  assert.equal(legacyResult.ok, false);
  assert.equal(legacyResult.reason, 'legacy');

  const recovered = join(root, 'recovered');
  mkdirSync(recovered);
  writeRecovery(recovered, { now: TS });
  const recoveredResult = assertWritable(recovered);
  assert.equal(recoveredResult.ok, false);
  assert.equal(recoveredResult.reason, 'recovery');

  assert.equal(assertWritable(join(root, 'absent-marker'), { legacy: true }).reason, 'legacy');
  assert.equal(assertWritable(join(root, 'absent-recovery'), { recovery: true }).reason, 'recovery');
});

test('assertWritable：损坏 carrier 与无标记非空目录按只读拒绝（fail-safe）', (t) => {
  const root = makeTempDir(t);

  const truncated = join(root, 'truncated');
  mkdirSync(truncated);
  writeFileSync(join(truncated, 'carrier.json'), '{"format":"session-seats"');
  const truncatedResult = assertWritable(truncated);
  assert.equal(truncatedResult.ok, false);
  assert.equal(truncatedResult.reason, 'corrupt');

  const emptyCarrier = join(root, 'empty-carrier');
  mkdirSync(emptyCarrier);
  writeFileSync(join(emptyCarrier, 'carrier.json'), '');
  assert.equal(assertWritable(emptyCarrier).reason, 'corrupt');

  const unmarked = join(root, 'unmarked');
  mkdirSync(unmarked);
  writeFileSync(join(unmarked, 'ledger.jsonl'), '{"version":1}\n');
  const unmarkedResult = assertWritable(unmarked);
  assert.equal(unmarkedResult.ok, false);
  assert.equal(unmarkedResult.reason, 'corrupt');

  const inboxOnly = join(root, 'inbox-only');
  mkdirSync(inboxOnly);
  writeFileSync(join(inboxOnly, 'inbox.jsonl'), '');
  assert.equal(assertWritable(inboxOnly).reason, 'corrupt');

  /* 标记文件存在但形态坏：不得当作「无标记」放行。 */
  const brokenMarker = join(root, 'broken-legacy-marker');
  mkdirSync(brokenMarker);
  writeFileSync(join(brokenMarker, MIGRATION_FILE_NAME), JSON.stringify({ legacy: false }));
  writeFileSync(join(brokenMarker, 'ledger.jsonl'), '{"version":1}\n');
  assert.equal(assertWritable(brokenMarker).reason, 'corrupt');
});

test('assertWritable：零字节台账按未落盘处理，标记文件不可读不得放行', (t) => {
  const root = makeTempDir(t);

  const zeroLedger = join(root, 'zero-ledger');
  writeCarrier(zeroLedger, sessionSeatsCarrier());
  writeFileSync(join(zeroLedger, 'ledger.jsonl'), '');
  const zeroResult = assertWritable(zeroLedger);
  assert.equal(zeroResult.ok, false);
  assert.equal(zeroResult.reason, 'recovery');

  const brokenMarker = join(root, 'broken-marker');
  writeCarrier(brokenMarker, sessionSeatsCarrier());
  writeFileSync(join(brokenMarker, 'ledger.jsonl'), '{"version":1}\n');
  mkdirSync(join(brokenMarker, RECOVERY_FILE_NAME));
  const markerResult = assertWritable(brokenMarker);
  assert.equal(markerResult.ok, false);
  assert.equal(markerResult.reason, 'corrupt');
  assert.equal(loadRecovery(brokenMarker).status, 'unreadable');
});

test('assertWritable：迁移后的归档目录仍拒绝写', (t) => {
  const dir = collabDirOf(t);
  writeFileSync(join(dir, 'member.json'), JSON.stringify(legacyMemberRecord()));
  writeFileSync(join(dir, 'ledger.jsonl'), '{"version":1}\n');
  assert.equal(markLegacyCompleted(dir, { now: TS }).ok, true);
  const result = assertWritable(dir);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'legacy');
  assert.equal(result.detail, MIGRATION_FILE_NAME);
});

test('标记读取分状态：missing/corrupt/unreadable 可区分', (t) => {
  const dir = collabDirOf(t);
  assert.equal(loadRecovery(dir).status, 'missing');
  assert.equal(loadMigration(dir).status, 'missing');

  writeFileSync(join(dir, RECOVERY_FILE_NAME), '{ broken');
  assert.equal(loadRecovery(dir).status, 'corrupt');
  writeFileSync(join(dir, MIGRATION_FILE_NAME), JSON.stringify({ legacy: false }));
  assert.equal(loadMigration(dir).status, 'corrupt');

  rmSync(join(dir, RECOVERY_FILE_NAME));
  mkdirSync(join(dir, RECOVERY_FILE_NAME));
  assert.equal(loadRecovery(dir).status, 'unreadable');
});

test('写入器入参非法：reason 超长拒绝且不落盘', (t) => {
  const dir = collabDirOf(t);
  const tooLong = 'x'.repeat(201);
  const recovery = writeRecovery(dir, { now: TS, reason: tooLong });
  assert.equal(recovery.ok, false);
  assert.equal(readRecovery(dir), null);

  writeFileSync(join(dir, 'member.json'), JSON.stringify(legacyMemberRecord()));
  const migration = markLegacyCompleted(dir, { now: TS, reason: tooLong });
  assert.equal(migration.ok, false);
  assert.equal(readMigration(dir), null);
});

test('markLegacyCompleted：写 migration.json、幂等、不改旧台账', (t) => {
  const dir = collabDirOf(t);
  writeFileSync(join(dir, 'member.json'), JSON.stringify(legacyMemberRecord()));
  const ledgerBytes = '{"version":1}\n';
  writeFileSync(join(dir, 'ledger.jsonl'), ledgerBytes);

  const first = markLegacyCompleted(dir, { now: '2026-10-21T08:00:00.000Z', reason: 'legacy-format' });
  assert.equal(first.ok, true);
  assert.equal(first.written, true);
  assert.deepEqual(readMigration(dir), { legacy: true, archivedAt: '2026-10-21T08:00:00.000Z', reason: 'legacy-format' });
  assert.equal(readFileSync(join(dir, 'ledger.jsonl'), 'utf8'), ledgerBytes);

  const second = markLegacyCompleted(dir, { now: '2026-10-21T09:00:00.000Z' });
  assert.equal(second.ok, true);
  assert.equal(second.written, false);
  assert.deepEqual(second.record, first.record);
});

test('markLegacyCompleted：非 legacy 目录拒绝写入', (t) => {
  const dir = collabDirOf(t);
  writeCarrier(dir, sessionSeatsCarrier());
  const result = markLegacyCompleted(dir, { now: TS });
  assert.equal(result.ok, false);
  assert.equal(result.record, null);
  assert.equal(existsSync(join(dir, MIGRATION_FILE_NAME)), false);
});

test('markLegacyCompleted：新形态目录混入 migration.json 时不得报归档成功', (t) => {
  const dir = collabDirOf(t);
  writeCarrier(dir, sessionSeatsCarrier());
  writeFileSync(join(dir, 'ledger.jsonl'), '{"version":1}\n');
  writeFileSync(join(dir, MIGRATION_FILE_NAME), JSON.stringify({ legacy: true, archivedAt: TS, reason: 'legacy-format' }));
  const result = markLegacyCompleted(dir, { now: TS });
  assert.equal(result.ok, false);
  assert.equal(result.record, null);
});

test('markLegacyCompleted：写失败继续只读并告警', (t) => {
  const dir = collabDirOf(t);
  writeFileSync(join(dir, 'member.json'), JSON.stringify(legacyMemberRecord()));
  /* 用「同名目录占位」制造不可替换的 migration.json —— 跨平台稳定的写失败面。 */
  mkdirSync(join(dir, MIGRATION_FILE_NAME));

  const warnings = [];
  const result = markLegacyCompleted(dir, { now: TS, warn: (message) => warnings.push(message) });
  assert.equal(result.ok, false);
  assert.equal(result.record, null);
  assert.ok(result.error instanceof Error);
  assert.equal(warnings.length, 1);
});
