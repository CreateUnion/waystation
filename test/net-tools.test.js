import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostsTool } from '../src/tools/hosts.js';
import { pingTool } from '../src/tools/ping.js';
import { deliveryStatusTool } from '../src/tools/delivery-status.js';
import { statusTool } from '../src/tools/status.js';

function contextWith(net) {
  return { version: '0.1.0', instanceId: 'inst-self', dataDir: '/data', logDir: '/data/logs', config: { identityName: '本机', port: 17321 }, net, startedAt: '2026-10-12T00:00:00.000Z' };
}

async function callTool(tool, args, net) {
  return tool.handler(args, contextWith(net));
}

test('ws_list_hosts：清单输出含首选地址与全部地址', async () => {
  const net = {
    listHosts: async () => ({
      ok: true,
      hosts: [{ instanceId: 'inst-b', identityName: '主机乙', addresses: ['127.0.0.2', '10.0.0.2'], collabCount: 2, lastSeenAt: '2026-10-12T00:00:00.000Z' }],
    }),
  };
  const result = await callTool(hostsTool(), {}, net);
  const hosts = JSON.parse(result.content[0].text);
  assert.equal(result.isError, undefined);
  assert.equal(hosts[0].identityName, '主机乙');
  assert.equal(hosts[0].address, '127.0.0.2');
  assert.deepEqual(hosts[0].addresses, ['127.0.0.2', '10.0.0.2']);
  assert.equal(hosts[0].collabCount, 2);
});

test('ws_list_hosts：降级 → isError + 明确文案', async () => {
  const net = { listHosts: async () => ({ ok: false, message: '本机已有驿站会话在监听端口 7321——…' }) };
  const result = await callTool(hostsTool(), {}, net);
  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes('本机已有驿站'));
});

test('ws_ping：缺参 / 地址非法 → isError（不发探测）', async () => {
  let dialed = 0;
  const net = { pingHost: async () => { dialed++; return { ok: true, reachable: true, rttMs: 1 }; } };
  for (const args of [{}, { address: '' }, { address: 'hostname' }, { address: 42 }]) {
    const result = await callTool(pingTool(), args, net);
    assert.equal(result.isError, true, JSON.stringify(args));
  }
  assert.equal(dialed, 0);
});

test('ws_ping：可达结果以正常结果返回（非工具错误）', async () => {
  const net = { pingHost: async () => ({ ok: true, reachable: true, rttMs: 7 }) };
  const result = await callTool(pingTool(), { address: '127.0.0.2' }, net);
  assert.equal(result.isError, undefined);
  const probed = JSON.parse(result.content[0].text);
  assert.equal(probed.reachable, true);
  assert.equal(probed.rttMs, 7);
});

test('ws_ping：不可达是信息不是错误（reachable=false 正常返回）', async () => {
  const net = { pingHost: async () => ({ ok: true, reachable: false, reason: '探测不可达：连接被拒' }) };
  const result = await callTool(pingTool(), { address: '127.0.0.9' }, net);
  assert.equal(result.isError, undefined);
  const probed = JSON.parse(result.content[0].text);
  assert.equal(probed.reachable, false);
  assert.ok(probed.reason.includes('不可达'));
});

test('ws_ping：降级 → isError + 明确文案', async () => {
  const net = { pingHost: async () => ({ ok: false, message: '端口 7321 被其他程序占用…' }) };
  const result = await callTool(pingTool(), { address: '127.0.0.2' }, net);
  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes('被其他程序占用'));
});

test('ws_delivery_status：透传查询参数并输出 JSON', async () => {
  const queries = [];
  const net = {
    deliveryStatus: (query) => {
      queries.push(query);
      return [{ msgId: 'msg-1', collabId: 'collab-1', type: 'notice', toInstanceId: 'inst-b', tier: 'at-peer', expired: false, attempts: 2, createdAt: '2026-10-12T00:00:00.000Z', nextAttemptAt: '2026-10-12T00:00:10.000Z', ackedAt: '2026-10-12T00:00:05.000Z', deliveredAt: null }];
    },
  };
  const result = await callTool(deliveryStatusTool(), { msgId: 'msg-1', collabId: 'collab-1' }, net);
  assert.deepEqual(queries, [{ msgId: 'msg-1', collabId: 'collab-1' }]);
  const rows = JSON.parse(result.content[0].text);
  assert.equal(rows[0].tier, 'at-peer');
});

test('ws_status：输出含 net 状态块（可用性与计数器）', async () => {
  const net = { status: () => ({ available: true, reason: null, message: '', port: 17321, counters: { discovery: {}, transport: {}, dispatch: {}, inbound: {} } }) };
  const result = await callTool(statusTool(), {}, net);
  const status = JSON.parse(result.content[0].text);
  assert.equal(status.net.available, true);
  assert.equal(status.net.port, 17321);
  assert.equal(status.version, '0.1.0');
});
