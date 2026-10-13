import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARCHIVED_STATES,
  COLLAB_STATES,
  MAX_FORUM_MEMBERS,
  canTransition,
  isArchived,
  isCollabState,
  isLedgerShape,
  isMemberRecordShape,
  isSnapshotShape,
  newCollabId,
  withDefaultMode,
} from '../src/collab/model.js';

function sampleLedger(overrides = {}) {
  return {
    version: 1,
    collabId: 'collab-1',
    name: '联调项目',
    topic: '发布联调',
    status: 'proposed',
    manager: { instanceId: 'inst-a', identityName: '主机甲' },
    members: [
      { instanceId: 'inst-a', identityName: '主机甲', role: 'manager', state: 'member', joinedAt: '2026-10-13T00:00:00.000Z' },
      { instanceId: 'inst-b', identityName: '主机乙', role: 'member', state: 'invited', joinedAt: '2026-10-13T00:00:00.000Z' },
    ],
    board: [],
    createdAt: '2026-10-13T00:00:00.000Z',
    updatedAt: '2026-10-13T00:00:00.000Z',
    ...overrides,
  };
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

test('状态迁移表：合法边通过、非法边拒绝（含终态无出边）', () => {
  assert.equal(canTransition('proposed', 'active'), true);
  assert.equal(canTransition('proposed', 'frozen'), true);
  assert.equal(canTransition('proposed', 'terminated'), true);
  assert.equal(canTransition('active', 'completed'), true);
  assert.equal(canTransition('frozen', 'proposed'), true);
  assert.equal(canTransition('active', 'frozen'), true);
  assert.equal(canTransition('frozen', 'active'), true);
  assert.equal(canTransition('frozen', 'completed'), true);
  assert.equal(canTransition('frozen', 'terminated'), true);
  assert.equal(canTransition('completed', 'active'), false);
  assert.equal(canTransition('terminated', 'proposed'), false);
  assert.equal(canTransition('proposed', 'completed'), false);
});

test('状态集：isCollabState / isArchived 边界；常量集齐五态与归档三态', () => {
  assert.deepEqual(COLLAB_STATES, ['proposed', 'active', 'frozen', 'completed', 'terminated']);
  assert.deepEqual(ARCHIVED_STATES, ['completed', 'terminated', 'left']);
  assert.equal(isCollabState('frozen'), true);
  assert.equal(isCollabState('left'), false);
  assert.equal(isArchived('left'), true);
  assert.equal(isArchived('active'), false);
});

test('讨论模式迁移表：四态去冻结——冻结边入 / 出全部拒绝，其余边与 managed 同形', () => {
  assert.equal(canTransition('proposed', 'active', 'forum'), true);
  assert.equal(canTransition('proposed', 'terminated', 'forum'), true);
  assert.equal(canTransition('active', 'completed', 'forum'), true);
  assert.equal(canTransition('proposed', 'frozen', 'forum'), false, '冻结态对讨论不可达');
  assert.equal(canTransition('active', 'frozen', 'forum'), false);
  assert.equal(canTransition('frozen', 'active', 'forum'), false, '冻结前状态簿记不适用（无冻结面）');
  assert.equal(canTransition('proposed', 'completed', 'forum'), false, '跨态直达拒绝');
  assert.equal(canTransition('active', 'terminated', 'forum'), false, '进行中的讨论不整条撤回（结束走 end）');
  assert.equal(canTransition('completed', 'active', 'forum'), false);
  assert.equal(canTransition('terminated', 'active', 'forum'), false);
});

test('迁移表默认模式：mode 缺省 = managed——既有调用点语义零变化', () => {
  assert.equal(canTransition('proposed', 'frozen'), true);
  assert.equal(canTransition('active', 'frozen'), true);
  assert.equal(canTransition('proposed', 'frozen', 'managed'), true);
  assert.equal(canTransition('active', 'completed'), true);
  assert.equal(canTransition('proposed', 'completed'), false);
});

test('模式形态：缺省通过（旧数据兼容）、词表内通过、词表外拒（台账与成员记录同判据）', () => {
  assert.equal(isLedgerShape(sampleLedger()), true, '缺 mode（旧数据）通过');
  assert.equal(isLedgerShape(sampleLedger({ mode: 'managed' })), true);
  assert.equal(isLedgerShape(sampleLedger({ mode: 'forum' })), true);
  assert.equal(isLedgerShape(sampleLedger({ mode: 'discussion' })), false);
  assert.equal(isLedgerShape(sampleLedger({ mode: 42 })), false);
  assert.equal(isMemberRecordShape(sampleMember()), true, '缺 mode（旧数据）通过');
  assert.equal(isMemberRecordShape(sampleMember({ mode: 'forum' })), true);
  assert.equal(isMemberRecordShape(sampleMember({ mode: 'paused' })), false);
});

test('withDefaultMode：缺 mode 就地补 managed（读取侧宽容）；已有取值不动', () => {
  assert.equal(withDefaultMode({}).mode, 'managed');
  assert.equal(withDefaultMode({ mode: 'forum' }).mode, 'forum');
  assert.equal(MAX_FORUM_MEMBERS, 16, '讨论参与者上限（含发起人）');
});

test('newCollabId：ID 形态且不重复', () => {
  const first = newCollabId();
  const second = newCollabId();
  assert.match(first, /^[0-9a-f-]{36}$/);
  assert.notEqual(first, second);
});

test('isLedgerShape：合法台账（含 board 条目与 endedAt）通过、JSON round-trip 后仍通过', () => {
  const ledger = sampleLedger({
    status: 'completed',
    endedAt: '2026-10-13T01:00:00.000Z',
    board: [{ entryId: 'entry-1', ts: '2026-10-13T00:30:00.000Z', from: { instanceId: 'inst-b', identityName: '主机乙' }, kind: 'progress', text: '过半' }],
  });
  assert.equal(isLedgerShape(ledger), true);
  assert.equal(isLedgerShape(JSON.parse(JSON.stringify(ledger))), true);
});

test('isLedgerShape：坏字段逐一拒（version / collabId / name / status / manager / members / board / 时间戳）', () => {
  const cases = [
    sampleLedger({ version: 0 }),
    sampleLedger({ collabId: '../evil' }),
    sampleLedger({ name: '甲\u0007乙' }),
    sampleLedger({ status: 'paused' }),
    sampleLedger({ manager: { instanceId: 'inst-a' } }),
    sampleLedger({ members: [] }),
    sampleLedger({ members: [{ instanceId: 'inst-a', identityName: '甲', role: 'member', state: 'unknown', joinedAt: '2026-10-13T00:00:00.000Z' }] }),
    sampleLedger({ board: [{ entryId: 'e-1', ts: 'x', from: { instanceId: 'inst-a', identityName: '甲' }, kind: 'progress', text: 'x' }] }),
    sampleLedger({ createdAt: 'not-a-time' }),
    sampleLedger({ endedAt: 42 }),
  ];
  for (const candidate of cases) {
    assert.equal(isLedgerShape(candidate), false, JSON.stringify(candidate).slice(0, 60));
  }
});

test('isMemberRecordShape：合法记录通过；decision 缺省 null 可接受（旧字段缺失兼容）', () => {
  assert.equal(isMemberRecordShape(sampleMember()), true);
  const legacy = sampleMember();
  delete legacy.decision;
  assert.equal(isMemberRecordShape(legacy), true);
  assert.equal(isMemberRecordShape(sampleMember({ decision: 'approved', archivedAt: '2026-10-13T02:00:00.000Z' })), true);
});

test('isMemberRecordShape：坏字段逐一拒（role / state / manager / endpoints / 时间戳 / decision）', () => {
  const cases = [
    sampleMember({ role: 'owner' }),
    sampleMember({ state: 'paused' }),
    sampleMember({ manager: { instanceId: 'bad id!', identityName: '甲' } }),
    sampleMember({ endpoints: { 'inst-a': { address: '', port: 17321 } } }),
    sampleMember({ endpoints: { 'inst-a': { address: '127.0.0.1', port: 70000 } } }),
    sampleMember({ endpoints: { 'inst-a': { address: '127.0.0.1', port: 17321 }, 'bad id!': { address: '127.0.0.1', port: 1 } } }),
    sampleMember({ roster: [] }),
    sampleMember({ roster: [{ instanceId: 'inst-a', identityName: '甲\u0007乙' }] }),
    sampleMember({ invitedAt: 'not-a-time' }),
    sampleMember({ decision: 'maybe' }),
  ];
  for (const candidate of cases) {
    assert.equal(isMemberRecordShape(candidate), false, JSON.stringify(candidate).slice(0, 60));
  }
});

test('isSnapshotShape：合法通过；digest 非 64 位小写十六进制或 ledger 形态坏拒', () => {
  const snapshot = {
    version: 2,
    digest: 'a'.repeat(64),
    receivedAt: '2026-10-13T00:00:00.000Z',
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
  assert.equal(isLedgerShape(sampleLedger({ status: 'frozen', frozenAt: '2026-10-13T03:00:00.000Z', frozenFrom: 'active' })), true);
  assert.equal(isLedgerShape(sampleLedger({ status: 'frozen', frozenAt: '2026-10-13T03:00:00.000Z', frozenFrom: 'proposed' })), true);
  assert.equal(isLedgerShape(sampleLedger({ frozenAt: 42 })), false);
  assert.equal(isLedgerShape(sampleLedger({ frozenFrom: 'completed' })), false);
});

test('成员记录冻结标记：frozenAt / frozenFrom 同判据（缺省兼容 + 枚举约束）', () => {
  assert.equal(isMemberRecordShape(sampleMember()), true, '缺省（旧数据）通过');
  assert.equal(isMemberRecordShape(sampleMember({ state: 'frozen', frozenAt: '2026-10-13T03:00:00.000Z', frozenFrom: 'proposed' })), true);
  assert.equal(isMemberRecordShape(sampleMember({ frozenAt: 'x' })), false);
  assert.equal(isMemberRecordShape(sampleMember({ frozenFrom: 'terminated' })), false);
});

test('成员记录发起人标识（originator）：缺省兼容、身份对形态通过、坏形态拒', () => {
  assert.equal(isMemberRecordShape(sampleMember()), true, '缺省（旧记录/未学到）通过');
  assert.equal(isMemberRecordShape(sampleMember({ originator: { instanceId: 'inst-a', identityName: '主机甲' } })), true);
  const cases = [
    sampleMember({ originator: 'inst-a' }),
    sampleMember({ originator: { instanceId: 'bad id!', identityName: '主机甲' } }),
    sampleMember({ originator: { instanceId: 'inst-a', identityName: '' } }),
    sampleMember({ originator: { instanceId: 'inst-a' } }),
    sampleMember({ originator: {} }),
  ];
  for (const candidate of cases) {
    assert.equal(isMemberRecordShape(candidate), false, JSON.stringify(candidate.originator));
  }
});
