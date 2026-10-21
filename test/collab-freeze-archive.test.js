import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { terminateLocalCopy } from '../src/collab/freeze.js';
import { loadMember } from '../src/collab/store.js';
import { seatFilePath } from '../src/paths.js';
import { createCollabService } from '../src/collab/service.js';
import { makeTempDir } from './helpers.js';

/* 冻结终止的本地归档口径（契约 §8/§9.3）：终态必须给本机席位写 archivedAt（退出注入与静音聚合）
 * 且不删除席位文件；旧的 mute.json store 已退役，终止路径不得再触达它。 */

const DAY = 24 * 60 * 60 * 1000;
const SELF = { instanceId: 'inst-self', identityName: '本机', port: 17321 };
const CREATOR_SESSION = 'sess-creator';
const TARGET = { instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.2', port: 17321 };

function quietLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function makeHarness(t) {
  const dir = makeTempDir(t);
  const service = createCollabService({
    dataDir: dir,
    config: { inviteTtlMs: DAY, freezeUnresolvedMs: DAY },
    self: SELF,
    send: () => ({ ok: true, msgId: 'q-1' }),
    knownHosts: { remember: () => {} },
    log: quietLog(),
    notify: () => {},
  });
  t.after(() => service.close());
  return { service, dir };
}

/* 经冻结广播冻上本机 proposed 协作——冻结裁定终止的前置状态（与 collab-terminal-ledger 同一夹具）。 */
async function frozenProposal(harness) {
  const created = harness.service.create({
    sessionId: CREATOR_SESSION,
    name: '联调项目',
    topic: '发布联调',
    targets: [TARGET],
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const frame = {
    v: 1,
    type: 'freeze',
    msgId: 'msg-freeze-archive',
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
  return created.collabId;
}

test('冻结裁定终止：本机席位写 archivedAt 并退出注入/静音聚合，席位文件不删除', async (t) => {
  const harness = makeHarness(t);
  const collabId = await frozenProposal(harness);
  const file = seatFilePath(harness.dir, collabId, CREATOR_SESSION);
  assert.equal(existsSync(file), true, '前置：创建者席位已落盘');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).archivedAt, undefined);

  const decided = harness.service.decide({ collabId, choice: 'terminate', sessionId: CREATOR_SESSION });
  assert.equal(decided.ok, true, JSON.stringify(decided));

  assert.equal(existsSync(file), true, '席位文件保留（删除属停点）');
  const seat = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(typeof seat.archivedAt, 'string', '席位持久面写归档时刻');
  assert.equal(harness.service.localSeatOf(collabId, CREATOR_SESSION).archived, true, '席位视图归档＝退出注入与静音聚合');
  assert.equal(typeof loadMember(harness.dir, collabId)?.archivedAt, 'string', '本地参与记录同步归档');
});

/* 成员侧本地终止：席位归档同样成立，且不再调用旧静音 store（保留一个会抛错的 clear 作探针）。 */
function memberLocalOf(collabId) {
  const seats = new Map([
    ['sess-m1', { sessionId: 'sess-m1', role: 'member', state: 'member', muted: true, joinSeq: 1, joinedAt: '2026-01-01T00:00:00.000Z' }],
    ['sess-m2', { sessionId: 'sess-m2', role: 'member', state: 'member', muted: false, joinSeq: 2, joinedAt: '2026-01-01T00:00:00.000Z' }],
  ]);
  const local = {
    collabId,
    role: 'member',
    ledger: null,
    member: { state: 'active', sessionId: 'sess-m1' },
    snapshot: {
      version: 3,
      ledger: {
        version: 3,
        collabId,
        status: 'active',
        manager: null,
        managerTerm: 1,
        members: [],
        board: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    },
    endpoints: new Map(),
    seats,
    mute: {
      clear: () => {
        throw new Error('终止路径不得调用退役的 mute.json store');
      },
    },
  };
  return { local, seats };
}

function memberStateOf(dir, local) {
  return {
    self: SELF,
    dataDir: dir,
    collabs: new Map([[local.collabId, local]]),
    counters: { freezeTerminatedLocal: 0, persistFailures: 0 },
    log: quietLog(),
    send: () => ({ ok: true, msgId: 'q-1' }),
  };
}

test('本地终止（成员核）：全部本机席位归档、终态快照保留、不触旧静音 store', (t) => {
  const dir = makeTempDir(t);
  const { local, seats } = memberLocalOf('collab-member-terminal');
  const state = memberStateOf(dir, local);

  assert.equal(terminateLocalCopy(state, local, '裁定：终止本方一条'), true);

  for (const sessionId of seats.keys()) {
    const file = seatFilePath(dir, local.collabId, sessionId);
    assert.equal(existsSync(file), true, `${sessionId} 席位文件保留`);
    assert.equal(typeof JSON.parse(readFileSync(file, 'utf8')).archivedAt, 'string', `${sessionId} 席位写归档时刻`);
  }
  assert.equal([...seats.values()].every((seat) => typeof seat.archivedAt === 'string'), true, '内存席位同步归档');
  assert.equal(local.member.archivedAt !== undefined, true, '成员记录归档');
  assert.equal(local.snapshot.ledger.localTerminal, true, '本地只读终态副本成立');
  assert.equal(state.counters.freezeTerminatedLocal, 1);
});
