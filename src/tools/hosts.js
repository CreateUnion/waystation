/* ws_list_hosts：扫描局域网在线驿站（UDP 广播 + 已知主机单播兜底，窗口收应答）。
 * 清单按实例标识去重合并：身份名 + 首选地址（首个应答来源）+ 全部地址 + 当前参与协作数。 */
export function hostsTool() {
  return {
    name: 'ws_list_hosts',
    description: '扫描局域网中在线的驿站（广播 + 单播兜底）：列出身份名、地址与当前参与协作数',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args, context) => {
      const listed = await context.net.listHosts();
      if (!listed.ok) {
        return { content: [{ type: 'text', text: listed.message }], isError: true };
      }
      const hosts = listed.hosts.map((host) => {
        const endpoints = endpointsOf(host);
        return {
          instanceId: host.instanceId,
          identityName: host.identityName,
          address: endpoints[0]?.address ?? '',
          addresses: endpoints.map((endpoint) => endpoint.address),
          endpoints: endpoints.map((endpoint) => (endpoint.port === null ? endpoint.address : `${endpoint.address}:${endpoint.port}`)),
          collabCount: host.collabCount,
          lastSeenAt: host.lastSeenAt,
        };
      });
      return { content: [{ type: 'text', text: JSON.stringify(hosts, null, 2) }] };
    },
  };
}

/* 最小形状同步（完整形态随工具面任务收口）：扫描条目已改为 endpoints（地址:端口）；
 * 对仍按旧形态投喂的调用方（单元测试假 net）保留 addresses 回退，避免跨任务波次窗口内的读数 TypeError。 */
function endpointsOf(host) {
  if (Array.isArray(host.endpoints)) {
    return host.endpoints;
  }
  return (host.addresses ?? []).map((address) => ({ address, port: null }));
}
