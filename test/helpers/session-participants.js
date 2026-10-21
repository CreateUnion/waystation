import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ID_PATTERN, isIdentityName } from '../../src/net/protocol.js';
import { createCollabService } from '../../src/collab/service.js';
import { ledgerDigest } from '../../src/collab/store.js';
import { carrierFilePath, collabDir, collabFilePath, seatFilePath } from '../../src/paths.js';
import { createDiscovery } from '../../src/net/discovery.js';
import { createDispatch } from '../../src/net/dispatch.js';
import { createInbound } from '../../src/net/inbound.js';
import { createKnownHosts } from '../../src/net/known-hosts.js';
import { createTransport } from '../../src/net/transport.js';
import { pickFreePort, repoRoot, waitFor } from '../helpers.js';

/* 会话级参与者场景的测试夹具，分两部分：
 * 第一部分是纯数据构造（席位名单 / 台账 / 时钟 / 旧版安装包）——不 import 协作运行时：
 *   e2e 与模块测试共用同一组形态，避免各用例自行拼装 §2.1 名单条目时出现字段漂移；
 * 第二部分是进程内双节点装配（本文件下方）：真实 service / dispatch / transport / inbound，
 *   只把会话桥投递替换为记录面（桥 IPC 属组合根，e2e 断言的是本机旁路与网络链路）。 */

/* 固定基准时刻与名单加入步长：夹具必须可复现——取 Date.now() 会让快照/digest 类断言
 * 每次运行都不同，失败也无法重放。 */
const FIXTURE_EPOCH_MS = Date.parse('2026-10-21T00:00:00.000Z');
const ROSTER_JOIN_STEP_MS = 1000;

const DEFAULT_OLD_PACKAGE = '.superpowers/sdd/update-package/waystation-0.1.5.zip';
const SEAT_ROLES = ['manager', 'member'];
const LEDGER_STATUSES = ['proposed', 'active', 'frozen', 'completed', 'terminated'];
const TERMINAL_STATUSES = ['completed', 'terminated'];

export function makeTempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'waystation-participants-'));
  const cleanup = () => {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      /* Windows 下杀软/索引服务对刚写入的文件有瞬时占用：重试耗尽只留痕，
       * 收尾钩子抛出会让 node:test 跳过其后钩子，危害大于残留的临时目录。 */
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code)) {
        throw error;
      }
      console.error(`[测试收尾] 临时数据根删除失败（环境性占用，已重试）：${root}（${error.code}）`);
    }
  };
  if (typeof t?.after === 'function') {
    t.after(cleanup);
  } else {
    /* 不传测试上下文时退化为进程退出清理（exit 钩子须同步，rmSync 满足）；
     * 数据根始终落在系统临时目录，绝不写真实 ~/.waystation。 */
    process.once('exit', cleanup);
  }
  return root;
}

/* 单调钟与墙钟分离：设计同时要求「单调钟超时」与「墙钟回拨/前跳」两类用例——
 * advance 推进两者，setWall 只动墙钟，单调钟因此永不倒流。 */
export function makeFakeClock(start = 0) {
  assertFiniteMs(start, '时钟起点');
  let wallMs = start;
  let monoMs = start;
  return {
    now: () => wallMs,
    monotonic: () => monoMs,
    advance(ms) {
      assertFiniteMs(ms, 'advance');
      if (ms <= 0) {
        throw new RangeError(`advance 只接受正数毫秒：${ms}`);
      }
      wallMs += ms;
      monoMs += ms;
      return wallMs;
    },
    setWall(ms) {
      assertFiniteMs(ms, 'setWall');
      wallMs = ms;
      return wallMs;
    },
    iso: () => new Date(wallMs).toISOString(),
  };
}

export function makeSeat(spec = {}) {
  const {
    instanceId,
    sessionId,
    identityName = instanceId,
    role = 'member',
    state = 'member',
    joinSeq = 1,
    joinedAt = FIXTURE_EPOCH_MS,
  } = spec;
  assertId(instanceId, 'instanceId');
  assertId(sessionId, 'sessionId');
  if (!isIdentityName(identityName)) {
    throw new TypeError(`identityName 须为合法身份名：${String(identityName)}`);
  }
  if (!SEAT_ROLES.includes(role)) {
    throw new TypeError(`role 只允许 manager/member：${String(role)}`);
  }
  if (state !== 'member') {
    throw new TypeError(`共享名单条目恒为 member；joining 属本地席位文件，不在本夹具形态内：${String(state)}`);
  }
  assertPositiveInt(joinSeq, 'joinSeq');
  return { instanceId, sessionId, identityName, role, state, joinSeq, joinedAt: toIsoTimestamp(joinedAt) };
}

export function makeRoster(seats = []) {
  if (!Array.isArray(seats)) {
    throw new TypeError('makeRoster 需要席位规格数组');
  }
  const seen = new Set();
  return seats.map((spec, index) => {
    const seat = makeSeat({
      joinSeq: index + 1,
      joinedAt: FIXTURE_EPOCH_MS + index * ROSTER_JOIN_STEP_MS,
      ...spec,
    });
    const key = `${seat.instanceId}\u0000${seat.sessionId}`;
    if (seen.has(key)) {
      throw new TypeError(`名单不得出现重复席位键：${seat.instanceId}/${seat.sessionId}`);
    }
    seen.add(key);
    return seat;
  });
}

export function makeLedger(spec = {}) {
  const fields = parseLedgerSpec(spec);
  const roster = fields.members === undefined ? defaultRoster(fields.terminal) : makeRoster(fields.members);
  const ledger = {
    collabId: fields.collabId,
    name: fields.name,
    topic: `${fields.name} 主题`,
    mode: 'managed',
    status: fields.status,
    version: fields.version,
    managerTerm: fields.managerTerm,
    joinSeqNext: nextJoinSeq(roster),
    manager: resolveManager(fields.manager, roster, fields.managerTerm, fields.terminal),
    members: roster,
    board: [],
    createdAt: new Date(FIXTURE_EPOCH_MS).toISOString(),
    updatedAt: new Date(FIXTURE_EPOCH_MS).toISOString(),
  };
  if (fields.managerWindow !== undefined) {
    ledger.managerWindow = fields.managerWindow;
  }
  return ledger;
}

function parseLedgerSpec(spec) {
  const {
    collabId = 'collab-fixture',
    name = 'fixture-collab',
    status = 'active',
    managerTerm = 1,
    version = 1,
    manager,
    members,
    managerWindow,
  } = spec;
  assertId(collabId, 'collabId');
  if (!isIdentityName(name)) {
    throw new TypeError(`协作名须为合法身份名：${String(name)}`);
  }
  if (!LEDGER_STATUSES.includes(status)) {
    throw new TypeError(`status 非法：${String(status)}`);
  }
  assertPositiveInt(managerTerm, 'managerTerm');
  assertPositiveInt(version, 'version');
  const terminal = TERMINAL_STATUSES.includes(status);
  if (terminal && managerWindow !== undefined) {
    throw new TypeError('终态台账不携 managerWindow（运行时须清除窗口基准）');
  }
  return { collabId, name, status, managerTerm, version, manager, members, managerWindow, terminal };
}

/* 旧版安装包定位：相对路径以仓库根为锚（不随启动目录漂移）；文件缺失返回 null 而非抛出，
 * 让依赖旧包的对端兼容用例可按环境跳过而不是整轮失败。 */
export function oldPackagePath(env = process.env) {
  const configured = typeof env?.WS_OLD_PACKAGE === 'string' ? env.WS_OLD_PACKAGE.trim() : '';
  const candidate = resolve(repoRoot, configured === '' ? DEFAULT_OLD_PACKAGE : configured);
  if (!existsSync(candidate)) {
    return null;
  }
  try {
    return statSync(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

function defaultRoster(terminal) {
  if (terminal) {
    return [];
  }
  return makeRoster([{ instanceId: 'instance-fixture-a', sessionId: 'session-fixture-a', role: 'manager' }]);
}

function resolveManager(explicitManager, roster, managerTerm, terminal) {
  if (explicitManager === null) {
    if (!terminal) {
      throw new TypeError('非终态台账必须有站长；manager:null 仅终态允许');
    }
    return null;
  }
  if (explicitManager === undefined) {
    return managerFromRoster(roster, managerTerm, terminal);
  }
  return normalizeManager(explicitManager, roster, managerTerm);
}

function managerFromRoster(roster, managerTerm, terminal) {
  const managers = roster.filter((seat) => seat.role === 'manager');
  if (managers.length === 1) {
    const seat = managers[0];
    return { instanceId: seat.instanceId, sessionId: seat.sessionId, identityName: seat.identityName, term: managerTerm };
  }
  if (managers.length === 0 && terminal) {
    return null;
  }
  throw new TypeError(managers.length === 0
    ? '非终态台账名单必须含一位 role=manager 的站长席位'
    : '台账名单不得出现多位站长');
}

function normalizeManager(manager, roster, managerTerm) {
  if (typeof manager !== 'object' || manager === null || Array.isArray(manager)) {
    throw new TypeError('manager 须为 {instanceId,sessionId,...} 对象');
  }
  assertId(manager.instanceId, 'manager.instanceId');
  assertId(manager.sessionId, 'manager.sessionId');
  const seat = roster.find((item) => item.instanceId === manager.instanceId && item.sessionId === manager.sessionId);
  if (roster.length > 0 && seat === undefined) {
    throw new TypeError('台账 manager 必须与名单中的席位一致');
  }
  const identityName = managerIdentity(manager, seat);
  if (!isIdentityName(identityName)) {
    throw new TypeError(`manager.identityName 非法：${String(identityName)}`);
  }
  if (seat !== undefined && identityName !== seat.identityName) {
    throw new TypeError(`manager.identityName 须与名单席位一致：${String(identityName)}`);
  }
  const term = manager.term === undefined ? managerTerm : manager.term;
  assertPositiveInt(term, 'manager.term');
  return { instanceId: manager.instanceId, sessionId: manager.sessionId, identityName, term };
}

function managerIdentity(manager, seat) {
  if (manager.identityName !== undefined) {
    return manager.identityName;
  }
  if (seat === undefined) {
    return manager.instanceId;
  }
  return seat.identityName;
}

function nextJoinSeq(roster) {
  /* 站长初始序号为 1、joinSeqNext 初始 2；空名单（终态）仍从 2 起，与设计初值一致。 */
  let maxSeq = 1;
  for (const seat of roster) {
    if (seat.joinSeq > maxSeq) {
      maxSeq = seat.joinSeq;
    }
  }
  return maxSeq + 1;
}

function assertId(value, label) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new TypeError(`${label} 须匹配 ID_PATTERN（1–64 位字母数字/连字符）：${String(value)}`);
  }
}

function assertPositiveInt(value, label) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${label} 须为正整数：${String(value)}`);
  }
}

function assertFiniteMs(value, label) {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${label} 须为有限毫秒数：${String(value)}`);
  }
}

function toIsoTimestamp(value) {
  const ms = typeof value === 'string' ? Date.parse(value) : value;
  if (!Number.isFinite(ms)) {
    throw new TypeError(`joinedAt 须为可解析时间或毫秒数：${String(value)}`);
  }
  return new Date(ms).toISOString();
}

/* —— 进程内双节点场景（e2e 共用） ——
 * 真 service ＋ 真 dispatch/transport/inbound（真实回环 TCP 帧链路），只把「桥投递」替换为
 * 记录面：e2e 断言本机旁路注入、扇出、outbox/ack 与跨机收发的真实语义，不拉起子进程。 */

const NODE_IDENTITY = '测试站点';
const NODE_JOIN_STEP_MS = 1000;

export function sessionNodeConfig(overrides = {}) {
  return {
    identityName: NODE_IDENTITY,
    scanWindowMs: 100,
    dialTimeoutMs: 1500,
    dispatchTickMs: 50,
    retryIntervalMs: 200,
    retrySlowIntervalMs: 400,
    retryFastCount: 5,
    queueMaxPerCollab: 200,
    messageTtlMs: 120000,
    inviteTtlMs: 120000,
    joinRequestTtlMs: 120000,
    managerProbeIntervalMs: 100,
    managerLossTimeoutMs: 30000,
    sessionSeatGraceMs: 60000,
    sessionSeatTimeoutMs: 30000,
    seatPresenceIntervalMs: 5000,
    sessionTakeoverWindowMs: 60000,
    handoverConfirmTimeoutMs: 10000,
    joinConfirmTtlMs: 10000,
    pendingInvitesMax: 64,
    stagedMaxPerSeat: 100,
    stagedMaxPerCollab: 500,
    forumSyncIntervalMs: 3600000,
    freezeUnresolvedMs: 60000,
    autoDeliver: true,
    ...overrides,
  };
}

/* 节点装配：临时根先建、清理钩子先注册——任何构造中途失败都不会遗留目录或定时器。
 * spec.home 复用既有数据根（核重启用例：状态必须跨进程实例保留，清理交给用例的 makeTempRoot）；
 * spec.probeCapability 注入服务层能力闸门的探测面（未注入＝服务按「单测/降级」不设闸）。 */
export async function startSessionNode(t, spec = {}) {
  const node = await newNodeOf(spec);
  t.after(() => closeSessionNode(node));
  if (typeof spec.seed === 'function') {
    spec.seed(node.home);
  }
  await buildSessionNode(node);
  return node;
}

/* 数据根与端口需要 await/分支，其余字段是纯映射：拆成两步把单函数复杂度留在上限内。 */
async function newNodeOf(spec) {
  const ownsHome = spec.home === undefined;
  const home = ownsHome ? mkdtempSync(join(tmpdir(), 'waystation-session-e2e-')) : spec.home;
  const port = spec.port ?? await pickFreePort();
  return nodeStateOf(spec, { ownsHome, home, port, identityName: spec.identityName ?? NODE_IDENTITY });
}

function nodeStateOf(spec, base) {
  return {
    home: base.home,
    ownsHome: base.ownsHome,
    port: base.port,
    config: sessionNodeConfig({ ...(spec.config ?? {}), port: base.port, identityName: base.identityName }),
    self: { instanceId: spec.instanceId ?? `inst-${randomUUID().slice(0, 8)}`, identityName: base.identityName, port: base.port },
    online: new Set(spec.online ?? []),
    deliveries: new Map(),
    sentFrames: [],
    notices: [],
    /* 注入面故障注入（D11 重复帧补扇出用例）：列出的会话注入返回 null，扇出保留为 pending。 */
    failInjectFor: new Set(spec.failInjectFor ?? []),
    discoveryEnabled: spec.discovery === true,
    discoveryBindAddress: spec.discoveryBindAddress ?? '127.0.0.1',
    probeCapability: spec.probeCapability ?? null,
    now: spec.now ?? null,
    log: quietLog(),
  };
}

async function buildSessionNode(node) {
  node.knownHosts = createKnownHosts({ dataDir: node.home, log: node.log });
  node.transport = createTransport({ port: node.port, log: node.log });
  node.dispatch = createDispatch({ dataDir: node.home, config: node.config, transport: node.transport, self: node.self, log: node.log });
  captureOutgoing(node);
  node.service = createNodeService(node);
  node.inbound = createNodeInbound(node);
  node.transport.setFrameHandler(node.inbound.onFrame);
  node.dispatch.setClientFrameRouter(node.inbound.onFrame);
  node.dispatch.start();
  await node.transport.listen();
  if (node.discoveryEnabled) {
    node.discovery = createDiscovery({
      port: node.port,
      /* LAN 用例只在显式开启时运行：绑定回环，保证即便跑起来也不向真实网卡广播/应答。 */
      bindAddress: node.discoveryBindAddress,
      instanceId: node.self.instanceId,
      identityName: node.self.identityName,
      getCollabCount: () => node.service.count(),
      knownHosts: node.knownHosts,
      log: node.log,
      activeSessions: () => [],
    });
    await node.discovery.start();
  }
}

/* 出站帧留证：报告帧（零成功带原 fromSessionId）不经 service 发送面，必须从 dispatch 层截获。 */
function captureOutgoing(node) {
  const rawSend = node.dispatch.send.bind(node.dispatch);
  const rawSendDirect = node.dispatch.sendDirect.bind(node.dispatch);
  node.dispatch.send = (message) => {
    node.sentFrames.push(message);
    return rawSend(message);
  };
  node.dispatch.sendDirect = (message) => {
    node.sentFrames.push(message);
    return rawSendDirect(message);
  };
}

function createNodeService(node) {
  return createCollabService({
    dataDir: node.home,
    config: node.config,
    self: node.self,
    send: (message) => node.dispatch.send(message),
    sendDirect: (message) => node.dispatch.sendDirect(message),
    knownHosts: node.knownHosts,
    /* 生产组合根恒定注入能力探测面；e2e 默认不注入时服务不设闸，能力用例必须显式注入。 */
    probeCapability: node.probeCapability,
    /* 假时钟（移交时限语义用例）：不注入时服务用 Date.now；注入了才让用例推进「已过期」。 */
    now: node.now,
    notify: (frame) => {
      node.notices.push(frame);
      return true;
    },
    deliverSeat: (frame, seat) => deliverToSeat(node, frame, seat),
    log: node.log,
    syncPeerPicker: () => [],
    inviteMinIntervalMs: 0,
    ledgerFetchTimeoutMs: 1500,
    handshakeReplyTimeoutMs: 300,
    takeoverProbeIntervalMs: 100,
  });
}

function createNodeInbound(node) {
  return createInbound({
    dataDir: node.home,
    config: node.config,
    self: node.self,
    dispatch: node.dispatch,
    log: node.log,
    hooks: {
      admit: (frame, meta) => node.service.hooks.admit(frame, meta),
      consume: (frame, meta) => node.service.hooks.consume(frame, meta),
      sessionGate: (frame, meta) => node.service.hooks.sessionGate(frame, meta),
      sessionDelivered: (frame) => node.service.hooks.sessionDelivered(frame),
      deliverToSession: (frame) => deliverToEverySeat(node, frame),
      listSeats: (collabId) => node.service.listInjectableTargets(collabId),
      injectSeat: (collabId, sessionId, frame) => {
        if (node.failInjectFor.has(sessionId)) {
          return null;
        }
        return node.service.injectLocalSeat(collabId, sessionId, frame);
      },
    },
  });
}

function deliverToSeat(node, frame, seat) {
  if (!node.online.has(seat.sessionId)) {
    return false;
  }
  const list = node.deliveries.get(seat.sessionId) ?? [];
  list.push({ type: frame.type, msgId: frame.msgId, payload: frame.payload, frame });
  node.deliveries.set(seat.sessionId, list);
  return true;
}

function deliverToEverySeat(node, frame) {
  let delivered = false;
  for (const seat of node.service.listLocalSeats(frame.collabId)) {
    delivered = deliverToSeat(node, frame, seat) || delivered;
  }
  return delivered;
}

/* 显式关闭（核重启用例需要「先关停、再以同一数据根换一个实例」）：收尾钩子会重复调用，
 * 因此清理必须幂等；复用外部传入的数据根时不得删除（状态要留给重启后的节点）。 */
export async function closeSessionNode(node) {
  if (node.closed === true) {
    return;
  }
  node.closed = true;
  node.online.clear();
  await quietClose(() => node.discovery?.close());
  await quietClose(() => node.service?.close());
  await quietClose(() => node.dispatch?.stop());
  await quietClose(() => node.transport?.close());
  if (node.ownsHome === false) {
    return;
  }
  try {
    rmSync(node.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (error) {
    if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code)) {
      throw error;
    }
    console.error(`[测试收尾] 临时数据根删除失败（环境性占用，已重试）：${node.home}（${error.code}）`);
  }
}

/* 收尾逐件独立：构造中途失败的组件可能根本不存在，单件异常不得阻断其余收尾。 */
async function quietClose(close) {
  try {
    await close();
  } catch {
    // 未构造/未启动：无需关闭
  }
}

/* 两节点互通：已知主机清单是端点与能力的来源（真实扫描在进程内的等价写入面）。 */
export function linkSessionNodes(left, right, { leftParticipants = 2, rightParticipants = 2 } = {}) {
  rememberSessionPeer(left, right, leftParticipants);
  rememberSessionPeer(right, left, rightParticipants);
}

function rememberSessionPeer(node, peer, participants) {
  node.knownHosts.remember({
    address: '127.0.0.1',
    port: peer.port,
    instanceId: peer.self.instanceId,
    identityName: peer.self.identityName,
    participants,
    source: participants === 0 ? 'probe' : 'scan',
  });
}

/* 目标描述符：建协作 targets、邀请与移交的目标字段共用。 */
export function targetOf(node, extra = {}) {
  return {
    instanceId: node.self.instanceId,
    identityName: node.self.identityName,
    address: '127.0.0.1',
    port: node.port,
    ...extra,
  };
}

/* 端点描述符：种子写的成员端点表与 known-hosts 同形（127.0.0.1 回环）。 */
export function endpointOf(node) {
  return { address: '127.0.0.1', port: node.port };
}

export function injectionsOf(node, sessionId) {
  return node.deliveries.get(sessionId) ?? [];
}

export function injectionTextsOf(node, sessionId) {
  return injectionsOf(node, sessionId).map((entry) => entry.payload?.text ?? '');
}

export function waitForInjection(node, sessionId, predicate, options = {}) {
  return waitFor(() => predicate(injectionsOf(node, sessionId)) || null, { timeoutMs: 10000, ...options });
}

/* 本机会话上线/离线：桥注册面与投递面同点（与组合根的桥注册/断开同形）。 */
export async function bringSessionOnline(node, sessionId) {
  node.online.add(sessionId);
  return node.service.registerBridgeEntry(sessionId, `bridge-${sessionId}`);
}

export async function bringSessionOffline(node, sessionId) {
  node.online.delete(sessionId);
  return node.service.unregisterBridgeEntry(sessionId, `bridge-${sessionId}`);
}

/* 直接喂帧（模拟对端直连）：走真实接收管线（准入 → 落盘 → 消费 → 扇出）。
 * onFrame 只把处理链登记到内部 chain，不返回等待面；用例需要「喂完即断言」时必须等管线收敛——
 * 以计数快照连续两次不变作为静止判据（有界，最多 1s）。 */
export async function feedSessionFrame(node, frame, { remoteAddress = '127.0.0.1' } = {}) {
  const acks = [];
  node.inbound.onFrame({ remoteAddress, send: (out) => acks.push(out) }, frame);
  await settleInbound(node);
  return acks;
}

async function settleInbound(node) {
  let previous = inboundProgressOf(node);
  for (let round = 0; round < 25; round++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const current = inboundProgressOf(node);
    if (current === previous) {
      return;
    }
    previous = current;
  }
}

function inboundProgressOf(node) {
  const counters = node.inbound.stats();
  delete counters.frames;   // frames 在 onFrame 入口同步自增，不能作为「处理完成」的信号
  return JSON.stringify(counters);
}

/* 种子协作：新形态 carrier + 台账 + 快照 + 席位文件（真实加载路径；不写旧形态字段）。 */
export function seedSessionCollab(home, collabId, spec = {}) {
  const ledger = makeLedger({
    collabId,
    name: spec.name ?? '种子协作',
    status: spec.status ?? 'active',
    managerTerm: spec.managerTerm ?? 1,
    version: spec.version ?? 2,
    manager: spec.manager,
    members: spec.members,
    managerWindow: spec.managerWindow,
  });
  const dir = collabDir(home, collabId);
  mkdirSync(join(dir, 'seats'), { recursive: true });
  writeSeedCarrier(home, collabId, ledger, spec);
  writeFileSync(collabFilePath(home, collabId, 'ledger.jsonl'), `${JSON.stringify(ledger)}\n`, 'utf8');
  writeSeedSnapshot(home, collabId, ledger, spec);
  writeSeedSeats(home, collabId, spec.seats ?? []);
  if (spec.member !== undefined) {
    writeJsonFile(join(dir, 'member.json'), spec.member);
  }
  return ledger;
}

function writeSeedCarrier(home, collabId, ledger, spec) {
  const carrier = {
    format: 'session-seats',
    version: 1,
    collabId,
    name: ledger.name,
    topic: ledger.topic,
    mode: ledger.mode,
    endpoints: spec.endpoints ?? {},
    snapshotVersion: ledger.version,
    createdAt: ledger.createdAt,
  };
  if (ledger.manager !== null) {
    carrier.manager = ledger.manager;
  }
  writeJsonFile(carrierFilePath(home, collabId), carrier);
}

function writeSeedSnapshot(home, collabId, ledger, spec) {
  writeJsonFile(join(collabDir(home, collabId), 'snapshot.json'), {
    version: ledger.version,
    digest: ledgerDigest(ledger),
    receivedAt: new Date(FIXTURE_EPOCH_MS).toISOString(),
    from: { instanceId: spec.snapshotFrom ?? 'inst-peer', identityName: '对端' },
    ledger,
  });
}

function writeSeedSeats(home, collabId, seats) {
  seats.forEach((seat, index) => {
    writeJsonFile(seatFilePath(home, collabId, seat.sessionId), {
      version: 1,
      sessionId: seat.sessionId,
      role: seat.role ?? 'member',
      state: 'member',
      joinSeq: seat.joinSeq ?? index + 1,
      joinedAt: new Date(FIXTURE_EPOCH_MS + index * NODE_JOIN_STEP_MS).toISOString(),
      muted: seat.muted === true,
    });
  });
}

/* 旧形态协作：member.json ＋ 旧台账（只用于 legacy 只读判定，不参与新形态加载）。 */
export function seedLegacyCollab(home, collabId, spec = {}) {
  const dir = collabDir(home, collabId);
  mkdirSync(dir, { recursive: true });
  const instanceId = spec.instanceId ?? 'inst-old';
  const identityName = spec.identityName ?? '旧机';
  const name = spec.name ?? '旧协作';
  const topic = spec.topic ?? '旧主题';
  writeJsonFile(join(dir, 'member.json'), {
    collabId,
    name,
    topic,
    role: 'manager',
    state: 'active',
    manager: { instanceId, identityName },
    endpoints: {},
    roster: [{ instanceId, identityName }],
    mode: 'managed',
    decision: 'approved',
  });
  const ledger = {
    version: 3,
    collabId,
    name,
    topic,
    status: 'active',
    manager: { instanceId, identityName },
    members: [{ instanceId, identityName, role: 'manager', state: 'member', joinedAt: new Date(FIXTURE_EPOCH_MS).toISOString() }],
    board: [],
    createdAt: new Date(FIXTURE_EPOCH_MS).toISOString(),
    updatedAt: new Date(FIXTURE_EPOCH_MS).toISOString(),
  };
  writeFileSync(join(dir, 'ledger.jsonl'), `${JSON.stringify(ledger)}\n`, 'utf8');
  return ledger;
}

function writeJsonFile(file, value) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function quietLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}
