import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostsTool } from '../src/tools/hosts.js';
import { pingTool } from '../src/tools/ping.js';
import { deliveryStatusTool } from '../src/tools/delivery-status.js';
import { statusTool } from '../src/tools/status.js';
import { checkInboxTool } from '../src/tools/check-inbox.js';
import { listCollabsTool, createCollabTool, inviteTool, requestJoinTool, approveInviteTool, withdrawInviteTool, viewLedgerTool, sendMessageTool, setMuteTool, leaveCollabTool, endCollabTool, SEND_MESSAGE_TYPES } from '../src/tools/collab.js';
import { decideTool, handoverTool, takeOverTool } from '../src/tools/governance.js';
import { MAX_COLLAB_MEMBERS } from '../src/net/protocol.js';
import { CONFIG_FILE_NAME, loadConfig } from '../src/config.js';
import { makeTempDir } from './helpers.js';

function contextWith(net) {
  return { version: '0.1.0', instanceId: 'inst-self', dataDir: '/data', logDir: '/data/logs', config: { identityName: '本机', port: 17321 }, net, collab: { stats: () => ({ collabs: 0, byState: {} }) }, activeSessions: () => [], startedAt: '2026-10-12T00:00:00.000Z' };
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
const SERVICE_DEFAULTS = {
  list: { collabs: [] },
  create: { ok: true, collabId: 'collab-1', invited: [{ instanceId: 'inst-b', ok: true, msgId: 'msg-1' }] },
  invite: { ok: true, collabId: 'collab-1', invited: [{ instanceId: 'inst-b', ok: true, msgId: 'msg-1' }] },
  approve: { ok: true, decision: 'approved' },
  withdraw: { ok: true, scope: 'single', withdrawn: ['inst-b'] },
  view: { ok: true, source: 'local', version: 2, ledger: { collabId: 'collab-1', version: 2 } },
  send: { ok: true, msgId: 'msg-9', tier: 'queued', note: '已排队' },
  setMute: { ok: true, collabId: 'collab-1', muted: true },
  end: { ok: true },
  leave: { ok: true },
};

function fakeService(responses = {}) {
  const calls = { list: 0, create: [], invite: [], approve: [], withdraw: [], view: [], send: [], setMute: [], end: [], leave: [] };
  /* 调用记录 + 响应注入（未注入口径取默认值）：工具层一律 await 结果，同步返回等价。 */
  const record = (name, input) => {
    calls[name].push(input);
    return responses[name] ?? SERVICE_DEFAULTS[name];
  };
  return {
    calls,
    list() {
      calls.list++;
      return responses.list ?? SERVICE_DEFAULTS.list;
    },
    create: (input) => record('create', input),
    invite: (input) => record('invite', input),
    approve: (input) => record('approve', input),
    withdraw: (input) => record('withdraw', input),
    view: (input) => record('view', input),
    send: (input) => record('send', input),
    setMute: (input) => record('setMute', input),
    end: (input) => record('end', input),
    leave: (input) => record('leave', input),
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
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.ok, true);
  const hosts = payload.hosts;
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
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.ok, true);
  assert.equal(payload.rows[0].tier, 'at-peer');
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

test('ws_check_inbox：透传查询并输出 {ok, total, returned, messages}', async () => {
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
  const hosts = JSON.parse(result.content[0].text).hosts;
  assert.equal(hosts[0].address, '127.0.0.2');
  assert.equal(hosts[0].port, 17321);
  assert.deepEqual(hosts[0].endpoints, ['127.0.0.2:17321', '127.0.0.3:17321']);
});

test('ws_list_hosts：载荷含本机段（身份/端口/活跃终端会话与计数；现取——会话变化即反映）', async () => {
  const net = {
    listHosts: async () => ({
      ok: true,
      hosts: [{ instanceId: 'inst-b', identityName: '主机乙', endpoints: [{ address: '127.0.0.2', port: 17321 }], collabCount: 1, lastSeenAt: '2026-10-12T00:00:00.000Z' }],
    }),
  };
  const sessions = [{ sessionId: 'session-a', bridgeId: 'bridge-1', app: '0.1.0', platform: 'win32', pid: 101 }];
  const context = { ...contextWith(net), activeSessions: () => sessions };
  const payload = JSON.parse((await hostsTool().handler({}, context)).content[0].text);
  assert.deepEqual(payload.self, {
    instanceId: 'inst-self',
    identityName: '本机',
    port: 17321,
    sessions: [{ sessionId: 'session-a', bridgeId: 'bridge-1', app: '0.1.0', platform: 'win32', pid: 101 }],
    sessionCount: 1,
  });
  assert.equal(payload.hosts.length, 1, 'hosts 维持「其他驿站」语义不变');
  assert.equal(payload.hosts[0].instanceId, 'inst-b');
  sessions.push({ sessionId: 'session-b', bridgeId: 'bridge-2', app: '0.1.0', platform: 'linux', pid: 202 });
  const again = JSON.parse((await hostsTool().handler({}, context)).content[0].text);
  assert.equal(again.self.sessionCount, 2, '会话集合每次现取（不取样缓存）');
});

test('ws_list_hosts：零活跃终端——本机段如实为零集合（不省略字段）', async () => {
  const net = { listHosts: async () => ({ ok: true, hosts: [] }) };
  const payload = JSON.parse((await callTool(hostsTool(), {}, net)).content[0].text);
  assert.deepEqual(payload.self.sessions, []);
  assert.equal(payload.self.sessionCount, 0);
  assert.deepEqual(payload.hosts, []);
});

test('ws_list_hosts：同机另一数据根条目带 sameMachine 标注（异机为 false，字段恒在场）', async () => {
  const net = {
    listHosts: async () => ({
      ok: true,
      hosts: [
        { instanceId: 'inst-same', identityName: '同机邻居', endpoints: [{ address: '127.0.0.2', port: 17321 }], collabCount: 0, lastSeenAt: '2026-10-12T00:00:00.000Z', sameMachine: true },
        { instanceId: 'inst-remote', identityName: '异机', endpoints: [{ address: '10.0.0.2', port: 17321 }], collabCount: 0, lastSeenAt: '2026-10-12T00:00:00.000Z', sameMachine: false },
      ],
    }),
  };
  const hosts = JSON.parse((await callTool(hostsTool(), {}, net)).content[0].text).hosts;
  assert.equal(hosts[0].sameMachine, true);
  assert.equal(hosts[1].sameMachine, false);
});

test('ws_status：输出含 site 站点块', async () => {
  const net = { status: () => ({ available: true, reason: null, message: '', port: 17321, counters: { discovery: {}, transport: {}, dispatch: {}, inbound: {} } }) };
  const context = contextWith(net);
  context.site = { mode: 'slot', slot: 2, port: 17322, takeover: false };
  const result = await statusTool().handler({}, context);
  const status = JSON.parse(result.content[0].text);
  assert.deepEqual(status.site, { mode: 'slot', slot: 2, port: 17322, takeover: false });
});

test('ws_status：身份未设置（首跑）载荷带 identityHint；预写合法身份名则不带', async (t) => {
  const net = { status: () => ({ available: true, reason: null, message: '', port: 17321, counters: { discovery: {}, transport: {}, dispatch: {}, inbound: {} } }) };
  const fresh = makeTempDir(t);
  const loaded = loadConfig(fresh);
  assert.equal(loaded.identityDefaulted, true, '前置：全新数据目录按未设置读入');
  const freshContext = { ...contextWith(net), dataDir: fresh, config: loaded.config, identityDefaulted: loaded.identityDefaulted };
  const freshStatus = JSON.parse((await statusTool().handler({}, freshContext)).content[0].text);
  assert.equal(typeof freshStatus.identityHint, 'string');
  assert.ok(freshStatus.identityHint.includes(loaded.config.identityName), '提示需含当前机器名值');
  assert.ok(freshStatus.identityHint.includes(join(fresh, CONFIG_FILE_NAME)), '提示需含配置文件路径');
  assert.ok(freshStatus.identityHint.includes('不设置就继续用它') && freshStatus.identityHint.includes('此提醒只出现这一次'));
  assert.ok(freshStatus.identityHint.includes('identityName') && freshStatus.identityHint.includes('下次会话生效'));

  const configured = makeTempDir(t);
  writeFileSync(join(configured, CONFIG_FILE_NAME), JSON.stringify({ identityName: '工位机' }));
  const named = loadConfig(configured);
  assert.equal(named.identityDefaulted, false, '前置：合法身份名不触发');
  const namedContext = { ...contextWith(net), dataDir: configured, config: named.config, identityDefaulted: named.identityDefaulted };
  const namedStatus = JSON.parse((await statusTool().handler({}, namedContext)).content[0].text);
  assert.equal(Object.hasOwn(namedStatus, 'identityHint'), false, '字段有值：一切照旧、无提示');
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
    { name: '项目', topic: '主题', targets: [{ instanceId: 'inst-b', identityName: '主机乙', address: 'not-an-ip', port: 17321 }] },
    { name: '项目', topic: '主题', targets: [{ instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.1', port: 70000 }] },
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
  assert.deepEqual(collab.calls.create, [{ name: '联调项目', topic: '发布联调', targets: [{ instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.2', port: 17321 }], mode: 'managed' }]);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.collabId, 'collab-1');
  assert.equal(payload.invited[0].ok, true);
});

test('ws_create_collab：mode 透传（缺省 managed / 显式 forum）、枚举外拒绝（不触服务）', async () => {
  const collab = fakeService();
  await callCollabTool(createCollabTool(), { name: '项目', topic: '主题', mode: 'forum', targets: [{ instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.2', port: 17321 }] }, collab);
  assert.equal(collab.calls.create[0].mode, 'forum');
  const bad = await callCollabTool(createCollabTool(), { name: '项目', topic: '主题', mode: 'discussion', targets: [{ instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.2', port: 17321 }] }, collab);
  assert.equal(bad.isError, true);
  assert.ok(bad.content[0].text.includes('mode 非法'));
  assert.equal(collab.calls.create.length, 1, '枚举外拒绝不触服务');
});

test('ws_create_collab：服务业务拒绝 → isError + 原文案', async () => {
  const collab = fakeService({ create: { ok: false, message: '本机参与协作数已达上限（64）——先结束或退出旧协作' } });
  const result = await callCollabTool(createCollabTool(), { name: '项目', topic: '主题', targets: [{ instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.2', port: 17321 }] }, collab);
  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes('上限'));
});

test('ws_invite：collabId / targets 形态逐拒（缺参 / 空 / 条目缺字段），不触服务', async () => {
  const collab = fakeService();
  const target = { instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.2', port: 17321 };
  const cases = [
    { targets: [target] },
    { collabId: '  ', targets: [target] },
    { collabId: 'collab-1' },
    { collabId: 'collab-1', targets: [] },
    { collabId: 'collab-1', targets: [{ instanceId: 'inst-b' }] },
    { collabId: 'collab-1', targets: [{ ...target, address: 'not-an-ip' }] },
  ];
  for (const args of cases) {
    const result = await callCollabTool(inviteTool(), args, collab);
    assert.equal(result.isError, true, JSON.stringify(args));
  }
  assert.equal(collab.calls.invite.length, 0);
});

test('ws_invite：合法 → 透传 trim 后的参数、输出 invited 详情；服务拒绝 → isError + 原文案', async () => {
  const collab = fakeService();
  const result = await callCollabTool(inviteTool(), {
    collabId: ' collab-1 ',
    targets: [{ instanceId: 'inst-b', identityName: ' 主机乙 ', address: '127.0.0.2', port: 17321 }],
  }, collab);
  assert.equal(result.isError, undefined);
  assert.deepEqual(collab.calls.invite, [{ collabId: 'collab-1', targets: [{ instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.2', port: 17321 }] }]);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.collabId, 'collab-1');
  assert.equal(payload.invited[0].ok, true);
  const denied = fakeService({ invite: { ok: false, message: '协作模式（managed）的增员补齐另立任务中——ws_invite 当前仅用于讨论模式' } });
  const refused = await callCollabTool(inviteTool(), { collabId: 'collab-1', targets: [{ instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.2', port: 17321 }] }, denied);
  assert.equal(refused.isError, true);
  assert.ok(refused.content[0].text.includes('另立任务'));
});

test('ws_request_join：name 缺失 / 空白 / 非字符串 → isError，不发敲门', async () => {
  const requests = [];
  const net = { requestJoin: async (input) => { requests.push(input); return { ok: true, replies: [] }; } };
  const cases = [{}, { name: '   ' }, { name: 42 }, { name: null }];
  for (const args of cases) {
    const result = await callTool(requestJoinTool(), args, net);
    assert.equal(result.isError, true, JSON.stringify(args));
  }
  assert.equal(requests.length, 0, '非法名在工具层拦下（不触发现层——广播不承载畸形载荷）');
});

test('ws_request_join：合法 → 透传 trim 名并输出应答清单（含不可截字段与截断标注）', async () => {
  const requests = [];
  const replies = [{ collabId: 'collab-1', name: '讨论甲', topic: '议题', memberCount: 2, originator: { instanceId: 'inst-a', identityName: '主机甲' }, topicTruncated: false, nameTruncated: false, responder: { instanceId: 'inst-a', identityName: '主机甲', address: '127.0.0.2', port: 17321 }, replies: 1 }];
  const net = { requestJoin: async (input) => { requests.push(input); return { ok: true, replies }; } };
  const result = await callTool(requestJoinTool(), { name: ' 讨论甲 ' }, net);
  assert.equal(result.isError, undefined);
  assert.deepEqual(requests, [{ name: '讨论甲' }]);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.replies, replies);
  assert.equal(payload.note, undefined, '有应答不带「无应答」提示');
});

test('ws_request_join：无应答 → 正常输出 + 统一提示（不作错误、不自动重试）', async () => {
  const net = { requestJoin: async () => ({ ok: true, replies: [] }) };
  const result = await callTool(requestJoinTool(), { name: '讨论甲' }, net);
  assert.equal(result.isError, undefined, '无应答不是工具错误');
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.replies, []);
  assert.ok(payload.note.includes('未收到任何应答'), payload.note);
  assert.ok(payload.note.includes('ws_invite'), '统一提示给出人工兜底路径（改走对方邀请）');
  assert.ok(payload.note.includes('不做自动重试'), '提示明示不做自动重试（不重试风暴）');
});

test('ws_request_join：服务拒绝（降级等）→ isError + 原文案', async () => {
  const net = { requestJoin: async () => ({ ok: false, message: '局域网监听失败——端口被占用' }) };
  const result = await callTool(requestJoinTool(), { name: '讨论甲' }, net);
  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes('端口被占用'));
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
  await callCollabTool(approveInviteTool(), { collabId: 'collab-3', approve: true, reason: '随手填的' }, collab);
  assert.deepEqual(collab.calls.approve[2], { collabId: 'collab-3', approve: true, reason: undefined }, 'approve=true 时 reason 在工具层丢弃（描述口径：仅拒绝时使用）');
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

test('ws_set_mute：muted 缺失 / 非布尔、collabId 非法 → isError，不调服务；合法透传 trim 值', async () => {
  const collab = fakeService();
  const cases = [
    { collabId: 'collab-1' },
    { collabId: 'collab-1', muted: 'yes' },
    { muted: true },
  ];
  for (const args of cases) {
    const result = await callCollabTool(setMuteTool(), args, collab);
    assert.equal(result.isError, true, JSON.stringify(args));
  }
  assert.equal(collab.calls.setMute.length, 0);
  const ok = await callCollabTool(setMuteTool(), { collabId: ' collab-1 ', muted: false }, collab);
  assert.equal(ok.isError, undefined);
  assert.deepEqual(collab.calls.setMute, [{ collabId: 'collab-1', muted: false }]);
  const payload = JSON.parse(ok.content[0].text);
  assert.equal(payload.collabId, 'collab-1');
  assert.equal(payload.muted, true, 'ok 载荷透传服务的 collabId / muted（桩返回 muted:true）');
  const denied = fakeService({ setMute: { ok: false, message: '本机没有该协作（collabId 不存在）——先看 ws_list_collabs' } });
  const refused = await callCollabTool(setMuteTool(), { collabId: 'collab-9', muted: true }, denied);
  assert.equal(refused.isError, true);
  assert.ok(refused.content[0].text.includes('collabId 不存在'));
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

/* —— 治理工具集（ws_decide / ws_handover / ws_take_over） —— */

/* 假治理服务：记录调用、按用例注入响应（参数形态与输出口径归本文件；业务判定归协作服务）。 */
function fakeGovernanceService(responses = {}) {
  const calls = { decide: [], decideMerge: [], handover: [], takeOver: [] };
  return {
    calls,
    decide(input) {
      calls.decide.push(input);
      return responses.decide ?? { ok: true, choice: 'keep', message: '已解除冻结并广播' };
    },
    decideMerge(input) {
      calls.decideMerge.push(input);
      return responses.decideMerge ?? { ok: true, choice: 'accept', adopted: 2 };
    },
    async handover(input) {
      calls.handover.push(input);
      return responses.handover ?? { ok: true, message: '移交完成' };
    },
    async takeOver(input) {
      calls.takeOver.push(input);
      return responses.takeOver ?? { ok: true, phase: 'awaiting-confirm', message: '待确认' };
    },
  };
}

test('ws_decide：恰提供一种形态（choice / mergeOffer 二者必居其一）', async () => {
  const collab = fakeGovernanceService();
  const withoutForms = await callCollabTool(decideTool(), { collabId: 'collab-1' }, collab);
  assert.equal(withoutForms.isError, true);
  assert.ok(withoutForms.content[0].text.includes('一种形态'));
  const bothForms = await callCollabTool(decideTool(), { collabId: 'collab-1', choice: 'keep', mergeOffer: 'accept' }, collab);
  assert.equal(bothForms.isError, true);
  const badCollab = await callCollabTool(decideTool(), { collabId: '  ' }, collab);
  assert.equal(badCollab.isError, true);
  assert.equal(collab.calls.decide.length, 0);
  assert.equal(collab.calls.decideMerge.length, 0);
});

test('ws_decide：choice 合法透传、枚举外拒绝、服务拒绝 isError', async () => {
  const collab = fakeGovernanceService();
  const kept = await callCollabTool(decideTool(), { collabId: ' collab-1 ', choice: 'keep' }, collab);
  assert.equal(kept.isError, undefined);
  assert.deepEqual(collab.calls.decide, [{ collabId: 'collab-1', choice: 'keep' }]);
  const merged = await callCollabTool(decideTool(), { collabId: 'collab-1', choice: 'merge' }, collab);
  const terminated = await callCollabTool(decideTool(), { collabId: 'collab-1', choice: 'terminate' }, collab);
  assert.equal(merged.isError, undefined);
  assert.equal(terminated.isError, undefined);
  assert.deepEqual(collab.calls.decide, [
    { collabId: 'collab-1', choice: 'keep' },
    { collabId: 'collab-1', choice: 'merge' },
    { collabId: 'collab-1', choice: 'terminate' },
  ]);
  const bad = await callCollabTool(decideTool(), { collabId: 'collab-1', choice: 'maybe' }, collab);
  assert.equal(bad.isError, true);
  const denied = fakeGovernanceService({ decide: { ok: false, message: '只有冻结中的协作需要裁定（当前未冻结）' } });
  assert.equal((await callCollabTool(decideTool(), { collabId: 'collab-1', choice: 'terminate' }, denied)).isError, true);
  assert.equal(collab.calls.decide.length, 3, 'merge / terminate 各透传一次、枚举外拒绝不触服务');
});

test('ws_decide：mergeOffer 合法透传、枚举外拒绝', async () => {
  const collab = fakeGovernanceService();
  const accepted = await callCollabTool(decideTool(), { collabId: 'collab-1', mergeOffer: 'accept' }, collab);
  assert.equal(accepted.isError, undefined);
  assert.deepEqual(collab.calls.decideMerge, [{ collabId: 'collab-1', mergeOffer: 'accept' }]);
  const bad = await callCollabTool(decideTool(), { collabId: 'collab-1', mergeOffer: 'later' }, collab);
  assert.equal(bad.isError, true);
  assert.equal(collab.calls.decideMerge.length, 1);
});

test('ws_handover：target 形态逐拒（缺 / 空 / 非法字符）、合法透传 trim 值', async () => {
  const collab = fakeGovernanceService();
  assert.equal((await callCollabTool(handoverTool(), { collabId: 'collab-1' }, collab)).isError, true);
  assert.equal((await callCollabTool(handoverTool(), { collabId: 'collab-1', target: '  ' }, collab)).isError, true);
  assert.equal((await callCollabTool(handoverTool(), { collabId: 'collab-1', target: 'bad id!' }, collab)).isError, true);
  assert.equal(collab.calls.handover.length, 0);
  const ok = await callCollabTool(handoverTool(), { collabId: ' collab-1 ', target: ' inst-b ' }, collab);
  assert.equal(ok.isError, undefined);
  assert.deepEqual(collab.calls.handover, [{ collabId: 'collab-1', target: 'inst-b' }]);
});

test('ws_take_over：confirm 非布尔拒；缺省发起 / true / false 三态透传', async () => {
  const collab = fakeGovernanceService();
  assert.equal((await callCollabTool(takeOverTool(), { collabId: 'collab-1', confirm: 'yes' }, collab)).isError, true);
  assert.equal(collab.calls.takeOver.length, 0);
  const begun = await callCollabTool(takeOverTool(), { collabId: 'collab-1' }, collab);
  assert.equal(begun.isError, undefined);
  assert.deepEqual(collab.calls.takeOver, [{ collabId: 'collab-1', confirm: undefined }]);
  await callCollabTool(takeOverTool(), { collabId: 'collab-1', confirm: true }, collab);
  await callCollabTool(takeOverTool(), { collabId: 'collab-1', confirm: false }, collab);
  assert.deepEqual(collab.calls.takeOver.slice(1), [{ collabId: 'collab-1', confirm: true }, { collabId: 'collab-1', confirm: false }]);
  const denied = fakeGovernanceService({ takeOver: { ok: false, message: '现任驿丞未被判定失联' } });
  const refused = await callCollabTool(takeOverTool(), { collabId: 'collab-1' }, denied);
  assert.equal(refused.isError, true);
  assert.ok(refused.content[0].text.includes('失联'));
});

test('治理工具输出封装：ok 载荷 JSON 化输出（含仅 ok 的内建字段）', async () => {
  const collab = fakeGovernanceService();
  const decided = await callCollabTool(decideTool(), { collabId: 'collab-1', choice: 'keep' }, collab);
  const payload = JSON.parse(decided.content[0].text);
  assert.equal(payload.choice, 'keep');
  assert.equal(payload.message, '已解除冻结并广播');
});

test('ws_delivery_status：系统回报条目折叠为 reportRows、不进 rows（不静默）', async () => {
  const net = {
    deliveryStatus: () => ([
      { msgId: 'msg-1', collabId: 'collab-1', type: 'notice', toInstanceId: 'inst-b', tier: 'at-peer', expired: false, attempts: 1, createdAt: '2026-10-13T00:00:00.000Z', nextAttemptAt: '2026-10-13T00:00:10.000Z', ackedAt: null, deliveredAt: null },
      { msgId: 'msg-2', collabId: 'collab-1', type: 'delivery-status', toInstanceId: 'inst-b', tier: 'at-peer', expired: false, attempts: 1, createdAt: '2026-10-13T00:00:01.000Z', nextAttemptAt: '2026-10-13T00:00:11.000Z', ackedAt: null, deliveredAt: null },
    ]),
  };
  const result = await callTool(deliveryStatusTool(), {}, net);
  const payload = JSON.parse(result.content[0].text);
  assert.ok(Array.isArray(payload.rows));
  assert.deepEqual(payload.rows.map((row) => row.msgId), ['msg-1'], '回报条目折叠后其余行原样');
  assert.equal(payload.reportRows, 1, '折叠条数以计数报出（不静默）');
});

test('ws_delivery_status：全部条目均为系统回报 → rows 为空数组、reportRows 如实计数（全折叠边界）', async () => {
  const reportRow = (msgId) => ({ msgId, collabId: 'collab-1', type: 'delivery-status', toInstanceId: 'inst-b', tier: 'at-peer', expired: false, attempts: 1, createdAt: '2026-10-13T00:00:00.000Z', nextAttemptAt: '2026-10-13T00:00:10.000Z', ackedAt: null, deliveredAt: null });
  const net = { deliveryStatus: () => [reportRow('msg-r1'), reportRow('msg-r2')] };
  const result = await callTool(deliveryStatusTool(), {}, net);
  const payload = JSON.parse(result.content[0].text);
  assert.ok(Array.isArray(payload.rows));
  assert.deepEqual(payload.rows, [], '全部回报条目折叠后 rows 为空数组');
  assert.equal(payload.reportRows, 2, '折叠条数与查询总数一致（不静默）');
});

test('ws_create_collab：目标上限随 MAX_COLLAB_MEMBERS 派生（上限内合法、越限拒绝）', async () => {
  const collab = fakeService();
  const targetOf = (index) => ({ instanceId: `inst-${index}`, identityName: `主机${index}`, address: '127.0.0.2', port: 17321 });
  const targets = Array.from({ length: MAX_COLLAB_MEMBERS - 1 }, (_, index) => targetOf(index));
  const accepted = await callCollabTool(createCollabTool(), { name: '项目', topic: '主题', targets }, collab);
  assert.equal(accepted.isError, undefined);
  const refused = await callCollabTool(createCollabTool(), { name: '项目', topic: '主题', targets: [...targets, targetOf(99)] }, collab);
  assert.equal(refused.isError, true);
  assert.equal(collab.calls.create.length, 1);
});

/* 口径测试的桩网络：覆盖发现/网络面工具的最低合法返回（含主动加入的应答清单）。 */
function fakeNet() {
  return {
    listHosts: async () => ({ ok: true, hosts: [] }),
    pingHost: async () => ({ ok: true, reachable: true, rttMs: 1 }),
    deliveryStatus: () => [],
    checkInbox: () => ({ collabId: 'collab-1', total: 0, returned: 0, messages: [] }),
    status: () => ({ available: true, reason: null, message: '', port: 17321, counters: {} }),
    requestJoin: async () => ({ ok: true, replies: [] }),
  };
}

test('工具返回口径：19 工具成功载荷均为含 ok:true 的 JSON 对象（统一不变量）', async () => {
  const net = fakeNet();
  const collab = fakeService();
  const governance = fakeGovernanceService();
  const single = { instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.2', port: 17321 };
  const cases = [
    { tool: statusTool(), args: {}, context: contextWith(net) },
    { tool: hostsTool(), args: {}, context: contextWith(net) },
    { tool: pingTool(), args: { address: '127.0.0.2', port: 17321 }, context: contextWith(net) },
    { tool: deliveryStatusTool(), args: {}, context: contextWith(net) },
    { tool: checkInboxTool(), args: { collabId: 'collab-1' }, context: contextWith(net) },
    { tool: listCollabsTool(), args: {}, context: collabContextOf(collab) },
    { tool: createCollabTool(), args: { name: '项目', topic: '主题', targets: [single] }, context: collabContextOf(collab) },
    { tool: approveInviteTool(), args: { collabId: 'collab-1', approve: true }, context: collabContextOf(collab) },
    { tool: withdrawInviteTool(), args: { collabId: 'collab-1' }, context: collabContextOf(collab) },
    { tool: viewLedgerTool(), args: { collabId: 'collab-1' }, context: collabContextOf(collab) },
    { tool: sendMessageTool(), args: { collabId: 'collab-1', text: '你好' }, context: collabContextOf(collab) },
    { tool: setMuteTool(), args: { collabId: 'collab-1', muted: true }, context: collabContextOf(collab) },
    { tool: leaveCollabTool(), args: { collabId: 'collab-1' }, context: collabContextOf(collab) },
    { tool: endCollabTool(), args: { collabId: 'collab-1' }, context: collabContextOf(collab) },
    { tool: inviteTool(), args: { collabId: 'collab-1', targets: [single] }, context: collabContextOf(collab) },
    { tool: requestJoinTool(), args: { name: '讨论甲' }, context: contextWith(net) },
    { tool: decideTool(), args: { collabId: 'collab-1', choice: 'keep' }, context: collabContextOf(governance) },
    { tool: handoverTool(), args: { collabId: 'collab-1', target: 'inst-b' }, context: collabContextOf(governance) },
    { tool: takeOverTool(), args: { collabId: 'collab-1' }, context: collabContextOf(governance) },
  ];
  assert.equal(cases.length, 19, '覆盖全部 19 工具');
  for (const { tool, args, context } of cases) {
    const result = await tool.handler(args, context);
    assert.equal(result.isError, undefined, tool.name);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.ok, true, tool.name);
  }
});
