import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeTempDir, waitFor } from './helpers.js';
import { makeLedger, seedSessionCollab } from './helpers/session-participants.js';
import { createCollabService } from '../src/collab/service.js';
import { ledgerDigest } from '../src/collab/store.js';
import { carrierFilePath } from '../src/paths.js';

/* 站长交接的补面（collab-takeover 用例集的续篇）：无实例拒绝面、握手的模式覆盖面、宽限/失联判定、
 * 显式移交在途挂起与到期解挂、自动移交的目标侧接受与签发（via=auto）。
 *
 * 已删除用例 → 设计依据 / 替代覆盖：
 * - 站长席位收到在途抢接握手视图 → 暂停写：v3 收集窗口/在途抢接视图已删除（§2A 整节取代 v3 §2A；
 *   §0.4 删除候选优先序与收集窗口）；handshake 载荷不再携 takeover 视图。
 * - 成员收到生效抢接握手视图 → 收敛：同上；抢接生效改由 manager-changed(via=takeover) 受理（A3）。
 * - 汇总报告两条（过期忽略 / 更高优先候选让位）：report 帧与优先序均属已删除语义（§0.4）。
 * - 失联判定与投递队列解耦 / 失联用户提示：仍有效，已在本文件补回运行中的断言。
 *
 * 夹具形态（consume-only）：新台账 + carrier(session-seats) + seats/ 预置；本文件不经
 * create/invite/join 的产品路径。协作域帧携 cap=2 与 from.sessionId（§1.1/§2.1/§5.1）。 */

const COLLAB = 'collab-followup';
const MGR = { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲机' };
const MEM = { instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙机' };
const MGR_ENDPOINT = { address: '127.0.0.1', port: 17321 };
const MEM_ENDPOINT = { address: '127.0.0.2', port: 17321 };

function quietLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function membersOf() {
  return [
    { ...MGR, role: 'manager', joinSeq: 1 },
    { ...MEM, role: 'member', joinSeq: 2 },
  ];
}

function memberRecordOf(endpoints) {
  return {
    collabId: COLLAB,
    name: '交接协作',
    topic: '交接主题',
    role: 'member',
    state: 'active',
    manager: { instanceId: MGR.instanceId, sessionId: MGR.sessionId, identityName: MGR.identityName },
    endpoints,
    roster: membersOf(),
    mode: 'managed',
    decision: 'approved',
  };
}

const ROLE_PRESETS = {
  manager: {
    self: MGR,
    seat: { sessionId: MGR.sessionId, role: 'manager', joinSeq: 1 },
    endpoints: { [MEM.instanceId]: MEM_ENDPOINT },
  },
  member: {
    self: MEM,
    seat: { sessionId: MEM.sessionId, role: 'member', joinSeq: 2 },
    endpoints: { [MGR.instanceId]: MGR_ENDPOINT },
  },
};

function harnessConfig(overrides = {}) {
  return {
    managerProbeIntervalMs: 10,
    managerLossTimeoutMs: 60,
    sessionSeatTimeoutMs: 300000,
    seatPresenceIntervalMs: 30000,
    sessionSeatGraceMs: 60000,
    handoverConfirmTimeoutMs: 40,
    sessionTakeoverWindowMs: 60000,
    ...overrides,
  };
}

function seedSpecOf(role, declared) {
  return {
    name: '交接协作',
    status: 'active',
    managerTerm: 1,
    version: 3,
    manager: MGR,
    members: membersOf(),
    seats: [ROLE_PRESETS[role].seat],
    endpoints: declared,
    snapshotFrom: MGR.instanceId,
    ...(role === 'member' ? { member: memberRecordOf(declared) } : {}),
  };
}

/* 双角色夹具：role=manager 时本机为 inst-a；role=member 时本机为 inst-b（带本地席位与成员记录）。 */
function makeHarness(t, { role = 'manager', endpoints = null, config = {}, probe = async () => ({ reachable: false, reason: '不可达' }) } = {}) {
  const dir = makeTempDir(t);
  const self = ROLE_PRESETS[role].self;
  const declared = endpoints ?? ROLE_PRESETS[role].endpoints;
  seedSessionCollab(dir, COLLAB, seedSpecOf(role, declared));
  const sent = [];
  const notified = [];
  const service = createCollabService({
    dataDir: dir,
    config: harnessConfig(config),
    self: { instanceId: self.instanceId, identityName: self.identityName, port: 17321 },
    send: (message) => {
      sent.push(message);
      return { ok: true, msgId: `q-${sent.length}` };
    },
    knownHosts: { remember: () => {}, lookup: () => null },
    log: quietLog(),
    ledgerFetchTimeoutMs: 30,
    inviteMinIntervalMs: 0,
    notify: (frame) => notified.push(frame),
    syncPeerPicker: () => [],
    probe,
    handshakeReplyTimeoutMs: 60000,
  });
  t.after(() => service.close());
  return { dir, service, sent, notified, self };
}

let seq = 0;

function frameOf(type, from, payload, remoteAddress = '127.0.0.1') {
  seq++;
  return {
    v: 1,
    cap: 2,
    type,
    msgId: `msg-${type}-${seq}`,
    collabId: COLLAB,
    from: { instanceId: from.instanceId, sessionId: from.sessionId, identityName: from.identityName, port: 17321 },
    ts: new Date().toISOString(),
    payload,
    remoteAddress,
  };
}

async function receive(service, frame, remoteAddress = frame.remoteAddress ?? '127.0.0.1') {
  const admitted = await service.hooks.admit(frame, { remoteAddress });
  if (admitted?.ok === true) {
    await service.hooks.consume(frame, { remoteAddress });
  }
  return admitted;
}

function freezeReasonOnDisk(dir) {
  try {
    return JSON.parse(readFileSync(carrierFilePath(dir, COLLAB), 'utf8')).freezeReason ?? null;
  } catch {
    return null;
  }
}

test('抢接发起：本机没有该协作 → 明确拒绝（不建记录、不抛错）', async (t) => {
  const harness = makeHarness(t, { role: 'member' });
  const rejected = await harness.service.takeOver({ collabId: 'collab-none', sessionId: MEM.sessionId });
  assert.equal(rejected.ok, false);
  assert.ok(rejected.message.includes('本机没有该协作'), rejected.message);
  const rejectedConfirm = await harness.service.takeOver({ collabId: 'collab-none', sessionId: MEM.sessionId, token: 'x' });
  assert.equal(rejectedConfirm.ok, false, '携令牌形态同一拒绝面（先查实例存在性）');
});

test('握手覆盖面：论坛实例不参与 managed 握手（协作实例照发）', async (t) => {
  const harness = makeHarness(t);
  const forum = harness.service.create({
    name: '讨论甲',
    topic: '议题',
    mode: 'forum',
    sessionId: 'sess-forum',
    targets: [{ instanceId: MEM.instanceId, identityName: MEM.identityName, address: MEM_ENDPOINT.address, port: MEM_ENDPOINT.port }],
  });
  assert.equal(forum.ok, true, String(forum.message));
  harness.sent.length = 0;
  harness.service.handshake();
  const handshakes = harness.sent.filter((frame) => frame.type === 'notice' && frame.payload?.event === 'handshake');
  assert.equal(handshakes.some((frame) => frame.collabId === forum.collabId), false, '讨论实例被跳过（对表由讨论引擎承担）');
  assert.equal(handshakes.some((frame) => frame.collabId === COLLAB), true, '协作实例照常发起握手');
  assert.equal(handshakes[0].fromSessionId, MGR.sessionId, '握手由本机席位签发');
});

test('失联判定：探测失败达时限 → 冻结 manager-offline 并落载体；恢复应答解除离线读数', async (t) => {
  const probeScript = [{ reachable: false, reason: '超时' }];
  const harness = makeHarness(t, {
    role: 'member',
    probe: async () => probeScript.shift() ?? { reachable: false, reason: '超时' },
  });
  harness.service.start();
  await waitFor(() => (harness.service.list().collabs[0].managerOffline === true ? true : null), { timeoutMs: 3000 });
  assert.equal(harness.service.stats().managerOffline >= 1, true);
  assert.equal(harness.notified.some((frame) => /冻结|失联/.test(frame.payload.text) && frame.payload.text.includes('ws_take_over')), true, '冻结提示含手动接管指引');
  await waitFor(() => (freezeReasonOnDisk(harness.dir) === 'manager-offline' ? true : null), { timeoutMs: 3000 });
  assert.equal(harness.service.list().collabs[0].state, 'frozen', '冻结即转只读态');
  assert.equal(harness.service.list().collabs[0].sessions.freezeReason, 'manager-offline', '冻结原因可读');
  const blockedWrite = await harness.service.send({ collabId: COLLAB, text: '冻结期消息', type: 'issue', sessionId: MEM.sessionId });
  assert.equal(blockedWrite.ok, false, '冻结即停写');
  assert.ok(/冻结|暂停/.test(blockedWrite.message), blockedWrite.message);
  probeScript.push({ reachable: true, rttMs: 1 });
  await waitFor(() => (harness.service.list().collabs[0].managerOffline === false ? true : null), { timeoutMs: 3000 });
  assert.equal(harness.service.stats().managerRecovered >= 1, true, '恢复应答计数');
  /* 恢复后的权威台账（现任站长同 term 更高版本）解除冻结并清除持久化原因。 */
  const refreshed = makeLedger({
    collabId: COLLAB,
    name: '交接协作',
    status: 'active',
    managerTerm: 1,
    version: 4,
    manager: MGR,
    members: membersOf(),
  });
  await receive(harness.service, frameOf('snapshot', MGR, {
    kind: 'data',
    managerTerm: 1,
    version: 4,
    digest: ledgerDigest(refreshed),
    ledger: refreshed,
  }));
  assert.equal(harness.service.list().collabs[0].state, 'active', '恢复后按权威快照解除冻结');
  assert.equal(freezeReasonOnDisk(harness.dir), null, '冻结原因随恢复清除');
});

test('失联判定与投递队列解耦：消息入队不改变探测结论', async (t) => {
  const probeScript = [{ reachable: false, reason: '超时' }];
  const harness = makeHarness(t, {
    role: 'member',
    probe: async () => probeScript.shift() ?? { reachable: false, reason: '超时' },
  });
  const queued = await harness.service.send({ collabId: COLLAB, text: '站长离线期间的消息', type: 'issue', sessionId: MEM.sessionId });
  assert.equal(queued.ok, true, '离线期间消息仍受理入队');
  assert.equal(harness.service.list().collabs[0].managerOffline, false, '入队本身不改变失联读数');
  harness.service.start();
  await waitFor(() => (harness.service.list().collabs[0].managerOffline === true ? true : null), { timeoutMs: 3000 });
  assert.equal(harness.service.stats().managerOffline >= 1, true, '探测结论只由探测证据决定');
  probeScript.push({ reachable: true, rttMs: 1 });
  await waitFor(() => (harness.service.list().collabs[0].managerOffline === false ? true : null), { timeoutMs: 3000 });
  assert.equal(harness.service.stats().managerRecovered >= 1, true);
});

test('显式移交在途：offer 发出即挂起常规写；到期自动解挂（不残留）', { timeout: 10000 }, async (t) => {
  const harness = makeHarness(t, {
    probe: async () => ({ reachable: true, rttMs: 1 }),
    config: { handoverConfirmTimeoutMs: 40 },
  });
  const sent = await harness.service.handover({
    collabId: COLLAB,
    target: MEM.instanceId,
    targetSessionId: MEM.sessionId,
    sessionId: MGR.sessionId,
  });
  assert.equal(sent.ok, true, String(sent.message));
  assert.ok(sent.offerId);
  assert.equal(harness.service.list().collabs[0].suspended, true, '等待期禁常规写');
  assert.equal((await harness.service.send({ collabId: COLLAB, text: '等待期消息', type: 'issue', sessionId: MGR.sessionId })).ok, false);
  const offer = harness.sent.find((entry) => entry.type === 'handover' && entry.payload.kind === 'offer');
  assert.equal(offer.fromSessionId, MGR.sessionId, 'offer 由站长席位签发');
  assert.equal(offer.payload.baseTerm, 1);
  assert.ok(offer.payload.digest && offer.payload.ledger && offer.payload.endpoints && offer.payload.expiresAt, 'offer 必填字段齐全');
  await waitFor(() => (harness.service.list().collabs[0].suspended === false ? true : null), { timeoutMs: 3000 });
  const resumed = await harness.service.send({ collabId: COLLAB, text: '到期后恢复写', type: 'issue', sessionId: MGR.sessionId });
  assert.equal(resumed.ok, true, String(resumed.message));
  assert.equal(harness.service.isWritable(COLLAB), true);
});

test('自动移交目标侧：auto-offer 匹配 offer → 自动接受并以新站长签发 via=auto（开窗、移除旧站长）', async (t) => {
  const manager = makeHarness(t, { probe: async () => ({ reachable: true, rttMs: 1 }) });
  const member = makeHarness(t, { role: 'member' });
  const dispatched = manager.service.autoTransfer({
    collabId: COLLAB,
    managerSessionId: MGR.sessionId,
    successorSeat: { instanceId: MEM.instanceId, sessionId: MEM.sessionId, identityName: MEM.identityName },
  });
  assert.equal(dispatched.ok, true, JSON.stringify(dispatched));
  const autoOffer = manager.sent.find((entry) => entry.type === 'notice' && entry.payload.event === 'auto-offer');
  const offer = manager.sent.find((entry) => entry.type === 'handover' && entry.payload.kind === 'offer');
  assert.ok(autoOffer, 'auto-offer 广播已发出');
  assert.ok(offer, 'offer 定向发出');
  assert.equal(autoOffer.fromSessionId, MGR.sessionId);
  assert.equal(offer.to.instanceId, MEM.instanceId);
  assert.equal(manager.service.list().collabs[0].suspended, true, '原站长发出 offer 即停写');
  const managerBlocked = await manager.service.send({ collabId: COLLAB, text: '自动移交等待期消息', type: 'issue', sessionId: MGR.sessionId });
  assert.equal(managerBlocked.ok, false, '原站长等待期不得继续写');

  await receive(member.service, frameOf('notice', MGR, autoOffer.payload));
  assert.equal(member.service.list().collabs[0].role, 'member', '目标收到 auto-offer 不自行提升');
  assert.equal(member.service.list().collabs[0].version, 3, '目标台账未变');
  await receive(member.service, frameOf('handover', MGR, offer.payload, MGR_ENDPOINT.address));
  await waitFor(() => (member.service.list().collabs[0].role === 'manager' ? true : null), { timeoutMs: 3000 });
  const ledger = (await member.service.view({ collabId: COLLAB })).ledger;
  assert.equal(ledger.managerTerm, 2);
  assert.equal(ledger.version, 4);
  assert.equal(ledger.manager.sessionId, MEM.sessionId);
  assert.equal(ledger.managerWindow.windowBaseTerm, 2, '自动移交后开 1 分钟窗口');
  assert.equal(ledger.members.some((entry) => entry.sessionId === MGR.sessionId), false, '旧站长席位按 manager-session-closed 移除');
  const change = member.sent.find((entry) => entry.type === 'notice' && entry.payload.event === 'manager-changed');
  assert.ok(change, '新站长签发 manager-changed');
  assert.equal(change.payload.via, 'auto');
  assert.equal(change.fromSessionId, MEM.sessionId, 'from＝新站长席位');
  assert.equal(change.payload.offerId, dispatched.offerId);
  assert.ok(change.payload.windowEndsAt);
  const accept = member.sent.find((entry) => entry.type === 'handover' && entry.payload.kind === 'accept');
  assert.ok(accept, '目标核自动接受（无人工确认）');
});
