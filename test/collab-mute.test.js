import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { collabFilePath, seatFilePath } from '../src/paths.js';
import { makeTempDir, waitFor } from './helpers.js';
import { createCollabService } from '../src/collab/service.js';
import { createInbound } from '../src/net/inbound.js';
import { createMuteStore, isMuteShape, MUTE_FILE_NAME } from '../src/collab/mute.js';
import { createInjectedStore, isInjectedRecordShape, INJECTED_FILE_NAME } from '../src/collab/injected.js';

/* 静音开关与注入标记的用例面（设计 §5.4）：席位级静音（本机会话逐席位判定）、取消摘要与跨重启
 * 持久、清理挂点（退出 / 结束 / 撤回）、真管线（接收管线 → 服务钩子 → 本机席位注入）的抑制与
 * 吸收路径前件。席位一律经真实链路建立：本机创建/加入（核内旁路）、邀请同意后接线、远端两段式
 * 入席；不直接构造席位文件绕过入席行为。 */

const DAY = 24 * 60 * 60 * 1000;
const SELF_A = { instanceId: 'inst-a', identityName: '主机甲', port: 17321, sessionId: 'sess-peer-a' };
const SELF_B = { instanceId: 'inst-b', identityName: '主机乙', port: 17322, sessionId: 'sess-peer-b' };
const SELF_INSTANCE = { instanceId: 'inst-self', identityName: '本机', port: 17321 };
const MANAGER_SESSION = 'sess-manager-a';
const MEMBER_SESSION = 'sess-member-b';
const FORUM_SUMMARY_TAIL = '静音期与回填内容不进注入，经查看器/ws_view_ledger 补看';
const MANAGED_SUMMARY_TAIL = '经 ws_check_inbox 补看';

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

/* 服务夹具：真临时目录 + 真席位表 + 假发送（记账）+ 假桥投递（记录逐席注入）+ 告警捕获。
 * bindings 与桥注册是组合根接线面，夹具按生产同形注入（论坛加入的「接线落地」判据依赖它们）。 */
function makeService(t, overrides = {}) {
  const dir = overrides.dir ?? makeTempDir(t);
  const made = {
    dir,
    sent: [],
    direct: [],
    notices: [],
    deliveries: [],
    bindings: new Map(),
    self: SELF_INSTANCE,
    ...makeLog(),
  };
  made.service = createCollabService(serviceOptionsOf(made, overrides));
  for (const sessionId of [MANAGER_SESSION, MEMBER_SESSION]) {
    made.service.registerBridgeEntry(sessionId, `bridge-${sessionId}`);
  }
  return made;
}

function serviceOptionsOf(made, overrides) {
  return {
    dataDir: made.dir,
    config: {
      inviteTtlMs: DAY,
      joinRequestTtlMs: DAY,
      joinConfirmTtlMs: DAY,
      messageTtlMs: 600000,
      ...(overrides.config ?? {}),
    },
    self: made.self,
    send: (message) => {
      made.sent.push(message);
      return { ok: true, msgId: `q-${made.sent.length}` };
    },
    sendDirect: (message) => {
      made.direct.push(message);
      return { ok: true, msgId: `d-${made.direct.length}` };
    },
    notify: (frame) => {
      made.notices.push(frame);
      return true;
    },
    deliverSeat: (frame, seat) => {
      made.deliveries.push({ sessionId: seat.sessionId, type: frame.type, msgId: frame.msgId, frame });
      return true;
    },
    knownHosts: { remember: () => {}, lookup: () => undefined },
    bindings: bindingsFacadeOf(made),
    bridgeIdOf: (sessionId) => `bridge-${sessionId}`,
    log: made.log,
    ledgerFetchTimeoutMs: 30,
    inviteMinIntervalMs: 0,
    pullReplyTimeoutMs: 60,
    syncPeerPicker: () => [],
    joinReplayIntervalsMs: [10, 20, 40],
  };
}

function bindingsFacadeOf(made) {
  return {
    set: (collabId, entry) => made.bindings.set(collabId, entry),
    get: (collabId) => made.bindings.get(collabId),
    entries: () => [...made.bindings.entries()],
  };
}

/* 接收管线级夹具：真接收管线 + 真服务消费 + 逐席位注入面（listSeats/injectSeat 与生产组合根
 * 同形；两个钩子都注入才启用席位扇出路径）。 */
function makePipedService(t, overrides = {}) {
  const made = makeService(t, overrides);
  made.reports = [];
  made.inbound = createInbound({
    dataDir: made.dir,
    config: { messageTtlMs: 600000 },
    self: made.self,
    dispatch: {
      resolvePong: () => false,
      onAck: () => {},
      onDeliveryReport: () => {},
      send: (message) => {
        made.reports.push(message);
        return { ok: true };
      },
    },
    hooks: {
      admit: (frame, meta) => made.service.hooks.admit(frame, meta),
      consume: (frame, meta) => made.service.hooks.consume(frame, meta),
      sessionGate: (frame, meta) => made.service.hooks.sessionGate(frame, meta),
      sessionDelivered: (frame) => made.service.hooks.sessionDelivered(frame),
      listSeats: (collabId) => made.service.listInjectableTargets(collabId),
      injectSeat: (collabId, sessionId, frame) => made.service.injectLocalSeat(collabId, sessionId, frame),
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  return made;
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

function localPeerOf(sessionId) {
  return { ...SELF_INSTANCE, sessionId };
}

function targetOf(peer) {
  return { instanceId: peer.instanceId, identityName: peer.identityName, address: '127.0.0.2', port: peer.port };
}

function collabFrame(type, collabId, from, payload, toSessions = null) {
  seq++;
  return {
    v: 1,
    cap: 2,
    type,
    msgId: `msg-${type}-${seq}`,
    from: { instanceId: from.instanceId, identityName: from.identityName, port: from.port, sessionId: from.sessionId },
    collabId,
    ts: new Date().toISOString(),
    payload,
    ...(toSessions === null ? {} : { toSessions }),
  };
}

/* 讨论邀请：不指名（名单含邀请者与本机会话）、无 inviteId（讨论无邀请簿记）。 */
function inviteFrame({ collabId, name = '联调项目', inviter = SELF_A } = {}) {
  seq++;
  const roster = [inviter, { ...SELF_INSTANCE, sessionId: MEMBER_SESSION }];
  return {
    v: 1,
    cap: 2,
    type: 'invite',
    msgId: `msg-inv-${seq}`,
    from: { instanceId: inviter.instanceId, identityName: inviter.identityName, port: inviter.port, sessionId: inviter.sessionId },
    collabId: collabId ?? `collab-${seq}`,
    ts: new Date().toISOString(),
    payload: {
      name,
      topic: '发布联调',
      mode: 'forum',
      members: roster.map((entry) => ({ instanceId: entry.instanceId, sessionId: entry.sessionId, identityName: entry.identityName })),
    },
  };
}

function postFrameOf(collabId, from, { postId, postSeq = 1, kind = 'reply', text }, toSessions = null) {
  return collabFrame('post', collabId, from, { post: { postId, seq: postSeq, kind, text } }, toSessions);
}

function joinFrameOf(collabId, from, eventId = randomUUID()) {
  return collabFrame('join', collabId, from, { eventId, ts: new Date().toISOString() });
}

function endFrameOf(collabId, from) {
  return collabFrame('end', collabId, from, {});
}

function freezeFrameOf(collabId, from, name, members) {
  return collabFrame('freeze', collabId, from, {
    name,
    members: members.map((entry) => ({ instanceId: entry.instanceId, sessionId: entry.sessionId, identityName: entry.identityName })),
  });
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

function seatPath(dir, collabId, sessionId) {
  return seatFilePath(dir, collabId, sessionId);
}

function seatOf(service, collabId, sessionId) {
  return service.listLocalSeats(collabId).find((seat) => seat.sessionId === sessionId) ?? null;
}

function suppressedOf(service, frame, sessionId) {
  return service.hooks.sessionGate(frame, { sessionId }).suppress === true;
}

function deliveriesOf(made, sessionId, type = null) {
  return made.deliveries.filter((entry) => entry.sessionId === sessionId && (type === null || entry.type === type));
}

function postDeliveriesOf(made, sessionId) {
  return deliveriesOf(made, sessionId, 'post');
}

function reportFor(made, msgId) {
  return made.reports.some((message) => message.payload?.refMsgId === msgId);
}

function resumeNoticeTextOf(made) {
  const notice = made.notices.filter((entry) => entry.payload?.event === 'local-alert').at(-1);
  return notice?.payload?.text ?? '';
}

function setMuteOf(made, collabId, sessionId, muted) {
  const result = made.service.setMute({ collabId, sessionId, muted });
  assert.equal(result.ok, true, result.message);
  return result;
}

async function unmuteAll(made, collabId) {
  setMuteOf(made, collabId, MANAGER_SESSION, false);
  setMuteOf(made, collabId, MEMBER_SESSION, false);
}

/* 本机讨论（两席）：远端发起人先邀请本机会话甲、同意；再指名邀请会话乙、同意。
 * 讨论成员粒度＝会话——每次同意由该会话自己发 join 事件并落本会话席位（新席位默认不静音）。 */
function namedForumInviteOf({ collabId, name, targetSessionId }) {
  const frame = inviteFrame({ collabId, name });
  frame.payload.targets = [{ instanceId: SELF_INSTANCE.instanceId, targetSessionId }];
  return frame;
}

async function makeForum(made, { name = '联调项目' } = {}) {
  const collabId = `collab-mute-forum-${++seq}`;
  for (const sessionId of [MANAGER_SESSION, MEMBER_SESSION]) {
    const admitted = await receive(made.service, namedForumInviteOf({ collabId, name, targetSessionId: sessionId }));
    assert.equal(admitted?.ok, true, admitted?.reason);
    await approveWithConsent(made.service, { collabId, sessionId });
  }
  return collabId;
}

/* 本机协作：站长会话创建，另一本机会话经两段式（申请 → 批准）入席。 */
function createManaged(made, { name = '协作甲', target = SELF_B } = {}) {
  const created = made.service.create({ name, topic: '主题', mode: 'managed', sessionId: MANAGER_SESSION, targets: [targetOf(target)] });
  assert.equal(created.ok, true, created.message);
  return created.collabId;
}

async function makeManaged(made, { name = '协作甲' } = {}) {
  const collabId = createManaged(made, { name });
  const asked = await made.service.join.request({ collabId, sessionId: MEMBER_SESSION });
  assert.equal(asked.ok, true, asked.message);
  const approved = await made.service.join.approve({ collabId, sessionId: MEMBER_SESSION, managerSessionId: MANAGER_SESSION, approve: true });
  assert.equal(approved.ok, true, approved.message);
  return collabId;
}

/* 成员侧讨论：接收邀请 → 用户确认门 → 同意（发出 join 成员事件）→ 本会话接线（落本机席位）。 */
async function makeMemberForum(made, { collabId, name = '联调项目', inviter = SELF_A } = {}) {
  const admitted = await receive(made.service, inviteFrame({ collabId, name, inviter }));
  assert.equal(admitted?.ok, true, admitted?.reason);
  await approveWithConsent(made.service, { collabId, sessionId: MEMBER_SESSION });
  const joined = await made.service.join.request({ collabId, sessionId: MEMBER_SESSION });
  assert.equal(joined.ok, true, joined.message);
  return collabId;
}

/* 同意门是产品行为（首次挑战、携令牌重试），夹具按真实两步走，不豁免确认。 */
async function approveWithConsent(service, { collabId, sessionId }) {
  const first = await service.approve({ collabId, approve: true, sessionId });
  const result = first?.needsUserConfirmation === true
    ? await service.approve({ collabId, approve: true, sessionId, confirmToken: first.confirmToken })
    : first;
  assert.equal(result.ok, true, result.message);
  return result;
}

/* 远端成员两段式入席：join-request → 站长批准（直投 join-grant）→ join-confirm 回执。 */
async function joinRemoteMember(made, collabId, connection) {
  const from = { instanceId: SELF_B.instanceId, identityName: SELF_B.identityName, port: SELF_B.port, sessionId: SELF_B.sessionId };
  made.inbound.onFrame(connection, {
    v: 1, cap: 2, type: 'join-request', msgId: `join-req-${++seq}`, from, collabId, ts: new Date().toISOString(),
    payload: { sessionId: SELF_B.sessionId },
  });
  await waitFor(() => (made.service.join.pendingJoinsOf(collabId).length === 1 ? true : null));
  const approved = await made.service.join.approve({ collabId, sessionId: SELF_B.sessionId, managerSessionId: MANAGER_SESSION, approve: true });
  assert.equal(approved.ok, true, approved.message);
  const grant = made.direct.find((message) => message.type === 'join-grant' && message.payload?.sessionId === SELF_B.sessionId);
  assert.ok(grant !== undefined, '批准必须签发 join-grant');
  made.inbound.onFrame(connection, {
    v: 1, cap: 2, type: 'join-confirm', msgId: `join-cfm-${++seq}`, from, collabId, ts: new Date().toISOString(),
    payload: { joinId: grant.payload.joinId, managerTerm: grant.payload.managerTerm, version: grant.payload.version },
  });
  await waitFor(async () => {
    const viewed = await made.service.view({ collabId });
    return viewed.ledger?.members.some((row) => row.sessionId === SELF_B.sessionId) === true ? true : null;
  });
}

async function sendForumPost(made, collabId, text) {
  const sent = await made.service.send({ collabId, sessionId: MANAGER_SESSION, text });
  assert.equal(sent.ok, true, sent.message);
}

test('静音开关：新席位默认不静音、显式设静音后抑制、席位落盘形态、重建服务后仍静音、校验面明确报错', async (t) => {
  const made = makeService(t);
  const collabId = await makeForum(made, { name: '联调项目' });
  assert.equal(seatOf(made.service, collabId, MANAGER_SESSION).muted, false, '发起席位默认不静音');
  assert.equal(seatOf(made.service, collabId, MEMBER_SESSION).muted, false, '同机加入席位默认不静音');
  assert.equal(suppressedOf(made.service, { type: 'post', collabId }, MEMBER_SESSION), false, '默认不静音：内容照常注入');
  assert.deepEqual(made.service.setMute({ collabId, sessionId: MEMBER_SESSION, muted: true }), { ok: true, collabId, muted: true });
  assert.equal(suppressedOf(made.service, { type: 'post', collabId }, MEMBER_SESSION), true, '显式静音后内容不注入');
  assert.equal(seatOf(made.service, collabId, MEMBER_SESSION).muted, true, '切换后本席即时反映');
  assert.equal(made.service.list({ sessionId: MEMBER_SESSION }).collabs[0].muted, true, '清单行聚合随席位切换');
  const seatRecord = JSON.parse(readFileSync(seatPath(made.dir, collabId, MEMBER_SESSION), 'utf8'));
  assert.equal(seatRecord.sessionId, MEMBER_SESSION);
  assert.equal(seatRecord.muted, true, '静音态落在本机席位文件（设计 §6.1）');
  const reloaded = makeService(t, { dir: made.dir });
  assert.equal(seatOf(reloaded.service, collabId, MEMBER_SESSION).muted, true, '重建服务后席位静音仍在');
  assert.equal(suppressedOf(reloaded.service, { type: 'post', collabId }, MEMBER_SESSION), true, '重建后按席位继续抑制');
  assert.equal(suppressedOf(reloaded.service, { type: 'post', collabId }, MANAGER_SESSION), false, '同机另一席不受影响');
  const unknown = made.service.setMute({ collabId: 'no-such', sessionId: MEMBER_SESSION, muted: true });
  assert.equal(unknown.ok, false);
  assert.ok(unknown.message.includes('collabId 不存在'), unknown.message);
  const badType = made.service.setMute({ collabId, sessionId: MEMBER_SESSION, muted: 'yes' });
  assert.equal(badType.ok, false);
  assert.ok(badType.message.includes('布尔'), badType.message);
  const noSeat = made.service.setMute({ collabId, sessionId: 'sess-ghost', muted: true });
  assert.equal(noSeat.ok, false);
  assert.ok(noSeat.message.includes('没有席位'), noSeat.message);
});

test('论坛受邀同意：默认不静音落到本会话席位（席位文件是唯一权威，不写退役 mute.json）', async (t) => {
  const made = makeService(t);
  const collabId = 'collab-forum-approve-seat';
  const admitted = await receive(made.service, inviteFrame({ collabId }));
  assert.equal(admitted?.ok, true, admitted?.reason);
  await approveWithConsent(made.service, { collabId, sessionId: MEMBER_SESSION });
  const seat = seatOf(made.service, collabId, MEMBER_SESSION);
  assert.ok(seat !== null, '论坛同意即建本会话席位');
  assert.equal(seat.muted, false, '默认不静音落席位（listLocalSeats 可见）');
  const record = JSON.parse(readFileSync(seatPath(made.dir, collabId, MEMBER_SESSION), 'utf8'));
  assert.equal(record.muted, false, '席位文件 muted=false（默认不静音落盘）');
  assert.equal(existsSync(mutePath(made.dir, collabId)), false, '不再写退役 mute.json');
  assert.equal(suppressedOf(made.service, { type: 'post', collabId }, MEMBER_SESSION), false, '同意后内容照常注入');
});

test('静音兜底不抑治理帧：同名讨论静音时，未知 collabId 的治理帧仍放行（设计 §5.4）', async (t) => {
  const made = makeService(t);
  const forumId = await makeForum(made, { name: '联调项目' });
  setMuteOf(made, forumId, MEMBER_SESSION, true);
  /* 旧兜底按名称 + 成员交集匹配到同名讨论，会把这帧误判为「被忽略治理帧」而抑制；
   * 治理帧应始终放行（静音只做内容类减法）。 */
  const foreignGovernance = freezeFrameOf('collab-unknown-governance', SELF_A, '联调项目', [SELF_INSTANCE]);
  assert.equal(suppressedOf(made.service, foreignGovernance, MEMBER_SESSION), false, '未知协作的治理帧不得被同名讨论的静音兜底抑制');
  assert.equal(suppressedOf(made.service, { ...foreignGovernance, type: 'end' }, MEMBER_SESSION), false, '结束帧同样放行');
  assert.equal(suppressedOf(made.service, { type: 'invite', collabId: 'collab-unknown-invite' }, MEMBER_SESSION), false, '邀请帧不受静音抑制');
});

test('静音栅栏判定：内容类按收件席位抑制；结束 / 邀请 / 快照 / 治理等待办照常', async (t) => {
  const made = makeService(t);
  const forumId = await makeForum(made, { name: '联调项目' });
  const managedId = await makeManaged(made, { name: '协作甲' });
  await unmuteAll(made, forumId);
  await unmuteAll(made, managedId);
  setMuteOf(made, forumId, MEMBER_SESSION, true);
  setMuteOf(made, managedId, MEMBER_SESSION, true);
  assert.equal(suppressedOf(made.service, { type: 'post', collabId: forumId }, MEMBER_SESSION), true, '讨论实时帖：静音席不注入');
  assert.equal(suppressedOf(made.service, { type: 'post', collabId: forumId }, MANAGER_SESSION), false, '同机另一席照常（逐席位判定）');
  assert.equal(suppressedOf(made.service, { type: 'end', collabId: forumId }, MEMBER_SESSION), false, '结束（终态）：照常');
  assert.equal(suppressedOf(made.service, { type: 'join', collabId: forumId }, MEMBER_SESSION), false, 'join：照常');
  assert.equal(suppressedOf(made.service, { type: 'notice', collabId: forumId }, MEMBER_SESSION), false, '通知类：照常');
  assert.equal(suppressedOf(made.service, { type: 'snapshot', collabId: forumId }, MEMBER_SESSION), false, '快照类：照常');
  assert.equal(suppressedOf(made.service, { type: 'invite', collabId: 'collab-invite-x' }, MEMBER_SESSION), false, '邀请（同意门）：照常');
  for (const kind of ['topic', 'task', 'progress', 'issue', 'stop', 'reply']) {
    assert.equal(suppressedOf(made.service, { type: kind, collabId: managedId }, MEMBER_SESSION), true, `${kind}：静音席不注入`);
  }
  assert.equal(suppressedOf(made.service, { type: 'notice', collabId: managedId }, MEMBER_SESSION), false, '协作通知类：照常');
  for (const type of ['freeze', 'unfreeze', 'decision']) {
    const frame = { ...freezeFrameOf(managedId, SELF_B, '协作甲', [SELF_B]), type };
    assert.equal(suppressedOf(made.service, frame, MEMBER_SESSION), false, `治理等待办 ${type}：照常`);
  }
  setMuteOf(made, forumId, MEMBER_SESSION, false);
  assert.equal(suppressedOf(made.service, { type: 'post', collabId: forumId }, MEMBER_SESSION), false, '取消后即时恢复判定');
});

test('被忽略治理帧不注入会话：命中讨论即置抑制（未静音也如此）；同名 managed 命中照常注入', async (t) => {
  const made = makePipedService(t);
  const connection = fakeConnection('127.0.0.2');
  const managedId = createManaged(made, { name: '联调项目' });
  await joinRemoteMember(made, managedId, connection);
  const forumId = await makeMemberForum(made, { collabId: 'collab-governance-forum', name: '联调项目' });
  setMuteOf(made, managedId, MANAGER_SESSION, true);
  setMuteOf(made, forumId, MEMBER_SESSION, true);
  const types = ['freeze', 'unfreeze', 'decision'];
  for (const [index, type] of types.entries()) {
    const frame = { ...freezeFrameOf(`collab-foreign-${index}`, SELF_A, '联调项目', [SELF_A]), type };
    made.inbound.onFrame(connection, frame);
    await waitFor(() => (made.service.stats().forumGovernanceIgnored === index + 1 ? true : null));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(connection.sent.some((entry) => entry.type === 'ack' && entry.ackFor === frame.msgId), true, `${type}：受理 + ack（防治理重试钉死）`);
    assert.equal(deliveriesOf(made, MEMBER_SESSION).some((entry) => entry.msgId === frame.msgId), false, `${type}：被忽略帧不注入会话`);
    assert.equal(reportFor(made, frame.msgId), false, `${type}：不发终态回报`);
  }
  const sameCollab = freezeFrameOf(forumId, SELF_A, '联调项目', [SELF_A]);
  assert.equal(suppressedOf(made.service, sameCollab, MEMBER_SESSION), false, '治理帧不受静音抑制；讨论的忽略由消费侧声明');
  const ignoredBefore = made.service.stats().forumGovernanceIgnored;
  const managedHit = freezeFrameOf(managedId, SELF_B, '联调项目', [SELF_B]);
  made.inbound.onFrame(connection, managedHit);
  await waitFor(() => (deliveriesOf(made, MANAGER_SESSION).some((entry) => entry.msgId === managedHit.msgId) ? true : null));
  assert.equal(made.service.stats().forumGovernanceIgnored, ignoredBefore, 'managed 命中不落讨论忽略计数');
  assert.equal(deliveriesOf(made, MANAGER_SESSION).some((entry) => entry.msgId === managedHit.msgId), true, '站长席静音仍注入治理等待办');
});

test('取消静音的错过内容摘要：N=静音期新增（讨论=帖 / 协作=内容消息）；重复设静音不重置基线；重复取消不发摘要', async (t) => {
  const made = makePipedService(t);
  const forumId = await makeForum(made, { name: '联调项目' });
  await unmuteAll(made, forumId);
  made.notices.length = 0;
  await sendForumPost(made, forumId, '静音前甲');
  await sendForumPost(made, forumId, '静音前乙');
  setMuteOf(made, forumId, MEMBER_SESSION, true);
  await sendForumPost(made, forumId, '静音期帖');
  assert.equal((await made.service.view({ collabId: forumId })).posts.length, 3, '静音期帖照常落盘（只做减法）');
  setMuteOf(made, forumId, MEMBER_SESSION, false);
  assert.equal(resumeNoticeTextOf(made), `静音期间本讨论新增 1 条——${FORUM_SUMMARY_TAIL}`);
  const noticeCount = made.notices.length;
  setMuteOf(made, forumId, MEMBER_SESSION, false);
  assert.equal(made.notices.length, noticeCount, '未静音时再取消：不发无意义摘要');
  setMuteOf(made, forumId, MEMBER_SESSION, true);
  await sendForumPost(made, forumId, '窗口一');
  setMuteOf(made, forumId, MEMBER_SESSION, true);
  await sendForumPost(made, forumId, '窗口二');
  setMuteOf(made, forumId, MEMBER_SESSION, false);
  assert.equal(resumeNoticeTextOf(made), `静音期间本讨论新增 2 条——${FORUM_SUMMARY_TAIL}`, '重复设静音不重置基线');
  const managedId = await makeManaged(made, { name: '协作乙' });
  await unmuteAll(made, managedId);
  setMuteOf(made, managedId, MANAGER_SESSION, true);
  const connection = fakeConnection();
  const fromMember = localPeerOf(MEMBER_SESSION);
  made.inbound.onFrame(connection, collabFrame('progress', managedId, fromMember, { text: '静音期进度一' }, [MANAGER_SESSION]));
  made.inbound.onFrame(connection, collabFrame('progress', managedId, fromMember, { text: '静音期进度二' }, [MANAGER_SESSION]));
  await waitFor(() => (made.service.indicators().find((item) => item.collabId === managedId)?.msgCount === 2 ? true : null));
  setMuteOf(made, managedId, MANAGER_SESSION, false);
  assert.equal(resumeNoticeTextOf(made), `静音期间本协作新增 2 条——${MANAGED_SUMMARY_TAIL}`);
});

test('同机两席静音互不影响：一席静音不抑制另一席；摘要基线按席位独立（进程内）', async (t) => {
  const made = makePipedService(t);
  const collabId = await makeManaged(made, { name: '协作甲' });
  await unmuteAll(made, collabId);
  const connection = fakeConnection();
  setMuteOf(made, collabId, MANAGER_SESSION, true);
  made.inbound.onFrame(connection, collabFrame('progress', collabId, localPeerOf(MEMBER_SESSION), { text: '给站长席' }, [MANAGER_SESSION]));
  await waitFor(() => (made.service.indicators().find((item) => item.collabId === collabId)?.msgCount === 1 ? true : null));
  made.inbound.onFrame(connection, collabFrame('progress', collabId, localPeerOf(MANAGER_SESSION), { text: '给成员席' }, [MEMBER_SESSION]));
  await waitFor(() => (deliveriesOf(made, MEMBER_SESSION, 'progress').length === 1 ? true : null));
  assert.equal(deliveriesOf(made, MANAGER_SESSION, 'progress').length, 0, '静音席不注入');
  assert.equal(deliveriesOf(made, MEMBER_SESSION, 'progress')[0].frame.payload.text, '给成员席', '未静音席照常注入');
  /* 两席同时静音后各自按自己的窗口算差值：先取消的一席 N=2（基线 0），后取消的那席
   * 在累计 2 时进入静音、窗口内无新增 → N=0（逐席基线，互不清空）。 */
  setMuteOf(made, collabId, MEMBER_SESSION, true);
  setMuteOf(made, collabId, MANAGER_SESSION, false);
  assert.equal(resumeNoticeTextOf(made), `静音期间本协作新增 2 条——${MANAGED_SUMMARY_TAIL}`);
  setMuteOf(made, collabId, MEMBER_SESSION, false);
  assert.equal(resumeNoticeTextOf(made), `静音期间本协作新增 0 条——${MANAGED_SUMMARY_TAIL}`, '逐席基线：后一席按自己的窗口算 N');
});

test('重启后席位仍静音、摘要降级不带 N；退役 mute.json 留盘不读不写', async (t) => {
  const made = makeService(t);
  const collabId = await makeManaged(made, { name: '协作甲' });
  setMuteOf(made, collabId, MANAGER_SESSION, true);
  /* 退役文件的相反内容不得影响新权威：席位 muted=true 即静音，旧文件的 muted:false 无人读取。 */
  writeFileSync(mutePath(made.dir, collabId), JSON.stringify({ v: 1, muted: false, baseline: 123 }));
  const reloaded = makeService(t, { dir: made.dir });
  assert.equal(seatOf(reloaded.service, collabId, MANAGER_SESSION).muted, true, '重启后静音态来自席位文件');
  assert.equal(suppressedOf(reloaded.service, { type: 'progress', collabId }, MANAGER_SESSION), true, '重启后仍按席位静音（不读旧文件）');
  setMuteOf(reloaded, collabId, MANAGER_SESSION, false);
  assert.equal(resumeNoticeTextOf(reloaded), `静音期间本协作可能有新内容——${MANAGED_SUMMARY_TAIL}`, '基线仅进程内：重启后缺失，摘要降级不带 N');
  assert.deepEqual(JSON.parse(readFileSync(mutePath(made.dir, collabId), 'utf8')), { v: 1, muted: false, baseline: 123 }, '退役文件留盘不删不改');
});

test('静音期首帧帖：不注入不记真；重复副本无注入事实不回报；取消后仍不进注入；新帖即时恢复注入', async (t) => {
  const made = makePipedService(t);
  const collabId = await makeForum(made, { name: '联调项目' });
  await unmuteAll(made, collabId);
  made.deliveries.length = 0;
  const connection = fakeConnection();
  setMuteOf(made, collabId, MEMBER_SESSION, true);
  const first = postFrameOf(collabId, localPeerOf(MANAGER_SESSION), { postId: 'post-m1', text: '静音期首帧' }, [MEMBER_SESSION]);
  made.inbound.onFrame(connection, first);
  await waitFor(() => made.service.stats().postsIn === 1);
  assert.equal(postDeliveriesOf(made, MEMBER_SESSION).length, 0, '静音期帖不进注入');
  assert.equal(made.inbound.stats().fanoutGated, 1, '静音栅栏按收件席位计数留痕');
  assert.equal(reportFor(made, first.msgId), true, '零注入也回报机器级终态（投递保证按机器级）');
  assert.equal(existsSync(injectedPath(made.dir, collabId)), false, '静音期首帧不记真');
  assert.equal((await made.service.view({ collabId })).posts.length, 1, '静音期帖照常落盘');
  const copy = { ...first, msgId: `${first.msgId}-copy` };
  made.inbound.onFrame(connection, copy);
  await waitFor(() => made.service.stats().postsDuplicated === 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(postDeliveriesOf(made, MEMBER_SESSION).length, 0, '重复副本不注入');
  assert.equal(reportFor(made, copy.msgId), false, '前件为假（未注入过）：不回报终态');
  setMuteOf(made, collabId, MEMBER_SESSION, false);
  assert.equal(resumeNoticeTextOf(made), `静音期间本讨论新增 1 条——${FORUM_SUMMARY_TAIL}`);
  made.inbound.onFrame(connection, { ...first, msgId: `${first.msgId}-again` });
  await waitFor(() => made.service.stats().postsDuplicated === 2);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(postDeliveriesOf(made, MEMBER_SESSION).length, 0, '静音期首帧取消后仍不进注入（去重吸收）');
  const later = postFrameOf(collabId, localPeerOf(MANAGER_SESSION), { postId: 'post-m2', postSeq: 2, text: '恢复后新帖' }, [MEMBER_SESSION]);
  made.inbound.onFrame(connection, later);
  await waitFor(() => postDeliveriesOf(made, MEMBER_SESSION).length === 1, { timeoutMs: 2000 });
  assert.equal(reportFor(made, later.msgId), true, '恢复注入：回报终态');
});

test('已注入标记：正常注入记真（跨重启保留）；重复副本回报终态以标记为前件；join 重复副本不受静音影响', async (t) => {
  const made = makePipedService(t);
  const collabId = await makeForum(made, { name: '联调项目' });
  await unmuteAll(made, collabId);
  made.deliveries.length = 0;
  const connection = fakeConnection();
  const first = postFrameOf(collabId, localPeerOf(MANAGER_SESSION), { postId: 'post-n1', text: '正常帖' }, [MEMBER_SESSION]);
  made.inbound.onFrame(connection, first);
  await waitFor(() => postDeliveriesOf(made, MEMBER_SESSION).length === 1);
  assert.equal(reportFor(made, first.msgId), true, '注入成功回报终态');
  const records = readFileSync(injectedPath(made.dir, collabId), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(records, [{ authorId: SELF_INSTANCE.instanceId, postId: 'post-n1' }], '注入成功记真');
  const copy = { ...first, msgId: `${first.msgId}-copy` };
  made.inbound.onFrame(connection, copy);
  await waitFor(() => made.service.stats().postsDuplicated === 1);
  await waitFor(() => (reportFor(made, copy.msgId) ? true : null));
  assert.equal(postDeliveriesOf(made, MEMBER_SESSION).length, 1, '重复副本不二次注入');
  const reloaded = makePipedService(t, { dir: made.dir });
  const connection2 = fakeConnection();
  const copy2 = { ...first, msgId: `${first.msgId}-copy2` };
  reloaded.inbound.onFrame(connection2, copy2);
  await waitFor(() => reloaded.service.stats().postsDuplicated === 1);
  await waitFor(() => (reportFor(reloaded, copy2.msgId) ? true : null));
  assert.equal(postDeliveriesOf(reloaded, MEMBER_SESSION).length, 0, '重启后不注入');
  const memberForumId = await makeMemberForum(made, { collabId: 'collab-join-dup', name: '联调项目二' });
  setMuteOf(made, memberForumId, MEMBER_SESSION, true);
  const joined = joinFrameOf(memberForumId, SELF_A, 'event-join-dup');
  made.inbound.onFrame(connection, joined);
  await waitFor(() => made.service.stats().forumJoinsIn >= 1);
  const joinCopy = { ...joined, msgId: `${joined.msgId}-copy` };
  made.inbound.onFrame(connection, joinCopy);
  await waitFor(() => made.service.stats().forumJoinDuplicates === 1);
  await waitFor(() => (reportFor(made, joinCopy.msgId) ? true : null));
  assert.equal(deliveriesOf(made, MEMBER_SESSION, 'join').filter((entry) => entry.msgId === joinCopy.msgId).length, 0, 'join 重复副本不注入');
});

test('清理挂点：离席删除本席（静音随席位退场）；终态改为归档保留（不删除用户数据）', async (t) => {
  const made = makeService(t);
  const forumId = await makeMemberForum(made, { collabId: 'collab-clear-leave', name: '联调项目' });
  setMuteOf(made, forumId, MEMBER_SESSION, true);
  assert.equal(existsSync(seatPath(made.dir, forumId, MEMBER_SESSION)), true, '前置：本会话席位在盘');
  assert.equal(made.service.leave({ collabId: forumId, sessionId: MEMBER_SESSION }).ok, true);
  assert.equal(seatOf(made.service, forumId, MEMBER_SESSION), null, '离席删除本机席位');
  assert.equal(existsSync(seatPath(made.dir, forumId, MEMBER_SESSION)), false, '离席删除席位文件（静音随席位退场）');
  assert.equal(existsSync(mutePath(made.dir, forumId)), false, '离席不写退役 mute.json');
  assert.equal(suppressedOf(made.service, { type: 'post', collabId: forumId }, MEMBER_SESSION), false, '离席后不静音');
  assert.equal(made.service.setMute({ collabId: forumId, sessionId: MEMBER_SESSION, muted: true }).ok, false, '离席后不能改席位静音');
  const managedEnd = await makeManaged(made, { name: '协作结束' });
  setMuteOf(made, managedEnd, MANAGER_SESSION, true);
  assert.equal(made.service.end({ collabId: managedEnd, sessionId: MANAGER_SESSION }).ok, true);
  const ended = seatOf(made.service, managedEnd, MANAGER_SESSION);
  assert.ok(ended !== null, '结束不删除本机席位（保留历史）');
  assert.equal(ended.archived, true, '结束给本机席位写 archivedAt');
  const endedRecord = JSON.parse(readFileSync(seatPath(made.dir, managedEnd, MANAGER_SESSION), 'utf8'));
  assert.ok(Number.isFinite(Date.parse(endedRecord.archivedAt)), 'archivedAt 已落盘');
  const managedWithdraw = createManaged(made, { name: '协作撤回' });
  setMuteOf(made, managedWithdraw, MANAGER_SESSION, true);
  assert.equal(made.service.withdraw({ collabId: managedWithdraw, sessionId: MANAGER_SESSION }).ok, true);
  const withdrawn = seatOf(made.service, managedWithdraw, MANAGER_SESSION);
  assert.ok(withdrawn !== null, '整条撤回不删除本机席位');
  assert.equal(withdrawn.archived, true, '整条撤回归档本机席位');
  const withdrawnRecord = JSON.parse(readFileSync(seatPath(made.dir, managedWithdraw, MANAGER_SESSION), 'utf8'));
  assert.ok(Number.isFinite(Date.parse(withdrawnRecord.archivedAt)), '撤回 archivedAt 已落盘');
});

test('静音期结束帧照常注入；成员侧归档（handleEnd）保留席位并写 archivedAt，归档后内容由准入拒绝', async (t) => {
  const made = makePipedService(t);
  const collabId = await makeMemberForum(made, { collabId: 'collab-end-inject', name: '联调项目' });
  setMuteOf(made, collabId, MEMBER_SESSION, true);
  made.deliveries.length = 0;
  const connection = fakeConnection('127.0.0.2');
  made.inbound.onFrame(connection, endFrameOf(collabId, SELF_A));
  await waitFor(() => deliveriesOf(made, MEMBER_SESSION, 'end').length === 1);
  assert.equal(made.inbound.stats().sessionGated, 0, '结束帧不落入静音抑制集（只做减法）');
  const archived = seatOf(made.service, collabId, MEMBER_SESSION);
  assert.ok(archived !== null, '归档不删除本机席位');
  assert.equal(archived.archived, true, '成员侧归档写 archivedAt');
  const record = JSON.parse(readFileSync(seatPath(made.dir, collabId, MEMBER_SESSION), 'utf8'));
  assert.ok(Number.isFinite(Date.parse(record.archivedAt)), 'archivedAt 已落盘（重启仍可读）');
  assert.equal(existsSync(mutePath(made.dir, collabId)), false, '不写退役 mute.json');
  const post = postFrameOf(collabId, SELF_A, { postId: 'post-after-end', text: '归档后' });
  const admitted = await made.service.hooks.admit(post, { remoteAddress: '127.0.0.2' });
  assert.equal(admitted.ok, false, '归档后内容由准入拒绝（不依赖残留席位静音）');
  assert.match(admitted.reason, /已结束/);
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
