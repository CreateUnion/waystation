import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { COLLABS_DIR_NAME } from '../src/paths.js';
import { createOutbox, OUTBOX_FILE_NAME } from '../src/net/outbox.js';
import { newMsgId } from '../src/net/protocol.js';
import { makeTempDir } from './helpers.js';

const CONFIG = {
  queueMaxPerCollab: 100,
  messageTtlMs: 600000,
  retryFastCount: 2,
  retryIntervalMs: 60,
  retrySlowIntervalMs: 120,
};

function silentLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function makeOutbox(dataDir, collabId = 'collab-1') {
  return createOutbox({ dataDir, collabId, config: CONFIG, log: silentLog() });
}

const FROM = { instanceId: 'inst-self', identityName: '本机', port: 7321, sessionId: 'sess-self' };

function enqueue(outbox, overrides = {}) {
  return outbox.enqueue({
    msgId: newMsgId(),
    to: { instanceId: 'inst-b', address: '127.0.0.2', port: 7321 },
    type: 'reply',
    payload: { text: '你好' },
    ts: new Date().toISOString(),
    from: FROM,
    fromSessionId: 'sess-self',
    toSessions: ['sess-b1', 'sess-b2'],
    ...overrides,
  });
}

test('outbox：机器级条目保留 from.sessionId 与 toSessions（一机一帧的目标集合）', (t) => {
  const dir = makeTempDir(t);
  const outbox = makeOutbox(dir);
  const msgId = newMsgId();
  assert.equal(enqueue(outbox, { msgId }).ok, true);
  const [entry] = outbox.entries();
  assert.equal(entry.msgId, msgId);
  assert.equal(entry.from.sessionId, 'sess-self');
  assert.equal(entry.fromSessionId, 'sess-self');
  assert.deepEqual(entry.toSessions, ['sess-b1', 'sess-b2']);
  assert.equal(outbox.size(), 1, '两席共用一条机器级条目——不得按席位拆条');
});

test('outbox：toSessions 去重后持久化，重开队列原样恢复', (t) => {
  const dir = makeTempDir(t);
  const msgId = newMsgId();
  assert.equal(enqueue(makeOutbox(dir), { msgId, toSessions: ['sess-b1', 'sess-b1', 'sess-b2'] }).ok, true);
  const reopened = makeOutbox(dir);
  const [entry] = reopened.entries();
  assert.equal(entry.msgId, msgId);
  assert.deepEqual(entry.toSessions, ['sess-b1', 'sess-b2']);
  assert.equal(entry.from.sessionId, 'sess-self');
  assert.equal(entry.fromSessionId, 'sess-self');
});

test('outbox：toSessions 非法（空 / 非数组 / 坏标识）受理面拒绝', (t) => {
  const outbox = makeOutbox(makeTempDir(t));
  for (const toSessions of [[], 'sess-a', [42], ['bad id!'], null]) {
    const result = enqueue(outbox, { toSessions });
    assert.equal(result.ok, false, JSON.stringify(toSessions));
    assert.ok(result.reason.includes('toSessions'), result.reason);
  }
  assert.equal(outbox.size(), 0);
});

test('outbox：from.sessionId 非法的记录按损坏跳过并计数（拒绝优于猜测）', (t) => {
  const dir = makeTempDir(t);
  mkdirSync(join(dir, COLLABS_DIR_NAME, 'collab-1'), { recursive: true });
  const bad = {
    msgId: 'msg-bad', collabId: 'collab-1',
    to: { instanceId: 'inst-b', address: '127.0.0.2', port: 7321 },
    type: 'reply', payload: { text: 'x' }, governance: false, state: 'queued', attempts: 0,
    createdAt: new Date().toISOString(), nextAttemptAt: Date.now(),
    from: { instanceId: 'inst-self', identityName: '本机', port: 7321, sessionId: 'bad id!' },
  };
  writeFileSync(join(dir, COLLABS_DIR_NAME, 'collab-1', OUTBOX_FILE_NAME), JSON.stringify(bad) + '\n');
  const outbox = makeOutbox(dir);
  assert.equal(outbox.size(), 0);
  assert.equal(outbox.stats().corruptRecords, 1);
});

test('outbox：ack 不是终态，回报后才到 session（机器级两档）', (t) => {
  const outbox = makeOutbox(makeTempDir(t));
  const msgId = newMsgId();
  enqueue(outbox, { msgId });
  assert.equal(outbox.markAcked(msgId, Date.now()), true);
  assert.equal(outbox.entries()[0].state, 'acked');
  assert.equal(outbox.unfinished().length, 1, 'acked 仍是未完成条目——只有回报建立终态');
  assert.equal(outbox.markSessionDelivered(msgId, Date.now()), true);
  assert.equal(outbox.entries()[0].state, 'session');
  assert.equal(outbox.unfinished().length, 0);
});
