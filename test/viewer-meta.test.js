import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metaViewOf } from '../src/viewer/meta.js';

/* 席面口径三分支（与终端查看器既有行为同源）：成员记录缺席看台账 / 管理席位看台账（退出态优先）/
 * 其余看参与记录；两者都不可读 = 未就绪（null）。 */

test('成员记录与台账都不可读 → null（未就绪）', () => {
  assert.equal(metaViewOf(null, null), null);
});

test('成员记录缺席 + 台账在 → 取台账名与状态', () => {
  assert.deepEqual(metaViewOf({ name: '台账名甲', status: 'active' }, null), { name: '台账名甲', state: 'active' });
});

test('管理席位 + 台账在 → 名取台账、态取台账状态', () => {
  const ledger = { name: '台账名甲', status: 'frozen' };
  const member = { role: 'manager', name: '记录名乙', state: 'member' };
  assert.deepEqual(metaViewOf(ledger, member), { name: '台账名甲', state: 'frozen' });
});

test('管理席位已退出：态取 left（退出优先），名仍取台账', () => {
  const ledger = { name: '台账名甲', status: 'active' };
  const member = { role: 'manager', name: '记录名乙', state: 'left' };
  assert.deepEqual(metaViewOf(ledger, member), { name: '台账名甲', state: 'left' });
});

test('管理席位但台账缺失 → 退回参与记录（降级如实呈现）', () => {
  const member = { role: 'manager', name: '记录名乙', state: 'active' };
  assert.deepEqual(metaViewOf(null, member), { name: '记录名乙', state: 'active' });
});

test('成员席位 → 取参与记录的名与态（台账在也不取）', () => {
  const ledger = { name: '台账名甲', status: 'completed' };
  const member = { role: 'member', name: '记录名乙', state: 'proposed' };
  assert.deepEqual(metaViewOf(ledger, member), { name: '记录名乙', state: 'proposed' });
});
