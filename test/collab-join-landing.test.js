import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { carrierFilePath, collabDir, pendingInvitesFilePath } from '../src/paths.js';
import { createCollabService } from '../src/collab/service.js';
import { classifyCollabDir } from '../src/collab/legacy.js';
import { loadSeats } from '../src/collab/local.js';
import { validateMessage } from '../src/net/protocol.js';
import { MIGRATION_FILE_NAME } from '../src/collab/migration.js';
import { makeTempDir } from './helpers.js';

/* 邀请落点的目录形态（设计 §4.2/§8）：挂起邀请目录必须是合法的 invite-stub（或升级后的
 * session-seats），任何拒绝路径都不得留下「只有 member.json」的目录——那会被重启判定成
 * 0.1.x 协作永久归档；载体写失败必须留下显式的 recovery 标记，而不是静默变成别的东西。 */

const SELF = { instanceId: 'inst-self', identityName: '本机' };
const MANAGER = { instanceId: 'inst-a', identityName: '主机甲', port: 17321, sessionId: 'sess-manager-a' };
const FORUM_COLLAB = 'collab-forum-landing';
const AMBIGUOUS_COLLAB = 'collab-ambiguous-landing';
const FAILED_CARRIER_COLLAB = 'collab-carrier-failed';
const MEMBER_DIR_COLLAB = 'collab-member-dir';
const TS = new Date('2026-10-21T00:00:00.000Z').toISOString();

function quietLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function makeService(t, overrides = {}) {
  const dir = overrides.dir ?? makeTempDir(t);
  const sent = [];
  const deliveries = [];
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
    notify: () => true,
    deliverSeat: (frame, seat) => {
      deliveries.push({ sessionId: seat.sessionId, type: frame.type, frame });
      return true;
    },
    log: quietLog(),
    ledgerFetchTimeoutMs: 60,
    inviteMinIntervalMs: 0,
    syncPeerPicker: () => [],
  });
  return { dir, service, sent, deliveries };
}

async function receive(service, frame) {
  const admitted = await service.hooks.admit(frame, { remoteAddress: '127.0.0.1' });
  if (admitted?.ok === true) {
    await service.hooks.consume(frame, { remoteAddress: '127.0.0.1' });
  }
  return admitted;
}

function inviteFrameOf(collabId, { name, topic, mode = 'managed', targets, inviteId } = {}) {
  const payload = {
    name: name ?? '邀请落点',
    topic: topic ?? '邀请落点主题',
    mode,
    members: [
      { instanceId: MANAGER.instanceId, identityName: MANAGER.identityName },
      { instanceId: SELF.instanceId, identityName: SELF.identityName },
    ],
  };
  if (targets !== undefined) {
    payload.targets = targets;
  }
  if (inviteId !== undefined) {
    payload.inviteId = inviteId;
  }
  return {
    v: 1, cap: 2, type: 'invite', msgId: `inv-${collabId}-${Math.random().toString(16).slice(2)}`,
    from: { ...MANAGER }, collabId, ts: TS, payload,
  };
}

function writeJsonFile(file, value) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function carrierOf(collabId, overrides = {}) {
  return {
    format: 'session-seats',
    version: 1,
    collabId,
    name: '成员目录',
    topic: '成员目录主题',
    mode: 'managed',
    endpoints: {},
    manager: { instanceId: MANAGER.instanceId, sessionId: 'sess-manager-a', identityName: MANAGER.identityName, term: 1 },
    snapshotVersion: 1,
    createdAt: TS,
    ...overrides,
  };
}

function memberRecordOf(collabId, role = 'member') {
  return {
    collabId,
    name: '成员目录',
    role,
    state: 'active',
    manager: { instanceId: MANAGER.instanceId, identityName: MANAGER.identityName },
    endpoints: {},
    roster: [{ instanceId: MANAGER.instanceId, identityName: MANAGER.identityName }],
    mode: 'managed',
    decision: null,
    topic: '成员目录主题',
  };
}

function seatFileOf(sessionId, role = 'member', overrides = {}) {
  return {
    version: 1, sessionId, role, state: 'member', joinSeq: 2, joinedAt: TS, muted: false, ...overrides,
  };
}

/* —— I-1：论坛邀请接受后升级为 session-seats，重启后讨论仍在 —— */

test('论坛邀请：接受后目录升级 session-seats，重启后讨论与席位都读回', async (t) => {
  const made = makeService(t);
  const admitted = await receive(made.service, inviteFrameOf(FORUM_COLLAB, { name: '论坛落点', topic: '讨论主题', mode: 'forum' }));
  assert.equal(admitted.ok, true, admitted.reason);
  assert.equal(classifyCollabDir(collabDir(made.dir, FORUM_COLLAB)).kind, 'invite-stub', '邀请落点先是 invite-stub');

  const sessionId = 'forum-session-1';
  await made.service.allowNextInvite({ collabId: FORUM_COLLAB, sessionId });
  const approved = await made.service.approve({ collabId: FORUM_COLLAB, approve: true, sessionId });
  assert.equal(approved.ok, true, approved.message);
  assert.equal(approved.joined, true, '讨论同意＝本地入席');

  assert.equal(
    JSON.parse(readFileSync(carrierFilePath(made.dir, FORUM_COLLAB), 'utf8')).format,
    'session-seats',
    '接受后载体升级为 session-seats（设计 §4.2「首次真正入席时原子替换」）',
  );
  assert.equal(classifyCollabDir(collabDir(made.dir, FORUM_COLLAB)).kind, 'session-seats');
  assert.equal(existsSync(join(collabDir(made.dir, FORUM_COLLAB), MIGRATION_FILE_NAME)), false, '不得被归档为旧协作');

  const restarted = makeService(t, { dir: made.dir });
  assert.equal(restarted.service.stats().legacyCollabs, 0, '重启不得判 legacy');
  assert.equal(restarted.service.stats().collabs, 1, '重启后讨论仍被加载');
  const entry = restarted.service.list({ sessionId }).collabs.find((row) => row.collabId === FORUM_COLLAB);
  assert.ok(entry !== undefined, '重启后讨论仍在列表中');
  assert.equal(entry.mode, 'forum');
  assert.equal(entry.name, '论坛落点');
  assert.equal(entry.sessions.localSeats.some((seat) => seat.sessionId === sessionId), true, '重启后本会话席位仍在');
});

/* —— I-3a：歧义拒绝也先落合法载体，不留「只有 member.json」的幻影目录 —— */

test('邀请目标短码歧义：拒绝后目录仍是 invite-stub，重启不归档', async (t) => {
  const made = makeService(t);
  await made.service.registerBridgeEntry('abcdef12-one', 'bridge-one');
  await made.service.registerBridgeEntry('abcdef12-two', 'bridge-two');
  const admitted = await receive(made.service, inviteFrameOf(AMBIGUOUS_COLLAB, {
    inviteId: 'inv-ambiguous-1',
    targets: [{ instanceId: SELF.instanceId, targetSessionId: 'abcdef12' }],
  }));
  assert.equal(admitted.ok, true, admitted.reason);
  assert.equal(made.service.join.pendingInvitesFor({ collabId: AMBIGUOUS_COLLAB, sessionId: 'abcdef12-one' }).length, 0, '歧义不登记挂起邀请');

  assert.equal(
    classifyCollabDir(collabDir(made.dir, AMBIGUOUS_COLLAB)).kind,
    'invite-stub',
    '事件面仍会建成员记录，但载体已先落 invite-stub——不得落成 legacy',
  );
  assert.equal(existsSync(join(collabDir(made.dir, AMBIGUOUS_COLLAB), MIGRATION_FILE_NAME)), false);

  const restarted = makeService(t, { dir: made.dir });
  assert.equal(restarted.service.stats().legacyCollabs, 0, '重启不写归档标记');
  assert.equal(restarted.service.stats().collabs, 0, 'invite-stub 不参与加载（也不进旧版只读列表）');
});

/* —— I-3b：载体写失败＝显式 recovery（只读可恢复），不是静默变化 —— */

test('邀请落点载体写失败：写 recovery 标记，重启按恢复态只读而非 legacy 归档', async (t) => {
  const made = makeService(t);
  await made.service.registerBridgeEntry('target-session-1', 'bridge-target');
  /* 用目录占住 carrier.json：原子替换的 rename 必失败（跨平台 EISDIR/EPERM），模拟磁盘写失败。
   * 这个形态在准入面本身就会判 corrupt 而拒收（写门 fail-closed），真实竞态是「准入时目录尚可写、
   * 写入时失败」，因此直接走消费面验证写失败的收口（准入面另有歧义用例覆盖完整管线）。 */
  const dir = collabDir(made.dir, FAILED_CARRIER_COLLAB);
  mkdirSync(join(dir, 'carrier.json', 'blocker'), { recursive: true });

  const frame = inviteFrameOf(FAILED_CARRIER_COLLAB, {
    inviteId: 'inv-carrier-failed-1',
    targets: [{ instanceId: SELF.instanceId, targetSessionId: 'target-session-1' }],
  });
  await made.service.hooks.consume(frame, { remoteAddress: '127.0.0.1' });
  assert.equal(classifyCollabDir(dir).kind, 'recovery', '载体写失败必须留下显式恢复标记');
  assert.equal(existsSync(join(dir, 'recovery.json')), true, 'recovery.json 已落盘（跨重启可读）');
  assert.equal(existsSync(join(dir, MIGRATION_FILE_NAME)), false);
  assert.equal(
    made.service.join.pendingInvitesFor({ collabId: FAILED_CARRIER_COLLAB, sessionId: 'target-session-1' }).length,
    0,
    '载体未落成的邀请不登记为可接受（否则接受时会因只读写门失败）',
  );

  const restarted = makeService(t, { dir: made.dir });
  const stats = restarted.service.stats();
  assert.equal(stats.legacyCollabs, 0, '重启不得归档为旧版');
  assert.equal(stats.recoveryCollabs, 1, '重启按恢复态只读登记');
});

/* —— I-4：载体丢失的真实成员目录不得被当邀请落点放行 —— */

test('真实成员目录丢 carrier：写门拒绝（不得因 pending-invites 在场 fail-open）', async (t) => {
  const made = makeService(t);
  const dir = collabDir(made.dir, MEMBER_DIR_COLLAB);
  writeJsonFile(carrierFilePath(made.dir, MEMBER_DIR_COLLAB), carrierOf(MEMBER_DIR_COLLAB));
  writeJsonFile(join(dir, 'member.json'), memberRecordOf(MEMBER_DIR_COLLAB, 'member'));
  writeJsonFile(join(dir, 'seats', 'sess-member-a.json'), seatFileOf('sess-member-a'));
  writeJsonFile(pendingInvitesFilePath(made.dir, MEMBER_DIR_COLLAB), { version: 1, invites: [] });

  const loaded = makeService(t, { dir: made.dir });
  assert.equal(loaded.service.stats().collabs, 1, '成员目录正常加载（判档 session-seats）');
  rmSync(carrierFilePath(made.dir, MEMBER_DIR_COLLAB), { force: true });
  assert.equal(classifyCollabDir(dir).kind, 'legacy', '运行中丢载体＝legacy 判档');

  const wrote = loaded.service.setMute({ collabId: MEMBER_DIR_COLLAB, sessionId: 'sess-member-a', muted: true });
  assert.equal(wrote.ok, false, '真实成员目录丢载体后必须拒绝写');
  assert.match(wrote.message, /旧版/, '按 legacy 只读拒绝，不得按邀请落点放行');
  assert.equal(loaded.service.stats().legacyWriteRejected, 1);
});

/* —— I-5：成员目录判档按「carrier ＋ 席位/快照证据」而非 member.json —— */

test('目录判档：carrier＋席位无 member.json 判 session-seats（成员目录合法形态）', (t) => {
  const root = makeTempDir(t);
  const dir = join(root, MEMBER_DIR_COLLAB);
  writeJsonFile(join(dir, 'carrier.json'), carrierOf(MEMBER_DIR_COLLAB));
  writeJsonFile(join(dir, 'seats', 'sess-member-a.json'), seatFileOf('sess-member-a'));
  assert.equal(classifyCollabDir(dir).kind, 'session-seats');
});

test('目录判档：member.json 解析失败不单独导致 recovery（席位证据仍在）', (t) => {
  const root = makeTempDir(t);
  const dir = join(root, MEMBER_DIR_COLLAB);
  writeJsonFile(join(dir, 'carrier.json'), carrierOf(MEMBER_DIR_COLLAB));
  writeJsonFile(join(dir, 'seats', 'sess-member-a.json'), seatFileOf('sess-member-a'));
  writeFileSync(join(dir, 'member.json'), '{ 损坏的 JSON', 'utf8');
  assert.equal(classifyCollabDir(dir).kind, 'session-seats');
});

test('目录判档：站长目录丢台账仍 recovery（站长席位/成员记录不得被当成员目录）', (t) => {
  const root = makeTempDir(t);
  const withMember = join(root, 'manager-with-member');
  writeJsonFile(join(withMember, 'carrier.json'), carrierOf('manager-with-member'));
  writeJsonFile(join(withMember, 'member.json'), memberRecordOf('manager-with-member', 'manager'));
  writeJsonFile(join(withMember, 'seats', 'sess-manager-a.json'), seatFileOf('sess-manager-a', 'manager'));
  writeJsonFile(join(withMember, 'snapshot.json'), { version: 1, ledger: { members: [] } });
  assert.equal(classifyCollabDir(withMember).kind, 'recovery');

  const seatOnly = join(root, 'manager-seat-only');
  writeJsonFile(join(seatOnly, 'carrier.json'), carrierOf('manager-seat-only'));
  writeJsonFile(join(seatOnly, 'seats', 'sess-manager-a.json'), seatFileOf('sess-manager-a', 'manager'));
  writeJsonFile(join(seatOnly, 'snapshot.json'), { version: 1, ledger: { members: [] } });
  assert.equal(classifyCollabDir(seatOnly).kind, 'recovery', '无 member.json 时按席位角色识别站长目录');
});

/* —— 注册补投（设计 §4.2）：会话注册时把本机挂起邀请按簿记语义重投 —— */

test('挂起邀请补投：离线非席位目标在桥注册时收到指名邀请并可接受', async (t) => {
  const made = makeService(t);
  const collabId = 'collab-replay-named';
  const admitted = await receive(made.service, inviteFrameOf(collabId, {
    inviteId: 'inv-replay-named-1',
    targets: [{ instanceId: SELF.instanceId, targetSessionId: 'seat-late' }],
  }));
  assert.equal(admitted.ok, true, admitted.reason);
  assert.equal(made.deliveries.filter((entry) => entry.type === 'invite').length, 0, '目标未注册：本次不注入');
  assert.equal(made.service.join.pendingInvitesFor({ collabId, sessionId: 'seat-late' }).length, 1);

  const registered = await made.service.registerBridgeEntry('seat-late', 'bridge-late');
  assert.equal(registered.ok, true);
  assert.equal(registered.invites, 1, '注册即补投');
  const delivered = made.deliveries.filter((entry) => entry.type === 'invite' && entry.sessionId === 'seat-late');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].frame.payload.inviteId, 'inv-replay-named-1');
  assert.deepEqual(delivered[0].frame.payload.targets, [{ instanceId: SELF.instanceId, targetSessionId: 'seat-late' }]);
  assert.equal(delivered[0].frame.from.sessionId, MANAGER.sessionId, '补投帧 from 必携签发会话（协议域帧）');
  assert.deepEqual(
    delivered[0].frame.payload.members,
    [{ instanceId: MANAGER.instanceId, sessionId: MANAGER.sessionId, identityName: MANAGER.instanceId }],
    'members 为席位条目（携 sessionId），不随补投丢席位键',
  );
  assert.equal(validateMessage(delivered[0].frame).ok, true, '补投帧须过真实协议校验');

  const accepted = await made.service.join.acceptInvite({ collabId, inviteId: 'inv-replay-named-1', sessionId: 'seat-late' });
  assert.equal(accepted.ok, true, accepted.message);
  assert.ok(made.sent.some((message) => message.type === 'approve'), '接受后回 approve 给邀请方');
});

test('挂起邀请补投：不指名邀请对每个注册会话各投一次，投出不消费记录', async (t) => {
  const made = makeService(t);
  const collabId = 'collab-replay-broadcast';
  const admitted = await receive(made.service, inviteFrameOf(collabId, { inviteId: 'inv-replay-broadcast-1' }));
  assert.equal(admitted.ok, true, admitted.reason);

  const first = await made.service.registerBridgeEntry('seat-a', 'bridge-a');
  assert.equal(first.invites, 1, '首个注册会话收到补投');
  assert.equal(made.service.join.pendingInvitesFor({ collabId, sessionId: 'seat-b' }).length, 1, '不指名邀请不因一次投出失效');

  const second = await made.service.registerBridgeEntry('seat-b', 'bridge-b');
  assert.equal(second.invites, 1, '后续注册会话同样收到补投');
  for (const sessionId of ['seat-a', 'seat-b']) {
    const delivered = made.deliveries.filter((entry) => entry.type === 'invite' && entry.sessionId === sessionId);
    assert.equal(delivered.length, 1, `${sessionId} 各收一份`);
    assert.equal(delivered[0].frame.payload.inviteId, 'inv-replay-broadcast-1');
    assert.equal(delivered[0].frame.payload.targets[0].targetSessionId, undefined, '不指名邀请的目标描述不指名');
  }
});

/* —— I-9：席位加载上限只约束非归档席位 —— */

test('席位加载上限只计非归档席位：32+ 归档不挤掉活跃席', (t) => {
  const root = makeTempDir(t);
  const collabId = 'collab-archived-seats';
  const seatDir = join(collabDir(root, collabId), 'seats');
  mkdirSync(seatDir, { recursive: true });
  for (let index = 0; index < 33; index++) {
    const sessionId = `arch-${String(index).padStart(2, '0')}`;
    writeJsonFile(join(seatDir, `${sessionId}.json`), seatFileOf(sessionId, 'member', { archivedAt: TS }));
  }
  const archivedOnly = loadSeats(root, collabId);
  assert.equal(archivedOnly.seats.size, 33, '归档席位全部载入（历史保留，不占活跃上限）');
  assert.equal(archivedOnly.corrupt, 0, '归档席位不计入超限丢弃');

  writeJsonFile(join(seatDir, 'zzzz-active.json'), seatFileOf('zzzz-active'));
  const withActive = loadSeats(root, collabId);
  assert.equal(withActive.seats.size, 34);
  assert.equal(withActive.seats.has('zzzz-active'), true, '第 33 个之后出现/加载的活跃席仍被读入');
  assert.equal(withActive.corrupt, 0);
});
