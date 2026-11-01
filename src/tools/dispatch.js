import {
  WS_DISPATCH_APPROVE_SPEC, WS_DISPATCH_CLAIM_SPEC, WS_DISPATCH_RELEASE_SPEC,
  WS_DISPATCH_RULES_RELOAD_SPEC, WS_DISPATCH_SCAN_SPEC,
} from './specs.js';
import { errorPayloadOf, errorResultOf } from '../util/errors.js';
import { errorResult, okResult } from './collab.js';

/* dispatch 工具集：与协作工具同一薄层口径——只做参数形态校验（会话标识 / 数组 / 布尔）与输出封装，
 * 业务判定（收编表、令牌、TTL、角色）一律在协作服务的 dispatch 域。 */

const MAX_CLAIM_TARGETS = 32;

function callerSessionOf(context, toolName) {
  const sessionId = typeof context.sessionId === 'string' ? context.sessionId.trim() : '';
  return sessionId === ''
    ? { refusal: errorResult(`本会话无会话标识：${toolName} 以调用会话身份执行`, { code: 'session-id-required' }) }
    : { sessionId, refusal: null };
}

/* 保留业务结果的原始 JSON（尤其 code: dispatch-lost）：master 靠它识别核心重启，不能退化成纯文案。
 * 统一错误结构在此归一：旧结果缺 hint 时按 code 补登记者，旧调用方读 ok / message 不受影响。 */
function dispatchFailure(result) {
  return errorResultOf(errorPayloadOf(result));
}

export function dispatchScanTool() {
  return {
    ...WS_DISPATCH_SCAN_SPEC,
    handler: async (_args, context) => {
      const caller = callerSessionOf(context, 'ws_dispatch_scan');
      if (caller.refusal !== null) {
        return caller.refusal;
      }
      const result = context.collab.dispatch.scan({ sessionId: caller.sessionId });
      return result.ok === true ? okResult(result) : dispatchFailure(result);
    },
  };
}

export function dispatchClaimTool() {
  return {
    ...WS_DISPATCH_CLAIM_SPEC,
    handler: async (args, context) => {
      const caller = callerSessionOf(context, 'ws_dispatch_claim');
      if (caller.refusal !== null) {
        return caller.refusal;
      }
      if (!validClaimTargetsOf(args.sessionIds)) {
        return errorResult('sessionIds 非法：需要 1–32 项非空字符串数组', { code: 'invalid-session-ids' });
      }
      const result = context.collab.dispatch.claim({
        sessionId: caller.sessionId,
        sessionIds: args.sessionIds.map((id) => id.trim()),
      });
      return result.ok === true ? okResult(result) : dispatchFailure(result);
    },
  };
}

function validClaimTargetsOf(sessionIds) {
  return Array.isArray(sessionIds) && sessionIds.length > 0 && sessionIds.length <= MAX_CLAIM_TARGETS
    && sessionIds.every((id) => typeof id === 'string' && id.trim() !== '');
}

export function dispatchApproveTool() {
  return {
    ...WS_DISPATCH_APPROVE_SPEC,
    handler: async (args, context) => {
      const caller = callerSessionOf(context, 'ws_dispatch_approve');
      if (caller.refusal !== null) {
        return caller.refusal;
      }
      if (typeof args.claimId !== 'string' || args.claimId.trim() === '') {
        return errorResult('claimId 非法：需要非空字符串', { code: 'invalid-claim-id' });
      }
      if (typeof args.approve !== 'boolean') {
        return errorResult('approve 非法：需要布尔值', { code: 'invalid-approve' });
      }
      const result = context.collab.dispatch.approve({
        sessionId: caller.sessionId,
        claimId: args.claimId.trim(),
        approve: args.approve,
        confirmToken: args.confirmToken,
      });
      /* needsUserConfirmation 不是失败：它是「用户还没确认」的正常中间态，必须正常返回给模型转述。 */
      return result.ok === true || result.needsUserConfirmation === true ? okResult(result) : dispatchFailure(result);
    },
  };
}

export function dispatchReleaseTool() {
  return {
    ...WS_DISPATCH_RELEASE_SPEC,
    handler: async (args, context) => {
      const caller = callerSessionOf(context, 'ws_dispatch_release');
      if (caller.refusal !== null) {
        return caller.refusal;
      }
      if (typeof args.sessionId !== 'string' || args.sessionId.trim() === '') {
        return errorResult('sessionId 非法：需要非空字符串', { code: 'invalid-session-id' });
      }
      const result = context.collab.dispatch.release({
        sessionId: caller.sessionId,
        targetSessionId: args.sessionId.trim(),
      });
      return result.ok === true ? okResult(result) : dispatchFailure(result);
    },
  };
}

export function dispatchRulesReloadTool() {
  return {
    ...WS_DISPATCH_RULES_RELOAD_SPEC,
    handler: async (_args, context) => {
      const caller = callerSessionOf(context, 'ws_dispatch_rules_reload');
      if (caller.refusal !== null) {
        return caller.refusal;
      }
      const result = context.collab.dispatch.reloadRules({ sessionId: caller.sessionId });
      return result.ok === true ? okResult(result) : dispatchFailure(result);
    },
  };
}
