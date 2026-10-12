# waystation（驿站）

局域网内多台机器上的 AI 会话（首期 Claude Code）各自运行一个「驿站」进程（MCP，stdio），
互相发现、按星型管理者模式建立协作并可靠投递消息——不依赖云账号与 Anthropic 服务。

> 状态：阶段二开发中（M1 地基，版本 0.1.0 未发布）。本 README 为骨架，正式说明随 M6 补全。

## 安装

（待 M6：Windows `install.ps1` / Linux `install.sh` 一键脚本、Claude Code MCP 注册、防火墙放行指引。）

## 开发

- 运行环境：Node ≥ 20；唯一运行时依赖 `@modelcontextprotocol/sdk`
- 跑测试：`npm test`
- 手工启动（开发调试）：`node src/index.js`——以 stdio 服务 MCP 客户端；直接在终端启动时无输出属正常（stdout 是协议通道）

## 安全模型（待 M6 完整披露）

局域网全信任、无口令、明文传输：同网设备可扫描、可发邀请，信道不加密不认证。
完整披露与取舍说明随 M6 补入；正式使用前请阅读。
