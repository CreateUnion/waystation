/* 桥常驻心跳监督（问题 7 的增量面）：默认每 10s 触发一次 link.heartbeat——
 * 已注册态发 ping 等应答（超时强制重连），未注册态走既有 ensureCore（四态判定/重生流复用）。
 * 心跳不是唯一恢复路径：关闭（WAYSTATION_BRIDGE_HEARTBEAT=0）、连接件无 heartbeat 方法或
 * 心跳内部异常时，都会继续依赖原有断连收口与重试计时器。
 * 循环串行：上一拍完成才排下一拍，不叠加；定时器 unref，不阻进程退出。 */

export const HEARTBEAT_ENV = 'WAYSTATION_BRIDGE_HEARTBEAT';
export const DEFAULT_HEARTBEAT_MS = 10000;
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30000;
export const HEARTBEAT_MIN_MS = 10;
export const HEARTBEAT_MAX_MS = 3600000;
const DISABLED_VALUES = ['0', 'false', 'off', 'no'];

/**
 * 心跳参数解析：构造选项 > 环境变量 > 默认。
 * 环境变量 0/false/off/no＝关闭；正整数毫秒＝间隔（10–3600000）；空＝默认；
 * 其余非法值回落默认并回带 invalidValue 供调用方告警一次（不静默吞掉配置错误）。
 * @param {Record<string, string | undefined>} env
 * @param {{ heartbeatMs?: number, heartbeatTimeoutMs?: number }} [options]
 * @returns {{ intervalMs: number, timeoutMs: number, invalidValue?: string }}
 */
export function heartbeatSettingsOf(env, options = {}) {
  const interval = intervalOf(env, options.heartbeatMs);
  const timeoutMs = positiveInt(options.heartbeatTimeoutMs) ?? positiveIntText(env?.WAYSTATION_BRIDGE_HEARTBEAT_TIMEOUT_MS) ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
  return interval.invalidValue === undefined
    ? { intervalMs: interval.intervalMs, timeoutMs }
    : { intervalMs: interval.intervalMs, timeoutMs, invalidValue: interval.invalidValue };
}

function intervalOf(env, injected) {
  if (Number.isInteger(injected) && injected >= 0) {
    return { intervalMs: injected };
  }
  const raw = typeof env?.[HEARTBEAT_ENV] === 'string' ? env[HEARTBEAT_ENV].trim().toLowerCase() : '';
  if (raw === '') {
    return { intervalMs: DEFAULT_HEARTBEAT_MS };
  }
  if (DISABLED_VALUES.includes(raw)) {
    return { intervalMs: 0 };
  }
  if (/^\d+$/.test(raw)) {
    const value = Number(raw);
    if (value >= HEARTBEAT_MIN_MS && value <= HEARTBEAT_MAX_MS) {
      return { intervalMs: value };
    }
  }
  return { intervalMs: DEFAULT_HEARTBEAT_MS, invalidValue: raw };
}

function positiveInt(value) {
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/* 环境变量形态：十进制正整数文本（与 interval 的解析口径一致）。 */
function positiveIntText(value) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const text = value.trim();
  return /^\d+$/.test(text) ? positiveInt(Number(text)) : undefined;
}

/**
 * 心跳循环：start 后按 intervalMs 周期执行 tick；tick 串行且异常隔离。
 * tick 公开供测试直接驱动（不依赖真实计时器）。
 * @param {{ link: any, log?: any, intervalMs?: number, timeoutMs?: number, onTick?: ((outcome: any) => void) | null }} options
 * @returns {{ start: () => void, stop: () => void, tick: () => Promise<void> }}
 */
export function createHeartbeatLoop({ link, log = null, intervalMs = DEFAULT_HEARTBEAT_MS, timeoutMs = DEFAULT_HEARTBEAT_TIMEOUT_MS, onTick = null }) {
  const state = {
    /** @type {ReturnType<typeof setTimeout> | null} */
    timer: null,
    stopped: false,
    running: false,
  };
  const schedule = () => {
    if (state.stopped || state.timer !== null || intervalMs <= 0) {
      return;
    }
    state.timer = setTimeout(() => {
      state.timer = null;
      void tick();
    }, intervalMs);
    state.timer.unref?.();
  };
  const tick = async () => {
    if (state.stopped || state.running) {
      return;
    }
    state.running = true;
    try {
      await runHeartbeat({ link, log, timeoutMs, onTick });
    } finally {
      state.running = false;
      schedule();
    }
  };
  return {
    start: () => schedule(),
    stop: () => {
      state.stopped = true;
      if (state.timer !== null) {
        clearTimeout(state.timer);
        state.timer = null;
      }
    },
    tick,
  };
}

/* 单拍：连接件缺失 heartbeat 时静默空转（旧/桩连接件兼容）；异常只告警，不击穿进程。 */
async function runHeartbeat({ link, log, timeoutMs, onTick }) {
  if (typeof link?.heartbeat !== 'function') {
    return;
  }
  let outcome;
  try {
    outcome = await link.heartbeat({ timeoutMs });
  } catch (error) {
    log?.warn?.('心跳监督异常（已隔离，不阻断既有重生流）', { reason: error?.message });
    return;
  }
  onTick?.(outcome);
  reportHeartbeatOutcome(log, outcome);
}

/* 结果呈现：replacing/closed 属预期态不告警；其余失败按 kind/message 留痕。 */
function reportHeartbeatOutcome(log, outcome) {
  if (isHeartbeatSuccess(outcome)) {
    reportHeartbeatSuccess(log, outcome);
    return;
  }
  if (!isExpectedHeartbeatGap(outcome)) {
    logHeartbeatGap(log, outcome);
  }
}

function isHeartbeatSuccess(outcome) {
  return outcome?.ok === true;
}

function isExpectedHeartbeatGap(outcome) {
  return outcome?.kind === 'replacing' || outcome?.kind === 'closed';
}

function reportHeartbeatSuccess(log, outcome) {
  if (outcome.reconnected === true) {
    log?.info?.('心跳监督：重连成功（会话已重新注册）');
  }
}

function logHeartbeatGap(log, outcome) {
  log?.warn?.('心跳监督未恢复连接', { kind: outcome?.kind ?? null, message: outcome?.message ?? null });
}
