/* ws_list_hosts：扫描局域网在线驿站（广播段扫 + 已知主机单播兜底，窗口收应答）。
 * 清单按实例标识去重合并：身份名 + 端点（「地址:端口」）。端点而非裸地址是回信寻址的依据——
 * 多站点下端口按站点独立，只报地址无法定位到对端驿站。
 * 返回口径：成功载荷顶层恒含 ok:true（19 工具统一约定，见 tools/collab.js）。 */
export function hostsTool() {
  return {
    name: 'ws_list_hosts',
    description: '扫描局域网中在线的驿站（广播段扫 + 单播兜底）：列出身份名、地址:端口与当前参与协作数',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args, context) => {
      const listed = await context.net.listHosts();
      if (!listed.ok) {
        return { content: [{ type: 'text', text: listed.message }], isError: true };
      }
      const hosts = listed.hosts.map((host) => ({
        instanceId: host.instanceId,
        identityName: host.identityName,
        address: host.endpoints[0]?.address ?? '',
        port: host.endpoints[0]?.port ?? null,
        endpoints: host.endpoints.map((endpoint) => `${endpoint.address}:${endpoint.port}`),
        collabCount: host.collabCount,
        lastSeenAt: host.lastSeenAt,
      }));
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, hosts }, null, 2) }] };
    },
  };
}
