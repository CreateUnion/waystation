import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const INSTANCE_ID_FILE = 'instance-id';

/* 空文件恢复段的锁目录。并发首跑是一次性事件，但本机实测单次文件系统操作约 0.5–1ms、
 * 「建文件 → 内容落盘」窗口约 1ms 量级——「先读到空、再删空文件」的窗口里，并发方刚
 * 落盘的值会被误删，随后删除者又建成「第二个所有者」（实测同起点并发下约三成概率出现
 * 「两个进程各自返回自己的 id」）。故恢复段以 mkdir 的原子独占互斥：持锁者独占「删空
 * 文件 + 独占创建」，等锁者只读不改，读到的必然是唯一所有者写入的值。 */
const LOCK_DIR_NAME = 'instance-id.lock';
/* 以下时长按「一次性事件，量级盖过毫秒窗口即可」取整：轮询间隔只影响恢复时延与开销；
 * 等待上限按持锁者正常耗时（实测百毫秒内）留出数量级余量；陈旧阈值显著大于等待上限，
 * 保证只接管确定已崩溃的锁，不会误抢活锁。 */
const LOCK_POLL_INTERVAL_MS = 20;
const LOCK_WAIT_LIMIT_MS = 2000;
const LOCK_STALE_AGE_MS = 10000;
/* 锁内重读轮数：覆盖「并发创建者已建文件、内容尚未落盘」的毫秒级窗口，
 * 避免把活创建者的空文件当陈旧残留删掉 */
const SETTLE_RECHECKS = 3;

/* Windows 上并发删/建同一路径会抛 EPERM/EBUSY（共享冲突），与 EEXIST 一样属瞬态，交给轮询 */
const LOCK_BUSY_CODES = new Set(['EEXIST', 'EPERM', 'EBUSY']);
const TRANSIENT_IO_CODES = new Set(['ENOENT', 'EPERM', 'EBUSY']);

/* 机器实例标识：首跑生成一次、此后终身不变（设计 §5/§14）。
 * 单独成文件而非 config.json 字段：配置是用户可改的整份替换，标识必须结构性地改不掉、不被配置重写波及。
 * 并发保护：缺失与空文件一律视为「未生成」，竞争统一由 'wx' 独占创建裁决——建成的进程是唯一
 * 所有者并返回自己写入的值，其余进程只读取所有者的值。空文件的恢复段走上面的锁目录互斥。 */
export function loadOrCreateInstanceId(dataDir) {
  const file = join(dataDir, INSTANCE_ID_FILE);
  const existing = readExistingId(file);
  if (existing !== null) {
    return existing;
  }
  const id = randomUUID();
  if (createExclusively(file, id)) {
    return id;
  }
  const raced = readExistingId(file);
  if (raced !== null) {
    return raced;
  }
  return recoverEmptyFile(dataDir, file, id);
}

function recoverEmptyFile(dataDir, file, id) {
  const lockDir = join(dataDir, LOCK_DIR_NAME);
  const deadline = Date.now() + LOCK_WAIT_LIMIT_MS;
  while (Date.now() < deadline) {
    if (acquireLock(lockDir)) {
      try {
        return initializeUnderLock(file, id);
      } finally {
        rmSync(lockDir, { recursive: true, force: true });
      }
    }
    const value = readExistingId(file);
    if (value !== null) {
      return value;
    }
    sleepSync(LOCK_POLL_INTERVAL_MS);
  }
  return recoverAfterLockTimeout(lockDir, file, id);
}

function initializeUnderLock(file, id) {
  const current = readExistingId(file);
  if (current !== null) {
    return current;
  }
  for (let check = 0; check < SETTLE_RECHECKS; check++) {
    sleepSync(LOCK_POLL_INTERVAL_MS);
    const settled = readExistingId(file);
    if (settled !== null) {
      return settled;
    }
  }
  removeFileIfExists(file);
  if (createExclusively(file, id)) {
    return id;
  }
  return readExistingId(file) ?? id;
}

/* 等锁超时：正常持锁者在百毫秒内完成，走到这里说明持锁者崩溃或极端迟缓。
 * 清陈旧锁（自愈「持锁进程崩溃」的残留）后直走最后一轮恢复——这一步不再有锁保护，
 * 属异常场景的兜底，正常路径不会到达。 */
function recoverAfterLockTimeout(lockDir, file, id) {
  const value = readExistingId(file);
  if (value !== null) {
    return value;
  }
  removeStaleLock(lockDir);
  removeFileIfExists(file);
  if (createExclusively(file, id)) {
    return id;
  }
  return readExistingId(file) ?? id;
}

function removeStaleLock(lockDir) {
  try {
    const age = Date.now() - statSync(lockDir).mtimeMs;
    if (age > LOCK_STALE_AGE_MS) {
      rmSync(lockDir, { recursive: true, force: true });
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

function acquireLock(lockDir) {
  try {
    mkdirSync(lockDir);
    return true;
  } catch (error) {
    if (LOCK_BUSY_CODES.has(error.code)) {
      return false;
    }
    throw error;
  }
}

function createExclusively(file, id) {
  try {
    writeFileSync(file, id + '\n', { flag: 'wx' });
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') {
      return false;
    }
    throw error;
  }
}

function removeFileIfExists(file) {
  try {
    rmSync(file);
  } catch (error) {
    if (!TRANSIENT_IO_CODES.has(error.code)) {
      throw error;
    }
  }
}

function readExistingId(file) {
  try {
    const text = readFileSync(file, 'utf8').trim();
    return text === '' ? null : text;
  } catch (error) {
    if (TRANSIENT_IO_CODES.has(error.code)) {
      return null;
    }
    throw error;
  }
}

/* 同步短睡：恢复段要求「拿锁 → 判断 → 放锁」串行推进，同步等待保持流程线性；
 * 等待都有界（轮询段到 deadline，锁内重读为固定轮数） */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
