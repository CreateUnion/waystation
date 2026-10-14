import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INDEX_HTML, APP_JS, STYLE_CSS } from '../src/viewer/assets.js';

/* 页面资产是内嵌字符串：宿主层能自动化的是语法自检、契约锚点与嵌入纪律反断言。
 * 客户端行为（跟随/暂停/浮标/字号持久/跨日分隔）要在浏览器里逐项过——入人验收单，不做 DOM 模拟。 */

test('客户端脚本：new Function 包装只解析不执行（语法自检）', () => {
  assert.doesNotThrow(() => new Function(APP_JS));   // 构造即解析；返回的函数绝不调用
});

/* 锚点＝客户端与服务端契约的字符串级证据：端点、游标参数、路由前缀、持久化键、滚动协议、
 * 方向标、浮标文案。任一处被重命名（服务端换端点、客户端换键），这里先红。 */
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
    '→',
    '←',
    '条新消息 ↓',
    '暂停',
    '恢复',
  ];
  for (const anchor of anchors) {
    assert.ok(APP_JS.includes(anchor), '缺少锚点：' + anchor);
  }
});

test('页面壳：三处挂载点与字号三键齐备', () => {
  for (const id of ['list-view', 'detail-view', 'event-track']) {
    assert.ok(INDEX_HTML.includes('id="' + id + '"'), '缺少挂载点：' + id);
  }
  for (const label of ['A＋', 'A−', '重置']) {
    assert.ok(INDEX_HTML.includes(label), '缺少字号控制键：' + label);
  }
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

test('嵌入纪律：客户端脚本无反引号与模板插值序列（防宿主层自咬）', () => {
  assert.ok(!APP_JS.includes('`'), '客户端脚本不得含反引号');
  assert.ok(!APP_JS.includes('$' + '{'), '客户端脚本不得含模板插值序列');
});

test('嵌入纪律：三资产零外部资源（无 http(s) 外链）', () => {
  for (const asset of [INDEX_HTML, APP_JS, STYLE_CSS]) {
    assert.ok(!asset.includes('http://'), '资产不得含 http:// 外链');
    assert.ok(!asset.includes('https://'), '资产不得含 https:// 外链');
  }
});

/* 渲染安全纪律的机器可查部分：innerHTML 只允许一处、且来源只认服务端渲染好的 row.html；
 * 其余字段的注入方式由人审逐行核（textContent 锚点断言在契约组）。 */
test('渲染安全：innerHTML 唯一入口是服务端 html 片段', () => {
  const lines = APP_JS.split('\n').filter((line) => line.includes('.innerHTML'));
  assert.equal(lines.length, 1, 'innerHTML 只允许一处（注入服务端 html 片段）');
  assert.ok(lines[0].includes('row.html'), 'innerHTML 的赋值来源只能是 row.html');
});

test('挂载点对账：客户端引用的 id 全部来自页面壳（防漂移）', () => {
  const declared = new Set([...INDEX_HTML.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
  const used = [...APP_JS.matchAll(/getElementById\('([^']+)'\)/g)].map((match) => match[1]);
  assert.ok(used.length >= 8, '客户端应缓存全部挂载点，实际只引用 ' + used.length + ' 个');
  for (const id of used) {
    assert.ok(declared.has(id), '客户端引用了页面壳中不存在的 id：' + id);
  }
});
