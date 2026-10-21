import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { collabFilePath, resolveDataDir } from '../src/paths.js';
import { ID_PATTERN } from '../src/net/protocol.js';
import { isPostEntryShape, POSTS_FILE_NAME } from '../src/collab/posts.js';
import { foldMemberEvents, isMemberEventShape, MEMBERS_FILE_NAME } from '../src/collab/members.js';
import { isLegacyLedgerRow } from '../src/collab/legacy.js';
import { isLedgerShape } from '../src/collab/model.js';
import { LEDGER_FILE_NAME, loadMember } from '../src/collab/store.js';
import { metaViewOf } from '../src/viewer/meta.js';
import { displayText } from '../src/viewer/text.js';

/* 讨论查看器（本地只读观战窗）：把一台讨论的本地数据面增量渲染成「时间戳＋正文」两栏帖流，
 * 成员与元状态变化以暗色系统行追加。独立零依赖程序——不与服务层的运行期部件发生关系
 * （不 import service / index / net），不起端口、不发网络、不注入会话；只读协作目录下的数据文件。
 *
 * 零写盘是硬契约：数据目录里的文件只读不改。存储层的 loadLines 会对半写尾行做截断修复
 * （ftruncate），因此本程序不经过它——自带的字节级尾读器只按位移读新字节，绝不以「修复」名义
 * 回写；元状态读取复用 store.js 的 loadMember（纯读），台账的「最后一条合法行」语义按
 * loadLedger 的同判据在本程序内以纯读复现（同用 isLedgerShape 校验，差别只在坏行不落盘）。
 *
 * 启动回放按文件序（= 到站序，帖落盘只有追加一条路径）如实呈现；与 ws_view_ledger 的显示序
 * （按 ts 排序）有意不同——那是台账视图的收敛序口径，观战窗要的是「这台机器先后看到了什么」。 */

const USAGE = '用法：node scripts/collab-viewer.js <讨论标识> [--author]';
const EXIT_USAGE_ERROR = 2;
/* 轮询周期：本地追加到呈现的可见延迟上限。500ms 与状态栏心跳同量级、人眼无感；
 * 每拍只是几次 stat 与小段增量读，开销相对该周期可忽略，细化周期徒增系统调用。 */
const POLL_INTERVAL_MS = 500;
const POSTS_LABEL = 'posts.jsonl';
const MEMBERS_LABEL = 'members.jsonl';
const LEDGER_LABEL = 'ledger.jsonl';
const BAD_LINE_NOTICE = '跳过一条无法解析的记录行';
const SYSTEM_PREFIX = '· ';
const COLUMN_SEPARATOR = '  ';   // 时间戳与正文之间留两空格：管道式输出下仍能看清列边界
/* 状态词表（对齐状态栏「待同意 / 冻结」的既有口径，补齐其余取值）：台账 status 与成员态共用；
 * 词表外的取值原样呈现——观战窗如实转述，不自造词。 */
const STATE_LABELS = { proposed: '待同意', active: '进行中', frozen: '冻结', completed: '已结束', terminated: '已终止', left: '已退出' };
const MEMBER_DIRECTIONS = { join: '加入', leave: '退出' };
/* 文件读取侧的每文件口径：label 用于提示行；台账文件在成员席位天然不存在（不是异常），
 * 缺席时不提示；帖与成员事件文件在启动前被建出来属正常过渡，只提示「消失后重现」。 */
const READER_INFO = {
  posts: { label: POSTS_LABEL, noticeMissing: true },
  members: { label: MEMBERS_LABEL, noticeMissing: true },
  ledger: { label: LEDGER_LABEL, noticeMissing: false },
};
/* 彩色仅在 TTY 上启用：管道 / 重定向输出裸文本（测试与日志友好）。 */
const DIM = process.stdout.isTTY === true ? '\u001b[2m' : '';
const RESET_DIM = DIM === '' ? '' : '\u001b[0m';

function writeLine(text) {
  process.stdout.write(`${text}\n`);
}

function systemLine(text) {
  writeLine(`${DIM}${SYSTEM_PREFIX}${text}${RESET_DIM}`);
}

function parseJsonOrNull(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/* 参数解析：恰好一个位置参数（讨论标识，形态与协作目录名同一判据）+ 可选 --author；
 * 未知选项 / 数量不符 / 非法标识 → null（调用方按用法错误处理——查看器是用户显式调用的程序，
 * 错误必须可见，与状态栏「故障静默空输出」是两个程序的两种契约）。 */
function parseArgs(args) {
  const positional = [];
  let withAuthor = false;
  for (const arg of args) {
    if (arg === '--author') {
      withAuthor = true;
      continue;
    }
    if (arg.startsWith('-') || !ID_PATTERN.test(arg)) {
      return null;
    }
    positional.push(arg);
  }
  if (positional.length !== 1) {
    return null;
  }
  return { collabId: positional[0], withAuthor };
}

function formatTime(ts) {
  const at = new Date(ts);
  const twoDigits = (value) => String(value).padStart(2, '0');
  return `${twoDigits(at.getHours())}:${twoDigits(at.getMinutes())}:${twoDigits(at.getSeconds())}`;
}

/* —— 字节级尾读器（零写盘的增量行读取）—— */

/* 契约：追加 → 只读位移之后的新字节，经 StringDecoder 逐段解码（UTF-8 多字节字符跨读取边界
 * 安全）；未以换行收尾的残段留在缓冲等待补齐，绝不当成行；截断（大小小于位移）→ 重置位移并由
 * 回调通知；文件消失 → 报告 missing，消失后重现无法保证连续性（位移已指不到原内容）→ 同样重置；
 * 坏行只切行不判内容，归调用方解析跳过。 */
function createLineReader(options) {
  const state = {
    file: options.file,
    onLine: options.onLine,
    onReset: options.onReset,
    offset: 0,
    decoder: new StringDecoder('utf8'),
    carry: '',
    wasMissing: false,
  };
  return { read: () => readNewBytes(state) };
}

/* 返回 'missing'（文件不在）/ 'idle'（无新字节）/ 'read'（读到新字节，含重置后的整卷重读）。 */
function readNewBytes(state) {
  const size = sizeOf(state.file);
  if (size === null) {
    state.wasMissing = true;
    return 'missing';
  }
  if (size < state.offset) {
    resetReader(state, 'truncated');
  } else if (state.wasMissing && state.offset > 0) {
    /* 缺席后重现：位移已指不到原内容，自卷首重读。位移为零 = 尚未消费过任何内容，重置是
     * 空操作——不提示，也不按「重现」处理。 */
    resetReader(state, 'restarted');
  }
  /* 文件在位即清缺席标记：它只对「已消费后消失再重现」的判定有意义，残留到首读成功之后
   * 会让下一拍误判重现、整卷重读（晚落盘的数据被重印、多出「已恢复」提示）。 */
  state.wasMissing = false;
  if (size === state.offset) {
    return 'idle';
  }
  return readRange(state, size);
}

/* 文件大小或 null（不存在 / 不可读都归「不在」——读取侧不区分故障与消失）。 */
function sizeOf(file) {
  try {
    return statSync(file).size;
  } catch {
    return null;
  }
}

function resetReader(state, reason) {
  state.offset = 0;
  state.decoder = new StringDecoder('utf8');
  state.carry = '';
  state.onReset(reason);
}

function readRange(state, size) {
  const buffer = Buffer.alloc(size - state.offset);
  let fd = null;
  try {
    fd = openSync(state.file, 'r');
    const bytesRead = readSync(fd, buffer, 0, buffer.length, state.offset);
    state.offset += bytesRead;
    emitLines(state, buffer.subarray(0, bytesRead));
  } catch {
    // 打开 / 读取失败（文件刚被移走等）：本拍放弃，下一拍按新状态重试——读取故障不终结观战窗
  } finally {
    if (fd !== null) {
      closeSync(fd);
    }
  }
  return 'read';
}

function emitLines(state, bytes) {
  const text = state.carry + state.decoder.write(bytes);
  const lines = text.split('\n');
  state.carry = lines.pop() ?? '';
  for (const line of lines) {
    if (line.trim() !== '') {
      state.onLine(line);
    }
  }
}

/* —— 呈现 —— */

function stateLabelOf(state) {
  return STATE_LABELS[state] ?? String(state);
}

/* 成员数：当前成员表长度——复用成员存储的折叠语义（单一权威），查看器不重实现折叠规则。 */
function memberCountOf(view) {
  return foldMemberEvents([...view.members.values()]).length;
}

function bannerOf(view) {
  if (view.meta === null) {
    return `【数据未就绪】${view.collabId} ｜ 成员未知`;
  }
  const size = view.seen.has('members') ? `${memberCountOf(view)} 人` : '成员未知';
  return `【${view.meta.name}】${stateLabelOf(view.meta.state)} ｜ ${size}`;
}

/* —— 数据行处理 —— */

function onPostLine(view, line) {
  const entry = parseJsonOrNull(line);
  if (!isPostEntryShape(entry)) {
    systemLine(BAD_LINE_NOTICE);
    return;
  }
  const columns = [formatTime(entry.ts)];
  if (view.withAuthor) {
    columns.push(entry.from.identityName);
  }
  columns.push(displayText(entry.text, { newlines: 'marker' }));
  writeLine(columns.join(COLUMN_SEPARATOR));
}

/* 成员事件入列：事件 id 去重（重放天然幂等，重复副本静默吸收）。 */
function absorbMemberEvent(view, event) {
  if (!isMemberEventShape(event)) {
    return 'rejected';
  }
  if (view.members.has(event.eventId)) {
    return 'duplicate';
  }
  view.members.set(event.eventId, event);
  return 'added';
}

/* 成员事件行：基线重放（启动 / 回卷重读）只重建折叠态、不印成员行；增量事件印一行系统行
 * （身份名 + 方向 + 现人数）——成员事件绝不产生帖行。坏行留痕不设重放静默：跳过记录在
 * 回放期与增量期一律留痕（与帖流同一提示）。 */
function onMemberLine(view, line) {
  const event = parseJsonOrNull(line);
  const outcome = absorbMemberEvent(view, event);
  if (outcome === 'rejected') {
    systemLine(BAD_LINE_NOTICE);
    return;
  }
  if (view.replay.has('members')) {
    return;
  }
  if (outcome === 'added') {
    systemLine(`${event.identityName} ${MEMBER_DIRECTIONS[event.kind]}（现 ${memberCountOf(view)} 人）`);
  }
}

/* 台账行：留最后一条通过形态校验的完整行（新形态按 loadLedger 同判据，0.1.x 旧形态按旧判据——
 * 新校验器 0.2.0 起要求 managerTerm/席位 sessionId，旧归档不能拿它读）；坏行跳过并留痕
 * （与帖 / 成员流同一提示，回放与增量一致——三面口径统一）。半写尾行到不了这里：
 * 尾读器缓冲至换行才算行。 */
function onLedgerLine(view, line) {
  const ledger = parseJsonOrNull(line);
  if (!isLedgerShape(ledger) && !isLegacyLedgerRow(ledger)) {
    systemLine(BAD_LINE_NOTICE);
    return;
  }
  view.ledger = ledger;
}

/* 读取器重置（截断 / 消失后重现）：数据面状态同步重置（成员表重折叠、台账重取），
 * 并印一行提示——重放本身是如实呈现，不重放才会静默丢内容。提示先于重读行（回调整在切行前触发）。 */
function onReaderReset(view, key, reason) {
  if (key === 'members') {
    view.members = new Map();
    view.replay.add('members');
  }
  if (key === 'ledger') {
    view.ledger = null;
  }
  const label = READER_INFO[key].label;
  if (reason === 'truncated') {
    systemLine(`${label} 被截断，自卷首重放`);
  } else {
    systemLine(`${label} 已恢复，自卷首重读`);
  }
}

/* —— 推进 —— */

/* 单文件推进一拍：只在「见过 → 不见」的过渡上印提示（不逐拍刷屏）；重现提示由读取器的重置回调发。
 * 本拍读毕即退出重放态——其后的追加行都是增量。 */
function advanceReader(view, key) {
  const info = READER_INFO[key];
  const outcome = view.readers[key].read();
  view.replay.delete(key);
  if (outcome === 'missing') {
    if (info.noticeMissing && view.seen.has(key) && !view.missing.has(key)) {
      view.missing.add(key);
      systemLine(`${info.label} 暂缺（等待恢复）`);
    }
    return;
  }
  view.seen.add(key);
  view.missing.delete(key);
}

/* 元状态刷新：名称 / 状态变化各印一行系统行；首次可读若发生在启动之后（数据晚就位）补一句提示。 */
function refreshMeta(view) {
  const meta = metaViewOf(view.ledger, loadMember(view.dataDir, view.collabId));
  if (meta === null) {
    return;
  }
  const previous = view.meta;
  view.meta = meta;
  if (previous === null) {
    if (view.primed) {
      systemLine(`数据已就绪：${meta.name}`);
    }
    return;
  }
  if (previous.name !== meta.name) {
    systemLine(`名称：${meta.name}`);
  }
  if (previous.state !== meta.state) {
    systemLine(`状态：${stateLabelOf(meta.state)}`);
  }
}

function tickViewer(view) {
  if (view.paused) {
    return;
  }
  advanceReader(view, 'posts');
  advanceReader(view, 'members');
  advanceReader(view, 'ledger');
  refreshMeta(view);
}

/* 启动：成员事件与台账先读为基线（不逐条回放系统行）→ 横幅一行 → 回放全部既有帖 → 转增量。 */
function primeViewer(view) {
  view.replay.add('members');
  advanceReader(view, 'members');
  advanceReader(view, 'ledger');
  refreshMeta(view);
  writeLine(bannerOf(view));
  advanceReader(view, 'posts');
  view.primed = true;
}

function togglePause(view) {
  view.paused = !view.paused;
  systemLine(view.paused ? '已暂停（按 p 恢复）' : '已恢复');
}

function createView({ dataDir, collabId, withAuthor }) {
  const view = {
    dataDir,
    collabId,
    withAuthor,
    readers: {},
    paused: false,
    primed: false,
    replay: new Set(),
    seen: new Set(),
    missing: new Set(),
    members: new Map(),
    ledger: null,
    meta: null,
    timer: null,
  };
  const files = {
    posts: collabFilePath(dataDir, collabId, POSTS_FILE_NAME),
    members: collabFilePath(dataDir, collabId, MEMBERS_FILE_NAME),
    ledger: collabFilePath(dataDir, collabId, LEDGER_FILE_NAME),
  };
  view.readers = {
    posts: createLineReader({ file: files.posts, onLine: (line) => onPostLine(view, line), onReset: (reason) => onReaderReset(view, 'posts', reason) }),
    members: createLineReader({ file: files.members, onLine: (line) => onMemberLine(view, line), onReset: (reason) => onReaderReset(view, 'members', reason) }),
    ledger: createLineReader({ file: files.ledger, onLine: (line) => onLedgerLine(view, line), onReset: (reason) => onReaderReset(view, 'ledger', reason) }),
  };
  return view;
}

/* 轮询一拍内的意外异常（未预料的坏数据形态等）不得终结整个观战窗：呈现一行错误、继续下一拍。
 * 已覆盖的故障（读失败 / 坏行 / 文件消失）在各自层内静默处理，不落到这里。 */
function startViewer(view) {
  view.timer = setInterval(() => {
    try {
      tickViewer(view);
    } catch (error) {
      systemLine(`查看器内部错误（继续轮询）：${error?.message ?? error}`);
    }
  }, POLL_INTERVAL_MS);
}

/* 正常退出（q / Ctrl+C）：还原终端原始模式后以码 0 退出（显式 process.exit——stdin 仍开着，
 * 事件循环不会自行结束）。 */
function stopViewer(view) {
  if (view.timer !== null) {
    clearInterval(view.timer);
    view.timer = null;
  }
  try {
    if (process.stdin.isTTY === true) {
      process.stdin.setRawMode(false);
    }
  } catch {
    // 终端已不可用：退出路径不因此受阻
  }
  process.exit(0);
}

/* 输入接线：TTY 走原始模式字节、管道同样监听 data 字节——p 暂停 / 恢复，q 与 Ctrl+C 退出。
 * 非交互（stdin 打不开原始模式）静默降级为纯流式：不从输入侧报错、不影响观战。 */
function attachInput(view) {
  try {
    if (process.stdin.isTTY === true) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
  } catch {
    return;
  }
  process.stdin.on('data', (chunk) => handleInputBytes(view, chunk));
  process.stdin.on('error', () => {});
  process.on('SIGINT', () => stopViewer(view));
}

function handleInputBytes(view, chunk) {
  for (const byte of chunk) {
    if (byte === 0x70) {
      togglePause(view);
    } else if (byte === 0x71 || byte === 0x03) {
      stopViewer(view);
    }
  }
}

/* 读端提前关闭（如 `| head`）时 stdout 的 EPIPE 默认冒泡为未捕获异常——观战窗按正常结束处理。 */
function onStdoutError(error) {
  if (error?.code === 'EPIPE') {
    process.exit(0);
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options === null) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = EXIT_USAGE_ERROR;
    return;
  }
  process.stdout.on('error', onStdoutError);
  const view = createView({ dataDir: resolveDataDir(process.env), collabId: options.collabId, withAuthor: options.withAuthor });
  primeViewer(view);
  startViewer(view);
  attachInput(view);
}

main();
