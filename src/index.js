import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
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
import { createMcpServer } from './server.js';
import { createKnownHosts } from './net/known-hosts.js';
import { createDiscovery } from './net/discovery.js';
import { createTransport } from './net/transport.js';
import { createDispatch } from './net/dispatch.js';
import { createInbound } from './net/inbound.js';
import { createNetStack } from './net/stack.js';
import { createClaudeCodeAdapter } from './adapters/claude-code.js';

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
const { config, created: configCreated } = loadConfig(activeDir, {
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
/* 首跑与写回落盘必须先于组件构造与 net.start()：「先落盘、后生效」——配置是一次性事实，
 * 组件构造与运行期不得出现第二处端口来源。writeBackPort 的端口值只在上方赋一次
 * （config.port = site.port），此处直接写整份 config。 */
if (configCreated || (site.ok && site.writeBackPort)) {
  try {
    saveConfig(activeDir, firstRunConfig(config, site));
  } catch (error) {
    log.error('配置文件写入失败', { dataDir: activeDir, reason: error.message });
    fatal(`配置文件无法写入：${error.message}——启动失败`);
  }
}

/* 网络层组合根：构造四组件、注入装配层（接线与生命周期归 stack——循环依赖在那里解除）。
 * 站点端口随 config.port 进入全部组件（多站点下各站点端口独立）；站点解析失败的结论经 degraded 直通。 */
const self = { instanceId, identityName: config.identityName, port: config.port };
const adapter = createClaudeCodeAdapter({ env: process.env, log });
if (!adapter.available()) {
  log.warn('会话投递适配器不可用（未检测到会话消息套接字）——投递降级为会话主动查');
}
const knownHosts = createKnownHosts({ dataDir: activeDir, log });
const discovery = createDiscovery({
  port: config.port,
  instanceId: self.instanceId,
  identityName: self.identityName,
  getCollabCount: () => 0,   // 协作台账接入后接真实计数：扫描列表要显示每台机器的忙闲
  knownHosts,
  log,
});
const transport = createTransport({ port: config.port, log });
const dispatch = createDispatch({ dataDir: activeDir, config, transport, self, log });
/* 投递适配器经钩子注入（分层纪律：核心模块不 import 适配层）；autoDeliver 关闭 = 不注入钩子，
 * 消息停留在第二档、由会话主动查（ws_check_inbox）承接。 */
const inbound = createInbound({
  dataDir: activeDir,
  config,
  self,
  dispatch,
  log,
  hooks: config.autoDeliver ? { deliverToSession: (frame) => adapter.deliverFrame(frame) } : {},
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
const bind = await net.start();
if (!bind.ok) {
  log.warn('局域网功能不可用（降级为本地 MCP 服务）', { reason: bind.reason, message: bind.message });
}

const registry = createToolRegistry();
registry.register(statusTool());
registry.register(hostsTool());
registry.register(pingTool());
registry.register(deliveryStatusTool());
registry.register(checkInboxTool());
const context = {
  version,
  instanceId,
  dataDir: activeDir,
  logDir,
  config,
  site: site.ok ? { mode: site.mode, slot: site.slot, port: site.port, takeover: site.takeover } : null,
  net,
  startedAt: new Date().toISOString(),
};
const server = createMcpServer({ version, registry, context });
await server.connect(new StdioServerTransport());

/* 会话关闭（stdin EOF）= 这台机器离线（设计 §13）：关闭网络栈释放 UDP/TCP 监听端口后进程自然退出
 * （关闭后事件循环不再有活动句柄，退出码 0）。MCP SDK 的 stdio transport 只监听 stdin 的 data/error、
 * 不报告 EOF（server/stdio.js），故在这个组合根接线；硬杀（SIGTERM/SIGKILL）保持「被外部终止」的
 * 既有语义，不接信号事件。
 * 优雅退出是尽力而为：上界为在途拨号超时（生产默认 5000ms）——超出 SDK 客户端 2s 兜底窗时退化为
 * SIGTERM 收尾；在途消息仍在落盘队列，重试即新一轮调度。 */
let sessionEnded = false;
function closeOnSessionEnd() {
  if (sessionEnded) {
    return;
  }
  sessionEnded = true;
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
});
