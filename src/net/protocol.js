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

/* 协作模式（设计 §3）：managed = 协作（缺省、兼容旧行为）、forum = 讨论（无主平权）。
 * 模式在创建时定死、不可变；缺字段按 managed 解释（读取侧宽容——对照 port 缺省先例）。
 * 版本一致性：旧版对端会忽略 mode 字段、也不认识讨论新增帧类型——讨论模式要求参与者同版本。 */
export const COLLAB_MODES = ['managed', 'forum'];
export const DEFAULT_COLLAB_MODE = 'managed';

export function isCollabMode(value) {
  return typeof value === 'string' && COLLAB_MODES.includes(value);
}

/* 消息类型最小集（设计 §10）+ 投递可靠性所必需的确认帧 ack。
 * 类型集是两端契约：未知类型一律拒绝（版本不匹配或伪造）。
 * post = 讨论模式的帖通道（设计 §5.2：帧 type = 通道类别、kind = 语义徽标）——
 * 本表是 managed 与讨论两模式的并集（帖载荷只校并集形态，模式语义归协作层）。
 * join = 讨论模式的成员加入事件（成立/加入双义通告，设计 §5.1/§5.4）；
 * join-request / join-grant / join-deny = 会话主动加入三帧（申请 / 批准 / 拒绝，会话级管理设计 §2）；
 * history-request / history-bundle = 拉取两件套（回填与真对账同一机制，设计 §5.3）。 */
export const MESSAGE_TYPES = [
  'invite', 'approve', 'decline', 'withdraw',
  'topic', 'task', 'progress', 'issue', 'stop', 'reply',
  'freeze', 'unfreeze', 'decision', 'handover', 'takeover-init', 'takeover', 'notice', 'leave', 'end',
  'ping', 'pong', 'delivery-status',
  'snapshot', 'seat-presence',
  'post',
  'join', 'join-request', 'join-grant', 'join-deny', 'join-confirm', 'history-request', 'history-bundle',
  'ack',
];

/* 能力闸门（会话级参与者 0.2.0 硬断裂）：协作域帧根节点必须声明 cap=2；
 * 发现面与 transport 帧（ping/pong/ack）不适用——旧版对端在发现面可见，但协作操作被本闸门拒绝。
 * PROTOCOL_VERSION 保持 1：断裂靠能力字段显式声明，不靠版本号。 */
export const COLLAB_CAPABILITY = 2;

/* 出站构造 helper：发送侧（dispatch.frameOf 等属主）统一用它叠加 cap，避免「自家预检拒自家帧」。
 * 纯函数、不改入参；transport 帧加了也无害（校验器对它们豁免）。 */
export function withCollabCapability(frame) {
  return { ...frame, cap: COLLAB_CAPABILITY };
}

/* 帖的语义徽标词表（设计 §5.2：协作类六类＝帖子类型、仅作标签——topic 帖按普通帖处理、
 * 不改任何元状态）。与 ws_send_message 的类型面同一词表（工具层直接引用本常量，单一权威）。 */
export const POST_KINDS = ['topic', 'task', 'progress', 'issue', 'stop', 'reply'];

/* 治理类通告（设计 §10 路由例外清单 + §9 takeover 豁免明示）：重试直至送达、豁免队列上限与过期。 */
export const GOVERNANCE_TYPES = ['freeze', 'unfreeze', 'decision', 'takeover-init', 'takeover'];

/* 投递豁免扩展（设计 §5.5）：讨论的 end / join / leave 是广播型控制事件，沿治理通告先例豁免
 * TTL 与队列上限（离线者另经对表从 bundle 元状态 / 成员事件集学到——豁免保证在线的迟到者不丢）。
 * 拉取两件套（history-*）为短生命周期请求-应答，明确**不泛化豁免**：无应答即换源或下轮对表。 */
export const DELIVERY_EXEMPT_TYPES = [...GOVERNANCE_TYPES, 'end', 'join', 'leave'];

/* 确认即终态的帧类型（设计 §10「ack 是递归的终端」）：delivery-status 的接收侧不落盘 inbox、
 * 不投会话，也不为回报再产生回报——发送方永远不会收到针对它的 session 档回报。
 * 发送队列据此在 ack 时直接收口为终态：停在 acked 会按 7 天保留期持续占用单协作配额
 * （心跳回报可在数小时内占满 500 条，普通消息全部被拒），见 outbox 的 markAcked / settleAckTerminal。 */
export const ACK_TERMINAL_TYPES = ['delivery-status'];

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
  if (!TRANSPORT_TYPES.includes(frame.type) && frame.cap !== COLLAB_CAPABILITY) {
    return refuse('协作域帧缺少 cap=2（对端版本不支持会话级协作，需 0.2.0+）');
  }
  if (!isId(frame.msgId)) {
    return refuse('msgId 非法');
  }
  const from = validateFrom(frame.from, frame.type);
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

/* 主动加入的敲门与应答（设计 §5.6）：同样走发现类数据报校验族——不进 MESSAGE_TYPES
 * （它们不是协作域帧，与入站帧白名单无交互）。 */
export function validateJoinKnock(datagram) {
  return validateDiscovery(datagram, 'join-knock');
}

export function validateJoinAck(datagram) {
  return validateDiscovery(datagram, 'join-ack');
}

/* 按名解析的请求与应答（会话级管理设计 §2）：单播数据报「谁在 <讨论名> 讨论」——请求方不自报身份
 * （应答按数据报来源地址单播回发，问答双方无需先互认），故请求不套发现类的身份必填口径；
 * 与敲门同族，同样不进 MESSAGE_TYPES（它们不是协作域帧，与入站帧白名单无交互）。 */
export function validateJoinResolve(datagram) {
  return validateDiscovery(datagram, 'join-resolve');
}

export function validateJoinResolveAck(datagram) {
  return validateDiscovery(datagram, 'join-resolve-ack');
}

/* 发现面能力字段（设计 §7.2，会话级参与者 0.2.0）：participants:2 是加法字段——
 * 响应存在但缺字段＝旧版/不支持；无响应＝未知（可达性由扫描侧判定，不归本层）。
 * 发现层校验不因该字段拒收旧版对端（发现仍按 v:1 互通），协作准入由协作域 cap 闸门拒绝。 */
export const PARTICIPANTS_CAPABILITY = 2;

export function isParticipantsCapability(value) {
  return value === PARTICIPANTS_CAPABILITY;
}

/** 探测/敲门/加入/解析应答是否显式声明支持会话级参与者。 */
export function supportsParticipants(datagram) {
  return isPlainObject(datagram) && isParticipantsCapability(datagram.participants);
}

/** 出站发现报文的加法字段：只在构造侧叠加，不改变旧字段语义。 */
export function withParticipantsCapability(datagram) {
  return { ...datagram, participants: PARTICIPANTS_CAPABILITY };
}

/* 解析应答的体积整形（沿加入应答同族：序列化后 ≤ MAX_DATAGRAM_BYTES，含信封）：
 * 未命中先归极简形态（讨论面字段在未命中时无意义）；命中先弃 name（整字段——不做前缀截断）、
 * 仍超则弃整份（返回 null，由发送方计数留痕）——绝不发超限数据报，也绝不截不可截字段（collabId 完整保留）。
 * 讨论名与完整讨论面由申请人加入后经正式通道对表补齐：这里的裁剪只是可达性妥协，不承载权威数据。 */
export function fitJoinResolveAck(datagram) {
  const shaped = datagram.found === true ? datagram : minimalResolveAck(datagram);
  if (fitsDatagramBudget(shaped)) {
    return shaped;
  }
  const withoutName = { ...shaped };
  delete withoutName.name;
  return fitsDatagramBudget(withoutName) ? withoutName : null;
}

/* 未命中应答的极简形态：弃讨论面字段（collabId / name）——其余字段原样保留（未知加法字段不弃，前向兼容）。 */
function minimalResolveAck(datagram) {
  const minimal = { ...datagram };
  delete minimal.collabId;
  delete minimal.name;
  return minimal;
}

/* 数据报体积量法：与发现层整形同一常量、同一量法（序列化后的 UTF-8 字节数）。 */
function fitsDatagramBudget(datagram) {
  return Buffer.byteLength(JSON.stringify(datagram)) <= MAX_DATAGRAM_BYTES;
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
 * 体积上限（MAX_FRAME_BYTES / MAX_DATAGRAM_BYTES）由消费方按 Buffer 字节数测量并执行
 * （例外：解析应答的整形 fitJoinResolveAck——可弃字段的次序是协议契约，随数据报校验定义于此）。 */
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
    return collabRule(frame.payload, frame);
  }
  return { ok: true };
}

function validateFrom(from, type) {
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
  return fromSessionRejection(from, type);
}

/* 签发席位（设计 §5.1）：协作域帧的 from 必须携 sessionId（A1/A2 来源判定、leave、join-confirm 都按它）；
 * transport 帧（ping/pong/ack）允许缺省，存在则同样过标识判据。 */
function fromSessionRejection(from, type) {
  if (type !== undefined && TRANSPORT_TYPES.includes(type)) {
    if (from.sessionId !== undefined && !isId(from.sessionId)) {
      return refuse('from.sessionId 非法（存在则须为 1–64 位字母数字与连字符）');
    }
    return { ok: true };
  }
  if (!isId(from.sessionId)) {
    return refuse('from.sessionId 非法（协作域帧需携带签发会话标识）');
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
  if (expectedType === 'join-resolve') {
    return joinResolveFieldsRejection(datagram);   // 请求方不自报身份：先于身份字段分支
  }
  if (!isId(datagram.instanceId)) {
    return refuse('发现报文 instanceId 非法');
  }
  if (!isIdentityName(datagram.identityName)) {
    return refuse('发现报文 identityName 非法');
  }
  return discoveryPayloadRejection(datagram, expectedType);
}

/* 各类型的专属字段（身份字段之后）：probe 无专属字段（公共头即全部）。 */
function discoveryPayloadRejection(datagram, expectedType) {
  if (expectedType === 'probe-ack') {
    return probeAckFieldsRejection(datagram);
  }
  if (expectedType === 'join-knock') {
    return joinKnockFieldsRejection(datagram);
  }
  if (expectedType === 'join-ack') {
    return joinAckFieldsRejection(datagram);
  }
  if (expectedType === 'join-resolve-ack') {
    return joinResolveAckFieldsRejection(datagram);
  }
  return { ok: true };
}

/* 扫描应答专属字段：collabCount 必填合法（0 起——无协作的站点照样应答）。
 * port：宽容缺省（已定案）——缺 port 回退数据报来源端口；字段存在则校验 1–65535 且以字段为准。 */
function probeAckFieldsRejection(datagram) {
  if (!isCollabCount(datagram.collabCount)) {
    return refuse('扫描应答 collabCount 非法');
  }
  if (datagram.port !== undefined && !isPort(datagram.port)) {
    return refuse('扫描应答 port 非法（1–65535 的整数）');
  }
  return { ok: true };
}

/* 敲门：讨论名（同身份名呈现判据；敲门会把名字播给全网，形态不得放宽）+ 报送标识
 * （应答据此回指本次敲门——旧应答不进新申请的结果面）。端口不入报文：来源端口即站点端口。 */
function joinKnockFieldsRejection(datagram) {
  if (!isId(datagram.knockId)) {
    return refuse('敲门报文 knockId 非法');
  }
  if (!isIdentityName(datagram.name)) {
    return refuse(`敲门报文 name 非法（讨论名：≤${MAX_IDENTITY_NAME_CHARS} 字符、不含不可见字符的呈现文本）`);
  }
  return { ok: true };
}

/* 应答：讨论面字段齐全（collabId / 名称 / 主题 / 成员数 / 发起人标识）+ port 宽容缺省。
 * 主题与名称可截断（体积预算，设计 §5.6），截断必须带标注——空值仅在被标注截断时容许，
 * 不得以空串伪装完整值；collabId / 成员数 / 发起人标识不可截（接收侧校验同口径）。 */
function joinAckFieldsRejection(datagram) {
  if (!isId(datagram.knockId)) {
    return refuse('加入应答 knockId 非法');
  }
  if (!isId(datagram.collabId)) {
    return refuse('加入应答 collabId 非法');
  }
  const textIssue = joinAckTextFieldsRejection(datagram);
  if (textIssue !== null) {
    return textIssue;
  }
  return joinAckMemberFieldsRejection(datagram);
}

/* 可截断文本字段（名称 / 主题）逐项拒收，全部通过返回 null。 */
function joinAckTextFieldsRejection(datagram) {
  const nameIssue = joinAckTextRejection(datagram.name, MAX_IDENTITY_NAME_CHARS, datagram.nameTruncated, '名称');
  if (nameIssue !== null) {
    return nameIssue;
  }
  const topicIssue = joinAckTextRejection(datagram.topic, MAX_TOPIC_CHARS, datagram.topicTruncated, '主题');
  if (topicIssue !== null) {
    return topicIssue;
  }
  return null;
}

/* 成员面字段（成员数 / 发起人标识）与 port 宽容缺省（缺 port 回退来源端口，同上扫描应答口径）。 */
function joinAckMemberFieldsRejection(datagram) {
  if (!Number.isInteger(datagram.memberCount) || datagram.memberCount < 1 || datagram.memberCount > MAX_COLLAB_COUNT) {
    return refuse(`加入应答 memberCount 非法（1–${MAX_COLLAB_COUNT} 的整数）`);
  }
  if (!isPeerShape(datagram.originator)) {
    return refuse('加入应答 originator 非法（需 instanceId + identityName 的发起人标识）');
  }
  if (datagram.port !== undefined && !isPort(datagram.port)) {
    return refuse('加入应答 port 非法（1–65535 的整数）');
  }
  return { ok: true };
}

/* 可截断文本字段（名称 / 主题）：形态合法即通过（返回 null）；空值仅限带截断标注；标注存在则须为布尔。 */
function joinAckTextRejection(value, maxChars, truncatedFlag, label) {
  if (truncatedFlag !== undefined && typeof truncatedFlag !== 'boolean') {
    return refuse(`加入应答 ${label}截断标注非法（布尔）`);
  }
  if (typeof value !== 'string') {
    return refuse(`加入应答 ${label}非法（≤${maxChars} 字符的呈现文本）`);
  }
  if (value === '') {
    return truncatedFlag === true ? null : refuse(`加入应答 ${label}不能为空（空值仅限截断标注）`);
  }
  return isPresentationText(value, maxChars) ? null : refuse(`加入应答 ${label}非法（≤${maxChars} 字符的呈现文本）`);
}

/* 解析请求：讨论名（同敲门口径——名字会播给被问者）+ 报送标识（应答据此回指本次解析，
 * 旧答不进新申请的结果面）。请求方不自报身份：单播问答按数据报来源地址回发。 */
function joinResolveFieldsRejection(datagram) {
  if (!isId(datagram.resolveId)) {
    return refuse('解析报文 resolveId 非法');
  }
  if (!isIdentityName(datagram.name)) {
    return refuse(`解析报文 name 非法（讨论名：≤${MAX_IDENTITY_NAME_CHARS} 字符、不含不可见字符的呈现文本）`);
  }
  return { ok: true };
}

/* 解析应答（单播回执）：报送标识 + 命中断言「谁在 <讨论名> 讨论」；port 宽容缺省（同扫描应答 /
 * 加入应答口径——缺 port 回退数据报来源端口）。命中与未命中各有自己的形态（见下方两个分支）。 */
function joinResolveAckFieldsRejection(datagram) {
  if (!isId(datagram.resolveId)) {
    return refuse('解析应答 resolveId 非法');
  }
  if (datagram.found !== true && datagram.found !== false) {
    return refuse('解析应答 found 非法（布尔）');
  }
  if (datagram.port !== undefined && !isPort(datagram.port)) {
    return refuse('解析应答 port 非法（1–65535 的整数）');
  }
  return datagram.found ? joinResolveHitRejection(datagram) : joinResolveMissRejection(datagram);
}

/* 命中形态：协作标识必携且不可截（沿加入应答不可截先例——申请人据此拨入加入）；
 * 讨论名可省（整形可弃，完整名加入后对表补齐），存在则须为合法讨论名（呈现面判据）。 */
function joinResolveHitRejection(datagram) {
  if (!isId(datagram.collabId)) {
    return refuse('解析应答 collabId 非法（命中必携；不可截不可弃）');
  }
  if (datagram.name !== undefined && !isIdentityName(datagram.name)) {
    return refuse(`解析应答 name 非法（讨论名：≤${MAX_IDENTITY_NAME_CHARS} 字符、不含不可见字符的呈现文本）`);
  }
  return { ok: true };
}

/* 未命中形态：极简——不带讨论面字段（带即拒：未命中却点名是自相矛盾的断言）。 */
function joinResolveMissRejection(datagram) {
  if (datagram.collabId !== undefined || datagram.name !== undefined) {
    return refuse('解析应答未命中不得携带讨论面字段（collabId / name）');
  }
  return { ok: true };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function isVersion(value) {
  return Number.isInteger(value) && value >= 1;
}

/** 任期编号（设计 §2A.1）：1..2^31−1 的整数；到顶拒绝变更、不回绕。 */
export function isManagerTerm(value) {
  return Number.isInteger(value) && value >= 1 && value <= MAX_MANAGER_TERM;
}

/* 席位引用（自动移交/站长变更的来源与目标）：instanceId + sessionId；identityName 可选但须可呈现。 */
function isSeatRef(value) {
  if (!isPlainObject(value) || !isId(value.instanceId) || !isId(value.sessionId)) {
    return false;
  }
  return value.identityName === undefined || isIdentityName(value.identityName);
}

/* 席位身份（名单行 / 站长）：instanceId + sessionId + identityName。 */
function isSeatPeer(value) {
  return isSeatRef(value) && isIdentityName(value.identityName);
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
 * 语义裁定（名单含本机、状态是否允许、来源是否现任站长）在协作层。上限值服务呈现链与会话注入链的稳健性。 */
/* 活跃席位上限（设计 §2.1/§2.5）：managed 协议硬顶 32；forum 软顶 16（按活跃会话计，历史行不占）。
 * MAX_COLLAB_MEMBERS 是 0.1.x 的退役名，保留为别名供未迁移调用点继续编译。 */
export const MAX_ACTIVE_SEATS = 32;
export const MAX_FORUM_ACTIVE_SEATS = 16;
export const MAX_COLLAB_MEMBERS = MAX_ACTIVE_SEATS;
/* 任期内序上界（设计 §2A.1 / §6.3）：2^31−1 防伪造 term 永久占优；到顶拒绝变更，不回绕。 */
export const MAX_MANAGER_TERM = 2147483647;
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
  post: validatePostPayload,
  join: validateMemberEventPayload,
  'join-request': validateJoinRequestPayload,
  'join-grant': validateJoinGrantPayload,
  'join-deny': validateJoinDenyPayload,
  'join-confirm': validateJoinConfirmPayload,
  'seat-presence': validateSeatPresencePayload,
  'history-request': validateHistoryRequestPayload,
  'history-bundle': validateHistoryBundlePayload,
  end: validateOptionalObjectPayload,
  leave: validateLeavePayload,
};

function validateInvitePayload(payload) {
  if (!isPlainObject(payload)) {
    return refuse('invite 缺少 payload');
  }
  const baseIssue = inviteBaseRejection(payload);
  if (baseIssue !== null) {
    return baseIssue;
  }
  const members = validateMemberList(payload.members, 'invite.members');
  if (!members.ok) {
    return members;
  }
  const extrasIssue = inviteExtrasRejection(payload);
  if (extrasIssue !== null) {
    return extrasIssue;
  }
  /* endpoints（可选加法字段，讨论邀请携带）：现成员端点表，被邀者据此取得入群所需的寻址信息。
   * 缺省不拒（managed 与旧版邀请不带）；存在则逐项过端点形态。 */
  return optionalInviteEndpointsRejection(payload.endpoints);
}

function inviteBaseRejection(payload) {
  if (payload.mode !== undefined && !isCollabMode(payload.mode)) {
    return refuse(`invite.mode 非法（可选值：${COLLAB_MODES.join(' / ')}；缺省 ${DEFAULT_COLLAB_MODE}）`);
  }
  if (!isIdentityName(payload.name)) {
    return refuse('invite.name 非法（项目名，同身份名呈现判据）');
  }
  if (!isPresentationText(payload.topic, MAX_TOPIC_CHARS)) {
    return refuse(`invite.topic 非法（≤${MAX_TOPIC_CHARS} 字符的呈现文本）`);
  }
  return null;
}

function inviteExtrasRejection(payload) {
  /* managed 邀请簿记键（forum 不生成、不返回 inviteId——D18）：可选，存在则过标识判据。 */
  if (payload.inviteId !== undefined && !isId(payload.inviteId)) {
    return refuse('invite.inviteId 非法（1–64 位字母数字与连字符）');
  }
  const targets = validateInviteTargets(payload.targets);
  if (!targets.ok) {
    return targets;
  }
  /* originator（可选加法字段，讨论邀请携带）：发起人实例标识（= 中继归属，与「邀请者引用」
   * 不同字段——邀请者≠发起人，中继归属不得由邀请者推断）；存在则须为完整身份对。 */
  if (payload.originator !== undefined && !isPeerShape(payload.originator)) {
    return refuse('invite.originator 非法（需 instanceId + identityName 的发起人标识）');
  }
  return null;
}

/* 邀请目标机器（设计 §2.2）：不要求目标席位已在 members 中。唯一性键 (instanceId,targetSessionId ?? '')；
 * targetSessionId 缺省＝不指名邀请（目标机全部活跃会话）。 */
function validateInviteTargets(targets) {
  if (targets === undefined) {
    return { ok: true };
  }
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > MAX_ACTIVE_SEATS) {
    return refuse(`invite.targets 须为 1–${MAX_ACTIVE_SEATS} 项的目标列表`);
  }
  const seen = new Set();
  for (const target of targets) {
    const rejection = inviteTargetRejection(target);
    if (rejection !== null) {
      return rejection;
    }
    const key = `${target.instanceId}\u0000${target.targetSessionId ?? ''}`;
    if (seen.has(key)) {
      return refuse('invite.targets 含重复目标（instanceId + targetSessionId）');
    }
    seen.add(key);
  }
  return { ok: true };
}

function inviteTargetRejection(target) {
  if (!isPlainObject(target) || !isId(target.instanceId)) {
    return refuse('invite.targets 条目非法（需 instanceId）');
  }
  if (target.targetSessionId !== undefined && !isId(target.targetSessionId)) {
    return refuse('invite.targets.targetSessionId 非法（1–64 位字母数字与连字符）');
  }
  return null;
}

function optionalInviteEndpointsRejection(endpoints) {
  if (endpoints === undefined) {
    return { ok: true };
  }
  return bundleEndpointsRejection(endpoints, 'invite.endpoints') ?? { ok: true };
}

/* 名单形态（invite / freeze / unfreeze / decision 共用）：1–32 项席位条目
 * {instanceId,sessionId,identityName}；唯一性键 (instanceId,sessionId)——同机多会话各自成席（D13）。
 * invite.members 只须含发起人，不要求目标席位在名单中（目标机器另用 targets 描述）。 */
function validateMemberList(members, label) {
  if (!Array.isArray(members) || members.length < 1 || members.length > MAX_ACTIVE_SEATS) {
    return refuse(`${label} 须为 1–${MAX_ACTIVE_SEATS} 项的席位名单`);
  }
  const seen = new Set();
  for (const member of members) {
    if (!isPlainObject(member) || !isId(member.instanceId) || !isId(member.sessionId) || !isIdentityName(member.identityName)) {
      return refuse(`${label} 条目非法（需 instanceId + sessionId + identityName 的席位条目）`);
    }
    const key = `${member.instanceId}\u0000${member.sessionId}`;
    if (seen.has(key)) {
      return refuse(`${label} 名单含重复席位标识（instanceId + sessionId）`);
    }
    seen.add(key);
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

/* 帖载荷（设计 §5.2 帖形态；校验分层见 §5.5）：本层只校「并集形态」——post 字段齐全、
 * 各字段形态与长度边界成立，不判协作模式；模式语义（讨论帖 vs managed 实例、kind 词表归属、
 * 帧类型与帖形态的一致性）归协作层。postId 由作者生成、接收端原样采用（不得本地重编）；
 * seq = 作者内单调序号（随帖携带、作者内比较的权威序列）；text 沿既有消息文本上限
 * （不复用 topic/stop 的呈现文本限制、不触发 task 的 taskId 分支）。
 * relay 为可选加法字段（讨论的中继分发，设计 §5.2）：成员把投稿发往中继时携带 true，
 * 中继据此识别「投稿转发」并扇出；缺省＝普通副本（接收端幂等吸收、不转达）。 */
function validatePostPayload(payload) {
  if (!isPlainObject(payload) || !isPlainObject(payload.post)) {
    return refuse('post 缺少 payload.post（帖形态）');
  }
  const post = payload.post;
  if (!isId(post.postId)) {
    return refuse('post.postId 非法（1–64 位字母数字与连字符）');
  }
  if (!Number.isInteger(post.seq) || post.seq < 1) {
    return refuse('post.seq 非法（≥1 的整数）');
  }
  if (typeof post.kind !== 'string' || post.kind === '') {
    return refuse('post.kind 非法（非空字符串；词表归属由协作层判定）');
  }
  if (!isMessageText(post.text)) {
    return refuse(`post.text 非法（非空、≤${MAX_MESSAGE_TEXT_CHARS} 字符）`);
  }
  return relayFlagRejection(payload);
}

/* relay 标记（可选加法字段）：布尔底线在本层，语义（投稿识别与转达）归协作层。 */
function relayFlagRejection(payload) {
  if (payload.relay !== undefined && typeof payload.relay !== 'boolean') {
    return refuse('post.relay 非法（布尔；缺省＝普通副本）');
  }
  return { ok: true };
}

/* —— 讨论模式的成员事件与拉取两件套（设计 §5.3/§5.4）—— */

/* 成员事件载荷（join；leave 的可选扩展字段同形）：唯一事件 id + 成员自身单调时刻。
 * 事件 id 是并集合并的去重键（重播/重复路径天然幂等）；时刻取成员侧分配的事件时刻
 * （非帧 ts——重发/重播帧的 ts 会变，事件时刻必须稳定，否则折叠会翻转）。 */
function validateMemberEventPayload(payload) {
  if (!isPlainObject(payload) || !isId(payload.eventId) || !isTimestamp(payload.ts)) {
    return refuse('缺少合法的 payload.eventId / payload.ts（成员事件形态）');
  }
  return { ok: true };
}

/* leave 载荷（managed 为空对象；讨论携成员事件字段 + 可选原因）：eventId 与 ts 成对出现。 */
function validateLeavePayload(payload) {
  if (payload !== undefined && !isPlainObject(payload)) {
    return refuse('payload 须为 JSON 对象');
  }
  if (payload === undefined) {
    return { ok: true };
  }
  if (payload.eventId !== undefined || payload.ts !== undefined) {
    if (!isId(payload.eventId) || !isTimestamp(payload.ts)) {
      return refuse('leave 的成员事件字段非法（eventId 与 ts 须成对且形态合法）');
    }
  }
  return validateReasonPayload(payload);
}

/* —— 会话主动加入四帧（设计 §4.4）：申请 / 批准 / 拒绝 / 确认 —— */

/* 申请：只携目标会话标识（会话短码在协议面之外——短码只是对外表示，帧内一律全标识）。 */
function validateJoinRequestPayload(payload) {
  if (!isPlainObject(payload) || !isId(payload.sessionId)) {
    return refuse('join-request.sessionId 非法（1–64 位字母数字与连字符）');
  }
  return { ok: true };
}

/* 批准：joinId + 站长席位 + 签发时 term + grantVersion；sessionId 为可选回带（确认授予对象）。 */
function validateJoinGrantPayload(payload) {
  if (!isPlainObject(payload) || !isId(payload.joinId)) {
    return refuse('join-grant.joinId 非法（1–64 位字母数字与连字符）');
  }
  if (!isSeatPeer(payload.manager)) {
    return refuse('join-grant.manager 非法（需 instanceId + sessionId + identityName 的站长席位）');
  }
  if (!isManagerTerm(payload.managerTerm)) {
    return refuse(`join-grant.managerTerm 非法（1–${MAX_MANAGER_TERM} 的整数）`);
  }
  if (!isVersion(payload.version)) {
    return refuse('join-grant.version 非法（≥1 的整数）');
  }
  if (payload.sessionId !== undefined && !isId(payload.sessionId)) {
    return refuse('join-grant.sessionId 非法（1–64 位字母数字与连字符）');
  }
  return { ok: true };
}

/* 拒绝：joinId + 原因（申请侧据此回滚）；reason 枚举是两段式入席的失败路径契约。 */
const JOIN_DENY_REASONS = ['expired', 'aborted', 'manager-changed', 'capacity'];

function validateJoinDenyPayload(payload) {
  if (!isPlainObject(payload) || !isId(payload.joinId)) {
    return refuse('join-deny.joinId 非法（1–64 位字母数字与连字符）');
  }
  if (typeof payload.reason !== 'string' || !JOIN_DENY_REASONS.includes(payload.reason)) {
    return refuse(`join-deny.reason 非法（${JOIN_DENY_REASONS.join(' / ')}）`);
  }
  if (payload.managerTerm !== undefined && !isManagerTerm(payload.managerTerm)) {
    return refuse(`join-deny.managerTerm 非法（1–${MAX_MANAGER_TERM} 的整数）`);
  }
  return { ok: true };
}

/* 确认：申请人回执 joinId + 其持有的 term/version；grantVersion 只作记录，版本推进由接收侧回快照。 */
function validateJoinConfirmPayload(payload) {
  if (!isPlainObject(payload) || !isId(payload.joinId)) {
    return refuse('join-confirm.joinId 非法（1–64 位字母数字与连字符）');
  }
  if (!isManagerTerm(payload.managerTerm)) {
    return refuse(`join-confirm.managerTerm 非法（1–${MAX_MANAGER_TERM} 的整数）`);
  }
  if (!isVersion(payload.version)) {
    return refuse('join-confirm.version 非法（≥1 的整数）');
  }
  return { ok: true };
}

/* —— 席位心跳（设计 §2A.9）：本机在该协作的活跃会话列表 —— */
function validateSeatPresencePayload(payload, frame) {
  if (!isPlainObject(payload) || !isId(payload.collabId) || !isId(payload.instanceId)) {
    return refuse('seat-presence 需 collabId + instanceId');
  }
  if (payload.collabId !== frame.collabId || payload.instanceId !== frame.from.instanceId) {
    return refuse('seat-presence 的 collabId / instanceId 必须与帧一致');
  }
  const sessionsIssue = seatPresenceSessionsRejection(payload.sessions);
  if (sessionsIssue !== null) {
    return sessionsIssue;
  }
  if (!isTimestamp(payload.sentAt)) {
    return refuse('seat-presence.sentAt 非法（时间戳）');
  }
  return { ok: true };
}

function seatPresenceSessionsRejection(sessions) {
  if (!Array.isArray(sessions) || sessions.length < 1 || sessions.length > MAX_ACTIVE_SEATS) {
    return refuse(`seat-presence.sessions 须为 1–${MAX_ACTIVE_SEATS} 项的会话列表`);
  }
  const seen = new Set();
  for (const sessionId of sessions) {
    if (!isId(sessionId)) {
      return refuse('seat-presence.sessions 含非法会话标识');
    }
    if (seen.has(sessionId)) {
      return refuse('seat-presence.sessions 含重复会话标识');
    }
    seen.add(sessionId);
  }
  return null;
}

/* 同步游标（排他语义的复合位置）：(ts, postId)——只由拉取推进；同刻按 postId 序兜底。 */
function isCursorShape(value) {
  return isPlainObject(value) && isTimestamp(value.ts) && isId(value.postId);
}

function optionalCursorRejection(value, label) {
  if (value === undefined || value === null) {
    return null;
  }
  return isCursorShape(value) ? null : refuse(`${label} 非法（需为 { ts, postId } 游标或 null）`);
}

/* 作者粒度摘要上界（形态防线）：条数与范围数都封顶——超限帧不可能是诚实实现所出。 */
export const MAX_SUMMARY_AUTHORS = 64;
export const MAX_SUMMARY_RANGES_PER_AUTHOR = 256;

/* 作者粒度摘要（设计 §5.3 真对账）：每作者计数 + 作者内已见序号集（范围内联编码，可定位回退起点）。 */
function summaryRejection(value, label) {
  if (value === undefined) {
    return null;   // 摘要为可选加法字段（普通拉取可不带；对表交换必须带）
  }
  if (!isPlainObject(value) || !Array.isArray(value.authors) || value.authors.length > MAX_SUMMARY_AUTHORS) {
    return refuse(`${label} 非法（需为 { authors: [...] } 且不超过 ${MAX_SUMMARY_AUTHORS} 位作者）`);
  }
  for (const author of value.authors) {
    const rejection = summaryAuthorRejection(author, label);
    if (rejection !== null) {
      return rejection;
    }
  }
  return null;
}

function summaryAuthorRejection(author, label) {
  if (!isPlainObject(author) || !isId(author.instanceId) || !Number.isInteger(author.count) || author.count < 1) {
    return refuse(`${label} 条目非法（需 instanceId + count ≥ 1）`);
  }
  if (!Array.isArray(author.seqs) || author.seqs.length === 0 || author.seqs.length > MAX_SUMMARY_RANGES_PER_AUTHOR) {
    return refuse(`${label}.seqs 非法（范围内联编码数组：非空且不超过 ${MAX_SUMMARY_RANGES_PER_AUTHOR} 段）`);
  }
  const rangesIssue = summaryRangesRejection(author.seqs, label);
  if (rangesIssue !== null) {
    return rangesIssue;
  }
  /* 计数与序号集自洽（计数 = 序号总数；纯算术、无展开循环）——摘要的完备性由它兜底。 */
  if (summarySeqTotal(author.seqs) !== author.count) {
    return refuse(`${label} 条目非法（count 与序号集不一致）`);
  }
  return null;
}

/* 序号段形态：二元组、正整数、升序且互不重叠（升序保证折叠与比对是同一读法）。 */
function summaryRangesRejection(ranges, label) {
  let lastTo = 0;
  for (const range of ranges) {
    if (!Array.isArray(range) || range.length !== 2) {
      return refuse(`${label}.seqs 段非法（需 [起, 止] 二元组）`);
    }
    const from = range[0];
    const to = range[1];
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
      return refuse(`${label}.seqs 段非法（正整数、升序且互不重叠）`);
    }
    if (from <= lastTo) {
      return refuse(`${label}.seqs 段非法（正整数、升序且互不重叠）`);
    }
    lastTo = to;
  }
  return null;
}

function summarySeqTotal(ranges) {
  let total = 0;
  for (const range of ranges) {
    total += range[1] - range[0] + 1;
  }
  return total;
}

/* history-request（拉取/对表请求）：after = 拉取起点（排他；null/缺省 = 空游标全量）；
 * summary = 请求方作者粒度摘要（对表交换用，可选）。 */
function validateHistoryRequestPayload(payload) {
  if (!isPlainObject(payload)) {
    return refuse('history-request 缺少 payload');
  }
  const cursorRejection = optionalCursorRejection(payload.after, 'history-request.after');
  if (cursorRejection !== null) {
    return cursorRejection;
  }
  const summaryIssue = summaryRejection(payload.summary, 'history-request.summary');
  if (summaryIssue !== null) {
    return summaryIssue;
  }
  return { ok: true };
}

/* 拉取体量形态上界（帧体积 1 MiB 硬顶之下的第二道防线）：条目数与端点表条数封顶。 */
export const MAX_BUNDLE_POSTS = 10000;
export const MAX_BUNDLE_EVENTS = 1000;
export const MAX_ENDPOINT_TABLE_ENTRIES = 64;

/* history-bundle（拉取应答）：增量段 + 尾部重叠窗 + 元状态 + 成员事件集 + 端点表 + 对表交换面
 * （应答方同步游标与摘要）+ 分段续拉面（more / nextAfter）。 */
function validateHistoryBundlePayload(payload) {
  if (!isPlainObject(payload)) {
    return refuse('history-bundle 缺少 payload');
  }
  const shapeIssue = bundleExchangeRejection(payload);
  if (shapeIssue !== null) {
    return shapeIssue;
  }
  const postsIssue = bundlePostsRejection(payload.posts, 'history-bundle.posts');
  if (postsIssue !== null) {
    return postsIssue;
  }
  const overlapIssue = bundlePostsRejection(payload.overlap, 'history-bundle.overlap');
  if (overlapIssue !== null) {
    return overlapIssue;
  }
  const tailIssue = bundleTailRejection(payload);
  if (tailIssue !== null) {
    return tailIssue;
  }
  return { ok: true };
}

function bundleExchangeRejection(payload) {
  const cursorRejection = optionalCursorRejection(payload.cursor, 'history-bundle.cursor');
  if (cursorRejection !== null) {
    return cursorRejection;
  }
  const summaryIssue = summaryRejection(payload.summary, 'history-bundle.summary');
  if (summaryIssue !== null) {
    return summaryIssue;
  }
  if (payload.more !== true && payload.more !== false) {
    return refuse('history-bundle.more 非法（布尔）');
  }
  if (payload.more === true && !isCursorShape(payload.nextAfter)) {
    return refuse('history-bundle.nextAfter 非法（more=true 时需为续拉游标）');
  }
  return null;
}

function bundlePostsRejection(posts, label) {
  if (!Array.isArray(posts) || posts.length > MAX_BUNDLE_POSTS) {
    return refuse(`${label} 非法（帖数组，不超过 ${MAX_BUNDLE_POSTS} 条）`);
  }
  for (const post of posts) {
    const rejection = bundledPostRejection(post, label);
    if (rejection !== null) {
      return rejection;
    }
  }
  return null;
}

function bundledPostRejection(post, label) {
  if (!isPlainObject(post) || !isPlainObject(post.from)) {
    return refuse(`${label} 条目非法（帖形态）`);
  }
  const fromIssue = postFromRejection(post.from, label);
  if (fromIssue !== null) {
    return fromIssue;
  }
  if (!isId(post.postId) || !Number.isInteger(post.seq) || post.seq < 1 || !isTimestamp(post.ts)) {
    return refuse(`${label} 条目非法（postId / seq / ts）`);
  }
  return postBodyRejection(post, label);
}

function postFromRejection(from, label) {
  if (!isId(from.instanceId) || !isIdentityName(from.identityName)) {
    return refuse(`${label}.from 非法（需 instanceId + identityName）`);
  }
  return null;
}

function postBodyRejection(post, label) {
  if (typeof post.kind !== 'string' || post.kind === '' || post.kind.length > 32) {
    return refuse(`${label}.kind 非法（非空短字符串；词表归属由协作层判定）`);
  }
  if (!isMessageText(post.text)) {
    return refuse(`${label}.text 非法（非空、≤${MAX_MESSAGE_TEXT_CHARS} 字符）`);
  }
  return null;
}

function bundleTailRejection(payload) {
  if (!isPlainObject(payload.meta)) {
    return refuse('history-bundle.meta 非法（须为讨论元状态对象）');
  }
  if (!Array.isArray(payload.members) || payload.members.length > MAX_BUNDLE_EVENTS) {
    return refuse(`history-bundle.members 非法（成员事件数组，不超过 ${MAX_BUNDLE_EVENTS} 条）`);
  }
  for (const event of payload.members) {
    const rejection = bundledMemberEventRejection(event);
    if (rejection !== null) {
      return rejection;
    }
  }
  return bundleEndpointsRejection(payload.endpoints);
}

function bundledMemberEventRejection(event) {
  if (!isPlainObject(event) || !isId(event.eventId)) {
    return refuse('history-bundle.members 条目非法（需事件 id）');
  }
  if (event.kind !== 'join' && event.kind !== 'leave') {
    return refuse('history-bundle.members 条目的 kind 非法（join / leave）');
  }
  if (!isId(event.instanceId) || !isIdentityName(event.identityName) || !isTimestamp(event.ts)) {
    return refuse('history-bundle.members 条目非法（instanceId / identityName / ts）');
  }
  return null;
}

function bundleEndpointsRejection(endpoints, label = 'history-bundle.endpoints') {
  if (!isPlainObject(endpoints)) {
    return refuse(`${label} 非法（须为对象：实例标识 → { address, port }）`);
  }
  const entries = Object.entries(endpoints);
  if (entries.length > MAX_ENDPOINT_TABLE_ENTRIES) {
    return refuse(`${label} 非法（不超过 ${MAX_ENDPOINT_TABLE_ENTRIES} 项）`);
  }
  for (const [instanceId, endpoint] of entries) {
    if (!isId(instanceId)) {
      return refuse(`${label} 键非法（需 1–64 位字母数字与连字符的实例标识）`);
    }
    const rejection = endpointEntryRejection(endpoint, `${label} 项`);
    if (!rejection.ok) {
      return rejection;
    }
  }
  return null;
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
    return refuse('notice.event 非法（本版：established / roster / snapshot-stored / manager-changed / auto-offer / handshake / merge-request / merge-outcome）');
  }
  return NOTICE_EVENT_RULES[payload.event](payload);
}

const NOTICE_EVENT_RULES = {
  established: validateVersionedNotice,
  roster: validateVersionedNotice,
  'snapshot-stored': validateVersionedNotice,
  'manager-changed': validateManagerChangedNotice,
  'auto-offer': validateAutoOfferNotice,
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

/* 站长变更（设计 §2A.1 受理表）：任期、版本、来源、前任、窗口与摘要均为受理依据；
 * 本层只判字段形态与按 via 的必备面，受理裁定（A1–A14）在协作层。 */
const MANAGER_CHANGE_VIAS = ['initial', 'handover', 'auto', 'takeover', 'takeover-manual'];

function validateManagerChangedNotice(payload) {
  const coreIssue = managerChangeCoreRejection(payload);
  if (coreIssue !== null) {
    return coreIssue;
  }
  const markIssue = managerChangeMarkRejection(payload);
  if (markIssue !== null) {
    return markIssue;
  }
  const windowIssue = managerChangeWindowRejection(payload);
  if (windowIssue !== null) {
    return windowIssue;
  }
  const windowFieldIssue = managerChangeWindowFieldRejection(payload);
  if (windowFieldIssue !== null) {
    return windowFieldIssue;
  }
  return managerChangeViaRejection(payload);
}

/* 窗口字段只属于开窗的 via（显式移交/initial/takeover-manual 无窗口；takeover 关闭窗口不带 endsAt）。 */
function managerChangeWindowFieldRejection(payload) {
  if (payload.windowEndsAt !== undefined && payload.via !== 'auto') {
    return refuse('manager-changed.windowEndsAt 仅 auto 可携（其余 via 不开窗）');
  }
  if (payload.windowBaseTerm !== undefined && payload.via !== 'takeover') {
    return refuse('manager-changed.windowBaseTerm 仅 takeover 可携');
  }
  if (payload.authorizedAt !== undefined && !['auto', 'takeover', 'takeover-manual'].includes(payload.via)) {
    return refuse('manager-changed.authorizedAt 仅 auto / takeover / takeover-manual 可携');
  }
  return null;
}

function managerChangeCoreRejection(payload) {
  if (!isManagerTerm(payload.term)) {
    return refuse(`manager-changed.term 非法（1–${MAX_MANAGER_TERM} 的整数）`);
  }
  if (!isVersion(payload.version)) {
    return refuse('manager-changed.version 非法（≥1 的整数）');
  }
  if (!isSeatPeer(payload.manager)) {
    return refuse('manager-changed.manager 非法（需 instanceId + sessionId + identityName 的站长席位）');
  }
  if (typeof payload.via !== 'string' || !MANAGER_CHANGE_VIAS.includes(payload.via)) {
    return refuse(`manager-changed.via 非法（${MANAGER_CHANGE_VIAS.join(' / ')}）`);
  }
  if (!isSeatRef(payload.prevManager)) {
    return refuse('manager-changed.prevManager 非法（需 instanceId + sessionId 的前任席位）');
  }
  return null;
}

function managerChangeMarkRejection(payload) {
  if (payload.offerId !== undefined && !isId(payload.offerId)) {
    return refuse('manager-changed.offerId 非法（1–64 位字母数字与连字符）');
  }
  if (!isTimestamp(payload.effectiveAt)) {
    return refuse('manager-changed.effectiveAt 非法（时间戳）');
  }
  if (typeof payload.digest !== 'string' || !DIGEST_PATTERN.test(payload.digest)) {
    return refuse('manager-changed.digest 非法（64 位小写十六进制）');
  }
  return null;
}

function managerChangeWindowRejection(payload) {
  if (payload.windowBaseTerm !== undefined && !isManagerTerm(payload.windowBaseTerm)) {
    return refuse(`manager-changed.windowBaseTerm 非法（1–${MAX_MANAGER_TERM} 的整数）`);
  }
  if (payload.windowEndsAt !== undefined && !isTimestamp(payload.windowEndsAt)) {
    return refuse('manager-changed.windowEndsAt 非法（时间戳）');
  }
  if (payload.authorizedAt !== undefined && !isTimestamp(payload.authorizedAt)) {
    return refuse('manager-changed.authorizedAt 非法（时间戳）');
  }
  return null;
}

/* 按 via 的必备面：handover/auto 带 offerId；auto 带窗口结束时刻；takeover 带窗口基准与授权时刻；
 * takeover-manual 带授权时刻；端点除 initial 外必填（解除新旧站长端点互盲）。 */
function managerChangeViaRejection(payload) {
  const endpointIssue = managerChangeEndpointRejection(payload);
  if (endpointIssue !== null) {
    return endpointIssue;
  }
  const offerIssue = managerChangeOfferRejection(payload);
  if (offerIssue !== null) {
    return offerIssue;
  }
  const authorizationIssue = managerChangeAuthorizationRejection(payload);
  return authorizationIssue ?? { ok: true };
}

function managerChangeOfferRejection(payload) {
  if ((payload.via === 'handover' || payload.via === 'auto') && !isId(payload.offerId)) {
    return refuse('manager-changed.offerId 必填（handover / auto）');
  }
  if (payload.via === 'auto' && !isTimestamp(payload.windowEndsAt)) {
    return refuse('manager-changed.windowEndsAt 必填（auto）');
  }
  return null;
}

function managerChangeAuthorizationRejection(payload) {
  if (payload.via === 'takeover' && (!isManagerTerm(payload.windowBaseTerm) || !isTimestamp(payload.authorizedAt))) {
    return refuse('manager-changed 的 takeover 需 windowBaseTerm + authorizedAt');
  }
  if (payload.via === 'takeover-manual' && !isTimestamp(payload.authorizedAt)) {
    return refuse('manager-changed 的 takeover-manual 需 authorizedAt');
  }
  return null;
}

function managerChangeEndpointRejection(payload) {
  if (payload.endpoint === undefined && payload.via === 'initial') {
    return null;
  }
  if (!isPlainObject(payload.endpoint)) {
    return refuse('manager-changed.endpoint 必填（新站长端点）');
  }
  const checked = endpointEntryRejection(payload.endpoint, 'manager-changed.endpoint');
  return checked.ok ? null : checked;
}

/* 自动移交广播（原站长核发 offer 时）：接收侧按 offerId 暂存，A2 的 manager-changed 必须匹配。 */
function validateAutoOfferNotice(payload) {
  if (!isId(payload.offerId)) {
    return refuse('auto-offer.offerId 非法（1–64 位字母数字与连字符）');
  }
  if (!isSeatRef(payload.prevManager)) {
    return refuse('auto-offer.prevManager 非法（需 instanceId + sessionId）');
  }
  if (!isSeatRef(payload.target)) {
    return refuse('auto-offer.target 非法（需 instanceId + sessionId）');
  }
  if (!isManagerTerm(payload.baseTerm)) {
    return refuse(`auto-offer.baseTerm 非法（1–${MAX_MANAGER_TERM} 的整数）`);
  }
  if (!isVersion(payload.version)) {
    return refuse('auto-offer.version 非法（≥1 的整数）');
  }
  if (!isTimestamp(payload.expiresAt)) {
    return refuse('auto-offer.expiresAt 非法（时间戳）');
  }
  return { ok: true };
}

/* 端点形态底线在此（address 字符串 + 端口范围），地址的 IP 字面量语义由协作层在采用前复核
 * （协议层不引 node:net）。 */
function endpointEntryRejection(endpoint, label) {
  if (!isPlainObject(endpoint) || typeof endpoint.address !== 'string' || endpoint.address === '' || endpoint.address.length > 64) {
    return refuse(`${label} 非法（需 address 字符串，≤64 字符）`);
  }
  if (!isPort(endpoint.port)) {
    return refuse(`${label}.port 非法（1–65535 的整数）`);
  }
  return { ok: true };
}

/* 握手对表（设计 §2A.1/§7.1）：应答自己的 (managerTerm, version, manager, managerEndpoint?)；
 * manager 可为 null（无台账），managerEndpoint 随应答下发以解除端点互盲。takeover 为旧版兼容观测字段。 */
function validateHandshakeNotice(payload) {
  const baseIssue = handshakeBaseRejection(payload);
  if (baseIssue !== null) {
    return baseIssue;
  }
  const optionalIssue = handshakeOptionalRejection(payload);
  if (optionalIssue !== null) {
    return optionalIssue;
  }
  if (payload.reply !== true && payload.reply !== false) {
    return refuse('handshake.reply 非法（布尔）');
  }
  return { ok: true };
}

function handshakeBaseRejection(payload) {
  if (payload.role !== 'manager' && payload.role !== 'member') {
    return refuse('handshake.role 非法（manager / member）');
  }
  if (!isManagerTerm(payload.managerTerm)) {
    return refuse(`handshake.managerTerm 非法（1–${MAX_MANAGER_TERM} 的整数）`);
  }
  if (payload.version !== null && !isVersion(payload.version)) {
    return refuse('handshake.version 非法（null 或 ≥1 的整数）');
  }
  if (payload.manager !== null && !isSeatPeer(payload.manager)) {
    return refuse('handshake.manager 非法（null 或 instanceId + sessionId + identityName 的站长席位）');
  }
  return null;
}

function handshakeOptionalRejection(payload) {
  if (payload.managerEndpoint !== undefined) {
    const endpointIssue = endpointEntryRejection(payload.managerEndpoint, 'handshake.managerEndpoint');
    if (!endpointIssue.ok) {
      return endpointIssue;
    }
  }
  if (payload.takeover !== undefined && payload.takeover !== null && !isTakeoverRecord(payload.takeover)) {
    return refuse('handshake.takeover 非法（null 或抢接记录）');
  }
  return null;
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
  /* 合流并集的参考数据（站长席位检出时提供、成员侧检出缺省）：被冻条的发起时间与站长。 */
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

/* 移交（先确认后删除，设计 §2A.1/§2A.4）：offer 携带 offerId + 基准任期 + 台账/端点/过期时刻；
 * accept/reject 必须回指同一 offerId，防止无主回执破坏「先确认后删除」。 */
const HANDOVER_REJECT_REASONS = ['expired', 'version-changed', 'manager-changed', 'rejected'];

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
    return validateHandoverReject(payload);
  }
  return refuse('handover.kind 非法（offer / accept / reject）');
}

function validateHandoverOffer(payload) {
  if (!isId(payload.offerId)) {
    return refuse('handover.offerId 非法（1–64 位字母数字与连字符）');
  }
  if (!isManagerTerm(payload.baseTerm)) {
    return refuse(`handover.baseTerm 非法（1–${MAX_MANAGER_TERM} 的整数）`);
  }
  if (!isVersionedDigestPayload(payload)) {
    return refuse('handover.version / digest 非法（版本 ≥1 整数、摘要 64 位小写十六进制）');
  }
  if (!isPlainObject(payload.ledger)) {
    return refuse('handover.ledger 非法（须为台账对象）');
  }
  if (!isTimestamp(payload.expiresAt)) {
    return refuse('handover.expiresAt 非法（时间戳）');
  }
  /* 端点全表必填（设计 §2A.1）：受让方据此解除与老成员的端点互盲。 */
  return bundleEndpointsRejection(payload.endpoints, 'handover.endpoints') ?? { ok: true };
}

function validateHandoverAccept(payload) {
  if (!isId(payload.offerId)) {
    return refuse('handover.offerId 非法（1–64 位字母数字与连字符）');
  }
  if (!isManagerTerm(payload.baseTerm)) {
    return refuse(`handover.baseTerm 非法（1–${MAX_MANAGER_TERM} 的整数）`);
  }
  if (!isVersionedDigestPayload(payload)) {
    return refuse('handover.version / digest 非法（版本 ≥1 整数、摘要 64 位小写十六进制）');
  }
  /* confirm 为用户确认在线上帧的显式标记（可选）：存在则须为布尔，防字符串真值混入。 */
  if (payload.confirm !== undefined && typeof payload.confirm !== 'boolean') {
    return refuse('handover.confirm 非法（布尔）');
  }
  return { ok: true };
}

function validateHandoverReject(payload) {
  if (!isId(payload.offerId)) {
    return refuse('handover.offerId 非法（1–64 位字母数字与连字符）');
  }
  if (typeof payload.reason !== 'string' || !HANDOVER_REJECT_REASONS.includes(payload.reason)) {
    return refuse(`handover.reject.reason 非法（${HANDOVER_REJECT_REASONS.join(' / ')}）`);
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

/* 抢接生效通告（设计 §2A.6/§7.1；v4 下为兼容观测，不单独产生 term 变更）：
 * 窗口基准任期 + 新任期递增 + 恢复台账摘要 + 授权时刻；term 必须等于 windowBaseTerm+1。 */
function validateTakeoverPayload(payload) {
  if (!isPlainObject(payload)) {
    return refuse('takeover 缺少 payload');
  }
  const baseIssue = takeoverBaseRejection(payload);
  if (baseIssue !== null) {
    return baseIssue;
  }
  return validateReasonPayload(payload);
}

function takeoverBaseRejection(payload) {
  if (!isVersion(payload.baseVersion)) {
    return refuse('takeover.baseVersion 非法（≥1 的整数）');
  }
  if (!isManagerTerm(payload.windowBaseTerm) || !isManagerTerm(payload.term)) {
    return refuse(`takeover.windowBaseTerm / term 非法（1–${MAX_MANAGER_TERM} 的整数）`);
  }
  if (payload.term !== payload.windowBaseTerm + 1) {
    return refuse('takeover.term 须等于 windowBaseTerm + 1');
  }
  if (!isVersion(payload.version)) {
    return refuse('takeover.version 非法（≥1 的整数）');
  }
  if (!isTimestamp(payload.authorizedAt)) {
    return refuse('takeover.authorizedAt 非法（时间戳）');
  }
  if (typeof payload.digest !== 'string' || !DIGEST_PATTERN.test(payload.digest)) {
    return refuse('takeover.digest 非法（64 位小写十六进制）');
  }
  return null;
}

function isPeerShape(peer) {
  return isPlainObject(peer) && isId(peer.instanceId) && isIdentityName(peer.identityName);
}

/* 快照（设计 §2A.1/§7.1）：请求携本方 (managerTerm,version)，可带 catchup 目的；
 * 数据帧的台账必须与帧的 managerTerm/version/managerWindow/collabId 自洽——不一致按损坏拒收。 */
function validateSnapshotPayload(payload, frame) {
  if (!isPlainObject(payload)) {
    return refuse('snapshot 缺少 payload');
  }
  if (payload.purpose !== undefined && payload.purpose !== 'catchup') {
    return refuse('snapshot.purpose 非法（仅 catchup）');
  }
  if (payload.kind === 'request') {
    return snapshotRequestRejection(payload);
  }
  if (payload.kind !== 'data') {
    return refuse('snapshot.kind 非法（request / data）');
  }
  return snapshotDataRejection(payload, frame);
}

function snapshotRequestRejection(payload) {
  if (!isManagerTerm(payload.managerTerm)) {
    return refuse(`snapshot.managerTerm 非法（1–${MAX_MANAGER_TERM} 的整数）`);
  }
  if (!isVersion(payload.version)) {
    return refuse('snapshot.version 非法（≥1 的整数）');
  }
  return { ok: true };
}

function snapshotDataRejection(payload, frame) {
  if (!isManagerTerm(payload.managerTerm)) {
    return refuse(`snapshot.managerTerm 非法（1–${MAX_MANAGER_TERM} 的整数）`);
  }
  if (!isVersion(payload.version)) {
    return refuse('snapshot.version 非法（≥1 的整数）');
  }
  if (typeof payload.digest !== 'string' || !DIGEST_PATTERN.test(payload.digest)) {
    return refuse('snapshot.digest 非法（64 位小写十六进制）');
  }
  if (!isPlainObject(payload.ledger)) {
    return refuse('snapshot.ledger 非法（须为台账对象）');
  }
  if (payload.managerWindow !== undefined && !isManagerWindowShape(payload.managerWindow)) {
    return refuse('snapshot.managerWindow 非法（需 windowBaseTerm + windowEndsAt）');
  }
  return snapshotConsistencyRejection(payload, frame);
}

function snapshotConsistencyRejection(payload, frame) {
  const ledger = payload.ledger;
  if (ledger.managerTerm !== payload.managerTerm || ledger.version !== payload.version) {
    return refuse('snapshot 台账的 managerTerm / version 与帧不一致');
  }
  if (ledger.collabId !== undefined && ledger.collabId !== frame.collabId) {
    return refuse('snapshot 台账的 collabId 与帧不一致');
  }
  if (!sameManagerWindow(payload.managerWindow, ledger.managerWindow)) {
    return refuse('snapshot.managerWindow 与台账不一致（任一侧存在即须两侧一致）');
  }
  return { ok: true };
}

function isManagerWindowShape(value) {
  return isPlainObject(value) && isManagerTerm(value.windowBaseTerm) && isTimestamp(value.windowEndsAt);
}

function sameManagerWindow(left, right) {
  if (left === undefined && right === undefined) {
    return true;
  }
  if (!isPlainObject(left) || !isPlainObject(right)) {
    return false;
  }
  return left.windowBaseTerm === right.windowBaseTerm && left.windowEndsAt === right.windowEndsAt;
}

function refuse(reason) {
  return { ok: false, reason };
}
