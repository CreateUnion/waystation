import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collabDir, collabFilePath, sessionFilePath } from '../src/paths.js';
import { makeTempDir } from './helpers.js';
import { createCollabService } from '../src/collab/service.js';
import { COUNTER_FILE_NAME, createCounterStore, isCounterShape } from '../src/collab/counter.js';
import { createSessionStatusWriter, indicatedEntriesOf, isIndicatedCollab } from '../src/session-status.js';
import { listCollabsTool } from '../src/tools/collab.js';

/* 状态栏消息数（观测面）的计数面用例：counter 存储单元面（起算 / 落盘 / 重建 / 坏文件 / 写失败）
 * + 服务受理面（六类内容消息计、治理与控制类不计、跨重启保留）+ 讨论帖列表计数（重复副本不计、
 * 回填计入）+ ws_list_collabs 载荷零变化 + 会话状态文件即时刷新（组合根同形接线）。 */

const DAY = 24 * 60 * 60 * 1000;
const SESSION_ID = 'session-obs-1';
/* 心跳极大值：用例时限内绝不触发——会话状态文件的每次更新只可能来自即时刷新路径。 */
const HEARTBEAT_NEVER_MS = 3600000;

function quietLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function peer(instanceId, identityName, port = 17321) {
  return { instanceId, identityName, port };
}

function target(instanceId) {
  return { instanceId, identityName: `主机${instanceId}`, address: '127.0.0.2', port: 17321 };
}

let seq = 0;

function collabFrame(type, collabId, from, payload) {
  seq++;
  return { v: 1, type, msgId: `msg-${type}-${seq}`, from: { instanceId: from.instanceId, identityName: from.identityName, port: from.port }, collabId, ts: new Date().toISOString(), payload };
}

function postFrame(collabId, from, { postId, seq: postSeq, kind = 'reply', text }) {
  return collabFrame('post', collabId, from, { post: { postId, seq: postSeq, kind, text } });
}

function joinFrameOf(collabId, from) {
  return collabFrame('join', collabId, from, { eventId: randomUUID(), ts: new Date().toISOString() });
}

/* 合法拉取应答（回填两帖）：游标空、无后续分段、成员与端点空表。 */
function bundleFrameOf(collabId, from) {
  const bundledPost = (postId, postSeq, text) => ({ from: { instanceId: from.instanceId, identityName: from.identityName }, postId, seq: postSeq, ts: new Date().toISOString(), kind: 'reply', text });
  return collabFrame('history-bundle', collabId, from, {
    cursor: null,
    more: false,
    posts: [bundledPost('post-b1', 11, '回填一'), bundledPost('post-b2', 12, '回填二')],
    overlap: [],
    meta: {},
    members: [],
    endpoints: {},
  });
}

/* 服务单测脚手架：真临时目录 + 假发送 + 观察面回调计数桩（overrides.service 可换掉回调）。 */
function makeService(t, overrides = {}) {
  const dir = overrides.dir ?? makeTempDir(t);
  let indicatorChanges = 0;
  const service = createCollabService({
    dataDir: dir,
    config: { inviteTtlMs: DAY },
    self: { instanceId: 'inst-self', identityName: '本机', port: 17321 },
    send: () => ({ ok: true, msgId: 'q-1' }),
    sendDirect: () => ({ ok: true, msgId: 'd-1' }),
    knownHosts: { remember: () => {} },
    log: quietLog(),
    inviteMinIntervalMs: 0,
    syncPeerPicker: () => [],
    onIndicatorChange: () => { indicatorChanges++; },
    ...overrides.service,
  });
  return { service, dir, indicatorChanges: () => indicatorChanges };
}

async function receive(service, frame, remoteAddress = '127.0.0.1') {
  const admitted = await service.hooks.admit(frame, { remoteAddress });
  if (admitted?.ok === true) {
    await service.hooks.consume(frame, { remoteAddress });
  }
  return admitted;
}

function counterFilePath(dir, collabId) {
  return collabFilePath(dir, collabId, COUNTER_FILE_NAME);
}

function messageCountOnDisk(dir, collabId) {
  return JSON.parse(readFileSync(counterFilePath(dir, collabId), 'utf8')).messageCount;
}

function indicatorOf(service, collabId) {
  const found = service.indicators().find((entry) => entry.collabId === collabId);
  return found === undefined ? null : found.msgCount;
}

/* 组合根同形接线（index.js 的两条）：真会话状态写入端 + 指示回调即时刷新。 */
function makeObservedStation(t) {
  const dir = makeTempDir(t);
  const holder = { service: null };
  let refreshes = 0;
  const writer = createSessionStatusWriter({
    mainDataDir: dir,
    sessionId: SESSION_ID,
    collect: () => ({
      instanceId: 'inst-self',
      identityName: '本机',
      site: null,
      port: 17321,
      collabs: indicatedEntriesOf(holder.service.list().collabs.filter(isIndicatedCollab), holder.service.indicators()),
    }),
    log: quietLog(),
    heartbeatMs: HEARTBEAT_NEVER_MS,
  });
  const made = makeService(t, { dir, service: { onIndicatorChange: () => { refreshes++; writer.refresh(); } } });
  holder.service = made.service;
  t.after(() => writer.close());
  const readStatus = () => JSON.parse(readFileSync(sessionFilePath(dir, SESSION_ID), 'utf8'));
  return {
    service: made.service,
    writer,
    refreshes: () => refreshes,
    entryOf: (collabId) => readStatus().collabs.find((entry) => entry.collabId === collabId),
  };
}

/* —— 计数存储（单元面） —— */

test('计数存储：不存在从零起算、自增原子落盘、重建保留（跨重启）', (t) => {
  const dir = makeTempDir(t);
  assert.equal(isCounterShape({ v: 1, messageCount: 0 }), true);
  assert.equal(isCounterShape({ v: 1, messageCount: -1 }), false);
  assert.equal(isCounterShape({ v: 2, messageCount: 0 }), false);
  assert.equal(isCounterShape({ messageCount: 0 }), false);
  assert.equal(isCounterShape(null), false);

  const store = createCounterStore({ dataDir: dir, collabId: 'collab-count-1', log: quietLog() });
  assert.equal(store.count(), 0, '文件不存在（首次运行）从零起算');
  store.increment();
  assert.equal(store.count(), 1);
  assert.deepEqual(JSON.parse(readFileSync(counterFilePath(dir, 'collab-count-1'), 'utf8')), { v: 1, messageCount: 1 });
  store.increment();
  assert.equal(messageCountOnDisk(dir, 'collab-count-1'), 2);

  const reopened = createCounterStore({ dataDir: dir, collabId: 'collab-count-1', log: quietLog() });
  assert.equal(reopened.count(), 2, '重建（跨重启）后计数保留');
  reopened.increment();
  assert.equal(messageCountOnDisk(dir, 'collab-count-1'), 3);
});

test('计数存储：坏文件归零并留痕（不崩），形态不符同款', (t) => {
  const dir = makeTempDir(t);
  mkdirSync(collabDir(dir, 'collab-count-2'), { recursive: true });
  const warnings = [];
  const log = { ...quietLog(), warn: (message) => warnings.push(message) };
  writeFileSync(counterFilePath(dir, 'collab-count-2'), '{oops');
  const store = createCounterStore({ dataDir: dir, collabId: 'collab-count-2', log });
  assert.equal(store.count(), 0, '坏文件归零');
  assert.equal(store.stats().corruptLoads, 1);
  assert.equal(warnings.length, 1, '归零必须留痕');
  store.increment();
  assert.equal(store.count(), 1, '归零后可继续累计');

  writeFileSync(counterFilePath(dir, 'collab-count-2'), JSON.stringify({ v: 1, messageCount: -5 }));
  const second = createCounterStore({ dataDir: dir, collabId: 'collab-count-2', log: quietLog() });
  assert.equal(second.count(), 0, '形态不符同样归零');
  assert.equal(second.stats().corruptLoads, 1);
});

test('计数存储：落盘失败只计数告警、内存态继续', (t) => {
  const dir = makeTempDir(t);
  const warnings = [];
  const store = createCounterStore({ dataDir: dir, collabId: 'collab-count-3', log: { ...quietLog(), warn: (message) => warnings.push(message) } });
  writeFileSync(join(dir, 'collabs'), '占位文件：协作目录由此建不出来');
  store.increment();
  assert.equal(store.count(), 1, '写盘失败内存态照常累计');
  assert.equal(store.stats().persistFailures, 1);
  assert.equal(warnings.length, 1);
  assert.equal(store.stats().corruptLoads, 0, '写入失败不污染加载面计数');
});

/* —— 服务受理面 —— */

test('协作计数：六类内容消息各计一次、治理与控制类不计，回调逐条触发', async (t) => {
  const { service, dir, indicatorChanges } = makeService(t);
  const created = service.create({ name: '联调项目', topic: '发布联调', targets: [target('inst-b')] });
  assert.equal(created.ok, true);
  const peerB = peer('inst-b', '主机乙');
  for (const kind of ['topic', 'task', 'progress', 'issue', 'stop', 'reply']) {
    const admitted = await receive(service, collabFrame(kind, created.collabId, peerB, { text: `${kind} 一条` }));
    assert.equal(admitted.ok, true, `${kind} 应被受理`);
  }
  assert.equal(indicatorOf(service, created.collabId), 6);
  assert.equal(messageCountOnDisk(dir, created.collabId), 6, '计数随受理落盘');
  assert.equal(indicatorChanges(), 6, '每条计数变化触发观察面回调');

  const notice = await receive(service, collabFrame('notice', created.collabId, peerB, { event: 'established', version: 2 }));
  assert.equal(notice.ok, true, '治理类照常受理');
  assert.equal(indicatorOf(service, created.collabId), 6, '治理类不计入内容消息数');
  const unknown = await receive(service, collabFrame('reply', 'collab-count-unknown', peerB, { text: '未知协作' }));
  assert.equal(unknown.ok, false, '未知 collabId 被门拒');
  assert.equal(indicatorChanges(), 6, '被拒帧不计不回调');
});

test('协作计数：跨重启保留并继续累计（同一数据目录重建服务）', async (t) => {
  const dir = makeTempDir(t);
  const first = makeService(t, { dir });
  const created = first.service.create({ name: '联调项目', topic: '发布联调', targets: [target('inst-b')] });
  const peerB = peer('inst-b', '主机乙');
  await receive(first.service, collabFrame('reply', created.collabId, peerB, { text: '第一条' }));
  await receive(first.service, collabFrame('reply', created.collabId, peerB, { text: '第二条' }));
  assert.equal(indicatorOf(first.service, created.collabId), 2);

  const second = makeService(t, { dir });
  assert.equal(indicatorOf(second.service, created.collabId), 2, '重启后计数保留');
  await receive(second.service, collabFrame('reply', created.collabId, peerB, { text: '第三条' }));
  assert.equal(indicatorOf(second.service, created.collabId), 3, '重启后继续累计');
});

test('讨论计数：帖列表条目数（重复副本不计）、回填帖同样计入', async (t) => {
  const { service } = makeService(t);
  const created = service.create({ name: '讨论甲', topic: '议题', mode: 'forum', targets: [target('inst-b')] });
  assert.equal(created.ok, true);
  const peerB = peer('inst-b', '主机乙');
  await receive(service, postFrame(created.collabId, peerB, { postId: 'post-1', seq: 1, text: '帖一' }));
  await receive(service, postFrame(created.collabId, peerB, { postId: 'post-2', seq: 2, text: '帖二' }));
  assert.equal(indicatorOf(service, created.collabId), 2);
  await receive(service, postFrame(created.collabId, peerB, { postId: 'post-2', seq: 2, text: '帖二的重复副本' }));
  assert.equal(indicatorOf(service, created.collabId), 2, '同（作者, postId）重复副本不计');

  const admitted = await receive(service, bundleFrameOf(created.collabId, peerB));
  assert.equal(admitted.ok, true, '回填应答被受理');
  assert.equal(indicatorOf(service, created.collabId), 4, '回填帖计入全量副本计数');
});

test('ws_list_collabs 载荷零变化：受理内容消息前后输出逐字节一致、无计数外溢字段', async (t) => {
  const { service } = makeService(t);
  const created = service.create({ name: '联调项目', topic: '发布联调', targets: [target('inst-b')] });
  const before = await listCollabsTool().handler({}, { collab: service });
  await receive(service, collabFrame('reply', created.collabId, peer('inst-b', '主机乙'), { text: '一条' }));
  const after = await listCollabsTool().handler({}, { collab: service });
  assert.equal(after.content[0].text, before.content[0].text, '受理内容消息不改变工具载荷');
  assert.equal(after.content[0].text.includes('msgCount'), false, '计数不经工具面外溢');
  assert.equal(Object.keys(service.list().collabs[0]).includes('msgCount'), false);
  assert.equal(indicatorOf(service, created.collabId), 1, '计数只在独立读法（indicators）里');
});

/* —— 即时刷新（会话状态文件） —— */

test('即时刷新：协作受理一条内容消息后，不等心跳会话状态文件已含新计数', async (t) => {
  const station = makeObservedStation(t);
  const created = station.service.create({ name: '联调项目', topic: '发布联调', targets: [target('inst-b')] });
  station.writer.start();
  assert.equal(station.entryOf(created.collabId).msgCount, 0);
  const peerB = peer('inst-b', '主机乙');
  await receive(station.service, collabFrame('reply', created.collabId, peerB, { text: '一条' }));
  assert.equal(station.entryOf(created.collabId).msgCount, 1, '受理即刷新（心跳未到）');
  await receive(station.service, collabFrame('reply', created.collabId, peerB, { text: '两条' }));
  assert.equal(station.entryOf(created.collabId).msgCount, 2);
  assert.equal(station.refreshes(), 2, '每条计数变化各触发一次刷新');
});

test('即时刷新：讨论的实时帖、回填帖与成员变化都不等心跳', async (t) => {
  const station = makeObservedStation(t);
  const created = station.service.create({ name: '讨论甲', topic: '议题', mode: 'forum', targets: [target('inst-b')] });
  station.writer.start();
  assert.equal(station.entryOf(created.collabId).msgCount, 0);
  assert.equal(station.entryOf(created.collabId).memberCount, 1, '发起人自创建即在成员表内');
  const peerB = peer('inst-b', '主机乙');
  await receive(station.service, postFrame(created.collabId, peerB, { postId: 'post-1', seq: 1, text: '帖一' }));
  assert.equal(station.entryOf(created.collabId).msgCount, 1, '实时帖落盘即刷新');

  const admitted = await receive(station.service, bundleFrameOf(created.collabId, peerB));
  assert.equal(admitted.ok, true);
  assert.equal(station.entryOf(created.collabId).msgCount, 3, '回填帖同样计入并即时刷新');

  await receive(station.service, joinFrameOf(created.collabId, peerB));
  assert.equal(station.entryOf(created.collabId).memberCount, 2, '成员变化同样即时刷新');
});

test('即时刷新：静音开关同样不等心跳——muted 随指示面进入会话状态文件（读取端缺字段按未静音）', (t) => {
  const station = makeObservedStation(t);
  const created = station.service.create({ name: '联调项目', topic: '发布联调', targets: [target('inst-b')] });
  station.writer.start();
  station.service.setMute({ collabId: created.collabId, muted: false });   // 新建即默认静音：显式取「未静音」基线
  assert.equal('muted' in station.entryOf(created.collabId), false, '未静音：字段缺省（加性口径——旧读取端不受扰）');
  const before = station.refreshes();
  station.service.setMute({ collabId: created.collabId, muted: true });
  assert.equal(station.entryOf(created.collabId).muted, true, '设静音即刷新');
  assert.equal(station.refreshes(), before + 1, '静音切换触发一次观察面刷新');
  station.service.setMute({ collabId: created.collabId, muted: false });
  assert.equal('muted' in station.entryOf(created.collabId), false, '取消静音：字段随之缺省');
});
