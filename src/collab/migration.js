import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_REASON_CHARS, isPresentationText } from '../net/protocol.js';
import { RECOVERY_FILE_NAME } from '../paths.js';
import { writeJsonAtomic } from '../storage.js';

/* 目录标记文件（设计 §6.2/§8）：两者都是「只读原因」的持久证据，不参与协作语义。
 *   migration.json — 旧形态协作的归档标记（legacy:true）；写入后旧目录只读。
 *   recovery.json  — 新协作半写（carrier 已落、台账未落）的恢复标记；目录按只读处理，不重建空台账。
 * 半写不是 legacy：二者用不同字段表达，恢复时不得把半写目录当旧协作归档。 */

/* migration.json 没有路径层常量（只由本模块写与读）；recovery.json 的文件名权威在 paths.js。 */
export const MIGRATION_FILE_NAME = 'migration.json';
export { RECOVERY_FILE_NAME };
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

/* 读取分状态：missing 与 corrupt/unreadable 对写门含义不同——坏掉的标记不能让写门当「无标记」放行。 */
export function loadMigration(dir) {
  return loadMarker(migrationPath(dir), isMigrationShape);
}

export function loadRecovery(dir) {
  return loadMarker(recoveryPath(dir), isRecoveryShape);
}

/* 兼容读取面：只关心「有没有合规记录」的调用方（展示、幂等短路）用这两个。 */
export function readMigration(dir) {
  return loadMigration(dir).record;
}

export function readRecovery(dir) {
  return loadRecovery(dir).record;
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

/* status：ok / missing（文件不存在）/ corrupt（解析或形态失败）/ unreadable（读取错误，含 EISDIR/EACCES）。 */
/** @returns {{ status: 'ok'|'missing'|'corrupt'|'unreadable', record: any, error?: any }} */
function loadMarker(filePath, predicate) {
  const read = tryReadText(filePath);
  if (read.missing) {
    return { status: 'missing', record: null };
  }
  if (read.error !== undefined) {
    return { status: 'unreadable', record: null, error: read.error };
  }
  try {
    const value = JSON.parse(read.text ?? '');
    return predicate(value)
      ? { status: 'ok', record: value }
      : { status: 'corrupt', record: null, error: new Error('标记文件形态不符') };
  } catch (error) {
    return { status: 'corrupt', record: null, error };
  }
}

/** @returns {{ text?: string, error?: any, missing?: boolean }} */
function tryReadText(filePath) {
  try {
    return { text: readFileSync(filePath, 'utf8') };
  } catch (error) {
    return error.code === 'ENOENT' ? { missing: true } : { error };
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
