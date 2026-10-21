import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ledgerDigest } from '../src/collab/store.js';
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
const SEAT_A = { instanceId: 'inst-a', sessionId: 'session-a', identityName: '甲机' };
const SEAT_B = { instanceId: 'inst-b', sessionId: 'session-b', identityName: '乙机' };
const SEAT_C = { instanceId: 'inst-c', sessionId: 'session-c', identityName: '丙机' };
const ENDPOINT = { address: '127.0.0.1', port: 46000 };

function iso(ms) {
  return new Date(ms).toISOString();
}

function seatRef(seat) {
  return { instanceId: seat.instanceId, sessionId: seat.sessionId };
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

function snapshotOf({ term = 2, version = 11, manager = SEAT_B, from = SEAT_B, window } = {}) {
  const ledger = { managerTerm: term, version, manager: { ...manager, term }, members: [] };
  if (window !== undefined) {
    ledger.managerWindow = window;
  }
  const frame = { kind: 'data', managerTerm: term, version, digest: ledgerDigest(ledger), ledger, from: { ...from } };
  if (window !== undefined) {
    frame.managerWindow = window;
  }
  return frame;
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

function rejects(result, reason) {
  assert.equal(result.accepted, false, `期望拒收，实际受理 ${result.reason}`);
  if (reason !== undefined) {
    assert.equal(result.reason, reason);
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

test('终态：manager:null 收到同 term 变更/快照 → 只拒收、不冻结', () => {
  const terminal = stateOf({ manager: null });
  rejects(acceptManagerChange(terminal, changeOf({ term: 1, manager: SEAT_A, from: SEAT_A }), { now: NOW }), 'no-local-manager');
  rejects(acceptManagerChange(terminal, snapshotOf({ term: 1, version: 10, manager: SEAT_A, from: SEAT_A }), snapshotCtx()), 'no-local-manager');
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

test('A10 快照：已受理过的新站长与 handover-pending 目标可受理', () => {
  const frame = snapshotOf({ manager: SEAT_C, from: SEAT_C });
  accepts(acceptManagerChange(stateOf(), frame, snapshotCtx({ acceptedManager: { term: 2, manager: seatRef(SEAT_C) } })));
  const target = snapshotOf();
  accepts(acceptManagerChange(stateOf(), target, snapshotCtx({
    suspended: { state: 'handover-pending', target: seatRef(SEAT_B) },
  })));
  rejects(acceptManagerChange(stateOf(), target, snapshotCtx({
    suspended: { state: 'handover-pending', target: seatRef(SEAT_C) },
  })));
});

test('A10 快照：auto 追赶三证据必须与本地任期连续', () => {
  const catchup = {
    offer: autoOfferOf(),
    change: {
      offerId: 'offer-auto',
      via: 'auto',
      term: 2,
      prevManager: seatRef(SEAT_A),
      manager: seatRef(SEAT_B),
    },
    leave: { instanceId: SEAT_A.instanceId, sessionId: SEAT_A.sessionId, reason: 'manager-session-closed' },
  };
  const frame = snapshotOf();
  accepts(acceptManagerChange(stateOf(), frame, snapshotCtx({ autoCatchup: catchup })));
  const termJump = snapshotOf({ term: 3, manager: SEAT_C, from: SEAT_C });
  rejects(acceptManagerChange(stateOf(), termJump, snapshotCtx({
    autoCatchup: { ...catchup, change: { ...catchup.change, term: 3, manager: seatRef(SEAT_C) }, offer: autoOfferOf({ target: seatRef(SEAT_C) }) },
  })));
  const wrongChangeTerm = snapshotCtx({ autoCatchup: { ...catchup, change: { ...catchup.change, term: 3 } } });
  rejects(acceptManagerChange(stateOf(), frame, wrongChangeTerm));
  const wrongLeave = snapshotCtx({ autoCatchup: { ...catchup, leave: { ...catchup.leave, reason: 'manager-lost' } } });
  rejects(acceptManagerChange(stateOf(), frame, wrongLeave));
  const wrongBase = snapshotCtx({ autoCatchup: { ...catchup, offer: autoOfferOf({ baseTerm: 2 }) } });
  rejects(acceptManagerChange(stateOf(), frame, wrongBase));
});

test('A10 快照：来源不明的 term+1 暂存等变更，超时/已拒变更/term 跳变 → 冻结', () => {
  const frame = snapshotOf({ manager: SEAT_C, from: SEAT_C });
  const pending = acceptManagerChange(stateOf(), frame, snapshotCtx());
  rejects(pending, 'snapshot-awaiting-change');
  assert.equal(pending.pendingCatchup, true);
  assert.equal(acceptManagerChange(stateOf(), frame, snapshotCtx({ pendingCatchupExpired: true })).freezeReason, 'manager-fork');
  assert.equal(acceptManagerChange(stateOf(), frame, snapshotCtx({ rejectedChangeFrom: SEAT_C })).freezeReason, 'manager-fork');
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
  rejects(acceptManagerChange(state, frame, snapshotCtx({ localFrozen: 'manager-pending' })), 'frozen-manager-pending');
});

test('A11/A12：同 term 快照校验签发者、保留本地窗口、窗口冲突冻结', () => {
  const localWindow = { windowBaseTerm: 1, windowEndsAt: iso(NOW + 30000) };
  const state = stateOf({ window: localWindow });
  const updated = acceptManagerChange(state, snapshotOf({ term: 1, version: 11, manager: SEAT_A, from: SEAT_A }), snapshotCtx());
  accepts(updated);
  assert.equal(updated.nextState.version, 11);
  assert.deepEqual(updated.nextState.managerWindow, localWindow);
  const conflicting = snapshotOf({ term: 1, version: 11, manager: SEAT_A, from: SEAT_A, window: { windowBaseTerm: 1, windowEndsAt: iso(NOW + 120000) } });
  assert.equal(acceptManagerChange(state, conflicting, snapshotCtx()).freezeReason, 'manager-fork');
  const inactive = acceptManagerChange(state, snapshotOf({ term: 1, version: 11, manager: SEAT_A, from: SEAT_A }), snapshotCtx({ localFrozen: 'manager-fork' }));
  rejects(inactive, 'frozen-manager-fork');
  rejects(acceptManagerChange(state, snapshotOf({ term: 1, version: 11, manager: SEAT_A, from: SEAT_C }), snapshotCtx()), 'snapshot-source-not-manager');
  const fork = acceptManagerChange(stateOf(), snapshotOf({ term: 1, version: 11, manager: SEAT_B }), snapshotCtx());
  assert.equal(fork.freezeReason, 'manager-fork');
});

test('A11：本地无窗口时快照窗口不被采纳，防止重开已关窗口', () => {
  const frame = snapshotOf({ term: 1, version: 11, manager: SEAT_A, from: SEAT_A, window: { windowBaseTerm: 1, windowEndsAt: iso(NOW + 120000) } });
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
