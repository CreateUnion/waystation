import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  COLLABS_DIR_NAME,
  INVITES_FILE_NAME,
  JOIN_APPLICATIONS_FILE_NAME,
  JOINS_FILE_NAME,
  PENDING_INVITES_FILE_NAME,
  collabFilePath,
  invitesFilePath,
  joinApplicationsFilePath,
  joinsFilePath,
  pendingInvitesFilePath,
  seatFilePath,
} from '../src/paths.js';
import {
  APPROVAL_ORIGINS,
  createInvitesFileStore,
  createJoinApplicationsStore,
  createJoiningFileStore,
  createJoinsStore,
  createPendingInvitesFileStore,
  isApprovalShape,
  isJoinApplicationShape,
  isJoinApplicationsShape,
  isJoiningRecordShape,
  isJoinsShape,
  isPendingJoinShape,
} from '../src/collab/joins.js';
import { LEDGER_FILE_NAME } from '../src/collab/store.js';
import { makeTempDir } from './helpers.js';

/* 会话级加入的两本台账（设计 §7）的用例面：形态谓词逐字段拒、读写往返与同会话幂等覆盖、
 * 整档坏载归空态 / 单条形态不符逐条丢弃（均留痕计数）、获准判定与移除、写 / 删失败面
 * （内存态继续、只计数告警）、按 sentAt 的过期剪除面，以及两处路径落点。 */

function makeLog() {
  const logs = [];
  return {
    logs,
    log: {
      info: () => {},
      warn: (message, fields) => logs.push({ message, fields }),
      error: (message, fields) => logs.push({ message, fields }),
    },
  };
}

/* 同时满足 v1 待批准与 v2 未确认 joining 两种形态：v1 读侧兼容与 v2 写侧共用同一夹具。 */
function pendingRecord(overrides = {}) {
  return {
    joinId: 'join-a1', instanceId: 'inst-a', identityName: '主机甲', sessionId: 'session-a1',
    managerTerm: 1, grantVersion: 1, requestedAt: 1000, expiresAt: 60000, ...overrides,
  };
}

function seatRecord(overrides = {}) {
  return {
    version: 1, sessionId: 'session-a1', role: 'member', state: 'member', muted: true,
    joinSeq: 1, joinedAt: '2026-01-01T00:00:00.000Z', ...overrides,
  };
}

/* 合法 managed 台账（只含站长一行）：用于验证「共享名单为获准权威」。 */
function managerLedger(collabId) {
  const at = '2026-01-01T00:00:00.000Z';
  return {
    version: 1,
    collabId,
    name: '项目',
    topic: '主题',
    mode: 'managed',
    status: 'active',
    managerTerm: 1,
    manager: { instanceId: 'inst-m', sessionId: 'session-m', identityName: '主机甲', term: 1 },
    joinSeqNext: 2,
    members: [{ instanceId: 'inst-m', sessionId: 'session-m', identityName: '主机甲', role: 'manager', state: 'member', joinSeq: 1, joinedAt: at }],
    board: [],
    createdAt: at,
    updatedAt: at,
  };
}

function approvalRecord(overrides = {}) {
  return { instanceId: 'inst-a', sessionId: 'session-a1', origin: 'grant', grantedAt: 2000, approvedBy: 'inst-manager', ...overrides };
}

function applicationRecord(overrides = {}) {
  return { collabId: 'collab-1', sessionId: 'session-a1', managerInstanceId: 'inst-manager', msgId: 'msg-1', sentAt: 1000, ...overrides };
}

function seedFile(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}

function backupsOf(file, marker) {
  return readdirSync(dirname(file))
    .filter((name) => name.startsWith(`${marker}-`))
    .map((name) => join(dirname(file), name));
}

/* 占位文件堵住目录创建路径（与 members / mute 同款失败面夹具）：父目录成文件即令写盘失败。 */
function blockDir(dataDir, dirName) {
  writeFileSync(join(dataDir, dirName), '占位：目录无法创建');
}

test('加入台账路径：协作目录内 joins.json、申请台账落 run/；非法 collabId 抛错', (t) => {
  const dir = makeTempDir(t);
  assert.equal(JOINS_FILE_NAME, 'joins.json');
  assert.equal(JOIN_APPLICATIONS_FILE_NAME, 'join-applications.json');
  assert.equal(joinsFilePath(dir, 'collab-1'), join(dir, COLLABS_DIR_NAME, 'collab-1', 'joins.json'));
  assert.equal(joinApplicationsFilePath(dir), join(dir, 'run', 'join-applications.json'));
  for (const bad of ['../evil', 'a/b', '', 7, null]) {
    assert.throws(() => joinsFilePath(dir, bad), /collabId 非法/);
  }
});

test('加入台账形态谓词：顶层两名单齐备、条目逐字段拒', () => {
  assert.deepEqual(APPROVAL_ORIGINS, ['create', 'invite', 'grant']);
  assert.equal(isJoinsShape({ v: 1, pendingJoins: [], approvals: [] }), true);
  assert.equal(isJoinsShape({ v: 1, pendingJoins: [] }), false, '缺名单');
  assert.equal(isJoinsShape({ v: 1, pendingJoins: {}, approvals: [] }), false, '名单非数组');
  assert.equal(isJoinsShape({ v: 2, pendingJoins: [] }), true, 'v2 只要求 pendingJoins（0.2.0 写侧形态）');
  assert.equal(isJoinsShape({ v: 3, pendingJoins: [], approvals: [] }), false, '版本不符');
  assert.equal(isJoinsShape(null), false);
  assert.equal(isJoinsShape([1]), false);
  assert.equal(isPendingJoinShape(pendingRecord()), true);
  assert.equal(isPendingJoinShape(pendingRecord({ identityName: undefined })), true, '机器名可缺省');
  assert.equal(isPendingJoinShape(pendingRecord({ sessionId: 'bad id!' })), false);
  assert.equal(isPendingJoinShape(pendingRecord({ instanceId: 7 })), false);
  assert.equal(isPendingJoinShape(pendingRecord({ identityName: '坏\n名' })), false, '机器名过身份名白名单');
  assert.equal(isPendingJoinShape(pendingRecord({ requestedAt: 1.5 })), false);
  assert.equal(isPendingJoinShape(pendingRecord({ requestedAt: '1000' })), false, '毫秒数而非 ISO 串');
  assert.equal(isPendingJoinShape(null), false);
  assert.equal(isJoiningRecordShape(pendingRecord()), true, 'v2 未确认 joining');
  assert.equal(isJoiningRecordShape(pendingRecord({ confirmed: true })), false, 'confirmed 不得落盘');
  assert.equal(isJoiningRecordShape(pendingRecord({ joinId: undefined })), false, '缺 joinId');
  assert.equal(isJoiningRecordShape(pendingRecord({ expiresAt: 500 })), false, '过期早于申请时刻');
  assert.equal(isApprovalShape(approvalRecord()), true);
  assert.equal(isApprovalShape(approvalRecord({ origin: 'join' })), false, 'origin 词表外');
  assert.equal(isApprovalShape(approvalRecord({ grantedAt: -1 })), false);
  assert.equal(isApprovalShape(approvalRecord({ approvedBy: '' })), false);
  assert.equal(isApprovalShape(approvalRecord({ approvedBy: 42 })), false);
  assert.equal(isJoinApplicationsShape({ v: 1, applications: [] }), true);
  assert.equal(isJoinApplicationsShape({ v: 1 }), false);
  assert.equal(isJoinApplicationsShape({ v: 1, applications: '名单' }), false);
  assert.equal(isJoinApplicationShape(applicationRecord()), true);
  assert.equal(isJoinApplicationShape(applicationRecord({ collabId: 'bad/id' })), false);
  assert.equal(isJoinApplicationShape(applicationRecord({ managerInstanceId: '' })), false);
  assert.equal(isJoinApplicationShape(applicationRecord({ msgId: null })), false);
  assert.equal(isJoinApplicationShape(applicationRecord({ sentAt: NaN })), false);
});

test('加入台账读写往返：写侧只产 v2（无 approvals）、重建载入、同会话幂等覆盖', (t) => {
  const dir = makeTempDir(t);
  const { log } = makeLog();
  const store = createJoinsStore({ dataDir: dir, collabId: 'collab-1', log });
  assert.deepEqual([store.pendingJoins(), store.approvals()], [[], []], '无文件即空态');
  assert.equal(store.addPendingJoin(pendingRecord()), true);
  assert.equal(store.addApproval(approvalRecord()), true);
  assert.deepEqual(store.approvals(), [approvalRecord()], '获准仅内存可见（旧读兼容）');
  const file = joinsFilePath(dir, 'collab-1');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
    v: 2,
    pendingJoins: [pendingRecord()],
  }, '落盘形态：v2 只含 pendingJoins，approvals 不写回');
  const reloaded = createJoinsStore({ dataDir: dir, collabId: 'collab-1', log });
  assert.deepEqual(reloaded.pendingJoins(), [pendingRecord()], '未确认 joining 跨重建');
  assert.deepEqual(reloaded.approvals(), [], 'approvals 不跨重启（权威是名单/席位）');
  assert.equal(reloaded.addPendingJoin(pendingRecord({ requestedAt: 3000 })), true);
  assert.deepEqual(reloaded.pendingJoins(), [pendingRecord({ requestedAt: 3000 })], '同会话重复入账只留一条（刷新）');
  assert.equal(reloaded.addApproval(approvalRecord({ origin: 'invite', grantedAt: 4000 })), true);
  assert.deepEqual(reloaded.approvals(), [approvalRecord({ origin: 'invite', grantedAt: 4000 })], '内存面可更新');
  assert.deepEqual([reloaded.stats().persists, reloaded.stats().pendingJoins, reloaded.stats().approvals], [1, 1, 1], 'persists 只属 pendingJoins（获准不写盘）');
  assert.equal(reloaded.addPendingJoin(pendingRecord({ sessionId: 'session-b2' })), true);
  assert.equal(reloaded.pendingJoins().length, 2, '异会话并列');
});

test('加入台账坏载：不可解析 / 形态不符 / 读取失败归空态并留痕；整档损坏先留 .corrupt 备份', (t) => {
  const dir = makeTempDir(t);
  seedFile(joinsFilePath(dir, 'collab-broken'), '{"v":1,');
  const broken = makeLog();
  const brokenStore = createJoinsStore({ dataDir: dir, collabId: 'collab-broken', log: broken.log });
  assert.deepEqual([brokenStore.pendingJoins(), brokenStore.approvals()], [[], []]);
  assert.equal(brokenStore.stats().corruptLoads, 1);
  assert.ok(broken.logs.some((entry) => entry.message.includes('加入台账文件不可用') && entry.fields.reason === '无法解析'), '不可解析留痕');
  const brokenBackups = backupsOf(joinsFilePath(dir, 'collab-broken'), `${JOINS_FILE_NAME}.corrupt`);
  assert.equal(brokenBackups.length, 1, '整档损坏先备份（不得静默清零后覆盖）');
  assert.equal(readFileSync(brokenBackups[0], 'utf8'), '{"v":1,', '备份保留原始字节');
  assert.equal(brokenStore.stats().corruptBackups, 1);
  assert.equal(existsSync(joinsFilePath(dir, 'collab-broken')), false, '原文件已改名留证');

  seedFile(joinsFilePath(dir, 'collab-shape'), { v: 3, pendingJoins: [], approvals: [] });
  const shaped = makeLog();
  const shapedStore = createJoinsStore({ dataDir: dir, collabId: 'collab-shape', log: shaped.log });
  assert.deepEqual(shapedStore.approvals(), [], '形态不符按空态');
  assert.ok(shaped.logs.some((entry) => entry.fields.reason === '形态不符'), '形态不符留痕');
  assert.equal(backupsOf(joinsFilePath(dir, 'collab-shape'), `${JOINS_FILE_NAME}.corrupt`).length, 1, '形态不符同样留档');

  mkdirSync(joinsFilePath(dir, 'collab-dir'), { recursive: true });
  const unreadable = makeLog();
  const dirStore = createJoinsStore({ dataDir: dir, collabId: 'collab-dir', log: unreadable.log });
  assert.deepEqual(dirStore.pendingJoins(), [], '读取失败按空态继续');
  assert.equal(dirStore.stats().corruptLoads, 1, '非 ENOENT 读故障并入损坏面');
  assert.ok(unreadable.logs.some((entry) => entry.message.includes('加入台账文件不可用')), '读取失败留痕');
  assert.equal(statSync(joinsFilePath(dir, 'collab-dir')).isDirectory(), true, '路径被目录占住时无原始字节可留，保持原样');
  assert.equal(dirStore.stats().corruptBackups, 0);
  const fresh = makeLog();
  createJoinsStore({ dataDir: makeTempDir(t), collabId: 'collab-fresh', log: fresh.log });
  assert.deepEqual(fresh.logs, [], '首次运行无文件：静默空态');
});

test('0.2.0 三本账整档损坏：先留 .corrupt-<ts> 备份，再按空态继续并可安全重写', (t) => {
  const dir = makeTempDir(t);
  const made = makeLog();
  const base = { dataDir: dir, log: made.log, now: () => 1000 };

  seedFile(invitesFilePath(dir, 'collab-inv'), '{"version":1,"invites":[');
  const invites = createInvitesFileStore({ ...base, collabId: 'collab-inv', ttlMs: 60000 });
  assert.deepEqual(invites.list(), []);
  const inviteBackups = backupsOf(invitesFilePath(dir, 'collab-inv'), `${INVITES_FILE_NAME}.corrupt`);
  assert.equal(inviteBackups.length, 1);
  assert.equal(readFileSync(inviteBackups[0], 'utf8'), '{"version":1,"invites":[');
  assert.equal(invites.save().ok, true, '备份后按空态重写不覆盖证据');
  assert.deepEqual(JSON.parse(readFileSync(invitesFilePath(dir, 'collab-inv'), 'utf8')), { version: 1, invites: [] });

  seedFile(pendingInvitesFilePath(dir, 'collab-pending'), '不是 JSON');
  const pending = createPendingInvitesFileStore({ ...base, collabId: 'collab-pending' });
  assert.deepEqual(pending.list(), []);
  const pendingBackups = backupsOf(pendingInvitesFilePath(dir, 'collab-pending'), `${PENDING_INVITES_FILE_NAME}.corrupt`);
  assert.equal(pendingBackups.length, 1);
  assert.equal(readFileSync(pendingBackups[0], 'utf8'), '不是 JSON');

  seedFile(joinsFilePath(dir, 'collab-join'), { v: 2, pendingJoins: '坏' });
  const joining = createJoiningFileStore({ ...base, collabId: 'collab-join', joiningTtlMs: 60000 });
  assert.deepEqual(joining.pendingJoins(), []);
  const joiningBackups = backupsOf(joinsFilePath(dir, 'collab-join'), `${JOINS_FILE_NAME}.corrupt`);
  assert.equal(joiningBackups.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(joiningBackups[0], 'utf8')), { v: 2, pendingJoins: '坏' });
  assert.equal(joining.stats().corruptBackups, 1);
});

test('joins.json v1 首次 v2 写：原档留为 .v1-<ts>，approvals 不静默丢失；回退旧读侧仍可恢复', (t) => {
  const dir = makeTempDir(t);
  const file = joinsFilePath(dir, 'collab-v1-upgrade');
  const original = JSON.stringify({ v: 1, pendingJoins: [], approvals: [approvalRecord()] });
  seedFile(file, original);
  const made = makeLog();
  const joining = createJoiningFileStore({ dataDir: dir, collabId: 'collab-v1-upgrade', log: made.log, joiningTtlMs: 60000 });
  assert.equal(joining.save().ok, true);
  const backups = backupsOf(file, `${JOINS_FILE_NAME}.v1`);
  assert.equal(backups.length, 1, '首次 v2 写前留档');
  assert.equal(readFileSync(backups[0], 'utf8'), original, '留档保留原始字节（含 approvals）');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { v: 2, pendingJoins: [] }, '写侧只产 v2');
  assert.equal(joining.save().ok, true);
  assert.equal(backupsOf(file, `${JOINS_FILE_NAME}.v1`).length, 1, '同一进程只留档一次');

  writeFileSync(file, readFileSync(backups[0], 'utf8'));
  assert.equal(createJoinsStore({ dataDir: dir, collabId: 'collab-v1-upgrade', log: made.log }).isGranted('session-a1'), true,
    '回退旧版：留档可还原 approvals 获准面');
});

test('加入台账坏载：单条形态不符逐条丢弃，好条目照旧载入', (t) => {
  const dir = makeTempDir(t);
  seedFile(joinsFilePath(dir, 'collab-drop'), {
    v: 1,
    pendingJoins: [pendingRecord(), pendingRecord({ sessionId: 'bad id!' }), { sessionId: 'session-c3' }],
    approvals: [approvalRecord(), approvalRecord({ origin: 'withdraw' })],
  });
  const made = makeLog();
  const store = createJoinsStore({ dataDir: dir, collabId: 'collab-drop', log: made.log });
  assert.deepEqual(store.pendingJoins(), [pendingRecord()], '坏条丢弃、好条保留');
  assert.deepEqual(store.approvals(), [approvalRecord()]);
  assert.equal(store.stats().corruptRecords, 3);
  assert.equal(store.stats().corruptLoads, 0, '整档形态成立：只丢单条，不进损坏面');
  assert.equal(made.logs.filter((entry) => entry.message.includes('加入台账条目形态不符（丢弃该条）')).length, 3);
  assert.ok(made.logs.some((entry) => entry.fields.section === '待批准'), '留痕带名单出处');
  assert.ok(made.logs.some((entry) => entry.fields.section === '获准'));
});

test('加入台账获准判定与移除：命中 / 未命中、移除即落盘、返回面与内部态脱钩', (t) => {
  const dir = makeTempDir(t);
  const { log } = makeLog();
  const store = createJoinsStore({ dataDir: dir, collabId: 'collab-grant', log });
  store.addApproval(approvalRecord({ sessionId: 'session-a1' }));
  store.addApproval(approvalRecord({ sessionId: 'session-b2', origin: 'create', approvedBy: '主机甲' }));
  assert.equal(store.isGranted('session-a1'), true);
  assert.equal(store.isGranted('session-b2'), true);
  assert.equal(store.isGranted('session-c3'), false, '未获准');
  assert.equal(store.isGranted(undefined), false);
  const view = store.approvals();
  view[0].origin = '改写尝试';
  assert.equal(store.approvals()[0].origin, 'grant', '返回面是副本');
  store.addPendingJoin(pendingRecord({ sessionId: 'session-a1' }));
  assert.equal(store.removePendingJoin('session-a1'), true);
  assert.equal(store.removePendingJoin('session-a1'), false, '重复移除如实报未命中');
  assert.equal(store.removePendingJoin(undefined), false);
  const reloaded = createJoinsStore({ dataDir: dir, collabId: 'collab-grant', log });
  assert.deepEqual(reloaded.pendingJoins(), [], '移除即时落盘');
  assert.deepEqual(reloaded.approvals(), [], '获准不落盘：重启后不回来');
});

test('加入台账拒绝面与失败面：形态不符拒入账、写 / 删失败内存态继续、clear 删文件', (t) => {
  const dir = makeTempDir(t);
  const made = makeLog();
  const store = createJoinsStore({ dataDir: dir, collabId: 'collab-refuse', log: made.log });
  assert.equal(store.addPendingJoin(pendingRecord({ sessionId: 'bad id!' })), false);
  assert.equal(store.addApproval(null), false);
  assert.equal(store.addApproval(approvalRecord({ origin: 'nope' })), false);
  assert.deepEqual([store.pendingJoins(), store.approvals()], [[], []]);
  assert.equal(store.stats().corruptRecords, 3);
  assert.equal(existsSync(joinsFilePath(dir, 'collab-refuse')), false, '被拒条目不得建文件');
  assert.equal(made.logs.filter((entry) => entry.message.includes('加入台账条目形态不符（拒绝入账）')).length, 3);
  const blockedDir = makeTempDir(t);
  blockDir(blockedDir, COLLABS_DIR_NAME);
  const failed = makeLog();
  const failedStore = createJoinsStore({ dataDir: blockedDir, collabId: 'collab-fail', log: failed.log });
  assert.equal(failedStore.addPendingJoin(pendingRecord({ sessionId: 'session-f1' })), true, '写盘失败仍入内存态');
  assert.deepEqual(failedStore.pendingJoins().length, 1);
  assert.deepEqual([failedStore.stats().persists, failedStore.stats().persistFailures], [0, 1]);
  assert.ok(failed.logs.some((entry) => entry.message.includes('加入台账写入失败')), '写失败留痕');
  store.clear();
  assert.deepEqual([store.stats().pendingJoins, store.stats().approvals, store.stats().clears], [0, 0, 1]);
  assert.equal(existsSync(joinsFilePath(dir, 'collab-refuse')), false);
  store.clear();
  assert.equal(store.stats().clears, 2, '文件本已不在也算成功');
  const rmDir = makeTempDir(t);
  const rmLog = makeLog();
  const rmStore = createJoinsStore({ dataDir: rmDir, collabId: 'collab-rm', log: rmLog.log });
  const rmFile = joinsFilePath(rmDir, 'collab-rm');
  seedFile(rmFile, { v: 2, pendingJoins: [] });
  rmSync(rmFile);
  mkdirSync(rmFile, { recursive: true });
  rmStore.clear();
  assert.deepEqual([rmStore.stats().approvals, rmStore.stats().persistFailures], [0, 1], '删失败只计数（内存态已复位）');
  assert.ok(rmLog.logs.some((entry) => entry.message.includes('加入台账清理失败')));
});

test('加入台账 load：显式重读覆盖内存态（外部改写即生效、坏档归空）', (t) => {
  const dir = makeTempDir(t);
  const { log } = makeLog();
  const store = createJoinsStore({ dataDir: dir, collabId: 'collab-reload', log });
  store.addApproval(approvalRecord());
  seedFile(joinsFilePath(dir, 'collab-reload'), { v: 1, pendingJoins: [pendingRecord()], approvals: [] });
  assert.equal(store.isGranted('session-a1'), true, '重读前：内存态未变');
  store.load();
  assert.deepEqual([store.pendingJoins(), store.approvals()], [[pendingRecord()], []]);
  assert.equal(store.isGranted('session-a1'), false, '重读即覆盖');
  writeFileSync(joinsFilePath(dir, 'collab-reload'), '坏档');
  store.load();
  assert.deepEqual(store.pendingJoins(), [], '重读遇坏档归空态');
  assert.equal(store.stats().corruptLoads, 1);
});

test('获准不写 approvals：旧档仅内存兼容；重启后以共享名单与席位为准', (t) => {
  const dir = makeTempDir(t);
  const { log } = makeLog();
  const store = createJoinsStore({ dataDir: dir, collabId: 'collab-authority', log });
  assert.equal(store.addPendingJoin(pendingRecord()), true);
  assert.equal(store.addApproval(approvalRecord()), true);
  assert.deepEqual(store.approvals(), [approvalRecord()], '同进程内旧判据仍可读');
  assert.deepEqual(JSON.parse(readFileSync(joinsFilePath(dir, 'collab-authority'), 'utf8')), {
    v: 2,
    pendingJoins: [pendingRecord()],
  }, '写侧只有 v2 pendingJoins，approvals 不落盘');
  assert.deepEqual(createJoinsStore({ dataDir: dir, collabId: 'collab-authority', log }).approvals(), [], '重启不恢复 approvals');

  /* 旧 v1 档：既无台账也无席位时，approvals 作只读兼容。 */
  seedFile(joinsFilePath(dir, 'collab-legacy'), { v: 1, pendingJoins: [], approvals: [approvalRecord()] });
  assert.equal(createJoinsStore({ dataDir: dir, collabId: 'collab-legacy', log }).isGranted('session-a1'), true, '旧档兼容');

  /* 席位为准：同会话席位已归档（终态）→ approvals 不得复活获准。 */
  seedFile(seatFilePath(dir, 'collab-legacy', 'session-a1'), seatRecord({ archivedAt: '2026-01-01T00:00:00.000Z' }));
  assert.equal(createJoinsStore({ dataDir: dir, collabId: 'collab-legacy', log }).isGranted('session-a1'), false, '归档席位退出获准面');

  /* 名单为准：台账存在且名单没有该会话 → approvals 不再是权威。 */
  seedFile(collabFilePath(dir, 'collab-roster', LEDGER_FILE_NAME), `${JSON.stringify(managerLedger('collab-roster'))}\n`);
  seedFile(joinsFilePath(dir, 'collab-roster'), { v: 1, pendingJoins: [], approvals: [approvalRecord()] });
  assert.equal(createJoinsStore({ dataDir: dir, collabId: 'collab-roster', log }).isGranted('session-a1'), false, '共享名单为权威');
});

test('旧 v1 待批准条目不经写回：不落 v2、不覆盖在途 join', (t) => {
  const dir = makeTempDir(t);
  const made = makeLog();
  const store = createJoinsStore({ dataDir: dir, collabId: 'collab-legacy-write', log: made.log });
  const legacyPending = { instanceId: 'inst-a', sessionId: 'session-a1', requestedAt: 1000 };
  assert.equal(store.addPendingJoin(legacyPending), true, '旧条目仍可入内存批准面');
  assert.equal(existsSync(joinsFilePath(dir, 'collab-legacy-write')), false, '旧形态不写 v2 文件');
  assert.equal(store.stats().persistSkips, 1);
  assert.ok(made.logs.some((entry) => entry.message.includes('含旧 v1 条目')), '跳过写回留痕');
});

test('加入申请台账坏载：不可解析 / 形态不符归空态、单条形态不符逐条丢弃留痕', (t) => {
  const dir = makeTempDir(t);
  seedFile(joinApplicationsFilePath(dir), '不是 JSON');
  const made = makeLog();
  const broken = createJoinApplicationsStore({ dataDir: dir, log: made.log });
  assert.deepEqual(broken.list(), []);
  assert.equal(broken.stats().corruptLoads, 1);
  assert.ok(made.logs.some((entry) => entry.message.includes('加入申请台账文件不可用') && entry.fields.reason === '无法解析'));
  const dir2 = makeTempDir(t);
  seedFile(joinApplicationsFilePath(dir2), { v: 1, applications: [applicationRecord(), applicationRecord({ msgId: 'bad msg!' })] });
  const dropped = makeLog();
  const store = createJoinApplicationsStore({ dataDir: dir2, log: dropped.log });
  assert.deepEqual(store.list(), [applicationRecord()]);
  assert.equal(store.stats().corruptRecords, 1);
  assert.ok(dropped.logs.some((entry) => entry.message.includes('加入申请台账条目形态不符（丢弃该条）')));
  const dir3 = makeTempDir(t);
  seedFile(joinApplicationsFilePath(dir3), '"台账"');
  const notObject = makeLog();
  const notObjectStore = createJoinApplicationsStore({ dataDir: dir3, log: notObject.log });
  assert.deepEqual(notObjectStore.list(), [], '顶层非对象按空态');
  assert.ok(notObject.logs.some((entry) => entry.fields.reason === '形态不符'));
  const dir4 = makeTempDir(t);
  mkdirSync(joinApplicationsFilePath(dir4), { recursive: true });
  const unreadable = makeLog();
  const dirStore = createJoinApplicationsStore({ dataDir: dir4, log: unreadable.log });
  assert.deepEqual(dirStore.list(), [], '读取失败按空态继续');
  assert.equal(dirStore.stats().corruptLoads, 1);
  const fresh = makeLog();
  createJoinApplicationsStore({ dataDir: makeTempDir(t), log: fresh.log });
  assert.deepEqual(fresh.logs, [], '首次运行无文件：静默空态');
});

test('加入申请台账读写往返：add 幂等（同 msgId 覆盖）、remove 命中 / 未命中、重建载入', (t) => {
  const dir = makeTempDir(t);
  const { log } = makeLog();
  const store = createJoinApplicationsStore({ dataDir: dir, log });
  assert.equal(store.add(applicationRecord()), true);
  assert.equal(store.add(applicationRecord({ sentAt: 5000 })), true, '重试重发同一 msgId');
  assert.deepEqual(store.list(), [applicationRecord({ sentAt: 5000 })], '同 msgId 只留一条（刷新）');
  assert.equal(store.add(applicationRecord({ msgId: 'msg-2', collabId: 'collab-2' })), true);
  assert.equal(store.list().length, 2);
  assert.deepEqual(JSON.parse(readFileSync(joinApplicationsFilePath(dir), 'utf8')), {
    v: 1,
    applications: [applicationRecord({ sentAt: 5000 }), applicationRecord({ msgId: 'msg-2', collabId: 'collab-2' })],
  });
  assert.equal(store.add(applicationRecord({ managerInstanceId: '不是 ID' })), false);
  assert.equal(store.stats().corruptRecords, 1);
  assert.equal(store.remove('msg-2'), true);
  assert.equal(store.remove('msg-2'), false, '未命中如实报');
  assert.equal(store.remove(7), false);
  const reloaded = createJoinApplicationsStore({ dataDir: dir, log });
  assert.deepEqual(reloaded.list(), [applicationRecord({ sentAt: 5000 })], '增删即时落盘');
  assert.deepEqual([reloaded.stats().adds, reloaded.stats().removes], [0, 0], '计数只属本线程内存态');
});

test('加入申请台账剪除：按 sentAt 与 TTL 判过期、剪除落盘、参数非法不剪', (t) => {
  const dir = makeTempDir(t);
  const made = makeLog();
  const store = createJoinApplicationsStore({ dataDir: dir, log: made.log });
  store.add(applicationRecord({ msgId: 'msg-old', sentAt: 1000 }));
  store.add(applicationRecord({ msgId: 'msg-edge', sentAt: 5000 }));
  store.add(applicationRecord({ msgId: 'msg-fresh', sentAt: 9000 }));
  assert.equal(store.pruneExpired(5000, 10000), 2, '满 TTL 即过期（age ≥ ttl）：老件与边缘件剪除');
  assert.deepEqual(store.list(), [applicationRecord({ msgId: 'msg-fresh', sentAt: 9000 })]);
  assert.equal(store.stats().pruned, 2);
  assert.deepEqual(JSON.parse(readFileSync(joinApplicationsFilePath(dir), 'utf8')).applications, [applicationRecord({ msgId: 'msg-fresh', sentAt: 9000 })], '剪除即时落盘');
  assert.equal(store.pruneExpired(5000, 10000), 0, '无过期即无剪除');
  assert.equal(store.pruneExpired('不久'), 0, '参数非法不剪');
  assert.equal(store.pruneExpired(NaN), 0);
  assert.equal(store.pruneExpired(-1), 0);
  assert.deepEqual(store.list(), [applicationRecord({ msgId: 'msg-fresh', sentAt: 9000 })], '非法参数下台账原样');
  assert.equal(store.stats().pruneRefusals, 3);
  assert.equal(made.logs.filter((entry) => entry.message.includes('加入申请台账剪除参数非法')).length, 3);
});

test('加入申请台账剪除：缺省 now 取当前时刻（真实时钟口径）', (t) => {
  const dir = makeTempDir(t);
  const store = createJoinApplicationsStore({ dataDir: dir, log: makeLog().log });
  const now = Date.now();
  store.add(applicationRecord({ msgId: 'msg-live', sentAt: now - 10 }));
  store.add(applicationRecord({ msgId: 'msg-stale', sentAt: now - 60000 }));
  assert.equal(store.pruneExpired(30000), 1, '缺省 now = 当前时刻');
  assert.deepEqual(store.list(), [applicationRecord({ msgId: 'msg-live', sentAt: now - 10 })]);
});

test('加入申请台账 load：显式重读覆盖内存态（外部改写即生效、坏档归空）', (t) => {
  const dir = makeTempDir(t);
  const { log } = makeLog();
  const store = createJoinApplicationsStore({ dataDir: dir, log });
  store.add(applicationRecord({ msgId: 'msg-old' }));
  seedFile(joinApplicationsFilePath(dir), { v: 1, applications: [applicationRecord({ msgId: 'msg-new', sentAt: 7000 })] });
  assert.deepEqual(store.list(), [applicationRecord({ msgId: 'msg-old' })], '重读前：内存态未变');
  store.load();
  assert.deepEqual(store.list(), [applicationRecord({ msgId: 'msg-new', sentAt: 7000 })]);
  writeFileSync(joinApplicationsFilePath(dir), '{}');
  store.load();
  assert.deepEqual(store.list(), [], '重读遇形态不符归空态');
  assert.equal(store.stats().corruptLoads, 1);
});

test('加入申请台账写失败面：内存态继续、只计数告警', (t) => {
  const dir = makeTempDir(t);
  blockDir(dir, 'run');
  const made = makeLog();
  const store = createJoinApplicationsStore({ dataDir: dir, log: made.log });
  assert.deepEqual(store.list(), [], '无文件即空态');
  assert.equal(store.add(applicationRecord()), true, '写盘失败仍入内存态');
  assert.deepEqual(store.list(), [applicationRecord()]);
  assert.deepEqual([store.stats().adds, store.stats().persistFailures], [1, 1], '入账计数与落盘失败分开记');
  assert.ok(made.logs.some((entry) => entry.message.includes('加入申请台账写入失败')), '写失败留痕');
  store.add(applicationRecord({ msgId: 'msg-2', sentAt: 1 }));
  assert.equal(store.remove('msg-2'), true, '删除同受失败面约束（内存态照旧生效）');
  assert.deepEqual([store.stats().adds, store.stats().removes, store.stats().persistFailures], [2, 1, 3]);
});
