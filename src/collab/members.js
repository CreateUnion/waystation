import { ID_PATTERN, isIdentityName } from '../net/protocol.js';
import { appendLine, loadLines } from '../storage.js';
import { collabDir, collabFilePath, ensureDir } from '../paths.js';
import { randomUUID } from 'node:crypto';

export const MEMBERS_FILE_NAME = 'members.jsonl';

/* 讨论模式的成员事件日志（设计 §5.4「成员关系 = 追加式事件日志」）：
 * join / leave 均为带唯一事件 id 的追加事件；合并 = 事件集并集（同 id 重放天然幂等）；
 * 当前成员表 = 按事件折叠——每个成员取其自身事件序（ts, eventId）最新的一条定其状态。
 * 成员是会话（席位键 = 实例 + 会话）：事件自带 sessionId 时按席位折叠，同机多会话各占一员；
 * 缺该字段的旧事件退回按实例折叠（既有档案照常可读）。re-join = 新 join 事件（新事件 id）——
 * 旧的 join 重放不复活已退出成员（抗重放、抗"复活"）。
 * 事件只追加、不修改不删除；落盘 JSONL 追加写，加载坏行计数跳过（坏数据不得让服务起不来）。 */

/* 事件形态（加载路径与追加路径共用；bundle 合并侧另协议层同形校验——本层是落盘数据的底线）。
 * 席位键可缺省（旧事件），给了就必须过标识形态校验——半个席位键比没有更危险。 */
export function isMemberEventShape(entry) {
  if (!isPlainObject(entry)) {
    return false;
  }
  if (!isMemberEventHeadShape(entry)) {
    return false;
  }
  if (!isIdLike(entry.instanceId) || !isIdentityName(entry.identityName)) {
    return false;
  }
  if (entry.sessionId !== undefined && !isIdLike(entry.sessionId)) {
    return false;
  }
  return typeof entry.ts === 'string' && entry.ts.length <= 40 && !Number.isNaN(Date.parse(entry.ts));
}

function isMemberEventHeadShape(entry) {
  if (!isIdLike(entry.eventId)) {
    return false;
  }
  return entry.kind === 'join' || entry.kind === 'leave';
}

function isIdLike(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

export function newMemberEventId() {
  return randomUUID();
}

/* 成员事件存储（每协作一份）：加载即投影为内存 Map（键 = 事件 id）；apply 去重后入列并落盘。
 * 落盘失败只计数告警、内存态继续（与帖子列表同一语义）；去重以内存态为准。
 * onChange = 观察面变化回调（人数即时刷新的挂点）：只在真的并入（新事件）后触发。 */
/**
 * @param {{ dataDir: string, collabId: string, log: any, onChange?: (() => void) | null }} options
 */
export function createMembersStore({ dataDir, collabId, log, onChange = null }) {
  const state = {
    collabId,
    log,
    file: collabFilePath(dataDir, collabId, MEMBERS_FILE_NAME),
    dataDir,
    events: new Map(),
    onChange,
    counters: { appended: 0, duplicates: 0, corruptRecords: 0, persistFailures: 0 },
  };
  load(state);
  return {
    apply: (event) => apply(state, event),
    fold: () => fold(state),
    includes: (instanceId) => fold(state).some((member) => member.instanceId === instanceId),
    events: () => [...state.events.values()],
    latestEventOf: (instanceId) => latestEventOf(state, instanceId),
    baselineTsOf: (instanceId) => baselineTsOf(state, instanceId),
    size: () => state.events.size,
    stats: () => ({ ...state.counters, size: state.events.size }),
  };
}

/* 加载：逐行过形态校验，坏行计数跳过；同事件 id 重复行只留先到者（内容等价，先到者即可）。 */
function load(state) {
  /** @type {{ entries: unknown[], tailDropped: boolean, corruptLines: Array<{ lineNumber: number, text: string }> } | null} */
  let loaded = null;
  try {
    loaded = loadLines(state.file);
  } catch (error) {
    state.counters.persistFailures++;
    state.log.warn('成员事件日志读取失败（按空集继续）', { collabId: state.collabId, reason: error.message });
  }
  if (loaded === null) {
    return;
  }
  if (loaded.tailDropped || loaded.corruptLines.length > 0) {
    state.log.warn('成员事件日志有残缺记录，按可解析条目载入', { collabId: state.collabId, tailDropped: loaded.tailDropped, corruptLines: loaded.corruptLines.length });
  }
  for (const record of loaded.entries) {
    if (!isMemberEventShape(record)) {
      state.counters.corruptRecords++;
      continue;
    }
    const event = /** @type {{ eventId: string }} */ (record);
    if (!state.events.has(event.eventId)) {
      state.events.set(event.eventId, record);
    }
  }
}

/* 并入事件（事件集并集）：同 id 重放返回 duplicate（不重复落盘）；新事件先入内存再落盘
 * （写失败内存态继续）。形态不符返回 rejected 并计数。 */
function apply(state, event) {
  if (!isMemberEventShape(event)) {
    state.counters.corruptRecords++;
    state.log.warn('成员事件形态不符（拒绝并入）', { collabId: state.collabId, eventId: event?.eventId });
    return 'rejected';
  }
  if (state.events.has(event.eventId)) {
    state.counters.duplicates++;
    return 'duplicate';
  }
  state.events.set(event.eventId, event);
  persist(state, event);
  if (state.onChange !== null) {
    state.onChange();
  }
  return 'added';
}

function persist(state, event) {
  try {
    ensureDir(collabDir(state.dataDir, state.collabId));
    appendLine(state.file, event);
    state.counters.appended++;
  } catch (error) {
    state.counters.persistFailures++;
    state.log.warn('成员事件写入失败（内存态继续）', { collabId: state.collabId, eventId: event.eventId, reason: error.message });
  }
}

/* 折叠（当前成员表）：按席位键分组，每组取事件序最新的一条（作者内比较键 = (ts, eventId)——
 * 同刻按事件 id 兜底，保证各副本对同一事件集折叠出同一结果）；最新为 join 者入表。
 * 事件无 sessionId 时分组键退回实例（旧档案的成员粒度），有则按会话——两类行不互相吞并：
 * 旧行的实例级身份与席位行的会话身份是不同的历史记录，合并会凭空改写其中一个。
 * 输出按实例、再按会话排序（确定性）。 */
function fold(state) {
  return foldMemberEvents([...state.events.values()]);
}

/** 对任意成员事件集折叠出当前成员表（存储的 fold 与「对端事件集」的收敛判定共用同一规则）。 */
export function foldMemberEvents(events) {
  const latest = new Map();
  for (const event of events) {
    const key = seatKeyOf(event);
    const held = latest.get(key);
    if (held === undefined || compareEvents(event, held) > 0) {
      latest.set(key, event);
    }
  }
  const members = [];
  for (const event of latest.values()) {
    if (event.kind === 'join') {
      members.push(seatMemberOf(event));
    }
  }
  return members.sort(compareMembers);
}

/* 分组键：会话标识在场即席位键（实例内以 NUL 隔开，与裸实例键不会撞车）；缺省退回实例键。
 * 非字符串/空串一律按缺省处理——折叠不得因半个坏字段整表抛错。 */
function seatKeyOf(event) {
  const sessionId = seatSessionIdOf(event);
  return sessionId === null ? event.instanceId : `${event.instanceId}\u0000${sessionId}`;
}

function seatSessionIdOf(event) {
  return typeof event.sessionId === 'string' && event.sessionId !== '' ? event.sessionId : null;
}

function seatMemberOf(event) {
  const member = { instanceId: event.instanceId, identityName: event.identityName };
  const sessionId = seatSessionIdOf(event);
  if (sessionId !== null) {
    member.sessionId = sessionId;
  }
  return member;
}

function compareMembers(left, right) {
  if (left.instanceId !== right.instanceId) {
    return left.instanceId < right.instanceId ? -1 : 1;
  }
  const leftSession = left.sessionId ?? '';
  const rightSession = right.sessionId ?? '';
  if (leftSession === rightSession) {
    return 0;
  }
  return leftSession < rightSession ? -1 : 1;
}

/* 作者内事件序：先时刻、后事件 id（同刻兜底）——与帖子显示序同一比较精神（§5.2）。 */
function compareEvents(left, right) {
  const byTs = Date.parse(left.ts) - Date.parse(right.ts);
  if (byTs !== 0) {
    return byTs;
  }
  if (left.eventId === right.eventId) {
    return 0;
  }
  return left.eventId < right.eventId ? -1 : 1;
}

/* 某成员的最新事件（不分 join/leave）。 */
function latestEventOf(state, instanceId) {
  let latest = null;
  for (const event of state.events.values()) {
    if (event.instanceId !== instanceId) {
      continue;
    }
    if (latest === null || compareEvents(event, latest) > 0) {
      latest = event;
    }
  }
  return latest;
}

/* 该作者的事件 ts 基线（发事件时强制单调的依据；跨重启经落盘恢复）。 */
function baselineTsOf(state, instanceId) {
  let ts = null;
  for (const event of state.events.values()) {
    if (event.instanceId === instanceId && (ts === null || Date.parse(event.ts) > Date.parse(ts))) {
      ts = event.ts;
    }
  }
  return ts;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
