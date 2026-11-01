import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchClaimTool } from '../src/tools/dispatch.js';
import { makeDispatchNode } from './helpers/dispatch.js';

/* #14 资源感知（建议型）：claim 返回 warnings，只警告不拒绝。
 * 内存探针经 makeDispatchNode 的 freeMemMB 注入，边界行为确定可复现。 */

function createDispatch(node) {
  const created = node.service.create({ mode: 'dispatch', name: '资源提醒', sessionId: 'master-1' });
  assert.equal(created.ok, true, String(created.message));
}

function withWorker2(node) {
  node.meta.set('worker-2', {
    sessionId: 'worker-2', role: 'slave', name: 'worker-2', kind: 'bg', entrypoint: 'sdk-cli', status: 'idle', metaUpdatedAt: node.now(),
  });
}

function contextOf(node) {
  return {
    version: '0.0.0',
    instanceId: 'inst-self',
    dataDir: node.dataDir,
    logDir: node.dataDir,
    config: { identityName: '本机', port: 7321 },
    net: { status: () => ({ available: true }) },
    collab: node.service,
    sessionId: 'master-1',
    startedAt: '2026-11-02T00:00:00.000Z',
  };
}

test('空闲内存低于 min_free_mem_mb：给出实测数字与释放建议，收编照常生效', (t) => {
  const node = makeDispatchNode(t, {
    freeMemMB: 1024,
    config: { dispatch: { resource_guard: { min_free_mem_mb: 2048 } } },
  });
  createDispatch(node);
  const result = node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1'] });
  assert.equal(result.ok, true);
  assert.equal(result.results[0].status, 'bound', '只警告不拒绝：收编结果不变');
  assert.equal(Array.isArray(result.warnings), true);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /1024/);
  assert.match(result.warnings[0], /2048/);
  assert.match(result.warnings[0], /释放|worker/);
  assert.match(result.warnings[0], /不拒绝|不影响/);
});

test('空闲内存等于阈值：不警告（严格小于才触发）', (t) => {
  const node = makeDispatchNode(t, {
    freeMemMB: 2048,
    config: { dispatch: { resource_guard: { min_free_mem_mb: 2048 } } },
  });
  createDispatch(node);
  const result = node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1'] });
  assert.deepEqual(result.warnings, []);
});

test('组员数达到 max_slaves：给出当前组员数与释放建议', (t) => {
  const node = makeDispatchNode(t, { config: { dispatch: { resource_guard: { max_slaves: 2 } } } });
  withWorker2(node);
  createDispatch(node);
  const result = node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1', 'worker-2'] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.results.map((entry) => entry.status), ['bound', 'bound']);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /组员数 2/);
  assert.match(result.warnings[0], /max_slaves/);
  assert.match(result.warnings[0], /释放/);
});

test('内存探测抛错 / 非有限值：跳过内存提醒，其余提醒照常', (t) => {
  const throwing = makeDispatchNode(t, {
    freeMemMBOf: () => { throw new Error('probe failed'); },
    config: { dispatch: { resource_guard: { min_free_mem_mb: 2048, max_slaves: 1 } } },
  });
  createDispatch(throwing);
  const first = throwing.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1'] });
  assert.equal(first.ok, true);
  assert.deepEqual(first.warnings, ['当前组员数 1 已达 dispatch.resource_guard.max_slaves（1）——建议先释放不用的组员或关闭不用的 worker（仅警告，不拒绝本次收编）']);
  const nonFinite = makeDispatchNode(t, { freeMemMBOf: () => Number.NaN });
  createDispatch(nonFinite);
  assert.deepEqual(nonFinite.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1'] }).warnings, []);
});

test('resource_guard.enabled=false：内存与组员数都不警告', (t) => {
  const node = makeDispatchNode(t, {
    freeMemMB: 1,
    config: { dispatch: { resource_guard: { enabled: false, min_free_mem_mb: 65536, max_slaves: 1 } } },
  });
  withWorker2(node);
  createDispatch(node);
  const result = node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1', 'worker-2'] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings, []);
});

test('ws_dispatch_claim 工具层原样返回 warnings 数组（无警告时为空数组）', async (t) => {
  const node = makeDispatchNode(t, {
    freeMemMB: 512,
    config: { dispatch: { resource_guard: { min_free_mem_mb: 2048 } } },
  });
  createDispatch(node);
  const result = await dispatchClaimTool().handler({ sessionIds: ['worker-1'] }, contextOf(node));
  assert.equal(result.isError, undefined, String(result.content?.[0]?.text));
  const payload = JSON.parse(result.content[0].text);
  assert.equal(Array.isArray(payload.warnings), true);
  assert.equal(payload.warnings.length, 1);
  assert.equal(payload.results[0].status, 'bound');
});

test('无 warning 时工具层仍返回空数组（类型稳定）', async (t) => {
  const node = makeDispatchNode(t, { freeMemMB: 8192 });
  createDispatch(node);
  const result = await dispatchClaimTool().handler({ sessionIds: ['worker-1'] }, contextOf(node));
  const payload = JSON.parse(result.content[0].text);
  assert.deepEqual(payload.warnings, []);
});
