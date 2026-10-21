import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDir } from './helpers.js';
import { createCollabService } from '../src/collab/service.js';
import { appendLedger, ensureCollabDir, loadLedger } from '../src/collab/store.js';
import { terminateLocalCopy } from '../src/collab/freeze.js';
import { isLedgerShape, isTerminalLedger } from '../src/collab/model.js';

/* 终态生产端（设计 §3.4）：冻结裁定终止与整条撤回都必须写出「manager:null、无窗口、无站长行」
 * 的终态台账——否则 loadLedger 只认最后一条通过形态校验的行，重启会静默回退到终止前的旧行。 */

const DAY = 24 * 60 * 60 * 1000;
const SELF = { instanceId: 'inst-self', identityName: '本机', port: 17321 };
const CREATOR_SESSION = 'sess-creator';
const TARGET = { instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.2', port: 17321 };

function quietLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function makeHarness(t) {
  const dir = makeTempDir(t);
  const sent = [];
  const config = {
    inviteTtlMs: DAY,
    managerProbeIntervalMs: 20,
    managerOfflineMs: 40,
    takeoverWindowMs: 60,
    freezeUnresolvedMs: DAY,
  };
  const service = createCollabService({
    dataDir: dir,
    config,
    self: SELF,
    send: (message) => {
      sent.push(message);
      return { ok: true, msgId: `q-${sent.length}` };
    },
    knownHosts: { remember: () => {} },
    log: quietLog(),
    notify: () => {},
  });
  t.after(() => service.close());
  return { service, sent, dir };
}

function createProposal(harness) {
  const created = harness.service.create({
    sessionId: CREATOR_SESSION,
    name: '联调项目',
    topic: '发布联调',
    targets: [TARGET],
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  return created.collabId;
}

/* 经冻结广播把本机 proposed 协作冻上（裁定终止的前置状态）。 */
async function freezeProposal(harness) {
  const frame = {
    v: 1,
    type: 'freeze',
    msgId: 'msg-freeze-terminal',
    from: { instanceId: 'inst-c', identityName: '主机丙', port: 17321 },
    collabId: 'collab-rival',
    ts: new Date().toISOString(),
    payload: {
      name: '联调项目',
      members: [{ instanceId: SELF.instanceId, identityName: SELF.identityName }, { instanceId: 'inst-c', identityName: '主机丙' }],
      reason: '同名冲突',
    },
  };
  const admitted = await harness.service.hooks.admit(frame, { remoteAddress: '127.0.0.1' });
  assert.equal(admitted?.ok, true, JSON.stringify(admitted));
  await harness.service.hooks.consume(frame, { remoteAddress: '127.0.0.1' });
}

function assertTerminalOnDisk(dir, collabId) {
  const loaded = loadLedger(dir, collabId);
  assert.equal(loaded.corrupt, false, '终态行必须是可用台账（不得判损坏）');
  assert.equal(loaded.badLines, undefined, '最后一条写入行必须通过形态校验（不得回退上一条）');
  const ledger = loaded.ledger;
  assert.ok(ledger, '重启加载必须拿到台账');
  assert.equal(ledger.status, 'terminated', '最后落盘的必须是终态行');
  assert.equal(ledger.manager, null, '终态必须 manager:null');
  assert.equal(Object.hasOwn(ledger, 'managerWindow'), false, '终态不得残留接管窗口');
  assert.equal(ledger.members.some((entry) => entry.role === 'manager'), false, '名单不得残留站长行');
  assert.equal(isTerminalLedger(ledger), true, '终态判据必须成立');
  assert.equal(isLedgerShape(ledger), true, '终态台账须过形态校验');
  return ledger;
}

test('冻结裁定终止：落盘终态可被 loadLedger 加载，不回退到终止前的冻结行', async (t) => {
  const harness = makeHarness(t);
  const collabId = createProposal(harness);
  await freezeProposal(harness);
  const frozen = loadLedger(harness.dir, collabId);
  assert.equal(frozen.ledger?.status, 'frozen', '前置：冻结行已落盘');

  const decided = harness.service.decide({ collabId, choice: 'terminate' });
  assert.equal(decided.ok, true, JSON.stringify(decided));

  const ledger = assertTerminalOnDisk(harness.dir, collabId);
  assert.ok(ledger.version > frozen.ledger.version, '加载到的是终止后的新行，而非公告前的旧行');
  assert.ok(ledger.members.length > 0, '终止保留名单行（终态通告仍要投给原参与者）');
});

/* 冻结中的站长台账，带一个尚未关闭的接管窗口——终止必须把窗口一并清掉，否则终态行不合法。 */
function windowedFrozenLedger(collabId) {
  const now = new Date().toISOString();
  return {
    version: 2,
    collabId,
    name: '联调项目',
    topic: '发布联调',
    mode: 'managed',
    status: 'frozen',
    managerTerm: 1,
    manager: { instanceId: SELF.instanceId, sessionId: CREATOR_SESSION, identityName: SELF.identityName, term: 1 },
    managerWindow: { windowBaseTerm: 1, windowEndsAt: new Date(Date.now() + 60000).toISOString() },
    joinSeqNext: 2,
    members: [
      { instanceId: SELF.instanceId, sessionId: CREATOR_SESSION, identityName: SELF.identityName, role: 'manager', state: 'member', joinSeq: 1, joinedAt: now },
      { instanceId: TARGET.instanceId, sessionId: 'sess-b1', identityName: TARGET.identityName, role: 'member', state: 'member', joinSeq: 2, joinedAt: now },
    ],
    board: [],
    createdAt: now,
    updatedAt: now,
    frozenAt: now,
    frozenFrom: 'active',
  };
}

function windowedState(dir, local) {
  return {
    self: SELF,
    dataDir: dir,
    collabs: new Map([[local.collabId, local]]),
    counters: { freezeTerminatedLocal: 0, ledgerMutations: 0, persistFailures: 0, snapshotSkipped: 0 },
    log: quietLog(),
    send: () => ({ ok: true, msgId: 'q-1' }),
  };
}

test('冻结裁定终止：接管窗口随终态清除（真实落盘）', (t) => {
  const dir = makeTempDir(t);
  const ledger = windowedFrozenLedger('collab-window');
  assert.equal(isLedgerShape(ledger), true, '前置夹具须是合法冻结台账（含接管窗口）');
  ensureCollabDir(dir, ledger.collabId);
  appendLedger(dir, ledger);
  const local = {
    collabId: ledger.collabId,
    role: 'manager',
    suspended: null,
    ledger,
    member: { state: 'active', sessionId: CREATOR_SESSION },
    endpoints: new Map(),
    seats: new Map(),
    mute: { clear: () => {} },
  };
  const beforeVersion = ledger.version;
  assert.equal(terminateLocalCopy(windowedState(dir, local), local, '裁定：终止本方一条'), true);

  const loaded = assertTerminalOnDisk(dir, ledger.collabId);
  assert.equal(loaded.version > beforeVersion, true, '落盘的是终止后的新行');
});

test('整条撤回：落盘终态可被 loadLedger 加载，不回退到撤回前的提议行', async (t) => {
  const harness = makeHarness(t);
  const collabId = createProposal(harness);
  const proposed = loadLedger(harness.dir, collabId);
  assert.equal(proposed.ledger?.status, 'proposed', '前置：提议行已落盘');

  const withdrawn = harness.service.withdraw({ collabId });
  assert.equal(withdrawn.ok, true, JSON.stringify(withdrawn));
  assert.equal(withdrawn.scope, 'all');

  const ledger = assertTerminalOnDisk(harness.dir, collabId);
  assert.ok(ledger.version > proposed.ledger.version, '加载到的是撤回后的新行，而非撤回前的旧行');
});
