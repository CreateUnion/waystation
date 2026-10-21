import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir, waitFor } from './helpers.js';
import { makeLedger, seedSessionCollab } from './helpers/session-participants.js';
import { createCollabService } from '../src/collab/service.js';
import { ledgerDigest, loadLedger } from '../src/collab/store.js';

/* 治理面（冻结裁定 / 合流递交 / 显式移交 / 站长变更接收 / 挂起期写闸 / 端点学习 / 转达）。
 *
 * 夹具形态（consume-only）：carrier(session-seats) + 新台账（managerTerm/joinSeqNext/
 * manager.sessionId/席位 joinSeq）+ seats/ 全部预置——本文件不经 create/invite/join 的产品路径，
 * 只覆盖治理帧的受理、决策与出站面；创建/邀请/加入的产品路径由 e2e-* 与 join/invite 套件覆盖，
 * 不能据本文件声称创建/邀请/加入可用。协作域帧携 cap=2、from.sessionId（设计 §1.1/§2.1/§5.1）。
 *
 * 已删除用例 → 设计依据 / 替代覆盖：
 * - 活跃协作的新增成员同意门（invited 行）：共享名单只放活跃席位（设计 §0.2 D1、§2.1、§4.1）；
 *   合流新增参与者改发邀请，由「decide merge（保留方）」覆盖。
 * - decide merge（保留方）新增参与者以 invited 入账：同上（D1）；本地保留方的「解冻 + 本地并集 +
 *   广播 executed=true」由「decide merge（本地保留方）」覆盖。
 * - 移交后旧席位台账已清理：§2A.4③ 要求保留本地只读副本；「移交全链」断言 ledger.jsonl 副本
 *   可读且快照副本存在，不固化删除行为。
 * - 移交阻塞等待确认：§2A.4③ 立即返回 offerId、不阻塞；改由「移交等待期」覆盖。
 * - manager-changed 旧载荷形态（无 term/version/offerId/digest）：§2A.1 帧表必填字段。
 * - 载荷学习触发陈旧队列重投：出站队列已改为机器级 outbox（§5.3）；端点学习面仍由
 *   「端点学习」覆盖。
 * - 端点留痕：非法端点（地址/端口）忽略并计数：端点形态由协议层 validateFrame 拒收
 *   （net-protocol 覆盖）；本套件经 hooks 直投刻意绕过协议层，不再断言消费面拒收。
 * - 抢接意图 taken-over 观测量 / takeover-init 挂起：抢接公告与收集窗口已删除（§0.4），
 *   挂起改由显式移交在途产生（§2A.4）。 */

const COLLAB = 'collab-governance';
const NAME = '联调项目';
const MGR = { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲机' };
const MEM = { instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙机' };
const RIVAL = { instanceId: 'inst-c', sessionId: 'sess-c', identityName: '丙机' };
const MGR_ENDPOINT = { address: '127.0.0.1', port: 17321 };
const MEM_ENDPOINT = { address: '127.0.0.2', port: 17321 };
const RIVAL_ENDPOINT = { address: '127.0.0.3', port: 17321 };
const DAY = 24 * 60 * 60 * 1000;

function quietLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function membersOf() {
  return [
    { ...MGR, role: 'manager', joinSeq: 1 },
    { ...MEM, role: 'member', joinSeq: 2 },
    { ...RIVAL, role: 'member', joinSeq: 3 },
  ];
}

function memberRecordOf(endpoints) {
  return {
    collabId: COLLAB,
    name: NAME,
    topic: '发布联调',
    role: 'member',
    state: 'active',
    manager: { instanceId: MGR.instanceId, sessionId: MGR.sessionId, identityName: MGR.identityName },
    endpoints,
    roster: membersOf(),
    mode: 'managed',
    decision: 'approved',
  };
}

function managerHarnessOptionsOf(options) {
  return {
    endpoints: options.endpoints ?? { [MEM.instanceId]: MEM_ENDPOINT, [RIVAL.instanceId]: RIVAL_ENDPOINT },
    config: options.config ?? {},
    probe: options.probe ?? (async () => ({ reachable: true, rttMs: 1 })),
    managerTerm: options.managerTerm ?? 1,
    version: options.version ?? 3,
    window: options.window,
  };
}

/* 站长侧：本机 inst-a，成员 inst-b / inst-c 端点已知。term/version/window 供接管窗口场景。 */
function makeManagerHarness(t, options = {}) {
  const { endpoints, config, probe, managerTerm, version, window } = managerHarnessOptionsOf(options);
  const dir = makeTempDir(t);
  seedSessionCollab(dir, COLLAB, {
    name: NAME,
    status: 'active',
    managerTerm,
    version,
    manager: { ...MGR, term: managerTerm },
    members: membersOf(),
    managerWindow: window,
    seats: [{ sessionId: MGR.sessionId, role: 'manager', joinSeq: 1 }],
    endpoints,
    snapshotFrom: MGR.instanceId,
  });
  const sent = [];
  const notified = [];
  const service = createCollabService({
    dataDir: dir,
    config: { freezeUnresolvedMs: DAY, handoverConfirmTimeoutMs: 500, ...config },
    self: { instanceId: MGR.instanceId, identityName: MGR.identityName, port: 17321 },
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
    handoverConfirmTimeoutMs: 500,
  });
  t.after(() => service.close());
  return { dir, service, sent, notified };
}

/* 成员侧：本机 inst-b，带本地席位与成员记录。 */
function makeMemberHarness(t, { endpoints = { [MGR.instanceId]: MGR_ENDPOINT }, config = {} } = {}) {
  const dir = makeTempDir(t);
  seedSessionCollab(dir, COLLAB, {
    name: NAME,
    status: 'active',
    managerTerm: 1,
    version: 3,
    manager: MGR,
    members: membersOf(),
    seats: [{ sessionId: MEM.sessionId, role: 'member', joinSeq: 2 }],
    endpoints,
    snapshotFrom: MGR.instanceId,
    member: memberRecordOf(endpoints),
  });
  const sent = [];
  const notified = [];
  const service = createCollabService({
    dataDir: dir,
    config: { freezeUnresolvedMs: DAY, ...config },
    self: { instanceId: MEM.instanceId, identityName: MEM.identityName, port: 17321 },
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
    handshakeReplyTimeoutMs: 60000,
  });
  t.after(() => service.close());
  return { dir, service, sent, notified };
}

let seq = 0;

function frameOf(type, from, payload, { collabId = COLLAB, remoteAddress = '127.0.0.1' } = {}) {
  seq++;
  return {
    v: 1,
    cap: 2,
    type,
    msgId: `msg-${type}-${seq}`,
    collabId,
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

function memberRecordOnDisk(dir) {
  return JSON.parse(readFileSync(join(dir, 'collabs', COLLAB, 'member.json'), 'utf8'));
}

function rosterRefs(extra = []) {
  const rows = membersOf().map((seat) => ({ instanceId: seat.instanceId, sessionId: seat.sessionId, identityName: seat.identityName }));
  return [...rows, ...extra];
}

/* 冲突裁定族广播（同名 + 成员交集）：把本机协作冻上。 */
async function freezeViaBroadcast(harness, { from = RIVAL, members = rosterRefs(), extra = {} } = {}) {
  await receive(harness.service, frameOf('freeze', from, {
    name: NAME,
    reason: '同名冲突',
    members,
    ...extra,
  }, { collabId: 'collab-rival' }));
}

function changeOf({ via = 'handover', term, version, manager, prevManager = { instanceId: MGR.instanceId, sessionId: MGR.sessionId }, offerId = 'offer-1', authorizedAt, windowBaseTerm, endpoint = RIVAL_ENDPOINT }) {
  return {
    event: 'manager-changed',
    via,
    term,
    version,
    manager,
    prevManager,
    offerId,
    ...(windowBaseTerm === undefined ? {} : { windowBaseTerm }),
    ...(authorizedAt === undefined ? {} : { authorizedAt }),
    effectiveAt: new Date().toISOString(),
    endpoint,
    digest: 'a'.repeat(64),
  };
}

/* —— 冻结裁定 —— */

test('decide keep：解除冻结回冻结前状态 + 广播 unfreeze；重复裁定被拒（非冻结）', async (t) => {
  const harness = makeManagerHarness(t);
  await freezeViaBroadcast(harness);
  assert.equal(harness.service.list().collabs[0].state, 'frozen');
  harness.sent.length = 0;
  const kept = harness.service.decide({ collabId: COLLAB, choice: 'keep', sessionId: MGR.sessionId });
  assert.equal(kept.ok, true, kept.message);
  assert.equal(harness.service.list().collabs[0].state, 'active', '回冻结前状态');
  const unfreezes = harness.sent.filter((frame) => frame.type === 'unfreeze');
  assert.equal(unfreezes.length >= 1, true);
  assert.equal(unfreezes[0].payload.name, NAME);
  assert.equal(unfreezes[0].to.instanceId, MEM.instanceId);
  assert.equal(harness.service.decide({ collabId: COLLAB, choice: 'keep', sessionId: MGR.sessionId }).ok, false, '已解除即拒绝');
  assert.equal(harness.service.stats().freezeDecisionsOut, 1);
});

test('decide terminate：本机该条终止并归档 + 广播执行帧', async (t) => {
  const harness = makeManagerHarness(t);
  await freezeViaBroadcast(harness);
  harness.sent.length = 0;
  const ended = harness.service.decide({ collabId: COLLAB, choice: 'terminate', sessionId: MGR.sessionId });
  assert.equal(ended.ok, true, ended.message);
  const entry = harness.service.list().collabs[0];
  assert.equal(entry.state, 'terminated');
  assert.equal(entry.archived, true);
  const decisions = harness.sent.filter((frame) => frame.type === 'decision');
  assert.equal(decisions.length >= 1, true, '逐成员机器广播执行帧');
  assert.equal(decisions[0].payload.choice, 'terminate');
  assert.equal(decisions[0].payload.executed, true);
  assert.equal(decisions[0].payload.collabId, COLLAB);
});

test('decide 守卫：管理员席位缺失 / 非冻结 / 非法 choice 逐拒', async (t) => {
  const harness = makeManagerHarness(t);
  assert.equal(harness.service.decide({ collabId: COLLAB, choice: 'keep', sessionId: MGR.sessionId }).ok, false, '未冻结拒绝');
  assert.equal(harness.service.decide({ collabId: COLLAB, choice: 'bogus', sessionId: MGR.sessionId }).ok, false);
  const member = makeMemberHarness(t);
  assert.equal(member.service.decide({ collabId: COLLAB, choice: 'keep', sessionId: MEM.sessionId }).ok, false, '成员席拒绝（治理写按席位授权）');
  await freezeViaBroadcast(member);
  const refused = member.service.decide({ collabId: COLLAB, choice: 'keep', sessionId: MEM.sessionId });
  assert.equal(refused.ok, false, '成员席在冻结中仍不得裁定');
  assert.ok(refused.message.includes('站长'), refused.message);
  const memberTerminate = member.service.decide({ collabId: COLLAB, choice: 'terminate', sessionId: MEM.sessionId });
  assert.equal(memberTerminate.ok, false, '非任期分叉的冻结仍由站长裁定（不得借 terminate 越权）');
  assert.ok(memberTerminate.message.includes('站长'), memberTerminate.message);
});

test('冻结写门：任期冻结不改台账 status 也停写，更高任期证据解除后恢复', async (t) => {
  const harness = makeManagerHarness(t);
  assert.equal(harness.service.isWritable(COLLAB), true);
  assert.equal(harness.service.freezeOnManagerOffline(COLLAB), true);
  assert.equal(harness.service.isWritable(COLLAB), false, '站长侧冻结不改台账 status 也必须拒绝写');
  const entry = harness.service.list().collabs[0];
  assert.equal(entry.freezeReason, 'manager-offline', '条目顶层下发冻结原因');
  assert.equal(entry.sessions.freezeReason, 'manager-offline', '嵌套 sessions.freezeReason 保留兼容');
  const decision = harness.service.decide({ collabId: COLLAB, choice: 'keep', sessionId: MGR.sessionId });
  assert.equal(decision.ok, false);
  assert.match(decision.message, /未冻结/, 'manager-offline 的恢复出口是手动接管，不是同名冲突裁定');
  await receive(harness.service, frameOf('notice', MEM, changeOf({
    via: 'takeover-manual',
    term: 2,
    version: 4,
    manager: MEM,
    authorizedAt: new Date().toISOString(),
  })));
  assert.equal(harness.service.isWritable(COLLAB), true, '解冻后恢复可写');
  assert.equal(harness.service.list().collabs[0].freezeReason, undefined, '解冻后顶层冻结原因消失');
});

test('任期分叉的成员席出口：terminate 可终止本方分支，merge / keep 不发', async (t) => {
  const member = makeMemberHarness(t);
  await receive(member.service, frameOf('notice', RIVAL, changeOf({
    term: 2,
    version: 4,
    manager: RIVAL,
    endpoint: RIVAL_ENDPOINT,
  })));
  assert.equal(member.service.list().collabs[0].sessions.freezeReason, 'manager-fork');
  for (const choice of ['merge', 'keep']) {
    const refused = member.service.decide({ collabId: COLLAB, choice, sessionId: MEM.sessionId });
    assert.equal(refused.ok, false, `${choice} 不适用且成员席无权裁定`);
  }
  const terminated = member.service.decide({ collabId: COLLAB, choice: 'terminate', sessionId: MEM.sessionId });
  assert.equal(terminated.ok, true, terminated.message);
  const entry = member.service.list().collabs[0];
  assert.equal(entry.state, 'terminated');
  assert.equal(entry.archived, true);
  assert.equal(member.sent.length, 0, '本地归档不广播');
});

test('裁定执行帧接收：终止命中本机条；本机更早数据时拒绝被并入', async (t) => {
  const harness = makeManagerHarness(t);
  await freezeViaBroadcast(harness);
  await receive(harness.service, frameOf('decision', RIVAL, {
    choice: 'terminate',
    name: NAME,
    members: rosterRefs(),
    collabId: COLLAB,
    executed: true,
  }, { collabId: 'collab-rival' }));
  assert.equal(harness.service.list().collabs[0].state, 'terminated', '同 collabId 副本终止');
});

test('裁定接收·合并执行帧：winner 命中即解冻；未命中即被并入转终止；本机更早则保持冻结', async (t) => {
  const first = makeManagerHarness(t);
  await freezeViaBroadcast(first);
  await receive(first.service, frameOf('decision', RIVAL, {
    choice: 'merge',
    name: NAME,
    members: rosterRefs(),
    winner: COLLAB,
    executed: true,
  }, { collabId: COLLAB }));
  assert.equal(first.service.list().collabs[0].state, 'active');

  const second = makeManagerHarness(t);
  await freezeViaBroadcast(second);
  await receive(second.service, frameOf('decision', RIVAL, {
    choice: 'merge',
    name: NAME,
    members: rosterRefs(),
    winner: 'collab-other',
    executed: true,
  }, { collabId: COLLAB }));
  assert.equal(second.service.list().collabs[0].state, 'terminated', '被并入条转终止');

  const third = makeManagerHarness(t);
  await freezeViaBroadcast(third);
  const earlier = await third.service.view({ collabId: COLLAB });
  await receive(third.service, frameOf('decision', RIVAL, {
    choice: 'merge',
    name: NAME,
    members: rosterRefs(),
    winner: 'collab-other',
    executed: true,
    createdAt: new Date(Date.parse(earlier.ledger.createdAt) + 60000).toISOString(),
  }, { collabId: COLLAB }));
  assert.equal(third.service.list().collabs[0].state, 'frozen', '执行方更晚 → 拒绝被并入（保持冻结由人谈）');
  assert.equal(third.service.stats().freezeDecisionConflicts >= 1, true);
});

test('裁定意向帧：不自动执行，只记录并提示本机人；已处置本地状态不被相抵裁定回退', async (t) => {
  const harness = makeManagerHarness(t);
  await freezeViaBroadcast(harness);
  harness.notified.length = 0;
  await receive(harness.service, frameOf('decision', MEM, {
    choice: 'merge',
    name: NAME,
    members: rosterRefs(),
    winner: 'collab-rival',
    executed: false,
    createdAt: new Date().toISOString(),
  }, { collabId: COLLAB }));
  assert.equal(harness.service.list().collabs[0].state, 'frozen', '意向不改本地冻结态');
  assert.equal(harness.notified.some((frame) => frame.payload.text.includes('对端选择了')), true);
  assert.equal(harness.service.stats().freezeIntentsIn >= 1, true);

  harness.service.decide({ collabId: COLLAB, choice: 'keep', sessionId: MGR.sessionId });
  const conflicts = harness.service.stats().freezeDecisionConflicts;
  await receive(harness.service, frameOf('decision', RIVAL, {
    choice: 'terminate',
    name: NAME,
    members: rosterRefs(),
    collabId: 'collab-rival',
    executed: true,
  }, { collabId: COLLAB }));
  assert.equal(harness.service.stats().freezeDecisionConflicts, conflicts + 1, '相抵裁定只计数不回退');
  assert.equal(harness.service.list().collabs[0].state, 'active');
});

test('unfreeze 接收：匹配即回冻结前状态；非冻结协同幂等忽略', async (t) => {
  const harness = makeManagerHarness(t);
  await freezeViaBroadcast(harness);
  await receive(harness.service, frameOf('unfreeze', RIVAL, { name: NAME, members: rosterRefs() }, { collabId: 'collab-rival' }));
  assert.equal(harness.service.list().collabs[0].state, 'active');
  assert.equal(harness.service.stats().unfreezesIn >= 1, true);
  const again = await receive(harness.service, frameOf('unfreeze', RIVAL, { name: NAME, members: rosterRefs() }, { collabId: 'collab-rival' }));
  assert.equal(again.ok, true, '重复解冻幂等放行');
  assert.equal(harness.service.list().collabs[0].state, 'active');
});

test('decide merge（非保留方）：改发意向帧，不本地执行', async (t) => {
  const harness = makeManagerHarness(t);
  await freezeViaBroadcast(harness, {
    extra: { createdAt: '2026-01-01T00:00:00.000Z', manager: { instanceId: RIVAL.instanceId, identityName: RIVAL.identityName } },
  });
  harness.sent.length = 0;
  const merged = harness.service.decide({ collabId: COLLAB, choice: 'merge', sessionId: MGR.sessionId });
  assert.equal(merged.ok, true, merged.message);
  assert.ok(merged.message.includes('意向'));
  assert.equal(harness.service.list().collabs[0].state, 'frozen', '未本地执行');
  const intents = harness.sent.filter((frame) => frame.type === 'decision');
  assert.equal(intents.length >= 1, true, '意向帧逐成员机器广播');
  assert.equal(intents[0].payload.executed, false);
});

test('decide merge（本地保留方）：解冻并本地执行，广播 executed=true 与 winner（名单只含活跃席位）', async (t) => {
  const harness = makeManagerHarness(t);
  await freezeViaBroadcast(harness, {
    extra: { createdAt: '2026-10-22T00:00:00.000Z', manager: { instanceId: RIVAL.instanceId, identityName: RIVAL.identityName } },
  });
  harness.sent.length = 0;
  const merged = harness.service.decide({ collabId: COLLAB, choice: 'merge', sessionId: MGR.sessionId });
  assert.equal(merged.ok, true, merged.message);
  assert.ok(merged.message.includes('合并已执行'), merged.message);
  assert.equal(harness.service.list().collabs[0].state, 'active', '保留方本地解冻');
  const decisions = harness.sent.filter((frame) => frame.type === 'decision');
  assert.equal(decisions.length >= 1, true, '执行帧逐成员机器广播');
  assert.equal(decisions[0].payload.executed, true, '保留方执行而非意向');
  assert.equal(decisions[0].payload.winner, COLLAB);
  const ledger = (await harness.service.view({ collabId: COLLAB })).ledger;
  assert.equal(ledger.members.every((entry) => entry.state === 'member'), true, '共享名单只含活跃席位');
});

test('decide merge（保留方）：新增参与者只发邀请，共享名单不写非 member 行（D1）', async (t) => {
  const outsider = { instanceId: 'inst-d', sessionId: 'sess-d', identityName: '丁机' };
  const harness = makeManagerHarness(t, {
    endpoints: { [MEM.instanceId]: MEM_ENDPOINT, [RIVAL.instanceId]: RIVAL_ENDPOINT, [outsider.instanceId]: { address: '127.0.0.4', port: 17321 } },
  });
  await freezeViaBroadcast(harness, {
    members: rosterRefs([outsider]),
    extra: { createdAt: '2099-01-01T00:00:00.000Z' },
  });
  harness.sent.length = 0;
  const merged = harness.service.decide({ collabId: COLLAB, choice: 'merge', sessionId: MGR.sessionId });
  assert.equal(merged.ok, true, merged.message);
  const ledger = (await harness.service.view({ collabId: COLLAB })).ledger;
  assert.equal(ledger.members.every((entry) => entry.state === 'member'), true, '共享名单只含活跃席位');
  assert.equal(ledger.members.some((entry) => entry.instanceId === outsider.instanceId), false, '受邀者同意前不入名单');
  const invites = harness.sent.filter((frame) => frame.type === 'invite');
  assert.equal(invites.length, 1, '新增参与者走邀请');
  assert.equal(invites[0].to.instanceId, outsider.instanceId);
  assert.deepEqual(invites[0].payload.targets, [{ instanceId: outsider.instanceId, targetSessionId: outsider.sessionId }], '目标机器按 targets 准入');
  assert.equal(typeof invites[0].fromSessionId, 'string', '邀请由站长席位签发');
  const decisions = harness.sent.filter((frame) => frame.type === 'decision');
  assert.equal(decisions.length >= 1, true);
  assert.equal(decisions[0].payload.members.every((entry) => typeof entry.sessionId === 'string'), true, '裁定帧名单携席位标识');
  const loaded = loadLedger(harness.dir, COLLAB);
  assert.equal(loaded.corrupt, false, '落盘台账未产生非法行');
  assert.equal(loaded.ledger.members.every((entry) => entry.state === 'member'), true);
});

/* —— 合流递交 —— */

function mergeRequestFrame(version = 5, { baseVersion = 3, tamper = false } = {}) {
  const ledger = makeLedger({
    collabId: COLLAB,
    name: NAME,
    status: 'active',
    managerTerm: 1,
    version,
    manager: MGR,
    members: membersOf(),
  });
  ledger.board = [{ entryId: 'entry-1', ts: new Date().toISOString(), from: { instanceId: MEM.instanceId, identityName: MEM.identityName }, kind: 'progress', text: '分区期间的进度' }];
  const digest = tamper ? 'a'.repeat(64) : ledgerDigest(ledger);
  return frameOf('notice', MEM, { event: 'merge-request', baseVersion, version, digest, ledger });
}

test('合流递交接收与裁定：accept 采纳看板增量（重编版本）+ 回执；reject 丢弃；非法递交拒绝', async (t) => {
  const harness = makeManagerHarness(t);
  harness.notified.length = 0;
  await receive(harness.service, mergeRequestFrame());
  assert.equal(harness.service.stats().mergeRequestsIn >= 1, true);
  assert.equal(harness.notified.some((frame) => frame.payload.text.includes('合流递交')), true);
  const before = harness.service.list().collabs[0].version;
  harness.sent.length = 0;
  const accepted = harness.service.decideMerge({ collabId: COLLAB, mergeOffer: 'accept', sessionId: MGR.sessionId });
  assert.equal(accepted.ok, true, accepted.message);
  assert.equal(accepted.adopted, 1);
  const ledger = (await harness.service.view({ collabId: COLLAB })).ledger;
  assert.equal(ledger.board.length, 1);
  assert.equal(ledger.version, before + 1, '经正常变更路径重编版本');
  const outcomes = harness.sent.filter((frame) => frame.type === 'notice' && frame.payload?.event === 'merge-outcome');
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].payload.adopted, true);
  assert.equal(outcomes[0].to.instanceId, MEM.instanceId);
  assert.equal(harness.service.stats().mergeAdopted, 1);

  const second = makeManagerHarness(t);
  await receive(second.service, mergeRequestFrame());
  const rejected = second.service.decideMerge({ collabId: COLLAB, mergeOffer: 'reject', sessionId: MGR.sessionId });
  assert.equal(rejected.ok, true);
  assert.equal((await second.service.view({ collabId: COLLAB })).ledger.board.length, 0, '丢弃零变更');
  assert.equal(second.service.stats().mergeDiscarded, 1);

  const third = makeManagerHarness(t);
  await receive(third.service, mergeRequestFrame(5, { tamper: true }));
  await receive(third.service, mergeRequestFrame(5, { baseVersion: 9 }));
  assert.equal(third.service.stats().mergeCorrupt, 2, '摘要不符 / 无超出部分均拒绝');
  assert.equal(third.service.decideMerge({ collabId: COLLAB, mergeOffer: 'accept', sessionId: MGR.sessionId }).ok, false, '无待裁定递交');
});

test('合流裁定结果回执：留痕计数 + 提示', async (t) => {
  const harness = makeManagerHarness(t);
  harness.notified.length = 0;
  await receive(harness.service, frameOf('notice', MEM, { event: 'merge-outcome', adopted: false }));
  assert.equal(harness.service.stats().mergeOutcomesIn >= 1, true);
  assert.equal(harness.notified.some((frame) => frame.payload.text.includes('丢弃')), true);
});

/* —— 48 小时无裁定 —— */

test('冻结超时提示：按时限提示一次（含单方处置指引），解除冻结后复位', async (t) => {
  const harness = makeManagerHarness(t, { config: { freezeUnresolvedMs: 40 } });
  await freezeViaBroadcast(harness);
  harness.notified.length = 0;
  harness.service.start();
  await waitFor(() => (harness.service.list().collabs[0].frozenUnresolved === true ? true : null), { timeoutMs: 3000 });
  const hits = harness.notified.filter((frame) => frame.payload.text.includes('ws_decide'));
  assert.equal(hits.length, 1, '单次提示');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(harness.notified.filter((frame) => frame.payload.text.includes('ws_decide')).length, 1, '再 tick 不重复提示');
  harness.service.decide({ collabId: COLLAB, choice: 'keep', sessionId: MGR.sessionId });
  assert.equal(harness.service.list().collabs[0].frozenUnresolved, false);
});

/* —— 显式移交（设计 §2A.4） —— */

async function startHandover(a, { target = MEM, targetSessionId = MEM.sessionId } = {}) {
  const pending = await a.service.handover({
    collabId: COLLAB,
    target: target.instanceId,
    targetSessionId,
    sessionId: MGR.sessionId,
  });
  const offer = a.sent.filter((entry) => entry.type === 'handover' && entry.payload.kind === 'offer').at(-1);
  return { pending, offer };
}

async function acceptOnTarget(b, offerPayload) {
  await receive(b.service, frameOf('handover', MGR, offerPayload));
  const challenge = b.service.confirmHandover({ collabId: COLLAB, sessionId: MEM.sessionId, offerId: offerPayload.offerId });
  assert.equal(challenge.needsUserConfirmation, true, challenge.message);
  const accepted = b.service.confirmHandover({ collabId: COLLAB, sessionId: MEM.sessionId, offerId: offerPayload.offerId, token: challenge.token });
  assert.equal(accepted.accepted, true, accepted.message);
  return b.sent.filter((entry) => entry.type === 'handover' && entry.payload.kind === 'accept').at(-1);
}

async function finishOnSource(a, acceptPayload) {
  await receive(a.service, frameOf('handover', MEM, acceptPayload.payload));
  return a.sent.filter((entry) => entry.type === 'notice' && entry.payload.event === 'manager-changed').at(-1);
}

test('移交全链：目标确认后旧站长降级（保留只读台账与快照副本）、受让方收到变更后担任站长', { timeout: 10000 }, async (t) => {
  const a = makeManagerHarness(t);
  const b = makeMemberHarness(t);
  const { pending, offer } = await startHandover(a);
  assert.equal(pending.ok, true, pending.message);
  assert.ok(pending.offerId);
  for (const field of ['offerId', 'baseTerm', 'version', 'digest', 'ledger', 'endpoints', 'expiresAt']) {
    assert.ok(offer.payload[field] !== undefined, `offer 必填字段 ${field}`);
  }
  assert.equal(offer.fromSessionId, MGR.sessionId, '旧站长席位签发');
  assert.equal(offer.payload.baseTerm, 1);
  assert.deepEqual(offer.payload.endpoints[RIVAL.instanceId], RIVAL_ENDPOINT, 'offer 携带端点全表');

  const accept = await acceptOnTarget(b, offer.payload);
  assert.equal(b.service.list().collabs[0].role, 'member', '目标确认不自行提升');
  const changed = await finishOnSource(a, accept);
  assert.ok(changed, '旧站长签发 manager-changed');
  assert.equal(changed.payload.via, 'handover');
  assert.equal(changed.payload.term, 2);
  assert.equal(changed.payload.version, 4);
  assert.equal(changed.payload.manager.sessionId, MEM.sessionId);
  assert.equal(changed.payload.windowEndsAt, undefined, '显式移交不开窗');
  assert.equal(a.service.list().collabs[0].role, 'member', '旧站长降级');
  assert.equal(existsSync(join(a.dir, 'collabs', COLLAB, 'ledger.jsonl')), true, '保留本地台账只读副本（§2A.4③）');
  const keptLedger = loadLedger(a.dir, COLLAB);
  assert.equal(keptLedger.corrupt, false, '只读台账副本仍可读');
  assert.equal(existsSync(join(a.dir, 'collabs', COLLAB, 'snapshot.json')), true, '保留只读快照副本');

  await receive(b.service, frameOf('notice', MGR, changed.payload));
  assert.equal(b.service.list().collabs[0].role, 'manager', '受让方采纳后担任站长');
  const ledgerB = (await b.service.view({ collabId: COLLAB })).ledger;
  assert.equal(ledgerB.manager.sessionId, MEM.sessionId);
  assert.equal(ledgerB.managerTerm, 2);
  assert.equal(ledgerB.members.find((entry) => entry.sessionId === MGR.sessionId).role, 'member', '旧站长席位降为成员');
  assert.equal(a.service.stats().handoverCompleted, 1);
  assert.equal(b.service.stats().handoverOffersStored, 1);
});

test('移交守卫：目标离线拒绝；对方拒绝回执；accept 不符作废', async (t) => {
  const offline = makeManagerHarness(t, { probe: async () => ({ reachable: false, reason: '超时' }) });
  const rejected = await offline.service.handover({ collabId: COLLAB, target: MEM.instanceId, targetSessionId: MEM.sessionId, sessionId: MGR.sessionId });
  assert.equal(rejected.ok, false);
  assert.ok(rejected.message.includes('离线'), rejected.message);
  assert.equal(offline.service.list().collabs[0].suspended, false, '未发出提议不挂起');

  const refused = makeManagerHarness(t);
  const pendingReject = await startHandover(refused);
  assert.equal(pendingReject.pending.ok, true);
  await receive(refused.service, frameOf('handover', MEM, { kind: 'reject', offerId: pendingReject.offer.payload.offerId, reason: '人手紧张' }));
  assert.equal(refused.service.list().collabs[0].suspended, false, '拒绝即解挂');
  assert.equal((await refused.service.send({ collabId: COLLAB, text: '拒绝后恢复写', type: 'issue', sessionId: MGR.sessionId })).ok, true);

  const mismatch = makeManagerHarness(t);
  const pendingMismatch = await startHandover(mismatch);
  await receive(mismatch.service, frameOf('handover', MEM, {
    kind: 'accept',
    offerId: pendingMismatch.offer.payload.offerId,
    baseTerm: 1,
    version: 2,
    digest: 'b'.repeat(64),
  }));
  const rejects = mismatch.sent.filter((entry) => entry.type === 'handover' && entry.payload.kind === 'reject');
  assert.equal(rejects.at(-1)?.payload.reason, 'version-changed', '回执不符按 version-changed 作废');
  assert.equal(mismatch.service.list().collabs[0].role, 'manager', '未完成移交');
});

test('移交受理（目标侧）：来源非现任站长拒收；冻结中由门控拒绝', async (t) => {
  const b = makeMemberHarness(t);
  const rogue = makeLedger({ collabId: COLLAB, name: NAME, status: 'active', managerTerm: 1, version: 3, manager: MGR, members: membersOf() });
  await receive(b.service, frameOf('handover', RIVAL, {
    kind: 'offer',
    offerId: 'offer-rogue',
    baseTerm: 1,
    version: 3,
    digest: ledgerDigest(rogue),
    ledger: rogue,
    endpoints: {},
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  }));
  assert.equal(b.service.stats().handoverOffersStored ?? 0, 0, '冒充来源不记录');
  assert.equal(b.service.list().collabs[0].role, 'member');

  const frozenB = makeMemberHarness(t);
  await freezeViaBroadcast(frozenB);
  assert.equal(frozenB.service.list().collabs[0].state, 'frozen');
  const gated = await frozenB.service.hooks.admit(frameOf('handover', MGR, {
    kind: 'offer',
    offerId: 'offer-frozen',
    baseTerm: 1,
    version: 3,
    digest: ledgerDigest(rogue),
    ledger: rogue,
    endpoints: {},
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  }), { remoteAddress: '127.0.0.1' });
  assert.equal(gated.ok, false, '冻结白名单不含 handover：门控拒绝');
  assert.equal(frozenB.service.list().collabs[0].state, 'frozen');
});

test('A1 站长变更接收：来源为现任站长 → 更新引用并记席位时钟；来源不符 → 冻结分叉', async (t) => {
  const b = makeMemberHarness(t);
  await receive(b.service, frameOf('notice', MGR, changeOf({
    term: 2,
    version: 4,
    manager: { instanceId: RIVAL.instanceId, sessionId: RIVAL.sessionId, identityName: RIVAL.identityName },
  })));
  assert.equal(memberRecordOnDisk(b.dir).manager.instanceId, RIVAL.instanceId);
  assert.equal(memberRecordOnDisk(b.dir).managerSinceVersion, 4, '席位时钟记入受理版本');
  assert.equal(b.service.list().collabs[0].state, 'active');

  const rogue = makeMemberHarness(t);
  await receive(rogue.service, frameOf('notice', RIVAL, changeOf({
    term: 2,
    version: 4,
    manager: { instanceId: RIVAL.instanceId, sessionId: RIVAL.sessionId, identityName: RIVAL.identityName },
  })));
  assert.equal(rogue.service.list().collabs[0].state, 'frozen', '来源非现任站长 → 冻结分叉');
  assert.equal(rogue.service.list().collabs[0].sessions.freezeReason, 'manager-fork', '冻结原因可读（嵌套兼容）');
  assert.equal(rogue.service.list().collabs[0].freezeReason, 'manager-fork', '条目顶层下发冻结原因');
  assert.equal(memberRecordOnDisk(rogue.dir).manager.instanceId, MGR.instanceId, '不采纳');
  const blocked = await rogue.service.send({ collabId: COLLAB, text: '分叉期消息', type: 'issue', sessionId: MEM.sessionId });
  assert.equal(blocked.ok, false, '冻结即停写');
});

test('移交等待期：常规写被拒（offer 后即挂起）；accept 到达后照常完成并解挂', async (t) => {
  const a = makeManagerHarness(t);
  const b = makeMemberHarness(t);
  const { pending, offer } = await startHandover(a);
  assert.equal(a.service.list().collabs[0].suspended, true, 'offer 发出即挂起');
  await receive(a.service, frameOf('topic', MEM, { text: '等待期主题变更' }));
  assert.equal((await a.service.view({ collabId: COLLAB })).ledger.topic, '联调项目 主题', '等待期常规写被拒（台账未变）');
  assert.equal(a.service.stats().mutationSuspended >= 1, true);
  assert.equal((await a.service.send({ collabId: COLLAB, text: '等待期消息', type: 'issue', sessionId: MGR.sessionId })).ok, false);
  const accept = await acceptOnTarget(b, offer.payload);
  await finishOnSource(a, accept);
  assert.equal((await pending).ok, true);
  assert.equal(a.service.list().collabs[0].role, 'member');
  assert.equal(a.service.list().collabs[0].suspended, false, '完成即解挂');
});

test('移交超时后解挂：常规写恢复（不残留挂起）', async (t) => {
  const a = makeManagerHarness(t, { config: { handoverConfirmTimeoutMs: 30 } });
  const { pending } = await startHandover(a);
  assert.equal(pending.ok, true);
  assert.equal(a.service.list().collabs[0].suspended, true);
  await waitFor(() => (a.service.list().collabs[0].suspended === false ? true : null), { timeoutMs: 3000 });
  assert.equal((await a.service.send({ collabId: COLLAB, text: '超时后恢复写', type: 'issue', sessionId: MGR.sessionId })).ok, true);
});

test('移交回执来源校验：非本次目标的 accept 被忽略并计数', async (t) => {
  const a = makeManagerHarness(t);
  const { offer } = await startHandover(a);
  const before = a.service.stats().eventMismatch;
  await receive(a.service, frameOf('handover', RIVAL, {
    kind: 'accept',
    offerId: offer.payload.offerId,
    baseTerm: 1,
    version: 3,
    digest: offer.payload.digest,
  }));
  assert.equal(a.service.list().collabs[0].role, 'manager', '错误来源不完成移交');
  assert.equal(a.service.stats().eventMismatch, before + 1, '来源不符计数');
});

test('席位交回：A→B 移交后 B 可把席位交回 A（降级方保留只读副本，仍可受让）', async (t) => {
  const a = makeManagerHarness(t);
  const b = makeMemberHarness(t, { endpoints: { [MGR.instanceId]: MGR_ENDPOINT, [MEM.instanceId]: MEM_ENDPOINT } });
  const { offer } = await startHandover(a);
  const accept = await acceptOnTarget(b, offer.payload);
  const changed = await finishOnSource(a, accept);
  await receive(b.service, frameOf('notice', MGR, changed.payload));
  assert.equal(b.service.list().collabs[0].role, 'manager');
  assert.equal(memberRecordOnDisk(a.dir).role, 'member');

  const back = await b.service.handover({
    collabId: COLLAB,
    target: MGR.instanceId,
    targetSessionId: MGR.sessionId,
    sessionId: MEM.sessionId,
  });
  assert.equal(back.ok, true, back.message);
  const offerBack = b.sent.filter((entry) => entry.type === 'handover' && entry.payload.kind === 'offer').at(-1);
  await receive(a.service, frameOf('handover', MEM, offerBack.payload));
  const challenge = a.service.confirmHandover({ collabId: COLLAB, sessionId: MGR.sessionId, offerId: offerBack.payload.offerId });
  assert.equal(challenge.needsUserConfirmation, true);
  const acceptedBack = a.service.confirmHandover({ collabId: COLLAB, sessionId: MGR.sessionId, offerId: offerBack.payload.offerId, token: challenge.token });
  assert.equal(acceptedBack.accepted, true, acceptedBack.message);
  const acceptBack = a.sent.filter((entry) => entry.type === 'handover' && entry.payload.kind === 'accept').at(-1);
  await receive(b.service, frameOf('handover', MGR, acceptBack.payload));
  const changedBack = b.sent.filter((entry) => entry.type === 'notice' && entry.payload.event === 'manager-changed').at(-1);
  assert.ok(changedBack, 'B 签发交回变更');
  assert.equal(changedBack.payload.manager.sessionId, MGR.sessionId);
  assert.equal(b.service.list().collabs[0].role, 'member');
});

test('挂起期明确拒绝：end / withdraw 不半执行（台账与记录均不动）', async (t) => {
  const harness = makeManagerHarness(t);
  await startHandover(harness);
  assert.equal(harness.service.list().collabs[0].suspended, true);
  const ended = harness.service.end({ collabId: COLLAB, sessionId: MGR.sessionId });
  assert.equal(ended.ok, false);
  assert.ok(ended.message.includes('暂停'), ended.message);
  assert.equal(harness.service.stats().ended, 0, '挂起期结束被拒（不半执行）');
  const viewed = (await harness.service.view({ collabId: COLLAB })).ledger;
  assert.equal(viewed.status, 'active', '台账未被改动');
  const withdrawn = harness.service.withdraw({ collabId: COLLAB, sessionId: MGR.sessionId });
  assert.equal(withdrawn.ok, false);
  assert.ok(withdrawn.message.includes('暂停'), withdrawn.message);
  assert.equal((await harness.service.view({ collabId: COLLAB })).ledger.status, 'active');
});

test('挂起期入站回应：拒绝且不虚增计数、不发名单通告（台账不动）', async (t) => {
  const harness = makeManagerHarness(t);
  await startHandover(harness);
  const approvalsBefore = harness.service.stats().approvalsIn;
  harness.sent.length = 0;
  await receive(harness.service, frameOf('approve', MEM, { inviteId: 'inv-late' }));
  assert.equal(harness.service.stats().approvalsIn, approvalsBefore, '挂起期回应不虚增计数');
  assert.equal(harness.sent.some((frame) => frame.payload?.event === 'roster'), false, '不发名单通告');
});

test('冲突裁定族零匹配：拒绝并计数（freezeUnmatched）', async (t) => {
  const harness = makeManagerHarness(t);
  const refused = await receive(harness.service, frameOf('unfreeze', { instanceId: 'inst-z', sessionId: 'sess-z', identityName: '主机Z' }, {
    name: '不相干项目',
    members: [{ instanceId: 'inst-z', sessionId: 'sess-z', identityName: '主机Z' }, { instanceId: 'inst-w', sessionId: 'sess-w', identityName: '主机W' }],
  }, { collabId: 'collab-none' }));
  assert.equal(refused.ok, false);
  assert.equal(harness.service.stats().freezeUnmatched >= 1, true);
});

/* —— 端点学习与转达（设计 §2A.8④/§5.1：旧站长向其余成员转发变更，from 保持原发席位） —— */

test('端点学习：manager-changed 携新站长端点即学得', async (t) => {
  const harness = makeMemberHarness(t);
  await receive(harness.service, frameOf('notice', MGR, changeOf({
    term: 2,
    version: 4,
    manager: { instanceId: RIVAL.instanceId, sessionId: RIVAL.sessionId, identityName: RIVAL.identityName },
    endpoint: { address: '127.0.0.9', port: 17321 },
  })));
  assert.deepEqual(memberRecordOnDisk(harness.dir).endpoints[RIVAL.instanceId], { address: '127.0.0.9', port: 17321 }, '成员学到新站长端点');
});

test('旧站长转达站长变更：向其余成员转发且 from 保持原发席位', async (t) => {
  /* 场景：站主任期 2 的窗口内被成员 RIVAL 接管（A3）。旧站长接到变更后降级，并须把变更
   * 转发给其余成员（§2A.8④）；转达帧的 from 仍是签发者 RIVAL——改写为转达者会让接收方
   * 把旧站长当成新站长。 */
  const harness = makeManagerHarness(t, {
    managerTerm: 2,
    version: 3,
    window: { windowBaseTerm: 2, windowEndsAt: new Date(Date.now() + 60000).toISOString() },
  });
  harness.sent.length = 0;
  await receive(harness.service, frameOf('notice', RIVAL, changeOf({
    via: 'takeover',
    term: 3,
    version: 4,
    manager: { instanceId: RIVAL.instanceId, sessionId: RIVAL.sessionId, identityName: RIVAL.identityName },
    windowBaseTerm: 2,
    authorizedAt: new Date().toISOString(),
    endpoint: RIVAL_ENDPOINT,
  })));
  assert.equal(harness.service.list().collabs[0].role, 'member', '旧站长按更高任期降级');
  const relayed = harness.sent.filter((entry) => entry.type === 'notice' && entry.payload?.event === 'manager-changed');
  assert.equal(relayed.length, 1, '向其余成员转达变更（不得静默丢弃）');
  assert.equal(relayed[0].to.instanceId, MEM.instanceId, '转达给其他成员机器');
  assert.equal(relayed[0].from.instanceId, RIVAL.instanceId, 'from 保持原发实例');
  assert.equal(relayed[0].from.sessionId, RIVAL.sessionId, 'from 保持原发席位');
});
