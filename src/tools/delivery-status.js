import { ID_PATTERN } from '../net/protocol.js';
import { WS_DELIVERY_STATUS_SPEC } from './specs.js';

const FILTER_PARAMS = ['msgId', 'collabId'];
/* 系统内部回报帧（第三档回执）自身也经发送队列、同样出现在查询行集里：每条送达消息因此多出
 * 一行自身回报（约 14 天可见、量级≈消息数）。回报是系统内部往返、对发送侧无信息增量——
 * 折叠为计数不逐行列出行集，字段恒在（reportRows）——「不静默」由字段 + 描述双重承载。 */
const REPORT_ROW_TYPE = 'delivery-status';

/* ws_delivery_status：发送侧三档投递状态查询入口（设计 §10）。
 * 语义边界：「已投进对方会话」≠「对方模型已读 / 已执行」——措辞不得暗示已被阅读。
 * 过滤参数是可选的非空字符串：其余形态一律 isError——按「不过滤」静默处理会被误读为
 * 「该标识下有这么多条记录」。
 * 数据面按契约走消息层：机器级行取服务面 deliveryStatusOf(msgId)（列表查询仍用栈的查询面），
 * 本机席位明细取 localSeatDeliveryOf(msgId, 本会话)——工具层不私接 outbox / inbox 结构。 */
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
      const query = { msgId: args.msgId?.trim(), collabId: args.collabId?.trim() };
      /* dispatch 没有持久投递账（纯内存、无 outbox 行）：如实给空面 + 模式标记，
       * 不落进栈查询面造出「查过但没有」的假象。 */
      if (query.collabId !== undefined && context.collab?.dispatch?.isDispatch?.(query.collabId) === true) {
        return { content: [{ type: 'text', text: JSON.stringify({
          ok: true, rows: [], reportRows: 0, dispatch: true,
          message: 'dispatch 无持久投递账（纯内存模式）',
        }, null, 2) }] };
      }
      const queried = machineRowsOf(context, query);
      const rows = queried.filter((row) => row.type !== REPORT_ROW_TYPE);
      const payload = { ok: true, rows, reportRows: queried.length - rows.length };
      const localSeat = localSeatOf(context, query.msgId);
      if (localSeat !== undefined) {
        payload.localSeat = localSeat;
      }
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    },
  };
}

/* 机器级行：按 msgId 时先走服务面的精确查询（契约的机器级状态面）；服务面未命中再回退栈的列表查询——
 * 论坛直投的短时记录不在 outbox 精确查询面里，回退保证「按 msgId 查得到」与列表口径一致。 */
function machineRowsOf(context, query) {
  if (query.msgId !== undefined) {
    const row = context.collab?.deliveryStatusOf?.(query.msgId);
    if (row !== null && row !== undefined) {
      return query.collabId === undefined || row.collabId === query.collabId ? [row] : [];
    }
  }
  return context.net.deliveryStatus(query);
}

/* 本机接收侧的逐席位明细：查询键是 (msgId, 本会话)——没有会话标识或 msgId 时无可查项。
 * 仅对精确查询（给了 msgId）返回，列表查询不逐行猜会话。 */
function localSeatOf(context, msgId) {
  const sessionId = context.sessionId;
  if (msgId === undefined || typeof sessionId !== 'string' || !ID_PATTERN.test(sessionId)) {
    return undefined;
  }
  if (typeof context.collab?.localSeatDeliveryOf !== 'function') {
    return undefined;
  }
  return context.collab.localSeatDeliveryOf(msgId, sessionId);
}
