import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { collabFilePath } from '../src/paths.js';
import { makeTempDir, waitFor } from './helpers.js';
import { createCollabService } from '../src/collab/service.js';
import { ledgerDigest } from '../src/collab/store.js';

/* 抢接治理的补面（既有 collab-takeover 用例集的续篇）：收集窗口内的汇总报告（report）、
 * 握手携带的在途/生效视图、论坛实例在握手覆盖面中的排除，以及「本机没有该协作」的拒绝面。
 * 全部经真服务 + 假发送/探测/提示装配（与 collab-takeover 同形），确定性驱动，不依赖网络。 */

const DAY = 24 * 60 * 60 * 1000;

function quietLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

/* 脚本化探测：按序取用结果，耗尽后默认「不可达」。 */
function probeQueue(results = []) {
  const queue = [...results];
  return {
    push: (result) => queue.push(result),
    fn: async () => queue.shift() ?? { reachable: false, reason: '脚本耗尽（默认不可达）' },
  };
}

function harnessConfig(overrides) {
  return {
    inviteTtlMs: DAY,
    managerProbeIntervalMs: 20,
    managerOfflineMs: 40,
    takeoverWindowMs: 60,
    freezeUnresolvedMs: DAY,
    ...(overrides.config ?? {}),
  };
}

function makeHarness(t, overrides = {}) {
  const dir = makeTempDir(t);
  const sent = [];
  const notified = [];
  const script = overrides.probeScript ?? probeQueue();
  const self = overrides.self ?? { instanceId: 'inst-self', identityName: '本机', port: 17321 };
  const config = harnessConfig(overrides);
  const service = createCollabService({
    dataDir: dir,
    config,
    self,
    send: (message) => {
      sent.push(message);
      return { ok: true, msgId: `q-${sent.length}` };
    },
    knownHosts: { remember: () => {} },
    log: quietLog(),
    ledgerFetchTimeoutMs: 30,
    inviteMinIntervalMs: 0,
    probe: overrides.probe === undefined ? script.fn : overrides.probe,
    reassign: () => ({ ok: true, moved: 0 }),
    notify: (frame) => {
      notified.push(frame);
    },
    takeoverProbeIntervalMs: overrides.takeoverProbeIntervalMs ?? 5,
    handshakeReplyTimeoutMs: overrides.handshakeReplyTimeoutMs ?? 40,
    handoverConfirmTimeoutMs: overrides.handoverConfirmTimeoutMs ?? 40,
  });
  return { service, sent, notified, dir, self, config, script };
}

let seq = 0;

function peer(instanceId, identityName, port = 17321) {
  return { instanceId, identityName, port };
}

function collabFrame(type, collabId, from, payload) {
  seq++;
  return { v: 1, type, msgId: `msg-${type}-${seq}`, from: { ...from, port: from.port ?? 17321 }, collabId, ts: new Date().toISOString(), payload };
}

async function receive(service, f, remoteAddress = '127.0.0.1') {
  const admitted = await service.hooks.admit(f, { remoteAddress });
  if (admitted?.ok === true) {
    await service.hooks.consume(f, { remoteAddress });
  }
  return admitted;
}

function sentOf(sent, type, collabId = null) {
  return sent.filter((entry) => entry.type === type && (collabId === null || entry.collabId === collabId));
}

/* 快照测试用最小合法台账与配套摘要（接收侧重算 digest 比对——构造值必须真实自洽）。 */
function ledgerStub(collabId, version, manager = { instanceId: 'inst-a', identityName: '主机甲' }) {
  const now = new Date().toISOString();
  return {
    version,
    collabId,
    name: '联调项目',
    topic: '发布联调',
    status: 'active',
    manager: { instanceId: manager.instanceId, identityName: manager.identityName },
    members: [
      { instanceId: manager.instanceId, identityName: manager.identityName, role: 'manager', state: 'member', joinedAt: now },
      { instanceId: 'inst-self', identityName: '本机', role: 'member', state: 'member', joinedAt: now },
    ],
    board: [],
    createdAt: now,
    updatedAt: now,
  };
}

async function deliverSnapshot(harness, collabId, version, manager = { instanceId: 'inst-a', identityName: '主机甲' }) {
  const ledger = ledgerStub(collabId, version, manager);
  await receive(harness.service, collabFrame('snapshot', collabId, { ...manager, port: 17321 }, { kind: 'data', version, digest: ledgerDigest(ledger), ledger }));
}

/* 成员侧已达成的协作（proposed → approved → established → 快照 v2）。 */
async function memberActive(harness, { collabId = 'collab-x', manager = peer('inst-a', '主机甲'), name = '联调项目' } = {}) {
  await receive(harness.service, collabFrame('invite', collabId, manager, {
    name,
    topic: '发布联调',
    members: [
      { instanceId: manager.instanceId, identityName: manager.identityName },
      { instanceId: harness.self.instanceId, identityName: harness.self.identityName },
    ],
  }));
  await harness.service.approve({ collabId, approve: true });
  await receive(harness.service, collabFrame('notice', collabId, manager, { event: 'established', version: 2 }));
  await deliverSnapshot(harness, collabId, 2, manager);
  return collabId;
}

/* 管理席位侧协作（含一名已同意成员 inst-b；台账 v2 定格）。 */
async function managerActive(harness, { name = '联调项目' } = {}) {
  const created = harness.service.create({
    name,
    topic: '发布联调',
    targets: [{ instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.2', port: 17321 }],
  });
  await receive(harness.service, collabFrame('approve', created.collabId, peer('inst-b', '主机乙'), {}));
  return created.collabId;
}

/* 等成员侧被判定失联（判死门槛走 harnessConfig 的短时限）。 */
async function waitManagerOffline(harness) {
  harness.service.start();
  await waitFor(() => (harness.service.list().collabs[0].managerOffline === true ? true : null), { timeoutMs: 3000 });
}

test('抢接发起：本机没有该协作 → 明确拒绝（不建记录、不抛错）', async (t) => {
  const harness = makeHarness(t);
  const rejected = await harness.service.takeOver({ collabId: 'collab-none' });
  assert.equal(rejected.ok, false);
  assert.ok(rejected.message.includes('本机没有该协作'), rejected.message);
  const rejectedConfirm = await harness.service.takeOver({ collabId: 'collab-none', confirm: true });
  assert.equal(rejectedConfirm.ok, false, 'confirm 形态同一拒绝面（先查实例存在性）');
  assert.equal(harness.service.stats().takeoversIn, 0, '拒绝不产生任何在途记录');
});

test('握手覆盖面：论坛实例不参与 managed 握手（协作实例照发）', async (t) => {
  const harness = makeHarness(t);
  const forum = harness.service.create({
    name: '讨论甲',
    topic: '议题',
    mode: 'forum',
    targets: [{ instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.2', port: 17321 }],
  });
  const managed = await managerActive(harness);
  harness.service.handshake();
  const handshakes = sentOf(harness.sent, 'notice').filter((frame) => frame.payload?.event === 'handshake');
  assert.equal(handshakes.some((frame) => frame.collabId === forum.collabId), false, '讨论实例被跳过（对表由讨论引擎承担）');
  assert.equal(handshakes.some((frame) => frame.collabId === managed), true, '协作实例照常发起握手');
});

test('管理席位收到在途抢接握手视图：暂停对外写（takeover-inflight）', async (t) => {
  const harness = makeHarness(t);
  const collabId = await managerActive(harness);
  await receive(harness.service, collabFrame('notice', collabId, peer('inst-b', '主机乙'), {
    event: 'handshake',
    role: 'member',
    version: 2,
    takeover: { phase: 'collecting', candidate: { instanceId: 'inst-b', identityName: '主机乙' }, baseVersion: 2 },
    reply: true,
  }));
  assert.equal(harness.service.list().collabs[0].suspended, true, '在途抢接视图到达 → 管理席位暂停对外写');
  await receive(harness.service, collabFrame('takeover-init', collabId, peer('inst-b', '主机乙'), { kind: 'cancel', reason: '候选放弃' }));
  assert.equal(harness.service.list().collabs[0].suspended, false, '取消到达即恢复');
});

test('成员收到生效抢接握手视图：收敛到新驿丞（成员记录改指）', async (t) => {
  const harness = makeHarness(t);
  const collabId = await memberActive(harness);
  const before = JSON.parse(readFileSync(collabFilePath(harness.dir, collabId, 'member.json'), 'utf8'));
  assert.equal(before.manager.instanceId, 'inst-a');
  await receive(harness.service, collabFrame('notice', collabId, peer('inst-e', '主机戊'), {
    event: 'handshake',
    role: 'manager',
    version: 2,
    takeover: { phase: 'effective', candidate: { instanceId: 'inst-e', identityName: '主机戊' }, baseVersion: 3 },
    reply: true,
  }));
  const after = JSON.parse(readFileSync(collabFilePath(harness.dir, collabId, 'member.json'), 'utf8'));
  assert.equal(after.manager.instanceId, 'inst-e', '生效抢接的握手视图使成员收敛到新驿丞');
  assert.equal(harness.service.list().collabs[0].role, 'member', '收敛不改变本机角色');
});

test('汇总报告：无在途记录的报告按过期忽略（计数留痕、不误让位）', async (t) => {
  const harness = makeHarness(t);
  const collabId = await memberActive(harness);
  const reportsBefore = harness.service.stats().takeoversReportsIn;
  await receive(harness.service, collabFrame('takeover-init', collabId, peer('inst-c', '主机丙'), {
    kind: 'report',
    version: 2,
    takeover: { candidate: { instanceId: 'inst-c', identityName: '主机丙' }, baseVersion: 2 },
  }));
  assert.equal(harness.service.stats().takeoversReportsIn, reportsBefore + 1, '报告计入接收面');
  assert.equal(harness.service.stats().takeoversYielded, 0, '无在途记录：不给让位');
});

test('汇总报告：在途期内更高优先候选的汇总到达 → 本机让位（等待面即时收口）', async (t) => {
  const harness = makeHarness(t, { config: { takeoverWindowMs: 3000 } });
  const collabId = await memberActive(harness);
  await waitManagerOffline(harness);
  const pending = harness.service.takeOver({ collabId });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await receive(harness.service, collabFrame('takeover-init', collabId, peer('inst-z', '主机子'), {
    kind: 'report',
    version: 2,
    takeover: { candidate: { instanceId: 'inst-z', identityName: '主机子' }, baseVersion: 1 },
  }));
  assert.equal(harness.service.stats().takeoversYielded, 0, '更低优先（更低基准版本）的汇总不让位');
  await receive(harness.service, collabFrame('takeover-init', collabId, peer('inst-c', '主机丙'), {
    kind: 'report',
    version: 2,
    takeover: { candidate: { instanceId: 'inst-c', identityName: '主机丙' }, baseVersion: 2 },
  }));
  const startedAt = Date.now();
  const verdict = await pending;
  assert.equal(verdict.ok, false, JSON.stringify(verdict));
  assert.ok(verdict.message.includes('让位'), verdict.message);
  assert.equal(Date.now() - startedAt < 1500, true, '让位由汇总报告即时触发（非等窗口自然结束——窗口 3000ms）');
  assert.equal(harness.service.stats().takeoversYielded >= 1, true);
  harness.service.close();
});
