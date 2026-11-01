import { participantsStateOf } from '../net/known-hosts.js';
import { shortSessionId } from '../util/short-id.js';
import { errorResult } from './collab.js';
import { WS_LIST_HOSTS_SPEC } from './specs.js';

/* ws_list_hosts：扫描局域网在线驿站（广播段扫 + 已知主机单播兜底，窗口收应答）。
 * 清单按实例标识去重合并：身份名 + 端点（「地址:端口」）。端点而非裸地址是回信寻址的依据——
 * 多站点下端口按站点独立，只报地址无法定位到对端驿站。
 * 载荷分两段：hosts＝其他驿站（本机实例由发现层按实例标识排除；同机的其他数据根实例照常列出、
 * 由网络层标注 sameMachine；另携对端上报的活跃会话短码 sessions——旧版对端无该字段＝省略，
 * 「零会话」与「没报」是两回事，不得混为一谈）；self＝本机自身（核心身份＋端口＋活跃终端会话，
 * 经上下文取值器现取——注册桥即活跃终端；此处维持全量会话记录不变）。
 * 本机地址无现成数据源，self 只报端口，不硬凑地址。
 * 返回口径：成功载荷顶层恒含 ok:true（27 工具统一约定，见 tools/collab.js）。 */
export function hostsTool() {
  return {
    ...WS_LIST_HOSTS_SPEC,
    handler: async (_args, context) => {
      const listed = await context.net.listHosts();
      if (!listed.ok) {
        return errorResult(listed.message, { code: 'network-scan-failed' });
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
        /* 会话级参与者能力三态（设计 §7.2）：2＝支持、0＝旧版应答缺字段、缺席＝从未观测到。
         * 未知先探测的闸门在服务层；这里只如实呈现，不擅自对全表发起探测。 */
        participants: participantsStateOf(host),
        ...sessionsFieldOf(host),
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

/* 远端条目的会话段（设计 §1）：对端没报该字段（旧版对端）＝整段省略——「对端没有活跃会话」
 * 与「对端没报」必须可区分，不拿空数组冒充满足；有值一律经短码唯一权威产出对外表示
 * （会话标识原样外泄无益，短码即指名的够用粒度）。 */
function sessionsFieldOf(host) {
  return Array.isArray(host.sessions)
    ? { sessions: host.sessions.map(shortSessionId).filter(Boolean) }
    : {};
}
