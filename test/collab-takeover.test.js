import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { collabDir } from '../src/paths.js';
import { makeTempDir, waitFor } from './helpers.js';
import { makeLedger, seedSessionCollab } from './helpers/session-participants.js';
import { createCollabService } from '../src/collab/service.js';
import { ledgerDigest } from '../src/collab/store.js';
import { acceptManagerChange } from '../src/collab/term.js';
import { handleHandshake, m5RuntimeOf, takeOver } from '../src/collab/takeover.js';

/* 站长交接（设计 §2A）：握手对表、失联判定、手动接管（A4）与窗口内接管（A3）、同 term 分叉（A8）、
 * 终态快照与 presence 超时离席。
 *
 * 夹具形态（consume-only）：新台账（managerTerm/joinSeqNext/manager.sessionId/席位 joinSeq）+
 * carrier(session-seats) + seats/ 全部预置——本文件不经 create/invite/join 的产品路径；
 * 「接管判定」组直接驱动 takeover 模块，服务授权与工具面全链由 e2e 覆盖。协作域帧携 cap=2、
 * from.sessionId、managerTerm/version/managerWindow（设计 §2A.1/§5.1）。
 *
 * 已删除用例 → 设计依据 / 替代覆盖：
 * - 抢接收集窗口/中止/待确认/confirm 越窗：v4 删除收集窗口与候选优先序（§0.4；§2A.6 改为
 *   窗口内任意活跃成员可接管）；新 A3 用例覆盖窗口内接管。
 * - 并发让位/优先序/汇总报告/意图/takeover-init：同上（§0.4）；takeover-init/takeover 帧仅保留
 *   接收转达兼容。
 * - 收到生效通告（原站长侧）删除本地台账 / 目标自行提升：v4 改为旧站长降级并保留只读副本
 *   （§2A.8），目标只校验并记录（§2A.4）。
 * - 陈旧席位主张三条：席位时钟/旧记录判据随优先序一并删除（§0.4）。
 * - 无在册端点时不置保守态：现实现把本机组广播计入已发送，无他机端点时仍按时限进入
 *   handshake-unresolved；该口径未在设计写明，按产品缺陷 ISSUE 上报，夹具不固化。
 * - 探测可观测性（旧 manager-changed 无端点）：旧载荷形态退役，端点由 A1–A4 帧必填（§2A.1）。
 * - 快照回执计数 / rosterSkipped / 失联提示 / 队列解耦 / 握手学到新站长引用：均有运行中的
 *   替代用例（见本文件与 collab-takeover-followup 的同名用例）。 */

const COLLAB = 'collab-takeover';
const MGR = { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '甲机' };
const MEM = { instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙机' };
const RIVAL = { instanceId: 'inst-c', sessionId: 'sess-c', identityName: '丙机' };
const MGR_ENDPOINT = { address: '127.0.0.1', port: 17321 };
const MEM_ENDPOINT = { address: '127.0.0.2', port: 17321 };
const RIVAL_ENDPOINT = { address: '127.0.0.3', port: 17321 };

const NOW = Date.now();
const iso = (ms = NOW) => new Date(ms).toISOString();

/* 文件级保活：接管发起/对表等待面用 unref 定时器（生产语义：会话关闭即退出）——本文件有
 * 「无外部事件」的等待轮次，须有外部定时器托住事件循环，否则 runner 判循环已空而取消用例。 */
const keepAlive = setInterval(() => {}, 20);
after(() => {
  clearInterval(keepAlive);
});

function quietLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function membersOf({ term = 1 } = {}) {
  return [
    { ...MGR, role: 'manager', joinSeq: 1, term },
    { ...MEM, role: 'member', joinSeq: 2 },
    { ...RIVAL, role: 'member', joinSeq: 3 },
  ];
}

function memberRecordOf(endpoints) {
  return {
    collabId: COLLAB,
    name: '交接协作',
    topic: '交接主题',
    role: 'member',
    state: 'active',
    manager: { instanceId: MGR.instanceId, sessionId: MGR.sessionId, identityName: MGR.identityName },
    endpoints,
    roster: membersOf(),
    mode: 'managed',
    decision: 'approved',
  };
}

/* 成员侧服务（inst-b 在册）：可指定台账窗口与成员记录端点。 */
function makeMemberHarness(t, { term = 1, version = 3, window = undefined, endpoints = { [MGR.instanceId]: MGR_ENDPOINT }, config = {} } = {}) {
  const dir = makeTempDir(t);
  seedSessionCollab(dir, COLLAB, {
    name: '交接协作',
    status: 'active',
    managerTerm: term,
    version,
    manager: { ...MGR, term },
    members: membersOf({ term }),
    managerWindow: window,
    seats: [{ sessionId: MEM.sessionId, role: 'member', joinSeq: 2 }],
    endpoints,
    snapshotFrom: MGR.instanceId,
    member: memberRecordOf(endpoints),
  });
  const sent = [];
  const service = createCollabService({
    dataDir: dir,
    config: memberHarnessConfig(config),
    self: { instanceId: MEM.instanceId, identityName: MEM.identityName, port: 17321 },
    send: (message) => {
      sent.push(message);
      return { ok: true, msgId: `q-${sent.length}` };
    },
    knownHosts: { remember: () => {}, lookup: () => null },
    log: quietLog(),
    ledgerFetchTimeoutMs: 30,
    inviteMinIntervalMs: 0,
    notify: () => {},
    syncPeerPicker: () => [],
    handshakeReplyTimeoutMs: 40,
  });
  t.after(() => service.close());
  return { dir, service, sent };
}

function memberHarnessConfig(overrides) {
  return {
    managerProbeIntervalMs: 20,
    managerLossTimeoutMs: 300000,
    sessionSeatTimeoutMs: 300000,
    seatPresenceIntervalMs: 30000,
    sessionSeatGraceMs: 60000,
    handshakeReplyTimeoutMs: 60000,
    ...overrides,
  };
}

/* 站长侧服务（inst-a 在册，成员 inst-b 端点已知）。 */
function makeManagerHarness(t, { endpoints = { [MEM.instanceId]: MEM_ENDPOINT, [RIVAL.instanceId]: RIVAL_ENDPOINT }, config = {} } = {}) {
  const dir = makeTempDir(t);
  seedSessionCollab(dir, COLLAB, {
    name: '交接协作',
    status: 'active',
    managerTerm: 1,
    version: 3,
    manager: MGR,
    members: membersOf(),
    seats: [{ sessionId: MGR.sessionId, role: 'manager', joinSeq: 1 }],
    endpoints,
    snapshotFrom: MGR.instanceId,
  });
  const sent = [];
  const service = createCollabService({
    dataDir: dir,
    config: {
      managerProbeIntervalMs: 20,
      managerLossTimeoutMs: 300000,
      handshakeReplyTimeoutMs: 40,
      ...config,
    },
    self: { instanceId: MGR.instanceId, identityName: MGR.identityName, port: 17321 },
    send: (message) => {
      sent.push(message);
      return { ok: true, msgId: `q-${sent.length}` };
    },
    knownHosts: { remember: () => {}, lookup: () => null },
    log: quietLog(),
    ledgerFetchTimeoutMs: 30,
    inviteMinIntervalMs: 0,
    notify: () => {},
    syncPeerPicker: () => [],
    handshakeReplyTimeoutMs: 40,
  });
  t.after(() => service.close());
  return { dir, service, sent };
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
    ts: iso(),
    payload,
    remoteAddress,
  };
}

async function receive(service, frame, remoteAddress = frame.remoteAddress ?? '127.0.0.1', peerInstanceId = null) {
  const meta = { remoteAddress, ...(peerInstanceId === null ? {} : { peerInstanceId }) };
  const admitted = await service.hooks.admit(frame, meta);
  if (admitted?.ok === true) {
    await service.hooks.consume(frame, meta);
  }
  return admitted;
}

function memberRecordOnDisk(dir) {
  return JSON.parse(readFileSync(join(dir, 'collabs', COLLAB, 'member.json'), 'utf8'));
}

function managerRefOnDisk(dir) {
  return memberRecordOnDisk(dir).manager;
}

function handshakePayloadOf(overrides = {}) {
  return {
    event: 'handshake',
    role: 'member',
    managerTerm: 1,
    version: 3,
    manager: { instanceId: MGR.instanceId, sessionId: MGR.sessionId, identityName: MGR.identityName },
    reply: false,
    ...overrides,
  };
}

/* —— 握手对表 —— */

test('握手：站长席位向名册广播（role=manager、managerTerm/version 取台账、reply=false、席位署名）', async (t) => {
  const harness = makeManagerHarness(t);
  harness.sent.length = 0;
  harness.service.handshake();
  const frames = harness.sent.filter((frame) => frame.type === 'notice' && frame.payload.event === 'handshake');
  assert.equal(frames.length, 2, '逐成员机器各一帧');
  const first = frames.find((frame) => frame.to.instanceId === MEM.instanceId);
  assert.equal(first.payload.role, 'manager');
  assert.equal(first.payload.reply, false);
  assert.equal(first.payload.managerTerm, 1);
  assert.equal(first.payload.version, 3);
  assert.equal(first.payload.manager.sessionId, MGR.sessionId);
  assert.equal(first.fromSessionId, MGR.sessionId, '由站长席位签发');
});

test('握手：收到非回帧必回一帧（reply=true），回帧不再被回（防乒乓）', async (t) => {
  const harness = makeManagerHarness(t);
  harness.sent.length = 0;
  await receive(harness.service, frameOf('notice', MEM, handshakePayloadOf()));
  const replies = harness.sent.filter((frame) => frame.type === 'notice' && frame.payload.event === 'handshake');
  assert.equal(replies.length, 1);
  assert.equal(replies[0].payload.reply, true);
  assert.equal(replies[0].to.instanceId, MEM.instanceId);
  assert.equal(replies[0].payload.managerTerm, 1);
  harness.sent.length = 0;
  await receive(harness.service, frameOf('notice', MEM, handshakePayloadOf({ reply: true })));
  assert.equal(harness.sent.filter((frame) => frame.payload?.event === 'handshake').length, 0);
});

test('握手：成员对表——现任站长任期/版本更高时拉取当前视图', async (t) => {
  const harness = makeMemberHarness(t);
  harness.sent.length = 0;
  await receive(harness.service, frameOf('notice', MGR, handshakePayloadOf({ role: 'manager', managerTerm: 2, version: 9 })));
  const requests = harness.sent.filter((frame) => frame.type === 'snapshot' && frame.payload.kind === 'request');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].to.instanceId, MGR.instanceId);
  assert.equal(requests[0].fromSessionId, MEM.sessionId, '请求由成员席位签发');
});

test('握手：更高任期的新站长应答 → 向该站长请求快照（学到引用，不凭握手改写本地站长）', async (t) => {
  const harness = makeMemberHarness(t, {
    endpoints: { [MGR.instanceId]: MGR_ENDPOINT, [RIVAL.instanceId]: RIVAL_ENDPOINT },
  });
  harness.sent.length = 0;
  await receive(harness.service, frameOf('notice', RIVAL, handshakePayloadOf({
    role: 'manager',
    managerTerm: 2,
    version: 9,
    manager: { instanceId: RIVAL.instanceId, sessionId: RIVAL.sessionId, identityName: RIVAL.identityName },
    managerEndpoint: RIVAL_ENDPOINT,
  })));
  const requests = harness.sent.filter((frame) => frame.type === 'snapshot' && frame.payload.kind === 'request');
  assert.equal(requests.length, 1, '向应答者请求快照补齐任期');
  assert.equal(requests[0].to.instanceId, RIVAL.instanceId, '请求发给握手报出的新站长');
  assert.equal(requests[0].payload.purpose, 'catchup');
  assert.equal(managerRefOnDisk(harness.dir).instanceId, MGR.instanceId, '握手不直接改写本地站长引用（须经快照受理）');
});

test('治理广播：无端点的远端成员被跳过并计 rosterSkipped（不静默）', async (t) => {
  const harness = makeManagerHarness(t, { endpoints: { [MEM.instanceId]: MEM_ENDPOINT } });
  harness.sent.length = 0;
  harness.service.handshake();
  assert.equal(harness.service.stats().rosterSkipped, 1);
  assert.equal(harness.sent.some((frame) => frame.to?.instanceId === MEM.instanceId), true, '有端点的成员照发');
  assert.equal(harness.sent.some((frame) => frame.to?.instanceId === RIVAL.instanceId), false, '无端点成员不发送');
});

test('握手：同任期不同站长主张 → 判定分叉并冻结（不按版本/优先序选胜者）', async (t) => {
  const harness = makeMemberHarness(t);
  await receive(harness.service, frameOf('notice', RIVAL, handshakePayloadOf({
    role: 'manager',
    manager: { instanceId: RIVAL.instanceId, sessionId: RIVAL.sessionId, identityName: RIVAL.identityName },
  })));
  assert.equal(harness.service.list().collabs[0].state, 'frozen', '同 term 冲突一律冻结（设计 §0.4 S6）');
  assert.equal(managerRefOnDisk(harness.dir).instanceId, MGR.instanceId, '不静默改现任');
});

test('握手：站长席位无法对表（无回帧）→ 停写保守运行；任一已受理帧接触后恢复', async (t) => {
  const harness = makeManagerHarness(t);
  harness.service.start();
  await waitFor(() => (harness.service.list().collabs[0].suspended === true ? true : null), { timeoutMs: 3000 });
  const blocked = await harness.service.send({ collabId: COLLAB, text: '暂停期消息', type: 'issue', sessionId: MGR.sessionId });
  assert.equal(blocked.ok, false);
  assert.ok(blocked.message.includes('暂停'), blocked.message);
  assert.equal(harness.service.stats().handshakeUnresolved >= 1, true);
  await receive(harness.service, frameOf('reply', MEM, { text: '任意在册联系' }));
  assert.equal(harness.service.list().collabs[0].suspended, false, '任一已受理帧即视为接触');
});

test('探测方向：站长席位不发起探测（计数零增长）', async (t) => {
  const harness = makeManagerHarness(t);
  harness.service.start();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(harness.service.stats().probeAttempts, 0);
});

/* —— 接管判定（设计 §2A.6/§2A.7）：直接驱动 takeover 模块的裁决面 ——
 * 夹具注入最小共享态，绕过服务授权层；服务层成员会话授权与工具面全链由 e2e 覆盖。 */

function takeoverSnapshotOf(ledger, role) {
  if (role === 'manager') {
    return null;
  }
  return {
    version: ledger.version,
    digest: ledgerDigest(ledger),
    receivedAt: iso(),
    from: { instanceId: MGR.instanceId, identityName: MGR.identityName },
    ledger,
  };
}

function takeoverLocalOf({ role, ledger, endpoints }) {
  const seatSessionId = role === 'manager' ? MGR.sessionId : MEM.sessionId;
  return {
    collabId: COLLAB,
    role,
    ledger: role === 'manager' ? ledger : null,
    member: memberRecordOf(Object.fromEntries(endpoints)),
    endpoints: new Map(endpoints),
    snapshot: takeoverSnapshotOf(ledger, role),
    seats: new Map([[seatSessionId, {
      version: 1,
      sessionId: seatSessionId,
      role: role === 'manager' ? 'manager' : 'member',
      state: 'member',
      joinSeq: role === 'manager' ? 1 : 2,
      joinedAt: iso(),
      muted: false,
      unverified: false,
    }]]),
    suspended: null,
    staleManagerId: null,
    mute: { clear: () => {} },
    handshakeUnresolved: false,
  };
}

function takeoverStateBaseOf(dir, sent) {
  return {
    dataDir: dir,
    config: { managerLossTimeoutMs: 300000, sessionTakeoverWindowMs: 60000, sessionSeatTimeoutMs: 300000, handoverConfirmTimeoutMs: 120000 },
    self: { instanceId: MEM.instanceId, identityName: MEM.identityName, port: 17321 },
    log: quietLog(),
    counters: {},
    knownHosts: { remember: () => {}, lookup: () => null },
    notify: () => {},
    send: (message) => {
      sent.push(message);
      return { ok: true, msgId: `t-${sent.length}` };
    },
    probes: new Map(),
    handshakeWatch: new Map(),
    pendingViews: new Map(),
    effectiveTakeovers: new Map(),
    takeovers: new Map(),
    rearmedTakeovers: new Map(),
    awaitingTakeovers: new Map(),
    relayedOrigins: new Map(),
    joinReplays: new Map(),
    relayDown: new Set(),
    handshakeReplyTimeoutMs: 5,
    sessionBridges: new Map(),
  };
}

/* 对表应答：接管发起会等待可达成员的最高 (term,version)（零应答按设计拒绝）——夹具在
 * handshake 出站时以另一成员身份回一帧，模拟真实对表面。replies 按目标实例覆盖应答内容
 * （缺省以 RIVAL 身份回显发起帧的 pair），供「以最高台账为基准」用例注入不同 term/version。 */
function defaultHandshakeReplyOf(message) {
  return {
    seat: RIVAL,
    managerTerm: message.payload.managerTerm,
    version: message.payload.version,
    manager: message.payload.manager,
  };
}

function autoReplySendOf(state, sent, replies = {}) {
  return (message) => {
    sent.push(message);
    if (message.type === 'notice' && message.payload?.event === 'handshake') {
      const reply = replies[message.to?.instanceId] ?? defaultHandshakeReplyOf(message);
      queueMicrotask(() => {
        handleHandshake(state, {
          v: 1,
          cap: 2,
          type: 'notice',
          msgId: `hs-reply-${sent.length}`,
          collabId: message.collabId,
          from: { instanceId: reply.seat.instanceId, sessionId: reply.seat.sessionId, identityName: reply.seat.identityName, port: 17321 },
          ts: iso(),
          payload: {
            event: 'handshake',
            role: 'member',
            managerTerm: reply.managerTerm,
            version: reply.version,
            manager: reply.manager,
            reply: true,
          },
        }).catch(() => {});
      });
    }
    return { ok: true, msgId: `t-${sent.length}` };
  };
}

function takeoverStateOf(t, { role = 'member', ledger, endpoints = [], replies = {} } = {}) {
  const dir = makeTempDir(t);
  mkdirSync(collabDir(dir, COLLAB), { recursive: true });
  const local = takeoverLocalOf({ role, ledger, endpoints });
  const sent = [];
  const state = { ...takeoverStateBaseOf(dir, sent), collabs: new Map([[COLLAB, local]]) };
  state.send = autoReplySendOf(state, sent, replies);
  return { state, local, sent, dir };
}

function ledgerForTakeover({ term = 1, version = 3, window = undefined, manager = MGR } = {}) {
  const members = membersOf({ term }).map((seat) => ({
    ...seat,
    role: seat.instanceId === manager.instanceId ? 'manager' : 'member',
  }));
  return makeLedger({
    collabId: COLLAB,
    name: '交接协作',
    status: 'active',
    managerTerm: term,
    version,
    manager: { ...manager, term },
    members,
    managerWindow: window,
  });
}

/* 接管前的台账采纳（模拟快照受理面已完成 A10/A11）：接管模块只看 local.snapshot。 */
function adoptLedgerSnapshot(local, ledger) {
  local.snapshot = {
    version: ledger.version,
    digest: ledgerDigest(ledger),
    receivedAt: iso(),
    from: { instanceId: ledger.manager.instanceId, identityName: ledger.manager.identityName },
    ledger,
  };
  if (local.member !== null && typeof local.member === 'object') {
    local.member.manager = { instanceId: ledger.manager.instanceId, identityName: ledger.manager.identityName };
  }
}

test('接管守卫：站长席位 / 无快照 / 非本机席位 / 站长可达 逐拒', async (t) => {
  const asManager = takeoverStateOf(t, { role: 'manager', sessionId: MGR.sessionId, ledger: ledgerForTakeover() });
  const managerVerdict = await takeOver(asManager.state, { collabId: COLLAB, sessionId: MGR.sessionId });
  assert.equal(managerVerdict.ok, false);
  assert.ok(managerVerdict.message.includes('站长'), managerVerdict.message);

  const bare = takeoverStateOf(t, { ledger: ledgerForTakeover() });
  bare.local.snapshot = null;
  const noSnapshot = await takeOver(bare.state, { collabId: COLLAB, sessionId: MEM.sessionId });
  assert.equal(noSnapshot.ok, false);
  assert.ok(noSnapshot.message.includes('快照'), noSnapshot.message);

  const outsider = takeoverStateOf(t, { ledger: ledgerForTakeover() });
  const notSeat = await takeOver(outsider.state, { collabId: COLLAB, sessionId: 'sess-other' });
  assert.equal(notSeat.ok, false);
  assert.ok(notSeat.message.includes('席位'), notSeat.message);

  const reachable = takeoverStateOf(t, { ledger: ledgerForTakeover(), endpoints: [[MGR.instanceId, MGR_ENDPOINT]] });
  const reachableVerdict = await takeOver(reachable.state, { collabId: COLLAB, sessionId: MEM.sessionId });
  assert.equal(reachableVerdict.ok, false, '站长可达时不得接管');
  assert.ok(reachableVerdict.message.includes('可达'), reachableVerdict.message);
});

test('A4 手动接管：站长不可达 → 挑战令牌二段式、任期+1、移除失联站长、无窗口', async (t) => {
  const { state, local, sent } = takeoverStateOf(t, {
    ledger: ledgerForTakeover(),
    endpoints: [[RIVAL.instanceId, RIVAL_ENDPOINT]],
  });
  const challenge = await takeOver(state, { collabId: COLLAB, sessionId: MEM.sessionId });
  assert.equal(challenge.ok, true, challenge.message);
  assert.equal(challenge.needsUserConfirmation, true);
  assert.ok(challenge.token);
  const done = await takeOver(state, { collabId: COLLAB, sessionId: MEM.sessionId, token: challenge.token });
  assert.equal(done.ok, true, done.message);
  assert.equal(local.role, 'manager');
  assert.equal(local.ledger.managerTerm, 2);
  assert.equal(local.ledger.version, 4);
  assert.equal(local.ledger.manager.sessionId, MEM.sessionId);
  assert.equal(local.ledger.managerWindow, undefined, '手动接管不开窗');
  assert.equal(local.ledger.members.some((entry) => entry.sessionId === MGR.sessionId), false, '失联站长席位移除');
  const change = sent.find((entry) => entry.type === 'notice' && entry.payload.event === 'manager-changed');
  assert.ok(change, '广播站长变更');
  assert.equal(change.payload.via, 'takeover-manual');
  assert.equal(change.payload.authorizedAt !== undefined, true);
  assert.equal(change.fromSessionId, MEM.sessionId, '新站长签发');
});

test('A3 窗口内接管：windowBaseTerm 对表、任期+1、清除窗口且不开新窗', async (t) => {
  const window = { windowBaseTerm: 2, windowEndsAt: iso(NOW + 60000) };
  const ledger = ledgerForTakeover({ term: 2, version: 5, window });
  const { state, local, sent } = takeoverStateOf(t, {
    ledger,
    endpoints: [[MGR.instanceId, MGR_ENDPOINT], [RIVAL.instanceId, RIVAL_ENDPOINT]],
  });
  const challenge = await takeOver(state, { collabId: COLLAB, sessionId: MEM.sessionId });
  assert.equal(challenge.ok, true, challenge.message);
  const done = await takeOver(state, { collabId: COLLAB, sessionId: MEM.sessionId, token: challenge.token });
  assert.equal(done.ok, true, done.message);
  assert.equal(local.ledger.managerTerm, 3);
  assert.equal(local.ledger.version, 6);
  assert.equal(local.ledger.manager.sessionId, MEM.sessionId);
  assert.equal(local.ledger.managerWindow, undefined, '接管后清除窗口');
  const change = sent.find((entry) => entry.type === 'notice' && entry.payload.event === 'manager-changed');
  assert.equal(change.payload.via, 'takeover');
  assert.equal(change.payload.windowBaseTerm, 2);
  assert.ok(change.payload.authorizedAt);
});

test('A3/A4 接管基准：应答给出更高 term/version 时按最高 pair 判定（A4 放弃、A3 取快照后按该台账签发）', async (t) => {
  const rivalManager = { instanceId: RIVAL.instanceId, sessionId: RIVAL.sessionId, identityName: RIVAL.identityName };

  /* A4（无窗口）：本机 1/3，成员应答报告已到 2/9 —— 按最高 pair 放弃接管并请求快照，
   * 不得按本地旧台账直接签发 2/4。 */
  const manual = takeoverStateOf(t, {
    ledger: ledgerForTakeover(),
    endpoints: [[RIVAL.instanceId, RIVAL_ENDPOINT]],
    replies: { [RIVAL.instanceId]: { seat: RIVAL, managerTerm: 2, version: 9, manager: rivalManager } },
  });
  const behind = await takeOver(manual.state, { collabId: COLLAB, sessionId: MEM.sessionId });
  assert.equal(behind.ok, false);
  assert.ok(behind.message.includes('任期'), behind.message);
  assert.equal(manual.sent.some((frame) => frame.type === 'snapshot' && frame.payload.kind === 'request' && frame.to?.instanceId === RIVAL.instanceId), true, '向最高应答者请求快照');
  assert.equal(manual.local.role, 'member', '未按旧台账自行提升');

  /* A3（窗口内）：本机 2/5，成员应答报告同一站长 term2/v9（版本更高）——先取快照；
   * 采纳该最高台账后，按 2/9 签发 3/10，窗口随接管关闭。 */
  const window = { windowBaseTerm: 2, windowEndsAt: iso(NOW + 60000) };
  const windowed = takeoverStateOf(t, {
    ledger: ledgerForTakeover({ term: 2, version: 5, window }),
    endpoints: [[RIVAL.instanceId, RIVAL_ENDPOINT]],
    replies: { [RIVAL.instanceId]: { seat: RIVAL, managerTerm: 2, version: 9, manager: MGR } },
  });
  const stale = await takeOver(windowed.state, { collabId: COLLAB, sessionId: MEM.sessionId });
  assert.equal(stale.ok, false);
  assert.ok(stale.message.includes('版本'), stale.message);
  assert.equal(windowed.sent.some((frame) => frame.type === 'snapshot' && frame.payload.kind === 'request' && frame.to?.instanceId === RIVAL.instanceId), true, '版本落后时先取快照');
  adoptLedgerSnapshot(windowed.local, ledgerForTakeover({ term: 2, version: 9, window, manager: MGR }));
  const windowChallenge = await takeOver(windowed.state, { collabId: COLLAB, sessionId: MEM.sessionId });
  assert.equal(windowChallenge.ok, true, windowChallenge.message);
  const windowDone = await takeOver(windowed.state, { collabId: COLLAB, sessionId: MEM.sessionId, token: windowChallenge.token });
  assert.equal(windowDone.ok, true, windowDone.message);
  assert.equal(windowed.local.ledger.managerTerm, 3, '以最高 term 为基准 +1');
  assert.equal(windowed.local.ledger.version, 10, '以最高 version 为基准 +1');
  assert.equal(windowed.local.ledger.managerWindow, undefined, '接管后清除窗口');
  assert.equal(windowed.local.ledger.manager.sessionId, MEM.sessionId);
  assert.equal(windowed.local.ledger.members.find((entry) => entry.instanceId === MGR.instanceId)?.role, 'member', '窗口接管保留旧站长席位并降级');
});

/* —— catch-up 快照（设计 A11/A12 步骤③）：冻结态版本落后时向握手最高 pair 持有者取快照 ——
 * 末位入席成员的本地名单可能缺后入席成员：来源资格只能由「本机刚请求过 + 握手最高 pair」限定，
 * 不得放宽成任意来源的同 term 快照。 */

/* 陈旧基线：本地快照名单缺 RIVAL，版本落后。 */
function staleLedgerOf({ version = 3 } = {}) {
  const ledger = ledgerForTakeover({ version });
  ledger.members = ledger.members.filter((member) => member.instanceId !== RIVAL.instanceId);
  return ledger;
}

function termStateFor(ledger) {
  return {
    managerTerm: ledger.managerTerm,
    manager: { instanceId: MGR.instanceId, sessionId: MGR.sessionId, identityName: MGR.identityName },
    version: ledger.version,
  };
}

function staleMemberSeats() {
  return membersOf().filter((seat) => seat.role !== 'manager' && seat.instanceId !== RIVAL.instanceId);
}

function snapshotFrameOf(ledger, from) {
  return {
    kind: 'data',
    managerTerm: ledger.managerTerm,
    version: ledger.version,
    digest: ledgerDigest(ledger),
    ledger,
    from: { ...from },
  };
}

const CATCHUP_HIGHEST = { term: 1, version: 9, manager: { instanceId: MGR.instanceId, sessionId: MGR.sessionId, identityName: MGR.identityName } };

test('catch-up：同 term 版本落后 → 向最高应答者请求快照，携 purpose:catchup 并登记选中来源', async (t) => {
  const { state, local, sent } = takeoverStateOf(t, {
    ledger: staleLedgerOf(),
    endpoints: [[RIVAL.instanceId, RIVAL_ENDPOINT]],
    replies: { [RIVAL.instanceId]: { seat: RIVAL, managerTerm: 1, version: 9, manager: MGR } },
  });
  const verdict = await takeOver(state, { collabId: COLLAB, sessionId: MEM.sessionId });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.message.includes('版本'), verdict.message);
  const requests = sent.filter((frame) => frame.type === 'snapshot' && frame.payload.kind === 'request');
  const selected = requests.filter((frame) => frame.to?.instanceId === RIVAL.instanceId);
  assert.equal(selected.length >= 1, true, '向最高应答者请求快照');
  assert.equal(selected.every((frame) => frame.payload.purpose === 'catchup'), true, '冻结态成员只应答携 purpose 的请求');
  const runtime = m5RuntimeOf(state);
  assert.equal(runtime.catchupSources.get(COLLAB)?.instanceId, RIVAL.instanceId, '登记本请求选中的来源（不写受理记录）');
  assert.equal(local.role, 'member', '未按旧台账提升');
});

test('catch-up：同 term 版本落后的握手应答 → 向应答者请求快照并携 purpose:catchup', async (t) => {
  const { state, sent } = takeoverStateOf(t, { ledger: ledgerForTakeover(), endpoints: [[RIVAL.instanceId, RIVAL_ENDPOINT]] });
  await handleHandshake(state, frameOf('notice', RIVAL, handshakePayloadOf({ reply: true, version: 9 })));
  const requests = sent.filter((frame) => frame.type === 'snapshot' && frame.payload.kind === 'request');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].to.instanceId, RIVAL.instanceId);
  assert.equal(requests[0].payload.purpose, 'catchup', '同 term 版本落后同样是追赶');
  assert.equal(m5RuntimeOf(state).catchupSources.get(COLLAB)?.instanceId, RIVAL.instanceId);
});

test('catch-up 受理：陈旧名单缺来源，但本机请求过且内容＝握手最高 pair → 同 term 采纳', () => {
  const stale = staleLedgerOf();
  const next = staleLedgerOf({ version: 9 });
  const state = termStateFor(stale);
  const frame = snapshotFrameOf(next, RIVAL);
  const baseCtx = {
    now: NOW,
    localFrozen: 'manager-offline',
    memberSeats: staleMemberSeats(),
    handshakeHighest: CATCHUP_HIGHEST,
    ledgerDigestOf: ledgerDigest,
  };
  const direct = acceptManagerChange(state, frame, { ...baseCtx, catchupSource: { instanceId: RIVAL.instanceId } });
  assert.equal(direct.accepted, true, `期望受理，实际 ${direct.reason}`);
  assert.equal(direct.reason, 'snapshot-version-accepted');
  assert.equal(direct.nextState.version, 9);
  assert.equal(direct.actions.includes('clear-freeze'), false, '同 term 名单刷新不解除 manager-offline');
  /* 接线层实际送达的形状：选择结果经 acceptedManager 透传。 */
  const wired = acceptManagerChange(state, frame, { ...baseCtx, acceptedManager: { catchupSource: { instanceId: RIVAL.instanceId } } });
  assert.equal(wired.accepted, true, `期望受理，实际 ${wired.reason}`);
});

test('catch-up 受理：未经请求 / 来源非选中者 / 内容≠握手最高 pair → 一律拒收', () => {
  const stale = staleLedgerOf();
  const next = staleLedgerOf({ version: 9 });
  const state = termStateFor(stale);
  const frame = snapshotFrameOf(next, RIVAL);
  const baseCtx = {
    now: NOW,
    localFrozen: 'manager-offline',
    memberSeats: staleMemberSeats(),
    handshakeHighest: CATCHUP_HIGHEST,
    ledgerDigestOf: ledgerDigest,
  };
  const unrequested = acceptManagerChange(state, frame, baseCtx);
  assert.equal(unrequested.accepted, false, '未请求过的来源不得凭握手最高 pair 转正');
  assert.equal(unrequested.reason, 'snapshot-source-not-manager');
  const otherSource = acceptManagerChange(state, frame, { ...baseCtx, catchupSource: { instanceId: 'inst-outsider' } });
  assert.equal(otherSource.accepted, false, '选中来源之外的应答仍拒收');
  const stalePair = acceptManagerChange(state, frame, {
    ...baseCtx,
    catchupSource: { instanceId: RIVAL.instanceId },
    handshakeHighest: { ...CATCHUP_HIGHEST, version: 8 },
  });
  assert.equal(stalePair.accepted, false, '快照必须与握手最高 pair 完全一致');
  /* 同 term 不同 manager 仍按 A12 冻结，来源放宽不改变任期判据。 */
  const conflicting = staleLedgerOf({ version: 9 });
  conflicting.manager = { ...RIVAL, term: 1 };
  conflicting.members = membersOf().map((seat) => ({ ...seat, role: seat.instanceId === RIVAL.instanceId ? 'manager' : 'member' }));
  const conflict = acceptManagerChange(state, snapshotFrameOf(conflicting, RIVAL), { ...baseCtx, catchupSource: { instanceId: RIVAL.instanceId } });
  assert.equal(conflict.accepted, false);
  assert.equal(conflict.freezeReason, 'manager-fork');
});

test('catch-up 受理：更高 term 的冻结态追赶同样只认本机请求过的来源', () => {
  const stale = staleLedgerOf();
  const higher = makeLedger({
    collabId: COLLAB,
    name: '交接协作',
    status: 'active',
    managerTerm: 2,
    version: 10,
    manager: RIVAL,
    members: membersOf().map((seat) => ({ ...seat, role: seat.instanceId === RIVAL.instanceId ? 'manager' : 'member' })),
  });
  const state = termStateFor(stale);
  const frame = snapshotFrameOf(higher, RIVAL);
  const ctx = {
    now: NOW,
    localFrozen: 'manager-offline',
    memberSeats: staleMemberSeats(),
    handshakeHighest: { term: 2, version: 10, manager: { instanceId: RIVAL.instanceId, sessionId: RIVAL.sessionId, identityName: RIVAL.identityName } },
    ledgerDigestOf: ledgerDigest,
  };
  const accepted = acceptManagerChange(state, frame, { ...ctx, catchupSource: { instanceId: RIVAL.instanceId } });
  assert.equal(accepted.accepted, true, `期望受理，实际 ${accepted.reason}`);
  assert.equal(accepted.reason, 'snapshot-catchup-accepted');
  assert.equal(accepted.nextState.managerTerm, 2);
  assert.equal(accepted.actions.includes('clear-freeze'), true, '采纳更高 term 台账即解除 manager-offline');
  const unrequested = acceptManagerChange(state, frame, ctx);
  assert.equal(unrequested.accepted, false);
  assert.equal(unrequested.reason, 'source-not-member');
});

/* —— 握手目标面（设计 §2A.6②/§2A.7①）：名单成员靠 known-hosts 寻址、不泛扫 —— */

test('握手目标面：成员机无协作内端点、known-hosts 有名单成员端点 → 握手实际发出并计入', async (t) => {
  const { state, local, sent } = takeoverStateOf(t, { ledger: ledgerForTakeover(), endpoints: [] });
  state.knownHosts = { remember: () => {}, lookup: (instanceId) => (instanceId === RIVAL.instanceId ? RIVAL_ENDPOINT : null) };
  const challenge = await takeOver(state, { collabId: COLLAB, sessionId: MEM.sessionId });
  const handshakes = sent.filter((frame) => frame.type === 'notice' && frame.payload?.event === 'handshake');
  assert.deepEqual(handshakes.map((frame) => frame.to?.instanceId), [RIVAL.instanceId], '名单成员按 known-hosts 端点进入握手面');
  assert.equal(challenge.ok, true, challenge.message);
  assert.equal(challenge.needsUserConfirmation, true);
  assert.equal(local.role, 'member', '对表阶段不提升');
});

test('握手目标面：known-hosts 无记录 → 零应答按既有路径拒绝', async (t) => {
  const { state, local, sent } = takeoverStateOf(t, { ledger: ledgerForTakeover(), endpoints: [] });
  const verdict = await takeOver(state, { collabId: COLLAB, sessionId: MEM.sessionId });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.message.includes('零应答'), verdict.message);
  assert.equal(sent.some((frame) => frame.type === 'notice' && frame.payload?.event === 'handshake'), false, '无地址可解析时不发握手');
  assert.equal(local.role, 'member', '零应答不得以本机旧台账接管');
});

test('握手目标面：端点表与名单并集去重，名单外实例不被探测（防探测放大）', async (t) => {
  const outsiderEndpoint = { address: '127.0.0.4', port: 17321 };
  const { state, sent } = takeoverStateOf(t, {
    ledger: ledgerForTakeover(),
    endpoints: [[RIVAL.instanceId, RIVAL_ENDPOINT]],
  });
  state.knownHosts = {
    remember: () => {},
    lookup: (instanceId) => {
      if (instanceId === RIVAL.instanceId) {
        return RIVAL_ENDPOINT;
      }
      return instanceId === 'inst-outsider' ? outsiderEndpoint : null;
    },
  };
  const challenge = await takeOver(state, { collabId: COLLAB, sessionId: MEM.sessionId });
  const handshakes = sent.filter((frame) => frame.type === 'notice' && frame.payload?.event === 'handshake');
  assert.deepEqual(handshakes.map((frame) => frame.to?.instanceId), [RIVAL.instanceId], '同一实例只发一次；名单外 known-hosts 条目不发');
  assert.equal(challenge.ok, true, challenge.message);
});

test('握手目标面：端点表已知但不在名单的实例仍纳入握手，其应答不充当成员见证', async (t) => {
  const legacy = { instanceId: 'inst-old', sessionId: 'sess-old', identityName: '旧机' };
  const { state, sent } = takeoverStateOf(t, {
    ledger: ledgerForTakeover(),
    endpoints: [[legacy.instanceId, { address: '127.0.0.5', port: 17321 }]],
    replies: { [legacy.instanceId]: { seat: legacy, managerTerm: 1, version: 3, manager: MGR } },
  });
  const verdict = await takeOver(state, { collabId: COLLAB, sessionId: MEM.sessionId });
  const handshakes = sent.filter((frame) => frame.type === 'notice' && frame.payload?.event === 'handshake');
  assert.deepEqual(handshakes.map((frame) => frame.to?.instanceId), [legacy.instanceId], '端点表条目进入握手面（旧站长/历史端点回归面）');
  assert.equal(verdict.ok, false);
  assert.ok(verdict.message.includes('零应答'), '名单成员全无端点时，名单外机器的应答不作对表证据');
});

/* —— 接收侧受理（设计 §2A.2） —— */

function changeOf({ via = 'takeover', term, version, manager, prevManager = { instanceId: MGR.instanceId, sessionId: MGR.sessionId }, windowBaseTerm, authorizedAt }) {
  return {
    event: 'manager-changed',
    via,
    term,
    version,
    manager,
    prevManager,
    ...(windowBaseTerm === undefined ? {} : { windowBaseTerm }),
    ...(authorizedAt === undefined ? {} : { authorizedAt }),
    effectiveAt: iso(),
    endpoint: RIVAL_ENDPOINT,
    digest: 'a'.repeat(64),
    ...(via === 'handover' ? { offerId: 'offer-t' } : {}),
  };
}

test('A3 迟到事件：本地窗口已关但 authorizedAt 在窗口内 → 照常受理（授权与传播分离）', async (t) => {
  const windowEndsAt = iso(NOW - 30000);
  const harness = makeMemberHarness(t, { term: 2, version: 5, window: { windowBaseTerm: 2, windowEndsAt } });
  await receive(harness.service, frameOf('notice', RIVAL, changeOf({
    term: 3,
    version: 6,
    windowBaseTerm: 2,
    authorizedAt: iso(NOW - 35000),
    manager: { instanceId: RIVAL.instanceId, sessionId: RIVAL.sessionId, identityName: RIVAL.identityName },
  })));
  assert.equal(managerRefOnDisk(harness.dir).instanceId, RIVAL.instanceId, '窗口内授权的迟到变更照常受理');
  assert.equal(memberRecordOnDisk(harness.dir).managerSinceVersion, 6, '席位时钟记入受理版本');
});

test('A3 窗口关闭：authorizedAt 落在窗口外 → 拒收计数、不冻结', async (t) => {
  const windowEndsAt = iso(NOW - 30000);
  const harness = makeMemberHarness(t, { term: 2, version: 5, window: { windowBaseTerm: 2, windowEndsAt } });
  const before = harness.service.stats().termRejects ?? 0;
  await receive(harness.service, frameOf('notice', RIVAL, changeOf({
    term: 3,
    version: 6,
    windowBaseTerm: 2,
    authorizedAt: iso(NOW),
    manager: { instanceId: RIVAL.instanceId, sessionId: RIVAL.sessionId, identityName: RIVAL.identityName },
  })));
  assert.equal(managerRefOnDisk(harness.dir).instanceId, MGR.instanceId, '窗口外接管不采纳');
  assert.equal(harness.service.stats().termRejects ?? 0, before + 1);
  assert.equal(harness.service.list().collabs[0].state, 'active', '窗口关闭拒收不冻结');
});

test('A8 同 term 不同 manager → 冻结 manager-fork、停写并计数', async (t) => {
  const harness = makeMemberHarness(t, { term: 2, version: 5 });
  await receive(harness.service, frameOf('notice', MGR, {
    event: 'manager-changed',
    via: 'handover',
    term: 2,
    version: 6,
    offerId: 'offer-fork',
    prevManager: { instanceId: MGR.instanceId, sessionId: MGR.sessionId },
    manager: { instanceId: RIVAL.instanceId, sessionId: RIVAL.sessionId, identityName: RIVAL.identityName },
    effectiveAt: iso(),
    endpoint: RIVAL_ENDPOINT,
    digest: 'b'.repeat(64),
  }));
  assert.equal(harness.service.list().collabs[0].state, 'frozen', '同 term 冲突即冻结');
  assert.equal(harness.service.list().collabs[0].sessions.freezeReason, 'manager-fork', '冻结原因可读');
  const blocked = await harness.service.send({ collabId: COLLAB, text: '分叉期消息', sessionId: MEM.sessionId });
  assert.equal(blocked.ok, false, '冻结即停写');
  assert.equal(managerRefOnDisk(harness.dir).instanceId, MGR.instanceId, '不静默改现任');
});

test('快照回执：现任站长的更高版本快照 → 采纳并回 snapshot-stored（成功路径计数）', async (t) => {
  const harness = makeMemberHarness(t);
  const next = makeLedger({
    collabId: COLLAB,
    name: '交接协作',
    status: 'active',
    managerTerm: 1,
    version: 4,
    manager: MGR,
    members: membersOf(),
  });
  await receive(harness.service, frameOf('snapshot', MGR, {
    kind: 'data',
    managerTerm: 1,
    version: 4,
    digest: ledgerDigest(next),
    ledger: next,
  }));
  assert.equal(harness.service.stats().snapshotStored, 1, '快照落盘');
  assert.equal(harness.service.stats().snapshotReceipts, 1, '成功回执计数');
  const receipt = harness.sent.find((entry) => entry.type === 'notice' && entry.payload?.event === 'snapshot-stored');
  assert.ok(receipt, '向快照来源回执');
  assert.equal(receipt.to.instanceId, MGR.instanceId);
  assert.equal(receipt.payload.version, 4);
});

test('终态快照（manager:null）：现任站长签发 → 本地只读终态；非站长来源拒收', async (t) => {
  const harness = makeMemberHarness(t);
  const terminal = makeLedger({ collabId: COLLAB, name: '交接协作', status: 'completed', managerTerm: 1, version: 4 });
  const frame = frameOf('snapshot', MGR, {
    kind: 'data',
    managerTerm: 1,
    version: 4,
    digest: ledgerDigest(terminal),
    ledger: terminal,
  });
  await receive(harness.service, frame);
  assert.equal(harness.service.list().collabs[0].state, 'completed', '只读终态');
  assert.equal(harness.service.list().collabs[0].role, 'member');
  const view = await harness.service.view({ collabId: COLLAB });
  assert.equal(view.ledger.status, 'completed', '本地只读台账为终态');
  assert.equal(view.ledger.manager, null, '终态 manager 必须为 null');
  const blocked = await harness.service.send({ collabId: COLLAB, text: '终态后消息', type: 'issue', sessionId: MEM.sessionId });
  assert.equal(blocked.ok, false, '终态停写');

  const other = makeMemberHarness(t);
  const rogue = frameOf('snapshot', RIVAL, {
    kind: 'data',
    managerTerm: 1,
    version: 4,
    digest: ledgerDigest(terminal),
    ledger: terminal,
  });
  await receive(other.service, rogue);
  assert.equal(other.service.list().collabs[0].state, 'active', '任意成员的同 term 终态快照拒收');
  assert.equal(other.service.stats().termRejects >= 1, true);
});

/* —— presence 超时（设计 §2A.9） —— */

test('presence 超时：远端席位连续未见 → 站长核移除名单行、departed 留痕并发名单通告', async (t) => {
  const harness = makeManagerHarness(t, {
    config: { sessionSeatTimeoutMs: 50, seatPresenceIntervalMs: 10 },
  });
  harness.service.start();
  await receive(harness.service, frameOf('notice', MEM, handshakePayloadOf({ reply: true }), { remoteAddress: MEM_ENDPOINT.address }), MEM_ENDPOINT.address, MEM.instanceId);
  await receive(harness.service, frameOf('seat-presence', MEM, {
    collabId: COLLAB,
    instanceId: MEM.instanceId,
    sessions: [MEM.sessionId],
    sentAt: iso(),
  }, { remoteAddress: MEM_ENDPOINT.address }), MEM_ENDPOINT.address, MEM.instanceId);
  const before = (await harness.service.view({ collabId: COLLAB })).ledger;
  const beforeVersion = before.version;
  assert.equal(before.members.some((entry) => entry.sessionId === MEM.sessionId), true, '心跳在册');
  await waitFor(async () => {
    const view = await harness.service.view({ collabId: COLLAB });
    return view.ledger.members.some((entry) => entry.sessionId === MEM.sessionId) ? null : true;
  }, { timeoutMs: 3000 });
  assert.equal(harness.service.stats().seatsExpired >= 1, true, '判离席计数');
  const departed = readFileSync(join(harness.dir, 'collabs', COLLAB, 'departed.jsonl'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(departed.some((entry) => entry.sessionId === MEM.sessionId && entry.reason === 'session-timeout'), true, '离席留痕');
  const after = (await harness.service.view({ collabId: COLLAB })).ledger;
  assert.equal(after.version, beforeVersion + 1, '名单移除推进台账版本');
  assert.equal(after.members.some((entry) => entry.instanceId === RIVAL.instanceId), true, '未超时的 RIVAL 未被误删');
  const rosters = harness.sent.filter((frame) => frame.type === 'notice' && frame.payload?.event === 'roster');
  assert.equal(rosters.length >= 1, true, '名单移除后向其余成员广播 roster 通告');
  assert.equal(rosters.every((frame) => frame.payload.version === after.version), true, '通告携带当前台账版本');
  assert.equal(rosters.some((frame) => frame.to?.instanceId === RIVAL.instanceId), true, '其余在册成员收到通告');
});
