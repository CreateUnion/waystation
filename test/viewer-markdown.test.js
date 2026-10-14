import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../src/viewer/markdown.js';

/* 判别语料（设计 §7 封闭清单）：结构 golden、非标准语法字面语料、XSS 语料、边界与压测。
 * 输入前提＝已过 displayText(text, { newlines: 'keep' })：控制 / 格式字符已剥、换行归一为 \n。 */

/* 不变量一：输出里的标签只允许来自渲染器自身——剥去本模块会产出的标签后，正文不得残留原始 < > " '。
 * 逃逸优先下任何注入都逃不出文本区，这条不变量即是 XSS 语料的公共判据。 */
const OWN_TAG_PATTERN = /<\/?(?:p|h[1-6]|ul|ol|li|blockquote|pre|code|div|span|table|thead|tbody|tr|th|td|a|strong|em|del|br|hr)(?:\s[^<>]*)?>/g;

/* 不变量二：整段输出（含属性值）里的每个 `&` 都必须起一个完整实体（转义表只产出这五个）——
 * 防「剥尾读切开实体」把 URL 断成半个实体（&amp 这种）而无人察觉；属性值也要查，切开实体的
 * 现场往往就在 href 里。 */
const DANGLING_AMPERSAND_PATTERN = /&(?!(?:amp|lt|gt|quot|#39);)/;

function assertTextOnly(html) {
  const text = html.replace(OWN_TAG_PATTERN, '');
  assert.ok(!/[<>"']/.test(text), `正文残留原始标记字符：${text}`);
  assert.ok(!DANGLING_AMPERSAND_PATTERN.test(html), `出现被切开的实体（含属性内）：${html}`);
}

/* ── 结构 golden：标题 ───────────────────────────────────── */

test('标题：`#` 到 `######` 六层字号', () => {
  const lines = ['# 一', '## 二', '### 三', '#### 四', '##### 五', '###### 六'];
  const names = '一二三四五六';
  lines.forEach((line, offset) => {
    assert.equal(renderMarkdown(line), `<h${offset + 1}>${names[offset]}</h${offset + 1}>`);
  });
});

test('标题：`#` 后必须有一个空格；七个 `#` 与无空格写法按字面', () => {
  assert.equal(renderMarkdown('# 有空格'), '<h1>有空格</h1>');
  assert.equal(renderMarkdown('#无空格'), '<p>#无空格</p>');
  assert.equal(renderMarkdown('####### 七'), '<p>####### 七</p>');
});

test('标题：空文本照出标签；行尾 `#` 按字面（不支持关闭井号）', () => {
  assert.equal(renderMarkdown('# '), '<h1></h1>');
  assert.equal(renderMarkdown('# 标题 #'), '<h1>标题 #</h1>');
});

test('标题：行内规则照常生效', () => {
  assert.equal(renderMarkdown('## 带 **粗** 的标题'), '<h2>带 <strong>粗</strong> 的标题</h2>');
});

/* ── 结构 golden：强调与行内代码 ─────────────────────────── */

test('强调：粗 / 斜 / 删除线与嵌套', () => {
  assert.equal(renderMarkdown('**粗**'), '<p><strong>粗</strong></p>');
  assert.equal(renderMarkdown('*斜*'), '<p><em>斜</em></p>');
  assert.equal(renderMarkdown('~~删~~'), '<p><del>删</del></p>');
  assert.equal(renderMarkdown('**粗 *斜* 粗**'), '<p><strong>粗 <em>斜</em> 粗</strong></p>');
  assert.equal(renderMarkdown('~~删**粗**删~~'), '<p><del>删<strong>粗</strong>删</del></p>');
});

test('强调：未闭合与空内容都按字面', () => {
  assert.equal(renderMarkdown('**粗'), '<p>**粗</p>');
  assert.equal(renderMarkdown('*斜'), '<p>*斜</p>');
  assert.equal(renderMarkdown('~~删'), '<p>~~删</p>');
  assert.equal(renderMarkdown('甲****乙'), '<p>甲****乙</p>');
  assert.equal(renderMarkdown('****'), '<hr>');   // 整行四个星号＝分隔线：块级判定先于行内
});

test('行内代码：等长配对 / 内容原样 / 未闭合按字面', () => {
  assert.equal(renderMarkdown('`code`'), '<p><code>code</code></p>');
  assert.equal(renderMarkdown('``a`b``'), '<p><code>a`b</code></p>');
  assert.equal(renderMarkdown('`a``'), '<p>`a``</p>');
  assert.equal(renderMarkdown('`\\*`'), '<p><code>\\*</code></p>');
  assert.equal(renderMarkdown('`code'), '<p>`code</p>');
  assert.equal(renderMarkdown('`**粗**`'), '<p><code>**粗**</code></p>');
});

test('行内代码：内容里的 HTML 特殊字符同样已转义', () => {
  assert.equal(renderMarkdown('`<b>`'), '<p><code>&lt;b&gt;</code></p>');
});

/* ── 结构 golden：围栏代码块 ─────────────────────────────── */

test('围栏：语言标识做 class 角标兼显示；无标识只有代码块', () => {
  assert.equal(
    renderMarkdown('```js\nconst a = 1;\n```'),
    '<div class="md-code-block"><span class="md-code-lang lang-js">js</span><pre class="md-code"><code>const a = 1;</code></pre></div>'
  );
  assert.equal(
    renderMarkdown('```\n**x**\n```'),
    '<div class="md-code-block"><pre class="md-code"><code>**x**</code></pre></div>'
  );
});

test('围栏：语言标识允许 `-`/`+`/`#`/`.`；其余字符不成围栏（按字面）', () => {
  assert.equal(
    renderMarkdown('```c++\nx\n```'),
    '<div class="md-code-block"><span class="md-code-lang lang-c++">c++</span><pre class="md-code"><code>x</code></pre></div>'
  );
  assert.equal(renderMarkdown('```js foo'), '<p>```js foo</p>');
});

test('围栏：未闭合＝其余全文为代码块内容', () => {
  assert.equal(
    renderMarkdown('说明\n```\nabc\ndef'),
    '<p>说明</p><div class="md-code-block"><pre class="md-code"><code>abc\ndef</code></pre></div>'
  );
});

test('围栏：≤3 空格缩进可开栏；收栏须同款式且不短于开栏', () => {
  assert.equal(
    renderMarkdown('   ```\nx\n   ```'),
    '<div class="md-code-block"><pre class="md-code"><code>x</code></pre></div>'
  );
  assert.equal(renderMarkdown('    ```'), '<p>    ```</p>');
  assert.equal(
    renderMarkdown('````\nx\n```'),
    '<div class="md-code-block"><pre class="md-code"><code>x\n```</code></pre></div>'
  );
  assert.equal(
    renderMarkdown('```\nx\n`````'),
    '<div class="md-code-block"><pre class="md-code"><code>x</code></pre></div>'
  );
});

/* ── 结构 golden：引用 ───────────────────────────────────── */

test('引用：单层 / 多行 / 标记后可选一空格 / 只有标记', () => {
  assert.equal(renderMarkdown('> 引文'), '<blockquote><p>引文</p></blockquote>');
  assert.equal(renderMarkdown('>引文'), '<blockquote><p>引文</p></blockquote>');
  assert.equal(renderMarkdown('> 甲\n> 乙'), '<blockquote><p>甲<br>乙</p></blockquote>');
  assert.equal(renderMarkdown('>'), '<blockquote></blockquote>');
});

test('引用：嵌套逐层剥标记；块内按块级规则继续解析', () => {
  assert.equal(renderMarkdown('> > 内层'), '<blockquote><blockquote><p>内层</p></blockquote></blockquote>');
  assert.equal(renderMarkdown('> # 标题\n> - 项'), '<blockquote><h1>标题</h1><ul><li>项</li></ul></blockquote>');
  assert.equal(renderMarkdown('> 甲\n\n> 乙'), '<blockquote><p>甲</p></blockquote><blockquote><p>乙</p></blockquote>');
});

test('引用：无标记的行不收进引用块（不做惰性续行）', () => {
  assert.equal(renderMarkdown('> 甲\n续行'), '<blockquote><p>甲</p></blockquote><p>续行</p>');
});

/* ── 结构 golden：列表 ───────────────────────────────────── */

test('列表：无序（-/*/+ 混用同属一块）与有序 start', () => {
  assert.equal(renderMarkdown('- 甲\n- 乙'), '<ul><li>甲</li><li>乙</li></ul>');
  assert.equal(renderMarkdown('* 甲\n+ 乙'), '<ul><li>甲</li><li>乙</li></ul>');
  assert.equal(renderMarkdown('3. 甲\n4. 乙'), '<ol start="3"><li>甲</li><li>乙</li></ol>');
  assert.equal(renderMarkdown('123456789. 九位'), '<ol start="123456789"><li>九位</li></ol>');
  assert.equal(renderMarkdown('1234567890. 十位'), '<p>1234567890. 十位</p>');
});

test('列表：一层子级（更深缩进仍是同一层子项）与子列表异型另起', () => {
  assert.equal(renderMarkdown('- 甲\n  - 乙\n  - 丙'), '<ul><li>甲<ul><li>乙</li><li>丙</li></ul></li></ul>');
  assert.equal(renderMarkdown('- 甲\n  - 乙\n    - 丙'), '<ul><li>甲<ul><li>乙</li><li>丙</li></ul></li></ul>');
  assert.equal(renderMarkdown('- 甲\n  1. 乙'), '<ul><li>甲<ol start="1"><li>乙</li></ol></li></ul>');
  assert.equal(
    renderMarkdown('- 甲\n  - 乙\n  1. 丙'),
    '<ul><li>甲<ul><li>乙</li></ul><ol start="1"><li>丙</li></ol></li></ul>'
  );
});

test('列表：任务列表字形（x 大小写均可；无 input 元素）', () => {
  assert.equal(
    renderMarkdown('- [ ] 待办\n- [x] 完成\n- [X] 大写'),
    '<ul><li>☐ 待办</li><li>☑ 完成</li><li>☑ 大写</li></ul>'
  );
  assert.equal(renderMarkdown('- [ ]'), '<ul><li>☐</li></ul>');
  assert.equal(renderMarkdown('- [x]无空格'), '<ul><li>[x]无空格</li></ul>');
});

test('列表：缩进续行并入最内层当前项（项内多行以 <br> 连接、不产生空段）', () => {
  assert.equal(renderMarkdown('- 甲\n  续'), '<ul><li>甲<br>续</li></ul>');
  assert.equal(renderMarkdown('- 甲\n  - 乙\n  续'), '<ul><li>甲<ul><li>乙<br>续</li></ul></li></ul>');
});

test('列表：以空行 / 非缩进正文 / 异型标记 / 单空格缩进收束', () => {
  assert.equal(renderMarkdown('- 甲\n\n- 乙'), '<ul><li>甲</li></ul><ul><li>乙</li></ul>');
  assert.equal(renderMarkdown('- 甲\n正文'), '<ul><li>甲</li></ul><p>正文</p>');
  assert.equal(renderMarkdown('- 甲\n1. 乙'), '<ul><li>甲</li></ul><ol start="1"><li>乙</li></ol>');
  assert.equal(renderMarkdown('- 甲\n - 乙'), '<ul><li>甲</li></ul><p> - 乙</p>');
});

test('列表：项内容走行内规则', () => {
  assert.equal(renderMarkdown('- **粗** 与 [x](http://e)'), '<ul><li><strong>粗</strong> 与 <a href="http://e" target="_blank" rel="noopener">x</a></li></ul>');
});

/* ── 结构 golden：表格 ───────────────────────────────────── */

test('表格：表头 / 分隔行 / 数据行（首尾空竖线可省可留）', () => {
  const expected = '<table class="md-table"><thead><tr><th>甲</th><th>乙</th></tr></thead>'
    + '<tbody><tr><td>1</td><td>2</td></tr></tbody></table>';
  assert.equal(renderMarkdown('| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |'), expected);
  assert.equal(renderMarkdown('甲 | 乙\n--- | ---\n1 | 2'), expected);
});

test('表格：分隔行的 `:` 定对齐（无 `:` 的列不出 align）', () => {
  assert.equal(
    renderMarkdown('| 甲 | 乙 | 丙 | 丁 |\n|:--|:-:|--:|---|\n| 1 | 2 | 3 | 4 |'),
    '<table class="md-table"><thead><tr><th align="left">甲</th><th align="center">乙</th><th align="right">丙</th><th>丁</th></tr></thead>'
    + '<tbody><tr><td align="left">1</td><td align="center">2</td><td align="right">3</td><td>4</td></tr></tbody></table>'
  );
});

test('表格：数据行不足补空、超出截断到表头列数（分隔行列数不决定列数）', () => {
  assert.equal(
    renderMarkdown('| 甲 | 乙 |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |'),
    '<table class="md-table"><thead><tr><th>甲</th><th>乙</th></tr></thead>'
    + '<tbody><tr><td>1</td><td></td></tr><tr><td>1</td><td>2</td></tr></tbody></table>'
  );
  assert.equal(
    renderMarkdown('| 甲 | 乙 |\n|---|\n| 1 | 2 |'),
    '<table class="md-table"><thead><tr><th>甲</th><th>乙</th></tr></thead>'
    + '<tbody><tr><td>1</td><td>2</td></tr></tbody></table>'
  );
});

test('表格：仅表头无分隔行不成表；`|` 行不成表的退化表头按段落', () => {
  assert.equal(renderMarkdown('甲 | 乙'), '<p>甲 | 乙</p>');
  assert.equal(renderMarkdown('|\n|---|'), '<p>|<br>|---|</p>');
});

test('表格：行以不含竖线的行 / 空行收束', () => {
  assert.equal(
    renderMarkdown('| 甲 |\n|---|\n正文\n| 乙 |'),
    '<table class="md-table"><thead><tr><th>甲</th></tr></thead><tbody></tbody></table><p>正文<br>| 乙 |</p>'
  );
  assert.equal(
    renderMarkdown('| 甲 |\n|---|\n\n| 乙 |'),
    '<table class="md-table"><thead><tr><th>甲</th></tr></thead><tbody></tbody></table><p>| 乙 |</p>'
  );
});

test('表格：表头与单元格走行内规则', () => {
  assert.equal(
    renderMarkdown('| **粗** | [x](http://e) |\n|---|---|'),
    '<table class="md-table"><thead><tr><th><strong>粗</strong></th>'
    + '<th><a href="http://e" target="_blank" rel="noopener">x</a></th></tr></thead><tbody></tbody></table>'
  );
});

/* ── 结构 golden：分隔线与段落 ───────────────────────────── */

test('分隔线：--- / *** / ___ / 夹空格的写法；不成型的按字面', () => {
  assert.equal(renderMarkdown('---'), '<hr>');
  assert.equal(renderMarkdown('***'), '<hr>');
  assert.equal(renderMarkdown('___'), '<hr>');
  assert.equal(renderMarkdown('_ _ _'), '<hr>');
  assert.equal(renderMarkdown('--'), '<p>--</p>');
  assert.equal(renderMarkdown('-*-'), '<p>-*-</p>');
});

test('分隔线：列表优先级在前——`- - -` 与 `* * *` 判定为列表项（设计列表顺序）', () => {
  assert.equal(renderMarkdown('- - -'), '<ul><li>- -</li></ul>');
  /* `* * *`：块归属先判列表（标记＋空格成立），项内容 `* *` 再走行内——最近同型定界符配对，
   * 内容为一个空格；强调规则从简，不做 CommonMark 的 flanking 判定 */
  assert.equal(renderMarkdown('* * *'), '<ul><li><em> </em></li></ul>');
});

test('分隔线：setext 标题不支持（`---` 恒为分隔线）', () => {
  assert.equal(renderMarkdown('标题\n---'), '<p>标题</p><hr>');
  assert.equal(renderMarkdown('标题\n==='), '<p>标题<br>===</p>');
});

test('段落：连续非空行成段、段内单换行转 <br>、空行分段', () => {
  assert.equal(renderMarkdown('甲\n乙'), '<p>甲<br>乙</p>');
  assert.equal(renderMarkdown('甲\n\n乙'), '<p>甲</p><p>乙</p>');
  assert.equal(renderMarkdown('甲\n\n\n乙'), '<p>甲</p><p>乙</p>');
});

test('段落：被块级构造打断（标题 / 列表 / 表格）；行首空格按字面', () => {
  assert.equal(renderMarkdown('前\n# 标题\n后'), '<p>前</p><h1>标题</h1><p>后</p>');
  assert.equal(renderMarkdown('前\n- 项\n后'), '<p>前</p><ul><li>项</li></ul><p>后</p>');
  assert.equal(renderMarkdown(' # 标题'), '<p> # 标题</p>');
});

test('块优先级：表格先行判定（不被段内 <br> 拆断、跨行成表）', () => {
  assert.equal(
    renderMarkdown('说明\n甲 | 乙\n--- | ---\n1 | 2'),
    '<p>说明</p><table class="md-table"><thead><tr><th>甲</th><th>乙</th></tr></thead>'
    + '<tbody><tr><td>1</td><td>2</td></tr></tbody></table>'
  );
});

test('块优先级：围栏内不做行内解析', () => {
  assert.equal(
    renderMarkdown('```\n**粗** [x](http://e)\n```'),
    '<div class="md-code-block"><pre class="md-code"><code>**粗** [x](http://e)</code></pre></div>'
  );
});

/* ── 结构 golden：链接 / 图片 / 裸链 ─────────────────────── */

test('链接：http / https 出链接，href 取转义后文本（不反转义）', () => {
  assert.equal(
    renderMarkdown('[文字](https://e.com)'),
    '<p><a href="https://e.com" target="_blank" rel="noopener">文字</a></p>'
  );
  assert.equal(
    renderMarkdown('[文字](http://e.com/a?b=1&c=2)'),
    '<p><a href="http://e.com/a?b=1&amp;c=2" target="_blank" rel="noopener">文字</a></p>'
  );
});

test('链接：scheme 归一为大小写不敏感；文字走行内规则', () => {
  assert.equal(
    renderMarkdown('[**粗**](HTTP://E.COM)'),
    '<p><a href="HTTP://E.COM" target="_blank" rel="noopener"><strong>粗</strong></a></p>'
  );
});

test('链接：URL 含空白即不匹配（title 写法整段字面）', () => {
  assert.equal(renderMarkdown('[文字](http://a "标题")'), '<p>[文字](http://a &quot;标题&quot;)</p>');
});

test('链接：括号单层平衡；两层嵌套整段字面；括号不闭合不成构造', () => {
  assert.equal(
    renderMarkdown('[x](http://e/a(b)c)'),
    '<p><a href="http://e/a(b)c" target="_blank" rel="noopener">x</a></p>'
  );
  assert.equal(renderMarkdown('[x](http://e/((a)))'), '<p>[x](http://e/((a)))</p>');
  assert.equal(
    renderMarkdown('[x](http://e'),
    '<p>[x](<a href="http://e" target="_blank" rel="noopener">http://e</a></p>'
  );
});

test('链接：URL 含中文标点不匹配（整段字面）', () => {
  assert.equal(renderMarkdown('[x](http://a。b)'), '<p>[x](http://a。b)</p>');
});

test('链接：`[文字]` 无括号按字面；`!` 后紧跟 `[` 才是图片', () => {
  assert.equal(renderMarkdown('[文字]'), '<p>[文字]</p>');
  assert.equal(
    renderMarkdown('! [x](http://e)'),
    '<p>! <a href="http://e" target="_blank" rel="noopener">x</a></p>'
  );
  assert.equal(renderMarkdown('![x]'), '<p>![x]</p>');
});

test('图片：呈现为「🖼 alt」链接（不拉图）；alt 过行内；非 http URL 整段字面', () => {
  assert.equal(
    renderMarkdown('![图](http://e/a.png)'),
    '<p><a href="http://e/a.png" target="_blank" rel="noopener">🖼 图</a></p>'
  );
  assert.equal(
    renderMarkdown('![**粗**](http://e/a.png)'),
    '<p><a href="http://e/a.png" target="_blank" rel="noopener">🖼 <strong>粗</strong></a></p>'
  );
  assert.equal(renderMarkdown('![图](javascript:x)'), '<p>![图](javascript:x)</p>');
});

test('裸链：http(s) 起、至空白与 < > 止', () => {
  assert.equal(
    renderMarkdown('见 http://e.com 结束'),
    '<p>见 <a href="http://e.com" target="_blank" rel="noopener">http://e.com</a> 结束</p>'
  );
  assert.equal(
    renderMarkdown('<http://e.com>'),
    '<p>&lt;<a href="http://e.com" target="_blank" rel="noopener">http://e.com</a>&gt;</p>'
  );
});

test('裸链：尾随中英文句读不并入链接（可连剥）', () => {
  assert.equal(
    renderMarkdown('见 http://e.com。'),
    '<p>见 <a href="http://e.com" target="_blank" rel="noopener">http://e.com</a>。</p>'
  );
  assert.equal(
    renderMarkdown('见 http://e.com.'),
    '<p>见 <a href="http://e.com" target="_blank" rel="noopener">http://e.com</a>.</p>'
  );
  assert.equal(
    renderMarkdown('（http://e.com）'),
    '<p>（<a href="http://e.com" target="_blank" rel="noopener">http://e.com</a>）</p>'
  );
  assert.equal(
    renderMarkdown('http://e.com/a.)'),
    '<p><a href="http://e.com/a" target="_blank" rel="noopener">http://e.com/a</a>.)</p>'
  );
});

test('裸链：转义后的引号（&quot; / &#39;）也在尾读之列', () => {
  assert.equal(
    renderMarkdown('http://e.com"'),
    '<p><a href="http://e.com" target="_blank" rel="noopener">http://e.com</a>&quot;</p>'
  );
  assert.equal(
    renderMarkdown("http://e.com'"),
    '<p><a href="http://e.com" target="_blank" rel="noopener">http://e.com</a>&#39;</p>'
  );
});

test('裸链：只剩 scheme 不成链接；中间句点与路径不切断', () => {
  assert.equal(renderMarkdown('http://'), '<p>http://</p>');
  assert.equal(
    renderMarkdown('http://e.com/a.b?x=1.5'),
    '<p><a href="http://e.com/a.b?x=1.5" target="_blank" rel="noopener">http://e.com/a.b?x=1.5</a></p>'
  );
});

test('裸链：`&名字;` 形状的收尾不剥——正文里的 `&` 转义成 &amp;，切开它 URL 会断成半个实体', () => {
  assert.equal(
    renderMarkdown('http://a&'),
    '<p><a href="http://a&amp;" target="_blank" rel="noopener">http://a&amp;</a></p>'
  );
  /* 实体完整性与句读剥离并存：`&amp;` 留在链接里（那是 `&` 的转义形态），用户多写的那枚 `;` 照剥 */
  assert.equal(
    renderMarkdown('http://a&;'),
    '<p><a href="http://a&amp;" target="_blank" rel="noopener">http://a&amp;</a>;</p>'
  );
});

test('裸链：实体以外的收尾分号仍按句读剥（含用户字面键入的实体写法）', () => {
  assert.equal(
    renderMarkdown('http://a.com;'),
    '<p><a href="http://a.com" target="_blank" rel="noopener">http://a.com</a>;</p>'
  );
  assert.equal(
    renderMarkdown('http://x&y;'),
    '<p><a href="http://x&amp;y" target="_blank" rel="noopener">http://x&amp;y</a>;</p>'
  );
  /* `&lt;` 由用户字面键入：转义后字面量在 `&amp;` 之后（`&amp;lt;`），收尾分号属用户正文（句读） */
  assert.equal(
    renderMarkdown('https://&lt;'),
    '<p><a href="https://&amp;lt" target="_blank" rel="noopener">https://&amp;lt</a>;</p>'
  );
});

test('裸链：scheme 大小写敏感（字面口径；链接目标判定才做归一）', () => {
  assert.equal(renderMarkdown('https://e.com'), '<p><a href="https://e.com" target="_blank" rel="noopener">https://e.com</a></p>');
  assert.equal(renderMarkdown('HTTP://e.com'), '<p>HTTP://e.com</p>');
  assert.equal(renderMarkdown('hello world'), '<p>hello world</p>');
});

test('文本：中文 / emoji / ZWJ 组合序列原样透出', () => {
  assert.equal(renderMarkdown('普通正文 😀'), '<p>普通正文 😀</p>');
  assert.equal(renderMarkdown('组合 👨‍👩‍👧'), '<p>组合 👨‍👩‍👧</p>');
});

/* ── 非标准语法：一律字面 ────────────────────────────────── */

test('非标准扩展按字面：==高亮== / 脚注 / 数学 / _斜_ / 上下标', () => {
  assert.equal(renderMarkdown('==高亮=='), '<p>==高亮==</p>');
  assert.equal(renderMarkdown('脚注[^1]'), '<p>脚注[^1]</p>');
  assert.equal(renderMarkdown('$x^2$'), '<p>$x^2$</p>');
  assert.equal(renderMarkdown('_斜_'), '<p>_斜_</p>');
  assert.equal(renderMarkdown('H~2~O'), '<p>H~2~O</p>');
});

test('非标准扩展：`> [!NOTE]`＝标准引用块 + 标记字面文本', () => {
  assert.equal(renderMarkdown('> [!NOTE]\n> 提醒'), '<blockquote><p>[!NOTE]<br>提醒</p></blockquote>');
});

test('转义：反斜杠让特殊字符按字面输出', () => {
  assert.equal(renderMarkdown('\\*不是强调\\*'), '<p>*不是强调*</p>');
  assert.equal(renderMarkdown('\\# 不是标题'), '<p># 不是标题</p>');
  assert.equal(renderMarkdown('\\> 不是引用'), '<p>&gt; 不是引用</p>');
  assert.equal(renderMarkdown('\\|'), '<p>|</p>');
  assert.equal(renderMarkdown('\\`不是代码\\`'), '<p>`不是代码`</p>');
  assert.equal(renderMarkdown('\\!'), '<p>!</p>');
  assert.equal(renderMarkdown('\\\\'), '<p>\\</p>');
});

test('转义：不在特殊集里的字符（含 `-`）反斜杠按字面（清单外一律字面）', () => {
  assert.equal(renderMarkdown('\\- 不是列表'), '<p>\\- 不是列表</p>');
  assert.equal(renderMarkdown('\\a'), '<p>\\a</p>');
  assert.equal(renderMarkdown('尾\\'), '<p>尾\\</p>');
});

/* ── XSS 语料 ────────────────────────────────────────────── */

test('XSS：原始 HTML 直通尝试一律转义（无未转义危险序列）', () => {
  const inputs = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '"><script>alert(1)</script>',
    '<svg onload=alert(1)>',
    '</p><iframe src=javascript:alert(1)></iframe>',
  ];
  for (const input of inputs) {
    const html = renderMarkdown(input);
    assertTextOnly(html);
    assert.equal(html.includes('<script'), false, html);
    assert.equal(html.includes('<img'), false, html);
    assert.equal(html.includes('<svg'), false, html);
    assert.equal(html.includes('<iframe'), false, html);
  }
  assert.equal(renderMarkdown('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
});

test('XSS：伪协议链接整段字面、不产出 href', () => {
  const inputs = [
    '[x](javascript:alert(1))',
    '[x](JavaScript:alert(1))',
    '[x](data:text/html,<script>alert(1)</script>)',
    '[x](vbscript:msgbox(1))',
    '![x](javascript:alert(1))',
  ];
  for (const input of inputs) {
    const html = renderMarkdown(input);
    assertTextOnly(html);
    assert.equal(html.includes('href'), false, html);
    assert.equal(html.includes('<script'), false, html);
  }
});

test('XSS：URL 内引号注入不逃出 href（属性值取转义后文本）', () => {
  const html = renderMarkdown('[x](http://a"onmouseover="x)');
  assert.equal(html, '<p><a href="http://a&quot;onmouseover=&quot;x" target="_blank" rel="noopener">x</a></p>');
  assertTextOnly(html);
});

test('XSS：实体走私按字面显示（不再有二次解析）', () => {
  assert.equal(renderMarkdown('&lt;script&gt;'), '<p>&amp;lt;script&amp;gt;</p>');
  assert.equal(renderMarkdown('&colon;'), '<p>&amp;colon;</p>');
  assert.equal(renderMarkdown('&#39;&quot;'), '<p>&amp;#39;&amp;quot;</p>');
});

test('XSS：链接文字 / 标题 / 表格单元格 / 围栏语言位都逃不出文本区', () => {
  assert.equal(
    renderMarkdown('[<script>](http://e)'),
    '<p><a href="http://e" target="_blank" rel="noopener">&lt;script&gt;</a></p>'
  );
  assert.equal(renderMarkdown('# <b>x</b>'), '<h1>&lt;b&gt;x&lt;/b&gt;</h1>');
  assert.equal(
    renderMarkdown('| <img onerror=1> |\n|---|'),
    '<table class="md-table"><thead><tr><th>&lt;img onerror=1&gt;</th></tr></thead><tbody></tbody></table>'
  );
  assert.equal(renderMarkdown('```js" onload="x'), '<p>```js&quot; onload=&quot;x</p>');
});

test('XSS：反引号 / 星号跨行尝试不构成跨行构造', () => {
  assert.equal(renderMarkdown('**甲\n乙**'), '<p>**甲<br>乙**</p>');
  assert.equal(renderMarkdown('`甲\n乙`'), '<p>`甲<br>乙`</p>');
});

/* ── 边界与压测 ──────────────────────────────────────────── */

test('边界：空串 / 纯空白 / 纯换行 → 空片段', () => {
  assert.equal(renderMarkdown(''), '');
  assert.equal(renderMarkdown('   '), '');
  assert.equal(renderMarkdown('\n\n'), '');
});

test('边界：`\\r` 按普通字符（管线已归一；出现即为普通字符，不另做处理）', () => {
  assert.equal(renderMarkdown('甲\r乙'), '<p>甲\r乙</p>');
  assert.equal(renderMarkdown('甲\r\n乙'), '<p>甲\r<br>乙</p>');
});

test('边界：未闭合行内代码 / 强调 / 删除线都按字面', () => {
  assert.equal(renderMarkdown('`甲'), '<p>`甲</p>');
  assert.equal(renderMarkdown('**甲'), '<p>**甲</p>');
  assert.equal(renderMarkdown('~~甲'), '<p>~~甲</p>');
});

test('边界：整行引用标记（4000 个 >）不炸栈——逐层剥标记与递归等价', () => {
  const html = renderMarkdown('>'.repeat(4000));
  assert.equal(html.split('<blockquote>').length - 1, 4000);
  assert.equal(html.split('</blockquote>').length - 1, 4000);
});

test('边界：超长不可断单行（4000 字符）不劣化——回溯压测变体', () => {
  const started = Date.now();
  assert.equal(renderMarkdown('甲'.repeat(4000)), `<p>${'甲'.repeat(4000)}</p>`);
  assert.equal(renderMarkdown('|'.repeat(4000)), `<p>${'|'.repeat(4000)}</p>`);
  assert.equal(renderMarkdown('['.repeat(4000)), `<p>${'['.repeat(4000)}</p>`);
  assert.equal(renderMarkdown('~~'.repeat(2000)), `<p>${'~~'.repeat(2000)}</p>`);
  assert.equal(renderMarkdown('[甲]('.repeat(1000)), `<p>${'[甲]('.repeat(1000)}</p>`);
  assert.equal(renderMarkdown('`'.repeat(2000) + '甲'.repeat(2000)), `<p>${'`'.repeat(2000)}${'甲'.repeat(2000)}</p>`);
  assert.equal(renderMarkdown('*'.repeat(4000)), '<hr>');   // 整行星号＝分隔线（块级判定先于行内）
  assert.equal(renderMarkdown('`'.repeat(4000)), '<div class="md-code-block"><pre class="md-code"><code></code></pre></div>');
  assert.ok(renderMarkdown('- '.repeat(2000)).startsWith('<ul><li>- -'));   // 列表路径同样线性
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `长行压测超出时间预算：${elapsed}ms`);
});
