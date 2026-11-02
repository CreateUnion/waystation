/* 调度持久化 / 保留期的配置常量与读取面（单一权威源，供 config.js、collab/dispatch.js、
 * retention.js 共用——避免默认值三处漂移）。
 * 配置是外部输入：消费方（尤其单测/旧配置文件）可能缺整段或给错类型，读取函数一律按
 * 「缺失/非法 → 内置默认」失败安全，校验告警由 config.js 的加载面负责。 */

export const DEFAULT_RESOURCE_GUARD_CONFIG = Object.freeze({
  enabled: true,
  min_free_mem_mb: 2048,
  max_slaves: 8,
});

/* 问题 2-A：dispatch 消息长度上限（字符数）——progress / result / 其他类型 text。
 * 超限拒绝（不截断），提示把长内容写文件、消息只发摘要 + 路径。 */
export const DEFAULT_MESSAGE_LIMITS_CONFIG = Object.freeze({
  progress: 800,
  result: 3000,
  text: 4000,
});

export const DEFAULT_TASK_STALE_MS = 1800000;          // 问题 6-A：默认 30 分钟
export const DEFAULT_REQUIRE_ACK_DEFAULT = false;      // 问题 6-B：默认仍不强制回执

export const DEFAULT_DISPATCH_CONFIG = Object.freeze({
  persist: true,
  state_path: '',
  master_timeout_ms: 180000,
  resource_guard: DEFAULT_RESOURCE_GUARD_CONFIG,
  message_limits: DEFAULT_MESSAGE_LIMITS_CONFIG,
  task_stale_ms: DEFAULT_TASK_STALE_MS,
  require_ack_default: DEFAULT_REQUIRE_ACK_DEFAULT,
});

export const DEFAULT_RETENTION_CONFIG = Object.freeze({
  dispatch_hours: 24,
  collabs_days: 30,
  logs_days: 14,
  cleanup_interval_h: 6,
  dry_run: false,
});

export const MASTER_TIMEOUT_MIN_MS = 10000;
export const MASTER_TIMEOUT_MAX_MS = 3600000;
export const RESOURCE_GUARD_MEM_MB_MIN = 256;
export const RESOURCE_GUARD_MEM_MB_MAX = 65536;
export const RESOURCE_GUARD_SLAVES_MIN = 1;
export const RESOURCE_GUARD_SLAVES_MAX = 64;
export const MESSAGE_LIMIT_MIN_CHARS = 64;
export const MESSAGE_LIMIT_MAX_CHARS = 20000;
export const TASK_STALE_MIN_MS = 60000;                // 60 秒
export const TASK_STALE_MAX_MS = 86400000;             // 24 小时
export const DISPATCH_HOURS_MAX = 8760;          // 1 年
export const COLLABS_DAYS_MAX = 3650;            // 10 年
export const LOGS_DAYS_MAX = 3650;
export const CLEANUP_INTERVAL_MAX_H = 168;       // 1 周

const PATH_SEGMENT_SEPARATORS = /[\\/]+/;

/** state_path 形态：字符串、无空字节、任一「..」路径段都拒绝（相对与绝对路径都适用）；
 * 空串＝用默认位置。路径解析（相对数据根 / 绝对路径原样）在 dispatch-store.js。 */
export function isValidDispatchStatePath(value) {
  if (typeof value !== 'string' || value.includes('\0')) {
    return false;
  }
  if (value.trim() === '') {
    return true;
  }
  return !value.split(PATH_SEGMENT_SEPARATORS).includes('..');
}

/** 是否启用调度状态持久化：只有显式 false 关闭；缺省（旧配置 / 单测夹具）保持任务书默认开启。 */
export function persistEnabledOf(config) {
  return config?.dispatch?.persist !== false;
}

/** 调度长心跳超时（毫秒）：缺失/非法回退 180000。 */
export function masterTimeoutMsOf(config) {
  const value = config?.dispatch?.master_timeout_ms;
  return Number.isInteger(value) && value >= MASTER_TIMEOUT_MIN_MS && value <= MASTER_TIMEOUT_MAX_MS
    ? value
    : DEFAULT_DISPATCH_CONFIG.master_timeout_ms;
}

/** 配置的 state_path（空串＝默认位置；非法值回退空串——调用方据此走默认位置而不是抛错）。 */
export function dispatchStatePathOf(config) {
  const value = config?.dispatch?.state_path;
  return isValidDispatchStatePath(value) ? value.trim() : '';
}

function integerInRange(value, min, max, fallback) {
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

/** 生效的资源提醒配置：缺失/非法逐项回落默认值（消费方为空配置 / 旧配置文件时安全）。 */
export function resourceGuardConfigOf(config) {
  const raw = config?.dispatch?.resource_guard;
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_RESOURCE_GUARD_CONFIG.enabled,
    min_free_mem_mb: integerInRange(
      source.min_free_mem_mb,
      RESOURCE_GUARD_MEM_MB_MIN,
      RESOURCE_GUARD_MEM_MB_MAX,
      DEFAULT_RESOURCE_GUARD_CONFIG.min_free_mem_mb,
    ),
    max_slaves: integerInRange(
      source.max_slaves,
      RESOURCE_GUARD_SLAVES_MIN,
      RESOURCE_GUARD_SLAVES_MAX,
      DEFAULT_RESOURCE_GUARD_CONFIG.max_slaves,
    ),
  };
}

/** 生效的 dispatch 消息长度上限：逐项校验（64–20000），缺失/非法回退默认值。 */
export function messageLimitsOf(config) {
  const raw = config?.dispatch?.message_limits;
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    progress: integerInRange(
      source.progress, MESSAGE_LIMIT_MIN_CHARS, MESSAGE_LIMIT_MAX_CHARS, DEFAULT_MESSAGE_LIMITS_CONFIG.progress,
    ),
    result: integerInRange(
      source.result, MESSAGE_LIMIT_MIN_CHARS, MESSAGE_LIMIT_MAX_CHARS, DEFAULT_MESSAGE_LIMITS_CONFIG.result,
    ),
    text: integerInRange(
      source.text, MESSAGE_LIMIT_MIN_CHARS, MESSAGE_LIMIT_MAX_CHARS, DEFAULT_MESSAGE_LIMITS_CONFIG.text,
    ),
  };
}

/** 任务超时提醒阈值（毫秒）：缺失/非法回退 30 分钟。 */
export function taskStaleMsOf(config) {
  const value = config?.dispatch?.task_stale_ms;
  return integerInRange(value, TASK_STALE_MIN_MS, TASK_STALE_MAX_MS, DEFAULT_TASK_STALE_MS);
}

/** 调度长 task 的 requireAck 缺省值：只有显式 true 生效（缺省 / 非法一律 false，保持兼容）。 */
export function requireAckDefaultOf(config) {
  return config?.dispatch?.require_ack_default === true;
}

/** 生效的保留期配置：逐项校验，缺失/非法回退默认值。 */
export function retentionConfigOf(config) {
  const raw = config?.retention;
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    dispatch_hours: integerInRange(source.dispatch_hours, 0, DISPATCH_HOURS_MAX, DEFAULT_RETENTION_CONFIG.dispatch_hours),
    collabs_days: integerInRange(source.collabs_days, 0, COLLABS_DAYS_MAX, DEFAULT_RETENTION_CONFIG.collabs_days),
    logs_days: integerInRange(source.logs_days, 0, LOGS_DAYS_MAX, DEFAULT_RETENTION_CONFIG.logs_days),
    cleanup_interval_h: integerInRange(source.cleanup_interval_h, 1, CLEANUP_INTERVAL_MAX_H, DEFAULT_RETENTION_CONFIG.cleanup_interval_h),
    dry_run: typeof source.dry_run === 'boolean' ? source.dry_run : DEFAULT_RETENTION_CONFIG.dry_run,
  };
}
