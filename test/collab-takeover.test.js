import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collabFilePath } from '../src/paths.js';
import { makeTempDir, waitFor } from './helpers.js';
import { createCollabService } from '../src/collab/service.js';
import { LEDGER_FILE_NAME, ledgerDigest } from '../src/collab/store.js';

const DAY = 24 * 60 * 60 * 1000;

function quietLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

/* 脚本化探测：按序取用结果，耗尽后默认「不可达」——窗口探测与周期探测共用同一脚本。 */
function probeQueue(results = []) {
  const queue = [...results];
  return {
    push: (result) => queue.push(result),
    fn: async () => queue.shift() ?? { reachable: false, reason: '脚本耗尽（默认不可达）' },
  };
}

/* 用例配置基线：短探测节律 / 短窗口 / 短等待面。 */
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

/* 服务脚手架（与本文件用例同参）：真实临时目录 + 假发送 / 探测 / 队列改投 / 提示。 */
function makeHarness(t, overrides = {}) {
  const dir = makeTempDir(t);
  const sent = [];
  const notified = [];
  const reassigns = [];
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
    reassign: (payload) => {
      reassigns.push(payload);
      return { ok: true, moved: overrides.moved ?? 0 };
    },
    notify: (frame) => {
      notified.push(frame);
    },
    takeoverProbeIntervalMs: overrides.takeoverProbeIntervalMs ?? 5,
    handshakeReplyTimeoutMs: overrides.handshakeReplyTimeoutMs ?? 40,
    handoverConfirmTimeoutMs: overrides.handoverConfirmTimeoutMs ?? 40,
  });
  return { service, sent, notified, reassigns, dir, self, config, script };
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
  const invite = collabFrame('invite', collabId, manager, {
    name,
    topic: '发布联调',
    members: [
      { instanceId: manager.instanceId, identityName: manager.identityName },
      { instanceId: harness.self.instanceId, identityName: harness.self.identityName },
    ],
  });
  await receive(harness.service, invite);
  await harness.service.approve({ collabId, approve: true });
  await receive(harness.service, collabFrame('notice', collabId, manager, { event: 'established', version: 2 }));
  await deliverSnapshot(harness, collabId, 2, manager);
  return collabId;
}

/* 管理席位侧协作（含一名已同意成员 inst-b；台账 v2 定格）。 */
function managerWithMember(harness, { names = null } = {}) {
  const created = harness.service.create({
    name: names ?? '联调项目',
    topic: '发布联调',
    targets: [{ instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.2', port: 17321 }],
  });
  return created;
}

async function managerActive(harness, options = {}) {
  const created = managerWithMember(harness, options);
  await receive(harness.service, collabFrame('approve', created.collabId, peer('inst-b', '主机乙'), {}));
  return created.collabId;
}

/* —— 失联判定 —— */

test('失联判定：连续失败时长达标置离线并提示；恢复应答清零并计恢复', async (t) => {
  const harness = makeHarness(t);
  await memberActive(harness);
  harness.service.start();
  await waitFor(() => (harness.service.list().collabs[0].managerOffline === true ? true : null), { timeoutMs: 3000 });
  assert.equal(harness.service.stats().managerOffline >= 1, true);
  assert.equal(harness.notified.some((frame) => frame.payload.text.includes('抢接')), true, '失联提示含抢接指引');
  harness.script.push({ reachable: true, rttMs: 1 });
  harness.script.push({ reachable: true, rttMs: 1 });
  await waitFor(() => (harness.service.list().collabs[0].managerOffline === false ? true : null), { timeoutMs: 3000 });
  assert.equal(harness.service.stats().managerRecovered >= 1, true);
  harness.service.close();
});

test('失联判定与投递队列解耦：排队条目不改变探测结论', async (t) => {
  const harness = makeHarness(t);
  const collabId = await memberActive(harness);
  const queued = await harness.service.send({ collabId, text: '离线期间的消息' });
  assert.equal(queued.ok, true, '消息对离线驿丞仍受理入队');
  harness.service.start();
  await waitFor(() => (harness.service.list().collabs[0].managerOffline === true ? true : null), { timeoutMs: 3000 });
  harness.script.push({ reachable: true, rttMs: 1 });
  await waitFor(() => (harness.service.list().collabs[0].managerOffline === false ? true : null), { timeoutMs: 3000 });
  harness.service.close();
});

test('探测方向：管理席位不发起探测（计数零增长）', async (t) => {
  const harness = makeHarness(t);
  await managerActive(harness);
  harness.service.start();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(harness.service.stats().probeAttempts, 0);
  harness.service.close();
});

/* —— 握手 —— */

test('握手：管理席位向名册广播（role=manager、reply=false、版本取台账）', async (t) => {
  const harness = makeHarness(t);
  const collabId = await managerActive(harness);
  harness.sent.length = 0;
  harness.service.handshake();
  const frames = sentOf(harness.sent, 'notice', collabId).filter((frame) => frame.payload.event === 'handshake');
  assert.equal(frames.length, 1);
  assert.equal(frames[0].payload.role, 'manager');
  assert.equal(frames[0].payload.reply, false);
  assert.equal(frames[0].payload.version, 3, '版本 = 台账当前版本（创建 v1 + 回应 v2 + 建立 v3）');
  assert.equal(frames[0].payload.takeover, null);
});

test('握手：收到非回帧必回一帧（reply=true），回帧不再被回（防乒乓）', async (t) => {
  const harness = makeHarness(t);
  const collabId = await managerActive(harness);
  harness.sent.length = 0;
  await receive(harness.service, collabFrame('notice', collabId, peer('inst-b', '主机乙'), { event: 'handshake', role: 'member', version: 2, takeover: null, reply: false }));
  const replies = sentOf(harness.sent, 'notice', collabId).filter((frame) => frame.payload.event === 'handshake');
  assert.equal(replies.length, 1);
  assert.equal(replies[0].payload.reply, true);
  assert.equal(replies[0].to.instanceId, 'inst-b');
  harness.sent.length = 0;
  await receive(harness.service, collabFrame('notice', collabId, peer('inst-b', '主机乙'), { event: 'handshake', role: 'member', version: 2, takeover: null, reply: true }));
  assert.equal(sentOf(harness.sent, 'notice', collabId).filter((frame) => frame.payload.event === 'handshake').length, 0);
});

test('握手：成员对表——现任驿丞版本更高时拉取当前视图', async (t) => {
  const harness = makeHarness(t);
  const collabId = await memberActive(harness);
  harness.sent.length = 0;
  await receive(harness.service, collabFrame('notice', collabId, peer('inst-a', '主机甲'), { event: 'handshake', role: 'manager', version: 9, takeover: null, reply: false }));
  assert.equal(sentOf(harness.sent, 'snapshot', collabId).some((frame) => frame.payload.kind === 'request'), true);
});

test('握手：发现驿丞已换（对表）——引用更新 + 陈旧队列重定向', async (t) => {
  const harness = makeHarness(t);
  const collabId = await memberActive(harness);
  await harness.service.send({ collabId, text: '在途消息' });
  harness.reassigns.length = 0;
  await receive(harness.service, collabFrame('notice', collabId, peer('inst-b', '主机乙'), { event: 'handshake', role: 'manager', version: 5, takeover: null, reply: false }));
  const member = JSON.parse(readFileSync(join(harness.dir, 'collabs', collabId, 'member.json'), 'utf8'));
  assert.equal(member.manager.instanceId, 'inst-b');
  assert.equal(harness.reassigns.length, 1, '发往旧驿丞的未确认条目已重定向');
  assert.equal(harness.reassigns[0].fromInstanceId, 'inst-a');
  assert.equal(harness.reassigns[0].to.instanceId, 'inst-b');
  assert.equal(harness.service.stats().managerChangedIn >= 1, true);
});

test('握手：无法对表（在册端点无回帧）——管理席位转只读保守运行，接触后恢复', async (t) => {
  const harness = makeHarness(t);
  const collabId = await managerActive(harness);
  harness.service.start();
  await waitFor(() => (harness.service.list().collabs[0].suspended === true ? true : null), { timeoutMs: 3000 });
  const blocked = await harness.service.send({ collabId, text: '暂停期消息', type: 'issue' });
  assert.equal(blocked.ok, false);
  assert.ok(blocked.message.includes('暂停'));
  assert.equal(harness.service.stats().handshakeUnresolved >= 1, true);
  /* 「任一成功接触」口径：不限于握手帧——在册成员的普通消息经端点学习同样证明对端可达。 */
  await receive(harness.service, collabFrame('reply', collabId, peer('inst-b', '主机乙'), { text: '任意在册联系' }));
  assert.equal(harness.service.list().collabs[0].suspended, false, '任一已受理帧即视为接触（恢复）');
  harness.service.close();
});

/* 磁盘点：清空管理席位记录的端点表（模拟邀请目标从未联系过的状态）后重建服务。 */
function clearEndpointsOnDisk(harness, collabId) {
  const memberPath = join(harness.dir, 'collabs', collabId, 'member.json');
  const member = JSON.parse(readFileSync(memberPath, 'utf8'));
  member.endpoints = {};
  writeFileSync(memberPath, JSON.stringify(member));
}

test('握手：无在册端点时不置保守态（无从对表即无对表义务）', async (t) => {
  const harness = makeHarness(t);
  const collabId = await managerActive(harness);
  clearEndpointsOnDisk(harness, collabId);
  const reloaded = reloadServiceOn(t, harness);
  reloaded.start();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(reloaded.list().collabs[0].suspended, false);
  reloaded.close();
});

/* —— 抢接规程 —— */

test('抢接发起守卫：管理器 / 未判失联 / 无快照 / 未接线探测均拒绝', async (t) => {
  const managerSide = makeHarness(t);
  const managed = await managerActive(managerSide);
  const asManager = await managerSide.service.takeOver({ collabId: managed });
  assert.equal(asManager.ok, false);
  assert.ok(asManager.message.includes('管理者'));

  const harness = makeHarness(t);
  const collabId = await memberActive(harness);
  const notOffline = await harness.service.takeOver({ collabId });
  assert.equal(notOffline.ok, false);
  assert.ok(notOffline.message.includes('失联'));

  const bare = makeHarness(t, { probe: null });
  const invite = collabFrame('invite', 'collab-bare', peer('inst-a', '主机甲'), {
    name: '无快照项目', topic: '主题',
    members: [{ instanceId: 'inst-a', identityName: '主机甲' }, { instanceId: 'inst-self', identityName: '本机' }],
  });
  await receive(bare.service, invite);
  const noProbe = await bare.service.takeOver({ collabId: 'collab-bare' });
  assert.equal(noProbe.ok, false);
  assert.ok(noProbe.message.includes('探测') || noProbe.message.includes('快照'));
});

test('抢接窗口：原驿丞恢复应答 → 中止并广播取消（假失联）', async (t) => {
  const harness = makeHarness(t);
  const collabId = await memberActive(harness);
  harness.service.start();
  await waitFor(() => (harness.service.list().collabs[0].managerOffline === true ? true : null), { timeoutMs: 3000 });
  harness.script.push({ reachable: true, rttMs: 1 });
  const verdict = await harness.service.takeOver({ collabId });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.message.includes('中止'));
  const cancels = sentOf(harness.sent, 'takeover-init', collabId).filter((frame) => frame.payload.kind === 'cancel');
  assert.equal(cancels.length >= 1, true, '中止即广播取消');
  assert.equal(harness.service.stats().takeoversAborted >= 1, true);
  harness.service.close();
});

test('抢接窗口：仍失联 → 待本机人确认；confirm=false 放弃并广播取消', async (t) => {
  const harness = makeHarness(t);
  const collabId = await memberActive(harness);
  harness.service.start();
  await waitFor(() => (harness.service.list().collabs[0].managerOffline === true ? true : null), { timeoutMs: 3000 });
  const verdict = await harness.service.takeOver({ collabId });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.phase, 'awaiting-confirm');
  assert.equal(verdict.baseVersion, 2);
  assert.equal(harness.notified.some((frame) => frame.payload.text.includes('ws_take_over')), true, '投递会话提示确认');
  const declined = await harness.service.takeOver({ collabId, confirm: false });
  assert.equal(declined.ok, true);
  assert.ok(declined.message.includes('放弃'));
  assert.equal(harness.service.stats().takeoversAborted >= 1, true);
  harness.service.close();
});

test('抢接生效：从快照恢复（manager 换本机、版本保持基准）、广播 takeover、推当前视图', async (t) => {
  const harness = makeHarness(t);
  const collabId = await memberActive(harness);
  harness.service.start();
  await waitFor(() => (harness.service.list().collabs[0].managerOffline === true ? true : null), { timeoutMs: 3000 });
  const verdict = await harness.service.takeOver({ collabId });
  assert.equal(verdict.phase, 'awaiting-confirm');
  harness.sent.length = 0;
  const applied = await harness.service.takeOver({ collabId, confirm: true });
  assert.equal(applied.ok, true);
  const viewed = await harness.service.view({ collabId });
  assert.equal(viewed.source, 'local');
  assert.equal(viewed.ledger.manager.instanceId, 'inst-self');
  assert.equal(viewed.ledger.version, 2, '版本号跨抢接延续（保持基准值）');
  const broadcasts = sentOf(harness.sent, 'takeover', collabId);
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].payload.baseVersion, 2);
  assert.equal(ledgerDigest(viewed.ledger), broadcasts[0].payload.digest, '通告摘要 = 恢复台账摘要');
  assert.equal(sentOf(harness.sent, 'snapshot', collabId).filter((frame) => frame.payload.kind === 'data').length >= 1, true, '承担席位即推当前视图');
  assert.equal(harness.service.stats().takeoversEffective >= 1, true);
  harness.service.close();
});

test('抢接生效前最后探测：原驿丞复活 → 中止不生效', async (t) => {
  const harness = makeHarness(t);
  const collabId = await memberActive(harness);
  harness.service.start();
  await waitFor(() => (harness.service.list().collabs[0].managerOffline === true ? true : null), { timeoutMs: 3000 });
  await harness.service.takeOver({ collabId });
  harness.script.push({ reachable: true, rttMs: 1 });
  const applied = await harness.service.takeOver({ collabId, confirm: true });
  assert.equal(applied.ok, false);
  assert.ok(applied.message.includes('中止'));
  assert.equal(harness.service.list().collabs[0].role, 'member');
  harness.service.close();
});

test('并发让位与顺位：更高优先意图到达即让位；让位对象取消后顺位提示可再确认', async (t) => {
  const harness = makeHarness(t);
  const collabId = await memberActive(harness);
  harness.service.start();
  await waitFor(() => (harness.service.list().collabs[0].managerOffline === true ? true : null), { timeoutMs: 3000 });
  const pending = harness.service.takeOver({ collabId });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const rival = peer('inst-c', '主机丙');
  await receive(harness.service, collabFrame('takeover-init', collabId, rival, {
    kind: 'announce', manager: { instanceId: 'inst-a', identityName: '主机甲' }, baseVersion: 7, windowEndsAt: new Date(Date.now() + 60000).toISOString(),
  }));
  const verdict = await pending;
  assert.equal(verdict.ok, false);
  assert.ok(verdict.message.includes('让位'));
  assert.equal(harness.service.stats().takeoversYielded >= 1, true);
  harness.sent.length = 0;
  await receive(harness.service, collabFrame('takeover-init', collabId, rival, { kind: 'cancel', reason: '候选放弃' }));
  assert.equal(harness.notified.some((frame) => frame.payload.text.includes('顺位')), true, '顺位提示投递会话');
  const applied = await harness.service.takeOver({ collabId, confirm: true });
  assert.equal(applied.ok, true, '顺位后 confirm=true 直接生效');
  assert.equal(harness.service.list().collabs[0].role, 'manager');
  harness.service.close();
});

test('收到意图（管理席位）：挂起在途（写暂停）；取消到达即恢复', async (t) => {
  const harness = makeHarness(t);
  const collabId = await managerActive(harness);
  await receive(harness.service, collabFrame('takeover-init', collabId, peer('inst-b', '主机乙'), {
    kind: 'announce', manager: { instanceId: 'inst-self', identityName: '本机' }, baseVersion: 3, windowEndsAt: new Date(Date.now() + 60000).toISOString(),
  }));
  assert.equal(harness.service.list().collabs[0].suspended, true);
  const blocked = await harness.service.send({ collabId, text: '暂停期', type: 'issue' });
  assert.equal(blocked.ok, false);
  const reports = sentOf(harness.sent, 'takeover-init', collabId).filter((frame) => frame.payload.kind === 'report');
  assert.equal(reports.length, 1, '向候选定向回汇总');
  assert.equal(reports[0].payload.version, 3, '版本 = 台账当前版本');
  await receive(harness.service, collabFrame('takeover-init', collabId, peer('inst-b', '主机乙'), { kind: 'cancel', reason: '原驿丞恢复应答' }));
  assert.equal(harness.service.list().collabs[0].suspended, false);
  const resumed = await harness.service.send({ collabId, text: '恢复后消息', type: 'issue' });
  assert.equal(resumed.ok, true);
});

test('收到意图（旁观成员）：转达并回汇总；同原帧重复副本不再转达', async (t) => {
  const harness = makeHarness(t);
  const collabId = await memberActive(harness);
  const rival = peer('inst-c', '主机丙');
  const announce = collabFrame('takeover-init', collabId, rival, {
    kind: 'announce', manager: { instanceId: 'inst-a', identityName: '主机甲' }, baseVersion: 5, windowEndsAt: new Date(Date.now() + 60000).toISOString(),
  });
  await receive(harness.service, announce);
  const relays = () => harness.sent.filter((frame) => frame.type === 'takeover-init' && frame.to.instanceId === 'inst-a').length;
  assert.equal(relays(), 1, '向其他在线参与者转达（此处为驿丞端点）');
  assert.equal(sentOf(harness.sent, 'takeover-init', collabId).filter((frame) => frame.payload.kind === 'report').length, 1, '向候选定向回汇总');
  harness.sent.length = 0;
  await receive(harness.service, { ...announce, msgId: 'msg-copy-1', payload: { ...announce.payload, originMsgId: announce.msgId } });
  assert.equal(relays(), 0, '同原帧重复副本不再转达');
});

test('收到生效通告（成员侧）：引用更新 + 合流递交（本地版本更高）', async (t) => {
  const harness = makeHarness(t);
  const collabId = await memberActive(harness);
  await deliverSnapshot(harness, collabId, 5);
  harness.sent.length = 0;
  await receive(harness.service, collabFrame('takeover', collabId, peer('inst-b', '主机乙'), { baseVersion: 4, digest: ledgerDigest(ledgerStub(collabId, 4)) }));
  const member = JSON.parse(readFileSync(join(harness.dir, 'collabs', collabId, 'member.json'), 'utf8'));
  assert.equal(member.manager.instanceId, 'inst-b');
  const offers = sentOf(harness.sent, 'notice', collabId).filter((frame) => frame.payload.event === 'merge-request');
  assert.equal(offers.length, 1);
  assert.equal(offers[0].payload.baseVersion, 4);
  assert.equal(offers[0].payload.version, 5);
  assert.equal(offers[0].to.instanceId, 'inst-b');
  assert.equal(harness.service.stats().mergeOffersSent >= 1, true);
});

test('收到生效通告（原驿丞侧）：停写 → 降级为成员、删除本地台账、保留快照备份、提示本机人', async (t) => {
  const harness = makeHarness(t);
  const collabId = await managerActive(harness);
  const ledgerPath = collabFilePath(harness.dir, collabId, LEDGER_FILE_NAME);
  assert.equal(existsSync(ledgerPath), true);
  harness.notified.length = 0;
  await receive(harness.service, collabFrame('takeover', collabId, peer('inst-b', '主机乙'), { baseVersion: 2, digest: ledgerDigest(ledgerStub(collabId, 2, { instanceId: 'inst-b', identityName: '主机乙' })) }));
  const entry = harness.service.list().collabs[0];
  assert.equal(entry.role, 'member');
  assert.equal(existsSync(ledgerPath), false, '单副本纪律：本地台账已删除');
  assert.equal(existsSync(join(harness.dir, 'collabs', collabId, 'snapshot.json')), true, '快照保留为成员备份');
  assert.equal(harness.notified.some((frame) => frame.payload.text.includes('已被替换')), true);
  assert.equal(harness.service.stats().takeoverDowngrades >= 1, true);
});

test('收到生效通告（原驿丞本地版本更高）：合流递交后照常降级', async (t) => {
  const harness = makeHarness(t);
  const collabId = await managerActive(harness);
  await receive(harness.service, collabFrame('topic', collabId, peer('inst-b', '主机乙'), { text: '分区期间的主题变更' }));
  assert.equal(harness.service.list().collabs[0].version, 4);
  harness.sent.length = 0;
  await receive(harness.service, collabFrame('takeover', collabId, peer('inst-c', '主机丙'), { baseVersion: 3, digest: ledgerDigest(ledgerStub(collabId, 3)) }));
  const offers = sentOf(harness.sent, 'notice', collabId).filter((frame) => frame.payload.event === 'merge-request');
  assert.equal(offers.length, 1, '超出部分已递交（人裁定采纳 / 丢弃）');
  assert.equal(offers[0].payload.version, 4);
  assert.equal(offers[0].payload.baseVersion, 3);
  assert.equal(harness.service.list().collabs[0].role, 'member');
});

test('对立生效抢接（收敛兜底）：弱通告被取代、强通告使既有生效者让位', async (t) => {
  const harness = makeHarness(t);
  const collabId = await memberActive(harness);
  await receive(harness.service, collabFrame('takeover', collabId, peer('inst-b', '主机乙'), { baseVersion: 5, digest: ledgerDigest(ledgerStub(collabId, 5)) }));
  const supersededBefore = harness.service.stats().takeoverSuperseded;
  await receive(harness.service, collabFrame('takeover', collabId, peer('inst-c', '主机丙'), { baseVersion: 4, digest: ledgerDigest(ledgerStub(collabId, 4)) }));
  assert.equal(harness.service.stats().takeoverSuperseded, supersededBefore + 1, '弱优先通告只转达不取代');
  await receive(harness.service, collabFrame('takeover', collabId, peer('inst-d', '主机丁'), { baseVersion: 9, digest: ledgerDigest(ledgerStub(collabId, 9)) }));
  const member = JSON.parse(readFileSync(join(harness.dir, 'collabs', collabId, 'member.json'), 'utf8'));
  assert.equal(member.manager.instanceId, 'inst-d', '更强通告成为现任');
});

/* 重载工具（与本文件脚手同参；端点保留磁盘态）。 */
function reloadServiceOn(t, made) {
  return createCollabService({
    dataDir: made.dir,
    config: made.config,
    self: made.self,
    send: (message) => {
      made.sent.push(message);
      return { ok: true, msgId: `q-${made.sent.length}` };
    },
    knownHosts: { remember: () => {} },
    log: quietLog(),
    ledgerFetchTimeoutMs: 30,
    inviteMinIntervalMs: 0,
    probe: null,
    reassign: () => ({ ok: true, moved: 0 }),
    notify: (frame) => {
      made.notified.push(frame);
    },
    takeoverProbeIntervalMs: 5,
    handshakeReplyTimeoutMs: 40,
    handoverConfirmTimeoutMs: 40,
  });
}

test('握手：管理席位收「记录指向本机」的对表回帧——零动作（不自我降级）', async (t) => {
  /* 判别性用例（源自对抗评审行为探针）：新驿丞重启后与持记录的成员回帧对表，
   * 成员的视图里「生效抢接者就是本机」——管理者分支必须识别自我引用并视为继续。 */
  const harness = makeHarness(t);
  const collabId = await managerActive(harness);
  const ledgerPath = collabFilePath(harness.dir, collabId, LEDGER_FILE_NAME);
  await receive(harness.service, collabFrame('notice', collabId, peer('inst-b', '主机乙'), {
    event: 'handshake',
    role: 'member',
    version: 3,
    takeover: { phase: 'effective', candidate: { instanceId: 'inst-self', identityName: '本机' }, baseVersion: 3 },
    reply: true,
  }));
  const entry = harness.service.list().collabs[0];
  assert.equal(entry.role, 'manager', '自身记录不触发降级');
  assert.equal(existsSync(ledgerPath), true, '本地台账不删');
  assert.equal(harness.service.stats().takeoverDowngrades, 0);
  assert.equal(harness.service.stats().suspensions, 0, '自身记录不算他方在途');
  const writable = await harness.service.send({ collabId, text: '仍在写', type: 'issue' });
  assert.equal(writable.ok, true);
});

test('握手：管理席位收「他方生效记录」——照常降级与合流路径不变（回归守卫）', async (t) => {
  const harness = makeHarness(t);
  const collabId = await managerActive(harness);
  await receive(harness.service, collabFrame('notice', collabId, peer('inst-b', '主机乙'), {
    event: 'handshake',
    role: 'member',
    version: 3,
    takeover: { phase: 'effective', candidate: { instanceId: 'inst-e', identityName: '主机戊' }, baseVersion: 3 },
    reply: true,
  }));
  assert.equal(harness.service.list().collabs[0].role, 'member', '他方生效即让位');
  assert.equal(harness.service.stats().takeoverDowngrades >= 1, true);
});

test('抢接窗口止：在册低优先 rival 不让位（本机仍为最高优先 → 待确认）', async (t) => {
  /* 判别性用例（源自对抗评审行为探针）：到达时严格更低者既没即时让位、窗口末也不应让位——
   * 让位判定必须与自身比较（全序），否则确定性优先序可被时序倒挂。 */
  const harness = makeHarness(t, { config: { takeoverWindowMs: 300 } });
  const collabId = await memberActive(harness);
  harness.service.start();
  await waitFor(() => (harness.service.list().collabs[0].managerOffline === true ? true : null), { timeoutMs: 3000 });
  const pending = harness.service.takeOver({ collabId });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await receive(harness.service, collabFrame('takeover-init', collabId, peer('inst-c', '主机丙'), {
    kind: 'announce', manager: { instanceId: 'inst-a', identityName: '主机甲' }, baseVersion: 1, windowEndsAt: new Date(Date.now() + 60000).toISOString(),
  }));
  const verdict = await pending;
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
  assert.equal(verdict.phase, 'awaiting-confirm', '低优先 rival 在册不改变本机的最高优先');
  assert.equal(harness.service.stats().takeoversYielded, 0);
  harness.service.close();
});

test('confirm 越窗：收集期 confirm 明确拒绝（不生效），窗口结论后可正常确认', async (t) => {
  const harness = makeHarness(t, { config: { takeoverWindowMs: 400 } });
  const collabId = await memberActive(harness);
  harness.service.start();
  await waitFor(() => (harness.service.list().collabs[0].managerOffline === true ? true : null), { timeoutMs: 3000 });
  const pending = harness.service.takeOver({ collabId });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const early = await harness.service.takeOver({ collabId, confirm: true });
  assert.equal(early.ok, false);
  assert.ok(early.message.includes('窗口'));
  assert.equal(harness.service.stats().takeoversEffective, 0);
  const verdict = await pending;
  assert.equal(verdict.phase, 'awaiting-confirm', '首发调用未被 confirm 插入而悬挂');
  const applied = await harness.service.takeOver({ collabId, confirm: true });
  assert.equal(applied.ok, true, String(applied.message));
  harness.service.close();
});

test('快照回执计数：成员存储快照即回执并计数', async (t) => {
  const harness = makeHarness(t);
  const collabId = await memberActive(harness);
  assert.equal(harness.service.stats().snapshotStored >= 1, true);
  assert.equal(harness.service.stats().snapshotReceipts >= 1, true);
  const receipts = sentOf(harness.sent, 'notice', collabId).filter((frame) => frame.payload.event === 'snapshot-stored');
  assert.equal(receipts.length >= 1, true);
  assert.equal(receipts[0].to.instanceId, 'inst-a');
});

test('未知协作的普通帧：门控拒绝并计数（unknownCollab）', async (t) => {
  const harness = makeHarness(t);
  const admitted = await receive(harness.service, collabFrame('reply', 'collab-none', peer('inst-z', '主机Z'), { text: '你好' }));
  assert.equal(admitted.ok, false);
  assert.equal(harness.service.stats().unknownCollab >= 1, true);
});

/* —— 转达归因与快照漂移（修复轮判别用例）—— */

test('转达保原发身份：经转达的生效通告认候选不认转达者', async (t) => {
  /* 判别性用例（源自对抗评审行为探针）：转达出口原样携带原发 from——身份语义定义在 from 上，
   * 改写为转达者会让接收方把转达者当作新驿丞（归因错位、写路径随之外错）。 */
  const relayNode = makeHarness(t, { self: { instanceId: 'inst-b', identityName: '主机乙', port: 17321 } });
  const collabId = await memberActive(relayNode, { collabId: 'collab-relay' });
  const digest = ledgerDigest(ledgerStub(collabId, 5, { instanceId: 'inst-c', identityName: '主机丙' }));
  const incoming = collabFrame('takeover', collabId, peer('inst-c', '主机丙'), { baseVersion: 5, digest });
  await receive(relayNode.service, incoming);
  const relay = relayNode.sent.find((entry) => entry.type === 'takeover' && entry.to.instanceId === 'inst-a');
  assert.equal(relay?.from?.instanceId, 'inst-c', '转达帧保留原发身份，不改写为转达者');
  assert.equal(relay.payload.originMsgId, incoming.msgId, '转达幂等键沿用原帧标识');

  const target = makeHarness(t);
  await memberActive(target, { collabId });
  await receive(target.service, collabFrame('takeover', collabId, relay.from, relay.payload), '127.0.0.9');
  const member = JSON.parse(readFileSync(join(target.dir, 'collabs', collabId, 'member.json'), 'utf8'));
  assert.equal(member.manager.instanceId, 'inst-c', '接收方采纳候选（转达者 inst-b 不得被当作新驿丞）');
  assert.equal(member.endpoints['inst-c'], undefined, '转达帧不作端点学习：from 是原发者、链路地址是转达者的');
});

test('转达保原发身份：同版本下转达者字典序更小不压过真实新驿丞', async (t) => {
  /* 判别性用例（源自对抗评审行为探针两态）：若转达把 from 改写为转达者（inst-b < inst-c），
   * 接收方在同基准版本下按实例标识序会把转达者当更高优先——真实新驿丞被转达噪声压过。 */
  const relayNode = makeHarness(t, { self: { instanceId: 'inst-b', identityName: '主机乙', port: 17321 } });
  const collabId = await memberActive(relayNode, { collabId: 'collab-relay-rank' });
  const digest = ledgerDigest(ledgerStub(collabId, 5, { instanceId: 'inst-c', identityName: '主机丙' }));
  await receive(relayNode.service, collabFrame('takeover', collabId, peer('inst-c', '主机丙'), { baseVersion: 5, digest }));
  const relay = relayNode.sent.find((entry) => entry.type === 'takeover' && entry.to.instanceId === 'inst-a');
  assert.equal(relay?.from?.instanceId, 'inst-c', '转达帧保留原发身份');

  const target = makeHarness(t);
  await memberActive(target, { collabId });
  await receive(target.service, collabFrame('takeover', collabId, peer('inst-c', '主机丙'), { baseVersion: 5, digest }));
  await receive(target.service, collabFrame('takeover', collabId, relay.from, relay.payload));
  const member = JSON.parse(readFileSync(join(target.dir, 'collabs', collabId, 'member.json'), 'utf8'));
  assert.equal(member.manager.instanceId, 'inst-c', '同版本转达不改变现任（转达者不压过真实新驿丞）');
  assert.equal(target.service.stats().takeoverSuperseded, 0, '同候选重复通告不走「弱优先取代」路径');
});

test('抢接生效：窗口内快照漂移——生效帧 baseVersion 取生效时台账真值', async (t) => {
  /* 判别性用例（源自对抗评审行为探针）：收集窗口内到达更新的原驿丞快照（版本漂移）——
   * 生效帧与恢复台账同源取真值，不沿用发起时宣布的旧基准（优先序与合流判定不被错值污染）。 */
  const harness = makeHarness(t);
  const collabId = await memberActive(harness);
  harness.service.start();
  await waitFor(() => (harness.service.list().collabs[0].managerOffline === true ? true : null), { timeoutMs: 3000 });
  const verdict = await harness.service.takeOver({ collabId });
  assert.equal(verdict.phase, 'awaiting-confirm');
  assert.equal(verdict.baseVersion, 2, '宣布基准为发起时快照版本');
  await deliverSnapshot(harness, collabId, 5);
  harness.sent.length = 0;
  const applied = await harness.service.takeOver({ collabId, confirm: true });
  assert.equal(applied.ok, true, String(applied.message));
  assert.ok(applied.message.includes('5'), '生效提示回报真值版本');
  const viewed = await harness.service.view({ collabId });
  assert.equal(viewed.ledger.version, 5, '恢复台账为窗口内收到的最新快照');
  const broadcasts = sentOf(harness.sent, 'takeover', collabId);
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].payload.baseVersion, 5, '生效帧基准 = 生效时台账真值');
  assert.equal(broadcasts[0].payload.digest, ledgerDigest(viewed.ledger), '通告摘要 = 恢复台账摘要');
  harness.service.close();
});

test('计数断言：无端点成员被治理广播跳过（rosterSkipped）；端点学得后补发生效通告（takeoverResends）', async (t) => {
  const harness = makeHarness(t);
  const collabId = 'collab-counters';
  const manager = peer('inst-a', '主机甲');
  const invite = collabFrame('invite', collabId, manager, {
    name: '联调项目',
    topic: '发布联调',
    members: [
      { instanceId: 'inst-a', identityName: '主机甲' },
      { instanceId: harness.self.instanceId, identityName: harness.self.identityName },
      { instanceId: 'inst-d', identityName: '主机丁' },
    ],
  });
  await receive(harness.service, invite);
  await harness.service.approve({ collabId, approve: true });
  await receive(harness.service, collabFrame('notice', collabId, manager, { event: 'established', version: 2 }));
  await deliverSnapshot(harness, collabId, 2, manager);
  harness.service.start();
  await waitFor(() => (harness.service.list().collabs[0].managerOffline === true ? true : null), { timeoutMs: 3000 });
  const skippedBefore = harness.service.stats().rosterSkipped;
  const verdict = await harness.service.takeOver({ collabId });
  assert.equal(verdict.phase, 'awaiting-confirm');
  assert.equal(harness.service.stats().rosterSkipped > skippedBefore, true, '名册中端点未知的成员被跳过并计数');
  const applied = await harness.service.takeOver({ collabId, confirm: true });
  assert.equal(applied.ok, true, String(applied.message));
  const resendsBefore = harness.service.stats().takeoverResends;
  harness.sent.length = 0;
  await receive(harness.service, collabFrame('reply', collabId, peer('inst-a', '主机甲', 17322), { text: '原驿丞换端口联系' }));
  assert.equal(harness.service.stats().takeoverResends, resendsBefore + 1, '端点学得后补发生效通告');
  const resent = sentOf(harness.sent, 'takeover', collabId);
  assert.equal(resent.length, 1);
  assert.equal(resent[0].to.instanceId, 'inst-a');
  assert.equal(resent[0].payload.baseVersion, 2);
  harness.service.close();
});
