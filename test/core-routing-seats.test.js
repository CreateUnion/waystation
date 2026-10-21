import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir } from './helpers.js';
import { bindingsFilePath } from '../src/paths.js';
import { ADOPT_GUIDANCE_NOTICE, createInjectionRouter } from '../src/core/routing.js';

/* 注入路由的席位驱动面（设计 §5.2）：注入来源＝本机席位表，绑定表退役；邀请不受席位过滤；
 * toSessions 定向与坏目标隔离；adopt 按席位判定。假注册表/假 IPC 与 core-routing 主用例同形。 */

function quietLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function registryStub() {
  const entries = [];
  return {
    register(record) {
      const entry = { bridgeId: record.bridgeId, sessionId: record.sessionId ?? null, record };
      entries.push(entry);
      return entry;
    },
    remove: () => {},
    count: () => entries.length,
    list: () => [...entries],
    find: (sessionId) => entries.find((entry) => entry.sessionId === sessionId) ?? null,
  };
}

function makeRouter(t, { seats = [], bindings = null, isGranted = null } = {}) {
  const dir = makeTempDir(t);
  if (bindings !== null) {
    mkdirSync(join(dir, 'run'), { recursive: true });
    writeFileSync(bindingsFilePath(dir), JSON.stringify(bindings), 'utf8');
  }
  const seatsById = new Map(seats.map((seat) => [seat.sessionId, seat]));
  const router = createInjectionRouter({
    dataDir: dir,
    log: quietLog(),
    describeCollab: () => ({ name: '项目甲', mode: 'managed' }),
    isGranted,
    seatsOf: () => [...seatsById.values()],
    seatOf: (collabId, sessionId) => seatsById.get(sessionId) ?? null,
    receiptTimeoutMs: 20,
  });
  const registry = registryStub();
  const out = [];
  router.load();
  router.attach({ registry, ipc: { send: (record, frame) => (out.push({ record, frame }), true) } });
  return { router, registry, out, dir, seatsById };
}

function seatOf(sessionId, overrides = {}) {
  return { sessionId, role: 'member', state: 'member', unverified: false, bridgeId: null, ...overrides };
}

function registerAll(registry, sessionIds) {
  for (const sessionId of sessionIds) {
    registry.register({ bridgeId: `bridge-${sessionId}`, sessionId });
  }
}

function frameOf(collabId, overrides = {}) {
  return {
    v: 1,
    type: 'reply',
    msgId: `msg-${Math.random().toString(16).slice(2)}`,
    from: { instanceId: 'inst-peer', sessionId: 'sess-peer', identityName: '对端', port: 17400 },
    collabId,
    ts: '2026-10-21T08:00:00.000Z',
    payload: { text: '你好' },
    ...overrides,
  };
}

function pushedSessions(out) {
  return out.filter((entry) => entry.frame.type === 'push').map((entry) => entry.record.sessionId);
}

/* push 回执的结算（同 core-routing 主用例：帧立即发出，回执注入后才收口投递结果）。 */
function settlePushes(router, out) {
  for (const { frame } of out) {
    if (frame.type === 'push') {
      router.settleDelivered({ type: 'delivered', pushId: frame.pushId, ok: true });
    }
  }
}

async function deliver(router, out, frame) {
  const pending = router.deliverToSession(frame);
  settlePushes(router, out);
  return pending;
}

test('席位驱动扇出：无 toSessions 投本机全部可注入席位（member/joining），未注册桥的席位跳过', async (t) => {
  const { router, registry, out } = makeRouter(t, {
    seats: [seatOf('sess-a'), seatOf('sess-b', { unverified: true }), seatOf('sess-c', { state: 'joining' })],
  });
  registerAll(registry, ['sess-a', 'sess-c']);
  const ok = await deliver(router, out, frameOf('collab-x'));
  assert.equal(ok, true);
  assert.deepEqual(pushedSessions(out).sort(), ['sess-a', 'sess-c']);
});

test('toSessions 定向：只投列表内席位；不在本机席位表的坏目标被隔离，不把整帧投给其他席位', async (t) => {
  const { router, registry, out } = makeRouter(t, {
    seats: [seatOf('sess-a'), seatOf('sess-b'), seatOf('sess-c')],
  });
  registerAll(registry, ['sess-a', 'sess-b', 'sess-c']);
  const frame = frameOf('collab-x', { payload: { text: '定向', toSessions: ['sess-a', 'sess-ghost', 'sess-c'] } });
  assert.equal(await deliver(router, out, frame), true);
  assert.deepEqual(pushedSessions(out).sort(), ['sess-a', 'sess-c']);
});

test('邀请不受席位过滤：无席位时未指名邀请投全部活跃桥；指名按完整标识／短码精确命中', async (t) => {
  const { router, registry, out } = makeRouter(t, { seats: [] });
  registerAll(registry, ['alpha-session', 'beta-session']);
  const invite = frameOf('collab-inv', { type: 'invite', payload: { name: '项目', topic: '主题', members: [] } });
  assert.equal(await deliver(router, out, invite), true);
  assert.deepEqual(pushedSessions(out).sort(), ['alpha-session', 'beta-session']);

  out.length = 0;
  const named = frameOf('collab-inv', {
    type: 'invite',
    payload: { name: '项目', topic: '主题', members: [], targetSessionId: 'beta-session' },
  });
  assert.equal(await deliver(router, out, named), true);
  assert.deepEqual(pushedSessions(out), ['beta-session']);

  out.length = 0;
  const shortNamed = frameOf('collab-inv', {
    type: 'invite',
    payload: { name: '项目', topic: '主题', members: [], targetSessionId: 'alpha-se' },
  });
  assert.equal(await deliver(router, out, shortNamed), true, '短码 8 字符精确命中 alpha-session');
  assert.deepEqual(pushedSessions(out), ['alpha-session']);
});

test('邀请短码歧义：token 同时命中两席 → 不猜接收者（不投任何桥）', async (t) => {
  const { router, registry, out } = makeRouter(t, { seats: [] });
  registerAll(registry, ['alpha-session', 'beta-session']);
  const ambiguous = frameOf('collab-inv', {
    type: 'invite',
    payload: { name: '项目', topic: '主题', members: [], targetSessionId: 'shared-a' },
  });
  assert.equal(await deliver(router, out, ambiguous), false);
  assert.deepEqual(pushedSessions(out), []);
});

test('绑定表退役：run/bindings.json 不参与注入（席位提供器在场时以席位为准）', async (t) => {
  const bindings = { 'collab-x': { sessionId: 'sess-other', bridgeId: 'bridge-other', boundAt: '2026-10-21T08:00:00.000Z', origin: 'create' } };
  const { router, registry, out, dir } = makeRouter(t, { seats: [seatOf('sess-a')], bindings });
  const original = readFileSync(bindingsFilePath(dir), 'utf8');
  registerAll(registry, ['sess-a', 'sess-other']);
  assert.equal(await deliver(router, out, frameOf('collab-x')), true);
  assert.deepEqual(pushedSessions(out), ['sess-a'], '只投席位，不投旧绑定会话');
  assert.equal(router.bindings.get('collab-x'), null, 'load 不再读旧绑定文件');
  assert.equal(readFileSync(bindingsFilePath(dir), 'utf8'), original, '旧文件留盘不改写');
});

test('机器级提示：无调用者上下文时投本机全部席位；无席位丢弃并留痕（返回 false）', async (t) => {
  const { router, registry, out } = makeRouter(t, { seats: [seatOf('sess-a'), seatOf('sess-b')] });
  registerAll(registry, ['sess-a']);
  const notice = { ...frameOf('collab-x'), type: 'notice', payload: { event: 'local-alert', text: '提示' } };
  assert.equal(router.notify(notice), true);
  assert.deepEqual(pushedSessions(out), ['sess-a']);

  const empty = makeRouter(t, { seats: [] });
  const second = { ...frameOf('collab-y'), type: 'notice', payload: { event: 'local-alert', text: '提示' } };
  assert.equal(empty.router.notify(second), false);
});

test('adopt 按席位判定：已有席位不夺席；无席位且未获准给指引；获准后只记内存绑定不落盘', (t) => {
  const { router, dir } = makeRouter(t, {
    seats: [seatOf('sess-a')],
    isGranted: (collabId, sessionId) => sessionId === 'sess-granted',
  });
  assert.deepEqual(
    router.applyAdopt({ tool: 'ws_send_message', args: { collabId: 'collab-x' }, caller: { bridgeId: 'b-a', sessionId: 'sess-a' } }),
    { adopted: false, notice: null },
  );
  const refused = router.applyAdopt({ tool: 'ws_send_message', args: { collabId: 'collab-x' }, caller: { bridgeId: 'b-b', sessionId: 'sess-b' } });
  assert.equal(refused.adopted, false);
  assert.equal(refused.notice, ADOPT_GUIDANCE_NOTICE);
  const adopted = router.applyAdopt({ tool: 'ws_send_message', args: { collabId: 'collab-x' }, caller: { bridgeId: 'b-g', sessionId: 'sess-granted' } });
  assert.equal(adopted.adopted, true);
  assert.equal(existsSync(bindingsFilePath(dir)), false, '绑定表已退役：不写 run/bindings.json');
});

test('deliverToSeat：本机旁路出口只投指定席位的桥，桥不在线返回 false', async (t) => {
  const { router, registry, out } = makeRouter(t, { seats: [seatOf('sess-a')] });
  registerAll(registry, ['sess-a']);
  const pending = router.deliverToSeat('sess-a', frameOf('collab-x'));
  settlePushes(router, out);
  assert.equal(await pending, true);
  assert.deepEqual(pushedSessions(out), ['sess-a']);
  assert.equal(await router.deliverToSeat('sess-missing', frameOf('collab-x')), false);
});
