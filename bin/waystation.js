#!/usr/bin/env node
// 入口保持极薄：缺省行为 = 启动驿站服务（与 `node src/index.js` 一致）；
// 带子命令时只做分派——`uninstall` / `purge-data` 各由 src/ 下同名 CLI 模块承载（动态导入：服务路径不加载它们）。
const command = process.argv[2];
if (command === 'uninstall') {
  const { runUninstallCli } = await import('../src/uninstall.js');
  process.exitCode = await runUninstallCli({ argv: process.argv.slice(3) });
} else if (command === 'purge-data') {
  const { runPurgeCli } = await import('../src/purge.js');
  process.exitCode = await runPurgeCli({ argv: process.argv.slice(3) });
} else if (command === '--help' || command === '-h') {
  console.error('waystation：MCP 驿站（缺省启动服务）。子命令：uninstall [--dry-run] [--purge-data]；purge-data [--yes]');
} else {
  await import('../src/index.js');
}
