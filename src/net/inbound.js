import { collabDir, collabFilePath, ensureDir } from '../paths.js';
import { appendLine, loadLines, replaceFile } from '../storage.js';
import { ID_PATTERN, PROTOCOL_VERSION, isPort, newMsgId } from './protocol.js';

export const INBOX_FILE_NAME = 'inbox.jsonl';

/* 收件流水压缩的行数触发阈值：自上次压缩以来的追加行数超过存活判重记录数 × 该倍率即重写文件。
 * 与发送队列同一口径——长驻进程里没有「终态事件」可等，靠行数触发才能保证文件增长有界。 */
const COMPACT_LINE_FACTOR = 2;

/* 可注入钩子的形状（全部可选，缺省即安全默认）：类型注解为类型检查服务——缺省值 {} 与属性访问需要明确形状。 */
/** @typedef {{ admit?: (frame: object, meta: { remoteAddress: string }) => { ok: boolean, reason?: string } | null | undefined | Promise<{ ok: boolean, reason?: string } | null | undefined>, consume?: (frame: object, meta: { remoteAddress: string }) => unknown, deliverToSession?: (frame: object) => unknown }} InboundHooks */

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
 * 会话注入有两条分流（见 isSessionSuppressed）：拉取两件套按类型从不注入；帖去重命中的副本
 * 由 consume 声明抑制——managed 的既有「受理帧仍注入」行为不受影响（栅栏限帖通道、不泛化）。
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
    boxes: new Map(),       // collabId → { path, seen: Map, appendsSinceCompact }（懒加载：首个消息到达时才建）
    chains: new WeakMap(),  // connection → Promise（同连接串行）
    counters: emptyCounters(),
  };
  return {
    start,
    stop,
    onFrame: (connection, frame) => onFrame(state, connection, frame),
    checkInbox: (query) => checkInbox(state, query),
    stats: () => statsOf(state),
  };
}

function emptyCounters() {
  return {
    frames: 0,
    accepted: 0,
    duplicates: 0,
    sessionDelivered: 0,
    sessionSuppressed: 0,
    acksSent: 0,
    reportsSent: 0,
    pingsAnswered: 0,
    pongsUnmatched: 0,
    acksIn: 0,
    reportsIn: 0,
    persistFailures: 0,
    hookFailures: 0,
    frameFailures: 0,
    reportFailures: 0,
    rejected: { admission: 0 },
  };
}

function start() {}

function stop() {}

function statsOf(state) {
  return { ...state.counters, rejected: { ...state.counters.rejected }, collabs: state.boxes.size, seen: seenTotal(state) };
}

/* 存活判重记录总数（跨协作求和）：窗口剪枝是否生效的直接观测量——不随进程运行时长增长即为有界。 */
function seenTotal(state) {
  let total = 0;
  for (const box of state.boxes.values()) {
    total += box.seen.size;
  }
  return total;
}

function onFrame(state, connection, frame) {
  state.counters.frames++;
  const chained = (state.chains.get(connection) ?? Promise.resolve())
    .then(() => handleFrame(state, connection, frame))
    .catch((error) => {
      /* 这条链是模块唯一的异常隔离带，它自己必须抛不出去：一旦本回调抛出，
       * 链条就以 rejected 落尾且无处理者，Node 按未处理的 rejection 终止进程——
       * 「绝不因内部错误 / 日志异常退出进程」不能停在最后一步失效。 */
      try {
        state.counters.frameFailures++;
        state.log.error('入站帧处理异常（已隔离）', { type: frame?.type, reason: error?.message });
      } catch {
        // 兜底现场已尽力：连计数与日志都失败时只剩静默——进程存活优先于留痕
      }
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
  try {
    state.dispatch.onDeliveryReport(frame.payload);
  } catch (error) {
    // 应用异常不改变 ack 的发出：ack 漏发会让发送方该单元的队头滞留重试直至过期——隔离带在此处同样要兜住
    state.counters.reportFailures++;
    state.log.warn('投递回报应用异常（已隔离，照常确认）', { refMsgId: frame.payload?.refMsgId, reason: error?.message });
  }
  // 回报一律回 ack——即使无法归属（refMsgId 未知，对端条目可能已过期）：不回会让发送方该单元队头滞留重试
  connection.send(ackFrame(state, frame.msgId));
  state.counters.acksSent++;
}

async function handleCollabMessage(state, connection, frame) {
  const meta = metaOf(connection);
  const admitted = await runAdmit(state, frame, meta);
  if (admitted === null || admitted === undefined || admitted.ok !== true) {
    state.counters.rejected.admission++;
    const reason = admitted?.reason ?? '未说明';
    /* 原因随消息文本一并输出（不止 fields）：准入拒绝是消息被整体丢弃的路径，
     * 只把原因放进字段会让「按消息文本订阅/检索日志」的通道看不到丢弃原因。 */
    state.log.warn(`协作域消息未通过准入，拒绝（不确认）：${reason}`, {
      msgId: frame.msgId,
      collabId: frame.collabId,
      reason,
    });
    return;
  }
  const box = boxFor(state, frame.collabId);
  if (isDuplicate(state, box, frame)) {
    state.counters.duplicates++;
    connection.send(ackFrame(state, frame.msgId));   // 重复 = 上次 ack 可能丢失：重确认、不重投
    state.counters.acksSent++;
    return;
  }
  const stored = persistInbound(state, box, frame);
  if (stored === null) {
    return;   // 未落盘不承诺：发送侧按重试 / 过期处理
  }
  box.seen.set(frame.msgId, { receivedAtMs: Date.now(), record: stored });
  box.appendsSinceCompact++;
  state.counters.accepted++;
  connection.send(ackFrame(state, frame.msgId));
  state.counters.acksSent++;
  compactIfDue(state, box);
  const consumed = await runHook(state, state.consume, frame, meta);
  if (await runDeliver(state, frame, consumed)) {
    state.counters.sessionDelivered++;
    sendDeliveryReport(state, frame, connection);
  }
}

/* 会话注入的分流面（讨论模式的两条机制，互不越界）：
 * ① 通道分流：拉取两件套是站间协议帧（bundle 内容经协作层落本地列表、以汇总行呈现），
 *    从不注入会话——按类型判定，与 consume 结果无关；
 * ② 去重栅栏（限帖通道、不泛化）：帖的（作者, postId）去重命中时抑制再次注入——由 consume
 *    以 { sessionDeliver: false } 显式声明（处理链的唯一知情方），本层只在该类型上采信。
 * 其余类型一律照旧注入——managed 的「受理帧（含被忽略的治理帧）仍注入」行为不变。 */
const SESSION_GATED_TYPES = new Set(['post', 'join']);
const CHANNEL_ROUTED_TYPES = new Set(['history-request', 'history-bundle']);

function isSessionSuppressed(frame, consumed) {
  if (CHANNEL_ROUTED_TYPES.has(frame.type)) {
    return true;
  }
  return SESSION_GATED_TYPES.has(frame.type) && consumed?.sessionDeliver === false;
}

/* 准入钩子包装：钩子异常一律按「未通过准入」归类——拒绝方向不变（不落盘、不 ack），
 * 但必须有准入拒绝计数与告警：真台账的缺陷会让消息全部丢弃，观测面不能同时失效。
 * 契约硬化：钩子可为同步或异步——await 承接 thenable；meta 携带连接来源地址
 * （协作端点学习与邀请限频的「来源」依据）。 */
async function runAdmit(state, frame, meta) {
  try {
    return await state.admit(frame, meta);
  } catch (error) {
    return { ok: false, reason: `准入钩子异常：${error?.message ?? '未知原因'}` };
  }
}

/* 判重检查（与载入路径同一窗口口径）：窗口内命中 = 重复；命中但已出窗 = 视为新消息。
 * 出窗记录就地剪掉，seen 存活数因此约等于「窗口内收到的消息数」，不随运行时长增长。
 * 检查与插入之间无 await（调用方在同一微任务内完成判重与落盘），并发判重不会交错。 */
function isDuplicate(state, box, frame) {
  const seen = box.seen.get(frame.msgId);
  if (seen === undefined) {
    return false;
  }
  if (Date.now() - seen.receivedAtMs < state.config.messageTtlMs) {
    return true;
  }
  box.seen.delete(frame.msgId);
  return false;
}

function ackFrame(state, ackFor) {
  return { v: PROTOCOL_VERSION, type: 'ack', msgId: newMsgId(), ackFor, from: state.self, ts: new Date().toISOString() };
}

/* 投递回报的寻址（设计 §5/§10）：回拨目标 = 原文发送方 from 的实例标识 + 端口，
 * 地址取对方拨入连接的来源地址（连接来源端口是临时端口，不可作回拨目标）。
 * from.port 缺失（旧版本发送方发来的帧）：不猜端口、不发起新拨号——尽力沿原 TCP 连接原路回执。
 * 转达副本（载荷带 originMsgId）例外：其 from 是原发者、连接来源是转达者——按 from.port 回拨
 * 必然错位（目标 = 转达者地址 × 原发者端口），错位条目还会随队列重试至 TTL；回报仅沿原连接
 * 原路（归属键 = 本跳 msgId，连接对端即本跳接收者）。写失败或连接已断只告警计数
 * （维持第二档；链接确认已在先，不受影响）。 */
function sendDeliveryReport(state, frame, connection) {
  const port = frame.from.port;
  if (isPort(port) && !isRelayedCopy(frame)) {
    const result = state.dispatch.send({
      collabId: frame.collabId,
      to: { instanceId: frame.from.instanceId, address: connection.remoteAddress, port },
      type: 'delivery-status',
      payload: { refMsgId: frame.msgId, tier: 'session' },
    });
    if (result.ok) {
      state.counters.reportsSent++;
    } else {
      state.log.warn('投递回报入队失败（维持第二档）', { refMsgId: frame.msgId, reason: result.reason });
    }
    return;
  }
  try {
    connection.send({
      v: PROTOCOL_VERSION,
      type: 'delivery-status',
      msgId: newMsgId(),
      from: state.self,
      collabId: frame.collabId,
      ts: new Date().toISOString(),
      payload: { refMsgId: frame.msgId, tier: 'session' },
    });
    state.counters.reportsSent++;
  } catch (error) {
    state.counters.reportFailures++;
    state.log.warn('投递回报原路回执失败（维持第二档）', { refMsgId: frame.msgId, reason: error.message });
  }
}

/* 转达副本判别：转达出口在载荷里带 originMsgId（原生帧没有）——回报寻址据此区分
 * 「直接接触」与「经第三方转达」。 */
function isRelayedCopy(frame) {
  return typeof frame.payload?.originMsgId === 'string' && frame.payload.originMsgId !== '';
}

/* 幂等去重记录 = 收件流水按保留期窗口的投影（单一权威源，无需第二份文件）：
 * 窗口外（超保留期）的同 msgId 视为新消息——与设计「去重记录落盘、保留期同队列」等价。
 * seen 的值就是落盘记录本身（原帧 + receivedAt）：运行期压实直接以它为重建来源，不再回读文件。 */
function boxFor(state, collabId) {
  let box = state.boxes.get(collabId);
  if (box !== undefined) {
    return box;
  }
  box = { path: collabFilePath(state.dataDir, collabId, INBOX_FILE_NAME), seen: new Map(), appendsSinceCompact: 0 };
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
 * 窗口空窗期内重复消息可能重复投递会话（最坏影响），由会话侧的幂等消费兜底。
 * 载入行数多于存活记录数（存在出窗行或不可用记录）即压实一次：文件回到窗口投影，与内存口径一致。 */
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
    const fresh = freshEntryOf(record, windowStart);
    if (fresh !== null) {
      box.seen.set(fresh.msgId, { receivedAtMs: fresh.receivedAtMs, record });
    }
  }
  if (loaded.entries.length > box.seen.size) {
    compactInbox(state, box);
  }
}

/* 去重窗口口径：保留期内收到的记录参与去重（窗口外的同 msgId 视为新消息）；
 * 返回可用的判重条目（msgId + 收到时刻），记录不可用或已出窗返回 null。 */
function freshEntryOf(record, windowStart) {
  if (typeof record !== 'object' || record === null) {
    return null;
  }
  const entry = /** @type {{ msgId?: unknown, receivedAt?: unknown }} */ (record);
  if (typeof entry.msgId !== 'string' || typeof entry.receivedAt !== 'string') {
    return null;
  }
  const receivedAtMs = Date.parse(entry.receivedAt);
  return receivedAtMs >= windowStart ? { msgId: entry.msgId, receivedAtMs } : null;
}

/* 运行期压实（对照发送队列的 prune / compact）：先按窗口剪掉过期判重记录，再按行数阈值决定是否重写文件。
 * 每次受理顺带剪枝——不引入定时器（生命周期归后续里程碑），剪枝成本随窗口内消息数走，摊还极小。
 * 未达阈值时出窗行留在文件里：整文件重写的代价只在超过阈值时付出。 */
function compactIfDue(state, box) {
  const windowStart = Date.now() - state.config.messageTtlMs;
  for (const [msgId, seen] of box.seen) {
    if (seen.receivedAtMs < windowStart) {
      box.seen.delete(msgId);
    }
  }
  if (box.appendsSinceCompact > box.seen.size * COMPACT_LINE_FACTOR) {
    compactInbox(state, box);
  }
}

/* 收件流水压实：把文件重写为「窗口内记录的投影」（存活判重记录即窗口投影，顺序 = 到达顺序）。
 * 重写失败保留原文件，追加计数不归零——下一次受理再试。 */
function compactInbox(state, box) {
  const lines = [...box.seen.values()].map((seen) => JSON.stringify(seen.record) + '\n').join('');
  try {
    replaceFile(box.path, lines);
    box.appendsSinceCompact = 0;
  } catch (error) {
    state.counters.persistFailures++;
    state.log.error('收件流水压缩失败（保留原文件）', { reason: error.message });
  }
}

/* 落盘并返回写入的记录（判重窗口与压缩重写都以它为权威副本）；失败计数留痕并返回 null。 */
function persistInbound(state, box, frame) {
  const record = { ...frame, receivedAt: new Date().toISOString() };
  try {
    appendLine(box.path, record);
    return record;
  } catch (error) {
    state.counters.persistFailures++;
    state.log.error('入站消息落盘失败（不确认，等待重投）', { msgId: frame.msgId, reason: error.message });
    return null;
  }
}

/* 钩子返回值透传（consume 的注入处置声明经它到达投递判定；异常隔离为 undefined = 保持照旧注入）。 */
async function runHook(state, hook, frame, meta) {
  try {
    return await hook(frame, meta);
  } catch (error) {
    state.counters.hookFailures++;
    state.log.error('接收钩子异常（已隔离）', { msgId: frame.msgId, reason: error.message });
    return undefined;
  }
}

async function runDeliver(state, frame, consumed) {
  if (isSessionSuppressed(frame, consumed)) {
    state.counters.sessionSuppressed++;
    return false;
  }
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

export const CHECK_INBOX_DEFAULT_LIMIT = 50;
export const CHECK_INBOX_MAX_LIMIT = 500;

/* 会话主动查（设计 §4 的降级路径）：读取某协作收件流水按保留期窗口的投影（与判重窗口同一权威）。
 * 只读：不投递、不改档位、不触发重投——适配器不可用（或写入未成功）期间，会话经工具主动查取（第二档的读出口）。
 * 返回最近 limit 条（按到达序）；total = 窗口内总数——截断是显式信息，不是静默丢弃。
 * 含已投递与未投递两类（去重按 msgId 由调用方自理）：不引入第二份投递账（单一权威源）。 */
function checkInbox(state, query = {}) {
  const { collabId, limit = CHECK_INBOX_DEFAULT_LIMIT } = query;
  if (typeof collabId !== 'string' || !ID_PATTERN.test(collabId)) {
    throw new TypeError('checkInbox 需要合法的 collabId（1–64 位字母数字与连字符）');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > CHECK_INBOX_MAX_LIMIT) {
    throw new TypeError(`checkInbox 的 limit 需为 1–${CHECK_INBOX_MAX_LIMIT} 的整数`);
  }
  const records = inboxRecordsOf(state, collabId);
  const messages = records.slice(Math.max(0, records.length - limit));
  return { collabId, total: records.length, returned: messages.length, messages };
}

/* 窗口投影来源：已懒载入的 box 用内存态并按同一窗口过滤（box.seen 只在受理与载入时剪枝，
 * 空闲出窗的记录仍留在内存态——两条路径必须同口径，否则同一查询在进程内与重启后结果不同）；
 * 未载入的只读载入——不建目录、不建 box，读路径不给任意合法 collabId 造副作用。
 * 读失败（EISDIR 等）计数留痕后向上抛：工具面归类为明确错误，
 * 不得静默返回空列表（「没有消息」与「读不到」必须可区分）。 */
function inboxRecordsOf(state, collabId) {
  const box = state.boxes.get(collabId);
  if (box !== undefined) {
    const windowStart = Date.now() - state.config.messageTtlMs;
    return [...box.seen.values()]
      .filter((seen) => seen.receivedAtMs >= windowStart)
      .map((seen) => seen.record);
  }
  try {
    const loaded = loadLines(collabFilePath(state.dataDir, collabId, INBOX_FILE_NAME));
    if (loaded.tailDropped || loaded.corruptLines.length > 0) {
      state.log.warn('收件流水查询：残缺记录按可解析条目返回', { collabId, tailDropped: loaded.tailDropped, corruptLines: loaded.corruptLines.length });
    }
    const windowStart = Date.now() - state.config.messageTtlMs;
    return loaded.entries.filter((record) => freshEntryOf(record, windowStart) !== null);
  } catch (error) {
    state.counters.persistFailures++;
    state.log.warn('收件流水读取失败（查询路径）', { collabId, reason: error.message });
    throw error;
  }
}

/* 钩子 meta（来源地址）：协作层用它学习成员端点与做邀请限频；测试假连接可能不带该字段，
 * 缺失按空串（下游以空串为「未知来源」继续处理，不抛出）。 */
function metaOf(connection) {
  return { remoteAddress: typeof connection?.remoteAddress === 'string' ? connection.remoteAddress : '' };
}
