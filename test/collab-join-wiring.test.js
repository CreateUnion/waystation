import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createJoinDomain } from '../src/collab/join.js';
import { createJoinApplicationsStore } from '../src/collab/joins.js';
import { decideAdmission } from '../src/collab/gate.js';
import { isLedgerShape, isMemberRecordShape } from '../src/collab/model.js';
import { COLLAB_CAPABILITY, MAX_ACTIVE_SEATS, validateMessage } from '../src/net/protocol.js';
import { carrierFilePath, collabDir, collabFilePath, invitesFilePath, pendingInvitesFilePath, joinsFilePath } from '../src/paths.js';
import { MEMBER_FILE_NAME, loadMember } from '../src/collab/store.js';
import { foldedMembersOf } from '../src/collab/local.js';
import { classifyCollabDir, isLegacyCollab } from '../src/collab/legacy.js';
import { MIGRATION_FILE_NAME } from '../src/collab/migration.js';
import { makeTempDir, waitFor } from './helpers.js';

/* M4 接线（0.2.0 会话级邀请与两段式入席）的判别面：邀请簿记 inviteId 全链路、指名/不指名、
 * pending-invites 生命周期、joinId 两段式、写点纪律（confirm 与名单提交之间不写 joins.json）、
 * 容量/过期/回滚/恢复对账。夹具直驱加入域（不构造 service.js——并行模块在途，避免跨模块红传导）。 */

const NOW = 1700000000000;
const COLLAB = 'collab-m4';
const MANAGER_SESSION = 'mgr-session-a';
const MANAGER_INSTANCE = 'inst-m';

function quietLog() {
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

function seat(sessionId, role = 'member', state = 'member') {
  return {
    version: 1, sessionId, role, state, joinSeq: role === 'manager' ? 1 : 2,
    joinedAt: new Date(NOW).toISOString(), muted: false, unverified: false,
  };
}

function memberRow(sessionId, overrides = {}) {
  return {
    instanceId: 'inst-a', sessionId, identityName: '应用甲', role: 'member', state: 'member',
    joinSeq: 2, joinedAt: new Date(NOW).toISOString(), ...overrides,
  };
}

function ledgerWith(members, overrides = {}) {
  return {
    version: 1,
    collabId: COLLAB,
    name: '接线项目',
    topic: '主题',
    mode: 'managed',
    status: 'active',
    managerTerm: 1,
    joinSeqNext: 2,
    manager: { instanceId: MANAGER_INSTANCE, sessionId: MANAGER_SESSION, identityName: '主机甲', term: 1 },
    members: [
      { instanceId: MANAGER_INSTANCE, sessionId: MANAGER_SESSION, identityName: '主机甲', role: 'manager', state: 'member', joinSeq: 1, joinedAt: new Date(NOW).toISOString() },
      ...members,
    ],
    board: [],
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function localOf(collabId, ledger, seats = []) {
  const seatMap = new Map([[MANAGER_SESSION, seat(MANAGER_SESSION, 'manager')]]);
  for (const entry of seats) {
    seatMap.set(entry.sessionId, entry);
  }
  return {
    collabId,
    role: 'manager',
    ledger,
    member: { collabId, role: 'manager', state: 'active' },
    endpoints: new Map(),
    snapshot: null,
    seats: seatMap,
    suspended: null,
  };
}

function makeHarness(t, overrides = {}) {
  const dir = overrides.dataDir ?? makeTempDir(t);
  const made = quietLog();
  const context = { dir, made, sent: [], injected: [], notices: [], clock: { value: NOW } };
  const sendImpl = overrides.send ?? captureSender(context.sent);
  const state = harnessStateOf(context, overrides, sendImpl);
  const join = createJoinDomain({ state, send: sendImpl, openViewer: null, log: made.log, now: state.clock });
  return harnessApiOf(context, state, join);
}

function captureSender(sent) {
  return (message) => {
    sent.push(message);
    return { ok: true, msgId: `msg-${sent.length}` };
  };
}

function harnessStateOf(context, overrides, sendImpl) {
  const { dir, made, injected, notices, clock } = context;
  return {
    dataDir: dir,
    config: { inviteTtlMs: 60000, pendingInvitesMax: 4, joinConfirmTtlMs: 60000, ...(overrides.config ?? {}) },
    self: { instanceId: MANAGER_INSTANCE, identityName: '主机甲', port: 17321 },
    collabs: new Map([[COLLAB, localOf(COLLAB, overrides.ledger ?? ledgerWith([]))]]),
    knownHosts: { lookup: (instanceId) => ({ address: '127.0.0.1', port: 18000 + (instanceId.length % 100) }), remember: () => {} },
    log: made.log,
    send: sendImpl,
    sendDirect: sendImpl,
    notify: (frame) => {
      notices.push(frame);
      return true;
    },
    injectLocalSeat: async (collabId, sessionId, frame) => {
      injected.push({ collabId, sessionId, frame });
      return { ok: true, delivered: true };
    },
    listLocalSeats: () => [],
    joinApplications: createJoinApplicationsStore({ dataDir: dir, log: made.log }),
    counters: {
      notificationsSent: 0, notificationsDropped: 0, persistFailures: 0, ledgerMutations: 0,
      snapshotSent: 0, snapshotSkipped: 0, messagesSent: 0, sendFailures: 0,
    },
    clock: () => clock.value,
    joinRequestRetryMs: 3600000,
    bindings: null,
    bridgeIdOf: null,
  };
}

function harnessApiOf(context, state, join) {
  return {
    join,
    state,
    local: state.collabs.get(COLLAB),
    dir: context.dir,
    sent: context.sent,
    injected: context.injected,
    notices: context.notices,
    logs: context.made.logs,
    clock: context.clock,
    advance: (ms) => { context.clock.value += ms; },
    addCollab: (collabId) => {
      const extra = localOf(collabId, ledgerWith([]));
      extra.ledger = { ...extra.ledger, collabId };
      state.collabs.set(collabId, extra);
      return extra;
    },
  };
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function joinRequestFrame(sessionId, instanceId = 'inst-a', identityName = '应用甲') {
  return {
    v: 1, cap: COLLAB_CAPABILITY, type: 'join-request', msgId: `req-${sessionId}`, from: { instanceId, identityName, port: 17400 },
    collabId: COLLAB, ts: new Date(NOW).toISOString(), payload: { sessionId },
  };
}

function joinConfirmFrame(joinId, sessionId, instanceId = 'inst-a', managerTerm = 1) {
  return {
    v: 1, cap: COLLAB_CAPABILITY, type: 'join-confirm', msgId: `cfm-${sessionId}`, from: { instanceId, identityName: '应用甲', port: 17400, sessionId },
    collabId: COLLAB, ts: new Date(NOW).toISOString(), payload: { joinId, managerTerm, version: 1 },
  };
}

function inviteApprovalFrame(inviteId, sessionId, instanceId = 'inst-a') {
  return {
    v: 1, cap: COLLAB_CAPABILITY, type: 'approve', msgId: `appr-${sessionId}`, from: { instanceId, identityName: '应用甲', port: 17400, sessionId },
    collabId: COLLAB, ts: new Date(NOW).toISOString(), payload: { inviteId },
  };
}

function deliveredOf(list, type) {
  return list.filter((message) => message.type === type);
}

/* —— 邀请簿记：createInvite / inviteId 全链路 / 投递失败回滚 —— */

test('createInvite：生成 inviteId、invites.json 落设计形态；邀请帧携 inviteId/targets/席位名单与 fromSessionId', async (t) => {
  const made = makeHarness(t);
  const created = await made.join.createInvite({
    collabId: COLLAB, managerSessionId: MANAGER_SESSION, targetInstanceId: 'inst-a', targetSessionId: 'app-session-1',
  });
  assert.equal(created.ok, true, created.message);
  assert.match(created.inviteId, /^inv-/);
  const invites = readJson(invitesFilePath(made.dir, COLLAB));
  assert.equal(invites.version, 1);
  assert.deepEqual(invites.invites[0].targets, [{ instanceId: 'inst-a', targetSessionId: 'app-session-1' }]);
  assert.equal(invites.invites[0].state, 'open');
  assert.deepEqual(invites.invites[0].acceptedSessions, [], '接受登记只在 confirm 成功后追加');
  const frame = deliveredOf(made.sent, 'invite')[0];
  assert.equal(frame.fromSessionId, MANAGER_SESSION, '直投帧补 fromSessionId（cap=2 帧强制）');
  assert.deepEqual(frame.toSessions, ['app-session-1'], '指名只投目标会话');
  assert.equal(frame.payload.inviteId, created.inviteId);
  assert.deepEqual(frame.payload.targets, [{ instanceId: 'inst-a', targetSessionId: 'app-session-1' }]);
  assert.equal(frame.payload.members[0].sessionId, MANAGER_SESSION, '名单按席位（含站长会话）');
});

test('createInvite：投递失败＝撤回记录（不留未投递的 open 邀请）', async (t) => {
  const made = makeHarness(t, { send: () => ({ ok: false, reason: '对方不可达' }) });
  const created = await made.join.createInvite({ collabId: COLLAB, managerSessionId: MANAGER_SESSION, targetInstanceId: 'inst-a' });
  assert.equal(created.ok, false);
  assert.match(created.message, /邀请发送失败/);
  const invites = readJson(invitesFilePath(made.dir, COLLAB));
  assert.equal(invites.invites[0].state, 'withdrawn');
});

test('createInvite：讨论不生成 inviteId（D18）；非站长会话/满载/坏目标如实拒', async (t) => {
  const made = makeHarness(t);
  made.local.ledger.mode = 'forum';
  const forum = await made.join.createInvite({ collabId: COLLAB, managerSessionId: MANAGER_SESSION, targetInstanceId: 'inst-a' });
  assert.equal(forum.ok, false);
  assert.equal(forum.code, 'forum-no-invite');
  assert.equal(existsSync(invitesFilePath(made.dir, COLLAB)), false, 'forum 不写 invites.json');

  const fresh = makeHarness(t);
  assert.match((await fresh.join.createInvite({ collabId: COLLAB, managerSessionId: 'not-manager', targetInstanceId: 'inst-a' })).message, /站长/);
  assert.match((await fresh.join.createInvite({ collabId: COLLAB, managerSessionId: MANAGER_SESSION, targetInstanceId: 'bad id!' })).message, /目标非法/);

  const full = makeHarness(t, { ledger: ledgerWith(fullRosterSeats()) });
  const refused = await full.join.createInvite({ collabId: COLLAB, managerSessionId: MANAGER_SESSION, targetInstanceId: 'inst-a' });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /上限/);
});

function fullRosterSeats() {
  const rows = [];
  for (let index = 1; index < MAX_ACTIVE_SEATS; index++) {
    rows.push(memberRow(`seat-${index}`, { instanceId: `inst-${index}`, identityName: `成员${index}`, joinSeq: index + 1 }));
  }
  return rows;
}

/* —— 目标机挂起邀请：生命周期、指名/不指名、回复 —— */

test('pending-invites：登记/补投匹配；指名邀请只对目标会话可见，接受后 consumed', async (t) => {
  const made = makeHarness(t);
  const applied = made.join.registerPendingInvite({
    collabId: COLLAB, inviteId: 'inv-target-1',
    fromManager: { instanceId: 'inst-remote-manager', sessionId: 'remote-mgr' },
    targetSessionId: 'app-session-1', expiresAt: NOW + 60000,
  });
  assert.equal(applied.ok, true, applied.message);
  assert.equal(made.join.pendingInvitesFor({ collabId: COLLAB, sessionId: 'app-session-1' }).length, 1);
  assert.deepEqual(made.join.pendingInvitesFor({ collabId: COLLAB, sessionId: 'app-session-2' }), [], '指名不外泄给同机其他会话');
  const accepted = await made.join.acceptInvite({ collabId: COLLAB, inviteId: 'inv-target-1', sessionId: 'app-session-1' });
  assert.equal(accepted.ok, true, accepted.message);
  assert.equal(accepted.pending, true, '远端站长：只发 approve，等 grant');
  const pending = readJson(pendingInvitesFilePath(made.dir, COLLAB));
  assert.equal(pending.invites[0].state, 'consumed');
  assert.deepEqual(pending.invites[0].acceptedSessions, ['app-session-1']);
  const approve = deliveredOf(made.sent, 'approve')[0];
  assert.equal(approve.fromSessionId, 'app-session-1');
  assert.equal(approve.payload.inviteId, 'inv-target-1');
  assert.deepEqual(approve.toSessions, ['remote-mgr'], '接受帧指名回站长会话');
});

test('pending-invites：不指名邀请多席各自接受；首个接受不消费整条；未成席的重复接受重发 approve', async (t) => {
  const made = makeHarness(t);
  made.join.registerPendingInvite({
    collabId: COLLAB, inviteId: 'inv-open-1',
    fromManager: { instanceId: 'inst-remote-manager', sessionId: 'remote-mgr' },
    expiresAt: NOW + 60000,
  });
  for (const sessionId of ['app-session-1', 'app-session-2', 'app-session-1']) {
    const accepted = await made.join.acceptInvite({ collabId: COLLAB, inviteId: 'inv-open-1', sessionId });
    assert.equal(accepted.ok, true, accepted.message);
  }
  const pending = readJson(pendingInvitesFilePath(made.dir, COLLAB));
  assert.equal(pending.invites[0].state, 'open', '不指名邀请保持 open（多席）');
  assert.deepEqual(pending.invites[0].acceptedSessions, ['app-session-1', 'app-session-2'], '同一会话只登记一次');
  assert.equal(deliveredOf(made.sent, 'approve').length, 3, '未成席的重复接受重发 approve（grant 丢帧可恢复）');
});

test('pending-invites：过期/未知/形态坏一律拒；接受未过期邀请后过期重放不再受理', async (t) => {
  const made = makeHarness(t);
  assert.equal((await made.join.acceptInvite({ collabId: COLLAB, inviteId: 'inv-ghost', sessionId: 'app-session-1' })).ok, false);
  assert.match(made.join.registerPendingInvite({
    collabId: COLLAB, inviteId: 'inv-expired', fromManager: { instanceId: 'inst-x', sessionId: 'sess-x' }, expiresAt: NOW - 1,
  }).message, /过期|expired/);
  made.join.registerPendingInvite({
    collabId: COLLAB, inviteId: 'inv-live', fromManager: { instanceId: 'inst-x', sessionId: 'sess-x' }, expiresAt: NOW + 1000,
  });
  made.advance(2000);
  const late = await made.join.acceptInvite({ collabId: COLLAB, inviteId: 'inv-live', sessionId: 'app-session-1' });
  assert.equal(late.ok, false);
  assert.match(late.message, /过期/);
});

/* —— 站长侧两段式：approveJoin → joinId → confirm → 名单提交 —— */

test('approveJoin：写 joining（joins.json v2 仅未确认）＋发 join-grant（joinId/manager/term/version/fromSessionId）', async (t) => {
  const made = makeHarness(t);
  made.join.handleJoinRequest(joinRequestFrame('app-session-1'));
  const approved = await made.join.approveJoin({ collabId: COLLAB, managerSessionId: MANAGER_SESSION, sessionId: 'app-session-1', approve: true });
  assert.equal(approved.ok, true, approved.message);
  assert.equal(approved.joining, true);
  assert.match(approved.joinId, /^join-/);
  const joins = readJson(joinsFilePath(made.dir, COLLAB));
  assert.equal(joins.v, 2);
  assert.deepEqual(Object.keys(joins.pendingJoins[0]).sort(), ['expiresAt', 'grantVersion', 'instanceId', 'joinId', 'managerTerm', 'requestedAt', 'sessionId']);
  assert.equal(joins.pendingJoins[0].joinId, approved.joinId);
  const grant = deliveredOf(made.sent, 'join-grant')[0];
  assert.equal(grant.fromSessionId, MANAGER_SESSION);
  assert.equal(grant.payload.joinId, approved.joinId);
  assert.deepEqual(grant.payload.manager, { instanceId: MANAGER_INSTANCE, sessionId: MANAGER_SESSION, identityName: '主机甲' });
  assert.equal(grant.payload.managerTerm, 1);
  assert.equal(grant.payload.version, joins.pendingJoins[0].grantVersion, 'grant 的 version 取签发时的台账版本');
  assert.equal(deliveredOf(made.sent, 'invite').length, 1, '冷启动申请先补受邀入席，后发 grant');
});

test('confirm：先 confirmJoining、再写共享名单；成功后 joins.json 清空、名单分配 joinSeq 并推快照', async (t) => {
  const made = makeHarness(t);
  const approved = await approvedOf(made, 'app-session-1');
  const confirmed = await made.join.handleJoinConfirm(joinConfirmFrame(approved.joinId, 'app-session-1'));
  assert.equal(confirmed.ok, true, confirmed.message);
  assert.equal(confirmed.action, 'join-confirmed');
  const row = made.local.ledger.members.find((entry) => entry.sessionId === 'app-session-1');
  assert.equal(row.state, 'member');
  assert.equal(row.role, 'member');
  assert.equal(row.joinSeq, 2);
  assert.equal(made.local.ledger.joinSeqNext, 3);
  assert.equal(made.local.ledger.status, 'active', '首个非站长席位入席即建立');
  assert.deepEqual(readJson(joinsFilePath(made.dir, COLLAB)).pendingJoins, [], '名单提交成功后写盘投影为空');
  const snapshot = deliveredOf(made.sent, 'snapshot').at(-1);
  assert.equal(snapshot.payload.kind, 'data');
  assert.equal(snapshot.payload.ledger.members.some((entry) => entry.sessionId === 'app-session-1' && entry.state === 'member'), true);
});

test('窗口期 join-confirm：快照携 managerWindow（有窗口才带，且与台账同窗）', async (t) => {
  const window = { windowBaseTerm: 1, windowEndsAt: NOW + 60000 };
  const made = makeHarness(t, { ledger: ledgerWith([], { managerWindow: window }) });
  const approved = await approvedOf(made, 'app-session-window');
  const result = await made.join.handleJoinConfirm(joinConfirmFrame(approved.joinId, 'app-session-window'));
  assert.equal(result.action, 'join-confirmed');
  const snapshot = deliveredOf(made.sent, 'snapshot').at(-1);
  assert.deepEqual(snapshot.payload.managerWindow, window, '窗口期快照必须携 managerWindow（缺失会被协议一致性校验拒收）');
  assert.deepEqual(snapshot.payload.ledger.managerWindow, window, '帧与台账同窗');
});

async function approvedOf(made, sessionId, instanceId = 'inst-a') {
  made.join.handleJoinRequest(joinRequestFrame(sessionId, instanceId));
  const approved = await made.join.approveJoin({ collabId: COLLAB, managerSessionId: MANAGER_SESSION, sessionId, approve: true });
  assert.equal(approved.ok, true, approved.message);
  return approved;
}

test('confirm 幂等：名单已有本席时 joinId 未知也回快照（alreadyMember），不重复分配 joinSeq', async (t) => {
  const made = makeHarness(t);
  const approved = await approvedOf(made, 'app-session-1');
  assert.equal((await made.join.handleJoinConfirm(joinConfirmFrame(approved.joinId, 'app-session-1'))).ok, true);
  const before = made.local.ledger.members.length;
  const replay = await made.join.handleJoinConfirm(joinConfirmFrame(approved.joinId, 'app-session-1'));
  assert.equal(replay.ok, true);
  assert.equal(replay.action, 'join-confirmed');
  assert.equal(replay.alreadyMember, true);
  assert.equal(made.local.ledger.members.length, before, '不重复入名单');
  assert.equal(deliveredOf(made.sent, 'snapshot').length >= 2, true, '回当前快照（H-I4）');
});

test('confirm 超时：过期即删 joining、回 join-deny(expired)，joins.json 投影清空', async (t) => {
  const made = makeHarness(t);
  const approved = await approvedOf(made, 'app-session-1');
  made.advance(60001);
  const result = await made.join.handleJoinConfirm(joinConfirmFrame(approved.joinId, 'app-session-1'));
  assert.equal(result.action, 'join-denied');
  assert.equal(result.reason, 'expired');
  assert.deepEqual(readJson(joinsFilePath(made.dir, COLLAB)).pendingJoins, []);
  assert.equal(deliveredOf(made.sent, 'join-deny').at(-1).payload.reason, 'expired');
  assert.equal(made.local.ledger.members.some((entry) => entry.sessionId === 'app-session-1' && entry.state === 'member'), false);
});

test('confirm 容量：32 席满员拒绝并回 join-deny(capacity)；alreadyMember 跳过容量与过期', async (t) => {
  const full = makeHarness(t, { ledger: ledgerWith(fullRosterSeats()) });
  full.join.handleJoinRequest(joinRequestFrame('app-session-1'));
  const refused = await full.join.approveJoin({ collabId: COLLAB, managerSessionId: MANAGER_SESSION, sessionId: 'app-session-1', approve: true });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'capacity');
  assert.equal(deliveredOf(full.sent, 'join-deny').at(-1).payload.reason, 'capacity');
  assert.deepEqual(readJson(joinsFilePath(full.dir, COLLAB))?.pendingJoins ?? [], [], '容量拒绝不产生 joining 记录');

  /* alreadyMember：名单已含本席的崩溃重放——跳过容量与过期（grant 可能已过 TTL），身份/term 仍校验。 */
  const replay = makeHarness(t);
  const approved = await approvedOf(replay, 'app-session-replay');
  for (const row of fullRosterSeats()) {
    replay.local.ledger.members.push(row);
  }
  replay.local.ledger.members.push(memberRow('app-session-replay', { instanceId: 'inst-a', joinSeq: MAX_ACTIVE_SEATS + 1 }));
  replay.advance(60001);
  const confirmed = replay.join.confirmJoining(approved.joinId, 'app-session-replay', {
    instanceId: 'inst-a', managerTerm: 1, alreadyMember: true, activeSeats: MAX_ACTIVE_SEATS,
  });
  assert.equal(confirmed.ok, true, confirmed.message);
  assert.equal(confirmed.alreadyMember, true);
});

function joiningRecord(joinId, instanceId, sessionId, overrides = {}) {
  return {
    joinId, instanceId, sessionId, managerTerm: 1, grantVersion: 1,
    requestedAt: NOW, expiresAt: NOW + 60000, ...overrides,
  };
}

function seedJoiningFile(dir, records) {
  const file = joinsFilePath(dir, COLLAB);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ v: 2, pendingJoins: records }));
}

test('confirm 名单写失败：unconfirm 回滚（joins.json 保留未确认 grant），恢复后可重试', async (t) => {
  const made = makeHarness(t);
  const approved = await approvedOf(made, 'app-session-1');
  made.local.suspended = { reason: 'test-suspended' };
  const failed = made.join.confirmJoining(approved.joinId, 'app-session-1', { instanceId: 'inst-a', managerTerm: 1 });
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'roster-write-failed');
  const pending = readJson(joinsFilePath(made.dir, COLLAB)).pendingJoins;
  assert.equal(pending.length, 1, 'confirm 成功与名单提交之间不写盘：盘上仍是未确认 grant');
  assert.equal(pending[0].joinId, approved.joinId);
  assert.equal(made.local.ledger.members.some((entry) => entry.sessionId === 'app-session-1' && entry.state === 'member'), false);
  made.local.suspended = null;
  const retried = made.join.confirmJoining(approved.joinId, 'app-session-1', { instanceId: 'inst-a', managerTerm: 1 });
  assert.equal(retried.ok, true, retried.message);
  assert.deepEqual(readJson(joinsFilePath(made.dir, COLLAB)).pendingJoins, []);
});

test('join-deny 回滚：只清本会话的申请记录，不误清同机其他待决申请', async (t) => {
  const made = makeHarness(t);
  const first = await approvedOf(made, 'app-session-a');
  await approvedOf(made, 'app-session-b');
  for (const [sessionId, msgId] of [['app-session-a', 'apply-a'], ['app-session-b', 'apply-b']]) {
    made.state.joinApplications.add({ collabId: COLLAB, sessionId, managerInstanceId: MANAGER_INSTANCE, msgId, sentAt: NOW });
  }
  const result = made.join.handleJoinDeny({
    v: 1, cap: COLLAB_CAPABILITY, type: 'join-deny', msgId: 'deny-a',
    from: { instanceId: MANAGER_INSTANCE, identityName: '主机甲', port: 17321, sessionId: MANAGER_SESSION },
    collabId: COLLAB, ts: new Date(NOW).toISOString(),
    payload: { joinId: first.joinId, reason: 'aborted', sessionId: 'app-session-a' },
  });
  assert.equal(result.action, 'join-denied');
  const remaining = made.state.joinApplications.list();
  assert.equal(remaining.some((record) => record.sessionId === 'app-session-a'), false, '本会话申请已清');
  assert.equal(remaining.some((record) => record.sessionId === 'app-session-b'), true, '其他会话申请保留');
});

/* —— 短码匹配、歧义、跨实例与跨协作 —— */

test('批准匹配：完整会话标识精确命中；唯一短码可用；短码歧义拒', async (t) => {
  const made = makeHarness(t);
  made.join.handleJoinRequest(joinRequestFrame('aaaa1111-session'));
  made.join.handleJoinRequest(joinRequestFrame('bbbb2222-session'));
  const ambiguous = await made.join.approveJoin({ collabId: COLLAB, managerSessionId: MANAGER_SESSION, sessionId: 'aaaa1111', approve: true });
  assert.equal(ambiguous.ok, true, ambiguous.message);
  const short = await made.join.approveJoin({ collabId: COLLAB, managerSessionId: MANAGER_SESSION, sessionId: 'bbbb2222', approve: true });
  assert.equal(short.ok, true, short.message);

  const clash = makeHarness(t);
  clash.join.handleJoinRequest(joinRequestFrame('aaaa1111-one'));
  clash.join.handleJoinRequest(joinRequestFrame('aaaa1111-two'));
  const refused = await clash.join.approveJoin({ collabId: COLLAB, managerSessionId: MANAGER_SESSION, sessionId: 'aaaa1111', approve: true });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /歧义/);
  const exact = await clash.join.approveJoin({ collabId: COLLAB, managerSessionId: MANAGER_SESSION, sessionId: 'aaaa1111-one', approve: true });
  assert.equal(exact.ok, true, '完整标识优先（不受短码歧义影响）');
});

test('跨实例 begin：同键不同实例回 instance-mismatch，不覆盖旧 grant；旧 joinId 仍可确认', async (t) => {
  const made = makeHarness(t);
  const first = await approvedOf(made, 'same-session', 'inst-a');
  made.join.handleJoinRequest(joinRequestFrame('same-session', 'inst-b', '应用乙'));
  const second = await made.join.approveJoin({ collabId: COLLAB, managerSessionId: MANAGER_SESSION, sessionId: 'same-session', approve: true });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'instance-mismatch');
  const confirmed = made.join.confirmJoining(first.joinId, 'same-session', { instanceId: 'inst-a', managerTerm: 1 });
  assert.equal(confirmed.ok, true, '旧实例的 grant 未被覆盖');
  assert.equal(made.local.ledger.members.find((entry) => entry.sessionId === 'same-session').instanceId, 'inst-a');
});

test('跨协作隔离：同一 inviteId 的挂起邀请与登记互不串台', async (t) => {
  const made = makeHarness(t);
  const other = made.addCollab('collab-other');
  made.join.registerPendingInvite({
    collabId: COLLAB, inviteId: 'inv-shared', fromManager: { instanceId: 'inst-x', sessionId: 'sess-x' }, expiresAt: NOW + 60000,
  });
  made.join.registerPendingInvite({
    collabId: 'collab-other', inviteId: 'inv-shared', fromManager: { instanceId: 'inst-x', sessionId: 'sess-x' }, targetSessionId: 'app-session-2', expiresAt: NOW + 60000,
  });
  assert.equal(made.join.pendingInvitesFor({ collabId: COLLAB, sessionId: 'app-session-1' }).length, 1);
  assert.deepEqual(made.join.pendingInvitesFor({ collabId: 'collab-other', sessionId: 'app-session-1' }), []);
  assert.equal(other.ledger.collabId, 'collab-other');
  const accepted = await made.join.acceptInvite({ collabId: 'collab-other', inviteId: 'inv-shared', sessionId: 'app-session-2' });
  assert.equal(accepted.ok, true, accepted.message);
  assert.equal(deliveredOf(made.sent, 'approve')[0].collabId, 'collab-other');
});

/* —— 邀请批准：acceptedSessions 只在入名单后登记；指名/不指名 ------- */

test('受邀批准：approve 只产生 joining，不登记已接受；confirm 成功后才写 acceptedSessions', async (t) => {
  const made = makeHarness(t);
  const invite = await made.join.createInvite({ collabId: COLLAB, managerSessionId: MANAGER_SESSION, targetInstanceId: 'inst-a', targetSessionId: 'app-session-1' });
  const granted = await made.join.handleInviteApproval(inviteApprovalFrame(invite.inviteId, 'app-session-1'));
  assert.equal(granted.ok, true, granted.message);
  const before = readJson(invitesFilePath(made.dir, COLLAB)).invites[0];
  assert.deepEqual(before.acceptedSessions, [], 'joining 阶段不算已接受');
  assert.equal(readJson(joinsFilePath(made.dir, COLLAB)).pendingJoins.length, 1);
  const confirmed = await made.join.handleJoinConfirm(joinConfirmFrame(granted.joinId, 'app-session-1'));
  assert.equal(confirmed.action, 'join-confirmed');
  const after = readJson(invitesFilePath(made.dir, COLLAB)).invites[0];
  assert.deepEqual(after.acceptedSessions, [{ instanceId: 'inst-a', sessionId: 'app-session-1' }]);
  assert.equal(after.state, 'closed', '指名邀请接受后整条关闭');
});

test('不指名邀请：多个会话各自确认成席；首个接受不消费整条，acceptedSessions 逐席登记', async (t) => {
  const made = makeHarness(t);
  const invite = await made.join.createInvite({ collabId: COLLAB, managerSessionId: MANAGER_SESSION, targetInstanceId: 'inst-a' });
  const first = await made.join.handleInviteApproval(inviteApprovalFrame(invite.inviteId, 'app-session-1'));
  const second = await made.join.handleInviteApproval(inviteApprovalFrame(invite.inviteId, 'app-session-2'));
  assert.equal(first.ok, true, first.message);
  assert.equal(second.ok, true, second.message, '首个接受不消费整条邀请');
  assert.equal((await made.join.handleJoinConfirm(joinConfirmFrame(first.joinId, 'app-session-1'))).action, 'join-confirmed');
  assert.equal((await made.join.handleJoinConfirm(joinConfirmFrame(second.joinId, 'app-session-2'))).action, 'join-confirmed');
  const record = readJson(invitesFilePath(made.dir, COLLAB)).invites[0];
  assert.equal(record.state, 'open', '不指名邀请保持 open（多席）');
  assert.deepEqual(record.acceptedSessions.map((entry) => entry.sessionId).sort(), ['app-session-1', 'app-session-2']);
});

test('指名邀请：非目标会话批准被拒；撤回后不再可批准；讨论无 inviteId 路径', async (t) => {
  const made = makeHarness(t);
  const invite = await made.join.createInvite({ collabId: COLLAB, managerSessionId: MANAGER_SESSION, targetInstanceId: 'inst-a', targetSessionId: 'app-session-1' });
  const wrong = await made.join.handleInviteApproval(inviteApprovalFrame(invite.inviteId, 'app-session-2'));
  assert.equal(wrong.ok, false);
  assert.match(wrong.message, /邀请不可用/);
  const withdrawn = made.join.withdrawInvite({ collabId: COLLAB, managerSessionId: MANAGER_SESSION, inviteId: invite.inviteId });
  assert.equal(withdrawn.ok, true);
  const after = await made.join.handleInviteApproval(inviteApprovalFrame(invite.inviteId, 'app-session-1'));
  assert.equal(after.ok, false);
  assert.match(after.message, /邀请不可用/);

  const forum = makeHarness(t);
  forum.local.ledger.mode = 'forum';
  assert.equal(forum.join.withdrawInvite({ collabId: COLLAB, managerSessionId: MANAGER_SESSION, inviteId: 'inv-x' }).code, 'forum-no-invite');
});

/* —— 启动恢复与对账 —— */

test('restore：按设计形态恢复未确认 joining；已入名单的记录对账清出；confirmed/坏条拒收', (t) => {
  const dir = makeTempDir(t);
  seedJoiningFile(dir, [
    joiningRecord('join-member', 'inst-a', 'already-member'),
    joiningRecord('join-pending', 'inst-a', 'pending-session'),
    { ...joiningRecord('join-confirmed', 'inst-a', 'confirmed-session'), confirmed: true },
    { joinId: 'join-bad' },
    joiningRecord('join-dup', 'inst-a', 'dup-session'),
    joiningRecord('join-dup', 'inst-b', 'dup-session-2'),
  ]);
  const made = makeHarness(t, { dataDir: dir });
  made.local.ledger = ledgerWith([memberRow('already-member', { instanceId: 'inst-a' })]);
  const projection = made.join.pendingJoiningProjection(COLLAB);
  assert.deepEqual(projection.map((record) => record.joinId).sort(), ['join-dup', 'join-pending'], '只留未确认且未入名单的记录');
  const saved = readJson(joinsFilePath(dir, COLLAB));
  assert.equal(saved.v, 2);
  assert.deepEqual(saved.pendingJoins.map((record) => record.joinId).sort(), ['join-dup', 'join-pending']);
});

test('restore：joins.json 超上限按有效期裁剪；过期未确认记录可继续 expire 并回 deny', async (t) => {
  const dir = makeTempDir(t);
  const records = [];
  for (let index = 0; index < MAX_ACTIVE_SEATS + 4; index++) {
    records.push(joiningRecord(`join-${index}`, 'inst-a', `session-${index}`, { expiresAt: NOW + 1000 + index }));
  }
  seedJoiningFile(dir, records);
  const made = makeHarness(t, { dataDir: dir });
  const projection = made.join.pendingJoiningProjection(COLLAB);
  assert.equal(projection.length, MAX_ACTIVE_SEATS, '恢复裁剪到运行期上限');
  assert.equal(projection.every((record) => record.expiresAt > NOW + 1000), true, '保留有效期更晚者');
  made.clock.value = NOW + 100000;
  const expired = await made.join.expireJoining(made.clock.value);
  assert.equal(expired.expired, MAX_ACTIVE_SEATS);
  assert.equal(readJson(joinsFilePath(dir, COLLAB)).pendingJoins.length, 0);
});

test('restore：pending-invites 超容量按终态优先回收，再淘汰最早过期 open（dropped）', (t) => {
  const dir = makeTempDir(t);
  const file = pendingInvitesFilePath(dir, COLLAB);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({
    version: 1,
    invites: [
      { inviteId: 'inv-open-old', collabId: COLLAB, fromManager: { instanceId: 'inst-x', sessionId: null }, targetSessionId: null, expiresAt: NOW + 1000, state: 'open', acceptedSessions: [] },
      { inviteId: 'inv-open-new', collabId: COLLAB, fromManager: { instanceId: 'inst-x', sessionId: null }, targetSessionId: null, expiresAt: NOW + 9000, state: 'open', acceptedSessions: [] },
      { inviteId: 'inv-consumed', collabId: COLLAB, fromManager: { instanceId: 'inst-x', sessionId: null }, targetSessionId: 's1', expiresAt: NOW + 5000, state: 'consumed', acceptedSessions: ['s1'] },
    ],
  }));
  const made = makeHarness(t, { dataDir: dir, config: { pendingInvitesMax: 2 } });
  const visible = made.join.pendingInvitesFor({ collabId: COLLAB, sessionId: 'app-session-1' });
  assert.deepEqual(visible.map((record) => record.inviteId).sort(), ['inv-open-new', 'inv-open-old'], '容量 2：先回收终态，两条 open 都保留');
});

/* —— 本机注入面与发送席位 —— */

test('本机目标：注入帧携 cap=2 与 from.sessionId；注入不可用时如实失败（服务注入面集成点）', async (t) => {
  const localTarget = makeHarness(t);
  localTarget.state.self.instanceId = MANAGER_INSTANCE;
  const created = await localTarget.join.createInvite({ collabId: COLLAB, managerSessionId: MANAGER_SESSION, targetInstanceId: MANAGER_INSTANCE, targetSessionId: 'app-session-1' });
  assert.equal(created.ok, true, created.message);
  assert.equal(localTarget.injected.length, 1);
  assert.equal(localTarget.injected[0].frame.cap, COLLAB_CAPABILITY);
  assert.equal(localTarget.injected[0].frame.from.sessionId, MANAGER_SESSION);
  assert.equal(localTarget.sent.length, 0, '本机目标不走网络发送');

  /* 形态类失败（注入面明确拒收）＝发送失败，邀请记录撤回。 */
  const broken = makeHarness(t);
  broken.state.injectLocalSeat = () => ({ ok: false, reason: 'not-invite-target' });
  const refused = await broken.join.createInvite({ collabId: COLLAB, managerSessionId: MANAGER_SESSION, targetInstanceId: MANAGER_INSTANCE, targetSessionId: 'not-seated' });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /注入|不可注入|发送失败/);

  /* 离线类失败（目标会话未注册 / 桥离线）不是发送面故障：邀请与挂起记录都保留，等注册补投。 */
  const offline = makeHarness(t);
  offline.state.injectLocalSeat = () => ({ ok: false, reason: 'no-seat' });
  const held = await offline.join.createInvite({ collabId: COLLAB, managerSessionId: MANAGER_SESSION, targetInstanceId: MANAGER_INSTANCE, targetSessionId: 'not-seated' });
  assert.equal(held.ok, true, held.message);
  assert.equal(held.pending, true);
  assert.equal(readJson(invitesFilePath(offline.dir, COLLAB)).invites[0].state, 'open', '离线目标保留 open 邀请记录');
  assert.equal(readJson(pendingInvitesFilePath(offline.dir, COLLAB)).invites[0].state, 'open', '离线目标保留挂起记录供补投');
});

/* —— 按名解析的能力字段（M12 接线点） —— */

test('按名解析：{instanceId} 目标保留实例标识传入探测；应答 participants 透传不丢弃', async (t) => {
  const made = makeHarness(t);
  const calls = [];
  made.state.requestJoinResolve = async (options) => {
    calls.push(options);
    return {
      ok: true,
      reply: {
        found: true, collabId: 'collab-far', participants: 2,
        responder: { instanceId: 'inst-known', identityName: '主机己', address: '127.0.0.1', port: 19000 },
      },
    };
  };
  const result = await made.join.request({ name: '远端项目', target: { instanceId: 'inst-known' }, sessionId: 'newcomer-1' });
  assert.equal(result.ok, true, result.message);
  assert.equal(calls[0].instanceId, 'inst-known', '实例标识随探测请求保留（单播能力探测的寻址依据）');
  assert.equal(result.participants, 2, 'participants 从应答透传到申请结果');
  assert.equal(deliveredOf(made.sent, 'join-request').length, 1);
});

/* —— 离席释放 / 未确认回滚（接线义务） —— */

test('releaseJoining：离席后同键可再次入席；unconfirmJoining 可把已确认记录退回未确认', async (t) => {
  const made = makeHarness(t);
  const first = await approvedOf(made, 'app-session-1');
  assert.equal(made.join.releaseJoining(COLLAB, 'app-session-1').released, true);
  assert.deepEqual(readJson(joinsFilePath(made.dir, COLLAB)).pendingJoins, [], '释放后写盘投影清空');
  const again = await approvedOf(made, 'app-session-1');
  assert.notEqual(again.joinId, first.joinId, '同键再入席换新 joinId');
  const unconfirmed = made.join.unconfirmJoining(again.joinId);
  assert.equal(unconfirmed.ok, true);
  assert.equal(unconfirmed.unconfirmed, false, '未确认记录再次回滚＝幂等成功');
  assert.equal(unconfirmed.idempotent, true);
});

/* —— 申请人侧（冷启动 grant）：本机无协作记录也能完成两段式 —— */

function joinGrantFrame(joinId, sessionId = 'app-session-1', overrides = {}) {
  return {
    v: 1, cap: COLLAB_CAPABILITY, type: 'join-grant', msgId: `grant-${sessionId}`,
    from: { instanceId: MANAGER_INSTANCE, identityName: '主机甲', port: 17321, sessionId: MANAGER_SESSION },
    collabId: COLLAB, ts: new Date(NOW).toISOString(),
    payload: {
      joinId,
      manager: { instanceId: MANAGER_INSTANCE, sessionId: MANAGER_SESSION, identityName: '主机甲' },
      managerTerm: 1, version: 1, sessionId,
    },
    ...overrides,
  };
}

/* 申请人机（首次接触：本机没有任何协作记录）。send 只记帧，由用例决定是否投递。 */
function applicantHarnessOf(t, { send = null, overrides = {} } = {}) {
  const dir = makeTempDir(t);
  const made = quietLog();
  const sent = [];
  const sender = send ?? ((message) => {
    sent.push(message);
    return { ok: true, msgId: `a-${sent.length}` };
  });
  const state = {
    dataDir: dir,
    config: { inviteTtlMs: 60000, pendingInvitesMax: 4, joinConfirmTtlMs: 60000 },
    self: { instanceId: 'inst-a', identityName: '应用甲', port: 17400 },
    collabs: new Map(),
    knownHosts: { lookup: () => null, remember: () => {} },
    log: made.log,
    notify: () => true,
    injectLocalSeat: async () => ({ ok: true, delivered: true }),
    listLocalSeats: () => [],
    joinApplications: createJoinApplicationsStore({ dataDir: dir, log: made.log }),
    counters: {
      notificationsSent: 0, notificationsDropped: 0, persistFailures: 0, ledgerMutations: 0,
      snapshotSent: 0, snapshotSkipped: 0, messagesSent: 0, sendFailures: 0,
    },
    clock: () => NOW,
    joinRequestRetryMs: 3600000,
    bindings: null,
    bridgeIdOf: null,
    ...overrides,
  };
  const join = createJoinDomain({ state, send: sender, openViewer: null, log: made.log, now: state.clock });
  return { join, state, sent, dir, logs: made.logs, sender };
}

test('冷启动 grant：本机无协作记录时建最小参与记录、写成员席位并发 join-confirm（不空等）', async (t) => {
  const applicant = applicantHarnessOf(t);
  applicant.state.joinApplications.add({
    collabId: COLLAB, sessionId: 'app-session-1', managerInstanceId: MANAGER_INSTANCE, msgId: 'apply-1', sentAt: NOW,
    managerAddress: '127.0.0.1', managerPort: 17321,
  });
  const result = await applicant.join.handleJoinGrant(joinGrantFrame('join-cold-1'));
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.action, 'joining');
  const local = applicant.state.collabs.get(COLLAB);
  assert.ok(local !== undefined, '未在册协作按 grant 建立最小本地参与记录');
  assert.equal(local.role, 'member');
  assert.equal(local.ledger, null);
  assert.deepEqual(local.endpoints.get(MANAGER_INSTANCE), { address: '127.0.0.1', port: 17321 }, '回执寻址用申请台账定格的站长端点');
  assert.equal(local.seats.size, 1, '只建一条席位');
  const seat = local.seats.get('app-session-1');
  assert.equal(seat.state, 'member');
  assert.equal(seat.unverified, true, '发出 confirm 后转 member(unverified)');
  assert.equal([...local.seats.keys()].includes(undefined), false, '合并写带 sessionId，不留匿名席位');
  const confirm = applicant.sent.find((message) => message.type === 'join-confirm');
  assert.equal(confirm.collabId, COLLAB);
  assert.equal(confirm.fromSessionId, 'app-session-1');
  assert.equal(confirm.payload.joinId, 'join-cold-1');
});

test('冷启动 E2E：按名解析申请 → 站长批准（先补邀请）→ grant → confirm → 双端成席', async (t) => {
  const pair = coldStartPairOf(t);
  const requested = await pair.applicant.join.request({ name: '接线项目', target: { instanceId: MANAGER_INSTANCE }, sessionId: 'app-session-1' });
  assert.equal(requested.ok, true, requested.message);
  assert.equal(pair.manager.join.pendingRequestsOf(COLLAB).some((record) => record.sessionId === 'app-session-1'), true, '站长侧收到申请');

  const approved = await pair.manager.join.approveJoin({ collabId: COLLAB, managerSessionId: MANAGER_SESSION, sessionId: 'app-session-1', approve: true });
  assert.equal(approved.ok, true, approved.message);
  assert.equal(deliveredOf(pair.managerSent, 'invite').length, 1, '冷启动申请先补指名邀请（对方据此建本地记录）');
  assert.equal(pair.manager.local.ledger.members.every((row) => row.state === 'member'), true, '批准前不把 invited 行写进 active-only 名单');
  assert.equal(isLedgerShape(pair.manager.local.ledger), true, '共享名单形态在批准过程中保持合法（重启可读回）');
  await waitFor(() => pair.manager.local.ledger.members.some((row) => row.sessionId === 'app-session-1' && row.state === 'member') ? true : null, { timeoutMs: 3000 });
  assertBothSeatedOf(pair);
});

test('冷启动记录形态：合法 session-seats 载体＋成员记录可读回；重启判档不落 legacy、不写归档标记', async (t) => {
  const applicant = applicantHarnessOf(t);
  applicant.state.joinApplications.add({
    collabId: COLLAB, sessionId: 'app-session-1', managerInstanceId: MANAGER_INSTANCE, msgId: 'apply-2', sentAt: NOW,
    managerAddress: '127.0.0.1', managerPort: 17321,
  });
  const result = await applicant.join.handleJoinGrant(joinGrantFrame('join-cold-2'));
  assert.equal(result.ok, true, result.reason);

  const carrier = readJson(carrierFilePath(applicant.dir, COLLAB));
  assert.equal(carrier.format, 'session-seats', '冷启动即落合格载体（不是只有 member.json）');
  assert.equal(carrier.name, COLLAB, '无邀请时以协作标识作占位名称');
  assert.equal(carrier.topic, COLLAB, '主题占位不得为空串');
  assert.equal(Number.isInteger(carrier.version), true);
  assert.equal(typeof carrier.createdAt, 'string');

  const record = readJson(collabFilePath(applicant.dir, COLLAB, MEMBER_FILE_NAME));
  assert.equal(isMemberRecordShape(record), true, '成员记录过形态校验');
  assert.equal(record.topic !== '', true);
  assert.notEqual(loadMember(applicant.dir, COLLAB), null, '重启加载面可读回成员记录');
  assert.equal(classifyCollabDir(collabDir(applicant.dir, COLLAB)).kind, 'session-seats', '目录判档为成员目录');
  assert.equal(isLegacyCollab(collabDir(applicant.dir, COLLAB)), false);
  assert.equal(existsSync(collabFilePath(applicant.dir, COLLAB, MIGRATION_FILE_NAME)), false, '不得写归档标记');
});

test('邀请落点载体：挂起邀请目录写 invite-stub，判档不落 legacy', (t) => {
  const made = makeHarness(t);
  const stubCollab = 'collab-stub-landing';
  const registered = made.join.handleInviteFrame(inviteFrameWithTargetOf('invite-stub-1', stubCollab));
  assert.equal(registered.ok, true, registered.message);
  const carrier = readJson(carrierFilePath(made.dir, stubCollab));
  assert.equal(carrier.format, 'invite-stub');
  assert.equal(carrier.snapshotVersion, 0);
  assert.equal(classifyCollabDir(collabDir(made.dir, stubCollab)).kind, 'invite-stub');
  assert.equal(isLegacyCollab(collabDir(made.dir, stubCollab)), false);
});

test('已入席协作收到重复邀请：invite-stub 不得覆盖/降级既有 session-seats 载体', async (t) => {
  const applicant = applicantHarnessOf(t);
  applicant.state.joinApplications.add({
    collabId: COLLAB, sessionId: 'app-session-1', managerInstanceId: MANAGER_INSTANCE, msgId: 'apply-dup', sentAt: NOW,
    managerAddress: '127.0.0.1', managerPort: 17321,
  });
  const granted = await applicant.join.handleJoinGrant(joinGrantFrame('join-dup-1'));
  assert.equal(granted.ok, true, granted.reason);
  assert.equal(readJson(carrierFilePath(applicant.dir, COLLAB)).format, 'session-seats');
  applicant.join.handleInviteFrame(inviteFrameWithTargetOf('invite-dup-1', COLLAB));
  assert.equal(readJson(carrierFilePath(applicant.dir, COLLAB)).format, 'session-seats', '重复邀请不得把活协作降级成邀请占位');
});

test('收到指名邀请：短码在本机命中多个会话＝拒绝，不回落原 token、不登记挂起', (t) => {
  const made = makeHarness(t);
  made.state.listLocalSeats = () => [{ sessionId: 'abcdef12-one' }, { sessionId: 'abcdef12-two' }];
  const result = made.join.handleInviteFrame(inviteFrameWithTargetOf('invite-amb-1', COLLAB, 'abcdef12'));
  assert.equal(result.ok, false, '歧义必须拒绝');
  assert.match(result.message, /多个会话|歧义/);
  assert.equal(existsSync(pendingInvitesFilePath(made.dir, COLLAB)), false, '拒收不登记挂起邀请');
});

function inviteFrameWithTargetOf(inviteId, collabId, targetSessionId = 'app-session-1') {
  return {
    v: 1, cap: COLLAB_CAPABILITY, type: 'invite', msgId: `inv-${inviteId}`,
    from: { instanceId: 'inst-x', identityName: '主机甲', port: 17321, sessionId: 'mgr-x' },
    collabId, ts: new Date(NOW).toISOString(),
    payload: {
      name: '邀请项目', topic: '主题', mode: 'managed', inviteId,
      targets: [{ instanceId: MANAGER_INSTANCE, targetSessionId }],
      members: [{ instanceId: 'inst-x', sessionId: 'mgr-x', identityName: '主机甲' }],
    },
  };
}

/* 两台机的域级联调：申请人首次接触（无本地记录），帧经用例自建的投递面互投。 */
function coldStartPairOf(t) {
  const managerSent = [];
  const wire = { applicant: null, manager: null };
  const manager = makeHarness(t, { send: managerRouteOf(managerSent, wire) });
  const applicant = applicantHarnessOf(t, {
    send: applicantRouteOf(wire),
    overrides: {
      knownHosts: { lookup: () => ({ address: '127.0.0.1', port: 17321 }), remember: () => {} },
      requestJoinResolve: async () => ({
        ok: true,
        reply: { found: true, collabId: COLLAB, responder: { instanceId: MANAGER_INSTANCE, identityName: '主机甲', address: '127.0.0.1', port: 17321 } },
      }),
    },
  });
  wire.applicant = applicant;
  wire.manager = manager;
  return { manager, applicant, managerSent };
}

function managerRouteOf(sent, wire) {
  return (message) => {
    sent.push(message);
    if (message.type === 'join-grant') {
      const frame = {
        v: 1, cap: COLLAB_CAPABILITY, type: 'join-grant', msgId: `m-${sent.length}`,
        from: { instanceId: MANAGER_INSTANCE, identityName: '主机甲', port: 17321, sessionId: MANAGER_SESSION },
        collabId: message.collabId, ts: new Date(NOW).toISOString(), payload: message.payload,
      };
      queueMicrotask(() => {
        wire.applicant.join.handleJoinGrant(frame).catch(() => {});
      });
    }
    return { ok: true, msgId: `m-${sent.length}` };
  };
}

function applicantRouteOf(wire) {
  return (message) => {
    if (message.type === 'join-request') {
      wire.manager.join.handleJoinRequest({
        v: 1, cap: COLLAB_CAPABILITY, type: 'join-request', msgId: `req-${message.fromSessionId}`,
        from: { instanceId: 'inst-a', identityName: '应用甲', port: 17400 },
        collabId: message.collabId, ts: new Date(NOW).toISOString(), payload: message.payload,
      });
    }
    if (message.type === 'join-confirm') {
      const frame = {
        v: 1, cap: COLLAB_CAPABILITY, type: 'join-confirm', msgId: `cfm-${message.fromSessionId}`,
        from: { instanceId: 'inst-a', identityName: '应用甲', port: 17400, sessionId: message.fromSessionId },
        collabId: message.collabId, ts: new Date(NOW).toISOString(), payload: message.payload,
      };
      queueMicrotask(() => {
        wire.manager.join.handleJoinConfirm(frame).catch(() => {});
      });
    }
    return { ok: true, msgId: `a-${message.type}-${message.fromSessionId}` };
  };
}

function assertBothSeatedOf({ manager, applicant, managerSent }) {
  const applicantLocal = applicant.state.collabs.get(COLLAB);
  assert.ok(applicantLocal !== undefined, '申请人本机已有协作记录');
  assert.equal(applicantLocal.seats.get('app-session-1')?.state, 'member');
  assert.equal(applicantLocal.seats.size, 1);
  assert.equal(manager.local.ledger.members.find((row) => row.sessionId === 'app-session-1').role, 'member');
  assert.equal(deliveredOf(managerSent, 'join-grant').length, 1);
}

/* —— 本机不指名邀请 / 异步注入失败 / 短码 —— */

test('本机不指名邀请：桥注册但未入席的会话也能收到（不只枚举 member 席位）', async (t) => {
  const made = makeHarness(t);
  made.state.self.instanceId = MANAGER_INSTANCE;
  made.state.sessionBridges = new Map([['bridge-session-1', 'bridge-1'], ['already-seated', 'bridge-2']]);
  made.state.listLocalSeats = () => [{ sessionId: 'already-seated', state: 'member' }];
  const created = await made.join.createInvite({ collabId: COLLAB, managerSessionId: MANAGER_SESSION, targetInstanceId: MANAGER_INSTANCE });
  assert.equal(created.ok, true, created.message);
  const targets = made.injected.map((entry) => entry.sessionId).sort();
  assert.deepEqual(targets, ['already-seated', 'bridge-session-1'], '投全部已注册会话（含未入席的桥注册会话）');
  assert.equal(made.injected.every((entry) => entry.frame.type === 'invite'), true);
});

test('异步注入失败：形态类 resolve {ok:false} 视为发送失败，邀请记录撤回、grant 作废', async (t) => {
  const refusedInvite = makeHarness(t);
  refusedInvite.state.self.instanceId = MANAGER_INSTANCE;
  refusedInvite.state.injectLocalSeat = async () => ({ ok: false, reason: 'bad-session' });
  const refused = await refusedInvite.join.createInvite({
    collabId: COLLAB, managerSessionId: MANAGER_SESSION, targetInstanceId: MANAGER_INSTANCE, targetSessionId: 'app-session-1',
  });
  assert.equal(refused.ok, false, '异步拒绝不得被当作已投递');
  assert.match(refused.message, /邀请发送失败：bad-session/);
  assert.equal(readJson(invitesFilePath(refusedInvite.dir, COLLAB)).invites[0].state, 'withdrawn');

  const refusedGrant = makeHarness(t);
  refusedGrant.state.self.instanceId = MANAGER_INSTANCE;
  refusedGrant.state.injectLocalSeat = async () => ({ ok: false, reason: 'gate-rejected' });
  refusedGrant.join.handleJoinRequest(joinRequestFrame('local-applicant', MANAGER_INSTANCE));
  const approved = await refusedGrant.join.approveJoin({
    collabId: COLLAB, managerSessionId: MANAGER_SESSION, sessionId: 'local-applicant', approve: true,
  });
  assert.equal(approved.ok, false);
  assert.equal(approved.reason, 'send-failed');
  assert.deepEqual(readJson(joinsFilePath(refusedGrant.dir, COLLAB))?.pendingJoins ?? [], [], '发送失败即在途 grant 作废');
});

test('短码指名邀请：本机解析成全量标识后投递；站长侧登记匹配同样接受短码；歧义拒绝', async (t) => {
  const localTarget = makeHarness(t);
  localTarget.state.self.instanceId = MANAGER_INSTANCE;
  localTarget.state.listLocalSeats = () => [{ sessionId: 'abcdef12-session', state: 'member' }];
  const created = await localTarget.join.createInvite({
    collabId: COLLAB, managerSessionId: MANAGER_SESSION, targetInstanceId: MANAGER_INSTANCE, targetSessionId: 'abcdef12',
  });
  assert.equal(created.ok, true, created.message);
  assert.equal(localTarget.injected[0].sessionId, 'abcdef12-session', '本机投递按全量标识找桥');
  assert.deepEqual(readJson(invitesFilePath(localTarget.dir, COLLAB)).invites[0].targets, [{ instanceId: MANAGER_INSTANCE, targetSessionId: 'abcdef12-session' }]);

  const remoteTarget = makeHarness(t);
  const remoteInvite = await remoteTarget.join.createInvite({
    collabId: COLLAB, managerSessionId: MANAGER_SESSION, targetInstanceId: 'inst-a', targetSessionId: 'abcdef12',
  });
  const granted = await remoteTarget.join.handleInviteApproval(inviteApprovalFrame(remoteInvite.inviteId, 'abcdef12-session'));
  assert.equal(granted.ok, true, 'approve 的完整标识与邀请记录的短码按同一口径命中');

  const ambiguous = makeHarness(t);
  ambiguous.state.self.instanceId = MANAGER_INSTANCE;
  ambiguous.state.listLocalSeats = () => [{ sessionId: 'abcdef12-one' }, { sessionId: 'abcdef12-two' }];
  const rejected = await ambiguous.join.createInvite({
    collabId: COLLAB, managerSessionId: MANAGER_SESSION, targetInstanceId: MANAGER_INSTANCE, targetSessionId: 'abcdef12',
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.message, /歧义/);

  const pending = makeHarness(t);
  pending.join.registerPendingInvite({
    collabId: COLLAB, inviteId: 'inv-short', fromManager: { instanceId: 'inst-x', sessionId: 'sess-x' },
    targetSessionId: 'abcdef12', expiresAt: NOW + 60000,
  });
  assert.equal(pending.join.pendingInvitesFor({ collabId: COLLAB, sessionId: 'abcdef12-session' }).length, 1, '挂起邀请可见性接受短码');
  assert.deepEqual(pending.join.pendingInvitesFor({ collabId: COLLAB, sessionId: 'other-session' }), []);
});

test('收到 v2 邀请：指名目标取自 targets[]（不得落成不指名），短码按全量标识落盘', async (t) => {
  const made = makeHarness(t);
  made.state.listLocalSeats = () => [{ sessionId: 'abcdef12-session', state: 'member' }];
  const registered = made.join.handleInviteFrame({
    v: 1, cap: COLLAB_CAPABILITY, type: 'invite', msgId: 'inv-v2-1',
    from: { instanceId: 'inst-x', identityName: '主机甲', port: 17321, sessionId: 'mgr-x' },
    collabId: COLLAB, ts: new Date(NOW).toISOString(),
    payload: {
      name: '邀请项目', topic: '', mode: 'managed', inviteId: 'inv-v2-1',
      targets: [{ instanceId: MANAGER_INSTANCE, targetSessionId: 'abcdef12' }],
      members: [{ instanceId: 'inst-x', sessionId: 'mgr-x', identityName: '主机甲' }],
    },
  });
  assert.equal(registered.ok, true, registered.message);
  const saved = readJson(pendingInvitesFilePath(made.dir, COLLAB)).invites;
  assert.equal(saved[0].targetSessionId, 'abcdef12-session', '短码在落盘时解析成全量标识');
  assert.equal(made.join.pendingInvitesFor({ collabId: COLLAB, sessionId: 'abcdef12-session' }).length, 1);
  assert.deepEqual(made.join.pendingInvitesFor({ collabId: COLLAB, sessionId: 'other-session' }), [], '指名邀请不外泄给同机其他会话');
});

/* —— 当前任期 / 归档终态 —— */

test('站长更替：旧 managerTerm 的 grant 不得落地——confirm 回 manager-changed 并作废记录', async (t) => {
  const made = makeHarness(t);
  const approved = await approvedOf(made, 'app-session-1');
  made.local.ledger.managerTerm = 2;
  const denied = await made.join.handleJoinConfirm(joinConfirmFrame(approved.joinId, 'app-session-1'));
  assert.equal(denied.action, 'join-denied');
  assert.equal(denied.reason, 'manager-changed');
  assert.equal(made.local.ledger.members.some((row) => row.sessionId === 'app-session-1' && row.state === 'member'), false, '旧任期的 grant 不得写名单');
  assert.deepEqual(readJson(joinsFilePath(made.dir, COLLAB)).pendingJoins, [], '旧 grant 已作废落盘');
  assert.equal(deliveredOf(made.sent, 'join-deny').at(-1).payload.reason, 'manager-changed');
});

test('归档终态：邀请/批准/入站申请/confirm 一律拒绝（不依赖入站门）', async (t) => {
  const made = makeHarness(t);
  const approved = await approvedOf(made, 'app-session-1');
  const invite = await made.join.createInvite({ collabId: COLLAB, managerSessionId: MANAGER_SESSION, targetInstanceId: 'inst-a', targetSessionId: 'late-invitee' });
  made.local.ledger.status = 'completed';
  const lateApprove = await made.join.handleInviteApproval(inviteApprovalFrame(invite.inviteId, 'late-invitee'));
  assert.equal(lateApprove.ok, false);
  assert.match(lateApprove.message, /已结束/, '终态协作不再处置邀请批准');
  assert.match((await made.join.createInvite({ collabId: COLLAB, managerSessionId: MANAGER_SESSION, targetInstanceId: 'inst-a' })).message, /已结束/);
  assert.match((await made.join.approveJoin({ collabId: COLLAB, managerSessionId: MANAGER_SESSION, sessionId: 'app-session-1', approve: true })).message, /已结束/);
  const inbound = made.join.handleJoinRequest(joinRequestFrame('late-session'));
  assert.equal(inbound.ok, false);
  assert.equal(inbound.reason, 'archived');
  assert.deepEqual(made.join.pendingRequestsOf(COLLAB), [], '终态协作不收待批准申请');
  const denied = await made.join.handleJoinConfirm(joinConfirmFrame(approved.joinId, 'app-session-1'));
  assert.equal(denied.action, 'join-denied');
  assert.equal(denied.reason, 'aborted');
  assert.equal(made.local.ledger.members.some((row) => row.sessionId === 'app-session-1' && row.state === 'member'), false, '终态名单不得再收席位');
});

/* —— 真实邀请链准入（targets 判定） —— */

test('冷启动批准补发的邀请：members 条目带 sessionId/identityName，过真实协议校验与目标机准入', async (t) => {
  const made = makeHarness(t);
  made.join.handleJoinRequest(joinRequestFrame('app-session-1'));
  const approved = await made.join.approveJoin({ collabId: COLLAB, managerSessionId: MANAGER_SESSION, sessionId: 'app-session-1', approve: true });
  assert.equal(approved.ok, true, approved.message);
  const sent = deliveredOf(made.sent, 'invite')[0];
  assert.deepEqual(
    sent.payload.members.map((entry) => ({ instanceId: entry.instanceId, sessionId: entry.sessionId })),
    [{ instanceId: MANAGER_INSTANCE, sessionId: MANAGER_SESSION }, { instanceId: 'inst-a', sessionId: 'app-session-1' }],
    '补席位行带 sessionId（协议名单条目的必填面）',
  );
  const frame = {
    ...sent,
    v: 1, cap: COLLAB_CAPABILITY, msgId: 'invite-cold-1',
    from: { instanceId: MANAGER_INSTANCE, identityName: '主机甲', port: 17321, sessionId: MANAGER_SESSION },
    ts: new Date(NOW).toISOString(),
  };
  assert.equal(validateMessage(frame).ok, true, '协议层校验通过（缺 sessionId 会被整帧拒收）');
  assert.equal(decideAdmission(gateStateOf('inst-a'), frame, { remoteAddress: '127.0.0.1' }).ok, true);
});

test('真实邀请链：createInvite 的帧按 targets 通过目标机准入（受邀会话不必在 members 内）', async (t) => {
  const made = makeHarness(t);
  const created = await made.join.createInvite({
    collabId: COLLAB, managerSessionId: MANAGER_SESSION, targetInstanceId: 'inst-member', targetSessionId: 'member-session-1',
  });
  assert.equal(created.ok, true, created.message);
  const sent = deliveredOf(made.sent, 'invite')[0];
  assert.deepEqual(sent.payload.members.map((entry) => entry.instanceId), [MANAGER_INSTANCE], '名单只含发起方');
  const frame = {
    ...sent,
    v: 1, cap: COLLAB_CAPABILITY, msgId: 'invite-real-1',
    from: { instanceId: MANAGER_INSTANCE, identityName: '主机甲', port: 17321, sessionId: MANAGER_SESSION },
    ts: new Date(NOW).toISOString(),
  };
  const target = gateStateOf('inst-member');
  assert.equal(decideAdmission(target, frame, { remoteAddress: '127.0.0.1' }).ok, true, 'targets 含本机即准入');
  const stranger = gateStateOf('inst-other');
  assert.equal(decideAdmission(stranger, frame, { remoteAddress: '127.0.0.1' }).ok, false, 'targets 不含本机即拒收');
});

function gateStateOf(selfInstanceId) {
  return {
    self: { instanceId: selfInstanceId, identityName: '目标机' },
    collabs: new Map(),
    counters: { invitesRejected: 0, unknownCollab: 0 },
    inviteWindow: new Map(),
    inviteMinIntervalMs: 0,
  };
}

/* —— 论坛接线后的本机席位 —— */

test('论坛在席加入：接线成功即补本机席位（member、默认静音），已有席位不覆盖角色', async (t) => {
  const made = makeHarness(t);
  const bindings = new Map();
  made.state.bindings = { set: (collabId, entry) => bindings.set(collabId, entry) };
  made.state.bridgeIdOf = (sessionId) => `bridge-${sessionId}`;
  const forum = {
    collabId: COLLAB,
    role: 'member',
    ledger: null,
    member: {
      collabId: COLLAB, role: 'member', state: 'active', name: '讨论甲', topic: '', mode: 'forum',
      manager: { instanceId: MANAGER_INSTANCE, identityName: '主机甲' },
      roster: [{ instanceId: MANAGER_INSTANCE, identityName: '主机甲' }], endpoints: {}, decision: 'approved',
    },
    endpoints: new Map(),
    snapshot: null,
    seats: new Map([[MANAGER_SESSION, seat(MANAGER_SESSION, 'manager')]]),
    /* 讨论成员粒度＝会话：本会话须有自己的 join 事件才走「已在席」直连分支。 */
    members: { includes: () => true, fold: () => [{ instanceId: MANAGER_INSTANCE, sessionId: 'forum-session-1' }] },
    suspended: null,
  };
  made.state.collabs.set(COLLAB, forum);
  const joined = await made.join.request({ collabId: COLLAB, sessionId: 'forum-session-1' });
  assert.equal(joined.ok, true, joined.message);
  assert.equal(bindings.has(COLLAB), true, '接线已落地');
  const created = forum.seats.get('forum-session-1');
  assert.ok(created !== undefined, '已加入的论坛会话拥有本机席位');
  assert.equal(created.role, 'member');
  assert.equal(created.muted, true, '默认静音写席位，不写退役 mute.json');
  assert.equal(forum.seats.get(MANAGER_SESSION).role, 'manager', '已有席位（发起人）不被覆盖');
});

/* —— C-3：确认/接受两段式的丢帧重试与超时回滚 —— */

function mutableClockAt(start = NOW) {
  const ref = { value: start };
  return { ref, now: () => ref.value };
}

function applicantWithClock(t, clock) {
  return applicantHarnessOf(t, { overrides: { clock: clock.now } });
}

async function grantedApplicantOf(t, { joinId = 'join-retry-1', clock = mutableClockAt() } = {}) {
  const applicant = applicantWithClock(t, clock);
  applicant.state.joinApplications.add({
    collabId: COLLAB, sessionId: 'app-session-1', managerInstanceId: MANAGER_INSTANCE, msgId: `apply-${joinId}`, sentAt: NOW,
    managerAddress: '127.0.0.1', managerPort: 17321,
  });
  const result = await applicant.join.handleJoinGrant(joinGrantFrame(joinId));
  assert.equal(result.ok, true, result.reason);
  return applicant;
}

test('C-3 join-confirm 丢帧：按 joinConfirmTtlMs/3 重发，快照清除 unverified 后停轮', async (t) => {
  const clock = mutableClockAt();
  const applicant = await grantedApplicantOf(t, { joinId: 'join-retry-1', clock });
  assert.equal(deliveredOf(applicant.sent, 'join-confirm').length, 1, '首帧已发');

  clock.ref.value += 20000;   // joinConfirmTtlMs 60000 / 3
  const retried = await applicant.join.retryPendingConfirms();
  assert.deepEqual(retried, { retried: 1, rolledBack: 0 });
  const confirms = deliveredOf(applicant.sent, 'join-confirm');
  assert.equal(confirms.length, 2, '重发轮续发 confirm');
  assert.equal(confirms[1].payload.joinId, 'join-retry-1');
  assert.equal(confirms[1].fromSessionId, 'app-session-1');
  assert.equal(confirms[1].to.instanceId, MANAGER_INSTANCE);
  assert.deepEqual(confirms[1].toSessions, [MANAGER_SESSION], '重发仍指名站长会话');

  applicant.state.collabs.get(COLLAB).seats.get('app-session-1').unverified = false;
  clock.ref.value += 20000;
  const stopped = await applicant.join.retryPendingConfirms();
  assert.deepEqual(stopped, { retried: 0, rolledBack: 0 });
  assert.equal(deliveredOf(applicant.sent, 'join-confirm').length, 2, '含本席快照到达后不再重发');
});

test('C-3 确认重发轮由定时器自行推进（无需外部调用）', async (t) => {
  const applicant = applicantHarnessOf(t, { overrides: { config: { joinConfirmTtlMs: 60 }, clock: () => NOW } });
  applicant.state.joinApplications.add({
    collabId: COLLAB, sessionId: 'app-session-1', managerInstanceId: MANAGER_INSTANCE, msgId: 'apply-timer', sentAt: NOW,
    managerAddress: '127.0.0.1', managerPort: 17321,
  });
  assert.equal((await applicant.join.handleJoinGrant(joinGrantFrame('join-timer-1'))).ok, true);
  await waitFor(() => deliveredOf(applicant.sent, 'join-confirm').length >= 2 ? true : null, { timeoutMs: 3000 });
  assert.equal(deliveredOf(applicant.sent, 'join-confirm')[1].payload.joinId, 'join-timer-1');
  applicant.state.collabs.get(COLLAB).seats.get('app-session-1').unverified = false;
  await new Promise((resolve) => setTimeout(resolve, 80));   // 下一拍观察到已收敛即停轮
});

test('C-3 join-confirm 超时：grant 过期后停止重发，宽限期满回滚未确认席位并提示', async (t) => {
  const clock = mutableClockAt();
  const notices = [];
  const applicant = applicantWithClock(t, clock);
  applicant.state.notify = (frame) => {
    notices.push(frame);
    return true;
  };
  applicant.state.joinApplications.add({
    collabId: COLLAB, sessionId: 'app-session-1', managerInstanceId: MANAGER_INSTANCE, msgId: 'apply-retry-timeout', sentAt: NOW,
    managerAddress: '127.0.0.1', managerPort: 17321,
  });
  assert.equal((await applicant.join.handleJoinGrant(joinGrantFrame('join-timeout-1'))).ok, true);

  clock.ref.value += 60000;   // grant 过期
  const holding = await applicant.join.retryPendingConfirms();
  assert.deepEqual(holding, { retried: 0, rolledBack: 0 }, '过期后不再发帧，只等宽限');
  assert.equal(deliveredOf(applicant.sent, 'join-confirm').length, 1, '过期后不重发');
  assert.equal(applicant.state.collabs.get(COLLAB).seats.has('app-session-1'), true, '宽限期内席位仍在（防幽灵席位误回滚）');

  clock.ref.value += 300000;   // sessionSeatTimeoutMs 宽限期满
  const rolled = await applicant.join.retryPendingConfirms();
  assert.deepEqual(rolled, { retried: 0, rolledBack: 1 });
  assert.equal(applicant.state.collabs.get(COLLAB).seats.has('app-session-1'), false, '未确认席位已回滚');
  assert.match(notices.at(-1)?.payload?.text ?? '', /入席未确认/, '回滚是可见的失败路径（定向提示）');
});

test('C-3 受邀接受重试：未成席重发 approve；成席后只回幂等不重复发帧', async (t) => {
  const applicant = applicantHarnessOf(t, {
    overrides: { knownHosts: { lookup: () => ({ address: '127.0.0.1', port: 18002 }), remember: () => {} } },
  });
  applicant.join.registerPendingInvite({
    collabId: COLLAB, inviteId: 'inv-resend-1',
    fromManager: { instanceId: MANAGER_INSTANCE, sessionId: MANAGER_SESSION },
    targetSessionId: 'app-session-1', expiresAt: NOW + 60000,
  });
  const first = await applicant.join.acceptInvite({ collabId: COLLAB, inviteId: 'inv-resend-1', sessionId: 'app-session-1' });
  assert.equal(first.ok, true, first.message);
  const again = await applicant.join.acceptInvite({ collabId: COLLAB, inviteId: 'inv-resend-1', sessionId: 'app-session-1' });
  assert.equal(again.ok, true, again.message);
  assert.equal(again.idempotent, true);
  assert.equal(again.resent, true, '未成席的重复接受必须重发 approve');
  const approves = deliveredOf(applicant.sent, 'approve');
  assert.equal(approves.length, 2);
  assert.equal(approves[1].payload.inviteId, 'inv-resend-1');
  assert.equal(approves[1].fromSessionId, 'app-session-1');

  applicant.state.collabs.set(COLLAB, {
    collabId: COLLAB,
    role: 'member',
    ledger: null,
    member: { collabId: COLLAB, role: 'member', state: 'active', name: '受邀项目', topic: '主题', mode: 'managed' },
    endpoints: new Map(),
    snapshot: null,
    seats: new Map([['app-session-1', seat('app-session-1')]]),
    suspended: null,
  });
  const seated = await applicant.join.acceptInvite({ collabId: COLLAB, inviteId: 'inv-resend-1', sessionId: 'app-session-1' });
  assert.equal(seated.ok, true);
  assert.equal(seated.idempotent, true);
  assert.equal(seated.resent, undefined, '已成席不再发 approve');
  assert.equal(deliveredOf(applicant.sent, 'approve').length, 2);
});

test('C-3 受邀接受重试：邀请过期后不再重发 approve（如实报过期）', async (t) => {
  const clock = mutableClockAt();
  const applicant = applicantHarnessOf(t, {
    overrides: {
      clock: clock.now,
      knownHosts: { lookup: () => ({ address: '127.0.0.1', port: 18002 }), remember: () => {} },
    },
  });
  applicant.join.registerPendingInvite({
    collabId: COLLAB, inviteId: 'inv-resend-expired',
    fromManager: { instanceId: MANAGER_INSTANCE, sessionId: MANAGER_SESSION },
    targetSessionId: 'app-session-1', expiresAt: NOW + 1000,
  });
  assert.equal((await applicant.join.acceptInvite({ collabId: COLLAB, inviteId: 'inv-resend-expired', sessionId: 'app-session-1' })).ok, true);
  clock.ref.value += 2000;
  const late = await applicant.join.acceptInvite({ collabId: COLLAB, inviteId: 'inv-resend-expired', sessionId: 'app-session-1' });
  assert.equal(late.ok, false);
  assert.equal(late.reason, 'expired');
  assert.equal(deliveredOf(applicant.sent, 'approve').length, 1, '过期后不重发');
});

test('C-3 同机接受：两段式发送失败不消费挂起邀请，恢复后可重试成功', async (t) => {
  const made = makeHarness(t);
  made.state.self.instanceId = MANAGER_INSTANCE;
  const invited = await made.join.createInvite({
    collabId: COLLAB, managerSessionId: MANAGER_SESSION, targetInstanceId: MANAGER_INSTANCE, targetSessionId: 'app-session-1',
  });
  assert.equal(invited.ok, true, invited.message);

  const originalInject = made.state.injectLocalSeat;
  made.state.injectLocalSeat = async () => ({ ok: false, reason: 'gate-rejected' });
  const failed = await made.join.acceptInvite({ collabId: COLLAB, inviteId: invited.inviteId, sessionId: 'app-session-1' });
  assert.equal(failed.ok, false);
  assert.equal(made.join.pendingInvitesFor({ collabId: COLLAB, sessionId: 'app-session-1' }).length, 1, '失败保留挂起邀请');
  assert.equal(readJson(invitesFilePath(made.dir, COLLAB)).invites[0].state, 'open', '邀请记录仍可重试');

  made.state.injectLocalSeat = originalInject;
  const retried = await made.join.acceptInvite({ collabId: COLLAB, inviteId: invited.inviteId, sessionId: 'app-session-1' });
  assert.equal(retried.ok, true, retried.message);
  assert.equal(retried.accepted, true);
  assert.equal(retried.joining, true, '重试后 grant 重新签发');
  assert.equal(made.join.pendingInvitesFor({ collabId: COLLAB, sessionId: 'app-session-1' }).length, 0);
  assert.equal(readJson(pendingInvitesFilePath(made.dir, COLLAB)).invites[0].state, 'consumed', '成功后才消费');
});

test('I-10 成员判定只认共享名单：本地席位在但名单不含该席时不得短路成 alreadyMember', async (t) => {
  const made = makeHarness(t);
  made.state.self.instanceId = MANAGER_INSTANCE;
  made.local.seats.set('app-session-1', seat('app-session-1'));
  const invite = await made.join.createInvite({
    collabId: COLLAB, managerSessionId: MANAGER_SESSION, targetInstanceId: MANAGER_INSTANCE, targetSessionId: 'app-session-1',
  });
  assert.equal(invite.ok, true, invite.message);
  const granted = await made.join.handleInviteApproval(inviteApprovalFrame(invite.inviteId, 'app-session-1', MANAGER_INSTANCE));
  assert.equal(granted.ok, true, granted.message);
  assert.equal(granted.joining, true, '名单没有该席：照常签发 grant，不得因本地席位文件短路');
  assert.equal(granted.alreadyMember, undefined);
  assert.equal(made.local.ledger.members.some((row) => row.sessionId === 'app-session-1'), false, '确认前不写名单');

  const confirmed = await made.join.handleJoinConfirm(joinConfirmFrame(granted.joinId, 'app-session-1', MANAGER_INSTANCE));
  assert.equal(confirmed.action, 'join-confirmed');
  assert.equal(
    made.local.ledger.members.some((row) => row.sessionId === 'app-session-1' && row.state === 'member'),
    true,
    'confirm 后以共享名单为准入席',
  );
});

test('M-7 讨论旧成员事件：折叠保持实例级并标注来源，不按最近会话伪造席位键', () => {
  const local = {
    members: {
      fold: () => [{ instanceId: 'inst-old', identityName: '旧机' }],
      latestEventOf: () => ({ sessionId: 'sess-recent' }),
    },
  };
  const rows = foldedMembersOf(local);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].instanceId, 'inst-old');
  assert.equal(rows[0].sessionId, null, '旧事件不补最近会话的席位键');
  assert.equal(rows[0].seatScope, 'instance', '显式标注实例级来源');
});

function resumeFixtureOf(t) {
  const dir = makeTempDir(t);
  const made = quietLog();
  const local = {
    collabId: COLLAB,
    role: 'member',
    ledger: null,
    member: { collabId: COLLAB, role: 'member', state: 'active', name: '续发项目', topic: '主题', mode: 'managed' },
    endpoints: new Map(),
    snapshot: null,
    seats: new Map([['app-session-1', {
      version: 1, sessionId: 'app-session-1', role: 'member', state: 'member', muted: true,
      unverified: true, joinId: 'join-resume-1', grantVersion: 3, joinedAt: new Date(NOW).toISOString(),
    }]]),
    suspended: null,
  };
  mkdirSync(dirname(carrierFilePath(dir, COLLAB)), { recursive: true });
  writeFileSync(carrierFilePath(dir, COLLAB), JSON.stringify({
    format: 'session-seats', version: 1, collabId: COLLAB, name: '续发项目', topic: '主题', mode: 'managed',
    endpoints: {},
    manager: { instanceId: MANAGER_INSTANCE, sessionId: MANAGER_SESSION, identityName: '主机甲', term: 2 },
    snapshotVersion: 0, createdAt: new Date(NOW).toISOString(),
  }));
  return { dir, made, local };
}

function resumeJoinOf({ dir, made, local }) {
  const sent = [];
  const state = {
    dataDir: dir,
    config: { inviteTtlMs: 60000, pendingInvitesMax: 4, joinConfirmTtlMs: 60000, sessionSeatTimeoutMs: 300000 },
    self: { instanceId: 'inst-a', identityName: '应用甲', port: 17400 },
    collabs: new Map([[COLLAB, local]]),
    knownHosts: { lookup: () => ({ address: '127.0.0.1', port: 18001 }), remember: () => {} },
    log: made.log,
    notify: () => true,
    injectLocalSeat: async () => ({ ok: true, delivered: true }),
    listLocalSeats: () => [],
    joinApplications: createJoinApplicationsStore({ dataDir: dir, log: made.log }),
    counters: { persistFailures: 0 },
    clock: () => NOW,
    joinRequestRetryMs: 3600000,
  };
  const join = createJoinDomain({
    state,
    send: (message) => {
      sent.push(message);
      return { ok: true, msgId: `resume-${sent.length}` };
    },
    openViewer: null,
    log: made.log,
    now: state.clock,
  });
  return { join, sent };
}

test('C-3 重启恢复：未确认席位按载体里的站长席位续发 join-confirm', async (t) => {
  const { join, sent } = resumeJoinOf(resumeFixtureOf(t));
  const result = await join.retryPendingConfirms();
  assert.deepEqual(result, { retried: 1, rolledBack: 0 });
  const confirm = sent.find((message) => message.type === 'join-confirm');
  assert.ok(confirm !== undefined, '重启后恢复重发轮');
  assert.equal(confirm.payload.joinId, 'join-resume-1');
  assert.equal(confirm.payload.managerTerm, 2, '站长任期取自载体（本地记录无台账）');
  assert.equal(confirm.payload.version, 3, 'grantVersion 取自席位文件');
  assert.equal(confirm.to.instanceId, MANAGER_INSTANCE);
  assert.deepEqual(confirm.toSessions, [MANAGER_SESSION]);
  assert.equal(confirm.fromSessionId, 'app-session-1');
});

/* —— I-2：撤回/拒绝闭环 —— */

test('撤回：关联在途 joining 作废并回 join-deny，目标端收到携 inviteId 的 withdraw 帧', async (t) => {
  const made = makeHarness(t);
  const invite = await made.join.createInvite({
    collabId: COLLAB, managerSessionId: MANAGER_SESSION, targetInstanceId: 'inst-a', targetSessionId: 'app-session-1',
  });
  assert.equal(invite.ok, true, invite.message);
  made.join.handleJoinRequest(joinRequestFrame('app-session-1'));
  const approved = await made.join.approveJoin({ collabId: COLLAB, managerSessionId: MANAGER_SESSION, sessionId: 'app-session-1', approve: true });
  assert.equal(approved.ok, true, approved.message);
  assert.equal(made.join.pendingJoiningProjection(COLLAB).length, 1, 'grant 已签发、待确认');

  const withdrawn = made.join.withdrawInvite({ collabId: COLLAB, managerSessionId: MANAGER_SESSION, inviteId: invite.inviteId });
  assert.equal(withdrawn.ok, true, withdrawn.message);
  assert.equal(withdrawn.joiningsAborted, 1, '撤回按邀请目标中止在途 grant');
  assert.deepEqual(made.join.pendingJoiningProjection(COLLAB), [], '撤回后在途入席不再存在');
  await waitFor(() => made.sent.some((frame) => frame.type === 'join-deny' && frame.payload?.joinId === approved.joinId) ? true : null, { timeoutMs: 1000 });
  await waitFor(() => made.sent.some((frame) => frame.type === 'withdraw' && frame.payload?.inviteId === invite.inviteId) ? true : null, { timeoutMs: 1000 });
  const declineFrame = made.sent.find((frame) => frame.type === 'withdraw');
  assert.equal(declineFrame.payload.scope, 'single');
  assert.equal(declineFrame.toSessions[0], 'app-session-1');
  assert.equal(readJson(invitesFilePath(made.dir, COLLAB)).invites.find((record) => record.inviteId === invite.inviteId).state, 'withdrawn');
});

test('拒绝帧：发起侧按 inviteId 关闭指名邀请记录（不再只计数）', async (t) => {
  const made = makeHarness(t);
  const invite = await made.join.createInvite({
    collabId: COLLAB, managerSessionId: MANAGER_SESSION, targetInstanceId: 'inst-a', targetSessionId: 'app-session-1',
  });
  assert.equal(invite.ok, true, invite.message);
  const declined = made.join.handleInviteDecline({
    v: 1, cap: COLLAB_CAPABILITY, type: 'decline', msgId: 'decline-1', collabId: COLLAB,
    from: { instanceId: 'inst-a', identityName: '应用甲', sessionId: 'app-session-1' },
    payload: { inviteId: invite.inviteId },
  });
  assert.equal(declined.ok, true, JSON.stringify(declined));
  assert.equal(declined.declined, true);
  const record = readJson(invitesFilePath(made.dir, COLLAB)).invites.find((entry) => entry.inviteId === invite.inviteId);
  assert.equal(record.state, 'closed', '指名邀请在拒绝后关闭（open 记录不得残留）');
});

test('终态拒绝回执（N-3）：已撤回 / 已过期邀请的 approve 回 join-deny（携目标会话）', async (t) => {
  const made = makeHarness(t);
  const invite = await made.join.createInvite({
    collabId: COLLAB, managerSessionId: MANAGER_SESSION, targetInstanceId: 'inst-a', targetSessionId: 'app-session-1',
  });
  assert.equal(invite.ok, true, invite.message);
  assert.equal(made.join.withdrawInvite({ collabId: COLLAB, managerSessionId: MANAGER_SESSION, inviteId: invite.inviteId }).ok, true);
  made.sent.length = 0;
  const rejected = await made.join.handleInviteApproval(inviteApprovalFrame(invite.inviteId, 'app-session-1'));
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'withdrawn');
  await waitFor(() => deliveredOf(made.sent, 'join-deny').length > 0 ? true : null, { timeoutMs: 1000 });
  const deny = deliveredOf(made.sent, 'join-deny').at(-1);
  assert.equal(deny.payload.sessionId, 'app-session-1', '回执指名到申请会话（目标端据此回滚申请）');
  assert.equal(deny.payload.joinId, invite.inviteId, '无在途 grant 时以 inviteId 兜底定位');
  assert.equal(deny.payload.reason, 'aborted');
  assert.equal(deny.to.instanceId, 'inst-a');
  assert.deepEqual(deny.toSessions, ['app-session-1']);

  const expiring = makeHarness(t, { config: { inviteTtlMs: 1000 } });
  const late = await expiring.join.createInvite({
    collabId: COLLAB, managerSessionId: MANAGER_SESSION, targetInstanceId: 'inst-a', targetSessionId: 'app-session-1',
  });
  expiring.clock.value += 2000;
  expiring.sent.length = 0;
  const expired = await expiring.join.handleInviteApproval(inviteApprovalFrame(late.inviteId, 'app-session-1'));
  assert.equal(expired.ok, false);
  assert.equal(expired.reason, 'expired');
  await waitFor(() => deliveredOf(expiring.sent, 'join-deny').length > 0 ? true : null, { timeoutMs: 1000 });
  assert.equal(deliveredOf(expiring.sent, 'join-deny').at(-1).payload.reason, 'expired');
});

test('重复 approve：邀请 TTL 在 grant 窗口内到期时仍续发同一 grant，不回终态拒绝', async (t) => {
  const made = makeHarness(t, { config: { inviteTtlMs: 1000 } });
  const invite = await made.join.createInvite({
    collabId: COLLAB, managerSessionId: MANAGER_SESSION, targetInstanceId: 'inst-a', targetSessionId: 'app-session-1',
  });
  const granted = await made.join.handleInviteApproval(inviteApprovalFrame(invite.inviteId, 'app-session-1'));
  assert.equal(granted.ok, true, granted.message);
  assert.equal(granted.joining, true);
  made.advance(2000);
  made.sent.length = 0;
  const again = await made.join.handleInviteApproval(inviteApprovalFrame(invite.inviteId, 'app-session-1'));
  assert.equal(again.ok, true, '在途 grant 有效时重复 approve 幂等成功');
  assert.equal(again.joinId, granted.joinId, '续发同一 joinId，不重开在途记录');
  assert.equal(deliveredOf(made.sent, 'join-grant').length, 1, '回执是续发的 join-grant');
  assert.equal(deliveredOf(made.sent, 'join-deny').length, 0, '在途 grant 不得被打回终态拒绝');
  const confirmed = await made.join.handleJoinConfirm(joinConfirmFrame(granted.joinId, 'app-session-1'));
  assert.equal(confirmed.action, 'join-confirmed', '续发后 confirm 仍可入名单');
});

test('重复 approve：名单已含本席时幂等成功，不回终态拒绝也不重复入名单', async (t) => {
  const made = makeHarness(t);
  const invite = await made.join.createInvite({
    collabId: COLLAB, managerSessionId: MANAGER_SESSION, targetInstanceId: 'inst-a', targetSessionId: 'app-session-1',
  });
  const granted = await made.join.handleInviteApproval(inviteApprovalFrame(invite.inviteId, 'app-session-1'));
  assert.equal((await made.join.handleJoinConfirm(joinConfirmFrame(granted.joinId, 'app-session-1'))).action, 'join-confirmed');
  made.sent.length = 0;
  const again = await made.join.handleInviteApproval(inviteApprovalFrame(invite.inviteId, 'app-session-1'));
  assert.equal(again.ok, true, '已入名单按幂等成功处置');
  assert.equal(again.member, true);
  assert.equal(again.alreadyMember, true);
  assert.equal(deliveredOf(made.sent, 'join-deny').length, 0, '已成立的席位不得被误拒');
  assert.equal(
    made.local.ledger.members.filter((entry) => entry.sessionId === 'app-session-1').length,
    1,
    '名单不重复登记',
  );
});

test('目标端撤回：挂起邀请置 withdrawn 并停投', async (t) => {
  const made = makeHarness(t);
  const invite = await made.join.createInvite({
    collabId: COLLAB, managerSessionId: MANAGER_SESSION, targetInstanceId: MANAGER_INSTANCE, targetSessionId: 'app-session-1',
  });
  assert.equal(invite.ok, true, invite.message);
  assert.equal(readJson(pendingInvitesFilePath(made.dir, COLLAB)).invites[0].state, 'open');
  const withdrawn = made.join.withdrawPendingInvite({ collabId: COLLAB, inviteId: invite.inviteId });
  assert.equal(withdrawn.ok, true, JSON.stringify(withdrawn));
  assert.equal(withdrawn.withdrawn, 1);
  assert.equal(readJson(pendingInvitesFilePath(made.dir, COLLAB)).invites[0].state, 'withdrawn');
  assert.deepEqual(made.join.pendingInvitesFor({ collabId: COLLAB, sessionId: 'app-session-1' }), []);
});

test('站长更替作废（D5）：关闭该协作的 open 邀请并清空待批准申请', async (t) => {
  const made = makeHarness(t);
  const invite = await made.join.createInvite({
    collabId: COLLAB, managerSessionId: MANAGER_SESSION, targetInstanceId: 'inst-a', targetSessionId: 'app-session-1',
  });
  assert.equal(invite.ok, true, invite.message);
  made.join.handleJoinRequest(joinRequestFrame('app-session-1'));
  assert.equal(made.join.pendingJoinsOf(COLLAB).length, 1, '待批准申请在册');

  const invalidated = made.join.invalidateInvitesForManagerChange(COLLAB);
  assert.equal(invalidated.withdrawn, 1, '旧站长的 open 邀请作废');
  assert.equal(invalidated.clearedRequests, 1, '待批准申请同步清空');
  assert.equal(made.join.pendingJoinsOf(COLLAB).length, 0);
  const record = readJson(invitesFilePath(made.dir, COLLAB)).invites.find((entry) => entry.inviteId === invite.inviteId);
  assert.equal(record.state, 'withdrawn');
});
