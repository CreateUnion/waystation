import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INDEX_HTML, APP_JS, STYLE_CSS } from '../src/viewer/assets.js';

/* 页面资产是内嵌字符串：宿主层能自动化的是语法自检、契约锚点与嵌入纪律反断言。
 * 客户端行为（跟随/暂停/浮标/字号持久/跨日分隔）要在浏览器里逐项过——入人验收单，不做 DOM 模拟。 */

test('客户端脚本：new Function 包装只解析不执行（语法自检）', () => {
  assert.doesNotThrow(() => new Function(APP_JS));   // 构造即解析；返回的函数绝不调用
});

/* 锚点＝客户端与服务端契约的字符串级证据：端点、游标参数、路由前缀、持久化键、滚动协议、
 * 分栏类、浮标文案。任一处被重命名（服务端换端点、客户端换键），这里先红。 */
test('客户端脚本：服务端契约锚点齐备', () => {
  const anchors = [
    '/api/collabs',
    '/api/collab/',
    'after=',
    '#/c/',
    'localStorage',
    'ws-viewer:fontScale',
    'textContent',
    'innerHTML',
    'hashchange',
    'feed-out',
    'feed-in',
    '条新消息 ↓',
    '暂停',
    '恢复',
    '会话流跳过',
  ];
  for (const anchor of anchors) {
    assert.ok(APP_JS.includes(anchor), '缺少锚点：' + anchor);
  }
  assert.ok(!APP_JS.includes('feed-direction'), '方向标（位置已表达方向，冗余）应已移除');
});

/* 会话可见面的字符串级契约：数据面字段名（sessions 四视图）与四段呈现标签、如实零措辞、
 * 类锚点——任一侧改名（服务端换字段、客户端换措辞）这里先红。 */
test('客户端脚本：会话可见面锚点齐备（四视图字段、四段标签与零措辞）', () => {
  for (const anchor of [
    'sessions',
    'localBound',
    'localGranted',
    'grantedRemote',
    'published',
    '本机绑定',
    '本机获准',
    '站长获准名单',
    '远端发布',
    '0 个会话',
    'collab-sessions',
    'banner-sessions',
  ]) {
    assert.ok(APP_JS.includes(anchor), '缺少锚点：' + anchor);
  }
  assert.ok(STYLE_CSS.includes('.collab-sessions'), '缺少列表行会话摘要样式');
  assert.ok(STYLE_CSS.includes('.banner-sessions'), '缺少详情页会话区样式');
});

test('页面壳：三处挂载点与字号三键齐备', () => {
  for (const id of ['list-view', 'detail-view', 'event-track']) {
    assert.ok(INDEX_HTML.includes('id="' + id + '"'), '缺少挂载点：' + id);
  }
  for (const label of ['A＋', 'A−', '重置']) {
    assert.ok(INDEX_HTML.includes(label), '缺少字号控制键：' + label);
  }
});

test('页面壳：返回列表键（同源 hash 链接，客户端接线与样式齐备）', () => {
  assert.ok(/<a id="app-back" href="#\/" hidden>/.test(INDEX_HTML), '缺少返回键挂载点或 href 非 #/');
  assert.ok(APP_JS.includes("getElementById('app-back')"), '客户端须接线返回键');
  assert.ok(APP_JS.includes("dom.back.hidden = route.view !== 'detail'"), '返回键须按路由切换显隐');
  assert.ok(STYLE_CSS.includes('#app-back'), '缺少返回键样式');
});

/* 任务书「无 <script src=」按「无外部脚本引用」落地：页面必须引同源相对资产 /app.js（服务端直出），
 * 断言收紧为白名单——脚本引用只允许恰为 /app.js 这一条，任何其它来源即红。 */
test('页面壳：脚本引用恰为同源相对资产 /app.js', () => {
  const sources = [...INDEX_HTML.matchAll(/<script\b[^>]*\bsrc\s*=\s*"([^"]*)"/g)].map((match) => match[1]);
  assert.deepEqual(sources, ['/app.js'], '脚本只允许引同源 /app.js，不得出现外部脚本来源');
});

test('样式：主题变量、色签 8 色、长串兜底齐备', () => {
  assert.ok(STYLE_CSS.includes(':root'), '缺少主题变量锚点 :root');
  for (let index = 0; index < 8; index++) {
    assert.ok(STYLE_CSS.includes('.chip-' + index), '缺少色签类：.chip-' + index);
  }
  assert.ok(STYLE_CSS.includes('overflow-wrap'), '缺少超长串兜底 overflow-wrap');
});

/* 聊天分栏的机器可查部分：左右对齐、气泡限宽、宽内容不破版（表格/代码滚动）、
 * 系统行居中；DOM 侧（viewer-assets-dom.test.js）盖结构与类，观感仍入人验收单。 */
test('样式：聊天式分栏与气泡溢出兜底齐备（窄窗/长内容不破版）', () => {
  assert.ok(/\.feed-out\s*\{[^}]*justify-content:\s*flex-end/.test(STYLE_CSS), 'out 行靠右');
  assert.ok(/\.feed-in\s*\{[^}]*justify-content:\s*flex-start/.test(STYLE_CSS), 'in 行靠左');
  assert.ok(/\.feed-bubble\s*\{[^}]*max-width:\s*76%/.test(STYLE_CSS), '气泡限宽 ~76%');
  assert.ok(/\.feed-bubble\s*\{[^}]*overflow-wrap:\s*anywhere/.test(STYLE_CSS), '气泡内长串可断');
  assert.ok(/\.md-table\s*\{[^}]*overflow-x:\s*auto/.test(STYLE_CSS), '宽表格在气泡内横向滚动');
  /* 用色断言钉到选择器规则体内：只查变量是否定义拦不住「变量在、规则没接线」的漂移。 */
  assert.ok(/\.feed-out\s+\.feed-bubble\s*\{[^}]*background:\s*var\(--bg-accent\)/.test(STYLE_CSS), '本机气泡用主色淡底');
  assert.ok(/\.feed-in\s+\.feed-bubble\s*\{[^}]*border-left[^}]*var\(--chip-color/.test(STYLE_CSS), '对方气泡边缘取作者色变量');
  assert.ok(/\.chip-name\s*\{[^}]*color:\s*var\(--chip-color/.test(STYLE_CSS), '色签名字色取作者色变量');
  assert.ok(/\.day-row\s*\{[^}]*text-align:\s*center/.test(STYLE_CSS), '日期分隔行居中');
  assert.ok(/\.event-row\s*\{[^}]*justify-content:\s*center/.test(STYLE_CSS), '系统事件行居中');
  assert.ok(/\.event-skipped\s*\{[^}]*text-align:\s*center/.test(STYLE_CSS), '跳过提示行居中');
  assert.ok(!STYLE_CSS.includes('feed-direction'), '方向标样式随冗余箭头一并移除');
});

test('嵌入纪律：客户端脚本无反引号与模板插值序列（防宿主层自咬）', () => {
  assert.ok(!APP_JS.includes('`'), '客户端脚本不得含反引号');
  assert.ok(!APP_JS.includes('$' + '{'), '客户端脚本不得含模板插值序列');
});

/* 零外部资源反断言（任务书嵌入纪律）：外链不只 http(s) 一种形态——协议相对 URL（"//host）、
 * data: 内联资源、CSS 的 @import 与 url(...)、iframe 的 srcdoc 都是外部资源/注入面，
 * 一并按可判定字符串拦下。 */
test('嵌入纪律：三资产零外部资源（协议相对 / data: / 内联资源语法）', () => {
  for (const asset of [INDEX_HTML, APP_JS, STYLE_CSS]) {
    for (const token of ['http://', 'https://', 'srcdoc', 'data:', '@import', 'url(']) {
      assert.ok(!asset.includes(token), '资产出现外部资源形态：' + token);
    }
    assert.ok(!asset.includes('"//'), '出现协议相对 URL（双引号形态）');
    assert.ok(!asset.includes("'//"), '出现协议相对 URL（单引号形态）');
  }
  // 无引号属性值的协议相对 URL（如 <script src=//evil…>、meta refresh 的 content=…url=//evil…）
  // 不带任何引号，上面两种带引号形态都扫不到——按 "=//" 直接拦下这最后一个缝隙。
  assert.ok(!INDEX_HTML.includes('=//'), '页面壳出现无引号形态的协议相对 URL（=//）');
});

/* 页面壳里的每个 src/href 值都必须是同源相对路径（以 / 开头且非 //）或页内片段（#…，hash 路由
 * 不产生网络请求）：覆盖单引号属性与大写 SRC=/HREF= 写法——任何外部来源（http(s)、协议相对、
 * data:）都通不过。
 * 无引号属性值（如 src= //evil…，HTML5 合法且浏览器会真实外发）不带引号、躲开带引号匹配，
 * 一并按无引号形态扫描——否则未来编辑引入无引号外链不会被任何断言拦下。 */
test('页面壳：全部 src/href 引用值同源相对（含无引号形态）', () => {
  const values = [...INDEX_HTML.matchAll(/\b(?:src|href)\s*=\s*(["'])([^"']*)\1/gi)].map((match) => match[2]);
  assert.ok(values.length >= 2, '页面壳应至少含样式与脚本两条引用，实际 ' + values.length + ' 条');
  const bare = [...INDEX_HTML.matchAll(/\b(?:src|href)\s*=\s*([^\s"'>]+)/gi)].map((match) => match[1]);
  for (const value of [...values, ...bare]) {
    const sameOrigin = (value.startsWith('/') && !value.startsWith('//')) || value.startsWith('#');
    assert.ok(sameOrigin, '引用值必须是同源相对路径或页内片段（含无引号形态）：' + value);
  }
});

test('页面壳：无图片 / 框架类标签（零外发请求的静态壳）', () => {
  for (const tag of ['<img', '<iframe', '<object', '<embed', '<video', '<audio']) {
    assert.ok(!INDEX_HTML.toLowerCase().includes(tag), '页面壳不得含 ' + tag + ' 标签');
  }
});

/* 渲染安全纪律的机器可查部分：innerHTML 只允许一处「赋值」、且来源只认服务端渲染好的
 * row.html。只看代码行（滤掉注释行）——注释里提到 innerHTML 是纪律说明，不是注入面；
 * 其余字段的注入方式由人审逐行核（textContent 锚点断言在契约组）。 */
const isCommentLine = (line) => {
  const trimmed = line.trim();
  return trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('//');
};

test('渲染安全：innerHTML 唯一入口是服务端 html 片段', () => {
  const code = APP_JS.split('\n').filter((line) => !isCommentLine(line)).join('\n');
  const assignments = code.match(/\.innerHTML\s*=/g) || [];
  assert.equal(assignments.length, 1, 'innerHTML 赋值只允许一处（注入服务端 html 片段）');
  const line = code.split('\n').find((text) => text.includes('.innerHTML'));
  assert.ok(line.includes('row.html'), 'innerHTML 的赋值来源只能是 row.html：' + line);
});

test('挂载点对账：客户端引用的 id 全部来自页面壳（防漂移）', () => {
  const declared = new Set([...INDEX_HTML.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
  const used = [...APP_JS.matchAll(/getElementById\('([^']+)'\)/g)].map((match) => match[1]);
  assert.ok(used.length >= 8, '客户端应缓存全部挂载点，实际只引用 ' + used.length + ' 个');
  for (const id of used) {
    assert.ok(declared.has(id), '客户端引用了页面壳中不存在的 id：' + id);
  }
});
