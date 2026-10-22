import { randomUUID } from 'node:crypto';

/* 邀请决定的用户确认门（2026-10-19 产品裁定）：同意 / 拒绝邀请默认**必须用户明确确认**，
 * 与 Claude Code 的权限模式（含 auto mode）无关——工具层首次调用只签发一次性确认挑战，
 * 代理须把邀请转述给用户、取得同意后携令牌重试才生效。用户明确表示「下一次无需确认」时，
 * 代理可登记**一次性豁免**（ws_allow_next_invite），下一次决定直接生效并消耗豁免。
 *
 * 存储是核心内存态（不落盘）：核心重启后挑战与豁免全部失效——宁多问一次，不静默放行。
 * 挑战绑定「会话 × 协作」，单次使用；TTL 10 分钟；表满按插入序淘汰（防伪造洪泛的写放大）。 */

export const INVITE_CONFIRM_TTL_MS = 10 * 60 * 1000;
const CHALLENGE_TABLE_MAX = 64;

function keyOf(sessionId, collabId) {
  return `${sessionId}\u0000${collabId}`;
}

/* 签发确认挑战（同会话同协作重签＝旧令牌作废，只认最新一次）。返回令牌。 */
export function issueInviteChallenge(state, { sessionId, collabId, now = Date.now() }) {
  const table = state.inviteConsent.challenges;
  pruneExpired(table, now);
  const token = randomUUID();
  table.set(keyOf(sessionId, collabId), { token, expiresAt: now + INVITE_CONFIRM_TTL_MS });
  while (table.size > CHALLENGE_TABLE_MAX) {
    table.delete(table.keys().next().value);
  }
  return token;
}

/* 消费确认挑战：令牌、会话、协作三者全对且未过期才放行；成功即删除（单次使用）。 */
export function consumeInviteChallenge(state, { sessionId, collabId, token, now = Date.now() }) {
  if (typeof token !== 'string' || token === '') {
    return false;
  }
  const table = state.inviteConsent.challenges;
  pruneExpired(table, now);
  const key = keyOf(sessionId, collabId);
  const held = table.get(key);
  if (held === undefined || held.token !== token || held.expiresAt <= now) {
    return false;
  }
  table.delete(key);
  return true;
}

/* 一次性豁免：仅在用户明确表示「下一次无需确认」时登记；下一次决定直接生效并立即消耗。 */
export function grantInviteWaiver(state, { sessionId }) {
  state.inviteConsent.waivers.set(sessionId, true);
}

export function consumeInviteWaiver(state, { sessionId }) {
  if (state.inviteConsent.waivers.get(sessionId) !== true) {
    return false;
  }
  state.inviteConsent.waivers.delete(sessionId);
  return true;
}

/* 会话级免确认（只免「同意」）：用户在会话内显式开启后，本会话的同意邀请不再逐条确认；
 * 拒绝邀请仍走确认门。按 sessionId 登记、纯内存态——会话结束（新会话新标识）自然失效，
 * 核心重启亦失效（沿用「宁多问一次」的安全口径）。 */
export function grantSessionAutoAccept(state, { sessionId }) {
  state.inviteConsent.autoAccept.add(sessionId);
}

export function revokeSessionAutoAccept(state, { sessionId }) {
  return state.inviteConsent.autoAccept.delete(sessionId);
}

export function hasSessionAutoAccept(state, { sessionId }) {
  return state.inviteConsent.autoAccept.has(sessionId);
}

function pruneExpired(table, now) {
  for (const [key, held] of table) {
    if (held.expiresAt <= now) {
      table.delete(key);
    }
  }
}
