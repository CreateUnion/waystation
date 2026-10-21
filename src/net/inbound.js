import { collabDir, collabFilePath, ensureDir } from '../paths.js';
import { appendLine, loadLines, replaceFile } from '../storage.js';
import { COLLAB_CAPABILITY, GOVERNANCE_TYPES, ID_PATTERN, MAX_ACTIVE_SEATS, PROTOCOL_VERSION, isPort, newMsgId, withCollabCapability } from './protocol.js';
import { CONFLICT_FRAME_TYPES } from '../collab/gate.js';
import { normalizeToSessions } from './outbox.js';

export const INBOX_FILE_NAME = 'inbox.jsonl';

/* 收件流水压缩的行数触发阈值：自上次压缩以来的追加行数超过存活判重记录数 × 该倍率即重写文件。
 * 与发送队列同一口径——长驻进程里没有「终态事件」可等，靠行数触发才能保证文件增长有界。 */
const COMPACT_LINE_FACTOR = 2;

/* 坏目标净化的标识长度上限：与协议标识判据（ID_PATTERN，1–64）同一上界——超长值只可能是
 * 被截断的错误输入，按同一上限保留可诊断前缀。 */
const MAX_TARGET_ID_CHARS = 64;

/* 可注入钩子的形状（全部可选，缺省即安全默认）：类型注解为类型检查服务——缺省值 {} 与属性访问需要明确形状。
 * sessionGate = 投递前的静音栅栏（返回 { suppress: true } 即本帧不进会话）；sessionDelivered = 投递成功后的
 * 事实通知（已注入标记的记真挂点——本层不掌握标记归属，只报「这帧进了会话」）。 */
/** @typedef {{ admit?: (frame: object, meta: { remoteAddress: string, peerInstanceId?: string }) => { ok: boolean, reason?: string } | null | undefined | Promise<{ ok: boolean, reason?: string } | null | undefined>, consume?: (frame: object, meta: { remoteAddress: string, peerInstanceId?: string }) => unknown, deliverToSession?: (frame: object) => unknown, sessionGate?: (frame: object, meta: { remoteAddress: string, sessionId?: string }) => { suppress?: boolean } | null | undefined | Promise<{ suppress?: boolean } | null | undefined>, sessionDelivered?: (frame: object, meta: { remoteAddress: string, peerInstanceId?: string }) => unknown, assertWritable?: (collabId: string) => { ok: boolean, reason?: string } | null | undefined | Promise<{ ok: boolean, reason?: string } | null | undefined>, listSeats?: (collabId: string) => Array<{ sessionId: string, state?: string, role?: string, unverified?: boolean }>, listInjectableTargets?: (collabId: string) => Array<{ sessionId: string, state?: string }> | null | undefined, injectSeat?: (collabId: string, sessionId: string, frame: object) => { ok: boolean, delivered?: boolean, staged?: boolean, duplicate?: boolean, skipped?: string, reason?: string } | null | undefined | Promise<{ ok: boolean, delivered?: boolean, staged?: boolean, duplicate?: boolean, skipped?: string, reason?: string } | null | undefined> }} InboundHooks */

/* 接收管线（设计 §10）：帧的类型路由（四类）——
 * ① 协作域（含治理类）：准入 → 幂等去重 → 落盘 → ack → 钩子 → 投递成功后回报
 *    （去重抑制的副本按「已收到（重复）」回报——发送侧的持久条目由此能到终态）；
 * ② delivery-status（投递回报）：应用（更新本方发送队列档位，幂等）→ 回 ack → 结束；
 *    不落盘 inbox、不投会话、不产生针对回报的回报——ack 是链路确认、是递归的终端。
 *    回报必须以 ack 收敛，否则发送方该「协作 × 对端」单元的队头永占、后续消息永久阻塞；
 * ③ ping/pong：请求/应答，不落盘不 ack；④ ack：链路确认终端，无任何响应。
 * 顺序语义：本层把同一连接上的帧串行化（promise 链）——发送侧按单元串行投递、接收侧按连接串行处理，
 * 「重放不乱序」由此闭合；不同连接之间互不阻塞。
 * ack 语义 = 「已到对方驿站」：先落盘再确认（确认即承诺已持久化）；准入拒绝 / 落盘失败一律不 ack，
 * 由发送侧按重试与过期收敛（设计 §10 拒绝并计数留痕，协议无 NACK）。
 * 会话注入分流（三支见 isSessionSuppressed，第四支是 runDeliver 里的静音栅栏）：拉取两件套
 * 按类型从不注入；帖去重命中的副本由 consume 声明抑制（栅栏限帖通道、不泛化）；讨论侧被忽略的
 * 冻结族帧同样由 consume 声明抑制（无待办价值，设计 §5.7）——managed 的既有「受理帧仍注入」
 * 行为不受影响（两类声明只在其词表内被采信，managed 侧 consume 不发出这两种声明）；
 * 静音抑制由服务钩子 sessionGate 声明（本层不掌握模式与静音态）。
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
    sessionGate: hooks.sessionGate ?? noop,
    sessionDelivered: hooks.sessionDelivered ?? noop,
    /* 写门（旧协作只读判定的接入口）：legacy / recovery / corrupt 一律只读——协作域帧整帧拒绝。
     * 缺省放行（独立观察窗/单测不接写门时行为零变）。 */
    assertWritable: optionalHook(hooks, 'assertWritable'),
    /* 席位扇出面（运行时席位接口）：两件都注入才启用——缺任一按旧单投路径处理（降级零变）。
     * listSeats 绑定本地席位表；injectSeat 绑定本机旁路注入（含暂存/补投）。 */
    listSeats: optionalHook(hooks, 'listSeats'),
    /* 可注入目标面（邀请例外）：本机注册桥 / 挂起邀请中的会话——受邀会话尚未成席也必须能收邀请；
     * 缺省为空，邀请按可注入席位收窄（不得回退为广播）。 */
    listInjectableTargets: optionalHook(hooks, 'listInjectableTargets'),
    injectSeat: optionalHook(hooks, 'injectSeat'),
    seatMode: optionalHook(hooks, 'listSeats') !== null && optionalHook(hooks, 'injectSeat') !== null,
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
    localSeatDeliveryOf: (msgId, sessionId) => localSeatDeliveryOf(state, msgId, sessionId),
    stats: () => statsOf(state),
  };
}

/* 可选钩子取面：非函数一律视为未注入（安全默认由调用方负责）。 */
function optionalHook(hooks, key) {
  return typeof hooks[key] === 'function' ? hooks[key] : null;
}

function emptyCounters() {
  return {
    frames: 0,
    accepted: 0,
    duplicates: 0,
    sessionDelivered: 0,
    sessionSuppressed: 0,
    sessionGated: 0,
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
    fromSessionRejected: 0,
    readonlyInboundRejected: 0,
    fanoutSeats: 0,
    fanoutInjected: 0,
    fanoutStaged: 0,
    fanoutGated: 0,
    fanoutDropped: 0,
    fanoutResumed: 0,
    reportsResent: 0,
    toSessionsRejected: 0,
    inviteTargetRejected: 0,
    inviteTargetsUnavailable: 0,
    duplicateMismatch: 0,
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
  if (!acceptIdentity(state, frame)) {
    return;
  }
  if (!await acceptWritable(state, frame)) {
    return;
  }
  const meta = metaOf(connection);
  if (!await acceptAdmission(state, frame, meta)) {
    return;
  }
  if (!acceptTargets(state, frame)) {
    return;
  }
  const box = boxFor(state, frame.collabId);
  if (isDuplicate(state, box, frame)) {
    await handleDuplicateFrame(state, box, frame, connection, meta);
    return;
  }
  if (state.seatMode) {
    await acceptSeatFanoutFrame(state, box, frame, connection, meta);
    return;
  }
  await acceptLegacyFrame(state, box, frame, connection, meta);
}

/* 帧身份（协作域帧须带发送会话）：不合规即整帧丢弃、不确认（不落盘、不计数为已受理）。 */
function acceptIdentity(state, frame) {
  const rejection = fromSessionRejection(frame);
  if (rejection === null) {
    return true;
  }
  state.counters.fromSessionRejected++;
  state.log.warn(`协作域帧发送席位不合规，拒绝（不确认）：${rejection}`, {
    msgId: frame.msgId,
    collabId: frame.collabId,
    type: frame.type,
  });
  return false;
}

/* 写门：legacy / recovery / corrupt 目录只读——不落盘、不 ack、不注入，计数留痕。
 * 写门异常按只读处理（失败安全：读不出的可写判定不能当成可写）。 */
async function acceptWritable(state, frame) {
  if (state.assertWritable === null) {
    return true;
  }
  const verdict = await writableVerdictOf(state, frame);
  if (verdict?.ok === true) {
    return true;
  }
  state.counters.readonlyInboundRejected++;
  state.log.warn('协作目录只读（legacy / recovery / corrupt），入站帧拒绝并计数', {
    collabId: frame.collabId,
    msgId: frame.msgId,
    reason: verdict?.reason ?? '未说明',
  });
  return false;
}

/* 写门判定（异常归只读：读不出的可写判定不能当成可写）。 */
async function writableVerdictOf(state, frame) {
  try {
    return await state.assertWritable(frame.collabId);
  } catch (error) {
    return { ok: false, reason: `写门判定异常：${error?.message ?? '未知原因'}` };
  }
}

/* 准入钩子：拒绝即整帧丢弃、不确认；原因随消息文本输出（日志订阅通道可见）。 */
async function acceptAdmission(state, frame, meta) {
  const admitted = await runAdmit(state, frame, meta);
  if (admitted !== null && admitted !== undefined && admitted.ok === true) {
    return true;
  }
  state.counters.rejected.admission++;
  const reason = admitted?.reason ?? '未说明';
  state.log.warn(`协作域消息未通过准入，拒绝（不确认）：${reason}`, {
    msgId: frame.msgId,
    collabId: frame.collabId,
    reason,
  });
  return false;
}

/* 外部输入的席位目标列表校验（整帧拒绝，不确认、不落盘）：toSessions 出现即须为 1–MAX_ACTIVE_SEATS
 * 个合法会话标识的数组（去重后），与出站入队共用同一判据；非数组 / 空数组 / 坏元素 / 超长一律
 * 拒绝——绝不回落到「缺省＝本机活跃席位」的全席扇出（坏值放大为广播即定向泄漏）。
 * 指名邀请的 targetSessionId 同样先过标识判据：坏值不得退化为不指名邀请。 */
function acceptTargets(state, frame) {
  if (frame.toSessions !== undefined) {
    const sessions = normalizeToSessions(frame.toSessions);
    if (sessions === null) {
      state.counters.toSessionsRejected++;
      state.log.warn('toSessions 非法，整帧拒绝（不确认）', {
        msgId: frame.msgId,
        collabId: frame.collabId,
        type: frame.type,
      });
      return false;
    }
    frame.toSessions = sessions;   // 归一后随记录落盘：重复帧补扇出与查询看到同一份目标集
  }
  if (frame.type === 'invite' && frame.payload?.targetSessionId !== undefined) {
    const targetSessionId = frame.payload.targetSessionId;
    if (typeof targetSessionId !== 'string' || !ID_PATTERN.test(targetSessionId)) {
      state.counters.inviteTargetRejected++;
      state.log.warn('邀请的指名会话非法，整帧拒绝（不确认）', {
        msgId: frame.msgId,
        collabId: frame.collabId,
      });
      return false;
    }
  }
  return true;
}

/* 重复帧：重确认（上次 ack 可能丢失）→ 按 inbox 扇出进度补投并重发机器级回报。 */
async function handleDuplicateFrame(state, box, frame, connection, meta) {
  state.counters.duplicates++;
  connection.send(ackFrame(state, frame.msgId));
  state.counters.acksSent++;
  await resumeDuplicate(state, box, frame, connection, meta);
}

/* 旧单投路径（未接席位注入面）：落盘 → ack → 消费 → 单次投递 → 回报。 */
async function acceptLegacyFrame(state, box, frame, connection, meta) {
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
  if (await runDeliver(state, frame, consumed, meta)) {
    await noteDelivered(state, frame, connection, meta);
    return;
  }
  if (isAbsorbedDuplicate(frame, consumed)) {
    /* 「已收到（重复）」的终态回报：不注入会话的重复副本（帖去重命中 / join 重播副本）仍是
     * 已受理的帧——发送侧的持久条目收不到终态回报会永远停在「已到对方驿站」：投递豁免类
     * （join）不参与过期回收，条目随重播轮次在出站队列里累积（慢泄漏）。 */
    sendDeliveryReport(state, frame, connection);
  }
}

/* 帧身份（设计 §5.1）：协作域帧必须携带发送会话 sessionId；transport（ping/pong/ack）与
 * delivery-status 不走本函数（前者即时通道、后者接收核机器级签发）。0.2.0 之前的帧已在传输入口
 * 被 cap 闸门拒收，这里只对声明 cap=2 的帧裁定，避免历史单测夹具与旧存档被本层误判。 */
function fromSessionRejection(frame) {
  if (frame.cap !== COLLAB_CAPABILITY) {
    return null;
  }
  const sessionId = frame.from?.sessionId;
  if (typeof sessionId === 'string' && ID_PATTERN.test(sessionId)) {
    return null;
  }
  return 'from.sessionId 缺失或非法（协作帧须携带发送会话）';
}

/* 席位扇出受理（D11）：先落机器级 inbox（含目标席位与扇出进度）→ ack → 消费 → 逐席注入。
 * 落盘先于 ack、扇出晚于 ack：崩溃在二者之间时，重复帧按 inbox 里的进度补扇出（见 resumeDuplicate）。 */
async function acceptSeatFanoutFrame(state, box, frame, connection, meta) {
  const targets = seatTargetsOf(state, frame);
  state.counters.fanoutDropped += targets.dropped.length;   // 坏目标隔离：丢弃并计数，不投给其他席位
  const record = {
    ...frame,
    receivedAt: new Date().toISOString(),
    fanout: { pending: targets.seats, done: [], dropped: targets.dropped, outcomes: {}, complete: false },
  };
  if (!persistRecord(state, box, record)) {
    return;   // 未落盘不承诺：发送侧按重试 / 过期处理
  }
  box.seen.set(frame.msgId, { receivedAtMs: Date.now(), record });
  box.appendsSinceCompact++;
  state.counters.accepted++;
  connection.send(ackFrame(state, frame.msgId));
  state.counters.acksSent++;
  compactIfDue(state, box);
  const consumed = await runHook(state, state.consume, frame, meta);
  if (isSessionSuppressed(frame, consumed)) {
    state.counters.sessionSuppressed += targets.seats.length;
    record.fanout.pending = [];
    record.fanout.complete = true;
    persistRecord(state, box, record);
    if (isAbsorbedDuplicate(frame, consumed)) {
      sendDeliveryReport(state, frame, connection, firstInjectedSeatOf(record));
    }
    return;
  }
  const firstSeat = await runSeatFanout(state, box, frame, record, meta);
  const successSeat = firstSeat ?? firstSuccessOf(record);
  if (successSeat !== null) {
    state.counters.sessionDelivered++;
    await runHook(state, state.sessionDelivered, frame, meta);
  }
  /* 零注入（含仅暂存）也必须回报机器级终态（设计 §5.3/D11）：签发席位取原帧的 from.sessionId
   * （历史发件身份，不要求仍活跃）；有实际注入时才用首个注入席位。发送侧由此不必等 TTL 收敛。 */
  sendDeliveryReport(state, frame, connection, firstInjectedSeatOf(record));
}

/* 本帧的目标席位（本机可注入面）：toSessions 给出时只取列表内席位——其他目标按坏目标隔离丢弃
 * 并计数，不把整帧投给别的席位；缺省时按本机活跃席位（member）扇出，邀请帧例外（不受活跃过滤，
 * 因为受邀会话可能仍在 joining / 未入席，或只在桥注册表 / 挂起邀请中登记）。
 * 指名邀请只投 payload.targetSessionId 一个会话——不得回落到同机其他席位或全席广播。
 * 发送会话自己的席位不投（本机旁路不给自己投递）。 */
function seatTargetsOf(state, frame) {
  const seats = safeListSeats(state, frame.collabId);
  const byId = injectableSurfaceOf(state, frame, seats);
  const requested = Array.isArray(frame.toSessions) ? frame.toSessions : null;
  const desired = desiredTargetsOf(state, frame, seats, byId, requested);
  const selected = [];
  const dropped = [];
  for (const sessionId of desired) {
    if (!byId.has(sessionId)) {
      dropped.push(sanitizeTargetOf(sessionId));
    } else if (!selected.includes(sessionId)) {
      selected.push(sessionId);   // 重复目标只注入一次（坏帧不得放大投递）
    }
  }
  return { seats: senderSeatExcluded(state, frame, selected), dropped: dropped.slice(0, MAX_ACTIVE_SEATS) };
}

/* 本机可注入面：活跃 / joining 席位；邀请帧额外并入驻册桥与挂起邀请中的目标会话（尚未成席也
 * 必须能收邀请）。目标面异常按空处理——宁可丢邀请（发送侧重试至 TTL），不得回落为广播。 */
function injectableSurfaceOf(state, frame, seats) {
  const byId = new Map();
  for (const seat of seats) {
    addInjectableSeat(byId, seat);
  }
  if (frame.type !== 'invite') {
    return byId;
  }
  for (const target of safeListInjectableTargets(state, frame.collabId)) {
    addInjectableTarget(byId, target);
  }
  return byId;
}

function addInjectableSeat(byId, seat) {
  if (typeof seat?.sessionId === 'string' && isInjectableSeat(seat)) {
    byId.set(seat.sessionId, seat);
  }
}

function addInjectableTarget(byId, target) {
  if (typeof target?.sessionId !== 'string' || !ID_PATTERN.test(target.sessionId) || byId.has(target.sessionId)) {
    return;
  }
  byId.set(target.sessionId, target);
}

/* 缺省目标（未给 toSessions）：邀请帧＝可注入目标全集；内容帧＝本机活跃席位（member）。
 * 邀请没有任何可注入目标时按丢弃处理并计数——无席位表时 fail-closed，不得广播。 */
function desiredTargetsOf(state, frame, seats, byId, requested) {
  if (frame.type === 'invite') {
    const named = frame.payload?.targetSessionId;
    if (typeof named === 'string' && named !== '') {
      return [named];   // 指名：只投目标会话；不在可注入面 → 走坏目标丢弃
    }
    if (requested !== null) {
      return requested;
    }
    if (byId.size === 0) {
      state.counters.inviteTargetsUnavailable++;
      state.log.warn('邀请无本机可注入目标（无席位表 / 桥注册 / 挂起邀请），按丢弃处理且不广播', {
        msgId: frame.msgId,
        collabId: frame.collabId,
      });
      return [];
    }
    return [...byId.keys()];
  }
  if (requested !== null) {
    return requested;
  }
  return seats.filter((seat) => seat?.state === 'member').map((seat) => seat.sessionId);
}

function safeListInjectableTargets(state, collabId) {
  if (state.listInjectableTargets === null) {
    return [];
  }
  try {
    const targets = state.listInjectableTargets(collabId);
    return Array.isArray(targets) ? targets : [];
  } catch (error) {
    state.counters.hookFailures++;
    state.log.warn('可注入目标面读取异常（按空处理）', { collabId, reason: error?.message });
    return [];
  }
}

/* 坏目标写进 inbox.dropped 前的净化：只留定长字符串形态（数组元素已过受理校验，这里防未来
 * 调用方绕过；长度按标识上限截断），条数在调用侧按席位上限裁剪。 */
function sanitizeTargetOf(value) {
  if (typeof value === 'string') {
    return value.slice(0, MAX_TARGET_ID_CHARS);
  }
  return `<${typeof value}>`;
}

function isInjectableSeat(seat) {
  return seat.state === 'member' || seat.state === 'joining';
}

function senderSeatExcluded(state, frame, sessionIds) {
  if (frame.from?.instanceId !== state.self.instanceId) {
    return sessionIds;
  }
  return sessionIds.filter((sessionId) => sessionId !== frame.from.sessionId);
}

function safeListSeats(state, collabId) {
  try {
    const seats = state.listSeats(collabId);
    return Array.isArray(seats) ? seats : [];
  } catch (error) {
    state.counters.hookFailures++;
    state.log.warn('席位表读取异常（按空席位处理）', { collabId, reason: error?.message });
    return [];
  }
}

/* 逐席扇出：每席独立走静音栅栏（治理事件豁免）→ 注入面。注入面异常时保留该席在 pending，
 * 本轮停止并等待重复帧补扇出（不得把未完成当成已投递）。 */
async function runSeatFanout(state, box, frame, record, meta) {
  let firstSuccess = null;
  while (record.fanout.pending.length > 0) {
    const sessionId = record.fanout.pending[0];
    const outcome = await fanoutOneSeat(state, frame, sessionId, meta);
    if (outcome === null) {
      break;
    }
    record.fanout.pending.shift();
    record.fanout.done.push(sessionId);
    record.fanout.outcomes[sessionId] = outcome;
    if (firstSuccess === null && isSuccessOutcome(outcome)) {
      firstSuccess = sessionId;
    }
    persistRecord(state, box, record);
  }
  record.fanout.complete = record.fanout.pending.length === 0;
  persistRecord(state, box, record);
  return firstSuccess;
}

async function fanoutOneSeat(state, frame, sessionId, meta) {
  if (await seatMutedOf(state, frame, sessionId, meta)) {
    state.counters.fanoutGated++;
    return 'gated';
  }
  state.counters.fanoutSeats++;
  const result = await safeInjectSeat(state, frame, sessionId);
  if (result === null) {
    return null;   // 注入面异常：保留该席在 pending，等重复帧补扇出
  }
  return outcomeOf(state, result);
}

async function seatMutedOf(state, frame, sessionId, meta) {
  if (isMuteExempt(frame)) {
    return false;
  }
  const gate = await runHook(state, state.sessionGate, frame, { ...meta, sessionId });
  return gate?.suppress === true;
}

async function safeInjectSeat(state, frame, sessionId) {
  try {
    return await state.injectSeat(frame.collabId, sessionId, frame);
  } catch (error) {
    state.counters.hookFailures++;
    state.log.error('席位注入异常（保留待补，等待重复帧）', { msgId: frame.msgId, sessionId, reason: error?.message });
    return null;
  }
}

function outcomeOf(state, result) {
  if (result?.ok !== true) {
    state.counters.fanoutDropped++;
    return 'dropped';
  }
  if (result.skipped === 'self') {
    return 'skipped';
  }
  if (result.duplicate === true) {
    state.counters.fanoutInjected++;
    return 'duplicate';
  }
  if (result.staged === true) {
    state.counters.fanoutStaged++;
    return 'staged';
  }
  state.counters.fanoutInjected++;
  return 'injected';
}

function isSuccessOutcome(outcome) {
  return outcome === 'injected' || outcome === 'staged' || outcome === 'duplicate';
}

function firstSuccessOf(record) {
  for (const [sessionId, outcome] of Object.entries(record.fanout?.outcomes ?? {})) {
    if (isSuccessOutcome(outcome)) {
      return sessionId;
    }
  }
  return null;
}

/* 回报签发席位只认「实际注入」的席位（injected / duplicate）；暂存不算——仅暂存时按零成功处置，
 * 回报用原帧的 from.sessionId（历史发件身份）。 */
function firstInjectedSeatOf(record) {
  for (const [sessionId, outcome] of Object.entries(record.fanout?.outcomes ?? {})) {
    if (outcome === 'injected' || outcome === 'duplicate') {
      return sessionId;
    }
  }
  return null;
}

/* 重复帧补扇出（D11/H-C6）：已完成的席位跳过，pending 里的席位补投；随后重发机器级回报（幂等）。
 * 补扇出一律复用 inbox 已存的原帧（剥离 receivedAt / fanout）：同 msgId 的重复帧若换了 type/payload
 * 即为内容与账不一致，拒绝补扇出并计数（仍保留 ack——链路确认与内容裁定是两件事）。
 * 旧单投路径（无席位注入面）维持原语义：重复只重确认、不重发回报。 */
async function resumeDuplicate(state, box, frame, connection, meta) {
  if (!state.seatMode) {
    return;
  }
  const record = box.seen.get(frame.msgId)?.record;
  if (record === undefined || record.fanout === undefined) {
    return;
  }
  if (!isSameStoredContent(frame, record)) {
    state.counters.duplicateMismatch++;
    state.log.warn('重复帧载荷与已存记录不一致，拒绝补扇出（保留 ack）', {
      msgId: frame.msgId,
      collabId: frame.collabId,
      storedType: record.type,
      incomingType: frame.type,
    });
    return;
  }
  const stored = storedFrameOf(record);
  if (record.fanout.pending.length > 0) {
    state.counters.fanoutResumed++;
    await runSeatFanout(state, box, stored, record, meta);
  }
  if (CHANNEL_ROUTED_TYPES.has(record.type)) {
    return;   // 拉取两件套是请求-应答：不给终态回报（与首份副本同一口径）
  }
  state.counters.reportsResent++;
  sendDeliveryReport(state, stored, connection, firstInjectedSeatOf(record));
}

/* 同 msgId 的内容一致性：类型与载荷（重复帧是同一发送的重放，内容必须逐字等价）。 */
function isSameStoredContent(frame, record) {
  return frame.type === record.type && JSON.stringify(frame.payload ?? null) === JSON.stringify(record.payload ?? null);
}

/* 已存记录还原为注入帧（去掉入站簿记字段）：补扇出只认这份权威副本。 */
function storedFrameOf(record) {
  const stored = { ...record };
  delete stored.receivedAt;
  delete stored.fanout;
  return stored;
}

/* 静音豁免（设计 §5.4）：邀请、离席、结束、治理族与站长变更/自动移交通告不受静音抑制；
 * 逐席判定在扇出循环内做，同机不同席位的静音态互不影响。 */
const MUTE_EXEMPT_TYPES = new Set([...GOVERNANCE_TYPES, 'invite', 'leave', 'end']);

function isMuteExempt(frame) {
  if (MUTE_EXEMPT_TYPES.has(frame.type)) {
    return true;
  }
  return frame.type === 'notice' && (frame.payload?.event === 'manager-changed' || frame.payload?.event === 'auto-offer');
}

/* 投递成功分支的收尾：计数 → 记真通知 → 终态回报。顺序即语义——已注入标记必须落定在终态
 * 回报之前（回报即承诺第三档，标记是它的事后凭据）。 */
async function noteDelivered(state, frame, connection, meta) {
  state.counters.sessionDelivered++;
  await runHook(state, state.sessionDelivered, frame, meta);
  sendDeliveryReport(state, frame, connection);
}

/* 「已受理（重复）」判定：consume 声明不注入会话的抑制副本——只认帖与 join 两类通道的声明
 * （拉取两件套的通道分流不在此回报：请求-应答经发送侧的换源 / 下轮节拍收敛，不给终态回报）。
 * 帖支的终态回执另设前件「该帖曾实际注入会话」（consume 依服务域持久标记给出 wasInjected）：
 * 静音期到达的首份副本未注入，其重复副本若照旧回报终态，就绕过了「未注入 + 会话主动查」的兜底。
 * join 支维持「重复副本仍回报终态」现状（join 按重播轮次按条重发，首份副本的处置已在先）。 */
function isAbsorbedDuplicate(frame, consumed) {
  if (frame.type === 'post') {
    return consumed?.sessionDeliver === false && consumed?.wasInjected === true;
  }
  return SESSION_GATED_TYPES.has(frame.type) && consumed?.sessionDeliver === false;
}

/* 会话注入的分流面（讨论模式的机制，互不越界）：
 * ① 通道分流：拉取两件套是站间协议帧（bundle 内容经协作层落本地列表、以汇总行呈现），
 *    从不注入会话——按类型判定，与 consume 结果无关；
 * ② 去重栅栏（限帖通道、不泛化）：帖的（作者, postId）去重命中时抑制再次注入——由 consume
 *    以 { sessionDeliver: false } 显式声明（处理链的唯一知情方），本层只在该类型上采信；
 * ③ 被忽略的冻结族帧（讨论侧）：讨论无冻结概念、忽略帧无待办价值——consume 在忽略分支以
 *    { sessionDeliver: false } 声明不注入（设计 §5.7 裁定）；词表取自 gate.js 单一权威
 *    （与静音栅栏的忽略判定同一词表——分叉即判据分叉）。managed 侧冻结族 consume 不声明，
 *    照旧注入（需处置的治理帧）；
 * ④ 静音栅栏（runDeliver 内的独立分支）：由服务钩子 sessionGate 声明——本层不掌握模式与
 *    静音态，只认 { suppress: true }；被抑制帧不进会话也不回报（维持第二档，会话主动查兜底）。 */
/* seat-presence 是机器级心跳：consume 声明不投会话时必须采信，否则每个席位都会收到心跳帧
 * （治理「待办」价值为零，且会让会话收件箱被心跳噪声淹没）。 */
const SESSION_GATED_TYPES = new Set(['post', 'join', 'seat-presence']);
const CHANNEL_ROUTED_TYPES = new Set(['history-request', 'history-bundle']);

function isSessionSuppressed(frame, consumed) {
  if (CHANNEL_ROUTED_TYPES.has(frame.type)) {
    return true;
  }
  if (SESSION_GATED_TYPES.has(frame.type) && consumed?.sessionDeliver === false) {
    return true;
  }
  return CONFLICT_FRAME_TYPES.has(frame.type) && consumed?.sessionDeliver === false;
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
function sendDeliveryReport(state, frame, connection, sessionId) {
  const port = frame.from.port;
  const identity = reportIdentityOf(state, frame, sessionId);
  if (isPort(port) && !isRelayedCopy(frame)) {
    const result = state.dispatch.send({
      collabId: frame.collabId,
      to: { instanceId: frame.from.instanceId, address: connection.remoteAddress, port },
      type: 'delivery-status',
      payload: { refMsgId: frame.msgId, tier: 'session' },
      ...(identity === undefined ? {} : { from: identity }),
    });
    if (result.ok) {
      state.counters.reportsSent++;
    } else {
      state.log.warn('投递回报入队失败（维持第二档）', { refMsgId: frame.msgId, reason: result.reason });
    }
    return;
  }
  try {
    connection.send(withCollabCapability({
      v: PROTOCOL_VERSION,
      type: 'delivery-status',
      msgId: newMsgId(),
      from: identity ?? state.self,
      collabId: frame.collabId,
      ts: new Date().toISOString(),
      payload: { refMsgId: frame.msgId, tier: 'session' },
    }));
    state.counters.reportsSent++;
  } catch (error) {
    state.counters.reportFailures++;
    state.log.warn('投递回报原路回执失败（维持第二档）', { refMsgId: frame.msgId, reason: error.message });
  }
}

/* 回报签发席位（设计 §7.1 与 2026-10-21 裁定）：只在实际注入（injected / duplicate）时用该本机
 * 席位；仅暂存或零成功一律用原帧的 from.sessionId（历史发件身份，不要求该席位仍活跃）。
 * 不得生成缺 from.sessionId 的 cap=2 帧——对端协议层会拒收，发送侧只能等 TTL。
 * 旧版无 sessionId 的帧维持无 from 的兼容回执（假 dispatch/旧测试面）。 */
function reportIdentityOf(state, frame, sessionId) {
  const signer = validSessionIdOf(sessionId) ?? validSessionIdOf(frame.from?.sessionId);
  return signer === null ? undefined : { ...state.self, sessionId: signer };
}

function validSessionIdOf(value) {
  return typeof value === 'string' && ID_PATTERN.test(value) ? value : null;
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
  return persistRecord(state, box, record) ? record : null;
}

/* 记录追加写（inbox 是状态快照流：同一 msgId 的后续行携带更新的扇出进度，载入时后写胜）。 */
function persistRecord(state, box, record) {
  try {
    appendLine(box.path, record);
    return true;
  } catch (error) {
    state.counters.persistFailures++;
    state.log.error('入站消息落盘失败（不确认，等待重投）', { msgId: record?.msgId, reason: error.message });
    return false;
  }
}

/* 钩子返回值透传（consume 的注入处置声明经它到达投递判定；sessionGate / sessionDelivered 同经它；
 * 异常隔离为 undefined = 保持照旧注入 / 不记真——栅栏与记号都是附属机制，主链不因它们失败）。 */
async function runHook(state, hook, frame, meta) {
  try {
    return await hook(frame, meta);
  } catch (error) {
    state.counters.hookFailures++;
    state.log.error('接收钩子异常（已隔离）', { msgId: frame.msgId, reason: error.message });
    return undefined;
  }
}

async function runDeliver(state, frame, consumed, meta) {
  if (isSessionSuppressed(frame, consumed)) {
    state.counters.sessionSuppressed++;
    return false;
  }
  /* 静音栅栏（独立分支，不与吸收路径混用）：被抑制帧返回 false 后不落入 isAbsorbedDuplicate——
   * consume 对它的声明自然非 { sessionDeliver: false }，不会误发终态回报。 */
  const gate = await runHook(state, state.sessionGate, frame, meta);
  if (gate?.suppress === true) {
    state.counters.sessionGated++;
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
  const { collabId, limit, sessionId } = inboxQueryOf(query);
  const records = inboxRecordsOf(state, collabId);
  const visible = sessionId === undefined ? records : records.filter((record) => recordVisibleTo(record, sessionId));
  const messages = visible.slice(Math.max(0, visible.length - limit));
  return { collabId, total: visible.length, returned: messages.length, messages };
}

function inboxQueryOf(query) {
  const { collabId, limit = CHECK_INBOX_DEFAULT_LIMIT, sessionId } = query;
  if (typeof collabId !== 'string' || !ID_PATTERN.test(collabId)) {
    throw new TypeError('checkInbox 需要合法的 collabId（1–64 位字母数字与连字符）');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > CHECK_INBOX_MAX_LIMIT) {
    throw new TypeError(`checkInbox 的 limit 需为 1–${CHECK_INBOX_MAX_LIMIT} 的整数`);
  }
  if (sessionId !== undefined && (typeof sessionId !== 'string' || !ID_PATTERN.test(sessionId))) {
    throw new TypeError('checkInbox 的 sessionId 非法（1–64 位字母数字与连字符）');
  }
  return { collabId, limit, sessionId };
}

/* 会话视角的可见性（设计 §5.3 D11）：扇出记录只对目标席位可见；没有席位目标的机器级记录
 * （治理提示 / 旧单投记录）对全本机会话可见。 */
function recordVisibleTo(record, sessionId) {
  if (record?.fanout !== undefined) {
    return record.fanout.done?.includes(sessionId) === true
      || record.fanout.pending?.includes(sessionId) === true
      || record.fanout.dropped?.includes(sessionId) === true;
  }
  if (Array.isArray(record?.toSessions)) {
    return record.toSessions.includes(sessionId);
  }
  return true;
}

/* 本机席位投递明细（契约查询面）：按 (msgId, sessionId) 取扇出结果。
 * 只查已载入的协作收件盒——msgId 是全局唯一标识，运行期查询足够；未知返回 unknown 不抛错。 */
function localSeatDeliveryOf(state, msgId, sessionId) {
  if (typeof msgId !== 'string' || msgId === '' || typeof sessionId !== 'string' || !ID_PATTERN.test(sessionId)) {
    throw new TypeError('localSeatDeliveryOf 需要合法的 msgId 与 sessionId');
  }
  for (const [collabId, box] of state.boxes) {
    const record = box.seen.get(msgId)?.record;
    if (record === undefined) {
      continue;
    }
    return { collabId, msgId, sessionId, ...seatStatusOf(record, sessionId) };
  }
  return { collabId: null, msgId, sessionId, status: 'unknown', complete: false };
}

function seatStatusOf(record, sessionId) {
  const fanout = record.fanout;
  if (fanout === undefined) {
    const delivered = record.toSessions === undefined || record.toSessions.includes(sessionId);
    return { status: delivered ? 'pending' : 'unknown', complete: false };
  }
  const complete = fanout.complete === true;
  const outcome = fanout.outcomes?.[sessionId];
  if (outcome !== undefined) {
    return { status: outcome === 'duplicate' ? 'injected' : outcome, complete };
  }
  return fanoutStatusOf(fanout, sessionId, complete);
}

function fanoutStatusOf(fanout, sessionId, complete) {
  if (fanout.pending?.includes(sessionId)) {
    return { status: 'pending', complete: false };
  }
  if (fanout.dropped?.includes(sessionId)) {
    return { status: 'dropped', complete };
  }
  return { status: 'unknown', complete };
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

/* 钩子 meta（来源地址 + 传输对端实例）：协作层用它学习成员端点、做邀请限频与判定治理帧来源。
 * peerInstanceId 必须来自连接层（拨号方按目标实例在连接上盖章，见 dispatch 的拨号登记）——
 * 绝不取帧内 from.instanceId：那是发送方自报字段，用它会把 presence 的「传输对端」校验
 * 退化为自证（伪造 from 即可刷新他人席位）。连接未携带时省略，下游按未知 fail-closed。
 * 测试假连接可能不带 remoteAddress，缺失按空串（下游以空串为「未知来源」）。 */
function metaOf(connection) {
  const meta = { remoteAddress: typeof connection?.remoteAddress === 'string' ? connection.remoteAddress : '' };
  const peerInstanceId = connection?.peerInstanceId;
  if (typeof peerInstanceId === 'string' && peerInstanceId !== '') {
    meta.peerInstanceId = peerInstanceId;
  }
  return meta;
}
