import { WS_LIST_HOSTS_SPEC } from './specs.js';

/* ws_list_hosts：扫描局域网在线驿站（广播段扫 + 已知主机单播兜底，窗口收应答）。
 * 清单按实例标识去重合并：身份名 + 端点（「地址:端口」）。端点而非裸地址是回信寻址的依据——
 * 多站点下端口按站点独立，只报地址无法定位到对端驿站。
 * 载荷分两段：hosts＝其他驿站（本机实例由发现层按实例标识排除；同机的其他数据根实例照常列出、
 * 由网络层标注 sameMachine）；self＝本机自身（核心身份＋端口＋活跃终端会话，经上下文取值器现取——
 * 注册桥即活跃终端）。本机地址无现成数据源，self 只报端口，不硬凑地址。
 * 返回口径：成功载荷顶层恒含 ok:true（19 工具统一约定，见 tools/collab.js）。 */
export function hostsTool() {
  return {
    ...WS_LIST_HOSTS_SPEC,
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
        sameMachine: host.sameMachine === true,
      }));
      const sessions = context.activeSessions();
      const self = {
        instanceId: context.instanceId,
        identityName: context.config.identityName,
        port: context.config.port,
        sessions,
        sessionCount: sessions.length,
      };
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, self, hosts }, null, 2) }] };
    },
  };
}
