/* Markdown 渲染子集（设计 §7 封闭清单）：消息正文 → 安全 HTML 片段，服务端单点渲染。
 *
 * 安全模型：逃逸优先。渲染前先对全文做一次 HTML 转义，其后所有解析都在转义后的文本上跑——
 * 输出里出现的 < > & 只可能来自本模块自己生成的标签，正文永远制造不出标记。正文是对端可控的
 * 外部数据，因此全程不做「反转义」：href 与 class 的值直接取转义后文本（浏览器看到的是等价文本，
 * 不是可执行结构）；需要比较语义的判定（如 scheme 白名单）也在转义文本上做。
 *
 * 清单外语法一律按字面输出，不发明样式（==高亮==、> [!NOTE] 的标记、脚注、数学、setext 标题、
 * `_斜_` 等）。块归属按设计列表的优先级判定：围栏 → 表格 → 标题 → 引用 → 列表 → 分隔线 → 段落；
 * 行内在单遍扫描里按 反斜杠转义 → 行内代码 → 图片 → 链接 → 裸链 → 强调 的优先级试构造，
 * 全部匹配都是手工比较或 indexOf（无嵌套量词正则），长行不退化。
 *
 * 输入约定：text 已经过 displayText(text, { newlines: 'keep' })——控制 / 格式字符已剥离、
 * 换行类字符已归一为 \n（服务端管线保证）。本模块不再做字符剥离，也不假设 \r 会出现。
 *
 * 纯函数、零依赖、无 IO、无日志：只做字符串处理，可被 Node 服务端直接加载。
 */

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const HTML_ESCAPABLE = /[&<>"']/g;

/* 转义后的 < > ：输入里的 < > 在转义文本中已变实体——引用标记、`\>` 转义与裸链边界都以实体形态判定 */
const ESCAPED_LT = '&lt;';
const ESCAPED_GT = '&gt;';

const FENCE_OPEN_RE = /^ {0,3}(`{3,})([A-Za-z0-9+#.-]*) *$/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}) *$/;
const HEADING_RE = /^(#{1,6}) (.*)$/;
const UNORDERED_ITEM_RE = /^[-*+] (.*)$/;
const ORDERED_ITEM_RE = /^(\d{1,9})\. (.*)$/;
const INDENT_PREFIX_RE = /^ {2,}(.*)$/;
const INDENTED_LINE_RE = /^ {2,}\S/;
const TABLE_SEPARATOR_RE = /^[|\-: ]*$/;
const HORIZONTAL_RULE_RE = /^([-*_])(?: *\1){2,} *$/;
const TASK_ITEM_RE = /^\[([ xX])\]( |$)/;
const HTTP_SCHEME_RE = /^\s*https?:\/\//i;
const URL_WHITESPACE_RE = /\s/;

/* 反斜杠转义的特殊集：转义后只认这一组字面字符（`\>` 的 `>` 已是实体，单独按实体判定） */
const INLINE_ESCAPABLE = new Set(['\\', '`', '*', '~', '[', ']', '(', ')', '#', '|', '!']);

/* URL 边界与句读：URL 语法以 ASCII 为主，中文标点一旦出现即属正文——
 * 裸链在此终止、方括号链接的 URL 含它则整段按字面（URL 不得含空白与中文标点）；
 * 句读（中英文）出现在 URL 末尾时不并入链接（句中 URL 后跟句号的常态）。 */
const URL_BOUNDARY_PUNCTUATION = new Set([
  '。', '，', '、', '；', '：', '！', '？', '“', '”', '‘', '’', '（', '）',
  '【', '】', '《', '》', '「', '」', '『', '』', '〈', '〉', '…', '—', '～',
]);
const LINK_TAIL_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?', ')']);

const ESCAPED_QUOTE = '&quot;';
const ESCAPED_APOSTROPHE = '&#39;';
const ENTITY_NAME_CHAR_RE = /[A-Za-z0-9#]/;

/**
 * 把消息正文渲染为 HTML 片段（设计 §7 封闭清单）。
 * @param {string} text 已经过 displayText(text, { newlines: 'keep' }) 的展示文本（换行已归一为 \n）
 * @returns {string} HTML 片段：内容全部转义，< > & 只来自本模块生成的标签，可直接进 innerHTML
 */
export function renderMarkdown(text) {
  return renderBlockLines(escapeHtml(text).split('\n'));
}

function escapeHtml(text) {
  return text.replace(HTML_ESCAPABLE, (char) => HTML_ESCAPES[char]);
}

function renderBlockLines(lines) {
  const chunks = [];
  let index = 0;
  while (index < lines.length) {
    index = renderNextBlock(lines, index, chunks);
  }
  return chunks.join('');
}

/* 块归属判定：自上而下一票通过（顺序即设计列表的优先级），判定归属后才进入该块的渲染。 */
function renderNextBlock(lines, index, chunks) {
  const line = lines[index];
  if (line.trim() === '') {
    return index + 1;
  }
  const fence = matchFenceOpen(line);
  if (fence !== null) {
    return renderFence(lines, index, chunks, fence);
  }
  if (isTableStart(lines, index)) {
    return renderTable(lines, index, chunks);
  }
  const heading = matchHeading(line);
  if (heading !== null) {
    return renderHeading(index, chunks, heading);
  }
  if (line.startsWith(ESCAPED_GT)) {
    return renderQuote(lines, index, chunks);
  }
  const listStart = matchListItem(line);
  if (listStart !== null) {
    return renderList(lines, index, chunks, listStart);
  }
  if (HORIZONTAL_RULE_RE.test(line)) {
    return renderHr(index, chunks);
  }
  return renderParagraph(lines, index, chunks);
}

/* 段落的收束判据：与 renderNextBlock 同一组谓词（空行单独判）——列表 / 表格等块不靠空行也换块。 */
function startsBlock(lines, index) {
  const line = lines[index];
  return FENCE_OPEN_RE.test(line)
    || isTableStart(lines, index)
    || HEADING_RE.test(line)
    || line.startsWith(ESCAPED_GT)
    || matchListItem(line) !== null
    || HORIZONTAL_RULE_RE.test(line);
}

/* ── 围栏代码块 ───────────────────────────────────────────── */

function matchFenceOpen(line) {
  const match = FENCE_OPEN_RE.exec(line);
  if (match === null) {
    return null;
  }
  return { ticks: match[1].length, lang: match[2] };
}

/* 收栏：同款式反引号行（长度不少于开栏，行内不再有他物）；未闭合时其余全文都是代码内容。 */
function isFenceClose(line, ticks) {
  const match = FENCE_CLOSE_RE.exec(line);
  return match !== null && match[1].length >= ticks;
}

function renderFence(lines, start, chunks, fence) {
  let index = start + 1;
  while (index < lines.length && !isFenceClose(lines[index], fence.ticks)) {
    index++;
  }
  chunks.push(fenceHtml(fence.lang, lines.slice(start + 1, index).join('\n')));
  return index < lines.length ? index + 1 : index;
}

function fenceHtml(lang, content) {
  const body = `<pre class="md-code"><code>${content}</code></pre>`;
  if (lang === '') {
    return `<div class="md-code-block">${body}</div>`;
  }
  /* 语言标识的字符集在开栏正则里已收窄（且转义在前，不含任何 HTML 特殊字符），可同时进 class 与显示文本 */
  const badge = `<span class="md-code-lang lang-${lang}">${lang}</span>`;
  return `<div class="md-code-block">${badge}${body}</div>`;
}

/* ── 表格（GFM 管道表） ───────────────────────────────────── */

function isTableStart(lines, index) {
  if (!lines[index].includes('|')) {
    return false;
  }
  if (index + 1 >= lines.length || !isTableSeparator(lines[index + 1])) {
    return false;
  }
  return parseTableRow(lines[index]).length > 0;
}

function isTableSeparator(line) {
  return line.includes('-') && TABLE_SEPARATOR_RE.test(line);
}

/* 数据行＝随后的含竖线非空行；空行（或出现不含竖线的行）即表格收束。 */
function renderTable(lines, start, chunks) {
  const header = parseTableRow(lines[start]);
  const alignments = tableAlignments(lines[start + 1], header.length);
  const rows = [];
  let index = start + 2;
  while (index < lines.length && lines[index].trim() !== '' && lines[index].includes('|')) {
    rows.push(parseTableRow(lines[index]));
    index++;
  }
  chunks.push(tableHtml(header, alignments, rows));
  return index;
}

function parseTableRow(line) {
  const cells = line.split('|').map((cell) => cell.trim());
  if (cells.length > 0 && cells[0] === '') {
    cells.shift();
  }
  if (cells.length > 0 && cells[cells.length - 1] === '') {
    cells.pop();
  }
  return cells;
}

/* 对齐取自分隔行：`:` 在首为左、在尾为右、两头都有为中；分隔行列数不足按无对齐补，多出的忽略。 */
function tableAlignments(line, count) {
  const cells = parseTableRow(line);
  const alignments = [];
  for (let position = 0; position < count; position++) {
    alignments.push(position < cells.length ? alignmentOf(cells[position]) : null);
  }
  return alignments;
}

function alignmentOf(cell) {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) {
    return 'center';
  }
  if (left) {
    return 'left';
  }
  if (right) {
    return 'right';
  }
  return null;
}

function tableHtml(header, alignments, rows) {
  const head = rowHtml('th', header, alignments);
  const body = rows.map((row) => rowHtml('td', row, alignments)).join('');
  return `<table class="md-table"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

/* 行按表头列数对齐输出：不足补空单元格、超出截断（分隔行只定对齐，不定列数）。 */
function rowHtml(tag, cells, alignments) {
  const parts = [];
  for (let position = 0; position < alignments.length; position++) {
    const align = alignments[position];
    const attribute = align === null ? '' : ` align="${align}"`;
    const text = position < cells.length ? cells[position] : '';
    parts.push(`<${tag}${attribute}>${renderInline(text)}</${tag}>`);
  }
  return `<tr>${parts.join('')}</tr>`;
}

/* ── 标题 / 引用 / 分隔线 ─────────────────────────────────── */

function matchHeading(line) {
  const match = HEADING_RE.exec(line);
  if (match === null) {
    return null;
  }
  return { level: match[1].length, text: match[2] };
}

function renderHeading(index, chunks, heading) {
  chunks.push(`<h${heading.level}>${renderInline(heading.text)}</h${heading.level}>`);
  return index + 1;
}

/* 引用块：连续以引用标记开头的行收集为一块，逐行剥一层标记后按同一套块级规则继续渲染——
 * 剥一层仍是「清一色引用行」时继续剥（等价于逐层递归，但不吃调用栈：对端可以让整行都是 `>`，
 * 递归深度会随输入长度线性增长）；块内不做惰性续行（无标记的行不收进引用块）。 */
function renderQuote(lines, start, chunks) {
  let inner = [];
  let index = start;
  while (index < lines.length && lines[index].startsWith(ESCAPED_GT)) {
    inner.push(stripQuoteMarker(lines[index]));
    index++;
  }
  let depth = 1;
  while (inner.length > 0 && inner.every((line) => line.startsWith(ESCAPED_GT))) {
    inner = inner.map((line) => stripQuoteMarker(line));
    depth++;
  }
  chunks.push('<blockquote>'.repeat(depth) + renderBlockLines(inner) + '</blockquote>'.repeat(depth));
  return index;
}

function stripQuoteMarker(line) {
  const rest = line.slice(ESCAPED_GT.length);
  return rest.startsWith(' ') ? rest.slice(1) : rest;
}

function renderHr(index, chunks) {
  chunks.push('<hr>');
  return index + 1;
}

/* ── 列表 ─────────────────────────────────────────────────── */

/**
 * @typedef {object} ListItem
 * @property {string[]} content 项内容行（已修剪；首行可能带任务字形前缀）
 * @property {ListBlock[]} subLists 子级列表（一层，异型子项标记会另起一个子列表）
 */

/**
 * @typedef {object} ListBlock
 * @property {'ul' | 'ol'} kind 列表型（无序 / 有序）
 * @property {number | null} number 有序列表的起始号（无序为 null）
 * @property {ListItem[]} items
 */

function matchListItem(line) {
  const unordered = UNORDERED_ITEM_RE.exec(line);
  if (unordered !== null) {
    return { kind: 'ul', number: null, content: itemContentOf(unordered[1]) };
  }
  const ordered = ORDERED_ITEM_RE.exec(line);
  if (ordered !== null) {
    return { kind: 'ol', number: Number(ordered[1]), content: itemContentOf(ordered[2]) };
  }
  return null;
}

function matchIndentedItem(line) {
  const indented = INDENT_PREFIX_RE.exec(line);
  if (indented === null) {
    return null;
  }
  return matchListItem(indented[1]);
}

/* 项内容：修剪首尾空白；以任务框标记开头（`[ ]` / `[x]`，大小写均可）时换成纯字形前缀——
 * 只读呈现，不生成 input 元素。 */
function itemContentOf(content) {
  const text = content.trim();
  const task = TASK_ITEM_RE.exec(text);
  if (task === null) {
    return text;
  }
  const glyph = task[1] === ' ' ? '☐' : '☑';
  const rest = text.slice(task[0].length);
  return rest === '' ? glyph : `${glyph} ${rest}`;
}

function renderList(lines, start, chunks, listStart) {
  const collected = collectList(lines, start, listStart);
  chunks.push(listHtml(collected.list));
  return collected.next;
}

function collectList(lines, start, listStart) {
  /** @type {ListBlock} */
  const list = { kind: listStart.kind, number: listStart.number, items: [] };
  /** @type {{ item: ListItem, sub: ListBlock | null }} */
  const cursor = { item: { content: [listStart.content], subLists: [] }, sub: null };
  list.items.push(cursor.item);
  let index = start + 1;
  while (index < lines.length && absorbListLine(lines[index], list, cursor)) {
    index++;
  }
  return { list, next: index };
}

/* 列表块续收三类行：同型根项 / 缩进子项（一层，缩进 ≥2 空格）/ 缩进续行；
 * 其余行（含空行、异型标记、非缩进正文）都结束本列表块。续行并入最内层当前项——
 * 子项之后再来续行归子项，与逐层缩进的直觉一致。 */
function absorbListLine(line, list, cursor) {
  if (line.trim() === '') {
    return false;
  }
  const rootItem = matchListItem(line);
  if (rootItem !== null) {
    if (rootItem.kind !== list.kind) {
      return false;
    }
    cursor.item = { content: [rootItem.content], subLists: [] };
    list.items.push(cursor.item);
    cursor.sub = null;
    return true;
  }
  const subItem = matchIndentedItem(line);
  if (subItem !== null) {
    appendSubItem(cursor, subItem);
    return true;
  }
  if (!INDENTED_LINE_RE.test(line)) {
    return false;
  }
  appendContinuation(cursor, line.trim());
  return true;
}

/* 子级只支持一层：子项标记与当前子列表同型则续收，异型（如 ul 里出现 `1.`）另起一个子列表。 */
function appendSubItem(cursor, subItem) {
  if (cursor.sub === null || cursor.sub.kind !== subItem.kind) {
    cursor.sub = { kind: subItem.kind, number: subItem.number, items: [] };
    cursor.item.subLists.push(cursor.sub);
  }
  cursor.sub.items.push({ content: [subItem.content], subLists: [] });
}

function appendContinuation(cursor, text) {
  const innermost = cursor.sub === null ? cursor.item : cursor.sub.items[cursor.sub.items.length - 1];
  innermost.content.push(text);
}

function listHtml(list) {
  const items = list.items.map((item) => itemHtml(item)).join('');
  if (list.kind === 'ol') {
    return `<ol start="${list.number}">${items}</ol>`;
  }
  return `<ul>${items}</ul>`;
}

/* 项内多行按段落口径连接（<br>），子列表作为块级内容接在项文本之后（块边界不产生 <br>）。 */
function itemHtml(item) {
  const text = item.content.map((line) => renderInline(line)).join('<br>');
  const children = item.subLists.map((sub) => listHtml(sub)).join('');
  return `<li>${text}${children}</li>`;
}

/* ── 段落 ─────────────────────────────────────────────────── */

function renderParagraph(lines, start, chunks) {
  const content = [lines[start]];
  let index = start + 1;
  while (index < lines.length && lines[index].trim() !== '' && !startsBlock(lines, index)) {
    content.push(lines[index]);
    index++;
  }
  chunks.push(`<p>${content.map((line) => renderInline(line)).join('<br>')}</p>`);
  return index;
}

/* ── 行内 ─────────────────────────────────────────────────── */

/* 单遍左到右扫描：在当前位置按优先级试一个构造，命中即整段消费，否则透出该字符。
 * 行内构造不跨行——换行由块层转成 <br>，每行独立解析（跨行的 `` ` `` / `*` 因此不成构造）。 */
function renderInline(text) {
  let html = '';
  let index = 0;
  while (index < text.length) {
    const token = matchInline(text, index);
    if (token === null) {
      html += text[index];
      index++;
      continue;
    }
    html += token.html;
    index = token.next;
  }
  return html;
}

function matchInline(text, index) {
  const char = text[index];
  if (char === '\\') {
    return matchBackslashEscape(text, index);
  }
  if (char === '`') {
    return matchCodeSpan(text, index);
  }
  if (char === '[') {
    return matchLink(text, index);
  }
  if (char === '!') {
    return matchImage(text, index);
  }
  if (char === 'h') {
    return matchBareLink(text, index);
  }
  return matchDelimitedAt(text, index, char);
}

function matchDelimitedAt(text, index, char) {
  if (char === '*') {
    return matchDelimited(text, index, '**', 'strong') ?? matchDelimited(text, index, '*', 'em');
  }
  if (char === '~') {
    return matchDelimited(text, index, '~~', 'del');
  }
  return null;
}

function matchBackslashEscape(text, index) {
  if (index + 1 >= text.length) {
    return null;
  }
  const next = text[index + 1];
  if (INLINE_ESCAPABLE.has(next)) {
    return { html: next, next: index + 2 };
  }
  if (text.startsWith(ESCAPED_GT, index + 1)) {
    return { html: ESCAPED_GT, next: index + 1 + ESCAPED_GT.length };
  }
  return null;
}

function matchCodeSpan(text, index) {
  const ticks = runLength(text, index, '`');
  const close = findTickRun(text, index + ticks, ticks);
  if (close === -1) {
    return null;
  }
  return { html: `<code>${text.slice(index + ticks, close)}</code>`, next: close + ticks };
}

function runLength(text, index, char) {
  let end = index;
  while (end < text.length && text[end] === char) {
    end++;
  }
  return end - index;
}

/* 反引号「等长配对」：只认长度完全相同的下一段反引号串；找不到时开场串按字面输出（内容不定界）。 */
function findTickRun(text, from, ticks) {
  let index = from;
  while (index < text.length) {
    if (text[index] !== '`') {
      index++;
      continue;
    }
    const length = runLength(text, index, '`');
    if (length === ticks) {
      return index;
    }
    index += length;
  }
  return -1;
}

/* 强调从简：闭合定界符取最近的下一次同型出现；未闭合或空内容（如 `甲****乙` 里的相邻定界符）
 * 都按字面输出。内层按同一套行内规则再解析（`**粗 [x](http://y)**` 里的链接照常成立）。 */
function matchDelimited(text, index, marker, tag) {
  if (!text.startsWith(marker, index)) {
    return null;
  }
  const close = text.indexOf(marker, index + marker.length);
  if (close === -1 || close === index + marker.length) {
    return null;
  }
  const content = text.slice(index + marker.length, close);
  return { html: `<${tag}>${renderInline(content)}</${tag}>`, next: close + marker.length };
}

/* 链接文字（图片 alt 同理）按行内规则再解析：文字里若还有裸链或链接，会产出嵌套 <a>——
 * 已知结果，有意不改：浏览器解析器按规范自动把内层 <a> 修正为兄弟节点，观察窗只读呈现、
 * 不依赖该结构；要规避得给文字单独一套「禁链接」扫描，属超出封闭清单的新机制。 */
function matchLink(text, index) {
  const target = scanBracketTarget(text, index);
  if (target === null) {
    return null;
  }
  if (isLinkTarget(target)) {
    return { html: linkHtml(target.url, renderInline(target.label)), next: target.next };
  }
  return { html: text.slice(index, target.next), next: target.next };
}

function matchImage(text, index) {
  if (text[index + 1] !== '[') {
    return null;
  }
  const target = scanBracketTarget(text, index + 1);
  if (target === null) {
    return null;
  }
  if (!isLinkTarget(target)) {
    return { html: text.slice(index, target.next), next: target.next };
  }
  return { html: linkHtml(target.url, `🖼 ${renderInline(target.label)}`), next: target.next };
}

/* `[文字](url)` 的语法段扫描：文字取到最近的 `](`（不支持 title 写法，`](` 前的内容都算文字）；
 * URL 取到括号平衡的收尾 `)`（URL 内可以再有括号，嵌套层数由白名单判定）；括号不闭合、无收尾
 * `)` 的都不算构造，按普通文本继续扫描。 */
function scanBracketTarget(text, index) {
  const bracket = text.indexOf('](', index + 1);
  if (bracket === -1) {
    return null;
  }
  const end = findParenClose(text, bracket + 2);
  if (end === null) {
    return null;
  }
  return {
    label: text.slice(index + 1, bracket),
    url: text.slice(bracket + 2, end.index),
    depth: end.depth,
    next: end.index + 1,
  };
}

function findParenClose(text, from) {
  let depth = 0;
  let maxDepth = 0;
  let index = from;
  while (index < text.length) {
    const char = text[index];
    if (char === '(') {
      depth++;
      maxDepth = Math.max(maxDepth, depth);
    } else if (char === ')') {
      if (depth === 0) {
        return { index, depth: maxDepth };
      }
      depth--;
    }
    index++;
  }
  return null;
}

/* 出链接的白名单：URL 不得含空白与中文标点、括号单层平衡；scheme 归一（剥首部空白、大小写不敏感）
 * 后仅 http/https。不满足的整段按字面输出（不产出 href，也就没有伪协议面与 title 走私面）。 */
function isLinkTarget(target) {
  if (target.depth > 1 || URL_WHITESPACE_RE.test(target.url) || containsUrlBoundaryPunctuation(target.url)) {
    return false;
  }
  return HTTP_SCHEME_RE.test(target.url);
}

function containsUrlBoundaryPunctuation(url) {
  for (const char of url) {
    if (URL_BOUNDARY_PUNCTUATION.has(char)) {
      return true;
    }
  }
  return false;
}

/* href 直接取转义后文本：不反转义、不重新拼装——属性边界由转义保证（输入里的引号已是实体）。 */
function linkHtml(url, label) {
  return `<a href="${url}" target="_blank" rel="noopener">${label}</a>`;
}

function matchBareLink(text, index) {
  const scheme = bareSchemeAt(text, index);
  if (scheme === null) {
    return null;
  }
  let end = index + scheme.length;
  while (end < text.length && !isBareLinkStop(text, end)) {
    end++;
  }
  end = trimLinkTail(text, end);
  if (end <= index + scheme.length) {
    return null;
  }
  const url = text.slice(index, end);
  return { html: linkHtml(url, url), next: end };
}

function bareSchemeAt(text, index) {
  if (text.startsWith('https://', index)) {
    return 'https://';
  }
  if (text.startsWith('http://', index)) {
    return 'http://';
  }
  return null;
}

/* 裸链边界：空白、< >（转义形态）与中文标点（URL 里出现中文标点即属正文）；
 * 只剩 scheme、没有主体的不成为链接。 */
function isBareLinkStop(text, index) {
  const char = text[index];
  return URL_WHITESPACE_RE.test(char)
    || URL_BOUNDARY_PUNCTUATION.has(char)
    || text.startsWith(ESCAPED_LT, index)
    || text.startsWith(ESCAPED_GT, index);
}

/* 尾随句读不并入链接（句中 URL 后跟句号 / 逗号 / 右括号等）；剥离可连做（`http://a.)` 这类）。
 * 两条实体保全规则：`"` / `'` 在转义文本里是 &quot; / &#39;，先按实体整段剥（它们本身就是栏里的
 * 句读，剥掉即去掉那个字符）；而 `&名字;` 形状的收尾（对端正文里的每个 `&` 都转义成 &amp;，
 * 天然长这样）整体保留——那里的分号属模块自己转义的实体，按句读剥会把 URL 断成半个实体。 */
function trimLinkTail(text, end) {
  let trimmed = end;
  while (trimmed > 0) {
    if (text.endsWith(ESCAPED_QUOTE, trimmed)) {
      trimmed -= ESCAPED_QUOTE.length;
      continue;
    }
    if (text.endsWith(ESCAPED_APOSTROPHE, trimmed)) {
      trimmed -= ESCAPED_APOSTROPHE.length;
      continue;
    }
    if (isEntityTerminator(text, trimmed)) {
      break;
    }
    if (LINK_TAIL_PUNCTUATION.has(text[trimmed - 1])) {
      trimmed--;
      continue;
    }
    break;
  }
  return trimmed;
}

/* 收尾的 `;` 是不是 `&名字;` 实体的终止符（名字非空、以 `&` 起）——是则不剥、不切开。 */
function isEntityTerminator(text, end) {
  if (text[end - 1] !== ';') {
    return false;
  }
  let index = end - 2;
  while (index >= 0 && ENTITY_NAME_CHAR_RE.test(text[index])) {
    index--;
  }
  return index < end - 2 && index >= 0 && text[index] === '&';
}
