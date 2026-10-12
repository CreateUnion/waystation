import { readdirSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { COLLABS_DIR_NAME } from '../paths.js';
import { ID_PATTERN, MAX_FRAME_BYTES, MESSAGE_TYPES, PROTOCOL_VERSION, TRANSPORT_TYPES, isPort, newMsgId, validateMessage } from './protocol.js';
import { createOutbox } from './outbox.js';

/* 发送调度（设计 §10）：按「协作 × 对端」单元串行投递（FIFO 保序），ack 推进，超时重传。
 * 节律：首投立即；未 ack 的重试恒定 retryIntervalMs，连续 retryFastCount 次后转 retrySlowIntervalMs，
 * 直至送达 / 过期——节律参数与容量、过期的权威在 outbox，本层只驱动「何时再试一次」。
 * 半开连接检测：重试必重拨（旧连接关闭）——应用层 ack 与超时是唯一判据（设计 §5/§10）。
 * 拨号连接上的回程帧（ack / pong / 投递回报）统一经 setClientFrameRouter 注入的路由器转交接收管线
 * （生产路径由装配层注入 inbound.onFrame）；未接线时帧计数丢弃。
 * deliveryStatus 查询按需惰性载入协作目录（幂等）：未 start 的降级态也能看到落盘的历史队列——
 * 查询只加载，不启 tick、不调度。
 * stop() 是发送截止点：停止后醒来的在途投递一律不发帧，在途拨号完成即关（连同探测在内一并收口）；
 * stop() 返回的 promise 在在途拨号全部落地后 resolve——resolve 即无无主连接。
 * 一切异常（拨号失败、写失败、调度循环内任何错误）都被捕获记录，绝不退出进程（健壮性硬性要求）。 */
export function createDispatch({ dataDir, config, transport, self, log }) {
  const state = {
    dataDir,
    config,
    transport,
    self,
    log,
    outboxes: new Map(),
    entryIndex: new Map(),     // msgId → collabId（ack / 回报的归属查找）
    inFlight: new Set(),       // 单元键（一次只投一条）
    pendingDials: new Set(),   // 在途拨号 promise（stop 收口等它们落地，不留无主连接）
    connections: new Map(),    // 单元键 → { connection, collabId, peer }
    pendingPings: new Map(),   // ping msgId → { resolve, startedAt, timer }
    counters: emptyCounters(),
    clientFrameRouter: null,
    timer: null,
    stopped: false,            // 发送截止点：stop 置位、start 复位
  };
  return {
    start: () => start(state),
    stop: () => stop(state),
    send: (message) => send(state, message),
    onAck: (msgId) => onAck(state, msgId),
    onDeliveryReport: (payload) => onDeliveryReport(state, payload),
    resolvePong: (frame) => resolvePong(state, frame),
    ping: (options) => ping(state, options),
    deliveryStatus: (query) => deliveryStatus(state, query),
    setClientFrameRouter: (router) => {
      state.clientFrameRouter = router;
    },
    stats: () => statsOf(state),
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
 * 连上后会成为没人跟踪的活连接。返回的 promise 在全部在途拨号落地后 resolve。 */
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
  await Promise.allSettled([...state.pendingDials]);
}

function send(state, { collabId, to, type, payload }) {
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
  if (!Number.isInteger(state.self.port) || state.self.port < 1 || state.self.port > 65535) {
    state.counters.sendsRejected++;
    return { ok: false, reason: 'from.port 非法（1–65535 的整数）：本机站点端口未就位（构造侧必填）' };
  }
  const msgId = newMsgId();
  const ts = new Date().toISOString();
  const payloadRejection = frameRejectionOf(frameOf(state, collabId, { msgId, type, payload, createdAt: ts }));
  if (payloadRejection !== null) {
    state.counters.sendsRejected++;
    return { ok: false, reason: payloadRejection };
  }
  const outbox = outboxFor(state, collabId);
  const result = outbox.enqueue({ msgId, to: { instanceId: to.instanceId, address: to.address, port: to.port }, type, payload, ts });
  if (!result.ok) {
    state.counters.sendsRejected++;
    return result;
  }
  state.entryIndex.set(msgId, collabId);
  return { ok: true, msgId, tier: 'queued' };
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

function onAck(state, msgId) {
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
  ensureLoadedCollabs(state);   // 查询路径惰性载入（幂等）：未 start 也能看到落盘的历史队列；只加载，不启 tick、不调度
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
  return rows.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

function statsOf(state) {
  return {
    ...state.counters,
    collabs: state.outboxes.size,
    inFlight: state.inFlight.size,
    connections: state.connections.size,
    pendingPings: state.pendingPings.size,
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
  const connection = await dialPeer(state, { address: entry.to.address, port: entry.to.port, timeoutMs: state.config.dialTimeoutMs });
  if (connection === null) {
    return null;   // 停止收口后才完成的拨号：连接已被收口关闭，不得登记、不得发帧
  }
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
    from: state.self,
    collabId,
    ts: entry.createdAt,
  };
  if (entry.payload !== undefined) {
    frame.payload = entry.payload;
  }
  return frame;
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
    tier,
    expired: entry.state === 'expired',
    attempts: entry.attempts,
    createdAt: entry.createdAt,
    nextAttemptAt: new Date(entry.nextAttemptAt).toISOString(),
    ackedAt: entry.ackedAt ?? null,
    deliveredAt: entry.deliveredAt ?? null,
  };
}
