import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayText } from '../src/viewer/text.js';

/* 终端口径（marker）：换行类字符替换为 ⏎、控制 / 格式类字符剥除、ZWJ 保留——语料与终端查看器
 * 既有行为对齐（该模块提取后是两个查看器共用的单一权威，终端查看器的 spawn E2E 是回归护栏）。 */

test('marker：四种换行类字符（LF / CR / U+2028 / U+2029）均替换为 ⏎', () => {
  assert.equal(displayText('甲\n乙', { newlines: 'marker' }), '甲⏎乙');
  assert.equal(displayText('甲\r乙', { newlines: 'marker' }), '甲⏎乙');
  assert.equal(displayText('甲\u2028乙', { newlines: 'marker' }), '甲⏎乙');
  assert.equal(displayText('甲\u2029乙', { newlines: 'marker' }), '甲⏎乙');
});

test('marker：CRLF 是两个换行类字符——替换为两个 ⏎（终端既有行为不变）', () => {
  assert.equal(displayText('甲\r\n乙', { newlines: 'marker' }), '甲⏎⏎乙');
});

test('marker：控制类字符剥除（C0 / DEL / C1，含可作终端 CSI 的 U+009B）', () => {
  assert.equal(displayText('A\u0000\u0007\u001b\u007fB\u0085\u009bC', { newlines: 'marker' }), 'ABC');
});

test('marker：格式类字符剥除（双向重排 RLO / 零宽类）', () => {
  assert.equal(displayText('A\u202eB\u200bC\ufeffD', { newlines: 'marker' }), 'ABCD');
});

test('marker：ZWJ（U+200D）保留——ZWJ emoji 组合序列整体保留', () => {
  assert.equal(displayText('组合 👨\u200d👩\u200d👧', { newlines: 'marker' }), '组合 👨\u200d👩\u200d👧');
  assert.equal(displayText('夹在文本间 a\u200db 的零宽连接符', { newlines: 'marker' }), '夹在文本间 a\u200db 的零宽连接符');
});

test('marker：普通文本 / 中文 / emoji / 变体选择符原样保留（空串返回空串）', () => {
  assert.equal(displayText('', { newlines: 'marker' }), '');
  assert.equal(displayText('普通正文 with ASCII 与 emoji 😀', { newlines: 'marker' }), '普通正文 with ASCII 与 emoji 😀');
  assert.equal(displayText('❤\ufe0f', { newlines: 'marker' }), '❤\ufe0f');
});

/* Web 口径（keep）：换行（CRLF / 孤立 CR / U+2028 / U+2029）归一为 \n 后保留；
 * 控制 / 格式类剥除规则与 marker 一致（\n 属 Cc，但归一后必须留下）。 */

test('keep：CRLF 归一为单个换行（不重复计数；连续空行保留）', () => {
  assert.equal(displayText('甲\r\n乙', { newlines: 'keep' }), '甲\n乙');
  assert.equal(displayText('甲\r\n\r\n乙', { newlines: 'keep' }), '甲\n\n乙');
});

test('keep：孤立 CR 与 U+2028 / U+2029 归一为换行', () => {
  assert.equal(displayText('甲\r乙', { newlines: 'keep' }), '甲\n乙');
  assert.equal(displayText('甲\u2028乙', { newlines: 'keep' }), '甲\n乙');
  assert.equal(displayText('甲\u2029乙', { newlines: 'keep' }), '甲\n乙');
});

test('keep：既有换行保留（归一后不被控制类剥除规则剔除）', () => {
  assert.equal(displayText('甲\n乙', { newlines: 'keep' }), '甲\n乙');
  assert.equal(displayText('\n开头与收尾\n', { newlines: 'keep' }), '\n开头与收尾\n');
});

test('keep：控制 / 格式类剥除规则与 marker 一致', () => {
  assert.equal(displayText('A\u009bB\u202eC\u200bD\u007fE', { newlines: 'keep' }), 'ABCDE');
});

test('keep：ZWJ 保留——ZWJ emoji 组合序列整体保留', () => {
  assert.equal(displayText('👨\u200d👩\u200d👧', { newlines: 'keep' }), '👨\u200d👩\u200d👧');
});

test('keep：混合语料——换行归一与控制 / 格式类剥除并存', () => {
  assert.equal(displayText('甲\r\n乙\u2028丙\u202e丁\u009b\n戊', { newlines: 'keep' }), '甲\n乙\n丙丁\n戊');
});
