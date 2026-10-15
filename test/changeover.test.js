import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  INFLIGHT_MESSAGE,
  NO_PROGRESS_ROUNDS,
  REPLACER_RELEASE_DEADLINE_MS,
  REPLACER_SETTLE_MS,
  VERSION_DOWNGRADE_MESSAGE,
  WAITING_DEADLINE_MS,
  compareAppVersions,
  createChangeoverLedger,
  createReplaceArbiter,
  createReplacerFlight,
  createWaitingForNewCore,
  decideChangeover,
  readTargetAppVersion,
} from '../src/core/changeover.js';
import { makeTempDir } from './helpers.js';

/* 换代协议用例（设计 §5 全协议／§2.6 硬杀防护链消费面）：五行判定（状态转换）、首个 replace 仲裁
 * （并发）、等待新核（状态机＋截止期）、replacer 收尾（超时硬杀路径）、no-progress（终止条件）、
 * 降级闭环（装回旧版不再换代）。全部纯逻辑＋注入时钟/桩件——本模块不碰 IO 与真实进程；
 * 测试一律临时根（makeTempDir），不触碰真实 ~/.waystation、不占站点端口段。 */

function fakeClock(start = 1_700_000_000_000) {
  const state = { ms: start };
  return {
    now: () => state.ms,
    advance(ms) {
      state.ms += ms;
    },
  };
}

function writePackageJson(dir, version) {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'waystation', version }, null, 2) + '\n');
}

/* —— 版本读取与比较（基准＝安装树，设计 §5.1） —— */

test('版本读取：安装树 package.json 为唯一基准', (t) => {
  const home = makeTempDir(t);
  writePackageJson(home, '0.4.2');
  assert.deepEqual(readTargetAppVersion({ appRoot: home }), { ok: true, version: '0.4.2' });

  const missing = join(home, 'not-installed');
  mkdirSync(missing, { recursive: true });
  const absent = readTargetAppVersion({ appRoot: missing });
  assert.equal(absent.ok, false);
  assert.equal(absent.reason, 'unreadable');

  const broken = join(home, 'broken');
  mkdirSync(broken, { recursive: true });
  writeFileSync(join(broken, 'package.json'), '{ not json');
  assert.equal(readTargetAppVersion({ appRoot: broken }).reason, 'broken');

  const malformed = join(home, 'malformed');
  mkdirSync(malformed, { recursive: true });
  writePackageJson(malformed, 'dev');
  assert.equal(readTargetAppVersion({ appRoot: malformed }).reason, 'broken');

  assert.throws(() => readTargetAppVersion({}), TypeError);
  assert.throws(() => readTargetAppVersion(), TypeError);
});

test('版本比较：三段数字逐一比较，发行版高于预发布', () => {
  assert.equal(compareAppVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareAppVersions('0.2.0', '0.1.9'), 1);
  assert.equal(compareAppVersions('0.1.10', '0.1.9'), 1);
  assert.equal(compareAppVersions('1.0.0', '1.0.0-rc.1'), 1);
  assert.equal(compareAppVersions('1.0.0-rc.1', '1.0.0'), -1);
  assert.equal(compareAppVersions('1.0.0-rc.1', '1.0.0-rc.2'), -1);
  assert.equal(compareAppVersions('0.9.9', '1.0.0'), -1);
  assert.throws(() => compareAppVersions('1.0', '1.0.0'), TypeError);
  assert.throws(() => compareAppVersions('1.0.0', '1.0'), TypeError);
});

/* —— 五行判定表（设计 §5.1，写死） —— */

test('判定·行一：ipcV 相同＋目标＝运行 → 直接服务', () => {
  const verdict = decideChangeover({ targetApp: '0.1.0', runningApp: '0.1.0', ipcVBridge: 1, ipcVCore: 1 });
  assert.equal(verdict.action, 'serve');
  assert.equal(verdict.verdict, 'same-version');
});

test('版本比较·已知限制（登记项）：预发布后缀按字典序——rc.9 排在 rc.10 之前', () => {
  // 非完整 semver 标识符比较（设计未要求；登记为真机校准项）——本用例钉住限制，防后续静默当作完整实现
  assert.equal(compareAppVersions('1.0.0-rc.9', '1.0.0-rc.10'), 1);
});

test('判定·行二：ipcV 相同＋目标＞运行 → 桥发起强制换代（不比桥内存版本）', () => {
  // 判据只吃「安装树目标版本 vs 运行核心版本」——桥内存版本不参与（签名即不含该输入）
  const verdict = decideChangeover({ targetApp: '0.2.0', runningApp: '0.1.0', ipcVBridge: 1, ipcVCore: 1 });
  assert.equal(verdict.action, 'replace');
  assert.equal(verdict.verdict, 'target-newer');
});

test('判定·行三：ipcV 相同＋目标＜运行 → 不换代（装回旧版即终止，防换代风暴）', () => {
  const verdict = decideChangeover({ targetApp: '0.1.0', runningApp: '0.2.0', ipcVBridge: 1, ipcVCore: 1 });
  assert.equal(verdict.action, 'serve');
  assert.equal(verdict.verdict, 'target-older');
});

test('判定·行四：ipcV 不同＋核心更高 → 旧桥降级文案（不换代为原则，与版本先后无关）', () => {
  const newer = decideChangeover({ targetApp: '0.2.0', runningApp: '0.2.0', ipcVBridge: 1, ipcVCore: 2 });
  assert.equal(newer.action, 'downgrade');
  assert.equal(newer.verdict, 'bridge-outdated');
  assert.equal(newer.message, VERSION_DOWNGRADE_MESSAGE);

  const alsoOutdated = decideChangeover({ targetApp: '0.3.0', runningApp: '0.2.0', ipcVBridge: 1, ipcVCore: 2 });
  assert.equal(alsoOutdated.action, 'downgrade');
  assert.equal(alsoOutdated.message, VERSION_DOWNGRADE_MESSAGE);
});

test('判定·行五：ipcV 不同＋核心更低 → 桥强制换代（目标＝安装树版本）', () => {
  const verdict = decideChangeover({ targetApp: '0.2.0', runningApp: '0.1.0', ipcVBridge: 2, ipcVCore: 1 });
  assert.equal(verdict.action, 'replace');
  assert.equal(verdict.verdict, 'core-outdated');

  // 目标＝运行也先走一次换代：闭环判定在轮次台账（重 spawn 后仍不兼容才收场）
  const sameVersion = decideChangeover({ targetApp: '0.1.0', runningApp: '0.1.0', ipcVBridge: 2, ipcVCore: 1 });
  assert.equal(sameVersion.action, 'replace');
});

test('判定·拒绝路径：核心 ipcV 取自版本拒绝帧（runningApp 不可得传 null）', () => {
  // 被拒握手没有 welcome——行四/行五只看方向，方向≡拒绝帧 v
  const coreNewer = decideChangeover({ targetApp: '0.2.0', runningApp: null, ipcVBridge: 1, ipcVCore: 2 });
  assert.equal(coreNewer.action, 'downgrade');
  const coreOlder = decideChangeover({ targetApp: '0.2.0', runningApp: null, ipcVBridge: 2, ipcVCore: 1 });
  assert.equal(coreOlder.action, 'replace');
  assert.equal(coreOlder.verdict, 'core-outdated');
});

test('判定：输入形态非法 → TypeError', () => {
  assert.throws(() => decideChangeover({ targetApp: 'x', runningApp: '1.0.0', ipcVBridge: 1, ipcVCore: 1 }), TypeError);
  assert.throws(() => decideChangeover({ targetApp: '1.0.0', runningApp: '1.0.0', ipcVBridge: 0, ipcVCore: 1 }), TypeError);
  assert.throws(() => decideChangeover({ targetApp: '1.0.0' }), TypeError);
});

test('文案：在途调用与旧桥降级（设计钉死的两句原文）', () => {
  assert.equal(INFLIGHT_MESSAGE, '核心换代中（约数秒），请重试；数据未丢');
  assert.equal(VERSION_DOWNGRADE_MESSAGE, '驿站已升级，请重开会话加载新版本');
});

/* —— 核心侧首个 replace 仲裁（设计 §5.2 步 2，并发） —— */

test('首个 replace 仲裁：定 replacer、进 shutting-down、广播帧形态', () => {
  const clock = fakeClock();
  const arbiter = createReplaceArbiter({ now: clock.now });
  assert.equal(arbiter.phase(), 'serving');
  assert.equal(arbiter.refusalFrame(), null);

  const admit = arbiter.onReplace({ bridgeId: 'bridge-a', reason: 'version-mismatch', wantApp: '0.2.0' });
  assert.equal(admit.ok, true);
  assert.deepEqual(admit.broadcast, {
    type: 'core-restarting',
    reason: 'version-mismatch',
    replacerBridgeId: 'bridge-a',
    deadlineMs: REPLACER_RELEASE_DEADLINE_MS,
    targetApp: '0.2.0',
  });
  assert.equal(arbiter.phase(), 'shutting-down');
  assert.equal(arbiter.replacer().bridgeId, 'bridge-a');
  assert.equal(arbiter.replacer().targetApp, '0.2.0');
});

test('首个 replace 仲裁：manual 原因不带 targetApp（CLI 停止通道共用）', () => {
  const arbiter = createReplaceArbiter();
  const admit = arbiter.onReplace({ bridgeId: 'bridge-cli', reason: 'manual' });
  assert.equal(admit.ok, true);
  assert.equal('targetApp' in admit.broadcast, false);
});

test('并发换代：第二个 replace 回 code:replacing 且不夺 replacer 位', () => {
  const arbiter = createReplaceArbiter();
  arbiter.onReplace({ bridgeId: 'bridge-a', reason: 'version-mismatch', wantApp: '0.2.0' });
  const second = arbiter.onReplace({ bridgeId: 'bridge-b', reason: 'version-mismatch', wantApp: '0.2.0' });
  assert.equal(second.ok, false);
  assert.equal(second.frame.type, 'welcome');
  assert.equal(second.frame.ok, false);
  assert.equal(second.frame.code, 'replacing');
  assert.equal(arbiter.replacer().bridgeId, 'bridge-a');
});

test('首个 replace 仲裁：缺发起桥标识 → TypeError', () => {
  const arbiter = createReplaceArbiter();
  assert.throws(() => arbiter.onReplace({ reason: 'version-mismatch', wantApp: '0.2.0' }), TypeError);
  assert.equal(arbiter.phase(), 'serving');
});

test('shutting-down 期握手回执：welcome{ok:false,code:replacing}', () => {
  const arbiter = createReplaceArbiter();
  arbiter.onReplace({ bridgeId: 'bridge-a', reason: 'version-mismatch', wantApp: '0.2.0' });
  const frame = arbiter.refusalFrame();
  assert.equal(frame.ok, false);
  assert.equal(frame.code, 'replacing');
  assert.equal(typeof frame.message, 'string');
});

/* —— 桥侧等待新核状态机（设计 §5.3，写死） —— */

test('等待新核：进入基线＝当前世代；窗口内记录缺失/未变一律等待且禁止冷启', () => {
  const clock = fakeClock();
  const waiting = createWaitingForNewCore({ now: clock.now });
  waiting.enter({ trigger: 'core-restarting', replacerBridgeId: 'bridge-a', targetApp: '0.2.0', generation: 'gen-old' });
  assert.equal(waiting.view().deadlineAt - clock.now(), WAITING_DEADLINE_MS);

  const first = waiting.observe({ startedAt: 'gen-old', pid: 11 });
  assert.equal(first.state, 'waiting');
  assert.equal(first.coldStartAllowed, false);

  clock.advance(5000);
  const missing = waiting.observe(null);
  assert.equal(missing.state, 'waiting');
  assert.equal(missing.coldStartAllowed, false);
});

test('等待新核：被回 replacing 亦可进入（两条进入路径同一状态机）', () => {
  const waiting = createWaitingForNewCore();
  waiting.enter({ trigger: 'replacing-refusal', generation: null });
  assert.equal(waiting.observe(null).state, 'waiting');
});

test('等待新核：世代（startedAt）变化 → 接新核记录，不冷启', () => {
  const waiting = createWaitingForNewCore();
  waiting.enter({ trigger: 'core-restarting', replacerBridgeId: 'bridge-a', generation: 'gen-old' });
  const next = waiting.observe({ startedAt: 'gen-new', pid: 22 });
  assert.equal(next.state, 'new-core');
  assert.equal(next.record.pid, 22);
  assert.equal(next.coldStartAllowed, false);
  assert.equal(waiting.observe({ startedAt: 'gen-newer' }).state, 'new-core');
});

test('等待新核：进入时无记录（基线 null）→ 记录出现即新世代', () => {
  const waiting = createWaitingForNewCore();
  waiting.enter({ trigger: 'replacing-refusal', generation: null });
  assert.equal(waiting.observe({ startedAt: 'gen-x' }).state, 'new-core');
});

test('等待新核：30s 截止 → 失败收场（降级上报文案），解禁后交标准获取路径', () => {
  const clock = fakeClock();
  const waiting = createWaitingForNewCore({ now: clock.now });
  waiting.enter({ trigger: 'core-restarting', replacerBridgeId: 'bridge-a', generation: 'gen-old' });
  clock.advance(WAITING_DEADLINE_MS);
  const timedOut = waiting.observe(null);
  assert.equal(timedOut.state, 'timeout');
  assert.match(timedOut.message, /换代等待超时/);
  assert.equal(timedOut.coldStartAllowed, true);
  // 不周期重试换代：终态保持（再观察不回到等待、不自起重试）
  clock.advance(60_000);
  assert.equal(waiting.observe(null).state, 'timeout');
});

test('等待新核：新核 welcome 即退出等待', () => {
  const waiting = createWaitingForNewCore();
  waiting.enter({ trigger: 'core-restarting', replacerBridgeId: 'bridge-a', generation: 'gen-old' });
  assert.equal(waiting.observe({ startedAt: 'gen-old' }).state, 'waiting');
  const registered = waiting.onWelcome();
  assert.equal(registered.state, 'registered');
  assert.equal(waiting.observe(null).state, 'registered');
});

test('等待新核：进入参数非法/终态复活 → 抛错（终态不复活＝不周期重试的机内保证）', () => {
  const waiting = createWaitingForNewCore();
  assert.throws(() => waiting.enter({ trigger: 'polling' }), TypeError);
  assert.throws(() => waiting.observe(null), Error);
  waiting.enter({ trigger: 'core-restarting', replacerBridgeId: 'b', generation: 'g1' });
  waiting.onWelcome();
  assert.throws(() => waiting.enter({ trigger: 'core-restarting', replacerBridgeId: 'b', generation: 'g2' }), /已进入/);
});

/* —— replacer 收尾序列（设计 §5.2 步 4：≤10s → 硬杀防护链 → 2s → 失败降级） —— */

function makeFlight(clock) {
  return createReplacerFlight({ pid: 4242, endpoint: '\\\\.\\pipe\\waystation-test', now: clock.now });
}

test('replacer 收尾：端点释放/pid 消失即 spawn', () => {
  const clock = fakeClock();
  const flight = makeFlight(clock);
  assert.equal(flight.phase(), 'release-wait');
  const next = flight.observe({ released: true });
  assert.equal(next.step, 'spawn');
  assert.equal(flight.phase(), 'spawn');
});

test('replacer 收尾：10s 未释放 → 走硬杀防护链 → 2s 沉降期确认后 spawn', () => {
  const clock = fakeClock();
  const flight = makeFlight(clock);
  clock.advance(REPLACER_RELEASE_DEADLINE_MS - 1);
  assert.equal(flight.observe({ released: false }).step, 'await-release');
  clock.advance(1);
  const due = flight.observe({ released: false });
  assert.equal(due.step, 'hard-kill');
  assert.equal(due.pid, 4242);

  const settled = flight.onKillResult('killed');
  assert.equal(settled.step, 'settle');
  assert.equal(settled.untilAt - clock.now(), REPLACER_SETTLE_MS);

  clock.advance(REPLACER_SETTLE_MS);
  assert.equal(flight.onSettled({ gone: true }).step, 'spawn');
});

test('replacer 收尾：防护链判 killed 但端点仍在（endpoint-gone 同族）→ 沉降期复核不消失即失败', () => {
  const clock = fakeClock();
  const flight = makeFlight(clock);
  clock.advance(REPLACER_RELEASE_DEADLINE_MS);
  flight.observe({ released: false });
  assert.equal(flight.onKillResult('endpoint-gone').step, 'settle');
  clock.advance(REPLACER_SETTLE_MS);
  const failed = flight.onSettled({ gone: false });
  assert.equal(failed.step, 'failure');
  assert.match(failed.message, /4242/);
  assert.match(failed.message, /waystation-test/);
  assert.match(failed.message, /核心换代失败/);
});

test('replacer 收尾：防护链校验不过（宁可不杀）→ 直接换代失败降级（文案含 pid 与端点）', () => {
  for (const conclusion of ['verification-failed', 'not-eligible', 'already-once']) {
    const clock = fakeClock();
    const flight = makeFlight(clock);
    clock.advance(REPLACER_RELEASE_DEADLINE_MS);
    flight.observe({ released: false });
    const failed = flight.onKillResult(conclusion);
    assert.equal(failed.step, 'failure');
    assert.match(failed.message, new RegExp(conclusion));
    assert.match(failed.message, /4242/);
    assert.match(failed.message, /waystation-test/);
  }
});

test('replacer 收尾：阶段外调用幂等（校验失败响亮、重复观察不改步）', () => {
  const clock = fakeClock();
  assert.throws(() => createReplacerFlight({}), TypeError);
  const flight = makeFlight(clock);
  // 未到期（非 hard-kill 阶段）回填防护链结论、非沉降期复核：原样返回当前步
  assert.equal(flight.onKillResult('killed').step, 'release-wait');
  assert.equal(flight.onSettled({ gone: true }).step, 'release-wait');
  assert.equal(flight.observe({ released: true }).step, 'spawn');
  assert.equal(flight.observe({ released: true }).step, 'spawn');
});

/* —— no-progress 轮次台账（设计 §5.2 步 7：连续两轮未达目标即终止；桥侧计数选型见报告） —— */

test('no-progress：连续两轮目标不变仍未达 → 停止换代＋降级上报', () => {
  const ledger = createChangeoverLedger();
  assert.equal(ledger.admitReplace('0.2.0').ok, true);
  const afterFirst = ledger.noteRoundResult({ targetApp: '0.2.0', runningApp: '0.1.0', ipcVBridge: 1, ipcVCore: 1 });
  assert.equal(afterFirst.status, 'retry');
  assert.equal(ledger.admitReplace('0.2.0').ok, true);

  const afterSecond = ledger.noteRoundResult({ targetApp: '0.2.0', runningApp: '0.1.0', ipcVBridge: 1, ipcVCore: 1 });
  assert.equal(afterSecond.status, 'no-progress');
  assert.match(afterSecond.message, /连续两轮/);

  const refused = ledger.admitReplace('0.2.0');
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'no-progress');
  assert.equal(NO_PROGRESS_ROUNDS, 2);
});

test('no-progress：目标达到即复位（换代成功不消耗下轮预算）', () => {
  const ledger = createChangeoverLedger();
  ledger.admitReplace('0.2.0');
  const reached = ledger.noteRoundResult({ targetApp: '0.2.0', runningApp: '0.2.0', ipcVBridge: 1, ipcVCore: 1 });
  assert.equal(reached.status, 'reached');
  assert.equal(ledger.admitReplace('0.2.0').ok, true);
});

test('台账：判停后目标达到 → 停因一并归零（人工把核心拉回目标版本的序列可再换代）', () => {
  const ledger = createChangeoverLedger();
  ledger.admitReplace('0.2.0');
  ledger.noteRoundResult({ targetApp: '0.2.0', runningApp: '0.1.0', ipcVBridge: 1, ipcVCore: 1 });
  ledger.admitReplace('0.2.0');
  ledger.noteRoundResult({ targetApp: '0.2.0', runningApp: '0.1.0', ipcVBridge: 1, ipcVCore: 1 });
  assert.equal(ledger.admitReplace('0.2.0').ok, false, '连续两轮后判停');
  const reached = ledger.noteRoundResult({ targetApp: '0.2.0', runningApp: '0.2.0', ipcVBridge: 1, ipcVCore: 1 });
  assert.equal(reached.status, 'reached');
  assert.equal(ledger.view().stopped, false, '达到即清停（不粘滞）');
  assert.equal(ledger.admitReplace('0.2.0').ok, true);
});

test('台账：判停后的拒绝文案随停因分流（stalled 不误报「连续两轮」）', () => {
  const ledger = createChangeoverLedger();
  ledger.admitReplace('0.1.0');
  ledger.noteRoundResult({ targetApp: '0.1.0', runningApp: '0.1.0', ipcVBridge: 2, ipcVCore: 1 });
  const refused = ledger.admitReplace('0.1.0');
  assert.equal(refused.ok, false);
  assert.match(refused.message, /ipcV/, 'stalled 停因：文案说协议不兼容，不说轮次耗尽');
  assert.doesNotMatch(refused.message, /连续两轮/);
});

test('no-progress：目标版本变化即复位（新目标新预算）', () => {
  const ledger = createChangeoverLedger();
  ledger.admitReplace('0.2.0');
  ledger.noteRoundResult({ targetApp: '0.2.0', runningApp: '0.1.0', ipcVBridge: 1, ipcVCore: 1 });
  assert.equal(ledger.admitReplace('0.2.1').ok, true);
});

test('降级方向闭环：重 spawn 后「目标＝运行且 ipcV 仍不兼容」→ 降级上报不再换代', () => {
  const ledger = createChangeoverLedger();
  ledger.admitReplace('0.1.0');
  const stalled = ledger.noteRoundResult({ targetApp: '0.1.0', runningApp: '0.1.0', ipcVBridge: 2, ipcVCore: 1 });
  assert.equal(stalled.status, 'stalled');
  assert.match(stalled.message, /ipcV/);
  assert.equal(ledger.admitReplace('0.1.0').ok, false);
});

test('台账：闭环判定只在轮次之后（未换代过则先放行一轮）', () => {
  const ledger = createChangeoverLedger();
  const pending = ledger.noteRoundResult({ targetApp: '0.1.0', runningApp: '0.1.0', ipcVBridge: 2, ipcVCore: 1 });
  assert.equal(pending.status, 'retry');
  assert.equal(ledger.admitReplace('0.1.0').ok, true);
  assert.throws(() => ledger.admitReplace(''), TypeError);
});

/* —— 桩化集成：换代全流程（首个 replace 定 replacer／广播／收尾／重 spawn／其余桥等待新核） —— */

test('桩化集成：换代全流程——第二桥进等待不冷启、replacer 收尾重 spawn、新旧世代交替', () => {
  const clock = fakeClock();
  const arbiter = createReplaceArbiter({ now: clock.now });
  const waitingSecond = createWaitingForNewCore({ now: clock.now });
  const waitingThird = createWaitingForNewCore({ now: clock.now });
  const flow = { coldStarts: 0, spawned: 0 };

  // 桥 A（新桥，目标＞运行）发起换代：核心首个 replace 定 replacer 并广播
  const admit = arbiter.onReplace({ bridgeId: 'bridge-a', reason: 'version-mismatch', wantApp: '0.2.0' });
  assert.equal(admit.ok, true);
  for (const bridge of [waitingSecond, waitingThird]) {
    bridge.enter({ trigger: 'core-restarting', replacerBridgeId: 'bridge-a', targetApp: '0.2.0', generation: 'gen-old' });
  }

  // 并发：桥 B 也发 replace → 回 replacing（不抢发起权）；桥 B 收广播后已在等待态（接线面
  // enterWaiting 幂等：已在等待不重复进入），此处以「被回 replacing 的桥」另起一台验证同路径
  const second = arbiter.onReplace({ bridgeId: 'bridge-b', reason: 'version-mismatch', wantApp: '0.2.0' });
  assert.equal(second.frame.code, 'replacing');
  const waitingByRefusal = createWaitingForNewCore({ now: clock.now });
  waitingByRefusal.enter({ trigger: 'replacing-refusal', replacerBridgeId: null, targetApp: '0.2.0', generation: 'gen-old' });
  assert.equal(waitingByRefusal.observe(null).state, 'waiting');

  // 旧核有序收尾中：记录删除 → 等待态桥一律保持等待、禁止冷启（防与 replacer 争锁）
  for (const bridge of [waitingSecond, waitingThird]) {
    const observed = bridge.observe(null);
    assert.equal(observed.state, 'waiting');
    if (observed.coldStartAllowed) {
      flow.coldStarts++;
    }
  }
  assert.equal(flow.coldStarts, 0);

  // replacer 等旧核释放（未死 → 硬杀防护链 → 沉降确认）后 spawn 安装树入口
  const flight = createReplacerFlight({ pid: 4242, endpoint: 'endpoint-old', now: clock.now });
  clock.advance(REPLACER_RELEASE_DEADLINE_MS);
  assert.equal(flight.observe({ released: false }).step, 'hard-kill');
  assert.equal(flight.onKillResult('killed').step, 'settle');
  clock.advance(REPLACER_SETTLE_MS);
  assert.equal(flight.onSettled({ gone: true }).step, 'spawn');
  flow.spawned++;

  // 新核写新世代：等待态桥接上新世代（不冷启）
  const next = waitingThird.observe({ startedAt: 'gen-new', pid: 33 });
  assert.equal(next.state, 'new-core');
  assert.equal(next.coldStartAllowed, false);
  assert.equal(waitingSecond.observe({ startedAt: 'gen-new', pid: 33 }).state, 'new-core');
  assert.equal(flow.spawned, 1);
  assert.equal(flow.coldStarts, 0);
});
