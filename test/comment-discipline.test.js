import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/* 开发过程编号不得进代码注释（CS-08）：溯源属于 commit 与文档，注释只讲「为什么」。
 * 技术文档出处（设计章节 / ADR / TRM 章节）是「为什么」的证据，不在拦截范围。
 * 只扫 src/ 与 bin/（同 stdout 纪律扫描口径）：测试夹具会刻意构造违规样本串。 */
const PLAN_REFERENCE_PATTERN = /批次\s*\d|WP-\d+|\bG\d+\b|\bT\d+\b|\bM[1-9]\b|\b[NCI]-\d+\b|\bH-[A-Z]\d+\b|\bR\d+\b|\bM-\d+\b/;

/* 迁移期存量基线（跨模块欠账）：下列行是提交树中实际存在的编号引用，由各属主清理。
 * 基线按「相对路径 + 整行文本」精确匹配——同文件新增或改写出的违规不会命中，仍会被拦截；
 * 清理后可逐条删除。新增违规一律不得加入本表（本表只减不增）——未提交工作树里新写入的编号
 * 不属于存量。扫描面扩展后新命中的旧引用直接清理注释里的编号，不扩基线。 */
const LEGACY_OFFENDERS = new Set([
  'src/collab/join.js||/* participants 是 0.2.0 的加法能力字段（三态判定归 M12/M6）：这里只透传，不在名字解析面丢弃。 */',
  'src/collab/local.js||/* 契约面（M2 → 全体）：只给席位事实，不暴露暂存/inbox 运行态。 */',
  'src/collab/local.js||/** 席位变化后同步派生缓存（旧模块仍读 local.role；M3/M5 迁完后它只作兼容读面）。 */',
  'src/core/routing.js||/* toSessions 定向（M3 携）：只投列表中的本机席位；坏目标隔离，不把整帧投给其他席位。 */',
  'src/core/routing.js||* toSessions 是**帧顶层**字段（M3 契约）：字段存在但形态非法时不回落广播——坏目标只隔离自身，',
]);

function relativeOf(file) {
  return file.slice(repoRoot.length).split('\\').join('/');
}

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
  assert.equal(PLAN_REFERENCE_PATTERN.test('M2 接入台账'), true, '里程碑短编号命中');
  assert.equal(PLAN_REFERENCE_PATTERN.test('M-5 注入面'), true, '带连字符的审查编号命中');
  assert.equal(PLAN_REFERENCE_PATTERN.test('（N-1）重发 approve'), true, 'N 系列编号命中');
  assert.equal(PLAN_REFERENCE_PATTERN.test('（C-3）写点纪律'), true, 'C 系列编号命中');
  assert.equal(PLAN_REFERENCE_PATTERN.test('（I-2）注释纪律'), true, 'I 系列编号命中');
  assert.equal(PLAN_REFERENCE_PATTERN.test('R1 跨重启'), true, 'R 系列编号命中');
  assert.equal(PLAN_REFERENCE_PATTERN.test('（H-C6）补扇出'), true, 'H 系列编号命中');
  assert.equal(PLAN_REFERENCE_PATTERN.test('HTTP-2 协议'), false, '词内 H-数字不误报（词边界）');
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
      if (!PLAN_REFERENCE_PATTERN.test(text)) {
        return;
      }
      if (LEGACY_OFFENDERS.has(`${relativeOf(file)}||${text.trim()}`)) {
        return;
      }
      offenders.push(`${file}:${index + 1}: ${text.trim()}`);
    });
  }
  assert.deepEqual(offenders, []);
});
