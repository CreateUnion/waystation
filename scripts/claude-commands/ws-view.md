---
description: 观察窗启动/打开（用法：/ws-view [--port N] [--no-open] [--stop]）
---
<!-- waystation-managed-command -->
用户要启动或打开人类观察窗（本机只读 Web 查看器）。参数原文：$ARGUMENTS

本命令只调用本机脚本、不依赖驿站工具（`mcp__waystation__*`）——未加载驿站工具的会话同样可用，不需要让用户新开会话。

流程：

1. 定位脚本：优先已安装路径 `$HOME/.waystation/app/scripts/ws-viewer.js`（存在即用）；否则看当前目录（仓库）下的 `scripts/ws-viewer.js`；两者都没有 → 提示「需先运行 waystation 安装脚本（重跑即可获得本功能）」，不要继续。
2. 后台/分离启动：**必须后台跑**——前台启动会把本会话的 Bash 调用一直挂住。首选 Bash 工具带 `run_in_background` 直接运行 `node <脚本路径>`；Windows 上也可用 `cmd /c start "" node "<脚本路径>"` 分离启动。用户给了参数就原样附加在脚本路径之后。
3. 启动验证：等不超过 5 秒——stdout 出现 `观察窗已就绪：http://127.0.0.1:<端口>/` 这一行即成（或轮询 `http://127.0.0.1:<端口>/api/health` 有应答）。脚本若发现同数据根实例已在跑，只会再开一次窗并退出 0——如实转告「已在运行，已为你打开页面」，不要重复启动。
4. 停止方法：`node "<脚本路径>" --stop`。注意：不带 `--port` 的裸 `--stop` 找不到用自定义 `--port N` 起的实例——起的时候带了 `--port N`，停的时候同样带上（README 有述）。
5. 报告：把打开地址（URL）与是否成功开窗告诉用户；出错就原文转述、不要自行重试。
