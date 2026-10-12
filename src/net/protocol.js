import { randomUUID } from 'node:crypto';

/* 协议契约（设计 §10）：帧/报文格式与入站校验的唯一权威。
 * 「帧」= TCP 通道上的一行 JSON（NDJSON）；「报文」= UDP 发现数据报。
 * 一切入站数据在使用前必须过本文件的校验器（字段完整性 / 类型 / 长度边界 / 数值范围），
 * 失败一律拒绝，计数留痕由消费方执行——局域网全信任模型不豁免（设计 §10 入站校验基线）。 */

export const PROTOCOL_VERSION = 1;

/* 体积上限是两端必须一致的协议常量（不是本地可调参数）：
 * 帧上限 1 MiB——快照为 KB 级（设计 §8），留余量并封顶；数据报上限 512 B——探测/应答为百字节级。 */
export const MAX_FRAME_BYTES = 1048576;
export const MAX_DATAGRAM_BYTES = 512;
export const MAX_IDENTITY_NAME_CHARS = 64;
export const MAX_COLLAB_COUNT = 1000000;

/* 标识类字段（instanceId / msgId / collabId / replyTo / refMsgId）共用同一形态：
 * 字母数字与连字符、1–64 字符。禁止点与斜杠是安全边界——collabId 会成为目录名，
 * 形态上排除路径穿越（与 paths.collabDir 的守卫同一权威）。 */
export const ID_PATTERN = /^[0-9a-zA-Z-]{1,64}$/;

/* 消息类型最小集（设计 §10）+ 投递可靠性所必需的确认帧 ack。
 * 类型集是两端契约：未知类型一律拒绝（版本不匹配或伪造）。 */
export const MESSAGE_TYPES = [
  'invite', 'approve', 'decline', 'withdraw',
  'topic', 'task', 'progress', 'issue', 'stop', 'reply',
  'freeze', 'unfreeze', 'decision', 'handover', 'takeover-init', 'takeover', 'notice', 'leave', 'end',
  'ping', 'pong', 'delivery-status',
  'snapshot',
  'ack',
];

/* 治理类通告（设计 §10 路由例外清单 + §9 takeover 豁免明示）：重试直至送达、豁免队列上限与过期。 */
export const GOVERNANCE_TYPES = ['freeze', 'unfreeze', 'decision', 'takeover-init', 'takeover'];

/* 传输类帧不带 collabId（可达性探测与链路确认没有协作归属）；其余类型均属协作域、必须携带。 */
export const TRANSPORT_TYPES = ['ping', 'pong', 'ack'];

export function newMsgId() {
  return randomUUID();
}

/** 消息信封校验（设计 §10）：根节点 → 身份字段 → 其余字段 → 类型专属字段，逐段委派。 */
export function validateMessage(frame) {
  if (!isPlainObject(frame)) {
    return refuse('消息根节点须为 JSON 对象');
  }
  const identity = validateIdentityFields(frame);
  if (identity !== null) {
    return identity;
  }
  const rest = validateRestFields(frame);
  if (rest !== null) {
    return rest;
  }
  return validateTypeSpecific(frame);
}

/* 身份字段：版本、类型集、msgId、from——先确认「是谁发的、什么类型」成立。 */
function validateIdentityFields(frame) {
  if (frame.v !== PROTOCOL_VERSION) {
    return refuse(`协议版本不匹配（期望 ${PROTOCOL_VERSION}）`);
  }
  if (typeof frame.type !== 'string' || !MESSAGE_TYPES.includes(frame.type)) {
    return refuse('未知消息类型');
  }
  if (!isId(frame.msgId)) {
    return refuse('msgId 非法');
  }
  const from = validateFrom(frame.from);
  if (!from.ok) {
    return from;
  }
  return null;
}

/* 其余字段：时间戳、协作归属（传输类豁免）、载荷形态。 */
function validateRestFields(frame) {
  if (!isTimestamp(frame.ts)) {
    return refuse('ts 非法');
  }
  if (!TRANSPORT_TYPES.includes(frame.type) && !isId(frame.collabId)) {
    return refuse('collabId 缺失或非法');
  }
  if (frame.payload !== undefined && !isPlainObject(frame.payload)) {
    return refuse('payload 须为 JSON 对象');
  }
  return null;
}

export function validateProbe(datagram) {
  return validateDiscovery(datagram, 'probe');
}

export function validateProbeAck(datagram) {
  return validateDiscovery(datagram, 'probe-ack');
}

/** 帧解码：JSON 解析 + 信封校验；成功时回带 frame 供调用方使用。 */
export function parseFrame(text) {
  if (typeof text !== 'string') {
    return refuse('帧须为文本');
  }
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 解析失败与「解析结果不是对象」（含字面量 null）共用下方出口：两者都不是合法帧
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return refuse('帧不是合法 JSON 对象');
  }
  const checked = validateMessage(parsed);
  if (!checked.ok) {
    return checked;
  }
  return { ok: true, frame: parsed };
}

/* 类型专属字段（本版只定义传输类）：pong 的 replyTo、ack 的 ackFor、delivery-status 的载荷结构。
 * 协作域载荷结构（task / progress / …）归后续里程碑定义——本层只做形态校验，不测量体积；
 * 体积上限（MAX_FRAME_BYTES / MAX_DATAGRAM_BYTES）由消费方按 Buffer 字节数测量并执行。 */
function validateTypeSpecific(frame) {
  if (frame.type === 'pong' && !isId(frame.replyTo)) {
    return refuse('pong 缺少合法的 replyTo');
  }
  if (frame.type === 'ack' && !isId(frame.ackFor)) {
    return refuse('ack 缺少合法的 ackFor');
  }
  if (frame.type === 'delivery-status') {
    if (!isPlainObject(frame.payload) || !isId(frame.payload.refMsgId)) {
      return refuse('delivery-status 缺少合法的 payload.refMsgId');
    }
    if (frame.payload.tier !== 'session') {
      return refuse('delivery-status 的 tier 非法（本版仅定义 session）');
    }
  }
  return { ok: true };
}

function validateFrom(from) {
  if (!isPlainObject(from) || !isId(from.instanceId)) {
    return refuse('from.instanceId 非法');
  }
  if (!isIdentityName(from.identityName)) {
    return refuse('from.identityName 非法');
  }
  /* from.port：构造侧必填；入站侧缺失不拒收——消息投递不因寻址信息缺失而废（回拨尽力而为）；
   * 存在则必须合法（1–65535 整数）：非法值不得流入回拨寻址。 */
  if (from.port !== undefined && !isPort(from.port)) {
    return refuse('from.port 非法（1–65535 的整数）');
  }
  return { ok: true };
}

function validateDiscovery(datagram, expectedType) {
  if (!isPlainObject(datagram)) {
    return refuse('发现报文根节点须为对象');
  }
  if (datagram.v !== PROTOCOL_VERSION) {
    return refuse(`协议版本不匹配（期望 ${PROTOCOL_VERSION}）`);
  }
  if (datagram.type !== expectedType) {
    return refuse(`发现报文类型非法（期望 ${expectedType}）`);
  }
  if (!isId(datagram.instanceId)) {
    return refuse('发现报文 instanceId 非法');
  }
  if (!isIdentityName(datagram.identityName)) {
    return refuse('发现报文 identityName 非法');
  }
  if (expectedType === 'probe-ack') {
    if (!isCollabCount(datagram.collabCount)) {
      return refuse('扫描应答 collabCount 非法');
    }
    /* port：宽容缺省（已定案）——缺 port 回退数据报来源端口；字段存在则校验 1–65535 且以字段为准。 */
    if (datagram.port !== undefined && !isPort(datagram.port)) {
      return refuse('扫描应答 port 非法（1–65535 的整数）');
    }
  }
  return { ok: true };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function isPort(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

/* 身份名白名单（2026-10-12 用户裁定，语义事实）：拒绝控制字符（Cc，含换行 / Tab / ESC）、
 * 不可见格式字符（Cf，含双向控制符、零宽、ZWJ）、行 / 段分隔符（Zl / Zp）——这些字符会破坏
 * 扫描列表、日志与工具输出的呈现。其余放开：单码位可见符号与 emoji 均可；
 * ZWJ 组合序列（U+200D∈Cf，如 👨‍👩‍👧）按 Cf 拒绝。
 * 协议入站校验与本地配置写入共用本函数（同一规则，单一权威）。 */
const FORBIDDEN_IDENTITY_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export function isIdentityName(value) {
  return typeof value === 'string'
    && value.trim() !== ''
    && value.length <= MAX_IDENTITY_NAME_CHARS
    && !FORBIDDEN_IDENTITY_CHARS.test(value);
}

function isTimestamp(value) {
  return typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value));
}

function isCollabCount(value) {
  return Number.isInteger(value) && value >= 0 && value <= MAX_COLLAB_COUNT;
}

function refuse(reason) {
  return { ok: false, reason };
}
