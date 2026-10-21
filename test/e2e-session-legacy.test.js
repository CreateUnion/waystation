import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { collabDir } from '../src/paths.js';
import { readLegacyCollab } from '../src/collab/legacy.js';
import {
  feedSessionFrame,
  seedLegacyCollab,
  startSessionNode,
} from './helpers/session-participants.js';

/* 旧协作只读：启动归档为只读、观察面可读、写门拒绝（工具面与入站帧）、旧文件字节不变。
 * 长操作声明：单节点进程内运行，通常 < 5s；单用例超时上限 30s。 */

const TIMEOUT_MS = 30000;
const COLLAB_ID = 'collab-legacy-e2e';

function seedLegacy(home) {
  seedLegacyCollab(home, COLLAB_ID, { name: '旧版协作', topic: '迁移前主题' });
}

function legacyNoticeFrame() {
  return {
    v: 1,
    cap: 2,
    type: 'notice',
    msgId: randomUUID(),
    collabId: COLLAB_ID,
    from: { instanceId: 'inst-old', identityName: '旧机', port: 24200, sessionId: 'seat-old' },
    ts: new Date().toISOString(),
    payload: { event: 'roster', text: '旧对端消息' },
  };
}

test('旧协作：列表与台账只读可读（观察窗数据源）', { timeout: TIMEOUT_MS }, async (t) => {
  const node = await startSessionNode(t, { seed: seedLegacy, online: ['seat-new'] });
  const entry = node.service.list().collabs.find((collab) => collab.collabId === COLLAB_ID);
  assert.equal(entry?.legacy, true, '旧形态被识别为 legacy');
  assert.equal(entry?.readOnly, true, '只读标记下发展示面');
  assert.equal(entry?.state, 'completed', '旧协作按已完成展示');
  assert.equal(node.service.stats().legacyCollabs, 1);
  const summary = readLegacyCollab(collabDir(node.home, COLLAB_ID));
  assert.equal(summary?.legacy, true, '观察窗只读读取器可读取旧目录');
  assert.equal(summary?.readOnly, true);
  assert.equal(summary?.state, 'completed');
  assert.equal(summary?.name, '旧版协作');
  assert.equal(summary?.memberCount, 1, '旧名单按只读摘要呈现');
});

test('旧协作：写门拒绝（发送 / 邀请 / 结束 / 入站帧），旧文件字节不变', { timeout: TIMEOUT_MS }, async (t) => {
  const node = await startSessionNode(t, { seed: seedLegacy, online: ['seat-new'] });
  const dir = collabDir(node.home, COLLAB_ID);
  const memberBefore = readText(join(dir, 'member.json'));
  const ledgerBefore = readText(join(dir, 'ledger.jsonl'));

  assert.equal(node.service.isWritable(COLLAB_ID), false);
  const sent = await node.service.send({ collabId: COLLAB_ID, text: '写门测试', sessionId: 'seat-new' });
  assert.equal(sent.ok, false, '旧协作拒绝发送');
  assert.match(String(sent.message), /旧版|只读/, String(sent.message));
  assert.equal((await node.service.invite({ collabId: COLLAB_ID, targets: [{ instanceId: 'inst-x', identityName: '丙机', address: '127.0.0.1', port: 24300 }] })).ok, false);
  assert.equal((await node.service.end({ collabId: COLLAB_ID, sessionId: 'seat-new' })).ok, false);

  const acks = await feedSessionFrame(node, legacyNoticeFrame());
  assert.equal(acks.length, 0, '旧协作入站帧不确认');
  assert.equal(node.service.stats().legacyInboundRejected, 1, '入站写门拒绝并计数');
  assert.equal(readText(join(dir, 'member.json')), memberBefore, '旧成员记录不被改写');
  assert.equal(readText(join(dir, 'ledger.jsonl')), ledgerBefore, '旧台账字节不变');
  assert.equal(existsSync(join(dir, 'migration.json')), true, '迁移标记留档');
});

function readText(file) {
  return readFileSync(file, 'utf8');
}
