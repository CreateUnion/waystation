import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANCHOR_PORT, SLOT_COUNT, slotDefaultPort } from '../src/site.js';

test('端口锚点：内置常量与槽位段形状', () => {
  assert.equal(ANCHOR_PORT, 7321);
  assert.equal(SLOT_COUNT, 8);
  assert.equal(slotDefaultPort(1), 7321);
  assert.equal(slotDefaultPort(8), 7328);
});

test('slotDefaultPort：非法槽位抛 TypeError', () => {
  for (const slot of [0, 9, '1', 1.5, null]) {
    assert.throws(() => slotDefaultPort(slot), TypeError, String(slot));
  }
});
