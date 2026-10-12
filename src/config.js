import { readFileSync, renameSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { writeJsonAtomic } from './storage.js';

export const CONFIG_FILE_NAME = 'config.json';

// 字段校验规则表：键与 buildDefaults 一一对应。类型校验挡住手改配置的笔误；
// 数值范围取「能用」的下限/上限，具体语义上限在消费方（日志/队列）表达
const FIELD_RULES = {
  identityName: { check: (value) => typeof value === 'string' && value.trim() !== '', reason: '需为非空字符串' },
  port: { check: (value) => Number.isInteger(value) && value >= 1 && value <= 65535, reason: '需为 1–65535 的整数' },
  offlineQueue: { check: (value) => typeof value === 'boolean', reason: '需为布尔值' },
  autoDeliver: { check: (value) => typeof value === 'boolean', reason: '需为布尔值' },
  logDir: { check: (value) => typeof value === 'string', reason: '需为字符串' },
  logMaxBytes: { check: (value) => Number.isInteger(value) && value >= 1024, reason: '需为不小于 1024 的整数' },
  logMaxFiles: { check: (value) => Number.isInteger(value) && value >= 1 && value <= 100, reason: '需为 1–100 的整数' },
};

/* 默认配置：设计 §14 参数表（开箱可用、一般不改）。
 * 协作端口 7321 的选择依据：PoC 全矩阵实测端口——UDP 广播/单播、TCP 直连、Linux ufw 放行均在 7321 上验证可达；
 * 且落在 1024–49151 静态区间，避开特权端口与动态端口段。登记与复核挂钩设计 §18（发布前），
 * 实践冷门性说明：唯一公开关联是 IANA 的遗留注册名 swx（Swiss Exchange 旧协议，已无实际部署；UDP 侧未注册）。 */
export function buildDefaults(hostName) {
  return {
    identityName: hostName,
    port: 7321,
    offlineQueue: true,
    autoDeliver: true,
    logDir: '',
    logMaxBytes: 1048576,
    logMaxFiles: 5,
  };
}

/**
 * 读配置。created=true 表示文件不存在或已损坏重建——调用方应把生效值落盘（首跑生成 config.json）。
 * 损坏处理遵循设计 §13 的「不静默覆盖」：原文件改名留副本后再按默认值重建。
 * 未知字段原样保留到生效配置里，saveConfig 写回时不丢（前后版本并存的安全带）。
 */
export function loadConfig(dataDir, options = {}) {
  const warn = options.warn ?? defaultWarn;
  const file = join(dataDir, CONFIG_FILE_NAME);
  const defaults = buildDefaults(hostname());
  const { raw, created } = readRawConfig(file, warn);
  const config = { ...defaults };
  // 用户可手改的文件是外部输入：自有键判定一律 Object.hasOwn——防 toString/constructor/__proto__
  // 等原型成员名穿透（`key in defaults` 会命中 Object.prototype 上的内置成员）；
  // unknown 用 null 原型对象：防 `unknown['__proto__'] = ...` 经原型 setter 改写而非落成数据键
  const unknown = Object.create(null);
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(defaults, key)) {
      unknown[key] = value;
      continue;
    }
    const checked = validateField(key, value);
    if (checked.ok) {
      config[key] = checked.value;
    } else {
      warn(`配置项 ${key} 无效（${checked.reason}），改用默认值 ${JSON.stringify(defaults[key])}`);
    }
  }
  return { config: { ...config, ...unknown }, created };
}

/** 原子整体替换写回（设计 §15 写入路径二：临时文件 + 重命名）；失败向上抛，由调用方兜底 */
export function saveConfig(dataDir, config) {
  writeJsonAtomic(join(dataDir, CONFIG_FILE_NAME), config);
}

function validateField(key, value) {
  const rule = Object.hasOwn(FIELD_RULES, key) ? FIELD_RULES[key] : undefined;
  if (rule === undefined) {
    return { ok: false, reason: '未知配置项' };
  }
  if (!rule.check(value)) {
    return { ok: false, reason: rule.reason };
  }
  return { ok: true, value };
}

function readRawConfig(file, warn) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('配置文件根节点须为 JSON 对象');
    }
    return { raw: parsed, created: false };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { raw: {}, created: true };
    }
    const backup = `${file}.corrupt-${Date.now()}`;
    try {
      renameSync(file, backup);
      warn(`配置文件损坏，已保留副本 ${backup}（${error.message}），按默认值重建`);
    } catch (renameError) {
      warn(`配置文件损坏且保留副本失败（${renameError.message}），按默认值重建`);
    }
    return { raw: {}, created: true };
  }
}

// 配置在日志系统就绪之前读取——stderr 是任何时刻都合法的告警通道
function defaultWarn(message) {
  console.error(`waystation: ${message}`);
}
