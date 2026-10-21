import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { COLLABS_DIR_NAME, collabDir, collabFilePath } from '../src/paths.js';
import { makeTempDir } from './helpers.js';
import {
  LEDGER_FILE_NAME,
  MEMBER_FILE_NAME,
  SNAPSHOT_FILE_NAME,
  appendLedger,
  ledgerDigest,
  listLocalCollabIds,
  loadLedger,
  loadMember,
  loadSnapshot,
  quarantineLedger,
  saveMember,
  saveSnapshot,
} from '../src/collab/store.js';

/* 台账夹具按 0.2.0 席位形态（模型层校验的唯一形态）：managerTerm / joinSeqNext /
 * manager.term / 席位键 sessionId + joinSeq；0.1.x 旧形态只由 legacy 读取器处理。 */
function ledgerOf(version, overrides = {}) {
  return {
    version,
    collabId: 'collab-1',
    name: '联调项目',
    topic: '发布联调',
    status: 'proposed',
    managerTerm: 1,
    joinSeqNext: 3,
    manager: { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '主机甲', term: 1 },
    members: [
      { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '主机甲', role: 'manager', state: 'member', joinSeq: 1, joinedAt: '2026-10-13T00:00:00.000Z' },
      { instanceId: 'inst-b', sessionId: 'sess-b', identityName: '主机乙', role: 'member', state: 'member', joinSeq: 2, joinedAt: '2026-10-13T00:00:00.000Z' },
    ],
    board: [],
    createdAt: '2026-10-13T00:00:00.000Z',
    updatedAt: '2026-10-13T00:00:00.000Z',
    ...overrides,
  };
}

test('ledgerDigest：同对象稳定、字段变化即变化、JSON round-trip 不改变', () => {
  const ledger = ledgerOf(1);
  const digest = ledgerDigest(ledger);
  assert.equal(digest, ledgerDigest(ledger));
  assert.equal(digest, ledgerDigest(JSON.parse(JSON.stringify(ledger))));
  assert.notEqual(digest, ledgerDigest(ledgerOf(2)));
});

test('appendLedger + loadLedger：多次追加取最后一条完整行', (t) => {
  const dir = makeTempDir(t);
  mkdirSync(collabDir(dir, 'collab-1'), { recursive: true });
  appendLedger(dir, ledgerOf(1));
  appendLedger(dir, ledgerOf(2, { status: 'active' }));
  const loaded = loadLedger(dir, 'collab-1');
  assert.equal(loaded.corrupt, false);
  assert.equal(loaded.ledger.version, 2);
  assert.equal(loaded.ledger.status, 'active');
});

test('loadLedger：中间坏行跳过取最近合法行；尾部半写截断后仍取最后合法行', (t) => {
  const dir = makeTempDir(t);
  mkdirSync(collabDir(dir, 'collab-1'), { recursive: true });
  const file = collabFilePath(dir, 'collab-1', LEDGER_FILE_NAME);
  appendFileSync(file, JSON.stringify(ledgerOf(1)) + '\n');
  appendFileSync(file, '{"broken":\n');
  appendFileSync(file, JSON.stringify(ledgerOf(2)) + '\n');
  assert.equal(loadLedger(dir, 'collab-1').ledger.version, 2);
  appendFileSync(file, '{"version":3,"half');
  const afterTail = loadLedger(dir, 'collab-1');
  assert.equal(afterTail.corrupt, false);
  assert.equal(afterTail.ledger.version, 2);
});

test('loadLedger：文件不存在或空 → 干净空；有内容但无一条合法 → corrupt', (t) => {
  const dir = makeTempDir(t);
  mkdirSync(collabDir(dir, 'collab-1'), { recursive: true });
  assert.deepEqual(loadLedger(dir, 'collab-1'), { ledger: null, corrupt: false });
  writeFileSync(collabFilePath(dir, 'collab-1', LEDGER_FILE_NAME), '');
  assert.deepEqual(loadLedger(dir, 'collab-1'), { ledger: null, corrupt: false });
  writeFileSync(collabFilePath(dir, 'collab-1', LEDGER_FILE_NAME), '{"version":"x"}\n{"status":42}\n');
  assert.deepEqual(loadLedger(dir, 'collab-1'), { ledger: null, corrupt: true });
});

test('quarantineLedger：改名留副本、原路径消失、副本可读', (t) => {
  const dir = makeTempDir(t);
  mkdirSync(collabDir(dir, 'collab-1'), { recursive: true });
  const file = collabFilePath(dir, 'collab-1', LEDGER_FILE_NAME);
  writeFileSync(file, 'broken\n');
  assert.equal(quarantineLedger(dir, 'collab-1'), true);
  assert.equal(existsSync(file), false);
  const backups = readdirSync(collabDir(dir, 'collab-1')).filter((name) => name.startsWith(`${LEDGER_FILE_NAME}.corrupt-`));
  assert.equal(backups.length, 1);
});

test('member 记录：save / load round-trip；不存在或形态不符 → null', (t) => {
  const dir = makeTempDir(t);
  mkdirSync(collabDir(dir, 'collab-1'), { recursive: true });
  assert.equal(loadMember(dir, 'collab-1'), null);
  const record = {
    collabId: 'collab-1',
    role: 'member',
    state: 'proposed',
    name: '联调项目',
    manager: { instanceId: 'inst-a', identityName: '主机甲' },
    roster: [{ instanceId: 'inst-a', identityName: '主机甲' }],
    endpoints: {},
    invitedAt: '2026-10-13T00:00:00.000Z',
    expiresAt: '2026-10-14T00:00:00.000Z',
    decision: null,
  };
  saveMember(dir, record);
  assert.deepEqual(loadMember(dir, 'collab-1'), record);
  writeFileSync(collabFilePath(dir, 'collab-1', MEMBER_FILE_NAME), '{"role":"owner"}\n');
  assert.equal(loadMember(dir, 'collab-1'), null);
});

test('snapshot：save / load round-trip；digest 形态坏 → null', (t) => {
  const dir = makeTempDir(t);
  mkdirSync(collabDir(dir, 'collab-1'), { recursive: true });
  const snapshot = {
    version: 2,
    digest: 'a'.repeat(64),
    receivedAt: '2026-10-13T00:00:00.000Z',
    from: { instanceId: 'inst-a', identityName: '主机甲' },
    ledger: ledgerOf(2),
  };
  saveSnapshot(dir, 'collab-1', snapshot);
  assert.deepEqual(loadSnapshot(dir, 'collab-1'), snapshot);
  writeFileSync(collabFilePath(dir, 'collab-1', SNAPSHOT_FILE_NAME), JSON.stringify({ ...snapshot, digest: 'short' }));
  assert.equal(loadSnapshot(dir, 'collab-1'), null);
});

test('loadSnapshot：不存在 → null（读取方按缺失处理）', (t) => {
  const dir = makeTempDir(t);
  mkdirSync(collabDir(dir, 'collab-1'), { recursive: true });
  assert.equal(loadSnapshot(dir, 'collab-1'), null);
});

test('listLocalCollabIds：只收合法目录名（非法名与文件过滤）、目录缺失按空清单', (t) => {
  const dir = makeTempDir(t);
  assert.deepEqual(listLocalCollabIds(dir), []);
  mkdirSync(join(dir, COLLABS_DIR_NAME, 'collab-1'), { recursive: true });
  mkdirSync(join(dir, COLLABS_DIR_NAME, 'bad id!'), { recursive: true });
  writeFileSync(join(dir, COLLABS_DIR_NAME, 'stray.txt'), 'x');
  assert.deepEqual(listLocalCollabIds(dir), ['collab-1']);
});

test('ledgerDigest：64 位小写十六进制（与协议摘要形态同一约定）、内容敏改即变', () => {
  const digest = ledgerDigest(ledgerOf(1));
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(digest, ledgerDigest(ledgerOf(1)), '同内容同摘要（稳定）');
  assert.notEqual(digest, ledgerDigest(ledgerOf(2)), '版本变化摘要变化');
});

test('quarantineLedger：文件缺失返回 false（失败不抛）；成功后改名保留副本', (t) => {
  const dir = makeTempDir(t);
  mkdirSync(collabDir(dir, 'collab-1'), { recursive: true });
  assert.equal(quarantineLedger(dir, 'collab-1'), false);
  writeFileSync(collabFilePath(dir, 'collab-1', LEDGER_FILE_NAME), '{}\n');
  assert.equal(quarantineLedger(dir, 'collab-1'), true);
  assert.equal(existsSync(collabFilePath(dir, 'collab-1', LEDGER_FILE_NAME)), false);
  const backups = readdirSync(collabDir(dir, 'collab-1')).filter((name) => name.startsWith(`${LEDGER_FILE_NAME}.corrupt-`));
  assert.equal(backups.length, 1);
});
