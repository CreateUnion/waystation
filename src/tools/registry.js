/* 工具注册框架：后续里程碑的所有工具经此登记、由 server.js 统一暴露。
 * 契约：handler(args, context) → { content: [{ type: 'text', text }], isError? }。
 * handler 抛错在此兜底为 isError 结果——异常不穿到 SDK，进程不因单个工具失败退出（设计 §6）。 */
export function createToolRegistry() {
  const tools = new Map();
  return {
    register(tool) {
      if (tools.has(tool.name)) {
        throw new Error(`工具名重复注册：${tool.name}`);
      }
      tools.set(tool.name, tool);
    },
    list() {
      return [...tools.values()].map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
    },
    async call(name, args, context) {
      const tool = tools.get(name);
      if (tool === undefined) {
        return { content: [{ type: 'text', text: `未知工具：${name}` }], isError: true };
      }
      try {
        return await tool.handler(args, context);
      } catch (error) {
        return { content: [{ type: 'text', text: `工具执行失败（${name}）：${error.message}` }], isError: true };
      }
    },
  };
}
