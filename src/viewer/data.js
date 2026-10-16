/* 人类观察窗的只读数据层：把本机协作/讨论目录的数据文件纯读成三组读取面
 * （列表 / 帖流与会话流 / 事件轨与元状态），供 HTTP 服务层渲染。
 *
 * 只读零写盘是硬契约：数据目录里的文件只读不改。存储层的 loadLines 会对半写尾行做截断修复
 * （ftruncate），因此一律自行 readFileSync，绝不经过它；loadConfig/saveConfig 的损坏分支会
 * 改名写盘、counter 模块的 import 面含写能力，同样禁用。
 * import 白名单（设计 §5.2）：store.js 只许 loadMember（纯读＋形态校验）；model/members/posts/joins
 * 只许形态判据与折叠纯函数；protocol.js/paths.js 取常量与判据函数；util/short-id.js 取会话短码的
 * 唯一权威；台账「最后一条合法行」按 isLedgerShape 纯读复现（沿 scripts/collab-viewer.js 的先例）；
 * member/snapshot/counter/config 四个小 JSON 自行 JSON.parse＋形态守卫。文件名常量因此在本文件就地
 * 定义（不 import 协作模块的常量符号）——单一权威由测试兜底：夹具以各模块导出的规范常量为准，
 * 与这里不同步即红。
 *
 * 会话可见面（设计 §1 观察窗）另纯读三源：run/bindings.json（本机绑定）、协作目录 joins.json
 * （获准名单）、站点根 known-hosts.json（远端发布）——三源一律宽容读取，缺源则整段省略。
 *
 * 微缓存只覆盖追加型 JSONL（posts/members/ledger/inbox/outbox）的解析结果，键 = (绝对路径,
 * size, mtimeMs)：append 必改 size；压实重写会改 size 或 mtime，键失配即重析。缺失态不入缓存
 * （每次先 stat，数据晚就绪必被发现）；小 JSON 直读不缓存（同尺寸原子替换能骗过键，且体量极小）。
 *
 * root 口径：'main' = 主数据目录；'s<k>' = <数据目录>/sites/<k>（k 取目录名原样，不硬编码槽位数）。 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { COLLABS_DIR_NAME, CONFIG_FILE_NAME, SITES_DIR_NAME, bindingsFilePath, collabDir, collabFilePath, joinsFilePath } from '../paths.js';
import { ID_PATTERN, MAX_MESSAGE_TEXT_CHARS, POST_KINDS, isIdentityName } from '../net/protocol.js';
import { isPostEntryShape } from '../collab/posts.js';
import { foldMemberEvents, isMemberEventShape } from '../collab/members.js';
import { isLedgerShape, isTimestamp } from '../collab/model.js';
import { loadMember } from '../collab/store.js';
import { isMuteShape } from '../collab/mute.js';
import { isApprovalShape, isJoinsShape } from '../collab/joins.js';
import { shortSessionId } from '../util/short-id.js';
import { displayText } from './text.js';
import { metaViewOf } from './meta.js';

/* 扇出合并窗口（设计 §5.3）：扇出逐条同步落盘、各自取时戳——毫秒相同的键在真实发送路径上
 * 会失配（写入系统调用拉开微秒级差距），窗口把「同一次扇出的连续条目」并回一组。
 * 链式判定（与本组上一条比，不与组首比）：长扇出仍整体成组；50ms 远大于单次落盘抖动、
 * 远小于人手连点两下的间隔。已知副作用照设计原文：同文连发若相邻 ≤50ms 会被并成一行。 */
const FANOUT_MERGE_WINDOW_MS = 50;

/* 读取侧文件名就地定义（白名单只放行协作模块的判据/折叠/loadMember 符号，store.js 更是只许
 * loadMember）：文件名是普通字符串、零写能力，副本的漂移风险由测试兜底——夹具一律以各模块导出的
 * 规范常量建立，任一处改名而此处不同步即用例变红。 */
const POSTS_FILE_NAME = 'posts.jsonl';
const MEMBERS_FILE_NAME = 'members.jsonl';
const LEDGER_FILE_NAME = 'ledger.jsonl';
const SNAPSHOT_FILE_NAME = 'snapshot.json';
const COUNTER_FILE_NAME = 'counter.json';
const MUTE_FILE_NAME = 'mute.json';
const INBOX_FILE_NAME = 'inbox.jsonl';
const OUTBOX_FILE_NAME = 'outbox.jsonl';
/* known-hosts.json 同规就地定义：known-hosts.js 的 import 面含写能力（createKnownHosts），只读层
 * 不引其符号；漂移由测试兜底（夹具以该模块导出的 KNOWN_HOSTS_FILE_NAME 规范常量建立）。 */
const KNOWN_HOSTS_FILE_NAME = 'known-hosts.json';

/* 本机身份名回退（config.json 缺失/损坏时，发出行作者无从得知——如实标「本机」）。 */
const FALLBACK_IDENTITY_NAME = '本机';
const MEMBER_EVENT_VERBS = { join: '加入', leave: '退出' };

/**
 * @typedef {{ root: string, base: string }} DataRoot
 * @typedef {{ id: string, ts: string, kind: string, fromName: string | null, direction: 'in' | 'out', text: string, payloadKey: string, count?: number }} SessionRow
 * @typedef {{ id: string, ts: string, fromName: string, direction: 'in' | 'out', kind: string, text: string, count?: number }} FeedRow
 * @typedef {{ id: string, ts: string, text: string }} EventRow
 * @typedef {{ rows: any[], skipped: number }} ParsedFile
 */

/* —— 通用小工具 —— */

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function timestampMsOf(ts) {
  return Date.parse(ts);
}

/* 缺失是合法状态（就绪前/归档后都在合法状态集内）——静默 null；其余读故障留痕后按缺失降级
 * （观察窗是观测面，单文件读故障不得把整页打成 500）。 */
function statOrNull(state, file) {
  try {
    return statSync(file);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      state.log?.warn?.('查看器读取 stat 失败（按缺失处理）', { file, reason: error.message });
    }
    return null;
  }
}

function readTextOrNull(state, file) {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      state.log?.warn?.('查看器读取失败（按缺失处理）', { file, reason: error.message });
    }
    return null;
  }
}

/* 小 JSON 直读（member/snapshot/counter/config）：缺失/损坏统一 null——「未就绪」是合法呈现态，
 * 不告警；非 ENOENT 的读故障（EISDIR/EACCES 等）与 JSONL 面同纪律：留痕 log?.warn 后按缺失降级。
 * 同尺寸原子替换能骗过 (path,size,mtime) 键，所以这类文件不缓存、每次现读。 */
function readJsonOrNull(state, file) {
  /** @type {string | null} */
  let text = null;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      state.log?.warn?.('查看器小 JSON 读取失败（按缺失处理）', { file, reason: error.message });
    }
  }
  if (text === null) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/* readdir 目录项：读不到（缺失/故障）返回 null——故障留痕，降级口径由调用方定。 */
function dirEntriesOrNull(state, dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') {
      state.log?.warn?.('查看器目录读取失败（按缺失处理）', { dir, reason: error.message });
    }
    return null;
  }
}

function dirNamesOf(state, dir) {
  const dirents = dirEntriesOrNull(state, dir);
  return dirents === null ? [] : dirents.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

/* —— 微缓存与 JSONL 解析 —— */

/* 完整行规则（全文件普适，防 skipped 与游标随半写抖动）：只计以换行收尾的完整行——收尾残段
 * 不计入、补齐后才出现；空行跳过且不计（沿存储层 loadLines 先例，空白行不属「坏行」）。
 * classify 三态：{ row } 入列；{ skip: true } 计入 skipped；null 忽略（合法但不属本读取面）。 */
function parseJsonlText(text, classify) {
  const rows = [];
  let skipped = 0;
  const lines = text.split('\n');
  lines.pop();
  for (const line of lines) {
    if (line.trim() === '') {
      continue;
    }
    /** @type {unknown} */
    let parsed = null;
    try {
      parsed = JSON.parse(line);
    } catch {
      // 解析失败与「解析结果不是对象」共用下方出口：都按坏行计数
    }
    if (!isPlainObject(parsed)) {
      skipped++;
      continue;
    }
    const classified = classify(parsed);
    if (classified === null) {
      continue;
    }
    if (classified.skip === true) {
      skipped++;
      continue;
    }
    rows.push(classified.row);
  }
  return { rows, skipped };
}

/* 命中不再读文件；文件消失（stat 失败）时连旧条目一并丢弃——防同键重建后吃到旧解析；
 * 读故障不入缓存，下一拍重试。 */
function readParsedFile(state, file, classify) {
  const stats = statOrNull(state, file);
  if (stats === null) {
    state.parsedCache.delete(file);
    return null;
  }
  const held = state.parsedCache.get(file);
  if (held !== undefined && held.size === stats.size && held.mtimeMs === stats.mtimeMs) {
    state.cacheHits++;
    return held.parsed;
  }
  const text = readTextOrNull(state, file);
  if (text === null) {
    return null;
  }
  state.cacheMisses++;
  const parsed = parseJsonlText(text, classify);
  state.parsedCache.set(file, { size: stats.size, mtimeMs: stats.mtimeMs, parsed });
  return parsed;
}

/* —— 行分类器（各文件一具）—— */

function classifyPostLine(parsed) {
  return isPostEntryShape(parsed) ? { row: parsed } : { skip: true };
}

function classifyMemberLine(parsed) {
  return isMemberEventShape(parsed) ? { row: parsed } : { skip: true };
}

function classifyLedgerLine(parsed) {
  return isLedgerShape(parsed) ? { row: parsed } : { skip: true };
}

/* 内容行头部（inbox/outbox 共用）：msgId 形态 / type 为串 / 时间戳合法——不符即坏行。
 * 先判 typeof 再 test：ID_PATTERN.test(undefined) 会把字面量 'undefined' 当合法 id。 */
function hasContentHead(parsed, ts) {
  return typeof parsed.msgId === 'string'
    && ID_PATTERN.test(parsed.msgId)
    && typeof parsed.type === 'string'
    && isTimestamp(ts);
}

/* 内容正文取数：stop 的正文在 payload.reason（发送侧 payloadOf 的构造形态），其余内容类在
 * payload.text；长度上限统一按并集上限 MAX_MESSAGE_TEXT_CHARS 防御——协议面各类型上限
 * （如 stop 的 MAX_REASON_CHARS）见 protocol.js，本上限只做内存/渲染防御、不做协议校验。
 * 超长/缺失/空白一律「取不到文本」，计入 skipped（协议保证内容帧必带文本，取不到即文件被手改过）。 */
function contentTextOf(type, payload) {
  if (!isPlainObject(payload)) {
    return null;
  }
  const text = type === 'stop' ? payload.reason : payload.text;
  if (typeof text !== 'string' || text.trim() === '' || text.length > MAX_MESSAGE_TEXT_CHARS) {
    return null;
  }
  return text;
}

function classifyInboxLine(parsed) {
  if (!hasContentHead(parsed, parsed.ts)) {
    return { skip: true };
  }
  if (!POST_KINDS.includes(parsed.type)) {
    return null;   // 非内容类帧（快照/治理/传输…）合法但不入会话流：忽略不计
  }
  if (!isPlainObject(parsed.from) || !isIdentityName(parsed.from.identityName)) {
    return { skip: true };
  }
  const text = contentTextOf(parsed.type, parsed.payload);
  if (text === null) {
    return { skip: true };
  }
  return { row: contentRowOf(parsed, 'in', parsed.ts, parsed.from.identityName, text) };
}

function classifyOutboxLine(parsed) {
  if (!hasContentHead(parsed, parsed.createdAt)) {
    return { skip: true };
  }
  if (!POST_KINDS.includes(parsed.type)) {
    return null;
  }
  const text = contentTextOf(parsed.type, parsed.payload);
  if (text === null) {
    return { skip: true };
  }
  return { row: contentRowOf(parsed, 'out', parsed.createdAt, null, text) };
}

/* 会话流内部行：fromName 只对 inbox 在解析期落定（行内自带）；outbox 的作者是本机身份名、
 * 来自 config.json，在组装期补——config 不在缓存键里，不能烘进缓存的解析结果。 */
function contentRowOf(parsed, direction, ts, fromName, text) {
  return {
    id: parsed.msgId,
    ts,
    direction,
    kind: parsed.type,
    fromName,
    text: displayText(text, { newlines: 'keep' }),
    payloadKey: JSON.stringify(parsed.payload),
  };
}

/* —— 会话流组装（折叠 → 扇出合并 → 并集）—— */

/* 折叠：同 msgId 取末条为行内容、首现时间为行 ts——outbox 是状态快照流（后写胜）；
 * inbox 判重窗过期后的重放同规去重（不重复显示重投）。 */
function foldContentRows(rows) {
  /** @type {Map<string, SessionRow>} */
  const byId = new Map();
  for (const row of rows) {
    const held = byId.get(row.id);
    byId.set(row.id, held === undefined ? row : { ...row, ts: held.ts });
  }
  return [...byId.values()];
}

function compareByTimeAndId(left, right) {
  const byTime = timestampMsOf(left.ts) - timestampMsOf(right.ts);
  if (byTime !== 0) {
    return byTime;
  }
  if (left.id === right.id) {
    return 0;
  }
  return left.id < right.id ? -1 : 1;
}

/* (ts, id) 全同的异常残迹固定 inbox 行在前（源序不依赖排序实现稳定性）。 */
function directionRank(row) {
  return row.direction === 'in' ? 0 : 1;
}

function compareForUnion(left, right) {
  const byTimeAndId = compareByTimeAndId(left, right);
  return byTimeAndId !== 0 ? byTimeAndId : directionRank(left) - directionRank(right);
}

/* 扇出合并：按（ts 升序、id 稳定序）走一遍，同 type＋payload 全等＋与组内上一条 ts 差 ≤窗口
 * 者并入一组；行 id＝组首 msgId（组内条目被回收致 id 顺移时客户端偶发一次全量重渲，无害）。 */
function mergeFanout(rows) {
  const ordered = [...rows].sort(compareByTimeAndId);
  /** @type {Array<{ row: SessionRow, payloadKey: string, lastTsMs: number, count: number }>} */
  const groups = [];
  for (const row of ordered) {
    const tail = groups[groups.length - 1];
    const rowTsMs = timestampMsOf(row.ts);
    const joins = tail !== undefined
      && tail.row.kind === row.kind
      && tail.payloadKey === row.payloadKey
      && rowTsMs - tail.lastTsMs <= FANOUT_MERGE_WINDOW_MS;
    if (joins) {
      tail.count++;
      tail.lastTsMs = rowTsMs;
      continue;
    }
    groups.push({ row, payloadKey: row.payloadKey, lastTsMs: rowTsMs, count: 1 });
  }
  return groups.map((group) => ({ ...group.row, count: group.count }));
}

/* 并集：两文件各自折叠后，outbox 行再过扇出合并；跨文件同 msgId（异常残迹）取 ts 较晚的条目、
 * 仍同取 inbox 行；组好后按（ts、id、源序）定序。 */
function assembleManagedRows(inboxRows, outboxRows, identityName) {
  /** @type {Map<string, SessionRow>} */
  const byId = new Map(mergeFanout(foldContentRows(outboxRows)).map((row) => [row.id, row]));
  for (const row of foldContentRows(inboxRows)) {
    const held = byId.get(row.id);
    if (held === undefined || timestampMsOf(row.ts) >= timestampMsOf(held.ts)) {
      byId.set(row.id, row);
    }
  }
  return [...byId.values()].sort(compareForUnion).map((row) => toFeedRow(row, identityName));
}

function toFeedRow(row, identityName) {
  /** @type {FeedRow} */
  const feed = {
    id: row.id,
    ts: row.ts,
    fromName: row.direction === 'in' ? row.fromName : identityName,
    direction: row.direction,
    kind: row.kind,
    text: row.text,
  };
  if (row.count > 1) {
    feed.count = row.count;   // 单条不携 count：服务层只对合并行标「（N 人）」
  }
  return feed;
}

/* —— 帖流（讨论）—— */

/* 帖流按文件序（=到站序，追加是唯一写入路径）成行，不做 ts 重排（沿终端查看器口径）。
 * 行 id 带作者实例标识：entryId 跨作者可撞，去重键是「作者+postId」。 */
function forumFeedRows(posts) {
  return posts.map((entry) => ({
    id: `${entry.entryId}@${entry.from.instanceId}`,
    ts: entry.ts,
    fromName: entry.from.identityName,
    kind: entry.kind,
    text: displayText(entry.text, { newlines: 'keep' }),
  }));
}

/* —— 锚点游标 —— */

/* after＝客户端最后渲染的行 id：定位其「末次出现」之后为增量（重复行残迹下仍指向已渲染那份）；
 * 找不到（行集前缘淘汰 / 压实重写）→ reset＋全量，客户端清屏重渲。count 类计数游标在滑窗下会
 * 静默吞条目，锚点在任何窗口形态下闭合，故不采用。缺省 after＝全量（初载语义，同 reset）。 */
function anchorOf(rows, after) {
  if (after === null || after === undefined) {
    return { rows, reset: true };
  }
  let found = -1;
  for (let index = 0; index < rows.length; index++) {
    if (rows[index].id === after) {
      found = index;
    }
  }
  if (found < 0) {
    return { rows, reset: true };
  }
  return { rows: rows.slice(found + 1), reset: false };
}

/* —— 小 JSON 取数（member/snapshot/counter/config/mute）—— */

/* 台账来源三分支（设计 §5.3）：manager→ledger.jsonl 末条合法行；member→snapshot.ledger
 * （成员席位的主体数据源）；role 不可知（参与记录缺失/损坏）→ledger 优先、无则 snapshot、
 * 皆无=未就绪。rows 供迁移行推导——末条即现态，快照分支只有单条（成员席位无迁移行）。 */
function ledgerSourceOf(state, base, collabId, member) {
  const role = member === null ? null : member.role;
  if (role === 'member') {
    const snapshotLedger = snapshotLedgerOf(state, base, collabId);
    return { ledgerRows: snapshotLedger === null ? [] : [snapshotLedger], skipped: 0 };
  }
  const parsed = readParsedFile(state, collabFilePath(base, collabId, LEDGER_FILE_NAME), classifyLedgerLine);
  const skipped = parsed === null ? 0 : parsed.skipped;
  if (parsed !== null && parsed.rows.length > 0) {
    return { ledgerRows: parsed.rows, skipped };
  }
  const snapshotLedger = role === null ? snapshotLedgerOf(state, base, collabId) : null;
  if (snapshotLedger !== null) {
    return { ledgerRows: [snapshotLedger], skipped };
  }
  return { ledgerRows: [], skipped };
}

function snapshotLedgerOf(state, base, collabId) {
  const parsed = readJsonOrNull(state, collabFilePath(base, collabId, SNAPSHOT_FILE_NAME));
  return isPlainObject(parsed) && isLedgerShape(parsed.ledger) ? parsed.ledger : null;
}

function lastOf(rows) {
  return rows.length > 0 ? rows[rows.length - 1] : null;
}

/* 累计收到计数（counter.json）：只读自行 JSON.parse＋{v:1, messageCount} 守卫（counter 模块的
 * import 面含写能力，白名单禁其符号）；缺失/损坏 → null（服务层省略该字段）。 */
function counterOf(state, base, collabId) {
  const parsed = readJsonOrNull(state, collabFilePath(base, collabId, COUNTER_FILE_NAME));
  if (isPlainObject(parsed) && parsed.v === 1 && Number.isInteger(parsed.messageCount) && parsed.messageCount >= 0) {
    return parsed.messageCount;
  }
  return null;
}

/* 静音态（mute.json）：纯读同一小 JSON 纪律（直读不缓存、非 ENOENT 读故障留痕降级）。形态判据
 * 只引 collab/mute.js 的 isMuteShape 单点——写面符号（createMuteStore）一律不引（白名单硬闸）；
 * 缺失/损坏/形态不符统一 false：坏文件与「静音存储自身的加载失败」同归默认（不静音）。 */
function mutedOf(state, base, collabId) {
  const parsed = readJsonOrNull(state, collabFilePath(base, collabId, MUTE_FILE_NAME));
  return isMuteShape(parsed) ? parsed.muted : false;
}

/* —— 会话可见面（设计 §1 观察窗：本机获准 / 本机绑定 / 站长获准名单 / 远端发布）—— */

/* 非空文本字段（展示用名）：缺失/空串＝无值（省略字段，呈现端回退别的标识）。 */
function textFieldOf(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

/* 本机绑定（run/bindings.json，核心单写者原子替换、读到的永远是已提交态）：整档读不出/解析不出/
 * 顶层非对象＝无源（undefined，呈现端省略该段）；表在场而本协作无条目/条目形态不符＝如实 null
 * （无接线）。会话标识经短码唯一权威（util/short-id.js）产出对外表示——不就地切片。 */
function localBoundOf(state, base, collabId) {
  const parsed = readJsonOrNull(state, bindingsFilePath(base));
  if (!isPlainObject(parsed)) {
    return undefined;
  }
  const binding = parsed[collabId];
  if (!isPlainObject(binding) || textFieldOf(binding.sessionId) === null) {
    return null;
  }
  return shortSessionId(binding.sessionId);
}

/* 加入台账的获准名单（协作目录 joins.json）：整档形态不符＝无源（null，含缺失/损坏——「未就绪」
 * 是合法呈现态，不告警）；合规档案逐条过 isApprovalShape（坏条丢弃、其余照常——与台账模块的加载
 * 纪律同源）。只引判据符号；写面 createJoinsStore 一律不引（白名单硬闸）。 */
function approvalsOf(state, base, collabId) {
  const parsed = readJsonOrNull(state, joinsFilePath(base, collabId));
  if (!isJoinsShape(parsed)) {
    return null;
  }
  return parsed.approvals.filter((entry) => isApprovalShape(entry));
}

/* 远端发布（站点根 known-hosts.json，发现层的学习清单）：逐条取「有合规实例标识且如实携 sessions
 * 数组」者——字段缺省＝对端未报（整条跳过，不伪造空列表），空数组＝如实报零（保留在场）；同实例
 * 多条择「最近见过」一条（与单点兜底清单的择新口径同源）。无任何可呈现条目＝无源（null）。 */
function publishedOf(state, base) {
  const parsed = readJsonOrNull(state, join(base, KNOWN_HOSTS_FILE_NAME));
  if (!isPlainObject(parsed) || !Array.isArray(parsed.hosts)) {
    return null;
  }
  const newest = new Map();
  for (const entry of parsed.hosts) {
    if (isPublishableEntry(entry)) {
      keepNewestPerInstance(newest, entry);
    }
  }
  if (newest.size === 0) {
    return null;
  }
  return [...newest.values()].map((held) => publishedEntryOf(held.entry));
}

/* 可呈现条目：有合规实例标识、且如实携 sessions 数组（缺字段＝对端未报，整条跳过）。 */
function isPublishableEntry(entry) {
  return isPlainObject(entry) && Array.isArray(entry.sessions) && hasInstanceId(entry);
}

/* 同实例择「最近见过」一条（时间戳读不出按最旧参与竞位；同刻先见者留）。 */
function keepNewestPerInstance(newest, entry) {
  const seen = typeof entry.lastSeenAt === 'string' ? Date.parse(entry.lastSeenAt) : Number.NaN;
  const held = newest.get(entry.instanceId);
  if (held === undefined || seen > held.seen) {
    newest.set(entry.instanceId, { seen, entry });
  }
}

/* 先判 typeof 再 test：ID_PATTERN.test(undefined) 会把字面量 'undefined' 当合法标识。 */
function hasInstanceId(entry) {
  return typeof entry.instanceId === 'string' && ID_PATTERN.test(entry.instanceId);
}

function publishedEntryOf(entry) {
  const view = {
    instanceId: entry.instanceId,
    sessions: entry.sessions.filter((code) => textFieldOf(code) !== null).map(shortSessionId),
  };
  const name = textFieldOf(entry.identityName);
  if (name !== null) {
    view.identityName = name;
  }
  return view;
}

/* 获准名单条目（站长席位视角）：实例标识＋会话短码；机器名从台账名单补齐（本机已认识该机器时，
 * 台账即台账/快照的 members 名单），名单查无则省略该字段（呈现端回退实例标识）。 */
function grantedEntryOf(approval, ledger) {
  const view = { instanceId: approval.instanceId, sessionId: shortSessionId(approval.sessionId) };
  const name = rosterNameOf(ledger, approval.instanceId);
  if (name !== null) {
    view.identityName = name;
  }
  return view;
}

function rosterNameOf(ledger, instanceId) {
  if (ledger === null || ledger === undefined || !Array.isArray(ledger.members)) {
    return null;
  }
  for (const member of ledger.members) {
    if (isPlainObject(member) && member.instanceId === instanceId) {
      return textFieldOf(member.identityName);
    }
  }
  return null;
}

/* 会话可见面（设计 §1）：四视图＝本机获准 / 本机绑定 / 站长获准名单 / 远端发布。
 * 获准名单按席位分派——站长席位（role=manager）的台账即「站长获准名单」（全体批准记录，逐条携
 * 实例标识）；成员会话机（及参与记录缺失的残骸）的台账即「本机获准名单」（本机哪些会话获准该协作）。
 * 讨论无批准门（无台账）——不产获准段（不是「未获准」，模式分支在呈现端同样按它走）；绑定与远端
 * 发布与模式无关。缺数据源则省略该字段（在场而空/null＝如实零/无）；四视图全缺＝整段省略（返回
 * null，条目与 meta 据此不带该字段——既有夹具无三源，载荷逐字节不变）。 */
function sessionsOf(state, base, collabId, member, mode, ledger) {
  const sessions = {};
  const bound = localBoundOf(state, base, collabId);
  if (bound !== undefined) {
    sessions.localBound = bound;
  }
  if (mode !== 'forum') {
    const approvals = approvalsOf(state, base, collabId);
    if (approvals !== null && member !== null && member.role === 'manager') {
      sessions.grantedRemote = approvals.map((approval) => grantedEntryOf(approval, ledger));
    } else if (approvals !== null) {
      sessions.localGranted = approvals.map((approval) => shortSessionId(approval.sessionId));
    }
  }
  const published = publishedOf(state, base);
  if (published !== null) {
    sessions.published = published;
  }
  return Object.keys(sessions).length === 0 ? null : sessions;
}

/* 本机身份名（发出行作者）：读对应根的 config.json，仅 JSON.parse＋字符串守卫——严禁 loadConfig
 * （其损坏分支会改名写盘）；缺失/损坏/空值回退「本机」。 */
function identityNameOf(state, base) {
  const parsed = readJsonOrNull(state, join(base, CONFIG_FILE_NAME));
  if (isPlainObject(parsed) && typeof parsed.identityName === 'string' && parsed.identityName.trim() !== '') {
    return parsed.identityName;
  }
  return FALLBACK_IDENTITY_NAME;
}

function topicOf(ledger, member) {
  if (ledger !== null) {
    return ledger.topic;
  }
  return member !== null && typeof member.topic === 'string' ? member.topic : null;
}

/* 模式判定：member.json.mode 为准；缺 mode 的旧记录按 managed 解释——单一权威在 model.js 的
 * 缺省口径，此处的文件形态只作「目录残骸」的防御性兜底（参与记录缺失/损坏且帖文件在，才判讨论）。 */
function modeOf(member, postsPresent) {
  if (member !== null && member.mode !== undefined) {
    return member.mode;
  }
  if (member === null && postsPresent) {
    return 'forum';
  }
  return 'managed';
}

/* —— 事件轨 —— */

function dedupeMemberEvents(rows) {
  const seen = new Set();
  const events = [];
  for (const row of rows) {
    if (!seen.has(row.eventId)) {
      seen.add(row.eventId);
      events.push(row);
    }
  }
  return events;
}

/* 讨论事件轨：文件序；现人数＝截至并含该事件按 foldMemberEvents 折叠（历史人数按事件前缀折叠，
 * 不是文件末尾的现人数——逐条回看才如实）。 */
function forumEventRows(events) {
  const rows = [];
  const prefix = [];
  for (const event of events) {
    prefix.push(event);
    const count = foldMemberEvents(prefix).length;
    rows.push({ id: event.eventId, ts: event.ts, text: `${event.identityName} ${MEMBER_EVENT_VERBS[event.kind]}（现 ${count} 人）` });
  }
  return rows;
}

/* 协作事件轨：相邻有效行 status 差异 → 迁移行；id＝「后行有效序号:迁移序号」——对同一文件内容
 * 确定（台账被隔离重建致旧迁移消失时，客户端由锚点 reset 兜底全量重渲）。 */
function migrationRowsOf(ledgerRows) {
  const rows = [];
  for (let index = 1; index < ledgerRows.length; index++) {
    const previous = ledgerRows[index - 1];
    const current = ledgerRows[index];
    if (previous.status !== current.status) {
      rows.push({ id: `${index}:${rows.length}`, ts: current.updatedAt, text: `状态：${previous.status} → ${current.status}` });
    }
  }
  return rows;
}

/* —— 根与协作目录解析 —— */

/* root → 数据根：'s<k>' 的 k 取目录名原样（与全根扫描同口径，不硬编码槽位数）；
 * 形态不合法 → null（读取面不抛，服务层按 404 呈现）。 */
function baseDirOf(dataDir, root) {
  if (root === 'main') {
    return dataDir;
  }
  if (typeof root !== 'string') {
    return null;
  }
  const matched = /^s(\d+)$/.exec(root);
  return matched === null ? null : join(dataDir, SITES_DIR_NAME, matched[1]);
}

/* 协作目录就位判定：目录不存在 / 非目录 / id 形态非法 → null——「目录缺失」与「数据未就绪」
 * 必须可区分（服务层 404 判定只吃前者）；此路径不抛（collabDir 的形态守卫已由前置判定挡下）。 */
function resolveCollabDir(state, root, collabId) {
  const base = baseDirOf(state.dataDir, root);
  if (base === null || typeof collabId !== 'string' || !ID_PATTERN.test(collabId)) {
    return null;
  }
  const dir = collabDir(base, collabId);
  const stats = statOrNull(state, dir);
  return stats !== null && stats.isDirectory() ? { base, dir } : null;
}

/* —— 读取面 —— */

function readFeed(state, root, collabId, after) {
  const resolved = resolveCollabDir(state, root, collabId);
  if (resolved === null) {
    return null;
  }
  const { base } = resolved;
  const member = loadMember(base, collabId);
  const posts = readParsedFile(state, collabFilePath(base, collabId, POSTS_FILE_NAME), classifyPostLine);
  if (modeOf(member, posts !== null) === 'forum') {
    const anchored = anchorOf(posts === null ? [] : forumFeedRows(posts.rows), after);
    return { rows: anchored.rows, reset: anchored.reset, skipped: posts === null ? 0 : posts.skipped };
  }
  const inbox = readParsedFile(state, collabFilePath(base, collabId, INBOX_FILE_NAME), classifyInboxLine);
  const outbox = readParsedFile(state, collabFilePath(base, collabId, OUTBOX_FILE_NAME), classifyOutboxLine);
  const rows = assembleManagedRows(
    inbox === null ? [] : inbox.rows,
    outbox === null ? [] : outbox.rows,
    identityNameOf(state, base),
  );
  const anchored = anchorOf(rows, after);
  return {
    rows: anchored.rows,
    reset: anchored.reset,
    skipped: (inbox === null ? 0 : inbox.skipped) + (outbox === null ? 0 : outbox.skipped),
  };
}

function readMeta(state, root, collabId, after) {
  const resolved = resolveCollabDir(state, root, collabId);
  if (resolved === null) {
    return null;
  }
  const { base } = resolved;
  const member = loadMember(base, collabId);
  const posts = readParsedFile(state, collabFilePath(base, collabId, POSTS_FILE_NAME), classifyPostLine);
  const mode = modeOf(member, posts !== null);
  /* 台账来源在分支前取好一并下发（会话可见面的获准名单同取这份，不再重读）。 */
  const source = mode === 'forum' ? { ledgerRows: [], skipped: 0 } : ledgerSourceOf(state, base, collabId, member);
  const meta = mode === 'forum'
    ? forumMetaOf(state, base, collabId, member, posts, after)
    : managedMetaOf(state, base, collabId, member, source, after);
  /* 静音态与会话可见面都与模式无关（讨论/协作同面），统一在 meta 组装末尾附加——两个模式分支各自增
   * 字段会把同一条取数纪律复制两份。缺源则整段省略（与列表条目同一口径）。 */
  const muted = mutedOf(state, base, collabId);
  const sessions = sessionsOf(state, base, collabId, member, mode, lastOf(source.ledgerRows));
  return sessions === null ? { ...meta, muted } : { ...meta, muted, sessions };
}

/* 讨论元状态：席面名/态取参与记录（讨论无台账）；成员数＝事件折叠；计数＝合法完整帖行数
 * （本观察窗所见）。 */
function forumMetaOf(state, base, collabId, member, posts, after) {
  const members = readParsedFile(state, collabFilePath(base, collabId, MEMBERS_FILE_NAME), classifyMemberLine);
  const events = dedupeMemberEvents(members === null ? [] : members.rows);
  const view = metaViewOf(null, member);
  return {
    name: view === null ? null : view.name,
    state: view === null ? null : view.state,
    mode: 'forum',
    memberCount: foldMemberEvents(events).length,
    count: posts === null ? 0 : posts.rows.length,
    topic: topicOf(null, member),
    events: anchorOf(forumEventRows(events), after),
    skipped: (members === null ? 0 : members.skipped) + (posts === null ? 0 : posts.skipped),
  };
}

/* 协作元状态：席面名/态取 metaViewOf 口径；人数＝台账/快照 members 名单长度（成员席位下是
 * 邀请定格名单，非实时人数——如实呈现）；计数＝累计收到（与会话流不同源：不含发出、且随
 * 文件现行内容走）。台账来源由调用方取好传入（会话可见面同取一份，台账文件不重读）。 */
function managedMetaOf(state, base, collabId, member, source, after) {
  const ledger = lastOf(source.ledgerRows);
  const view = metaViewOf(ledger, member);
  return {
    name: view === null ? null : view.name,
    state: view === null ? null : view.state,
    mode: 'managed',
    memberCount: ledger === null ? 0 : ledger.members.length,
    count: counterOf(state, base, collabId),
    topic: topicOf(ledger, member),
    events: anchorOf(migrationRowsOf(source.ledgerRows), after),
    skipped: source.skipped,
  };
}

/* —— 列表（全根扫描）—— */

/* 扫描面＝主数据目录 + 全部 sites/<数字目录>（目录事实，不硬编码槽位数；sites/ 不存在＝正常）。 */
function rootsOf(state) {
  const sitesDir = join(state.dataDir, SITES_DIR_NAME);
  const roots = [{ root: 'main', base: state.dataDir }];
  for (const name of dirNamesOf(state, sitesDir)) {
    if (/^\d+$/.test(name)) {
      roots.push({ root: `s${name}`, base: join(sitesDir, name) });
    }
  }
  return roots;
}

function collabIdsOf(state, base) {
  return dirNamesOf(state, join(base, COLLABS_DIR_NAME)).filter((name) => ID_PATTERN.test(name));
}

/* 最后活动：目录内文件 mtimeMs 最大值；目录空（无文件）时退目录自身 mtime——新建协作无文件
 * 也要能参与排序。目录读不到返回 0（降级仍可排序，不留 undefined）。 */
function updatedAtMsOf(state, base, collabId) {
  const dir = collabDir(base, collabId);
  const dirents = dirEntriesOrNull(state, dir);
  if (dirents === null) {
    return 0;
  }
  /** @type {number | null} */
  let newest = null;
  for (const entry of dirents) {
    if (!entry.isFile()) {
      continue;
    }
    const stats = statOrNull(state, join(dir, entry.name));
    if (stats !== null && (newest === null || stats.mtimeMs > newest)) {
      newest = stats.mtimeMs;
    }
  }
  if (newest !== null) {
    return newest;
  }
  const dirStats = statOrNull(state, dir);
  return dirStats === null ? 0 : dirStats.mtimeMs;
}

function forumSummaryOf(state, base, collabId, posts) {
  const members = readParsedFile(state, collabFilePath(base, collabId, MEMBERS_FILE_NAME), classifyMemberLine);
  const events = dedupeMemberEvents(members === null ? [] : members.rows);
  return { ledger: null, memberCount: foldMemberEvents(events).length, count: posts === null ? 0 : posts.rows.length };
}

function managedSummaryOf(state, base, collabId, member) {
  const source = ledgerSourceOf(state, base, collabId, member);
  const ledger = lastOf(source.ledgerRows);
  return { ledger, memberCount: ledger === null ? 0 : ledger.members.length, count: counterOf(state, base, collabId) };
}

function summarizeCollab(state, site, collabId) {
  const member = loadMember(site.base, collabId);
  const posts = readParsedFile(state, collabFilePath(site.base, collabId, POSTS_FILE_NAME), classifyPostLine);
  const mode = modeOf(member, posts !== null);
  const summary = mode === 'forum'
    ? forumSummaryOf(state, site.base, collabId, posts)
    : managedSummaryOf(state, site.base, collabId, member);
  const view = metaViewOf(summary.ledger, member);
  const entry = {
    root: site.root,
    id: collabId,
    name: view === null ? null : view.name,
    state: view === null ? null : view.state,
    muted: mutedOf(state, site.base, collabId),
    mode,
    memberCount: summary.memberCount,
    count: summary.count,
    updatedAt: updatedAtMsOf(state, site.base, collabId),
  };
  /* 会话可见面：缺数据源则省略整段（列表行与详情成员区都据此不渲染空段）。 */
  const sessions = sessionsOf(state, site.base, collabId, member, mode, summary.ledger);
  if (sessions !== null) {
    entry.sessions = sessions;
  }
  return entry;
}

/* 排序：updatedAt 倒序；同值以 id、再以 root 稳定序（同名 id 出现在两根时顺序仍确定）。 */
function compareCollabEntries(left, right) {
  if (left.updatedAt !== right.updatedAt) {
    return right.updatedAt - left.updatedAt;
  }
  if (left.id !== right.id) {
    return left.id < right.id ? -1 : 1;
  }
  if (left.root === right.root) {
    return 0;
  }
  return left.root < right.root ? -1 : 1;
}

function listCollabs(state) {
  const entries = [];
  for (const site of rootsOf(state)) {
    for (const collabId of collabIdsOf(state, site.base)) {
      entries.push(summarizeCollab(state, site, collabId));
    }
  }
  return { collabs: entries.sort(compareCollabEntries) };
}

/* —— 工厂 —— */

/**
 * 只读数据层工厂（同步 API、纯读；工厂闭包持微缓存）。
 * @param {{ dataDir: string, log?: any }} options log 仅用于读故障留痕（log?.warn）
 * @returns {{ listCollabs: () => { collabs: any[] }, readFeed: (root: string, collabId: string, after?: string | null) => any, readMeta: (root: string, collabId: string, after?: string | null) => any, stats: () => { cacheHits: number, cacheMisses: number } }}
 */
export function createViewerData({ dataDir, log }) {
  const state = {
    dataDir,
    log,
    /** @type {Map<string, { size: number, mtimeMs: number, parsed: ParsedFile }>} */
    parsedCache: new Map(),
    cacheHits: 0,
    cacheMisses: 0,
  };
  return {
    listCollabs: () => listCollabs(state),
    readFeed: (root, collabId, after) => readFeed(state, root, collabId, after),
    readMeta: (root, collabId, after) => readMeta(state, root, collabId, after),
    stats: () => ({ cacheHits: state.cacheHits, cacheMisses: state.cacheMisses }),
  };
}
