import { ID_PATTERN } from '../net/protocol.js';
import { errorPayloadOf, errorResultOf } from '../util/errors.js';
import { callerSessionOf, collabIdArg, errorResult, optionalTextArg, resultOf } from './collab.js';
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
      /* 裁定按调用席位授权（spec：站长席位；任期分叉下成员也可 terminate）：无会话标识
       * 没有可核对席位，不得退回整机兼容。 */
      const caller = callerSessionOf(context, 'ws_decide');
      if (caller.refusal !== null) {
        return caller.refusal;
      }
      if (args.mergeOffer !== undefined) {
        return decideMergeOfferCall(args, collabId, caller.sessionId, context);
      }
      if (args.choice !== 'merge' && args.choice !== 'keep' && args.choice !== 'terminate') {
        return errorResult('参数非法：需恰提供一种形态——choice（冻结裁定：merge / keep / terminate）或 mergeOffer（合流递交裁定：accept / reject）');
      }
      return resultOf(await context.collab.decide({ collabId, choice: args.choice, sessionId: caller.sessionId }));
    },
  };
}

function decideMergeOfferCall(args, collabId, sessionId, context) {
  if (args.choice !== undefined) {
    return errorResult('参数非法：choice 与 mergeOffer 只能提供一种');
  }
  if (args.mergeOffer !== 'accept' && args.mergeOffer !== 'reject') {
    return errorResult('参数 mergeOffer 非法：可选值为 accept / reject');
  }
  return resultOf(context.collab.decideMerge({ collabId, mergeOffer: args.mergeOffer, sessionId }));
}

export function handoverTool() {
  return {
    ...WS_HANDOVER_SPEC,
    handler: async (args, context) => {
      const collabId = collabIdArg(args);
      if (collabId === null) {
        return errorResult('参数 collabId 非法：需要非空白字符串');
      }
      /* 移交的双角色都以调用会话为席位主体：无标识时服务层会退回整机兼容，成员会话可冒充
       * 站长发起移交——工具层必须先拒。 */
      const caller = callerSessionOf(context, 'ws_handover');
      if (caller.refusal !== null) {
        return caller.refusal;
      }
      const parsed = handoverArgsOf(args);
      if (parsed.error !== undefined) {
        return errorResult(parsed.error);
      }
      if (parsed.role === 'target') {
        return handoverTargetCall(parsed.value, collabId, caller.sessionId, context);
      }
      /* 发起角色：目标席位由 target + targetSessionId 共同定位（同机多席必须指名）；
       * 发起立即返回，不在工具层等目标确认（确认时限与迟到判定归服务）。 */
      return resultOf(await context.collab.handover({ collabId, ...parsed.value, sessionId: caller.sessionId }));
    },
  };
}

/* 双角色参数归一：offerId 存在＝目标确认/拒绝角色；否则＝站长发起角色。两种角色的字段集
 * 互斥——混给会让「谁在确认哪条提议」含糊，直接拒绝而不是静默择一。 */
function handoverArgsOf(args) {
  const offerId = optionalTextArg(args, 'offerId');
  if (args.offerId !== undefined && offerId === '') {
    return { error: '参数 offerId 非法：需要非空白字符串（目标角色：站长发起成功后返回的 offerId）' };
  }
  const target = optionalTextArg(args, 'target');
  const targetSessionId = optionalTextArg(args, 'targetSessionId');
  const targetError = handoverTargetErrorOf(args, target, targetSessionId);
  if (targetError !== null) {
    return { error: targetError };
  }
  const decisionError = handoverDecisionErrorOf(args);
  if (decisionError !== null) {
    return { error: decisionError };
  }
  const reason = optionalTextArg(args, 'reason');
  if (args.reason !== undefined && reason === '') {
    return { error: '参数 reason 非法：需要非空白字符串（拒绝原因）' };
  }
  return offerId === undefined
    ? handoverInitiatorArgsOf({ args, target, targetSessionId, decision: args.decision })
    : handoverTargetArgsOf({ args, offerId, target, targetSessionId, decision: args.decision, reason });
}

function handoverTargetErrorOf(args, target, targetSessionId) {
  if (args.target !== undefined && (target === undefined || !ID_PATTERN.test(target))) {
    return '参数 target 非法：需要成员的实例标识（1–64 位字母数字与连字符）';
  }
  if (args.targetSessionId !== undefined && (targetSessionId === undefined || !ID_PATTERN.test(targetSessionId))) {
    return '参数 targetSessionId 非法：需要会话标识（短码或完整标识）';
  }
  return null;
}

function handoverDecisionErrorOf(args) {
  const decision = args.decision;
  if (decision !== undefined && decision !== 'accept' && decision !== 'reject') {
    return '参数 decision 非法：可选值为 accept / reject';
  }
  return null;
}

function handoverInitiatorArgsOf({ args, target, targetSessionId, decision }) {
  if (decision !== undefined || args.confirmToken !== undefined) {
    return { error: '参数非法：decision / confirmToken 属目标确认角色，须与 offerId 同时给出' };
  }
  if (target === undefined || targetSessionId === undefined) {
    return { error: '参数非法：站长发起角色需要 target 与 targetSessionId（均必填）；目标确认角色请给 offerId' };
  }
  return { role: 'initiator', value: { target, targetSessionId } };
}

function handoverTargetArgsOf({ args, offerId, target, targetSessionId, decision, reason }) {
  if (target !== undefined || targetSessionId !== undefined) {
    return { error: '参数非法：offerId（目标确认角色）与 target / targetSessionId（站长发起角色）不可同时提供' };
  }
  const confirmToken = optionalTextArg(args, 'confirmToken');
  if (args.confirmToken !== undefined && confirmToken === '') {
    return { error: '参数 confirmToken 非法：需要非空白字符串（首次确认调用返回的令牌）' };
  }
  if (decision === 'reject' && reason === undefined) {
    return { error: '参数非法：decision=reject 须给出 reason（拒绝原因）' };
  }
  return { role: 'target', value: { offerId, decision, reason, confirmToken } };
}

/* 目标角色：拒绝走独立回执入口（不得落回接受路径），确认走一次性挑战令牌。
 * 目标侧绝不自行提升为站长——提升只发生在旧站长收到 accept 后签发站长变更。 */
async function handoverTargetCall(value, collabId, sessionId, context) {
  if (value.decision === 'reject') {
    return rejectHandoverCall(value, collabId, sessionId, context);
  }
  if (typeof context.collab.confirmHandover !== 'function') {
    return errorResult('目标确认移交不可用：服务层尚未暴露 confirmHandover（移交提议已记录，本机不会自行提升）');
  }
  const result = await context.collab.confirmHandover({ collabId, sessionId, offerId: value.offerId, token: value.confirmToken });
  if (result?.needsUserConfirmation === true) {
    return confirmationChallengeOf(result, value.offerId);
  }
  return resultOf(result);
}

async function rejectHandoverCall(value, collabId, sessionId, context) {
  if (typeof context.collab.rejectHandover !== 'function') {
    return errorResult('目标拒绝移交不可用：服务层尚未暴露拒绝入口（rejectHandover）——本次未回执');
  }
  /* 拒绝要发帧回执，服务入口必然是异步的：不 await 会把 Promise 当结果对象，
   * 走到 result.ok !== true 分支产出空文案（用户看不到拒绝是否生效）。 */
  return resultOf(await context.collab.rejectHandover({ collabId, sessionId, offerId: value.offerId, reason: value.reason }));
}

export function takeOverTool() {
  return {
    ...WS_TAKE_OVER_SPEC,
    handler: async (args, context) => {
      const collabId = collabIdArg(args);
      if (collabId === null) {
        return errorResult('参数 collabId 非法：需要非空白字符串');
      }
      if (args.confirm !== undefined) {
        return errorResult('参数 confirm 已退役：接管确认须用首次调用返回的 confirmToken');
      }
      const confirmToken = optionalTextArg(args, 'confirmToken');
      if (args.confirmToken !== undefined && confirmToken === '') {
        return errorResult('参数 confirmToken 非法：需要非空白字符串（首次调用返回的确认令牌）');
      }
      /* 首次调用只签发挑战（服务返回 needsUserConfirmation＋token），携令牌重试才执行；
       * 调用会话随上下文穿参——接管的是本机在该协作的席位，不是整台机器。 */
      const result = await context.collab.takeOver({ collabId, sessionId: context.sessionId, token: confirmToken });
      if (result?.needsUserConfirmation === true) {
        return confirmationChallengeOf(result);
      }
      return resultOf(result);
    },
  };
}

/* 一次性挑战的返回面与 ws_approve_invite 同形：令牌不能被 resultOf 的纯文案错误面吞掉——
 * 代理据此把治理动作转述给用户，取得同意后携 confirmToken 重试。 */
function confirmationChallengeOf(result, offerId) {
  const payload = {
    ok: false, code: 'user-confirmation-required', needsUserConfirmation: true,
    confirmToken: result.token, message: result.message,
  };
  if (offerId !== undefined) {
    payload.offerId = offerId;
  }
  return errorResultOf(errorPayloadOf(payload));
}
