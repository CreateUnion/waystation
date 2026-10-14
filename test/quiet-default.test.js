import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { collabFilePath } from '../src/paths.js';
import { makeTempDir } from './helpers.js';
import { createCollabService } from '../src/collab/service.js';
import { MUTE_FILE_NAME } from '../src/collab/mute.js';
import { approveInviteTool, createCollabTool } from '../src/tools/collab.js';

/* 入席默认静音（安静默认期设计 §3.1/§3.3）的判别用例面：三入口入席即静音（managed 创建 / 讨论创建 /
 * 同意加入）、受邀未同意不静音、拒绝后无 mute.json 残留（写点未挂宽的判据）、既有协作不追溯、
 * 重入闭环（退出清理 → 重新同意再静音）、基线口径与取消摘要、成功载荷的 notice 提醒（要素齐备、
 * 既有字段原样）。写点一旦挂到记录创建 / 成员落盘这类宽调用点，本文件前两组用例立刻翻红。 */

const DAY = 24 * 60 * 60 * 1000;
const SELF_A = { instanceId: 'inst-a', identityName: '主机甲', port: 17321 };
const SELF_B = { instanceId: 'inst-b', identityName: '主机乙', port: 17322 };

function makeService(t, overrides = {}) {
  const dir = overrides.dir ?? makeTempDir(t);
  const notices = [];
  const service = createCollabService({
    dataDir: dir,
    config: { inviteTtlMs: DAY },
    self: { instanceId: 'inst-self', identityName: '本机', port: 17321 },
    send: () => ({ ok: true, msgId: 'q-1' }),
    sendDirect: () => ({ ok: true, msgId: 'd-1' }),
    notify: (frame) => { notices.push(frame); },
    knownHosts: { remember: () => {} },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    ledgerFetchTimeoutMs: 30,
    inviteMinIntervalMs: 0,
    pullReplyTimeoutMs: 60,
    syncPeerPicker: () => [],
    joinReplayIntervalsMs: [10, 20, 40],
  });
  return { service, notices, dir };
}

let seq = 0;

function peer(instanceId, identityName, port) {
  return { instanceId, identityName, port };
}

function targetOf(member) {
  return { instanceId: member.instanceId, identityName: member.identityName, address: '127.0.0.2', port: member.port };
}

/* 邀请帧：mode 给定才携带（缺字段 = 旧版对端形态，接收侧按 managed 解释）。 */
function inviteFrame({ collabId, name = '联调项目', mode } = {}) {
  seq++;
  const roster = [SELF_A, peer('inst-self', '本机', 17321)];
  const payload = { name, topic: '发布联调', members: roster.map((entry) => ({ instanceId: entry.instanceId, identityName: entry.identityName })) };
  if (mode !== undefined) {
    payload.mode = mode;
  }
  return {
    v: 1,
    type: 'invite',
    msgId: `msg-inv-${seq}`,
    from: { instanceId: SELF_A.instanceId, identityName: SELF_A.identityName, port: SELF_A.port },
    collabId,
    ts: new Date().toISOString(),
    payload,
  };
}

function postFrameOf(collabId, from, { postId, postSeq = 1, text }) {
  seq++;
  return {
    v: 1,
    type: 'post',
    msgId: `msg-post-${seq}`,
    from: { instanceId: from.instanceId, identityName: from.identityName, port: from.port },
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
    type,
    msgId: `msg-content-${seq}`,
    from: { instanceId: from.instanceId, identityName: from.identityName, port: from.port },
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

function suppressedOf(service, frame) {
  return service.hooks.sessionGate(frame).suppress === true;
}

function mutePath(dir, collabId) {
  return collabFilePath(dir, collabId, MUTE_FILE_NAME);
}

function muteFileOf(dir, collabId) {
  return JSON.parse(readFileSync(mutePath(dir, collabId), 'utf8'));
}

/* 工具层直调（与生产同形：只有 context.collab 是协作工具集的入参面）。 */
async function callCollabTool(tool, args, collab) {
  return tool.handler(args, { collab });
}

function payloadOf(result) {
  assert.notEqual(result.isError, true, result.content[0].text);
  return JSON.parse(result.content[0].text);
}

test('三入口入席即静音：managed 创建与讨论创建（落盘形态与基线 0 起）', (t) => {
  const made = makeService(t);
  const managedId = made.service.create({ name: '协作甲', topic: '主题', targets: [targetOf(SELF_B)] }).collabId;
  assert.equal(suppressedOf(made.service, { type: 'progress', collabId: managedId }), true, 'managed 创建：内容消息不注入本会话');
  assert.deepEqual(muteFileOf(made.dir, managedId), { v: 1, muted: true, baseline: 0 }, '落盘形态 v/muted/baseline（入席时刻读数为 0）');
  const forumId = made.service.create({ name: '讨论甲', topic: '议题', mode: 'forum', targets: [targetOf(SELF_B)] }).collabId;
  assert.equal(suppressedOf(made.service, { type: 'post', collabId: forumId }), true, '讨论创建：实时帖不注入本会话');
  assert.deepEqual(muteFileOf(made.dir, forumId), { v: 1, muted: true, baseline: 0 });
});

test('三入口入席即静音：同意邀请（讨论与协作两条链路）', async (t) => {
  const made = makeService(t);
  const forumId = 'collab-approve-forum';
  await receive(made.service, inviteFrame({ collabId: forumId, mode: 'forum' }));
  assert.equal((await made.service.approve({ collabId: forumId, approve: true })).ok, true);
  assert.equal(suppressedOf(made.service, { type: 'post', collabId: forumId }), true, '讨论：同意即默认静音');
  assert.deepEqual(muteFileOf(made.dir, forumId), { v: 1, muted: true, baseline: 0 });
  const managedId = 'collab-approve-managed';
  await receive(made.service, inviteFrame({ collabId: managedId }));
  assert.equal((await made.service.approve({ collabId: managedId, approve: true })).ok, true);
  assert.equal(suppressedOf(made.service, { type: 'progress', collabId: managedId }), true, '协作：同意即默认静音');
  assert.deepEqual(muteFileOf(made.dir, managedId), { v: 1, muted: true, baseline: 0 });
});

test('受邀未同意不静音；拒绝后无 mute.json 残留（两条链路都不写）', async (t) => {
  const made = makeService(t);
  const forumId = 'collab-decline-forum';
  await receive(made.service, inviteFrame({ collabId: forumId, mode: 'forum' }));
  assert.equal(suppressedOf(made.service, { type: 'post', collabId: forumId }), false, '受邀未同意：不静音');
  assert.equal(existsSync(mutePath(made.dir, forumId)), false, '受邀未同意：无 mute.json');
  assert.equal((await made.service.approve({ collabId: forumId, approve: false, reason: '本轮不参加' })).ok, true);
  assert.equal(suppressedOf(made.service, { type: 'post', collabId: forumId }), false, '拒绝：不静音');
  assert.equal(existsSync(mutePath(made.dir, forumId)), false, '拒绝：无 mute.json 残留');
  const managedId = 'collab-decline-managed';
  await receive(made.service, inviteFrame({ collabId: managedId }));
  assert.equal((await made.service.approve({ collabId: managedId, approve: false })).ok, true);
  assert.equal(suppressedOf(made.service, { type: 'progress', collabId: managedId }), false, '拒绝（协作）：不静音');
  assert.equal(existsSync(mutePath(made.dir, managedId)), false, '拒绝（协作）：无 mute.json 残留');
});

test('既有协作不追溯：无静音状态文件的存量协作载入后维持不静音且不被补写', (t) => {
  const made = makeService(t);
  const collabId = made.service.create({ name: '协作甲', topic: '主题', targets: [targetOf(SELF_B)] }).collabId;
  rmSync(mutePath(made.dir, collabId), { force: true });   // 存量形态：升级前落盘的协作没有静音状态文件
  const reloaded = makeService(t, { dir: made.dir });
  assert.equal(reloaded.service.list().collabs.some((entry) => entry.collabId === collabId), true, '存量协作已载入');
  assert.equal(suppressedOf(reloaded.service, { type: 'progress', collabId }), false, '存量协作维持现状：不静音');
  assert.equal(existsSync(mutePath(made.dir, collabId)), false, '载入不补写静音状态（升级不改存量）');
});

test('重入闭环：退出清理静音 → 重新受邀同意 → 默认再静音', async (t) => {
  const made = makeService(t);
  const collabId = 'collab-reentry';
  await receive(made.service, inviteFrame({ collabId, mode: 'forum' }));
  await made.service.approve({ collabId, approve: true });
  assert.equal(existsSync(mutePath(made.dir, collabId)), true, '首次入席：默认静音已落盘');
  assert.equal(made.service.leave({ collabId }).ok, true);
  assert.equal(existsSync(mutePath(made.dir, collabId)), false, '退出：静音状态随终态清理');
  await receive(made.service, inviteFrame({ collabId, mode: 'forum' }));
  assert.equal((await made.service.approve({ collabId, approve: true })).ok, true);
  assert.equal(existsSync(mutePath(made.dir, collabId)), true, '重入：默认静音再次落盘');
  assert.equal(suppressedOf(made.service, { type: 'post', collabId }), true, '重入后帖注入判定：静音');
});

test('基线口径与取消摘要：基线 = 入席时刻读数，摘要只计静音期新增', async (t) => {
  const made = makeService(t);
  const fromA = peer(SELF_A.instanceId, SELF_A.identityName, SELF_A.port);
  const fromB = peer(SELF_B.instanceId, SELF_B.identityName, SELF_B.port);
  const forumId = 'collab-baseline-forum';
  await receive(made.service, inviteFrame({ collabId: forumId, mode: 'forum' }));
  await made.service.approve({ collabId: forumId, approve: true });
  assert.equal(muteFileOf(made.dir, forumId).baseline, 0, '基线 = 入席时刻的当下累计读数（0 起）');
  await receive(made.service, postFrameOf(forumId, fromA, { postId: 'post-q1', postSeq: 1, text: '静音期一' }));
  await receive(made.service, postFrameOf(forumId, fromA, { postId: 'post-q2', postSeq: 2, text: '静音期二' }));
  assert.equal((await made.service.view({ collabId: forumId })).posts.length, 2, '静音期内容照常落盘（只做减法）');
  assert.equal((await made.service.setMute({ collabId: forumId, muted: false })).ok, true);
  assert.ok(made.notices.at(-1).payload.text.includes('静音期间本讨论新增 2 条'), made.notices.at(-1).payload.text);
  const managedId = made.service.create({ name: '协作甲', topic: '主题', targets: [targetOf(SELF_B)] }).collabId;
  await receive(made.service, contentFrame('progress', managedId, fromB, { text: '静音期进度一' }));
  assert.equal((await made.service.setMute({ collabId: managedId, muted: false })).ok, true);
  assert.ok(made.notices.at(-1).payload.text.includes('静音期间本协作新增 1 条'), made.notices.at(-1).payload.text);
});

test('成功载荷的 notice：创建与同意各增一字段，既有字段原样', async (t) => {
  const made = makeService(t);
  const created = payloadOf(await callCollabTool(createCollabTool(), { name: '协作甲', topic: '主题', targets: [targetOf(SELF_B)] }, made.service));
  assert.equal(created.ok, true, '既有字段原样');
  assert.equal(typeof created.collabId, 'string', '既有字段：collabId');
  assert.equal(Array.isArray(created.invited), true, '既有字段：invited');
  assert.ok(created.notice.includes('已默认静音'), '要素：已默认静音');
  assert.ok(created.notice.includes('不注入本会话'), '要素：消息不注入本会话');
  assert.ok(created.notice.includes('/ws-view'), '要素：实时观看走观察窗');
  assert.ok(created.notice.includes('/ws-mute') && created.notice.includes('取消静音'), '要素：可取消静音');
  const collabId = 'collab-notice-member';
  await receive(made.service, inviteFrame({ collabId, mode: 'forum' }));
  const agreed = payloadOf(await callCollabTool(approveInviteTool(), { collabId, approve: true }, made.service));
  assert.equal(agreed.decision, 'approved', '既有字段原样');
  assert.equal(agreed.joined, true, '既有字段：joined');
  assert.equal(agreed.notice, created.notice, '同一提醒文案（单一权威）');
});

test('失败与拒绝载荷不带 notice：错误路径是纯文案、拒绝不入席', async (t) => {
  const made = makeService(t);
  await callCollabTool(createCollabTool(), { name: '协作甲', topic: '主题', targets: [targetOf(SELF_B)] }, made.service);
  const rejected = await callCollabTool(createCollabTool(), { name: '协作甲', topic: '主题', targets: [targetOf(SELF_B)] }, made.service);
  assert.equal(rejected.isError, true, '同名同参与者：服务拒绝');
  assert.ok(!rejected.content[0].text.includes('已默认静音'), '失败载荷不加提醒（没有已写入的静音可承诺）');
  const collabId = 'collab-notice-declined';
  await receive(made.service, inviteFrame({ collabId, mode: 'forum' }));
  const declined = payloadOf(await callCollabTool(approveInviteTool(), { collabId, approve: false }, made.service));
  assert.equal(declined.decision, 'declined', '既有字段原样');
  assert.equal(Object.hasOwn(declined, 'notice'), false, '拒绝：不带提醒（未入席、未写静音）');
});
