import { join } from 'node:path';
import { CONFIG_FILE_NAME } from '../config.js';

/* 会话期首检与排障的诊断工具（设计 §14：会话期首检——工具可调用）。
 * 只读、无副作用；实例标识仅在此诊断面可见——设计 §14 的「不显示于界面」指
 * 面向用户的界面（扫描列表/同意门/台账），首检与排障需要按实例核对持久化是否生效。 */
export function statusTool() {
  return {
    name: 'ws_status',
    description: '查看本机驿站状态（版本、实例标识、数据目录、端口配置、网络状态等）——会话期首检与排障使用',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args, context) => {
      const status = {
        name: 'waystation',
        version: context.version,
        instanceId: context.instanceId,
        identityName: context.config.identityName,
        dataDir: context.dataDir,
        logDir: context.logDir,
        configFile: join(context.dataDir, CONFIG_FILE_NAME),
        port: context.config.port,
        site: context.site,   // { mode, slot, port, takeover }；站点解析失败降级时为 null
        pid: process.pid,
        node: process.version,
        startedAt: context.startedAt,
        net: context.net.status(),
        collab: context.collab.stats(),   // 协作服务计数（注册表状态分布 + 各类拒绝 / 丢弃计数）
      };
      return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] };
    },
  };
}
