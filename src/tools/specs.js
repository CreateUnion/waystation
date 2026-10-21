/* 工具规格单一权威：22 个工具的 name / description / inputSchema——形态即 registry.list() 的输出三元组
 * （src/tools/registry.js）。核心用它注册 handler，桥用它应答 MCP tools/list——核心不在时桥也必须答得上，
 * 故本模块是纯数据：零 import、无运行时依赖，桥侧导入它不认识网络、不认识数据层。
 *
 * 为什么规格里的数值是字面量而不引用协议 / 服务层常量：引用即把 net 层拉进桥的依赖面（桥不认识网络）。
 * 取值一致性由 test/tool-specs-freeze.test.js 反查真实常量与真实默认值守护：成员上限 31 / 16 / 15、
 * 身份名 64、主题与理由 200、正文 4000、模式词表与缺省 managed、消息类型词表与缺省 reply、
 * 收件窗口 50 / 500——常量改了而这里没跟上会响亮失败。词表取值（如裁定取值
 * merge / keep / terminate）与其余措辞不在反查范围：改协议 / 服务常量时须一并核对本文件。
 *
 * 字段本身是对外契约（工具面与 schema 不变）：逐字节冻结在同名测试里，改动任一字符都会让它变红。
 *
 * 参与者是会话（0.2.0）：target / to 指向实例，targetSessionId / toSessionId 指向会话短码（必须成对给出）；
 * 移交与接管走一次性确认令牌。ws_handover 是双角色工具——站长发起（target）与目标确认（offerId）共用
 * 同一个工具，target 因此只在发起角色必填，schema 里放宽为可选、由描述约束角色。 */

/* 被邀请目标的条目 schema（创建邀请与增邀两工具共用同一形状，单一权威保持在本模块）。
 * targetSessionId＝对目标实例的**会话短码**指名（可选）：该目标的邀请只投这一会话、只有它能点头；
 * 省略 = 不指名（投目标机全部活跃会话，谁点头谁承接）——旧版对端忽略该字段，等同不指名（如实）。 */

const TARGET_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    instanceId: { type: 'string', description: '目标驿站实例标识（取自 ws_list_hosts）' },
    identityName: { type: 'string', description: '目标身份名（取自 ws_list_hosts；进邀请名单与同意门）' },
    address: { type: 'string', description: '目标地址（IP 字面量）' },
    port: { type: 'integer', description: '目标端口（取自 ws_list_hosts 的端点）' },
    targetSessionId: { type: 'string', description: '指名会话短码（可选，精确匹配、不做前缀展开）：只投该目标实例上的这一会话、只有它能点头；省略 = 不指名（投全部活跃会话）' },
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
  description: '扫描局域网中在线的驿站（广播段扫 + 单播兜底）：列出身份名、地址:端口、当前参与协作数、对端活跃会话短码与 participants 能力（支持 / 不支持 / 未知——会话级协作要求对端为「支持」，未知可先单播探测）；载荷另含本机段 self（本机身份、端口与活跃终端会话），同机其他数据根的实例在 hosts 里带 sameMachine 标注',
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
  description: '查询已发消息的投递状态：投递记账按机器级——一条逻辑消息向 N 台机器发送＝N 个机器帧、逐机器 msgId（已排队 / 已到对方驿站 / 已投进对方会话——「已投进会话」不等于已被阅读）；本机接收侧另显示逐席位明细（已注入 / 暂存待重连 / 判离席丢弃），远端只显示机器级。讨论模式的帖不落持久队列，两路投递（经中继投稿、降级直投）共用同一档位面：投递中 / 已到对方驿站 / 已投进对方会话 / 未达（待对表收敛，note 字段说明）——中继路径下「已到对方驿站」= 投稿达中继（成员级结果由中继聚合捎回），「已排队」档不适用；系统内部回报条目不逐行列出（其条数见 reportRows）',
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
  description: '读取某协作的收件流水（按保留期窗口）：只返回本会话的收件（含已投递与未投递；默认 50 条、上限 500 条，以 limit 参数为准）；机器级治理提示（如离席、站长变更、结束）对全本机会话可见',
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
  description: '列出本机参与的全部协作（本会话的 sessionRole / sessionState、冻结原因 freezeReason、待回应邀请与是否过期、是否静音）——站长侧条目另含 pendingJoins（两段式入席的待确认申请）；新建协作与同意门处置的入口',
  inputSchema: { type: 'object', properties: {} },
};

export const WS_CREATE_COLLAB_SPEC = {
  name: 'ws_create_collab',
  description: '发起协作或讨论（模式创建时定死、不可变）：创建会话即入席——managed 下本会话任站长（joinSeq=1），forum 下任发起人/中继；向选中目标并行发出邀请（对方在同意门点头后两段式入席）；targets 可带 targetSessionId 指名目标会话；目标取自 ws_list_hosts 的实例标识与端点',
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
  description: '对一条待回应邀请表态（同意 = 本调用会话加入协作；拒绝 = 本条不参与）。首次调用只返回“需要用户确认”与一次性令牌——须先向用户转述邀请、取得明确同意后携 confirmToken 重试；同意后进入两段式入席（joining，确认后转 member）。managed 下同意＝向站长申请；forum 下同意＝本会话直接发 join 成员事件。用户明确说“下一次无需确认”时可先用 ws_allow_next_invite 登记一次性豁免',
  inputSchema: {
    type: 'object',
    properties: {
      collabId: { type: 'string', description: '协作标识（取自 ws_list_collabs 的待回应邀请条目）' },
      approve: { type: 'boolean', description: 'true = 同意加入；false = 拒绝' },
      reason: { type: 'string', description: '拒绝原因（可选，仅拒绝时使用，≤200 字符）' },
      confirmToken: { type: 'string', description: '用户确认挑战令牌（可选）：首次调用会返回 needsUserConfirmation 与令牌；取得用户明确同意后携此令牌重试' },
    },
    required: ['collabId', 'approve'],
  },
};

export const WS_ALLOW_NEXT_INVITE_SPEC = {
  name: 'ws_allow_next_invite',
  description: '登记一次性邀请确认豁免：仅当用户明确表示「下一次邀请无需确认」时调用；下一次同意 / 拒绝邀请将直接生效并消耗豁免（核心重启后失效）。不适用于移交 / 接管等治理确认——那些一律走各自的一次性令牌',
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

export const WS_WITHDRAW_INVITE_SPEC = {
  name: 'ws_withdraw_invite',
  description: '撤回邀请（managed 仅站长；forum 仅撤回本机挂起记录并停止补投，已投出的邀请不可收回）：给 inviteId 撤回该条邀请记录；未给 inviteId 而给 target 时按目标撤回；两者都省略整条取消（协作终止）',
  inputSchema: {
    type: 'object',
    properties: {
      collabId: { type: 'string', description: '协作标识' },
      inviteId: { type: 'string', description: '邀请记录标识（可选；取自 ws_invite 返回的 inviteId——按记录撤回该条邀请）' },
      target: { type: 'string', description: '被撤回目标的实例标识（可选；未给 inviteId 时按目标撤回；与 inviteId 都省略 = 整条取消）' },
    },
    required: ['collabId'],
  },
};

export const WS_VIEW_LEDGER_SPEC = {
  name: 'ws_view_ledger',
  description: '查看协作台账：名单按会话（机器身份名 / 会话短码），含离席历史，旧版协作只读显示；站长本机直读；成员在线时向站长拉取（source=live），站长离线回退本地快照并标注可能非最新；讨论模式=本地合并视图（帖子列表＋成员表＋端点，标注「本地视图，未与全员核对」）',
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
  description: '发送协作域消息（发送者须为本机活跃且非 unverified 席位）：星型路由——成员发给站长，站长省略 to 即发全体成员；按目标机器去重、一机一帧，返回逐机器 msgId；离线时消息排队、对方重开后送达。to＝目标实例/地址，配可选 toSessionId（会话短码，精确匹配；只给会话参数会被拒绝）。讨论模式为发帖（人人可见、to / toSessionId 一律拒绝）：默认经中继（发起人）投递（成员投稿至中继、由其转达全员），中继不可达时自动降级直投——返回的 route 字段如实标注本机走的路（relay/degraded/fanout）、results 为投稿或直投的受理态，成员级结果经中继聚合捎回、未达者由对方周期对表收敛',
  inputSchema: {
    type: 'object',
    properties: {
      collabId: { type: 'string', description: '协作标识' },
      text: { type: 'string', description: '消息正文（必填，≤4000 字符）' },
      type: { type: 'string', description: '消息类型（可选，缺省 reply；可选值：topic / task / progress / issue / stop / reply）' },
      to: { type: 'string', description: '目标成员实例标识或地址（可选；须与 toSessionId 同时给出才能定向席位；协作：站长可选；成员省略即发给站长；讨论一律拒绝）' },
      toSessionId: { type: 'string', description: '目标会话短码（可选，须与 to 同时给出；精确匹配，不做前缀展开）——只投该机器上的这一会话；讨论一律拒绝' },
    },
    required: ['collabId', 'text'],
  },
};

export const WS_SET_MUTE_SPEC = {
  name: 'ws_set_mute',
  description: '设置或取消某条协作 / 讨论中本会话的静音（纯本地行为开关、不广播、对端无感）：只改本席位，同机其他会话不受影响；静音期实时内容（讨论帖、协作内容消息）不再注入本会话——经查看器 / ws_check_inbox / ws_view_ledger 补看；结束、邀请、离席、站长变更与治理等待办照常注入；取消静音时给一行「静音期间新增 N 条」摘要；静音状态随本机席位持久（席位删除即清理）',
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
  description: '退出某条协作（只退本调用会话；协作由站长、讨论由发起人收通知并更新台账）——managed 下站长也可退出（触发自动移交，无其他成员则结束）；终态数据本地保留',
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
  description: '结束协作（managed 仅站长会话；讨论为发起人）：全员收到结束通告、各机把终态台账转归档——结束后不再接受任何协作域消息',
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
  description: '邀请成员加入既有讨论（任何成员可发起、重复邀请幂等）或既有协作（managed 仅站长）：邀请记录生成 inviteId 供后续撤回 / 对账，forum 不生成、不返回 inviteId；已入席机器的新会话请走 ws_join 申请。目标可指名（targetSessionId 只投该会话）或不指名（投目标机当前全部活跃会话，各自独立成席）',
  inputSchema: {
    type: 'object',
    properties: {
      collabId: { type: 'string', description: '协作 / 讨论标识（取自 ws_list_collabs）' },
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

export const WS_JOIN_SPEC = {
  name: 'ws_join',
  description: '申请加入协作或讨论（本会话尚未在席时发起）：协作＝两段式申请——给 collabId 直接申请，只给 name＋target 时先对该目标单播按名解析出 collabId 再申请（名称不广播）；申请直投站长，站长批准后本会话进入 joining，确认（join-confirm）后成为 member。讨论＝本机在席时本会话直接接线生效（无批准门），未在席时封装敲门全流程（等待放行，接线在同意门）。会话标识取本会话上下文——无会话标识的会话无法申请加入（明确拒）。',
  inputSchema: {
    type: 'object',
    properties: {
      collabId: { type: 'string', description: '协作 / 讨论标识（可选；与 name 二选一——给了就跳过按名解析）' },
      name: { type: 'string', description: '协作 / 讨论名（可选；与 collabId 二选一——本机同名在册者直取，否则需 target 按名单播解析）' },
      target: {
        type: 'object',
        description: '按名解析的目标（可选，仅 name 且本机未在册时用）：{ address, port } 或 { instanceId }（后者经已知主机清单解析出端点）',
        properties: {
          address: { type: 'string', description: '目标地址（IP 字面量）' },
          port: { type: 'integer', description: '目标端口' },
          instanceId: { type: 'string', description: '目标实例标识（须在已知主机清单内——先 ws_list_hosts）' },
        },
      },
    },
  },
};

export const WS_APPROVE_JOIN_SPEC = {
  name: 'ws_approve_join',
  description: '批准或拒绝一条待回应的加入申请（站长侧）：批准＝把申请人置入 joining（两段式入席，等对方 join-confirm；收到 confirm 后先入名单再回快照）；拒绝＝回执携原因并出待批准面。待批准清单见 ws_list_collabs 条目的 pendingJoins；批准是活人门（无人点头＝新会话加不进协作，如实）。',
  inputSchema: {
    type: 'object',
    properties: {
      collabId: { type: 'string', description: '协作标识（取自 ws_list_collabs 的 pendingJoins 条目所在协作）' },
      sessionId: { type: 'string', description: '申请人会话标识（短码即可——取 pendingJoins 的 sessionId；精确匹配，不做前缀展开）' },
      approve: { type: 'boolean', description: 'true = 批准加入；false = 拒绝' },
      reason: { type: 'string', description: '拒绝原因（可选，仅拒绝时使用，≤200 字符）' },
    },
    required: ['collabId', 'sessionId', 'approve'],
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
  description: '显式移交（两段式，不开接管窗口）：站长发起＝target＋targetSessionId 指定目标席位（须在线、心跳新鲜），返回 offerId，等待目标用户确认（120 秒）；目标确认＝offerId＋confirmToken（首次调用只返回确认挑战与令牌，须经本机用户确认后携令牌重试）。接受后移交台账与端点：目标升站长、旧站长降为成员；超时后迟到的 accept 一律拒绝',
  inputSchema: {
    type: 'object',
    properties: {
      collabId: { type: 'string', description: '协作标识' },
      target: { type: 'string', description: '目标成员实例标识（站长发起时必填；取自 ws_view_ledger 名单）' },
      targetSessionId: { type: 'string', description: '目标会话短码（站长发起时与 target 同时给出；精确匹配，不做前缀展开）' },
      offerId: { type: 'string', description: '移交邀约标识（目标确认时必填；站长发起成功后返回 offerId）' },
      confirmToken: { type: 'string', description: '用户确认挑战令牌（confirmToken，目标确认时使用）：首次确认调用返回 needsUserConfirmation 与令牌；取得本机用户同意后携此令牌重试' },
    },
    required: ['collabId'],
  },
};

export const WS_TAKE_OVER_SPEC = {
  name: 'ws_take_over',
  description: '接管（成员侧）：仅当站长不可达（本地已冻结 manager-offline，或已超过站长失联判定时限）或自动移交后的接管窗口内可用；不再有收集窗口与候选优先序。首次调用只返回确认挑战与令牌——须先向本机用户确认后携 confirmToken 重试；无令牌的 confirm:true 一律拒绝。发起前先握手取可达成员最高 (managerTerm, version) 台账作基准，取不到则拒绝；接管后不开新窗口',
  inputSchema: {
    type: 'object',
    properties: {
      collabId: { type: 'string', description: '协作标识' },
      confirmToken: { type: 'string', description: '用户确认挑战令牌：首次调用返回 needsUserConfirmation 与令牌；取得本机用户确认后携此令牌重试' },
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
  WS_ALLOW_NEXT_INVITE_SPEC,
  WS_WITHDRAW_INVITE_SPEC,
  WS_VIEW_LEDGER_SPEC,
  WS_SEND_MESSAGE_SPEC,
  WS_SET_MUTE_SPEC,
  WS_LEAVE_COLLAB_SPEC,
  WS_END_COLLAB_SPEC,
  WS_INVITE_SPEC,
  WS_REQUEST_JOIN_SPEC,
  WS_JOIN_SPEC,
  WS_APPROVE_JOIN_SPEC,
  WS_DECIDE_SPEC,
  WS_HANDOVER_SPEC,
  WS_TAKE_OVER_SPEC,
];

export const SPECS_BY_NAME = Object.fromEntries(TOOL_SPECS.map((spec) => [spec.name, spec]));
