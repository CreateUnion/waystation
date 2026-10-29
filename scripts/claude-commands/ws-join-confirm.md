---
description: 加入申请人工批准开关（用法：/ws-join-confirm on|off|status|clear [--permanent]）
---
<!-- waystation-managed-command -->
用户要控制本会话或本机「作为站长收到加入申请时是否需要人工批准」。参数原文：$ARGUMENTS

流程：

1. 若本会话没有 waystation 工具（`mcp__waystation__*` 不存在），提示用户：本会话未加载驿站工具，请**新开**一个 Claude Code 会话再试，不要继续。
2. 解析参数（只认这四种，不猜）：
   - `on` → `action: 'set'`, `gate: 'join'`, `requireConfirmation: true`
   - `off` → `action: 'set'`, `gate: 'join'`, `requireConfirmation: false`
   - `status` → `action: 'status'`, `gate: 'join'`
   - `clear` → `action: 'clear'`, `gate: 'join'`
   - 其他值 → 不调用工具，向用户确认要开启、关闭、查询还是清除。
3. 是否带 `--permanent`：带 → `scope: 'persistent'`；不带 → `scope: 'session'`。
4. 调用 `ws_set_confirm_gate`，参数带上第 2、3 步的字段。
5. 若返回 `needsUserConfirmation: true`：把 `summary` 原样转述给用户，**等用户明确同意**，再携返回的 `confirmToken` 重试；用户不同意就停止。
6. 回执按结果如实转述：
   - 开启成功：本会话（或本机）收到加入申请时会恢复逐条人工批准。
   - 关闭成功：必须明确告诉用户——`join off` 会让**整条入席自动走完**：站长侧自动批准，申请人侧的 `join-confirm` 是申请人核心自动发送的协议帧，不是第二次人工确认；**站长桥断开期间仍会继续自动批准**（本设计的取舍）。拒绝申请仍走人工确认。
   - 查询：如实说「本会话临时值 / 永久默认值 / 当前生效值」三层。
   - 清除：说明临时覆盖已清除（或永久字段已删除、回到默认 true）。
7. 工具报错原文转述，不自行重试或换参数。
