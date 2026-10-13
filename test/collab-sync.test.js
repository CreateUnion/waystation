import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { collabFilePath } from '../src/paths.js';
import { makeTempDir, waitFor } from './helpers.js';
import { createCollabService } from '../src/collab/service.js';
import { MEMBERS_FILE_NAME } from '../src/collab/members.js';
import { POSTS_FILE_NAME } from '../src/collab/posts.js';
import { comparePosition, rollbackPlanOf, summaryOf } from '../src/collab/sync.js';
import { createInbound } from '../src/net/inbound.js';

const DAY = 24 * 60 * 60 * 1000;
const BASE_MS = Date.parse('2026-10-13T00:00:00.000Z');
const AUTHOR_U = { instanceId: 'inst-u', identityName: '主机U', port: 17331 };

function quietLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

/* 服务夹具（对表/收敛用例专用）：假发送（入队只记账）+ 可注入直投（虚拟线）+ 假提示面。
 * 对端选取默认静默——每个用例显式注入固定对端序（确定性测试手段）；
 * 入站限流默认放宽（限流判定由专门用例按产品默认值判别）。 */
function makeService(t, overrides = {}) {
  const dir = makeTempDir(t);
  const sent = [];
  const direct = [];
  const notices = [];
  const self = overrides.self ?? { instanceId: 'inst-self', identityName: '本机', port: 17321 };
  const config = { inviteTtlMs: DAY, ...(overrides.config ?? {}) };
  const service = createCollabService({
    dataDir: dir,
    config,
    self,
    send: (message) => {
      sent.push(message);
      return { ok: true, msgId: `q-${sent.length}` };
    },
    sendDirect: overrides.sendDirect ?? ((message) => {
      direct.push(message);
      return { ok: true, msgId: `d-${direct.length}` };
    }),
    notify: (frame) => {
      notices.push(frame);
    },
    knownHosts: { remember: () => {} },
    log: quietLog(),
    ledgerFetchTimeoutMs: 30,
    inviteMinIntervalMs: 0,
    ...syncOverridesOf(overrides),
  });
  return { service, sent, direct, notices, dir, self, config };
}

/* 对表/收敛参数（用例按需覆盖；缺省为测试友好的收敛值，产品默认见模块常量）。 */
function syncOverridesOf(overrides) {
  return {
    pullReplyTimeoutMs: overrides.pullReplyTimeoutMs ?? 60,
    syncPeerPicker: overrides.syncPeerPicker ?? (() => []),
    syncRequestMax: overrides.syncRequestMax ?? 50,
    syncMaxRequestsPerCycle: overrides.syncMaxRequestsPerCycle ?? 2,
    syncSoftBundleBytes: overrides.syncSoftBundleBytes ?? 512 * 1024,
    joinReplayIntervalsMs: overrides.joinReplayIntervalsMs ?? [10, 20, 40],
  };
}

let seq = 0;

function peer(instanceId, identityName, port = 17321) {
  return { instanceId, identityName, port };
}

const SELF_A = { instanceId: 'inst-a', identityName: '主机甲', port: 17321 };
const SELF_B = { instanceId: 'inst-b', identityName: '主机乙', port: 17322 };

function collabFrame(type, collabId, from, payload) {
  seq++;
  return { v: 1, type, msgId: `msg-${type}-${seq}`, from: { instanceId: from.instanceId, identityName: from.identityName, port: from.port }, collabId, ts: new Date().toISOString(), payload };
}

function inviteFrame({ collabId, manager = SELF_A, members, name = '联调项目', topic = '发布联调', mode, endpoints } = {}) {
  seq++;
  const roster = members ?? [manager, { instanceId: 'inst-self', identityName: '本机', port: 17321 }];
  const payload = { name, topic, members: roster.map((entry) => ({ instanceId: entry.instanceId, identityName: entry.identityName })) };
  if (mode !== undefined) {
    payload.mode = mode;
  }
  if (endpoints !== undefined) {
    payload.endpoints = endpoints;
  }
  return { v: 1, type: 'invite', msgId: `msg-inv-${seq}`, from: { instanceId: manager.instanceId, identityName: manager.identityName, port: manager.port }, collabId: collabId ?? `collab-${seq}`, ts: new Date().toISOString(), payload };
}

function joinFrameOf(collabId, from, ts = null) {
  return collabFrame('join', collabId, from, { eventId: randomUUID(), ts: ts ?? new Date().toISOString() });
}

function forumPostFrame(collabId, from, { postId, seq: postSeq, kind = 'reply', text }, ts) {
  const frame = collabFrame('post', collabId, from, { post: { postId, seq: postSeq, kind, text } });
  if (ts !== undefined) {
    frame.ts = ts;
  }
  return frame;
}

async function receive(service, frame, remoteAddress = '127.0.0.1') {
  const admitted = await service.hooks.admit(frame, { remoteAddress });
  if (admitted?.ok === true) {
    await service.hooks.consume(frame, { remoteAddress });
  }
  return admitted;
}

function sentOf(sent, type, collabId = null) {
  return sent.filter((entry) => entry.type === type && (collabId === null || entry.collabId === collabId));
}

function wireFramesOf(frames, type, collabId = null) {
  return frames.filter((frame) => frame.type === type && (collabId === null || frame.collabId === collabId));
}

/* 保活等待：对表轮次的应答等待面用 unref 定时器（生产语义：会话关闭即退出）——测试里等待
 * 一个可能「无应答」的轮次时需要外部保活，否则 node:test 判定事件循环已空而取消本文件。 */
async function awaitSync(pending) {
  const keepAlive = setInterval(() => {}, 20);
  try {
    return await pending;
  } finally {
    clearInterval(keepAlive);
  }
}

/* 直投虚拟线：sendDirect → 组上线帧（与 dispatch.sendDirect 的帧同构）→ 投进对端接收管线；
 * hop = 手工一跳投递（入队广播与既有帧的重投用）。 */
function makeWire() {
  const nodes = new Map();
  const frames = [];
  let serial = 0;
  const build = (message, fromSelf) => {
    serial++;
    return {
      v: 1,
      type: message.type,
      msgId: `wire-${serial}`,
      from: { instanceId: fromSelf.instanceId, identityName: fromSelf.identityName, port: fromSelf.port },
      collabId: message.collabId,
      ts: typeof message.createdAt === 'string' ? message.createdAt : new Date().toISOString(),
      payload: message.payload,
    };
  };
  /* 来源地址按端口派生（127.0.0.<port-17320>）：同源限流用例的记账面与手投请求互不污染。 */
  const addressOf = (self) => `127.0.0.${self.port - 17320}`;
  return {
    register(self, service) {
      nodes.set(self.instanceId, { self, service });
    },
    frames,
    sendDirectFor(self) {
      return (message) => {
        const frame = build(message, self);
        frames.push(frame);
        const target = nodes.get(message.to.instanceId);
        if (target !== undefined) {
          Promise.resolve().then(() => receive(target.service, frame, addressOf(self))).catch(() => {});
        }
        return { ok: true, msgId: frame.msgId };
      };
    },
    async hop(service, message, fromSelf) {
      return receive(service, { ...build(message, fromSelf), msgId: `hop-${randomUUID()}` }, addressOf(fromSelf));
    },
  };
}

/* 双节点对表场景：A=发起人（管理席位）、B=成员（受邀并已加入）。
 * B 的自播 join 经手工一跳送达 A；B 再对表一轮拉回 A 的事件集（双方成员表装配完成）。
 * overrides.a / overrides.b 覆盖各端构造面（软阈、预算、重播间隔等）。 */
async function makeForumPair(t, overrides = {}) {
  const wire = makeWire();
  const selfA = overrides.selfA ?? SELF_A;
  const selfB = overrides.selfB ?? SELF_B;
  const madeA = makeService(t, { self: selfA, sendDirect: wire.sendDirectFor(selfA), syncPeerPicker: () => [selfB.instanceId], ...overrides.a });
  wire.register(selfA, madeA.service);
  const madeB = makeService(t, { self: selfB, sendDirect: wire.sendDirectFor(selfB), syncPeerPicker: () => [selfA.instanceId], ...overrides.b });
  wire.register(selfB, madeB.service);
  const made = madeA.service.create({
    name: '讨论甲',
    topic: '议题',
    mode: 'forum',
    targets: [{ instanceId: selfB.instanceId, identityName: selfB.identityName, address: '127.0.0.2', port: selfB.port }],
  });
  const collabId = made.collabId;
  await receive(madeB.service, inviteFrame({
    collabId,
    name: '讨论甲',
    topic: '议题',
    mode: 'forum',
    manager: peer(selfA.instanceId, selfA.identityName, selfA.port),
    members: [peer(selfA.instanceId, selfA.identityName, selfA.port), peer(selfB.instanceId, selfB.identityName, selfB.port)],
  }));
  await madeB.service.approve({ collabId, approve: true });
  const joinMessage = sentOf(madeB.sent, 'join', collabId)[0];
  await wire.hop(madeA.service, joinMessage, selfB);
  await awaitSync(madeB.service.sync({ collabId }));
  return { wire, selfA, selfB, a: madeA, b: madeB, collabId, joinMessage };
}

/* 以第三方作者的帖注入目标节点（直投帧形态；ts 按序号单调、间隔 1 分钟——超出尾部时间窗，
 * 中段洞用例的洞才落在窗口之外）。 */
async function injectPosts(target, collabId, posts) {
  for (const post of posts) {
    const frame = forumPostFrame(collabId, AUTHOR_U, { postId: post.postId, seq: post.seq, text: post.text }, new Date(BASE_MS + post.seq * 60000).toISOString());
    await receive(target, frame);
  }
}

function postsOf(count, skip = []) {
  return Array.from({ length: count }, (_, index) => ({ postId: `post-${index + 1}`, seq: index + 1, text: `第${index + 1}帖` }))
    .filter((post) => !skip.includes(post.seq));
}

function viewMembers(view) {
  return view.members.map((entry) => entry.instanceId);
}

/* —— 摘要与回退起点（真对账的判据面，纯函数判别） —— */

function entryOf(authorId, seq, ts) {
  return { entryId: `post-${authorId}-${seq}`, seq, ts, from: { instanceId: authorId, identityName: authorId }, kind: 'reply', text: `x${seq}` };
}

test('作者粒度摘要：每作者计数 + 已见序号集（范围内联编码）；同一集合折叠同值', () => {
  const entries = [
    entryOf('inst-a', 1, '2026-10-13T00:00:01.000Z'),
    entryOf('inst-a', 2, '2026-10-13T00:00:02.000Z'),
    entryOf('inst-a', 4, '2026-10-13T00:00:04.000Z'),
    entryOf('inst-b', 1, '2026-10-13T00:00:03.000Z'),
  ];
  const summary = summaryOf(entries);
  assert.deepEqual(summary.authors, [
    { instanceId: 'inst-a', count: 3, seqs: [[1, 2], [4, 4]] },
    { instanceId: 'inst-b', count: 1, seqs: [[1, 1]] },
  ]);
  assert.deepEqual(summaryOf([...entries].reverse()).authors, summary.authors, '与扫描序无关（确定性）');
});

test('回退起点：对端有而本机缺的最早序号 → 本机更早一条的落点；定位不到 → 整粒度重拉（null）', () => {
  const mine = [entryOf('inst-u', 1, '2026-10-13T00:00:01.000Z'), entryOf('inst-u', 2, '2026-10-13T00:00:02.000Z'), entryOf('inst-u', 4, '2026-10-13T00:00:04.000Z')];
  const theirs = summaryOf([...mine, entryOf('inst-u', 3, '2026-10-13T00:00:03.000Z')]);
  const plan = rollbackPlanOf(mine, theirs);
  assert.equal(plan.needed, true);
  assert.deepEqual(plan.start, { ts: '2026-10-13T00:00:02.000Z', postId: 'post-inst-u-2' }, '起点 = 缺失序号 3 之前的本机最大序号（2）落点');
  assert.equal(rollbackPlanOf(mine, summaryOf(mine)).needed, false, '摘要一致（本机不缺对端所有）→ 无须回退');
  const ahead = rollbackPlanOf([...mine, entryOf('inst-u', 5, '2026-10-13T00:00:05.000Z')], summaryOf(mine));
  assert.equal(ahead.needed, false, '本机领先（对端缺本机的帖）→ 本机无须动作');
  const fromStart = rollbackPlanOf([entryOf('inst-u', 2, '2026-10-13T00:00:02.000Z')], summaryOf([entryOf('inst-u', 1, '2026-10-13T00:00:01.000Z'), entryOf('inst-u', 2, '2026-10-13T00:00:02.000Z')]));
  assert.deepEqual(fromStart, { needed: true, start: null }, '缺对端首条 / 无可定位更早帖 → 整粒度重拉');
  assert.equal(comparePosition('2026-10-13T00:00:01.000Z', 'a', '2026-10-13T00:00:01.000Z', 'b'), -1, '同刻按 postId 序兜底');
});

/* —— 拉取与回填 —— */

test('新人回填：after=空（全量）拉取——帖入列、成员事件并集、元状态学习、汇总行、游标落盘', async (t) => {
  const { wire, a, b, collabId } = await makeForumPair(t);
  await injectPosts(a.service, collabId, postsOf(2));
  const outcome = await awaitSync(b.service.sync({ collabId }));
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  const requests = wireFramesOf(wire.frames, 'history-request', collabId);
  assert.equal(requests[requests.length - 1].payload.after, null, '新人本地无数据：after=空（全量）');
  const view = await b.service.view({ collabId });
  assert.equal(view.posts.length, 2, '回填帖落本地列表');
  assert.equal(view.topic, '议题', '元状态（主题）经对表学习');
  assert.deepEqual(viewMembers(view), ['inst-a', 'inst-b'], '成员事件集并集：发起人的创建 join 事件学到');
  assert.equal(b.service.stats().syncPostsBackfilled, 2);
  assert.ok(b.notices.some((frame) => frame.payload.text.includes('已回填 2 帖')), '回填汇总一行（拉取通道静默入列）');
  assert.equal(b.service.stats().postsIn, 0, '拉取到位不是「收到直投帖」');
  const member = JSON.parse(readFileSync(collabFilePath(b.dir, collabId, 'member.json'), 'utf8'));
  assert.deepEqual(member.syncCursor, { ts: '2026-10-13T00:02:00.000Z', postId: 'post-2' }, '同步游标落盘（只由拉取推进）');
});

test('游标语义：直投到位只进列表不动游标；已有数据后 after=同步游标（增量续拉）', async (t) => {
  const { wire, a, b, collabId } = await makeForumPair(t);
  await receive(b.service, forumPostFrame(collabId, AUTHOR_U, { postId: 'post-1', seq: 1, text: '直投到位的帖' }, new Date(BASE_MS + 1000).toISOString()));
  assert.equal((await b.service.view({ collabId })).posts.length, 1);
  await injectPosts(a.service, collabId, postsOf(1));
  await awaitSync(b.service.sync({ collabId }));
  const firstRequest = wireFramesOf(wire.frames, 'history-request', collabId)[0];
  assert.equal(firstRequest.payload.after, null, '直投不推游标：拉取起点仍为空游标（漏段不被游标跳过）');
  await injectPosts(a.service, collabId, [{ postId: 'post-2', seq: 2, text: '第二帖' }]);
  await awaitSync(b.service.sync({ collabId }));
  const requests = wireFramesOf(wire.frames, 'history-request', collabId);
  assert.deepEqual(requests[requests.length - 1].payload.after, { ts: '2026-10-13T00:01:00.000Z', postId: 'post-1' }, '已有数据：after = 同步游标');
  assert.equal((await b.service.view({ collabId })).posts.length, 2);
});

test('真对账检出中段洞并修复：游标已越过、洞在尾窗之外——检出 → 回退重拉（起点低于游标）→ 补上', async (t) => {
  const { wire, a, b, collabId } = await makeForumPair(t);
  /* 阶段一：A 侧当时也缺第 3 帖——B 全量拉取后随 A 收敛到同一集合（1,2,4..25），游标越过第 3 帖位置。 */
  await injectPosts(a.service, collabId, postsOf(25, [3]));
  await awaitSync(b.service.sync({ collabId }));
  assert.equal((await b.service.view({ collabId })).posts.length, 24);
  assert.equal(b.service.stats().syncMismatches, 0, '阶段一摘要一致（双方同集合）');
  /* 阶段二：第 3 帖到达 A（迟到直投）；B 的增量段与尾部窗口（最近 20 帖）都不含它（洞在中段）。 */
  await injectPosts(a.service, collabId, [postsOf(25)[2]]);
  /* 阶段三：B 的下一轮对表（固定对端序 → A）检出摘要不一致 → 回退重拉。 */
  const rolled = await awaitSync(b.service.sync({ collabId }));
  assert.equal(rolled.ok, true, JSON.stringify(rolled));
  assert.equal(b.service.stats().syncMismatches, 1, '摘要不一致被检出（真对账）');
  assert.equal(b.service.stats().syncRollbacks, 1, '有界回退重拉发起');
  const view = await b.service.view({ collabId });
  assert.equal(view.posts.length, 25, '洞补上');
  assert.ok(view.posts.some((entry) => entry.entryId === 'post-3'));
  const requests = wireFramesOf(wire.frames, 'history-request', collabId);
  assert.deepEqual(requests[requests.length - 1].payload.after, { ts: new Date(BASE_MS + 120000).toISOString(), postId: 'post-2' }, '重拉起点低于游标（可定位的最早不一致处之前——第三条 after 路径）');
});

test('尾部重叠窗口（辅助）：近端洞不经回退即自愈（摘要比对前已一致）', async (t) => {
  const { a, b, collabId } = await makeForumPair(t);
  await injectPosts(a.service, collabId, postsOf(25, [24]));
  await awaitSync(b.service.sync({ collabId }));
  assert.equal((await b.service.view({ collabId })).posts.length, 24);
  const before = b.service.stats();
  await injectPosts(a.service, collabId, [postsOf(25)[23]]);
  const tailed = await awaitSync(b.service.sync({ collabId }));
  assert.equal(tailed.ok, true);
  const view = await b.service.view({ collabId });
  assert.equal(view.posts.length, 25, '尾部窗口把近端洞带回');
  assert.equal(b.service.stats().syncMismatches, before.syncMismatches, '不经真对账回退（尾窗先自愈）');
  assert.equal(b.service.stats().syncRollbacks, before.syncRollbacks);
});

test('分段续拉：软阈之下分段（more / nextAfter）、续拉直至追平', async (t) => {
  const { wire, a, b, collabId } = await makeForumPair(t, { a: { syncSoftBundleBytes: 380 }, b: { syncMaxRequestsPerCycle: 20 } });
  await injectPosts(a.service, collabId, postsOf(6));
  const outcome = await awaitSync(b.service.sync({ collabId }));
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal((await b.service.view({ collabId })).posts.length, 6, '续拉直至追平');
  assert.equal(b.service.stats().syncSegments, 2, '两段 more=true 的续拉');
  const requests = wireFramesOf(wire.frames, 'history-request', collabId);
  const bundles = wireFramesOf(wire.frames, 'history-bundle', collabId);
  assert.ok(requests.length >= 3, `分段续拉请求（实际 ${requests.length}）`);
  assert.equal(bundles.filter((frame) => frame.payload.more === true).every((frame) => frame.payload.nextAfter !== undefined), true, 'more=true 必携续拉游标');
  const continueAfters = requests.map((frame) => frame.payload.after).filter((after) => after !== null);
  const nextAfters = bundles.map((frame) => frame.payload.nextAfter).filter((cursor) => cursor !== undefined);
  assert.deepEqual(continueAfters, nextAfters, '续拉起点 = 上一段末帖落点（按序一一对应）');
});

/* —— 成员收敛 —— */

test('join 未收敛重播（对表自愈）：递增间隔有界；拉回的表含自己即停', async (t) => {
  const wire = makeWire();
  const madeA = makeService(t, { self: SELF_A, sendDirect: wire.sendDirectFor(SELF_A) });
  wire.register(SELF_A, madeA.service);
  const madeB = makeService(t, { self: SELF_B, sendDirect: wire.sendDirectFor(SELF_B), syncPeerPicker: () => [SELF_A.instanceId], joinReplayIntervalsMs: [10, 20] });
  wire.register(SELF_B, madeB.service);
  const collabId = madeA.service.create({ name: '讨论甲', topic: '议题', mode: 'forum', targets: [{ instanceId: SELF_B.instanceId, identityName: SELF_B.identityName, address: '127.0.0.2', port: SELF_B.port }] }).collabId;
  await receive(madeB.service, inviteFrame({ collabId, mode: 'forum', manager: peer(SELF_A.instanceId, SELF_A.identityName, SELF_A.port), members: [peer(SELF_A.instanceId, SELF_A.identityName, SELF_A.port), peer(SELF_B.instanceId, SELF_B.identityName, SELF_B.port)] }));
  await madeB.service.approve({ collabId, approve: true });
  const joinCount = () => sentOf(madeB.sent, 'join', collabId).length;
  assert.equal(joinCount(), 1, '同意即自播 join（立即一次）');
  await waitFor(() => (joinCount() >= 3 ? true : null), { timeoutMs: 2000 });
  assert.equal(madeB.service.stats().joinReplays, 3, '立即一次 + 两档递增间隔（有界）');
  await new Promise((resolve) => setTimeout(resolve, 60));
  const settled = joinCount();
  /* 幽灵自愈：B 对表拉回 A 的表（A 尚未收过 B 的 join——本用例刻意未投递）→ 重播。 */
  await awaitSync(madeB.service.sync({ collabId }));
  assert.equal(joinCount(), settled + 1, 'tick 拉回的成员表不含自己 → 重播 join');
  /* 收敛判据达成：A 收悉 B 的 join → B 再对表 → 表含自己 → 停止重播。 */
  await receive(madeA.service, joinFrameMessage(sentOf(madeB.sent, 'join', collabId)[0], SELF_B));
  await awaitSync(madeB.service.sync({ collabId }));
  await new Promise((resolve) => setTimeout(resolve, 60));
  const afterConverge = joinCount();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(joinCount(), afterConverge, '对端表已含自己：重播停止（不再增殖）');
});

/* 入队帧 → 上线帧（保持 payload 与 from；msgId 换新——模拟重播/重投的新副本）。 */
function joinFrameMessage(message, fromSelf) {
  return {
    v: 1,
    type: message.type,
    msgId: `replay-${randomUUID()}`,
    from: { instanceId: fromSelf.instanceId, identityName: fromSelf.identityName, port: fromSelf.port },
    collabId: message.collabId,
    ts: new Date().toISOString(),
    payload: message.payload,
  };
}

test('join 幂等并集与抗重放：重复副本不重复计数入表；leave 后旧 join 重放不复活；re-join 可入', async (t) => {
  const { a, joinMessage, collabId } = await makeForumPair(t);
  const before = a.service.stats().forumJoinsIn;
  await receive(a.service, joinFrameMessage(joinMessage, SELF_B));
  assert.equal(a.service.stats().forumJoinsIn, before, '同事件 id 重放幂等（并集吸收）');
  assert.equal(a.service.stats().forumJoinDuplicates >= 1, true);
  /* 事件时刻显式排后（B 自身单调时钟的真实形态）：确保折叠取 leave 为最新。 */
  const leaveTs = new Date(Date.now() + 5000).toISOString();
  const leaveFrame = collabFrame('leave', collabId, peer(SELF_B.instanceId, SELF_B.identityName, SELF_B.port), { eventId: randomUUID(), ts: leaveTs });
  await receive(a.service, leaveFrame);
  assert.deepEqual(viewMembers(await a.service.view({ collabId })), ['inst-a'], '退出者出表');
  await receive(a.service, joinFrameMessage(joinMessage, SELF_B));
  assert.deepEqual(viewMembers(await a.service.view({ collabId })), ['inst-a'], '旧 join 重放不复活已退出成员');
  await receive(a.service, joinFrameOf(collabId, peer(SELF_B.instanceId, SELF_B.identityName, SELF_B.port), new Date(Date.parse(leaveTs) + 1000).toISOString()));
  assert.deepEqual(viewMembers(await a.service.view({ collabId })), ['inst-a', 'inst-b'], 're-join = 新 join 事件（重入）');
});

test('发起人退出（leave 自播）：成员表出表、讨论存续（成员仍可发帖）；结束权随退出放弃', async (t) => {
  const { wire, selfA, a, b, collabId } = await makeForumPair(t);
  const left = await a.service.leave({ collabId });
  assert.equal(left.ok, true, left.message);
  assert.equal(a.service.list().collabs[0].state, 'left', '发起人退出 → 本机归档');
  assert.equal((await a.service.end({ collabId })).ok, false, '发起人退出即放弃结束权');
  const leaveMessage = sentOf(a.sent, 'leave', collabId)[0];
  assert.ok(leaveMessage !== undefined, 'leave 事件广播发出');
  await wire.hop(b.service, leaveMessage, selfA);
  assert.deepEqual(viewMembers(await b.service.view({ collabId })), ['inst-b'], '成员折叠表移除发起人');
  assert.equal(b.service.list().collabs[0].state, 'active', '讨论存续（非终态）');
  const posted = await b.service.send({ collabId, text: '发起人离开后的帖' });
  assert.equal(posted.ok, true, '讨论存续：成员仍可发帖');
});

/* —— end 双通道与终态吸收 —— */

test('end 双通道：在线广播即归档；离线者回归经 bundle 元状态学 end → 本地转归档；终态吸收不回退', async (t) => {
  const { wire, selfA, selfB, a, b, collabId } = await makeForumPair(t);
  await injectPosts(a.service, collabId, postsOf(2));
  /* C 受邀并加入，但此后「离线」（不投递任何帧给 C）。 */
  const selfC = { instanceId: 'inst-c', identityName: '主机丙', port: 17323 };
  const madeC = makeService(t, { self: selfC, sendDirect: wire.sendDirectFor(selfC), syncPeerPicker: () => [selfA.instanceId] });
  wire.register(selfC, madeC.service);
  await receive(madeC.service, inviteFrame({ collabId, mode: 'forum', manager: peer(selfA.instanceId, selfA.identityName, selfA.port), members: [peer(selfA.instanceId, selfA.identityName, selfA.port), peer(selfB.instanceId, selfB.identityName, selfB.port), peer(selfC.instanceId, selfC.identityName, selfC.port)], endpoints: { [selfA.instanceId]: { address: '127.0.0.1', port: selfA.port } } }));
  await madeC.service.approve({ collabId, approve: true });
  await receive(a.service, joinFrameOf(collabId, peer(selfC.instanceId, selfC.identityName, selfC.port)));
  /* 发起人结束：广播 end（豁免 TTL/上限）；在线者 B 经广播通道。 */
  const ended = await a.service.end({ collabId });
  assert.equal(ended.ok, true);
  assert.equal(a.service.list().collabs[0].state, 'completed');
  const endMessage = sentOf(a.sent, 'end', collabId)[0];
  assert.ok(endMessage !== undefined, 'end 广播发出');
  await wire.hop(b.service, endMessage, selfA);
  assert.equal(b.service.list().collabs[0].state, 'completed', '在线者收 end 广播即归档');
  /* 离线者 C 回归：对表拉取（归档后的 A 仍应答——只读回填通道不因归档关闭）。 */
  const outcome = await awaitSync(madeC.service.sync({ collabId }));
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(madeC.service.list().collabs[0].state, 'completed', '经 bundle 元状态学到 end → 本地转归档');
  assert.equal((await madeC.service.view({ collabId })).posts.length, 2, '归档后回填仍可达');
  assert.equal(madeC.service.stats().syncTerminalsIn, 1);
  /* 终态吸收：陈旧副本（meta=active）不把 completed 回退。 */
  const staleBundle = {
    v: 1,
    type: 'history-bundle',
    msgId: `stale-${randomUUID()}`,
    from: { instanceId: selfA.instanceId, identityName: selfA.identityName, port: selfA.port },
    collabId,
    ts: new Date().toISOString(),
    payload: { cursor: null, more: false, posts: [], overlap: [], meta: { state: 'active', name: '讨论甲', topic: '议题' }, members: [], endpoints: {} },
  };
  assert.equal((await receive(madeC.service, staleBundle)).ok, true);
  assert.equal(madeC.service.list().collabs[0].state, 'completed', '任何来源不得把终态回退到先前状态');
  /* 归档后新帖照拒。 */
  const latePost = forumPostFrame(collabId, AUTHOR_U, { postId: 'post-late', seq: 9, text: '结束后的帖' }, new Date(BASE_MS + 9000).toISOString());
  assert.equal((await receive(a.service, latePost)).ok, false, '归档后新帖照拒');
  assert.equal(a.service.stats().lateDropped >= 1, true);
});

/* —— 无应答与限流 —— */

test('无应答统一处理：不重试该源、换源重试；源耗尽则本轮放弃（下轮 tick 兜底）', async (t) => {
  const wire = makeWire();
  const madeA = makeService(t, { self: SELF_A, sendDirect: wire.sendDirectFor(SELF_A), syncPeerPicker: () => [SELF_B.instanceId, 'inst-c'], pullReplyTimeoutMs: 25 });
  wire.register(SELF_A, madeA.service);
  const collabId = madeA.service.create({
    name: '讨论甲',
    topic: '议题',
    mode: 'forum',
    targets: [
      { instanceId: SELF_B.instanceId, identityName: SELF_B.identityName, address: '127.0.0.2', port: SELF_B.port },
      { instanceId: 'inst-c', identityName: '主机丙', address: '127.0.0.3', port: 17323 },
    ],
  }).collabId;
  const selfC = { instanceId: 'inst-c', identityName: '主机丙', port: 17323 };
  const madeC = makeService(t, { self: selfC, sendDirect: wire.sendDirectFor(selfC), syncPeerPicker: () => [SELF_A.instanceId] });
  wire.register(selfC, madeC.service);
  await receive(madeC.service, inviteFrame({ collabId, mode: 'forum', manager: peer(SELF_A.instanceId, SELF_A.identityName, SELF_A.port), members: [peer(SELF_A.instanceId, SELF_A.identityName, SELF_A.port), peer('inst-c', '主机丙', 17323)] }));
  await madeC.service.approve({ collabId, approve: true });
  await receive(madeA.service, joinFrameOf(collabId, peer('inst-c', '主机丙', 17323)));   // C 的 join 先达 A（应答条件：请求方在成员表内）
  await awaitSync(madeC.service.sync({ collabId }));   // C 的对表（从 A 拉回事件集——C 的表含 A）
  await receive(madeA.service, joinFrameOf(collabId, peer(SELF_B.instanceId, SELF_B.identityName, SELF_B.port)));   // B 在表内但不在线（虚拟线未注册）
  await waitFor(() => (madeA.service.stats().syncNoAnswer >= 1 ? true : null), { timeoutMs: 2000 });   // join 到达触发的后台一轮先收尾
  const before = madeA.service.stats().syncNoAnswer;
  const outcome = await awaitSync(madeA.service.sync({ collabId }));
  assert.equal(outcome.ok, true, '换源后取得应答');
  assert.equal(outcome.sourceId, 'inst-c', 'B 无应答 → 换源到 C');
  assert.equal(madeA.service.stats().syncNoAnswer, before + 1, '无应答计数（不重试该源）');
  const unreachable = makeService(t, { self: SELF_A, sendDirect: () => ({ ok: true, msgId: 'x' }), syncPeerPicker: () => [SELF_B.instanceId], pullReplyTimeoutMs: 20 });
  const lonely = unreachable.service.create({ name: '讨论乙', topic: '议题', mode: 'forum', targets: [{ instanceId: SELF_B.instanceId, identityName: SELF_B.identityName, address: '127.0.0.2', port: SELF_B.port }] }).collabId;
  await receive(unreachable.service, joinFrameOf(lonely, peer(SELF_B.instanceId, SELF_B.identityName, SELF_B.port)));
  await waitFor(() => (unreachable.service.stats().syncNoAnswer >= 1 ? true : null), { timeoutMs: 2000 });   // join 到达触发的后台一轮先收尾
  const abandoned = await awaitSync(unreachable.service.sync({ collabId: lonely }));
  assert.equal(abandoned.ok, false);
  assert.equal(abandoned.reason, 'no-answer', '全部源无应答：本轮放弃（下轮 tick 自动再来）');
});

test('请求类入站限流（同源 10s 内 2 次，产品默认值判别）与非成员拒绝计数', async (t) => {
  /* 产品默认数值显式注入（模块常量：窗口 10s、上限 2 次）。 */
  const { a, collabId } = await makeForumPair(t, { a: { syncRequestMax: 2, syncRequestWindowMs: 10000 } });
  const request = () => collabFrame('history-request', collabId, peer(SELF_B.instanceId, SELF_B.identityName, SELF_B.port), {});
  assert.equal((await receive(a.service, request())).ok, true);
  assert.equal((await receive(a.service, request())).ok, true);
  const throttled = await receive(a.service, request());
  assert.equal(throttled.ok, false, '第三跳在窗口内被限流');
  assert.ok(throttled.reason.includes('频繁'), throttled.reason);
  assert.equal(a.service.stats().syncRequestsThrottled, 1);
  const stranger = collabFrame('history-request', collabId, peer('inst-z', '主机Z', 17399), {});
  const rejected = await receive(a.service, stranger);
  assert.equal(rejected.ok, false, '非成员请求拒绝');
  assert.ok(rejected.reason.includes('成员表'), rejected.reason);
  assert.equal(a.service.stats().syncRequestsRejected, 1);
});

/* —— 会话注入面（接收管线实链路） —— */

/* 组一份合法拉取应答帧（bundle）：两帖回填、无后续分段。 */
function bundleFrameOf(collabId, from) {
  const postOf = (postId, postSeq, text) => ({ from: { instanceId: from.instanceId, identityName: from.identityName }, postId, seq: postSeq, ts: new Date(BASE_MS + postSeq * 60000).toISOString(), kind: 'reply', text });
  return {
    v: 1,
    type: 'history-bundle',
    msgId: `bundle-${randomUUID()}`,
    from: { instanceId: from.instanceId, identityName: from.identityName, port: from.port },
    collabId,
    ts: new Date().toISOString(),
    payload: {
      cursor: null,
      summary: { authors: [{ instanceId: from.instanceId, count: 2, seqs: [[1, 2]] }] },
      more: false,
      posts: [postOf('post-1', 1, '回填一'), postOf('post-2', 2, '回填二')],
      overlap: [],
      meta: { state: 'active', name: '讨论甲', topic: '议题' },
      members: [],
      endpoints: {},
    },
  };
}

/* 接收管线级夹具：真 consume（协作服务）+ 假会话注入面（记账）+ 假连接。 */
function makePipedService(t, overrides = {}) {
  const made = makeService(t, overrides);
  const session = [];
  const inbound = createInbound({
    dataDir: made.dir,
    config: { messageTtlMs: 600000 },
    self: made.self,
    dispatch: { resolvePong: () => false, onAck: () => {}, onDeliveryReport: () => {}, send: () => ({ ok: true }) },
    hooks: {
      admit: (frame, meta) => made.service.hooks.admit(frame, meta),
      consume: (frame, meta) => made.service.hooks.consume(frame, meta),
      deliverToSession: (frame) => {
        session.push(frame);
        return true;
      },
    },
    log: quietLog(),
  });
  return { ...made, inbound, session };
}

function fakeConnection(remoteAddress = '127.0.0.1') {
  return { remoteAddress, sent: [], send(frame) { this.sent.push(frame); } };
}

test('注入栅栏（限帖通道）：(作者, postId) 去重命中抑制重复注入——判别副本用不同 msgId', async (t) => {
  const made = makePipedService(t);
  await receive(made.service, inviteFrame({ collabId: 'collab-fence', mode: 'forum' }));
  await made.service.approve({ collabId: 'collab-fence', approve: true });
  const connection = fakeConnection();
  const post = { postId: 'post-1', seq: 1, kind: 'reply', text: '第一帖' };
  const first = collabFrame('post', 'collab-fence', peer(SELF_A.instanceId, SELF_A.identityName, SELF_A.port), { post });
  made.inbound.onFrame(connection, first);
  await waitFor(() => made.session.length === 1);
  /* 不同 msgId 的重复路径副本（同 (作者, postId)）：旧路径会二次注入——栅栏判别点。 */
  made.inbound.onFrame(connection, { ...first, msgId: `${first.msgId}-copy` });
  await waitFor(() => made.service.stats().postsDuplicated === 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(made.session.length, 1, '去重命中的副本不二次注入会话');
  assert.equal(made.inbound.stats().sessionSuppressed, 1);
  assert.equal((await made.service.view({ collabId: 'collab-fence' })).posts.length, 1);
});

test('会话注入分流：拉取两件套帧从不注入（含回填帖）；managed 的「受理帧仍注入」不泛化', async (t) => {
  const made = makePipedService(t);
  /* 管理席位侧讨论实例：B 已加入——拉取请求/应答经真管线到达。 */
  const collabId = made.service.create({ name: '讨论甲', topic: '议题', mode: 'forum', targets: [{ instanceId: SELF_B.instanceId, identityName: SELF_B.identityName, address: '127.0.0.2', port: SELF_B.port }] }).collabId;
  await receive(made.service, joinFrameOf(collabId, peer(SELF_B.instanceId, SELF_B.identityName, SELF_B.port)));
  const connection = fakeConnection();
  made.inbound.onFrame(connection, collabFrame('history-request', collabId, peer(SELF_B.instanceId, SELF_B.identityName, SELF_B.port), { after: null }));
  await waitFor(() => made.service.stats().syncBundlesSent === 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(made.session.length, 0, '拉取请求不注入会话');
  made.inbound.onFrame(connection, bundleFrameOf(collabId, SELF_B));
  await waitFor(() => made.service.stats().syncPostsBackfilled === 2);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(made.session.length, 0, '回填帖（bundle 内容）不进会话注入');
  assert.ok(made.notices.some((frame) => frame.payload.text.includes('已回填 2 帖')), '汇总一行代替逐条注入');
  /* managed 控制面：受理帧仍注入（栅栏不泛化）。 */
  const managedId = made.service.create({ name: '协作甲', topic: '主题', targets: [{ instanceId: SELF_B.instanceId, identityName: SELF_B.identityName, address: '127.0.0.2', port: SELF_B.port }] }).collabId;
  const notice = collabFrame('notice', managedId, peer(SELF_B.instanceId, SELF_B.identityName, SELF_B.port), { event: 'roster', version: 2 });
  const suppressedBefore = made.inbound.stats().sessionSuppressed;
  made.inbound.onFrame(connection, notice);
  await waitFor(() => made.session.length === 1);
  made.inbound.onFrame(connection, { ...notice, msgId: `${notice.msgId}-copy` });
  await waitFor(() => made.session.length === 2, { timeoutMs: 2000 });
  assert.equal(made.inbound.stats().sessionSuppressed, suppressedBefore, 'managed 帧不产生注入抑制（照旧注入）');
});

/* —— 成员侧邀请端到端与跨重启基线 —— */

test('任何成员可邀请端到端：成员侧构造邀请 → 被邀同意 → join → 回填（T1 交接闭合）', async (t) => {
  const { wire, selfB, b, collabId, a } = await makeForumPair(t);
  await injectPosts(a.service, collabId, postsOf(3));
  await awaitSync(b.service.sync({ collabId }));   // B 先追平（回填 3 帖）
  const selfC = { instanceId: 'inst-c', identityName: '主机丙', port: 17323 };
  const madeC = makeService(t, { self: selfC, sendDirect: wire.sendDirectFor(selfC), syncPeerPicker: () => [selfB.instanceId] });
  wire.register(selfC, madeC.service);
  const invited = await b.service.invite({ collabId, targets: [{ instanceId: selfC.instanceId, identityName: selfC.identityName, address: '127.0.0.3', port: selfC.port }] });
  assert.equal(invited.ok, true, invited.message);
  const inviteMessage = sentOf(b.sent, 'invite', collabId)[0];
  assert.equal(inviteMessage.payload.mode, 'forum');
  assert.equal(inviteMessage.payload.topic, '议题');
  assert.deepEqual(inviteMessage.payload.members.map((entry) => entry.instanceId).sort(), ['inst-a', 'inst-b', 'inst-c'], '名单 = 折叠成员表 ∪ 目标');
  await wire.hop(madeC.service, inviteMessage, selfB);
  const joined = await madeC.service.approve({ collabId, approve: true });
  assert.equal(joined.ok, true, joined.message);
  assert.equal(madeC.service.list().collabs[0].state, 'active', '同意即加入（不依赖邀请者）');
  const cJoin = sentOf(madeC.sent, 'join', collabId)[0];
  await wire.hop(b.service, cJoin, selfC);
  await wire.hop(a.service, cJoin, selfC);
  assert.deepEqual(viewMembers(await b.service.view({ collabId })), ['inst-a', 'inst-b', 'inst-c'], 'B 的折叠表含 C');
  assert.deepEqual(viewMembers(await a.service.view({ collabId })), ['inst-a', 'inst-b', 'inst-c'], 'A 的折叠表含 C');
  const outcome = await awaitSync(madeC.service.sync({ collabId }));
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal((await madeC.service.view({ collabId })).posts.length, 3, '新人回填全部历史');
  assert.deepEqual(viewMembers(await madeC.service.view({ collabId })), ['inst-a', 'inst-b', 'inst-c']);
});

test('成员事件时刻的跨重启单调基线：落盘基线恢复，回拨取基线 + 1ms', async (t) => {
  const made = makeService(t);
  const collabId = made.service.create({ name: '讨论甲', topic: '议题', mode: 'forum', targets: [{ instanceId: SELF_B.instanceId, identityName: SELF_B.identityName, address: '127.0.0.2', port: SELF_B.port }] }).collabId;
  const futureMs = Date.now() + DAY;
  const eventFuture = new Date(futureMs).toISOString();
  const postFuture = new Date(futureMs + 5000).toISOString();
  /* 夹具：落盘带未来时刻的自机事件与自机帖（时钟回拨后的等价形态），重载后新事件必须严格越过两者。 */
  appendFileSync(collabFilePath(made.dir, collabId, MEMBERS_FILE_NAME), `${JSON.stringify({ eventId: 'evt-future', kind: 'join', instanceId: 'inst-self', identityName: '本机', ts: eventFuture })}\n`);
  appendFileSync(collabFilePath(made.dir, collabId, POSTS_FILE_NAME), `${JSON.stringify({ entryId: 'post-fixture', seq: 5, ts: postFuture, from: { instanceId: 'inst-self', identityName: '本机' }, kind: 'reply', text: '未来基线的帖（夹具）' })}\n`);
  const reloaded = createCollabService({
    dataDir: made.dir,
    config: made.config,
    self: made.self,
    send: () => ({ ok: true, msgId: 'q' }),
    sendDirect: () => ({ ok: true, msgId: 'd' }),
    notify: () => {},
    knownHosts: { remember: () => {} },
    log: quietLog(),
    ledgerFetchTimeoutMs: 30,
    inviteMinIntervalMs: 0,
    syncPeerPicker: () => [],
  });
  const left = await reloaded.leave({ collabId });
  assert.equal(left.ok, true, left.message);
  assert.equal(reloaded.list().collabs[0].state, 'left', '退出即归档（状态面）');
  const endAfterLeave = await reloaded.end({ collabId });
  assert.equal(endAfterLeave.ok, false, '发起人退出即放弃结束权（end 被拒）');
  assert.ok(endAfterLeave.message.includes('结束权'), endAfterLeave.message);
  const events = readFileSync(collabFilePath(made.dir, collabId, MEMBERS_FILE_NAME), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const leaveEvent = events.find((event) => event.kind === 'leave');
  assert.ok(leaveEvent !== undefined, 'leave 事件落盘');
  assert.equal(Date.parse(leaveEvent.ts), Date.parse(postFuture) + 1, '取 max(帖子基线 + 1ms, 事件基线 + 1ms, now)');
});
