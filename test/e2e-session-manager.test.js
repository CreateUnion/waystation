import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { ledgerDigest } from '../src/collab/store.js';
import {
  autoOfferFilePath,
  carrierFilePath,
  collabFilePath,
  departedFilePath,
  handoverOffersFilePath,
  handoverPendingFilePath,
  managerPendingFilePath,
} from '../src/paths.js';
import {
  bringSessionOffline,
  bringSessionOnline,
  closeSessionNode,
  endpointOf,
  feedSessionFrame,
  injectionsOf,
  linkSessionNodes,
  makeFakeClock,
  makeTempRoot,
  seedSessionCollab,
  startSessionNode,
} from './helpers/session-participants.js';
import { waitFor, waitForRebindable } from './helpers.js';

/* 站长交接的真实链路：auto-offer + 新站长签发（成员侧开窗）、同 term 分叉冻结与成员本地裁定、
 * 站长会话关闭的自动移交、整机离线后的手动接管（含可达 peer 对表）、显式移交两段式、
 * 1 分钟窗口接管/过期、并发接管、迟到 accept 拒绝与核重启恢复。
 * 长操作声明：冻结用例按缩小后的失联时限（300ms）等待，自动移交按 400ms 宽限等待；
 * 单用例超时上限 60s，禁止无界等待。 */

const TIMEOUT_MS = 60000;
const COLLAB_ID = 'collab-manager';
const MANAGER = { instanceId: 'inst-mgr', sessionId: 'seat-manager', identityName: '甲机' };
const MEMBER = { instanceId: 'inst-mem', sessionId: 'seat-member', identityName: '乙机' };
const OBSERVER = { instanceId: 'inst-obs', sessionId: 'seat-observer', identityName: '丁机' };
const RIVAL = { instanceId: 'inst-rival', sessionId: 'seat-rival', identityName: '丙机' };
const PEER = { instanceId: 'inst-peer', sessionId: 'seat-peer', identityName: '戊机' };

const BASE_MEMBERS = [
  { instanceId: MANAGER.instanceId, sessionId: MANAGER.sessionId, identityName: MANAGER.identityName, role: 'manager', joinSeq: 1 },
  { instanceId: MEMBER.instanceId, sessionId: MEMBER.sessionId, identityName: MEMBER.identityName, role: 'member', joinSeq: 2 },
];

/* 统一节点种子：newForm 新形态（carrier ＋台账 ＋快照 ＋席位），member=true 时写成员记录
 * （member.endpoints 是本机端点表的持久化来源——握手/回执寻址不靠夹具手填）。 */
function seedNode({ seats, members = BASE_MEMBERS, manager = MANAGER, term = 1, version = 3, window, endpoints = {}, memberEndpoints = {}, member = false }) {
  return (home) => seedSessionCollab(home, COLLAB_ID, {
    name: '交接协作',
    managerTerm: term,
    version,
    manager,
    members,
    managerWindow: window,
    endpoints,
    snapshotFrom: manager.instanceId,
    seats,
    ...(member
      ? {
        member: {
          collabId: COLLAB_ID,
          name: '交接协作',
          topic: '交接协作 主题',
          role: 'member',
          state: 'active',
          manager: { instanceId: manager.instanceId, sessionId: manager.sessionId, identityName: manager.identityName },
          endpoints: memberEndpoints,
          roster: members,
          mode: 'managed',
          decision: 'approved',
        },
      }
      : {}),
  });
}

function noticeFrame(payload, from) {
  return {
    v: 1,
    cap: 2,
    type: 'notice',
    msgId: randomUUID(),
    collabId: COLLAB_ID,
    from: { ...from, port: 24000 },
    ts: new Date().toISOString(),
    payload,
  };
}

function handoverFrame(payload, from) {
  return {
    v: 1,
    cap: 2,
    type: 'handover',
    msgId: randomUUID(),
    collabId: COLLAB_ID,
    from: { ...from, port: 24000 },
    ts: new Date().toISOString(),
    payload,
  };
}

function autoOfferPayload(offerId) {
  return {
    event: 'auto-offer',
    offerId,
    prevManager: { instanceId: MANAGER.instanceId, sessionId: MANAGER.sessionId },
    target: { instanceId: MEMBER.instanceId, sessionId: MEMBER.sessionId },
    baseTerm: 1,
    version: 3,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
}

function autoChangedLedger(base, windowEndsAt) {
  const next = structuredClone(base);
  next.managerTerm = 2;
  next.version = base.version + 1;
  next.members = next.members
    .filter((seat) => !(seat.role === 'manager' && seat.instanceId === MANAGER.instanceId && seat.sessionId === MANAGER.sessionId))
    .map((seat) => (seat.instanceId === MEMBER.instanceId && seat.sessionId === MEMBER.sessionId ? { ...seat, role: 'manager' } : seat));
  next.manager = { instanceId: MEMBER.instanceId, sessionId: MEMBER.sessionId, identityName: MEMBER.identityName, term: 2 };
  next.managerWindow = { windowBaseTerm: 2, windowEndsAt };
  return next;
}

function autoChangePayload(baseLedger, offerId, windowEndsAt, endpoint = { address: '127.0.0.1', port: 24001 }) {
  return {
    event: 'manager-changed',
    via: 'auto',
    offerId,
    term: 2,
    version: baseLedger.version + 1,
    prevManager: { instanceId: MANAGER.instanceId, sessionId: MANAGER.sessionId },
    manager: { instanceId: MEMBER.instanceId, sessionId: MEMBER.sessionId, identityName: MEMBER.identityName },
    effectiveAt: new Date().toISOString(),
    windowEndsAt,
    endpoint,
    digest: ledgerDigest(autoChangedLedger(baseLedger, windowEndsAt)),
  };
}

async function viewOf(node) {
  return (await node.service.view({ collabId: COLLAB_ID })).ledger ?? null;
}

/* 甲机站长 + 乙机成员：真实回环链路、双方服务已启动（presence/宽限/失联计时生效）。 */
async function startLinkedPair(t, { config = {}, managerSeed, memberSeed, managerHome, memberHome }) {
  const manager = await startSessionNode(t, {
    ...(managerHome === undefined ? {} : { home: managerHome }),
    instanceId: MANAGER.instanceId,
    identityName: MANAGER.identityName,
    seed: managerSeed,
    online: [MANAGER.sessionId],
    config,
  });
  const member = await startSessionNode(t, {
    ...(memberHome === undefined ? {} : { home: memberHome }),
    instanceId: MEMBER.instanceId,
    identityName: MEMBER.identityName,
    seed: memberSeed,
    online: [MEMBER.sessionId],
    config,
  });
  linkSessionNodes(manager, member);
  manager.service.start();
  member.service.start();
  await bringSessionOnline(manager, MANAGER.sessionId);
  await bringSessionOnline(member, MEMBER.sessionId);
  return { manager, member };
}

/* 当前站长（MEMBER 机）＋挑战者（RIVAL 机），台账带 managerWindow：窗口接管与过期的公共夹具。 */
async function startWindowPair(t, windowEndsAt) {
  const window = { windowBaseTerm: 2, windowEndsAt };
  const members = [
    { instanceId: MEMBER.instanceId, sessionId: MEMBER.sessionId, identityName: MEMBER.identityName, role: 'manager', joinSeq: 2 },
    { instanceId: RIVAL.instanceId, sessionId: RIVAL.sessionId, identityName: RIVAL.identityName, role: 'member', joinSeq: 3 },
  ];
  const manager = await startSessionNode(t, {
    instanceId: MEMBER.instanceId,
    identityName: MEMBER.identityName,
    seed: seedNode({ term: 2, version: 11, window, manager: MEMBER, members, seats: [{ sessionId: MEMBER.sessionId, role: 'manager', joinSeq: 2 }] }),
    online: [MEMBER.sessionId],
  });
  const challenger = await startSessionNode(t, {
    instanceId: RIVAL.instanceId,
    identityName: RIVAL.identityName,
    seed: seedNode({
      term: 2,
      version: 11,
      window,
      manager: MEMBER,
      members,
      seats: [{ sessionId: RIVAL.sessionId, role: 'member', joinSeq: 3 }],
      member: true,
      memberEndpoints: { [MEMBER.instanceId]: endpointOf(manager) },
    }),
    online: [RIVAL.sessionId],
  });
  linkSessionNodes(manager, challenger);
  await bringSessionOnline(manager, MEMBER.sessionId);
  await bringSessionOnline(challenger, RIVAL.sessionId);
  return { manager, challenger };
}

/* 冻结原因落载体（供观察窗只读展示）：运行态不暴露独立字段，按落盘事实断言。 */
function freezeReasonOf(node) {
  try {
    return JSON.parse(readFileSync(carrierFilePath(node.home, COLLAB_ID), 'utf8')).freezeReason ?? null;
  } catch {
    return null;
  }
}

function readJsonOrNull(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

test('新站长签发 via=auto：成员侧受理、开窗并按新台账收敛（A2）', { timeout: TIMEOUT_MS }, async (t) => {
  const windowEndsAt = new Date(Date.now() + 60000).toISOString();
  const nextMembers = [
    { instanceId: MEMBER.instanceId, sessionId: MEMBER.sessionId, identityName: MEMBER.identityName, role: 'manager', joinSeq: 2 },
    { instanceId: OBSERVER.instanceId, sessionId: OBSERVER.sessionId, identityName: OBSERVER.identityName, role: 'member', joinSeq: 3 },
  ];
  const nextManager = await startSessionNode(t, {
    instanceId: MEMBER.instanceId,
    identityName: MEMBER.identityName,
    seed: seedNode({ term: 2, version: 4, window: { windowBaseTerm: 2, windowEndsAt }, manager: MEMBER, members: nextMembers, seats: [{ sessionId: MEMBER.sessionId, role: 'manager', joinSeq: 2 }] }),
    online: [MEMBER.sessionId],
  });
  const observer = await startSessionNode(t, {
    instanceId: OBSERVER.instanceId,
    identityName: OBSERVER.identityName,
    seed: seedNode({
      seats: [{ sessionId: OBSERVER.sessionId, role: 'member', joinSeq: 3 }],
      members: [...BASE_MEMBERS, { instanceId: OBSERVER.instanceId, sessionId: OBSERVER.sessionId, identityName: OBSERVER.identityName, role: 'member', joinSeq: 3 }],
      member: true,
      memberEndpoints: { [MEMBER.instanceId]: endpointOf(nextManager) },
    }),
    online: [OBSERVER.sessionId],
  });
  await bringSessionOnline(nextManager, MEMBER.sessionId);
  await bringSessionOnline(observer, OBSERVER.sessionId);
  const before = await viewOf(observer);
  const offerId = 'offer-auto-1';
  await feedSessionFrame(observer, noticeFrame(autoOfferPayload(offerId), MANAGER));
  await waitFor(() => observer.service.stats().autoOffersIn === 1 ? true : null, { timeoutMs: 3000 });
  await feedSessionFrame(observer, noticeFrame(autoChangePayload(before, offerId, windowEndsAt, endpointOf(nextManager)), MEMBER));
  const ledger = await waitFor(() => observer.service.view({ collabId: COLLAB_ID }).then((view) => {
    const current = view.ledger;
    return current?.managerTerm === 2 && current.manager?.sessionId === MEMBER.sessionId ? current : null;
  }), { timeoutMs: 8000 });

  assert.equal(ledger.manager.term, 2);
  assert.deepEqual(ledger.managerWindow, { windowBaseTerm: 2, windowEndsAt }, 'auto 变更开启 1 分钟窗口');
  assert.equal(ledger.members.some((seat) => seat.sessionId === MANAGER.sessionId), false, 'auto 最终台账移除旧站长席位');
  assert.equal(ledger.members.find((seat) => seat.sessionId === MEMBER.sessionId).role, 'manager');
});

test('T2a：无本地 auto-offer 记录的自签 auto 变更拒收，不改 manager', { timeout: TIMEOUT_MS }, async (t) => {
  const observer = await startSessionNode(t, {
    instanceId: OBSERVER.instanceId,
    identityName: OBSERVER.identityName,
    seed: seedNode({
      seats: [{ sessionId: OBSERVER.sessionId, role: 'member', joinSeq: 3 }],
      members: [...BASE_MEMBERS, { instanceId: OBSERVER.instanceId, sessionId: OBSERVER.sessionId, identityName: OBSERVER.identityName, role: 'member', joinSeq: 3 }],
      member: true,
    }),
    online: [OBSERVER.sessionId],
  });
  await bringSessionOnline(observer, OBSERVER.sessionId);
  const before = await viewOf(observer);
  /* 自签：来源必须是帧里声称的新站长（这里＝成员自己），否则先撞 A5 来源校验而非 A2 的 offer 证据判定。 */
  const forged = {
    ...autoChangePayload(before, 'offer-never-seen', new Date(Date.now() + 60000).toISOString()),
    manager: { instanceId: MEMBER.instanceId, sessionId: MEMBER.sessionId, identityName: MEMBER.identityName },
  };
  await feedSessionFrame(observer, noticeFrame(forged, { instanceId: MEMBER.instanceId, sessionId: MEMBER.sessionId, identityName: MEMBER.identityName }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  const after = await viewOf(observer);
  assert.equal(after.managerTerm, before.managerTerm, '任期不得推进');
  assert.equal(after.manager.sessionId, MANAGER.sessionId, 'manager 不得被自签帧改写');
  assert.ok((observer.service.stats().termRejects ?? 0) >= 1, '拒收并计数');
});

test('T2b：已收到 accept 未收到签发帧 → frozen(manager-pending)，不换目标不恢复写', { timeout: TIMEOUT_MS }, async (t) => {
  const manager = await startSessionNode(t, {
    instanceId: MANAGER.instanceId,
    identityName: MANAGER.identityName,
    seed: seedNode({
      seats: [{ sessionId: MANAGER.sessionId, role: 'manager', joinSeq: 1 }],
      endpoints: { [MEMBER.instanceId]: { address: '127.0.0.1', port: 24600 } },
    }),
    online: [MANAGER.sessionId],
    config: { handoverConfirmTimeoutMs: 1500 },
  });
  await bringSessionOnline(manager, MANAGER.sessionId);
  const offered = await manager.service.autoTransfer({ collabId: COLLAB_ID, managerSessionId: MANAGER.sessionId });
  assert.equal(offered.ok, true, String(offered.message ?? offered.reason));
  const persisted = await waitFor(() => readJsonOrNull(autoOfferFilePath(manager.home, COLLAB_ID)), { timeoutMs: 3000 });
  assert.equal(persisted.offerId, offered.offerId, 'run/auto-offer.json 落盘');

  const ledger = await viewOf(manager);
  const accept = handoverFrame({
    kind: 'accept',
    offerId: offered.offerId,
    baseTerm: 1,
    version: ledger.version,
    digest: ledgerDigest(ledger),
    confirm: true,
  }, MEMBER);
  await feedSessionFrame(manager, accept);
  await waitFor(() => freezeReasonOf(manager) === 'manager-pending' ? true : null, { timeoutMs: 3000 });
  assert.equal(existsSync(managerPendingFilePath(manager.home, COLLAB_ID)), true, 'manager-pending 标记落盘');
  await new Promise((resolve) => setTimeout(resolve, 1800));
  assert.equal(freezeReasonOf(manager), 'manager-pending', '超时后仍停在 manager-pending');
  const after = await viewOf(manager);
  assert.equal(after.managerTerm, 1, '不得自行产生第二个 term+1');
  assert.equal(after.manager.sessionId, MANAGER.sessionId);
  assert.equal(manager.sentFrames.some((frame) => frame.payload?.event === 'manager-changed'), false, '未收到签发帧时不得宣告变更');
});

test('同 term 分叉：冻结 manager-fork，成员席本地裁定 terminate 只归档本方', { timeout: TIMEOUT_MS }, async (t) => {
  const member = await startSessionNode(t, {
    instanceId: MEMBER.instanceId,
    identityName: MEMBER.identityName,
    seed: seedNode({ term: 2, version: 5, seats: [{ sessionId: MEMBER.sessionId, role: 'member', joinSeq: 2 }], member: true }),
    online: [MEMBER.sessionId],
  });
  await bringSessionOnline(member, MEMBER.sessionId);
  await feedSessionFrame(member, noticeFrame({
    event: 'manager-changed',
    via: 'handover',
    offerId: 'offer-rival',
    term: 2,
    version: 6,
    prevManager: { instanceId: MANAGER.instanceId, sessionId: MANAGER.sessionId },
    manager: { instanceId: RIVAL.instanceId, sessionId: RIVAL.sessionId, identityName: RIVAL.identityName },
    effectiveAt: new Date().toISOString(),
    endpoint: { address: '127.0.0.1', port: 24002 },
    digest: 'b'.repeat(64),
  }, RIVAL));
  await waitFor(() => freezeReasonOf(member) === 'manager-fork' ? true : null, { timeoutMs: 3000 });
  const decided = await member.service.decide({ collabId: COLLAB_ID, choice: 'terminate', sessionId: MEMBER.sessionId });
  assert.equal(decided.ok, true, String(decided.message));
  const ledger = await viewOf(member);
  assert.equal(ledger.status, 'terminated', '终止后本方只读归档');
  assert.equal(member.sentFrames.some((frame) => frame.type === 'decision'), false, '本地归档不广播合并');
});

test('T12：显式移交迟到 accept 拒绝并回 reject(expired)，台账不变', { timeout: TIMEOUT_MS }, async (t) => {
  /* 假时钟把「已过期」做成确定性判据：真实定时器在 60s 后才触发，不会抢先清掉在途记录。 */
  const clock = makeFakeClock(Date.now());
  const manager = await startSessionNode(t, {
    instanceId: MANAGER.instanceId,
    identityName: MANAGER.identityName,
    now: () => clock.now(),
    seed: seedNode({
      seats: [{ sessionId: MANAGER.sessionId, role: 'manager', joinSeq: 1 }],
      endpoints: { [MEMBER.instanceId]: { address: '127.0.0.1', port: 24601 } },
    }),
    online: [MANAGER.sessionId],
    config: { handoverConfirmTimeoutMs: 60000 },
  });
  await bringSessionOnline(manager, MANAGER.sessionId);
  const offered = await manager.service.handover({ collabId: COLLAB_ID, target: MEMBER.instanceId, targetSessionId: MEMBER.sessionId, sessionId: MANAGER.sessionId });
  assert.equal(offered.ok, true, String(offered.message));
  const pendingFile = handoverPendingFilePath(manager.home, COLLAB_ID);
  assert.equal(readJsonOrNull(pendingFile)?.offerId, offered.offerId, '显式移交在途记录落盘');
  clock.advance(61000);
  const ledger = await viewOf(manager);
  await feedSessionFrame(manager, handoverFrame({
    kind: 'accept',
    offerId: offered.offerId,
    baseTerm: 1,
    version: ledger.version,
    digest: ledgerDigest(ledger),
    confirm: true,
  }, MEMBER));
  await waitFor(() => manager.sentFrames.some((frame) => frame.type === 'handover' && frame.payload?.kind === 'reject') ? true : null, { timeoutMs: 3000 });
  const reject = manager.sentFrames.find((frame) => frame.type === 'handover' && frame.payload?.kind === 'reject');
  assert.equal(reject.payload.reason, 'expired', '迟到 accept 按 expired 拒绝');
  assert.equal(reject.from?.sessionId ?? reject.fromSessionId, MANAGER.sessionId, 'reject 由旧站长席位签发');
  const after = await viewOf(manager);
  assert.equal(after.managerTerm, 1, 'term 不变');
  assert.equal(after.manager.sessionId, MANAGER.sessionId, 'manager 不变');
  assert.equal(existsSync(pendingFile), false, '过期后在途记录清除');
});

test('站长会话关闭：宽限后自动移交，新站长签发 via=auto 并开窗，旧站长降级', { timeout: TIMEOUT_MS }, async (t) => {
  const { manager, member } = await startLinkedPair(t, {
    config: { sessionSeatGraceMs: 400, seatPresenceIntervalMs: 100, managerProbeIntervalMs: 100, managerLossTimeoutMs: 30000, handoverConfirmTimeoutMs: 5000 },
    managerSeed: seedNode({ seats: [{ sessionId: MANAGER.sessionId, role: 'manager', joinSeq: 1 }] }),
    memberSeed: seedNode({ seats: [{ sessionId: MEMBER.sessionId, role: 'member', joinSeq: 2 }], member: true }),
  });
  await bringSessionOffline(manager, MANAGER.sessionId);

  const change = await waitFor(() => member.sentFrames.find((frame) => frame.type === 'notice'
    && frame.payload?.event === 'manager-changed' && frame.payload?.via === 'auto') ?? null, { timeoutMs: 12000 });
  assertAutoChange(change);

  const ledger = await waitFor(() => member.service.view({ collabId: COLLAB_ID }).then((view) => {
    const current = view.ledger;
    return current?.managerTerm === 2 && current.manager?.sessionId === MEMBER.sessionId ? current : null;
  }), { timeoutMs: 12000 });
  assertAutoLedger(ledger);
  await assertAutoPersistence(manager, member, change.payload.offerId);
});

function assertAutoChange(change) {
  assert.equal(change.payload.prevManager.sessionId, MANAGER.sessionId, 'prevManager 是原站长席位');
  assert.equal(change.payload.manager.sessionId, MEMBER.sessionId, '新站长以自己名义签发');
  assert.equal(change.from?.sessionId ?? change.fromSessionId, MEMBER.sessionId, '签发帧 from = 新站长席位');
  assert.match(String(change.payload.offerId), /[0-9a-f-]{8}/, 'auto 变更携 offerId');
  assert.equal(change.payload.term, 2);
  assert.equal(change.payload.windowEndsAt !== undefined, true, 'auto 变更携 windowEndsAt');
}

function assertAutoLedger(ledger) {
  assert.equal(ledger.manager.instanceId, MEMBER.instanceId);
  assert.equal(ledger.manager.term, 2);
  assert.equal(ledger.managerWindow.windowBaseTerm, 2, '新站长台账开启窗口');
  assert.ok(Date.parse(ledger.managerWindow.windowEndsAt) > Date.now(), '窗口尚未到期');
  assert.equal(ledger.members.some((seat) => seat.role === 'manager' && seat.sessionId === MANAGER.sessionId), false, '旧站长席位移除');
}

async function assertAutoPersistence(manager, member, offerId) {
  const offerRecord = await waitFor(() => readJsonOrNull(handoverOffersFilePath(member.home, COLLAB_ID)), { timeoutMs: 5000 });
  assert.ok(offerRecord.offers.some((offer) => offer.offerId === offerId), '目标侧 offer 记录落盘');
  const autoRecord = readJsonOrNull(autoOfferFilePath(manager.home, COLLAB_ID));
  assert.equal(autoRecord?.offerId, offerId, '原站长核 auto-offer 副本落盘（重启恢复面）');
  await waitFor(() => manager.service.stats().managerDowngrades === 1 ? true : null, { timeoutMs: 8000 });
  assert.equal(manager.service.localSeatOf(COLLAB_ID, MANAGER.sessionId), null, '旧站长席位已移除');
  const oldMember = readJsonOrNull(collabFilePath(manager.home, COLLAB_ID, 'member.json'));
  assert.equal(oldMember.manager.instanceId, MEMBER.instanceId, '旧站长按新任期收敛');
}

test('整机离线：成员冻结 manager-offline，经可达 peer 对表后手动接管成功', { timeout: TIMEOUT_MS }, async (t) => {
  const { peer, member } = await startCandidateWithPeer(t);
  await waitFor(() => freezeReasonOf(member) === 'manager-offline' ? true : null, { timeoutMs: 5000 });
  const first = await member.service.takeOver({ collabId: COLLAB_ID, sessionId: MEMBER.sessionId });
  assert.equal(first.needsUserConfirmation, true, String(first.message));
  assert.ok(member.sentFrames.some((frame) => frame.type === 'notice' && frame.payload?.event === 'handshake'), '接管前先向可达成员握手');
  assert.ok(peer.sentFrames.some((frame) => frame.type === 'notice' && frame.payload?.event === 'handshake' && frame.payload?.reply === true), 'peer 应答握手');

  const confirmed = await member.service.takeOver({ collabId: COLLAB_ID, sessionId: MEMBER.sessionId, token: first.token });
  assert.equal(confirmed.ok, true, String(confirmed.message));
  assertManualTakeover(await viewOf(member), member.sentFrames);
  await waitFor(() => peer.service.view({ collabId: COLLAB_ID }).then((view) => view.ledger?.manager?.sessionId === MEMBER.sessionId ? true : null), { timeoutMs: 8000 });
  await waitFor(() => freezeReasonOf(member) === null ? true : null, { timeoutMs: 3000 });
});

async function startCandidateWithPeer(t) {
  const config = { seatPresenceIntervalMs: 100, managerProbeIntervalMs: 100, managerLossTimeoutMs: 300, sessionSeatTimeoutMs: 30000 };
  const members = [...BASE_MEMBERS, { instanceId: PEER.instanceId, sessionId: PEER.sessionId, identityName: PEER.identityName, role: 'member', joinSeq: 3 }];
  const peer = await startSessionNode(t, {
    instanceId: PEER.instanceId,
    identityName: PEER.identityName,
    seed: seedNode({ members, seats: [{ sessionId: PEER.sessionId, role: 'member', joinSeq: 3 }], member: true }),
    online: [PEER.sessionId],
    config,
  });
  const member = await startSessionNode(t, {
    instanceId: MEMBER.instanceId,
    identityName: MEMBER.identityName,
    seed: seedNode({
      members,
      seats: [{ sessionId: MEMBER.sessionId, role: 'member', joinSeq: 2 }],
      member: true,
      memberEndpoints: { [PEER.instanceId]: endpointOf(peer) },
    }),
    online: [MEMBER.sessionId],
    config,
  });
  linkSessionNodes(member, peer);
  await bringSessionOnline(peer, PEER.sessionId);
  await bringSessionOnline(member, MEMBER.sessionId);
  peer.service.start();
  member.service.start();
  return { peer, member };
}

function assertManualTakeover(ledger, sentFrames) {
  assert.equal(ledger.managerTerm, 2, '接管推进任期');
  assert.equal(ledger.manager.sessionId, MEMBER.sessionId, '接管方成为新站长');
  assert.equal(ledger.managerWindow, undefined, '手动接管不开窗');
  assert.equal(ledger.members.some((seat) => seat.instanceId === MANAGER.instanceId), false, '失联站长席位移除');
  const change = sentFrames.find((frame) => frame.type === 'notice' && frame.payload?.event === 'manager-changed');
  assert.equal(change.payload.via, 'takeover-manual');
  assert.equal(change.payload.prevManager.sessionId, MANAGER.sessionId);
  assert.equal(typeof change.payload.authorizedAt, 'string', '手动接管必携 authorizedAt');
  assert.equal(change.payload.windowEndsAt, undefined, '手动接管无窗口');
}

test('显式移交：目标确认令牌两段式，旧站长降级、不开窗', { timeout: TIMEOUT_MS }, async (t) => {
  const config = { handoverConfirmTimeoutMs: 5000 };
  const managerSeed = seedNode({ seats: [{ sessionId: MANAGER.sessionId, role: 'manager', joinSeq: 1 }] });
  const { manager, member } = await startLinkedPair(t, {
    config,
    managerSeed,
    memberSeed: seedNode({ seats: [{ sessionId: MEMBER.sessionId, role: 'member', joinSeq: 2 }], member: true }),
  });

  const offered = await manager.service.handover({ collabId: COLLAB_ID, target: MEMBER.instanceId, targetSessionId: MEMBER.sessionId, sessionId: MANAGER.sessionId });
  assert.equal(offered.ok, true, String(offered.message));
  assert.equal(readJsonOrNull(handoverPendingFilePath(manager.home, COLLAB_ID))?.offerId, offered.offerId, '等待期停写记录落盘');
  await waitFor(() => injectionsOf(member, MEMBER.sessionId).some((entry) => entry.type === 'handover' && entry.payload?.kind === 'offer') ? true : null, { timeoutMs: 8000 });
  const offeredFrame = injectionsOf(member, MEMBER.sessionId).find((entry) => entry.type === 'handover' && entry.payload?.kind === 'offer');
  assert.equal(offeredFrame.frame.from.sessionId, MANAGER.sessionId, 'offer 由旧站长席位签发');
  assert.equal(offeredFrame.payload.offerId, offered.offerId);
  assert.equal(offeredFrame.payload.digest.length, 64, 'offer 携真实 digest');

  assert.equal(member.service.localSeatOf(COLLAB_ID, MEMBER.sessionId).role, 'member', '目标收到 offer 不自行提升');
  assert.equal((await viewOf(member)).manager.sessionId, MANAGER.sessionId);
  await confirmHandoverWithToken(member, offered.offerId);
  await assertHandoverCompleted(manager, member, offered.offerId);
});

async function confirmHandoverWithToken(member, offerId) {
  const challenge = await member.service.confirmHandover({ collabId: COLLAB_ID, sessionId: MEMBER.sessionId, offerId });
  assert.equal(challenge.needsUserConfirmation, true, String(challenge.message));
  const accepted = await member.service.confirmHandover({ collabId: COLLAB_ID, sessionId: MEMBER.sessionId, offerId, token: challenge.token });
  assert.equal(accepted.ok, true, String(accepted.message));
}

async function assertHandoverCompleted(manager, member, offerId) {
  await waitFor(() => member.service.localSeatOf(COLLAB_ID, MEMBER.sessionId)?.role === 'manager' ? true : null, { timeoutMs: 8000 });
  const ledger = await viewOf(member);
  assert.equal(ledger.managerTerm, 2);
  assert.equal(ledger.manager.sessionId, MEMBER.sessionId);
  assert.equal(ledger.managerWindow, undefined, '显式移交不开抢接窗口');
  assert.equal(ledger.members.find((seat) => seat.sessionId === MANAGER.sessionId).role, 'member', '旧站长保留席位并降级');
  await waitFor(() => manager.service.localSeatOf(COLLAB_ID, MANAGER.sessionId)?.role === 'member' ? true : null, { timeoutMs: 8000 });
  const change = manager.sentFrames.find((frame) => frame.type === 'notice' && frame.payload?.event === 'manager-changed');
  assert.equal(change.payload.via, 'handover');
  assert.equal(change.payload.offerId, offerId);
  assert.equal(change.payload.windowEndsAt, undefined, 'handover 变更无窗口');
  assert.equal(existsSync(handoverPendingFilePath(manager.home, COLLAB_ID)), false, '完成后在途记录清除');
  const offersOnTarget = readJsonOrNull(handoverOffersFilePath(member.home, COLLAB_ID));
  assert.ok(offersOnTarget.offers.some((offer) => offer.offerId === offerId), '目标侧 offer 记录落盘');
}

test('T4：1 分钟窗口内成员接管，关闭窗口且不重开（新站长签发 via=takeover）', { timeout: TIMEOUT_MS }, async (t) => {
  const { manager, challenger } = await startWindowPair(t, new Date(Date.now() + 60000).toISOString());
  const confirmed = await takeOverWithToken(challenger, RIVAL.sessionId);
  assert.equal(confirmed.ok, true, String(confirmed.message));
  assertWindowTakeover(await viewOf(challenger), challenger.sentFrames);
  await waitFor(() => manager.service.view({ collabId: COLLAB_ID }).then((view) => view.ledger?.manager?.sessionId === RIVAL.sessionId ? true : null), { timeoutMs: 8000 });
  assert.equal((await viewOf(manager)).managerTerm, 3, '旧站长按更高 term 降级采纳');
});

async function takeOverWithToken(node, sessionId) {
  const first = await node.service.takeOver({ collabId: COLLAB_ID, sessionId });
  assert.equal(first.needsUserConfirmation, true, String(first.message));
  return node.service.takeOver({ collabId: COLLAB_ID, sessionId, token: first.token });
}

function assertWindowTakeover(ledger, sentFrames) {
  assert.equal(ledger.managerTerm, 3);
  assert.equal(ledger.manager.sessionId, RIVAL.sessionId);
  assert.equal(ledger.managerWindow, undefined, '窗口内接管关闭窗口且不开新窗');
  const change = sentFrames.find((frame) => frame.type === 'notice' && frame.payload?.event === 'manager-changed');
  assert.equal(change.payload.via, 'takeover');
  assert.equal(change.payload.windowBaseTerm, 2);
  assert.equal(typeof change.payload.authorizedAt, 'string');
}

test('窗口过期：未授权接管被拒；更高 term 快照不得转正并冻结 manager-fork（T5）', { timeout: TIMEOUT_MS }, async (t) => {
  const { manager, challenger } = await startWindowPair(t, new Date(Date.now() - 1000).toISOString());
  const refused = await challenger.service.takeOver({ collabId: COLLAB_ID, sessionId: RIVAL.sessionId });
  assert.equal(refused.ok, false, '窗口过期且站长可达时拒绝接管');
  assert.match(String(refused.message), /可达|放弃接管|窗口|失联/, String(refused.message));
  assert.equal((await viewOf(challenger)).managerTerm, 2, '被拒接管不改本地任期');

  /* 被拒接管者推送更高 term 快照：活跃态按 A10 不采纳未受理 manager 的台账，转 manager-fork。 */
  await feedUnauthorizedSnapshot(manager, await viewOf(manager));
  await waitFor(() => freezeReasonOf(manager) === 'manager-fork' ? true : null, { timeoutMs: 3000 });
  const after = await viewOf(manager);
  assert.equal(after.managerTerm, 2, '高 term 快照不得把被拒接管转正');
  assert.equal(after.manager.sessionId, MEMBER.sessionId);
});

async function feedUnauthorizedSnapshot(manager, termState) {
  /* 形态必须自洽（唯一 manager 行 ↔ manager 字段）：否则先被判损坏，测不到 A10 的来源授权面。 */
  const nextTerm = termState.managerTerm + 1;
  const forgedLedger = {
    ...structuredClone(termState),
    managerTerm: nextTerm,
    version: termState.version + 1,
    members: termState.members.map((seat) => (seat.instanceId === RIVAL.instanceId
      ? { ...seat, role: 'manager' }
      : { ...seat, role: 'member' })),
    manager: { instanceId: RIVAL.instanceId, sessionId: RIVAL.sessionId, identityName: RIVAL.identityName, term: nextTerm },
  };
  delete forgedLedger.managerWindow;
  await feedSessionFrame(manager, {
    v: 1,
    cap: 2,
    type: 'snapshot',
    msgId: randomUUID(),
    collabId: COLLAB_ID,
    from: { instanceId: RIVAL.instanceId, sessionId: RIVAL.sessionId, identityName: RIVAL.identityName, port: 24003 },
    ts: new Date().toISOString(),
    payload: { kind: 'data', managerTerm: forgedLedger.managerTerm, version: forgedLedger.version, digest: ledgerDigest(forgedLedger), ledger: forgedLedger },
  });
}

test('并发手动接管：同 term 不同 manager 互相冻结 manager-fork，不自动选胜者', { timeout: TIMEOUT_MS }, async (t) => {
  const { first, second } = await startConcurrentCandidates(t);
  await waitFor(() => freezeReasonOf(first) === 'manager-offline' && freezeReasonOf(second) === 'manager-offline' ? true : null, { timeoutMs: 5000 });
  const challenges = await Promise.all([
    first.service.takeOver({ collabId: COLLAB_ID, sessionId: MEMBER.sessionId }),
    second.service.takeOver({ collabId: COLLAB_ID, sessionId: RIVAL.sessionId }),
  ]);
  assert.equal(challenges.every((entry) => entry.needsUserConfirmation === true), true, JSON.stringify(challenges));
  const results = await Promise.all([
    first.service.takeOver({ collabId: COLLAB_ID, sessionId: MEMBER.sessionId, token: challenges[0].token }),
    second.service.takeOver({ collabId: COLLAB_ID, sessionId: RIVAL.sessionId, token: challenges[1].token }),
  ]);
  assert.equal(results.every((entry) => entry.ok === true), true, JSON.stringify(results));

  /* 两端各持 term 2 / 不同 manager：把对方签发的变更互相投递（同 term 冲突）。 */
  await exchangeManagerChanges(first, MEMBER, second, RIVAL);
  await waitFor(() => freezeReasonOf(first) === 'manager-fork' && freezeReasonOf(second) === 'manager-fork' ? true : null, { timeoutMs: 5000 });
  assert.equal((await viewOf(first)).manager.sessionId, MEMBER.sessionId, '本方台账不自作合并');
  assert.equal((await viewOf(second)).manager.sessionId, RIVAL.sessionId, '对方台账不自作合并');
});

/* 见证机只应答握手（不参与接管）；两名候选互不知道对方端点——冲突证据由用例定向投递。 */
async function startConcurrentCandidates(t) {
  const config = { seatPresenceIntervalMs: 100, managerProbeIntervalMs: 100, managerLossTimeoutMs: 300, sessionSeatTimeoutMs: 30000, handshakeReplyTimeoutMs: 400 };
  const members = [
    { instanceId: MANAGER.instanceId, sessionId: MANAGER.sessionId, identityName: MANAGER.identityName, role: 'manager', joinSeq: 1 },
    { instanceId: MEMBER.instanceId, sessionId: MEMBER.sessionId, identityName: MEMBER.identityName, role: 'member', joinSeq: 2 },
    { instanceId: RIVAL.instanceId, sessionId: RIVAL.sessionId, identityName: RIVAL.identityName, role: 'member', joinSeq: 3 },
    { instanceId: PEER.instanceId, sessionId: PEER.sessionId, identityName: PEER.identityName, role: 'member', joinSeq: 4 },
  ];
  const witness = await startSessionNode(t, {
    instanceId: PEER.instanceId,
    identityName: PEER.identityName,
    seed: seedNode({ members, seats: [{ sessionId: PEER.sessionId, role: 'member', joinSeq: 4 }], member: true }),
    online: [PEER.sessionId],
    config,
  });
  const first = await startSessionNode(t, {
    instanceId: MEMBER.instanceId,
    identityName: MEMBER.identityName,
    seed: seedNode({ members, seats: [{ sessionId: MEMBER.sessionId, role: 'member', joinSeq: 2 }], member: true, memberEndpoints: { [PEER.instanceId]: endpointOf(witness) } }),
    online: [MEMBER.sessionId],
    config,
  });
  const second = await startSessionNode(t, {
    instanceId: RIVAL.instanceId,
    identityName: RIVAL.identityName,
    seed: seedNode({ members, seats: [{ sessionId: RIVAL.sessionId, role: 'member', joinSeq: 3 }], member: true, memberEndpoints: { [PEER.instanceId]: endpointOf(witness) } }),
    online: [RIVAL.sessionId],
    config,
  });
  await bringSessionOnline(witness, PEER.sessionId);
  await bringSessionOnline(first, MEMBER.sessionId);
  await bringSessionOnline(second, RIVAL.sessionId);
  witness.service.start();
  first.service.start();
  second.service.start();
  return { witness, first, second };
}

async function exchangeManagerChanges(left, leftSeat, right, rightSeat) {
  const leftLedger = await viewOf(left);
  const rightLedger = await viewOf(right);
  /* 交叉投递：左方收到右方签发的变更，右方收到左方签发的变更（同 term 不同 manager 的冲突证据）。 */
  await feedSessionFrame(left, noticeFrame(changeOf(rightLedger, rightSeat), rightSeat));
  await feedSessionFrame(right, noticeFrame(changeOf(leftLedger, leftSeat), leftSeat));
}

function changeOf(ledger, seat) {
  return {
    event: 'manager-changed',
    via: 'takeover-manual',
    term: ledger.managerTerm,
    version: ledger.version,
    prevManager: { instanceId: MANAGER.instanceId, sessionId: MANAGER.sessionId },
    manager: { instanceId: seat.instanceId, sessionId: seat.sessionId, identityName: seat.identityName },
    effectiveAt: new Date().toISOString(),
    authorizedAt: new Date().toISOString(),
    endpoint: { address: '127.0.0.1', port: 24004 },
    digest: ledgerDigest(ledger),
  };
}

test('核重启：宽限内以同一数据根恢复席位与台账，远端不误踢', { timeout: TIMEOUT_MS }, async (t) => {
  const config = { seatPresenceIntervalMs: 100, managerProbeIntervalMs: 100, managerLossTimeoutMs: 30000, sessionSeatGraceMs: 5000 };
  const memberHome = makeTempRoot(t);
  const { manager, member } = await startLinkedPair(t, {
    config,
    memberHome,
    managerSeed: seedNode({ seats: [{ sessionId: MANAGER.sessionId, role: 'manager', joinSeq: 1 }] }),
    memberSeed: seedNode({ seats: [{ sessionId: MEMBER.sessionId, role: 'member', joinSeq: 2 }], member: true }),
  });
  assert.equal((await manager.service.send({ collabId: COLLAB_ID, text: '重启前', sessionId: MANAGER.sessionId })).ok, true);
  await waitFor(() => injectionsOf(member, MEMBER.sessionId).some((entry) => entry.payload?.text === '重启前') ? true : null, { timeoutMs: 8000 });
  const restarted = await restartMember(t, member, config);
  assert.equal(restarted.service.listLocalSeats(COLLAB_ID).some((seat) => seat.sessionId === MEMBER.sessionId), true, '席位文件随数据根恢复');
  const restored = readJsonOrNull(collabFilePath(restarted.home, COLLAB_ID, 'snapshot.json'));
  assert.equal(restored?.ledger?.manager?.sessionId, MANAGER.sessionId, '台账/快照恢复');
  const resumed = await manager.service.send({ collabId: COLLAB_ID, text: '重启后', sessionId: MANAGER.sessionId });
  assert.equal(resumed.ok, true, String(resumed.message));
  await waitFor(() => injectionsOf(restarted, MEMBER.sessionId).some((entry) => entry.payload?.text === '重启后') ? true : null, { timeoutMs: 8000 });
  assertNoFalseLeave(manager);
});

async function restartMember(t, member, config) {
  const { home, port } = member;
  const instanceId = member.self.instanceId;
  await closeSessionNode(member);
  await waitForRebindable(port);
  const restarted = await startSessionNode(t, { home, port, instanceId, identityName: MEMBER.identityName, online: [MEMBER.sessionId], config });
  await bringSessionOnline(restarted, MEMBER.sessionId);
  return restarted;
}

async function assertNoFalseLeave(manager) {
  const roster = (await manager.service.view({ collabId: COLLAB_ID })).ledger.members;
  assert.equal(roster.some((seat) => seat.sessionId === MEMBER.sessionId), true, '重启期间远端不误踢');
  const departed = existsSync(departedFilePath(manager.home, COLLAB_ID)) ? readFileSync(departedFilePath(manager.home, COLLAB_ID), 'utf8') : '';
  assert.equal(departed.includes(`"${MEMBER.sessionId}"`), false, '重启未产生离席记录');
}
