/* 人类观察窗页面资产：整页 HTML、客户端脚本与样式表——以字符串常量内嵌，由 HTTP 服务直出
 * （GET /、/app.js、/style.css）。零构建步骤、零外部资源（无 CDN、字体、图片、外链），
 * 页面只与本机 /api/* 相对路径通信。
 *
 * 嵌入纪律（硬）：客户端脚本不用反引号模板字面量与模板插值序列（拼串一律用 +）——脚本要经
 * 宿主字符串承载，反引号在宿主层就是字符串边界、模板插值会在宿主层被提前展开，两者都会「自咬」；
 * 三个常量一律用 String.raw 让嵌入文本按字面承载，语法自检由单测的 new Function 兜底。
 *
 * 渲染安全纪律（硬）：服务端渲染好的 html 片段是 innerHTML 的唯一来源（服务端已转义）；
 * 其余外部字段（作者名 / kind / topic / 状态词 / 事件文本 / 列表字段）一律 textContent 或
 * createElement 属性赋值注入——非 html 字段只要被拼进 HTML 字符串，就绕过渲染器的转义面，
 * 等价于重新打开一个注入点。 */

export const INDEX_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>waystation 观察窗</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header id="app-bar">
  <span id="app-title">waystation 观察窗</span>
  <span id="app-status"></span>
  <span id="app-buttons">
    <button id="font-down" type="button" title="缩小字号">A−</button>
    <button id="font-reset" type="button" title="重置字号">重置</button>
    <button id="font-up" type="button" title="放大字号">A＋</button>
    <button id="pause" type="button" hidden>暂停</button>
  </span>
</header>
<main id="list-view" hidden></main>
<main id="detail-view" hidden>
  <div id="banner"></div>
  <div id="detail-body">
    <div id="stream-pane">
      <div id="stream"></div>
      <button id="new-badge" type="button" hidden></button>
    </div>
    <aside id="event-pane">
      <h2 class="pane-title">事件轨</h2>
      <div id="event-track"></div>
    </aside>
  </div>
</main>
<noscript>观察窗页面需要启用 JavaScript 才能渲染。</noscript>
<script src="/app.js" defer></script>
</body>
</html>`;

export const APP_JS = String.raw`/* 观察窗客户端：hash 路由（#/ 列表、#/c/<root>/<id> 详情）＋ 1s 轮询增量渲染。
 * 本文件禁用反引号与模板插值序列（见 assets.js 头注的嵌入纪律），拼串一律用 +。 */
(function () {
  'use strict';

  /* 轮询周期：设计钉死的 1s 节拍；贴底容差给亚像素滚动与行高取整留余量——太小会把
   * 「贴着底看」误判成「用户上滚了」，太大则上滚一点点仍会被抢滚。 */
  const POLL_INTERVAL_MS = 1000;
  const BOTTOM_SLACK_PX = 24;

  /* 作者色签：逐码位滚动哈希取 8 色之一，只要求同作者恒同色——不承担密码学职责。 */
  const PALETTE_SIZE = 8;
  const HASH_BASE = 31;
  const HASH_MODULO = 1000003;

  /* 路由段形态判据（与协议 ID 形态一致）：列表里的 id 直接拼进 href，非形态安全值不得进 URL。 */
  const ID_MAX_CHARS = 64;
  const ZERO_CODE = '0'.charCodeAt(0);
  const NINE_CODE = '9'.charCodeAt(0);

  /* 字号：localStorage 持久；档距 25%（两三下就能明显看出变化）；上下限防止把布局撑到不可用。 */
  const FONT_SCALE_KEY = 'ws-viewer:fontScale';
  const FONT_DEFAULT_PX = 16;
  const FONT_MIN_PX = 12;
  const FONT_MAX_PX = 28;
  const FONT_STEP = 1.25;

  const NOT_READY_TEXT = '数据未就绪';
  const NOT_READY_ENTRY = '（数据未就绪）';
  /* 标题与静音横幅文案（设计 §3.3／§3.5 写死的要素；反引号属设计文档的 Markdown 代码标记，
   * 页面按纯文本呈现命令名）。 */
  const DEFAULT_TITLE = 'waystation 观察窗';
  const MUTE_BANNER_TEXT = '🔇 本协作已静音——消息不注入 AI 会话（观察窗照常显示）；要让本会话实时跟进，用 /ws-mute 取消静音';

  /* 状态词表对齐终端查看器与状态栏的既有口径；词表外取值原样呈现，不自造词。 */
  const MODE_LABELS = new Map([['forum', '讨论'], ['managed', '协作']]);
  const STATE_LABELS = new Map([
    ['proposed', '待同意'],
    ['active', '进行中'],
    ['frozen', '冻结'],
    ['completed', '已结束'],
    ['terminated', '已终止'],
    ['left', '已退出'],
  ]);

  const state = {
    routeGen: 0,
    view: 'list',
    root: '',
    id: '',
    mode: '',
    feedAnchor: null,
    metaAnchor: null,
    lastSkipped: 0,
    feedSkipped: 0,
    lastFeedSkipped: 0,
    lastDate: null,
    follow: true,
    pending: 0,
    paused: false,
    gone: false,
    errors: { feed: false, meta: false },
    feedBusy: false,
    metaBusy: false,
    fontScale: FONT_DEFAULT_PX,
  };

  const dom = {};

  /* —— 通用小工具 —— */

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined && text !== null) {
      node.textContent = text;
    }
    return node;
  }

  function appendText(parent, text) {
    parent.appendChild(document.createTextNode(text));
  }

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function timeOf(ts) {
    const at = new Date(ts);
    return pad2(at.getHours()) + ':' + pad2(at.getMinutes()) + ':' + pad2(at.getSeconds());
  }

  function dateOf(ts) {
    const at = new Date(ts);
    return at.getFullYear() + '-' + pad2(at.getMonth() + 1) + '-' + pad2(at.getDate());
  }

  function stampOf(ms) {
    return dateOf(ms) + ' ' + timeOf(ms);
  }

  function modeLabel(mode) {
    const label = MODE_LABELS.get(mode);
    return label === undefined ? String(mode) : label;
  }

  function stateLabel(value) {
    if (value === null || value === undefined) {
      return NOT_READY_TEXT;
    }
    const label = STATE_LABELS.get(value);
    return label === undefined ? String(value) : label;
  }

  function colorIndex(name) {
    let hash = 0;
    for (const ch of name) {
      hash = (hash * HASH_BASE + ch.codePointAt(0)) % HASH_MODULO;
    }
    return hash % PALETTE_SIZE;
  }

  /* 作者色签：色块＝名字首字，同作者恒同色；徽标与名字都走 textContent。 */
  function chipOf(name) {
    const text = (name === null || name === undefined || name === '') ? '？' : String(name);
    const chip = el('span', 'chip');
    chip.appendChild(el('span', 'chip-badge chip-' + colorIndex(text), Array.from(text)[0]));
    chip.appendChild(el('span', 'chip-name', text));
    return chip;
  }

  /* —— 路由 —— */

  function isDigits(text) {
    if (text === '') {
      return false;
    }
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code < ZERO_CODE || code > NINE_CODE) {
        return false;
      }
    }
    return true;
  }

  function isRootToken(root) {
    if (root === 'main') {
      return true;
    }
    return root.charAt(0) === 's' && isDigits(root.slice(1));
  }

  /* id 允许的字符类（字母 / 数字 / 连字符）：用区间比较写，避免正则——宿主字符串层对反斜杠
   * 的处理不参与本文件语义，字符判据是这条链上最容易出错的环节，写成最直白的形式。 */
  function isIdChar(ch) {
    return (ch >= '0' && ch <= '9')
      || (ch >= 'a' && ch <= 'z')
      || (ch >= 'A' && ch <= 'Z')
      || ch === '-';
  }

  function isIdToken(id) {
    if (id.length === 0 || id.length > ID_MAX_CHARS) {
      return false;
    }
    for (let index = 0; index < id.length; index++) {
      if (!isIdChar(id.charAt(index))) {
        return false;
      }
    }
    return true;
  }

  function parseRoute(hash) {
    if (hash === '' || hash === '#' || hash === '#/') {
      return { view: 'list' };
    }
    if (hash.indexOf('#/c/') === 0) {
      const parts = hash.slice(4).split('/');
      if (parts.length === 2 && isRootToken(parts[0]) && isIdToken(parts[1])) {
        return { view: 'detail', root: parts[0], id: parts[1] };
      }
    }
    return { view: 'unknown' };
  }

  /* 视图间共用状态归零：锚点、跟随与浮标、错误标记——新视图从干净态起步。
   * 忙标记一并归零：新视图首屏不被旧视图的在途请求迟滞（旧请求的 finally 有代次守卫，不会误清新拍标记）。 */
  function resetViewState() {
    state.feedAnchor = null;
    state.metaAnchor = null;
    state.mode = '';
    state.lastSkipped = 0;
    state.feedSkipped = 0;
    state.lastFeedSkipped = 0;
    state.lastDate = null;
    state.follow = true;
    state.pending = 0;
    state.paused = false;
    state.gone = false;
    state.errors = { feed: false, meta: false };
    state.feedBusy = false;
    state.metaBusy = false;
    dom.status.textContent = '';
    dom.badge.hidden = true;
    dom.pause.textContent = '暂停';
  }

  function onRoute() {
    const route = parseRoute(window.location.hash);
    if (route.view === 'unknown') {
      window.location.hash = '#/';   // 归一到列表；赋值会再触发 hashchange 走完整流程
      return;
    }
    state.routeGen++;                // 作废在途响应：旧路由的返回不得落进新视图
    resetViewState();
    state.view = route.view;
    state.root = route.root === undefined ? '' : route.root;
    state.id = route.id === undefined ? '' : route.id;
    dom.listView.hidden = route.view !== 'list';
    dom.detailView.hidden = route.view !== 'detail';
    dom.pause.hidden = route.view !== 'detail';
    applyTitle(null);
    if (route.view === 'detail') {
      startDetail();
      return;
    }
    loadList();
  }

  /* —— 列表视图 —— */

  function countSegmentOf(item) {
    if (item.count === null || item.count === undefined) {
      return NOT_READY_ENTRY;
    }
    return item.mode === 'forum' ? item.count + ' 帖' : '累计收到 ' + item.count + ' 条';
  }

  function collabRowNode(item) {
    const row = el('a', 'collab-row');
    row.href = '#/c/' + item.root + '/' + item.id;
    const name = el('span', 'collab-name', item.name === null || item.name === undefined ? NOT_READY_ENTRY : item.name);
    if (item.root !== 'main') {
      name.appendChild(el('span', 'collab-site', '站点#' + item.root.slice(1)));
    }
    row.appendChild(name);
    if (item.muted === true) {
      row.appendChild(el('span', 'collab-muted', '🔇'));
    }
    appendText(row, ' — ');
    row.appendChild(el('span', 'collab-mode', modeLabel(item.mode)));
    appendText(row, ' — ');
    row.appendChild(el('span', 'collab-state', item.state === null || item.state === undefined ? NOT_READY_ENTRY : stateLabel(item.state)));
    appendText(row, ' — ');
    row.appendChild(el('span', 'collab-people', item.memberCount + ' 人'));
    appendText(row, ' — ');
    row.appendChild(el('span', 'collab-count', countSegmentOf(item)));
    appendText(row, ' — ');
    row.appendChild(el('span', 'collab-updated', stampOf(item.updatedAt)));
    return row;
  }

  function renderList(items) {
    dom.listView.replaceChildren();
    if (items.length === 0) {
      dom.listView.appendChild(el('div', 'empty-note', '本机暂无协作或讨论'));
      return;
    }
    const list = el('div', 'collab-list');
    for (const item of items) {
      list.appendChild(collabRowNode(item));
    }
    dom.listView.appendChild(list);
  }

  /* 列表只在进入视图时拉一次：刷新动作发生在详情页，列表不需要秒级跟随。 */
  function loadList() {
    const gen = state.routeGen;
    fetchJson('/api/collabs').then(function (data) {
      if (gen !== state.routeGen) {
        return;
      }
      renderList(data.collabs || []);
    }).catch(function () {
      if (gen !== state.routeGen) {
        return;
      }
      dom.listView.replaceChildren(el('div', 'empty-note', '读取失败（连接中断），请刷新页面重试'));
    });
  }

  /* —— 详情视图：横幅 / 流 / 事件轨 —— */

  function showBannerNotReady() {
    dom.banner.replaceChildren(el('div', 'banner-line', NOT_READY_TEXT));
  }

  function renderBanner(meta) {
    if (meta.name === null && meta.state === null) {
      showBannerNotReady();
      return;
    }
    const nameText = meta.name === null || meta.name === undefined ? NOT_READY_ENTRY : meta.name;
    const line = el('div', 'banner-line');
    line.appendChild(el('span', 'banner-name', '【' + nameText + '】' + stateLabel(meta.state)));
    appendText(line, ' ｜ ');
    line.appendChild(el('span', 'banner-mode', modeLabel(meta.mode)));
    appendText(line, ' ｜ ');
    line.appendChild(el('span', 'banner-people', meta.memberCount + ' 人'));
    appendText(line, ' ｜ ');
    line.appendChild(el('span', 'banner-count', countSegmentOf(meta)));
    dom.banner.replaceChildren(line);
    if (meta.topic !== null && meta.topic !== undefined && meta.topic !== '') {
      dom.banner.appendChild(el('div', 'banner-topic', meta.topic));
    }
    /* 静音横幅随 meta 每拍重渲：false 时不渲染即天然移除（无需另写撤销路径）。 */
    if (meta.muted === true) {
      dom.banner.appendChild(el('div', 'banner-muted', MUTE_BANNER_TEXT));
    }
  }

  /* 窗口标题（设计 §3.5）：meta 就位后带协作名；名称未就绪（null/缺失/空）保持默认标题——
   * 路由切换先归默认，避免详情间切换时短暂挂着上一协作的名字。 */
  function applyTitle(name) {
    const named = typeof name === 'string' && name !== '';
    document.title = named ? DEFAULT_TITLE + ' · ' + name : DEFAULT_TITLE;
  }

  /* 一行流：时间（悬停完整 ISO）＋方向（协作行）＋作者色签＋kind 徽标＋正文。
   * 正文是服务端渲染好的 html 片段（唯一允许的 innerHTML 入口）；其余字段全部 textContent。 */
  function feedRowNode(row) {
    const wrap = el('div', 'feed-row');
    const head = el('div', 'feed-head');
    const time = el('span', 'feed-time', timeOf(row.ts));
    time.title = row.ts;
    head.appendChild(time);
    if (row.direction === 'out' || row.direction === 'in') {
      head.appendChild(el('span', 'feed-direction', row.direction === 'out' ? '→' : '←'));
    }
    head.appendChild(chipOf(row.fromName));
    head.appendChild(el('span', 'feed-kind', row.kind));
    if (typeof row.count === 'number' && row.count > 1) {
      head.appendChild(el('span', 'feed-count', '（' + row.count + ' 人）'));
    }
    wrap.appendChild(head);
    const body = el('div', 'msg-body');
    body.innerHTML = typeof row.html === 'string' ? row.html : '';
    wrap.appendChild(body);
    return wrap;
  }

  function appendFeedRows(rows) {
    for (const row of rows) {
      const day = dateOf(row.ts);
      if (day !== state.lastDate) {
        state.lastDate = day;
        dom.stream.appendChild(el('div', 'day-row', day));
      }
      dom.stream.appendChild(feedRowNode(row));
    }
  }

  function eventRowNode(event) {
    const row = el('div', 'event-row');
    row.appendChild(el('span', 'event-time', timeOf(event.ts)));
    row.appendChild(el('span', 'event-text', event.text));
    return row;
  }

  /* reset 清屏按 class token 只清本面节点：两面同拍重渲时不误清另一面的计数行与水位。
   * 先收集后重设——不边遍历边改（HTMLCollection 是活集合）。 */
  function clearByClass(token) {
    const kept = [];
    for (const node of dom.eventTrack.children) {
      if (!String(node.className).split(' ').includes(token)) {
        kept.push(node);
      }
    }
    dom.eventTrack.replaceChildren(...kept);
  }

  /* 元状态面坏行提示（meta.skipped：成员的加入/退出事件、台账行；讨论的帖行也并入本面）：
   * 计数有增才补一行，绝不重复刷屏；reset 清屏时水位归零，提示可在重渲后重现。 */
  function applySkipped(skipped) {
    if (typeof skipped !== 'number' || skipped <= state.lastSkipped) {
      return;
    }
    state.lastSkipped = skipped;
    dom.eventTrack.appendChild(el('div', 'event-skipped event-skipped-meta', '跳过 ' + skipped + ' 条无法解析的记录'));
  }

  /* 会话流面坏行提示（feed.skipped）：只对协作显示——讨论的帖行坏行已并入 meta 行，
   * 不分面门控会在讨论里出现两行同一个数。水位独立于 meta 行，有增才显示。 */
  function applyFeedSkipped() {
    if (state.mode !== 'managed' || state.feedSkipped <= state.lastFeedSkipped) {
      return;
    }
    state.lastFeedSkipped = state.feedSkipped;
    dom.eventTrack.appendChild(el('div', 'event-skipped event-skipped-feed', '会话流跳过 ' + state.feedSkipped + ' 条无法解析的记录'));
  }

  function applyEvents(events) {
    if (events === undefined) {
      return;
    }
    if (events.reset === true) {
      clearByClass('event-row');
      clearByClass('event-skipped-meta');
      state.metaAnchor = null;
      state.lastSkipped = 0;
    }
    const rows = events.rows || [];
    for (const row of rows) {
      dom.eventTrack.appendChild(eventRowNode(row));
    }
    if (rows.length > 0) {
      state.metaAnchor = rows[rows.length - 1].id;
    }
  }

  function applyMeta(data) {
    state.mode = data.mode === undefined ? '' : data.mode;
    applyEvents(data.events);
    applySkipped(data.skipped);
    applyFeedSkipped();   // feed 可能先于 meta 落地：mode 就位后再看会话流计数行
    renderBanner(data);
    applyTitle(data.name);
  }

  /* —— 跟随与浮标 —— */

  function atBottom() {
    return dom.stream.scrollHeight - dom.stream.scrollTop - dom.stream.clientHeight <= BOTTOM_SLACK_PX;
  }

  function updateBadge() {
    dom.badge.hidden = state.pending === 0;
    if (state.pending > 0) {
      dom.badge.textContent = state.pending + ' 条新消息 ↓';
    }
  }

  function scrollToBottom() {
    dom.stream.scrollTop = dom.stream.scrollHeight;
    state.pending = 0;
    updateBadge();
  }

  /* 新行落地后：跟随态直接滚底；用户上滚过则把行数记进浮标，绝不抢滚。 */
  function markArrived(count) {
    if (count === 0) {
      return;
    }
    if (state.follow) {
      scrollToBottom();
      return;
    }
    state.pending += count;
    updateBadge();
  }

  function onStreamScroll() {
    state.follow = atBottom();
    if (state.follow && state.pending > 0) {
      state.pending = 0;
      updateBadge();
    }
  }

  /* —— 轮询 —— */

  /* 锚点原样拼进 query：行 id 的字符集（uuid 十六进制与 -，分隔符 @ / :）全在 URL query 的
   * 合法字符集内——不做百分号编码，就不引入「服务端是否解码」的依赖（两种口径都命中同一锚点）。 */
  function faceUrl(face, after) {
    let url = '/api/collab/' + state.root + '/' + state.id + '/' + face;
    if (after !== null) {
      url += '?after=' + after;
    }
    return url;
  }

  function fetchJson(url) {
    return fetch(url, { cache: 'no-store' }).then(function (response) {
      if (!response.ok) {
        const failure = new Error('HTTP ' + response.status);
        failure.status = response.status;
        throw failure;
      }
      return response.json();
    });
  }

  /* 状态行按面记账（feed / meta 各一位）：一面瞬时失败、另一面成功时不互相抹掉提示。 */
  function refreshStatus() {
    if (state.gone) {
      return;   // 已判定的「未找到」提示不被另一面尚在途的成功响应抹掉
    }
    const failed = state.errors.feed || state.errors.meta;
    dom.status.textContent = failed ? '连接中断，重试中…' : '';
  }

  /* 轮询失败面：404＝该协作已不在数据面（目录被清理），停轮询并如实说；其余按瞬时故障重试。 */
  function handlePollFailure(error, face) {
    if (error.status === 404) {
      state.gone = true;
      dom.status.textContent = '未找到该协作，可能已被清理';
      return;
    }
    state.errors[face] = true;
    refreshStatus();
  }

  /* 单面上限一并发：1s 节拍下若上一次仍在途，重入会把同一段增量渲染两遍。 */
  function pollFeed() {
    if (state.paused || state.gone || state.feedBusy) {
      return;
    }
    const gen = state.routeGen;
    state.feedBusy = true;
    fetchJson(faceUrl('feed', state.feedAnchor)).then(function (data) {
      // 暂停期间结算的响应丢弃且不推进锚点：恢复补拉从暂停前的锚点接上，一笔不漏
      if (gen !== state.routeGen || state.paused) {
        return;
      }
      applyFeed(data);
      state.errors.feed = false;
      refreshStatus();
    }).catch(function (error) {
      if (gen === state.routeGen && !state.paused) {
        handlePollFailure(error, 'feed');
      }
    }).finally(function () {
      // 代次守卫：路由切换已把忙标记归零，旧请求结算不得误清新视图的标记
      if (gen === state.routeGen) {
        state.feedBusy = false;
      }
    });
  }

  function pollMeta() {
    if (state.paused || state.gone || state.metaBusy) {
      return;
    }
    const gen = state.routeGen;
    state.metaBusy = true;
    fetchJson(faceUrl('meta', state.metaAnchor)).then(function (data) {
      if (gen !== state.routeGen || state.paused) {
        return;
      }
      applyMeta(data);
      state.errors.meta = false;
      refreshStatus();
    }).catch(function (error) {
      if (gen === state.routeGen && !state.paused) {
        handlePollFailure(error, 'meta');
      }
    }).finally(function () {
      if (gen === state.routeGen) {
        state.metaBusy = false;
      }
    });
  }

  /* 增量落地：reset＝清屏全量重渲并重置锚点（锚点缺失时服务端也回全量）；锚点取本批末行 id。
   * 重渲前记下「离底距离」：非跟随态按同一距离恢复——上滚阅读的位置不被 reset 甩到顶部
   * （此处不计浮标：重渲的行不是新消息，是同一批内容的重建）。 */
  function applyFeed(data) {
    const isReset = data.reset === true;
    const distanceFromBottom = isReset ? dom.stream.scrollHeight - dom.stream.scrollTop : 0;
    if (isReset) {
      dom.stream.replaceChildren();
      clearByClass('event-skipped-feed');
      state.feedAnchor = null;
      state.lastDate = null;
      state.pending = 0;
      state.lastFeedSkipped = 0;   // reset 后会话流计数行可重现（旧行清掉、水位归零）
      updateBadge();
    }
    const rows = data.rows || [];
    appendFeedRows(rows);
    if (rows.length > 0) {
      state.feedAnchor = rows[rows.length - 1].id;
    }
    state.feedSkipped = typeof data.skipped === 'number' ? data.skipped : 0;
    applyFeedSkipped();
    if (!isReset) {
      markArrived(rows.length);
      return;
    }
    if (state.follow) {
      scrollToBottom();
      return;
    }
    dom.stream.scrollTop = Math.max(0, dom.stream.scrollHeight - distanceFromBottom);
  }

  function tick() {
    if (state.view !== 'detail') {
      return;
    }
    pollFeed();
    pollMeta();
  }

  function togglePause() {
    state.paused = !state.paused;
    dom.pause.textContent = state.paused ? '恢复' : '暂停';
    if (!state.paused) {
      pollFeed();     // 恢复即补拉一次，不等下一拍
      pollMeta();
    }
  }

  function startDetail() {
    dom.stream.replaceChildren();
    dom.eventTrack.replaceChildren();
    showBannerNotReady();
    pollFeed();
    pollMeta();
  }

  /* —— 字号 —— */

  function readFontScale() {
    let stored = null;
    try {
      stored = window.localStorage.getItem(FONT_SCALE_KEY);
    } catch (error) {
      stored = null;   // 隐私模式等禁用存储：按默认字号起步（写侧同样降级）
    }
    const parsed = Number(stored);
    if (!Number.isFinite(parsed) || parsed < FONT_MIN_PX || parsed > FONT_MAX_PX) {
      return FONT_DEFAULT_PX;
    }
    return parsed;
  }

  function applyFontScale(px) {
    const clamped = Math.min(FONT_MAX_PX, Math.max(FONT_MIN_PX, Math.round(px)));
    state.fontScale = clamped;
    document.documentElement.style.fontSize = clamped + 'px';
    try {
      window.localStorage.setItem(FONT_SCALE_KEY, String(clamped));
    } catch (error) {
      // 存储不可用时仅本次生效：字号是观看偏好，失败不值得打断渲染
    }
  }

  /* —— 启动 —— */

  function cacheDom() {
    dom.status = document.getElementById('app-status');
    dom.fontUp = document.getElementById('font-up');
    dom.fontDown = document.getElementById('font-down');
    dom.fontReset = document.getElementById('font-reset');
    dom.pause = document.getElementById('pause');
    dom.listView = document.getElementById('list-view');
    dom.detailView = document.getElementById('detail-view');
    dom.banner = document.getElementById('banner');
    dom.stream = document.getElementById('stream');
    dom.badge = document.getElementById('new-badge');
    dom.eventTrack = document.getElementById('event-track');
  }

  function boot() {
    cacheDom();
    applyFontScale(readFontScale());
    dom.fontUp.addEventListener('click', function () {
      applyFontScale(state.fontScale * FONT_STEP);
    });
    dom.fontDown.addEventListener('click', function () {
      applyFontScale(state.fontScale / FONT_STEP);
    });
    dom.fontReset.addEventListener('click', function () {
      applyFontScale(FONT_DEFAULT_PX);
    });
    dom.pause.addEventListener('click', togglePause);
    dom.badge.addEventListener('click', function () {
      state.follow = true;
      scrollToBottom();
    });
    dom.stream.addEventListener('scroll', onStreamScroll);
    window.addEventListener('hashchange', onRoute);
    window.setInterval(tick, POLL_INTERVAL_MS);
    onRoute();
  }

  boot();
})();`;

export const STYLE_CSS = String.raw`/* 深色单主题（设计裁定）：主题变量集中在 :root，色签 8 色与语义色同表定义；
 * 正文区 overflow-wrap: anywhere 兜底超长不可断串（协议允许 4000 字符单行）。 */
:root {
  color-scheme: dark;
  --bg: #14161b;
  --bg-raised: #1b1f27;
  --bg-code: #191d25;
  --line: #2a303c;
  --fg: #dde3ee;
  --fg-dim: #939db1;
  --accent: #6ea8ff;
  --warn: #ffb454;
  --chip-0: #e57373;
  --chip-1: #f0a35e;
  --chip-2: #e3cf6a;
  --chip-3: #7ec87e;
  --chip-4: #4dc9c9;
  --chip-5: #5aa9f0;
  --chip-6: #9a8cf0;
  --chip-7: #e07ad0;
}

* { box-sizing: border-box; }

[hidden] { display: none !important; }

html { font-size: 16px; }

body {
  margin: 0;
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  color: var(--fg);
  font-family: "Microsoft YaHei", "PingFang SC", system-ui, sans-serif;
  font-size: 1rem;
  line-height: 1.5;
}

/* —— 顶栏 —— */

#app-bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.5rem 0.8rem;
  background: var(--bg-raised);
  border-bottom: 1px solid var(--line);
}

#app-title { font-weight: 600; }

#app-status { flex: 1; color: var(--warn); font-size: 0.85rem; }

#app-buttons { display: flex; gap: 0.35rem; }

button {
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--line);
  border-radius: 0.35rem;
  padding: 0.2rem 0.6rem;
  font-family: inherit;
  font-size: 0.9rem;
  cursor: pointer;
}

button:hover { border-color: var(--accent); }

/* —— 列表视图 —— */

#list-view { flex: 1; min-height: 0; overflow-y: auto; padding: 0.6rem 0.8rem; }

.collab-row {
  display: block;
  padding: 0.55rem 0.7rem;
  border-bottom: 1px solid var(--line);
  color: inherit;
  text-decoration: none;
  overflow-wrap: anywhere;
}

.collab-row:hover { background: var(--bg-raised); }

.collab-name { font-weight: 600; }

.collab-site {
  margin-left: 0.45rem;
  padding: 0 0.35rem;
  border: 1px solid var(--line);
  border-radius: 0.25rem;
  color: var(--fg-dim);
  font-size: 0.78rem;
  font-weight: 400;
}

.collab-mode, .collab-people, .collab-count, .collab-state, .collab-updated { color: var(--fg-dim); }

/* 静音标记：行内小间距即可，颜色从简（emoji 自带字形色） */
.collab-muted { margin-left: 0.35rem; font-weight: 400; }

.empty-note { padding: 1.2rem; color: var(--fg-dim); text-align: center; }

/* —— 详情视图 —— */

#detail-view { flex: 1; min-height: 0; display: flex; flex-direction: column; }

#banner {
  flex: none;
  padding: 0.55rem 0.8rem;
  background: var(--bg-raised);
  border-bottom: 1px solid var(--line);
  overflow-wrap: anywhere;
}

.banner-line { font-weight: 600; }

.banner-mode, .banner-people, .banner-count { color: var(--fg-dim); font-weight: 400; }

.banner-topic { margin-top: 0.15rem; color: var(--fg-dim); font-size: 0.85rem; font-weight: 400; }

/* 静音提醒行：与顶栏状态提示同用 --warn（同为「需要注意的运行态」语义） */
.banner-muted { margin-top: 0.15rem; color: var(--warn); font-size: 0.85rem; font-weight: 400; }

#detail-body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 21rem;
}

#stream-pane { position: relative; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }

#stream { flex: 1; min-height: 0; overflow-y: auto; padding: 0.5rem 0.8rem; }

#event-pane { min-height: 0; overflow-y: auto; padding: 0.5rem 0.7rem; border-left: 1px solid var(--line); }

.pane-title { margin: 0 0 0.4rem; color: var(--fg-dim); font-size: 0.85rem; font-weight: 600; }

/* 窄屏：事件轨折叠到流底部（响应式顺带，不做专门设计）。 */
@media (max-width: 880px) {
  #detail-body { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) auto; }
  #event-pane { border-left: none; border-top: 1px solid var(--line); max-height: 32vh; }
}

/* —— 主栏流 —— */

.feed-row { padding: 0.35rem 0.15rem 0.5rem; border-bottom: 1px dashed var(--line); }

.feed-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.45rem;
  color: var(--fg-dim);
  font-size: 0.78rem;
}

.feed-time { font-variant-numeric: tabular-nums; }

.feed-direction { color: var(--accent); font-weight: 700; }

.feed-kind { padding: 0 0.3rem; border: 1px solid var(--line); border-radius: 0.25rem; }

.feed-count { color: var(--accent); }

.day-row { margin: 0.5rem 0 0.1rem; color: var(--fg-dim); font-size: 0.8rem; text-align: center; }

.chip { display: inline-flex; align-items: center; gap: 0.3rem; }

.chip-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.35em;
  height: 1.35em;
  border-radius: 0.3rem;
  background: var(--fg-dim);
  color: #12151b;
  font-weight: 700;
}

.chip-name { color: var(--fg-dim); }

/* 色签 8 色：放在 .chip-badge 之后，同特异性下后写者胜 */
.chip-0 { background: var(--chip-0); }
.chip-1 { background: var(--chip-1); }
.chip-2 { background: var(--chip-2); }
.chip-3 { background: var(--chip-3); }
.chip-4 { background: var(--chip-4); }
.chip-5 { background: var(--chip-5); }
.chip-6 { background: var(--chip-6); }
.chip-7 { background: var(--chip-7); }

/* —— 消息正文（Markdown 渲染产物）—— */

.msg-body { margin-top: 0.3rem; overflow-wrap: anywhere; }

.msg-body > :first-child { margin-top: 0; }

.msg-body > :last-child { margin-bottom: 0; }

.msg-body p { margin: 0.45rem 0; }

.msg-body h1, .msg-body h2, .msg-body h3, .msg-body h4, .msg-body h5, .msg-body h6 {
  margin: 0.7rem 0 0.3rem;
  line-height: 1.3;
}

.msg-body h1 { font-size: 1.5em; }
.msg-body h2 { font-size: 1.3em; }
.msg-body h3 { font-size: 1.15em; }
.msg-body h4 { font-size: 1.05em; }
.msg-body h5 { font-size: 0.95em; }
.msg-body h6 { color: var(--fg-dim); font-size: 0.9em; }

.msg-body a { color: var(--accent); }

.msg-body blockquote {
  margin: 0.45rem 0;
  padding: 0.1rem 0.7rem;
  border-left: 0.22rem solid var(--line);
  color: var(--fg-dim);
}

.msg-body ul, .msg-body ol { margin: 0.4rem 0; padding-left: 1.5rem; }

.msg-body code {
  padding: 0.05rem 0.3rem;
  background: var(--bg-code);
  border-radius: 0.25rem;
  font-family: Consolas, "Cascadia Mono", monospace;
  font-size: 0.92em;
}

.msg-body .md-code-block { position: relative; margin: 0.5rem 0; }

.msg-body .md-code {
  margin: 0;
  padding: 0.55rem 0.7rem;
  background: var(--bg-code);
  border: 1px solid var(--line);
  border-radius: 0.35rem;
  overflow-x: auto;
}

.msg-body .md-code code { padding: 0; background: none; }

.msg-body .md-code-lang {
  position: absolute;
  top: 0.3rem;
  right: 0.45rem;
  color: var(--fg-dim);
  font-size: 0.72rem;
}

.msg-body .md-table { width: 100%; margin: 0.5rem 0; border-collapse: collapse; }

.msg-body .md-table th, .msg-body .md-table td {
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--line);
  text-align: left;
}

.msg-body .md-table thead th { background: var(--bg-raised); }

.msg-body .md-table tbody tr:nth-child(even) { background: var(--bg-code); }

.msg-body hr { margin: 0.7rem 0; border: none; border-top: 1px solid var(--line); }

/* —— 事件轨 —— */

.event-row { display: flex; gap: 0.4rem; padding: 0.15rem 0; color: var(--fg-dim); font-size: 0.82rem; }

.event-time { flex: none; font-variant-numeric: tabular-nums; }

.event-text { overflow-wrap: anywhere; }

.event-skipped { margin-top: 0.4rem; color: var(--warn); font-size: 0.82rem; }

/* —— 新消息浮标 —— */

#new-badge {
  position: absolute;
  right: 1rem;
  bottom: 1rem;
  padding: 0.3rem 0.85rem;
  background: var(--accent);
  border: none;
  border-radius: 1rem;
  color: #0f1218;
  font-weight: 600;
  box-shadow: 0 0.2rem 0.6rem rgba(0, 0, 0, 0.45);
}`;
