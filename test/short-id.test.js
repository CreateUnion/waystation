import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHORT_ID_CHARS, isSessionShortCode, matchSessionByShort, matchSessionByToken, shortSessionId } from '../src/util/short-id.js';

test('shortSessionId：前 8 字符；短于 8 原样；非字符串空串', () => {
  assert.equal(SHORT_ID_CHARS, 8);
  assert.equal(shortSessionId('f0822792-64f2-4792-818a-721cd3debaa5'), 'f0822792');
  assert.equal(shortSessionId('seg-a'), 'seg-a');
  assert.equal(shortSessionId(null), '');
  assert.equal(shortSessionId(42), '');
});

test('isSessionShortCode：1–8 位标识字符；空 / 超长 / 非法字符 / 非字符串拒', () => {
  assert.equal(isSessionShortCode('f0822792'), true);
  assert.equal(isSessionShortCode('seg-a'), true);
  assert.equal(isSessionShortCode('a'), true);
  assert.equal(isSessionShortCode('f0822792-64f2'), false, '超过短码长度不是短码');
  assert.equal(isSessionShortCode(''), false);
  assert.equal(isSessionShortCode('a.b'), false);
  assert.equal(isSessionShortCode('a/b'), false);
  assert.equal(isSessionShortCode('a b'), false);
  assert.equal(isSessionShortCode(42), false);
  assert.equal(isSessionShortCode(null), false);
});

test('matchSessionByShort：只做短码相等比较——零命中 / 歧义 / 非法一律 null', () => {
  const sessions = [
    { sessionId: 'f0822792-aaaa' },
    { sessionId: 'f0822792-bbbb' },
    { sessionId: 'deadbeef-cccc' },
    { sessionId: 'seg-a' },
  ];
  assert.equal(matchSessionByShort(sessions, 'deadbeef'), 'deadbeef-cccc');
  assert.equal(matchSessionByShort(sessions, 'seg-a'), 'seg-a');
  assert.equal(matchSessionByShort(sessions, 'f0822792'), null, '短码歧义＝拒绝');
  assert.equal(matchSessionByShort(sessions, 'f08227'), null, '不做前缀展开');
  assert.equal(matchSessionByShort(sessions, 'nope'), null);
  assert.equal(matchSessionByShort(sessions, ''), null);
  assert.equal(matchSessionByShort(sessions, 'bad code'), null);
  assert.equal(matchSessionByShort('not-an-array', 'deadbeef'), null);
});

test('matchSessionByToken：完整标识按精确相等、短码按精确短码；前缀不做展开', () => {
  const sessions = [
    { sessionId: 'f0822792-aaaa' },
    { sessionId: 'f0822792-bbbb' },
    { sessionId: 'deadbeef-cccc' },
    { sessionId: 'seg-a' },
  ];
  assert.equal(matchSessionByToken(sessions, 'deadbeef-cccc'), 'deadbeef-cccc', '完整标识精确命中');
  assert.equal(matchSessionByToken(sessions, 'f0822792-aaaa'), 'f0822792-aaaa');
  assert.equal(matchSessionByToken(sessions, 'deadbeef'), 'deadbeef-cccc', '短码精确命中');
  assert.equal(matchSessionByToken(sessions, 'seg-a'), 'seg-a', '完整标识优先于短码');
  assert.equal(matchSessionByToken(sessions, 'deadbeef-cc'), null, '完整标识的前缀不匹配');
  assert.equal(matchSessionByToken(sessions, 'f0822792'), null, '短码歧义＝拒绝');
  assert.equal(matchSessionByToken(sessions, 'seg'), null, '无精确短码');
  assert.equal(matchSessionByToken(sessions, ''), null);
  assert.equal(matchSessionByToken(sessions, 42), null);
});
