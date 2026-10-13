import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeJsonAtomic } from './storage.js';
import { sessionFilePath } from './paths.js';
import { ID_PATTERN } from './net/protocol.js';

/* 会话级状态文件写入端（状态栏「协作中」指示的机制载体）：把本会话参与的协作快照写进
 * <主数据目录>/sessions/<sessionId>.json——会话标识取自会话注入的 CLAUDE_CODE_SESSION_ID
 * （MCP 子进程可见性经实测在案），同机多会话按标识各写各的文件、读取端直接命中。
 * 生命周期挂在会话进程上：启动即写、周期心跳、会话关闭删除（会话关了这台机器就离线）。
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
  const payload = {
    v: STATUS_VERSION,
    sessionId: state.sessionId,
    instanceId: snapshot.instanceId,
    identityName: snapshot.identityName,
    site: snapshot.site ?? null,
    port: snapshot.port ?? null,
    pid: process.pid,
    updatedAt: state.now().toISOString(),
    collabs: snapshot.collabs,
  };
  try {
    mkdirSync(dirname(/** @type {string} */ (state.filePath)), { recursive: true });
    writeJsonAtomic(/** @type {string} */ (state.filePath), payload);
    state.counters.writes++;
  } catch (error) {
    state.counters.writeFailures++;
    state.log.warn('会话状态文件写入失败（不影响主流程）', { reason: error?.message });
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
  try {
    rmSync(state.filePath, { force: true });
  } catch (error) {
    state.log.warn('会话状态文件清除失败（读取端按时间判陈旧）', { reason: error?.message });
  }
}
