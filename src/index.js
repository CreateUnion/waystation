/* 桥入口薄壳（设计附 A 裁定）：驿站 MCP 服务的入口现为「会话桥」——工具目录/转发、注入写入与
 * 核心监督全部在 src/bridge/main.js（核心组合根由独立进程 bin/waystation-core.js 承载，桥按需
 * 冷启并监督）。本文件保持为既有测试与 MCP 注册的 spawn 入口（零改引），自身不含任何业务逻辑。 */
import { startBridge } from './bridge/main.js';

await startBridge();
