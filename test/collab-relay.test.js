import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { collabDir, collabFilePath } from '../src/paths.js';
import { makeTempDir, waitFor } from './helpers.js';
import { createCollabService } from '../src/collab/service.js';
import { MEMBERS_FILE_NAME } from '../src/collab/members.js';
import { createDispatch } from '../src/net/dispatch.js';
import { createInbound } from '../src/net/inbound.js';

/* 中继分发（默认）与直投（降级）的判别用例（设计 §5.2/§5.3/§9.1）：
 * ①三节点中继路径（投稿标记、from 保原作者、全员收敛一致）；②降级（中继不可达 → 当次即直投）；
 * ③恢复（后台检测通过 → 切回中继、计数断言）；④重复分发幂等；⑤端点未知跳过并计数；
 * ⑥与水位拉取正交（离线者照常追平）；⑦降级期直投副本不再转达（设计两可项的选定行为）；
 * ⑧发起人标识传递（邀请载荷 / bundle 元状态两路）；生命周期（发起人退出 → 直投兜底）；
 * 聚合捎回（成员会话回报译回原作者——真 dispatch + 真 inbound 三节点接缝）。
 * 多数用例经注入缝（假发送 / 虚拟直投线（节点可达性可配）/ 可控探测面）+ 临时目录，不触真实网络。 */

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
  const sendDirect = overrides.sendDirect === undefined
    ? (message) => {
        direct.push(message);
        return { ok: true, msgId: `d-${direct.length}` };
      }
    : overrides.sendDirect;
  const service = createCollabService({
    dataDir: dir,
    config: { inviteTtlMs: DAY },
    self: overrides.self,
    send: (message) => {
      sent.push(message);
      return { ok: true, msgId: `q-${sent.length}` };
    },
    sendDirect,
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

/* 可控探测面：可达集合 up 为唯一判据（与直投线同一把尺——「拨号失败/探测不可达」同类降级触发）；
 * stats.calls 记录探测次数（「降级中不重复探测」的判据面）。 */
function probeFor(up, stats) {
  return async (address, port) => {
    stats.calls++;
    const seat = SEATS.find((entry) => entry.port === port);
    if (seat === undefined || !up.has(seat.instanceId)) {
      return { reachable: false, reason: '测试：探测不可达' };
    }
    return { reachable: true, rttMs: 1 };
  };
}

/* 一轮对表并取本轮结论（同意即回填与 join 触发的在途轮次可能占位——同一实例同时只跑一轮）。
 * 经 awaitSync 保活：应答等待面是 unref 定时器，纯等待会被 runner 判为空事件循环而取消。 */
async function syncWhenIdle(service, collabId) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const outcome = await awaitSync(service.sync({ collabId }));
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
 * join 自播手工投递到 A，B/C 各对表一轮拉回事件集与元状态——装配完成（折叠成员表三人齐）。
 * options.probes 可逐席位替换探测面；options.noDirect 圈定无直投注入的席位（降级面用例）。 */
async function makeStudio(t, options = {}) {
  const up = options.up ?? new Set(SEATS.map((seat) => seat.instanceId));
  const wire = makeWire(up);
  const probeStats = { calls: 0 };
  const probe = probeFor(up, probeStats);
  const probeOf = (seat) => options.probes?.[seat.instanceId] ?? probe;
  const directOf = (seat) => (options.noDirect?.has(seat.instanceId) ? null : wire.sendDirectFor(seat));
  const madeA = makeService(t, { self: SELF_A, sendDirect: directOf(SELF_A), probe: probeOf(SELF_A), syncPeerPicker: () => [SELF_B.instanceId, SELF_C.instanceId] });
  const madeB = makeService(t, { self: SELF_B, sendDirect: directOf(SELF_B), probe: probeOf(SELF_B), syncPeerPicker: () => [SELF_A.instanceId, SELF_C.instanceId] });
  const madeC = makeService(t, { self: SELF_C, sendDirect: directOf(SELF_C), probe: probeOf(SELF_C), syncPeerPicker: () => [SELF_A.instanceId, SELF_B.instanceId] });
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
  const joinB = sentOf(madeB.sent, 'join', collabId)[0];
  const joinC = sentOf(madeC.sent, 'join', collabId)[0];
  await wire.hop(joinB, SELF_B, madeA.service);
  await wire.hop(joinC, SELF_C, madeA.service);
  /* 成员之间的 join 也直接投递一份：折叠成员表三人齐不依赖对表应答（无直投面的降级面用例
   * 里应答方可能不可用，装配不得因此半途）。 */
  await wire.hop(joinC, SELF_C, madeB.service);
  await wire.hop(joinB, SELF_B, madeC.service);
  await syncWhenIdle(madeB.service, collabId);
  await syncWhenIdle(madeC.service, collabId);
  return { wire, up, probe, probeStats, collabId, a: madeA, b: madeB, c: madeC };
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
  await syncWhenIdle(a.service, collabId);   // 单轮可能撞上在途轮次（join 触发行）——等到本轮真跑起来
  assert.equal((await a.service.view({ collabId })).posts.length, 1, '中继回归经对表追平降级期的帖');

  /* ③恢复：降级态下周期对表顺带探测 → 可达 → 清除降级态（计数），下一帖回中继路径。 */
  const beforeRecovery = b.service.stats().relayRecoveries;
  await syncWhenIdle(b.service, collabId);
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

test('降级持续期：降级态下发帖不重复探测（直投照走），计数不重复累积', async (t) => {
  const { up, probeStats, collabId, b, c } = await makeStudio(t);
  up.delete(SELF_A.instanceId);
  const first = await b.service.send({ collabId, text: '降级一' });
  assert.equal(first.route, 'degraded');
  const probesAfterFirst = probeStats.calls;
  assert.equal(probesAfterFirst > 0, true, '首帖探测中继（不可达判定）');
  const second = await b.service.send({ collabId, text: '降级二' });
  assert.equal(second.route, 'degraded');
  assert.ok(second.note.includes('降级中'), second.note);
  assert.equal(probeStats.calls, probesAfterFirst, '降级中不重复探测（恢复检测归周期对表 tick）');
  assert.equal(b.service.stats().relayDegrades, 1, '不重复置降级态');
  assert.equal(b.service.stats().relayDegradedPosts, 2);
  await waitFor(async () => ((await c.service.view({ collabId })).posts.length === 2 ? true : null));
});

test('探测异常一律归「不可达」（不穿出调用链）：当场降级直投', async (t) => {
  const { collabId, b, c } = await makeStudio(t, {
    probes: { [SELF_B.instanceId]: async () => { throw new Error('探测面故障'); } },
  });
  const posted = await b.service.send({ collabId, text: '探测异常帖' });
  assert.equal(posted.route, 'degraded');
  assert.ok(posted.note.includes('探测异常'), posted.note);
  assert.equal(b.service.stats().relayDegrades, 1);
  await waitFor(async () => ((await c.service.view({ collabId })).posts.length === 1 ? true : null));
});

test('直投面不可用（注入缺失）：投稿面与直投面各自如实标注、帖仍落本机列表', async (t) => {
  const memberSide = await makeStudio(t, { noDirect: new Set([SELF_B.instanceId]) });
  const posted = await memberSide.b.service.send({ collabId: memberSide.collabId, text: '无直投面的帖' });
  assert.equal(posted.route, 'degraded', '投稿未受理 → 本次直投（同样无直投面）');
  assert.ok(posted.note.includes('投稿未受理'), posted.note);
  assert.ok(posted.results.every((entry) => entry.reason.includes('直投面不可用')), JSON.stringify(posted.results));
  assert.equal((await memberSide.b.service.view({ collabId: memberSide.collabId })).posts.length, 1, '帖的事务点在本机列表');
});

test('中继侧直投面不可用：转达跳过并计数，其余副本不受影响（对方经对表追平）', async (t) => {
  const { wire, collabId, a, b, c } = await makeStudio(t, { noDirect: new Set([SELF_A.instanceId]) });
  const posted = await b.service.send({ collabId, text: '中继无直投面' });
  assert.equal(posted.route, 'relay', '投稿本身经作者侧直投面送达中继');
  await waitFor(async () => ((await a.service.view({ collabId })).posts.length === 1 ? true : null));
  assert.equal(a.service.stats().postFanoutSkipped, 1, '转达面缺失计数留痕');
  assert.equal(a.service.stats().relayRedistributed, 1, '入列与计数照走（不得静默死锁）');
  assert.equal(c.service.stats().postsIn, 0, '实时副本未达（中继侧无直投面）');
  await syncWhenIdle(c.service, collabId);
  assert.equal((await c.service.view({ collabId })).posts.length, 1, '对方经周期对表追平');
  assert.equal(wire.postsTo(SELF_C.instanceId).length, 0);
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
  await syncWhenIdle(c.service, collabId);
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
  /* 恢复检测不误判：端点仍未知 → 无从探测，保持降级（不得凭空中继路径）。 */
  await syncWhenIdle(madeE.service, lonelyId);
  assert.equal(madeE.service.stats().relayRecoveries, 0, '端点未知无从探测——保持降级');
});

test('⑧邀请载荷自指发起人：拒绝学入并计数——不学入 / 不改写；受邀者不因构造性邀请被置为中继', async (t) => {
  /* 行为腿：自指值未学入 → 本机不把自己当中继（发帖降级直投）。 */
  const made = makeService(t, { self: SELF_B });
  const collabId = `collab-selforigin-${randomUUID()}`;
  const payload = {
    name: '讨论自指', topic: '议题', mode: 'forum',
    members: [SELF_A, SELF_B].map((seat) => ({ instanceId: seat.instanceId, identityName: seat.identityName })),
    originator: { instanceId: SELF_B.instanceId, identityName: SELF_B.identityName },
  };
  const admitted = await receive(made.service, collabFrame('invite', collabId, SELF_A, payload), addressOf(SELF_A));
  assert.equal(admitted.ok, true, '邀请本身照常受理（自指值只在不学入）');
  assert.equal(made.service.stats().forumMetaRejected, 1, '自指发起人标识拒绝并计数');
  const memberOf = () => JSON.parse(readFileSync(collabFilePath(made.dir, collabId, 'member.json'), 'utf8'));
  assert.equal(memberOf().originator, undefined, '自指发起人标识不学入（不落盘）');
  const approved = await made.service.approve({ collabId, approve: true });
  assert.equal(approved.ok, true, approved.message);
  const posted = await made.service.send({ collabId, text: '乙的帖（中继未知）' });
  assert.equal(posted.route, 'degraded', '自指未被学入：本机不把自己当中继（降级直投）');
  assert.ok(posted.note.includes('中继未知'), posted.note);

  /* 学习腿：合法值照旧学入；其后的自指重邀不改写已学得标识（逐次计数）。 */
  const learner = makeService(t, { self: SELF_B });
  const learnId = `collab-selforigin-${randomUUID()}`;
  await receive(learner.service, collabFrame('invite', learnId, SELF_A, payload), addressOf(SELF_A));
  const learnedOf = () => JSON.parse(readFileSync(collabFilePath(learner.dir, learnId, 'member.json'), 'utf8'));
  assert.equal(learnedOf().originator, undefined, '首次自指不学入');
  await receive(learner.service, collabFrame('invite', learnId, SELF_A, {
    ...payload,
    originator: { instanceId: SELF_A.instanceId, identityName: SELF_A.identityName },
  }), addressOf(SELF_A));
  assert.deepEqual(learnedOf().originator, { instanceId: SELF_A.instanceId, identityName: SELF_A.identityName }, '合法发起人标识学入（正对照）');
  await receive(learner.service, collabFrame('invite', learnId, SELF_A, payload), addressOf(SELF_A));
  assert.deepEqual(learnedOf().originator, { instanceId: SELF_A.instanceId, identityName: SELF_A.identityName }, '自指重邀不改写已学得标识');
  assert.equal(learner.service.stats().forumMetaRejected, 2, '自指两次逐一计数');
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

test('转达面成员校验：非成员投稿（带 relay 标记）照常入列但不转达——不放大到全员直投', async (t) => {
  const { wire, collabId, a } = await makeStudio(t);
  const frame = forumPostFrame(collabId, { instanceId: 'inst-z', identityName: '主机Z', port: 17399 }, { postId: 'post-outsider', seq: 1, text: '陌生人的投稿' });
  frame.payload.relay = true;
  const admitted = await receive(a.service, frame, '127.0.0.9');
  assert.equal(admitted.ok, true, '帖本身照常受理（内容面语义不变）');
  const view = await a.service.view({ collabId });
  assert.equal(view.posts.some((entry) => entry.entryId === 'post-outsider'), true, '入列落盘去重照旧');
  assert.equal(a.service.stats().relaySubmissionsRejected, 1, '非成员投稿不转达并计数');
  assert.equal(a.service.stats().relaySubmissionsIn, 0);
  assert.equal(a.service.stats().relayRedistributed, 0);
  assert.equal(wire.postsTo(SELF_C.instanceId).length, 0, '成员端点零投递（1→N 放大被堵）');
});

test('恢复检测窗口内并发第二轮对表：already-running（在途置位先于检测 await）', async (t) => {
  let probeReachable = false;
  const slowProbe = () => new Promise((resolve) => setTimeout(() => resolve(
    probeReachable ? { reachable: true, rttMs: 1 } : { reachable: false, reason: '测试：探测不可达' },
  ), 40));
  const studio = await makeStudio(t, { probes: { [SELF_B.instanceId]: slowProbe } });
  studio.up.delete(SELF_A.instanceId);
  const degraded = await studio.b.service.send({ collabId: studio.collabId, text: '降级帖' });
  assert.equal(degraded.route, 'degraded', '探测不可达 → 降级（同时置降级态）');
  probeReachable = true;
  const first = studio.b.service.sync({ collabId: studio.collabId });   // 不等待：首轮进入恢复检测（40ms 桩）
  await new Promise((resolve) => setTimeout(resolve, 10));
  const second = await studio.b.service.sync({ collabId: studio.collabId });
  assert.equal(second.reason, 'already-running', '检测窗口内并发第二轮被拒（在途轮次唯一）');
  const outcome = await awaitSync(first);
  assert.notEqual(outcome.reason, 'already-running', '首轮正常收尾（未被并发判据误伤）');
  assert.equal(studio.b.service.stats().relayRecoveries, 1, '首轮完成恢复检测');
  const third = await awaitSync(studio.b.service.sync({ collabId: studio.collabId }));
  assert.notEqual(third.reason, 'already-running', '置位已释放（下一轮不再 already-running）');
});

test('发起人标识入 member.json 形态校验：坏形态按既有加载语义跳过并计数，合法记录照常加载', (t) => {
  const dir = makeTempDir(t);
  const memberFile = collabFilePath(dir, 'collab-origin', 'member.json');
  const member = {
    collabId: 'collab-origin',
    role: 'member',
    state: 'active',
    name: '讨论甲',
    mode: 'forum',
    manager: { instanceId: 'inst-a', identityName: '主机甲' },
    roster: [{ instanceId: 'inst-a', identityName: '主机甲' }, { instanceId: 'inst-b', identityName: '主机乙' }],
    endpoints: {},
    decision: 'approved',
    originator: { instanceId: 'bad id!', identityName: '主机甲' },
  };
  mkdirSync(collabDir(dir, 'collab-origin'), { recursive: true });
  writeFileSync(memberFile, JSON.stringify(member));
  const rejected = makeLoadService(dir);
  assert.deepEqual(rejected.list(), { collabs: [] }, '坏 originator 记录按坏数据跳过');
  assert.equal(rejected.stats().loadFailures, 1);
  member.originator = { instanceId: 'inst-a', identityName: '主机甲' };
  writeFileSync(memberFile, JSON.stringify(member));
  const loaded = makeLoadService(dir);
  assert.equal(loaded.list().collabs.length, 1, '合法记录照常加载');
  assert.equal(loaded.list().collabs[0].collabId, 'collab-origin');
});

/* 加载面最小装配（只关心注册表恢复与计数）。 */
function makeLoadService(dir) {
  return createCollabService({
    dataDir: dir,
    config: { inviteTtlMs: DAY },
    self: SELF_A,
    send: () => ({ ok: true, msgId: 'q-load' }),
    sendDirect: null,
    probe: null,
    knownHosts: { remember: () => {} },
    log: quietLog(),
  });
}

/* —— 聚合捎回（设计 §5.2「成员级投递结果由中继聚合捎回」）：真 dispatch + 真 inbound 三节点 —— */

const NET_CONFIG = { port: 7321, retryIntervalMs: 40, retrySlowIntervalMs: 80, retryFastCount: 2, queueMaxPerCollab: 100, messageTtlMs: 600000, dispatchTickMs: 20, dialTimeoutMs: 150 };

/* 假连接（与生产 transport 接口同形）：send 记录帧，receive 分发给已注册的帧处理器。 */
function fakeConnection(remoteAddress = '127.0.0.1') {
  const listeners = { frame: null, close: null };
  return {
    remoteAddress,
    sent: [],
    send(frame) {
      this.sent.push(frame);
    },
    onFrame(callback) {
      listeners.frame = callback;
    },
    onClose(callback) {
      listeners.close = callback;
    },
    close() {
      if (listeners.close !== null) {
        listeners.close();
      }
    },
    receive(frame) {
      return listeners.frame === null ? undefined : listeners.frame(frame);
    },
  };
}

/* 三节点直连网（假传输）：按拨号端口定位目标站点；dialed 记录每台机器拨出的帧——
 * 聚合捎回「译回帧」的判别面（转达副本的回报沿原连接回执，不经拨号，故不在此表）。 */
function makeNetPairs() {
  const nodes = new Map();
  const byPort = new Map();
  const dialed = [];
  const clientFor = (dialer, target) => {
    const serverView = fakeConnection(addressOf(dialer));   // 接收方看到的来源地址 = 拨号方
    const clientView = fakeConnection(addressOf(target));
    clientView.send = (frame) => {
      dialed.push({ from: dialer.instanceId, frame });
      nodes.get(target.instanceId).inbound.onFrame(serverView, frame);
    };
    serverView.send = (frame) => clientView.receive(frame);
    return clientView;
  };
  return {
    dialed,
    register(self, inbound) {
      nodes.set(self.instanceId, { self, inbound });
      byPort.set(self.port, self.instanceId);
    },
    transportOf(self) {
      return {
        setFrameHandler() {},
        dial: ({ port }) => Promise.resolve(clientFor(self, nodes.get(byPort.get(port)).self)),
      };
    },
  };
}

/* 单节点装配（真 dispatch + 真 inbound + 协作服务）：与生产组合根同构的接线（含聚合捎回注入面）。
 * deliverToSession 可注入——中继侧「会话未回报」的变体由用例给出。 */
function makeNetNode(t, { self, dir, transport, deliverToSession = () => true }) {
  const log = quietLog();
  const dispatch = createDispatch({
    dataDir: dir,
    config: NET_CONFIG,
    transport,
    self,
    log,
    onRelayedReport: (payload) => service.relayReport(payload),
  });
  const { service, inbound } = makeNetCollab({ dir, self, dispatch, log, deliverToSession });
  dispatch.setClientFrameRouter((connection, frame) => inbound.onFrame(connection, frame));
  dispatch.start();
  t.after(() => dispatch.stop());
  return { dispatch, service, inbound };
}

/* 协作服务 + 接收管线的装配（admit/consume 钩子与投递面；与生产组合根同一注入形状）。 */
function makeNetCollab({ dir, self, dispatch, log, deliverToSession }) {
  const service = createCollabService({
    dataDir: dir,
    config: { inviteTtlMs: DAY },
    self,
    send: (message) => dispatch.send(message),
    sendDirect: (message) => dispatch.sendDirect(message),
    probe: null,
    notify: () => {},
    knownHosts: { remember: () => {} },
    log,
    ledgerFetchTimeoutMs: 30,
    inviteMinIntervalMs: 0,
    syncPeerPicker: () => [],
    joinReplayIntervalsMs: [2000],
  });
  const inbound = createInbound({
    dataDir: dir,
    config: { messageTtlMs: 600000 },
    self,
    dispatch,
    hooks: {
      admit: (frame, meta) => service.hooks.admit(frame, meta),
      consume: (frame, meta) => service.hooks.consume(frame, meta),
      deliverToSession,
    },
    log,
  });
  return { service, inbound };
}

/* 三节点装配：A=发起人/中继、B/C=成员，邀请与 join 全经真实队列送达（拨号按端口定位）。 */
async function makeNetStudio(t, { relaySessionReports = true } = {}) {
  const net = makeNetPairs();
  const nodes = {
    a: makeNetNode(t, { self: SELF_A, dir: makeTempDir(t), transport: net.transportOf(SELF_A), deliverToSession: () => relaySessionReports }),
    b: makeNetNode(t, { self: SELF_B, dir: makeTempDir(t), transport: net.transportOf(SELF_B) }),
    c: makeNetNode(t, { self: SELF_C, dir: makeTempDir(t), transport: net.transportOf(SELF_C) }),
  };
  net.register(SELF_A, nodes.a.inbound);
  net.register(SELF_B, nodes.b.inbound);
  net.register(SELF_C, nodes.c.inbound);
  const collabId = nodes.a.service.create({ name: '讨论三', topic: '议题', mode: 'forum', targets: [targetOf(SELF_B), targetOf(SELF_C)] }).collabId;
  await waitFor(() => (
    nodes.b.service.list().collabs.some((entry) => entry.collabId === collabId)
    && nodes.c.service.list().collabs.some((entry) => entry.collabId === collabId)
      ? true : null
  ), { timeoutMs: 8000 });
  await nodes.b.service.approve({ collabId, approve: true });
  await nodes.c.service.approve({ collabId, approve: true });
  await waitFor(() => (nodes.a.service.stats().forumJoinsIn >= 2 ? true : null), { timeoutMs: 8000 });
  return { net, nodes, collabId };
}

test('聚合捎回：中继把成员会话回报译回原作者（既有 delivery-status 帧；含幂等与无环判别）', async (t) => {
  /* 中继侧会话不回报（适配器不可用态）：作者侧档位只能由成员会话的回报经聚合捎回升级——
   * 该配置下「译回帧」不含歧义（既有投稿回报帧不存在）。 */
  const { net, nodes, collabId } = await makeNetStudio(t, { relaySessionReports: false });
  const own = await nodes.a.service.send({ collabId, text: '甲的帖' });
  assert.equal(own.route, 'fanout', '中继自帖直接扇出（同时备下原生直投记录）');
  const posted = await nodes.b.service.send({ collabId, text: '乙的帖' });
  assert.equal(posted.route, 'relay');
  const rowOf = (owner, target) => owner.dispatch.deliveryStatus({ collabId }).find((row) => row.type === 'post' && row.toInstanceId === target);
  const submissionRow = rowOf(nodes.b, SELF_A.instanceId);
  assert.ok(submissionRow !== undefined, '投稿直投记录在作者侧');
  const reportsToAuthor = () => net.dialed.filter((entry) => (
    entry.from === SELF_A.instanceId && entry.frame.type === 'delivery-status' && entry.frame.payload?.refMsgId === submissionRow.msgId
  ));
  /* 判别点（旧行为必红）：成员（丙）会话收到转达副本 → 中继把第三档回报译回原作者。 */
  await waitFor(() => (reportsToAuthor().length >= 1 ? true : null), { timeoutMs: 8000 });
  assert.equal(reportsToAuthor()[0].frame.payload.tier, 'session');
  assert.equal(reportsToAuthor()[0].frame.from.instanceId, SELF_A.instanceId, '译回帧由中继发出');
  /* 端到端 sanity：作者档位达第三档（此配置下只能经聚合捎回抵达）。 */
  await waitFor(() => {
    const row = nodes.b.dispatch.deliveryStatus({ collabId }).find((candidate) => candidate.msgId === submissionRow.msgId);
    return row?.tier === 'session' ? true : null;
  }, { timeoutMs: 8000 });
  assert.equal(nodes.a.service.stats().relayReportSent >= 1, true, '聚合回报发送计数（可观测）');
  assert.equal((await nodes.c.service.view({ collabId })).posts.length, 2, '成员侧实时副本已入列（中继自帖 + 转达副本；回报的前件）');

  /* 幂等：同一转达副本的重复回报不再译回第二帧（状态首次跃迁才触发）。 */
  const relayedRow = rowOf(nodes.a, SELF_C.instanceId);
  assert.ok(relayedRow !== undefined, '中继的转达记录在案');
  const before = reportsToAuthor().length;
  nodes.a.dispatch.onDeliveryReport({ refMsgId: relayedRow.msgId, tier: 'session' });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(reportsToAuthor().length, before, '重复回报无第二帧');

  /* 回归：原生副本（无 originMsgId / 无 from）的第三档回报不触发译回。 */
  const nativeRow = rowOf(nodes.a, SELF_B.instanceId);
  assert.ok(nativeRow !== undefined, '中继自帖的直投记录（原生帧）');
  nodes.a.dispatch.onDeliveryReport({ refMsgId: nativeRow.msgId, tier: 'session' });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(reportsToAuthor().length, before, '原生回报不产生译回帧（既有路径不动）');

  /* 无环：回报是递归终端——接收方不为「回报帧」再产生回报。 */
  const reportFrame = reportsToAuthor()[0].frame;
  assert.equal(net.dialed.some((entry) => entry.frame.type === 'delivery-status' && entry.frame.payload?.refMsgId === reportFrame.msgId), false, '不为回报再产生回报');
});

test('聚合捎回：原作者端点未知 → 跳过并计数（不臆造地址），主链不受影响', async (t) => {
  const { collabId, a } = await makeStudio(t);
  a.service.relayReport({ collabId, originMsgId: 'origin-unknown', author: { instanceId: 'inst-ghost', identityName: '幽灵' } });
  assert.equal(a.service.stats().relayReportSkipped, 1);
  assert.equal(a.service.stats().relayReportSent, 0);
  a.service.relayReport({ collabId: 'collab-absent', originMsgId: 'origin-unknown', author: { instanceId: 'inst-ghost', identityName: '幽灵' } });
  assert.equal(a.service.stats().relayReportSkipped, 1, '非本机在册协作不臆造（防御面：跳过不计）');
});

/* —— 元状态学习面与加载面同判据（复评 Important-1：学习面宽于加载面 → 坏值落盘 → 重启跳过） —— */

/* 拉取应答帧的最小合法形态（载荷过协议层；meta 只过 isPlainObject——正是坏值可乘之面）。 */
function bundleFrameOfNet(collabId, from, meta, members = []) {
  return collabFrame('history-bundle', collabId, from, { cursor: null, more: false, posts: [], overlap: [], meta, members, endpoints: {} });
}

test('元状态学习面：坏 originator/stamps 不学入不落盘——重启照常加载（loadFailures=0）', async (t) => {
  const made = makeService(t, { self: SELF_B });
  const collabId = `collab-learn-${randomUUID()}`;
  await receive(made.service, collabFrame('invite', collabId, SELF_A, {
    name: '讨论学', topic: '议题', mode: 'forum',
    members: [SELF_A, SELF_B].map((seat) => ({ instanceId: seat.instanceId, identityName: seat.identityName })),
  }));
  await made.service.approve({ collabId, approve: true });
  const admitted = await receive(made.service, bundleFrameOfNet(collabId, SELF_A, {
    name: '讨论学', state: 'active', topic: '坏\u0007主题',
    originator: { instanceId: 'bad id!', identityName: '主机甲' },
    createdAt: 'not-a-time',
  }));
  assert.equal(admitted.ok, true, 'bundle 本身合法受理（坏值只在不学入）');
  const member = JSON.parse(readFileSync(collabFilePath(made.dir, collabId, 'member.json'), 'utf8'));
  assert.equal(member.originator, undefined, '坏 originator 不学入（不落盘）');
  assert.equal(member.topic, '议题', '坏 topic 不改写既有值');
  assert.equal(member.forumMeta, undefined, '坏时间戳不学入');
  assert.equal(made.service.stats().forumMetaRejected, 2, '逐字段计数（originator + createdAt；topic 已有值不参与学习）');
  const reloaded = makeLoadService(made.dir);
  assert.equal(reloaded.stats().loadFailures, 0, '重启照常加载（网络坏值未成为「重启即跳过」的源头）');
  assert.equal(reloaded.list().collabs.length, 1);
});

test('元状态学习面：坏 topic（记录缺省）不学入；自指 originator 拒绝；三者逐一计数', async (t) => {
  const dir = makeTempDir(t);
  const collabId = 'collab-legacy';
  writeLegacyMemberRecord(dir, collabId);
  const service = createCollabService({
    dataDir: dir,
    config: { inviteTtlMs: DAY },
    self: SELF_B,
    send: () => ({ ok: true, msgId: 'q-legacy' }),
    sendDirect: null,
    probe: null,
    knownHosts: { remember: () => {} },
    log: quietLog(),
  });
  await receive(service, bundleFrameOfNet(collabId, SELF_A, {
    name: '讨论旧', state: 'active', topic: '坏\u0007主题',
    originator: { instanceId: SELF_B.instanceId, identityName: SELF_B.identityName },
    establishedAt: 42,
  }));
  const member = JSON.parse(readFileSync(collabFilePath(dir, collabId, 'member.json'), 'utf8'));
  assert.equal(member.topic, undefined, '坏 topic 不学入（保持缺失）');
  assert.equal(member.originator, undefined, '自指 originator 拒绝（发起人恒为他人他机）');
  assert.equal(member.forumMeta, undefined, '坏时间戳不学入');
  assert.equal(service.stats().forumMetaRejected, 3, '三个坏字段逐一计数');
});

test('元状态学习面：合法值照旧学入（只补不覆回归）；重启加载完整', async (t) => {
  const dir = makeTempDir(t);
  const collabId = 'collab-legacy';
  writeLegacyMemberRecord(dir, collabId);
  const service = createCollabService({
    dataDir: dir,
    config: { inviteTtlMs: DAY },
    self: SELF_B,
    send: () => ({ ok: true, msgId: 'q-legacy-ok' }),
    sendDirect: null,
    probe: null,
    knownHosts: { remember: () => {} },
    log: quietLog(),
  });
  const createdAt = '2026-10-13T00:00:00.000Z';
  await receive(service, bundleFrameOfNet(collabId, SELF_A, {
    name: '讨论旧', state: 'active', topic: '议题二',
    originator: { instanceId: SELF_A.instanceId, identityName: SELF_A.identityName },
    createdAt,
    establishedAt: '2026-10-13T01:00:00.000Z',
  }));
  const member = JSON.parse(readFileSync(collabFilePath(dir, collabId, 'member.json'), 'utf8'));
  assert.equal(member.topic, '议题二', '合法 topic 学入（记录缺省时补学）');
  assert.deepEqual(member.originator, { instanceId: SELF_A.instanceId, identityName: SELF_A.identityName }, '合法 originator 学入');
  assert.deepEqual(member.forumMeta, { createdAt, establishedAt: '2026-10-13T01:00:00.000Z' }, '合法时间戳学入');
  assert.equal(service.stats().forumMetaRejected, 0, '合法值不计数');
  /* 只补不覆：更晚的合法值不改写已学得字段。 */
  await receive(service, bundleFrameOfNet(collabId, SELF_A, { name: '讨论旧', state: 'active', topic: '议题三', createdAt: '2026-10-14T00:00:00.000Z' }));
  const again = JSON.parse(readFileSync(collabFilePath(dir, collabId, 'member.json'), 'utf8'));
  assert.equal(again.topic, '议题二', '只补不覆：已学得 topic 不被后续来源改写');
  assert.equal(again.forumMeta.createdAt, createdAt);
  const reloaded = makeLoadService(dir);
  assert.equal(reloaded.stats().loadFailures, 0, '合法记录重启加载完整');
  assert.equal(reloaded.list().collabs.length, 1);
});

/* 旧形态成员记录（缺 topic/originator/forumMeta；本机已在折叠表内——写一条自己的 join 事件）。 */
function writeLegacyMemberRecord(dir, collabId) {
  mkdirSync(collabDir(dir, collabId), { recursive: true });
  writeFileSync(collabFilePath(dir, collabId, 'member.json'), JSON.stringify({
    collabId,
    role: 'member',
    state: 'active',
    name: '讨论旧',
    mode: 'forum',
    manager: { instanceId: SELF_A.instanceId, identityName: SELF_A.identityName },
    roster: [
      { instanceId: SELF_A.instanceId, identityName: SELF_A.identityName },
      { instanceId: SELF_B.instanceId, identityName: SELF_B.identityName },
    ],
    endpoints: {},
    decision: 'approved',
  }));
  writeFileSync(collabFilePath(dir, collabId, MEMBERS_FILE_NAME), `${JSON.stringify({
    eventId: randomUUID(),
    kind: 'join',
    instanceId: SELF_B.instanceId,
    identityName: SELF_B.identityName,
    ts: '2026-10-13T00:00:00.000Z',
  })}\n`);
}
