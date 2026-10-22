import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { collabDir, collabFilePath, seatFilePath } from '../src/paths.js';
import { makeTempDir } from './helpers.js';
import { createCollabService } from '../src/collab/service.js';
import { MUTE_FILE_NAME } from '../src/collab/mute.js';
import { approveInviteTool, createCollabTool } from '../src/tools/collab.js';

/* 入席默认值（2026-10-22 用户裁定：新席位默认不静音，managed 与讨论一致）的判别用例面：
 * 三入口入席不静音（managed 创建 / 讨论创建 / 同意加入）、受邀未同意不静音、拒绝后无席位与
 * 退役 mute.json 残留、存量旧版协作不追溯、重入仍不静音、显式静音的基线口径与取消摘要、
 * 成功载荷不再带默认静音 notice。静音权威是 seats/<sessionId>.json——新席位写 muted:false，
 * 显式 ws_set_mute 才置 true。 */

const DAY = 24 * 60 * 60 * 1000;
const SELF_A = { instanceId: 'inst-a', identityName: '主机甲', port: 17321, sessionId: 'sess-peer-a' };
const SELF_B = { instanceId: 'inst-b', identityName: '主机乙', port: 17322, sessionId: 'sess-peer-b' };
const SELF_INSTANCE = { instanceId: 'inst-self', identityName: '本机', port: 17321 };
/* 本机两席：MANAGER_SESSION 建协/签发邀请，MEMBER_SESSION 受邀同意（同机两会话旁路）。 */
const MANAGER_SESSION = 'sess-local-manager';
const MEMBER_SESSION = 'sess-local-member';

function makeService(t, overrides = {}) {
  const dir = overrides.dir ?? makeTempDir(t);
  const notices = [];
  const delivered = [];
  const service = createCollabService({
    dataDir: dir,
    config: { inviteTtlMs: DAY, joinRequestTtlMs: DAY, joinConfirmTtlMs: DAY },
    self: SELF_INSTANCE,
    send: () => ({ ok: true, msgId: 'q-1' }),
    sendDirect: () => ({ ok: true, msgId: 'd-1' }),
    notify: (frame) => { notices.push(frame); },
    deliverSeat: (frame) => { delivered.push(frame); return true; },
    knownHosts: { remember: () => {}, lookup: () => undefined },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    ledgerFetchTimeoutMs: 30,
    inviteMinIntervalMs: 0,
    pullReplyTimeoutMs: 60,
    syncPeerPicker: () => [],
    joinReplayIntervalsMs: [10, 20, 40],
  });
  /* 受邀会话的桥在册：同机邀请按桥注册面直投（首帧白名单，见设计 §4.3）。 */
  service.registerBridgeEntry(MEMBER_SESSION, 'bridge-member');
  return { service, notices, dir, delivered };
}

let seq = 0;

function targetOf(member) {
  return { instanceId: member.instanceId, identityName: member.identityName, address: '127.0.0.2', port: member.port };
}

/* 邀请帧：mode 给定才携带（缺字段 = 旧版对端形态，接收侧按 managed 解释）。
 * 0.2.0 名单条目按会话席位（instanceId + sessionId + identityName）。 */
function inviteFrame({ collabId, name = '联调项目', mode } = {}) {
  seq++;
  const roster = [SELF_A, { ...SELF_INSTANCE, sessionId: MEMBER_SESSION }];
  const payload = { name, topic: '发布联调', members: roster.map((entry) => ({ instanceId: entry.instanceId, sessionId: entry.sessionId, identityName: entry.identityName })) };
  if (mode !== undefined) {
    payload.mode = mode;
  }
  return {
    v: 1,
    cap: 2,
    type: 'invite',
    msgId: `msg-inv-${seq}`,
    from: { instanceId: SELF_A.instanceId, sessionId: SELF_A.sessionId, identityName: SELF_A.identityName, port: SELF_A.port },
    collabId,
    ts: new Date().toISOString(),
    payload,
  };
}

function postFrameOf(collabId, from, { postId, postSeq = 1, text }) {
  seq++;
  return {
    v: 1,
    cap: 2,
    type: 'post',
    msgId: `msg-post-${seq}`,
    from: { instanceId: from.instanceId, sessionId: from.sessionId, identityName: from.identityName, port: from.port },
    collabId,
    ts: new Date().toISOString(),
    payload: { post: { postId, seq: postSeq, kind: 'reply', text } },
  };
}

/* 协作（managed）内容消息帧：与讨论帖同构，只换类型（内容类词表以 protocol.POST_KINDS 为权威）。 */
function contentFrame(type, collabId, from, payload) {
  seq++;
  return {
    v: 1,
    cap: 2,
    type,
    msgId: `msg-content-${seq}`,
    from: { instanceId: from.instanceId, sessionId: from.sessionId, identityName: from.identityName, port: from.port },
    collabId,
    ts: new Date().toISOString(),
    payload,
  };
}

async function receive(service, frame, remoteAddress = '127.0.0.1') {
  const admitted = await service.hooks.admit(frame, { remoteAddress });
  if (admitted?.ok === true) {
    await service.hooks.consume(frame, { remoteAddress });
  }
  return admitted;
}

function suppressedOf(service, frame, sessionId = MEMBER_SESSION) {
  return service.hooks.sessionGate(frame, { sessionId }).suppress === true;
}

function seatPath(dir, collabId, sessionId) {
  return seatFilePath(dir, collabId, sessionId);
}

function seatFileOf(dir, collabId, sessionId) {
  return JSON.parse(readFileSync(seatPath(dir, collabId, sessionId), 'utf8'));
}

function mutePath(dir, collabId) {
  return collabFilePath(dir, collabId, MUTE_FILE_NAME);
}

/* 0.2.0 同意门：首次决定只发挑战（不改状态），携 confirmToken 重试才生效。
 * 同意以调用会话为单位——会话标识决定入席的席位。 */
async function approveWithConsent(service, { collabId, sessionId, approve = true, reason, inviteId } = {}) {
  const input = {
    collabId,
    approve,
    sessionId,
    ...(reason === undefined ? {} : { reason }),
    ...(inviteId === undefined ? {} : { inviteId }),
  };
  const challenge = await service.approve(input);
  assert.equal(challenge.needsUserConfirmation, true, '同意 / 拒绝须用户确认（0.2.0 同意门）');
  return service.approve({ ...input, confirmToken: challenge.confirmToken });
}

/* 同机协作邀请：站长会话经加入域签发邀请（invites.json 开放记录 + 目标机挂起邀请），
 * 目标会话再走同意门与两段式（grant → confirm 由本机旁路同步跑完）。 */
async function inviteSeatOf(made, collabId, { managerSessionId, memberSessionId }) {
  const invited = await made.service.join.createInvite({
    collabId,
    managerSessionId,
    targetInstanceId: SELF_INSTANCE.instanceId,
    targetSessionId: memberSessionId,
  });
  assert.equal(invited.ok, true, invited.message);
  return invited.inviteId;
}

/* 工具层直调（与生产同形：context.collab 是协作工具集，context.sessionId 是调用会话）。 */
async function callCollabTool(tool, args, collab, sessionId = undefined) {
  return tool.handler(args, { collab, ...(sessionId === undefined ? {} : { sessionId }) });
}

/* 工具层同意门的两步走：首次 isError 携挑战，携 confirmToken 重试才落状态。 */
async function callApproveToolWithConsent(collab, args, sessionId) {
  const first = await callCollabTool(approveInviteTool(), args, collab, sessionId);
  assert.equal(first.isError, true, '首次决定只发挑战');
  const challenge = JSON.parse(first.content[0].text);
  assert.equal(challenge.needsUserConfirmation, true, '同意 / 拒绝须用户确认（0.2.0 同意门）');
  return callCollabTool(approveInviteTool(), { ...args, confirmToken: challenge.confirmToken }, collab, sessionId);
}

function payloadOf(result) {
  assert.notEqual(result.isError, true, result.content[0].text);
  return JSON.parse(result.content[0].text);
}

/* 升级前落盘的存量协作（0.1.x）：只有旧成员记录，无载体 / 席位 / 台账——载入按旧版只读视图呈现。 */
function writeLegacyCollab(dir, collabId) {
  mkdirSync(collabDir(dir, collabId), { recursive: true });
  writeFileSync(collabFilePath(dir, collabId, 'member.json'), JSON.stringify({
    collabId,
    role: 'member',
    state: 'active',
    name: '旧协作',
    topic: '旧主题',
    mode: 'managed',
    manager: { instanceId: SELF_A.instanceId, identityName: SELF_A.identityName },
    roster: [{ instanceId: SELF_A.instanceId, identityName: SELF_A.identityName }],
    endpoints: {},
    decision: null,
  }));
}

test('新席位默认不静音：managed 创建与讨论创建（席位文件落盘）', (t) => {
  const made = makeService(t);
  const managedId = made.service.create({ name: '协作甲', topic: '主题', targets: [targetOf(SELF_B)], sessionId: MANAGER_SESSION }).collabId;
  assert.equal(suppressedOf(made.service, { type: 'progress', collabId: managedId }, MANAGER_SESSION), false, 'managed 创建：内容消息照常注入本会话');
  const managedSeat = seatFileOf(made.dir, managedId, MANAGER_SESSION);
  assert.equal(managedSeat.muted, false, '席位文件 muted=false（新席位默认不静音）');
  assert.equal(managedSeat.role, 'manager', '创建会话即站长席位');
  assert.equal(existsSync(mutePath(made.dir, managedId)), false, '不再写退役 mute.json');
  const forumId = made.service.create({ name: '讨论甲', topic: '议题', mode: 'forum', targets: [targetOf(SELF_B)], sessionId: MANAGER_SESSION }).collabId;
  assert.equal(suppressedOf(made.service, { type: 'post', collabId: forumId }, MANAGER_SESSION), false, '讨论创建：实时帖照常注入本会话');
  assert.equal(seatFileOf(made.dir, forumId, MANAGER_SESSION).muted, false, '讨论创建同样不静音');
  assert.equal(existsSync(mutePath(made.dir, forumId)), false, '讨论创建不写退役 mute.json');
});

test('新席位默认不静音：同意邀请（讨论与协作两条链路）', async (t) => {
  const made = makeService(t);
  const forumId = 'collab-approve-forum';
  await receive(made.service, inviteFrame({ collabId: forumId, mode: 'forum' }));
  const forumJoin = await approveWithConsent(made.service, { collabId: forumId, sessionId: MEMBER_SESSION });
  assert.equal(forumJoin.ok, true, forumJoin.message);
  assert.equal(suppressedOf(made.service, { type: 'post', collabId: forumId }), false, '讨论：同意后不静音');
  assert.equal(seatFileOf(made.dir, forumId, MEMBER_SESSION).muted, false, '讨论同意：席位 muted=false');
  assert.equal(existsSync(mutePath(made.dir, forumId)), false, '讨论同意不写退役 mute.json');
  const managed = made.service.create({ name: '协作甲', topic: '主题', targets: [targetOf(SELF_B)], sessionId: MANAGER_SESSION });
  const inviteId = await inviteSeatOf(made, managed.collabId, { managerSessionId: MANAGER_SESSION, memberSessionId: MEMBER_SESSION });
  const seatJoin = await approveWithConsent(made.service, { collabId: managed.collabId, sessionId: MEMBER_SESSION, inviteId });
  assert.equal(seatJoin.ok, true, seatJoin.message);
  assert.equal(suppressedOf(made.service, { type: 'progress', collabId: managed.collabId }), false, '协作：同意后不静音');
  assert.equal(seatFileOf(made.dir, managed.collabId, MEMBER_SESSION).muted, false, '协作同意：席位 muted=false');
  assert.equal(existsSync(mutePath(made.dir, managed.collabId)), false, '协作同意不写退役 mute.json');
});

test('受邀未同意不静音；拒绝后无席位与退役 mute.json 残留（讨论链路）', async (t) => {
  const made = makeService(t);
  const forumId = 'collab-decline-forum';
  await receive(made.service, inviteFrame({ collabId: forumId, mode: 'forum' }));
  assert.equal(suppressedOf(made.service, { type: 'post', collabId: forumId }), false, '受邀未同意：不静音');
  assert.equal(existsSync(seatPath(made.dir, forumId, MEMBER_SESSION)), false, '受邀未同意：无本会话席位');
  assert.equal(existsSync(mutePath(made.dir, forumId)), false, '受邀未同意：无退役 mute.json');
  const declined = await approveWithConsent(made.service, { collabId: forumId, sessionId: MEMBER_SESSION, approve: false, reason: '本轮不参加' });
  assert.equal(declined.ok, true, String(declined.message));
  assert.equal(declined.decision, 'declined');
  assert.equal(suppressedOf(made.service, { type: 'post', collabId: forumId }), false, '拒绝：不静音');
  assert.equal(existsSync(seatPath(made.dir, forumId, MEMBER_SESSION)), false, '拒绝：不建席位');
  assert.equal(existsSync(mutePath(made.dir, forumId)), false, '拒绝：无退役 mute.json 残留');
});

test('存量协作不追溯：旧版目录载入后不静音、不补写席位（升级不改存量）', (t) => {
  const dir = makeTempDir(t);
  const collabId = 'collab-legacy-mute';
  writeLegacyCollab(dir, collabId);
  const made = makeService(t, { dir });
  assert.equal(made.service.list().collabs.some((entry) => entry.collabId === collabId), true, '存量协作已载入');
  assert.equal(suppressedOf(made.service, { type: 'progress', collabId }), false, '旧版协作维持现状：不静音');
  assert.equal(existsSync(seatPath(dir, collabId, MEMBER_SESSION)), false, '载入不补写席位（升级不改存量）');
  assert.equal(existsSync(mutePath(dir, collabId)), false, '载入不写退役 mute.json');
});

test('重入不改变默认：退出删除席位 → 重新受邀同意 → 仍默认不静音', async (t) => {
  const made = makeService(t);
  const created = made.service.create({ name: '协作甲', topic: '主题', targets: [targetOf(SELF_B)], sessionId: MANAGER_SESSION });
  const collabId = created.collabId;
  await approveWithConsent(made.service, {
    collabId,
    sessionId: MEMBER_SESSION,
    inviteId: await inviteSeatOf(made, collabId, { managerSessionId: MANAGER_SESSION, memberSessionId: MEMBER_SESSION }),
  });
  assert.equal(existsSync(seatPath(made.dir, collabId, MEMBER_SESSION)), true, '首次入席：本会话席位已落盘');
  assert.equal(seatFileOf(made.dir, collabId, MEMBER_SESSION).muted, false, '首次入席：席位不静音');
  assert.equal(made.service.leave({ collabId, sessionId: MEMBER_SESSION }).ok, true);
  assert.equal(existsSync(seatPath(made.dir, collabId, MEMBER_SESSION)), false, '退出：席位文件随席位删除');
  assert.equal(existsSync(mutePath(made.dir, collabId)), false, '退出不写退役 mute.json');
  const rejoined = await approveWithConsent(made.service, {
    collabId,
    sessionId: MEMBER_SESSION,
    inviteId: await inviteSeatOf(made, collabId, { managerSessionId: MANAGER_SESSION, memberSessionId: MEMBER_SESSION }),
  });
  assert.equal(rejoined.ok, true, rejoined.message);
  assert.equal(existsSync(seatPath(made.dir, collabId, MEMBER_SESSION)), true, '重入：本会话席位再次落盘');
  assert.equal(seatFileOf(made.dir, collabId, MEMBER_SESSION).muted, false, '重入：仍默认不静音');
  assert.equal(suppressedOf(made.service, { type: 'progress', collabId }), false, '重入后内容照常注入');
});

test('显式静音的基线口径与取消摘要：基线 = 设静音时刻读数', async (t) => {
  const made = makeService(t);
  const fromA = SELF_A;
  const fromB = SELF_B;
  const forumId = 'collab-baseline-forum';
  await receive(made.service, inviteFrame({ collabId: forumId, mode: 'forum' }));
  await approveWithConsent(made.service, { collabId: forumId, sessionId: MEMBER_SESSION });
  await receive(made.service, postFrameOf(forumId, fromA, { postId: 'post-q1', postSeq: 1, text: '静音前一' }));
  await receive(made.service, postFrameOf(forumId, fromA, { postId: 'post-q2', postSeq: 2, text: '静音前二' }));
  assert.equal((await made.service.view({ collabId: forumId })).posts.length, 2, '静音前内容照常落盘');
  assert.equal((await made.service.setMute({ collabId: forumId, sessionId: MEMBER_SESSION, muted: true })).ok, true);
  await receive(made.service, postFrameOf(forumId, fromA, { postId: 'post-q3', postSeq: 3, text: '静音期一' }));
  assert.equal((await made.service.setMute({ collabId: forumId, sessionId: MEMBER_SESSION, muted: false })).ok, true);
  assert.ok(made.notices.at(-1).payload.text.includes('静音期间本讨论新增 1 条'), made.notices.at(-1).payload.text);
  const managedId = made.service.create({ name: '协作甲', topic: '主题', targets: [targetOf(SELF_B)], sessionId: MANAGER_SESSION }).collabId;
  await receive(made.service, contentFrame('progress', managedId, fromB, { text: '静音前进度' }));
  assert.equal((await made.service.setMute({ collabId: managedId, sessionId: MANAGER_SESSION, muted: true })).ok, true);
  await receive(made.service, contentFrame('progress', managedId, fromB, { text: '静音期进度' }));
  assert.equal((await made.service.setMute({ collabId: managedId, sessionId: MANAGER_SESSION, muted: false })).ok, true);
  assert.ok(made.notices.at(-1).payload.text.includes('静音期间本协作新增 1 条'), made.notices.at(-1).payload.text);
});

test('非布尔真值同意：讨论链路的入席生效且不静音（服务 API 直调）', async (t) => {
  const made = makeService(t);
  const forumId = 'collab-truthy-forum';
  await receive(made.service, inviteFrame({ collabId: forumId, mode: 'forum' }));
  const joined = await approveWithConsent(made.service, { collabId: forumId, sessionId: MEMBER_SESSION, approve: 1 });
  assert.equal(joined.ok, true, String(joined.message));
  assert.equal(joined.decision, 'approved', '按真值判定为同意（既有判据不变）');
  assert.equal(joined.joined, true, '入席生效');
  assert.equal(suppressedOf(made.service, { type: 'post', collabId: forumId }), false, '默认不静音');
  assert.equal(seatFileOf(made.dir, forumId, MEMBER_SESSION).muted, false, '席位落盘 muted=false');
  assert.equal(Object.hasOwn(joined, 'notice'), false, '不再带默认静音提醒');
});

test('幂等重入不覆盖用户显式静音：重复同意成功且不改静音', async (t) => {
  const made = makeService(t);
  const created = made.service.create({ name: '协作甲', topic: '主题', targets: [targetOf(SELF_B)], sessionId: MANAGER_SESSION });
  const collabId = created.collabId;
  const inviteId = await inviteSeatOf(made, collabId, { managerSessionId: MANAGER_SESSION, memberSessionId: MEMBER_SESSION });
  const first = await approveWithConsent(made.service, { collabId, sessionId: MEMBER_SESSION, inviteId });
  assert.equal(first.ok, true, String(first.message));
  assert.equal(seatFileOf(made.dir, collabId, MEMBER_SESSION).muted, false, '首次同意：席位默认不静音');
  assert.equal((await made.service.setMute({ collabId, sessionId: MEMBER_SESSION, muted: true })).ok, true);
  assert.equal(seatFileOf(made.dir, collabId, MEMBER_SESSION).muted, true, '已显式设静音');
  const second = await approveWithConsent(made.service, { collabId, sessionId: MEMBER_SESSION, inviteId });
  assert.equal(second.ok, true, '重复同意：幂等成功（未改口）');
  assert.equal(second.idempotent, true, '重复接受按幂等结果返回');
  assert.equal(Object.hasOwn(second, 'notice'), false, '本次没有任何写入：不给提醒');
  assert.equal(seatFileOf(made.dir, collabId, MEMBER_SESSION).muted, true, '用户显式静音不被覆盖');
  assert.equal(suppressedOf(made.service, { type: 'progress', collabId }), true, '内容按显式静音抑制');
});

test('显式静音窗口基线 = 设静音时刻（受邀期内容不计入）', async (t) => {
  const made = makeService(t);
  const collabId = 'collab-invite-window';
  await receive(made.service, inviteFrame({ collabId, mode: 'forum' }));
  await receive(made.service, postFrameOf(collabId, SELF_A, { postId: 'post-q1', postSeq: 1, text: '受邀期帖' }));
  assert.equal((await made.service.view({ collabId })).posts.length, 1, '受邀期内容照常落盘');
  const joined = await approveWithConsent(made.service, { collabId, sessionId: MEMBER_SESSION });
  assert.equal(joined.ok, true, String(joined.message));
  assert.equal(seatFileOf(made.dir, collabId, MEMBER_SESSION).muted, false, '同意后默认不静音');
  assert.equal((await made.service.setMute({ collabId, sessionId: MEMBER_SESSION, muted: true })).ok, true);
  await receive(made.service, postFrameOf(collabId, SELF_A, { postId: 'post-q2', postSeq: 2, text: '静音期帖' }));
  assert.equal((await made.service.setMute({ collabId, sessionId: MEMBER_SESSION, muted: false })).ok, true);
  assert.ok(made.notices.at(-1).payload.text.includes('静音期间本讨论新增 1 条'), '窗口基线＝设静音时刻读数（受邀期内容不计入）');
});

test('成功载荷不再带默认静音 notice：创建与同意字段原样', async (t) => {
  const made = makeService(t);
  const created = payloadOf(await callCollabTool(createCollabTool(), { name: '协作甲', topic: '主题', targets: [targetOf(SELF_B)] }, made.service, MANAGER_SESSION));
  assert.equal(created.ok, true, '既有字段原样');
  assert.equal(typeof created.collabId, 'string', '既有字段：collabId');
  assert.equal(Array.isArray(created.invited), true, '既有字段：invited');
  assert.equal(Object.hasOwn(created, 'notice'), false, '默认不静音：无默认静音提醒');
  const collabId = 'collab-notice-member';
  await receive(made.service, inviteFrame({ collabId, mode: 'forum' }));
  const agreed = payloadOf(await callApproveToolWithConsent(made.service, { collabId, approve: true }, MEMBER_SESSION));
  assert.equal(agreed.decision, 'approved', '既有字段原样');
  assert.equal(agreed.joined, true, '既有字段：joined');
  assert.equal(Object.hasOwn(agreed, 'notice'), false, '同意载荷无默认静音提醒');
});

test('失败与拒绝载荷不带 notice：错误路径是纯文案、拒绝不入席', async (t) => {
  const made = makeService(t);
  await callCollabTool(createCollabTool(), { name: '协作甲', topic: '主题', targets: [targetOf(SELF_B)] }, made.service, MANAGER_SESSION);
  const rejected = await callCollabTool(createCollabTool(), { name: '协作甲', topic: '主题', targets: [targetOf(SELF_B)] }, made.service, MANAGER_SESSION);
  assert.equal(rejected.isError, true, '同名同参与者：服务拒绝');
  assert.ok(!rejected.content[0].text.includes('已默认静音'), '失败载荷不加提醒（没有已写入的静音可承诺）');
  const collabId = 'collab-notice-declined';
  await receive(made.service, inviteFrame({ collabId, mode: 'forum' }));
  const declined = payloadOf(await callApproveToolWithConsent(made.service, { collabId, approve: false }, MEMBER_SESSION));
  assert.equal(declined.decision, 'declined', '既有字段原样');
  assert.equal(Object.hasOwn(declined, 'notice'), false, '拒绝：不带提醒（未入席、未写静音）');
});

/* managed 席位邀请的拒绝（设计 §4.3「拒绝 = 本条不参与」）：approve=false 携 inviteId 走加入域，
 * 消费挂起邀请并补发 decline；拒绝不建席位。 */
test('managed 席位邀请的拒绝：受理、消费挂起邀请且不建席位', async (t) => {
  const made = makeService(t);
  const created = made.service.create({ name: '协作甲', topic: '主题', targets: [targetOf(SELF_B)], sessionId: MANAGER_SESSION });
  const inviteId = await inviteSeatOf(made, created.collabId, { managerSessionId: MANAGER_SESSION, memberSessionId: MEMBER_SESSION });
  const declined = payloadOf(await callApproveToolWithConsent(
    made.service, { collabId: created.collabId, inviteId, approve: false, reason: '本轮不参加' }, MEMBER_SESSION,
  ));
  assert.equal(declined.ok, true, `拒绝邀请应被受理；实际：${declined.message}`);
  assert.equal(declined.declined, true, '拒绝结论如实返回');
  assert.equal(existsSync(seatPath(made.dir, created.collabId, MEMBER_SESSION)), false, '拒绝不建席位');
  assert.deepEqual(
    made.service.join.pendingInvitesFor({ collabId: created.collabId, sessionId: MEMBER_SESSION }), [],
    '拒绝后挂起邀请不再补投本会话',
  );
});

/* 拒绝原因按协议呈现判据在落地前校验：非法原因整条拒绝，挂起邀请保持可回应。 */
test('managed 席位邀请的拒绝：原因非法不落地', async (t) => {
  const made = makeService(t);
  const created = made.service.create({ name: '协作甲', topic: '主题', targets: [targetOf(SELF_B)], sessionId: MANAGER_SESSION });
  const inviteId = await inviteSeatOf(made, created.collabId, { managerSessionId: MANAGER_SESSION, memberSessionId: MEMBER_SESSION });
  const declined = await approveWithConsent(made.service, {
    collabId: created.collabId, inviteId, approve: false, sessionId: MEMBER_SESSION, reason: '甲\n乙',
  });
  assert.equal(declined.ok, false, '非法原因（换行）被拒');
  assert.match(String(declined.message), /拒绝原因非法/);
  assert.equal(
    made.service.join.pendingInvitesFor({ collabId: created.collabId, sessionId: MEMBER_SESSION }).length, 1,
    '拒绝未落地：挂起邀请仍可回应',
  );
});

/* 拒绝的簿记面：向邀请者补发 decline 帧（站长侧计数 +1）；重复拒绝按幂等返回且不重复投递。 */
test('拒绝：站长侧收到 decline，重复拒绝幂等且不重复计数', async (t) => {
  const made = makeService(t);
  const created = made.service.create({ name: '协作甲', topic: '主题', targets: [targetOf(SELF_B)], sessionId: MANAGER_SESSION });
  const inviteId = await inviteSeatOf(made, created.collabId, { managerSessionId: MANAGER_SESSION, memberSessionId: MEMBER_SESSION });
  await made.service.registerBridgeEntry(MANAGER_SESSION, 'bridge-manager');
  const first = await approveWithConsent(made.service, {
    collabId: created.collabId, inviteId, approve: false, sessionId: MEMBER_SESSION, reason: '本轮不参加',
  });
  assert.equal(first.ok, true, String(first.message));
  const declineFrames = made.delivered.filter((frame) => frame.type === 'decline');
  assert.equal(declineFrames.length, 1, '站长侧收到一条 decline 帧');
  assert.equal(declineFrames[0].payload.reason, '本轮不参加', '拒绝原因随帧送达');
  assert.equal(declineFrames[0].from.sessionId, MEMBER_SESSION, '发信会话＝拒绝会话');
  /* 同机旁路只把帧交付给会话；这里把它送进本站长的接收管线，模拟站长核真正收到该帧。 */
  await receive(made.service, declineFrames[0]);
  assert.equal(made.service.stats().declinesIn, 1, '站长侧 decline 计数 +1');
  const second = await approveWithConsent(made.service, {
    collabId: created.collabId, inviteId, approve: false, sessionId: MEMBER_SESSION, reason: '本轮不参加',
  });
  assert.equal(second.ok, true, String(second.message));
  assert.equal(second.idempotent, true, '重复拒绝按幂等返回');
  assert.equal(made.delivered.filter((frame) => frame.type === 'decline').length, 1, '幂等拒绝不重复投递');
  assert.equal(made.service.stats().declinesIn, 1, '站长侧不重复计数');
  assert.equal(existsSync(seatPath(made.dir, created.collabId, MEMBER_SESSION)), false, '重复拒绝仍无席位');
});
