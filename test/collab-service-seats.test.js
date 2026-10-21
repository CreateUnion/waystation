import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collabDir, carrierFilePath, runDir } from '../src/paths.js';
import { makeTempDir } from './helpers.js';
import { createCollabService } from '../src/collab/service.js';
import { readCarrierFormat } from '../src/collab/carrier.js';
import { readMigration, readRecovery } from '../src/collab/migration.js';
import { seatFilePath } from '../src/paths.js';

/* M2 运行时席位与本地投递：席位载入/派生、本机旁路、暂存补投、桥注册、核心存续、legacy/recovery 写门、
 * 绑定表退役与新建协作的载体/席位落盘。夹具直接落新形态文件（M1 台账形态 + M8 载体标记）。 */

const NOW = '2026-10-21T08:00:00.000Z';

function quietLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function makeService(t, overrides = {}) {
  const dir = makeTempDir(t);
  const delivered = [];
  const controller = { online: overrides.online ?? true };
  const service = createCollabService({
    dataDir: dir,
    config: { sessionSeatGraceMs: 60000, stagedMaxPerSeat: 100, stagedMaxPerCollab: 500, ...(overrides.config ?? {}) },
    self: { instanceId: 'inst-self', identityName: '本机', port: 17321 },
    send: () => ({ ok: true, msgId: 'q-1' }),
    sendDirect: () => ({ ok: true, msgId: 'd-1' }),
    knownHosts: overrides.knownHosts ?? { remember: () => {} },
    notify: () => true,
    probeCapability: overrides.probeCapability ?? null,
    deliverSeat: overrides.deliverSeat ?? ((frame, seat) => {
      if (!controller.online) {
        return false;
      }
      delivered.push({ sessionId: seat.sessionId, msgId: frame?.msgId ?? null, type: frame?.type ?? null });
      return true;
    }),
    deliveryStatusOf: overrides.deliveryStatusOf ?? null,
    localSeatDeliveryOf: overrides.localSeatDeliveryOf ?? null,
    log: quietLog(),
    syncPeerPicker: () => [],
  });
  return { service, dir, delivered, controller };
}

function writeJson(file, value) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function ensureSeatDir(dir, collabId) {
  mkdirSync(join(collabDir(dir, collabId), 'seats'), { recursive: true });
}

function seatOf(sessionId, overrides = {}) {
  return {
    version: 1,
    sessionId,
    role: 'member',
    state: 'member',
    joinSeq: 2,
    joinedAt: NOW,
    muted: false,
    ...overrides,
  };
}

function writeSeat(dir, collabId, seat) {
  ensureSeatDir(dir, collabId);
  writeJson(seatFilePath(dir, collabId, seat.sessionId), seat);
}

function ledgerOf(collabId, { status = 'active', managerSessionId = 'sess-mgr' } = {}) {
  return {
    version: 2,
    managerTerm: 1,
    joinSeqNext: 3,
    collabId,
    name: '联调项目',
    topic: '发布联调',
    mode: 'managed',
    status,
    manager: { instanceId: 'inst-self', sessionId: managerSessionId, identityName: '本机', term: 1 },
    members: [
      { instanceId: 'inst-self', sessionId: managerSessionId, identityName: '本机', role: 'manager', state: 'member', joinSeq: 1, joinedAt: NOW },
      { instanceId: 'inst-self', sessionId: 'sess-dev', identityName: '本机', role: 'member', state: 'member', joinSeq: 2, joinedAt: NOW },
    ],
    board: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function carrierOf(collabId) {
  return {
    format: 'session-seats',
    version: 1,
    collabId,
    name: '联调项目',
    topic: '发布联调',
    mode: 'managed',
    endpoints: {},
    snapshotVersion: 1,
    createdAt: NOW,
  };
}

/* 双席夹具：一场站长席 + 一场成员席，均在本机；台账名单与新形态一致。 */
function seedTwoSeats(dir, collabId = 'collab-seats') {
  mkdirSync(collabDir(dir, collabId), { recursive: true });
  writeJson(carrierFilePath(dir, collabId), carrierOf(collabId));
  writeJson(join(collabDir(dir, collabId), 'ledger.jsonl'), ledgerOf(collabId));
  // ledger.jsonl 是逐行 JSON；上面的整档 JSON 也是单行合法台账（写一次变更）
  writeJson(join(collabDir(dir, collabId), 'snapshot.json'), {
    version: 2,
    digest: 'a'.repeat(64),
    receivedAt: NOW,
    from: { instanceId: 'inst-self', identityName: '本机' },
    ledger: ledgerOf(collabId),
  });
  writeSeat(dir, collabId, seatOf('sess-mgr', { role: 'manager', joinSeq: 1, muted: true }));
  writeSeat(dir, collabId, seatOf('sess-dev'));
  return collabId;
}

function injectFrame(msgId, fromSessionId = 'sess-peer', type = 'notice') {
  return {
    v: 1,
    type,
    msgId,
    collabId: 'collab-seats',
    from: { instanceId: 'inst-peer', sessionId: fromSessionId, identityName: '对端', port: 17322 },
    payload: { text: '内容' },
  };
}

function sessionIds(seats) {
  return seats.map((seat) => seat.sessionId).sort();
}

test('席位载入：双席、站长席派生、角色从席位派生（local.role 不再是独立事实）', async (t) => {
  const { dir } = makeService(t);
  const collabId = seedTwoSeats(dir);
  const reloaded = createCollabService({
    dataDir: dir,
    config: {},
    self: { instanceId: 'inst-self', identityName: '本机', port: 17321 },
    send: () => ({ ok: true }),
    sendDirect: () => ({ ok: true }),
    knownHosts: { remember: () => {} },
    notify: () => true,
    log: quietLog(),
    syncPeerPicker: () => [],
  });
  assert.deepEqual(sessionIds(reloaded.listLocalSeats(collabId)), ['sess-dev', 'sess-mgr']);
  const manager = reloaded.managerSeatOf(collabId);
  assert.equal(manager.sessionId, 'sess-mgr');
  assert.equal(manager.role, 'manager');
  assert.equal(reloaded.localSeatOf(collabId, 'sess-dev').role, 'member');
  assert.equal(reloaded.localSeatOf(collabId, 'sess-nobody'), null);
  const entry = reloaded.list().collabs.find((item) => item.collabId === collabId);
  assert.equal(entry.role, 'manager', '本机有站长席 → 派生角色为 manager');
  assert.equal(entry.muted, true, '静音按席位聚合（站长席静音）');
  assert.deepEqual(reloaded.listLocalSeats('collab-none'), []);
  reloaded.close();
});

test('本机旁路：同机双席各自注入、同 msgId 去重、发送会话不给自己投递', async (t) => {
  const { service, dir, delivered } = makeService(t);
  const collabId = seedTwoSeats(dir);
  const reloaded = reopen(t, dir, delivered);
  await reloaded.registerBridgeEntry('sess-mgr', 'bridge-mgr');
  await reloaded.registerBridgeEntry('sess-dev', 'bridge-dev');

  const first = await reloaded.injectLocalSeat(collabId, 'sess-dev', injectFrame('msg-1'));
  assert.deepEqual(first, { ok: true, delivered: true });
  const duplicate = await reloaded.injectLocalSeat(collabId, 'sess-dev', injectFrame('msg-1'));
  assert.deepEqual(duplicate, { ok: true, duplicate: true });
  const managerCopy = await reloaded.injectLocalSeat(collabId, 'sess-mgr', injectFrame('msg-1'));
  assert.deepEqual(managerCopy, { ok: true, delivered: true });
  const selfCopy = await reloaded.injectLocalSeat(collabId, 'sess-dev', injectFrame('msg-2', 'sess-dev'));
  assert.deepEqual(selfCopy, { ok: true, skipped: 'self' });

  assert.deepEqual(delivered.map((item) => [item.sessionId, item.msgId]), [['sess-dev', 'msg-1'], ['sess-mgr', 'msg-1']]);
  assert.equal(reloaded.stats().seatsInjected, 2);
  assert.equal(reloaded.stats().seatDuplicates, 1);
  assert.equal(reloaded.stats().seatSelfSkipped, 1);
  assert.deepEqual(await reloaded.injectLocalSeat(collabId, 'sess-none', injectFrame('msg-3')), { ok: false, reason: 'no-seat' });
  assert.deepEqual(await reloaded.injectLocalSeat('collab-none', 'sess-dev', injectFrame('msg-4')), { ok: false, reason: 'unknown-collab' });
  assert.deepEqual(await reloaded.injectLocalSeat(collabId, 'bad/session', injectFrame('msg-5')), { ok: false, reason: 'bad-session' });
  reloaded.close();
  service.close();
});

test('暂存与补投：桥离线进暂存、同席按到达序补投、超限丢最旧并计数', async (t) => {
  const { dir, delivered, controller } = makeService(t, { config: { stagedMaxPerSeat: 2, stagedMaxPerCollab: 3 } });
  const collabId = seedTwoSeats(dir);
  const service = reopen(t, dir, delivered, { config: { stagedMaxPerSeat: 2, stagedMaxPerCollab: 3 }, controller });
  controller.online = false;

  for (const msgId of ['m1', 'm2', 'm3', 'm4']) {
    const result = await service.injectLocalSeat(collabId, 'sess-dev', injectFrame(msgId));
    assert.deepEqual(result, { ok: true, staged: true });
  }
  assert.equal(service.stats().seatStagedDropped, 2, '单席上限 2：两帧被丢弃');
  assert.equal(service.stats().seatsStaged, 4);

  controller.online = true;
  const bound = await service.registerBridgeEntry('sess-dev', 'bridge-dev');
  assert.equal(bound.ok, true);
  assert.equal(bound.flushed, 2);
  assert.deepEqual(delivered.map((item) => item.msgId), ['m3', 'm4'], '补投按到达序、丢最旧');

  await service.unregisterBridgeEntry('sess-dev', 'bridge-dev');
  assert.deepEqual(await service.injectLocalSeat(collabId, 'sess-dev', injectFrame('m5')), { ok: true, staged: true });
  await service.registerBridgeEntry('sess-dev', 'bridge-dev');
  assert.deepEqual(delivered.map((item) => item.msgId), ['m3', 'm4', 'm5']);
  service.close();
});

test('暂存：每协作总上限生效（跨席位丢最旧）', async (t) => {
  const { dir, delivered, controller } = makeService(t, { config: { stagedMaxPerSeat: 5, stagedMaxPerCollab: 3 } });
  const collabId = seedTwoSeats(dir);
  const service = reopen(t, dir, delivered, { config: { stagedMaxPerSeat: 5, stagedMaxPerCollab: 3 }, controller });
  controller.online = false;
  for (const msgId of ['a1', 'a2']) {
    await service.injectLocalSeat(collabId, 'sess-mgr', injectFrame(msgId));
  }
  for (const msgId of ['b1', 'b2']) {
    await service.injectLocalSeat(collabId, 'sess-dev', injectFrame(msgId));
  }
  assert.equal(service.stats().seatStagedDropped, 1);
  controller.online = true;
  const bound = await service.registerBridgeEntry('sess-mgr', 'bridge-mgr');
  assert.equal(bound.flushed, 1, '站长席只剩 a2');
  await service.registerBridgeEntry('sess-dev', 'bridge-dev');
  assert.deepEqual(delivered.map((item) => item.msgId), ['a2', 'b1', 'b2']);
  service.close();
});

test('桥注册/注销：按 (sessionId,bridgeId) 绑定与解除；跨协作同会话一起绑定', async (t) => {
  const { dir, delivered } = makeService(t);
  const first = seedTwoSeats(dir, 'collab-a');
  const second = seedTwoSeats(dir, 'collab-b');
  const service = reopen(t, dir, delivered);
  const bound = await service.registerBridgeEntry('sess-dev', 'bridge-dev');
  assert.equal(bound.seats, 2, '同会话在本机两个协作的席位都绑定');
  assert.equal(service.seatsForRouting(first).find((seat) => seat.sessionId === 'sess-dev').bridgeId, 'bridge-dev');

  const wrong = await service.unregisterBridgeEntry('sess-dev', 'bridge-old');
  assert.equal(wrong.cleared, 0, '桥标识不符不解除');
  const cleared = await service.unregisterBridgeEntry('sess-dev', 'bridge-dev');
  assert.equal(cleared.cleared, 2);
  assert.equal(service.seatsForRouting(second).find((seat) => seat.sessionId === 'sess-dev').bridgeId, null);
  service.close();
});

test('会话级静音：逐席栅栏（内容类受抑制、治理豁免）；ws_set_mute 只改本席并落盘', async (t) => {
  const { dir } = makeService(t);
  const collabId = seedTwoSeats(dir);
  const service = reopen(t, dir, []);
  const post = { type: 'post', collabId, from: { sessionId: 'sess-peer' }, payload: {} };
  const notice = { type: 'notice', collabId, from: { sessionId: 'sess-peer' }, payload: {} };
  assert.deepEqual(service.hooks.sessionGate(post, { sessionId: 'sess-mgr' }), { suppress: true }, '站长席静音：内容类抑制');
  assert.deepEqual(service.hooks.sessionGate(post, { sessionId: 'sess-dev' }), { suppress: false }, '成员席未静音：照常注入');
  assert.deepEqual(service.hooks.sessionGate(notice, { sessionId: 'sess-mgr' }), { suppress: false }, '治理/提示类不受静音抑制');

  const unmuted = service.setMute({ collabId, muted: false, sessionId: 'sess-mgr' });
  assert.equal(unmuted.ok, true);
  assert.deepEqual(service.hooks.sessionGate(post, { sessionId: 'sess-mgr' }), { suppress: false });
  const onDisk = JSON.parse(readFileSync(seatFilePath(dir, collabId, 'sess-mgr'), 'utf8'));
  assert.equal(onDisk.muted, false, '静音只改本席位文件');

  assert.equal(service.setMute({ collabId, muted: true, sessionId: 'sess-none' }).ok, false, '无席位拒绝（不改他人）');
  assert.equal(service.setMute({ collabId, muted: true, sessionId: 'sess-dev' }).ok, true);
  assert.deepEqual(service.hooks.sessionGate(post, { sessionId: 'sess-dev' }), { suppress: true });
  assert.equal(JSON.parse(readFileSync(seatFilePath(dir, collabId, 'sess-mgr'), 'utf8')).muted, false, '另一席不受影响');
  service.close();
});

test('核心存续：有活跃席位时返回 max(核心宽限, 席位宽限+10s) 的席位侧下界', async (t) => {
  const { dir } = makeService(t, { config: { sessionSeatGraceMs: 5000 } });
  seedTwoSeats(dir);
  const service = reopen(t, dir, [], { config: { sessionSeatGraceMs: 5000 } });
  assert.equal(service.ensureCoreLifetimeForSeats(), 15000);
  service.close();

  const emptyService = reopen(t, makeTempDir(t), []);
  assert.equal(emptyService.ensureCoreLifetimeForSeats(), 0, '无活跃席位不延长');
  emptyService.close();
});

test('legacy 启动：旧 member.json → 归档只读；写类与入站帧一律拒绝并计数', async (t) => {
  const { dir } = makeService(t);
  const collabId = 'collab-legacy';
  mkdirSync(collabDir(dir, collabId), { recursive: true });
  writeJson(join(collabDir(dir, collabId), 'member.json'), {
    collabId,
    name: '旧协作',
    role: 'manager',
    state: 'active',
    manager: { instanceId: 'inst-old', identityName: '旧机' },
    endpoints: {},
    roster: [{ instanceId: 'inst-old', identityName: '旧机' }],
    mode: 'managed',
    decision: 'approved',
  });

  const service = reopen(t, dir, []);
  assert.equal(readMigration(collabDir(dir, collabId))?.legacy, true, '启动即写 migration.json');
  const legacyEntry = service.list().collabs.find((entry) => entry.collabId === collabId);
  assert.equal(legacyEntry.legacy, true);
  assert.equal(legacyEntry.readOnly, true);
  assert.equal(legacyEntry.state, 'completed');
  assert.equal(service.count(), 0, '旧协作不计入活跃协作');
  assert.equal(service.isWritable(collabId), false);
  assert.equal(service.send({ collabId, text: 'x' }).ok, false);
  assert.match(service.send({ collabId, text: 'x' }).message, /旧版/);

  const admitted = await service.hooks.admit({
    v: 1, type: 'notice', msgId: 'legacy-1', collabId,
    from: { instanceId: 'inst-old', identityName: '旧机', port: 17321 },
    payload: { text: 'x' },
  }, { remoteAddress: '127.0.0.1' });
  assert.equal(admitted.ok, false);
  assert.equal(service.stats().legacyInboundRejected, 1);
  assert.equal(service.stats().legacyWriteRejected >= 1, true);
  const onDisk = JSON.parse(readFileSync(join(collabDir(dir, collabId), 'member.json'), 'utf8'));
  assert.equal(onDisk.state, 'active', '旧记录不被改写');
  service.close();
});

test('半写目录：carrier 已落而台账缺失 → 写 recovery.json、只读、写类拒绝', async (t) => {
  const { dir } = makeService(t);
  const collabId = 'collab-half';
  mkdirSync(collabDir(dir, collabId), { recursive: true });
  writeJson(carrierFilePath(dir, collabId), carrierOf(collabId));
  const service = reopen(t, dir, []);
  assert.equal(readRecovery(collabDir(dir, collabId))?.state, 'half-created');
  assert.equal(service.isWritable(collabId), false);
  assert.match(service.send({ collabId, text: 'x' }).message, /半写|恢复态/);
  service.close();
});

test('损坏目录：carrier 不可读 → 只读并映射「损坏/只读」提示（不改写坏数据）', async (t) => {
  const { dir } = makeService(t);
  const collabId = 'collab-corrupt';
  mkdirSync(collabDir(dir, collabId), { recursive: true });
  writeFileSync(carrierFilePath(dir, collabId), '{ 坏掉的 JSON', 'utf8');
  const service = reopen(t, dir, []);
  assert.equal(service.isWritable(collabId), false);
  assert.match(service.send({ collabId, text: 'x' }).message, /损坏/);
  assert.equal(readFileSync(carrierFilePath(dir, collabId), 'utf8'), '{ 坏掉的 JSON', '损坏文件不被改写');
  service.close();
});

test('绑定表退役：run/bindings.json 不再作为注入来源，文件留盘不被改写', async (t) => {
  const { dir, delivered } = makeService(t);
  const collabId = seedTwoSeats(dir);
  const bindings = { [collabId]: { sessionId: 'sess-other', bridgeId: 'bridge-other', boundAt: NOW, origin: 'create' } };
  mkdirSync(runDir(dir), { recursive: true });
  writeJson(join(runDir(dir), 'bindings.json'), bindings);

  const service = reopen(t, dir, delivered);
  await service.registerBridgeEntry('sess-dev', 'bridge-dev');
  assert.deepEqual(await service.injectLocalSeat(collabId, 'sess-other', injectFrame('x-1')), { ok: false, reason: 'no-seat' });
  assert.deepEqual(await service.injectLocalSeat(collabId, 'sess-dev', injectFrame('x-2')), { ok: true, delivered: true });
  assert.deepEqual(JSON.parse(readFileSync(join(runDir(dir), 'bindings.json'), 'utf8')), bindings, '旧文件留盘不改写');
  service.close();
});

test('新建协作：写 carrier（session-seats）与创建者站长席位', async (t) => {
  const { service, dir } = makeService(t);
  const result = service.create({
    name: '新协作',
    topic: '新主题',
    targets: [{ instanceId: 'inst-peer', identityName: '对端', address: '127.0.0.1', port: 17322 }],
    sessionId: 'sess-creator',
  });
  assert.equal(result.ok, true);
  const dirOfCollab = collabDir(dir, result.collabId);
  assert.equal(readCarrierFormat(dirOfCollab), 'session-seats');
  const carrier = JSON.parse(readFileSync(carrierFilePath(dir, result.collabId), 'utf8'));
  assert.equal(carrier.manager.sessionId, 'sess-creator');
  const seats = service.listLocalSeats(result.collabId);
  assert.equal(seats.length, 1);
  assert.deepEqual(
    { sessionId: seats[0].sessionId, role: seats[0].role, state: seats[0].state, joinSeq: seats[0].joinSeq },
    { sessionId: 'sess-creator', role: 'manager', state: 'member', joinSeq: 1 },
  );
  assert.equal(existsSync(seatFilePath(dir, result.collabId, 'sess-creator')), true);
  assert.equal(service.isWritable(result.collabId), true);
  service.close();
});

test('legacy 台账：启动归档只读，旧 ledger.jsonl 字节不变、不触发损坏隔离', async (t) => {
  const { dir } = makeService(t);
  const collabId = 'collab-old-ledger';
  const legacyDir = collabDir(dir, collabId);
  mkdirSync(legacyDir, { recursive: true });
  const legacyLedger = JSON.stringify({
    version: 3,
    collabId,
    name: '旧协作',
    topic: '旧主题',
    status: 'active',
    manager: { instanceId: 'inst-old', identityName: '旧机' },
    members: [{ instanceId: 'inst-old', identityName: '旧机', role: 'manager', state: 'member', joinedAt: NOW }],
    board: [],
    createdAt: NOW,
    updatedAt: NOW,
  }) + '\n';
  writeJson(join(legacyDir, 'member.json'), {
    collabId, name: '旧协作', role: 'manager', state: 'active',
    manager: { instanceId: 'inst-old', identityName: '旧机' },
    endpoints: {}, roster: [{ instanceId: 'inst-old', identityName: '旧机' }], mode: 'managed',
  });
  writeFileSync(join(legacyDir, 'ledger.jsonl'), legacyLedger, 'utf8');

  const service = reopen(t, dir, []);
  assert.equal(readMigration(legacyDir)?.legacy, true);
  assert.equal(readFileSync(join(legacyDir, 'ledger.jsonl'), 'utf8'), legacyLedger, '旧台账字节不变');
  const quarantined = readdirSync(legacyDir).filter((name) => name.startsWith('ledger.jsonl.corrupt-'));
  assert.deepEqual(quarantined, [], 'legacy 分流先于台账载入：不隔离、不重建');
  assert.equal(service.list().collabs.find((entry) => entry.collabId === collabId)?.legacy, true);
  service.close();
});

test('新形态台账损坏：重建模板为新形态（managerTerm/joinSeqNext/manager.sessionId）', async (t) => {
  const { dir } = makeService(t);
  const collabId = 'collab-rebuild';
  mkdirSync(collabDir(dir, collabId), { recursive: true });
  writeJson(carrierFilePath(dir, collabId), carrierOf(collabId));
  writeSeat(dir, collabId, seatOf('sess-mgr', { role: 'manager', joinSeq: 1 }));
  writeFileSync(join(collabDir(dir, collabId), 'ledger.jsonl'), '{ 坏掉的台账\n', 'utf8');

  const service = reopen(t, dir, []);
  const lines = readFileSync(join(collabDir(dir, collabId), 'ledger.jsonl'), 'utf8').split('\n').filter((line) => line.trim() !== '');
  assert.equal(lines.length, 1, '重建结果落新首行');
  const rebuilt = JSON.parse(lines.at(-1));
  assert.equal(rebuilt.managerTerm, 1);
  assert.equal(rebuilt.joinSeqNext, 2);
  assert.equal(rebuilt.manager.sessionId, 'sess-mgr');
  assert.equal(rebuilt.members[0].joinSeq, 1);
  assert.equal(readdirSync(collabDir(dir, collabId)).some((name) => name.startsWith('ledger.jsonl.corrupt-')), true, '损坏副本保留');
  service.close();
});

/* —— M2 审查修复的判别用例 —— */

function frameFor(collabId, msgId, fromSessionId = 'sess-peer', type = 'notice', payload = { text: '内容' }) {
  return {
    v: 1,
    type,
    msgId,
    collabId,
    from: { instanceId: 'inst-peer', sessionId: fromSessionId, identityName: '对端', port: 17322 },
    payload,
  };
}

test('C-1 新建席位带完整运行态：创建后首次注入不崩溃', async (t) => {
  const { service, delivered } = makeService(t);
  const created = service.create({ name: '新协作', topic: '主题', targets: [{ instanceId: 'inst-peer', identityName: '对端', address: '127.0.0.1', port: 17322 }], sessionId: 'sess-creator' });
  assert.equal(created.ok, true, created.message);
  await service.registerBridgeEntry('sess-creator', 'bridge-creator');
  const injected = await service.injectLocalSeat(created.collabId, 'sess-creator', frameFor(created.collabId, 'm-new-1'));
  assert.deepEqual(injected, { ok: true, delivered: true });
  assert.deepEqual(delivered.map((item) => item.msgId), ['m-new-1']);
  service.close();
});

test('I-2 先注册桥后创建：新席位绑定当前桥，首帧直接交付而非暂存', async (t) => {
  const { service, delivered } = makeService(t);
  await service.registerBridgeEntry('sess-creator', 'bridge-creator');
  const created = service.create({ name: '新协作', topic: '主题', targets: [{ instanceId: 'inst-peer', identityName: '对端', address: '127.0.0.1', port: 17322 }], sessionId: 'sess-creator' });
  assert.equal(created.ok, true);
  assert.equal(service.seatsForRouting(created.collabId)[0].bridgeId, 'bridge-creator');
  assert.deepEqual(await service.injectLocalSeat(created.collabId, 'sess-creator', frameFor(created.collabId, 'm-bind-1')), { ok: true, delivered: true });
  assert.equal(delivered.length, 1);
  service.close();
});

test('I-8 暂存被上限丢弃后释放 msgId：发送方重试不被永久判重', async (t) => {
  const { service, dir, delivered, controller } = makeService(t, { config: { stagedMaxPerSeat: 1 } });
  const collabId = seedTwoSeats(dir);
  const live = reopen(t, dir, delivered, { config: { stagedMaxPerSeat: 1 }, controller });
  controller.online = false;
  assert.deepEqual(await live.injectLocalSeat(collabId, 'sess-dev', frameFor(collabId, 'drop-1')), { ok: true, staged: true });
  assert.deepEqual(await live.injectLocalSeat(collabId, 'sess-dev', frameFor(collabId, 'drop-2')), { ok: true, staged: true });
  assert.equal(live.stats().seatStagedDropped, 1, 'drop-1 被丢弃');
  const retried = await live.injectLocalSeat(collabId, 'sess-dev', frameFor(collabId, 'drop-1'));
  assert.deepEqual(retried, { ok: true, staged: true }, '重试不得命中 duplicate（否则消息永久丢失）');
  assert.equal(live.stats().seatDuplicates, 0);
  controller.online = true;
  await live.registerBridgeEntry('sess-dev', 'bridge-dev');
  assert.deepEqual(delivered.map((item) => item.msgId), ['drop-1'], '重试帧最终补投成功');
  live.close();
  service.close();
});

test('I-7 补投进行中新帧入队尾：交付顺序不越队', async (t) => {
  let release = null;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const delivered = [];
  const deliverSeat = async (frame, seat) => {
    if (frame?.msgId === 'order-1') {
      await gate;
    }
    delivered.push({ sessionId: seat.sessionId, msgId: frame?.msgId ?? null });
    return true;
  };
  const { dir } = makeService(t);
  const collabId = seedTwoSeats(dir);
  const live = reopen(t, dir, delivered, { deliverSeat });
  const offline = { ...live };
  assert.equal(offline !== null, true);
  /* 先离线暂存 order-1，再上线开始补投；补投被闸住时注入 order-2。 */
  const staged = await live.injectLocalSeat(collabId, 'sess-dev', frameFor(collabId, 'order-1'));
  assert.deepEqual(staged, { ok: true, staged: true });
  const flushing = live.registerBridgeEntry('sess-dev', 'bridge-dev');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const during = await live.injectLocalSeat(collabId, 'sess-dev', frameFor(collabId, 'order-2'));
  assert.deepEqual(during, { ok: true, staged: true }, '补投期间新帧先暂存');
  release();
  await flushing;
  assert.deepEqual(delivered.map((item) => item.msgId), ['order-1', 'order-2'], '补投按到达序，新帧不得超车');
  live.close();
});

test('I-6 离席按席位：同机一席退出不归档另一席', async (t) => {
  const { dir, delivered } = makeService(t);
  const collabId = seedTwoSeats(dir);
  writeSeat(dir, collabId, seatOf('sess-dev2', { joinSeq: 3 }));
  const service = reopen(t, dir, delivered);
  const left = service.leave({ collabId, sessionId: 'sess-dev' });
  assert.equal(left.ok, true, left.message);
  assert.deepEqual(sessionIds(service.listLocalSeats(collabId)), ['sess-dev2', 'sess-mgr'], '只移除退出者席位');
  assert.equal(service.list().collabs[0].state, 'active', '同机仍有站长/成员席：整机不得归档');
  service.close();
});

test('C-7 治理写按席位授权：同机成员席不得 end/invite，可退出', async (t) => {
  const { dir, delivered } = makeService(t);
  const collabId = seedTwoSeats(dir);
  const service = reopen(t, dir, delivered);
  const target = { instanceId: 'inst-peer', identityName: '对端', address: '127.0.0.1', port: 17322 };
  const memberEnd = service.end({ collabId, sessionId: 'sess-dev' });
  assert.equal(memberEnd.ok, false);
  assert.match(memberEnd.message, /站长席位/);
  const memberInvite = service.invite({ collabId, targets: [target], sessionId: 'sess-dev' });
  assert.equal(memberInvite.ok, false);
  assert.match(memberInvite.message, /站长席位/);
  const memberLeave = service.leave({ collabId, sessionId: 'sess-dev' });
  assert.equal(memberLeave.ok, true, memberLeave.message);
  const managerInvite = service.invite({ collabId, targets: [target], sessionId: 'sess-mgr' });
  assert.equal(managerInvite.ok, true, managerInvite.message);
  const managerEnd = service.end({ collabId, sessionId: 'sess-mgr' });
  assert.equal(managerEnd.ok, true, managerEnd.message);
  service.close();
});

test('C-8 受邀未入席会话按桥注册可注入；指名邀请不投非目标会话', async (t) => {
  const { service, dir, delivered } = makeService(t);
  const collabId = seedTwoSeats(dir);
  const live = reopen(t, dir, delivered);
  await live.registerBridgeEntry('sess-invitee', 'bridge-invitee');
  await live.registerBridgeEntry('sess-bystander', 'bridge-bystander');
  const targets = live.listInjectableTargets(collabId).map((seat) => seat.sessionId);
  assert.ok(targets.includes('sess-invitee'), '未入席会话进入可注入目标');
  const invite = frameFor(collabId, 'inv-1', 'sess-manager-peer', 'invite', { name: '项目', topic: '主题', members: [{ instanceId: 'inst-peer', sessionId: 'sess-manager-peer', identityName: '对端' }] });
  assert.deepEqual(await live.injectLocalSeat(collabId, 'sess-invitee', invite), { ok: true, delivered: true });
  const bystander = await live.injectLocalSeat(collabId, 'sess-bystander', { ...invite, msgId: 'inv-2', payload: { ...invite.payload, targetSessionId: 'sess-invitee' } });
  assert.deepEqual(bystander, { ok: false, reason: 'not-invite-target' }, '指名邀请只投目标会话');
  const nonInvite = await live.injectLocalSeat(collabId, 'sess-bystander', frameFor(collabId, 'n-1', 'sess-peer', 'notice'));
  assert.deepEqual(nonInvite, { ok: false, reason: 'no-seat' }, '非邀请帧不得投未入席会话');
  assert.deepEqual(await live.injectLocalSeat(collabId, 'sess-invitee', { ...invite, msgId: 'inv-3', payload: { name: '项目', topic: '主题', members: [] } }), { ok: true, delivered: true });
  assert.deepEqual(delivered.filter((item) => item.sessionId === 'sess-invitee').map((item) => item.msgId), ['inv-1', 'inv-3']);
  live.close();
  service.close();
});

test('I-3/I-4 本机旁路落盘投递账并可查明细', async (t) => {
  const { service, dir, delivered } = makeService(t, {
    deliveryStatusOf: () => ({ msgId: 'm-ledger', tier: 'delivered' }),
    localSeatDeliveryOf: () => ({ collabId: 'from-inbound', msgId: 'm-unknown', sessionId: 'sess-x', status: 'staged', complete: false }),
  });
  const collabId = seedTwoSeats(dir);
  const live = reopen(t, dir, delivered, {
    deliveryStatusOf: () => ({ msgId: 'm-ledger', tier: 'delivered' }),
    localSeatDeliveryOf: () => ({ collabId: 'from-inbound', msgId: 'm-unknown', sessionId: 'sess-x', status: 'staged', complete: false }),
  });
  await live.registerBridgeEntry('sess-dev', 'bridge-dev');
  await live.injectLocalSeat(collabId, 'sess-dev', frameFor(collabId, 'm-ledger'));
  const detail = live.localSeatDeliveryOf('m-ledger', 'sess-dev');
  assert.equal(detail.status, 'injected');
  assert.equal(detail.complete, true);
  const lines = readFileSync(join(collabDir(dir, collabId), 'inbox.jsonl'), 'utf8').split('\n').filter((line) => line.trim() !== '');
  const record = JSON.parse(lines.at(-1));
  assert.equal(record.local, true);
  assert.deepEqual(record.fanout.outcomes, { 'sess-dev': 'injected' });
  assert.deepEqual(live.deliveryStatusOf('m-ledger'), { msgId: 'm-ledger', tier: 'delivered' });
  assert.equal(live.localSeatDeliveryOf('m-unknown', 'sess-x').status, 'staged', '未命中内存事实时委托接收管线账');
  live.close();
  service.close();
});

test('M8 I-1 写门不缓存正判定：运行中目录变 recovery 立即 fail-closed', async (t) => {
  const { dir, delivered } = makeService(t);
  const collabId = seedTwoSeats(dir);
  const service = reopen(t, dir, delivered);
  assert.equal(service.isWritable(collabId), true);
  rmSync(join(collabDir(dir, collabId), 'ledger.jsonl'));
  assert.equal(service.isWritable(collabId), false, '台账删除后重判为半写只读，不得沿用旧正判定');
  assert.equal(service.send({ collabId, text: 'x' }).ok, false);
  service.close();
});

test('I-10 站长席位文件缺失：按 carrier.manager 恢复席位并加载台账，不伪造 sessionId', async (t) => {
  const { dir, delivered } = makeService(t);
  const collabId = 'collab-recover-manager';
  mkdirSync(collabDir(dir, collabId), { recursive: true });
  const carrier = carrierOf(collabId);
  carrier.manager = { instanceId: 'inst-self', sessionId: 'sess-mgr', identityName: '本机', term: 1 };
  writeJson(carrierFilePath(dir, collabId), carrier);
  writeFileSync(join(collabDir(dir, collabId), 'ledger.jsonl'), `${JSON.stringify(ledgerOf(collabId))}\n`, 'utf8');
  const service = reopen(t, dir, delivered);
  assert.equal(service.managerSeatOf(collabId)?.sessionId, 'sess-mgr');
  assert.deepEqual(sessionIds(service.listLocalSeats(collabId)), ['sess-mgr']);
  assert.equal(service.list().collabs[0].role, 'manager');
  assert.equal(service.list().collabs[0].version, 2, '台账按 carrier 站长身份正常加载');
  assert.equal(service.stats().seatRecoveredFromCarrier, 1);
  service.close();
});

test('I-11 无会话标识拒绝创建：不落任何持久化', async (t) => {
  const { service, dir } = makeService(t);
  const result = service.create({ name: '无标识', topic: '主题', targets: [] });
  assert.equal(result.ok, false);
  assert.match(result.message, /会话标识/);
  const collabs = join(dir, 'collabs');
  assert.deepEqual(existsSync(collabs) ? readdirSync(collabs) : [], [], '拒绝路径不建协作目录');
  service.close();
});

test('C-6 席位角色迁移原语：改席位角色后站长派生随之切换', async (t) => {
  const { dir, delivered } = makeService(t);
  const collabId = seedTwoSeats(dir);
  const service = reopen(t, dir, delivered);
  assert.equal(service.setSeatRole(collabId, 'sess-mgr', 'member').ok, true);
  assert.equal(service.setSeatRole(collabId, 'sess-dev', 'manager').ok, true);
  assert.equal(service.managerSeatOf(collabId).sessionId, 'sess-dev');
  assert.equal(service.list().collabs[0].role, 'manager', '派生缓存随席位同步');
  service.close();
});

test('能力闸门：未知先探测、不支持明确拒绝、已知支持不探测', async (t) => {
  const target = { instanceId: 'inst-b', identityName: '对端', address: '127.0.0.1', port: 17322 };
  let probes = 0;
  const unsupported = makeService(t, {
    probeCapability: async () => {
      probes++;
      return { ok: true, capability: 'unsupported' };
    },
    knownHosts: { remember: () => {}, participantsOf: () => undefined },
  });
  const refused = await unsupported.service.create({ name: '闸门', topic: '主题', targets: [target], sessionId: 'sess-gate-a' });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /不支持会话级协作/);
  assert.equal(probes, 1, '未知能力：先探测一次再拒绝');

  const supported = makeService(t, {
    probeCapability: async () => ({ ok: true, capability: 'supported' }),
    knownHosts: { remember: () => {}, participantsOf: () => undefined },
  });
  const created = await supported.service.create({ name: '闸门', topic: '主题', targets: [target], sessionId: 'sess-gate-b' });
  assert.equal(created.ok, true, created.message);

  let skipped = 0;
  const known = makeService(t, {
    probeCapability: async () => {
      skipped++;
      return { ok: true, capability: 'unknown' };
    },
    knownHosts: { remember: () => {}, participantsOf: () => 2 },
  });
  const knownCreated = await known.service.create({ name: '闸门', topic: '主题', targets: [target], sessionId: 'sess-gate-c' });
  assert.equal(knownCreated.ok, true, knownCreated.message);
  assert.equal(skipped, 0, '已知支持不重复探测');
  unsupported.service.close();
  supported.service.close();
  known.service.close();
});

test('接管授权：成员席可发起（不再被 managerOnly 拦下）', async (t) => {
  const { dir, delivered } = makeService(t);
  const collabId = seedTwoSeats(dir);
  const service = reopen(t, dir, delivered);
  const result = await service.takeOver({ collabId, sessionId: 'sess-dev' });
  assert.equal(result.ok, false, '本机有站长席时接管会被业务门拒绝');
  assert.doesNotMatch(result.message ?? '', /只有站长席位/, '不得在席位授权层拦成员会话');
  service.close();
});

/* 重新以同一目录构造服务（模拟核心重启），沿用同一交付记录数组。 */
function reopen(t, dir, delivered, overrides = {}) {
  return createCollabService({
    dataDir: dir,
    config: { sessionSeatGraceMs: 60000, ...(overrides.config ?? {}) },
    self: { instanceId: 'inst-self', identityName: '本机', port: 17321 },
    send: () => ({ ok: true, msgId: 'q-1' }),
    sendDirect: () => ({ ok: true, msgId: 'd-1' }),
    knownHosts: overrides.knownHosts ?? { remember: () => {} },
    notify: () => true,
    probeCapability: overrides.probeCapability ?? null,
    deliverSeat: overrides.deliverSeat ?? ((frame, seat) => {
      if (overrides.controller !== undefined && !overrides.controller.online) {
        return false;
      }
      delivered.push({ sessionId: seat.sessionId, msgId: frame?.msgId ?? null, type: frame?.type ?? null });
      return true;
    }),
    deliveryStatusOf: overrides.deliveryStatusOf ?? null,
    localSeatDeliveryOf: overrides.localSeatDeliveryOf ?? null,
    log: quietLog(),
    syncPeerPicker: () => [],
  });
}
