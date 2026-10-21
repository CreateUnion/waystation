import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { collabFilePath } from '../src/paths.js';
import { makeTempDir } from './helpers.js';
import { createCollabService } from '../src/collab/service.js';
import { MEMBERS_FILE_NAME, foldMemberEvents } from '../src/collab/members.js';

/* 讨论成员事件的席位键（设计 §2.2/§4.5/§5.1/§10）：成员＝会话——帧的 from.sessionId 与
 * 对表 bundle 里的事件 sessionId 必须原样落进成员事件日志，否则发起人侧折叠表只剩实例、
 * 邀请载荷漏掉远端已入席席位（整帧仍合法，只是名单缺人）。 */

const DAY = 24 * 60 * 60 * 1000;
const SELF_A = { instanceId: 'inst-a', identityName: '主机甲', port: 17321 };
const SESSION_A = 'sess-a';
const PEER_B = { instanceId: 'inst-b', identityName: '主机乙', port: 17322 };
const SESSION_B1 = 'sess-b1';
const SESSION_B2 = 'sess-b2';

function quietLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function makeService(t) {
  const dir = makeTempDir(t);
  const sent = [];
  let serial = 0;
  const service = createCollabService({
    dataDir: dir,
    config: { inviteTtlMs: DAY },
    self: SELF_A,
    send: (message) => {
      sent.push(message);
      return { ok: true, msgId: `q-${++serial}` };
    },
    sendDirect: () => ({ ok: true, msgId: `d-${++serial}` }),
    notify: () => {},
    knownHosts: { remember: () => {} },
    log: quietLog(),
    ledgerFetchTimeoutMs: 30,
    inviteMinIntervalMs: 0,
    pullReplyTimeoutMs: 60,
    syncPeerPicker: () => [],
    joinReplayIntervalsMs: [10, 20],
  });
  t.after(() => service.close());
  return { service, sent, dir };
}

function ghostOf(suffix) {
  return { instanceId: `inst-ghost-${suffix}`, identityName: '幽灵机', address: '127.0.0.1', port: 17390 };
}

function createForumOf(service) {
  const created = service.create({
    name: '席位讨论',
    topic: '成员事件席位键',
    mode: 'forum',
    sessionId: SESSION_A,
    targets: [ghostOf('create')],
  });
  assert.equal(created.ok, true, String(created.message));
  return created.collabId;
}

let seq = 0;

/* 成员事件帧：join/leave 都由作者会话签发（设计 §4.5/§7.1），席位键在 from.sessionId。 */
function memberFrameOf(kind, collabId, from, { eventId, ts }) {
  seq++;
  const stamp = ts ?? new Date().toISOString();
  return {
    v: 1,
    cap: 2,
    type: kind,
    msgId: `msg-${kind}-${seq}`,
    from: { instanceId: from.instanceId, sessionId: from.sessionId, identityName: from.identityName, port: from.port },
    collabId,
    ts: stamp,
    payload: { eventId, ts: stamp },
  };
}

function bundleFrameOf(collabId, from, members) {
  seq++;
  return {
    v: 1,
    cap: 2,
    type: 'history-bundle',
    msgId: `msg-bundle-${seq}`,
    from: { instanceId: from.instanceId, sessionId: from.sessionId, identityName: from.identityName, port: from.port },
    collabId,
    ts: new Date().toISOString(),
    payload: {
      cursor: null,
      summary: { authors: [] },
      more: false,
      posts: [],
      overlap: [],
      meta: {},
      members,
      endpoints: {},
    },
  };
}

async function receive(service, frame) {
  const admitted = await service.hooks.admit(frame, { remoteAddress: '127.0.0.1' });
  if (admitted?.ok === true) {
    await service.hooks.consume(frame, { remoteAddress: '127.0.0.1' });
  }
  return admitted;
}

/* 发起人侧落盘的成员事件（观察窗与折叠表的同一取数面）。 */
function storedEventsOf(dir, collabId) {
  const text = readFileSync(collabFilePath(dir, collabId, MEMBERS_FILE_NAME), 'utf8');
  return text.trim().split('\n').filter((line) => line !== '').map((line) => JSON.parse(line));
}

function foldedSeatsOf(dir, collabId) {
  return foldMemberEvents(storedEventsOf(dir, collabId)).map((member) => `${member.instanceId}/${member.sessionId ?? '-'}`);
}

test('远端 join/leave：事件按 from.sessionId 落盘，折叠表按会话列出远端席位', async (t) => {
  const { service, dir } = makeService(t);
  const collabId = createForumOf(service);
  const admitted = await receive(service, memberFrameOf('join', collabId, { ...PEER_B, sessionId: SESSION_B1 }, { eventId: 'b1-join', ts: '2026-10-21T00:00:00.000Z' }));
  assert.equal(admitted?.ok, true, JSON.stringify(admitted));

  const stored = storedEventsOf(dir, collabId).find((event) => event.eventId === 'b1-join');
  assert.equal(stored.sessionId, SESSION_B1, '远端 join 事件携发起会话的席位键');
  assert.equal(stored.instanceId, PEER_B.instanceId);
  assert.deepEqual(foldedSeatsOf(dir, collabId), [`inst-a/${SESSION_A}`, `inst-b/${SESSION_B1}`], '折叠表列出本机与远端各自的会话');

  const view = await service.view({ collabId });
  const foldedRemote = view.members.find((member) => member.instanceId === PEER_B.instanceId);
  assert.equal(foldedRemote?.sessionId, SESSION_B1, '讨论视图的成员行保留远端会话标识');

  await receive(service, memberFrameOf('leave', collabId, { ...PEER_B, sessionId: SESSION_B1 }, { eventId: 'b1-leave', ts: '2026-10-21T00:00:10.000Z' }));
  const leaveEvent = storedEventsOf(dir, collabId).find((event) => event.eventId === 'b1-leave');
  assert.equal(leaveEvent.sessionId, SESSION_B1, '远端 leave 事件同样携席位键');
  assert.deepEqual(foldedSeatsOf(dir, collabId), [`inst-a/${SESSION_A}`], '离席者按席位出表');
});

test('同机双会话：发起人侧折叠表各占一行，一个会话离席不影响另一个', async (t) => {
  const { service, dir } = makeService(t);
  const collabId = createForumOf(service);
  await receive(service, memberFrameOf('join', collabId, { ...PEER_B, sessionId: SESSION_B1 }, { eventId: 'b1-join', ts: '2026-10-21T00:00:00.000Z' }));
  await receive(service, memberFrameOf('join', collabId, { ...PEER_B, sessionId: SESSION_B2 }, { eventId: 'b2-join', ts: '2026-10-21T00:00:01.000Z' }));
  assert.deepEqual(foldedSeatsOf(dir, collabId), [`inst-a/${SESSION_A}`, `inst-b/${SESSION_B1}`, `inst-b/${SESSION_B2}`], '同机双会话在成员表各一行');
  await receive(service, memberFrameOf('leave', collabId, { ...PEER_B, sessionId: SESSION_B1 }, { eventId: 'b1-leave', ts: '2026-10-21T00:00:02.000Z' }));
  assert.deepEqual(foldedSeatsOf(dir, collabId), [`inst-a/${SESSION_A}`, `inst-b/${SESSION_B2}`], '只出离席会话那一行');
});

test('对表往返：bundle 里的成员事件按事件自带的 sessionId 落盘（不按发送者的席位顶替）', async (t) => {
  const { service, dir } = makeService(t);
  const collabId = createForumOf(service);
  await receive(service, memberFrameOf('join', collabId, { ...PEER_B, sessionId: SESSION_B1 }, { eventId: 'b1-join', ts: '2026-10-21T00:00:00.000Z' }));
  /* 应答机 B 的事件集里含着 C 的 join（事件集并集语义）：C 的席位键必须原样保留。 */
  const admitted = await receive(service, bundleFrameOf(collabId, { ...PEER_B, sessionId: SESSION_B1 }, [
    { eventId: 'c1-join', kind: 'join', instanceId: 'inst-c', identityName: '主机丙', sessionId: 'sess-c1', ts: '2026-10-21T00:00:05.000Z' },
    { eventId: 'c-legacy-join', kind: 'join', instanceId: 'inst-d', identityName: '主机丁', ts: '2026-10-21T00:00:06.000Z' },
  ]));
  assert.equal(admitted?.ok, true, JSON.stringify(admitted));
  const forwarded = storedEventsOf(dir, collabId).find((event) => event.eventId === 'c1-join');
  assert.equal(forwarded.sessionId, 'sess-c1', '转述事件的席位键随事件走（不是发送者的会话）');
  assert.equal(forwarded.instanceId, 'inst-c');
  const legacy = storedEventsOf(dir, collabId).find((event) => event.eventId === 'c-legacy-join');
  assert.equal('sessionId' in legacy, false, '缺席位键的旧事件如实不带（不编造）');
  assert.deepEqual(foldedSeatsOf(dir, collabId), [`inst-a/${SESSION_A}`, `inst-b/${SESSION_B1}`, `inst-c/sess-c1`, 'inst-d/-'], '折叠表同时容纳席位行与旧实例行');
});

test('讨论邀请载荷：members 含远端已入席会话的席位条目', async (t) => {
  const { service, sent } = makeService(t);
  const collabId = createForumOf(service);
  await receive(service, memberFrameOf('join', collabId, { ...PEER_B, sessionId: SESSION_B1 }, { eventId: 'b1-join', ts: '2026-10-21T00:00:00.000Z' }));
  const sentBefore = sent.length;
  const invited = await service.invite({ collabId, sessionId: SESSION_A, targets: [ghostOf('invite')] });
  assert.equal(invited.ok, true, String(invited.message));
  const inviteFrames = sent.slice(sentBefore).filter((message) => message.type === 'invite' && message.collabId === collabId);
  assert.equal(inviteFrames.length, 1, '一台目标机器一帧邀请');
  const members = inviteFrames[0].payload.members;
  assert.ok(members.some((member) => member.instanceId === SELF_A.instanceId && member.sessionId === SESSION_A), 'members 含本机发起会话席位');
  assert.ok(members.some((member) => member.instanceId === PEER_B.instanceId && member.sessionId === SESSION_B1), 'members 含远端已入席会话席位');
});
