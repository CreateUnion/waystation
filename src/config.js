import { readFileSync, renameSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { MAX_IDENTITY_NAME_CHARS, isIdentityName, isPort } from './net/protocol.js';
import { ANCHOR_PORT, SLOT_COUNT, slotDefaultPort } from './site.js';
import { CONFIG_FILE_NAME } from './paths.js';
import { writeJsonAtomic } from './storage.js';

/* 文件名的权威源在 paths.js：站点解析（site.js）在载入配置前要按目录直读 config 的 port，
 * 与 config→site 的依赖方向（锚点常量的引用）共同决定了文件名不能留在本文件（会成环）。
 * 此处重导出只为保持既有导入点（status 工具与测试）不变——不要回迁定义。 */
export { CONFIG_FILE_NAME };

/* 抢接收集窗口的合法上界（具名导出＝单一权威）：核心侧工具执行安全期限按它派生
 * （routing.js 的 CALL_SAFETY_DEADLINE_MS）——上界调整时两处同步由测试看护，不散写数字。 */
export const MAX_TAKEOVER_WINDOW_MS = 600000;

// 字段校验规则表：键与 buildDefaults 一一对应。类型校验挡住手改配置的笔误；
// 数值范围取「能用」的边界（下界贴语义有效值、上界防荒唐值），具体语义上限在消费方表达
const FIELD_RULES = {
  identityName: {
    check: (value) => isIdentityName(value),
    reason: `需为非空字符串、不超过 ${MAX_IDENTITY_NAME_CHARS} 字符、且不含控制 / 不可见格式 / 行段分隔字符`,
  },
  port: { check: (value) => isPort(value), reason: '需为 1–65535 的整数' },
  offlineQueue: { check: (value) => typeof value === 'boolean', reason: '需为布尔值' },
  autoDeliver: { check: (value) => typeof value === 'boolean', reason: '需为布尔值' },
  logDir: { check: (value) => typeof value === 'string', reason: '需为字符串' },
  logMaxBytes: { check: (value) => Number.isInteger(value) && value >= 1024, reason: '需为不小于 1024 的整数' },
  logMaxFiles: { check: (value) => Number.isInteger(value) && value >= 1 && value <= 100, reason: '需为 1–100 的整数' },
  // 网络与消息参数（设计 §5/§10「内部数值参数用内置默认值、支持配置文件修改」的落点）
  scanWindowMs: { check: (value) => Number.isInteger(value) && value >= 100 && value <= 60000, reason: '需为 100–60000 的整数（毫秒）' },
  retryIntervalMs: { check: (value) => Number.isInteger(value) && value >= 100 && value <= 3600000, reason: '需为 100–3600000 的整数（毫秒）' },
  retrySlowIntervalMs: { check: (value) => Number.isInteger(value) && value >= 100 && value <= 86400000, reason: '需为 100–86400000 的整数（毫秒）' },
  retryFastCount: { check: (value) => Number.isInteger(value) && value >= 1 && value <= 100, reason: '需为 1–100 的整数' },
  queueMaxPerCollab: { check: (value) => Number.isInteger(value) && value >= 1 && value <= 100000, reason: '需为 1–100000 的整数' },
  messageTtlMs: { check: (value) => Number.isInteger(value) && value >= 1000 && value <= 2592000000, reason: '需为 1000–2592000000 的整数（毫秒，上限 30 天）' },
  dispatchTickMs: { check: (value) => Number.isInteger(value) && value >= 10 && value <= 60000, reason: '需为 10–60000 的整数（毫秒）' },
  dialTimeoutMs: { check: (value) => Number.isInteger(value) && value >= 100 && value <= 120000, reason: '需为 100–120000 的整数（毫秒）' },
  // 占用者探测总预算（槽位解析与绑定失败分类共用；测试可注入小值——数值语义见 site.js / stack.js 消费方）
  probeTimeoutMs: { check: (value) => Number.isInteger(value) && value >= 100 && value <= 30000, reason: '需为 100–30000 的整数（毫秒）' },
  // 单条邀请的过期标注时限（设计 §6 默认 24 小时；过期仅标注、不改协作状态）
  inviteTtlMs: { check: (value) => Number.isInteger(value) && value >= 1000 && value <= 30 * DAY_MS, reason: '需为 1000–2592000000 的整数（毫秒，上限 30 天）' },
  // 加入申请的过期时限（设计 §8：缺省同邀请时限 24 小时）——站长侧待批准与发起侧等待回执都按
  // 申请时刻的年龄与它比对（两侧时间戳同为毫秒整数，做差即比）；申请不经 outbox 长队列（否则先被
  // messageTtlMs 过期），故本值不参与队列过期判定
  joinRequestTtlMs: { check: (value) => Number.isInteger(value) && value >= 1000 && value <= 30 * DAY_MS, reason: '需为 1000–2592000000 的整数（毫秒，上限 30 天）' },
  // 失联判定与抢接规程参数（设计 §9「默认 30s」「默认 2 分钟」「默认 30s，可配」的落点；
  // 下界取「实用快节律」——测试与极小网络可用，防的是误配打爆探测定时器）
  managerProbeIntervalMs: { check: (value) => Number.isInteger(value) && value >= 100 && value <= 600000, reason: '需为 100–600000 的整数（毫秒）' },
  managerOfflineMs: { check: (value) => Number.isInteger(value) && value >= 200 && value <= 3600000, reason: '需为 200–3600000 的整数（毫秒）' },
  takeoverWindowMs: { check: (value) => Number.isInteger(value) && value >= 200 && value <= MAX_TAKEOVER_WINDOW_MS, reason: `需为 200–${MAX_TAKEOVER_WINDOW_MS} 的整数（毫秒）` },
  // 冻结无裁定的单方处置提示时限（设计 §6 默认 48 小时）
  freezeUnresolvedMs: { check: (value) => Number.isInteger(value) && value >= 60000 && value <= 30 * DAY_MS, reason: '需为 60000–2592000000 的整数（毫秒，上限 30 天）' },
  // 讨论的周期对表节拍（设计 §5.4 anti-entropy 默认 60s 可配）
  forumSyncIntervalMs: { check: (value) => Number.isInteger(value) && value >= 1000 && value <= 3600000, reason: '需为 1000–3600000 的整数（毫秒）' },
};

const DAY_MS = 24 * 60 * 60 * 1000;

/* 默认身份名的派生：槽位 ≥2 取 `<主机名>-<k>`（同机多站点在扫描列表默认可区分），槽位 1 / 省略即主机名本身。
 * 主机名长度没有全局硬上界（单标签上限 63 字符、Linux 主机名字段可达 64），加后缀后可能越过身份名上限——
 * 身份名由协议预检整串判定，越界会让该站点全部出站帧被拒（LAN 整站不可用），故按上限截断主机名部分、
 * 槽位后缀优先保留；截断只缩短长度，不引入控制 / 格式字符（主机名原样截断）。 */
function defaultIdentityName(hostName, slot) {
  const suffix = slot !== null && slot >= 2 ? `-${slot}` : '';
  return hostName.slice(0, MAX_IDENTITY_NAME_CHARS - suffix.length) + suffix;
}

/* 默认配置：设计 §14 参数表（开箱可用、一般不改）。
 * options.slot：站点槽位（1..SLOT_COUNT）——决定默认身份名（槽位 ≥2 取 `<主机名>-<k>`，
 * 同机多站点在扫描列表默认可区分）与默认端口（槽位默认端口 = 锚点 + k - 1）；省略 = 主站点。
 * 协作端口锚点（现 7321）的选择依据：PoC 全矩阵实测端口——UDP 广播/单播、TCP 直连、Linux ufw 放行均在 7321 上
 * 验证可达；且落在 1024–49151 静态区间，避开特权端口与动态端口段。登记与复核挂钩设计 §18（发布前），
 * 实践冷门性说明：唯一公开关联是 IANA 的遗留注册名 swx（Swiss Exchange 旧协议，已无实际部署；UDP 侧未注册）。 */
export function buildDefaults(hostName, options = {}) {
  const slot = options.slot ?? null;
  if (slot !== null && (!Number.isInteger(slot) || slot < 1 || slot > SLOT_COUNT)) {
    throw new TypeError(`槽位非法（应为 1–${SLOT_COUNT} 的整数或省略）：${String(slot)}`);
  }
  return {
    identityName: defaultIdentityName(hostName, slot),
    port: slot === null ? ANCHOR_PORT : slotDefaultPort(slot),
    offlineQueue: true,
    autoDeliver: true,
    logDir: '',
    logMaxBytes: 1048576,
    logMaxFiles: 5,
    // 网络与消息层默认值（设计 §5/§10 明文默认）：
    // 扫描等待窗口 2s；重传恒定 10s、连续 3 次无 ack 后转 60s 低频直至送达/过期；
    // 单协作队列上限 500 条；消息保留期 7 天（队列过期与接收端去重窗口共用——设计 §10「保留期同队列」）；
    // 调度 tick 1s；拨号（含 ping 应答等待）超时 5s；占用者探测总预算 1s。
    scanWindowMs: 2000,
    retryIntervalMs: 10000,
    retrySlowIntervalMs: 60000,
    retryFastCount: 3,
    queueMaxPerCollab: 500,
    messageTtlMs: 7 * DAY_MS,
    dispatchTickMs: 1000,
    dialTimeoutMs: 5000,
    probeTimeoutMs: 1000,
    inviteTtlMs: DAY_MS,
    // 加入申请的过期时限：缺省同邀请的 24 小时（申请不经 outbox 长队列，不参与队列过期）
    joinRequestTtlMs: DAY_MS,
    // 失联判定与抢接规程默认值（设计 §9 明文默认）：
    // 对站长周期探测 30s；连续失败累计 2 分钟判失联；抢接收集窗口 30s（自广播起算）；
    // 冻结无裁定 48 小时提示双方（单方处置时限）。
    managerProbeIntervalMs: 30000,
    managerOfflineMs: 120000,
    takeoverWindowMs: 30000,
    freezeUnresolvedMs: 48 * 60 * 60 * 1000,
    // 讨论的周期对表节拍（设计 §5.4 明文默认 60s）：落后方按此节拍拉增量、对账与重播。
    forumSyncIntervalMs: 60000,
  };
}

/**
 * 读配置。created=true 表示文件不存在或已损坏重建——调用方应把生效值落盘（首跑生成 config.json）。
 * identityDefaulted=true 表示根对象里的 identityName「未设置」（缺失 / null / 空串 / 纯空白）——
 * 按未设置处理：保留默认机器名、不告警；调用方应把生效值落盘并在本会话给一次提示（见 status 工具）。
 * 损坏处理遵循设计 §13 的「不静默覆盖」：原文件改名留副本后再按默认值重建。
 * 未知字段原样保留到生效配置里，saveConfig 写回时不丢（前后版本并存的安全带）。
 * options.defaults：站点感知默认值对象（多站点槽位目录传 buildDefaults(hostname(), { slot })）；
 * 缺省 = buildDefaults(hostname())（主站点语义）。
 */
export function loadConfig(dataDir, options = {}) {
  const warn = options.warn ?? defaultWarn;
  const file = join(dataDir, CONFIG_FILE_NAME);
  const defaults = options.defaults ?? buildDefaults(hostname());
  const { raw, created } = readRawConfig(file, warn);
  const config = { ...defaults };
  const identityDefaulted = isIdentityUnset(raw.identityName);
  // 用户可手改的文件是外部输入：自有键判定一律 Object.hasOwn——防 toString/constructor/__proto__
  // 等原型成员名穿透（`key in defaults` 会命中 Object.prototype 上的内置成员）；
  // unknown 用 null 原型对象：防 `unknown['__proto__'] = ...` 经原型 setter 改写而非落成数据键
  const unknown = Object.create(null);
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(defaults, key)) {
      unknown[key] = value;
      continue;
    }
    if (key === 'identityName' && identityDefaulted) {
      continue;   // 未设置不告警：保留默认机器名，由调用方落盘触发一次提示
    }
    const checked = validateField(key, value);
    if (checked.ok) {
      config[key] = checked.value;
    } else {
      warn(`配置项 ${key} 无效（${checked.reason}），改用默认值 ${JSON.stringify(defaults[key])}`);
    }
  }
  return { config: { ...config, ...unknown }, created, identityDefaulted };
}

/* 身份名「未设置」的口径：字段缺失 / null / 空串 / 纯空白——用户清空字段即回到未设置，
 * 下次启动重新触发一轮「落盘默认值 + 本会话提示一次」，语义自洽。类型错（数字 / 布尔 / 对象）
 * 不属此列：那是有值但不合法，仍走告警回落路径。 */
function isIdentityUnset(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
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
