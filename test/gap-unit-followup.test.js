import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { makeTempDir, pickFreePort } from './helpers.js';
import { inferredFrozenFrom } from '../src/collab/local.js';
import { createOutbox } from '../src/net/outbox.js';
import { createChangeoverSeat, createPortDetector } from '../src/core/lifecycle.js';
import { probeStation } from '../src/site.js';

/* 单元级补面：旧数据兜底推断、出站队列读数、端口探测器与站点探测的缺省告警通道、换代席位
 * 的读面（phase/replacer/refusalFrame）。全部进程内构造，不碰真实数据根与站点端口段。 */

function quietLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

test('冻结前状态兜底：管理侧看成员落定、成员侧看同决结果（旧数据缺 frozenFrom 标记）', () => {
  const manager = (members) => inferredFrozenFrom({ role: 'manager', ledger: { members } });
  assert.equal(manager([{ role: 'member', state: 'invited' }]), 'proposed', '全部仍在邀请态 → 未成立');
  assert.equal(manager([{ role: 'member', state: 'member' }]), 'active', '存在落定成员 → 已成立');
  assert.equal(manager([{ role: 'member', state: 'left' }]), 'proposed', '退出者不构成成立证据');
  assert.equal(inferredFrozenFrom({ role: 'member', member: { decision: 'approved' } }), 'active');
  assert.equal(inferredFrozenFrom({ role: 'member', member: { decision: 'withdrawn' } }), 'active');
  assert.equal(inferredFrozenFrom({ role: 'member', member: { decision: null } }), 'proposed', '未回应者视为进行中');
});

test('出站队列读数：unfinished 计未达终态的条目（入队→尝试→确认→会话档）', (t) => {
  const dir = makeTempDir(t);
  const outbox = createOutbox({ dataDir: dir, collabId: 'collab-1', log: quietLog(), config: { retryIntervalMs: 100, retrySlowIntervalMs: 200, retryFastCount: 2, queueMaxPerCollab: 3, messageTtlMs: 60000 } });
  assert.deepEqual(outbox.unfinished(), [], '空队列：读数为空');
  const input = { msgId: randomUUID(), to: { instanceId: 'inst-b', address: '127.0.0.2', port: 17321 }, type: 'notice', payload: { text: '排队消息' }, ts: new Date().toISOString() };
  assert.deepEqual(outbox.enqueue(input), { ok: true });
  assert.equal(outbox.unfinished().length, 1, '入队后条目位列未完成面');
  outbox.markAttempt(input.msgId, Date.now());
  assert.equal(outbox.unfinished().length, 1, '尝试不改变未完成判据');
  outbox.markAcked(input.msgId, Date.now());
  assert.equal(outbox.unfinished().length, 1, '到站（ack）仍属未完成面——第三档会话投递才算达终态');
  outbox.markSessionDelivered(input.msgId, Date.now());
  assert.deepEqual(outbox.unfinished(), [], '会话档投递后出列');
});

test('端口探测器缺省告警：无注入 warn 时按缺省通道报 TCP 证据失败（不误判为命中）', async (t) => {
  const dir = makeTempDir(t);
  const port = await pickFreePort();
  const detector = createPortDetector({ dataDir: dir, port, probeTimeoutMs: 200 });
  try {
    const detection = await detector.detect();
    assert.equal(detection.hit, false, '空闲端口上无同根站点证据');
  } finally {
    detector.close();
  }
});

test('站点探测缺省告警：无注入 warn 时按缺省通道报连接失败（判定为无站点）', async () => {
  const port = await pickFreePort();
  const result = await probeStation({ port, probeTimeoutMs: 200 });
  assert.equal(result.station, false, '空闲端口上无站点应答');
  assert.equal(result.peer, null);
});

test('换代席位读面：phase/replacer/refusalFrame 随首个 replace 受理推进且收尾回调恰一次', () => {
  const admitted = [];
  const seat = createChangeoverSeat({ deadlineMs: 5000, now: () => 1234, onAdmitted: (broadcast, replacer) => admitted.push({ broadcast, replacer }) });
  assert.equal(seat.phase(), 'serving');
  assert.equal(seat.replacer(), null);
  assert.equal(seat.refusalFrame(), null, '服务期无换代回执');
  const outcome = seat.onReplace({ bridgeId: 'bridge-1', reason: 'version-mismatch', wantApp: '0.2.0' });
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(seat.phase(), 'shutting-down');
  assert.equal(seat.replacer().bridgeId, 'bridge-1');
  assert.equal(seat.refusalFrame().code, 'replacing', '收尾期握手回执为 replacing');
  assert.equal(admitted.length, 1, '首个受理触发收尾回调一次');
  const second = seat.onReplace({ bridgeId: 'bridge-2', reason: 'version-mismatch', wantApp: '0.2.0' });
  assert.equal(second.ok, false, '并发第二个 replace 不再受理');
  assert.equal(admitted.length, 1, '其后不重复触发收尾回调');
});
