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
  const collabRule = COLLAB_PAYLOAD_RULES[frame.type];
  if (collabRule !== undefined) {
    return collabRule(frame.payload);
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

/** 端口范围判定（1–65535 整数）：协议入站校验与本地文件读取共用同一判据。
 * @param {*} value
 * @returns {value is number} */
export function isPort(value) {
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

/* —— 协作域载荷形态（协作核心）：本层只判形态（字段完整性 / 类型 / 长度边界 / 数值范围）；
 * 语义裁定（名单含本机、状态是否允许）在协作层。上限值服务呈现链与会话注入链的稳健性。 */
export const MAX_COLLAB_MEMBERS = 32;
export const MAX_TOPIC_CHARS = 200;
export const MAX_MESSAGE_TEXT_CHARS = 4000;
export const MAX_REASON_CHARS = 200;
export const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/* 呈现面短文本：进扫描列表 / 同意门 / 台账 / 会话呈现的字段——空、超长或含不可见字符都会破坏呈现链；
 * 与身份名同一字符类判据（Cc / Cf / Zl / Zp 拒绝）。 */
export function isPresentationText(value, maxChars) {
  return typeof value === 'string'
    && value.trim() !== ''
    && value.length <= maxChars
    && !FORBIDDEN_IDENTITY_CHARS.test(value);
}

/* 正文判据（数据面）：只限类型与非空与长度——换行等可打印内容属于数据，由投递链的外
 * 部数据警示承载；不含呈现面的不可见字符限制。 */
function isMessageText(value) {
  return typeof value === 'string' && value.trim() !== '' && value.length <= MAX_MESSAGE_TEXT_CHARS;
}

/* 协作域类型 → payload 校验函数（表驱动：新增类型只加一行；协作域类型全部挂表防漏，
 * 未挂表的治理类型走「不校验载荷」的宽容路径）。 */
const COLLAB_PAYLOAD_RULES = {
  invite: validateInvitePayload,
  approve: validateOptionalObjectPayload,
  decline: validateReasonPayload,
  withdraw: validateWithdrawPayload,
  topic: validateTopicPayload,
  task: validateTaskPayload,
  progress: validateProgressPayload,
  issue: validateBodyPayload,
  stop: validateReasonPayload,
  reply: validateBodyPayload,
  notice: validateNoticePayload,
  freeze: validateFreezePayload,
  snapshot: validateSnapshotPayload,
  end: validateOptionalObjectPayload,
  leave: validateOptionalObjectPayload,
};

function validateInvitePayload(payload) {
  if (!isPlainObject(payload)) {
    return refuse('invite 缺少 payload');
  }
  if (!isIdentityName(payload.name)) {
    return refuse('invite.name 非法（项目名，同身份名呈现判据）');
  }
  if (!isPresentationText(payload.topic, MAX_TOPIC_CHARS)) {
    return refuse(`invite.topic 非法（≤${MAX_TOPIC_CHARS} 字符的呈现文本）`);
  }
  return validateMemberList(payload.members, 'invite.members');
}

/* 名单形态（invite 与 freeze 共用）：2–上限项、每项 instanceId 合法且唯一；
 * freeze 场景只需实例标识（用于交集匹配），invite 场景额外要求身份名可呈现。 */
function validateMemberList(members, label) {
  if (!Array.isArray(members) || members.length < 2 || members.length > MAX_COLLAB_MEMBERS) {
    return refuse(`${label} 须为 2–${MAX_COLLAB_MEMBERS} 项的名单`);
  }
  const seen = new Set();
  for (const member of members) {
    if (!isPlainObject(member) || !isId(member.instanceId)) {
      return refuse(`${label} 条目非法（需 instanceId）`);
    }
    if (label === 'invite.members' && !isIdentityName(member.identityName)) {
      return refuse('invite.members 条目非法（需 identityName）');
    }
    if (seen.has(member.instanceId)) {
      return refuse(`${label} 名单含重复实例标识`);
    }
    seen.add(member.instanceId);
  }
  return { ok: true };
}

function validateOptionalObjectPayload(payload) {
  if (payload !== undefined && !isPlainObject(payload)) {
    return refuse('payload 须为 JSON 对象');
  }
  return { ok: true };
}

function validateReasonPayload(payload) {
  if (payload === undefined) {
    return { ok: true };
  }
  if (!isPlainObject(payload)) {
    return refuse('payload 须为 JSON 对象');
  }
  if (payload.reason !== undefined && !isPresentationText(payload.reason, MAX_REASON_CHARS)) {
    return refuse(`reason 非法（≤${MAX_REASON_CHARS} 字符的呈现文本）`);
  }
  return { ok: true };
}

function validateWithdrawPayload(payload) {
  if (!isPlainObject(payload)) {
    return refuse('withdraw 缺少 payload');
  }
  if (payload.scope !== 'single' && payload.scope !== 'all') {
    return refuse('withdraw.scope 非法（single / all）');
  }
  return validateReasonPayload(payload);
}

function validateTopicPayload(payload) {
  if (!isPlainObject(payload)) {
    return refuse('topic 缺少 payload');
  }
  if (!isPresentationText(payload.text, MAX_TOPIC_CHARS)) {
    return refuse(`topic.text 非法（≤${MAX_TOPIC_CHARS} 字符的呈现文本）`);
  }
  return { ok: true };
}

function validateBodyPayload(payload) {
  if (!isPlainObject(payload)) {
    return refuse('payload 须为 JSON 对象');
  }
  if (!isMessageText(payload.text)) {
    return refuse(`text 非法（非空、≤${MAX_MESSAGE_TEXT_CHARS} 字符）`);
  }
  return { ok: true };
}

function validateTaskPayload(payload) {
  if (!isPlainObject(payload) || !isId(payload.taskId)) {
    return refuse('task.taskId 非法（1–64 位字母数字与连字符）');
  }
  return validateBodyPayload(payload);
}

function validateProgressPayload(payload) {
  if (!isPlainObject(payload)) {
    return refuse('payload 须为 JSON 对象');
  }
  if (payload.taskId !== undefined && !isId(payload.taskId)) {
    return refuse('progress.taskId 非法（1–64 位字母数字与连字符）');
  }
  return validateBodyPayload(payload);
}

function validateNoticePayload(payload) {
  if (!isPlainObject(payload)) {
    return refuse('notice 缺少 payload');
  }
  if (payload.event !== 'established' && payload.event !== 'roster' && payload.event !== 'snapshot-stored') {
    return refuse('notice.event 非法（本版：established / roster / snapshot-stored）');
  }
  if (payload.version !== undefined && (!Number.isInteger(payload.version) || payload.version < 1)) {
    return refuse('notice.version 非法（≥1 的整数）');
  }
  return { ok: true };
}

function validateFreezePayload(payload) {
  if (!isPlainObject(payload)) {
    return refuse('freeze 缺少 payload');
  }
  if (!isIdentityName(payload.name)) {
    return refuse('freeze.name 非法（项目名）');
  }
  const members = validateMemberList(payload.members, 'freeze.members');
  if (!members.ok) {
    return members;
  }
  return validateReasonPayload(payload);
}

function validateSnapshotPayload(payload) {
  if (!isPlainObject(payload)) {
    return refuse('snapshot 缺少 payload');
  }
  if (payload.kind === 'request') {
    return { ok: true };
  }
  if (payload.kind !== 'data') {
    return refuse('snapshot.kind 非法（request / data）');
  }
  if (!Number.isInteger(payload.version) || payload.version < 1) {
    return refuse('snapshot.version 非法（≥1 的整数）');
  }
  if (typeof payload.digest !== 'string' || !DIGEST_PATTERN.test(payload.digest)) {
    return refuse('snapshot.digest 非法（64 位小写十六进制）');
  }
  if (!isPlainObject(payload.ledger)) {
    return refuse('snapshot.ledger 非法（须为台账对象）');
  }
  return { ok: true };
}

function refuse(reason) {
  return { ok: false, reason };
}
