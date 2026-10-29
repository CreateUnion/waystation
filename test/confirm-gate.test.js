import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDefaults } from '../src/config.js';
import {
  CONFIRM_GATE_SESSION_MAX, clearSessionGate, confirmGateOverCap, consumeConfirmToken, createConfirmGateState,
  gateConfigKey, gateValueOf, isConfirmGate, issueConfirmToken, markConfirmGateClosed, markConfirmGateOpen,
  pruneConfirmGates, queueConfirmGateNotice, setSessionGate, takeConfirmGateNotices,
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
  // 缺 config 时按 true 处理（防御分支：真实调用方总会带 buildDefaults）
  const bare = { confirmGates: createConfirmGateState() };
  assert.deepEqual(gateValueOf(bare, 'sess-a', 'join'), {
    sessionValue: null, configValue: true, effectiveValue: true,
  });
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

test('永久令牌：绑定会话/动作/门/值，单次消费', () => {
  const state = fakeState();
  const token = issueConfirmToken(state, {
    sessionId: 'sess-a', action: 'set', gate: 'invite', value: false, now: 1000,
  });
  const attempt = (overrides = {}) => consumeConfirmToken(state, {
    sessionId: 'sess-a', action: 'set', gate: 'invite', value: false, token, now: 1001, ...overrides,
  });
  // 每次错配都必须在令牌仍在有效期内、且未被消费的前提下命中绑定校验
  assert.equal(attempt({ sessionId: 'sess-b' }), false, '会话不匹配拒绝');
  assert.equal(attempt({ action: 'clear' }), false, '动作不匹配拒绝');
  assert.equal(attempt({ gate: 'join' }), false, '门不匹配拒绝');
  assert.equal(attempt({ value: true }), false, '值不匹配拒绝');
  assert.equal(attempt(), true, '会话/动作/门/值全对才放行');
  assert.equal(attempt(), false, '令牌只能消费一次');
});

test('永久令牌：10 分钟窗口内有效，超时拒绝', () => {
  const state = fakeState();
  const live = issueConfirmToken(state, {
    sessionId: 'sess-a', action: 'clear', gate: 'join', value: undefined, now: 1000,
  });
  assert.equal(consumeConfirmToken(state, {
    sessionId: 'sess-a', action: 'clear', gate: 'join', token: live, now: 1000 + 10 * 60 * 1000 - 1,
  }), true, '窗口内最后一毫秒仍有效');
  const expired = issueConfirmToken(state, {
    sessionId: 'sess-a', action: 'clear', gate: 'join', value: undefined, now: 1000,
  });
  assert.equal(consumeConfirmToken(state, {
    sessionId: 'sess-a', action: 'clear', gate: 'join', token: expired, now: 1000 + 10 * 60 * 1000 + 1,
  }), false, '超过 10 分钟拒绝');
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

test('门名校验与配置键映射', () => {
  assert.equal(isConfirmGate('invite'), true);
  assert.equal(isConfirmGate('join'), true);
  assert.equal(isConfirmGate('other'), false);
  assert.equal(isConfirmGate(undefined), false);
  assert.equal(gateConfigKey('invite'), 'inviteConfirmation');
  assert.equal(gateConfigKey('join'), 'joinRequestConfirmation');
});

test('会话表上限：256 条在线会话不越界，257 条越界', () => {
  assert.equal(CONFIRM_GATE_SESSION_MAX, 256);
  const state = fakeState();
  for (let index = 0; index < CONFIRM_GATE_SESSION_MAX; index += 1) {
    setSessionGate(state, `sess-${index}`, 'invite', true, 0);
  }
  assert.equal(state.confirmGates.sessions.size, CONFIRM_GATE_SESSION_MAX);
  assert.equal(confirmGateOverCap(state), false);
  setSessionGate(state, 'sess-over', 'invite', true, 0);
  assert.equal(state.confirmGates.sessions.size, CONFIRM_GATE_SESSION_MAX + 1, '在线会话不淘汰');
  assert.equal(confirmGateOverCap(state), true);
});

test('clearSessionGate：未覆盖的目标门不清条目，无条目返回 false', () => {
  const state = fakeState();
  assert.equal(clearSessionGate(state, 'sess-missing', 'invite'), false, '无条目返回 false');
  setSessionGate(state, 'sess-a', 'invite', false, 0);
  assert.equal(clearSessionGate(state, 'sess-a', 'join'), true, '条目存在即返回 true');
  assert.equal(state.confirmGates.sessions.has('sess-a'), true, '另一门覆盖仍在，条目不删');
  assert.equal(gateValueOf(state, 'sess-a', 'invite').sessionValue, false);
  assert.equal(gateValueOf(state, 'sess-a', 'join').sessionValue, null);
});

test('永久令牌表：超过 64 条按插入序淘汰最旧', () => {
  const state = fakeState();
  const tokens = [];
  for (let index = 0; index < 65; index += 1) {
    tokens.push(issueConfirmToken(state, {
      sessionId: `sess-${index}`, action: 'set', gate: 'invite', value: true, now: 1000,
    }));
  }
  assert.equal(state.confirmGates.tokens.size, 64, '表上限 64');
  assert.equal(consumeConfirmToken(state, {
    sessionId: 'sess-0', action: 'set', gate: 'invite', value: true, token: tokens[0], now: 1001,
  }), false, '最旧令牌被淘汰');
  assert.equal(consumeConfirmToken(state, {
    sessionId: 'sess-64', action: 'set', gate: 'invite', value: true, token: tokens[64], now: 1001,
  }), true, '最新令牌可用');
});

test('永久令牌：非字符串 / 空令牌拒绝', () => {
  const state = fakeState();
  for (const token of [undefined, null, 42, '']) {
    assert.equal(consumeConfirmToken(state, {
      sessionId: 'sess-a', action: 'set', gate: 'invite', value: true, token, now: 0,
    }), false, String(token));
  }
  assert.equal(state.confirmGates.tokens.size, 0);
});

test('桥断开宽限：按 sessionSeatGraceMs 计时，超时清理后回落 config 默认', () => {
  const state = fakeState({ sessionSeatGraceMs: 5000 });
  setSessionGate(state, 'sess-a', 'invite', false, 0);
  markConfirmGateClosed(state, 'sess-a', 1000);
  assert.equal(pruneConfirmGates(state, 5000), 0);
  assert.equal(pruneConfirmGates(state, 6001), 1);
  assert.equal(gateValueOf(state, 'sess-a', 'invite').effectiveValue, true);
});

test('桥断开/重连：无会话条目时安全无操作；缺 sessionSeatGraceMs 时按 60s 宽限', () => {
  const state = fakeState();
  markConfirmGateClosed(state, 'sess-missing', 100);
  markConfirmGateOpen(state, 'sess-missing');
  assert.equal(state.confirmGates.sessions.size, 0, '无条目时不产生状态');

  const fallback = fakeState({ sessionSeatGraceMs: undefined });
  setSessionGate(fallback, 'sess-a', 'join', true, 0);
  markConfirmGateClosed(fallback, 'sess-a', 1000);
  assert.equal(pruneConfirmGates(fallback, 60999), 0, '默认 60s 宽限内保留');
  assert.equal(pruneConfirmGates(fallback, 61001), 1, '超出默认宽限清理');
});
