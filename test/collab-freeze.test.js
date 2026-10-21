import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDir } from './helpers.js';
import { makeLedger } from './helpers/session-participants.js';
import { decide } from '../src/collab/freeze.js';
import { managerFreezeReasonOf } from '../src/collab/gate.js';
import { ledgerDigest, loadSnapshot } from '../src/collab/store.js';

/* 任期分叉（manager-fork）的用户出口：冻结期只允许 terminate 本地归档，merge/keep 不适用；
 * 成员席位同样可裁定（分叉不是站长权限）；本机归档不广播、不推快照（契约、设计 §1.3）。
 * 模块层直调 decide：服务入口的席位授权另行接线，见任务报告 ISSUE。 */

const COLLAB = 'collab-freeze';
const NAME = '分叉协作';
const MGR = { instanceId: 'inst-mgr', sessionId: 'sess-mgr', identityName: '甲机' };
const MEM = { instanceId: 'inst-mem', sessionId: 'sess-mem', identityName: '乙机' };

function quietLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function ledgerFixture() {
  return makeLedger({
    collabId: COLLAB,
    name: NAME,
    status: 'active',
    managerTerm: 2,
    version: 5,
    manager: MGR,
    members: [{ ...MGR, role: 'manager', joinSeq: 1 }, { ...MEM, role: 'member', joinSeq: 2 }],
  });
}

function memberRecordOf(role) {
  return {
    collabId: COLLAB,
    name: NAME,
    topic: `${NAME} 主题`,
    role,
    state: 'frozen',
    manager: { instanceId: MGR.instanceId, sessionId: MGR.sessionId, identityName: MGR.identityName },
    endpoints: {},
    roster: ledgerFixture().members,
    mode: 'managed',
    decision: 'approved',
    freezeReason: 'manager-fork',
  };
}

function snapshotOf(ledger) {
  return {
    version: ledger.version,
    digest: ledgerDigest(ledger),
    receivedAt: new Date().toISOString(),
    from: { instanceId: MGR.instanceId, identityName: MGR.identityName },
    ledger,
  };
}

/* 本机分叉副本：member = 成员核（role=member），manager = 旧站长核（role=manager）。
 * 运行时冻结由生命周期接线层维护，测试直接摆出同一事实（state.m5Runtime.frozen）。 */
function forkFixture(t, { role = 'member' } = {}) {
  const dir = makeTempDir(t);
  const ledger = ledgerFixture();
  const local = {
    collabId: COLLAB,
    role,
    ledger: role === 'manager' ? structuredClone(ledger) : null,
    member: memberRecordOf(role),
    seats: new Map(),
    endpoints: new Map(),
    snapshot: snapshotOf(structuredClone(ledger)),
    mute: { clear: () => {} },
    suspended: null,
  };
  const sent = [];
  const state = {
    dataDir: dir,
    self: { instanceId: role === 'manager' ? MGR.instanceId : MEM.instanceId, identityName: '本机' },
    collabs: new Map([[COLLAB, local]]),
    counters: {},
    log: quietLog(),
    m5Runtime: { frozen: new Map([[COLLAB, 'manager-fork']]), frozenFrom: new Map() },
    send: (message) => {
      sent.push(message);
      return { ok: true, msgId: `q-${sent.length}` };
    },
  };
  return { state, local, dir, sent };
}

test('manager-fork 成员席：merge / keep 不适用，terminate 本地归档且不广播', (t) => {
  const { state, local, dir, sent } = forkFixture(t);
  for (const choice of ['merge', 'keep']) {
    const refused = decide(state, { collabId: COLLAB, choice });
    assert.equal(refused.ok, false, choice);
    assert.ok(refused.message.includes('不适用'), refused.message);
  }
  const done = decide(state, { collabId: COLLAB, choice: 'terminate' });
  assert.equal(done.ok, true, done.message);
  assert.equal(local.member.state, 'terminated');
  assert.equal(typeof local.member.archivedAt, 'string');
  assert.equal(sent.length, 0, '本机归档不广播（不发 decision / snapshot）');
  assert.equal(managerFreezeReasonOf(state, COLLAB), null, '归档后冻结判据不再成立');
  const snapshot = loadSnapshot(dir, COLLAB);
  assert.equal(snapshot.ledger.status, 'terminated', '成员核以本地终态副本保留归档读数');
  assert.equal(snapshot.ledger.manager, null);
  assert.equal(snapshot.ledger.version, 6, '版本递增');
  assert.equal(snapshot.ledger.localTerminal, true);
  assert.deepEqual(snapshot.ledger.members, [], '本地终态副本名单清空');
});

test('manager-fork 旧站长核：terminate 只归档本机台账，不推快照', (t) => {
  const { state, local, sent } = forkFixture(t, { role: 'manager' });
  const done = decide(state, { collabId: COLLAB, choice: 'terminate' });
  assert.equal(done.ok, true, done.message);
  assert.equal(local.ledger.status, 'terminated');
  assert.equal(local.ledger.manager, null);
  assert.equal(Object.hasOwn(local.ledger, 'managerWindow'), false);
  assert.equal(local.ledger.members.every((entry) => entry.role === 'member'), true);
  assert.equal(sent.length, 0, 'localOnly 不推快照、不广播');
});

test('manager-fork 判据：运行态缺失时以持久化 freezeReason 兜底，杂散值不停写', (t) => {
  const { state } = forkFixture(t);
  state.m5Runtime.frozen.clear();
  assert.equal(managerFreezeReasonOf(state, COLLAB), 'manager-fork', '成员记录的冻结原因可判');
  state.collabs.get(COLLAB).member.freezeReason = 'arbitrary';
  assert.equal(managerFreezeReasonOf(state, COLLAB), null, '只认三态词表');
});

test('manager-fork 重复终止：第二次如实拒绝（已归档）', (t) => {
  const { state } = forkFixture(t);
  assert.equal(decide(state, { collabId: COLLAB, choice: 'terminate' }).ok, true);
  const again = decide(state, { collabId: COLLAB, choice: 'terminate' });
  assert.equal(again.ok, false);
  assert.ok(again.message.includes('归档'), again.message);
});
