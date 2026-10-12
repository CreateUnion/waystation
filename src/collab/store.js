import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { COLLABS_DIR_NAME, collabDir, collabFilePath, ensureDir } from '../paths.js';
import { ID_PATTERN } from '../net/protocol.js';
import { appendLine, loadLines, writeJsonAtomic } from '../storage.js';
import { isLedgerShape, isMemberRecordShape, isSnapshotShape } from './model.js';

export const LEDGER_FILE_NAME = 'ledger.jsonl';
export const MEMBER_FILE_NAME = 'member.json';
export const SNAPSHOT_FILE_NAME = 'snapshot.json';

/* 协作目录就位（写路径自足）：接收链路由收件落盘先建目录，但发起（create）与成员记录写入
 * 走在无接收流水的路径上——写包装统一先确保目录存在，杜绝被「只计数不抛」兜底掩盖的 ENOENT 面。 */
export function ensureCollabDir(dataDir, collabId) {
  ensureDir(collabDir(dataDir, collabId));
}

/* 协作目录的持久化原语（设计 §15 定案的两条写入路径）：
 * 台账 = 追加写的状态快照流（每行一次变更后的完整台账，加载取最后一条通过形态校验的完整行）；
 * member.json / snapshot.json = 整体替换写（临时文件 + 重命名，存储层既有机制）。
 * 写失败向上抛（调用方按模块语境计数；「绝不因写盘失败退出进程」由调用方兜底）。 */

export function ledgerDigest(ledger) {
  return createHash('sha256').update(JSON.stringify(ledger)).digest('hex');
}

export function appendLedger(dataDir, ledger) {
  appendLine(collabFilePath(dataDir, ledger.collabId, LEDGER_FILE_NAME), ledger);
}

/* 加载台账并给出损坏事实：取最后一条通过形态校验的完整行。
 * corrupt = 「文件里有内容但没有一条可用」（中间坏行 / 结构不符 / 仅剩半写尾行被截断）——
 * 由调用方决定隔离与重建；干净的空文件不算损坏。 */
/**
 * @param {string} dataDir
 * @param {string} collabId
 * @returns {{ ledger: object | null, corrupt: boolean }}
 */
export function loadLedger(dataDir, collabId) {
  const loaded = loadLines(collabFilePath(dataDir, collabId, LEDGER_FILE_NAME));
  for (let index = loaded.entries.length - 1; index >= 0; index--) {
    const entry = loaded.entries[index];
    if (isLedgerShape(entry)) {
      return { ledger: /** @type {object} */ (entry), corrupt: false };
    }
  }
  return { ledger: null, corrupt: loaded.entries.length > 0 || loaded.corruptLines.length > 0 || loaded.tailDropped };
}

/* 损坏台账隔离：改名 `.corrupt-<ts>` 保留排查依据（与 known-hosts / config 的损坏处置同一手法）。
 * 失败返回 false（隔离不成功不影响后续重建尝试）。 */
export function quarantineLedger(dataDir, collabId) {
  const file = collabFilePath(dataDir, collabId, LEDGER_FILE_NAME);
  try {
    renameSync(file, `${file}.corrupt-${Date.now()}`);
    return true;
  } catch {
    return false;
  }
}

/* 删除本地台账文件（移交「先确认后删除」的删除面：确认回执到手后由旧席位执行）。
 * force 语义——文件不存在不算失败；失败返回 false，由调用方计数告警（删除不成就保守保留，
 * 不会造成数据错乱：本机已转成员，遗留台账文件仅在极端路径下被重建读取）。 */
export function removeLedgerFile(dataDir, collabId) {
  try {
    rmSync(collabFilePath(dataDir, collabId, LEDGER_FILE_NAME), { force: true });
    return true;
  } catch {
    return false;
  }
}

export function saveMember(dataDir, record) {
  writeJsonAtomic(collabFilePath(dataDir, record.collabId, MEMBER_FILE_NAME), record);
}

/** @returns {any} 形态已由 isMemberRecordShape 校验（调用方按记录形态消费） */
export function loadMember(dataDir, collabId) {
  return readJsonShape(collabFilePath(dataDir, collabId, MEMBER_FILE_NAME), isMemberRecordShape);
}

export function saveSnapshot(dataDir, collabId, snapshot) {
  writeJsonAtomic(collabFilePath(dataDir, collabId, SNAPSHOT_FILE_NAME), snapshot);
}

/** @returns {any} 形态已由 isSnapshotShape 校验（调用方按快照形态消费） */
export function loadSnapshot(dataDir, collabId) {
  return readJsonShape(collabFilePath(dataDir, collabId, SNAPSHOT_FILE_NAME), isSnapshotShape);
}

/* 本机参与清单的物理来源：collabs/ 目录下合法 collabId 形态的子目录。
 * 目录缺失按空清单起步（父目录由组合根保证存在；独立测试中缺目录不构成错误）。 */
export function listLocalCollabIds(dataDir) {
  /** @type {import('node:fs').Dirent[]} */
  let dirents = [];
  try {
    dirents = readdirSync(join(dataDir, COLLABS_DIR_NAME), { withFileTypes: true });
  } catch {
    // 目录缺失 / 不可读：按空清单起步
  }
  if (dirents.length === 0) {
    return [];
  }
  return dirents
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => ID_PATTERN.test(name));
}

/* 读一个整体替换写的 JSON 文件并做形态校验；不存在 / 损坏 / 形态不符一律 null——
 * 这类文件是派生数据（快照）或可由上层重写（成员记录），读取方按缺失处理并计数留痕。 */
/** @param {string} file @param {(value: unknown) => boolean} isShape @returns {any} */
function readJsonShape(file, isShape) {
  /** @type {string | null} */
  let raw = null;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    // 不存在 / 不可读：按缺失处理
  }
  if (raw === null) {
    return null;
  }
  /** @type {unknown} */
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 解析失败与「形状不符」共用下方出口：都归 null
  }
  return isShape(parsed) ? parsed : null;
}
