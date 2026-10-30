import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DISPATCH_RULES_FILE_NAME } from '../src/collab/dispatch.js';
import { makeDispatchNode } from './helpers/dispatch.js';

function createDispatch(node) {
  const created = node.service.create({ mode: 'dispatch', name: 'dispatch', sessionId: 'master-1' });
  assert.equal(created.ok, true, String(created.message));
  return created;
}

test('claim 判定表：无头 slave 直接绑定；交互式无角色待确认；非交互式无角色拒绝', (t) => {
  const node = makeDispatchNode(t);
  createDispatch(node);
  const result = node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1', 'human-1', 'headless-1'] });
  assert.equal(result.ok, true);
  const byId = Object.fromEntries(result.results.map((entry) => [entry.sessionId, entry]));
  assert.equal(byId['worker-1'].status, 'bound');
  assert.equal(byId['human-1'].status, 'pending');
  assert.equal(typeof byId['human-1'].claimId, 'string');
  assert.equal(byId['headless-1'].status, 'rejected');
  assert.match(
    byId['headless-1'].reason,
    /claimable: true/,
    '拒收文案应指引 master 认领 scan 中标 claimable: true 的条目',
  );
});

test('claim 门在 pending 期间被关掉：approve:true 免令牌直接绑定，附知情通知', (t) => {
  const node = makeDispatchNode(t);
  createDispatch(node);
  const claimed = node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['human-1'] });
  const claimId = claimed.results[0].claimId;
  // 门开时 claim 已进 pending；随后目标会话把门关掉——approve 按当下生效值免令牌放行
  const gateOff = node.service.setConfirmGate({
    action: 'set', gate: 'claim', requireConfirmation: false, scope: 'session', sessionId: 'human-1',
  });
  assert.equal(gateOff.ok, true, String(gateOff.message ?? ''));
  const approved = node.service.dispatch.approve({ sessionId: 'human-1', claimId, approve: true });
  assert.equal(approved.ok, true, String(approved.message ?? ''));
  assert.equal(approved.needsUserConfirmation, undefined, '门 off 不得再要确认');
  assert.equal(approved.bound, true);
  const autoNotice = node.notices.find(
    (frame) => frame.payload?.targetSessionId === 'human-1' && frame.payload?.event === 'dispatch-claim-auto',
  );
  assert.ok(autoNotice, '应向被收编会话注入知情通知');
  assert.match(autoNotice.payload.text, /master「master」/);
});

test('claim 拒绝：目标 role=master、WAYSTATION_MASTER 不匹配、master 自己', (t) => {
  const node = makeDispatchNode(t, {
    meta: [['other-master', { sessionId: 'other-master', role: 'master', name: 'other', kind: 'interactive', metaUpdatedAt: 0 }]],
  });
  createDispatch(node);
  const result = node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['master-1', 'other-master'] });
  assert.equal(result.results.find((entry) => entry.sessionId === 'master-1').status, 'rejected');
  assert.equal(result.results.find((entry) => entry.sessionId === 'other-master').status, 'rejected');
  node.meta.set('human-1', { ...node.meta.get('human-1'), masterName: 'someone-else' });
  const mismatch = node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['human-1'] });
  assert.equal(mismatch.results[0].status, 'rejected');
});

test('交互式首次 confirm：不带 token 签发，带 token 才绑定；拒绝直接释放', (t) => {
  const node = makeDispatchNode(t);
  createDispatch(node);
  const claimed = node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['human-1'] });
  const claimId = claimed.results[0].claimId;
  const first = node.service.dispatch.approve({ sessionId: 'human-1', claimId, approve: true });
  assert.equal(first.ok, false);
  assert.equal(first.needsUserConfirmation, true);
  assert.equal(typeof first.confirmToken, 'string');
  const wrongSession = node.service.dispatch.approve({
    sessionId: 'human-2', claimId, approve: true, confirmToken: first.confirmToken,
  });
  assert.equal(wrongSession.ok, false);
  const bound = node.service.dispatch.approve({
    sessionId: 'human-1', claimId, approve: true, confirmToken: first.confirmToken,
  });
  assert.equal(bound.ok, true);
  assert.equal(bound.bound, true);
  assert.equal(node.service.dispatch.status().dispatch.slaves.some((slave) => slave.sessionId === 'human-1'), true);
  const reused = node.service.dispatch.approve({
    sessionId: 'human-1', claimId, approve: true, confirmToken: first.confirmToken,
  });
  assert.equal(reused.ok, false, '一次性令牌：绑定后同一 claimId 不可重放');

  const secondClaim = node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['human-1'] });
  assert.equal(secondClaim.results[0].status, 'bound', '已收编幂等');
  const other = node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['headless-1'] });
  assert.equal(other.results[0].status, 'rejected');
});

test('交互式第一次 approve:false 直接拒绝；claim TTL 到期释放', (t) => {
  const node = makeDispatchNode(t);
  createDispatch(node);
  const claimed = node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['human-1'] });
  const claimId = claimed.results[0].claimId;
  const rejected = node.service.dispatch.approve({ sessionId: 'human-1', claimId, approve: false });
  assert.equal(rejected.ok, true);
  assert.equal(node.service.dispatch.approve({ sessionId: 'human-1', claimId, approve: true }).ok, false, '已释放');

  const again = node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['human-1'] });
  node.advance(10 * 60 * 1000 + 1);
  node.service.dispatch.sweep(node.now());
  assert.equal(node.notices.some((frame) => frame.payload?.event === 'dispatch-claim-expired'), true, 'TTL 清扫须回收申请并留通知');
  const expired = node.service.dispatch.approve({ sessionId: 'human-1', claimId: again.results[0].claimId, approve: true });
  assert.equal(expired.ok, false);
});

test('release：master 释放；非 master 不能释放', (t) => {
  const node = makeDispatchNode(t);
  createDispatch(node);
  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1'] });
  const denied = node.service.dispatch.release({ sessionId: 'human-1', targetSessionId: 'worker-1' });
  assert.equal(denied.ok, false);
  const released = node.service.dispatch.release({ sessionId: 'master-1', targetSessionId: 'worker-1' });
  assert.equal(released.ok, true);
  assert.equal(node.service.dispatch.status().dispatch.slaves.length, 0);
});

test('元数据：kind 保留 bg / unknown，只有 fresh interactive 才算交互式', (t) => {
  const node = makeDispatchNode(t);
  assert.equal(node.service.dispatch.metaOf('worker-1').kind, 'bg', '无头会话的 bg 不得被吞成 unknown');
  assert.equal(node.service.dispatch.metaOf('master-1').kind, 'interactive');
  node.meta.set('weird-1', { sessionId: 'weird-1', role: 'none', name: 'weird', kind: 'sdk', metaUpdatedAt: node.now() });
  assert.equal(node.service.dispatch.metaOf('weird-1').kind, 'unknown', '未知 kind 回退 unknown');
  assert.equal(node.service.dispatch.isInteractiveOf(node.service.dispatch.metaOf('worker-1')), false);
  assert.equal(node.service.dispatch.isInteractiveOf(node.service.dispatch.metaOf('master-1')), true);
  node.meta.get('master-1').metaUpdatedAt = node.now() - 5 * 60 * 1000 - 1;
  assert.equal(node.service.dispatch.isInteractiveOf(node.service.dispatch.metaOf('master-1')), false, '元数据过期不再算交互式');
});

test('notify 接线：claim 向目标注入确认提示；release 通知双方', (t) => {
  const node = makeDispatchNode(t);
  createDispatch(node);
  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['human-1'] });
  const prompt = node.notices.find((frame) => frame.payload?.event === 'dispatch-claim');
  assert.ok(prompt, 'pending 收编必须向目标注入确认提示，不得静默无动作');
  assert.equal(prompt.type, 'notice');
  assert.equal(prompt.payload.targetSessionId, 'human-1');
  assert.match(prompt.payload.text, /ws_dispatch_approve/);

  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1'] });
  const released = node.service.dispatch.release({ sessionId: 'master-1', targetSessionId: 'worker-1' });
  assert.equal(released.ok, true);
  const targetNotice = node.notices.find((frame) => frame.payload?.event === 'dispatch-released');
  const masterNotice = node.notices.find((frame) => frame.payload?.event === 'dispatch-member-left');
  assert.equal(targetNotice?.payload.targetSessionId, 'worker-1');
  assert.equal(masterNotice?.payload.targetSessionId, 'master-1');
});

test('claim 门 off：master 手动 claim 交互式会话直接绑定（不进 pending、不弹确认）', (t) => {
  const node = makeDispatchNode(t, { config: { dispatchClaimConfirmation: false } });
  createDispatch(node);
  const result = node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['human-1'] });
  assert.equal(result.results[0].status, 'bound', '门 off 手动 claim 直接绑定');
  assert.equal(result.results[0].claimId, undefined, '不产生待确认申请');
  const prompts = node.notices.filter((frame) => frame.payload?.event === 'dispatch-claim');
  assert.equal(prompts.length, 0, '不注入确认提示');
  const autoNotice = node.notices.find((frame) => frame.payload?.event === 'dispatch-claim-auto');
  assert.ok(autoNotice, '注入知情通知');
});

test('收编通知携带纪律包全文（三条路径：门 off 手动绑定 / autoClaim / pending 确认提示）', (t) => {
  const node = makeDispatchNode(t, { config: { dispatchClaimConfirmation: false } });
  writeFileSync(join(node.dataDir, DISPATCH_RULES_FILE_NAME), '纪律甲：主动汇报。\n纪律乙：弹窗先知会。\n', 'utf8');
  createDispatch(node);
  // 路径一：门 off 手动 claim → 直接绑定通知带纪律包全文
  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['human-1'] });
  const boundNotice = node.notices.find(
    (frame) => frame.payload?.event === 'dispatch-claim-auto' && frame.payload?.targetSessionId === 'human-1',
  );
  assert.match(String(boundNotice?.payload?.text ?? ''), /纪律甲：主动汇报/, '门 off 绑定通知应带纪律包全文');
  // 路径二：autoClaim 入编 → 知情通知带纪律包全文
  const autoNode = makeDispatchNode(t, { config: { dispatchClaimConfirmation: false } });
  writeFileSync(join(autoNode.dataDir, DISPATCH_RULES_FILE_NAME), '纪律甲：主动汇报。\n', 'utf8');
  const autoCreated = autoNode.service.create({ mode: 'dispatch', name: 'dispatch', sessionId: 'master-1', autoClaim: true });
  assert.equal(autoCreated.ok, true);
  const autoNotice = autoNode.notices.find(
    (frame) => frame.payload?.event === 'dispatch-claim-auto' && frame.payload?.targetSessionId === 'worker-1',
  );
  assert.match(String(autoNotice?.payload?.text ?? ''), /纪律甲：主动汇报/, 'autoClaim 通知应带纪律包全文');
  // 路径三：门 on 的 pending 确认提示预告纪律
  const promptNode = makeDispatchNode(t);
  writeFileSync(join(promptNode.dataDir, DISPATCH_RULES_FILE_NAME), '纪律乙：弹窗先知会。\n', 'utf8');
  createDispatch(promptNode);
  promptNode.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['human-1'] });
  const prompt = promptNode.notices.find((frame) => frame.payload?.event === 'dispatch-claim');
  assert.match(String(prompt?.payload?.text ?? ''), /批准后适用收编纪律：\n纪律乙/, 'pending 提示应预告纪律');
  assert.equal(autoCreated.collabId !== undefined, true);
});

test('纪律文件热生效：改文件后再收编，新通知携带新文本（无需 reload）', (t) => {
  const node = makeDispatchNode(t, { config: { dispatchClaimConfirmation: false } });
  writeFileSync(join(node.dataDir, DISPATCH_RULES_FILE_NAME), '纪律 v1：主动汇报。\n', 'utf8');
  createDispatch(node);
  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['human-1'] });
  writeFileSync(join(node.dataDir, DISPATCH_RULES_FILE_NAME), '纪律 v2：先知会再弹窗。\n', 'utf8');
  node.service.dispatch.release({ sessionId: 'master-1', targetSessionId: 'human-1' });
  const again = node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['human-1'] });
  assert.equal(again.results[0].status, 'bound');
  const notice = node.notices.filter(
    (frame) => frame.payload?.event === 'dispatch-claim-auto' && frame.payload?.targetSessionId === 'human-1',
  ).pop();
  assert.match(String(notice?.payload?.text ?? ''), /纪律 v2：先知会再弹窗/, '改文件后新收编通知应带新文本');
  assert.equal(String(notice?.payload?.text ?? '').includes('纪律 v1'), false, '旧文本不应再出现');
});

test('纪律文件缺失：回退内置最简纪律并向 master 知会一次（同 record 不重复刷屏）', (t) => {
  const node = makeDispatchNode(t, { config: { dispatchClaimConfirmation: false } });
  createDispatch(node);
  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['human-1'] });
  const boundNotice = node.notices.find(
    (frame) => frame.payload?.event === 'dispatch-claim-auto' && frame.payload?.targetSessionId === 'human-1',
  );
  assert.match(String(boundNotice?.payload?.text ?? ''), /权限类允许\/拒绝弹窗不可远程代批/, '缺失时回退内置最简纪律');
  const warns = () => node.notices.filter(
    (frame) => frame.payload?.event === 'dispatch-rules-missing' && frame.payload?.targetSessionId === 'master-1',
  );
  assert.equal(warns().length, 1, 'master 只被告知一次');
  node.service.dispatch.release({ sessionId: 'master-1', targetSessionId: 'human-1' });
  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['human-1'] });
  assert.equal(warns().length, 1, '同 record 第二次收编不再重复知会');
});

test('ws_dispatch_rules_reload：master 重读文件向全体在编广播最新纪律（带版本号）；非 master 拒绝', (t) => {
  const node = makeDispatchNode(t, { config: { dispatchClaimConfirmation: false } });
  writeFileSync(join(node.dataDir, DISPATCH_RULES_FILE_NAME), '纪律 R1：主动汇报。\n', 'utf8');
  createDispatch(node);
  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['human-1'] });
  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1'] });

  const denied = node.service.dispatch.reloadRules({ sessionId: 'human-1' });
  assert.equal(denied.ok, false, '非 master 不能重载广播');

  const reloaded = node.service.dispatch.reloadRules({ sessionId: 'master-1' });
  assert.equal(reloaded.ok, true);
  assert.equal(reloaded.rulesMissing, false);
  assert.equal(reloaded.notified, 2, '全体在编成员都收到广播');
  assert.match(reloaded.version, /^[0-9a-f]{8}$/);
  const updates = node.notices.filter((frame) => frame.payload?.event === 'dispatch-rules-updated');
  assert.equal(updates.length, 2);
  assert.deepEqual(
    updates.map((frame) => frame.payload?.targetSessionId).sort(),
    ['human-1', 'worker-1'],
    '广播对象应为全体在编成员',
  );
  for (const frame of updates) {
    assert.match(String(frame.payload?.text ?? ''), /【纪律更新 v[0-9a-f]{8} .+】/, '广播带版本号+时间戳');
    assert.match(String(frame.payload?.text ?? ''), /纪律 R1：主动汇报/, '广播携带最新全文');
  }
});

test('reload 文件缺失：按内置最简纪律广播并标注 rulesMissing；版本随内容变化', (t) => {
  const node = makeDispatchNode(t, { config: { dispatchClaimConfirmation: false } });
  createDispatch(node);
  node.service.dispatch.claim({ sessionId: 'master-1', sessionIds: ['worker-1'] });
  const missing = node.service.dispatch.reloadRules({ sessionId: 'master-1' });
  assert.equal(missing.ok, true);
  assert.equal(missing.rulesMissing, true);
  const frame = node.notices.find((entry) => entry.payload?.event === 'dispatch-rules-updated');
  assert.match(String(frame?.payload?.text ?? ''), /权限类允许\/拒绝弹窗不可远程代批/, '缺失时广播内置最简纪律');

  writeFileSync(join(node.dataDir, DISPATCH_RULES_FILE_NAME), '纪律 R2：先知会。\n', 'utf8');
  const first = node.service.dispatch.reloadRules({ sessionId: 'master-1' });
  writeFileSync(join(node.dataDir, DISPATCH_RULES_FILE_NAME), '纪律 R3：热生效。\n', 'utf8');
  const second = node.service.dispatch.reloadRules({ sessionId: 'master-1' });
  assert.notEqual(first.version, second.version, '内容变了版本号必须变');
  assert.equal(first.rulesMissing, false);
});
