import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COLLABS_DIR_NAME, CONFIG_FILE_NAME, DATA_DIR_ENV, coreJsonPath, ensureDir, resolveDataDir, resolveLogDir } from '../paths.js';
import { checkWritableDir } from '../selfcheck.js';
import { buildDefaults, loadConfig, saveConfig } from '../config.js';
import { createLogger } from '../log.js';
import { loadOrCreateInstanceId } from '../instance-id.js';
import { createToolRegistry } from '../tools/registry.js';
import { statusTool } from '../tools/status.js';
import { hostsTool } from '../tools/hosts.js';
import { pingTool } from '../tools/ping.js';
import { deliveryStatusTool } from '../tools/delivery-status.js';
import { checkInboxTool } from '../tools/check-inbox.js';
import { listCollabsTool, createCollabTool, inviteTool, requestJoinTool, approveInviteTool, withdrawInviteTool, viewLedgerTool, sendMessageTool, setMuteTool, leaveCollabTool, endCollabTool } from '../tools/collab.js';
import { decideTool, handoverTool, takeOverTool } from '../tools/governance.js';
import { createKnownHosts } from '../net/known-hosts.js';
import { createDiscovery } from '../net/discovery.js';
import { createTransport } from '../net/transport.js';
import { createDispatch } from '../net/dispatch.js';
import { createInbound } from '../net/inbound.js';
import { createNetStack } from '../net/stack.js';
import { createCollabService } from '../collab/service.js';
import { isPort } from '../net/protocol.js';
import { createCoreSessionStatus, indicatedEntriesOf, isIndicatedCollab } from '../session-status.js';
import { ANCHOR_PORT, SLOT_COUNT, tryAcquirePort } from '../site.js';
import { writeJsonAtomic } from '../storage.js';
import { rootDigest } from '../util/digest.js';
import { openViewerOnStart, openViewerWindow } from '../viewer/launch.js';
import { IPC_VERSION, createIpcServer, endpointFor, newIpcToken } from './ipc.js';
import { createInjectionRouter } from './routing.js';
import {
  STARTUP_DEADLINE_MS, acquireCoreLock, createArbiter, createBridgeRegistry, createChangeoverSeat,
  createEndpointProbe, createGraceWindow, createOwnedHeartbeat, createPeriodicRetry, createPortDetector,
  createWaitingLifetime, degradedDetailOf, lifecycleParams, pidIsAlive, readCoreRecord, readPersistentCore,
  removeOwnCoreRecord, sameProcessRecord, startHeartbeat, testNumber, waitingDetailOf,
} from './lifecycle.js';

/* 核心组合根与启动序（设计 §3.1-6）：本数据根唯一的常驻驿站进程——数据、网络、定时器与工具执行的
 * 唯一持有者与唯一写者；不持有会话凭据（注入口写入端在桥，凭据不出桥进程）。
 * 启动序固定：取锁（含仲裁循环）→ 探测（同根两道：命中即驻留等待接管态并在此返回）→ 自检 →
 * 身份与配置落盘 → LAN 栈（端口被占＝①② 降级服务＋周期重试）→ 注册表加载（组件构造内含）→
 * IPC 监听 → 原子改写 ready。
 * 失败语义：启动失败把原因尽力写进 run/core.json 的 startupError 后由入口以退出码 1 拒绝服务
 * （run/ 自身不可写时原因写不进——如实只剩退出码）；正常退出（含宽限到期/等待态寿命到期）删运行
 * 描述符前对证锁仍为自己。 */

// 版本单一来源：包元数据（安装树即版本权威——核心运行的就是安装树里的这份代码）
const APP_VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

const CORE_RECORD_VERSION = 1;   // run/core.json 的文件形态版本（字段口径变化时人工递增）
const ANCHOR_SEAM_ENV = 'WAYSTATION_TEST_ANCHOR_PORT';

/* 观察窗脚本入口（触发 A/B 的拉起出口用）：按模块位置相对解析，不依赖 PATH/工作目录（同入口布局纪律）。 */
const VIEWER_SCRIPT_PATH = fileURLToPath(new URL('../../scripts/ws-viewer.js', import.meta.url));

/**
 * @typedef {object} CoreRecord
 * @property {number} v
 * @property {number} ipcV
 * @property {string} appVersion
 * @property {number} pid
 * @property {string} endpoint
 * @property {string} token
 * @property {{ instanceId: string, identityName: string } | null} identity
 * @property {number} port
 * @property {string} startedAt
 * @property {string} status
 * @property {string} [statusDetail]
 * @property {string} startupDeadline
 * @property {string} heartbeatAt
 * @property {string} [startupError]
 */

/**
 * @typedef {object} CoreState
 * @property {(message: string) => void} warn
 * @property {{ heartbeatMs: number, pollMs: number, judgeMs: number, graceMs: number, waitingMaxMs: number, probeTimeoutMs: number, startupDelayMs: number, changeoverDelayMs: number, portRetryMs: number, portProbeTimeoutMs: number }} params
 * @property {string} dataDir
 * @property {number} port
 * @property {'config' | 'anchor'} portSource
 * @property {number} anchorPort
 * @property {string} corePath
 * @property {{ stop: () => void } | null} heartbeat
 * @property {any} detector
 * @property {{ stop: () => void } | null} lifetime
 * @property {{ stop: () => void } | null} retry
 * @property {boolean} stopped
 * @property {any} config
 * @property {string} logDir
 * @property {any} log
 * @property {string} instanceId
 * @property {any} self
 * @property {any} collab
 * @property {any} net
 * @property {any} registry
 * @property {any} context
 * @property {any} routing
 * @property {any} ipc
 * @property {any} bridges
 * @property {any} sessionStatus
 * @property {any} grace
 * @property {any} changeover
 * @property {((record: any) => void) | null} onBridgeSessionFileDrop
 * @property {((record: any) => void) | null} onBridgeBindingsSleep
 * @property {boolean} persistent
 * @property {{ promise: Promise<number>, settle: (code: number) => void }} exit
 * @property {boolean} configCreated
 * @property {boolean} identityDefaulted
 * @property {CoreRecord} record
 */

/** @typedef {{ ok: true, dataDir: string, port: number, portSource: 'config' | 'anchor' }} RootOk */
/** @typedef {RootOk | { ok: false, message: string }} RootResolution */
/** @typedef {{ ok: false, reason: string, message: string, exitCode?: number }} StartupResult */

/* 跨进程测试注入缝的读取原语（testNumber）在生命周期层（单一权威）；本文件只用锚点缝。 */
function anchorPortOf(env) {
  return testNumber(env, ANCHOR_SEAM_ENV, 1, 65535) ?? ANCHOR_PORT;
}

/* 单根解析（设计 §6.1）：数据根＝WAYSTATION_HOME 优先、缺省 ~/.waystation（路径层既有语义不变）；
 * 端口＝config.port 显式值——未显式配置时：主根（默认路径）取锚点；显式根拒绝启动（必须显式配端口，
 * 防两个根静默同抢锚点），不落盘、不静默取端口。options.mainDir 为测试注入缝（伪造默认根），生产缺省。 */
/**
 * @param {{ env?: Record<string, string | undefined>, mainDir?: string }} [options]
 * @returns {RootResolution}
 */
export function resolveCoreRoot(options = {}) {
  const env = options.env ?? process.env;
  const explicitRoot = typeof env[DATA_DIR_ENV] === 'string' && env[DATA_DIR_ENV].trim() !== '';
  const dataDir = explicitRoot ? resolveDataDir(env) : (options.mainDir ?? resolveDataDir(env));
  const anchorPort = anchorPortOf(env);
  const configured = configuredPortOf(dataDir);
  if (configured !== null) {
    return { ok: true, dataDir, port: configured, portSource: 'config' };
  }
  if (explicitRoot) {
    return {
      ok: false,
      message: `显式数据根未显式配置端口——拒绝启动：请在 ${join(dataDir, CONFIG_FILE_NAME)} 中设置 port`
        + `（核心端口＝显式值；仅主根缺省取锚点 ${anchorPort}——多根不配端口会静默同抢锚点）`,
    };
  }
  return { ok: true, dataDir, port: anchorPort, portSource: 'anchor' };
}

/* 配置文件里的原始 port：只认「文件存在、JSON 可解析、根为对象、port 为合法端口」——
 * 其余（缺失/损坏/非法值）一律按未配置处理：显式根据此拒绝启动，不静默兜底。 */
function configuredPortOf(dataDir) {
  /** @type {unknown} */
  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync(join(dataDir, CONFIG_FILE_NAME), 'utf8'));
  } catch {
    // 不存在 / 不可读 / 损坏与「形状不符」共用出口：都按未配置处理
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const port = /** @type {Record<string, unknown>} */ (parsed).port;
  return isPort(port) ? port : null;
}

/** 取锁（含仲裁循环，设计 §2.3）：独占创建失败（EEXIST）转仲裁——等待活核、让位已有核心、
 * 判死收紧后清理陈旧锁——直到本进程取得锁或按结论退出；数据根不可写等其他 errno 直接拒绝。
 * 结论为 null＝本进程已持有锁；否则为带退出码的拒绝结论（running 让位＝0，occupied 拒绝服务＝1）。
 * @param {CoreState} state
 * @returns {Promise<StartupResult | null>} */
async function acquireCoreWithArbitration(state) {
  const arbiter = createLockArbiter(state);
  for (;;) {
    const acquired = acquireCoreLock({
      dataDir: state.dataDir,
      corePath: state.corePath,
      record: state.record,
      log: { warn: (message) => state.warn(message) },
    });
    if (acquired.ok) {
      return null;
    }
    if (acquired.reason !== 'already-exists') {
      return { ok: false, reason: acquired.reason, message: acquired.message, exitCode: 1 };
    }
    const outcome = await arbiter.poll();
    if (outcome.kind === 'running' || outcome.kind === 'occupied') {
      return lockRefusal(state, outcome);
    }
    if (outcome.kind === 'cleared') {
      state.warn(`已隔离陈旧核心锁（${outcome.staleReason}）：${outcome.stalePath}`);
      continue;
    }
    if (outcome.kind === 'rebuild') {
      continue;
    }
    await sleep(outcome.nextPollMs ?? state.params.pollMs);
  }
}

/** 仲裁器装配（时钟注入：观测间隔走单调钟、心跳新鲜判据走墙钟；端点反证经 IPC 客户端面）。
 * @param {CoreState} state @returns {any} */
function createLockArbiter(state) {
  return createArbiter({
    corePath: state.corePath,
    now: () => performance.now(),
    wallNow: () => Date.now(),
    isAlive: pidIsAlive,
    probe: createEndpointProbe({
      dataDir: state.dataDir,
      appVersion: APP_VERSION,
      timeoutMs: state.params.probeTimeoutMs,
      log: null,
    }),
    params: state.params,
    log: { warn: (message) => state.warn(message) },
  });
}

/** 仲裁的非接管结论：running＝已有核心在服务（让位退出 0）；occupied＝有锁但无法确认可服务
 * （保守退出 1）。两者都不清理不抢占。
 * @param {CoreState} state
 * @param {{ kind: string, reason?: string }} outcome
 * @returns {{ ok: false, reason: string, message: string, exitCode: number }} */
function lockRefusal(state, outcome) {
  const reason = outcome.kind === 'running'
    ? '已有核心在服务（pid 存活、端点可连）——不清理、不抢占，本进程退出'
    : `本根已有核心锁但无法确认其可服务（${outcome.reason}）——不清理、不抢占，本进程退出`;
  console.error(`waystation-core: ${reason}`);
  return { ok: false, reason: 'already-running', message: reason, exitCode: outcome.kind === 'running' ? 0 : 1 };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* 运行描述符写入（原子替换：任何时刻读取方看到的都是完整版本）+ 心跳时刻刷新。 */
function writeCoreRecord(state) {
  state.record.heartbeatAt = new Date().toISOString();
  writeJsonAtomic(state.corePath, state.record);
}

// 周期心跳运行期写入：写失败只告警——运行期绝不因写盘问题退出（健壮性硬性要求）。
// 取锁成功即起跳（starting 态自证活核——启动窗口与等待接管态都靠它表达「pid 活」），
// 彼时日志组件尚未构造：告警走可空链。
function writeCoreRecordQuietly(state) {
  try {
    writeCoreRecord(state);
  } catch (error) {
    state.log?.warn?.('运行描述符刷新失败（不影响主流程）', { reason: error.message });
  }
}

/* 启动期/等待期的告警通道：日志组件未构造、或等待接管态不写 logs（避免与在跑的旧站点
 * 日志轮转交错）——stderr 恒可用（与 config/site 同惯例）。 */
function stderrLog(state) {
  return {
    warn: (message, meta) => state.warn(typeof meta?.reason === 'string' ? `${message}（${meta.reason}）` : message),
  };
}

/* 启动序步骤二·同根旧站点探测（设计 §2.3 两道）：命中即进等待接管态并让启动序在此返回——
 * 「数据面零写」的落点：自检/目录创建/身份与配置落盘/组件构造/IPC 全不执行。
 * @returns {Promise<boolean>} 是否进入等待接管态 */
async function probeSameRootStation(state) {
  const detection = await state.detector.detect();
  if (!detection.hit) {
    return false;
  }
  enterWaitingState(state, detection);
  return true;
}

/* ③ 同根 → 驻留等待接管态（设计 §2.3）：不监听 IPC、不写 ready（原子改写只发生在迁出）、数据面零写
 * （collabs/sessions/known-hosts/config）、logs 不写（诊断只走 statusDetail）——仅 run/ 豁免
 * （core.json 心跳与凭据必需）；waiting 无 startupDeadline（僵尸判定由心跳超期承担）；
 * 心跳自取锁成功即起，本态照刷（自证活核）。退出三途：接管（本级迁出）/ 寿命上界 / stop --force
 * （CLI 面终止——零写态无数据风险，核心侧无需代码）。 */
function enterWaitingState(state, detection) {
  state.record.status = 'waiting';
  delete state.record.startupDeadline;
  state.record.identity = detection.own.instanceId === null
    ? null
    : { instanceId: detection.own.instanceId, identityName: detection.own.identityName };
  state.record.statusDetail = waitingDetailOf(detection);
  writeCoreRecord(state);
  state.lifetime = createWaitingLifetime({
    maxMs: state.params.waitingMaxMs,
    onExpire: () => expireWaitingCore(state),
    log: stderrLog(state),
  });
  state.lifetime.start();
  startPortRetry(state, () => waitingRound(state));
}

/* 周期重试循环装配（waiting 重探与 ①② 降级重试共用）：诊断走 stderr（等待期不写 logs）。 */
function startPortRetry(state, round) {
  state.retry = createPeriodicRetry({
    retryMs: state.params.portRetryMs,
    round,
    log: stderrLog(state),
  });
  state.retry.start();
}

function stopWaitingMachinery(state) {
  state.lifetime?.stop();
  state.lifetime = null;
  state.retry?.stop();
  state.retry = null;
}

/* waiting 期每轮：两道重探测——仍命中只更新指引（内容不变不写盘）；不再命中＝迁出判定：
 * 先重验锁（失锁即退，写死），再走全序迁出。迁出时端口若被占（此刻占用者必非本根旧站点——
 * 同根证据已消失），绑定包装自然落入 ①② 降级服务路径（ready＋net.degraded＋后台重试）。 */
async function waitingRound(state) {
  const detection = await state.detector.detect();
  if (detection.hit) {
    const detail = waitingDetailOf(detection);
    if (detail !== state.record.statusDetail) {
      state.record.statusDetail = detail;
      writeCoreRecordQuietly(state);
    }
    return;
  }
  if (!ownLockStillHeld(state)) {
    leaveSuperseded(state);
    return;
  }
  await migrateFromWaiting(state);
}

/* 迁出前重验锁（写死「失锁即退」）：pid/startedAt 对证运行描述符仍是本进程——被顶替即退。 */
function ownLockStillHeld(state) {
  const latest = readCoreRecord(state.corePath);
  return latest.ok && sameProcessRecord(state.record, latest.record);
}

/* 被顶替即退：运行描述符已不属于本进程——让位退出、不清理不迁移（零写态退出无数据风险；
 * core.json 归继任者，删锁路径的对证自会拒绝）。 */
function leaveSuperseded(state) {
  state.warn('运行描述符已不属于本进程（等待接管态被顶替）——退出');
  stopWaitingMachinery(state);
  state.exit.settle(0);
}

/* waiting 寿命上界（60 分钟，设计 §2.3 退出②）：到期自行退出，避免无主进程堆积——删 core.json
 * 前对证仍为自己（删前对证原语），退出码 0；后续任何桥到达会重新探测（旧站点仍在则再入等待，低频循环可接受）。 */
function expireWaitingCore(state) {
  state.warn('等待接管态超过寿命上界——退出（后续桥到达会重新探测）');
  stopWaitingMachinery(state);
  removeOwnCoreRecord({ corePath: state.corePath, mine: state.record, log: stderrLog(state) });
  state.exit.settle(0);
}

/* 迁出（设计 §2.3 退出①）：两道已不命中＋锁已复验 → 补做自检起的全序（等待期零写下缺的写面在此补齐：
 * 目录创建/身份与配置落盘/注册表加载/IPC 监听/原子改写 ready）。迁出期自检不过＝启动失败收场
 * （startupError 尽力写＋退出 1）。 */
async function migrateFromWaiting(state) {
  stopWaitingMachinery(state);
  delete state.record.statusDetail;
  try {
    await runServiceSequence(state);
  } catch (error) {
    const refusal = await refuseStartup(state, error);
    state.exit.settle(refusal.exitCode);
    return;
  }
  state.log.info('等待接管态迁出完成（同根旧站点已退场）', { port: state.port });
}

/* 拉长启动注入（测试缝，生效闸 NODE_TEST_CONTEXT）：把「取锁已建、服务未监听」的启动窗口
 * 拉长到可观察，供并发第二核心「等待不偷锁」的进程级用例；生产恒 0。 */
function startupDelay(state) {
  const delayMs = state.params.startupDelayMs;
  return delayMs > 0 ? sleep(delayMs) : Promise.resolve();
}

/* 启动序步骤七·IPC 监听（桥的服务面）：接 IPC 层的服务器面——端点/认证/帧/心跳在彼处，
 * 本函数只做接线（欢迎回执构造、桥注册表与宽限窗的挂点、业务帧分发、绑定表加载与
 * 注入路由的注册表/IPC 发送面 attach、换代席）。 */
async function listenIpc(state) {
  state.persistent = readPersistentCore({ dataDir: state.dataDir, warn: state.warn });
  state.changeover = createCoreChangeoverSeat(state);
  state.bridges = createBridgeRegistry({
    onCountChange: (count) => state.grace.noteBridgeCount(count),
    log: state.log,
  });
  state.grace = createGraceWindow({
    graceMs: state.params.graceMs,
    persistent: state.persistent,
    onExpire: () => expireCore(state),
    log: state.log,
  });
  /* 会话状态写面（设计 §4.5）：单核心生命周期一份——网络组件重建不重建本写面（已写文件与
   * 首见记账必须跨重建续存）；注册/断开事件在下方 IPC 回调接入。 */
  state.sessionStatus = createCoreSessionStatus({
    dataDir: state.dataDir,
    collect: () => coreSessionSnapshot(state),
    collabsOf: (sessionId) => collabsBoundTo(state, sessionId),
    log: state.log,
  });
  state.sessionStatus.start();
  state.ipc = createIpcServer({
    dataDir: state.dataDir,
    token: state.record.token,
    welcomeOf: ({ bridges }) => state.changeover.refusalFrame() ?? welcomeFrameOf(state, bridges),
    onFrame: (frame, record) => dispatchCoreFrame(state, frame, record),
    onRegister: (record) => registerBridgeEntry(state, record),
    onClose: (record) => closeBridgeEntry(state, record),
    log: state.log,
  });
  state.routing.attach({ registry: state.bridges, ipc: state.ipc });
  state.routing.load();
  await state.ipc.start();
}

/* 换代席构造（设计 §5.2）：首个 replace 受理即广播 core-restarting 并触发换届收尾（恰一次）。
 * 广播抛错只落痕、不得阻断收尾；收尾抛错也必须结算退出（shutting-down 已对外宣告——楔死＝永久
 * 拒握手且不退出）——与宽限路径对收尾回调挂 catch 同待遇。 */
function createCoreChangeoverSeat(state) {
  return createChangeoverSeat({
    onAdmitted: (broadcast) => {
      try {
        state.ipc.broadcast(broadcast);
      } catch (error) {
        state.log?.error?.('换代广播失败（继续收尾）', { reason: error?.message });
      }
      void shutdownForChangeover(state).catch((error) => {
        state.log?.error?.('换届收尾异常（强制结算退出）', { reason: error?.message });
        state.exit.settle(0);
      });
    },
  });
}

/* 桥注册（设计 §3.1-6 末位）：注册表记账 + 会话状态文件写面；该会话首次出现才按规则判一次
 * 观察窗触发 B——每 sessionId 一次记账（重连/顶替/重生重注册不重判，设计 §7）。 */
function registerBridgeEntry(state, record) {
  state.bridges.register(record);
  const noticed = state.sessionStatus.noteRegister(record);
  if (noticed.firstSeen) {
    triggerViewerOnStart(state);
  }
}

/* 触发 B（新会话首次注册；判定口径与旧宿主逐字不变——进行中状态集/同根在跑/不重复弹窗全在
 * 出口内，触发时现读主根 config 的 viewerAutoOpen）：根映射单核恒 main；后台异步、绝不抛出
 * （出口内部消化异常），不阻塞帧处理。 */
function triggerViewerOnStart(state) {
  void openViewerOnStart({
    collabs: state.collab.list().collabs,
    root: 'main',
    digest: rootDigest(state.dataDir),
    dataDir: state.dataDir,
    siteMode: 'single',
    slot: null,
    scriptPath: VIEWER_SCRIPT_PATH,
    log: state.log,
  });
}

/* 会话状态文件的快照面（核心身份与站点形态）：site 恒 single——null/旧形态会被下一核的数据面
 * 同根探测判为旧站点（自锁），写面另有 fail-safe 兜底；collabs 走 per-session 提供者（下函数）。 */
function coreSessionSnapshot(state) {
  return {
    instanceId: state.instanceId,
    identityName: state.config.identityName,
    site: { mode: 'single', slot: null, port: state.port, takeover: false },
    port: state.port,
    collabs: [],
  };
}

/* 会话文件的协作集（per-session 过滤）：绑定条目为唯一权威（create/join/adopt 写点）——
 * 受邀未同意（尚无绑定）不进任何会话文件；被 adopt 夺席后随查询实时转移；休眠绑定（其会话
 * 离线、无该会话文件）无处可见。绑定表经路由实时读取（网络组件重建后同址生效）。 */
function collabsBoundTo(state, sessionId) {
  const listed = state.collab?.list().collabs ?? [];
  const bound = listed.filter((entry) => isIndicatedCollab(entry)
    && state.routing?.bindings?.get(entry.collabId)?.sessionId === sessionId);
  return indicatedEntriesOf(bound, state.collab?.indicators());
}

/* 桥断开清理（设计 §3.3 桥崩行）：删该桥注册——注册表移除即「绑定转休眠」（路由的活跃/休眠按
 * 注册表实时派生，见路由的判定口径）；其会话状态文件删除与绑定休眠的显式写面按两个挂点接入
 * （未接入＝空转，不改变连接与认证语义，同探测占位的先例）。在途 push 不追发：桥已死，消息仍在
 * 核心收件流水，会话重连后经拉取面补看。 */
function closeBridgeEntry(state, record) {
  state.bridges.remove(record);
  state.onBridgeSessionFileDrop?.(record);
  state.onBridgeBindingsSleep?.(record);
}

/* IPC 业务帧分发：delivered → push 回执等待面；call → 工具执行面（执行带安全期限，
 * 每次 call 必回恰一帧 result）；replace → 换代席（首个受理并收尾、其后一律回 replacing）。
 * 帧处理各自独立——执行面的 async 异常在此隔离（回调抛错契约：消费者自行兜底）。 */
function dispatchCoreFrame(state, frame, record) {
  if (frame.type === 'delivered') {
    state.routing.settleDelivered(frame);
    return;
  }
  if (frame.type === 'call') {
    void state.routing.handleCall(frame, record, { tools: state.registry, baseContext: state.context })
      .catch((error) => state.log?.error?.('工具调用执行面异常（已隔离）', { tool: frame.tool, reason: error?.message }));
    return;
  }
  if (frame.type === 'replace') {
    handleReplaceFrame(state, frame, record);
  }
}

/* 换代受理（设计 §5.2 步 1-2）：首个 replace 定 replacer（广播与收尾在席的受理回调里，恰一次）；
 * 其后一律回 welcome{ok:false,code:'replacing'}（帧表内唯一带 ok/code 的回执形态）。 */
function handleReplaceFrame(state, frame, record) {
  const outcome = state.changeover.onReplace({ bridgeId: record.bridgeId, reason: frame.reason, wantApp: frame.wantApp });
  if (outcome.ok === false) {
    state.ipc.send(record, outcome.frame);
    return;
  }
  state.log?.info?.('换代受理：核心进入 shutting-down（有序收尾后退出）', {
    replacer: record.bridgeId,
    reason: frame.reason,
    targetApp: outcome.broadcast.targetApp ?? null,
  });
}

/* 换届收尾（设计 §5.2 步 4）：沿用既有有序收尾（停心跳／等待面按 closeService 语义中止／LAN／
 * IPC／删 core.json——「无未落盘状态」由该语义保证）后请求退出 0；重启由 replacer 桥负责
 * （spawn 安装树入口）。广播发出后的收尾前留可注入窗口（测试缝，生产恒 0）：供进程级用例观察
 * 「shutting-down 期第二桥被拒/新握手被拒」。 */
async function shutdownForChangeover(state) {
  if (state.params.changeoverDelayMs > 0) {
    await sleep(state.params.changeoverDelayMs);
  }
  await stopCore(state);
  state.exit.settle(0);
}

/* 注册回执（帧契约在 IPC 层）：net.degraded 以「LAN 不可用」表达单核降级语义——
 * 端口被占时核心照常 ready，本地工具照常、LAN 工具返回降级文案（设计 §6.1-①②）。 */
function welcomeFrameOf(state, bridges) {
  const net = state.net.status();
  return {
    type: 'welcome',
    ok: true,
    v: IPC_VERSION,
    app: APP_VERSION,
    corePid: process.pid,
    dataDir: state.dataDir,
    identity: { instanceId: state.instanceId, identityName: state.config.identityName },
    port: state.port,
    net: { available: net.available, degraded: !net.available },
    persistent: state.persistent,
    bridges,
  };
}

/* 宽限到期：有序收尾（停心跳 → 等待面 → LAN → IPC → 删运行描述符）后请求退出 0。 */
async function expireCore(state) {
  state.log?.info?.('宽限到期：有序收尾退出');
  await stopCore(state);
  state.exit.settle(0);
}

/* 心跳装配：所有权守卫（周期写前对证锁仍为自己——被顶替窗口内不覆写继任者的描述符，
 * 对证不符即走「失锁即退」）＋周期启动。 */
function startCoreHeartbeat(state) {
  const owned = createOwnedHeartbeat({
    corePath: state.corePath,
    mine: state.record,
    write: () => writeCoreRecordQuietly(state),
    onLost: () => {
      void exitOnLostLock(state);
    },
    log: null,
  });
  return startHeartbeat({ intervalMs: state.params.heartbeatMs, onTick: () => owned.tick() });
}

/* 心跳面失锁（锁已被继任者重建）：有序退出——不写 startupError；stopCore 的对证删锁天然保留
 * 继任者的描述符（不误删）。退出码 0＝收干净后让位，桥按新核重连。 */
async function exitOnLostLock(state) {
  state.log?.warn?.('失锁即退：核心锁已被继任者重建，有序收尾退出');
  await stopCore(state);
  state.exit.settle(0);
}

/* 目录可用性自检：能建目录 + 能真实落盘探针文件（磁盘满/权限不足在这一步暴露），
 * 不合格即抛带原因的启动拒绝（原因进 startupError 与 stderr）。 */
function ensureWritableDir(dir, label) {
  try {
    ensureDir(dir);
  } catch (error) {
    throw new Error(`${label}不可用：${dir}（${error.message}）——启动自检失败，拒绝服务`, { cause: error });
  }
  const check = checkWritableDir(dir);
  if (!check.ok) {
    throw new Error(`启动自检失败，拒绝服务：${check.message}`);
  }
}

function ensureCollabsDir(state) {
  try {
    ensureDir(join(state.dataDir, COLLABS_DIR_NAME));
  } catch (error) {
    state.log.error('协作目录父级创建失败', { dataDir: state.dataDir, reason: error.message });
    throw new Error(`协作目录不可用：${error.message}——启动失败`, { cause: error });
  }
}

/* 启动序步骤三·自检：数据目录 → 配置读取（日志目录按配置解析）→ 日志目录 → 协作目录。
 * 拒绝服务语义与既有组合根一致（数据目录 index.js:62-70、日志目录 77-86）。 */
function checkSelf(state) {
  ensureWritableDir(state.dataDir, '数据目录');
  const loaded = loadConfig(state.dataDir, { defaults: buildDefaults(hostname()), warn: state.warn });
  state.config = loaded.config;
  state.configCreated = loaded.created;
  state.identityDefaulted = loaded.identityDefaulted;
  state.config.port = state.port;   // 生效端口＝单根解析结论（先于任何组件构造）
  state.logDir = resolveLogDir(state.dataDir, state.config.logDir);
  ensureWritableDir(state.logDir, '日志目录');
  state.log = createLogger({ logDir: state.logDir, maxBytes: state.config.logMaxBytes, maxFiles: state.config.logMaxFiles });
  ensureCollabsDir(state);
}

/* 首跑/补写落盘的配置：主根锚点分支不把生效端口写进文件——写进去＝把「缺省锚点」变成
 * 「显式固定」，此后调锚点不再生效（与「程序写下的默认值不预写端口」的既有纪律同向）。 */
function firstRunConfig(state) {
  const written = { ...state.config };
  if (state.portSource === 'anchor') {
    delete written.port;
  }
  return written;
}

/* 启动序步骤四·身份与配置落盘（先落盘、后生效）：实例标识与配置补写都先于组件构造落地；
 * 身份同时补进运行描述符（锁创建时数据根尚未读取，identity 字段彼时为空）。 */
function persistIdentityAndConfig(state) {
  try {
    state.instanceId = loadOrCreateInstanceId(state.dataDir);
  } catch (error) {
    state.log.error('实例标识读写失败', { dataDir: state.dataDir, reason: error.message });
    throw new Error(`实例标识无法持久化：${error.message}——启动失败`, { cause: error });
  }
  state.record.identity = { instanceId: state.instanceId, identityName: state.config.identityName };
  if (state.configCreated || state.identityDefaulted) {
    try {
      saveConfig(state.dataDir, firstRunConfig(state));
    } catch (error) {
      state.log.error('配置文件写入失败', { dataDir: state.dataDir, reason: error.message });
      throw new Error(`配置文件无法写入：${error.message}——启动失败`, { cause: error });
    }
  }
  writeCoreRecord(state);
}

/* 工具处理器注册（19 个）：核心持有注册表与启动期 context；调用者身份注入（per-request）与
 * 执行面（IPC call 帧）在其交付物接入——本函数只做启动期单例装配。 */
function registerTools() {
  const registry = createToolRegistry();
  registry.register(statusTool());
  registry.register(hostsTool());
  registry.register(pingTool());
  registry.register(deliveryStatusTool());
  registry.register(checkInboxTool());
  registry.register(listCollabsTool());
  registry.register(createCollabTool());
  registry.register(approveInviteTool());
  registry.register(withdrawInviteTool());
  registry.register(viewLedgerTool());
  registry.register(sendMessageTool());
  registry.register(setMuteTool());
  registry.register(leaveCollabTool());
  registry.register(endCollabTool());
  registry.register(inviteTool());
  registry.register(requestJoinTool());
  registry.register(decideTool());
  registry.register(handoverTool());
  registry.register(takeOverTool());
  return registry;
}

function buildContext(state) {
  return {
    version: APP_VERSION,
    instanceId: state.instanceId,
    dataDir: state.dataDir,
    logDir: state.logDir,
    config: state.config,
    identityDefaulted: state.identityDefaulted,
    site: { mode: 'single', slot: null, port: state.port, takeover: false },
    net: state.net,
    collab: state.collab,
    startedAt: state.record.startedAt,
    /* 核心的 IPC 端点：ws_status 的 core 字段在场条件（仅核心应答时出现——桥的差错载荷由桥合成）。 */
    coreEndpoint: state.record.endpoint,
    /* 本机活跃终端（ws_list_hosts 本机段的会话数据源）：注册表在 IPC 监听步构造、网络组件重建
     * 不重建它——取值器现取，未装配相位如实为空集合。 */
    activeSessions: () => state.bridges?.sessions() ?? [],
  };
}

/* 启动序步骤五前置·组件构造（协作服务的构造内含注册表加载/恢复——复用既有实现，不另写加载器）。
 * 构造必须先于 net.start：入站帧处理依赖钩子成员（既有接线顺序，不是新语义）。
 * 注入路由先于协作服务构造（notify 注入面需要它，describeCollab 闭包运行期才取服务）；
 * 桥注册表与 IPC 发送面在 listenIpc 内 attach——此前任何提示按「无接收者」处置（丢＋留痕）。
 * 投递钩子按 autoDeliver 配置**不注入**＝消息停留第二档（ws_check_inbox / 观察窗照常）。 */
function buildComponents(state) {
  const config = state.config;
  state.self = { instanceId: state.instanceId, identityName: config.identityName, port: config.port };
  const knownHosts = createKnownHosts({ dataDir: state.dataDir, log: state.log });
  const transport = createTransport({ port: config.port, log: state.log });
  const dispatch = createDispatch({
    dataDir: state.dataDir,
    config,
    transport,
    self: state.self,
    log: state.log,
    /* 转达副本达第三档 → 聚合捎回译回原作者：回调只在运行期触发（声明顺序无碍）。 */
    onRelayedReport: (payload) => state.collab.relayReport(payload),
  });
  state.routing = createInjectionRouter({
    dataDir: state.dataDir,
    log: state.log,
    describeCollab: (collabId) => state.collab?.describe(collabId) ?? null,
  });
  state.collab = createCollabService({
    dataDir: state.dataDir,
    config,
    self: state.self,
    send: (message) => dispatch.send(message),
    sendDirect: (message) => dispatch.sendDirect(message),
    probe: (address, port) => dispatch.ping({ address, port }),
    reassign: (payload) => dispatch.reassignPeer(payload),
    notify: (frame) => state.routing.notify(frame),
    knownHosts,
    log: state.log,
    /* 观察窗触发 A（建立协作即开该协作页）：单核根恒 main、站点形态 single——判定与出口零改，
     * 宿主由旧组合根移到核心。 */
    viewerRoot: 'main',
    openViewer: (ref) => openViewerWindow({
      ref, dataDir: state.dataDir, siteMode: 'single', slot: null, scriptPath: VIEWER_SCRIPT_PATH, log: state.log,
    }),
    /* 指示面变化（内容计数 / 帖 / 成员事件）→ 会话状态文件即时刷新；写面在 IPC 监听步构造，
     * 本回调运行期才触达（LAN 起表到写面构造之间可达——空转护栏）。 */
    onIndicatorChange: () => state.sessionStatus?.refresh(),
  });
  state.net = buildNetStack(state, { knownHosts, transport, dispatch });
  state.registry = registerTools();
  state.context = buildContext(state);
}

// 网络装配：把构造好的四组件与钩子接线（注入面经闭包取协作服务——运行期才触达）
function buildNetStack(state, { knownHosts, transport, dispatch }) {
  const config = state.config;
  return createNetStack({
    discovery: createDiscovery({
      port: config.port,
      instanceId: state.self.instanceId,
      identityName: state.self.identityName,
      getCollabCount: () => state.collab.count(),
      knownHosts,
      log: state.log,
      onJoinKnock: (knock) => state.collab.joinKnock(knock),
    }),
    transport,
    dispatch,
    inbound: createInbound({
      dataDir: state.dataDir,
      config,
      self: state.self,
      dispatch,
      log: state.log,
      hooks: {
        admit: (frame, meta) => state.collab.hooks.admit(frame, meta),
        consume: (frame, meta) => state.collab.hooks.consume(frame, meta),
        sessionGate: (frame) => state.collab.hooks.sessionGate(frame),
        sessionDelivered: (frame) => state.collab.hooks.sessionDelivered(frame),
        /* 链一投递（渲染在核心、桥不渲染不解析）：autoDeliver 关闭＝不注入钩子——
         * 消息停留第二档，由会话经 ws_check_inbox 拉取（既有降级语义零变）。 */
        ...(config.autoDeliver ? { deliverToSession: (frame) => state.routing.deliverToSession(frame) } : {}),
      },
    }),
    port: config.port,
    self: state.self,
    scanWindowMs: config.scanWindowMs,
    probeTimeoutMs: config.probeTimeoutMs,
    degraded: null,
    log: state.log,
  });
}

/* 启动序步骤五·LAN 栈启动（设计 §6.1 统一「等待接管」循环的 ①② 支）：绑定调用经核心层包装——
 * 先自证端口空闲再触达组件（占用者形态在触达前拦下，网络组件不被推进「已关闭不可复用」态）。
 * 端口被占＝降级服务：ready 照常（本地工具照常）、statusDetail 给分类指引、后台 30s 周期重试
 * （每轮重探测重分类；占用者退场即自动接管＝net 恢复，无状态迁移）。 */
async function startNetStack(state) {
  const bind = await state.net.start();
  if (bind.ok) {
    state.collab.start();
    return;
  }
  const detection = await state.detector.detect();
  const message = degradedDetailOf(detection.kind, { port: state.port });
  state.log.warn('局域网功能不可用（降级为本地 MCP 服务）', { reason: bind.reason, message });
  state.record.statusDetail = message;
  writeCoreRecord(state);
  startPortRetry(state, () => lanRetryRound(state));
}

/* 重试轮的绑定尝试（核心层包装 net.stack 的绑定调用）：先以取锁原语自证端口空闲再触达组件——
 * 占用者仍在时不惊动组件（不产生每轮的组件级降级日志＝日志限频；也避免把只占 TCP 的占用者
 * 变成一次性销毁态）；空闲再 start；组件曾随 TCP 半绑定失败销毁（components-closed）时先重建
 * 网络面再试一次（恢复途径是重建组件——组合根职责；重建面见 rebuildNetworkComponents）。 */
async function lanBindAttempt(state) {
  const acquired = await tryAcquirePort({ port: state.port });
  if (!acquired.ok) {
    const detection = await state.detector.detect();
    return { ok: false, kind: detection.kind, message: degradedDetailOf(detection.kind, { port: state.port }) };
  }
  const bind = await state.net.start();
  if (bind.ok) {
    return { ok: true };
  }
  if (bind.reason !== 'components-closed') {
    return { ok: false, kind: bind.reason, message: bind.message };
  }
  rebuildNetworkComponents(state);
  const retried = await state.net.start();
  return retried.ok ? { ok: true } : { ok: false, kind: retried.reason, message: retried.message };
}

/* 网络组件的重建（组件一次性生命周期：TCP 半绑定失败会「同生共死」撤下两个监听，此后 start 恒返回
 * components-closed——恢复途径＝重建组件）。重建面＝网络与协作组件整体重造＋注入路由重挂＋绑定表重载；
 * 保留面＝桥注册表、IPC 服务器与宽限窗（组合根各处经 state 现取，重造即生效；桥连接存活、绑定表从盘重载）。
 * 触达时机＝降级服务期的恢复轮，且前置 `lanBindAttempt` 已以 tryAcquirePort 自证端口空闲——旧组件套接字
 * 必已全关，故旧 net 栈不另 close（关闭面由「components-closed ⟹ 套接字全关」与本次自证共同兜住）。
 * 前提如实：此时 IPC 已监听、桥可以已注册（welcome 已含 net.degraded）——重造会丢弃旧注入路由的
 * 内存态（在途 push 等待者、按会话记账）；LAN 面从未起 ⇒ 远程注入无从产生，残余风险低。 */
function rebuildNetworkComponents(state) {
  try {
    state.collab?.close();
  } catch (error) {
    state.log.warn('重建前协作服务回收异常（已忽略）', { reason: error.message });
  }
  buildComponents(state);
  state.routing.attach({ registry: state.bridges, ipc: state.ipc });
  state.routing.load();
}

/* ①② 降级期间的每轮：重试绑定——成功＝net 恢复（无状态迁移：清降级文案、起协作面、停循环）；
 * 仍被占则只在分类文案变化时写盘（限频：轮次默认 30s，文案不变不产生写）。 */
async function lanRetryRound(state) {
  const attempt = await lanBindAttempt(state);
  if (!attempt.ok) {
    if (attempt.message !== state.record.statusDetail) {
      state.record.statusDetail = attempt.message;
      writeCoreRecordQuietly(state);
    }
    return;
  }
  state.collab.start();
  delete state.record.statusDetail;
  writeCoreRecordQuietly(state);
  state.log.info('局域网监听已恢复（占用者已退场，自动接管）', { port: state.port });
  state.retry?.stop();
  state.retry = null;
}

/* 启动序步骤八·就绪：原子改写 status:'ready'（就绪＝桥的握手语义点）；宽限电平补充——
 * 进入 ready 时注册桥数为 0 也立即起计时（不等「末桥退场」转换事件，设计 §3.2）。 */
function markReady(state) {
  state.record.status = 'ready';
  writeCoreRecord(state);
  state.grace.noteBridgeCount(state.bridges.count());
  state.log.info('核心启动完成', {
    version: APP_VERSION,
    dataDir: state.dataDir,
    port: state.port,
    persistent: state.persistent,
    netAvailable: state.net.status().available,
    collabCount: state.collab.count(),
  });
}

/* 有序收尾（正常退出路径）：停宽限计时 → 停心跳 → 收协作等待面 → 关网络栈 → 关 IPC →
 * 删运行描述符（对证锁仍为自己）。本函数不退出进程：退出码由调用方决定（宽限到期走 exit 闩锁，
 * 入口据此以约定码退出）。 */
async function stopCore(state) {
  if (state.stopped) {
    return;
  }
  state.stopped = true;
  state.grace?.cancel();
  state.heartbeat?.stop();
  stopWaitingMachinery(state);
  state.detector?.close();
  if (state.collab !== null) {
    state.collab.close();
  }
  if (state.net !== null) {
    await state.net.close();
  }
  if (state.ipc !== null) {
    await state.ipc.close();
  }
  state.sessionStatus?.close();   // 删自己写的全部会话文件（会话关了这台机器就离线）
  removeOwnCoreRecord({ corePath: state.corePath, mine: state.record, log: state.log });
}

/* 初始运行描述符（status:'starting'）：字段写全——identity 留空（数据根尚未读取）、
 * endpoint/token 先落（桥按端点建连；token 每次启动轮换，凭据实现归 IPC 层）。 */
function createCoreRecord(root) {
  const startedAt = new Date();
  return {
    v: CORE_RECORD_VERSION,
    ipcV: IPC_VERSION,
    appVersion: APP_VERSION,
    pid: process.pid,
    endpoint: endpointFor(root.dataDir),
    token: newIpcToken(),
    identity: null,
    port: root.port,
    startedAt: startedAt.toISOString(),
    status: 'starting',
    startupDeadline: new Date(startedAt.getTime() + STARTUP_DEADLINE_MS).toISOString(),
    heartbeatAt: startedAt.toISOString(),
  };
}

/* 退出闩锁：宽限到期等内部路径请求进程退出（入口 await whenExited 后按码退出）——
 * 一次性结算（重复 settle 忽略）。 */
function createExitLatch() {
  /** @type {((code: number) => void) | null} */
  let settle = null;
  const promise = new Promise((resolve) => {
    settle = resolve;
  });
  return {
    promise,
    settle: (code) => {
      if (settle !== null) {
        const resolve = settle;
        settle = null;
        resolve(code);
      }
    },
  };
}

/** @param {Record<string, string | undefined>} env @param {RootOk} root @returns {CoreState} */
function createCoreState(env, root) {
  return {
    warn: (message) => {
      console.error(`waystation-core: ${message}`);
    },
    params: lifecycleParams(env),
    dataDir: root.dataDir,
    port: root.port,
    portSource: root.portSource,
    anchorPort: anchorPortOf(env),   // 同根探测的段基（与端口解析同一注入缝）
    corePath: coreJsonPath(root.dataDir),
    heartbeat: null,
    detector: null,
    lifetime: null,
    retry: null,
    stopped: false,
    config: null,
    logDir: '',
    log: null,
    instanceId: '',
    self: null,
    collab: null,
    net: null,
    registry: null,
    context: null,
    routing: null,
    ipc: null,
    bridges: null,
    sessionStatus: null,
    changeover: null,
    grace: null,
    /* 桥断开清理的两个触发挂点：会话状态文件删除——缺省接本核会话状态写面（下方 startCore 装配），
     * 外部注入优先（测试观测/附加写面）；绑定休眠——活跃/休眠由路由按注册表实时派生（无显式写面，
     * 保持空转＝无操作）。 */
    onBridgeSessionFileDrop: null,
    onBridgeBindingsSleep: null,
    persistent: false,
    exit: createExitLatch(),
    configCreated: false,
    identityDefaulted: false,
    record: createCoreRecord(root),
  };
}

/* 启动序（设计 §3.1-6）：探测 → 命中同根即在等待接管态返回（零写落点）→ 拉长启动注入 → 服务段。 */
async function runStartupSequence(state) {
  if (await probeSameRootStation(state)) {
    return;
  }
  await startupDelay(state);
  await runServiceSequence(state);
}

/* 自「自检」起的服务段（启动与 waiting 迁出共用同一序列：等待期零写下缺的写面在此补齐）。 */
async function runServiceSequence(state) {
  checkSelf(state);
  persistIdentityAndConfig(state);
  buildComponents(state);
  await startNetStack(state);
  await listenIpc(state);
  markReady(state);
}

/** 启动失败的收场：先最小回收已构造组件（停心跳与已起的服务面——in-process 调用不留单例残留），
 * 再把原因尽力写进 startupError（run/ 在取锁后即可用；写不进时如实只剩退出码），stderr 明确报出——
 * 入口据此以退出码 1 拒绝服务；文件保留启动态供桥读原因（陈旧锁由后续启动清理）。
 * @param {CoreState} state
 * @param {unknown} error
 * @returns {Promise<{ ok: false, reason: string, message: string, exitCode: number }>} */
async function refuseStartup(state, error) {
  const message = error instanceof Error ? error.message : '未知原因';
  state.record.startupError = message;
  state.heartbeat?.stop();
  stopWaitingMachinery(state);
  state.detector?.close();
  await recycleComponents(state);
  try {
    writeCoreRecord(state);
  } catch {
    // run/ 自身不可写：原因写不进——如实只剩退出码
  }
  console.error(`waystation-core: 启动失败，拒绝服务：${message}`);
  return { ok: false, reason: 'startup-failed', message, exitCode: 1 };
}

/* 启动失败收场的最小回收：逐件隔离——任一回收失败不改变失败结论（in-process 调用不留单例残留）。 */
async function recycleComponents(state) {
  try {
    state.collab?.close();
  } catch {
    // 回收失败不改变失败结论
  }
  try {
    await state.net?.close();
  } catch {
    // 同上
  }
  try {
    await state.ipc?.close();
  } catch {
    // 同上（IPC 监听可能已起——in-process 调用不得留残余监听）
  }
  try {
    state.sessionStatus?.close();   // 与 stopCore 同收口：删自己写的会话文件（启动失败的窄窗防御）
  } catch {
    // 同上
  }
}

/* 服务句柄（现取视图）：waiting 态在启动序早期即返回（彼时组件面还是空相），迁出后才装配——
 * 组件/身份/配置一律经取值器现取，句柄在两种相位下都如实反映当前状态。 */
function coreHandle(state) {
  return {
    dataDir: state.dataDir,
    port: state.port,
    get instanceId() {
      return state.instanceId;
    },
    get identityName() {
      return state.config?.identityName ?? '';
    },
    get registry() {
      return state.registry;
    },
    get context() {
      return state.context;
    },
    get net() {
      return state.net;
    },
    status: () => state.record.status,
    stop: () => stopCore(state),
    whenExited: () => state.exit.promise,
  };
}

/**
 * 启动核心（设计 §3.1-6 固定启动序）：取锁（EEXIST 转仲裁：等待/让位/判死收紧）→ 探测 → 自检 →
 * 身份与配置落盘 → LAN 栈 → 注册表加载（组件构造内含）→ IPC 监听 → 原子改写 ready。
 * 失败（端口未解析/取锁失败/自检不过/异常）一律返回 { ok:false }：不退出进程——
 * 退出码属入口职责（bin 按 exitCode 退出：让位 0、拒绝服务 1；宽限到期等内部退出走 whenExited）。
 * 桥断开清理的两个触发挂点（会话状态文件删除／绑定休眠的显式写面）经 options 注入，供接线步与
 * 测试提供；生产未接入时为空转。
 * @param {{ env?: Record<string, string | undefined>, mainDir?: string,
 *   onBridgeSessionFileDrop?: ((record: any) => void) | null,
 *   onBridgeBindingsSleep?: ((record: any) => void) | null }} [options]
 * @returns {Promise<StartupResult | { ok: true, core: any }>}
 */
export async function startCore(options = {}) {
  const env = options.env ?? process.env;
  const root = resolveCoreRoot({ env, mainDir: options.mainDir });
  if (!root.ok) {
    console.error(`waystation-core: ${root.message}`);
    return { ok: false, reason: 'port-unresolved', message: root.message, exitCode: 1 };
  }
  const state = createCoreState(env, root);
  /* 会话状态文件删除的缺省实现＝本核写面（随该桥断开删 sessions/<sessionId>.json）；注入时以注入者
   * 为准（测试观测/附加写面——写面自身的「当前写者」守卫使重复调用成为空转）。 */
  state.onBridgeSessionFileDrop = options.onBridgeSessionFileDrop ?? ((record) => state.sessionStatus?.noteRemove(record));
  state.onBridgeBindingsSleep = options.onBridgeBindingsSleep ?? null;
  const locked = await acquireCoreWithArbitration(state);
  if (locked !== null) {
    return locked;
  }
  state.heartbeat = startCoreHeartbeat(state);
  state.detector = createPortDetector({
    dataDir: state.dataDir,
    port: state.port,
    segmentBase: state.anchorPort,
    count: SLOT_COUNT,
    probeTimeoutMs: state.params.portProbeTimeoutMs,
    warn: (message) => state.warn(message),
  });
  try {
    await runStartupSequence(state);
  } catch (error) {
    return refuseStartup(state, error);
  }
  return { ok: true, core: coreHandle(state) };
}
