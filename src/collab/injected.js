import { appendLine, loadLines } from '../storage.js';
import { collabDir, collabFilePath, ensureDir } from '../paths.js';
import { ID_PATTERN } from '../net/protocol.js';

export const INJECTED_FILE_NAME = 'injected.jsonl';

/* 「已实际注入会话」的帖子标记集（设计 §5.7）：吸收路径的终态回执以
 * 「该帖（作者, postId）曾真的进过本会话」为前件——吸收 = 幂等去重命中的重复副本，正常情况下
 * 它此前已注入过一次、可以回报终态；但静音期到达的第一份副本会被抑制（未注入），此后的重复
 * 副本若照旧回报终态，就绕过了「未注入维持第二档 + 会话补看」的兜底（发送方以为已投达）。
 * 于是把「注入事实」从概率推断（曾见该帖）改为持久事实：注入成功时记真，回报前查真。
 * 取值为真集（只记真、只读该集合；假 = 不在集内），追加式 JSONL、随协作目录走——
 * 归档留存、清库随目录删；跨重启不丢（重启前的注入事实对重启后的重复副本仍然有效）。
 * 落盘失败只计数告警、内存态继续（与帖子 / 计数存储同一语义：写盘失败不得中断协作主链）。 */

/* 记录形态：作者实例标识 + postId（同一判据族 ID_PATTERN——与帖条目、wire 载荷同词表）。 */
export function isInjectedRecordShape(record) {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return false;
  }
  return typeof record.authorId === 'string' && ID_PATTERN.test(record.authorId)
    && typeof record.postId === 'string' && ID_PATTERN.test(record.postId);
}

/**
 * @param {{ dataDir: string, collabId: string, log: any }} options
 */
export function createInjectedStore({ dataDir, collabId, log }) {
  const state = {
    collabId,
    log,
    file: collabFilePath(dataDir, collabId, INJECTED_FILE_NAME),
    dataDir,
    keys: new Set(),
    counters: { marked: 0, corruptRecords: 0, persistFailures: 0 },
  };
  load(state);
  return {
    has: (authorId, postId) => state.keys.has(keyOf(authorId, postId)),
    mark: (authorId, postId) => mark(state, authorId, postId),
    size: () => state.keys.size,
    stats: () => ({ ...state.counters, size: state.keys.size }),
  };
}

function keyOf(authorId, postId) {
  return `${authorId}\u0000${postId}`;
}

/* 加载：逐行过形态校验，坏行计数跳过（坏数据不得让服务起不来）；重复行天然只留一份（真集去重）。 */
function load(state) {
  /** @type {{ entries: unknown[], tailDropped: boolean, corruptLines: Array<{ lineNumber: number, text: string }> } | null} */
  let loaded = null;
  try {
    loaded = loadLines(state.file);
  } catch (error) {
    state.counters.persistFailures++;
    state.log.warn('注入标记读取失败（按空集继续）', { collabId: state.collabId, reason: error.message });
  }
  if (loaded === null) {
    return;
  }
  if (loaded.tailDropped || loaded.corruptLines.length > 0) {
    state.log.warn('注入标记有残缺记录，按可解析条目载入', { collabId: state.collabId, tailDropped: loaded.tailDropped, corruptLines: loaded.corruptLines.length });
  }
  for (const record of loaded.entries) {
    if (!isInjectedRecordShape(record)) {
      state.counters.corruptRecords++;
      continue;
    }
    const { authorId, postId } = /** @type {{ authorId: string, postId: string }} */ (record);
    state.keys.add(keyOf(authorId, postId));
  }
}

/* 记真：已记过返回 false（幂等——同一帖重复注入只应记一次，正常路径也不会走到）；
 * 新记录先入内存（回报前件即时生效）再落盘（写失败内存态继续）。 */
function mark(state, authorId, postId) {
  if (!ID_PATTERN.test(authorId) || !ID_PATTERN.test(postId)) {
    state.counters.corruptRecords++;
    state.log.warn('注入标记形态不符（拒绝入集）', { collabId: state.collabId, authorId, postId });
    return false;
  }
  const key = keyOf(authorId, postId);
  if (state.keys.has(key)) {
    return false;
  }
  state.keys.add(key);
  persist(state, authorId, postId);
  return true;
}

function persist(state, authorId, postId) {
  try {
    ensureDir(collabDir(state.dataDir, state.collabId));
    appendLine(state.file, { authorId, postId });
    state.counters.marked++;
  } catch (error) {
    state.counters.persistFailures++;
    state.log.warn('注入标记写入失败（内存态继续）', { collabId: state.collabId, authorId, postId, reason: error.message });
  }
}
