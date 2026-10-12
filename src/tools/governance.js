import { ID_PATTERN } from '../net/protocol.js';
import { collabIdArg, errorResult, resultOf, trimmedString } from './collab.js';

/* 治理工具集（设计 §10 工具最小集的治理落点）：裁定 / 移交 / 抢接——薄层，只做参数形态校验
 * （业务判定在协作服务，服务的 { ok:false, message } 映射为 isError）；三工具同域共置一个文件。 */

export function decideTool() {
  return {
    name: 'ws_decide',
    description: '裁定（管理席位）：冻结中三选一——merge（合并；建议发起更早者任管理者，名单并集、新增成员走同意门）/ keep（保持两条，需明示）/ terminate（终止本方一条）；合流递交裁定用 mergeOffer=accept|reject',
    inputSchema: {
      type: 'object',
      properties: {
        collabId: { type: 'string', description: '协作标识（取自 ws_list_collabs）' },
        choice: { type: 'string', enum: ['merge', 'keep', 'terminate'], description: '冻结裁定：合并 / 保持两条 / 终止' },
        mergeOffer: { type: 'string', enum: ['accept', 'reject'], description: '合流递交裁定：采纳看板增量 / 丢弃' },
      },
      required: ['collabId'],
    },
    handler: async (args, context) => {
      const collabId = collabIdArg(args);
      if (collabId === null) {
        return errorResult('参数 collabId 非法：需要非空白字符串');
      }
      if (args.mergeOffer !== undefined) {
        return decideMergeOfferCall(args, collabId, context);
      }
      if (args.choice !== 'merge' && args.choice !== 'keep' && args.choice !== 'terminate') {
        return errorResult('参数非法：需恰提供一种形态——choice（冻结裁定：merge / keep / terminate）或 mergeOffer（合流递交裁定：accept / reject）');
      }
      return resultOf(await context.collab.decide({ collabId, choice: args.choice }));
    },
  };
}

function decideMergeOfferCall(args, collabId, context) {
  if (args.choice !== undefined) {
    return errorResult('参数非法：choice 与 mergeOffer 只能提供一种');
  }
  if (args.mergeOffer !== 'accept' && args.mergeOffer !== 'reject') {
    return errorResult('参数 mergeOffer 非法：可选值为 accept / reject');
  }
  return resultOf(context.collab.decideMerge({ collabId, mergeOffer: args.mergeOffer }));
}

export function handoverTool() {
  return {
    name: 'ws_handover',
    description: '显式交接（管理席位）：把驿丞席位移交给在线成员（先确认后删除——对方校验并回执后本机才清理台账）；目标离线会被拒绝（应急走 ws_take_over 抢接）',
    inputSchema: {
      type: 'object',
      properties: {
        collabId: { type: 'string', description: '协作标识' },
        target: { type: 'string', description: '目标成员实例标识（取自 ws_view_ledger 名单）' },
      },
      required: ['collabId', 'target'],
    },
    handler: async (args, context) => {
      const collabId = collabIdArg(args);
      if (collabId === null) {
        return errorResult('参数 collabId 非法：需要非空白字符串');
      }
      const target = trimmedString(args, 'target');
      if (target === '' || !ID_PATTERN.test(target)) {
        return errorResult('参数 target 非法：需要成员的实例标识（1–64 位字母数字与连字符）');
      }
      return resultOf(await context.collab.handover({ collabId, target }));
    },
  };
}

export function takeOverTool() {
  return {
    name: 'ws_take_over',
    description: '抢接（成员侧，管理者被判失联后）：缺省发起——广播收集窗口（默认 30s）并持续探测原驿丞；窗口结束若本机为最高优先候选，经本机人确认后用 confirm: true 生效（含生效前最后探测）、false 放弃（顺位候选会收到重排提示）',
    inputSchema: {
      type: 'object',
      properties: {
        collabId: { type: 'string', description: '协作标识' },
        confirm: { type: 'boolean', description: '确认分支：true = 生效；false = 放弃；省略 = 发起收集窗口' },
      },
      required: ['collabId'],
    },
    handler: async (args, context) => {
      const collabId = collabIdArg(args);
      if (collabId === null) {
        return errorResult('参数 collabId 非法：需要非空白字符串');
      }
      if (args.confirm !== undefined && typeof args.confirm !== 'boolean') {
        return errorResult('参数 confirm 非法：需要布尔值（或省略表示发起）');
      }
      return resultOf(await context.collab.takeOver({ collabId, confirm: args.confirm }));
    },
  };
}
