import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { validateMessage } from '../src/net/protocol.js';
import { makeDispatchNode } from './helpers/dispatch.js';

/* dispatch 的隔离面（设计 §10/§11）：不进局域网、不写协作文件。
 * 隔离靠「dispatch 状态独立 Map + 本机 IPC + 显式拒绝」——不用 from.instanceId 做判据（可伪造）。 */

test('协议：mode=dispatch 的邀请帧被拒绝（COLLAB_MODES 不含 dispatch）', () => {
  const frame = {
    v: 1, cap: 2, type: 'invite', msgId: 'msg-1', collabId: 'collab-1',
    from: { instanceId: 'inst-1', identityName: '甲', sessionId: 'sess-1' },
    ts: new Date().toISOString(),
    payload: {
      name: 'dispatch', topic: 'x', mode: 'dispatch',
      members: [{ instanceId: 'inst-1', identityName: '甲', sessionId: 'sess-1' }],
    },
  };
  const checked = validateMessage(frame);
  assert.equal(checked.ok, false);
  assert.match(checked.reason, /mode/);
});

test('LAN 准入：dispatch collabId 的伪造 task/progress/result/error 一律显式拒绝并计数', (t) => {
  const node = makeDispatchNode(t);
  const created = node.service.create({ mode: 'dispatch', name: '隔离', sessionId: 'master-1' });
  assert.equal(created.ok, true, String(created.message));
  const types = ['task', 'progress', 'result', 'error'];
  for (const type of types) {
    const admitted = node.service.hooks.admit({
      v: 1, cap: 2, type, msgId: `msg-${type}`, collabId: created.collabId,
      from: { instanceId: 'inst-evil', identityName: '攻击者', sessionId: 'evil-1' },
      ts: new Date().toISOString(), payload: { text: 'x' },
    }, { remoteAddress: '10.0.0.9' });
    assert.equal(admitted.ok, false, `${type} 不得进入 dispatch`);
    assert.match(admitted.reason, /dispatch/, `${type} 的拒绝须是 dispatch 隔离专条（不是泛化的未知协作）`);
  }
  assert.equal(node.service.stats().dispatchLanRejected, types.length, 'LAN 拒绝逐帧计数留痕');
});

test('零文件：dispatch 创建 / 消息 / 结束不新增 collabs/ 文件', (t) => {
  const node = makeDispatchNode(t);
  const collabsDir = join(node.dataDir, 'collabs');
  const listCollabFiles = () => (existsSync(collabsDir) ? readdirSync(collabsDir, { recursive: true }).sort() : []);
  const before = listCollabFiles();
  const created = node.service.create({ mode: 'dispatch', name: '零文件', sessionId: 'master-1' });
  assert.equal(created.ok, true, String(created.message));
  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1'] });
  node.service.dispatch.send({ collabId: created.collabId, sessionId: 'master-1', text: 'x', toSessionIds: ['worker-1'] });
  node.service.dispatch.end({ collabId: created.collabId, sessionId: 'master-1' });
  const after = listCollabFiles();
  assert.deepEqual(after, before, 'dispatch 生命周期不得在 collabs/ 留下任何文件');
});
