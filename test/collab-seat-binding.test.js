import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDir, waitFor } from './helpers.js';
import {
  bringSessionOnline,
  closeSessionNode,
  injectionsOf,
  linkSessionNodes,
  startSessionNode,
  targetOf,
  waitForInjection,
} from './helpers/session-participants.js';

/* 讨论入席后的席位桥绑定（设计 §3.1/§3.2、§4.2）：受邀会话同意并落名单后，其席位必须绑定
 * 当前已注册桥——内容帧直接注入该会话，不得落 staged 等桥重连。判别面走真实接收管线：
 * 建讨论 → 邀请 → 同意 → 发帖 → 目标会话收到注入（不重启桥）。 */

const OWNER_SESSION = 'session-forum-owner';
const GUEST_SESSION = 'session-forum-guest';
const IDLE_SESSION = 'session-forum-idle';
const GHOST = { instanceId: 'inst-ghost', identityName: '幽灵机', address: '127.0.0.1', port: 1 };

async function quietWait(predicate, options) {
  return waitFor(async () => ((await predicate()) ? true : null), { timeoutMs: 15000, ...options });
}

async function startPair(t, guestSessions = [GUEST_SESSION]) {
  const owner = await startSessionNode(t, { identityName: '甲机', online: [OWNER_SESSION] });
  const guest = await startSessionNode(t, { identityName: '乙机', online: guestSessions });
  linkSessionNodes(owner, guest);
  await bringSessionOnline(owner, OWNER_SESSION);
  for (const sessionId of guestSessions) {
    await bringSessionOnline(guest, sessionId);
  }
  return { owner, guest };
}

async function createForum(owner, guest) {
  const created = await owner.service.create({
    name: '席位绑定讨论',
    topic: '绑定议题',
    targets: [GHOST, targetOf(guest)],
    mode: 'forum',
    sessionId: OWNER_SESSION,
  });
  assert.equal(created.ok, true, String(created.message));
  return created.collabId;
}

async function waitLocalParticipation(node, collabId) {
  await quietWait(() => node.service.list({}).collabs.some((entry) => entry.collabId === collabId));
}

/* 同意门的一次性豁免：用例只判席位绑定，不重复走用户确认挑战。 */
async function approveForumInvite(guest, collabId, sessionId) {
  await waitLocalParticipation(guest, collabId);
  const waived = await guest.service.allowNextInvite({ sessionId });
  assert.equal(waived.ok, true, String(waived.message));
  const approved = await guest.service.approve({ collabId, approve: true, sessionId });
  assert.equal(approved.ok, true, String(approved.message));
}

async function waitFoldedMember(owner, collabId, instanceId) {
  await quietWait(async () => (await owner.service.view({ collabId })).members.some((member) => member.instanceId === instanceId));
}

/* 帖帧正文在 payload.post.text（内容帧不是通知帧的 payload.text）——按它取注入事实。 */
function postTextsOf(node, sessionId) {
  return injectionsOf(node, sessionId).filter((entry) => entry.type === 'post').map((entry) => entry.payload?.post?.text ?? '');
}

async function postAndWaitInjection(owner, guest, collabId, text, sessionId = GUEST_SESSION) {
  const posted = await owner.service.send({ collabId, text, type: 'issue', sessionId: OWNER_SESSION });
  assert.equal(posted.ok, true, String(posted.message));
  await waitForInjection(guest, sessionId, (list) => list.some((entry) => entry.payload?.post?.text === text), { timeoutMs: 15000 });
  return posted;
}

test('讨论同意入席后席位绑定当前桥：发帖直接注入该会话，不落 staged', { timeout: 60000 }, async (t) => {
  const { owner, guest } = await startPair(t, [GUEST_SESSION, IDLE_SESSION]);
  const collabId = await createForum(owner, guest);
  await approveForumInvite(guest, collabId, GUEST_SESSION);

  const seat = guest.service.seatForRouting(collabId, GUEST_SESSION);
  assert.ok(seat !== null, '同意后本机席位已建立');
  assert.equal(seat.state, 'member');
  assert.equal(seat.bridgeId, `bridge-${GUEST_SESSION}`, '席位必须绑定该会话已注册的桥（否则内容帧只会进暂存）');
  assert.equal(guest.service.seatForRouting(collabId, IDLE_SESSION), null, '未同意会话不得被误绑席位/桥');

  /* 同一机器的未入席会话不得收到讨论内容的注入（坏目标隔离）。 */
  assert.equal(injectionsOf(guest, IDLE_SESSION).filter((entry) => entry.type === 'post').length, 0);

  const unmuted = await guest.service.setMute({ collabId, sessionId: GUEST_SESSION, muted: false });
  assert.equal(unmuted.ok, true, String(unmuted.message));
  await waitFoldedMember(owner, collabId, guest.self.instanceId);

  const posted = await postAndWaitInjection(owner, guest, collabId, '绑定后第一帖');
  assert.ok(postTextsOf(guest, GUEST_SESSION).includes('绑定后第一帖'));
  assert.equal(guest.service.localSeatDeliveryOf(posted.results[0].msgId, GUEST_SESSION).status, 'injected', '投递账记为已注入（不是暂存）');
  assert.equal(guest.service.seatForRouting(collabId, GUEST_SESSION).bridgeId, `bridge-${GUEST_SESSION}`, '注入后绑定不变');
});

test('席位重建/重启路径：重启后按桥注册重新绑定，内容帧照常注入', { timeout: 60000 }, async (t) => {
  const home = makeTempDir(t);
  const owner = await startSessionNode(t, { identityName: '甲机', online: [OWNER_SESSION] });
  const guest = await startSessionNode(t, { home, identityName: '乙机', online: [GUEST_SESSION] });
  linkSessionNodes(owner, guest);
  await bringSessionOnline(owner, OWNER_SESSION);
  await bringSessionOnline(guest, GUEST_SESSION);
  const collabId = await createForum(owner, guest);
  await approveForumInvite(guest, collabId, GUEST_SESSION);
  await guest.service.setMute({ collabId, sessionId: GUEST_SESSION, muted: false });
  await waitFoldedMember(owner, collabId, guest.self.instanceId);
  await postAndWaitInjection(owner, guest, collabId, '重启前的帖子');

  const port = guest.port;
  await closeSessionNode(guest);
  const restarted = await startSessionNode(t, { home, port, identityName: '乙机', online: [GUEST_SESSION] });
  await bringSessionOnline(restarted, GUEST_SESSION);

  const seat = restarted.service.seatForRouting(collabId, GUEST_SESSION);
  assert.ok(seat !== null, '重启后席位由席位文件恢复');
  assert.equal(seat.bridgeId, `bridge-${GUEST_SESSION}`, '桥注册面必须把恢复的席位绑定到当前桥');
  await restarted.service.setMute({ collabId, sessionId: GUEST_SESSION, muted: false });
  await postAndWaitInjection(owner, restarted, collabId, '重启后的帖子');
  assert.ok(postTextsOf(restarted, GUEST_SESSION).includes('重启后的帖子'));
});
