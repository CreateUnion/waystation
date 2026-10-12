import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { COLLABS_DIR_NAME } from '../src/paths.js';
import { newMsgId } from '../src/net/protocol.js';
import { OUTBOX_FILE_NAME, createOutbox } from '../src/net/outbox.js';
import { makeTempDir } from './helpers.js';

function quietLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function testConfig(overrides = {}) {
  return {
    retryIntervalMs: 100,
    retrySlowIntervalMs: 200,
    retryFastCount: 2,
    queueMaxPerCollab: 3,
    messageTtlMs: 50,
    ...overrides,
  };
}

function makeOutbox(t, { dataDir, config } = {}) {
  const dir = dataDir ?? makeTempDir(t);
  const outbox = createOutbox({
    dataDir: dir,
    collabId: 'collab-1',
    config: config ?? testConfig(),
    log: quietLog(),
  });
  return { dir, outbox, file: join(dir, COLLABS_DIR_NAME, 'collab-1', OUTBOX_FILE_NAME) };
}

function sendInput(overrides = {}) {
  return {
    msgId: newMsgId(),
    to: { instanceId: 'inst-b', address: '127.0.0.2' },
    type: 'notice',
    payload: { text: '你好' },
    ts: new Date().toISOString(),
    ...overrides,
  };
}

test('enqueue：落盘为协作目录下 outbox.jsonl，重启可续读', (t) => {
  const { dir, outbox, file } = makeOutbox(t);
  const input = sendInput();
  assert.deepEqual(outbox.enqueue(input), { ok: true });
  assert.equal(existsSync(file), true);
  const reopened = createOutbox({ dataDir: dir, collabId: 'collab-1', config: testConfig(), log: quietLog() });
  assert.equal(reopened.size(), 1);
  const entry = reopened.entries()[0];
  assert.equal(entry.msgId, input.msgId);
  assert.equal(entry.state, 'queued');
  assert.equal(entry.attempts, 0);
  assert.equal(entry.governance, false);
  assert.deepEqual(entry.to, { instanceId: 'inst-b', address: '127.0.0.2' });
  assert.equal(entry.payload.text, '你好');
});

test('状态推进历史：重开时折叠（文件行数收敛为条目数）', (t) => {
  const { dir, outbox, file } = makeOutbox(t);
  const input = sendInput();
  outbox.enqueue(input);
  outbox.markAttempt(input.msgId, Date.now());
  outbox.markAttempt(input.msgId, Date.now());
  outbox.markAcked(input.msgId, Date.now());
  assert.ok(readFileSync(file, 'utf8').trim().split('\n').length >= 4);
  const reopened = createOutbox({ dataDir: dir, collabId: 'collab-1', config: testConfig(), log: quietLog() });
  assert.equal(reopened.entries().length, 1);
  assert.equal(reopened.entries()[0].state, 'acked');
  assert.equal(reopened.entries()[0].attempts, 2);
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 1);
});

test('压缩触发：重试追加超「条目数 × 倍率」即压缩，长会话文件行数有界', (t) => {
  const { outbox, file } = makeOutbox(t, { config: testConfig({ messageTtlMs: 600000 }) });
  const input = sendInput();
  outbox.enqueue(input);
  for (let i = 0; i < 50; i++) {
    outbox.markAttempt(input.msgId, Date.now() + i);
    outbox.prune(Date.now() + i);   // 无过期/回收事件：压缩只能由追加行数阈值触发
  }
  const lines = readFileSync(file, 'utf8').trim().split('\n').length;
  assert.ok(lines <= 4, `50 次重试后文件行数应保持有界，实际 ${lines} 行`);
  assert.ok(outbox.stats().compactions >= 1);
});

test('容量：未完成条目达上限即拒绝；终态条目释放名额', (t) => {
  const { outbox } = makeOutbox(t);
  const first = sendInput();
  outbox.enqueue(first);
  outbox.enqueue(sendInput());
  outbox.enqueue(sendInput());
  const rejected = outbox.enqueue(sendInput());
  assert.equal(rejected.ok, false);
  assert.ok(rejected.reason.includes('队列已满'));
  outbox.markSessionDelivered(first.msgId, Date.now());
  assert.deepEqual(outbox.enqueue(sendInput()), { ok: true });
});

test('容量：治理类通告豁免上限', (t) => {
  const { outbox } = makeOutbox(t);
  outbox.enqueue(sendInput());
  outbox.enqueue(sendInput());
  outbox.enqueue(sendInput());
  const takeover = sendInput({ type: 'takeover' });
  assert.deepEqual(outbox.enqueue(takeover), { ok: true });
  assert.equal(outbox.entries().find((entry) => entry.msgId === takeover.msgId).governance, true);
});

test('容量：上限只计非治理条目；治理类不占配额且随时可入', (t) => {
  const { outbox } = makeOutbox(t);
  for (let i = 0; i < 5; i++) {   // 治理条数超上限也不拒绝：治理类不受容量约束
    assert.deepEqual(outbox.enqueue(sendInput({ type: 'takeover' })), { ok: true });
  }
  for (let i = 0; i < 3; i++) {   // 治理积压不占名额：普通消息仍可用满全部配额
    assert.deepEqual(outbox.enqueue(sendInput()), { ok: true });
  }
  const rejected = outbox.enqueue(sendInput());
  assert.equal(rejected.ok, false);
  assert.ok(rejected.reason.includes('队列已满'));
  assert.deepEqual(outbox.enqueue(sendInput({ type: 'freeze' })), { ok: true });   // 普通消息满额后治理仍可入
});

test('过期：超保留期的未完成条目在 prune 时标记 expired 并列入回报', (t) => {
  const { outbox } = makeOutbox(t);
  const stale = sendInput({ ts: new Date(Date.now() - 60).toISOString() });
  outbox.enqueue(stale);
  const fresh = sendInput();
  outbox.enqueue(fresh);
  const result = outbox.prune(Date.now());
  assert.deepEqual(result.expired, [stale.msgId]);
  assert.equal(outbox.entries().find((entry) => entry.msgId === stale.msgId).state, 'expired');
  assert.equal(outbox.entries().find((entry) => entry.msgId === fresh.msgId).state, 'queued');
});

test('过期：治理类未送达前豁免；送达后按普通规则回收', (t) => {
  const { outbox } = makeOutbox(t);
  const governance = sendInput({ type: 'takeover', ts: new Date(Date.now() - 60).toISOString() });
  outbox.enqueue(governance);
  assert.deepEqual(outbox.prune(Date.now()).expired, []);
  assert.equal(outbox.entries()[0].state, 'queued');
  const deliveredAt = Date.now();
  outbox.markSessionDelivered(governance.msgId, deliveredAt);
  assert.deepEqual(outbox.prune(deliveredAt + 51).dropped, 1);
  assert.equal(outbox.size(), 0);
});

test('终态记录：按「终态时刻 + 保留期」回收', (t) => {
  const { outbox } = makeOutbox(t);
  const input = sendInput();
  outbox.enqueue(input);
  const deliveredAt = Date.now();
  outbox.markSessionDelivered(input.msgId, deliveredAt);
  assert.deepEqual(outbox.prune(deliveredAt + 10), { expired: [], dropped: 0 });
  assert.deepEqual(outbox.prune(deliveredAt + 51), { expired: [], dropped: 1 });
});

test('units/headFor：按对端分单元；head 取最老 queued；acked 不阻塞后续', (t) => {
  const { outbox } = makeOutbox(t, { config: testConfig({ queueMaxPerCollab: 100 }) });
  const older = sendInput();
  const newer = sendInput();
  outbox.enqueue(older);
  outbox.enqueue(newer);
  outbox.enqueue(sendInput({ to: { instanceId: 'inst-c', address: '127.0.0.3' } }));
  assert.deepEqual(outbox.units().sort(), ['inst-b', 'inst-c']);
  assert.equal(outbox.headFor('inst-b').msgId, older.msgId);
  outbox.markAcked(older.msgId, Date.now());
  assert.equal(outbox.headFor('inst-b').msgId, newer.msgId);
  outbox.markSessionDelivered(newer.msgId, Date.now());
  assert.equal(outbox.headFor('inst-b'), undefined);
  assert.deepEqual(outbox.units(), ['inst-c']);
});

test('markAttempt 节律：快重传期内用 retryIntervalMs，之后转 retrySlowIntervalMs', (t) => {
  const { outbox } = makeOutbox(t, { config: testConfig({ retryFastCount: 2, retryIntervalMs: 100, retrySlowIntervalMs: 200 }) });
  const input = sendInput();
  outbox.enqueue(input);
  outbox.markAttempt(input.msgId, 1000);
  assert.equal(outbox.entries()[0].nextAttemptAt, 1100);
  outbox.markAttempt(input.msgId, 1100);
  assert.equal(outbox.entries()[0].nextAttemptAt, 1200);
  outbox.markAttempt(input.msgId, 1200);
  assert.equal(outbox.entries()[0].nextAttemptAt, 1400);
});

test('状态推进：未知 msgId 与重复调用均为无操作（幂等、不抛）', (t) => {
  const { outbox } = makeOutbox(t);
  assert.equal(outbox.markAttempt('nope', Date.now()), false);
  assert.equal(outbox.markAcked('nope', Date.now()), false);
  assert.equal(outbox.markSessionDelivered('nope', Date.now()), false);
  const input = sendInput();
  outbox.enqueue(input);
  assert.equal(outbox.markAcked(input.msgId, Date.now()), true);
  assert.equal(outbox.markAcked(input.msgId, Date.now()), false);
  assert.equal(outbox.entries()[0].state, 'acked');
});

test('载入：非本协作/结构非法记录跳过并计数', (t) => {
  const dir = makeTempDir(t);
  const file = join(dir, COLLABS_DIR_NAME, 'collab-1', OUTBOX_FILE_NAME);
  mkdirSync(join(dir, COLLABS_DIR_NAME, 'collab-1'), { recursive: true });   // 直接写文件前先建协作目录
  const good = {
    msgId: newMsgId(), collabId: 'collab-1', to: { instanceId: 'inst-b', address: '127.0.0.2' },
    type: 'notice', governance: false, state: 'queued', attempts: 0,
    createdAt: new Date().toISOString(), nextAttemptAt: Date.now(),
  };
  writeFileSync(file, [
    JSON.stringify(good),
    JSON.stringify({ ...good, msgId: newMsgId(), collabId: 'collab-9' }),
    JSON.stringify({ msgId: newMsgId(), state: 'flying' }),
    JSON.stringify(42),
  ].join('\n') + '\n');
  const outbox = createOutbox({ dataDir: dir, collabId: 'collab-1', config: testConfig(), log: quietLog() });
  assert.equal(outbox.size(), 1);
  assert.ok(outbox.stats().corruptRecords >= 3);
});

test('载入：读失败按空队列继续（计数 + 告警，不向调用方抛出）', (t) => {
  const dir = makeTempDir(t);
  const file = join(dir, COLLABS_DIR_NAME, 'collab-1', OUTBOX_FILE_NAME);
  mkdirSync(file, { recursive: true });   // 目录占位：读取必得非 ENOENT 错误（EISDIR，Windows/Linux 一致）
  const warnings = [];
  const log = { info: () => {}, warn: (message, detail) => warnings.push({ message, detail }), error: () => {} };
  const outbox = createOutbox({ dataDir: dir, collabId: 'collab-1', config: testConfig(), log });
  assert.equal(outbox.size(), 0);
  assert.equal(outbox.stats().persistFailures, 1);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].message.includes('读取失败'));
  assert.equal(warnings[0].detail.collabId, 'collab-1');
  assert.match(warnings[0].detail.reason, /EISDIR/);
});

test('入队：落盘失败即回滚（未落盘即不承诺），不留内存条目', (t) => {
  const { outbox, file } = makeOutbox(t);
  mkdirSync(file, { recursive: true });   // 目录占位：追加写必失败（EISDIR，Windows/Linux 一致）
  const before = outbox.stats().persistFailures;
  const result = outbox.enqueue(sendInput());
  assert.equal(result.ok, false);
  assert.ok(result.reason.includes('落盘失败'));
  assert.equal(outbox.size(), 0);
  assert.equal(outbox.headFor('inst-b'), undefined);
  assert.equal(outbox.stats().persistFailures, before + 1);
});
