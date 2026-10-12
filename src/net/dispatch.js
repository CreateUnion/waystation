import { readdirSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { COLLABS_DIR_NAME } from '../paths.js';
import { ID_PATTERN, MESSAGE_TYPES, PROTOCOL_VERSION, TRANSPORT_TYPES, newMsgId } from './protocol.js';
import { createOutbox } from './outbox.js';

/* 发送调度（设计 §10）：按「协作 × 对端」单元串行投递（FIFO 保序），ack 推进，超时重传。
 * 节律：首投立即；未 ack 的重试恒定 retryIntervalMs，连续 retryFastCount 次后转 retrySlowIntervalMs，
 * 直至送达 / 过期——节律参数与容量、过期的权威在 outbox，本层只驱动「何时再试一次」。
 * 半开连接检测：重试必重拨（旧连接关闭）——应用层 ack 与超时是唯一判据（设计 §5/§10）。
 * 拨号连接上的回程帧（ack / pong / 投递回报）统一经 setClientFrameRouter 注入的路由器转交接收管线
 * （生产路径由装配层注入 inbound.onFrame）；未接线时帧计数丢弃。
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
    connections: new Map(),    // 单元键 → { connection, collabId, peer }
    pendingPings: new Map(),   // ping msgId → { resolve, startedAt, timer }
    counters: emptyCounters(),
    clientFrameRouter: null,
    timer: null,
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
  ensureLoadedCollabs(state);
  state.timer = setInterval(() => {
    tick(state);
  }, state.config.dispatchTickMs);
  if (typeof state.timer.unref === 'function') {
    state.timer.unref();   // 定时器不阻止进程退出：会话关闭即退出是产品语义
  }
}

function stop(state) {
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
  const msgId = newMsgId();
  const outbox = outboxFor(state, collabId);
  const result = outbox.enqueue({ msgId, to: { instanceId: to.instanceId, address: to.address }, type, payload, ts: new Date().toISOString() });
  if (!result.ok) {
    state.counters.sendsRejected++;
    return result;
  }
  state.entryIndex.set(msgId, collabId);
  return { ok: true, msgId, tier: 'queued' };
}

/* send 参数校验：任一不合法即返回统一拒绝原因（点名参数清单），合法返回 null。 */
function sendRejection(collabId, to, type) {
  const argsReason = 'send 参数非法（collabId / to.instanceId / to.address / type，地址须为 IP 字面量）';
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
    connection = await state.transport.dial({ address, port, timeoutMs: state.config.dialTimeoutMs });
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
  try {
    const key = `${collabId}:${entry.to.instanceId}`;
    const connection = await obtainConnection(state, key, collabId, entry);
    connection.send(frameOf(state, collabId, entry));
    state.counters.attempts++;
  } catch (error) {
    state.counters.deliveryFailures++;
    state.log.warn('投递失败，按节律重试', { msgId: entry.msgId, peer: entry.to.instanceId, reason: error.message });
  } finally {
    outbox.markAttempt(entry.msgId, Date.now());   // 成功与失败都计一次尝试：失败也要退避，不得每 tick 重拨
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
  const connection = await state.transport.dial({ address: entry.to.address, port: state.config.port, timeoutMs: state.config.dialTimeoutMs });
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
  for (const outbox of state.outboxes.values()) {
    const result = outbox.prune(now);
    if (result.expired.length > 0) {
      state.counters.expiredTotal += result.expired.length;
      state.log.warn('发送队列条目过期（未送达，查询入口可查）', { expired: result.expired });
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
