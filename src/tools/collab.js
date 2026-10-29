import { isIP } from 'node:net';
import { COLLAB_MODES, DEFAULT_COLLAB_MODE, ID_PATTERN, MAX_COLLAB_MEMBERS, POST_KINDS, isIdentityName, isPort } from '../net/protocol.js';
import { DISPATCH_MESSAGE_TYPES } from '../collab/dispatch.js';
import {
  WS_ALLOW_NEXT_INVITE_SPEC, WS_APPROVE_INVITE_SPEC, WS_CREATE_COLLAB_SPEC, WS_END_COLLAB_SPEC, WS_INVITE_SPEC, WS_LEAVE_COLLAB_SPEC,
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

/* 创建模式：现有 LAN 协作模式之外加纯内存的 dispatch（不写入 COLLAB_MODES——LAN 协议不认它）。 */
const CREATE_MODES = [...COLLAB_MODES, 'dispatch'];

/* 清单的会话视角（本会话是否获准 / 是否绑定）要判在调用者身上：调用上下文已注入本会话标识，
 * 工具层只把它原样转交（判定归协作服务——无标识会话如实传空，由服务判否）。
 * sessionRole / sessionState 是「本会话」的席位视角，服务清单给的是本机角色/状态——
 * 逐条按调用会话现取席位，未入席如实给 null（不拿机器角色冒充会话角色）。 */
export function listCollabsTool() {
  return {
    ...WS_LIST_COLLABS_SPEC,
    handler: async (_args, context) => {
      const listed = context.collab.list({ sessionId: context.sessionId });
      const collabs = Array.isArray(listed.collabs)
        ? listed.collabs.map((entry) => withSessionSeatFields(context, entry))
        : listed.collabs;
      return okResult({ ok: true, ...listed, collabs });
    },
  };
}

function withSessionSeatFields(context, entry) {
  const seat = context.collab.localSeatOf?.(entry.collabId, context.sessionId) ?? null;
  const freezeReason = freezeReasonOf(entry);
  return {
    ...entry,
    sessionRole: seat?.role ?? null,
    sessionState: seat?.state ?? null,
    ...(freezeReason === null ? {} : { freezeReason }),
  };
}

/* 冻结原因的形状兼容（设计 §9 把 freezeReason 列为条目字段）：服务现把原因嵌在 sessions 下，
 * 工具层优先取条目顶层、缺失时回退嵌套——两种形状都不让展示面丢原因。 */
function freezeReasonOf(entry) {
  const top = entry.freezeReason;
  if (typeof top === 'string' && top.trim() !== '') {
    return top;
  }
  const nested = entry.sessions?.freezeReason;
  return typeof nested === 'string' && nested.trim() !== '' ? nested : null;
}

export function createCollabTool() {
  return {
    ...WS_CREATE_COLLAB_SPEC,
    handler: async (args, context) => {
      const mode = args.mode === undefined ? DEFAULT_COLLAB_MODE : args.mode;
      if (!CREATE_MODES.includes(mode)) {
        return errorResult(`参数 mode 非法：可选值为 ${CREATE_MODES.join(' / ')}（缺省 ${DEFAULT_COLLAB_MODE}）`);
      }
      const name = trimmedString(args, 'name');
      if (name === '') {
        return errorResult('参数 name 非法：需要非空白字符串');
      }
      /* dispatch 是纯内存本机编排：不接受 LAN 目标，主题可选；创建会话须为 master（服务判定）。 */
      if (mode === 'dispatch') {
        if (args.targets !== undefined) {
          return errorResult('dispatch 模式不接受 targets：首建后用 ws_dispatch_claim 收编本机会话');
        }
        const dispatchTopic = trimmedString(args, 'topic');
        return resultOf(await context.collab.create({
          mode: 'dispatch', name, topic: dispatchTopic === '' ? undefined : dispatchTopic, sessionId: context.sessionId,
        }));
      }
      const topic = trimmedString(args, 'topic');
      if (topic === '') {
        return errorResult('参数 topic 非法：managed / forum 需要非空白主题描述');
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
      const caller = callerSessionOf(context, 'ws_invite');
      if (caller.refusal !== null) {
        return caller.refusal;
      }
      const targets = targetsArg(args);
      if (targets === null) {
        return errorResult(targetsErrorMessage());
      }
      const verdicts = await capabilityVerdictsOf(targets, context);
      /* 邀请簿记归加入域：逐目标签发 inviteId（撤回 / 对账的定位键）。加入域面未暴露时
       * 回退旧邀请面（论坛与尚未接线的装配），不让工具层直接依赖 outgoing 内部。 */
      if (typeof context.join?.createInvite === 'function') {
        return inviteViaJoinDomain(collabId, targets, verdicts, caller.sessionId, context);
      }
      return inviteViaLegacySurface(collabId, targets, verdicts, caller.sessionId, context);
    },
  };
}

/* 邀请前的能力闸门（设计 §7.2）归服务层：加入域的 createInvite 与旧邀请面的 invite 走同一
 * 证据链——已知支持直接放行、已知不支持拒绝、未知才单播探测一次。工具层不再自带探测：那样
 * 会对已知支持的目标也发一次 UDP，一旦应答丢包就 fail-closed，并把服务层已短路的目标再问一遍。
 * 探测面不可用的装配无法判定——如实标记 unverified 而不是把未知当支持。 */
function capabilityVerdictsOf(targets, context) {
  const state = typeof context.net?.probeCapability === 'function' ? 'delegated' : 'unverified';
  return targets.map(() => ({ state }));
}

async function inviteViaJoinDomain(collabId, targets, verdicts, sessionId, context) {
  const invited = [];
  for (const [index, target] of targets.entries()) {
    const verdict = verdicts[index];
    const created = await context.join.createInvite(inviteCallOf(collabId, target, sessionId));
    /* 论坛无邀请簿记（设计 D18）：整批回退旧邀请面，forum 不生成也不返回 inviteId。 */
    if (created.code === 'forum-no-invite') {
      return inviteViaLegacySurface(collabId, targets, verdicts, sessionId, context);
    }
    /* 能力拒绝（已知不支持 / 探测后仍未知）与业务拒绝一样由服务层逐目标回报——工具层只封装，
     * 不再根据自身探测另下一份结论。前面的目标可能已发出邀请，不能用一个错误吞掉已签发的事实。 */
    invited.push(created.ok === true
      ? inviteRecordOf(target, created, verdict)
      : { instanceId: target.instanceId, ok: false, reason: created.message });
  }
  /* 一个都没签发出＝本次邀请失败：顶层 ok:true 会让代理把「谁也没邀请到」当成功——
   * 逐目标原因回传（含 collab 级前置拒绝：非站长会话 / 无席位 / 已归档），供调用方修正后重试。 */
  if (invited.every((entry) => entry.ok !== true)) {
    const details = invited.map((entry) => `${entry.instanceId}：${entry.reason ?? '未知原因'}`).join('；');
    return errorResult(`邀请全部失败（${invited.length} 个目标）：${details}`);
  }
  return okResult({ ok: true, collabId, invited });
}

function inviteCallOf(collabId, target, sessionId) {
  return {
    collabId,
    managerSessionId: sessionId,
    targetInstanceId: target.instanceId,
    ...(target.targetSessionId === undefined ? {} : { targetSessionId: target.targetSessionId }),
  };
}

/* 逐目标结果沿用旧邀请面的形状（instanceId / ok / msgId），另携 inviteId 与有效期。
 * 探测面缺失时附 capability:'unverified'：邀请照发，但调用方知道能力未经确认。 */
function inviteRecordOf(target, created, verdict) {
  const record = { instanceId: target.instanceId, ok: true, inviteId: created.inviteId };
  if (verdict.state === 'unverified') {
    record.capability = 'unverified';
  }
  if (created.expiresAt !== undefined) {
    record.expiresAt = created.expiresAt;
  }
  if (created.delivery?.msgId !== undefined) {
    record.msgId = created.delivery.msgId;
  }
  return record;
}

/* 旧邀请面（论坛 / 加入域未接线）：能力闸门归 service.invite（同一服务层证据链），工具层只
 * 做输出封装；旧面不逐目标携带结论，探测面缺失时以顶层标记如实说明能力未经确认。 */
async function inviteViaLegacySurface(collabId, targets, verdicts, sessionId, context) {
  const result = await context.collab.invite({ collabId, targets, sessionId });
  if (result.ok === true && verdicts.some((verdict) => verdict.state === 'unverified')) {
    return okResult({ ...result, capability: 'unverified' });
  }
  return resultOf(result);
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
      /* inviteId 定位到具体邀请记录：同一协作可同时存在多条 open 邀请（指名 / 不指名、重发），
       * 仅凭 collabId 无法确定同意的是哪一条；forum 无邀请簿记，省略。 */
      const inviteId = optionalTextArg(args, 'inviteId');
      if (args.inviteId !== undefined && inviteId === '') {
        return errorResult('参数 inviteId 非法：需要非空白字符串（邀请记录标识）');
      }
      /* 本会话标识平铺穿参（服务侧 caller.sessionId 备选形态亦收）：指名邀请的「只有该会话能点头」
       * 判定要拿点头会话做比对面；无标识会话如实传空（指名邀请被拒、未指名零变）。
       * confirmToken：用户确认挑战令牌（服务层首次调用签发，取得用户同意后重试时携带）。 */
      const confirmToken = optionalTextArg(args, 'confirmToken');
      const result = await context.collab.approve({ collabId, inviteId, approve: args.approve, reason, sessionId: context.sessionId, confirmToken });
      /* 用户确认挑战：结构化返回（令牌不能被 resultOf 的纯文案错误面吞掉）——
       * 代理据此把邀请摘要转述给用户，取得同意后携 confirmToken 重试。 */
      if (result?.needsUserConfirmation === true) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, needsUserConfirmation: true, confirmToken: result.confirmToken, invite: result.invite, message: result.message }) }],
          isError: true,
        };
      }
      return resultOf(result);
    },
  };
}

/* 邀请确认豁免：mode 缺省＝一次性；session / off / status 供会话级开关与查询。
 * 拒绝邀请始终走确认门——会话级开关只免「同意」。 */
export function allowNextInviteTool() {
  return {
    ...WS_ALLOW_NEXT_INVITE_SPEC,
    handler: async (args, context) => {
      const mode = typeof args?.mode === 'string' ? args.mode : undefined;
      const input = mode === undefined ? { sessionId: context.sessionId } : { sessionId: context.sessionId, mode };
      return resultOf(await context.collab.allowNextInvite(input));
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
      const caller = callerSessionOf(context, 'ws_withdraw_invite');
      if (caller.refusal !== null) {
        return caller.refusal;
      }
      const parsed = withdrawArgsOf(args);
      if (parsed.error !== undefined) {
        return errorResult(parsed.error);
      }
      if (parsed.inviteId !== undefined) {
        return withdrawByInviteId(parsed.inviteId, collabId, caller.sessionId, context);
      }
      /* 0.2.0 协作按 invites.json 的目标撤回（共享名单是 active-only，旧名单路径无 invited 行）；
       * 加入域面未暴露时退回旧路径（旧协作/直调夹具）。 */
      if (typeof context.join?.withdrawInviteByTarget === 'function') {
        return resultOf(context.join.withdrawInviteByTarget({ collabId, managerSessionId: caller.sessionId, target: parsed.target }));
      }
      return resultOf(await context.collab.withdraw({ collabId, target: parsed.target, sessionId: caller.sessionId }));
    },
  };
}

/* 撤回的定位参数归一：inviteId 与 target 二选一。无定位参数时不得落到服务层的「target 缺省 =
 * 整条撤回」路径——结束协作的唯一入口是 ws_end_collab（设计 §3.4），撤回工具只关闭邀请记录。 */
function withdrawArgsOf(args) {
  const inviteId = optionalTextArg(args, 'inviteId');
  if (args.inviteId !== undefined && inviteId === '') {
    return { error: '参数 inviteId 非法：需要非空白字符串（邀请记录标识）' };
  }
  const target = optionalTextArg(args, 'target');
  if (args.target !== undefined && target === '') {
    return { error: '参数 target 非法：需要非空白字符串（目标实例标识）' };
  }
  if (inviteId !== undefined && target !== undefined) {
    return { error: '参数非法：inviteId 与 target 二选一（inviteId 定位单条邀请记录，target 按目标精确撤回）' };
  }
  if (inviteId === undefined && target === undefined) {
    return { error: '参数非法：需要 inviteId（邀请记录标识）或 target（目标实例标识）——结束整条协作请用 ws_end_collab' };
  }
  return inviteId === undefined ? { target } : { inviteId };
}

/* 按邀请记录撤回（邀请簿记）：定位键是 inviteId，签发者为本会话；
 * 加入域面未暴露时明确报错（不得静默落回 target / 整条撤回路径）。 */
function withdrawByInviteId(inviteId, collabId, sessionId, context) {
  if (typeof context.join?.withdrawInvite !== 'function') {
    return errorResult('参数 inviteId 暂不可用：服务层尚未暴露按邀请记录撤回（join.withdrawInvite）');
  }
  return resultOf(context.join.withdrawInvite({ collabId, managerSessionId: sessionId, inviteId }));
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
      /* dispatch 与 managed / forum 的参数面不同（toSessionIds / taskId 只属于 dispatch；
       * dispatch 又不接受 to / toSessionId）：解析必须先按容器模式分流。 */
      const dispatch = context.collab.dispatch?.isDispatch?.(collabId) === true;
      const parsed = dispatch ? dispatchSendArgsOf(args) : sendMessageArgsOf(args);
      if (parsed.error !== undefined) {
        return errorResult(parsed.error);
      }
      /* 发送者会话随调用上下文穿参：本机多席时由服务层据此选定发件席位（缺省兜底只适用于
       * 无席位表的历史调用链）。 */
      return resultOf(await context.collab.send({ collabId, ...parsed.value, sessionId: context.sessionId }));
    },
  };
}

/* 消息参数归一（正文 / 类型 / 定向）：定向席位 = 实例 + 会话两步，只给 toSessionId 时无法定位
 * 目标机器，工具层先拒（双字段必须成对）；歧义由服务层的 matchSessionByToken 语义兜底。 */
function sendMessageArgsOf(args) {
  const basics = messageBasicsOf(args);
  if (basics.error !== undefined) {
    return basics;
  }
  /* dispatch 专属字段不得被 managed / forum 静默忽略：忽略会造出「定向了却没定向」的假象。 */
  const dispatchOnlyRefusal = dispatchOnlyFieldsRefusalOf(args);
  if (dispatchOnlyRefusal !== null) {
    return { error: dispatchOnlyRefusal };
  }
  const to = optionalTextArg(args, 'to');
  if (args.to !== undefined && to === '') {
    return { error: '参数 to 非法：需要非空白字符串（或省略）' };
  }
  const toSessionId = toSessionIdArg(args);
  if (toSessionId.error !== undefined) {
    return { error: toSessionId.error };
  }
  if (toSessionId.value !== undefined && to === undefined) {
    return { error: '参数非法：toSessionId 须与 to 同时给出（只给会话参数无法定位目标机器）' };
  }
  return { value: { text: basics.value.text, type: basics.value.type, to, toSessionId: toSessionId.value } };
}

/* 正文与类型（两模式共用）：type 缺省 reply，取值限协作类词表。 */
function messageBasicsOf(args) {
  const text = trimmedString(args, 'text');
  if (text === '') {
    return { error: '参数 text 非法：需要非空白字符串（消息正文）' };
  }
  const type = args.type === undefined ? 'reply' : args.type;
  if (typeof type !== 'string' || !SEND_MESSAGE_TYPES.includes(type)) {
    return { error: `参数 type 非法：可选值为 ${SEND_MESSAGE_TYPES.join(' / ')}（缺省 reply）` };
  }
  return { value: { text, type } };
}

function dispatchOnlyFieldsRefusalOf(args) {
  return args.toSessionIds !== undefined || args.taskId !== undefined
    ? 'toSessionIds / taskId 只用于 dispatch 模式；managed / forum 请用 to + toSessionId'
    : null;
}

/* dispatch 参数面（纯本机内存域）：type 只认四类词表；定向用 toSessionIds 数组
 * （省略即由核心按绑定路由：master→全体 slave、slave→master），不接受 to / toSessionId
 * （实例 + 会话的两段式定位在单机域里没有意义）；taskId 是任务的关联键，≤64 字符。 */
function dispatchSendArgsOf(args) {
  const basics = dispatchBasicsOf(args);
  if (basics.error !== undefined) {
    return basics;
  }
  const targets = dispatchTargetsArgOf(args.toSessionIds);
  if (targets.error !== undefined) {
    return targets;
  }
  if (args.taskId !== undefined && !isDispatchTaskId(args.taskId)) {
    return { error: 'taskId 非法：需要 1–64 字符的非空白字符串' };
  }
  return { value: { text: basics.value.text, type: args.type, toSessionIds: targets.value, taskId: args.taskId?.trim() } };
}

function dispatchBasicsOf(args) {
  const text = trimmedString(args, 'text');
  if (text === '') {
    return { error: '参数 text 非法：需要非空白字符串（消息正文）' };
  }
  if (args.type !== undefined && !DISPATCH_MESSAGE_TYPES.includes(args.type)) {
    return { error: `参数 type 非法：dispatch 可选值为 ${DISPATCH_MESSAGE_TYPES.join(' / ')}` };
  }
  if (args.to !== undefined || args.toSessionId !== undefined) {
    return { error: 'dispatch 不接受 to / toSessionId——定向用 toSessionIds 数组，省略即由核心按绑定路由' };
  }
  return { value: { text } };
}

function dispatchTargetsArgOf(toSessionIds) {
  if (toSessionIds === undefined) {
    return { value: undefined };
  }
  if (!Array.isArray(toSessionIds) || toSessionIds.length === 0
    || toSessionIds.some((id) => typeof id !== 'string' || id.trim() === '')) {
    return { error: 'toSessionIds 非法：需要非空字符串数组（省略即按绑定路由）' };
  }
  return { value: toSessionIds.map((id) => id.trim()) };
}

function isDispatchTaskId(taskId) {
  return typeof taskId === 'string' && taskId.trim() !== '' && taskId.length <= 64;
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
      /* 静音按会话（本席位）：调用会话随上下文穿参，服务写该席位并落盘；工具层不碰持久化文件。 */
      return resultOf(await context.collab.setMute({ collabId, muted: args.muted, sessionId: context.sessionId }));
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
      /* 离席按会话（设计 §3.4/§9）：只退本会话的席位，同机其他席位与整机兼容记录不受牵连——
       * 会话标识随上下文穿参，缺标识由服务如实拒绝（不落到按首个活跃席位代签）。 */
      return resultOf(await context.collab.leave({ collabId, sessionId: context.sessionId }));
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
      /* 结束是站长会话的治理动作（managed）：调用会话必须随参——缺标识时服务层会退回整机
       * 兼容，同机成员会话因此能结束整条协作。 */
      const caller = callerSessionOf(context, 'ws_end_collab');
      if (caller.refusal !== null) {
        return caller.refusal;
      }
      return resultOf(await context.collab.end({ collabId, sessionId: caller.sessionId }));
    },
  };
}

/* 治理 / 邀请类工具的会话前提（设计 §1.1/§1.2）：会话标识是席位授权的主体，缺失时不得退回
 * 整机兼容——否则同机任一成员会话都会被当成站长。返回 { sessionId, refusal }：refusal 非空
 * 即应原样作为工具错误返回；调用参数一律用归一后的 sessionId。 */
export function callerSessionOf(context, toolName) {
  const sessionId = typeof context.sessionId === 'string' ? context.sessionId.trim() : '';
  if (sessionId === '') {
    return {
      sessionId,
      refusal: errorResult(`本会话无会话标识：${toolName} 以调用会话的席位授权，无法确定调用席位——请从带会话标识的终端调用`),
    };
  }
  return { sessionId, refusal: null };
}

/* 工具返回口径（23 工具单一权威）：成功 = 顶层含 ok:true 的 JSON 对象（列表载荷用命名字段承载：
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

/* 定向会话参数（toSessionId）：未给＝未定向；给了须为标识形态（短码是标识前缀，同一判据）——
 * 「给了但形态坏」与「没给」必须分开，坏形态不得静默落回无定向发送。 */
function toSessionIdArg(args) {
  const value = optionalTextArg(args, 'toSessionId');
  if (args.toSessionId === undefined) {
    return { value: undefined };
  }
  if (typeof value !== 'string' || value === '' || !ID_PATTERN.test(value)) {
    return { error: '参数 toSessionId 非法：需要会话标识（短码或完整标识）' };
  }
  return { value };
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
