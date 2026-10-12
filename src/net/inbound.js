import { collabDir, collabFilePath, ensureDir } from '../paths.js';
import { appendLine, loadLines } from '../storage.js';
import { PROTOCOL_VERSION, newMsgId } from './protocol.js';

export const INBOX_FILE_NAME = 'inbox.jsonl';

/* 可注入钩子的形状（全部可选，缺省即安全默认）：类型注解为类型检查服务——缺省值 {} 与属性访问需要明确形状。 */
/** @typedef {{ admit?: (frame: object) => { ok: boolean, reason?: string } | null | undefined, consume?: (frame: object) => unknown, deliverToSession?: (frame: object) => unknown }} InboundHooks */

/* 接收管线（设计 §10）：帧的类型路由（四类）——
 * ① 协作域（含治理类）：准入 → 幂等去重 → 落盘 → ack → 钩子 → 投递成功后回报；
 * ② delivery-status（投递回报）：应用（更新本方发送队列档位，幂等）→ 回 ack → 结束；
 *    不落盘 inbox、不投会话、不产生针对回报的回报——ack 是链路确认、是递归的终端。
 *    回报必须以 ack 收敛，否则发送方该「协作 × 对端」单元的队头永占、后续消息永久阻塞；
 * ③ ping/pong：请求/应答，不落盘不 ack；④ ack：链路确认终端，无任何响应。
 * 顺序语义：本层把同一连接上的帧串行化（promise 链）——发送侧按单元串行投递、接收侧按连接串行处理，
 * 「重放不乱序」由此闭合；不同连接之间互不阻塞。
 * ack 语义 = 「已到对方驿站」：先落盘再确认（确认即承诺已持久化）；准入拒绝 / 落盘失败一律不 ack，
 * 由发送侧按重试与过期收敛（设计 §10 拒绝并计数留痕，协议无 NACK）。
 * 准入与「写入会话收件箱」都是可注入钩子：协作台账与投递适配器接入前，以安全默认（拒绝 / 不投递）占位。 */
/**
 * @param {{ dataDir: string, config: any, self: any, dispatch: any, hooks?: InboundHooks, log: any }} options
 */
export function createInbound({ dataDir, config, self, dispatch, hooks = {}, log }) {
  const state = {
    dataDir,
    config,
    self,
    dispatch,
    admit: hooks.admit ?? defaultAdmit,
    consume: hooks.consume ?? noop,
    deliverToSession: hooks.deliverToSession ?? defaultDeliver,
    log,
    boxes: new Map(),       // collabId → { path, seen: Set }（懒加载：首个消息到达时才建）
    chains: new WeakMap(),  // connection → Promise（同连接串行）
    counters: emptyCounters(),
  };
  return {
    start,
    stop,
    onFrame: (connection, frame) => onFrame(state, connection, frame),
    stats: () => statsOf(state),
  };
}

function emptyCounters() {
  return {
    frames: 0,
    accepted: 0,
    duplicates: 0,
    sessionDelivered: 0,
    acksSent: 0,
    reportsSent: 0,
    pingsAnswered: 0,
    pongsUnmatched: 0,
    acksIn: 0,
    reportsIn: 0,
    persistFailures: 0,
    hookFailures: 0,
    rejected: { admission: 0 },
  };
}

function start() {}

function stop() {}

function statsOf(state) {
  return { ...state.counters, rejected: { ...state.counters.rejected }, collabs: state.boxes.size };
}

function onFrame(state, connection, frame) {
  state.counters.frames++;
  const chained = (state.chains.get(connection) ?? Promise.resolve())
    .then(() => handleFrame(state, connection, frame))
    .catch((error) => {
      state.log.error('入站帧处理异常（已隔离）', { type: frame.type, reason: error.message });
    });
  state.chains.set(connection, chained);
}

async function handleFrame(state, connection, frame) {
  if (frame.type === 'ping') {
    connection.send({ v: PROTOCOL_VERSION, type: 'pong', msgId: newMsgId(), replyTo: frame.msgId, from: state.self, ts: new Date().toISOString() });
    state.counters.pingsAnswered++;
    return;
  }
  if (frame.type === 'pong') {
    if (!state.dispatch.resolvePong(frame)) {
      state.counters.pongsUnmatched++;
    }
    return;
  }
  if (frame.type === 'ack') {
    state.counters.acksIn++;
    state.dispatch.onAck(frame.ackFor);
    return;
  }
  if (frame.type === 'delivery-status') {
    applyReport(state, connection, frame);
    return;
  }
  await handleCollabMessage(state, connection, frame);
}

/* 投递回报的处理链：应用（本方发送队列档位推进，重复回报重复应用无副作用）后回 ack。
 * 回 ack 是必需的：发送方的回报条目靠这条 ack 离开队头，否则该单元后续消息被永久阻塞；
 * ack 是递归终端——不为回报再产生回报，也不落盘 inbox、不投会话。 */
function applyReport(state, connection, frame) {
  state.counters.reportsIn++;
  state.dispatch.onDeliveryReport(frame.payload);
  // 回报一律回 ack——即使无法归属（refMsgId 未知，对端条目可能已过期）：不回会让发送方该单元队头滞留重试
  connection.send(ackFrame(state, frame.msgId));
  state.counters.acksSent++;
}

async function handleCollabMessage(state, connection, frame) {
  const admitted = state.admit(frame);
  if (admitted === null || admitted === undefined || admitted.ok !== true) {
    state.counters.rejected.admission++;
    state.log.warn('协作域消息未通过准入，拒绝（不确认）', {
      msgId: frame.msgId,
      collabId: frame.collabId,
      reason: admitted?.reason ?? '未说明',
    });
    return;
  }
  const box = boxFor(state, frame.collabId);
  if (box.seen.has(frame.msgId)) {
    state.counters.duplicates++;
    connection.send(ackFrame(state, frame.msgId));   // 重复 = 上次 ack 可能丢失：重确认、不重投
    return;
  }
  if (!persistInbound(state, box, frame)) {
    return;   // 未落盘不承诺：发送侧按重试 / 过期处理
  }
  box.seen.add(frame.msgId);
  state.counters.accepted++;
  connection.send(ackFrame(state, frame.msgId));
  state.counters.acksSent++;
  await runHook(state, state.consume, frame);
  if (await runDeliver(state, frame)) {
    state.counters.sessionDelivered++;
    sendDeliveryReport(state, frame, connection.remoteAddress);
  }
}

function ackFrame(state, ackFor) {
  return { v: PROTOCOL_VERSION, type: 'ack', msgId: newMsgId(), ackFor, from: state.self, ts: new Date().toISOString() };
}

function sendDeliveryReport(state, frame, address) {
  const result = state.dispatch.send({
    collabId: frame.collabId,
    to: { instanceId: frame.from.instanceId, address },
    type: 'delivery-status',
    payload: { refMsgId: frame.msgId, tier: 'session' },
  });
  if (result.ok) {
    state.counters.reportsSent++;
  } else {
    state.log.warn('投递回报入队失败（维持第二档）', { refMsgId: frame.msgId, reason: result.reason });
  }
}

/* 幂等去重记录 = 收件流水按保留期窗口的投影（单一权威源，无需第二份文件）：
 * 窗口外（超保留期）的同 msgId 视为新消息——与设计「去重记录落盘、保留期同队列」等价。 */
function boxFor(state, collabId) {
  let box = state.boxes.get(collabId);
  if (box !== undefined) {
    return box;
  }
  box = { path: collabFilePath(state.dataDir, collabId, INBOX_FILE_NAME), seen: new Set() };
  try {
    ensureDir(collabDir(state.dataDir, collabId));
  } catch (error) {
    state.log.error('协作目录创建失败（收件落盘将不可用）', { collabId, reason: error.message });
  }
  loadSeenWindow(state, box, collabId);
  state.boxes.set(collabId, box);
  return box;
}

/* 载入去重窗口：读取失败按「存储不可用」处理——计数 + 告警留痕后窗口置空继续，不把消息处理打成异常。
 * 窗口空窗期内重复消息可能重复投递会话（最坏影响），由会话侧的幂等消费兜底。 */
function loadSeenWindow(state, box, collabId) {
  /** @type {{ entries: unknown[], tailDropped: boolean, corruptLines: Array<{ lineNumber: number, text: string }> } | null} */
  let loaded = null;
  try {
    loaded = loadLines(box.path);
  } catch (error) {
    state.counters.persistFailures++;
    state.log.warn('收件流水读取失败（落盘失败，去重窗口置空继续）', { collabId, reason: error.message });
  }
  if (loaded === null) {
    return;
  }
  if (loaded.tailDropped || loaded.corruptLines.length > 0) {
    state.log.warn('收件流水有残缺记录，按可解析条目载入', { collabId, tailDropped: loaded.tailDropped, corruptLines: loaded.corruptLines.length });
  }
  const windowStart = Date.now() - state.config.messageTtlMs;
  for (const record of loaded.entries) {
    const msgId = freshRecordId(record, windowStart);
    if (msgId !== null) {
      box.seen.add(msgId);
    }
  }
}

/* 去重窗口口径：保留期内收到的记录参与去重（窗口外的同 msgId 视为新消息）；返回可用的 msgId。 */
function freshRecordId(record, windowStart) {
  if (typeof record !== 'object' || record === null) {
    return null;
  }
  const entry = /** @type {{ msgId?: unknown, receivedAt?: unknown }} */ (record);
  if (typeof entry.msgId !== 'string' || typeof entry.receivedAt !== 'string') {
    return null;
  }
  return Date.parse(entry.receivedAt) >= windowStart ? entry.msgId : null;
}

function persistInbound(state, box, frame) {
  try {
    appendLine(box.path, { ...frame, receivedAt: new Date().toISOString() });
    return true;
  } catch (error) {
    state.counters.persistFailures++;
    state.log.error('入站消息落盘失败（不确认，等待重投）', { msgId: frame.msgId, reason: error.message });
    return false;
  }
}

async function runHook(state, hook, frame) {
  try {
    await hook(frame);
  } catch (error) {
    state.counters.hookFailures++;
    state.log.error('接收钩子异常（已隔离）', { msgId: frame.msgId, reason: error.message });
  }
}

async function runDeliver(state, frame) {
  try {
    return (await state.deliverToSession(frame)) === true;
  } catch (error) {
    state.counters.hookFailures++;
    state.log.error('会话投递钩子异常（维持第二档）', { msgId: frame.msgId, reason: error.message });
    return false;
  }
}

/* 安全默认：协作台账接入前，任何协作域消息都没有可核对的归属——一律拒绝（设计 §10 未知 collabId 拒绝）。 */
function defaultAdmit() {
  return { ok: false, reason: '本机暂无可核对的协作台账' };
}

/* 安全默认：投递适配器接入前，消息停留在收件流水（维持第二档），待适配器或会话主动查取。 */
async function defaultDeliver() {
  return false;
}

function noop() {}
