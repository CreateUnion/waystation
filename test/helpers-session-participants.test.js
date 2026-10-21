import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { repoRoot } from './helpers.js';
import {
  makeFakeClock,
  makeLedger,
  makeRoster,
  makeSeat,
  makeTempRoot,
  oldPackagePath,
} from './helpers/session-participants.js';

/* node:test 上下文的最小替身：只用到 after 注册钩子；runCleanup 手动触发，便于在同一用例内断言清理效果。 */
function fakeTestContext() {
  const hooks = [];
  return {
    after: (fn) => hooks.push(fn),
    runCleanup: () => {
      for (const fn of hooks.splice(0)) {
        fn();
      }
    },
  };
}

test('makeTempRoot：临时数据根落在系统临时目录，注册后清理', () => {
  const t = fakeTestContext();
  const root = makeTempRoot(t);
  assert.equal(existsSync(root), true);
  assert.equal(statSync(root).isDirectory(), true);
  assert.equal(resolve(root).startsWith(resolve(tmpdir())), true);
  assert.match(root, /waystation-participants-/);
  t.runCleanup();
  assert.equal(existsSync(root), false);
});

test('makeFakeClock：advance 同时推进墙钟与单调钟', () => {
  const clock = makeFakeClock(1000);
  assert.equal(clock.now(), 1000);
  assert.equal(clock.monotonic(), 1000);
  assert.equal(clock.advance(59000), 60000);
  assert.equal(clock.monotonic(), 60000);
  assert.equal(clock.iso(), '1970-01-01T00:01:00.000Z');
});

test('makeFakeClock：墙钟可回拨/前跳，单调钟不倒流', () => {
  const clock = makeFakeClock(60000);
  clock.advance(1000);
  clock.setWall(500);
  assert.equal(clock.now(), 500);
  assert.equal(clock.monotonic(), 61000);
  clock.setWall(120000);
  clock.advance(1000);
  assert.equal(clock.now(), 121000);
  assert.equal(clock.monotonic(), 62000);
});

test('makeFakeClock：非法输入抛 TypeError/RangeError', () => {
  assert.throws(() => makeFakeClock(Number.NaN), TypeError);
  const clock = makeFakeClock();
  assert.throws(() => clock.advance(0), RangeError);
  assert.throws(() => clock.advance(-1), RangeError);
  assert.throws(() => clock.advance(Number.POSITIVE_INFINITY), TypeError);
  assert.throws(() => clock.setWall('later'), TypeError);
});

test('makeSeat：缺省生成共享名单条目形态', () => {
  assert.deepEqual(makeSeat({ instanceId: 'inst-a', sessionId: 'sess-a' }), {
    instanceId: 'inst-a',
    sessionId: 'sess-a',
    identityName: 'inst-a',
    role: 'member',
    state: 'member',
    joinSeq: 1,
    joinedAt: '2026-10-21T00:00:00.000Z',
  });
});

test('makeSeat：站长席位、显式序号与毫秒时间归一为 ISO', () => {
  const seat = makeSeat({
    instanceId: 'inst-b',
    sessionId: 'sess-b',
    identityName: '小明',
    role: 'manager',
    joinSeq: 7,
    joinedAt: Date.parse('2026-10-21T01:02:03.000Z'),
  });
  assert.equal(seat.role, 'manager');
  assert.equal(seat.identityName, '小明');
  assert.equal(seat.joinSeq, 7);
  assert.equal(seat.joinedAt, '2026-10-21T01:02:03.000Z');
});

test('makeSeat：非法标识/角色/状态/序号/时间一律拒绝', () => {
  assert.throws(() => makeSeat({ sessionId: 'sess-a' }), /instanceId/);
  assert.throws(() => makeSeat({ instanceId: 'inst/a', sessionId: 'sess-a' }), /instanceId/);
  assert.throws(() => makeSeat({ instanceId: 'inst-a', sessionId: '' }), /sessionId/);
  assert.throws(() => makeSeat({ instanceId: 'inst-a', sessionId: 'sess-a', role: 'owner' }), /role/);
  assert.throws(() => makeSeat({ instanceId: 'inst-a', sessionId: 'sess-a', state: 'joining' }), /member/);
  assert.throws(() => makeSeat({ instanceId: 'inst-a', sessionId: 'sess-a', joinSeq: 0 }), /joinSeq/);
  assert.throws(() => makeSeat({ instanceId: 'inst-a', sessionId: 'sess-a', joinedAt: 'not-a-date' }), /joinedAt/);
});

test('makeRoster：按名单顺序分配 joinSeq，加入时刻递增', () => {
  const roster = makeRoster([
    { instanceId: 'inst-a', sessionId: 'sess-a', role: 'manager' },
    { instanceId: 'inst-b', sessionId: 'sess-b' },
  ]);
  assert.deepEqual(roster.map((seat) => seat.joinSeq), [1, 2]);
  assert.deepEqual(roster.map((seat) => seat.role), ['manager', 'member']);
  assert.equal(roster[1].joinedAt > roster[0].joinedAt, true);
  assert.deepEqual(makeRoster([]), []);
});

test('makeRoster：显式 joinSeq 保留，重复席位键拒绝', () => {
  const roster = makeRoster([{ instanceId: 'inst-a', sessionId: 'sess-a', joinSeq: 9 }]);
  assert.equal(roster[0].joinSeq, 9);
  assert.throws(() => makeRoster([
    { instanceId: 'inst-a', sessionId: 'sess-a' },
    { instanceId: 'inst-a', sessionId: 'sess-a' },
  ]), /重复席位键/);
});

test('makeLedger：缺省 active 台账，站长从名单派生', () => {
  const ledger = makeLedger();
  assert.equal(ledger.status, 'active');
  assert.equal(ledger.managerTerm, 1);
  assert.equal(ledger.version, 1);
  assert.equal(ledger.joinSeqNext, 2);
  assert.equal(ledger.members.length, 1);
  assert.equal(ledger.members[0].role, 'manager');
  assert.deepEqual(ledger.manager, {
    instanceId: ledger.members[0].instanceId,
    sessionId: ledger.members[0].sessionId,
    identityName: ledger.members[0].identityName,
    term: 1,
  });
  assert.equal('managerWindow' in ledger, false);
});

test('makeLedger：自定义名单/站长任期/窗口按新形态落字段', () => {
  const members = makeRoster([
    { instanceId: 'inst-a', sessionId: 'sess-a', role: 'manager' },
    { instanceId: 'inst-a', sessionId: 'sess-a2' },
  ]);
  const window = { windowBaseTerm: 2, windowEndsAt: '2026-10-21T00:01:00.000Z' };
  const ledger = makeLedger({
    collabId: 'collab-x',
    name: '协作一',
    managerTerm: 2,
    version: 12,
    members,
    managerWindow: window,
  });
  assert.equal(ledger.collabId, 'collab-x');
  assert.equal(ledger.name, '协作一');
  assert.equal(ledger.managerTerm, 2);
  assert.equal(ledger.version, 12);
  assert.equal(ledger.joinSeqNext, 3);
  assert.equal(ledger.manager.term, 2);
  assert.deepEqual(ledger.managerWindow, window);
});

test('makeLedger：显式 manager 须与名单席位一致', () => {
  const members = makeRoster([{ instanceId: 'inst-a', sessionId: 'sess-a', role: 'manager' }]);
  const ledger = makeLedger({ members, manager: { instanceId: 'inst-a', sessionId: 'sess-a' } });
  assert.equal(ledger.manager.identityName, 'inst-a');
  assert.equal(ledger.manager.term, 1);
  assert.throws(
    () => makeLedger({ members, manager: { instanceId: 'inst-z', sessionId: 'sess-z' } }),
    /名单/,
  );
});

test('makeLedger：终态缺省空名单与 manager:null，且拒绝窗口字段', () => {
  const ledger = makeLedger({ status: 'completed' });
  assert.deepEqual(ledger.members, []);
  assert.equal(ledger.manager, null);
  assert.equal(ledger.managerTerm, 1);
  assert.equal(ledger.joinSeqNext, 2);
  assert.throws(
    () => makeLedger({ status: 'terminated', managerWindow: { windowBaseTerm: 1, windowEndsAt: 'x' } }),
    /managerWindow/,
  );
});

test('makeLedger：非终态空名单、非法状态与非法版本拒绝', () => {
  assert.throws(() => makeLedger({ members: [] }), /站长/);
  assert.throws(() => makeLedger({ members: null }), /数组/);
  assert.throws(() => makeLedger({ status: 'done' }), /status/);
  assert.throws(() => makeLedger({ version: 0 }), /version/);
  assert.throws(() => makeLedger({ collabId: 'bad/id' }), /collabId/);
});

test('oldPackagePath：缺省解析到 .superpowers 下的 0.1.5 安装包', () => {
  const expected = resolve(repoRoot, '.superpowers/sdd/update-package/waystation-0.1.5.zip');
  /* 安装包是本机留档文件、不入库：存在则须返回该绝对路径，缺席按约定返回 null。 */
  assert.equal(oldPackagePath({}), existsSync(expected) ? expected : null);
});

test('oldPackagePath：WS_OLD_PACKAGE 相对路径以仓库根为锚', () => {
  assert.equal(oldPackagePath({ WS_OLD_PACKAGE: 'package.json' }), join(repoRoot, 'package.json'));
  assert.equal(oldPackagePath({ WS_OLD_PACKAGE: '  package.json  ' }), join(repoRoot, 'package.json'));
  assert.equal(oldPackagePath({ WS_OLD_PACKAGE: '' }), oldPackagePath({}));
});

test('oldPackagePath：绝对路径命中文件；缺失或非文件返回 null 不抛', (t) => {
  const root = makeTempRoot(t);
  const archive = join(root, 'waystation-old.zip');
  writeFileSync(archive, 'zip');
  assert.equal(oldPackagePath({ WS_OLD_PACKAGE: archive }), archive);
  assert.equal(oldPackagePath({ WS_OLD_PACKAGE: join(root, 'missing.zip') }), null);
  assert.equal(oldPackagePath({ WS_OLD_PACKAGE: root }), null);
});
