import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostsTool } from '../src/tools/hosts.js';
import { pingTool } from '../src/tools/ping.js';
import { deliveryStatusTool } from '../src/tools/delivery-status.js';
import { statusTool } from '../src/tools/status.js';
import { checkInboxTool } from '../src/tools/check-inbox.js';
import { listCollabsTool, createCollabTool, approveInviteTool, withdrawInviteTool, viewLedgerTool, sendMessageTool, leaveCollabTool, endCollabTool, SEND_MESSAGE_TYPES } from '../src/tools/collab.js';

function contextWith(net) {
  return { version: '0.1.0', instanceId: 'inst-self', dataDir: '/data', logDir: '/data/logs', config: { identityName: '本机', port: 17321 }, net, collab: { stats: () => ({ collabs: 0, byState: {} }) }, startedAt: '2026-10-12T00:00:00.000Z' };
}

async function callTool(tool, args, net) {
  return tool.handler(args, contextWith(net));
}

function collabContextOf(collab) {
  return {
    version: '0.1.0',
    instanceId: 'inst-self',
    dataDir: '/data',
    logDir: '/data/logs',
    config: { identityName: '本机', port: 17321 },
    net: {},
    collab,
    startedAt: '2026-10-12T00:00:00.000Z',
  };
}

async function callCollabTool(tool, args, collab) {
  return tool.handler(args, collabContextOf(collab));
}

/* 假服务：记录调用、按用例注入响应——本文件的目的是工具层的参数形态与输出口径，
 * 业务判定（状态门控 / 冻结白名单）归协作服务自身的用例（collab-service.test.js）。 */
function fakeService(responses = {}) {
  const calls = { list: 0, create: [], approve: [], withdraw: [], view: [], send: [], end: [], leave: [] };
  return {
    calls,
    list() {
      calls.list++;
      return responses.list ?? { collabs: [] };
    },
    async create(input) {
      calls.create.push(input);
      return responses.create ?? { ok: true, collabId: 'collab-1', invited: [{ instanceId: 'inst-b', ok: true, msgId: 'msg-1' }] };
    },
    async approve(input) {
      calls.approve.push(input);
      return responses.approve ?? { ok: true, decision: 'approved' };
    },
    async withdraw(input) {
      calls.withdraw.push(input);
      return responses.withdraw ?? { ok: true, scope: 'single', withdrawn: ['inst-b'] };
    },
    async view(input) {
      calls.view.push(input);
      return responses.view ?? { ok: true, source: 'local', version: 2, ledger: { collabId: 'collab-1', version: 2 } };
    },
    async send(input) {
      calls.send.push(input);
      return responses.send ?? { ok: true, msgId: 'msg-9', tier: 'queued', note: '已排队' };
    },
    async end(input) {
      calls.end.push(input);
      return responses.end ?? { ok: true };
    },
    async leave(input) {
      calls.leave.push(input);
      return responses.leave ?? { ok: true };
    },
  };
}

test('ws_list_hosts：清单输出含首选地址与全部端点', async () => {
  const net = {
    listHosts: async () => ({
      ok: true,
      hosts: [{ instanceId: 'inst-b', identityName: '主机乙', endpoints: [{ address: '127.0.0.2', port: 17321 }, { address: '10.0.0.2', port: 17321 }], collabCount: 2, lastSeenAt: '2026-10-12T00:00:00.000Z' }],
    }),
  };
  const result = await callTool(hostsTool(), {}, net);
  const hosts = JSON.parse(result.content[0].text);
  assert.equal(result.isError, undefined);
  assert.equal(hosts[0].identityName, '主机乙');
  assert.equal(hosts[0].address, '127.0.0.2');
  assert.equal(hosts[0].port, 17321);
  assert.deepEqual(hosts[0].endpoints, ['127.0.0.2:17321', '10.0.0.2:17321']);
  assert.equal(hosts[0].addresses, undefined, '过渡的整地址数组字段已删除（端点为准）');
  assert.equal(hosts[0].collabCount, 2);
});

test('ws_list_hosts：降级 → isError + 明确文案', async () => {
  const net = { listHosts: async () => ({ ok: false, message: '显式端口 17321 被占用——不自动改端口、不递增槽位' }) };
  const result = await callTool(hostsTool(), {}, net);
  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes('不自动改端口'));
});

test('ws_ping：缺参 / 地址非法 → isError（不发探测）', async () => {
  let dialed = 0;
  const net = { pingHost: async () => { dialed++; return { ok: true, reachable: true, rttMs: 1 }; } };
  for (const args of [{}, { address: '', port: 17321 }, { address: 'hostname', port: 17321 }, { address: 42, port: 17321 }]) {
    const result = await callTool(pingTool(), args, net);
    assert.equal(result.isError, true, JSON.stringify(args));
  }
  assert.equal(dialed, 0);
});

test('ws_ping：可达结果以正常结果返回（非工具错误）', async () => {
  const net = { pingHost: async () => ({ ok: true, reachable: true, rttMs: 7 }) };
  const result = await callTool(pingTool(), { address: '127.0.0.2', port: 17321 }, net);
  assert.equal(result.isError, undefined);
  const probed = JSON.parse(result.content[0].text);
  assert.equal(probed.reachable, true);
  assert.equal(probed.rttMs, 7);
});

test('ws_ping：不可达是信息不是错误（reachable=false 正常返回）', async () => {
  const net = { pingHost: async () => ({ ok: true, reachable: false, reason: '探测不可达：连接被拒' }) };
  const result = await callTool(pingTool(), { address: '127.0.0.9', port: 17321 }, net);
  assert.equal(result.isError, undefined);
  const probed = JSON.parse(result.content[0].text);
  assert.equal(probed.reachable, false);
  assert.ok(probed.reason.includes('不可达'));
});

test('ws_ping：降级 → isError + 明确文案', async () => {
  const net = { pingHost: async () => ({ ok: false, message: '显式端口 17321 被占用——不自动改端口、不递增槽位' }) };
  const result = await callTool(pingTool(), { address: '127.0.0.2', port: 17321 }, net);
  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes('不自动改端口'));
});

test('ws_delivery_status：透传查询参数（首尾空白去除后）并输出 JSON', async () => {
  const queries = [];
  const net = {
    deliveryStatus: (query) => {
      queries.push(query);
      return [{ msgId: 'msg-1', collabId: 'collab-1', type: 'notice', toInstanceId: 'inst-b', tier: 'at-peer', expired: false, attempts: 2, createdAt: '2026-10-12T00:00:00.000Z', nextAttemptAt: '2026-10-12T00:00:10.000Z', ackedAt: '2026-10-12T00:00:05.000Z', deliveredAt: null }];
    },
  };
  const result = await callTool(deliveryStatusTool(), { msgId: ' msg-1 ', collabId: ' collab-1 ' }, net);
  assert.deepEqual(queries, [{ msgId: 'msg-1', collabId: 'collab-1' }]);
  const rows = JSON.parse(result.content[0].text);
  assert.equal(rows[0].tier, 'at-peer');
});

test('ws_delivery_status：过滤参数形态非法 → isError（不发查询）', async () => {
  let queried = 0;
  const net = { deliveryStatus: () => { queried++; return []; } };
  for (const args of [{ msgId: 42 }, { msgId: {} }, { collabId: 42 }, { collabId: null }, { msgId: '' }, { msgId: '   ' }]) {
    const result = await callTool(deliveryStatusTool(), args, net);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.ok(result.content[0].text.includes('非空字符串'), JSON.stringify(args));
  }
  assert.equal(queried, 0);
});

test('ws_delivery_status：过滤参数缺省 → 正常查询（不过滤）', async () => {
  const queries = [];
  const net = { deliveryStatus: (query) => { queries.push(query); return []; } };
  const result = await callTool(deliveryStatusTool(), {}, net);
  assert.equal(result.isError, undefined);
  assert.equal(queries.length, 1);
});

test('ws_status：输出含 net 状态块（可用性与计数器）', async () => {
  const net = { status: () => ({ available: true, reason: null, message: '', port: 17321, counters: { discovery: {}, transport: {}, dispatch: {}, inbound: {} } }) };
  const result = await callTool(statusTool(), {}, net);
  const status = JSON.parse(result.content[0].text);
  assert.equal(status.net.available, true);
  assert.equal(status.net.port, 17321);
  assert.equal(status.version, '0.1.0');
});

test('ws_check_inbox：collabId 必填与类型校验（不发查询）', async () => {
  let queried = 0;
  const net = { checkInbox: () => { queried++; return { collabId: 'x', total: 0, returned: 0, messages: [] }; } };
  for (const args of [{}, { collabId: '' }, { collabId: '   ' }, { collabId: 42 }]) {
    const result = await callTool(checkInboxTool(), args, net);
    assert.equal(result.isError, true, JSON.stringify(args));
  }
  assert.equal(queried, 0);
});

test('ws_check_inbox：limit 越界与类型错误 → isError（不发查询）', async () => {
  let queried = 0;
  const net = { checkInbox: () => { queried++; return { collabId: 'x', total: 0, returned: 0, messages: [] }; } };
  for (const limit of [0, 501, 1.5, '50']) {
    const result = await callTool(checkInboxTool(), { collabId: 'collab-1', limit }, net);
    assert.equal(result.isError, true, String(limit));
  }
  assert.equal(queried, 0);
});

test('ws_check_inbox：透传查询并输出 {total, returned, messages}', async () => {
  const queries = [];
  const net = {
    checkInbox: (query) => {
      queries.push(query);
      return { collabId: 'collab-1', total: 1, returned: 1, messages: [{ msgId: 'm-1', payload: { text: '你好' } }] };
    },
  };
  const result = await callTool(checkInboxTool(), { collabId: ' collab-1 ', limit: 3 }, net);
  assert.deepEqual(queries, [{ collabId: 'collab-1', limit: 3 }]);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.total, 1);
  assert.equal(payload.messages[0].msgId, 'm-1');
});

test('ws_ping：port 缺失 / 非法 → isError（不发探测）；合法时透传 {address, port}', async () => {
  const probed = [];
  const net = { pingHost: async (options) => { probed.push(options); return { ok: true, reachable: true, rttMs: 3 }; } };
  for (const args of [{ address: '127.0.0.2' }, { address: '127.0.0.2', port: 0 }, { address: '127.0.0.2', port: 1.5 }, { address: '127.0.0.2', port: '7321' }]) {
    const result = await callTool(pingTool(), args, net);
    assert.equal(result.isError, true, JSON.stringify(args));
  }
  assert.equal(probed.length, 0);
  const ok = await callTool(pingTool(), { address: '127.0.0.2', port: 17321 }, net);
  assert.equal(ok.isError, undefined);
  assert.deepEqual(probed, [{ address: '127.0.0.2', port: 17321 }]);
});

test('ws_list_hosts：输出端点（address / port / 地址:端口 字符串数组）', async () => {
  const net = {
    listHosts: async () => ({
      ok: true,
      hosts: [{ instanceId: 'inst-b', identityName: '主机乙', endpoints: [{ address: '127.0.0.2', port: 17321 }, { address: '127.0.0.3', port: 17321 }], collabCount: 0, lastSeenAt: '2026-10-12T00:00:00.000Z' }],
    }),
  };
  const result = await callTool(hostsTool(), {}, net);
  const hosts = JSON.parse(result.content[0].text);
  assert.equal(hosts[0].address, '127.0.0.2');
  assert.equal(hosts[0].port, 17321);
  assert.deepEqual(hosts[0].endpoints, ['127.0.0.2:17321', '127.0.0.3:17321']);
});

test('ws_status：输出含 site 站点块', async () => {
  const net = { status: () => ({ available: true, reason: null, message: '', port: 17321, counters: { discovery: {}, transport: {}, dispatch: {}, inbound: {} } }) };
  const context = contextWith(net);
  context.site = { mode: 'slot', slot: 2, port: 17322, takeover: false };
  const result = await statusTool().handler({}, context);
  const status = JSON.parse(result.content[0].text);
  assert.deepEqual(status.site, { mode: 'slot', slot: 2, port: 17322, takeover: false });
});

test('ws_list_collabs：透传服务清单（含角色/状态/邀请过期标注字段）', async () => {
  const collab = fakeService({
    list: { collabs: [{ collabId: 'collab-1', name: '联调项目', role: 'member', state: 'proposed', decision: null, expired: false, version: null, memberCount: 2, archived: false }] },
  });
  const result = await callCollabTool(listCollabsTool(), {}, collab);
  assert.equal(result.isError, undefined);
  const listed = JSON.parse(result.content[0].text);
  assert.equal(listed.collabs[0].collabId, 'collab-1');
  assert.equal(listed.collabs[0].expired, false);
  assert.equal(collab.calls.list, 1);
});

test('ws_create_collab：name / topic 缺失或空白 → isError，不调服务', async () => {
  const collab = fakeService();
  const target = { instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.2', port: 17321 };
  for (const args of [{}, { name: '项目' }, { name: '   ', topic: '主题', targets: [target] }, { name: '项目', topic: '', targets: [target] }]) {
    const result = await callCollabTool(createCollabTool(), args, collab);
    assert.equal(result.isError, true, JSON.stringify(args));
  }
  assert.equal(collab.calls.create.length, 0);
});

test('ws_create_collab：targets 形态逐拒（非数组 / 空 / 条目缺字段 / 身份名非法 / port 非整数）', async () => {
  const collab = fakeService();
  const cases = [
    { name: '项目', topic: '主题', targets: 'not-an-array' },
    { name: '项目', topic: '主题', targets: [] },
    { name: '项目', topic: '主题', targets: [{ instanceId: 'inst-b' }] },
    { name: '项目', topic: '主题', targets: [{ instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.1' }] },
    { name: '项目', topic: '主题', targets: [{ instanceId: 'inst-b', identityName: '甲\n乙', address: '127.0.0.1', port: 17321 }] },
    { name: '项目', topic: '主题', targets: [{ instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.1', port: 1.5 }] },
  ];
  for (const args of cases) {
    const result = await callCollabTool(createCollabTool(), args, collab);
    assert.equal(result.isError, true, JSON.stringify(args));
  }
  assert.equal(collab.calls.create.length, 0);
});

test('ws_create_collab：合法 → 透传 trim 后的参数（含身份名）、输出 invited 详情', async () => {
  const collab = fakeService();
  const result = await callCollabTool(createCollabTool(), {
    name: ' 联调项目 ',
    topic: ' 发布联调 ',
    targets: [{ instanceId: 'inst-b', identityName: ' 主机乙 ', address: '127.0.0.2', port: 17321 }],
  }, collab);
  assert.equal(result.isError, undefined);
  assert.deepEqual(collab.calls.create, [{ name: '联调项目', topic: '发布联调', targets: [{ instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.2', port: 17321 }] }]);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.collabId, 'collab-1');
  assert.equal(payload.invited[0].ok, true);
});

test('ws_create_collab：服务业务拒绝 → isError + 原文案', async () => {
  const collab = fakeService({ create: { ok: false, message: '本机参与协作数已达上限（64）——先结束或退出旧协作' } });
  const result = await callCollabTool(createCollabTool(), { name: '项目', topic: '主题', targets: [{ instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.2', port: 17321 }] }, collab);
  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes('上限'));
});

test('ws_approve_invite：collabId 缺失 / approve 非布尔 → isError，不调服务', async () => {
  const collab = fakeService();
  for (const args of [{}, { collabId: 'collab-1' }, { collabId: 'collab-1', approve: 'yes' }, { collabId: '  ', approve: true }]) {
    const result = await callCollabTool(approveInviteTool(), args, collab);
    assert.equal(result.isError, true, JSON.stringify(args));
  }
  assert.equal(collab.calls.approve.length, 0);
});

test('ws_approve_invite：同意与拒绝两态透传（reason 随拒绝）', async () => {
  const collab = fakeService();
  await callCollabTool(approveInviteTool(), { collabId: ' collab-1 ', approve: true }, collab);
  await callCollabTool(approveInviteTool(), { collabId: 'collab-2', approve: false, reason: ' 人手不足 ' }, collab);
  assert.deepEqual(collab.calls.approve, [
    { collabId: 'collab-1', approve: true, reason: undefined },
    { collabId: 'collab-2', approve: false, reason: '人手不足' },
  ]);
});

test('ws_withdraw_invite：target 合法（字符串）与缺省（整条）两形态透传', async () => {
  const collab = fakeService();
  await callCollabTool(withdrawInviteTool(), { collabId: 'collab-1', target: ' inst-b ' }, collab);
  await callCollabTool(withdrawInviteTool(), { collabId: 'collab-1' }, collab);
  assert.deepEqual(collab.calls.withdraw, [
    { collabId: 'collab-1', target: 'inst-b' },
    { collabId: 'collab-1', target: undefined },
  ]);
  const bad = await callCollabTool(withdrawInviteTool(), { collabId: 'collab-1', target: 42 }, collab);
  assert.equal(bad.isError, true);
  assert.equal(collab.calls.withdraw.length, 2);
});

test('ws_view_ledger：合法 → 输出 source / version / ledger；服务拒绝（无快照）→ isError', async () => {
  const collab = fakeService();
  const result = await callCollabTool(viewLedgerTool(), { collabId: 'collab-1' }, collab);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.source, 'local');
  assert.equal(payload.ledger.version, 2);
  assert.deepEqual(collab.calls.view, [{ collabId: 'collab-1' }]);
  const denied = fakeService({ view: { ok: false, message: '管理者离线且本机无快照——没有可读台账' } });
  const deniedResult = await callCollabTool(viewLedgerTool(), { collabId: 'collab-1' }, denied);
  assert.equal(deniedResult.isError, true);
  assert.ok(deniedResult.content[0].text.includes('没有可读台账'));
});

test('ws_view_ledger：collabId 缺失 → isError，不调服务', async () => {
  const collab = fakeService();
  const result = await callCollabTool(viewLedgerTool(), {}, collab);
  assert.equal(result.isError, true);
  assert.equal(collab.calls.view.length, 0);
});

test('ws_send_message：text 缺失 / type 非协作类 / to 非字符串 → isError，不调服务', async () => {
  const collab = fakeService();
  const cases = [
    { collabId: 'collab-1' },
    { collabId: 'collab-1', text: '  ' },
    { collabId: 'collab-1', text: '你好', type: 'invite' },
    { collabId: 'collab-1', text: '你好', to: 42 },
  ];
  for (const args of cases) {
    const result = await callCollabTool(sendMessageTool(), args, collab);
    assert.equal(result.isError, true, JSON.stringify(args));
  }
  assert.equal(collab.calls.send.length, 0);
  assert.deepEqual(SEND_MESSAGE_TYPES, ['topic', 'task', 'progress', 'issue', 'stop', 'reply']);
});

test('ws_send_message：合法 → 透传（type 缺省 reply、to 缺省 undefined）、输出含排队说明', async () => {
  const collab = fakeService();
  const result = await callCollabTool(sendMessageTool(), { collabId: ' collab-1 ', text: ' 请查收 ' }, collab);
  assert.deepEqual(collab.calls.send, [{ collabId: 'collab-1', text: '请查收', type: 'reply', to: undefined }]);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.tier, 'queued');
  assert.ok(payload.note.includes('已排队'));
});

test('ws_send_message：服务拒绝（冻结）→ isError + 原文案', async () => {
  const collab = fakeService({ send: { ok: false, message: '协作已冻结：仅允许读台账 / 裁定 / 退出 / 终止' } });
  const result = await callCollabTool(sendMessageTool(), { collabId: 'collab-1', text: '你好' }, collab);
  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes('冻结'));
});

test('ws_end_collab / ws_leave_collab：合法透传、拒绝路径 isError、缺参不调服务', async () => {
  const collab = fakeService();
  assert.equal((await callCollabTool(endCollabTool(), { collabId: 'collab-1' }, collab)).isError, undefined);
  assert.equal((await callCollabTool(leaveCollabTool(), { collabId: 'collab-1' }, collab)).isError, undefined);
  assert.deepEqual(collab.calls.end, [{ collabId: 'collab-1' }]);
  assert.deepEqual(collab.calls.leave, [{ collabId: 'collab-1' }]);
  assert.equal((await callCollabTool(endCollabTool(), {}, collab)).isError, true);
  const denied = fakeService({ leave: { ok: false, message: '管理席位不可退出——请先结束协作或显式交接' } });
  assert.equal((await callCollabTool(leaveCollabTool(), { collabId: 'collab-1' }, denied)).isError, true);
  assert.equal(collab.calls.end.length, 1);
});
