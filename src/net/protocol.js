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

/* 类型专属字段：pong 的 replyTo、ack 的 ackFor、delivery-status 的载荷结构、
 * 协作域（建协类 / 协作类 / 治理类）的载荷形态。
 * 本层只做形态校验（字段完整性 / 类型 / 长度边界 / 数值范围），不测量体积；
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

/* —— 协作域载荷形态（协作核心 + 治理与韧性）：本层只判形态（字段完整性 / 类型 / 长度边界 / 数值范围）；
 * 语义裁定（名单含本机、状态是否允许、来源是否现任驿丞）在协作层。上限值服务呈现链与会话注入链的稳健性。 */
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

/* 协作域类型 → payload 校验函数（表驱动：新增类型只加一行）。
 * 协作域类型全部挂表防漏（含治理类五型——「形态宽松」的过渡口径随本表收口）。 */
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
  unfreeze: validateUnfreezePayload,
  decision: validateDecisionPayload,
  handover: validateHandoverPayload,
  'takeover-init': validateTakeoverInitPayload,
  takeover: validateTakeoverPayload,
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

/* 名单形态（invite / freeze / unfreeze / decision 共用）：2–上限项、每项 instanceId 合法且唯一；
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

/* notice 事件集（建协 / 协作 + 治理与韧性扩展）：事件枚举 + 各事件字段形态。
 * 事件名查表一律 Object.hasOwn：事件名是外来字符串，直接取值会命中 Object.prototype 上的
 * 内置成员——constructor / toString 会调错函数返回非结果形态，__proto__ 更会因不可调用
 * 抛出异常穿出校验层（调用链上无捕获点，恶意帧即进程级故障）。 */
function validateNoticePayload(payload) {
  if (!isPlainObject(payload)) {
    return refuse('notice 缺少 payload');
  }
  if (typeof payload.event !== 'string' || !Object.hasOwn(NOTICE_EVENT_RULES, payload.event)) {
    return refuse('notice.event 非法（本版：established / roster / snapshot-stored / manager-changed / handshake / merge-request / merge-outcome）');
  }
  return NOTICE_EVENT_RULES[payload.event](payload);
}

const NOTICE_EVENT_RULES = {
  established: validateVersionedNotice,
  roster: validateVersionedNotice,
  'snapshot-stored': validateVersionedNotice,
  'manager-changed': validateManagerChangedNotice,
  handshake: validateHandshakeNotice,
  'merge-request': validateMergeRequestNotice,
  'merge-outcome': validateMergeOutcomeNotice,
};

/* established / roster / snapshot-stored：version 可选且 ≥1（既有三事件形态不变）。 */
function validateVersionedNotice(payload) {
  if (payload.version !== undefined && (!Number.isInteger(payload.version) || payload.version < 1)) {
    return refuse('notice.version 非法（≥1 的整数）');
  }
  return { ok: true };
}

/* 驿丞已变更（移交完成后旧席位广播）：新驿丞身份与交接版本均必填；endpoint（新驿丞端点）
 * 为可选加法字段——随通告下发以解除「只与旧驿丞通信过的成员」与新驿丞的端点互盲。 */
function validateManagerChangedNotice(payload) {
  if (!Number.isInteger(payload.version) || payload.version < 1) {
    return refuse('manager-changed.version 非法（≥1 的整数）');
  }
  if (!isPeerShape(payload.manager)) {
    return refuse('manager-changed.manager 非法（需 instanceId + identityName）');
  }
  return optionalEndpointRejection(payload.endpoint, 'manager-changed.endpoint');
}

/* 可选端点字段（治理载荷的加法扩展；旧帧无此字段行为不变）：结构底线在此（原样拒收超限
 * 或形态不符），地址的 IP 字面量语义由协作层在采用前复核（协议层不引 node:net）。 */
function optionalEndpointRejection(endpoint, label) {
  if (endpoint === undefined) {
    return { ok: true };
  }
  return endpointEntryRejection(endpoint, label);
}

function endpointEntryRejection(endpoint, label) {
  if (!isPlainObject(endpoint) || typeof endpoint.address !== 'string' || endpoint.address === '' || endpoint.address.length > 64) {
    return refuse(`${label} 非法（需 address 字符串，≤64 字符）`);
  }
  if (!isPort(endpoint.port)) {
    return refuse(`${label}.port 非法（1–65535 的整数）`);
  }
  return { ok: true };
}

/* 握手对表（启动 / 网络恢复 / 治理通告后的收敛机制）：角色、版本、在途或生效抢接视图、回帧标记。 */
function validateHandshakeNotice(payload) {
  if (payload.role !== 'manager' && payload.role !== 'member') {
    return refuse('handshake.role 非法（manager / member）');
  }
  if (payload.version !== null && (!Number.isInteger(payload.version) || payload.version < 1)) {
    return refuse('handshake.version 非法（null 或 ≥1 的整数）');
  }
  if (payload.takeover !== null && !isTakeoverRecord(payload.takeover)) {
    return refuse('handshake.takeover 非法（null 或抢接记录）');
  }
  if (payload.reply !== true && payload.reply !== false) {
    return refuse('handshake.reply 非法（布尔）');
  }
  return { ok: true };
}

/* 抢接记录（handshake 与 takeover-init report 共用）：在途或生效相位 + 候选身份 + 基准版本。 */
function isTakeoverRecord(value) {
  if (!isPlainObject(value)) {
    return false;
  }
  if (value.phase !== 'inflight' && value.phase !== 'effective') {
    return false;
  }
  if (!isPeerShape(value.candidate)) {
    return false;
  }
  return Number.isInteger(value.baseVersion) && value.baseVersion >= 1;
}

/* 合流递交（本地版本高于现任基准者提交超出部分）：基准版本、递交版本、摘要与整份台账。 */
function validateMergeRequestNotice(payload) {
  if (!Number.isInteger(payload.baseVersion) || payload.baseVersion < 1) {
    return refuse('merge-request.baseVersion 非法（≥1 的整数）');
  }
  if (!Number.isInteger(payload.version) || payload.version < 1) {
    return refuse('merge-request.version 非法（≥1 的整数）');
  }
  if (typeof payload.digest !== 'string' || !DIGEST_PATTERN.test(payload.digest)) {
    return refuse('merge-request.digest 非法（64 位小写十六进制）');
  }
  if (!isPlainObject(payload.ledger)) {
    return refuse('merge-request.ledger 非法（须为台账对象）');
  }
  return { ok: true };
}

function validateMergeOutcomeNotice(payload) {
  if (payload.adopted !== true && payload.adopted !== false) {
    return refuse('merge-outcome.adopted 非法（布尔）');
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
  /* 合流并集的参考数据（管理席位检出时提供、成员侧检出缺省）：被冻条的发起时间与管理者。 */
  if (payload.createdAt !== undefined && !isTimestamp(payload.createdAt)) {
    return refuse('freeze.createdAt 非法（时间戳）');
  }
  if (payload.manager !== undefined && !isPeerShape(payload.manager)) {
    return refuse('freeze.manager 非法（需 instanceId + identityName）');
  }
  return validateReasonPayload(payload);
}

/* 解冻（与 freeze 同判据的匹配面：同名 + 成员交集）：裁定「保持两条」的执行广播。 */
function validateUnfreezePayload(payload) {
  if (!isPlainObject(payload)) {
    return refuse('unfreeze 缺少 payload');
  }
  if (!isIdentityName(payload.name)) {
    return refuse('unfreeze.name 非法（项目名）');
  }
  const members = validateMemberList(payload.members, 'unfreeze.members');
  if (!members.ok) {
    return members;
  }
  return validateReasonPayload(payload);
}

/* 冻结裁定（合并 / 保持两条 / 终止）：choice 枚举 + 匹配面；winner / collabId / executed 为执行型字段。 */
function validateDecisionPayload(payload) {
  if (!isPlainObject(payload)) {
    return refuse('decision 缺少 payload');
  }
  const base = validateDecisionBase(payload);
  if (!base.ok) {
    return base;
  }
  return validateDecisionMarks(payload);
}

function validateDecisionBase(payload) {
  if (payload.choice !== 'merge' && payload.choice !== 'keep' && payload.choice !== 'terminate') {
    return refuse('decision.choice 非法（merge / keep / terminate）');
  }
  if (!isIdentityName(payload.name)) {
    return refuse('decision.name 非法（项目名）');
  }
  return validateMemberList(payload.members, 'decision.members');
}

function validateDecisionMarks(payload) {
  if (payload.winner !== undefined && !isId(payload.winner)) {
    return refuse('decision.winner 非法（协作标识）');
  }
  if (payload.collabId !== undefined && !isId(payload.collabId)) {
    return refuse('decision.collabId 非法（协作标识）');
  }
  if (payload.executed !== undefined && payload.executed !== true && payload.executed !== false) {
    return refuse('decision.executed 非法（布尔）');
  }
  /* 保留方声明的参考数据（合并执行帧携带本机条发起时间；缺省则不参与接收侧顺序校验）。 */
  if (payload.createdAt !== undefined && !isTimestamp(payload.createdAt)) {
    return refuse('decision.createdAt 非法（时间戳）');
  }
  return validateReasonPayload(payload);
}

/* 移交（先确认后删除）：offer 携带整份台账与摘要、accept 为回执、reject 为拒绝。 */
function validateHandoverPayload(payload) {
  if (!isPlainObject(payload)) {
    return refuse('handover 缺少 payload');
  }
  if (payload.kind === 'offer') {
    return validateHandoverOffer(payload);
  }
  if (payload.kind === 'accept') {
    return validateHandoverAccept(payload);
  }
  if (payload.kind === 'reject') {
    return validateReasonPayload(payload);
  }
  return refuse('handover.kind 非法（offer / accept / reject）');
}

/* offer：版本 + 摘要 + 台账整份；endpoints（可选加法字段）= 旧驿丞视角的端点全表
 * （instanceId → {address, port}）——受让方逐项学习后立即可直投老成员（端点互盲修复）。 */
function validateHandoverOffer(payload) {
  if (!isVersionedDigestPayload(payload)) {
    return refuse('handover.version / digest 非法（版本 ≥1 整数、摘要 64 位小写十六进制）');
  }
  if (!isPlainObject(payload.ledger)) {
    return refuse('handover.ledger 非法（须为台账对象）');
  }
  if (payload.endpoints === undefined) {
    return { ok: true };
  }
  if (!isPlainObject(payload.endpoints)) {
    return refuse('handover.endpoints 非法（须为对象：实例标识 → {address, port}）');
  }
  for (const [instanceId, endpoint] of Object.entries(payload.endpoints)) {
    if (!isId(instanceId)) {
      return refuse('handover.endpoints 键非法（需 1–64 位字母数字与连字符的实例标识）');
    }
    const rejection = endpointEntryRejection(endpoint, 'handover.endpoints 项');
    if (!rejection.ok) {
      return rejection;
    }
  }
  return { ok: true };
}

function validateHandoverAccept(payload) {
  if (!isVersionedDigestPayload(payload)) {
    return refuse('handover.version / digest 非法（版本 ≥1 整数、摘要 64 位小写十六进制）');
  }
  return { ok: true };
}

function isVersionedDigestPayload(payload) {
  if (!Number.isInteger(payload.version) || payload.version < 1) {
    return false;
  }
  return typeof payload.digest === 'string' && DIGEST_PATTERN.test(payload.digest);
}

/* 抢接发起（收集窗口）：announce 广播意图、report 定向回汇总、cancel 中止（假失联恢复 / 让位 / 放弃）。 */
function validateTakeoverInitPayload(payload) {
  if (!isPlainObject(payload)) {
    return refuse('takeover-init 缺少 payload');
  }
  if (payload.kind === 'announce') {
    return validateTakeoverAnnounce(payload);
  }
  if (payload.kind === 'report') {
    return validateTakeoverReport(payload);
  }
  if (payload.kind === 'cancel') {
    return validateReasonPayload(payload);
  }
  return refuse('takeover-init.kind 非法（announce / report / cancel）');
}

function validateTakeoverAnnounce(payload) {
  if (!isPeerShape(payload.manager)) {
    return refuse('takeover-init.manager 非法（需 instanceId + identityName）');
  }
  if (!Number.isInteger(payload.baseVersion) || payload.baseVersion < 1) {
    return refuse('takeover-init.baseVersion 非法（≥1 的整数）');
  }
  if (!isTimestamp(payload.windowEndsAt)) {
    return refuse('takeover-init.windowEndsAt 非法（时间戳）');
  }
  return { ok: true };
}

function validateTakeoverReport(payload) {
  if (payload.version !== null && (!Number.isInteger(payload.version) || payload.version < 1)) {
    return refuse('takeover-init.version 非法（null 或 ≥1 的整数）');
  }
  if (payload.takeover !== null && !isTakeoverRecord(payload.takeover)) {
    return refuse('takeover-init.takeover 非法（null 或抢接记录）');
  }
  return { ok: true };
}

/* 抢接生效通告：基准版本 + 恢复台账摘要（新驿丞身份以帧 from 为准）。 */
function validateTakeoverPayload(payload) {
  if (!isPlainObject(payload)) {
    return refuse('takeover 缺少 payload');
  }
  if (!Number.isInteger(payload.baseVersion) || payload.baseVersion < 1) {
    return refuse('takeover.baseVersion 非法（≥1 的整数）');
  }
  if (typeof payload.digest !== 'string' || !DIGEST_PATTERN.test(payload.digest)) {
    return refuse('takeover.digest 非法（64 位小写十六进制）');
  }
  return validateReasonPayload(payload);
}

function isPeerShape(peer) {
  return isPlainObject(peer) && isId(peer.instanceId) && isIdentityName(peer.identityName);
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
