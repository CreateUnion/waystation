import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolveDataDir } from '../paths.js';
import { createMcpServer } from '../server.js';
import { TOOL_SPECS } from '../tools/specs.js';
import { HEARTBEAT_ENV, createHeartbeatLoop, heartbeatSettingsOf } from './heartbeat.js';
import { createCoreLink } from './ipc-client.js';
import { createSessionWriter } from './session-writer.js';
import { bridgeMetaOf, createSessionMetaWatcher } from './session-meta.js';

/* 桥组合根（设计 §2.1/§2.2）：stdio MCP 门面＋工具目录/转发＋本会话注入口写入＋核心连接监督。
 * 桥只做两件半事：27 工具的目录（不依赖核心即答）与调用转发、注入写入（复用适配器写面）、
 * 核心不可达时的 ws_status 差错合成（「纯转发件」原则的唯一登记例外）。桥不读不写数据根
 * （只读 run/core.json），不认识协作、不认识网络、不认识数据。 */

// 版本单一来源：包元数据（桥的运行版本；换代判定的权威是安装树目标版本）
const BRIDGE_VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
/* app 安装树根（差错载荷的桥来源静态信息；冷启入口路径由 ipc-client 按模块位置相对解析）。 */
const APP_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));

/* 桥的日志面：不写文件日志（waystation.log 的唯一写者是核心）——warn/error 一律走 stderr，
 * stdout 是 MCP 协议通道（主设计 §16-A 纪律）。 */
export function createStderrLog() {
  const write = (message, meta) => {
    console.error(`waystation-bridge: ${message}`, meta === undefined ? '' : JSON.stringify(meta));
  };
  return { info: write, warn: write, error: write };
}

/* 转发 registry（server.js 消费的同一形态）：list＝规格单一权威的浅拷贝（按只读处理，
 * 桥侧不得变异——共享对象一旦就地改写会同时污染核心侧输出）；call＝经连接件转发。
 * dispatch 是本机纯内存能力：规格列表无条件暴露（桥不依赖核心即答），但调用在核心 welcome
 * 未宣告 dispatch 能力位时由桥直接拒绝——旧核收到未知工具只会回泛化错误，用户无从知道该升级
 * 重开会话。能力判定必须晚于 ensureCore：冷启 / 重连时 welcome 尚为 null，先看它会把
 * 「核心还没起」误诊成「核心版本不支持」，并跳过 ensureCore 的等待契约。 */
export function createForwardingRegistry({ link, version = BRIDGE_VERSION, app = APP_ROOT }) {
  return {
    list: () => TOOL_SPECS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    call: (name, args) => forwardCall(link, name, args ?? {}, { version, app }),
  };
}

async function forwardCall(link, name, args, bridgeInfo) {
  const ensured = await link.ensureCore();
  if (!ensured.ok) {
    return failureResult(name, ensured, bridgeInfo);
  }
  if (isDispatchCallOf(name, args) && link.state?.welcome?.dispatch !== 1) {
    return {
      content: [{ type: 'text', text: '当前核心版本不支持 dispatch——请升级并重开会话' }],
      isError: true,
    };
  }
  const called = await link.call(name, args);
  return called.ok ? called.result : failureResult(name, called, bridgeInfo);
}

/* dispatch 能力面：dispatch_* 工具与「创建 dispatch 模式」同属新核能力——旧核不宣告 dispatch 时
 * 一律由桥直接拒绝（否则 ws_create_collab{mode:'dispatch'} 只会拿到核心的泛化模式错误）。
 * ws_create_collab 仅 dispatch 模式受闸；managed/forum 是旧核既有能力，不得误伤。 */
function isDispatchCallOf(name, args) {
  return name.startsWith('ws_dispatch_') || (name === 'ws_create_collab' && args.mode === 'dispatch');
}

/* 核心不可达的差错载荷（设计 §8 写死）：ws_status 合成 core:{available:false, reason}
 * （reason 取分类文案：等待态即 statusDetail，失败态取 startupError 或桥的分类文案）
 * ＋桥来源静态信息（version/app，标注来源＝桥）；其余字段省略——不填占位、不伪造。 */
function failureResult(name, failure, bridgeInfo) {
  if (name !== 'ws_status') {
    return { content: [{ type: 'text', text: failure.message }], isError: true };
  }
  const payload = {
    core: { available: false, reason: failure.message },
    bridge: { version: bridgeInfo.version, app: bridgeInfo.app },
  };
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true };
}

/* 桥运行时：装配连接件、注入写面与转发 registry（不含 stdio/MCP 传输——单测可直接装配）。
 * 监督接线（崩溃→重生→重注册链）：节奏与防护链注入缝透传连接件（测试/校准用）；重注册经
 * onRegistered 外送一行 stderr 诊断（桥不写文件日志——重生对操作者的可见面就是这行）。 */
export function createBridgeRuntime(options = {}) {
  const env = options.env ?? process.env;
  const log = options.log ?? createStderrLog();
  const dataDir = options.dataDir ?? resolveDataDir(env);
  const writer = options.writer ?? createSessionWriter({ env, log });
  warnIfWriterUnavailable(writer, log);
  const sessionId = sessionIdOf(env);
  const link = options.link ?? createCoreLink(linkOptionsOf({ options, env, log, dataDir, sessionId }));
  const watcher = startSessionMetaWatcher(options, env, sessionId, link);
  const heartbeat = startHeartbeatRuntime({ options, env, log, link });
  link.setPushHandler((push) => {
    void deliverPush(link, writer, push, log);
  });
  link.setRegisteredHandler?.((welcome, meta) => {
    log.info(meta.reborn ? '核心重生后重注册（连接已接续）' : '核心已注册', { corePid: welcome.corePid });
    /* 「注册时上报一次」：hello 快照固定于运行时构造，断连期间的 /rename 不会被 watcher 补发
     * （未注册时 sendRegisterUpdate 丢弃但基线已前移）——注册成功后现读一次最新元数据补上。 */
    link.sendRegisterUpdate?.(bridgeMetaOf({ env, sessionId }));
  });
  return {
    env,
    log,
    dataDir,
    writer,
    link,
    heartbeat,
    registry: createForwardingRegistry({ link }),
    close: async () => {
      heartbeat?.stop();
      watcher?.close();
      await link.close();
    },
  };
}

/* 常驻心跳接线：环境变量 0/false/off/no 关闭；非法间隔告警一次后回落默认。
 * 连接件无 heartbeat 方法（旧桩/嵌入形态）时静默不启——心跳是增量监督，旧路径照常。 */
function startHeartbeatRuntime({ options, env, log, link }) {
  if (options.heartbeat === false || typeof link.heartbeat !== 'function') {
    return null;
  }
  const settings = heartbeatSettingsOf(env, options);
  if (settings.invalidValue !== undefined) {
    log.warn?.('桥心跳间隔配置非法（回落到默认 10s）', { value: settings.invalidValue, env: HEARTBEAT_ENV });
  }
  if (settings.intervalMs <= 0) {
    log.info?.('桥常驻心跳已关闭（WAYSTATION_BRIDGE_HEARTBEAT=0）');
    return null;
  }
  const loop = createHeartbeatLoop({
    link,
    log,
    intervalMs: settings.intervalMs,
    timeoutMs: settings.timeoutMs,
  });
  loop.start();
  return loop;
}

/* 启动力检（既有组合根的「会话投递适配器不可用」告警在此接续）：未检测到会话消息套接字＝
 * 本会话收不到推送，消息停留第二档、可经 ws_check_inbox 拉取——该条件不静默。 */
function warnIfWriterUnavailable(writer, log) {
  if (writer.available?.() === false) {
    log.warn('会话投递适配器不可用（未检测到会话消息套接字）——投递降级为会话主动查');
  }
}

/* 连接件构造参数：启动期会话元数据快照随 hello 上报（后续变化经 register-update）。 */
function linkOptionsOf({ options, env, log, dataDir, sessionId }) {
  return {
    dataDir,
    env,
    log,
    app: BRIDGE_VERSION,
    bridgeId: randomUUID(),
    sessionId,
    ...bridgeMetaOf({ env, sessionId }),
    fastRetryMs: options.fastRetryMs,
    callTimeoutMs: options.callTimeoutMs,
    heartbeatTimeoutMs: options.heartbeatTimeoutMs,
    guardOptions: options.guardOptions,
  };
}

/* 会话元数据 watcher：与核心连接并行运行（未注册期间变化被 sendRegisterUpdate 丢弃，
 * 注册后的变化外送 register-update；初次快照已随 hello 上报）。测试/注入链路可显式关闭。 */
function startSessionMetaWatcher(options, env, sessionId, link) {
  if (options.sessionMetaWatcher === false) {
    return null;
  }
  return createSessionMetaWatcher({
    env,
    sessionId,
    onChange: (meta) => link.sendRegisterUpdate?.(meta),
  });
}

function sessionIdOf(env) {
  const sessionId = env.CLAUDE_CODE_SESSION_ID;
  return typeof sessionId === 'string' && sessionId !== '' ? sessionId : undefined;
}

/* push → 本会话注入口写入 → delivered 回执：分桶映射在注入写面（适配器分桶语义零变），
 * 帧发送归连接件。投递失败不抛出——回执届时缺席，核心按「未注入」处置。 */
async function deliverPush(link, writer, push, log) {
  try {
    const receipt = await writer.deliver(push.text);
    const frame = { type: 'delivered', pushId: push.pushId, ok: receipt.ok };
    if (!receipt.ok) {
      frame.reason = receipt.reason;
    }
    link.sendDelivered(frame);
  } catch (error) {
    log.warn('push 注入写入失败（回执缺席，核心按未注入处置）', { reason: error.message });
  }
}

/* 桥入口（src/index.js 薄壳的承载）：MCP 初始化不阻塞——核心连接是后台流程
 * （server.connect 立即完成；首个工具调用才等待，上限 10s）。会话结束（stdin EOF）＝桥退场：
 * 发 bye、关连接，核心侧按「桥断开」清理并起宽限计时。 */
export async function startBridge(options = {}) {
  const runtime = createBridgeRuntime(options);
  const server = createMcpServer({ version: BRIDGE_VERSION, registry: runtime.registry, context: {} });
  await server.connect(new StdioServerTransport());
  void runtime.link.ensureCore().catch(noop);
  let closing = false;
  const close = async () => {
    if (closing) {
      return;
    }
    closing = true;
    await runtime.close();
  };
  process.stdin.on('end', () => {
    void close();
  });
  process.stdin.on('close', () => {
    void close();
  });
  return { server, runtime, close };
}

function noop() {}
