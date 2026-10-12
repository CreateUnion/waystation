import { randomUUID } from 'node:crypto';
import dgram from 'node:dgram';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { CONFIG_FILE_NAME, DATA_DIR_ENV, resolveDataDir, siteDataDir } from './paths.js';
import { PROTOCOL_VERSION, isPort, validateProbeAck } from './net/protocol.js';

/* 站点域（设计 §13 多站点，模型 A）：一台机器上的每个驿站进程 = 一个站点——
 * 独立数据目录 + 独立站点实例标识 + 独立 LAN 端口。本模块含「锚点与槽位数学」与
 * 槽位解析（resolveSite：取锁探测、占用者双证据分类、显式端口接管）。
 * 「默认端口」为内置常量：各端一致、不随任何配置变化——它是广播锚点与槽位段的基准
 * （发布前登记见设计 §18；数值的唯一权威源即本文件，config 的默认值引用它）。 */
export const ANCHOR_PORT = 7321;
export const SLOT_COUNT = 8;

/** 槽位 k（1..SLOT_COUNT）的默认端口：锚点起的连续段，槽位 1 = 锚点本身。
 * 非法槽位一律抛错（与路径层同思路：不做清洗，让编程错误当场显形）。 */
export function slotDefaultPort(slot) {
  if (!Number.isInteger(slot) || slot < 1 || slot > SLOT_COUNT) {
    throw new TypeError(`槽位非法（应为 1–${SLOT_COUNT} 的整数）：${String(slot)}`);
  }
  return ANCHOR_PORT + slot - 1;
}

/* 占用者探测总预算的模块默认值：与 config.probeTimeoutMs 的默认一致。resolveSite 先于配置载入
 * （数据目录由解析结果决定），故以本模块默认值为准、测试经 options.probeTimeoutMs 注入；
 * 运行期 stack 的占用探测以 config.probeTimeoutMs 为准（数值的配置权威源在 config.buildDefaults）。 */
export const OCCUPIER_PROBE_TIMEOUT_MS = 1000;

/**
 * 站点槽位解析（设计 §13 多站点规程）：决定本站点用哪个数据目录与哪个 LAN 端口——必须先于组件构造
 * （组件要拿端口）、也先于配置载入（数据目录决定读哪份 config.json）。
 * 四种结局：槽位模式 / 显式数据目录模式，各含成功与降级两类；永不抛出（失败以 { ok:false, reason, message } 返回，
 * 由组合根降级启动——进程继续作为本地 MCP 服务）。唯一的写动作（显式目录首跑端口写回）由组合根执行：
 * 本函数只以 writeBackPort 标记提请。
 * options.segmentBase / options.mainDir 为测试注入缝（生产一律缺省：锚点 / resolveDataDir(env)），不是配置面。
 */
/**
 * @typedef {{ ok: true, mode: 'slot' | 'explicit', dataDir: string, slot: number | null, port: number, takeover: boolean, writeBackPort: boolean }
 *   | { ok: false, reason: 'takeover-taken' | 'anchor-taken' | 'segment-exhausted' | 'bind-failed', message: string }} SiteResult
 */

/**
 * @param {{ env?: Record<string, string | undefined>, warn?: (message: string) => void, probeTimeoutMs?: number, segmentBase?: number, mainDir?: string }} [options]
 * @returns {Promise<SiteResult>}
 */
export async function resolveSite(options = {}) {
  const env = options.env ?? process.env;
  const warn = options.warn ?? defaultWarn;
  const probeTimeoutMs = options.probeTimeoutMs ?? OCCUPIER_PROBE_TIMEOUT_MS;
  const segmentBase = options.segmentBase ?? ANCHOR_PORT;
  const explicitDir = typeof env[DATA_DIR_ENV] === 'string' && env[DATA_DIR_ENV].trim() !== '';
  if (explicitDir) {
    return resolveExplicitDir(resolveDataDir(env), { warn, probeTimeoutMs, segmentBase });
  }
  return resolveSlotSite(options.mainDir ?? resolveDataDir(env), { warn, probeTimeoutMs, segmentBase });
}

/* 槽位模式（默认数据目录）：从槽位 1 起逐槽搜索「取锁成功」的最低槽位。
 * 被占槽位的分类（R-1 落定）：合法驿站 → 顺延；无关程序 → 槽位 1 报错降级（不递增、不静默离开广播锚点）、
 * 槽位 k≥2 跳过；接管槽位被任何占用者占 → 一律顺延（占则跳——多终端不被单个被占端口钉死）。
 * 「显式端口被任何占用者占 → 报错降级」的字面语义落在显式数据目录模式与绑定竞态（本模式无此分支：
 * 槽位不被本终端取得即站点不成立，转向下一槽位是搜索语义而非站点改端口）。 */
/**
 * @param {string} mainDir
 * @param {{ warn: (message: string) => void, probeTimeoutMs: number, segmentBase: number }} options
 * @returns {Promise<SiteResult>}
 */
async function resolveSlotSite(mainDir, options) {
  for (let slot = 1; slot <= SLOT_COUNT; slot++) {
    const dir = slot === 1 ? mainDir : siteDataDir(mainDir, slot);
    const defaultPort = options.segmentBase + slot - 1;
    const explicitPort = explicitPortOf(dir, defaultPort);
    const port = explicitPort ?? defaultPort;
    const acquired = await tryAcquire({ port });
    if (acquired.ok) {
      return { ok: true, mode: 'slot', dataDir: dir, slot, port, takeover: explicitPort !== null, writeBackPort: false };
    }
    if (acquired.reason === 'bind-error') {
      return { ok: false, reason: 'bind-failed', message: `端口 ${port} 监听失败（${acquired.error.message}）——局域网功能不可用` };
    }
    /* 接管槽位被占（驿站或其他占用者）：该槽位按搜索跳过（占则跳）——但用户显式配置失效不得静默，向 warn 通道留痕；
     * 顺延不检查占用者类别（多开不被单个被占端口钉死），留痕覆盖两类占用。 */
    if (explicitPort !== null) {
      options.warn(`配置的端口 ${explicitPort} 被占用——该站点按槽位搜索顺延（config.json 中的 port 未生效）`);
      continue;
    }
    if (await hasLegalStation({ port, probeTimeoutMs: options.probeTimeoutMs, warn: options.warn })) {
      continue;   // 槽位在用（运行中的站点）：顺延——多终端的正常路径
    }
    if (slot === 1) {
      return {
        ok: false,
        reason: 'anchor-taken',
        message: `默认端口 ${defaultPort} 被其他程序占用——无显式配置时不自动递增（不静默离开广播锚点）；请释放该端口，或改用显式数据目录（WAYSTATION_HOME）固定站点目录`,
      };
    }
  }
  return {
    ok: false,
    reason: 'segment-exhausted',
    message: `端口段 ${options.segmentBase}–${options.segmentBase + SLOT_COUNT - 1} 的 ${SLOT_COUNT} 个槽位均不可用——本地功能可用，依赖局域网的工具暂不可用；释放端口或减少同机终端数后重启`,
  };
}

/* 显式数据目录（WAYSTATION_HOME）：目录固定、不参与槽位分配。
 * 有显式 port（任何合法值）→ 固定该端口：被任何占用者占 → 报错降级（不递增、不静默改——设计字面语义）；
 * 无显式 port → 首跑取端口段中最低空闲，以 writeBackPort 提请组合根写回（合并进首跑配置落盘、先于生效落盘）。 */
/**
 * @param {string} dir
 * @param {{ warn: (message: string) => void, probeTimeoutMs: number, segmentBase: number }} options
 * @returns {Promise<SiteResult>}
 */
async function resolveExplicitDir(dir, options) {
  const explicitPort = rawPortOf(dir);
  if (explicitPort !== null) {
    const acquired = await tryAcquire({ port: explicitPort });
    if (acquired.ok) {
      return { ok: true, mode: 'explicit', dataDir: dir, slot: null, port: explicitPort, takeover: true, writeBackPort: false };
    }
    if (acquired.reason === 'bind-error') {
      return { ok: false, reason: 'bind-failed', message: `端口 ${explicitPort} 监听失败（${acquired.error.message}）——局域网功能不可用` };
    }
    return {
      ok: false,
      reason: 'takeover-taken',
      message: `显式端口 ${explicitPort} 被占用——已按 config.json 的显式端口固定：不自动改端口、不递增槽位；请释放该端口或修改 config.json 的 port`,
    };
  }
  for (let offset = 0; offset < SLOT_COUNT; offset++) {
    const port = options.segmentBase + offset;
    const acquired = await tryAcquire({ port });
    if (acquired.ok) {
      return { ok: true, mode: 'explicit', dataDir: dir, slot: null, port, takeover: false, writeBackPort: true };
    }
    if (acquired.reason === 'bind-error') {
      return { ok: false, reason: 'bind-failed', message: `端口 ${port} 监听失败（${acquired.error.message}）——局域网功能不可用` };
    }
  }
  return {
    ok: false,
    reason: 'segment-exhausted',
    message: `端口段 ${options.segmentBase}–${options.segmentBase + SLOT_COUNT - 1} 均不可用——本地功能可用，依赖局域网的工具暂不可用；释放端口后重启`,
  };
}

/* 槽位目录的显式端口判定：「端口值等于槽位默认端口视同未配置」（含历史版本首跑写入的默认值——
 * 多终端自动顺延不被它卡死）；读失败 / 损坏 / 非法值同样按未配置（与 loadConfig 的回落口径一致）。 */
function explicitPortOf(dir, defaultPort) {
  const port = rawPortOf(dir);
  if (port === null) {
    return null;
  }
  return port === defaultPort ? null : port;
}

/* 原始端口读取：只认「文件存在、JSON 可解析、根为对象、port 为 1–65535 整数」的情形。 */
function rawPortOf(dir) {
  /** @type {unknown} */
  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync(join(dir, CONFIG_FILE_NAME), 'utf8'));
  } catch {
    // 不存在 / 不可读 / 损坏与「形状不符」共用下方出口：都按未配置处理
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const port = /** @type {Record<string, unknown>} */ (parsed).port;
  if (!isPort(port)) {
    return null;
  }
  return port;
}

/* 取锁：UDP 与 TCP 同号都要能独占绑定（端口即槽位占用锁——绑定成功 = 取得槽位，无需额外锁文件）。
 * 取得后立即释放：真实监听由网络组件在引导完成后建立。释放与组件绑定之间有毫秒级竞态窗口——
 * 竞态由「组件绑定失败 → 占用者分类」兜底（设计如实记录的残余：极端并发退化为本终端会话期降级，重启即恢复）。 */
async function tryAcquire({ port }) {
  const udp = dgram.createSocket({ type: 'udp4', reuseAddr: false });
  try {
    await bindUdp(udp, port, '0.0.0.0');
  } catch (error) {
    closeSocketQuietly(udp);
    return acquireFailure(error);
  }
  const tcp = net.createServer();
  try {
    await listenTcp(tcp, port, '0.0.0.0');
  } catch (error) {
    closeSocketQuietly(udp);
    return acquireFailure(error);
  }
  await new Promise((resolve) => { tcp.close(resolve); });
  closeSocketQuietly(udp);
  return { ok: true };
}

function acquireFailure(error) {
  return error.code === 'EADDRINUSE'
    ? { ok: false, reason: 'in-use', error }
    : { ok: false, reason: 'bind-error', error };
}

async function bindUdp(socket, port, address) {
  return /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind({ port, address, exclusive: true }, () => {
      socket.removeListener('error', reject);
      resolve();
    });
  }));
}

async function listenTcp(server, port, address) {
  return /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port, host: address }, () => {
      server.removeListener('error', reject);
      resolve();
    });
  }));
}

function closeSocketQuietly(socket) {
  try {
    socket.close();
  } catch {
    // 未绑定成功的套接字无需关闭
  }
}

/* 双证据占用者分类（设计 §13 / I3 裁定）：任一证据给出合法驿站应答 → 驿站占用。
 * UDP 证据用前半预算（它覆盖「UDP 已绑、TCP 未绑」的并发启动窗口——占用者 UDP 必先绑），
 * TCP 证据用剩余预算并在预算内重试一次（覆盖占用者「已绑、回程处理器尚未接线」的启动瞬间）。 */
async function hasLegalStation({ port, probeTimeoutMs, warn }) {
  const deadline = Date.now() + probeTimeoutMs;
  const udpBudget = Math.max(1, Math.floor(probeTimeoutMs / 2));
  if (await udpEvidence({ port, budgetMs: udpBudget, warn })) {
    return true;
  }
  return tcpEvidence({ port, budgetMs: Math.max(1, deadline - Date.now()), warn });
}

/* UDP 证据：临时套接字发一个合法 probe（本站点尚未引导，用一次性随机标识——对端按陌生站点记入清单，
 * 随后被本站点真实标识的探测/应答覆盖，键为「地址:端口」），收合法 probe-ack 即证据。 */
async function udpEvidence({ port, budgetMs, warn }) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: false });
  try {
    await bindUdp(socket, 0, '0.0.0.0');
  } catch (error) {
    warn(`占用者探测的临时套接字建立失败（${error.message}），按无应答处理`);
    closeSocketQuietly(socket);
    return false;
  }
  /** @type {ReturnType<typeof setTimeout> | null} */
  let waitTimer = null;
  try {
    // 目标端口无 UDP 监听时，ICMP 端口不可达可能在套接字上异步反映为错误——它只意味着「无应答」，
    // 不改变证据结论（吞掉并保持等待定时器语义；不作为拒绝或告警，避免探测路径自身噪音）。
    socket.on('error', () => {});
    const answered = new Promise((resolve) => {
      socket.on('message', (buffer) => {
        const datagram = parseDatagram(buffer);
        if (datagram !== null && validateProbeAck(datagram).ok) {
          resolve(true);
        }
      });
    });
    const probe = Buffer.from(JSON.stringify({
      v: PROTOCOL_VERSION,
      type: 'probe',
      instanceId: randomUUID(),
      identityName: hostname(),
    }));
    socket.send(probe, port, '127.0.0.1', () => {});
    const got = await Promise.race([
      answered,
      new Promise((resolve) => { waitTimer = setTimeout(resolve, budgetMs); }),
    ]);
    return got === true;
  } finally {
    if (waitTimer !== null) {
      clearTimeout(waitTimer);   // 应答先胜出时定时器仍挂起：清掉，不残留（泄漏的定时器会拖住进程退出）
    }
    closeSocketQuietly(socket);
  }
}

/* TCP 证据：拨号 + 在共享预算内等 pong（发两次——第二次覆盖「已绑定、回程帧处理器尚未接线」的启动瞬间）。
 * 任一合法 pong = 证据；拨号失败/超时 = 无证据（按无应答处理，由调用方与 UDP 证据合成结论）。 */
async function tcpEvidence({ port, budgetMs, warn }) {
  /** @type {import('node:net').Socket | null} */
  let socket = null;
  try {
    socket = await dialTcp({ port, timeoutMs: budgetMs });
    return await waitPongReply(socket, budgetMs);
  } catch (error) {
    warn(`占用者探测的 TCP 证据失败（${error.message}），按无应答处理`);
    return false;
  } finally {
    if (socket !== null) {
      socket.destroy();
    }
  }
}

/* 等 pong：首轮用一半剩余预算，未应答则重发一次、二轮用尽剩余预算（本轮等待上界 = 全预算）；
 * 返回是否收到与本轮 ping 匹配的合法 pong。等待定时器在本函数内清理，不残留（泄漏的定时器会拖住进程退出）。 */
async function waitPongReply(socket, budgetMs) {
  /** @type {ReturnType<typeof setTimeout> | null} */
  let waitTimer = null;
  const deadline = Date.now() + budgetMs;
  try {
    socket.on('error', () => {});
    const replyTo = randomUUID();
    const ping = pingFrame(replyTo);
    const answered = pongWatcher(socket, replyTo);
    const wait = (ms) => new Promise((resolve) => {
      waitTimer = setTimeout(resolve, Math.max(1, Math.ceil(ms)));
    });
    socket.write(ping);
    if (await Promise.race([answered, wait((deadline - Date.now()) / 2)]) === true) {
      return true;
    }
    if (waitTimer !== null) {
      clearTimeout(waitTimer);   // 首轮以「连接关闭」而非计时器结束：清掉挂起的定时器，不残留下半轮
    }
    socket.write(ping);
    return await Promise.race([answered, wait(deadline - Date.now())]) === true;
  } finally {
    if (waitTimer !== null) {
      clearTimeout(waitTimer);
    }
  }
}

/* 逐行消费到达数据，命中与本轮 ping 匹配的合法 pong 即 resolve(true)；连接关闭 resolve(false)。 */
function pongWatcher(socket, replyTo) {
  let received = '';
  return new Promise((resolve) => {
    socket.on('data', (chunk) => {
      received += chunk.toString('utf8');
      let index = received.indexOf('\n');
      while (index !== -1) {
        const line = received.slice(0, index);
        received = received.slice(index + 1);
        if (isPongFor(line, replyTo)) {
          resolve(true);
          return;
        }
        index = received.indexOf('\n');
      }
    });
    socket.on('close', () => resolve(false));
  });
}

/* 探测用 ping 帧（身份为一次性随机标识 + 主机名；必须过对端协议校验，故字段齐全）。 */
function pingFrame(replyTo) {
  return JSON.stringify({
    v: PROTOCOL_VERSION,
    type: 'ping',
    msgId: replyTo,
    from: { instanceId: randomUUID(), identityName: hostname() },
    ts: new Date().toISOString(),
  }) + '\n';
}

function dialTcp({ port, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const onError = (error) => {
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`拨号超时（${timeoutMs}ms）`));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.removeListener('error', onError);
      resolve(socket);
    });
    socket.once('error', onError);
  });
}

function isPongFor(line, replyTo) {
  try {
    const frame = JSON.parse(line);
    return frame !== null && typeof frame === 'object' && frame.type === 'pong' && frame.replyTo === replyTo;
  } catch {
    return false;
  }
}

function parseDatagram(buffer) {
  /** @type {unknown} */
  let parsed = null;
  try {
    parsed = JSON.parse(buffer.toString('utf8'));
  } catch {
    // 解析失败与「解析结果非对象」共用下方出口：都归 null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return /** @type {Record<string, unknown>} */ (parsed);
}

// 站点解析在日志系统就绪之前运行——stderr 是任何时刻都合法的告警通道（与 config.js 同惯例）
function defaultWarn(message) {
  console.error(`waystation: ${message}`);
}
