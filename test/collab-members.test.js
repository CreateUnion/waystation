import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collabFilePath } from '../src/paths.js';
import { makeTempDir } from './helpers.js';
import { MEMBERS_FILE_NAME, createMembersStore, foldMemberEvents, isMemberEventShape, newMemberEventId } from '../src/collab/members.js';

function quietLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function eventOf(overrides = {}) {
  return {
    eventId: newMemberEventId(),
    kind: 'join',
    instanceId: 'inst-a',
    identityName: '主机甲',
    ts: new Date().toISOString(),
    ...overrides,
  };
}

function makeStore(t, { collabId = 'collab-1', dataDir = null, log = quietLog() } = {}) {
  const dir = dataDir ?? makeTempDir(t);
  return { dir, store: createMembersStore({ dataDir: dir, collabId, log }) };
}

test('成员事件形态：合法通过；eventId / kind / instanceId / identityName / ts 逐字段非法拒', () => {
  assert.equal(isMemberEventShape(eventOf()), true);
  assert.equal(isMemberEventShape(eventOf({ kind: 'leave' })), true);
  assert.equal(isMemberEventShape(eventOf({ eventId: 'bad id!' })), false);
  assert.equal(isMemberEventShape(eventOf({ eventId: undefined })), false);
  assert.equal(isMemberEventShape(eventOf({ kind: 'close' })), false);
  assert.equal(isMemberEventShape(eventOf({ instanceId: '../x' })), false);
  assert.equal(isMemberEventShape(eventOf({ identityName: '   ' })), false);
  assert.equal(isMemberEventShape(eventOf({ ts: '昨天' })), false);
  assert.equal(isMemberEventShape(null), false);
});

test('并入与幂等：同事件 id 重放只留一份（duplicate）；形态不符 rejected 并计数', (t) => {
  const { store } = makeStore(t);
  const event = eventOf();
  assert.equal(store.apply(event), 'added');
  assert.equal(store.apply(event), 'duplicate', '同一事件重放（重播/重复路径）幂等');
  assert.equal(store.apply(eventOf({ eventId: event.eventId, instanceId: 'inst-b' })), 'duplicate', '同 id 视为同一事件（先到者为准）');
  assert.equal(store.apply({ ...eventOf(), kind: 'close' }), 'rejected');
  assert.equal(store.size(), 1);
  assert.equal(store.stats().duplicates, 2);
  assert.equal(store.stats().corruptRecords, 1);
});

test('折叠：每成员取自身最新事件；leave 出表；re-join 新事件重入；抗重放（旧 join 不复活）', (t) => {
  const { store } = makeStore(t);
  const early = '2026-10-13T00:00:00.000Z';
  const later = '2026-10-13T00:00:10.000Z';
  const aJoin = eventOf({ eventId: 'a-join-1', instanceId: 'inst-a', ts: early });
  const bJoin = eventOf({ eventId: 'b-join-1', instanceId: 'inst-b', identityName: '主机乙', ts: early });
  store.apply(aJoin);
  store.apply(bJoin);
  assert.deepEqual(store.fold().map((member) => member.instanceId), ['inst-a', 'inst-b']);
  store.apply(eventOf({ eventId: 'a-leave-1', kind: 'leave', instanceId: 'inst-a', ts: later }));
  assert.deepEqual(store.fold().map((member) => member.instanceId), ['inst-b'], '退出者即时出表');
  store.apply(aJoin);
  assert.deepEqual(store.fold().map((member) => member.instanceId), ['inst-b'], '旧 join 重放不复活已退出成员（抗重放）');
  store.apply(eventOf({ eventId: 'a-join-2', instanceId: 'inst-a', identityName: '主机甲改', ts: '2026-10-13T00:00:20.000Z' }));
  assert.deepEqual(store.fold().map((member) => member.instanceId), ['inst-a', 'inst-b'], 're-join = 新 join 事件（重入）');
  assert.equal(store.fold().find((member) => member.instanceId === 'inst-a').identityName, '主机甲改', '身份名随自身最新事件');
});

test('折叠的确定性：同 (ts, eventId) 兜底比较——乱序并入产出同一结果；对任意事件集可折叠', () => {
  const ts = '2026-10-13T00:00:00.000Z';
  const join = { eventId: 'evt-b', kind: 'join', instanceId: 'inst-a', identityName: '甲', ts };
  const leave = { eventId: 'evt-c', kind: 'leave', instanceId: 'inst-a', identityName: '甲', ts };
  const fromJoinFirst = foldMemberEvents([join, leave]);
  const fromLeaveFirst = foldMemberEvents([leave, join]);
  assert.deepEqual(fromJoinFirst, fromLeaveFirst, '按同一比较键折叠（同刻按事件 id 序兜底）');
  assert.deepEqual(fromJoinFirst, [], '同刻取事件 id 序大者（leave）');
});

test('落盘与重载：JSONL 持久、重载折叠结果一致；坏行跳过计数；同 id 重复行折叠', (t) => {
  const dir = makeTempDir(t);
  const first = createMembersStore({ dataDir: dir, collabId: 'collab-1', log: quietLog() });
  const event = eventOf({ eventId: 'evt-1' });
  first.apply(event);
  const second = createMembersStore({ dataDir: dir, collabId: 'collab-1', log: quietLog() });
  assert.equal(second.size(), 1);
  assert.deepEqual(second.events()[0], event);

  const file = collabFilePath(dir, 'collab-1', MEMBERS_FILE_NAME);
  appendFileSync(file, '{"半个对象\n');
  appendFileSync(file, `${JSON.stringify({ eventId: 'evt-bad', kind: 'close', instanceId: 'inst-a', identityName: '甲', ts: new Date().toISOString() })}\n`);
  appendFileSync(file, `${JSON.stringify(event)}\n`);
  const logs = [];
  const third = createMembersStore({ dataDir: dir, collabId: 'collab-1', log: { info: () => {}, warn: (message, fields) => logs.push({ message, fields }), error: () => {} } });
  assert.equal(third.size(), 1, '坏行与重复行不入列');
  assert.equal(third.stats().corruptRecords, 1, '形态不符的行计数');
  assert.ok(logs.some((entry) => entry.message.includes('残缺记录')), '坏行读取留痕');
});

test('读取失败：按空集继续（计数 + 告警、不抛出）', (t) => {
  const dir = makeTempDir(t);
  mkdirSync(collabFilePath(dir, 'collab-1', MEMBERS_FILE_NAME), { recursive: true });
  const logs = [];
  const store = createMembersStore({ dataDir: dir, collabId: 'collab-1', log: { info: () => {}, warn: (message) => logs.push(message), error: () => {} } });
  assert.equal(store.size(), 0);
  assert.equal(store.stats().persistFailures, 1);
  assert.ok(logs.some((message) => message.includes('读取失败')));
  assert.equal(store.apply(eventOf()), 'added', '写入受阻不改变并入语义（内存态继续）');
});

test('写盘失败：内存态继续（计数 + 告警、不抛出）', (t) => {
  const dir = makeTempDir(t);
  writeFileSync(join(dir, 'collabs'), '占用路径：协作目录无法创建');
  const logs = [];
  const store = createMembersStore({ dataDir: dir, collabId: 'collab-1', log: { info: () => {}, warn: (message) => logs.push(message), error: () => {} } });
  assert.equal(store.apply(eventOf()), 'added', '落盘失败不得中断协作主链');
  assert.equal(store.size(), 1);
  assert.equal(store.stats().persistFailures, 1);
  assert.ok(logs.some((message) => message.includes('写入失败')));
});

test('作者基线：latestEventOf / baselineTsOf 取自身事件最大 ts（跨重启落盘基线的读法）', (t) => {
  const { store } = makeStore(t);
  assert.equal(store.latestEventOf('inst-a'), null);
  assert.equal(store.baselineTsOf('inst-a'), null);
  store.apply(eventOf({ eventId: 'evt-1', instanceId: 'inst-a', ts: '2026-10-13T00:00:00.000Z' }));
  store.apply(eventOf({ eventId: 'evt-2', instanceId: 'inst-a', ts: '2026-10-13T00:00:05.000Z' }));
  store.apply(eventOf({ eventId: 'evt-3', instanceId: 'inst-b', identityName: '乙', ts: '2026-10-13T00:00:09.000Z' }));
  assert.equal(store.baselineTsOf('inst-a'), '2026-10-13T00:00:05.000Z');
  assert.equal(store.latestEventOf('inst-a').eventId, 'evt-2');
  assert.equal(store.baselineTsOf('inst-c'), null);
});
