import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collabFilePath } from '../src/paths.js';
import { makeTempDir } from './helpers.js';
import { POSTS_FILE_NAME, createPostsStore, displayOrderOf, isPostEntryShape, newPostId } from '../src/collab/posts.js';

function quietLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function entryOf(overrides = {}) {
  return {
    entryId: 'post-1',
    seq: 1,
    ts: new Date().toISOString(),
    from: { instanceId: 'inst-a', identityName: '主机甲' },
    kind: 'reply',
    text: '你好',
    ...overrides,
  };
}

function makeStore(t, { collabId = 'collab-1', dataDir = null, log = quietLog() } = {}) {
  const dir = dataDir ?? makeTempDir(t);
  return { dir, store: createPostsStore({ dataDir: dir, collabId, log }) };
}

test('帖条目形态：合法通过；entryId / seq / ts / from / kind / text 逐字段非法拒', () => {
  assert.equal(isPostEntryShape(entryOf()), true);
  assert.equal(isPostEntryShape(entryOf({ entryId: 'bad id!' })), false);
  assert.equal(isPostEntryShape(entryOf({ entryId: undefined })), false);
  assert.equal(isPostEntryShape(entryOf({ seq: 0 })), false);
  assert.equal(isPostEntryShape(entryOf({ seq: 1.5 })), false);
  assert.equal(isPostEntryShape(entryOf({ ts: '不是时间' })), false);
  assert.equal(isPostEntryShape(entryOf({ from: { instanceId: 'inst-a' } })), false);
  assert.equal(isPostEntryShape(entryOf({ from: { instanceId: 'bad id!', identityName: '甲' } })), false);
  assert.equal(isPostEntryShape(entryOf({ kind: '笔记' })), false);
  assert.equal(isPostEntryShape(entryOf({ kind: 'note' })), false, '看板私有 kind 不是帖的徽标词表');
  assert.equal(isPostEntryShape(entryOf({ text: '   ' })), false);
  assert.equal(isPostEntryShape(entryOf({ text: 'x'.repeat(4001) })), false);
  assert.equal(isPostEntryShape(entryOf({ text: 'x'.repeat(4000) })), true);
  assert.equal(isPostEntryShape(null), false);
  for (const kind of ['topic', 'task', 'progress', 'issue', 'stop', 'reply']) {
    assert.equal(isPostEntryShape(entryOf({ kind })), true, kind);
  }
});

test('追加与去重：同作者同 postId 只入列一次；不同作者同 postId 各留一份；形态不符不入列', (t) => {
  const { store, dir } = makeStore(t);
  assert.equal(store.append(entryOf()), true);
  assert.equal(store.append(entryOf()), false, '重复副本不入列');
  assert.equal(store.has('inst-a', 'post-1'), true);
  assert.equal(store.has('inst-b', 'post-1'), false);
  assert.equal(store.append(entryOf({ from: { instanceId: 'inst-b', identityName: '主机乙' } })), true, '不同作者同 postId 各留一份（去重键含作者）');
  assert.equal(store.append({ ...entryOf({ entryId: 'post-2' }), kind: '越表' }), false, '形态不符拒绝');
  assert.equal(store.size(), 2);
  assert.equal(store.stats().appended, 2);
  assert.ok(collabFilePath(dir, 'collab-1', POSTS_FILE_NAME).length > 0);
});

test('落盘与重载：JSONL 持久、重载恢复条目；坏行跳过计数；同键重复行折叠为先到者', (t) => {
  const dir = makeTempDir(t);
  const first = createPostsStore({ dataDir: dir, collabId: 'collab-1', log: quietLog() });
  const entry = entryOf({ entryId: newPostId(), text: '第一条' });
  assert.equal(first.append(entry), true);
  const second = createPostsStore({ dataDir: dir, collabId: 'collab-1', log: quietLog() });
  assert.equal(second.size(), 1);
  assert.deepEqual(second.entries()[0], entry);

  const file = collabFilePath(dir, 'collab-1', POSTS_FILE_NAME);
  appendFileSync(file, '{"半个对象\n');
  appendFileSync(file, `${JSON.stringify({ entryId: 'post-shape-bad', seq: 1, ts: new Date().toISOString(), from: { instanceId: 'inst-a', identityName: '主机甲' }, kind: '越表', text: 'x' })}\n`);
  appendFileSync(file, `${JSON.stringify(entry)}\n`);   // 同键重复行：折叠（内容等价，先到者为准）
  const logs = [];
  const third = createPostsStore({ dataDir: dir, collabId: 'collab-1', log: { info: () => {}, warn: (message, fields) => logs.push({ message, fields }), error: () => {} } });
  assert.equal(third.size(), 1, '坏行与重复行不入列');
  assert.equal(third.stats().corruptRecords, 1, '形态不符的行计数');
  assert.ok(logs.some((entryLog) => entryLog.message.includes('残缺记录')), '坏行读取留痕');
});

test('读取失败：按空列表继续（计数 + 告警、不抛出）', (t) => {
  const dir = makeTempDir(t);
  mkdirSync(collabFilePath(dir, 'collab-1', POSTS_FILE_NAME), { recursive: true });   // 目录占据文件路径：读取与写入都会抛错
  const logs = [];
  const log = { info: () => {}, warn: (message) => logs.push(message), error: () => {} };
  const store = createPostsStore({ dataDir: dir, collabId: 'collab-1', log });
  assert.equal(store.size(), 0);
  assert.equal(store.stats().persistFailures, 1);
  assert.ok(logs.some((message) => message.includes('读取失败')));
  assert.equal(store.append(entryOf()), true, '写入受阻不改变入列语义（内存态继续）');
  assert.equal(store.size(), 1);
  assert.equal(store.stats().persistFailures, 2);
});

test('写盘失败：内存态继续（计数 + 告警、不抛出）', (t) => {
  const dir = makeTempDir(t);
  writeFileSync(join(dir, 'collabs'), '占用路径：协作目录无法创建');
  const logs = [];
  const log = { info: () => {}, warn: (message) => logs.push(message), error: () => {} };
  const store = createPostsStore({ dataDir: dir, collabId: 'collab-1', log });
  assert.equal(store.append(entryOf()), true, '落盘失败不得中断协作主链');
  assert.equal(store.size(), 1);
  assert.equal(store.stats().persistFailures, 1);
  assert.ok(logs.some((message) => message.includes('写入失败')));
});

test('作者基线：无该作者的帖取空基线；以该作者最大序号与最大 ts 为准', (t) => {
  const { store } = makeStore(t);
  assert.deepEqual(store.ownBaseline('inst-a'), { seq: null, ts: null });
  const older = '2026-10-13T00:00:00.000Z';
  const newer = '2026-10-13T00:00:05.000Z';
  store.append(entryOf({ entryId: 'post-1', seq: 2, ts: newer }));
  store.append(entryOf({ entryId: 'post-2', seq: 3, ts: older, from: { instanceId: 'inst-b', identityName: '主机乙' } }));
  assert.deepEqual(store.ownBaseline('inst-a'), { seq: 2, ts: newer });
  assert.deepEqual(store.ownBaseline('inst-b'), { seq: 3, ts: older });
  store.append(entryOf({ entryId: 'post-3', seq: 7, ts: older, from: { instanceId: 'inst-b', identityName: '主机乙' } }));
  assert.deepEqual(store.ownBaseline('inst-b'), { seq: 7, ts: older }, '序号取最大、ts 取最大（两者独立）');
});

test('显示序：按 ts 排序；同刻按 postId 序兜底；不改原数组', () => {
  const earlyB = entryOf({ entryId: 'post-b', seq: 1, ts: '2026-10-13T00:00:00.000Z' });
  const earlyA = entryOf({ entryId: 'post-a', seq: 2, ts: '2026-10-13T00:00:00.000Z', from: { instanceId: 'inst-b', identityName: '主机乙' } });
  const late = entryOf({ entryId: 'post-c', seq: 3, ts: '2026-10-13T00:00:01.000Z' });
  const source = [late, earlyB, earlyA];
  const ordered = displayOrderOf(source);
  assert.deepEqual(ordered.map((entry) => entry.entryId), ['post-a', 'post-b', 'post-c'], '同刻按 postId 序在前，晚刻在最后');
  assert.deepEqual(source.map((entry) => entry.entryId), ['post-c', 'post-b', 'post-a'], '原数组顺序不变（返回新数组）');
  const twin = entryOf({ entryId: 'post-a', seq: 9, ts: '2026-10-13T00:00:00.000Z', from: { instanceId: 'inst-b', identityName: '主机乙' } });
  const withTwin = displayOrderOf([twin, earlyA, earlyB]);
  assert.deepEqual(withTwin.map((entry) => entry.entryId), ['post-a', 'post-a', 'post-b'], '跨作者同 postId 且同刻：不可比即保持稳定次序');
});
