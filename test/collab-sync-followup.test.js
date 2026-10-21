import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { collabFilePath } from '../src/paths.js';
import { makeTempDir, waitFor } from './helpers.js';
import { createCollabService } from '../src/collab/service.js';
import { LEDGER_FILE_NAME } from '../src/collab/store.js';

/* 文件级保活：对表等待面用 unref 定时器（会话关闭即退出是产品语义）——本文件的用例会等待
 * 「可能无应答」的轮次，须有外部定时器托住事件循环，否则 runner 判定循环已空而取消用例。 */
const keepAlive = setInterval(() => {}, 20);
after(() => {
  clearInterval(keepAlive);
});

/* 讨论对表引擎的补面（既有 collab-sync 用例集的续篇）：周期 tick 驱动（startSyncEngine 的
 * 定时回调）、收尾时未决等待面的即时了结、无对端注入时的候选轮换（rotateCandidates），以及
 * 旧数据缺成立时刻时按成员事件推导的兜底。全部真服务 + 假直投虚拟线装配，确定性驱动。
 *
 * 0.2.0 夹具形态：协作域帧携 cap=2 与 from.sessionId；名单条目为席位形态
 * {instanceId, sessionId, identityName}；创建须带调用会话标识（设计 §1.1/§2.1/§5.1）。
 * 本文件无已删除用例：讨论对表的投票/成员/回填语义未被 v4 改动（D2/D10 保持既有中继语义）。 */

const DAY = 24 * 60 * 60 * 1000;

function quietLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

const SELF_A = { instanceId: 'inst-a', identityName: '主机甲', port: 17321 };
const SELF_B = { instanceId: 'inst-b', identityName: '主机乙', port: 17322 };
const SELF_C = { instanceId: 'inst-c', identityName: '主机丙', port: 17323 };
const AUTHOR_U = { instanceId: 'inst-u', identityName: '主机U', port: 17331 };

let seq = 0;

/* 会话标识按实例派生：同一实例的帧署名稳定，测试断言可复现。 */
function sessionOf(instanceId) {
  return `sess-${String(instanceId).replace(/^inst-/, '')}`;
}

function peer(instanceId, identityName, port = 17321) {
  return { instanceId, identityName, port, sessionId: sessionOf(instanceId) };
}

function collabFrame(type, collabId, from, payload) {
  seq++;
  return { v: 1, cap: 2, type, msgId: `msg-${type}-${seq}`, from: { ...from, sessionId: from.sessionId ?? sessionOf(from.instanceId), port: from.port ?? 17321 }, collabId, ts: new Date().toISOString(), payload };
}

async function receive(service, f, remoteAddress = '127.0.0.1') {
  const admitted = await service.hooks.admit(f, { remoteAddress });
  if (admitted?.ok === true) {
    await service.hooks.consume(f, { remoteAddress });
  }
  return admitted;
}

/* 讨论邀请的同意（一次性确认豁免 + 会话标识）：join/approve 帧因此携 fromSessionId。 */
async function approveForum(service, collabId, sessionId) {
  service.allowNextInvite({ sessionId });
  return service.approve({ collabId, approve: true, sessionId });
}

function inviteFrame({ collabId, manager = SELF_A, members, name = '讨论甲', topic = '议题', mode = 'forum', endpoints } = {}) {
  seq++;
  const roster = members ?? [manager, peer('inst-self', '本机', 17321)];
  const payload = {
    name,
    topic,
    members: roster.map((entry) => ({ instanceId: entry.instanceId, sessionId: entry.sessionId ?? sessionOf(entry.instanceId), identityName: entry.identityName })),
    mode,
  };
  if (endpoints !== undefined) {
    payload.endpoints = endpoints;
  }
  return { v: 1, cap: 2, type: 'invite', msgId: `msg-inv-${seq}`, from: { instanceId: manager.instanceId, sessionId: manager.sessionId ?? sessionOf(manager.instanceId), identityName: manager.identityName, port: manager.port }, collabId, ts: new Date().toISOString(), payload };
}

function joinFrameOf(collabId, from, ts) {
  seq++;
  return { v: 1, cap: 2, type: 'join', msgId: `msg-join-${seq}`, from: { instanceId: from.instanceId, sessionId: from.sessionId ?? sessionOf(from.instanceId), identityName: from.identityName, port: from.port }, collabId, ts: ts ?? new Date().toISOString(), payload: { eventId: `evt-join-${seq}`, ts: ts ?? new Date().toISOString() } };
}

function forumPostFrame(collabId, from, { postId, seq: postSeq, text }, ts) {
  const frame = collabFrame('post', collabId, from, { post: { postId, seq: postSeq, kind: 'reply', text } });
  if (ts !== undefined) {
    frame.ts = ts;
  }
  return frame;
}

function sentOf(sent, type, collabId = null) {
  return sent.filter((entry) => entry.type === type && (collabId === null || entry.collabId === collabId));
}

/* 服务夹具（对表用例专用）：假发送（入队只记账）+ 可注入直投虚拟线 + 假提示面。 */
function makeService(t, overrides = {}) {
  const dir = makeTempDir(t);
  const sent = [];
  const direct = [];
  const notices = [];
  const self = overrides.self ?? SELF_B;
  const config = { inviteTtlMs: DAY, ...(overrides.config ?? {}) };
  const service = createCollabService({
    dataDir: dir,
    config,
    self,
    send: overrides.send ?? ((message) => {
      sent.push(message);
      return { ok: true, msgId: `q-${sent.length}` };
    }),
    sendDirect: overrides.sendDirect ?? ((message) => {
      direct.push(message);
      return { ok: true, msgId: `d-${direct.length}` };
    }),
    notify: (frame) => {
      notices.push(frame);
    },
    knownHosts: { remember: () => {} },
    log: quietLog(),
    ledgerFetchTimeoutMs: 30,
    inviteMinIntervalMs: 0,
    pullReplyTimeoutMs: overrides.pullReplyTimeoutMs ?? 60,
    syncPeerPicker: overrides.syncPeerPicker,
    syncRequestMax: 50,
    syncMaxRequestsPerCycle: overrides.syncMaxRequestsPerCycle ?? 2,
    syncSoftBundleBytes: 512 * 1024,
    joinReplayIntervalsMs: overrides.joinReplayIntervalsMs ?? [10, 20, 40],
  });
  return { service, sent, direct, notices, dir, self, config };
}

/* 直投虚拟线：sendDirect → 组线上帧 → 投进对端接收管线；hop = 手工一跳投递。 */
function makeWire() {
  const nodes = new Map();
  const frames = [];
  let serial = 0;
  const build = (message, fromSelf) => {
    serial++;
    const from = { instanceId: fromSelf.instanceId, identityName: fromSelf.identityName, port: fromSelf.port };
    const ts = typeof message.createdAt === 'string' ? message.createdAt : new Date().toISOString();
    return { v: 1, type: message.type, msgId: `wire-${serial}`, from, to: message.to, collabId: message.collabId, ts, payload: message.payload };
  };
  const addressOf = (self) => `127.0.0.${self.port - 17320}`;
  const deliver = (target, frame, sourceAddress) => Promise.resolve().then(() => receive(target.service, frame, sourceAddress)).catch(() => {});
  return {
    register(self, service) {
      nodes.set(self.instanceId, { self, service });
    },
    unregister(self) {
      nodes.delete(self.instanceId);
    },
    frames,
    sendDirectFor(self) {
      return (message) => {
        const frame = build(message, self);
        frames.push(frame);
        const target = nodes.get(message.to?.instanceId);
        if (target !== undefined) {
          deliver(target, frame, addressOf(self));
        }
        return { ok: true, msgId: frame.msgId };
      };
    },
    async hop(service, message, fromSelf) {
      return receive(service, { ...build(message, fromSelf), msgId: `hop-${serial++}` }, addressOf(fromSelf));
    },
  };
}

/* 保活等待：对表轮次的应答等待面用 unref 定时器——等待「可能无应答」的轮次时需要外部保活。 */
async function awaitSync(pending) {
  const keepAlive = setInterval(() => {}, 20);
  try {
    return await pending;
  } finally {
    clearInterval(keepAlive);
  }
}

/* 双节点对表场景：A=发起人（站长席位）、B=成员（受邀并已加入，join 经手工一跳送达 A）。 */
async function makeForumPair(t, overrides = {}) {
  const wire = makeWire();
  const selfA = overrides.selfA ?? SELF_A;
  const selfB = overrides.selfB ?? SELF_B;
  const madeA = makeService(t, { self: selfA, sendDirect: wire.sendDirectFor(selfA), ...overrides.a });
  wire.register(selfA, madeA.service);
  const madeB = makeService(t, { self: selfB, sendDirect: wire.sendDirectFor(selfB), syncPeerPicker: overrides.b?.syncPeerPicker ?? (() => [selfA.instanceId]), ...overrides.b });
  wire.register(selfB, madeB.service);
  const made = madeA.service.create({
    name: '讨论甲',
    topic: '议题',
    mode: 'forum',
    sessionId: sessionOf(selfA.instanceId),
    targets: [{ instanceId: selfB.instanceId, identityName: selfB.identityName, address: '127.0.0.2', port: selfB.port }],
  });
  const collabId = made.collabId;
  await receive(madeB.service, inviteFrame({
    collabId,
    name: '讨论甲',
    topic: '议题',
    members: [peer(selfA.instanceId, selfA.identityName, selfA.port), peer(selfB.instanceId, selfB.identityName, selfB.port)],
  }));
  await approveForum(madeB.service, collabId, sessionOf(selfB.instanceId));
  const joinMessage = sentOf(madeB.sent, 'join', collabId)[0];
  await wire.hop(madeA.service, joinMessage, selfB);
  await awaitSync(madeB.service.sync({ collabId }));
  return { wire, selfA, selfB, a: madeA, b: madeB, collabId, joinMessage };
}

test('周期 tick：对表引擎按间隔驱动对表——对端新帖经 tick 自动拉回（无需手工触发）', async (t) => {
  const { a, b, collabId } = await makeForumPair(t, { b: { config: { forumSyncIntervalMs: 25 } } });
  const before = (await b.service.view({ collabId })).posts.length;
  await receive(a.service, forumPostFrame(collabId, AUTHOR_U, { postId: 'post-tick-1', seq: 1, text: 'tick 拉回的帖' }, new Date().toISOString()));
  const cyclesBefore = b.service.stats().syncCycles;
  b.service.start();
  await waitFor(async () => ((await b.service.view({ collabId })).posts.length > before ? true : null), { timeoutMs: 5000 });
  assert.equal(b.service.stats().syncCycles > cyclesBefore, true, '轮次由周期 tick 驱动（非手工 syncNow）');
  await b.service.close();
});

test('周期 tick：对表单轮异常被隔离为计数与告警（引擎不因单轮异常停下）', async (t) => {
  const made = makeService(t, {
    config: { forumSyncIntervalMs: 25 },
    syncPeerPicker: () => {
      throw new Error('注入的对端序异常');
    },
  });
  const collabId = 'collab-tick-fail';
  await receive(made.service, inviteFrame({
    collabId,
    manager: peer(SELF_A.instanceId, SELF_A.identityName, SELF_A.port),
    members: [peer(SELF_A.instanceId, SELF_A.identityName, SELF_A.port), peer(SELF_B.instanceId, SELF_B.identityName, SELF_B.port)],
    endpoints: { [SELF_A.instanceId]: { address: '127.0.0.2', port: SELF_A.port } },
  }));
  await approveForum(made.service, collabId, sessionOf(SELF_B.instanceId));
  const failuresBefore = made.service.stats().syncFailures;
  made.service.start();
  await waitFor(() => (made.service.stats().syncFailures > failuresBefore ? true : null), { timeoutMs: 5000 });
  assert.equal(made.service.list().collabs.some((entry) => entry.collabId === collabId), true, '异常轮次不影响实例在册');
  await made.service.close();
});

test('收尾：停止对表引擎时未决的拉取等待面即时了结（不等应答期限）', async (t) => {
  /* 场景：本机是讨论发起人（有新形态 carrier，可跨重启加载），对端端点已知但不应答——
   * 同数据根重开一实例后发起对表，等待面挂起；收尾须即时了结等待面，而不是等满应答期限。
   * 重开实例不带自动轮，轮次归属确定。 */
  const first = makeServiceOnDir(t, makeTempDir(t), SELF_B, { pullReplyTimeoutMs: 60 });
  const created = first.service.create({
    name: '讨论甲',
    topic: '议题',
    mode: 'forum',
    sessionId: sessionOf(SELF_B.instanceId),
    targets: [{ instanceId: SELF_C.instanceId, identityName: SELF_C.identityName, address: '127.0.0.3', port: SELF_C.port }],
  });
  assert.equal(created.ok, true, String(created.message));
  const collabId = created.collabId;
  await new Promise((resolve) => setTimeout(resolve, 200));   // 等首实例的自动轮收口（60ms 期限）
  await first.service.close();

  const second = makeServiceOnDir(t, first.dir, SELF_B, { pullReplyTimeoutMs: 8000 });
  const pending = second.service.sync({ collabId });
  const raced = await Promise.race([pending.then((value) => ({ settled: true, value })), new Promise((resolve) => setTimeout(() => resolve({ settled: false }), 1500))]);
  assert.equal(raced.settled, false, `定向对表应进入等待面（对端不应答）：${JSON.stringify(raced.value ?? null)}`);
  const startedAt = Date.now();
  await second.service.close();
  const outcome = await awaitSync(pending);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'no-answer', `收尾即了结为无应答：${JSON.stringify(outcome)}`);
  assert.equal(Date.now() - startedAt < 4000, true, '收尾不等待应答期限（8000ms 未到）');
});

/* 轮换场景：A=站长席位（真应答），B=已加入成员（不注入对端序→走轮换），C 仅端点已知（不应答）。 */
async function makeRotationScene(t, wire) {
  const madeA = makeService(t, { self: SELF_A, sendDirect: wire.sendDirectFor(SELF_A) });
  wire.register(SELF_A, madeA.service);
  const madeB = makeService(t, { self: SELF_B, sendDirect: wire.sendDirectFor(SELF_B), pullReplyTimeoutMs: 50 });
  wire.register(SELF_B, madeB.service);
  const created = madeA.service.create({
    name: '讨论甲',
    topic: '议题',
    mode: 'forum',
    sessionId: sessionOf(SELF_A.instanceId),
    targets: [
      { instanceId: SELF_B.instanceId, identityName: SELF_B.identityName, address: '127.0.0.2', port: SELF_B.port },
      { instanceId: SELF_C.instanceId, identityName: SELF_C.identityName, address: '127.0.0.3', port: SELF_C.port },
    ],
  });
  const collabId = created.collabId;
  await receive(madeB.service, inviteFrame({
    collabId,
    name: '讨论甲',
    topic: '议题',
    manager: peer(SELF_A.instanceId, SELF_A.identityName, SELF_A.port),
    members: [
      peer(SELF_A.instanceId, SELF_A.identityName, SELF_A.port),
      peer(SELF_B.instanceId, SELF_B.identityName, SELF_B.port),
      peer(SELF_C.instanceId, SELF_C.identityName, SELF_C.port),
    ],
    endpoints: {
      [SELF_A.instanceId]: { address: '127.0.0.2', port: SELF_A.port },
      [SELF_C.instanceId]: { address: '127.0.0.3', port: SELF_C.port },
    },
  }));
  await approveForum(madeB.service, collabId, sessionOf(SELF_B.instanceId));
  await wire.hop(madeA.service, sentOf(madeB.sent, 'join', collabId)[0], SELF_B);
  return { madeA, madeB, collabId };
}

/* 单轮驱动：settled=false 表示轮次仍在等待面（长等待）。 */
function driveSyncRound(service, collabId, waitMs = 800) {
  return Promise.race([
    service.sync({ collabId }).then((value) => ({ settled: true, value })),
    new Promise((resolve) => setTimeout(() => resolve({ settled: false }), waitMs)),
  ]);
}

test('候选轮换：无对端序注入时按轮换序取源——次轮改从另一源起（换源重试）', async (t) => {
  const wire = makeWire();
  const { madeB, collabId } = await makeRotationScene(t, wire);
  const requestTargets = () => wire.frames
    .filter((frame) => frame.type === 'history-request' && frame.from.instanceId === SELF_B.instanceId && frame.to !== undefined)
    .map((frame) => frame.to.instanceId);
  const hasRotationPair = () => {
    const seen = requestTargets();
    return seen.some((id, index) => index > 0 && id === SELF_C.instanceId && seen[index + 1] === SELF_A.instanceId);
  };
  /* 加入触发的自动轮先落线（其首源即轮换序首候选）；随后驱动轮次直至观察到
   * 「inst-c 起首 → 换回 inst-a」的相邻序（自动/重播轮在途时同步调用返回 already-running，重试即可）。 */
  await waitFor(() => (requestTargets().length >= 1 ? true : null), { timeoutMs: 5000 });
  await waitFor(async () => {
    if (hasRotationPair()) {
      return true;
    }
    const raced = await driveSyncRound(madeB.service, collabId);
    if (raced.settled === true && raced.value.ok !== true && raced.value.reason !== 'already-running') {
      throw new Error(`非预期的轮次结论：${JSON.stringify(raced.value)}`);
    }
    return hasRotationPair() ? true : null;
  }, { timeoutMs: 10000, intervalMs: 5 });
  const targets = requestTargets();
  assert.equal(targets[0], SELF_A.instanceId, '首轮首源 = 轮换序首个候选（inst-a）');
});

test('成立时刻兜底：台账缺 establishedAt（旧数据）时按最早他方 join 事件推导', async (t) => {
  const madeA = makeService(t, { self: SELF_A });
  const created = madeA.service.create({
    name: '讨论甲',
    topic: '议题',
    mode: 'forum',
    sessionId: sessionOf(SELF_A.instanceId),
    targets: [{ instanceId: SELF_B.instanceId, identityName: SELF_B.identityName, address: '127.0.0.2', port: SELF_B.port }],
  });
  assert.equal(created.ok, true, String(created.message));
  const collabId = created.collabId;
  const joinTs = new Date(Date.now() - 60000).toISOString();
  await receive(madeA.service, joinFrameOf(collabId, SELF_B, joinTs));
  /* 旧数据形态：状态已 active 而成立时刻缺失（模拟历史版本落盘缺字段）。 */
  const ledgerPath = collabFilePath(madeA.dir, collabId, LEDGER_FILE_NAME);
  const lines = readFileSync(ledgerPath, 'utf8').trim().split('\n');
  const latest = JSON.parse(lines[lines.length - 1]);
  delete latest.establishedAt;
  latest.status = 'active';
  writeFileSync(ledgerPath, `${JSON.stringify(latest)}\n`);
  const reloaded = makeServiceOnDir(t, madeA.dir, SELF_A);
  const firstReq = await receive(reloaded.service, collabFrame('history-request', collabId, SELF_B, { after: null }));
  assert.equal(firstReq.ok, true, JSON.stringify(firstReq));
  const bundles = reloaded.direct.filter((message) => message.type === 'history-bundle' && message.collabId === collabId);
  assert.equal(bundles.length, 1, '站长席位应答一帧回填');
  assert.equal(bundles[0].payload.meta.establishedAt, joinTs, '成立时刻按最早他方 join 事件推导（兜底不臆造新值）');
});

/* 同数据根的服务实例（旧数据形态的加载面 / 重开实例面）：注册表从盘重载。 */
function makeServiceOnDir(t, dir, self, options = {}) {
  const sent = [];
  const direct = [];
  const notices = [];
  const service = createCollabService({
    dataDir: dir,
    config: { inviteTtlMs: DAY },
    self,
    send: (message) => {
      sent.push(message);
      return { ok: true, msgId: `p-${sent.length}` };
    },
    sendDirect: (message) => {
      direct.push(message);
      return { ok: true, msgId: `pd-${direct.length}` };
    },
    notify: (frame) => {
      notices.push(frame);
    },
    /* 已知主机面：端点表未持久化——重开实例的寻址兜底经此提供（与核心接线的 known-hosts 同角色）。 */
    knownHosts: {
      remember: () => {},
      lookup: (instanceId) => (instanceId === SELF_B.instanceId ? { address: '127.0.0.2', port: SELF_B.port } : null),
    },
    log: quietLog(),
    ledgerFetchTimeoutMs: 30,
    inviteMinIntervalMs: 0,
    pullReplyTimeoutMs: options.pullReplyTimeoutMs ?? 60,
    joinReplayIntervalsMs: options.joinReplayIntervalsMs ?? [10, 20, 40],
  });
  t.after(() => service.close());
  return { service, sent, direct, notices, dir };
}
