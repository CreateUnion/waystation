import { errorPayloadOf, errorResultOf } from '../util/errors.js';
import { WS_SET_CONFIRM_GATE_SPEC } from './specs.js';
import { errorResult, okResult } from './collab.js';

/* ws_set_confirm_gate：薄封装。参数形态在这里挡，业务判定（令牌、落盘顺序、优先级）在服务层。 */
export function setConfirmGateTool() {
  return {
    ...WS_SET_CONFIRM_GATE_SPEC,
    handler: async (args, context) => {
      const sessionId = typeof context.sessionId === 'string' ? context.sessionId.trim() : '';
      if (sessionId === '') {
        return errorResult('本会话无会话标识：确认门按会话生效，无法确定调用会话');
      }
      const result = context.collab.setConfirmGate({ ...args, sessionId });
      if (result.needsUserConfirmation === true) {
        return errorResultOf(errorPayloadOf({ ...result, code: 'user-confirmation-required' }));
      }
      return result.ok === true ? okResult(result) : errorResult(result.message ?? '确认门设置失败');
    },
  };
}
