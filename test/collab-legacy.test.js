import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir } from './helpers.js';
import {
  createLegacyRejectionCounter,
  isLegacyCollab,
  markLegacyCompleted,
  readLegacyCollab,
} from '../src/collab/legacy.js';

const TS = '2026-10-21T08:00:00.000Z';

function legacyMember(overrides = {}) {
  return {
    collabId: 'collab-1',
    role: 'member',
    state: 'active',
    name: '旧协作',
    topic: '旧主题',
    mode: 'managed',
    manager: { instanceId: 'inst-a', identityName: '主机甲' },
    roster: [
      { instanceId: 'inst-a', identityName: '主机甲' },
      { instanceId: 'inst-b', identityName: '主机乙' },
    ],
    endpoints: { 'inst-a': { address: '127.0.0.1', port: 17321 } },
    decision: null,
    ...overrides,
  };
}

function legacyLedger(version, overrides = {}) {
  return {
    version,
    collabId: 'collab-1',
    name: '旧协作',
    topic: '旧主题',
    status: 'active',
    manager: { instanceId: 'inst-a', identityName: '主机甲' },
    members: [
      { instanceId: 'inst-a', identityName: '主机甲', role: 'manager', state: 'member', joinedAt: TS },
      { instanceId: 'inst-b', identityName: '主机乙', role: 'member', state: 'member', joinedAt: TS },
    ],
    board: [],
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

function legacySnapshot(ledger, overrides = {}) {
  return {
    version: ledger.version,
    digest: 'a'.repeat(64),
    receivedAt: TS,
    from: { instanceId: 'inst-a', identityName: '主机甲' },
    ledger,
    ...overrides,
  };
}

function collabDirOf(t, id = 'collab-1') {
  const dir = join(makeTempDir(t), id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(dir, name, value) {
  writeFileSync(join(dir, name), JSON.stringify(value));
}

function writeLedger(dir, rows) {
  writeFileSync(join(dir, 'ledger.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
}

test('isLegacyCollab：旧 member.json 且无新标记才是 legacy', (t) => {
  const legacy = collabDirOf(t, 'a');
  writeJson(legacy, 'member.json', legacyMember());
  assert.equal(isLegacyCollab(legacy), true);

  const marked = collabDirOf(t, 'b');
  writeJson(marked, 'member.json', legacyMember());
  writeJson(marked, 'carrier.json', { format: 'session-seats' });
  assert.equal(isLegacyCollab(marked), false);

  const stub = collabDirOf(t, 'c');
  writeJson(stub, 'member.json', legacyMember());
  writeJson(stub, 'carrier.json', { format: 'invite-stub' });
  assert.equal(isLegacyCollab(stub), false);

  /* 只有 format 标记即可排除 legacy——整档形态坏掉不改变「新形态目录」这一事实。 */
  const corruptMarked = collabDirOf(t, 'd');
  writeJson(corruptMarked, 'member.json', legacyMember());
  writeJson(corruptMarked, 'carrier.json', { format: 'session-seats', version: 0 });
  assert.equal(isLegacyCollab(corruptMarked), false);

  /* 未知 format 不是标记：仍按旧形态判。 */
  const unknownFormat = collabDirOf(t, 'e');
  writeJson(unknownFormat, 'member.json', legacyMember());
  writeJson(unknownFormat, 'carrier.json', { format: 'member-v1' });
  assert.equal(isLegacyCollab(unknownFormat), true);

  const migrated = collabDirOf(t, 'f');
  writeJson(migrated, 'member.json', legacyMember());
  writeJson(migrated, 'migration.json', { legacy: true, archivedAt: TS, reason: 'legacy-format' });
  assert.equal(isLegacyCollab(migrated), false);

  const recovering = collabDirOf(t, 'g');
  writeJson(recovering, 'member.json', legacyMember());
  writeJson(recovering, 'recovery.json', { state: 'half-created', at: TS, reason: 'carrier-without-ledger' });
  assert.equal(isLegacyCollab(recovering), false);

  const empty = collabDirOf(t, 'h');
  assert.equal(isLegacyCollab(empty), false);
  assert.equal(isLegacyCollab(join(empty, 'absent')), false);
});

test('readLegacyCollab：以最后一条合法台账行取摘要，旧形态不受新校验器影响', (t) => {
  const dir = collabDirOf(t);
  writeJson(dir, 'member.json', legacyMember());
  writeLedger(dir, [
    legacyLedger(1),
    legacyLedger(2, {
      status: 'frozen',
      members: [{ instanceId: 'inst-a', identityName: '主机甲', role: 'manager', state: 'member', joinedAt: TS }],
    }),
  ]);

  const summary = readLegacyCollab(dir);
  assert.equal(summary.legacy, true);
  assert.equal(summary.readOnly, true);
  assert.equal(summary.collabId, 'collab-1');
  assert.equal(summary.name, '旧协作');
  assert.equal(summary.topic, '旧主题');
  assert.equal(summary.mode, 'managed');
  /* 旧协作按设计显示为 completed 只读；最后已知状态另字段保留。 */
  assert.equal(summary.state, 'completed');
  assert.equal(summary.sourceState, 'frozen');
  assert.equal(summary.role, 'member');
  assert.equal(summary.memberCount, 1);
  assert.deepEqual(summary.roster, [
    { instanceId: 'inst-a', identityName: '主机甲', role: 'manager', state: 'member' },
  ]);
  assert.deepEqual(summary.manager, { instanceId: 'inst-a', identityName: '主机甲' });
  assert.deepEqual(summary.warnings, []);
});

test('readLegacyCollab：无台账时回退快照，再无则用成员记录定格名单', (t) => {
  const withSnapshot = collabDirOf(t, 'a');
  writeJson(withSnapshot, 'member.json', legacyMember());
  writeJson(withSnapshot, 'snapshot.json', legacySnapshot(legacyLedger(4, { status: 'completed' })));
  const fromSnapshot = readLegacyCollab(withSnapshot);
  assert.equal(fromSnapshot.sourceState, 'completed');
  assert.equal(fromSnapshot.memberCount, 2);
  assert.equal(fromSnapshot.roster[1].identityName, '主机乙');

  const memberOnly = collabDirOf(t, 'b');
  writeJson(memberOnly, 'member.json', legacyMember({ state: 'frozen' }));
  const fromMember = readLegacyCollab(memberOnly);
  assert.equal(fromMember.sourceState, 'frozen');
  assert.equal(fromMember.memberCount, 2);
  assert.deepEqual(fromMember.roster, [
    { instanceId: 'inst-a', identityName: '主机甲', role: null, state: null },
    { instanceId: 'inst-b', identityName: '主机乙', role: null, state: null },
  ]);
});

test('readLegacyCollab：损坏的 member.json 降级到台账并留告警', (t) => {
  const dir = collabDirOf(t);
  writeFileSync(join(dir, 'member.json'), '{ broken');
  writeLedger(dir, [legacyLedger(1)]);
  const summary = readLegacyCollab(dir);
  assert.equal(summary.role, null);
  assert.equal(summary.name, '旧协作');
  assert.equal(summary.memberCount, 2);
  assert.equal(summary.warnings.length, 1);
  assert.match(summary.warnings[0], /member\.json/);
});

test('readLegacyCollab：尾部半行只忽略不截断，读取零写盘', (t) => {
  const dir = collabDirOf(t);
  writeJson(dir, 'member.json', legacyMember());
  const complete = JSON.stringify(legacyLedger(1));
  const partial = '{"version":2,"collabId":"collab-1"';
  writeFileSync(join(dir, 'ledger.jsonl'), `${complete}\n${partial}`);
  const before = readFileSync(join(dir, 'ledger.jsonl'), 'utf8');
  const filesBefore = readdirSync(dir).sort();

  const summary = readLegacyCollab(dir);
  assert.equal(summary.memberCount, 2);
  assert.equal(summary.warnings.length, 1);
  assert.match(summary.warnings[0], /ledger\.jsonl/);
  assert.equal(readFileSync(join(dir, 'ledger.jsonl'), 'utf8'), before);
  assert.deepEqual(readdirSync(dir).sort(), filesBefore);
});

test('readLegacyCollab：旧讨论用成员事件折叠当前名单', (t) => {
  const dir = collabDirOf(t);
  writeJson(dir, 'member.json', legacyMember({ mode: 'forum' }));
  const events = [
    { eventId: 'event-1', kind: 'join', instanceId: 'inst-a', identityName: '主机甲', ts: TS },
    { eventId: 'event-2', kind: 'join', instanceId: 'inst-b', identityName: '主机乙', ts: TS },
    { eventId: 'event-3', kind: 'leave', instanceId: 'inst-b', identityName: '主机乙', ts: '2026-10-21T09:00:00.000Z' },
  ];
  writeFileSync(join(dir, 'members.jsonl'), events.map((event) => JSON.stringify(event)).join('\n') + '\n');

  const summary = readLegacyCollab(dir);
  assert.equal(summary.mode, 'forum');
  assert.equal(summary.memberCount, 1);
  assert.deepEqual(summary.roster, [{ instanceId: 'inst-a', identityName: '主机甲', role: null, state: null }]);
});

test('readLegacyCollab：归档后的旧目录仍可读并带 archivedAt', (t) => {
  const dir = collabDirOf(t);
  writeJson(dir, 'member.json', legacyMember());
  writeLedger(dir, [legacyLedger(1)]);
  assert.equal(markLegacyCompleted(dir, { now: TS }).ok, true);

  assert.equal(isLegacyCollab(dir), false);
  const summary = readLegacyCollab(dir);
  assert.equal(summary.legacy, true);
  assert.equal(summary.readOnly, true);
  assert.equal(summary.archivedAt, TS);
  assert.equal(summary.memberCount, 2);
});

test('readLegacyCollab：非 legacy 目录返回 null', (t) => {
  const dir = collabDirOf(t);
  writeJson(dir, 'carrier.json', { format: 'session-seats' });
  assert.equal(readLegacyCollab(dir), null);
});

test('旧版对端/旧协作写路径拒绝计数：函数级累计且快照为副本', () => {
  const counter = createLegacyRejectionCounter();
  assert.deepEqual(counter.read(), { legacyInboundRejected: 0, legacyWriteRejected: 0 });
  assert.equal(counter.noteInbound(), 1);
  assert.equal(counter.noteInbound(2), 3);
  assert.equal(counter.noteWrite(), 1);
  const snapshot = counter.read();
  assert.deepEqual(snapshot, { legacyInboundRejected: 3, legacyWriteRejected: 1 });
  counter.noteWrite();
  assert.deepEqual(snapshot, { legacyInboundRejected: 3, legacyWriteRejected: 1 });
  assert.throws(() => counter.noteWrite(0), TypeError);
});
