import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ACTIVE_SEATS } from '../src/net/protocol.js';
import {
  ARCHIVED_STATES,
  COLLAB_STATES,
  MAX_FORUM_MEMBERS,
  canTransition,
  compareSnapshot,
  isArchived,
  isCollabState,
  isLedgerRosterShape,
  isLedgerShape,
  isMemberRecordShape,
  isSnapshotShape,
  newCollabId,
  withDefaultMode,
} from '../src/collab/model.js';

const AT = '2026-10-13T00:00:00.000Z';

function seat(overrides = {}) {
  return {
    instanceId: 'inst-a',
    sessionId: 'sess-a',
    identityName: '主机甲',
    role: 'member',
    state: 'member',
    joinSeq: 1,
    joinedAt: AT,
    ...overrides,
  };
}

function managerOf(overrides = {}) {
  return { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '主机甲', term: 1, ...overrides };
}

function sampleLedger(overrides = {}) {
  return {
    version: 1,
    collabId: 'collab-1',
    name: '联调项目',
    topic: '发布联调',
    status: 'proposed',
    managerTerm: 1,
    joinSeqNext: 2,
    manager: managerOf(),
    members: [
      seat({ role: 'manager' }),
      seat({ instanceId: 'inst-b', sessionId: 'sess-b', identityName: '主机乙', joinSeq: 2 }),
    ],
    board: [],
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function forumLedger(overrides = {}) {
  return {
    version: 1,
    collabId: 'collab-1',
    name: '讨论甲',
    topic: '议题',
    status: 'active',
    mode: 'forum',
    managerTerm: 1,
    members: [
      { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '主机甲', role: 'member', state: 'member', joinedAt: AT },
    ],
    board: [],
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function snapshotOf(term, version, instanceId = 'inst-a', sessionId = 'sess-a') {
  return { ledger: { managerTerm: term, version, manager: { instanceId, sessionId, identityName: '甲', term } } };
}

function sampleMember(overrides = {}) {
  return {
    collabId: 'collab-1',
    role: 'member',
    state: 'proposed',
    name: '联调项目',
    manager: { instanceId: 'inst-a', identityName: '主机甲' },
    roster: [
      { instanceId: 'inst-a', identityName: '主机甲' },
      { instanceId: 'inst-b', identityName: '主机乙' },
    ],
    endpoints: { 'inst-a': { address: '127.0.0.1', port: 17321 } },
    invitedAt: '2026-10-13T00:00:00.000Z',
    expiresAt: '2026-10-14T00:00:00.000Z',
    decision: null,
    ...overrides,
  };
}

test('状态迁移表：合法边通过、非法边拒绝（含 proposed→completed 与终态无出边）', () => {
  assert.equal(canTransition('proposed', 'active'), true);
  assert.equal(canTransition('proposed', 'frozen'), true);
  assert.equal(canTransition('proposed', 'terminated'), true);
  assert.equal(canTransition('proposed', 'completed'), true);
  assert.equal(canTransition('active', 'completed'), true);
  assert.equal(canTransition('frozen', 'proposed'), true);
  assert.equal(canTransition('active', 'frozen'), true);
  assert.equal(canTransition('frozen', 'active'), true);
  assert.equal(canTransition('frozen', 'completed'), true);
  assert.equal(canTransition('frozen', 'terminated'), true);
  assert.equal(canTransition('completed', 'active'), false);
  assert.equal(canTransition('terminated', 'proposed'), false);
});

test('状态集：isCollabState / isArchived 边界；常量集齐五态与归档三态', () => {
  assert.deepEqual(COLLAB_STATES, ['proposed', 'active', 'frozen', 'completed', 'terminated']);
  assert.deepEqual(ARCHIVED_STATES, ['completed', 'terminated', 'left']);
  assert.equal(isCollabState('frozen'), true);
  assert.equal(isCollabState('left'), false);
  assert.equal(isArchived('left'), true);
  assert.equal(isArchived('active'), false);
});

test('讨论模式迁移表：四态去冻结——proposed→completed 补入；其余边与 managed 同形', () => {
  assert.equal(canTransition('proposed', 'active', 'forum'), true);
  assert.equal(canTransition('proposed', 'terminated', 'forum'), true);
  assert.equal(canTransition('proposed', 'completed', 'forum'), true);
  assert.equal(canTransition('active', 'completed', 'forum'), true);
  assert.equal(canTransition('proposed', 'frozen', 'forum'), false, '冻结态对讨论不可达');
  assert.equal(canTransition('active', 'frozen', 'forum'), false);
  assert.equal(canTransition('frozen', 'active', 'forum'), false, '冻结前状态簿记不适用（无冻结面）');
  assert.equal(canTransition('active', 'terminated', 'forum'), false, '进行中的讨论不整条撤回（结束走 end）');
  assert.equal(canTransition('completed', 'active', 'forum'), false);
  assert.equal(canTransition('terminated', 'active', 'forum'), false);
});

test('迁移表默认模式：mode 缺省 = managed——既有调用点语义零变化', () => {
  assert.equal(canTransition('proposed', 'frozen'), true);
  assert.equal(canTransition('active', 'frozen'), true);
  assert.equal(canTransition('proposed', 'frozen', 'managed'), true);
  assert.equal(canTransition('active', 'completed'), true);
  assert.equal(canTransition('proposed', 'completed'), true);
});

test('模式形态：缺省通过、词表内通过、词表外拒（台账与成员记录同判据）', () => {
  assert.equal(isLedgerShape(sampleLedger()), true, '缺 mode（旧数据）通过');
  assert.equal(isLedgerShape(sampleLedger({ mode: 'managed' })), true);
  assert.equal(isLedgerShape(forumLedger()), true);
  assert.equal(isLedgerShape(sampleLedger({ mode: 'forum' })), false, 'forum 名单不得含 role=manager 行');
  assert.equal(isLedgerShape(sampleLedger({ mode: 'discussion' })), false);
  assert.equal(isLedgerShape(sampleLedger({ mode: 42 })), false);
  assert.equal(isMemberRecordShape(sampleMember()), true, '旧 member.json 形态留给 legacy 读取器');
  assert.equal(isMemberRecordShape(sampleMember({ mode: 'forum' })), true);
  assert.equal(isMemberRecordShape(sampleMember({ mode: 'paused' })), false);
});

test('withDefaultMode：缺 mode 就地补 managed（读取侧宽容）；已有取值不动', () => {
  assert.equal(withDefaultMode({}).mode, 'managed');
  assert.equal(withDefaultMode({ mode: 'forum' }).mode, 'forum');
  assert.equal(MAX_FORUM_MEMBERS, 16, '讨论参与者上限（含发起人）');
  assert.equal(MAX_ACTIVE_SEATS, 32);
});

test('newCollabId：ID 形态且不重复', () => {
  const first = newCollabId();
  const second = newCollabId();
  assert.match(first, /^[0-9a-f-]{36}$/);
  assert.notEqual(first, second);
});

test('isLedgerShape：席位台账（含 board 条目与 endedAt）通过、JSON round-trip 后仍通过', () => {
  const ledger = sampleLedger({
    status: 'completed',
    endedAt: '2026-10-13T01:00:00.000Z',
    board: [{ entryId: 'entry-1', ts: '2026-10-13T00:30:00.000Z', from: { instanceId: 'inst-b', identityName: '主机乙' }, kind: 'progress', text: '过半' }],
  });
  assert.equal(isLedgerShape(ledger), true);
  assert.equal(isLedgerShape(JSON.parse(JSON.stringify(ledger))), true);
});

test('isLedgerShape：坏字段逐一拒（版本 / 标识 / 名单 / 时间戳）', () => {
  const cases = [
    sampleLedger({ version: 0 }),
    sampleLedger({ collabId: '../evil' }),
    sampleLedger({ name: '甲\u0007乙' }),
    sampleLedger({ status: 'paused' }),
    sampleLedger({ members: [] }),
    sampleLedger({ board: [{ entryId: 'e-1', ts: 'x', from: { instanceId: 'inst-a', identityName: '甲' }, kind: 'progress', text: 'x' }] }),
    sampleLedger({ createdAt: 'not-a-time' }),
    sampleLedger({ endedAt: 42 }),
  ];
  for (const candidate of cases) {
    assert.equal(isLedgerShape(candidate), false, JSON.stringify(candidate).slice(0, 60));
  }
});

test('managerTerm / joinSeqNext：必填、1..2^31−1 正整数；managerTerm 保留最后值', () => {
  assert.equal(isLedgerShape(sampleLedger({ managerTerm: 2147483647, manager: managerOf({ term: 2147483647 }) })), true);
  assert.equal(isLedgerShape(sampleLedger({ managerTerm: 2147483648 })), false);
  assert.equal(isLedgerShape(sampleLedger({ managerTerm: 0 })), false);
  assert.equal(isLedgerShape(sampleLedger({ managerTerm: '1' })), false);
  assert.equal(isLedgerShape(sampleLedger({ joinSeqNext: 2147483647 })), true);
  assert.equal(isLedgerShape(sampleLedger({ joinSeqNext: 2147483648 })), false);
  assert.equal(isLedgerShape(sampleLedger({ joinSeqNext: 1.5 })), false);
  assert.equal(isLedgerShape(sampleLedger({ joinSeqNext: undefined })), false);
});

test('席位条目：同实例多会话成两席；重复席位键拒；非 member 状态不再接受', () => {
  const twoSeatsSameMachine = sampleLedger({
    members: [
      seat({ role: 'manager' }),
      seat({ instanceId: 'inst-a', sessionId: 'sess-a2', identityName: '主机甲', joinSeq: 2 }),
    ],
  });
  assert.equal(isLedgerShape(twoSeatsSameMachine), true, '同 instanceId 不同 sessionId 允许');
  const duplicated = sampleLedger({ members: [seat({ role: 'manager' }), seat({ joinSeq: 2 })] });
  assert.equal(isLedgerShape(duplicated), false, '同一 (instanceId,sessionId) 不得重复');
  for (const state of ['invited', 'approved', 'left', 'declined']) {
    assert.equal(isLedgerShape(sampleLedger({ members: [seat({ role: 'manager', state })] })), false, state);
  }
});

test('席位条目：sessionId / identityName / joinedAt / joinSeq 边界逐项拒', () => {
  const cases = [
    seat({ role: 'manager', sessionId: undefined }),
    seat({ role: 'manager', sessionId: 'bad id!' }),
    seat({ role: 'manager', identityName: '' }),
    seat({ role: 'manager', joinedAt: 'x' }),
    seat({ role: 'manager', joinSeq: undefined }),
    seat({ role: 'manager', joinSeq: 0 }),
    seat({ role: 'manager', joinSeq: 1.5 }),
    seat({ role: 'manager', joinSeq: '1' }),
    seat({ role: 'manager', joinSeq: 2147483648 }),
    seat({ role: 'boss' }),
  ];
  for (const entry of cases) {
    assert.equal(isLedgerShape(sampleLedger({ members: [entry] })), false, JSON.stringify(entry).slice(0, 60));
  }
});

test('managed 站长一致性：非终态恰一 manager 且与名单行、term 一致', () => {
  assert.equal(isLedgerShape(sampleLedger({ manager: null })), false, '非终态不得 manager:null');
  assert.equal(isLedgerShape(sampleLedger({ manager: managerOf({ term: 2 }) })), false, 'manager.term 须等于 managerTerm');
  assert.equal(isLedgerShape(sampleLedger({ manager: managerOf({ identityName: '别名' }) })), false);
  assert.equal(isLedgerShape(sampleLedger({ manager: managerOf({ instanceId: 'inst-b', sessionId: 'sess-b', identityName: '主机乙' }) })), false);
  assert.equal(isLedgerShape(sampleLedger({ members: [seat(), seat({ instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙', joinSeq: 2 })].map((entry) => ({ ...entry, role: 'manager' })) })), false, '两个站长行');
  assert.equal(isLedgerShape(sampleLedger({ members: [seat({ instanceId: 'inst-b', sessionId: 'sess-b', identityName: '主机乙' })] })), false, '名单无站长行');
});

test('终态：completed/terminated 允许空名单与 manager:null；managerWindow 清除', () => {
  assert.equal(isLedgerShape(sampleLedger({ status: 'completed', manager: null, members: [] })), true);
  assert.equal(isLedgerShape(sampleLedger({ status: 'terminated', manager: null, members: [], endedAt: AT })), true);
  assert.equal(isLedgerShape(sampleLedger({ status: 'completed' })), true, '保留站长与名单也合法');
  assert.equal(isLedgerShape(sampleLedger({ status: 'completed', manager: null })), false, 'manager:null 时名单不得残留站长行');
  assert.equal(isLedgerShape(sampleLedger({
    status: 'completed',
    managerWindow: { windowBaseTerm: 1, windowEndsAt: AT },
  })), false, '终态不得携带 managerWindow');
});

test('forum 分支：不要求 manager / joinSeq / joinSeqNext；managerTerm 仍在', () => {
  assert.equal(isLedgerShape(forumLedger()), true);
  assert.equal(isLedgerShape(forumLedger({ manager: null })), true);
  assert.equal(isLedgerShape(forumLedger({ manager: { instanceId: 'inst-a', identityName: '主机甲' } })), true, 'manager 字段可作中继记录');
  assert.equal(isLedgerShape(forumLedger({ joinSeqNext: 2 })), true);
  assert.equal(isLedgerShape(forumLedger({ managerTerm: undefined })), false);
  assert.equal(isLedgerShape(forumLedger({ managerTerm: 0 })), false);
  assert.equal(isLedgerShape(forumLedger({ members: [] })), false, '非终态名单至少 1');
  assert.equal(isLedgerShape(forumLedger({ status: 'completed', members: [] })), true);
});

test('forum 席位：joinSeq 可省、存在则须合法；席位键唯一性照旧', () => {
  assert.equal(isLedgerShape(forumLedger({ members: [seat({ joinSeq: undefined })] })), true);
  assert.equal(isLedgerShape(forumLedger({ members: [seat({ joinSeq: 0 })] })), false);
  assert.equal(isLedgerShape(forumLedger({ members: [seat({ joinSeq: 2147483648 })] })), false);
  assert.equal(isLedgerShape(forumLedger({ members: [seat(), seat()] })), false, '重复席位键');
  assert.equal(isLedgerShape(forumLedger({ members: [seat(), seat({ instanceId: 'inst-a', sessionId: 'sess-a2' })] })), true);
});

test('forum 无站长：名单含 role=manager 行拒；managerWindow 不属于 discussion', () => {
  assert.equal(isLedgerShape(forumLedger({ members: [seat({ role: 'manager' })] })), false);
  assert.equal(isLedgerShape(forumLedger({ managerWindow: { windowBaseTerm: 1, windowEndsAt: AT } })), false);
});

test('managerWindow：baseTerm 必须等于当前 managerTerm（陈旧窗口＝损坏）、时间戳合法', () => {
  const ledger = sampleLedger({
    managerTerm: 2,
    manager: managerOf({ term: 2 }),
    managerWindow: { windowBaseTerm: 2, windowEndsAt: AT },
  });
  assert.equal(isLedgerShape(ledger), true);
  assert.equal(isLedgerShape({ ...ledger, managerWindow: { windowBaseTerm: 1, windowEndsAt: AT } }), false, '陈旧窗口拒收');
  assert.equal(isLedgerShape({ ...ledger, managerWindow: { windowBaseTerm: 3, windowEndsAt: AT } }), false);
  assert.equal(isLedgerShape({ ...ledger, managerWindow: { windowBaseTerm: 0, windowEndsAt: AT } }), false);
  assert.equal(isLedgerShape({ ...ledger, managerWindow: { windowBaseTerm: 2, windowEndsAt: 'x' } }), false);
  assert.equal(isLedgerShape({ ...ledger, managerWindow: 'x' }), false);
  assert.equal(isLedgerShape({ ...ledger, managerWindow: null }), false);
});

test('isLedgerRosterShape：空名单按非终态/终态分别判定；mode 决定 joinSeq 是否必填', () => {
  assert.equal(isLedgerRosterShape(sampleLedger().members), true);
  assert.equal(isLedgerRosterShape([]), false);
  assert.equal(isLedgerRosterShape([], { allowEmpty: true }), true);
  assert.equal(isLedgerRosterShape(forumLedger().members, { mode: 'forum' }), true);
  assert.equal(isLedgerRosterShape(forumLedger().members), false, 'managed 判据要求 joinSeq');
  const many = Array.from({ length: MAX_ACTIVE_SEATS }, (raw, index) => seat({ sessionId: `sess-${index}`, joinSeq: index + 1 }));
  assert.equal(isLedgerRosterShape(many), true);
  assert.equal(isLedgerRosterShape([...many, seat({ sessionId: 'sess-extra', joinSeq: 33 })]), false);
  assert.equal(isLedgerRosterShape([seat(), seat()]), false);
});

test('managed 名单 joinSeq 单调不减：严格递减拒收、相等允许（分区重复序号破平）', () => {
  const decreasing = sampleLedger({
    members: [
      seat({ role: 'manager', joinSeq: 1 }),
      seat({ instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙', joinSeq: 5 }),
      seat({ instanceId: 'inst-c', sessionId: 'sess-c', identityName: '丙', joinSeq: 3 }),
    ],
  });
  assert.equal(isLedgerShape(decreasing), false, '严格递减＝损坏');
  const equal = sampleLedger({
    members: [
      seat({ role: 'manager', joinSeq: 1 }),
      seat({ instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙', joinSeq: 2 }),
      seat({ instanceId: 'inst-c', sessionId: 'sess-c', identityName: '丙', joinSeq: 2 }),
    ],
  });
  assert.equal(isLedgerShape(equal), true, '相等允许');
  assert.equal(isLedgerShape(sampleLedger({
    members: [
      seat({ role: 'manager', joinSeq: 1 }),
      seat({ instanceId: 'inst-b', sessionId: 'sess-b', identityName: '乙', joinSeq: 2 }),
      seat({ instanceId: 'inst-c', sessionId: 'sess-c', identityName: '丙', joinSeq: 3 }),
    ],
  })), true, '递增合法');
});

test('compareSnapshot：按 (managerTerm, version) 字典序；同 term 不同 manager 冲突；同 term/version 幂等', () => {
  assert.equal(compareSnapshot(snapshotOf(2, 1), snapshotOf(1, 9)).order, 1);
  assert.equal(compareSnapshot(snapshotOf(1, 9), snapshotOf(2, 1)).order, -1);
  assert.equal(compareSnapshot(snapshotOf(1, 2), snapshotOf(1, 3)).order, -1);
  assert.equal(compareSnapshot(snapshotOf(1, 3), snapshotOf(1, 3)).idempotent, true);
  const conflict = compareSnapshot(snapshotOf(1, 2, 'inst-a', 'sess-a'), snapshotOf(1, 9, 'inst-a', 'sess-b'));
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.order, 0, '同 term 冲突不比较 version');
  assert.equal(compareSnapshot(snapshotOf(1, 2), { ledger: { version: 1 } }).ok, false);
  assert.equal(compareSnapshot(null, snapshotOf(1, 2)).ok, false);
});

test('compareSnapshot：也接受台账对象（无 ledger 包装）', () => {
  const left = { managerTerm: 3, version: 5, manager: { instanceId: 'inst-a', sessionId: 'sess-a' } };
  const right = { managerTerm: 3, version: 4, manager: { instanceId: 'inst-a', sessionId: 'sess-a' } };
  assert.equal(compareSnapshot(left, right).order, 1);
});

test('compareSnapshot：终态 manager:null 参与比较——同 null 比 version/幂等，null 与席位同 term 冲突', () => {
  const terminal = (version) => ({ managerTerm: 1, version, manager: null });
  assert.equal(compareSnapshot(terminal(3), terminal(4)).order, -1);
  assert.equal(compareSnapshot(terminal(4), terminal(4)).idempotent, true);
  assert.equal(compareSnapshot(terminal(3), snapshotOf(1, 9)).conflict, true);
  assert.equal(compareSnapshot(terminal(3), { managerTerm: 1, version: 3 }).ok, false, 'manager 字段缺失仍是非法形态');
});

test('isSnapshotShape：合法通过；digest 非 64 位小写十六进制或 ledger 形态坏拒', () => {
  const snapshot = {
    version: 2,
    digest: 'a'.repeat(64),
    receivedAt: AT,
    from: { instanceId: 'inst-a', identityName: '主机甲' },
    ledger: sampleLedger(),
  };
  assert.equal(isSnapshotShape(snapshot), true);
  assert.equal(isSnapshotShape({ ...snapshot, digest: 'A'.repeat(64) }), false);
  assert.equal(isSnapshotShape({ ...snapshot, ledger: [] }), false);
  assert.equal(isSnapshotShape({ ...snapshot, version: 0 }), false);
});

test('isLedgerShape 对空对象 / null / 数组一律拒（形态底线）', () => {
  for (const candidate of [{}, null, [], 'ledger', 42]) {
    assert.equal(isLedgerShape(candidate), false, String(candidate));
  }
});

test('台账冻结标记：frozenAt / frozenFrom 缺省通过、合法值通过、非法拒', () => {
  assert.equal(isLedgerShape(sampleLedger()), true, '缺省（旧数据）通过');
  assert.equal(isLedgerShape(sampleLedger({ status: 'frozen', frozenAt: AT, frozenFrom: 'active' })), true);
  assert.equal(isLedgerShape(sampleLedger({ status: 'frozen', frozenAt: AT, frozenFrom: 'proposed' })), true);
  assert.equal(isLedgerShape(sampleLedger({ frozenAt: 42 })), false);
  assert.equal(isLedgerShape(sampleLedger({ frozenFrom: 'completed' })), false);
});

test('成员记录（legacy）：冻结标记与 originator 判据不变', () => {
  assert.equal(isMemberRecordShape(sampleMember()), true);
  assert.equal(isMemberRecordShape(sampleMember({ state: 'frozen', frozenAt: AT, frozenFrom: 'proposed' })), true);
  assert.equal(isMemberRecordShape(sampleMember({ frozenAt: 'x' })), false);
  assert.equal(isMemberRecordShape(sampleMember({ originator: { instanceId: 'inst-a', identityName: '主机甲' } })), true);
  assert.equal(isMemberRecordShape(sampleMember({ originator: { instanceId: 'inst-a' } })), false);
});

test('成员记录（legacy）：坏字段逐一拒（role / state / manager / endpoints / roster / 时间戳 / decision）', () => {
  const cases = [
    sampleMember({ role: 'owner' }),
    sampleMember({ state: 'paused' }),
    sampleMember({ manager: { instanceId: 'bad id!', identityName: '甲' } }),
    sampleMember({ endpoints: { 'inst-a': { address: '', port: 17321 } } }),
    sampleMember({ endpoints: { 'inst-a': { address: '127.0.0.1', port: 70000 } } }),
    sampleMember({ endpoints: { 'bad id!': { address: '127.0.0.1', port: 1 } } }),
    sampleMember({ roster: [] }),
    sampleMember({ roster: [{ instanceId: 'inst-a', identityName: '甲\u0007乙' }] }),
    sampleMember({ invitedAt: 'not-a-time' }),
    sampleMember({ decision: 'maybe' }),
  ];
  for (const candidate of cases) {
    assert.equal(isMemberRecordShape(candidate), false, JSON.stringify(candidate).slice(0, 60));
  }
});
