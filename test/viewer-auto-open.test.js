import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir } from './helpers.js';
import { DEFAULT_VIEWER_PORT, openViewerOnStart, openViewerWindow, viewerConsentNoticeOf } from '../src/viewer/launch.js';
import { createCollabService } from '../src/collab/service.js';
import { CONFIG_FILE_NAME } from '../src/paths.js';

/* 自动开窗的拉起出口（openViewerWindow）与触发 B 判定（openViewerOnStart）的判别用例：
 * 真实临时数据根（config.json 现读）＋spawn/探针桩——绝不真开窗、不起观察窗进程。
 * 纯构造（buildViewerSpawn / viewerRootOf / readViewerAutoOpen 读文件桩 / 进行中筛选）在
 * viewer-launch.test.js；spawn 真脚本的判别面在 viewer-e2e.test.js（--focus 全分支与 detached
 * 存活机器测试）。env 注入统一传 {}（node --test 下进程环境带 NODE_TEST_CONTEXT，会命中
 * 测试上下文闸——各用例显式给出「非测试」环境以走真实 spawn 路径）。 */

const DIGEST = 'abcd1234';

function healthOf(over = {}) {
  return { app: 'waystation-viewer', v: 1, pid: 4242, root: DIGEST, ...over };
}

function captureLog() {
  const warns = [];
  return { warns, warn: (...args) => warns.push(args) };
}

/* spawn 桩：记账调用，返回可派发 error/exit 的假子进程（unref 记账）。 */
function fakeSpawn() {
  const calls = [];
  const children = [];
  const spawnFn = (command, args, options) => {
    const handlers = new Map();
    const child = {
      unrefed: false,
      on: (event, handler) => handlers.set(event, handler),
      unref: () => {
        child.unrefed = true;
      },
    };
    calls.push({ command, args, options });
    children.push({ handlers, child });
    return child;
  };
  return { calls, children, spawnFn };
}

function writeConfig(dir, config) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, CONFIG_FILE_NAME), JSON.stringify(config));
}

/* 触发 A 的出入口形态（ref＝root/id）：测试统一走该包装，逐用例只改关心的字段。 */
function openCall({ home, ref = { root: 'main', id: 'c-1' }, spawnFn, log, env = {} }) {
  return openViewerWindow({ ref, dataDir: home, siteMode: 'explicit', slot: null, scriptPath: 'S', log, spawnFn, env });
}

function entryOf(collabId, role = 'manager', state = 'active') {
  return { collabId, role, state };
}

/* —— openViewerWindow：开关、测试上下文闸、失败路径、现读 —— */

test('openViewerWindow：开关开启 → 按构造计划分离 spawn＋unref，零告警', (t) => {
  const home = makeTempDir(t);
  writeConfig(home, { viewerAutoOpen: true });
  const log = captureLog();
  const { calls, children, spawnFn } = fakeSpawn();
  assert.deepEqual(openCall({ home, spawnFn, log }), { opened: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.execPath);
  assert.deepEqual(calls[0].args, ['S', '--focus', 'main/c-1']);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.stdio, 'ignore');
  assert.equal(calls[0].options.env.WAYSTATION_HOME, process.env.WAYSTATION_HOME, '显式模式继承，不改写');
  assert.equal(children[0].child.unrefed, true, '分离进程必须 unref——不阻塞服务退出');
  assert.deepEqual(log.warns, []);
});

test('openViewerWindow：viewerAutoOpen=false → 不 spawn（手开不受影响），不告警', (t) => {
  const home = makeTempDir(t);
  writeConfig(home, { viewerAutoOpen: false });
  const log = captureLog();
  const { calls, spawnFn } = fakeSpawn();
  assert.deepEqual(openCall({ home, spawnFn, log }), { opened: false, reason: 'auto-open-off' });
  assert.equal(calls.length, 0);
  assert.deepEqual(log.warns, [], '显式 false 是正常配置，不属回落告警面');
});

test('openViewerWindow：测试上下文（NODE_TEST_CONTEXT）→ 不 spawn（e2e 站点安全阀）＋诊断留痕', (t) => {
  const home = makeTempDir(t);
  writeConfig(home, { viewerAutoOpen: true });
  const { calls, spawnFn } = fakeSpawn();
  const log = captureLog();
  assert.deepEqual(
    openCall({ home, spawnFn, log, env: { NODE_TEST_CONTEXT: 'child-v8' } }),
    { opened: false, reason: 'test-context' },
  );
  assert.equal(calls.length, 0);
  assert.equal(log.warns.length, 1, '跳过拉起须留诊断一行（返回值无人消费）');
  assert.match(String(log.warns[0]), /测试上下文/);
});

test('openViewerWindow：开关现读——改 config.json 后下一次触发即生效；非法值经出口 warn 留痕', (t) => {
  const home = makeTempDir(t);
  writeConfig(home, { viewerAutoOpen: false });
  const { calls, spawnFn } = fakeSpawn();
  const log = captureLog();
  assert.equal(openCall({ home, spawnFn, log }).reason, 'auto-open-off');
  assert.equal(calls.length, 0);
  writeConfig(home, { viewerAutoOpen: 'yes' });
  assert.deepEqual(openCall({ home, spawnFn, log }), { opened: true }, '非法值回落 true 照常拉起');
  assert.equal(log.warns.length, 1, '回落经出口 warn 留痕');
  writeConfig(home, { viewerAutoOpen: true });
  assert.deepEqual(openCall({ home, spawnFn, log }), { opened: true });
  assert.equal(calls.length, 2);
  assert.equal(log.warns.length, 1);
});

test('openViewerWindow：spawn error／非零 exit → log.warn 留痕；exit 0 不告警；同步抛错被吞', (t) => {
  const home = makeTempDir(t);
  writeConfig(home, { viewerAutoOpen: true });
  const log = captureLog();
  const { children, spawnFn } = fakeSpawn();
  openCall({ home, spawnFn, log });
  children[0].handlers.get('error')(new Error('ENOENT'));
  children[0].handlers.get('exit')(3);
  assert.equal(log.warns.length, 2, 'error 与非零 exit 各留痕一次');
  assert.match(String(log.warns[0]), /观察窗拉起失败/);
  assert.match(String(log.warns[1]), /观察窗进程异常退出/);

  openCall({ home, spawnFn, log });
  children[1].handlers.get('exit')(0);
  children[1].handlers.get('exit')(null);
  assert.equal(log.warns.length, 2, '正常退出（码 0）与信号终止（码 null）都不告警');

  const throwing = () => {
    throw new Error('EPERM');
  };
  assert.deepEqual(openCall({ home, spawnFn: throwing, log }), { opened: false, reason: 'error' });
  assert.match(String(log.warns[2]), /观察窗拉起异常/);
});

/* —— openViewerOnStart：触发 B 规则 —— */

function startCall({ home, collabs, boundCollabIds, probe, spawnFn, log, root = 'main', siteMode = 'explicit', slot = null }) {
  return openViewerOnStart({ collabs, boundCollabIds, root, digest: DIGEST, dataDir: home, siteMode, slot, scriptPath: 'S', log, probe, spawnFn, env: {} });
}

test('触发 B：恰 1 个进行中 → 其详情页（--focus <root>/<id>）', async (t) => {
  const home = makeTempDir(t);
  writeConfig(home, { viewerAutoOpen: true });
  const { calls, spawnFn } = fakeSpawn();
  const result = await startCall({
    home, collabs: [entryOf('c-solo')], boundCollabIds: ['c-solo'], probe: async () => null, spawnFn, log: captureLog(),
    root: 's3', siteMode: 'slot', slot: 3,
  });
  assert.deepEqual(result, { opened: true });
  assert.deepEqual(calls[0].args, ['S', '--focus', 's3/c-solo']);
});

test('触发 B：≥2 个进行中 → 列表页（不带 --focus）', async (t) => {
  const home = makeTempDir(t);
  writeConfig(home, { viewerAutoOpen: true });
  const { calls, spawnFn } = fakeSpawn();
  const result = await startCall({ home, collabs: [entryOf('c-1'), entryOf('c-2')], boundCollabIds: ['c-1', 'c-2'], probe: async () => null, spawnFn, log: captureLog() });
  assert.deepEqual(result, { opened: true });
  assert.deepEqual(calls[0].args, ['S'], '列表页＝不带 focus 的默认启动');
});

test('触发 B：同根已在跑 → 不重复弹（默认端口段探针＋根摘要比对）', async (t) => {
  const home = makeTempDir(t);
  writeConfig(home, { viewerAutoOpen: true });
  const ports = [];
  const probe = async ({ port }) => {
    ports.push(port);
    return healthOf();
  };
  const { calls, spawnFn } = fakeSpawn();
  const result = await startCall({ home, collabs: [entryOf('c-1')], boundCollabIds: ['c-1'], probe, spawnFn, log: captureLog() });
  assert.deepEqual(result, { opened: false, reason: 'running' });
  assert.equal(calls.length, 0, '已跑不再拉起，也不重复弹窗');
  assert.equal(ports[0], DEFAULT_VIEWER_PORT, '「在跑」判定走默认端口段');
});

test('触发 B：别根实例存在 → 视为未在跑，照常拉起', async (t) => {
  const home = makeTempDir(t);
  writeConfig(home, { viewerAutoOpen: true });
  const { calls, spawnFn } = fakeSpawn();
  const result = await startCall({
    home, collabs: [entryOf('c-1')], boundCollabIds: ['c-1'], probe: async () => healthOf({ root: 'ffffffff' }), spawnFn, log: captureLog(),
  });
  assert.deepEqual(result, { opened: true });
  assert.equal(calls.length, 1);
});

test('触发 B：0 个 / 仅受邀未同意（member proposed）→ 不做，且不探端口', async (t) => {
  const home = makeTempDir(t);
  writeConfig(home, { viewerAutoOpen: true });
  let probes = 0;
  const probe = async () => {
    probes++;
    return null;
  };
  const { calls, spawnFn } = fakeSpawn();
  assert.deepEqual(await startCall({ home, collabs: [], boundCollabIds: [], probe, spawnFn, log: captureLog() }), { opened: false, reason: 'none' });
  assert.deepEqual(
    await startCall({ home, collabs: [entryOf('j-proposed', 'member', 'proposed')], boundCollabIds: ['j-proposed'], probe, spawnFn, log: captureLog() }),
    { opened: false, reason: 'none' },
  );
  assert.equal(probes, 0, '无进行中协作不做任何探测');
  assert.equal(calls.length, 0);
});

test('触发 B：自建者 proposed 仍弹、member active 弹、归档态不弹', async (t) => {
  const home = makeTempDir(t);
  writeConfig(home, { viewerAutoOpen: true });
  const { calls, spawnFn } = fakeSpawn();
  const managerProposed = await startCall({ home, collabs: [entryOf('m-proposed', 'manager', 'proposed')], boundCollabIds: ['m-proposed'], probe: async () => null, spawnFn, log: captureLog() });
  assert.deepEqual(managerProposed, { opened: true });
  assert.deepEqual(calls[0].args, ['S', '--focus', 'main/m-proposed']);
  const memberActive = await startCall({ home, collabs: [entryOf('j-active', 'member', 'active')], boundCollabIds: ['j-active'], probe: async () => null, spawnFn, log: captureLog() });
  assert.deepEqual(memberActive, { opened: true });
  const archived = await startCall({
    home, collabs: [entryOf('m-done', 'manager', 'completed'), entryOf('j-done', 'member', 'terminated')], boundCollabIds: ['m-done', 'j-done'], probe: async () => null, spawnFn, log: captureLog(),
  });
  assert.deepEqual(archived, { opened: false, reason: 'none' });
  assert.equal(calls.length, 2, '归档协作不作为拉起的依据');
});

test('触发 B：开关 false → 全关（不 spawn，reason 透传）', async (t) => {
  const home = makeTempDir(t);
  writeConfig(home, { viewerAutoOpen: false });
  const { calls, spawnFn } = fakeSpawn();
  const result = await startCall({ home, collabs: [entryOf('c-1')], boundCollabIds: ['c-1'], probe: async () => null, spawnFn, log: captureLog() });
  assert.deepEqual(result, { opened: false, reason: 'auto-open-off' });
  assert.equal(calls.length, 0);
});

test('触发 B：探针异常 → 静默降级＋log.warn（绝不抛出）', async (t) => {
  const home = makeTempDir(t);
  writeConfig(home, { viewerAutoOpen: true });
  const log = captureLog();
  const probe = async () => {
    throw new Error('探测故障');
  };
  const { calls, spawnFn } = fakeSpawn();
  assert.deepEqual(await startCall({ home, collabs: [entryOf('c-1')], boundCollabIds: ['c-1'], probe, spawnFn, log }), { opened: false, reason: 'error' });
  assert.equal(calls.length, 0);
  assert.equal(log.warns.length, 1);
  assert.match(String(log.warns[0]), /静默降级/);
});

test('触发 B：绑定集空 → 不做（连端口都不探）', async (t) => {
  const home = makeTempDir(t);
  writeConfig(home, { viewerAutoOpen: true });
  let probes = 0;
  const probe = async () => { probes++; return null; };
  const { calls, spawnFn } = fakeSpawn();
  const result = await startCall({ home, collabs: [entryOf('c-1')], boundCollabIds: [], probe, spawnFn, log: captureLog() });
  assert.deepEqual(result, { opened: false, reason: 'none' });
  assert.equal(probes, 0, '绑定空集不做任何探测');
  assert.equal(calls.length, 0);
});

test('触发 B：绑定只含部分枚举 → 只按绑定集判（详情页取绑定者）', async (t) => {
  const home = makeTempDir(t);
  writeConfig(home, { viewerAutoOpen: true });
  const { calls, spawnFn } = fakeSpawn();
  const result = await startCall({ home, collabs: [entryOf('c-1'), entryOf('c-2')], boundCollabIds: ['c-1'], probe: async () => null, spawnFn, log: captureLog() });
  assert.deepEqual(result, { opened: true });
  assert.deepEqual(calls[0].args, ['S', '--focus', 'main/c-1'], '未绑定的 c-2 不参与判定');
});

test('触发 B：绑定集参数缺失/非数组 → 按空集＋warn 一次，不弹', async (t) => {
  const home = makeTempDir(t);
  writeConfig(home, { viewerAutoOpen: true });
  const log = captureLog();
  const { calls, spawnFn } = fakeSpawn();
  assert.deepEqual(await startCall({ home, collabs: [entryOf('c-1')], probe: async () => null, spawnFn, log }), { opened: false, reason: 'none' });
  assert.deepEqual(await startCall({ home, collabs: [entryOf('c-1')], boundCollabIds: 'c-1', probe: async () => null, spawnFn, log }), { opened: false, reason: 'none' });
  assert.equal(calls.length, 0);
  assert.equal(log.warns.length, 2);
  assert.match(String(log.warns[0]), /绑定集/);
});

test('触发 B·确认模式（viewerAutoOpenOnStart=confirm）：不拉起，返回进行中清单供核心投确认提示', async (t) => {
  const home = makeTempDir(t);
  writeConfig(home, { viewerAutoOpen: true, viewerAutoOpenOnStart: 'confirm' });
  const { calls, spawnFn } = fakeSpawn();
  const result = await startCall({ home, collabs: [entryOf('c-1')], boundCollabIds: ['c-1'], probe: async () => null, spawnFn, log: captureLog() });
  assert.deepEqual(result, { opened: false, reason: 'confirm', collabs: [entryOf('c-1')] });
  assert.equal(calls.length, 0, '确认模式不拉起观察窗');
});

test('触发 B·确认模式与总开关：viewerAutoOpen=false 优先（不弹也不投提示）', async (t) => {
  const home = makeTempDir(t);
  writeConfig(home, { viewerAutoOpen: false, viewerAutoOpenOnStart: 'confirm' });
  const { calls, spawnFn } = fakeSpawn();
  const result = await startCall({ home, collabs: [entryOf('c-1')], boundCollabIds: ['c-1'], probe: async () => null, spawnFn, log: captureLog() });
  assert.deepEqual(result, { opened: false, reason: 'auto-open-off' });
  assert.equal(calls.length, 0);
});

test('触发 B·确认模式非法值：按 auto 回落并留痕（照常拉起）', async (t) => {
  const home = makeTempDir(t);
  writeConfig(home, { viewerAutoOpen: true, viewerAutoOpenOnStart: 'ask' });
  const { calls, spawnFn } = fakeSpawn();
  const log = captureLog();
  const result = await startCall({ home, collabs: [entryOf('c-1')], boundCollabIds: ['c-1'], probe: async () => null, spawnFn, log });
  assert.deepEqual(result, { opened: true });
  assert.equal(calls.length, 1, '非法值按 auto：照常拉起');
  assert.equal(log.warns.length, 1, '非法值 warn 一次');
});

test('确认提示帧：notice/local-alert、定向会话、协作名清单与 /ws-view 指引', () => {
  const frame = viewerConsentNoticeOf({
    collabs: [{ collabId: 'c-1', name: '联调项目' }, { collabId: 'c-2', name: '第二协作' }],
    self: { instanceId: 'inst-self', identityName: '本机', port: 17321 },
    sessionId: 'session-a',
  });
  assert.equal(frame.type, 'notice');
  assert.equal(frame.collabId, 'c-1');
  assert.equal(frame.payload.event, 'local-alert');
  assert.equal(frame.payload.targetSessionId, 'session-a');
  assert.match(frame.payload.text, /会话已启动/);
  assert.match(frame.payload.text, /「联调项目」、「第二协作」/);
  assert.match(frame.payload.text, /观察窗未自动打开/);
  assert.match(frame.payload.text, /\/ws-view/);
});

/* —— 触发 A：创建/同意成功点经 openViewer(ref) 落到真实出口 —— */

/* 服务单测脚手架：真临时数据根＋假发送/直投/清单/提示（沿 collab-service.test.js 先例）。 */
function makeService(t, overrides = {}) {
  const dir = overrides.dataDir ?? makeTempDir(t);
  const sent = [];
  const service = createCollabService({
    dataDir: dir,
    config: { inviteTtlMs: 24 * 60 * 60 * 1000 },
    self: { instanceId: 'inst-self', identityName: '本机', port: 17321 },
    send: (message) => {
      sent.push(message);
      return { ok: true, msgId: `q-${sent.length}` };
    },
    sendDirect: () => ({ ok: true, msgId: 'd-1' }),
    knownHosts: { remember: () => {} },
    notify: () => {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
    syncPeerPicker: () => [],
    inviteMinIntervalMs: 0,
    ledgerFetchTimeoutMs: 60,
    ...overrides,
  });
  return { service, sent, dir };
}

function inviteFrame(collabId) {
  return {
    v: 1,
    type: 'invite',
    msgId: `msg-inv-${collabId}`,
    from: { instanceId: 'inst-a', identityName: '主机甲', port: 17321 },
    collabId,
    ts: new Date().toISOString(),
    payload: {
      name: '联调项目',
      topic: '发布联调',
      members: [
        { instanceId: 'inst-a', identityName: '主机甲' },
        { instanceId: 'inst-self', identityName: '本机' },
      ],
    },
  };
}

async function receive(service, frame) {
  const admitted = await service.hooks.admit(frame, { remoteAddress: '127.0.0.1' });
  if (admitted?.ok === true) {
    await service.hooks.consume(frame, { remoteAddress: '127.0.0.1' });
  }
  return admitted;
}

function createInput() {
  return { name: '联调项目', topic: '主题', targets: [{ instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.2', port: 17321 }] };
}

test('触发 A：创建成功 → openViewer(ref) 被调且 ref＝{ root, id }', (t) => {
  const opened = [];
  const { service } = makeService(t, { viewerRoot: 's3', openViewer: (ref) => opened.push(ref) });
  const created = service.create(createInput());
  assert.equal(created.ok, true);
  assert.deepEqual(opened, [{ root: 's3', id: created.collabId }], 'ref 的 root＝注入的站点根、id＝新协作');
});

test('触发 A：同意加入成功 → openViewer(ref) 被调且 ref 正确', async (t) => {
  const opened = [];
  const { service } = makeService(t, { viewerRoot: 'main', openViewer: (ref) => opened.push(ref) });
  await receive(service, inviteFrame('collab-inv'));
  assert.deepEqual(opened, [], '受邀未同意不弹');
  const approved = await service.approve({ collabId: 'collab-inv', approve: true });
  assert.equal(approved.ok, true);
  assert.deepEqual(opened, [{ root: 'main', id: 'collab-inv' }]);
});

test('触发 A：拒绝邀请 → 不弹（入席成功才拉起）', async (t) => {
  const opened = [];
  const { service } = makeService(t, { viewerRoot: 'main', openViewer: (ref) => opened.push(ref) });
  await receive(service, inviteFrame('collab-inv'));
  const declined = await service.approve({ collabId: 'collab-inv', approve: false, reason: '人手不足' });
  assert.equal(declined.ok, true);
  assert.deepEqual(opened, []);
});

test('触发 A：viewerAutoOpen=false → 真实出口不拉起（spawn 桩零调用）', (t) => {
  const home = makeTempDir(t);
  writeConfig(home, { viewerAutoOpen: false });
  const { calls, spawnFn } = fakeSpawn();
  const { service } = makeService(t, {
    dataDir: home,
    viewerRoot: 'main',
    openViewer: (ref) => openViewerWindow({ ref, dataDir: home, siteMode: 'explicit', slot: null, scriptPath: 'S', log: captureLog(), spawnFn, env: {} }),
  });
  const created = service.create(createInput());
  assert.equal(created.ok, true);
  assert.equal(calls.length, 0, '开关 false：触发 A 全关');
});
