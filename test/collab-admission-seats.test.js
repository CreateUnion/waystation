import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDir } from './helpers.js';
import { createCollabService } from '../src/collab/service.js';

/* 讨论成员准入的席位判据（设计 §2.2「成员＝会话」/§5.1 中继准入）：折叠成员表按
 * (instanceId, sessionId) 产出席位行——历史拉取与中继转达都必须按席位放行。同机第二个
 * 未入席会话不得借机器历史成员身份拿到讨论历史，也不得借中继把投稿放大为全员直投；
 * 无 sessionId 的旧帧退回实例判据，旧档案照常可读。 */

const DAY = 24 * 60 * 60 * 1000;
const SELF_A = { instanceId: 'inst-a', identityName: '主机甲', port: 17321 };
const SESSION_A = 'sess-a1';
const PEER_B = { instanceId: 'inst-b', identityName: '主机乙', port: 17322 };
const SESSION_B1 = 'sess-b1';
const SESSION_B2 = 'sess-b2';
const PEER_C = { instanceId: 'inst-c', identityName: '主机丙', port: 17323 };
const SESSION_C1 = 'sess-c1';

function quietLog(warnings) {
  return {
    info: () => {},
    warn: (message, detail) => {
      warnings.push({ message, detail });
    },
    error: () => {},
  };
}

function makeService(t, warnings = []) {
  const dir = makeTempDir(t);
  const sent = [];
  const direct = [];
  let serial = 0;
  const service = createCollabService({
    dataDir: dir,
    config: { inviteTtlMs: DAY },
    self: SELF_A,
    send: (message) => {
      sent.push(message);
      return { ok: true, msgId: `q-${++serial}` };
    },
    sendDirect: (message) => {
      direct.push(message);
      return { ok: true, msgId: `d-${++serial}` };
    },
    notify: () => {},
    knownHosts: { remember: () => {} },
    log: quietLog(warnings),
    ledgerFetchTimeoutMs: 30,
    inviteMinIntervalMs: 0,
    pullReplyTimeoutMs: 60,
    syncPeerPicker: () => [],
    syncRequestMax: 50,
    joinReplayIntervalsMs: [10, 20],
  });
  t.after(() => service.close());
  return { service, sent, direct };
}

function ghostTargetOf(suffix) {
  return { instanceId: `inst-ghost-${suffix}`, identityName: '幽灵机', address: '127.0.0.1', port: 17390 };
}

function makeForumOf(service) {
  const created = service.create({
    name: '席位准入讨论',
    topic: '准入判据',
    mode: 'forum',
    sessionId: SESSION_A,
    targets: [ghostTargetOf('create')],
  });
  assert.equal(created.ok, true, String(created.message));
  return created.collabId;
}

let seq = 0;

/* 帧成形：from.sessionId 存在才随帧带出（旧帧的席位键缺省形态）。 */
function frameOf(type, collabId, from, payload) {
  seq++;
  const seat = { instanceId: from.instanceId, identityName: from.identityName, port: from.port };
  if (typeof from.sessionId === 'string') {
    seat.sessionId = from.sessionId;
  }
  return {
    v: 1,
    cap: 2,
    type,
    msgId: `msg-${type}-${seq}`,
    from: seat,
    collabId,
    ts: new Date().toISOString(),
    payload,
  };
}

function historyRequestOf(collabId, from) {
  return frameOf('history-request', collabId, from, {});
}

/* 中继投稿：payload.relay 是成员发往中继的投稿识别形态。 */
function relayPostOf(collabId, from, postId, postSeq) {
  const frame = frameOf('post', collabId, from, { post: { postId, seq: postSeq, kind: 'reply', text: `投稿 ${postId}` } });
  frame.payload.relay = true;
  return frame;
}

async function receive(service, frame, remoteAddress = '127.0.0.1') {
  const admitted = await service.hooks.admit(frame, { remoteAddress });
  if (admitted?.ok === true) {
    await service.hooks.consume(frame, { remoteAddress });
  }
  return admitted;
}

async function joinInto(service, collabId, seat, remoteAddress) {
  const stamp = new Date().toISOString();
  const frame = frameOf('join', collabId, seat, { eventId: `${seat.instanceId}-${seat.sessionId}-join`, ts: stamp });
  const admitted = await receive(service, frame, remoteAddress);
  assert.equal(admitted?.ok, true, `成员 join 准入：${JSON.stringify(admitted)}`);
}

test('历史拉取准入按席位：同机未入席会话被拒，在席会话通过，拒绝计数与日志留痕', async (t) => {
  const warnings = [];
  const { service } = makeService(t, warnings);
  const collabId = makeForumOf(service);
  await joinInto(service, collabId, { ...PEER_B, sessionId: SESSION_B1 }, '127.0.0.2');

  const own = await receive(service, historyRequestOf(collabId, { ...SELF_A, sessionId: SESSION_A }));
  assert.equal(own.ok, true, '本机在席会话通过');
  const seated = await receive(service, historyRequestOf(collabId, { ...PEER_B, sessionId: SESSION_B1 }), '127.0.0.2');
  assert.equal(seated.ok, true, '同机在席会话通过');

  const rejectedBefore = service.stats().syncRequestsRejected;
  const unseated = await receive(service, historyRequestOf(collabId, { ...PEER_B, sessionId: SESSION_B2 }), '127.0.0.3');
  assert.equal(unseated.ok, false, '同机未入席会话不得借机器身份通过');
  assert.ok(unseated.reason.includes('成员表'), unseated.reason);
  assert.equal(service.stats().syncRequestsRejected, rejectedBefore + 1, '拒绝计数留痕');
  assert.ok(warnings.some((entry) => entry.message.includes('成员表') && entry.detail?.sessionId === SESSION_B2), '拒绝日志留痕');
});

test('旧帧无 sessionId：历史拉取按实例兜底（旧档案可读），陌生实例照旧拒绝', async (t) => {
  const { service } = makeService(t);
  const collabId = makeForumOf(service);
  await joinInto(service, collabId, { ...PEER_B, sessionId: SESSION_B1 }, '127.0.0.2');

  const legacy = await receive(service, historyRequestOf(collabId, PEER_B), '127.0.0.4');
  assert.equal(legacy.ok, true, '无席位键的旧帧退回实例判据');
  const stranger = await receive(service, historyRequestOf(collabId, PEER_C), '127.0.0.5');
  assert.equal(stranger.ok, false, '实例本身不在成员表内仍拒绝');
  assert.ok(stranger.reason.includes('成员表'), stranger.reason);
});

test('中继转达按席位：同机未入席会话的投稿照常入列但不转达并计数', async (t) => {
  const { service, direct } = makeService(t);
  const collabId = makeForumOf(service);
  await joinInto(service, collabId, { ...PEER_B, sessionId: SESSION_B1 }, '127.0.0.2');
  await joinInto(service, collabId, { ...PEER_C, sessionId: SESSION_C1 }, '127.0.0.3');
  const toC = () => direct.filter((message) => message.type === 'post' && message.to.instanceId === PEER_C.instanceId);

  const seatedPost = relayPostOf(collabId, { ...PEER_B, sessionId: SESSION_B1 }, 'post-b1', 1);
  assert.equal((await receive(service, seatedPost, '127.0.0.2')).ok, true);
  assert.equal(service.stats().relaySubmissionsIn, 1, '在席会话的投稿被转达');
  assert.equal(toC().length, 1, '转达到其他成员');

  const unseatedPost = relayPostOf(collabId, { ...PEER_B, sessionId: SESSION_B2 }, 'post-b2', 2);
  const admitted = await receive(service, unseatedPost, '127.0.0.2');
  assert.equal(admitted.ok, true, '投稿本身照常受理（内容面语义不变）');
  assert.equal(service.stats().relaySubmissionsRejected, 1, '非成员会话不转达并计数');
  assert.equal(service.stats().relaySubmissionsIn, 1, '在席计数不因拒绝增加');
  assert.equal(toC().length, 1, '未产生 1→N 放大转达');
  const view = await service.view({ collabId });
  assert.ok(view.posts.some((entry) => entry.entryId === 'post-b2'), '帖照常入列');
});

test('旧帧无 sessionId：中继转达按实例兜底（旧档案可读）', async (t) => {
  const { service, direct } = makeService(t);
  const collabId = makeForumOf(service);
  await joinInto(service, collabId, { ...PEER_B, sessionId: SESSION_B1 }, '127.0.0.2');
  await joinInto(service, collabId, { ...PEER_C, sessionId: SESSION_C1 }, '127.0.0.3');

  const legacyPost = relayPostOf(collabId, PEER_B, 'post-legacy', 1);
  assert.equal((await receive(service, legacyPost, '127.0.0.2')).ok, true);
  assert.equal(service.stats().relaySubmissionsIn, 1, '无席位键的旧帧按实例判据转达');
  assert.equal(service.stats().relaySubmissionsRejected, 0);
  assert.equal(direct.filter((message) => message.to.instanceId === PEER_C.instanceId).length, 1, '照常转达其他成员');
});
