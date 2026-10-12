// 双进程预演的驿站节点：以真实网络组件装配一个节点，用 stdin 的 JSON 行命令驱动。
// stdout 只输出命令应答（本夹具自有命令行协议，非 MCP）；日志走文件与 stderr。
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { loadConfig } from '../../src/config.js';
import { loadOrCreateInstanceId } from '../../src/instance-id.js';
import { createLogger } from '../../src/log.js';
import { collabFilePath } from '../../src/paths.js';
import { loadLines } from '../../src/storage.js';
import { createDiscovery } from '../../src/net/discovery.js';
import { createDispatch } from '../../src/net/dispatch.js';
import { INBOX_FILE_NAME, createInbound } from '../../src/net/inbound.js';
import { createKnownHosts } from '../../src/net/known-hosts.js';
import { createNetStack } from '../../src/net/stack.js';
import { createTransport } from '../../src/net/transport.js';

const options = JSON.parse(process.argv[2]);
const { dataDir, port, bindAddress, knownPeers = [] } = options;

function write(payload) {
  process.stdout.write(JSON.stringify(payload) + '\n');
}

const { config } = loadConfig(dataDir);   // 端口与加速参数由测试预写 config.json
const log = createLogger({ logDir: join(dataDir, 'logs'), maxBytes: config.logMaxBytes, maxFiles: config.logMaxFiles });
const instanceId = loadOrCreateInstanceId(dataDir);
const self = { instanceId, identityName: config.identityName };
const knownHosts = createKnownHosts({ dataDir, log });
for (const address of knownPeers) {
  knownHosts.remember({ address });
}
let sessionWriterOk = true;
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
    deliverToSession: () => sessionWriterOk,  // 预演：以开关模拟适配器的成败
  },
});
const stack = createNetStack({ discovery, transport, dispatch, inbound, port, self, scanWindowMs: config.scanWindowMs, log });

const bind = await stack.start();
write({ event: 'ready', instanceId, identityName: self.identityName, bind });

async function handle(line) {
  const command = JSON.parse(line);
  if (command.cmd === 'list_hosts') {
    const listed = await stack.listHosts();
    write({ ok: listed.ok, hosts: listed.hosts ?? [], message: listed.message ?? '' });
    return;
  }
  if (command.cmd === 'ping' || command.cmd === 'send' || command.cmd === 'status' || command.cmd === 'inbox') {
    write(await queryReply(command));
    return;
  }
  if (command.cmd === 'set_writer') {
    sessionWriterOk = command.ok === true;
    write({ ok: true });
    return;
  }
  if (command.cmd === 'exit') {
    await shutdown();
    return;
  }
  write({ ok: false, error: `未知命令：${String(command.cmd)}` });
}

/* 查询类命令的应答出口（ping / send / status / inbox 共用）。 */
async function queryReply(command) {
  if (command.cmd === 'ping') {
    return { ok: true, ...(await stack.pingHost({ address: command.address })) };
  }
  if (command.cmd === 'send') {
    return { ok: true, ...stack.send({ collabId: command.collabId, to: command.to, type: command.type ?? 'notice', payload: command.payload }) };
  }
  if (command.cmd === 'status') {
    return { ok: true, rows: stack.deliveryStatus(command) };
  }
  return { ok: true, messages: loadLines(collabFilePath(dataDir, command.collabId, INBOX_FILE_NAME)).entries };
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
