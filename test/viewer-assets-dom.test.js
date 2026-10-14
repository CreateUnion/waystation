import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APP_JS } from '../src/viewer/assets.js';

/* 客户端行为的可复跑固化：自包含最小 DOM 桩（零依赖，不引 jsdom——项目零新增依赖），把 APP_JS
 * 当被测对象执行真实逻辑。桩只实现客户端实际用到的面：节点树、textContent、innerHTML 存储、
 * hidden、属性（title/href）、事件监听、滚动量、localStorage、fetch 编排队列。
 * 覆盖：列表与详情首屏、跨日分隔、方向标与（N 人）、锚点携带与 reset 清屏、上滚浮标、
 * 暂停冻结与在途丢弃、恢复补拉、字号持久与钳制、404 停轮询、非法 hash 归一、两行坏行计数。
 * 桩不模拟布局与 HTML 解析（innerHTML 只存字符串）——浏览器侧观感仍由人验收逐项过。 */

const MOUNT_IDS = [
  'app-status', 'font-up', 'font-down', 'font-reset', 'pause',
  'list-view', 'detail-view', 'banner', 'stream', 'new-badge', 'event-track',
];

const TS_MORNING = '2026-10-14T09:00:01.000Z';
const TS_NEXT_DAY = '2026-10-15T01:02:03.000Z';

class StubNode {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.className = '';
    this.textContent = '';
    this.hidden = false;
    this.html = null;
    this.attrs = {};
    this.listeners = {};
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
  }

  appendChild(node) {
    this.children.push(node);
    return node;
  }

  replaceChildren(...nodes) {
    this.children = nodes;
    this.textContent = '';
  }

  addEventListener(type, handler) {
    (this.listeners[type] = this.listeners[type] || []).push(handler);
  }

  set innerHTML(value) {
    this.html = value;
  }

  get innerHTML() {
    return this.html;
  }

  set title(value) {
    this.attrs.title = value;
  }

  set href(value) {
    this.attrs.href = value;
  }
}

/* 文本聚合（含文本节点）：整行文案断言用。class token 命中：'chip-badge chip-3' 命中 'chip-badge'。 */
function textOf(node) {
  let out = typeof node.textContent === 'string' ? node.textContent : '';
  for (const child of node.children) {
    out += typeof child.text === 'string' ? child.text : textOf(child);
  }
  return out;
}

function findAll(node, token, found = []) {
  for (const child of node.children) {
    if (typeof child.text === 'string') {
      continue;
    }
    if (String(child.className).split(' ').includes(token)) {
      found.push(child);
    }
    findAll(child, token, found);
  }
  return found;
}

function textLines(node, token) {
  return findAll(node, token).map((child) => textOf(child));
}

function fireOn(node, type) {
  for (const handler of node.listeners[type] || []) {
    handler();
  }
}

/* 桩的 window：事件监听登记表、localStorage 用 Map 承载、setInterval 只存回调
 * （测试用 env.timer 手动驱动节拍，不真起定时器）。 */
function createStubWindow(env, storage, listeners) {
  return {
    location: { hash: '' },
    addEventListener: (type, handler) => { listeners.push({ type, handler }); },
    setInterval: (fn) => { env.timer = fn; },
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => { storage.set(key, value); },
    },
  };
}

function createStubDocument(byId) {
  return {
    documentElement: { style: {} },
    getElementById: (id) => byId[id],
    createElement: (tag) => new StubNode(tag),
    createTextNode: (text) => ({ text }),
  };
}

/* fetch 编排队列：每条 entry = { match, body, status? }（按 URL 子串匹配并消耗），
 * 或 { match, gate }——gate 为测试自持的 Promise，用于制造悬着的「在途响应」。 */
function createFetchStub(env) {
  return (url) => {
    env.requests.push(url);
    const entry = env.scripted.shift();
    assert.ok(entry !== undefined, '未编排的请求：' + url);
    assert.ok(url.includes(entry.match), '请求与编排不匹配：' + url);
    if (entry.gate !== undefined) {
      return entry.gate;
    }
    return Promise.resolve({
      ok: entry.status === undefined || entry.status === 200,
      status: entry.status === undefined ? 200 : entry.status,
      json: () => Promise.resolve(entry.body),
    });
  };
}

function fireWindowEvent(listeners, type) {
  for (const listener of listeners) {
    if (listener.type === type) {
      listener.handler();
    }
  }
}

function createEnv() {
  const byId = {};
  for (const id of MOUNT_IDS) {
    byId[id] = new StubNode('div');
  }
  const listeners = [];
  const storage = new Map();
  const env = { byId, storage, requests: [], scripted: [] };
  env.window = createStubWindow(env, storage, listeners);
  env.document = createStubDocument(byId);
  env.fireWindow = (type) => fireWindowEvent(listeners, type);
  env.plan = (...entries) => { env.scripted.push(...entries); };
  env.flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  env.fetch = createFetchStub(env);
  env.start = () => {
    const run = new Function('document', 'window', 'fetch', APP_JS);
    run(env.document, env.window, env.fetch);
  };
  return env;
}

function feedRow(id, extra = {}) {
  return { id, ts: TS_MORNING, fromName: '甲', direction: 'in', kind: 'progress', html: '<p>' + id + '</p>', ...extra };
}

function metaBody(extra = {}) {
  return {
    name: '演示', state: 'active', mode: 'managed', memberCount: 2, count: 7, topic: '议题',
    events: { rows: [], reset: false }, skipped: 0, ...extra,
  };
}

/* 起点一：列表视图（boot 时 hash 为空）。 */
async function bootList(env, collabs) {
  env.plan({ match: '/api/collabs', body: { collabs } });
  env.start();
  await env.flush();
}

/* 起点二：详情视图（boot 前先落 hash，首屏 feed＋meta 两拍一次结算）。 */
async function bootDetail(env, feed, meta) {
  env.window.location.hash = '#/c/main/demo';
  env.plan({ match: '/feed', body: feed }, { match: '/meta', body: meta });
  env.start();
  await env.flush();
}

function streamRows(env) {
  return findAll(env.byId['stream'], 'feed-row');
}

test('列表视图：行渲染、站点#k 标记、未就绪占位与 href 路由', async () => {
  const env = createEnv();
  await bootList(env, [
    { root: 'main', id: 'demo', name: '演示', mode: 'forum', state: 'active', memberCount: 2, count: 5, updatedAt: 1760000000000 },
    { root: 's3', id: 'cleanup', name: null, mode: 'managed', state: null, memberCount: 4, count: null, updatedAt: 1760000001000 },
  ]);
  const rows = findAll(env.byId['list-view'], 'collab-row');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].attrs.href, '#/c/main/demo');
  const first = textOf(rows[0]);
  assert.ok(first.includes('演示') && first.includes('讨论') && first.includes('进行中') && first.includes('5 帖'), first);
  const second = textOf(rows[1]);
  assert.ok(second.includes('站点#3') && second.includes('（数据未就绪）'), second);
  assert.ok(!second.includes('累计收到'), '未就绪的计数不得造数：' + second);
});

test('列表视图：空态文案', async () => {
  const env = createEnv();
  await bootList(env, []);
  assert.equal(textOf(env.byId['list-view']), '本机暂无协作或讨论');
});

test('列表视图：muted 行加 🔇 标记，非静音行无标记', async () => {
  const env = createEnv();
  await bootList(env, [
    { root: 'main', id: 'demo', name: '演示', mode: 'managed', state: 'active', memberCount: 2, count: 5, updatedAt: 1760000000000, muted: true },
    { root: 'main', id: 'calm', name: '平静', mode: 'managed', state: 'active', memberCount: 1, count: 1, updatedAt: 1760000001000, muted: false },
  ]);
  const rows = findAll(env.byId['list-view'], 'collab-row');
  assert.equal(findAll(rows[0], 'collab-muted').length, 1, '静音行应有 🔇 标记');
  assert.ok(textOf(rows[0]).includes('🔇'), textOf(rows[0]));
  assert.equal(findAll(rows[1], 'collab-muted').length, 0, '非静音行不得出现标记');
  assert.ok(!textOf(rows[1]).includes('🔇'), textOf(rows[1]));
});

test('详情首屏：并发发起、横幅、跨日分隔、注入面分界', async () => {
  const env = createEnv();
  await bootDetail(env, {
    rows: [
      feedRow('a1', { ts: TS_MORNING }),
      feedRow('a2', { ts: TS_NEXT_DAY, fromName: '乙<script>', html: '<p>&lt;b&gt;</p>' }),
    ],
    reset: true,
    skipped: 0,
  }, metaBody({ events: { rows: [{ id: '1:0', ts: TS_MORNING, text: '状态：proposed → active' }], reset: true } }));
  assert.equal(env.requests.length, 2, '首屏应并发发起 feed 与 meta');
  const banner = textOf(env.byId['banner']);
  assert.ok(banner.includes('【演示】进行中') && banner.includes('协作') && banner.includes('2 人'), banner);
  assert.ok(banner.includes('累计收到 7 条') && banner.includes('议题'), banner);
  assert.equal(streamRows(env).length, 2);
  assert.equal(findAll(env.byId['stream'], 'day-row').length, 2, '两日各一日期分隔行');
  const bodies = findAll(env.byId['stream'], 'msg-body');
  assert.equal(bodies[0].innerHTML, '<p>a1</p>');
  assert.equal(bodies[1].innerHTML, '<p>&lt;b&gt;</p>', 'innerHTML 只承接服务端 html 字段');
  assert.ok(textOf(streamRows(env)[1]).includes('乙<script>'), '作者名按文本注入（textContent）');
  assert.equal(findAll(env.byId['event-track'], 'event-row').length, 1);
  assert.equal(findAll(env.byId['stream'], 'feed-time')[0].attrs.title, TS_MORNING, '悬停 title 为原始 ISO');
});

test('横幅：muted=true 显示静音提醒（含 /ws-mute 要素），翻回 false 即移除', async () => {
  const env = createEnv();
  await bootDetail(env, { rows: [], reset: true, skipped: 0 }, metaBody({ muted: true }));
  const banner = textOf(env.byId['banner']);
  assert.ok(banner.includes('🔇 本协作已静音'), banner);
  assert.ok(banner.includes('消息不注入 AI 会话') && banner.includes('/ws-mute'), banner);
  env.plan(
    { match: '/feed', body: { rows: [], reset: false, skipped: 0 } },
    { match: '/meta', body: metaBody({ muted: false }) },
  );
  env.timer();
  await env.flush();
  const after = textOf(env.byId['banner']);
  assert.ok(!after.includes('🔇'), '取消静音后横幅必须移除：' + after);
  assert.ok(after.includes('【演示】进行中'), '常规横幅行不受影响：' + after);
});

test('窗口标题：详情 meta 就位后带协作名；meta 未返回与列表路由保持默认', async () => {
  const env = createEnv();
  await bootList(env, []);
  assert.equal(env.document.title, 'waystation 观察窗', '列表路由为默认标题');
  env.plan({ match: '/feed', body: { rows: [], reset: true, skipped: 0 } }, { match: '/meta', body: metaBody() });
  env.window.location.hash = '#/c/main/demo';
  env.fireWindow('hashchange');
  assert.equal(env.document.title, 'waystation 观察窗', 'meta 返回前保持默认标题');
  await env.flush();
  assert.equal(env.document.title, 'waystation 观察窗 · 演示');
  env.plan({ match: '/api/collabs', body: { collabs: [] } });
  env.window.location.hash = '#/';
  env.fireWindow('hashchange');
  await env.flush();
  assert.equal(env.document.title, 'waystation 观察窗', '回列表恢复默认标题');
});

test('窗口标题：名称未就绪（name=null）保持默认标题', async () => {
  const env = createEnv();
  await bootDetail(env, { rows: [], reset: true, skipped: 0 }, metaBody({ name: null, state: null }));
  assert.equal(env.document.title, 'waystation 观察窗');
});

test('协作行：方向标与（N 人）标记，count 缺省不显示', async () => {
  const env = createEnv();
  await bootDetail(env, {
    rows: [feedRow('a1', { direction: 'out', count: 3 }), feedRow('a2', { direction: 'in' })],
    reset: true,
    skipped: 0,
  }, metaBody());
  const heads = findAll(env.byId['stream'], 'feed-head');
  assert.equal(findAll(heads[0], 'feed-direction')[0].textContent, '→');
  assert.equal(findAll(heads[1], 'feed-direction')[0].textContent, '←');
  assert.ok(textOf(heads[0]).includes('（3 人）'), textOf(heads[0]));
  assert.ok(!textOf(heads[1]).includes('人）'), 'count 缺省不显示人数标记');
});

test('增量轮询：两拍请求各带上次末行/末事件 id 的锚点，只追加不清屏', async () => {
  const env = createEnv();
  await bootDetail(env, { rows: [feedRow('a1')], reset: true, skipped: 0 },
    metaBody({ events: { rows: [{ id: '7:0', ts: TS_MORNING, text: '状态：proposed → active' }], reset: true } }));
  env.plan(
    { match: 'after=a1', body: { rows: [feedRow('a2', { ts: TS_NEXT_DAY })], reset: false, skipped: 0 } },
    { match: 'after=7:0', body: metaBody({ events: { rows: [], reset: false } }) },
  );
  env.timer();
  await env.flush();
  assert.equal(env.requests[2], '/api/collab/main/demo/feed?after=a1');
  assert.equal(env.requests[3], '/api/collab/main/demo/meta?after=7:0');
  assert.equal(streamRows(env).length, 2, '增量只追加');
});

test('reset：清屏全量重渲、旧行不叠加、日期分隔随重渲重建', async () => {
  const env = createEnv();
  await bootDetail(env, { rows: [feedRow('a1'), feedRow('a2')], reset: true, skipped: 0 }, metaBody());
  env.plan(
    { match: 'after=a2', body: { rows: [feedRow('b1')], reset: true, skipped: 0 } },
    { match: '/meta', body: metaBody() },
  );
  env.timer();
  await env.flush();
  assert.equal(streamRows(env).length, 1, 'reset 后只留全量行，不叠加');
  assert.equal(findAll(env.byId['stream'], 'day-row').length, 1);
});

test('滚动：上滚不抢滚出浮标、点击回底恢复跟随', async () => {
  const env = createEnv();
  await bootDetail(env, { rows: [feedRow('a1')], reset: true, skipped: 0 }, metaBody());
  const stream = env.byId['stream'];
  stream.scrollHeight = 1000;
  stream.clientHeight = 400;
  stream.scrollTop = 0;
  fireOn(stream, 'scroll');
  env.plan(
    { match: '/feed', body: { rows: [feedRow('a2')], reset: false, skipped: 0 } },
    { match: '/meta', body: metaBody() },
  );
  env.timer();
  await env.flush();
  assert.equal(env.byId['new-badge'].hidden, false, '上滚后新行应出浮标');
  assert.equal(env.byId['new-badge'].textContent, '1 条新消息 ↓');
  assert.equal(stream.scrollTop, 0, '上滚态不得抢滚');
  fireOn(env.byId['new-badge'], 'click');
  assert.equal(env.byId['new-badge'].hidden, true);
  assert.equal(stream.scrollTop, stream.scrollHeight, '点击浮标回底');
});

test('暂停：冻结轮询；在途响应丢弃且不推进锚点；恢复立即补拉', async () => {
  const env = createEnv();
  await bootDetail(env, { rows: [feedRow('a1')], reset: true, skipped: 0 }, metaBody());
  let settle = () => {};
  const inFlight = new Promise((resolve) => {
    settle = () => resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ rows: [feedRow('a2')], reset: false, skipped: 0 }),
    });
  });
  env.plan({ match: '/feed', gate: inFlight }, { match: '/meta', body: metaBody() });
  env.timer();                                  // 两拍发出：feed 挂在闸门上
  fireOn(env.byId['pause'], 'click');           // 结算之前暂停
  settle();
  await env.flush();
  assert.equal(streamRows(env).length, 1, '暂停期间结算的响应应丢弃');
  const settled = env.requests.length;
  env.timer();
  await env.flush();
  assert.equal(env.requests.length, settled, '暂停应冻结轮询');
  env.plan(
    { match: 'after=a1', body: { rows: [feedRow('a2')], reset: false, skipped: 0 } },
    { match: '/meta', body: metaBody() },
  );
  fireOn(env.byId['pause'], 'click');           // 恢复：立即补拉
  await env.flush();
  assert.equal(env.requests[settled], '/api/collab/main/demo/feed?after=a1', '锚点仍是暂停前末行 id');
  assert.equal(streamRows(env).length, 2, '恢复补拉把丢弃的那行补上');
});

test('字号：三键改根字号并持久化，超限钳制', async () => {
  const env = createEnv();
  await bootList(env, []);
  fireOn(env.byId['font-up'], 'click');
  assert.equal(env.document.documentElement.style.fontSize, '20px');
  assert.equal(env.storage.get('ws-viewer:fontScale'), '20');
  for (let index = 0; index < 5; index++) {
    fireOn(env.byId['font-up'], 'click');
  }
  assert.equal(env.document.documentElement.style.fontSize, '28px', '上限钳制');
  for (let index = 0; index < 8; index++) {
    fireOn(env.byId['font-down'], 'click');
  }
  assert.equal(env.document.documentElement.style.fontSize, '12px', '下限钳制');
  fireOn(env.byId['font-reset'], 'click');
  assert.equal(env.document.documentElement.style.fontSize, '16px');
});

test('字号：刷新后从 localStorage 恢复', async () => {
  const env = createEnv();
  env.storage.set('ws-viewer:fontScale', '20');
  await bootList(env, []);
  assert.equal(env.document.documentElement.style.fontSize, '20px');
});

test('轮询 404：停轮询并提示，提示不被另一面成功响应抹掉', async () => {
  const env = createEnv();
  await bootDetail(env, { rows: [], reset: true, skipped: 0 }, metaBody());
  env.plan({ match: '/feed', status: 404, body: {} }, { match: '/meta', body: metaBody() });
  env.timer();
  await env.flush();
  assert.equal(env.byId['app-status'].textContent, '未找到该协作，可能已被清理');
  const settled = env.requests.length;
  env.timer();
  await env.flush();
  assert.equal(env.requests.length, settled, '404 后停止轮询');
});

test('路由：非法 hash 归一到列表', async () => {
  const env = createEnv();
  await bootList(env, []);
  env.window.location.hash = '#/c/../x/y';
  env.fireWindow('hashchange');
  assert.equal(env.window.location.hash, '#/');
  assert.equal(env.byId['detail-view'].hidden, true);
});

test('坏行计数：元状态面与会话流面各一行、水位独立、有增才显示', async () => {
  const env = createEnv();
  await bootDetail(env, { rows: [feedRow('a1')], reset: true, skipped: 2 }, metaBody({ skipped: 1 }));
  assert.deepEqual(textLines(env.byId['event-track'], 'event-skipped'), [
    '跳过 1 条无法解析的记录',
    '会话流跳过 2 条无法解析的记录',
  ]);
  env.plan(
    { match: '/feed', body: { rows: [], reset: false, skipped: 2 } },
    { match: '/meta', body: metaBody({ skipped: 1 }) },
  );
  env.timer();
  await env.flush();
  assert.equal(findAll(env.byId['event-track'], 'event-skipped').length, 2, '计数未增不重复提示');
  env.plan(
    { match: '/feed', body: { rows: [], reset: false, skipped: 3 } },
    { match: '/meta', body: metaBody({ skipped: 4 }) },
  );
  env.timer();
  await env.flush();
  const lines = textLines(env.byId['event-track'], 'event-skipped');
  assert.equal(lines.length, 4, '两面增量各补一行：' + lines.join(' | '));
  assert.ok(lines.includes('跳过 4 条无法解析的记录') && lines.includes('会话流跳过 3 条无法解析的记录'), lines.join(' | '));
});

test('坏行计数：讨论侧不出现会话流计数行（帖行坏行并入 meta 行）', async () => {
  const env = createEnv();
  await bootDetail(env, { rows: [feedRow('a1')], reset: true, skipped: 2 },
    metaBody({ mode: 'forum', name: '讨论一号', count: 3, skipped: 3 }));
  assert.deepEqual(textLines(env.byId['event-track'], 'event-skipped'), ['跳过 3 条无法解析的记录']);
});

test('reset：清屏后坏行计数行可随重渲重现（水位归零）', async () => {
  const env = createEnv();
  await bootDetail(env, { rows: [feedRow('a1')], reset: true, skipped: 2 },
    metaBody({ skipped: 1, events: { rows: [{ id: '1:0', ts: TS_MORNING, text: '状态：proposed → active' }], reset: true } }));
  assert.equal(findAll(env.byId['event-track'], 'event-skipped').length, 2);
  env.plan(
    { match: '/feed', body: { rows: [feedRow('a1')], reset: true, skipped: 2 } },
    { match: '/meta', body: metaBody({ skipped: 1, events: { rows: [{ id: '2:0', ts: TS_MORNING, text: '状态：active → frozen' }], reset: true } }) },
  );
  env.timer();
  await env.flush();
  assert.equal(findAll(env.byId['event-track'], 'event-row').length, 1, '事件轨 reset 后只留全量事件');
  assert.equal(findAll(env.byId['event-track'], 'event-skipped').length, 2, '计数行随 reset 重现');
});

test('渲染安全：innerHTML 只接服务端 html 字段，其余字段按文本注入', async () => {
  const env = createEnv();
  const hostileName = '<img src=x onerror=1>';
  await bootDetail(env, {
    rows: [feedRow('a1', { fromName: hostileName, kind: '<b>粗</b>', html: '<p>安全</p>' })],
    reset: true,
    skipped: 0,
  }, metaBody());
  const bodies = findAll(env.byId['stream'], 'msg-body');
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].innerHTML, '<p>安全</p>');
  const head = findAll(env.byId['stream'], 'feed-head')[0];
  assert.ok(textOf(head).includes(hostileName), '作者名按文本呈现');
  assert.ok(textOf(head).includes('<b>粗</b>'), 'kind 按文本呈现');
});

test('路由切换：旧在途不迟滞新视图、不污染呈现、不误清忙标记', async () => {
  const env = createEnv();
  await bootDetail(env, { rows: [feedRow('a1')], reset: true, skipped: 0 }, metaBody());
  let settleOld = () => {};
  const oldGate = new Promise((resolve) => {
    settleOld = () => resolve({ ok: true, status: 200, json: () => Promise.resolve({ rows: [feedRow('a2')], reset: false, skipped: 0 }) });
  });
  env.plan({ match: '/feed', gate: oldGate }, { match: '/meta', gate: oldGate });   // A 两路在途
  env.timer();
  let settleFeed = () => {};
  let settleMeta = () => {};
  const newFeed = new Promise((resolve) => {
    settleFeed = () => resolve({ ok: true, status: 200, json: () => Promise.resolve({ rows: [feedRow('b1')], reset: true, skipped: 0 }) });
  });
  const newMeta = new Promise((resolve) => {
    settleMeta = () => resolve({ ok: true, status: 200, json: () => Promise.resolve(metaBody({ name: '乙协作' })) });
  });
  env.plan({ match: 'beta/feed', gate: newFeed }, { match: 'beta/meta', gate: newMeta });
  env.window.location.hash = '#/c/main/beta';
  env.fireWindow('hashchange');
  assert.equal(env.requests.length, 6, '切到 B 立即发起两路，不被 A 的忙标记迟滞');
  settleOld();
  await env.flush();
  assert.equal(streamRows(env).length, 0, '旧 A 响应不得落进 B（代次作废）');
  const dispatched = env.requests.length;
  env.timer();
  await env.flush();
  assert.equal(env.requests.length, dispatched, 'B 在途时不得重复并发（旧 finally 未误清忙标记）');
  settleFeed();
  settleMeta();
  await env.flush();
  assert.equal(streamRows(env).length, 1, 'B 首屏数据落屏');
  assert.ok(textOf(env.byId['banner']).includes('【乙协作】'), textOf(env.byId['banner']));
});
