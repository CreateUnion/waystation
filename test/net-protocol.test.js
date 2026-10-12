import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GOVERNANCE_TYPES,
  ID_PATTERN,
  MAX_COLLAB_COUNT,
  MAX_DATAGRAM_BYTES,
  MAX_FRAME_BYTES,
  MESSAGE_TYPES,
  PROTOCOL_VERSION,
  TRANSPORT_TYPES,
  isIdentityName,
  newMsgId,
  parseFrame,
  validateMessage,
  validateProbe,
  validateProbeAck,
} from '../src/net/protocol.js';

const SELF = { instanceId: '11111111-2222-4333-8444-555555555555', identityName: '主机甲' };
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function envelope(overrides = {}) {
  return {
    v: 1,
    msgId: newMsgId(),
    type: 'notice',
    from: SELF,
    collabId: 'collab-1',
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
  assert.equal(parsed.frame.type, 'notice');
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

test('发现报文根节点非对象（null / 字符串）：validateProbe / validateProbeAck 拒绝', () => {
  assert.equal(validateProbe(null).ok, false);
  assert.equal(validateProbeAck('text').ok, false);
});

test('发现报文类型不匹配（探测/应答互收）：拒绝', () => {
  const ackShape = { v: PROTOCOL_VERSION, type: 'probe-ack', instanceId: SELF.instanceId, identityName: '主机甲' };
  assert.equal(validateProbe(ackShape).ok, false);
  assert.equal(validateProbeAck({ ...ackShape, type: 'probe' }).ok, false);
});

test('常量：版本、类型集、治理集、传输集与体积上限', () => {
  assert.equal(PROTOCOL_VERSION, 1);
  assert.equal(MESSAGE_TYPES.length, 24);
  for (const type of ['invite', 'approve', 'decline', 'withdraw', 'topic', 'task', 'progress', 'issue', 'stop', 'reply', 'freeze', 'unfreeze', 'decision', 'handover', 'takeover-init', 'takeover', 'notice', 'leave', 'end', 'ping', 'pong', 'delivery-status', 'snapshot', 'ack']) {
    assert.ok(MESSAGE_TYPES.includes(type), type);
  }
  assert.deepEqual(GOVERNANCE_TYPES, ['freeze', 'unfreeze', 'decision', 'takeover-init', 'takeover']);
  assert.deepEqual(TRANSPORT_TYPES, ['ping', 'pong', 'ack']);
  assert.equal(MAX_FRAME_BYTES, 1048576);
  assert.equal(MAX_DATAGRAM_BYTES, 512);
  assert.equal(ID_PATTERN.test('../x'), false);
  assert.equal(ID_PATTERN.test('a/b'), false);
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
    type: 'notice',
    from: { instanceId: 'inst-a', identityName: '主机甲' },
    collabId: 'collab-1',
    ts: new Date().toISOString(),
    ...overrides,
  };
}

test('from.port：合法整数通过、缺失通过（构造侧必填、入站侧容忍缺省）', () => {
  assert.equal(validateMessage(frameWith({ from: { instanceId: 'inst-a', identityName: '主机甲', port: 7321 } })).ok, true);
  assert.equal(validateMessage(frameWith()).ok, true);
  assert.equal(validateMessage(frameWith({ from: { instanceId: 'inst-a', identityName: '主机甲', port: 65535 } })).ok, true);
});

test('from.port：非法值拒收（0 / 65536 / 字符串 / 小数）', () => {
  for (const port of [0, 65536, '7321', 1.5, -1]) {
    const checked = validateMessage(frameWith({ from: { instanceId: 'inst-a', identityName: '主机甲', port } }));
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
