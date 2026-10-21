import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideAdmission, frozenWriteRefusalOf, managerFreezeReasonOf } from '../src/collab/gate.js';
import { INVITE_THROTTLE_TABLE_MAX, MAX_PENDING_INVITES } from '../src/collab/model.js';

/* 准入门 join 家族的单元用例：直调 decideAdmission，state 用最小夹具。
 * 为什么直调而不是经服务：本族的两条次序语义（回执帧先于未知 collabId 判定、申请帧三查后落既有
 * 状态门）只在这一层可判；且申请台账与待批准名单的注入面（state.joinApplications /
 * state.pendingJoinsOf）由组合根提供——本文件把它摆出来当入参契约（字段名与形状即接线约定）。
 * 帧形态（sessionId / reqMsgId 过标识白名单、协作域必携 collabId）已由协议层用例覆盖，此处不重验。 */

const SELF_ID = 'inst-self';
const REQUEST_MSG_ID = 'msg-join-request';
const TTL_MS = 60 * 1000;

function quietLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

/* 门判定面触及的计数（生产侧由服务计数器提供）：本族两支＋既有链路在本文件可触发的几支。 */
function makeCounters() {
  return {
    invitesRejected: 0,
    joinRequestsRejected: 0,
    joinDecisionsRejected: 0,
    unknownCollab: 0,
    rejectedFrozen: 0,
    forumTypeRejected: 0,
  };
}

/* 本机为站长的在册协作：门只读状态与模式两处（manager 记录取台账、成员态非 left）。 */
function localManagerOf(collabId, { status = 'active', mode = 'managed' } = {}) {
  return {
    collabId,
    role: 'manager',
    ledger: { status, mode },
    member: { state: 'active' },
  };
}

function makeState(overrides = {}) {
  return {
    self: { instanceId: SELF_ID, identityName: '本机' },
    log: quietLog(),
    counters: makeCounters(),
    collabs: new Map(),
    inviteWindow: new Map(),
    inviteMinIntervalMs: 60 * 1000,
    joinRequestWindow: new Map(),
    joinRequestTtlMs: TTL_MS,
    joinApplications: { list: () => [] },
    pendingJoinsOf: () => [],
    ...overrides,
  };
}

function frameOf(type, { msgId, collabId, from, payload }) {
  return {
    v: 1,
    type,
    msgId,
    collabId,
    from: { instanceId: from, identityName: '主机甲' },
    payload,
  };
}

function joinRequestOf({ collabId = 'collab-a', from = 'inst-a', msgId = REQUEST_MSG_ID, sessionId = 'session-a' } = {}) {
  return frameOf('join-request', { msgId, collabId, from, payload: { sessionId } });
}

function joinDecisionOf(type, { collabId = 'collab-a', from = 'inst-a', msgId = `${type}-reply`, reqMsgId = REQUEST_MSG_ID, reason } = {}) {
  const payload = reason === undefined ? { reqMsgId } : { reqMsgId, reason };
  return frameOf(type, { msgId, collabId, from, payload });
}

/* 受邀帧（仅本文件的「窗口表独立」用例用）：来源在名单内、本机在名单内、形态齐备。 */
function inviteOf({ collabId = 'collab-inv', from = 'inst-b', msgId = 'msg-invite' } = {}) {
  return frameOf('invite', {
    msgId,
    collabId,
    from,
    payload: {
      name: '联调项目',
      topic: '发布联调',
      members: [{ instanceId: from, identityName: '主机乙' }, { instanceId: SELF_ID, identityName: '本机' }],
    },
  });
}

/* 本机申请台账条目（形态沿加入台账：时间戳为毫秒整数）。 */
function applicationOf({ collabId = 'collab-a', managerInstanceId = 'inst-a', msgId = REQUEST_MSG_ID, sessionId = 'session-a', sentAt = Date.now() } = {}) {
  return { collabId, sessionId, managerInstanceId, msgId, sentAt };
}

const SOURCE_A = { remoteAddress: '10.0.0.1' };

/* —— join-request：三查 —— */

test('join-request：同源限频拒（窗口表独立于邀请限频）', () => {
  const state = makeState({ collabs: new Map([['collab-a', localManagerOf('collab-a')]]) });
  const first = decideAdmission(state, joinRequestOf({ msgId: 'msg-r1' }), SOURCE_A);
  assert.equal(first.ok, true);
  const second = decideAdmission(state, joinRequestOf({ msgId: 'msg-r2' }), SOURCE_A);
  assert.equal(second.ok, false);
  assert.ok(second.reason.includes('频繁'), second.reason);
  assert.equal(state.counters.joinRequestsRejected, 1, '限频拒计本族计数');
  const other = decideAdmission(state, joinRequestOf({ msgId: 'msg-r3' }), { remoteAddress: '10.0.0.2' });
  assert.equal(other.ok, true, '限频按来源记账，不牵连其他来源');

  /* 独立性两支：邀请记账不挤占申请额度，申请记账也不挤占邀请额度。 */
  const shared = { remoteAddress: '10.0.0.4' };
  assert.equal(decideAdmission(state, inviteOf({ from: 'inst-b' }), shared).ok, true, '来源首邀受理');
  assert.equal(decideAdmission(state, joinRequestOf({ msgId: 'msg-r4' }), shared).ok, true, '邀请已占该来源额度，申请窗口仍独立');
  const sharedTwo = { remoteAddress: '10.0.0.5' };
  assert.equal(decideAdmission(state, joinRequestOf({ msgId: 'msg-r5' }), sharedTwo).ok, true, '来源首发申请受理');
  assert.equal(decideAdmission(state, inviteOf({ from: 'inst-c', msgId: 'msg-inv-2' }), sharedTwo).ok, true, '申请已占该来源额度，邀请窗口仍独立');

  /* 限频表有界（沿邀请限频表容量先例）：表满丢最旧，不随伪造来源洪泛无限增长。 */
  for (let index = 0; index < INVITE_THROTTLE_TABLE_MAX + 1; index++) {
    decideAdmission(state, joinRequestOf({ msgId: `msg-b${index}` }), { remoteAddress: `10.1.0.${index}` });
  }
  assert.equal(state.joinRequestWindow.size, INVITE_THROTTLE_TABLE_MAX, '表满按容量收敛');
});

test('join-request：待批准上限拒（读该协作的待批准数）', () => {
  const fullId = 'collab-full';
  const roomyId = 'collab-roomy';
  const asked = [];
  const state = makeState({
    collabs: new Map([['collab-full', localManagerOf(fullId)], ['collab-roomy', localManagerOf(roomyId)]]),
    pendingJoinsOf: (collabId) => {
      asked.push(collabId);
      const size = collabId === 'collab-full' ? MAX_PENDING_INVITES : MAX_PENDING_INVITES - 1;
      return Array.from({ length: size }, (_, index) => ({ instanceId: 'inst-x', sessionId: `session-${index}`, requestedAt: Date.now() }));
    },
  });
  const rejected = decideAdmission(state, joinRequestOf({ collabId: fullId }), SOURCE_A);
  assert.equal(rejected.ok, false);
  assert.ok(rejected.reason.includes(`上限（${MAX_PENDING_INVITES}）`), rejected.reason);
  assert.equal(state.counters.joinRequestsRejected, 1);
  assert.deepEqual(asked, [fullId], '按申请所属协作取待批准数');
  const roomy = decideAdmission(state, joinRequestOf({ collabId: roomyId, msgId: 'msg-r2' }), { remoteAddress: '10.0.0.2' });
  assert.equal(roomy.ok, true, '未及上限照常受理');
  assert.deepEqual(asked, [fullId, roomyId]);
});

test('join-request：自邀拒（from 为本机实例）——本机对本站长协作的申请走待批准面，不经网络帧', () => {
  const state = makeState({ collabs: new Map([['collab-a', localManagerOf('collab-a')]]) });
  const rejected = decideAdmission(state, joinRequestOf({ from: SELF_ID }), SOURCE_A);
  assert.equal(rejected.ok, false);
  assert.ok(rejected.reason.includes('自邀'), rejected.reason);
  assert.equal(state.counters.joinRequestsRejected, 1);
  assert.equal(state.joinRequestWindow.size, 0, '自邀拒不留限频记账');
});

test('join-request：三查通过后落入既有状态门（活跃受理；冻结 / 讨论 / 未知 collab 自然拒）', () => {
  const state = makeState({
    collabs: new Map([
      ['collab-live', localManagerOf('collab-live')],
      ['collab-frozen', localManagerOf('collab-frozen', { status: 'frozen' })],
      ['collab-forum', localManagerOf('collab-forum', { mode: 'forum' })],
    ]),
  });
  const live = decideAdmission(state, joinRequestOf({ collabId: 'collab-live' }), { remoteAddress: '10.0.0.1' });
  assert.equal(live.ok, true, '活跃协作：申请过三查即受理（批准与接线归加入域）');
  const frozen = decideAdmission(state, joinRequestOf({ collabId: 'collab-frozen' }), { remoteAddress: '10.0.0.2' });
  assert.equal(frozen.ok, false);
  assert.ok(frozen.reason.includes('冻结'), frozen.reason);
  const forum = decideAdmission(state, joinRequestOf({ collabId: 'collab-forum' }), { remoteAddress: '10.0.0.3' });
  assert.equal(forum.ok, false);
  assert.equal(state.counters.forumTypeRejected, 1, '讨论实例按类型语义拒（无批准门）');
  const unknown = decideAdmission(state, joinRequestOf({ collabId: 'collab-absent' }), { remoteAddress: '10.0.0.4' });
  assert.equal(unknown.ok, false);
  assert.equal(state.counters.unknownCollab, 1, '未知 collabId 照旧落既有判定');
  const nonFamily = decideAdmission(state, frameOf('reply', { msgId: 'msg-reply', collabId: 'collab-live', from: 'inst-a', payload: { text: '好' } }), { remoteAddress: '10.0.0.5' });
  assert.equal(nonFamily.ok, true, '非本族帧直落既有链路（本族专支不拦）');
  assert.equal(state.counters.joinRequestsRejected, 0, '落既有链路拒的不计本族计数');
});

/* —— join-grant / join-deny：比对申请台账 —— */

test('join-grant：无申请记录拒——分支先于未知 collabId 判定（发起机尚无该协作）', () => {
  const state = makeState({ joinApplications: { list: () => [applicationOf({ collabId: 'collab-other' })] } });
  const rejected = decideAdmission(state, joinDecisionOf('join-grant'), SOURCE_A);
  assert.equal(rejected.ok, false);
  assert.ok(rejected.reason.includes('不匹配'), rejected.reason);
  assert.equal(state.counters.joinDecisionsRejected, 1);
  assert.equal(state.counters.unknownCollab, 0, '回执帧不落未知 collab 判定');
});

test('join-grant：申请记录已过期拒（时效与台账剪除同一基准）', () => {
  const state = makeState({ joinApplications: { list: () => [applicationOf({ sentAt: Date.now() - TTL_MS })] } });
  const rejected = decideAdmission(state, joinDecisionOf('join-grant'), SOURCE_A);
  assert.equal(rejected.ok, false);
  assert.ok(rejected.reason.includes('过期'), rejected.reason);
  assert.equal(state.counters.joinDecisionsRejected, 1);
});

test('join-grant：collabId / 站长实例 / 申请帧标识任一不符即拒', () => {
  const cases = [
    { name: '站长实例不符（冒名回执）', frame: joinDecisionOf('join-grant', { from: 'inst-impostor' }) },
    { name: '申请帧标识不符', frame: joinDecisionOf('join-grant', { reqMsgId: 'msg-other' }) },
    { name: 'collabId 不符', frame: joinDecisionOf('join-grant', { collabId: 'collab-other' }) },
  ];
  for (const { name, frame } of cases) {
    const state = makeState({ joinApplications: { list: () => [applicationOf()] } });
    const rejected = decideAdmission(state, frame, SOURCE_A);
    assert.equal(rejected.ok, false, name);
    assert.equal(state.counters.joinDecisionsRejected, 1, name);
  }
});

test('join-grant：三项全符且未过期即受理——本机尚无该协作亦可（回执先于入席）', () => {
  const state = makeState({ joinApplications: { list: () => [applicationOf()] } });
  const admitted = decideAdmission(state, joinDecisionOf('join-grant'), SOURCE_A);
  assert.equal(admitted.ok, true);
  assert.equal(state.counters.joinDecisionsRejected, 0);
  assert.equal(state.counters.unknownCollab, 0);
  const fresh = makeState({ joinApplications: { list: () => [applicationOf({ sentAt: Date.now() - TTL_MS + 1000 })] } });
  assert.equal(decideAdmission(fresh, joinDecisionOf('join-grant'), SOURCE_A).ok, true, '差未满时限即未过期');
});

test('join-deny：同款比对——无记录拒、过期拒、匹配受理（携 reason 不影响判定）', () => {
  const noRecord = makeState();
  const miss = decideAdmission(noRecord, joinDecisionOf('join-deny'), SOURCE_A);
  assert.equal(miss.ok, false);
  assert.equal(noRecord.counters.joinDecisionsRejected, 1);
  assert.equal(noRecord.counters.unknownCollab, 0, '拒绝也走本族分支');
  const expiredState = makeState({ joinApplications: { list: () => [applicationOf({ sentAt: Date.now() - TTL_MS - 1 })] } });
  const expired = decideAdmission(expiredState, joinDecisionOf('join-deny', { reason: '暂不接纳' }), SOURCE_A);
  assert.equal(expired.ok, false);
  assert.ok(expired.reason.includes('过期'), expired.reason);
  const matchedState = makeState({ joinApplications: { list: () => [applicationOf()] } });
  const matched = decideAdmission(matchedState, joinDecisionOf('join-deny', { reason: '暂不接纳' }), SOURCE_A);
  assert.equal(matched.ok, true);
  assert.equal(matchedState.counters.joinDecisionsRejected, 0);
});

/* —— 邀请目标（设计 §2.2 D13）：targets 是目标机器的准入依据 —— */

function inviteFrameOf({ targets, members, from = 'inst-b' }) {
  return frameOf('invite', {
    msgId: `msg-invite-${Math.random()}`,
    collabId: 'collab-inv',
    from,
    payload: { name: '联调项目', topic: '发布联调', members, ...(targets === undefined ? {} : { targets }) },
  });
}

const SENDER_ONLY = [{ instanceId: 'inst-b', identityName: '主机乙' }];
const WITH_SELF = [...SENDER_ONLY, { instanceId: SELF_ID, identityName: '本机' }];

test('invite：members 只含发起人时按 targets 准入目标机', () => {
  const state = makeState();
  const admitted = decideAdmission(state, inviteFrameOf({ targets: [{ instanceId: SELF_ID }], members: SENDER_ONLY }), SOURCE_A);
  assert.equal(admitted.ok, true, admitted.reason);
  assert.equal(state.counters.invitesRejected, 0);
});

test('invite：无 targets 的旧版邀请退回「名单含本机」兼容判据', () => {
  const admitted = decideAdmission(makeState(), inviteFrameOf({ members: WITH_SELF }), SOURCE_A);
  assert.equal(admitted.ok, true, admitted.reason);
  const absent = decideAdmission(makeState(), inviteFrameOf({ members: SENDER_ONLY }), { remoteAddress: '10.0.0.9' });
  assert.equal(absent.ok, false, '旧版名单不含本机即拒');
});

test('invite：targets 不含本机即拒——目标机器是唯一判据，名单含本机也不放行', () => {
  const state = makeState();
  const rejected = decideAdmission(state, inviteFrameOf({ targets: [{ instanceId: 'inst-other' }], members: WITH_SELF }), SOURCE_A);
  assert.equal(rejected.ok, false);
  assert.ok(rejected.reason.includes('目标'), rejected.reason);
  assert.equal(state.counters.invitesRejected, 1);
});

/* —— 冻结写门（设计 §1.3/§6.4）：任期冻结三态与共享态冻结同权 —— */

function contentFrameOf(collabId = 'collab-a') {
  return frameOf('issue', { msgId: 'msg-issue', collabId, from: 'inst-peer', payload: { text: '进度' } });
}

function frozenManagerState(reason) {
  return makeState({
    collabs: new Map([['collab-a', localManagerOf('collab-a')]]),
    m5Runtime: { frozen: new Map([['collab-a', reason]]) },
  });
}

test('冻结写门：manager-fork / manager-pending / manager-offline 期间写拒绝，解冻后恢复', () => {
  for (const reason of ['manager-fork', 'manager-pending', 'manager-offline']) {
    const state = frozenManagerState(reason);
    assert.equal(managerFreezeReasonOf(state, 'collab-a'), reason);
    assert.ok(frozenWriteRefusalOf(state, 'collab-a').includes('冻结'));
    const rejected = decideAdmission(state, contentFrameOf(), SOURCE_A);
    assert.equal(rejected.ok, false, reason);
    assert.ok(rejected.reason.includes('冻结'), rejected.reason);
    assert.equal(state.counters.rejectedFrozen, 1, reason);
    state.m5Runtime.frozen.delete('collab-a');
    assert.equal(managerFreezeReasonOf(state, 'collab-a'), null);
    assert.equal(frozenWriteRefusalOf(state, 'collab-a'), null);
    assert.equal(decideAdmission(state, contentFrameOf(), SOURCE_A).ok, true, `${reason} 解冻后恢复写`);
  }
});

test('冻结写门：收敛与退场帧仍放行（快照 / 接管 / 通告 / 离席 / 结束）', () => {
  const state = frozenManagerState('manager-pending');
  for (const type of ['snapshot', 'takeover', 'takeover-init', 'notice', 'leave', 'end']) {
    assert.equal(decideAdmission(state, frameOf(type, { msgId: `msg-${type}`, collabId: 'collab-a', from: 'inst-peer', payload: {} }), SOURCE_A).ok, true, type);
  }
});

test('冻结写门：运行态缺失时以持久化 freezeReason 兜底，杂散值不停写，归档后冻结不成立', () => {
  const local = localManagerOf('collab-a');
  local.freezeReason = 'manager-fork';
  const state = makeState({ collabs: new Map([['collab-a', local]]), m5Runtime: { frozen: new Map() } });
  assert.equal(managerFreezeReasonOf(state, 'collab-a'), 'manager-fork');
  local.freezeReason = 'arbitrary';
  assert.equal(managerFreezeReasonOf(state, 'collab-a'), null, '只认三态词表');
  local.freezeReason = 'manager-offline';
  local.ledger.status = 'terminated';
  assert.equal(managerFreezeReasonOf(state, 'collab-a'), null, '终态优先于冻结');
});
