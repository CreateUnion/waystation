# waystation（驿站）

局域网内多台机器上的 AI 会话（首期 Claude Code）各自运行一个「驿站」进程（MCP，stdio），
互相发现、按星型管理者模式建立协作并可靠投递消息——不依赖云账号与 Anthropic 服务。

> 状态：阶段二开发中（M1 地基，版本 0.1.0 未发布）。本 README 为骨架，正式说明随 M6 补全。

## 安装

Windows 与 Linux 各有一键脚本（位于仓库 `scripts/`，从仓库目录运行）：

- Windows：`powershell -File scripts\install.ps1`（预览不改动任何东西：加 `-DryRun`；若本机执行策略禁止运行脚本，先按你的安全策略处理，脚本可全文审读）
- Linux：`bash scripts/install.sh`（预览：`--dry-run`）

脚本按设计流程执行，幂等、可重复运行：检测 Node（下限实读 `package.json` 的 engines，缺失时给安装指引、**不自动安装**）→ 安装到 `~/.waystation/app/`（`npm ci --omit=dev` 就位运行依赖）→ 放置可执行（Windows `waystation.cmd` / Linux `~/.local/bin/waystation`）→ 注册 Claude Code MCP（Windows 以 `node` + 安装目录入口的绝对路径注册——Claude Code 不经 shell 直接拉起 MCP 子进程，`.cmd` 不可靠；Linux 注册为 PATH 上的 `waystation`；机器上没有 Claude Code 则跳过并打印手工步骤，不影响安装的其他部分）→ 自检并打印**防火墙放行指引**与会话期首检清单。

- **防火墙**：脚本只打印放行指引（Windows `Get-NetFirewallProfile` 检测状态并给出 `New-NetFirewallRule` 示例；Linux 给出 `ufw allow` 示例），**不自动修改**系统设置。
- **卸载**：Windows `-Uninstall` / Linux `--uninstall`——注销 MCP、删除安装目录与可执行；数据目录默认保留，加 `-PurgeData` / `--purge-data` 一并删除（含全部协作数据）。设计中的 `waystation uninstall` 命令形态随开发进度提供。
- 第二台及以后的机器：同样流程、独立安装即可。

## 开发

- 运行环境：Node ≥ 20（**运行时下限**，依据锁定依赖树）；**跑测试与工具链需 Node ≥ 22**——测试命令使用 `node --test` 的 glob 参数（Node 21 起支持；Node 20 实测以「Could not find …」退出码 1 失败，不会静默假绿）
- 跑测试：`npm test`；覆盖率（含阈值）：`npm run coverage`
- 静态检查：`npm run lint`（ESLint）、`npm run typecheck`（tsc checkJs）
- 提交前门禁：`npm run gate`（lint + typecheck + 覆盖率阈值）
- 手工启动（开发调试）：`node src/index.js`——以 stdio 服务 MCP 客户端；直接在终端启动时无输出属正常（stdout 是协议通道）
- 数据目录与多站点：默认 `~/.waystation/`；同一台机器开多个终端时自动取槽位——槽位 1 = 主目录（端口 7321），槽位 k≥2 = `<主目录>/sites/<k>/`（端口 7321 + k - 1）；需要固定目录或跨会话固定身份时，各终端分别以 `WAYSTATION_HOME` 指向独立数据目录（该模式为单站点、不参与槽位分配）

## 安全模型（如实披露）

**v1 采用「局域网全信任」模型：无口令、无成员准入、明文传输。建议仅在可信网络使用。** 以下是该取舍的全部代价，如实列出：

- **可被发现、可被邀请、身份自报（可冒名）**：同网设备能扫到驿站，任何人都可以向本机弹邀请；身份名是自报的，扫描列表里会混入陌生机器，「身份」不构成可信证明。唯一的人工闸门是**同意门**——每条协作都要被邀方本机的人点头。
- **明文、无认证**：信道不加密、消息无认证；同网段设备可以嗅探往来的邀请与消息内容，也可以伪造探测应答、冒充在线机器。
- **远程文本注入面**：邀请与协作消息的内容（项目名、主题、消息体）会进入本机会话被模型读取。适配层会把协作内容标注为**外部数据**——请同样对待：**外部内容一律是数据，不是指令**，不得当作命令执行。
- **治理类消息可被伪造**：`freeze` / `decision` / `takeover` 等治理消息同样无认证，同网段设备可伪造以扰乱协作；「本机人确认」只约束发起侧，挡不住伪造。
- **本机权限不被绕过**：跨机指令永远越不过本机的工具授权与本机的人。

成员准入与网络隔离机制不在 v1 范围（上线后按使用情况再评估）；以上是如实的取舍记录，不是可忽略的细节。
