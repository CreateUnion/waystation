import { randomUUID } from 'node:crypto';
import { POST_KINDS, ID_PATTERN, MAX_MESSAGE_TEXT_CHARS, isIdentityName } from '../net/protocol.js';
import { appendLine, loadLines } from '../storage.js';
import { collabDir, collabFilePath, ensureDir } from '../paths.js';

export const POSTS_FILE_NAME = 'posts.jsonl';

/* 讨论模式的本地帖子列表（设计 §5.2「帖子落本地列表」、§4「人人全量副本」）：
 * 追加写 JSONL、条目不可变（帖只追加、不修改不删除）；内存态 = Map，键为
 * 「作者实例标识 + postId」——合并/去重键的落点（同一帖经重复路径到达只留一份）。
 * 条目形态复用看板条目的结构（entryId / ts / from / kind / text），另带 seq（作者内单调序号，
 * 随帖携带）——周期对表的作者粒度摘要消费「已见序号集」，故序号必须随条目留存。
 * entryId = 载荷 postId 原样采用（接收端不得本地重编——它是该帖在全部副本中的稳定标识；
 * 设计允许本地条目 id 另编，此处取同值以省一份冗余字段）。 */

/* 帖条目形态校验（加载路径与追加路径共用）：字段完整性 / 类型 / 长度边界，
 * 与协议层帖载荷同一判据族（kind 词表在此同样要求——落盘内容是本机长期数据面）。 */
export function isPostEntryShape(entry) {
  if (!isPlainObject(entry)) {
    return false;
  }
  if (!isPostHeadShape(entry)) {
    return false;
  }
  if (!isPostFromShape(entry.from)) {
    return false;
  }
  if (typeof entry.kind !== 'string' || !POST_KINDS.includes(entry.kind)) {
    return false;
  }
  return typeof entry.text === 'string' && entry.text.trim() !== '' && entry.text.length <= MAX_MESSAGE_TEXT_CHARS;
}

function isPostHeadShape(entry) {
  if (typeof entry.entryId !== 'string' || !ID_PATTERN.test(entry.entryId)) {
    return false;
  }
  if (!Number.isInteger(entry.seq) || entry.seq < 1) {
    return false;
  }
  return typeof entry.ts === 'string' && entry.ts.length <= 40 && !Number.isNaN(Date.parse(entry.ts));
}

function isPostFromShape(from) {
  return isPlainObject(from) && typeof from.instanceId === 'string' && ID_PATTERN.test(from.instanceId) && isIdentityName(from.identityName);
}

/* 帖身份生成（与 msgId 同为 UUID 形态；语义独立成名——postId 跨副本稳定、不参与传输层去重）。 */
export function newPostId() {
  return randomUUID();
}

/* 显示序（设计 §5.2）：按 ts 排序、同刻（同 ts）按 postId 序兜底——跨作者仅近似序、
 * 各副本对同一帖子集合产出同一顺序（收敛序）。作者内 ts 落盘强制单调，故 ts 序即作者内序号序。 */
export function displayOrderOf(entries) {
  return [...entries].sort(comparePosts);
}

function comparePosts(left, right) {
  const byTs = Date.parse(left.ts) - Date.parse(right.ts);
  if (byTs !== 0) {
    return byTs;
  }
  if (left.entryId === right.entryId) {
    return 0;
  }
  return left.entryId < right.entryId ? -1 : 1;
}

/* 本地帖子列表（每协作一份）：加载即投影为内存 Map；追加 = 去重 → 内存入列 → 落盘。
 * 落盘失败只计数告警、内存态继续（与成员记录写盘同一语义：写盘失败不得中断协作主链），
 * 但去重以内存态为准——重复副本绝不二次入列与二次落盘。 */
export function createPostsStore({ dataDir, collabId, log }) {
  const state = {
    collabId,
    log,
    file: collabFilePath(dataDir, collabId, POSTS_FILE_NAME),
    dataDir,
    entries: new Map(),
    counters: { appended: 0, corruptRecords: 0, persistFailures: 0 },
  };
  load(state);
  return {
    has: (authorId, entryId) => state.entries.has(keyOf(authorId, entryId)),
    append: (entry) => append(state, entry),
    entries: () => [...state.entries.values()],
    ownBaseline: (authorId) => ownBaselineOf(state, authorId),
    size: () => state.entries.size,
    stats: () => ({ ...state.counters, size: state.entries.size }),
  };
}

function keyOf(authorId, entryId) {
  return `${authorId}\u0000${entryId}`;
}

/* 加载：逐行过形态校验，坏行计数跳过（坏数据不得让服务起不来）；同键重复行只留先到者
 * （条目不可变——同一帖的重复行内容等价，先到者即可）。 */
function load(state) {
  /** @type {{ entries: unknown[], tailDropped: boolean, corruptLines: Array<{ lineNumber: number, text: string }> } | null} */
  let loaded = null;
  try {
    loaded = loadLines(state.file);
  } catch (error) {
    state.counters.persistFailures++;
    state.log.warn('帖子列表读取失败（按空列表继续）', { collabId: state.collabId, reason: error.message });
  }
  if (loaded === null) {
    return;
  }
  if (loaded.tailDropped || loaded.corruptLines.length > 0) {
    state.log.warn('帖子列表有残缺记录，按可解析条目载入', { collabId: state.collabId, tailDropped: loaded.tailDropped, corruptLines: loaded.corruptLines.length });
  }
  for (const record of loaded.entries) {
    if (!isPostEntryShape(record)) {
      state.counters.corruptRecords++;
      continue;
    }
    const entry = /** @type {{ entryId: string, from: { instanceId: string } }} */ (record);
    const key = keyOf(entry.from.instanceId, entry.entryId);
    if (!state.entries.has(key)) {
      state.entries.set(key, record);
    }
  }
}

/* 追加：重复（同作者 + postId）返回 false；新条目先入内存再落盘（写失败内存态继续）。 */
function append(state, entry) {
  if (!isPostEntryShape(entry)) {
    state.counters.corruptRecords++;
    state.log.warn('帖条目形态不符（拒绝入列）', { collabId: state.collabId, entryId: entry?.entryId });
    return false;
  }
  const key = keyOf(entry.from.instanceId, entry.entryId);
  if (state.entries.has(key)) {
    return false;
  }
  state.entries.set(key, entry);
  persist(state, entry);
  return true;
}

function persist(state, entry) {
  try {
    ensureDir(collabDir(state.dataDir, state.collabId));
    appendLine(state.file, entry);
    state.counters.appended++;
  } catch (error) {
    state.counters.persistFailures++;
    state.log.warn('帖子列表写入失败（内存态继续）', { collabId: state.collabId, entryId: entry.entryId, reason: error.message });
  }
}

/* 作者基线（发帖时的序号与 ts 分配依据）：该作者已入列的帖中取最大序号与最大 ts；
 * 无该作者的帖 = 空基线（首帖从 1 起、ts 取当前时刻）。 */
function ownBaselineOf(state, authorId) {
  let seq = null;
  let ts = null;
  let tsMs = Number.NEGATIVE_INFINITY;
  for (const entry of state.entries.values()) {
    if (entry.from.instanceId !== authorId) {
      continue;
    }
    if (seq === null || entry.seq > seq) {
      seq = entry.seq;
    }
    const entryMs = Date.parse(entry.ts);
    if (entryMs > tsMs) {
      tsMs = entryMs;
      ts = entry.ts;
    }
  }
  return { seq, ts };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
