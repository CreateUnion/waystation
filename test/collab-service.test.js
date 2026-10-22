import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  COLLABS_DIR_NAME, carrierFilePath, collabDir, collabFilePath, invitesFilePath, pendingInvitesFilePath, seatFilePath,
} from '../src/paths.js';
import { makeTempDir, waitFor } from './helpers.js';
import { createCollabService } from '../src/collab/service.js';
import { DEFAULT_PENDING_INVITES_MAX } from '../src/collab/model.js';
import { createDispatch } from '../src/net/dispatch.js';
import { createInbound } from '../src/net/inbound.js';
import { POSTS_FILE_NAME } from '../src/collab/posts.js';
import { LEDGER_FILE_NAME, MEMBER_FILE_NAME, appendLedger, ledgerDigest, loadLedger } from '../src/collab/store.js';

const DAY = 24 * 60 * 60 * 1000;

function quietLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

/* 可选注入项的缺省归一：把 `??` 分支从构造大量选项的夹具里移出（保持夹具复杂度可读）。 */
function optionOf(value, fallback = null) {
  return value === undefined ? fallback : value;
}

/* 服务单测脚手架：真临时目录 + 假发送（捕获出队消息）+ 假直投（捕获直投消息）+ 假清单 + 本机提示捕获
 * （notify 注入面——放行提示等 local-alert 的落点）；hooks 直调模拟接收管线（admit 通过才 consume——
 * 与真实管线同序；落盘/ack 属接收管线自身用例，不在此重复）。overrides.self 供双节点夹具区分身份；
 * sendDirect: null = 直投面不可用（降级面）。
 * 对表对端选取默认静默（syncPeerPicker 返回空序）——由专门的对表用例注入真实对端，
 * 其余用例不被环境性直投噪音干扰。 */
function makeService(t, overrides = {}) {
  const dir = overrides.dataDir ?? makeTempDir(t);
  const sent = [];
  const direct = [];
  const remembered = [];
  const notices = [];
  const self = overrides.self ?? { instanceId: 'inst-self', identityName: '本机', port: 17321 };
  const config = { inviteTtlMs: DAY, ...(overrides.config ?? {}) };
  const knownHosts = optionOf(overrides.knownHosts, { remember: (entry) => remembered.push(entry) });
  const sendDirect = overrides.sendDirect === undefined
    ? (message) => {
        direct.push(message);
        return { ok: true, msgId: `d-${direct.length}` };
      }
    : overrides.sendDirect;
  const service = createCollabService({
    dataDir: dir,
    config,
    self,
    send: (message) => {
      sent.push(message);
      return { ok: true, msgId: `q-${sent.length}` };
    },
    sendDirect,
    knownHosts,
    notify: (frame) => notices.push(frame),
    probeCapability: optionOf(overrides.probeCapability),
    deliveryStatusOf: optionOf(overrides.deliveryStatusOf),
    localSeatDeliveryOf: optionOf(overrides.localSeatDeliveryOf),
    deliverSeat: overrides.deliverSeat,
    requestJoin: optionOf(overrides.requestJoin), requestJoinResolve: optionOf(overrides.requestJoinResolve),
    bindings: overrides.bindings ?? null, log: quietLog(),
    ledgerFetchTimeoutMs: overrides.ledgerFetchTimeoutMs ?? 60,
    inviteMinIntervalMs: overrides.inviteMinIntervalMs ?? 0,
    pullReplyTimeoutMs: overrides.pullReplyTimeoutMs,
    syncPeerPicker: overrides.syncPeerPicker ?? (() => []),
  });
  defaultSessionOf(service);
  return { service, sent, direct, remembered, notices, dir, self, config };
}

/* 0.2.0 会话级调用：创建/离席等入口必须携调用会话。旧夹具以直调服务装配协作，
 * 这里补上本机默认席位；显式传入的值优先（含显式 null——用于验证无标识拒绝）。 */
function defaultSessionOf(service) {
  for (const entry of ['create', 'send', 'leave', 'end', 'invite']) {
    const raw = service[entry];
    service[entry] = (input = {}) => raw({ sessionId: SELF_SEAT, ...input });
  }
}

let seq = 0;

/* 0.2.0 席位身份：instanceId 定机器、sessionId 定席位。本文件的对端夹具按实例标识派生稳定
 * 席位标识（同机双席场景另行显式给不同 sessionId）。 */
function peer(instanceId, identityName, port = 17321) {
  return { instanceId, sessionId: `sess-${instanceId}`, identityName, port };
}

function inviteFrame({ collabId = null, manager = peer('inst-a', '主机甲'), members, name = '联调项目', topic = '发布联调', mode, msgId = null } = {}) {
  seq++;
  const roster = members ?? [manager, peer('inst-self', '本机', 17321)];
  return {
    v: 1,
    cap: 2,
    type: 'invite',
    msgId: msgId ?? `msg-inv-${seq}`,
    from: { instanceId: manager.instanceId, sessionId: manager.sessionId, identityName: manager.identityName, port: manager.port },
    collabId: collabId ?? `collab-${seq}`,
    ts: new Date().toISOString(),
    payload: invitePayloadOf(name, topic, roster, mode),
  };
}

/* 邀请载荷成形：名单是会话席位条目（instanceId + sessionId + identityName，0.2.0 协议硬性）。
 * mode 给定才携带（缺字段 = 旧版对端形态——接收侧按 managed 解释）。 */
function invitePayloadOf(name, topic, roster, mode) {
  const payload = { name, topic, members: roster.map((entry) => ({ instanceId: entry.instanceId, sessionId: entry.sessionId ?? `sess-${entry.instanceId}`, identityName: entry.identityName })) };
  if (mode !== undefined) {
    payload.mode = mode;
  }
  return payload;
}

function collabFrame(type, collabId, from, payload) {
  seq++;
  return { v: 1, cap: 2, type, msgId: `msg-${type}-${seq}`, from: { instanceId: from.instanceId, sessionId: from.sessionId, identityName: from.identityName, port: from.port }, collabId, ts: new Date().toISOString(), payload };
}

function memberOf(dir, collabId) {
  return JSON.parse(readFileSync(collabFilePath(dir, collabId, MEMBER_FILE_NAME), 'utf8'));
}

/* 讨论成员事件（members.jsonl）：每行一条 join/leave 事件，成员粒度按 sessionId。 */
function memberEventsOf(dir, collabId) {
  try {
    return readFileSync(collabFilePath(dir, collabId, 'members.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function receive(service, frame, remoteAddress = '127.0.0.1') {
  const admitted = await service.hooks.admit(frame, { remoteAddress });
  if (admitted?.ok === true) {
    await service.hooks.consume(frame, { remoteAddress });
  }
  return admitted;
}

/* 讨论「加入」事件注入缝：经与真实接收同序的 admit + consume 落进成员事件日志（成员表装配）。
 * remoteAddress 传 '' 模拟「端点未知」的对端（事件入表但不学端点）。 */
async function receiveJoin(service, collabId, from, { remoteAddress = '127.0.0.1', ts = null } = {}) {
  const frame = collabFrame('join', collabId, from, { eventId: randomUUID(), ts: ts ?? new Date().toISOString() });
  return { frame, admitted: await receive(service, frame, remoteAddress) };
}

function sentOf(sent, type, collabId = null) {
  return sent.filter((entry) => entry.type === type && (collabId === null || entry.collabId === collabId));
}

/* 快照测试用最小合法台账与配套摘要（接收侧会重算 digest 比对——构造值必须真实自洽）。
 * 0.2.0 形态：managerTerm/joinSeqNext/manager.sessionId/席位 joinSeq 缺一即被 store 判 corrupt。 */
function ledgerStub(collabId, version) {
  const now = new Date().toISOString();
  return {
    version,
    collabId,
    name: '联调项目',
    topic: '发布联调',
    mode: 'managed',
    status: 'active',
    managerTerm: 1,
    joinSeqNext: 2,
    manager: { instanceId: 'inst-a', sessionId: 'sess-inst-a', identityName: '主机甲', term: 1 },
    members: [{ instanceId: 'inst-a', sessionId: 'sess-inst-a', identityName: '主机甲', role: 'manager', state: 'member', joinSeq: 1, joinedAt: now }],
    board: [],
    createdAt: now,
    updatedAt: now,
  };
}

function snapshotFrame(collabId, from, version) {
  const ledger = ledgerStub(collabId, version);
  return collabFrame('snapshot', collabId, from, { kind: 'data', version, digest: ledgerDigest(ledger), ledger });
}

/* —— 会话级种子夹具（0.2.0）：carrier(session-seats) + 新形态台账 + 席位文件 ——
 * 旧用例多以 service.create 装配「提议中的站长侧协作」；create 的落盘形态由 M3 负责迁移，
 * 本代理只改测试：直接按新形态落三件套，经正常加载路径（reloadService）装配，覆盖同一被测行为。 */
const SEED_AT = '2026-10-21T08:00:00.000Z';
const SELF_SEAT = 'sess-self';

/* 0.2.0 同意门：首次决定只发挑战（不产生状态变更），携 confirmToken 重试才生效。
 * 同意以调用会话为单位——会话标识决定入席的席位。 */
async function approveInviteWithConsentOf(service, collabId, sessionId, approve = true, reason = undefined) {
  const challenge = await service.approve({ collabId, approve, reason, sessionId });
  assert.equal(challenge.needsUserConfirmation, true, '同意 / 拒绝须用户确认（0.2.0 同意门）');
  return service.approve({ collabId, approve, reason, sessionId, confirmToken: challenge.confirmToken });
}

function writeSeedCollab(dir, { collabId, mode, status, name, topic, members, manager = null, endpoints = {} }) {
  mkdirSync(collabDir(dir, collabId), { recursive: true });
  const carrier = {
    format: 'session-seats',
    version: 1,
    collabId,
    name,
    topic,
    mode,
    endpoints,
    snapshotVersion: 1,
    createdAt: SEED_AT,
  };
  if (manager !== null) {
    carrier.manager = { ...manager, term: 1 };
  }
  writeFileSync(carrierFilePath(dir, collabId), JSON.stringify(carrier, null, 2));
  const ledger = {
    version: 1,
    collabId,
    name,
    topic,
    mode,
    status,
    managerTerm: 1,
    manager: mode === 'managed' ? { ...manager, term: 1 } : manager,
    members,
    board: [],
    createdAt: SEED_AT,
    updatedAt: SEED_AT,
  };
  if (mode === 'managed') {
    ledger.joinSeqNext = members.reduce((max, row) => Math.max(max, row.joinSeq ?? 0), 0) + 1;
  }
  writeFileSync(collabFilePath(dir, collabId, LEDGER_FILE_NAME), `${JSON.stringify(ledger)}\n`);
}

function writeSeatFile(dir, collabId, sessionId, { role = 'member', joinSeq = 1, muted = false } = {}) {
  mkdirSync(join(collabDir(dir, collabId), 'seats'), { recursive: true });
  writeFileSync(seatFilePath(dir, collabId, sessionId), JSON.stringify({
    version: 1,
    sessionId,
    role,
    state: 'member',
    joinSeq,
    joinedAt: SEED_AT,
    muted,
  }));
}

/* R1 叠加冻结种子：成员侧协作 + 载体任期冻结原因 + 成员记录的台账传播标记。 */
function seedLedgerFrozenMember(dir, collabId) {
  const manager = { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '主机甲' };
  const managerRow = { ...manager, role: 'manager', state: 'member', joinSeq: 1, joinedAt: SEED_AT };
  const memberRow = { instanceId: 'inst-self', sessionId: SELF_SEAT, identityName: '本机', role: 'member', state: 'member', joinSeq: 2, joinedAt: SEED_AT };
  writeSeedCollab(dir, {
    collabId, mode: 'managed', status: 'active', name: '叠加冻结', topic: '主题',
    members: [managerRow, memberRow], manager,
    endpoints: { 'inst-a': { address: '127.0.0.1', port: 17321 } },
  });
  writeSeatFile(dir, collabId, SELF_SEAT, { role: 'member', joinSeq: 2 });
  const carrierPath = carrierFilePath(dir, collabId);
  writeFileSync(carrierPath, JSON.stringify({ ...JSON.parse(readFileSync(carrierPath, 'utf8')), freezeReason: 'manager-offline' }));
  writeFileSync(collabFilePath(dir, collabId, MEMBER_FILE_NAME), JSON.stringify({
    collabId, name: '叠加冻结', topic: '主题', mode: 'managed', role: 'member', state: 'frozen',
    decision: 'approved', manager: { instanceId: 'inst-a', identityName: '主机甲' },
    roster: [managerRow, memberRow].map((row) => ({ instanceId: row.instanceId, identityName: row.identityName })),
    endpoints: { 'inst-a': { address: '127.0.0.1', port: 17321 } },
    freezeReason: 'ledger', frozenFrom: 'active', frozenAt: SEED_AT,
    invitedAt: SEED_AT, expiresAt: '2026-10-22T08:00:00.000Z',
  }));
  return { manager, managerRow, memberRow };
}

/* 站长侧 managed 协作种子：主席位 + invited 行（row 自带 sessionId 与端点地址）。 */
function seededManagedCollab(dir, {
  collabId = 'collab-mgr',
  name = '联调项目',
  topic = '发布联调',
  status = 'proposed',
  invited = [],
  managerInstanceId = 'inst-self',
  managerSessionId = SELF_SEAT,
  managerName = '本机',
} = {}) {
  const seeded = managedSeedRowsOf({ managerInstanceId, managerSessionId, managerName, invited });
  writeSeedCollab(dir, {
    collabId,
    mode: 'managed',
    status,
    name,
    topic,
    members: seeded.members,
    manager: { instanceId: managerInstanceId, sessionId: managerSessionId, identityName: managerName },
    endpoints: seeded.endpoints,
  });
  writeSeatFile(dir, collabId, managerSessionId, { role: 'manager', joinSeq: 1 });
  return collabId;
}

function managedSeedRowsOf({ managerInstanceId, managerSessionId, managerName, invited }) {
  const members = [{
    instanceId: managerInstanceId,
    sessionId: managerSessionId,
    identityName: managerName,
    role: 'manager',
    state: 'member',
    joinSeq: 1,
    joinedAt: SEED_AT,
  }];
  const endpoints = {};
  invited.forEach((entry, index) => {
    members.push({
      instanceId: entry.instanceId,
      sessionId: entry.sessionId ?? `sess-${entry.instanceId}`,
      identityName: entry.identityName,
      role: 'member',
      state: entry.state ?? 'invited',
      joinSeq: entry.joinSeq ?? index + 2,
      joinedAt: SEED_AT,
    });
    endpoints[entry.instanceId] = { address: entry.address ?? '127.0.0.2', port: entry.port ?? 17321 };
  });
  return { members, endpoints };
}

/* 讨论侧种子：发起人（本机）一席；讨论台账名单行不带站长角色。 */
function seededForumCollab(made, { collabId = 'collab-forum', name = '讨论甲', topic = '议题', status = 'proposed', sessionId = SELF_SEAT } = {}) {
  writeSeedCollab(made.dir, {
    collabId,
    mode: 'forum',
    status,
    name,
    topic,
    members: [{ instanceId: 'inst-self', sessionId, identityName: '本机', role: 'member', state: 'member', joinedAt: SEED_AT }],
    manager: { instanceId: 'inst-self', sessionId, identityName: '本机' },
  });
  writeSeatFile(made.dir, collabId, sessionId, { role: 'manager', joinSeq: 1 });
  return reloadService(made);
}

/* 磁盘夹具：写一条同名 managed 协作（用于构造「建立判定点前才出现同名交集」的竞态态）。 */
function writeRivalMember(dir, name = '联调项目') {
  seededManagedCollab(dir, {
    collabId: 'collab-rival',
    name,
    managerInstanceId: 'inst-d',
    managerSessionId: 'sess-rival',
    managerName: '主机丁',
    invited: [{ instanceId: 'inst-c', sessionId: 'sess-inst-c', identityName: '主机丙' }],
  });
}

/* 以既有工作目录重建服务（重载恢复与竞态构造共用；发送与直投仍汇入原数组便于断言）。 */
function reloadService(made) {
  const service = createCollabService({
    dataDir: made.dir,
    config: made.config,
    self: made.self,
    send: (message) => {
      made.sent.push(message);
      return { ok: true, msgId: `q-${made.sent.length}` };
    },
    sendDirect: (message) => {
      made.direct.push(message);
      return { ok: true, msgId: `d-${made.direct.length}` };
    },
    knownHosts: { remember: () => {} },
    log: quietLog(),
    ledgerFetchTimeoutMs: 30,
    inviteMinIntervalMs: 0,
  });
  defaultSessionOf(service);
  return service;
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
  /* 0.2.0 邀请载荷：members 只须含发起人席位；目标机器另用 targets 描述（设计 §2.2/D13）。 */
  assert.deepEqual(invites[0].payload.members, [
    { instanceId: 'inst-self', sessionId: 'sess-self', identityName: '本机' },
  ]);
  assert.deepEqual(invites[0].payload.targets, [{ instanceId: 'inst-b' }]);
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

test('invite 到达：成员记录建立（proposed / decision null / 有效期）、站长端点与清单学习、过期标注随之', async (t) => {
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
  const approved = await approveInviteWithConsentOf(service, 'collab-9', SELF_SEAT);
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
  const approved = await approveInviteWithConsentOf(service, 'collab-exp', SELF_SEAT);
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
  assert.ok(first.reason.includes('本机'), first.reason);
  const badSource = inviteFrame({ collabId: 'collab-b', manager: peer('inst-x', '主机X'), members: [peer('inst-a', '主机甲'), peer('inst-self', '本机', 17321)] });
  const second = await receive(service, badSource);
  assert.equal(second.ok, false);
  assert.equal(service.list().collabs.length, 0);
});

test('invite：同来源限频（可注入）与挂起上限（配置 pendingInvitesMax 缺省 64）', async (t) => {
  const { service } = makeService(t, { inviteMinIntervalMs: 50 });
  const first = await receive(service, inviteFrame({ collabId: 'collab-r1' }));
  assert.equal(first.ok, true);
  const second = await receive(service, inviteFrame({ collabId: 'collab-r2' }));
  assert.equal(second.ok, false);
  assert.ok(second.reason.includes('频繁'));
  await new Promise((resolve) => setTimeout(resolve, 60));
  const third = await receive(service, inviteFrame({ collabId: 'collab-r3' }));
  assert.equal(third.ok, true);

  const freshMade = makeService(t);
  const fresh = freshMade.service;
  for (let index = 0; index < DEFAULT_PENDING_INVITES_MAX; index++) {
    /* 0.2.0 邀请携 inviteId：挂起账（pending-invites）是上限计数的权威面，重启后仍可恢复。 */
    const frame = inviteFrame({ collabId: `collab-p${index}`, name: `项目-${index}` });
    frame.payload.inviteId = `inv-p${index}`;
    const admitted = await receive(fresh, frame);
    assert.equal(admitted.ok, true, String(index));
  }
  const overflow = await receive(fresh, inviteFrame({ collabId: `collab-p${DEFAULT_PENDING_INVITES_MAX}`, name: '项目-溢出' }));
  assert.equal(overflow.ok, false);
  assert.ok(overflow.reason.includes(`上限（${DEFAULT_PENDING_INVITES_MAX}）`), overflow.reason);
  /* 重启后按挂起邀请账计数（invite-stub 不参与注册表加载，旧口径会归零）。 */
  const restarted = reloadService(freshMade);
  const overflowAfterRestart = await receive(restarted, inviteFrame({ collabId: 'collab-p-after-restart', name: '项目-重启后' }));
  assert.equal(overflowAfterRestart.ok, false, '重启后上限计数仍准确');
  assert.ok(overflowAfterRestart.reason.includes(`上限（${DEFAULT_PENDING_INVITES_MAX}）`), overflowAfterRestart.reason);
});

test('M-5 邀请落点失败：会话注入面按失败帧抑制（不再投出无法接受的邀请）', async (t) => {
  const made = makeService(t);
  const blockedId = 'collab-landing-blocked';
  /* 载体可写、挂起邀请落盘失败：把 pending-invites.json 的位置换成目录（邀请落点失败路径）。 */
  mkdirSync(join(collabDir(made.dir, blockedId), 'pending-invites.json'), { recursive: true });
  const failed = inviteFrame({ collabId: blockedId });
  failed.payload.inviteId = 'inv-landing-blocked';
  const admitted = await receive(made.service, failed);
  assert.equal(admitted.ok, true, `准入面受理（落点失败属消费面）：${admitted.reason}`);
  assert.equal(made.service.stats().inviteLandingAborted, 1);
  assert.deepEqual(
    made.service.hooks.sessionGate(failed, { sessionId: SELF_SEAT }),
    { suppress: true },
    '落点失败的邀请不得注入会话（用户看不到不可接受的待办）',
  );

  const valid = inviteFrame({ collabId: 'collab-landing-ok' });
  valid.payload.inviteId = 'inv-landing-ok';
  assert.equal((await receive(made.service, valid)).ok, true);
  assert.deepEqual(made.service.hooks.sessionGate(valid, { sessionId: SELF_SEAT }), { suppress: false }, '正常邀请照旧注入');
});

test('approve：同意发帧并记 decision；同向重复幂等（不重复发帧）；改口拒绝', async (t) => {
  const { service, sent } = makeService(t);
  const framed = inviteFrame({ collabId: 'collab-9' });
  await receive(service, framed);
  await approveInviteWithConsentOf(service, 'collab-9', SELF_SEAT);
  assert.equal(sentOf(sent, 'approve', 'collab-9').length, 1);
  const again = await service.approve({ collabId: 'collab-9', approve: true, sessionId: SELF_SEAT });
  assert.equal(again.ok, true);
  assert.equal(sentOf(sent, 'approve', 'collab-9').length, 1);
  const flip = await service.approve({ collabId: 'collab-9', approve: false, sessionId: SELF_SEAT });
  assert.equal(flip.ok, false);
  const declined = await service.approve({ collabId: 'collab-10', approve: false, reason: '人手不足', sessionId: SELF_SEAT });
  assert.equal(declined.ok, false);   // 未收到该邀请
});

test('重启后重复接受（N-1）：invite-stub 无本地记录时未成席的再次接受仍重发 approve', async (t) => {
  const first = makeService(t);
  const collabId = 'collab-n1';
  const inviteId = 'inv-n1';
  /* 盘上只有挂起邀请（无载体 / 无本地参与记录）：等同重启后 invite-stub 的读取面。 */
  mkdirSync(collabDir(first.dir, collabId), { recursive: true });
  writeFileSync(pendingInvitesFilePath(first.dir, collabId), JSON.stringify({
    version: 1,
    invites: [{
      inviteId,
      collabId,
      fromManager: { instanceId: 'inst-a', sessionId: 'sess-a' },
      targetSessionId: SELF_SEAT,
      expiresAt: Date.now() + 60000,
      state: 'open',
      acceptedSessions: [],
    }],
  }));
  /* 同一数据根换新服务：invite-stub 不参与注册表加载（等价于重启后的读取面）。 */
  const made = makeService(t, {
    dataDir: first.dir,
    knownHosts: { lookup: () => ({ address: '127.0.0.1', port: 17321 }), remember: () => {} },
  });
  assert.equal(made.service.list().collabs.length, 0, '重启后本地无该协作记录');

  const firstChallenge = await made.service.approve({ collabId, inviteId, sessionId: SELF_SEAT, approve: true });
  assert.equal(firstChallenge.needsUserConfirmation, true, JSON.stringify(firstChallenge));
  const accepted = await made.service.approve({
    collabId, inviteId, sessionId: SELF_SEAT, approve: true, confirmToken: firstChallenge.confirmToken,
  });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal(accepted.pending, true, '首次接受已消费挂起邀请、等待 grant');
  assert.equal(sentOf(made.direct, 'approve', collabId).length, 1, '首次接受发出 approve');

  const secondChallenge = await made.service.approve({ collabId, inviteId, sessionId: SELF_SEAT, approve: true });
  assert.equal(secondChallenge.needsUserConfirmation, true, '重复接受仍过用户确认门');
  const again = await made.service.approve({
    collabId, inviteId, sessionId: SELF_SEAT, approve: true, confirmToken: secondChallenge.confirmToken,
  });
  assert.equal(again.ok, true, `未成席的重复接受不得退回「本机没有该协作」：${again.message}`);
  assert.equal(again.resent, true, '重复接受必须重发 approve');
  assert.equal(sentOf(made.direct, 'approve', collabId).length, 2, 'approve 帧计数增加一条');
});

test('decline：拒绝帧携带 reason；decision 定格 declined', async (t) => {
  const { service, sent } = makeService(t);
  const framed = inviteFrame({ collabId: 'collab-9' });
  await receive(service, framed);
  const result = await approveInviteWithConsentOf(service, 'collab-9', SELF_SEAT, false, ' 人手不足 ');
  assert.equal(result.ok, true);
  assert.equal(result.decision, 'declined');
  const frames = sentOf(sent, 'decline', 'collab-9');
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0].payload, { reason: '人手不足' });
});

test('邀请确认门：首次决定只发挑战（状态不变）；携 confirmToken 重试才生效', async (t) => {
  const { service, dir } = makeService(t);
  await receive(service, inviteFrame({ collabId: 'collab-consent' }));
  const first = await service.approve({ collabId: 'collab-consent', approve: true, sessionId: 'session-c1' });
  assert.equal(first.ok, false);
  assert.equal(first.needsUserConfirmation, true);
  assert.equal(typeof first.confirmToken, 'string');
  assert.equal(first.invite.name, '联调项目', '邀请摘要供代理向用户转述');
  assert.equal(memberOf(dir, 'collab-consent').decision ?? null, null, '未取得用户确认＝零状态变更');
  const approved = await service.approve({ collabId: 'collab-consent', approve: true, sessionId: 'session-c1', confirmToken: first.confirmToken });
  assert.equal(approved.ok, true);
  assert.equal(approved.decision, 'approved');
});

test('邀请确认门：拒绝同样需要确认；一次性豁免让下一次决定直接生效并消耗', async (t) => {
  const { service, dir } = makeService(t);
  await receive(service, inviteFrame({ collabId: 'collab-c2' }));
  assert.equal((await service.allowNextInvite({ sessionId: 'session-c2' })).ok, true);
  const declined = await service.approve({ collabId: 'collab-c2', approve: false, reason: '不参与', sessionId: 'session-c2' });
  assert.equal(declined.ok, true, '豁免：决定直接生效');
  assert.equal(declined.decision, 'declined');
  assert.equal(memberOf(dir, 'collab-c2').decision, 'declined');

  const second = makeService(t);
  await receive(second.service, inviteFrame({ collabId: 'collab-c3' }));
  await second.service.allowNextInvite({ sessionId: 'session-c3' });
  const direct = await second.service.approve({ collabId: 'collab-c3', approve: true, sessionId: 'session-c3' });
  assert.equal(direct.ok, true, '豁免消耗于第一次决定');
  await receive(second.service, inviteFrame({ collabId: 'collab-c4', name: '第二协作' }));
  const gated = await second.service.approve({ collabId: 'collab-c4', approve: true, sessionId: 'session-c3' });
  assert.equal(gated.needsUserConfirmation, true, '豁免已消耗：下一次重新需要确认');
});

test('会话级免确认：mode=session 连续同意不再逐条确认，拒绝仍需确认，off 撤销', async (t) => {
  const { service } = makeService(t);
  const enabled = await service.allowNextInvite({ sessionId: 'session-auto', mode: 'session' });
  assert.equal(enabled.ok, true);
  assert.equal(enabled.enabled, true);

  await receive(service, inviteFrame({ collabId: 'collab-auto-1' }));
  const first = await service.approve({ collabId: 'collab-auto-1', approve: true, sessionId: 'session-auto' });
  assert.equal(first.ok, true, '会话级豁免：同意直接生效');
  assert.equal(first.decision, 'approved');

  await receive(service, inviteFrame({ collabId: 'collab-auto-2', name: '第二协作' }));
  const second = await service.approve({ collabId: 'collab-auto-2', approve: true, sessionId: 'session-auto' });
  assert.equal(second.ok, true, '会话级豁免不消耗：本会话后续同意继续免确认');

  await receive(service, inviteFrame({ collabId: 'collab-auto-3', name: '第三协作' }));
  const decline = await service.approve({ collabId: 'collab-auto-3', approve: false, reason: '不参与', sessionId: 'session-auto' });
  assert.equal(decline.needsUserConfirmation, true, '拒绝仍走确认门（会话级豁免只免同意）');

  const status = await service.allowNextInvite({ sessionId: 'session-auto', mode: 'status' });
  assert.equal(status.enabled, true, 'status 查询当前会话的开关态');
  const off = await service.allowNextInvite({ sessionId: 'session-auto', mode: 'off' });
  assert.equal(off.ok, true);
  assert.equal(off.enabled, false);

  await receive(service, inviteFrame({ collabId: 'collab-auto-4', name: '第四协作' }));
  const gated = await service.approve({ collabId: 'collab-auto-4', approve: true, sessionId: 'session-auto' });
  assert.equal(gated.needsUserConfirmation, true, 'off 之后恢复逐条确认');
});

test('会话级免确认：只作用于登记会话；席位邀请路径（带 inviteId）同样只免同意', async (t) => {
  const { service } = makeService(t);
  await service.allowNextInvite({ sessionId: 'session-owner', mode: 'session' });
  await receive(service, inviteFrame({ collabId: 'collab-iso' }));

  const other = await service.approve({ collabId: 'collab-iso', approve: true, sessionId: 'session-other' });
  assert.equal(other.needsUserConfirmation, true, '同机其他会话不受影响');

  const seatApproved = await service.approve({
    collabId: 'collab-iso', inviteId: 'inv-missing', approve: true, sessionId: 'session-owner',
  });
  assert.notEqual(seatApproved.needsUserConfirmation, true, '席位邀请路径：同意不过确认门');

  const seatDeclined = await service.approve({
    collabId: 'collab-iso', inviteId: 'inv-missing', approve: false, sessionId: 'session-owner',
  });
  assert.equal(seatDeclined.needsUserConfirmation, true, '席位邀请路径：拒绝仍需确认');
});

test('邀请确认门：挑战绑定协作——他协作的令牌无效', async (t) => {
  const { service } = makeService(t);
  await receive(service, inviteFrame({ collabId: 'collab-x' }));
  await receive(service, inviteFrame({ collabId: 'collab-y', name: '协作乙' }));
  const a = await service.approve({ collabId: 'collab-x', approve: true, sessionId: 'session-z' });
  assert.equal(a.needsUserConfirmation, true);
  const cross = await service.approve({ collabId: 'collab-y', approve: true, sessionId: 'session-z', confirmToken: a.confirmToken });
  assert.equal(cross.needsUserConfirmation, true, '跨协作令牌无效（重新签发本协作挑战）');
  const b = await service.approve({ collabId: 'collab-y', approve: true, sessionId: 'session-z', confirmToken: cross.confirmToken });
  assert.equal(b.ok, true);
});

test('重入（成员侧·已拒绝）：managed 再收邀请 → 重新定格提议面（旧决策清空），同意门可再次入席', async (t) => {
  const { service, dir } = makeService(t);
  await receive(service, inviteFrame({ collabId: 'collab-rejoin' }));
  await approveInviteWithConsentOf(service, 'collab-rejoin', SELF_SEAT, false, '暂时不参与');
  assert.equal(memberOf(dir, 'collab-rejoin').decision, 'declined');
  const rejectedBefore = service.stats().invitesRejected;
  const admitted = await receive(service, inviteFrame({ collabId: 'collab-rejoin', topic: '重入主题' }));
  assert.equal(admitted.ok, true, admitted.reason);
  const member = memberOf(dir, 'collab-rejoin');
  assert.equal(member.state, 'proposed', '重新定格提议面');
  assert.equal(member.decision, null, '旧拒绝决策清空（重走同意门）');
  assert.equal(member.topic, '重入主题', '主题随最新邀请定格');
  assert.equal(service.stats().invitesRejected, rejectedBefore, '可重入终局不再计入拒绝');
  const approved = await approveInviteWithConsentOf(service, 'collab-rejoin', SELF_SEAT);
  assert.equal(approved.ok, true);
  assert.equal(approved.decision, 'approved', '重入后同意门照常生效');
});

test('重入（成员侧·已退出）：left 的协作再收邀请 → 清归档标记、重走同意门', async (t) => {
  const { service, dir } = makeService(t);
  await receive(service, inviteFrame({ collabId: 'collab-left-rejoin' }));
  assert.equal((await approveInviteWithConsentOf(service, 'collab-left-rejoin', SELF_SEAT)).decision, 'approved', '夹具前置：本机已同意');
  const left = await service.leave({ collabId: 'collab-left-rejoin' });
  assert.equal(left.ok, true, left.message);
  const leftMember = memberOf(dir, 'collab-left-rejoin');
  assert.equal(leftMember.state, 'left');
  assert.equal(typeof leftMember.archivedAt, 'string');
  const admitted = await receive(service, inviteFrame({ collabId: 'collab-left-rejoin', topic: '重入主题' }));
  assert.equal(admitted.ok, true, admitted.reason);
  const member = memberOf(dir, 'collab-left-rejoin');
  assert.equal(member.state, 'proposed', '退出后重新定格提议面');
  assert.equal('archivedAt' in member, false, '归档标记清除');
  assert.equal(member.decision, null);
});

test('重入边界（成员侧）：已加入（active）的 managed 重复邀请照旧拒绝——成员面零变更', async (t) => {
  const { service, dir } = makeService(t);
  await receive(service, inviteFrame({ collabId: 'collab-active-again' }));
  assert.equal((await approveInviteWithConsentOf(service, 'collab-active-again', SELF_SEAT)).decision, 'approved', '夹具前置：本机已同意');
  const before = memberOf(dir, 'collab-active-again');
  const rejectedBefore = service.stats().invitesRejected;
  await receive(service, inviteFrame({ collabId: 'collab-active-again' }));
  assert.equal(service.stats().invitesRejected, rejectedBefore + 1, '非终局重复邀请维持拒绝语义');
  assert.deepEqual(memberOf(dir, 'collab-active-again'), before, '成员面零变更');
});

/* —— 站长侧：回应收集与建立 —— */

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

test('approve 到达站长席位：入账 + 快照推进 + 未全票不建立', { skip: '夹具依赖已退役的机器级邀请/全票建立流程（0.2.0 由 M4 两段式入席取代；新流程覆盖见 test/collab-invites.test.js 与 test/collab-service-seats.test.js）——迁移到新夹具归 M9' }, async (t) => {
  const { service, sent, collabId } = managerWithTwoInvites(t);
  await receive(service, collabFrame('approve', collabId, peer('inst-b', '主机乙'), {}));
  assert.equal(sentOf(sent, 'snapshot', collabId).length >= 1, true);
  assert.equal(sentOf(sent, 'notice', collabId).length, 0);
  assert.equal(service.list().collabs[0].state, 'proposed');
});

test('全票建立：status active、名单定格、established 通告与终定快照先于通告入队', { skip: '夹具依赖已退役的机器级邀请/全票建立流程（0.2.0 由 M4 两段式入席取代；新流程覆盖见 test/collab-invites.test.js 与 test/collab-service-seats.test.js）——迁移到新夹具归 M9' }, async (t) => {
  const { service, sent, collabId } = managerWithTwoInvites(t);
  await receive(service, collabFrame('approve', collabId, peer('inst-b', '主机乙'), {}));
  await receive(service, collabFrame('approve', collabId, peer('inst-c', '主机丙'), {}));
  const entry = service.list().collabs[0];
  assert.equal(entry.state, 'active');
  assert.equal(entry.version, 4, 'v1 创建 + 两条回应入账 + 建立定格');
  const notices = sentOf(sent, 'notice', collabId).filter((frame) => frame.payload.event === 'established');
  assert.equal(notices.length, 2);
  const queue = sent.filter((frame) => frame.collabId === collabId);
  assert.equal(queue[queue.length - 1].payload.event, 'established');
  /* 建立结果以站长席位的权威台账面读取（内存台账即本次写入的权威对象；落盘形态归 create 的
   * 新形态迁移，不在本用例判定面）。 */
  const ledger = (await service.view({ collabId })).ledger;
  assert.equal(ledger.status, 'active');
  assert.equal(ledger.version, 4);
});

test('部分 decline：带剩余人建立（名单含同意者、declined 留档、通告只发同意者）', { skip: '夹具依赖已退役的机器级邀请/全票建立流程（0.2.0 由 M4 两段式入席取代；新流程覆盖见 test/collab-invites.test.js 与 test/collab-service-seats.test.js）——迁移到新夹具归 M9' }, async (t) => {
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

test('同意门迟到守卫：已撤回 / 已回应的成员不被迟到回应翻转', { skip: '夹具依赖已退役的机器级邀请/全票建立流程（0.2.0 由 M4 两段式入席取代；新流程覆盖见 test/collab-invites.test.js 与 test/collab-service-seats.test.js）——迁移到新夹具归 M9' }, async (t) => {
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
  const approved = await approveInviteWithConsentOf(service, collabId, SELF_SEAT);
  assert.equal(approved.decision, 'approved', '夹具前置：本机已同意');
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

test('冲突检测②（建立前）：全票后复检检出同名交集 → 冻结、不建立、广播', { skip: '夹具依赖已退役的机器级邀请/全票建立流程（0.2.0 由 M4 两段式入席取代；新流程覆盖见 test/collab-invites.test.js 与 test/collab-service-seats.test.js）——迁移到新夹具归 M9' }, async (t) => {
  const made = managerWithTwoInvites(t);
  const collabId = made.collabId;
  await receive(made.service, collabFrame('approve', collabId, peer('inst-b', '主机乙'), {}));
  /* 造出「同名交集协作在建立判定点前才进入注册表」的竞态态（到达时检测覆盖不到的窗口的防御面）：
   * 磁盘夹具写入另一条，加载路径不做冲突检测，重启后两条并存，最后一条回应触发建立判定点。 */
  writeRivalMember(made.dir);
  const reloaded = reloadService(made);
  assert.equal(reloaded.list().collabs.length, 2, '两条并存（加载不做冲突检测——竞态窗口的构造）');
  made.sent.length = 0;
  await receive(reloaded, collabFrame('approve', collabId, peer('inst-c', '主机丙'), {}));
  const entry = reloaded.list().collabs.find((candidate) => candidate.collabId === collabId);
  assert.equal(entry.state, 'frozen', '建立判定点复检检出同名交集');
  assert.equal(sentOf(made.sent, 'notice', collabId).filter((frame) => frame.payload.event === 'established').length, 0);
  assert.equal(sentOf(made.sent, 'freeze', collabId).length >= 1, true);
  assert.equal(reloaded.stats().freezeDetected, 1);
});

test('freeze 接收：匹配 → 冻结 + 转达（originMsgId 承载防环）；重复副本不再转达；不匹配拒绝', async (t) => {
  const { service, sent } = makeService(t);
  const held = await activeTwoMemberCollab(t, service);
  /* 签发者（inst-c）必须按席位在帧名单内（设计 §7.1 签发者校验）；inst-self 沿用邀请载荷的席位键。 */
  const noticeMembers = [peer('inst-c', '主机丙'), peer('inst-a', '主机甲'), peer('inst-self', '本机', 17321)];
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
    members: [peer('inst-c', '主机丙'), peer('inst-a', '主机甲'), peer('inst-self', '本机', 17321)],
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

test('R1 台账冻结 + 任期冻结叠加：重启保留成员 ledger 标记，active 台账到达后恢复', async (t) => {
  const made = makeService(t);
  const collabId = 'collab-r1-ledger';
  const { manager, managerRow, memberRow } = seedLedgerFrozenMember(made.dir, collabId);

  const service = reloadService(made);
  const entry = service.list().collabs.find((item) => item.collabId === collabId);
  assert.equal(entry?.state, 'frozen', '重启后仍按任期冻结停写');
  assert.equal(entry?.freezeReason, 'manager-offline', '展示面以载体任期原因为权威');

  /* authoritative active 台账到达：成员必须恢复，且台账传播标记被清除（不被任期原因覆盖）。 */
  const activeLedger = {
    version: 3, collabId, name: '叠加冻结', topic: '主题', mode: 'managed', status: 'active',
    managerTerm: 1, joinSeqNext: 3, manager: { ...manager, term: 1 }, members: [managerRow, memberRow],
    board: [], createdAt: SEED_AT, updatedAt: SEED_AT,
  };
  const from = { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '主机甲', port: 17321 };
  await receive(service, collabFrame('snapshot', collabId, from, {
    kind: 'data', version: 3, digest: ledgerDigest(activeLedger), ledger: activeLedger,
  }));
  const persisted = memberOf(made.dir, collabId);
  assert.equal(persisted.state, 'active', 'active 台账到达后成员恢复');
  assert.equal(persisted.freezeReason, undefined, '台账传播标记随恢复清除（未被任期原因覆盖）');
});

/* —— 撤回 / 结束 / 退出 —— */

test('withdraw：single 单条撤回；已回应 / 未知目标 / 成员侧拒绝；all 终止并归档', { skip: '夹具依赖已退役的机器级邀请/全票建立流程（0.2.0 由 M4 两段式入席取代；新流程覆盖见 test/collab-invites.test.js 与 test/collab-service-seats.test.js）——迁移到新夹具归 M9' }, async (t) => {
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

test('end：先终态快照后 end 通告（按目标 FIFO 序）、本地归档；proposed / 已结束拒绝', { skip: '夹具依赖已退役的机器级邀请/全票建立流程（0.2.0 由 M4 两段式入席取代；新流程覆盖见 test/collab-invites.test.js 与 test/collab-service-seats.test.js）——迁移到新夹具归 M9' }, async (t) => {
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

test('leave：成员退出发帧并归档；站长拒绝自身退出；站长收 leave 入账 + roster 通告', { skip: '夹具依赖已退役的机器级邀请/全票建立流程（0.2.0 由 M4 两段式入席取代；新流程覆盖见 test/collab-invites.test.js 与 test/collab-service-seats.test.js）——迁移到新夹具归 M9' }, async (t) => {
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

test('topic 到达站长席位：主题更新 + version 推进 + 快照；topic 外发时本机台账先行更新', { skip: '夹具依赖已退役的机器级邀请/全票建立流程（0.2.0 由 M4 两段式入席取代；新流程覆盖见 test/collab-invites.test.js 与 test/collab-service-seats.test.js）——迁移到新夹具归 M9' }, async (t) => {
  const { service, sent, collabId } = managerWithTwoInvites(t);
  await receive(service, collabFrame('topic', collabId, peer('inst-b', '主机乙'), { text: '主题更新为发布冲刺' }));
  assert.equal(service.list().collabs[0].version, 2);
  assert.equal(sentOf(sent, 'snapshot', collabId).length >= 1, true);
  const topicOut = await service.send({ collabId, text: '主题更新为收尾阶段', type: 'topic' });
  assert.equal(topicOut.ok, true);
  assert.equal(sentOf(sent, 'topic', collabId).length, 2, '发给两名成员');
});

test('progress 到达站长席位：board 追加；超 200 条剪除最旧并计数', async (t) => {
  const { service, collabId } = managerWithTwoInvites(t);
  for (let index = 0; index < 205; index++) {
    await receive(service, collabFrame('progress', collabId, peer('inst-b', '主机乙'), { text: `进度-${index}` }));
  }
  assert.equal(service.stats().boardEvicted, 5);
});

test('快照接收：digest 校验通过即存储 + 回执；篡改 / 版本倒退拒绝', { skip: '夹具依赖已退役的机器级邀请/全票建立流程（0.2.0 由 M4 两段式入席取代；新流程覆盖见 test/collab-invites.test.js 与 test/collab-service-seats.test.js）——迁移到新夹具归 M9' }, async (t) => {
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

test('快照载荷冻结：同批次两次变更的两帧 digest 各自自洽（活引用分叉的回归）', { skip: '夹具依赖已退役的机器级邀请/全票建立流程（0.2.0 由 M4 两段式入席取代；新流程覆盖见 test/collab-invites.test.js 与 test/collab-service-seats.test.js）——迁移到新夹具归 M9' }, async (t) => {
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

test('快照应答载荷冻结：入队后台账再变更，帧摘要自洽且接收侧零「摘要不符」', { skip: '夹具依赖已退役的机器级邀请/全票建立流程（0.2.0 由 M4 两段式入席取代；新流程覆盖见 test/collab-invites.test.js 与 test/collab-service-seats.test.js）——迁移到新夹具归 M9' }, async (t) => {
  /* 站长席位用新形态种子装配（create 的落盘形态迁移归 M3）：一席活跃成员可应答快照请求。 */
  const manager = makeService(t, { self: { instanceId: 'inst-a', identityName: '主机甲', port: 17321 } });
  const collabId = 'collab-snap-freeze';
  seededManagedCollab(manager.dir, {
    collabId,
    invited: [{ instanceId: 'inst-b', identityName: '主机乙', sessionId: 'sess-inst-b', state: 'member', joinSeq: 2, address: '127.0.0.2' }],
  });
  const managerService = reloadService(manager);
  const member = makeService(t);
  await receive(member.service, inviteFrame({ collabId, manager: peer('inst-a', '主机甲'), members: [peer('inst-a', '主机甲'), peer('inst-self', '本机', 17321)] }));
  await receive(managerService, collabFrame('snapshot', collabId, peer('inst-b', '主机乙'), { kind: 'request' }));
  const answers = sentOf(manager.sent, 'snapshot', collabId).filter((frame) => frame.payload.kind === 'data');
  assert.equal(answers.length, 1, '请求应答一帧');
  /* 假发送按引用留存捕获（同真实队列「入队之后才序列化」的活引用面）：回执前台账再变更一次。 */
  await receive(managerService, collabFrame('topic', collabId, peer('inst-b', '主机乙'), { text: '主题更新' }));
  assert.equal(managerService.list().collabs[0].version, 2, '应答之后台账确已变更');
  assert.equal(ledgerDigest(answers[0].payload.ledger), answers[0].payload.digest, '应答帧摘要与内容自洽（载荷已冻结）');
  assert.equal(answers[0].payload.ledger.version, answers[0].payload.version);
  await receive(member.service, collabFrame('snapshot', collabId, peer('inst-a', '主机甲'), answers[0].payload));
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
  const badDecline = await approveInviteWithConsentOf(memberSide.service, 'collab-text', SELF_SEAT, false, 'x'.repeat(201));
  assert.equal(badDecline.ok, false);
  const listed = memberSide.service.list().collabs[0];
  assert.equal(listed.decision, null, '校验失败不得先定格决策');
  assert.equal(listed.state, 'proposed');
});

test('快照请求：站长席位应答当前台账；成员侧忽略', async (t) => {
  const made = makeService(t);
  const collabId = seededManagedCollab(made.dir, {
    invited: [{ instanceId: 'inst-b', sessionId: 'sess-inst-b', identityName: '主机乙', state: 'member' }],
  });
  const service = reloadService(made);
  await receive(service, collabFrame('snapshot', collabId, peer('inst-b', '主机乙'), { kind: 'request' }));
  const replies = sentOf(made.sent, 'snapshot', collabId).filter((frame) => frame.payload.kind === 'data');
  assert.equal(replies.length, 1);
  assert.equal(replies[0].to.instanceId, 'inst-b');
  const memberSide = makeService(t);
  const held = await activeTwoMemberCollab(t, memberSide.service);
  memberSide.sent.length = 0;
  await receive(memberSide.service, collabFrame('snapshot', held, peer('inst-a', '主机甲'), { kind: 'request' }));
  assert.equal(sentOf(memberSide.sent, 'snapshot', held).length, 0);
});

/* —— 读路径与离线/终止语义 —— */

test('view：站长席位本机直读；成员在线拉取（注入回应）为 live', { skip: '夹具依赖已退役的机器级邀请/全票建立流程（0.2.0 由 M4 两段式入席取代；新流程覆盖见 test/collab-invites.test.js 与 test/collab-service-seats.test.js）——迁移到新夹具归 M9' }, async (t) => {
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

test('view：超时回退快照并标注可能非最新；无快照 → ok:false；归档读快照并标记 archived', { skip: '夹具依赖已退役的机器级邀请/全票建立流程（0.2.0 由 M4 两段式入席取代；新流程覆盖见 test/collab-invites.test.js 与 test/collab-service-seats.test.js）——迁移到新夹具归 M9' }, async (t) => {
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

test('send 路由与状态门控：成员只发站长、站长可发指定/全体、未知与归档拒绝', { skip: '夹具依赖已退役的机器级邀请/全票建立流程（0.2.0 由 M4 两段式入席取代；新流程覆盖见 test/collab-invites.test.js 与 test/collab-service-seats.test.js）——迁移到新夹具归 M9' }, async (t) => {
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

test('describe / count / stats：描述器含名称与模式、缺省 null、计数排除归档', async (t) => {
  const { service, collabId } = managerWithTwoInvites(t);
  assert.deepEqual(service.describe(collabId), { name: '联调项目', mode: 'managed' });
  assert.equal(service.describe('collab-none'), null);
  assert.equal(service.count(), 1);
  await service.withdraw({ collabId, sessionId: SELF_SEAT });
  assert.equal(service.count(), 0);
  assert.equal(service.stats().byState.terminated, 1);
});

/* —— 重载恢复与门控健壮性 —— */

test('重载恢复：重建服务后注册表 / 台账 / 名单均可恢复（新形态载体）', async (t) => {
  const made = makeService(t);
  const created = made.service.create({
    name: '联调项目',
    topic: '发布联调',
    targets: [{ instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.2', port: 17321 }],
  });
  const reloaded = reloadService(made);
  const entry = reloaded.list().collabs.find((item) => item.collabId === created.collabId);
  assert.equal(entry.collabId, created.collabId);
  assert.equal(entry.name, '联调项目');
  assert.equal(entry.role, 'manager');
  assert.equal(entry.memberCount >= 1, true, '台账名单恢复（站长至少一席）');
  assert.equal(reloaded.count(), 1);
});

test('台账损坏重建：隔离副本 + 从快照恢复；无快照 → 成员骨架 + 计数', async (t) => {
  const made = makeService(t);
  const collabId = seededManagedCollab(made.dir, { collabId: 'collab-recover', name: '联调项目', topic: '主题' });
  const ledgerPath = collabFilePath(made.dir, collabId, LEDGER_FILE_NAME);
  const first = loadLedger(made.dir, collabId);
  assert.equal(first.ledger.version, 1);
  writeFileSync(ledgerPath, '{"broken":\n');
  const reloaded = reloadService(made);
  assert.equal(reloaded.stats().ledgerCorrupt, 1);
  assert.equal(reloaded.stats().ledgerRebuilt, 1);
  const quarantined = readdirSync(collabDir(made.dir, collabId)).filter((name) => name.startsWith(`${LEDGER_FILE_NAME}.corrupt-`));
  assert.equal(quarantined.length, 1);
  assert.equal(loadLedger(made.dir, collabId).ledger.version, 1, '重建已回写');
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

test('并发 view：同一协作的两个等待面各自解挂（先到者不再被后来者顶掉）', { skip: '夹具依赖已退役的机器级邀请/全票建立流程（0.2.0 由 M4 两段式入席取代；新流程覆盖见 test/collab-invites.test.js 与 test/collab-service-seats.test.js）——迁移到新夹具归 M9' }, async (t) => {
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

test('并发 view：先到者超时只摘自己（等待面部分摘除），后到者仍被在线回应解挂', { skip: '夹具依赖已退役的机器级邀请/全票建立流程（0.2.0 由 M4 两段式入席取代；新流程覆盖见 test/collab-invites.test.js 与 test/collab-service-seats.test.js）——迁移到新夹具归 M9' }, async (t) => {
  const { service } = makeService(t, { ledgerFetchTimeoutMs: 600 });
  const held = await activeTwoMemberCollab(t, service);
  const first = service.view({ collabId: held });
  /* 错开两个等待面的起点：先到者先超时（此时后到者仍在等待面列表里——摘除必须只摘自己）。 */
  await new Promise((resolve) => setTimeout(resolve, 150));
  const second = service.view({ collabId: held });
  const firstView = await first;
  assert.equal(firstView.ok, false, '先到者超时回退：本机无快照、如实拒绝');
  assert.equal(firstView.message, '站长离线且本机无快照——没有可读台账');
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
  assert.equal(view.message, '站长离线且本机无快照——没有可读台账');
});

test('观测计数：未知协作拒绝 / 快照回执 / 未匹配冻结（运营观测面断言）', { skip: '夹具依赖已退役的机器级邀请/全票建立流程（0.2.0 由 M4 两段式入席取代；新流程覆盖见 test/collab-invites.test.js 与 test/collab-service-seats.test.js）——迁移到新夹具归 M9' }, async (t) => {
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

/* —— 讨论模式（模式字段、状态机裁剪、冲突隔离、邀请入口）—— */

function targetOf(index) {
  return { instanceId: `inst-${index}`, identityName: `主机${index}`, address: '127.0.0.2', port: 17321 };
}

function createForum(service, { name = '讨论甲', targets = [targetOf('b')] } = {}) {
  const created = service.create({ name, topic: '议题', targets, mode: 'forum' });
  assert.equal(created.ok, true, created.message);
  return created.collabId;
}

/* 「已加入」态夹具（服务 / 协议级口径）：真实加入通路归后续任务——此处以追加合法台账行的方式
 * 装配「进行中」，走正常加载路径（成员记录不动，站长席位状态以台账为权威）。 */
function advanceForumToActive(made, collabId) {
  const loaded = loadLedger(made.dir, collabId);
  appendLedger(made.dir, { ...loaded.ledger, status: 'active', version: loaded.ledger.version + 1 });
}

test('讨论创建：mode 入台账 / 成员记录 / 列表；写入侧写全（managed 创建同样显式写 mode）', (t) => {
  const { service, dir } = makeService(t);
  const collabId = createForum(service);
  const entry = service.list().collabs[0];
  assert.equal(entry.collabId, collabId);
  assert.equal(entry.mode, 'forum');
  const onDisk = JSON.parse(readFileSync(collabFilePath(dir, collabId, MEMBER_FILE_NAME), 'utf8'));
  assert.equal(onDisk.mode, 'forum');
  assert.equal(loadLedger(dir, collabId).ledger.mode, 'forum');

  const managed = service.create({ name: '协作乙', topic: '主题', targets: [targetOf('c')] });
  assert.equal(managed.ok, true);
  const managedEntry = service.list().collabs.find((candidate) => candidate.collabId === managed.collabId);
  assert.equal(managedEntry.mode, 'managed', '缺 mode 按 managed 解释（写入侧同样写全）');
  assert.equal(loadLedger(dir, managed.collabId).ledger.mode, 'managed');
});

test('讨论创建：targets 上限 15（含发起人共 16）；协议层名单硬顶 32 校验照旧', (t) => {
  const { service, sent } = makeService(t);
  const fifteen = Array.from({ length: 15 }, (_, index) => targetOf(`t${index}`));
  const created = service.create({ name: '讨论甲', topic: '议题', targets: fifteen, mode: 'forum' });
  assert.equal(created.ok, true, '15 项在限内');
  assert.equal(sentOf(sent, 'invite', created.collabId).length, 15);
  const overflow = service.create({ name: '讨论乙', topic: '议题', targets: [...fifteen, targetOf('t15')], mode: 'forum' });
  assert.equal(overflow.ok, false, '第 16 项（=17 人）拒绝');
  assert.ok(overflow.message.includes('16'), overflow.message);
  const badMode = service.create({ name: '讨论丙', topic: '议题', targets: [targetOf('c')], mode: 'discussion' });
  assert.equal(badMode.ok, false);
  assert.ok(badMode.message.includes('模式非法'));
  const managed = service.create({ name: '协作丁', topic: '主题', targets: [...fifteen, targetOf('t15')] });
  assert.equal(managed.ok, true, 'managed 上限（31）不受讨论 16 限制');
});

test('讨论状态机：提议中→进行中→已完成 / 提议中→已终止；非法边拒绝', async (t) => {
  const made = makeService(t);
  const collabId = 'collab-forum';
  const proposed = seededForumCollab(made, { collabId, name: '讨论甲' });
  assert.equal(proposed.list().collabs[0].state, 'proposed', '种子装配即「提议中」');
  const earlyEnd = await proposed.end({ collabId });
  assert.equal(earlyEnd.ok, false, '提议中不可直接结束（取消走整条撤回）');
  advanceForumToActive(made, collabId);
  const service = reloadService(made);
  assert.equal(service.list().collabs[0].state, 'active', '夹具装配「进行中」后经正常加载路径恢复');
  assert.equal(service.list().collabs[0].mode, 'forum', '模式随台账恢复');
  const activeWithdraw = await service.withdraw({ collabId });
  assert.equal(activeWithdraw.ok, false, '进行中不可整条撤回（结束走 end）');
  const ended = await service.end({ collabId });
  assert.equal(ended.ok, true);
  const entry = service.list().collabs[0];
  assert.equal(entry.state, 'completed');
  assert.equal(entry.archived, true);
  assert.equal((await service.end({ collabId })).ok, false, '终态不可再结束');

  const second = makeService(t);
  const secondId = 'collab-forum-b';
  const secondService = seededForumCollab(second, { collabId: secondId, name: '讨论乙' });
  const all = await secondService.withdraw({ collabId: secondId });
  assert.equal(all.ok, true);
  assert.equal(secondService.list().collabs[0].state, 'terminated');
});

test('讨论收冻结族帧：受理 + ack + 忽略计数、状态不变、不转达（freeze / decision 同判据）', async (t) => {
  const { service, sent } = makeService(t);
  createForum(service);
  sent.length = 0;
  const members = [peer('inst-c', '主机丙'), { instanceId: 'inst-self', sessionId: SELF_SEAT, identityName: '本机' }];
  const freeze = collabFrame('freeze', 'collab-remote', peer('inst-c', '主机丙'), { name: '讨论甲', members, reason: '同名冲突' });
  const admitted = await receive(service, freeze);
  assert.equal(admitted.ok, true, '讨论命中的冻结帧：受理 + ack（防治理重试钉死）');
  assert.equal(service.list().collabs[0].state, 'proposed', '讨论不被冻结（冻结态不可达）');
  assert.equal(service.stats().forumGovernanceIgnored, 1);
  assert.equal(service.stats().freezeApplied, 0);
  assert.equal(sentOf(sent, 'freeze').length, 0, '讨论不转达冻结帧');
  const decision = collabFrame('decision', 'collab-remote', peer('inst-c', '主机丙'), { choice: 'terminate', name: '讨论甲', members, executed: true });
  const decisionAdmitted = await receive(service, decision);
  assert.equal(decisionAdmitted.ok, true);
  assert.equal(service.stats().forumGovernanceIgnored, 2);
  assert.equal(service.list().collabs[0].state, 'proposed', '终结裁定不施于讨论');
  assert.equal(service.stats().freezeTerminatedLocal, 0);
  const unrelated = collabFrame('freeze', 'collab-none', peer('inst-z', '主机Z'), { name: '不相干项目', members: [{ instanceId: 'inst-z' }, { instanceId: 'inst-w' }] });
  assert.equal((await receive(service, unrelated)).ok, false, '与讨论也无关的冻结帧照旧拒绝（不滥 ack）');
});

test('治理工具守卫：讨论实例四入口（裁定 / 合流裁定 / 移交 / 抢接）一律拒绝并给指引；managed 与未知照旧', async (t) => {
  const made = makeService(t);
  const collabId = 'collab-forum';
  seededForumCollab(made, { collabId, name: '讨论甲' });
  advanceForumToActive(made, collabId);
  const service = reloadService(made);
  const calls = [
    { name: 'decide', invoke: () => service.decide({ collabId, choice: 'terminate' }) },
    { name: 'decideMerge', invoke: () => service.decideMerge({ collabId, mergeOffer: 'accept' }) },
    { name: 'handover', invoke: () => service.handover({ collabId, target: 'inst-b' }) },
    { name: 'takeOver', invoke: () => service.takeOver({ collabId }) },
  ];
  for (const call of calls) {
    const result = await call.invoke();
    assert.equal(result.ok, false, call.name);
    assert.ok(result.message.includes('讨论模式无此操作'), `${call.name}: ${result.message}`);
  }
  /* 提议中的讨论同判据（守卫先于状态判定，四入口同文案）。 */
  const fresh = makeService(t);
  const proposedId = 'collab-forum-p';
  const freshService = seededForumCollab(fresh, { collabId: proposedId, name: '讨论乙' });
  const early = await freshService.takeOver({ collabId: proposedId });
  assert.ok(early.message.includes('讨论模式无此操作'), early.message);

  /* managed 直通：原逻辑照旧执行（不误报讨论文案）。 */
  const managed = service.create({ name: '协作甲', topic: '主题', targets: [targetOf('b')] });
  const decided = await service.decide({ collabId: managed.collabId, choice: 'terminate', sessionId: SELF_SEAT });
  assert.equal(decided.ok, false);
  assert.ok(decided.message.includes('冻结'), decided.message);
  assert.ok(!decided.message.includes('讨论模式无此操作'));
  const merged = await service.decideMerge({ collabId: managed.collabId, mergeOffer: 'accept', sessionId: SELF_SEAT });
  assert.ok(merged.message.includes('合流'), merged.message);
  const handed = await service.handover({ collabId: managed.collabId, target: 'inst-b', sessionId: SELF_SEAT });
  assert.ok(handed.message.includes('移交'), handed.message);
  const taken = await service.takeOver({ collabId: managed.collabId, sessionId: SELF_SEAT });
  assert.ok(taken.message.includes('无需') && taken.message.includes('接管'), taken.message);

  /* 未知 collabId 照旧（守卫不臆造协作）。 */
  const unknown = await service.decide({ collabId: 'collab-none', choice: 'terminate' });
  assert.ok(unknown.message.includes('没有该协作'), unknown.message);
});

test('结束守卫：非发起人一律拒绝并指引 ws_leave_collab；发起人退出后结束不再受理；发起人照常可结束', async (t) => {
  /* 非发起人（成员侧记录）：拒绝并给替代动作。 */
  const memberSide = makeService(t);
  await receive(memberSide.service, inviteFrame({ collabId: 'collab-f-end', mode: 'forum' }));
  const memberEnd = await memberSide.service.end({ collabId: 'collab-f-end' });
  assert.equal(memberEnd.ok, false);
  assert.ok(memberEnd.message.includes('只有发起人可以结束讨论'), memberEnd.message);
  assert.ok(memberEnd.message.includes('ws_leave_collab'), memberEnd.message);
  assert.equal(memberSide.service.list().collabs[0].state, 'proposed', '拒绝路径零状态变更');

  /* 发起人（进行中）照常可结束。 */
  const initiator = makeService(t);
  const collabId = 'collab-forum';
  seededForumCollab(initiator, { collabId, name: '讨论甲' });
  advanceForumToActive(initiator, collabId);
  const active = reloadService(initiator);
  const ended = await active.end({ collabId });
  assert.equal(ended.ok, true, ended.message);
  assert.equal(active.list().collabs[0].state, 'completed');

  /* 发起人退出后再结束：拒绝（退出即放弃结束权——讨论存续，结束不再受理）。 */
  const leaving = makeService(t);
  const leftId = 'collab-forum-left';
  seededForumCollab(leaving, { collabId: leftId, name: '讨论乙' });
  advanceForumToActive(leaving, leftId);
  const left = reloadService(leaving);
  const leaveResult = await left.leave({ collabId: leftId });
  assert.equal(leaveResult.ok, true, leaveResult.message);
  const lateEnd = await left.end({ collabId: leftId });
  assert.equal(lateEnd.ok, false);
  /* 0.2.0：发起人席位随离席移除，结束权随席位消失——拒绝文案回到「只有发起人」面，
   * 「结束不再受理」的语义不变。 */
  assert.ok(lateEnd.message.includes('只有发起人'), lateEnd.message);
  assert.ok(lateEnd.message.includes('ws_leave_collab'), lateEnd.message);
});

test('入站类型白名单（发起人侧）：managed 专属类型到讨论一律拒绝并计数——名单通告（roster）是唯一例外', async (t) => {
  const made = makeService(t);
  const collabId = 'collab-forum';
  const service = seededForumCollab(made, { collabId, name: '讨论甲' });
  const before = loadLedger(made.dir, collabId).ledger;
  const sentBefore = made.sent.length;
  const sender = peer('inst-b', '主机乙');
  for (const type of ['topic', 'task', 'progress', 'issue', 'stop', 'reply']) {
    const admitted = await receive(service, collabFrame(type, collabId, sender, { text: `伪造 ${type}` }));
    assert.equal(admitted.ok, false, type);
    assert.ok(admitted.reason.includes('类型语义不符'), `${type}: ${admitted.reason}`);
  }
  for (const type of ['snapshot', 'takeover-init', 'takeover', 'handover']) {
    const admitted = await receive(service, collabFrame(type, collabId, sender, {}));
    assert.equal(admitted.ok, false, type);
    assert.ok(admitted.reason.includes('类型语义不符'), `${type}: ${admitted.reason}`);
  }
  for (const event of ['established', 'handshake', 'manager-changed', 'merge-outcome']) {
    const admitted = await receive(service, collabFrame('notice', collabId, sender, { event, version: 1 }));
    assert.equal(admitted.ok, false, `notice/${event}`);
    assert.ok(admitted.reason.includes('类型语义不符'), `notice/${event}: ${admitted.reason}`);
  }
  assert.equal(service.stats().forumTypeRejected, 14, '协作六类流 + notice 治理事件四条 + snapshot / 抢接两型 / 移交逐一计数');
  const roster = await receive(service, collabFrame('notice', collabId, sender, { event: 'roster', version: 1 }));
  assert.equal(roster.ok, true, '名单通告是讨论加入链在用的事件——照旧受理 + ack（拒收会让对端重试钉死）');
  assert.equal(service.stats().noticesIn, 1, '名单通告照旧入账（无挂表处理器，计数一条）');
  assert.equal(service.stats().topicsIn, 0, '主题未被域外帧改写');
  assert.equal(service.stats().progressIn, 0, '看板未被域外帧追加');
  const after = loadLedger(made.dir, collabId).ledger;
  assert.deepEqual(after, before, '拒绝路径零台账变更（主题 / 版本 / 看板全部不动）');
  assert.equal(after.topic, '议题');
  assert.equal(after.board.length, 0);
  assert.equal(made.sent.length, sentBefore, '拒绝路径零出站（不转达、不推送快照）');
  assert.equal(service.list().collabs[0].state, 'proposed', '讨论状态不变');
});

test('入站类型白名单（成员侧）：受邀记录收同类型同样拒绝并计数', async (t) => {
  const { service } = makeService(t);
  await receive(service, inviteFrame({ collabId: 'collab-f-type', mode: 'forum' }));
  for (const type of ['topic', 'task', 'progress', 'issue', 'stop', 'reply']) {
    const refused = await receive(service, collabFrame(type, 'collab-f-type', peer('inst-a', '主机甲'), { text: 'x' }));
    assert.equal(refused.ok, false, type);
  }
  assert.equal(service.stats().forumTypeRejected, 6);
  const roster = await receive(service, collabFrame('notice', 'collab-f-type', peer('inst-a', '主机甲'), { event: 'roster', version: 1 }));
  assert.equal(roster.ok, true, '名单通告到成员侧照旧受理（加入链在用）');
  assert.equal(service.stats().forumTypeRejected, 6, '名单通告不计入拒绝');
  assert.equal(service.list().collabs[0].state, 'proposed');
});

test('入站类型白名单（managed 对称回归）：协作六类流在 managed 实例照旧受理并联动台账', async (t) => {
  const made = makeService(t);
  const managedId = 'collab-managed';
  seededManagedCollab(made.dir, { collabId: managedId, name: '协作甲', topic: '主题' });
  const service = reloadService(made);
  const sender = peer('inst-b', '主机乙');
  const topicIn = await receive(service, collabFrame('topic', managedId, sender, { text: '新主题' }));
  assert.equal(topicIn.ok, true, topicIn.reason);
  const progressIn = await receive(service, collabFrame('progress', managedId, sender, { text: '进度一条' }));
  assert.equal(progressIn.ok, true, progressIn.reason);
  assert.equal(service.stats().forumTypeRejected, 0);
  assert.equal(loadLedger(made.dir, managedId).ledger.topic, '新主题', 'managed 照旧受理并联动台账');
  assert.equal(loadLedger(made.dir, managedId).ledger.board.length, 1);
});

test('入站类型白名单：邀请家族（approve / decline / withdraw）到讨论照常受理并计数（拒的不是它）', { skip: '夹具依赖已退役的机器级邀请/全票建立流程（0.2.0 由 M4 两段式入席取代；新流程覆盖见 test/collab-invites.test.js 与 test/collab-service-seats.test.js）——迁移到新夹具归 M9' }, async (t) => {
  const { service } = makeService(t);
  const collabId = createForum(service, { targets: [targetOf('b'), targetOf('c')] });
  const approved = await receive(service, collabFrame('approve', collabId, peer('inst-b', '主机乙'), {}));
  assert.equal(approved.ok, true, approved.reason);
  assert.equal(service.stats().approvalsIn, 1);
  const declined = await receive(service, collabFrame('decline', collabId, peer('inst-c', '主机丙'), {}));
  assert.equal(declined.ok, true, declined.reason);
  assert.equal(service.stats().declinesIn, 1);
  assert.equal(service.stats().forumTypeRejected, 0, '邀请家族不被类型白名单误伤');

  const memberSide = makeService(t);
  await receive(memberSide.service, inviteFrame({ collabId: 'collab-f-wd', mode: 'forum' }));
  const withdrawn = await receive(memberSide.service, collabFrame('withdraw', 'collab-f-wd', peer('inst-a', '主机甲'), {}));
  assert.equal(withdrawn.ok, true, withdrawn.reason);
  assert.equal(memberSide.service.stats().withdrawn, 1);
  assert.equal(memberSide.service.list().collabs[0].decision, 'withdrawn');
  assert.equal(memberSide.service.stats().forumTypeRejected, 0);
});

test('冲突隔离①：managed 检出（邀请到达 / 建立前复检）不命中同名讨论', async (t) => {
  const { service } = makeService(t);
  createForum(service);
  const incoming = inviteFrame({ collabId: 'collab-m', name: '讨论甲', manager: peer('inst-d', '主机丁'), members: [peer('inst-d', '主机丁'), peer('inst-self', '本机', 17321)] });
  const admitted = await receive(service, incoming);
  assert.equal(admitted.ok, true);
  const forumEntry = service.list().collabs.find((entry) => entry.mode === 'forum');
  assert.equal(forumEntry.state, 'proposed', '同名 managed 邀请到达：讨论不被连带冻结');
  const managedEntry = service.list().collabs.find((entry) => entry.collabId === 'collab-m');
  assert.equal(managedEntry.state, 'proposed', '新到 managed 邀请不因同名讨论被检出冻结');
  assert.equal(service.stats().freezeDetected, 0);
});

test('冲突隔离②：讨论创建与讨论邀请跳过冲突检测（同名 managed 在场）', async (t) => {
  const { service } = makeService(t);
  const managed = service.create({ name: '讨论甲', topic: '主题', targets: [targetOf('b')] });
  assert.equal(managed.ok, true);
  const forumId = service.create({ name: '讨论甲', topic: '议题', targets: [targetOf('c')], mode: 'forum' });
  assert.equal(forumId.ok, true, '同名 managed 在场：讨论创建不拒绝、不触发冻结');
  assert.equal(service.stats().freezeDetected, 0);

  const member = makeService(t);
  await receive(member.service, inviteFrame({ collabId: 'collab-m9', name: '讨论甲' }));
  const forumAdmitted = await receive(member.service, inviteFrame({ collabId: 'collab-f9', name: '讨论甲', mode: 'forum' }));
  assert.equal(forumAdmitted.ok, true);
  const states = Object.fromEntries(member.service.list().collabs.map((entry) => [entry.collabId, entry.state]));
  assert.equal(states['collab-f9'], 'proposed', '讨论邀请到达不触发冲突冻结');
  assert.equal(states['collab-m9'], 'proposed', '既有同名 managed 记录不被讨论邀请连带冻结');
  assert.equal(member.service.stats().freezeDetected, 0);

  const reverse = makeService(t);
  const forum = reverse.service.create({ name: '讨论甲', topic: '议题', targets: [targetOf('b')], mode: 'forum' });
  assert.equal(forum.ok, true);
  const managedAfter = reverse.service.create({ name: '讨论甲', topic: '主题', targets: [targetOf('c')] });
  assert.equal(managedAfter.ok, true, '讨论不参与匹配：不阻挠同名 managed 创建（任何方向）');
});

test('冲突隔离③：建立前复检不命中同名讨论（managed 正常建立、讨论不被连带冻结）', { skip: '夹具依赖已退役的机器级邀请/全票建立流程（0.2.0 由 M4 两段式入席取代；新流程覆盖见 test/collab-invites.test.js 与 test/collab-service-seats.test.js）——迁移到新夹具归 M9' }, async (t) => {
  const made = makeService(t);
  const forumId = createForum(made.service);
  const managed = made.service.create({ name: '讨论甲', topic: '主题', targets: [targetOf('b'), targetOf('c')] });
  assert.equal(managed.ok, true);
  await receive(made.service, collabFrame('approve', managed.collabId, peer('inst-b', '主机乙'), {}));
  await receive(made.service, collabFrame('approve', managed.collabId, peer('inst-c', '主机丙'), {}));
  const states = Object.fromEntries(made.service.list().collabs.map((entry) => [entry.collabId, entry.state]));
  assert.equal(states[managed.collabId], 'active', '同名讨论在场不阻挠 managed 建立');
  assert.equal(states[forumId], 'proposed', '讨论不被建立前复检连带冻结');
  assert.equal(made.service.stats().freezeDetected, 0);
});

test('载入兼容：缺 mode 的旧成员记录 / 旧台账 / 旧邀请一律按 managed 解释', async (t) => {
  const made = makeService(t);
  const collabId = 'collab-legacy-mode';
  seededManagedCollab(made.dir, { collabId, name: '协作甲', topic: '主题' });
  /* 旧数据回放：把落盘记录与台账行里的 mode 剥掉（模拟旧版写出），重载后语义应为 managed。 */
  const memberPath = collabFilePath(made.dir, collabId, MEMBER_FILE_NAME);
  writeFileSync(memberPath, JSON.stringify({
    collabId,
    name: '协作甲',
    role: 'manager',
    state: 'proposed',
    manager: { instanceId: 'inst-self', identityName: '本机' },
    endpoints: {},
    roster: [{ instanceId: 'inst-self', identityName: '本机' }],
    decision: null,
  }));
  const ledgerPath = collabFilePath(made.dir, collabId, LEDGER_FILE_NAME);
  const legacyLedger = loadLedger(made.dir, collabId).ledger;
  delete legacyLedger.mode;
  writeFileSync(ledgerPath, `${JSON.stringify(legacyLedger)}\n`);
  const reloaded = reloadService(made);
  assert.equal(reloaded.list().collabs[0].mode, 'managed', '缺 mode 的旧记录按 managed 解释');
  assert.equal(reloaded.count(), 1, '载入兼容不丢记录');

  const memberSide = makeService(t);
  await receive(memberSide.service, inviteFrame({ collabId: 'collab-old' }));
  assert.equal(memberSide.service.list().collabs[0].mode, 'managed', '旧版邀请（无 mode 字段）→ managed');
  await receive(memberSide.service, inviteFrame({ collabId: 'collab-new', mode: 'forum' }));
  assert.equal(memberSide.service.list().collabs.find((entry) => entry.collabId === 'collab-new').mode, 'forum');
});

test('ws_invite：向既有讨论发邀请帧（模式随载荷、名单为席位条目、目标机走 targets、重复邀请幂等、不改本地成员表）', async (t) => {
  const { service, sent } = makeService(t);
  const collabId = createForum(service);
  await receiveJoin(service, collabId, peer('inst-b', '主机b'));
  sent.length = 0;
  const target = targetOf('c');
  const result = await service.invite({ collabId, targets: [target] });
  assert.equal(result.ok, true);
  const invites = sentOf(sent, 'invite', collabId);
  assert.equal(invites.length, 1);
  assert.equal(invites[0].to.instanceId, 'inst-c');
  assert.equal(invites[0].payload.mode, 'forum');
  assert.equal(invites[0].payload.name, '讨论甲');
  assert.equal(invites[0].payload.topic, '议题');
  assert.deepEqual(invites[0].payload.members, [
    { instanceId: 'inst-b', sessionId: 'sess-inst-b', identityName: '主机b' },
    { instanceId: 'inst-self', sessionId: 'sess-self', identityName: '本机' },
  ], '名单 = 已加入席位的协议条目（instanceId + sessionId + identityName）');
  assert.deepEqual(invites[0].payload.targets, [{ instanceId: 'inst-c' }], '被邀目标机只走 targets，不混入名单');
  assert.equal(invites[0].payload.endpoints['inst-b'].port, 17321, '讨论邀请随带端点表（被邀者据此取得寻址信息）');
  const again = await service.invite({ collabId, targets: [target] });
  assert.equal(again.ok, true, '重复邀请幂等（重发帧、不报错）');
  const second = sentOf(sent, 'invite', collabId)[1];
  assert.deepEqual(second.payload.members, invites[0].payload.members, '名单不因邀请目标增长（席位键去重）');
  assert.deepEqual(second.payload.targets, [{ instanceId: 'inst-c' }], '重复邀请同样只描述目标机');
  const entry = service.list().collabs[0];
  assert.equal(entry.memberCount, 2, '邀请动作不改本地成员表（成员关系由加入事件推进）');
  assert.equal(entry.mode, 'forum', '模式创建时定死、不可变');
});

test('ws_invite（managed）：站长可邀请新机器加入既有协作——登记受邀行＋发帧（载荷含目标、可指名）', { skip: '夹具依赖已退役的机器级邀请/全票建立流程（0.2.0 由 M4 两段式入席取代；新流程覆盖见 test/collab-invites.test.js 与 test/collab-service-seats.test.js）——迁移到新夹具归 M9' }, async (t) => {
  const { service, sent, dir } = makeService(t);
  const created = service.create({ name: '协作甲', topic: '主题', targets: [targetOf('b')] });
  assert.equal(created.ok, true, created.message);
  sent.length = 0;
  const target = { ...targetOf('c'), targetSessionId: 'c0ffee12' };
  const result = await service.invite({ collabId: created.collabId, targets: [target] });
  assert.equal(result.ok, true, result.message);
  const invites = sentOf(sent, 'invite', created.collabId);
  assert.equal(invites.length, 1);
  assert.equal(invites[0].to.instanceId, 'inst-c');
  assert.equal(invites[0].payload.mode, 'managed');
  assert.equal(invites[0].payload.targetSessionId, 'c0ffee12', '指名会话随载荷下发');
  assert.ok(invites[0].payload.members.some((entry) => entry.instanceId === 'inst-c'), '载荷名单含被邀者（准入判据）');
  const row = loadLedger(dir, created.collabId).ledger.members.find((entry) => entry.instanceId === 'inst-c');
  assert.equal(row.state, 'invited', '受邀行先登记（回应守卫要求 invited）');
  assert.equal(row.role, 'member');
});

test('ws_invite（managed）：非站长拒绝——成员会话请让目标走 ws_join', async (t) => {
  const { service } = makeService(t);
  await receive(service, inviteFrame({ collabId: 'collab-member' }));
  assert.equal((await approveInviteWithConsentOf(service, 'collab-member', SELF_SEAT)).decision, 'approved', '夹具前置：本机已同意');
  const result = await service.invite({ collabId: 'collab-member', targets: [targetOf('c')] });
  assert.equal(result.ok, false);
  assert.match(result.message, /只有站长/);
});

test('ws_invite（managed）：目标已在有效名单内 → 拒绝（新会话走 ws_join）', { skip: '夹具依赖已退役的机器级邀请/全票建立流程（0.2.0 由 M4 两段式入席取代；新流程覆盖见 test/collab-invites.test.js 与 test/collab-service-seats.test.js）——迁移到新夹具归 M9' }, async (t) => {
  const { service } = makeService(t);
  const created = service.create({ name: '协作乙', topic: '主题', targets: [targetOf('c')] });
  const result = await service.invite({ collabId: created.collabId, targets: [targetOf('c')] });
  assert.equal(result.ok, false);
  assert.match(result.message, /已在协作名单内/);
  assert.match(result.message, /ws_join/);
});

test('ws_invite（managed）：终局行重邀翻回 invited（declined → invited）', { skip: '夹具依赖已退役的机器级邀请/全票建立流程（0.2.0 由 M4 两段式入席取代；新流程覆盖见 test/collab-invites.test.js 与 test/collab-service-seats.test.js）——迁移到新夹具归 M9' }, async (t) => {
  const { service, dir } = makeService(t);
  const created = service.create({ name: '协作丙', topic: '主题', targets: [targetOf('c')] });
  await receive(service, collabFrame('decline', created.collabId, peer('inst-c', '主机c'), {}), '127.0.0.3');
  const declined = loadLedger(dir, created.collabId).ledger.members.find((entry) => entry.instanceId === 'inst-c');
  assert.equal(declined.state, 'declined', '先落终局行');
  const result = await service.invite({ collabId: created.collabId, targets: [targetOf('c')] });
  assert.equal(result.ok, true, result.message);
  const revived = loadLedger(dir, created.collabId).ledger.members.find((entry) => entry.instanceId === 'inst-c');
  assert.equal(revived.state, 'invited', '终局行重邀翻回 invited');
});

test('ws_invite：16 软约束（邀请侧，数据源=折叠成员表）——16 人拒新邀请；被拒者不占名额', async (t) => {
  /* 数据源勘正（T1 Info4 / T2 审查 Info-6）：名额 = 按事件折叠的成员表（join 者才占位），
   * 创建名单/受邀未加入者/被拒者都不占（旧名单口径下被拒者永久占名额——本用例旧口径必红）。 */
  const { service } = makeService(t);
  const fifteen = Array.from({ length: 15 }, (_, index) => targetOf(`t${index}`));
  const collabId = createForum(service, { targets: fifteen });
  for (const target of fifteen) {
    await receiveJoin(service, collabId, peer(target.instanceId, target.identityName));
  }
  assert.equal(service.list().collabs[0].memberCount, 16, '折叠成员表 16 人（发起人 + 15 名已加入者）');
  const invited = await service.invite({ collabId, targets: [targetOf('x')] });
  assert.equal(invited.ok, false);
  assert.ok(invited.message.includes('上限'), invited.message);

  const roomy = makeService(t);
  const roomyId = createForum(roomy.service, { targets: fifteen });
  for (const target of fifteen.slice(0, 14)) {
    await receiveJoin(roomy.service, roomyId, peer(target.instanceId, target.identityName));
  }
  assert.equal(roomy.service.list().collabs[0].memberCount, 15);
  assert.equal((await roomy.service.invite({ collabId: roomyId, targets: [targetOf('x')] })).ok, true, '15 人成员表仍可邀请');
  await receive(roomy.service, collabFrame('decline', roomyId, peer(fifteen[14].instanceId, fifteen[14].identityName), {}));
  assert.equal(roomy.service.list().collabs[0].memberCount, 15, '被拒者不占名额（旧名单口径此处为 16）');
  assert.equal((await roomy.service.invite({ collabId: roomyId, targets: [targetOf('y')] })).ok, true, '被拒者不占名额后仍可邀请');

  /* 合并不设限：16 人表上第 17 个 join 事件照并入（上限是邀请侧软约束、不是合并侧闸门——并发补位可暂到 17）。 */
  const capped = makeService(t);
  const cappedId = createForum(capped.service, { targets: fifteen });
  for (const target of fifteen) {
    await receiveJoin(capped.service, cappedId, peer(target.instanceId, target.identityName));
  }
  assert.equal(capped.service.list().collabs[0].memberCount, 16);
  const extra = await receiveJoin(capped.service, cappedId, peer('inst-x', '主机X'));
  assert.equal(extra.admitted.ok, true, '第 17 个 join 照受理（软约束不设合并闸门）');
  assert.equal(capped.service.list().collabs[0].memberCount, 17, '并发补位暂 17 允许（设计 §9 已披露边界）');
});

test('ws_invite：未知 / 归档 / 未加入 / 目标形态一律明确拒绝并指引；managed 走站长增员', async (t) => {
  const { service } = makeService(t);
  const managed = service.create({ name: '协作甲', topic: '主题', targets: [targetOf('b')] });
  const onManaged = await service.invite({ collabId: managed.collabId, targets: [targetOf('c')] });
  assert.equal(onManaged.ok, true, 'managed 既有协作：站长可邀请新机器（2026-10-19 开放增员）');
  const unknown = await service.invite({ collabId: 'collab-none', targets: [targetOf('c')] });
  assert.equal(unknown.ok, false);
  assert.ok(unknown.message.includes('没有该协作或讨论'), unknown.message);

  const collabId = createForum(service);
  const badTargets = await service.invite({ collabId, targets: [] });
  assert.equal(badTargets.ok, false);
  assert.ok(badTargets.message.includes('目标'));
  await service.withdraw({ collabId });
  const archived = await service.invite({ collabId, targets: [targetOf('c')] });
  assert.equal(archived.ok, false);
  assert.ok(archived.message.includes('不再受理'), archived.message);

  const memberSide = makeService(t);
  await receive(memberSide.service, inviteFrame({ collabId: 'collab-f8', mode: 'forum' }));
  const onMember = await memberSide.service.invite({ collabId: 'collab-f8', targets: [targetOf('c')] });
  assert.equal(onMember.ok, false, '受邀未加入者不可邀请（加入为成员后才能邀请）');
  assert.ok(onMember.message.includes('尚未加入'), onMember.message);
});

test('讨论成员侧邀请链：任何成员可邀请——同意加入后由本地记录构造邀请帧（T1 交接闭合）', async (t) => {
  const memberSide = makeService(t);
  await receive(memberSide.service, inviteFrame({ collabId: 'collab-f8', mode: 'forum' }));
  const approved = await approveInviteWithConsentOf(memberSide.service, 'collab-f8', SELF_SEAT);
  assert.equal(approved.ok, true, approved.message);
  assert.equal(approved.joined, true, '讨论同意即加入（join 生效不依赖邀请者）');
  assert.equal(memberSide.service.list().collabs[0].state, 'active', '本地转进行中');
  const onMember = await memberSide.service.invite({ collabId: 'collab-f8', targets: [targetOf('c')] });
  assert.equal(onMember.ok, true, onMember.message);
  const invite = sentOf(memberSide.sent, 'invite', 'collab-f8')[0];
  assert.equal(invite.payload.mode, 'forum');
  assert.equal(invite.payload.name, '联调项目', '名取本地记录');
  assert.equal(invite.payload.topic, '发布联调', '主题取本地记录（邀请载荷定格——T1 缺口闭合）');
  assert.deepEqual(invite.payload.members, [
    { instanceId: 'inst-self', sessionId: SELF_SEAT, identityName: '本机' },
  ], '名单 = 已入席的本机席位条目（目标机不混入）');
  assert.deepEqual(invite.payload.targets, [{ instanceId: 'inst-c' }], '被邀目标机只走 targets');
  assert.equal(memberSide.service.stats().forumJoinsOut, 1, '同意后自播 join');
  const joinFrames = sentOf(memberSide.sent, 'join', 'collab-f8');
  assert.ok(joinFrames.length >= 1, 'join 自播发出');
  assert.equal(typeof joinFrames[0].payload.eventId, 'string');
  const approveFrames = sentOf(memberSide.sent, 'approve', 'collab-f8');
  assert.equal(approveFrames.length, 1, 'approve 回执仍发回邀请者（簿记，不构成生效条件）');
});

/* —— 主动加入（设计 §5.6）：成员侧敲门命中处理（collab.joinKnock = 发现层注入面）—— */

function joinKnockOf(name, { instanceId = 'inst-x', identityName = '主机X', address = '127.0.0.2', port = 17321 } = {}) {
  return { instanceId, identityName, address, port, knockId: 'knock-1', name };
}

test('主动加入：敲门命中本机讨论 → 应答载荷（collabId / 主题 / 成员数 / 发起人）+ 本机一行放行提示', (t) => {
  const { service, notices } = makeService(t);
  const collabId = createForum(service, { name: '讨论甲' });
  const replies = service.joinKnock(joinKnockOf('讨论甲'));
  assert.deepEqual(replies, [{
    collabId,
    name: '讨论甲',
    topic: '议题',
    memberCount: 1,
    originator: { instanceId: 'inst-self', identityName: '本机' },
  }], '发起人本机即中继：应答的发起人标识 = 本机');
  assert.equal(service.stats().joinKnockMatches, 1);
  assert.equal(service.stats().joinKnockAckSkipped, 0);
  assert.equal(notices.length, 1, '命中一次提示一行');
  const notice = notices[0];
  assert.equal(notice.type, 'notice');
  assert.equal(notice.collabId, collabId, '提示挂在命中的讨论上（渲染时取讨论名做头行）');
  assert.equal(notice.payload.event, 'local-alert');
  assert.ok(notice.payload.text.includes('主机X'), '提示含申请人身份名');
  assert.ok(notice.payload.text.includes('inst-x'), '提示含申请人实例标识');
  assert.ok(notice.payload.text.includes('127.0.0.2:17321'), '提示含来源端点（放行时作 ws_invite 目标）');
  assert.ok(notice.payload.text.includes('讨论甲'), '提示含讨论名');
  assert.ok(notice.payload.text.includes('ws_invite'), '提示给出放行动作（本机人执行）');
});

test('主动加入：静音不抑制放行提示（提示属待办类、不经内容栅栏；应答为成员自动行为）', async (t) => {
  const { service, notices } = makeService(t);
  const collabId = createForum(service, { name: '讨论甲' });
  const muted = await service.setMute({ collabId, sessionId: SELF_SEAT, muted: true });
  assert.equal(muted.ok, true);
  assert.deepEqual(service.hooks.sessionGate({ type: 'post', collabId }), { suppress: true }, '静音确已生效：实时帖被内容栅栏抑制');
  const replies = service.joinKnock(joinKnockOf('讨论甲'));
  assert.equal(replies.length, 1, '静音不影响应答（放行链不因本机静音而断）');
  assert.equal(notices.length, 1, '放行提示照常注入（静音不抑）');
});

test('主动加入：非命中矩阵（异名 / 协作实例同名 / 已归档 / 受邀未加入）→ 零应答零提示', async (t) => {
  const made = makeService(t);
  const forumId = createForum(made.service, { name: '讨论甲' });
  const managed = made.service.create({ name: '同名协作', topic: '主题', targets: [targetOf('b')] });
  assert.equal(managed.ok, true);
  assert.deepEqual(made.service.joinKnock(joinKnockOf('另一个讨论')), [], '异名不命中');
  assert.deepEqual(made.service.joinKnock(joinKnockOf('同名协作')), [], 'managed 实例同名也不命中（主动加入是讨论模式的能力）');
  assert.equal((await made.service.withdraw({ collabId: forumId })).ok, true);
  assert.deepEqual(made.service.joinKnock(joinKnockOf('讨论甲')), [], '已终止（归档）的讨论不再应答纳新');
  assert.equal(made.notices.length, 0);

  const invitedOnly = makeService(t);
  await receive(invitedOnly.service, inviteFrame({ collabId: 'collab-f-knock', mode: 'forum', name: '讨论甲' }));
  assert.deepEqual(invitedOnly.service.joinKnock(joinKnockOf('讨论甲')), [], '受邀未同意者尚非成员、无权放行');
  assert.equal(invitedOnly.notices.length, 0);
});

test('主动加入：成员侧命中（已加入、发起人已知）→ 应答取本地元数据；发起人未知 → 提示照发、不代发残缺应答', async (t) => {
  const memberSide = makeService(t);
  const frame = inviteFrame({ collabId: 'collab-f-knock', mode: 'forum', name: '讨论甲' });
  frame.payload.originator = { instanceId: 'inst-a', identityName: '主机甲' };
  await receive(memberSide.service, frame);
  const joined = await approveInviteWithConsentOf(memberSide.service, 'collab-f-knock', SELF_SEAT);
  assert.equal(joined.ok, true);
  assert.equal(joined.joined, true, '讨论同意即入席（join 链路）');
  const replies = memberSide.service.joinKnock(joinKnockOf('讨论甲'));
  assert.deepEqual(replies, [{
    collabId: 'collab-f-knock',
    name: '讨论甲',
    topic: '发布联调',
    memberCount: 1,
    originator: { instanceId: 'inst-a', identityName: '主机甲' },
  }], '成员侧应答取本地记录（主题随邀请载荷学得；成员数 = 折叠成员表）');
  assert.equal(memberSide.notices.length, 1);

  const noOriginator = makeService(t);
  await receive(noOriginator.service, inviteFrame({ collabId: 'collab-f-knock', mode: 'forum', name: '讨论甲' }));
  assert.equal((await approveInviteWithConsentOf(noOriginator.service, 'collab-f-knock', SELF_SEAT)).joined, true, '讨论同意即入席（join 链路）');
  assert.deepEqual(noOriginator.service.joinKnock(joinKnockOf('讨论甲')), [], '发起人标识未知：不代发残缺应答');
  assert.equal(noOriginator.service.stats().joinKnockAckSkipped, 1, '跳过一份计数留痕');
  assert.equal(noOriginator.notices.length, 1, '提示照发（放行路径不依赖应答内容）');
});

test('主动加入：同名多讨论 → 各实例各自应答、逐一提示（跨模式同名 = 不同实例）', (t) => {
  const { service, notices } = makeService(t);
  const first = createForum(service, { name: '讨论甲' });
  const second = createForum(service, { name: '讨论甲' });
  const replies = service.joinKnock(joinKnockOf('讨论甲'));
  assert.equal(replies.length, 2);
  assert.deepEqual(replies.map((reply) => reply.collabId).sort(), [first, second].sort());
  assert.equal(service.stats().joinKnockMatches, 2);
  assert.equal(notices.length, 2, '同一敲门在两实例各提示一行（放行按 collabId 执行）');
});

test('同机敲门放行指引不指名：指引只给身份与端点，放行走未指名邀请由同意门定夺', async (t) => {
  const knocker = 'sess-knock-b';
  const made = makeService(t, {
    requestJoin: async ({ name }) => {
      /* 直接调用 joinKnock 的合成路径：发现层会丢弃本机自答，这里绕过发现层，只用确定性输入
       * 验证放行指引与同意门守卫（不是真实 UDP 回环的复刻）。 */
      made.service.joinKnock({
        instanceId: 'inst-self', identityName: '本机', address: '127.0.0.1', port: 17321, knockId: 'knock-n4', name,
      });
      return { ok: true, replies: [] };
    },
  });
  const collabId = createForum(made.service, { name: '讨论甲' });
  const knocked = await made.service.join.request({ collabId, sessionId: knocker });
  assert.equal(knocked.ok, true, knocked.message);
  assert.equal(knocked.knocked, true);
  const notice = made.notices.find((frame) => frame.payload?.event === 'local-alert');
  assert.ok(notice !== undefined, '敲门命中发出放行指引');
  assert.ok(notice.payload.text.includes('inst-self'), '指引带申请人身份（身份仍由敲门报文提供）');
  assert.ok(!notice.payload.text.includes('targetSessionId'), '指引不再给出指名参数——放行按未指名邀请');
});

test('同机双会话（N-4）：未指名邀请被其他会话接受时不得替敲门者建席', async (t) => {
  const collabId = 'collab-n4';
  const knocker = 'sess-knock-b';
  const other = 'sess-knock-c';
  const made = makeService(t, {
    requestJoin: async () => ({ ok: true, replies: [] }),
    bindings: new Map(),
  });
  const knocked = await made.service.join.request({ name: '讨论甲', sessionId: knocker });
  assert.equal(knocked.ok, true, knocked.message);
  assert.equal(knocked.knocked, true, '敲门登记在册');

  const unnamed = inviteFrame({ collabId, name: '讨论甲', mode: 'forum', members: [peer('inst-a', '主机甲'), peer('inst-self', '本机', 17321)] });
  unnamed.payload.endpoints = { 'inst-a': { address: '127.0.0.1', port: 17321 } };
  assert.equal((await receive(made.service, unnamed)).ok, true);
  const joined = await approveInviteWithConsentOf(made.service, collabId, other);
  assert.equal(joined.ok, true, joined.message);
  assert.equal(joined.joined, true, '接受未指名邀请的是 C 自己');
  await new Promise((resolve) => setTimeout(resolve, 20));   // settleKnockedSession 的让位宏任务
  assert.equal(made.service.localSeatOf(collabId, knocker), null, '未同意的敲门者不得被建席');
  assert.equal(
    memberEventsOf(made.dir, collabId).some((event) => event.kind === 'join' && event.sessionId === knocker),
    false,
    '敲门者没有自己的 join 事件时不得出现在成员表',
  );
});

test('同机双会话 e2e：B 敲门 → B 自己接受未指名邀请 → B 有席位、join 事件、可发帖、对端可见', async (t) => {
  const collabId = 'collab-n4-named';
  const knocker = 'sess-knock-b';
  const made = makeService(t, {
    requestJoin: async () => ({ ok: true, replies: [] }),
  });
  const knocked = await made.service.join.request({ name: '讨论甲', sessionId: knocker });
  assert.equal(knocked.ok, true, knocked.message);
  assert.equal(knocked.knocked, true);

  const invite = inviteFrame({ collabId, name: '讨论甲', mode: 'forum', members: [peer('inst-a', '主机甲'), peer('inst-self', '本机', 17321)] });
  invite.payload.endpoints = { 'inst-a': { address: '127.0.0.1', port: 17321 } };
  assert.deepEqual(invite.payload.targets, undefined, '放行走未指名邀请（生产路径不再指名）');
  assert.equal((await receive(made.service, invite)).ok, true);
  const bJoined = await approveInviteWithConsentOf(made.service, collabId, knocker);
  assert.equal(bJoined.ok, true, bJoined.message);
  assert.equal(bJoined.joined, true);
  await waitFor(() => made.service.localSeatOf(collabId, knocker) !== null ? true : null, { timeoutMs: 2000 });
  assert.equal(made.service.localSeatOf(collabId, knocker)?.state, 'member', 'B 的席位成立');
  assert.equal(
    memberEventsOf(made.dir, collabId).some((event) => event.kind === 'join' && event.sessionId === knocker),
    true,
    'B 的席位有自己的 join 事件',
  );
  const posted = await made.service.send({ collabId, sessionId: knocker, text: 'B 的发言' });
  assert.equal(posted.ok, true, posted.message);
  assert.ok(
    made.sent.some((message) => message.type === 'join' && message.fromSessionId === knocker && message.to?.instanceId === 'inst-a'),
    'join 事件已向对端（成员机）广播——对端据此看到 B',
  );
});

test('主动加入：16 人讨论如实应答成员数（上限判定在放行/邀请步，不拒应答——16 检查点）', async (t) => {
  const { service } = makeService(t);
  const collabId = createForum(service, { name: '讨论甲' });
  for (let index = 0; index < 15; index++) {
    await receiveJoin(service, collabId, peer(`inst-j${index}`, `主机j${index}`));
  }
  const replies = service.joinKnock(joinKnockOf('讨论甲'));
  assert.equal(replies.length, 1);
  assert.equal(replies[0].memberCount, 16, '成员数如实（折叠成员表：发起人 + 15 名加入者）');
  const refused = await service.invite({ collabId, targets: [targetOf('extra')] });
  assert.equal(refused.ok, false, '16 检查点：上限判定在放行/邀请步（T3 既有面）——成员表满拒绝新邀请');
  assert.ok(refused.message.includes('上限'));
});

/* —— 讨论模式（帖通道：发帖直投、接收幂等与本地列表、显示序、本地视图）—— */

function forumPostFrame(collabId, from, { postId, postSeq, kind = 'reply', text }, ts = null) {
  const frame = collabFrame('post', collabId, from, { post: { postId, seq: postSeq, kind, text } });
  if (ts !== null) {
    frame.ts = ts;
  }
  return frame;
}

test('讨论发帖：本地先落列表（postId/序号/ts 分配即定）、除本机逐成员直投、载荷帖形态、topic 帖零元状态变化', async (t) => {
  const made = makeService(t);
  const collabId = createForum(made.service, { targets: [targetOf('b'), targetOf('c')] });
  await receiveJoin(made.service, collabId, peer('inst-b', '主机b'));
  await receiveJoin(made.service, collabId, peer('inst-c', '主机c'));
  const before = loadLedger(made.dir, collabId).ledger;
  const posted = await made.service.send({ collabId, text: '第一条议题贴', type: 'topic' });
  assert.equal(posted.ok, true, posted.message);
  assert.match(posted.postId, /^[0-9a-f-]{36}$/);
  assert.equal(posted.seq, 1);
  assert.ok(!Number.isNaN(Date.parse(posted.ts)));
  assert.deepEqual(posted.to.sort(), ['inst-b', 'inst-c']);
  assert.equal(made.direct.length, 2, '除本机外逐成员一投');
  for (const message of made.direct) {
    assert.equal(message.type, 'post');
    assert.equal(message.payload.post.postId, posted.postId);
    assert.equal(message.payload.post.seq, 1);
    assert.equal(message.payload.post.kind, 'topic');
    assert.equal(message.payload.post.text, '第一条议题贴');
    assert.equal(message.createdAt, posted.ts, '帧 ts 随帖携带（作者侧强制单调的落盘 ts）');
  }
  const view = await made.service.view({ collabId });
  assert.equal(view.ok, true);
  assert.equal(view.mode, 'forum');
  assert.equal(view.source, 'local');
  assert.ok(view.note.includes('本地视图'));
  assert.equal(view.posts.length, 1);
  const entry = view.posts[0];
  assert.equal(entry.entryId, posted.postId, '本地条目 id 取载荷 postId（原样采用、不本地重编）');
  assert.equal(entry.seq, 1);
  assert.equal(entry.ts, posted.ts);
  assert.deepEqual(entry.from, { instanceId: 'inst-self', identityName: '本机' });
  assert.equal(entry.kind, 'topic');
  assert.equal(entry.text, '第一条议题贴');
  assert.deepEqual(view.members.map((member) => member.instanceId).sort(), ['inst-b', 'inst-c', 'inst-self']);
  assert.equal(view.endpoints['inst-b'].port, 17321);
  assert.deepEqual(loadLedger(made.dir, collabId).ledger, before, 'topic 帖零元状态变化（只追加，不改任何元状态）');
  assert.equal(made.service.stats().postsSent, 1);
});

test('讨论发帖：作者序号严格递增、ts 强制单调（回拨取上一条 +1ms）', async (t) => {
  const made = makeService(t);
  const collabId = createForum(made.service);
  const first = await made.service.send({ collabId, text: '一' });
  const second = await made.service.send({ collabId, text: '二' });
  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
  assert.ok(Date.parse(second.ts) > Date.parse(first.ts), '连续发帖 ts 严格递增');
  /* 回拨注入：落盘基线带未来 ts（时钟回拨后的等价形态），重载后新帖必须严格大于基线。 */
  const futureMs = Date.now() + DAY;
  const futureTs = new Date(futureMs).toISOString();
  appendFileSync(collabFilePath(made.dir, collabId, POSTS_FILE_NAME), `${JSON.stringify({ entryId: 'post-fixture', seq: 5, ts: futureTs, from: { instanceId: 'inst-self', identityName: '本机' }, kind: 'reply', text: '未来基线的帖（夹具）' })}\n`);
  const reloaded = reloadService(made);
  const third = await reloaded.send({ collabId, text: '三' });
  assert.equal(third.seq, 6, '序号以已落列表的作者基线续增');
  assert.equal(Date.parse(third.ts), futureMs + 1, '回拨场景取 max(上一条 +1ms, now)');
});

test('讨论发帖：to 一律拒绝并提示；kind 越表 / text 越限拒绝；拒绝路径零本地变更', async (t) => {
  const made = makeService(t);
  const collabId = createForum(made.service);
  const routed = await made.service.send({ collabId, text: '定向', to: 'inst-b' });
  assert.equal(routed.ok, false);
  assert.ok(routed.message.includes('定向'), routed.message);
  const badKind = await made.service.send({ collabId, text: 'x', type: 'freeze' });
  assert.equal(badKind.ok, false);
  assert.ok(badKind.message.includes('类型'), badKind.message);
  assert.equal((await made.service.send({ collabId, text: 'x'.repeat(4001) })).ok, false);
  assert.equal((await made.service.send({ collabId, text: '   ' })).ok, false);
  assert.equal(made.direct.length, 0);
  assert.equal((await made.service.view({ collabId })).posts.length, 0, '拒绝路径不落帖');
  assert.equal(made.service.stats().postsSent, 0);
});

test('讨论发帖：归档后拒绝新帖（本地入口与入站两侧）', async (t) => {
  const made = makeService(t);
  const collabId = createForum(made.service);
  await made.service.withdraw({ collabId });   // 整条撤回 → 已终止
  const rejected = await made.service.send({ collabId, text: '结束后的帖' });
  assert.equal(rejected.ok, false);
  assert.ok(rejected.message.includes('不再接受'), rejected.message);
  const late = await receive(made.service, forumPostFrame(collabId, peer('inst-a', '主机甲'), { postId: 'post-late', postSeq: 1, text: 'x' }));
  assert.equal(late.ok, false);
  assert.equal(made.service.stats().lateDropped, 1);
});

test('讨论收帖：入本地列表、重复副本不重复入列；kind 越表在准入门拒绝计数；post 帧到 managed 实例拒绝计数', async (t) => {
  const made = makeService(t);
  await receive(made.service, inviteFrame({ collabId: 'collab-f1', mode: 'forum' }));
  const frame = forumPostFrame('collab-f1', peer('inst-a', '主机甲'), { postId: 'post-x', postSeq: 3, kind: 'issue', text: '甲的问题' });
  const admitted = await receive(made.service, frame);
  assert.equal(admitted.ok, true);
  const view = await made.service.view({ collabId: 'collab-f1' });
  assert.equal(view.posts.length, 1);
  assert.deepEqual(view.posts[0].from, { instanceId: 'inst-a', identityName: '主机甲' });
  assert.equal(view.posts[0].seq, 3);
  assert.equal(view.posts[0].ts, frame.ts);
  assert.equal(made.service.stats().postsIn, 1);
  const copy = await receive(made.service, { ...frame, msgId: `${frame.msgId}-copy` });
  assert.equal(copy.ok, true, '重复路径副本照常受理（msgId 不同——帖级去重由列表承担）');
  assert.equal((await made.service.view({ collabId: 'collab-f1' })).posts.length, 1);
  assert.equal(made.service.stats().postsDuplicated, 1);
  const badKind = forumPostFrame('collab-f1', peer('inst-a', '主机甲'), { postId: 'post-y', postSeq: 4, kind: '笔记', text: 'x' });
  const refused = await receive(made.service, badKind);
  assert.equal(refused.ok, false);
  assert.ok(refused.reason.includes('词表'), refused.reason);
  assert.equal(made.service.stats().postRejected, 1);

  const managed = makeService(t);
  const managedId = managed.service.create({ name: '协作甲', topic: '主题', targets: [targetOf('b')] }).collabId;
  const toManaged = forumPostFrame(managedId, peer('inst-a', '主机甲'), { postId: 'post-z', postSeq: 1, text: 'x' });
  const refusedManaged = await receive(managed.service, toManaged);
  assert.equal(refusedManaged.ok, false);
  assert.ok(refusedManaged.reason.includes('讨论'), refusedManaged.reason);
  assert.equal(managed.service.stats().postRejected, 1);
});

/* 直投虚拟线（服务级双节点夹具）：sendDirect → 组上线帧（与 dispatch.sendDirect 的帧同构）→
 * 异步投进对端接收管线（admit + consume）。入队（send）不建模——广播一跳由用例手工投递。 */
function makeDirectWire() {
  const nodes = new Map();
  const frames = [];
  let serial = 0;
  return {
    register(self, service) {
      nodes.set(self.instanceId, { self, service });
    },
    frames,
    sendDirect(instanceId) {
      return (message) => {
        const sender = nodes.get(instanceId);
        serial++;
        const frame = {
          v: 1,
          type: message.type,
          msgId: `wire-${serial}`,
          from: { instanceId: sender.self.instanceId, identityName: sender.self.identityName, port: sender.self.port },
          collabId: message.collabId,
          ts: typeof message.createdAt === 'string' ? message.createdAt : new Date().toISOString(),
          payload: message.payload,
        };
        frames.push(frame);
        const target = nodes.get(message.to.instanceId);
        if (target !== undefined) {
          Promise.resolve().then(() => receive(target.service, frame)).catch(() => {});
        }
        return { ok: true, msgId: frame.msgId };
      };
    },
  };
}

/* 广播帧（入队路径）的手工投递：一步到对端，无应答语义。 */
async function deliverBroadcast(service, message, fromSelf) {
  return receive(service, {
    v: 1,
    type: message.type,
    msgId: randomUUID(),
    from: { instanceId: fromSelf.instanceId, identityName: fromSelf.identityName, port: fromSelf.port },
    collabId: message.collabId,
    ts: new Date().toISOString(),
    payload: message.payload,
  });
}

/* 一轮对表并取本轮结论：同意即回填（加入后的驱动）可能有在途轮次——同一实例同时只跑一轮
 * （在途期间起的轮次被拒 already-running），等其收尾后重试到本轮真正跑起来。 */
async function syncWhenIdle(service, collabId) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const outcome = await service.sync({ collabId });
    if (outcome.reason !== 'already-running') {
      return outcome;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return { ok: false, reason: '在途轮次始终未收尾' };
}

test('讨论双节点并发发帖：真实 join 装配（自播 + 对表拉回）、互投收敛、重复副本无害、两端显示序一致', async (t) => {
  const wire = makeDirectWire();
  const selfA = { instanceId: 'inst-a', identityName: '主机甲', port: 17321 };
  const selfB = { instanceId: 'inst-b', identityName: '主机乙', port: 17322 };
  const madeA = makeService(t, { self: selfA, sendDirect: wire.sendDirect('inst-a') });
  wire.register(selfA, madeA.service);
  const madeB = makeService(t, { self: selfB, sendDirect: wire.sendDirect('inst-b'), syncPeerPicker: () => ['inst-a'], pullReplyTimeoutMs: 60 });
  wire.register(selfB, madeB.service);
  const collabId = createForum(madeA.service, { targets: [{ instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.2', port: 17322 }] });
  await receive(madeB.service, inviteFrame({ collabId, mode: 'forum', manager: peer('inst-a', '主机甲'), members: [peer('inst-a', '主机甲'), peer('inst-b', '主机乙', 17322)] }));
  /* B 同意即加入（自播 join）；join 是广播——手工投给 A（一跳、无应答）。席位标识取邀请名单里本机的条目（peer 派生）。 */
  const approved = await approveInviteWithConsentOf(madeB.service, collabId, 'sess-inst-b');
  assert.equal(approved.ok, true, approved.message);
  const joinMessage = sentOf(madeB.sent, 'join', collabId)[0];
  assert.ok(joinMessage !== undefined, '同意后自播 join 帧');
  await deliverBroadcast(madeA.service, joinMessage, selfB);
  assert.equal(madeA.service.list().collabs[0].state, 'active', '发起人收悉首个加入：讨论转进行中');
  /* B 的成员表经对表拉回 A 的事件集（真实拉取/应答链走直达线），同时学到 A 的端点。 */
  const synced = await syncWhenIdle(madeB.service, collabId);
  assert.equal(synced.ok, true, JSON.stringify(synced));
  assert.deepEqual((await madeB.service.view({ collabId })).members.map((entry) => entry.instanceId).sort(), ['inst-a', 'inst-b']);
  const postedA = await madeA.service.send({ collabId, text: '甲的第一帖', sessionId: SELF_SEAT });
  const postedB = await madeB.service.send({ collabId, text: '乙的第一帖', sessionId: 'sess-inst-b' });
  assert.equal(postedA.ok, true);
  assert.equal(postedB.ok, true);
  assert.equal(postedA.results[0].ok, true, 'A（发起人=中继）直接扇出经折叠成员表达 B');
  assert.equal(postedB.results[0].ok, true, 'B（成员）经中继路径投稿达 A');
  /* 重复路径副本（不同 msgId 的同帖）：去重命中不重复入列；首份由真实直投到位。 */
  const delivered = wire.frames.filter((frame) => frame.type === 'post');
  assert.equal(delivered.length, 2, '两帖各直投一份');
  for (const frame of delivered) {
    const target = frame.from.instanceId === 'inst-a' ? madeB.service : madeA.service;
    assert.equal((await receive(target, { ...frame, msgId: `${frame.msgId}-copy` })).ok, true);
  }
  const viewA = await madeA.service.view({ collabId });
  const viewB = await madeB.service.view({ collabId });
  assert.deepEqual(viewA.posts, viewB.posts, '两端对同一帖集合收敛出同一显示序');
  assert.equal(viewA.posts.length, 2);
  assert.deepEqual(viewA.posts.map((entry) => entry.from.instanceId).sort(), ['inst-a', 'inst-b']);
  assert.equal(madeA.service.stats().postsDuplicated, 1, '重复路径副本不重复入列');
  assert.equal(madeB.service.stats().postsDuplicated, 1);
  assert.equal(madeA.service.stats().postsIn, 1);
});

test('讨论视图：显示序按 ts 排序（同刻按 postId 兜底）、折叠成员表与端点齐备、标注本地视图', async (t) => {
  const made = makeService(t);
  await receive(made.service, inviteFrame({ collabId: 'collab-f4', mode: 'forum' }));
  await receiveJoin(made.service, 'collab-f4', peer('inst-a', '主机甲'));
  const lateTs = new Date(Date.now() + 2000).toISOString();
  const earlyTs = new Date().toISOString();
  await receive(made.service, forumPostFrame('collab-f4', peer('inst-a', '主机甲'), { postId: 'post-late', postSeq: 2, text: '晚的' }, lateTs));
  await receive(made.service, forumPostFrame('collab-f4', peer('inst-a', '主机甲'), { postId: 'post-early', postSeq: 1, text: '早的' }, earlyTs));
  const view = await made.service.view({ collabId: 'collab-f4' });
  assert.deepEqual(view.posts.map((entry) => entry.entryId), ['post-early', 'post-late'], '显示序按 ts 排序（与到达序无关）');
  assert.ok(view.note.includes('本地视图，未与全员核对'));
  assert.equal(view.topic, '发布联调', '主题取本地记录（成员侧经邀请/对表学习）');
  assert.deepEqual(view.members.map((member) => member.instanceId), ['inst-a'], '成员表 = 折叠成员表（本机未加入不在表内）');
  assert.equal(view.endpoints['inst-a'].address, '127.0.0.1');
  assert.equal((await made.service.send({ collabId: 'collab-f4', text: '未加入者的帖' })).ok, false, '未加入不可发帖');
});

test('讨论发帖（邀请未携发起人标识的旧形态）：中继未知 → 降级直投——端点未知成员如实标注待对表、不影响其余成员投出', async (t) => {
  const made = makeService(t);
  await receive(made.service, inviteFrame({ collabId: 'collab-f3', mode: 'forum', members: [peer('inst-a', '主机甲'), peer('inst-self', '本机', 17321), peer('inst-c', '主机丙')] }));
  assert.equal((await approveInviteWithConsentOf(made.service, 'collab-f3', SELF_SEAT)).ok, true, '成员侧同意即加入');
  /* 成员表经 join 事件并入：甲（端点可学）与丙（来源地址缺失——端点未知）。 */
  await receiveJoin(made.service, 'collab-f3', peer('inst-a', '主机甲'));
  await receiveJoin(made.service, 'collab-f3', peer('inst-c', '主机丙'), { remoteAddress: '' });
  const posted = await made.service.send({ collabId: 'collab-f3', text: '乙的帖' });
  assert.equal(posted.ok, true);
  assert.equal(posted.route, 'degraded', '中继未知（邀请未携发起人标识）→ 直投，待对表补学后自动回中继');
  const results = Object.fromEntries(posted.results.map((entry) => [entry.instanceId, entry]));
  assert.equal(results['inst-a'].ok, true);
  assert.equal(results['inst-c'].ok, false);
  assert.ok(results['inst-c'].reason.includes('待对表'), results['inst-c'].reason);
  assert.equal(made.direct.length, 1, '仅对端点已知成员直投');
  assert.equal(made.direct[0].to.instanceId, 'inst-a');
});

test('讨论发帖：直投面不可用（注入缺失）——帖仍落本机列表、计数留痕、结果逐目标如实标注', async (t) => {
  const made = makeService(t, { sendDirect: null });
  const collabId = createForum(made.service);
  await receiveJoin(made.service, collabId, peer('inst-b', '主机b'));
  const posted = await made.service.send({ collabId, text: '降级帖' });
  assert.equal(posted.ok, true, '帖的事务点在本机列表（直投尽力）');
  assert.equal(posted.results[0].ok, false);
  assert.ok(posted.results[0].reason.includes('直投面不可用'));
  assert.equal(made.service.stats().postFanoutSkipped, 1);
  assert.equal((await made.service.view({ collabId })).posts.length, 1);
});

test('讨论发帖：帖子列表落盘、重载恢复（序号续增、重复副本判定仍生效）', async (t) => {
  const made = makeService(t);
  const collabId = createForum(made.service);
  const posted = await made.service.send({ collabId, text: '第一条' });
  assert.equal(existsSync(collabFilePath(made.dir, collabId, POSTS_FILE_NAME)), true);
  const reloaded = reloadService(made);
  const view = await reloaded.view({ collabId });
  assert.equal(view.posts.length, 1);
  assert.equal(view.posts[0].entryId, posted.postId);
  const next = await reloaded.send({ collabId, text: '第二条' });
  assert.equal(next.seq, 2, '重载后序号自作者基线续增');
  await receive(reloaded, forumPostFrame(collabId, peer('inst-self', '本机', 17321), { postId: posted.postId, postSeq: 1, text: '第一条' }));
  assert.equal((await reloaded.view({ collabId })).posts.length, 2, '重载后同（作者, postId）的重复副本仍不入列');
  assert.equal(reloaded.stats().postsDuplicated, 1);
});

/* —— 0.2.0 集成修复：carrier-first / 本机投递查询接线 / 丢弃事实 / 建协闸门顺序 —— */

const SELF_NODE = { instanceId: 'inst-self', identityName: '本机', port: 17321 };

function collabDirIdsOf(dir) {
  try {
    return readdirSync(join(dir, 'collabs'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function anyCarrierUnder(dir) {
  return collabDirIdsOf(dir).some((id) => existsSync(carrierFilePath(dir, id)));
}

test('建协落盘顺序：carrier 先于目标登记/成员/台账/首邀——登记目标时 carrier 已在盘上', async (t) => {
  let dir = null;
  const carrierSeenAtRemember = [];
  const made = makeService(t, {
    knownHosts: {
      remember: () => {
        carrierSeenAtRemember.push(anyCarrierUnder(dir));
      },
    },
  });
  dir = made.dir;
  const result = await made.service.create({
    name: '载体先行',
    topic: '主题',
    targets: [{ instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.2', port: 17321 }],
    sessionId: 'sess-self',
  });
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(carrierSeenAtRemember, [true], '已知主机登记（成员/台账/首邀之前）时 carrier 必须已落盘');
  assert.equal(existsSync(carrierFilePath(dir, result.collabId)), true);
});

test('建协：carrier 写失败则整体中止——不发首邀、不落成员/台账', (t) => {
  const made = makeService(t);
  /* collabs 位置是普通文件：carrier 的目录创建必失败（创建路径的第一份写）。 */
  writeFileSync(join(made.dir, 'collabs'), 'block');
  const result = made.service.create({
    name: '载失败',
    topic: '主题',
    targets: [{ instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.2', port: 17321 }],
    sessionId: 'sess-self',
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /载体/);
  assert.deepEqual(made.sent, [], '首邀不得在 carrier 失败后发出');
  assert.equal(made.service.list().collabs.length, 0);
});

test('建协后续步骤失败：carrier 已落盘，目录重启后不得被判 legacy', async (t) => {
  let dir = null;
  let sabotaged = false;
  const made = makeService(t, {
    knownHosts: {
      remember: () => {
        if (sabotaged) {
          return;
        }
        sabotaged = true;
        /* 目标登记发生在 carrier 之后：把新协作的 seats 位置换成普通文件，模拟席位落盘失败
         * （成员/台账仍会写成功，首邀因无签发席位而停发）。 */
        const [collabId] = readdirSync(join(dir, 'collabs'));
        writeFileSync(join(collabDir(dir, collabId), 'seats'), 'block');
      },
    },
  });
  dir = made.dir;
  const created = await made.service.create({
    name: '后半失败',
    topic: '主题',
    targets: [{ instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.2', port: 17321 }],
    sessionId: 'sess-self',
  });
  assert.equal(created.ok, true, created.message);
  assert.equal(made.sent.length, 0, '创建者席位落盘失败：首邀不发');
  const reloaded = reloadService(made);
  const entry = reloaded.list().collabs.find((item) => item.collabId === created.collabId);
  assert.ok(entry, '目录仍应作为新形态协作载入');
  assert.equal(entry.legacy, undefined, 'carrier 先行：失败窗口不得把目录判成 legacy');
  assert.equal(reloaded.isWritable(created.collabId), true, '已写台账的目录不属于半写只读');
});

test('建协持久化硬前置：成员 / 台账写失败即中止——零邀请、不返回成功、目录标记恢复态', async (t) => {
  for (const fileName of [MEMBER_FILE_NAME, LEDGER_FILE_NAME]) {
    let dir = null;
    let collabId = null;
    let sabotaged = false;
    const made = makeService(t, {
      knownHosts: {
        remember: () => {
          if (sabotaged) {
            return;
          }
          sabotaged = true;
          /* 目标登记发生在 carrier 之后、成员/台账之前：把目标文件位置换成目录，模拟写盘失败。 */
          [collabId] = readdirSync(join(dir, 'collabs'));
          mkdirSync(join(collabDir(dir, collabId), fileName), { recursive: true });
        },
      },
    });
    dir = made.dir;
    const created = made.service.create({
      name: '持久化失败',
      topic: '主题',
      targets: [{ instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.2', port: 17321 }],
      sessionId: 'sess-self',
    });
    assert.equal(created.ok, false, `${fileName} 写失败必须让创建失败`);
    assert.match(created.message, fileName === LEDGER_FILE_NAME ? /台账/ : /成员/);
    assert.deepEqual(made.sent, [], `${fileName} 写失败：首邀不得发出`);
    assert.equal(made.service.list().collabs.length, 0, `${fileName} 写失败：失败目录不进入本机列表`);
    assert.equal(existsSync(collabFilePath(dir, collabId, 'recovery.json')), true, '载体保留并写恢复标记（失败可诊断）');
    const reloaded = reloadService(made);
    assert.equal(reloaded.list().collabs.some((item) => item.collabId === collabId), false, '重启后按恢复态只读，不作为协作载入');
  }
});

test('建协闸门：目标包含本机时立即拒绝，不发起自探测（误导性能力文案不得先出现）', async (t) => {
  let probes = 0;
  const made = makeService(t, {
    probeCapability: async () => {
      probes++;
      return { capability: 'unknown' };
    },
  });
  const result = await made.service.create({
    name: '自目标',
    topic: '主题',
    targets: [{ instanceId: 'inst-self', identityName: '本机', address: '127.0.0.1', port: 17321 }],
    sessionId: 'sess-self',
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /本机|重复/);
  assert.equal(probes, 0, '形态拒绝先于能力探测');
});

/* —— 本机旁路查询接线（I2）：真服务＋真 dispatch＋真 inbound 的同机双席 —— */

function seedSameMachineCollab(dir, { collabId = 'collab-same-machine', memberSeat = 'sess-local-2' } = {}) {
  seededManagedCollab(dir, {
    collabId,
    name: '同机协作',
    topic: '投递主题',
    status: 'active',
    invited: [{ instanceId: 'inst-self', sessionId: memberSeat, identityName: '本机', state: 'member', joinSeq: 2 }],
  });
  writeSeatFile(dir, collabId, memberSeat, { role: 'member', joinSeq: 2 });
  return collabId;
}

function wiredQueryConfigOf() {
  return {
    queueMaxPerCollab: 100,
    messageTtlMs: 600000,
    retryIntervalMs: 200,
    retrySlowIntervalMs: 60000,
    retryFastCount: 2,
    dispatchTickMs: 50,
    sessionSeatGraceMs: 60000,
    stagedMaxPerSeat: 100,
    stagedMaxPerCollab: 500,
  };
}

/* 真 dispatch（不入网、不 start）＋真 inbound 的查询接线：与生产 deliveryWiringOf 同一接缝。 */
function buildWiredQueries(dir) {
  const config = wiredQueryConfigOf();
  const dispatch = createDispatch({
    dataDir: dir,
    config,
    transport: { setFrameHandler: () => {}, stats: () => ({}) },
    self: SELF_NODE,
    log: quietLog(),
  });
  const inbound = createInbound({ dataDir: dir, config, self: SELF_NODE, dispatch, log: quietLog() });
  return { config, dispatch, inbound };
}

function buildWiredService(t, dir, { delivered, offline = false } = {}) {
  const wired = buildWiredQueries(dir);
  const service = createCollabService({
    dataDir: dir,
    config: wired.config,
    self: SELF_NODE,
    send: (message) => wired.dispatch.send(message),
    sendDirect: (message) => wired.dispatch.sendDirect(message),
    knownHosts: { remember: () => {} },
    deliverSeat: (frame, seat) => {
      if (offline) {
        return false;
      }
      delivered?.push({ sessionId: seat.sessionId, msgId: frame?.msgId ?? null });
      return true;
    },
    deliveryStatusOf: (msgId) => wired.dispatch.deliveryStatusOf(msgId),
    localSeatDeliveryOf: (msgId, sessionId) => wired.inbound.localSeatDeliveryOf(msgId, sessionId),
    noteLocalDelivery: (entry) => wired.inbound.noteLocalDelivery(entry),
    log: quietLog(),
    syncPeerPicker: () => [],
  });
  t.after(() => service.close());
  return { service, ...wired };
}

test('同机双席：发送省略 to → 本机旁路机器级终态与收件席明细可查；重启后收件席明细仍可查', async (t) => {
  const made = makeService(t);
  const collabId = seedSameMachineCollab(made.dir);
  const delivered = [];
  const first = buildWiredService(t, made.dir, { delivered });
  /* 先经接收核写面载入收件盒（模拟长运行核已有入站流量）：此后服务直投若绕过盒子，运行期查询就看不到。 */
  first.inbound.noteLocalDelivery({
    collabId,
    sessionId: 'sess-local-2',
    frame: { msgId: 'msg-inbox-warmup', type: 'reply', collabId, payload: { text: '预热' } },
    outcome: 'injected',
  });
  await first.service.registerBridgeEntry('sess-local-2', 'bridge-local-2');
  const sent = await first.service.send({ collabId, text: '同机双席', sessionId: 'sess-self' });
  assert.equal(sent.ok, true, sent.message);
  assert.deepEqual(delivered.map((entry) => entry.sessionId), ['sess-local-2'], '同机目标走本机旁路');
  assert.deepEqual(sent.results.map((entry) => entry.instanceId), ['inst-self']);
  assert.equal(sent.results[0].local, true);

  const row = first.service.deliveryStatusOf(sent.msgId);
  assert.equal(row?.tier, 'session', '本机旁路机器级终态立即成立');
  assert.equal(row?.toInstanceId, 'inst-self');
  assert.deepEqual(row?.toSessions, ['sess-local-2']);
  assert.equal(first.service.localSeatDeliveryOf(sent.msgId, 'sess-local-2').status, 'injected');
  const inboxBefore = first.inbound.checkInbox({ collabId, sessionId: 'sess-local-2' });
  assert.equal(inboxBefore.total, 2, '本机投递行写进已载入的收件盒：checkInbox 立即可见');
  assert.deepEqual(inboxBefore.messages.map((record) => record.msgId), ['msg-inbox-warmup', sent.msgId]);
  assert.equal(inboxBefore.messages[1].local, true);

  const restarted = buildWiredService(t, made.dir, {});
  const afterRestart = restarted.service.localSeatDeliveryOf(sent.msgId, 'sess-local-2');
  assert.equal(afterRestart.status, 'injected', '重启后按需折叠载入收件流水，收件席明细仍可查');
  assert.equal(afterRestart.collabId, collabId);
  assert.deepEqual(restarted.inbound.checkInbox({ collabId, sessionId: 'sess-local-2' }), inboxBefore,
    'checkInbox 在本机投递行上进程内与重启后逐字段一致');
  assert.throws(() => restarted.service.localSeatDeliveryOf(sent.msgId, 'bad id!'), TypeError);
});

/* —— 暂存丢弃事实（m4）：超限丢最旧 / 席位移除后仍可答「dropped」 —— */

function localContentFrame(collabId, msgId, text = '暂存') {
  return {
    v: 1,
    cap: 2,
    type: 'reply',
    msgId,
    collabId,
    from: { instanceId: 'inst-peer', sessionId: 'sess-peer', identityName: '主机乙', port: 17321 },
    ts: new Date().toISOString(),
    payload: { text },
  };
}

test('暂存超限丢弃：丢最旧并留下 dropped 事实（不再回落 unknown）', async (t) => {
  const dir = makeTempDir(t);
  const collabId = seedSameMachineCollab(dir);
  const made = makeService(t, { dataDir: dir, config: { stagedMaxPerSeat: 1, stagedMaxPerCollab: 10 }, deliverSeat: () => false });
  const firstMsg = randomUUID();
  const secondMsg = randomUUID();
  const first = await made.service.injectLocalSeat(collabId, 'sess-local-2', localContentFrame(collabId, firstMsg, '一'));
  const second = await made.service.injectLocalSeat(collabId, 'sess-local-2', localContentFrame(collabId, secondMsg, '二'));
  assert.equal(first.staged, true);
  assert.equal(second.staged, true);
  assert.deepEqual(made.service.localSeatDeliveryOf(firstMsg, 'sess-local-2'), {
    collabId, msgId: firstMsg, sessionId: 'sess-local-2', status: 'dropped', complete: true,
  });
  assert.equal(made.service.localSeatDeliveryOf(secondMsg, 'sess-local-2').status, 'staged');
});

test('席位移除丢弃暂存：该席明细转为 dropped，而非从未到达的 unknown', async (t) => {
  const dir = makeTempDir(t);
  const collabId = seedSameMachineCollab(dir);
  const made = makeService(t, { dataDir: dir, deliverSeat: () => false });
  const msgId = randomUUID();
  const injected = await made.service.injectLocalSeat(collabId, 'sess-local-2', localContentFrame(collabId, msgId));
  assert.equal(injected.staged, true);
  const left = await made.service.leave({ collabId, sessionId: 'sess-local-2' });
  assert.equal(left.ok, true, left.message);
  assert.deepEqual(made.service.localSeatDeliveryOf(msgId, 'sess-local-2'), {
    collabId, msgId, sessionId: 'sess-local-2', status: 'dropped', complete: true,
  });
});

/* —— 0.2.0 席位审查回归（I-7 / I-8 / M-2 / M-5 / I-1） —— */

function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

test('清单：重启后 invite-stub 的待回应邀请随 ws_list_collabs 暴露 inviteId', async (t) => {
  const made = makeService(t);
  const frame = inviteFrame({ collabId: 'collab-stub' });
  frame.payload.inviteId = 'inv-restart-1';
  frame.payload.targets = [{ instanceId: made.self.instanceId, targetSessionId: 'sess-offline' }];
  const admitted = await receive(made.service, frame);
  assert.equal(admitted.ok, true, JSON.stringify(admitted));
  assert.equal(readJsonFile(pendingInvitesFilePath(made.dir, 'collab-stub')).invites.length, 1);

  const reloaded = reloadService(made);
  const entry = reloaded.list({ sessionId: 'sess-offline' }).collabs.find((collab) => collab.collabId === 'collab-stub');
  assert.ok(entry !== undefined, '仅挂起邀请的目录重启后仍在清单里（不参与注册表加载）');
  assert.equal(entry.pendingInvites.length, 1);
  assert.deepEqual(entry.pendingInvites[0].inviteId, 'inv-restart-1');
  assert.equal(entry.pendingInvites[0].targetSessionId, 'sess-offline');
  assert.equal(entry.pendingInvites[0].from.instanceId, 'inst-a');
  assert.equal(entry.pendingInvites[0].state, 'open');
  assert.equal(entry.pendingInvites[0].expired, false);
  assert.equal(reloaded.list({ sessionId: 'sess-other' }).collabs.some((collab) => collab.collabId === 'collab-stub'), false, '非目标会话看不到指名邀请');
});

test('写门：内存 corrupt 标记 + 目录仍判 session-seats 时拒绝写（I-8）', async (t) => {
  const made = makeService(t);
  const created = made.service.create({ name: '损坏台账', topic: '主题', targets: [targetOf('b')] });
  assert.equal(created.ok, true, created.message);
  const collabId = created.collabId;
  const dir = collabDir(made.dir, collabId);
  /* 让台账无法重建：删掉席位与载体里的站长会话证据；台账写坏（非空 → 目录仍判半写/新形态）。 */
  rmSync(join(dir, 'seats'), { recursive: true, force: true });
  const carrier = readJsonFile(carrierFilePath(made.dir, collabId));
  delete carrier.manager;
  writeFileSync(carrierFilePath(made.dir, collabId), JSON.stringify(carrier));
  writeFileSync(collabFilePath(made.dir, collabId, LEDGER_FILE_NAME), '{broken-ledger');

  const reloaded = reloadService(made);
  assert.equal(reloaded.isWritable(collabId), false, '台账不可重建即只读（内存标记）');
  /* 重启后启动清理已把坏台账改名；重新写一个非空坏台账，让目录判档回到 session-seats。 */
  writeFileSync(collabFilePath(made.dir, collabId, LEDGER_FILE_NAME), '{broken-again');
  assert.equal(reloaded.isWritable(collabId), false, '目录回到 session-seats 也不得凭文件面放行内存只读标记');
});

test('静音：无会话标识一律拒绝，不按唯一席位兜底（M-2）', async (t) => {
  const made = makeService(t);
  const collabId = createForum(made.service);
  const noSession = await made.service.setMute({ collabId, muted: true });
  assert.equal(noSession.ok, false);
  assert.match(noSession.message, /sessionId|会话标识/);
  assert.equal(made.service.setMute({ collabId, sessionId: SELF_SEAT, muted: true }).ok, true);
});

test('邀请载体写失败：中止本地落地，不写 member.json（M-5）', async (t) => {
  const made = makeService(t);
  const collabId = 'collab-carrier-fail';
  mkdirSync(collabDir(made.dir, collabId), { recursive: true });
  /* 以目录占位 carrier.json：写载体必然失败（与磁盘满同属落点失败面）。 */
  mkdirSync(join(collabDir(made.dir, collabId), 'carrier.json'));
  const frame = inviteFrame({ collabId });
  /* 直调消费面（准入面另判目录损坏）：验证「落地失败即中止」，不再写成员记录。 */
  const consumed = await made.service.hooks.consume(frame, { remoteAddress: '127.0.0.1' });
  assert.equal(consumed.ok, false);
  assert.equal(consumed.reason, 'carrier-write-failed');
  assert.equal(existsSync(join(collabDir(made.dir, collabId), MEMBER_FILE_NAME)), false, '载体失败后不得再写成员记录（污染只读目录）');
  assert.equal(made.service.list().collabs.some((entry) => entry.collabId === collabId), false);
});

test('生命周期清扫：presence 节拍收敛过期挂起邀请与发起侧记录（I-1）', async (t) => {
  const made = makeService(t, {
    config: { inviteTtlMs: 40, seatPresenceIntervalMs: 30, managerProbeIntervalMs: 1000 },
  });
  const created = made.service.create({ name: '清扫项目', topic: '主题', targets: [targetOf('b')] });
  assert.equal(created.ok, true, created.message);
  made.service.start();
  const invited = await made.service.join.createInvite({
    collabId: created.collabId, managerSessionId: SELF_SEAT,
    targetInstanceId: made.self.instanceId, targetSessionId: 'sess-late',
  });
  assert.equal(invited.ok, true, invited.message);
  await waitFor(() => {
    const book = readJsonFile(pendingInvitesFilePath(made.dir, created.collabId));
    return book?.invites?.find((entry) => entry.inviteId === invited.inviteId)?.state === 'expired' ? true : null;
  }, { timeoutMs: 4000 });
  await waitFor(() => {
    const book = readJsonFile(invitesFilePath(made.dir, created.collabId));
    return (book?.invites ?? []).some((entry) => entry.inviteId === invited.inviteId) ? null : true;
  }, { timeoutMs: 4000 });
  made.service.close();
});

test('生命周期清扫：不在注册表的 invite-stub 目录也清理过期终态记录（I-1）', async (t) => {
  const old = makeService(t);
  const collabId = 'collab-old-terminal';
  const dir = collabDir(old.dir, collabId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(carrierFilePath(old.dir, collabId), JSON.stringify({
    format: 'invite-stub', version: 1, collabId, name: '旧邀请', topic: '主题', mode: 'managed',
    endpoints: {}, snapshotVersion: 0, createdAt: new Date().toISOString(),
  }));
  writeFileSync(pendingInvitesFilePath(old.dir, collabId), JSON.stringify({
    version: 1,
    invites: [{
      inviteId: 'inv-old', collabId, fromManager: { instanceId: 'inst-a', sessionId: 'sess-a' },
      targetSessionId: null, expiresAt: Date.now() - 2 * DAY, state: 'consumed', acceptedSessions: [],
    }],
  }));
  old.service.start();
  await waitFor(() => {
    const book = readJsonFile(pendingInvitesFilePath(old.dir, collabId));
    return (book?.invites ?? []).length === 0 ? true : null;
  }, { timeoutMs: 4000 });
  old.service.close();
});

/* —— 0.2.0 两段式重试面：站内直投帧的手工转达（不经网络层） —— */

/* 出站消息 → 完整协议帧：捕获面只有 to/fromSessionId 等投递字段，接收面需要 v/cap/from/ts。
 * 身份取发送方 self，会话取消息的签发席位——与真实出站组帧同一取数面。 */
function relayFrameOf(message, senderSelf) {
  seq++;
  const from = { ...senderSelf };
  if (typeof message.fromSessionId === 'string') {
    from.sessionId = message.fromSessionId;
  }
  return {
    v: 1,
    cap: 2,
    type: message.type,
    msgId: `relay-${seq}`,
    collabId: message.collabId,
    from,
    ts: new Date().toISOString(),
    payload: message.payload,
  };
}

function lastSentOf(list, type) {
  return list.filter((message) => message.type === type).at(-1) ?? null;
}

async function relayInto(target, message, senderSelf) {
  assert.ok(message !== null, `缺少待转达的 ${senderSelf.instanceId} 出站帧`);
  return receive(target, relayFrameOf(message, senderSelf));
}

/* 重试入席的双机夹具：站长侧在途 TTL 短（便于自然过期），受邀侧确认重发轮拉长（避免噪音帧）。 */
function resendPairOf(t) {
  const manager = makeService(t, {
    self: { instanceId: 'inst-m', identityName: '主机甲', port: 17401 },
    config: { joinConfirmTtlMs: 1000, seatPresenceIntervalMs: 20 },
  });
  const member = makeService(t, {
    self: { instanceId: 'inst-a', identityName: '应用甲', port: 17402 },
    config: { joinConfirmTtlMs: 60000 },
  });
  t.after(() => manager.service.close());
  const created = manager.service.create({
    name: '重试入席',
    topic: '主题',
    mode: 'managed',
    sessionId: 'sess-m',
    targets: [{ instanceId: 'inst-a', identityName: '应用甲', address: '127.0.0.1', port: 17402 }],
  });
  assert.equal(created.ok, true, String(created.message));
  return { manager, member, collabId: created.collabId };
}

/* 一次完整的「受邀方接受 → approve 到站长 → 站长签 grant → grant 回受邀方」，
 * 返回双方观察到的结论；confirm 是否转达由调用方决定（重试用例要模拟丢帧）。 */
async function acceptThroughGrantOf(pair, inviteId) {
  const { manager, member, collabId } = pair;
  const accepted = await member.service.join.acceptInvite({ collabId, inviteId, sessionId: 'sess-a' });
  assert.equal(accepted.ok, true, String(accepted.message));
  assert.equal((await relayInto(manager.service, lastSentOf(member.direct, 'approve'), member.self)).ok, true, 'approve 进入站长核');
  const grant = lastSentOf(manager.direct, 'join-grant');
  const admitted = await relayInto(member.service, grant, manager.self);
  assert.equal(admitted.ok, true, admitted.ok === true ? 'grant 通过受邀方准入门' : `grant 未通过受邀方准入门：${admitted.reason}`);
  return { accepted, grant };
}

test('重复接受：在途 grant 过期后站长重签 joinId，受邀方重建申请台账后准入并 confirm 入名单', async (t) => {
  const pair = resendPairOf(t);
  const { manager, member, collabId } = pair;
  const invited = await manager.service.join.createInvite({
    collabId, managerSessionId: 'sess-m', targetInstanceId: 'inst-a', targetSessionId: 'sess-a',
  });
  assert.equal(invited.ok, true, String(invited.message));
  assert.equal((await relayInto(member.service, lastSentOf(manager.direct, 'invite'), manager.self)).ok, true, '邀请进入受邀核');

  const first = await acceptThroughGrantOf(pair, invited.inviteId);
  assert.equal(lastSentOf(member.direct, 'join-confirm').payload.joinId, first.grant.payload.joinId, '受邀方对首份 grant 发 confirm');

  /* 模拟 confirm 丢失且站长不可达：丢弃 confirm，只让站长侧在途记录按 TTL 自然过期
   * （过期回执照发但不转达——不可达的语义）。 */
  manager.service.start();
  await waitFor(() => manager.service.join.pendingJoiningProjection(collabId).length === 0 ? true : null, { timeoutMs: 4000 });
  assert.equal(lastSentOf(manager.direct, 'join-deny')?.payload.joinId, first.grant.payload.joinId, '过期回执指向旧 joinId（本用例按不可达丢弃）');

  member.direct.length = 0;
  const again = await acceptThroughGrantOf(pair, invited.inviteId);
  assert.equal(again.accepted.resent, true, '未成席的重复接受重发 approve');
  assert.notEqual(again.grant.payload.joinId, first.grant.payload.joinId, '站长对仍 open 的邀请重签新 joinId');
  const confirm2 = lastSentOf(member.direct, 'join-confirm');
  assert.equal(confirm2.payload.joinId, again.grant.payload.joinId, '受邀方对新 joinId 发出 confirm');
  assert.equal((await relayInto(manager.service, confirm2, member.self)).ok, true, 'confirm 进入站长核');

  const rows = (await manager.service.view({ collabId })).ledger.members
    .filter((entry) => entry.instanceId === 'inst-a' && entry.sessionId === 'sess-a');
  assert.equal(rows.length, 1, 'confirm 后本席进入共享名单');
  const snapshot = lastSentOf(manager.direct, 'snapshot');
  assert.equal((await relayInto(member.service, snapshot, manager.self)).ok, true, '入名单后快照回到本席');
  assert.notEqual(member.service.localSeatOf(collabId, 'sess-a')?.unverified, true, '含本席快照清除未确认标记');
});

test('同机双会话（N-4）：敲门者已有自己的 join 事件时，另一点头会话可触发接线', async (t) => {
  const collabId = 'collab-n4-selfjoined';
  const knocker = 'sess-knock-b';
  const other = 'sess-knock-c';
  const bindings = new Map();
  const made = makeService(t, {
    requestJoin: async () => ({ ok: true, replies: [] }),
    bindings,
  });
  await receive(made.service, inviteFrame({
    collabId, name: '讨论甲', mode: 'forum',
    members: [peer('inst-a', '主机甲'), peer('inst-self', '本机', 17321)],
  }));
  const knocked = await made.service.join.request({ name: '讨论甲', sessionId: knocker });
  assert.equal(knocked.ok, true, knocked.message);
  assert.equal(knocked.knocked, true, '敲门登记在册');

  /* 敲门者自己的 join 事件经对表回填到达（回填合并不滤本机实例；入站 join 帧则会滤，
   * 因此这里必须走成员事件并集这条真实面）。 */
  const selfJoin = {
    eventId: randomUUID(), kind: 'join', instanceId: 'inst-self', sessionId: knocker,
    identityName: '本机', ts: new Date().toISOString(),
  };
  const bucket = await receive(made.service, collabFrame('history-bundle', collabId, peer('inst-a', '主机甲'), {
    cursor: null, more: false, posts: [], overlap: [], meta: {}, members: [selfJoin], endpoints: {},
  }));
  assert.equal(bucket.ok, true, '敲门者的历史 join 事件随对表回填落地');

  const accepted = await approveInviteWithConsentOf(made.service, collabId, other);
  assert.equal(accepted.ok, true, accepted.message);
  assert.equal(accepted.joined, true, '点头的是 C 自己');
  await waitFor(() => made.service.localSeatOf(collabId, knocker) !== null ? true : null, { timeoutMs: 2000 });
  assert.equal(made.service.localSeatOf(collabId, knocker)?.state, 'member', '敲门者已有 join 事件：接线不被幽灵席位守卫拦下');
  assert.equal(bindings.get(collabId)?.sessionId, knocker, '接线落到敲门会话');
});
