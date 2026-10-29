import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCollabService } from '../src/collab/service.js';
import { loadConfig } from '../src/config.js';
import { makeTempDir } from './helpers.js';
import { sessionNodeConfig } from './helpers/session-participants.js';

function quietLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function makeService(t) {
  const dataDir = makeTempDir(t);
  const service = createCollabService({
    dataDir,
    config: sessionNodeConfig({ inviteConfirmation: true, joinRequestConfirmation: true }),
    self: { instanceId: 'inst-self', identityName: '本机', port: 7321 },
    send: () => ({ ok: true, msgId: 'msg-1' }),
    sendDirect: () => ({ ok: true, msgId: 'direct-1' }),
    knownHosts: { remember: () => {}, lookup: () => undefined },
    notify: () => true,
    deliverSeat: () => true,
    log: quietLog(),
    syncPeerPicker: () => [],
  });
  return { service, dataDir };
}

test('status 返回两个门的三元值', (t) => {
  const { service } = makeService(t);
  const result = service.setConfirmGate({ action: 'status', sessionId: 'sess-a' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.gates.invite, { sessionValue: null, configValue: true, effectiveValue: true });
  assert.deepEqual(result.gates.join, { sessionValue: null, configValue: true, effectiveValue: true });
});

test('set session 立即生效；clear 回落；非法参数拒绝', (t) => {
  const { service } = makeService(t);
  const set = service.setConfirmGate({
    action: 'set', gate: 'invite', requireConfirmation: false, scope: 'session', sessionId: 'sess-a',
  });
  assert.equal(set.ok, true);
  assert.equal(set.effectiveValue, false);
  assert.equal(service.setConfirmGate({ action: 'status', gate: 'invite', sessionId: 'sess-a' }).gates.invite.sessionValue, false);
  assert.equal(service.setConfirmGate({ action: 'clear', gate: 'invite', scope: 'session', sessionId: 'sess-a' }).ok, true);
  assert.equal(service.setConfirmGate({ action: 'status', gate: 'invite', sessionId: 'sess-a' }).gates.invite.effectiveValue, true);
  assert.equal(service.setConfirmGate({ action: 'set', gate: 'invite', requireConfirmation: 'no', scope: 'session', sessionId: 'sess-a' }).ok, false);
});

test('persistent：首次只发令牌，携令牌重试才落盘；先写盘后改内存', (t) => {
  const { service, dataDir } = makeService(t);
  const first = service.setConfirmGate({
    action: 'set', gate: 'join', requireConfirmation: false, scope: 'persistent', sessionId: 'sess-a',
  });
  assert.equal(first.ok, false);
  assert.equal(first.needsUserConfirmation, true);
  assert.equal(typeof first.confirmToken, 'string');
  assert.equal(loadConfig(dataDir).config.joinRequestConfirmation, true, '首次不得落盘');
  const second = service.setConfirmGate({
    action: 'set', gate: 'join', requireConfirmation: false, scope: 'persistent',
    sessionId: 'sess-a', confirmToken: first.confirmToken,
  });
  assert.equal(second.ok, true);
  assert.equal(second.effectiveValue, false);
  assert.equal(loadConfig(dataDir).config.joinRequestConfirmation, false);
  assert.match(readFileSync(join(dataDir, 'config.json'), 'utf8'), /"joinRequestConfirmation": false/);
});

test('旧 ws_allow_next_invite 与新开关共用同一份会话状态', (t) => {
  const { service } = makeService(t);
  service.allowNextInvite({ mode: 'session', sessionId: 'sess-a' });
  assert.equal(service.setConfirmGate({ action: 'status', gate: 'invite', sessionId: 'sess-a' }).gates.invite.sessionValue, false);
  service.setConfirmGate({ action: 'set', gate: 'invite', requireConfirmation: true, scope: 'session', sessionId: 'sess-a' });
  assert.equal(service.allowNextInvite({ mode: 'status', sessionId: 'sess-a' }).enabled, false);
});
