/* 工具规格单一权威：19 个工具的 name / description / inputSchema——形态即 registry.list() 的输出三元组
 * （src/tools/registry.js）。核心用它注册 handler，桥用它应答 MCP tools/list——核心不在时桥也必须答得上，
 * 故本模块是纯数据：零 import、无运行时依赖，桥侧导入它不认识网络、不认识数据层。
 *
 * 为什么规格里的数值是字面量而不引用协议 / 服务层常量：引用即把 net 层拉进桥的依赖面（桥不认识网络）。
 * 取值一致性由 test/tool-specs-freeze.test.js 反查真实常量与真实默认值守护：成员上限 31 / 16 / 15、
 * 身份名 64、主题与理由 200、正文 4000、模式词表与缺省 managed、消息类型词表与缺省 reply、
 * 收件窗口 50 / 500、抢接窗口 30s——常量改了而这里没跟上会响亮失败。词表取值（如裁定取值
 * merge / keep / terminate）与其余措辞不在反查范围：改协议 / 服务常量时须一并核对本文件。
 *
 * 字段本身是对外契约（工具面与 schema 不变）：逐字节冻结在同名测试里，改动任一字符都会让它变红。 */

/* 被邀请目标的条目 schema（创建邀请与增邀两工具共用同一形状，单一权威保持在本模块）。 */

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

export const WS_STATUS_SPEC = {
  name: 'ws_status',
  description: '查看本机驿站状态（版本、实例标识、数据目录、端口配置、网络状态等）——会话期首检与排障使用',
  inputSchema: { type: 'object', properties: {} },
};

export const WS_LIST_HOSTS_SPEC = {
  name: 'ws_list_hosts',
  description: '扫描局域网中在线的驿站（广播段扫 + 单播兜底）：列出身份名、地址:端口与当前参与协作数；载荷另含本机段 self（本机身份、端口与活跃终端会话），同机其他数据根的实例在 hosts 里带 sameMachine 标注',
  inputSchema: { type: 'object', properties: {} },
};

export const WS_PING_SPEC = {
  name: 'ws_ping',
  description: '探测某台机器的驿站是否可达（TCP 拨入 + ping/pong 往返延迟）——端口取自 ws_list_hosts 的端点',
  inputSchema: {
    type: 'object',
    properties: {
      address: { type: 'string', description: '目标地址（IPv4/IPv6 字面量，不做域名解析）' },
      port: { type: 'integer', description: '目标驿站端口（取自 ws_list_hosts 的端点）' },
    },
    required: ['address', 'port'],
  },
};

export const WS_DELIVERY_STATUS_SPEC = {
  name: 'ws_delivery_status',
  description: '查询已发消息的投递状态（已排队 / 已到对方驿站 / 已投进对方会话——「已投进会话」不等于已被阅读）；讨论模式的帖不落持久队列，两路投递（经中继投稿、降级直投）共用同一档位面：投递中 / 已到对方驿站 / 已投进对方会话 / 未达（待对表收敛，note 字段说明）——中继路径下「已到对方驿站」= 投稿达中继（成员级结果由中继聚合捎回），「已排队」档不适用；系统内部回报条目不逐行列出（其条数见 reportRows）',
  inputSchema: {
    type: 'object',
    properties: {
      msgId: { type: 'string', description: '按消息标识过滤（可选）' },
      collabId: { type: 'string', description: '按协作过滤（可选）' },
    },
  },
};

export const WS_CHECK_INBOX_SPEC = {
  name: 'ws_check_inbox',
  description: '读取某协作的收件流水（按保留期窗口）：返回最近的消息（含已投递与未投递；默认 50 条、上限 500 条，以 limit 参数为准）',
  inputSchema: {
    type: 'object',
    properties: {
      collabId: { type: 'string', description: '协作标识（必填）' },
      limit: { type: 'integer', description: '返回最近条数（可选，默认 50，上限 500）' },
    },
    required: ['collabId'],
  },
};

export const WS_LIST_COLLABS_SPEC = {
  name: 'ws_list_collabs',
  description: '列出本机参与的全部协作（角色、状态、待回应邀请与是否过期、是否静音）——新建协作与同意门处置的入口',
  inputSchema: { type: 'object', properties: {} },
};

export const WS_CREATE_COLLAB_SPEC = {
  name: 'ws_create_collab',
  description: '发起协作或讨论（模式创建时定死、不可变）：向选中目标并行发出邀请（对方在同意门点头后加入）；目标取自 ws_list_hosts 的实例标识与端点',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '项目名（必填；同身份名呈现判据，≤64 字符）' },
      topic: { type: 'string', description: '主题描述（必填；≤200 字符）' },
      mode: { type: 'string', description: '模式（可选，缺省 managed）：managed / forum——forum（讨论）参与者至多 16（含发起人）' },
      targets: { type: 'array', description: '被邀请目标（1–31 项；讨论模式至多 15 项）', items: TARGET_ITEM_SCHEMA },
    },
    required: ['name', 'topic', 'targets'],
  },
};

export const WS_APPROVE_INVITE_SPEC = {
  name: 'ws_approve_invite',
  description: '对一条待回应邀请表态（同意 = 加入协作；拒绝 = 本条不参与，邀请方决定继续或取消）',
  inputSchema: {
    type: 'object',
    properties: {
      collabId: { type: 'string', description: '协作标识（取自 ws_list_collabs 的待回应邀请条目）' },
      approve: { type: 'boolean', description: 'true = 同意加入；false = 拒绝' },
      reason: { type: 'string', description: '拒绝原因（可选，仅拒绝时使用，≤200 字符）' },
    },
    required: ['collabId', 'approve'],
  },
};

export const WS_WITHDRAW_INVITE_SPEC = {
  name: 'ws_withdraw_invite',
  description: '撤回邀请（站长；讨论为发起人，仅提议中）：指定 target 撤回该条；省略 target 整条取消（协作终止）',
  inputSchema: {
    type: 'object',
    properties: {
      collabId: { type: 'string', description: '协作标识' },
      target: { type: 'string', description: '被撤回成员的实例标识（可选；省略 = 整条取消）' },
    },
    required: ['collabId'],
  },
};

export const WS_VIEW_LEDGER_SPEC = {
  name: 'ws_view_ledger',
  description: '查看协作台账：站长本机直读；成员在线时向站长拉取（source=live），站长离线回退本地快照并标注可能非最新；讨论模式=本地合并视图（帖子列表＋成员表＋端点，标注「本地视图，未与全员核对」）',
  inputSchema: {
    type: 'object',
    properties: {
      collabId: { type: 'string', description: '协作标识（取自 ws_list_collabs）' },
    },
    required: ['collabId'],
  },
};

export const WS_SEND_MESSAGE_SPEC = {
  name: 'ws_send_message',
  description: '发送协作域消息（星型路由：成员发给站长；站长省略 to 即发全体成员）——离线时消息排队、对方重开后送达；讨论模式为发帖（人人可见、to 参数一律拒绝）：默认经中继（发起人）投递（成员投稿至中继、由其转达全员），中继不可达时自动降级直投——返回的 route 字段如实标注本机走的路（relay/degraded/fanout）、results 为投稿或直投的受理态，成员级结果经中继聚合捎回、未达者由对方周期对表收敛',
  inputSchema: {
    type: 'object',
    properties: {
      collabId: { type: 'string', description: '协作标识' },
      text: { type: 'string', description: '消息正文（必填，≤4000 字符）' },
      type: { type: 'string', description: '消息类型（可选，缺省 reply；可选值：topic / task / progress / issue / stop / reply）' },
      to: { type: 'string', description: '目标成员实例标识（协作：站长可选；成员省略即发给站长；讨论一律拒绝）' },
    },
    required: ['collabId', 'text'],
  },
};

export const WS_SET_MUTE_SPEC = {
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
};

export const WS_LEAVE_COLLAB_SPEC = {
  name: 'ws_leave_collab',
  description: '退出某条协作（本机不再参与；协作由站长、讨论由发起人收通知并更新台账）——终态数据本地保留',
  inputSchema: {
    type: 'object',
    properties: {
      collabId: { type: 'string', description: '协作标识' },
    },
    required: ['collabId'],
  },
};

export const WS_END_COLLAB_SPEC = {
  name: 'ws_end_collab',
  description: '结束协作（站长；讨论为发起人）：全员收到结束通告、各机把终态台账转归档——结束后不再接受任何协作域消息',
  inputSchema: {
    type: 'object',
    properties: {
      collabId: { type: 'string', description: '协作标识' },
    },
    required: ['collabId'],
  },
};

export const WS_INVITE_SPEC = {
  name: 'ws_invite',
  description: '邀请成员加入既有讨论（对既有讨论发出，重复邀请幂等）——协作（managed）的增员补齐另立任务中，本工具当前仅用于讨论',
  inputSchema: {
    type: 'object',
    properties: {
      collabId: { type: 'string', description: '讨论标识（取自 ws_list_collabs 的 mode=forum 条目）' },
      targets: { type: 'array', description: '被邀请目标（1–31 项）', items: TARGET_ITEM_SCHEMA },
    },
    required: ['collabId', 'targets'],
  },
};

export const WS_REQUEST_JOIN_SPEC = {
  name: 'ws_request_join',
  description: '主动加入讨论：向局域网敲门（广播 + 已知主机单播、少量重发）询问「谁在 <讨论名> 讨论」，返回应答清单（collabId / 名称 / 主题 / 成员数 / 发起人实例标识 / 应答者与地址:端口）。加入流程 = 任一在场成员本机放行（对方执行 ws_invite 邀请你）→ 你在同意门 ws_approve_invite 确认。注意：敲门会把讨论名播给全网（局域网可见）；伪造申请由放行与同意门兜底。无应答时稍后重试或直接联系成员。',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '讨论名（必填；同身份名呈现判据，≤64 字符）' },
    },
    required: ['name'],
  },
};

export const WS_DECIDE_SPEC = {
  name: 'ws_decide',
  description: '裁定（站长席位）：冻结中三选一——merge（合并；建议发起更早者任站长，名单并集、新增成员走同意门）/ keep（保持两条，需明示）/ terminate（终止本方一条）；合流递交裁定用 mergeOffer=accept|reject',
  inputSchema: {
    type: 'object',
    properties: {
      collabId: { type: 'string', description: '协作标识（取自 ws_list_collabs）' },
      choice: { type: 'string', enum: ['merge', 'keep', 'terminate'], description: '冻结裁定：合并 / 保持两条 / 终止' },
      mergeOffer: { type: 'string', enum: ['accept', 'reject'], description: '合流递交裁定：采纳看板增量 / 丢弃' },
    },
    required: ['collabId'],
  },
};

export const WS_HANDOVER_SPEC = {
  name: 'ws_handover',
  description: '显式交接（站长席位）：把站长席位移交给在线成员（先确认后删除——对方校验并回执后本机才清理台账）；目标离线会被拒绝（应急走 ws_take_over 抢接）',
  inputSchema: {
    type: 'object',
    properties: {
      collabId: { type: 'string', description: '协作标识' },
      target: { type: 'string', description: '目标成员实例标识（取自 ws_view_ledger 名单）' },
    },
    required: ['collabId', 'target'],
  },
};

export const WS_TAKE_OVER_SPEC = {
  name: 'ws_take_over',
  description: '抢接（成员侧，站长被判失联后）：缺省发起——广播收集窗口（默认 30s）并持续探测原站长；窗口结束若本机为最高优先候选，经本机人确认后用 confirm: true 生效（含生效前最后探测）、false 放弃（顺位候选会收到重排提示）',
  inputSchema: {
    type: 'object',
    properties: {
      collabId: { type: 'string', description: '协作标识' },
      confirm: { type: 'boolean', description: '确认分支：true = 生效；false = 放弃；省略 = 发起收集窗口' },
    },
    required: ['collabId'],
  },
};

/* 全量有序表（顺序即核心注册序、亦即 tools/list 对外顺序）；按名索引供按需取单项。 */
export const TOOL_SPECS = [
  WS_STATUS_SPEC,
  WS_LIST_HOSTS_SPEC,
  WS_PING_SPEC,
  WS_DELIVERY_STATUS_SPEC,
  WS_CHECK_INBOX_SPEC,
  WS_LIST_COLLABS_SPEC,
  WS_CREATE_COLLAB_SPEC,
  WS_APPROVE_INVITE_SPEC,
  WS_WITHDRAW_INVITE_SPEC,
  WS_VIEW_LEDGER_SPEC,
  WS_SEND_MESSAGE_SPEC,
  WS_SET_MUTE_SPEC,
  WS_LEAVE_COLLAB_SPEC,
  WS_END_COLLAB_SPEC,
  WS_INVITE_SPEC,
  WS_REQUEST_JOIN_SPEC,
  WS_DECIDE_SPEC,
  WS_HANDOVER_SPEC,
  WS_TAKE_OVER_SPEC,
];

export const SPECS_BY_NAME = Object.fromEntries(TOOL_SPECS.map((spec) => [spec.name, spec]));
