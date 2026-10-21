import { ID_PATTERN } from '../net/protocol.js';

/* 会话短码（对外表示）：sessionId 前 8 字符——不假设十六进制（标识形态仅受 ID_PATTERN 约束）。
 * 匹配一律精确比较：完整标识按全等、短码按 shortSessionId 全等；不做前缀展开。
 * 零命中/歧义/非法输入一律按「指定会话不在场」处置。 */
export const SHORT_ID_CHARS = 8;

export function shortSessionId(sessionId) {
  return typeof sessionId === 'string' ? sessionId.slice(0, SHORT_ID_CHARS) : '';
}

export function isSessionShortCode(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= SHORT_ID_CHARS && ID_PATTERN.test(value);
}

/* 短码精确匹配：只接受短码形态；命中的席位短码必须唯一。 */
export function matchSessionByShort(sessions, short) {
  if (!isSessionShortCode(short) || !Array.isArray(sessions)) {
    return null;
  }
  const matched = sessions.filter((entry) => typeof entry?.sessionId === 'string' && shortSessionId(entry.sessionId) === short);
  return matched.length === 1 ? matched[0].sessionId : null;
}

/* 用户可输入完整标识或短码：先按完整 sessionId 全等，再按短码全等；两者都不做前缀展开。
 * 歧义（短码多命中）与非法输入返回 null，由调用方拒绝。 */
export function matchSessionByToken(sessions, token) {
  if (typeof token !== 'string' || token === '' || !ID_PATTERN.test(token) || !Array.isArray(sessions)) {
    return null;
  }
  const exact = sessions.filter((entry) => entry?.sessionId === token);
  if (exact.length > 1) {
    return null;
  }
  if (exact.length === 1) {
    return exact[0].sessionId;
  }
  return matchSessionByShort(sessions, token);
}
