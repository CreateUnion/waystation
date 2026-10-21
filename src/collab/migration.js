import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_REASON_CHARS, isPresentationText } from '../net/protocol.js';
import { writeJsonAtomic } from '../storage.js';

/* 目录标记文件（设计 §6.2/§8）：两者都是「只读原因」的持久证据，不参与协作语义。
 *   migration.json — 旧形态协作的归档标记（legacy:true）；写入后旧目录只读。
 *   recovery.json  — 新协作半写（carrier 已落、台账未落）的恢复标记；目录按只读处理，不重建空台账。
 * 半写不是 legacy：二者用不同字段表达，恢复时不得把半写目录当旧协作归档。 */

export const MIGRATION_FILE_NAME = 'migration.json';
export const RECOVERY_FILE_NAME = 'recovery.json';
export const HALF_CREATED_STATE = 'half-created';
export const DEFAULT_RECOVERY_REASON = 'carrier-without-ledger';

export function migrationPath(dir) {
  return join(dir, MIGRATION_FILE_NAME);
}

export function recoveryPath(dir) {
  return join(dir, RECOVERY_FILE_NAME);
}

export function isMigrationShape(record) {
  return isPlainObject(record)
    && record.legacy === true
    && isTimestamp(record.archivedAt)
    && isReasonShape(record.reason);
}

export function isRecoveryShape(record) {
  return isPlainObject(record)
    && record.state === HALF_CREATED_STATE
    && isTimestamp(record.at)
    && isReasonShape(record.reason);
}

/* 读取只用于判定，损坏/缺失一律 null 且不抛错——写门与列表展示都不能因标记文件坏掉而中断。 */
export function readMigration(dir) {
  return readJsonShape(migrationPath(dir), isMigrationShape);
}

export function readRecovery(dir) {
  return readJsonShape(recoveryPath(dir), isRecoveryShape);
}

/** 写半写标记：已存在合规记录时原样保留（重启恢复幂等，不刷新首次时刻）。
 * 写失败返回失败结果而不抛出——调用方继续按只读处理，不能因标记写不进去而放弃恢复。 */
export function writeRecovery(dir, options = {}) {
  const existing = readRecovery(dir);
  if (existing !== null) {
    return { ok: true, record: existing, written: false };
  }
  const record = {
    state: HALF_CREATED_STATE,
    at: options.now ?? new Date().toISOString(),
    reason: options.reason ?? DEFAULT_RECOVERY_REASON,
  };
  if (!isRecoveryShape(record)) {
    return { ok: false, record: null, written: false, error: new TypeError('recovery.json 形态非法，拒绝写入') };
  }
  try {
    writeJsonAtomic(recoveryPath(dir), record);
  } catch (error) {
    return { ok: false, record: null, written: false, error };
  }
  return { ok: true, record, written: true };
}

function readJsonShape(filePath, predicate) {
  try {
    const value = JSON.parse(readFileSync(filePath, 'utf8'));
    return predicate(value) ? value : null;
  } catch {
    return null;
  }
}

function isReasonShape(reason) {
  return isPresentationText(reason, MAX_REASON_CHARS);
}

function isTimestamp(value) {
  return typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value));
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
