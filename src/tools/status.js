import { join } from 'node:path';
import { CONFIG_FILE_NAME } from '../config.js';
import { hostResourcesOf } from '../host-resources.js';
import { errorResult } from './collab.js';
import { WS_STATUS_SPEC } from './specs.js';

/* 会话期首检与排障的诊断工具（设计 §14：会话期首检——工具可调用）。
 * 只读、无副作用；实例标识仅在此诊断面可见——设计 §14 的「不显示于界面」指
 * 面向用户的界面（扫描列表/同意门/台账），首检与排障需要按实例核对持久化是否生效。
 *
 * 两种视图（#12）：compact 是缺省的精简面，只保留首检 / 调度提示词真正依赖的字段；
 * full 与 0.2.6 的既有输出逐字段一致（仅新增 host.resources），完整计数器、路径与
 * identityHint 都在 full。任何视图都保留 ok / version / dispatch（无调度时为 null）与
 * dispatch.slaves（调度长提示词依赖）。 */

const STATUS_VIEWS = new Set(['compact', 'full']);
const COMPACT_VIEW_HINT = '完整计数器请用 ws_status { view: "full" }';

/**
 * @param {{ resourcesOf?: () => { freeMemMB: number, totalMemMB: number, claudeProcs: number, nodeProcs: number } }} [options]
 */
export function statusTool(options = {}) {
  const resourcesOf = typeof options.resourcesOf === 'function' ? options.resourcesOf : hostResourcesOf;
  return {
    ...WS_STATUS_SPEC,
    handler: async (args, context) => {
      const view = args?.view;
      if (view !== undefined && !STATUS_VIEWS.has(view)) {
        return errorResult(`view 非法：${JSON.stringify(view)}——只接受 "compact" 或 "full"`, { code: 'invalid-view' });
      }
      const net = context.net.status();
      const status = view === 'full'
        ? fullStatusOf(context, net, resourcesOf)
        : compactStatusOf(context, net, resourcesOf);
      return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] };
    },
  };
}

/* full：保持既有字段与顺序，仅在 net 之后插入 host.resources（唯一允许的新增）。 */
function fullStatusOf(context, net, resourcesOf) {
  const configFile = join(context.dataDir, CONFIG_FILE_NAME);
  const core = coreBlockOf(context, net);
  return {
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
    ...(core === null ? {} : { core }),
    net,
    host: { resources: resourcesOf() },
    collab: context.collab.stats(),   // 协作服务计数（注册表状态分布 + 各类拒绝 / 丢弃计数）
    dispatch: dispatchStatusOf(context),   // dispatch 内存域视图（无＝null）
    ...identityHintBlockOf(context, configFile),
  };
}

/* compact：任务书列出的字段集；不展开完整计数器、路径与身份提示。 */
function compactStatusOf(context, net, resourcesOf) {
  const core = coreBlockOf(context, net);
  return {
    ok: true,
    version: context.version,
    name: 'waystation',
    identityName: context.config.identityName,
    instanceId: context.instanceId,
    pid: process.pid,
    startedAt: context.startedAt,
    ...(core === null ? {} : { core: { pid: core.pid, app: core.app, endpoint: core.endpoint } }),
    site: context.site,
    net: { available: net.available === true, reason: net.reason ?? null },
    host: { resources: resourcesOf() },
    dispatch: dispatchStatusOf(context),
    collab: compactCollabOf(context.collab.stats()),
    viewHint: COMPACT_VIEW_HINT,
  };
}

/* core 字段仅在核心应答时出现（coreEndpoint 由核心组合根注入；核心不可达时的差错载荷
 * 由桥合成）。应答即核心可用——不设 available 子字段；LAN 降级时带 degraded 标注。 */
function coreBlockOf(context, net) {
  if (typeof context.coreEndpoint !== 'string' || context.coreEndpoint === '') {
    return null;
  }
  return {
    pid: process.pid,
    app: context.version,
    endpoint: context.coreEndpoint,
    ...(net.available ? {} : { degraded: true }),
  };
}

function dispatchStatusOf(context) {
  return context.collab.dispatch?.status?.()?.dispatch ?? null;
}

/* 协作计数摘要：只取 byState 的四项；无协作 / 旧服务缺字段时补零，类型稳定。 */
function compactCollabOf(stats) {
  const byState = stats?.byState !== null && typeof stats?.byState === 'object' ? stats.byState : {};
  return {
    collabs: Number.isInteger(stats?.collabs) ? stats.collabs : 0,
    active: byState.active ?? 0,
    completed: byState.completed ?? 0,
    terminated: byState.terminated ?? 0,
  };
}

/* 身份未设置的会话级提示：启动时已把默认机器名落盘，字段只在本会话出现——命令面撞到就
 * 向用户转达一次（可代改 identityName，下次会话生效），不阻断主流程。标志是内存态，
 * 字段有值后不再带本字段。 */
function identityHintBlockOf(context, configFile) {
  if (context.identityDefaulted !== true) {
    return {};
  }
  return {
    identityHint: `身份名未设置：当前使用默认机器名「${context.config.identityName}」——不设置就继续用它，此提醒只出现这一次。`
      + `要自定义请改 ${configFile} 里的 identityName 字段（下次会话生效；本次启动已按该值落盘）。`,
  };
}
