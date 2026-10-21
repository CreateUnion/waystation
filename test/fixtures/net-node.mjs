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
/* 本夹具进程模拟「一个会话」：生产会话标识来自 CLAUDE_CODE_SESSION_ID，预演进程没有该环境，
 * 由实例标识派生一个稳定标识——同一数据目录重启仍是同一会话（离线续投、重启收敛用例依赖这一点），
 * 不与真实会话标识冲突（fixture- 前缀）。需要多会话的用例可经 options.sessionId 显式指定。 */
const sessionId = typeof options.sessionId === 'string' && options.sessionId !== '' ? options.sessionId : `fixture-${instanceId}`;
const self = { instanceId, identityName: config.identityName, port };
const knownHosts = createKnownHosts({ dataDir, log });
for (const peer of knownPeers) {
  knownHosts.remember({ address: peer.address, port: peer.port });
}
let sessionWriterOk = true;
/* 网络组件在协作服务之后构造（生产组合根同序），能力探测经闭包在运行期触达。 */
const net = { stack: null, inbound: null };
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
  /* 直投面与查询面按生产组合根同参注入（deliveryWiringOf）：预演的「机器级状态＋本机席位明细」
   * 与生产走同一接缝——少了这两个注入，本机旁路账的查询永远走不到。 */
  sendDirect: (message) => dispatch.sendDirect(message),
  deliveryStatusOf: (msgId) => dispatch.deliveryStatusOf(msgId),
  localSeatDeliveryOf: (msgId, sessionId) => net.inbound?.localSeatDeliveryOf(msgId, sessionId)
    ?? { collabId: null, msgId, sessionId, status: 'unknown', complete: false },
  probe: (address, port) => dispatch.ping({ address, port }),
  reassign: (payload) => dispatch.reassignPeer(payload),
  notify: adapter !== null ? (frame) => adapter.deliverFrame(frame) : null,
  /* 本机席位交付面：预演会话视为桥在线（set_writer 开关桩控制成功/失败）——与生产
   * routing.deliverToSeat 的「桥在则直投」同一语义，离线暂存/补投仍由服务层判定。 */
  deliverSeat: () => sessionWriterOk,
  /* 能力闸门：建协/邀请/加入前探目标 participants——与生产同参（预演两端都是 0.2.0，
   * 探测应得「支持」；探测本身也覆盖发现面能力字段的往返）。 */
  probeCapability: (probeOptions) => net.stack.probeCapability(probeOptions),
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
          sessionGate: (frame, meta) => collab.hooks.sessionGate(frame, meta),
          sessionDelivered: (frame) => collab.hooks.sessionDelivered(frame),
          /* 席位扇出面（设计 §5.2/§5.3）：与生产组合根同参——可注入目标 = 本机席位 ∪ 注册桥，
           * 内容帧按 toSessions / 活跃席位注入，两段式入席的核内协议帧经 injectLocalSeat 处置。 */
          listSeats: (collabId) => collab.listInjectableTargets(collabId),
          injectSeat: (collabId, targetSessionId, frame) => collab.injectLocalSeat(collabId, targetSessionId, frame),
        }
      : { admit: () => ({ ok: true }) }),   // collab:false = 纯传输层预演：全准入（M2/M3 既有形态）
    deliverToSession: adapter !== null ? (frame) => adapter.deliverFrame(frame) : () => sessionWriterOk,
  },
});
net.inbound = inbound;
const stack = createNetStack({ discovery, transport, dispatch, inbound, port, self, scanWindowMs: config.scanWindowMs, log });
net.stack = stack;

const bind = await stack.start();
if (bind.ok) {
  collab.start();   // 探测定时器 + 启动握手——与生产组合根同参（降级不启动）
  /* 会话注册面：生产在会话桥接入时登记；预演节点只有一个合成会话，启动即注册——
   * 未入席的受邀会话必须先在可注入面里，邀请首帧才投得进来（设计 §5.2）。 */
  await collab.registerBridgeEntry(sessionId, 'fixture-bridge');
}
write({ event: 'ready', instanceId, sessionId, identityName: self.identityName, port, bind });

/* 调用会话：命令可显式指定，缺省＝本预演进程的合成会话（与工具层 context.sessionId 同一穿参形态）。 */
function callerSessionOf(command) {
  return typeof command.sessionId === 'string' && command.sessionId !== '' ? command.sessionId : sessionId;
}

/* 邀请确认门的人类确认面：真实 CLI 由用户点头并重试携带 confirmToken；预演进程没有交互面，
 * 这里自动完成同一动作（携首调签发的令牌重试）——被验证的是两段式入席链路，不是用户确认弹层。 */
async function approveWithAutoConsent(input) {
  const first = await collab.approve(input);
  if (first?.needsUserConfirmation !== true || typeof first.confirmToken !== 'string') {
    return first;
  }
  return collab.approve({ ...input, confirmToken: first.confirmToken });
}

/* 本会话在目标机上挂起邀请的记录（生产由 ws_list_collabs 的待回应邀请条目承载 inviteId；
 * 夹具直接从加入域取同一份簿记）。 */
function pendingInviteIdOf(command) {
  if (typeof command.inviteId === 'string' && command.inviteId !== '') {
    return command.inviteId;
  }
  const pending = collab.join.pendingInvitesFor({ collabId: command.collabId, sessionId: callerSessionOf(command) });
  return Array.isArray(pending) && pending.length > 0 ? pending[0].inviteId : undefined;
}

/* 命令表（条件链改查表：新增命令不再抬升 handle 的圈复杂度；exit 自行退出、以 null 表示无应答）。 */
const COMMANDS = {
  list_hosts: async () => {
    const listed = await stack.listHosts();
    return { ok: listed.ok, hosts: listed.hosts ?? [], message: listed.message ?? '' };
  },
  ping: async (command) => ({ ok: true, ...(await stack.pingHost({ address: command.address, port: command.port })) }),
  send: async (command) => ({
    ok: true,
    ...stack.send({
      collabId: command.collabId,
      to: command.to,
      type: command.type ?? 'reply',
      payload: command.payload,
      fromSessionId: callerSessionOf(command),
      ...(Array.isArray(command.toSessions) ? { toSessions: command.toSessions } : {}),
    }),
  }),
  status: async (command) => ({ ok: true, rows: stack.deliveryStatus(command) }),
  inbox: async (command) => ({ ok: true, messages: loadLines(collabFilePath(dataDir, command.collabId, INBOX_FILE_NAME)).entries }),
  // 会话主动查路径（生产由 ws_check_inbox 工具承载）：
  check_inbox: async (command) => ({ ok: true, result: stack.checkInbox({ collabId: command.collabId, limit: command.limit, sessionId: callerSessionOf(command) }) }),
  set_writer: async (command) => {
    sessionWriterOk = command.ok === true;
    return { ok: true };
  },
  // 协作服务命令（生产由 ws_* 工具承载；本夹具直调服务公共面，会话标识按工具层同形穿参）：
  create_collab: async (command) => collab.create({ name: command.name, topic: command.topic, mode: command.mode, targets: command.targets, sessionId: callerSessionOf(command) }),
  approve_invite: async (command) => approveWithAutoConsent({
    collabId: command.collabId,
    inviteId: pendingInviteIdOf(command),
    approve: command.approve,
    reason: command.reason,
    sessionId: callerSessionOf(command),
  }),
  withdraw_invite: async (command) => (typeof command.inviteId === 'string' && command.inviteId !== ''
    ? collab.join.withdrawInvite({ collabId: command.collabId, inviteId: command.inviteId, managerSessionId: callerSessionOf(command) })
    : collab.withdraw({ collabId: command.collabId, target: command.target, sessionId: callerSessionOf(command) })),
  send_message: async (command) => collab.send({ collabId: command.collabId, text: command.text, type: command.type, to: command.to, toSessionId: command.toSessionId, sessionId: callerSessionOf(command) }),
  view_ledger: async (command) => collab.view({ collabId: command.collabId }),
  set_mute: async (command) => collab.setMute({ collabId: command.collabId, muted: command.muted, sessionId: callerSessionOf(command) }),
  list_collabs: async (command) => collab.list({ sessionId: callerSessionOf(command) }),
  end_collab: async (command) => collab.end({ collabId: command.collabId, sessionId: callerSessionOf(command) }),
  leave_collab: async (command) => collab.leave({ collabId: command.collabId, sessionId: callerSessionOf(command) }),
  // 治理命令（生产由 ws_decide / ws_handover / ws_take_over 工具承载）：
  decide: async (command) => collab.decide({ collabId: command.collabId, choice: command.choice, sessionId: callerSessionOf(command) }),
  decide_merge_offer: async (command) => collab.decideMerge({ collabId: command.collabId, mergeOffer: command.mergeOffer, sessionId: callerSessionOf(command) }),
  handover: async (command) => collab.handover({ collabId: command.collabId, target: command.target, targetSessionId: command.targetSessionId, sessionId: callerSessionOf(command) }),
  handover_confirm: async (command) => collab.confirmHandover({ collabId: command.collabId, offerId: command.offerId, token: command.token, sessionId: callerSessionOf(command) }),
  handover_reject: async (command) => collab.rejectHandover({ collabId: command.collabId, offerId: command.offerId, reason: command.reason, sessionId: callerSessionOf(command) }),
  take_over: async (command) => collab.takeOver({ collabId: command.collabId, token: command.token, sessionId: callerSessionOf(command) }),
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
