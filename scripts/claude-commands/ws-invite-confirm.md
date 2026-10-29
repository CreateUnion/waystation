---
description: 邀请人工确认开关（用法：/ws-invite-confirm on|off|status|clear [--permanent]）
---
<!-- waystation-managed-command -->
用户要控制本会话或本机的「收到邀请是否需要人工确认」。参数原文：$ARGUMENTS

流程：

1. 若本会话没有 waystation 工具（`mcp__waystation__*` 不存在），提示用户：本会话未加载驿站工具，请**新开**一个 Claude Code 会话再试，不要继续。
2. 解析参数（只认这四种，不猜）：
   - `on` → `action: 'set'`, `gate: 'invite'`, `requireConfirmation: true`
   - `off` → `action: 'set'`, `gate: 'invite'`, `requireConfirmation: false`
   - `status` → `action: 'status'`, `gate: 'invite'`
   - `clear` → `action: 'clear'`, `gate: 'invite'`
   - 其他值 → 不调用工具，向用户确认要开启、关闭、查询还是清除。
3. 是否带 `--permanent`：带 → `scope: 'persistent'`；不带 → `scope: 'session'`。
4. 调用 `ws_set_confirm_gate`，参数带上第 2、3 步的字段。
5. 若返回 `needsUserConfirmation: true`：把 `summary` 原样转述给用户，**等用户明确同意**，再携返回的 `confirmToken` 重试同一调用；用户不同意就停止，不重试。
6. 回执按结果如实转述：
   - 开启成功：说明本会话（或本机，若 permanent）收到邀请时会恢复逐条人工确认。
   - 关闭成功：说明**只对指名邀请**自动同意；**不指名邀请仍人工**；**拒绝邀请始终人工**。临时值在会话结束或核心重启后失效；永久值是整机级放宽。
   - 查询：如实说「本会话临时值 / 永久默认值 / 当前生效值」三层。
   - 清除：说明临时覆盖已清除（或永久字段已删除、回到默认 true）。
7. 工具报错原文转述，不自行重试或换参数；不要把这个开关扩展到移交 / 接管等治理确认。
