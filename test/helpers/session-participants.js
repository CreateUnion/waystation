import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ID_PATTERN, isIdentityName } from '../../src/net/protocol.js';
import { repoRoot } from '../helpers.js';

/* 会话级参与者场景（席位名单 / 台账 / 时钟 / 旧版安装包）的测试夹具：
 * 只产出纯数据与可注入时钟，不 import 协作运行时模块——e2e 与模块测试共用同一组形态，
 * 避免各用例自行拼装 §2.1 名单条目时出现字段漂移。 */

/* 固定基准时刻与名单加入步长：夹具必须可复现——取 Date.now() 会让快照/digest 类断言
 * 每次运行都不同，失败也无法重放。 */
const FIXTURE_EPOCH_MS = Date.parse('2026-10-21T00:00:00.000Z');
const ROSTER_JOIN_STEP_MS = 1000;

const DEFAULT_OLD_PACKAGE = '.superpowers/sdd/update-package/waystation-0.1.5.zip';
const SEAT_ROLES = ['manager', 'member'];
const LEDGER_STATUSES = ['proposed', 'active', 'frozen', 'completed', 'terminated'];
const TERMINAL_STATUSES = ['completed', 'terminated'];

export function makeTempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'waystation-participants-'));
  const cleanup = () => {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      /* Windows 下杀软/索引服务对刚写入的文件有瞬时占用：重试耗尽只留痕，
       * 收尾钩子抛出会让 node:test 跳过其后钩子，危害大于残留的临时目录。 */
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code)) {
        throw error;
      }
      console.error(`[测试收尾] 临时数据根删除失败（环境性占用，已重试）：${root}（${error.code}）`);
    }
  };
  if (typeof t?.after === 'function') {
    t.after(cleanup);
  } else {
    /* 不传测试上下文时退化为进程退出清理（exit 钩子须同步，rmSync 满足）；
     * 数据根始终落在系统临时目录，绝不写真实 ~/.waystation。 */
    process.once('exit', cleanup);
  }
  return root;
}

/* 单调钟与墙钟分离：设计同时要求「单调钟超时」与「墙钟回拨/前跳」两类用例——
 * advance 推进两者，setWall 只动墙钟，单调钟因此永不倒流。 */
export function makeFakeClock(start = 0) {
  assertFiniteMs(start, '时钟起点');
  let wallMs = start;
  let monoMs = start;
  return {
    now: () => wallMs,
    monotonic: () => monoMs,
    advance(ms) {
      assertFiniteMs(ms, 'advance');
      if (ms <= 0) {
        throw new RangeError(`advance 只接受正数毫秒：${ms}`);
      }
      wallMs += ms;
      monoMs += ms;
      return wallMs;
    },
    setWall(ms) {
      assertFiniteMs(ms, 'setWall');
      wallMs = ms;
      return wallMs;
    },
    iso: () => new Date(wallMs).toISOString(),
  };
}

export function makeSeat(spec = {}) {
  const {
    instanceId,
    sessionId,
    identityName = instanceId,
    role = 'member',
    state = 'member',
    joinSeq = 1,
    joinedAt = FIXTURE_EPOCH_MS,
  } = spec;
  assertId(instanceId, 'instanceId');
  assertId(sessionId, 'sessionId');
  if (!isIdentityName(identityName)) {
    throw new TypeError(`identityName 须为合法身份名：${String(identityName)}`);
  }
  if (!SEAT_ROLES.includes(role)) {
    throw new TypeError(`role 只允许 manager/member：${String(role)}`);
  }
  if (state !== 'member') {
    throw new TypeError(`共享名单条目恒为 member；joining 属本地席位文件，不在本夹具形态内：${String(state)}`);
  }
  assertPositiveInt(joinSeq, 'joinSeq');
  return { instanceId, sessionId, identityName, role, state, joinSeq, joinedAt: toIsoTimestamp(joinedAt) };
}

export function makeRoster(seats = []) {
  if (!Array.isArray(seats)) {
    throw new TypeError('makeRoster 需要席位规格数组');
  }
  const seen = new Set();
  return seats.map((spec, index) => {
    const seat = makeSeat({
      joinSeq: index + 1,
      joinedAt: FIXTURE_EPOCH_MS + index * ROSTER_JOIN_STEP_MS,
      ...spec,
    });
    const key = `${seat.instanceId}\u0000${seat.sessionId}`;
    if (seen.has(key)) {
      throw new TypeError(`名单不得出现重复席位键：${seat.instanceId}/${seat.sessionId}`);
    }
    seen.add(key);
    return seat;
  });
}

export function makeLedger(spec = {}) {
  const fields = parseLedgerSpec(spec);
  const roster = fields.members === undefined ? defaultRoster(fields.terminal) : makeRoster(fields.members);
  const ledger = {
    collabId: fields.collabId,
    name: fields.name,
    topic: `${fields.name} 主题`,
    mode: 'managed',
    status: fields.status,
    version: fields.version,
    managerTerm: fields.managerTerm,
    joinSeqNext: nextJoinSeq(roster),
    manager: resolveManager(fields.manager, roster, fields.managerTerm, fields.terminal),
    members: roster,
    board: [],
    createdAt: new Date(FIXTURE_EPOCH_MS).toISOString(),
    updatedAt: new Date(FIXTURE_EPOCH_MS).toISOString(),
  };
  if (fields.managerWindow !== undefined) {
    ledger.managerWindow = fields.managerWindow;
  }
  return ledger;
}

function parseLedgerSpec(spec) {
  const {
    collabId = 'collab-fixture',
    name = 'fixture-collab',
    status = 'active',
    managerTerm = 1,
    version = 1,
    manager,
    members,
    managerWindow,
  } = spec;
  assertId(collabId, 'collabId');
  if (!isIdentityName(name)) {
    throw new TypeError(`协作名须为合法身份名：${String(name)}`);
  }
  if (!LEDGER_STATUSES.includes(status)) {
    throw new TypeError(`status 非法：${String(status)}`);
  }
  assertPositiveInt(managerTerm, 'managerTerm');
  assertPositiveInt(version, 'version');
  const terminal = TERMINAL_STATUSES.includes(status);
  if (terminal && managerWindow !== undefined) {
    throw new TypeError('终态台账不携 managerWindow（运行时须清除窗口基准）');
  }
  return { collabId, name, status, managerTerm, version, manager, members, managerWindow, terminal };
}

/* 旧版安装包定位：相对路径以仓库根为锚（不随启动目录漂移）；文件缺失返回 null 而非抛出，
 * 让依赖旧包的对端兼容用例可按环境跳过而不是整轮失败。 */
export function oldPackagePath(env = process.env) {
  const configured = typeof env?.WS_OLD_PACKAGE === 'string' ? env.WS_OLD_PACKAGE.trim() : '';
  const candidate = resolve(repoRoot, configured === '' ? DEFAULT_OLD_PACKAGE : configured);
  if (!existsSync(candidate)) {
    return null;
  }
  try {
    return statSync(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

function defaultRoster(terminal) {
  if (terminal) {
    return [];
  }
  return makeRoster([{ instanceId: 'instance-fixture-a', sessionId: 'session-fixture-a', role: 'manager' }]);
}

function resolveManager(explicitManager, roster, managerTerm, terminal) {
  if (explicitManager === null) {
    if (!terminal) {
      throw new TypeError('非终态台账必须有站长；manager:null 仅终态允许');
    }
    return null;
  }
  if (explicitManager === undefined) {
    return managerFromRoster(roster, managerTerm, terminal);
  }
  return normalizeManager(explicitManager, roster, managerTerm);
}

function managerFromRoster(roster, managerTerm, terminal) {
  const managers = roster.filter((seat) => seat.role === 'manager');
  if (managers.length === 1) {
    const seat = managers[0];
    return { instanceId: seat.instanceId, sessionId: seat.sessionId, identityName: seat.identityName, term: managerTerm };
  }
  if (managers.length === 0 && terminal) {
    return null;
  }
  throw new TypeError(managers.length === 0
    ? '非终态台账名单必须含一位 role=manager 的站长席位'
    : '台账名单不得出现多位站长');
}

function normalizeManager(manager, roster, managerTerm) {
  if (typeof manager !== 'object' || manager === null || Array.isArray(manager)) {
    throw new TypeError('manager 须为 {instanceId,sessionId,...} 对象');
  }
  assertId(manager.instanceId, 'manager.instanceId');
  assertId(manager.sessionId, 'manager.sessionId');
  const seat = roster.find((item) => item.instanceId === manager.instanceId && item.sessionId === manager.sessionId);
  if (roster.length > 0 && seat === undefined) {
    throw new TypeError('台账 manager 必须与名单中的席位一致');
  }
  const identityName = managerIdentity(manager, seat);
  if (!isIdentityName(identityName)) {
    throw new TypeError(`manager.identityName 非法：${String(identityName)}`);
  }
  if (seat !== undefined && identityName !== seat.identityName) {
    throw new TypeError(`manager.identityName 须与名单席位一致：${String(identityName)}`);
  }
  const term = manager.term === undefined ? managerTerm : manager.term;
  assertPositiveInt(term, 'manager.term');
  return { instanceId: manager.instanceId, sessionId: manager.sessionId, identityName, term };
}

function managerIdentity(manager, seat) {
  if (manager.identityName !== undefined) {
    return manager.identityName;
  }
  if (seat === undefined) {
    return manager.instanceId;
  }
  return seat.identityName;
}

function nextJoinSeq(roster) {
  /* 站长初始序号为 1、joinSeqNext 初始 2；空名单（终态）仍从 2 起，与设计初值一致。 */
  let maxSeq = 1;
  for (const seat of roster) {
    if (seat.joinSeq > maxSeq) {
      maxSeq = seat.joinSeq;
    }
  }
  return maxSeq + 1;
}

function assertId(value, label) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new TypeError(`${label} 须匹配 ID_PATTERN（1–64 位字母数字/连字符）：${String(value)}`);
  }
}

function assertPositiveInt(value, label) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${label} 须为正整数：${String(value)}`);
  }
}

function assertFiniteMs(value, label) {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${label} 须为有限毫秒数：${String(value)}`);
  }
}

function toIsoTimestamp(value) {
  const ms = typeof value === 'string' ? Date.parse(value) : value;
  if (!Number.isFinite(ms)) {
    throw new TypeError(`joinedAt 须为可解析时间或毫秒数：${String(value)}`);
  }
  return new Date(ms).toISOString();
}
