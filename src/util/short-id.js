/* 会话短码（对外表示）：sessionId 前 8 字符——不假设十六进制（标识形态仅受 ID_PATTERN 约束）。
 * 对外一律短码；接收侧在在册会话上做唯一前缀匹配，零命中/歧义一律按「指定会话不在场」处置
 * （来源：2026-10-16 会话级管理设计 §0/§3）。 */
export const SHORT_ID_CHARS = 8;

export function shortSessionId(sessionId) {
  return typeof sessionId === 'string' ? sessionId.slice(0, SHORT_ID_CHARS) : '';
}

export function matchSessionByShort(sessions, short) {
  if (typeof short !== 'string' || short === '') {
    return null;
  }
  const matched = sessions.filter((entry) => typeof entry?.sessionId === 'string' && entry.sessionId.startsWith(short));
  return matched.length === 1 ? matched[0].sessionId : null;
}
