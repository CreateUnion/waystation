import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitFor } from './helpers.js';
import { inviteTool } from '../src/tools/collab.js';
import {
  bringSessionOnline,
  linkSessionNodes,
  startSessionNode,
  targetOf,
  waitForInjection,
} from './helpers/session-participants.js';

/* 讨论邀请载荷的席位条目（设计 §2.2/§4.5、D13）：invite.members 每条都必须携
 * instanceId + sessionId + identityName（协议层按席位键校验，缺 sessionId 整帧拒收）。
 * 判别面：forum 建讨论 → ws_invite → 目标机收到合法邀请并可同意成席。 */

const OWNER_SESSION = 'session-payload-owner';
const GUEST_SESSION = 'session-payload-guest';
const GHOST = { instanceId: 'inst-ghost', identityName: '幽灵机', address: '127.0.0.1', port: 1 };

async function quietWait(predicate) {
  return waitFor(async () => ((await predicate()) ? true : null), { timeoutMs: 15000 });
}

async function startPair(t) {
  const owner = await startSessionNode(t, { identityName: '甲机', online: [OWNER_SESSION] });
  const guest = await startSessionNode(t, { identityName: '乙机', online: [GUEST_SESSION] });
  linkSessionNodes(owner, guest);
  await bringSessionOnline(owner, OWNER_SESSION);
  await bringSessionOnline(guest, GUEST_SESSION);
  return { owner, guest };
}

function toolContextOf(node) {
  return { collab: node.service, join: node.service.join, sessionId: OWNER_SESSION, net: {} };
}

async function createDiscussionOf(owner) {
  const created = await owner.service.create({
    name: '载荷讨论',
    topic: '席位条目议题',
    targets: [GHOST],
    mode: 'forum',
    sessionId: OWNER_SESSION,
  });
  assert.equal(created.ok, true, String(created.message));
  return created.collabId;
}

async function invitedFrameOf(owner, guest, collabId) {
  const invited = await inviteTool().handler({
    collabId,
    targets: [targetOf(guest)],
  }, toolContextOf(owner));
  assert.equal(invited.isError, undefined, String(invited.content[0].text));
  const payload = JSON.parse(invited.content[0].text);
  assert.equal(payload.ok, true);
  assert.equal(payload.invited[0].ok, true, String(payload.invited[0].reason));
  await waitForInjection(guest, GUEST_SESSION, (list) => list.some((entry) => entry.type === 'invite'), { timeoutMs: 15000 });
  return guest.deliveries.get(GUEST_SESSION).find((entry) => entry.type === 'invite').frame;
}

function assertSeatEntries(members, owner) {
  assert.ok(Array.isArray(members) && members.length >= 1, '邀请成员表非空');
  for (const member of members) {
    assert.equal(typeof member.instanceId, 'string');
    assert.equal(typeof member.sessionId, 'string', '每个成员条目都必须携席位键 sessionId（缺字段整帧被拒）');
    assert.equal(typeof member.identityName, 'string');
  }
  assert.ok(members.some((member) => member.instanceId === owner.self.instanceId && member.sessionId === OWNER_SESSION), 'members 含发起人席位');
}

async function assertJoinedSeatOf(guest, collabId) {
  const waived = await guest.service.allowNextInvite({ sessionId: GUEST_SESSION });
  assert.equal(waived.ok, true, String(waived.message));
  const approved = await guest.service.approve({ collabId, approve: true, sessionId: GUEST_SESSION });
  assert.equal(approved.ok, true, String(approved.message));
  const seat = guest.service.localSeatOf(collabId, GUEST_SESSION);
  assert.ok(seat !== null, '受邀会话同意后成席');
  assert.equal(seat.state, 'member');
  /* 折叠成员表按席位键输出（本机事件含 sessionId）：后续邀请载荷的同一取数面。 */
  const view = await guest.service.view({ collabId });
  const folded = view.members.find((member) => member.instanceId === guest.self.instanceId);
  assert.ok(folded !== undefined, '本机加入事件已入折叠成员表');
  assert.equal(folded.sessionId, GUEST_SESSION, '折叠成员表保留加入会话的席位键');
}

test('讨论 ws_invite：成员条目按席位键携带 sessionId，邀请帧通过准入并可同意成席', { timeout: 60000 }, async (t) => {
  const { owner, guest } = await startPair(t);
  const collabId = await createDiscussionOf(owner);
  const frame = await invitedFrameOf(owner, guest, collabId);
  assertSeatEntries(frame.payload.members, owner);
  /* 收到即证明接收侧协议校验通过；同意后本机席位落成（不需要邀请者再发任何帧）。 */
  await assertJoinedSeatOf(guest, collabId);
  await quietWait(async () => (await owner.service.view({ collabId })).members.some((member) => member.instanceId === guest.self.instanceId));
});
