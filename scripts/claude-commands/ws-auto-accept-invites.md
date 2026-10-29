---
description: 会话级邀请免确认开关（兼容旧命令；新命令请用 /ws-invite-confirm）
---
<!-- waystation-managed-command -->
这是旧命令的兼容别名。旧参数方向与新命令相反，**不得**把旧 `on` 朴素映射到新 `on`。参数原文：$ARGUMENTS

映射：

| 旧参数 | 新调用 |
|---|---|
| 空参数或 `on` | `gate: 'invite'`, `requireConfirmation: false`, `scope: 'session'` |
| `off` | `gate: 'invite'`, `requireConfirmation: true`, `scope: 'session'` |
| `status` | `gate: 'invite'`, `action: 'status'` |

流程：

1. 若本会话没有 waystation 工具（`mcp__waystation__*` 不存在），提示用户新开会话，不要继续。
2. 按上表解析参数；其他值不调用工具，向用户确认要开启、关闭还是查询。
3. 调用 `ws_set_confirm_gate`，字段按上表。
4. 回执如实转述：旧 `on` 等于新命令的「免确认」；**只对指名邀请自动同意**，不指名邀请仍人工，**拒绝邀请始终人工**。临时值在会话结束、核心重启后失效。
5. 工具报错原文转述，不自行重试。
