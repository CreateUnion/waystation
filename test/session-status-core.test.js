import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCoreSessionStatus } from '../src/session-status.js';
import { sessionFilePath } from '../src/paths.js';
import { makeTempDir, waitFor } from './helpers.js';

/* 核心侧会话状态写面（设计 §4.5）：核心为每个注册桥写/删 sessions/<sessionId>.json；
 * 同 sessionId 顶替 = 最新注册桥为唯一写入者（防「先写后删/先删后写」竞态）；
 * 心跳 5s、陈旧 20s 判据沿用读取端；核心退出删除自己写的全部文件。
 * 文件形态 v1（updatedAt + collabs[]）是读取端契约面——断言按读取端实际消费的字段写。
 * 全部用例经临时根（makeTempDir），绝不触碰真实 ~/.waystation。 */

function quietLog() {
  const entries = [];
  return {
    entries,
    log: {
      info: (message, fields) => entries.push({ level: 'info', message, fields }),
      warn: (message, fields) => entries.push({ level: 'warn', message, fields }),
      error: (message, fields) => entries.push({ level: 'error', message, fields }),
    },
  };
}

/* 核心侧快照（与核心组合根 collect 接线同形：核心身份 + single 站点形态 + 指示条目）。 */
function coreSnapshot(overrides = {}) {
  return {
    instanceId: 'core-inst',
    identityName: '本机',
    site: { mode: 'single', slot: null, port: 17321, takeover: false },
    port: 17321,
    collabs: [{ collabId: 'collab-1', name: '联调项目', state: 'active', role: 'manager', memberCount: 3 }],
    ...overrides,
  };
}

function makeCoreStatus(t, options = {}) {
  const dir = makeTempDir(t);
  const { entries, log } = quietLog();
  const status = createCoreSessionStatus({
    dataDir: dir,
    collect: () => coreSnapshot(),
    log,
    heartbeatMs: 60000,
    now: () => new Date('2026-10-15T00:00:00.000Z'),
    ...options,
  });
  return { dir, entries, status };
}

/* 注册桥记录：核心 IPC 层 onRegister 下发的形态（sessionId 可缺失；connId 区分同一桥标识的先后连接）。 */
function bridgeOf(sessionId, overrides = {}) {
  return { bridgeId: 'bridge-1', sessionId, connId: 1, ...overrides };
}

test('注册即写：为注册桥落一份 v1 形态文件（核心身份字段 + single 站点形态，读取端契约字段齐全）', (t) => {
  const { dir, status } = makeCoreStatus(t);
  const noticed = status.noteRegister(bridgeOf('session-a'));
  assert.deepEqual(noticed, { tracked: true, sessionId: 'session-a', firstSeen: true });
  const payload = JSON.parse(readFileSync(sessionFilePath(dir, 'session-a'), 'utf8'));
  assert.equal(payload.v, 1);
  assert.equal(payload.sessionId, 'session-a');
  assert.equal(payload.instanceId, 'core-inst');
  assert.equal(payload.identityName, '本机');
  assert.deepEqual(payload.site, { mode: 'single', slot: null, port: 17321, takeover: false });
  assert.equal(payload.port, 17321);
  assert.equal(payload.pid, process.pid, 'pid 为核心进程（工具与状态文件同进程写入）');
  assert.equal(payload.updatedAt, '2026-10-15T00:00:00.000Z');
  assert.deepEqual(payload.collabs, coreSnapshot().collabs);
  assert.equal(status.stats().writes, 1);
  status.close();
});

test('多桥：各写各的文件；refresh 一次刷新全部注册桥文件（指示变化不等心跳）', (t) => {
  let collabs = [];
  const { dir, status } = makeCoreStatus(t, { collect: () => coreSnapshot({ collabs }) });
  status.noteRegister(bridgeOf('session-a', { bridgeId: 'bridge-a' }));
  status.noteRegister(bridgeOf('session-b', { bridgeId: 'bridge-b' }));
  assert.equal(existsSync(sessionFilePath(dir, 'session-a')), true);
  assert.equal(existsSync(sessionFilePath(dir, 'session-b')), true);
  assert.deepEqual(JSON.parse(readFileSync(sessionFilePath(dir, 'session-b'), 'utf8')).collabs, []);
  collabs = coreSnapshot().collabs;
  status.refresh();
  for (const sessionId of ['session-a', 'session-b']) {
    assert.deepEqual(JSON.parse(readFileSync(sessionFilePath(dir, sessionId), 'utf8')).collabs, collabs);
  }
  assert.equal(status.stats().writes, 4, '两次注册 + 刷新轮两文件各一次');
  status.close();
});

test('周期心跳：按注入节律刷新全部文件（新协作随快照进入）', async (t) => {
  let round = 0;
  const { dir, status } = makeCoreStatus(t, {
    heartbeatMs: 25,
    now: () => new Date(1700000000000 + round * 1000),
    collect: () => coreSnapshot({ collabs: round === 0 ? [] : coreSnapshot().collabs }),
  });
  status.noteRegister(bridgeOf('session-hb'));
  status.start();
  round = 1;
  await waitFor(() => {
    const payload = JSON.parse(readFileSync(sessionFilePath(dir, 'session-hb'), 'utf8'));
    return payload.collabs.length === 1 && payload.collabs[0].name === '联调项目' ? true : null;
  }, { timeoutMs: 3000, intervalMs: 10 });
  status.close();
});

test('顶替裁决：同 sessionId 两桥 → 最新为唯一写者；旧桥的移除通知不删新写者的文件', (t) => {
  const { dir, status } = makeCoreStatus(t);
  const stale = bridgeOf('session-a', { bridgeId: 'bridge-old', connId: 1 });
  const fresh = bridgeOf('session-a', { bridgeId: 'bridge-new', connId: 2 });
  status.noteRegister(stale);
  assert.deepEqual(status.noteRegister(fresh).firstSeen, false, '同会话重注册不再首见');
  assert.equal(status.stats().sessions, 1, '同会话只占一份记账');
  assert.equal(status.noteRemove(stale), false, '旧写者的移除通知空转');
  assert.equal(existsSync(sessionFilePath(dir, 'session-a')), true, '新写者的文件不得被旧桥的断开删除');
  assert.equal(status.noteRemove(fresh), true);
  assert.equal(existsSync(sessionFilePath(dir, 'session-a')), false, '当前写者断开才删文件');
  status.close();
});

test('重生/顶替接续：先删后写与先写后删都收敛到最新桥为写者（无竞态残留）', (t) => {
  const { dir, status } = makeCoreStatus(t);
  const file = sessionFilePath(dir, 'session-a');
  /* 先删后写：旧桥断开通知先到，再注册新桥 → 文件由新桥重建。 */
  status.noteRegister(bridgeOf('session-a', { bridgeId: 'bridge-1', connId: 1 }));
  status.noteRemove(bridgeOf('session-a', { bridgeId: 'bridge-1', connId: 1 }));
  assert.equal(existsSync(file), false);
  status.noteRegister(bridgeOf('session-a', { bridgeId: 'bridge-1', connId: 2 }));
  assert.equal(existsSync(file), true, '同桥标识的新连接注册后文件重建');
  /* 先写后删：新连接先注册（顶替），旧连接的断开通知随后到达 → 文件保持存在。 */
  status.noteRegister(bridgeOf('session-a', { bridgeId: 'bridge-1', connId: 3 }));
  assert.equal(status.noteRemove(bridgeOf('session-a', { bridgeId: 'bridge-1', connId: 2 })), false);
  assert.equal(existsSync(file), true, '旧连接的断开不得删掉新连接的文件');
  status.close();
});

test('核心退出：删除自己写的全部会话文件（多桥）；close 幂等且其后注册/刷新空转', (t) => {
  const { dir, status } = makeCoreStatus(t);
  status.noteRegister(bridgeOf('session-a', { bridgeId: 'bridge-a' }));
  status.noteRegister(bridgeOf('session-b', { bridgeId: 'bridge-b' }));
  status.close();
  assert.equal(existsSync(sessionFilePath(dir, 'session-a')), false);
  assert.equal(existsSync(sessionFilePath(dir, 'session-b')), false);
  assert.equal(status.stats().active, false);
  status.close();
  const writesAfterClose = status.stats().writes;
  const noticed = status.noteRegister(bridgeOf('session-c'));
  assert.deepEqual(noticed, { tracked: false, sessionId: 'session-c', firstSeen: false }, 'close 为终态：其后注册不再记账');
  status.refresh();
  assert.equal(existsSync(sessionFilePath(dir, 'session-c')), false, 'close 后不复活文件');
  assert.equal(status.stats().writes, writesAfterClose);
});

test('无会话标识或形态不符的桥：跳过 + info 留痕 + 计数，不落任何文件', (t) => {
  const { dir, entries, status } = makeCoreStatus(t);
  for (const [sessionId, label] of [[null, '缺失'], ['bad id!', '非法字符'], ['', '空串']]) {
    const noticed = status.noteRegister(bridgeOf(sessionId));
    assert.deepEqual(noticed, { tracked: false, sessionId: null, firstSeen: false }, label);
  }
  assert.equal(status.stats().skipped, 3);
  assert.equal(status.noteRemove(bridgeOf(null)), false, '无标识的移除通知同样空转');
  assert.equal(entries.filter((entry) => entry.level === 'info' && entry.message.includes('无会话标识')).length, 3);
  assert.deepEqual(readdirSync(dir), [], '不落任何文件');
  status.close();
});

test('健壮性：采集异常与写入失败隔离为计数与告警，绝不抛出（写盘问题不影响主流程）', (t) => {
  const throwOnce = { count: 0 };
  const { entries, status } = makeCoreStatus(t, {
    collect: () => {
      throwOnce.count++;
      throw new Error('采集失败');
    },
  });
  const noticed = status.noteRegister(bridgeOf('session-a'));
  assert.deepEqual(noticed, { tracked: true, sessionId: 'session-a', firstSeen: true });
  assert.equal(status.stats().collectFailures, 1);
  assert.equal(entries.some((entry) => entry.message.includes('会话状态快照收集失败')), true);
  assert.equal(throwOnce.count, 1);
  status.refresh();
  assert.equal(status.stats().collectFailures, 2, '采集异常下刷新整轮跳过（不写任何文件）');
  status.start();
  status.start();
  status.close();

  const dir2 = makeTempDir(t);
  const { entries: entries2, log } = quietLog();
  writeFileSync(join(dir2, 'sessions'), '占位');
  const status2 = createCoreSessionStatus({
    dataDir: dir2,
    collect: () => coreSnapshot(),
    log,
    heartbeatMs: 60000,
    now: () => new Date(),
  });
  status2.noteRegister(bridgeOf('session-b'));
  assert.equal(status2.stats().writeFailures, 1);
  assert.equal(entries2.some((entry) => entry.message.includes('会话状态文件写入失败')), true);
  status2.close();
});

test('firstSeen 记账：首见为真；重连/顶替/重生重注册为假；新会话为真（观察窗触发 B 的每 sessionId 一次闸）', (t) => {
  const { status } = makeCoreStatus(t);
  assert.equal(status.noteRegister(bridgeOf('session-a')).firstSeen, true);
  assert.equal(status.noteRegister(bridgeOf('session-a', { bridgeId: 'bridge-2', connId: 2 })).firstSeen, false, '顶替');
  status.noteRemove(bridgeOf('session-a', { bridgeId: 'bridge-2', connId: 2 }));
  assert.equal(status.noteRegister(bridgeOf('session-a', { bridgeId: 'bridge-3', connId: 3 })).firstSeen, false, '断开后重生重注册');
  assert.equal(status.noteRegister(bridgeOf('session-b')).firstSeen, true, '新会话按规则重判');
  assert.equal(status.noteRegister(bridgeOf(null)).firstSeen, false, '无会话标识的桥不参与记账');
  status.close();
});

test('per-session 绑定过滤：collabsOf 提供者 → 各会话各写自己绑定的协作集；无绑定 → 空数组', (t) => {
  const boundTo = {
    'session-a': [{ collabId: 'collab-a', name: '甲项目', state: 'active', role: 'manager', memberCount: 2 }],
    'session-b': [],
  };
  const queried = [];
  const { dir, status } = makeCoreStatus(t, {
    collabsOf: (sessionId) => {
      queried.push(sessionId);
      return boundTo[sessionId] ?? [];
    },
  });
  status.noteRegister(bridgeOf('session-a', { bridgeId: 'bridge-a' }));
  status.noteRegister(bridgeOf('session-b', { bridgeId: 'bridge-b' }));
  assert.deepEqual(JSON.parse(readFileSync(sessionFilePath(dir, 'session-a'), 'utf8')).collabs, boundTo['session-a']);
  assert.deepEqual(JSON.parse(readFileSync(sessionFilePath(dir, 'session-b'), 'utf8')).collabs, [], '无绑定会话写空数组');
  status.refresh();
  assert.deepEqual(queried, ['session-a', 'session-b', 'session-a', 'session-b'], '注册与刷新都按会话查询绑定');
  assert.deepEqual(JSON.parse(readFileSync(sessionFilePath(dir, 'session-a'), 'utf8')).collabs, boundTo['session-a']);
  status.close();
});

test('绑定提供者异常：跳过本轮该文件写入（保持上一份内容）＋计数告警，心跳重试', (t) => {
  let fail = false;
  const { dir, entries, status } = makeCoreStatus(t, {
    collabsOf: (sessionId) => {
      if (fail) {
        throw new Error('绑定表不可读');
      }
      return [{ collabId: `c-${sessionId}`, state: 'active' }];
    },
  });
  status.noteRegister(bridgeOf('session-a'));
  const before = readFileSync(sessionFilePath(dir, 'session-a'), 'utf8');
  fail = true;
  status.refresh();
  assert.equal(status.stats().collectFailures, 1);
  assert.equal(entries.some((entry) => entry.message.includes('会话绑定快照收集失败')), true);
  assert.equal(readFileSync(sessionFilePath(dir, 'session-a'), 'utf8'), before, '本轮跳过：文件保持上一份内容');
  status.close();
});

test('绑定提供者返回非数组：形态校验拒绝——跳过本轮写入（不留缺字段文件）＋计数告警', (t) => {
  const { dir, entries, status } = makeCoreStatus(t, { collabsOf: () => undefined });
  status.noteRegister(bridgeOf('session-a'));
  assert.equal(existsSync(sessionFilePath(dir, 'session-a')), false, '无效形态不落文件');
  assert.equal(status.stats().collectFailures, 1);
  assert.equal(entries.some((entry) => entry.message.includes('会话绑定快照形态不符')), true);
  status.close();
});

test('站点 fail-safe：site 缺失/null/旧形态 → 一律写 single 形态（防下一核数据面探测误判自锁）', (t) => {
  for (const [site, label] of [[undefined, '缺失'], [null, 'null'], [{ mode: 'slot', slot: 1, port: 17321, takeover: false }, '旧槽位形态']]) {
    const { dir, status } = makeCoreStatus(t, { collect: () => coreSnapshot({ site }) });
    status.noteRegister(bridgeOf('session-a', { bridgeId: `bridge-${label}` }));
    const payload = JSON.parse(readFileSync(sessionFilePath(dir, 'session-a'), 'utf8'));
    assert.deepEqual(payload.site, { mode: 'single', slot: null, port: 17321, takeover: false }, label);
    status.close();
  }
});
