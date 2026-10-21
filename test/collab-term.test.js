import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ledgerDigest } from '../src/collab/store.js';
import { isLedgerShape } from '../src/collab/model.js';
import { newMsgId, PROTOCOL_VERSION, validateMessage, withCollabCapability } from '../src/net/protocol.js';
import {
  acceptManagerChange,
  clearManagerWindow,
  compareSnapshot,
  makeAutoOffer,
  managerWindowRemaining,
  matchesAutoOffer,
  setManagerWindow,
} from '../src/collab/term.js';

const NOW = Date.parse('2026-10-21T10:00:00.000Z');
const DIGEST = 'a'.repeat(64);
const COLLAB_ID = 'collab-m5-term';
const SEAT_A = { instanceId: 'inst-a', sessionId: 'session-a', identityName: '甲机' };
const SEAT_B = { instanceId: 'inst-b', sessionId: 'session-b', identityName: '乙机' };
const SEAT_C = { instanceId: 'inst-c', sessionId: 'session-c', identityName: '丙机' };
const SEAT_D = { instanceId: 'inst-d', sessionId: 'session-d', identityName: '丁机' };
const ENDPOINT = { address: '127.0.0.1', port: 46000 };

function iso(ms) {
  return new Date(ms).toISOString();
}

function seatRef(seat) {
  return { instanceId: seat.instanceId, sessionId: seat.sessionId };
}

function rosterRow(seat, role, joinSeq) {
  return {
    instanceId: seat.instanceId,
    sessionId: seat.sessionId,
    identityName: seat.identityName,
    role,
    state: 'member',
    joinSeq,
    joinedAt: iso(NOW - 60000),
  };
}

function stateOf({ term = 1, version = 10, manager = SEAT_A, window } = {}) {
  return {
    managerTerm: term,
    manager: manager === null ? null : { ...manager, term },
    version,
    ...(window === undefined ? {} : { managerWindow: window }),
  };
}

function changeOf(overrides = {}) {
  return {
    event: 'manager-changed',
    term: 2,
    version: 11,
    manager: { ...SEAT_B },
    via: 'handover',
    prevManager: seatRef(SEAT_A),
    from: { ...SEAT_A },
    offerId: 'offer-1',
    effectiveAt: iso(NOW),
    endpoint: { ...ENDPOINT },
    digest: DIGEST,
    ...overrides,
  };
}

function defaultRoster(manager, members) {
  if (members !== undefined) {
    return members;
  }
  if (manager === null) {
    return [];
  }
  return [rosterRow(manager, 'manager', 1), rosterRow(SEAT_D, 'member', 2)];
}

/* 台账构造器：默认产出能通过 isLedgerShape 的 managed 台账（M1 形态），
 * 让每个快照用例证明的不只是纯函数分支，而是可上线的入站形态。 */
function ledgerOf({ term = 2, version = 11, manager = SEAT_B, status = 'active', members, window, events } = {}) {
  const roster = defaultRoster(manager, members);
  const ledger = {
    version,
    collabId: COLLAB_ID,
    name: '联调项目',
    topic: '任期判决',
    status,
    managerTerm: term,
    joinSeqNext: 3,
    manager: manager === null ? null : { ...manager, term },
    members: roster,
    board: [],
    createdAt: iso(NOW - 120000),
    updatedAt: iso(NOW - 60000),
  };
  if (window !== undefined) {
    ledger.managerWindow = window;
  }
  if (events !== undefined) {
    ledger.events = events;
  }
  return ledger;
}

function snapshotOf({ term = 2, version = 11, manager = SEAT_B, from = SEAT_B, window, status, events, members, digest } = {}) {
  const ledger = ledgerOf({
    term,
    version,
    manager,
    status: status ?? (manager === null ? 'completed' : 'active'),
    members,
    window,
    events,
  });
  assert.equal(isLedgerShape(ledger), true, `快照台账必须通过 isLedgerShape: ${JSON.stringify(ledger).slice(0, 160)}`);
  const frame = {
    kind: 'data',
    managerTerm: term,
    version,
    digest: digest ?? ledgerDigest(ledger),
    ledger,
    from: { ...from },
  };
  if (window !== undefined) {
    frame.managerWindow = window;
  }
  return frame;
}

function catchupEvents(overrides = {}) {
  const offer = {
    type: 'auto-offer',
    offerId: 'offer-auto',
    prevManager: seatRef(SEAT_A),
    target: seatRef(SEAT_B),
    baseTerm: 1,
    version: 10,
    ...(overrides.offer ?? {}),
  };
  const change = {
    type: 'manager-changed',
    via: 'auto',
    offerId: 'offer-auto',
    term: 2,
    version: 11,
    prevManager: seatRef(SEAT_A),
    manager: seatRef(SEAT_B),
    ...(overrides.change ?? {}),
  };
  const leave = {
    type: 'leave',
    instanceId: SEAT_A.instanceId,
    sessionId: SEAT_A.sessionId,
    reason: 'manager-session-closed',
    ...(overrides.leave ?? {}),
  };
  return [offer, change, leave];
}

function snapshotCtx(extra = {}) {
  return { now: NOW, ledgerDigestOf: ledgerDigest, ...extra };
}

function autoOfferOf(overrides = {}) {
  return makeAutoOffer({
    offerId: 'offer-auto',
    prevManager: seatRef(SEAT_A),
    target: seatRef(SEAT_B),
    baseTerm: 1,
    version: 10,
    expiresAt: iso(NOW + 120000),
    ...overrides,
  });
}

function accepts(result) {
  assert.equal(result.accepted, true, `期望受理，实际 ${result.reason}`);
}

function rejects(result, reason, message) {
  assert.equal(result.accepted, false, message ?? `期望拒收，实际受理 ${result.reason}`);
  if (reason !== undefined) {
    assert.equal(result.reason, reason, message);
  }
}

function takeoverFrame(overrides = {}) {
  return changeOf({
    term: 3,
    version: 12,
    manager: SEAT_C,
    via: 'takeover',
    prevManager: SEAT_B,
    from: SEAT_C,
    offerId: undefined,
    windowBaseTerm: 2,
    authorizedAt: iso(NOW),
    ...overrides,
  });
}

function manualFrame(overrides = {}) {
  return takeoverFrame({ via: 'takeover-manual', ...overrides });
}

function windowState(overrides = {}) {
  return stateOf({
    term: 2,
    version: 11,
    manager: SEAT_B,
    window: { windowBaseTerm: 2, windowEndsAt: iso(NOW + 60000) },
    ...overrides,
  });
}

function manualCtx(extra = {}) {
  return { now: NOW, memberSeats: [SEAT_C], managerReachable: false, ...extra };
}

function wireEnvelope(payload, from = SEAT_A) {
  return withCollabCapability({
    v: PROTOCOL_VERSION,
    type: 'snapshot',
    msgId: newMsgId(),
    collabId: COLLAB_ID,
    ts: iso(NOW),
    from: { instanceId: from.instanceId, sessionId: from.sessionId, identityName: from.identityName },
    payload,
  });
}

function wirePayloadOf(frame) {
  return {
    kind: 'data',
    version: frame.version,
    managerTerm: frame.managerTerm,
    digest: frame.digest,
    ledger: frame.ledger,
    ...(frame.managerWindow === undefined ? {} : { managerWindow: frame.managerWindow }),
  };
}

test('A1 handover：来源旧站长、term+1、version 更新 → 受理、关旧窗、不开窗', () => {
  const state = stateOf({ window: { windowBaseTerm: 1, windowEndsAt: iso(NOW + 30000) } });
  const result = acceptManagerChange(state, changeOf(), { now: NOW });
  accepts(result);
  assert.equal(result.nextState.managerTerm, 2);
  assert.equal(result.nextState.manager.sessionId, SEAT_B.sessionId);
  assert.equal(result.nextState.manager.term, 2);
  assert.equal(result.nextState.version, 11);
  assert.equal(result.nextState.managerWindow, undefined);
  assert.ok(result.actions.includes('adopt'));
  assert.ok(result.actions.includes('request-snapshot'));
  assert.ok(result.actions.includes('close-window'));
});

test('A1 handover：来源或 prevManager 对不上 → 拒收并冻结分叉', () => {
  const bySource = acceptManagerChange(stateOf(), changeOf({ from: SEAT_C }), { now: NOW });
  rejects(bySource);
  assert.equal(bySource.freezeReason, 'manager-fork');
  assert.ok(bySource.actions.includes('count-reject'));
  const byPrev = acceptManagerChange(stateOf(), changeOf({ prevManager: SEAT_C }), { now: NOW });
  rejects(byPrev);
  assert.equal(byPrev.freezeReason, 'manager-fork');
});

test('A1 handover：缺 offerId / digest / endpoint / from 或 version 不更新 → 拒收计数、不冻结', () => {
  const cases = [
    changeOf({ offerId: undefined }),
    changeOf({ digest: '' }),
    changeOf({ endpoint: undefined }),
    changeOf({ version: 10 }),
  ];
  for (const frame of cases) {
    const result = acceptManagerChange(stateOf(), frame, { now: NOW });
    rejects(result);
    assert.equal(result.freezeReason, undefined);
    assert.ok(result.actions.includes('count-reject'));
    assert.equal(result.nextState.manager.sessionId, SEAT_A.sessionId);
  }
  const noFrom = changeOf();
  delete noFrom.from;
  rejects(acceptManagerChange(stateOf(), noFrom, { now: NOW }), 'frame-invalid');
});

test('A2 auto：来源新站长且匹配 auto-offer → 受理并写入窗口与剩余时长', () => {
  const frame = changeOf({ via: 'auto', from: SEAT_B, offerId: 'offer-auto', windowEndsAt: iso(NOW + 60000) });
  const result = acceptManagerChange(stateOf(), frame, { now: NOW, autoOffers: [autoOfferOf()] });
  accepts(result);
  assert.deepEqual(result.nextState.managerWindow, { windowBaseTerm: 2, windowEndsAt: iso(NOW + 60000) });
  assert.equal(result.windowRemaining, 60000);
  assert.ok(result.actions.includes('open-window'));
});

test('A2 auto：无匹配 auto-offer → 拒收计数且不改 manager（T2a）', () => {
  const frame = changeOf({
    via: 'auto',
    from: SEAT_C,
    manager: SEAT_C,
    offerId: 'offer-auto',
    windowEndsAt: iso(NOW + 60000),
  });
  const result = acceptManagerChange(stateOf(), frame, { now: NOW });
  rejects(result);
  assert.equal(result.freezeReason, undefined);
  assert.equal(result.nextState.manager.sessionId, SEAT_A.sessionId);
  assert.ok(result.actions.includes('request-snapshot'), '错过 offer 时拉快照走 A10 追赶');
});

test('A2 auto：offerId / target / prevManager / baseTerm 不匹配均拒收', () => {
  const frame = changeOf({ via: 'auto', from: SEAT_B, offerId: 'offer-auto', windowEndsAt: iso(NOW + 60000) });
  const mismatches = [
    autoOfferOf({ offerId: 'offer-other' }),
    autoOfferOf({ target: seatRef(SEAT_C) }),
    autoOfferOf({ prevManager: seatRef(SEAT_C) }),
    autoOfferOf({ baseTerm: 2 }),
  ];
  for (const offer of mismatches) {
    const result = acceptManagerChange(stateOf(), frame, { now: NOW, autoOffers: [offer] });
    rejects(result);
    assert.equal(result.nextState.manager.sessionId, SEAT_A.sessionId);
  }
});

test('A2 auto：来源不是新站长 → 拒收并冻结分叉', () => {
  const frame = changeOf({ via: 'auto', from: SEAT_C, offerId: 'offer-auto', windowEndsAt: iso(NOW + 60000) });
  const result = acceptManagerChange(stateOf(), frame, { now: NOW, autoOffers: [autoOfferOf()] });
  rejects(result);
  assert.equal(result.freezeReason, 'manager-fork');
});

test('A2 auto：迟到 130s 到达 → 受理但窗口剩余为 0；远期/倒序窗口按坏帧拒收', () => {
  const late = changeOf({
    via: 'auto',
    from: SEAT_B,
    offerId: 'offer-auto',
    effectiveAt: iso(NOW - 130000),
    windowEndsAt: iso(NOW - 70000),
  });
  const accepted = acceptManagerChange(stateOf(), late, { now: NOW, autoOffers: [autoOfferOf()] });
  accepts(accepted);
  assert.equal(managerWindowRemaining(accepted.nextState.managerWindow, NOW), 0);
  const far = changeOf({ via: 'auto', from: SEAT_B, offerId: 'offer-auto', windowEndsAt: iso(NOW + 3600000) });
  rejects(acceptManagerChange(stateOf(), far, { now: NOW, autoOffers: [autoOfferOf()] }), 'window-invalid');
  const backwards = changeOf({
    via: 'auto',
    from: SEAT_B,
    offerId: 'offer-auto',
    windowEndsAt: iso(NOW - 1000),
  });
  rejects(acceptManagerChange(stateOf(), backwards, { now: NOW, autoOffers: [autoOfferOf()] }), 'window-invalid');
  const zeroLength = changeOf({
    via: 'auto',
    from: SEAT_B,
    offerId: 'offer-auto',
    effectiveAt: iso(NOW),
    windowEndsAt: iso(NOW),
  });
  rejects(acceptManagerChange(stateOf(), zeroLength, { now: NOW, autoOffers: [autoOfferOf()] }), 'window-invalid');
  const future = changeOf({
    via: 'auto',
    from: SEAT_B,
    offerId: 'offer-auto',
    effectiveAt: iso(NOW + 3600000),
    windowEndsAt: iso(NOW + 3660000),
  });
  rejects(acceptManagerChange(stateOf(), future, { now: NOW, autoOffers: [autoOfferOf()] }), 'window-invalid');
});

test('A3 takeover：59s 受理、61s 拒收、窗口内授权迟到仍受理', () => {
  const at59 = acceptManagerChange(windowState(), takeoverFrame({ authorizedAt: iso(NOW + 59000) }), {
    now: NOW + 59000,
    memberSeats: [SEAT_C],
    windowBaseAt: NOW,
  });
  accepts(at59);
  assert.equal(at59.nextState.manager.sessionId, SEAT_C.sessionId);
  assert.equal(at59.nextState.managerWindow, undefined);
  const at61 = acceptManagerChange(windowState(), takeoverFrame({ authorizedAt: iso(NOW + 61000) }), {
    now: NOW + 61000,
    memberSeats: [SEAT_C],
    windowBaseAt: NOW,
  });
  rejects(at61, 'window-closed');
  const late = acceptManagerChange(windowState({ window: { windowBaseTerm: 2, windowEndsAt: iso(NOW - 10000) } }), takeoverFrame({ authorizedAt: iso(NOW - 20000) }), {
    now: NOW + 60000,
    memberSeats: [SEAT_C],
  });
  accepts(late);
});

test('A3 takeover：墙钟回拨不重开窗口，前跳后仍按窗口内 authorizedAt 受理', () => {
  const attacker = takeoverFrame({ authorizedAt: iso(NOW - 3600000) });
  rejects(acceptManagerChange(windowState(), attacker, {
    now: NOW - 3600000,
    memberSeats: [SEAT_C],
    windowBaseAt: NOW,
  }), 'window-closed');
  assert.equal(managerWindowRemaining(windowState().managerWindow, NOW - 3600000, { baseAt: NOW }), 60000);
  const lateAuthorized = takeoverFrame({ authorizedAt: iso(NOW + 30000) });
  accepts(acceptManagerChange(windowState(), lateAuthorized, {
    now: NOW + 3600000,
    memberSeats: [SEAT_C],
    windowBaseAt: NOW,
  }));
});

test('A3 takeover：本地无窗口基准或 windowBaseTerm 不符 → 拒收并请求快照', () => {
  const noWindow = acceptManagerChange(stateOf({ term: 2, version: 11, manager: SEAT_B }), takeoverFrame(), {
    now: NOW,
    memberSeats: [SEAT_C],
  });
  rejects(noWindow, 'window-missing');
  assert.ok(noWindow.actions.includes('request-snapshot'));
  rejects(acceptManagerChange(windowState(), takeoverFrame({ windowBaseTerm: 1 }), {
    now: NOW,
    memberSeats: [SEAT_C],
  }), 'window-base-mismatch');
});

test('A3 takeover：签发者不是新站长或来源不在名单 → 冻结分叉', () => {
  const byIssuer = acceptManagerChange(windowState(), takeoverFrame({ from: SEAT_B }), {
    now: NOW,
    memberSeats: [SEAT_B, SEAT_C],
  });
  rejects(byIssuer);
  assert.equal(byIssuer.freezeReason, 'manager-fork');
  const byRoster = acceptManagerChange(windowState(), takeoverFrame(), { now: NOW, memberSeats: [SEAT_B] });
  rejects(byRoster);
  assert.equal(byRoster.freezeReason, 'manager-fork');
  const missingRoster = acceptManagerChange(windowState(), takeoverFrame(), { now: NOW });
  rejects(missingRoster);
  assert.equal(missingRoster.freezeReason, 'manager-fork');
});

test('A4 takeover-manual：活跃态（未冻结）在站长不可达证据下受理，无窗口', () => {
  const state = stateOf({ term: 2, version: 11, manager: SEAT_B });
  const result = acceptManagerChange(state, manualFrame(), manualCtx());
  accepts(result);
  assert.equal(result.nextState.manager.sessionId, SEAT_C.sessionId);
  assert.equal(result.nextState.managerWindow, undefined);
  assert.equal(result.actions.includes('clear-freeze'), false);
});

test('A4 takeover-manual：可达性证据缺失拒绝；站长可达拒绝；离线冻结可作证据并解除', () => {
  const state = stateOf({ term: 2, version: 11, manager: SEAT_B });
  rejects(acceptManagerChange(state, manualFrame(), { now: NOW, memberSeats: [SEAT_C] }), 'manager-reachability-unknown');
  rejects(acceptManagerChange(state, manualFrame(), manualCtx({ managerReachable: true })), 'manager-reachable');
  const offline = acceptManagerChange(state, manualFrame(), manualCtx({ managerReachable: undefined, localFrozen: 'manager-offline' }));
  accepts(offline);
  assert.ok(offline.actions.includes('clear-freeze'));
  const departed = acceptManagerChange(state, manualFrame(), manualCtx({ managerReachable: undefined, managerDeparted: true }));
  accepts(departed);
});

test('A4 takeover-manual：fork / pending 冻结态拒收，不解除冻结', () => {
  const state = stateOf({ term: 2, version: 11, manager: SEAT_B });
  rejects(acceptManagerChange(state, manualFrame(), manualCtx({ localFrozen: 'manager-fork' })), 'frozen-manager-fork');
  rejects(acceptManagerChange(state, manualFrame(), manualCtx({ localFrozen: 'manager-pending' })), 'frozen-manager-pending');
});

test('A4 takeover-manual：只拦当前任期的 auto 在途，旧任期 offer 不阻塞', () => {
  const state = stateOf({ term: 2, version: 11, manager: SEAT_B });
  const blocking = autoOfferOf({ baseTerm: 2, prevManager: seatRef(SEAT_B), target: seatRef(SEAT_C) });
  rejects(acceptManagerChange(state, manualFrame(), manualCtx({ autoOffers: [blocking] })), 'auto-in-flight');
  rejects(acceptManagerChange(state, manualFrame(), manualCtx({ autoInFlight: true })), 'auto-in-flight');
  const stale = autoOfferOf();
  accepts(acceptManagerChange(state, manualFrame(), manualCtx({ autoOffers: [stale] })));
  const expired = autoOfferOf({ baseTerm: 2, prevManager: seatRef(SEAT_B), expiresAt: iso(NOW - 1) });
  accepts(acceptManagerChange(state, manualFrame(), manualCtx({ autoOffers: [expired] })));
});

test('A4 takeover-manual：签发者非新站长 / 来源非成员 / prevManager 不符', () => {
  const state = stateOf({ term: 2, version: 11, manager: SEAT_B });
  const byIssuer = acceptManagerChange(state, manualFrame({ from: SEAT_B }), manualCtx({ memberSeats: [SEAT_B, SEAT_C] }));
  rejects(byIssuer);
  assert.equal(byIssuer.freezeReason, 'manager-fork');
  const byRoster = acceptManagerChange(state, manualFrame(), manualCtx({ memberSeats: [SEAT_B] }));
  rejects(byRoster);
  assert.equal(byRoster.freezeReason, 'manager-fork');
  const byPrev = acceptManagerChange(state, manualFrame({ prevManager: seatRef(SEAT_A) }), manualCtx());
  rejects(byPrev);
  assert.equal(byPrev.freezeReason, 'manager-fork');
});

test('A5：term+1 但缺 authorizedAt / offer 前提不成立 → 拒收计数、不冻结', () => {
  const frame = takeoverFrame({
    term: 2,
    manager: SEAT_B,
    prevManager: SEAT_A,
    from: SEAT_B,
    windowBaseTerm: 1,
    authorizedAt: undefined,
  });
  const state = stateOf({ window: { windowBaseTerm: 1, windowEndsAt: iso(NOW + 30000) } });
  const result = acceptManagerChange(state, frame, { now: NOW, memberSeats: [SEAT_B] });
  rejects(result);
  assert.equal(result.freezeReason, undefined);
  assert.ok(result.actions.includes('count-reject'));
});

test('A6：term 跳跃 → 需握手对表；超时不能同步 → 冻结节；pending 超时不转 fork', () => {
  const frame = changeOf({ term: 3, version: 12, manager: SEAT_C, from: SEAT_C, offerId: undefined });
  const gap = acceptManagerChange(stateOf(), frame, { now: NOW });
  rejects(gap, 'term-gap');
  assert.equal(gap.needsSync, true);
  assert.ok(gap.actions.includes('handshake'));
  const expired = acceptManagerChange(stateOf(), frame, { now: NOW, syncExpired: true });
  assert.equal(expired.freezeReason, 'manager-fork');
  const pending = acceptManagerChange(stateOf(), frame, { now: NOW, syncExpired: true, localFrozen: 'manager-pending' });
  rejects(pending, 'manager-pending-timeout');
  assert.equal(pending.freezeReason, undefined);
});

test('A7/A8/A9：同 term 幂等、同 term 不同 manager 分叉、低 term 拒收', () => {
  const idempotent = acceptManagerChange(stateOf(), changeOf({ term: 1, manager: SEAT_A, version: 12, from: SEAT_A }), { now: NOW });
  rejects(idempotent, 'idempotent');
  assert.equal(idempotent.idempotent, true);
  assert.deepEqual(idempotent.actions, ['ack', 'request-snapshot']);
  const sameVersion = acceptManagerChange(stateOf(), changeOf({ term: 1, manager: SEAT_A, version: 10, from: SEAT_A }), { now: NOW });
  assert.deepEqual(sameVersion.actions, ['ack']);
  const fork = acceptManagerChange(stateOf(), changeOf({ term: 1, manager: SEAT_B, version: 12 }), { now: NOW });
  assert.equal(fork.freezeReason, 'manager-fork');
  rejects(acceptManagerChange(stateOf({ term: 2, version: 12 }), changeOf({ term: 1, manager: SEAT_B }), { now: NOW }), 'term-behind');
});

test('冻结态门控：fork 拒收所有 term+1；pending 只接受在途 offer 的 auto', () => {
  rejects(acceptManagerChange(stateOf(), changeOf(), { now: NOW, localFrozen: 'manager-fork' }), 'frozen-manager-fork');
  rejects(acceptManagerChange(stateOf(), changeOf(), { now: NOW, localFrozen: 'manager-pending' }), 'frozen-manager-pending');
  const autoFrame = changeOf({ via: 'auto', from: SEAT_B, offerId: 'offer-auto', windowEndsAt: iso(NOW + 60000) });
  rejects(acceptManagerChange(stateOf(), autoFrame, {
    now: NOW,
    localFrozen: 'manager-pending',
    autoOffers: [autoOfferOf()],
  }), 'pending-offer-mismatch');
  const matched = acceptManagerChange(stateOf(), autoFrame, {
    now: NOW,
    localFrozen: 'manager-pending',
    autoOffers: [autoOfferOf()],
    pendingTarget: seatRef(SEAT_B),
  });
  accepts(matched);
  assert.ok(matched.actions.includes('clear-freeze'));
  rejects(acceptManagerChange(stateOf(), autoFrame, {
    now: NOW,
    localFrozen: 'manager-pending',
    autoOffers: [autoOfferOf()],
    pendingOfferId: 'other-offer',
  }), 'pending-offer-mismatch');
});

test('本地终态：同 term 变更/非授权快照只拒收，不永久拒收也不冻结', () => {
  const terminal = stateOf({ manager: null });
  rejects(acceptManagerChange(terminal, changeOf({ term: 1, manager: SEAT_A, from: SEAT_A }), { now: NOW }), 'no-local-manager');
  rejects(acceptManagerChange(terminal, snapshotOf({ term: 1, version: 10, manager: SEAT_A, from: SEAT_A }), snapshotCtx()), 'snapshot-not-authorized');
});

test('A10 快照：来源＝本地现任站长 → 受理更高 term', () => {
  const result = acceptManagerChange(stateOf(), snapshotOf({ from: SEAT_A }), snapshotCtx());
  accepts(result);
  assert.equal(result.nextState.managerTerm, 2);
  assert.equal(result.nextState.manager.sessionId, SEAT_B.sessionId);
  assert.equal(result.nextState.version, 11);
});

test('A10 快照：digest 未验证或不匹配 → 拒收，不得采纳', () => {
  const frame = snapshotOf({ from: SEAT_A });
  rejects(acceptManagerChange(stateOf(), frame, { now: NOW }), 'digest-unverified');
  const tampered = { ...frame, digest: 'b'.repeat(64) };
  rejects(acceptManagerChange(stateOf(), tampered, snapshotCtx()), 'digest-unverified');
  accepts(acceptManagerChange(stateOf(), frame, snapshotCtx()));
});

test('A10 快照：已受理过的新站长（绑定来源）与 handover-pending 目标可受理', () => {
  const frame = snapshotOf({ manager: SEAT_C, from: SEAT_C });
  const record = { term: 2, manager: seatRef(SEAT_C), source: seatRef(SEAT_C) };
  accepts(acceptManagerChange(stateOf(), frame, snapshotCtx({ acceptedManager: record })));
  const wrongSource = acceptManagerChange(stateOf(), frame, snapshotCtx({
    acceptedManager: { ...record, source: seatRef(SEAT_B) },
  }));
  rejects(wrongSource);
  assert.equal(wrongSource.freezeReason, 'manager-fork');
  const missingSource = acceptManagerChange(stateOf(), frame, snapshotCtx({
    acceptedManager: { term: 2, manager: seatRef(SEAT_C) },
  }));
  rejects(missingSource);
  assert.equal(missingSource.freezeReason, 'manager-fork');
  rejects(acceptManagerChange(stateOf(), snapshotOf({ term: 1, version: 11, manager: SEAT_A, from: SEAT_C }), snapshotCtx({
    acceptedManager: { term: 1, manager: seatRef(SEAT_A), source: seatRef(SEAT_A) },
  })), 'snapshot-source-not-manager');
  const target = snapshotOf();
  accepts(acceptManagerChange(stateOf(), target, snapshotCtx({
    suspended: { state: 'handover-pending', target: seatRef(SEAT_B) },
  })));
  const wrongTarget = acceptManagerChange(stateOf(), target, snapshotCtx({
    suspended: { state: 'handover-pending', target: seatRef(SEAT_C) },
  }));
  rejects(wrongTarget);
  assert.equal(wrongTarget.freezeReason, 'manager-fork');
  rejects(acceptManagerChange(stateOf(), target, snapshotCtx({ suspended: 'handover-pending' })));
});

test('A10 追赶（I-3）：只认本机已收的匹配 auto-offer，快照自造 events + 自算 digest 一律拒绝并冻结', () => {
  const state = stateOf();
  const forgedEvents = catchupEvents({
    offer: { target: seatRef(SEAT_C) },
    change: { manager: seatRef(SEAT_C) },
  });
  const forged = snapshotOf({ term: 2, version: 11, manager: SEAT_C, from: SEAT_C, events: forgedEvents });
  const byEventsOnly = acceptManagerChange(state, forged, snapshotCtx({ memberSeats: [SEAT_C] }));
  rejects(byEventsOnly);
  assert.equal(byEventsOnly.freezeReason, 'manager-fork', '台账事件不构成来源证据（无签名可自造）');
  assert.equal(byEventsOnly.nextState.manager.sessionId, SEAT_A.sessionId);
  const localOffer = autoOfferOf({ target: seatRef(SEAT_C) });
  const catchup = acceptManagerChange(state, forged, snapshotCtx({ autoOffers: [localOffer] }));
  accepts(catchup);
  assert.equal(catchup.nextState.manager.sessionId, SEAT_C.sessionId);
  const wrongTarget = acceptManagerChange(state, forged, snapshotCtx({ autoOffers: [autoOfferOf()] }));
  rejects(wrongTarget);
  assert.equal(wrongTarget.freezeReason, 'manager-fork');
  const wrongBase = acceptManagerChange(state, forged, snapshotCtx({
    autoOffers: [autoOfferOf({ target: seatRef(SEAT_C), baseTerm: 2 })],
  }));
  rejects(wrongBase);
  assert.equal(wrongBase.freezeReason, 'manager-fork');
  const wrongPrev = acceptManagerChange(state, forged, snapshotCtx({
    autoOffers: [autoOfferOf({ target: seatRef(SEAT_C), prevManager: seatRef(SEAT_B) })],
  }));
  rejects(wrongPrev);
  assert.equal(wrongPrev.freezeReason, 'manager-fork');
});

test('A10 快照：未受理来源的更高 term（含自称新站长）→ 拒收并冻结，不经快照转正', () => {
  const frame = snapshotOf({ manager: SEAT_C, from: SEAT_C });
  const result = acceptManagerChange(stateOf(), frame, snapshotCtx({ memberSeats: [SEAT_C] }));
  rejects(result);
  assert.equal(result.freezeReason, 'manager-fork');
  assert.ok(result.actions.includes('count-reject'));
  const jump = snapshotOf({ term: 4, manager: SEAT_C, from: SEAT_C });
  assert.equal(acceptManagerChange(stateOf(), jump, snapshotCtx()).freezeReason, 'manager-fork');
});

test('A10 快照：manager-offline 只受理与握手最高 pair 一致且来源为成员的 catch-up', () => {
  const state = stateOf({ term: 2, version: 12, manager: SEAT_B });
  const frame = snapshotOf({ term: 3, version: 14, manager: SEAT_C, from: SEAT_A });
  const highest = { term: 3, version: 14, manager: seatRef(SEAT_C) };
  const accepted = acceptManagerChange(state, frame, snapshotCtx({
    localFrozen: 'manager-offline',
    handshakeHighest: highest,
    memberSeats: [SEAT_A],
  }));
  accepts(accepted);
  assert.ok(accepted.actions.includes('clear-freeze'));
  rejects(acceptManagerChange(state, frame, snapshotCtx({
    localFrozen: 'manager-offline',
    handshakeHighest: { ...highest, version: 13 },
    memberSeats: [SEAT_A],
  })));
  rejects(acceptManagerChange(state, frame, snapshotCtx({
    localFrozen: 'manager-offline',
    handshakeHighest: highest,
  })), 'source-not-member');
});

test('A10 快照：fork 证据必须绑定快照 term/manager，pending 只读', () => {
  const state = stateOf({ term: 2, version: 12, manager: SEAT_B });
  const frame = snapshotOf({ term: 3, version: 14, manager: SEAT_C, from: SEAT_A });
  const good = { via: 'takeover-manual', authorizedAt: iso(NOW - 1000), term: 3, manager: seatRef(SEAT_C) };
  accepts(acceptManagerChange(state, frame, snapshotCtx({ localFrozen: 'manager-fork', authorizedEvidence: good })));
  rejects(acceptManagerChange(state, frame, snapshotCtx({
    localFrozen: 'manager-fork',
    authorizedEvidence: { ...good, manager: seatRef(SEAT_B) },
  })), 'frozen-manager-fork');
  rejects(acceptManagerChange(state, frame, snapshotCtx({
    localFrozen: 'manager-fork',
    authorizedEvidence: { ...good, term: 2 },
  })), 'frozen-manager-fork');
  rejects(acceptManagerChange(state, frame, snapshotCtx({ localFrozen: 'manager-pending' })), 'frozen-manager-pending');
});

test('A11/A12：同 term 快照校验签发者、保留本地窗口、窗口冲突冻结', () => {
  const localWindow = { windowBaseTerm: 1, windowEndsAt: iso(NOW + 30000) };
  const state = stateOf({ window: localWindow });
  const updated = acceptManagerChange(state, snapshotOf({ term: 1, version: 11, manager: SEAT_A, from: SEAT_A }), snapshotCtx());
  accepts(updated);
  assert.equal(updated.nextState.version, 11);
  assert.deepEqual(updated.nextState.managerWindow, localWindow);
  const conflicting = snapshotOf({ term: 1, version: 11, manager: SEAT_A, from: SEAT_A, window: { windowBaseTerm: 1, windowEndsAt: iso(NOW + 45000) } });
  assert.equal(acceptManagerChange(state, conflicting, snapshotCtx()).freezeReason, 'manager-fork');
  const inactive = acceptManagerChange(state, snapshotOf({ term: 1, version: 11, manager: SEAT_A, from: SEAT_A }), snapshotCtx({ localFrozen: 'manager-fork' }));
  rejects(inactive, 'frozen-manager-fork');
  const pending = acceptManagerChange(state, snapshotOf({ term: 1, version: 11, manager: SEAT_A, from: SEAT_A }), snapshotCtx({ localFrozen: 'manager-pending' }));
  rejects(pending, 'frozen-manager-pending');
  rejects(acceptManagerChange(state, snapshotOf({ term: 1, version: 11, manager: SEAT_A, from: SEAT_C }), snapshotCtx()), 'snapshot-source-not-manager');
  const fork = acceptManagerChange(stateOf(), snapshotOf({ term: 1, version: 11, manager: SEAT_B }), snapshotCtx());
  assert.equal(fork.freezeReason, 'manager-fork');
});

test('A11：本地无窗口时快照窗口不被采纳，防止重开已关窗口', () => {
  const frame = snapshotOf({ term: 1, version: 11, manager: SEAT_A, from: SEAT_A, window: { windowBaseTerm: 1, windowEndsAt: iso(NOW + 45000) } });
  const result = acceptManagerChange(stateOf(), frame, snapshotCtx());
  accepts(result);
  assert.equal(result.nextState.managerWindow, undefined);
});

test('A11：manager-offline 时成员可做同 term 名单刷新，但不解除冻结', () => {
  const frame = snapshotOf({ term: 1, version: 11, manager: SEAT_A, from: SEAT_C });
  const result = acceptManagerChange(stateOf(), frame, snapshotCtx({ localFrozen: 'manager-offline', memberSeats: [SEAT_C] }));
  accepts(result);
  assert.equal(result.actions.includes('clear-freeze'), false);
});

test('A13/A14：同 term 同 version 幂等、低 term 拒收', () => {
  const same = acceptManagerChange(stateOf(), snapshotOf({ term: 1, version: 10, manager: SEAT_A, from: SEAT_A }), snapshotCtx());
  rejects(same, 'snapshot-idempotent');
  assert.deepEqual(same.actions, ['ack-snapshot-stored']);
  rejects(acceptManagerChange(stateOf({ term: 2, version: 12 }), snapshotOf({ term: 1, version: 9, manager: SEAT_A, from: SEAT_A }), snapshotCtx()), 'term-behind');
});

test('终态快照 C-1：成员用更高 term 的 manager:null 结束协作 → 拒绝且不改状态', () => {
  const state = stateOf();
  const attack = snapshotOf({ term: 2, version: 11, manager: null, from: SEAT_B });
  const result = acceptManagerChange(state, attack, snapshotCtx({ memberSeats: [SEAT_B] }));
  rejects(result, 'snapshot-terminal-untrusted');
  assert.equal(result.freezeReason, undefined, '不得让成员远程冻结活跃核');
  assert.ok(result.actions.includes('count-reject'));
  assert.equal(result.nextState.manager.sessionId, SEAT_A.sessionId);
  assert.equal(result.nextState.managerTerm, 1);
});

test('终态快照：同 term 活跃核只接受现任站长；成员副本拒绝且不冻结', () => {
  const state = stateOf({ window: { windowBaseTerm: 1, windowEndsAt: iso(NOW + 30000) } });
  const byMember = acceptManagerChange(state, snapshotOf({ term: 1, version: 11, manager: null, from: SEAT_B }), snapshotCtx({ memberSeats: [SEAT_B] }));
  rejects(byMember, 'snapshot-source-not-manager');
  assert.equal(byMember.freezeReason, undefined);
  assert.ok(byMember.actions.includes('count-reject'));
  const byManager = acceptManagerChange(state, snapshotOf({ term: 1, version: 11, manager: null, from: SEAT_A }), snapshotCtx());
  accepts(byManager);
  assert.equal(byManager.nextState.manager, null);
  assert.equal(byManager.nextState.managerTerm, 1);
  assert.equal(byManager.nextState.version, 11);
  assert.ok(byManager.actions.includes('adopt'));
  assert.ok(byManager.actions.includes('close-window'));
  rejects(acceptManagerChange(state, snapshotOf({ term: 1, version: 10, manager: null, from: SEAT_A }), snapshotCtx()), 'version-not-newer');
});

test('终态快照：更高 term 只认经 A1–A4 受理的新站长（acceptedManager 绑定来源）', () => {
  const record = { term: 2, manager: seatRef(SEAT_C), source: seatRef(SEAT_C) };
  const frame = snapshotOf({ term: 2, version: 11, manager: null, from: SEAT_C });
  accepts(acceptManagerChange(stateOf(), frame, snapshotCtx({ acceptedManager: record })));
  rejects(acceptManagerChange(stateOf(), frame, snapshotCtx({
    acceptedManager: { ...record, source: seatRef(SEAT_B) },
  })), 'snapshot-terminal-untrusted');
  rejects(acceptManagerChange(stateOf(), frame, snapshotCtx({
    acceptedManager: { term: 2, manager: seatRef(SEAT_C) },
  })), 'snapshot-terminal-untrusted');
  rejects(acceptManagerChange(stateOf(), frame, snapshotCtx({ memberSeats: [SEAT_C] })), 'snapshot-terminal-untrusted');
});

test('终态快照：fork/pending 不得被解除；offline 仅认本地现任站长（视为站长恢复）', () => {
  const terminal = snapshotOf({ term: 1, version: 11, manager: null, from: SEAT_A });
  rejects(acceptManagerChange(stateOf(), terminal, snapshotCtx({ localFrozen: 'manager-fork' })), 'frozen-manager-fork');
  rejects(acceptManagerChange(stateOf(), terminal, snapshotCtx({ localFrozen: 'manager-pending' })), 'frozen-manager-pending');
  const offlineByMember = acceptManagerChange(stateOf(), snapshotOf({ term: 1, version: 11, manager: null, from: SEAT_B }), snapshotCtx({
    localFrozen: 'manager-offline',
    memberSeats: [SEAT_B],
  }));
  rejects(offlineByMember, 'snapshot-source-not-manager');
  assert.equal(offlineByMember.actions.includes('clear-freeze'), false);
  assert.equal(offlineByMember.nextState.manager.sessionId, SEAT_A.sessionId);
  const offlineByManager = acceptManagerChange(stateOf(), terminal, snapshotCtx({ localFrozen: 'manager-offline' }));
  accepts(offlineByManager);
  assert.ok(offlineByManager.actions.includes('clear-freeze'));
});

test('终态不可逆（I-2）：经受理的更高 term 非终态权威台账可覆盖本地终态', () => {
  const terminalState = stateOf({ term: 2, version: 11, manager: null });
  const frame = snapshotOf({ term: 3, version: 12, manager: SEAT_C, from: SEAT_C });
  const unauthorized = acceptManagerChange(terminalState, frame, snapshotCtx());
  rejects(unauthorized, 'snapshot-not-authorized');
  assert.ok(unauthorized.actions.includes('request-snapshot'));
  const record = { term: 3, manager: seatRef(SEAT_C), source: seatRef(SEAT_C) };
  const restored = acceptManagerChange(terminalState, frame, snapshotCtx({ acceptedManager: record }));
  accepts(restored);
  assert.equal(restored.nextState.managerTerm, 3);
  assert.equal(restored.nextState.manager.sessionId, SEAT_C.sessionId);
  const byHandshake = acceptManagerChange(terminalState, frame, snapshotCtx({
    handshakeHighest: { term: 3, version: 12, manager: seatRef(SEAT_C) },
  }));
  accepts(byHandshake);
  const sameTerm = snapshotOf({ term: 2, version: 12, manager: SEAT_C, from: SEAT_C });
  rejects(acceptManagerChange(terminalState, sameTerm, snapshotCtx()), 'snapshot-not-authorized');
  rejects(acceptManagerChange(terminalState, sameTerm, snapshotCtx({
    handshakeHighest: { term: 2, version: 12, manager: seatRef(SEAT_C) },
  })), 'snapshot-not-authorized', '同 term 冲突不得靠 handshake 覆盖');
  accepts(acceptManagerChange(terminalState, sameTerm, snapshotCtx({
    acceptedManager: { term: 2, manager: seatRef(SEAT_C), source: seatRef(SEAT_C) },
  })));
  const auto = snapshotOf({ term: 3, version: 12, manager: SEAT_B, from: SEAT_B });
  accepts(acceptManagerChange(terminalState, auto, snapshotCtx({
    autoOffers: [autoOfferOf({ baseTerm: 2, prevManager: seatRef(SEAT_C), target: seatRef(SEAT_B) })],
  })));
});

test('终态副本收敛：同 term 按 version 推进；更高 term 必须有权威证据（防 term 钉高）', () => {
  const terminalState = stateOf({ term: 2, version: 11, manager: null });
  const sameTerm = snapshotOf({ term: 2, version: 12, manager: null, from: SEAT_B });
  const advanced = acceptManagerChange(terminalState, sameTerm, snapshotCtx({ memberSeats: [SEAT_B] }));
  accepts(advanced);
  assert.equal(advanced.nextState.version, 12);
  rejects(acceptManagerChange(terminalState, snapshotOf({ term: 2, version: 11, manager: null, from: SEAT_B }), snapshotCtx()), 'snapshot-idempotent');
  rejects(acceptManagerChange(terminalState, snapshotOf({ term: 2, version: 10, manager: null, from: SEAT_B }), snapshotCtx()), 'version-behind');
  const higher = snapshotOf({ term: 9, version: 20, manager: null, from: SEAT_B });
  rejects(acceptManagerChange(terminalState, higher, snapshotCtx({ memberSeats: [SEAT_B] })), 'snapshot-terminal-untrusted');
  const byHandshake = acceptManagerChange(terminalState, higher, snapshotCtx({
    handshakeHighest: { term: 9, version: 20, manager: null },
  }));
  accepts(byHandshake);
  assert.equal(byHandshake.nextState.managerTerm, 9);
});

test('终态形态：manager:null 必须携终态 status，且不得残留窗口', () => {
  const activeNull = ledgerOf({ term: 2, version: 11, manager: null, status: 'active' });
  const activeFrame = {
    kind: 'data',
    managerTerm: 2,
    version: 11,
    digest: ledgerDigest(activeNull),
    ledger: activeNull,
    from: { ...SEAT_B },
  };
  rejects(acceptManagerChange(stateOf(), activeFrame, snapshotCtx({ memberSeats: [SEAT_B] })), 'frame-invalid');
  const terminalWindow = { windowBaseTerm: 2, windowEndsAt: iso(NOW + 30000) };
  const withWindow = ledgerOf({ term: 2, version: 11, manager: null, status: 'completed', window: terminalWindow });
  rejects(acceptManagerChange(stateOf(), {
    kind: 'data',
    managerTerm: 2,
    version: 11,
    managerWindow: terminalWindow,
    digest: ledgerDigest(withWindow),
    ledger: withWindow,
    from: { ...SEAT_B },
  }, snapshotCtx({ memberSeats: [SEAT_B] })), 'frame-invalid');
});

test('快照窗口：帧/台账不一致按损坏拒收；同刻不同格式不误判；远期窗口拒收', () => {
  const state = stateOf();
  const localWindow = { windowBaseTerm: 1, windowEndsAt: iso(NOW + 30000) };
  const base = snapshotOf({ term: 1, version: 11, manager: SEAT_A, from: SEAT_A, window: localWindow });
  accepts(acceptManagerChange(state, base, snapshotCtx()));
  const frameOnly = { ...base, managerWindow: { ...localWindow, windowEndsAt: iso(NOW + 45000) } };
  rejects(acceptManagerChange(state, frameOnly, snapshotCtx()), 'snapshot-corrupt');
  const ledgerOnly = { ...base };
  delete ledgerOnly.managerWindow;
  rejects(acceptManagerChange(state, ledgerOnly, snapshotCtx()), 'snapshot-corrupt');
  /* 纯函数层防御：协议层 sameManagerWindow 用原始字符串比较（同一时刻不同序列化在入站即被拒）。 */
  const sameInstant = { ...base, managerWindow: { ...localWindow, windowEndsAt: new Date(NOW + 30000).toISOString().replace('.000Z', 'Z') } };
  accepts(acceptManagerChange(state, sameInstant, snapshotCtx()));
  const far = snapshotOf({ term: 1, version: 11, manager: SEAT_A, from: SEAT_A, window: { windowBaseTerm: 1, windowEndsAt: iso(NOW + 120000) } });
  rejects(acceptManagerChange(state, far, snapshotCtx()), 'snapshot-window-invalid');
});

test('窗口配置：sessionTakeoverWindowMs=120s 驱动 A2 剩余与 A3 59/61s 边界', () => {
  const frame = changeOf({
    via: 'auto',
    from: SEAT_B,
    offerId: 'offer-auto',
    effectiveAt: iso(NOW),
    windowEndsAt: iso(NOW + 120000),
  });
  const accepted = acceptManagerChange(stateOf(), frame, {
    now: NOW,
    autoOffers: [autoOfferOf()],
    sessionTakeoverWindowMs: 120000,
  });
  accepts(accepted);
  assert.equal(accepted.windowRemaining, 120000);
  assert.equal(managerWindowRemaining({ windowBaseTerm: 2, windowEndsAt: iso(NOW + 120000) }, NOW + 59000, {
    baseAt: NOW,
    windowMs: 120000,
  }), 61000);
  const state = windowState({ window: { windowBaseTerm: 2, windowEndsAt: iso(NOW + 120000) } });
  accepts(acceptManagerChange(state, takeoverFrame({ authorizedAt: iso(NOW + 119000) }), {
    now: NOW + 119000,
    memberSeats: [SEAT_C],
    windowBaseAt: NOW,
    sessionTakeoverWindowMs: 120000,
  }));
  rejects(acceptManagerChange(state, takeoverFrame({ authorizedAt: iso(NOW + 121000) }), {
    now: NOW + 121000,
    memberSeats: [SEAT_C],
    windowBaseAt: NOW,
    sessionTakeoverWindowMs: 120000,
  }), 'window-closed');
});

test('窗口配置：windowMs:0 视为未提供，不覆盖 sessionTakeoverWindowMs=120s', () => {
  assert.equal(managerWindowRemaining({ windowBaseTerm: 2, windowEndsAt: iso(NOW + 120000) }, NOW, {
    baseAt: NOW,
    windowMs: 0,
    sessionTakeoverWindowMs: 120000,
  }), 120000);
  const frame = changeOf({ via: 'auto', from: SEAT_B, offerId: 'offer-auto', windowEndsAt: iso(NOW + 120000) });
  const result = acceptManagerChange(stateOf(), frame, {
    now: NOW,
    autoOffers: [autoOfferOf()],
    windowMs: 0,
    sessionTakeoverWindowMs: 120000,
  });
  accepts(result);
  assert.equal(result.windowRemaining, 120000);
});

test('digestVerified:true 是显式旁路；需重算 digest 的接线才可置位', () => {
  const frame = snapshotOf({ from: SEAT_A });
  rejects(acceptManagerChange(stateOf(), frame, { now: NOW }), 'digest-unverified');
  accepts(acceptManagerChange(stateOf(), frame, { now: NOW, digestVerified: true }));
});

test('A3 授权分支拒绝未来 authorizedAt（伪造远期窗口时）', () => {
  const farEnd = NOW + 3600000 + 60000;
  const state = stateOf({
    term: 2,
    version: 11,
    manager: SEAT_B,
    window: { windowBaseTerm: 2, windowEndsAt: iso(farEnd) },
  });
  const frame = takeoverFrame({ authorizedAt: iso(farEnd - 1000) });
  rejects(acceptManagerChange(state, frame, { now: NOW, memberSeats: [SEAT_C] }), 'window-closed');
});

test('真实链路：validateMessage 通过后由 acceptManagerChange 受理；终态攻击同样走真实形态', () => {
  const state = stateOf();
  const window = { windowBaseTerm: 2, windowEndsAt: iso(NOW + 60000) };
  const frame = snapshotOf({ term: 2, version: 11, manager: SEAT_B, from: SEAT_A, window });
  const valid = wireEnvelope(wirePayloadOf(frame), SEAT_A);
  assert.deepEqual(validateMessage(valid), { ok: true });
  const accepted = acceptManagerChange(state, { ...valid.payload, from: valid.from }, snapshotCtx());
  accepts(accepted);
  assert.equal(accepted.nextState.manager.sessionId, SEAT_B.sessionId);
  assert.deepEqual(accepted.nextState.managerWindow, window);
  const attack = snapshotOf({ term: 2, version: 11, manager: null, from: SEAT_B });
  const attackWire = wireEnvelope(wirePayloadOf(attack), SEAT_B);
  assert.deepEqual(validateMessage(attackWire), { ok: true });
  rejects(acceptManagerChange(state, { ...attackWire.payload, from: attackWire.from }, snapshotCtx({
    memberSeats: [SEAT_B],
  })), 'snapshot-terminal-untrusted');
  const missingTerm = wireEnvelope({ kind: 'data', version: 11, digest: frame.digest, ledger: frame.ledger });
  assert.equal(validateMessage(missingTerm).ok, false, '快照生产端必须携 managerTerm（I-4）');
  const missingWindow = wireEnvelope({ kind: 'data', version: 11, managerTerm: 2, digest: frame.digest, ledger: frame.ledger });
  assert.equal(validateMessage(missingWindow).ok, false, '台账带窗口时帧必须携同值 managerWindow（I-4）');
});

test('compareSnapshot：排序/冲突/幂等，且与任期判决分类一致', () => {
  const local = { managerTerm: 2, version: 10, manager: seatRef(SEAT_B) };
  assert.equal(compareSnapshot(local, { managerTerm: 3, version: 11, manager: seatRef(SEAT_C) }).order, -1);
  assert.equal(compareSnapshot(local, { managerTerm: 2, version: 9, manager: seatRef(SEAT_B) }).order, 1);
  const conflict = compareSnapshot(local, { managerTerm: 2, version: 11, manager: seatRef(SEAT_C) });
  assert.equal(conflict.conflict, true);
  assert.equal(compareSnapshot(local, { ...local }).idempotent, true);
  assert.equal(compareSnapshot(null, local).ok, false);
  const state = stateOf({ term: 2, version: 10, manager: SEAT_B });
  const idem = acceptManagerChange(state, changeOf({ term: 2, manager: SEAT_B, version: 11, from: SEAT_B }), { now: NOW });
  assert.equal(idem.idempotent, true);
  const fork = acceptManagerChange(state, changeOf({ term: 2, manager: SEAT_C, version: 11, from: SEAT_B }), { now: NOW });
  assert.equal(fork.freezeReason, 'manager-fork');
});

test('makeAutoOffer / matchesAutoOffer：形态、匹配、恰好到期', () => {
  const offer = autoOfferOf();
  assert.deepEqual(offer, {
    offerId: 'offer-auto',
    prevManager: seatRef(SEAT_A),
    target: seatRef(SEAT_B),
    baseTerm: 1,
    version: 10,
    expiresAt: iso(NOW + 120000),
  });
  const frame = changeOf({ via: 'auto', from: SEAT_B, offerId: 'offer-auto', windowEndsAt: iso(NOW + 60000) });
  assert.equal(matchesAutoOffer(offer, frame, NOW), true);
  assert.equal(matchesAutoOffer({ ...offer, offerId: 'other' }, frame, NOW), false);
  assert.equal(matchesAutoOffer({ ...offer, target: seatRef(SEAT_C) }, frame, NOW), false);
  assert.equal(matchesAutoOffer({ ...offer, prevManager: seatRef(SEAT_C) }, frame, NOW), false);
  assert.equal(matchesAutoOffer({ ...offer, baseTerm: 2 }, frame, NOW), false);
  assert.equal(matchesAutoOffer({ ...offer, expiresAt: iso(NOW) }, frame, NOW), false);
  assert.equal(makeAutoOffer({ offerId: 'x' }), null);
  assert.equal(makeAutoOffer({ ...offer, expiresAt: 'not-a-time' }), null);
});

test('managerWindow helper：写入/清除不改原状态，剩余按 59/60/61s、回拨与前跳收敛', () => {
  const state = stateOf();
  const window = { windowBaseTerm: 2, windowEndsAt: iso(NOW + 60000) };
  const opened = setManagerWindow(state, window);
  assert.deepEqual(opened.managerWindow, window);
  assert.equal(state.managerWindow, undefined);
  assert.equal(clearManagerWindow(opened).managerWindow, undefined);
  assert.equal(managerWindowRemaining(window, NOW + 59000, { baseAt: NOW }), 1000);
  assert.equal(managerWindowRemaining(window, NOW + 60000, { baseAt: NOW }), 0);
  assert.equal(managerWindowRemaining(window, NOW + 61000, { baseAt: NOW }), 0);
  assert.equal(managerWindowRemaining(window, NOW - 3600000, { baseAt: NOW }), 60000);
  assert.equal(managerWindowRemaining(window, NOW + 3600000, { baseAt: NOW }), 0);
  const far = { windowBaseTerm: 2, windowEndsAt: iso(NOW + 3600000) };
  assert.equal(managerWindowRemaining(far, NOW), 70000);
  assert.equal(managerWindowRemaining(undefined, NOW), 0);
});

test('非法帧：不抛异常、不改状态、不误冻结', () => {
  const state = stateOf();
  assert.doesNotThrow(() => acceptManagerChange(state, null, {}));
  rejects(acceptManagerChange(state, null, {}), 'frame-invalid');
  rejects(acceptManagerChange(state, { event: 'manager-changed' }, {}), 'frame-invalid');
  rejects(acceptManagerChange(state, snapshotOf({ term: 2 }), { now: NOW }), 'digest-unverified');
});
