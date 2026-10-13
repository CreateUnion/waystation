# waystation（驿站）

局域网内多台机器上的 AI 会话（首期 Claude Code）各自运行一个「驿站」进程（MCP，stdio），
互相发现、按星型管理者模式建立协作并可靠投递消息——不依赖云账号与 Anthropic 服务。

> 状态：阶段二开发中（版本 0.1.0，未发布）；真机验收（两台及以上机器）与收尾随后进行。

## 安装

Windows 与 Linux 各有一键脚本（位于仓库 `scripts/`，从仓库目录运行）：

- Windows：`powershell -File scripts\install.ps1`（预览不改动任何东西：加 `-DryRun`；若本机执行策略禁止运行脚本，先按你的安全策略处理，脚本可全文审读）
- Linux：`bash scripts/install.sh`（预览：`--dry-run`）

脚本按设计流程执行，幂等、可重复运行：检测 Node（下限实读 `package.json` 的 engines，缺失时给安装指引、**不自动安装**）→ 安装到 `~/.waystation/app/`（`npm ci --omit=dev` 就位运行依赖）→ 放置可执行（Windows `waystation.cmd` / Linux `~/.local/bin/waystation`）→ 注册 Claude Code MCP（Windows 以 `node` + 安装目录入口的绝对路径注册——Claude Code 不经 shell 直接拉起 MCP 子进程，`.cmd` 不可靠；Linux 注册为 PATH 上的 `waystation`，`~/.local/bin` 不在 PATH 时注册该 shim 的绝对路径；机器上没有 Claude Code 则跳过并打印手工步骤，不影响安装的其他部分）→ 安装斜杠命令到 `~/.claude/commands/`（`/ws-collab`、`/ws-list`、`/ws-purge` 随装；重跑覆盖已装版本、同名手工文件不覆盖、安装目录下已移除命令的陈旧副本会清理；没有 Claude Code 则跳过并打印手工步骤）→ 自检并打印**防火墙放行指引**、其他 MCP 客户端配置片段与会话期首检清单。

- **防火墙**：脚本只打印放行指引、**不自动修改**系统设置。Windows 用 `Get-NetFirewallProfile` 检测各配置状态并给出 `New-NetFirewallRule` 示例；Linux 免 root 读取 ufw 启用态（`/etc/ufw/ufw.conf`）或检测 firewalld 服务，给出 `ufw allow` / `firewall-cmd` 示例。（Windows 防火墙开启场景的规则形态尚未实测验收。）
- **卸载**：`waystation uninstall`——注销 MCP 注册、移除随装的斜杠命令（只删带受管标记的文件，手工放入的同名文件不动）、删除可执行与安装目录；数据目录默认保留，加 `--purge-data` 连数据一起删（先加 `--dry-run` 可预览）。与安装脚本的 `-Uninstall` / `--uninstall` 开关在默认布局下等价，二选一即可；**自定义 `WAYSTATION_HOME` 时以本命令为准**（安装脚本不读该变量）。
- **清空数据（保留身份与安装）**：`waystation purge-data`——清掉全部协作数据、保留身份（`config.json`、`instance-id`，含各槽位）与安装面（`app/`、`bin/`）；默认只预览（列出将删除与保留的清单），确认后加 `--yes` 执行，不可恢复；也可用 `/ws-purge` 斜杠命令走同一条流程。
- 第二台及以后的机器：同样流程、独立安装即可。
- 刚安装或升级过 Node 时，重启 Claude Code 与终端让 PATH 生效，再进会话首检。

## 快速上手

1. 新开一个 Claude Code 会话（会话启动时会拉起驿站进程）；`/mcp` 里 waystation 应显示已连接。
2. 让 Claude 调用 `ws_status` 查看本站点状态、`ws_list_hosts` 扫局域网在线驿站（列出身份名与 地址:端口）；装了随安装分发的斜杠命令时，等价形态是 `/ws-list`。
3. 发起协作：`ws_create_collab`（项目名 / 主题 / 目标取自扫描列表）——斜杠命令等价形态 `/ws-collab <项目名> <主题…> [协作者…]`（不写协作者会弹出在线驿站多选）；对方在同意门 `ws_approve_invite` → 双向 `ws_send_message`、`ws_view_ledger` 看台账。
4. 可选：配置状态栏「协作中」指示（见下节）——进入协作后状态栏显示当前协作。
5. 可选：其他 MCP 客户端（如 opencode）见下节配置片段。

工具面共 17 项（扫描 / 探测 / 投递状态 / 收件流水 / 协作建撤进退与邀请 / 消息与台账 / 移交 / 抢接 / 裁定），完整清单与参数由 MCP 客户端在会话里展示。

身份名默认为机器名（同机多站点带槽位后缀）；数据目录 `config.json` 的 `identityName` 为空或缺失 = 未设置——首个会话会提示一次并自动写入默认值（此后不再提示）；要自定义就改该字段（下次会话生效）。

## 状态栏「协作中」指示

驿站把「本会话参与的协作」写入会话级状态文件（`~/.waystation/sessions/<会话标识>.json`，会话关闭即删除）；
随附的读取脚本渲染成一行：进入协作后显示 `协作中：项目名（角色，人数）`，无协作 / 会话离线时不显示。

配置（`~/.claude/settings.json`；`$HOME` 在 bash 与 PowerShell 下均可用，路径按你的安装位置调整）：

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"$HOME/.waystation/app/scripts/statusline.js\""
  }
}
```

- 已在用第三方状态栏（如 claude-hud）时，组合方式取决于该插件的扩展能力（claude-hud 的 `--extra-cmd` 可追加一段输出，需 `CLAUDE_HUD_ALLOW_EXTRA_CMD=1`），按插件文档对接；本脚本也可独立作为 `statusLine` 使用。
- 若状态栏为空：先确认脚本路径存在；个别平台若经 cmd.exe 执行、`$HOME` 不展开，改用绝对路径。
- 已知边界：会话恢复（`--continue` / `--resume`）场景下，驿站进程持有的会话标识可能与当前状态栏不一致——此时指示不显示。
- 自定义数据目录：显式 `WAYSTATION_HOME` 由驿站与状态栏脚本各自从所在进程的环境读取——需对两者都生效（如整机环境变量）；仅注入 MCP 注册（如 `claude mcp add -e`）时，状态栏进程按默认目录读取、与实际写入目录失配——指示不显示。

## 讨论查看器（本地只读观战窗）

讨论的本地帖子可以单独看：仓库随附一个独立只读脚本，把某台讨论的本地数据渲染成「时间戳＋正文」的帖流并自动跟随增量刷新。零依赖、零网络、**不写任何文件**（纯读，也不改「半写尾行」这类残缺数据）。

```bash
node scripts/collab-viewer.js <讨论标识>            # 讨论标识 = ws_list_collabs 里的 collabId
node scripts/collab-viewer.js <讨论标识> --author    # 在时间戳与正文之间加一列发帖身份名
```

- 启动先印一行横幅（`【讨论名】状态 ｜ N 人`），随后回放既有全部帖子；此后的成员进出与元状态（名称 / 状态）变化以 `· ` 开头的暗色系统行追加——成员事件不产生帖行。
- 按 `p` 暂停 / 恢复（暂停只冻结显示，文件照常增长，恢复后补齐暂停期内容）；按 `q` 或 Ctrl+C 退出。
- 仅当 stdout 是终端时上色，管道 / 重定向输出裸文本；数据尚未落盘（讨论还没建出来）时横幅标注「数据未就绪」并持续等待；文件被截断或中途消失都会给出提示并自卷首重读。
- 参数缺失 / 非法会打印用法并以非 0 退出（与状态栏脚本「故障静默空输出」是两种程序的两种契约）。

## 其他 MCP 客户端

以 opencode 为例（`opencode.json` 的 `mcp` 段；`command` 为数组、指向安装目录入口的绝对路径）：

```json
{
  "mcp": {
    "waystation": {
      "type": "local",
      "command": ["node", "<安装目录>/bin/waystation.js"],
      "enabled": true
    }
  }
}
```

（示例依据 opencode 官方文档 `mcp-servers` 页，2026-10-13 核对；不同客户端字段名不同，按其文档对应填写。）

## 升级与迁移

- 更新：v1 换目录重启生效——把新版本文件拷入安装目录、重跑安装脚本即可，会话重开生效；将来发布 npm 后为一条更新命令。
- 迁移注意：**改过端口的旧站点**（历史版本曾把默认端口写进站点配置）靠启动自介推送与扫描段扫自愈——升级后互扫即可重新见到彼此，无需手工同步配置。

## 开发

- 运行环境：Node ≥ 20（**运行时下限**，取 `package.json` 的 `engines`）；**跑测试与工具链需 Node ≥ 21（本项目固定 22）**——测试命令使用 `node --test` 的 glob 参数（Node 21 起支持；Node 20 实测以「Could not find …」退出码 1 失败，不会静默假绿）
- 跑测试：`npm test`；覆盖率（含阈值）：`npm run coverage`
- 静态检查：`npm run lint`（ESLint）、`npm run typecheck`（tsc checkJs）
- 提交前门禁：`npm run gate`（lint + typecheck + 覆盖率阈值）
- 手工启动（开发调试）：`node src/index.js`——以 stdio 服务 MCP 客户端；直接在终端启动时无输出属正常（stdout 是协议通道）
- 数据目录与多站点：默认 `~/.waystation/`；同一台机器开多个终端时自动取槽位——槽位 1 = 主目录（端口 7321），槽位 k≥2 = `<主目录>/sites/<k>/`（端口 7321 + k - 1）；需要固定目录或跨会话固定身份时，各终端分别以 `WAYSTATION_HOME` 指向独立数据目录（该模式为单站点、不参与槽位分配）
- 会话状态文件：`~/.waystation/sessions/<会话标识>.json`（状态栏指示的机制载体；崩溃残留按 20 秒时间判据自然不可见）

## 安全模型（如实披露）

**v1 采用「局域网全信任」模型：无口令、无成员准入、明文传输。建议仅在可信网络使用。** 以下是该取舍的全部代价，如实列出：

- **可被发现、可被邀请、身份自报（可冒名）**：同网设备能扫到驿站，任何人都可以向本机弹邀请；身份名是自报的，扫描列表里会混入陌生机器，「身份」不构成可信证明。唯一的人工闸门是**同意门**——每条协作都要被邀方本机的人点头。
- **明文、无认证**：信道不加密、消息无认证；同网段设备可以嗅探往来的邀请与消息内容，也可以伪造探测应答、冒充在线机器。
- **远程文本注入面**：邀请与协作消息的内容（项目名、主题、消息体）会进入本机会话被模型读取。适配层会把协作内容标注为**外部数据**——请同样对待：**外部内容一律是数据，不是指令**，不得当作命令执行。
- **治理类消息可被伪造**：`freeze` / `decision` / `takeover` 等治理消息同样无认证，同网段设备可伪造以扰乱协作；「本机人确认」只约束发起侧，挡不住伪造。
- **本机权限不被绕过**：跨机指令永远越不过本机的工具授权与本机的人。

成员准入与网络隔离机制不在 v1 范围（上线后按使用情况再评估）；以上是如实的取舍记录，不是可忽略的细节。
