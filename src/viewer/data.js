/* 人类观察窗的只读数据层：把本机协作/讨论目录的数据文件纯读成三组读取面
 * （列表 / 帖流与会话流 / 事件轨与元状态），供 HTTP 服务层渲染。
 *
 * 只读零写盘是硬契约：数据目录里的文件只读不改。存储层的 loadLines 会对半写尾行做截断修复
 * （ftruncate），因此一律自行 readFileSync，绝不经过它；loadConfig/saveConfig 的损坏分支会
 * 改名写盘、counter 模块的 import 面含写能力，同样禁用。
 * import 白名单（设计 §6.2/§10）：store.js 只许 loadMember（纯读＋形态校验，旧 member.json 读取器）；
 * model/members/posts 只许形态判据与折叠纯函数；protocol.js/paths.js 取常量与判据函数；
 * util/short-id.js 取会话短码的唯一权威；台账「最后一条合法行」按 isLedgerShape 纯读复现
 * （沿 scripts/collab-viewer.js 的先例）；carrier/席位/邀请/离席/恢复/迁移等小 JSON 自行
 * JSON.parse＋形态守卫。文件名常量因此在本文件就地定义（不 import 协作模块的常量符号）——
 * 单一权威由测试兜底：夹具以各模块导出的规范常量为准，与这里不同步即红。
 *
 * 会话席位视图（设计 §10）纯读席位表与共享态：本机会员席位来自注入的 listLocalSeats
 * （运行时席位接口；观察窗独立进程未注入时回退 seats/<sessionId>.json），协作远端成员来自
 * 台账/快照名单、讨论远端成员来自成员事件折叠（本机实例按根目录 instance-id 排除），
 * 离席历史来自本地派生索引 departed.jsonl。旧协作（旧 member.json、无 carrier 标记）与
 * migration/recovery 标记只读呈现；协作目录的数据文件清单见 READ_FILE_NAMES。
 *
 * 微缓存只覆盖追加型 JSONL（posts/members/ledger/inbox/outbox）的解析结果，键 = (绝对路径,
 * size, mtimeMs)：append 必改 size；压实重写会改 size 或 mtime，键失配即重析。缺失态不入缓存
 * （每次先 stat，数据晚就绪必被发现）；小 JSON 直读不缓存（同尺寸原子替换能骗过键，且体量极小）。
 *
 * root 口径：'main' = 主数据目录；'s<k>' = <数据目录>/sites/<k>（k 取目录名原样，不硬编码槽位数）。 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  COLLABS_DIR_NAME,
  CONFIG_FILE_NAME,
  SEATS_DIR_NAME,
  SITES_DIR_NAME,
  carrierFilePath,
  collabDir,
  collabFilePath,
  departedFilePath,
  invitesFilePath,
  joinsFilePath,
  pendingInvitesFilePath,
} from '../paths.js';
import { ID_PATTERN, MAX_MESSAGE_TEXT_CHARS, POST_KINDS, isIdentityName } from '../net/protocol.js';
import { isPostEntryShape } from '../collab/posts.js';
import { foldMemberEvents, isMemberEventShape } from '../collab/members.js';
import { isLedgerShape, isTimestamp } from '../collab/model.js';
import { loadMember } from '../collab/store.js';
import { readLegacyCollab } from '../collab/legacy.js';
import { CARRIER_FORMATS } from '../collab/carrier.js';
import { loadRecovery } from '../collab/migration.js';
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
const INBOX_FILE_NAME = 'inbox.jsonl';
const OUTBOX_FILE_NAME = 'outbox.jsonl';
/* known-hosts.json 同规就地定义：known-hosts.js 的 import 面含写能力（createKnownHosts），只读层
 * 不引其符号；漂移由测试兜底（夹具以该模块导出的 KNOWN_HOSTS_FILE_NAME 规范常量建立）。 */
const KNOWN_HOSTS_FILE_NAME = 'known-hosts.json';
/* 0.2.0 本地文件形态（设计 §6.2/§10）：路径常量与文件名取自 paths.js 的唯一权威；旧形态判定
 * 与摘要由 legacy 只读读取器的 readLegacyCollab 单点提供（本层不自建旧形态判据）。
 * 清单精确覆盖本层实际读取的只读文件面：不在读取路径上的候选（handover-offers.json、
 * run/core-stop.json）不进清单，避免「声明保留但永不读取」的漂移；instance-id 用于把本机
 * 实例从讨论远端成员里排除。 */
/* seats/ 是目录；其余为协作目录或数据根内的文件。sessions/<sessionId>.json 是状态栏的派生
 * 指示面，由状态栏读取端消费，本层不读。 */
export const READ_FILE_NAMES = Object.freeze([
  'config.json',
  'instance-id',
  'posts.jsonl',
  'members.jsonl',
  'inbox.jsonl',
  'outbox.jsonl',
  'counter.json',
  'ledger.jsonl',
  'snapshot.json',
  'carrier.json',
  'seats',
  'invites.json',
  'pending-invites.json',
  'joins.json',
  'departed.jsonl',
  'known-hosts.json',
  'recovery.json',
  'member.json',
  'migration.json',
]);

/* 席位文件形态版本：与运行时落盘形态一致（观察窗与运行时不得各判一套，差异由静态一致性
 * 用例锁定）。 */
const SEAT_FILE_VERSION = 1;
/* 机器实例标识文件名（数据根下）：本层只读，不触发创建；名字与 instance-id 模块的常量由
 * 测试锁定。 */
const INSTANCE_ID_FILE_NAME = 'instance-id';

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

/* 坏 JSON 必须留痕（坏 carrier/recovery 不得静默按「无标记」处理）；观察窗轮询密集，
 * 同一文件只告警一次，避免刷屏。 */
function warnOnce(state, warnedSet, key, message, fields) {
  if (warnedSet.has(key)) {
    return;
  }
  warnedSet.add(key);
  state.log?.warn?.(message, fields);
}

/* carrier 的 JSON 解析：缺失合法（未创建）；解析失败留痕后按缺失降级——坏 carrier 与
 * legacy 读取器的「无合规 format」判据一致，不在这里造第二套形态判定。 */
function readCarrierJson(state, file) {
  const text = readTextOrNull(state, file);
  if (text === null) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    warnOnce(state, state.carrierWarned, file, '查看器 carrier JSON 解析失败（按缺失处理）', { file });
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

/* —— 小 JSON 取数（carrier/snapshot/counter/config/席位/邀请）—— */

/* 台账来源三分支（设计 §5.3）：manager→ledger.jsonl 末条合法行；member→snapshot.ledger
 * （成员席位的主体数据源）；role 不可知（本机席位缺失/损坏或旧记录缺失）→ledger 优先、
 * 无则 snapshot、皆无=未就绪。rows 供迁移行推导——末条即现态，快照分支只有单条（成员席位
 * 无迁移行）。 */
function ledgerSourceOf(state, base, collabId, role) {
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

/* —— 会话席位视图（设计 §10：本机会员席位 / 远端成员 / 离席历史）—— */

/* 非空文本字段（展示用名）：缺失/空串＝无值（省略字段，呈现端回退别的标识）。 */
function textFieldOf(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

/* 目录形态标记（设计 §6.2/§8）：carrier 是新形态标记；recovery 是半写目录标记。旧形态判定
 * 与只读摘要一律走 legacy 只读读取器的 readLegacyCollab（单点判据，本层不重复实现）。 */
function carrierOf(state, base, collabId) {
  const parsed = readCarrierJson(state, carrierFilePath(base, collabId));
  /* 只有合规 format 标记才按新形态处理；半写/异形 carrier 与 legacy 只读读取器的判据保持一致
   * （readLegacyCollab 只看 format 标记），避免 meta 与 sessions 各说一套。 */
  return isPlainObject(parsed) && CARRIER_FORMATS.includes(parsed.format) ? parsed : null;
}

/* 坏标记（解析失败/形态不符/读故障）比「无标记」更值得告警：写门会按损坏处理，观察窗
 * 至少不得静默当作普通协作。记录仍按无标记降级（本层不重复实现写门判定）。 */
function recoveryOf(state, base, collabId) {
  const loaded = loadRecovery(collabDir(base, collabId));
  if (loaded.status === 'corrupt' || loaded.status === 'unreadable') {
    warnOnce(state, state.recoveryWarned, collabId, '查看器恢复标记不可用（按无标记降级）', {
      collabId,
      status: loaded.status,
      reason: loaded.error?.message ?? null,
    });
    return null;
  }
  return loaded.record;
}

/* legacy 只读摘要（旧 member.json 档案，含已迁移归档）：非旧形态目录返回 null；本层只消费摘要，
 * 不自行判断旧形态，也不做任何旧台账改写。读取器异常按「非 legacy」降级，单目录故障不得
 * 把整页列表打成 500。 */
function legacySummaryOf(state, base, collabId) {
  try {
    const summary = readLegacyCollab(collabDir(base, collabId));
    logLegacyWarnings(state, collabId, summary);
    return summary;
  } catch (error) {
    state.log?.warn?.('查看器旧协作读取失败（按非旧形态降级）', { collabId, reason: error?.message });
    return null;
  }
}

function logLegacyWarnings(state, collabId, summary) {
  if (summary === null || !Array.isArray(summary.warnings) || summary.warnings.length === 0) {
    return;
  }
  if (state.legacyWarned.has(collabId)) {
    return;
  }
  state.legacyWarned.add(collabId);
  for (const warning of summary.warnings) {
    state.log?.warn?.('查看器旧协作读取告警（只读降级）', { collabId, warning });
  }
}

/* 本机席位（设计 §1.2）：运行时席位接口 listLocalSeats 优先；观察窗独立进程未注入时回退
 * seats/<sessionId>.json。两来源同一视图形态；席位文件逐条校验、坏条跳过（不清洗不删除）。 */
function localSeatsOf(state, base, collabId) {
  const injected = injectedSeatsOf(state, collabId);
  const files = injected === null ? readSeatFiles(state, base, collabId) : { seats: injected, corrupt: 0 };
  const localName = identityNameOf(state, base);
  return {
    seats: files.seats.map((seat) => ({ identityName: localName, ...seat })).sort(compareSeatViews),
    corrupt: files.corrupt,
  };
}

function injectedSeatsOf(state, collabId) {
  if (typeof state.listLocalSeats !== 'function') {
    return null;
  }
  try {
    const seats = state.listLocalSeats(collabId);
    if (Array.isArray(seats)) {
      return seats.map((seat) => seatViewOf(seat)).filter((seat) => seat !== null);
    }
  } catch (error) {
    state.log?.warn?.('查看器本机席位读取失败（回退席位文件）', { collabId, reason: error?.message });
    return null;
  }
  state.log?.warn?.('查看器本机席位形态不符（回退席位文件）', { collabId });
  return null;
}

function readSeatFiles(state, base, collabId) {
  const dir = join(collabDir(base, collabId), SEATS_DIR_NAME);
  const dirents = dirEntriesOrNull(state, dir);
  if (dirents === null) {
    return { seats: [], corrupt: 0 };
  }
  const seats = [];
  let corrupt = 0;
  for (const entry of dirents) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }
    const sessionId = entry.name.slice(0, -'.json'.length);
    if (!ID_PATTERN.test(sessionId)) {
      corrupt++;
      warnSeatCorrupt(state, collabId, join(dir, entry.name));
      continue;
    }
    const file = join(dir, entry.name);
    const record = readJsonOrNull(state, file);
    const seat = isSeatFileShape(record, sessionId) ? seatViewOf(record) : null;
    if (seat === null) {
      corrupt++;
      warnSeatCorrupt(state, collabId, file);
      continue;
    }
    seats.push(seat);
  }
  return { seats, corrupt };
}

/* 席位文件形态与运行时落盘判据逐项对齐（版本精确、会话标识必填且与文件名一致、member 状态
 * 必须能回答 joinSeq/joinedAt）：观察窗显示而运行时判损坏的分叉由静态一致性用例锁定。 */
function isSeatFileShape(record, expectedSessionId) {
  if (!isPlainObject(record) || record.version !== SEAT_FILE_VERSION || record.sessionId !== expectedSessionId) {
    return false;
  }
  if (!isSeatRole(record.role) || !isSeatState(record.state)) {
    return false;
  }
  return isSeatMemberComplete(record) && isSeatOptionalFieldsShape(record);
}

/* 已入席席位必须有入席序号与时刻；joining 阶段二者可缺省。 */
function isSeatMemberComplete(record) {
  return record.state !== 'member' || (isSeatSeq(record.joinSeq) && isTimestamp(record.joinedAt));
}

function isSeatOptionalFieldsShape(record) {
  return isOptionalSeatSeq(record.joinSeq)
    && isOptionalSeatSeq(record.grantVersion)
    && isOptionalTimestamp(record.joinedAt)
    && isOptionalTimestamp(record.archivedAt)
    && isOptionalBoolean(record.muted)
    && isOptionalBoolean(record.unverified)
    && isOptionalJoinId(record.joinId);
}

function isOptionalTimestamp(value) {
  return value === undefined || isTimestamp(value);
}

function isOptionalBoolean(value) {
  return value === undefined || typeof value === 'boolean';
}

function isOptionalJoinId(value) {
  return value === undefined || (typeof value === 'string' && ID_PATTERN.test(value));
}

function isOptionalSeatSeq(value) {
  return value === undefined || isSeatSeq(value);
}

function isSeatSeq(value) {
  return Number.isInteger(value) && value >= 1;
}

function warnSeatCorrupt(state, collabId, file) {
  if (state.seatWarned.has(file)) {
    return;
  }
  state.seatWarned.add(file);
  state.log?.warn?.('查看器席位文件损坏（按不存在处理）', { collabId, file });
}

/* 席位视图：会话标识短码＋角色＋状态＋入席序号。文件来源已由 isSeatFileShape 校验
 * （会话标识与文件名一致）；注入来源按运行时契约再验一次标识形态。 */
function seatViewOf(seat) {
  if (!isPlainObject(seat) || !isSeatRole(seat.role) || !isSeatState(seat.state)) {
    return null;
  }
  const sessionId = textFieldOf(seat.sessionId);
  if (sessionId === null || !ID_PATTERN.test(sessionId)) {
    return null;
  }
  const view = { sessionId: shortSessionId(sessionId), role: seat.role, state: seat.state, muted: seat.muted === true };
  if (isSeatSeq(seat.joinSeq)) {
    view.joinSeq = seat.joinSeq;
  }
  if (seat.unverified === true) {
    view.unverified = true;
  }
  return view;
}

function isSeatRole(role) {
  return role === 'manager' || role === 'member';
}

function isSeatState(state) {
  return state === 'member' || state === 'joining';
}

function compareSeatViews(left, right) {
  const leftSeq = Number.isInteger(left.joinSeq) ? left.joinSeq : Number.MAX_SAFE_INTEGER;
  const rightSeq = Number.isInteger(right.joinSeq) ? right.joinSeq : Number.MAX_SAFE_INTEGER;
  if (leftSeq !== rightSeq) {
    return leftSeq - rightSeq;
  }
  const leftKey = left.sessionId ?? left.instanceId ?? '';
  const rightKey = right.sessionId ?? right.instanceId ?? '';
  if (leftKey === rightKey) {
    return 0;
  }
  return leftKey < rightKey ? -1 : 1;
}

/* 角色取本机席位（状态栏与观察窗同口径）；本机无席位时回退旧 member.json 缓存。 */
function roleOf(member, localSeats) {
  if (localSeats.some((seat) => seat.role === 'manager')) {
    return 'manager';
  }
  if (localSeats.length > 0) {
    return 'member';
  }
  return member === null ? null : member.role;
}

/* 远端成员＝共享名单中不属于本机席位的行（按会话标识比较；旧名单无 sessionId 时按本机实例
 * 过滤站长机自己的行）。字段均来自共享台账/快照，不落本机席位文件。 */
function remoteSeatsOf(ledger, localSeats, localInstanceId) {
  if (ledger === null || !Array.isArray(ledger.members)) {
    return [];
  }
  const localSessionIds = new Set(localSeats.map((seat) => seat.sessionId));
  const remote = [];
  for (const member of ledger.members) {
    const view = remoteSeatViewOf(member, localSessionIds, localInstanceId);
    if (view !== null) {
      remote.push(view);
    }
  }
  return remote.sort(compareSeatViews);
}

function remoteSeatViewOf(member, localSessionIds, localInstanceId) {
  if (!isRemoteSeatCandidate(member, localSessionIds, localInstanceId)) {
    return null;
  }
  const sessionId = textFieldOf(member.sessionId);
  const view = { instanceId: member.instanceId };
  const name = textFieldOf(member.identityName);
  if (name !== null) {
    view.identityName = name;
  }
  if (sessionId !== null && ID_PATTERN.test(sessionId)) {
    view.sessionId = shortSessionId(sessionId);
  }
  view.role = member.role;
  view.state = member.state;
  if (Number.isInteger(member.joinSeq) && member.joinSeq > 0) {
    view.joinSeq = member.joinSeq;
  }
  return view;
}

function isRemoteSeatCandidate(member, localSessionIds, localInstanceId) {
  if (!isPlainObject(member) || !isSeatRole(member.role) || typeof member.state !== 'string') {
    return false;
  }
  if (localInstanceId !== null && member.instanceId === localInstanceId) {
    return false;
  }
  const sessionId = textFieldOf(member.sessionId);
  return sessionId === null || !localSessionIds.has(shortSessionId(sessionId));
}

/* 本机实例标识：数据根 instance-id 是权威（观察窗独立进程也能读）；缺失时退回旧参与记录里的
 * 站长实例（仅站长机可推导）。两边都没有＝无法按实例排除本机行，只能按会话短码排除。 */
function localInstanceIdOf(state, base, member) {
  const fromFile = instanceIdOfRoot(state, base);
  if (fromFile !== null) {
    return fromFile;
  }
  if (member === null || member.role !== 'manager') {
    return null;
  }
  const manager = member.manager;
  return isPlainObject(manager) && hasInstanceId(manager) ? manager.instanceId : null;
}

function instanceIdOfRoot(state, base) {
  const text = readTextOrNull(state, join(base, INSTANCE_ID_FILE_NAME));
  if (text === null) {
    return null;
  }
  const instanceId = text.trim();
  return ID_PATTERN.test(instanceId) ? instanceId : null;
}

/* 旧协作的成员视图取自 legacy 摘要 roster（旧台账/快照的名单，或旧 member.json 的定格名单）：
 * 字段缺失时只呈现机器与短码，不伪造角色/状态。 */
function legacyRosterSeatsOf(legacy, localSeats, localInstanceId) {
  const localSessionIds = new Set(localSeats.map((seat) => seat.sessionId));
  const remote = [];
  for (const entry of Array.isArray(legacy.roster) ? legacy.roster : []) {
    const view = legacyRosterSeatViewOf(entry, localSessionIds, localInstanceId);
    if (view !== null) {
      remote.push(view);
    }
  }
  return remote.sort(compareSeatViews);
}

function legacyRosterSeatViewOf(entry, localSessionIds, localInstanceId) {
  if (!isLegacyRosterCandidate(entry, localSessionIds, localInstanceId)) {
    return null;
  }
  const sessionId = textFieldOf(entry.sessionId);
  const view = { instanceId: entry.instanceId };
  const name = textFieldOf(entry.identityName);
  if (name !== null) {
    view.identityName = name;
  }
  if (sessionId !== null && ID_PATTERN.test(sessionId)) {
    view.sessionId = shortSessionId(sessionId);
  }
  if (isSeatRole(entry.role)) {
    view.role = entry.role;
  }
  if (typeof entry.state === 'string' && entry.state !== '') {
    view.state = entry.state;
  }
  return view;
}

function isLegacyRosterCandidate(entry, localSessionIds, localInstanceId) {
  if (!isPlainObject(entry) || !hasInstanceId(entry)) {
    return false;
  }
  if (localInstanceId !== null && entry.instanceId === localInstanceId) {
    return false;
  }
  const sessionId = textFieldOf(entry.sessionId);
  return sessionId === null || !localSessionIds.has(shortSessionId(sessionId));
}

/* 讨论的远端成员取自成员事件折叠（forum 无共享台账）：按席位键取每个键的最新事件，
 * 只有最新仍是 join 者才在席——leave 之后不得残留，也不得只看最新 join。
 * 生产事件只写 instanceId（一台机器一个会话），事件若携 sessionId 则按会话分席。
 * 本机实例按数据根 instance-id 排除（本机会话已在本机席位段，不能重复计入远端）；
 * 事件携会话标识时再按短码排除一次。讨论人数与本折叠同源。 */
function forumActiveMemberEventsOf(state, base, collabId) {
  const members = readParsedFile(state, collabFilePath(base, collabId, MEMBERS_FILE_NAME), classifyMemberLine);
  return members === null ? [] : foldForumMemberEvents(dedupeMemberEvents(members.rows));
}

function foldForumMemberEvents(events) {
  const latest = new Map();
  for (const event of events) {
    const key = forumSeatKeyOf(event);
    const held = latest.get(key);
    if (held === undefined || compareMemberEvents(event, held) > 0) {
      latest.set(key, event);
    }
  }
  const active = [];
  for (const event of latest.values()) {
    if (event.kind === 'join') {
      active.push(event);
    }
  }
  return active;
}

function forumSeatKeyOf(event) {
  const sessionId = textFieldOf(event.sessionId);
  return sessionId === null ? event.instanceId : `${event.instanceId}/${sessionId}`;
}

function forumRemoteSeatsOf(state, base, collabId, localSeats, localInstanceId) {
  const localSessionIds = new Set(localSeats.map((seat) => seat.sessionId));
  const remote = [];
  for (const event of forumActiveMemberEventsOf(state, base, collabId)) {
    if (localInstanceId !== null && event.instanceId === localInstanceId) {
      continue;
    }
    const view = forumRemoteSeatViewOf(event, localSessionIds);
    if (view !== null) {
      remote.push(view);
    }
  }
  return remote.sort(compareSeatViews);
}

function compareMemberEvents(left, right) {
  const byTime = Date.parse(left.ts) - Date.parse(right.ts);
  if (byTime !== 0) {
    return byTime;
  }
  if (left.eventId === right.eventId) {
    return 0;
  }
  return left.eventId < right.eventId ? -1 : 1;
}

function forumRemoteSeatViewOf(event, localSessionIds) {
  const sessionId = textFieldOf(event.sessionId);
  if (sessionId !== null && localSessionIds.has(shortSessionId(sessionId))) {
    return null;
  }
  const view = { instanceId: event.instanceId, role: 'member', state: 'member' };
  const name = textFieldOf(event.identityName);
  if (name !== null) {
    view.identityName = name;
  }
  if (sessionId !== null && ID_PATTERN.test(sessionId)) {
    view.sessionId = shortSessionId(sessionId);
  }
  return view;
}

/* 离席历史（本地派生索引，权威在共享台账事件）：字段照 §6.2；机器名先取条目自带、再取发现清单
 * 的最近见过名（与单点兜底清单的择新口径同源）。 */
function departedOf(state, base, collabId, names) {
  const parsed = readParsedFile(state, departedFilePath(base, collabId), classifyDepartedLine);
  return parsed === null ? [] : parsed.rows.map((row) => departedViewOf(row, names));
}

function classifyDepartedLine(parsed) {
  if (!isPlainObject(parsed) || !hasInstanceId(parsed)) {
    return { skip: true };
  }
  if (parsed.sessionId !== undefined && !(typeof parsed.sessionId === 'string' && ID_PATTERN.test(parsed.sessionId))) {
    return { skip: true };
  }
  if (parsed.reason !== undefined && typeof parsed.reason !== 'string') {
    return { skip: true };
  }
  if (parsed.at !== undefined && !isTimestamp(parsed.at)) {
    return { skip: true };
  }
  return { row: parsed };
}

function departedViewOf(row, names) {
  const view = { instanceId: row.instanceId };
  const name = textFieldOf(row.identityName) ?? names.get(row.instanceId) ?? null;
  if (name !== null) {
    view.identityName = name;
  }
  const sessionId = textFieldOf(row.sessionId);
  if (sessionId !== null) {
    view.sessionId = shortSessionId(sessionId);
  }
  if (typeof row.reason === 'string' && row.reason !== '') {
    view.reason = row.reason;
  }
  if (isTimestamp(row.at)) {
    view.at = row.at;
  }
  return view;
}

/* 待回应邀请：目标机 pending-invites.json 与站长机 invites.json 的 open 记录，按 inviteId 去重；
 * 讨论无邀请簿记（D18），不产该段。过期与否只影响记录状态，不在读取面按墙钟裁剪。 */
function pendingInvitesOf(state, base, collabId, mode, names) {
  if (mode === 'forum') {
    return [];
  }
  const byId = new Map();
  collectPendingInvites(byId, readJsonOrNull(state, pendingInvitesFilePath(base, collabId)), collabId, names, true);
  collectPendingInvites(byId, readJsonOrNull(state, invitesFilePath(base, collabId)), collabId, names, false);
  return [...byId.values()];
}

function collectPendingInvites(byId, parsed, collabId, names, withFrom) {
  if (!isPlainObject(parsed) || !Array.isArray(parsed.invites)) {
    return;
  }
  for (const invite of parsed.invites) {
    if (isOpenInviteOf(invite, collabId) && !byId.has(invite.inviteId)) {
      byId.set(invite.inviteId, pendingInviteViewOf(invite, names, withFrom));
    }
  }
}

function isOpenInviteOf(invite, collabId) {
  if (!isPlainObject(invite) || typeof invite.inviteId !== 'string' || invite.inviteId === '') {
    return false;
  }
  if (invite.state !== 'open') {
    return false;
  }
  return invite.collabId === undefined || invite.collabId === collabId;
}

function pendingInviteViewOf(invite, names, withFrom) {
  const view = { inviteId: invite.inviteId };
  const targetSessionId = textFieldOf(invite.targetSessionId);
  if (targetSessionId !== null && ID_PATTERN.test(targetSessionId)) {
    view.targetSessionId = shortSessionId(targetSessionId);
  }
  if (withFrom) {
    Object.assign(view, fromManagerFieldsOf(invite.fromManager, names));
  }
  if (isTimestamp(invite.expiresAt)) {
    view.expiresAt = invite.expiresAt;
  }
  return view;
}

function fromManagerFieldsOf(from, names) {
  if (!isPlainObject(from)) {
    return {};
  }
  const fields = {};
  if (hasInstanceId(from)) {
    fields.fromInstanceId = from.instanceId;
    const name = textFieldOf(from.identityName) ?? names.get(from.instanceId) ?? null;
    if (name !== null) {
      fields.fromName = name;
    }
  }
  const fromSessionId = textFieldOf(from.sessionId);
  if (fromSessionId !== null && ID_PATTERN.test(fromSessionId)) {
    fields.fromSessionId = shortSessionId(fromSessionId);
  }
  return fields;
}

/* 待确认入席（joins.json v1/v2 共用 pendingJoins）：只作展示计数，不参与准入门。 */
function pendingJoinsOf(state, base, collabId, mode) {
  if (mode === 'forum') {
    return [];
  }
  const parsed = readJsonOrNull(state, joinsFilePath(base, collabId));
  if (!isPlainObject(parsed) || !Array.isArray(parsed.pendingJoins)) {
    return [];
  }
  const views = [];
  for (const join of parsed.pendingJoins) {
    if (!isPlainObject(join) || typeof join.sessionId !== 'string' || !ID_PATTERN.test(join.sessionId)) {
      continue;
    }
    const view = { sessionId: shortSessionId(join.sessionId) };
    if (isTimestamp(join.expiresAt) || Number.isInteger(join.expiresAt)) {
      view.expiresAt = join.expiresAt;
    }
    views.push(view);
  }
  return views;
}

/* 站点根 known-hosts.json 的实例名表（同实例择最近见过一条）：只用于离席历史/邀请来源的
 * 机器名补齐；缺字段的条目整条跳过，不伪造名字。 */
function knownHostNamesOf(state, base) {
  const parsed = readJsonOrNull(state, join(base, KNOWN_HOSTS_FILE_NAME));
  if (!isPlainObject(parsed) || !Array.isArray(parsed.hosts)) {
    return new Map();
  }
  const newest = new Map();
  for (const entry of parsed.hosts) {
    if (isPlainObject(entry) && hasInstanceId(entry) && textFieldOf(entry.identityName) !== null) {
      keepNewestPerInstance(newest, entry);
    }
  }
  return new Map([...newest.values()].map((held) => [held.entry.instanceId, held.entry.identityName]));
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

/* 会话席位视图（设计 §10）：三段（本机/远端/离席）＋活跃席位数＋静音聚合＋邀请/入席待办＋
 * 冻结原因；旧协作与半写目录另带只读标记。完全无数据源（空目录）＝整段省略。 */
function sessionsOf(state, base, collabId, context) {
  const { carrier, member, ledger, mode, localSeats, activeSeatCount, legacy, corruptSeatCount } = context;
  const recovery = recoveryOf(state, base, collabId);
  const names = knownHostNamesOf(state, base);
  const departed = departedOf(state, base, collabId, names);
  const pendingInvites = pendingInvitesOf(state, base, collabId, mode, names);
  const pendingJoins = pendingJoinsOf(state, base, collabId, mode);
  if (!hasSessionSource({ carrier, member, ledger, localSeats, departed, pendingInvites, pendingJoins, recovery, legacy, corruptSeatCount })) {
    return null;
  }
  const localInstanceId = localInstanceIdOf(state, base, member);
  const remoteSeats = remoteSeatsFor(mode, state, base, collabId, { ledger, localSeats, legacy, localInstanceId });
  const sessions = {
    localSeats,
    remoteSeats,
    departed,
    pendingInvites,
    pendingJoins,
    /* 活跃席位与元状态人数同源：讨论不得一边按成员事件折叠出「1 人」、一边把本机/离席者
     * 重复计入「3 席」。 */
    activeSeatCount,
    localSeatCount: localSeats.length,
    mutedSeatCount: localSeats.filter((seat) => seat.muted === true).length,
  };
  const freezeReason = freezeReasonOf(ledger, carrier);
  if (freezeReason !== null) {
    sessions.freezeReason = freezeReason;
  }
  if (corruptSeatCount > 0) {
    sessions.corruptSeatCount = corruptSeatCount;
  }
  if (legacy !== null) {
    sessions.legacy = true;
    sessions.readOnly = true;
  }
  if (recovery !== null) {
    sessions.recovery = true;
    sessions.readOnly = true;
  }
  return sessions;
}

/* 远端成员来源：旧协作取 legacy 摘要 roster；讨论取成员事件折叠；managed 取共享台账/快照。 */
function remoteSeatsFor(mode, state, base, collabId, { ledger, localSeats, legacy, localInstanceId }) {
  if (legacy !== null) {
    return legacyRosterSeatsOf(legacy, localSeats, localInstanceId);
  }
  if (mode === 'forum') {
    return forumRemoteSeatsOf(state, base, collabId, localSeats, localInstanceId);
  }
  return remoteSeatsOf(ledger, localSeats, localInstanceId);
}

/* 空目录不产席位段；任一来源在场即呈现（在场而空＝如实零/无）。 */
function hasSessionSource({ carrier, member, ledger, localSeats, departed, pendingInvites, pendingJoins, recovery, legacy, corruptSeatCount }) {
  if (carrier !== null || member !== null || ledger !== null || recovery !== null || legacy !== null) {
    return true;
  }
  return localSeats.length > 0 || departed.length > 0 || pendingInvites.length > 0 || pendingJoins.length > 0 || corruptSeatCount > 0;
}

/* 冻结原因只读共享态已有字段（台账非空值优先、carrier 兜底）；空串/null 不得遮蔽 carrier 的
 * 有效原因，解除冻结后写入方把值清空即不再显示；缺失即省略，不在观察窗自造。 */
function freezeReasonOf(ledger, carrier) {
  return nonEmptyReasonOf(ledger?.freezeReason) ?? nonEmptyReasonOf(carrier?.freezeReason);
}

function nonEmptyReasonOf(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function activeSeatCountOf(ledger) {
  if (ledger === null || !Array.isArray(ledger.members)) {
    return 0;
  }
  return ledger.members.filter((member) => isPlainObject(member) && member.state === 'member').length;
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

/* 元状态口径：新形态以 carrier 名为准、状态取共享台账；旧形态完全以 legacy 摘要为权威
 * （state 固定 completed，摘要名来自旧台账/快照/成员记录）。两者都缺＝未就绪。 */
function metaViewFor(carrier, member, ledger, legacy) {
  if (legacy !== null && carrier === null) {
    return { name: legacy.name, state: legacy.state };
  }
  if (carrier !== null) {
    return carrierMetaViewOf(carrier, member, ledger);
  }
  return metaViewOf(ledger, member);
}

/* 成员机仍然以本地参与记录显示本机视角（既有口径）；新形态目录没有 member.json，这条分支只
 * 服务于迁移残迹与夹具。已退出优先于台账态。 */
function carrierMetaViewOf(carrier, member, ledger) {
  if (member !== null && member.state === 'left') {
    return leftMetaViewOf(carrier, member);
  }
  if (member !== null && member.role === 'member') {
    return { name: member.name, state: member.state };
  }
  const name = textFieldOf(carrier.name) ?? (ledger === null ? null : ledger.name);
  const state = ledger !== null ? ledger.status : (member === null ? null : member.state);
  return { name, state };
}

function leftMetaViewOf(carrier, member) {
  const name = member.role === 'member' ? member.name : (textFieldOf(carrier.name) ?? member.name);
  return { name, state: 'left' };
}

function topicOf(carrier, ledger, member, legacy) {
  if (carrier !== null && typeof carrier.topic === 'string') {
    return carrier.topic;
  }
  if (ledger !== null) {
    return ledger.topic;
  }
  if (legacy !== null && typeof legacy.topic === 'string') {
    return legacy.topic;
  }
  return member !== null && typeof member.topic === 'string' ? member.topic : null;
}

/* 模式判定：carrier.mode 为准；旧协作取 legacy 摘要的 mode；其后再看 member.json.mode（缺 mode 按
 * managed 解释）；参与记录缺失/损坏且帖文件在时才按讨论兜底——单一权威在 model.js 的缺省口径。 */
function modeOf(carrier, member, postsPresent, legacy) {
  if (carrier !== null && isModeValue(carrier.mode)) {
    return carrier.mode;
  }
  if (legacy !== null && isModeValue(legacy.mode)) {
    return legacy.mode;
  }
  if (member !== null && member.mode !== undefined) {
    return member.mode;
  }
  if (member === null && postsPresent) {
    return 'forum';
  }
  return 'managed';
}

function isModeValue(value) {
  return value === 'managed' || value === 'forum';
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
  const carrier = carrierOf(state, base, collabId);
  const member = loadMember(base, collabId);
  const legacy = legacySummaryOf(state, base, collabId);
  const posts = readParsedFile(state, collabFilePath(base, collabId, POSTS_FILE_NAME), classifyPostLine);
  if (modeOf(carrier, member, posts !== null, legacy) === 'forum') {
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
  const carrier = carrierOf(state, base, collabId);
  const member = loadMember(base, collabId);
  const legacy = legacySummaryOf(state, base, collabId);
  const posts = readParsedFile(state, collabFilePath(base, collabId, POSTS_FILE_NAME), classifyPostLine);
  const mode = modeOf(carrier, member, posts !== null, legacy);
  const localSeatView = localSeatsOf(state, base, collabId);
  const localSeats = localSeatView.seats;
  const role = roleOf(member, localSeats);
  /* 台账来源在分支前取好一并下发（会话席位视图同取这份，不再重读）。旧协作的旧台账不经
   * 新形态校验（否则旧行会被计成坏行），其摘要、名单与状态全部由 legacy 只读读取器提供。 */
  const source = mode === 'forum' || legacy !== null
    ? { ledgerRows: [], skipped: 0 }
    : ledgerSourceOf(state, base, collabId, role);
  const meta = mode === 'forum'
    ? forumMetaOf(state, base, collabId, carrier, member, legacy, posts, after)
    : managedMetaOf(state, base, collabId, carrier, member, legacy, source, after);
  const ledger = lastOf(source.ledgerRows);
  const activeSeatCount = mode === 'forum'
    ? meta.memberCount
    : (ledger === null ? (legacy === null ? localSeats.length : legacy.memberCount) : activeSeatCountOf(ledger));
  const sessions = sessionsOf(state, base, collabId, {
    carrier, member, ledger, mode, localSeats, activeSeatCount, legacy, corruptSeatCount: localSeatView.corrupt,
  });
  return sessions === null ? meta : { ...meta, sessions };
}

/* 讨论元状态：名/态取 carrier（新形态）或 legacy 旧协作摘要/参与记录；成员数＝事件折叠；
 * 计数＝合法完整帖行数（本观察窗所见）。 */
function forumMetaOf(state, base, collabId, carrier, member, legacy, posts, after) {
  /* 旧协作的成员事件由 legacy 旧判据读取（摘要已折叠人数）；本层不再用新形态校验器解析旧事件。
   * 本层暂不展示旧事件轨，避免把旧行计成坏行。 */
  const members = legacy === null
    ? readParsedFile(state, collabFilePath(base, collabId, MEMBERS_FILE_NAME), classifyMemberLine)
    : null;
  const events = dedupeMemberEvents(members === null ? [] : members.rows);
  const view = metaViewFor(carrier, member, null, legacy);
  return {
    name: view === null ? null : view.name,
    state: view === null ? null : view.state,
    mode: 'forum',
    memberCount: legacy !== null ? legacy.memberCount : foldForumMemberEvents(events).length,
    count: posts === null ? 0 : posts.rows.length,
    topic: topicOf(carrier, null, member, legacy),
    events: anchorOf(forumEventRows(events), after),
    skipped: (members === null ? 0 : members.skipped) + (posts === null ? 0 : posts.skipped),
  };
}

/* 协作元状态：名/态取 carrier、legacy 旧协作摘要或新形态台账；人数＝台账/快照 members 名单长度
 * （成员席位下是邀请定格名单，非实时人数——如实呈现），旧协作无新形态台账时取摘要人数；
 * 计数＝累计收到（与会话流不同源：不含发出、且随文件现行内容走）。台账来源由调用方取好传入
 * （会话席位视图同取一份，台账文件不重读）。 */
function managedMetaOf(state, base, collabId, carrier, member, legacy, source, after) {
  const ledger = lastOf(source.ledgerRows);
  const view = metaViewFor(carrier, member, ledger, legacy);
  const memberCount = ledger !== null ? ledger.members.length : (legacy === null ? 0 : legacy.memberCount);
  return {
    name: view === null ? null : view.name,
    state: view === null ? null : view.state,
    mode: 'managed',
    memberCount,
    count: counterOf(state, base, collabId),
    topic: topicOf(carrier, ledger, member, legacy),
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
  return { ledger: null, memberCount: foldForumMemberEvents(events).length, count: posts === null ? 0 : posts.rows.length };
}

function managedSummaryOf(state, base, collabId, role) {
  const source = ledgerSourceOf(state, base, collabId, role);
  const ledger = lastOf(source.ledgerRows);
  return { ledger, memberCount: ledger === null ? 0 : ledger.members.length, count: counterOf(state, base, collabId) };
}

/* 旧协作摘要只取 legacy 摘要与观察面计数：不读新形态台账，避免把旧行误计为坏行。 */
function legacySummaryValue(state, base, collabId, legacy, mode, posts) {
  return {
    ledger: null,
    memberCount: legacy.memberCount,
    count: mode === 'forum' ? (posts === null ? 0 : posts.rows.length) : counterOf(state, base, collabId),
  };
}

function summarizeCollab(state, site, collabId) {
  const carrier = carrierOf(state, site.base, collabId);
  const member = loadMember(site.base, collabId);
  const legacy = legacySummaryOf(state, site.base, collabId);
  const posts = readParsedFile(state, collabFilePath(site.base, collabId, POSTS_FILE_NAME), classifyPostLine);
  const mode = modeOf(carrier, member, posts !== null, legacy);
  const localSeatView = localSeatsOf(state, site.base, collabId);
  const localSeats = localSeatView.seats;
  const role = roleOf(member, localSeats);
  const summary = legacy !== null
    ? legacySummaryValue(state, site.base, collabId, legacy, mode, posts)
    : (mode === 'forum'
      ? forumSummaryOf(state, site.base, collabId, posts)
      : managedSummaryOf(state, site.base, collabId, role));
  const view = metaViewFor(carrier, member, summary.ledger, legacy);
  const memberCount = summary.memberCount;
  const entry = {
    root: site.root,
    id: collabId,
    name: view === null ? null : view.name,
    state: view === null ? null : view.state,
    mode,
    memberCount,
    count: summary.count,
    updatedAt: updatedAtMsOf(state, site.base, collabId),
  };
  /* 会话席位视图：缺数据源则省略整段（列表行与详情成员区都据此不渲染空段）。 */
  const activeSeatCount = mode === 'forum'
    ? memberCount
    : (summary.ledger === null ? (legacy === null ? localSeats.length : legacy.memberCount) : activeSeatCountOf(summary.ledger));
  const sessions = sessionsOf(state, site.base, collabId, {
    carrier, member, ledger: summary.ledger, mode, localSeats, activeSeatCount, legacy, corruptSeatCount: localSeatView.corrupt,
  });
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
 * listLocalSeats 是运行时席位的注入点：核心进程内接线时传入，独立观察窗进程不传则
 * 回退读取 seats/<sessionId>.json——两种来源产出的视图形态一致。
 * @param {{ dataDir: string, log?: any, listLocalSeats?: ((collabId: string) => any[]) | null }} options
 *   log 仅用于读故障留痕（log?.warn）
 * @returns {{ listCollabs: () => { collabs: any[] }, readFeed: (root: string, collabId: string, after?: string | null) => any, readMeta: (root: string, collabId: string, after?: string | null) => any, stats: () => { cacheHits: number, cacheMisses: number } }}
 */
export function createViewerData({ dataDir, log, listLocalSeats = null }) {
  const state = {
    dataDir,
    log,
    listLocalSeats,
    /** @type {Map<string, { size: number, mtimeMs: number, parsed: ParsedFile }>} */
    parsedCache: new Map(),
    legacyWarned: new Set(),
    seatWarned: new Set(),
    carrierWarned: new Set(),
    recoveryWarned: new Set(),
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
