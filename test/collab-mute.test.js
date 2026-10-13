import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { collabFilePath } from '../src/paths.js';
import { makeTempDir, waitFor } from './helpers.js';
import { createCollabService } from '../src/collab/service.js';
import { createInbound } from '../src/net/inbound.js';
import { createMuteStore, isMuteShape, MUTE_FILE_NAME } from '../src/collab/mute.js';
import { createInjectedStore, isInjectedRecordShape, INJECTED_FILE_NAME } from '../src/collab/injected.js';

/* 静音开关与注入标记（讨论模式 §5.7）的用例面：store 与栅栏判定（服务直调）、取消摘要与
 * 跨重启持久、清理挂点（退出 / 归档）、真管线（接收管线 → 服务钩子 → 假会话注入）的抑制与
 * 吸收路径前件（标记为真才回报终态；join 通道不受影响）。 */

const DAY = 24 * 60 * 60 * 1000;

const SELF_A = { instanceId: 'inst-a', identityName: '主机甲', port: 17321 };
const SELF_B = { instanceId: 'inst-b', identityName: '主机乙', port: 17322 };

function makeLog() {
  const logs = [];
  return {
    logs,
    log: {
      info: () => {},
      warn: (message, fields) => logs.push({ message, fields }),
      error: (message, fields) => logs.push({ message, fields }),
    },
  };
}

/* 服务夹具（静音面）：真临时目录 + 假发送（记账）+ 假提示面（摘要捕获）+ 告警捕获；
 * overrides.dir 传既有目录即「重建服务」（跨重启持久用例）。 */
function makeService(t, overrides = {}) {
  const dir = overrides.dir ?? makeTempDir(t);
  const sent = [];
  const notices = [];
  const { logs, log } = makeLog();
  const self = { instanceId: 'inst-self', identityName: '本机', port: 17321 };
  const service = createCollabService({
    dataDir: dir,
    config: { inviteTtlMs: DAY },
    self,
    send: (message) => { sent.push(message); return { ok: true, msgId: `q-${sent.length}` }; },
    sendDirect: () => ({ ok: true, msgId: 'd-1' }),
    notify: (frame) => { notices.push(frame); },
    knownHosts: { remember: () => {} },
    log,
    ledgerFetchTimeoutMs: 30,
    inviteMinIntervalMs: 0,
    pullReplyTimeoutMs: 60,
    syncPeerPicker: () => [],
    joinReplayIntervalsMs: [10, 20, 40],
  });
  return { service, sent, notices, logs, dir, self };
}

/* 接收管线级夹具（真接收管线 + 真服务消费 + 假会话注入面 + 假连接）：四钩子与生产组合根同形。 */
function makePipedService(t, overrides = {}) {
  const made = makeService(t, overrides);
  const session = [];
  const reports = [];
  const inbound = createInbound({
    dataDir: made.dir,
    config: { messageTtlMs: 600000 },
    self: made.self,
    dispatch: {
      resolvePong: () => false,
      onAck: () => {},
      onDeliveryReport: () => {},
      send: (message) => { reports.push(message); return { ok: true }; },
    },
    hooks: {
      admit: (frame, meta) => made.service.hooks.admit(frame, meta),
      consume: (frame, meta) => made.service.hooks.consume(frame, meta),
      sessionGate: (frame) => made.service.hooks.sessionGate(frame),
      sessionDelivered: (frame) => made.service.hooks.sessionDelivered(frame),
      deliverToSession: (frame) => { session.push(frame); return true; },
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  return { ...made, inbound, session, reports };
}

function fakeConnection(remoteAddress = '127.0.0.1') {
  const sent = [];
  return {
    remoteAddress,
    sent,
    send(frame) { sent.push(frame); },
  };
}

let seq = 0;

function peer(instanceId, identityName, port = 17321) {
  return { instanceId, identityName, port };
}

function targetOf(member) {
  return { instanceId: member.instanceId, identityName: member.identityName, address: '127.0.0.2', port: member.port };
}

function collabFrame(type, collabId, from, payload) {
  seq++;
  return { v: 1, type, msgId: `msg-${type}-${seq}`, from: { instanceId: from.instanceId, identityName: from.identityName, port: from.port }, collabId, ts: new Date().toISOString(), payload };
}

function inviteFrame({ collabId, name = '联调项目', mode = 'forum' } = {}) {
  seq++;
  const roster = [SELF_A, { instanceId: 'inst-self', identityName: '本机', port: 17321 }];
  return {
    v: 1,
    type: 'invite',
    msgId: `msg-inv-${seq}`,
    from: { instanceId: SELF_A.instanceId, identityName: SELF_A.identityName, port: SELF_A.port },
    collabId: collabId ?? `collab-${seq}`,
    ts: new Date().toISOString(),
    payload: { name, topic: '发布联调', mode, members: roster.map((entry) => ({ instanceId: entry.instanceId, identityName: entry.identityName })) },
  };
}

function postFrameOf(collabId, from, { postId, postSeq = 1, kind = 'reply', text }) {
  return collabFrame('post', collabId, from, { post: { postId, seq: postSeq, kind, text } });
}

function joinFrameOf(collabId, from) {
  return collabFrame('join', collabId, from, { eventId: randomUUID(), ts: new Date().toISOString() });
}

function freezeFrameOf(from, name, members) {
  return collabFrame('freeze', 'collab-freeze-1', from, { name, members: members.map((entry) => ({ instanceId: entry.instanceId, identityName: entry.identityName })) });
}

async function receive(service, frame, remoteAddress = '127.0.0.1') {
  const admitted = await service.hooks.admit(frame, { remoteAddress });
  if (admitted?.ok === true) {
    await service.hooks.consume(frame, { remoteAddress });
  }
  return admitted;
}

function mutePath(dir, collabId) {
  return collabFilePath(dir, collabId, MUTE_FILE_NAME);
}

function injectedPath(dir, collabId) {
  return collabFilePath(dir, collabId, INJECTED_FILE_NAME);
}

function suppressedOf(service, frame) {
  return service.hooks.sessionGate(frame).suppress === true;
}

function sessionPosts(made) {
  return made.session.filter((frame) => frame.type === 'post');
}

function reportFor(made, msgId) {
  return made.reports.some((message) => message.payload?.refMsgId === msgId);
}

/* 成员侧讨论（经邀请 + 同意）：默认名 联调项目、邀请者 主机甲。 */
async function makeMemberForum(made, { collabId, name = '联调项目' } = {}) {
  await receive(made.service, inviteFrame({ collabId, name, mode: 'forum' }));
  await made.service.approve({ collabId, approve: true });
  return collabId;
}

/* 管理席位侧协作（managed）：本机发起、单目标。 */
function makeManaged(made, { name = '协作甲', target = SELF_B } = {}) {
  return made.service.create({ name, topic: '主题', targets: [targetOf(target)] }).collabId;
}

/* 管理席位侧讨论：本机发起（讨论创建跳过同名冲突检查）、成员 join。 */
async function makeManagerForum(made, { name = '联调项目', member = SELF_B } = {}) {
  const collabId = made.service.create({ name, topic: '议题', mode: 'forum', targets: [targetOf(member)] }).collabId;
  const joined = joinFrameOf(collabId, peer(member.instanceId, member.identityName, member.port));
  await receive(made.service, joined);
  return { collabId, joined };
}

test('静音开关：默认不静音、设静音落盘形态、重建服务后仍静音、校验面明确报错', async (t) => {
  const made = makeService(t);
  const collabId = await makeMemberForum(made, { collabId: 'collab-mute-persist' });
  assert.equal(suppressedOf(made.service, { type: 'post', collabId }), false, '默认不静音');
  assert.deepEqual(made.service.setMute({ collabId, muted: true }), { ok: true, collabId, muted: true });
  assert.deepEqual(JSON.parse(readFileSync(mutePath(made.dir, collabId), 'utf8')), { v: 1, muted: true, baseline: 0 }, '落盘形态：v/muted/baseline');
  const reloaded = makeService(t, { dir: made.dir });
  assert.equal(suppressedOf(reloaded.service, { type: 'post', collabId }), true, '重建服务后仍静音（跨重启持久）');
  const unknown = made.service.setMute({ collabId: 'no-such', muted: true });
  assert.equal(unknown.ok, false);
  assert.ok(unknown.message.includes('collabId 不存在'), unknown.message);
  const badType = made.service.setMute({ collabId, muted: 'yes' });
  assert.equal(badType.ok, false);
  assert.ok(badType.message.includes('布尔'), badType.message);
});

test('静音栅栏判定：讨论帖与协作六类内容抑制；结束 / 邀请 / 快照 / 治理等待办照常', async (t) => {
  const made = makeService(t);
  const forumId = await makeMemberForum(made, { collabId: 'collab-gate-forum' });
  const managedId = makeManaged(made, { name: '协作甲' });
  made.service.setMute({ collabId: forumId, muted: true });
  made.service.setMute({ collabId: managedId, muted: true });
  assert.equal(suppressedOf(made.service, { type: 'post', collabId: forumId }), true, '讨论实时帖：静音期不注入');
  assert.equal(suppressedOf(made.service, { type: 'end', collabId: forumId }), false, '结束（终态）：照常');
  assert.equal(suppressedOf(made.service, { type: 'join', collabId: forumId }), false, 'join：照常');
  assert.equal(suppressedOf(made.service, { type: 'notice', collabId: forumId }), false, '通知类：照常');
  assert.equal(suppressedOf(made.service, { type: 'snapshot', collabId: forumId }), false, '快照类：照常');
  assert.equal(suppressedOf(made.service, { type: 'invite', collabId: 'collab-invite-x' }), false, '邀请（同意门）：照常');
  for (const kind of ['topic', 'task', 'progress', 'issue', 'stop', 'reply']) {
    assert.equal(suppressedOf(made.service, { type: kind, collabId: managedId }), true, `${kind}：静音期不注入`);
  }
  assert.equal(suppressedOf(made.service, { type: 'notice', collabId: managedId }), false, '协作通知类：照常');
  /* 协作侧治理等待办（freeze / unfreeze / decision 命中本机 managed）：帧有处置意义，照常注入。 */
  const from = peer(SELF_B.instanceId, SELF_B.identityName, SELF_B.port);
  for (const type of ['freeze', 'unfreeze', 'decision']) {
    const frame = { ...freezeFrameOf(from, '协作甲', [SELF_B]), type };
    assert.equal(suppressedOf(made.service, frame), false, `协作侧 ${type}（本机有处置面）：照常`);
  }
  made.service.setMute({ collabId: forumId, muted: false });
  assert.equal(suppressedOf(made.service, { type: 'post', collabId: forumId }), false, '取消后即时恢复判定');
});

test('被忽略治理帧：命中静音讨论抑制；未静音照常；同名 managed 命中时照常（待办价值优先）', async (t) => {
  const made = makeService(t);
  /* 先建 managed（同名冲突检查只施于 managed），后建讨论（讨论创建跳过检查）。 */
  makeManaged(made, { name: '联调项目' });
  const forumId = await makeMemberForum(made, { collabId: 'collab-freeze-forum', name: '联调项目' });
  const from = peer(SELF_A.instanceId, SELF_A.identityName, SELF_A.port);
  const forumHit = freezeFrameOf(from, '联调项目', [SELF_A]);      // 只在讨论名单内（成员侧 roster = 发起人 + 本机）
  const managedHit = freezeFrameOf(from, '联调项目', [SELF_B]);    // 只在 managed 名册内
  assert.equal(suppressedOf(made.service, forumHit), false, '未静音：讨论忽略面照常注入');
  made.service.setMute({ collabId: forumId, muted: true });
  assert.equal(suppressedOf(made.service, forumHit), true, '命中静音讨论的忽略帧：静音期不注入');
  assert.equal(suppressedOf(made.service, managedHit), false, '同名 managed 命中：本机有处置面，照常注入');
});

test('取消静音的错过内容摘要：N=静音期新增（讨论=帖 / 协作=内容消息）；重复设静音不重置基线；重复取消不发摘要', async (t) => {
  const made = makeService(t);
  const fromA = peer(SELF_A.instanceId, SELF_A.identityName, SELF_A.port);
  const forumId = await makeMemberForum(made, { collabId: 'collab-summary-forum' });
  await receive(made.service, postFrameOf(forumId, fromA, { postId: 'post-a1', postSeq: 1, text: '静音前甲' }));
  await receive(made.service, postFrameOf(forumId, fromA, { postId: 'post-a2', postSeq: 2, text: '静音前乙' }));
  made.service.setMute({ collabId: forumId, muted: true });
  await receive(made.service, postFrameOf(forumId, fromA, { postId: 'post-a3', postSeq: 3, text: '静音期帖' }));
  assert.equal((await made.service.view({ collabId: forumId })).posts.length, 3, '静音期帖照常落盘（只做减法）');
  made.service.setMute({ collabId: forumId, muted: false });
  const notice = made.notices.at(-1);
  assert.equal(notice.type, 'notice');
  assert.equal(notice.payload.event, 'local-alert');
  assert.equal(notice.collabId, forumId);
  assert.equal(notice.payload.text, '静音期间本讨论新增 1 条——静音期与回填内容不进注入，经查看器/ws_view_ledger 补看');
  const noticeCount = made.notices.length;
  made.service.setMute({ collabId: forumId, muted: false });
  assert.equal(made.notices.length, noticeCount, '未静音时再取消：不发无意义摘要');
  /* 重复设静音不重置基线：两次「设静音」之间与之后到达的帖都并入同一窗口。 */
  made.service.setMute({ collabId: forumId, muted: true });
  await receive(made.service, postFrameOf(forumId, fromA, { postId: 'post-a4', postSeq: 4, text: '窗口一' }));
  made.service.setMute({ collabId: forumId, muted: true });
  await receive(made.service, postFrameOf(forumId, fromA, { postId: 'post-a5', postSeq: 5, text: '窗口二' }));
  made.service.setMute({ collabId: forumId, muted: false });
  assert.equal(made.notices.at(-1).payload.text, '静音期间本讨论新增 2 条——静音期与回填内容不进注入，经查看器/ws_view_ledger 补看');
  /* 协作侧：N = 内容消息计数增量；文案直达收件箱工具。 */
  const managedId = makeManaged(made, { name: '协作乙' });
  const fromB = peer(SELF_B.instanceId, SELF_B.identityName, SELF_B.port);
  made.service.setMute({ collabId: managedId, muted: true });
  await receive(made.service, collabFrame('progress', managedId, fromB, { text: '静音期进度一' }));
  await receive(made.service, collabFrame('progress', managedId, fromB, { text: '静音期进度二' }));
  made.service.setMute({ collabId: managedId, muted: false });
  assert.equal(made.notices.at(-1).payload.text, '静音期间本协作新增 2 条——经 ws_check_inbox 补看');
});

test('基线缺失与坏文件：baseline null 的旧形态摘要降级不带 N；坏文件按默认不静音并留痕', async (t) => {
  const made = makeService(t);
  const collabId = await makeMemberForum(made, { collabId: 'collab-summary-degrade' });
  const file = mutePath(made.dir, collabId);
  writeFileSync(file, JSON.stringify({ v: 1, muted: true, baseline: null }));
  const reloaded = makeService(t, { dir: made.dir });
  assert.equal(suppressedOf(reloaded.service, { type: 'post', collabId }), true, '基线缺失不影响静音本身');
  reloaded.service.setMute({ collabId, muted: false });
  assert.equal(reloaded.notices.at(-1).payload.text, '静音期间本讨论可能有新内容——静音期与回填内容不进注入，经查看器/ws_view_ledger 补看', '基线缺失：摘要降级为不带 N');
  writeFileSync(file, '{ 坏文件');
  const reloaded2 = makeService(t, { dir: made.dir });
  assert.equal(suppressedOf(reloaded2.service, { type: 'post', collabId }), false, '坏文件按默认（不静音）继续');
  assert.ok(reloaded2.logs.some((entry) => entry.message.includes('静音状态文件不可用')), '坏文件必须留痕（告警）');
});

test('静音期首帧帖：不注入不记真；重复副本不回报终态；取消后仍不进注入；新帖即时恢复注入', async (t) => {
  const made = makePipedService(t);
  const { collabId } = await makeManagerForum(made);
  made.service.setMute({ collabId, muted: true });
  const connection = fakeConnection();
  const from = peer(SELF_B.instanceId, SELF_B.identityName, SELF_B.port);
  const first = postFrameOf(collabId, from, { postId: 'post-m1', seq: 1, text: '静音期首帧' });
  made.inbound.onFrame(connection, first);
  await waitFor(() => made.service.stats().postsIn === 1);
  assert.equal(sessionPosts(made).length, 0, '静音期帖不进注入');
  assert.equal(made.inbound.stats().sessionGated, 1, '静音栅栏计数留痕');
  assert.equal(reportFor(made, first.msgId), false, '被抑制帧不发终态回报（发送侧维持第二档）');
  assert.equal(existsSync(injectedPath(made.dir, collabId)), false, '静音期首帧不记真');
  assert.equal((await made.service.view({ collabId })).posts.length, 1, '静音期帖照常落盘');
  const copy = { ...first, msgId: `${first.msgId}-copy` };
  made.inbound.onFrame(connection, copy);
  await waitFor(() => made.service.stats().postsDuplicated === 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(sessionPosts(made).length, 0, '重复副本不注入');
  assert.equal(reportFor(made, copy.msgId), false, '前件为假（未注入过）：不回报终态');
  made.service.setMute({ collabId, muted: false });
  assert.equal(made.notices.at(-1).payload.text, '静音期间本讨论新增 1 条——静音期与回填内容不进注入，经查看器/ws_view_ledger 补看');
  const again = { ...first, msgId: `${first.msgId}-again` };
  made.inbound.onFrame(connection, again);
  await waitFor(() => made.service.stats().postsDuplicated === 2);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(sessionPosts(made).length, 0, '静音期首帧取消后仍不进注入（去重吸收）——边角行为留证');
  const later = postFrameOf(collabId, from, { postId: 'post-m2', seq: 2, text: '恢复后新帖' });
  made.inbound.onFrame(connection, later);
  await waitFor(() => sessionPosts(made).length === 1, { timeoutMs: 2000 });
  assert.equal(reportFor(made, later.msgId), true, '恢复注入：回报终态');
});

test('已注入标记：正常注入记真（跨重启保留）；重复副本回报终态以标记为前件；join 重复副本不受静音影响', async (t) => {
  const made = makePipedService(t);
  const { collabId, joined } = await makeManagerForum(made);
  const connection = fakeConnection();
  const from = peer(SELF_B.instanceId, SELF_B.identityName, SELF_B.port);
  const first = postFrameOf(collabId, from, { postId: 'post-n1', seq: 1, text: '正常帖' });
  made.inbound.onFrame(connection, first);
  await waitFor(() => sessionPosts(made).length === 1);
  assert.equal(reportFor(made, first.msgId), true, '注入成功回报终态（现状回归）');
  const records = readFileSync(injectedPath(made.dir, collabId), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(records, [{ authorId: SELF_B.instanceId, postId: 'post-n1' }], '注入成功记真');
  const copy = { ...first, msgId: `${first.msgId}-copy` };
  made.inbound.onFrame(connection, copy);
  await waitFor(() => made.service.stats().postsDuplicated === 1);
  await waitFor(() => (reportFor(made, copy.msgId) ? true : null));
  assert.equal(sessionPosts(made).length, 1, '重复副本不二次注入');
  /* 跨重启：标记持久——重启后的重复副本仍回报终态。 */
  const reloaded = makePipedService(t, { dir: made.dir });
  const connection2 = fakeConnection();
  const copy2 = { ...first, msgId: `${first.msgId}-copy2` };
  reloaded.inbound.onFrame(connection2, copy2);
  await waitFor(() => reloaded.service.stats().postsDuplicated === 1);
  await waitFor(() => (reportFor(reloaded, copy2.msgId) ? true : null));
  assert.equal(sessionPosts(reloaded).length, 0, '重启后不注入');
  /* join 重复副本：不注入但照常回报终态；静音不改变该通道（isolated 于帖通道前件之外）。 */
  reloaded.service.setMute({ collabId, muted: true });
  const joinCopy = { ...joined, msgId: `${joined.msgId}-copy` };
  reloaded.inbound.onFrame(connection2, joinCopy);
  await waitFor(() => reloaded.service.stats().forumJoinDuplicates === 1);
  await waitFor(() => (reportFor(reloaded, joinCopy.msgId) ? true : null));
});

test('清理挂点：成员退出（讨论）与管理结束 / 整条撤回（协作）清理静音状态', async (t) => {
  const made = makeService(t);
  const forumId = await makeMemberForum(made, { collabId: 'collab-clear-leave' });
  made.service.setMute({ collabId: forumId, muted: true });
  assert.equal(existsSync(mutePath(made.dir, forumId)), true);
  assert.equal(made.service.leave({ collabId: forumId }).ok, true);
  assert.equal(existsSync(mutePath(made.dir, forumId)), false, '退出清理静音文件');
  assert.equal(suppressedOf(makeService(t, { dir: made.dir }).service, { type: 'post', collabId: forumId }), false, '重入从默认（不静音）开始');
  const managedEnd = makeManaged(made, { name: '协作结束' });
  await receive(made.service, collabFrame('approve', managedEnd, peer(SELF_B.instanceId, SELF_B.identityName, SELF_B.port), {}));
  made.service.setMute({ collabId: managedEnd, muted: true });
  assert.equal(existsSync(mutePath(made.dir, managedEnd)), true);
  assert.equal(made.service.end({ collabId: managedEnd }).ok, true);
  assert.equal(existsSync(mutePath(made.dir, managedEnd)), false, '结束清理静音文件');
  const managedWithdraw = makeManaged(made, { name: '协作撤回' });
  made.service.setMute({ collabId: managedWithdraw, muted: true });
  assert.equal(existsSync(mutePath(made.dir, managedWithdraw)), true);
  assert.equal(made.service.withdraw({ collabId: managedWithdraw }).ok, true);
  assert.equal(existsSync(mutePath(made.dir, managedWithdraw)), false, '整条撤回清理静音文件');
});

test('静音期结束帧照常注入；成员侧归档（handleEnd）同时清理静音状态', async (t) => {
  const made = makePipedService(t);
  const collabId = await makeMemberForum(made, { collabId: 'collab-end-inject' });
  made.service.setMute({ collabId, muted: true });
  const connection = fakeConnection();
  const endFrame = collabFrame('end', collabId, peer(SELF_A.instanceId, SELF_A.identityName, SELF_A.port), {});
  made.inbound.onFrame(connection, endFrame);
  await waitFor(() => (made.session.some((frame) => frame.type === 'end') ? true : null));
  assert.equal(made.inbound.stats().sessionGated, 0, '结束帧不落入抑制集（只做减法）');
  assert.equal(existsSync(mutePath(made.dir, collabId)), false, '归档清理静音状态');
  assert.equal(suppressedOf(makeService(t, { dir: made.dir }).service, { type: 'post', collabId }), false, '归档后重建服务：不静音');
});

/* —— store 级补测（与 members / counter 同族口径：形态单测、坏载、读写失败面） —— */

test('静音 store 形态与坏载：逐字段拒、形态不符 / 读取失败归默认并留痕、不静音载入清基线', (t) => {
  assert.equal(isMuteShape({ v: 1, muted: true, baseline: 0 }), true);
  assert.equal(isMuteShape({ v: 1, muted: false, baseline: null }), true);
  assert.equal(isMuteShape(null), false);
  assert.equal(isMuteShape('状态'), false);
  assert.equal(isMuteShape([1]), false);
  assert.equal(isMuteShape({ v: 2, muted: true, baseline: 0 }), false);
  assert.equal(isMuteShape({ v: 1, muted: 'yes', baseline: 0 }), false);
  assert.equal(isMuteShape({ v: 1, muted: true, baseline: -1 }), false);
  assert.equal(isMuteShape({ v: 1, muted: true, baseline: 1.5 }), false);
  const dir = makeTempDir(t);
  mkdirSync(dirname(mutePath(dir, 'collab-shape')), { recursive: true });
  writeFileSync(mutePath(dir, 'collab-shape'), JSON.stringify({ v: 2, muted: true, baseline: 3 }));
  const { logs, log } = makeLog();
  const bad = createMuteStore({ dataDir: dir, collabId: 'collab-shape', log });
  assert.equal(bad.isMuted(), false, '形态不符按默认不静音');
  assert.equal(bad.stats().corruptLoads, 1);
  assert.ok(logs.some((entry) => entry.message.includes('静音状态文件不可用') && entry.fields.reason === '形态不符'), '形态不符必须留痕');
  writeFileSync(mutePath(dir, 'collab-shape'), JSON.stringify({ v: 1, muted: false, baseline: 9 }));
  const off = createMuteStore({ dataDir: dir, collabId: 'collab-shape', log: makeLog().log });
  assert.deepEqual([off.isMuted(), off.stats().baseline], [false, null], '不静音载入即清基线');
  const dir2 = makeTempDir(t);
  mkdirSync(mutePath(dir2, 'collab-dir'), { recursive: true });
  const { logs: logs2, log: log2 } = makeLog();
  const dirStore = createMuteStore({ dataDir: dir2, collabId: 'collab-dir', log: log2 });
  assert.equal(dirStore.isMuted(), false);
  assert.equal(dirStore.stats().corruptLoads, 1, '读取非 ENOENT 并入损坏面');
  assert.ok(logs2.some((entry) => entry.message.includes('静音状态文件不可用')), '读取失败必须留痕');
});

test('静音 store 失败面与基线语义：写 / 删失败内存态继续、基线补记与取消清空', (t) => {
  const dir = makeTempDir(t);
  mkdirSync(mutePath(dir, 'collab-rm'), { recursive: true });
  const { logs, log } = makeLog();
  const rmStore = createMuteStore({ dataDir: dir, collabId: 'collab-rm', log });
  rmStore.clear();
  assert.equal(rmStore.stats().persistFailures, 1, '删除失败只计数（内存态已复位）');
  assert.ok(logs.some((entry) => entry.message.includes('静音状态清理失败')));
  const dir2 = makeTempDir(t);
  writeFileSync(join(dir2, 'collabs'), '占位：协作目录无法创建');
  const { logs: logs2, log: log2 } = makeLog();
  const failStore = createMuteStore({ dataDir: dir2, collabId: 'collab-fail', log: log2 });
  const before = failStore.setMuted(true, 0);
  assert.deepEqual([before.wasMuted, failStore.isMuted()], [false, true], '写盘失败内存态继续');
  assert.deepEqual([failStore.stats().persists, failStore.stats().persistFailures], [0, 1]);
  assert.ok(logs2.some((entry) => entry.message.includes('静音状态写入失败')));
  const store = createMuteStore({ dataDir: makeTempDir(t), collabId: 'collab-baseline', log: makeLog().log });
  store.setMuted(true);
  assert.equal(store.stats().baseline, null, '计数缺失：基线降级');
  store.setMuted(true, 7);
  assert.equal(store.stats().baseline, 7, '基线缺失时再设静音补记当前值');
  store.setMuted(false, 9);
  assert.deepEqual([store.isMuted(), store.stats().baseline], [false, null], '取消清基线');
  store.clear();
  assert.equal(store.stats().clears, 1, '清理成功计数（文件本已不在也算成功）');
});

test('注入标记 store 形态与坏载：逐字段拒、坏行跳过、半写尾行截断、残缺留痕', (t) => {
  assert.equal(isInjectedRecordShape({ authorId: 'inst-a', postId: 'post-1' }), true);
  assert.equal(isInjectedRecordShape(null), false);
  assert.equal(isInjectedRecordShape([{ authorId: 'inst-a', postId: 'post-1' }]), false);
  assert.equal(isInjectedRecordShape({ postId: 'post-1' }), false);
  assert.equal(isInjectedRecordShape({ authorId: 'inst-a', postId: 'bad id!' }), false);
  const dir = makeTempDir(t);
  const seeded = createInjectedStore({ dataDir: dir, collabId: 'collab-load', log: makeLog().log });
  assert.equal(seeded.mark('inst-a', 'post-1'), true, '记真即落盘');
  appendFileSync(injectedPath(dir, 'collab-load'), '{"坏行"\n');
  appendFileSync(injectedPath(dir, 'collab-load'), `${JSON.stringify({ authorId: 'inst-a' })}\n`);
  const { logs, log } = makeLog();
  const loaded = createInjectedStore({ dataDir: dir, collabId: 'collab-load', log });
  assert.equal(loaded.size(), 1, '不可解析行与形态不符行不入集');
  assert.equal(loaded.stats().corruptRecords, 1, '形态不符行计数');
  assert.ok(logs.some((entry) => entry.message.includes('注入标记有残缺记录') && entry.fields.tailDropped === false), '中间坏行留痕');
  appendFileSync(injectedPath(dir, 'collab-load'), '{"authorId":"inst-b",');
  const { logs: logs2, log: log2 } = makeLog();
  const reloaded = createInjectedStore({ dataDir: dir, collabId: 'collab-load', log: log2 });
  assert.equal(reloaded.size(), 1, '半写尾行截断丢弃');
  assert.ok(logs2.some((entry) => entry.message.includes('注入标记有残缺记录') && entry.fields.tailDropped === true), '半写尾行留痕');
});

test('注入标记 store 失败面与幂等：读 / 写失败内存态继续、mark 拒绝与重复记真', (t) => {
  const dir = makeTempDir(t);
  mkdirSync(injectedPath(dir, 'collab-err'), { recursive: true });
  const { logs, log } = makeLog();
  const errStore = createInjectedStore({ dataDir: dir, collabId: 'collab-err', log });
  assert.equal(errStore.size(), 0, '读取失败按空集继续');
  assert.equal(errStore.stats().persistFailures, 1);
  assert.ok(logs.some((entry) => entry.message.includes('注入标记读取失败')));
  assert.equal(errStore.mark('bad id!', 'post-2'), false);
  assert.equal(errStore.stats().corruptRecords, 1);
  assert.ok(logs.some((entry) => entry.message.includes('注入标记形态不符')), '形态不符拒绝入集并留痕');
  const empty = createInjectedStore({ dataDir: makeTempDir(t), collabId: 'collab-empty', log: makeLog().log });
  assert.equal(empty.size(), 0, '无文件即空集');
  const dir2 = makeTempDir(t);
  writeFileSync(join(dir2, 'collabs'), '占位：协作目录无法创建');
  const { logs: logs2, log: log2 } = makeLog();
  const failStore = createInjectedStore({ dataDir: dir2, collabId: 'collab-fail', log: log2 });
  assert.equal(failStore.mark('inst-d', 'post-4'), true);
  assert.equal(failStore.has('inst-d', 'post-4'), true, '写盘失败内存态继续');
  assert.equal(failStore.stats().persistFailures, 1);
  assert.ok(logs2.some((entry) => entry.message.includes('注入标记写入失败')));
  assert.equal(failStore.mark('inst-d', 'post-4'), false, '同帖重复记真幂等');
  assert.equal(failStore.size(), 1);
});
