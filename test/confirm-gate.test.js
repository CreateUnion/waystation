import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDefaults } from '../src/config.js';
import {
  clearSessionGate, consumeConfirmToken, createConfirmGateState, gateValueOf,
  issueConfirmToken, markConfirmGateClosed, markConfirmGateOpen, pruneConfirmGates, queueConfirmGateNotice,
  setSessionGate, takeConfirmGateNotices,
} from '../src/collab/confirm-gate.js';

function fakeState(overrides = {}) {
  return {
    config: { ...buildDefaults('test-host'), ...overrides },
    confirmGates: createConfirmGateState(),
  };
}

test('确认门默认值：两个门都要求人工确认', () => {
  const config = buildDefaults('test-host');
  assert.equal(config.inviteConfirmation, true);
  assert.equal(config.joinRequestConfirmation, true);
});

test('优先级：会话覆盖 > config；clear 后回落 config', () => {
  const state = fakeState({ inviteConfirmation: false });
  assert.deepEqual(gateValueOf(state, 'sess-a', 'invite'), {
    sessionValue: null, configValue: false, effectiveValue: false,
  });
  setSessionGate(state, 'sess-a', 'invite', true, 0);
  assert.deepEqual(gateValueOf(state, 'sess-a', 'invite'), {
    sessionValue: true, configValue: false, effectiveValue: true,
  });
  assert.equal(clearSessionGate(state, 'sess-a', 'invite'), true);
  assert.equal(gateValueOf(state, 'sess-a', 'invite').effectiveValue, false);
});

test('桥断开宽限：宽限内保留，超时清理；重连取消宽限', () => {
  const state = fakeState({ sessionSeatGraceMs: 1000 });
  setSessionGate(state, 'sess-a', 'invite', false, 0);
  markConfirmGateClosed(state, 'sess-a', 100);
  assert.equal(pruneConfirmGates(state, 500), 0);
  assert.equal(gateValueOf(state, 'sess-a', 'invite').sessionValue, false);
  markConfirmGateOpen(state, 'sess-a');
  markConfirmGateClosed(state, 'sess-a', 1000);
  assert.equal(pruneConfirmGates(state, 2001), 1);
  assert.equal(gateValueOf(state, 'sess-a', 'invite').sessionValue, null);
});

test('永久令牌：绑定会话/动作/门/值，单次消费，过期拒绝', () => {
  const state = fakeState();
  const token = issueConfirmToken(state, {
    sessionId: 'sess-a', action: 'set', gate: 'invite', value: false, now: 1000,
  });
  assert.equal(consumeConfirmToken(state, {
    sessionId: 'sess-a', action: 'set', gate: 'invite', value: false, token, now: 1001,
  }), true);
  assert.equal(consumeConfirmToken(state, {
    sessionId: 'sess-a', action: 'set', gate: 'invite', value: false, token, now: 1002,
  }), false, '令牌只能消费一次');
  const expired = issueConfirmToken(state, {
    sessionId: 'sess-a', action: 'clear', gate: 'join', value: undefined, now: 1000,
  });
  assert.equal(consumeConfirmToken(state, {
    sessionId: 'sess-a', action: 'clear', gate: 'join', token: expired, now: 1000 + 10 * 60 * 1000 + 1,
  }), false, '超过 10 分钟拒绝');
  assert.equal(consumeConfirmToken(state, {
    sessionId: 'sess-b', action: 'clear', gate: 'join', token: expired, now: 1001,
  }), false, '会话不匹配拒绝');
});

test('自动批准通知队列：64 条上限，按会话取回，溢出拒绝', () => {
  const state = fakeState();
  for (let index = 0; index < 64; index += 1) {
    assert.equal(queueConfirmGateNotice(state, {
      sessionId: index % 2 === 0 ? 'sess-a' : 'sess-b', collabId: `collab-${index}`, text: `通知 ${index}`,
    }), true);
  }
  assert.equal(queueConfirmGateNotice(state, { sessionId: 'sess-a', collabId: 'collab-x', text: '溢出' }), false);
  const taken = takeConfirmGateNotices(state, 'sess-a');
  assert.equal(taken.length, 32);
  assert.equal(state.confirmGates.notices.length, 32);
  assert.equal(takeConfirmGateNotices(state, 'sess-a').length, 0);
});
