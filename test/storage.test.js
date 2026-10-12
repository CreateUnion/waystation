import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendLine, loadLines, replaceFile, writeJsonAtomic } from '../src/storage.js';
import { makeTempDir } from './helpers.js';

test('appendLine + loadLines：基本往返', (t) => {
  const file = join(makeTempDir(t), 'stream.jsonl');
  appendLine(file, { seq: 1, text: '第一条' });
  appendLine(file, { seq: 2, text: '第二条' });
  appendLine(file, { seq: 3, text: '第三条' });
  const loaded = loadLines(file);
  assert.deepEqual(loaded.entries, [
    { seq: 1, text: '第一条' },
    { seq: 2, text: '第二条' },
    { seq: 3, text: '第三条' },
  ]);
  assert.equal(loaded.tailDropped, false);
  assert.deepEqual(loaded.corruptLines, []);
});

test('appendLine：不可序列化的值（undefined）抛出，不静默写坏行', (t) => {
  const file = join(makeTempDir(t), 'stream.jsonl');
  assert.throws(() => appendLine(file, undefined), /无法序列化为 JSON/);
});

test('文件不存在：视为空存储', (t) => {
  const file = join(makeTempDir(t), 'missing.jsonl');
  const loaded = loadLines(file);
  assert.deepEqual(loaded.entries, []);
  assert.equal(loaded.tailDropped, false);
  assert.deepEqual(loaded.corruptLines, []);
});

test('尾部半行：读取时截断至最后完整行（丢尾条）并修复文件', (t) => {
  const file = join(makeTempDir(t), 'stream.jsonl');
  writeFileSync(file, '{"seq":1}\n{"seq":2}\n{"seq":3');
  const loaded = loadLines(file);
  assert.deepEqual(loaded.entries, [{ seq: 1 }, { seq: 2 }]);
  assert.equal(loaded.tailDropped, true);
  assert.deepEqual(loaded.corruptLines, []);
  assert.equal(readFileSync(file, 'utf8'), '{"seq":1}\n{"seq":2}\n');
});

test('尾部修复后继续追加：不产生粘连行', (t) => {
  const file = join(makeTempDir(t), 'stream.jsonl');
  writeFileSync(file, '{"seq":1}\n{"seq":2}\n{"seq":3');
  loadLines(file);
  appendLine(file, { seq: 4 });
  const loaded = loadLines(file);
  assert.deepEqual(loaded.entries, [{ seq: 1 }, { seq: 2 }, { seq: 4 }]);
  assert.equal(loaded.tailDropped, false);
});

test('整个文件都是半行（无换行）：修复为空文件', (t) => {
  const file = join(makeTempDir(t), 'stream.jsonl');
  writeFileSync(file, '{"seq":1');
  const loaded = loadLines(file);
  assert.deepEqual(loaded.entries, []);
  assert.equal(loaded.tailDropped, true);
  assert.equal(readFileSync(file, 'utf8'), '');
});

test('中间完整坏行：上报 corruptLines 且不修改文件', (t) => {
  const file = join(makeTempDir(t), 'stream.jsonl');
  const content = '{"seq":1}\n{broken}\n{"seq":2}\nnull\n';
  writeFileSync(file, content);
  const loaded = loadLines(file);
  assert.deepEqual(loaded.entries, [{ seq: 1 }, { seq: 2 }]);
  assert.equal(loaded.tailDropped, false);
  assert.deepEqual(loaded.corruptLines, [
    { lineNumber: 2, text: '{broken}' },
    { lineNumber: 4, text: 'null' },
  ]);
  assert.equal(readFileSync(file, 'utf8'), content);
});

test('空行与纯空白行：跳过，不算损坏', (t) => {
  const file = join(makeTempDir(t), 'stream.jsonl');
  writeFileSync(file, '{"seq":1}\n\n   \n{"seq":2}\n');
  const loaded = loadLines(file);
  assert.deepEqual(loaded.entries, [{ seq: 1 }, { seq: 2 }]);
  assert.deepEqual(loaded.corruptLines, []);
});

test('多字节内容尾部修复：按字节截断不出乱码', (t) => {
  const file = join(makeTempDir(t), 'stream.jsonl');
  writeFileSync(file, '{"名":"值"}\n{"残"');
  const loaded = loadLines(file);
  assert.deepEqual(loaded.entries, [{ 名: '值' }]);
  assert.equal(loaded.tailDropped, true);
  assert.equal(readFileSync(file, 'utf8'), '{"名":"值"}\n');
});

test('半行断在多字节字符中间（解码出替换符）：仍能识别并修复，守卫不误判', (t) => {
  const file = join(makeTempDir(t), 'stream.jsonl');
  // 完整行 + 一个被断掉的多字节字符（0xE6 0xAE 为不完整的三字节序列）：写盘共 10 字节，应截断到 8
  writeFileSync(file, Buffer.concat([Buffer.from('{"a":1}\n'), Buffer.from([0xe6, 0xae])]));
  const loaded = loadLines(file);
  assert.deepEqual(loaded.entries, [{ a: 1 }]);
  assert.equal(loaded.tailDropped, true);
  assert.equal(readFileSync(file, 'utf8'), '{"a":1}\n');
});

test('replaceFile：原子替换既有文件、不留临时文件', (t) => {
  const dir = makeTempDir(t);
  const file = join(dir, 'snapshot.json');
  replaceFile(file, '第一版');
  replaceFile(file, '第二版');
  assert.equal(readFileSync(file, 'utf8'), '第二版');
  assert.deepEqual(readdirSync(dir).filter((name) => name.includes('.tmp')), []);
});

test('writeJsonAtomic：对象以可读格式落盘（config.json 用）', (t) => {
  const file = join(makeTempDir(t), 'config.json');
  writeJsonAtomic(file, { port: 7321, identityName: '驿站' });
  const text = readFileSync(file, 'utf8');
  assert.ok(text.endsWith('\n'));
  assert.deepEqual(JSON.parse(text), { port: 7321, identityName: '驿站' });
  assert.ok(text.includes('\n  "port": 7321'));
});
