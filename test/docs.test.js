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

test('README：数据目录与单核说明（WAYSTATION_HOME、槽位历史布局与身份名）', () => {
  const text = readFileSync(join(repoRoot, 'README.md'), 'utf8');
  assert.ok(text.includes('WAYSTATION_HOME'), 'README 开发节须说明显式数据目录');
  assert.ok(text.includes('sites/'), 'README 须说明旧槽位目录布局（停用为历史只读面）');
  assert.ok(text.includes('identityName'), 'README 须说明身份名默认为机器名、可用 identityName 自定义');
});

test('README：单机一核与桥节齐备（核心管理口 / 常驻开关 / 离线语义 / 逃生门）', () => {
  const text = readFileSync(join(repoRoot, 'README.md'), 'utf8');
  assert.ok(text.includes('单机一核与桥'), '单核与桥节写入文档');
  assert.ok(text.includes('waystation core status') && text.includes('waystation core stop'), '核心管理口（core status / core stop）写入文档');
  assert.ok(text.includes('persistentCore'), '常驻开关（persistentCore）写入文档');
  assert.ok(text.includes('推停拉不停'), '离线语义修订（推停拉不停、不追发）写入文档');
  assert.ok(text.includes('关全部旧会话 → 重跑安装脚本 → 重开'), '升级换代推荐顺序写入文档');
});

test('README：披露锚句与安装/状态栏/卸载/迁移文档面齐备（防腐化）', () => {
  const text = readFileSync(join(repoRoot, 'README.md'), 'utf8');
  assert.ok(text.includes('建议仅在可信网络使用'), '安全披露锚句保持（发布义务）');
  assert.ok(text.includes('statusline.js'), '状态栏配置段指向读取脚本');
  assert.ok(text.includes('waystation uninstall'), '卸载命令面写入文档');
  assert.ok(text.includes('/ws-collab'), '随安装分发的斜杠命令（/ws-collab）写入文档');
  assert.ok(text.includes('/ws-discuss') && text.includes('/ws-mute'), '讨论 / 静音命令（/ws-discuss、/ws-mute）写入文档');
  assert.ok(text.includes('讨论模式（forum）'), '讨论模式节写入文档');
  assert.ok(text.includes('如实披露（讨论模式）'), '讨论模式披露逐条写入文档');
  assert.ok(text.includes('waystation purge-data'), '清空数据命令（purge-data，保留身份与安装）写入文档');
  assert.ok(text.includes('install\\setup.ps1'), '智能安装入口（setup.ps1）写入文档');
  assert.ok(text.includes('以本命令为准'), '卸载命令交付口径在文档（自定义 WAYSTATION_HOME 时以本命令为准，非「设计中」措辞）');
  assert.ok(text.includes('自介') && text.includes('升级与迁移'), '改端口旧站点的迁移注意在文档');
});

test('README：本机可见性与静音标记写入文档（列表本机段 / 同机标注与发现边界 / 状态栏 🔇）', () => {
  const text = readFileSync(join(repoRoot, 'README.md'), 'utf8');
  assert.ok(text.includes('本机段'), 'README 须说明 ws_list_hosts 列表含本机段');
  assert.ok(text.includes('sameMachine'), 'README 须说明同机实例的标注字段');
  assert.ok(text.includes('同机实例扫不到'), '同机实例的发现边界须如实写入（未接触且不在扫描段内则扫不到）');
  assert.ok(text.includes('🔇'), '状态栏静音标记写入文档');
});

test('README：确认门命令、默认值与 join 自动走完边界齐备', () => {
  const text = readFileSync(join(repoRoot, 'README.md'), 'utf8');
  assert.ok(text.includes('/ws-invite-confirm'));
  assert.ok(text.includes('/ws-join-confirm'));
  assert.ok(text.includes('inviteConfirmation'));
  assert.ok(text.includes('joinRequestConfirmation'));
  assert.ok(text.includes('不指名'));
  assert.ok(text.includes('自动走完'));
  assert.ok(text.includes('旧命令'));
});

test('README：dispatch 模式、角色、无历史边界与微信集成责任齐备', () => {
  const text = readFileSync(join(repoRoot, 'README.md'), 'utf8');
  assert.ok(text.includes('调度（dispatch）模式（本机多会话编排）'), '调度（dispatch）模式节写入文档');
  assert.ok(text.includes('WAYSTATION_ROLE=master'), 'master 启动期角色写入文档');
  assert.ok(text.includes('WAYSTATION_ROLE=slave'), 'slave 启动期角色写入文档');
  assert.ok(text.includes('不保存历史'), '无历史边界写入文档');
  assert.ok(text.includes('--allowed-tools'), '无头 worker 的 allowed-tools 模板写入文档');
  assert.ok(text.includes('微信'), '微信推送的集成责任写入文档');
  assert.ok(text.includes('sessionCode') && text.includes('群发'), '会话短码定向与省略即群发写入文档');
  assert.ok(text.includes('burst_limit') && text.includes('ret=-2'), '微信侧人工验证项（burst_limit / ret=-2）写入文档');
});

test('README：人类观察窗节齐备（命令/启动器/开关/日志排查/发送方提示/升级重跑）', () => {
  const text = readFileSync(join(repoRoot, 'README.md'), 'utf8');
  assert.ok(text.includes('/ws-view'), '观察窗命令（/ws-view）写入文档');
  assert.ok(text.includes('人类观察窗（Web 查看器）'), '观察窗节写入文档');
  assert.ok(text.includes('ws-view.vbs'), '双击启动器（ws-view.vbs）写入文档');
  assert.ok(text.includes('http://127.0.0.1:7330/'), '默认地址写入文档');
  assert.ok(text.includes('--no-open') && text.includes('--stop'), '观察窗开关（--no-open / --stop）写入文档');
  assert.ok(text.includes('裸 `--stop` 停不到'), '裸 --stop 停不到自定义端口实例的边界写入文档');
  assert.ok(text.includes('%TEMP%\\ws-view.log'), '双击无反应看 %TEMP%\\ws-view.log 写入文档');
  assert.ok(text.includes('==高亮=='), '发送方标准 Markdown 提示写入文档');
  assert.ok(text.includes('重跑一次安装脚本'), '升级与迁移节补「既有安装需重跑安装脚本」');
});
