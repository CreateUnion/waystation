import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import dgram from 'node:dgram';
import net from 'node:net';
import { join } from 'node:path';
import { CONFIG_FILE_NAME, bindingsFilePath, coreJsonPath, joinApplicationsFilePath, joinsFilePath } from '../src/paths.js';
import { createCollabService } from '../src/collab/service.js';
import { resolveJoinTarget } from '../src/collab/join.js';
import { bindingIsActive, createBindingStore } from '../src/core/routing.js';
import { createIpcClient } from '../src/core/ipc.js';
import { startCore } from '../src/core/main.js';
import { makeTempDir, pickFreePort, waitFor } from './helpers.js';

/* 加入域服务（会话级加入 §2/§4）的判别面：申请 / 批准 / 接线 / 拒绝呈现 / 讨论直连。
 * 夹具＝真临时根 ＋ 假投递（send / sendDirect 捕获）＋ 假清单 ＋ 本机提示捕获；
 * hooks 直调模拟接收管线（admit 通过才 consume——与真实管线同序）。
 * 末节为真核 e2e（本机自批链）：真核心进程内起站 ＋ 真 IPC 桥 ＋ 真 TCP 入站探针
 * （建协 → 新会话申请 → 待批准面 → 批准 → 接线 → 注入到达该会话）。 */

const DAY = 24 * 60 * 60 * 1000;
let seq = 0;

function quietLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function peer(instanceId, identityName, port = 17321) {
  return { instanceId, identityName, port };
}

/* 建协目标（目标端点须为 IP 字面量 ＋ 端口——建协的入口判据）。 */
function endpoint(instanceId, identityName, address = '127.0.0.1', port = 17400) {
  return { instanceId, identityName, address, port };
}

/* 投递捕获面（假 send / sendDirect：记账并返帧标识——回执比对键出自它）。 */
function captureDeliveries() {
  const sent = [];
  const direct = [];
  return {
    sent,
    direct,
    send: (message) => {
      sent.push(message);
      return { ok: true, msgId: `q-${sent.length}` };
    },
    sendDirect: (message) => {
      direct.push(message);
      return { ok: true, msgId: `d-${direct.length}` };
    },
  };
}

/* 可注入取值的统一口径（显式 null＝该面缺位；未给＝夹具默认）。 */
function optionalOf(overrides, key, fallback) {
  return overrides[key] === undefined ? fallback : overrides[key];
}

/* 服务夹具：真临时目录 ＋ 假投递 ＋ 真绑定表（落盘——清单的绑定视角读的就是它）。
 * joinRequestRetryMs 缺省取一小时（等价关闭——重试面由专门用例注入短节律）。 */
function makeService(t, overrides = {}) {
  const dir = makeTempDir(t);
  const notices = [];
  const opened = [];
  const deliveries = captureDeliveries();
  const bindings = createBindingStore({ dataDir: dir, log: quietLog() });
  const self = overrides.self ?? peer('inst-self', '本机');
  const config = { inviteTtlMs: DAY, ...(overrides.config ?? {}) };
  const service = createCollabService({
    dataDir: dir,
    config,
    self,
    send: overrides.send ?? deliveries.send,
    sendDirect: optionalOf(overrides, 'sendDirect', deliveries.sendDirect),
    knownHosts: { remember: () => {}, lookup: () => undefined },
    notify: (frame) => {
      notices.push(frame);
      return true;
    },
    log: quietLog(),
    bindings: optionalOf(overrides, 'bindings', bindings),
    bridgeIdOf: overrides.bridgeIdOf ?? null,
    openViewer: (ref) => {
      opened.push(ref);
      return { opened: false, reason: 'test' };
    },
    requestJoinResolve: overrides.requestJoinResolve ?? null,
    requestJoin: overrides.requestJoin ?? null,
    now: overrides.now ?? (() => Date.now()),
    joinRequestRetryMs: overrides.joinRequestRetryMs ?? 3600000,
    ledgerFetchTimeoutMs: 60,
    inviteMinIntervalMs: 0,
    syncPeerPicker: () => [],
  });
  return { service, dir, self, sent: deliveries.sent, direct: deliveries.direct, notices, opened, bindings, config };
}

async function receive(service, frame, remoteAddress = '127.0.0.1') {
  const admitted = await service.hooks.admit(frame, { remoteAddress });
  if (admitted?.ok === true) {
    await service.hooks.consume(frame, { remoteAddress });
  }
  return admitted;
}

function invitePayloadOf(name, topic, roster, mode) {
  const payload = { name, topic, members: roster.map((entry) => ({ instanceId: entry.instanceId, identityName: entry.identityName })) };
  if (mode !== undefined) {
    payload.mode = mode;
  }
  return payload;
}

function inviteFrame({ collabId, manager = peer('inst-a', '主机甲'), name = '联调项目', topic = '发布联调', mode } = {}) {
  seq++;
  const roster = [manager, peer('inst-self', '本机')];
  return {
    v: 1,
    type: 'invite',
    msgId: `msg-inv-${seq}`,
    from: { ...manager },
    collabId,
    ts: new Date().toISOString(),
    payload: invitePayloadOf(name, topic, roster, mode),
  };
}

function joinRequestFrame(collabId, sessionId, from = peer('inst-b', '主机乙', 17400)) {
  seq++;
  return { v: 1, type: 'join-request', msgId: `msg-req-${seq}`, from: { ...from }, collabId, ts: new Date().toISOString(), payload: { sessionId } };
}

function grantFrame(collabId, sessionId, reqMsgId, from = peer('inst-a', '主机甲', 17321)) {
  seq++;
  return { v: 1, type: 'join-grant', msgId: `msg-grant-${seq}`, from: { ...from }, collabId, ts: new Date().toISOString(), payload: { sessionId, reqMsgId } };
}

function denyFrame(collabId, reqMsgId, reason, from = peer('inst-a', '主机甲', 17321)) {
  seq++;
  const payload = { reqMsgId };
  if (reason !== undefined) {
    payload.reason = reason;
  }
  return { v: 1, type: 'join-deny', msgId: `msg-deny-${seq}`, from: { ...from }, collabId, ts: new Date().toISOString(), payload };
}

/* 本机为成员的协作记录（真邀请 + 真同意——成员记录走既有入席路径，不是手造形态）。 */
async function activeMemberCollab(t, made, collabId, manager = peer('inst-a', '主机甲')) {
  const admitted = await receive(made.service, inviteFrame({ collabId, manager }));
  assert.equal(admitted.ok, true, '邀请过准入');
  const approved = await made.service.approve({ collabId, approve: true });
  assert.equal(approved.ok, true, '同意入席');
  return collabId;
}

function applicationsOf(dir) {
  try {
    return JSON.parse(readFileSync(joinApplicationsFilePath(dir), 'utf8')).applications;
  } catch {
    return [];
  }
}

function approvalsOf(dir, collabId) {
  try {
    return JSON.parse(readFileSync(joinsFilePath(dir, collabId), 'utf8')).approvals;
  } catch {
    return [];
  }
}

function pendingOf(dir, collabId) {
  try {
    return JSON.parse(readFileSync(joinsFilePath(dir, collabId), 'utf8')).pendingJoins;
  } catch {
    return [];
  }
}

function sentOf(list, type) {
  return list.filter((entry) => entry.type === type);
}

/* —— 申请：本机自批直落待批准面（不经网络帧）与站长侧待批准面 —— */

test('申请（本机自批）：本机会话对本站长协作的申请直落待批准面、不经网络帧；待批准面在清单里按短码呈现', async (t) => {
  const made = makeService(t);
  const created = made.service.create({ name: '自建项目', topic: '主题', targets: [endpoint('inst-b', '主机乙')] });
  assert.equal(created.ok, true);
  const result = await made.service.join.request({ collabId: created.collabId, sessionId: 'newcomer-1' });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.local, true, '本机即站长：申请不进网络管线（门对 from===self 一律自邀拒）');
  assert.deepEqual(sentOf(made.direct, 'join-request'), [], '零网络帧');
  assert.deepEqual(sentOf(made.sent, 'join-request'), []);
  const pending = made.service.join.pendingJoinsOf(created.collabId);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].sessionId, 'newcomer-1');
  assert.equal(pending[0].instanceId, 'inst-self');
  assert.equal(typeof pending[0].requestedAt, 'number');
  assert.deepEqual(pendingOf(made.dir, created.collabId).map((entry) => entry.sessionId), ['newcomer-1'], '落台账（joins.json 的 pendingJoins）');
  const listed = made.service.list().collabs.find((entry) => entry.collabId === created.collabId);
  assert.deepEqual(listed.pendingJoins, [{ instanceId: 'inst-self', identityName: '本机', sessionId: 'newcomer', requestedAt: pending[0].requestedAt }],
    '站长侧展示面：短码（前 8 字符）＋ 实例标识 ＋ 申请时刻');
});

test('申请（本机自批）：未决期内重复申请不重发（同会话同协作幂等，待批准面不堆行）', async (t) => {
  const made = makeService(t);
  const created = made.service.create({ name: '自建项目', topic: '主题', targets: [endpoint('inst-b', '主机乙')] });
  const first = await made.service.join.request({ collabId: created.collabId, sessionId: 'newcomer-1' });
  const again = await made.service.join.request({ collabId: created.collabId, sessionId: 'newcomer-1' });
  assert.equal(first.pending, true);
  assert.equal(again.ok, true);
  assert.equal(again.idempotent, true, '未决期内重复申请＝如实报「已在等待」而不重发');
  assert.equal(made.service.join.pendingJoinsOf(created.collabId).length, 1, '待批准面不堆行');
  assert.deepEqual(pendingOf(made.dir, created.collabId).length, 1);
});

test('批准（本机自批链）：批准＝写获准台账＋接线本会话＋删待批准＋开该协作页（进入即见）', async (t) => {
  const made = makeService(t, { bridgeIdOf: (sessionId) => (sessionId === 'newcomer-1' ? 'bridge-n1' : null) });
  const created = made.service.create({ name: '自建项目', topic: '主题', targets: [endpoint('inst-b', '主机乙')] });
  made.opened.length = 0;   // 建协的触发 A 已记账：本用例只判加入接线后的那一次
  await made.service.join.request({ collabId: created.collabId, sessionId: 'newcomer-1' });
  const approved = made.service.join.approve({ collabId: created.collabId, sessionId: 'newcomer-1', approve: true, approvedBy: 'session-a' });
  assert.equal(approved.ok, true, approved.message);
  assert.equal(approved.bound, true);
  const approvals = approvalsOf(made.dir, created.collabId);
  assert.equal(approvals.length, 1);
  assert.deepEqual(
    { sessionId: approvals[0].sessionId, origin: approvals[0].origin, approvedBy: approvals[0].approvedBy, instanceId: approvals[0].instanceId },
    { sessionId: 'newcomer-1', origin: 'grant', approvedBy: 'session-a', instanceId: 'inst-self' },
  );
  assert.equal(typeof approvals[0].grantedAt, 'number', '时间戳毫秒整数（与准入门同一时间基准）');
  assert.deepEqual(made.service.join.pendingJoinsOf(created.collabId), [], '批准即出待批准面');
  assert.equal(made.service.join.isGranted(created.collabId, 'newcomer-1'), true);
  assert.equal(made.service.join.isGranted(created.collabId, 'newcomer'), false, '获准按全量会话标识精确匹配（短码不算命中）');
  const binding = made.bindings.get(created.collabId);
  assert.equal(binding.sessionId, 'newcomer-1');
  assert.equal(binding.origin, 'grant');
  assert.equal(binding.bridgeId, 'bridge-n1', '会话在册＝记其当前桥（出处记录）');
  assert.equal(typeof binding.boundAt, 'string');
  assert.deepEqual(made.opened, [{ root: 'main', id: created.collabId }], '触发 A 同款的「进入即见」');
  const listed = made.service.list({ sessionId: 'newcomer-1' }).collabs.find((entry) => entry.collabId === created.collabId);
  assert.equal(listed.sessionGranted, true, '获准视角（本会话）');
  assert.equal(listed.sessionBound, true, '绑定视角（本会话）');
  assert.deepEqual(listed.pendingJoins, []);
});

test('批准（拒绝）：删待批准＋本机自批的拒绝经本机提示面呈现原因，且不写任何获准 / 绑定', async (t) => {
  const made = makeService(t);
  const created = made.service.create({ name: '自建项目', topic: '主题', targets: [endpoint('inst-b', '主机乙')] });
  await made.service.join.request({ collabId: created.collabId, sessionId: 'newcomer-1' });
  const denied = made.service.join.approve({ collabId: created.collabId, sessionId: 'newcomer-1', approve: false, approvedBy: 'session-a', reason: '本项目已满员' });
  assert.equal(denied.ok, true, denied.message);
  assert.deepEqual(made.service.join.pendingJoinsOf(created.collabId), []);
  assert.deepEqual(approvalsOf(made.dir, created.collabId), []);
  assert.equal(made.bindings.get(created.collabId), null);
  assert.equal(made.notices.length, 1, '拒绝＝本机提示一行（沿既有本机提示先例）');
  assert.equal(made.notices[0].collabId, created.collabId);
  assert.match(made.notices[0].payload.text, /拒绝/);
  assert.match(made.notices[0].payload.text, /本项目已满员/, '原因随提示呈现');
});

test('批准：待批准不存在 / 非站长协作 / 批准者非法 / 拒绝原因非法一律如实拒', async (t) => {
  const made = makeService(t);
  const created = made.service.create({ name: '自建项目', topic: '主题', targets: [endpoint('inst-b', '主机乙')] });
  const missing = made.service.join.approve({ collabId: created.collabId, sessionId: 'newcomer-1', approve: true, approvedBy: 'session-a' });
  assert.equal(missing.ok, false);
  assert.match(missing.message, /没有待批准/);
  const badApprover = made.service.join.approve({ collabId: created.collabId, sessionId: 'newcomer-1', approve: true, approvedBy: '' });
  assert.equal(badApprover.ok, false);
  assert.match(badApprover.message, /approvedBy/);
  await made.service.join.request({ collabId: created.collabId, sessionId: 'newcomer-1' });
  const unknownCollab = made.service.join.approve({ collabId: 'collab-ghost', sessionId: 'newcomer-1', approve: true, approvedBy: 'session-a' });
  assert.equal(unknownCollab.ok, false);
  assert.match(unknownCollab.message, /没有该协作/);
  const badReason = made.service.join.approve({ collabId: created.collabId, sessionId: 'newcomer-1', approve: false, approvedBy: 'session-a', reason: '甲\n乙' });
  assert.equal(badReason.ok, false, '拒绝原因过呈现判据（不得带换行）');
  assert.equal(made.service.join.pendingJoinsOf(created.collabId).length, 1, '被拒的处置不动待批准面');
});

/* —— 申请：远端站长的直投路径（成员机在席；短节律重试与时限） —— */

test('申请（成员机在席）：join-request 直投站长、落申请台账；未决期内重复申请不重发', async (t) => {
  const made = makeService(t);
  await activeMemberCollab(t, made, 'collab-remote');
  const result = await made.service.join.request({ collabId: 'collab-remote', sessionId: 'newcomer-1' });
  assert.equal(result.ok, true, result.message);
  const requests = sentOf(made.direct, 'join-request');
  assert.equal(requests.length, 1, '在席＝直投（不进 outbox 长队列）');
  assert.deepEqual(requests[0].to, { instanceId: 'inst-a', address: '127.0.0.1', port: 17321 }, '直投站长（端点来自协作端点表）');
  assert.deepEqual(requests[0].payload, { sessionId: 'newcomer-1' });
  const applications = applicationsOf(made.dir);
  assert.equal(applications.length, 1);
  assert.deepEqual(
    { collabId: applications[0].collabId, sessionId: applications[0].sessionId, managerInstanceId: applications[0].managerInstanceId, msgId: applications[0].msgId },
    { collabId: 'collab-remote', sessionId: 'newcomer-1', managerInstanceId: 'inst-a', msgId: 'd-1' },
    '申请记录：协作＋会话＋站长实例＋申请帧标识（回执比对按此三键命中）',
  );
  assert.equal(typeof applications[0].sentAt, 'number');
  const again = await made.service.join.request({ collabId: 'collab-remote', sessionId: 'newcomer-1' });
  assert.equal(again.idempotent, true);
  assert.equal(sentOf(made.direct, 'join-request').length, 1, '未决期内重复申请不重发');
});

test('申请（未在席）：先按名解析取 collabId 再直投；无应答 / 未命中 / 降级各如实报错', async (t) => {
  const made = makeService(t, {
    requestJoinResolve: async ({ name, address, port }) => {
      assert.equal(name, '远端项目');
      assert.equal(address, '127.0.0.2');
      assert.equal(port, 17500);
      return { ok: true, reply: { found: true, collabId: 'collab-far', responder: { instanceId: 'inst-z', identityName: '主机丙', address: '127.0.0.2', port: 17500 } } };
    },
  });
  const result = await made.service.join.request({ name: '远端项目', target: { address: '127.0.0.2', port: 17500 }, sessionId: 'newcomer-1' });
  assert.equal(result.ok, true, result.message);
  const requests = sentOf(made.direct, 'join-request');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].collabId, 'collab-far');
  assert.deepEqual(requests[0].to, { instanceId: 'inst-z', address: '127.0.0.2', port: 17500 }, '回执对象＝应答者实例（申请先于入席：没有本地记录可依）');
  assert.equal(applicationsOf(made.dir)[0].managerInstanceId, 'inst-z');

  const silent = makeService(t, { requestJoinResolve: async () => ({ ok: true, reply: null }) });
  const noAnswer = await silent.service.join.request({ name: '远端项目', target: { address: '127.0.0.2', port: 17500 }, sessionId: 'newcomer-1' });
  assert.equal(noAnswer.ok, false);
  assert.match(noAnswer.message, /无应答|不可达/);
  assert.equal(sentOf(silent.direct, 'join-request').length, 0);

  const missed = makeService(t, { requestJoinResolve: async () => ({ ok: true, reply: { found: false } }) });
  const notFound = await missed.service.join.request({ name: '远端项目', target: { address: '127.0.0.2', port: 17500 }, sessionId: 'newcomer-1' });
  assert.equal(notFound.ok, false);
  assert.match(notFound.message, /没有名|未找到/);

  const degraded = makeService(t, { requestJoinResolve: async () => ({ ok: false, message: '局域网功能不可用' }) });
  const down = await degraded.service.join.request({ name: '远端项目', target: { address: '127.0.0.2', port: 17500 }, sessionId: 'newcomer-1' });
  assert.equal(down.ok, false);
  assert.equal(down.message, '局域网功能不可用', '降级面原样透传（不吞原因）');
});

test('申请：sessionId / collabId / name 形态缺失或非法一律如实拒（不发帧、不落台账）', async (t) => {
  const made = makeService(t);
  const noSession = await made.service.join.request({ collabId: 'collab-remote' });
  assert.equal(noSession.ok, false);
  assert.match(noSession.message, /sessionId/);
  const noTarget = await made.service.join.request({ sessionId: 'newcomer-1' });
  assert.equal(noTarget.ok, false);
  const badCollabId = await made.service.join.request({ collabId: 'collab remote', sessionId: 'newcomer-1' });
  assert.equal(badCollabId.ok, false);
  const unknownCollab = await made.service.join.request({ collabId: 'collab-ghost', sessionId: 'newcomer-1' });
  assert.equal(unknownCollab.ok, false);
  assert.match(unknownCollab.message, /没有该协作/);
  assert.deepEqual(applicationsOf(made.dir), []);
});

test('申请（异常面）：消息面缺位 / 直投面缺失 / 发送面拒绝一律如实报错（不发帧、不落台账）', async (t) => {
  /* 消息面缺位（网络组件未注入）：按名解析与敲门都如实报错，不静默改走别的通道。 */
  const bare = makeService(t);
  const noResolve = await bare.service.join.request({ name: '远端项目', target: { address: '127.0.0.2', port: 17500 }, sessionId: 'newcomer-1' });
  assert.equal(noResolve.ok, false);
  assert.match(noResolve.message, /不可用/);
  const noKnock = await bare.service.join.request({ name: '某讨论', sessionId: 'newcomer-1' });
  assert.equal(noKnock.ok, false);
  assert.match(noKnock.message, /不可用/);
  const unknown = await bare.service.join.request({ collabId: 'collab-ghost', sessionId: 'newcomer-1' });
  assert.equal(unknown.ok, false);
  assert.match(unknown.message, /没有该协作/);
  assert.deepEqual(applicationsOf(bare.dir), []);
  /* 直投面缺失（不静默改走 outbox 长队列）与发送面拒绝：都如实报错、不落申请台账。 */
  const directless = makeService(t, { sendDirect: null });
  await activeMemberCollab(t, directless, 'collab-remote');
  const blocked = await directless.service.join.request({ collabId: 'collab-remote', sessionId: 'newcomer-1' });
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /直投面不可用/);
  assert.deepEqual(applicationsOf(directless.dir), []);
  const refused = makeService(t, { sendDirect: () => ({ ok: false, reason: '目标为本机实例，拒绝对自己投递' }) });
  await activeMemberCollab(t, refused, 'collab-remote');
  const refusedSend = await refused.service.join.request({ collabId: 'collab-remote', sessionId: 'newcomer-1' });
  assert.equal(refusedSend.ok, false);
  assert.match(refusedSend.message, /发送失败/);
  assert.match(refusedSend.message, /拒绝对自己投递/, '原因原样透传');
  assert.deepEqual(applicationsOf(refused.dir), []);
});

test('申请（短节律重试至时限）：未决期内按节律重发（沿用首次发出时刻）、时限到即剪除并停轮', async (t) => {
  let clockMs = Date.now();
  const made = makeService(t, {
    now: () => clockMs,
    config: { joinRequestTtlMs: 60000 },
    joinRequestRetryMs: 15,
    joinRequestRetryMaxMs: 15,
  });
  await activeMemberCollab(t, made, 'collab-remote');
  await made.service.join.request({ collabId: 'collab-remote', sessionId: 'newcomer-1' });
  const firstSentAt = applicationsOf(made.dir)[0].sentAt;
  await waitFor(() => (sentOf(made.direct, 'join-request').length >= 3 ? true : null), { timeoutMs: 4000 });
  const attempts = applicationsOf(made.dir);
  assert.equal(attempts.length, 1, '重发刷新原记录而不堆行（同会话同协作恒一条）');
  assert.equal(attempts[0].sentAt, firstSentAt, '时限基准＝首次发出时刻（重发不续命）');
  clockMs += 120000;   // 越过申请时限
  await waitFor(() => (applicationsOf(made.dir).length === 0 ? true : null), { timeoutMs: 4000 });
  const stopped = sentOf(made.direct, 'join-request').length;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(sentOf(made.direct, 'join-request').length, stopped, '时限到即停轮（不再重发）');
});

/* —— 回执落地：grant / deny 的比对与收尾 —— */

test('join-grant 到达：写本机获准台账＋接线（离线会话写持久映射、重开即活）＋删申请记录＋开该协作页', async (t) => {
  const made = makeService(t);
  await activeMemberCollab(t, made, 'collab-remote');
  made.opened.length = 0;   // 同意入席的触发 A 已记账：本用例只判回执接线后的那一次
  await made.service.join.request({ collabId: 'collab-remote', sessionId: 'newcomer-1' });
  const reqMsgId = applicationsOf(made.dir)[0].msgId;
  await made.service.hooks.consume(grantFrame('collab-remote', 'newcomer-1', reqMsgId), { remoteAddress: '127.0.0.1' });
  const approvals = approvalsOf(made.dir, 'collab-remote');
  assert.equal(approvals.length, 1);
  assert.deepEqual(
    { sessionId: approvals[0].sessionId, origin: approvals[0].origin, approvedBy: approvals[0].approvedBy, instanceId: approvals[0].instanceId },
    { sessionId: 'newcomer-1', origin: 'grant', approvedBy: '主机甲', instanceId: 'inst-self' },
    '批准人取回执帧的 from（join-grant 不携 approvedBy）',
  );
  assert.equal(made.service.join.isGranted('collab-remote', 'newcomer-1'), true);
  assert.deepEqual(applicationsOf(made.dir), [], '回执落地即删申请记录');
  const binding = made.bindings.get('collab-remote');
  assert.equal(binding.sessionId, 'newcomer-1');
  assert.equal(binding.origin, 'grant');
  assert.equal(binding.bridgeId, 'newcomer-1', '会话离线（无桥可查）＝沿用会话标识作出处记录');
  assert.deepEqual(made.opened, [{ root: 'main', id: 'collab-remote' }]);
  /* 离线会话＝写持久映射、重开即活跃（注册表桩：绑定的活跃判定只认会话标识）。 */
  assert.equal(bindingIsActive(binding, { find: () => null }), false, '会话不在场＝绑定休眠（不注入）');
  assert.equal(
    bindingIsActive(binding, { find: (sessionId) => (sessionId === 'newcomer-1' ? { bridgeId: 'bridge-1', sessionId } : null) }),
    true,
    '会话重开（重新注册）＝绑定即活跃（重开即活）',
  );
  const listed = made.service.list({ sessionId: 'newcomer-1' }).collabs.find((entry) => entry.collabId === 'collab-remote');
  assert.equal(listed.sessionGranted, true);
  assert.equal(listed.sessionBound, true);
});

test('join-grant 的比对：无记录 / 站长实例不符 / 帧标识不符 / 授权会话不符 / 已过期一律不落地', async (t) => {
  const made = makeService(t);
  await activeMemberCollab(t, made, 'collab-remote');
  const writeOnly = (frame) => made.service.hooks.consume(frame, { remoteAddress: '127.0.0.1' });
  await writeOnly(grantFrame('collab-remote', 'newcomer-1', 'msg-never-applied'));
  assert.deepEqual(approvalsOf(made.dir, 'collab-remote'), [], '无申请记录＝伪造回执无从凭空造获准');
  assert.equal(made.bindings.get('collab-remote'), null);
  await made.service.join.request({ collabId: 'collab-remote', sessionId: 'newcomer-1' });
  const reqMsgId = applicationsOf(made.dir)[0].msgId;
  await writeOnly(grantFrame('collab-remote', 'newcomer-1', reqMsgId, peer('inst-forged', '冒充者', 17999)));
  await writeOnly(grantFrame('collab-remote', 'newcomer-1', `${reqMsgId}-x`));
  await writeOnly(grantFrame('collab-remote', 'newcomer-other', reqMsgId));
  assert.deepEqual(approvalsOf(made.dir, 'collab-remote'), [], '三种不符（站长实例 / 帧标识 / 授权会话）都不落地');
  assert.equal(applicationsOf(made.dir).length, 1, '不落地即不动申请台账（有效申请仍待决）');
  assert.equal(made.bindings.get('collab-remote'), null);

  const expired = makeService(t, { config: { joinRequestTtlMs: 10 } });
  await activeMemberCollab(t, expired, 'collab-remote');
  await expired.service.join.request({ collabId: 'collab-remote', sessionId: 'newcomer-1' });
  const lateId = applicationsOf(expired.dir)[0].msgId;
  await new Promise((resolve) => setTimeout(resolve, 30));
  await expired.service.hooks.consume(grantFrame('collab-remote', 'newcomer-1', lateId), { remoteAddress: '127.0.0.1' });
  assert.deepEqual(approvalsOf(expired.dir, 'collab-remote'), [], '过期回执不再受理（与准入门同一时限基准）');
  assert.equal(expired.bindings.get('collab-remote'), null);
});

test('join-deny 到达：删申请记录＋本机提示呈现拒绝与原因；记录删后迟到副本不再重复呈现', async (t) => {
  const made = makeService(t);
  await activeMemberCollab(t, made, 'collab-remote');
  await made.service.join.request({ collabId: 'collab-remote', sessionId: 'newcomer-1' });
  const reqMsgId = applicationsOf(made.dir)[0].msgId;
  await made.service.hooks.consume(denyFrame('collab-remote', reqMsgId, '本期不再纳新'), { remoteAddress: '127.0.0.1' });
  assert.deepEqual(applicationsOf(made.dir), [], '拒绝即删申请记录');
  assert.equal(made.notices.length, 1);
  assert.equal(made.notices[0].collabId, 'collab-remote');
  assert.equal(made.notices[0].payload.event, 'local-alert', '沿既有本机提示先例（notice + local-alert）');
  assert.match(made.notices[0].payload.text, /拒绝/);
  assert.match(made.notices[0].payload.text, /本期不再纳新/);
  assert.equal(made.bindings.get('collab-remote'), null);
  await made.service.hooks.consume(denyFrame('collab-remote', reqMsgId), { remoteAddress: '127.0.0.1' });
  assert.equal(made.notices.length, 1, '记录已删：迟到的重发副本不再重复呈现');
});

/* —— 站长侧：待批准面（入站 join-request）与批准 / 拒绝回执 —— */

test('站长侧：join-request 入站 → 待批准面；批准＝写本机批准记录＋回 join-grant（携授权会话与申请帧标识）＋出待批准面', async (t) => {
  const made = makeService(t);
  const created = made.service.create({ name: '自建项目', topic: '主题', targets: [endpoint('inst-b', '主机乙')] });
  const admitted = await receive(made.service, joinRequestFrame(created.collabId, 'remote-7'), '127.0.0.2');
  assert.equal(admitted.ok, true, admitted.reason);
  const pending = made.service.join.pendingJoinsOf(created.collabId);
  assert.equal(pending.length, 1);
  assert.deepEqual(
    { instanceId: pending[0].instanceId, identityName: pending[0].identityName, sessionId: pending[0].sessionId },
    { instanceId: 'inst-b', identityName: '主机乙', sessionId: 'remote-7' },
  );
  const approved = made.service.join.approve({ collabId: created.collabId, sessionId: 'remote-7', approve: true, approvedBy: 'session-a' });
  assert.equal(approved.ok, true, approved.message);
  const grants = sentOf(made.direct, 'join-grant');
  assert.equal(grants.length, 1);
  assert.deepEqual(grants[0].to, { instanceId: 'inst-b', address: '127.0.0.2', port: 17400 }, '回执直投申请人（端点由入站帧学习）');
  assert.equal(grants[0].payload.sessionId, 'remote-7', '回执携授权会话（确认授予对象）');
  assert.equal(grants[0].payload.reqMsgId, pending[0].reqMsgId, '回执携申请帧标识（决定与申请对上）');
  assert.match(grants[0].payload.reqMsgId, /^msg-req-\d+$/);
  assert.deepEqual(made.service.join.pendingJoinsOf(created.collabId), [], '批准即出待批准面');
  assert.deepEqual(approvalsOf(made.dir, created.collabId).map((entry) => entry.sessionId), ['remote-7'], '站长机记全体批准记录');
  assert.equal(made.bindings.get(created.collabId), null, '远端申请人不占本机绑定（接线在申请人机器）');
});

test('站长侧：短码（唯一前缀）可用、歧义拒；拒绝＝回 join-deny（含原因）并出待批准面', async (t) => {
  const made = makeService(t);
  const created = made.service.create({ name: '自建项目', topic: '主题', targets: [endpoint('inst-b', '主机乙')] });
  await receive(made.service, joinRequestFrame(created.collabId, 'remote-1'), '127.0.0.2');
  await receive(made.service, joinRequestFrame(created.collabId, 'remote-2', peer('inst-c', '主机丙', 17500)), '127.0.0.3');
  const ambiguous = made.service.join.approve({ collabId: created.collabId, sessionId: 'remote-', approve: true, approvedBy: 'session-a' });
  assert.equal(ambiguous.ok, false, '短码歧义＝无从判定该批哪一个');
  const denied = made.service.join.approve({ collabId: created.collabId, sessionId: 'remote-', approve: false, approvedBy: 'session-a' });
  assert.equal(denied.ok, false, '歧义在拒绝面同样拒');
  await receive(made.service, joinRequestFrame(created.collabId, 'remote-3', peer('inst-d', '主机丁', 17600)), '127.0.0.4');
  assert.deepEqual(made.service.join.pendingJoinsOf(created.collabId).map((entry) => entry.sessionId), ['remote-1', 'remote-2', 'remote-3']);
  const one = made.service.join.approve({ collabId: created.collabId, sessionId: 'remote-1', approve: false, approvedBy: 'session-a', reason: '名额已满' });
  assert.equal(one.ok, true, one.message);
  const denies = sentOf(made.direct, 'join-deny');
  assert.equal(denies.length, 1);
  assert.equal(denies[0].payload.reason, '名额已满');
  assert.deepEqual(denies[0].to, { instanceId: 'inst-b', address: '127.0.0.2', port: 17400 }, '回执投该申请者（同名机器各有自己的端点）');
  assert.deepEqual(made.service.join.pendingJoinsOf(created.collabId).map((entry) => entry.sessionId), ['remote-2', 'remote-3']);
});

test('站长侧：非站长机器收到 join-request 不落待批准面（批准权不随数据副本走）', async (t) => {
  const made = makeService(t);
  await activeMemberCollab(t, made, 'collab-remote');
  const admitted = await receive(made.service, joinRequestFrame('collab-remote', 'remote-7'), '127.0.0.2');
  assert.equal(admitted.ok, true, admitted.reason);
  assert.deepEqual(made.service.join.pendingJoinsOf('collab-remote'), []);
  assert.deepEqual(pendingOf(made.dir, 'collab-remote'), [], '不落待批准');
});

test('处置与敲门的异常面：敲门抛错 / 网络面拒绝 / 无批准权 / 旧记录缺帧标识 / 回执面缺失各如实报错', async (t) => {
  const thrown = makeService(t, {
    requestJoin: async () => {
      throw new Error('UDP 不可用');
    },
  });
  const failed = await thrown.service.join.request({ name: '联调讨论', sessionId: 'forumses-1' });
  assert.equal(failed.ok, false);
  assert.match(failed.message, /UDP 不可用/, '敲门异常不吞原因');
  const refused = makeService(t, { requestJoin: async () => ({ ok: false, message: '局域网功能不可用' }) });
  const down = await refused.service.join.request({ name: '联调讨论', sessionId: 'forumses-1' });
  assert.equal(down.ok, false);
  assert.equal(down.message, '局域网功能不可用');
  /* 本机是成员（非站长）：无批准权（批准权不随数据副本走）。 */
  const member = makeService(t);
  await activeMemberCollab(t, member, 'collab-remote');
  await receive(member.service, joinRequestFrame('collab-remote', 'remote-7'), '127.0.0.2');
  const noPower = member.service.join.approve({ collabId: 'collab-remote', sessionId: 'remote-7', approve: true, approvedBy: 'session-a' });
  assert.equal(noPower.ok, false);
  assert.match(noPower.message, /不是该协作的站长/);
  /* 旧记录缺申请帧标识（回执无从对上申请）：如实拒，不臆造回执。 */
  const legacy = makeService(t);
  const created = legacy.service.create({ name: '自建项目', topic: '主题', targets: [endpoint('inst-b', '主机乙')] });
  await receive(legacy.service, joinRequestFrame(created.collabId, 'remote-7'), '127.0.0.2');
  const seeded = JSON.parse(readFileSync(joinsFilePath(legacy.dir, created.collabId), 'utf8'));
  seeded.pendingJoins = seeded.pendingJoins.map(({ reqMsgId: _dropped, ...rest }) => rest);
  writeFileSync(joinsFilePath(legacy.dir, created.collabId), JSON.stringify(seeded));
  const legacyApprove = legacy.service.join.approve({ collabId: created.collabId, sessionId: 'remote-7', approve: true, approvedBy: 'session-a' });
  assert.equal(legacyApprove.ok, false);
  assert.match(legacyApprove.message, /缺申请帧标识/);
  /* 会话标识形态非法（非标识）＝没有该待批准。 */
  const malformed = legacy.service.join.approve({ collabId: created.collabId, sessionId: 'remote 7', approve: true, approvedBy: 'session-a' });
  assert.equal(malformed.ok, false);
  assert.match(malformed.message, /没有待批准/);
  /* 回执面缺失（直投面未注入）：不落处置（待批准面保留以便重试）。 */
  const directless = makeService(t, { sendDirect: null });
  const held = directless.service.create({ name: '自建项目', topic: '主题', targets: [endpoint('inst-b', '主机乙')] });
  await receive(directless.service, joinRequestFrame(held.collabId, 'remote-7'), '127.0.0.2');
  const noReplyFace = directless.service.join.approve({ collabId: held.collabId, sessionId: 'remote-7', approve: true, approvedBy: 'session-a' });
  assert.equal(noReplyFace.ok, false);
  assert.match(noReplyFace.message, /直投面不可用/);
  assert.equal(directless.service.join.pendingJoinsOf(held.collabId).length, 1, '未落处置＝待批准面保留');
  assert.deepEqual(approvalsOf(directless.dir, held.collabId), [], '批准记录不落（回执发不出去＝没批准）');
});

/* —— 待批准提供方：时限剪除与未知协作 —— */

test('pendingJoinsOf：未知协作返空数组；过期待批准按申请时限剪除（剪除即落盘）', async (t) => {
  let clockMs = Date.now();
  const made = makeService(t, { now: () => clockMs, config: { joinRequestTtlMs: 1000 } });
  const created = made.service.create({ name: '自建项目', topic: '主题', targets: [endpoint('inst-b', '主机乙')] });
  assert.deepEqual(made.service.join.pendingJoinsOf('collab-unknown'), []);
  assert.deepEqual(made.service.join.pendingJoinsOf(), []);
  await made.service.join.request({ collabId: created.collabId, sessionId: 'newcomer-1' });
  assert.equal(made.service.join.pendingJoinsOf(created.collabId).length, 1);
  clockMs += 5000;
  assert.deepEqual(made.service.join.pendingJoinsOf(created.collabId), [], '过期待批准不再进面（门只数不筛）');
  assert.deepEqual(pendingOf(made.dir, created.collabId), [], '剪除即落盘');
  assert.deepEqual(made.service.list().collabs[0].pendingJoins, [], '展示面同步清空');
});

/* —— 讨论直连分支（模式＝forum） —— */

test('讨论分支（在席）：本机接线立即生效（写绑定 origin:join、无批准门），零网络帧', async (t) => {
  const made = makeService(t);
  const created = made.service.create({ name: '联调讨论', topic: '主题', mode: 'forum', targets: [endpoint('inst-b', '主机乙')] });
  assert.equal(created.ok, true, created.message);
  made.opened.length = 0;   // 建协的触发 A 已记账：本用例只判讨论接线那一支（不开页）
  const result = await made.service.join.request({ name: '联调讨论', sessionId: 'forumses-1' });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.bound, true, '在席＝接线立即（无批准门）');
  const binding = made.bindings.get(created.collabId);
  assert.equal(binding.sessionId, 'forumses-1');
  assert.equal(binding.origin, 'join');
  assert.deepEqual(sentOf(made.direct, 'join-request'), [], '讨论不经申请帧');
  assert.deepEqual(made.opened, [], '讨论接线不开协作页（无「进入即见」要求）');
  assert.equal(made.service.list({ sessionId: 'forumses-1' }).collabs[0].sessionBound, true);
});

test('讨论分支（未在席）：按名敲门封装（复用敲门原语）——有应答＝等待放行，无应答如实明示', async (t) => {
  const knocked = [];
  const made = makeService(t, {
    requestJoin: async ({ name }) => {
      knocked.push(name);
      return { ok: true, replies: [{ collabId: 'collab-f', name, memberCount: 3, originator: peer('inst-a', '主机甲') }] };
    },
  });
  const result = await made.service.join.request({ name: '联调讨论', sessionId: 'forumses-1' });
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(knocked, ['联调讨论'], '敲门原语复用（广播按名）');
  assert.equal(result.knocked, true);
  assert.equal(result.replies.length, 1);
  assert.match(result.note, /等待放行/);
  assert.equal(made.bindings.entries().length, 0, '放行在同意门：未放行前不接线');

  const silent = makeService(t, { requestJoin: async () => ({ ok: true, replies: [] }) });
  const none = await silent.service.join.request({ name: '联调讨论', sessionId: 'forumses-1' });
  assert.equal(none.ok, true);
  assert.deepEqual(none.replies, []);
  assert.match(none.note, /无人|无应答/);
});

test('申请（已归档）：在册但已退出的协作不再纳新（如实拒，不落待批准面）', async (t) => {
  const made = makeService(t);
  await activeMemberCollab(t, made, 'collab-left');
  const left = await made.service.leave({ collabId: 'collab-left' });
  assert.equal(left.ok, true, left.message);
  const result = await made.service.join.request({ collabId: 'collab-left', sessionId: 'newcomer-1' });
  assert.equal(result.ok, false);
  assert.match(result.message, /已结束|已退出/);
  assert.deepEqual(made.service.join.pendingJoinsOf('collab-left'), [], '不落待批准面');
});

test('讨论分支（已归档）：在册但已退出 = 不再纳新（如实拒）', async (t) => {
  const made = makeService(t);
  const created = made.service.create({ name: '联调讨论', topic: '主题', mode: 'forum', targets: [endpoint('inst-b', '主机乙')] });
  const left = await made.service.leave({ collabId: created.collabId });
  assert.equal(left.ok, true, left.message);
  const result = await made.service.join.request({ name: '联调讨论', sessionId: 'forumses-1' });
  assert.equal(result.ok, false);
  assert.match(result.message, /已结束|已退出/);
  assert.notEqual(made.bindings.get(created.collabId)?.sessionId, 'forumses-1', '已归档的讨论不给接线');
});

/* —— 按名解析（发现层的 onJoinResolve 注入面：组合根提供的命中回调） —— */

test('resolveJoinTarget / joinResolve：按名匹配本机 managed 在册协作；同名多义 / 无匹配 / 讨论同名一律未命中', async (t) => {
  const collabs = new Map([
    ['collab-a1', managerLocalOf('collab-a1', '联调项目')],
    ['collab-a2', managerLocalOf('collab-a2', '联调项目')],
    ['collab-b1', managerLocalOf('collab-b1', '独占项目')],
    ['collab-c1', managerLocalOf('collab-c1', '联调讨论', 'forum')],
    ['collab-d1', managerLocalOf('collab-d1', '已结束项目', 'managed', 'completed')],
  ]);
  assert.deepEqual(resolveJoinTarget({ collabs }, { name: '无此项目' }), { found: false });
  assert.deepEqual(resolveJoinTarget({ collabs }, { name: '联调项目' }), { found: false }, '同名多义＝申请人无从判定该进哪一个');
  assert.deepEqual(resolveJoinTarget({ collabs }, { name: '联调讨论' }), { found: false }, '解析面只认协作（managed）——讨论的加入走敲门');
  assert.deepEqual(resolveJoinTarget({ collabs }, { name: '已结束项目' }), { found: false }, '已结束的协作不再纳新（不该把人引向死路）');
  assert.deepEqual(resolveJoinTarget({ collabs }, { name: '' }), null, '无效请求不应答（缺省＝本机没有解析面）');
  const unique = resolveJoinTarget({ collabs }, { name: '独占项目' });
  assert.deepEqual(unique, { found: true, collabId: 'collab-b1', name: '独占项目' }, '命中必携合法 collabId（协议层硬约束）');

  const made = makeService(t);
  const created = made.service.create({ name: '独占项目', topic: '主题', targets: [endpoint('inst-b', '主机乙')] });
  assert.deepEqual(made.service.joinResolve({ name: '独占项目' }), { found: true, collabId: created.collabId, name: '独占项目' });
  assert.deepEqual(made.service.joinResolve({ name: '无此项目' }), { found: false }, '未命中一律不带 collabId / name');
});

function managerLocalOf(collabId, name, mode = 'managed', status = 'proposed') {
  return { collabId, role: 'manager', ledger: { name, mode, status }, member: { state: 'active' } };
}

/* —— 真核 e2e（本机自批链） —— */

async function startCoreOnTempRoot(t, home) {
  writeFileSync(join(home, CONFIG_FILE_NAME), JSON.stringify({ port: await pickFreePort(), identityName: '本机', viewerAutoOpen: false }, null, 2));
  const started = await startCore({ env: { ...process.env, WAYSTATION_HOME: home } });
  assert.equal(started.ok, true, started.message ?? '核心启动');
  t.after(() => started.core.stop());
  return { record: JSON.parse(readFileSync(coreJsonPath(home), 'utf8')), core: started.core };
}

function bridgeClientFor(home, record, { bridgeId, sessionId }) {
  const frames = [];
  const client = createIpcClient({
    dataDir: home,
    hello: { app: record.appVersion, token: record.token, bridgeId, sessionId },
    onFrame: (frame) => {
      frames.push(frame);
      if (frame.type === 'push') {
        client.send({ type: 'delivered', pushId: frame.pushId, ok: true });
      }
    },
    onClose: () => {},
  });
  return { client, frames };
}

async function callAndWait(entry, tool, args) {
  const id = randomUUID();
  entry.client.send({ type: 'call', id, tool, args });
  await waitFor(() => entry.frames.some((frame) => frame.type === 'result' && frame.id === id), { timeoutMs: 10000 });
  return JSON.parse(entry.frames.find((frame) => frame.type === 'result' && frame.id === id).content[0].text);
}

/* 真 TCP 入站探针：向核心端口发一行协作域帧（真实接收管线：准入 → 落盘 → 消费 → 按绑定注入会话）。
 * 对端身份取自探针自身（非本机），故不经「from===self」的自报面。 */
function sendInboundFrame(port, frame) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(`${JSON.stringify(frame)}\n`);
    });
    socket.once('error', () => resolve(false));
    socket.once('data', () => {
      socket.end();
      resolve(true);
    });
    socket.setTimeout(4000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/* 按名解析探针：真 UDP 数据报问核心「谁在 <name> 协作」（组合根注入的命中回调应答）。 */
function askJoinResolve(port, name) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    let timer = null;
    const done = (value) => {
      if (timer !== null) {
        clearTimeout(timer);
      }
      socket.close();
      resolve(value);
    };
    const request = Buffer.from(JSON.stringify({ v: 1, type: 'join-resolve', resolveId: `resolve-${seq++}`, name }));
    socket.once('message', (message) => done(JSON.parse(message.toString('utf8'))));
    socket.once('error', () => done(null));
    timer = setTimeout(() => done(null), 3000);
    socket.send(request, port, '127.0.0.1');
  });
}

/* 注入探针：真 TCP 帧走完整接收管线（准入 → 落盘 → 消费 → 按绑定投该会话的桥），
 * 返回到达该会话的那条 push（未到达即超时抛错）。 */
async function injectedPushOf(core, entry, collabId, peerPort) {
  const probe = {
    v: 1,
    type: 'reply',
    msgId: `msg-probe-${randomUUID()}`,
    from: { instanceId: 'inst-probe', identityName: '探针机', port: peerPort },
    collabId,
    ts: new Date().toISOString(),
    payload: { text: '注入探针' },
  };
  assert.equal(await sendInboundFrame(core.port, probe), true, '入站帧被受理（ack 回程）');
  await waitFor(() => (entry.frames.some((frame) => frame.type === 'push' && frame.collabId === collabId) ? true : null), { timeoutMs: 10000 });
  return entry.frames.find((frame) => frame.type === 'push' && frame.collabId === collabId);
}

test('真核 e2e（本机自批链）：建协 → 新会话申请 → 待批准面 → 批准 → 接线 → 注入到达该会话', { timeout: 90000 }, async (t) => {
  const home = makeTempDir(t);
  const { record, core } = await startCoreOnTempRoot(t, home);
  const peerPort = await pickFreePort();
  const owner = bridgeClientFor(home, record, { bridgeId: 'bridge-a', sessionId: 'session-a' });
  const fresh = bridgeClientFor(home, record, { bridgeId: 'bridge-b', sessionId: 'session-b' });
  t.after(async () => {
    for (const entry of [owner, fresh]) {
      await entry.client.close().catch(() => {});
    }
  });
  await owner.client.connect();
  await fresh.client.connect();
  const created = await callAndWait(owner, 'ws_create_collab', {
    name: '进程内环', topic: '主题', targets: [{ instanceId: 'inst-peer', identityName: '对端', address: '127.0.0.1', port: peerPort }],
  });
  assert.equal(created.ok, true, created.message);
  /* 建协即默认静音（注入栅栏）：本链路验的是「按绑定注入」而非静音，先取消静音；
   * 静音切换本身会经调用者桥投一行摘要，故两侧已收帧一并清空，后续断言只判接线后的注入。 */
  const unmuted = await callAndWait(owner, 'ws_set_mute', { collabId: created.collabId, muted: false });
  assert.equal(unmuted.ok, true, unmuted.message);
  owner.frames.length = 0;
  fresh.frames.length = 0;
  /* 新会话申请（本机即站长：直落本机待批准面，不经网络帧）→ 站长侧待批准面（经真 IPC 工具面取数）。 */
  const requested = await core.context.collab.join.request({ collabId: created.collabId, sessionId: 'session-b' });
  assert.equal(requested.ok, true, requested.message);
  assert.equal(requested.local, true);
  const listed = await callAndWait(owner, 'ws_list_collabs', {});
  const entry = listed.collabs.find((row) => row.collabId === created.collabId);
  assert.deepEqual(entry.pendingJoins.map((row) => row.sessionId), ['session-'], '待批准面在清单里可见（短码）');
  /* 批准 → 接线（写绑定）→ 该会话视角两字段齐真、异会话不随之绑定。 */
  const approved = core.context.collab.join.approve({ collabId: created.collabId, sessionId: 'session-b', approve: true, approvedBy: 'session-a' });
  assert.equal(approved.ok, true, approved.message);
  await waitFor(() => (JSON.parse(readFileSync(bindingsFilePath(home), 'utf8'))[created.collabId]?.sessionId === 'session-b' ? true : null), { timeoutMs: 10000 });
  const asFresh = await callAndWait(fresh, 'ws_list_collabs', {});
  const freshEntry = asFresh.collabs.find((row) => row.collabId === created.collabId);
  assert.equal(freshEntry.sessionGranted, true, '获准（本会话）');
  assert.equal(freshEntry.sessionBound, true, '接线（本会话）');
  const asOwner = await callAndWait(owner, 'ws_list_collabs', {});
  assert.equal(asOwner.collabs.find((row) => row.collabId === created.collabId).sessionBound, false, '异会话不随之绑定');
  /* 注入到达该会话（只投绑定会话）。 */
  const injected = await injectedPushOf(core, fresh, created.collabId, peerPort);
  assert.match(injected.text, /注入探针/, '注入文本经核心渲染到达该会话');
  assert.equal(owner.frames.some((frame) => frame.type === 'push' && frame.collabId === created.collabId), false, '注入只投绑定会话');
});

test('真核 e2e（按名解析）：组合根注入的命中回调应答本机在册协作；未命中一律不点名', { timeout: 60000 }, async (t) => {
  const home = makeTempDir(t);
  const { record, core } = await startCoreOnTempRoot(t, home);
  const peerPort = await pickFreePort();
  const owner = bridgeClientFor(home, record, { bridgeId: 'bridge-r', sessionId: 'session-r' });
  t.after(async () => {
    await owner.client.close().catch(() => {});
  });
  await owner.client.connect();
  const created = await callAndWait(owner, 'ws_create_collab', {
    name: '解析项目', topic: '主题', targets: [{ instanceId: 'inst-peer', identityName: '对端', address: '127.0.0.1', port: peerPort }],
  });
  assert.equal(created.ok, true, created.message);
  const hit = await askJoinResolve(core.port, '解析项目');
  assert.equal(hit.found, true, '命中应答（按名匹配本机 managed 在册协作）');
  assert.equal(hit.collabId, created.collabId, '命中必携合法协作标识（协议层硬约束）');
  assert.equal(hit.instanceId, core.instanceId, '应答者是本机驿站');
  const miss = await askJoinResolve(core.port, '无此项目');
  assert.equal(miss.found, false, '未命中照答（不是「本机没有解析面」）');
  assert.equal('collabId' in miss, false, '未命中一律不带 collabId / name');
  assert.equal('name' in miss, false);
});

/* —— 修复轮：未在席的批准一并完成入席 / 讨论敲门的本会话接线 / 已接线未获准的守卫 —— */

/* 站长侧批准携带的入席邀请（直投面）转成受邀方收到的帧（from＝站长身份）。 */
function inviteFrameOf(message, station) {
  seq++;
  return {
    v: 1,
    type: 'invite',
    msgId: `msg-seat-${seq}`,
    from: { ...station },
    collabId: message.collabId,
    ts: new Date().toISOString(),
    payload: message.payload,
  };
}

/* 同一数据根上的重建（重开即活与重启无留痕的判别面：注册表加载重跑一遍）。 */
function reloadServiceOf(made) {
  return createCollabService({
    dataDir: made.dir,
    config: made.config,
    self: made.self,
    send: (message) => ({ ok: true, msgId: `q-${message.type}` }),
    sendDirect: () => ({ ok: true, msgId: 'd-1' }),
    knownHosts: { remember: () => {}, lookup: () => undefined },
    notify: () => true,
    log: quietLog(),
    bindings: createBindingStore({ dataDir: made.dir, log: quietLog() }),
    ledgerFetchTimeoutMs: 60,
    inviteMinIntervalMs: 0,
    syncPeerPicker: () => [],
  });
}

test('未在席的批准（站长侧）：先补入席邀请（既有受邀通道、名单含被邀者、指名申请会话）再投批准回执', async (t) => {
  const owner = makeService(t);
  const created = owner.service.create({ name: '远端项目', topic: '主题', targets: [endpoint('inst-b', '主机乙')] });
  await receive(owner.service, joinRequestFrame(created.collabId, 'newcomer-1', peer('inst-c', '主机丙', 17600)), '127.0.0.3');
  const approved = owner.service.join.approve({ collabId: created.collabId, sessionId: 'newcomer-1', approve: true, approvedBy: 'session-a' });
  assert.equal(approved.ok, true, approved.message);
  const invites = sentOf(owner.direct, 'invite');
  assert.equal(invites.length, 1, '未在册的申请人＝批准一并补入席（既有受邀通道）');
  assert.deepEqual(invites[0].to, { instanceId: 'inst-c', address: '127.0.0.3', port: 17600 }, '投申请人机器（端点由入站帧学习）');
  assert.equal(invites[0].payload.name, '远端项目');
  assert.equal(invites[0].payload.members.some((row) => row.instanceId === 'inst-c'), true, '名单含被邀者（受邀准入的准入判据）');
  assert.equal(invites[0].payload.targetSessionId, 'newcomer-1', '指名申请会话（点头权归它）');
  const grants = sentOf(owner.direct, 'join-grant');
  assert.equal(grants.length, 1, '授权回执照发');
  assert.equal(owner.direct.findIndex((row) => row.type === 'invite') < owner.direct.findIndex((row) => row.type === 'join-grant'), true, '先入席、后授权');
  assert.deepEqual(approvalsOf(owner.dir, created.collabId).map((entry) => entry.sessionId), ['newcomer-1'], '站长机记批准记录');
});

test('未在席的批准（申请人机）：受邀通道注册本机协作＋回执落获准与接线——重启零加载留痕（端态＝本机认识该协作）', async (t) => {
  const owner = makeService(t);
  const created = owner.service.create({ name: '远端项目', topic: '主题', targets: [endpoint('inst-b', '主机乙')] });
  await receive(owner.service, joinRequestFrame(created.collabId, 'newcomer-1', peer('inst-c', '主机丙', 17600)), '127.0.0.3');
  owner.service.join.approve({ collabId: created.collabId, sessionId: 'newcomer-1', approve: true, approvedBy: 'session-a' });
  const seatInvite = sentOf(owner.direct, 'invite')[0];
  /* 申请人机：按名解析得 collabId → 直投申请（未在席：本机无该协作记录）。 */
  const applicant = makeService(t, {
    self: peer('inst-c', '主机丙', 17600),
    requestJoinResolve: async () => ({ ok: true, reply: { found: true, collabId: created.collabId, responder: { instanceId: 'inst-self', identityName: '本机', address: '127.0.0.1', port: 17321 } } }),
  });
  const asked = await applicant.service.join.request({ name: '远端项目', target: { address: '127.0.0.1', port: 17321 }, sessionId: 'newcomer-1' });
  assert.equal(asked.ok, true, asked.message);
  assert.equal(applicant.service.list().collabs.length, 0, '申请先于入席：本机尚无该协作记录');
  /* 站长的入席邀请到达（受邀准入路径注册本机协作与成员记录）→ 批准回执落地（获准＋接线）。 */
  const admitted = await receive(applicant.service, inviteFrameOf(seatInvite, peer('inst-self', '本机')), '127.0.0.1');
  assert.equal(admitted.ok, true, admitted.reason);
  assert.equal(applicant.service.list().collabs.length, 1, '受邀准入路径＝机器入席（既有机制复用）');
  const reqMsgId = applicationsOf(applicant.dir)[0].msgId;
  await applicant.service.hooks.consume(grantFrame(created.collabId, 'newcomer-1', reqMsgId, peer('inst-self', '本机')), { remoteAddress: '127.0.0.1' });
  assert.deepEqual(applicationsOf(applicant.dir), [], '回执落地即删申请记录');
  assert.equal(applicant.service.join.isGranted(created.collabId, 'newcomer-1'), true);
  assert.equal(applicant.bindings.get(created.collabId).sessionId, 'newcomer-1');
  assert.deepEqual(applicant.opened, [{ root: 'main', id: created.collabId }]);
  const reloaded = reloadServiceOf(applicant);
  assert.equal(reloaded.stats().loadFailures, 0, '端态＝本机认识该协作（协作目录完整，重启零加载留痕）');
  assert.equal(reloaded.stats().collabs, 1, '成员记录在场（不是只有 joins.json 的空壳目录）');
});

test('未在席的批准（站长侧）：申请人机器已在册＝不补入席邀请（在席机器的新窗口照旧只收回执）', async (t) => {
  const owner = makeService(t);
  const created = owner.service.create({
    name: '在册项目',
    topic: '主题',
    targets: [endpoint('inst-b', '主机乙'), endpoint('inst-c', '主机丙', '127.0.0.3', 17600)],
  });
  await receive(owner.service, joinRequestFrame(created.collabId, 'newcomer-1', peer('inst-c', '主机丙', 17600)), '127.0.0.3');
  const approved = owner.service.join.approve({ collabId: created.collabId, sessionId: 'newcomer-1', approve: true, approvedBy: 'session-a' });
  assert.equal(approved.ok, true, approved.message);
  assert.deepEqual(sentOf(owner.direct, 'invite'), [], '已在册（台账名单含该机器）＝不再邀请');
  assert.equal(sentOf(owner.direct, 'join-grant').length, 1);
});

test('讨论敲门登记：本机收到该讨论的邀请并同意后，请求会话随同意门接线（本会话接线语义）', async (t) => {
  const made = makeService(t, {
    requestJoin: async ({ name }) => ({ ok: true, replies: [{ collabId: 'collab-f', name, memberCount: 2, originator: peer('inst-a', '主机甲') }] }),
  });
  const knocked = await made.service.join.request({ name: '联调讨论', sessionId: 'forumses-1' });
  assert.equal(knocked.ok, true, knocked.message);
  assert.equal(made.bindings.entries().length, 0, '未放行前不接线');
  /* 放行者（另一端）发来讨论邀请：本机注册协作；同意门落地时请求会话接线。 */
  const admitted = await receive(made.service, inviteFrame({ collabId: 'collab-f', name: '联调讨论', mode: 'forum' }), '127.0.0.1');
  assert.equal(admitted.ok, true, admitted.reason);
  const approved = await made.service.approve({ collabId: 'collab-f', approve: true });
  assert.equal(approved.ok, true, approved.message);
  assert.equal(approved.joined, true, '既有同意门行为不动');
  await new Promise((resolve) => setTimeout(resolve, 10));   // 接线在同意门之后（宏任务让位：写点先落放行者席位）
  const binding = made.bindings.get('collab-f');
  assert.equal(binding.sessionId, 'forumses-1', '请求会话持席（加入后本会话接线）');
  assert.equal(binding.origin, 'join');
  assert.equal(made.service.list({ sessionId: 'forumses-1' }).collabs[0].sessionBound, true);
});

test('讨论敲门登记：无登记的讨论同意后不额外接线（既有行为不动）', async (t) => {
  const made = makeService(t);
  await receive(made.service, inviteFrame({ collabId: 'collab-g', name: '旁路讨论', mode: 'forum' }), '127.0.0.1');
  const approved = await made.service.approve({ collabId: 'collab-g', approve: true });
  assert.equal(approved.ok, true, approved.message);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(made.bindings.entries().length, 0, '无登记＝不接线（服务面无写点时零绑定）');
});

/* —— 修复轮：获准入账失败的守卫（杜绝「已接线未获准」） —— */

test('批准（本机自批）：获准条目形态不符＝不写绑定、不删待批准（杜绝已接线未获准）', async (t) => {
  const clock = { skew: 0 };
  const made = makeService(t, { now: () => 1700000000000 + clock.skew });
  const created = made.service.create({ name: '自建项目', topic: '主题', targets: [endpoint('inst-b', '主机乙')] });
  await made.service.join.request({ collabId: created.collabId, sessionId: 'newcomer-1' });
  assert.equal(made.service.join.pendingJoinsOf(created.collabId).length, 1);
  clock.skew = 0.5;   // 获准时刻形态不符（毫秒整数判据）＝入账被拒
  const approved = made.service.join.approve({ collabId: created.collabId, sessionId: 'newcomer-1', approve: true, approvedBy: 'session-a' });
  assert.equal(approved.ok, false, '未入账即不得接线');
  assert.equal(made.bindings.get(created.collabId), null, '不写绑定（已接线未获准态不成立）');
  assert.deepEqual(approvalsOf(made.dir, created.collabId), []);
  assert.equal(made.service.join.pendingJoinsOf(created.collabId).length, 1, '待批准面保留（可重试）');
  clock.skew = 0;
  const retried = made.service.join.approve({ collabId: created.collabId, sessionId: 'newcomer-1', approve: true, approvedBy: 'session-a' });
  assert.equal(retried.ok, true, '形态恢复后可重试落地');
  assert.equal(made.bindings.get(created.collabId).sessionId, 'newcomer-1');
  assert.equal(made.service.list({ sessionId: 'newcomer-1' }).collabs[0].sessionBound, true);
});

test('join-grant：获准条目形态不符＝不写绑定、不删申请记录（回执不作数，申请仍待决）', async (t) => {
  const clock = { skew: 0 };
  const made = makeService(t, { now: () => 1700000000000 + clock.skew });
  await activeMemberCollab(t, made, 'collab-remote');
  made.opened.length = 0;
  await made.service.join.request({ collabId: 'collab-remote', sessionId: 'newcomer-1' });
  const reqMsgId = applicationsOf(made.dir)[0].msgId;
  clock.skew = 0.5;
  await made.service.hooks.consume(grantFrame('collab-remote', 'newcomer-1', reqMsgId), { remoteAddress: '127.0.0.1' });
  assert.equal(made.bindings.get('collab-remote'), null, '未获准即不接线');
  assert.deepEqual(approvalsOf(made.dir, 'collab-remote'), []);
  assert.equal(applicationsOf(made.dir).length, 1, '申请记录保留（回执未落地）');
  assert.deepEqual(made.opened, [], '不开窗');
});

/* —— 修复轮：守卫 / 错误分支覆盖 —— */

test('申请（异常面·续）：按名解析抛错 / 应答形态不全 / 站长端点未知 / 绑定表缺位各如实报错', async (t) => {
  const boom = makeService(t, {
    requestJoinResolve: async () => {
      throw new Error('UDP 坏掉了');
    },
  });
  const failed = await boom.service.join.request({ name: '远端项目', target: { address: '127.0.0.2', port: 17500 }, sessionId: 'newcomer-1' });
  assert.equal(failed.ok, false);
  assert.match(failed.message, /UDP 坏掉了/, '解析异常不吞原因');
  const partial = makeService(t, {
    requestJoinResolve: async () => ({ ok: true, reply: { found: true, collabId: 'collab-far' } }),
  });
  const incomplete = await partial.service.join.request({ name: '远端项目', target: { address: '127.0.0.2', port: 17500 }, sessionId: 'newcomer-1' });
  assert.equal(incomplete.ok, false);
  assert.match(incomplete.message, /形态不全/, '应答者实例缺失＝无从寻址');
  /* 在席机器但站长端点未知（受邀帧不带来源地址）：如实报端点未知，不投帧。 */
  const noEndpoint = makeService(t);
  await receive(noEndpoint.service, inviteFrame({ collabId: 'collab-noep' }), '');
  const unmapped = await noEndpoint.service.join.request({ collabId: 'collab-noep', sessionId: 'newcomer-1' });
  assert.equal(unmapped.ok, false);
  assert.match(unmapped.message, /端点未知/);
  assert.equal(sentOf(noEndpoint.direct, 'join-request').length, 0);
  /* 绑定表未注入：讨论在席的接线未落地＝如实报错（不是假成功）。 */
  const bare = makeService(t, { bindings: null });
  const forum = bare.service.create({ name: '联调讨论', topic: '主题', mode: 'forum', targets: [endpoint('inst-b', '主机乙')] });
  const unbound = await bare.service.join.request({ name: '联调讨论', sessionId: 'forumses-1' });
  assert.equal(unbound.ok, false);
  assert.match(unbound.message, /绑定表/);
  assert.equal(bare.service.list().collabs.find((row) => row.collabId === forum.collabId).sessionBound, false);
});

test('站长侧（异常面·续）：入站申请形态不全 / 端点未学得 / 回执面拒绝各如实处置', async (t) => {
  const made = makeService(t);
  const created = made.service.create({ name: '自建项目', topic: '主题', targets: [endpoint('inst-b', '主机乙')] });
  const broken = joinRequestFrame(created.collabId, 'remote-7');
  broken.payload = {};
  await made.service.hooks.consume(broken, { remoteAddress: '127.0.0.2' });
  assert.deepEqual(made.service.join.pendingJoinsOf(created.collabId), [], '形态不全不落待批准面');
  /* 端点未学得（入站帧不带来源地址）：处置前置拒，待批准面保留。 */
  await receive(made.service, joinRequestFrame(created.collabId, 'remote-9', peer('inst-z', '主机戊', 17900)), '');
  const noTarget = made.service.join.approve({ collabId: created.collabId, sessionId: 'remote-9', approve: true, approvedBy: 'session-a' });
  assert.equal(noTarget.ok, false);
  assert.match(noTarget.message, /端点未知/);
  assert.equal(made.service.join.pendingJoinsOf(created.collabId).length, 1);
  /* 回执面拒绝（直投面返回失败）：未落处置。 */
  const refused = makeService(t, { sendDirect: () => ({ ok: false, reason: '目标为本机实例，拒绝对自己投递' }) });
  const held = refused.service.create({ name: '自建项目', topic: '主题', targets: [endpoint('inst-b', '主机乙')] });
  await receive(refused.service, joinRequestFrame(held.collabId, 'remote-7'), '127.0.0.2');
  const blocked = refused.service.join.approve({ collabId: held.collabId, sessionId: 'remote-7', approve: true, approvedBy: 'session-a' });
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /回执发送失败/);
  assert.equal(refused.service.join.pendingJoinsOf(held.collabId).length, 1);
  /* 获准判据的形态守卫。 */
  assert.equal(made.service.join.isGranted('bad id', 'remote-7'), false);
  assert.equal(made.service.join.isGranted(created.collabId, 'bad id'), false);
  assert.equal(made.service.join.isGranted('collab-ghost', 'remote-7'), false);
});

test('未在席的批准（站长侧）：入席邀请发送失败＝未落处置（待批准面保留，可重试）', async (t) => {
  const refused = makeService(t, { sendDirect: () => ({ ok: false, reason: '对方端点不可达' }) });
  const created = refused.service.create({ name: '远端项目', topic: '主题', targets: [endpoint('inst-b', '主机乙')] });
  await receive(refused.service, joinRequestFrame(created.collabId, 'newcomer-1', peer('inst-c', '主机丙', 17600)), '127.0.0.3');
  const approved = refused.service.join.approve({ collabId: created.collabId, sessionId: 'newcomer-1', approve: true, approvedBy: 'session-a' });
  assert.equal(approved.ok, false);
  assert.match(approved.message, /入席邀请发送失败/);
  assert.match(approved.message, /对方端点不可达/, '原因原样透传');
  assert.equal(refused.service.join.pendingJoinsOf(created.collabId).length, 1, '未落处置＝待批准面保留');
  assert.deepEqual(approvalsOf(refused.dir, created.collabId), [], '批准记录不落');
});

test('讨论敲门登记：放行来得太晚（越过申请时限）＝不再接线（登记过期）', async (t) => {
  let clockMs = 1700000000000;
  const made = makeService(t, {
    now: () => clockMs,
    config: { joinRequestTtlMs: 1000 },
    requestJoin: async ({ name }) => ({ ok: true, replies: [{ collabId: 'collab-f', name, memberCount: 2, originator: peer('inst-a', '主机甲') }] }),
  });
  const knocked = await made.service.join.request({ name: '联调讨论', sessionId: 'forumses-1' });
  assert.equal(knocked.ok, true, knocked.message);
  clockMs += 60000;   // 放行远超申请时限
  const admitted = await receive(made.service, inviteFrame({ collabId: 'collab-f', name: '联调讨论', mode: 'forum' }), '127.0.0.1');
  assert.equal(admitted.ok, true, admitted.reason);
  const approved = await made.service.approve({ collabId: 'collab-f', approve: true });
  assert.equal(approved.ok, true, approved.message);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(made.bindings.entries().length, 0, '登记过期＝不接线（陈旧放行不改席位）');
});
