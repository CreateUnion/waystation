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
      const hosts = listed.hosts.map((host) => ({
        instanceId: host.instanceId,
        identityName: host.identityName,
        address: host.addresses[0] ?? '',
        addresses: host.addresses,
        collabCount: host.collabCount,
        lastSeenAt: host.lastSeenAt,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(hosts, null, 2) }] };
    },
  };
}
