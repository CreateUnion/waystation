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
      /* 按本会话过滤（设计 §1.2/§9）：收件流水是逐席位的，没有会话标识就无法确定该给谁看——
       * 必须拒绝，不得退回「全本机收件」（那会把同机其他会话的消息泄露给无标识调用方）。 */
      const sessionId = typeof context.sessionId === 'string' ? context.sessionId.trim() : '';
      if (sessionId === '') {
        return { content: [{ type: 'text', text: '本会话无会话标识：ws_check_inbox 按会话过滤（设计 §1.2），无法确定收件席位——请从带会话标识的终端调用' }], isError: true };
      }
      /* 机器级治理提示（无席位指向的记录）仍由服务面按全本机会话可见处理。 */
      const query = { collabId, limit: args.limit ?? CHECK_INBOX_DEFAULT_LIMIT, sessionId };
      const result = context.net.checkInbox(query);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...result }, null, 2) }] };
    },
  };
}
