import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './helpers.js';

const STANDARD_FILE = join(repoRoot, 'docs', '编码规范.md');

test('编码规范文档存在、非空、含必备章节', () => {
  const text = readFileSync(STANDARD_FILE, 'utf8');
  assert.ok(text.length > 1000, '编码规范文档不得为占位空壳');
  for (const heading of ['样板文件', '命名', '函数结构', '注释', '错误处理', '数据结构', '测试', '工具化', '分层边界', '空值惯例', '错误惯例', '命名后缀']) {
    assert.ok(text.includes(`## ${heading}`) || text.includes(`# ${heading}`) || text.includes(`## ${heading} `), `缺少必备章节：${heading}`);
  }
});

test('编码规范文档无模板占位符残留（【】形态）', () => {
  const text = readFileSync(STANDARD_FILE, 'utf8');
  assert.equal(/【[^】]*】/u.test(text), false, '不得残留模板占位符——所有决策须替换为项目实际值');
});

test('README：数据目录与多站点说明（WAYSTATION_HOME 与槽位目录）', () => {
  const text = readFileSync(join(repoRoot, 'README.md'), 'utf8');
  assert.ok(text.includes('WAYSTATION_HOME'), 'README 开发节须说明显式数据目录');
  assert.ok(text.includes('sites/'), 'README 开发节须说明一机多站点目录布局');
});

test('README：披露锚句与安装/状态栏/卸载/迁移文档面齐备（防腐化）', () => {
  const text = readFileSync(join(repoRoot, 'README.md'), 'utf8');
  assert.ok(text.includes('建议仅在可信网络使用'), '安全披露锚句保持（发布义务）');
  assert.ok(text.includes('statusline.js'), '状态栏配置段指向读取脚本');
  assert.ok(text.includes('waystation uninstall'), '卸载命令面写入文档');
  assert.ok(text.includes('自介') && text.includes('升级与迁移'), '改端口旧站点的迁移注意在文档');
});
