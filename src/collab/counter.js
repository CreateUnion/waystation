import { readFileSync } from 'node:fs';
import { writeJsonAtomic } from '../storage.js';
import { collabDir, collabFilePath, ensureDir } from '../paths.js';

export const COUNTER_FILE_NAME = 'counter.json';

/* 协作（managed）的内容消息累计计数（状态栏「N 条」的持久数据面）：
 * 只计本机收到的内容类入站消息（计数点挂服务消费链，判据见服务侧），随协作目录走——归档留存、
 * 清库随目录删。形态 { v: 1, messageCount } 单文件原子替换：整份覆盖写而非追加，与追加式日志的
 * 取舍不同——数值文件半写即不可解析、且无「按行恢复」的余地，原子替换天然免于残行。
 * 健壮性沿既有 store 语义：加载坏文件归零并留痕、落盘失败只计数告警、内存态继续——
 * 显示面数据不得让服务起不来、不得中断协作主链。计数自本版本起累计（升级前的存量不计）。 */

export function isCounterShape(record) {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return false;
  }
  if (record.v !== 1) {
    return false;
  }
  return Number.isInteger(record.messageCount) && record.messageCount >= 0;
}

/* onChange = 观察面变化回调（会话状态文件即时刷新的挂点）：只在计数真的变化后触发。 */
/**
 * @param {{ dataDir: string, collabId: string, log: any, onChange?: (() => void) | null }} options
 */
export function createCounterStore({ dataDir, collabId, log, onChange = null }) {
  const state = {
    collabId,
    log,
    file: collabFilePath(dataDir, collabId, COUNTER_FILE_NAME),
    dataDir,
    messageCount: 0,
    onChange,
    counters: { corruptLoads: 0, persists: 0, persistFailures: 0 },
  };
  load(state);
  return {
    increment: () => increment(state),
    count: () => state.messageCount,
    stats: () => ({ ...state.counters, count: state.messageCount }),
  };
}

/* 加载：文件不存在（首次运行）静默从零起算；存在但读不出 / 解析不出 / 形态不符 → 归零并留痕
 * （计数损坏即失去真值——以零为起点继续累计，胜过让整条协作加载失败或带病沿用）。 */
function load(state) {
  const text = readText(state);
  if (text === null) {
    return;
  }
  const parsed = parseJsonOrNull(text);
  if (parsed === null) {
    traceCorruptLoad(state, '无法解析');
    return;
  }
  if (!isCounterShape(parsed)) {
    traceCorruptLoad(state, '形态不符');
    return;
  }
  state.messageCount = parsed.messageCount;
}

/* 读取：文件不存在（首次运行）静默按「尚无计数」处理；其他读故障并入损坏面（留痕）。 */
function readText(state) {
  try {
    return readFileSync(state.file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      traceCorruptLoad(state, error.message);
    }
    return null;
  }
}

function parseJsonOrNull(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function traceCorruptLoad(state, reason) {
  state.counters.corruptLoads++;
  state.log.warn('内容消息计数文件不可用（归零重新累计）', { collabId: state.collabId, reason });
}

/* 自增：先改内存（显示面即时反映）再落盘；落盘失败不回滚内存态（与帖子 / 成员存储同一语义），
 * 计数变化无论是否落盘都通知观察面。 */
function increment(state) {
  state.messageCount++;
  persist(state);
  if (state.onChange !== null) {
    state.onChange();
  }
}

function persist(state) {
  try {
    ensureDir(collabDir(state.dataDir, state.collabId));
    writeJsonAtomic(state.file, { v: 1, messageCount: state.messageCount });
    state.counters.persists++;
  } catch (error) {
    state.counters.persistFailures++;
    state.log.warn('内容消息计数写入失败（内存态继续）', { collabId: state.collabId, reason: error.message });
  }
}

/* 观察面回调的统一出口（计数 / 帖 / 成员三类变化都经它抵达会话状态文件刷新）：
 * 回调属显示面，异常一律隔离为计数与告警——钩子与事件路径不得因显示面故障抛出。 */
export function notifyIndicatorChange(state) {
  if (typeof state.onIndicatorChange !== 'function') {
    return;
  }
  try {
    state.onIndicatorChange();
  } catch (error) {
    state.counters.indicatorChangeFailures++;
    state.log.warn('观察面回调异常（已隔离）', { reason: error?.message });
  }
}
