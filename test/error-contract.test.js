import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDispatchNode } from './helpers/dispatch.js';
import { ERROR_HINTS, FALLBACK_ERROR_HINT, errorOf, errorPayloadOf, isErrorCode } from '../src/util/errors.js';
import { dispatchClaimTool, dispatchReleaseTool, dispatchScanTool } from '../src/tools/dispatch.js';
import { sendMessageTool } from '../src/tools/collab.js';
import { setConfirmGateTool } from '../src/tools/confirm-gate.js';
import { statusTool } from '../src/tools/status.js';
import { SPECS_BY_NAME } from '../src/tools/specs.js';
import { createForwardingRegistry } from '../src/bridge/main.js';

const LONG_SLAVE = 'abcdef12-3456-7890-abcd-ef1234567890';

function contextOf(node, sessionId) {
  return { collab: node.service, sessionId, net: {} };
}

function statusContextOf(node) {
  return {
    version: '0.0.0',
    instanceId: 'inst-status',
    dataDir: node.dataDir,
    logDir: node.dataDir,
    config: { identityName: '本机', port: 17321 },
    net: { status: () => ({ available: true }) },
    collab: node.service,
    startedAt: '2026-11-02T00:00:00.000Z',
    site: null,
  };
}

function payloadOf(result) {
  return JSON.parse(result.content[0].text);
}

function stubLink(overrides = {}) {
  return {
    state: { welcome: null },
    ensureCore: async () => ({ ok: true }),
    call: async () => ({ ok: true, result: { content: [] } }),
    ...overrides,
  };
}

function addLongSlave(node, overrides = {}) {
  node.meta.set(LONG_SLAVE, {
    sessionId: LONG_SLAVE, role: 'slave', name: 'ai-63', kind: 'bg',
    entrypoint: 'sdk-cli', status: 'idle', metaUpdatedAt: node.now(), ...overrides,
  });
}

test('工具描述：scan / status / claim / release / send 标明 sessionCode 口径', () => {
  assert.ok(SPECS_BY_NAME.ws_dispatch_scan.description.includes('sessionCode'));
  assert.ok(SPECS_BY_NAME.ws_dispatch_scan.description.includes('名字'));
  assert.ok(SPECS_BY_NAME.ws_status.description.includes('sessionCode'));
  assert.ok(SPECS_BY_NAME.ws_dispatch_claim.description.includes('sessionCode'));
  assert.ok(SPECS_BY_NAME.ws_dispatch_release.inputSchema.properties.sessionId.description.includes('sessionCode'));
  assert.ok(SPECS_BY_NAME.ws_send_message.inputSchema.properties.toSessionIds.description.includes('sessionCode'));
});

test('错误码表：全部 kebab-case，且每个 code 都有非空修复建议', () => {
  const entries = Object.entries(ERROR_HINTS);
  assert.ok(entries.length >= 30, '错误码表覆盖 dispatch 域与核心常见失败');
  for (const [code, hint] of entries) {
    assert.equal(isErrorCode(code), true, `code 非法：${code}`);
    assert.equal(typeof hint, 'string', `${code} 缺少 hint`);
    assert.ok(hint.trim().length > 0, `${code} 的 hint 不得为空`);
  }
});

test('errorOf：非法 code 回落、message 缺失兜底、显式 hint 覆盖登记建议', () => {
  const invalid = errorOf('Not_A_Code', '');
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'request-rejected');
  assert.equal(typeof invalid.message, 'string');
  assert.equal(typeof invalid.hint, 'string');
  assert.ok(invalid.hint.length > 0);
  const custom = errorOf('dispatch-lost', '调度没了', '先重建调度');
  assert.equal(custom.hint, '先重建调度');
  assert.equal(custom.code, 'dispatch-lost');
});

test('errorOf：未登记但合法的 code 回落通用 hint；errorPayloadOf 保留附加字段', () => {
  const unregistered = errorOf('some-unregistered-code', '自定义失败');
  assert.equal(unregistered.code, 'some-unregistered-code');
  assert.equal(unregistered.hint, FALLBACK_ERROR_HINT);

  const payload = errorPayloadOf({ ok: false, code: 'dispatch-lost', message: '调度没了', extra: '保留' });
  assert.equal(payload.extra, '保留');
  assert.equal(payload.hint, ERROR_HINTS['dispatch-lost']);
  assert.equal(errorPayloadOf(null).code, 'request-rejected');
  assert.equal(isErrorCode(null), false);
});

test('用户确认挑战：isError 载荷同样带 code / hint，且保留 needsUserConfirmation / confirmToken', async () => {
  const context = {
    sessionId: 'session-a',
    collab: {
      setConfirmGate: () => ({
        ok: false, needsUserConfirmation: true, confirmToken: 'tok-1', message: '需向用户确认后重试',
      }),
    },
  };
  const result = await setConfirmGateTool().handler(
    { action: 'set', gate: 'invite', requireConfirmation: false, scope: 'persistent' },
    context,
  );
  assert.equal(result.isError, true);
  const payload = payloadOf(result);
  assert.equal(payload.code, 'user-confirmation-required');
  assert.equal(payload.needsUserConfirmation, true);
  assert.equal(payload.confirmToken, 'tok-1');
  assert.ok(payload.hint.includes('confirmToken'));
});

test('dispatch 工具失败：统一错误四字段（dispatch-lost / session-id-required / 参数校验）', async (t) => {
  const node = makeDispatchNode(t);
  node.service.create({ mode: 'dispatch', name: '错误契约', sessionId: 'master-1' });

  const lost = payloadOf(await dispatchScanTool().handler({}, contextOf(node, 'worker-1')));
  assert.equal(lost.ok, false);
  assert.equal(lost.code, 'dispatch-lost');
  assert.equal(typeof lost.message, 'string');
  assert.equal(typeof lost.hint, 'string');
  assert.ok(lost.hint.includes('ws_status'));

  const noSession = payloadOf(await dispatchScanTool().handler({}, contextOf(node, '')));
  assert.equal(noSession.code, 'session-id-required');

  const badClaim = payloadOf(await dispatchClaimTool().handler({ sessionIds: [] }, contextOf(node, 'master-1')));
  assert.equal(badClaim.code, 'invalid-session-ids');
  assert.ok(badClaim.hint.length > 0);
});

test('收编失败子结果：session-not-visible 与 bridge-stale 各有稳定 code 和修复建议', async (t) => {
  const node = makeDispatchNode(t);
  node.service.create({ mode: 'dispatch', name: '收编错误', sessionId: 'master-1' });
  addLongSlave(node, { online: false, role: 'slave', name: 'stale-bridge' });

  const ghost = payloadOf(await dispatchClaimTool().handler({ sessionIds: ['ghost-1'] }, contextOf(node, 'master-1')));
  const ghostEntry = ghost.results[0];
  assert.equal(ghostEntry.status, 'rejected');
  assert.equal(ghostEntry.code, 'session-not-visible');
  assert.ok(ghostEntry.reason.includes('不在本机注册表'));
  assert.ok(ghostEntry.hint.includes('桥'));

  const stale = payloadOf(await dispatchClaimTool().handler({ sessionIds: ['abcdef12'] }, contextOf(node, 'master-1')));
  assert.equal(stale.results[0].code, 'bridge-stale');
  assert.ok(stale.results[0].hint.includes('桥'));

  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1'] });
  node.meta.delete('worker-1');
  const staleBound = payloadOf(await dispatchClaimTool().handler({ sessionIds: ['worker-1'] }, contextOf(node, 'master-1')));
  assert.equal(staleBound.results[0].code, 'bridge-stale', '已绑定组员的桥断开（仍在宽限内）归 bridge-stale');
  assert.equal(staleBound.results[0].sessionId, 'worker-1');

  /* 同一会话同时出现在 grace 与 slaves（桥断开宽限期）：短码解析必须先去重，不得误判为歧义。 */
  const longBound = 'beefcafe-1111-2222-3333-444455556666';
  node.meta.set(longBound, {
    sessionId: longBound, role: 'slave', name: 'long-bound', kind: 'bg',
    entrypoint: 'sdk-cli', status: 'idle', metaUpdatedAt: node.now(),
  });
  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: [longBound] });
  node.service.dispatch.noteBridgeClosed(longBound, node.now());
  node.meta.delete(longBound);
  const graceClaim = payloadOf(await dispatchClaimTool().handler({ sessionIds: ['beefcafe'] }, contextOf(node, 'master-1')));
  assert.equal(graceClaim.results[0].code, 'bridge-stale');
  assert.equal(graceClaim.results[0].sessionId, longBound);
});

test('scan 与 ws_status dispatch 段：每个会话带稳定短码 sessionCode，名字保留', async (t) => {
  const node = makeDispatchNode(t);
  addLongSlave(node);
  const created = node.service.create({ mode: 'dispatch', name: '短码', sessionId: 'master-1' });
  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: [LONG_SLAVE] });

  const scanned = payloadOf(await dispatchScanTool().handler({}, contextOf(node, 'master-1')));
  const entry = scanned.sessions.find((session) => session.sessionId === LONG_SLAVE);
  assert.equal(entry.sessionCode, 'abcdef12', '短码＝sessionId 前 8 位');
  assert.equal(entry.name, 'ai-63', '名字字段保留');

  const serviceStatus = node.service.dispatch.status().dispatch;
  assert.equal(serviceStatus.masterSessionCode, 'master-1');
  assert.equal(serviceStatus.slaves.find((slave) => slave.sessionId === LONG_SLAVE).sessionCode, 'abcdef12');

  const status = payloadOf(await statusTool().handler({}, statusContextOf(node)));
  assert.equal(status.dispatch.collabId, created.collabId);
  assert.equal(status.dispatch.slaves[0].sessionCode, 'abcdef12');
});

test('短码输入：claim / send / release 接受 sessionCode，并回写完整 sessionId', async (t) => {
  const node = makeDispatchNode(t);
  addLongSlave(node);
  const created = node.service.create({ mode: 'dispatch', name: '短码输入', sessionId: 'master-1' });

  const claimed = payloadOf(await dispatchClaimTool().handler({ sessionIds: ['abcdef12'] }, contextOf(node, 'master-1')));
  assert.equal(claimed.results[0].status, 'bound');
  assert.equal(claimed.results[0].sessionId, LONG_SLAVE);

  const sent = payloadOf(await sendMessageTool().handler({
    collabId: created.collabId, text: '执行', type: 'task', toSessionIds: ['abcdef12'], taskId: 't-1',
  }, contextOf(node, 'master-1')));
  assert.deepEqual(sent.targets, [LONG_SLAVE]);
  assert.equal(sent.delivery.targets[0].status, 'delivered');

  const released = payloadOf(await dispatchReleaseTool().handler({ sessionId: 'abcdef12' }, contextOf(node, 'master-1')));
  assert.equal(released.ok, true);
  assert.equal(released.sessionId, LONG_SLAVE);
});

test('ws_send_message 的 dispatch 失败保留服务层 code/hint，不退化成纯文案', async (t) => {
  const node = makeDispatchNode(t);
  const created = node.service.create({ mode: 'dispatch', name: '消息错误', sessionId: 'master-1' });
  const result = await sendMessageTool().handler(
    { collabId: created.collabId, text: 'x' },
    contextOf(node, 'ghost-session'),
  );
  assert.equal(result.isError, true);
  const payload = payloadOf(result);
  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'session-not-visible');
  assert.ok(payload.hint.includes('桥'));
});

test('dispatch 发送失败：dispatch-empty / target-not-in-dispatch / not-dispatch-member / slave-target-refused', async (t) => {
  const node = makeDispatchNode(t);
  const created = node.service.create({ mode: 'dispatch', name: '发送错误', sessionId: 'master-1' });

  const empty = await node.service.dispatch.send({ collabId: created.collabId, sessionId: 'master-1', text: 'x' });
  assert.equal(empty.code, 'dispatch-empty');

  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1'] });
  const outside = await node.service.dispatch.send({
    collabId: created.collabId, sessionId: 'master-1', text: 'x', toSessionIds: ['ghost-1'],
  });
  assert.equal(outside.code, 'target-not-in-dispatch');
  assert.ok(outside.hint.includes('sessionCode'));

  const outsider = await node.service.dispatch.send({
    collabId: created.collabId, sessionId: 'human-1', text: 'x',
  });
  assert.equal(outsider.code, 'not-dispatch-member');

  const wrongPeer = await node.service.dispatch.send({
    collabId: created.collabId, sessionId: 'worker-1', text: 'x', toSessionIds: ['human-1'],
  });
  assert.equal(wrongPeer.code, 'slave-target-refused');
});

test('桥侧核心失败：unreachable / waiting / version / 未知 kind 各有稳定 code 与 hint', async () => {
  const unreachable = stubLink({ ensureCore: async () => ({ ok: false, kind: 'unreachable', message: '核心无应答或重启中，请重试' }) });
  const unavailable = payloadOf(await createForwardingRegistry({ link: unreachable }).call('ws_list_hosts', {}));
  assert.equal(unavailable.code, 'core-unavailable');
  assert.ok(unavailable.hint.includes('run/core.json'));

  const waiting = stubLink({ ensureCore: async () => ({ ok: false, kind: 'waiting', message: '等待旧版会话退出' }) });
  const status = payloadOf(await createForwardingRegistry({ link: waiting, version: '9.9.9', app: '/app' }).call('ws_status', {}));
  assert.equal(status.code, 'core-unavailable');
  assert.equal(status.core.available, false);
  assert.equal(status.bridge.version, '9.9.9');

  const versioned = stubLink({ call: async () => ({ ok: false, kind: 'version', message: '核心版本不兼容' }) });
  const unsupported = payloadOf(await createForwardingRegistry({ link: versioned }).call('ws_ping', { address: '127.0.0.1', port: 1 }));
  assert.equal(unsupported.code, 'core-version-unsupported');
  assert.equal(unsupported.message, '核心版本不兼容');

  const unknown = stubLink({ ensureCore: async () => ({ ok: false, kind: 'mystery', message: '未知失败' }) });
  const fallback = payloadOf(await createForwardingRegistry({ link: unknown }).call('ws_ping', { address: '127.0.0.1', port: 1 }));
  assert.equal(fallback.code, 'core-unavailable', '未知 kind 回落 core-unavailable');
});
