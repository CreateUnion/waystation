import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { COLLABS_DIR_NAME, ensureDir, resolveDataDir, resolveLogDir } from './paths.js';
import { checkWritableDir } from './selfcheck.js';
import { buildDefaults, loadConfig, saveConfig } from './config.js';
import { resolveSite, slotDefaultPort } from './site.js';
import { createLogger } from './log.js';
import { loadOrCreateInstanceId } from './instance-id.js';
import { createToolRegistry } from './tools/registry.js';
import { statusTool } from './tools/status.js';
import { hostsTool } from './tools/hosts.js';
import { pingTool } from './tools/ping.js';
import { deliveryStatusTool } from './tools/delivery-status.js';
import { checkInboxTool } from './tools/check-inbox.js';
import { listCollabsTool, createCollabTool, inviteTool, requestJoinTool, approveInviteTool, withdrawInviteTool, viewLedgerTool, sendMessageTool, setMuteTool, leaveCollabTool, endCollabTool } from './tools/collab.js';
import { decideTool, handoverTool, takeOverTool } from './tools/governance.js';
import { createMcpServer } from './server.js';
import { createKnownHosts } from './net/known-hosts.js';
import { createDiscovery } from './net/discovery.js';
import { createTransport } from './net/transport.js';
import { createDispatch } from './net/dispatch.js';
import { createInbound } from './net/inbound.js';
import { createNetStack } from './net/stack.js';
import { createClaudeCodeAdapter } from './adapters/claude-code.js';
import { createCollabService } from './collab/service.js';
import { createSessionStatusWriter, indicatedEntriesOf, isIndicatedCollab } from './session-status.js';
import { openViewerOnStart, openViewerWindow, rootDigest, viewerRootOf } from './viewer/launch.js';

// 版本单一来源：包元数据（不另设常量，避免与 package.json 漂移）
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/* 启动失败（自检不过 / 存储不可用）→ stderr 明确报错后以退出码 1「拒绝服务」（设计 §13）。
 * 这是有意的退出：与「运行期绝不因内部错误退出」不冲突——数据目录不可用时服务没有意义。 */
function fatal(message) {
  console.error(`waystation: ${message}`);
  process.exit(1);
}

/* 首跑配置落盘（设计 §13/§14）：槽位站点目录不预写 port 字段（不写 = 自动）——
 * 程序写下的槽位默认值不得让后续读取把它误判为「显式接管」。
 * 显式目录首跑选中的端口已在下方先写入内存 config（config.port = site.port，单一赋值点），
 * 本函数不再重复赋值——「先落盘、后生效」的顺序由落盘调用点先于组件构造保证。 */
function firstRunConfig(config, site) {
  const written = { ...config };
  if (site.ok && site.mode === 'slot' && written.port === slotDefaultPort(site.slot)) {
    delete written.port;
  }
  return written;
}

/* 站点解析（设计 §13 多站点）：先定「本站点用哪个数据目录、哪个 LAN 端口」，再引导——
 * 解析失败（槽位段耗尽 / 锚点被无关程序占 / 显式端口被占）不阻断启动：以主数据目录降级启动
 * （本地 MCP 服务可用），LAN 工具返回解析结论的明确文案（经 stack 的预降级直通，不重复绑定）。 */
const site = await resolveSite({ env: process.env });
if (!site.ok) {
  console.error(`waystation: ${site.message}`);
}
const activeDir = site.ok ? site.dataDir : resolveDataDir(process.env);
try {
  ensureDir(activeDir);
} catch (error) {
  fatal(`数据目录不可用：${activeDir}（${error.message}）——启动自检失败，拒绝服务`);
}
const dataCheck = checkWritableDir(activeDir);
if (!dataCheck.ok) {
  fatal(`启动自检失败，拒绝服务：${dataCheck.message}`);
}
const { config, created: configCreated, identityDefaulted } = loadConfig(activeDir, {
  defaults: buildDefaults(hostname(), { slot: site.ok && site.mode === 'slot' ? site.slot : null }),
});
if (site.ok && site.writeBackPort) {
  config.port = site.port;   // 显式目录首跑选中的端口：写回与生效同值（先落盘、后生效）
}
const logDir = resolveLogDir(activeDir, config.logDir);
try {
  ensureDir(logDir);
} catch (error) {
  fatal(`日志目录不可用：${logDir}（${error.message}）——启动自检失败，拒绝服务`);
}
const logCheck = checkWritableDir(logDir);
if (!logCheck.ok) {
  fatal(`启动自检失败，拒绝服务：${logCheck.message}`);
}
const log = createLogger({ logDir, maxBytes: config.logMaxBytes, maxFiles: config.logMaxFiles });
try {
  ensureDir(join(activeDir, COLLABS_DIR_NAME));
} catch (error) {
  log.error('协作目录父级创建失败', { dataDir: activeDir, reason: error.message });
  fatal(`协作目录不可用：${error.message}——启动失败`);
}
let instanceId = '';
try {
  instanceId = loadOrCreateInstanceId(activeDir);
} catch (error) {
  log.error('实例标识读写失败', { dataDir: activeDir, reason: error.message });
  fatal(`实例标识无法持久化：${error.message}——启动失败`);
}
/* 首跑/写回/身份补写落盘必须先于组件构造与 net.start()——「先落盘、后生效」是既定验收项。
 * 身份补写（identityDefaulted）= 把生效的默认机器名写进字段：此后各会话读到的字段已有值，
 * 提示不再触发（本次会话的提示标志只活在内存里，不随配置落盘）。 */
if (configCreated || identityDefaulted || (site.ok && site.writeBackPort)) {
  try {
    saveConfig(activeDir, firstRunConfig(config, site));
  } catch (error) {
    log.error('配置文件写入失败', { dataDir: activeDir, reason: error.message });
    fatal(`配置文件无法写入：${error.message}——启动失败`);
  }
}

/* 观察窗自动打开的入口与站点根：入口按安装布局相对解析
 * （<app|repo>/scripts/ws-viewer.js 相对本模块），不依赖 PATH/工作目录；站点根映射取站点解析
 * 结果（显式目录与槽位 1 = 主根 main、槽位 k≥2 = s<k>；降级启动按活动目录解释——子进程 env
 * 不动、其缺省解析恒等于本进程的活动目录）。触发 A（建立协作即开该协作页）由协作服务经注入
 * 钩子调用，触发 B（新会话启动按规则
 * 拉起）在本组合根启动时判定一次。 */
const viewerScriptPath = fileURLToPath(new URL('../scripts/ws-viewer.js', import.meta.url));
const viewerSiteMode = site.ok ? site.mode : null;
const viewerSlot = site.ok ? site.slot : null;
const viewerRoot = viewerRootOf({ siteMode: viewerSiteMode, slot: viewerSlot });

/* 网络层与协作层组合根：构造组件、注入装配层（接线与生命周期归 stack——循环依赖在那里解除）。
 * 适配器先于协作服务构造：协作服务的 notify（本机提示注入面）需要它；其 describeCollab 闭包
 * 延迟引用协作服务（TDZ 安全——描述器只在投递渲染时调用，启动期不触达）。
 * 协作服务在 dispatch 之后构造（发送经其可靠队列、帖直投经其直投通道；探测经其即时通道；
 * 队列改投经其新出口）、在 inbound 之前构造（admit/consume 注入）；发现层经闭包取协作计数
 * （扫描列表显示真实忙闲；闭包在 start 时才调用，声明顺序无碍）。 */
const self = { instanceId, identityName: config.identityName, port: config.port };
const knownHosts = createKnownHosts({ dataDir: activeDir, log });
const transport = createTransport({ port: config.port, log });
const dispatch = createDispatch({
  dataDir: activeDir,
  config,
  transport,
  self,
  log,
  /* 转达副本达第三档 → 聚合捎回译回原作者（讨论的中继分发）：回调只在运行期触发（与
   * describeCollab 同一先例——声明顺序无碍）；寻址与失败留痕在协作侧，异常自隔离。 */
  onRelayedReport: (payload) => collab.relayReport(payload),
});
const adapter = createClaudeCodeAdapter({
  env: process.env,
  log,
  describeCollab: (collabId) => collab.describe(collabId),
});
if (!adapter.available()) {
  log.warn('会话投递适配器不可用（未检测到会话消息套接字）——投递降级为会话主动查');
}
const collab = createCollabService({
  dataDir: activeDir,
  config,
  self,
  send: (message) => dispatch.send(message),
  sendDirect: (message) => dispatch.sendDirect(message),
  probe: (address, port) => dispatch.ping({ address, port }),
  reassign: (payload) => dispatch.reassignPeer(payload),
  notify: (frame) => adapter.deliverFrame(frame),
  knownHosts,
  log,
  /* 触发 A（建立协作即开该协作页）：创建/同意成功点经 openViewer(ref) 落下——本站点根随 ref
   * 传入（服务层不复制根映射）；开关由拉起出口现读，失败静默降级（钩子不抛出）。 */
  viewerRoot,
  openViewer: (ref) => openViewerWindow({ ref, dataDir: activeDir, siteMode: viewerSiteMode, slot: viewerSlot, scriptPath: viewerScriptPath, log }),
  /* 观察面变化（内容消息计数 / 帖入列 / 成员事件）→ 会话状态文件即时刷新（计数变化不等心跳）；
   * 声明顺序无碍（同 describeCollab 先例）：回调只在运行期触发，sessionStatus 彼时已就绪。 */
  onIndicatorChange: () => sessionStatus.refresh(),
});
const discovery = createDiscovery({
  port: config.port,
  instanceId: self.instanceId,
  identityName: self.identityName,
  getCollabCount: () => collab.count(),
  knownHosts,
  log,
  /* 主动加入的敲门命中面（设计 §5.6）：命中匹配、应答载荷与本机放行提示在协作域
   * （发现层不 import 协作层——经注入回调解除，异常由发现层隔离）。 */
  onJoinKnock: (knock) => collab.joinKnock(knock),
});
/* 协作门控、静音栅栏（sessionGate）与注入标记通知（sessionDelivered）与投递适配器均经钩子注入
 * （分层纪律：核心模块不 import 协作层 / 适配层）；autoDeliver 关闭 = 不注入投递钩子，
 * 消息停留在第二档、由会话主动查（ws_check_inbox）承接。 */
const inbound = createInbound({
  dataDir: activeDir,
  config,
  self,
  dispatch,
  log,
  hooks: {
    admit: (frame, meta) => collab.hooks.admit(frame, meta),
    consume: (frame, meta) => collab.hooks.consume(frame, meta),
    sessionGate: (frame) => collab.hooks.sessionGate(frame),
    sessionDelivered: (frame) => collab.hooks.sessionDelivered(frame),
    ...(config.autoDeliver ? { deliverToSession: (frame) => adapter.deliverFrame(frame) } : {}),
  },
});
const net = createNetStack({
  discovery,
  transport,
  dispatch,
  inbound,
  port: config.port,
  self,
  scanWindowMs: config.scanWindowMs,
  probeTimeoutMs: config.probeTimeoutMs,
  degraded: site.ok ? null : { reason: site.reason, message: site.message },
  log,
});
/* 会话级状态文件（状态栏「协作中」指示的写入端）：启动即写、周期心跳、会话关闭删除。
 * 文件落主数据目录的 sessions/（槽位站点 k≥2 也在此共享目录；会话标识全局唯一）。
 * 归档协作不进指示面；快照裁剪为指示所需字段（读取端与写入端只共用这一份形态）。 */
const sessionStatus = createSessionStatusWriter({
  mainDataDir: resolveDataDir(process.env),
  sessionId: process.env.CLAUDE_CODE_SESSION_ID,
  collect: () => ({
    instanceId: self.instanceId,
    identityName: self.identityName,
    site: site.ok ? { mode: site.mode, slot: site.slot, port: site.port, takeover: site.takeover } : null,
    port: config.port,
    collabs: indicatedEntriesOf(collab.list().collabs.filter(isIndicatedCollab), collab.indicators()),
  }),
  log,
});
sessionStatus.start();
const bind = await net.start();
if (!bind.ok) {
  log.warn('局域网功能不可用（降级为本地 MCP 服务）', { reason: bind.reason, message: bind.message });
} else {
  collab.start();   // 探测定时器 + 启动握手（常驻收敛机制；降级不启动——无 LAN 面对表）
}
/* 触发 B（新会话启动，每会话一次）：本站点存在待拉的进行中协作且同根观察窗未在跑才拉起——
 * 后台执行不阻塞 MCP 启动（探测多是连接拒绝、即时返回），异常由出口内部消化（绝不抛出）。
 * 「同根」摘要取子进程解析所得的数据目录（＝本进程 resolveDataDir(process.env)：显式/降级下
 * 即活动目录、槽位模式下即主目录——与观察窗子进程的缺省解析同址），本站在观察窗里由 focus
 * 根定位；槽位站点的开关仍读本站点（槽位目录）config.json。 */
void openViewerOnStart({
  collabs: collab.list().collabs,
  root: viewerRoot,
  digest: rootDigest(resolveDataDir(process.env)),
  dataDir: activeDir,
  siteMode: viewerSiteMode,
  slot: viewerSlot,
  scriptPath: viewerScriptPath,
  log,
});

const registry = createToolRegistry();
registry.register(statusTool());
registry.register(hostsTool());
registry.register(pingTool());
registry.register(deliveryStatusTool());
registry.register(checkInboxTool());
registry.register(listCollabsTool());
registry.register(createCollabTool());
registry.register(approveInviteTool());
registry.register(withdrawInviteTool());
registry.register(viewLedgerTool());
registry.register(sendMessageTool());
registry.register(setMuteTool());
registry.register(leaveCollabTool());
registry.register(endCollabTool());
registry.register(inviteTool());
registry.register(requestJoinTool());
registry.register(decideTool());
registry.register(handoverTool());
registry.register(takeOverTool());
const context = {
  version,
  instanceId,
  dataDir: activeDir,
  logDir,
  config,
  // 身份未设置的会话级标志（内存态）：status 工具据此在载荷里带一次身份提示
  identityDefaulted,
  site: site.ok ? { mode: site.mode, slot: site.slot, port: site.port, takeover: site.takeover } : null,
  net,
  collab,
  startedAt: new Date().toISOString(),
};
const server = createMcpServer({ version, registry, context });
await server.connect(new StdioServerTransport());

/* 会话关闭（stdin EOF）= 这台机器离线（设计 §13）：先收协作层等待面（未决的拉取定时器、探测
 * 定时器与抢接 / 移交等待面），再关闭网络栈释放 UDP/TCP 监听端口，进程自然退出（退出码 0）。
 * MCP SDK 的 stdio transport 只监听 stdin 的 data/error、不报告 EOF（server/stdio.js），
 * 故在这个组合根接线；硬杀（SIGTERM/SIGKILL）保持「被外部终止」的既有语义，不接信号事件。
 * 优雅退出是尽力而为：上界为在途拨号超时（生产默认 5000ms）——超出 SDK 客户端 2s 兜底窗时
 * 退化为 SIGTERM 收尾；在途消息仍在落盘队列，重试即新一轮调度。 */
let sessionEnded = false;
function closeOnSessionEnd() {
  if (sessionEnded) {
    return;
  }
  sessionEnded = true;
  sessionStatus.close();
  collab.close();
  void net.close();
}
process.stdin.on('end', closeOnSessionEnd);     // 管道写端关闭（EOF）
process.stdin.on('close', closeOnSessionEnd);   // 流销毁兜底：与 end 二选一先到先赢

log.info('waystation 启动完成', {
  version,
  dataDir: activeDir,
  logDir,
  port: config.port,
  site: site.ok ? { mode: site.mode, slot: site.slot } : null,
  adapterAvailable: adapter.available(),
  netAvailable: bind.ok,
  collabCount: collab.count(),
});
