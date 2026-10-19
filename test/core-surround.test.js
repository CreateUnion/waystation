import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCoreSessionStatus } from '../src/session-status.js';
import { createBridgeRegistry } from '../src/core/lifecycle.js';
import { createIpcClient } from '../src/core/ipc.js';
import { startCore } from '../src/core/main.js';
import { createCollabService } from '../src/collab/service.js';
import { LOG_FILE_NAME } from '../src/log.js';
import { statusTool } from '../src/tools/status.js';
import { openViewerOnStart, openViewerWindow, viewerRootOf } from '../src/viewer/launch.js';
import { CONFIG_FILE_NAME, coreJsonPath, sessionFilePath } from '../src/paths.js';
import { makeTempDir, pickFreePort, waitFor } from './helpers.js';

/* 核心周边面的综合判别面（设计 §2.5/§8/§12：ws_status 载荷；§7：观察窗触发 A/B 宿主改核心）：
 * ① ws_status 成功应答的单核形态与降级服务态、core 字段的在场条件；
 * ② 观察窗触发 B 的每 sessionId 记账——判定面＝本会话绑定面（绑定集按注册会话取数、判定在出口内
 *    单点）；判定复用的出口是 launch.js 真实函数，spawn/探针全桩，
 *    绝不真开窗（env 传 {} 走真实 spawn 路径、spawnFn 为桩，与 viewer-auto-open.test.js 同法）；
 * ③ 整链：注册表顶替真实事件序、触发 A 核心宿主（真服务→真出口→桩 spawn）；
 * ④ 接线后真件整链：真核心进程内起站＋真 IPC 客户端——桥生命周期与会话文件、per-session 过滤。
 *    真核进程内经测试上下文闸（NODE_TEST_CONTEXT）拦下开窗；探针只对回环默认端口段做只读 health。 */

/* —— ws_status 载荷（核心应答面） —— */

function fakeContext(overrides = {}) {
  return {
    version: '9.9.9',
    instanceId: 'core-inst',
    identityName: '本机',
    dataDir: 'C:/fake-root',
    logDir: 'C:/fake-root/logs',
    config: { identityName: '本机', port: 17321 },
    net: { available: true, status: () => ({ available: true, message: null, reason: null }) },
    collab: { stats: () => ({ registered: 0 }) },
    startedAt: '2026-10-15T00:00:00.000Z',
    site: { mode: 'single', slot: null, port: 17321, takeover: false },
    coreEndpoint: '\\\\.\\pipe\\waystation-core-abcdef12',
    ...overrides,
  };
}

async function statusPayload(context) {
  const result = await statusTool().handler({}, context);
  return JSON.parse(result.content[0].text);
}

test('ws_status：成功应答为单核形态——site 恒 single、pid/startedAt 是核心的、core 字段带核心端点', async () => {
  const payload = await statusPayload(fakeContext());
  assert.deepEqual(payload.site, { mode: 'single', slot: null, port: 17321, takeover: false });
  assert.equal(payload.pid, process.pid);
  assert.equal(payload.startedAt, '2026-10-15T00:00:00.000Z');
  assert.deepEqual(payload.core, { pid: process.pid, app: '9.9.9', endpoint: '\\\\.\\pipe\\waystation-core-abcdef12' });
  assert.equal('available' in payload.core, false, '核心应答即核心可用：不设 available 子字段');
  assert.equal('degraded' in payload.core, false, 'LAN 正常时不带降级标注');
});

test('ws_status：①② 端口降级服务态——site 仍 single，降级经 net 与 core.degraded 表达', async () => {
  const degraded = { available: false, message: '端口被无关程序占用，请释放后自动接管', reason: 'occupied' };
  const payload = await statusPayload(fakeContext({ net: { status: () => degraded } }));
  assert.deepEqual(payload.site, { mode: 'single', slot: null, port: 17321, takeover: false }, '降级服务态下 site 仍是单核形态');
  assert.equal(payload.net.available, false);
  assert.equal(payload.core.degraded, true);
  assert.equal(payload.pid, process.pid);
});

test('ws_status：单根解析/初始化失败的残余路径——site 为 null（不做形态兜底伪造）', async () => {
  const payload = await statusPayload(fakeContext({ site: null }));
  assert.equal(payload.site, null);
});

test('ws_status：非核心应答（无核心端点）——不出现 core 字段（不伪造、不填占位）', async () => {
  const payload = await statusPayload(fakeContext({ coreEndpoint: undefined }));
  assert.equal('core' in payload, false);
  assert.equal(payload.site.mode, 'single', '其余字段照常呈现');
});

/* —— 观察窗触发 B：每 sessionId 一次记账（宿主＝核心） —— */

const DIGEST = 'abcd1234';

function healthOf(over = {}) {
  return { app: 'waystation-viewer', v: 1, pid: 4242, root: DIGEST, ...over };
}

function captureLog() {
  const warns = [];
  return { warns, warn: (...args) => warns.push(args) };
}

/* spawn 桩：记账调用，返回可派发 error/exit 的假子进程（unref 记账）——绝不真开窗。 */
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

function entryOf(collabId, role = 'manager', state = 'active') {
  return { collabId, role, state };
}

test('触发 A（核心宿主）：单核 siteMode 的根映射恒 main；viewerAutoOpen=false 时零 spawn', (t) => {
  const home = makeTempDir(t);
  writeConfig(home, { viewerAutoOpen: true });
  const { calls, spawnFn } = fakeSpawn();
  const root = viewerRootOf({ siteMode: 'single', slot: null });
  assert.equal(root, 'main', '单核下根恒 main（viewerRootOf 零改动，槽位分支不再命中）');
  const opened = openViewerWindow({ ref: { root, id: 'c-9' }, dataDir: home, siteMode: 'single', slot: null, scriptPath: 'S', log: captureLog(), spawnFn, env: {} });
  assert.deepEqual(opened, { opened: true });
  assert.deepEqual(calls[0].args, ['S', '--focus', 'main/c-9']);
  const homeOff = makeTempDir(t);
  writeConfig(homeOff, { viewerAutoOpen: false });
  const offFake = fakeSpawn();
  const off = openViewerWindow({ ref: { root: 'main', id: 'c-9' }, dataDir: homeOff, siteMode: 'single', slot: null, scriptPath: 'S', log: captureLog(), spawnFn: offFake.spawnFn, env: {} });
  assert.deepEqual(off, { opened: false, reason: 'auto-open-off' });
  assert.equal(offFake.calls.length, 0, '开关 false：触发 A 全关');
});

/* 核心宿主接线同形（main.js 接线时的实际形态）：桥注册 → 写会话状态文件 + 首见才判触发 B；
 * 判定复用 launch.js 的真实出口（判定在出口内单点），根的映射走单核（恒 main）。判定面＝本会话
 * 绑定面（会话级暴露语义）：bindings 以 { [collabId]: sessionId } 模拟绑定表的会话归属，register
 * 按注册会话取绑定集——与 main.js 的 boundCollabIdsOf 同口径（只取数、不判决）。 */
function makeCoreHostTrigger({ home, collabs, bindings = {}, probe, spawnFn, log }) {
  const status = createCoreSessionStatus({
    dataDir: home,
    collect: () => ({ instanceId: 'core-inst', identityName: '本机', site: { mode: 'single', slot: null, port: 17321, takeover: false }, port: 17321, collabs: collabs() }),
    log,
    heartbeatMs: 60000,
    now: () => new Date(),
  });
  const register = (bridge) => {
    const noticed = status.noteRegister(bridge);
    if (!noticed.firstSeen) {
      return Promise.resolve(null);
    }
    const boundCollabIds = Object.entries(bindings).filter(([, sid]) => sid === bridge.sessionId).map(([id]) => id);
    return openViewerOnStart({
      collabs: collabs(), boundCollabIds, root: 'main', digest: DIGEST, dataDir: home, siteMode: 'single', slot: null,
      scriptPath: 'S', log, probe, spawnFn, env: {},
    });
  };
  return { status, register };
}

test('触发 B 记账：新 sessionId 首次注册判一次；同 sessionId 顶替/断开/重生重注册不重判', async (t) => {
  const home = makeTempDir(t);
  writeConfig(home, { viewerAutoOpen: true });
  const log = captureLog();
  const { calls, spawnFn } = fakeSpawn();
  let probes = 0;
  const probe = async () => {
    probes++;
    return null;
  };
  const trigger = makeCoreHostTrigger({ home, collabs: () => [entryOf('c-1')], bindings: { 'c-1': 'session-a' }, probe, spawnFn, log });
  await trigger.register({ bridgeId: 'b1', sessionId: 'session-a', connId: 1 });
  assert.deepEqual(calls[0].args, ['S', '--focus', 'main/c-1'], '单核根恒 main，恰 1 个进行中 → 详情页');
  const probesAfterFirst = probes;
  await trigger.register({ bridgeId: 'b2', sessionId: 'session-a', connId: 2 });
  assert.equal(trigger.status.noteRemove({ bridgeId: 'b2', sessionId: 'session-a', connId: 2 }), true);
  await trigger.register({ bridgeId: 'b3', sessionId: 'session-a', connId: 3 });
  assert.equal(probes, probesAfterFirst, '同 sessionId 不重判——连「同根在跑」探测都不做');
  assert.equal(calls.length, 1, '不重复弹窗');
});

test('触发 B 记账：新 sessionId 按规则重判；同根已在跑 → 判了但不重复弹', async (t) => {
  const home = makeTempDir(t);
  writeConfig(home, { viewerAutoOpen: true });
  const { calls, spawnFn } = fakeSpawn();
  let probes = 0;
  const probe = async () => {
    probes++;
    return healthOf();
  };
  const trigger = makeCoreHostTrigger({
    home, collabs: () => [entryOf('c-1'), entryOf('c-2')], bindings: { 'c-1': 'session-a', 'c-2': 'session-b' }, probe, spawnFn, log: captureLog(),
  });
  const first = await trigger.register({ bridgeId: 'b1', sessionId: 'session-a', connId: 1 });
  assert.deepEqual(first, { opened: false, reason: 'running' });
  const probesAfterFirst = probes;
  await trigger.register({ bridgeId: 'b4', sessionId: 'session-b', connId: 4 });
  assert.ok(probes > probesAfterFirst, '新会话重判（重新做同根探测）');
  assert.equal(calls.length, 0, '已在跑：判了但不重复弹窗');
});

test('触发 B 开关三支（核心宿主）：缺省 true 静默拉起、显式 false 不弹、非法值回落 true 并留痕', async (t) => {
  /* 缺省（无 config.json）：静默按 true。 */
  const homeDefault = makeTempDir(t);
  const logDefault = captureLog();
  const defaultFake = fakeSpawn();
  const triggerDefault = makeCoreHostTrigger({ home: homeDefault, collabs: () => [entryOf('c-1')], bindings: { 'c-1': 's-default' }, probe: async () => null, spawnFn: defaultFake.spawnFn, log: logDefault });
  const opened = await triggerDefault.register({ bridgeId: 'b1', sessionId: 's-default', connId: 1 });
  assert.deepEqual(opened, { opened: true });
  assert.equal(defaultFake.calls.length, 1);
  assert.deepEqual(logDefault.warns, [], '缺省不告警');
  /* 显式 false：不弹（手开不受影响）。 */
  const homeOff = makeTempDir(t);
  writeConfig(homeOff, { viewerAutoOpen: false });
  const offFake = fakeSpawn();
  const triggerOff = makeCoreHostTrigger({ home: homeOff, collabs: () => [entryOf('c-1')], bindings: { 'c-1': 's-off' }, probe: async () => null, spawnFn: offFake.spawnFn, log: captureLog() });
  assert.deepEqual(await triggerOff.register({ bridgeId: 'b1', sessionId: 's-off', connId: 1 }), { opened: false, reason: 'auto-open-off' });
  assert.equal(offFake.calls.length, 0);
  /* 非法值：回落 true 拉起 + warn 留痕一次。 */
  const homeBad = makeTempDir(t);
  writeConfig(homeBad, { viewerAutoOpen: 'yes' });
  const badLog = captureLog();
  const badFake = fakeSpawn();
  const triggerBad = makeCoreHostTrigger({ home: homeBad, collabs: () => [entryOf('c-1')], bindings: { 'c-1': 's-bad' }, probe: async () => null, spawnFn: badFake.spawnFn, log: badLog });
  assert.deepEqual(await triggerBad.register({ bridgeId: 'b1', sessionId: 's-bad', connId: 1 }), { opened: true });
  assert.equal(badFake.calls.length, 1);
  assert.equal(badLog.warns.length, 1, '非法值经出口 warn 留痕');
});

test('触发 B：未绑定新会话注册 → 不判不弹（连探测都不做）', async (t) => {
  const home = makeTempDir(t);
  writeConfig(home, { viewerAutoOpen: true });
  let probes = 0;
  const probe = async () => { probes++; return null; };
  const { calls, spawnFn } = fakeSpawn();
  const trigger = makeCoreHostTrigger({ home, collabs: () => [entryOf('c-1')], bindings: { 'c-1': 'session-other' }, probe, spawnFn, log: captureLog() });
  await trigger.register({ bridgeId: 'b1', sessionId: 'session-fresh', connId: 1 });
  assert.equal(probes, 0);
  assert.equal(calls.length, 0, '未绑定会话不弹窗');
});

/* —— 整链：注册表顶替真实事件序（接线形态与 main.js 接线一致） —— */

test('整链·注册表顶替事件序：新桥注册触发旧连接断开 → 旧连接的 onClose 空转不删文件；新桥断开才删', (t) => {
  const home = makeTempDir(t);
  const log = captureLog();
  const status = createCoreSessionStatus({
    dataDir: home,
    collect: () => ({ instanceId: 'core-inst', identityName: '本机', site: { mode: 'single', slot: null, port: 17321, takeover: false }, port: 17321, collabs: [entryOf('c-1')] }),
    log,
    heartbeatMs: 60000,
    now: () => new Date(),
  });
  const bridges = createBridgeRegistry({ log });
  const closed = [];
  /* 接线同形：注册与断开各两处调用（noteRemove 自守卫，不依赖注册表 remove 的返回值）。 */
  const registerEvent = (record) => {
    bridges.register(record);
    return status.noteRegister(record);
  };
  const closeEvent = (record) => {
    const removed = bridges.remove(record);
    status.noteRemove(record);
    return removed;
  };
  const file = sessionFilePath(home, 'session-a');
  const stale = { connId: 1, bridgeId: 'b-old', sessionId: 'session-a', close: () => closed.push('b-old') };
  const fresh = { connId: 2, bridgeId: 'b-new', sessionId: 'session-a', close: () => closed.push('b-new') };
  assert.equal(registerEvent(stale).firstSeen, true);
  assert.equal(existsSync(file), true);
  registerEvent(fresh);
  assert.deepEqual(closed, ['b-old'], '注册表顶替自动断开旧连接（其 onClose 随后到达）');
  assert.equal(closeEvent(stale), false, '注册表对旧连接已无登记');
  assert.equal(existsSync(file), true, '旧连接的断开通知不得删掉新写者的文件');
  assert.equal(bridges.count(), 1);
  assert.equal(closeEvent(fresh), true);
  assert.equal(status.stats().sessions, 0);
  assert.equal(existsSync(file), false, '当前写者断开才删文件');
});

/* —— 整链：触发 A（核心宿主）——真协作服务 → 真出口 → 桩 spawn —— */

function makeCoreHostService(home, spawnFn, log) {
  return createCollabService({
    dataDir: home,
    config: { inviteTtlMs: 24 * 60 * 60 * 1000 },
    self: { instanceId: 'inst-self', identityName: '本机', port: 17321 },
    send: () => ({ ok: true, msgId: 'q-1' }),
    sendDirect: () => ({ ok: true, msgId: 'd-1' }),
    knownHosts: { remember: () => {} },
    notify: () => {},
    log,
    syncPeerPicker: () => [],
    inviteMinIntervalMs: 0,
    ledgerFetchTimeoutMs: 60,
    viewerRoot: 'main',
    openViewer: (ref) => openViewerWindow({ ref, dataDir: home, siteMode: 'single', slot: null, scriptPath: 'S', log, spawnFn, env: {} }),
  });
}

test('整链·触发 A（核心宿主）：建立协作 → 真出口以 single 根拉起该协作详情页（桩 spawn，不开窗）', (t) => {
  const home = makeTempDir(t);
  writeConfig(home, { viewerAutoOpen: true });
  const { calls, spawnFn } = fakeSpawn();
  const log = { info: () => {}, warn: () => {}, error: () => {} };
  const service = makeCoreHostService(home, spawnFn, log);
  const created = service.create({
    name: '联调项目',
    topic: '主题',
    targets: [{ instanceId: 'inst-b', identityName: '主机乙', address: '127.0.0.2', port: 17321 }],
  });
  assert.equal(created.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['S', '--focus', `main/${created.collabId}`], '根恒 main（单核），id＝新协作');
});

/* —— 整链（接线后真件）：真核心进程内起站 + 真 IPC 客户端 —— */

async function startCoreOnTempRoot(t, home, configOverrides = {}) {
  writeFileSync(join(home, CONFIG_FILE_NAME), JSON.stringify({ port: await pickFreePort(), identityName: '本机', viewerAutoOpen: false, ...configOverrides }, null, 2));
  const started = await startCore({ env: { ...process.env, WAYSTATION_HOME: home } });
  assert.equal(started.ok, true, started.message ?? '核心启动');
  t.after(() => {
    try {
      const stopped = started.core.stop();
      if (stopped && typeof stopped.catch === 'function') {
        stopped.catch(() => {});
      }
    } catch {
      // 用例内已显式停核：收尾不重复报错
    }
  });
  return { record: JSON.parse(readFileSync(coreJsonPath(home), 'utf8')), core: started.core };
}

function bridgeClientFor(home, record, { bridgeId, sessionId }) {
  const frames = [];
  const closed = [];
  const client = createIpcClient({
    dataDir: home,
    hello: { app: record.appVersion, token: record.token, bridgeId, sessionId },
    onFrame: (frame) => frames.push(frame),
    onClose: (info) => closed.push(info),
  });
  return { client, frames, closed };
}

async function callAndWait(entry, tool, args) {
  const id = randomUUID();
  entry.client.send({ type: 'call', id, tool, args });
  await waitFor(() => entry.frames.some((frame) => frame.type === 'result' && frame.id === id), { timeoutMs: 10000 });
  return JSON.parse(entry.frames.find((frame) => frame.type === 'result' && frame.id === id).content[0].text);
}

function logTextOf(home) {
  try {
    return readFileSync(join(home, 'logs', LOG_FILE_NAME), 'utf8');
  } catch {
    return '';
  }
}

function triggerJudgedCount(home) {
  return logTextOf(home).split('跳过观察窗自动打开').length - 1;
}

/* 出口 fail-safe 告警（缺绑定集参数按空集处理）的出现次数：它恒为 0 才是接线到位的判别面——
 * 旧接线（不传 boundCollabIds）会把每次触发 B 都打成该告警（真核侧对 main.js 新接线的拦截点，
 * 负断言侧的「不留痕」以它为准）。 */
function failSafeWarnCount(home) {
  return logTextOf(home).split('触发 B 缺绑定集参数').length - 1;
}

test('整链·真核＋真 IPC：注册即写＋顶替存活（旧连接断开空转）＋断开删除', { timeout: 60000 }, async (t) => {
  const home = makeTempDir(t);
  const { record } = await startCoreOnTempRoot(t, home);
  const live = [];
  t.after(async () => {
    for (const entry of live) {
      await entry.client.close().catch(() => {});
    }
  });
  const file = sessionFilePath(home, 'session-live-1');
  const first = bridgeClientFor(home, record, { bridgeId: 'bridge-live-1', sessionId: 'session-live-1' });
  live.push(first);
  await first.client.connect();
  await waitFor(() => (existsSync(file) ? true : null), { timeoutMs: 10000 });
  const payload = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(payload.sessionId, 'session-live-1');
  assert.deepEqual(payload.site, { mode: 'single', slot: null, port: record.port, takeover: false });
  assert.deepEqual(payload.collabs, []);
  assert.equal(payload.pid, process.pid);
  /* 顶替：同 sessionId 第二桥注册 → 核心断开旧连接（旧客户端收到 onClose）→ 文件不得被删。 */
  const second = bridgeClientFor(home, record, { bridgeId: 'bridge-live-2', sessionId: 'session-live-1' });
  live.push(second);
  await second.client.connect();
  await waitFor(() => (first.closed.length === 1 ? true : null), { timeoutMs: 10000 });
  assert.equal(existsSync(file), true, '被顶替的旧连接断开不得删掉新写者的文件');
  /* 当前写者断开 → 文件删除。 */
  second.client.send({ type: 'bye', reason: 'session-end' });
  await second.client.close();
  await waitFor(() => (existsSync(file) ? null : true), { timeoutMs: 10000 });
});

test('整链·观察窗触发记账（真核）：建协触发 A 达出口；未绑定新会话注册全静默；同 sessionId 顶替不重判', { timeout: 60000 }, async (t) => {
  const home = makeTempDir(t);
  const { record } = await startCoreOnTempRoot(t, home);
  const peerPort = await pickFreePort();
  const live = [];
  t.after(async () => {
    for (const entry of live) {
      await entry.client.close().catch(() => {});
    }
  });
  const seed = bridgeClientFor(home, record, { bridgeId: 'bridge-seed', sessionId: 'session-seed' });
  live.push(seed);
  await seed.client.connect();
  /* 建协（进行中：站长侧 proposed）→ 触发 A 以单核根拉起该协作页（测试上下文闸拦下开窗，出口留痕）。 */
  const created = await callAndWait(seed, 'ws_create_collab', {
    name: '记账项目', topic: '主题', targets: [{ instanceId: 'inst-peer', identityName: '对端', address: '127.0.0.1', port: peerPort }],
  });
  assert.equal(created.ok, true, created.message);
  await waitFor(() => (triggerJudgedCount(home) >= 1 ? true : null), { timeoutMs: 10000 });
  const judgedAfterCreate = triggerJudgedCount(home);
  /* 未绑定新会话注册 → 触发 B 只取本会话绑定集（会话级暴露语义）：guest 无绑定，出口在绑定过滤处
   * 返回 none——不判、不探、不留痕。负断言：等核心受理注册（会话文件落盘）后短等待，判定计数不增；
   * 随后同 sessionId 顶替不重判（未绑定新会话＝全静默）。 */
  const guest = bridgeClientFor(home, record, { bridgeId: 'bridge-guest-1', sessionId: 'session-guest' });
  live.push(guest);
  await guest.client.connect();
  const guestFile = sessionFilePath(home, 'session-guest');
  await waitFor(() => (existsSync(guestFile) ? true : null), { timeoutMs: 10000 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(triggerJudgedCount(home), judgedAfterCreate, '未绑定新会话＝全静默（会话级暴露语义：不判不弹）');
  assert.equal(failSafeWarnCount(home), 0, '绑定集参数恒在场（main.js 接线）：不落「缺参数」fail-safe 告警');
  const judgedOnce = triggerJudgedCount(home);
  const superseder = bridgeClientFor(home, record, { bridgeId: 'bridge-guest-2', sessionId: 'session-guest' });
  live.push(superseder);
  await superseder.client.connect();
  await waitFor(() => (guest.closed.length === 1 ? true : null), { timeoutMs: 10000 });
  assert.equal(triggerJudgedCount(home), judgedOnce, '同 sessionId 顶替不重判（不重复开窗判定）');
});

test('整链·触发 B 确认模式（真核）：已绑定会话注册 → 不拉起、收确认提示帧', { timeout: 90000 }, async (t) => {
  const home = makeTempDir(t);
  const confirmConfig = { viewerAutoOpen: true, viewerAutoOpenOnStart: 'confirm' };
  const live = [];
  t.after(async () => {
    for (const entry of live) {
      await entry.client.close().catch(() => {});
    }
  });
  /* 第一核：建协把 seed 会话写进绑定表（触发 A 照常走出口；测试上下文闸拦下开窗）。 */
  const first = await startCoreOnTempRoot(t, home, confirmConfig);
  const peerPort = await pickFreePort();
  const seed = bridgeClientFor(home, first.record, { bridgeId: 'bridge-confirm-seed', sessionId: 'session-confirm' });
  live.push(seed);
  await seed.client.connect();
  const created = await callAndWait(seed, 'ws_create_collab', {
    name: '确认模式项目', topic: '主题', targets: [{ instanceId: 'inst-peer', identityName: '对端', address: '127.0.0.1', port: peerPort }],
  });
  assert.equal(created.ok, true, created.message);
  await waitFor(() => (triggerJudgedCount(home) >= 1 ? true : null), { timeoutMs: 10000 });
  const judgedAfterCreate = triggerJudgedCount(home);
  await seed.client.close();
  await first.core.stop();
  /* 第二核：同 sessionId 重新注册＝已绑定会话首次注册 → 确认模式：不拉起，投确认提示。 */
  const second = await startCoreOnTempRoot(t, home, confirmConfig);
  const bound = bridgeClientFor(home, second.record, { bridgeId: 'bridge-confirm-bound', sessionId: 'session-confirm' });
  live.push(bound);
  await bound.client.connect();
  await waitFor(() => (bound.frames.some((frame) => frame.type === 'push' && String(frame.text).includes('观察窗未自动打开')) ? true : null), { timeoutMs: 10000 });
  const notice = bound.frames.find((frame) => frame.type === 'push' && String(frame.text).includes('观察窗未自动打开'));
  assert.equal(notice.frameType, 'notice', '确认提示为本机提示帧');
  assert.match(notice.text, /「确认模式项目」/, '提示携协作名');
  assert.match(notice.text, /\/ws-view/, '指引手动打开');
  assert.equal(triggerJudgedCount(home), judgedAfterCreate, '确认模式不拉起（无新出口留痕）');
});

/* 会话获准台账（joins.json）直落：夺席收紧后，休眠/空绑定下的写类夺席以本机获准台账为判据
 * （本会话未获准不夺席）；登记工具面归会话级加入链的后续批，本用例以台账面就位构造
 * 「已获准、绑定休眠」前态——核心判据读的就是这份文件（获准全量会话标识精确匹配）。 */
function grantSessionInLedger(home, instanceId, collabId, sessionId) {
  writeFileSync(join(home, 'collabs', collabId, 'joins.json'), JSON.stringify({
    v: 1,
    pendingJoins: [],
    approvals: [{ instanceId, sessionId, origin: 'grant', grantedAt: Date.now(), approvedBy: 'session-a' }],
  }, null, 2), 'utf8');
}

test('整链·per-session 过滤（真核＋真工具调用）：绑定随会话、异会话不含、断开删除、夺席后转移', { timeout: 90000 }, async (t) => {
  const home = makeTempDir(t);
  const { record } = await startCoreOnTempRoot(t, home);
  const peerPort = await pickFreePort();
  const a = bridgeClientFor(home, record, { bridgeId: 'bridge-a', sessionId: 'session-a' });
  const b = bridgeClientFor(home, record, { bridgeId: 'bridge-b', sessionId: 'session-b' });
  t.after(async () => {
    await a.client.close().catch(() => {});
    await b.client.close().catch(() => {});
  });
  await a.client.connect();
  await b.client.connect();
  const fileA = sessionFilePath(home, 'session-a');
  const fileB = sessionFilePath(home, 'session-b');
  await waitFor(() => (existsSync(fileA) && existsSync(fileB) ? true : null), { timeoutMs: 10000 });
  const collabsOf = (file) => JSON.parse(readFileSync(file, 'utf8')).collabs;
  const created = await callAndWait(a, 'ws_create_collab', {
    name: '进程内环', topic: '主题', targets: [{ instanceId: 'inst-peer', identityName: '对端', address: '127.0.0.1', port: peerPort }],
  });
  assert.equal(created.ok, true, created.message);
  await waitFor(() => (collabsOf(fileA).some((entry) => entry.collabId === created.collabId) ? true : null), { timeoutMs: 12000 });
  assert.equal(collabsOf(fileB).length, 0, '异会话文件不含他人绑定的协作');
  /* 调用会话断开 → 文件删除；异会话写类调用夺席（绑定休眠）→ 协作随查询转移到新会话文件。 */
  a.client.send({ type: 'bye', reason: 'session-end' });
  await a.client.close();
  await waitFor(() => (existsSync(fileA) ? null : true), { timeoutMs: 10000 });
  /* 会话 B 获准台账就位（已获准、绑定休眠 → 写类调用夺席；未经收紧的旧行为里 B 不获准也夺）。 */
  grantSessionInLedger(home, record.identity.instanceId, created.collabId, 'session-b');
  const muted = await callAndWait(b, 'ws_set_mute', { collabId: created.collabId, muted: true });
  assert.equal(muted.ok, true, muted.message);
  await waitFor(() => (collabsOf(fileB).some((entry) => entry.collabId === created.collabId) ? true : null), { timeoutMs: 12000 });
  assert.equal(collabsOf(fileB).find((entry) => entry.collabId === created.collabId).muted, true, '静音切换即刷新会话文件（状态栏 🔇 的数据源）');
});

/* —— 整链·ws_list_hosts 本机段（真核＋真 IPC） —— */

test('整链·本机段会话数据源：上下文取值器随桥注册/退场实时变化（零桥边界如实为空集合）', { timeout: 60000 }, async (t) => {
  const home = makeTempDir(t);
  const { record, core } = await startCoreOnTempRoot(t, home);
  const a = bridgeClientFor(home, record, { bridgeId: 'bridge-seg-a', sessionId: 'session-seg-a' });
  const b = bridgeClientFor(home, record, { bridgeId: 'bridge-seg-b', sessionId: 'session-seg-b' });
  t.after(async () => {
    await a.client.close().catch(() => {});
    await b.client.close().catch(() => {});
  });
  assert.deepEqual(core.context.activeSessions(), [], '零桥边界：核心已起、尚无桥');
  await a.client.connect();
  await waitFor(() => (core.context.activeSessions().length === 1 ? true : null), { timeoutMs: 10000 });
  assert.equal(core.context.activeSessions()[0].sessionId, 'session-seg-a');
  assert.equal(core.context.activeSessions()[0].app, core.context.version, '客户端字段取自注册记录（桥 hello 的应用版本）');
  await b.client.connect();
  await waitFor(() => (core.context.activeSessions().length === 2 ? true : null), { timeoutMs: 10000 });
  a.client.send({ type: 'bye', reason: 'session-end' });
  await a.client.close();
  await waitFor(() => (core.context.activeSessions().length === 1 ? true : null), { timeoutMs: 10000 });
  assert.deepEqual(core.context.activeSessions().map((entry) => entry.sessionId), ['session-seg-b'], '退场后只留在线桥');
});
