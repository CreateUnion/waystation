import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createJoinDomain } from '../src/collab/join.js';
import { createJoinApplicationsStore } from '../src/collab/joins.js';
import { COLLAB_CAPABILITY, MAX_ACTIVE_SEATS } from '../src/net/protocol.js';
import { invitesFilePath, pendingInvitesFilePath, joinsFilePath } from '../src/paths.js';
import { makeTempDir } from './helpers.js';

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

test('createInvite：生成 inviteId、invites.json 落设计形态；邀请帧携 inviteId/targets/席位名单与 fromSessionId', (t) => {
  const made = makeHarness(t);
  const created = made.join.createInvite({
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

test('createInvite：投递失败＝撤回记录（不留未投递的 open 邀请）', (t) => {
  const made = makeHarness(t, { send: () => ({ ok: false, reason: '对方不可达' }) });
  const created = made.join.createInvite({ collabId: COLLAB, managerSessionId: MANAGER_SESSION, targetInstanceId: 'inst-a' });
  assert.equal(created.ok, false);
  assert.match(created.message, /邀请发送失败/);
  const invites = readJson(invitesFilePath(made.dir, COLLAB));
  assert.equal(invites.invites[0].state, 'withdrawn');
});

test('createInvite：讨论不生成 inviteId（D18）；非站长会话/满载/坏目标如实拒', (t) => {
  const made = makeHarness(t);
  made.local.ledger.mode = 'forum';
  const forum = made.join.createInvite({ collabId: COLLAB, managerSessionId: MANAGER_SESSION, targetInstanceId: 'inst-a' });
  assert.equal(forum.ok, false);
  assert.equal(forum.code, 'forum-no-invite');
  assert.equal(existsSync(invitesFilePath(made.dir, COLLAB)), false, 'forum 不写 invites.json');

  const fresh = makeHarness(t);
  assert.match(fresh.join.createInvite({ collabId: COLLAB, managerSessionId: 'not-manager', targetInstanceId: 'inst-a' }).message, /站长/);
  assert.match(fresh.join.createInvite({ collabId: COLLAB, managerSessionId: MANAGER_SESSION, targetInstanceId: 'bad id!' }).message, /目标非法/);

  const full = makeHarness(t, { ledger: ledgerWith(fullRosterSeats()) });
  const refused = full.join.createInvite({ collabId: COLLAB, managerSessionId: MANAGER_SESSION, targetInstanceId: 'inst-a' });
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

test('pending-invites：登记/补投匹配；指名邀请只对目标会话可见，接受后 consumed', (t) => {
  const made = makeHarness(t);
  const applied = made.join.registerPendingInvite({
    collabId: COLLAB, inviteId: 'inv-target-1',
    fromManager: { instanceId: 'inst-remote-manager', sessionId: 'remote-mgr' },
    targetSessionId: 'app-session-1', expiresAt: NOW + 60000,
  });
  assert.equal(applied.ok, true, applied.message);
  assert.equal(made.join.pendingInvitesFor({ collabId: COLLAB, sessionId: 'app-session-1' }).length, 1);
  assert.deepEqual(made.join.pendingInvitesFor({ collabId: COLLAB, sessionId: 'app-session-2' }), [], '指名不外泄给同机其他会话');
  const accepted = made.join.acceptInvite({ collabId: COLLAB, inviteId: 'inv-target-1', sessionId: 'app-session-1' });
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

test('pending-invites：不指名邀请多席各自接受；首个接受不消费整条；同会话重复接受幂等', (t) => {
  const made = makeHarness(t);
  made.join.registerPendingInvite({
    collabId: COLLAB, inviteId: 'inv-open-1',
    fromManager: { instanceId: 'inst-remote-manager', sessionId: 'remote-mgr' },
    expiresAt: NOW + 60000,
  });
  for (const sessionId of ['app-session-1', 'app-session-2', 'app-session-1']) {
    const accepted = made.join.acceptInvite({ collabId: COLLAB, inviteId: 'inv-open-1', sessionId });
    assert.equal(accepted.ok, true, accepted.message);
  }
  const pending = readJson(pendingInvitesFilePath(made.dir, COLLAB));
  assert.equal(pending.invites[0].state, 'open', '不指名邀请保持 open（多席）');
  assert.deepEqual(pending.invites[0].acceptedSessions, ['app-session-1', 'app-session-2'], '同一会话只登记一次');
  assert.equal(deliveredOf(made.sent, 'approve').length, 2, '重复接受幂等短路：不再发第二次 approve');
});

test('pending-invites：过期/未知/形态坏一律拒；接受未过期邀请后过期重放不再受理', (t) => {
  const made = makeHarness(t);
  assert.equal(made.join.acceptInvite({ collabId: COLLAB, inviteId: 'inv-ghost', sessionId: 'app-session-1' }).ok, false);
  assert.match(made.join.registerPendingInvite({
    collabId: COLLAB, inviteId: 'inv-expired', fromManager: { instanceId: 'inst-x', sessionId: 'sess-x' }, expiresAt: NOW - 1,
  }).message, /过期|expired/);
  made.join.registerPendingInvite({
    collabId: COLLAB, inviteId: 'inv-live', fromManager: { instanceId: 'inst-x', sessionId: 'sess-x' }, expiresAt: NOW + 1000,
  });
  made.advance(2000);
  const late = made.join.acceptInvite({ collabId: COLLAB, inviteId: 'inv-live', sessionId: 'app-session-1' });
  assert.equal(late.ok, false);
  assert.match(late.message, /过期/);
});

/* —— 站长侧两段式：approveJoin → joinId → confirm → 名单提交 —— */

test('approveJoin：写 joining（joins.json v2 仅未确认）＋发 join-grant（joinId/manager/term/version/fromSessionId）', (t) => {
  const made = makeHarness(t);
  made.join.handleJoinRequest(joinRequestFrame('app-session-1'));
  const approved = made.join.approveJoin({ collabId: COLLAB, managerSessionId: MANAGER_SESSION, sessionId: 'app-session-1', approve: true });
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
  assert.equal(grant.payload.version, 1);
});

test('confirm：先 confirmJoining、再写共享名单；成功后 joins.json 清空、名单分配 joinSeq 并推快照', (t) => {
  const made = makeHarness(t);
  const approved = approvedOf(made, 'app-session-1');
  const confirmed = made.join.handleJoinConfirm(joinConfirmFrame(approved.joinId, 'app-session-1'));
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
  assert.equal(snapshot.payload.ledger.members.some((entry) => entry.sessionId === 'app-session-1'), true);
});

test('窗口期 join-confirm：快照携 managerWindow（有窗口才带，且与台账同窗）', (t) => {
  const window = { windowBaseTerm: 1, windowEndsAt: NOW + 60000 };
  const made = makeHarness(t, { ledger: ledgerWith([], { managerWindow: window }) });
  const approved = approvedOf(made, 'app-session-window');
  const result = made.join.handleJoinConfirm(joinConfirmFrame(approved.joinId, 'app-session-window'));
  assert.equal(result.action, 'join-confirmed');
  const snapshot = deliveredOf(made.sent, 'snapshot').at(-1);
  assert.deepEqual(snapshot.payload.managerWindow, window, '窗口期快照必须携 managerWindow（缺失会被协议一致性校验拒收）');
  assert.deepEqual(snapshot.payload.ledger.managerWindow, window, '帧与台账同窗');
});

function approvedOf(made, sessionId, instanceId = 'inst-a') {
  made.join.handleJoinRequest(joinRequestFrame(sessionId, instanceId));
  const approved = made.join.approveJoin({ collabId: COLLAB, managerSessionId: MANAGER_SESSION, sessionId, approve: true });
  assert.equal(approved.ok, true, approved.message);
  return approved;
}

test('confirm 幂等：名单已有本席时 joinId 未知也回快照（alreadyMember），不重复分配 joinSeq', (t) => {
  const made = makeHarness(t);
  const approved = approvedOf(made, 'app-session-1');
  assert.equal(made.join.handleJoinConfirm(joinConfirmFrame(approved.joinId, 'app-session-1')).ok, true);
  const before = made.local.ledger.members.length;
  const replay = made.join.handleJoinConfirm(joinConfirmFrame(approved.joinId, 'app-session-1'));
  assert.equal(replay.ok, true);
  assert.equal(replay.action, 'join-confirmed');
  assert.equal(replay.alreadyMember, true);
  assert.equal(made.local.ledger.members.length, before, '不重复入名单');
  assert.equal(deliveredOf(made.sent, 'snapshot').length >= 2, true, '回当前快照（H-I4）');
});

test('confirm 超时：过期即删 joining、回 join-deny(expired)，joins.json 投影清空', (t) => {
  const made = makeHarness(t);
  const approved = approvedOf(made, 'app-session-1');
  made.advance(60001);
  const result = made.join.handleJoinConfirm(joinConfirmFrame(approved.joinId, 'app-session-1'));
  assert.equal(result.action, 'join-denied');
  assert.equal(result.reason, 'expired');
  assert.deepEqual(readJson(joinsFilePath(made.dir, COLLAB)).pendingJoins, []);
  assert.equal(deliveredOf(made.sent, 'join-deny').at(-1).payload.reason, 'expired');
  assert.equal(made.local.ledger.members.some((entry) => entry.sessionId === 'app-session-1'), false);
});

test('confirm 容量：32 席满员拒绝并回 join-deny(capacity)；alreadyMember 跳过容量与过期', (t) => {
  const full = makeHarness(t, { ledger: ledgerWith(fullRosterSeats()) });
  full.join.handleJoinRequest(joinRequestFrame('app-session-1'));
  const refused = full.join.approveJoin({ collabId: COLLAB, managerSessionId: MANAGER_SESSION, sessionId: 'app-session-1', approve: true });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'capacity');
  assert.equal(deliveredOf(full.sent, 'join-deny').at(-1).payload.reason, 'capacity');
  assert.deepEqual(readJson(joinsFilePath(full.dir, COLLAB))?.pendingJoins ?? [], [], '容量拒绝不产生 joining 记录');

  /* alreadyMember：名单已含本席的崩溃重放——跳过容量与过期（grant 可能已过 TTL），身份/term 仍校验。 */
  const replay = makeHarness(t);
  const approved = approvedOf(replay, 'app-session-replay');
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

test('confirm 名单写失败：unconfirm 回滚（joins.json 保留未确认 grant），恢复后可重试', (t) => {
  const made = makeHarness(t);
  const approved = approvedOf(made, 'app-session-1');
  made.local.suspended = { reason: 'test-suspended' };
  const failed = made.join.confirmJoining(approved.joinId, 'app-session-1', { instanceId: 'inst-a', managerTerm: 1 });
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'roster-write-failed');
  const pending = readJson(joinsFilePath(made.dir, COLLAB)).pendingJoins;
  assert.equal(pending.length, 1, 'confirm 成功与名单提交之间不写盘：盘上仍是未确认 grant');
  assert.equal(pending[0].joinId, approved.joinId);
  assert.equal(made.local.ledger.members.some((entry) => entry.sessionId === 'app-session-1'), false);
  made.local.suspended = null;
  const retried = made.join.confirmJoining(approved.joinId, 'app-session-1', { instanceId: 'inst-a', managerTerm: 1 });
  assert.equal(retried.ok, true, retried.message);
  assert.deepEqual(readJson(joinsFilePath(made.dir, COLLAB)).pendingJoins, []);
});

test('join-deny 回滚：只清本会话的申请记录，不误清同机其他待决申请', (t) => {
  const made = makeHarness(t);
  const first = approvedOf(made, 'app-session-a');
  approvedOf(made, 'app-session-b');
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

test('批准匹配：完整会话标识精确命中；唯一短码可用；短码歧义拒', (t) => {
  const made = makeHarness(t);
  made.join.handleJoinRequest(joinRequestFrame('aaaa1111-session'));
  made.join.handleJoinRequest(joinRequestFrame('bbbb2222-session'));
  const ambiguous = made.join.approveJoin({ collabId: COLLAB, managerSessionId: MANAGER_SESSION, sessionId: 'aaaa1111', approve: true });
  assert.equal(ambiguous.ok, true, ambiguous.message);
  const short = made.join.approveJoin({ collabId: COLLAB, managerSessionId: MANAGER_SESSION, sessionId: 'bbbb2222', approve: true });
  assert.equal(short.ok, true, short.message);

  const clash = makeHarness(t);
  clash.join.handleJoinRequest(joinRequestFrame('aaaa1111-one'));
  clash.join.handleJoinRequest(joinRequestFrame('aaaa1111-two'));
  const refused = clash.join.approveJoin({ collabId: COLLAB, managerSessionId: MANAGER_SESSION, sessionId: 'aaaa1111', approve: true });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /歧义/);
  const exact = clash.join.approveJoin({ collabId: COLLAB, managerSessionId: MANAGER_SESSION, sessionId: 'aaaa1111-one', approve: true });
  assert.equal(exact.ok, true, '完整标识优先（不受短码歧义影响）');
});

test('跨实例 begin：同键不同实例回 instance-mismatch，不覆盖旧 grant；旧 joinId 仍可确认', (t) => {
  const made = makeHarness(t);
  const first = approvedOf(made, 'same-session', 'inst-a');
  made.join.handleJoinRequest(joinRequestFrame('same-session', 'inst-b', '应用乙'));
  const second = made.join.approveJoin({ collabId: COLLAB, managerSessionId: MANAGER_SESSION, sessionId: 'same-session', approve: true });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'instance-mismatch');
  const confirmed = made.join.confirmJoining(first.joinId, 'same-session', { instanceId: 'inst-a', managerTerm: 1 });
  assert.equal(confirmed.ok, true, '旧实例的 grant 未被覆盖');
  assert.equal(made.local.ledger.members.find((entry) => entry.sessionId === 'same-session').instanceId, 'inst-a');
});

test('跨协作隔离：同一 inviteId 的挂起邀请与登记互不串台', (t) => {
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
  const accepted = made.join.acceptInvite({ collabId: 'collab-other', inviteId: 'inv-shared', sessionId: 'app-session-2' });
  assert.equal(accepted.ok, true, accepted.message);
  assert.equal(deliveredOf(made.sent, 'approve')[0].collabId, 'collab-other');
});

/* —— 邀请批准：acceptedSessions 只在入名单后登记；指名/不指名 ------- */

test('受邀批准：approve 只产生 joining，不登记已接受；confirm 成功后才写 acceptedSessions', (t) => {
  const made = makeHarness(t);
  const invite = made.join.createInvite({ collabId: COLLAB, managerSessionId: MANAGER_SESSION, targetInstanceId: 'inst-a', targetSessionId: 'app-session-1' });
  const granted = made.join.handleInviteApproval(inviteApprovalFrame(invite.inviteId, 'app-session-1'));
  assert.equal(granted.ok, true, granted.message);
  const before = readJson(invitesFilePath(made.dir, COLLAB)).invites[0];
  assert.deepEqual(before.acceptedSessions, [], 'joining 阶段不算已接受');
  assert.equal(readJson(joinsFilePath(made.dir, COLLAB)).pendingJoins.length, 1);
  const confirmed = made.join.handleJoinConfirm(joinConfirmFrame(granted.joinId, 'app-session-1'));
  assert.equal(confirmed.action, 'join-confirmed');
  const after = readJson(invitesFilePath(made.dir, COLLAB)).invites[0];
  assert.deepEqual(after.acceptedSessions, [{ instanceId: 'inst-a', sessionId: 'app-session-1' }]);
  assert.equal(after.state, 'closed', '指名邀请接受后整条关闭');
});

test('不指名邀请：多个会话各自确认成席；首个接受不消费整条，acceptedSessions 逐席登记', (t) => {
  const made = makeHarness(t);
  const invite = made.join.createInvite({ collabId: COLLAB, managerSessionId: MANAGER_SESSION, targetInstanceId: 'inst-a' });
  const first = made.join.handleInviteApproval(inviteApprovalFrame(invite.inviteId, 'app-session-1'));
  const second = made.join.handleInviteApproval(inviteApprovalFrame(invite.inviteId, 'app-session-2'));
  assert.equal(first.ok, true, first.message);
  assert.equal(second.ok, true, second.message, '首个接受不消费整条邀请');
  assert.equal(made.join.handleJoinConfirm(joinConfirmFrame(first.joinId, 'app-session-1')).action, 'join-confirmed');
  assert.equal(made.join.handleJoinConfirm(joinConfirmFrame(second.joinId, 'app-session-2')).action, 'join-confirmed');
  const record = readJson(invitesFilePath(made.dir, COLLAB)).invites[0];
  assert.equal(record.state, 'open', '不指名邀请保持 open（多席）');
  assert.deepEqual(record.acceptedSessions.map((entry) => entry.sessionId).sort(), ['app-session-1', 'app-session-2']);
});

test('指名邀请：非目标会话批准被拒；撤回后不再可批准；讨论无 inviteId 路径', (t) => {
  const made = makeHarness(t);
  const invite = made.join.createInvite({ collabId: COLLAB, managerSessionId: MANAGER_SESSION, targetInstanceId: 'inst-a', targetSessionId: 'app-session-1' });
  const wrong = made.join.handleInviteApproval(inviteApprovalFrame(invite.inviteId, 'app-session-2'));
  assert.equal(wrong.ok, false);
  assert.match(wrong.message, /邀请不可用/);
  const withdrawn = made.join.withdrawInvite({ collabId: COLLAB, managerSessionId: MANAGER_SESSION, inviteId: invite.inviteId });
  assert.equal(withdrawn.ok, true);
  const after = made.join.handleInviteApproval(inviteApprovalFrame(invite.inviteId, 'app-session-1'));
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

test('restore：joins.json 超上限按有效期裁剪；过期未确认记录可继续 expire 并回 deny', (t) => {
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
  const expired = made.join.expireJoining(made.clock.value);
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

test('本机目标：注入帧携 cap=2 与 from.sessionId；注入不可用时如实失败（M2 扩展集成点）', async (t) => {
  const localTarget = makeHarness(t);
  localTarget.state.self.instanceId = MANAGER_INSTANCE;
  const created = localTarget.join.createInvite({ collabId: COLLAB, managerSessionId: MANAGER_SESSION, targetInstanceId: MANAGER_INSTANCE, targetSessionId: 'app-session-1' });
  assert.equal(created.ok, true, created.message);
  assert.equal(localTarget.injected.length, 1);
  assert.equal(localTarget.injected[0].frame.cap, COLLAB_CAPABILITY);
  assert.equal(localTarget.injected[0].frame.from.sessionId, MANAGER_SESSION);
  assert.equal(localTarget.sent.length, 0, '本机目标不走网络发送');

  const broken = makeHarness(t);
  broken.state.injectLocalSeat = () => ({ ok: false, reason: 'no-seat' });
  const refused = broken.join.createInvite({ collabId: COLLAB, managerSessionId: MANAGER_SESSION, targetInstanceId: MANAGER_INSTANCE, targetSessionId: 'not-seated' });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /注入|不可注入|发送失败/);
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

test('releaseJoining：离席后同键可再次入席；unconfirmJoining 可把已确认记录退回未确认', (t) => {
  const made = makeHarness(t);
  const first = approvedOf(made, 'app-session-1');
  assert.equal(made.join.releaseJoining(COLLAB, 'app-session-1').released, true);
  assert.deepEqual(readJson(joinsFilePath(made.dir, COLLAB)).pendingJoins, [], '释放后写盘投影清空');
  const again = approvedOf(made, 'app-session-1');
  assert.notEqual(again.joinId, first.joinId, '同键再入席换新 joinId');
  const unconfirmed = made.join.unconfirmJoining(again.joinId);
  assert.equal(unconfirmed.ok, true);
  assert.equal(unconfirmed.unconfirmed, false, '未确认记录再次回滚＝幂等成功');
  assert.equal(unconfirmed.idempotent, true);
});
