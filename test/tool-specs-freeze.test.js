import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './helpers.js';
import { createToolRegistry } from '../src/tools/registry.js';
import * as specsModule from '../src/tools/specs.js';
import { SPECS_BY_NAME, TOOL_SPECS } from '../src/tools/specs.js';
import { statusTool } from '../src/tools/status.js';
import { hostsTool } from '../src/tools/hosts.js';
import { pingTool } from '../src/tools/ping.js';
import { deliveryStatusTool } from '../src/tools/delivery-status.js';
import { checkInboxTool } from '../src/tools/check-inbox.js';
import { listCollabsTool, createCollabTool, approveInviteTool, allowNextInviteTool, withdrawInviteTool, viewLedgerTool, sendMessageTool, setMuteTool, leaveCollabTool, endCollabTool, inviteTool, requestJoinTool, SEND_MESSAGE_TYPES } from '../src/tools/collab.js';
import { joinTool, approveJoinTool } from '../src/tools/join.js';
import { decideTool, handoverTool, takeOverTool } from '../src/tools/governance.js';
import { COLLAB_MODES, DEFAULT_COLLAB_MODE, MAX_ACTIVE_SEATS, MAX_IDENTITY_NAME_CHARS, MAX_MESSAGE_TEXT_CHARS, MAX_REASON_CHARS, MAX_TOPIC_CHARS } from '../src/net/protocol.js';
import { MAX_FORUM_MEMBERS } from '../src/collab/model.js';
import { CHECK_INBOX_DEFAULT_LIMIT, CHECK_INBOX_MAX_LIMIT } from '../src/net/inbound.js';

/* 工具面冻结：name / description / inputSchema 是对外契约（MCP 客户端可见）——规格外提到
 * src/tools/specs.js 不得改变它一个字节。本文件是这条口径的机器证明：把改造前的 registry.list()
 * 全量输出固化为常量，改造后逐字节比对。
 *
 * 快照红了先别改快照——先判断这是不是有意的对外变更（增删工具、改描述、动 schema）：是，则连同
 * 文档一起改并交人确认；不是，则是回归。 */

/* 装配序＝核心组合根注册序（src/core/main.js 的 registerTools）：tools/list 的对外顺序即此序；
 * 真实装配面的顺序由 server.test.js 的 tools/list 断言兜底，本文件只对规格与规格装配后的输出负责。 */
const TOOL_FACTORIES = [
  statusTool,
  hostsTool,
  pingTool,
  deliveryStatusTool,
  checkInboxTool,
  listCollabsTool,
  createCollabTool,
  approveInviteTool,
  allowNextInviteTool,
  withdrawInviteTool,
  viewLedgerTool,
  sendMessageTool,
  setMuteTool,
  leaveCollabTool,
  endCollabTool,
  inviteTool,
  requestJoinTool,
  joinTool,
  approveJoinTool,
  decideTool,
  handoverTool,
  takeOverTool,
];

function coreToolList() {
  const registry = createToolRegistry();
  for (const factory of TOOL_FACTORIES) {
    registry.register(factory());
  }
  return registry.list();
}

test('工具面冻结快照：22 项逐字节不变', () => {
  const listed = coreToolList();
  assert.equal(listed.length, 22, '工具数为 22——增删工具属须人批准的对外变更');
  assert.equal(
    JSON.stringify(listed, null, 2),
    FROZEN_LIST_JSON,
    '工具规格与冻结基准不符：先确认是否为有意的对外变更，再决定改快照还是修回归',
  );
});

test('规格模块：22 项无遗漏，按名索引与注册序一致', () => {
  assert.equal(TOOL_SPECS.length, 22, '规格模块须与工具数一一对应');
  assert.deepEqual(Object.keys(SPECS_BY_NAME), TOOL_SPECS.map((spec) => spec.name));
  assert.deepEqual(coreToolList().map((tool) => tool.name), TOOL_SPECS.map((spec) => spec.name));
});

/* 模块纯净＝桥侧消费的前提：桥导入规格模块只答 tools/list，不得因此牵入 handler 或服务层
 * （桥不认识协作、不认识网络、不认识数据）。按语句形态扫（行首 import／再导出／取 require），
 * 不对整段文本泛搜——描述文本里出现英文 import 一词不该误红。 */
test('规格模块纯净：无取模块语句，导出全为数据', () => {
  const source = readFileSync(join(repoRoot, 'src', 'tools', 'specs.js'), 'utf8');
  assert.equal(/^\s*import\b/m.test(source), false, '规格模块不得 import 任何模块（含行首动态 import()）');
  assert.equal(/^\s*export\b[^\n]*\bfrom\b/m.test(source), false, '规格模块不得再导出其他模块');
  assert.equal(/^\s*(?:const|let|var)\s+\w+\s*=\s*require\s*\(/m.test(source), false, '规格模块不得取 CommonJS 模块');
  const nonData = Object.entries(specsModule)
    .filter(([, value]) => typeof value !== 'object' || value === null)
    .map(([name]) => name);
  assert.deepEqual(nonData, [], '规格模块的导出只能是数据（对象 / 数组）');
});

/* 规格里的数值是字面量（见 specs.js 头注）——取值一致性靠本测试兜底：凡规格文本里可反查的值，
 * 一律拿真实常量（协议 / 协作模型 / 配置默认值）或真实行为反查；常量改了而规格没跟上，这里响亮失败。 */
test('规格文本与协议 / 服务常量取值一致', async () => {
  const createCollab = SPECS_BY_NAME.ws_create_collab.inputSchema.properties;
  const targetLimit = MAX_ACTIVE_SEATS - 1;
  const forumTargetLimit = MAX_FORUM_MEMBERS - 1;

  assert.ok(createCollab.targets.description.includes(`1–${targetLimit} 项`));
  assert.ok(createCollab.targets.description.includes(`至多 ${forumTargetLimit} 项`));
  assert.ok(createCollab.mode.description.includes(COLLAB_MODES.join(' / ')));
  assert.ok(createCollab.mode.description.includes(`缺省 ${DEFAULT_COLLAB_MODE}`));
  assert.ok(createCollab.mode.description.includes(`至多 ${MAX_FORUM_MEMBERS}（含发起人）`));
  assert.ok(createCollab.name.description.includes(`≤${MAX_IDENTITY_NAME_CHARS} 字符`));
  assert.ok(createCollab.topic.description.includes(`≤${MAX_TOPIC_CHARS} 字符`));
  assert.ok(SPECS_BY_NAME.ws_invite.inputSchema.properties.targets.description.includes(`1–${targetLimit} 项`));
  assert.ok(SPECS_BY_NAME.ws_request_join.inputSchema.properties.name.description.includes(`≤${MAX_IDENTITY_NAME_CHARS} 字符`));
  assert.ok(SPECS_BY_NAME.ws_approve_invite.inputSchema.properties.reason.description.includes(`≤${MAX_REASON_CHARS} 字符`));
  assert.ok(SPECS_BY_NAME.ws_send_message.inputSchema.properties.text.description.includes(`≤${MAX_MESSAGE_TEXT_CHARS} 字符`));
  assert.ok(SPECS_BY_NAME.ws_send_message.inputSchema.properties.type.description.includes(SEND_MESSAGE_TYPES.join(' / ')));
  assert.ok(SPECS_BY_NAME.ws_check_inbox.description.includes(`默认 ${CHECK_INBOX_DEFAULT_LIMIT} 条、上限 ${CHECK_INBOX_MAX_LIMIT} 条`));
  assert.ok(SPECS_BY_NAME.ws_check_inbox.inputSchema.properties.limit.description.includes(`默认 ${CHECK_INBOX_DEFAULT_LIMIT}，上限 ${CHECK_INBOX_MAX_LIMIT}`));
  /* 「缺省 reply」不是常量、而是工具层对缺省消息类型的承诺：调 handler 反查真实值
   * （服务层另有一层同值兜底，属纵深防御）。 */
  const defaultType = await sendMessageDefaultType();
  assert.ok(SPECS_BY_NAME.ws_send_message.inputSchema.properties.type.description.includes(`缺省 ${defaultType}`));
});

/* 会话级参与者 0.2.0 的工具面形态（设计 §9）：这些字段是 handler 接线的对前面——缺一个就说明
 * 规格没跟上设计。此处只断言「存在与语义关键词」，措辞变动不红；逐字节面由冻结快照兜底。 */
test('会话级工具面：双字段定向与确认令牌齐备', () => {
  const propertiesOf = (name) => SPECS_BY_NAME[name].inputSchema.properties;

  const sendMessage = propertiesOf('ws_send_message');
  assert.ok(sendMessage.to.description.includes('实例'));
  assert.ok(sendMessage.toSessionId.description.includes('短码'));
  assert.ok(sendMessage.toSessionId.description.includes('精确匹配'));
  assert.deepEqual(SPECS_BY_NAME.ws_send_message.inputSchema.required, ['collabId', 'text']);

  const handover = propertiesOf('ws_handover');
  assert.ok(handover.targetSessionId.description.includes('短码'));
  assert.ok(handover.offerId.description.includes('offerId'));
  assert.ok(handover.confirmToken.description.includes('confirmToken'));
  assert.equal(handover.target.description.includes('发起'), true, 'target 只在站长发起角色使用');
  assert.deepEqual(SPECS_BY_NAME.ws_handover.inputSchema.required, ['collabId'], '双角色：目标确认不带 target');
  assert.ok(SPECS_BY_NAME.ws_handover.description.includes('120'));
  assert.ok(SPECS_BY_NAME.ws_handover.description.includes('不开'));

  const takeOver = propertiesOf('ws_take_over');
  assert.ok(takeOver.confirmToken.description.includes('令牌'));
  assert.equal(Object.hasOwn(takeOver, 'confirm'), false, '无令牌的 confirm:true 不再暴露');
  assert.deepEqual(SPECS_BY_NAME.ws_take_over.inputSchema.required, ['collabId']);
  assert.ok(SPECS_BY_NAME.ws_take_over.description.includes('不可达'));
  assert.ok(SPECS_BY_NAME.ws_take_over.description.includes('窗口'));
});

test('会话级工具面：返回面与其余工具同步会话语义', () => {
  const propertiesOf = (name) => SPECS_BY_NAME[name].inputSchema.properties;

  assert.ok(SPECS_BY_NAME.ws_invite.description.includes('inviteId'));
  assert.ok(SPECS_BY_NAME.ws_invite.description.includes('forum'));
  assert.equal(Object.hasOwn(propertiesOf('ws_withdraw_invite'), 'inviteId'), true, '撤回作用于 inviteId 记录');

  assert.ok(SPECS_BY_NAME.ws_list_collabs.description.includes('sessionRole'));
  assert.ok(SPECS_BY_NAME.ws_list_collabs.description.includes('sessionState'));
  assert.ok(SPECS_BY_NAME.ws_list_collabs.description.includes('freezeReason'));
  assert.ok(SPECS_BY_NAME.ws_list_collabs.description.includes('pendingJoins'));
  for (const legacyField of ['localBound', 'localGranted', 'grantedRemote', 'published']) {
    assert.equal(SPECS_BY_NAME.ws_list_collabs.description.includes(legacyField), false, `旧四视图字段 ${legacyField} 已移除`);
  }

  assert.ok(SPECS_BY_NAME.ws_list_hosts.description.includes('participants'));
  assert.ok(SPECS_BY_NAME.ws_check_inbox.description.includes('本会话'));
  assert.ok(SPECS_BY_NAME.ws_delivery_status.description.includes('机器级'));
  assert.ok(SPECS_BY_NAME.ws_delivery_status.description.includes('席位明细'));
  assert.ok(SPECS_BY_NAME.ws_set_mute.description.includes('本席位'));
  assert.equal(SPECS_BY_NAME.ws_set_mute.description.includes('跨会话不丢'), false);
  assert.ok(SPECS_BY_NAME.ws_leave_collab.description.includes('只退本调用会话'));
  assert.ok(SPECS_BY_NAME.ws_approve_join.inputSchema.properties.sessionId.description.includes('精确匹配'));
  assert.ok(SPECS_BY_NAME.ws_approve_join.description.includes('joining'));
  assert.ok(SPECS_BY_NAME.ws_join.description.includes('两段式'));
  assert.ok(SPECS_BY_NAME.ws_approve_invite.description.includes('两段式'));
});

/* 参数面不回退（设计 §9）：除 ws_handover 因双角色放宽 target 外，既有必填项一律保持——
 * 工具面对外承诺的最小参数集不得在本批静默缩水。 */
test('既有必填项保持（ws_handover 双角色为例外）', () => {
  const required = {
    ws_ping: ['address', 'port'],
    ws_check_inbox: ['collabId'],
    ws_create_collab: ['name', 'topic', 'targets'],
    ws_approve_invite: ['collabId', 'approve'],
    ws_withdraw_invite: ['collabId'],
    ws_view_ledger: ['collabId'],
    ws_send_message: ['collabId', 'text'],
    ws_set_mute: ['collabId', 'muted'],
    ws_leave_collab: ['collabId'],
    ws_end_collab: ['collabId'],
    ws_invite: ['collabId', 'targets'],
    ws_request_join: ['name'],
    ws_approve_join: ['collabId', 'sessionId', 'approve'],
    ws_decide: ['collabId'],
    ws_take_over: ['collabId'],
  };
  for (const [name, expected] of Object.entries(required)) {
    assert.deepEqual(SPECS_BY_NAME[name].inputSchema.required, expected, `${name} 的必填项不得缩水`);
  }
});

/* 未传 type 时工具层实际发出的类型——假 collab 只记录入参。 */
async function sendMessageDefaultType() {
  let sent = null;
  await sendMessageTool().handler({ collabId: 'collab-1', text: '正文' }, {
    collab: { send: (args) => { sent = args; return { ok: true }; } },
  });
  return sent.type;
}

/* 冻结基准：22 工具注册后 JSON.stringify(registry.list(), null, 2) 的全量输出（本批从当前树生成）。
 * 文本级固化——缩进与换行也是比对范围，故整段贴在此处、不手工编辑。
 * 会话级参与者 0.2.0（工具面保持 22 项，本次重冻的批准流程即本批）：名单与参与者粒度改为会话——
 * ws_send_message 增 toSessionId、ws_handover 增 targetSessionId/offerId/confirmToken 并放宽为双角色、
 * ws_take_over 以 confirmToken 取代无令牌 confirm、ws_invite 描述 inviteId 与 forum 例外、
 * ws_withdraw_invite 增 inviteId、ws_list_collabs / ws_list_hosts / ws_check_inbox / ws_delivery_status
 * 换会话级返回面；其余描述同步会话级语义。按「须人批准的对外变更」规程整体重冻，
 * md5 由 e93ce1f55ba032743a4723f803b97031（13247 字符）更新为 29aee52b9ad324f5797c9f4ccd2eb6fb（15641 字符）。
 * 工具数与顺序（22 项）未变。 */
const FROZEN_LIST_JSON = `[
  {
    "name": "ws_status",
    "description": "查看本机驿站状态（版本、实例标识、数据目录、端口配置、网络状态等）——会话期首检与排障使用",
    "inputSchema": {
      "type": "object",
      "properties": {}
    }
  },
  {
    "name": "ws_list_hosts",
    "description": "扫描局域网中在线的驿站（广播段扫 + 单播兜底）：列出身份名、地址:端口、当前参与协作数、对端活跃会话短码与 participants 能力（支持 / 不支持 / 未知——会话级协作要求对端为「支持」，未知可先单播探测）；载荷另含本机段 self（本机身份、端口与活跃终端会话），同机其他数据根的实例在 hosts 里带 sameMachine 标注",
    "inputSchema": {
      "type": "object",
      "properties": {}
    }
  },
  {
    "name": "ws_ping",
    "description": "探测某台机器的驿站是否可达（TCP 拨入 + ping/pong 往返延迟）——端口取自 ws_list_hosts 的端点",
    "inputSchema": {
      "type": "object",
      "properties": {
        "address": {
          "type": "string",
          "description": "目标地址（IPv4/IPv6 字面量，不做域名解析）"
        },
        "port": {
          "type": "integer",
          "description": "目标驿站端口（取自 ws_list_hosts 的端点）"
        }
      },
      "required": [
        "address",
        "port"
      ]
    }
  },
  {
    "name": "ws_delivery_status",
    "description": "查询已发消息的投递状态：投递记账按机器级——一条逻辑消息向 N 台机器发送＝N 个机器帧、逐机器 msgId（已排队 / 已到对方驿站 / 已投进对方会话——「已投进会话」不等于已被阅读）；本机接收侧另显示逐席位明细（已注入 / 暂存待重连 / 判离席丢弃），远端只显示机器级。讨论模式的帖不落持久队列，两路投递（经中继投稿、降级直投）共用同一档位面：投递中 / 已到对方驿站 / 已投进对方会话 / 未达（待对表收敛，note 字段说明）——中继路径下「已到对方驿站」= 投稿达中继（成员级结果由中继聚合捎回），「已排队」档不适用；系统内部回报条目不逐行列出（其条数见 reportRows）",
    "inputSchema": {
      "type": "object",
      "properties": {
        "msgId": {
          "type": "string",
          "description": "按消息标识过滤（可选）"
        },
        "collabId": {
          "type": "string",
          "description": "按协作过滤（可选）"
        }
      }
    }
  },
  {
    "name": "ws_check_inbox",
    "description": "读取某协作的收件流水（按保留期窗口）：只返回本会话的收件（含已投递与未投递；默认 50 条、上限 500 条，以 limit 参数为准）；机器级治理提示（如离席、站长变更、结束）对全本机会话可见",
    "inputSchema": {
      "type": "object",
      "properties": {
        "collabId": {
          "type": "string",
          "description": "协作标识（必填）"
        },
        "limit": {
          "type": "integer",
          "description": "返回最近条数（可选，默认 50，上限 500）"
        }
      },
      "required": [
        "collabId"
      ]
    }
  },
  {
    "name": "ws_list_collabs",
    "description": "列出本机参与的全部协作（本会话的 sessionRole / sessionState、冻结原因 freezeReason、待回应邀请与是否过期、是否静音）——站长侧条目另含 pendingJoins（两段式入席的待确认申请）；新建协作与同意门处置的入口",
    "inputSchema": {
      "type": "object",
      "properties": {}
    }
  },
  {
    "name": "ws_create_collab",
    "description": "发起协作或讨论（模式创建时定死、不可变）：创建会话即入席——managed 下本会话任站长（joinSeq=1），forum 下任发起人/中继；向选中目标并行发出邀请（对方在同意门点头后两段式入席）；targets 可带 targetSessionId 指名目标会话；目标取自 ws_list_hosts 的实例标识与端点",
    "inputSchema": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "description": "项目名（必填；同身份名呈现判据，≤64 字符）"
        },
        "topic": {
          "type": "string",
          "description": "主题描述（必填；≤200 字符）"
        },
        "mode": {
          "type": "string",
          "description": "模式（可选，缺省 managed）：managed / forum——forum（讨论）参与者至多 16（含发起人）"
        },
        "targets": {
          "type": "array",
          "description": "被邀请目标（1–31 项；讨论模式至多 15 项）",
          "items": {
            "type": "object",
            "properties": {
              "instanceId": {
                "type": "string",
                "description": "目标驿站实例标识（取自 ws_list_hosts）"
              },
              "identityName": {
                "type": "string",
                "description": "目标身份名（取自 ws_list_hosts；进邀请名单与同意门）"
              },
              "address": {
                "type": "string",
                "description": "目标地址（IP 字面量）"
              },
              "port": {
                "type": "integer",
                "description": "目标端口（取自 ws_list_hosts 的端点）"
              },
              "targetSessionId": {
                "type": "string",
                "description": "指名会话短码（可选，精确匹配、不做前缀展开）：只投该目标实例上的这一会话、只有它能点头；省略 = 不指名（投全部活跃会话）"
              }
            },
            "required": [
              "instanceId",
              "identityName",
              "address",
              "port"
            ]
          }
        }
      },
      "required": [
        "name",
        "topic",
        "targets"
      ]
    }
  },
  {
    "name": "ws_approve_invite",
    "description": "对一条待回应邀请表态（同意 = 本调用会话加入协作；拒绝 = 本条不参与）。首次调用只返回“需要用户确认”与一次性令牌——须先向用户转述邀请、取得明确同意后携 confirmToken 重试；同意后进入两段式入席（joining，确认后转 member）。managed 下同意＝向站长申请；forum 下同意＝本会话直接发 join 成员事件。用户明确说“下一次无需确认”时可先用 ws_allow_next_invite 登记一次性豁免",
    "inputSchema": {
      "type": "object",
      "properties": {
        "collabId": {
          "type": "string",
          "description": "协作标识（取自 ws_list_collabs 的待回应邀请条目）"
        },
        "approve": {
          "type": "boolean",
          "description": "true = 同意加入；false = 拒绝"
        },
        "reason": {
          "type": "string",
          "description": "拒绝原因（可选，仅拒绝时使用，≤200 字符）"
        },
        "confirmToken": {
          "type": "string",
          "description": "用户确认挑战令牌（可选）：首次调用会返回 needsUserConfirmation 与令牌；取得用户明确同意后携此令牌重试"
        }
      },
      "required": [
        "collabId",
        "approve"
      ]
    }
  },
  {
    "name": "ws_allow_next_invite",
    "description": "登记一次性邀请确认豁免：仅当用户明确表示「下一次邀请无需确认」时调用；下一次同意 / 拒绝邀请将直接生效并消耗豁免（核心重启后失效）。不适用于移交 / 接管等治理确认——那些一律走各自的一次性令牌",
    "inputSchema": {
      "type": "object",
      "properties": {}
    }
  },
  {
    "name": "ws_withdraw_invite",
    "description": "撤回邀请（managed 仅站长；forum 仅撤回本机挂起记录并停止补投，已投出的邀请不可收回）：给 inviteId 撤回该条邀请记录；未给 inviteId 而给 target 时按目标撤回；两者都省略整条取消（协作终止）",
    "inputSchema": {
      "type": "object",
      "properties": {
        "collabId": {
          "type": "string",
          "description": "协作标识"
        },
        "inviteId": {
          "type": "string",
          "description": "邀请记录标识（可选；取自 ws_invite 返回的 inviteId——按记录撤回该条邀请）"
        },
        "target": {
          "type": "string",
          "description": "被撤回目标的实例标识（可选；未给 inviteId 时按目标撤回；与 inviteId 都省略 = 整条取消）"
        }
      },
      "required": [
        "collabId"
      ]
    }
  },
  {
    "name": "ws_view_ledger",
    "description": "查看协作台账：名单按会话（机器身份名 / 会话短码），含离席历史，旧版协作只读显示；站长本机直读；成员在线时向站长拉取（source=live），站长离线回退本地快照并标注可能非最新；讨论模式=本地合并视图（帖子列表＋成员表＋端点，标注「本地视图，未与全员核对」）",
    "inputSchema": {
      "type": "object",
      "properties": {
        "collabId": {
          "type": "string",
          "description": "协作标识（取自 ws_list_collabs）"
        }
      },
      "required": [
        "collabId"
      ]
    }
  },
  {
    "name": "ws_send_message",
    "description": "发送协作域消息（发送者须为本机活跃且非 unverified 席位）：星型路由——成员发给站长，站长省略 to 即发全体成员；按目标机器去重、一机一帧，返回逐机器 msgId；离线时消息排队、对方重开后送达。to＝目标实例/地址，配可选 toSessionId（会话短码，精确匹配；只给会话参数会被拒绝）。讨论模式为发帖（人人可见、to / toSessionId 一律拒绝）：默认经中继（发起人）投递（成员投稿至中继、由其转达全员），中继不可达时自动降级直投——返回的 route 字段如实标注本机走的路（relay/degraded/fanout）、results 为投稿或直投的受理态，成员级结果经中继聚合捎回、未达者由对方周期对表收敛",
    "inputSchema": {
      "type": "object",
      "properties": {
        "collabId": {
          "type": "string",
          "description": "协作标识"
        },
        "text": {
          "type": "string",
          "description": "消息正文（必填，≤4000 字符）"
        },
        "type": {
          "type": "string",
          "description": "消息类型（可选，缺省 reply；可选值：topic / task / progress / issue / stop / reply）"
        },
        "to": {
          "type": "string",
          "description": "目标成员实例标识或地址（可选；须与 toSessionId 同时给出才能定向席位；协作：站长可选；成员省略即发给站长；讨论一律拒绝）"
        },
        "toSessionId": {
          "type": "string",
          "description": "目标会话短码（可选，须与 to 同时给出；精确匹配，不做前缀展开）——只投该机器上的这一会话；讨论一律拒绝"
        }
      },
      "required": [
        "collabId",
        "text"
      ]
    }
  },
  {
    "name": "ws_set_mute",
    "description": "设置或取消某条协作 / 讨论中本会话的静音（纯本地行为开关、不广播、对端无感）：只改本席位，同机其他会话不受影响；静音期实时内容（讨论帖、协作内容消息）不再注入本会话——经查看器 / ws_check_inbox / ws_view_ledger 补看；结束、邀请、离席、站长变更与治理等待办照常注入；取消静音时给一行「静音期间新增 N 条」摘要；静音状态随本机席位持久（席位删除即清理）",
    "inputSchema": {
      "type": "object",
      "properties": {
        "collabId": {
          "type": "string",
          "description": "本机参与的协作标识（取自 ws_list_collabs）"
        },
        "muted": {
          "type": "boolean",
          "description": "true 进入静音 / false 取消静音（必填）"
        }
      },
      "required": [
        "collabId",
        "muted"
      ]
    }
  },
  {
    "name": "ws_leave_collab",
    "description": "退出某条协作（只退本调用会话；协作由站长、讨论由发起人收通知并更新台账）——managed 下站长也可退出（触发自动移交，无其他成员则结束）；终态数据本地保留",
    "inputSchema": {
      "type": "object",
      "properties": {
        "collabId": {
          "type": "string",
          "description": "协作标识"
        }
      },
      "required": [
        "collabId"
      ]
    }
  },
  {
    "name": "ws_end_collab",
    "description": "结束协作（managed 仅站长会话；讨论为发起人）：全员收到结束通告、各机把终态台账转归档——结束后不再接受任何协作域消息",
    "inputSchema": {
      "type": "object",
      "properties": {
        "collabId": {
          "type": "string",
          "description": "协作标识"
        }
      },
      "required": [
        "collabId"
      ]
    }
  },
  {
    "name": "ws_invite",
    "description": "邀请成员加入既有讨论（任何成员可发起、重复邀请幂等）或既有协作（managed 仅站长）：邀请记录生成 inviteId 供后续撤回 / 对账，forum 不生成、不返回 inviteId；已入席机器的新会话请走 ws_join 申请。目标可指名（targetSessionId 只投该会话）或不指名（投目标机当前全部活跃会话，各自独立成席）",
    "inputSchema": {
      "type": "object",
      "properties": {
        "collabId": {
          "type": "string",
          "description": "协作 / 讨论标识（取自 ws_list_collabs）"
        },
        "targets": {
          "type": "array",
          "description": "被邀请目标（1–31 项）",
          "items": {
            "type": "object",
            "properties": {
              "instanceId": {
                "type": "string",
                "description": "目标驿站实例标识（取自 ws_list_hosts）"
              },
              "identityName": {
                "type": "string",
                "description": "目标身份名（取自 ws_list_hosts；进邀请名单与同意门）"
              },
              "address": {
                "type": "string",
                "description": "目标地址（IP 字面量）"
              },
              "port": {
                "type": "integer",
                "description": "目标端口（取自 ws_list_hosts 的端点）"
              },
              "targetSessionId": {
                "type": "string",
                "description": "指名会话短码（可选，精确匹配、不做前缀展开）：只投该目标实例上的这一会话、只有它能点头；省略 = 不指名（投全部活跃会话）"
              }
            },
            "required": [
              "instanceId",
              "identityName",
              "address",
              "port"
            ]
          }
        }
      },
      "required": [
        "collabId",
        "targets"
      ]
    }
  },
  {
    "name": "ws_request_join",
    "description": "主动加入讨论：向局域网敲门（广播 + 已知主机单播、少量重发）询问「谁在 <讨论名> 讨论」，返回应答清单（collabId / 名称 / 主题 / 成员数 / 发起人实例标识 / 应答者与地址:端口）。加入流程 = 任一在场成员本机放行（对方执行 ws_invite 邀请你）→ 你在同意门 ws_approve_invite 确认。注意：敲门会把讨论名播给全网（局域网可见）；伪造申请由放行与同意门兜底。无应答时稍后重试或直接联系成员。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "description": "讨论名（必填；同身份名呈现判据，≤64 字符）"
        }
      },
      "required": [
        "name"
      ]
    }
  },
  {
    "name": "ws_join",
    "description": "申请加入协作或讨论（本会话尚未在席时发起）：协作＝两段式申请——给 collabId 直接申请，只给 name＋target 时先对该目标单播按名解析出 collabId 再申请（名称不广播）；申请直投站长，站长批准后本会话进入 joining，确认（join-confirm）后成为 member。讨论＝本机在席时本会话直接接线生效（无批准门），未在席时封装敲门全流程（等待放行，接线在同意门）。会话标识取本会话上下文——无会话标识的会话无法申请加入（明确拒）。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "collabId": {
          "type": "string",
          "description": "协作 / 讨论标识（可选；与 name 二选一——给了就跳过按名解析）"
        },
        "name": {
          "type": "string",
          "description": "协作 / 讨论名（可选；与 collabId 二选一——本机同名在册者直取，否则需 target 按名单播解析）"
        },
        "target": {
          "type": "object",
          "description": "按名解析的目标（可选，仅 name 且本机未在册时用）：{ address, port } 或 { instanceId }（后者经已知主机清单解析出端点）",
          "properties": {
            "address": {
              "type": "string",
              "description": "目标地址（IP 字面量）"
            },
            "port": {
              "type": "integer",
              "description": "目标端口"
            },
            "instanceId": {
              "type": "string",
              "description": "目标实例标识（须在已知主机清单内——先 ws_list_hosts）"
            }
          }
        }
      }
    }
  },
  {
    "name": "ws_approve_join",
    "description": "批准或拒绝一条待回应的加入申请（站长侧）：批准＝把申请人置入 joining（两段式入席，等对方 join-confirm；收到 confirm 后先入名单再回快照）；拒绝＝回执携原因并出待批准面。待批准清单见 ws_list_collabs 条目的 pendingJoins；批准是活人门（无人点头＝新会话加不进协作，如实）。",
    "inputSchema": {
      "type": "object",
      "properties": {
        "collabId": {
          "type": "string",
          "description": "协作标识（取自 ws_list_collabs 的 pendingJoins 条目所在协作）"
        },
        "sessionId": {
          "type": "string",
          "description": "申请人会话标识（短码即可——取 pendingJoins 的 sessionId；精确匹配，不做前缀展开）"
        },
        "approve": {
          "type": "boolean",
          "description": "true = 批准加入；false = 拒绝"
        },
        "reason": {
          "type": "string",
          "description": "拒绝原因（可选，仅拒绝时使用，≤200 字符）"
        }
      },
      "required": [
        "collabId",
        "sessionId",
        "approve"
      ]
    }
  },
  {
    "name": "ws_decide",
    "description": "裁定（站长席位）：冻结中三选一——merge（合并；建议发起更早者任站长，名单并集、新增成员走同意门）/ keep（保持两条，需明示）/ terminate（终止本方一条）；合流递交裁定用 mergeOffer=accept|reject",
    "inputSchema": {
      "type": "object",
      "properties": {
        "collabId": {
          "type": "string",
          "description": "协作标识（取自 ws_list_collabs）"
        },
        "choice": {
          "type": "string",
          "enum": [
            "merge",
            "keep",
            "terminate"
          ],
          "description": "冻结裁定：合并 / 保持两条 / 终止"
        },
        "mergeOffer": {
          "type": "string",
          "enum": [
            "accept",
            "reject"
          ],
          "description": "合流递交裁定：采纳看板增量 / 丢弃"
        }
      },
      "required": [
        "collabId"
      ]
    }
  },
  {
    "name": "ws_handover",
    "description": "显式移交（两段式，不开接管窗口）：站长发起＝target＋targetSessionId 指定目标席位（须在线、心跳新鲜），返回 offerId，等待目标用户确认（120 秒）；目标确认＝offerId＋confirmToken（首次调用只返回确认挑战与令牌，须经本机用户确认后携令牌重试）。接受后移交台账与端点：目标升站长、旧站长降为成员；超时后迟到的 accept 一律拒绝",
    "inputSchema": {
      "type": "object",
      "properties": {
        "collabId": {
          "type": "string",
          "description": "协作标识"
        },
        "target": {
          "type": "string",
          "description": "目标成员实例标识（站长发起时必填；取自 ws_view_ledger 名单）"
        },
        "targetSessionId": {
          "type": "string",
          "description": "目标会话短码（站长发起时与 target 同时给出；精确匹配，不做前缀展开）"
        },
        "offerId": {
          "type": "string",
          "description": "移交邀约标识（目标确认时必填；站长发起成功后返回 offerId）"
        },
        "confirmToken": {
          "type": "string",
          "description": "用户确认挑战令牌（confirmToken，目标确认时使用）：首次确认调用返回 needsUserConfirmation 与令牌；取得本机用户同意后携此令牌重试"
        }
      },
      "required": [
        "collabId"
      ]
    }
  },
  {
    "name": "ws_take_over",
    "description": "接管（成员侧）：仅当站长不可达（本地已冻结 manager-offline，或已超过站长失联判定时限）或自动移交后的接管窗口内可用；不再有收集窗口与候选优先序。首次调用只返回确认挑战与令牌——须先向本机用户确认后携 confirmToken 重试；无令牌的 confirm:true 一律拒绝。发起前先握手取可达成员最高 (managerTerm, version) 台账作基准，取不到则拒绝；接管后不开新窗口",
    "inputSchema": {
      "type": "object",
      "properties": {
        "collabId": {
          "type": "string",
          "description": "协作标识"
        },
        "confirmToken": {
          "type": "string",
          "description": "用户确认挑战令牌：首次调用返回 needsUserConfirmation 与令牌；取得本机用户确认后携此令牌重试"
        }
      },
      "required": [
        "collabId"
      ]
    }
  }
]`;
