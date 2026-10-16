import { isIP } from 'node:net';
import { COLLAB_MODES, DEFAULT_COLLAB_MODE, ID_PATTERN, MAX_COLLAB_MEMBERS, POST_KINDS, isCollabMode, isIdentityName, isPort } from '../net/protocol.js';
import {
  WS_APPROVE_INVITE_SPEC, WS_CREATE_COLLAB_SPEC, WS_END_COLLAB_SPEC, WS_INVITE_SPEC, WS_LEAVE_COLLAB_SPEC,
  WS_LIST_COLLABS_SPEC, WS_REQUEST_JOIN_SPEC, WS_SEND_MESSAGE_SPEC, WS_SET_MUTE_SPEC, WS_VIEW_LEDGER_SPEC,
  WS_WITHDRAW_INVITE_SPEC,
} from './specs.js';

/* 协作工具集（设计 §10 工具最小集的协作核心期落点）：薄层——只做参数形态校验
 * （非空字符串 / 布尔 / 数组 / 整数 / 身份名）与输出封装；业务判定（状态门控、冻结白名单、
 * 路由、上限）一律在协作服务，服务的 { ok: false, message } 映射为 isError。
 * 本组工具同域共置一个文件：共享同一份参数助手，避免多份重复的 trim / 形态校验。 */

/* 会话消息可用的协作类类型（设计 §10）：治理类与建协类不经本工具。
 * 同一词表即讨论模式帖的语义徽标（protocol.POST_KINDS，单一权威——两处判定同一份取值）。 */
export const SEND_MESSAGE_TYPES = POST_KINDS;

const MAX_TARGETS = MAX_COLLAB_MEMBERS - 1;   // 目标上限 = 名单上限减发起者本人（单一权威：protocol.MAX_COLLAB_MEMBERS）

/* 清单的会话视角（本会话是否获准 / 是否绑定）要判在调用者身上：调用上下文已注入本会话标识，
 * 工具层只把它原样转交（判定归协作服务——无标识会话如实传空，由服务判否）。 */
export function listCollabsTool() {
  return {
    ...WS_LIST_COLLABS_SPEC,
    handler: async (_args, context) => okResult({ ok: true, ...context.collab.list({ sessionId: context.sessionId }) }),
  };
}

export function createCollabTool() {
  return {
    ...WS_CREATE_COLLAB_SPEC,
    handler: async (args, context) => {
      const name = trimmedString(args, 'name');
      const topic = trimmedString(args, 'topic');
      if (name === '' || topic === '') {
        return errorResult('参数 name / topic 非法：需要非空白字符串（项目名与主题描述）');
      }
      const mode = args.mode === undefined ? DEFAULT_COLLAB_MODE : args.mode;
      if (!isCollabMode(mode)) {
        return errorResult(`参数 mode 非法：可选值为 ${COLLAB_MODES.join(' / ')}（缺省 ${DEFAULT_COLLAB_MODE}）`);
      }
      const targets = targetsArg(args);
      if (targets === null) {
        return errorResult(targetsErrorMessage());
      }
      /* 本会话标识随创建穿参：发起会话即获准（写本机获准台账 origin:create——会话级加入 §5
       * 获准写点一）；无标识会话如实传空（未获准者可走 ws_join 申请）。 */
      return resultOf(await context.collab.create({ name, topic, targets, mode, sessionId: context.sessionId }));
    },
  };
}

export function inviteTool() {
  return {
    ...WS_INVITE_SPEC,
    handler: async (args, context) => {
      const collabId = collabIdArg(args);
      if (collabId === null) {
        return errorResult('参数 collabId 非法：需要非空白字符串');
      }
      const targets = targetsArg(args);
      if (targets === null) {
        return errorResult(targetsErrorMessage());
      }
      return resultOf(await context.collab.invite({ collabId, targets }));
    },
  };
}

/* targets 非法时的统一文案（两工具共用——形状与上限同一权威）。 */
function targetsErrorMessage() {
  return `参数 targets 非法：需要 1–${MAX_TARGETS} 项 { instanceId, identityName, address, port }（地址为 IP 字面量、端口为 1–65535 整数）`;
}

/* 无应答的统一处理（设计 §5.6）：不作错误、不自动重试——提示稍后重试或改走对方 ws_invite 邀请。 */
const JOIN_NO_ANSWER_NOTE = '未收到任何应答（可能无人收到敲门、在场成员离线，或该讨论名无人认领）——稍后重试，或直接联系讨论成员由对方执行 ws_invite 邀请你；本工具不做自动重试。';

/* 主动加入（设计 §5.6/§7）：敲门会把讨论名播给全网（局域网可见——如实披露⑥）；应答为在场成员的
 * 自动行为（主题 / 名称可能截断，加入后经正式通道对表补齐）；申请本身可伪造，由放行（对方本机人）
 * 与同意门兜底（披露⑦）。加入 = 任一成员本机放行（ws_invite 邀请你）→ 你在同意门确认。 */
export function requestJoinTool() {
  return {
    ...WS_REQUEST_JOIN_SPEC,
    handler: async (args, context) => {
      const name = trimmedString(args, 'name');
      if (name === '') {
        return errorResult('参数 name 非法：需要非空白字符串（讨论名）');
      }
      const result = await context.net.requestJoin({ name });
      if (result.ok === true && result.replies.length === 0) {
        return okResult({ ...result, note: JOIN_NO_ANSWER_NOTE });
      }
      return resultOf(result);
    },
  };
}

export function approveInviteTool() {
  return {
    ...WS_APPROVE_INVITE_SPEC,
    handler: async (args, context) => {
      const collabId = collabIdArg(args);
      if (collabId === null) {
        return errorResult('参数 collabId 非法：需要非空白字符串');
      }
      if (typeof args.approve !== 'boolean') {
        return errorResult('参数 approve 非法：需要布尔值');
      }
      /* reason 按描述语义归一：approve=true 时在工具层丢弃（服务层该分支本就不消费）——宁可少传，
       * 不让「同意 + 理由」这种无定义组合穿到线上。 */
      const reason = args.approve === false ? optionalTextArg(args, 'reason') : undefined;
      /* 本会话标识平铺穿参（服务侧 caller.sessionId 备选形态亦收）：指名邀请的「只有该会话能点头」
       * 判定要拿点头会话做比对面；无标识会话如实传空（指名邀请被拒、未指名零变）。 */
      return resultOf(await context.collab.approve({ collabId, approve: args.approve, reason, sessionId: context.sessionId }));
    },
  };
}

export function withdrawInviteTool() {
  return {
    ...WS_WITHDRAW_INVITE_SPEC,
    handler: async (args, context) => {
      const collabId = collabIdArg(args);
      if (collabId === null) {
        return errorResult('参数 collabId 非法：需要非空白字符串');
      }
      const target = optionalTextArg(args, 'target');
      if (args.target !== undefined && target === '') {
        return errorResult('参数 target 非法：需要非空白字符串（或省略表示整条取消）');
      }
      return resultOf(await context.collab.withdraw({ collabId, target }));
    },
  };
}

export function viewLedgerTool() {
  return {
    ...WS_VIEW_LEDGER_SPEC,
    handler: async (args, context) => {
      const collabId = collabIdArg(args);
      if (collabId === null) {
        return errorResult('参数 collabId 非法：需要非空白字符串');
      }
      return resultOf(await context.collab.view({ collabId }));
    },
  };
}

export function sendMessageTool() {
  return {
    ...WS_SEND_MESSAGE_SPEC,
    handler: async (args, context) => {
      const collabId = collabIdArg(args);
      if (collabId === null) {
        return errorResult('参数 collabId 非法：需要非空白字符串');
      }
      const text = trimmedString(args, 'text');
      if (text === '') {
        return errorResult('参数 text 非法：需要非空白字符串（消息正文）');
      }
      const type = args.type === undefined ? 'reply' : args.type;
      if (typeof type !== 'string' || !SEND_MESSAGE_TYPES.includes(type)) {
        return errorResult(`参数 type 非法：可选值为 ${SEND_MESSAGE_TYPES.join(' / ')}（缺省 reply）`);
      }
      const to = optionalTextArg(args, 'to');
      if (args.to !== undefined && to === '') {
        return errorResult('参数 to 非法：需要非空白字符串（或省略）');
      }
      return resultOf(await context.collab.send({ collabId, text, type, to }));
    },
  };
}

export function setMuteTool() {
  return {
    ...WS_SET_MUTE_SPEC,
    handler: async (args, context) => {
      const collabId = collabIdArg(args);
      if (collabId === null) {
        return errorResult('参数 collabId 非法：需要非空白字符串');
      }
      if (typeof args.muted !== 'boolean') {
        return errorResult('参数 muted 非法：需要布尔值（true 进入静音 / false 取消静音）');
      }
      return resultOf(await context.collab.setMute({ collabId, muted: args.muted }));
    },
  };
}

export function leaveCollabTool() {
  return {
    ...WS_LEAVE_COLLAB_SPEC,
    handler: async (args, context) => {
      const collabId = collabIdArg(args);
      if (collabId === null) {
        return errorResult('参数 collabId 非法：需要非空白字符串');
      }
      return resultOf(await context.collab.leave({ collabId }));
    },
  };
}

export function endCollabTool() {
  return {
    ...WS_END_COLLAB_SPEC,
    handler: async (args, context) => {
      const collabId = collabIdArg(args);
      if (collabId === null) {
        return errorResult('参数 collabId 非法：需要非空白字符串');
      }
      return resultOf(await context.collab.end({ collabId }));
    },
  };
}

/* 工具返回口径（21 工具单一权威）：成功 = 顶层含 ok:true 的 JSON 对象（列表载荷用命名字段承载：
 * hosts / rows / collabs）；失败 = errorResult 纯文案 + isError。新增工具一律照此。 */
export function okResult(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

export function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/* 业务结果封装：{ ok: true, … } → 正常输出；{ ok: false, message } → isError 原文案。
 * 导出供治理工具集复用——工具层的输出契约单一权威。 */
export function resultOf(result) {
  if (result.ok === true) {
    return okResult(result);
  }
  return errorResult(result.message);
}

export function trimmedString(args, name) {
  const value = args[name];
  return typeof value === 'string' ? value.trim() : '';
}

export function optionalTextArg(args, name) {
  if (args[name] === undefined) {
    return undefined;
  }
  return trimmedString(args, name);
}

export function collabIdArg(args) {
  const collabId = trimmedString(args, 'collabId');
  return collabId === '' ? null : collabId;
}

/* 目标数组形态（工具层只检基础形态；ID 形态与地址字面量由服务裁定——ID_PATTERN 在此用于
 * 拒绝明显非法的实例标识、减少一次往返）。 */
function targetsArg(args) {
  if (!Array.isArray(args.targets) || args.targets.length < 1 || args.targets.length > MAX_TARGETS) {
    return null;
  }
  const targets = [];
  for (const entry of args.targets) {
    const target = targetArg(entry);
    if (target === null) {
      return null;
    }
    targets.push(target);
  }
  return targets;
}

function targetArg(entry) {
  if (typeof entry !== 'object' || entry === null) {
    return null;
  }
  return trimmedTargetFields(entry);
}

/* 四字段归一：instanceId / identityName / address 各自 trim 后按判据校验（与配置面、协议层同权威）；address 取 IP 字面量、port 取 protocol.isPort——与 ws_ping 同深度（服务侧兜底保留，纵深防御）。 */
function trimmedTargetFields(entry) {
  const instanceId = trimmedString(entry, 'instanceId');
  const identityName = trimmedString(entry, 'identityName');
  const address = trimmedString(entry, 'address');
  if (instanceId === '' || !ID_PATTERN.test(instanceId) || !isIdentityName(identityName)) {
    return null;
  }
  if (!isTargetEndpoint(address, entry.port)) {
    return null;
  }
  const named = targetSessionFieldOf(entry);
  if (named === null) {
    return null;
  }
  return { instanceId, identityName, address, port: entry.port, ...named };
}

function isTargetEndpoint(address, port) {
  return address !== '' && isIP(address) !== 0 && isPort(port);
}

/* 可选指名会话（邀请的 targetSessionId）：未给＝不指名（字段不出现在归一结果里）；给了须为
 * 标识形态（短码是标识前缀，同一判据）——「给了但形态坏」与「没给」必须分开，不得静默丢字段
 * （丢字段＝把指名邀请变成广播，与用户意图相反）。 */
function targetSessionFieldOf(entry) {
  if (entry.targetSessionId === undefined || entry.targetSessionId === null) {
    return {};
  }
  const targetSessionId = typeof entry.targetSessionId === 'string' ? entry.targetSessionId.trim() : '';
  if (targetSessionId === '' || !ID_PATTERN.test(targetSessionId)) {
    return null;
  }
  return { targetSessionId };
}
