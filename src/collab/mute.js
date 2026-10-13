import { readFileSync, rmSync } from 'node:fs';
import { writeJsonAtomic } from '../storage.js';
import { collabDir, collabFilePath, ensureDir } from '../paths.js';
import { CONFLICT_FRAME_TYPES, matchConflictCollabs, matchForumCollabs } from './gate.js';
import { localModeOf } from './local.js';
import { POST_KINDS } from '../net/protocol.js';

export const MUTE_FILE_NAME = 'mute.json';

/* 静音状态（设计 §5.7）：per-collab 本地行为开关——纯本地，不广播、无外发帧。
 * 静音期「内容类」帧不进会话注入，「状态与待办类」一概照旧（只做减法，抑制集见 muteSuppresses）；
 * 取消时以「当前累计 − 基线」给一行错过内容摘要。形态 { v: 1, muted, baseline }：baseline 是
 * 设静音时刻的累计读数（论坛 = 帖子列表 size、managed = 内容消息计数，由调用方取数），
 * 随状态文件持久——跨重启不丢。健壮性沿既有 store 语义：坏文件按默认（不静音）归零并留痕、
 * 落盘失败只计数告警、内存态继续——行为开关不得让服务起不来。 */

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

/* 静音栅栏判定（设计 §5.7 抑制集；模式感知；服务域接线）。
 * ① 论坛实时帖（各 kind 一律）：post 帧只属于讨论实例（准入已保证）；
 * ② managed 内容消息：六类判据取协议层 POST_KINDS（与内容计数、ws_send_message 类型面同一权威词表）；
 * ③ 论坛被忽略治理帧（freeze 族「受理 + ack、忽略」）：复刻消费侧忽略条件——managed 无命中
 *    （本机有处置面，帧仍是待办：照常注入）且命中的讨论实例中任一处于静音（帧对该实例无待办价值）。
 * 其余一律不抑制（只做减法：end / 邀请 / 协作侧 freeze 等待办、一切非内容帧照旧注入）。 */
export function muteSuppresses(state, frame) {
  if (frame.type === 'post') {
    const local = state.collabs.get(frame.collabId);
    return local !== undefined && local.mute.isMuted();
  }
  if (POST_KINDS.includes(frame.type)) {
    const local = state.collabs.get(frame.collabId);
    return local !== undefined && localModeOf(local) !== 'forum' && local.mute.isMuted();
  }
  if (CONFLICT_FRAME_TYPES.has(frame.type)) {
    return suppressesIgnoredGovernance(state, frame);
  }
  return false;
}

/* 被忽略治理帧的静音判定：与消费侧 noteForumGovernanceIgnored 同一判据面（不另立口径——
 * 两处判据一旦分叉，会出现「计入忽略但照旧注入」或反向的错位）。取数前提同消费侧：形态由
 * 协议层校验、准入按同字段匹配通过——能走到投递步的治理帧 payload 必然齐全。 */
function suppressesIgnoredGovernance(state, frame) {
  const memberIds = frame.payload.members.map((member) => member.instanceId);
  if (matchConflictCollabs(state, frame.payload.name, memberIds).length > 0) {
    return false;
  }
  return matchForumCollabs(state, frame.payload.name, memberIds).some((local) => local.mute.isMuted());
}
