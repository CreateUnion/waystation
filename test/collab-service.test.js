import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { COLLABS_DIR_NAME, collabDir, collabFilePath } from '../src/paths.js';
import { makeTempDir } from './helpers.js';
import { createCollabService } from '../src/collab/service.js';
import { LEDGER_FILE_NAME, ledgerDigest, loadLedger } from '../src/collab/store.js';

const DAY = 24 * 60 * 60 * 1000;

function quietLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

/* 服务单测脚手架：真临时目录 + 假发送（捕获出队消息）+ 假清单；hooks 直调模拟接收管线
 * （admit 通过才 consume——与真实管线同序；落盘/ack 属接收管线自身用例，不在此重复）。 */
function makeService(t, overrides = {}) {
  const dir = makeTempDir(t);
  const sent = [];
  const remembered = [];
  const self = { instanceId: 'inst-self', identityName: '本机', port: 17321 };
  const config = { inviteTtlMs: DAY, ...(overrides.config ?? {}) };
  const knownHosts = { remember: (entry) => remembered.push(entry) };
  const service = createCollabService({
    dataDir: dir,
    config,
    self,
    send: (message) => {
      sent.push(message);
      return { ok: true, msgId: `q-${sent.length}` };
    },
    knownHosts,
    log: quietLog(),
    ledgerFetchTimeoutMs: overrides.ledgerFetchTimeoutMs ?? 60,
    inviteMinIntervalMs: overrides.inviteMinIntervalMs ?? 0,
  });
  return { service, sent, remembered, dir, self, config };
}

let seq = 0;

function peer(instanceId, identityName, port = 17321) {
  return { instanceId, identityName, port };
}

function inviteFrame({ collabId = null, manager = peer('inst-a', '主机甲'), members, name = '联调项目', topic = '发布联调', msgId = null } = {}) {
  seq++;
  const roster = members ?? [manager, peer('inst-self', '本机', 17321)];
  return {
    v: 1,
    type: 'invite',
    msgId: msgId ?? `msg-inv-${seq}`,
    from: { instanceId: manager.instanceId, identityName: manager.identityName, port: manager.port },
    collabId: collabId ?? `collab-${seq}`,
    ts: new Date().toISOString(),
    payload: { name, topic, members: roster.map((entry) => ({ instanceId: entry.instanceId, identityName: entry.identityName })) },
  };
}

function collabFrame(type, collabId, from, payload) {
  seq++;
  return { v: 1, type, msgId: `msg-${type}-${seq}`, from: { instanceId: from.instanceId, identityName: from.identityName, port: from.port }, collabId, ts: new Date().toISOString(), payload };
}

async function receive(service, frame, remoteAddress = '127.0.0.1') {
  const admitted = await service.hooks.admit(frame, { remoteAddress });
  if (admitted?.ok === true) {
    await service.hooks.consume(frame, { remoteAddress });
  }
  return admitted;
}

function sentOf(sent, type, collabId = null) {
  return sent.filter((entry) => entry.type === type && (collabId === null || entry.collabId === collabId));
}

/* 快照测试用最小合法台账与配套摘要（接收侧会重算 digest 比对——构造值必须真实自洽）。 */
function ledgerStub(collabId, version) {
  const now = new Date().toISOString();
  return {
    version,
    collabId,
    name: '联调项目',
    topic: '发布联调',
    status: 'active',
    manager: { instanceId: 'inst-a', identityName: '主机甲' },
    members: [{ instanceId: 'inst-a', identityName: '主机甲', role: 'manager', state: 'member', joinedAt: now }],
    board: [],
    createdAt: now,
    updatedAt: now,
  };
}

function snapshotFrame(collabId, from, version) {
  const ledger = ledgerStub(collabId, version);
  return collabFrame('snapshot', collabId, from, { kind: 'data', version, digest: ledgerDigest(ledger), ledger });
}

/* 磁盘夹具：写一条成员侧同名协作（用于构造「建立判定点前才出现同名交集」的竞态态）。 */
function writeRivalMember(dir, name = '联调项目') {
  const rivalDir = collabDir(dir, 'collab-rival');
  mkdirSync(rivalDir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(join(rivalDir, 'member.json'), JSON.stringify({
    collabId: 'collab-rival',
    role: 'member',
    state: 'proposed',
    name,
    manager: { instanceId: 'inst-d', identityName: '主机丁' },
    roster: [{ instanceId: 'inst-d', identityName: '主机丁' }, { instanceId: 'inst-self', identityName: '本机' }],
    endpoints: {},
    invitedAt: now,
    expiresAt: new Date(Date.parse(now) + DAY).toISOString(),
    decision: null,
  }));
}

/* 以既有工作目录重建服务（重载恢复与竞态构造共用；发送仍汇入原 sent 数组便于断言）。 */
function reloadService(made) {
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
  });
}

/* —— 注册表与创建 —— */

test('空目录起步：list 空、count 0、stats 计数齐备', (t) => {
  const { service } = makeService(t);
  assert.deepEqual(service.list(), { collabs: [] });
  assert.equal(service.count(), 0);
  const stats = service.stats();
  assert.equal(stats.collabs, 0);
  assert.equal(stats.lateDropped, 0);
});

test('create 参数拒绝：非法名 / 主题 / 目标形态（不发帧、不建目录）', (t) => {
  const { service, sent, dir } = makeService(t);
  const target = { instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.2', port: 17321 };
  const cases = [
    { name: '甲\n乙', topic: '主题', targets: [target] },
    { name: '项目', topic: 'x'.repeat(201), targets: [target] },
    { name: '项目', topic: '主题', targets: [] },
    { name: '项目', topic: '主题', targets: [target, target] },
    { name: '项目', topic: '主题', targets: [{ ...target, instanceId: 'inst-self' }] },
    { name: '项目', topic: '主题', targets: [{ ...target, address: 'not-an-ip' }] },
    { name: '项目', topic: '主题', targets: [{ ...target, port: 70000 }] },
  ];
  for (const input of cases) {
    const result = service.create(input);
    assert.equal(result.ok, false, JSON.stringify(input).slice(0, 60));
  }
  assert.equal(sent.length, 0);
  const collabsDir = join(dir, COLLABS_DIR_NAME);
  assert.deepEqual(existsSync(collabsDir) ? readdirSync(collabsDir) : [], [], '拒绝路径不落任何协作目录');
});

test('create：台账 v1 与成员记录落盘、invite 帧逐目标发出、目标记入清单', (t) => {
  const { service, sent, remembered } = makeService(t);
  const result = service.create({
    name: '联调项目',
    topic: '发布联调',
    targets: [{ instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.2', port: 17321 }],
  });
  assert.equal(result.ok, true);
  assert.match(result.collabId, /^[0-9a-f-]{36}$/);
  assert.equal(result.invited.length, 1);
  assert.equal(result.invited[0].ok, true);
  const invites = sentOf(sent, 'invite', result.collabId);
  assert.equal(invites.length, 1);
  assert.deepEqual(invites[0].to, { instanceId: 'inst-b', address: '127.0.0.2', port: 17321 });
  assert.equal(invites[0].payload.name, '联调项目');
  assert.deepEqual(invites[0].payload.members, [
    { instanceId: 'inst-self', identityName: '本机' },
    { instanceId: 'inst-b', identityName: '主机乙' },
  ]);
  assert.equal(remembered.some((entry) => entry.instanceId === 'inst-b'), true);
  const listed = service.list().collabs;
  assert.equal(listed[0].role, 'manager');
  assert.equal(listed[0].state, 'proposed');
  assert.equal(listed[0].version, 1);
});

test('create：本机已有同名且参与者有交集的协作 → 拒绝（防重复发起）', (t) => {
  const { service } = makeService(t);
  service.create({ name: '联调项目', topic: '主题', targets: [{ instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.2', port: 17321 }] });
  const second = service.create({ name: '联调项目', topic: '主题', targets: [{ instanceId: 'inst-c', identityName: '主机丙', address: '127.0.0.3', port: 17321 }] });
  assert.equal(second.ok, false);
  assert.ok(second.message.includes('同名'));
});

test('create：本机参与协作数达上限（64）→ 拒绝', (t) => {
  const { service } = makeService(t);
  for (let index = 0; index < 64; index++) {
    const created = service.create({ name: `项目-${index}`, topic: '主题', targets: [{ instanceId: `inst-${index}`, identityName: `主机-${index}`, address: '127.0.0.2', port: 17321 + (index % 7) }] });
    assert.equal(created.ok, true, String(index));
  }
  const overflow = service.create({ name: '项目-溢出', topic: '主题', targets: [{ instanceId: 'inst-x', identityName: '主机X', address: '127.0.0.2', port: 17321 }] });
  assert.equal(overflow.ok, false);
  assert.ok(overflow.message.includes('上限'));
});

/* —— 邀请到达与同意门 —— */

test('invite 到达：成员记录建立（proposed / decision null / 有效期）、管理者端点与清单学习、过期标注随之', async (t) => {
  const { service, remembered } = makeService(t);
  const framed = inviteFrame({ collabId: 'collab-9' });
  const admitted = await receive(service, framed);
  assert.equal(admitted.ok, true);
  const listed = service.list().collabs;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].collabId, 'collab-9');
  assert.equal(listed[0].role, 'member');
  assert.equal(listed[0].state, 'proposed');
  assert.equal(listed[0].decision, null);
  assert.equal(listed[0].expired, false);
  assert.equal(Date.parse(listed[0].expiresAt) - Date.parse(listed[0].invitedAt), DAY);
  assert.ok(remembered.some((entry) => entry.instanceId === 'inst-a' && entry.address === '127.0.0.1'));
  const approved = await service.approve({ collabId: 'collab-9', approve: true });
  assert.equal(approved.ok, true);
});

test('邀请过期仅标注：状态与决策不变、过期后仍可回应', async (t) => {
  const { service, sent } = makeService(t, { config: { inviteTtlMs: 1 } });
  await receive(service, inviteFrame({ collabId: 'collab-exp' }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  const entry = service.list().collabs[0];
  assert.equal(entry.expired, true, '超过注入的有效期即标注过期');
  assert.equal(entry.state, 'proposed', '过期不改状态（过期不算拒绝）');
  assert.equal(entry.decision, null);
  const approved = await service.approve({ collabId: 'collab-exp', approve: true });
  assert.equal(approved.ok, true, '过期后仍可回应（只标注、不拦截）');
  assert.equal(sentOf(sent, 'approve', 'collab-exp').length, 1);
});

test('invite：来源为本机 / 名单不含本机 / 来源不在名单 → admit 拒绝、不建记录', async (t) => {
  const { service } = makeService(t);
  const selfSource = inviteFrame({ collabId: 'collab-c', manager: peer('inst-self', '本机', 17321), members: [peer('inst-self', '本机', 17321), peer('inst-b', '主机乙')] });
  const selfResult = await receive(service, selfSource);
  assert.equal(selfResult.ok, false);
  assert.ok(selfResult.reason.includes('自邀'));
  const withoutSelf = inviteFrame({ collabId: 'collab-a', members: [peer('inst-a', '主机甲'), peer('inst-b', '主机乙')] });
  const first = await receive(service, withoutSelf);
  assert.equal(first.ok, false);
  assert.ok(first.reason.includes('名单不含本机'));
  const badSource = inviteFrame({ collabId: 'collab-b', manager: peer('inst-x', '主机X'), members: [peer('inst-a', '主机甲'), peer('inst-self', '本机', 17321)] });
  const second = await receive(service, badSource);
  assert.equal(second.ok, false);
  assert.equal(service.list().collabs.length, 0);
});

test('invite：同来源限频（可注入）与挂起上限（16）', async (t) => {
  const { service } = makeService(t, { inviteMinIntervalMs: 50 });
  const first = await receive(service, inviteFrame({ collabId: 'collab-r1' }));
  assert.equal(first.ok, true);
  const second = await receive(service, inviteFrame({ collabId: 'collab-r2' }));
  assert.equal(second.ok, false);
  assert.ok(second.reason.includes('频繁'));
  await new Promise((resolve) => setTimeout(resolve, 60));
  const third = await receive(service, inviteFrame({ collabId: 'collab-r3' }));
  assert.equal(third.ok, true);

  const { service: fresh } = makeService(t);
  for (let index = 0; index < 16; index++) {
    const admitted = await receive(fresh, inviteFrame({ collabId: `collab-p${index}`, name: `项目-${index}` }));
    assert.equal(admitted.ok, true, String(index));
  }
  const overflow = await receive(fresh, inviteFrame({ collabId: 'collab-p16', name: '项目-溢出' }));
  assert.equal(overflow.ok, false);
  assert.ok(overflow.reason.includes('上限'));
});

test('approve：同意发帧并记 decision；同向重复幂等（不重复发帧）；改口拒绝', async (t) => {
  const { service, sent } = makeService(t);
  const framed = inviteFrame({ collabId: 'collab-9' });
  await receive(service, framed);
  await service.approve({ collabId: 'collab-9', approve: true });
  assert.equal(sentOf(sent, 'approve', 'collab-9').length, 1);
  const again = await service.approve({ collabId: 'collab-9', approve: true });
  assert.equal(again.ok, true);
  assert.equal(sentOf(sent, 'approve', 'collab-9').length, 1);
  const flip = await service.approve({ collabId: 'collab-9', approve: false });
  assert.equal(flip.ok, false);
  const declined = await service.approve({ collabId: 'collab-10', approve: false, reason: '人手不足' });
  assert.equal(declined.ok, false);   // 未收到该邀请
});

test('decline：拒绝帧携带 reason；decision 定格 declined', async (t) => {
  const { service, sent } = makeService(t);
  const framed = inviteFrame({ collabId: 'collab-9' });
  await receive(service, framed);
  const result = await service.approve({ collabId: 'collab-9', approve: false, reason: ' 人手不足 ' });
  assert.equal(result.ok, true);
  assert.equal(result.decision, 'declined');
  const frames = sentOf(sent, 'decline', 'collab-9');
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0].payload, { reason: '人手不足' });
});

/* —— 管理者侧：回应收集与建立 —— */

function managerWithTwoInvites(t) {
  const made = makeService(t);
  const created = made.service.create({
    name: '联调项目',
    topic: '发布联调',
    targets: [
      { instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.2', port: 17321 },
      { instanceId: 'inst-c', identityName: '主机丙', address: '127.0.0.3', port: 17321 },
    ],
  });
  return { ...made, collabId: created.collabId };
}

test('approve 到达管理席位：入账 + 快照推进 + 未全票不建立', async (t) => {
  const { service, sent, collabId } = managerWithTwoInvites(t);
  await receive(service, collabFrame('approve', collabId, peer('inst-b', '主机乙'), {}));
  assert.equal(sentOf(sent, 'snapshot', collabId).length >= 1, true);
  assert.equal(sentOf(sent, 'notice', collabId).length, 0);
  assert.equal(service.list().collabs[0].state, 'proposed');
});

test('全票建立：status active、名单定格、established 通告与终定快照先于通告入队', async (t) => {
  const { service, sent, dir: made, collabId } = managerWithTwoInvites(t);
  await receive(service, collabFrame('approve', collabId, peer('inst-b', '主机乙'), {}));
  await receive(service, collabFrame('approve', collabId, peer('inst-c', '主机丙'), {}));
  const entry = service.list().collabs[0];
  assert.equal(entry.state, 'active');
  assert.equal(entry.version, 4, 'v1 创建 + 两条回应入账 + 建立定格');
  const notices = sentOf(sent, 'notice', collabId).filter((frame) => frame.payload.event === 'established');
  assert.equal(notices.length, 2);
  const queue = sent.filter((frame) => frame.collabId === collabId);
  assert.equal(queue[queue.length - 1].payload.event, 'established');
  const ledger = loadLedger(made, collabId).ledger;
  assert.equal(ledger.status, 'active');
  assert.equal(ledger.version, 4);
});

test('部分 decline：带剩余人建立（名单含同意者、declined 留档、通告只发同意者）', async (t) => {
  const { service, sent, collabId } = managerWithTwoInvites(t);
  await receive(service, collabFrame('approve', collabId, peer('inst-b', '主机乙'), {}));
  await receive(service, collabFrame('decline', collabId, peer('inst-c', '主机丙'), { reason: '忙' }));
  assert.equal(service.list().collabs[0].state, 'active');
  const notices = sentOf(sent, 'notice', collabId).filter((frame) => frame.payload.event === 'established');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].to.instanceId, 'inst-b');
});

test('全部 decline：保持提议中、不发建立通告（可整条撤回）', async (t) => {
  const { service, sent, collabId } = managerWithTwoInvites(t);
  await receive(service, collabFrame('decline', collabId, peer('inst-b', '主机乙'), {}));
  await receive(service, collabFrame('decline', collabId, peer('inst-c', '主机丙'), {}));
  assert.equal(service.list().collabs[0].state, 'proposed');
  assert.equal(sentOf(sent, 'notice', collabId).filter((frame) => frame.payload.event === 'established').length, 0);
});

test('同意门迟到守卫：已撤回 / 已回应的成员不被迟到回应翻转', async (t) => {
  const withdrawn = managerWithTwoInvites(t);
  await withdrawn.service.withdraw({ collabId: withdrawn.collabId, target: 'inst-b' });
  const atWithdrawn = withdrawn.service.list().collabs[0].version;
  await receive(withdrawn.service, collabFrame('approve', withdrawn.collabId, peer('inst-b', '主机乙'), {}));
  assert.equal(withdrawn.service.list().collabs[0].version, atWithdrawn, '迟到同意零台账变更');
  const afterWithdraw = (await withdrawn.service.view({ collabId: withdrawn.collabId })).ledger;
  assert.equal(afterWithdraw.members.find((entry) => entry.instanceId === 'inst-b').state, 'withdrawn', '已撤回成员不被迟到同意翻转');
  assert.equal(withdrawn.service.stats().eventMismatch, 1);

  const decided = managerWithTwoInvites(t);
  await receive(decided.service, collabFrame('approve', decided.collabId, peer('inst-b', '主机乙'), {}));
  const atApproved = decided.service.list().collabs[0].version;
  await receive(decided.service, collabFrame('decline', decided.collabId, peer('inst-b', '主机乙'), { reason: '改口' }));
  assert.equal(decided.service.list().collabs[0].version, atApproved, '迟到拒绝零台账变更');
  const afterDecline = (await decided.service.view({ collabId: decided.collabId })).ledger;
  assert.equal(afterDecline.members.find((entry) => entry.instanceId === 'inst-b').state, 'approved', '已同意成员不被迟到拒绝翻转');
  assert.equal(decided.service.stats().eventMismatch, 1);
});

/* —— 冲突检测与冻结 —— */

async function activeTwoMemberCollab(t, service, { collabId = 'collab-x' } = {}) {
  const framed = inviteFrame({ collabId, manager: peer('inst-a', '主机甲'), members: [peer('inst-a', '主机甲'), peer('inst-self', '本机', 17321)] });
  await receive(service, framed);
  await service.approve({ collabId, approve: true });
  await receive(service, collabFrame('notice', collabId, peer('inst-a', '主机甲'), { event: 'established', version: 2 }));
  return collabId;
}

test('冲突检测①（邀请到达）：冻结新到邀请并连带冻结本机同名协作 + 广播（目标含两条协作的端点）', async (t) => {
  const { service, sent } = makeService(t);
  const held = await activeTwoMemberCollab(t, service);
  const incoming = inviteFrame({ collabId: 'collab-y', manager: peer('inst-c', '主机丙'), members: [peer('inst-c', '主机丙'), peer('inst-self', '本机', 17321)], name: '联调项目' });
  const admitted = await receive(service, incoming);
  assert.equal(admitted.ok, true);
  const states = Object.fromEntries(service.list().collabs.map((entry) => [entry.collabId, entry.state]));
  assert.equal(states[held], 'frozen', '检出方连带冻结本机同名协作（双向冻结在检出机落地）');
  assert.equal(states['collab-y'], 'frozen');
  const freezes = sentOf(sent, 'freeze');
  assert.equal(freezes.length >= 1, true);
  assert.equal(freezes[0].payload.name, '联调项目');
  assert.equal(freezes.some((frame) => frame.collabId === 'collab-y'), true);
  assert.equal(service.stats().freezeDetected, 1);
});

test('冲突检测②（建立前）：全票后复检检出同名交集 → 冻结、不建立、广播', async (t) => {
  const made = makeService(t);
  const created = made.service.create({
    name: '联调项目',
    topic: '主题',
    targets: [
      { instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.2', port: 17321 },
      { instanceId: 'inst-c', identityName: '主机丙', address: '127.0.0.3', port: 17321 },
    ],
  });
  await receive(made.service, collabFrame('approve', created.collabId, peer('inst-b', '主机乙'), {}));
  /* 造出「同名交集协作在建立判定点前才进入注册表」的竞态态（到达时检测覆盖不到的窗口的防御面）：
   * 磁盘夹具写入另一条，加载路径不做冲突检测，重启后两条并存，最后一条回应触发建立判定点。 */
  writeRivalMember(made.dir);
  const reloaded = reloadService(made);
  assert.equal(reloaded.list().collabs.length, 2, '两条并存（加载不做冲突检测——竞态窗口的构造）');
  made.sent.length = 0;
  await receive(reloaded, collabFrame('approve', created.collabId, peer('inst-c', '主机丙'), {}));
  const entry = reloaded.list().collabs.find((candidate) => candidate.collabId === created.collabId);
  assert.equal(entry.state, 'frozen', '建立判定点复检检出同名交集');
  assert.equal(sentOf(made.sent, 'notice', created.collabId).filter((frame) => frame.payload.event === 'established').length, 0);
  assert.equal(sentOf(made.sent, 'freeze', created.collabId).length >= 1, true);
  assert.equal(reloaded.stats().freezeDetected, 1);
});

test('freeze 接收：匹配 → 冻结 + 转达（originMsgId 承载防环）；重复副本不再转达；不匹配拒绝', async (t) => {
  const { service, sent } = makeService(t);
  const held = await activeTwoMemberCollab(t, service);
  const noticeMembers = [peer('inst-a', '主机甲'), peer('inst-self', '本机', 17321)];
  const freeze = collabFrame('freeze', 'collab-remote', peer('inst-c', '主机丙'), {
    name: '联调项目',
    members: noticeMembers.map((entry) => ({ instanceId: entry.instanceId, identityName: entry.identityName })),
    reason: '同名冲突',
  });
  const admitted = await receive(service, freeze);
  assert.equal(admitted.ok, true);
  assert.equal(service.list().collabs.find((entry) => entry.collabId === held).state, 'frozen');
  const relays = sent.filter((entry) => entry.type === 'freeze');
  assert.equal(relays.length, 1, '转达给匹配协作的其他端点（除本机与来源，逐目标一帧）');
  assert.equal(relays[0].payload.originMsgId, freeze.msgId);
  assert.notEqual(relays[0].payload, freeze.payload, '转达载荷为独立副本（独立入队）');
  assert.equal(relays[0].collabId, held, '转达归属被匹配的本地协作');
  assert.equal(service.stats().freezeRelayed, 1);
  assert.equal(service.stats().freezeApplied, 1);
  const before = sent.length;
  await receive(service, { ...freeze, msgId: 'msg-copy-1', payload: { ...freeze.payload, originMsgId: freeze.msgId } });
  assert.equal(sent.length, before, '同 originMsgId 的重复副本不再转达（本地冻结幂等仍生效）');
  const unmatched = collabFrame('freeze', 'collab-none', peer('inst-z', '主机Z'), {
    name: '不相干项目',
    members: [peer('inst-z', '主机Z'), peer('inst-w', '主机W', 1)],
  });
  const refused = await receive(service, unmatched);
  assert.equal(refused.ok, false);
});

test('冻结期写拒绝：协作类消息与 send 均拒、白名单（snapshot / notice / leave / end）放行', async (t) => {
  const { service } = makeService(t);
  const held = await activeTwoMemberCollab(t, service);
  await receive(service, collabFrame('freeze', 'collab-remote', peer('inst-c', '主机丙'), {
    name: '联调项目',
    members: [peer('inst-a', '主机甲'), peer('inst-self', '本机', 17321)],
  }));
  const write = await receive(service, collabFrame('reply', held, peer('inst-a', '主机甲'), { text: '冻结期消息' }));
  assert.equal(write.ok, false);
  assert.ok(write.reason.includes('冻结'));
  for (const type of ['topic', 'progress']) {
    const rejected = await service.hooks.admit(collabFrame(type, held, peer('inst-a', '主机甲'), { text: '冻结期消息' }), { remoteAddress: '127.0.0.1' });
    assert.equal(rejected.ok, false, `冻结期 ${type} 拒绝`);
    assert.ok(rejected.reason.includes('冻结'));
  }
  assert.equal(service.stats().rejectedFrozen, 3, '被冻结拒绝的协作类消息逐条计数');
  const send = await service.send({ collabId: held, text: '冻结期外发', type: 'reply' });
  assert.equal(send.ok, false);
  const snapshot = await receive(service, collabFrame('snapshot', held, peer('inst-a', '主机甲'), { kind: 'request' }));
  assert.equal(snapshot.ok, true);
  for (const type of ['notice', 'leave', 'end']) {
    const allowed = await service.hooks.admit(collabFrame(type, held, peer('inst-a', '主机甲'), {}), { remoteAddress: '127.0.0.1' });
    assert.equal(allowed.ok, true, `冻结期 ${type} 放行`);
  }
});

/* —— 撤回 / 结束 / 退出 —— */

test('withdraw：single 单条撤回；已回应 / 未知目标 / 成员侧拒绝；all 终止并归档', async (t) => {
  const { service, sent, collabId } = managerWithTwoInvites(t);
  const single = await service.withdraw({ collabId, target: 'inst-b' });
  assert.equal(single.ok, true);
  assert.deepEqual(sentOf(sent, 'withdraw', collabId).map((frame) => frame.payload.scope), ['single']);
  const invalidTarget = await service.withdraw({ collabId, target: 42 });
  assert.equal(invalidTarget.ok, false, '已提供但非法的 target：明确拒绝');
  assert.equal(service.list().collabs[0].state, 'proposed', '非法 target 不静默归并整条撤回');
  assert.deepEqual(sentOf(sent, 'withdraw', collabId).map((frame) => frame.payload.scope), ['single'], '非法 target 不发帧');
  await receive(service, collabFrame('approve', collabId, peer('inst-c', '主机丙'), {}));
  const responded = await service.withdraw({ collabId, target: 'inst-c' });
  assert.equal(responded.ok, false, '已回应的成员不可撤回');
  const badTarget = await service.withdraw({ collabId, target: 'inst-zz' });
  assert.equal(badTarget.ok, false);
  const memberSide = makeService(t);
  const framed = inviteFrame({ collabId: 'collab-m' });
  await receive(memberSide.service, framed);
  const notManager = await memberSide.service.withdraw({ collabId: 'collab-m' });
  assert.equal(notManager.ok, false);

  const second = managerWithTwoInvites(t);
  const all = await second.service.withdraw({ collabId: second.collabId });
  assert.equal(all.ok, true);
  assert.deepEqual(sentOf(second.sent, 'withdraw', second.collabId).map((frame) => frame.payload.scope), ['all', 'all']);
  const entry = second.service.list().collabs[0];
  assert.equal(entry.state, 'terminated');
  assert.equal(entry.archived, true);
  assert.equal(second.service.count(), 0, '归档不计入参与数');
});

test('withdraw 到达成员：single 定格 withdrawn；all 终止并归档', async (t) => {
  const { service } = makeService(t);
  const first = inviteFrame({ collabId: 'collab-9' });
  await receive(service, first);
  await receive(service, collabFrame('withdraw', 'collab-9', peer('inst-a', '主机甲'), { scope: 'single' }));
  assert.equal(service.list().collabs[0].decision, 'withdrawn');
  const second = inviteFrame({ collabId: 'collab-11', name: '第二协作' });
  await receive(service, second);
  await receive(service, collabFrame('withdraw', 'collab-11', peer('inst-a', '主机甲'), { scope: 'all' }));
  const entry = service.list().collabs.find((candidate) => candidate.collabId === 'collab-11');
  assert.equal(entry.state, 'terminated');
  assert.equal(entry.archived, true);
});

test('end：先终态快照后 end 通告（按目标 FIFO 序）、本地归档；proposed / 已结束拒绝', async (t) => {
  const { service, sent, collabId } = managerWithTwoInvites(t);
  const proposed = await service.end({ collabId });
  assert.equal(proposed.ok, false);
  assert.ok(proposed.message.includes('撤回'));
  await receive(service, collabFrame('approve', collabId, peer('inst-b', '主机乙'), {}));
  await receive(service, collabFrame('approve', collabId, peer('inst-c', '主机丙'), {}));
  sent.length = 0;
  const ended = await service.end({ collabId });
  assert.equal(ended.ok, true);
  const forB = sent.filter((frame) => frame.collabId === collabId && frame.to.instanceId === 'inst-b');
  assert.equal(forB[0].type, 'snapshot');
  assert.equal(forB[forB.length - 1].type, 'end');
  assert.equal(service.list().collabs[0].state, 'completed');
  assert.equal((await service.end({ collabId })).ok, false);
});

test('end 到达成员 / 迟到消息：归档 + 协作类拒绝并计数 + snapshot 放行', async (t) => {
  const { service } = makeService(t);
  const held = await activeTwoMemberCollab(t, service);
  await receive(service, collabFrame('end', held, peer('inst-a', '主机甲'), {}));
  assert.equal(service.list().collabs[0].state, 'completed');
  const late = await receive(service, collabFrame('reply', held, peer('inst-a', '主机甲'), { text: '迟到' }));
  assert.equal(late.ok, false);
  assert.equal(service.stats().lateDropped, 1);
  const admitted = await receive(service, snapshotFrame(held, peer('inst-a', '主机甲'), 9));
  assert.equal(admitted.ok, true, '归档态放行快照接收');
});

test('leave：成员退出发帧并归档；管理者拒绝自身退出；管理者收 leave 入账 + roster 通告', async (t) => {
  const { service, sent } = makeService(t);
  const held = await activeTwoMemberCollab(t, service);
  const left = await service.leave({ collabId: held });
  assert.equal(left.ok, true);
  assert.equal(sentOf(sent, 'leave', held).length, 1);
  assert.equal(service.list().collabs[0].state, 'left');

  const managerSide = managerWithTwoInvites(t);
  await receive(managerSide.service, collabFrame('approve', managerSide.collabId, peer('inst-b', '主机乙'), {}));
  await receive(managerSide.service, collabFrame('approve', managerSide.collabId, peer('inst-c', '主机丙'), {}));
  const managerLeave = await managerSide.service.leave({ collabId: managerSide.collabId });
  assert.equal(managerLeave.ok, false);
  managerSide.sent.length = 0;
  await receive(managerSide.service, collabFrame('leave', managerSide.collabId, peer('inst-b', '主机乙'), {}));
  assert.equal(managerSide.sent.some((frame) => frame.type === 'notice' && frame.payload.event === 'roster'), true);
  assert.equal(managerSide.service.stats().leftIn, 1);
});

/* —— 台账联动与快照 —— */

test('topic 到达管理席位：主题更新 + version 推进 + 快照；topic 外发时本机台账先行更新', async (t) => {
  const { service, sent, collabId } = managerWithTwoInvites(t);
  await receive(service, collabFrame('topic', collabId, peer('inst-b', '主机乙'), { text: '主题更新为发布冲刺' }));
  assert.equal(service.list().collabs[0].version, 2);
  assert.equal(sentOf(sent, 'snapshot', collabId).length >= 1, true);
  const topicOut = await service.send({ collabId, text: '主题更新为收尾阶段', type: 'topic' });
  assert.equal(topicOut.ok, true);
  assert.equal(sentOf(sent, 'topic', collabId).length, 2, '发给两名成员');
});

test('progress 到达管理席位：board 追加；超 200 条剪除最旧并计数', async (t) => {
  const { service, collabId } = managerWithTwoInvites(t);
  for (let index = 0; index < 205; index++) {
    await receive(service, collabFrame('progress', collabId, peer('inst-b', '主机乙'), { text: `进度-${index}` }));
  }
  assert.equal(service.stats().boardEvicted, 5);
});

test('快照接收：digest 校验通过即存储 + 回执；篡改 / 版本倒退拒绝', async (t) => {
  const { service, sent } = makeService(t);
  const held = await activeTwoMemberCollab(t, service);
  await receive(service, snapshotFrame(held, peer('inst-a', '主机甲'), 7));
  assert.equal(service.stats().snapshotStored, 1);
  assert.equal(sentOf(sent, 'notice', held).some((frame) => frame.payload.event === 'snapshot-stored'), true);
  const tampered = collabFrame('snapshot', held, peer('inst-a', '主机甲'), {
    kind: 'data',
    version: 8,
    digest: ledgerDigest(ledgerStub(held, 8)),
    ledger: { ...ledgerStub(held, 8), topic: '被篡改的主题' },
  });
  await receive(service, tampered);
  assert.equal(service.stats().snapshotCorrupt, 1);
  await receive(service, snapshotFrame(held, peer('inst-a', '主机甲'), 5));
  assert.equal(service.stats().snapshotStale, 1);
});

test('快照接收：形态与交叉一致性校验（形态非法 / 版本灌高 / collabId 不符 → 拒绝计数）', async (t) => {
  const { service, sent } = makeService(t);
  const held = await activeTwoMemberCollab(t, service);
  /* 形态非法（看板条目缺 text）：digest 自洽也不得进入内存 / 落盘（形态是接收侧第一关）。 */
  const misshapen = ledgerStub(held, 6);
  misshapen.board = [{ entryId: 'entry-1', ts: new Date().toISOString(), from: { instanceId: 'inst-a', identityName: '主机甲' }, kind: 'progress' }];
  await receive(service, collabFrame('snapshot', held, peer('inst-a', '主机甲'), { kind: 'data', version: 6, digest: ledgerDigest(misshapen), ledger: misshapen }));
  assert.equal(service.stats().snapshotCorrupt, 1);
  /* 版本灌高：version 字段与内嵌台账不一致 → 拒绝（防伪造高版本把后续正常快照全部按倒退丢弃）。 */
  await receive(service, collabFrame('snapshot', held, peer('inst-a', '主机甲'), { kind: 'data', version: 999, digest: ledgerDigest(ledgerStub(held, 5)), ledger: ledgerStub(held, 5) }));
  assert.equal(service.stats().snapshotCorrupt, 2);
  /* collabId 不符：内嵌台账属于别的协作 → 拒绝。 */
  await receive(service, collabFrame('snapshot', held, peer('inst-a', '主机甲'), { kind: 'data', version: 5, digest: ledgerDigest(ledgerStub('collab-other', 5)), ledger: ledgerStub('collab-other', 5) }));
  assert.equal(service.stats().snapshotCorrupt, 3);
  assert.equal(service.stats().snapshotStored, 0, '三例均不得入存储');
  assert.equal(sentOf(sent, 'notice', held).some((frame) => frame.payload.event === 'snapshot-stored'), false, '拒绝路径无回执');
});

test('快照载荷冻结：同批次两次变更的两帧 digest 各自自洽（活引用分叉的回归）', async (t) => {
  const { service, sent, collabId } = managerWithTwoInvites(t);
  await receive(service, collabFrame('approve', collabId, peer('inst-b', '主机乙'), {}));
  await receive(service, collabFrame('approve', collabId, peer('inst-c', '主机丙'), {}));
  const frames = sentOf(sent, 'snapshot', collabId).filter((frame) => frame.payload.kind === 'data');
  assert.equal(frames.length >= 2, true);
  for (const frame of frames) {
    assert.equal(ledgerDigest(frame.payload.ledger), frame.payload.digest, `v${frame.payload.version} 帧摘要与内容自洽`);
    assert.equal(frame.payload.ledger.version, frame.payload.version);
  }
});

test('快照应答载荷冻结：入队后台账再变更，帧摘要自洽且接收侧零「摘要不符」', async (t) => {
  const manager = managerWithTwoInvites(t);
  const member = makeService(t);
  await receive(member.service, inviteFrame({ collabId: manager.collabId, manager: peer('inst-a', '主机甲'), members: [peer('inst-a', '主机甲'), peer('inst-self', '本机', 17321)] }));
  await receive(manager.service, collabFrame('snapshot', manager.collabId, peer('inst-b', '主机乙'), { kind: 'request' }));
  const answers = sentOf(manager.sent, 'snapshot', manager.collabId).filter((frame) => frame.payload.kind === 'data');
  assert.equal(answers.length, 1, '请求应答一帧');
  /* 假发送按引用留存捕获（同真实队列「入队之后才序列化」的活引用面）：回执前台账再变更一次。 */
  await receive(manager.service, collabFrame('topic', manager.collabId, peer('inst-b', '主机乙'), { text: '主题更新' }));
  assert.equal(manager.service.list().collabs[0].version, 2, '应答之后台账确已变更');
  assert.equal(ledgerDigest(answers[0].payload.ledger), answers[0].payload.digest, '应答帧摘要与内容自洽（载荷已冻结）');
  assert.equal(answers[0].payload.ledger.version, answers[0].payload.version);
  await receive(member.service, collabFrame('snapshot', manager.collabId, peer('inst-a', '主机甲'), answers[0].payload));
  assert.equal(member.service.stats().snapshotCorrupt, 0, '接收侧零「快照摘要不符」');
  assert.equal(member.service.stats().snapshotStored, 1);
});

test('文本预校验：越界 topic 拒绝且本地台账零变更；stop / 拒绝原因同判据', async (t) => {
  const { service, collabId } = managerWithTwoInvites(t);
  const before = service.list().collabs[0].version;
  assert.equal((await service.send({ collabId, text: 'x'.repeat(250), type: 'topic' })).ok, false);
  assert.equal((await service.send({ collabId, text: '第一行\n第二行', type: 'topic' })).ok, false);
  assert.equal((await service.send({ collabId, text: 'x'.repeat(201), type: 'stop' })).ok, false);
  assert.equal(service.list().collabs[0].version, before, '拒绝路径零本地变更（台账未被毒化）');
  const viewed = await service.view({ collabId });
  assert.equal(viewed.ledger.topic, '发布联调', '主题保持原值');
  assert.equal(viewed.ledger.version, before);

  const memberSide = makeService(t);
  await receive(memberSide.service, inviteFrame({ collabId: 'collab-text' }));
  const badDecline = await memberSide.service.approve({ collabId: 'collab-text', approve: false, reason: 'x'.repeat(201) });
  assert.equal(badDecline.ok, false);
  const listed = memberSide.service.list().collabs[0];
  assert.equal(listed.decision, null, '校验失败不得先定格决策');
  assert.equal(listed.state, 'proposed');
});

test('快照请求：管理席位应答当前台账；成员侧忽略', async (t) => {
  const { service, sent, collabId } = managerWithTwoInvites(t);
  await receive(service, collabFrame('snapshot', collabId, peer('inst-b', '主机乙'), { kind: 'request' }));
  const replies = sentOf(sent, 'snapshot', collabId).filter((frame) => frame.payload.kind === 'data');
  assert.equal(replies.length, 1);
  assert.equal(replies[0].to.instanceId, 'inst-b');
  const memberSide = makeService(t);
  const held = await activeTwoMemberCollab(t, memberSide.service);
  memberSide.sent.length = 0;
  await receive(memberSide.service, collabFrame('snapshot', held, peer('inst-a', '主机甲'), { kind: 'request' }));
  assert.equal(sentOf(memberSide.sent, 'snapshot', held).length, 0);
});

/* —— 读路径与离线/终止语义 —— */

test('view：管理席位本机直读；成员在线拉取（注入回应）为 live', async (t) => {
  const { service, collabId } = managerWithTwoInvites(t);
  const localView = await service.view({ collabId });
  assert.equal(localView.source, 'local');
  assert.equal(localView.ledger.collabId, collabId);

  const memberSide = makeService(t);
  const held = await activeTwoMemberCollab(t, memberSide.service);
  const pending = memberSide.service.view({ collabId: held });
  await receive(memberSide.service, snapshotFrame(held, peer('inst-a', '主机甲'), 5));
  const liveView = await pending;
  assert.equal(liveView.source, 'live');
  assert.equal(liveView.version, 5);
});

test('view：超时回退快照并标注可能非最新；无快照 → ok:false；归档读快照并标记 archived', async (t) => {
  const { service } = makeService(t, { ledgerFetchTimeoutMs: 30 });
  const held = await activeTwoMemberCollab(t, service);
  await receive(service, snapshotFrame(held, peer('inst-a', '主机甲'), 5));
  const timeoutView = await service.view({ collabId: held });
  assert.equal(timeoutView.ok, true);
  assert.equal(timeoutView.source, 'snapshot');
  assert.ok(timeoutView.note.includes('可能非最新'));
  assert.equal(timeoutView.version, 5);
  await receive(service, collabFrame('end', held, peer('inst-a', '主机甲'), {}));
  const archivedView = await service.view({ collabId: held });
  assert.equal(archivedView.archived, true);
  assert.equal(archivedView.version, 5);

  const { service: bare } = makeService(t, { ledgerFetchTimeoutMs: 30 });
  const bareHeld = await activeTwoMemberCollab(t, bare);
  const missing = await bare.view({ collabId: bareHeld });
  assert.equal(missing.ok, false);
  assert.ok(missing.message.includes('没有可读台账'));
});

test('send 路由与状态门控：成员只发管理者、管理者可发指定/全体、未知与归档拒绝', async (t) => {
  const { service, sent } = makeService(t);
  const held = await activeTwoMemberCollab(t, service);
  const okSend = await service.send({ collabId: held, text: '收到', type: 'reply' });
  assert.equal(okSend.ok, true);
  assert.equal(sentOf(sent, 'reply', held)[0].to.instanceId, 'inst-a');
  const toOther = await service.send({ collabId: held, text: 'x', type: 'reply', to: 'inst-zz' });
  assert.equal(toOther.ok, false);
  const unknown = await service.send({ collabId: 'collab-none', text: 'x' });
  assert.equal(unknown.ok, false);
  await service.leave({ collabId: held });
  const afterLeft = await service.send({ collabId: held, text: 'x' });
  assert.equal(afterLeft.ok, false);
  const managerSide = managerWithTwoInvites(t);
  await receive(managerSide.service, collabFrame('approve', managerSide.collabId, peer('inst-b', '主机乙'), {}));
  await receive(managerSide.service, collabFrame('approve', managerSide.collabId, peer('inst-c', '主机丙'), {}));
  managerSide.sent.length = 0;
  const broadcast = await managerSide.service.send({ collabId: managerSide.collabId, text: '全体注意', type: 'issue' });
  assert.equal(broadcast.ok, true);
  assert.deepEqual(broadcast.to.sort(), ['inst-b', 'inst-c']);
  assert.equal(broadcast.note.includes('已排队'), true);
});

test('describe / count / stats：描述器缺省 null、计数排除归档', async (t) => {
  const { service, collabId } = managerWithTwoInvites(t);
  assert.deepEqual(service.describe(collabId), { name: '联调项目' });
  assert.equal(service.describe('collab-none'), null);
  assert.equal(service.count(), 1);
  await service.withdraw({ collabId });
  assert.equal(service.count(), 0);
  assert.equal(service.stats().byState.terminated, 1);
});

/* —— 重载恢复与门控健壮性 —— */

test('重载恢复：重建服务后注册表 / 台账 / 端点 / 决策均可恢复', async (t) => {
  const made = makeService(t);
  const framed = inviteFrame({ collabId: 'collab-9' });
  await receive(made.service, framed);
  await made.service.approve({ collabId: 'collab-9', approve: true });
  const reloaded = reloadService(made);
  const entry = reloaded.list().collabs[0];
  assert.equal(entry.collabId, 'collab-9');
  assert.equal(entry.decision, 'approved');
  assert.equal(reloaded.count(), 1);
});

test('台账损坏重建：隔离副本 + 从快照恢复；无快照 → 成员骨架 + 计数', async (t) => {
  const made = makeService(t);
  const created = made.service.create({ name: '联调项目', topic: '主题', targets: [{ instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.2', port: 17321 }] });
  const ledgerPath = collabFilePath(made.dir, created.collabId, LEDGER_FILE_NAME);
  const first = loadLedger(made.dir, created.collabId);
  assert.equal(first.ledger.version, 1);
  writeFileSync(ledgerPath, '{"broken":\n');
  const reloaded = reloadService(made);
  assert.equal(reloaded.stats().ledgerCorrupt, 1);
  assert.equal(reloaded.stats().ledgerRebuilt, 1);
  const quarantined = readdirSync(collabDir(made.dir, created.collabId)).filter((name) => name.startsWith(`${LEDGER_FILE_NAME}.corrupt-`));
  assert.equal(quarantined.length, 1);
  assert.equal(loadLedger(made.dir, created.collabId).ledger.version, 1, '重建已回写');
});

test('门控健壮性：畸形帧不抛出（异常隔离为拒绝）', async (t) => {
  const { service } = makeService(t);
  const broken = { v: 1, type: 'invite', msgId: 'msg-broken', from: peer('inst-a', '主机甲'), collabId: 'collab-broken', ts: new Date().toISOString(), payload: { name: '项目', topic: '主题', members: 'not-an-array' } };
  const admitted = await receive(service, broken);
  assert.equal(admitted.ok, false);
  await service.hooks.consume({ v: 1, type: 'invite', msgId: 'msg-broken-2', from: peer('inst-a', '主机甲'), collabId: 'collab-broken-2', ts: new Date().toISOString(), payload: {} }, { remoteAddress: '127.0.0.1' });
  assert.equal(service.stats().eventFailures, 1, 'consume 异常被隔离为计数，进程不退出');
  assert.equal(service.list().collabs.length, 0, '畸形邀请不建记录');
});

test('并发 view：同一协作的两个等待面各自解挂（先到者不再被后来者顶掉）', async (t) => {
  const { service } = makeService(t, { ledgerFetchTimeoutMs: 200 });
  const held = await activeTwoMemberCollab(t, service);
  const first = service.view({ collabId: held });
  const second = service.view({ collabId: held });
  await receive(service, snapshotFrame(held, peer('inst-a', '主机甲'), 5));
  const [firstView, secondView] = await Promise.all([first, second]);
  assert.equal(firstView.source, 'live', '先发起的等待面同样拿到在线回应');
  assert.equal(secondView.source, 'live');
  assert.equal(firstView.version, 5);
  assert.equal(secondView.version, 5);
});

test('并发 view：先到者超时只摘自己（等待面部分摘除），后到者仍被在线回应解挂', async (t) => {
  const { service } = makeService(t, { ledgerFetchTimeoutMs: 600 });
  const held = await activeTwoMemberCollab(t, service);
  const first = service.view({ collabId: held });
  /* 错开两个等待面的起点：先到者先超时（此时后到者仍在等待面列表里——摘除必须只摘自己）。 */
  await new Promise((resolve) => setTimeout(resolve, 150));
  const second = service.view({ collabId: held });
  const firstView = await first;
  assert.equal(firstView.ok, false, '先到者超时回退：本机无快照、如实拒绝');
  assert.equal(firstView.message, '管理者离线且本机无快照——没有可读台账');
  await receive(service, snapshotFrame(held, peer('inst-a', '主机甲'), 5));
  const secondView = await second;
  assert.equal(secondView.source, 'live', '回应仍能解挂后到者（先到者的超时未摘掉整条等待面）');
  assert.equal(secondView.version, 5);
});

test('close：在途 view 等待面被统一解挂（按无快照回退、不悬置到超时）', { timeout: 5000 }, async (t) => {
  const { service } = makeService(t, { ledgerFetchTimeoutMs: 60000 });
  const held = await activeTwoMemberCollab(t, service);
  const pending = service.view({ collabId: held });
  service.close();
  const view = await pending;
  assert.equal(view.ok, false, 'close 解挂等待面：本机无快照、如实拒绝');
  assert.equal(view.message, '管理者离线且本机无快照——没有可读台账');
});

test('观测计数：未知协作拒绝 / 快照回执 / 未匹配冻结（运营观测面断言）', async (t) => {
  const manager = managerWithTwoInvites(t);
  await receive(manager.service, collabFrame('approve', manager.collabId, peer('inst-b', '主机乙'), {}));
  assert.equal(manager.service.stats().unknownCollab, 0);
  const refused = await receive(manager.service, collabFrame('topic', 'collab-unknown', peer('inst-b', '主机乙'), { text: '越界' }));
  assert.equal(refused.ok, false);
  assert.equal(manager.service.stats().unknownCollab, 1);

  const member = makeService(t);
  const held = await activeTwoMemberCollab(t, member.service);
  member.sent.length = 0;
  await receive(member.service, snapshotFrame(held, peer('inst-a', '主机甲'), 5));
  assert.equal(member.service.stats().snapshotReceipts, 1, '快照回执成功计数');
  assert.equal(sentOf(member.sent, 'notice', held).some((frame) => frame.payload.event === 'snapshot-stored'), true);

  const freezeBefore = member.service.stats().freezeUnmatched;
  const freezeRefused = await receive(member.service, collabFrame('freeze', 'collab-none', peer('inst-a', '主机甲'), { name: '不存在的项目', members: [{ instanceId: 'inst-a' }, { instanceId: 'inst-self' }] }));
  assert.equal(freezeRefused.ok, false);
  assert.equal(member.service.stats().freezeUnmatched, freezeBefore + 1, '与己无关的冻结通告拒绝并计数');
});
