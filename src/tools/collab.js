import { isIP } from 'node:net';
import { COLLAB_MODES, DEFAULT_COLLAB_MODE, ID_PATTERN, MAX_COLLAB_MEMBERS, POST_KINDS, isCollabMode, isIdentityName, isPort } from '../net/protocol.js';

/* 协作工具集（设计 §10 工具最小集的协作核心期落点）：薄层——只做参数形态校验
 * （非空字符串 / 布尔 / 数组 / 整数 / 身份名）与输出封装；业务判定（状态门控、冻结白名单、
 * 路由、上限）一律在协作服务，服务的 { ok: false, message } 映射为 isError。
 * 本组工具同域共置一个文件：共享同一份参数助手，避免多份重复的 trim / 形态校验。 */

/* 会话消息可用的协作类类型（设计 §10）：治理类与建协类不经本工具。
 * 同一词表即讨论模式帖的语义徽标（protocol.POST_KINDS，单一权威——两处判定同一份取值）。 */
export const SEND_MESSAGE_TYPES = POST_KINDS;

const MAX_TARGETS = MAX_COLLAB_MEMBERS - 1;   // 目标上限 = 名单上限减发起者本人（单一权威：protocol.MAX_COLLAB_MEMBERS）

/* 被邀请目标的条目 schema（创建邀请与增邀两工具共用同一形状；上线前的形态把关）。 */
const TARGET_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    instanceId: { type: 'string', description: '目标驿站实例标识（取自 ws_list_hosts）' },
    identityName: { type: 'string', description: '目标身份名（取自 ws_list_hosts；进邀请名单与同意门）' },
    address: { type: 'string', description: '目标地址（IP 字面量）' },
    port: { type: 'integer', description: '目标端口（取自 ws_list_hosts 的端点）' },
  },
  required: ['instanceId', 'identityName', 'address', 'port'],
};

export function listCollabsTool() {
  return {
    name: 'ws_list_collabs',
    description: '列出本机参与的全部协作（角色、状态、待回应邀请与是否过期）——新建协作与同意门处置的入口',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args, context) => okResult({ ok: true, ...context.collab.list() }),
  };
}

/* 入席默认静音的提醒（设计 §3.3）：创建与同意两处成功载荷加一行 notice——要素写死为
 * 「已默认静音／消息不注入本会话／实时观看走观察窗／要本会话实时跟进用 /ws-mute 取消静音」。
 * 提醒只加字段、不动既有字段（工具载荷仍是可直接 JSON.parse 的对象——文本追加会破坏解析面）。 */
const DEFAULT_MUTE_NOTICE = '已默认静音——消息不注入本会话；实时观看走观察窗（/ws-view），要本会话实时跟进用 /ws-mute 取消静音';

/* 成功才加提醒：失败载荷保持纯 message（失败路径没有「已默认静音」可承诺）。 */
function withDefaultMuteNotice(result) {
  return result.ok === true ? { ...result, notice: DEFAULT_MUTE_NOTICE } : result;
}

export function createCollabTool() {
  return {
    name: 'ws_create_collab',
    description: '发起协作或讨论（模式创建时定死、不可变）：向选中目标并行发出邀请（对方在同意门点头后加入）；目标取自 ws_list_hosts 的实例标识与端点',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '项目名（必填；同身份名呈现判据，≤64 字符）' },
        topic: { type: 'string', description: '主题描述（必填；≤200 字符）' },
        mode: { type: 'string', description: `模式（可选，缺省 ${DEFAULT_COLLAB_MODE}）：${COLLAB_MODES.join(' / ')}——forum（讨论）参与者至多 16（含发起人）` },
        targets: { type: 'array', description: `被邀请目标（1–${MAX_TARGETS} 项；讨论模式至多 15 项）`, items: TARGET_ITEM_SCHEMA },
      },
      required: ['name', 'topic', 'targets'],
    },
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
      return resultOf(withDefaultMuteNotice(await context.collab.create({ name, topic, targets, mode })));
    },
  };
}

export function inviteTool() {
  return {
    name: 'ws_invite',
    description: '邀请成员加入既有讨论（对既有讨论发出，重复邀请幂等）——协作（managed）的增员补齐另立任务中，本工具当前仅用于讨论',
    inputSchema: {
      type: 'object',
      properties: {
        collabId: { type: 'string', description: '讨论标识（取自 ws_list_collabs 的 mode=forum 条目）' },
        targets: { type: 'array', description: `被邀请目标（1–${MAX_TARGETS} 项）`, items: TARGET_ITEM_SCHEMA },
      },
      required: ['collabId', 'targets'],
    },
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
    name: 'ws_request_join',
    description: '主动加入讨论：向局域网敲门（广播 + 已知主机单播、少量重发）询问「谁在 <讨论名> 讨论」，返回应答清单（collabId / 名称 / 主题 / 成员数 / 发起人实例标识 / 应答者与地址:端口）。加入流程 = 任一在场成员本机放行（对方执行 ws_invite 邀请你）→ 你在同意门 ws_approve_invite 确认。注意：敲门会把讨论名播给全网（局域网可见）；伪造申请由放行与同意门兜底。无应答时稍后重试或直接联系成员。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '讨论名（必填；同身份名呈现判据，≤64 字符）' },
      },
      required: ['name'],
    },
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
    name: 'ws_approve_invite',
    description: '对一条待回应邀请表态（同意 = 加入协作；拒绝 = 本条不参与，管理者决定继续或取消）',
    inputSchema: {
      type: 'object',
      properties: {
        collabId: { type: 'string', description: '协作标识（取自 ws_list_collabs 的待回应邀请条目）' },
        approve: { type: 'boolean', description: 'true = 同意加入；false = 拒绝' },
        reason: { type: 'string', description: '拒绝原因（可选，仅拒绝时使用，≤200 字符）' },
      },
      required: ['collabId', 'approve'],
    },
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
      const result = await context.collab.approve({ collabId, approve: args.approve, reason });
      /* 提醒只随「同意」：拒绝不入席、不写静音，带上提醒会与事实相反。 */
      return resultOf(args.approve === true ? withDefaultMuteNotice(result) : result);
    },
  };
}

export function withdrawInviteTool() {
  return {
    name: 'ws_withdraw_invite',
    description: '撤回邀请（管理者，仅提议中）：指定 target 撤回该条；省略 target 整条取消（协作终止）',
    inputSchema: {
      type: 'object',
      properties: {
        collabId: { type: 'string', description: '协作标识' },
        target: { type: 'string', description: '被撤回成员的实例标识（可选；省略 = 整条取消）' },
      },
      required: ['collabId'],
    },
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
    name: 'ws_view_ledger',
    description: '查看协作台账：管理者本机直读；成员在线时向管理者拉取（source=live），管理者离线回退本地快照并标注可能非最新；讨论模式=本地合并视图（帖子列表＋成员表＋端点，标注「本地视图，未与全员核对」）',
    inputSchema: {
      type: 'object',
      properties: {
        collabId: { type: 'string', description: '协作标识（取自 ws_list_collabs）' },
      },
      required: ['collabId'],
    },
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
    name: 'ws_send_message',
    description: '发送协作域消息（星型路由：成员发给管理者；管理者省略 to 即发全体成员）——离线时消息排队、对方重开后送达；讨论模式为发帖（人人可见、to 参数一律拒绝）：默认经中继（发起人）投递（成员投稿至中继、由其转达全员），中继不可达时自动降级直投——返回的 route 字段如实标注本机走的路（relay/degraded/fanout）、results 为投稿或直投的受理态，成员级结果经中继聚合捎回、未达者由对方周期对表收敛',
    inputSchema: {
      type: 'object',
      properties: {
        collabId: { type: 'string', description: '协作标识' },
        text: { type: 'string', description: '消息正文（必填，≤4000 字符）' },
        type: { type: 'string', description: `消息类型（可选，缺省 reply；可选值：${SEND_MESSAGE_TYPES.join(' / ')}）` },
        to: { type: 'string', description: '目标成员实例标识（管理者可选；成员省略即发给管理者）' },
      },
      required: ['collabId', 'text'],
    },
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
    name: 'ws_set_mute',
    description: '设置或取消某条协作 / 讨论的静音（纯本地行为开关、不广播、对端无感）：静音期实时内容（讨论帖、协作内容消息）不再注入本会话——经查看器 / ws_check_inbox / ws_view_ledger 补看；结束、邀请与治理等待办照常注入；取消静音时给一行「静音期间新增 N 条」摘要；静音状态持久（跨会话不丢）',
    inputSchema: {
      type: 'object',
      properties: {
        collabId: { type: 'string', description: '本机参与的协作标识（取自 ws_list_collabs）' },
        muted: { type: 'boolean', description: 'true 进入静音 / false 取消静音（必填）' },
      },
      required: ['collabId', 'muted'],
    },
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
    name: 'ws_leave_collab',
    description: '退出某条协作（本机不再参与；管理者收通知并更新台账）——终态数据本地保留',
    inputSchema: {
      type: 'object',
      properties: {
        collabId: { type: 'string', description: '协作标识' },
      },
      required: ['collabId'],
    },
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
    name: 'ws_end_collab',
    description: '结束协作（管理者）：全员收到结束通告、各机把终态台账转归档——结束后不再接受任何协作域消息',
    inputSchema: {
      type: 'object',
      properties: {
        collabId: { type: 'string', description: '协作标识' },
      },
      required: ['collabId'],
    },
    handler: async (args, context) => {
      const collabId = collabIdArg(args);
      if (collabId === null) {
        return errorResult('参数 collabId 非法：需要非空白字符串');
      }
      return resultOf(await context.collab.end({ collabId }));
    },
  };
}

/* 工具返回口径（19 工具单一权威）：成功 = 顶层含 ok:true 的 JSON 对象（列表载荷用命名字段承载：
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

function optionalTextArg(args, name) {
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
  const instanceId = typeof entry.instanceId === 'string' ? entry.instanceId.trim() : '';
  const identityName = typeof entry.identityName === 'string' ? entry.identityName.trim() : '';
  const address = typeof entry.address === 'string' ? entry.address.trim() : '';
  if (instanceId === '' || !ID_PATTERN.test(instanceId) || !isIdentityName(identityName)) {
    return null;
  }
  if (address === '' || isIP(address) === 0 || !isPort(entry.port)) {
    return null;
  }
  return { instanceId, identityName, address, port: entry.port };
}
