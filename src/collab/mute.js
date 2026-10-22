import { readFileSync, rmSync } from 'node:fs';
import { writeJsonAtomic } from '../storage.js';
import { collabDir, collabFilePath, ensureDir } from '../paths.js';

export const MUTE_FILE_NAME = 'mute.json';

/* 静音状态：0.2.0 起按会话席位持久（seats/<sessionId>.json 的 muted，唯一权威），
 * mute.json 退出语义面、留盘不删（契约 §8）——本文件的 store 仅为旧档读取器保留，
 * 新代码不得实例化或以其作为静音/摘要基线权威。
 * 摘要基线改为进程内按席位（collabId + sessionId）记录（见下方 baseline 原语）：进程重启后
 * 基线缺失，取消静音时按既有降级文案（不带 N），不新增持久化字段。 */

export function isMuteShape(record) {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return false;
  }
  if (record.v !== 1) {
    return false;
  }
  if (typeof record.muted !== 'boolean') {
    return false;
  }
  if (record.baseline === null) {
    return true;
  }
  return Number.isInteger(record.baseline) && record.baseline >= 0;
}

/**
 * @param {{ dataDir: string, collabId: string, log: any }} options
 */
export function createMuteStore({ dataDir, collabId, log }) {
  const state = {
    collabId,
    log,
    file: collabFilePath(dataDir, collabId, MUTE_FILE_NAME),
    dataDir,
    muted: false,
    baseline: null,
    counters: { corruptLoads: 0, persists: 0, persistFailures: 0, clears: 0 },
  };
  load(state);
  return {
    isMuted: () => state.muted,
    setMuted: (muted, currentCount) => setMuted(state, muted, currentCount),
    clear: () => clear(state),
    stats: () => ({ ...state.counters, muted: state.muted, baseline: state.baseline }),
  };
}

/* 加载：文件不存在（默认不静音）静默；存在但读不出 / 解析不出 / 形态不符 → 归默认并留痕
 * （开关损坏即失去真值——以「不静音」为起点继续，优于让整条协作加载失败或带病沿用）。 */
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
  if (!isMuteShape(parsed)) {
    traceCorruptLoad(state, '形态不符');
    return;
  }
  state.muted = parsed.muted;
  /* 不静音即无静音窗口：基线随之清空（形态允许残留值，语义上仅静音期有意义）。 */
  state.baseline = parsed.muted ? parsed.baseline : null;
}

/* 读取：文件不存在（首次运行）静默按「尚无静音状态」处理；其他读故障并入损坏面（留痕）。 */
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
  state.log.warn('静音状态文件不可用（按默认不静音继续）', { collabId: state.collabId, reason });
}

/* 设置 / 取消（幂等）：设静音时记下当前累计为基线——重复设静音不重置基线（窗口仍从首次算起）；
 * 取消时清基线。返回前态供调用方判断「是否发生真翻转」（未静音时再取消发不出有意义的摘要）。 */
function setMuted(state, muted, currentCount) {
  const before = { wasMuted: state.muted, baseline: state.baseline };
  if (muted === true) {
    if (!before.wasMuted || state.baseline === null) {
      state.baseline = Number.isInteger(currentCount) ? currentCount : null;
    }
    state.muted = true;
  } else {
    state.muted = false;
    state.baseline = null;
  }
  persist(state);
  return before;
}

function persist(state) {
  try {
    ensureDir(collabDir(state.dataDir, state.collabId));
    writeJsonAtomic(state.file, { v: 1, muted: state.muted, baseline: state.baseline });
    state.counters.persists++;
  } catch (error) {
    state.counters.persistFailures++;
    state.log.warn('静音状态写入失败（内存态继续）', { collabId: state.collabId, reason: error.message });
  }
}

/* 清理（协作退出 / 归档时的生命周期终点）：内存复位 + 删文件。静音是行为状态而非协作内容——
 * 退出后本机不再收该协作的注入；重入（讨论）时从默认（不静音）起点开始，不留幽灵静音。
 * 文件本已不在（从未设过静音）也算成功；删除失败只计数告警。 */
function clear(state) {
  state.muted = false;
  state.baseline = null;
  try {
    rmSync(state.file, { force: true });
    state.counters.clears++;
  } catch (error) {
    state.counters.persistFailures++;
    state.log.warn('静音状态清理失败（已忽略）', { collabId: state.collabId, reason: error.message });
  }
}

/* —— 静音摘要基线（进程内，按席位） ——
 * 键 = collabId + sessionId：同机两席各算各的窗口，互不清空。基线只在显式设静音时记录
 * （ws_set_mute(true)），取消时算 N 并删除；进程重启后内存表为空，
 * 取消静音按「基线缺失」降级（不虚构数字），不新增持久化字段。 */

function baselinesOf(state) {
  if (!(state.muteBaselines instanceof Map)) {
    state.muteBaselines = new Map();
  }
  return state.muteBaselines;
}

function baselineKeyOf(collabId, sessionId) {
  return `${collabId}\u0000${sessionId}`;
}

/* 首次进入静音窗口时记下当前累计；重复设静音不重置（窗口仍从首次算起）。
 * 返回是否本次新记（供调用方按需判断基线来源）。 */
export function rememberMuteBaselineIfAbsent(state, collabId, sessionId, currentCount) {
  const baselines = baselinesOf(state);
  const key = baselineKeyOf(collabId, sessionId);
  if (baselines.has(key)) {
    return false;
  }
  baselines.set(key, Number.isInteger(currentCount) && currentCount >= 0 ? currentCount : null);
  return true;
}

/* 取走并删除基线（取消静音）：缺基线返回 null＝摘要降级。 */
export function takeMuteBaseline(state, collabId, sessionId) {
  const baselines = baselinesOf(state);
  const key = baselineKeyOf(collabId, sessionId);
  if (!baselines.has(key)) {
    return null;
  }
  const baseline = baselines.get(key);
  baselines.delete(key);
  return baseline;
}

export function forgetMuteBaseline(state, collabId, sessionId) {
  baselinesOf(state).delete(baselineKeyOf(collabId, sessionId));
}

/* 协作终态 / 整机清理：一次清掉该协作全部席位基线（避免进程内表滞留无主条目）。 */
export function forgetMuteBaselinesOfCollab(state, collabId) {
  const prefix = `${collabId}\u0000`;
  for (const key of baselinesOf(state).keys()) {
    if (key.startsWith(prefix)) {
      baselinesOf(state).delete(key);
    }
  }
}
