import { readdirSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { COLLABS_DIR_NAME } from '../paths.js';
import { ID_PATTERN, MAX_FRAME_BYTES, MESSAGE_TYPES, PROTOCOL_VERSION, TRANSPORT_TYPES, isPort, newMsgId, validateMessage, withCollabCapability } from './protocol.js';
import { createOutbox } from './outbox.js';

/* 直投（讨论模式帖通道，设计 §5.2「在线直投 + 短重试」）：逐帖直发、不落持久逐帖队列——
 * 尝试次数与重试间隔取「短」量级（首投 + 2 次重试、每次等待窗 1s），失败即止、不逐帖承诺送达；
 * 离线者的收敛由对方周期对表拉取兜底（拉取机制属对表链路）。单次尝试的等待窗 = 重试间隔
 * （到点未 ack 按失败重试）；重试必重拨（与队列的半开连接检测同口径）。
 * 投递记录（供 ws_delivery_status 的帖行集）在内存短期保留：保留窗 10 分钟、上限 512 条
 * （按插入序淘汰）——它是短时事实面，与持久队列（7 天保留、可重启续投）明确分开。
 * 四个数值均经构造选项可注入（测试收敛用），生产用本默认值。 */
const DIRECT_MAX_ATTEMPTS = 3;
const DIRECT_RETRY_INTERVAL_MS = 1000;
const DIRECT_RECORD_TTL_MS = 10 * 60 * 1000;
const DIRECT_RECORD_MAX = 512;

/* 发送调度（设计 §10）：按「协作 × 对端」单元串行投递（FIFO 保序），ack 推进，超时重传。
 * 节律：首投立即；未 ack 的重试恒定 retryIntervalMs，连续 retryFastCount 次后转 retrySlowIntervalMs，
 * 直至送达 / 过期——节律参数与容量、过期的权威在 outbox，本层只驱动「何时再试一次」。
 * 半开连接检测：重试必重拨（旧连接关闭）——应用层 ack 与超时是唯一判据（设计 §5/§10）。
 * 拨号连接上的回程帧（ack / pong / 投递回报）统一经 setClientFrameRouter 注入的路由器转交接收管线
 * （生产路径由装配层注入 inbound.onFrame）；未接线时帧计数丢弃。
 * deliveryStatus 查询按需惰性载入协作目录（幂等）：未 start 的降级态也能看到落盘的历史队列与
 * 直投短时记录——查询只加载，不启 tick、不调度。
 * stop() 是发送截止点：停止后醒来的在途投递一律不发帧，在途拨号完成即关（连同探测在内一并收口）；
 * 直投等待面在 stop 时统一解挂（未达 + 不再重试）；stop() 返回的 promise 在在途拨号全部落地后
 * resolve——resolve 即无无主连接。
 * 一切异常（拨号失败、写失败、调度循环内任何错误）都被捕获记录，绝不退出进程（健壮性硬性要求）。 */
export function createDispatch(options) {
  const state = buildState(options);
  return {
    start: () => start(state),
    stop: () => stop(state),
    send: (message) => send(state, message),
    sendDirect: (message) => sendDirect(state, message),
    onAck: (msgId) => onAck(state, msgId),
    onDeliveryReport: (payload) => onDeliveryReport(state, payload),
    deliveryStatusOf: (msgId) => deliveryStatusOf(state, msgId),
    resolvePong: (frame) => resolvePong(state, frame),
    ping: (options) => ping(state, options),
    deliveryStatus: (query) => deliveryStatus(state, query),
    reassignPeer: (payload) => reassignPeer(state, payload),
    setClientFrameRouter: (router) => {
      state.clientFrameRouter = router;
    },
    stats: () => statsOf(state),
  };
}

/* 运行态容器：依赖注入与直投参数一次性定格（直投参数缺省 = 模块顶部常量；测试经选项收敛）。
 * onRelayedReport（可选注入面）：转达副本首次达第三档时的聚合捎回通知（讨论的中继分发）——
 * 与协作层的接线口径同 setClientFrameRouter 先例；缺省不接（本层行为照旧）。 */
function buildState({ dataDir, config, transport, self, log, onRelayedReport = null,
  directMaxAttempts = DIRECT_MAX_ATTEMPTS, directRetryIntervalMs = DIRECT_RETRY_INTERVAL_MS,
  directRecordTtlMs = DIRECT_RECORD_TTL_MS, directRecordMax = DIRECT_RECORD_MAX }) {
  return {
    dataDir,
    config,
    transport,
    self,
    log,
    onRelayedReport,
    directMaxAttempts,
    directRetryIntervalMs,
    directRecordTtlMs,
    directRecordMax,
    outboxes: new Map(),
    entryIndex: new Map(),     // msgId → collabId（ack / 回报的归属查找）
    inFlight: new Set(),       // 单元键（一次只投一条）
    pendingDials: new Set(),   // 在途拨号 promise（stop 收口等它们落地，不留无主连接）
    unitDials: new Map(),      // 单元键 → 在途拨号 promise（并发同单元投递共享同一次拨号）
    connections: new Map(),    // 单元键 → { connection, collabId, peer }
    pendingPings: new Map(),   // ping msgId → { resolve, startedAt, timer }
    directRecords: new Map(),  // 直投 msgId → 投递记录（短时保留；查询行集来源）
    directWaiters: new Map(),  // 直投 msgId → { resolve, timer }（单次尝试的 ack 等待面）
    directActive: new Map(),   // 单元键 → 在途直投数（空闲连接判定据此不关闭在用连接）
    counters: emptyCounters(),
    clientFrameRouter: null,
    timer: null,
    stopped: false,            // 发送截止点：stop 置位、start 复位
  };
}

function emptyCounters() {
  return {
    attempts: 0,
    ackedTotal: 0,
    deliveredTotal: 0,
    acksUnknown: 0,
    reportsUnknown: 0,
    pongsUnknown: 0,
    sendsRejected: 0,
    deliveryFailures: 0,
    expiredTotal: 0,
    clientFramesDropped: 0,
    directRejected: 0,
    directAttempts: 0,
    directAcked: 0,
    directSession: 0,
    directUndelivered: 0,
  };
}

function start(state) {
  if (state.timer !== null) {
    return;   // 幂等：重复 start 不叠挂 interval——叠挂的 interval 会逃过 stop 的清理，停止后仍继续投递
  }
  state.stopped = false;   // start 即重新开闸：stop 之后再次启动，投递恢复
  ensureLoadedCollabs(state);
  state.timer = setInterval(() => {
    tick(state);
  }, state.config.dispatchTickMs);
  if (typeof state.timer.unref === 'function') {
    state.timer.unref();   // 定时器不阻止进程退出：会话关闭即退出是产品语义
  }
}

/* 停止 = 发送截止点：置位后醒来的在途投递一律不发帧（完成即关连接），在途拨号由本层收口——
 * transport.close() 兜不住这个窗口：它只遍历「已连上」的连接集，close() 之前尚未连上的拨号 socket 收不到，
 * 连上后会成为没人跟踪的活连接。返回的 promise 在全部在途拨号落地后 resolve。
 * 直投等待面在此时统一解挂（未达语义）——直投任务醒来即止，不留跨停止的挂起定时器。 */
async function stop(state) {
  state.stopped = true;
  if (state.timer !== null) {
    clearInterval(state.timer);
    state.timer = null;
  }
  for (const held of state.connections.values()) {
    held.connection.close();
  }
  state.connections.clear();
  for (const pending of state.pendingPings.values()) {
    clearTimeout(pending.timer);
    pending.resolve(null);
  }
  state.pendingPings.clear();
  settleDirectWaiters(state);
  await Promise.allSettled([...state.pendingDials]);
}

/* 直投等待面统一解挂（stop 路径）：以 'stopped' 终止单次尝试等待——任务层据此收尾为「未达」。 */
function settleDirectWaiters(state) {
  for (const waiter of state.directWaiters.values()) {
    clearTimeout(waiter.timer);
    waiter.resolve('stopped');
  }
  state.directWaiters.clear();
}

/* message.from（可选）：转达帧的原发身份——治理转达保留发起者身份（身份语义定义在 from 上），
 * 缺省以本机身份盖章；fromSessionId 为发送会话——写入 from.sessionId（协作域帧的发送席位）。
 * toSessions 为同一帧上的本机目标席位集合（机器级一帧一机，D11）；缺省＝接收核按全部活跃席位扇出。
 * 预检、入队与投递（frameOf）三处同用这一份身份。 */
function send(state, { collabId, to, type, payload, from, fromSessionId, toSessions }) {
  const rejection = sendRejection(collabId, to, type);
  if (rejection !== null) {
    state.counters.sendsRejected++;
    return { ok: false, reason: rejection };
  }
  if (TRANSPORT_TYPES.includes(type)) {
    // 传输类帧是即时通道（可达性探测 / 链路确认）：队列语义要求「对方 ack 才出队」，
    // 而入队这些类型会造出永不 ack 的队头——该单元后续消息被永久阻塞
    state.counters.sendsRejected++;
    return { ok: false, reason: '传输类帧（ping / pong / ack）不走发送队列：请求应答与链路确认是即时通道' };
  }
  if (to.instanceId === state.self.instanceId) {
    state.counters.sendsRejected++;
    return { ok: false, reason: '目标为本机实例，拒绝对自己投递' };
  }
  if (!isPort(state.self.port)) {
    state.counters.sendsRejected++;
    return { ok: false, reason: 'from.port 非法（1–65535 的整数）：本机站点端口未就位（构造侧必填）' };
  }
  const msgId = newMsgId();
  const ts = new Date().toISOString();
  const identity = identityOf(state, from, fromSessionId);
  if (!hasSenderSession(identity)) {
    state.counters.sendsRejected++;
    return { ok: false, reason: '协作域帧缺少发送会话标识（from.sessionId / fromSessionId 必填）——拒绝以本机名义兜底' };
  }
  const payloadRejection = frameRejectionOf(frameOf(state, collabId, { msgId, type, payload, createdAt: ts, from: identity, toSessions }));
  if (payloadRejection !== null) {
    state.counters.sendsRejected++;
    return { ok: false, reason: payloadRejection };
  }
  const outbox = outboxFor(state, collabId);
  const result = outbox.enqueue({ msgId, to: { instanceId: to.instanceId, address: to.address, port: to.port }, type, payload, ts, from: identity, fromSessionId, toSessions });
  if (!result.ok) {
    state.counters.sendsRejected++;
    return result;
  }
  state.entryIndex.set(msgId, collabId);
  return { ok: true, msgId, tier: 'queued' };
}

/* 协作域帧的签发席位（硬闸门）：cap=2 帧必须带合法 from.sessionId——不得以本机身份兜底
 * （兜底出的帧没有 sessionId，对端必拒收）；转达帧的 from 原样使用，其 sessionId 同样必填。 */
function hasSenderSession(identity) {
  return typeof identity?.sessionId === 'string' && ID_PATTERN.test(identity.sessionId);
}

/* 帧身份：显式 from（转达原发者）优先；否则带上发送会话的 fromSessionId；都没有则本机身份。 */
function identityOf(state, from, fromSessionId) {
  if (from !== undefined) {
    return from;
  }
  if (typeof fromSessionId === 'string') {
    return { ...state.self, sessionId: fromSessionId };
  }
  return undefined;
}

/* 终帧预检（受理面）：体积与协议两关都以「对端入站校验」为准——体积超限的帧会被对端直接销毁；
 * 结构与协议不符的帧（含类型专属字段，如 delivery-status 的 refMsgId 形态）会被对端拒收——
 * 两类条目重试多少次都是同一结果，且恒为队头（headFor 只取最老 queued）：普通条目阻塞至过期，
 * 治理类条目豁免过期则把单元永久钉死，必须在受理面拒绝。
 * 形态与体积都按「序列化上线后的实际形态」计——toJSON 之类的序列化钩子会改写上线载荷，
 * 只查原对象形态会被绕过；validateMessage 跑在同一份上线形态上，与对端校验器同一实现。 */
function frameRejectionOf(frame) {
  try {
    const line = JSON.stringify(frame);
    const bytes = Buffer.byteLength(line);
    if (bytes > MAX_FRAME_BYTES) {
      return `帧体积 ${bytes} 字节超协议上限 ${MAX_FRAME_BYTES} 字节：对端会拒收并断开连接，本条永不送达`;
    }
    const wire = JSON.parse(line);   // 上限内才解析，解析不会失败；上线形态（toJSON 已生效）与对端实际收到的形态一致
    if (wire.payload !== undefined && !isPlainObject(wire.payload)) {
      return 'payload 须为 JSON 对象（协议信封规则）：序列化后为数组 / 字符串 / 数字 / null 的载荷会被对端拒收，本条永不送达';
    }
    const checked = validateMessage(wire);
    if (!checked.ok) {
      return `帧与协议校验不符（${checked.reason}）：对端必拒收，本条永不送达`;
    }
  } catch (error) {
    return `payload 无法序列化（${error.message}）：落盘与对端都无法处理，本条永不送达`;
  }
  return null;
}

/* 与 protocol 信封校验的「payload 须为 JSON 对象」同一形态判据（对象、非 null、非数组）。 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/* send 参数校验：任一不合法即返回统一拒绝原因（点名参数清单），合法返回 null。 */
function sendRejection(collabId, to, type) {
  const argsReason = 'send 参数非法（collabId / to.instanceId / to.address / to.port / type，地址须为 IP 字面量、端口须为 1–65535 整数）';
  if (!isIdLike(collabId)) {
    return argsReason;
  }
  if (typeof to !== 'object') {
    return argsReason;
  }
  if (to === null) {
    return argsReason;
  }
  if (!isIdLike(to.instanceId)) {
    return argsReason;
  }
  if (!isAddressLike(to.address)) {
    return argsReason;
  }
  if (!isPort(to.port)) {
    return argsReason;
  }
  if (!isKnownType(type)) {
    return argsReason;
  }
  return null;
}

function isIdLike(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function isAddressLike(value) {
  return typeof value === 'string' && isIP(value) !== 0;
}

function isKnownType(value) {
  return typeof value === 'string' && MESSAGE_TYPES.includes(value);
}

/* 直投受理（讨论模式帖通道）：当场返回受理结果，投递在独立任务中进行（不占调用方、不落队列）。
 * 与队列路径共用：参数 / 终帧预检（与对端入站校验同一权威——不合法直接拒绝，不做无谓重试）、
 * 连接模型（首投复用、重试重拨）、ack 与投递回报的归属机制。
 * 不共用：落盘（无 outbox 写入）、节律（固定短重试、失败即止）。
 * createdAt 缺省取当前时刻；调用方可给帖的落盘 ts——帧 ts 随帖携带（接收端显示序与作者内序依据）。
 * from（可选）＝转达帧的原发身份（中继扇出保原作者；与队列路径同一语义）——缺省以本机身份盖章。 */
function sendDirect(state, { collabId, to, type, payload, createdAt, from, fromSessionId, toSessions }) {
  const rejection = directRejection(state, collabId, to, type);
  if (rejection !== null) {
    state.counters.directRejected++;
    return { ok: false, reason: rejection };
  }
  const identity = identityOf(state, from, fromSessionId);
  if (!hasSenderSession(identity)) {
    state.counters.directRejected++;
    return { ok: false, reason: '协作域帧缺少发送会话标识（from.sessionId / fromSessionId 必填）——拒绝以本机名义兜底' };
  }
  const record = directRecordOf(collabId, to, { type, payload, createdAt, from: identity, toSessions });
  const payloadRejection = frameRejectionOf(frameOf(state, collabId, record));
  if (payloadRejection !== null) {
    state.counters.directRejected++;
    return { ok: false, reason: payloadRejection };
  }
  rememberDirectRecord(state, record);
  const key = `${collabId}:${to.instanceId}`;
  runDirectDelivery(state, key, record).catch((error) => {
    state.log.error('直投任务异常（已隔离）', { msgId: record.msgId, reason: error.message });
  });
  return { ok: true, msgId: record.msgId };
}

/* 直投参数拒绝（与 send 同一形态判据 + 直投专属两条）：传输类帧不走直投（即时通道语义）；
 * 本机端口必须就位（帧的 from.port 是对方回报寻址依据）。返回拒绝原因或 null。 */
function directRejection(state, collabId, to, type) {
  const shapeReason = sendRejection(collabId, to, type);
  if (shapeReason !== null) {
    return shapeReason;
  }
  if (TRANSPORT_TYPES.includes(type)) {
    return '传输类帧（ping / pong / ack）不走直投：请求应答与链路确认是即时通道';
  }
  if (to.instanceId === state.self.instanceId) {
    return '目标为本机实例，拒绝对自己投递';
  }
  if (!isPort(state.self.port)) {
    return 'from.port 非法（1–65535 的整数）：本机站点端口未就位（构造侧必填）';
  }
  return null;
}

function directRecordOf(collabId, to, { type, payload, createdAt, from, toSessions }) {
  return {
    msgId: newMsgId(),
    collabId,
    to: { instanceId: to.instanceId, address: to.address, port: to.port },
    type,
    payload,
    from,
    toSessions,
    state: 'inflight',
    attempts: 0,
    createdAt: typeof createdAt === 'string' ? createdAt : new Date().toISOString(),
    ackedAt: undefined,
    deliveredAt: undefined,
    failedAt: undefined,
    reason: undefined,
  };
}

/* 直投任务：短重试循环——每次尝试（拨号/复用 → 发帧 → 等 ack）；未确认则等一个间隔后重试，
 * 尝试上限用尽或调度器停止即收尾为「未达」（不逐帖承诺送达；离线者由对方周期对表拉取收敛）。
 * directActive 计该单元在途直投数：空闲连接判定据此不关闭正在等待 ack 的连接。 */
async function runDirectDelivery(state, key, record) {
  state.directActive.set(key, (state.directActive.get(key) ?? 0) + 1);
  try {
    for (let attempt = 1; attempt <= state.directMaxAttempts; attempt++) {
      const outcome = await attemptDirectDelivery(state, key, record);
      if (outcome === 'settled') {
        return;
      }
      if (outcome === 'stopped' || attempt === state.directMaxAttempts) {
        markDirectUndelivered(state, record);
        return;
      }
      await sleep(state.directRetryIntervalMs);
    }
  } finally {
    dropDirectActivity(state, key);
  }
}

/* 单次尝试：连接（首投复用 / 重试重拨）→ 发帧 → 等 ack（等待窗 = 重试间隔）。
 * 返回 'settled'（ack / 会话回报已到）、'retry'（未确认——失败也要等间隔，不得每轮重拨）、
 * 'stopped'（调度器停止：中止且不再重试）。尝试计数含拨号失败（与队列口径一致）。 */
async function attemptDirectDelivery(state, key, record) {
  if (record.state === 'at-peer' || record.state === 'session') {
    return 'settled';   // 重试间隙到达的确认（等待面已收）：不再重发
  }
  if (state.stopped) {
    record.reason = '调度器已停止——直投中止';
    return 'stopped';
  }
  try {
    const connection = await obtainConnection(state, key, record.collabId, record);
    if (connection === null || state.stopped) {
      record.reason = '调度器已停止——直投中止';
      return 'stopped';
    }
    connection.send(frameOf(state, record.collabId, record));
    state.counters.directAttempts++;
    record.attempts++;
  } catch (error) {
    record.attempts++;
    record.reason = `拨号失败：${error.message}`;
    state.counters.deliveryFailures++;
    state.log.warn('直投失败，按短节律重试', { msgId: record.msgId, peer: record.to.instanceId, reason: error.message });
    return 'retry';
  }
  const outcome = await waitForDirectSettle(state, record.msgId);
  if (outcome === 'settled') {
    return 'settled';
  }
  if (outcome === 'stopped') {
    record.reason = '调度器已停止——直投中止';
    return 'stopped';
  }
  record.reason = `等待对方驿站确认超时（${state.directRetryIntervalMs}ms 内无 ack）`;
  return 'retry';
}

/* 单次尝试的 ack 等待面：到点按超时返回；ack / 会话回报 / 停止由结算路径唤醒。 */
function waitForDirectSettle(state, msgId) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      state.directWaiters.delete(msgId);
      resolve('timeout');
    }, state.directRetryIntervalMs);
    state.directWaiters.set(msgId, { resolve, timer });
  });
}

function settleDirectWaiter(state, msgId, outcome) {
  const waiter = state.directWaiters.get(msgId);
  if (waiter === undefined) {
    return;
  }
  state.directWaiters.delete(msgId);
  clearTimeout(waiter.timer);
  waiter.resolve(outcome);
}

/* 投递记录登记（短时保留）：登记即按保留窗剪枝 + 容量淘汰最旧（幂等、无定时器）。 */
function rememberDirectRecord(state, record) {
  pruneDirectRecords(state, Date.now());
  state.directRecords.set(record.msgId, record);
  while (state.directRecords.size > state.directRecordMax) {
    const oldest = state.directRecords.keys().next().value;
    state.directRecords.delete(oldest);
  }
}

/* 保留窗剪枝：记录自创建起超窗即移除（查询与登记两路径共同维护——无定时器，稳态零开销）。 */
function pruneDirectRecords(state, now) {
  for (const [msgId, record] of state.directRecords) {
    if (now - Date.parse(record.createdAt) > state.directRecordTtlMs) {
      state.directRecords.delete(msgId);
    }
  }
}

/* 记录推进（状态单调向前：inflight → at-peer → session；未达档不吞迟到 ack——真实送达不得回退）：
 * ack 与会话回报都可能晚于等待面到达（重试间隙 / 任务收尾后），推进一律幂等。 */
function markDirectAcked(state, record, now) {
  if (record.state === 'at-peer' || record.state === 'session') {
    return false;
  }
  record.state = 'at-peer';
  record.ackedAt = new Date(now).toISOString();
  record.reason = undefined;
  state.counters.directAcked++;
  settleDirectWaiter(state, record.msgId, 'settled');
  return true;
}

function markDirectSession(state, record, now) {
  if (record.state === 'session') {
    return false;
  }
  if (record.state !== 'at-peer') {
    /* 会话回报蕴含对方驿站已确认（接收侧先 ack 后投会话）：ack 未被本机观测到时按同一时刻记。 */
    record.state = 'at-peer';
    record.ackedAt = new Date(now).toISOString();
    state.counters.directAcked++;
  }
  record.state = 'session';
  record.deliveredAt = new Date(now).toISOString();
  record.reason = undefined;
  state.counters.directSession++;
  settleDirectWaiter(state, record.msgId, 'settled');
  return true;
}

/* 中继转达副本的回报译回（讨论中继分发的聚合捎回，设计 §5.2「成员级投递结果由中继捎回」）：
 * 被转达副本（载荷带 originMsgId）首次达第三档时，把「该成员会话已收到」通知注入面译回原作者
 * （原投稿帧）。只在状态首次跃迁时触发（重复回报不再产生第二帧）；原生副本（无 originMsgId /
 * 无 from）不触发——既有回报语义与 queue 路径（治理转发）均不受影响；注入面异常隔离为日志，
 * 绝不穿出投递回报主链（投递回报的 ack 与状态推进照旧）。 */
function notifyRelayedReport(state, record) {
  const originMsgId = record.payload?.originMsgId;
  const author = record.from;
  if (typeof originMsgId !== 'string' || originMsgId === '' || typeof author?.instanceId !== 'string') {
    return;
  }
  if (typeof state.onRelayedReport !== 'function') {
    return;
  }
  try {
    state.onRelayedReport({ collabId: record.collabId, originMsgId, author: { instanceId: author.instanceId, identityName: author.identityName } });
  } catch (error) {
    state.log.error('聚合回报注入面异常（已隔离）', { collabId: record.collabId, reason: error?.message });
  }
}

function markDirectUndelivered(state, record) {
  if (record.state === 'at-peer' || record.state === 'session') {
    return;   // 等待窗与收尾之间的迟到确认：已投达不得被标成未达
  }
  record.state = 'undelivered';
  record.failedAt = new Date().toISOString();
  state.counters.directUndelivered++;
}

function dropDirectActivity(state, key) {
  const held = state.directActive.get(key);
  if (held === undefined || held <= 1) {
    state.directActive.delete(key);
    return;
  }
  state.directActive.set(key, held - 1);
}

/* 重试等待（不阻止进程退出：会话结束即退出是产品语义——等待窗不得拖住事件循环；
 * 停止后任务在下一轮唤醒点看到截止位即收尾）。 */
function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  });
}

function onAck(state, msgId) {
  const direct = state.directRecords.get(msgId);
  if (direct !== undefined) {
    markDirectAcked(state, direct, Date.now());
    return;
  }
  const located = locate(state, msgId);
  if (located === null) {
    state.counters.acksUnknown++;
    state.log.warn('收到未知消息的确认（忽略）', { msgId });
    return;
  }
  if (located.outbox.markAcked(msgId, Date.now())) {
    state.counters.ackedTotal++;
    closeConnectionIfIdle(state, located.collabId, located.entry.to.instanceId);
  }
}

function onDeliveryReport(state, { refMsgId, tier }) {
  const direct = state.directRecords.get(refMsgId);
  if (direct !== undefined && tier === 'session') {
    if (markDirectSession(state, direct, Date.now())) {
      notifyRelayedReport(state, direct);
    }
    return;
  }
  const located = locate(state, refMsgId);
  if (located === null || tier !== 'session') {
    state.counters.reportsUnknown++;
    state.log.warn('收到无法归属的投递回报（忽略）', { refMsgId, tier });
    return;
  }
  if (located.outbox.markSessionDelivered(refMsgId, Date.now())) {
    state.counters.deliveredTotal++;
    closeConnectionIfIdle(state, located.collabId, located.entry.to.instanceId);
  }
}

function resolvePong(state, frame) {
  const pending = state.pendingPings.get(frame.replyTo);
  if (pending === undefined) {
    state.counters.pongsUnknown++;
    return false;
  }
  clearTimeout(pending.timer);
  state.pendingPings.delete(frame.replyTo);
  pending.resolve(Date.now() - pending.startedAt);
  return true;
}

async function ping(state, { address, port }) {
  const msgId = newMsgId();
  /* 连接句柄按接口消费（形状由注入的 transport 定义）：显式 any 让类型检查接受收窄与 finally 关闭 */
  /** @type {any} */
  let connection = null;
  try {
    connection = await dialPeer(state, { address, port, timeoutMs: state.config.dialTimeoutMs });
    if (connection === null) {
      return { reachable: false, reason: '探测中止：调度器已停止（不发探测帧）' };
    }
    adopt(state, connection);
    const outcome = new Promise((resolve) => {
      const waitTimer = setTimeout(() => {
        if (state.pendingPings.delete(msgId)) {
          resolve(null);
        }
      }, state.config.dialTimeoutMs);
      state.pendingPings.set(msgId, { resolve, startedAt: Date.now(), timer: waitTimer });
    });
    connection.send({ v: PROTOCOL_VERSION, type: 'ping', msgId, from: state.self, ts: new Date().toISOString() });
    const rttMs = await outcome;
    if (rttMs === null) {
      return { reachable: false, reason: `探测超时（${state.config.dialTimeoutMs}ms 内无应答）` };
    }
    return { reachable: true, rttMs };
  } catch (error) {
    return { reachable: false, reason: `探测不可达：${error.message}` };
  } finally {
    const pending = state.pendingPings.get(msgId);
    if (pending !== undefined) {
      clearTimeout(pending.timer);
      state.pendingPings.delete(msgId);
    }
    if (connection !== null) {
      connection.close();
    }
  }
}

function deliveryStatus(state, query = {}) {
  ensureLoadedCollabs(state);   // 查询路径惰性载入（幂等）：未 start 也能看到落盘的历史队列与直投短时记录；只加载，不启 tick、不调度
  pruneDirectRecords(state, Date.now());
  const rows = [...outboxRowsOf(state, query), ...directRowsOf(state, query)];
  return rows.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

/* 队列行集（含在线直投的短时记录之外的全部历史条目）；过滤口径：字符串非空才过滤。 */
function outboxRowsOf(state, query) {
  const { msgId, collabId } = query;
  const rows = [];
  for (const [id, outbox] of state.outboxes) {
    if (typeof collabId === 'string' && collabId !== '' && id !== collabId) {
      continue;
    }
    for (const entry of outbox.entries()) {
      if (typeof msgId === 'string' && msgId !== '' && entry.msgId !== msgId) {
        continue;
      }
      rows.push(statusRow(id, entry));
    }
  }
  return rows;
}

/* 直投短时记录行集（讨论模式的帖投递事实面；与队列行集同形输出）。 */
function directRowsOf(state, query) {
  const { msgId, collabId } = query;
  const rows = [];
  for (const record of state.directRecords.values()) {
    if (typeof collabId === 'string' && collabId !== '' && record.collabId !== collabId) {
      continue;
    }
    if (typeof msgId === 'string' && msgId !== '' && record.msgId !== msgId) {
      continue;
    }
    rows.push(directStatusRow(record));
  }
  return rows;
}

/* 直投投递记录 → 查询行（设计 §5.2 讨论语义）：档位取记录状态——inflight（直投中，过渡态）/
 * at-peer（已到对方驿站，直投 ack）/ session（已投进对方会话，回报）/ undelivered（未送达，
 * 待对表收敛；「已排队」档不适用、不出现）。未达行带 note 与失败原因，如实呈现收敛路径。 */
function directStatusRow(record) {
  return {
    msgId: record.msgId,
    collabId: record.collabId,
    type: record.type,
    toInstanceId: record.to.instanceId,
    fromSessionId: record.from?.sessionId ?? null,
    toSessions: record.toSessions ?? null,
    tier: record.state,
    expired: false,
    attempts: record.attempts,
    createdAt: record.createdAt,
    nextAttemptAt: null,
    ackedAt: record.ackedAt ?? null,
    deliveredAt: record.deliveredAt ?? null,
    note: record.state === 'undelivered' ? '未达——待对表收敛（对方周期拉取后自动追平）' : null,
    reason: record.reason ?? null,
  };
}

/* 队列改投（协作层在降级 / 移交时消费）：把该协作发往旧对端的未确认条目改投新对端。
 * 只动既有队列（不新建协作目录——协作目录的创建归发送路径）；无该协作队列时按零条成功。 */
function reassignPeer(state, { collabId, fromInstanceId, to }) {
  const rejection = reassignRejection(collabId, fromInstanceId, to);
  if (rejection !== null) {
    return { ok: false, reason: rejection };
  }
  const outbox = state.outboxes.get(collabId);
  if (outbox === undefined) {
    return { ok: true, moved: 0 };
  }
  const result = outbox.reassignPeer(fromInstanceId, to);
  return { ok: true, moved: result.moved };
}

/* 改投参数校验：与 send 同一形态判据（标识 / IP 字面量 / 端口范围）。 */
function reassignRejection(collabId, fromInstanceId, to) {
  if (!isIdLike(collabId) || !isIdLike(fromInstanceId)) {
    return 'reassignPeer 参数非法（collabId / fromInstanceId 须为 1–64 位字母数字与连字符）';
  }
  if (typeof to !== 'object' || to === null || !isIdLike(to.instanceId) || !isAddressLike(to.address) || !isPort(to.port)) {
    return 'reassignPeer 目标非法（instanceId / address / port：地址须为 IP 字面量、端口 1–65535 整数）';
  }
  return null;
}

function statsOf(state) {
  return {
    ...state.counters,
    collabs: state.outboxes.size,
    inFlight: state.inFlight.size,
    connections: state.connections.size,
    pendingPings: state.pendingPings.size,
    directRecords: state.directRecords.size,
    directActive: state.directActive.size,
  };
}

function tick(state) {
  try {
    const now = Date.now();
    pruneAll(state, now);
    for (const [collabId, outbox] of state.outboxes) {
      scheduleUnits(state, collabId, outbox, now);
    }
    closeIdleConnections(state);
  } catch (error) {
    state.log.error('调度循环异常（已隔离，不退出进程）', { reason: error.message });
  }
}

/* 为一个协作的每个对端单元调度一次投递：单元在途则跳过，投放失败在任务内部消化。 */
function scheduleUnits(state, collabId, outbox, now) {
  for (const peer of outbox.units()) {
    const key = `${collabId}:${peer}`;
    if (state.inFlight.has(key)) {
      continue;
    }
    startDelivery(state, key, collabId, outbox, peer, now);
  }
}

function startDelivery(state, key, collabId, outbox, peer, now) {
  const head = outbox.headFor(peer);
  if (head === undefined || head.nextAttemptAt > now) {
    return;
  }
  state.inFlight.add(key);
  deliverHead(state, collabId, outbox, head)
    .catch((error) => {
      state.log.error('投递任务异常（已隔离）', { reason: error.message });
    })
    .finally(() => {
      state.inFlight.delete(key);
    });
}

async function deliverHead(state, collabId, outbox, entry) {
  const key = `${collabId}:${entry.to.instanceId}`;
  let attempted = false;
  try {
    const connection = await obtainConnection(state, key, collabId, entry);
    if (connection === null || state.stopped) {
      return;   // 停止收口后醒来的投递：新拨号连接已就地关闭、复用连接已被 stop 关闭——不发帧、不计尝试
    }
    if (entry.state !== 'queued') {
      closeConnectionIfIdle(state, collabId, entry.to.instanceId);   // await 期间已被 ack / 过期：不发帧、不计尝试
      return;
    }
    connection.send(frameOf(state, collabId, entry));
    state.counters.attempts++;
    attempted = true;
  } catch (error) {
    state.counters.deliveryFailures++;
    state.log.warn('投递失败，按节律重试', { msgId: entry.msgId, peer: entry.to.instanceId, reason: error.message });
    attempted = true;
  } finally {
    if (attempted) {
      outbox.markAttempt(entry.msgId, Date.now());   // 成功与失败都计一次尝试：失败也要退避，不得每 tick 重拨
    }
  }
}

async function obtainConnection(state, key, collabId, entry) {
  const held = state.connections.get(key);
  if (held !== undefined && entry.attempts === 0) {
    return held.connection;   // 复用：同单元的连续消息走同一连接（按需建立、可复用）
  }
  if (held !== undefined) {
    held.connection.close();  // 重试 = 半开嫌疑：重拨后再发
    state.connections.delete(key);
  }
  return dialForUnit(state, key, collabId, entry);
}

/* 拨号去重（同单元共享在途拨号）：并发的同单元投递（帖直投与队列调度可同时触达同一对端）
 * 不得各自拨号——后到者共享先到者的拨号结果，避免双连接与连接登记的相互覆盖
 * （被覆盖的连接会脱离空闲回收视野，只能等对端关闭）。 */
function dialForUnit(state, key, collabId, entry) {
  let pending = state.unitDials.get(key);
  if (pending === undefined) {
    pending = performDial(state, key, collabId, entry);
    state.unitDials.set(key, pending);
    const clear = () => {
      if (state.unitDials.get(key) === pending) {
        state.unitDials.delete(key);
      }
    };
    pending.then(clear, clear);   // 成败都清（失败不产生未处理 rejection：两个出口都接住）
  }
  return pending;
}

async function performDial(state, key, collabId, entry) {
  const connection = await dialPeer(state, { address: entry.to.address, port: entry.to.port, timeoutMs: state.config.dialTimeoutMs });
  if (connection === null) {
    return null;   // 停止收口后才完成的拨号：连接已被收口关闭，不得登记、不得发帧
  }
  /* 传输对端实例：本连接是按该条目的目标实例拨出的——这是连接层事实，入站 meta.peerInstanceId
   * 据此盖章（不得由帧内 from 自报）。入站接受的连接来源身份未知，保持省略（下游 fail-closed）。 */
  connection.peerInstanceId = entry.to.instanceId;
  adopt(state, connection);
  connection.onClose(() => {
    const current = state.connections.get(key);
    if (current !== undefined && current.connection === connection) {
      state.connections.delete(key);
    }
  });
  state.connections.set(key, { connection, collabId, peer: entry.to.instanceId });
  return connection;
}

/* 拨号统一出口：在途拨号登记进 pendingDials，stop 之后完成的一律按「中止」处理并返回 null——
 * 成功的就地关闭（每个拨号 socket 都有确定的有界清理路径，不留无主连接），失败的不算投递失败
 * （与「成功拨号不计尝试」对称：stop 是截止点，其后的拨号结果不再有投递语义）。
 * 发送截止点也随之成立：停止后完成的拨号走不到「登记 + 发帧」。
 * 调用方对 null 的约定是「不发帧、不计尝试」。 */
async function dialPeer(state, options) {
  const pending = state.transport.dial(options);
  state.pendingDials.add(pending);
  try {
    const connection = await pending;
    if (state.stopped) {
      connection.close();
      return null;
    }
    return connection;
  } catch (error) {
    if (state.stopped) {
      return null;   // 停止期间的拨号失败：无连接可留、不计尝试与失败计数（对称于成功路径的就地关闭）
    }
    throw error;
  } finally {
    state.pendingDials.delete(pending);
  }
}

function adopt(state, connection) {
  connection.onFrame((frame) => {
    if (state.clientFrameRouter === null) {
      state.counters.clientFramesDropped++;
      return;
    }
    try {
      const result = state.clientFrameRouter(connection, frame);
      if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
        result.catch((error) => {
          state.log.error('拨号连接帧处理异常（异步）', { reason: error.message });
        });
      }
    } catch (error) {
      state.log.error('拨号连接帧处理异常', { reason: error.message });
    }
  });
}

function closeConnectionIfIdle(state, collabId, peer) {
  if (state.directActive.has(`${collabId}:${peer}`)) {
    return;   // 该连接上仍有在途直投（ack 等待面挂在其上）：不得关闭
  }
  const outbox = state.outboxes.get(collabId);
  if (outbox !== undefined && outbox.headFor(peer) === undefined) {
    const key = `${collabId}:${peer}`;
    const held = state.connections.get(key);
    if (held !== undefined) {
      held.connection.close();
      state.connections.delete(key);
    }
  }
}

function closeIdleConnections(state) {
  for (const [key, held] of [...state.connections]) {
    if (state.directActive.has(key)) {
      continue;   // 在途直投连接不是空闲连接（关闭会丢掉正在等待的 ack）
    }
    const outbox = state.outboxes.get(held.collabId);
    if (outbox === undefined || outbox.headFor(held.peer) === undefined) {
      held.connection.close();
      state.connections.delete(key);
    }
  }
}

function pruneAll(state, now) {
  let recycled = 0;
  for (const outbox of state.outboxes.values()) {
    const result = outbox.prune(now);
    recycled += result.dropped;
    if (result.expired.length > 0) {
      state.counters.expiredTotal += result.expired.length;
      state.log.warn('发送队列条目过期（未送达，查询入口可查）', { expired: result.expired });
    }
  }
  if (recycled > 0) {
    rebuildEntryIndex(state);   // 有回收才重建：稳态零开销
  }
}

/* 索引回收：条目被队列回收后 msgId 不再有用，长驻进程不能留「只增不删」的映射慢增长。
 * 按当前存活条目集重建等价于剔除陈旧项——索引只会因 send 与载入而写入，两者写的都是存活条目。 */
function rebuildEntryIndex(state) {
  state.entryIndex.clear();
  for (const [collabId, outbox] of state.outboxes) {
    for (const entry of outbox.entries()) {
      state.entryIndex.set(entry.msgId, collabId);
    }
  }
}

function frameOf(state, collabId, entry) {
  const frame = {
    v: PROTOCOL_VERSION,
    msgId: entry.msgId,
    type: entry.type,
    from: entry.from ?? state.self,   // 转达帧携带原发身份；缺省以本机身份盖章
    collabId,
    ts: entry.createdAt,
  };
  if (Array.isArray(entry.toSessions) && entry.toSessions.length > 0) {
    frame.toSessions = entry.toSessions;
  }
  if (entry.payload !== undefined) {
    frame.payload = entry.payload;
  }
  return withCollabCapability(frame);   // 0.2.0 硬断裂：协作域帧统一声明能力（与校验器同源）
}

function outboxFor(state, collabId) {
  let outbox = state.outboxes.get(collabId);
  if (outbox === undefined) {
    outbox = createOutbox({ dataDir: state.dataDir, collabId, config: state.config, log: state.log });
    state.outboxes.set(collabId, outbox);
    for (const entry of outbox.entries()) {
      state.entryIndex.set(entry.msgId, collabId);   // 载入的条目同样要能被 ack / 回报归属
    }
  }
  return outbox;
}

function ensureLoadedCollabs(state) {
  let names = [];
  try {
    names = readdirSync(join(state.dataDir, COLLABS_DIR_NAME), { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory() && ID_PATTERN.test(dirent.name))
      .map((dirent) => dirent.name);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      state.log.warn('协作目录列举失败（不退出进程）', { reason: error.message });
    }
  }
  for (const name of names) {
    outboxFor(state, name);
  }
}

function locate(state, msgId) {
  const collabId = state.entryIndex.get(msgId);
  if (collabId === undefined) {
    return null;
  }
  const outbox = state.outboxes.get(collabId);
  if (outbox === undefined) {
    return null;
  }
  const entry = outbox.entries().find((candidate) => candidate.msgId === msgId);
  if (entry === undefined) {
    return null;
  }
  return { collabId, outbox, entry };
}

function statusRow(collabId, entry) {
  let tier = 'queued';
  if (entry.state === 'session') {
    tier = 'session';
  } else if (entry.state === 'acked' || entry.ackedAt !== undefined) {
    tier = 'at-peer';
  }
  return {
    msgId: entry.msgId,
    collabId,
    type: entry.type,
    toInstanceId: entry.to.instanceId,
    fromSessionId: entry.from?.sessionId ?? entry.fromSessionId ?? null,
    toSessions: entry.toSessions ?? null,
    tier,
    expired: entry.state === 'expired',
    attempts: entry.attempts,
    createdAt: entry.createdAt,
    nextAttemptAt: new Date(entry.nextAttemptAt).toISOString(),
    ackedAt: entry.ackedAt ?? null,
    deliveredAt: entry.deliveredAt ?? null,
  };
}

/* 机器级状态查询（契约查询面）：按 msgId 取唯一一条队列行；未知返回 null。
 * 只加载协作目录、不启调度（与 deliveryStatus 查询同口径）。 */
function deliveryStatusOf(state, msgId) {
  if (!isIdLike(msgId)) {
    return null;
  }
  ensureLoadedCollabs(state);
  for (const [collabId, outbox] of state.outboxes) {
    const entry = outbox.entries().find((candidate) => candidate.msgId === msgId);
    if (entry !== undefined) {
      return statusRow(collabId, entry);
    }
  }
  return null;
}
