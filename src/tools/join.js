import { isIP } from 'node:net';
import { ID_PATTERN, isPort } from '../net/protocol.js';
import { WS_APPROVE_JOIN_SPEC, WS_JOIN_SPEC } from './specs.js';
import { collabIdArg, errorResult, optionalTextArg, resultOf, trimmedString } from './collab.js';

/* 会话级加入工具集（ws_join / ws_approve_join，设计 §2/§4/§6）：薄层——只做参数形态校验与本会话
 * 标识取用；业务判定（在席直连 / 敲门 / 按名解析 / 站长态度与批准权）一律在加入域服务，服务的
 * { ok: false, message } 映射为 isError。
 * 两工具的会话标识都取调用上下文（context.sessionId，桥注册时注入）：申请与批准都以会话为记账
 * 单位——无标识的会话既申请不了（无从接线），也批准不了（批准要记批准者会话），工具层明确拒；
 * 服务层的形态校验保留为纵深防御。 */

/* 本会话标识（工具层取用面）：缺省 / 空白一律按无标识（如实），不臆造。 */
function sessionIdOf(context) {
  const value = typeof context?.sessionId === 'string' ? context.sessionId.trim() : '';
  return value === '' ? null : value;
}

/* 加入申请（设计 §2/§4）：collabId 直给＝跳过按名解析；只给 name＋target＝先单播按名解析
 * （target 取 { address, port }，或 { instanceId } 经已知主机清单解析出端点）；只给 name ＝
 * 讨论敲门路径。 */
export function joinTool() {
  return {
    ...WS_JOIN_SPEC,
    handler: async (args, context) => {
      const sessionId = sessionIdOf(context);
      if (sessionId === null) {
        return errorResult('本会话无会话标识，无法申请加入');
      }
      const collabId = collabIdArg(args);
      const name = trimmedString(args, 'name');
      if (collabId === null && name === '') {
        return errorResult('参数非法：需要 collabId（协作标识），或 name（协作 / 讨论名，可配 target 按名解析）');
      }
      const target = targetArg(args);
      if (target === null) {
        /* 文案与加入域的形态拒绝逐字同源（同一输入的两种到达路径给同一句——两处分叉即缺陷）。 */
        return errorResult('参数 target 非法：需要 { address, port }（IP 字面量 ＋ 1–65535 端口）或 { instanceId }（已知主机清单里的实例标识）');
      }
      return resultOf(await context.join.request({
        collabId: collabId ?? undefined,
        name: name === '' ? undefined : name,
        target,
        sessionId,
      }));
    },
  };
}

/* 站长批准 / 拒绝（设计 §2/§6）：sessionId＝申请人会话（短码即可——服务侧唯一前缀匹配，
 * 与待批准面同一口径）；approvedBy＝本会话（批准备案「谁点的头」，获准台账契约要求非空）。 */
export function approveJoinTool() {
  return {
    ...WS_APPROVE_JOIN_SPEC,
    handler: async (args, context) => {
      const collabId = collabIdArg(args);
      if (collabId === null) {
        return errorResult('参数 collabId 非法：需要非空白字符串');
      }
      const sessionId = trimmedString(args, 'sessionId');
      if (sessionId === '') {
        return errorResult('参数 sessionId 非法：需要非空白字符串（申请人会话标识 / 短码）');
      }
      if (typeof args.approve !== 'boolean') {
        return errorResult('参数 approve 非法：需要布尔值（true = 批准 / false = 拒绝）');
      }
      const approvedBy = sessionIdOf(context);
      if (approvedBy === null) {
        return errorResult('本会话无会话标识，无法处置加入申请（批准须记批准者会话）');
      }
      /* reason 按描述语义归一：approve=true 时在工具层丢弃（服务层该分支不消费）——与
       * ws_approve_invite 同一口径（同意 + 理由是无定义组合）。 */
      const reason = args.approve === false ? optionalTextArg(args, 'reason') : undefined;
      return resultOf(await context.join.approve({ collabId, sessionId, approve: args.approve, reason, approvedBy }));
    },
  };
}

/* target 两形态归一（可选）：缺省＝未给（undefined，走敲门 / 直取）；给了一律要过形态判据——
 * { address, port } 取 IP 字面量＋端口，{ instanceId } 取实例标识（端点解析归加入域：已知主机
 * 清单在服务层，工具层只把形态钉死）；形态非法返回 null（与「未给」区分——给了坏形态不得静默
 * 落回敲门广播路径）。 */
function targetArg(args) {
  const raw = args.target;
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  return targetFormsOf(raw);
}

/* 两形态归一：{instanceId} 或 {address, port}——都按判据校验，形态坏返回 null。 */
function targetFormsOf(raw) {
  const instanceId = trimmedString(raw, 'instanceId');
  if (instanceId !== '') {
    return ID_PATTERN.test(instanceId) ? { instanceId } : null;
  }
  const address = trimmedString(raw, 'address');
  return isIP(address) !== 0 && isPort(raw.port) ? { address, port: raw.port } : null;
}
