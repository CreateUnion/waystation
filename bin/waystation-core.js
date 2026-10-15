#!/usr/bin/env node
// 入口保持极薄：唯一职责 = 启动本数据根的核心（组合根与启动序在 src/core/main.js，按模块位置相对
// 解析——不依赖 PATH 与工作目录）。启动被拒（端口未解析 / 取锁失败 / 自检不过）时原因已由组合根
// 报出（stderr 与启动描述符），本入口按组合根给出的退出码退出——「已有核心在服务」的让位为 0，
// 拒绝服务为 1；就绪后等待内部退出请求（宽限到期有序收尾）按其退出码退出。
import { startCore } from '../src/core/main.js';

const result = await startCore();
if (!result.ok) {
  process.exit(result.exitCode ?? 1);
}
process.exit(await result.core.whenExited());
