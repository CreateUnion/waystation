import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from './helpers.js';
import { createViewerData } from '../src/viewer/data.js';
import { COLLABS_DIR_NAME, CONFIG_FILE_NAME, SITES_DIR_NAME } from '../src/paths.js';
import { POSTS_FILE_NAME } from '../src/collab/posts.js';
import { MEMBERS_FILE_NAME } from '../src/collab/members.js';
import { LEDGER_FILE_NAME, MEMBER_FILE_NAME, SNAPSHOT_FILE_NAME } from '../src/collab/store.js';
import { COUNTER_FILE_NAME } from '../src/collab/counter.js';
import { MUTE_FILE_NAME } from '../src/collab/mute.js';
import { INBOX_FILE_NAME } from '../src/net/inbound.js';
import { OUTBOX_FILE_NAME } from '../src/net/outbox.js';

/* 只读数据层的判别用例：临时数据根（makeTempDir）＋手工落盘的文件流——绝不触碰真实 ~/.waystation。
 * 夹具一律以各模块导出的规范文件名常量为准（数据层就地定义的名字常量若与它们漂移，用例即红）。
 * 时间戳全部字符串定格（不依赖真实时钟），排序与迁移断言的确定性由此保证。 */

const T0 = '2026-10-14T10:00:00.000Z';
/** @param {number} offsetMs */
function tsPlus(offsetMs) {
  return new Date(Date.parse(T0) + offsetMs).toISOString();
}

function collabDirIn(dataDir, root, collabId) {
  const base = root === 'main' ? dataDir : join(dataDir, SITES_DIR_NAME, root.slice(1));
  return join(base, COLLABS_DIR_NAME, collabId);
}

function writeFiles(dir, files) {
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
}

function writeConfigAt(baseDir, identityName) {
  mkdirSync(baseDir, { recursive: true });
  writeFileSync(join(baseDir, CONFIG_FILE_NAME), `${JSON.stringify({ identityName })}\n`);
}

/* 把目录内全部文件的 mtime 定格到整秒：updatedAt（文件 mtime 最大值）的断言由此确定。 */
function stampAllFiles(dir, seconds) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile()) {
      utimesSync(join(dir, entry.name), seconds, seconds);
    }
  }
}

function jsonl(...values) {
  return values.map((value) => `${JSON.stringify(value)}\n`).join('');
}

function memberRecord(over = {}) {
  return {
    collabId: 'c-1',
    name: '甲机',
    role: 'manager',
    state: 'active',
    manager: { instanceId: 'mgr-1', identityName: '甲机' },
    endpoints: {},
    roster: [{ instanceId: 'mgr-1', identityName: '甲机' }],
    ...over,
  };
}

function postEntry(over = {}) {
  return {
    entryId: 'post-1',
    seq: 1,
    ts: T0,
    from: { instanceId: 'inst-a', identityName: '甲机' },
    kind: 'task',
    text: '正文甲',
    ...over,
  };
}

function memberEvent(over = {}) {
  return { eventId: 'ev-1', kind: 'join', instanceId: 'inst-a', identityName: '甲机', ts: T0, ...over };
}

function ledgerOf(over = {}) {
  return {
    version: 1,
    collabId: 'c-1',
    name: '协作甲',
    topic: '主题甲',
    status: 'active',
    manager: { instanceId: 'mgr-1', identityName: '甲机' },
    members: [
      { instanceId: 'mgr-1', identityName: '甲机', role: 'manager', state: 'member', joinedAt: T0 },
      { instanceId: 'inst-b', identityName: '乙机', role: 'member', state: 'member', joinedAt: T0 },
    ],
    board: [],
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

function snapshotOf(over = {}) {
  return {
    version: 1,
    digest: 'a'.repeat(64),
    receivedAt: T0,
    from: { instanceId: 'mgr-1', identityName: '甲机' },
    ledger: ledgerOf(),
    ...over,
  };
}

function inboxRow(over = {}) {
  return {
    v: 1,
    type: 'reply',
    msgId: 'msg-in-1',
    from: { instanceId: 'inst-b', identityName: '乙机', port: 7000 },
    collabId: 'c-1',
    ts: T0,
    payload: { text: '收到' },
    receivedAt: T0,
    ...over,
  };
}

function outboxRow(over = {}) {
  return {
    msgId: 'msg-out-1',
    collabId: 'c-1',
    to: { instanceId: 'inst-b', address: '127.0.0.1', port: 7000 },
    type: 'reply',
    payload: { text: '发出' },
    governance: false,
    state: 'queued',
    attempts: 0,
    createdAt: T0,
    nextAttemptAt: 0,
    ...over,
  };
}

function createData(dataDir) {
  return createViewerData({ dataDir, log: { warn() {} } });
}

function rowIds(result) {
  return result.rows.map((row) => row.id);
}

/* —— 讨论（forum）帖流 —— */

function writeForumFixture(dataDir, collabId = 'c-1') {
  writeFiles(collabDirIn(dataDir, 'main', collabId), {
    [POSTS_FILE_NAME]: jsonl(
      postEntry(),
      postEntry({ entryId: 'post-2', seq: 2, ts: tsPlus(1000), kind: 'reply', text: '甲\r\n乙\u0007' }),
    ),
    [MEMBERS_FILE_NAME]: jsonl(memberEvent()),
    [MEMBER_FILE_NAME]: JSON.stringify(memberRecord({ mode: 'forum', collabId })),
  });
}

test('forum：帖流按文件序成行，id/字段与正文呈现口径正确（无 direction/count）', (t) => {
  const dataDir = makeTempDir(t);
  writeForumFixture(dataDir);
  const feed = createData(dataDir).readFeed('main', 'c-1', null);
  assert.equal(feed.reset, true);
  assert.equal(feed.skipped, 0);
  assert.deepEqual(feed.rows, [
    { id: 'post-1@inst-a', ts: T0, fromName: '甲机', kind: 'task', text: '正文甲' },
    { id: 'post-2@inst-a', ts: tsPlus(1000), fromName: '甲机', kind: 'reply', text: '甲\n乙' },
  ]);
  for (const row of feed.rows) {
    assert.equal('direction' in row, false);
    assert.equal('count' in row, false);
  }
});

test('forum：跨作者同 entryId 两行并存（行 id 带作者实例标识）', (t) => {
  const dataDir = makeTempDir(t);
  writeFiles(collabDirIn(dataDir, 'main', 'c-1'), {
    [POSTS_FILE_NAME]: jsonl(
      postEntry({ entryId: 'same-1' }),
      postEntry({ entryId: 'same-1', seq: 2, ts: tsPlus(500), from: { instanceId: 'inst-b', identityName: '乙机' } }),
    ),
    [MEMBER_FILE_NAME]: JSON.stringify(memberRecord({ mode: 'forum' })),
  });
  const feed = createData(dataDir).readFeed('main', 'c-1', null);
  assert.deepEqual(rowIds(feed), ['same-1@inst-a', 'same-1@inst-b']);
});

test('forum：半写尾行不计入，补齐后计入（同一夹具两态）', (t) => {
  const dataDir = makeTempDir(t);
  const dir = collabDirIn(dataDir, 'main', 'c-1');
  writeFiles(dir, { [MEMBER_FILE_NAME]: JSON.stringify(memberRecord({ mode: 'forum' })) });
  const file = join(dir, POSTS_FILE_NAME);
  const first = JSON.stringify(postEntry());
  const second = JSON.stringify(postEntry({ entryId: 'post-2', seq: 2, ts: tsPlus(1000) }));
  writeFileSync(file, `${first}\n${second}`);   // 尾行未以换行收尾 = 半写
  const data = createData(dataDir);
  const half = data.readFeed('main', 'c-1', null);
  assert.deepEqual(rowIds(half), ['post-1@inst-a']);
  assert.equal(half.skipped, 0);   // 残段不属坏行：不计入 skipped
  writeFileSync(file, `${first}\n${second}\n`);
  assert.deepEqual(rowIds(data.readFeed('main', 'c-1', null)), ['post-1@inst-a', 'post-2@inst-a']);
});

test('forum：坏行（坏 JSON／形态不符）跳过并计数，空行不计', (t) => {
  const dataDir = makeTempDir(t);
  writeFiles(collabDirIn(dataDir, 'main', 'c-1'), {
    [POSTS_FILE_NAME]: `${JSON.stringify(postEntry())}\n不是 JSON\n\n${JSON.stringify(postEntry({ entryId: 'post-2', seq: 2, kind: '未知词表' }))}\n`,
    [MEMBER_FILE_NAME]: JSON.stringify(memberRecord({ mode: 'forum' })),
  });
  const feed = createData(dataDir).readFeed('main', 'c-1', null);
  assert.deepEqual(rowIds(feed), ['post-1@inst-a']);
  assert.equal(feed.skipped, 2);
});

test('forum：锚点——缺省全量、中间锚增量、重复 id 取末次、末锚空增量、锚被淘汰 reset 全量', (t) => {
  const dataDir = makeTempDir(t);
  writeFiles(collabDirIn(dataDir, 'main', 'c-1'), {
    [POSTS_FILE_NAME]: jsonl(
      postEntry(),
      postEntry({ entryId: 'post-2', seq: 2, ts: tsPlus(1000) }),
      postEntry(),   // 同一帖的重复行（残迹）：行 id 与首行相同
      postEntry({ entryId: 'post-3', seq: 3, ts: tsPlus(2000) }),
    ),
    [MEMBER_FILE_NAME]: JSON.stringify(memberRecord({ mode: 'forum' })),
  });
  const data = createData(dataDir);
  const all = data.readFeed('main', 'c-1', null);
  assert.equal(all.reset, true);
  assert.deepEqual(rowIds(all), ['post-1@inst-a', 'post-2@inst-a', 'post-1@inst-a', 'post-3@inst-a']);
  const byFirst = data.readFeed('main', 'c-1', 'post-1@inst-a');
  assert.equal(byFirst.reset, false);
  assert.deepEqual(rowIds(byFirst), ['post-3@inst-a']);   // 取末次出现：首现之后会多出两条
  const byLast = data.readFeed('main', 'c-1', 'post-3@inst-a');
  assert.equal(byLast.reset, false);
  assert.deepEqual(rowIds(byLast), []);
  const evicted = data.readFeed('main', 'c-1', '早已淘汰的行');
  assert.equal(evicted.reset, true);
  assert.deepEqual(rowIds(evicted), rowIds(all));
});

/* —— 协作（managed）会话流 —— */

function writeManagedFixture(dataDir, collabId, files) {
  writeFiles(collabDirIn(dataDir, 'main', collabId), {
    [MEMBER_FILE_NAME]: JSON.stringify(memberRecord({ collabId })),
    ...files,
  });
}

test('managed：outbox 同 msgId 多行取末条（内容取末、ts 取首现）', (t) => {
  const dataDir = makeTempDir(t);
  writeConfigAt(dataDir, '甲机');
  writeManagedFixture(dataDir, 'c-1', {
    [OUTBOX_FILE_NAME]: jsonl(
      outboxRow({ createdAt: T0, payload: { text: '早期文本' }, state: 'queued' }),
      outboxRow({ createdAt: tsPlus(3000), payload: { text: '末条文本' }, state: 'session' }),
    ),
  });
  const feed = createData(dataDir).readFeed('main', 'c-1', null);
  assert.deepEqual(feed.rows, [
    { id: 'msg-out-1', ts: T0, fromName: '甲机', direction: 'out', kind: 'reply', text: '末条文本' },
  ]);
});

test('managed：inbox 重放同 msgId 去重（内容取末、ts 取首现，不重复显示重投）', (t) => {
  const dataDir = makeTempDir(t);
  writeManagedFixture(dataDir, 'c-1', {
    [INBOX_FILE_NAME]: jsonl(
      inboxRow({ ts: T0, payload: { text: '第一次收到' } }),
      inboxRow({ ts: tsPlus(5000), payload: { text: '重投副本' } }),
    ),
  });
  const feed = createData(dataDir).readFeed('main', 'c-1', null);
  assert.deepEqual(feed.rows, [
    { id: 'msg-in-1', ts: T0, fromName: '乙机', direction: 'in', kind: 'reply', text: '重投副本' },
  ]);
});

test('managed：方向与作者名——inbox 取帧内 from，outbox 取对应根 config；缺失/损坏回退「本机」', (t) => {
  const dataDir = makeTempDir(t);
  writeConfigAt(dataDir, '甲机');
  writeManagedFixture(dataDir, 'c-1', {
    [INBOX_FILE_NAME]: jsonl(inboxRow({ ts: tsPlus(1000) })),
    [OUTBOX_FILE_NAME]: jsonl(outboxRow()),
  });
  writeConfigAt(join(dataDir, SITES_DIR_NAME, '2'), '乙机');
  writeFiles(collabDirIn(dataDir, 's2', 'c-1'), {
    [MEMBER_FILE_NAME]: JSON.stringify(memberRecord()),
    [OUTBOX_FILE_NAME]: jsonl(outboxRow({ msgId: 'msg-out-2' })),
  });
  writeFiles(collabDirIn(dataDir, 's3', 'c-1'), {
    [MEMBER_FILE_NAME]: JSON.stringify(memberRecord()),
    [OUTBOX_FILE_NAME]: jsonl(outboxRow({ msgId: 'msg-out-3' })),
  });
  writeConfigAt(join(dataDir, SITES_DIR_NAME, '4'), '甲机');
  writeFileSync(join(dataDir, SITES_DIR_NAME, '4', CONFIG_FILE_NAME), '{不是 JSON');
  writeFiles(collabDirIn(dataDir, 's4', 'c-1'), {
    [MEMBER_FILE_NAME]: JSON.stringify(memberRecord()),
    [OUTBOX_FILE_NAME]: jsonl(outboxRow({ msgId: 'msg-out-4' })),
  });
  const data = createData(dataDir);
  assert.deepEqual(data.readFeed('main', 'c-1', null).rows, [
    { id: 'msg-out-1', ts: T0, fromName: '甲机', direction: 'out', kind: 'reply', text: '发出' },
    { id: 'msg-in-1', ts: tsPlus(1000), fromName: '乙机', direction: 'in', kind: 'reply', text: '收到' },
  ]);
  assert.equal(data.readFeed('s2', 'c-1', null).rows[0].fromName, '乙机');   // 站点根读自己的 config
  assert.equal(data.readFeed('s3', 'c-1', null).rows[0].fromName, '本机');   // config 缺失
  assert.equal(data.readFeed('s4', 'c-1', null).rows[0].fromName, '本机');   // config 损坏
});

test('managed：扇出合并——错峰链式步进全并为一行（count/组首 id 与 ts），>50ms 断点分裂', (t) => {
  const dataDir = makeTempDir(t);
  writeManagedFixture(dataDir, 'c-1', {
    [OUTBOX_FILE_NAME]: jsonl(
      outboxRow({ msgId: 'f-1', createdAt: tsPlus(0), payload: { text: '同文' } }),
      outboxRow({ msgId: 'f-2', createdAt: tsPlus(7), payload: { text: '同文' } }),
      outboxRow({ msgId: 'f-3', createdAt: tsPlus(14), payload: { text: '同文' } }),
      outboxRow({ msgId: 'f-4', createdAt: tsPlus(21), payload: { text: '同文' } }),
      outboxRow({ msgId: 'f-5', createdAt: tsPlus(100), payload: { text: '同文' } }),   // 与上一条差 79ms：分裂
    ),
  });
  const feed = createData(dataDir).readFeed('main', 'c-1', null);
  assert.deepEqual(feed.rows, [
    { id: 'f-1', ts: tsPlus(0), fromName: '本机', direction: 'out', kind: 'reply', text: '同文', count: 4 },
    { id: 'f-5', ts: tsPlus(100), fromName: '本机', direction: 'out', kind: 'reply', text: '同文' },
  ]);
});

test('managed：扇出合并为链式判定（累计超窗仍并入）；payload 或 type 不同不并', (t) => {
  const dataDir = makeTempDir(t);
  writeManagedFixture(dataDir, 'c-1', {
    [OUTBOX_FILE_NAME]: jsonl(
      outboxRow({ msgId: 'g-1', createdAt: tsPlus(0), payload: { text: '链式' } }),
      outboxRow({ msgId: 'g-2', createdAt: tsPlus(30), payload: { text: '链式' } }),
      outboxRow({ msgId: 'g-3', createdAt: tsPlus(60), payload: { text: '链式' } }),   // 距组首 60 > 50、距组内上一条 30
      outboxRow({ msgId: 'g-4', createdAt: tsPlus(100), payload: { text: '另文' } }),   // payload 不同
      outboxRow({ msgId: 'g-5', createdAt: tsPlus(110), type: 'task', payload: { text: '另文' } }),   // type 不同
    ),
  });
  const feed = createData(dataDir).readFeed('main', 'c-1', null);
  assert.deepEqual(rowIds(feed), ['g-1', 'g-4', 'g-5']);
  assert.equal(feed.rows[0].count, 3);
  assert.equal('count' in feed.rows[1], false);
  assert.equal('count' in feed.rows[2], false);
});

test('managed：POST_KINDS 过滤——非内容类合法行不入流也不计 skipped', (t) => {
  const dataDir = makeTempDir(t);
  writeManagedFixture(dataDir, 'c-1', {
    [INBOX_FILE_NAME]: jsonl(
      inboxRow({ msgId: 'n-1', type: 'notice', payload: { event: 'roster' } }),
      inboxRow({ msgId: 'n-2', type: 'snapshot', payload: { kind: 'data' } }),
      inboxRow({ msgId: 'n-3', ts: tsPlus(1000) }),
    ),
    [OUTBOX_FILE_NAME]: jsonl(
      outboxRow({ msgId: 'n-4', type: 'invite', payload: { name: 'x', topic: 'y', members: [{}, {}] } }),
      outboxRow({ msgId: 'n-5', type: 'delivery-status', payload: { refMsgId: 'n-3', tier: 'session' } }),
    ),
  });
  const feed = createData(dataDir).readFeed('main', 'c-1', null);
  assert.deepEqual(rowIds(feed), ['n-3']);
  assert.equal(feed.skipped, 0);
});

test('managed：正文取数——stop 取 payload.reason；缺文本/超长按坏行计数', (t) => {
  const dataDir = makeTempDir(t);
  writeManagedFixture(dataDir, 'c-1', {
    [INBOX_FILE_NAME]: jsonl(
      inboxRow({ msgId: 's-1', type: 'stop', payload: { reason: '停一停' } }),
      inboxRow({ msgId: 's-2', ts: tsPlus(1000), payload: {} }),
      inboxRow({ msgId: 's-3', ts: tsPlus(2000), payload: { text: 'x'.repeat(4001) } }),
    ),
  });
  const feed = createData(dataDir).readFeed('main', 'c-1', null);
  assert.deepEqual(feed.rows, [
    { id: 's-1', ts: T0, fromName: '乙机', direction: 'in', kind: 'stop', text: '停一停' },
  ]);
  assert.equal(feed.skipped, 2);
});

test('managed：inbox/outbox 坏行（非法 JSON／形态不符／缺 from／缺文本）跳过并计数，行集不受影响', (t) => {
  const dataDir = makeTempDir(t);
  const inboxNoFrom = { v: 1, type: 'reply', msgId: 'no-from', collabId: 'c-1', ts: tsPlus(3000), payload: { text: '无 from' }, receivedAt: T0 };
  writeManagedFixture(dataDir, 'c-1', {
    [INBOX_FILE_NAME]: `${jsonl(inboxRow({ msgId: 'ok-in', ts: tsPlus(1000) }))}不是 JSON\n${JSON.stringify(inboxRow({ msgId: '坏 id', ts: tsPlus(2000) }))}\n${JSON.stringify(inboxNoFrom)}\n`,
    [OUTBOX_FILE_NAME]: `${jsonl(outboxRow({ msgId: 'ok-out' }))}{不是 JSON\n${JSON.stringify(outboxRow({ msgId: 'msg-out-2', createdAt: '不是时间' }))}\n${JSON.stringify(outboxRow({ msgId: 'no-text', payload: {} }))}\n`,
  });
  const feed = createData(dataDir).readFeed('main', 'c-1', null);
  assert.deepEqual(rowIds(feed), ['ok-out', 'ok-in']);
  assert.equal(feed.skipped, 6);
});

test('managed：并集排序（ts 升序、同 ts 按 id）与跨文件同 msgId（取晚者、平局 inbox）', (t) => {
  const dataDir = makeTempDir(t);
  writeManagedFixture(dataDir, 'c-1', {
    [INBOX_FILE_NAME]: jsonl(
      inboxRow({ msgId: 'msg-c', ts: tsPlus(1000), payload: { text: '丙' } }),
      inboxRow({ msgId: 'msg-b', ts: tsPlus(2000), payload: { text: '乙' } }),
      inboxRow({ msgId: 'msg-x', ts: tsPlus(3000), payload: { text: '收方晚' } }),
      inboxRow({ msgId: 'msg-y', ts: tsPlus(5000), payload: { text: '收方早' } }),
      inboxRow({ msgId: 'msg-z', ts: tsPlus(6000), payload: { text: '平局' } }),
    ),
    [OUTBOX_FILE_NAME]: jsonl(
      outboxRow({ msgId: 'msg-a', createdAt: tsPlus(1000), payload: { text: '甲' } }),
      outboxRow({ msgId: 'msg-x', createdAt: tsPlus(4000), payload: { text: '发方更晚' } }),
      outboxRow({ msgId: 'msg-y', createdAt: tsPlus(4000), payload: { text: '发方更早' } }),
      outboxRow({ msgId: 'msg-z', createdAt: tsPlus(6000), payload: { text: '平局' } }),
    ),
  });
  const feed = createData(dataDir).readFeed('main', 'c-1', null);
  assert.deepEqual(
    feed.rows.map((row) => [row.id, row.ts, row.direction]),
    [
      ['msg-a', tsPlus(1000), 'out'],
      ['msg-c', tsPlus(1000), 'in'],
      ['msg-b', tsPlus(2000), 'in'],
      ['msg-x', tsPlus(4000), 'out'],
      ['msg-y', tsPlus(5000), 'in'],
      ['msg-z', tsPlus(6000), 'in'],
    ],
  );
});

test('managed：会话流锚点（中间锚增量、找不到 reset 全量）', (t) => {
  const dataDir = makeTempDir(t);
  writeManagedFixture(dataDir, 'c-1', {
    [INBOX_FILE_NAME]: jsonl(
      inboxRow({ msgId: 'a-1', ts: tsPlus(0) }),
      inboxRow({ msgId: 'a-2', ts: tsPlus(1000) }),
      inboxRow({ msgId: 'a-3', ts: tsPlus(2000) }),
    ),
  });
  const data = createData(dataDir);
  const after = data.readFeed('main', 'c-1', 'a-1');
  assert.equal(after.reset, false);
  assert.deepEqual(rowIds(after), ['a-2', 'a-3']);
  const evicted = data.readFeed('main', 'c-1', '早已压实掉的行');
  assert.equal(evicted.reset, true);
  assert.deepEqual(rowIds(evicted), ['a-1', 'a-2', 'a-3']);
});

/* —— 元状态与事件轨 —— */

test('managed：管理席位——台账末条为名/态权威，人数取名单长度，计数取累计收到，迁移行 id/文本/序正确', (t) => {
  const dataDir = makeTempDir(t);
  writeFiles(collabDirIn(dataDir, 'main', 'c-1'), {
    [MEMBER_FILE_NAME]: JSON.stringify(memberRecord({ collabId: 'c-1' })),
    [LEDGER_FILE_NAME]: jsonl(
      ledgerOf({ status: 'proposed', updatedAt: tsPlus(0) }),
      ledgerOf({ status: 'active', updatedAt: tsPlus(1000) }),
      '这是一条坏行\n',
      ledgerOf({ status: 'frozen', updatedAt: tsPlus(2000) }),
      ledgerOf({ status: 'active', updatedAt: tsPlus(3000), name: '协作甲改名' }),
    ),
    [COUNTER_FILE_NAME]: JSON.stringify({ v: 1, messageCount: 7 }),
  });
  const meta = createData(dataDir).readMeta('main', 'c-1', null);
  assert.deepEqual(meta, {
    name: '协作甲改名',
    state: 'active',
    mode: 'managed',
    memberCount: 2,
    count: 7,
    topic: '主题甲',
    events: {
      rows: [
        { id: '1:0', ts: tsPlus(1000), text: '状态：proposed → active' },
        { id: '2:1', ts: tsPlus(2000), text: '状态：active → frozen' },
        { id: '3:2', ts: tsPlus(3000), text: '状态：frozen → active' },
      ],
      reset: true,
    },
    skipped: 1,
    muted: false,
  });
  const anchored = createData(dataDir).readMeta('main', 'c-1', '1:0');
  assert.equal(anchored.events.reset, false);
  assert.deepEqual(anchored.events.rows.map((row) => row.id), ['2:1', '3:2']);
});

test('managed：无迁移（台账单条或状态不变）与退出态优先（member.state=left 覆盖台账态）', (t) => {
  const dataDir = makeTempDir(t);
  writeFiles(collabDirIn(dataDir, 'main', 'c-1'), {
    [MEMBER_FILE_NAME]: JSON.stringify(memberRecord({ collabId: 'c-1', state: 'left' })),
    [LEDGER_FILE_NAME]: jsonl(
      ledgerOf({ status: 'active', updatedAt: tsPlus(0) }),
      ledgerOf({ status: 'active', updatedAt: tsPlus(1000) }),
    ),
  });
  const meta = createData(dataDir).readMeta('main', 'c-1', null);
  assert.equal(meta.state, 'left');   // 退出优先（席面口径）
  assert.deepEqual(meta.events.rows, []);
  assert.equal(meta.count, null);   // 无 counter：由服务层省略
  writeFiles(collabDirIn(dataDir, 'main', 'c-2'), {
    [MEMBER_FILE_NAME]: JSON.stringify(memberRecord({ collabId: 'c-2' })),
    [LEDGER_FILE_NAME]: jsonl(ledgerOf({ status: 'proposed', updatedAt: tsPlus(0) })),
  });
  const single = createData(dataDir).readMeta('main', 'c-2', null);
  assert.deepEqual(single.events.rows, []);
});

test('managed：成员席位——仅 snapshot 为主体数据源（名单为邀请定格），台账文件被忽略、无迁移行', (t) => {
  const dataDir = makeTempDir(t);
  writeFiles(collabDirIn(dataDir, 'main', 'c-1'), {
    [MEMBER_FILE_NAME]: JSON.stringify(memberRecord({ collabId: 'c-1', role: 'member', name: '成员乙' })),
    [SNAPSHOT_FILE_NAME]: JSON.stringify(snapshotOf({
      ledger: ledgerOf({
        name: '协作乙',
        status: 'frozen',
        topic: '主题乙',
        members: [
          { instanceId: 'mgr-1', identityName: '甲机', role: 'manager', state: 'member', joinedAt: T0 },
          { instanceId: 'inst-b', identityName: '乙机', role: 'member', state: 'member', joinedAt: T0 },
          { instanceId: 'inst-c', identityName: '丙机', role: 'member', state: 'member', joinedAt: T0 },
        ],
      }),
    })),
    [LEDGER_FILE_NAME]: jsonl(
      ledgerOf({ status: 'proposed', updatedAt: tsPlus(0) }),
      ledgerOf({ status: 'completed', updatedAt: tsPlus(1000) }),
    ),
    [COUNTER_FILE_NAME]: JSON.stringify({ v: 1, messageCount: 3 }),
  });
  const meta = createData(dataDir).readMeta('main', 'c-1', null);
  assert.equal(meta.name, '成员乙');   // 成员席位取参与记录
  assert.equal(meta.state, 'active');
  assert.equal(meta.memberCount, 3);   // 名单长度（邀请定格名单，非实时人数）
  assert.equal(meta.topic, '主题乙');
  assert.equal(meta.count, 3);
  assert.deepEqual(meta.events.rows, []);   // 单份快照无迁移行；台账文件按 role 分支被忽略
});

test('role 不可知：member.json 缺失→ledger 优先、无则 snapshot、皆无＝未就绪', (t) => {
  const dataDir = makeTempDir(t);
  writeFiles(collabDirIn(dataDir, 'main', 'c-ledger'), {
    [LEDGER_FILE_NAME]: jsonl(ledgerOf({ name: '台账名', status: 'frozen', updatedAt: T0 })),
  });
  writeFiles(collabDirIn(dataDir, 'main', 'c-snap'), {
    [SNAPSHOT_FILE_NAME]: JSON.stringify(snapshotOf({ ledger: ledgerOf({ name: '快照名', status: 'proposed' }) })),
  });
  writeFiles(collabDirIn(dataDir, 'main', 'c-none'), {});
  const data = createData(dataDir);
  const viaLedger = data.readMeta('main', 'c-ledger', null);
  assert.equal(viaLedger.name, '台账名');
  assert.equal(viaLedger.state, 'frozen');
  const viaSnapshot = data.readMeta('main', 'c-snap', null);
  assert.equal(viaSnapshot.name, '快照名');
  assert.equal(viaSnapshot.state, 'proposed');
  assert.deepEqual(viaSnapshot.events.rows, []);
  const none = data.readMeta('main', 'c-none', null);
  assert.equal(none.name, null);
  assert.equal(none.state, null);
  assert.deepEqual(none.events.rows, []);
});

test('role 不可知：member.json 损坏同样走三分支（损坏文件被当缺失）', (t) => {
  const dataDir = makeTempDir(t);
  writeFiles(collabDirIn(dataDir, 'main', 'c-1'), {
    [MEMBER_FILE_NAME]: '{损坏的 JSON',
    [LEDGER_FILE_NAME]: jsonl(ledgerOf({ name: '台账名兜底' })),
  });
  const meta = createData(dataDir).readMeta('main', 'c-1', null);
  assert.equal(meta.name, '台账名兜底');
  assert.equal(meta.state, 'active');
});

test('mode 判定：缺 mode→managed；参与记录缺失/损坏且帖文件在→forum（文件形态兜底）', (t) => {
  const dataDir = makeTempDir(t);
  writeFiles(collabDirIn(dataDir, 'main', 'c-nomode'), {
    [MEMBER_FILE_NAME]: JSON.stringify(memberRecord({ collabId: 'c-nomode' })),   // 无 mode 字段（旧记录）
  });
  writeFiles(collabDirIn(dataDir, 'main', 'c-forum'), {
    [POSTS_FILE_NAME]: jsonl(postEntry()),
  });
  writeFiles(collabDirIn(dataDir, 'main', 'c-managed'), {
    [MEMBER_FILE_NAME]: '{损坏',
  });
  const data = createData(dataDir);
  assert.equal(data.readMeta('main', 'c-nomode', null).mode, 'managed');
  assert.equal(data.readMeta('main', 'c-forum', null).mode, 'forum');
  assert.equal(data.readMeta('main', 'c-managed', null).mode, 'managed');
  assert.deepEqual(rowIds(data.readFeed('main', 'c-forum', null)), ['post-1@inst-a']);
  assert.deepEqual(data.readFeed('main', 'c-managed', null), { rows: [], reset: true, skipped: 0 });
});

test('forum：事件轨折叠人数逐事件正确、重放去重、topic 取参与记录、事件锚点同 feed', (t) => {
  const dataDir = makeTempDir(t);
  writeFiles(collabDirIn(dataDir, 'main', 'c-1'), {
    [MEMBERS_FILE_NAME]: jsonl(
      memberEvent({ eventId: 'ev-1', kind: 'join', ts: T0 }),
      memberEvent({ eventId: 'ev-2', kind: 'join', instanceId: 'inst-b', identityName: '乙机', ts: tsPlus(1000) }),
      memberEvent({ eventId: 'ev-1', kind: 'join', ts: T0 }),   // 重放：eventId 去重（首现胜）
      memberEvent({ eventId: 'ev-3', kind: 'leave', ts: tsPlus(2000) }),
    ),
    [POSTS_FILE_NAME]: jsonl(postEntry(), postEntry({ entryId: 'post-2', seq: 2, ts: tsPlus(500) })),
    [MEMBER_FILE_NAME]: JSON.stringify(memberRecord({ mode: 'forum', topic: '讨论主题' })),
  });
  const data = createData(dataDir);
  const meta = data.readMeta('main', 'c-1', null);
  assert.equal(meta.mode, 'forum');
  assert.equal(meta.name, '甲机');
  assert.equal(meta.state, 'active');
  assert.equal(meta.memberCount, 1);
  assert.equal(meta.count, 2);
  assert.equal(meta.topic, '讨论主题');
  assert.deepEqual(meta.events.rows, [
    { id: 'ev-1', ts: T0, text: '甲机 加入（现 1 人）' },
    { id: 'ev-2', ts: tsPlus(1000), text: '乙机 加入（现 2 人）' },
    { id: 'ev-3', ts: tsPlus(2000), text: '甲机 退出（现 1 人）' },
  ]);
  const anchored = data.readMeta('main', 'c-1', 'ev-1');
  assert.equal(anchored.events.reset, false);
  assert.deepEqual(anchored.events.rows.map((row) => row.id), ['ev-2', 'ev-3']);
  assert.equal(data.readMeta('main', 'c-1', '无此事件').events.reset, true);
});

/* —— null 语义与未就绪 —— */

test('null 语义：目录不存在／id 形态非法／root 非法 → null 不抛；目录存在未就绪 → 正常空返回', (t) => {
  const dataDir = makeTempDir(t);
  const data = createData(dataDir);
  assert.equal(data.readFeed('main', 'c-1', null), null);
  assert.equal(data.readMeta('main', 'c-1', null), null);
  for (const root of ['x', 's', 's1x', 'S2', 'main2', null, undefined, 3]) {
    assert.equal(data.readFeed(root, 'c-1', null), null, `root=${String(root)}`);
    assert.equal(data.readMeta(root, 'c-1', null), null, `root=${String(root)}`);
  }
  mkdirSync(collabDirIn(dataDir, 'main', 'ok-1'), { recursive: true });
  for (const badId of ['..', '.', 'a/b', 'a\\b', '', '有中文', 'a b', 'a'.repeat(65), 7, null, undefined]) {
    assert.equal(data.readFeed('main', badId, null), null, `id=${String(badId)}`);
    assert.equal(data.readMeta('main', badId, null), null, `id=${String(badId)}`);
  }
  assert.deepEqual(data.readFeed('main', 'ok-1', null), { rows: [], reset: true, skipped: 0 });
  assert.deepEqual(data.readMeta('main', 'ok-1', null), {
    name: null,
    state: null,
    mode: 'managed',
    memberCount: 0,
    count: null,
    topic: null,
    events: { rows: [], reset: true },
    skipped: 0,
    muted: false,
  });
  assert.equal(data.readFeed('s2', 'ok-1', null), null);   // sites 槽位目录不存在
  mkdirSync(collabDirIn(dataDir, 's2', 'ok-1'), { recursive: true });
  assert.deepEqual(data.readFeed('s2', 'ok-1', null), { rows: [], reset: true, skipped: 0 });
});

/* —— 列表（全根扫描） —— */

test('listCollabs：主目录＋sites 双根（同名 id 两目录）、非 ID_PATTERN 目录忽略、updatedAt 最大者倒序', (t) => {
  const dataDir = makeTempDir(t);
  // main 根：c-1 讨论（两帖两事件）；c-2 协作（管理员席位）；非法名目录与散文件应被忽略
  writeFiles(collabDirIn(dataDir, 'main', 'c-1'), {
    [POSTS_FILE_NAME]: jsonl(postEntry(), postEntry({ entryId: 'post-2', seq: 2, ts: tsPlus(500) })),
    [MEMBERS_FILE_NAME]: jsonl(
      memberEvent({ eventId: 'ev-1', ts: T0 }),
      memberEvent({ eventId: 'ev-2', instanceId: 'inst-b', identityName: '乙机', ts: tsPlus(500) }),
    ),
    [MEMBER_FILE_NAME]: JSON.stringify(memberRecord({ mode: 'forum', collabId: 'c-1' })),
  });
  writeFiles(collabDirIn(dataDir, 'main', 'c-2'), {
    [MEMBER_FILE_NAME]: JSON.stringify(memberRecord({ collabId: 'c-2' })),
    [LEDGER_FILE_NAME]: jsonl(ledgerOf({ collabId: 'c-2', status: 'frozen' })),
    [COUNTER_FILE_NAME]: JSON.stringify({ v: 1, messageCount: 5 }),
  });
  mkdirSync(join(dataDir, COLLABS_DIR_NAME, '非法名下划线'), { recursive: true });
  writeFileSync(join(dataDir, COLLABS_DIR_NAME, '散文件'), 'x');
  // sites 根：同名 c-1 的成员席位（仅 snapshot；无 counter）
  writeFiles(collabDirIn(dataDir, 's2', 'c-1'), {
    [MEMBER_FILE_NAME]: JSON.stringify(memberRecord({ collabId: 'c-1', role: 'member', name: '成员乙' })),
    [SNAPSHOT_FILE_NAME]: JSON.stringify(snapshotOf({ ledger: ledgerOf({ name: '协作乙', status: 'proposed' }) })),
  });
  mkdirSync(join(dataDir, SITES_DIR_NAME, 'README'), { recursive: true });   // 非数字目录忽略
  // updatedAt 定格：把每个协作目录的全部文件 mtime 设为整秒（utimes 往返无损，最大者即该值）
  stampAllFiles(collabDirIn(dataDir, 'main', 'c-1'), 1700000100);
  stampAllFiles(collabDirIn(dataDir, 'main', 'c-2'), 1700000200);
  stampAllFiles(collabDirIn(dataDir, 's2', 'c-1'), 1700000300);
  const { collabs } = createData(dataDir).listCollabs();
  assert.deepEqual(collabs, [
    { root: 's2', id: 'c-1', name: '成员乙', state: 'active', muted: false, mode: 'managed', memberCount: 2, count: null, updatedAt: 1700000300000 },
    { root: 'main', id: 'c-2', name: '协作甲', state: 'frozen', muted: false, mode: 'managed', memberCount: 2, count: 5, updatedAt: 1700000200000 },
    { root: 'main', id: 'c-1', name: '甲机', state: 'active', muted: false, mode: 'forum', memberCount: 2, count: 2, updatedAt: 1700000100000 },
  ]);
});

test('listCollabs：updatedAt 同值以 id（再以 root）稳定序；sites 不存在＝正常；空根返回空清单', (t) => {
  const dataDir = makeTempDir(t);
  const data = createData(dataDir);
  assert.deepEqual(data.listCollabs(), { collabs: [] });
  for (const id of ['c-b', 'c-a']) {
    writeFiles(collabDirIn(dataDir, 'main', id), {
      [MEMBER_FILE_NAME]: JSON.stringify(memberRecord({ collabId: id })),
    });
  }
  stampAllFiles(collabDirIn(dataDir, 'main', 'c-a'), 1700000500);
  stampAllFiles(collabDirIn(dataDir, 'main', 'c-b'), 1700000500);
  assert.deepEqual(data.listCollabs().collabs.map((entry) => entry.id), ['c-a', 'c-b']);
});

/* —— 微缓存 —— */

test('缓存：同 (size, mtime) 二次读命中且不重析——同尺寸改写＋恢复 mtime 后仍返回旧解析', (t) => {
  const dataDir = makeTempDir(t);
  const dir = collabDirIn(dataDir, 'main', 'c-1');
  writeFiles(dir, { [MEMBER_FILE_NAME]: JSON.stringify(memberRecord({ mode: 'forum' })) });
  const postsFile = join(dir, POSTS_FILE_NAME);
  const wholeSecondMs = 1700000000000;   // 整秒：utimes 往返无损（各平台文件时间粒度均细于整秒）
  const contentA = jsonl(postEntry({ text: '甲正文' }));
  const contentB = jsonl(postEntry({ text: '乙正文' }));
  assert.equal(contentB.length, contentA.length);
  writeFileSync(postsFile, contentA);
  utimesSync(postsFile, wholeSecondMs / 1000, wholeSecondMs / 1000);
  assert.equal(statSync(postsFile).mtimeMs, wholeSecondMs);
  const data = createData(dataDir);
  assert.equal(data.readFeed('main', 'c-1', null).rows[0].text, '甲正文');
  const first = data.stats();
  writeFileSync(postsFile, contentB);   // 同尺寸改写
  utimesSync(postsFile, wholeSecondMs / 1000, wholeSecondMs / 1000);
  assert.equal(statSync(postsFile).mtimeMs, wholeSecondMs);
  const second = data.readFeed('main', 'c-1', null);
  assert.equal(second.rows[0].text, '甲正文');   // 服务的是旧解析：命中未重读
  assert.ok(data.stats().cacheHits > first.cacheHits);
  assert.equal(data.stats().cacheMisses, first.cacheMisses);
});

test('缓存：删文件后以同键（同 size+mtime）重建仍命中——键只认 (路径, size, mtime)', (t) => {
  const dataDir = makeTempDir(t);
  const dir = collabDirIn(dataDir, 'main', 'c-1');
  writeFiles(dir, { [MEMBER_FILE_NAME]: JSON.stringify(memberRecord({ mode: 'forum' })) });
  const postsFile = join(dir, POSTS_FILE_NAME);
  const wholeSecondMs = 1700000000000;
  const contentA = jsonl(postEntry({ text: '甲正文' }));
  const contentB = jsonl(postEntry({ text: '乙正文' }));
  writeFileSync(postsFile, contentA);
  utimesSync(postsFile, wholeSecondMs / 1000, wholeSecondMs / 1000);
  const data = createData(dataDir);
  assert.equal(data.readFeed('main', 'c-1', null).rows[0].text, '甲正文');
  unlinkSync(postsFile);
  writeFileSync(postsFile, contentB);   // 删除后以同 size + 同 mtime 重建
  utimesSync(postsFile, wholeSecondMs / 1000, wholeSecondMs / 1000);
  const again = data.readFeed('main', 'c-1', null);
  assert.equal(again.rows[0].text, '甲正文');
});

test('缓存：缺失态不入缓存——文件随后出现即能读到；已缓存文件被删后读返空、再写入即见新内容', (t) => {
  const dataDir = makeTempDir(t);
  const dir = collabDirIn(dataDir, 'main', 'c-1');
  writeFiles(dir, { [MEMBER_FILE_NAME]: JSON.stringify(memberRecord({ mode: 'forum' })) });
  const postsFile = join(dir, POSTS_FILE_NAME);
  const data = createData(dataDir);
  assert.deepEqual(data.readFeed('main', 'c-1', null).rows, []);
  writeFileSync(postsFile, jsonl(postEntry({ text: '晚就绪' })));
  assert.deepEqual(data.readFeed('main', 'c-1', null).rows.map((row) => row.text), ['晚就绪']);
  unlinkSync(postsFile);
  assert.deepEqual(data.readFeed('main', 'c-1', null).rows, []);   // 缺失不服务旧缓存
  writeFileSync(postsFile, jsonl(postEntry({ text: '重建后的新内容' })));
  assert.deepEqual(data.readFeed('main', 'c-1', null).rows.map((row) => row.text), ['重建后的新内容']);
});

test('缓存：小 JSON 直读不缓存——counter/member/config/mute 同尺寸改写后即读到', (t) => {
  const dataDir = makeTempDir(t);
  writeConfigAt(dataDir, '甲机');
  const dir = collabDirIn(dataDir, 'main', 'c-1');
  writeFiles(dir, {
    [MEMBER_FILE_NAME]: JSON.stringify(memberRecord({ collabId: 'c-1', role: 'member', name: '甲机' })),
    [COUNTER_FILE_NAME]: JSON.stringify({ v: 1, messageCount: 5 }),
    [MUTE_FILE_NAME]: JSON.stringify({ v: 1, muted: false, baseline: null }),
    [OUTBOX_FILE_NAME]: jsonl(outboxRow()),
  });
  const data = createData(dataDir);
  assert.equal(data.readMeta('main', 'c-1', null).count, 5);
  assert.equal(data.readMeta('main', 'c-1', null).name, '甲机');
  assert.equal(data.readMeta('main', 'c-1', null).muted, false);
  assert.equal(data.readFeed('main', 'c-1', null).rows[0].fromName, '甲机');
  writeFileSync(join(dir, COUNTER_FILE_NAME), JSON.stringify({ v: 1, messageCount: 7 }));
  writeFileSync(join(dir, MEMBER_FILE_NAME), JSON.stringify(memberRecord({ collabId: 'c-1', role: 'member', name: '乙机' })));
  writeFileSync(join(dir, MUTE_FILE_NAME), JSON.stringify({ v: 1, muted: true, baseline: null }));   // 同尺寸改写
  writeConfigAt(dataDir, '乙机');
  assert.equal(data.readMeta('main', 'c-1', null).count, 7);
  assert.equal(data.readMeta('main', 'c-1', null).name, '乙机');
  assert.equal(data.readMeta('main', 'c-1', null).muted, true);
  assert.equal(data.readFeed('main', 'c-1', null).rows[0].fromName, '乙机');
});

test('小 JSON 读故障（非缺失，位置是目录）留痕降级：warn 被调、不抛、按未就绪语义', (t) => {
  const dataDir = makeTempDir(t);
  const dir = collabDirIn(dataDir, 'main', 'c-1');
  writeFiles(dir, {
    [MEMBER_FILE_NAME]: JSON.stringify(memberRecord({ collabId: 'c-1', role: 'member' })),
    [OUTBOX_FILE_NAME]: jsonl(outboxRow()),
  });
  mkdirSync(join(dir, COUNTER_FILE_NAME), { recursive: true });   // 小 JSON 位置是目录：读取必抛（非 ENOENT）
  const warnings = [];
  const data = createViewerData({ dataDir, log: { warn: (...args) => warnings.push(args) } });
  const meta = data.readMeta('main', 'c-1', null);
  assert.equal(meta.count, null);   // 读故障按未就绪降级，不抛
  assert.equal(meta.name, '甲机');   // 其余取数不受影响
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][0]), /小 JSON 读取失败/);
  assert.equal(String(warnings[0][1].file).endsWith(COUNTER_FILE_NAME), true);
});

/* —— 静音态（mute.json 纯读） —— */

/* 协作夹具＋可选 mute.json：muteContent 为 null 时不落文件（缺失态），否则按原文写入（可给损坏文）。 */
function writeMuteCollab(dataDir, collabId, muteContent) {
  const files = { [LEDGER_FILE_NAME]: jsonl(ledgerOf({ collabId })) };
  if (muteContent !== null) {
    files[MUTE_FILE_NAME] = muteContent;
  }
  writeFiles(collabDirIn(dataDir, 'main', collabId), files);
}

test('muted：正常读取布尔（论坛/协作同面、baseline 不影响呈现）；缺失/损坏/形态不符一律 false', (t) => {
  const dataDir = makeTempDir(t);
  writeMuteCollab(dataDir, 'c-on', JSON.stringify({ v: 1, muted: true, baseline: 3 }));
  writeMuteCollab(dataDir, 'c-off', JSON.stringify({ v: 1, muted: false, baseline: null }));
  writeMuteCollab(dataDir, 'c-none', null);
  writeMuteCollab(dataDir, 'c-corrupt', '{不是 JSON');
  writeMuteCollab(dataDir, 'c-shape', JSON.stringify({ v: 2, muted: true, baseline: null }));   // 版本不符＝形态不符
  writeFiles(collabDirIn(dataDir, 'main', 'c-forum-on'), {
    [MUTE_FILE_NAME]: JSON.stringify({ v: 1, muted: true, baseline: null }),
    [POSTS_FILE_NAME]: jsonl(postEntry()),
    [MEMBER_FILE_NAME]: JSON.stringify(memberRecord({ mode: 'forum', collabId: 'c-forum-on' })),
  });
  const data = createData(dataDir);
  assert.equal(data.readMeta('main', 'c-on', null).muted, true);
  assert.equal(data.readMeta('main', 'c-off', null).muted, false);
  assert.equal(data.readMeta('main', 'c-none', null).muted, false);
  assert.equal(data.readMeta('main', 'c-corrupt', null).muted, false);
  assert.equal(data.readMeta('main', 'c-shape', null).muted, false);
  assert.equal(data.readMeta('main', 'c-forum-on', null).muted, true);   // 讨论面同取数
  const byId = new Map(data.listCollabs().collabs.map((entry) => [entry.id, entry.muted]));
  assert.deepEqual([...byId.keys()].sort(), ['c-corrupt', 'c-forum-on', 'c-none', 'c-off', 'c-on', 'c-shape']);
  assert.equal(byId.get('c-on'), true);
  assert.equal(byId.get('c-forum-on'), true);
  for (const id of ['c-off', 'c-none', 'c-corrupt', 'c-shape']) {
    assert.equal(byId.get(id), false, id);
  }
});

test('muted：读故障（位置是目录）留痕并按 false 降级，不抛', (t) => {
  const dataDir = makeTempDir(t);
  const dir = collabDirIn(dataDir, 'main', 'c-1');
  writeFiles(dir, { [LEDGER_FILE_NAME]: jsonl(ledgerOf({ collabId: 'c-1' })) });
  mkdirSync(join(dir, MUTE_FILE_NAME), { recursive: true });   // 位置是目录：读取必抛（非 ENOENT）
  const warnings = [];
  const data = createViewerData({ dataDir, log: { warn: (...args) => warnings.push(args) } });
  assert.equal(data.readMeta('main', 'c-1', null).muted, false);
  assert.equal(data.listCollabs().collabs[0].muted, false);
  assert.equal(warnings.length, 2);   // meta 与列表各现读一次，各留一条痕
  assert.match(String(warnings[0][0]), /小 JSON 读取失败/);
  assert.equal(String(warnings[0][1].file).endsWith(MUTE_FILE_NAME), true);
});

test('工厂：接口键与 stats 形态（cacheHits/cacheMisses）', (t) => {
  const data = createData(makeTempDir(t));
  assert.deepEqual(Object.keys(data).sort(), ['listCollabs', 'readFeed', 'readMeta', 'stats']);
  assert.deepEqual(data.stats(), { cacheHits: 0, cacheMisses: 0 });
});

/* —— 大文件夹具 —— */

test('大文件夹具：1500 行台账与 500 帖的正确性（线性量级，不做硬计时断言）', (t) => {
  const dataDir = makeTempDir(t);
  const ledgerLines = [];
  for (let index = 0; index < 1500; index++) {
    ledgerLines.push(ledgerOf({ status: index < 750 ? 'proposed' : 'active', updatedAt: tsPlus(index) }));
  }
  writeFiles(collabDirIn(dataDir, 'main', 'big-ledger'), {
    [MEMBER_FILE_NAME]: JSON.stringify(memberRecord({ collabId: 'big-ledger' })),
    [LEDGER_FILE_NAME]: jsonl(...ledgerLines),
    [COUNTER_FILE_NAME]: JSON.stringify({ v: 1, messageCount: 1500 }),
  });
  const postLines = [];
  for (let index = 0; index < 500; index++) {
    postLines.push(postEntry({ entryId: `post-${index}`, seq: index + 1, ts: tsPlus(index) }));
  }
  writeFiles(collabDirIn(dataDir, 'main', 'big-posts'), {
    [MEMBER_FILE_NAME]: JSON.stringify(memberRecord({ mode: 'forum', collabId: 'big-posts' })),
    [POSTS_FILE_NAME]: jsonl(...postLines),
  });
  const data = createData(dataDir);
  const meta = data.readMeta('main', 'big-ledger', null);
  assert.equal(meta.state, 'active');
  assert.equal(meta.memberCount, 2);
  assert.equal(meta.count, 1500);
  assert.deepEqual(meta.events.rows, [{ id: '750:0', ts: tsPlus(750), text: '状态：proposed → active' }]);
  const feed = data.readFeed('main', 'big-posts', null);
  assert.equal(feed.rows.length, 500);
  assert.equal(feed.rows[499].id, 'post-499@inst-a');
  assert.equal(data.readMeta('main', 'big-posts', null).count, 500);
  assert.equal(data.readFeed('main', 'big-posts', 'post-249@inst-a').rows.length, 250);
});

/* —— 只读白名单（静态自证） —— */

test('只读白名单：data.js 的 import 只含白名单符号（防未来漂移）', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/viewer/data.js', import.meta.url)), 'utf8');
  /* 白名单（设计 §5.2）：store.js 只许 loadMember；model/members/posts 只许判据与折叠纯函数；
   * protocol.js/paths.js 常量与判据函数；node: 内置只取读取面；两个查看器共享模块只读引用。 */
  const expected = new Map([
    ['node:fs', ['readFileSync', 'readdirSync', 'statSync']],
    ['node:path', ['join']],
    ['../paths.js', ['COLLABS_DIR_NAME', 'CONFIG_FILE_NAME', 'SITES_DIR_NAME', 'collabDir', 'collabFilePath']],
    ['../net/protocol.js', ['ID_PATTERN', 'MAX_MESSAGE_TEXT_CHARS', 'POST_KINDS', 'isIdentityName']],
    ['../collab/posts.js', ['isPostEntryShape']],
    ['../collab/members.js', ['foldMemberEvents', 'isMemberEventShape']],
    ['../collab/model.js', ['isLedgerShape', 'isTimestamp']],
    ['../collab/store.js', ['loadMember']],
    ['../collab/mute.js', ['isMuteShape']],   // 纯判据符号；写面 createMuteStore 不在此列
    ['./text.js', ['displayText']],
    ['./meta.js', ['metaViewOf']],
  ]);
  const actual = new Map();
  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('import ')) {
      continue;
    }
    const matched = /^import\s*\{([^}]+)\}\s*from\s*'([^']+)';$/.exec(trimmed);
    assert.notEqual(matched, null, `import 行不属白名单形态：${trimmed}`);
    actual.set(matched[2], matched[1].split(',').map((symbol) => symbol.trim()).filter((symbol) => symbol !== '').sort());
  }
  assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort());
  for (const [module, symbols] of actual) {
    assert.deepEqual(symbols, [...expected.get(module)].sort(), `模块 ${module} 引入了白名单之外的符号`);
  }
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '');   // 注释剔除后再查动态引用（JSDoc 的 import() 类型注解不算）
  assert.equal(/import\s*\(/.test(code), false, '不得有动态 import');
  assert.equal(/require\s*\(/.test(code), false, '不得有 require');
});
