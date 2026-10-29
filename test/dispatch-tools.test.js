import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDispatchNode } from './helpers/dispatch.js';
import { dispatchApproveTool, dispatchClaimTool, dispatchReleaseTool, dispatchScanTool } from '../src/tools/dispatch.js';

function contextOf(node, sessionId) {
  return { collab: node.service, sessionId };
}

test('ws_dispatch_scan：无会话标识拒绝；master 返回 sessions', async (t) => {
  const node = makeDispatchNode(t);
  node.service.create({ mode: 'dispatch', name: '工具', sessionId: 'master-1' });
  const denied = await dispatchScanTool().handler({}, contextOf(node, ''));
  assert.equal(denied.isError, true);
  const scanned = await dispatchScanTool().handler({}, contextOf(node, 'master-1'));
  assert.equal(scanned.isError, undefined);
  assert.match(scanned.content[0].text, /"sessionId"/);
});

test('ws_dispatch_claim：非数组拒绝；多目标返回逐项状态', async (t) => {
  const node = makeDispatchNode(t);
  node.service.create({ mode: 'dispatch', name: '工具', sessionId: 'master-1' });
  const bad = await dispatchClaimTool().handler({ sessionIds: 'worker-1' }, contextOf(node, 'master-1'));
  assert.equal(bad.isError, true);
  const result = await dispatchClaimTool().handler({ sessionIds: ['worker-1', 'human-1'] }, contextOf(node, 'master-1'));
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.results.find((entry) => entry.sessionId === 'worker-1').status, 'bound');
  assert.equal(payload.results.find((entry) => entry.sessionId === 'human-1').status, 'pending');
});

test('ws_dispatch_approve：首次返回 needsUserConfirmation，不是纯文案错误', async (t) => {
  const node = makeDispatchNode(t);
  node.service.create({ mode: 'dispatch', name: '工具', sessionId: 'master-1' });
  const claimed = await dispatchClaimTool().handler({ sessionIds: ['human-1'] }, contextOf(node, 'master-1'));
  const claimId = JSON.parse(claimed.content[0].text).results[0].claimId;
  const result = await dispatchApproveTool().handler({ claimId, approve: true }, contextOf(node, 'human-1'));
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.needsUserConfirmation, true);
  assert.equal(typeof payload.confirmToken, 'string');
});

test('ws_dispatch_release：参数形态校验与 master 释放路径', async (t) => {
  const node = makeDispatchNode(t);
  node.service.create({ mode: 'dispatch', name: '工具', sessionId: 'master-1' });
  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1'] });
  const bad = await dispatchReleaseTool().handler({ sessionId: '' }, contextOf(node, 'master-1'));
  assert.equal(bad.isError, true);
  const denied = await dispatchReleaseTool().handler({ sessionId: 'worker-1' }, contextOf(node, 'human-1'));
  assert.equal(denied.isError, true);
  const released = await dispatchReleaseTool().handler({ sessionId: 'worker-1' }, contextOf(node, 'master-1'));
  assert.equal(released.isError, undefined);
  assert.equal(JSON.parse(released.content[0].text).sessionId, 'worker-1');
});
