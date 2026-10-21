import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostsTool } from '../src/tools/hosts.js';
import { pingTool } from '../src/tools/ping.js';
import { deliveryStatusTool } from '../src/tools/delivery-status.js';
import { statusTool } from '../src/tools/status.js';
import { checkInboxTool } from '../src/tools/check-inbox.js';
import { listCollabsTool, createCollabTool, inviteTool, requestJoinTool, approveInviteTool, allowNextInviteTool, withdrawInviteTool, viewLedgerTool, sendMessageTool, setMuteTool, leaveCollabTool, endCollabTool, SEND_MESSAGE_TYPES } from '../src/tools/collab.js';
import { joinTool, approveJoinTool } from '../src/tools/join.js';
import { decideTool, handoverTool, takeOverTool } from '../src/tools/governance.js';
import { createNetStack } from '../src/net/stack.js';
import { MAX_COLLAB_MEMBERS } from '../src/net/protocol.js';
import { CONFIG_FILE_NAME, loadConfig } from '../src/config.js';
import { createCollabService } from '../src/collab/service.js';
import { createJoinsStore } from '../src/collab/joins.js';
import { bindingsFilePath, runDir } from '../src/paths.js';
import { makeTempDir } from './helpers.js';

function contextWith(net, overrides = {}) {
  return {
    version: '0.1.0',
    instanceId: 'inst-self',
    dataDir: '/data',
    logDir: '/data/logs',
    config: { identityName: '本机', port: 17321 },
    net,
    collab: { stats: () => ({ collabs: 0, byState: {} }) },
    activeSessions: () => [],
    startedAt: '2026-10-12T00:00:00.000Z',
    ...overrides,
  };
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
  allowNextInvite: { ok: true, note: '已登记一次性豁免' },
  withdraw: { ok: true, scope: 'single', withdrawn: ['inst-b'] },
  view: { ok: true, source: 'local', version: 2, ledger: { collabId: 'collab-1', version: 2 } },
  send: { ok: true, msgId: 'msg-9', tier: 'queued', note: '已排队' },
  setMute: { ok: true, collabId: 'collab-1', muted: true },
  end: { ok: true },
  leave: { ok: true },
  join: {
    request: { ok: true, collabId: 'collab-1', sessionId: 'session-a-0123456789', mode: 'managed', pending: true },
    approve: { ok: true, collabId: 'collab-1', sessionId: 'newcomer-1', bound: true },
  },
};

function fakeService(responses = {}) {
  const calls = { list: 0, listInputs: [], create: [], invite: [], approve: [], allowNextInvite: [], withdraw: [], view: [], send: [], setMute: [], end: [], leave: [] };
  /* 调用记录 + 响应注入（未注入口径取默认值）：工具层一律 await 结果，同步返回等价。 */
  const record = (name, input) => {
    calls[name].push(input);
    return responses[name] ?? SERVICE_DEFAULTS[name];
  };
  return {
    calls,
    list(input) {
      calls.list++;
      calls.listInputs.push(input);
      return responses.list ?? SERVICE_DEFAULTS.list;
    },
    create: (input) => record('create', input),
    invite: (input) => record('invite', input),
    approve: (input) => record('approve', input),
    allowNextInvite: (input) => record('allowNextInvite', input),
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

test('ws_list_hosts：participants 三态（支持 / 不支持 / 未知）逐条呈现', async () => {
  const base = { identityName: '主机', endpoints: [{ address: '127.0.0.2', port: 17321 }], collabCount: 0, lastSeenAt: '2026-10-12T00:00:00.000Z' };
  const net = {
    listHosts: async () => ({
      ok: true,
      hosts: [
        { ...base, instanceId: 'inst-new', participants: 2 },
        { ...base, instanceId: 'inst-old', participants: 0 },
        { ...base, instanceId: 'inst-unknown' },
      ],
    }),
  };
  const result = await callTool(hostsTool(), {}, net);
  const hosts = JSON.parse(result.content[0].text).hosts;
  assert.deepEqual(hosts.map((host) => host.participants), ['supported', 'unsupported', 'unknown']);
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

test('ws_delivery_status：按 msgId 走服务面机器级行并按本会话取席位明细', async () => {
  const row = { msgId: 'msg-1', collabId: 'collab-1', type: 'notice', toInstanceId: 'inst-b', fromSessionId: 'session-a-0123456789', tier: 'at-peer', expired: false, attempts: 2, createdAt: '2026-10-12T00:00:00.000Z', nextAttemptAt: '2026-10-12T00:00:10.000Z', ackedAt: '2026-10-12T00:00:05.000Z', deliveredAt: null };
  const calls = { machine: [], seat: [] };
  const collab = {
    deliveryStatusOf: (msgId) => {
      calls.machine.push(msgId);
      return row;
    },
    localSeatDeliveryOf: (msgId, sessionId) => {
      calls.seat.push({ msgId, sessionId });
      return { collabId: 'collab-1', msgId, sessionId, status: 'injected', complete: true };
    },
  };
  const net = { deliveryStatus: () => { throw new Error('msgId 查询应走服务面'); } };
  const result = await deliveryStatusTool().handler({ msgId: ' msg-1 ' }, contextWith(net, { collab, sessionId: 'session-a-0123456789' }));
  assert.deepEqual(calls.machine, ['msg-1']);
  assert.deepEqual(calls.seat, [{ msgId: 'msg-1', sessionId: 'session-a-0123456789' }]);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.ok, true);
  assert.equal(payload.rows[0].tier, 'at-peer');
  assert.equal(payload.rows[0].fromSessionId, 'session-a-0123456789', '零成功行仍说明原发件会话');
  assert.equal(payload.localSeat.status, 'injected');
});

test('ws_delivery_status：服务面无该 msgId 时回退机器级列表（论坛直投短时记录不丢）', async () => {
  const directRow = { msgId: 'post-1', collabId: 'collab-f', type: 'topic', toInstanceId: 'inst-b', fromSessionId: 'session-b-0123456789', tier: 'at-peer', expired: false, attempts: 1, createdAt: '2026-10-12T00:00:00.000Z', nextAttemptAt: '2026-10-12T00:00:10.000Z', ackedAt: null, deliveredAt: null };
  const net = { deliveryStatus: (query) => (query.msgId === 'post-1' ? [directRow] : []) };
  const collab = { deliveryStatusOf: () => null, localSeatDeliveryOf: () => ({ collabId: 'collab-f', msgId: 'post-1', sessionId: 'session-a-0123456789', status: 'unknown', complete: false }) };
  const result = await deliveryStatusTool().handler({ msgId: 'post-1' }, contextWith(net, { collab, sessionId: 'session-a-0123456789' }));
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.rows[0].msgId, 'post-1');
  assert.equal(payload.rows[0].fromSessionId, 'session-b-0123456789');
});

test('ws_delivery_status：无 msgId 时按 collabId 列表查询（不查席位明细）', async () => {
  const queries = [];
  let seatQueries = 0;
  const net = {
    deliveryStatus: (query) => {
      queries.push(query);
      return [{ msgId: 'msg-1', collabId: 'collab-1', type: 'notice', toInstanceId: 'inst-b', tier: 'at-peer', expired: false, attempts: 2, createdAt: '2026-10-12T00:00:00.000Z', nextAttemptAt: '2026-10-12T00:00:10.000Z', ackedAt: null, deliveredAt: null }];
    },
  };
  const collab = {
    deliveryStatusOf: () => { throw new Error('列表查询不应按 msgId 取行'); },
    localSeatDeliveryOf: () => { seatQueries++; return {}; },
  };
  const result = await deliveryStatusTool().handler({ collabId: ' collab-1 ' }, contextWith(net, { collab, sessionId: 'session-a-0123456789' }));
  assert.deepEqual(queries, [{ msgId: undefined, collabId: 'collab-1' }]);
  assert.equal(seatQueries, 0, '列表不以 msgId 逐行查席位（无 msgId 时无明细可查）');
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.rows[0].tier, 'at-peer');
  assert.equal(Object.hasOwn(payload, 'localSeat'), false);
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

test('ws_check_inbox：透传查询（含本会话标识）并输出 {ok, total, returned, messages}', async () => {
  const queries = [];
  const net = {
    checkInbox: (query) => {
      queries.push(query);
      return { collabId: 'collab-1', total: 1, returned: 1, messages: [{ msgId: 'm-1', payload: { text: '你好' } }] };
    },
  };
  const context = contextWith(net, { sessionId: 'session-a-0123456789' });
  const result = await checkInboxTool().handler({ collabId: ' collab-1 ', limit: 3 }, context);
  assert.deepEqual(queries, [{ collabId: 'collab-1', limit: 3, sessionId: 'session-a-0123456789' }], '按本会话过滤（不是全本机会话流水）');
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.total, 1);
  assert.equal(payload.messages[0].msgId, 'm-1');
});

test('ws_check_inbox：无会话标识 → isError 明确拒绝（不得退回全本机收件）', async () => {
  const queries = [];
  const net = { checkInbox: (query) => { queries.push(query); return { collabId: 'collab-1', total: 0, returned: 0, messages: [] }; } };
  for (const context of [contextWith(net), { ...contextWith(net), sessionId: '' }, { ...contextWith(net), sessionId: '   ' }]) {
    const result = await checkInboxTool().handler({ collabId: 'collab-1' }, context);
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes('会话标识'), result.content[0].text);
  }
  assert.equal(queries.length, 0, '拒绝路径不查收件流水（按会话过滤是硬前提）');
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

test('ws_list_hosts：远端条目的 sessions 为会话短码；旧版对端无该字段则省略、零会话如实为空数组', async () => {
  const net = {
    listHosts: async () => ({
      ok: true,
      hosts: [
        { instanceId: 'inst-b', identityName: '主机乙', endpoints: [{ address: '127.0.0.2', port: 17321 }], collabCount: 1, lastSeenAt: '2026-10-12T00:00:00.000Z', sessions: ['9f8e7d6c5b4a3210', 'ab12cd34ef56'] },
        { instanceId: 'inst-old', identityName: '旧版对端', endpoints: [{ address: '127.0.0.3', port: 17321 }], collabCount: 0, lastSeenAt: '2026-10-12T00:00:00.000Z' },
        { instanceId: 'inst-quiet', identityName: '零会话机', endpoints: [{ address: '127.0.0.4', port: 17321 }], collabCount: 0, lastSeenAt: '2026-10-12T00:00:00.000Z', sessions: [] },
      ],
    }),
  };
  const hosts = JSON.parse((await callTool(hostsTool(), {}, net)).content[0].text).hosts;
  assert.deepEqual(hosts[0].sessions, ['9f8e7d6c', 'ab12cd34'], '远端会话以短码呈现（前 8 字符）');
  assert.equal(Object.hasOwn(hosts[1], 'sessions'), false, '旧版对端无该字段：省略而非伪造空数组');
  assert.deepEqual(hosts[2].sessions, [], '对端如实报零会话：空数组在场（与「没报」区分）');
});

test('ws_list_hosts：远端会话段的坏元素（非字符串 / 空串）逐项剔除，不留空串占位', async () => {
  const net = {
    listHosts: async () => ({
      ok: true,
      hosts: [
        { instanceId: 'inst-mixed', identityName: '混合机', endpoints: [{ address: '127.0.0.5', port: 17321 }], collabCount: 1, lastSeenAt: '2026-10-12T00:00:00.000Z', sessions: ['9f8e7d6c5b4a3210', '', null, 42, 'ab12cd34ef56'] },
      ],
    }),
  };
  const hosts = JSON.parse((await callTool(hostsTool(), {}, net)).content[0].text).hosts;
  assert.deepEqual(hosts[0].sessions, ['9f8e7d6c', 'ab12cd34'], '坏元素剔除（短码化产出空串的不留占位）');
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

test('ws_list_collabs：条目按调用会话给出 sessionRole / sessionState（真服务席位面）', async (t) => {
  const dir = makeTempDir(t);
  const service = realCollabServiceOf(dir);
  const created = service.create({ name: '联调项目', topic: '发布联调', targets: [{ instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.2', port: 17321 }], sessionId: 'session-a-0123456789' });
  assert.equal(created.ok, true);
  const own = await listEntryFor(service, created.collabId, 'session-a-0123456789');
  assert.equal(own.sessionRole, 'manager', '创建会话即站长席位');
  assert.equal(own.sessionState, 'member');
  const stranger = await listEntryFor(service, created.collabId, 'session-b-9876543210');
  assert.equal(stranger.sessionRole, null, '未入席会话如实为空（不拿机器角色冒充会话角色）');
  assert.equal(stranger.sessionState, null);
});

/* 真服务夹具（会话字段判定的集成面）：只装配判定所需的最小依赖——获准台账是磁盘真相，
 * 每次列表调用现读；会话绑定按本机席位判定；投递面用假发送（本用例不出网）。 */
function quietLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function realCollabServiceOf(dir, log = quietLog()) {
  return createCollabService({
    dataDir: dir,
    config: { inviteTtlMs: 24 * 60 * 60 * 1000 },
    self: { instanceId: 'inst-self', identityName: '本机', port: 17321 },
    send: () => ({ ok: true, msgId: 'q-1' }),
    knownHosts: { remember: () => {} },
    log,
    syncPeerPicker: () => [],
  });
}

async function listEntryFor(collab, collabId, sessionId) {
  const context = { ...collabContextOf(collab), sessionId };
  const payload = JSON.parse((await listCollabsTool().handler({}, context)).content[0].text);
  return payload.collabs.find((entry) => entry.collabId === collabId);
}

test('ws_list_collabs：freezeReason 服务给了就透传、没给不伪造', async () => {
  const frozen = fakeService({
    list: { collabs: [{ collabId: 'collab-1', name: '联调项目', role: 'member', state: 'frozen', freezeReason: 'manager-offline', memberCount: 2, archived: false }] },
  });
  const listed = JSON.parse((await callCollabTool(listCollabsTool(), {}, frozen)).content[0].text);
  assert.equal(listed.collabs[0].freezeReason, 'manager-offline', '工具层原样透传服务给出的冻结原因');
  const plain = fakeService({ list: { collabs: [{ collabId: 'collab-2', name: '联调项目', role: 'manager', state: 'active', memberCount: 1, archived: false }] } });
  const unfrozen = JSON.parse((await callCollabTool(listCollabsTool(), {}, plain)).content[0].text);
  assert.equal(Object.hasOwn(unfrozen.collabs[0], 'freezeReason'), false, '服务未给该字段时不得凭空补值');
});

test('ws_list_collabs：按调用会话穿参（context 既有注入；无标识会话传 undefined）', async () => {
  const collab = fakeService();
  await listCollabsTool().handler({}, { ...collabContextOf(collab), sessionId: 'session-a-0123456789' });
  await listCollabsTool().handler({}, collabContextOf(collab));
  assert.deepEqual(collab.calls.listInputs.map((input) => input.sessionId), ['session-a-0123456789', undefined], '逐次携本会话标识；无标识会话如实为空');
});

test('ws_list_collabs：sessionGranted / sessionBound 按调用会话判定（获准要全量标识精确命中、绑定看绑定表指向本会话）', async (t) => {
  const dir = makeTempDir(t);
  const service = realCollabServiceOf(dir);
  const created = service.create({ name: '联调项目', topic: '发布联调', targets: [{ instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.2', port: 17321 }], sessionId: 'session-a-0123456789' });
  assert.equal(created.ok, true);
  const grantedSession = 'session-a-0123456789';
  const joins = createJoinsStore({ dataDir: dir, collabId: created.collabId, log: quietLog() });
  assert.equal(joins.addApproval({ instanceId: 'inst-self', sessionId: grantedSession, origin: 'grant', grantedAt: 1, approvedBy: '主机甲' }), true);
  mkdirSync(runDir(dir), { recursive: true });
  writeFileSync(bindingsFilePath(dir), JSON.stringify({ [created.collabId]: { sessionId: grantedSession, bridgeId: 'bridge-1', boundAt: '2026-10-16T00:00:00.000Z', origin: 'create' } }));

  const own = await listEntryFor(service, created.collabId, grantedSession);
  assert.equal(own.sessionGranted, true, '本会话在获准台账');
  assert.equal(own.sessionBound, true, '绑定表指向本会话');

  const other = await listEntryFor(service, created.collabId, 'session-b-9999999999');
  assert.equal(other.sessionGranted, false, '异会话不在获准台账');
  assert.equal(other.sessionBound, false, '绑定表未指向异会话');

  const shortCode = await listEntryFor(service, created.collabId, grantedSession.slice(0, 8));
  assert.equal(shortCode.sessionGranted, false, '短码不是台账键：获准须全量标识精确命中');
  assert.equal(shortCode.sessionBound, false, '短码不等于绑定表里的全量标识');

  const sessionless = await listEntryFor(service, created.collabId, undefined);
  assert.equal(sessionless.sessionGranted, false, '无标识会话：两字段如实判否（字段恒在场）');
  assert.equal(sessionless.sessionBound, false);
});

test('ws_list_collabs：无获准台账 / 无本机席位按空态判否——列表不因读不到台账而失败', async (t) => {
  const dir = makeTempDir(t);
  const service = realCollabServiceOf(dir);
  const created = service.create({ name: '联调项目', topic: '发布联调', targets: [{ instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.2', port: 17321 }], sessionId: 'session-a-0123456789' });
  assert.equal(created.ok, true);
  /* 绑定判据已按席位（设计 §1）：既有判定面在创建会话的席位上成立，未参与会话如实判否。 */
  const stranger = await listEntryFor(service, created.collabId, 'session-z-0123456789');
  assert.equal(stranger.sessionGranted, false, '无获准台账＝未获准');
  assert.equal(stranger.sessionBound, false, '无本机席位＝未绑定');
  const own = await listEntryFor(service, created.collabId, 'session-a-0123456789');
  assert.equal(own.sessionGranted, true, '创建会话获准（写点一 origin:create）');
  assert.equal(own.sessionBound, true, '创建会话即本机席位');
});

/* 会话级写入点（真服务集成面）：创建 / 同意邀请的获准写点（joins.json 台账——adopt 收紧的
 * 唯一判据）与指名邀请的发送面（targetSessionId 落帧载荷的见证）。 */

/* 真服务夹具（可捕获外发帧）：与 realCollabServiceOf 同装配，另记 send 的每条载荷。 */
function capturingServiceOf(t) {
  const dir = makeTempDir(t);
  const sent = [];
  const service = createCollabService({
    dataDir: dir,
    config: { inviteTtlMs: 24 * 60 * 60 * 1000 },
    self: { instanceId: 'inst-self', identityName: '本机', port: 17321 },
    send: (message) => {
      sent.push(message);
      return { ok: true, msgId: `q-${sent.length}` };
    },
    knownHosts: { remember: () => {}, lookup: () => undefined },
    log: quietLog(),
    syncPeerPicker: () => [],
  });
  return { service, sent, dir };
}

test('真服务：创建成功＝发起会话获准（名单席位为准）；无会话标识不写', async (t) => {
  const made = capturingServiceOf(t);
  const sessionId = 'session-a-0123456789';
  const created = made.service.create({ name: '联调项目', topic: '发布联调', targets: [{ instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.2', port: 17321 }], sessionId });
  assert.equal(created.ok, true, created.message);
  /* 0.2.0 的获准权威是共享名单中的活跃席位——approvals 段只作旧档兼容（写侧已退役），
   * 不再用它的写入断言获准事实。 */
  const granted = await listEntryFor(made.service, created.collabId, sessionId);
  assert.equal(granted.sessionGranted, true, '列表的会话视角即见获准（名单席位判据）');
  assert.equal(granted.sessionState, 'member', '创建会话即活跃席位');

  const bare = capturingServiceOf(t);
  const plain = bare.service.create({ name: '联调项目', topic: '发布联调', targets: [{ instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.2', port: 17321 }] });
  assert.equal(plain.ok, false, '无会话标识不得创建协作（创建会话即入席，0.2.0 会话级前提）');
  assert.ok(plain.message.includes('无会话标识'));
});

test('真服务：指名邀请随帧载荷顶层（创建 targets 与增邀同规）；未指名＝字段不在场（发送面）', async (t) => {
  const made = capturingServiceOf(t);
  const created = made.service.create({
    name: '联调项目',
    topic: '发布联调',
    targets: [
      { instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.2', port: 17321 },
      { instanceId: 'inst-c', identityName: '主机丙', address: '127.0.0.3', port: 17321, targetSessionId: 'a1b2c3d4' },
    ],
    sessionId: 'session-a-0123456789',
  });
  assert.equal(created.ok, true, created.message);
  const invites = made.sent.filter((frame) => frame.type === 'invite');
  assert.equal(invites.length, 2);
  assert.equal(invites[0].payload.targetSessionId, undefined, '未指名：字段不在场（投目标机全部活跃会话）');
  assert.equal(invites[1].payload.targetSessionId, 'a1b2c3d4', '指名：随邀请帧载荷定格（接收侧按它只投目标会话）');
  const bad = await createCollabTool().handler({
    name: '联调项目',
    topic: '发布联调',
    targets: [{ instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.2', port: 17321, targetSessionId: '坏 形态' }],
  }, { ...collabContextOf(made.service) });
  assert.equal(bad.isError, true, '指名会话形态坏：工具层拦下（不得静默丢字段变成广播）');
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
  assert.deepEqual(collab.calls.create, [{ name: '联调项目', topic: '发布联调', targets: [{ instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.2', port: 17321 }], mode: 'managed', sessionId: undefined }], 'sessionId 随本会话上下文穿参（本上下文无标识：如实传空）');
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

function inviteJoinFakeOf(createCalls) {
  return {
    async createInvite(input) {
      createCalls.push(input);
      if (input.targetInstanceId === 'inst-forum') {
        return { ok: false, code: 'forum-no-invite', message: '讨论无邀请簿记' };
      }
      if (input.targetInstanceId === 'inst-bad') {
        return { ok: false, message: '目标已在协作名单内' };
      }
      return { ok: true, inviteId: `inv-${input.targetInstanceId}`, expiresAt: '2026-10-22T00:00:00.000Z', delivery: { ok: true, msgId: `msg-${input.targetInstanceId}` } };
    },
  };
}

test('ws_invite：加入域可用时逐目标签发 inviteId（指名随目标透传、失败目标如实回报）', async () => {
  const createCalls = [];
  const collab = fakeService();
  const context = { ...collabContextOf(collab), join: inviteJoinFakeOf(createCalls), sessionId: 'session-a-0123456789' };
  const result = await inviteTool().handler({
    collabId: ' collab-1 ',
    targets: [
      { instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.2', port: 17321 },
      { instanceId: 'inst-c', identityName: '主机丙', address: '127.0.0.3', port: 17321, targetSessionId: 'sess-c' },
      { instanceId: 'inst-bad', identityName: '主机丁', address: '127.0.0.4', port: 17321 },
    ],
  }, context);
  assert.equal(result.isError, undefined);
  assert.deepEqual(createCalls, [
    { collabId: 'collab-1', managerSessionId: 'session-a-0123456789', targetInstanceId: 'inst-b' },
    { collabId: 'collab-1', managerSessionId: 'session-a-0123456789', targetInstanceId: 'inst-c', targetSessionId: 'sess-c' },
    { collabId: 'collab-1', managerSessionId: 'session-a-0123456789', targetInstanceId: 'inst-bad' },
  ], '邀请簿记按会话签发：管理会话为签发者，指名会话随目标透传');
  const payload = JSON.parse(result.content[0].text);
  assert.deepEqual(payload.invited.map((entry) => [entry.instanceId, entry.inviteId, entry.msgId]), [
    ['inst-b', 'inv-inst-b', 'msg-inst-b'],
    ['inst-c', 'inv-inst-c', 'msg-inst-c'],
    ['inst-bad', undefined, undefined],
  ], '逐目标如实回报（已签发的 inviteId 不因后续失败而丢弃）');
  assert.deepEqual(payload.invited[2], { instanceId: 'inst-bad', ok: false, reason: '目标已在协作名单内' });
});

test('ws_invite：全部目标失败 → isError 并逐目标给出原因（不得 ok:true）', async () => {
  const collab = fakeService();
  const join = {
    async createInvite(input) {
      return input.targetInstanceId === 'inst-b'
        ? { ok: false, message: '只有站长会话可以邀请成员' }
        : { ok: false, message: '该协作已结束（或本机已退出）——不再发起邀请' };
    },
  };
  const context = { ...collabContextOf(collab), join, sessionId: 'session-b-9876543210' };
  const result = await inviteTool().handler({
    collabId: 'collab-1',
    targets: [
      { instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.2', port: 17321 },
      { instanceId: 'inst-c', identityName: '主机丙', address: '127.0.0.3', port: 17321 },
    ],
  }, context);
  assert.equal(result.isError, true, '一个都没签发出＝邀请失败，顶层不得 ok:true');
  const text = result.content[0].text;
  assert.ok(text.includes('邀请全部失败'), text);
  assert.ok(text.includes('inst-b') && text.includes('只有站长会话可以邀请成员'), '逐目标原因（第一项）');
  assert.ok(text.includes('inst-c') && text.includes('已结束'), '逐目标原因（第二项）');
  assert.equal(collab.calls.invite.length, 0, '加入域可用时不静默落回旧邀请面');
});

test('ws_invite：论坛无邀请簿记 → 整批回退旧邀请面（不产生 inviteId）', async () => {
  const createCalls = [];
  const collab = fakeService();
  const context = { ...collabContextOf(collab), join: inviteJoinFakeOf(createCalls), sessionId: 'session-a-0123456789' };
  const target = { instanceId: 'inst-forum', identityName: '论坛乙', address: '127.0.0.2', port: 17321 };
  const forum = await inviteTool().handler({ collabId: 'collab-f', targets: [target] }, context);
  assert.equal(forum.isError, undefined);
  assert.deepEqual(collab.calls.invite, [{ collabId: 'collab-f', targets: [target] }], '论坛回退旧邀请面（不产生 inviteId）');
});

test('ws_invite / ws_withdraw_invite（真服务）：邀请簿记返回 inviteId，撤回按记录生效', async (t) => {
  const dir = makeTempDir(t);
  const service = realCollabServiceOf(dir);
  const sessionId = 'session-a-0123456789';
  const target = { instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.2', port: 17321 };
  const created = service.create({ name: '联调项目', topic: '发布联调', targets: [target], sessionId });
  assert.equal(created.ok, true, created.message);
  const context = { ...collabContextOf(service), join: service.join, sessionId };
  const invited = await inviteTool().handler({ collabId: created.collabId, targets: [target] }, context);
  assert.equal(invited.isError, undefined, invited.content[0].text);
  const payload = JSON.parse(invited.content[0].text);
  assert.ok(typeof payload.invited[0].inviteId === 'string' && payload.invited[0].inviteId !== '', '邀请簿记生成 inviteId（撤回 / 对账的定位键）');
  const withdrawn = await withdrawInviteTool().handler({ collabId: created.collabId, inviteId: payload.invited[0].inviteId }, context);
  assert.equal(withdrawn.isError, undefined, withdrawn.content[0].text);
  assert.equal(JSON.parse(withdrawn.content[0].text).withdrawn, true, '按 inviteId 撤回该条记录');
});

/* 真服务装配面（会话级 0.2.0 的接线前提）：邀请域与生命周期域的导出由 M2/M4/M5 在同批接线，
 * 工具层只消费——这些用例在真实 createCollabService 上跑，防止「假服务绿、真装配空」重演。 */
test('ws_invite（真服务）：非站长会话邀请全部失败 → isError 逐目标原因，不产生邀请记录', async (t) => {
  const dir = makeTempDir(t);
  const service = realCollabServiceOf(dir);
  const target = { instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.2', port: 17321 };
  const created = service.create({ name: '联调项目', topic: '发布联调', targets: [target], sessionId: 'session-a-0123456789' });
  assert.equal(created.ok, true, created.message);
  const context = { ...collabContextOf(service), join: service.join, sessionId: 'session-b-9876543210' };
  const result = await inviteTool().handler({ collabId: created.collabId, targets: [target] }, context);
  assert.equal(result.isError, true, '一个目标也签不出＝工具错误，不得回 ok:true');
  assert.ok(result.content[0].text.includes('邀请全部失败'), result.content[0].text);
  assert.ok(result.content[0].text.includes('没有席位'), '失败原因取自真实席位授权面');
});

test('真服务：交接确认与投递查询入口已接线（走业务拒绝，不是“服务层尚未暴露”）', async (t) => {
  const dir = makeTempDir(t);
  const service = realCollabServiceOf(dir);
  const sessionId = 'session-a-0123456789';
  const target = { instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.2', port: 17321 };
  const created = service.create({ name: '联调项目', topic: '发布联调', targets: [target], sessionId });
  assert.equal(created.ok, true, created.message);
  const context = { ...collabContextOf(service), sessionId };
  const confirm = await handoverTool().handler({ collabId: created.collabId, offerId: 'offer-none' }, context);
  assert.equal(confirm.isError, true);
  assert.ok(confirm.content[0].text.includes('没有该待确认的移交提议'), confirm.content[0].text);
  assert.equal(confirm.content[0].text.includes('confirmHandover'), false, '真装配下确认入口在场（挑战/回执由服务判定）');

  const reject = await handoverTool().handler({ collabId: created.collabId, offerId: 'offer-none', decision: 'reject', reason: '不合适' }, context);
  assert.equal(reject.isError, true);
  assert.ok(reject.content[0].text.includes('没有该待确认的移交提议'), reject.content[0].text);
  assert.equal(reject.content[0].text.includes('rejectHandover'), false, '真装配下拒绝入口在场（异步回执经 await 后给出业务结果）');

  const net = { deliveryStatus: () => [] };
  const status = await deliveryStatusTool().handler({ msgId: 'msg-none' }, { ...context, net });
  const payload = JSON.parse(status.content[0].text);
  assert.equal(payload.localSeat.sessionId, sessionId, '本机席位明细经真实服务面取数');
  assert.equal(payload.localSeat.status, 'unknown', '无投递事实时如实 unknown（不是伪造已注入）');
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

/* —— 会话级加入（ws_join / ws_approve_join）：会话标识取用与参数形态（业务判定归加入域服务） —— */

/* 假加入域：记录调用、按用例注入响应（工具层只做参数形态与会话标识取用，不替服务判决）。 */
function fakeJoinService(responses = {}) {
  const calls = { request: [], approve: [] };
  const record = (name, input) => {
    calls[name].push(input);
    return responses[name] ?? SERVICE_DEFAULTS.join[name];
  };
  return { calls, request: (input) => record('request', input), approve: (input) => record('approve', input) };
}

function joinContextOf(join, sessionId = 'session-a-0123456789') {
  return { ...collabContextOf({}), join, sessionId };
}

test('ws_join：无会话标识 → isError 明确拒（申请以会话为记账单位），不调加入域', async () => {
  const join = fakeJoinService();
  const result = await joinTool().handler({ collabId: 'collab-1' }, joinContextOf(join, ''));
  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes('本会话无会话标识，无法申请加入'), result.content[0].text);
  assert.equal(join.calls.request.length, 0);
});

test('ws_join：collabId 与 name 需给其一（都缺 → isError）；合法透传 trim 值与本会话标识', async () => {
  const join = fakeJoinService();
  const missing = await joinTool().handler({}, joinContextOf(join));
  assert.equal(missing.isError, true);
  assert.ok(missing.content[0].text.includes('collabId'));
  const direct = await joinTool().handler({ collabId: ' collab-1 ' }, joinContextOf(join));
  assert.equal(direct.isError, undefined);
  assert.deepEqual(join.calls.request[0], { collabId: 'collab-1', name: undefined, target: undefined, sessionId: 'session-a-0123456789' });
  const payload = JSON.parse(direct.content[0].text);
  assert.equal(payload.ok, true);
  assert.equal(payload.pending, true);
  const byName = await joinTool().handler({ name: ' 远端项目 ', target: { instanceId: ' inst-b ' } }, joinContextOf(join));
  assert.equal(byName.isError, undefined);
  assert.deepEqual(join.calls.request[1], { collabId: undefined, name: '远端项目', target: { instanceId: 'inst-b' }, sessionId: 'session-a-0123456789' });
});

test('ws_join：target 两形态（{address, port} / {instanceId}）归一透传；形态非法逐拒，不调加入域', async () => {
  const join = fakeJoinService();
  const byAddress = await joinTool().handler({ name: '远端项目', target: { address: ' 127.0.0.2 ', port: 17321 } }, joinContextOf(join));
  assert.equal(byAddress.isError, undefined);
  assert.deepEqual(join.calls.request[0].target, { address: '127.0.0.2', port: 17321 });
  const cases = [
    { name: '项目', target: 42 },
    { name: '项目', target: {} },
    { name: '项目', target: { address: '127.0.0.2' } },
    { name: '项目', target: { address: 'not-an-ip', port: 17321 } },
    { name: '项目', target: { address: '127.0.0.2', port: 1.5 } },
    { name: '项目', target: { instanceId: 'bad id!' } },
    { name: '项目', target: { instanceId: '   ' } },
  ];
  for (const args of cases) {
    const result = await joinTool().handler(args, joinContextOf(join));
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.ok(result.content[0].text.includes('target 非法'), JSON.stringify(args));
  }
  assert.equal(join.calls.request.length, 1, '形态非法在工具层拦下（不触加入域）');
});

test('ws_join：加入域拒绝 → isError + 原文案', async () => {
  const join = fakeJoinService({ request: { ok: false, message: '站长端点未知（协作端点表与已知主机清单都没有该实例）——稍后重试或先 ws_list_hosts 确认对方在线' } });
  const result = await joinTool().handler({ collabId: 'collab-1' }, joinContextOf(join));
  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes('站长端点未知'));
});

test('ws_approve_join：collabId / sessionId / approve 形态逐拒、无会话标识拒，不调加入域', async () => {
  const join = fakeJoinService();
  const sessionless = await approveJoinTool().handler({ collabId: 'collab-1', sessionId: 'newcomer-1', approve: true }, joinContextOf(join, ''));
  assert.equal(sessionless.isError, true);
  assert.ok(sessionless.content[0].text.includes('本会话无会话标识'), sessionless.content[0].text);
  const cases = [
    { sessionId: 'newcomer-1', approve: true },
    { collabId: '  ', sessionId: 'newcomer-1', approve: true },
    { collabId: 'collab-1', approve: true },
    { collabId: 'collab-1', sessionId: '   ', approve: true },
    { collabId: 'collab-1', sessionId: 'newcomer-1' },
    { collabId: 'collab-1', sessionId: 'newcomer-1', approve: 'yes' },
  ];
  for (const args of cases) {
    const result = await approveJoinTool().handler(args, joinContextOf(join));
    assert.equal(result.isError, true, JSON.stringify(args));
  }
  assert.equal(join.calls.approve.length, 0);
});

test('ws_approve_join：批准 / 拒绝两态透传（sessionId 短码原样、approvedBy ＝ 本会话；reason 随拒绝）', async () => {
  const join = fakeJoinService();
  await approveJoinTool().handler({ collabId: ' collab-1 ', sessionId: ' newcome ', approve: true }, joinContextOf(join));
  await approveJoinTool().handler({ collabId: 'collab-2', sessionId: 'newcomer-2', approve: false, reason: ' 名额满了 ' }, joinContextOf(join));
  await approveJoinTool().handler({ collabId: 'collab-3', sessionId: 'newcomer-3', approve: true, reason: '随手填的' }, joinContextOf(join));
  assert.deepEqual(join.calls.approve, [
    { collabId: 'collab-1', sessionId: 'newcome', approve: true, reason: undefined, approvedBy: 'session-a-0123456789', managerSessionId: 'session-a-0123456789' },
    { collabId: 'collab-2', sessionId: 'newcomer-2', approve: false, reason: '名额满了', approvedBy: 'session-a-0123456789', managerSessionId: 'session-a-0123456789' },
    { collabId: 'collab-3', sessionId: 'newcomer-3', approve: true, reason: undefined, approvedBy: 'session-a-0123456789', managerSessionId: 'session-a-0123456789' },
  ], 'approve=true 时 reason 在工具层丢弃（描述口径：仅拒绝时使用）；签发席位随批准者会话');
  const payload = JSON.parse((await approveJoinTool().handler({ collabId: 'collab-1', sessionId: 'newcomer-1', approve: true }, joinContextOf(join))).content[0].text);
  assert.equal(payload.ok, true);
  const denied = fakeJoinService({ approve: { ok: false, message: '该会话没有待批准的加入申请（可能已过期、已处置，或会话标识不符）' } });
  const refused = await approveJoinTool().handler({ collabId: 'collab-1', sessionId: 'newcomer-1', approve: true }, joinContextOf(denied));
  assert.equal(refused.isError, true);
  assert.ok(refused.content[0].text.includes('没有待批准的加入申请'));
});

test('ws_approve_invite：collabId 缺失 / approve 非布尔 → isError，不调服务', async () => {
  const collab = fakeService();
  for (const args of [{}, { collabId: 'collab-1' }, { collabId: 'collab-1', approve: 'yes' }, { collabId: '  ', approve: true }, { collabId: 'collab-1', inviteId: '  ', approve: true }]) {
    const result = await callCollabTool(approveInviteTool(), args, collab);
    assert.equal(result.isError, true, JSON.stringify(args));
  }
  assert.equal(collab.calls.approve.length, 0);
});

test('ws_approve_invite：同意与拒绝两态透传（reason 随拒绝；inviteId / sessionId 随参数与上下文穿参）', async () => {
  const collab = fakeService();
  await callCollabTool(approveInviteTool(), { collabId: ' collab-1 ', approve: true }, collab);
  await callCollabTool(approveInviteTool(), { collabId: 'collab-2', approve: false, reason: ' 人手不足 ' }, collab);
  assert.deepEqual(collab.calls.approve, [
    { collabId: 'collab-1', inviteId: undefined, approve: true, reason: undefined, sessionId: undefined, confirmToken: undefined },
    { collabId: 'collab-2', inviteId: undefined, approve: false, reason: '人手不足', sessionId: undefined, confirmToken: undefined },
  ], '无标识会话如实传空（点头判定由服务面判否）');
  await callCollabTool(approveInviteTool(), { collabId: 'collab-3', approve: true, reason: '随手填的' }, collab);
  assert.deepEqual(collab.calls.approve[2], { collabId: 'collab-3', inviteId: undefined, approve: true, reason: undefined, sessionId: undefined, confirmToken: undefined }, 'approve=true 时 reason 在工具层丢弃（描述口径：仅拒绝时使用）');
  const sessionful = { ...collabContextOf(collab), sessionId: 'session-a-0123456789' };
  await approveInviteTool().handler({ collabId: 'collab-4', inviteId: ' inv-1 ', approve: true }, sessionful);
  assert.deepEqual(collab.calls.approve[3], { collabId: 'collab-4', inviteId: 'inv-1', approve: true, reason: undefined, sessionId: 'session-a-0123456789', confirmToken: undefined }, 'inviteId 定位具体邀请记录、context.sessionId 平铺穿参（点头判定的比对面）');
});

test('ws_withdraw_invite：target 精确撤回透传；inviteId 走加入域簿记（不再报待接线）', async () => {
  const collab = fakeService();
  await callCollabTool(withdrawInviteTool(), { collabId: 'collab-1', target: ' inst-b ' }, collab);
  assert.deepEqual(collab.calls.withdraw, [{ collabId: 'collab-1', target: 'inst-b' }], '只按目标撤回单条记录');
  const missing = await callCollabTool(withdrawInviteTool(), { collabId: 'collab-1' }, collab);
  assert.equal(missing.isError, true);
  assert.ok(missing.content[0].text.includes('ws_end_collab'), '缺定位参数时指向结束协作的唯一入口');

  const withdrawCalls = [];
  const join = { withdrawInvite(input) { withdrawCalls.push(input); return { ok: true, inviteId: input.inviteId, withdrawn: true }; } };
  const context = { ...collabContextOf(collab), join, sessionId: 'session-a-0123456789' };
  const withdrawn = await withdrawInviteTool().handler({ collabId: ' collab-1 ', inviteId: ' inv-1 ' }, context);
  assert.equal(withdrawn.isError, undefined);
  assert.deepEqual(withdrawCalls, [{ collabId: 'collab-1', managerSessionId: 'session-a-0123456789', inviteId: 'inv-1' }], '按记录撤回：inviteId + 签发会话');
  assert.equal(JSON.parse(withdrawn.content[0].text).withdrawn, true);
  const unavailable = await withdrawInviteTool().handler({ collabId: 'collab-1', inviteId: 'inv-1' }, { ...context, join: {} });
  assert.equal(unavailable.isError, true);
  assert.ok(unavailable.content[0].text.includes('join.withdrawInvite'), '加入域面未暴露时明确报错，不静默落回整条撤回');

  const both = await callCollabTool(withdrawInviteTool(), { collabId: 'collab-1', inviteId: 'inv-1', target: 'inst-b' }, collab);
  assert.equal(both.isError, true);
  const badId = await callCollabTool(withdrawInviteTool(), { collabId: 'collab-1', inviteId: '  ' }, collab);
  assert.equal(badId.isError, true);
  const bad = await callCollabTool(withdrawInviteTool(), { collabId: 'collab-1', target: 42 }, collab);
  assert.equal(bad.isError, true);
  assert.equal(collab.calls.withdraw.length, 1, '拒绝路径均未调旧服务（不会被解释为整条取消）');
});

test('ws_view_ledger：合法 → 输出 source / version / ledger；服务拒绝（无快照）→ isError', async () => {
  const collab = fakeService();
  const result = await callCollabTool(viewLedgerTool(), { collabId: 'collab-1' }, collab);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.source, 'local');
  assert.equal(payload.ledger.version, 2);
  assert.deepEqual(collab.calls.view, [{ collabId: 'collab-1' }]);
  const denied = fakeService({ view: { ok: false, message: '站长离线且本机无快照——没有可读台账' } });
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
  assert.deepEqual(collab.calls.send, [{ collabId: 'collab-1', text: '请查收', type: 'reply', to: undefined, toSessionId: undefined, sessionId: undefined }]);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.tier, 'queued');
  assert.ok(payload.note.includes('已排队'));
});

test('ws_send_message：toSessionId 与 to 成对校验、本会话标识随上下文穿参', async () => {
  const collab = fakeService();
  const context = { ...collabContextOf(collab), sessionId: 'session-a-0123456789' };
  const sent = await sendMessageTool().handler({ collabId: 'collab-1', text: '你好', to: 'inst-b', toSessionId: ' deadbeef ' }, context);
  assert.equal(sent.isError, undefined);
  assert.deepEqual(collab.calls.send, [{ collabId: 'collab-1', text: '你好', type: 'reply', to: 'inst-b', toSessionId: 'deadbeef', sessionId: 'session-a-0123456789' }], '定向席位与发送者会话均透传');
  for (const args of [
    { collabId: 'collab-2', text: '你好', toSessionId: 'deadbeef' },
    { collabId: 'collab-3', text: '你好', to: 'inst-b', toSessionId: '  ' },
    { collabId: 'collab-4', text: '你好', to: 'inst-b', toSessionId: 'bad id!' },
  ]) {
    const refused = await callCollabTool(sendMessageTool(), args, collab);
    assert.equal(refused.isError, true, JSON.stringify(args));
  }
  assert.equal(collab.calls.send.length, 1, '拒绝路径不调服务');
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
  const context = { ...collabContextOf(collab), sessionId: 'session-a-0123456789' };
  const ok = await setMuteTool().handler({ collabId: ' collab-1 ', muted: false }, context);
  assert.equal(ok.isError, undefined);
  assert.deepEqual(collab.calls.setMute, [{ collabId: 'collab-1', muted: false, sessionId: 'session-a-0123456789' }], '静音按本会话席位写入（不落整机文件）');
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
  assert.deepEqual(collab.calls.leave, [{ collabId: 'collab-1', sessionId: undefined }], '无会话上下文时如实传空（由服务拒绝，不代签其他会话）');
  assert.equal((await callCollabTool(endCollabTool(), {}, collab)).isError, true);
  const denied = fakeService({ leave: { ok: false, message: '站长席位不可退出——请先结束协作或显式交接' } });
  assert.equal((await callCollabTool(leaveCollabTool(), { collabId: 'collab-1' }, denied)).isError, true);
  assert.equal(collab.calls.end.length, 1);
});

test('ws_leave_collab：透传本会话标识（只退本会话席位，不按首个活跃席位代签）', async () => {
  const collab = fakeService();
  const context = { ...collabContextOf(collab), sessionId: 'session-a-0123456789' };
  const result = await leaveCollabTool().handler({ collabId: 'collab-1' }, context);
  assert.equal(result.isError, undefined);
  assert.deepEqual(collab.calls.leave, [{ collabId: 'collab-1', sessionId: 'session-a-0123456789' }]);
});

/* —— 治理工具集（ws_decide / ws_handover / ws_take_over） —— */

/* 假治理服务：记录调用、按用例注入响应（参数形态与输出口径归本文件；业务判定归协作服务）。 */
function fakeGovernanceService(responses = {}) {
  const calls = { decide: [], decideMerge: [], handover: [], confirmHandover: [], rejectHandover: [], takeOver: [] };
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
      return responses.handover ?? { ok: true, offerId: 'offer-1', message: '已发出移交提议' };
    },
    confirmHandover(input) {
      calls.confirmHandover.push(input);
      return responses.confirmHandover ?? { ok: true, accepted: true, message: '已回执接受' };
    },
    /* 拒绝要发帧回执，真实入口是异步的：假服务保持异步，才能暴露工具层漏 await。 */
    async rejectHandover(input) {
      calls.rejectHandover.push(input);
      return responses.rejectHandover ?? { ok: true, rejected: true, message: '已回执拒绝' };
    },
    async takeOver(input) {
      calls.takeOver.push(input);
      return responses.takeOver ?? { ok: true, applied: true, message: '已接管' };
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

test('ws_handover 站长发起角色：target 与 targetSessionId 均必填、形态逐拒；合法透传两者与本会话标识', async () => {
  const collab = fakeGovernanceService();
  const context = { ...collabContextOf(collab), sessionId: 'session-a-0123456789' };
  for (const args of [
    { collabId: 'collab-1' },
    { collabId: 'collab-1', target: 'inst-b' },
    { collabId: 'collab-1', target: '  ', targetSessionId: 'sess-b' },
    { collabId: 'collab-1', target: 'bad id!', targetSessionId: 'sess-b' },
    { collabId: 'collab-1', target: 'inst-b', targetSessionId: 'bad id!' },
  ]) {
    const result = await handoverTool().handler(args, context);
    assert.equal(result.isError, true, JSON.stringify(args));
  }
  assert.equal(collab.calls.handover.length, 0, '形态非法不触服务');
  const ok = await handoverTool().handler({ collabId: ' collab-1 ', target: ' inst-b ', targetSessionId: ' sess-b ' }, context);
  assert.equal(ok.isError, undefined);
  assert.deepEqual(collab.calls.handover, [{ collabId: 'collab-1', target: 'inst-b', targetSessionId: 'sess-b', sessionId: 'session-a-0123456789' }]);
  assert.equal(JSON.parse(ok.content[0].text).offerId, 'offer-1', '发起立即返回 offerId');
});

test('ws_handover 发起角色：targetSessionId 短码原样透传（解析与匹配归服务层）', async () => {
  const collab = fakeGovernanceService();
  const context = { ...collabContextOf(collab), sessionId: 'session-a-0123456789' };
  const result = await handoverTool().handler({ collabId: 'collab-1', target: 'inst-b', targetSessionId: ' 9f8e7d6c ' }, context);
  assert.equal(result.isError, undefined);
  assert.equal(collab.calls.handover[0].targetSessionId, '9f8e7d6c', '短码不做前缀展开、不换成完整标识（工具层只透传）');
});

test('ws_handover 目标确认角色：offerId+confirmToken 路由 confirmHandover，首次挑战映射为 confirmToken', async () => {
  const confirmCalls = [];
  let response = { ok: true, needsUserConfirmation: true, token: 'tok-1', offerId: 'offer-1', message: '需用户确认：携同一 token 重试' };
  const collab = {
    calls: { confirmHandover: confirmCalls },
    confirmHandover(input) {
      confirmCalls.push(input);
      return response;
    },
  };
  const context = { ...collabContextOf(collab), sessionId: 'session-a-0123456789' };
  const challenged = await handoverTool().handler({ collabId: 'collab-1', offerId: ' offer-1 ' }, context);
  assert.equal(challenged.isError, true, '首次只签发挑战（需用户确认）');
  const payload = JSON.parse(challenged.content[0].text);
  assert.equal(payload.needsUserConfirmation, true);
  assert.equal(payload.confirmToken, 'tok-1', '令牌以 schema 的 confirmToken 字段返回');
  assert.deepEqual(confirmCalls, [{ collabId: 'collab-1', sessionId: 'session-a-0123456789', offerId: 'offer-1', token: undefined }], '目标角色不需要 target');

  response = { ok: true, accepted: true, message: '已回执接受' };
  const accepted = await handoverTool().handler({ collabId: 'collab-1', offerId: 'offer-1', confirmToken: ' tok-1 ' }, context);
  assert.equal(accepted.isError, undefined, '携令牌重试走接受回执');
  assert.deepEqual(confirmCalls.slice(1), [{ collabId: 'collab-1', sessionId: 'session-a-0123456789', offerId: 'offer-1', token: 'tok-1' }]);
  assert.equal(JSON.parse(accepted.content[0].text).accepted, true);

  const unavailable = await handoverTool().handler({ collabId: 'collab-1', offerId: 'offer-1' }, { ...context, collab: {} });
  assert.equal(unavailable.isError, true);
  assert.ok(unavailable.content[0].text.includes('confirmHandover'), '服务入口未接线时明确报错（不静默丢确认）');
});

test('ws_handover 目标拒绝角色：decision=reject 须 reason；无服务入口时明确报错，不落回接受路径', async () => {
  const collab = fakeGovernanceService();
  const context = { ...collabContextOf(collab), sessionId: 'session-a-0123456789' };
  const noReason = await handoverTool().handler({ collabId: 'collab-1', offerId: 'offer-1', decision: 'reject' }, context);
  assert.equal(noReason.isError, true);
  assert.ok(noReason.content[0].text.includes('reason'));
  assert.equal(collab.calls.rejectHandover.length, 0);
  assert.equal(collab.calls.confirmHandover.length, 0);

  const rejected = await handoverTool().handler({ collabId: 'collab-1', offerId: 'offer-1', decision: 'reject', reason: ' 正在发布 ' }, context);
  assert.equal(rejected.isError, undefined);
  assert.deepEqual(collab.calls.rejectHandover, [{ collabId: 'collab-1', sessionId: 'session-a-0123456789', offerId: 'offer-1', reason: '正在发布' }]);
  assert.equal(JSON.parse(rejected.content[0].text).rejected, true, '异步拒绝入口经 await 后完整输出（漏 await 会得到空文案）');
  assert.equal(collab.calls.confirmHandover.length, 0, '拒绝不得落回接受路径');

  const missing = { ...context, collab: fakeGovernanceService() };
  delete missing.collab.rejectHandover;
  const unavailable = await handoverTool().handler({ collabId: 'collab-1', offerId: 'offer-1', decision: 'reject', reason: '不合适' }, missing);
  assert.equal(unavailable.isError, true);
  assert.ok(unavailable.content[0].text.includes('rejectHandover'), '服务入口未接线时明确报错（不静默等超时）');
});

test('ws_handover 角色参数冲突：offerId 与 target/targetSessionId 不可同给；decision/confirmToken 须配 offerId', async () => {
  const collab = fakeGovernanceService();
  for (const args of [
    { collabId: 'collab-1', offerId: 'offer-1', target: 'inst-b' },
    { collabId: 'collab-1', offerId: 'offer-1', target: 'inst-b', targetSessionId: 'sess-b' },
    { collabId: 'collab-1', target: 'inst-b', targetSessionId: 'sess-b', decision: 'accept' },
    { collabId: 'collab-1', target: 'inst-b', targetSessionId: 'sess-b', confirmToken: 'tok-1' },
    { collabId: 'collab-1', offerId: 'offer-1', decision: 'maybe' },
    { collabId: 'collab-1', offerId: 'offer-1', confirmToken: '  ' },
  ]) {
    const result = await callCollabTool(handoverTool(), args, collab);
    assert.equal(result.isError, true, JSON.stringify(args));
  }
  assert.equal(collab.calls.handover.length, 0);
  assert.equal(collab.calls.confirmHandover.length, 0);
});

test('ws_take_over：退役 confirm 一律拒绝；首次挑战映射 confirmToken、重试透传 {collabId,sessionId,token}', async () => {
  const takeOverCalls = [];
  let response = { ok: true, needsUserConfirmation: true, token: 'tok-9', message: '接管需本机用户确认' };
  const collab = {
    calls: { takeOver: takeOverCalls },
    takeOver(input) {
      takeOverCalls.push(input);
      return response;
    },
  };
  const context = { ...collabContextOf(collab), sessionId: 'session-a-0123456789' };
  for (const confirm of [true, false, 'yes']) {
    const retired = await takeOverTool().handler({ collabId: 'collab-1', confirm }, context);
    assert.equal(retired.isError, true, `confirm=${String(confirm)} 已退役`);
  }
  assert.equal(takeOverCalls.length, 0, '退役参数不触服务');
  const challenged = await takeOverTool().handler({ collabId: 'collab-1' }, context);
  assert.equal(challenged.isError, true);
  assert.equal(JSON.parse(challenged.content[0].text).confirmToken, 'tok-9');
  assert.deepEqual(takeOverCalls, [{ collabId: 'collab-1', sessionId: 'session-a-0123456789', token: undefined }]);

  response = { ok: true, applied: true, message: '已接管' };
  const applied = await takeOverTool().handler({ collabId: 'collab-1', confirmToken: ' tok-9 ' }, context);
  assert.equal(applied.isError, undefined);
  assert.deepEqual(takeOverCalls.slice(1), [{ collabId: 'collab-1', sessionId: 'session-a-0123456789', token: 'tok-9' }]);
  assert.equal(JSON.parse(applied.content[0].text).applied, true);

  const denied = fakeGovernanceService({ takeOver: { ok: false, message: '现任站长未被判定失联' } });
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

test('工具返回口径：22 工具成功载荷均为含 ok:true 的 JSON 对象（统一不变量）', async () => {
  const net = fakeNet();
  const collab = fakeService();
  const join = fakeJoinService();
  const governance = fakeGovernanceService();
  const single = { instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.2', port: 17321 };
  const cases = [
    { tool: statusTool(), args: {}, context: contextWith(net) },
    { tool: hostsTool(), args: {}, context: contextWith(net) },
    { tool: pingTool(), args: { address: '127.0.0.2', port: 17321 }, context: contextWith(net) },
    { tool: deliveryStatusTool(), args: {}, context: contextWith(net) },
    { tool: checkInboxTool(), args: { collabId: 'collab-1' }, context: contextWith(net, { sessionId: 'session-a-0123456789' }) },
    { tool: listCollabsTool(), args: {}, context: collabContextOf(collab) },
    { tool: createCollabTool(), args: { name: '项目', topic: '主题', targets: [single] }, context: collabContextOf(collab) },
    { tool: approveInviteTool(), args: { collabId: 'collab-1', inviteId: 'inv-1', approve: true }, context: collabContextOf(collab) },
    { tool: allowNextInviteTool(), args: {}, context: collabContextOf(collab) },
    { tool: withdrawInviteTool(), args: { collabId: 'collab-1', target: 'inst-b' }, context: collabContextOf(collab) },
    { tool: viewLedgerTool(), args: { collabId: 'collab-1' }, context: collabContextOf(collab) },
    { tool: sendMessageTool(), args: { collabId: 'collab-1', text: '你好' }, context: collabContextOf(collab) },
    { tool: setMuteTool(), args: { collabId: 'collab-1', muted: true }, context: collabContextOf(collab) },
    { tool: leaveCollabTool(), args: { collabId: 'collab-1' }, context: collabContextOf(collab) },
    { tool: endCollabTool(), args: { collabId: 'collab-1' }, context: collabContextOf(collab) },
    { tool: inviteTool(), args: { collabId: 'collab-1', targets: [single] }, context: collabContextOf(collab) },
    { tool: requestJoinTool(), args: { name: '讨论甲' }, context: contextWith(net) },
    { tool: joinTool(), args: { collabId: 'collab-1' }, context: joinContextOf(join) },
    { tool: approveJoinTool(), args: { collabId: 'collab-1', sessionId: 'newcomer-1', approve: true }, context: joinContextOf(join) },
    { tool: decideTool(), args: { collabId: 'collab-1', choice: 'keep' }, context: collabContextOf(governance) },
    { tool: handoverTool(), args: { collabId: 'collab-1', target: 'inst-b', targetSessionId: 'sess-b' }, context: collabContextOf(governance) },
    { tool: takeOverTool(), args: { collabId: 'collab-1' }, context: collabContextOf(governance) },
  ];
  assert.equal(cases.length, 22, '覆盖全部 22 工具');
  for (const { tool, args, context } of cases) {
    const result = await tool.handler(args, context);
    assert.equal(result.isError, undefined, tool.name);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.ok, true, tool.name);
  }
});

/* —— 网络装配面（工具面接线）：能力探测转调与 instanceId 透传 ——
 * 未知先探测的闸门在服务层；工具层拿到的只是这里的转调面（不直接触达发现组件）。 */

function capabilityStackOf({ degraded = null } = {}) {
  const calls = [];
  const discovery = {
    start: async () => {},
    announce: () => {},
    close: async () => {},
    stats: () => ({}),
    scan: async () => [],
    probeCapability: async (options) => {
      calls.push({ api: 'probeCapability', options });
      return { capability: 'supported', participants: 2, responder: { instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.2', port: 17321 } };
    },
    requestJoinResolve: async (options) => {
      calls.push({ api: 'requestJoinResolve', options });
      return null;
    },
  };
  const transport = { listen: async () => {}, close: async () => {}, setFrameHandler: () => {}, stats: () => ({}) };
  const dispatch = { start: () => {}, stop: async () => {}, setClientFrameRouter: () => {}, send: () => ({ ok: true }), deliveryStatus: () => [], ping: async () => ({}), stats: () => ({}) };
  const inbound = { start: () => {}, stop: () => {}, onFrame: () => {}, stats: () => ({}) };
  const log = { info: () => {}, warn: () => {}, error: () => {} };
  const stack = createNetStack({ discovery, transport, dispatch, inbound, port: 17321, self: { instanceId: 'inst-self', identityName: '本机', port: 17321 }, scanWindowMs: 250, log, degraded });
  return { stack, calls };
}

test('net stack：probeCapability 转调发现层并透传 instanceId；requestJoinResolve 同样透传', async () => {
  const { stack, calls } = capabilityStackOf();
  await stack.start();
  const probed = await stack.probeCapability({ address: '127.0.0.2', port: 17321, instanceId: 'inst-b' });
  assert.equal(probed.ok, true);
  assert.equal(probed.capability, 'supported');
  assert.deepEqual(calls[0], { api: 'probeCapability', options: { address: '127.0.0.2', port: 17321, instanceId: 'inst-b' } }, 'instanceId 是能力归户证据，必须原样下传');
  const resolved = await stack.requestJoinResolve({ name: '联调讨论', address: '127.0.0.2', port: 17321, instanceId: 'inst-b' });
  assert.deepEqual(resolved, { ok: true, reply: null });
  assert.equal(calls[1].options.instanceId, 'inst-b', '按名解析的实例过滤同样透传');
  await stack.close();
});

test('net stack：probeCapability 形态非法 / 降级 → 明确错误（不触达发现层）', async () => {
  const invalid = capabilityStackOf();
  await invalid.stack.start();
  for (const args of [{}, { address: 'localhost', port: 17321 }, { address: '127.0.0.2', port: 0 }, { address: '127.0.0.2', port: 17321, instanceId: '' }]) {
    const result = await invalid.stack.probeCapability(args);
    assert.equal(result.ok, false, JSON.stringify(args));
  }
  assert.equal(invalid.calls.length, 0, '非法参数在启程前把关');
  await invalid.stack.close();

  const degraded = capabilityStackOf({ degraded: { reason: 'segment-exhausted', message: '端口段全满——本地功能可用' } });
  await degraded.stack.start();
  const skipped = await degraded.stack.probeCapability({ address: '127.0.0.2', port: 17321 });
  assert.equal(skipped.ok, false);
  assert.equal(skipped.message, '端口段全满——本地功能可用');
  assert.equal(degraded.calls.length, 0, '降级态不触达组件');
});
