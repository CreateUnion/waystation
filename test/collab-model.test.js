import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARCHIVED_STATES,
  COLLAB_STATES,
  canTransition,
  isArchived,
  isCollabState,
  isLedgerShape,
  isMemberRecordShape,
  isSnapshotShape,
  newCollabId,
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
