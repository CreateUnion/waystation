import { join } from 'node:path';
import { CONFIG_FILE_NAME } from '../config.js';
import { WS_STATUS_SPEC } from './specs.js';

/* 会话期首检与排障的诊断工具（设计 §14：会话期首检——工具可调用）。
 * 只读、无副作用；实例标识仅在此诊断面可见——设计 §14 的「不显示于界面」指
 * 面向用户的界面（扫描列表/同意门/台账），首检与排障需要按实例核对持久化是否生效。 */
export function statusTool() {
  return {
    ...WS_STATUS_SPEC,
    handler: async (_args, context) => {
      const configFile = join(context.dataDir, CONFIG_FILE_NAME);
      const net = context.net.status();
      const status = {
        ok: true,
        name: 'waystation',
        version: context.version,
        instanceId: context.instanceId,
        identityName: context.config.identityName,
        dataDir: context.dataDir,
        logDir: context.logDir,
        configFile,
        port: context.config.port,
        /* 单核形态：成功应答恒 { mode:'single', slot:null, port, takeover:false }——LAN 端口被
         * 无关程序/别根占用时仍是它（降级服务态经 net.degraded 表达，site 不随之退回 null）；
         * null 仅保留给「单根解析/初始化失败」的残余路径。 */
        site: context.site,
        /* pid / startedAt 是核心的：工具在核心进程内执行，启动时刻随 context 传入。 */
        pid: process.pid,
        node: process.version,
        startedAt: context.startedAt,
        /* core 字段仅在核心应答时出现（coreEndpoint 由核心组合根注入；核心不可达时的差错载荷
         * 由桥合成）。应答即核心可用——不设 available 子字段；LAN 降级时带 degraded 标注。 */
        ...(typeof context.coreEndpoint === 'string' && context.coreEndpoint !== '' ? {
          core: { pid: process.pid, app: context.version, endpoint: context.coreEndpoint, ...(net.available ? {} : { degraded: true }) },
        } : {}),
        net,
        collab: context.collab.stats(),   // 协作服务计数（注册表状态分布 + 各类拒绝 / 丢弃计数）
        /* 身份未设置的会话级提示：启动时已把默认机器名落盘，字段只在本会话出现——命令面撞到就
         * 向用户转达一次（可代改 identityName，下次会话生效），不阻断主流程。标志是内存态，
         * 字段有值后不再带本字段。 */
        ...(context.identityDefaulted === true ? {
          identityHint: `身份名未设置：当前使用默认机器名「${context.config.identityName}」——不设置就继续用它，此提醒只出现这一次。`
            + `要自定义请改 ${configFile} 里的 identityName 字段（下次会话生效；本次启动已按该值落盘）。`,
        } : {}),
      };
      return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] };
    },
  };
}
