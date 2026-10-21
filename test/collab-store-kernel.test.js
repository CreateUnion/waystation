import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { collabDir, collabFilePath } from '../src/paths.js';
import { LEDGER_FILE_NAME, appendLedger, loadLedger } from '../src/collab/store.js';
import { makeTempDir } from './helpers.js';

const AT = '2026-10-21T00:00:00.000Z';

function ledgerOf(version, overrides = {}) {
  return {
    version,
    collabId: 'collab-1',
    name: '联调项目',
    topic: '发布联调',
    status: 'proposed',
    managerTerm: 1,
    joinSeqNext: 2,
    manager: { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '主机甲', term: 1 },
    members: [
      { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '主机甲', role: 'manager', state: 'member', joinSeq: 1, joinedAt: AT },
      { instanceId: 'inst-b', sessionId: 'sess-b', identityName: '主机乙', role: 'member', state: 'member', joinSeq: 2, joinedAt: AT },
    ],
    board: [],
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function legacyLedgerOf() {
  return {
    version: 1,
    collabId: 'collab-1',
    name: '联调项目',
    topic: '发布联调',
    status: 'proposed',
    manager: { instanceId: 'inst-a', identityName: '主机甲' },
    members: [
      { instanceId: 'inst-a', identityName: '主机甲', role: 'manager', state: 'member', joinedAt: AT },
    ],
    board: [],
    createdAt: AT,
    updatedAt: AT,
  };
}

test('loadLedger：新形态台账取最后一条合法行', (t) => {
  const dir = makeTempDir(t);
  mkdirSync(collabDir(dir, 'collab-1'), { recursive: true });
  appendLedger(dir, ledgerOf(1));
  appendLedger(dir, ledgerOf(2, { status: 'active' }));
  const loaded = loadLedger(dir, 'collab-1');
  assert.deepEqual(loaded, { ledger: loaded.ledger, corrupt: false });
  assert.equal(loaded.ledger.version, 2);
  assert.equal(loaded.badLines, undefined, '干净加载不追加告警字段');
});

test('loadLedger：最后合法行之后的形态坏行计入 badLines，加载仍回退到最后合法行', (t) => {
  const dir = makeTempDir(t);
  mkdirSync(collabDir(dir, 'collab-1'), { recursive: true });
  appendLedger(dir, ledgerOf(1));
  appendFileSync(collabFilePath(dir, 'collab-1', LEDGER_FILE_NAME), `${JSON.stringify({ version: 2, collabId: 'collab-1' })}\n`);
  appendFileSync(collabFilePath(dir, 'collab-1', LEDGER_FILE_NAME), '{"half');
  const loaded = loadLedger(dir, 'collab-1');
  assert.equal(loaded.corrupt, false);
  assert.equal(loaded.ledger.version, 1);
  assert.equal(loaded.badLines, 1, '完整坏行计入；半写尾行由存储层截断，不重复告警');
});

test('loadLedger：整档旧形态（无 managerTerm/席位）→ corrupt，且不改写文件（legacy 归 M8）', (t) => {
  const dir = makeTempDir(t);
  mkdirSync(collabDir(dir, 'collab-1'), { recursive: true });
  const file = collabFilePath(dir, 'collab-1', LEDGER_FILE_NAME);
  writeFileSync(file, `${JSON.stringify(legacyLedgerOf())}\n`);
  const before = readFileSync(file, 'utf8');
  const loaded = loadLedger(dir, 'collab-1');
  assert.equal(loaded.ledger, null);
  assert.equal(loaded.corrupt, true);
  assert.equal(readFileSync(file, 'utf8'), before, '加载只读，不静默清洗/隔离');
});

test('loadLedger：不存在或空文件 → 干净空，无告警字段', (t) => {
  const dir = makeTempDir(t);
  mkdirSync(collabDir(dir, 'collab-1'), { recursive: true });
  assert.deepEqual(loadLedger(dir, 'collab-1'), { ledger: null, corrupt: false });
  writeFileSync(collabFilePath(dir, 'collab-1', LEDGER_FILE_NAME), '');
  assert.deepEqual(loadLedger(dir, 'collab-1'), { ledger: null, corrupt: false });
});
