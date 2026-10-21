import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDir } from './helpers.js';
import { createCollabService } from '../src/collab/service.js';
import { PARTICIPANTS_CAPABILITY } from '../src/net/protocol.js';
import { PARTICIPANTS_SOURCE_PROBE, createKnownHosts } from '../src/net/known-hosts.js';
import { inviteTool } from '../src/tools/collab.js';

/* ws_invite 的能力预检证据链（设计 §7.2）：已知支持不探测、已知不支持零探测直接拒、
 * 未知才单播探测一次、探测失败按未知 fail-closed 且给出明确原因。判定归服务层（加入域的
 * createInvite 自带同一证据链），工具层只封装逐目标结果——不得对每次邀请无条件探测。 */

const SESSION = 'session-cap-0123456789';
const COL = '127.0.0.1';

function quietLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function peerOf(instanceId, port) {
  return { instanceId, identityName: '对端机', address: COL, port };
}

function buildServiceOf(t) {
  const dir = makeTempDir(t);
  const knownHosts = createKnownHosts({ dataDir: dir, log: quietLog() });
  const calls = [];
  const probeCapability = async (options) => {
    calls.push(options);
    if (options.instanceId === 'inst-quiet') {
      return { ok: false, message: '能力探测失败：超时' };
    }
    return { ok: true, capability: 'supported' };
  };
  const service = createCollabService({
    dataDir: dir,
    config: { inviteTtlMs: 24 * 60 * 60 * 1000 },
    self: { instanceId: 'inst-self', identityName: '本机', port: 17321 },
    send: () => ({ ok: true, msgId: 'q-1' }),
    knownHosts,
    probeCapability,
    log: quietLog(),
    syncPeerPicker: () => [],
  });
  return { service, knownHosts, calls, probeCapability };
}

async function createCollabOf(service, knownHosts) {
  knownHosts.remember({
    address: COL,
    port: 17001,
    instanceId: 'inst-seed',
    identityName: '种子机',
    participants: PARTICIPANTS_CAPABILITY,
    source: 'scan',
  });
  const created = await service.create({
    name: '能力预检协作',
    topic: '证据链',
    targets: [peerOf('inst-seed', 17001)],
    mode: 'managed',
    sessionId: SESSION,
  });
  assert.equal(created.ok, true, String(created.message));
  return created.collabId;
}

function contextOf(built, joinCalls) {
  return {
    collab: built.service,
    join: {
      createInvite: (input) => {
        joinCalls.push(input);
        return built.service.join.createInvite(input);
      },
    },
    net: { probeCapability: built.probeCapability },
    sessionId: SESSION,
  };
}

function invitedOf(result) {
  return JSON.parse(result.content[0].text).invited ?? [];
}

function rememberEvidenceOf(knownHosts) {
  knownHosts.remember({
    address: COL,
    port: 17002,
    instanceId: 'inst-known-ok',
    identityName: '已知支持机',
    participants: PARTICIPANTS_CAPABILITY,
    source: 'scan',
  });
  knownHosts.remember({
    address: COL,
    port: 17003,
    instanceId: 'inst-known-no',
    identityName: '已知不支持机',
    participants: 0,
    source: PARTICIPANTS_SOURCE_PROBE,
  });
  knownHosts.remember({ address: COL, port: 17004, instanceId: 'inst-unknown', identityName: '未知机' });
  knownHosts.remember({ address: COL, port: 17005, instanceId: 'inst-quiet', identityName: '静默机' });
}

async function assertKnownSupported(invite, built) {
  built.calls.length = 0;
  const supported = await invite(peerOf('inst-known-ok', 17002));
  assert.equal(supported.isError, undefined, String(supported.content[0].text));
  assert.equal(invitedOf(supported)[0].ok, true);
  assert.ok(typeof invitedOf(supported)[0].inviteId === 'string', '已知支持直接签发邀请记录');
  assert.equal(built.calls.length, 0, '已知支持不得重复探测');
}

async function assertKnownUnsupported(invite, built, joinCalls) {
  built.calls.length = 0;
  const unsupported = await invite(peerOf('inst-known-no', 17003));
  assert.equal(unsupported.isError, true);
  assert.match(String(unsupported.content[0].text), /不支持/);
  assert.equal(built.calls.length, 0, '已知不支持不得再探测');
  assert.equal(joinCalls.filter((call) => call.targetInstanceId === 'inst-known-no').length, 1, '拒绝原因由服务层证据链给出');
}

async function assertUnknownProbedOnce(invite, built) {
  built.calls.length = 0;
  const unknown = await invite(peerOf('inst-unknown', 17004));
  assert.equal(unknown.isError, undefined, String(unknown.content[0].text));
  assert.equal(built.calls.length, 1, '未知目标只探测一次');
  assert.equal(built.calls[0].instanceId, 'inst-unknown');
  assert.equal(built.calls[0].address, COL);
  assert.equal(built.calls[0].port, 17004);
}

async function assertProbeFailureRejected(invite, built, joinCalls) {
  built.calls.length = 0;
  const quiet = await invite(peerOf('inst-quiet', 17005));
  assert.equal(quiet.isError, true);
  const quietText = String(quiet.content[0].text);
  assert.match(quietText, /无法确认/);
  assert.match(quietText, /请确认对方为 0\.2\.0\+ 且在线/, quietText);
  assert.equal(built.calls.length, 1, '探测失败只探测一次，不重试刷屏');
  assert.equal(joinCalls.filter((call) => call.targetInstanceId === 'inst-quiet').length, 1, '探测失败仍由服务层判定并拒绝');
}

test('能力预检：已知支持零探测、已知不支持零探测、未知探测一次、探测失败拒绝', { timeout: 30000 }, async (t) => {
  const built = buildServiceOf(t);
  const collabId = await createCollabOf(built.service, built.knownHosts);
  assert.equal(built.calls.length, 0, '已知支持的目标不应在创建时探测');
  rememberEvidenceOf(built.knownHosts);

  const joinCalls = [];
  const invite = (target) => inviteTool().handler({ collabId, targets: [target] }, contextOf(built, joinCalls));
  await assertKnownSupported(invite, built);
  await assertKnownUnsupported(invite, built, joinCalls);
  await assertUnknownProbedOnce(invite, built);
  await assertProbeFailureRejected(invite, built, joinCalls);
});

test('能力预检：同一批多目标逐目标判定——已知支持零探测、未知目标单独探测', { timeout: 30000 }, async (t) => {
  const built = buildServiceOf(t);
  const collabId = await createCollabOf(built.service, built.knownHosts);
  built.knownHosts.remember({
    address: COL,
    port: 17012,
    instanceId: 'inst-batch-ok',
    identityName: '批量已知机',
    participants: PARTICIPANTS_CAPABILITY,
    source: 'scan',
  });
  built.knownHosts.remember({ address: COL, port: 17013, instanceId: 'inst-batch-new', identityName: '批量未知机' });
  built.calls.length = 0;

  const result = await inviteTool().handler({
    collabId,
    targets: [peerOf('inst-batch-ok', 17012), peerOf('inst-batch-new', 17013)],
  }, contextOf(built, []));
  assert.equal(result.isError, undefined, String(result.content[0].text));
  assert.deepEqual(invitedOf(result).map((entry) => entry.ok), [true, true]);
  assert.deepEqual(built.calls.map((call) => call.instanceId), ['inst-batch-new'], '只探测未知目标');
});
