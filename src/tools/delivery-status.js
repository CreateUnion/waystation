const FILTER_PARAMS = ['msgId', 'collabId'];

/* ws_delivery_status：发送侧三档投递状态查询入口（设计 §10）。
 * 语义边界：「已投进对方会话」≠「对方模型已读 / 已执行」——措辞不得暗示已被阅读。
 * 过滤参数是可选的非空字符串：其余形态一律 isError——按「不过滤」静默处理会被误读为
 * 「该标识下有这么多条记录」。 */
export function deliveryStatusTool() {
  return {
    name: 'ws_delivery_status',
    description: '查询已发消息的投递状态（已排队 / 已到对方驿站 / 已投进对方会话——「已投进会话」不等于已被阅读）',
    inputSchema: {
      type: 'object',
      properties: {
        msgId: { type: 'string', description: '按消息标识过滤（可选）' },
        collabId: { type: 'string', description: '按协作过滤（可选）' },
      },
    },
    handler: async (args, context) => {
      const invalid = FILTER_PARAMS.filter((name) => {
        const value = args[name];
        return value !== undefined && (typeof value !== 'string' || value.trim() === '');
      });
      if (invalid.length > 0) {
        return { content: [{ type: 'text', text: `参数 ${invalid.join('、')} 非法：需要非空字符串（可选参数，不传则不过滤）` }], isError: true };
      }
      const rows = context.net.deliveryStatus({ msgId: args.msgId, collabId: args.collabId });
      return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
    },
  };
}
