import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeTempDir, pickFreePort, waitFor } from './helpers.js';
import { coreJsonPath } from '../src/paths.js';
import { createIpcClient } from '../src/core/ipc.js';
import { startCore } from '../src/core/main.js';
import { createInjectionRouter } from '../src/core/routing.js';
import { createCollabService } from '../src/collab/service.js';
import { loadMember } from '../src/collab/store.js';
import { newCollabId } from '../src/collab/model.js';

/* 指名邀请（会话级加入「点名」）三落点的判别面：投递过滤（有 targetSessionId 只投目标会话的桥）／
 * 离线目标挂起与重开补投（member.json 登记 ＋ 桥注册挂点）／点头判定（member.json 的指名 ≠ 点头
 * 会话即拒）；末支为真核 e2e（真组合根：挂起的指名邀请在目标会话注册时补投到其桥）。
 * 夹具＝真临时根 ＋ 真协作服务 ＋ 真注入路由（假注册表 / 假 IPC 发送面——与核组合根同形的装配）。 */

const DAY = 24 * 60 * 60 * 1000;
const SELF = { instanceId: 'inst-self', identityName: '本机', port: 17401 };
const PEER = { instanceId: 'inst-peer', identityName: '对端', port: 17400 };

function quietLog(lines = []) {
  const record = (level) => (message, meta) => lines.push({ level, message, meta });
  return { info: record('info'), warn: record('warn'), error: record('error') };
}

/* 假桥注册表（形态对齐 lifecycle.createBridgeRegistry；前缀解析面走 list + startsWith，故此处
 * 只提供 list/find，与真表同形）。 */
function registryStub() {
  const entries = [];
  return {
    entries,
    register(record) {
      const entry = { bridgeId: record.bridgeId, sessionId: record.sessionId ?? null, record };
      entries.push(entry);
      return entry;
    },
    remove(record) {
      const index = entries.findIndex((entry) => entry.record === record);
      if (index >= 0) {
        entries.splice(index, 1);
      }
    },
    count: () => entries.length,
    list: () => [...entries],
    find: (sessionId) => entries.find((entry) => entry.sessionId === sessionId) ?? null,
  };
}

function bridgeRecord(bridgeId, sessionId) {
  return { connId: bridgeId, bridgeId, sessionId, send: () => {} };
}

function pushFramesOf(out, bridgeId = null) {
  return out.filter((entry) => entry.frame.type === 'push' && (bridgeId === null || entry.record.bridgeId === bridgeId));
}

/* 夹具：真路由（获准判据与核组合根同源——闭包运行期取真服务）＋真服务（notify 走路由）。
 * 假 IPC 发送面默认自动回执（须挂桥形态由用例自行注入）。 */
function makeHarness(t, overrides = {}) {
  const dir = makeTempDir(t);
  const h = { dir, registry: registryStub(), out: [], logLines: [], self: SELF, overrides };
  h.config = { inviteTtlMs: DAY, messageTtlMs: DAY, scanWindowMs: 100, probeTimeoutMs: 100, ...(overrides.config ?? {}) };
  h.router = createInjectionRouter({
    dataDir: dir,
    log: quietLog(h.logLines),
    describeCollab: (collabId) => h.service.describe(collabId),
    isGranted: (collabId, sessionId) => h.service.join.isGranted(collabId, sessionId),
    receiptTimeoutMs: overrides.receiptTimeoutMs,
  });
  h.ipc = {
    send: (record, frame) => {
      h.out.push({ record, frame });
      if (frame.type === 'push') {
        overrides.onPush?.(h, frame);   // 并发写入注入点（补投在途时的第三个写入方）
        queueMicrotask(() => h.router.settleDelivered({ type: 'delivered', pushId: frame.pushId, ok: overrides.pushOk !== false }));
      }
      return true;
    },
  };
  h.service = createCollabService({
    dataDir: dir,
    config: h.config,
    self: SELF,
    send: () => ({ ok: true, msgId: 'q-1' }),
    sendDirect: () => ({ ok: true, msgId: 'd-1' }),
    knownHosts: { remember: () => {}, lookup: () => undefined },
    notify: (frame) => h.router.notify(frame),
    log: quietLog(h.logLines),
    bindings: h.router.bindings,
    bridgeIdOf: (sessionId) => h.registry.find(sessionId)?.bridgeId ?? null,
    syncPeerPicker: () => [],
    ledgerFetchTimeoutMs: 60,
    inviteMinIntervalMs: 0,
  });
  h.router.load();
  h.router.attach({ registry: h.registry, ipc: h.ipc });
  return h;
}

/* 真接收管线的三步（与 inbound 的次序同形）：准入 → 消费（落 member.json）→ 按绑定/指名投递。 */
async function receive(h, frame) {
  const meta = { remoteAddress: '127.0.0.1' };
  const admitted = await h.service.hooks.admit(frame, meta);
  if (admitted?.ok !== true) {
    return admitted;
  }
  await h.service.hooks.consume(frame, meta);
  return { ok: true, delivered: await h.router.deliverToSession(frame) };
}

function inviteFrameOf(collabId, targetSessionId, overrides = {}) {
  const payload = {
    name: '指名项目',
    topic: '发布联调',
    members: [PEER, SELF].map((peer) => ({ instanceId: peer.instanceId, identityName: peer.identityName })),
    ...(targetSessionId === undefined ? {} : { targetSessionId }),
    ...(overrides.payload ?? {}),
  };
  return {
    v: 1,
    type: 'invite',
    msgId: `msg-inv-${randomUUID()}`,
    from: { ...PEER },
    collabId,
    ts: '2026-10-16T08:00:00.000Z',
    payload,
    ...overrides.frame,
  };
}

function memberFileOf(h, collabId) {
  return join(h.dir, 'collabs', collabId, 'member.json');
}

function memberPatch(h, collabId, patch) {
  const record = JSON.parse(readFileSync(memberFileOf(h, collabId), 'utf8'));
  writeFileSync(memberFileOf(h, collabId), JSON.stringify({ ...record, ...patch }, null, 2), 'utf8');
}

function memberOf(h, collabId) {
  return JSON.parse(readFileSync(memberFileOf(h, collabId), 'utf8'));
}

/* —— 落点一：指名投递过滤 —— */

test('指名邀请：只投目标会话的桥（短码前缀命中），其余活跃桥一条不投；目标随之定格入 member.json', async (t) => {
  const h = makeHarness(t);
  h.registry.register(bridgeRecord('bridge-a', 'session-alpha'));
  h.registry.register(bridgeRecord('bridge-b', 'session-target-a1b2c3d4'));
  const frame = inviteFrameOf('collab-named', 'session-t');
  const received = await receive(h, frame);
  assert.equal(received.ok, true, '邀请过准入');
  await waitFor(() => pushFramesOf(h.out, 'bridge-b').length >= 1);
  assert.equal(pushFramesOf(h.out, 'bridge-a').length, 0, '非目标会话不投（不广播）');
  assert.equal(pushFramesOf(h.out, 'bridge-b').length, 1, '恰投目标桥一条');
  assert.equal(pushFramesOf(h.out, 'bridge-b')[0].frame.frameType, 'invite', '推送面 frameType 带原帧类型');
  assert.equal(await received.delivered, true);
  assert.equal(memberOf(h, 'collab-named').targetSessionId, 'session-target-a1b2c3d4', '在场命中即定格全标识（点头判据的精确面）');
  assert.deepEqual(memberOf(h, 'collab-named').pendingInvites, undefined, '在场投出＝不登记挂起');
});

test('指名邀请·离线目标：不投（未投计数）＋登记挂起于 member.json；登记记录过 loadMember 校验', async (t) => {
  const h = makeHarness(t);
  h.registry.register(bridgeRecord('bridge-a', 'session-alpha'));
  const frame = inviteFrameOf('collab-named', 'session-t');
  const received = await receive(h, frame);
  assert.equal(received.delivered, false, '目标不在场：不投');
  assert.equal(pushFramesOf(h.out).length, 0);
  assert.equal(h.router.stats().inboundUnrouted, 1, '按未投计数（数据已落盘，工具与观察窗照常可拉）');
  assert.equal(h.router.stats().inboundFailed, 0, '不在场不记失败（三态互斥）');
  const record = loadMember(h.dir, 'collab-named');
  assert.ok(record !== null, '追加了挂起字段的记录仍过成员记录形态校验');
  assert.equal(record.targetSessionId, 'session-t', '指名短码随记录定格（点头判据）');
  assert.equal(record.pendingInvites.length, 1, '挂起登记一条');
  assert.equal(record.pendingInvites[0].sessionId, 'session-t');
  assert.equal(record.pendingInvites[0].frame.msgId, frame.msgId, '原帧随登记留存（补投经同一渲染面）');
});

/* —— 落点二：离线挂起补投（桥注册挂点） —— */

test('挂起补投：目标会话注册即投其桥＋登记摘除；再补投不重发（幂等面）', async (t) => {
  const h = makeHarness(t);
  h.registry.register(bridgeRecord('bridge-a', 'session-alpha'));
  const frame = inviteFrameOf('collab-named', 'session-t');
  await receive(h, frame);
  assert.equal(memberOf(h, 'collab-named').pendingInvites.length, 1, '先挂起');

  const recordC = bridgeRecord('bridge-t', 'session-target-abc');
  h.registry.register(recordC);
  assert.equal(await h.router.flushPendingInvites('session-nowhere'), 0, '未注册会话：补投空转（不做任何取数）');
  assert.equal(await h.router.flushPendingInvites('session-target-abc'), 1, '补投一条');
  await waitFor(() => pushFramesOf(h.out, 'bridge-t').length >= 1);
  const push = pushFramesOf(h.out, 'bridge-t')[0].frame;
  assert.equal(push.frameType, 'invite');
  assert.ok(push.text.includes('指名项目'), '补投文本经核心渲染（与首投同一面）');
  assert.equal(pushFramesOf(h.out, 'bridge-a').length, 0, '不旁投其他桥');
  assert.equal(h.router.stats().pendingInvitesFlushed, 1);
  assert.deepEqual(memberOf(h, 'collab-named').pendingInvites, [], '投出即摘除登记');
  assert.equal(await h.router.flushPendingInvites('session-target-abc'), 0, '登记已摘：再补投为空转');
  assert.equal(pushFramesOf(h.out, 'bridge-t').length, 1, '不重发');
});

test('挂起补投：投出失败保留登记（下轮再投）；非目标会话注册不投；过期 / 已处置的登记就地摘除', async (t) => {
  const h = makeHarness(t, { pushOk: false });
  h.registry.register(bridgeRecord('bridge-a', 'session-alpha'));
  await receive(h, inviteFrameOf('collab-named', 'session-t'));
  h.registry.register(bridgeRecord('bridge-x', 'session-other'));
  assert.equal(await h.router.flushPendingInvites('session-other'), 0, '非指名会话注册：不投不摘');
  assert.equal(memberOf(h, 'collab-named').pendingInvites.length, 1);

  const recordT = bridgeRecord('bridge-t', 'session-target-abc');
  h.registry.register(recordT);
  assert.equal(await h.router.flushPendingInvites('session-target-abc'), 0, '回执未到：本次不计补投');
  assert.equal(memberOf(h, 'collab-named').pendingInvites.length, 1, '投出未成：登记保留（下轮再投）');

  memberPatch(h, 'collab-named', { expiresAt: '2026-10-15T00:00:00.000Z' });
  assert.equal(await h.router.flushPendingInvites('session-target-abc'), 0, '过期限：不投');
  assert.deepEqual(memberOf(h, 'collab-named').pendingInvites, [], '过期的登记就地摘除');

  h.registry.remove(recordT);
  memberPatch(h, 'collab-named', { expiresAt: new Date(Date.now() + DAY).toISOString() });
  await receive(h, inviteFrameOf('collab-named', 'session-t'));
  assert.equal(memberOf(h, 'collab-named').pendingInvites.length, 1, '重发邀请重新挂起（目标再度离线）');
  memberPatch(h, 'collab-named', { decision: 'declined' });
  h.registry.register(bridgeRecord('bridge-t', 'session-target-abc'));
  assert.equal(await h.router.flushPendingInvites('session-target-abc'), 0, '邀请已处置：不投');
  assert.deepEqual(memberOf(h, 'collab-named').pendingInvites, [], '已处置的登记就地摘除（不给已回绝的邀请补投）');

  const failedPush = await receive(h, inviteFrameOf('collab-named', 'session-t'));
  assert.equal(failedPush.delivered, false, '目标在场但回执未成：按未注入处置');
  assert.equal(h.router.stats().inboundFailed, 1, '单桥失败计数（三态互斥：失败 ≠ 未投）');
});

test('挂起登记·服务侧整写不抹掉路由面字段：挂起登记与指名标记仍在，补投仍可命中', async (t) => {
  const h = makeHarness(t);
  h.registry.register(bridgeRecord('bridge-a', 'session-alpha'));
  await receive(h, inviteFrameOf('collab-named', 'session-t'));
  assert.equal(memberOf(h, 'collab-named').pendingInvites.length, 1, '挂起登记就位');

  /* 服务侧整写（成员记录整写的唯一咽喉＝persistMember）：端点变化即整写——用一条旁路帧把
   * 站长的来源端口换掉，框架走「准入 → 消费 → 端点学习 → 整写」，投递面不参与（非邀请帧）。 */
  const touched = { ...inviteFrameOf('collab-named', 'session-t'), type: 'reply', msgId: `msg-touch-${randomUUID()}`, payload: { text: '你好' } };
  touched.from = { ...PEER, port: PEER.port + 1 };
  const learned = await receive(h, touched);
  assert.equal(learned.ok, true, '旁路帧过准入（端点学习触发整写）');
  assert.equal(memberOf(h, 'collab-named').endpoints['inst-peer'].port, PEER.port + 1, '端点已学得（整写确实发生）');
  assert.equal(memberOf(h, 'collab-named').pendingInvites.length, 1, '整写后挂起登记仍在');
  assert.equal(memberOf(h, 'collab-named').targetSessionId, 'session-t', '整写后指名标记仍在');

  h.registry.register(bridgeRecord('bridge-t', 'session-target-abc'));
  assert.equal(await h.router.flushPendingInvites('session-target-abc'), 1, '补投仍可命中（登记未被整写抹掉）');
  await waitFor(() => pushFramesOf(h.out, 'bridge-t').length >= 1);
  assert.ok(pushFramesOf(h.out, 'bridge-t')[0].frame.text.includes('指名项目'), '补投文本照常');
});

test('挂起补投·写回不覆盖并发登记：跨 await 期间新到的登记保留（写回前重读合并）', async (t) => {
  let h = null;
  h = makeHarness(t, {
    onPush: (harness) => {
      /* 并发登记：模拟补投在途（等回执）时另一条指名邀请落到 member.json（登记面是读改写）。 */
      const record = JSON.parse(readFileSync(memberFileOf(harness, 'collab-named'), 'utf8'));
      const frame = inviteFrameOf('collab-named', 'session-late', { payload: { name: '后到项目' } });
      writeFileSync(memberFileOf(harness, 'collab-named'), JSON.stringify({
        ...record,
        pendingInvites: [...record.pendingInvites, { sessionId: 'session-late', frame }],
      }, null, 2), 'utf8');
    },
  });
  h.registry.register(bridgeRecord('bridge-a', 'session-alpha'));
  await receive(h, inviteFrameOf('collab-named', 'session-t'));
  h.registry.register(bridgeRecord('bridge-t', 'session-target-abc'));
  assert.equal(await h.router.flushPendingInvites('session-target-abc'), 1, '本轮补投一条（在途期新登记入库）');
  assert.deepEqual(memberOf(h, 'collab-named').pendingInvites.map((item) => item.sessionId), ['session-late'], '在途新登记保留、本轮已结清的摘除');

  h.registry.register(bridgeRecord('bridge-l', 'session-late-9'));
  assert.equal(await h.router.flushPendingInvites('session-late-9'), 1, '后到登记照常补投（未被旧快照覆盖）');
  await waitFor(() => pushFramesOf(h.out, 'bridge-l').length >= 1);
  assert.ok(pushFramesOf(h.out, 'bridge-l')[0].frame.text.includes('后到项目'), '后到邀请文本照常');
});

/* —— 落点三：点头判定（member.json 的指名 ≠ 点头会话即拒） —— */

test('点头判定：指名会话照常同意；异会话 / 无会话标识一律拒（不改记录、不误绑）', async (t) => {
  const h = makeHarness(t);
  h.registry.register(bridgeRecord('bridge-a', 'session-alpha'));
  await receive(h, inviteFrameOf('collab-named', 'session-t'));

  const byOther = h.service.approve({ collabId: 'collab-named', approve: true, sessionId: 'session-other' });
  assert.equal(byOther.ok, false, '异会话点头：拒');
  assert.match(byOther.message, /指定给了别的会话/, '如实指明本邀请的指名面');
  assert.equal(memberOf(h, 'collab-named').decision ?? null, null, '拒绝不改记录（未表过态）');
  const sessionless = h.service.approve({ collabId: 'collab-named', approve: true });
  assert.equal(sessionless.ok, false, '无会话标识（无上下文）：无从核对指名，拒');

  const byTarget = h.service.approve({ collabId: 'collab-named', approve: true, sessionId: 'session-target-abc' });
  assert.equal(byTarget.ok, true, '指名会话（全标识前缀命中）：照常同意');
  assert.equal(byTarget.decision, 'approved');
});

test('点头判定·未指名：无 targetSessionId 字段照旧（谁点头谁承接）；讨论不设批准门不受影响', async (t) => {
  const h = makeHarness(t);
  h.registry.register(bridgeRecord('bridge-a', 'session-alpha'));
  await receive(h, inviteFrameOf('collab-plain', undefined));
  assert.equal(memberOf(h, 'collab-plain').targetSessionId, undefined, '未指名：不写指名标记');
  const approved = h.service.approve({ collabId: 'collab-plain', approve: true, sessionId: 'session-other' });
  assert.equal(approved.ok, true, '未指名的邀请：任意在席会话可点头（沿旧行为）');
});

test('指名邀请·前缀歧义：两个活跃会话都命中 → 按「不在场」处置（不猜接收者）', async (t) => {
  const h = makeHarness(t);
  h.registry.register(bridgeRecord('bridge-b1', 'session-beta-one'));
  h.registry.register(bridgeRecord('bridge-b2', 'session-beta-two'));
  const received = await receive(h, inviteFrameOf('collab-named', 'session-b'));
  assert.equal(received.delivered, false, '歧义：不投');
  assert.equal(pushFramesOf(h.out).length, 0);
  assert.equal(memberOf(h, 'collab-named').pendingInvites.length, 1, '歧义按不在场登记挂起（短码留存）');
});

/* —— 真核 e2e：组合根挂点（registerBridgeEntry 后补投）与点头判定 —— */

function bridgeClientFor(home, record, { bridgeId, sessionId }) {
  const frames = [];
  const client = createIpcClient({
    dataDir: home,
    hello: { app: record.appVersion, token: record.token, bridgeId, sessionId },
    onFrame: (frame) => {
      frames.push(frame);
      if (frame.type === 'push') {
        client.send({ type: 'delivered', pushId: frame.pushId, ok: true });
      }
    },
    onClose: () => {},
  });
  return { client, frames };
}

/* 真核场景的指名邀请帧（成员名单含对端与本机——准入要求来源与自身都在名单里）。 */
function namedInviteFor(collabId, instanceId, targetSessionId) {
  return {
    v: 1,
    type: 'invite',
    msgId: `msg-${randomUUID()}`,
    from: { ...PEER },
    collabId,
    ts: new Date().toISOString(),
    payload: {
      name: '指名项目',
      topic: '主题',
      members: [PEER, { instanceId, identityName: '本机' }].map((peer) => ({ instanceId: peer.instanceId, identityName: peer.identityName })),
      targetSessionId,
    },
  };
}

/* 真 TCP 探针：一行协作域帧走完整接收管线（准入 → 落盘 → 消费 → 投递判定）。 */
function sendInboundFrame(port, frame) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(`${JSON.stringify(frame)}\n`);
    });
    socket.once('error', () => resolve(false));
    socket.once('data', () => {
      socket.end();
      resolve(true);
    });
    socket.setTimeout(4000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

test('真核 e2e：离线指名邀请挂起 → 目标会话注册即补投到其桥（组合根挂点）；异会话同意被拒', { timeout: 90000 }, async (t) => {
  const home = makeTempDir(t);
  const port = await pickFreePort();
  writeFileSync(join(home, 'config.json'), JSON.stringify({ port, identityName: '本机' }, null, 2));
  const started = await startCore({ env: { ...process.env, WAYSTATION_HOME: home } });
  assert.equal(started.ok, true, started.message ?? '核心启动');
  t.after(() => started.core.stop());
  const record = JSON.parse(readFileSync(coreJsonPath(home), 'utf8'));
  const watcher = bridgeClientFor(home, record, { bridgeId: 'bridge-w', sessionId: 'session-watch' });
  t.after(() => watcher.client.close());
  await watcher.client.connect();

  const collabId = newCollabId();
  assert.equal(await sendInboundFrame(port, namedInviteFor(collabId, record.identity.instanceId, 'session-target')), true, '邀请经真接收管线受理（ack 回程）');
  const memberFile = join(home, 'collabs', collabId, 'member.json');
  await waitFor(() => (existsSync(memberFile) && JSON.parse(readFileSync(memberFile, 'utf8')).pendingInvites?.length === 1 ? true : null), { timeoutMs: 10000 });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(watcher.frames.some((frame) => frame.type === 'push'), false, '目标不在场：此刻不投任何桥');

  const target = bridgeClientFor(home, record, { bridgeId: 'bridge-t', sessionId: 'session-target-a1b2' });
  t.after(() => target.client.close());
  await target.client.connect();
  await waitFor(() => (target.frames.some((frame) => frame.type === 'push' && frame.collabId === collabId) ? true : null), { timeoutMs: 15000 });
  const push = target.frames.find((frame) => frame.type === 'push' && frame.collabId === collabId);
  assert.ok(push.text.includes('指名项目'), '补投文本经核心渲染到达目标会话（注册挂点）');
  assert.equal(watcher.frames.some((frame) => frame.type === 'push' && frame.collabId === collabId), false, '旁观会话不投');
  await waitFor(() => (JSON.parse(readFileSync(memberFile, 'utf8')).pendingInvites.length === 0 ? true : null), { timeoutMs: 10000 });

  const byOther = started.core.context.collab.approve({ collabId, approve: true, sessionId: 'session-watch' });
  assert.equal(byOther.ok, false, '异会话同意：拒（点头判定读 member.json 的指名面）');
  assert.match(byOther.message, /指定给了别的会话/);
});
