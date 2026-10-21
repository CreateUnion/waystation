import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDir } from './helpers.js';
import { createMembersStore, foldMemberEvents, isMemberEventShape, newMemberEventId } from '../src/collab/members.js';

/* 讨论成员事件的席位口径（设计 §2.2/§4.5/§10）：成员＝会话，事件携 (instanceId, sessionId) 两个键；
 * 旧档案（0.1.x 事件无 sessionId）退回按实例折叠——两种历史记录都要能读，且不互相吞并。 */

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

function makeStore(t, { collabId = 'collab-1' } = {}) {
  const dir = makeTempDir(t);
  return { dir, store: createMembersStore({ dataDir: dir, collabId, log: quietLog() }) };
}

test('事件形态：sessionId 可选——合法席位键通过，非法形态整条拒收', () => {
  assert.equal(isMemberEventShape(eventOf({ sessionId: 'sess-a' })), true, '带席位键的事件合法');
  assert.equal(isMemberEventShape(eventOf()), true, '旧事件无席位键仍合法（既有档案可读）');
  assert.equal(isMemberEventShape(eventOf({ sessionId: '' })), false, '空串不是席位键');
  assert.equal(isMemberEventShape(eventOf({ sessionId: 42 })), false, '非字符串不是席位键');
  assert.equal(isMemberEventShape(eventOf({ sessionId: 'bad id!' })), false, '含非法字符的席位键拒收');
  assert.equal(isMemberEventShape(eventOf({ sessionId: 'x'.repeat(65) })), false, '超长席位键拒收');
});

test('折叠按席位：同机两会话各一行，一个会话 leave 只出该行（另一会话不受影响）', (t) => {
  const { store } = makeStore(t);
  store.apply(eventOf({ eventId: 'b1-join', instanceId: 'inst-b', sessionId: 'sess-b1', ts: '2026-10-21T00:00:00.000Z' }));
  store.apply(eventOf({ eventId: 'b2-join', instanceId: 'inst-b', sessionId: 'sess-b2', ts: '2026-10-21T00:00:01.000Z' }));
  assert.deepEqual(store.fold(), [
    { instanceId: 'inst-b', identityName: '主机甲', sessionId: 'sess-b1' },
    { instanceId: 'inst-b', identityName: '主机甲', sessionId: 'sess-b2' },
  ], '同机双会话在成员表各占一行');
  store.apply(eventOf({ eventId: 'b1-leave', kind: 'leave', instanceId: 'inst-b', sessionId: 'sess-b1', ts: '2026-10-21T00:00:02.000Z' }));
  assert.deepEqual(store.fold().map((member) => member.sessionId), ['sess-b2'], '离席只出自己那一行');
});

test('同会话 join/leave 语义不变：最新事件定状态，旧 join 重放不复活', (t) => {
  const { store } = makeStore(t);
  const join = eventOf({ eventId: 'join-1', instanceId: 'inst-b', sessionId: 'sess-b1', ts: '2026-10-21T00:00:00.000Z' });
  store.apply(join);
  store.apply(eventOf({ eventId: 'leave-1', kind: 'leave', instanceId: 'inst-b', sessionId: 'sess-b1', ts: '2026-10-21T00:00:10.000Z' }));
  assert.deepEqual(store.fold(), [], 'leave 后出表');
  store.apply(join);
  assert.deepEqual(store.fold(), [], '旧 join 重放不复活已退出会话（抗重放）');
  store.apply(eventOf({ eventId: 'join-2', instanceId: 'inst-b', sessionId: 'sess-b1', ts: '2026-10-21T00:00:20.000Z' }));
  assert.deepEqual(store.fold().map((member) => member.sessionId), ['sess-b1'], 're-join = 新 join 事件重入');
});

test('旧事件无 sessionId：退回按实例折叠（既有档案的折叠结果不变）', () => {
  const folded = foldMemberEvents([
    { eventId: 'a-1', kind: 'join', instanceId: 'inst-a', identityName: '甲', ts: '2026-10-13T00:00:00.000Z' },
    { eventId: 'a-2', kind: 'join', instanceId: 'inst-a', identityName: '甲', ts: '2026-10-13T00:00:05.000Z' },
  ]);
  assert.deepEqual(folded, [{ instanceId: 'inst-a', identityName: '甲' }], '同实例旧事件仍折成一行（不按事件条数展开）');
  assert.equal('sessionId' in folded[0], false, '缺席位键时不编造');
});

test('旧实例级事件与席位级事件各成一行：两类历史记录不互相吞并', () => {
  const folded = foldMemberEvents([
    { eventId: 'old', kind: 'join', instanceId: 'inst-a', identityName: '甲', ts: '2026-10-13T00:00:00.000Z' },
    { eventId: 'seat-1', kind: 'join', instanceId: 'inst-a', identityName: '甲', sessionId: 'sess-a1', ts: '2026-10-21T00:00:00.000Z' },
    { eventId: 'seat-2', kind: 'join', instanceId: 'inst-a', identityName: '甲', sessionId: 'sess-a2', ts: '2026-10-21T00:00:01.000Z' },
  ]);
  assert.deepEqual(folded, [
    { instanceId: 'inst-a', identityName: '甲' },
    { instanceId: 'inst-a', identityName: '甲', sessionId: 'sess-a1' },
    { instanceId: 'inst-a', identityName: '甲', sessionId: 'sess-a2' },
  ], '实例级旧行与两个席位行并存（按事件自带的键分组）');
});

test('折叠确定性：同席位乱序并入产出同一结果；输出按实例、再按会话排序', () => {
  const first = { eventId: 'e1', kind: 'join', instanceId: 'inst-a', identityName: '甲', sessionId: 'sess-2', ts: '2026-10-21T00:00:00.000Z' };
  const second = { eventId: 'e2', kind: 'join', instanceId: 'inst-a', identityName: '甲', sessionId: 'sess-1', ts: '2026-10-21T00:00:00.000Z' };
  assert.deepEqual(foldMemberEvents([first, second]), foldMemberEvents([second, first]), '并入顺序不影响折叠结果');
  assert.deepEqual(foldMemberEvents([first, second]).map((member) => member.sessionId), ['sess-1', 'sess-2'], '同实例按会话标识排序');
});

test('落盘重载：席位键随事件持久，重载后折叠一致', (t) => {
  const dir = makeTempDir(t);
  const event = eventOf({ eventId: 'evt-seat', instanceId: 'inst-b', sessionId: 'sess-b1' });
  const first = createMembersStore({ dataDir: dir, collabId: 'collab-1', log: quietLog() });
  first.apply(event);
  const second = createMembersStore({ dataDir: dir, collabId: 'collab-1', log: quietLog() });
  assert.deepEqual(second.fold(), [{ instanceId: 'inst-b', identityName: '主机甲', sessionId: 'sess-b1' }], '重载后席位行仍可折叠');
});
