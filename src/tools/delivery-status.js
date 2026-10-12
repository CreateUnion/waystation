/* ws_delivery_status：发送侧三档投递状态查询入口（设计 §10）。
 * 语义边界：「已投进对方会话」≠「对方模型已读 / 已执行」——措辞不得暗示已被阅读。 */
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
      const rows = context.net.deliveryStatus({ msgId: args.msgId, collabId: args.collabId });
      return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
    },
  };
}
