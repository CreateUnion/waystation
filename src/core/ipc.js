/* 核心与桥之间的本机 IPC 层（设计 §2.3/§2.4）：端点选择与权限、NDJSON 帧编解码与逐字段校验、
 * 首帧（hello）认证、心跳与卡死判定。传输＝命名管道（Windows）/ Unix 域套接字（POSIX）为主端点，
 * 并行监听 TCP 环回（127.0.0.1，ephemeral 端口）供跨 Session 拨入；双监听保证新旧桥混配可用。
 *
 * 本模块只承载两端共用契约与机制；连接生命周期策略（冷启/重连/换代/顶替）属消费方
 * （核心组合根与桥的监督件）。帧协议冻结于此：类型集、字段形态与校验判据以设计 §2.4 为准，
 * 改判据点即改本模块与 test/ipc.test.js。
 *
 * 信任模型（设计 §2.6 如实登记）：本机同用户进程视为可信；端点权限与 token 是纵深防御，
 * 不是对抗同用户恶意进程的保证。对端进程身份校验（连接方须为会话进程子进程）需要拿到连接方的
 * pid / 凭据——Node 核心面不可得：命名管道服务端拿不到客户端 pid（本机实测：remote* 全 undefined、
 * socket._getpeername() 返回空对象、句柄无真实 fd），POSIX 的 SO_PEERCRED 也没有 JS 绑定
 * （要另装原生模块＝新增依赖）。故按设计裁定回落「接受＋如实登记」——不实现进程身份校验；
 * 若 Node 面将来暴露对端凭据 API，应重估该结论（test/ipc.test.js 有对应固化用例会转红提示）。 */

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { ID_PATTERN, isIdentityName, isPort } from '../net/protocol.js';
import { runDir } from '../paths.js';
import { rootDigest } from '../util/digest.js';

/* IPC 帧协议版本：只在帧协议真变时人工 +1，不随 app 版本自动递增（换代判定的兼容维度）。 */
export const IPC_VERSION = 1;

/* 单帧上限 1 MiB（设计 §2.4 写死；与 LAN 帧同值但两协议互不承诺兼容，各自权威）。 */
export const IPC_MAX_FRAME_BYTES = 1048576;

/* 标识与短文本类字符串字段的长度上界（设计 §2.4「各字符串字段长度上界（如 512 字节）」）。
 * 按字节而非字符计——上界服务的是解析与内存边界，多字节字符按实际占用计。 */
export const IPC_STRING_MAX_BYTES = 512;

/* 心跳（设计 §2.4 草案值）：默认 10s ping/pong；30s 无任何帧＝对端卡死（核侧同判定）。
 * 数值经注入缝（构造参数＋ WAYSTATION_TEST_* 环境变量）收敛，真机复测后校准（实现期校准项）。 */
export const HEARTBEAT_PING_MS = 10_000;
export const PEER_TIMEOUT_MS = 30_000;

/* 客户端连接与握手期限（设计 §3.1 数值族；构造参数可注入）。 */
export const IPC_CONNECT_TIMEOUT_MS = 5000;
export const IPC_HANDSHAKE_TIMEOUT_MS = 10000;

/* 帧类型全集（设计 §2.4 帧表）：12 种、两端契约，未知类型一律拒。 */
export const FRAME_TYPES = ['hello', 'welcome', 'call', 'result', 'push', 'delivered', 'replace', 'core-restarting', 'register-update', 'ping', 'pong', 'bye'];

/* 方向归属（帧表的「方向」列）：每端只接受自己方向入站的那批，其余按未知帧拒。 */
const SERVER_INBOUND_TYPES = new Set(['call', 'delivered', 'replace', 'register-update', 'bye', 'ping', 'pong']);
const CLIENT_INBOUND_TYPES = new Set(['welcome', 'result', 'push', 'core-restarting', 'ping', 'pong']);

const PLATFORMS = ['win32', 'linux', 'darwin'];
/* app 版本形态：三段数字＋可选预发布后缀（「x.y.z」的最小放宽——防预发布版本被形态拒而握手失败）。 */
const APP_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const DELIVERED_REASONS = ['rejected', 'failed', 'unavailable', 'timeout'];
/* replace 与 core-restarting 共用原因词表：version-mismatch＝换代（设计 §5.2）；
 * manual＝核心有序退出（CLI 停止通道，设计 §3.4 的「经 IPC 发 replace（reason='manual'）」）。 */
const REPLACE_REASONS = ['version-mismatch', 'manual'];
const WELCOME_ERROR_CODES = ['auth', 'version', 'replacing', 'shutting-down'];
const BYE_REASONS = ['session-end', 'replace'];

/* 本机 TCP loopback 监听：服务上下文（Session 0）冷启的核心，命名管道默认 ACL 会拒绝用户会话
 * 拨号（EPERM）；TCP 环回无此跨 Session 限制。只绑显式 IPv4 环回——localhost 可能解析到 ::1，
 * 0.0.0.0 会暴露到局域网。端口 ephemeral（listen 端口 0），由系统分配后回填描述符。 */
export const IPC_TCP_HOST = '127.0.0.1';

const PIPE_PREFIX = '\\\\.\\pipe\\waystation-';
const UNIX_SOCKET_NAME = 'core.sock';
const RUN_DIR_MODE = 0o700;
const SOCKET_FILE_MODE = 0o600;
const NEWLINE_BYTE = 0x0a;

/* 认证失败的唯一回执（固定字节）：错 token、缺 token 与一切认证阶段形态失败共用同一份——
 * 回执内容不随原因变化，「token 是否通过」不可从回执区分（不泄漏差异信息，设计 §2.4）。 */
const AUTH_REJECTION_LINE = `${JSON.stringify({ type: 'welcome', ok: false, code: 'auth', message: '认证失败' })}\n`;
/* 版本拒绝回执携核心自身 ipcV（v）：桥需要「核心 ipcV 更高（旧桥降级）／更低（桥强制换代）」的
 * 方向才能定行（设计 §5.1 行四/行五），拒绝应答是桥侧唯一可得核心 ipcV 的通道；认证类拒绝不携
 * 任何版本信息（「不泄漏差异」的判据只对认证面成立——token 是否通过不可从回执区分）。 */
const VERSION_REJECTION_LINE = `${JSON.stringify({ type: 'welcome', ok: false, code: 'version', v: IPC_VERSION, message: '驿站版本不兼容，请重开会话加载新版本' })}\n`;
const PING_LINE = `${JSON.stringify({ type: 'ping' })}\n`;

/* 跨进程测试缝：仅当 NODE_TEST_CONTEXT 存在时读取——生产环境残留该变量组不生效；
 * 测试 spawn 子进程须显式传递该变量。不进文档与常规配置面。 */
const NODE_TEST_CONTEXT_ENV = 'NODE_TEST_CONTEXT';
const IPC_PING_ENV = 'WAYSTATION_TEST_IPC_PING_MS';
const IPC_PEER_TIMEOUT_ENV = 'WAYSTATION_TEST_IPC_PEER_TIMEOUT_MS';

/* —— 端点、目录与凭据 —— */

/**
 * IPC 端点：POSIX `<root>/run/core.sock`；Windows `\\.\pipe\waystation-<rootDigest>`（8 hex，
 * 复用 rootDigest 同一函数，不另派生）。多根按摘要天然隔离。
 * @param {string} dataDir 数据根
 * @param {string} [platform] 平台（注入缝：单测在本机断言两形态）
 * @returns {string}
 */
export function endpointFor(dataDir, platform = process.platform) {
  if (platform === 'win32') {
    return `${PIPE_PREFIX}${rootDigest(dataDir)}`;
  }
  return join(runDir(dataDir), UNIX_SOCKET_NAME);
}

/**
 * run/ 显式以 0700 创建（设计 §2.3：token 保密性由 run/ 自身 mode 承重——0700 的目录不可被
 * 非属主穿透；根目录 0755 不致命）。无法保证 0700（设置失败或既存宽松）时告警如实登记：
 * 该前提不成立时 token 不构成秘密。Windows 无 POSIX mode 语义（默认安全描述符），跳过判定。
 * @param {string} dataDir
 * @param {{ log?: any, platform?: string }} [options]
 * @returns {string} run/ 路径
 */
export function ensureRunDir(dataDir, { log, platform = process.platform } = {}) {
  const dir = runDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: RUN_DIR_MODE });
  if (platform !== 'win32') {
    const mode = readDirMode(dir);
    if (mode !== RUN_DIR_MODE) {
      log?.warn?.('run/ 无法保证 0700：token 不构成秘密（设计 §2.3 如实登记）', {
        dir,
        mode: mode === null ? 'unreadable' : mode.toString(8),
      });
    }
  }
  return dir;
}

/**
 * 启动前解除 POSIX 端点的陈旧残余（socket 文件在进程死亡后残留，监听前清理）。
 * Windows 管道随进程消失、无残余可清，恒返回 false。同根唯一写者由核心锁承担，
 * 本函数不做活体探测——调用方须在持有核心锁之后调用。
 * @param {string} dataDir
 * @param {string} [platform]
 * @returns {boolean} 是否清理了残余
 */
export function prepareEndpoint(dataDir, platform = process.platform) {
  if (platform === 'win32') {
    return false;
  }
  const path = endpointFor(dataDir, platform);
  if (!existsSync(path)) {
    return false;
  }
  rmSync(path, { force: true });
  return true;
}

/** 核心每次启动轮换的 IPC token（64 hex）：写入 run/core.json，桥每次连接时现读。 */
export function newIpcToken() {
  return randomBytes(32).toString('hex');
}

function readDirMode(dir) {
  try {
    return statSync(dir).mode & 0o777;
  } catch {
    return null;
  }
}

/* —— 帧校验（外部输入面，判据写死） —— */

/**
 * 逐字段校验一帧（IPC 是外部输入面，不豁免）：类型 / 字段完整性 / 类型 / 长度边界。
 * 未知类型与形态不合一律拒；额外字段忽略（前向兼容）。失败原因只进本机日志与计数、
 * 不回送对端（认证阶段的对外回执固定）。
 * @param {any} frame 解码后的帧对象
 * @returns {{ ok: true, frame: any } | { ok: false, reason: string }}
 */
export function validateIpcFrame(frame) {
  if (!isPlainObject(frame)) {
    return refuse('帧根节点须为 JSON 对象');
  }
  const checker = FRAME_CHECKERS.get(frame.type);
  if (checker === undefined) {
    return refuse(`未知帧类型：${typeof frame.type === 'string' ? frame.type.slice(0, 32) : typeof frame.type}`);
  }
  return checker(frame);
}

/** 帧序列化：一行 JSON＋换行（NDJSON）。发送面数据来自本进程、可信，不做入站校验。 */
export function encodeIpcFrame(frame) {
  return `${JSON.stringify(frame)}\n`;
}

/**
 * NDJSON 帧解码器（字节级切分）：多帧粘连 / 跨块半行 / CRLF / 空行 / 畸形 JSON 都按行收敛；
 * 超长行（> maxBytes）拒帧一次并丢弃至下一个换行（丢弃模式），其后帧照常解析。
 * end() 供流结束场景显式收尾：残余半行按畸形拒帧（不自动调用——连接断开属正常收尾，不算坏帧）。
 * @param {{ maxBytes?: number, onFrame: (frame: any) => void, onRefuse: (reason: 'oversize' | 'malformed') => void }} options
 * @returns {{ push: (chunk: Buffer | string) => void, end: () => void }}
 */
export function createFrameDecoder({ maxBytes = IPC_MAX_FRAME_BYTES, onFrame, onRefuse }) {
  const state = { buffer: Buffer.alloc(0), skipping: false };
  return {
    push: (chunk) => pushChunk(state, chunk, maxBytes, onFrame, onRefuse),
    end: () => finishStream(state, onRefuse),
  };
}

function pushChunk(state, chunk, maxBytes, onFrame, onRefuse) {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
  if (state.skipping) {
    const newline = bytes.indexOf(NEWLINE_BYTE);
    if (newline < 0) {
      return;
    }
    state.skipping = false;
    state.buffer = bytes.subarray(newline + 1);
  } else {
    state.buffer = state.buffer.length === 0 ? bytes : Buffer.concat([state.buffer, bytes]);
  }
  drainLines(state, maxBytes, onFrame, onRefuse);
}

function drainLines(state, maxBytes, onFrame, onRefuse) {
  for (;;) {
    const newline = state.buffer.indexOf(NEWLINE_BYTE);
    if (newline < 0) {
      if (state.buffer.length > maxBytes) {
        state.buffer = Buffer.alloc(0);
        state.skipping = true;
        onRefuse('oversize');
      }
      return;
    }
    const line = state.buffer.subarray(0, newline);
    state.buffer = state.buffer.subarray(newline + 1);
    if (line.length > maxBytes) {
      onRefuse('oversize');
      continue;
    }
    deliverLine(line, onFrame, onRefuse);
  }
}

function deliverLine(line, onFrame, onRefuse) {
  const text = line.toString('utf8').replace(/\r$/, '');
  if (text === '') {
    return;
  }
  try {
    onFrame(JSON.parse(text));
  } catch {
    onRefuse('malformed');
  }
}

function finishStream(state, onRefuse) {
  if (!state.skipping && state.buffer.length > 0) {
    state.buffer = Buffer.alloc(0);
    onRefuse('malformed');
  }
  state.skipping = false;
}

/* —— 帧字段判据（逐类型） —— */

function checkHello(frame) {
  if (!isPositiveInt(frame.v)) {
    return refuse('hello.v 非法（ipcV 为正整数）');
  }
  if (!isAppVersion(frame.app)) {
    return refuse('hello.app 非法（形态 x.y.z）');
  }
  if (!isShortText(frame.token)) {
    return refuse('hello.token 非法');
  }
  if (!isIdLike(frame.bridgeId)) {
    return refuse('hello.bridgeId 非法（ID_PATTERN 同族）');
  }
  if (frame.sessionId !== undefined && !isIdLike(frame.sessionId)) {
    return refuse('hello.sessionId 非法（ID_PATTERN 同族）');
  }
  if (!isPositiveInt(frame.pid)) {
    return refuse('hello.pid 非法（正整数）');
  }
  if (!isPlatform(frame.platform)) {
    return refuse('hello.platform 不在词表');
  }
  return checkSessionMetaFields(frame);
}

/* 会话元数据字段（hello 与 register-update 共用判据）：role / kind 走词表，文本字段按短文本
 * 上界（null 表示「未知/已消失」），metaUpdatedAt 为非负有限数。 */
function checkSessionMetaFields(frame) {
  const refusal = checkSessionMetaVocabulary(frame) ?? checkSessionMetaText(frame) ?? checkSessionMetaTimestamp(frame);
  return refusal ?? accepted(frame);
}

function checkSessionMetaVocabulary(frame) {
  if (frame.role !== undefined && !['master', 'slave', 'none'].includes(frame.role)) {
    return refuse('session-meta.role 不在词表');
  }
  if (frame.kind !== undefined && !['interactive', 'bg', 'unknown'].includes(frame.kind)) {
    return refuse('session-meta.kind 不在词表');
  }
  return null;
}

function checkSessionMetaText(frame) {
  for (const field of ['masterName', 'name', 'entrypoint', 'status']) {
    if (frame[field] !== undefined && frame[field] !== null && !isShortText(frame[field])) {
      return refuse(`session-meta.${field} 非法`);
    }
  }
  return null;
}

function checkSessionMetaTimestamp(frame) {
  if (frame.metaUpdatedAt !== undefined && (!Number.isFinite(frame.metaUpdatedAt) || frame.metaUpdatedAt < 0)) {
    return refuse('session-meta.metaUpdatedAt 非法');
  }
  return null;
}

function checkWelcome(frame) {
  if (frame.ok === true) {
    return checkWelcomeSuccess(frame);
  }
  if (frame.ok === false) {
    if (!WELCOME_ERROR_CODES.includes(frame.code)) {
      return refuse('welcome.code 不在词表');
    }
    if (frame.code === 'version' && frame.v !== undefined && !isPositiveInt(frame.v)) {
      return refuse('welcome.v 非法（version 拒绝帧携核心 ipcV，正整数）');
    }
    if (!isShortText(frame.message)) {
      return refuse('welcome.message 非法');
    }
    return accepted(frame);
  }
  return refuse('welcome.ok 须为布尔');
}

function checkWelcomeSuccess(frame) {
  if (!isPositiveInt(frame.v) || !isPositiveInt(frame.corePid)) {
    return refuse('welcome.v/corePid 非法');
  }
  if (!isAppVersion(frame.app)) {
    return refuse('welcome.app 非法（形态 x.y.z）');
  }
  if (!isShortText(frame.dataDir)) {
    return refuse('welcome.dataDir 非法');
  }
  return checkWelcomeState(frame);
}

function checkWelcomeState(frame) {
  if (!isWelcomeIdentity(frame.identity)) {
    return refuse('welcome.identity 非法');
  }
  if (!isPort(frame.port)) {
    return refuse('welcome.port 非法');
  }
  if (!isWelcomeNet(frame.net)) {
    return refuse('welcome.net 非法（available/degraded 布尔）');
  }
  if (typeof frame.persistent !== 'boolean') {
    return refuse('welcome.persistent 非法');
  }
  if (!Number.isInteger(frame.bridges) || frame.bridges < 0) {
    return refuse('welcome.bridges 非法（非负整数、注册后的在线桥数）');
  }
  return accepted(frame);
}

function checkCall(frame) {
  if (!isIdLike(frame.id)) {
    return refuse('call.id 非法（ID_PATTERN 同族）');
  }
  if (!isShortText(frame.tool)) {
    return refuse('call.tool 非法');
  }
  if (!isPlainObject(frame.args)) {
    return refuse('call.args 须为对象（形态校验交各工具 schema）');
  }
  return accepted(frame);
}

function checkResult(frame) {
  if (!isIdLike(frame.id)) {
    return refuse('result.id 非法（ID_PATTERN 同族）');
  }
  if (!Array.isArray(frame.content)) {
    return refuse('result.content 须为数组（MCP 结果载荷零改动）');
  }
  if (frame.isError !== undefined && typeof frame.isError !== 'boolean') {
    return refuse('result.isError 非法');
  }
  return accepted(frame);
}

function checkPush(frame) {
  if (!isIdLike(frame.pushId)) {
    return refuse('push.pushId 非法（ID_PATTERN 同族）');
  }
  if (!isPayloadText(frame.text)) {
    return refuse('push.text 非法');
  }
  if (!isIdLike(frame.collabId)) {
    return refuse('push.collabId 非法');
  }
  if (!isShortText(frame.frameType)) {
    return refuse('push.frameType 非法');
  }
  return accepted(frame);
}

function checkDelivered(frame) {
  if (!isIdLike(frame.pushId)) {
    return refuse('delivered.pushId 非法（ID_PATTERN 同族）');
  }
  if (typeof frame.ok !== 'boolean') {
    return refuse('delivered.ok 须为布尔');
  }
  if (frame.ok) {
    return frame.reason === undefined ? accepted(frame) : refuse('delivered 成功不得带 reason');
  }
  if (!DELIVERED_REASONS.includes(frame.reason)) {
    return refuse('delivered.reason 不在词表');
  }
  return accepted(frame);
}

function checkReplace(frame) {
  if (!REPLACE_REASONS.includes(frame.reason)) {
    return refuse('replace.reason 不在词表');
  }
  if (frame.reason === 'version-mismatch' && !isAppVersion(frame.wantApp)) {
    return refuse('replace.wantApp 非法（换代请求必给目标版本）');
  }
  if (frame.wantApp !== undefined && !isAppVersion(frame.wantApp)) {
    return refuse('replace.wantApp 非法');
  }
  return accepted(frame);
}

function checkCoreRestarting(frame) {
  if (!REPLACE_REASONS.includes(frame.reason)) {
    return refuse('core-restarting.reason 不在词表');
  }
  if (!isIdLike(frame.replacerBridgeId)) {
    return refuse('core-restarting.replacerBridgeId 非法');
  }
  if (frame.targetApp !== undefined && !isAppVersion(frame.targetApp)) {
    return refuse('core-restarting.targetApp 非法');
  }
  if (!Number.isInteger(frame.deadlineMs) || frame.deadlineMs < 0) {
    return refuse('core-restarting.deadlineMs 非法（非负整数毫秒）');
  }
  return accepted(frame);
}

function checkBye(frame) {
  return BYE_REASONS.includes(frame.reason) ? accepted(frame) : refuse('bye.reason 不在词表');
}

/* ping/pong 无字段要求（额外字段忽略）。 */
function checkHeartbeat(frame) {
  return accepted(frame);
}

const FRAME_CHECKERS = new Map([
  ['hello', checkHello],
  ['welcome', checkWelcome],
  ['call', checkCall],
  ['result', checkResult],
  ['push', checkPush],
  ['delivered', checkDelivered],
  ['replace', checkReplace],
  ['core-restarting', checkCoreRestarting],
  ['register-update', checkSessionMetaFields],
  ['ping', checkHeartbeat],
  ['pong', checkHeartbeat],
  ['bye', checkBye],
]);

/* —— 校验小工具（沿 protocol.js 的结果对象惯例：失败以数据表达，不抛异常穿层） —— */

/** @returns {{ ok: false, reason: string }} */
function refuse(reason) {
  return { ok: false, reason };
}

/** @returns {{ ok: true, frame: any }} */
function accepted(frame) {
  return { ok: true, frame };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/* 标识类短文本：非空、≤512 字节。形态判据（ID_PATTERN 等）由各字段单独施加。 */
function isShortText(value) {
  return typeof value === 'string' && value !== '' && Buffer.byteLength(value, 'utf8') <= IPC_STRING_MAX_BYTES;
}

/* 载荷类文本（push.text）：只要求非空字符串——长度由单帧上限（1 MiB）承重，
 * 不套用标识类的 512B 短界（会话消息本体可达 KB 级）。 */
function isPayloadText(value) {
  return typeof value === 'string' && value !== '';
}

function isIdLike(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function isPlatform(value) {
  return typeof value === 'string' && PLATFORMS.includes(value);
}

function isAppVersion(value) {
  return typeof value === 'string' && APP_VERSION_PATTERN.test(value);
}

function isPositiveInt(value) {
  return Number.isInteger(value) && value > 0;
}

function isWelcomeIdentity(identity) {
  return isPlainObject(identity) && isIdLike(identity.instanceId) && isIdentityName(identity.identityName);
}

function isWelcomeNet(netState) {
  return isPlainObject(netState) && typeof netState.available === 'boolean' && typeof netState.degraded === 'boolean';
}

/* —— 心跳参数（注入缝：构造参数 > 测试环境变量 > 模块默认） —— */

function heartbeatParamsOf(injected = {}) {
  const env = testEnvOverrides();
  return {
    pingIntervalMs: pickMs([injected.pingIntervalMs, env.pingIntervalMs], HEARTBEAT_PING_MS),
    peerTimeoutMs: pickMs([injected.peerTimeoutMs, env.peerTimeoutMs], PEER_TIMEOUT_MS),
    now: typeof injected.now === 'function' ? injected.now : Date.now,
  };
}

function testEnvOverrides() {
  if (process.env[NODE_TEST_CONTEXT_ENV] === undefined) {
    return {};
  }
  return {
    pingIntervalMs: positiveIntOrUndefined(process.env[IPC_PING_ENV]),
    peerTimeoutMs: positiveIntOrUndefined(process.env[IPC_PEER_TIMEOUT_ENV]),
  };
}

function positiveIntOrUndefined(raw) {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function pickMs(values, fallback) {
  for (const value of values) {
    if (Number.isInteger(value) && value > 0) {
      return value;
    }
  }
  return fallback;
}

/* —— 核心侧服务端 —— */

/**
 * IPC 服务端（核心侧）：监听端点、逐连接认证与帧分发、心跳与卡死判定。
 * welcomeOf 由组合根注入（identity/port/net/persistent 是核心状态，本模块不构造业务载荷）；
 * onFrame 只收认证后的桥→核业务帧（call/delivered/replace）；hello/ping/pong/bye 由本层自理
 * （bye＝桥正常退场，连接即关）。
 * 回调抛错契约（冻结）：welcomeOf/onFrame/onRegister/onClose/onStuck 由消费者提供，本层不做
 * try/catch 兜底——回调抛错沿调用点（socket 数据/关闭事件、心跳定时器）穿出，属消费者的编程错误，
 * 消费者须自行隔离并兜底（仓内先例：工具 handler 异常由 registry 兜底为 isError、dispatch 对钩子异常隔离计数）。
 * @param {{
 *   dataDir: string,
 *   token: string,
 *   welcomeOf: (context: { hello: any, record: any, bridges: number }) => any,
 *   onFrame?: (frame: any, record: any) => void,
 *   onRegister?: (record: any) => void,
 *   onClose?: (record: any, info: { reason: string }) => void,
 *   onStuck?: (record: any) => void,
 *   heartbeat?: { pingIntervalMs?: number, peerTimeoutMs?: number, now?: () => number },
 *   log?: any,
 * }} options
 * @returns {{ endpoint: string, state: any, start: () => Promise<{ endpoint: string, tcp: { host: string, port: number } }>, close: () => Promise<void>,
 *   send: (record: any, frame: any) => boolean, broadcast: (frame: any) => number, listBridges: () => any[],
 *   tcp: () => { host: string, port: number } | null }}
 */
export function createIpcServer(options) {
  const state = buildServerState(options);
  return {
    endpoint: state.endpoint,
    state: state.counters,
    start: () => startServer(state),
    close: () => closeServer(state),
    send: (record, frame) => sendToRecord(state, record, frame),
    broadcast: (frame) => broadcast(state, frame),
    listBridges: () => listBridges(state),
    tcp: () => state.tcp,
  };
}

function errnoCodeOf(error) {
  return /** @type {any} */ (error).code;
}

function assertServerOptions(dataDir, token, welcomeOf) {
  if (typeof dataDir !== 'string' || dataDir === '') {
    throw new TypeError('createIpcServer 缺少 dataDir');
  }
  if (typeof token !== 'string' || token === '') {
    throw new TypeError('createIpcServer 缺少 token（核心每次启动轮换）');
  }
  if (typeof welcomeOf !== 'function') {
    throw new TypeError('createIpcServer 缺少 welcomeOf（注册结果构造器）');
  }
}

/** @param {any} [options] */
function buildServerState({ dataDir, token, welcomeOf, onFrame, onRegister, onClose, onStuck, heartbeat, log } = {}) {
  assertServerOptions(dataDir, token, welcomeOf);
  return {
    dataDir,
    token,
    welcomeOf,
    onFrame: onFrame ?? null,
    onRegister: onRegister ?? null,
    onClose: onClose ?? null,
    onStuck: onStuck ?? null,
    log: log ?? null,
    params: heartbeatParamsOf(heartbeat),
    endpoint: endpointFor(dataDir),
    counters: { refusedFrames: 0, oversizeFrames: 0, malformedFrames: 0, invalidFrames: 0, authFailures: 0, versionMismatches: 0, stuckPeers: 0 },
    conns: [],
    nextConnId: 1,
    /** @type {any} */
    listener: null,
    /** @type {{ host: string, port: number } | null} */
    tcp: null,
    /** @type {any} */
    tcpListener: null,
  };
}

async function startServer(state) {
  ensureRunDir(state.dataDir, { log: state.log });
  prepareEndpoint(state.dataDir);
  const listener = net.createServer((socket) => acceptConnection(state, socket));
  /* 常驻错误监听：监听成功后的错误（罕见）只留痕，不得击穿进程（健壮性硬性要求）。 */
  listener.on('error', (error) => state.log?.warn?.('IPC 服务端错误', { code: errnoCodeOf(error) }));
  await listenOn(listener, state.endpoint);
  state.listener = listener;
  if (process.platform !== 'win32') {
    chmodSync(state.endpoint, SOCKET_FILE_MODE);
  }
  await startTcpListener(state);
  return { endpoint: state.endpoint, tcp: { ...state.tcp } };
}

/* TCP 监听与旧端点并存（过渡期双监听）：旧桥照连原端点，新桥优先 TCP。
 * ephemeral 端口由系统分配，监听后从 address() 回填——描述符由组合根写入。 */
async function startTcpListener(state) {
  const listener = net.createServer((socket) => acceptConnection(state, socket));
  listener.on('error', (error) => state.log?.warn?.('IPC TCP 监听错误', { code: errnoCodeOf(error) }));
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    listener.once('error', onError);
    listener.listen({ host: IPC_TCP_HOST, port: 0 }, () => {
      listener.removeListener('error', onError);
      resolve(undefined);
    });
  });
  const address = listener.address();
  if (address === null || typeof address === 'string') {
    throw new TypeError('TCP 监听未返回端口（装配错误）');
  }
  state.tcp = { host: IPC_TCP_HOST, port: address.port };
  state.tcpListener = listener;
}

function listenOn(listener, endpoint) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    listener.once('error', onError);
    listener.listen(endpoint, () => {
      listener.removeListener('error', onError);
      resolve(undefined);
    });
  });
}

async function closeServer(state) {
  for (const conn of [...state.conns]) {
    conn.socket.destroy();
  }
  await closeListener(state, 'listener');
  await closeListener(state, 'tcpListener');
  state.tcp = null;
}

async function closeListener(state, key) {
  const listener = state[key];
  state[key] = null;
  if (listener !== null) {
    await new Promise((resolve) => listener.close(() => resolve(undefined)));
  }
}

function acceptConnection(state, socket) {
  const conn = {
    connId: state.nextConnId++,
    socket,
    lastFrameAt: state.params.now(),
    rejected: false,
    bye: false,
    stuck: false,
    /** @type {any} */
    bridgeId: null,
    /** @type {any} */
    record: null,
    /** @type {any} */
    decoder: null,
    /** @type {any} */
    timer: null,
  };
  state.conns.push(conn);
  conn.decoder = createFrameDecoder({
    onFrame: (frame) => handleInbound(state, conn, frame),
    onRefuse: (reason) => refuseFrame(state, conn, reason),
  });
  socket.on('data', (chunk) => {
    if (!conn.rejected) {
      conn.decoder.push(chunk);
    }
  });
  socket.on('error', (error) => state.log?.warn?.('IPC 连接错误', { connId: conn.connId, code: errnoCodeOf(error) }));
  socket.on('close', () => handleDisconnect(state, conn));
  conn.timer = setInterval(() => tickConnection(state, conn), state.params.pingIntervalMs);
  conn.timer.unref?.();
}

function handleInbound(state, conn, frame) {
  if (conn.rejected) {
    return;
  }
  conn.lastFrameAt = state.params.now();
  if (conn.record === null) {
    authorizeHello(state, conn, frame);
    return;
  }
  dispatchAuthed(state, conn, frame);
}

/* 认证阶段：任何失败都走同一回执＋立即断开（错/缺 token 与形态失败不可区分）。
 * 顺序＝形态校验先于 token 比对——判据不因 token 而变（不泄漏「token 是否已通过」）。 */
function authorizeHello(state, conn, frame) {
  if (!isPlainObject(frame) || frame.type !== 'hello') {
    countRefusal(state, 'invalid', '首帧须为 hello');
    return rejectAuth(state, conn, '首帧非 hello');
  }
  const checked = validateIpcFrame(frame);
  if (!checked.ok) {
    countRefusal(state, 'invalid', checked.reason);
    return rejectAuth(state, conn, checked.reason);
  }
  if (frame.token !== state.token) {
    return rejectAuth(state, conn, 'token 不符');
  }
  if (frame.v !== IPC_VERSION) {
    state.counters.versionMismatches++;
    conn.rejected = true;
    state.log?.warn?.('IPC 版本不兼容，连接关闭', { connId: conn.connId, v: frame.v, coreV: IPC_VERSION });
    conn.socket.end(VERSION_REJECTION_LINE);
    return;
  }
  registerBridge(state, conn, frame);
}

function rejectAuth(state, conn, detail) {
  if (conn.rejected) {
    return;
  }
  conn.rejected = true;
  state.counters.authFailures++;
  state.log?.warn?.('IPC 认证未过，连接关闭', { connId: conn.connId, reason: detail });
  conn.socket.end(AUTH_REJECTION_LINE);
}

function registerBridge(state, conn, hello) {
  conn.bridgeId = hello.bridgeId;
  conn.record = {
    connId: conn.connId,
    bridgeId: hello.bridgeId,
    sessionId: hello.sessionId ?? null,
    pid: hello.pid,
    platform: hello.platform,
    app: hello.app,
    v: hello.v,
    role: hello.role ?? 'none',
    masterName: hello.masterName ?? null,
    name: hello.name ?? null,
    kind: hello.kind ?? null,
    entrypoint: hello.entrypoint ?? null,
    status: hello.status ?? null,
    metaUpdatedAt: hello.metaUpdatedAt ?? 0,
    send: (frame) => sendToConn(state, conn, frame),
    close: () => conn.socket.destroy(),
  };
  state.onRegister?.(conn.record);
  const welcome = state.welcomeOf({ hello, record: conn.record, bridges: listBridges(state).length });
  sendToConn(state, conn, welcome);
}

/* 注册后分发：hello/ping/pong/bye 由本层自理；业务帧交组合根（onFrame）。
 * 未知类型、方向不符（收到核→桥方向的帧）与形态不合一律拒帧计数，连接保持。 */
function dispatchAuthed(state, conn, frame) {
  const checked = validateIpcFrame(frame);
  if (!checked.ok || !SERVER_INBOUND_TYPES.has(frame.type)) {
    countRefusal(state, 'invalid', checked.ok ? `方向不符：${String(frame.type)}` : checked.reason);
    return;
  }
  if (frame.type === 'ping') {
    sendToConn(state, conn, { type: 'pong' });
    return;
  }
  if (frame.type === 'bye') {
    conn.bye = true;
    conn.socket.end();
    return;
  }
  if (frame.type === 'pong') {
    return;
  }
  state.onFrame?.(frame, conn.record);
}

function refuseFrame(state, conn, reason) {
  countRefusal(state, reason, '解码拒帧');
  if (conn.record === null) {
    rejectAuth(state, conn, `解码拒帧：${reason}`);
  }
}

function countRefusal(state, kind, detail) {
  state.counters.refusedFrames++;
  if (kind === 'oversize') {
    state.counters.oversizeFrames++;
  } else if (kind === 'malformed') {
    state.counters.malformedFrames++;
  } else {
    state.counters.invalidFrames++;
  }
  state.log?.warn?.('IPC 拒帧', { kind, detail });
}

function tickConnection(state, conn) {
  if (conn.rejected) {
    return;
  }
  if (state.params.now() - conn.lastFrameAt > state.params.peerTimeoutMs) {
    conn.stuck = true;
    state.counters.stuckPeers++;
    state.log?.warn?.('IPC 对端卡死（超时无任何帧）', { connId: conn.connId, bridgeId: conn.bridgeId });
    if (conn.record !== null) {
      state.onStuck?.(conn.record);
    }
    conn.socket.destroy();
    return;
  }
  if (conn.record !== null) {
    conn.socket.write(PING_LINE);
  }
}

function handleDisconnect(state, conn) {
  if (conn.timer !== null) {
    clearInterval(conn.timer);
    conn.timer = null;
  }
  const index = state.conns.indexOf(conn);
  if (index >= 0) {
    state.conns.splice(index, 1);
  }
  if (conn.record === null) {
    return;
  }
  const reason = conn.bye ? 'bye' : (conn.stuck ? 'stuck' : 'peer');
  state.onClose?.(conn.record, { reason });
}

function sendToConn(state, conn, frame) {
  if (conn.rejected || conn.socket.destroyed) {
    state.log?.warn?.('IPC 发送失败：连接已关闭', { connId: conn.connId, bridgeId: conn.bridgeId });
    return false;
  }
  conn.socket.write(encodeIpcFrame(frame));
  return true;
}

function sendToRecord(state, record, frame) {
  const conn = state.conns.find((candidate) => candidate.record === record || candidate.connId === record?.connId);
  return conn === undefined ? false : sendToConn(state, conn, frame);
}

function broadcast(state, frame) {
  let sent = 0;
  for (const conn of state.conns) {
    if (conn.record !== null && sendToConn(state, conn, frame)) {
      sent++;
    }
  }
  return sent;
}

function listBridges(state) {
  return state.conns.filter((conn) => conn.record !== null).map((conn) => conn.record);
}

/* —— 桥侧客户端（单次连接；重连/换代属上层策略） —— */

/**
 * IPC 客户端（桥侧）：连接端点 → 首帧 hello → 等待 welcome → 逐帧分发 ＋ 心跳。
 * 连接在 connect() 内一次性建立；重连/冷启/换代策略由桥的监督件承载（本模块不感知）。
 * 回调抛错契约（冻结）：onFrame/onStuck/onClose 同服务端——本层不做 try/catch 兜底，抛错穿出，
 * 消费者须自行隔离。
 * @param {{
 *   dataDir: string,
 *   endpoint?: string | { host: string, port: number },
 *   hello: { app: string, v?: number, token: string, bridgeId: string, sessionId?: string, pid?: number, platform?: string,
 *     role?: string, masterName?: string | null, name?: string | null, kind?: string, entrypoint?: string | null,
 *     status?: string | null, metaUpdatedAt?: number },
 *   onFrame?: (frame: any) => void,
 *   onStuck?: () => void,
 *   onClose?: (info: { reason: string }) => void,
 *   heartbeat?: { pingIntervalMs?: number, peerTimeoutMs?: number, now?: () => number },
 *   log?: any,
 *   connectTimeoutMs?: number,
 *   handshakeTimeoutMs?: number,
 * }} options
 * @returns {{ endpoint: string | { host: string, port: number }, state: any, connect: () => Promise<any>, send: (frame: any) => boolean, close: () => Promise<void> }}
 */
export function createIpcClient(options) {
  const state = buildClientState(options);
  return {
    endpoint: state.endpoint,
    state: state.view,
    connect: () => connect(state),
    send: (frame) => sendToCore(state, frame),
    close: () => closeClient(state),
  };
}

function assertClientOptions(dataDir, hello) {
  if (typeof dataDir !== 'string' || dataDir === '') {
    throw new TypeError('createIpcClient 缺少 dataDir');
  }
  if (!isPlainObject(hello) || typeof hello.app !== 'string' || typeof hello.token !== 'string' || typeof hello.bridgeId !== 'string') {
    throw new TypeError('createIpcClient 的 hello 须含 app/token/bridgeId（可选 sessionId/pid/platform）');
  }
}

/** @param {any} [options] */
function buildClientState({ dataDir, endpoint, hello, onFrame, onStuck, onClose, heartbeat, log, connectTimeoutMs = IPC_CONNECT_TIMEOUT_MS, handshakeTimeoutMs = IPC_HANDSHAKE_TIMEOUT_MS } = {}) {
  assertClientOptions(dataDir, hello);
  const state = {
    dataDir,
    hello,
    onFrame: onFrame ?? null,
    onStuck: onStuck ?? null,
    onClose: onClose ?? null,
    log: log ?? null,
    params: heartbeatParamsOf(heartbeat),
    connectTimeoutMs,
    handshakeTimeoutMs,
    /* 端点可注入（描述符里的 TCP 环回）；缺省沿用数据根派生端点——旧核/旧测试形态不变。 */
    endpoint: endpoint ?? endpointFor(dataDir),
    view: { welcome: null, registered: false, refusedFrames: 0, oversizeFrames: 0, malformedFrames: 0, invalidFrames: 0, stuckPeers: 0 },
    started: false,
    registered: false,
    closeReason: 'peer',
    lastFrameAt: 0,
    /** @type {any} */
    socket: null,
    /** @type {any} */
    decoder: null,
    /** @type {any} */
    timer: null,
    /** @type {any} */
    dialTimer: null,
    /** @type {any} */
    handshakeTimer: null,
    /** @type {any} */
    dialError: null,
    /** @type {{ resolve: (welcome: any) => void, reject: (error: Error) => void } | null} */
    settle: null,
  };
  return state;
}

function connect(state) {
  if (state.started) {
    return Promise.reject(new Error('IPC 客户端为单次连接（重连属上层策略）'));
  }
  state.started = true;
  return new Promise((resolve, reject) => {
    state.settle = { resolve, reject };
    state.dialTimer = setTimeout(() => failConnect(state, 'timeout', 'IPC 连接超时'), state.connectTimeoutMs);
    const socket = net.connect(state.endpoint);
    state.socket = socket;
    state.decoder = createFrameDecoder({
      onFrame: (frame) => handleClientFrame(state, frame),
      onRefuse: (reason) => countClientRefusal(state, reason),
    });
    socket.on('connect', () => onConnected(state));
    socket.on('data', (chunk) => {
      if (!socket.destroyed) {
        state.decoder.push(chunk);
      }
    });
    socket.on('error', (error) => {
      state.dialError = error;
      if (state.settle !== null) {
        failConnect(state, errnoCodeOf(error) ?? 'error', `IPC 连接失败：${errnoCodeOf(error) ?? error.message}`);
        return;
      }
      state.log?.warn?.('IPC 连接错误', { code: errnoCodeOf(error) });
    });
    socket.on('close', () => onClientClose(state));
  });
}

function onConnected(state) {
  clearTimeout(state.dialTimer);
  state.dialTimer = null;
  state.handshakeTimer = setTimeout(() => failConnect(state, 'timeout', 'IPC 握手超时（hello 后无 welcome）'), state.handshakeTimeoutMs);
  state.lastFrameAt = state.params.now();
  state.socket.write(encodeIpcFrame(helloFrameOf(state)));
}

function helloFrameOf(state) {
  const hello = state.hello;
  /** @type {Record<string, any>} */
  const frame = {
    type: 'hello',
    // 桥侧件可显式指定本桥帧协议版本（换代判定的「桥 ipcV」注入缝：校准/测试构造两侧不一致）；
    // 缺省＝本进程编译期常量。
    v: hello.v ?? IPC_VERSION,
    app: hello.app,
    token: hello.token,
    bridgeId: hello.bridgeId,
    pid: hello.pid ?? process.pid,
    platform: hello.platform ?? process.platform,
  };
  if (hello.sessionId !== undefined) {
    frame.sessionId = hello.sessionId;
  }
  for (const field of SESSION_META_FIELDS) {
    if (hello[field] !== undefined) {
      frame[field] = hello[field];
    }
  }
  return frame;
}

/* hello 可选的会话元数据字段（register-update 的启动期快照）；undefined 不上帧——
 * JSON 往返会丢 undefined，发送面不必制造空字段。 */
const SESSION_META_FIELDS = ['role', 'masterName', 'name', 'kind', 'entrypoint', 'status', 'metaUpdatedAt'];

/* Error 带 code 的构造（各处拒绝原因统一走本函数：code 供上层按类处置/定向文案）。 */
function errorWithCode(code, message) {
  const error = /** @type {any} */ (new Error(message));
  error.code = code;
  return error;
}

function handleClientFrame(state, frame) {
  state.lastFrameAt = state.params.now();
  const checked = validateIpcFrame(frame);
  if (!checked.ok) {
    countClientRefusal(state, 'invalid', checked.reason);
    return;
  }
  if (state.registered) {
    dispatchClientFrame(state, frame);
    return;
  }
  handleHandshake(state, frame);
}

function handleHandshake(state, frame) {
  if (frame.type !== 'welcome') {
    countClientRefusal(state, 'invalid', `握手期收到 ${String(frame.type)}`);
    return;
  }
  if (frame.ok === false) {
    const error = errorWithCode(frame.code, frame.message ?? 'IPC 注册被拒绝');
    /* version 拒绝帧携带的核心 ipcV 透传为 coreV：换代判定的方向输入（设计 §5.1 行四/行五）——
     * 桥侧不另开探测通道；其余拒绝码无此字段（认证面不泄漏差异）。 */
    if (frame.v !== undefined) {
      error.coreV = frame.v;
    }
    settleConnect(state, { error });
    return;
  }
  state.registered = true;
  state.view.registered = true;
  state.view.welcome = frame;
  clearTimeout(state.handshakeTimer);
  state.handshakeTimer = null;
  state.timer = setInterval(() => tickClient(state), state.params.pingIntervalMs);
  state.timer.unref?.();
  settleConnect(state, { welcome: frame });
}

/* 注册后分发：ping 自动回 pong；pong 只刷新存活；result/push/core-restarting 交上层。 */
function dispatchClientFrame(state, frame) {
  if (!CLIENT_INBOUND_TYPES.has(frame.type)) {
    countClientRefusal(state, 'invalid', `方向不符：${String(frame.type)}`);
    return;
  }
  if (frame.type === 'ping') {
    sendToCore(state, { type: 'pong' });
    return;
  }
  if (frame.type === 'pong') {
    return;
  }
  state.onFrame?.(frame);
}

function tickClient(state) {
  if (state.params.now() - state.lastFrameAt > state.params.peerTimeoutMs) {
    state.view.stuckPeers++;
    state.closeReason = 'stuck';
    state.log?.warn?.('IPC 核心卡死（超时无任何帧）');
    state.onStuck?.();
    state.socket?.destroy();
    return;
  }
  sendToCore(state, { type: 'ping' });
}

function sendToCore(state, frame) {
  const socket = state.socket;
  if (socket === null || socket.destroyed) {
    return false;
  }
  socket.write(encodeIpcFrame(frame));
  return true;
}

function countClientRefusal(state, kind, detail) {
  state.view.refusedFrames++;
  if (kind === 'oversize') {
    state.view.oversizeFrames++;
  } else if (kind === 'malformed') {
    state.view.malformedFrames++;
  } else {
    state.view.invalidFrames++;
  }
  state.log?.warn?.('IPC 拒帧', { kind, detail });
}

function onClientClose(state) {
  if (state.timer !== null) {
    clearInterval(state.timer);
    state.timer = null;
  }
  clearTimeout(state.dialTimer);
  clearTimeout(state.handshakeTimer);
  state.dialTimer = null;
  state.handshakeTimer = null;
  if (state.settle !== null) {
    failConnect(state, state.dialError?.code ?? 'closed', 'IPC 连接在握手完成前关闭');
    return;
  }
  if (state.registered) {
    state.onClose?.({ reason: state.closeReason });
  }
}

function settleConnect(state, outcome) {
  const settle = state.settle;
  if (settle === null) {
    return;
  }
  state.settle = null;
  clearTimeout(state.dialTimer);
  clearTimeout(state.handshakeTimer);
  state.dialTimer = null;
  state.handshakeTimer = null;
  if (outcome.welcome !== undefined) {
    settle.resolve(outcome.welcome);
    return;
  }
  state.closeReason = 'client';
  state.socket?.destroy();
  settle.reject(outcome.error);
}

function failConnect(state, code, message) {
  if (state.settle === null) {
    return;
  }
  settleConnect(state, { error: errorWithCode(state.dialError?.code ?? code, message) });
}

async function closeClient(state) {
  state.closeReason = 'client';
  clearTimeout(state.dialTimer);
  clearTimeout(state.handshakeTimer);
  state.dialTimer = null;
  state.handshakeTimer = null;
  if (state.timer !== null) {
    clearInterval(state.timer);
    state.timer = null;
  }
  if (state.socket !== null && !state.socket.destroyed) {
    const socket = state.socket;
    await new Promise((resolve) => {
      socket.once('close', resolve);
      socket.destroy();
    });
  }
}
