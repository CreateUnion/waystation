import { ID_PATTERN } from '../net/protocol.js';
import { collabIdArg, errorResult, resultOf, trimmedString } from './collab.js';
import { WS_DECIDE_SPEC, WS_HANDOVER_SPEC, WS_TAKE_OVER_SPEC } from './specs.js';

/* 治理工具集（设计 §10 工具最小集的治理落点）：裁定 / 移交 / 抢接——薄层，只做参数形态校验
 * （业务判定在协作服务，服务的 { ok:false, message } 映射为 isError）；三工具同域共置一个文件。 */

export function decideTool() {
  return {
    ...WS_DECIDE_SPEC,
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
    ...WS_HANDOVER_SPEC,
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
    ...WS_TAKE_OVER_SPEC,
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
