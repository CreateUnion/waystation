import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { collabDir, seatFilePath } from '../src/paths.js';
import { classifyCollabDir } from '../src/collab/legacy.js';
import { makeTempDir } from './helpers.js';
import { createCollabService } from '../src/collab/service.js';

/* 终态与本地席位（设计 §3.4 / 契约 §8）：结束与整条撤回归档本机席位（archivedAt）而非删除文件；
 * 归档席位退出静音聚合、注入与状态栏活跃判定；重启仍能读取历史席位。 */

const DAY = 24 * 60 * 60 * 1000;
const SELF = { instanceId: 'inst-self', identityName: '本机' };
const MANAGER_SESSION = 'sess-manager-a';
const MEMBER_SESSION = 'sess-member-b';
const REMOTE = { instanceId: 'inst-peer', identityName: '对端', address: '127.0.0.2', port: 17400 };

function quietLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function makeService(t, overrides = {}) {
  const dir = overrides.dir ?? makeTempDir(t);
  const delivered = [];
  const sent = [];
  const bindings = new Map();
  const service = createCollabService({
    dataDir: dir,
    config: {
      inviteTtlMs: DAY, joinRequestTtlMs: DAY, joinConfirmTtlMs: DAY, messageTtlMs: 600000,
    },
    self: SELF,
    send: (message) => {
      sent.push(message);
      return { ok: true, msgId: `q-${sent.length}` };
    },
    sendDirect: () => ({ ok: true, msgId: 'd-1' }),
    notify: () => true,
    deliverSeat: (frame, seat) => {
      delivered.push({ sessionId: seat.sessionId, type: frame.type });
      return true;
    },
    knownHosts: { remember: () => {}, lookup: () => undefined },
    bindings: {
      set: (collabId, entry) => bindings.set(collabId, entry),
      get: (collabId) => bindings.get(collabId),
      entries: () => [...bindings.entries()],
    },
    bridgeIdOf: (sessionId) => `bridge-${sessionId}`,
    log: quietLog(),
    ledgerFetchTimeoutMs: 30,
    pullReplyTimeoutMs: 60,
    syncPeerPicker: () => [],
    joinReplayIntervalsMs: [10, 20, 40],
    ...(overrides.probeCapability === undefined ? {} : { probeCapability: overrides.probeCapability }),
  });
  return { dir, service, delivered, sent };
}

function targetOf(peer) {
  return { instanceId: peer.instanceId, identityName: peer.identityName, address: peer.address, port: peer.port };
}

function createManaged(made, name = '协作甲') {
  const created = made.service.create({
    name, topic: '主题', mode: 'managed', sessionId: MANAGER_SESSION, targets: [targetOf(REMOTE)],
  });
  assert.equal(created.ok, true, created.message);
  return created.collabId;
}

async function makeManaged(made, name = '协作甲') {
  const collabId = createManaged(made, name);
  await made.service.registerBridgeEntry(MEMBER_SESSION, `bridge-${MEMBER_SESSION}`);
  const asked = await made.service.join.request({ collabId, sessionId: MEMBER_SESSION });
  assert.equal(asked.ok, true, asked.message);
  const approved = await made.service.join.approve({ collabId, sessionId: MEMBER_SESSION, managerSessionId: MANAGER_SESSION, approve: true });
  assert.equal(approved.ok, true, approved.message);
  return collabId;
}

function listEntryOf(made, collabId, sessionId) {
  return made.service.list({ sessionId }).collabs.find((entry) => entry.collabId === collabId) ?? null;
}

function seatRecordOf(made, collabId, sessionId) {
  return JSON.parse(readFileSync(seatFilePath(made.dir, collabId, sessionId), 'utf8'));
}

function seatOf(service, collabId, sessionId) {
  return service.listLocalSeats(collabId).find((seat) => seat.sessionId === sessionId) ?? null;
}

function contentFrameOf(collabId) {
  return {
    v: 1,
    cap: 2,
    type: 'progress',
    msgId: 'msg-after-terminal',
    collabId,
    from: { instanceId: REMOTE.instanceId, identityName: REMOTE.identityName, port: REMOTE.port, sessionId: 'sess-peer-a' },
    ts: new Date().toISOString(),
    payload: { text: '终态后的内容' },
  };
}

test('结束协作：本机席位归档（archivedAt 落盘、不删除），退出注入/静音聚合/状态栏；重启仍可读', async (t) => {
  const made = makeService(t);
  const collabId = await makeManaged(made);
  assert.equal(seatOf(made.service, collabId, MANAGER_SESSION)?.muted, true, '前置：默认静音已落席位');
  const ended = made.service.end({ collabId, sessionId: MANAGER_SESSION });
  assert.equal(ended.ok, true, ended.message);

  const seats = made.service.listLocalSeats(collabId);
  assert.equal(seats.length, 2, '结束不删除本机席位（保留历史）');
  assert.ok(seats.every((seat) => seat.archived === true), '全部本机席位标记归档');
  const record = seatRecordOf(made, collabId, MANAGER_SESSION);
  assert.ok(Number.isFinite(Date.parse(record.archivedAt)), 'archivedAt 已落盘');
  assert.equal(record.muted, true, '归档不篡改席位静音历史');

  const listed = listEntryOf(made, collabId, MANAGER_SESSION);
  assert.equal(listed.state, 'completed');
  assert.equal(listed.archived, true);
  assert.deepEqual(listed.sessions.localSeats, [], '归档席位退出状态栏活跃判定');
  assert.equal(listed.muted, false, '归档席位退出静音聚合');

  const injected = await made.service.injectLocalSeat(collabId, MANAGER_SESSION, contentFrameOf(collabId));
  assert.deepEqual(injected, { ok: false, reason: 'seat-archived' }, '归档席位退出注入');

  const reloaded = makeService(t, { dir: made.dir });
  const seatsAfter = reloaded.service.listLocalSeats(collabId);
  assert.equal(seatsAfter.length, 2, '重启后席位仍可读');
  assert.ok(seatsAfter.every((seat) => seat.archived === true), '重启后归档标记仍在');
  assert.equal(listEntryOf(reloaded, collabId, MANAGER_SESSION).state, 'completed', '重启后仍显示终态');
});

test('整条撤回：本机席位归档（archivedAt 落盘、不删除），重启仍可读', async (t) => {
  const made = makeService(t);
  const collabId = createManaged(made, '协作撤回');
  const withdrawn = made.service.withdraw({ collabId, sessionId: MANAGER_SESSION });
  assert.equal(withdrawn.ok, true, withdrawn.message);

  const seat = seatOf(made.service, collabId, MANAGER_SESSION);
  assert.ok(seat !== null, '整条撤回不删除本机席位');
  assert.equal(seat.archived, true, '整条撤回归档本机席位');
  const record = seatRecordOf(made, collabId, MANAGER_SESSION);
  assert.ok(Number.isFinite(Date.parse(record.archivedAt)), 'archivedAt 已落盘');

  const listed = listEntryOf(made, collabId, MANAGER_SESSION);
  assert.equal(listed.state, 'terminated');
  assert.equal(listed.archived, true);
  assert.deepEqual(listed.sessions.localSeats, [], '归档席位退出状态栏活跃判定');

  const reloaded = makeService(t, { dir: made.dir });
  const seatAfter = seatOf(reloaded.service, collabId, MANAGER_SESSION);
  assert.ok(seatAfter !== null, '重启后席位仍可读');
  assert.equal(seatAfter.archived, true, '重启后归档标记仍在');
  assert.equal(listEntryOf(reloaded, collabId, MANAGER_SESSION).state, 'terminated', '重启后仍显示终态');
});

/* —— 服务层输入校验与折叠席位键（协调者追加项） —— */

function forumInviteFrameOf(collabId) {
  return {
    v: 1,
    cap: 2,
    type: 'invite',
    msgId: `msg-invite-${collabId}`,
    from: { instanceId: REMOTE.instanceId, identityName: REMOTE.identityName, port: REMOTE.port, sessionId: 'sess-peer-a' },
    collabId,
    ts: new Date().toISOString(),
    payload: {
      name: '联调项目',
      topic: '发布联调',
      mode: 'forum',
      members: [
        { instanceId: REMOTE.instanceId, sessionId: 'sess-peer-a', identityName: REMOTE.identityName },
        { instanceId: SELF.instanceId, sessionId: MEMBER_SESSION, identityName: SELF.identityName },
      ],
    },
  };
}

async function receive(made, frame) {
  const admitted = await made.service.hooks.admit(frame, { remoteAddress: '127.0.0.1' });
  if (admitted?.ok === true) {
    await made.service.hooks.consume(frame, { remoteAddress: '127.0.0.1' });
  }
  return admitted;
}

async function approveWithConsent(made, collabId, sessionId) {
  const first = await made.service.approve({ collabId, approve: true, sessionId });
  const result = first?.needsUserConfirmation === true
    ? await made.service.approve({ collabId, approve: true, sessionId, confirmToken: first.confirmToken })
    : first;
  assert.equal(result.ok, true, result.message);
  return result;
}

test('无会话 approve 被拒绝且不升级目录：invite-stub 保持原状，随后带会话同意正常', async (t) => {
  const made = makeService(t);
  const collabId = 'collab-approve-no-session';
  const admitted = await receive(made, forumInviteFrameOf(collabId));
  assert.equal(admitted?.ok, true, admitted?.reason);
  assert.equal(classifyCollabDir(collabDir(made.dir, collabId)).kind, 'invite-stub', '前置：邀请落点仍是 invite-stub');

  const refused = await made.service.approve({ collabId, approve: true });
  assert.equal(refused.ok, false, '无会话同意必须拒绝');
  assert.match(refused.message, /会话标识/, '拒绝文案指向缺少调用会话标识');
  assert.equal(classifyCollabDir(collabDir(made.dir, collabId)).kind, 'invite-stub', '拒绝不得升级载体（否则目录会成 carrier 无台账的永久只读态）');
  assert.equal(existsSync(join(collabDir(made.dir, collabId), 'recovery.json')), false, '拒绝不得写恢复标记');

  await approveWithConsent(made, collabId, MEMBER_SESSION);
  assert.equal(classifyCollabDir(collabDir(made.dir, collabId)).kind, 'session-seats', '带会话同意后目录正常升级');
  const seat = seatOf(made.service, collabId, MEMBER_SESSION);
  assert.ok(seat !== null, '带会话同意建席');
  assert.equal(seat.muted, true, '默认静音同步落席位');
});

test('能力探测异常 fail-closed：按「无法确认目标能力」拒绝并计数，不穿出调用链', async (t) => {
  const made = makeService(t, { probeCapability: async () => { throw new Error('探测爆炸'); } });
  const created = await made.service.create({ name: '协作甲', topic: '主题', sessionId: MANAGER_SESSION, targets: [targetOf(REMOTE)] });
  assert.equal(created.ok, false, '探测异常不得放行创建');
  assert.match(created.message, /无法确认目标驿站/);
  assert.match(created.message, /探测异常/);
  assert.equal(made.service.stats().capabilityProbeFailures, 1, '异常必须计数');
  assert.equal(made.service.list().collabs.length, 0, '拒绝路径不建协作');
});

function remoteJoinFrameOf(collabId, sessionId, at) {
  return {
    v: 1,
    cap: 2,
    type: 'join',
    msgId: `msg-join-${sessionId}`,
    from: { instanceId: REMOTE.instanceId, identityName: REMOTE.identityName, port: REMOTE.port, sessionId },
    collabId,
    ts: at,
    payload: { eventId: `event-${sessionId}`, ts: at },
  };
}

test('同机双会话：折叠成员表与邀请载荷各保留两行（sessionId 不被反查覆盖）', async (t) => {
  const made = makeService(t);
  const created = made.service.create({
    name: '联调项目', topic: '发布联调', mode: 'forum', sessionId: MANAGER_SESSION, targets: [targetOf(REMOTE)],
  });
  assert.equal(created.ok, true, created.message);
  const collabId = created.collabId;
  const firstTs = new Date(Date.now() - 1000).toISOString();
  const secondTs = new Date().toISOString();
  await receive(made, remoteJoinFrameOf(collabId, 'sess-peer-a', firstTs));
  await receive(made, remoteJoinFrameOf(collabId, 'sess-peer-b', secondTs));

  const view = await made.service.view({ collabId });
  const remoteRows = view.members.filter((member) => member.instanceId === REMOTE.instanceId);
  assert.deepEqual(remoteRows.map((member) => member.sessionId).sort(), ['sess-peer-a', 'sess-peer-b'], '视图两行各保留自己的席位键');

  const invited = made.service.invite({ collabId, targets: [targetOf(REMOTE)], sessionId: MANAGER_SESSION });
  assert.equal(invited.ok, true, invited.message);
  const frame = made.sent.filter((message) => message.type === 'invite' && message.collabId === collabId).at(-1);
  assert.ok(frame !== undefined, '邀请帧已发出');
  const invitedRemoteRows = frame.payload.members.filter((member) => member.instanceId === REMOTE.instanceId);
  assert.deepEqual(invitedRemoteRows.map((member) => member.sessionId).sort(), ['sess-peer-a', 'sess-peer-b'], '邀请成员表保留两席（不被去重成一行）');
});
