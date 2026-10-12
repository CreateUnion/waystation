import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostsTool } from '../src/tools/hosts.js';
import { pingTool } from '../src/tools/ping.js';
import { deliveryStatusTool } from '../src/tools/delivery-status.js';
import { statusTool } from '../src/tools/status.js';
import { checkInboxTool } from '../src/tools/check-inbox.js';

function contextWith(net) {
  return { version: '0.1.0', instanceId: 'inst-self', dataDir: '/data', logDir: '/data/logs', config: { identityName: '本机', port: 17321 }, net, startedAt: '2026-10-12T00:00:00.000Z' };
}

async function callTool(tool, args, net) {
  return tool.handler(args, contextWith(net));
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
