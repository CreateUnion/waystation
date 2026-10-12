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
import { createMcpServer } from './server.js';

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
const registry = createToolRegistry();
registry.register(statusTool());
const context = {
  version,
  instanceId,
  dataDir,
  logDir,
  config,
  startedAt: new Date().toISOString(),
};
const server = createMcpServer({ version, registry, context });
await server.connect(new StdioServerTransport());
log.info('waystation 启动完成', { version, dataDir, logDir, port: config.port });
