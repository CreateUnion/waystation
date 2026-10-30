import { randomUUID } from 'node:crypto';

/* 确认门（invite / join）的会话级覆盖、永久令牌与自动批准通知队列。
 * 纯内存：会话覆盖在核心重启后清空；永久值落 config.json，由服务层先写盘再改内存。
 * 优先级固定为「会话覆盖 > config 默认」；gateValueOf 是唯一读法，避免两处各判一套。 */

export const CONFIRM_GATE_SESSION_MAX = 256;
export const CONFIRM_GATE_TOKEN_TTL_MS = 10 * 60 * 1000;
const TOKEN_TABLE_MAX = 64;
const NOTICE_QUEUE_MAX = 64;
const GATE_CONFIG_KEYS = {
  invite: 'inviteConfirmation',
  join: 'joinRequestConfirmation',
  claim: 'dispatchClaimConfirmation',
};

export function createConfirmGateState() {
  return { sessions: new Map(), tokens: new Map(), notices: [] };
}

export function isConfirmGate(value) {
  return value === 'invite' || value === 'join' || value === 'claim';
}

export function gateConfigKey(gate) {
  return GATE_CONFIG_KEYS[gate];
}

export function gateValueOf(state, sessionId, gate) {
  const override = state.confirmGates.sessions.get(sessionId);
  const raw = override?.[gate];
  const sessionValue = typeof raw === 'boolean' ? raw : null;
  const configValue = state.config?.[GATE_CONFIG_KEYS[gate]] !== false;
  return {
    sessionValue,
    configValue,
    effectiveValue: sessionValue === null ? configValue : sessionValue,
  };
}

export function setSessionGate(state, sessionId, gate, value, now = Date.now()) {
  pruneConfirmGates(state, now);
  const entry = state.confirmGates.sessions.get(sessionId) ?? {
    invite: undefined,
    join: undefined,
    claim: undefined,
    graceUntil: null,
    updatedAt: now,
  };
  entry[gate] = value;
  entry.updatedAt = now;
  state.confirmGates.sessions.set(sessionId, entry);
}

export function clearSessionGate(state, sessionId, gate) {
  const entry = state.confirmGates.sessions.get(sessionId);
  if (entry === undefined) {
    return false;
  }
  entry[gate] = undefined;
  if (entry.invite === undefined && entry.join === undefined && entry.claim === undefined) {
    state.confirmGates.sessions.delete(sessionId);
  }
  return true;
}

export function markConfirmGateClosed(state, sessionId, now = Date.now()) {
  const entry = state.confirmGates.sessions.get(sessionId);
  if (entry === undefined) {
    return;
  }
  const graceMs = Number.isInteger(state.config?.sessionSeatGraceMs) ? state.config.sessionSeatGraceMs : 60000;
  entry.graceUntil = now + graceMs;
}

export function markConfirmGateOpen(state, sessionId) {
  const entry = state.confirmGates.sessions.get(sessionId);
  if (entry !== undefined) {
    entry.graceUntil = null;
  }
}

export function pruneConfirmGates(state, now = Date.now()) {
  let removed = 0;
  for (const [sessionId, entry] of state.confirmGates.sessions) {
    if (entry.graceUntil !== null && entry.graceUntil <= now) {
      state.confirmGates.sessions.delete(sessionId);
      removed++;
    }
  }
  return removed;
}

/* 在线/宽限内会话不淘汰；Map 超过上限只留痕，由服务层决定日志。 */
export function confirmGateOverCap(state) {
  return state.confirmGates.sessions.size > CONFIRM_GATE_SESSION_MAX;
}

export function issueConfirmToken(state, { sessionId, action, gate, value, now = Date.now() }) {
  pruneTokens(state, now);
  const token = randomUUID();
  state.confirmGates.tokens.set(token, {
    sessionId,
    action,
    gate,
    value: typeof value === 'boolean' ? value : null,
    expiresAt: now + CONFIRM_GATE_TOKEN_TTL_MS,
  });
  while (state.confirmGates.tokens.size > TOKEN_TABLE_MAX) {
    state.confirmGates.tokens.delete(state.confirmGates.tokens.keys().next().value);
  }
  return token;
}

export function consumeConfirmToken(state, { sessionId, action, gate, value, token, now = Date.now() }) {
  if (typeof token !== 'string' || token === '') {
    return false;
  }
  pruneTokens(state, now);
  const held = state.confirmGates.tokens.get(token);
  if (held === undefined) {
    return false;
  }
  const wanted = typeof value === 'boolean' ? value : null;
  if (held.sessionId !== sessionId || held.action !== action || held.gate !== gate || held.value !== wanted) {
    return false;
  }
  state.confirmGates.tokens.delete(token);
  return true;
}

/* 自动批准通知的有界队列：站长桥离线时先排队，注册补投时按 sessionId 取回。
 * 溢出直接丢弃并返回 false，调用方计 dropped；队列满不得阻塞批准主链。 */
export function queueConfirmGateNotice(state, notice) {
  const queue = state.confirmGates.notices;
  if (queue.length >= NOTICE_QUEUE_MAX) {
    return false;
  }
  queue.push(notice);
  return true;
}

export function takeConfirmGateNotices(state, sessionId) {
  const queue = state.confirmGates.notices;
  const taken = queue.filter((entry) => entry.sessionId === sessionId);
  state.confirmGates.notices = queue.filter((entry) => entry.sessionId !== sessionId);
  return taken;
}

function pruneTokens(state, now) {
  for (const [token, held] of state.confirmGates.tokens) {
    if (held.expiresAt <= now) {
      state.confirmGates.tokens.delete(token);
    }
  }
}
