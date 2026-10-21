import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ID_PATTERN } from './net/protocol.js';

export const DATA_DIR_ENV = 'WAYSTATION_HOME';
export const LOGS_DIR_NAME = 'logs';
export const COLLABS_DIR_NAME = 'collabs';
export const SITES_DIR_NAME = 'sites';
/* 配置文件名归路径层：站点解析（site.js）在载入 config 前需要按「目录 → 原样读取 port」直接定位文件，
 * 而 config.js 依赖 site.js 的锚点常量——文件名常量若留在 config 会形成循环依赖，故归位于路径层（各文件/目录名常量所在）。 */
export const CONFIG_FILE_NAME = 'config.json';

/* 数据目录：配置文件就住在数据目录里，所以目录位置只能由环境变量先定，不能在配置里配。
 * WAYSTATION_HOME 优先（设计 §14：数据目录可单独改），默认 ~/.waystation；
 * 相对值按进程 CWD 解析——此处没有更早的锚点，配置方应给绝对路径 */
export function resolveDataDir(env) {
  const configured = env[DATA_DIR_ENV];
  if (typeof configured === 'string' && configured.trim() !== '') {
    return resolve(configured.trim());
  }
  return join(homedir(), '.waystation');
}

/** 日志目录：配置项优先，默认 <dataDir>/logs（设计 §14：日志目录可单独改）。
 * 相对配置值以 dataDir 为锚点——不能按进程 CWD 解析：MCP 子进程的 CWD 是会话工作目录（不稳定） */
export function resolveLogDir(dataDir, configuredLogDir) {
  if (typeof configuredLogDir === 'string' && configuredLogDir.trim() !== '') {
    return resolve(dataDir, configuredLogDir.trim());
  }
  return join(dataDir, LOGS_DIR_NAME);
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

/** 每协作目录（设计 §15：每协作一个目录，存台账 / 快照 / 待投队列 / 本地流水）。
 * collabId 来自入站数据、会成为目录名——形态校验与协议层同一权威（禁点与斜杠，排除路径穿越），
 * 这是安全硬边界：校验不过一律抛错，不做任何清洗或拼接。 */
export function collabDir(dataDir, collabId) {
  if (typeof collabId !== 'string' || !ID_PATTERN.test(collabId)) {
    throw new TypeError(`collabId 非法，不得用于路径拼接：${String(collabId).slice(0, 32)}`);
  }
  return join(dataDir, COLLABS_DIR_NAME, collabId);
}

/* 协作目录内文件名的段形态：字符类排除分隔符、冒号与控制字符，首/尾点另行排除——
 * 首点堵 '.' 与 '..'，尾点堵 Windows 会折叠尾点的归一化形态（同一判据跨平台生效，不依赖 path 的平台行为）。
 * 与 collabId 的守卫同一思路：非法段一律抛错，不做清洗。 */
const COLLAB_FILE_NAME_PATTERN = /^[0-9a-zA-Z.-]+$/;

/** 协作目录内的具名文件。fileName 只接受单段文件名（允许点分扩展名，如下游的 outbox.jsonl）——
 * 与 collabId 同一硬边界：段形态不符一律抛错，不做清洗或拼接。 */
export function collabFilePath(dataDir, collabId, fileName) {
  if (
    typeof fileName !== 'string' ||
    !COLLAB_FILE_NAME_PATTERN.test(fileName) ||
    fileName.startsWith('.') ||
    fileName.endsWith('.')
  ) {
    throw new TypeError(`fileName 非法，不得用于路径拼接：${String(fileName).slice(0, 32)}`);
  }
  return join(collabDir(dataDir, collabId), fileName);
}

export const JOINS_FILE_NAME = 'joins.json';

/** 每协作加入台账（设计 §7）：本机待批准名单＋本机获准名单同住一个文件——两侧（站长 / 会话所在机）
 * 同形态、各持本机相关条目，故随协作走。文件名经 collabFilePath 过段形态守卫（与 collabId 同一硬边界）。 */
export function joinsFilePath(dataDir, collabId) {
  return collabFilePath(dataDir, collabId, JOINS_FILE_NAME);
}

/* —— 会话级参与者 0.2.0 本地文件（设计 §6.2）：载体描述、席位、邀请簿记、交接与恢复标记 —— */

export const CARRIER_FILE_NAME = 'carrier.json';
export const SEATS_DIR_NAME = 'seats';
export const INVITES_FILE_NAME = 'invites.json';
export const PENDING_INVITES_FILE_NAME = 'pending-invites.json';
export const HANDOVER_OFFERS_FILE_NAME = 'handover-offers.json';
export const DEPARTED_FILE_NAME = 'departed.jsonl';
export const RECOVERY_FILE_NAME = 'recovery.json';

/** 载体描述（format:'session-seats' / 'invite-stub'）：新协作的第一份落盘文件，先于台账。 */
export function carrierFilePath(dataDir, collabId) {
  return collabFilePath(dataDir, collabId, CARRIER_FILE_NAME);
}

/** 本机会话席位文件：seats/<sessionId>.json——sessionId 成为文件名，与 collabId 同一硬边界（非法即抛）。 */
export function seatFilePath(dataDir, collabId, sessionId) {
  if (typeof sessionId !== 'string' || !ID_PATTERN.test(sessionId)) {
    throw new TypeError(`sessionId 非法，不得用于路径拼接：${String(sessionId).slice(0, 32)}`);
  }
  return join(collabDir(dataDir, collabId), SEATS_DIR_NAME, `${sessionId}.json`);
}

/** 站长机邀请簿记（managed）：inviteId → 目标与接受记录。 */
export function invitesFilePath(dataDir, collabId) {
  return collabFilePath(dataDir, collabId, INVITES_FILE_NAME);
}

/** 目标机挂起邀请：未入席会话的补投依据。 */
export function pendingInvitesFilePath(dataDir, collabId) {
  return collabFilePath(dataDir, collabId, PENDING_INVITES_FILE_NAME);
}

/** 目标机交接记录：offer 台账与确认状态（重启后可继续确认）。 */
export function handoverOffersFilePath(dataDir, collabId) {
  return collabFilePath(dataDir, collabId, HANDOVER_OFFERS_FILE_NAME);
}

/** 本机离席历史：本地派生索引，权威证据在共享台账事件。 */
export function departedFilePath(dataDir, collabId) {
  return collabFilePath(dataDir, collabId, DEPARTED_FILE_NAME);
}

/** 半写新协作目录标记：有 marker 无台账时按只读处理，不重建空台账。 */
export function recoveryFilePath(dataDir, collabId) {
  return collabFilePath(dataDir, collabId, RECOVERY_FILE_NAME);
}

/* 协作目录内的 run/：单协作文档型运行态（与根 run/ 的机器级接线运行态分离）。 */
export const AUTO_OFFER_FILE_NAME = 'auto-offer.json';
export const MANAGER_PENDING_FILE_NAME = 'manager-pending.json';
export const HANDOVER_PENDING_FILE_NAME = 'handover-pending.json';

export function collabRunDir(dataDir, collabId) {
  return join(collabDir(dataDir, collabId), RUN_DIR_NAME);
}

/** 原站长核的 auto-offer 副本（离线成员追赶与重启恢复）。 */
export function autoOfferFilePath(dataDir, collabId) {
  return join(collabRunDir(dataDir, collabId), AUTO_OFFER_FILE_NAME);
}

/** 原站长核在「已收到 accept、未收到新站长签发」期间的只读冻结标记。 */
export function managerPendingFilePath(dataDir, collabId) {
  return join(collabRunDir(dataDir, collabId), MANAGER_PENDING_FILE_NAME);
}

/** 旧站长侧的显式移交在途记录（重启后恢复停写等待或作废）。 */
export function handoverPendingFilePath(dataDir, collabId) {
  return join(collabRunDir(dataDir, collabId), HANDOVER_PENDING_FILE_NAME);
}

/** 槽位 k≥2 的站点数据目录（设计 §13：槽位 1 = 主数据目录本身，k≥2 = <主数据目录>/sites/<k>/，各自含独立 config.json）。
 * 槽位上限由 site.js 的 SLOT_COUNT 约束（本函数只做路径层底线：≥2 的整数）——
 * 与 collabId 同一硬边界：非法值一律抛错，不做清洗或拼接。 */
export function siteDataDir(mainDataDir, slot) {
  if (!Number.isInteger(slot) || slot < 2) {
    throw new TypeError(`站点槽位非法，不得用于路径拼接：${String(slot).slice(0, 16)}`);
  }
  return join(mainDataDir, SITES_DIR_NAME, String(slot));
}

export const SESSIONS_DIR_NAME = 'sessions';

/** 会话级状态文件（状态栏「协作中」指示的载体）：按会话标识一文件、落在主数据目录的 sessions/ 下——
 * 槽位站点共享主数据目录，会话标识全局唯一，读取端按标识直接命中、无需扫描槽位目录。
 * sessionId 来自会话注入的环境变量、会成为文件名——与 collabId 同一硬边界：形态不符一律抛错，不做清洗。 */
export function sessionFilePath(mainDataDir, sessionId) {
  if (typeof sessionId !== 'string' || !ID_PATTERN.test(sessionId)) {
    throw new TypeError(`sessionId 非法，不得用于路径拼接：${String(sessionId).slice(0, 32)}`);
  }
  return join(mainDataDir, SESSIONS_DIR_NAME, `${sessionId}.json`);
}

/* 运行态目录（设计 §2.3/§6.1）：核心锁＋运行描述符＋凭据（core.json）、IPC 端点与绑定表（bindings.json）、
 * 加入申请台账（join-applications.json）的宿主。与业务数据分离——核心的等待接管态「数据面零写」只豁免 run/ 自身。 */
export const RUN_DIR_NAME = 'run';
export const CORE_JSON_FILE_NAME = 'core.json';
export const BINDINGS_FILE_NAME = 'bindings.json';

export function runDir(root) {
  return join(root, RUN_DIR_NAME);
}

export function coreJsonPath(root) {
  return join(root, RUN_DIR_NAME, CORE_JSON_FILE_NAME);
}

export function bindingsFilePath(root) {
  return join(root, RUN_DIR_NAME, BINDINGS_FILE_NAME);
}

export const JOIN_APPLICATIONS_FILE_NAME = 'join-applications.json';

/** 本机会话的加入申请台账（设计 §7）：用会话身份申请入席后、等站长回执期间的申请记录。
 * 跨协作（条目自带 collabId）且先于本机认识该协作存在（未在席者敲门解析后才得 collabId），
 * 故不落单协作目录，与绑定表同住 run/——两者都描述本机与会话的接线，属运行态而非协作内容。 */
export function joinApplicationsFilePath(root) {
  return join(root, RUN_DIR_NAME, JOIN_APPLICATIONS_FILE_NAME);
}
