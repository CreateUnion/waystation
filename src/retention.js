import { readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { ID_PATTERN } from './net/protocol.js';
import { COLLABS_DIR_NAME, LOGS_DIR_NAME, collabArchiveDir, collabDir, ensureDir } from './paths.js';
import { loadLedger, loadMember } from './collab/store.js';
import { retentionConfigOf } from './dispatch-config.js';

/* 保留期清理（任务书 §5.4 / IMPROVEMENTS §5.4，问题 19）：
 *   - collabs：只清「本机 member 记录终态 + archivedAt 超期 + 全部席位已归档 + 台账终态」的目录；
 *     先 gzip 归档到 <数据根>/archive/collabs/，归档成功才删除原目录（保守：归档失败即保留）；
 *   - 日志：现有按大小轮转不变，这里按 mtime 删除超过 logs_days 的 waystation.log[.N]；
 *   - dry-run：只统计与写日志，不动文件；
 *   - 活跃 / 在途（active / frozen / proposed / 席位未归档 / recovery / 未知目录）永不清理。
 * 核心是单写者、清理为同步执行——与协作写路径无并发窗口；调度状态文件的超期残留由
 * collab/dispatch-store.js 的启动恢复路径处理，不在此重复删除。 */

const DAY_MS = 24 * 60 * 60 * 1000;
const LOG_FILE_PATTERN = /^waystation\.log(?:\.\d+)?$/;
/* 单目录归档读取上限：避免超大目录把清理本身打爆内存；超限跳过并告警（保留原目录）。 */
export const ARCHIVE_MAX_BYTES = 64 * 1024 * 1024;

/**
 * 执行一轮保留期清理。
 * @param {{ dataDir: string, logDir?: string, config: any, log: any, now?: number,
 *   dryRun?: boolean | null }} input
 * @returns {{ dryRun: boolean, collabs: any, archives: any, logs: any }}
 */
export function runRetentionCleanup({ dataDir, logDir = join(dataDir, LOGS_DIR_NAME), config, log, now = Date.now(), dryRun = null }) {
  const retention = retentionConfigOf(config);
  const effectiveDryRun = resolveDryRun(dryRun, retention);
  const stats = emptyStats(effectiveDryRun);
  const context = { dataDir, logDir, retention, log, now, dryRun: effectiveDryRun, stats };
  safePhase(log, 'collabs', () => cleanupCollabs(context), () => {
    stats.collabs.failed++;
  });
  safePhase(log, 'logs', () => cleanupLogs(context), () => {
    stats.logs.failed++;
  });
  logSummary(log, retention, stats);
  return stats;
}

function resolveDryRun(value, retention) {
  return value === null || value === undefined ? retention.dry_run : value === true;
}

function emptyStats(dryRun) {
  return {
    dryRun,
    collabs: { archived: 0, skippedActive: 0, skippedUnknown: 0, failed: 0 },
    archives: { deleted: 0 },
    logs: { deleted: 0, failed: 0 },
  };
}

/* 单个阶段异常隔离：清理是附属面，任何扫描/IO 异常都不得中断另一阶段或核心主链。 */
function safePhase(log, name, run, onError) {
  try {
    run();
  } catch (error) {
    onError();
    log?.warn?.(`保留期清理：${name} 扫描异常（已隔离）`, { reason: error?.message });
  }
}

function logSummary(log, retention, stats) {
  log?.info?.('保留期清理完成', {
    dryRun: stats.dryRun,
    collabsArchived: stats.collabs.archived,
    collabsSkippedActive: stats.collabs.skippedActive,
    collabsSkippedUnknown: stats.collabs.skippedUnknown,
    archivesDeleted: stats.archives.deleted,
    logsDeleted: stats.logs.deleted,
    collabsDays: retention.collabs_days,
    logsDays: retention.logs_days,
  });
}

/* —— collabs —— */

function cleanupCollabs({ dataDir, retention, log, now, dryRun, stats }) {
  const cutoff = now - retention.collabs_days * DAY_MS;
  for (const entry of readDirents(join(dataDir, COLLABS_DIR_NAME))) {
    if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) {
      continue;
    }
    safeCollabCleanup({ dataDir, collabId: entry.name, cutoff, log, now, dryRun, stats });
  }
  pruneArchives({ dataDir, cutoff, log, dryRun, stats });
}

/* 单条目异常隔离：某目录读取/解析失败只计数告警，不中止其余目录的清理。 */
function safeCollabCleanup({ dataDir, collabId, cutoff, log, now, dryRun, stats }) {
  try {
    applyCollabCleanup({ dataDir, collabId, cutoff, log, now, dryRun, stats });
  } catch (error) {
    stats.collabs.failed++;
    log?.warn?.('保留期清理：协作目录检查异常（已隔离）', { collabId, reason: error?.message });
  }
}

function applyCollabCleanup({ dataDir, collabId, cutoff, log, now, dryRun, stats }) {
  const verdict = collabCleanable({ dataDir, collabId, cutoff });
  if (verdict.ok !== true) {
    if (verdict.reason === 'active') {
      stats.collabs.skippedActive++;
    } else {
      stats.collabs.skippedUnknown++;
    }
    return;
  }
  if (dryRun) {
    stats.collabs.archived++;
    log?.info?.('保留期清理：将归档已结束协作', { collabId, dryRun: true, archivedAt: verdict.archivedAt });
    return;
  }
  const archived = archiveCollab({ dataDir, collabId, log, now });
  if (archived.ok !== true) {
    stats.collabs.failed++;
    log?.warn?.('保留期清理：协作归档失败，保留原目录', { collabId, reason: archived.reason });
    return;
  }
  deleteCollabDir({ dataDir, collabId, archivedAt: verdict.archivedAt, archivePath: archived.path, log, stats });
}

function deleteCollabDir({ dataDir, collabId, archivedAt, archivePath, log, stats }) {
  try {
    rmSync(collabDir(dataDir, collabId), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    stats.collabs.archived++;
    log?.info?.('保留期清理：已归档并删除协作目录', { collabId, archivedAt, archive: archivePath });
  } catch (error) {
    stats.collabs.failed++;
    log?.warn?.('保留期清理：协作目录删除失败（归档已保留）', { collabId, reason: error?.message });
  }
}

/* 删除判据（全部满足才删除）：本机 member 记录 completed/terminated + archivedAt 超期 +
 * 全部本地席位已归档 + 台账（若存在且可解析）同属终态；恢复标记 / 未知目录 / 坏记录一律跳过。 */
function collabCleanable({ dataDir, collabId, cutoff }) {
  const dir = collabDir(dataDir, collabId);
  if (existsIn(dir, 'recovery.json')) {
    return skip('recovery');
  }
  const member = loadMember(dataDir, collabId);
  if (member === null) {
    return skip('unknown');
  }
  return terminalMemberVerdict(member, { dataDir, collabId, dir, cutoff });
}

function terminalMemberVerdict(member, { dataDir, collabId, dir, cutoff }) {
  if (member.state !== 'completed' && member.state !== 'terminated') {
    return skip('active');
  }
  const archivedAt = parseTimestamp(member.archivedAt);
  if (archivedAt === null) {
    return skip('unknown');
  }
  if (archivedAt > cutoff) {
    return skip('active');
  }
  const seatsVerdict = seatsArchivedOf(join(dir, 'seats'));
  if (seatsVerdict === false) {
    return skip('active');
  }
  if (seatsVerdict === null || !ledgerTerminalOf(dataDir, collabId)) {
    return skip('unknown');
  }
  return { ok: true, archivedAt: new Date(archivedAt).toISOString() };
}

function skip(reason) {
  return { ok: false, reason };
}

/* true＝全部席位已归档（或没有席位文件）；false＝存在未归档席位；null＝读取失败/形态不可判（保守跳过）。 */
function seatsArchivedOf(seatsDir) {
  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try {
    entries = readdirSync(seatsDir, { withFileTypes: true });
  } catch (error) {
    return error?.code === 'ENOENT' ? true : null;
  }
  for (const entry of entries) {
    const verdict = seatArchivedVerdict(seatsDir, entry);
    if (verdict !== true) {
      return verdict;
    }
  }
  return true;
}

function seatArchivedVerdict(seatsDir, entry) {
  if (!entry.isFile() || !entry.name.endsWith('.json')) {
    return true;
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(join(seatsDir, entry.name), 'utf8'));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const record = /** @type {{ archivedAt?: unknown }} */ (parsed);
  return parseTimestamp(record.archivedAt) === null ? false : true;
}

/* 台账存在时必须可解析且为终态；不存在＝成员侧目录，不以此判否；损坏＝不可判，保守跳过。 */
function ledgerTerminalOf(dataDir, collabId) {
  const loaded = loadLedger(dataDir, collabId);
  if (loaded.corrupt === true) {
    return false;
  }
  if (loaded.ledger === null) {
    return true;
  }
  const ledger = /** @type {{ status?: unknown }} */ (loaded.ledger);
  return ledger.status === 'completed' || ledger.status === 'terminated';
}

function archiveCollab({ dataDir, collabId, log, now }) {
  const files = collectFiles(collabDir(dataDir, collabId));
  if (files.error !== undefined) {
    return { ok: false, reason: files.error };
  }
  const bytes = files.bytes ?? 0;
  if (bytes > ARCHIVE_MAX_BYTES) {
    return { ok: false, reason: `目录过大（${bytes} 字节，上限 ${ARCHIVE_MAX_BYTES}）` };
  }
  const target = join(collabArchiveDir(dataDir), `${collabId}.json.gz`);
  try {
    ensureDir(collabArchiveDir(dataDir));
    const payload = { v: 1, collabId, archivedAt: new Date(now).toISOString(), files: files.value };
    writeFileSync(target, gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'), { level: 9 }));
    return { ok: true, path: target };
  } catch (error) {
    log?.warn?.('保留期清理：归档写入失败', { collabId, reason: error?.message, target });
    return { ok: false, reason: error?.message ?? '归档写入失败' };
  }
}

/* 递归收集目录内普通文件：相对路径统一用 / 分隔，内容 base64 保真（文本 / 二进制都可还原）。
 * 符号链接跳过（不跟随，避免把数据根之外的内容打进归档）。 */
function collectFiles(root) {
  /** @type {Record<string, string>} */
  const value = {};
  let bytes = 0;
  const context = { root, value, addBytes: (size) => { bytes += size; } };
  const error = walkDirectory(root, context);
  return error === null ? { value, bytes } : { error };
}

function walkDirectory(dir, context) {
  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    return error?.message ?? '目录读取失败';
  }
  for (const entry of entries) {
    const error = collectDirectoryEntry(dir, entry, context);
    if (error !== null) {
      return error;
    }
  }
  return null;
}

function collectDirectoryEntry(dir, entry, context) {
  if (entry.isSymbolicLink()) {
    return null;
  }
  if (entry.isDirectory()) {
    return walkDirectory(join(dir, entry.name), context);
  }
  return entry.isFile() ? collectFile(dir, entry, context) : null;
}

function collectFile(dir, entry, context) {
  const full = join(dir, entry.name);
  /** @type {Buffer} */
  let content;
  try {
    content = readFileSync(full);
  } catch (error) {
    return error?.message ?? '文件读取失败';
  }
  const key = relative(context.root, full).split(sep).join('/');
  context.value[key] = content.toString('base64');
  context.addBytes(content.length);
  return null;
}

/* 归档文件本身也受 collabs_days 约束：mtime 早于 cutoff 的 .json.gz 删除——总占用有界。 */
function pruneArchives({ dataDir, cutoff, log, dryRun, stats }) {
  const archiveDir = collabArchiveDir(dataDir);
  for (const entry of readDirents(archiveDir)) {
    if (!entry.isFile() || !entry.name.endsWith('.json.gz')) {
      continue;
    }
    const file = join(archiveDir, entry.name);
    const mtimeMs = mtimeOf(file);
    if (mtimeMs === null || mtimeMs > cutoff) {
      continue;
    }
    stats.archives.deleted++;
    if (dryRun) {
      log?.info?.('保留期清理：将删除超期归档', { file: entry.name, dryRun: true });
      continue;
    }
    removeFile(file, '归档', log);
  }
}

/* —— logs —— */

function cleanupLogs({ logDir, retention, log, now, dryRun, stats }) {
  const cutoff = now - retention.logs_days * DAY_MS;
  for (const entry of readDirents(logDir)) {
    if (!entry.isFile() || !LOG_FILE_PATTERN.test(entry.name)) {
      continue;
    }
    const file = join(logDir, entry.name);
    const mtimeMs = mtimeOf(file);
    if (mtimeMs === null || mtimeMs > cutoff) {
      continue;
    }
    stats.logs.deleted++;
    if (!dryRun) {
      removeFile(file, '日志', log);
    }
  }
}

function removeFile(file, label, log) {
  try {
    unlinkSync(file);
    log?.info?.(`保留期清理：已删除超期${label}`, { file });
  } catch (error) {
    log?.warn?.(`保留期清理：${label}删除失败`, { file, reason: error?.message });
  }
}

function readDirents(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function mtimeOf(file) {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

function parseTimestamp(value) {
  if (typeof value !== 'string' || value.length > 40) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function existsIn(dir, name) {
  try {
    return readdirSync(dir).includes(name);
  } catch {
    return false;
  }
}
