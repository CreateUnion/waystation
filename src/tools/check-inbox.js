import { CHECK_INBOX_DEFAULT_LIMIT, CHECK_INBOX_MAX_LIMIT } from '../net/inbound.js';
import { WS_CHECK_INBOX_SPEC } from './specs.js';

/* ws_check_inbox：会话主动查（设计 §4 的降级路径）——读取某协作的收件流水窗口
 * （「已到对方驿站」但可能未投进本会话的消息从这里取）。
 * 只读：不改变投递档位、不触发重投；返回含已投递与未投递两类（按 msgId 去重由调用方自理）。
 * collabId 必填：避免跨协作全量列举；协作标识以驿站台账/工具面为准。 */
export function checkInboxTool() {
  return {
    ...WS_CHECK_INBOX_SPEC,
    handler: async (args, context) => {
      const collabId = typeof args.collabId === 'string' ? args.collabId.trim() : '';
      if (collabId === '') {
        return { content: [{ type: 'text', text: '参数 collabId 非法：需要非空字符串' }], isError: true };
      }
      if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > CHECK_INBOX_MAX_LIMIT)) {
        return { content: [{ type: 'text', text: `参数 limit 非法：需要 1–${CHECK_INBOX_MAX_LIMIT} 的整数（可选，不传用默认 ${CHECK_INBOX_DEFAULT_LIMIT}）` }], isError: true };
      }
      /* 按本会话过滤（设计 §9）：只取投给本席位的记录；机器级治理提示仍对全本机会话可见。
       * 调用上下文没有会话标识时如实不传（服务按全本机可见面返回），不伪造。 */
      const query = { collabId, limit: args.limit ?? CHECK_INBOX_DEFAULT_LIMIT };
      if (typeof context.sessionId === 'string' && context.sessionId !== '') {
        query.sessionId = context.sessionId;
      }
      const result = context.net.checkInbox(query);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...result }, null, 2) }] };
    },
  };
}
