import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { statusTool } from '../src/tools/status.js';

/* #12 状态视图精简：默认 compact，显式 view:"full" 与既有输出逐字段一致并多 host.resources。
 * 本文件是本条对外契约的判别面：键集、嵌套形状、两视图不变式、空 dispatch 的类型稳定性、
 * 非法 view 的统一错误结构。 */

const RESOURCES = Object.freeze({ freeMemMB: 4096, totalMemMB: 16384, claudeProcs: 2, nodeProcs: 5 });
const NET = Object.freeze({
  available: true,
  reason: null,
  message: 'LAN 正常',
  port: 17321,
  counters: { discovery: { scans: 1 }, transport: {}, dispatch: {}, inbound: {} },
});
const COLLAB_STATS = Object.freeze({
  collabs: 4,
  dispatchCount: 1,
  byState: { active: 2, completed: 1, proposed: 1, terminated: 0 },
  rejectedInvites: 7,
  counters: { seatRemovals: 1 },
});
const DISPATCH_STATUS = Object.freeze({
  collabId: 'dispatch-1',
  name: '批次',
  status: 'active',
  masterSessionId: 'master-1',
  masterSessionCode: 'master-1',
  masterLastSeenAt: '2026-11-02T00:00:00.000Z',
  slaves: [{ sessionId: 'worker-1', sessionCode: 'worker-1', name: 'worker', kind: 'bg' }],
  taskCount: 2,
});

function fakeContext(overrides = {}) {
  const dispatchStatus = overrides.dispatchStatus ?? (() => ({ ok: true, dispatch: DISPATCH_STATUS, persisted: true }));
  const net = overrides.net ?? { status: () => NET };
  const collab = overrides.collab ?? { stats: () => COLLAB_STATS, dispatch: { status: dispatchStatus } };
  return {
    version: '9.9.9',
    instanceId: 'inst-x',
    identityName: '本机',
    dataDir: 'C:/fake-root',
    logDir: 'C:/fake-root/logs',
    config: { identityName: '本机', port: 17321 },
    net,
    collab,
    startedAt: '2026-11-02T03:00:00.000Z',
    site: { mode: 'single', slot: null, port: 17321, takeover: false },
    coreEndpoint: '\\\\.\\pipe\\waystation-core-abcdef12',
    identityDefaulted: true,
    ...overrides,
  };
}

async function callStatus(args, context = fakeContext()) {
  return statusTool({ resourcesOf: () => ({ ...RESOURCES }) }).handler(args, context);
}

function payloadOf(result) {
  return JSON.parse(result.content[0].text);
}

function sortedKeys(value) {
  return Object.keys(value).sort();
}

test('ws_status 缺省 compact：顶层只保留首检字段，viewHint 指向 full', async () => {
  const payload = payloadOf(await callStatus({}));
  assert.deepEqual(sortedKeys(payload), [
    'collab', 'core', 'dispatch', 'host', 'identityName', 'instanceId', 'name', 'net',
    'ok', 'pid', 'site', 'startedAt', 'version', 'viewHint',
  ]);
  assert.equal(payload.ok, true);
  assert.equal(payload.version, '9.9.9');
  assert.equal(payload.name, 'waystation');
  assert.equal(payload.identityName, '本机');
  assert.equal(payload.instanceId, 'inst-x');
  assert.equal(payload.pid, process.pid);
  assert.equal(payload.startedAt, '2026-11-02T03:00:00.000Z');
  assert.equal(payload.viewHint, '完整计数器请用 ws_status { view: "full" }');
});

test('ws_status compact：core / net / collab / host / dispatch 形状按任务书裁剪', async () => {
  const degradedNet = {
    available: false,
    reason: 'occupied',
    message: '端口被占用',
    port: 17321,
    counters: { transport: { attempts: 9 } },
  };
  const payload = payloadOf(await callStatus({}, fakeContext({
    net: { status: () => degradedNet },
    site: null,
  })));
  assert.deepEqual(payload.core, {
    pid: process.pid,
    app: '9.9.9',
    endpoint: '\\\\.\\pipe\\waystation-core-abcdef12',
  }, 'compact core 只含 pid / app / endpoint（degraded 只在 full 出现）');
  assert.deepEqual(payload.net, { available: false, reason: 'occupied' }, 'compact net 只含 available / reason');
  assert.deepEqual(payload.site, null);
  assert.deepEqual(payload.collab, { collabs: 4, active: 2, completed: 1, terminated: 0 },
    'collab 只取 byState 的四项计数，其余键不展开');
  assert.deepEqual(payload.host, { resources: RESOURCES });
  assert.deepEqual(payload.dispatch, DISPATCH_STATUS, 'dispatch 全段原样保留（slaves 供调度长提示词使用）');
  assert.equal(Object.hasOwn(payload, 'identityHint'), false, 'compact 不展开 identityHint');
  for (const fullOnly of ['dataDir', 'logDir', 'configFile', 'port', 'node', 'identityHint']) {
    assert.equal(Object.hasOwn(payload, fullOnly), false, `compact 省略 ${fullOnly}`);
  }
});

test('ws_status full：与既有输出逐字段一致，仅新增 host.resources', async () => {
  const context = fakeContext();
  const payload = payloadOf(await callStatus({ view: 'full' }, context));
  const configFile = join(context.dataDir, 'config.json');
  const identityHint = `身份名未设置：当前使用默认机器名「${context.config.identityName}」——不设置就继续用它，此提醒只出现这一次。`
    + `要自定义请改 ${configFile} 里的 identityName 字段（下次会话生效；本次启动已按该值落盘）。`;
  const { host, ...legacy } = payload;
  assert.deepEqual(legacy, {
    ok: true,
    name: 'waystation',
    version: '9.9.9',
    instanceId: 'inst-x',
    identityName: '本机',
    dataDir: 'C:/fake-root',
    logDir: 'C:/fake-root/logs',
    configFile,
    port: 17321,
    site: { mode: 'single', slot: null, port: 17321, takeover: false },
    pid: process.pid,
    node: process.version,
    startedAt: '2026-11-02T03:00:00.000Z',
    core: {
      pid: process.pid,
      app: '9.9.9',
      endpoint: '\\\\.\\pipe\\waystation-core-abcdef12',
    },
    net: NET,
    collab: COLLAB_STATS,
    dispatch: DISPATCH_STATUS,
    identityHint,
  });
  assert.deepEqual(host, { resources: RESOURCES });
  assert.equal(Object.hasOwn(payload, 'viewHint'), false, 'full 不新增 viewHint（保持既有输出面）');
});

test('ws_status 两视图不变式：ok / version / dispatch.slaves 恒在，dispatch 为空时字段仍在且类型稳定', async () => {
  const active = {
    compact: payloadOf(await callStatus({})),
    full: payloadOf(await callStatus({ view: 'full' })),
  };
  for (const [view, payload] of Object.entries(active)) {
    assert.equal(payload.ok, true, view);
    assert.equal(payload.version, '9.9.9', view);
    assert.equal(Array.isArray(payload.dispatch.slaves), true, `${view}：dispatch.slaves 必须存在`);
  }
  const empty = fakeContext({ dispatchStatus: () => ({ ok: true, dispatch: null, persisted: true }) });
  for (const args of [{}, { view: 'full' }]) {
    const payload = payloadOf(await callStatus(args, empty));
    assert.equal(Object.hasOwn(payload, 'dispatch'), true, 'dispatch 字段不得消失');
    assert.equal(payload.dispatch, null, '无调度时稳定为 null');
  }
});

test('ws_status：非法 view 返回统一错误结构 invalid-view', async () => {
  for (const view of ['FULL', 'full ', '', 'detail', 1, null, true, {}]) {
    const result = await callStatus({ view });
    assert.equal(result.isError, true, JSON.stringify(view));
    const payload = payloadOf(result);
    assert.equal(payload.ok, false);
    assert.equal(payload.code, 'invalid-view');
    assert.equal(typeof payload.message, 'string');
    assert.equal(typeof payload.hint, 'string');
    assert.ok(payload.hint.includes('compact') && payload.hint.includes('full'), 'hint 给出两个合法取值');
  }
});

test('ws_status compact：无核心端点时不伪造 core 字段', async () => {
  const context = fakeContext({ coreEndpoint: undefined });
  const payload = payloadOf(await callStatus({}, context));
  assert.equal(Object.hasOwn(payload, 'core'), false);
  assert.equal(payload.site.mode, 'single');
});
