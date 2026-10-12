import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { COLLABS_DIR_NAME, ensureDir, resolveDataDir, resolveLogDir } from './paths.js';
import { checkWritableDir } from './selfcheck.js';
import { loadConfig, saveConfig } from './config.js';
import { createLogger } from './log.js';
import { loadOrCreateInstanceId } from './instance-id.js';
import { createToolRegistry } from './tools/registry.js';
import { statusTool } from './tools/status.js';
import { hostsTool } from './tools/hosts.js';
import { pingTool } from './tools/ping.js';
import { deliveryStatusTool } from './tools/delivery-status.js';
import { createMcpServer } from './server.js';
import { createKnownHosts } from './net/known-hosts.js';
import { createDiscovery } from './net/discovery.js';
import { createTransport } from './net/transport.js';
import { createDispatch } from './net/dispatch.js';
import { createInbound } from './net/inbound.js';
import { createNetStack } from './net/stack.js';

// 版本单一来源：包元数据（不另设常量，避免与 package.json 漂移）
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/* 启动失败（自检不过 / 存储不可用）→ stderr 明确报错后以退出码 1「拒绝服务」（设计 §13）。
 * 这是有意的退出：与「运行期绝不因内部错误退出」不冲突——数据目录不可用时服务没有意义。 */
function fatal(message) {
  console.error(`waystation: ${message}`);
  process.exit(1);
}

const dataDir = resolveDataDir(process.env);
try {
  ensureDir(dataDir);
} catch (error) {
  fatal(`数据目录不可用：${dataDir}（${error.message}）——启动自检失败，拒绝服务`);
}
const dataCheck = checkWritableDir(dataDir);
if (!dataCheck.ok) {
  fatal(`启动自检失败，拒绝服务：${dataCheck.message}`);
}
const { config, created: configCreated } = loadConfig(dataDir);
const logDir = resolveLogDir(dataDir, config.logDir);
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
  ensureDir(join(dataDir, COLLABS_DIR_NAME));
} catch (error) {
  log.error('协作目录父级创建失败', { dataDir, reason: error.message });
  fatal(`协作目录不可用：${error.message}——启动失败`);
}
let instanceId = '';
try {
  instanceId = loadOrCreateInstanceId(dataDir);
} catch (error) {
  log.error('实例标识读写失败', { dataDir, reason: error.message });
  fatal(`实例标识无法持久化：${error.message}——启动失败`);
}
if (configCreated) {
  try {
    saveConfig(dataDir, config);
  } catch (error) {
    log.error('配置文件写入失败', { dataDir, reason: error.message });
    fatal(`配置文件无法写入：${error.message}——启动失败`);
  }
}

/* 网络层组合根：构造四组件、注入装配层（接线与生命周期归 stack——循环依赖在那里解除）。
 * 钩子暂不注入：协作台账与投递适配器接入前，接收管线以安全默认占位（拒绝 / 不投递）。 */
const self = { instanceId, identityName: config.identityName };
const knownHosts = createKnownHosts({ dataDir, log });
const discovery = createDiscovery({
  port: config.port,
  instanceId: self.instanceId,
  identityName: self.identityName,
  getCollabCount: () => 0,   // 协作台账接入后接真实计数：扫描列表要显示每台机器的忙闲
  knownHosts,
  log,
});
const transport = createTransport({ port: config.port, log });
const dispatch = createDispatch({ dataDir, config, transport, self, log });
const inbound = createInbound({ dataDir, config, self, dispatch, log });
const net = createNetStack({ discovery, transport, dispatch, inbound, port: config.port, self, scanWindowMs: config.scanWindowMs, log });
const bind = await net.start();
if (!bind.ok) {
  log.warn('局域网功能不可用（降级为本地 MCP 服务）', { reason: bind.reason, message: bind.message });
}

const registry = createToolRegistry();
registry.register(statusTool());
registry.register(hostsTool());
registry.register(pingTool());
registry.register(deliveryStatusTool());
const context = {
  version,
  instanceId,
  dataDir,
  logDir,
  config,
  net,
  startedAt: new Date().toISOString(),
};
const server = createMcpServer({ version, registry, context });
await server.connect(new StdioServerTransport());

/* 会话关闭（stdin EOF）= 这台机器离线（设计 §13）：关闭网络栈释放 UDP/TCP 监听端口后进程自然退出
 * （关闭后事件循环不再有活动句柄，退出码 0）。MCP SDK 的 stdio transport 只监听 stdin 的 data/error、
 * 不报告 EOF（server/stdio.js），故在这个组合根接线；硬杀（SIGTERM/SIGKILL）保持「被外部终止」的
 * 既有语义，不接信号事件。 */
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

log.info('waystation 启动完成', { version, dataDir, logDir, port: config.port, netAvailable: bind.ok });
