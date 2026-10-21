import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { invitesFilePath } from '../src/paths.js';
import { createCollabService } from '../src/collab/service.js';
import {
  bringSessionOnline,
  linkSessionNodes,
  sessionNodeConfig,
  startSessionNode,
  targetOf,
  waitForInjection,
} from './helpers/session-participants.js';
import { makeTempDir, waitFor } from './helpers.js';

/* 建协首邀的邀请簿记（设计 §4.1/§4.2）：managed 建协必须与 ws_invite 同一条两段式链路——
 * 首邀帧携 inviteId、站长机 invites.json 有 open 记录、目标机登记挂起邀请，受邀会话才能用
 * ws_approve_invite 的正式路径入席。forum 无邀请簿记（D18），载荷不得出现 inviteId。
 * 长操作声明：两节点用例走真实回环 TCP，通常 < 20s，单用例超时上限 60s。 */

const TIMEOUT_MS = 60000;

const SELF = { instanceId: 'inst-self', identityName: '本机', port: 7321 };
const REMOTE_TARGET = { instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.2', port: 17321 };
const MANAGER_SESSION = 'seat-manager';

function quietLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function invitesBookOf(home, collabId) {
  const file = invitesFilePath(home, collabId);
  return existsSync(file) ? readJson(file) : null;
}

function openRecordsOf(book) {
  return (book?.invites ?? []).filter((record) => record.state === 'open');
}

/* 进程内服务夹具（真实 service，发送面替换为记录/故障注入）：建协首邀的失败收口与 forum 例外
 * 不需要网络链路，用这里才能精确控制 send 的成败。 */
function makeService(t, { failInvites = false } = {}) {
  const dir = makeTempDir(t);
  const sent = [];
  const service = createCollabService({
    dataDir: dir,
    config: sessionNodeConfig({ inviteTtlMs: 120000 }),
    self: SELF,
    send: (message) => {
      sent.push(message);
      if (failInvites && message.type === 'invite') {
        return { ok: false, reason: '模拟入队失败' };
      }
      return { ok: true, msgId: `msg-${sent.length}` };
    },
    sendDirect: (message) => {
      sent.push(message);
      return { ok: true, msgId: `direct-${sent.length}` };
    },
    knownHosts: { remember: () => {}, lookup: () => undefined },
    notify: () => true,
    deliverSeat: () => true,
    log: quietLog(),
    syncPeerPicker: () => [],
    inviteMinIntervalMs: 0,
  });
  return { dir, service, sent };
}

async function startPair(t) {
  const manager = await startSessionNode(t, { identityName: '甲机', online: [MANAGER_SESSION] });
  const member = await startSessionNode(t, { identityName: '乙机', online: ['seat-b1', 'seat-b2'] });
  linkSessionNodes(manager, member);
  await bringSessionOnline(manager, MANAGER_SESSION);
  await bringSessionOnline(member, 'seat-b1');
  await bringSessionOnline(member, 'seat-b2');
  return { manager, member };
}

async function createInviting(manager, member, name, extraTarget = {}) {
  const created = await manager.service.create({
    name,
    topic: `${name} 主题`,
    targets: [targetOf(member, extraTarget)],
    mode: 'managed',
    sessionId: MANAGER_SESSION,
  });
  assert.equal(created.ok, true, String(created.message));
  return created;
}

function inviteEntryOf(created) {
  assert.equal(created.invited.length, 1);
  const entry = created.invited[0];
  assert.equal(entry.ok, true, String(entry.reason));
  assert.match(String(entry.inviteId), /^inv-/, '建协首邀必须生成 inviteId（两段式同意的校验键）');
  return entry;
}

async function waitRosterHas(manager, collabId, sessionIds) {
  return waitFor(async () => {
    const view = await manager.service.view({ collabId });
    const sessions = view.ledger?.members.map((seat) => seat.sessionId) ?? [];
    return sessionIds.every((sessionId) => sessions.includes(sessionId)) ? true : null;
  }, { timeoutMs: 10000 });
}

function assertInviteRecordOpen(manager, member, created, entry) {
  const book = invitesBookOf(manager.home, created.collabId);
  assert.ok(book !== null, '建协首邀必须落 invites.json');
  const record = book.invites.find((row) => row.inviteId === entry.inviteId);
  assert.ok(record !== undefined, 'invites.json 登记该 inviteId');
  assert.equal(record.state, 'open');
  assert.deepEqual(record.targets, [{ instanceId: member.self.instanceId, targetSessionId: 'seat-b2' }]);
  assert.equal(record.expiresAt, entry.expiresAt);
}

async function assertPendingInviteHeld(member, collabId, sessionId, inviteId) {
  await waitFor(() => (
    member.service.join.pendingInvitesFor({ collabId, sessionId, inviteId }).length === 1 ? true : null
  ), { timeoutMs: 8000 });
}

async function settleInvitedSeat(manager, member, collabId, inviteId, sessionId) {
  const accepted = await member.service.join.acceptInvite({ collabId, inviteId, sessionId });
  assert.equal(accepted.ok, true, String(accepted.message));
  assert.equal(accepted.inviteId, inviteId);

  const grant = await waitFor(() => manager.sentFrames.find((frame) => frame.type === 'join-grant'
    && frame.payload?.joinId !== undefined) ?? null, { timeoutMs: 8000 });
  assert.equal(grant.from?.sessionId ?? grant.fromSessionId, MANAGER_SESSION, 'join-grant 由站长席位签发');
  await waitFor(() => member.sentFrames.find((frame) => frame.type === 'join-confirm'
    && frame.payload?.joinId === grant.payload.joinId) ?? null, { timeoutMs: 8000 });
  await waitRosterHas(manager, collabId, [MANAGER_SESSION, sessionId]);
}

test('建协指名远端会话：邀请帧携 inviteId、站长簿记 open、受邀机挂起登记，approve 两段式成席', { timeout: TIMEOUT_MS }, async (t) => {
  const { manager, member } = await startPair(t);
  const created = await createInviting(manager, member, '建协首邀', { targetSessionId: 'seat-b2' });
  const entry = inviteEntryOf(created);

  const arrived = await waitForInjection(
    member,
    'seat-b2',
    (list) => list.find((item) => item.type === 'invite' && item.payload?.inviteId === entry.inviteId) ?? null,
    { timeoutMs: 8000 },
  );
  assert.equal(arrived.frame.from.sessionId, MANAGER_SESSION, '首邀由站长席位签发');

  assertInviteRecordOpen(manager, member, created, entry);
  await assertPendingInviteHeld(member, created.collabId, 'seat-b2', entry.inviteId);
  await settleInvitedSeat(manager, member, created.collabId, entry.inviteId, 'seat-b2');

  const view = await manager.service.view({ collabId: created.collabId });
  assert.equal(view.ledger.members.length, 2, '站长与受邀会话各占一席');
  const after = invitesBookOf(manager.home, created.collabId).invites.find((row) => row.inviteId === entry.inviteId);
  assert.deepEqual(after.acceptedSessions, [{ instanceId: member.self.instanceId, sessionId: 'seat-b2' }], '成席后登记已接受');
});

test('建协首邀发送失败：撤回邀请记录，invites.json 不留 open 残留', { timeout: TIMEOUT_MS }, async (t) => {
  const made = makeService(t, { failInvites: true });
  const created = made.service.create({
    name: '首邀失败',
    topic: '首邀失败主题',
    targets: [REMOTE_TARGET],
    mode: 'managed',
    sessionId: MANAGER_SESSION,
  });
  assert.equal(created.ok, true, String(created.message));
  assert.equal(created.invited[0].ok, false, '发送失败如实回报');
  assert.match(String(created.invited[0].reason), /模拟入队失败/, '如实回报发送面给出的原因');
  assert.match(String(created.invited[0].inviteId), /^inv-/, '失败条目仍可追溯尝试过的邀请键');

  const book = invitesBookOf(made.dir, created.collabId);
  assert.deepEqual(openRecordsOf(book), [], '发送失败不得留下可接受的 open 记录');
  const record = book.invites.find((row) => row.inviteId === created.invited[0].inviteId);
  assert.equal(record?.state, 'withdrawn', '未投递的邀请记录置 withdrawn');
});

test('建协首邀簿记写入失败：不发邀请并返回明确原因', { timeout: TIMEOUT_MS }, async (t) => {
  const made = makeService(t);
  const created = made.service.create({
    name: '首邀簿记失败',
    topic: '首邀簿记失败主题',
    targets: [REMOTE_TARGET],
    mode: 'managed',
    sessionId: MANAGER_SESSION,
  });
  assert.equal(created.ok, true, String(created.message));

  /* 用目录占住 invites.json：原子替换的 rename 必失败，模拟磁盘写失败。 */
  const file = invitesFilePath(made.dir, created.collabId);
  rmSync(file, { force: true });
  mkdirSync(file, { recursive: true });
  const sentBefore = made.sent.length;

  const opened = made.service.join.openInitialInvite({
    collabId: created.collabId,
    managerSessionId: MANAGER_SESSION,
    targetInstanceId: 'inst-c',
  });
  assert.equal(opened.ok, false);
  assert.match(String(opened.message), /邀请簿记写入失败/);
  assert.equal(made.sent.length, sentBefore, '簿记写不进去不得再发邀请帧');
});

test('讨论建协：邀请无 inviteId 且不写 invites.json（D18）', { timeout: TIMEOUT_MS }, async (t) => {
  const made = makeService(t);
  const created = made.service.create({
    name: '讨论首邀',
    topic: '讨论首邀主题',
    targets: [REMOTE_TARGET],
    mode: 'forum',
    sessionId: MANAGER_SESSION,
  });
  assert.equal(created.ok, true, String(created.message));
  assert.equal(created.invited[0].ok, true, String(created.invited[0].reason));
  assert.equal(created.invited[0].inviteId, undefined, 'forum 不生成、不返回 inviteId');

  const inviteFrame = made.sent.find((message) => message.type === 'invite');
  assert.ok(inviteFrame !== undefined, '讨论邀请照常发出');
  assert.equal(inviteFrame.payload.inviteId, undefined, '讨论邀请载荷不得携 inviteId');
  assert.equal(existsSync(invitesFilePath(made.dir, created.collabId)), false, 'forum 不写 invites.json');
});

/* 邀请来源校验按席位键（设计 §2.2/D13）：members 里含同一机器，不等于含发信的那个会话。 */
function inviteAdmissionFrame({ from, members, targets = [{ instanceId: SELF.instanceId }] }) {
  return {
    v: 1,
    cap: 2,
    type: 'invite',
    msgId: `inv-gate-${Math.random().toString(16).slice(2)}`,
    from,
    collabId: 'collab-invite-source-gate',
    ts: new Date().toISOString(),
    payload: { name: '来源校验', topic: '来源校验主题', mode: 'managed', members, targets },
  };
}

test('邀请来源按席位校验：同机非发起会话被拒、站长席位通过、旧帧退回实例判据', { timeout: TIMEOUT_MS }, async (t) => {
  const made = makeService(t);
  const members = [{ instanceId: 'inst-a', sessionId: MANAGER_SESSION, identityName: '主机甲' }];
  const fromOf = (sessionId) => ({
    instanceId: 'inst-a', identityName: '主机甲', port: 17400,
    ...(sessionId === undefined ? {} : { sessionId }),
  });
  const sourceOf = { remoteAddress: '127.0.0.1' };

  const other = await made.service.hooks.admit(
    inviteAdmissionFrame({ from: fromOf('sess-other'), members }),
    sourceOf,
  );
  assert.equal(other.ok, false, '同机未入席会话不得借站长机器身份通过来源校验');
  assert.match(String(other.reason), /名单/, String(other.reason));

  const manager = await made.service.hooks.admit(
    inviteAdmissionFrame({ from: fromOf(MANAGER_SESSION), members }),
    sourceOf,
  );
  assert.equal(manager.ok, true, String(manager.reason));

  const legacy = await made.service.hooks.admit(
    inviteAdmissionFrame({ from: fromOf(undefined), members }),
    sourceOf,
  );
  assert.equal(legacy.ok, true, '无 sessionId 的旧帧退回实例判据');

  /* 旧版成员表条目（只有 instanceId）只在绕过协议校验的直喂面出现：协议层要求邀请 members
   * 为席位条目，因此该兜底不是网络可达的冒充路径。 */
  const legacyMembers = await made.service.hooks.admit(
    inviteAdmissionFrame({ from: fromOf('sess-other'), members: [{ instanceId: 'inst-a', identityName: '主机甲' }] }),
    sourceOf,
  );
  assert.equal(legacyMembers.ok, true, '旧版实例条目名单退回实例判据');
});

test('建协不指名：同一 inviteId 下两个受邀会话各自同意成席', { timeout: TIMEOUT_MS }, async (t) => {
  const { manager, member } = await startPair(t);
  const created = await createInviting(manager, member, '建协不指名');
  const entry = inviteEntryOf(created);

  for (const sessionId of ['seat-b1', 'seat-b2']) {
    await waitForInjection(
      member,
      sessionId,
      (list) => list.find((item) => item.type === 'invite' && item.payload?.inviteId === entry.inviteId) ?? null,
      { timeoutMs: 8000 },
    );
  }

  for (const sessionId of ['seat-b1', 'seat-b2']) {
    const accepted = await member.service.join.acceptInvite({
      collabId: created.collabId,
      inviteId: entry.inviteId,
      sessionId,
    });
    assert.equal(accepted.ok, true, String(accepted.message));
  }

  await waitRosterHas(manager, created.collabId, [MANAGER_SESSION, 'seat-b1', 'seat-b2']);
  const view = await manager.service.view({ collabId: created.collabId });
  assert.equal(view.ledger.members.filter((seat) => seat.sessionId !== MANAGER_SESSION).length, 2);
  const record = invitesBookOf(manager.home, created.collabId).invites.find((row) => row.inviteId === entry.inviteId);
  assert.deepEqual(
    record.acceptedSessions.map((seat) => seat.sessionId).sort(),
    ['seat-b1', 'seat-b2'],
    '不指名邀请保持 open，两个会话都登记为已接受',
  );
});

test('建协首邀的邀请簿记可跨核重启读回（撤回面按恢复记录工作）', { timeout: TIMEOUT_MS }, async (t) => {
  const first = makeService(t);
  const created = first.service.create({
    name: '首邀重启',
    topic: '首邀重启主题',
    targets: [REMOTE_TARGET],
    mode: 'managed',
    sessionId: MANAGER_SESSION,
  });
  assert.equal(created.ok, true, String(created.message));
  const inviteId = created.invited[0].inviteId;

  const restarted = createCollabService({
    dataDir: first.dir,
    config: sessionNodeConfig({ inviteTtlMs: 120000 }),
    self: SELF,
    send: () => ({ ok: true, msgId: 'm' }),
    sendDirect: () => ({ ok: true, msgId: 'd' }),
    knownHosts: { remember: () => {}, lookup: () => undefined },
    notify: () => true,
    deliverSeat: () => true,
    log: quietLog(),
    syncPeerPicker: () => [],
    inviteMinIntervalMs: 0,
  });
  /* 撤回面只按 inviteId 工作：能撤回即证明重启后从 invites.json 恢复了该条 open 记录。 */
  const withdrawn = restarted.join.withdrawInitialInvite({ collabId: created.collabId, inviteId });
  assert.equal(withdrawn.ok, true, String(withdrawn.message));
  const book = invitesBookOf(first.dir, created.collabId);
  assert.equal(book.invites.find((row) => row.inviteId === inviteId)?.state, 'withdrawn');
});
