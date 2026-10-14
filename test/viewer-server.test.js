import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { join } from 'node:path';
import { makeTempDir } from './helpers.js';
import { createViewerData } from '../src/viewer/data.js';
import { INDEX_HTML, APP_JS, STYLE_CSS } from '../src/viewer/assets.js';
import { rootDigest, startViewerServer } from '../src/viewer/server.js';
import { renderMarkdown } from '../src/viewer/markdown.js';
import { COLLABS_DIR_NAME, CONFIG_FILE_NAME, SITES_DIR_NAME } from '../src/paths.js';
import { POSTS_FILE_NAME } from '../src/collab/posts.js';
import { MEMBERS_FILE_NAME } from '../src/collab/members.js';
import { LEDGER_FILE_NAME, MEMBER_FILE_NAME } from '../src/collab/store.js';
import { COUNTER_FILE_NAME } from '../src/collab/counter.js';
import { INBOX_FILE_NAME } from '../src/net/inbound.js';
import { OUTBOX_FILE_NAME } from '../src/net/outbox.js';

/* 观察窗 HTTP 服务的判别用例：真实监听（port: 0 由内核分配——天然不碰 7330–7339 默认段与
 * 站点槽位段 7321–7328）＋临时数据根夹具——绝不触碰真实 ~/.waystation。
 * Host 族用例走 node:http 客户端自设 headers（fetch/undici 改不了 Host）；
 * 编码路径段用例同样走 node:http（fetch 的 URL 解析会先做规范化，发不出原始字节）。
 * 时间戳全部定格，不依赖真实时钟。 */

/* —— 夹具 —— */

const T0 = '2026-10-14T10:00:00.000Z';

function tsPlus(offsetMs) {
  return new Date(Date.parse(T0) + offsetMs).toISOString();
}

function collabDirIn(dataDir, root, collabId) {
  const base = root === 'main' ? dataDir : join(dataDir, SITES_DIR_NAME, root.slice(1));
  return join(base, COLLABS_DIR_NAME, collabId);
}

function writeFiles(dir, files) {
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
}

function writeConfigAt(baseDir, identityName) {
  writeFileSync(join(baseDir, CONFIG_FILE_NAME), `${JSON.stringify({ identityName })}\n`);
}

function jsonl(...values) {
  return values.map((value) => `${JSON.stringify(value)}\n`).join('');
}

function memberRecord(over = {}) {
  return {
    collabId: 'c-1',
    name: '甲机',
    role: 'manager',
    state: 'active',
    manager: { instanceId: 'mgr-1', identityName: '甲机' },
    endpoints: {},
    roster: [{ instanceId: 'mgr-1', identityName: '甲机' }],
    ...over,
  };
}

function postEntry(over = {}) {
  return {
    entryId: 'post-1',
    seq: 1,
    ts: T0,
    from: { instanceId: 'inst-a', identityName: '甲机' },
    kind: 'task',
    text: '正文甲',
    ...over,
  };
}

function memberEvent(over = {}) {
  return { eventId: 'ev-1', kind: 'join', instanceId: 'inst-a', identityName: '甲机', ts: T0, ...over };
}

function ledgerOf(over = {}) {
  return {
    version: 1,
    collabId: 'c-1',
    name: '协作甲',
    topic: '主题甲',
    status: 'active',
    manager: { instanceId: 'mgr-1', identityName: '甲机' },
    members: [
      { instanceId: 'mgr-1', identityName: '甲机', role: 'manager', state: 'member', joinedAt: T0 },
      { instanceId: 'inst-b', identityName: '乙机', role: 'member', state: 'member', joinedAt: T0 },
    ],
    board: [],
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

function inboxRow(over = {}) {
  return {
    v: 1,
    type: 'reply',
    msgId: 'msg-in-1',
    from: { instanceId: 'inst-b', identityName: '乙机', port: 7000 },
    collabId: 'c-1',
    ts: T0,
    payload: { text: '收到' },
    receivedAt: T0,
    ...over,
  };
}

function outboxRow(over = {}) {
  return {
    msgId: 'msg-out-1',
    collabId: 'c-1',
    to: { instanceId: 'inst-b', address: '127.0.0.1', port: 7000 },
    type: 'reply',
    payload: { text: '发出' },
    governance: false,
    state: 'queued',
    attempts: 0,
    createdAt: T0,
    nextAttemptAt: 0,
    ...over,
  };
}

/* 讨论夹具：三条合法帖（含 Markdown 标记与 HTML 注入尝试）＋一条坏行（skipped 透传用）＋
 * 一条成员事件＋参与记录（mode=forum，含主题）。 */
function writeForumFixture(dataDir, collabId = 'c-forum') {
  writeFiles(collabDirIn(dataDir, 'main', collabId), {
    [POSTS_FILE_NAME]: jsonl(
      postEntry({ entryId: 'post-1', text: '普通一条' }),
      postEntry({ entryId: 'post-2', seq: 2, ts: tsPlus(1000), kind: 'reply', text: '正文含 **粗体** 与 `代码`' }),
      postEntry({ entryId: 'post-3', seq: 3, ts: tsPlus(2000), kind: 'issue', text: '<script>alert(1)</script>' }),
    ) + '{坏行\n',
    [MEMBERS_FILE_NAME]: jsonl(memberEvent()),
    [MEMBER_FILE_NAME]: JSON.stringify(memberRecord({ mode: 'forum', collabId, topic: '讨论主题' })),
  });
}

/* 协作夹具：管理席位（台账两行＝一条迁移）＋扇出合并对（错峰 ≤50ms 链式）＋收到一条＋
 * counter 累计收到＋根 config 本机身份名。 */
function writeManagedFixture(dataDir, collabId = 'c-managed') {
  writeFiles(collabDirIn(dataDir, 'main', collabId), {
    [MEMBER_FILE_NAME]: JSON.stringify(memberRecord({ mode: 'managed', collabId })),
    [LEDGER_FILE_NAME]: jsonl(
      ledgerOf({ collabId }),
      ledgerOf({ collabId, status: 'frozen', updatedAt: tsPlus(1000) }),
    ),
    [COUNTER_FILE_NAME]: JSON.stringify({ v: 1, messageCount: 7 }),
    [INBOX_FILE_NAME]: jsonl(inboxRow({ ts: T0 })),
    [OUTBOX_FILE_NAME]: jsonl(
      outboxRow({ msgId: 'f-1', createdAt: tsPlus(500), payload: { text: '**同文**扇出' } }),
      outboxRow({ msgId: 'f-2', createdAt: tsPlus(507), payload: { text: '**同文**扇出' } }),
    ),
  });
  writeConfigAt(dataDir, '甲机');
}

/* —— 服务与 HTTP 客户端 —— */

const LOCAL_ASSETS = { INDEX_HTML, APP_JS, STYLE_CSS };

/* 起一个真实监听的观察窗（port: 0 由内核分配）；用例收尾统一 close。 */
async function startTestViewer(t, { dataDir, log = null, data = null }) {
  const viewer = await startViewerServer({
    dataDir,
    log,
    port: 0,
    data: data ?? createViewerData({ dataDir, log }),
    assets: LOCAL_ASSETS,
  });
  t.after(() => viewer.close());
  return { port: viewer.port, origin: `http://127.0.0.1:${viewer.port}` };
}

/* fetch 取回「状态＋头＋文本体」三元组（JSON 响应由用例自行 parse）。 */
async function fetchText(origin, path, options) {
  const response = await fetch(origin + path, options);
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    cacheControl: response.headers.get('cache-control'),
    body: await response.text(),
  };
}

/* Host 族与编码路径用例：node:http 客户端自设 headers/原始路径（fetch 做不到）。
 * hostHeader 传 null 时以 setHost: false 构造「缺失 Host」的请求。 */
function requestWithHost(port, hostHeader, path = '/api/health', method = 'GET') {
  const options = { host: '127.0.0.1', port, path, method };
  if (hostHeader === null) {
    options.setHost = false;
  } else {
    options.headers = { Host: hostHeader };
  }
  return new Promise((resolveRequest, rejectRequest) => {
    const req = httpRequest(options, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolveRequest({ status: res.statusCode, body }));
    });
    req.on('error', rejectRequest);
    req.end();
  });
}

/* —— 资产、health、列表 —— */

test('资产与头：三份资产直出且 Content-Type 正确，全部响应带 no-store', async (t) => {
  const dataDir = makeTempDir(t);
  const viewer = await startTestViewer(t, { dataDir });
  const cases = [
    ['/', 'text/html; charset=utf-8', INDEX_HTML],
    ['/app.js', 'text/javascript; charset=utf-8', APP_JS],
    ['/style.css', 'text/css; charset=utf-8', STYLE_CSS],
  ];
  for (const [path, contentType, expected] of cases) {
    const res = await fetchText(viewer.origin, path);
    assert.equal(res.status, 200, path);
    assert.equal(res.contentType, contentType, path);
    assert.equal(res.cacheControl, 'no-store', path);
    assert.equal(res.body, expected, path);
  }
  for (const probe of ['/api/health', '/api/nope']) {
    assert.equal((await fetchText(viewer.origin, probe)).cacheControl, 'no-store', probe);
  }
  const notAllowed = await fetchText(viewer.origin, '/api/collabs', { method: 'POST' });
  assert.equal(notAllowed.cacheControl, 'no-store');
});

test('health：形态与根摘要（8 hex、同目录两次一致、不同目录不同）', async (t) => {
  const dataDir = makeTempDir(t);
  const otherDir = makeTempDir(t);
  const viewer = await startTestViewer(t, { dataDir });
  const health = await fetchText(viewer.origin, '/api/health');
  assert.equal(health.contentType, 'application/json; charset=utf-8');
  const first = JSON.parse(health.body);
  assert.deepEqual(first, { app: 'waystation-viewer', v: 1, pid: process.pid, root: rootDigest(dataDir) });
  assert.match(first.root, /^[0-9a-f]{8}$/);
  const again = JSON.parse((await fetchText(viewer.origin, '/api/health')).body);
  assert.equal(again.root, first.root);
  const other = await startTestViewer(t, { dataDir: otherDir });
  const elsewhere = JSON.parse((await fetchText(other.origin, '/api/health')).body);
  assert.notEqual(elsewhere.root, first.root);
});

test('collabs：列表原样透传（含 root 标记与 mode 判定）', async (t) => {
  const dataDir = makeTempDir(t);
  writeForumFixture(dataDir);
  writeManagedFixture(dataDir);
  const data = createViewerData({ dataDir });
  const viewer = await startTestViewer(t, { dataDir, data });
  const body = JSON.parse((await fetchText(viewer.origin, '/api/collabs')).body);
  assert.deepEqual(body, data.listCollabs());
  assert.equal(body.collabs.length, 2);
  assert.equal(body.collabs.find((entry) => entry.id === 'c-forum').mode, 'forum');
  assert.equal(body.collabs.find((entry) => entry.id === 'c-managed').mode, 'managed');
  assert.ok(body.collabs.every((entry) => entry.root === 'main'));
});

/* —— feed —— */

test('feed（讨论）：正文渲染为 html、text 被替换、坏行 skipped 透传', async (t) => {
  const dataDir = makeTempDir(t);
  writeForumFixture(dataDir);
  const viewer = await startTestViewer(t, { dataDir });
  const feed = JSON.parse((await fetchText(viewer.origin, '/api/collab/main/c-forum/feed')).body);
  assert.equal(feed.reset, true);
  assert.equal(feed.skipped, 1);
  assert.deepEqual(feed.rows.map((row) => row.id), ['post-1@inst-a', 'post-2@inst-a', 'post-3@inst-a']);
  assert.deepEqual(feed.rows[0], {
    id: 'post-1@inst-a', ts: T0, fromName: '甲机', kind: 'task', html: renderMarkdown('普通一条'),
  });
  const rich = feed.rows[1];
  assert.equal(rich.ts, tsPlus(1000));
  assert.equal(rich.kind, 'reply');
  assert.equal('text' in rich, false);
  assert.ok(rich.html.includes('<strong>粗体</strong>'));
  assert.ok(rich.html.includes('<code>代码</code>'));
  const injected = feed.rows[2].html;
  assert.ok(!injected.includes('<script>'));
  assert.ok(injected.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
});

test('feed（讨论）：锚点透传——中段增量、末段空增量、找不到即 reset 全量', async (t) => {
  const dataDir = makeTempDir(t);
  writeForumFixture(dataDir);
  const viewer = await startTestViewer(t, { dataDir });
  const middle = JSON.parse((await fetchText(viewer.origin, '/api/collab/main/c-forum/feed?after=post-2@inst-a')).body);
  assert.equal(middle.reset, false);
  assert.deepEqual(middle.rows.map((row) => row.id), ['post-3@inst-a']);
  const tail = JSON.parse((await fetchText(viewer.origin, '/api/collab/main/c-forum/feed?after=post-3@inst-a')).body);
  assert.deepEqual(tail.rows, []);
  assert.equal(tail.reset, false);
  const missing = JSON.parse((await fetchText(viewer.origin, '/api/collab/main/c-forum/feed?after=nope')).body);
  assert.equal(missing.reset, true);
  assert.equal(missing.rows.length, 3);
});

test('feed（协作）：direction 与 count 透传，正文在服务端渲染', async (t) => {
  const dataDir = makeTempDir(t);
  writeManagedFixture(dataDir);
  const viewer = await startTestViewer(t, { dataDir });
  const feed = JSON.parse((await fetchText(viewer.origin, '/api/collab/main/c-managed/feed')).body);
  assert.equal(feed.reset, true);
  assert.equal(feed.skipped, 0);
  assert.deepEqual(feed.rows[0], {
    id: 'msg-in-1', ts: T0, fromName: '乙机', direction: 'in', kind: 'reply', html: renderMarkdown('收到'),
  });
  const merged = feed.rows[1];
  assert.equal(merged.id, 'f-1');
  assert.equal(merged.ts, tsPlus(500));
  assert.equal(merged.fromName, '甲机');
  assert.equal(merged.direction, 'out');
  assert.equal(merged.count, 2);
  assert.equal('text' in merged, false);
  assert.ok(merged.html.includes('<strong>同文</strong>'));
});

/* —— meta —— */

test('meta（讨论）：字段与事件轨纯文本原样透传、skipped 计数', async (t) => {
  const dataDir = makeTempDir(t);
  writeForumFixture(dataDir);
  const viewer = await startTestViewer(t, { dataDir });
  const meta = JSON.parse((await fetchText(viewer.origin, '/api/collab/main/c-forum/meta')).body);
  assert.deepEqual(meta, {
    name: '甲机',
    state: 'active',
    mode: 'forum',
    memberCount: 1,
    count: 3,
    topic: '讨论主题',
    events: { rows: [{ id: 'ev-1', ts: T0, text: '甲机 加入（现 1 人）' }], reset: true },
    skipped: 1,
  });
  const anchored = JSON.parse((await fetchText(viewer.origin, '/api/collab/main/c-forum/meta?after=ev-1')).body);
  assert.deepEqual(anchored.events.rows, []);
  assert.equal(anchored.events.reset, false);
});

test('meta（协作）：台账口径、迁移行与累计收到计数原样透传', async (t) => {
  const dataDir = makeTempDir(t);
  writeManagedFixture(dataDir);
  const viewer = await startTestViewer(t, { dataDir });
  const meta = JSON.parse((await fetchText(viewer.origin, '/api/collab/main/c-managed/meta')).body);
  assert.deepEqual(meta, {
    name: '协作甲',
    state: 'frozen',
    mode: 'managed',
    memberCount: 2,
    count: 7,
    topic: '主题甲',
    events: { rows: [{ id: '1:0', ts: tsPlus(1000), text: '状态：active → frozen' }], reset: true },
    skipped: 0,
  });
});

/* —— 路由边界 —— */

const NOT_FOUND_PATHS = [
  '/api/nope',
  '/index.html',
  '/api/collab/main/c-forum',
  '/api/collab/main/c-forum/feed/extra',
  '/api/collab/main/id_under_score/feed',
  '/api/collab/MAIN/c-forum/feed',
  '/api/collab/x/c-forum/feed',
  '/api/collab/s99/c-forum/feed',
];

/* 编码段：必须以原始字节送达服务端（fetch 的 URL 解析会先规范化）——走 node:http 的 path。 */
const ENCODED_PATHS = [
  '/api/collab/main/%2e%2e/feed',
  '/api/collab/%6dain/c-forum/feed',
  '/api/collab/main/c%2Dforum/feed',
];

test('404 族：未知路径、非法 root/id、目录缺失、编码段、大小写敏感', async (t) => {
  const dataDir = makeTempDir(t);
  writeForumFixture(dataDir);
  const viewer = await startTestViewer(t, { dataDir });
  for (const path of NOT_FOUND_PATHS) {
    const res = await fetchText(viewer.origin, path);
    assert.equal(res.status, 404, path);
    assert.deepEqual(JSON.parse(res.body), { error: '未知路径' }, path);
    assert.equal(res.cacheControl, 'no-store', path);
  }
  for (const path of ENCODED_PATHS) {
    const res = await requestWithHost(viewer.port, 'localhost', path);
    assert.equal(res.status, 404, path);
    assert.deepEqual(JSON.parse(res.body), { error: '未知路径' }, path);
  }
  const metaMissing = await fetchText(viewer.origin, '/api/collab/s99/c-forum/meta');
  assert.equal(metaMissing.status, 404);
});

test('未就绪：目录在而数据未落盘 → 200 空数据（与目录缺失的 404 成对）', async (t) => {
  const dataDir = makeTempDir(t);
  mkdirSync(collabDirIn(dataDir, 'main', 'c-empty'), { recursive: true });
  const viewer = await startTestViewer(t, { dataDir });
  const feed = JSON.parse((await fetchText(viewer.origin, '/api/collab/main/c-empty/feed')).body);
  assert.deepEqual(feed, { rows: [], reset: true, skipped: 0 });
  const meta = JSON.parse((await fetchText(viewer.origin, '/api/collab/main/c-empty/meta')).body);
  assert.deepEqual(meta, {
    name: null,
    state: null,
    mode: 'managed',
    memberCount: 0,
    count: null,
    topic: null,
    events: { rows: [], reset: true },
    skipped: 0,
  });
});

test('双根同名 id：main 与 s1 各路由到自己的数据根', async (t) => {
  const dataDir = makeTempDir(t);
  writeForumFixture(dataDir, 'c-1');
  writeFiles(collabDirIn(dataDir, 's1', 'c-1'), {
    [POSTS_FILE_NAME]: jsonl(postEntry({ entryId: 'site-1', text: '站点帖' })),
    [MEMBER_FILE_NAME]: JSON.stringify(memberRecord({ mode: 'forum', collabId: 'c-1' })),
  });
  const viewer = await startTestViewer(t, { dataDir });
  const mainFeed = JSON.parse((await fetchText(viewer.origin, '/api/collab/main/c-1/feed')).body);
  assert.deepEqual(mainFeed.rows.map((row) => row.id), ['post-1@inst-a', 'post-2@inst-a', 'post-3@inst-a']);
  const siteFeed = JSON.parse((await fetchText(viewer.origin, '/api/collab/s1/c-1/feed')).body);
  assert.deepEqual(siteFeed.rows.map((row) => row.id), ['site-1@inst-a']);
  assert.equal(siteFeed.rows[0].html, renderMarkdown('站点帖'));
});

test('405：非 GET 的任何路径；Host 违规先于方法判定', async (t) => {
  const dataDir = makeTempDir(t);
  const viewer = await startTestViewer(t, { dataDir });
  for (const path of ['/api/collabs', '/', '/api/nope']) {
    const res = await fetchText(viewer.origin, path, { method: 'POST' });
    assert.equal(res.status, 405, path);
    assert.deepEqual(JSON.parse(res.body), { error: '仅支持 GET' }, path);
  }
  const conflicted = await requestWithHost(viewer.port, 'evil.com', '/api/collabs', 'POST');
  assert.equal(conflicted.status, 403);
});

const HOST_CASES = [
  ['localhost', 200],
  ['localhost:1234', 200],
  ['127.0.0.1:80', 200],
  ['[::1]:80', 200],
  ['LOCALHOST.', 200],
  ['evil.com', 403],
  ['evil.com:7330', 403],
  [null, 403],
];

test('Host 族：白名单（localhost/IP 字面量）放行，非法或缺失 403（含资产面）', async (t) => {
  const dataDir = makeTempDir(t);
  const viewer = await startTestViewer(t, { dataDir });
  for (const [hostHeader, expected] of HOST_CASES) {
    const res = await requestWithHost(viewer.port, hostHeader);
    assert.equal(res.status, expected, `Host: ${String(hostHeader)}`);
  }
  const denied = await requestWithHost(viewer.port, 'evil.com');
  assert.deepEqual(JSON.parse(denied.body), { error: '非法 Host' });
  const assetDenied = await requestWithHost(viewer.port, 'evil.com', '/');
  assert.equal(assetDenied.status, 403);
  const allowed = await requestWithHost(viewer.port, 'localhost');
  assert.equal(JSON.parse(allowed.body).app, 'waystation-viewer');
});

/* —— 容错、摘要、关停 —— */

test('请求级容错：数据面抛错 → 500＋log.warn 留痕，服务保持可用', async (t) => {
  const dataDir = makeTempDir(t);
  const warns = [];
  const log = { warn: (...args) => warns.push(args) };
  const data = {
    listCollabs: () => ({ collabs: [] }),
    readFeed: () => { throw new Error('数据面故障'); },
    readMeta: () => null,
  };
  const viewer = await startTestViewer(t, { dataDir, log, data });
  const failed = await fetchText(viewer.origin, '/api/collab/main/c-x/feed');
  assert.equal(failed.status, 500);
  assert.deepEqual(JSON.parse(failed.body), { error: '内部错误' });
  assert.equal(warns.length, 1);
  assert.equal(warns[0][1].reason, '数据面故障');
  const ok = await fetchText(viewer.origin, '/api/collabs');
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.body), { collabs: [] });
});

test('rootDigest：8 hex；win32 大小写折叠等价；不同目录不同', (t) => {
  const dirA = makeTempDir(t);
  const dirB = makeTempDir(t);
  const digest = rootDigest(dirA);
  assert.match(digest, /^[0-9a-f]{8}$/);
  assert.equal(rootDigest(dirA), digest);
  assert.notEqual(rootDigest(dirB), digest);
  assert.equal(rootDigest('.'), rootDigest(process.cwd()));
  if (process.platform === 'win32') {
    assert.equal(rootDigest(dirA.toUpperCase()), digest);
    assert.equal(rootDigest(dirA.toLowerCase()), digest);
  }
});

test('close()：停止接收、端口释放（同端口可重绑）', async (t) => {
  const dataDir = makeTempDir(t);
  const viewer = await startViewerServer({
    dataDir,
    port: 0,
    data: createViewerData({ dataDir }),
    assets: LOCAL_ASSETS,
  });
  const origin = `http://127.0.0.1:${viewer.port}`;
  assert.equal((await fetchText(origin, '/api/health')).status, 200);
  await viewer.close();
  await assert.rejects(fetch(`${origin}/api/health`));
  const rebound = createNetServer();
  await new Promise((resolveBind, rejectBind) => {
    rebound.once('error', rejectBind);
    rebound.listen({ host: '127.0.0.1', port: viewer.port }, resolveBind);
  });
  await new Promise((resolveClosed) => rebound.close(resolveClosed));
});

test('监听失败（端口被占）→ Promise reject（组合根的端口协商接口）', async (t) => {
  const dataDir = makeTempDir(t);
  const occupant = createNetServer();
  await new Promise((resolveBind) => occupant.listen({ host: '127.0.0.1', port: 0 }, resolveBind));
  t.after(() => new Promise((resolveClosed) => occupant.close(resolveClosed)));
  const started = startViewerServer({
    dataDir,
    host: '127.0.0.1',
    port: occupant.address().port,
    data: createViewerData({ dataDir }),
    assets: LOCAL_ASSETS,
  });
  await assert.rejects(started, { code: 'EADDRINUSE' });
});
