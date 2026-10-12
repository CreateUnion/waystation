// 双进程预演的驿站节点：以真实网络组件装配一个节点，用 stdin 的 JSON 行命令驱动。
// stdout 只输出命令应答（本夹具自有命令行协议，非 MCP）；日志走文件与 stderr。
import { createInterface } from 'node:readline';
import { loadConfig } from '../../src/config.js';
import { loadOrCreateInstanceId } from '../../src/instance-id.js';
import { createLogger } from '../../src/log.js';
import { collabFilePath, resolveLogDir } from '../../src/paths.js';
import { loadLines } from '../../src/storage.js';
import { createClaudeCodeAdapter } from '../../src/adapters/claude-code.js';
import { createDiscovery } from '../../src/net/discovery.js';
import { createDispatch } from '../../src/net/dispatch.js';
import { INBOX_FILE_NAME, createInbound } from '../../src/net/inbound.js';
import { createKnownHosts } from '../../src/net/known-hosts.js';
import { createNetStack } from '../../src/net/stack.js';
import { createTransport } from '../../src/net/transport.js';

const options = JSON.parse(process.argv[2]);
const { dataDir, bindAddress, knownPeers = [] } = options;

function write(payload) {
  process.stdout.write(JSON.stringify(payload) + '\n');
}

/* 站点端口单一来源 = 配置文件（与生产同源：生产由站点解析把端口写进 config 后组件消费 config.port）——
 * argv 不承载端口，杜绝「夹具与生产各一套端口来源」的静默分叉。 */
const { config } = loadConfig(dataDir);
const port = config.port;
const log = createLogger({ logDir: resolveLogDir(dataDir, config.logDir), maxBytes: config.logMaxBytes, maxFiles: config.logMaxFiles });
const instanceId = loadOrCreateInstanceId(dataDir);
const self = { instanceId, identityName: config.identityName, port };
const knownHosts = createKnownHosts({ dataDir, log });
for (const peer of knownPeers) {
  knownHosts.remember({ address: peer.address, port: peer.port });
}
let sessionWriterOk = true;
/* adapter: true = 走真适配器（读本进程环境变量——预演进程须在目标会话的 shell 下启动）；
 * 缺省 = set_writer 开关桩（自动预演用，不依赖真实会话）。 */
const adapter = options.adapter === true ? createClaudeCodeAdapter({ env: process.env, log }) : null;
const discovery = createDiscovery({
  port,
  bindAddress,
  instanceId,
  identityName: self.identityName,
  getCollabCount: () => 0,
  knownHosts,
  log,
});
const transport = createTransport({ port, bindAddress, log });
const dispatch = createDispatch({ dataDir, config, transport, self, log });
const inbound = createInbound({
  dataDir,
  config,
  self,
  dispatch,
  log,
  hooks: {
    admit: () => ({ ok: true }),              // 预演：无协作台账，全部准入
    deliverToSession: adapter !== null ? (frame) => adapter.deliverFrame(frame) : () => sessionWriterOk,
  },
});
const stack = createNetStack({ discovery, transport, dispatch, inbound, port, self, scanWindowMs: config.scanWindowMs, log });

const bind = await stack.start();
write({ event: 'ready', instanceId, identityName: self.identityName, port, bind });

/* 命令表（条件链改查表：新增命令不再抬升 handle 的圈复杂度；exit 自行退出、以 null 表示无应答）。 */
const COMMANDS = {
  list_hosts: async () => {
    const listed = await stack.listHosts();
    return { ok: listed.ok, hosts: listed.hosts ?? [], message: listed.message ?? '' };
  },
  ping: async (command) => ({ ok: true, ...(await stack.pingHost({ address: command.address, port: command.port })) }),
  send: async (command) => ({ ok: true, ...stack.send({ collabId: command.collabId, to: command.to, type: command.type ?? 'notice', payload: command.payload }) }),
  status: async (command) => ({ ok: true, rows: stack.deliveryStatus(command) }),
  inbox: async (command) => ({ ok: true, messages: loadLines(collabFilePath(dataDir, command.collabId, INBOX_FILE_NAME)).entries }),
  // 会话主动查路径（生产由 ws_check_inbox 工具承载）：
  check_inbox: async (command) => ({ ok: true, result: stack.checkInbox({ collabId: command.collabId, limit: command.limit }) }),
  set_writer: async (command) => {
    sessionWriterOk = command.ok === true;
    return { ok: true };
  },
  exit: async () => {
    await shutdown();
    return null;   // 退出应答由 shutdown 在冲刷回调里写出
  },
};

async function handle(line) {
  const command = JSON.parse(line);
  const run = COMMANDS[command.cmd];
  if (run === undefined) {
    write({ ok: false, error: `未知命令：${String(command.cmd)}` });
    return;
  }
  const reply = await run(command);
  if (reply !== null) {
    write(reply);
  }
}

/* 收尾：先撤下网络层，再等 stdout 冲刷完成后退出——process.exit 不等待写完成，
 * Linux 下应答会整包丢失（Windows 行为不同，会掩盖该缺陷），调用方 await 的 exit 应答将永不到达。 */
async function shutdown() {
  await stack.close();
  process.stdout.write(JSON.stringify({ ok: true }) + '\n', () => {
    process.exit(0);
  });
}

createInterface({ input: process.stdin }).on('line', (line) => {
  handle(line).catch((error) => {
    write({ ok: false, error: error.message });
  });
});
