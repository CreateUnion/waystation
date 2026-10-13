import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { collabFilePath } from '../src/paths.js';
import { makeTempDir, waitFor } from './helpers.js';
import { createCollabService } from '../src/collab/service.js';

/* 中继分发（默认）与直投（降级）的判别用例（设计 §5.2/§5.3/§9.1）：
 * ①三节点中继路径（投稿标记、from 保原作者、全员收敛一致）；②降级（中继不可达 → 当次即直投）；
 * ③恢复（后台检测通过 → 切回中继、计数断言）；④重复分发幂等；⑤端点未知跳过并计数；
 * ⑥与水位拉取正交（离线者照常追平）；⑦降级期直投副本不再转达（设计两可项的选定行为）；
 * ⑧发起人标识传递（邀请载荷 / bundle 元状态两路）；生命周期（发起人退出 → 直投兜底）。
 * 全部经注入缝（假发送 / 虚拟直投线（节点可达性可配）/ 可控探测面）+ 临时目录，不触真实网络。 */

const DAY = 24 * 60 * 60 * 1000;
const SELF_A = { instanceId: 'inst-a', identityName: '主机甲', port: 17321 };
const SELF_B = { instanceId: 'inst-b', identityName: '主机乙', port: 17322 };
const SELF_C = { instanceId: 'inst-c', identityName: '主机丙', port: 17323 };
const SELF_E = { instanceId: 'inst-e', identityName: '主机戊', port: 17324 };
const SEATS = [SELF_A, SELF_B, SELF_C, SELF_E];

function quietLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function targetOf(seat) {
  return { instanceId: seat.instanceId, identityName: seat.identityName, address: addressOf(seat), port: seat.port };
}

function addressOf(self) {
  return `127.0.0.${self.port - 17320}`;
}

function makeService(t, overrides = {}) {
  const dir = makeTempDir(t);
  const sent = [];
  const direct = [];
  const notices = [];
  const service = createCollabService({
    dataDir: dir,
    config: { inviteTtlMs: DAY },
    self: overrides.self,
    send: (message) => {
      sent.push(message);
      return { ok: true, msgId: `q-${sent.length}` };
    },
    sendDirect: overrides.sendDirect ?? ((message) => {
      direct.push(message);
      return { ok: true, msgId: `d-${direct.length}` };
    }),
    probe: overrides.probe ?? null,
    notify: (frame) => {
      notices.push(frame);
    },
    knownHosts: { remember: () => {} },
    log: quietLog(),
    ledgerFetchTimeoutMs: 30,
    inviteMinIntervalMs: 0,
    pullReplyTimeoutMs: 60,
    syncPeerPicker: overrides.syncPeerPicker ?? (() => []),
    syncRequestMax: 50,
    syncMaxSourcesPerCycle: 3,
    joinReplayIntervalsMs: [10, 20],
  });
  return { service, sent, direct, notices, dir, self: overrides.self };
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

let seq = 0;

function collabFrame(type, collabId, from, payload) {
  seq++;
  return {
    v: 1,
    type,
    msgId: `msg-${type}-${seq}`,
    from: { instanceId: from.instanceId, identityName: from.identityName, port: from.port },
    collabId,
    ts: new Date().toISOString(),
    payload,
  };
}

function joinFrameOf(collabId, from) {
  return collabFrame('join', collabId, from, { eventId: randomUUID(), ts: new Date().toISOString() });
}

function forumPostFrame(collabId, from, { postId, seq: postSeq, kind = 'reply', text }) {
  return collabFrame('post', collabId, from, { post: { postId, seq: postSeq, kind, text } });
}

/* 直投帧成形（与 dispatch.frameOf 同口径：message.from 透传——转达帧 from 保原作者；
 * ts 取 createdAt（帖的落盘 ts 随帧携带）、缺省当前时刻）。 */
function wireFrameOf(message, fromSelf, serial) {
  return {
    v: 1,
    type: message.type,
    msgId: `wire-${serial}`,
    from: message.from ?? { instanceId: fromSelf.instanceId, identityName: fromSelf.identityName, port: fromSelf.port },
    collabId: message.collabId,
    ts: typeof message.createdAt === 'string' ? message.createdAt : new Date().toISOString(),
    payload: message.payload,
  };
}

/* 直投虚拟线：可达集合 up 为准——不可达节点按「受理被拒」返回（与真实拨号失败同信号：作者据此
 * 当场降级、中继扇出据实跳过）；送达的帧记下投递目标供断言。 */
function makeWire(up) {
  const nodes = new Map();
  const frames = [];
  let serial = 0;
  return {
    up,
    frames,
    register(self, service) {
      nodes.set(self.instanceId, { self, service });
    },
    sendDirectFor(self) {
      return (message) => {
        serial++;
        const frame = wireFrameOf(message, self, serial);
        const target = nodes.get(message.to.instanceId);
        if (target === undefined || !up.has(message.to.instanceId)) {
          return { ok: false, reason: '测试：不可达（无接收方）' };
        }
        frames.push({ ...frame, toInstanceId: message.to.instanceId });
        Promise.resolve().then(() => receive(target.service, frame, addressOf(self))).catch(() => {});
        return { ok: true, msgId: frame.msgId };
      };
    },
    /* 入队消息（join/leave/invite 广播类）手工上线：同帧形态、msgId 换新。 */
    async hop(message, fromSelf, service) {
      serial++;
      const frame = { ...wireFrameOf(message, fromSelf, serial), msgId: `hop-${randomUUID()}` };
      return receive(service, frame, addressOf(fromSelf));
    },
    postsTo(toInstanceId) {
      return frames.filter((frame) => frame.type === 'post' && frame.toInstanceId === toInstanceId);
    },
  };
}

/* 可控探测面：可达集合 up 为唯一判据（与直投线同一把尺——「拨号失败/探测不可达」同类降级触发）。 */
function probeFor(up) {
  return async (address, port) => {
    const seat = SEATS.find((entry) => entry.port === port);
    if (seat === undefined || !up.has(seat.instanceId)) {
      return { reachable: false, reason: '测试：探测不可达' };
    }
    return { reachable: true, rttMs: 1 };
  };
}

/* 一轮对表并取本轮结论（同意即回填与 join 触发的在途轮次可能占位——同一实例同时只跑一轮）。 */
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

/* 保活等待：对表轮次的应答等待面用 unref 定时器——等一个可能「无应答」的轮次时需外部保活。 */
async function awaitSync(pending) {
  const keepAlive = setInterval(() => {}, 20);
  try {
    return await pending;
  } finally {
    clearInterval(keepAlive);
  }
}

/* 三节点工作室：A=发起人（中继）、B/C=成员。B/C 经实际邀请载荷（含成员/端点/发起人标识）加入，
 * join 自播手工投递到 A，B/C 各对表一轮拉回事件集与元状态——装配完成（折叠成员表三人齐）。 */
async function makeStudio(t, options = {}) {
  const up = options.up ?? new Set(SEATS.map((seat) => seat.instanceId));
  const wire = makeWire(up);
  const probe = probeFor(up);
  const madeA = makeService(t, { self: SELF_A, sendDirect: wire.sendDirectFor(SELF_A), probe, syncPeerPicker: () => [SELF_B.instanceId, SELF_C.instanceId] });
  const madeB = makeService(t, { self: SELF_B, sendDirect: wire.sendDirectFor(SELF_B), probe, syncPeerPicker: () => [SELF_A.instanceId, SELF_C.instanceId] });
  const madeC = makeService(t, { self: SELF_C, sendDirect: wire.sendDirectFor(SELF_C), probe, syncPeerPicker: () => [SELF_A.instanceId, SELF_B.instanceId] });
  wire.register(SELF_A, madeA.service);
  wire.register(SELF_B, madeB.service);
  wire.register(SELF_C, madeC.service);
  const collabId = madeA.service.create({
    name: '讨论三',
    topic: '三节点议题',
    mode: 'forum',
    targets: [targetOf(SELF_B), targetOf(SELF_C)],
  }).collabId;
  await deliverInvite(wire, madeA, madeB, collabId);
  await madeB.service.approve({ collabId, approve: true });
  await deliverInvite(wire, madeA, madeC, collabId);
  await madeC.service.approve({ collabId, approve: true });
  await wire.hop(sentOf(madeB.sent, 'join', collabId)[0], SELF_B, madeA.service);
  await wire.hop(sentOf(madeC.sent, 'join', collabId)[0], SELF_C, madeA.service);
  await syncWhenIdle(madeB.service, collabId);
  await syncWhenIdle(madeC.service, collabId);
  return { wire, up, probe, collabId, a: madeA, b: madeB, c: madeC };
}

/* 邀请帧上线：取发送侧实际入队的 invite 消息（载荷与真实链路同源——含成员/端点/发起人标识）。 */
async function deliverInvite(wire, from, to, collabId) {
  const invite = sentOf(from.sent, 'invite', collabId).find((message) => message.to.instanceId === to.self.instanceId);
  assert.ok(invite !== undefined, `发起人对 ${to.self.instanceId} 的邀请已入队`);
  await wire.hop(invite, from.self, to.service);
}

function postsOf(view) {
  return view.posts;
}

test('①三节点中继路径：成员发帖发中继（投稿标记）、中继扇出转达（from 保原作者）→ 全员收敛一致', async (t) => {
  const { wire, collabId, a, b, c } = await makeStudio(t);
  const posted = await b.service.send({ collabId, text: '乙的第一帖', type: 'issue' });
  assert.equal(posted.ok, true, posted.message);
  assert.equal(posted.route, 'relay', '默认经中继分发');
  assert.deepEqual(posted.to, [SELF_A.instanceId], '投稿只发中继（不逐成员直投）');
  assert.equal(b.service.stats().relayPostsSent, 1);
  assert.equal(b.service.stats().relayDegradedPosts, 0);
  const submissions = wire.postsTo(SELF_A.instanceId);
  assert.equal(submissions.length, 1, '中继收到一份投稿');
  assert.equal(submissions[0].from.instanceId, SELF_B.instanceId);
  assert.equal(submissions[0].payload.relay, true, '投稿识别形态：payload.relay 标记');
  assert.equal(submissions[0].ts, posted.ts, '帧 ts 随帖携带');
  await waitFor(async () => ((await c.service.view({ collabId })).posts.length === 1 ? true : null));
  const relayed = wire.postsTo(SELF_C.instanceId);
  assert.equal(relayed.length, 1, '中继对成员逐份直投转达');
  assert.equal(relayed[0].from.instanceId, SELF_B.instanceId, '转达帧 from 保原作者');
  assert.equal(relayed[0].payload.relay, undefined, '转达副本不是投稿（不带标记）');
  assert.equal(relayed[0].payload.originMsgId, submissions[0].msgId, '转达副本随带 originMsgId（转达判别面）');
  assert.equal(relayed[0].ts, posted.ts, '转达帧 ts 保原帖 ts（显示序跨副本一致的前提）');
  const viewA = await a.service.view({ collabId });
  const viewB = await b.service.view({ collabId });
  const viewC = await c.service.view({ collabId });
  assert.deepEqual(postsOf(viewB), postsOf(viewA), '作者与中继副本一致');
  assert.deepEqual(postsOf(viewC), postsOf(viewB), '三副本收敛出同一帖集合与显示序');
  assert.equal(postsOf(viewC)[0].from.instanceId, SELF_B.instanceId, '接收端显示的作者是原作者');
  assert.equal(a.service.stats().relaySubmissionsIn, 1);
  assert.equal(a.service.stats().relayRedistributed, 1);
  assert.equal(a.service.stats().relayFanoutSkipped, 0);
  assert.equal(b.service.stats().postsDuplicated, 0, '投稿不回流作者（无重复副本）');

  /* 中继自帖：直接扇出（它就是分发器）——不产生投稿标记帧。 */
  const postedA = await a.service.send({ collabId, text: '甲的帖' });
  assert.equal(postedA.route, 'fanout');
  assert.deepEqual(postedA.to.sort(), [SELF_B.instanceId, SELF_C.instanceId]);
  assert.equal(wire.postsTo(SELF_B.instanceId).filter((frame) => frame.from.instanceId === SELF_A.instanceId).length, 1);
  await waitFor(async () => ((await c.service.view({ collabId })).posts.length === 2 ? true : null));
  assert.deepEqual(postsOf(await c.service.view({ collabId })), postsOf(await b.service.view({ collabId })));
});

test('②降级：中继不可达（探测失败）→ 当场降级直投、本次即走直投；③恢复：检测通过后切回中继并计数', async (t) => {
  const { up, collabId, a, b, c } = await makeStudio(t);
  up.delete(SELF_A.instanceId);   // 发起人会话关闭 = 中继消失（非错误）
  const degraded = await b.service.send({ collabId, text: '降级期的帖' });
  assert.equal(degraded.ok, true);
  assert.equal(degraded.route, 'degraded', '探测不可达 → 当场降级');
  assert.deepEqual(degraded.to.sort(), [SELF_A.instanceId, SELF_C.instanceId], '降级 = 对全成员直投');
  assert.ok(degraded.note.includes('探测不可达'), degraded.note);
  assert.equal(degraded.results.find((entry) => entry.instanceId === SELF_C.instanceId).ok, true, '可达成员照常送达');
  assert.equal(degraded.results.find((entry) => entry.instanceId === SELF_A.instanceId).ok, false, '不可达成员如实标注');
  assert.equal(b.service.stats().relayDegrades, 1, '进入降级态（当次）');
  assert.equal(b.service.stats().relayDegradedPosts, 1);
  assert.equal(b.service.stats().relayPostsSent, 0);
  await waitFor(async () => ((await c.service.view({ collabId })).posts.length === 1 ? true : null));
  assert.equal((await c.service.view({ collabId })).posts[0].from.instanceId, SELF_B.instanceId);

  /* 中继缺席期间的帖：不承诺中继收到——回归后经对表追平（拉取兜底不变）。 */
  up.add(SELF_A.instanceId);
  await awaitSync(a.service.sync({ collabId }));
  assert.equal((await a.service.view({ collabId })).posts.length, 1, '中继回归经对表追平降级期的帖');

  /* ③恢复：降级态下周期对表顺带探测 → 可达 → 清除降级态（计数），下一帖回中继路径。 */
  const beforeRecovery = b.service.stats().relayRecoveries;
  await awaitSync(b.service.sync({ collabId }));
  assert.equal(b.service.stats().relayRecoveries, beforeRecovery + 1, '恢复检测通过（可观测计数）');
  const back = await b.service.send({ collabId, text: '恢复后的帖' });
  assert.equal(back.route, 'relay', '路径切回中继');
  assert.deepEqual(back.to, [SELF_A.instanceId]);
  assert.equal(b.service.stats().relayPostsSent, 1);
  assert.equal(b.service.stats().relayDegradedPosts, 1, '降级计数不再增长');
  await waitFor(async () => ((await c.service.view({ collabId })).posts.length === 2 ? true : null), { timeoutMs: 2000 });
  assert.equal(a.service.stats().relayRedistributed, 1, '恢复后的帖经转达分发（降级期的帖不经转达）');
  assert.equal(c.service.stats().postsIn, 2, '降级直投副本 + 恢复后转达副本各一份（重复吸收）');
});

test('④重复分发幂等：同一投稿重复到达不重复转达；多路副本按（作者, postId）吸收无害', async (t) => {
  const { wire, collabId, a, b, c } = await makeStudio(t);
  await b.service.send({ collabId, text: '幂等帖' });
  const submission = wire.postsTo(SELF_A.instanceId)[0];
  assert.ok(submission !== undefined);
  await waitFor(async () => ((await c.service.view({ collabId })).posts.length === 1 ? true : null));
  /* 同帖第二副本（不同 msgId、同 postId）再投中继：入列去重、不再转达。 */
  const admitted = await receive(a.service, { ...submission, msgId: `copy-${randomUUID()}` }, addressOf(SELF_B));
  assert.equal(admitted.ok, true, '重复投稿照常受理（帖级去重由本地列表承担）');
  assert.equal(a.service.stats().postsDuplicated, 1);
  assert.equal(a.service.stats().relaySubmissionsIn, 1, '重复副本不计投稿');
  assert.equal(a.service.stats().relayRedistributed, 1, '转达每（作者, postId）至多一次');
  assert.equal(wire.postsTo(SELF_C.instanceId).length, 1, '未重复扇出');

  /* 转达副本的重复投递：接收端去重吸收（不重复入列），且不做端点学习（from 是原作者、
   * 链路来源是转达者——学错会把作者端点记成转达者地址）。 */
  const relayed = wire.postsTo(SELF_C.instanceId)[0];
  const twice = await receive(c.service, { ...relayed, msgId: `copy2-${randomUUID()}` }, addressOf(SELF_A));
  assert.equal(twice.ok, true);
  assert.equal(c.service.stats().postsDuplicated, 1);
  const viewC = await c.service.view({ collabId });
  assert.equal(viewC.posts.length, 1, '两路副本幂等吸收');
  assert.equal(viewC.endpoints[SELF_B.instanceId].address, addressOf(SELF_B), '转达副本不改写作者端点（无端点学习）');
  assert.equal(b.service.stats().relayPostsSent, 1);
});

test('⑤端点未知跳过并计数：转达不因个别成员端点未知而阻塞其余目标', async (t) => {
  const { collabId, a, b, c } = await makeStudio(t);
  /* 幽灵成员丁：join 事件到达（入折叠表）但来源地址缺失（端点学不到）。 */
  await receive(a.service, joinFrameOf(collabId, { instanceId: 'inst-d', identityName: '主机丁', port: 17325 }), '');
  const posted = await b.service.send({ collabId, text: '端点未知场景' });
  assert.equal(posted.route, 'relay');
  await waitFor(async () => ((await c.service.view({ collabId })).posts.length === 1 ? true : null));
  assert.equal(a.service.stats().relayFanoutSkipped, 1, '端点未知目标跳过并计数');
  assert.equal(a.service.stats().relayRedistributed, 1, '跳过不阻塞整帖转达');
  assert.equal(c.service.stats().postsIn, 1, '可达成员照常收到');
});

test('⑥与水位拉取正交：中继路径下离线成员回归仍经对表追平（实时通道与拉取通道各计各的）', async (t) => {
  const { up, collabId, b, c } = await makeStudio(t);
  up.delete(SELF_C.instanceId);   // 丙离线：中继转达送不到
  await b.service.send({ collabId, text: '离线期的帖' });
  assert.equal(c.service.stats().postsIn, 0, '离线成员未收到实时副本');
  up.add(SELF_C.instanceId);
  await awaitSync(c.service.sync({ collabId }));
  const view = await c.service.view({ collabId });
  assert.equal(view.posts.length, 1, '回归经拉取追平（传输切换与水位拉取正交）');
  assert.equal(c.service.stats().syncPostsBackfilled, 1);
  assert.equal(c.service.stats().postsIn, 0, '回填与实时接收分开计数');
});

test('⑦降级期经直投已到中继的副本不再转达（设计两可项的选定行为）：吸收不扇出', async (t) => {
  const { wire, collabId, a } = await makeStudio(t);
  /* 未带投稿标记的直投副本（降级期作者对全成员直投的形态）投到中继。 */
  const plain = forumPostFrame(collabId, SELF_B, { postId: 'post-plain', seq: 9, text: '直投副本' });
  const admitted = await receive(a.service, plain, addressOf(SELF_B));
  assert.equal(admitted.ok, true, '副本照常受理并入列');
  const view = await a.service.view({ collabId });
  assert.equal(view.posts.some((entry) => entry.entryId === 'post-plain'), true);
  assert.equal(a.service.stats().relaySubmissionsIn, 0, '未标记副本不算投稿');
  assert.equal(a.service.stats().relayRedistributed, 0, '选定行为：不再转达');
  assert.equal(wire.postsTo(SELF_C.instanceId).length, 0, '无扇出（重复流量不放大——漏者由对表兜底）');
});

test('⑧发起人标识传递：邀请载荷（被邀者）与 bundle 元状态（后经对表者）均能定位中继端点', async (t) => {
  const { wire, up, probe, collabId, a, b } = await makeStudio(t);
  /* (a) 邀请路径：载荷携发起人实例标识；被邀者持久化并据此定位中继。 */
  const inviteToB = sentOf(a.sent, 'invite', collabId).find((message) => message.to.instanceId === SELF_B.instanceId);
  assert.deepEqual(inviteToB.payload.originator, { instanceId: SELF_A.instanceId, identityName: SELF_A.identityName }, '邀请载荷携发起人实例标识');
  const memberB = JSON.parse(readFileSync(collabFilePath(b.dir, collabId, 'member.json'), 'utf8'));
  assert.deepEqual(memberB.originator, { instanceId: SELF_A.instanceId, identityName: SELF_A.identityName }, '被邀者记录持久发起人标识');
  const posted = await b.service.send({ collabId, text: '被邀者发帖' });
  assert.equal(posted.route, 'relay', '被邀者据邀请即可定位中继端点');
  assert.deepEqual(posted.to, [SELF_A.instanceId]);

  /* 成员再邀请他人：载荷的发起人标识仍是发起人（不是邀请者——归属不得由邀请者推断）。 */
  await b.service.invite({ collabId, targets: [targetOf(SELF_E)] });
  const inviteToE = sentOf(b.sent, 'invite', collabId).find((message) => message.to.instanceId === SELF_E.instanceId);
  assert.deepEqual(inviteToE.payload.originator, { instanceId: SELF_A.instanceId, identityName: SELF_A.identityName }, '增邀同款：携发起人标识');

  /* (b) 后经对表者：旧形态邀请（无发起人标识/端点表）→ 中继未知先直投；对表拉回元状态后定位中继。 */
  const madeE = makeService(t, { self: SELF_E, sendDirect: wire.sendDirectFor(SELF_E), probe, syncPeerPicker: () => [SELF_B.instanceId] });
  wire.register(SELF_E, madeE.service);
  await receive(madeE.service, collabFrame('invite', collabId, SELF_B, legacyInvitePayload()), addressOf(SELF_B));
  await madeE.service.approve({ collabId, approve: true });
  await wire.hop(sentOf(madeE.sent, 'join', collabId)[0], SELF_E, b.service);
  const blind = await madeE.service.send({ collabId, text: '戊的帖（中继未知）' });
  assert.equal(blind.route, 'degraded', '中继未知时先直投（不臆断归属）');
  assert.ok(blind.note.includes('中继未知'), blind.note);
  assert.equal(madeE.service.stats().relayDegradedPosts, 1);
  await syncWhenIdle(madeE.service, collabId);
  const memberE = JSON.parse(readFileSync(collabFilePath(madeE.dir, collabId, 'member.json'), 'utf8'));
  assert.deepEqual(memberE.originator, { instanceId: SELF_A.instanceId, identityName: SELF_A.identityName }, '经 bundle 元状态学到发起人标识（迟到成员路径）');
  const located = await madeE.service.send({ collabId, text: '戊的帖（已定位中继）' });
  assert.equal(located.route, 'relay', '后经对表者定位到中继端点（标识与端点均经对表学到）');
  assert.deepEqual(located.to, [SELF_A.instanceId]);
  assert.equal(up.has(SELF_A.instanceId), true);
});

/* 旧形态讨论邀请载荷（无发起人标识、无端点表）：接收侧按「中继未知」处理。 */
function legacyInvitePayload() {
  return {
    name: '讨论三',
    topic: '三节点议题',
    mode: 'forum',
    members: [
      { instanceId: SELF_A.instanceId, identityName: SELF_A.identityName },
      { instanceId: SELF_B.instanceId, identityName: SELF_B.identityName },
      { instanceId: SELF_E.instanceId, identityName: SELF_E.identityName },
    ],
  };
}

test('⑧端点就绪检查：发起人标识已学、端点未知 → 降级直投并计数（relayEndpointUnknown）', async (t) => {
  const { wire, probe } = await makeStudio(t);
  const madeE = makeService(t, { self: SELF_E, sendDirect: wire.sendDirectFor(SELF_E), probe, syncPeerPicker: () => [] });
  wire.register(SELF_E, madeE.service);
  const lonelyId = `collab-${randomUUID()}`;
  /* 邀请来源地址缺失（端点学不到）+ 载荷带发起人标识（标识已学）——定位中继时只缺端点。 */
  await receive(madeE.service, collabFrame('invite', lonelyId, SELF_B, {
    ...legacyInvitePayload(),
    originator: { instanceId: SELF_A.instanceId, identityName: SELF_A.identityName },
  }), '');
  await madeE.service.approve({ collabId: lonelyId, approve: true });
  const noEndpoint = await madeE.service.send({ collabId: lonelyId, text: '端点未知' });
  assert.equal(noEndpoint.route, 'degraded');
  assert.ok(noEndpoint.note.includes('中继端点未知'), noEndpoint.note);
  assert.equal(madeE.service.stats().relayEndpointUnknown, 1);
  assert.equal(madeE.service.stats().relayDegradedPosts, 1);
});

test('生命周期：发起人退出（leave）= 永久放弃中继职责——成员转常态直投兜底（非探测失败）', async (t) => {
  const { wire, collabId, a, b, c } = await makeStudio(t);
  await a.service.leave({ collabId });   // 自播 leave（入队广播）
  const leaveMessage = sentOf(a.sent, 'leave', collabId)[0];
  assert.ok(leaveMessage !== undefined, '发起人退出自播 leave');
  await wire.hop(leaveMessage, SELF_A, b.service);
  await wire.hop(leaveMessage, SELF_A, c.service);
  const posted = await b.service.send({ collabId, text: '发起人退出后的帖' });
  assert.equal(posted.route, 'degraded', '退出 = 放弃中继职责 → 直投兜底');
  assert.ok(posted.note.includes('退出'), posted.note);
  assert.equal(b.service.stats().relayDegrades, 0, '退出判据不走探测（不置降级态计数）');
  assert.equal(b.service.stats().relayDegradedPosts, 1);
  await waitFor(async () => ((await c.service.view({ collabId })).posts.length === 1 ? true : null));
  assert.equal((await c.service.view({ collabId })).posts[0].from.instanceId, SELF_B.instanceId);
});
