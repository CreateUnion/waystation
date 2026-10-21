import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir } from './helpers.js';
import {
  CARRIER_FILE_NAME,
  CARRIER_FORMATS,
  CARRIER_FORMAT_INVITE_STUB,
  CARRIER_FORMAT_SESSION_SEATS,
  carrierPath,
  isCarrierShape,
  readCarrier,
  readCarrierFormat,
  writeCarrier,
} from '../src/collab/carrier.js';

const TS = '2026-10-21T08:00:00.000Z';

function sampleCarrier(overrides = {}) {
  return {
    format: CARRIER_FORMAT_SESSION_SEATS,
    version: 1,
    collabId: 'collab-1',
    name: '联调项目',
    topic: '发布联调',
    mode: 'managed',
    endpoints: { 'inst-a': { address: '127.0.0.1', port: 17321 } },
    manager: { instanceId: 'inst-a', sessionId: 'session-a', identityName: '主机甲', term: 1 },
    originator: { instanceId: 'inst-a', sessionId: 'session-a', identityName: '主机甲' },
    forumMeta: { createdAt: TS },
    syncCursor: { ts: TS, postId: 'post-1' },
    snapshotVersion: 3,
    createdAt: TS,
    ...overrides,
  };
}

/* 每个用例独立目录，绝不触碰真实 ~/.waystation（与仓内其它用例同一纪律）。 */
function collabDirOf(t) {
  const dir = join(makeTempDir(t), 'collab-1');
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('carrier 形态：session-seats 全字段与 invite-stub 最小形态均通过', () => {
  assert.deepEqual(CARRIER_FORMATS, [CARRIER_FORMAT_SESSION_SEATS, CARRIER_FORMAT_INVITE_STUB]);
  assert.equal(isCarrierShape(sampleCarrier()), true);
  const stub = {
    format: CARRIER_FORMAT_INVITE_STUB,
    version: 1,
    collabId: 'collab-2',
    name: '受邀项目',
    topic: '待入席',
    mode: 'managed',
    endpoints: {},
    snapshotVersion: 0,
    createdAt: TS,
  };
  assert.equal(isCarrierShape(stub), true);
});

test('carrier 形态：逐字段非法一律拒绝，不做清洗', () => {
  const mutations = [
    ['顶层非对象', null],
    ['未知 format', { format: 'member-v1' }],
    ['version 非正整数', { version: 0 }],
    ['collabId 非法', { collabId: 'bad id' }],
    ['name 空串', { name: '   ' }],
    ['topic 空串', { topic: '' }],
    ['mode 非法', { mode: 'group' }],
    ['endpoints 非对象', { endpoints: [] }],
    ['endpoint 缺地址', { endpoints: { 'inst-a': { address: '', port: 17321 } } }],
    ['endpoint 端口越界', { endpoints: { 'inst-a': { address: '127.0.0.1', port: 0 } } }],
    ['manager 缺 sessionId', { manager: { instanceId: 'inst-a', identityName: '主机甲', term: 1 } }],
    ['manager term 非正整数', { manager: { instanceId: 'inst-a', sessionId: 'session-a', identityName: '主机甲', term: 0 } }],
    ['originator 缺 sessionId', { originator: { instanceId: 'inst-a', identityName: '主机甲' } }],
    ['forumMeta 时间非法', { forumMeta: { createdAt: 'not-a-time' } }],
    ['syncCursor 形态非法', { syncCursor: { ts: TS, postId: 'bad id' } }],
    ['snapshotVersion 负数', { snapshotVersion: -1 }],
    ['createdAt 非法', { createdAt: 'yesterday' }],
  ];
  for (const [label, patch] of mutations) {
    const value = patch === null ? null : sampleCarrier(patch);
    assert.equal(isCarrierShape(value), false, `应拒绝：${label}`);
  }
});

test('carrier 读写：原子落盘后可完整读回，临时文件不残留', (t) => {
  const dir = collabDirOf(t);
  const carrier = sampleCarrier();
  writeCarrier(dir, carrier);
  assert.equal(existsSync(carrierPath(dir)), true);
  assert.equal(carrierPath(dir), join(dir, CARRIER_FILE_NAME));

  const loaded = readCarrier(dir);
  assert.equal(loaded.status, 'ok');
  assert.deepEqual(loaded.carrier, carrier);
  assert.equal(readCarrierFormat(dir), CARRIER_FORMAT_SESSION_SEATS);

  const leftovers = readdirSync(dir).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('carrier 写：目录不存在时按需创建', (t) => {
  const dir = join(makeTempDir(t), 'nested', 'collab-9');
  writeCarrier(dir, sampleCarrier({ collabId: 'collab-9' }));
  assert.equal(readCarrier(dir).status, 'ok');
});

test('carrier 写：形态非法抛 TypeError 且不落盘', (t) => {
  const dir = collabDirOf(t);
  assert.throws(() => writeCarrier(dir, sampleCarrier({ format: 'bad' })), TypeError);
  assert.equal(existsSync(carrierPath(dir)), false);
});

test('carrier 读：缺失与损坏可区分，损坏不抛出', (t) => {
  const dir = collabDirOf(t);
  assert.deepEqual(readCarrier(dir), { status: 'missing', carrier: null });
  assert.equal(readCarrierFormat(dir), null);

  writeFileSync(carrierPath(dir), '{ not json');
  const corrupt = readCarrier(dir);
  assert.equal(corrupt.status, 'corrupt');
  assert.equal(corrupt.carrier, null);
  assert.equal(typeof corrupt.error, 'string');
  assert.equal(readCarrierFormat(dir), null);
});

test('carrier format 标记：只认两种 format，不要求整档形态通过', (t) => {
  const dir = collabDirOf(t);
  writeFileSync(carrierPath(dir), JSON.stringify({ format: CARRIER_FORMAT_SESSION_SEATS, version: 0 }));
  assert.equal(readCarrierFormat(dir), CARRIER_FORMAT_SESSION_SEATS);
  assert.equal(readCarrier(dir).status, 'corrupt');

  writeFileSync(carrierPath(dir), JSON.stringify({ format: 'member-v1' }));
  assert.equal(readCarrierFormat(dir), null);
});

test('carrier 写：替换既有文件后读到的永远是完整新版', (t) => {
  const dir = collabDirOf(t);
  writeCarrier(dir, sampleCarrier({ name: '旧名' }));
  const next = sampleCarrier({ name: '新名', snapshotVersion: 8 });
  writeCarrier(dir, next);
  assert.deepEqual(readCarrier(dir).carrier, next);
});
