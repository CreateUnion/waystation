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
import { listCollabsTool, createCollabTool, approveInviteTool, withdrawInviteTool, viewLedgerTool, sendMessageTool, setMuteTool, leaveCollabTool, endCollabTool, inviteTool, requestJoinTool, SEND_MESSAGE_TYPES } from '../src/tools/collab.js';
import { decideTool, handoverTool, takeOverTool } from '../src/tools/governance.js';
import { COLLAB_MODES, DEFAULT_COLLAB_MODE, MAX_COLLAB_MEMBERS, MAX_IDENTITY_NAME_CHARS, MAX_MESSAGE_TEXT_CHARS, MAX_REASON_CHARS, MAX_TOPIC_CHARS } from '../src/net/protocol.js';
import { MAX_FORUM_MEMBERS } from '../src/collab/model.js';
import { buildDefaults } from '../src/config.js';
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
  withdrawInviteTool,
  viewLedgerTool,
  sendMessageTool,
  setMuteTool,
  leaveCollabTool,
  endCollabTool,
  inviteTool,
  requestJoinTool,
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

test('工具面冻结快照：19 项逐字节不变', () => {
  const listed = coreToolList();
  assert.equal(listed.length, 19, '工具数为 19——增删工具属须人批准的对外变更');
  assert.equal(
    JSON.stringify(listed, null, 2),
    FROZEN_LIST_JSON,
    '工具规格与冻结基准不符：先确认是否为有意的对外变更，再决定改快照还是修回归',
  );
});

test('规格模块：19 项无遗漏，按名索引与注册序一致', () => {
  assert.equal(TOOL_SPECS.length, 19, '规格模块须与工具数一一对应');
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
  const targetLimit = MAX_COLLAB_MEMBERS - 1;
  const forumTargetLimit = MAX_FORUM_MEMBERS - 1;
  const takeoverWindowSec = buildDefaults('本机').takeoverWindowMs / 1000;

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
  assert.ok(SPECS_BY_NAME.ws_take_over.description.includes(`默认 ${takeoverWindowSec}s`));
  /* 「缺省 reply」不是常量、而是工具层对缺省消息类型的承诺：调 handler 反查真实值
   * （服务层另有一层同值兜底，属纵深防御）。 */
  const defaultType = await sendMessageDefaultType();
  assert.ok(SPECS_BY_NAME.ws_send_message.inputSchema.properties.type.description.includes(`缺省 ${defaultType}`));
});

/* 未传 type 时工具层实际发出的类型——假 collab 只记录入参。 */
async function sendMessageDefaultType() {
  let sent = null;
  await sendMessageTool().handler({ collabId: 'collab-1', text: '正文' }, {
    collab: { send: (args) => { sent = args; return { ok: true }; } },
  });
  return sent.type;
}

/* 冻结基准：19 工具注册后 JSON.stringify(registry.list(), null, 2) 的全量输出（改造前从当前树生成）。
 * 文本级固化——缩进与换行也是比对范围，故整段贴在此处、不手工编辑。
 * 新增本机段带来的两条描述变更（有意对外变更）：ws_list_hosts 描述补「本机段 self 与同机
 * sameMachine 标注」、ws_list_collabs 描述补「是否静音」——描述同步后按规程整体重冻，md5 由
 * 5f087a6b36bcbdd2ab37ed5fb0fec9c4（改造前基准）更新为 56533a014d0eafc7be51e92f67d85911
 * （10871 字符）；其余 17 项与全部 schema 逐字节未动（本次 diff 只有下方两行描述变化）。
 * 站长更名批与讨论侧措辞修的描述变更（有意对外变更）：工具描述统一改称「站长」（10 行），
 * 五处再作模式精确化（ws_end_collab / ws_withdraw_invite / ws_approve_invite / ws_send_message·to
 * / ws_leave_collab——补「讨论为发起人」「邀请方」等两模式口径）——按规程重冻，md5 由
 * 56533a014d0eafc7be51e92f67d85911 更新为 05adcc78fd1add8e83b902b536bd18ae（10893 字符）；
 * 全部 schema 与结构逐字节未动。 */
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
    "description": "扫描局域网中在线的驿站（广播段扫 + 单播兜底）：列出身份名、地址:端口与当前参与协作数；载荷另含本机段 self（本机身份、端口与活跃终端会话），同机其他数据根的实例在 hosts 里带 sameMachine 标注",
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
    "description": "查询已发消息的投递状态（已排队 / 已到对方驿站 / 已投进对方会话——「已投进会话」不等于已被阅读）；讨论模式的帖不落持久队列，两路投递（经中继投稿、降级直投）共用同一档位面：投递中 / 已到对方驿站 / 已投进对方会话 / 未达（待对表收敛，note 字段说明）——中继路径下「已到对方驿站」= 投稿达中继（成员级结果由中继聚合捎回），「已排队」档不适用；系统内部回报条目不逐行列出（其条数见 reportRows）",
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
    "description": "读取某协作的收件流水（按保留期窗口）：返回最近的消息（含已投递与未投递；默认 50 条、上限 500 条，以 limit 参数为准）",
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
    "description": "列出本机参与的全部协作（角色、状态、待回应邀请与是否过期、是否静音）——新建协作与同意门处置的入口",
    "inputSchema": {
      "type": "object",
      "properties": {}
    }
  },
  {
    "name": "ws_create_collab",
    "description": "发起协作或讨论（模式创建时定死、不可变）：向选中目标并行发出邀请（对方在同意门点头后加入）；目标取自 ws_list_hosts 的实例标识与端点",
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
    "description": "对一条待回应邀请表态（同意 = 加入协作；拒绝 = 本条不参与，邀请方决定继续或取消）",
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
        }
      },
      "required": [
        "collabId",
        "approve"
      ]
    }
  },
  {
    "name": "ws_withdraw_invite",
    "description": "撤回邀请（站长；讨论为发起人，仅提议中）：指定 target 撤回该条；省略 target 整条取消（协作终止）",
    "inputSchema": {
      "type": "object",
      "properties": {
        "collabId": {
          "type": "string",
          "description": "协作标识"
        },
        "target": {
          "type": "string",
          "description": "被撤回成员的实例标识（可选；省略 = 整条取消）"
        }
      },
      "required": [
        "collabId"
      ]
    }
  },
  {
    "name": "ws_view_ledger",
    "description": "查看协作台账：站长本机直读；成员在线时向站长拉取（source=live），站长离线回退本地快照并标注可能非最新；讨论模式=本地合并视图（帖子列表＋成员表＋端点，标注「本地视图，未与全员核对」）",
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
    "description": "发送协作域消息（星型路由：成员发给站长；站长省略 to 即发全体成员）——离线时消息排队、对方重开后送达；讨论模式为发帖（人人可见、to 参数一律拒绝）：默认经中继（发起人）投递（成员投稿至中继、由其转达全员），中继不可达时自动降级直投——返回的 route 字段如实标注本机走的路（relay/degraded/fanout）、results 为投稿或直投的受理态，成员级结果经中继聚合捎回、未达者由对方周期对表收敛",
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
          "description": "目标成员实例标识（协作：站长可选；成员省略即发给站长；讨论一律拒绝）"
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
    "description": "设置或取消某条协作 / 讨论的静音（纯本地行为开关、不广播、对端无感）：静音期实时内容（讨论帖、协作内容消息）不再注入本会话——经查看器 / ws_check_inbox / ws_view_ledger 补看；结束、邀请与治理等待办照常注入；取消静音时给一行「静音期间新增 N 条」摘要；静音状态持久（跨会话不丢）",
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
    "description": "退出某条协作（本机不再参与；协作由站长、讨论由发起人收通知并更新台账）——终态数据本地保留",
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
    "description": "结束协作（站长；讨论为发起人）：全员收到结束通告、各机把终态台账转归档——结束后不再接受任何协作域消息",
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
    "description": "邀请成员加入既有讨论（对既有讨论发出，重复邀请幂等）——协作（managed）的增员补齐另立任务中，本工具当前仅用于讨论",
    "inputSchema": {
      "type": "object",
      "properties": {
        "collabId": {
          "type": "string",
          "description": "讨论标识（取自 ws_list_collabs 的 mode=forum 条目）"
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
    "description": "显式交接（站长席位）：把站长席位移交给在线成员（先确认后删除——对方校验并回执后本机才清理台账）；目标离线会被拒绝（应急走 ws_take_over 抢接）",
    "inputSchema": {
      "type": "object",
      "properties": {
        "collabId": {
          "type": "string",
          "description": "协作标识"
        },
        "target": {
          "type": "string",
          "description": "目标成员实例标识（取自 ws_view_ledger 名单）"
        }
      },
      "required": [
        "collabId",
        "target"
      ]
    }
  },
  {
    "name": "ws_take_over",
    "description": "抢接（成员侧，站长被判失联后）：缺省发起——广播收集窗口（默认 30s）并持续探测原站长；窗口结束若本机为最高优先候选，经本机人确认后用 confirm: true 生效（含生效前最后探测）、false 放弃（顺位候选会收到重排提示）",
    "inputSchema": {
      "type": "object",
      "properties": {
        "collabId": {
          "type": "string",
          "description": "协作标识"
        },
        "confirm": {
          "type": "boolean",
          "description": "确认分支：true = 生效；false = 放弃；省略 = 发起收集窗口"
        }
      },
      "required": [
        "collabId"
      ]
    }
  }
]`;
