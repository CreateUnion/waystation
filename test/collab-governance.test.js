import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { collabFilePath } from '../src/paths.js';
import { makeTempDir, waitFor } from './helpers.js';
import { createCollabService } from '../src/collab/service.js';
import { LEDGER_FILE_NAME, ledgerDigest } from '../src/collab/store.js';

const DAY = 24 * 60 * 60 * 1000;

function quietLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function probeQueue(results = []) {
  const queue = [...results];
  return async () => queue.shift() ?? { reachable: false, reason: '脚本耗尽（默认不可达）' };
}

/* 服务脚手架：真实临时目录 + 假发送 / 探测 / 队列改投 / 提示（治理用例参数收短）。 */
function makeHarness(t, overrides = {}) {
  const dir = makeTempDir(t);
  const sent = [];
  const notified = [];
  const reassigns = [];
  const self = overrides.self ?? { instanceId: 'inst-self', identityName: '本机', port: 17321 };
  const config = {
    inviteTtlMs: DAY,
    managerProbeIntervalMs: 20,
    managerOfflineMs: 40,
    takeoverWindowMs: 60,
    freezeUnresolvedMs: overrides.freezeUnresolvedMs ?? DAY,
    ...(overrides.config ?? {}),
  };
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
    probe: overrides.probe === undefined ? probeQueue(overrides.probeResults ?? []) : overrides.probe,
    reassign: (payload) => {
      reassigns.push(payload);
      return { ok: true, moved: overrides.moved ?? 0 };
    },
    notify: (frame) => {
      notified.push(frame);
    },
    takeoverProbeIntervalMs: 5,
    handshakeReplyTimeoutMs: 40,
    handoverConfirmTimeoutMs: overrides.handoverConfirmTimeoutMs ?? 500,
  });
  return { service, sent, notified, reassigns, dir, self, config };
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

function ledgerStub(collabId, version, { manager = { instanceId: 'inst-a', identityName: '主机甲' }, board = [], status = 'active', name = '联调项目' } = {}) {
  const now = new Date().toISOString();
  return {
    version,
    collabId,
    name,
    topic: '发布联调',
    status,
    manager: { instanceId: manager.instanceId, identityName: manager.identityName },
    members: [
      { instanceId: manager.instanceId, identityName: manager.identityName, role: 'manager', state: 'member', joinedAt: now },
      { instanceId: 'inst-b', identityName: '主机乙', role: 'member', state: 'member', joinedAt: now },
    ],
    board,
    createdAt: now,
    updatedAt: now,
  };
}

/* 站长席位侧已建立的协作（v3：创建 v1 + 回应 v2 + 建立 v3；成员 inst-b 端点已知）。 */
async function managerActive(harness, { name = '联调项目' } = {}) {
  const created = harness.service.create({
    name,
    topic: '发布联调',
    targets: [{ instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.2', port: 17321 }],
  });
  await receive(harness.service, collabFrame('approve', created.collabId, peer('inst-b', '主机乙'), {}));
  return created.collabId;
}

/* 经冻结广播把本机匹配协作冻上（与冲突检出同判据：同名 + 成员交集）。 */
async function freezeViaBroadcast(harness, collabId, { name = '联调项目', from = peer('inst-c', '主机丙'), rivalMembers = null, extra = {} } = {}) {
  const members = rivalMembers ?? [
    { instanceId: 'inst-c', identityName: '主机丙' },
    { instanceId: 'inst-b', identityName: '主机乙' },
  ];
  await receive(harness.service, collabFrame('freeze', 'collab-rival', from, { name, members, reason: '同名冲突', ...extra }));
  return collabId;
}

/* —— 冻结裁定 —— */

test('decide keep：解除冻结回冻结前状态 + 广播 unfreeze；重复裁定被拒（非冻结）', async (t) => {
  const harness = makeHarness(t);
  const collabId = await managerActive(harness);
  await freezeViaBroadcast(harness, collabId);
  assert.equal(harness.service.list().collabs[0].state, 'frozen');
  harness.sent.length = 0;
  const kept = harness.service.decide({ collabId, choice: 'keep' });
  assert.equal(kept.ok, true);
  assert.equal(harness.service.list().collabs[0].state, 'active', '回冻结前状态');
  const unfreezes = sentOf(harness.sent, 'unfreeze', collabId);
  assert.equal(unfreezes.length, 1);
  assert.equal(unfreezes[0].payload.name, '联调项目');
  assert.equal(unfreezes[0].to.instanceId, 'inst-b');
  assert.equal(harness.service.decide({ collabId, choice: 'keep' }).ok, false, '已解除即拒绝');
  assert.equal(harness.service.stats().freezeDecisionsOut, 1);
});

test('decide terminate：本机该条终止并归档 + 广播执行帧', async (t) => {
  const harness = makeHarness(t);
  const collabId = await managerActive(harness);
  await freezeViaBroadcast(harness, collabId);
  harness.sent.length = 0;
  const ended = harness.service.decide({ collabId, choice: 'terminate' });
  assert.equal(ended.ok, true);
  const entry = harness.service.list().collabs[0];
  assert.equal(entry.state, 'terminated');
  assert.equal(entry.archived, true);
  const decisions = sentOf(harness.sent, 'decision', collabId);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].payload.choice, 'terminate');
  assert.equal(decisions[0].payload.executed, true);
  assert.equal(decisions[0].payload.collabId, collabId);
});

test('decide 守卫：成员侧 / 非冻结 / 非法 choice 逐拒', async (t) => {
  const harness = makeHarness(t);
  const created = harness.service.create({ name: '联调项目', topic: '主题', targets: [{ instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.2', port: 17321 }] });
  assert.equal(harness.service.decide({ collabId: created.collabId, choice: 'keep' }).ok, false, '提议中（未冻结）拒绝');
  assert.equal(harness.service.decide({ collabId: created.collabId, choice: 'bogus' }).ok, false);
  const memberSide = makeHarness(t, { self: { instanceId: 'inst-m', identityName: '成员机', port: 17321 } });
  const invite = collabFrame('invite', 'collab-m', peer('inst-a', '主机甲'), {
    name: '联调项目', topic: '主题',
    members: [{ instanceId: 'inst-a', identityName: '主机甲' }, { instanceId: 'inst-m', identityName: '成员机' }],
  });
  await receive(memberSide.service, invite);
  assert.equal(memberSide.service.decide({ collabId: 'collab-m', choice: 'keep' }).ok, false, '成员侧拒绝（路径是退出）');
});

test('裁定执行帧接收：终止命中本机条、其余匹配条解除冻结；本机更早数据时拒绝被并入', async (t) => {
  const harness = makeHarness(t);
  const collabId = await managerActive(harness);
  await freezeViaBroadcast(harness, collabId);
  await receive(harness.service, collabFrame('decision', 'collab-rival', peer('inst-c', '主机丙'), {
    choice: 'terminate', name: '联调项目', members: [{ instanceId: 'inst-c', identityName: '主机丙' }, { instanceId: 'inst-b', identityName: '主机乙' }],
    collabId: 'collab-rival', executed: true,
  }));
  assert.equal(harness.service.list().collabs[0].state, 'active', '对方条终止 → 本方解除冻结');

  const second = makeHarness(t);
  const secondId = await managerActive(second);
  await freezeViaBroadcast(second, secondId);
  await receive(second.service, collabFrame('decision', 'collab-rival', peer('inst-c', '主机丙'), {
    choice: 'terminate', name: '联调项目', members: [{ instanceId: 'inst-c', identityName: '主机丙' }, { instanceId: 'inst-b', identityName: '主机乙' }],
    collabId: secondId, executed: true,
  }));
  assert.equal(second.service.list().collabs[0].state, 'terminated', '同 collabId 副本终止');
});

test('裁定接收·合并执行帧：winner 命中即解冻；未命中即被并入转终止；本机更早则保持冻结', async (t) => {
  const harness = makeHarness(t);
  const collabId = await managerActive(harness);
  await freezeViaBroadcast(harness, collabId);
  await receive(harness.service, collabFrame('decision', collabId, peer('inst-c', '主机丙'), {
    choice: 'merge', name: '联调项目', members: [{ instanceId: 'inst-c', identityName: '主机丙' }, { instanceId: 'inst-b', identityName: '主机乙' }],
    winner: collabId, executed: true,
  }));
  assert.equal(harness.service.list().collabs[0].state, 'active');

  const second = makeHarness(t);
  const secondId = await managerActive(second);
  await freezeViaBroadcast(second, secondId);
  await receive(second.service, collabFrame('decision', secondId, peer('inst-c', '主机丙'), {
    choice: 'merge', name: '联调项目', members: [{ instanceId: 'inst-c', identityName: '主机丙' }, { instanceId: 'inst-b', identityName: '主机乙' }],
    winner: 'collab-other', executed: true,
  }));
  assert.equal(second.service.list().collabs[0].state, 'terminated', '被并入条转终止');

  const third = makeHarness(t);
  const thirdId = await managerActive(third);
  await freezeViaBroadcast(third, thirdId);
  const earlier = third.service.view({ collabId: thirdId, });
  const earlierCreatedAt = (await earlier).ledger.createdAt;
  await receive(third.service, collabFrame('decision', thirdId, peer('inst-c', '主机丙'), {
    choice: 'merge', name: '联调项目', members: [{ instanceId: 'inst-c', identityName: '主机丙' }, { instanceId: 'inst-b', identityName: '主机乙' }],
    winner: 'collab-other', executed: true, createdAt: new Date(Date.parse(earlierCreatedAt) + 60000).toISOString(),
  }));
  assert.equal(third.service.list().collabs[0].state, 'frozen', '执行方更晚 → 拒绝被并入（保持冻结由人谈）');
  assert.equal(third.service.stats().freezeDecisionConflicts >= 1, true);
});

test('裁定意向帧：不自动执行，只记录并提示本机人；已处置本地状态不被相抵裁定回退', async (t) => {
  const harness = makeHarness(t);
  const collabId = await managerActive(harness);
  await freezeViaBroadcast(harness, collabId);
  harness.notified.length = 0;
  await receive(harness.service, collabFrame('decision', collabId, peer('inst-b', '主机乙'), {
    choice: 'merge', name: '联调项目', members: [{ instanceId: 'inst-b', identityName: '主机乙' }, { instanceId: 'inst-c', identityName: '主机丙' }],
    winner: 'collab-rival', executed: false, createdAt: new Date().toISOString(),
  }));
  assert.equal(harness.service.list().collabs[0].state, 'frozen', '意向不改本地冻结态');
  assert.equal(harness.notified.some((frame) => frame.payload.text.includes('对端选择了')), true);
  assert.equal(harness.service.stats().freezeIntentsIn >= 1, true);

  harness.service.decide({ collabId, choice: 'keep' });
  const conflicts = harness.service.stats().freezeDecisionConflicts;
  await receive(harness.service, collabFrame('decision', collabId, peer('inst-c', '主机丙'), {
    choice: 'terminate', name: '联调项目', members: [{ instanceId: 'inst-c', identityName: '主机丙' }, { instanceId: 'inst-b', identityName: '主机乙' }],
    collabId: 'collab-rival', executed: true,
  }));
  assert.equal(harness.service.stats().freezeDecisionConflicts, conflicts + 1, '相抵裁定只计数不回退');
  assert.equal(harness.service.list().collabs[0].state, 'active');
});

test('unfreeze 接收：匹配即回冻结前状态；非冻结协同幂等忽略', async (t) => {
  const harness = makeHarness(t);
  const collabId = await managerActive(harness);
  await freezeViaBroadcast(harness, collabId);
  await receive(harness.service, collabFrame('unfreeze', 'collab-rival', peer('inst-c', '主机丙'), {
    name: '联调项目', members: [{ instanceId: 'inst-c', identityName: '主机丙' }, { instanceId: 'inst-b', identityName: '主机乙' }],
  }));
  assert.equal(harness.service.list().collabs[0].state, 'active');
  assert.equal(harness.service.stats().unfreezesIn >= 1, true);
  const again = await receive(harness.service, collabFrame('unfreeze', 'collab-rival', peer('inst-c', '主机丙'), {
    name: '联调项目', members: [{ instanceId: 'inst-c', identityName: '主机丙' }, { instanceId: 'inst-b', identityName: '主机乙' }],
  }));
  assert.equal(again.ok, true, '重复解冻幂等放行');
  assert.equal(harness.service.list().collabs[0].state, 'active');
});

test('decide merge（保留方执行）：解冻 + 并集新增成员以 invited 入账 + 执行帧广播', async (t) => {
  const harness = makeHarness(t);
  const collabId = await managerActive(harness);
  await freezeViaBroadcast(harness, collabId, {
    extra: { createdAt: new Date(Date.now() + 3600000).toISOString(), manager: { instanceId: 'inst-c', identityName: '主机丙' } },
  });
  harness.sent.length = 0;
  const merged = harness.service.decide({ collabId, choice: 'merge' });
  assert.equal(merged.ok, true, String(merged.message));
  assert.equal(harness.service.list().collabs[0].state, 'active', '保留条解除冻结');
  const ledger = (await harness.service.view({ collabId })).ledger;
  const added = ledger.members.find((member) => member.instanceId === 'inst-c');
  assert.equal(added.state, 'invited', '新增参与者以 invited 入账（走同意门）');
  assert.equal(harness.service.stats().mergeInviteSkipped >= 1, true, '端点未知时暂缓邀请（登记边界）');
  const decisions = sentOf(harness.sent, 'decision', collabId);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].payload.choice, 'merge');
  assert.equal(decisions[0].payload.winner, collabId);
  assert.equal(decisions[0].payload.executed, true);
});

test('decide merge（非保留方）：改发意向帧，不本地执行', async (t) => {
  const harness = makeHarness(t);
  const collabId = await managerActive(harness);
  await freezeViaBroadcast(harness, collabId, {
    extra: { createdAt: new Date(Date.now() - 3600000).toISOString(), manager: { instanceId: 'inst-c', identityName: '主机丙' } },
  });
  harness.sent.length = 0;
  const merged = harness.service.decide({ collabId, choice: 'merge' });
  assert.equal(merged.ok, true);
  assert.ok(merged.message.includes('意向'));
  assert.equal(harness.service.list().collabs[0].state, 'frozen', '未本地执行');
  const intents = sentOf(harness.sent, 'decision', collabId);
  assert.equal(intents.length, 1);
  assert.equal(intents[0].payload.executed, false);
});

test('活跃协作的新增成员同意门：approve → member 定格 + 名单通告；decline → 定格 declined', async (t) => {
  const harness = makeHarness(t);
  const collabId = await managerActive(harness);
  /* 以第二次冻结合并的并集输入造出两名 invited 成员（c 与 d）——直接经 conflictRival 路径。 */
  await freezeViaBroadcast(harness, collabId, {
    extra: {
      createdAt: new Date(Date.now() + 3600000).toISOString(),
      manager: { instanceId: 'inst-c', identityName: '主机丙' },
      members: [
        { instanceId: 'inst-c', identityName: '主机丙' },
        { instanceId: 'inst-b', identityName: '主机乙' },
        { instanceId: 'inst-d', identityName: '主机丁' },
      ],
    },
  });
  harness.service.decide({ collabId, choice: 'merge' });
  harness.sent.length = 0;
  await receive(harness.service, collabFrame('approve', collabId, peer('inst-c', '主机丙'), {}));
  await receive(harness.service, collabFrame('decline', collabId, peer('inst-d', '主机丁'), { reason: '忙' }));
  const ledger = (await harness.service.view({ collabId })).ledger;
  assert.equal(ledger.members.find((member) => member.instanceId === 'inst-c').state, 'member');
  assert.equal(ledger.members.find((member) => member.instanceId === 'inst-d').state, 'declined');
  assert.equal(sentOf(harness.sent, 'notice', collabId).some((frame) => frame.payload.event === 'roster'), true, '新成员定格即名单通告');
});

/* —— 合流递交 —— */

function mergeRequestFrame(collabId, from, { baseVersion = 2, version = 5, tamper = false } = {}) {
  const ledger = ledgerStub(collabId, version, { board: [{ entryId: 'entry-1', ts: new Date().toISOString(), from: { instanceId: 'inst-b', identityName: '主机乙' }, kind: 'progress', text: '分区期间的进度' }] });
  const digest = tamper ? 'a'.repeat(64) : ledgerDigest(ledger);
  return collabFrame('notice', collabId, from, { event: 'merge-request', baseVersion, version, digest, ledger });
}

test('合流递交接收与裁定：accept 采纳看板增量（重编版本）+ 回执；reject 丢弃；非法递交拒绝', async (t) => {
  const harness = makeHarness(t);
  const collabId = await managerActive(harness);
  harness.notified.length = 0;
  await receive(harness.service, mergeRequestFrame(collabId, peer('inst-b', '主机乙')));
  assert.equal(harness.service.stats().mergeRequestsIn >= 1, true);
  assert.equal(harness.notified.some((frame) => frame.payload.text.includes('合流递交')), true);
  const before = harness.service.list().collabs[0].version;
  harness.sent.length = 0;
  const accepted = harness.service.decideMerge({ collabId, mergeOffer: 'accept' });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.adopted, 1);
  const ledger = (await harness.service.view({ collabId })).ledger;
  assert.equal(ledger.board.length, 1);
  assert.equal(ledger.version, before + 1, '经正常变更路径重编版本');
  const outcomes = sentOf(harness.sent, 'notice', collabId).filter((frame) => frame.payload.event === 'merge-outcome');
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].payload.adopted, true);
  assert.equal(outcomes[0].to.instanceId, 'inst-b');
  assert.equal(harness.service.stats().mergeAdopted, 1);

  const second = makeHarness(t);
  const secondId = await managerActive(second);
  await receive(second.service, mergeRequestFrame(secondId, peer('inst-b', '主机乙')));
  const rejected = second.service.decideMerge({ collabId: secondId, mergeOffer: 'reject' });
  assert.equal(rejected.ok, true);
  const rejectedLedger = (await second.service.view({ collabId: secondId })).ledger;
  assert.equal(rejectedLedger.board.length, 0, '丢弃零变更');
  assert.equal(second.service.stats().mergeDiscarded, 1);

  const third = makeHarness(t);
  const thirdId = await managerActive(third);
  await receive(third.service, mergeRequestFrame(thirdId, peer('inst-b', '主机乙'), { tamper: true }));
  await receive(third.service, mergeRequestFrame(thirdId, peer('inst-b', '主机乙'), { baseVersion: 9, version: 9 }));
  assert.equal(third.service.stats().mergeCorrupt, 2, '摘要不符 / 无超出部分均拒绝');
  assert.equal(third.service.decideMerge({ collabId: thirdId, mergeOffer: 'accept' }).ok, false, '无待裁定递交');
});

test('合流裁定结果回执：留痕计数 + 提示', async (t) => {
  const harness = makeHarness(t);
  const collabId = await managerActive(harness);
  harness.notified.length = 0;
  await receive(harness.service, collabFrame('notice', collabId, peer('inst-b', '主机乙'), { event: 'merge-outcome', adopted: false }));
  assert.equal(harness.service.stats().mergeOutcomesIn >= 1, true);
  assert.equal(harness.notified.some((frame) => frame.payload.text.includes('丢弃')), true);
});

/* —— 48 小时无裁定 —— */

test('冻结超时提示：按时限提示一次（含单方处置指引），解除冻结后复位', async (t) => {
  const harness = makeHarness(t, { freezeUnresolvedMs: 40 });
  const collabId = await managerActive(harness);
  await freezeViaBroadcast(harness, collabId);
  harness.notified.length = 0;
  harness.service.start();
  await waitFor(() => (harness.service.list().collabs[0].frozenUnresolved === true ? true : null), { timeoutMs: 3000 });
  const hits = harness.notified.filter((frame) => frame.payload.text.includes('ws_decide'));
  assert.equal(hits.length, 1, '单次提示');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(harness.notified.filter((frame) => frame.payload.text.includes('ws_decide')).length, 1, '再 tick 不重复提示');
  harness.service.decide({ collabId, choice: 'keep' });
  assert.equal(harness.service.list().collabs[0].frozenUnresolved, false);
  harness.service.close();
});

/* —— 显式移交 —— */

function memberHarness(t) {
  return makeHarness(t, { self: { instanceId: 'inst-b', identityName: '主机乙', port: 17321 } });
}

async function memberActiveAt(harness, collabId, manager = peer('inst-a', '主机甲'), version = 3) {
  const invite = collabFrame('invite', collabId, manager, {
    name: '联调项目', topic: '发布联调',
    members: [{ instanceId: manager.instanceId, identityName: manager.identityName }, { instanceId: harness.self.instanceId, identityName: harness.self.identityName }],
  });
  await receive(harness.service, invite);
  await harness.service.approve({ collabId, approve: true });
  await receive(harness.service, collabFrame('notice', collabId, manager, { event: 'established', version }));
  const ledger = ledgerStub(collabId, version, { manager: { instanceId: manager.instanceId, identityName: manager.identityName } });
  await receive(harness.service, collabFrame('snapshot', collabId, manager, { kind: 'data', version, digest: ledgerDigest(ledger), ledger }));
}

test('移交全链：确认后旧席位清理台账并转成员，受让方担任席位并广播「站长已变更」', async (t) => {
  const a = makeHarness(t, { probeResults: [{ reachable: true, rttMs: 1 }] });
  const collabId = await managerActive(a);
  const b = memberHarness(t);
  await memberActiveAt(b, collabId);
  const ledgerPath = collabFilePath(a.dir, collabId, LEDGER_FILE_NAME);
  const pending = a.service.handover({ collabId, target: 'inst-b' });
  const offer = await waitFor(() => a.sent.find((frame) => frame.type === 'handover' && frame.payload.kind === 'offer'), { timeoutMs: 2000 });
  await receive(b.service, collabFrame('handover', collabId, peer('inst-a', '主机甲'), offer.payload));
  assert.equal(b.service.list().collabs[0].role, 'manager', '受让方担任站长席位');
  const accept = await waitFor(() => b.sent.find((frame) => frame.type === 'handover' && frame.payload.kind === 'accept'), { timeoutMs: 2000 });
  await receive(a.service, collabFrame('handover', collabId, peer('inst-b', '主机乙'), accept.payload));
  const result = await pending;
  assert.equal(result.ok, true, String(result.message));
  assert.equal(a.service.list().collabs[0].role, 'member', '旧席位转协作者');
  assert.equal(existsSync(ledgerPath), false, '先确认后删除：台账已清理');
  const changed = sentOf(a.sent, 'notice', collabId).filter((frame) => frame.payload.event === 'manager-changed');
  assert.equal(changed.length, 1);
  assert.equal(changed[0].payload.manager.instanceId, 'inst-b');
  assert.equal(a.service.stats().handoverCompleted, 1);
  assert.equal(b.service.stats().handoverAccepted, 1);
});

test('移交守卫与失败路径：目标离线拒绝、超时不删、对方拒绝、回执不符作废', async (t) => {
  const offline = makeHarness(t, { probeResults: [{ reachable: false, reason: '超时' }] });
  const offlineId = await managerActive(offline);
  const rejected = await offline.service.handover({ collabId: offlineId, target: 'inst-b' });
  assert.equal(rejected.ok, false);
  assert.ok(rejected.message.includes('离线'));
  assert.equal(existsSync(collabFilePath(offline.dir, offlineId, LEDGER_FILE_NAME)), true);

  const silent = makeHarness(t, { probeResults: [{ reachable: true }], handoverConfirmTimeoutMs: 30 });
  const silentId = await managerActive(silent);
  const waited = await silent.service.handover({ collabId: silentId, target: 'inst-b' });
  assert.equal(waited.ok, false);
  assert.ok(waited.message.includes('未收到'));
  assert.equal(existsSync(collabFilePath(silent.dir, silentId, LEDGER_FILE_NAME)), true, '无确认不删除');
  assert.equal(silent.service.stats().handoverTimeouts, 1);

  const refused = makeHarness(t, { probeResults: [{ reachable: true }], handoverConfirmTimeoutMs: 500 });
  const refusedId = await managerActive(refused);
  const pendingReject = refused.service.handover({ collabId: refusedId, target: 'inst-b' });
  const offer = await waitFor(() => refused.sent.find((frame) => frame.type === 'handover' && frame.payload.kind === 'offer'), { timeoutMs: 2000 });
  await receive(refused.service, collabFrame('handover', refusedId, peer('inst-b', '主机乙'), { kind: 'reject', reason: '人手紧张' }));
  const rejectResult = await pendingReject;
  assert.equal(rejectResult.ok, false);
  assert.ok(rejectResult.message.includes('人手紧张'));
  assert.equal(refused.service.stats().handoverRejected, 1);
  assert.equal(offer.payload.kind, 'offer');

  const mismatch = makeHarness(t, { probeResults: [{ reachable: true }], handoverConfirmTimeoutMs: 500 });
  const mismatchId = await managerActive(mismatch);
  const pendingMismatch = mismatch.service.handover({ collabId: mismatchId, target: 'inst-b' });
  await waitFor(() => mismatch.sent.find((frame) => frame.type === 'handover' && frame.payload.kind === 'offer'), { timeoutMs: 2000 });
  await receive(mismatch.service, collabFrame('handover', mismatchId, peer('inst-b', '主机乙'), { kind: 'accept', version: 2, digest: 'b'.repeat(64) }));
  const mismatchResult = await pendingMismatch;
  assert.equal(mismatchResult.ok, false);
  assert.ok(mismatchResult.message.includes('不符') || mismatchResult.message.includes('作废'));
  assert.equal(existsSync(collabFilePath(mismatch.dir, mismatchId, LEDGER_FILE_NAME)), true);
});

test('移交受理（目标侧）：来源非现任站长忽略；冻结中由门控拒绝（不处理不经手）', async (t) => {
  const b = memberHarness(t);
  const collabId = 'collab-h';
  await memberActiveAt(b, collabId);
  const rogue = collabFrame('handover', collabId, peer('inst-z', '主机Z'), { kind: 'offer', version: 3, digest: ledgerDigest(ledgerStub(collabId, 3)), ledger: ledgerStub(collabId, 3) });
  await receive(b.service, rogue);
  assert.equal(b.service.list().collabs[0].role, 'member', '冒充来源不生效');
  assert.equal(b.service.stats().handoverRejected >= 1, true);

  const frozenB = memberHarness(t);
  const frozenId = 'collab-f';
  await memberActiveAt(frozenB, frozenId);
  await receive(frozenB.service, collabFrame('freeze', 'collab-rival', peer('inst-c', '主机丙'), {
    name: '联调项目', members: [{ instanceId: 'inst-c', identityName: '主机丙' }, { instanceId: 'inst-b', identityName: '主机乙' }],
  }));
  assert.equal(frozenB.service.list().collabs[0].state, 'frozen');
  const offerLedger = ledgerStub(frozenId, 3);
  const gated = await frozenB.service.hooks.admit(collabFrame('handover', frozenId, peer('inst-a', '主机甲'), { kind: 'offer', version: 3, digest: ledgerDigest(offerLedger), ledger: offerLedger }), { remoteAddress: '127.0.0.1' });
  assert.equal(gated.ok, false, '冻结白名单不含 handover：门控拒绝（发送方按无回执收敛）');
  assert.equal(frozenB.service.list().collabs[0].state, 'frozen');
});

test('站长变更通告接收：来源为现任站长时更新引用；来源不符忽略并计数', async (t) => {
  const b = memberHarness(t);
  const collabId = 'collab-mc';
  await memberActiveAt(b, collabId);
  await receive(b.service, collabFrame('notice', collabId, peer('inst-a', '主机甲'), { event: 'manager-changed', version: 3, manager: { instanceId: 'inst-e', identityName: '主机戊' } }));
  const member = JSON.parse(readFileSync(join(b.dir, 'collabs', collabId, 'member.json'), 'utf8'));
  assert.equal(member.manager.instanceId, 'inst-e');
  const before = b.service.stats().eventMismatch;
  await receive(b.service, collabFrame('notice', collabId, peer('inst-z', '主机Z'), { event: 'manager-changed', version: 3, manager: { instanceId: 'inst-f', identityName: '主机己' } }));
  assert.equal(b.service.stats().eventMismatch, before + 1, '非现任来源忽略');
  const memberAgain = JSON.parse(readFileSync(join(b.dir, 'collabs', collabId, 'member.json'), 'utf8'));
  assert.equal(memberAgain.manager.instanceId, 'inst-e');
});

test('移交等待期：常规写被拒（负例，offer 后即挂起）；accept 到达后照常完成并解挂', async (t) => {
  /* 判别性用例（源自对抗评审行为探针）：等待窗内的任意常规写会让回执版本错配、旧席位
   * 保守不删而受让方已担任席位——单边孤儿。修复 = offer 后即挂起（等待期禁常规写）。 */
  const a = makeHarness(t, { probeResults: [{ reachable: true, rttMs: 1 }], handoverConfirmTimeoutMs: 500 });
  const collabId = await managerActive(a);
  const b = memberHarness(t);
  await memberActiveAt(b, collabId);
  const pending = a.service.handover({ collabId, target: 'inst-b' });
  const offer = await waitFor(() => a.sent.find((frame) => frame.type === 'handover' && frame.payload.kind === 'offer'), { timeoutMs: 2000 });
  assert.equal(a.service.list().collabs[0].suspended, true, 'offer 发出即挂起（等待期禁常规写）');
  await receive(a.service, collabFrame('topic', collabId, peer('inst-b', '主机乙'), { text: '等待期主题变更' }));
  const ledgerDuring = (await a.service.view({ collabId })).ledger;
  assert.equal(ledgerDuring.topic, '发布联调', '等待期常规写被拒（台账未变）');
  assert.equal(a.service.stats().mutationSuspended >= 1, true);
  const blockedSend = await a.service.send({ collabId, text: '等待期消息', type: 'issue' });
  assert.equal(blockedSend.ok, false);
  await receive(b.service, collabFrame('handover', collabId, peer('inst-a', '主机甲'), offer.payload));
  const accept = await waitFor(() => b.sent.find((frame) => frame.type === 'handover' && frame.payload.kind === 'accept'), { timeoutMs: 2000 });
  await receive(a.service, collabFrame('handover', collabId, peer('inst-b', '主机乙'), accept.payload));
  const result = await pending;
  assert.equal(result.ok, true, String(result.message));
  assert.equal(a.service.list().collabs[0].role, 'member');
  assert.equal(a.service.list().collabs[0].suspended, false, '完成即解挂（转成员清挂起）');
});

test('移交超时后解挂：常规写恢复（不残留挂起）', async (t) => {
  const a = makeHarness(t, { probeResults: [{ reachable: true, rttMs: 1 }], handoverConfirmTimeoutMs: 60 });
  const collabId = await managerActive(a);
  const waited = await a.service.handover({ collabId, target: 'inst-b' });
  assert.equal(waited.ok, false);
  assert.equal(a.service.list().collabs[0].suspended, false, '超时统一解挂');
  const resumed = await a.service.send({ collabId, text: '超时后恢复写', type: 'issue' });
  assert.equal(resumed.ok, true);
});

test('冲突裁定族零匹配：拒绝并计数（freezeUnmatched）', async (t) => {
  const harness = makeHarness(t);
  await managerActive(harness);
  const refused = await receive(harness.service, collabFrame('unfreeze', 'collab-none', peer('inst-z', '主机Z'), {
    name: '不相干项目', members: [{ instanceId: 'inst-z' }, { instanceId: 'inst-w' }],
  }));
  assert.equal(refused.ok, false);
  assert.equal(harness.service.stats().freezeUnmatched >= 1, true);
});

test('移交回执来源校验：非本次目标的 accept / reject 被忽略并计数', async (t) => {
  const a = makeHarness(t, { probeResults: [{ reachable: true, rttMs: 1 }], handoverConfirmTimeoutMs: 500 });
  const collabId = await managerActive(a);
  const pending = a.service.handover({ collabId, target: 'inst-b' });
  const offer = await waitFor(() => a.sent.find((frame) => frame.type === 'handover' && frame.payload.kind === 'offer'), { timeoutMs: 2000 });
  const before = a.service.stats().eventMismatch;
  await receive(a.service, collabFrame('handover', collabId, peer('inst-c', '主机丙'), { kind: 'accept', version: offer.payload.version, digest: offer.payload.digest }));
  assert.equal(a.service.list().collabs[0].role, 'manager', '错误来源不完成移交');
  assert.equal(a.service.stats().eventMismatch, before + 1, '来源不符计数');
  await receive(a.service, collabFrame('handover', collabId, peer('inst-b', '主机乙'), { kind: 'accept', version: offer.payload.version, digest: offer.payload.digest }));
  const result = await pending;
  assert.equal(result.ok, true, String(result.message));
  assert.equal(a.service.list().collabs[0].role, 'member');
});

/* —— 席位交回与挂起期语义（修复轮判别用例）—— */

test('席位交回：A→B 移交后 role 位同步，B 可把席位交回 A', async (t) => {
  /* 判别性用例（源自对抗评审行为探针）：席位变更须同步 members[].role（台账 manager 与 role 位
   * 恒一致）——否则旧站长 role 仍为 manager，交回被移交前置（「需为已建立成员」）误拒。 */
  const a = makeHarness(t, { probeResults: [{ reachable: true, rttMs: 1 }] });
  const collabId = await managerActive(a);
  const b = makeHarness(t, { self: { instanceId: 'inst-b', identityName: '主机乙', port: 17321 }, probeResults: [{ reachable: true, rttMs: 1 }] });
  await memberActiveAt(b, collabId);
  const pending = a.service.handover({ collabId, target: 'inst-b' });
  const offer = await waitFor(() => a.sent.find((frame) => frame.type === 'handover' && frame.payload.kind === 'offer'), { timeoutMs: 2000 });
  await receive(b.service, collabFrame('handover', collabId, peer('inst-a', '主机甲'), offer.payload));
  const accept = await waitFor(() => b.sent.find((frame) => frame.type === 'handover' && frame.payload.kind === 'accept'), { timeoutMs: 2000 });
  await receive(a.service, collabFrame('handover', collabId, peer('inst-b', '主机乙'), accept.payload));
  const first = await pending;
  assert.equal(first.ok, true, String(first.message));
  const ledgerB = (await b.service.view({ collabId })).ledger;
  assert.equal(ledgerB.manager.instanceId, 'inst-b');
  assert.equal(ledgerB.members.find((member) => member.instanceId === 'inst-b').role, 'manager', '新站长 role=manager');
  assert.equal(ledgerB.members.find((member) => member.instanceId === 'inst-self').role, 'member', '原站长 role=member');

  /* B（现站长）把席位交回 A（原站长）：端点由「在册联系」学习，回执以 A 真实实例标识送达。 */
  await receive(b.service, collabFrame('reply', collabId, peer('inst-self', '本机'), { text: '在册联系' }));
  const pendingBack = b.service.handover({ collabId, target: 'inst-self' });
  const offerBack = await waitFor(() => b.sent.find((frame) => frame.type === 'handover' && frame.payload.kind === 'offer'), { timeoutMs: 2000 });
  await receive(a.service, collabFrame('handover', collabId, peer('inst-b', '主机乙'), offerBack.payload));
  const acceptBack = await waitFor(() => a.sent.find((frame) => frame.type === 'handover' && frame.payload.kind === 'accept'), { timeoutMs: 2000 });
  await receive(b.service, collabFrame('handover', collabId, peer('inst-self', '本机'), acceptBack.payload));
  const back = await pendingBack;
  assert.equal(back.ok, true, String(back.message));
  assert.equal(b.service.list().collabs[0].role, 'member');
  assert.equal(a.service.list().collabs[0].role, 'manager', '席位交回原站长');
});

test('挂起期明确拒绝：end / withdraw 不半执行（台账与记录均不动）', async (t) => {
  /* 判别性用例（源自对抗评审行为探针）：收敛等待中的完成 / 撤回会与在途席位变更相互践踏
   * （成员已归档、站长仍活跃的僵尸协作）——入口明确拒绝（与 sendMessage 同一口径）。 */
  const harness = makeHarness(t);
  const collabId = await managerActive(harness);
  await receive(harness.service, collabFrame('takeover-init', collabId, peer('inst-b', '主机乙'), {
    kind: 'announce', manager: { instanceId: 'inst-self', identityName: '本机' }, baseVersion: 3, windowEndsAt: new Date(Date.now() + 60000).toISOString(),
  }));
  assert.equal(harness.service.list().collabs[0].suspended, true);
  const ended = harness.service.end({ collabId });
  assert.equal(ended.ok, false);
  assert.ok(ended.message.includes('暂停'));
  assert.equal(harness.service.stats().ended, 0, '挂起期结束被拒（不半执行）');
  const viewed = (await harness.service.view({ collabId })).ledger;
  assert.equal(viewed.status, 'active', '台账未被改动');

  const proposed = makeHarness(t);
  const created = proposed.service.create({ name: '撤回项目', topic: '主题', targets: [{ instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.2', port: 17321 }] });
  await receive(proposed.service, collabFrame('takeover-init', created.collabId, peer('inst-b', '主机乙'), {
    kind: 'announce', manager: { instanceId: 'inst-self', identityName: '本机' }, baseVersion: 1, windowEndsAt: new Date(Date.now() + 60000).toISOString(),
  }));
  assert.equal(proposed.service.list().collabs[0].suspended, true);
  const withdrawn = proposed.service.withdraw({ collabId: created.collabId });
  assert.equal(withdrawn.ok, false);
  assert.ok(withdrawn.message.includes('暂停'));
  assert.equal(proposed.service.stats().withdrawn, 0, '挂起期撤回被拒（不半执行）');
  const stillProposed = (await proposed.service.view({ collabId: created.collabId })).ledger;
  assert.equal(stillProposed.status, 'proposed');
});

test('挂起期入站回应：拒绝且不虚增计数、不发名单通告（台账不动）', async (t) => {
  /* 判别性用例（期终审查 Minor-4）：挂起期 approve 的台账写被写闸拦下——回应计数与名单通告
   * 不得照常推进（否则计数虚增 + 对未变更名单发空通告）。 */
  const harness = makeHarness(t);
  const collabId = await managerActive(harness);
  await freezeViaBroadcast(harness, collabId, {
    extra: {
      createdAt: new Date(Date.now() + 3600000).toISOString(),
      manager: { instanceId: 'inst-c', identityName: '主机丙' },
      members: [
        { instanceId: 'inst-c', identityName: '主机丙' },
        { instanceId: 'inst-b', identityName: '主机乙' },
        { instanceId: 'inst-d', identityName: '主机丁' },
      ],
    },
  });
  harness.service.decide({ collabId, choice: 'merge' });
  await receive(harness.service, collabFrame('takeover-init', collabId, peer('inst-b', '主机乙'), {
    kind: 'announce', manager: { instanceId: 'inst-self', identityName: '本机' }, baseVersion: 4, windowEndsAt: new Date(Date.now() + 60000).toISOString(),
  }));
  assert.equal(harness.service.list().collabs[0].suspended, true);
  const approvalsBefore = harness.service.stats().approvalsIn;
  harness.sent.length = 0;
  await receive(harness.service, collabFrame('approve', collabId, peer('inst-c', '主机丙'), {}));
  assert.equal(harness.service.stats().approvalsIn, approvalsBefore, '挂起期回应不虚增计数');
  assert.equal(harness.service.stats().mutationSuspended >= 1, true, '写闸拦截有留痕（mutationSuspended）');
  assert.equal(sentOf(harness.sent, 'notice', collabId).some((frame) => frame.payload.event === 'roster'), false, '不发名单通告（名单未变更）');
  const ledger = (await harness.service.view({ collabId })).ledger;
  assert.equal(ledger.members.find((member) => member.instanceId === 'inst-c').state, 'invited', '成员状态未被写入');
});

/* —— 交接端点互盲修复（M7-F1）—— */

/* 三节点交接前置：A 为站长，B / C 均只与 A 直连过（各自的端点表只有 A）。 */
async function handoverTriadReady(a, b, c, collabId) {
  const peerA = peer('inst-a', '主机甲');
  for (const node of [b, c]) {
    const address = node === b ? '127.0.0.2' : '127.0.0.3';
    await memberActiveAt(node, collabId, peerA, 4);
    const approve = node.sent.find((message) => message.type === 'approve');
    await receive(a.service, collabFrame('approve', collabId, peer(node.self.instanceId, node.self.identityName), approve.payload), address);
  }
}

test('交接端点互盲修复：manager-changed 携带新站长端点、offer 携带端点全表（成员即时可达）', async (t) => {
  /* 判别性用例（M7-F1 真机缺陷）：成员只与旧站长直连过（端点表只有旧站长）——交接后若新
   * 站长端点不随通告下发即互盲死结（探测跳过、握手 / 消息发不出）；载荷携带端点 + 接收侧
   * 学习后，成员立即学到新站长端点（互盲解除、出站可达）。 */
  const a = makeHarness(t, { probeResults: [{ reachable: true, rttMs: 1 }] });
  const b = makeHarness(t, { self: { instanceId: 'inst-b', identityName: '主机乙', port: 17321 } });
  const c = makeHarness(t, { self: { instanceId: 'inst-c', identityName: '主机丙', port: 17321 } });
  const peerA = peer('inst-a', '主机甲');
  const collabId = a.service.create({
    name: '交接项目',
    topic: '联调',
    targets: [
      { instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.2', port: 17321 },
      { instanceId: 'inst-c', identityName: '主机丙', address: '127.0.0.3', port: 17321 },
    ],
  }).collabId;
  await handoverTriadReady(a, b, c, collabId);

  const pending = a.service.handover({ collabId, target: 'inst-b' });
  const offer = await waitFor(() => a.sent.find((message) => message.type === 'handover' && message.payload.kind === 'offer'), { timeoutMs: 2000 });
  assert.deepEqual(offer.payload.endpoints['inst-c'], { address: '127.0.0.3', port: 17321 }, '辅修：offer 携带端点全表（旧站长视角）');
  await receive(b.service, collabFrame('handover', collabId, peerA, offer.payload));
  const memberB = JSON.parse(readFileSync(join(b.dir, 'collabs', collabId, 'member.json'), 'utf8'));
  assert.deepEqual(memberB.endpoints['inst-c'], { address: '127.0.0.3', port: 17321 }, '辅修：受让方逐项学习（可直投老成员）');
  const accept = await waitFor(() => b.sent.find((message) => message.type === 'handover' && message.payload.kind === 'accept'), { timeoutMs: 2000 });
  await receive(a.service, collabFrame('handover', collabId, peer('inst-b', '主机乙'), accept.payload), '127.0.0.2');
  assert.equal((await pending).ok, true);

  const changed = a.sent.find((message) => message.type === 'notice' && message.payload.event === 'manager-changed');
  assert.ok(changed, '旧站长广播站长变更');
  assert.deepEqual(changed.payload.endpoint, { address: '127.0.0.2', port: 17321 }, '主修：载荷携带新站长端点');
  await receive(c.service, collabFrame('notice', collabId, peerA, changed.payload));
  const memberC = JSON.parse(readFileSync(join(c.dir, 'collabs', collabId, 'member.json'), 'utf8'));
  assert.equal(memberC.manager.instanceId, 'inst-b');
  assert.deepEqual(memberC.endpoints['inst-b'], { address: '127.0.0.2', port: 17321 }, '成员学到新站长端点（互盲解除）');
  const sent = await c.service.send({ collabId, text: '交接后第一条', type: 'reply' });
  assert.equal(sent.ok, true, '消息直达新站长（不再「端点未知」）');
  assert.equal(sent.to[0], 'inst-b');
  c.service.close();
});

test('端点留痕：治理载荷携带非法端点项（地址 / 端口两分支）→ 忽略并计数、不入表', async (t) => {
  /* M7-F1 审查 Minor-1①：载荷端点的留痕忽略行为直覆盖——站长变更本身照常生效（端点属
   * 辅助面），非法项不污染端点表。 */
  const harness = makeHarness(t);
  const collabId = 'collab-endpoint';
  await memberActiveAt(harness, collabId);
  const rejectedBefore = harness.service.stats().endpointRejected;
  await receive(harness.service, collabFrame('notice', collabId, peer('inst-a', '主机甲'), {
    event: 'manager-changed',
    version: 3,
    manager: { instanceId: 'inst-b', identityName: '主机乙' },
    endpoint: { address: 'not-an-ip', port: 17321 },
  }));
  assert.equal(harness.service.stats().endpointRejected, rejectedBefore + 1, '地址非法 → 忽略并计数');
  let member = JSON.parse(readFileSync(join(harness.dir, 'collabs', collabId, 'member.json'), 'utf8'));
  assert.equal(member.manager.instanceId, 'inst-b', '站长变更本身照常生效（端点属辅助面）');
  assert.equal(member.endpoints['inst-b'], undefined, '非法端点不入表');

  await receive(harness.service, collabFrame('notice', collabId, peer('inst-b', '主机乙'), {
    event: 'manager-changed',
    version: 4,
    manager: { instanceId: 'inst-c', identityName: '主机丙' },
    endpoint: { address: '127.0.0.9', port: 70000 },
  }));
  assert.equal(harness.service.stats().endpointRejected, rejectedBefore + 2, '端口非法 → 忽略并计数');
  member = JSON.parse(readFileSync(join(harness.dir, 'collabs', collabId, 'member.json'), 'utf8'));
  assert.equal(member.manager.instanceId, 'inst-c');
  assert.equal(member.endpoints['inst-c'], undefined, '非法端口不入表');
});

test('载荷学习触发陈旧队列重投：manager-changed 学到新站长端点后原队列条目自动改投', async (t) => {
  /* M7-F1 审查 Minor-1②（真机复验第③步的机制）：指向旧站长的未确认条目在换站长瞬间因新端点
   * 未知而暂存（staleManagerId）；载荷携带端点学得后必须自动重定向补投——否则排队样本永不
   * 投递（互盲死结的投递侧）。判别方式：观测注入的 reassign 改投原语——旧实现（载荷端点不
   * 学习）下 resumeStaleRetarget 无触发，reassign 永不被调用（必红）。 */
  const harness = makeHarness(t, { moved: 2 });
  const collabId = 'collab-retarget';
  await memberActiveAt(harness, collabId);
  const queued = await harness.service.send({ collabId, text: '发往旧站长的排队样本' });
  assert.equal(queued.ok, true, '换站长前条目已入队（指向旧站长）');
  harness.reassigns.length = 0;
  await receive(harness.service, collabFrame('notice', collabId, peer('inst-a', '主机甲'), {
    event: 'manager-changed',
    version: 3,
    manager: { instanceId: 'inst-b', identityName: '主机乙' },
    endpoint: { address: '127.0.0.9', port: 17321 },
  }));
  assert.equal(harness.service.stats().queueStaleKept >= 1, true, '换站长瞬间新端点未知 → 条目先暂存');
  assert.equal(harness.reassigns.length, 1, '载荷学得端点即触发陈旧队列重定向（resumeStaleRetarget）');
  assert.equal(harness.reassigns[0].fromInstanceId, 'inst-a');
  assert.deepEqual(harness.reassigns[0].to, { instanceId: 'inst-b', address: '127.0.0.9', port: 17321 }, '改投目标 = 学得的新站长端点');
  assert.equal(harness.service.stats().queueRetargeted, 2, '改投条目数入账（补投生效面）');
});
