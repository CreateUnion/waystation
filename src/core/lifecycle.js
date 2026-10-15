import { randomBytes } from 'node:crypto';
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { INSTANCE_ID_FILE } from '../instance-id.js';
import { CONFIG_FILE_NAME, coreJsonPath } from '../paths.js';
import { ANCHOR_PORT, OCCUPIER_PROBE_TIMEOUT_MS, SLOT_COUNT, classifyOccupant, createProbeSession, findSameRootSessions } from '../site.js';
import { REPLACER_RELEASE_DEADLINE_MS, createReplaceArbiter } from './changeover.js';
import { createIpcClient, ensureRunDir } from './ipc.js';

/* 核心生命周期层（设计 §2.3 取锁仲裁／§3.2 末桥退场与宽限／§3.4 常驻模式／§6.1 端口语义）：
 * 核心锁的独占创建与对证、取锁仲裁的确定性四分支（pid 死→判陈旧；活核驻留→等待；ready＋端点
 * 反证可连→让位；超期→判死收紧）、心跳启停、宽限期管理（含「进入 ready 时注册桥即 0」的电平补充）、
 * 桥注册表（同 sessionId 新桥顶替旧桥）、常驻开关读取、等待接管态的维持通道（寿命上界与迁出前
 * 重验锁）、端点反证（经 IPC 客户端面做最小应用层往返——探测的瞬时注册/断开会重置核心的宽限窗口，
 * 上界＝候补核数 N〔每次探测的注册-断开最多重置一次〕，无正确性代价，如实登记）。
 * 常量与判据集中于此：数值全员经注入缝（构造参数 > WAYSTATION_TEST_* 环境变量〔生效闸＝
 * NODE_TEST_CONTEXT〕> 内建默认）；判死观测间隔与等待上界一律走单调时钟（防系统睡眠/墙钟跳变误判，
 * 心跳新鲜判据按墙钟比 heartbeatAt——心跳旧不旧是墙钟事实，误杀防线由两次观测与端点反证承担）。 */

export const HEARTBEAT_MS = 5000;
export const STARTUP_DEADLINE_MS = 15000;
export const GRACE_MS = 60000;
export const WAITING_MAX_MS = 60 * 60 * 1000;
export const ARBITRATION_POLL_MS = 1000;
/* 端口占用处置的周期重试间隔（设计 §6.1：等待接管循环默认 30s、每轮重探测重分类、无终止上界） */
export const PORT_RETRY_MS = 30000;
/* 判死阈值下界：≥3×心跳间隔且 ≥15s——实测两下界同为 15s（3×5s），取较大者兜住心跳被改大的配置 */
export const JUDGE_THRESHOLD_MIN_MS = 15000;
const PROBE_TIMEOUT_MS = 2000;
/* 半写锁窗口豁免阈值（具名登记）：独占创建（wx）与内容写入之间，锁文件对并发读者短暂呈现为
 * 空/半份——mtime 新近（写入尚在收敛）时仲裁不清、下一轮再读；超此阈值仍不可读＝真残留，照常清理。
 * 写窗口实测为毫秒级，取 5s 为宽松安全值（≥2×默认仲裁轮询间隔）。 */
const LOCK_SETTLE_MS = 5000;

/* 跨进程测试注入缝（内部族，不进配置面）：仅当 NODE_TEST_CONTEXT 存在时读取——生产环境残留
 * 该变量组不生效；形态或范围不合一律按未注入处理（回落内建值），不静默改用近似值。 */
const NODE_TEST_CONTEXT_ENV = 'NODE_TEST_CONTEXT';
const SEAM_HEARTBEAT = 'WAYSTATION_TEST_HEARTBEAT_MS';
const SEAM_POLL = 'WAYSTATION_TEST_ARBITRATION_POLL_MS';
const SEAM_JUDGE = 'WAYSTATION_TEST_JUDGE_THRESHOLD_MS';
const SEAM_GRACE = 'WAYSTATION_TEST_GRACE_MS';
const SEAM_WAITING = 'WAYSTATION_TEST_WAITING_MAX_MS';
const SEAM_PROBE = 'WAYSTATION_TEST_PROBE_TIMEOUT_MS';
const SEAM_STARTUP_DELAY = 'WAYSTATION_TEST_STARTUP_DELAY_MS';
const SEAM_CHANGEOVER_DELAY = 'WAYSTATION_TEST_CHANGEOVER_DELAY_MS';
const SEAM_PORT_RETRY = 'WAYSTATION_TEST_PORT_RETRY_MS';
const SEAM_PORT_PROBE = 'WAYSTATION_TEST_PORT_PROBE_TIMEOUT_MS';

/** 注入缝读取：闸未开、形态不合或越界一律返回 null（调用方回落内建默认）。 */
export function testNumber(env, name, min, max) {
  if (typeof env[NODE_TEST_CONTEXT_ENV] !== 'string') {
    return null;
  }
  const raw = typeof env[name] === 'string' ? env[name].trim() : '';
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const value = Number(raw);
  return value >= min && value <= max ? value : null;
}

/** 生命周期数值参数（一次读取，随状态对象传递给各原语与仲裁器）。 */
export function lifecycleParams(env) {
  const heartbeatMs = testNumber(env, SEAM_HEARTBEAT, 100, 3600000) ?? HEARTBEAT_MS;
  return {
    heartbeatMs,
    pollMs: testNumber(env, SEAM_POLL, 10, 600000) ?? ARBITRATION_POLL_MS,
    judgeMs: testNumber(env, SEAM_JUDGE, 10, 3600000) ?? Math.max(3 * heartbeatMs, JUDGE_THRESHOLD_MIN_MS),
    graceMs: testNumber(env, SEAM_GRACE, 10, 86400000) ?? GRACE_MS,
    waitingMaxMs: testNumber(env, SEAM_WAITING, 10, 86400000) ?? WAITING_MAX_MS,
    probeTimeoutMs: testNumber(env, SEAM_PROBE, 100, 60000) ?? PROBE_TIMEOUT_MS,
    ...delayParams(env),
  };
}

/* 拉长注入族与端口节奏（单列一支：控制主函数的判据数，守 CS-10 复杂度上限）。 */
function delayParams(env) {
  return {
    startupDelayMs: testNumber(env, SEAM_STARTUP_DELAY, 1, 600000) ?? 0,
    changeoverDelayMs: testNumber(env, SEAM_CHANGEOVER_DELAY, 1, 600000) ?? 0,
    portRetryMs: testNumber(env, SEAM_PORT_RETRY, 10, 600000) ?? PORT_RETRY_MS,
    portProbeTimeoutMs: testNumber(env, SEAM_PORT_PROBE, 50, 30000) ?? OCCUPIER_PROBE_TIMEOUT_MS,
  };
}

/* —— 锁步：独占创建、读取、对证、清理 —— */

/**
 * 取锁（设计 §2.3）：run/core.json 以「独占创建」（wx）原子取得——锁＋运行描述符＋凭据三合一。
 * errno 分级（写死）：EEXIST＝已有核心 → 交调用方进仲裁；EACCES/EROFS＝数据根不可写 →
 * 直接报错（不读 core.json、不判活性、不尝试清理）。run/ 的 0700 创建与「无法保证即告警」
 * 以 IPC 层 ensureRunDir 为单一权威（token 的保密性由 run/ 自身权限承重）。
 * createExclusive 为测试注入缝（平台无 EACCES/EROFS 常态时的桩级验证）。
 * @param {{ dataDir: string, corePath?: string, record: any, createExclusive?: (path: string, text: string) => void, log?: any }} options
 * @returns {{ ok: true } | { ok: false, reason: 'already-exists' } | { ok: false, reason: 'data-dir-unwritable' | 'lock-failed', message: string }}
 */
export function acquireCoreLock({ dataDir, corePath = coreJsonPath(dataDir), record, createExclusive, log = null }) {
  try {
    ensureRunDir(dataDir, { log });
  } catch (error) {
    return { ok: false, reason: 'data-dir-unwritable', message: `数据根不可用：${dataDir}（${error.message}）` };
  }
  const create = createExclusive ?? ((path, text) => writeFileSync(path, text, { flag: 'wx' }));
  try {
    create(corePath, JSON.stringify(record, null, 2) + '\n');
    return { ok: true };
  } catch (error) {
    if (error.code === 'EEXIST') {
      return { ok: false, reason: 'already-exists' };
    }
    if (error.code === 'EACCES' || error.code === 'EROFS') {
      return { ok: false, reason: 'data-dir-unwritable', message: `数据根不可写（${error.code}）：${corePath}` };
    }
    return { ok: false, reason: 'lock-failed', message: `核心锁创建失败：${error.message}` };
  }
}

/** pid 活性判据（signal 0）：ESRCH＝不存在；EPERM＝存在但无权限（视为活）。pid 复用属残余风险
 * （防护链缩窗而非消除，见设计 §2.6 如实登记）。 */
export function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** 读运行描述符：missing＝文件不存在；unreadable＝不可读或形态不合（JSON 坏/根非对象）。
 * @param {string} corePath
 * @returns {{ ok: true, record: any } | { ok: false, reason: 'missing' | 'unreadable' }} */
export function readCoreRecord(corePath) {
  const read = readCoreText(corePath);
  if (!read.ok) {
    return { ok: false, reason: read.reason };
  }
  try {
    const record = JSON.parse(read.text);
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      return { ok: false, reason: 'unreadable' };
    }
    return { ok: true, record };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}

/** @param {string} corePath @returns {{ ok: true, text: string } | { ok: false, reason: 'missing' | 'unreadable' }} */
function readCoreText(corePath) {
  try {
    return { ok: true, text: readFileSync(corePath, 'utf8') };
  } catch (error) {
    return { ok: false, reason: error.code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
}

/* 锁对证（两组字段各有用点）：token/startedAt＝正常退出删锁与判死复校；pid/startedAt＝
 * 等待接管态迁出前的重验（「失锁即退」）。token 每次启动轮换，是「同一把锁」的最强判据。 */
export function sameCoreRecord(mine, current) {
  return Boolean(mine && current && mine.token === current.token && mine.startedAt === current.startedAt);
}

export function sameProcessRecord(mine, current) {
  return Boolean(mine && current && mine.pid === current.pid && mine.startedAt === current.startedAt);
}

/**
 * 判死或陈旧清理（设计 §2.3-d-④）：先重读现状、与 expected 复校，再原子 rename 到
 * `core.json.stale-<rand>`——rename 成功即独占清理权（并发候补只有一个能 rename 成功）。
 * expected＝判定时读到的记录快照（null＝当时不可解析）；重读与快照不符一律拒绝（防删掉继任者的锁）。
 * @param {{ corePath: string, expected: any, log?: any }} options
 * @returns {{ ok: true, stalePath: string } | { ok: false, reason: 'gone' | 'changed' | 'failed', message?: string }}
 */
export function reclaimStaleLock({ corePath, expected, log = null }) {
  const latest = readCoreRecord(corePath);
  if (!latest.ok && latest.reason === 'missing') {
    return { ok: false, reason: 'gone' };
  }
  if (recordChanged(latest, expected)) {
    return { ok: false, reason: 'changed' };
  }
  return renameAside(corePath, log);
}

/** @param {string} corePath @param {any} log
 * @returns {{ ok: true, stalePath: string } | { ok: false, reason: 'gone' | 'failed', message?: string }} */
function renameAside(corePath, log) {
  const stalePath = `${corePath}.stale-${randomBytes(4).toString('hex')}`;
  try {
    renameSync(corePath, stalePath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { ok: false, reason: 'gone' };
    }
    log?.warn?.('陈旧核心锁清理失败', { corePath, reason: error.message });
    return { ok: false, reason: 'failed', message: error.message };
  }
  log?.warn?.('陈旧核心锁已隔离', { corePath, stalePath });
  return { ok: true, stalePath };
}

/* 复校判据：快照的可读性与内容都须与现状一致——可读变坏、坏变可读、内容不符都按「已变」处理。 */
function recordChanged(latest, expected) {
  if (!latest.ok) {
    return expected !== null;
  }
  return expected === null || !sameCoreRecord(expected, latest.record);
}

/**
 * 正常退出清锁：删前对证 token/startedAt 仍为自己；文件缺失按无事；对证不符或读取失败保留不删。
 * @param {{ corePath: string, mine: any, log?: any }} options
 * @returns {{ ok: boolean, removed: boolean }}
 */
export function removeOwnCoreRecord({ corePath, mine, log = null }) {
  const latest = readCoreRecord(corePath);
  if (!latest.ok) {
    if (latest.reason !== 'missing') {
      log?.warn?.('运行描述符读取失败——保留不删', { corePath });
    }
    return { ok: true, removed: false };
  }
  if (!sameCoreRecord(mine, latest.record)) {
    log?.warn?.('运行描述符已被继任者重写——保留不删', { corePath });
    return { ok: true, removed: false };
  }
  return deleteCoreRecord(corePath, log);
}

function deleteCoreRecord(corePath, log) {
  try {
    rmSync(corePath, { force: true });
  } catch (error) {
    log?.warn?.('运行描述符清理失败——保留文件', { corePath, reason: error.message });
    return { ok: false, removed: false };
  }
  return { ok: true, removed: true };
}

/* —— 取锁仲裁（确定性四分支）—— */

function assertArbiterOptions({ now, wallNow, isAlive, probe, params }) {
  if (typeof now !== 'function' || typeof wallNow !== 'function') {
    throw new TypeError('createArbiter 缺少时钟注入（now 单调钟 / wallNow 墙钟）');
  }
  if (typeof isAlive !== 'function') {
    throw new TypeError('createArbiter 缺少 pid 活性判据（isAlive）');
  }
  if (typeof probe !== 'function') {
    throw new TypeError('createArbiter 缺少端点反证（probe）');
  }
  if (params === null || typeof params !== 'object' || !Number.isInteger(params.judgeMs) || !Number.isInteger(params.pollMs)) {
    throw new TypeError('createArbiter 缺少仲裁参数（judgeMs/pollMs 整数）');
  }
}

/**
 * 取锁仲裁器（设计 §2.3）：竞争失败者每轮 poll 重读 run/core.json 后按序判定——
 * a) pid 死 → 判陈旧（原子 rename 清理）；
 * b) pid 活＋starting/waiting＋心跳新鲜 → 等待（不删不抢；starting 另守 startupDeadline，
 *    waiting 无截止期）；
 * c) pid 活＋ready＋端点反证可连 → running（已有核心在服务，本进程让位退出）；
 * d) 超出截止期或心跳超期 → 判死候选：连续两次独立观测（间隔 ≥judgeMs，按单调钟计）＋
 *    有界端点反证（可连 → 降活不判死；探测未完成 → 宁可不杀）＋rename 前 token/startedAt 复校；
 * e) 端点不可连不单独构成陈旧判据——探测未完成（unavailable）同样不构成。
 * 返回结论：rebuild（锁已不在，可直接重建）/ cleared（已判陈旧并清理）/ wait（继续轮询）/
 * running（已有核心在服务）/ occupied（有锁但无法确认可服务：保守退出、不清理不抢占）。
 * @param {{ corePath: string, now: () => number, wallNow: () => number, isAlive: (pid: number) => boolean,
 *   probe: (record: any) => Promise<'reachable' | 'unreachable' | 'unavailable'>, params: { judgeMs: number, pollMs: number }, log?: any }} options
 * @returns {{ poll: () => Promise<any> }}
 */
export function createArbiter(options) {
  assertArbiterOptions(options);
  const state = { candidate: null };
  return { poll: () => poll(state, options) };
}

async function poll(state, ctx) {
  const seen = readCoreRecord(ctx.corePath);
  if (!seen.ok) {
    state.candidate = null;
    if (seen.reason === 'missing') {
      return { kind: 'rebuild', reason: 'missing' };
    }
    if (lockIsSettling(ctx.corePath, ctx.wallNow())) {
      return { kind: 'wait', reason: 'settling', nextPollMs: ctx.params.pollMs };
    }
    return clearedOutcome(ctx, null, 'unreadable');
  }
  if (!ctx.isAlive(seen.record.pid)) {
    state.candidate = null;
    return clearedOutcome(ctx, seen.record, 'pid-dead');
  }
  return pollAlive(state, ctx, seen.record);
}

async function pollAlive(state, ctx, record) {
  const beatFresh = ctx.wallNow() - Date.parse(record.heartbeatAt) < ctx.params.judgeMs;
  const deadlineOver = record.status === 'starting'
    && Date.parse(record.startupDeadline) <= ctx.wallNow();
  if (record.status === 'ready' && beatFresh) {
    state.candidate = null;
    const result = await probeSafely(ctx, record);
    if (result === 'reachable') {
      return { kind: 'running', via: 'probe' };
    }
    return { kind: 'occupied', reason: result === 'unreachable' ? 'endpoint-unreachable' : 'probe-unavailable' };
  }
  if (beatFresh && !deadlineOver) {
    state.candidate = null;
    return { kind: 'wait', reason: record.status === 'waiting' ? 'waiting' : 'starting', nextPollMs: ctx.params.pollMs };
  }
  return judgeCandidate(state, ctx, record);
}

async function judgeCandidate(state, ctx, record) {
  if (state.candidate === null) {
    state.candidate = { at: ctx.now(), token: record.token, startedAt: record.startedAt };
    return { kind: 'wait', reason: 'observe', nextPollMs: ctx.params.pollMs };
  }
  if (ctx.now() - state.candidate.at < ctx.params.judgeMs) {
    return { kind: 'wait', reason: 'observe', nextPollMs: ctx.params.pollMs };
  }
  const snapshot = state.candidate;
  const result = await probeSafely(ctx, record);
  if (result === 'reachable') {
    state.candidate = null;
    return { kind: 'running', via: 'alive' };
  }
  if (result !== 'unreachable') {
    state.candidate = null;
    return { kind: 'occupied', reason: 'probe-unavailable' };
  }
  state.candidate = null;
  return clearedOutcome(ctx, snapshot, 'judged-dead');
}

/* 探针异常按「未完成」处理（宁可不杀）：探测器的错误不得成为判死依据。 */
async function probeSafely(ctx, record) {
  try {
    return await ctx.probe(record);
  } catch (error) {
    ctx.log?.warn?.('端点反证探测异常（按未完成处理）', { reason: error?.message });
    return 'unavailable';
  }
}

/* 半写锁窗口豁免（写死补钉）：不可读且 mtime 新近时不清、下一轮再读——独占创建与内容写入之间
 * 并发读者可能读到空/半份，不得据此判陈旧；mtime 陈旧仍照常清理（防真残留滞留，总在 ≤ 阈值后收敛）。
 * mtime 读不到（文件刚消失）不豁免：由下一轮按 missing 收敛。 */
function lockIsSettling(corePath, wallNow) {
  try {
    return wallNow - statSync(corePath).mtimeMs < LOCK_SETTLE_MS;
  } catch {
    return false;
  }
}

function clearedOutcome(ctx, expected, staleReason) {
  const reclaimed = reclaimStaleLock({ corePath: ctx.corePath, expected, log: ctx.log });
  if (reclaimed.ok) {
    return { kind: 'cleared', staleReason, stalePath: reclaimed.stalePath };
  }
  if (reclaimed.reason === 'gone') {
    return { kind: 'rebuild', reason: 'missing' };
  }
  return { kind: 'wait', reason: 'changed', nextPollMs: ctx.params.pollMs };
}

/* —— 心跳启停 —— */

/**
 * 心跳：非退出态周期刷新运行描述符（starting 起即刷——启动窗口与等待接管态都要自证活核）。
 * onTick 自行吞错（运行期绝不因写盘失败退出进程，健壮性硬性要求）。
 * @param {{ intervalMs: number, onTick: () => void }} options
 * @returns {{ stop: () => void }}
 */
export function startHeartbeat({ intervalMs, onTick }) {
  const timer = setInterval(onTick, intervalMs);
  return { stop: () => clearInterval(timer) };
}

/**
 * 心跳的所有权守卫（「失锁即退」在周期写面的落点）：周期写运行描述符前对证 token/startedAt
 * 仍为自己——被顶替窗口内（锁已被继任者重建）不得覆写继任者的描述符；对证不符即触发退出通道
 * （onLost：有序退出、不删继任者锁、不写 startupError）并停写。读失败（missing/unreadable）
 * 与内容不符同判失锁：本进程对锁的所有权已不可证，保守让位；对证通过才交给 write。
 * @param {{ corePath: string, mine: any, write: () => void, onLost: () => void, log?: any }} options
 * @returns {{ tick: () => void, lost: () => boolean }}
 */
export function createOwnedHeartbeat({ corePath, mine, write, onLost, log = null }) {
  const state = { lost: false };
  return {
    tick() {
      if (state.lost) {
        return;
      }
      const latest = readCoreRecord(corePath);
      if (!latest.ok || !sameCoreRecord(mine, latest.record)) {
        state.lost = true;
        log?.warn?.('心跳对证发现失锁——停止刷新并让位');
        onLost();
        return;
      }
      write();
    },
    lost: () => state.lost,
  };
}

/* —— 宽限期 —— */

/**
 * 宽限窗（设计 §3.2）：注册桥数归零起计时，到期回调有序收尾；新桥到达清零。
 * 电平补充：进入 ready 时即使从未有桥也应立即起计时（调用方以「当前桥数」调用本对象一次）。
 * 常驻模式不因末桥退场起计时（构造即固定）。到期回调异步派发、异常只留痕（收尾失败不得
 * 击穿进程）。计时器 unref：进程存活由心跳与 IPC 监听承担，不依赖本计时器。
 * @param {{ graceMs: number, persistent?: boolean, onExpire: () => any, log?: any }} options
 * @returns {{ noteBridgeCount: (count: number) => void, cancel: () => void, pending: () => boolean }}
 */
export function createGraceWindow({ graceMs, persistent = false, onExpire, log = null }) {
  /** @type {{ timer: ReturnType<typeof setTimeout> | null }} */
  const state = { timer: null };
  function cancel() {
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  }
  function expire() {
    state.timer = null;
    Promise.resolve()
      .then(() => onExpire())
      .catch((error) => log?.warn?.('宽限到期收尾异常', { reason: error?.message }));
  }
  return {
    noteBridgeCount(count) {
      if (count > 0 || persistent) {
        cancel();
        return;
      }
      if (state.timer === null) {
        state.timer = setTimeout(expire, graceMs);
        state.timer.unref?.();
      }
    },
    cancel,
    pending: () => state.timer !== null,
  };
}

/* —— 桥注册表 —— */

/**
 * 桥注册表：bridgeId → {bridgeId, sessionId, record}＋桥数计数（宽限计时输入；后续任务的
 * 注入路由、会话状态文件与会话桥监督共用本表）。同 sessionId 多桥＝新桥顶替旧桥——断开旧连接、
 * 删旧注册（净替换只通知一次计数，避免 0 交叉触发宽限抖动）；remove 幂等（连接关闭事件与
 * 顶替路径可能各触发一次，以 bridgeId/connId 收敛）。
 * @param {{ onCountChange?: ((count: number) => void) | null, onSupersede?: ((entry: any) => void) | null, log?: any }} [options]
 * @returns {any}
 */
export function createBridgeRegistry({ onCountChange = null, onSupersede = null, log = null } = {}) {
  const state = { byBridgeId: new Map(), bySessionId: new Map() };
  function notify() {
    onCountChange?.(state.byBridgeId.size);
  }
  return {
    register(record) {
      const sessionId = typeof record.sessionId === 'string' ? record.sessionId : null;
      const previous = sessionId === null ? undefined : state.bySessionId.get(sessionId);
      const entry = { bridgeId: record.bridgeId, sessionId, record };
      state.byBridgeId.set(entry.bridgeId, entry);
      if (sessionId !== null) {
        state.bySessionId.set(sessionId, entry);
      }
      if (previous !== undefined && previous.bridgeId !== record.bridgeId) {
        state.byBridgeId.delete(previous.bridgeId);
        closeQuietly(previous.record, log);
        onSupersede?.(previous);
      }
      notify();
    },
    remove(record) {
      const entry = findBridge(state, record);
      if (entry === null) {
        return false;
      }
      state.byBridgeId.delete(entry.bridgeId);
      if (entry.sessionId !== null && state.bySessionId.get(entry.sessionId) === entry) {
        state.bySessionId.delete(entry.sessionId);
      }
      notify();
      return true;
    },
    count: () => state.byBridgeId.size,
    list: () => [...state.byBridgeId.values()],
    find: (sessionId) => state.bySessionId.get(sessionId) ?? null,
    /* 活跃终端视图（ws_list_hosts 本机段的数据源）——口径见 sessionsOf。 */
    sessions: () => sessionsOf(state),
  };
}

/* 活跃终端视图的口径：会话集＝带会话标识的注册桥，按注册序——无标识的桥不构成可指名的终端
 * （口径同会话状态写面：不进任何会话文件）；顶替语义使同一会话至多一条，无需再排重。
 * 字段只取注册记录里现成的客户端信息（缺失如实为空值）。 */
function sessionsOf(state) {
  return [...state.byBridgeId.values()]
    .filter((entry) => typeof entry.sessionId === 'string')
    .map((entry) => ({
      sessionId: entry.sessionId,
      bridgeId: entry.bridgeId,
      app: typeof entry.record?.app === 'string' ? entry.record.app : null,
      platform: typeof entry.record?.platform === 'string' ? entry.record.platform : null,
      pid: Number.isInteger(entry.record?.pid) ? entry.record.pid : null,
    }));
}

function closeQuietly(record, log) {
  try {
    record?.close?.();
  } catch (error) {
    log?.warn?.('顶替旧桥时断开其连接失败（忽略）', { reason: error?.message });
  }
}

function findBridge(state, record) {
  if (record === null || typeof record !== 'object') {
    return null;
  }
  for (const entry of state.byBridgeId.values()) {
    if (entry.record === record || (record.connId !== undefined && entry.record?.connId === record.connId)) {
      return entry;
    }
  }
  return null;
}

/* —— 常驻开关 —— */

/**
 * 常驻模式读取（设计 §3.4，每根一份）：纯 JSON.parse＋类型判定，无写副作用（不得走 loadConfig——
 * 其损坏分支会改名重建）。缺省（无文件/无字段）静默 false；非法值（非布尔）或不可读 warn 一次后
 * 按 false 处理。读法与观察窗的 viewerAutoOpen 同构。
 * @param {{ dataDir: string, warn: (message: string) => void, readFile?: (path: string, encoding: 'utf8') => string }} options
 * @returns {boolean}
 */
export function readPersistentCore({ dataDir, warn, readFile = readFileSync }) {
  try {
    const parsed = JSON.parse(readFile(join(dataDir, CONFIG_FILE_NAME), 'utf8'));
    const value = parsed?.persistentCore;
    if (value === undefined || value === false) {
      return false;
    }
    if (value === true) {
      return true;
    }
    warn('persistentCore 值非法（非布尔），按默认（非常驻）处理');
    return false;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    warn(`persistentCore 不可读（${error.message}），按默认（非常驻）处理`);
    return false;
  }
}

/* —— 等待接管态的维持通道 —— */

/**
 * 等待接管态的寿命上界（设计 §2.3 退出②）：驻留超上限即自行退出——避免无主进程堆积；
 * 后续桥到达会重新探测（旧站点仍在则再入等待，低频循环可接受）。到期回调由调用方完成
 * 「删 core.json 前对证 + 退出 0」。计时器 unref：等待核的进程存活由心跳承担。
 * @param {{ maxMs: number, onExpire: () => any, log?: any }} options
 * @returns {{ start: () => void, stop: () => void }}
 */
export function createWaitingLifetime({ maxMs, onExpire, log = null }) {
  /** @type {{ timer: ReturnType<typeof setTimeout> | null }} */
  const state = { timer: null };
  return {
    start() {
      if (state.timer === null) {
        state.timer = setTimeout(() => {
          state.timer = null;
          Promise.resolve()
            .then(() => onExpire())
            .catch((error) => log?.warn?.('等待接管态寿命到期收尾异常', { reason: error?.message }));
        }, maxMs);
        state.timer.unref?.();
      }
    },
    stop() {
      if (state.timer !== null) {
        clearTimeout(state.timer);
        state.timer = null;
      }
    },
  };
}

/* —— 端点反证 —— */

/* 收到 welcome 即证明对端核心活着并能在应用层应答——认证/版本被拒同属「有核心在服务」
 * （拒绝的差异不影响「端点在应答」这一事实）。 */
const ALIVE_REJECTION_CODES = new Set(['auth', 'version', 'replacing', 'shutting-down']);

/**
 * 端点反证（设计 §2.3-d-② 的有界端点反证）：经 IPC 客户端面做最小应用层往返——connect →
 * hello（token 读自运行描述符）→ welcome → 断开。结论三值：reachable（对端在服务）、
 * unreachable（连接失败/超时）、unavailable 由包装层给出（探测未完成）。
 * 探测会瞬时注册/断开一个桥（bridgeId 前缀 probe-）——会重置核心的宽限窗口，上界＝候补核数 N
 * （每次探测的注册-断开最多重置一次），登记为已知项。
 * @param {{ dataDir: string, token: string, appVersion: string, timeoutMs?: number, log?: any }} options
 * @returns {Promise<'reachable' | 'unreachable'>}
 */
export async function probeEndpoint({ dataDir, token, appVersion, timeoutMs = PROBE_TIMEOUT_MS, log = null }) {
  const client = createIpcClient({
    dataDir,
    hello: { app: appVersion, token, bridgeId: `probe-${randomBytes(6).toString('hex')}` },
    connectTimeoutMs: timeoutMs,
    handshakeTimeoutMs: timeoutMs,
    log,
  });
  try {
    await client.connect();
    return 'reachable';
  } catch (error) {
    return ALIVE_REJECTION_CODES.has(error?.code) ? 'reachable' : 'unreachable';
  } finally {
    await client.close();
  }
}

/**
 * 端点反证器（供仲裁接线）：token 取被判记录里的凭据；探测自身异常一律归一为 unavailable
 * （判死收紧按「宁可不杀」处理，探测的实现错误不得成为判死依据）。
 * @param {{ dataDir: string, appVersion: string, timeoutMs?: number, log?: any }} options
 * @returns {(record: any) => Promise<'reachable' | 'unreachable' | 'unavailable'>}
 */
export function createEndpointProbe({ dataDir, appVersion, timeoutMs, log = null }) {
  return async (record) => {
    try {
      return await probeEndpoint({ dataDir, token: record?.token, appVersion, timeoutMs, log });
    } catch (error) {
      log?.warn?.('端点反证不可用（按探测未完成处理）', { reason: error?.message });
      return 'unavailable';
    }
  };
}

/* —— 端口阶段（设计 §6.1 统一「等待接管」循环）—— */

/* 探测告警通道：端口阶段先于日志组件（启动探测）或处于「不写 logs」的等待态——stderr 恒可用。 */
function defaultProbeWarn(message) {
  console.error(`waystation-core: ${message}`);
}

/** 只读本根身份（探测所需身份＝只读路径获取，不触发数据根写面）：instance-id 文件直读——缺失或为空
 * 即无身份（以 null 表征；条目判据对 null 锚一律不命中，不放行）；identityName 直读配置（缺失/损坏/
 * 形态不合回退主机名，与默认配置同源），只作呈现与诊断。
 * 与 loadOrCreateInstanceId 的差异：本路径**不创建**该文件——同根旧站点在跑时它必已存在；
 * 不存在时「无身份」本身即正确结论（没有可吻合的旧站点）。 */
export function readOwnIdentity({ dataDir }) {
  return { instanceId: readIdentityFile(dataDir), identityName: readIdentityName(dataDir) };
}

function readIdentityFile(dataDir) {
  try {
    const value = readFileSync(join(dataDir, INSTANCE_ID_FILE), 'utf8').trim();
    return value === '' ? null : value;
  } catch {
    return null;   // 不存在/不可读：无身份（零写不变量下不创建）
  }
}

function readIdentityName(dataDir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dataDir, CONFIG_FILE_NAME), 'utf8'));
    const name = parsed?.identityName;
    if (typeof name === 'string' && name.trim() !== '') {
      return name;
    }
  } catch {
    // 缺失/损坏：与「配置不存在时用默认身份名」同判（回退主机名）
  }
  return hostname();
}

/**
 * 同根旧站点探测器（设计 §2.3/§6.1 两道）：①端口道＝目标端口双证据身份＋锚点段全段 probe-ack 身份
 * （防旧站点顺延到段内别端口）；②数据面＝sessions/ 下本根新鲜旧形态会话文件（旧站点可能不持任何端口）。
 * 两道任一命中即 same-root。探测会话由本探测器持有（复用套接字：周期重探不给在跑旧站点的已知主机
 * 清单添陌生条目）；两路探测并发跑（同一等待窗口，不叠预算）；detect 不写任何数据面文件。
 * @param {{ dataDir: string, port: number, segmentBase?: number, count?: number, probeTimeoutMs?: number,
 *   warn?: (message: string) => void }} options
 * @returns {{ detect: () => Promise<any>, close: () => void }}
 */
export function createPortDetector({ dataDir, port, segmentBase = ANCHOR_PORT, count = SLOT_COUNT, probeTimeoutMs = OCCUPIER_PROBE_TIMEOUT_MS, warn = defaultProbeWarn }) {
  const session = createProbeSession({ warn });
  return {
    async detect() {
      const own = readOwnIdentity({ dataDir });
      const [target, segment] = await Promise.all([
        session.probeStation({ port, probeTimeoutMs }),
        session.scanSegment({ segmentBase, count, probeTimeoutMs }),
      ]);
      const sessions = findSameRootSessions({ mainDir: dataDir, instanceId: own.instanceId });
      const kind = classifyOccupant({ own, target, segment, sessions });
      return { kind, hit: kind === 'same-root', own, target, segment, sessions };
    },
    close: () => session.close(),
  };
}

/** 等待接管态的指引文案（设计 §2.3 指引承载）：pid 取自数据面条目（端口道身份不含 pid——如实按可得性取）。 */
export function waitingDetailOf(detection) {
  const who = waitingWhoOf(detection?.sessions?.[0] ?? null, detection?.own ?? null);
  return `检测到同根旧版会话运行中（${who}），请先关闭它；关闭后自动接管`;
}

/* 呈现用的「谁」：pid 与身份名按可得性拼装（数据面条目两者都有；端口道身份只有身份名）；都不可得时报无。 */
function waitingWhoOf(session, own) {
  const name = session?.identityName ?? own?.identityName ?? null;
  const parts = [];
  if (session !== null && Number.isInteger(session.pid)) {
    parts.push(`pid ${session.pid}`);
  }
  if (typeof name === 'string' && name !== '') {
    parts.push(name);
  }
  return parts.length > 0 ? parts.join(' / ') : '身份不可得';
}

/** ①② 降级服务的分类文案（设计 §6.1；waiting 不驻留本态，同根相只在残余竞态里出现）。 */
export function degradedDetailOf(kind, { port }) {
  if (kind === 'other-station') {
    return `本机另有驿站占用端口 ${port}——请先停掉该驿站；释放后自动接管（本地工具照常）`;
  }
  if (kind === 'same-root') {
    return `检测到同根旧版会话运行中——请先关闭它；关闭后自动接管（本地工具照常）`;
  }
  return `端口 ${port} 被无关程序占用——请释放后自动接管（本地工具照常）`;
}

/**
 * 周期重试循环（设计 §6.1「无终止上界」）：每 retryMs 跑一轮 round——轮次串行（上一轮未结束不叠发）、
 * 轮内异常隔离（单轮失败不结束循环：端口循环是长期后台面）。计时器 unref：不阻进程退出（退出路径
 * 显式 stop）。waiting 重探与 ①② 降级重试共用本原语。
 * @param {{ retryMs: number, round: () => Promise<any>, log?: any }} options
 * @returns {{ start: () => void, stop: () => void }}
 */
export function createPeriodicRetry({ retryMs, round, log = null }) {
  /** @type {{ timer: ReturnType<typeof setTimeout> | null, stopped: boolean, running: boolean }} */
  const state = { timer: null, stopped: false, running: false };
  const schedule = () => {
    if (state.stopped || state.timer !== null) {
      return;
    }
    state.timer = setTimeout(() => {
      state.timer = null;
      void runRetryRound(state, round, schedule, log);
    }, retryMs);
    state.timer.unref?.();
  };
  return {
    start: () => schedule(),
    stop: () => {
      state.stopped = true;
      if (state.timer !== null) {
        clearTimeout(state.timer);
        state.timer = null;
      }
    },
  };
}

async function runRetryRound(state, round, schedule, log) {
  if (state.stopped || state.running) {
    return;
  }
  state.running = true;
  try {
    await round();
  } catch (error) {
    log?.warn?.('端口重试轮次异常（已隔离，继续重试）', { reason: error?.message });
  } finally {
    state.running = false;
    schedule();
  }
}

/* —— 换代席（核心侧；设计 §5.2） —— */

/**
 * 换届席：把换代仲裁（判定/状态机在 changeover.js——单一权威）缝合到生命周期面——首个 replace
 * 定 replacer 并**恰触发一次收尾回调**（调用方在回调里广播 core-restarting ＋ 走有序收尾），
 * 其后一律回 welcome{ok:false,code:'replacing'}；shutting-down 期的新握手同回该拒绝帧。
 * 收尾本体复用既有 stopCore 面（停心跳/等待面按 closeService 语义中止/LAN/IPC/删 core.json），
 * 退出结算由调用方定（换代退出 0）。
 * @param {{ onAdmitted?: ((broadcast: any, replacer: any) => void) | null, deadlineMs?: number, now?: () => number }} [options]
 * @returns {any}
 */
export function createChangeoverSeat({ onAdmitted = null, deadlineMs = REPLACER_RELEASE_DEADLINE_MS, now = Date.now } = {}) {
  const arbiter = createReplaceArbiter({ deadlineMs, now });
  return {
    phase: () => arbiter.phase(),
    replacer: () => arbiter.replacer(),
    /** shutting-down 期的握手回执（welcome{ok:false,code:'replacing'}）；服务期为 null。 */
    refusalFrame: () => arbiter.refusalFrame(),
    /** replace 帧处理：首个→{ok:true, broadcast}（并触发收尾回调一次）；其后→{ok:false, frame}。 */
    onReplace: (frame) => {
      const outcome = arbiter.onReplace(frame);
      if (outcome.ok === true) {
        onAdmitted?.(outcome.broadcast, arbiter.replacer());
      }
      return outcome;
    },
  };
}
