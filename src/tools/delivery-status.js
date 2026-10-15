import { WS_DELIVERY_STATUS_SPEC } from './specs.js';

const FILTER_PARAMS = ['msgId', 'collabId'];
/* 系统内部回报帧（第三档回执）自身也经发送队列、同样出现在查询行集里：每条送达消息因此多出
 * 一行自身回报（约 14 天可见、量级≈消息数）。回报是系统内部往返、对发送侧无信息增量——
 * 折叠为计数不逐行列出行集，字段恒在（reportRows）——「不静默」由字段 + 描述双重承载。 */
const REPORT_ROW_TYPE = 'delivery-status';

/* ws_delivery_status：发送侧三档投递状态查询入口（设计 §10）。
 * 语义边界：「已投进对方会话」≠「对方模型已读 / 已执行」——措辞不得暗示已被阅读。
 * 过滤参数是可选的非空字符串：其余形态一律 isError——按「不过滤」静默处理会被误读为
 * 「该标识下有这么多条记录」。 */
export function deliveryStatusTool() {
  return {
    ...WS_DELIVERY_STATUS_SPEC,
    handler: async (args, context) => {
      const invalid = FILTER_PARAMS.filter((name) => {
        const value = args[name];
        return value !== undefined && (typeof value !== 'string' || value.trim() === '');
      });
      if (invalid.length > 0) {
        return { content: [{ type: 'text', text: `参数 ${invalid.join('、')} 非法：需要非空字符串（可选参数，不传则不过滤）` }], isError: true };
      }
      /* 校验通过的值至多带首尾空白，透传前去除：查询按标识精确比对，带空白串会被当作不存在的标识、
       * 静默返回空列表——「没匹配上」与「该标识不存在」将不可区分。 */
      const queried = context.net.deliveryStatus({ msgId: args.msgId?.trim(), collabId: args.collabId?.trim() });
      const rows = queried.filter((row) => row.type !== REPORT_ROW_TYPE);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, rows, reportRows: queried.length - rows.length }, null, 2) }] };
    },
  };
}
