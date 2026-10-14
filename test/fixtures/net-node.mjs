// 双进程预演的驿站节点：以真实网络组件 + 协作服务装配一个节点，用 stdin 的 JSON 行命令驱动。
// stdout 只输出命令应答（本夹具自有命令行协议，非 MCP）；日志走文件与 stderr。
import { createInterface } from 'node:readline';
import { loadConfig } from '../../src/config.js';
import { loadOrCreateInstanceId } from '../../src/instance-id.js';
import { createLogger } from '../../src/log.js';
import { collabFilePath, resolveLogDir } from '../../src/paths.js';
import { loadLines } from '../../src/storage.js';
import { createClaudeCodeAdapter } from '../../src/adapters/claude-code.js';
import { createCollabService } from '../../src/collab/service.js';
import { createDiscovery } from '../../src/net/discovery.js';
import { createDispatch } from '../../src/net/dispatch.js';
import { INBOX_FILE_NAME, createInbound } from '../../src/net/inbound.js';
import { createKnownHosts } from '../../src/net/known-hosts.js';
import { createNetStack } from '../../src/net/stack.js';
import { createTransport } from '../../src/net/transport.js';

const options = JSON.parse(process.argv[2]);
const { dataDir, bindAddress, knownPeers = [] } = options;
/* collab 门控开关（缺省 true = 与生产同参装配）：false = 纯传输层回归——无协作台账、门控回全准入，
 * 供 M2/M3 存量消息用例保持「不建协作、直发直收」的定位（协作场景一律走缺省 true）。 */
const collabEnabled = options.collab !== false;

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
 * 缺省 = set_writer 开关桩（自动预演用，不依赖真实会话）。描述器指向协作服务（与生产同参）。 */
const adapter = options.adapter === true
  ? createClaudeCodeAdapter({ env: process.env, log, describeCollab: (collabId) => collab.describe(collabId) })
  : null;
const transport = createTransport({ port, bindAddress, log });
const dispatch = createDispatch({ dataDir, config, transport, self, log });
/* 协作服务与生产组合根同参等价（除非显式注明的刻意差异）：发送经可靠队列、探测经即时通道、
 * 队列改投经调度出口、清单接入、描述器接线、提示经注入口（适配器缺失时无提示面）。 */
const collab = createCollabService({
  dataDir,
  config,
  self,
  send: (message) => dispatch.send(message),
  probe: (address, port) => dispatch.ping({ address, port }),
  reassign: (payload) => dispatch.reassignPeer(payload),
  notify: adapter !== null ? (frame) => adapter.deliverFrame(frame) : null,
  knownHosts,
  log,
});
const discovery = createDiscovery({
  port,
  bindAddress,
  instanceId,
  identityName: self.identityName,
  getCollabCount: () => collab.count(),
  knownHosts,
  log,
});
const inbound = createInbound({
  dataDir,
  config,
  self,
  dispatch,
  log,
  hooks: {
    ...(collabEnabled
      ? {
          admit: (frame, meta) => collab.hooks.admit(frame, meta),
          consume: (frame, meta) => collab.hooks.consume(frame, meta),
          sessionGate: (frame) => collab.hooks.sessionGate(frame),
          sessionDelivered: (frame) => collab.hooks.sessionDelivered(frame),
        }
      : { admit: () => ({ ok: true }) }),   // collab:false = 纯传输层预演：全准入（M2/M3 既有形态）
    deliverToSession: adapter !== null ? (frame) => adapter.deliverFrame(frame) : () => sessionWriterOk,
  },
});
const stack = createNetStack({ discovery, transport, dispatch, inbound, port, self, scanWindowMs: config.scanWindowMs, log });

const bind = await stack.start();
if (bind.ok) {
  collab.start();   // 探测定时器 + 启动握手——与生产组合根同参（降级不启动）
}
write({ event: 'ready', instanceId, identityName: self.identityName, port, bind });

/* 命令表（条件链改查表：新增命令不再抬升 handle 的圈复杂度；exit 自行退出、以 null 表示无应答）。 */
const COMMANDS = {
  list_hosts: async () => {
    const listed = await stack.listHosts();
    return { ok: listed.ok, hosts: listed.hosts ?? [], message: listed.message ?? '' };
  },
  ping: async (command) => ({ ok: true, ...(await stack.pingHost({ address: command.address, port: command.port })) }),
  send: async (command) => ({ ok: true, ...stack.send({ collabId: command.collabId, to: command.to, type: command.type ?? 'reply', payload: command.payload }) }),
  status: async (command) => ({ ok: true, rows: stack.deliveryStatus(command) }),
  inbox: async (command) => ({ ok: true, messages: loadLines(collabFilePath(dataDir, command.collabId, INBOX_FILE_NAME)).entries }),
  // 会话主动查路径（生产由 ws_check_inbox 工具承载）：
  check_inbox: async (command) => ({ ok: true, result: stack.checkInbox({ collabId: command.collabId, limit: command.limit }) }),
  set_writer: async (command) => {
    sessionWriterOk = command.ok === true;
    return { ok: true };
  },
  // 协作服务命令（生产由 ws_* 工具承载；本夹具直调服务公共面）：
  create_collab: async (command) => collab.create({ name: command.name, topic: command.topic, targets: command.targets }),
  approve_invite: async (command) => collab.approve({ collabId: command.collabId, approve: command.approve, reason: command.reason }),
  withdraw_invite: async (command) => collab.withdraw({ collabId: command.collabId, target: command.target }),
  send_message: async (command) => collab.send({ collabId: command.collabId, text: command.text, type: command.type, to: command.to }),
  view_ledger: async (command) => collab.view({ collabId: command.collabId }),
  set_mute: async (command) => collab.setMute({ collabId: command.collabId, muted: command.muted }),
  list_collabs: async () => collab.list(),
  end_collab: async (command) => collab.end({ collabId: command.collabId }),
  leave_collab: async (command) => collab.leave({ collabId: command.collabId }),
  // 治理命令（生产由 ws_decide / ws_handover / ws_take_over 工具承载）：
  decide: async (command) => collab.decide({ collabId: command.collabId, choice: command.choice }),
  decide_merge_offer: async (command) => collab.decideMerge({ collabId: command.collabId, mergeOffer: command.mergeOffer }),
  handover: async (command) => collab.handover({ collabId: command.collabId, target: command.target }),
  take_over: async (command) => collab.takeOver({ collabId: command.collabId }),
  take_over_confirm: async (command) => collab.takeOver({ collabId: command.collabId, confirm: true }),
  take_over_decline: async (command) => collab.takeOver({ collabId: command.collabId, confirm: false }),
  handshake: async () => {
    await collab.handshake();
    return { ok: true };
  },
  collab_stats: async () => ({ ok: true, stats: collab.stats() }),
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

/* 收尾：先收协作层等待面（与生产组合根同序），再撤下网络层，最后等 stdout 冲刷完成后退出——
 * process.exit 不等待写完成，Linux 下应答会整包丢失（Windows 行为不同，会掩盖该缺陷）。 */
async function shutdown() {
  collab.close();
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
