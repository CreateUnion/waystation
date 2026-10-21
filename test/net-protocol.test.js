import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COLLAB_CAPABILITY,
  DELIVERY_EXEMPT_TYPES,
  DIGEST_PATTERN,
  GOVERNANCE_TYPES,
  ID_PATTERN,
  MAX_ACTIVE_SEATS,
  MAX_COLLAB_COUNT,
  MAX_COLLAB_MEMBERS,
  MAX_DATAGRAM_BYTES,
  MAX_FORUM_ACTIVE_SEATS,
  MAX_FRAME_BYTES,
  MAX_MANAGER_TERM,
  MAX_MESSAGE_TEXT_CHARS,
  MAX_TOPIC_CHARS,
  MESSAGE_TYPES,
  PARTICIPANTS_CAPABILITY,
  POST_KINDS,
  PROTOCOL_VERSION,
  TRANSPORT_TYPES,
  fitJoinResolveAck,
  isIdentityName,
  isParticipantsCapability,
  isPresentationText,
  newMsgId,
  parseFrame,
  supportsParticipants,
  withCollabCapability,
  withParticipantsCapability,
  validateJoinAck,
  validateJoinKnock,
  validateJoinResolve,
  validateJoinResolveAck,
  validateMessage,
  validateProbe,
  validateProbeAck,
} from '../src/net/protocol.js';

const SELF = { instanceId: '11111111-2222-4333-8444-555555555555', sessionId: 'sess-self', identityName: '主机甲' };
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function envelope(overrides = {}) {
  return {
    v: 1,
    msgId: newMsgId(),
    type: 'reply',
    from: SELF,
    collabId: 'collab-1',
    cap: 2,
    ts: new Date().toISOString(),
    payload: { text: '你好' },
    ...overrides,
  };
}

test('合法协作域消息：通过', () => {
  assert.equal(validateMessage(envelope()).ok, true);
});

test('消息根节点非对象（null / 数组 / 字符串 / 数字）：拒绝', () => {
  for (const bad of [null, ['x'], 'text', 42]) {
    const checked = validateMessage(bad);
    assert.equal(checked.ok, false, String(bad));
    assert.ok(checked.reason.includes('根节点'), String(bad));
  }
});

test('协议版本不匹配：拒绝', () => {
  const checked = validateMessage(envelope({ v: 2 }));
  assert.equal(checked.ok, false);
  assert.ok(checked.reason.includes('版本'));
});

test('未知消息类型 / 类型非字符串：拒绝', () => {
  assert.equal(validateMessage(envelope({ type: '命令下发' })).ok, false);
  assert.equal(validateMessage(envelope({ type: 42 })).ok, false);
});

test('msgId 非法（含路径穿越形态与超长）：拒绝', () => {
  for (const bad of ['../evil', 'a/b', 'a.b', '', 'x'.repeat(65), 123, null]) {
    assert.equal(validateMessage(envelope({ msgId: bad })).ok, false, String(bad));
  }
});

test('from 非法（缺失 / instanceId 非法 / 身份名空或超长）：拒绝', () => {
  assert.equal(validateMessage(envelope({ from: undefined })).ok, false);
  assert.equal(validateMessage(envelope({ from: { instanceId: 'a b', identityName: '甲' } })).ok, false);
  assert.equal(validateMessage(envelope({ from: { instanceId: SELF.instanceId, identityName: '   ' } })).ok, false);
  assert.equal(validateMessage(envelope({ from: { instanceId: SELF.instanceId, identityName: 'x'.repeat(65) } })).ok, false);
});

test('ts 非法（不可解析 / 非字符串）：拒绝', () => {
  assert.equal(validateMessage(envelope({ ts: '昨天' })).ok, false);
  assert.equal(validateMessage(envelope({ ts: 123 })).ok, false);
});

test('协作域消息缺 collabId：拒绝；传输类不带 collabId：通过', () => {
  assert.equal(validateMessage(envelope({ collabId: undefined })).ok, false);
  assert.equal(validateMessage(envelope({ type: 'ping', collabId: undefined, payload: undefined })).ok, true);
  assert.equal(validateMessage(envelope({ type: 'ack', ackFor: newMsgId(), collabId: undefined, payload: undefined })).ok, true);
});

test('pong：缺 replyTo 拒绝、带合法 replyTo 通过', () => {
  const base = { type: 'pong', collabId: undefined, payload: undefined };
  assert.equal(validateMessage(envelope(base)).ok, false);
  assert.equal(validateMessage(envelope({ ...base, replyTo: newMsgId() })).ok, true);
});

test('ack：缺 ackFor 拒绝、带合法 ackFor 通过', () => {
  const base = { type: 'ack', collabId: undefined, payload: undefined };
  assert.equal(validateMessage(envelope(base)).ok, false);
  assert.equal(validateMessage(envelope({ ...base, ackFor: newMsgId() })).ok, true);
});

test('delivery-status：载荷缺失 / refMsgId 非法 / tier 非 session 拒绝；合法通过', () => {
  const refMsgId = newMsgId();
  const base = { type: 'delivery-status' };
  assert.equal(validateMessage(envelope({ ...base, payload: undefined })).ok, false);
  assert.equal(validateMessage(envelope({ ...base, payload: { refMsgId: '../x', tier: 'session' } })).ok, false);
  assert.equal(validateMessage(envelope({ ...base, payload: { refMsgId, tier: 'at-peer' } })).ok, false);
  assert.equal(validateMessage(envelope({ ...base, payload: { refMsgId, tier: 'session' } })).ok, true);
});

test('payload 非对象（数组 / 字符串）：拒绝', () => {
  assert.equal(validateMessage(envelope({ payload: ['x'] })).ok, false);
  assert.equal(validateMessage(envelope({ payload: 'text' })).ok, false);
});

test('未知顶层字段：通过（前后版本并存的前向兼容）', () => {
  assert.equal(validateMessage(envelope({ futureField: { enabled: true } })).ok, true);
});

test('parseFrame：非法 JSON / 非对象 / 合法帧', () => {
  assert.equal(parseFrame('{oops').ok, false);
  assert.equal(parseFrame('null').ok, false);
  assert.equal(parseFrame('[1,2]').ok, false);
  assert.equal(parseFrame(JSON.stringify(envelope())).ok, true);
  const parsed = parseFrame(JSON.stringify(envelope()));
  assert.equal(parsed.frame.type, 'reply');
});

test('parseFrame：入参非字符串（消费方误传 Buffer）：拒绝', () => {
  for (const bad of [null, 42, Buffer.from('{}')]) {
    const checked = parseFrame(bad);
    assert.equal(checked.ok, false, String(bad));
    assert.ok(checked.reason.includes('文本'), String(bad));
  }
});

test('parseFrame：合法 JSON 但信封非法：拒绝并带回原因', () => {
  const checked = parseFrame(JSON.stringify(envelope({ v: 2 })));
  assert.equal(checked.ok, false);
  assert.ok(checked.reason.includes('版本'));
});

test('发现报文：探测/应答校验（含 collabCount 数值范围）', () => {
  const probe = { v: PROTOCOL_VERSION, type: 'probe', instanceId: SELF.instanceId, identityName: '主机甲' };
  assert.equal(validateProbe(probe).ok, true);
  assert.equal(validateProbe({ ...probe, v: 2 }).ok, false);
  assert.equal(validateProbe({ ...probe, instanceId: '../x' }).ok, false);
  assert.equal(validateProbe({ ...probe, identityName: '' }).ok, false);
  const ack = { ...probe, type: 'probe-ack', collabCount: 0 };
  assert.equal(validateProbeAck(ack).ok, true);
  assert.equal(validateProbeAck({ ...ack, collabCount: -1 }).ok, false);
  assert.equal(validateProbeAck({ ...ack, collabCount: 1.5 }).ok, false);
  assert.equal(validateProbeAck({ ...ack, collabCount: MAX_COLLAB_COUNT + 1 }).ok, false);
  assert.equal(validateProbeAck({ ...ack, collabCount: undefined }).ok, false);
});

test('发现面 participants 能力字段 helper：2 为支持、缺字段为不支持、加法构造不改旧字段', () => {
  assert.equal(PARTICIPANTS_CAPABILITY, 2);
  assert.equal(isParticipantsCapability(2), true);
  assert.equal(isParticipantsCapability(undefined), false);
  assert.equal(isParticipantsCapability(1), false);
  assert.equal(isParticipantsCapability('2'), false);
  assert.equal(supportsParticipants({ participants: 2 }), true);
  assert.equal(supportsParticipants({}), false, '响应缺字段＝旧版不支持');
  assert.equal(supportsParticipants(null), false);
  const ack = withParticipantsCapability({ v: 1, type: 'probe-ack', instanceId: 'inst-a', identityName: '主机甲', collabCount: 0 });
  assert.equal(ack.participants, 2);
  assert.equal(ack.type, 'probe-ack');
  assert.equal(validateProbeAck(ack).ok, true, '加法字段不影响发现层校验');
});

test('发现报文根节点非对象（null / 字符串）：validateProbe / validateProbeAck 拒绝', () => {
  assert.equal(validateProbe(null).ok, false);
  assert.equal(validateProbeAck('text').ok, false);
});

test('发现报文类型不匹配（探测/应答互收）：拒绝', () => {
  const ackShape = { v: PROTOCOL_VERSION, type: 'probe-ack', instanceId: SELF.instanceId, identityName: '主机甲' };
  assert.equal(validateProbe(ackShape).ok, false);
  assert.equal(validateProbeAck({ ...ackShape, type: 'probe' }).ok, false);
});

test('常量：版本、类型集（会话级两型）、治理集、传输集、能力与上限', () => {
  assert.equal(PROTOCOL_VERSION, 1);
  assert.equal(COLLAB_CAPABILITY, 2);
  assert.equal(MESSAGE_TYPES.length, 33);
  for (const type of ['invite', 'approve', 'decline', 'withdraw', 'topic', 'task', 'progress', 'issue', 'stop', 'reply', 'freeze', 'unfreeze', 'decision', 'handover', 'takeover-init', 'takeover', 'notice', 'leave', 'end', 'ping', 'pong', 'delivery-status', 'snapshot', 'post', 'join', 'join-request', 'join-grant', 'join-deny', 'join-confirm', 'seat-presence', 'history-request', 'history-bundle', 'ack']) {
    assert.ok(MESSAGE_TYPES.includes(type), type);
  }
  assert.deepEqual(GOVERNANCE_TYPES, ['freeze', 'unfreeze', 'decision', 'takeover-init', 'takeover']);
  assert.deepEqual(TRANSPORT_TYPES, ['ping', 'pong', 'ack']);
  assert.deepEqual(POST_KINDS, ['topic', 'task', 'progress', 'issue', 'stop', 'reply']);
  assert.equal(MAX_ACTIVE_SEATS, 32);
  assert.equal(MAX_FORUM_ACTIVE_SEATS, 16);
  assert.equal(MAX_COLLAB_MEMBERS, MAX_ACTIVE_SEATS, '退役名保留为别名（既有模块仍引用）');
  assert.equal(MAX_MANAGER_TERM, 2147483647);
  assert.equal(MAX_FRAME_BYTES, 1048576);
  assert.equal(MAX_DATAGRAM_BYTES, 512);
  assert.equal(ID_PATTERN.test('../x'), false);
  assert.equal(ID_PATTERN.test('a/b'), false);
});

test('能力闸门：协作域帧须 cap=2；缺失 / 低版本 / 非法值拒收并给明确 reason', () => {
  assert.equal(validateMessage(envelope()).ok, true);
  for (const cap of [undefined, 1, 3, '2', null]) {
    const checked = validateMessage(envelope({ cap }));
    assert.equal(checked.ok, false, String(cap));
    assert.ok(checked.reason.includes('cap'), checked.reason);
  }
  assert.ok(validateMessage(envelope({ cap: undefined })).reason.includes('0.2.0'), '提示需 0.2.0+');
});

test('能力闸门：transport 帧（ping / pong / ack）豁免 cap', () => {
  assert.equal(validateMessage(envelope({ type: 'ping', collabId: undefined, cap: undefined })).ok, true);
  assert.equal(validateMessage(envelope({ type: 'pong', collabId: undefined, replyTo: newMsgId(), cap: undefined })).ok, true);
  assert.equal(validateMessage(envelope({ type: 'ack', collabId: undefined, ackFor: newMsgId(), cap: undefined })).ok, true);
});

test('出站 helper withCollabCapability：frameOf 同形帧（无 cap）过预检，纯函数不改入参', () => {
  const frameOfShape = {
    v: 1,
    msgId: 'msg-1',
    type: 'reply',
    from: { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '主机甲', port: 7321 },
    collabId: 'collab-1',
    ts: new Date().toISOString(),
    payload: { text: '你好' },
  };
  assert.equal(validateMessage(frameOfShape).ok, false, '未加 cap 的出站帧被自家预检拒绝');
  const wire = withCollabCapability(frameOfShape);
  assert.equal(wire.cap, COLLAB_CAPABILITY);
  assert.equal(validateMessage(wire).ok, true);
  assert.equal(frameOfShape.cap, undefined, '不得修改入参');
});

test('from.sessionId：协作域帧必填且合法；transport 帧可缺省、出现则须合法', () => {
  const missing = frameWith({ from: { instanceId: 'inst-a', identityName: '主机甲' } });
  assert.equal(validateMessage(missing).ok, false);
  assert.ok(validateMessage(missing).reason.includes('from.sessionId'));
  const illegal = frameWith({ from: { instanceId: 'inst-a', sessionId: '../evil', identityName: '主机甲' } });
  assert.equal(validateMessage(illegal).ok, false);
  assert.equal(validateMessage(frameWith({ type: 'ping', collabId: undefined, from: { instanceId: 'inst-a', identityName: '主机甲' } })).ok, true);
  assert.equal(validateMessage(frameWith({ type: 'ack', collabId: undefined, ackFor: newMsgId(), from: { instanceId: 'inst-a', identityName: '主机甲' } })).ok, true);
  assert.equal(validateMessage(frameWith({ type: 'ping', collabId: undefined, from: { instanceId: 'inst-a', sessionId: 'bad id!', identityName: '主机甲' } })).ok, false);
  assert.equal(validateMessage(frameWith({ type: 'ping', collabId: undefined, from: { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '主机甲' } })).ok, true);
});

test('投递豁免集：治理五型 + 讨论 end/join/leave；拉取两件套不泛化豁免', () => {
  assert.deepEqual(DELIVERY_EXEMPT_TYPES, ['freeze', 'unfreeze', 'decision', 'takeover-init', 'takeover', 'end', 'join', 'leave']);
  assert.equal(DELIVERY_EXEMPT_TYPES.includes('history-request'), false, '短生命周期请求-应答不豁免');
  assert.equal(DELIVERY_EXEMPT_TYPES.includes('history-bundle'), false);
});

test('newMsgId：UUID 形态且互不相同', () => {
  const first = newMsgId();
  const second = newMsgId();
  assert.match(first, UUID_PATTERN);
  assert.notEqual(first, second);
});

/* 供 from.port / identityName 用例复用的合法帧骨架（校验器逐段检查，改动任一字段都会落到对应分支）。 */
function frameWith(overrides = {}) {
  return {
    v: 1,
    msgId: 'msg-1',
    type: 'reply',
    from: { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '主机甲' },
    collabId: 'collab-1',
    cap: 2,
    ts: new Date().toISOString(),
    payload: { text: '你好' },
    ...overrides,
  };
}

test('from.port：合法整数通过、缺失通过（构造侧必填、入站侧容忍缺省）', () => {
  assert.equal(validateMessage(frameWith({ from: { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '主机甲', port: 7321 } })).ok, true);
  assert.equal(validateMessage(frameWith()).ok, true);
  assert.equal(validateMessage(frameWith({ from: { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '主机甲', port: 65535 } })).ok, true);
});

test('from.port：非法值拒收（0 / 65536 / 字符串 / 小数）', () => {
  for (const port of [0, 65536, '7321', 1.5, -1]) {
    const checked = validateMessage(frameWith({ from: { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '主机甲', port } }));
    assert.equal(checked.ok, false, String(port));
    assert.ok(checked.reason.includes('from.port'), checked.reason);
  }
});

test('probe-ack port：存在则校验、缺失回退来源端口（宽容缺省）', () => {
  const base = { v: 1, type: 'probe-ack', instanceId: 'inst-b', identityName: '主机乙', collabCount: 0 };
  assert.equal(validateProbeAck(base).ok, true, '缺 port 是合法形态（旧实现应答）');
  assert.equal(validateProbeAck({ ...base, port: 7331 }).ok, true);
});

test('probe-ack port：存在但非法拒收（0 / 超界 / 字符串）', () => {
  const base = { v: 1, type: 'probe-ack', instanceId: 'inst-b', identityName: '主机乙', collabCount: 0 };
  for (const port of [0, 65536, '7331', 1.5]) {
    const checked = validateProbeAck({ ...base, port });
    assert.equal(checked.ok, false, String(port));
    assert.ok(checked.reason.includes('port'), checked.reason);
  }
});

test('identityName 白名单：控制字符 / 不可见格式（含 ZWJ）/ 行段分隔符一律拒收（协议入站）', () => {
  const refused = ['甲\n乙', '甲\t乙', '甲\u0007', '甲\u200b乙', '甲\u202eb', '甲\u2028乙', '甲\u2029乙', '👨\u200d👩'];
  for (const identityName of refused) {
    assert.equal(validateProbe({ v: 1, type: 'probe', instanceId: 'inst-a', identityName }).ok, false, JSON.stringify(identityName));
    assert.equal(validateMessage(frameWith({ from: { instanceId: 'inst-a', identityName } })).ok, false, JSON.stringify(identityName));
  }
});

test('identityName 白名单：中文、单码位 emoji、可见符号与内部空格通过', () => {
  for (const identityName of ['主机甲', '工位 🚀 三号', 'dev-box_A', '甲 乙']) {
    assert.equal(validateProbe({ v: 1, type: 'probe', instanceId: 'inst-a', identityName }).ok, true, identityName);
  }
});

test('isIdentityName 边界：空串 / 仅空白 / 65 字符拒收，64 字符通过', () => {
  assert.equal(isIdentityName(''), false);
  assert.equal(isIdentityName('   '), false);
  assert.equal(isIdentityName('x'.repeat(65)), false);
  assert.equal(isIdentityName('x'.repeat(64)), true);
  assert.equal(isIdentityName(42), false);
});

/* 协作域载荷校验用例：骨架沿用既有 frameWith，payload 按类型注入。 */
function collabFrame(type, payload) {
  return frameWith({ type, payload });
}

/* 席位条目（invite / freeze / unfreeze / decision 名单共用）：instanceId + sessionId + identityName。 */
function seatOf(instanceId, sessionId, identityName) {
  return { instanceId, sessionId, identityName };
}

const SEAT_A = seatOf('inst-a', 'sess-a', '主机甲');
const SEAT_B = seatOf('inst-b', 'sess-b', '主机乙');

test('协作域 invite：合法通过（中文名、主题、席位名单 2 项 + targets）', () => {
  assert.equal(validateMessage(collabFrame('invite', {
    name: '联调项目',
    topic: '发布联调',
    members: [SEAT_A, SEAT_B],
    targets: [{ instanceId: 'inst-b' }],
  })).ok, true);
});

test('协作域 invite：mode 可选（缺省 = managed 旧行为）、词表内通过、词表外拒', () => {
  const base = { name: '项目', topic: '主题', members: [SEAT_A, SEAT_B] };
  assert.equal(validateMessage(collabFrame('invite', base)).ok, true, '缺 mode（旧版对端）通过');
  assert.equal(validateMessage(collabFrame('invite', { ...base, mode: 'managed' })).ok, true);
  assert.equal(validateMessage(collabFrame('invite', { ...base, mode: 'forum' })).ok, true);
  for (const mode of ['discussion', '', 42, null]) {
    const checked = validateMessage(collabFrame('invite', { ...base, mode }));
    assert.equal(checked.ok, false, String(mode));
    assert.ok(checked.reason.includes('invite.mode'), checked.reason);
  }
});

test('协作域 invite：name 非法逐拒（控制字符 / 超 64 字符 / 空串 / 缺字段）', () => {
  const members = [SEAT_A, SEAT_B];
  for (const name of ['甲\n乙', 'x'.repeat(65), '', undefined]) {
    assert.equal(validateMessage(collabFrame('invite', { name, topic: '主题', members })).ok, false, String(name));
  }
});

test('协作域 invite：topic 非法逐拒（201 字符 / 零宽字符 / 缺字段）', () => {
  const members = [SEAT_A, SEAT_B];
  for (const topic of ['x'.repeat(201), '主\u200b题', undefined]) {
    assert.equal(validateMessage(collabFrame('invite', { name: '项目', topic, members })).ok, false, String(topic));
  }
});

test('协作域 invite：members 为席位条目——下界 1、上界 32、同实例多会话可并存', () => {
  const many = Array.from({ length: 33 }, (raw, index) => seatOf(`inst-${index}`, `sess-${index}`, `主机-${index}`));
  const sameMachine = [SEAT_A, seatOf('inst-a', 'sess-a2', '主机甲')];
  assert.equal(validateMessage(collabFrame('invite', { name: '项目', topic: '主题', members: [SEAT_A] })).ok, true, '只须含发起人');
  assert.equal(validateMessage(collabFrame('invite', { name: '项目', topic: '主题', members: sameMachine })).ok, true);
  assert.equal(validateMessage(collabFrame('invite', { name: '项目', topic: '主题', members: many.slice(0, 32) })).ok, true);
  for (const members of [[], many, 'not-an-array']) {
    assert.equal(validateMessage(collabFrame('invite', { name: '项目', topic: '主题', members })).ok, false, JSON.stringify(members).slice(0, 40));
  }
  assert.equal(MAX_COLLAB_MEMBERS, 32);
});

test('协作域 invite：members 重复席位键 / 条目缺 sessionId 或 identityName 拒', () => {
  const cases = [
    [SEAT_A, SEAT_A],
    [SEAT_A, { instanceId: 'inst-a', identityName: '主机甲' }],
    [SEAT_A, { instanceId: 'inst-a', sessionId: 'sess-a2' }],
    [SEAT_A, { instanceId: '../x', sessionId: 'sess-b', identityName: '乙' }],
    [SEAT_A, { instanceId: 'inst-b', sessionId: 'bad id!', identityName: '乙' }],
  ];
  for (const members of cases) {
    assert.equal(validateMessage(collabFrame('invite', { name: '项目', topic: '主题', members })).ok, false, JSON.stringify(members).slice(0, 60));
  }
});

test('协作域 invite：targets 可选；唯一性键 (instanceId,targetSessionId ?? \'\')、条目形态受检', () => {
  const base = { name: '项目', topic: '主题', members: [SEAT_A] };
  assert.equal(validateMessage(collabFrame('invite', base)).ok, true, 'targets 缺省合法');
  assert.equal(validateMessage(collabFrame('invite', { ...base, targets: [{ instanceId: 'inst-b' }, { instanceId: 'inst-b', targetSessionId: 'sess-b' }] })).ok, true);
  const many = Array.from({ length: 32 }, (raw, index) => ({ instanceId: `inst-${index}` }));
  assert.equal(validateMessage(collabFrame('invite', { ...base, targets: many })).ok, true, '32 项上限内');
  assert.equal(validateMessage(collabFrame('invite', { ...base, targets: [...many, { instanceId: 'inst-extra' }] })).ok, false, '33 项拒绝');
  const bad = [
    [],
    [{ instanceId: 'inst-b' }, { instanceId: 'inst-b' }],
    [{ targetSessionId: 'sess-b' }],
    [{ instanceId: 'inst-b', targetSessionId: 'bad id!' }],
    'x',
  ];
  for (const targets of bad) {
    assert.equal(validateMessage(collabFrame('invite', { ...base, targets })).ok, false, JSON.stringify(targets).slice(0, 60));
  }
});

test('协作域 approve / end / leave：payload 省略或空对象通过、非对象拒', () => {
  assert.equal(validateMessage(frameWith({ type: 'approve' })).ok, true);
  assert.equal(validateMessage(collabFrame('approve', {})).ok, true);
  assert.equal(validateMessage(collabFrame('end', {})).ok, true);
  assert.equal(validateMessage(frameWith({ type: 'leave' })).ok, true);
  assert.equal(validateMessage(collabFrame('approve', [])).ok, false);
  assert.equal(validateMessage(collabFrame('end', 'x')).ok, false);
});

test('协作域 decline / stop：reason 可选（合法通过 / 超长拒 / 非对象拒）', () => {
  assert.equal(validateMessage(frameWith({ type: 'decline' })).ok, true);
  assert.equal(validateMessage(collabFrame('decline', { reason: '人手不足' })).ok, true);
  assert.equal(validateMessage(collabFrame('stop', { reason: 'x'.repeat(201) })).ok, false);
  assert.equal(validateMessage(collabFrame('decline', { reason: '带\u0007控制符' })).ok, false);
});

test('协作域 withdraw：scope 必填且枚举、reason 可选', () => {
  assert.equal(validateMessage(collabFrame('withdraw', { scope: 'single' })).ok, true);
  assert.equal(validateMessage(collabFrame('withdraw', { scope: 'all', reason: '项目取消' })).ok, true);
  for (const payload of [undefined, {}, { scope: 'both' }, { scope: 'all', reason: 'x'.repeat(201) }]) {
    assert.equal(validateMessage(collabFrame('withdraw', payload)).ok, false, JSON.stringify(payload));
  }
});

test('协作域 topic / task：topic.text 呈现文本上限 200、task.taskId 形态', () => {
  assert.equal(validateMessage(collabFrame('topic', { text: 'x'.repeat(200) })).ok, true);
  assert.equal(validateMessage(collabFrame('topic', { text: 'x'.repeat(201) })).ok, false);
  assert.equal(validateMessage(collabFrame('task', { taskId: 'task-1', text: '请执行' })).ok, true);
  assert.equal(validateMessage(collabFrame('task', { taskId: 'bad id!', text: 'x' })).ok, false);
});

test('协作域 progress / issue / reply：正文判据（缺失拒 / 4001 拒 / 4000 与换行通过 / taskId 可选）', () => {
  assert.equal(validateMessage(collabFrame('progress', { text: '过', taskId: 'task-1' })).ok, true);
  assert.equal(validateMessage(collabFrame('progress', { text: '过' })).ok, true);
  assert.equal(validateMessage(collabFrame('progress', { text: '过', taskId: 'bad id!' })).ok, false);
  assert.equal(validateMessage(collabFrame('progress', {})).ok, false);
  assert.equal(validateMessage(collabFrame('issue', { text: '第一行\n第二行' })).ok, true);
  assert.equal(validateMessage(collabFrame('reply', { text: 'x'.repeat(4000) })).ok, true);
  assert.equal(validateMessage(collabFrame('reply', { text: 'x'.repeat(4001) })).ok, false);
  assert.equal(MAX_TOPIC_CHARS, 200);
});

test('协作域 post：帖形态判据（并集形态在协议层、kind 词表归属协作层）', () => {
  const post = { postId: 'post-1', seq: 1, kind: 'reply', text: '你好' };
  assert.equal(validateMessage(collabFrame('post', { post })).ok, true);
  assert.equal(validateMessage(collabFrame('post', { post: { ...post, kind: 'topic', text: 'x'.repeat(MAX_MESSAGE_TEXT_CHARS) } })).ok, true, 'text 沿消息文本上限（不与 topic 的 200 呈现限制挂钩）');
  assert.equal(validateMessage(collabFrame('post', { post: { ...post, text: '第一行\n第二行' } })).ok, true, '正文面允许换行（与既有消息正文同判据）');
  assert.equal(validateMessage(collabFrame('post', {})).ok, false, '缺 payload.post');
  assert.equal(validateMessage(collabFrame('post', { post: { ...post, postId: 'bad id!' } })).ok, false);
  assert.equal(validateMessage(collabFrame('post', { post: { ...post, seq: 0 } })).ok, false);
  assert.equal(validateMessage(collabFrame('post', { post: { ...post, seq: 1.5 } })).ok, false);
  assert.equal(validateMessage(collabFrame('post', { post: { ...post, seq: '1' } })).ok, false);
  assert.equal(validateMessage(collabFrame('post', { post: { ...post, kind: 7 } })).ok, false);
  assert.equal(validateMessage(collabFrame('post', { post: { ...post, text: '' } })).ok, false);
  assert.equal(validateMessage(collabFrame('post', { post: { ...post, text: 'x'.repeat(4001) } })).ok, false);
  assert.equal(validateMessage(collabFrame('post', { post: { ...post, seq: undefined } })).ok, false, '序号必填（随帖携带）');
  assert.equal(validateMessage(collabFrame('post', { post: { ...post, kind: '飘' } })).ok, true, '词表越界的 kind 由协作层判定（协议层只判并集形态）');
});

test('协作域 join / leave（讨论成员事件）：事件 id 与事件时刻成对必填；leave 兼容既有空载荷', () => {
  const stamp = { eventId: 'evt-1', ts: new Date().toISOString() };
  assert.equal(validateMessage(collabFrame('join', stamp)).ok, true);
  assert.equal(validateMessage(collabFrame('join', { eventId: 'evt-1' })).ok, false, '缺事件时刻');
  assert.equal(validateMessage(collabFrame('join', { ts: stamp.ts })).ok, false, '缺事件 id');
  assert.equal(validateMessage(collabFrame('join', { ...stamp, eventId: 'bad id!' })).ok, false);
  assert.equal(validateMessage(collabFrame('join', { ...stamp, ts: '昨天' })).ok, false);
  assert.equal(validateMessage(collabFrame('leave', stamp)).ok, true, 'leave 可携成员事件字段（讨论）');
  assert.equal(validateMessage(collabFrame('leave', {})).ok, true, 'managed 的空载荷照旧');
  assert.equal(validateMessage(collabFrame('leave', undefined)).ok, true);
  assert.equal(validateMessage(collabFrame('leave', { eventId: 'evt-1' })).ok, false, 'eventId 与 ts 须成对');
  assert.equal(validateMessage(collabFrame('leave', { ...stamp, reason: '退出' })).ok, true);
});

/* 会话主动加入四帧（会话级参与者设计 §4.4）：申请 / 批准 / 拒绝 / 确认——协作域帧，标识字段过 ID 判据。 */

test('协作域 join-request：sessionId 必携且合法（缺 payload / 非对象 / 非标识逐项拒）', () => {
  assert.equal(validateMessage(collabFrame('join-request', { sessionId: 'sess-1' })).ok, true);
  for (const sessionId of [undefined, '../x', 'a/b', 'a.b', '', 'x'.repeat(65), 42, null]) {
    const checked = validateMessage(collabFrame('join-request', { sessionId }));
    assert.equal(checked.ok, false, String(sessionId));
    assert.ok(checked.reason.includes('join-request.sessionId'), checked.reason);
  }
  assert.equal(validateMessage(collabFrame('join-request', undefined)).ok, false, '缺 payload');
  assert.equal(validateMessage(collabFrame('join-request', [])).ok, false, 'payload 须为 JSON 对象');
});

function joinGrantOf(overrides = {}) {
  return {
    joinId: 'join-1',
    sessionId: 'sess-1',
    manager: { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '主机甲' },
    managerTerm: 1,
    version: 2,
    ...overrides,
  };
}

test('协作域 join-grant：joinId / manager / managerTerm / version 必携，term 1..2^31−1', () => {
  assert.equal(validateMessage(collabFrame('join-grant', joinGrantOf())).ok, true);
  for (const joinId of [undefined, '../x', 42]) {
    const checked = validateMessage(collabFrame('join-grant', joinGrantOf({ joinId })));
    assert.equal(checked.ok, false, String(joinId));
    assert.ok(checked.reason.includes('join-grant.joinId'), checked.reason);
  }
  assert.equal(validateMessage(collabFrame('join-grant', joinGrantOf({ manager: { instanceId: 'inst-a', identityName: '甲' } }))).ok, false, 'manager 需席位身份');
  assert.equal(validateMessage(collabFrame('join-grant', joinGrantOf({ managerTerm: 0 }))).ok, false);
  assert.equal(validateMessage(collabFrame('join-grant', joinGrantOf({ managerTerm: 2147483648 }))).ok, false);
  assert.equal(validateMessage(collabFrame('join-grant', joinGrantOf({ version: 0 }))).ok, false);
  assert.equal(validateMessage(collabFrame('join-grant', {})).ok, false);
});

test('协作域 join-deny：joinId 必携、reason 枚举（expired / aborted / manager-changed / capacity）', () => {
  assert.equal(validateMessage(collabFrame('join-deny', { joinId: 'join-1', reason: 'expired' })).ok, true);
  assert.equal(validateMessage(collabFrame('join-deny', { joinId: 'join-1', reason: 'aborted', managerTerm: 2 })).ok, true);
  assert.equal(validateMessage(collabFrame('join-deny', { joinId: 'join-1' })).ok, false, 'reason 必填');
  assert.equal(validateMessage(collabFrame('join-deny', { joinId: 'bad id!', reason: 'expired' })).ok, false);
  assert.equal(validateMessage(collabFrame('join-deny', { joinId: 'join-1', reason: 'later' })).ok, false);
  assert.equal(validateMessage(collabFrame('join-deny', { joinId: 'join-1', reason: 'expired', managerTerm: 0 })).ok, false);
});

test('协作域 join-confirm：joinId + managerTerm + version 必携（两段式确认）', () => {
  assert.equal(validateMessage(collabFrame('join-confirm', { joinId: 'join-1', managerTerm: 1, version: 2 })).ok, true);
  assert.equal(validateMessage(collabFrame('join-confirm', { managerTerm: 1, version: 2 })).ok, false);
  assert.equal(validateMessage(collabFrame('join-confirm', { joinId: 'bad id!', managerTerm: 1, version: 2 })).ok, false);
  assert.equal(validateMessage(collabFrame('join-confirm', { joinId: 'join-1', managerTerm: 0, version: 2 })).ok, false);
  assert.equal(validateMessage(collabFrame('join-confirm', { joinId: 'join-1', managerTerm: 1 })).ok, false);
});

test('协作域 seat-presence：instanceId / sessions 列表 / sentAt 必携；与帧 collabId/from 一致', () => {
  const legal = { collabId: 'collab-1', instanceId: 'inst-a', sessions: ['sess-a', 'sess-a2'], sentAt: new Date().toISOString() };
  assert.equal(validateMessage(collabFrame('seat-presence', legal)).ok, true);
  assert.equal(validateMessage(collabFrame('seat-presence', { ...legal, sessions: Array.from({ length: 32 }, (raw, index) => `sess-${index}`) })).ok, true, '32 席上限内');
  const bad = [
    { ...legal, instanceId: undefined },
    { ...legal, instanceId: 'inst-b' },
    { ...legal, collabId: 'collab-2' },
    { ...legal, sessions: [] },
    { ...legal, sessions: 'sess-a' },
    { ...legal, sessions: ['bad id!'] },
    { ...legal, sessions: ['sess-a', 'sess-a'] },
    { ...legal, sessions: Array.from({ length: 33 }, (raw, index) => `sess-${index}`) },
    { ...legal, sentAt: '昨天' },
  ];
  for (const payload of bad) {
    assert.equal(validateMessage(collabFrame('seat-presence', payload)).ok, false, JSON.stringify(payload).slice(0, 60));
  }
});

test('协作域加入四帧：属协作域必须携 collabId（缺 collabId 拒）', () => {
  const cases = [
    ['join-request', { sessionId: 'sess-1' }],
    ['join-grant', joinGrantOf()],
    ['join-deny', { joinId: 'join-1', reason: 'expired' }],
    ['join-confirm', { joinId: 'join-1', managerTerm: 1, version: 2 }],
  ];
  for (const [type, payload] of cases) {
    assert.equal(validateMessage(collabFrame(type, payload)).ok, true, type);
    const checked = validateMessage(frameWith({ type, collabId: undefined, payload }));
    assert.equal(checked.ok, false, type);
    assert.ok(checked.reason.includes('collabId'), checked.reason);
    assert.equal(TRANSPORT_TYPES.includes(type), false, type);
  }
});

test('协作域 history-request：after 与 summary 均为可选加法字段（空载荷 = 全量拉取）', () => {
  const cursor = { ts: new Date().toISOString(), postId: 'post-1' };
  const summary = { authors: [{ instanceId: 'inst-a', count: 3, seqs: [[1, 2], [4, 4]] }] };
  assert.equal(validateMessage(collabFrame('history-request', {})).ok, true);
  assert.equal(validateMessage(collabFrame('history-request', { after: cursor })).ok, true);
  assert.equal(validateMessage(collabFrame('history-request', { after: null, summary })).ok, true);
  assert.equal(validateMessage(collabFrame('history-request', { after: { ts: cursor.ts } })).ok, false, '游标缺 postId');
  assert.equal(validateMessage(collabFrame('history-request', { after: { ts: '昨天', postId: 'post-1' } })).ok, false);
  assert.equal(validateMessage(collabFrame('history-request', { after: 'post-1' })).ok, false);
  for (const bad of [
    {},
    { authors: 'x' },
    { authors: [{ instanceId: 'inst-a', count: 0, seqs: [[1, 1]] }] },
    { authors: [{ instanceId: 'inst-a', count: 1, seqs: [] }] },
    { authors: [{ instanceId: 'inst-a', count: 2, seqs: [[2, 1]] }] },
    { authors: [{ instanceId: 'inst-a', count: 2, seqs: [[1, 2], [2, 3]] }] },
    { authors: [{ instanceId: 'inst-a', count: 2, seqs: [[1, 1], [0, 0]] }] },
  ]) {
    assert.equal(validateMessage(collabFrame('history-request', { summary: bad })).ok, false, JSON.stringify(bad).slice(0, 60));
  }
});

test('协作域 history-bundle：交换面与尾部面逐字段校验（more=true 必须带续拉游标）', () => {
  const post = { from: { instanceId: 'inst-a', identityName: '主机甲' }, postId: 'post-1', seq: 1, ts: new Date().toISOString(), kind: 'reply', text: '你好' };
  const cursor = { ts: new Date().toISOString(), postId: 'post-1' };
  const legal = {
    cursor,
    summary: { authors: [{ instanceId: 'inst-a', count: 1, seqs: [[1, 1]] }] },
    more: false,
    posts: [post],
    overlap: [post],
    meta: { state: 'active', name: '讨论甲', topic: '议题', createdAt: post.ts, establishedAt: post.ts, endedAt: undefined },
    members: [{ eventId: 'evt-1', kind: 'join', instanceId: 'inst-a', identityName: '主机甲', ts: post.ts }],
    endpoints: { 'inst-a': { address: '127.0.0.1', port: 7321 } },
  };
  assert.equal(validateMessage(collabFrame('history-bundle', legal)).ok, true);
  assert.equal(validateMessage(collabFrame('history-bundle', { ...legal, cursor: null, more: true, nextAfter: cursor })).ok, true);
  assert.equal(validateMessage(collabFrame('history-bundle', { ...legal, more: true })).ok, false, 'more=true 缺 nextAfter');
  assert.equal(validateMessage(collabFrame('history-bundle', { ...legal, more: 'yes' })).ok, false);
  assert.equal(validateMessage(collabFrame('history-bundle', { ...legal, posts: undefined })).ok, false);
  assert.equal(validateMessage(collabFrame('history-bundle', { ...legal, posts: [{ ...post, from: { instanceId: 'bad id!', identityName: '甲' } }] })).ok, false);
  assert.equal(validateMessage(collabFrame('history-bundle', { ...legal, posts: [{ ...post, seq: 0 }] })).ok, false);
  assert.equal(validateMessage(collabFrame('history-bundle', { ...legal, posts: [{ ...post, text: 'x'.repeat(4001) }] })).ok, false);
  assert.equal(validateMessage(collabFrame('history-bundle', { ...legal, members: [{ eventId: 'evt-1', kind: 'close', instanceId: 'inst-a', identityName: '甲', ts: post.ts }] })).ok, false);
  assert.equal(validateMessage(collabFrame('history-bundle', { ...legal, endpoints: { 'inst-a': { address: '127.0.0.1', port: 0 } } })).ok, false);
  assert.equal(validateMessage(collabFrame('history-bundle', { ...legal, endpoints: 'x' })).ok, false);
  assert.equal(validateMessage(collabFrame('history-bundle', { ...legal, meta: 'x' })).ok, false);
});

test('协作域 invite：endpoints 为可选加法字段（讨论携带；形态同端点表）', () => {
  const members = [SEAT_A, SEAT_B];
  const base = { name: '讨论甲', topic: '议题', members };
  assert.equal(validateMessage(collabFrame('invite', base)).ok, true);
  assert.equal(validateMessage(collabFrame('invite', { ...base, endpoints: { 'inst-a': { address: '127.0.0.1', port: 7321 } } })).ok, true);
  assert.equal(validateMessage(collabFrame('invite', { ...base, endpoints: { 'inst-a': { address: '127.0.0.1', port: 0 } } })).ok, false);
  assert.equal(validateMessage(collabFrame('invite', { ...base, endpoints: 'x' })).ok, false);
});

test('协作域 notice：event 枚举（established / roster / snapshot-stored）、version 可选且 ≥1', () => {
  assert.equal(validateMessage(collabFrame('notice', { event: 'established', version: 3 })).ok, true);
  assert.equal(validateMessage(collabFrame('notice', { event: 'roster' })).ok, true);
  assert.equal(validateMessage(collabFrame('notice', { event: 'snapshot-stored', version: 2 })).ok, true);
  assert.equal(validateMessage(collabFrame('notice', { event: 'unknown' })).ok, false);
  assert.equal(validateMessage(collabFrame('notice', { event: 'established', version: 0 })).ok, false);
});

test('协作域 freeze：名单为席位条目、1–32 项（下界 1 依 D13）；缺 sessionId/identityName 拒', () => {
  assert.equal(validateMessage(collabFrame('freeze', { name: '项目', members: [SEAT_A] })).ok, true, '单席合法');
  assert.equal(validateMessage(collabFrame('freeze', { name: '项目', members: [SEAT_A, SEAT_B] })).ok, true);
  assert.equal(validateMessage(collabFrame('freeze', { name: '项目', members: [{ instanceId: 'inst-a' }] })).ok, false);
  assert.equal(validateMessage(collabFrame('freeze', { name: '项目', members: [{ instanceId: 'inst-a', sessionId: 'sess-a' }] })).ok, false);
  assert.equal(validateMessage(collabFrame('freeze', { name: '项目', members: [{ instanceId: 'inst-a', identityName: '甲' }] })).ok, false);
});

test('协作域 snapshot request：kind=request 需 managerTerm+version；purpose 仅 catchup', () => {
  assert.equal(validateMessage(collabFrame('snapshot', { kind: 'request' })).ok, false, '缺 term/version');
  assert.equal(validateMessage(collabFrame('snapshot', { kind: 'request', managerTerm: 2, version: 2 })).ok, true);
  assert.equal(validateMessage(collabFrame('snapshot', { kind: 'request', managerTerm: 2, version: 2, purpose: 'catchup' })).ok, true);
  assert.equal(validateMessage(collabFrame('snapshot', { kind: 'request', managerTerm: 0, version: 2 })).ok, false);
  assert.equal(validateMessage(collabFrame('snapshot', { kind: 'request', managerTerm: 2, version: 0 })).ok, false);
  assert.equal(validateMessage(collabFrame('snapshot', { kind: 'request', managerTerm: 2, version: 2, purpose: 'other' })).ok, false);
});

function snapshotData(overrides = {}) {
  const ledger = { collabId: 'collab-1', managerTerm: 2, version: 2, managerWindow: { windowBaseTerm: 2, windowEndsAt: '2026-10-13T00:00:00.000Z' } };
  return {
    kind: 'data',
    managerTerm: 2,
    version: 2,
    managerWindow: { windowBaseTerm: 2, windowEndsAt: '2026-10-13T00:00:00.000Z' },
    digest: 'a'.repeat(64),
    ledger,
    ...overrides,
  };
}

test('协作域 snapshot data：帧与台账的 managerTerm/version/collabId/managerWindow 必须自洽', () => {
  assert.equal(validateMessage(collabFrame('snapshot', snapshotData())).ok, true);
  assert.equal(validateMessage(collabFrame('snapshot', snapshotData({ managerWindow: undefined }))).ok, false, '任一侧有窗口即须两侧一致');
  assert.equal(validateMessage(collabFrame('snapshot', snapshotData({ managerWindow: undefined, ledger: { collabId: 'collab-1', managerTerm: 2, version: 2 } }))).ok, true, '双方均无窗口合法');
  assert.equal(validateMessage(collabFrame('snapshot', snapshotData({ digest: 'zz' }))).ok, false);
  assert.equal(validateMessage(collabFrame('snapshot', snapshotData({ ledger: undefined }))).ok, false);
  assert.equal(validateMessage(collabFrame('snapshot', { ...snapshotData(), ledger: { collabId: 'collab-1', managerTerm: 3, version: 2 } })).ok, false, 'term 不一致');
  assert.equal(validateMessage(collabFrame('snapshot', { ...snapshotData(), ledger: { collabId: 'collab-1', managerTerm: 2, version: 1 } })).ok, false, 'version 不一致');
  assert.equal(validateMessage(collabFrame('snapshot', { ...snapshotData(), ledger: { collabId: 'collab-2', managerTerm: 2, version: 2 } })).ok, false, 'collabId 不一致');
  assert.equal(validateMessage(collabFrame('snapshot', { ...snapshotData(), ledger: { collabId: 'collab-1', managerTerm: 2, version: 2 } })).ok, false, '帧有窗口而台账无');
  assert.equal(validateMessage(collabFrame('snapshot', { kind: 'push' })).ok, false);
});

test('协作域全类型覆盖：对每个协作域类型给非法 payload 必拒（防漏挂表）', () => {
  const collabTypes = ['invite', 'approve', 'decline', 'withdraw', 'topic', 'task', 'progress', 'issue', 'stop', 'reply', 'notice', 'freeze', 'snapshot', 'post', 'join', 'join-request', 'join-grant', 'join-deny', 'join-confirm', 'seat-presence', 'history-request', 'history-bundle', 'end', 'leave'];
  const invalidPayload = {
    invite: { name: '项目' },
    approve: 'x',
    decline: 'x',
    withdraw: {},
    topic: {},
    task: {},
    progress: {},
    issue: {},
    stop: 'x',
    reply: {},
    notice: {},
    freeze: {},
    snapshot: {},
    post: { post: { postId: 'post-1' } },
    join: {},
    'join-request': {},
    'join-grant': { sessionId: 'sess-1' },
    'join-deny': {},
    'join-confirm': {},
    'seat-presence': {},
    'history-request': 'x',
    'history-bundle': {},
    end: 'x',
    leave: 'x',
  };
  for (const type of collabTypes) {
    assert.equal(validateMessage(collabFrame(type, invalidPayload[type])).ok, false, type);
  }
});

test('isPresentationText：空 / 超限 / 控制与不可见字符拒、中文与空格通过', () => {
  assert.equal(isPresentationText('联调 主题', 200), true);
  assert.equal(isPresentationText('   ', 200), false);
  assert.equal(isPresentationText('x'.repeat(201), 200), false);
  assert.equal(isPresentationText('甲\u200b乙', 200), false);
  assert.equal(isPresentationText(42, 200), false);
  assert.equal(DIGEST_PATTERN.test('a'.repeat(64)), true);
  assert.equal(DIGEST_PATTERN.test('A'.repeat(64)), false);
});

/* —— 治理与韧性载荷（协作域的治理五型与 notice 事件扩展） —— */

const digestOf = 'a'.repeat(64);

test('治理域 freeze：createdAt / manager 为可选参考字段（存在则校验）', () => {
  const members = [SEAT_A, SEAT_B];
  assert.equal(validateMessage(frameWith({ type: 'freeze', payload: { name: '项目', members } })).ok, true);
  assert.equal(validateMessage(frameWith({ type: 'freeze', payload: { name: '项目', members, createdAt: new Date().toISOString(), manager: { instanceId: 'inst-a', identityName: '主机甲' } } })).ok, true);
  assert.equal(validateMessage(frameWith({ type: 'freeze', payload: { name: '项目', members, createdAt: 42 } })).ok, false);
  assert.equal(validateMessage(frameWith({ type: 'freeze', payload: { name: '项目', members, manager: { instanceId: 'inst-a' } } })).ok, false);
});

test('治理域 decision：choice 枚举、名单必填、执行型字段与 createdAt 逐项校验', () => {
  const members = [SEAT_A, SEAT_B];
  const legal = { choice: 'merge', name: '项目', members };
  assert.equal(validateMessage(frameWith({ type: 'decision', payload: legal })).ok, true);
  assert.equal(validateMessage(frameWith({ type: 'decision', payload: { ...legal, winner: 'collab-1', collabId: 'collab-2', executed: true, createdAt: new Date().toISOString(), reason: '裁定' } })).ok, true);
  for (const payload of [
    { ...legal, choice: 'both' },
    { choice: 'keep', members },
    { ...legal, members: [{ instanceId: 'inst-a' }] },
    { ...legal, winner: '../x' },
    { ...legal, executed: 'yes' },
    { ...legal, createdAt: 1 },
    { ...legal, reason: 'x'.repeat(201) },
  ]) {
    assert.equal(validateMessage(frameWith({ type: 'decision', payload })).ok, false, JSON.stringify(payload).slice(0, 60));
  }
});

test('治理域 unfreeze：name + members 必填、reason 可选（与 freeze 同判据）', () => {
  const members = [SEAT_A, SEAT_B];
  assert.equal(validateMessage(frameWith({ type: 'unfreeze', payload: { name: '项目', members } })).ok, true);
  assert.equal(validateMessage(frameWith({ type: 'unfreeze', payload: { name: '项目', members, reason: '保持两条' } })).ok, true);
  assert.equal(validateMessage(frameWith({ type: 'unfreeze', payload: { name: '项目' } })).ok, false);
  assert.equal(validateMessage(frameWith({ type: 'unfreeze', payload: { name: '项目', members, reason: '坏\u0007字符' } })).ok, false);
});

function handoverOfferOf(overrides = {}) {
  return {
    kind: 'offer',
    offerId: 'offer-1',
    baseTerm: 1,
    version: 3,
    digest: digestOf,
    ledger: {},
    endpoints: { 'inst-b': { address: '127.0.0.2', port: 7321 } },
    expiresAt: new Date().toISOString(),
    ...overrides,
  };
}

test('治理域 handover offer：offerId/baseTerm/version/digest/ledger/endpoints/expiresAt 必填逐项拒', () => {
  assert.equal(validateMessage(frameWith({ type: 'handover', payload: handoverOfferOf() })).ok, true);
  for (const field of ['offerId', 'baseTerm', 'version', 'digest', 'ledger', 'endpoints', 'expiresAt']) {
    assert.equal(validateMessage(frameWith({ type: 'handover', payload: handoverOfferOf({ [field]: undefined }) })).ok, false, field);
  }
  assert.equal(validateMessage(frameWith({ type: 'handover', payload: handoverOfferOf({ offerId: '../x' }) })).ok, false);
  assert.equal(validateMessage(frameWith({ type: 'handover', payload: handoverOfferOf({ baseTerm: 0 }) })).ok, false);
  assert.equal(validateMessage(frameWith({ type: 'handover', payload: handoverOfferOf({ baseTerm: 2147483648 }) })).ok, false);
  assert.equal(validateMessage(frameWith({ type: 'handover', payload: handoverOfferOf({ version: 0 }) })).ok, false);
  assert.equal(validateMessage(frameWith({ type: 'handover', payload: handoverOfferOf({ digest: 'zz' }) })).ok, false);
  assert.equal(validateMessage(frameWith({ type: 'handover', payload: handoverOfferOf({ expiresAt: '昨天' }) })).ok, false);
  for (const endpoints of ['x', { 'bad id!': { address: '127.0.0.2', port: 7321 } }, { 'inst-b': { address: 7, port: 7321 } }, { 'inst-b': { address: '127.0.0.2', port: 0 } }]) {
    assert.equal(validateMessage(frameWith({ type: 'handover', payload: handoverOfferOf({ endpoints }) })).ok, false, JSON.stringify(endpoints));
  }
});

test('治理域 handover accept/reject：accept 回指 offerId+baseTerm，reject 回指 offerId 且 reason 枚举', () => {
  const accept = { kind: 'accept', offerId: 'offer-1', baseTerm: 1, version: 3, digest: digestOf };
  assert.equal(validateMessage(frameWith({ type: 'handover', payload: accept })).ok, true);
  assert.equal(validateMessage(frameWith({ type: 'handover', payload: { ...accept, confirm: true } })).ok, true);
  assert.equal(validateMessage(frameWith({ type: 'handover', payload: { ...accept, confirm: 'yes' } })).ok, false);
  for (const field of ['offerId', 'baseTerm', 'version', 'digest']) {
    assert.equal(validateMessage(frameWith({ type: 'handover', payload: { ...accept, [field]: undefined } })).ok, false, field);
  }
  assert.equal(validateMessage(frameWith({ type: 'handover', payload: { kind: 'reject', offerId: 'offer-1', reason: 'version-changed' } })).ok, true);
  assert.equal(validateMessage(frameWith({ type: 'handover', payload: { kind: 'reject', offerId: 'offer-1', reason: 'expired' } })).ok, true);
  assert.equal(validateMessage(frameWith({ type: 'handover', payload: { kind: 'reject', reason: 'expired' } })).ok, false);
  assert.equal(validateMessage(frameWith({ type: 'handover', payload: { kind: 'reject', offerId: 'offer-1', reason: '忙' } })).ok, false);
  assert.equal(validateMessage(frameWith({ type: 'handover', payload: { kind: 'later' } })).ok, false);
  assert.equal(validateMessage(frameWith({ type: 'handover', payload: 'x' })).ok, false);
});

test('治理域 takeover-init announce：manager / baseVersion / windowEndsAt 逐字段拒', () => {
  const legal = { kind: 'announce', manager: { instanceId: 'inst-a', identityName: '主机甲' }, baseVersion: 3, windowEndsAt: new Date().toISOString() };
  assert.equal(validateMessage(frameWith({ type: 'takeover-init', payload: legal })).ok, true);
  for (const payload of [
    { ...legal, manager: { instanceId: 'inst-a' } },
    { ...legal, baseVersion: 0 },
    { ...legal, windowEndsAt: 'not-a-time' },
    { kind: 'announce' },
  ]) {
    assert.equal(validateMessage(frameWith({ type: 'takeover-init', payload })).ok, false, JSON.stringify(payload).slice(0, 60));
  }
});

test('治理域 takeover-init report：version 与 takeover 可空、记录形态逐字段拒', () => {
  assert.equal(validateMessage(frameWith({ type: 'takeover-init', payload: { kind: 'report', version: null, takeover: null } })).ok, true);
  const record = { phase: 'effective', candidate: { instanceId: 'inst-b', identityName: '主机乙' }, baseVersion: 2 };
  assert.equal(validateMessage(frameWith({ type: 'takeover-init', payload: { kind: 'report', version: 2, takeover: record } })).ok, true);
  for (const payload of [
    { kind: 'report', version: 0, takeover: null },
    { kind: 'report', version: null, takeover: { ...record, phase: 'waiting' } },
    { kind: 'report', version: null, takeover: { ...record, candidate: { instanceId: 'inst-b' } } },
  ]) {
    assert.equal(validateMessage(frameWith({ type: 'takeover-init', payload })).ok, false, JSON.stringify(payload).slice(0, 60));
  }
});

test('治理域 takeover-init cancel：reason 可选', () => {
  assert.equal(validateMessage(frameWith({ type: 'takeover-init', payload: { kind: 'cancel' } })).ok, true);
  assert.equal(validateMessage(frameWith({ type: 'takeover-init', payload: { kind: 'cancel', reason: '原站长恢复应答' } })).ok, true);
  assert.equal(validateMessage(frameWith({ type: 'takeover-init', payload: { kind: 'cancel', reason: 'x'.repeat(201) } })).ok, false);
});

test('治理域 takeover：baseVersion/windowBaseTerm/term/version/authorizedAt/digest 必填且 term=base+1', () => {
  const legal = { baseVersion: 3, windowBaseTerm: 2, term: 3, version: 4, authorizedAt: new Date().toISOString(), digest: digestOf };
  assert.equal(validateMessage(frameWith({ type: 'takeover', payload: legal })).ok, true);
  assert.equal(validateMessage(frameWith({ type: 'takeover', payload: { ...legal, reason: '站长失联' } })).ok, true);
  for (const field of ['baseVersion', 'windowBaseTerm', 'term', 'version', 'authorizedAt', 'digest']) {
    assert.equal(validateMessage(frameWith({ type: 'takeover', payload: { ...legal, [field]: undefined } })).ok, false, field);
  }
  assert.equal(validateMessage(frameWith({ type: 'takeover', payload: { ...legal, baseVersion: 1.5 } })).ok, false);
  assert.equal(validateMessage(frameWith({ type: 'takeover', payload: { ...legal, windowBaseTerm: 0 } })).ok, false);
  assert.equal(validateMessage(frameWith({ type: 'takeover', payload: { ...legal, term: 4 } })).ok, false, 'term 必须等于 windowBaseTerm+1');
  assert.equal(validateMessage(frameWith({ type: 'takeover', payload: { ...legal, authorizedAt: '昨天' } })).ok, false);
  assert.equal(validateMessage(frameWith({ type: 'takeover', payload: { ...legal, digest: 'zz' } })).ok, false);
});

test('治理域全类型覆盖：五个治理类型给非法 payload 必拒（防漏挂表）', () => {
  const governanceTypes = ['unfreeze', 'decision', 'handover', 'takeover-init', 'takeover'];
  const invalidPayload = {
    unfreeze: {},
    decision: { choice: 'merge' },
    handover: { kind: 'offer' },
    'takeover-init': { kind: 'report', version: 0, takeover: null },
    takeover: {},
  };
  for (const type of governanceTypes) {
    assert.equal(validateMessage(frameWith({ type, payload: invalidPayload[type] })).ok, false, type);
  }
});

function managerChangedOf(overrides = {}) {
  return {
    event: 'manager-changed',
    manager: { instanceId: 'inst-b', sessionId: 'sess-b', identityName: '主机乙' },
    term: 2,
    version: 3,
    via: 'handover',
    prevManager: { instanceId: 'inst-a', sessionId: 'sess-a' },
    offerId: 'offer-1',
    effectiveAt: new Date().toISOString(),
    endpoint: { address: '127.0.0.2', port: 7321 },
    digest: 'a'.repeat(64),
    ...overrides,
  };
}

test('notice manager-changed：term/version/via/prevManager/effectiveAt/digest/endpoint 必填逐项拒', () => {
  assert.equal(validateMessage(frameWith({ type: 'notice', payload: managerChangedOf() })).ok, true);
  const required = ['manager', 'term', 'version', 'via', 'prevManager', 'effectiveAt', 'digest'];
  for (const field of required) {
    assert.equal(validateMessage(frameWith({ type: 'notice', payload: managerChangedOf({ [field]: undefined }) })).ok, false, field);
  }
  assert.equal(validateMessage(frameWith({ type: 'notice', payload: managerChangedOf({ term: 0 }) })).ok, false);
  assert.equal(validateMessage(frameWith({ type: 'notice', payload: managerChangedOf({ term: 2147483648 }) })).ok, false);
  assert.equal(validateMessage(frameWith({ type: 'notice', payload: managerChangedOf({ version: 0 }) })).ok, false);
  assert.equal(validateMessage(frameWith({ type: 'notice', payload: managerChangedOf({ via: 'coup' }) })).ok, false);
  assert.equal(validateMessage(frameWith({ type: 'notice', payload: managerChangedOf({ digest: 'zz' }) })).ok, false);
});

test('notice manager-changed：manager 与 prevManager 按席位形态（需 sessionId）', () => {
  assert.equal(validateMessage(frameWith({ type: 'notice', payload: managerChangedOf({ manager: { instanceId: 'inst-b', identityName: '主机乙' } }) })).ok, false);
  assert.equal(validateMessage(frameWith({ type: 'notice', payload: managerChangedOf({ prevManager: { instanceId: 'inst-a' } }) })).ok, false);
  assert.equal(validateMessage(frameWith({ type: 'notice', payload: managerChangedOf({ offerId: '../x' }) })).ok, false);
  for (const endpoint of [{ address: '127.0.0.2', port: 0 }, { address: 7, port: 7321 }, 'x', { port: 7321 }, { address: '', port: 7321 }]) {
    assert.equal(validateMessage(frameWith({ type: 'notice', payload: managerChangedOf({ endpoint }) })).ok, false, JSON.stringify(endpoint));
  }
});

test('notice manager-changed：按 via 校验窗口/授权字段（auto / takeover / takeover-manual / initial）', () => {
  assert.equal(validateMessage(frameWith({ type: 'notice', payload: managerChangedOf({ via: 'auto' }) })).ok, false, 'auto 需 windowEndsAt');
  const auto = managerChangedOf({ via: 'auto', windowEndsAt: new Date().toISOString() });
  assert.equal(validateMessage(frameWith({ type: 'notice', payload: auto })).ok, true);
  assert.equal(validateMessage(frameWith({ type: 'notice', payload: managerChangedOf({ via: 'takeover' }) })).ok, false, 'takeover 需窗口基准');
  const takeover = managerChangedOf({ via: 'takeover', windowBaseTerm: 1, authorizedAt: new Date().toISOString() });
  assert.equal(validateMessage(frameWith({ type: 'notice', payload: takeover })).ok, true);
  assert.equal(validateMessage(frameWith({ type: 'notice', payload: managerChangedOf({ via: 'takeover-manual' }) })).ok, false, '手动接管需 authorizedAt');
  assert.equal(validateMessage(frameWith({ type: 'notice', payload: managerChangedOf({ via: 'takeover-manual', authorizedAt: new Date().toISOString() }) })).ok, true);
  assert.equal(validateMessage(frameWith({ type: 'notice', payload: managerChangedOf({ via: 'initial', endpoint: undefined }) })).ok, true, 'initial 可缺 endpoint');
});

test('notice manager-changed：窗口字段只随开窗的 via 出现（防伪造组合）', () => {
  const windowEndsAt = new Date().toISOString();
  assert.equal(validateMessage(frameWith({ type: 'notice', payload: managerChangedOf({ via: 'handover', windowEndsAt }) })).ok, false, 'handover 不开窗');
  assert.equal(validateMessage(frameWith({ type: 'notice', payload: managerChangedOf({ via: 'initial', endpoint: undefined, windowEndsAt }) })).ok, false);
  assert.equal(validateMessage(frameWith({ type: 'notice', payload: managerChangedOf({ via: 'auto', windowEndsAt, windowBaseTerm: 1 }) })).ok, false, 'auto 不携窗口基准');
  assert.equal(validateMessage(frameWith({ type: 'notice', payload: managerChangedOf({ via: 'takeover', windowBaseTerm: 1, authorizedAt: windowEndsAt, windowEndsAt }) })).ok, false, 'takeover 不开新窗');
  assert.equal(validateMessage(frameWith({ type: 'notice', payload: managerChangedOf({ via: 'handover', authorizedAt: windowEndsAt }) })).ok, false, 'handover 不携授权时刻');
});

function handshakeOf(overrides = {}) {
  return { event: 'handshake', role: 'member', managerTerm: 1, version: null, manager: null, reply: false, ...overrides };
}

test('notice handshake：managerTerm 必填、manager 可 null 或席位、managerEndpoint 可选', () => {
  assert.equal(validateMessage(frameWith({ type: 'notice', payload: handshakeOf() })).ok, true);
  const manager = { instanceId: 'inst-a', sessionId: 'sess-a', identityName: '主机甲' };
  assert.equal(validateMessage(frameWith({ type: 'notice', payload: handshakeOf({ role: 'manager', version: 3, manager, managerEndpoint: { address: '127.0.0.1', port: 7321 }, reply: true }) })).ok, true);
  assert.equal(validateMessage(frameWith({ type: 'notice', payload: handshakeOf({ managerTerm: undefined }) })).ok, false);
  assert.equal(validateMessage(frameWith({ type: 'notice', payload: handshakeOf({ managerTerm: 0 }) })).ok, false);
  assert.equal(validateMessage(frameWith({ type: 'notice', payload: handshakeOf({ managerTerm: 2147483648 }) })).ok, false);
  assert.equal(validateMessage(frameWith({ type: 'notice', payload: handshakeOf({ manager: { instanceId: 'inst-a', identityName: '主机甲' } }) })).ok, false);
  assert.equal(validateMessage(frameWith({ type: 'notice', payload: handshakeOf({ managerEndpoint: { address: 'x', port: 0 } }) })).ok, false);
});

test('notice handshake：role / version / takeover / reply 逐字段拒', () => {
  const record = { phase: 'inflight', candidate: { instanceId: 'inst-b', identityName: '主机乙' }, baseVersion: 2 };
  assert.equal(validateMessage(frameWith({ type: 'notice', payload: handshakeOf({ role: 'manager', version: 3, takeover: record, reply: true }) })).ok, true);
  for (const payload of [
    handshakeOf({ role: 'boss' }),
    handshakeOf({ version: 0 }),
    handshakeOf({ takeover: { phase: 'x', candidate: { instanceId: 'inst-b', identityName: '乙' }, baseVersion: 1 } }),
    handshakeOf({ reply: 'yes' }),
  ]) {
    assert.equal(validateMessage(frameWith({ type: 'notice', payload })).ok, false, JSON.stringify(payload).slice(0, 60));
  }
});

test('notice auto-offer：offerId / prevManager / target / baseTerm / version / expiresAt 必填逐项拒', () => {
  const legal = {
    event: 'auto-offer',
    offerId: 'offer-1',
    prevManager: { instanceId: 'inst-a', sessionId: 'sess-a' },
    target: { instanceId: 'inst-b', sessionId: 'sess-b' },
    baseTerm: 1,
    version: 2,
    expiresAt: new Date().toISOString(),
  };
  assert.equal(validateMessage(frameWith({ type: 'notice', payload: legal })).ok, true);
  for (const field of ['offerId', 'prevManager', 'target', 'baseTerm', 'version', 'expiresAt']) {
    assert.equal(validateMessage(frameWith({ type: 'notice', payload: { ...legal, [field]: undefined } })).ok, false, field);
  }
  assert.equal(validateMessage(frameWith({ type: 'notice', payload: { ...legal, prevManager: { instanceId: 'inst-a' } } })).ok, false);
  assert.equal(validateMessage(frameWith({ type: 'notice', payload: { ...legal, target: { instanceId: 'inst-b' } } })).ok, false);
  assert.equal(validateMessage(frameWith({ type: 'notice', payload: { ...legal, baseTerm: 0 } })).ok, false);
  assert.equal(validateMessage(frameWith({ type: 'notice', payload: { ...legal, baseTerm: 2147483648 } })).ok, false);
  assert.equal(validateMessage(frameWith({ type: 'notice', payload: { ...legal, version: 0 } })).ok, false);
  assert.equal(validateMessage(frameWith({ type: 'notice', payload: { ...legal, expiresAt: '昨天' } })).ok, false);
});

test('notice merge-request：baseVersion / version / digest / ledger 逐字段拒', () => {
  const legal = { event: 'merge-request', baseVersion: 2, version: 5, digest: digestOf, ledger: {} };
  assert.equal(validateMessage(frameWith({ type: 'notice', payload: legal })).ok, true);
  for (const payload of [
    { ...legal, baseVersion: 0 },
    { ...legal, version: 0 },
    { ...legal, digest: 'short' },
    { ...legal, ledger: [] },
  ]) {
    assert.equal(validateMessage(frameWith({ type: 'notice', payload })).ok, false, JSON.stringify(payload).slice(0, 60));
  }
});

test('notice merge-outcome：adopted 布尔必填', () => {
  assert.equal(validateMessage(frameWith({ type: 'notice', payload: { event: 'merge-outcome', adopted: true } })).ok, true);
  assert.equal(validateMessage(frameWith({ type: 'notice', payload: { event: 'merge-outcome', adopted: false } })).ok, true);
  assert.equal(validateMessage(frameWith({ type: 'notice', payload: { event: 'merge-outcome' } })).ok, false);
});

test('notice event 为原型成员名（__proto__ / constructor / toString）：按未知事件拒绝，校验层不抛穿', () => {
  for (const event of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    const checked = validateMessage(frameWith({ type: 'notice', payload: { event } }));
    assert.equal(checked.ok, false, event);
    assert.ok(checked.reason.includes('notice.event'), `${event}: ${checked.reason}`);
  }
});

/* —— 主动加入（设计 §5.6）：敲门与应答数据报（发现类，不入 MESSAGE_TYPES） —— */

const KNOCK = { v: PROTOCOL_VERSION, type: 'join-knock', instanceId: 'inst-a', identityName: '主机甲', knockId: 'knock-1', name: '联调讨论' };

/* 应答骨架（截断标注缺省不携带；截断用例按需覆盖）。 */
function ackDatagram(overrides = {}) {
  return {
    v: PROTOCOL_VERSION,
    type: 'join-ack',
    instanceId: 'inst-b',
    identityName: '主机乙',
    knockId: 'knock-1',
    collabId: 'collab-1',
    name: '联调讨论',
    topic: '发布联调',
    memberCount: 3,
    originator: { instanceId: 'inst-org', identityName: '发起人' },
    port: 7321,
    ...overrides,
  };
}

test('join-knock：合法通过；knockId 与 name 逐项拒', () => {
  assert.equal(validateJoinKnock(KNOCK).ok, true);
  for (const knockId of ['../x', 'a b', '', 'x'.repeat(65), 42, undefined]) {
    assert.equal(validateJoinKnock({ ...KNOCK, knockId }).ok, false, String(knockId));
  }
  for (const name of ['甲\n乙', 'x'.repeat(65), '', '   ', undefined, 42]) {
    const checked = validateJoinKnock({ ...KNOCK, name });
    assert.equal(checked.ok, false, String(name));
    assert.ok(checked.reason.includes('name'), checked.reason);
  }
});

test('join-ack：合法通过；port 可选（宽容缺省）、存在则须合法', () => {
  assert.equal(validateJoinAck(ackDatagram()).ok, true);
  assert.equal(validateJoinAck(ackDatagram({ port: undefined })).ok, true, '缺 port 回退数据报来源端口（同 probe-ack 宽容缺省）');
  for (const port of [0, 65536, '7321', 1.5]) {
    assert.equal(validateJoinAck(ackDatagram({ port })).ok, false, String(port));
  }
});

test('join-ack：必携字段逐项拒（knockId / collabId / memberCount / originator）', () => {
  for (const knockId of ['../x', undefined]) {
    assert.equal(validateJoinAck(ackDatagram({ knockId })).ok, false, String(knockId));
  }
  for (const collabId of ['a/b', undefined]) {
    assert.equal(validateJoinAck(ackDatagram({ collabId })).ok, false, String(collabId));
  }
  assert.equal(validateJoinAck(ackDatagram({ memberCount: 0 })).ok, false, '成员数 ≥1');
  assert.equal(validateJoinAck(ackDatagram({ memberCount: 1.5 })).ok, false);
  assert.equal(validateJoinAck(ackDatagram({ memberCount: MAX_COLLAB_COUNT + 1 })).ok, false);
  assert.equal(validateJoinAck(ackDatagram({ memberCount: undefined })).ok, false);
  assert.equal(validateJoinAck(ackDatagram({ originator: undefined })).ok, false, '发起人标识为必携字段');
  assert.equal(validateJoinAck(ackDatagram({ originator: { instanceId: 'inst-org' } })).ok, false);
  assert.equal(validateJoinAck(ackDatagram({ originator: { instanceId: 'bad id!', identityName: '发起人' } })).ok, false);
});

test('join-ack：主题与名称可截断——空值仅限带截断标注；标注须为布尔', () => {
  assert.equal(validateJoinAck(ackDatagram({ topic: '', topicTruncated: true })).ok, true, '截到空主题必须带标注（诚实留痕）');
  assert.equal(validateJoinAck(ackDatagram({ topic: '' })).ok, false, '空主题无标注 = 以空值伪装完整值');
  assert.equal(validateJoinAck(ackDatagram({ name: '', nameTruncated: true })).ok, true);
  assert.equal(validateJoinAck(ackDatagram({ name: '' })).ok, false);
  assert.equal(validateJoinAck(ackDatagram({ topicTruncated: true })).ok, true, '未截断而携带标注只是冗余（不拒）');
  for (const flag of ['yes', 1, null]) {
    assert.equal(validateJoinAck(ackDatagram({ topicTruncated: flag })).ok, false, String(flag));
    assert.equal(validateJoinAck(ackDatagram({ nameTruncated: flag })).ok, false, String(flag));
  }
});

test('join-ack：主题与名称沿用呈现面判据（超长 / 控制字符 / 非字符串拒）', () => {
  assert.equal(validateJoinAck(ackDatagram({ topic: 'x'.repeat(MAX_TOPIC_CHARS) })).ok, true);
  assert.equal(validateJoinAck(ackDatagram({ topic: 'x'.repeat(MAX_TOPIC_CHARS + 1) })).ok, false);
  assert.equal(validateJoinAck(ackDatagram({ name: 'x'.repeat(65) })).ok, false);
  assert.equal(validateJoinAck(ackDatagram({ name: '甲\n乙' })).ok, false);
  assert.equal(validateJoinAck(ackDatagram({ topic: '主​题' })).ok, false);
  assert.equal(validateJoinAck(ackDatagram({ topic: 42 })).ok, false);
  assert.equal(validateJoinAck(ackDatagram({ name: 42 })).ok, false);
});

/* —— 按名解析（会话级管理设计 §2）：单播请求与应答数据报（发现类，不入 MESSAGE_TYPES） —— */

const RESOLVE = { v: PROTOCOL_VERSION, type: 'join-resolve', name: '联调讨论', resolveId: 'resolve-1' };

/* 解析应答骨架（未命中为极简形态——讨论面字段由用例按需覆盖）。 */
function resolveAck(overrides = {}) {
  return {
    v: PROTOCOL_VERSION,
    type: 'join-resolve-ack',
    instanceId: 'inst-b',
    identityName: '主机乙',
    port: 7321,
    resolveId: 'resolve-1',
    found: true,
    collabId: 'collab-1',
    name: '联调讨论',
    ...overrides,
  };
}

/* 未命中骨架（极简形态：不带讨论面字段）。 */
function resolveMiss(overrides = {}) {
  return {
    v: PROTOCOL_VERSION,
    type: 'join-resolve-ack',
    instanceId: 'inst-b',
    identityName: '主机乙',
    port: 7321,
    resolveId: 'resolve-1',
    found: false,
    ...overrides,
  };
}

test('join-resolve：合法通过（请求方不自报身份——单播问答按来源回发）；resolveId 与 name 逐项拒', () => {
  assert.equal(validateJoinResolve(RESOLVE).ok, true);
  assert.equal(validateJoinResolve({ ...RESOLVE, instanceId: 'inst-a', identityName: '主机甲' }).ok, true, '自报身份只是冗余字段（不拒）');
  for (const resolveId of ['../x', 'a b', '', 'x'.repeat(65), 42, undefined]) {
    const checked = validateJoinResolve({ ...RESOLVE, resolveId });
    assert.equal(checked.ok, false, String(resolveId));
    assert.ok(checked.reason.includes('resolveId'), checked.reason);
  }
  for (const name of ['甲\n乙', 'x'.repeat(65), '', '   ', undefined, 42]) {
    const checked = validateJoinResolve({ ...RESOLVE, name });
    assert.equal(checked.ok, false, String(name));
    assert.ok(checked.reason.includes('name'), checked.reason);
  }
});

test('join-resolve-ack：命中形态（found=true 必携 collabId、name 可省）；resolveId 与身份字段必携', () => {
  assert.equal(validateJoinResolveAck(resolveAck()).ok, true);
  assert.equal(validateJoinResolveAck(resolveAck({ name: undefined })).ok, true, '整形弃名后仍合法（完整名加入后对表补齐）');
  assert.equal(validateJoinResolveAck(resolveAck({ name: 'x'.repeat(64) })).ok, true);
  for (const collabId of [undefined, 'a/b', 42]) {
    const checked = validateJoinResolveAck(resolveAck({ collabId }));
    assert.equal(checked.ok, false, String(collabId));
    assert.ok(checked.reason.includes('collabId'), checked.reason);
  }
  for (const name of ['甲\n乙', 'x'.repeat(65), '', 42]) {
    assert.equal(validateJoinResolveAck(resolveAck({ name })).ok, false, String(name));
  }
  for (const resolveId of [undefined, '../x', 42]) {
    const checked = validateJoinResolveAck(resolveAck({ resolveId }));
    assert.equal(checked.ok, false, String(resolveId));
    assert.ok(checked.reason.includes('resolveId'), checked.reason);
  }
  for (const instanceId of [undefined, '../x', 42]) {
    assert.equal(validateJoinResolveAck(resolveAck({ instanceId })).ok, false, String(instanceId));
  }
  for (const identityName of [undefined, '', '甲\n乙', 42]) {
    assert.equal(validateJoinResolveAck(resolveAck({ identityName })).ok, false, String(identityName));
  }
});

test('join-resolve-ack：未命中为极简形态（不带讨论面字段，带了即拒）', () => {
  assert.equal(validateJoinResolveAck(resolveMiss()).ok, true);
  assert.equal(validateJoinResolveAck(resolveMiss({ collabId: 'collab-1' })).ok, false, '未命中却给出协作标识（矛盾断言）');
  assert.equal(validateJoinResolveAck(resolveMiss({ name: '联调讨论' })).ok, false, '未命中不带讨论名');
});

test('join-resolve-ack：found 必携且为布尔；port 宽容缺省、存在则须合法', () => {
  for (const found of [undefined, 'yes', 'true', 1, null]) {
    const checked = validateJoinResolveAck(resolveAck({ found }));
    assert.equal(checked.ok, false, String(found));
    assert.ok(checked.reason.includes('found'), checked.reason);
  }
  assert.equal(validateJoinResolveAck(resolveAck({ port: undefined })).ok, true, '缺 port 回退数据报来源端口（同扫描应答 / 加入应答口径）');
  for (const port of [0, 65536, '7321', 1.5]) {
    const checked = validateJoinResolveAck(resolveAck({ port }));
    assert.equal(checked.ok, false, String(port));
    assert.ok(checked.reason.includes('port'), checked.reason);
  }
});

test('解析数据报对的体积整形：预算内原样返回（未命中极简形态照原样）', () => {
  const hit = resolveAck();
  assert.deepEqual(fitJoinResolveAck(hit), hit);
  const miss = resolveMiss();
  assert.deepEqual(fitJoinResolveAck(miss), miss);
});

test('fitJoinResolveAck：命中超限先弃 name（整字段弃、不截前缀）、collabId 不可截', () => {
  const heavy = resolveAck({ instanceId: 'e'.repeat(64), identityName: '乙'.repeat(64), collabId: 'c'.repeat(64), resolveId: 'r'.repeat(64), name: '名'.repeat(64) });
  assert.ok(Buffer.byteLength(JSON.stringify(heavy)) > MAX_DATAGRAM_BYTES, '构造面须确实超限');
  const fitted = fitJoinResolveAck(heavy);
  assert.ok(Buffer.byteLength(JSON.stringify(fitted)) <= MAX_DATAGRAM_BYTES);
  assert.equal(Object.hasOwn(fitted, 'name'), false, '超限弃 name 整字段（不做前缀截断）');
  assert.equal(fitted.collabId, heavy.collabId, '不可截字段保持完整');
  assert.equal(fitted.resolveId, heavy.resolveId);
  assert.equal(fitted.instanceId, heavy.instanceId);
  assert.equal(validateJoinResolveAck(fitted).ok, true, '整形结果必过校验（同一权威自洽）');
});

test('fitJoinResolveAck：未命中先归极简形态（弃讨论面字段）；仍超预算一律弃整份（返回 null）', () => {
  const miss = resolveMiss({ collabId: 'collab-1', name: '联调讨论' });
  const fitted = fitJoinResolveAck(miss);
  assert.ok(Buffer.byteLength(JSON.stringify(fitted)) <= MAX_DATAGRAM_BYTES);
  assert.equal(Object.hasOwn(fitted, 'collabId'), false, '未命中不带讨论面字段');
  assert.equal(Object.hasOwn(fitted, 'name'), false);
  assert.equal(fitted.found, false);
  assert.equal(fitted.resolveId, 'resolve-1');
  assert.equal(validateJoinResolveAck(fitted).ok, true);
  /* 弃尽可弃字段仍超（信封本身撑爆）→ 弃整份：绝不发超限数据报、绝不截不可截字段。 */
  const hopeless = resolveMiss({ instanceId: 'e'.repeat(64), identityName: '乙'.repeat(64), futureField: 'x'.repeat(200) });
  assert.equal(fitJoinResolveAck(hopeless), null);
  const hopelessHit = resolveAck({ instanceId: 'e'.repeat(64), identityName: '乙'.repeat(64), collabId: 'c'.repeat(64), resolveId: 'r'.repeat(64), name: '名'.repeat(64), futureField: 'x'.repeat(200) });
  assert.equal(fitJoinResolveAck(hopelessHit), null, '整形只弃 name：其余字段（含未来加法字段）不截不弃，据此仍超即弃发');
});

test('敲门与应答、解析对不入协作域类型表：validateMessage 按未知类型拒绝', () => {
  assert.equal(MESSAGE_TYPES.includes('join-knock'), false);
  assert.equal(MESSAGE_TYPES.includes('join-ack'), false);
  assert.equal(MESSAGE_TYPES.includes('join-resolve'), false);
  assert.equal(MESSAGE_TYPES.includes('join-resolve-ack'), false);
  assert.equal(validateMessage(frameWith({ type: 'join-knock' })).ok, false);
  assert.equal(validateMessage(frameWith({ type: 'join-ack' })).ok, false);
  assert.equal(validateMessage(frameWith({ type: 'join-resolve' })).ok, false);
  assert.equal(validateMessage(frameWith({ type: 'join-resolve-ack' })).ok, false);
  assert.ok(validateMessage(frameWith({ type: 'join-knock' })).reason.includes('未知'));
  assert.ok(validateMessage(frameWith({ type: 'join-resolve' })).reason.includes('未知'));
});

test('发现类校验器互不认账：probe / probe-ack / join-knock / join-ack / join-resolve / join-resolve-ack 交叉拒绝', () => {
  const probe = { v: PROTOCOL_VERSION, type: 'probe', instanceId: 'inst-a', identityName: '主机甲' };
  const probeAck = { ...probe, type: 'probe-ack', collabCount: 0 };
  assert.equal(validateProbe(KNOCK).ok, false);
  assert.equal(validateProbe(ackDatagram()).ok, false);
  assert.equal(validateProbeAck(KNOCK).ok, false);
  assert.equal(validateProbeAck(ackDatagram()).ok, false);
  assert.equal(validateJoinKnock(probe).ok, false);
  assert.equal(validateJoinKnock(probeAck).ok, false);
  assert.equal(validateJoinAck(probe).ok, false);
  assert.equal(validateJoinAck(probeAck).ok, false, 'probe-ack 不得被当作 join-ack 吸收');
  assert.equal(validateJoinKnock({ ...KNOCK, v: 2 }).ok, false);
  assert.equal(validateJoinKnock({ ...KNOCK, instanceId: '../x' }).ok, false);
  assert.equal(validateJoinAck(null).ok, false);
  assert.equal(validateJoinKnock('text').ok, false);
  /* 解析对与敲门族互不认账（单播请求 / 应答各归各的校验器）。 */
  assert.equal(validateJoinResolve(KNOCK).ok, false);
  assert.equal(validateJoinResolve(ackDatagram()).ok, false);
  assert.equal(validateJoinResolve(resolveAck()).ok, false);
  assert.equal(validateJoinKnock(RESOLVE).ok, false);
  assert.equal(validateJoinKnock(resolveAck()).ok, false);
  assert.equal(validateJoinAck(RESOLVE).ok, false);
  assert.equal(validateJoinAck(resolveAck()).ok, false, '解析应答不得被当作加入应答吸收');
  assert.equal(validateJoinResolveAck(RESOLVE).ok, false);
  assert.equal(validateJoinResolveAck(KNOCK).ok, false);
  assert.equal(validateJoinResolveAck(ackDatagram()).ok, false);
  assert.equal(validateJoinResolveAck(probeAck).ok, false);
  assert.equal(validateJoinResolve(null).ok, false);
  assert.equal(validateJoinResolve('text').ok, false);
  assert.equal(validateJoinResolveAck(null).ok, false);
  assert.equal(validateJoinResolveAck('text').ok, false);
  assert.equal(validateJoinResolve({ ...RESOLVE, v: 2 }).ok, false);
  assert.equal(validateJoinResolveAck({ ...resolveAck(), v: 2 }).ok, false);
});
