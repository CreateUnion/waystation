import { isIP } from 'node:net';

/* ws_ping：可达性探测（TCP 拨入 + ping/pong 往返延迟）。
 * 可达与否都是探测结果（不可达是信息、不是工具错误）；工具错误只留给参数与降级。 */
export function pingTool() {
  return {
    name: 'ws_ping',
    description: '探测某台机器的驿站是否可达（TCP 拨入 + ping/pong 往返延迟）',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: '目标地址（IPv4/IPv6 字面量，不做域名解析）' },
      },
      required: ['address'],
    },
    handler: async (args, context) => {
      const address = typeof args.address === 'string' ? args.address.trim() : '';
      if (address === '' || isIP(address) === 0) {
        return { content: [{ type: 'text', text: '参数 address 非法：需要 IPv4/IPv6 字面量（不做域名解析）' }], isError: true };
      }
      const probed = await context.net.pingHost({ address });
      if (!probed.ok) {
        return { content: [{ type: 'text', text: probed.message }], isError: true };
      }
      return { content: [{ type: 'text', text: JSON.stringify(probed, null, 2) }] };
    },
  };
}
