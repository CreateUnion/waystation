---
description: 发起一次 waystation 协作（用法：/ws-collab <对方> <项目名> <主题…>）
---
<!-- waystation-managed-command -->
用户要用 waystation 发起协作。参数原文：$ARGUMENTS

解析规则（按空格切分；主题可带空格或引号，取「其余全部」）：
- 第一段 = 对方：身份名（可用逗号/顿号分隔多个），也接受 IP 或 IP:端口
- 第二段 = 项目名
- 其余 = 主题

缺对方/项目名/主题时，把缺的（可一次问全）问清楚再动手，不要编造——主题会进入对方本机的同意门，必须是用户的原话。

步骤：

1. 调用 waystation 的 `ws_list_hosts` 扫描在线驿站。若本会话没有 waystation 工具（`mcp__waystation__*` 不存在），提示用户：本会话未加载驿站工具，请**新开**一个 Claude Code 会话再试，不要继续。
2. 逐段匹配对方：
   - 身份名先精确匹配，再前缀/包含模糊匹配；IP[:端口] 按地址（可选端口）匹配
   - 唯一命中 → 直接选；0 个命中 → 列出完整在线清单（身份名 + 地址:端口）让用户挑；多个命中 → 列候选让用户挑。**不要猜**
3. 调用 `ws_create_collab`：`name` = 项目名，`topic` = 主题，`targets` = 每个命中驿站的 `{ instanceId, identityName, address, port }`（取自 `ws_list_hosts` 输出，原样透传）。
4. 回执：如实转述返回的协作标识、成员与各目标投递状态（别只报「成功」）；一句提醒——**邀请已发到对方会话，需要对方那台机器的人同意（对方调 `ws_approve_invite`）后才建立**；本机后续可用 `ws_list_collabs` 看协作、`ws_send_message` 发消息、`ws_view_ledger` 看台账。
5. 工具报错（对方不可达、参数被拒等）时把原文转述给用户，不要自行重试或换目标。
