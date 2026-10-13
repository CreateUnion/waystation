import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DELIVERY_EXEMPT_TYPES,
  DIGEST_PATTERN,
  GOVERNANCE_TYPES,
  ID_PATTERN,
  MAX_COLLAB_COUNT,
  MAX_COLLAB_MEMBERS,
  MAX_DATAGRAM_BYTES,
  MAX_FRAME_BYTES,
  MAX_MESSAGE_TEXT_CHARS,
  MAX_TOPIC_CHARS,
  MESSAGE_TYPES,
  POST_KINDS,
  PROTOCOL_VERSION,
  TRANSPORT_TYPES,
  isIdentityName,
  isPresentationText,
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
    type: 'reply',
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
  assert.equal(MESSAGE_TYPES.length, 28);
  for (const type of ['invite', 'approve', 'decline', 'withdraw', 'topic', 'task', 'progress', 'issue', 'stop', 'reply', 'freeze', 'unfreeze', 'decision', 'handover', 'takeover-init', 'takeover', 'notice', 'leave', 'end', 'ping', 'pong', 'delivery-status', 'snapshot', 'post', 'join', 'history-request', 'history-bundle', 'ack']) {
    assert.ok(MESSAGE_TYPES.includes(type), type);
  }
  assert.deepEqual(GOVERNANCE_TYPES, ['freeze', 'unfreeze', 'decision', 'takeover-init', 'takeover']);
  assert.deepEqual(TRANSPORT_TYPES, ['ping', 'pong', 'ack']);
  assert.deepEqual(POST_KINDS, ['topic', 'task', 'progress', 'issue', 'stop', 'reply']);
  assert.equal(MAX_FRAME_BYTES, 1048576);
  assert.equal(MAX_DATAGRAM_BYTES, 512);
  assert.equal(ID_PATTERN.test('../x'), false);
  assert.equal(ID_PATTERN.test('a/b'), false);
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
    from: { instanceId: 'inst-a', identityName: '主机甲' },
    collabId: 'collab-1',
    ts: new Date().toISOString(),
    payload: { text: '你好' },
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

/* 协作域载荷校验用例：骨架沿用既有 frameWith，payload 按类型注入。 */
function collabFrame(type, payload) {
  return frameWith({ type, payload });
}

test('协作域 invite：合法通过（中文名、主题、成员 2 项）', () => {
  const members = [
    { instanceId: 'inst-a', identityName: '主机甲' },
    { instanceId: 'inst-b', identityName: '主机乙' },
  ];
  assert.equal(validateMessage(collabFrame('invite', { name: '联调项目', topic: '发布联调', members })).ok, true);
});

test('协作域 invite：mode 可选（缺省 = managed 旧行为）、词表内通过、词表外拒', () => {
  const members = [{ instanceId: 'inst-a', identityName: '甲' }, { instanceId: 'inst-b', identityName: '乙' }];
  const base = { name: '项目', topic: '主题', members };
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
  const members = [{ instanceId: 'inst-a', identityName: '甲' }, { instanceId: 'inst-b', identityName: '乙' }];
  for (const name of ['甲\n乙', 'x'.repeat(65), '', undefined]) {
    const checked = validateMessage(collabFrame('invite', { name, topic: '主题', members }));
    assert.equal(checked.ok, false, String(name));
    assert.ok(checked.reason.includes('invite'), checked.reason);
  }
});

test('协作域 invite：topic 非法逐拒（201 字符 / 零宽字符 / 缺字段）', () => {
  const members = [{ instanceId: 'inst-a', identityName: '甲' }, { instanceId: 'inst-b', identityName: '乙' }];
  for (const topic of ['x'.repeat(201), '主\u200b题', undefined]) {
    assert.equal(validateMessage(collabFrame('invite', { name: '项目', topic, members })).ok, false, String(topic));
  }
});

test('协作域 invite：members 形态逐拒（少于 2 / 超 32 / 重复实例标识 / 条目缺字段）', () => {
  const two = [{ instanceId: 'inst-a', identityName: '甲' }, { instanceId: 'inst-b', identityName: '乙' }];
  const many = Array.from({ length: 33 }, (raw, index) => ({ instanceId: `inst-${index}`, identityName: `主机-${index}` }));
  const dup = [...two, { instanceId: 'inst-a', identityName: '别名' }];
  const cases = [[two[0]], many, dup, [{ instanceId: 'inst-a' }, two[1]], 'not-an-array'];
  for (const members of cases) {
    assert.equal(validateMessage(collabFrame('invite', { name: '项目', topic: '主题', members })).ok, false, JSON.stringify(members).slice(0, 40));
  }
  assert.equal(MAX_COLLAB_MEMBERS, 32);
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
  const members = [{ instanceId: 'inst-a', identityName: '主机甲' }, { instanceId: 'inst-b', identityName: '主机乙' }];
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

test('协作域 freeze / snapshot：freeze 名单形态；snapshot request 通过、data 需 version+digest+ledger', () => {
  const members = [{ instanceId: 'inst-a' }, { instanceId: 'inst-b' }];
  assert.equal(validateMessage(collabFrame('freeze', { name: '项目', members })).ok, true);
  assert.equal(validateMessage(collabFrame('freeze', { name: '项目', members: [{ instanceId: 'inst-a' }] })).ok, false);
  assert.equal(validateMessage(collabFrame('freeze', { name: '项目', members: [{ identityName: '甲' }, { instanceId: 'inst-b' }] })).ok, false);
  assert.equal(validateMessage(collabFrame('snapshot', { kind: 'request' })).ok, true);
  const digest = 'a'.repeat(64);
  assert.equal(validateMessage(collabFrame('snapshot', { kind: 'data', version: 2, digest, ledger: {} })).ok, true);
  assert.equal(validateMessage(collabFrame('snapshot', { kind: 'data', version: 2, digest: 'zz', ledger: {} })).ok, false);
  assert.equal(validateMessage(collabFrame('snapshot', { kind: 'data', version: 2, digest })).ok, false);
  assert.equal(validateMessage(collabFrame('snapshot', { kind: 'push' })).ok, false);
});

test('协作域全类型覆盖：对每个协作域类型给非法 payload 必拒（防漏挂表）', () => {
  const collabTypes = ['invite', 'approve', 'decline', 'withdraw', 'topic', 'task', 'progress', 'issue', 'stop', 'reply', 'notice', 'freeze', 'snapshot', 'post', 'join', 'history-request', 'history-bundle', 'end', 'leave'];
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
  const members = [{ instanceId: 'inst-a' }, { instanceId: 'inst-b' }];
  assert.equal(validateMessage(frameWith({ type: 'freeze', payload: { name: '项目', members } })).ok, true);
  assert.equal(validateMessage(frameWith({ type: 'freeze', payload: { name: '项目', members, createdAt: new Date().toISOString(), manager: { instanceId: 'inst-a', identityName: '主机甲' } } })).ok, true);
  assert.equal(validateMessage(frameWith({ type: 'freeze', payload: { name: '项目', members, createdAt: 42 } })).ok, false);
  assert.equal(validateMessage(frameWith({ type: 'freeze', payload: { name: '项目', members, manager: { instanceId: 'inst-a' } } })).ok, false);
});

test('治理域 decision：choice 枚举、名单必填、执行型字段与 createdAt 逐项校验', () => {
  const members = [{ instanceId: 'inst-a' }, { instanceId: 'inst-b' }];
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
  const members = [{ instanceId: 'inst-a' }, { instanceId: 'inst-b' }];
  assert.equal(validateMessage(frameWith({ type: 'unfreeze', payload: { name: '项目', members } })).ok, true);
  assert.equal(validateMessage(frameWith({ type: 'unfreeze', payload: { name: '项目', members, reason: '保持两条' } })).ok, true);
  assert.equal(validateMessage(frameWith({ type: 'unfreeze', payload: { name: '项目' } })).ok, false);
  assert.equal(validateMessage(frameWith({ type: 'unfreeze', payload: { name: '项目', members, reason: '坏\u0007字符' } })).ok, false);
});

test('治理域 handover：offer / accept / reject 三型与逐字段拒', () => {
  assert.equal(validateMessage(frameWith({ type: 'handover', payload: { kind: 'offer', version: 3, digest: digestOf, ledger: {} } })).ok, true);
  assert.equal(validateMessage(frameWith({ type: 'handover', payload: { kind: 'accept', version: 3, digest: digestOf } })).ok, true);
  assert.equal(validateMessage(frameWith({ type: 'handover', payload: { kind: 'reject', reason: '忙' } })).ok, true);
  /* 端点互盲修复的加法字段：offer 可选端点全表（旧帧无此字段行为不变；自家新帧不被自家拒收）。 */
  const withEndpoints = { kind: 'offer', version: 3, digest: digestOf, ledger: {}, endpoints: { 'inst-b': { address: '127.0.0.2', port: 7321 } } };
  assert.equal(validateMessage(frameWith({ type: 'handover', payload: withEndpoints })).ok, true, 'offer.endpoints 放行');
  for (const payload of [
    { kind: 'offer', version: 0, digest: digestOf, ledger: {} },
    { kind: 'offer', version: 3, digest: 'zz', ledger: {} },
    { kind: 'offer', version: 3, digest: digestOf },
    { kind: 'accept', version: 3 },
    { kind: 'reject', reason: 42 },
    { kind: 'later' },
    'x',
    { kind: 'offer', version: 3, digest: digestOf, ledger: {}, endpoints: 'x' },
    { kind: 'offer', version: 3, digest: digestOf, ledger: {}, endpoints: { 'bad id!': { address: '127.0.0.2', port: 7321 } } },
    { kind: 'offer', version: 3, digest: digestOf, ledger: {}, endpoints: { 'inst-b': { address: 7, port: 7321 } } },
    { kind: 'offer', version: 3, digest: digestOf, ledger: {}, endpoints: { 'inst-b': { address: '127.0.0.2', port: 0 } } },
  ]) {
    assert.equal(validateMessage(frameWith({ type: 'handover', payload })).ok, false, JSON.stringify(payload).slice(0, 60));
  }
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
  assert.equal(validateMessage(frameWith({ type: 'takeover-init', payload: { kind: 'cancel', reason: '原驿丞恢复应答' } })).ok, true);
  assert.equal(validateMessage(frameWith({ type: 'takeover-init', payload: { kind: 'cancel', reason: 'x'.repeat(201) } })).ok, false);
});

test('治理域 takeover：baseVersion 与 digest 必填、reason 可选', () => {
  assert.equal(validateMessage(frameWith({ type: 'takeover', payload: { baseVersion: 3, digest: digestOf } })).ok, true);
  assert.equal(validateMessage(frameWith({ type: 'takeover', payload: { baseVersion: 3, digest: digestOf, reason: '管理者失联' } })).ok, true);
  assert.equal(validateMessage(frameWith({ type: 'takeover', payload: { baseVersion: 1.5, digest: digestOf } })).ok, false);
  assert.equal(validateMessage(frameWith({ type: 'takeover', payload: { baseVersion: 3 } })).ok, false);
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

test('notice manager-changed：manager 与 version 必填；endpoint 可选且形状受检', () => {
  const manager = { instanceId: 'inst-b', identityName: '主机乙' };
  assert.equal(validateMessage(frameWith({ type: 'notice', payload: { event: 'manager-changed', version: 3, manager } })).ok, true);
  assert.equal(validateMessage(frameWith({ type: 'notice', payload: { event: 'manager-changed', version: 3 } })).ok, false);
  assert.equal(validateMessage(frameWith({ type: 'notice', payload: { event: 'manager-changed', version: 0, manager } })).ok, false);
  /* 端点互盲修复的加法字段：新驿丞端点随通告下发（旧帧无此字段行为不变；自家新帧不被自家拒收）。 */
  const withEndpoint = { event: 'manager-changed', version: 3, manager, endpoint: { address: '127.0.0.2', port: 7321 } };
  assert.equal(validateMessage(frameWith({ type: 'notice', payload: withEndpoint })).ok, true, 'endpoint 放行');
  for (const endpoint of [{ address: '127.0.0.2', port: 0 }, { address: 7, port: 7321 }, 'x', { port: 7321 }, { address: '', port: 7321 }]) {
    assert.equal(validateMessage(frameWith({ type: 'notice', payload: { ...withEndpoint, endpoint } })).ok, false, JSON.stringify(endpoint));
  }
});

test('notice handshake：role / version / takeover / reply 逐字段拒', () => {
  const legal = { event: 'handshake', role: 'member', version: null, takeover: null, reply: false };
  assert.equal(validateMessage(frameWith({ type: 'notice', payload: legal })).ok, true);
  const record = { phase: 'inflight', candidate: { instanceId: 'inst-b', identityName: '主机乙' }, baseVersion: 2 };
  assert.equal(validateMessage(frameWith({ type: 'notice', payload: { ...legal, role: 'manager', version: 3, takeover: record, reply: true } })).ok, true);
  for (const payload of [
    { ...legal, role: 'boss' },
    { ...legal, version: 0 },
    { ...legal, takeover: { phase: 'x', candidate: { instanceId: 'inst-b', identityName: '乙' }, baseVersion: 1 } },
    { ...legal, reply: 'yes' },
  ]) {
    assert.equal(validateMessage(frameWith({ type: 'notice', payload })).ok, false, JSON.stringify(payload).slice(0, 60));
  }
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
