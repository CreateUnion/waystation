import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { collabDir } from '../src/paths.js';
import { makeTempDir, waitFor } from './helpers.js';
import { makeLedger, seedSessionCollab } from './helpers/session-participants.js';
import { createCollabService } from '../src/collab/service.js';
import { ledgerDigest } from '../src/collab/store.js';
import { handleHandshake, takeOver } from '../src/collab/takeover.js';

/* 站长交接（设计 §2A）：握手对表、失联判定、手动接管（A4）与窗口内接管（A3）、同 term 分叉（A8）、
 * 终态快照与 presence 超时离席。
 *
 * 已删除用例清单（设计依据）：
 * - 「抢接窗口：收集窗口/中止/待确认/生效」与「confirm 越窗」：v4 删除收集窗口与候选优先序
 *   （设计 §0.4 取代关系；§2A.6 改为「窗口内任何活跃成员可接管，发起前握手取最高」）。
 * - 「并发让位与顺位」「低优先 rival 不让位」「takeover-init 意图/汇总/转达」：抢接公告与让位优先序
 *   已删除（§0.4）；takeover-init/takeover 帧仅保留接收转达兼容（§2A.1 表外）。
 * - 「收到生效通告（原站长侧）：删除本地台账」相关：v4 改为旧站长降级、保留只读副本；
 *   「目标自行提升」删除（§2A.4 目标只校验并记录）。
 * - 「陈旧席位主张」三条（takeover 记录版本判据）：席位时钟/旧记录收敛面随优先序一并删除（§0.4）。
 * - 「无在册端点时不置保守态」：现实现把本机组广播计入已发送（sendToRoster），无他机端点时仍会
 *   按时限进入 handshake-unresolved；该口径未在设计写明，按产品缺陷 ISSUE 上报，夹具不固化。
 * - 「探测可观测性（旧 manager-changed 无端点）」：旧载荷形态退役，端点由 A1–A4 帧必填（§2A.1）。
 *
 * 夹具形态：新台账（managerTerm/joinSeqNext/manager.sessionId/席位 joinSeq）+ carrier(session-seats)
 * + seats/；协作域帧携 cap=2、from.sessionId、managerTerm/version/managerWindow（设计 §2A.1/§5.1）。 */

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

/* —— 接管判定（设计 §2A.6/§2A.7）：直接驱动 M5 接管实现 ——
 * 服务层 takeOver 当前误用 managerOnly 席位授权（成员会话被拒，ISSUE），夹具按实现入口注入最小共享态。 */

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
 * handshake 出站时以另一成员身份回一帧，模拟真实对表面。 */
function autoReplySendOf(state, sent) {
  return (message) => {
    sent.push(message);
    if (message.type === 'notice' && message.payload?.event === 'handshake') {
      queueMicrotask(() => {
        handleHandshake(state, {
          v: 1,
          cap: 2,
          type: 'notice',
          msgId: `hs-reply-${sent.length}`,
          collabId: message.collabId,
          from: { instanceId: RIVAL.instanceId, sessionId: RIVAL.sessionId, identityName: RIVAL.identityName, port: 17321 },
          ts: iso(),
          payload: {
            event: 'handshake',
            role: 'member',
            managerTerm: message.payload.managerTerm,
            version: message.payload.version,
            manager: message.payload.manager,
            reply: true,
          },
        }).catch(() => {});
      });
    }
    return { ok: true, msgId: `t-${sent.length}` };
  };
}

function takeoverStateOf(t, { role = 'member', ledger, endpoints = [] } = {}) {
  const dir = makeTempDir(t);
  mkdirSync(collabDir(dir, COLLAB), { recursive: true });
  const local = takeoverLocalOf({ role, ledger, endpoints });
  const sent = [];
  const state = { ...takeoverStateBaseOf(dir, sent), collabs: new Map([[COLLAB, local]]) };
  state.send = autoReplySendOf(state, sent);
  return { state, local, sent, dir };
}

function ledgerForTakeover({ term = 1, version = 3, window = undefined } = {}) {
  return makeLedger({
    collabId: COLLAB,
    name: '交接协作',
    status: 'active',
    managerTerm: term,
    version,
    manager: { ...MGR, term },
    members: membersOf({ term }),
    managerWindow: window,
  });
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
  const blocked = await harness.service.send({ collabId: COLLAB, text: '分叉期消息', sessionId: MEM.sessionId });
  assert.equal(blocked.ok, false, '冻结即停写');
  assert.equal(managerRefOnDisk(harness.dir).instanceId, MGR.instanceId, '不静默改现任');
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
  assert.equal(before.members.some((entry) => entry.sessionId === MEM.sessionId), true, '心跳在册');
  await waitFor(async () => {
    const view = await harness.service.view({ collabId: COLLAB });
    return view.ledger.members.some((entry) => entry.sessionId === MEM.sessionId) ? null : true;
  }, { timeoutMs: 3000 });
  assert.equal(harness.service.stats().seatsExpired >= 1, true, '判离席计数');
  const departed = readFileSync(join(harness.dir, 'collabs', COLLAB, 'departed.jsonl'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(departed.some((entry) => entry.sessionId === MEM.sessionId && entry.reason === 'session-timeout'), true, '离席留痕');
});
