import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeJsonAtomic } from './storage.js';
import { sessionFilePath } from './paths.js';
import { ID_PATTERN } from './net/protocol.js';
import { matchSessionByShort, shortSessionId } from './util/short-id.js';

/* 会话级状态文件写入端（状态栏「协作中」指示的机制载体）：把会话参与协作的快照写进
 * <主数据目录>/sessions/<sessionId>.json，读取端（scripts/statusline.js）按会话标识直接命中。
 * 两份写面共用同一文件形态与跳过/告警纪律：
 *   · 单会话写面（createSessionStatusWriter）：标识取自会话注入的 CLAUDE_CODE_SESSION_ID
 *     （MCP 子进程可见性经实测在案），生命周期挂在会话进程上——启动即写、周期心跳、会话关闭删除；
 *   · 核心写面（createCoreSessionStatus）：核心为每个注册桥写/删（单核多桥，设计 §4.5），
 *     生命周期挂在核心上——注册即写、桥断开删、核心退出删自己写的全部文件。
 * 健壮性：快照采集与写盘异常一律隔离为计数与告警，绝不抛出（写盘问题不得影响主流程）；
 * 会话标识缺失（非 Claude Code 客户端等正常场景）按跳过处理——info 留痕 + 计数，不每次告警。 */

export const SESSION_STATUS_HEARTBEAT_MS = 5000;
export const SESSION_STATUS_STALE_MS = 20000;
const STATUS_VERSION = 1;
const SESSION_ID_ENV = 'CLAUDE_CODE_SESSION_ID';

/* 归档协作不进指示面：状态栏指示的是「本会话正在参与的协作」，条目自带的 archived 布尔
 * （完成 / 终止 / 退出后为真）即判据——不在此重复推导状态语义。
 * 单独导出的缘由：过滤原内联在组合根（src/index.js）收集闭包、无独立观测面——谓词提出来
 * 才能把这条行为契约锁进断言（test/session-status.test.js）。 */
export function isIndicatedCollab(entry) {
  return entry.archived !== true;
}

/* 指示条目的成形与指标合并（写入端快照的裁剪面）：清单条目按 collabId 并入观察面读数
 * （msgCount）——读数缺失或非有效值时字段缺省，读取端按「计数不可得则省略」处理（加性变更，
 * 状态文件版本不动）。静音态同走缺省口径（true 才带字段）：读取端缺字段按未静音——旧文件与
 * 新读取端、新文件与旧读取端两个方向都兼容。
 *
 * 席位来源（0.2.0）：传入 sessionId 且条目携 sessions.localSeats 时，按短码命中「本会话的席位」，
 * role/muted 取该席位；命不中＝本会话没有该协作的席位，条目剔除。未传 sessionId 或条目没有
 * 席位表时沿用旧条目字段（兼容旧调用方与旧清单，不改变状态文件版本）。 */
export function indicatedEntriesOf(entries, indicators, sessionId = null) {
  const readings = new Map((indicators ?? []).map((reading) => [reading.collabId, reading.msgCount]));
  const projected = [];
  for (const entry of entries) {
    const seat = seatOfEntry(entry, sessionId);
    if (seat === null) {
      continue;
    }
    const item = {
      collabId: entry.collabId,
      name: entry.name,
      state: entry.state,
      role: seat === undefined ? entry.role : seat.role,
      mode: entry.mode,
      memberCount: entry.memberCount,
    };
    const muted = seat === undefined ? entry.muted === true : seat.muted === true;
    if (muted) {
      item.muted = true;
    }
    const msgCount = readings.get(entry.collabId);
    if (Number.isInteger(msgCount) && msgCount >= 0) {
      item.msgCount = msgCount;
    }
    projected.push(item);
  }
  return projected;
}

/* 本会话在条目席位表中的席位：undefined＝无席位表/无会话标识（走旧字段兜底）；
 * null＝席位表在场但没有本会话席位（条目不属于本会话）；对象＝命中席位。
 * 席位来源可能是运行时写入的完整 sessionId 或观察窗的短码：统一按短码精确匹配，歧义即拒。 */
function seatOfEntry(entry, sessionId) {
  const seats = entry?.sessions?.localSeats;
  if (!Array.isArray(seats) || typeof sessionId !== 'string' || sessionId === '') {
    return undefined;
  }
  const matchedId = matchSessionByShort(seats, shortSessionId(sessionId));
  if (matchedId === null) {
    return null;
  }
  return seats.find((seat) => seat !== null && typeof seat === 'object' && seat.sessionId === matchedId) ?? null;
}

/**
 * @param {{ mainDataDir: string, sessionId: string | undefined, collect: () => object, log: any,
 *   heartbeatMs?: number, now?: () => Date }} options
 */
export function createSessionStatusWriter({ mainDataDir, sessionId, collect, log, heartbeatMs = SESSION_STATUS_HEARTBEAT_MS, now = () => new Date() }) {
  const state = {
    sessionId: typeof sessionId === 'string' ? sessionId.trim() : '',
    collect,
    log,
    heartbeatMs,
    now,
    /* 关闭为终态：置位后 refresh / start 一律空转——防关闭后的误调用复活文件
     * （会话关了这台机器就离线，复活出的文件会与真实状态相悖）。 */
    stopped: false,
    /** @type {string | null} */
    filePath: null,
    /** @type {ReturnType<typeof setInterval> | null} */
    timer: null,
    counters: { writes: 0, writeFailures: 0, collectFailures: 0, skipped: 0 },
  };
  if (state.sessionId !== '' && ID_PATTERN.test(state.sessionId)) {
    state.filePath = sessionFilePath(mainDataDir, state.sessionId);
  } else {
    state.counters.skipped++;
    state.log.info('会话状态文件未启用（无会话标识）', { envKey: SESSION_ID_ENV });
  }
  return {
    start: () => start(state),
    refresh: () => refresh(state),
    close: () => close(state),
    stats: () => ({ ...state.counters, active: state.filePath !== null && !state.stopped }),
  };
}

/* 启动 = 立即写一次 + 周期心跳；定时器 unref（后台刷新不阻进程退出——会话关闭路径另有显式 close）。
 * 已关闭（终态）的写入端不再重启。 */
function start(state) {
  if (state.stopped || state.filePath === null || state.timer !== null) {
    return;
  }
  refresh(state);
  state.timer = setInterval(() => refresh(state), state.heartbeatMs);
  state.timer.unref();
}

/* 快照采集的异常隔离：采集失败只计数告警并返回 null（调用方跳过本次刷新），绝不抛出。 */
function collectOrNull(state) {
  try {
    return state.collect();
  } catch (error) {
    state.counters.collectFailures++;
    state.log.warn('会话状态快照收集失败（跳过本次刷新）', { reason: error?.message });
    return null;
  }
}

/* 单步刷新（幂等，可独立于 start 调用——供测试与异常路径复用）；已关闭（终态）时空转。 */
function refresh(state) {
  if (state.stopped || state.filePath === null) {
    return;
  }
  const snapshot = collectOrNull(state);
  if (snapshot === null) {
    return;
  }
  writeSessionFile(state, state.sessionId, state.filePath, snapshot, snapshot.collabs, snapshot.site ?? null);
}

/* 文件形态的唯一权威（写入端两份共用）：v + 会话标识 + 身份与站点四字段 + updatedAt + collabs。
 * site 与 collabs 由调用面显式给出（两份写面的站点形态与协作集来源不同）；pid 恒写当前进程——
 * 核心侧该进程即核心，字段语义随宿主移动、不另立判据。 */
function buildPayload(state, sessionId, snapshot, collabs, site) {
  return {
    v: STATUS_VERSION,
    sessionId,
    instanceId: snapshot.instanceId,
    identityName: snapshot.identityName,
    site,
    port: snapshot.port ?? null,
    pid: process.pid,
    updatedAt: state.now().toISOString(),
    collabs,
  };
}

function writeSessionFile(state, sessionId, filePath, snapshot, collabs, site) {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeJsonAtomic(filePath, buildPayload(state, sessionId, snapshot, collabs, site));
    state.counters.writes++;
  } catch (error) {
    state.counters.writeFailures++;
    state.log.warn('会话状态文件写入失败（不影响主流程）', { reason: error?.message });
  }
}

function removeSessionFile(state, filePath) {
  try {
    rmSync(filePath, { force: true });
  } catch (error) {
    state.log.warn('会话状态文件清除失败（读取端按时间判陈旧）', { reason: error?.message });
  }
}

/* 关闭 = 置终态 + 停表 + 删除本会话文件（陈旧残留由读取端按时间判据兜底不可见）。 */
function close(state) {
  state.stopped = true;
  if (state.timer !== null) {
    clearInterval(state.timer);
    state.timer = null;
  }
  if (state.filePath === null) {
    return;
  }
  removeSessionFile(state, state.filePath);
}

/* —— 核心侧写面（单核一核多桥，设计 §4.5） —— */

/**
 * 核心是数据根唯一写者：为每个注册桥写 `sessions/<sessionId>.json`，桥断开删该文件，核心退出
 * 删除自己写的全部文件（等价于「会话关了这台机器就离线」）。
 * 同 sessionId 顶替（客户端重拉新桥而旧连接未断）：最新注册桥为唯一写入者——删文件以「当前写者
 * 的同一连接」对证，顶替后的旧连接断开通知一律空转（「先写后删/先删后写」两种到达顺序都收敛）。
 * 注册通知同时给出「本会话是否核心启动以来首见」——观察窗触发 B 的每 sessionId 一次记账
 * （设计 §7）以它为准：同会话的重连/顶替/重生重注册不再重判，新会话按规则重判。
 * 协作集经 collabsOf(sessionId) 提供（缺省＝全局快照的 collabs）：单核下状态栏呈现的是
 * 「本会话绑定的协作」，绑定归属由接线侧经绑定表查询。
 * 心跳 5s、陈旧 20s 判据沿用（陈旧判据在读取端）；快照采集与写盘异常一律隔离为计数与告警。
 * @param {{ dataDir: string, collect: () => object, collabsOf?: ((sessionId: string) => any[]) | null,
 *   log: any, heartbeatMs?: number, now?: () => Date }} options
 */
export function createCoreSessionStatus({ dataDir, collect, collabsOf = null, log, heartbeatMs = SESSION_STATUS_HEARTBEAT_MS, now = () => new Date() }) {
  const state = {
    dataDir,
    collect,
    collabsOf,
    log,
    heartbeatMs,
    now,
    /* 关闭为终态（同单会话写面）：置位后注册/刷新一律空转。 */
    stopped: false,
    /* sessionId → { bridge, filePath }：当前写者（最新注册桥）。
     * seenSessions＝核心启动以来见过的会话标识（内存表，不落盘——核心重启后由在线桥重新注册重建）。 */
    sessions: new Map(),
    seenSessions: new Set(),
    /** @type {ReturnType<typeof setInterval> | null} */
    timer: null,
    counters: { writes: 0, writeFailures: 0, collectFailures: 0, skipped: 0 },
  };
  return {
    noteRegister: (bridge) => noteRegister(state, bridge),
    noteRemove: (bridge) => noteRemove(state, bridge),
    refresh: () => refreshCore(state),
    start: () => startCore(state),
    close: () => closeCore(state),
    stats: () => ({ ...state.counters, sessions: state.sessions.size, active: !state.stopped }),
  };
}

/* 注册桥的会话标识：缺失或形态不符（ID_PATTERN 同族；标识会拼进文件路径）一律按跳过处理——
 * 沿单会话写面先例：info 留痕 + 计数，不每次告警（非 Claude Code 客户端等属正常场景）。 */
function noteRegister(state, bridge) {
  if (state.stopped) {
    return { tracked: false, sessionId: sessionIdOf(bridge), firstSeen: false };
  }
  const sessionId = sessionIdOf(bridge);
  if (sessionId === null) {
    state.counters.skipped++;
    state.log.info('会话状态文件跳过（桥无会话标识或形态不符）', { bridgeId: bridge?.bridgeId ?? null });
    return { tracked: false, sessionId: null, firstSeen: false };
  }
  const firstSeen = !state.seenSessions.has(sessionId);
  state.seenSessions.add(sessionId);
  const entry = { bridge, filePath: sessionFilePath(state.dataDir, sessionId) };
  state.sessions.set(sessionId, entry);
  const snapshot = collectOrNull(state);
  if (snapshot !== null) {
    writeCoreSessionFile(state, sessionId, entry.filePath, snapshot);
  }
  return { tracked: true, sessionId, firstSeen };
}

/* 桥断开通知：仅当前写者的断开删文件——被顶替的旧连接（或其重复通知）一律空转，
 * 防旧桥的删除把新桥刚写的文件删掉。 */
function noteRemove(state, bridge) {
  const sessionId = sessionIdOf(bridge);
  if (sessionId === null) {
    return false;
  }
  const entry = state.sessions.get(sessionId);
  if (entry === undefined || !isSameBridge(entry.bridge, bridge)) {
    return false;
  }
  state.sessions.delete(sessionId);
  removeSessionFile(state, entry.filePath);
  return true;
}

/* 同一桥连接的判定：IPC 层对同一连接下发同一记录对象，对象同一性即判据；回退连接标识比对——
 * 承接「同桥标识的新旧连接并存」的顶替窗口（此前连接的对象可能已被复制传递）。 */
function isSameBridge(entryBridge, bridge) {
  return entryBridge === bridge || (bridge?.connId !== undefined && entryBridge?.connId === bridge.connId);
}

function sessionIdOf(bridge) {
  const sessionId = bridge?.sessionId;
  return typeof sessionId === 'string' && ID_PATTERN.test(sessionId) ? sessionId : null;
}

/* 站点字段的 fail-safe（核心写面专属）：恒 single 形态——site 缺失/非法一律按核心端口合成。
 * 本核自己的会话文件若写出 null 或旧形态，会被下一核的数据面同根探测误判为「旧站点在跑」
 * 而进等待接管态（自锁），故此处不信任调用方传来的快照。 */
function singleSiteOf(snapshot) {
  const site = snapshot.site;
  if (site !== null && typeof site === 'object' && site.mode === 'single') {
    return site;
  }
  return { mode: 'single', slot: null, port: snapshot.port ?? null, takeover: false };
}

/* 本会话的协作集：缺省（未注入提供者）＝全局快照的 collabs（兼容旧行为）；提供者异常或返回
 * 非数组（形态校验——写入面只落数组形态的 collabs 字段，防缺字段文件）与快照采集同路隔离——
 * 跳过本轮该文件写入（文件保持上一份内容），心跳与指示刷新会重试。 */
function collabsOfSession(state, sessionId, snapshot) {
  if (typeof state.collabsOf !== 'function') {
    return snapshot.collabs;
  }
  try {
    const collabs = state.collabsOf(sessionId);
    if (Array.isArray(collabs)) {
      return collabs;
    }
  } catch (error) {
    state.counters.collectFailures++;
    state.log.warn('会话绑定快照收集失败（跳过本次刷新）', { reason: error?.message });
    return null;
  }
  /* 非数组＝无效提供者输出：与异常同路（跳过本轮写入，不留缺字段文件）。 */
  state.counters.collectFailures++;
  state.log.warn('会话绑定快照形态不符（跳过本次刷新）', { reason: '非数组' });
  return null;
}

/* 核心侧写入一步：协作集走 per-session 提供者、站点恒 single（fail-safe 见上）。 */
function writeCoreSessionFile(state, sessionId, filePath, snapshot) {
  const collabs = collabsOfSession(state, sessionId, snapshot);
  if (!Array.isArray(collabs)) {
    return;
  }
  writeSessionFile(state, sessionId, filePath, snapshot, collabs, singleSiteOf(snapshot));
}

/* 刷新全部注册桥文件（指示面变化不等心跳）：快照采集一次、写入各文件。 */
function refreshCore(state) {
  if (state.stopped || state.sessions.size === 0) {
    return;
  }
  const snapshot = collectOrNull(state);
  if (snapshot === null) {
    return;
  }
  for (const [sessionId, entry] of state.sessions) {
    writeCoreSessionFile(state, sessionId, entry.filePath, snapshot);
  }
}

/* 启动 = 立即刷新一次 + 周期心跳；定时器 unref（后台刷新不阻进程退出——核心退出路径另有显式 close）。 */
function startCore(state) {
  if (state.stopped || state.timer !== null) {
    return;
  }
  refreshCore(state);
  state.timer = setInterval(() => refreshCore(state), state.heartbeatMs);
  state.timer.unref();
}

/* 核心退出 = 停表 + 删除自己写的全部会话文件（终态：其后注册/刷新空转）。 */
function closeCore(state) {
  if (state.stopped) {
    return;
  }
  state.stopped = true;
  if (state.timer !== null) {
    clearInterval(state.timer);
    state.timer = null;
  }
  for (const entry of state.sessions.values()) {
    removeSessionFile(state, entry.filePath);
  }
  state.sessions.clear();
}
