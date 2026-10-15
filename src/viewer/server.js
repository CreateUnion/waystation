/* 人类观察窗的本地只读 HTTP 服务：把只读数据层（注入的 createViewerData 实例）与页面资产
 * （注入的三字符串对象）装配成四个 JSON 端点与三份资产直出；默认仅绑回环 127.0.0.1。
 *
 * 安全与呈现边界（设计 §8）：
 * - Host 头白名单（仅 localhost 与 IP 字面量）：防 DNS rebinding——服务只绑回环，但恶意网页
 *   仍可让浏览器把「解析到 127.0.0.1 的域名」当同源目标发请求，Host 校验是回环下的纵深防御；
 * - 路径段与 after 一律不做百分号解码：原始字节直接匹配模式，没有「解码后再匹配」这一解释层，
 *   编码绕过（%2e%2e 穿越、编码后的字母）自然落 404；
 * - 全部响应 Cache-Control: no-store：观测面呈现的是「现状」，任何缓存层都会把它变成过时快照；
 * - 服务端唯一组装 HTML 的地方是 renderMarkdown 的产物；其余字段（作者名/kind/事件文本等）
 *   全部以纯文本 JSON 交付、由客户端 textContent 注入——不经 HTML 拼接就没有转义遗漏面。
 *
 * rootDigest 的唯一定义在中立模块 util/digest.js（health 响应、组合根的端口自发现、--stop 的
 * 根匹配与核心的 IPC 端点命名共用同一函数）；本模块只再导出，不复制实现，防止口径漂移。 */

import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { ID_PATTERN } from '../net/protocol.js';
import { rootDigest } from '../util/digest.js';
import { renderMarkdown } from './markdown.js';

export { rootDigest };

const APP_NAME = 'waystation-viewer';
const HEALTH_VERSION = 1;
const LOCAL_HOST_NAME = 'localhost';
const MAIN_ROOT = 'main';
const URL_SHELL = 'http://localhost';
const AFTER_KEY = 'after';
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
const SITE_ROOT_PATTERN = /^s\d+$/;
const COLLAB_FACE_PATTERN = /^\/api\/collab\/([^/]+)\/([^/]+)\/(feed|meta)$/;
/* 资产路由表：路径 → 注入对象里的键与 Content-Type。 */
const ASSET_ROUTES = new Map([
  ['/', { assetKey: 'INDEX_HTML', contentType: 'text/html; charset=utf-8' }],
  ['/app.js', { assetKey: 'APP_JS', contentType: 'text/javascript; charset=utf-8' }],
  ['/style.css', { assetKey: 'STYLE_CSS', contentType: 'text/css; charset=utf-8' }],
]);

/* —— Host 头校验 —— */

/* 去端口：括注形态（[IPv6]:端口 或 [IPv6]）取中括号内容；普通形态仅在唯一冒号且其后为纯
 * 数字时剥——IPv6 字面量的多冒号形态因此原样通过，交给下方的 isIP 判定。 */
function stripHostPort(host) {
  const bracketed = /^\[([0-9a-f:.]*)\](?::\d+)?$/.exec(host);
  if (bracketed !== null) {
    return bracketed[1];
  }
  const colonIndex = host.indexOf(':');
  if (colonIndex < 0 || host.indexOf(':', colonIndex + 1) >= 0) {
    return host;
  }
  return /^\d+$/.test(host.slice(colonIndex + 1)) ? host.slice(0, colonIndex) : host;
}

/* 规范化：小写化（Host 名大小写不敏感）→ 去端口 → 去尾点（限定的绝对域名写法）。
 * 缺失（HTTP/1.0 等不带 Host 的请求）返回 null。 */
function hostNameOf(rawHost) {
  if (typeof rawHost !== 'string') {
    return null;
  }
  const named = stripHostPort(rawHost.toLowerCase());
  return named.endsWith('.') ? named.slice(0, -1) : named;
}

/* 白名单：仅 localhost 与 IPv4/IPv6 字面量。域名（含解析到 127.0.0.1 的域名）一律拒绝——
 * 攻击面恰恰来自「域名指向回环」，而不是回环地址本身。 */
function isLocalHostName(name) {
  return typeof name === 'string' && (name === LOCAL_HOST_NAME || isIP(name) !== 0);
}

/* —— query 与路由匹配 —— */

/* 请求目标解析（origin-form 与 absolute-form 都可解析）：`//`、`/\` 这类空授权形态会抛错——
 * 按未知路径 404 呈现，不落入请求级 500（500 留给处理故障，畸形请求目标不属服务端故障）。 */
function pathOf(rawUrl) {
  try {
    return new URL(rawUrl, URL_SHELL).pathname;
  } catch {
    return null;
  }
}

/* after 原样截取、不做百分号解码（与路径段同一口径）。行 id 的字符集（十六进制、'-'、'@'、':'）
 * 不含 % 与 +，故原样取串与 searchParams.get 对合法锚点同解。 */
function afterOf(rawUrl) {
  const queryIndex = rawUrl.indexOf('?');
  if (queryIndex < 0) {
    return null;
  }
  const prefix = `${AFTER_KEY}=`;
  for (const pair of rawUrl.slice(queryIndex + 1).split('&')) {
    if (pair.startsWith(prefix)) {
      return pair.slice(prefix.length);
    }
  }
  return null;
}

/* 协作面路由：路径段按原始字节匹配（URL 构造器也不解码 pathname）。root 非 main/s<数字>、
 * id 不合 ID_PATTERN 都返回 null——与未知路径同落 404，对外不可区分。 */
function matchCollabFace(path) {
  const matched = COLLAB_FACE_PATTERN.exec(path);
  if (matched === null) {
    return null;
  }
  const [, root, collabId, face] = matched;
  if ((root !== MAIN_ROOT && !SITE_ROOT_PATTERN.test(root)) || !ID_PATTERN.test(collabId)) {
    return null;
  }
  return { root, collabId, face };
}

/* —— 响应原语 —— */

/* 全部响应 no-store 由这里单点施加（含错误响应）。 */
function respondText(res, status, contentType, body) {
  res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  res.end(body);
}

function respondJson(res, status, payload) {
  respondText(res, status, JSON_CONTENT_TYPE, JSON.stringify(payload));
}

/* —— 端点 —— */

/* 行字段逐项透传，仅 text → html：id/ts/fromName/direction/kind/count 原样保留。 */
function feedRowOf(row) {
  const { text, ...rest } = row;
  return { ...rest, html: renderMarkdown(text) };
}

function feedPayloadOf(result) {
  return { rows: result.rows.map(feedRowOf), reset: result.reset, skipped: result.skipped };
}

/* 协作读取面：目录缺失/形态不合时数据层返 null（「未就绪」不是错误）——一律 404。
 * feed 的正文换成服务端渲染的 html；meta 原样透传（事件轨文本保持纯文本）。 */
function serveCollabFace(context, face, after, res) {
  const result = face.face === 'feed'
    ? context.data.readFeed(face.root, face.collabId, after)
    : context.data.readMeta(face.root, face.collabId, after);
  if (result === null) {
    respondJson(res, 404, { error: '未知路径' });
    return;
  }
  respondJson(res, 200, face.face === 'feed' ? feedPayloadOf(result) : result);
}

function routeGetRequest(context, req, res) {
  const rawUrl = req.url ?? '';
  const path = pathOf(rawUrl);
  if (path === null) {
    respondJson(res, 404, { error: '未知路径' });
    return;
  }
  const assetRoute = ASSET_ROUTES.get(path);
  if (assetRoute !== undefined) {
    respondText(res, 200, assetRoute.contentType, context.assets[assetRoute.assetKey]);
    return;
  }
  if (path === '/api/health') {
    respondJson(res, 200, { app: APP_NAME, v: HEALTH_VERSION, pid: process.pid, root: rootDigest(context.dataDir) });
    return;
  }
  if (path === '/api/collabs') {
    respondJson(res, 200, { collabs: context.data.listCollabs().collabs });
    return;
  }
  const face = matchCollabFace(path);
  if (face === null) {
    respondJson(res, 404, { error: '未知路径' });
    return;
  }
  serveCollabFace(context, face, afterOf(rawUrl), res);
}

function serveRequest(context, req, res) {
  if (!isLocalHostName(hostNameOf(req.headers.host))) {
    respondJson(res, 403, { error: '非法 Host' });
    return;
  }
  if (req.method !== 'GET') {
    respondJson(res, 405, { error: '仅支持 GET' });
    return;
  }
  routeGetRequest(context, req, res);
}

/* 请求级容错：单个请求的任何异常只毁这一个请求——留痕后按响应是否已写出择路（已写出就只能
 * 断开连接，不得让半截响应冒充完整），绝不崩进程。 */
function handleRequest(context, req, res) {
  try {
    serveRequest(context, req, res);
  } catch (error) {
    context.log?.warn?.('查看器请求处理失败', { url: req.url, reason: error.message });
    if (res.headersSent) {
      res.destroy();
      return;
    }
    respondJson(res, 500, { error: '内部错误' });
  }
}

/* —— 工厂 —— */

/* 监听成功后取实际端口（port: 0 时是内核分配值）。 */
function boundPortOf(server, fallbackPort) {
  const address = server.address();
  return typeof address === 'object' && address !== null ? address.port : fallbackPort;
}

/* 优雅关停：先停止接收；空闲 keep-alive 连接不属「在途」，立即释放让关停收敛，在途请求则等
 * 它完成——close 回调在连接清空后触发。
 *
 * @param {import('node:http').Server} server
 * @returns {Promise<void>}
 */
function closeServer(server) {
  /** @type {Promise<void>} */
  const closed = new Promise((resolveClosed, rejectClosed) => {
    server.close((error) => {
      if (error) {
        rejectClosed(error);
        return;
      }
      resolveClosed();
    });
    server.closeIdleConnections();
  });
  return closed;
}

/**
 * 启动观察窗 HTTP 服务（默认仅绑回环）。data（createViewerData 实例）与 assets（INDEX_HTML/
 * APP_JS/STYLE_CSS 三字符串对象）由组合根装配注入，本模块不自建；port: 0 由内核分配（测试用）；
 * 监听失败（EADDRINUSE 等）以 Promise reject 上报，供组合根做端口协商。
 * @param {{ dataDir: string, log?: any, host?: string, port?: number, data: any, assets: any }} options
 * @returns {Promise<{ port: number, close: () => Promise<void> }>}
 */
export function startViewerServer({ dataDir, log, host = '127.0.0.1', port = 0, data, assets }) {
  const context = { dataDir, log, data, assets };
  /* requireHostHeader: false——Node 默认会把「无 Host 的 HTTP/1.1」挡在路由之前回 400，绕开
   * 本模块钉死的 403 判定；关掉默认，让 Host 白名单成为所有请求（含无 Host）的统一判定路径。 */
  const server = createServer({ requireHostHeader: false }, (req, res) => handleRequest(context, req, res));
  return new Promise((resolveStarted, rejectStarted) => {
    server.once('error', rejectStarted);
    server.listen({ host, port }, () => {
      resolveStarted({ port: boundPortOf(server, port), close: () => closeServer(server) });
    });
  });
}
