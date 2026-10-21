import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from './helpers.js';
import { createViewerData } from '../src/viewer/data.js';
import { COLLABS_DIR_NAME, CONFIG_FILE_NAME, JOINS_FILE_NAME, SITES_DIR_NAME } from '../src/paths.js';
import { KNOWN_HOSTS_FILE_NAME } from '../src/net/known-hosts.js';
import { POSTS_FILE_NAME } from '../src/collab/posts.js';
import { MEMBERS_FILE_NAME } from '../src/collab/members.js';
import { LEDGER_FILE_NAME, MEMBER_FILE_NAME, SNAPSHOT_FILE_NAME } from '../src/collab/store.js';
import { COUNTER_FILE_NAME } from '../src/collab/counter.js';
import { MUTE_FILE_NAME } from '../src/collab/mute.js';
import { INBOX_FILE_NAME } from '../src/net/inbound.js';
import { OUTBOX_FILE_NAME } from '../src/net/outbox.js';
import { SEAT_FILE_VERSION, isSeatShape } from '../src/collab/local.js';
import { clearFreezeReason, persistFreezeReason } from '../src/collab/takeover.js';
import { INSTANCE_ID_FILE } from '../src/instance-id.js';

/* 0.2.0 本地文件形态：观察窗按设计 §6.2 的文件名就地定义读取面，夹具以各模块导出的
 * 规范常量为准（漂移即红）。 */
const CARRIER_FILE_NAME = 'carrier.json';
const SEATS_DIR_NAME = 'seats';
const INVITES_FILE_NAME = 'invites.json';
const PENDING_INVITES_FILE_NAME = 'pending-invites.json';
const DEPARTED_FILE_NAME = 'departed.jsonl';
const RECOVERY_FILE_NAME = 'recovery.json';
const MIGRATION_FILE_NAME = 'migration.json';

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

/* 夹具默认写成 0.2.0 目录（member.json 在场时补 carrier 标记）；legacy 专项用例传 { legacy: true }
 * 保留旧形态，交给 legacy 只读读取器。 */
function writeFiles(dir, files, options = {}) {
  mkdirSync(dir, { recursive: true });
  const withCarrier = options.legacy === true || files[MEMBER_FILE_NAME] === undefined || files[CARRIER_FILE_NAME] !== undefined
    ? files
    : { ...files, [CARRIER_FILE_NAME]: JSON.stringify(carrierForFiles(files)) };
  for (const [name, content] of Object.entries(withCarrier)) {
    const file = join(dir, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

/* 从同批夹具文件推导一份形态自洽的 carrier：名/主题/模式优先取台账（末条）或快照台账，
 * 其次成员记录；只服务测试夹具，不参与生产读取。 */
function carrierForFiles(files) {
  const member = parseJsonOrNull(files[MEMBER_FILE_NAME]);
  const current = carrierLedgerOf(files, member);
  return {
    format: 'session-seats',
    version: 1,
    ...carrierFieldsOf(member, current),
    snapshotVersion: 1,
    createdAt: T0,
  };
}

function carrierFieldsOf(member, current) {
  return {
    collabId: carrierFieldOr(member, current, 'collabId', 'c-1'),
    name: carrierFieldOr(current, member, 'name', '协作甲'),
    topic: carrierFieldOr(current, member, 'topic', '主题'),
    mode: carrierFieldOr(member, current, 'mode', 'managed'),
    endpoints: member?.endpoints ?? {},
    manager: carrierManagerOf(member, current),
  };
}

function carrierFieldOr(first, second, key, fallback) {
  return pickText(first?.[key], second?.[key]) ?? fallback;
}

function pickText(...values) {
  for (const value of values) {
    const text = textOrNull(value);
    if (text !== null) {
      return text;
    }
  }
  return null;
}

/* 成员机以快照台账为现态来源（台账文件在成员机是过期副本）；站长机取台账末条。 */
function carrierLedgerOf(files, member) {
  const snapshotLedger = parseJsonOrNull(files[SNAPSHOT_FILE_NAME])?.ledger ?? null;
  if (member !== null && member.role === 'member' && snapshotLedger !== null) {
    return snapshotLedger;
  }
  return lastJsonlObject(files[LEDGER_FILE_NAME]) ?? snapshotLedger;
}

function carrierManagerOf(member, current) {
  const manager = current?.manager ?? member?.manager ?? { instanceId: 'mgr-1', identityName: '甲机' };
  return { ...manager, sessionId: manager.sessionId ?? 'session-manager-fx', term: manager.term ?? 1 };
}

function textOrNull(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

function parseJsonOrNull(text) {
  if (typeof text !== 'string') {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function lastJsonlObject(text) {
  if (typeof text !== 'string') {
    return null;
  }
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  for (let index = lines.length - 1; index >= 0; index--) {
    const parsed = parseJsonOrNull(lines[index]);
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
}

function writeConfigAt(baseDir, identityName) {
  mkdirSync(baseDir, { recursive: true });
  writeFileSync(join(baseDir, CONFIG_FILE_NAME), `${JSON.stringify({ identityName })}\n`);
}

/* 数据根本机实例标识：讨论成员事件只有 instanceId，本机排除依赖这一文件。 */
function writeInstanceId(dataDir, instanceId) {
  writeFileSync(join(dataDir, 'instance-id'), `${instanceId}\n`);
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

/* 讨论生命周期事件（真实生产形态，不携 sessionId）：本机、远端、离席、重入各一条路径。 */
function forumLifecycleEvents() {
  return jsonl(
    memberEvent({ eventId: 'ev-a', instanceId: 'inst-a', identityName: '甲机', ts: T0 }),
    memberEvent({ eventId: 'ev-b', instanceId: 'inst-b', identityName: '乙机', ts: tsPlus(1000) }),
    memberEvent({ eventId: 'ev-c', instanceId: 'inst-c', identityName: '丙机', ts: tsPlus(2000) }),
    memberEvent({ eventId: 'ev-b-leave', kind: 'leave', instanceId: 'inst-b', identityName: '乙机', ts: tsPlus(3000) }),
    memberEvent({ eventId: 'ev-d', instanceId: 'inst-d', identityName: '丁机', ts: tsPlus(4000) }),
    memberEvent({ eventId: 'ev-d-leave', kind: 'leave', instanceId: 'inst-d', identityName: '丁机', ts: tsPlus(5000) }),
    memberEvent({ eventId: 'ev-d-rejoin', instanceId: 'inst-d', identityName: '丁机', ts: tsPlus(6000) }),
  );
}

function ledgerOf(over = {}) {
  return {
    version: 1,
    collabId: 'c-1',
    name: '协作甲',
    topic: '主题甲',
    status: 'active',
    managerTerm: 1,
    joinSeqNext: 3,
    manager: { instanceId: 'mgr-1', sessionId: '1111222233334444', identityName: '甲机', term: 1 },
    members: [
      { instanceId: 'mgr-1', sessionId: '1111222233334444', identityName: '甲机', role: 'manager', state: 'member', joinSeq: 1, joinedAt: T0 },
      { instanceId: 'inst-b', sessionId: 'aaaabbbbccccdddd', identityName: '乙机', role: 'member', state: 'member', joinSeq: 2, joinedAt: T0 },
    ],
    board: [],
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

/* 0.1.x 旧台账形态（无 sessionId/joinSeq/managerTerm）：交给 legacy 旧形态读取器。 */
function legacyLedgerOf(over = {}) {
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

/* 0.2.0 会话席位夹具：carrier 是目录形态标记，ledger 名单按 (instanceId, sessionId) 键。 */
const LOCAL_MANAGER_SESSION = '1111222233334444';
const LOCAL_MEMBER_SESSION = '9999888877776666';
const REMOTE_MEMBER_SESSION = 'aaaabbbbccccdddd';
const REMOTE_DEPARTED_SESSION = 'ccccddddeeeeffff';
const PENDING_JOIN_SESSION = 'ddddeeeeffff0000';
/* 讨论席位折叠：本机实例上未落座的会话、远端实例的第二个会话（同机双席按席位键分开）。 */
const FORUM_UNSEATED_LOCAL_SESSION = '7777888899990000';
const REMOTE_SECOND_SESSION = 'aaaabbbbcccc1111';

function carrierRecord(over = {}) {
  return {
    format: 'session-seats',
    version: 1,
    collabId: 'c-1',
    name: '协作甲',
    topic: '主题甲',
    mode: 'managed',
    endpoints: {},
    manager: { instanceId: 'mgr-1', sessionId: LOCAL_MANAGER_SESSION, identityName: '甲机', term: 1 },
    snapshotVersion: 1,
    createdAt: T0,
    ...over,
  };
}

function seatRecord(over = {}) {
  return {
    version: 1,
    sessionId: LOCAL_MANAGER_SESSION,
    role: 'manager',
    state: 'member',
    joinSeq: 1,
    joinedAt: T0,
    muted: false,
    ...over,
  };
}

function sessionLedgerOf(over = {}) {
  return ledgerOf({
    managerTerm: 1,
    joinSeqNext: 3,
    manager: { instanceId: 'mgr-1', sessionId: LOCAL_MANAGER_SESSION, identityName: '甲机', term: 1 },
    members: [
      { instanceId: 'mgr-1', sessionId: LOCAL_MANAGER_SESSION, identityName: '甲机', role: 'manager', state: 'member', joinSeq: 1, joinedAt: T0 },
      { instanceId: 'inst-b', sessionId: REMOTE_MEMBER_SESSION, identityName: '乙机', role: 'member', state: 'member', joinSeq: 2, joinedAt: T0 },
    ],
    ...over,
  });
}

function writeSessionFixture(dataDir, collabId, files = {}) {
  writeConfigAt(dataDir, '甲机');
  writeFiles(collabDirIn(dataDir, 'main', collabId), {
    [CARRIER_FILE_NAME]: JSON.stringify(carrierRecord({ collabId })),
    [LEDGER_FILE_NAME]: jsonl(sessionLedgerOf({ collabId })),
    [`${SEATS_DIR_NAME}/${LOCAL_MANAGER_SESSION}.json`]: JSON.stringify(seatRecord()),
    ...files,
  });
}

/* 完整席位视图夹具：双本机席位（一静音）＋远端成员＋离席历史＋待回应邀请/待确认入席＋冻结原因。 */
function writeFullSessionFixture(dataDir) {
  writeSessionFixture(dataDir, 'c-1', { ...fullSeatFiles(), ...fullInviteFiles() });
  writeFileSync(join(dataDir, KNOWN_HOSTS_FILE_NAME), JSON.stringify({
    version: 4,
    hosts: [
      { address: '10.0.0.9', port: 7323, instanceId: 'inst-c', identityName: '丙机', lastSeenAt: T0, sessions: [] },
    ],
  }));
}

function fullSeatFiles() {
  return {
    [`${SEATS_DIR_NAME}/${LOCAL_MEMBER_SESSION}.json`]: JSON.stringify(seatRecord({
      sessionId: LOCAL_MEMBER_SESSION,
      role: 'member',
      joinSeq: 3,
      muted: true,
    })),
    /* 冻结原因按运行时写入面落在 carrier（台账只留状态）；读取面以 carrier 为权威。 */
    [CARRIER_FILE_NAME]: JSON.stringify({ ...carrierRecord({ collabId: 'c-1' }), freezeReason: 'manager-offline' }),
    [LEDGER_FILE_NAME]: jsonl(sessionLedgerOf({ collabId: 'c-1', status: 'frozen' })),
    [DEPARTED_FILE_NAME]: `${jsonl(
      { instanceId: 'inst-c', sessionId: REMOTE_DEPARTED_SESSION, reason: 'manager-session-closed', term: 3, at: tsPlus(5000) },
    )}${JSON.stringify({ bad: 'line' })}\n`,
  };
}

function fullInviteFiles() {
  return {
    [PENDING_INVITES_FILE_NAME]: JSON.stringify({
      version: 1,
      invites: [
        {
          inviteId: 'inv-1',
          collabId: 'c-1',
          fromManager: { instanceId: 'inst-c', sessionId: REMOTE_DEPARTED_SESSION },
          targetSessionId: REMOTE_MEMBER_SESSION,
          expiresAt: tsPlus(60000),
          state: 'open',
          acceptedSessions: [],
        },
        { inviteId: 'inv-closed', collabId: 'c-1', state: 'consumed', expiresAt: tsPlus(1000) },
      ],
    }),
    [INVITES_FILE_NAME]: JSON.stringify({
      version: 1,
      invites: [
        { inviteId: 'inv-2', targets: [{ instanceId: 'inst-b', targetSessionId: REMOTE_MEMBER_SESSION }], createdAt: T0, expiresAt: tsPlus(90000), state: 'open' },
        { inviteId: 'inv-3', targets: [], createdAt: T0, expiresAt: tsPlus(90000), state: 'closed' },
      ],
    }),
    [JOINS_FILE_NAME]: JSON.stringify({
      v: 2,
      pendingJoins: [
        { joinId: 'j-1', instanceId: 'inst-d', sessionId: PENDING_JOIN_SESSION, managerTerm: 1, grantVersion: 2, requestedAt: T0, expiresAt: tsPlus(30000) },
      ],
    }),
  };
}

function fullSessionViewExpected() {
  return {
    localSeats: [
      { identityName: '甲机', sessionId: '11112222', role: 'manager', state: 'member', joinSeq: 1, muted: false },
      { identityName: '甲机', sessionId: '99998888', role: 'member', state: 'member', joinSeq: 3, muted: true },
    ],
    remoteSeats: [
      { instanceId: 'inst-b', identityName: '乙机', sessionId: 'aaaabbbb', role: 'member', state: 'member', joinSeq: 2 },
    ],
    departed: [
      { instanceId: 'inst-c', identityName: '丙机', sessionId: 'ccccdddd', reason: 'manager-session-closed', at: tsPlus(5000) },
    ],
    pendingInvites: [
      { inviteId: 'inv-1', targetSessionId: 'aaaabbbb', fromInstanceId: 'inst-c', fromSessionId: 'ccccdddd', fromName: '丙机', expiresAt: tsPlus(60000) },
      { inviteId: 'inv-2', expiresAt: tsPlus(90000) },
    ],
    pendingJoins: [
      { sessionId: 'ddddeeee', expiresAt: tsPlus(30000) },
    ],
    activeSeatCount: 2,
    localSeatCount: 2,
    mutedSeatCount: 1,
    freezeReason: 'manager-offline',
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

test('managed：站长席位——台账末条为名/态权威，人数取名单长度，计数取累计收到，迁移行 id/文本/序正确', (t) => {
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
  const { sessions, ...metaCore } = meta;
  assert.deepEqual(metaCore, {
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
  });
  assert.equal(sessions.activeSeatCount, 2);
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
          { instanceId: 'mgr-1', sessionId: '1111222233334444', identityName: '甲机', role: 'manager', state: 'member', joinSeq: 1, joinedAt: T0 },
          { instanceId: 'inst-b', sessionId: 'aaaabbbbccccdddd', identityName: '乙机', role: 'member', state: 'member', joinSeq: 2, joinedAt: T0 },
          { instanceId: 'inst-c', sessionId: 'bbbbccccddddeeee', identityName: '丙机', role: 'member', state: 'member', joinSeq: 3, joinedAt: T0 },
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
  });
  assert.equal(data.readFeed('s2', 'ok-1', null), null);   // sites 槽位目录不存在
  mkdirSync(collabDirIn(dataDir, 's2', 'ok-1'), { recursive: true });
  assert.deepEqual(data.readFeed('s2', 'ok-1', null), { rows: [], reset: true, skipped: 0 });
});

/* —— 列表（全根扫描） —— */

function writeListFixture(dataDir) {
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
  writeFiles(collabDirIn(dataDir, 's2', 'c-1'), {
    [MEMBER_FILE_NAME]: JSON.stringify(memberRecord({ collabId: 'c-1', role: 'member', name: '成员乙' })),
    [SNAPSHOT_FILE_NAME]: JSON.stringify(snapshotOf({ ledger: ledgerOf({ name: '协作乙', status: 'proposed' }) })),
  });
  mkdirSync(join(dataDir, SITES_DIR_NAME, 'README'), { recursive: true });
  stampAllFiles(collabDirIn(dataDir, 'main', 'c-1'), 1700000100);
  stampAllFiles(collabDirIn(dataDir, 'main', 'c-2'), 1700000200);
  stampAllFiles(collabDirIn(dataDir, 's2', 'c-1'), 1700000300);
}

test('listCollabs：主目录＋sites 双根（同名 id 两目录）、非 ID_PATTERN 目录忽略、updatedAt 最大者倒序', (t) => {
  const dataDir = makeTempDir(t);
  writeListFixture(dataDir);
  const { collabs } = createData(dataDir).listCollabs();
  assert.deepEqual(collabs.map((entry) => ({
    root: entry.root,
    id: entry.id,
    name: entry.name,
    state: entry.state,
    mode: entry.mode,
    memberCount: entry.memberCount,
    count: entry.count,
    updatedAt: entry.updatedAt,
  })), [
    { root: 's2', id: 'c-1', name: '成员乙', state: 'active', mode: 'managed', memberCount: 2, count: null, updatedAt: 1700000300000 },
    { root: 'main', id: 'c-2', name: '协作甲', state: 'frozen', mode: 'managed', memberCount: 2, count: 5, updatedAt: 1700000200000 },
    { root: 'main', id: 'c-1', name: '甲机', state: 'active', mode: 'forum', memberCount: 2, count: 2, updatedAt: 1700000100000 },
  ]);
  assert.equal(collabs[0].sessions.activeSeatCount, 2);   // 成员席位取快照名单
  assert.equal(collabs[1].sessions.activeSeatCount, 2);   // 站长席位取台账名单
  assert.equal(collabs[1].sessions.remoteSeats.length, 2);   // 无本机席位文件承接：本机站长行保留在远端段，不静默消失
  assert.equal(collabs[2].sessions.activeSeatCount, 2);   // 讨论取成员事件折叠
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

test('缓存：小 JSON 直读不缓存——counter/member/config 同尺寸改写后即读到', (t) => {
  const dataDir = makeTempDir(t);
  writeConfigAt(dataDir, '甲机');
  const dir = collabDirIn(dataDir, 'main', 'c-1');
  writeFiles(dir, {
    [MEMBER_FILE_NAME]: JSON.stringify(memberRecord({ collabId: 'c-1', role: 'member', name: '甲机' })),
    [COUNTER_FILE_NAME]: JSON.stringify({ v: 1, messageCount: 5 }),
    [OUTBOX_FILE_NAME]: jsonl(outboxRow()),
  });
  const data = createData(dataDir);
  assert.equal(data.readMeta('main', 'c-1', null).count, 5);
  assert.equal(data.readMeta('main', 'c-1', null).name, '甲机');
  assert.equal(data.readFeed('main', 'c-1', null).rows[0].fromName, '甲机');
  writeFileSync(join(dir, COUNTER_FILE_NAME), JSON.stringify({ v: 1, messageCount: 7 }));
  writeFileSync(join(dir, MEMBER_FILE_NAME), JSON.stringify(memberRecord({ collabId: 'c-1', role: 'member', name: '乙机' })));
  writeConfigAt(dataDir, '乙机');
  assert.equal(data.readMeta('main', 'c-1', null).count, 7);
  assert.equal(data.readMeta('main', 'c-1', null).name, '乙机');
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

/* —— 会话级静音（按本机席位聚合，退役机器级 mute.json 布尔） —— */

test('静音：按本机席位聚合 mutedSeatCount；mute.json 的机器级布尔不再参与呈现', (t) => {
  const dataDir = makeTempDir(t);
  writeSessionFixture(dataDir, 'c-1', {
    [`${SEATS_DIR_NAME}/${LOCAL_MEMBER_SESSION}.json`]: JSON.stringify(seatRecord({
      sessionId: LOCAL_MEMBER_SESSION,
      role: 'member',
      joinSeq: 3,
      muted: true,
    })),
    [MUTE_FILE_NAME]: JSON.stringify({ v: 1, muted: true, baseline: null }),   // 退役文件：留盘但不读
  });
  const data = createData(dataDir);
  const entry = data.listCollabs().collabs[0];
  const meta = data.readMeta('main', 'c-1', null);
  assert.equal(entry.sessions.mutedSeatCount, 1);
  assert.equal(entry.sessions.localSeatCount, 2);
  assert.equal(meta.sessions.mutedSeatCount, 1);
  assert.deepEqual(meta.sessions.localSeats.map((seat) => seat.muted), [false, true]);
  assert.equal('muted' in entry, false, '列表条目不得再有机器级静音布尔');
  assert.equal('muted' in meta, false, '详情 meta 不得再有机器级静音布尔');
});

test('归档席位：不进入 localSeats、不计入 mutedSeatCount 与讨论活跃数（与服务状态栏同口径）', (t) => {
  const dataDir = makeTempDir(t);
  writeConfigAt(dataDir, '甲机');
  writeInstanceId(dataDir, 'inst-a');
  writeFiles(collabDirIn(dataDir, 'main', 'c-forum-archived'), {
    [CARRIER_FILE_NAME]: JSON.stringify(carrierRecord({ collabId: 'c-forum-archived', name: '讨论甲', mode: 'forum' })),
    [MEMBERS_FILE_NAME]: jsonl(
      memberEvent({ eventId: 'ev-a', instanceId: 'inst-a', identityName: '甲机', ts: T0 }),
      memberEvent({ eventId: 'ev-b', instanceId: 'inst-b', identityName: '乙机', ts: tsPlus(1000) }),
    ),
    [`${SEATS_DIR_NAME}/${LOCAL_MANAGER_SESSION}.json`]: JSON.stringify(seatRecord({ role: 'member', joinSeq: 1 })),
    [`${SEATS_DIR_NAME}/${LOCAL_MEMBER_SESSION}.json`]: JSON.stringify(seatRecord({
      sessionId: LOCAL_MEMBER_SESSION,
      role: 'member',
      joinSeq: 2,
      muted: true,
      archivedAt: tsPlus(5000),
    })),
    [POSTS_FILE_NAME]: jsonl(postEntry()),
  });
  const data = createData(dataDir);
  const entry = data.listCollabs().collabs[0];
  const meta = data.readMeta('main', 'c-forum-archived', null);
  assert.deepEqual(meta.sessions.localSeats.map((seat) => seat.sessionId), ['11112222'], '归档席位不出现在本机席位段');
  assert.equal(meta.sessions.localSeatCount, 1);
  assert.equal(meta.sessions.mutedSeatCount, 0, '归档席位不参与静音聚合');
  assert.equal(meta.sessions.activeSeatCount, 2, '讨论活跃＝本机活跃 1 ＋远端 1（归档席不计）');
  assert.equal(meta.memberCount, meta.sessions.activeSeatCount, '人数与活跃同源');
  assert.equal(entry.sessions.localSeatCount, 1);
  assert.deepEqual(entry.sessions.remoteSeats.map((seat) => seat.instanceId), ['inst-b'], '归档席位不得以远端成员身份重复出现');
});

test('静音：席位文件缺失/损坏时按 0 席静音（不读 mute.json 兜底）', (t) => {
  const dataDir = makeTempDir(t);
  writeFiles(collabDirIn(dataDir, 'main', 'c-1'), {
    [CARRIER_FILE_NAME]: JSON.stringify(carrierRecord({ collabId: 'c-1' })),
    [LEDGER_FILE_NAME]: jsonl(sessionLedgerOf({ collabId: 'c-1' })),
    [MUTE_FILE_NAME]: JSON.stringify({ v: 1, muted: true, baseline: null }),
  });
  const meta = createData(dataDir).readMeta('main', 'c-1', null);
  assert.deepEqual(meta.sessions.localSeats, []);
  assert.equal(meta.sessions.mutedSeatCount, 0);
  assert.equal('muted' in meta, false);
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

/* —— 会话席位视图（本机会员席位 / 远端成员 / 离席历史） —— */

test('sessions：成员按会话展示——本机席位（机器名＋短码＋角色＋状态＋joinSeq）、远端成员、离席历史、待回应邀请/待确认入席、冻结原因', (t) => {
  const dataDir = makeTempDir(t);
  writeFullSessionFixture(dataDir);
  const data = createData(dataDir);
  const expected = fullSessionViewExpected();
  assert.deepEqual(data.listCollabs().collabs[0].sessions, expected);
  const meta = data.readMeta('main', 'c-1', null);
  assert.deepEqual(meta.sessions, expected);
  assert.equal(meta.name, '协作甲');
  assert.equal(meta.state, 'frozen');
  assert.equal(meta.mode, 'managed');
  assert.equal(meta.memberCount, 2);
  assert.equal(meta.topic, '主题甲');
  for (const retired of ['localBound', 'localGranted', 'grantedRemote', 'published']) {
    assert.equal(retired in meta.sessions, false, `旧四视图字段应已移除：${retired}`);
  }
});

test('sessions：讨论远端成员按真实事件形态折叠——本机实例排除、leave 移出、重入按最新事件、人数与活跃同源', (t) => {
  const dataDir = makeTempDir(t);
  writeConfigAt(dataDir, '甲机');
  writeInstanceId(dataDir, 'inst-a');
  writeFiles(collabDirIn(dataDir, 'main', 'c-forum'), {
    [CARRIER_FILE_NAME]: JSON.stringify(carrierRecord({ collabId: 'c-forum', name: '讨论甲', mode: 'forum' })),
    /* 生产成员事件只有 eventId/kind/instanceId/identityName/ts，不携 sessionId。 */
    [MEMBERS_FILE_NAME]: forumLifecycleEvents(),
    [`${SEATS_DIR_NAME}/${LOCAL_MANAGER_SESSION}.json`]: JSON.stringify(seatRecord({ role: 'member', joinSeq: 1 })),
    [POSTS_FILE_NAME]: jsonl(postEntry()),
  });
  const data = createData(dataDir);
  const expected = {
    localSeats: [
      { identityName: '甲机', sessionId: '11112222', role: 'member', state: 'member', joinSeq: 1, muted: false },
    ],
    remoteSeats: [
      { instanceId: 'inst-c', identityName: '丙机', role: 'member', state: 'member' },
      { instanceId: 'inst-d', identityName: '丁机', role: 'member', state: 'member' },
    ],
    departed: [],
    pendingInvites: [],
    pendingJoins: [],
    activeSeatCount: 3,
    localSeatCount: 1,
    mutedSeatCount: 0,
  };
  assert.deepEqual(data.listCollabs().collabs[0].sessions, expected);
  const meta = data.readMeta('main', 'c-forum', null);
  assert.deepEqual(meta.sessions, expected);
  assert.equal(meta.memberCount, 3, '讨论人数与活跃席位同源（本机 1 + 远端 2）');
  assert.equal(meta.sessions.activeSeatCount, meta.memberCount, '不得一人三席');
  assert.equal(meta.sessions.activeSeatCount, meta.sessions.localSeatCount + meta.sessions.remoteSeats.length, 'UI 三数自洽');
  assert.equal(meta.mode, 'forum');
});

test('sessions：讨论本机双席不重复计入远端；活跃数＝本机＋远端、人数同源', (t) => {
  const dataDir = makeTempDir(t);
  writeConfigAt(dataDir, '甲机');
  writeInstanceId(dataDir, 'inst-a');
  writeFiles(collabDirIn(dataDir, 'main', 'c-forum'), {
    [CARRIER_FILE_NAME]: JSON.stringify(carrierRecord({ collabId: 'c-forum', name: '讨论甲', mode: 'forum' })),
    [MEMBERS_FILE_NAME]: jsonl(
      memberEvent({ eventId: 'ev-a', instanceId: 'inst-a', identityName: '甲机', ts: T0 }),
      memberEvent({ eventId: 'ev-b', instanceId: 'inst-b', identityName: '乙机', ts: tsPlus(1000) }),
    ),
    [`${SEATS_DIR_NAME}/${LOCAL_MANAGER_SESSION}.json`]: JSON.stringify(seatRecord({ role: 'member', joinSeq: 1 })),
    [`${SEATS_DIR_NAME}/${LOCAL_MEMBER_SESSION}.json`]: JSON.stringify(seatRecord({
      sessionId: LOCAL_MEMBER_SESSION,
      role: 'member',
      joinSeq: 2,
    })),
    [POSTS_FILE_NAME]: jsonl(postEntry()),
  });
  const meta = createData(dataDir).readMeta('main', 'c-forum', null);
  assert.equal(meta.sessions.localSeatCount, 2, '本机两席都在本机席位段');
  assert.deepEqual(meta.sessions.remoteSeats.map((seat) => seat.instanceId), ['inst-b'], '本机实例不得再列为远端');
  assert.equal(meta.sessions.activeSeatCount, meta.memberCount, '活跃数与人数同源');
  assert.equal(meta.sessions.activeSeatCount, 3, '活跃＝本机 2 席＋远端 1 席：本机会话按席位计、远端按机器折叠');
  assert.equal(meta.sessions.activeSeatCount, meta.sessions.localSeatCount + meta.sessions.remoteSeats.length, 'UI 三数自洽');
});

test('sessions：讨论成员事件带 sessionId 时按席位键折叠——本机会话按短码排除，未落座的本机会话仍保留', (t) => {
  const dataDir = makeTempDir(t);
  writeConfigAt(dataDir, '甲机');
  writeInstanceId(dataDir, 'inst-a');
  writeFiles(collabDirIn(dataDir, 'main', 'c-forum-seat'), {
    [CARRIER_FILE_NAME]: JSON.stringify(carrierRecord({ collabId: 'c-forum-seat', name: '讨论甲', mode: 'forum' })),
    [MEMBERS_FILE_NAME]: jsonl(
      memberEvent({ eventId: 'ev-a', instanceId: 'inst-a', sessionId: LOCAL_MANAGER_SESSION, ts: T0 }),
      memberEvent({ eventId: 'ev-b', instanceId: 'inst-a', sessionId: LOCAL_MEMBER_SESSION, ts: tsPlus(1000) }),
      memberEvent({ eventId: 'ev-c', instanceId: 'inst-a', sessionId: FORUM_UNSEATED_LOCAL_SESSION, ts: tsPlus(2000) }),
      memberEvent({ eventId: 'ev-d1', instanceId: 'inst-b', sessionId: REMOTE_MEMBER_SESSION, ts: tsPlus(3000) }),
      memberEvent({ eventId: 'ev-d2', instanceId: 'inst-b', sessionId: REMOTE_SECOND_SESSION, ts: tsPlus(4000) }),
      memberEvent({ eventId: 'ev-d1-leave', kind: 'leave', instanceId: 'inst-b', sessionId: REMOTE_MEMBER_SESSION, ts: tsPlus(5000) }),
    ),
    [`${SEATS_DIR_NAME}/${LOCAL_MANAGER_SESSION}.json`]: JSON.stringify(seatRecord({ role: 'member', joinSeq: 1 })),
    [`${SEATS_DIR_NAME}/${LOCAL_MEMBER_SESSION}.json`]: JSON.stringify(seatRecord({
      sessionId: LOCAL_MEMBER_SESSION,
      role: 'member',
      joinSeq: 2,
    })),
    [POSTS_FILE_NAME]: jsonl(postEntry()),
  });
  const data = createData(dataDir);
  const entry = data.listCollabs().collabs[0];
  assert.equal(entry.sessions.localSeatCount, 2);
  assert.deepEqual(entry.sessions.remoteSeats.map((seat) => seat.sessionId), ['77778888', 'aaaabbbb'],
    '按席位键折叠：本机已落座两席不重复；未落座的本机会话与远端同机另一席各占一行');
  assert.deepEqual(entry.sessions.remoteSeats.map((seat) => seat.instanceId), ['inst-a', 'inst-b']);
  assert.equal(entry.sessions.activeSeatCount, 4, '活跃＝本机 2 席＋远端 2 席');
  assert.equal(entry.memberCount, 4, '讨论人数取同一折叠结果（不是按机器折叠的 2 人）');
  assert.equal(entry.sessions.activeSeatCount, entry.sessions.localSeatCount + entry.sessions.remoteSeats.length, 'UI 三数自洽');
  const meta = data.readMeta('main', 'c-forum-seat', null);
  assert.equal(meta.memberCount, meta.sessions.activeSeatCount, '列表与详情同一来源');
});

test('sessions：freezeReason——carrier 权威、台账仅兼容兜底（台账残留旧值不得遮蔽 carrier、也不得在解除后复活）', (t) => {
  const dataDir = makeTempDir(t);
  writeFreezeReasonFixture(dataDir, 'c-carrier-wins', {
    ledgerReason: 'manager-fork',
    carrierReason: 'manager-offline',
  });
  writeFreezeReasonFixture(dataDir, 'c-carrier-only', { carrierReason: 'manager-pending' });
  writeFreezeReasonFixture(dataDir, 'c-ledger-only', { ledgerReason: 'manager-fork', withCarrier: false });
  writeFreezeReasonFixture(dataDir, 'c-null', { ledgerReason: null, carrierReason: 'manager-offline' });
  writeFreezeReasonFixture(dataDir, 'c-empty', { ledgerReason: '', carrierReason: 'manager-offline' });
  writeFreezeReasonFixture(dataDir, 'c-cleared', { ledgerReason: 'manager-fork', carrierReason: undefined });
  writeFreezeReasonFixture(dataDir, 'c-plain', {});
  const byId = new Map(createData(dataDir).listCollabs().collabs.map((entry) => [entry.id, entry]));
  assert.equal(byId.get('c-carrier-wins').sessions.freezeReason, 'manager-offline', 'carrier 新值优先于台账旧值');
  assert.equal(byId.get('c-carrier-only').sessions.freezeReason, 'manager-pending', 'carrier 有值即取');
  assert.equal(byId.get('c-ledger-only').sessions.freezeReason, 'manager-fork', '无 carrier 的兼容形态才回退台账');
  assert.equal(byId.get('c-null').sessions.freezeReason, 'manager-offline', 'null 不得遮蔽 carrier');
  assert.equal(byId.get('c-empty').sessions.freezeReason, 'manager-offline', '空串不得遮蔽 carrier');
  assert.equal('freezeReason' in byId.get('c-cleared').sessions, false, 'carrier 已清除时台账残留旧值不得复活冻结原因');
  assert.equal('freezeReason' in byId.get('c-plain').sessions, false, '缺省不造字段');
});

function writeFreezeReasonFixture(dataDir, collabId, { ledgerReason = undefined, carrierReason = undefined, withCarrier = true } = {}) {
  const carrier = carrierRecord({ collabId });
  if (carrierReason !== undefined) {
    carrier.freezeReason = carrierReason;
  }
  const ledger = ledgerOf({ collabId, status: 'frozen' });
  if (ledgerReason !== undefined) {
    ledger.freezeReason = ledgerReason;
  }
  writeFiles(collabDirIn(dataDir, 'main', collabId), {
    ...(withCarrier ? { [CARRIER_FILE_NAME]: JSON.stringify(carrier) } : {}),
    [LEDGER_FILE_NAME]: jsonl(ledger),
  });
}

test('sessions：freezeReason 真实写路径（运行时落盘形态）——persist 写 carrier、clear 后字段消失（台账旧值不遮蔽）', (t) => {
  const dataDir = makeTempDir(t);
  const collabId = 'c-freeze-write';
  const dir = collabDirIn(dataDir, 'main', collabId);
  writeFiles(dir, {
    [CARRIER_FILE_NAME]: JSON.stringify(carrierRecord({ collabId })),
    /* 台账残留旧冻结原因：写入面只写 carrier，任何台账旧值都不得遮蔽 carrier 的新值/清除。 */
    [LEDGER_FILE_NAME]: jsonl(ledgerOf({ collabId, status: 'frozen', freezeReason: 'manager-fork' })),
  });
  const state = {
    dataDir,
    collabs: new Map([[collabId, { collabId, member: null }]]),
    counters: {},
    log: { info() {}, warn() {}, error() {} },
    config: {},
  };
  assert.equal(persistFreezeReason(state, collabId, 'manager-offline'), true);
  const data = createData(dataDir);
  assert.equal(data.readMeta('main', collabId, null).sessions.freezeReason, 'manager-offline', 'carrier 新值优先');
  assert.equal(JSON.parse(readFileSync(join(dir, CARRIER_FILE_NAME), 'utf8')).freezeReason, 'manager-offline', '落盘在 carrier');
  assert.equal(clearFreezeReason(state, collabId), true);
  const thawed = data.readMeta('main', collabId, null);
  assert.equal('freezeReason' in thawed.sessions, false, '解除后字段消失（台账旧值不得让它复活）');
  assert.equal('freezeReason' in JSON.parse(readFileSync(join(dir, CARRIER_FILE_NAME), 'utf8')), false, 'carrier 字段已删除');
});

test('sessions：冻结→解除后不再显示旧原因（写入方清空台账与 carrier 即消失）', (t) => {
  const dataDir = makeTempDir(t);
  const dir = collabDirIn(dataDir, 'main', 'c-thaw');
  writeFreezeReasonFixture(dataDir, 'c-thaw', {
    ledgerReason: 'manager-offline',
    carrierReason: 'manager-offline',
  });
  const data = createData(dataDir);
  assert.equal(data.readMeta('main', 'c-thaw', null).sessions.freezeReason, 'manager-offline');
  /* 解除冻结：写入方把台账与 carrier 的原因都清掉（台账转 active、不带原因）。 */
  writeFileSync(join(dir, LEDGER_FILE_NAME), jsonl(ledgerOf({ collabId: 'c-thaw', status: 'active' })));
  writeFileSync(join(dir, CARRIER_FILE_NAME), JSON.stringify(carrierRecord({ collabId: 'c-thaw' })));
  const thawed = data.readMeta('main', 'c-thaw', null);
  assert.equal(thawed.state, 'active');
  assert.equal('freezeReason' in thawed.sessions, false, '解除冻结后不得继续显示旧原因');
});

test('sessions：坏 carrier（无合规 format）不按新形态处理——meta 与 legacy sessions 一致', (t) => {
  const dataDir = makeTempDir(t);
  writeFiles(collabDirIn(dataDir, 'main', 'c-badcarrier'), {
    [MEMBER_FILE_NAME]: JSON.stringify(memberRecord({ collabId: 'c-badcarrier' })),
    [LEDGER_FILE_NAME]: jsonl(legacyLedgerOf({ collabId: 'c-badcarrier' })),
    [CARRIER_FILE_NAME]: JSON.stringify({}),
  }, { legacy: true });
  const meta = createData(dataDir).readMeta('main', 'c-badcarrier', null);
  assert.equal(meta.sessions.legacy, true);
  assert.equal(meta.state, 'completed', '坏 carrier 不得把旧协作显示成进行中');
  assert.equal(meta.name, '协作甲');
});

test('sessions：离席历史只读——真实形态条目展示、坏行跳过、无文件为空', (t) => {
  const dataDir = makeTempDir(t);
  writeSessionFixture(dataDir, 'c-departed', {
    [DEPARTED_FILE_NAME]: `${jsonl({ instanceId: 'inst-c', sessionId: REMOTE_DEPARTED_SESSION, reason: 'manager-session-closed', term: 3, at: tsPlus(5000) })}${JSON.stringify({ bad: 'line' })}\n`,
  });
  writeSessionFixture(dataDir, 'c-nodeparted');
  const byId = new Map(createData(dataDir).listCollabs().collabs.map((entry) => [entry.id, entry]));
  assert.deepEqual(byId.get('c-departed').sessions.departed, [
    { instanceId: 'inst-c', sessionId: 'ccccdddd', reason: 'manager-session-closed', at: tsPlus(5000) },
  ]);
  assert.deepEqual(byId.get('c-nodeparted').sessions.departed, [], '无离席文件＝如实空，不造条目');
});

test('sessions：离席历史的 sessionId:null（生产者实例级离席）按条目展示计数，非法非 null 标识仍跳过', (t) => {
  const dataDir = makeTempDir(t);
  writeSessionFixture(dataDir, 'c-departed-null', {
    [DEPARTED_FILE_NAME]: jsonl(
      { instanceId: 'inst-d', sessionId: null, reason: 'session-timeout', term: 2, at: tsPlus(6000) },
      { instanceId: 'inst-e', sessionId: 42, reason: 'manager-lost' },
      { instanceId: 'inst-c', sessionId: REMOTE_DEPARTED_SESSION, reason: 'manager-session-closed', at: tsPlus(5000) },
    ),
  });
  const entry = createData(dataDir).listCollabs().collabs.find((collab) => collab.id === 'c-departed-null');
  assert.deepEqual(entry.sessions.departed, [
    { instanceId: 'inst-d', reason: 'session-timeout', at: tsPlus(6000) },
    { instanceId: 'inst-c', sessionId: 'ccccdddd', reason: 'manager-session-closed', at: tsPlus(5000) },
  ], 'null 是合法的实例级离席形态（不是坏行）；非 null 非法标识仍按坏行跳过');
});

test('sessions：坏 JSON carrier/recovery 明确告警不静默，页面按可读来源降级', (t) => {
  const dataDir = makeTempDir(t);
  writeFiles(collabDirIn(dataDir, 'main', 'c-badcarrier'), {
    [MEMBER_FILE_NAME]: JSON.stringify(memberRecord({ collabId: 'c-badcarrier' })),
    [LEDGER_FILE_NAME]: jsonl(legacyLedgerOf({ collabId: 'c-badcarrier' })),
    [CARRIER_FILE_NAME]: '{坏 JSON',
  }, { legacy: true });
  writeFiles(collabDirIn(dataDir, 'main', 'c-badrecovery'), {
    [CARRIER_FILE_NAME]: JSON.stringify(carrierRecord({ collabId: 'c-badrecovery' })),
    [RECOVERY_FILE_NAME]: '{坏 JSON',
  });
  const warnings = [];
  const data = createViewerData({ dataDir, log: { warn: (...args) => warnings.push(args) } });
  const badCarrier = data.readMeta('main', 'c-badcarrier', null);
  assert.equal(badCarrier.sessions.legacy, true, '坏 carrier 交给旧形态读取器');
  const badRecovery = data.readMeta('main', 'c-badrecovery', null);
  assert.equal('recovery' in badRecovery.sessions, false, '坏恢复标记按无标记降级');
  assert.equal(warnings.some((args) => String(args[0]).includes('carrier JSON 解析失败')), true);
  assert.equal(warnings.some((args) => String(args[0]).includes('恢复标记不可用')), true);
});

test('sessions：坏席位文件告警并计数（按不存在处理），合法席位不受影响', (t) => {
  const dataDir = makeTempDir(t);
  writeSessionFixture(dataDir, 'c-1', {
    [`${SEATS_DIR_NAME}/2222333344445555.json`]: '{不是 JSON',
    [`${SEATS_DIR_NAME}/3333444455556666.json`]: JSON.stringify({ version: 1, sessionId: '3333444455556666', role: 'emperor', state: 'member' }),
  });
  const warnings = [];
  const data = createViewerData({ dataDir, log: { warn: (...args) => warnings.push(args) } });
  const entry = data.listCollabs().collabs[0];
  assert.equal(entry.sessions.corruptSeatCount, 2);
  assert.equal(entry.sessions.localSeatCount, 1);
  assert.equal(entry.sessions.localSeats[0].sessionId, '11112222');
  assert.equal(warnings.filter((args) => String(args[0]).includes('席位文件损坏')).length, 2);
});

test('sessions：本机席位文件缺失/损坏时本机参与者不从两段同时消失——台账行留在远端段、活跃数闭合', (t) => {
  const dataDir = makeTempDir(t);
  writeInstanceId(dataDir, 'mgr-1');
  for (const collabId of ['c-missing-seat', 'c-corrupt-seat']) {
    writeFiles(collabDirIn(dataDir, 'main', collabId), {
      [CARRIER_FILE_NAME]: JSON.stringify(carrierRecord({ collabId })),
      [LEDGER_FILE_NAME]: jsonl(ledgerOf({ collabId })),
      ...(collabId === 'c-corrupt-seat' ? { [`${SEATS_DIR_NAME}/${LOCAL_MANAGER_SESSION}.json`]: '{坏 JSON' } : {}),
    });
  }
  const byId = new Map(createData(dataDir).listCollabs().collabs.map((entry) => [entry.id, entry]));
  for (const collabId of ['c-missing-seat', 'c-corrupt-seat']) {
    const entry = byId.get(collabId);
    assert.equal(entry.sessions.localSeatCount, 0, `${collabId}：席位文件不可用＝本机段为空`);
    assert.deepEqual(entry.sessions.remoteSeats.map((seat) => seat.sessionId), ['11112222', 'aaaabbbb'],
      `${collabId}：本机台账行保留在远端段（不得两段同时消失）`);
    assert.equal(entry.sessions.activeSeatCount, 2, `${collabId}：活跃数仍取台账`);
    assert.equal(entry.sessions.activeSeatCount, entry.sessions.localSeatCount + entry.sessions.remoteSeats.length,
      `${collabId}：可见行数与活跃数闭合`);
  }
  assert.equal('corruptSeatCount' in byId.get('c-missing-seat').sessions, false, '缺失不是损坏');
  assert.equal(byId.get('c-corrupt-seat').sessions.corruptSeatCount, 1, '损坏按不存在处理但告警计数');
});

test('sessions：讨论本机席位文件缺失/损坏时成员事件保留在远端段，人数与可见席位自洽', (t) => {
  const dataDir = makeTempDir(t);
  writeConfigAt(dataDir, '甲机');
  writeInstanceId(dataDir, 'inst-a');
  for (const collabId of ['c-forum-missing-seat', 'c-forum-corrupt-seat']) {
    writeFiles(collabDirIn(dataDir, 'main', collabId), {
      [CARRIER_FILE_NAME]: JSON.stringify(carrierRecord({ collabId, mode: 'forum' })),
      [MEMBERS_FILE_NAME]: jsonl(
        memberEvent({ eventId: 'ev-a', instanceId: 'inst-a', identityName: '甲机', ts: T0 }),
        memberEvent({ eventId: 'ev-b', instanceId: 'inst-b', identityName: '乙机', ts: tsPlus(1000) }),
      ),
      ...(collabId === 'c-forum-corrupt-seat' ? { [`${SEATS_DIR_NAME}/${LOCAL_MANAGER_SESSION}.json`]: '{坏 JSON' } : {}),
      [POSTS_FILE_NAME]: jsonl(postEntry()),
    });
  }
  const byId = new Map(createData(dataDir).listCollabs().collabs.map((entry) => [entry.id, entry]));
  for (const collabId of ['c-forum-missing-seat', 'c-forum-corrupt-seat']) {
    const entry = byId.get(collabId);
    assert.equal(entry.sessions.localSeatCount, 0, `${collabId}：本机席位不可用＝本机段为空`);
    assert.deepEqual(entry.sessions.remoteSeats.map((seat) => seat.instanceId), ['inst-a', 'inst-b'],
      `${collabId}：本机实例的成员事件保留在远端段`);
    assert.equal(entry.sessions.activeSeatCount, 2, `${collabId}：活跃＝两段可见行`);
    assert.equal(entry.memberCount, 2, `${collabId}：讨论人数与活跃同源`);
    assert.equal(entry.sessions.activeSeatCount, entry.sessions.localSeatCount + entry.sessions.remoteSeats.length,
      `${collabId}：UI 三数自洽`);
  }
  assert.equal(byId.get('c-forum-corrupt-seat').sessions.corruptSeatCount, 1, '损坏仍告警计数');
});

test('sessions：legacy 讨论事件轨不套用新形态判据（不读旧 members.jsonl、不计坏行）', (t) => {
  const dataDir = makeTempDir(t);
  writeFiles(collabDirIn(dataDir, 'main', 'c-legacy-forum'), {
    [MEMBER_FILE_NAME]: JSON.stringify(memberRecord({ collabId: 'c-legacy-forum', mode: 'forum', topic: '旧讨论' })),
    [POSTS_FILE_NAME]: jsonl(postEntry()),
    [MEMBERS_FILE_NAME]: jsonl({ eventId: 'ev-old', kind: 'join', instanceId: 'inst-b', identityName: '乙机', ts: '不是时间' }),
  }, { legacy: true });
  const meta = createData(dataDir).readMeta('main', 'c-legacy-forum', null);
  assert.equal(meta.mode, 'forum');
  assert.equal(meta.state, 'completed');
  assert.deepEqual(meta.events.rows, []);
  assert.equal(meta.skipped, 0, '旧事件不得被新校验器计成坏行');
  assert.equal(meta.sessions.legacy, true);
});

test('sessions：本机席位来源可注入 listLocalSeats（运行时席位接口，优先于席位文件）；provider 异常回退文件并留痕', (t) => {
  const dataDir = makeTempDir(t);
  writeSessionFixture(dataDir, 'c-1');
  const calls = [];
  const injected = createViewerData({
    dataDir,
    log: { warn() {} },
    listLocalSeats: (collabId) => {
      calls.push(collabId);
      return [{ sessionId: LOCAL_MEMBER_SESSION, role: 'member', state: 'member', joinSeq: 9, muted: true, unverified: true }];
    },
  });
  assert.deepEqual(injected.listCollabs().collabs[0].sessions.localSeats, [
    { identityName: '甲机', sessionId: '99998888', role: 'member', state: 'member', joinSeq: 9, muted: true, unverified: true },
  ]);
  assert.deepEqual(calls, ['c-1'], 'provider 以 collabId 调用');

  const warnings = [];
  const fallback = createViewerData({
    dataDir,
    log: { warn: (...args) => warnings.push(args) },
    listLocalSeats: () => { throw new Error('席位表不可读'); },
  });
  assert.deepEqual(fallback.listCollabs().collabs[0].sessions.localSeats, [
    { identityName: '甲机', sessionId: '11112222', role: 'manager', state: 'member', joinSeq: 1, muted: false },
  ]);
  assert.equal(warnings.some((entry) => String(entry[0]).includes('本机席位')), true);
});

test('sessions：席位文件逐条校验——坏 JSON／非法角色／文件名与标识不符一律跳过，不影响其余席位', (t) => {
  const dataDir = makeTempDir(t);
  writeSessionFixture(dataDir, 'c-1', {
    [`${SEATS_DIR_NAME}/${LOCAL_MEMBER_SESSION}.json`]: JSON.stringify(seatRecord({
      sessionId: LOCAL_MEMBER_SESSION,
      role: 'member',
      joinSeq: 2,
    })),
    [`${SEATS_DIR_NAME}/2222333344445555.json`]: '{不是 JSON',
    [`${SEATS_DIR_NAME}/3333444455556666.json`]: JSON.stringify(seatRecord({ sessionId: '3333444455556666', role: 'emperor' })),
    [`${SEATS_DIR_NAME}/不是标识.json`]: JSON.stringify(seatRecord()),
    [`${SEATS_DIR_NAME}/4444555566667777.json`]: JSON.stringify(seatRecord({ sessionId: '8888999900001111' })),   // 文件键与内容不符
  });
  assert.deepEqual(createData(dataDir).listCollabs().collabs[0].sessions.localSeats, [
    { identityName: '甲机', sessionId: '11112222', role: 'manager', state: 'member', joinSeq: 1, muted: false },
    { identityName: '甲机', sessionId: '99998888', role: 'member', state: 'member', joinSeq: 2, muted: false },
  ]);
});

/* 席位形态一致性夹具：一张合法 member 席、一张合法 joining 席，以及版本/会话标识/序号/时刻
 * 四类缺陷席。cases 同时喂运行时判据与观察窗。 */
function seatShapeFixtures() {
  const missingSession = seatRecord();
  delete missingSession.sessionId;
  const files = {
    [`${SEATS_DIR_NAME}/3000000000000001.json`]: seatRecord({ sessionId: '3000000000000001' }),
    [`${SEATS_DIR_NAME}/3000000000000002.json`]: seatRecord({ sessionId: '3000000000000002', version: 2 }),
    [`${SEATS_DIR_NAME}/3000000000000003.json`]: seatRecord({ sessionId: '3000000000000003', joinSeq: undefined }),
    [`${SEATS_DIR_NAME}/3000000000000004.json`]: seatRecord({ sessionId: '3000000000000004', joinedAt: undefined }),
    [`${SEATS_DIR_NAME}/5000000000000005.json`]: { version: 1, sessionId: '5000000000000005', role: 'member', state: 'joining' },
    [`${SEATS_DIR_NAME}/3000000000000006.json`]: missingSession,
  };
  return {
    files,
    cases: [
      ['3000000000000001', true],
      ['3000000000000002', false],
      ['3000000000000003', false],
      ['3000000000000004', false],
      ['5000000000000005', true],
      ['3000000000000006', false],
    ],
  };
}

test('sessions：席位文件形态与运行时 isSeatShape 一致——版本精确、会话标识必填、member 序号/时刻必填', (t) => {
  const dataDir = makeTempDir(t);
  writeConfigAt(dataDir, '甲机');
  const { files, cases } = seatShapeFixtures();
  writeFiles(collabDirIn(dataDir, 'main', 'c-1'), {
    [CARRIER_FILE_NAME]: JSON.stringify(carrierRecord({ collabId: 'c-1' })),
    [LEDGER_FILE_NAME]: jsonl(sessionLedgerOf({ collabId: 'c-1' })),
    ...Object.fromEntries(Object.entries(files).map(([name, record]) => [name, JSON.stringify(record)])),
  });
  for (const [sessionId, expected] of cases) {
    assert.equal(isSeatShape(files[`${SEATS_DIR_NAME}/${sessionId}.json`]), expected, `运行时判据：${sessionId}`);
  }
  const entry = createData(dataDir).listCollabs().collabs[0];
  assert.deepEqual(entry.sessions.localSeats.map((seat) => seat.sessionId), ['30000000', '50000000']);
  assert.equal(entry.sessions.corruptSeatCount, 4, '观察窗与运行时同一判据：四项被拒');
  assert.equal(entry.sessions.localSeatCount, 2);
});

test('sessions：旧协作（member.json，无 carrier 标记）＝legacy 只读；旧名单作远端成员、无本机席位时本机旧站长行保留在远端段', (t) => {
  const dataDir = makeTempDir(t);
  writeFiles(collabDirIn(dataDir, 'main', 'c-1'), {
    [MEMBER_FILE_NAME]: JSON.stringify(memberRecord({ collabId: 'c-1' })),
    [LEDGER_FILE_NAME]: jsonl(legacyLedgerOf({ collabId: 'c-1' })),
  }, { legacy: true });
  const data = createData(dataDir);
  const expected = {
    localSeats: [],
    remoteSeats: [
      { instanceId: 'inst-b', identityName: '乙机', role: 'member', state: 'member' },
      { instanceId: 'mgr-1', identityName: '甲机', role: 'manager', state: 'member' },
    ],
    departed: [],
    pendingInvites: [],
    pendingJoins: [],
    activeSeatCount: 2,
    localSeatCount: 0,
    mutedSeatCount: 0,
    legacy: true,
    readOnly: true,
  };
  assert.deepEqual(data.listCollabs().collabs[0].sessions, expected);
  const meta = data.readMeta('main', 'c-1', null);
  assert.deepEqual(meta.sessions, expected);
  assert.equal('freezeReason' in meta.sessions, false, '冻结原因缺省即省略');
  assert.equal(meta.name, '协作甲', '旧协作摘要名取 legacy 读取器');
  assert.equal(meta.state, 'completed', '旧协作按 completed 只读展示');
  assert.equal(meta.skipped, 0, '旧台账行不得被新形态校验计成坏行');
});

test('sessions：migration.json legacy 标记与 recovery.json 半写目录均按只读呈现', (t) => {
  const dataDir = makeTempDir(t);
  writeFiles(collabDirIn(dataDir, 'main', 'c-mig'), {
    [MEMBER_FILE_NAME]: JSON.stringify(memberRecord({ collabId: 'c-mig' })),
    [LEDGER_FILE_NAME]: jsonl(legacyLedgerOf({ collabId: 'c-mig' })),
    [MIGRATION_FILE_NAME]: JSON.stringify({ legacy: true, archivedAt: T0, reason: '旧形态迁移' }),
  }, { legacy: true });
  writeFiles(collabDirIn(dataDir, 'main', 'c-half'), {
    [CARRIER_FILE_NAME]: JSON.stringify(carrierRecord({ collabId: 'c-half' })),
    [RECOVERY_FILE_NAME]: JSON.stringify({ state: 'half-created', at: T0, reason: '台账未落盘' }),
  });
  const byId = new Map(createData(dataDir).listCollabs().collabs.map((entry) => [entry.id, entry]));
  assert.equal(byId.get('c-mig').sessions.legacy, true);
  assert.equal(byId.get('c-mig').sessions.readOnly, true);
  assert.equal(byId.get('c-mig').sessions.recovery, undefined);
  assert.equal(byId.get('c-mig').state, 'completed');
  assert.equal(byId.get('c-half').sessions.recovery, true);
  assert.equal(byId.get('c-half').sessions.readOnly, true);
  assert.equal(byId.get('c-half').sessions.legacy, undefined);
});

test('sessions：仅台账在手也产席位段（远端成员）；完全空目录不产段；台账损坏按无源降级', (t) => {
  const dataDir = makeTempDir(t);
  writeFiles(collabDirIn(dataDir, 'main', 'c-ledger'), { [LEDGER_FILE_NAME]: jsonl(ledgerOf({ collabId: 'c-ledger' })) });
  writeFiles(collabDirIn(dataDir, 'main', 'c-broken'), {
    [LEDGER_FILE_NAME]: jsonl(ledgerOf({ collabId: 'c-broken' })),
    [JOINS_FILE_NAME]: '{不是 JSON',
  });
  mkdirSync(collabDirIn(dataDir, 'main', 'c-empty'), { recursive: true });
  const byId = new Map(createData(dataDir).listCollabs().collabs.map((entry) => [entry.id, entry]));
  assert.equal(byId.get('c-ledger').sessions.remoteSeats.length, 2);
  assert.equal(byId.get('c-ledger').sessions.legacy, undefined);
  assert.equal(byId.get('c-broken').sessions.remoteSeats.length, 2);
  assert.equal('sessions' in byId.get('c-empty'), false);
});

/* —— 只读白名单（静态自证） —— */

test('只读白名单：data.js 的 import 只含白名单符号（防未来漂移）', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/viewer/data.js', import.meta.url)), 'utf8');
  /* 白名单（设计 §6.2/§10）：store.js 只许 loadMember；model/members/posts 只许判据与折叠纯函数；
   * protocol.js/paths.js 常量与判据函数；util/short-id.js 短码唯一权威；node: 内置只取读取面；
   * 两个查看器共享模块只读引用。known-hosts.json 的名字在 data.js 就地定义（该模块 import 面含写
   * 能力 createKnownHosts），夹具以 KNOWN_HOSTS_FILE_NAME 规范常量建立兜底漂移。 */
  const expected = new Map([
    ['node:fs', ['readFileSync', 'readdirSync', 'statSync']],
    ['node:path', ['join']],
    ['../paths.js', ['COLLABS_DIR_NAME', 'CONFIG_FILE_NAME', 'SEATS_DIR_NAME', 'SITES_DIR_NAME', 'carrierFilePath', 'collabDir', 'collabFilePath', 'departedFilePath', 'invitesFilePath', 'joinsFilePath', 'pendingInvitesFilePath']],
    ['../net/protocol.js', ['ID_PATTERN', 'MAX_MESSAGE_TEXT_CHARS', 'POST_KINDS', 'isIdentityName']],
    ['../collab/posts.js', ['isPostEntryShape']],
    ['../collab/members.js', ['isMemberEventShape']],
    ['../collab/model.js', ['isLedgerShape', 'isTimestamp']],
    ['../collab/store.js', ['loadMember']],
    ['../collab/legacy.js', ['readLegacyCollab']],
    ['../collab/carrier.js', ['CARRIER_FORMATS']],
    ['../collab/migration.js', ['loadRecovery']],
    ['../util/short-id.js', ['shortSessionId']],
    ['./text.js', ['displayText']],
    ['./meta.js', ['metaViewOf']],
  ]);
  const actual = new Map();
  const importPattern = /import\s*\{([^}]+)\}\s*from\s*'([^']+)';/g;
  for (const matched of source.matchAll(importPattern)) {
    actual.set(matched[2], matched[1].split(',').map((symbol) => symbol.trim()).filter((symbol) => symbol !== '').sort());
  }
  const importCount = [...source.matchAll(/^import\s/gm)].length;
  assert.equal(actual.size, importCount, '所有 import 行都必须属白名单形态（含多行 import）');
  assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort());
  for (const [module, symbols] of actual) {
    assert.deepEqual(symbols, [...expected.get(module)].sort(), `模块 ${module} 引入了白名单之外的符号`);
  }
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '');   // 注释剔除后再查动态引用（JSDoc 的 import() 类型注解不算）
  assert.equal(/import\s*\(/.test(code), false, '不得有动态 import');
  assert.equal(/require\s*\(/.test(code), false, '不得有 require');
});

test('只读白名单：就地文件名常量与模块权威一致（instance-id 与席位文件版本）', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/viewer/data.js', import.meta.url)), 'utf8');
  assert.equal(source.includes(`const INSTANCE_ID_FILE_NAME = '${INSTANCE_ID_FILE}';`), true);
  assert.equal(source.includes(`const SEAT_FILE_VERSION = ${SEAT_FILE_VERSION};`), true);
});

test('只读白名单：数据面文件清单精确覆盖（carrier/seats/邀请/离席/发现/状态/台账/恢复/旧形态），bindings 已移除', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/viewer/data.js', import.meta.url)), 'utf8');
  const matched = /const READ_FILE_NAMES = Object\.freeze\(\[([\s\S]*?)\]\);/.exec(source);
  assert.notEqual(matched, null, 'data.js 必须声明 READ_FILE_NAMES 白名单');
  const names = [...matched[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
  assert.deepEqual(names, [
    'config.json',
    'instance-id',
    'posts.jsonl',
    'members.jsonl',
    'inbox.jsonl',
    'outbox.jsonl',
    'counter.json',
    'ledger.jsonl',
    'snapshot.json',
    'carrier.json',
    'seats',
    'invites.json',
    'pending-invites.json',
    'joins.json',
    'departed.jsonl',
    'known-hosts.json',
    'recovery.json',
    'member.json',
    'migration.json',
  ]);
  assert.equal(source.includes('bindings'), false, '绑定表已退役，不得留在读取面');
});
