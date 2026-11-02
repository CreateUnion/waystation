import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

/* MCP server 装配（薄层）：SDK 接线只在这里；工具行为全部在 registry 与各工具模块 */
export function createMcpServer({ version, registry, context }) {
  /* listChanged：桥在核心换代后会热刷新工具目录并通知客户端重拉（已开会话无需 /mcp）。 */
  const server = new Server({ name: 'waystation', version }, { capabilities: { tools: { listChanged: true } } });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    await registry.refresh?.();
    return { tools: registry.list() };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return registry.call(request.params.name, request.params.arguments ?? {}, context);
  });
  return server;
}
