---
description: 发起一次 waystation 讨论（用法：/ws-discuss <讨论名> <主题…> [参与者…]）
---
<!-- waystation-managed-command -->
用户要用 waystation 发起讨论。参数原文：$ARGUMENTS

解析规则：
- 首段 = 讨论名
- 末尾的词 = 参与者（**可多个**：空格、顿号、逗号分隔均可；也接受 IP 或 IP:端口）。判断方式：先扫描在线驿站，再把参数末尾能对上在线驿站身份名（精确 → 前缀/包含）或地址的词摘出来当参与者
- 中间其余 = 主题。讨论名、主题会进对方同意门，以用户说过的为准：没直接说但上下文有明确依据的，提取成草稿也要在发起前让用户确认；没有依据就当场问——不要编造

流程：

1. 缺讨论名或主题 → 一次问全再动手。
2. 调用 waystation 的 `ws_list_hosts` 扫描在线驿站（候选一律取载荷的 `hosts` 段——「其他驿站」；新载荷另含 `self` 本机段，不参与候选）。若本会话没有 waystation 工具（`mcp__waystation__*` 不存在），提示用户：本会话未加载驿站工具，请**新开**一个 Claude Code 会话再试，不要继续。
3. 顺手调一次 `ws_status`：若载荷带 `identityHint`，向用户转达一次（想改名就帮他写入 config.json 的 `identityName`，说明**下次会话生效**）；不阻断流程，之后照常继续。
4. 敲定参与者（规则与 `/ws-collab` 相同）：
   - **没指定**（末尾没有能对上的词）→ 用 AskUserQuestion 多选（multiSelect: true）把当前在线驿站全部列为候选项（label = 身份名，description = 地址:端口、参与协作数）让用户挑；在线超过 4 个（选项上限）时改为文本列全清单请用户点名。一个都没扫到 → 报告「未扫到在线驿站」+ 排查提示（对方会话是否开着、防火墙是否放行），终止。
   - **部分指定不存在** → 明确提醒「未找到：×××（不在线或名字不符）」，列出在线清单；再用 AskUserQuestion 确认「就用找到的这些继续 / 重新选」。
   - **全部指定都不存在** → 提醒后转入上面的多选流程（同"没指定"）。
   - 拿不准/多重含义 → 列候选让用户挑，不要猜。
5. 调用 `ws_create_collab`：`name` = 讨论名，`topic` = 主题，**`mode` = `'forum'`**（讨论必须显式带上，缺省是协作），`targets` = 每个选中驿站的 `{ instanceId, identityName, address, port }`（取自 `ws_list_hosts` 输出，原样透传）。讨论参与者至多 16 人（含发起人），即 targets 至多 15 项——超了先请用户取舍，不要自行截断。
6. 回执：如实转述返回的讨论标识、成员与各目标投递状态（别只报「成功」）；一句提醒——**邀请已发到对方会话，需要对方那台机器的人同意（对方调 `ws_approve_invite`）后才加入**。本机后续可用 `ws_send_message` 发帖（标签词表 topic / task / progress / issue / stop / reply，缺省 reply）、`ws_view_ledger` 看讨论记录、`ws_invite` 再邀新人（任何成员都可发起）、`ws_leave_collab` 退出；**结束权归发起人**（`ws_end_collab`；成员想退出用 `ws_leave_collab`）。
7. 工具报错（对方不可达、参数被拒等）时把原文转述给用户，不要自行重试或换目标。
