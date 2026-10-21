import { test } from 'node:test';
import assert from 'node:assert/strict';
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
  const frame = { kind: 'data', managerTerm: term, version, digest: DIGEST, ledger, from: { ...from } };
  if (window !== undefined) {
    ledger.managerWindow = window;
    frame.managerWindow = window;
  }
  return frame;
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
  const byPrev = acceptManagerChange(stateOf(), changeOf({ prevManager: SEAT_C }), { now: NOW });
  rejects(byPrev);
  assert.equal(byPrev.freezeReason, 'manager-fork');
});

test('A1 handover：缺 offerId / digest / endpoint 或 version 不更新 → 拒收计数、不冻结', () => {
  const noOffer = changeOf();
  delete noOffer.offerId;
  const noEndpoint = changeOf();
  delete noEndpoint.endpoint;
  const cases = [noOffer, changeOf({ digest: '' }), noEndpoint, changeOf({ version: 10 })];
  for (const frame of cases) {
    const result = acceptManagerChange(stateOf(), frame, { now: NOW });
    rejects(result);
    assert.equal(result.freezeReason, undefined);
    assert.ok(result.actions.includes('count-reject'));
    assert.equal(result.nextState.manager.sessionId, SEAT_A.sessionId);
  }
});

test('A2 auto：来源新站长且匹配 auto-offer → 受理并写入窗口', () => {
  const frame = changeOf({
    via: 'auto',
    from: SEAT_B,
    offerId: 'offer-auto',
    windowEndsAt: iso(NOW + 60000),
  });
  const result = acceptManagerChange(stateOf(), frame, { now: NOW, autoOffers: [autoOfferOf()] });
  accepts(result);
  assert.equal(result.nextState.manager.sessionId, SEAT_B.sessionId);
  assert.deepEqual(result.nextState.managerWindow, {
    windowBaseTerm: 2,
    windowEndsAt: iso(NOW + 60000),
  });
  assert.equal(managerWindowRemaining(result.nextState.managerWindow, NOW), 60000);
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
  assert.ok(result.actions.includes('count-reject'));
});

test('A2 auto：offerId / target / prevManager / baseTerm 不匹配均拒收', () => {
  const frame = changeOf({
    via: 'auto',
    from: SEAT_B,
    offerId: 'offer-auto',
    windowEndsAt: iso(NOW + 60000),
  });
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
  const frame = changeOf({
    via: 'auto',
    from: SEAT_C,
    offerId: 'offer-auto',
    windowEndsAt: iso(NOW + 60000),
  });
  const result = acceptManagerChange(stateOf(), frame, { now: NOW, autoOffers: [autoOfferOf()] });
  rejects(result);
  assert.equal(result.freezeReason, 'manager-fork');
});

test('A2 auto：迟到 130s 到达 → 受理但窗口剩余为 0，不重开', () => {
  const frame = changeOf({
    via: 'auto',
    from: SEAT_B,
    offerId: 'offer-auto',
    effectiveAt: iso(NOW - 130000),
    windowEndsAt: iso(NOW - 70000),
  });
  const result = acceptManagerChange(stateOf(), frame, { now: NOW, autoOffers: [autoOfferOf()] });
  accepts(result);
  assert.equal(managerWindowRemaining(result.nextState.managerWindow, NOW), 0);
});

test('A3 takeover：窗口内授权 → 受理、关窗、不开新窗', () => {
  const state = stateOf({
    term: 2,
    version: 11,
    manager: SEAT_B,
    window: { windowBaseTerm: 2, windowEndsAt: iso(NOW + 30000) },
  });
  const frame = changeOf({
    term: 3,
    version: 12,
    manager: SEAT_C,
    via: 'takeover',
    prevManager: SEAT_B,
    from: SEAT_C,
    offerId: undefined,
    windowBaseTerm: 2,
    authorizedAt: iso(NOW - 1000),
  });
  const result = acceptManagerChange(state, frame, { now: NOW, memberSeats: [SEAT_C] });
  accepts(result);
  assert.equal(result.nextState.manager.sessionId, SEAT_C.sessionId);
  assert.equal(result.nextState.managerWindow, undefined);
  assert.ok(result.actions.includes('close-window'));
});

test('A3 takeover：本地窗口已过但 authorizedAt 在窗口内 → 仍受理（授权与传播分离）', () => {
  const state = stateOf({
    term: 2,
    version: 11,
    manager: SEAT_B,
    window: { windowBaseTerm: 2, windowEndsAt: iso(NOW - 10000) },
  });
  const frame = changeOf({
    term: 3,
    version: 12,
    manager: SEAT_C,
    via: 'takeover',
    prevManager: SEAT_B,
    from: SEAT_C,
    offerId: undefined,
    windowBaseTerm: 2,
    authorizedAt: iso(NOW - 20000),
  });
  accepts(acceptManagerChange(state, frame, { now: NOW + 60000, memberSeats: [SEAT_C] }));
});

test('A3 takeover：窗口外且非窗口内授权 → 拒收计数', () => {
  const state = stateOf({
    term: 2,
    version: 11,
    manager: SEAT_B,
    window: { windowBaseTerm: 2, windowEndsAt: iso(NOW - 10000) },
  });
  const frame = changeOf({
    term: 3,
    version: 12,
    manager: SEAT_C,
    via: 'takeover',
    prevManager: SEAT_B,
    from: SEAT_C,
    offerId: undefined,
    windowBaseTerm: 2,
    authorizedAt: iso(NOW + 5000),
  });
  rejects(acceptManagerChange(state, frame, { now: NOW, memberSeats: [SEAT_C] }), 'window-closed');
});

test('A3 takeover：本地无窗口基准或 windowBaseTerm 不符 → 拒收并请求快照', () => {
  const frame = changeOf({
    term: 3,
    version: 12,
    manager: SEAT_C,
    via: 'takeover',
    prevManager: SEAT_B,
    from: SEAT_C,
    offerId: undefined,
    windowBaseTerm: 2,
    authorizedAt: iso(NOW),
  });
  const noWindow = acceptManagerChange(stateOf({ term: 2, version: 11, manager: SEAT_B }), frame, { now: NOW, memberSeats: [SEAT_C] });
  rejects(noWindow, 'window-missing');
  assert.ok(noWindow.actions.includes('request-snapshot'));
  const state = stateOf({
    term: 2,
    version: 11,
    manager: SEAT_B,
    window: { windowBaseTerm: 2, windowEndsAt: iso(NOW + 30000) },
  });
  rejects(acceptManagerChange(state, { ...frame, windowBaseTerm: 1 }, { now: NOW, memberSeats: [SEAT_C] }), 'window-base-mismatch');
});

test('A4 takeover-manual：活跃态（未冻结）也受理，无窗口', () => {
  const state = stateOf({ term: 2, version: 11, manager: SEAT_B });
  const frame = changeOf({
    term: 3,
    version: 12,
    manager: SEAT_C,
    via: 'takeover-manual',
    prevManager: SEAT_B,
    from: SEAT_C,
    offerId: undefined,
    authorizedAt: iso(NOW),
  });
  const result = acceptManagerChange(state, frame, { now: NOW, memberSeats: [SEAT_C] });
  accepts(result);
  assert.equal(result.nextState.manager.sessionId, SEAT_C.sessionId);
  assert.equal(result.nextState.managerWindow, undefined);
  assert.equal(result.actions.includes('clear-freeze'), false);
});

test('A4 takeover-manual：解除 manager-offline 冻结但仍拒绝 fork / pending', () => {
  const frame = changeOf({
    term: 3,
    version: 12,
    manager: SEAT_C,
    via: 'takeover-manual',
    prevManager: SEAT_B,
    from: SEAT_C,
    offerId: undefined,
    authorizedAt: iso(NOW),
  });
  const state = stateOf({ term: 2, version: 11, manager: SEAT_B });
  const offline = acceptManagerChange(state, frame, { now: NOW, memberSeats: [SEAT_C], localFrozen: 'manager-offline' });
  accepts(offline);
  assert.ok(offline.actions.includes('clear-freeze'));
  const fork = acceptManagerChange(state, frame, { now: NOW, memberSeats: [SEAT_C], localFrozen: 'manager-fork' });
  rejects(fork, 'frozen-manager-fork');
  assert.equal(fork.freezeReason, undefined);
  const pending = acceptManagerChange(state, frame, { now: NOW, memberSeats: [SEAT_C], localFrozen: 'manager-pending' });
  rejects(pending, 'frozen-manager-pending');
});

test('A4 takeover-manual：未解决 auto 在途时拒收，offer 过期后放行', () => {
  const frame = changeOf({
    term: 3,
    version: 12,
    manager: SEAT_C,
    via: 'takeover-manual',
    prevManager: SEAT_B,
    from: SEAT_C,
    offerId: undefined,
    authorizedAt: iso(NOW),
  });
  const state = stateOf({ term: 2, version: 11, manager: SEAT_B });
  rejects(acceptManagerChange(state, frame, { now: NOW, memberSeats: [SEAT_C], autoInFlight: true }), 'auto-in-flight');
  rejects(acceptManagerChange(state, frame, { now: NOW, memberSeats: [SEAT_C], autoOffers: [autoOfferOf()] }), 'auto-in-flight');
  const expired = autoOfferOf({ expiresAt: iso(NOW - 1) });
  accepts(acceptManagerChange(state, frame, { now: NOW, memberSeats: [SEAT_C], autoOffers: [expired] }));
});

test('A4 takeover-manual：站长仍可达、来源非成员或 prevManager 不符', () => {
  const frame = changeOf({
    term: 3,
    version: 12,
    manager: SEAT_C,
    via: 'takeover-manual',
    prevManager: SEAT_B,
    from: SEAT_C,
    offerId: undefined,
    authorizedAt: iso(NOW),
  });
  const state = stateOf({ term: 2, version: 11, manager: SEAT_B });
  rejects(acceptManagerChange(state, frame, { now: NOW, memberSeats: [SEAT_C], managerReachable: true }), 'manager-reachable');
  rejects(acceptManagerChange(state, frame, { now: NOW, memberSeats: [SEAT_B] }), 'source-not-member');
  const byPrev = acceptManagerChange(state, { ...frame, prevManager: seatRef(SEAT_A) }, { now: NOW, memberSeats: [SEAT_C] });
  rejects(byPrev);
  assert.equal(byPrev.freezeReason, 'manager-fork');
});

test('A5：term+1 但缺 authorizedAt / offer 前提不成立 → 拒收计数、不冻结', () => {
  const takeover = changeOf({
    term: 2,
    version: 11,
    via: 'takeover',
    prevManager: SEAT_A,
    from: SEAT_B,
    offerId: undefined,
    windowBaseTerm: 1,
    authorizedAt: undefined,
  });
  const state = stateOf({ window: { windowBaseTerm: 1, windowEndsAt: iso(NOW + 30000) } });
  const result = acceptManagerChange(state, takeover, { now: NOW, memberSeats: [SEAT_B] });
  rejects(result);
  assert.equal(result.freezeReason, undefined);
  assert.ok(result.actions.includes('count-reject'));
});

test('冻结态门控：manager-fork 拒收 term+1 单一变更，manager-pending 只放行 auto 签发帧', () => {
  const fork = acceptManagerChange(stateOf(), changeOf(), { now: NOW, localFrozen: 'manager-fork' });
  rejects(fork, 'frozen-manager-fork');
  assert.equal(fork.nextState.manager.sessionId, SEAT_A.sessionId);
  const pendingHandover = acceptManagerChange(stateOf(), changeOf(), { now: NOW, localFrozen: 'manager-pending' });
  rejects(pendingHandover, 'frozen-manager-pending');
  const autoFrame = changeOf({ via: 'auto', from: SEAT_B, offerId: 'offer-auto', windowEndsAt: iso(NOW + 60000) });
  const autoResult = acceptManagerChange(stateOf(), autoFrame, {
    now: NOW,
    localFrozen: 'manager-pending',
    autoOffers: [autoOfferOf()],
  });
  accepts(autoResult);
  assert.ok(autoResult.actions.includes('clear-freeze'));
});

test('A5：非成员来源冻结分叉，缺来源只拒收计数', () => {
  const state = stateOf({ term: 2, version: 11, manager: SEAT_B });
  const takeover = changeOf({
    term: 3,
    version: 12,
    manager: SEAT_C,
    via: 'takeover',
    prevManager: SEAT_B,
    from: SEAT_C,
    offerId: undefined,
    windowBaseTerm: 2,
    authorizedAt: iso(NOW),
  });
  const nonMember = acceptManagerChange(state, takeover, { now: NOW, memberSeats: [SEAT_B] });
  rejects(nonMember);
  assert.equal(nonMember.freezeReason, 'manager-fork');
  const noFrom = changeOf();
  delete noFrom.from;
  const missing = acceptManagerChange(stateOf(), noFrom, { now: NOW });
  rejects(missing, 'source-missing');
  assert.equal(missing.freezeReason, undefined);
});

test('A6：term 跳跃 → 需握手对表；超时不能同步 → 冻结节', () => {
  const frame = changeOf({ term: 3, version: 12, manager: SEAT_C, from: SEAT_C, offerId: undefined });
  const gap = acceptManagerChange(stateOf(), frame, { now: NOW });
  rejects(gap, 'term-gap');
  assert.equal(gap.needsSync, true);
  assert.ok(gap.actions.includes('handshake'));
  assert.ok(gap.actions.includes('request-snapshot'));
  const expired = acceptManagerChange(stateOf(), frame, { now: NOW, syncExpired: true });
  rejects(expired);
  assert.equal(expired.freezeReason, 'manager-fork');
});

test('A7/A8/A9：同 term 幂等、同 term 不同 manager 分叉、低 term 拒收', () => {
  const idempotent = acceptManagerChange(stateOf(), changeOf({ term: 1, manager: SEAT_A, version: 12, from: SEAT_A }), { now: NOW });
  rejects(idempotent, 'idempotent');
  assert.equal(idempotent.idempotent, true);
  assert.deepEqual(idempotent.actions, ['ack', 'request-snapshot']);
  assert.equal(idempotent.nextState.managerTerm, 1);
  const sameVersion = acceptManagerChange(stateOf(), changeOf({ term: 1, manager: SEAT_A, version: 10, from: SEAT_A }), { now: NOW });
  assert.deepEqual(sameVersion.actions, ['ack']);
  const fork = acceptManagerChange(stateOf(), changeOf({ term: 1, manager: SEAT_B, version: 12 }), { now: NOW });
  rejects(fork);
  assert.equal(fork.freezeReason, 'manager-fork');
  const behind = acceptManagerChange(stateOf({ term: 2, version: 12 }), changeOf({ term: 1, manager: SEAT_B }), { now: NOW });
  rejects(behind, 'term-behind');
  assert.ok(behind.actions.includes('count-reject'));
});

test('A10 快照：来源＝本地现任站长 → 受理更高 term', () => {
  const result = acceptManagerChange(stateOf(), snapshotOf({ from: SEAT_A }), { now: NOW });
  accepts(result);
  assert.equal(result.nextState.managerTerm, 2);
  assert.equal(result.nextState.manager.sessionId, SEAT_B.sessionId);
  assert.equal(result.nextState.version, 11);
});

test('A10 快照：handover-pending 时新站长的快照可受理', () => {
  const result = acceptManagerChange(stateOf(), snapshotOf(), { now: NOW, suspended: 'handover-pending' });
  accepts(result);
});

test('A10 快照：离线 auto 追赶需 offer＋auto change＋旧站长 leave 三证据齐备', () => {
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
  const accepted = acceptManagerChange(stateOf(), frame, { now: NOW, autoCatchup: catchup });
  accepts(accepted);
  const missingLeave = { ...catchup, leave: undefined };
  const pending = acceptManagerChange(stateOf(), frame, { now: NOW, autoCatchup: missingLeave });
  rejects(pending);
  assert.equal(pending.pendingCatchup, true);
  const wrongReason = { ...catchup, leave: { ...catchup.leave, reason: 'left' } };
  rejects(acceptManagerChange(stateOf(), frame, { now: NOW, autoCatchup: wrongReason }));
});

test('A10 快照：活跃态来源不明的 term+1 快照暂存等变更，超时或已拒变更同源 → 冻结', () => {
  const frame = snapshotOf({ manager: SEAT_C, from: SEAT_C });
  const pending = acceptManagerChange(stateOf(), frame, { now: NOW });
  rejects(pending, 'snapshot-awaiting-change');
  assert.equal(pending.pendingCatchup, true);
  assert.ok(pending.actions.includes('store-pending-catchup'));
  const expired = acceptManagerChange(stateOf(), frame, { now: NOW, pendingCatchupExpired: true });
  rejects(expired);
  assert.equal(expired.freezeReason, 'manager-fork');
  const rejectedSource = acceptManagerChange(stateOf(), frame, { now: NOW, rejectedChangeFrom: SEAT_C });
  rejects(rejectedSource);
  assert.equal(rejectedSource.freezeReason, 'manager-fork');
  const farAhead = snapshotOf({ term: 4, manager: SEAT_C, from: SEAT_C });
  const frozen = acceptManagerChange(stateOf(), farAhead, { now: NOW });
  rejects(frozen);
  assert.equal(frozen.freezeReason, 'manager-fork');
});

test('A10 快照：冻结 manager-offline 只受理与握手最高 pair 一致的 catch-up', () => {
  const state = stateOf({ term: 2, version: 12, manager: SEAT_B });
  const frame = snapshotOf({ term: 3, version: 14, manager: SEAT_C, from: SEAT_A });
  const highest = { term: 3, version: 14, manager: seatRef(SEAT_C) };
  const accepted = acceptManagerChange(state, frame, {
    now: NOW,
    localFrozen: 'manager-offline',
    handshakeHighest: highest,
  });
  accepts(accepted);
  assert.ok(accepted.actions.includes('clear-freeze'));
  const mismatch = acceptManagerChange(state, frame, {
    now: NOW,
    localFrozen: 'manager-offline',
    handshakeHighest: { ...highest, version: 13 },
  });
  rejects(mismatch);
  assert.equal(mismatch.freezeReason, 'manager-fork');
});

test('A10 快照：manager-fork 只接受更高 term 的授权接管证据，manager-pending 只读', () => {
  const state = stateOf({ term: 2, version: 12, manager: SEAT_B });
  const frame = snapshotOf({ term: 3, version: 14, manager: SEAT_C, from: SEAT_A });
  const blocked = acceptManagerChange(state, frame, { now: NOW, localFrozen: 'manager-fork' });
  rejects(blocked, 'frozen-manager-fork');
  assert.equal(blocked.freezeReason, undefined);
  const authorized = acceptManagerChange(state, frame, {
    now: NOW,
    localFrozen: 'manager-fork',
    authorizedEvidence: { via: 'takeover-manual', authorizedAt: iso(NOW - 1000) },
  });
  accepts(authorized);
  rejects(
    acceptManagerChange(state, frame, { now: NOW, localFrozen: 'manager-pending' }),
    'frozen-manager-pending',
  );
});

test('A11/A12/A13/A14：同 term 快照的版本、分叉与幂等', () => {
  const updated = acceptManagerChange(stateOf(), snapshotOf({ term: 1, version: 11, manager: SEAT_A, from: SEAT_A }), { now: NOW });
  accepts(updated);
  assert.equal(updated.nextState.managerTerm, 1);
  assert.equal(updated.nextState.version, 11);
  const fork = acceptManagerChange(stateOf(), snapshotOf({ term: 1, version: 11, manager: SEAT_B }), { now: NOW });
  rejects(fork);
  assert.equal(fork.freezeReason, 'manager-fork');
  const same = acceptManagerChange(stateOf(), snapshotOf({ term: 1, version: 10, manager: SEAT_A, from: SEAT_A }), { now: NOW });
  rejects(same, 'snapshot-idempotent');
  assert.equal(same.idempotent, true);
  assert.deepEqual(same.actions, ['ack-snapshot-stored']);
  const behind = acceptManagerChange(stateOf({ term: 2, version: 12 }), snapshotOf({ term: 1, version: 9, manager: SEAT_A, from: SEAT_A }), { now: NOW });
  rejects(behind, 'term-behind');
});

test('compareSnapshot：按 (managerTerm,version) 排序，同 term 不同 manager 报冲突', () => {
  const a = { managerTerm: 1, version: 10, manager: seatRef(SEAT_A) };
  const b = { managerTerm: 2, version: 11, manager: seatRef(SEAT_B) };
  assert.equal(compareSnapshot(a, b).order, -1);
  assert.equal(compareSnapshot(b, a).order, 1);
  assert.equal(compareSnapshot({ ...a, version: 9 }, a).order, -1);
  const conflict = compareSnapshot(a, { ...a, manager: seatRef(SEAT_B) });
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.order, 0);
  assert.equal(compareSnapshot(a, { ...a }).idempotent, true);
  assert.equal(compareSnapshot(null, a).ok, false);
});

test('makeAutoOffer / matchesAutoOffer：形态、匹配与过期', () => {
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
  assert.equal(matchesAutoOffer({ ...offer, expiresAt: iso(NOW - 1) }, frame, NOW), false);
  assert.equal(makeAutoOffer({ offerId: 'x' }), null);
  assert.equal(makeAutoOffer({ ...offer, expiresAt: 'not-a-time' }), null);
});

test('managerWindow helper：写入不改原状态、清除、剩余计算', () => {
  const state = stateOf();
  const window = { windowBaseTerm: 2, windowEndsAt: iso(NOW + 5000) };
  const opened = setManagerWindow(state, window);
  assert.deepEqual(opened.managerWindow, window);
  assert.equal(state.managerWindow, undefined);
  assert.notEqual(opened, state);
  const cleared = clearManagerWindow(opened);
  assert.equal(cleared.managerWindow, undefined);
  assert.equal(opened.managerWindow.windowBaseTerm, 2);
  assert.notEqual(cleared, opened);
  assert.equal(managerWindowRemaining(window, NOW), 5000);
  assert.equal(managerWindowRemaining(window, NOW + 6000), 0);
  assert.equal(managerWindowRemaining(undefined, NOW), 0);
});

test('非法帧与终态：不抛异常、不改状态、不误冻结', () => {
  const state = stateOf();
  assert.doesNotThrow(() => acceptManagerChange(state, null, {}));
  rejects(acceptManagerChange(state, null, {}), 'frame-invalid');
  rejects(acceptManagerChange(state, { event: 'manager-changed' }, {}), 'frame-invalid');
  const terminal = stateOf({ manager: null });
  rejects(acceptManagerChange(terminal, changeOf({ prevManager: SEAT_A }), { now: NOW }), 'no-local-manager');
});
