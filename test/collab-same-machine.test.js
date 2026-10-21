import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { collabFilePath } from '../src/paths.js';
import { createCollabService } from '../src/collab/service.js';
import { MUTE_FILE_NAME } from '../src/collab/mute.js';
import { loadLedger } from '../src/collab/store.js';
import { makeTempDir } from './helpers.js';

/* 同机（单核）两会话各自成席（设计 §4.4「同机走核内旁路」）：两段式状态机、共享名单与本地席位
 * 一律照桌面语义成立，只是帧不经过网络——不因此缩小为「只有站长侧记录」。 */

const SELF = { instanceId: 'inst-self', identityName: '本机' };
const MANAGER_SESSION = 'sess-manager-a';
const MEMBER_SESSION = 'sess-member-b';
const REMOTE_TARGET = { instanceId: 'inst-peer', identityName: '对端', address: '127.0.0.1', port: 17400 };
const TWO_STAGE_TYPES = ['join-request', 'join-grant', 'join-confirm', 'join-deny'];

function quietLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function makeService(t, overrides = {}) {
  const dir = overrides.dir ?? makeTempDir(t);
  const sent = [];
  const deliveries = [];
  const notices = [];
  const service = createCollabService({
    dataDir: dir,
    config: {
      inviteTtlMs: 120000, joinRequestTtlMs: 120000, joinConfirmTtlMs: 60000, pendingInvitesMax: 64,
      ...(overrides.config ?? {}),
    },
    self: SELF,
    send: (message) => {
      sent.push(message);
      return { ok: true, msgId: `msg-${sent.length}` };
    },
    sendDirect: (message) => {
      sent.push(message);
      return { ok: true, msgId: `direct-${sent.length}` };
    },
    knownHosts: { remember: () => {}, lookup: () => undefined },
    notify: (frame) => {
      notices.push(frame);
      return true;
    },
    /* 桥投递记录面：返回 true 表示目标会话在线；本机协议帧（join 家族/快照）走核内接收面，不经此处。 */
    deliverSeat: (frame, seat) => {
      deliveries.push({ sessionId: seat.sessionId, type: frame.type, frame });
      return true;
    },
    log: quietLog(),
    ledgerFetchTimeoutMs: 60,
    inviteMinIntervalMs: 0,
    syncPeerPicker: () => [],
    now: overrides.now,
  });
  return { dir, service, sent, deliveries, notices };
}

function createCollabOf(made, name, mode = 'managed') {
  const created = made.service.create({
    name, topic: `${name} 主题`, sessionId: MANAGER_SESSION, targets: [REMOTE_TARGET], mode,
  });
  assert.equal(created.ok, true, created.message);
  return created.collabId;
}

function mutePathOf(dir, collabId) {
  return collabFilePath(dir, collabId, MUTE_FILE_NAME);
}

function twoStageFramesOf(made) {
  return made.sent.filter((message) => TWO_STAGE_TYPES.includes(message.type));
}

function reload(made, t) {
  return makeService(t, { dir: made.dir });
}

test('同机申请：批准后共享名单与申请侧本地席位同时成立，快照收敛后可发送', async (t) => {
  const made = makeService(t);
  await made.service.registerBridgeEntry(MEMBER_SESSION, `bridge-${MEMBER_SESSION}`);
  const collabId = createCollabOf(made, '同机申请');

  const asked = await made.service.join.request({ collabId, sessionId: MEMBER_SESSION });
  assert.equal(asked.ok, true, asked.message);
  assert.equal(asked.local, true, '同机申请走核内待批准面');

  const approved = await made.service.join.approve({
    collabId, sessionId: MEMBER_SESSION, managerSessionId: MANAGER_SESSION, approve: true,
  });
  assert.equal(approved.ok, true, approved.message);
  assert.deepEqual(twoStageFramesOf(made), [], '同机两段式不产生网络帧（核内旁路）');

  const roster = loadLedger(made.dir, collabId).ledger.members;
  assert.ok(
    roster.some((row) => row.sessionId === MEMBER_SESSION && row.role === 'member'),
    '批准应答报成功必须对应共享名单中的真实成员行',
  );
  const seats = made.service.listLocalSeats(collabId);
  assert.ok(seats.some((seat) => seat.sessionId === MANAGER_SESSION && seat.role === 'manager'), '站长席位仍在');
  const memberSeat = seats.find((seat) => seat.sessionId === MEMBER_SESSION);
  assert.equal(memberSeat?.state, 'member', '申请侧本地席位成立');
  assert.equal(memberSeat?.unverified, false, '含本席快照到达后清除 unverified');

  const sentMessage = await made.service.send({ collabId, sessionId: MEMBER_SESSION, text: '同机成员消息' });
  assert.equal(sentMessage.ok, true, sentMessage.message);
});

test('同机待批准申请：超过申请时限即从待批准面剪除，过期后不可再批准', async (t) => {
  let clockMs = Date.now();
  const made = makeService(t, { now: () => clockMs, config: { joinRequestTtlMs: 1000 } });
  const collabId = createCollabOf(made, '同机待批准');
  const asked = await made.service.join.request({ collabId, sessionId: MEMBER_SESSION });
  assert.equal(asked.ok, true, asked.message);
  assert.equal(made.service.join.pendingJoinsOf(collabId).length, 1);

  clockMs += 5000;
  assert.equal(made.service.join.pendingJoinsOf(collabId).length, 0, '超过申请时限的申请不再出面（申请人侧台账已失效）');
  const approved = await made.service.join.approve({
    collabId, sessionId: MEMBER_SESSION, managerSessionId: MANAGER_SESSION, approve: true,
  });
  assert.equal(approved.ok, false, '过期申请不得签发注定空授权的 grant');
  assert.match(approved.message, /没有待批准的加入申请/);
});

test('同机邀请：投达后登记挂起邀请，接受后两侧同名单、同席位，重启后仍在', async (t) => {
  const made = makeService(t);
  await made.service.registerBridgeEntry(MEMBER_SESSION, `bridge-${MEMBER_SESSION}`);
  const collabId = createCollabOf(made, '同机邀请');

  const invited = await made.service.join.createInvite({
    collabId, managerSessionId: MANAGER_SESSION,
    targetInstanceId: SELF.instanceId, targetSessionId: MEMBER_SESSION,
  });
  assert.equal(invited.ok, true, invited.message);
  const delivered = made.deliveries.filter((entry) => entry.type === 'invite' && entry.sessionId === MEMBER_SESSION);
  assert.equal(delivered.length, 1, '邀请帧经核内旁路投达目标会话');

  const pending = made.service.join.pendingInvitesFor({ collabId, sessionId: MEMBER_SESSION });
  assert.equal(pending.length, 1, '同机邀请必须进 pending-invites（acceptInvite 的证据面）');
  assert.equal(pending[0].inviteId, invited.inviteId);

  const accepted = await made.service.join.acceptInvite({
    collabId, inviteId: invited.inviteId, sessionId: MEMBER_SESSION,
  });
  assert.equal(accepted.ok, true, accepted.message);
  assert.equal(accepted.member, true, '接受即完成入席（核内旁路同步跑完 grant → confirm → 名单提交）');

  for (const sessionId of [MANAGER_SESSION, MEMBER_SESSION]) {
    const entry = made.service.list({ sessionId }).collabs.find((row) => row.collabId === collabId);
    assert.ok(entry !== undefined, `${sessionId} 的列表可见该协作`);
    const seatIds = entry.sessions.localSeats.map((seat) => seat.sessionId).sort();
    assert.deepEqual(seatIds, [MANAGER_SESSION, MEMBER_SESSION].sort(), `${sessionId} 视角的席位表与另一侧一致`);
    assert.equal(entry.memberCount, 2, '成员数按共享名单两席计');
  }
  const rosterSessions = loadLedger(made.dir, collabId).ledger.members.map((row) => row.sessionId).sort();
  assert.deepEqual(rosterSessions, [MANAGER_SESSION, MEMBER_SESSION].sort(), '共享名单两侧都在');

  const restarted = reload(made, t);
  const seatsAfter = restarted.service.listLocalSeats(collabId);
  for (const sessionId of [MANAGER_SESSION, MEMBER_SESSION]) {
    const seat = seatsAfter.find((entry) => entry.sessionId === sessionId);
    assert.equal(seat?.state, 'member', `重启后 ${sessionId} 的席位仍在`);
  }
  const rosterAfter = loadLedger(made.dir, collabId).ledger.members.map((row) => row.sessionId).sort();
  assert.deepEqual(rosterAfter, [MANAGER_SESSION, MEMBER_SESSION].sort(), '重启后共享名单两侧都在');
});

/* —— 静音摘要（设计 §5.4）：设静音记基线，取消按差值给 N —— */

const FORUM_SUMMARY_HEAD = '静音期间本讨论新增';
const FORUM_DEGRADE_TEXT = '静音期间本讨论可能有新内容——静音期与回填内容不进注入，经查看器/ws_view_ledger 补看';

async function postToForumOf(made, collabId, text) {
  const sent = await made.service.send({ collabId, sessionId: MANAGER_SESSION, text });
  assert.equal(sent.ok, true, sent.message);
}

function lastNoticeTextOf(made) {
  return made.notices.at(-1)?.payload?.text ?? '';
}

test('取消静音摘要：静音期新增 N 条；无新增 0 条；重启后基线缺失按降级文案', async (t) => {
  const made = makeService(t);
  const collabId = createCollabOf(made, '静音摘要', 'forum');
  made.service.setMute({ collabId, sessionId: MANAGER_SESSION, muted: false });
  made.notices.length = 0;

  await postToForumOf(made, collabId, '静音前内容一');
  await postToForumOf(made, collabId, '静音前内容二');
  made.service.setMute({ collabId, sessionId: MANAGER_SESSION, muted: true });
  await postToForumOf(made, collabId, '静音期内容');
  made.service.setMute({ collabId, sessionId: MANAGER_SESSION, muted: false });
  assert.equal(lastNoticeTextOf(made), `${FORUM_SUMMARY_HEAD} 1 条——静音期与回填内容不进注入，经查看器/ws_view_ledger 补看`);

  made.service.setMute({ collabId, sessionId: MANAGER_SESSION, muted: true });
  made.service.setMute({ collabId, sessionId: MANAGER_SESSION, muted: false });
  assert.equal(lastNoticeTextOf(made), `${FORUM_SUMMARY_HEAD} 0 条——静音期与回填内容不进注入，经查看器/ws_view_ledger 补看`, '无新增＝0 条');

  /* 重复设静音不重置基线：两次设静音之间的内容并入同一窗口。 */
  made.service.setMute({ collabId, sessionId: MANAGER_SESSION, muted: true });
  await postToForumOf(made, collabId, '窗口一');
  made.service.setMute({ collabId, sessionId: MANAGER_SESSION, muted: true });
  await postToForumOf(made, collabId, '窗口二');
  made.service.setMute({ collabId, sessionId: MANAGER_SESSION, muted: false });
  assert.equal(lastNoticeTextOf(made), `${FORUM_SUMMARY_HEAD} 2 条——静音期与回填内容不进注入，经查看器/ws_view_ledger 补看`);

  /* 基线只在进程内有效：重启后席位仍静音，但摘要按降级文案（不带 N），不再读写退役的 mute.json。 */
  made.service.setMute({ collabId, sessionId: MANAGER_SESSION, muted: true });
  const restarted = reload(made, t);
  assert.equal(restarted.service.localSeatOf(collabId, MANAGER_SESSION)?.muted, true, '重启后席位静音仍在');
  await postToForumOf(restarted, collabId, '重启后静音期内容');
  restarted.service.setMute({ collabId, sessionId: MANAGER_SESSION, muted: false });
  assert.equal(lastNoticeTextOf(restarted), FORUM_DEGRADE_TEXT, '基线缺失：摘要降级不带 N');
});

test('取消静音摘要：基线缺失（旧文件）时明确降级为不带 N 的文案', async (t) => {
  const made = makeService(t);
  const collabId = createCollabOf(made, '静音降级', 'forum');
  made.service.setMute({ collabId, sessionId: MANAGER_SESSION, muted: true });
  writeFileSync(mutePathOf(made.dir, collabId), JSON.stringify({ v: 1, muted: true, baseline: null }), 'utf8');

  const restarted = reload(made, t);
  const unmuted = restarted.service.setMute({ collabId, sessionId: MANAGER_SESSION, muted: false });
  assert.equal(unmuted.ok, true, unmuted.message);
  assert.equal(lastNoticeTextOf(restarted), FORUM_DEGRADE_TEXT, '基线缺失：摘要降级不带 N');
});
