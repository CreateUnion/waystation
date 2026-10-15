import { createClaudeCodeAdapter } from '../adapters/claude-code.js';

/* 桥的注入写面（设计 §2.2）：复用会话适配器的 deliver 写面——观察窗与失败分桶语义零变，
 * 本模块只加两件事：串行化投递（使分桶增量可准确归属到单次投递）与回执映射
 * （成功→ok；失败→适配器桶 rejected/failed/unavailable）。timeout 只属 IPC 等待层，不在此产生。 */

/**
 * @param {{ env?: Record<string, string | undefined>, log: any, settleMs?: number, connectTimeoutMs?: number }} options
 */
export function createSessionWriter(options) {
  const { env = process.env, log, settleMs, connectTimeoutMs } = options;
  const adapter = createClaudeCodeAdapter({ env, log, settleMs, connectTimeoutMs });
  const state = { chain: Promise.resolve() };
  return {
    available: () => adapter.available(),
    stats: () => adapter.stats(),
    /** 注入一段文本（核心已渲染的 push.text，桥不渲染不解析）；返回回执映射 { ok } / { ok:false, reason } */
    deliver(text) {
      const task = state.chain.then(() => mapReceipt(adapter, text));
      state.chain = task.then(noop, noop);
      return task;
    },
  };
}

function noop() {}

/* 单次投递 + 分桶归属：投递前后读计数快照，增量即本次结果的桶——
 * 串行链保证增量不被并发投递串扰；无增量（异常形态）按 failed 兜底。 */
async function mapReceipt(adapter, text) {
  const before = adapter.stats();
  const ok = await adapter.deliver(text);
  if (ok) {
    return { ok: true };
  }
  const after = adapter.stats();
  return { ok: false, reason: bucketOf(before, after) };
}

function bucketOf(before, after) {
  if (after.unavailable > before.unavailable) {
    return 'unavailable';
  }
  if (after.rejected > before.rejected) {
    return 'rejected';
  }
  return 'failed';
}
