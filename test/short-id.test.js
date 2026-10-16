import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHORT_ID_CHARS, shortSessionId, matchSessionByShort } from '../src/util/short-id.js';

test('shortSessionId：前 8 字符；短于 8 原样；非字符串空串', () => {
  assert.equal(SHORT_ID_CHARS, 8);
  assert.equal(shortSessionId('f0822792-64f2-4792-818a-721cd3debaa5'), 'f0822792');
  assert.equal(shortSessionId('seg-a'), 'seg-a');
  assert.equal(shortSessionId(null), '');
  assert.equal(shortSessionId(42), '');
});

test('matchSessionByShort：唯一前缀命中全量标识；零命中/歧义→null', () => {
  /* 夹具：前 8 字符彼此可区分（唯一前缀命中的前提），且 seg-a/seg-b 保留共同前缀（歧义用例）。 */
  const sessions = [{ sessionId: 'seg-a-session' }, { sessionId: 'seg-b-session' }, { sessionId: 'other-1' }];
  assert.equal(matchSessionByShort(sessions, 'seg-a-session'), 'seg-a-session');
  assert.equal(matchSessionByShort(sessions, 'seg-a-session'.slice(0, 8)), 'seg-a-session');
  assert.equal(matchSessionByShort(sessions, 'seg-'), null, '前缀歧义＝不在场');
  assert.equal(matchSessionByShort(sessions, 'nope'), null);
  assert.equal(matchSessionByShort(sessions, ''), null);
});
