import { randomUUID } from 'node:crypto';
import { MAX_TOPIC_CHARS, isIdentityName, isPresentationText } from '../net/protocol.js';
import { shortSessionId } from '../util/short-id.js';

/* dispatch 内存域：与 managed / forum 同级的第三种模式，但不进 state.collabs、不写任何协作文件。
 * 状态全部在 state.dispatches（Map<collabId, record>）。本模块只做纯内存判定与组帧；
 * 消息投递经注入的 notify（routing.notify），不碰 LAN 出站队列 / 本机席位注入 / inbox 落盘。 */

export const DISPATCH_MESSAGE_TYPES = ['topic', 'task', 'progress', 'issue', 'stop', 'reply', 'result', 'error'];
export const DISPATCH_QUEUE_MAX = 256;
export const DISPATCH_CLAIM_TTL_MS = 10 * 60 * 1000;
export const DISPATCH_META_FRESH_MS = 5 * 60 * 1000;
export const DISPATCH_MEMBER_EVENT_DEBOUNCE_MS = 500;

export function createDispatchDomain(deps) {
  const { state, now = Date.now } = deps;
  const sessionMetaOf = deps.sessionMetaOf ?? (() => null);
  const listSessionIds = deps.listSessionIds ?? (() => []);
  const metaOf = (sessionId) => normalizeMeta(sessionMetaOf(sessionId), sessionId);
  const isInteractiveOf = (meta) => meta !== null
    && meta.kind === 'interactive'
    && meta.metaUpdatedAt > 0
    && now() - meta.metaUpdatedAt <= DISPATCH_META_FRESH_MS;
  const masterDispatchOf = (sessionId) => masterDispatchOfIn(state, sessionId);
  const dispatchOf = (sessionId) => dispatchOfIn(state, sessionId, masterDispatchOf);
  return {
    dispatches: state.dispatches,
    metaOf,
    isInteractiveOf,
    masterDispatchOf,
    dispatchOf,
    create: (input) => createDispatchIn(state, metaOf, now, input),
    scan: (input) => scanSessionsIn(state, masterDispatchOf, metaOf, listSessionIds, input),
    list: () => listDispatchesIn(state),
    describe: (collabId) => describeDispatchIn(state, collabId),
    view: (collabId) => viewDispatchIn(state, collabId),
    status: () => statusOfDispatches(state),
    isDispatch: (collabId) => state.dispatches.has(collabId),
  };
}

/* 会话元数据归一（桥上报的原始记录 → dispatch 域内形状）：名字非法时用会话短码兜底
 * （不是完整 sessionId——全量标识适合定位、不适合展示）。 */
function normalizeMeta(raw, sessionId) {
  if (!isMetaRecord(raw)) {
    return null;
  }
  return {
    sessionId,
    name: metaNameOf(raw, sessionId),
    kind: raw.kind === 'interactive' ? 'interactive' : 'unknown',
    entrypoint: textOrNull(raw.entrypoint),
    status: textOrNull(raw.status),
    role: roleOf(raw.role),
    masterName: isIdentityName(raw.masterName) ? raw.masterName.trim() : null,
    metaUpdatedAt: Number.isFinite(raw.metaUpdatedAt) ? raw.metaUpdatedAt : 0,
    online: raw.online !== false,
  };
}

function isMetaRecord(value) {
  return value !== null && value !== undefined && typeof value === 'object';
}

function metaNameOf(raw, sessionId) {
  return isIdentityName(raw.name) ? raw.name.trim() : shortSessionId(sessionId);
}

function textOrNull(value) {
  return typeof value === 'string' ? value : null;
}

function roleOf(value) {
  return value === 'master' || value === 'slave' ? value : 'none';
}

function masterDispatchOfIn(state, sessionId) {
  for (const record of state.dispatches.values()) {
    if (record.masterSessionId === sessionId) {
      return record;
    }
  }
  return null;
}

function dispatchOfIn(state, sessionId, masterDispatchOf) {
  const master = masterDispatchOf(sessionId);
  if (master !== null) {
    return master;
  }
  for (const record of state.dispatches.values()) {
    if (record.slaves.has(sessionId)) {
      return record;
    }
  }
  return null;
}

function createDispatchIn(state, metaOf, now, { name, topic, sessionId }) {
  const meta = metaOf(sessionId);
  if (meta === null || meta.role !== 'master') {
    return { ok: false, message: 'dispatch 只能由启动期 WAYSTATION_ROLE=master 的会话创建——工具参数与聊天内容不能声明 master 角色' };
  }
  if (state.dispatches.size > 0) {
    return { ok: false, message: '一个核心同一时刻只允许一个 dispatch——先结束现有 dispatch' };
  }
  if (!isIdentityName(name)) {
    return { ok: false, message: 'dispatch 名称非法：需要 1–64 字符且不含控制字符' };
  }
  if (topic !== undefined && topic !== null && !isPresentationText(topic, MAX_TOPIC_CHARS)) {
    return { ok: false, message: `dispatch 主题非法：需要不超过 ${MAX_TOPIC_CHARS} 字符` };
  }
  const collabId = randomUUID();
  const record = {
    collabId,
    mode: 'dispatch',
    ephemeral: true,
    name: name.trim(),
    topic: typeof topic === 'string' && topic.trim() !== '' ? topic.trim() : null,
    masterSessionId: sessionId,
    masterName: meta.name,
    createdAt: new Date(now()).toISOString(),
    slaves: new Map(),
    claims: new Map(),
    queues: new Map(),
    grace: new Map(),
    pendingEvents: [],
    eventTimer: null,
  };
  state.dispatches.set(collabId, record);
  return { ok: true, collabId, mode: 'dispatch', ephemeral: true, name: record.name, topic: record.topic };
}

function scanSessionsIn(state, masterDispatchOf, metaOf, listSessionIds, { sessionId }) {
  const record = masterDispatchOf(sessionId);
  if (record === null) {
    return { ok: false, code: 'dispatch-lost', message: 'dispatch 不存在（可能已结束或核心已重启）——请重新创建' };
  }
  const sessions = [];
  for (const target of listSessionIds()) {
    if (target === sessionId) {
      continue;
    }
    const meta = metaOf(target);
    if (meta === null) {
      continue;
    }
    sessions.push({
      sessionId: target,
      name: meta.name,
      kind: meta.kind,
      entrypoint: meta.entrypoint,
      role: meta.role,
      status: meta.status,
      claimedBy: record.slaves.has(target) ? record.masterSessionId : null,
    });
  }
  return { ok: true, dispatchId: record.collabId, sessions };
}

function listDispatchesIn(state) {
  return [...state.dispatches.values()].map((record) => ({
    collabId: record.collabId,
    name: record.name,
    mode: 'dispatch',
    ephemeral: true,
    topic: record.topic,
    masterSessionId: record.masterSessionId,
    slaveCount: record.slaves.size,
    createdAt: record.createdAt,
  }));
}

function describeDispatchIn(state, collabId) {
  const record = state.dispatches.get(collabId);
  if (record === undefined) {
    return null;
  }
  return { collabId, name: record.name, mode: 'dispatch', ephemeral: true, topic: record.topic };
}

function viewDispatchIn(state, collabId) {
  const record = state.dispatches.get(collabId);
  if (record === undefined) {
    return { ok: false, message: '本机没有该 dispatch（可能已结束或核心已重启）' };
  }
  return {
    ok: true, collabId, mode: 'dispatch', ephemeral: true,
    message: 'dispatch 不保存历史：无台账、无帖、无收件流水、无观察窗回放',
  };
}

function statusOfDispatches(state) {
  const records = [...state.dispatches.values()];
  if (records.length === 0) {
    return { ok: true, dispatch: null };
  }
  const record = records[0];
  return {
    ok: true,
    dispatch: {
      collabId: record.collabId,
      name: record.name,
      masterSessionId: record.masterSessionId,
      slaves: [...record.slaves.values()].map((slave) => ({
        sessionId: slave.sessionId, name: slave.name, kind: slave.kind,
      })),
    },
  };
}
