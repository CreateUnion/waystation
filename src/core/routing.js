import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ID_PATTERN } from '../net/protocol.js';
import { MAX_TAKEOVER_WINDOW_MS } from '../config.js';
import { bindingsFilePath } from '../paths.js';
import { writeJsonAtomic } from '../storage.js';
import { renderSessionMessage } from '../adapters/claude-code.js';
import { ensureRunDir } from './ipc.js';

/* 注入路由（设计 §4 全要素）：绑定表（run/bindings.json）与两条注入决策链。
 * 链一（入站帧）：绑定查询 → 桥在线则 push（文本在核心渲染，桥不渲染不解析）→ 等待 delivered
 * 回执（期限 2s，超时按未注入处置）；绑定休眠到此为止、其余无绑定帧不投（数据已落盘、
 * 发送侧维持第二档）。无绑定邀请例外（首邀到达时绑定表尚无该条目，而其是本机待办——
 * 受邀请方据此走同意门）：投当前全部活跃桥，仍不写绑定。
 * 链二（本机提示）：调用者相关（工具调用触发）投调用者桥——调用身份经 AsyncLocalStorage 随
 * 调用链外置，无需把 context 逐层穿过协作服务；定时器/入站类按绑定路由，休眠/无绑定丢弃＋留痕。
 * 判定口径（写死）：活跃 = 绑定的 sessionId 在当前注册桥集合内；休眠是派生状态（不落盘）——
 * 桥退场即休眠、原会话重连即活跃；绑定里的 bridgeId 只作入席出处记录。
 * adopt：写类调用来自活跃会话而绑定休眠/空 → 夺席（判定先于工具 handler）；绑定活跃且异会话
 * → 不夺席＋响应附 notice 指引；纯读类与敲门（ws_request_join）一律不改绑定。
 * 本模块不 import 桥组件与网络收发面（注册表与 IPC 发送面由组合根 attach 注入），
 * 渲染复用适配器的 renderSessionMessage（核心渲染面单一权威）。 */

export const PUSH_RECEIPT_TIMEOUT_MS = 2000;

/* 核心侧工具执行安全期限（§2.4「每桥每连接等待均带期限」的执行面落地）：只兜「handler 永不收口」
 * 的缺陷形态——期限到以明确错误回报，不让桥侧 MCP 调用永久挂起（操作可能仍在后台继续，由只读
 * 工具核实）。取值依据＝**大于全部合法长等待上界＋余量**：全部 handler 阻塞路径中，最长者为
 * 抢接收集窗口（takeoverWindowMs——collect 形态的 ws_take_over 阻塞全窗，见
 * collab/takeover.js:410,476-486；次长者 dialTimeoutMs 上界 120000ms，其余移交 5s／对表 5s／
 * 快照 3s 均短）。**期限自上界具名常量派生**（上界＝config.MAX_TAKEOVER_WINDOW_MS 单一权威；
 * 余量＝探测节律／移交／调度余隙）——上界调整时期限自动跟随，耦合由测试看护。 */
export const CALL_DEADLINE_MARGIN_MS = 60000;
export const CALL_SAFETY_DEADLINE_MS = MAX_TAKEOVER_WINDOW_MS + CALL_DEADLINE_MARGIN_MS;

/* 写类（可夺席）与纯读类词表（设计 §4.1 写死）：其余工具既不入席也不夺席——
 * ws_create_collab / ws_approve_invite 走各写入点，ws_request_join 敲门有网络副作用但不入席。 */
const WRITE_CLASS_TOOLS = new Set([
  'ws_send_message', 'ws_set_mute', 'ws_decide', 'ws_handover', 'ws_take_over',
  'ws_invite', 'ws_withdraw_invite', 'ws_end_collab', 'ws_leave_collab',
]);
const READ_CLASS_TOOLS = new Set([
  'ws_status', 'ws_list_collabs', 'ws_list_hosts', 'ws_ping', 'ws_view_ledger', 'ws_check_inbox', 'ws_delivery_status',
]);

/** 工具归类：write（可夺席）/ read（不改绑定）/ none（既不夺席也不改绑定）。 */
export function classifyTool(name) {
  if (WRITE_CLASS_TOOLS.has(name)) {
    return 'write';
  }
  return READ_CLASS_TOOLS.has(name) ? 'read' : 'none';
}

/* 绑定活跃时的跨会话写类调用指引（设计 §4.1 文案）——可达路径＝关掉/退出原会话后由休眠态夺席。 */
export const ADOPT_GUIDANCE_NOTICE = '该协作的注入绑定于另一会话；如需本会话接收，请让该会话退出协作或关闭';
/* 调用者相关提示的归属说明（链二①）：摘要投本会话，但该协作的持续注入归另一会话。 */
export const ATTRIBUTION_NOTICE = '本协作的实时注入绑定于另一会话——本次调用触发的提示仅投本会话';
/* 无会话标识的桥（env 缺 CLAUDE_CODE_SESSION_ID）：绑定/注入/夺席语义全部不可用——在写类与
 * 入席类调用（create/approve）的成功响应里如实说明（同一 notice 机制），不静默降级。 */
export const SESSIONLESS_NOTICE = '本会话无会话标识（CLAUDE_CODE_SESSION_ID 缺失）——无法登记注入绑定，本会话收不到该协作的实时注入；请重开会话或检查客户端环境';

/* 绑定条目的入席出处（写点枚举）。 */
const BINDING_ORIGINS = ['create', 'join', 'adopt'];
/* 丢弃留痕的首行摘要截断（日志可读性；完整文案在帧里，日志只作定位）。 */
const DROP_HEAD_MAX = 120;

function isCollabId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function collabIdOf(args) {
  const value = args?.collabId;
  return isCollabId(value) ? value : null;
}

/* —— 绑定表（run/bindings.json；原子替换、核心单写者） —— */

/**
 * @param {{ dataDir: string, log: any }} options
 */
export function createBindingStore({ dataDir, log }) {
  const state = {
    dataDir,
    log,
    bindings: new Map(),
    counters: { entries: 0, loaded: 0, droppedEntries: 0, corruptLoads: 0, persists: 0, persistFailures: 0 },
  };
  return {
    load: () => loadBindings(state),
    get: (collabId) => state.bindings.get(collabId) ?? null,
    entries: () => [...state.bindings.entries()],
    set(collabId, binding) {
      state.bindings.set(collabId, binding);
      return persistBindings(state);
    },
    remove(collabId) {
      if (!state.bindings.has(collabId)) {
        return false;
      }
      state.bindings.delete(collabId);
      persistBindings(state);
      return true;
    },
    stats: () => ({ ...state.counters, size: state.bindings.size }),
  };
}

/* 加载与恢复比对（设计 §4.1）：只做载入——「活跃/休眠」由注册表实时派生，不落盘不比对快照，
 * 故桥退场即休眠、原会话重连即活跃，无需恢复写回。损坏文件按空表继续（绑定是路由态，
 * 丢它只是不再注入；不阻塞启动、不抛错）。 */
function loadBindings(state) {
  const text = readBindingsText(state);
  if (text === null) {
    return;
  }
  const parsed = parseJsonOrNull(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    traceCorruptBindings(state, '形态不符');
    return;
  }
  for (const [collabId, binding] of Object.entries(parsed)) {
    if (!isCollabId(collabId) || !isBindingShape(binding)) {
      state.counters.droppedEntries++;
      state.log.warn('绑定条目形态不符（丢弃该条）', { collabId });
      continue;
    }
    state.bindings.set(collabId, normalizeBinding(binding));
    state.counters.loaded++;
  }
}

function readBindingsText(state) {
  try {
    return readFileSync(bindingsFilePath(state.dataDir), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      traceCorruptBindings(state, error.message);
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

function traceCorruptBindings(state, reason) {
  state.counters.corruptLoads++;
  state.log.warn('绑定表不可用（按空表继续——仅影响注入路由，数据面不受影响）', { reason });
}

function isBindingShape(binding) {
  return binding !== null
    && typeof binding === 'object'
    && !Array.isArray(binding)
    && isCollabId(binding.sessionId)
    && isCollabId(binding.bridgeId)
    && typeof binding.boundAt === 'string'
    && BINDING_ORIGINS.includes(binding.origin);
}

/* 只取契约四字段（额外字段不随内存态扩散；顺带剔除原型链上的杂项）。 */
function normalizeBinding(binding) {
  return { sessionId: binding.sessionId, bridgeId: binding.bridgeId, boundAt: binding.boundAt, origin: binding.origin };
}

function persistBindings(state) {
  try {
    ensureRunDir(state.dataDir, { log: state.log });
    writeJsonAtomic(bindingsFilePath(state.dataDir), Object.fromEntries(state.bindings));
    state.counters.persists++;
    return true;
  } catch (error) {
    state.counters.persistFailures++;
    state.log.warn('绑定表写入失败（内存态继续——重启后该次入席丢失）', { reason: error.message });
    return false;
  }
}

/* —— 活跃判定与目标解析 —— */

/** 绑定是否活跃：绑定的会话有在线桥（sessionId 为身份，bridgeId 只作出处记录——
 * 原会话重连（新 bridgeId）依旧活跃，注入投向其当前连接）。 */
export function bindingIsActive(binding, registry) {
  if (binding === null || !isCollabId(binding?.sessionId)) {
    return false;
  }
  const entry = registry?.find?.(binding.sessionId);
  return entry !== undefined && entry !== null;
}

/* 链一/链二②的目标解析：无绑定或绑定休眠 → null（不注入）。 */
function entryForCollab(state, collabId) {
  if (!isCollabId(collabId) || state.registry === null || state.ipc === null) {
    return null;
  }
  const binding = state.bindings.get(collabId);
  if (binding === null) {
    return null;
  }
  return state.registry.find(binding.sessionId) ?? null;
}

/* 链二①的目标解析：调用者桥（按 bridgeId 精确命中——调用在途，调用者必在线）。 */
function entryForBridge(state, bridgeId) {
  if (state.registry === null || state.ipc === null) {
    return null;
  }
  return state.registry.list().find((entry) => entry.bridgeId === bridgeId) ?? null;
}

/* JSON 对象判定（结果载荷与载荷解析共用）：null / 数组 / 非对象一律不合。 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/* 结果载荷解析（写点判据：MCP 成功结果的第一段文本必为 JSON 对象；isError / 非 JSON 一律 null）。 */
function okPayloadOf(result) {
  const parsed = jsonObjectOf(result);
  return parsed !== null && parsed.ok === true ? parsed : null;
}

/* MCP 结果第一段文本的 JSON 对象（notice 附加与写点判据共用的解析面）。 */
function jsonObjectOf(result) {
  if (!isPlainObject(result) || result.isError === true) {
    return null;
  }
  const text = result.content?.[0]?.text;
  if (typeof text !== 'string') {
    return null;
  }
  const parsed = parseJsonOrNull(text);
  return isPlainObject(parsed) ? parsed : null;
}

/** notice 附加（不改 schema：复用安静默认的 notice 字段先例）：只改 JSON 对象载荷的
 * 成功结果；与既有 notice 并置（互不覆盖）。解析不出即原样返回——notice 是附属面，不得弄坏主结果。 */
export function attachNotice(result, notices) {
  if (!Array.isArray(notices) || notices.length === 0) {
    return result;
  }
  const payload = jsonObjectOf(result);
  const first = result?.content?.[0];
  if (payload === null || first?.type !== 'text') {
    return result;
  }
  const notice = notices.join('；');
  const merged = typeof payload.notice === 'string' && payload.notice !== '' ? `${payload.notice}；${notice}` : notice;
  return { ...result, content: [{ ...first, text: JSON.stringify({ ...payload, notice: merged }, null, 2) }, ...result.content.slice(1)] };
}

/* —— push 派发与回执等待面 —— */

/* 每条 push 独立等待面（上限 2s）：超时＝按未注入处置（不记「已注入」标记、不发第三档），
 * 该桥计不健康；帧链彼此独立——单桥卡顿只拖慢它自己的等待，不阻断其他桥/其他连接。 */
function createPusher(state) {
  return {
    push: (record, payload) => pushOf(state, record, payload),
    settle: (frame) => settleOf(state, frame),
  };
}

function pushOf(state, record, { text, collabId, frameType }) {
  const pushId = randomUUID();
  const frame = { type: 'push', pushId, text, collabId, frameType };
  const receipt = new Promise((resolve) => {
    const timer = setTimeout(() => {
      state.pending.delete(pushId);
      noteUnhealthy(state, record?.bridgeId);
      state.counters.receiptTimeouts++;
      state.log.warn('push 回执超时（按未注入处置）', { bridgeId: record?.bridgeId, collabId, timeoutMs: state.timeoutMs });
      resolve(false);
    }, state.timeoutMs);
    state.pending.set(pushId, { resolve, timer });
  });
  if (state.ipc.send(record, frame) === true) {
    state.counters.pushesSent++;
    return receipt;
  }
  dropPending(state, pushId);
  state.counters.pushSendFailures++;
  state.log.warn('push 发送失败（连接已关闭——按未注入处置）', { bridgeId: record?.bridgeId, collabId });
  return Promise.resolve(false);
}

function dropPending(state, pushId) {
  const held = state.pending.get(pushId);
  if (held !== undefined) {
    clearTimeout(held.timer);
    state.pending.delete(pushId);
    held.resolve(false);
  }
}

function settleOf(state, frame) {
  const held = state.pending.get(frame?.pushId);
  if (held === undefined) {
    state.counters.receiptsUnmatched++;
    return false;
  }
  clearTimeout(held.timer);
  state.pending.delete(frame.pushId);
  const ok = frame.ok === true;
  if (ok) {
    state.counters.receiptsOk++;
  } else {
    state.counters.receiptsFailed++;
  }
  held.resolve(ok);
  return true;
}

/* 不健康计数（观测面）：按桥累计；表有界（插入序淘汰）——bridgeId 每连接新 UUID，
 * 无界累加会让长驻核心的观测面自增长。 */
const UNHEALTHY_BRIDGES_MAX = 64;

function noteUnhealthy(state, bridgeId) {
  const count = (state.unhealthy.get(bridgeId) ?? 0) + 1;
  state.unhealthy.delete(bridgeId);
  state.unhealthy.set(bridgeId, count);
  while (state.unhealthy.size > UNHEALTHY_BRIDGES_MAX) {
    state.unhealthy.delete(state.unhealthy.keys().next().value);
  }
}

/* —— 组合面 —— */

/**
 * @param {{ dataDir: string, log: any, describeCollab?: ((collabId: string) => any) | null,
 *   receiptTimeoutMs?: number, callTimeoutMs?: number, now?: () => number }} options
 */
export function createInjectionRouter({ dataDir, log, describeCollab = null, receiptTimeoutMs = PUSH_RECEIPT_TIMEOUT_MS, callTimeoutMs = CALL_SAFETY_DEADLINE_MS, now = Date.now }) {
  const state = {
    dataDir,
    log,
    describeCollab,
    timeoutMs: receiptTimeoutMs,
    callTimeoutMs,
    clock: now,
    bindings: createBindingStore({ dataDir, log }),
    registry: null,
    ipc: null,
    pending: new Map(),
    unhealthy: new Map(),
    callContext: new AsyncLocalStorage(),
    droppedNotices: 0,
    counters: {
      adoptions: 0, inboundPushed: 0, inboundUnrouted: 0, inboundFailed: 0,
      notifyCaller: 0, notifyBound: 0, notifyDropped: 0, renderFailures: 0,
      callFailures: 0, callTimeouts: 0, callLateResults: 0,
      pushesSent: 0, pushSendFailures: 0, receiptTimeouts: 0,
      receiptsOk: 0, receiptsFailed: 0, receiptsUnmatched: 0,
    },
  };
  const pusher = createPusher(state);
  return routerApiOf(state, pusher);
}

function routerApiOf(state, pusher) {
  return {
    bindings: state.bindings,
    load: () => state.bindings.load(),
    attach({ registry, ipc }) {
      state.registry = registry ?? null;
      state.ipc = ipc ?? null;
    },
    applyAdopt: (input) => applyAdoptOf(state, input),
    applyWritePoint: (input) => applyWritePointOf(state, input),
    runCall: (caller, fn) => runCallOf(state, caller, fn),
    handleCall: (frame, record, options) => handleCallOf(state, frame, record, options),
    deliverToSession: (frame) => deliverOf(state, frame, pusher),
    notify: (frame) => notifyOf(state, frame, pusher),
    settleDelivered: (frame) => pusher.settle(frame),
    stats: () => ({
      ...state.counters,
      droppedNotices: state.droppedNotices,
      pendingPushes: state.pending.size,
      unhealthy: Object.fromEntries(state.unhealthy),
      bindings: state.bindings.stats(),
    }),
  };
}

/* adopt 判定（设计 §4.1，先于工具 handler 调用）：写类 + collabId + 绑定休眠/空 → 夺席；
 * 绑定活跃且异会话 → 不夺席＋notice 指引；同会话/无 collabId/非写类 → 原样。
 * 无会话标识的调用者不入席（绑定以 sessionId 为身份，无从记录）。 */
function applyAdoptOf(state, { tool, args, caller, now = null }) {
  if (classifyTool(tool) !== 'write') {
    return noAdopt();
  }
  const collabId = collabIdOf(args);
  if (collabId === null) {
    return noAdopt();
  }
  const sessionId = caller?.sessionId ?? null;
  const held = state.bindings.get(collabId);
  if (!bindableCaller(sessionId, caller)) {
    return noAdopt();   // 无会话标识的桥本就不入席：指引文案对它不成立（另经 SESSIONLESS_NOTICE 说明）
  }
  if (bindingIsActive(held, state.registry)) {
    return held.sessionId === sessionId ? noAdopt() : { adopted: false, notice: ADOPT_GUIDANCE_NOTICE };
  }
  const boundAt = new Date(now ?? state.clock()).toISOString();
  state.bindings.set(collabId, { sessionId, bridgeId: caller.bridgeId, boundAt, origin: 'adopt' });
  state.counters.adoptions++;
  state.log.info('写类调用夺席（绑定休眠或空）', { collabId, sessionId, bridgeId: caller.bridgeId });
  return { adopted: true, notice: null };
}

/* 可入席的调用者（绑定以 sessionId 为身份、bridgeId 作出处）：无会话标识的桥不入席。 */
function bindableCaller(sessionId, caller) {
  return isCollabId(sessionId) && isCollabId(caller?.bridgeId);
}

function noAdopt() {
  return { adopted: false, notice: null };
}

/* 无会话标识桥的可见性：写类调用与入席类调用（create/approve）的成功响应附一条说明
 * （绑定语义对它们整体不可用——静默降级改为如实告知）。只读类不附（避免每次调用噪声）。 */
function sessionlessNoticeOf(tool, caller) {
  if (isCollabId(caller?.sessionId)) {
    return null;
  }
  return classifyTool(tool) === 'write' || tool === 'ws_create_collab' || tool === 'ws_approve_invite' ? SESSIONLESS_NOTICE : null;
}

/* 写点（设计 §4.1：create/join/adopt/leave/end；本函数只做 handler 之后的四个）：
 * create 与 join 的成功结果把绑定写给调用会话；leave/end 成功删条目。
 * 失败结果（isError / ok:false）一律不改绑定——写点以「成功」为前件。 */
function applyWritePointOf(state, { tool, args, caller, result, now = null }) {
  const payload = okPayloadOf(result);
  if (payload === null) {
    return false;
  }
  if (tool === 'ws_create_collab') {
    return bindEntry(state, payload.collabId, 'create', caller, now);
  }
  if (tool === 'ws_approve_invite') {
    return payload.decision === 'approved' ? bindEntry(state, collabIdOf(args), 'join', caller, now) : false;
  }
  if (tool === 'ws_leave_collab' || tool === 'ws_end_collab') {
    const collabId = collabIdOf(args);
    return collabId === null ? false : state.bindings.remove(collabId);
  }
  return false;
}

function bindEntry(state, collabId, origin, caller, now = null) {
  if (!isCollabId(collabId)) {
    return false;
  }
  const sessionId = caller?.sessionId ?? null;
  if (!bindableCaller(sessionId, caller)) {
    state.log.warn('调用者无会话标识——不写绑定（该会话收不到该协作注入）', { collabId, origin });
    return false;
  }
  const boundAt = new Date(now ?? state.clock()).toISOString();
  state.bindings.set(collabId, { sessionId, bridgeId: caller.bridgeId, boundAt, origin });
  return true;
}

/* 调用链上下文（链二①的归属判据）：调用身份经 AsyncLocalStorage 随调用链外置——
 * 协作服务在任意深度触发的 notify 都能归因到「谁在动手」，且并发调用互不串扰
 * （全局变量式「当前调用者」会在两桥并发 handler 交错时错归）。
 * 分类判据＝「handler 在飞」（active 标志），不是「上下文存在」：ALS 会被 handler 内安排的
 * 定时器/微任务继承，若按存在性归类，抢接窗口结束等**定时器链**提示会误投调用者桥
 * （调用返回后仍投 B、调用者桥下线即丢）——置 false 后走链二②按绑定路由，与「定时器类按绑定」
 * 同口径。 */
function runCallOf(state, caller, fn) {
  const context = {
    bridgeId: caller?.bridgeId ?? null,
    sessionId: caller?.sessionId ?? null,
    notices: Array.isArray(caller?.notices) ? caller.notices : [],
    active: true,
  };
  try {
    return closeAfter(context, state.callContext.run(context, fn));
  } catch (error) {
    context.active = false;
    throw error;
  }
}

/* handler 结束即置 active=false（同步返回与 promise 收口两条路径同置）：此后由该调用链
 * 继承上下文的后继触发（定时器/微任务）归链二②按绑定路由。 */
function closeAfter(context, result) {
  if (result !== null && typeof result?.then === 'function') {
    return result.then(
      (value) => {
        context.active = false;
        return value;
      },
      (error) => {
        context.active = false;
        throw error;
      },
    );
  }
  context.active = false;
  return result;
}

/* call 帧执行面（桥 e2e 的解锁面——未接时 call 帧被静默丢弃）：adopt 判定先于 handler → handler（per-request context
 * 带调用者身份，执行带安全期限）→ 写点 → notice 附加 → result 帧。**每次 call 必回恰一帧 result**
 * （正常/未知工具/isError/异常/期限全路径）——桥侧在途调用由此不会永久挂起。 */
async function handleCallOf(state, frame, record, options) {
  const caller = { bridgeId: record?.bridgeId ?? null, sessionId: record?.sessionId ?? null };
  const guidance = applyAdoptOf(state, { tool: frame.tool, args: frame.args, caller });
  const call = { ...caller, notices: [] };
  const context = { ...options.baseContext, bridgeId: caller.bridgeId, sessionId: caller.sessionId };
  const outcome = await callWithDeadline(state, frame.tool, () => runCallOf(state, call, () => options.tools.call(frame.tool, frame.args, context)));
  if (outcome.timedOut) {
    sendResultOf(state, record, frame.id, timeoutResultOf(state));
    return;
  }
  applyWritePointOf(state, { tool: frame.tool, args: frame.args, caller, result: outcome.result });
  const notices = [guidance.notice, sessionlessNoticeOf(frame.tool, caller), ...call.notices].filter((entry) => entry !== null);
  sendResultOf(state, record, frame.id, attachNotice(outcome.result, notices));
}

/* 期限竞速：先到者定局（handler 结果 / 同步抛错 / 异常 / 期限）；期限后到达的晚结果丢弃不再发帧
 * （同 id 不得有第二帧 result）。handler 异常本由 registry 兜底为 isError，此处的兜底防一切
 * 消费者形态（同步抛出的执行器同样收口为 isError 结果——「必回一帧 result」不因注册表形态破例）。 */
function callWithDeadline(state, tool, execute) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      state.counters.callTimeouts++;
      state.log.warn('工具执行超出核心侧安全期限（按超时回报，不无限挂）', { tool, timeoutMs: state.callTimeoutMs });
      resolve({ timedOut: true });
    }, state.callTimeoutMs);
    timer.unref?.();
    const finish = (outcome) => {
      if (settled) {
        state.counters.callLateResults++;
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const failed = (error) => {
      if (settled) {
        state.counters.callLateResults++;   // 超时/已定局后的晚到失败：不再重复归因（避免「又是超时又是失败」的噪声）
        return;
      }
      state.counters.callFailures++;
      state.log.error('工具调用执行面异常（已隔离）', { tool, reason: error?.message });
      finish({ timedOut: false, result: { content: [{ type: 'text', text: `工具执行面异常：${error?.message ?? '未知原因'}` }], isError: true } });
    };
    try {
      Promise.resolve(execute()).then((result) => finish({ timedOut: false, result }), failed);
    } catch (error) {
      failed(error);
    }
  });
}

function timeoutResultOf(state) {
  const seconds = Math.round(state.callTimeoutMs / 1000);
  return {
    content: [{ type: 'text', text: `工具执行超时（核心侧安全期限 ${seconds}s）：本次调用不再等待——该操作可能仍在后台继续，请稍后用只读工具（ws_status / ws_list_collabs）核实状态` }],
    isError: true,
  };
}

function sendResultOf(state, record, id, result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const frame = { type: 'result', id, content };
  if (result?.isError === true) {
    frame.isError = true;
  }
  if (state.ipc?.send(record, frame) !== true) {
    state.log.warn('result 帧发送失败（连接已关闭）', { tool: id });
  }
}

/* —— 链一：入站帧 —— */

/* 无绑定首邀判定（专属兜底分支的前件）：绑定表无该条目——「无条目」与「条目休眠」必须分开看，
 * 后者照旧不投（该协作已有席位，由持席会话处置）。未 attach（无注册表/发送面）不构成本支
 * 前件：落回原路径按未投处置。 */
function isUnboundInvite(state, frame) {
  return frame?.type === 'invite'
    && isCollabId(frame.collabId)
    && state.bindings.get(frame.collabId) === null
    && state.registry !== null
    && state.ipc !== null;
}

/* 无绑定邀请的机器级兜底：邀请是本机待办（受邀请方据此走同意门），首邀到达时绑定表却尚无该
 * 条目（写点只有 create/join/adopt）——投给当前全部活跃注册桥。同机多窗口＝同一参与者，该由
 * 哪个窗口处理由人决定，故不猜接收者、全部投；各桥并发推送、独立回执期限，单桥失败不阻断
 * 其余。不写绑定：席位仍只由 create/join/adopt 写点建立（邀请到达不是入席）。
 * 零活跃桥＝挂起照旧（不投、计未投）——数据已落盘，工具与观察窗照常可拉。 */
async function deliverInviteBroadcastOf(state, frame, pusher) {
  const targets = state.registry.list();
  if (targets.length === 0) {
    state.counters.inboundUnrouted++;
    return false;
  }
  const text = renderTextOf(state, frame);
  if (text === null) {
    state.counters.inboundUnrouted++;
    return false;
  }
  const outcomes = await Promise.all(targets.map((entry) => pusher.push(entry.record, { text, collabId: frame.collabId, frameType: frame.type })));
  const ok = outcomes.includes(true);
  if (ok) {
    state.counters.inboundPushed++;
  } else {
    state.counters.inboundFailed++;
  }
  return ok;
}

async function deliverOf(state, frame, pusher) {
  const entry = entryForCollab(state, frame?.collabId);
  if (entry === null && isUnboundInvite(state, frame)) {
    return deliverInviteBroadcastOf(state, frame, pusher);
  }
  const text = entry === null ? null : renderTextOf(state, frame);
  if (entry === null || text === null) {
    state.counters.inboundUnrouted++;
    return false;
  }
  const ok = await pusher.push(entry.record, { text, collabId: frame.collabId, frameType: frame.type });
  if (ok) {
    state.counters.inboundPushed++;
  } else {
    state.counters.inboundFailed++;
  }
  return ok;
}

/* —— 链二：本机提示 —— */

/* 返回 false = 该提示无接收者（join-ack 判据的落点：调用方据此「不回 ack」）；
 * 返回 true = 已投出（或已交给等待面）。异常不抛出以外的返回值契约见 outgoing.notifyLocal。 */
function notifyOf(state, frame, pusher) {
  const text = renderTextOf(state, frame);
  if (text === null || !isCollabId(frame?.collabId)) {
    return dropNoticeOf(state, frame, text, '帧形态不全');
  }
  const caller = state.callContext.getStore();
  if (caller?.active === true) {
    return notifyCallerOf(state, frame, text, caller, pusher);
  }
  const entry = entryForCollab(state, frame.collabId);
  if (entry === null) {
    return dropNoticeOf(state, frame, text, '无活跃绑定会话');
  }
  void pusher.push(entry.record, { text, collabId: frame.collabId, frameType: frame.type });
  state.counters.notifyBound++;
  return true;
}

/* 链二①：投调用者桥；调用者非该协作绑定会话时把归属说明记进本次调用回报（附 C 同口径：
 * 「调用者本就在活跃，休眠判定不适用」——投递面不看绑定，只在回报里说明归属）。 */
function notifyCallerOf(state, frame, text, caller, pusher) {
  const entry = entryForBridge(state, caller.bridgeId);
  if (entry === null) {
    return dropNoticeOf(state, frame, text, '调用者桥不在线');
  }
  const binding = state.bindings.get(frame.collabId);
  if ((binding === null || binding.sessionId !== caller.sessionId) && !caller.notices.includes(ATTRIBUTION_NOTICE)) {
    caller.notices.push(ATTRIBUTION_NOTICE);
  }
  void pusher.push(entry.record, { text, collabId: frame.collabId, frameType: frame.type });
  state.counters.notifyCaller++;
  return true;
}

/* 休眠/无绑定丢弃必须留痕（设计 §4.2-b）：累计条数＋首行摘要——提示本就不落盘不上网络，
 * 静默消失会让「明明收到敲门却没人放行」无从排查。摘要取原始提示文本（渲染前）——
 * 渲染文本的首行是上下文头（身份与时间戳），对定位「丢了哪条」没有信息量。 */
function dropNoticeOf(state, frame, text, reason) {
  state.droppedNotices++;
  state.counters.notifyDropped++;
  const raw = typeof frame?.payload?.text === 'string' && frame.payload.text !== '' ? frame.payload.text : text;
  const head = typeof raw === 'string' && raw !== '' ? raw.split('\n')[0].slice(0, DROP_HEAD_MAX) : '(无渲染文本)';
  state.log.warn('本机提示丢弃（不可投——留痕）', { collabId: frame?.collabId ?? null, reason, dropped: state.droppedNotices, head });
  return false;
}

/* 核心渲染（设计 §2.2：渲染归核心，桥不渲染不解析）。渲染失败只丢该条（附属面不得弄坏主链）。 */
function renderTextOf(state, frame) {
  try {
    const text = renderSessionMessage(frame, { describeCollab: state.describeCollab });
    return typeof text === 'string' && text !== '' ? text : null;
  } catch (error) {
    state.counters.renderFailures++;
    state.log.warn('注入文本渲染失败（丢弃该条）', { type: frame?.type, reason: error?.message });
    return null;
  }
}
