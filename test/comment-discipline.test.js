import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/* 开发过程编号不得进代码注释（CS-08）：溯源属于 commit 与文档，注释只讲「为什么」。
 * 技术文档出处（设计章节 / ADR / TRM 章节）是「为什么」的证据，不在拦截范围。
 * 只扫 src/ 与 bin/（同 stdout 纪律扫描口径）：测试夹具会刻意构造违规样本串。 */
const PLAN_REFERENCE_PATTERN = /批次\s*\d|WP-\d+|\bG\d+\b|\bT\d+\b|\bM[1-9]\b/;

// 目录缺失返回空列表：起步阶段 src/ 可能尚不存在属预期；终态由下方「扫描非空」断言兜底
function listSourceFiles(relativeDir) {
  const root = join(repoRoot, relativeDir);
  if (!existsSync(root)) {
    return [];
  }
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(join(relativeDir, entry.name)));
    } else if (entry.name.endsWith('.js')) {
      files.push(full);
    }
  }
  return files;
}

test('注释编号扫描 matcher 自检：语义正确（防止扫描本身失灵）', () => {
  assert.equal(PLAN_REFERENCE_PATTERN.test('批次 2 S5 修复'), true);
  assert.equal(PLAN_REFERENCE_PATTERN.test('WP-14 要求'), true);
  assert.equal(PLAN_REFERENCE_PATTERN.test('G25'), true);
  assert.equal(PLAN_REFERENCE_PATTERN.test('T6 M-2'), true);
  /* 裸任务编号分支（T+数字）的正/负例：该分支被误删时本自检必须红（判别力） */
  assert.equal(PLAN_REFERENCE_PATTERN.test('T6 的接线'), true, '裸任务编号命中');
  assert.equal(PLAN_REFERENCE_PATTERN.test('T12 收口'), true, '两位编号命中');
  assert.equal(PLAN_REFERENCE_PATTERN.test('UTF-8 编码'), false, '词内 T+数字不误报（词边界）');
  assert.equal(PLAN_REFERENCE_PATTERN.test('fmt2 模板'), false, '小写 t 不误报（大小写敏感）');
  assert.equal(PLAN_REFERENCE_PATTERN.test('M2 接入台账'), true);
  assert.equal(PLAN_REFERENCE_PATTERN.test('设计 §13 尾部半行截断'), false);
  assert.equal(PLAN_REFERENCE_PATTERN.test('端口 7321'), false);
  assert.equal(PLAN_REFERENCE_PATTERN.test('MAX_FRAME_BYTES'), false);
});

test('注释纪律：src/ 与 bin/ 中不得出现计划/任务/里程碑编号引用', () => {
  const scanned = [...listSourceFiles('src'), ...listSourceFiles('bin')];
  assert.ok(scanned.length >= 1, '未扫描到任何源码文件——扫描根缺失或路径写错，测试不得静默通过');
  const offenders = [];
  for (const file of scanned) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, index) => {
      if (PLAN_REFERENCE_PATTERN.test(text)) {
        offenders.push(`${file}:${index + 1}: ${text.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, []);
});
