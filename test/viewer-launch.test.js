import { test } from 'node:test';
import assert from 'node:assert/strict';
import { win32 } from 'node:path';
import {
  buildOpenCommand,
  buildViewerSpawn,
  classifyBusyPort,
  DEFAULT_VIEWER_PORT,
  inProgressCollabsOf,
  locateEdge,
  openWindow,
  PORT_TRIES,
  probeViewer,
  readViewerAutoOpen,
  rootDigest,
  STOP_RELEASE_WAIT_MS,
  stopViewer,
  viewerRootOf,
} from '../src/viewer/launch.js';
import { rootDigest as serverRootDigest } from '../src/viewer/server.js';

/* 启动链纯函数的判别用例：全部副作用注入桩（fetch / spawn / kill / sleep / exists / readFile）——
 * 不碰网络、不碰真实文件系统、不起进程；spawn 真脚本的判别面在 viewer-e2e.test.js，
 * 自动开窗的拉起出口与触发 B 规则（真实临时目录＋spawn 桩）在 viewer-auto-open.test.js。 */

const DIGEST = 'abcd1234';

function healthOf(over = {}) {
  return { app: 'waystation-viewer', v: 1, pid: 4242, root: DIGEST, ...over };
}

/* 脚本化探针：按调用序吐出响应；超出脚本长度的部分沿用最后一个（释放轮询恒活等场景用）。 */
function scriptedProbe(responses) {
  const ports = [];
  const queue = [...responses];
  const last = queue[queue.length - 1];
  return {
    ports,
    probe: async ({ port }) => {
      ports.push(port);
      return queue.length > 0 ? queue.shift() : last;
    },
  };
}

/* 假节拍：立即完成并记录周期——释放轮询的推进不依赖真实时钟。 */
function fakeSleep() {
  const delays = [];
  return {
    delays,
    sleep: async (ms) => {
      delays.push(ms);
    },
  };
}

/* —— probeViewer —— */

test('probeViewer：自家应答返回应答对象，请求指向回环 health 且带超时信号', async () => {
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url, options });
    return { json: async () => healthOf() };
  };
  const health = await probeViewer({ port: 7330, fetchFn });
  assert.deepEqual(health, healthOf());
  assert.equal(calls[0].url, 'http://127.0.0.1:7330/api/health');
  assert.ok(calls[0].options.signal instanceof AbortSignal, '探测必须带中止信号（超时防线）');
});

test('probeViewer：坏 JSON → null', async () => {
  const fetchFn = async () => ({
    json: async () => {
      throw new SyntaxError('不是 JSON');
    },
  });
  assert.equal(await probeViewer({ port: 7330, fetchFn }), null);
});

test('probeViewer：超时（信号中止 fetch）→ null', async () => {
  const fetchFn = (url, options) => new Promise((resolve, reject) => {
    /* AbortSignal.timeout 的计时器是 unref'd 的（到达即中止，但不保活动）——本桩自持一个
     * ref'd 计时器把事件循环撑到中止信号到达，否则测试进程的循环会带着未结算的 Promise 清空。 */
    const keeper = setTimeout(() => {}, 500);
    options.signal.addEventListener('abort', () => {
      clearTimeout(keeper);
      reject(new Error('aborted'));
    });
  });
  assert.equal(await probeViewer({ port: 7330, timeoutMs: 20, fetchFn }), null);
});

test('probeViewer：非自家 app → null', async () => {
  const fetchFn = async () => ({ json: async () => ({ app: 'other-thing', v: 1 }) });
  assert.equal(await probeViewer({ port: 7330, fetchFn }), null);
});

test('probeViewer：连接被拒（fetch 抛错）→ null', async () => {
  const fetchFn = async () => {
    throw new Error('ECONNREFUSED');
  };
  assert.equal(await probeViewer({ port: 7330, fetchFn }), null);
});

/* —— classifyBusyPort —— */

test('classifyBusyPort：自家同根→ours；别根/他形态/探针 null→other', async () => {
  assert.equal(await classifyBusyPort({ port: 7330, digest: DIGEST, probe: async () => healthOf() }), 'ours');
  assert.equal(await classifyBusyPort({ port: 7330, digest: DIGEST, probe: async () => healthOf({ root: 'ffffffff' }) }), 'other');
  assert.equal(await classifyBusyPort({ port: 7330, digest: DIGEST, probe: async () => ({ app: 'nobody', v: 1 }) }), 'other');
  assert.equal(await classifyBusyPort({ port: 7330, digest: DIGEST, probe: async () => null }), 'other');
});

/* —— locateEdge —— */

const PF32 = 'C:\\Program Files (x86)';
const PF = 'C:\\Program Files';
const EDGE_RELATIVE = ['Microsoft', 'Edge', 'Application', 'msedge.exe'];

test('locateEdge：三序位（PF(x86)→PF→PATH）与全缺→null', () => {
  const env = { 'ProgramFiles(x86)': PF32, ProgramFiles: PF, PATH: 'C:\\Windows;C:\\Tools' };
  const fromPF32 = win32.join(PF32, ...EDGE_RELATIVE);
  const fromPF = win32.join(PF, ...EDGE_RELATIVE);
  const fromPath = win32.join('C:\\Tools', 'msedge.exe');

  // 三处都在：取 PF(x86) 序位（顺序即断言）
  assert.equal(locateEdge({ platform: 'win32', env, exists: () => true }), fromPF32);
  // PF(x86) 缺：落到 PF
  assert.equal(locateEdge({ platform: 'win32', env, exists: (path) => path === fromPF }), fromPF);
  // 程序目录都缺：落到 PATH 命中项（空段不产生相对候选）
  assert.equal(locateEdge({ platform: 'win32', env: { ...env, PATH: 'C:\\A;;C:\\Tools' }, exists: (path) => path === fromPath }), fromPath);
  // 全缺：null
  assert.equal(locateEdge({ platform: 'win32', env, exists: () => false }), null);
});

test('locateEdge：POSIX 恒 null（走 open/xdg-open），环境齐全也不查', () => {
  const env = { 'ProgramFiles(x86)': PF32, ProgramFiles: PF, PATH: 'C:\\Tools' };
  assert.equal(locateEdge({ platform: 'linux', env, exists: () => true }), null);
  assert.equal(locateEdge({ platform: 'darwin', env, exists: () => true }), null);
});

/* —— buildOpenCommand —— */

test('buildOpenCommand：win+Edge / win 无 Edge / darwin / linux 四矩阵', () => {
  const url = 'http://127.0.0.1:7330/';
  const edgePath = 'C:\\Edge\\msedge.exe';
  assert.deepEqual(buildOpenCommand({ platform: 'win32', url, edgePath }), {
    cmd: edgePath,
    args: [`--app=${url}`, '--window-size=1280,900'],
  });
  assert.deepEqual(buildOpenCommand({ platform: 'win32', url, edgePath: null }), {
    cmd: 'cmd',
    args: ['/c', 'start', '', url],
  });
  assert.deepEqual(buildOpenCommand({ platform: 'darwin', url, edgePath: null }), { cmd: 'open', args: [url] });
  assert.deepEqual(buildOpenCommand({ platform: 'linux', url, edgePath: null }), { cmd: 'xdg-open', args: [url] });
});

/* —— openWindow —— */

test('openWindow：spawn 收到 detached/stdio ignore、unref 被调用；同步异常→false', () => {
  const calls = [];
  const handlers = new Map();
  let unrefed = false;
  const spawnFn = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    return {
      on: (event, handler) => {
        handlers.set(event, handler);
      },
      unref: () => {
        unrefed = true;
      },
    };
  };
  const plan = { cmd: 'cmd', args: ['/c', 'start', '', 'http://127.0.0.1:7330/'] };
  assert.equal(openWindow({ plan, spawnFn }), true);
  assert.deepEqual(calls, [{ cmd: plan.cmd, args: plan.args, options: { detached: true, stdio: 'ignore' } }]);
  assert.equal(unrefed, true, '分离进程必须 unref——开窗失败不得拖住服务进程');
  const onError = handlers.get('error');
  assert.equal(typeof onError, 'function', '异步启动失败必须有处理器兜底，不得让未处理事件崩掉服务');
  onError(new Error('ENOENT'));   // 处理器必须吞掉，调用即断言不抛
  assert.equal(openWindow({
    plan,
    spawnFn: () => {
      throw new Error('ENOENT');
    },
  }), false);
});

/* —— stopViewer —— */

test('stopViewer：多实例只停首个（端口序），后续端口不再探测', async () => {
  const { ports, probe } = scriptedProbe([healthOf({ pid: 111 }), healthOf({ pid: 111 }), null]);
  const killed = [];
  const { sleep } = fakeSleep();
  const result = await stopViewer({ candidatePorts: [7330, 7331], digest: DIGEST, probe, kill: (pid) => killed.push(pid), sleep });
  assert.deepEqual(result, { stopped: true, port: 7330, pid: 111 });
  assert.deepEqual(killed, [111]);
  assert.deepEqual(ports, [7330, 7330, 7330], '首端口命中即停：确认探与释放探都在 7330，7331 从未被探测');
});

test('stopViewer：别根跳过继续扫，kill 的是同根那个', async () => {
  const { ports, probe } = scriptedProbe([
    healthOf({ pid: 111, root: 'other000' }),
    healthOf({ pid: 222 }),
    healthOf({ pid: 222 }),
    null,
  ]);
  const killed = [];
  const { sleep } = fakeSleep();
  const result = await stopViewer({ candidatePorts: [7330, 7331], digest: DIGEST, probe, kill: (pid) => killed.push(pid), sleep });
  assert.deepEqual(result, { stopped: true, port: 7331, pid: 222 });
  assert.deepEqual(killed, [222]);
  assert.deepEqual(ports, [7330, 7331, 7331, 7331]);
});

test('stopViewer：复探不同 pid 或探空（pid 复用窗口）→ 不 kill，继续扫', async () => {
  const killed = [];
  const { sleep } = fakeSleep();
  const changed = scriptedProbe([healthOf({ pid: 111 }), healthOf({ pid: 222 })]);
  assert.deepEqual(
    await stopViewer({ candidatePorts: [7330], digest: DIGEST, probe: changed.probe, kill: (pid) => killed.push(pid), sleep }),
    { stopped: false },
  );
  const vanished = scriptedProbe([healthOf({ pid: 111 }), null]);
  assert.deepEqual(
    await stopViewer({ candidatePorts: [7330], digest: DIGEST, probe: vanished.probe, kill: (pid) => killed.push(pid), sleep }),
    { stopped: false },
  );
  assert.deepEqual(killed, [], '复探不一致一律不 kill');
});

test('stopViewer：kill 后轮询释放——两次仍活、第三次释放→stopped', async () => {
  const { probe } = scriptedProbe([
    healthOf({ pid: 111 }),
    healthOf({ pid: 111 }),
    healthOf({ pid: 111 }),
    healthOf({ pid: 111 }),
    null,
  ]);
  const killed = [];
  const { delays, sleep } = fakeSleep();
  const result = await stopViewer({ candidatePorts: [7330], digest: DIGEST, probe, kill: (pid) => killed.push(pid), sleep });
  assert.deepEqual(result, { stopped: true, port: 7330, pid: 111 });
  assert.deepEqual(killed, [111]);
  assert.equal(delays.length, 3, '第三次释放探测前共等三轮');
});

test('stopViewer：kill 抛错→stopped false＋reason（含底层原因）', async () => {
  const { probe } = scriptedProbe([healthOf({ pid: 111 }), healthOf({ pid: 111 })]);
  const { sleep } = fakeSleep();
  const result = await stopViewer({
    candidatePorts: [7330],
    digest: DIGEST,
    probe,
    kill: () => {
      throw new Error('EPERM');
    },
    sleep,
  });
  assert.equal(result.stopped, false);
  assert.match(result.reason, /111/);
  assert.match(result.reason, /EPERM/);
});

test('stopViewer：全无命中→{stopped:false}（不带 reason）', async () => {
  const { probe } = scriptedProbe([null]);
  const killed = [];
  const { sleep } = fakeSleep();
  const result = await stopViewer({ candidatePorts: [7330, 7331], digest: DIGEST, probe, kill: (pid) => killed.push(pid), sleep });
  assert.deepEqual(result, { stopped: false });
  assert.deepEqual(killed, []);
});

test('stopViewer：kill 后端口始终未释放→stopped false＋reason（不把「发过 kill」当已停止）', async () => {
  const { probe } = scriptedProbe([healthOf({ pid: 111 }), healthOf({ pid: 111 }), healthOf({ pid: 111 })]);
  const killed = [];
  const { delays, sleep } = fakeSleep();
  const result = await stopViewer({ candidatePorts: [7330], digest: DIGEST, probe, kill: (pid) => killed.push(pid), sleep });
  assert.equal(result.stopped, false);
  assert.equal(result.port, 7330);
  assert.equal(result.pid, 111);
  assert.match(result.reason, /未释放/);
  assert.deepEqual(killed, [111]);
  assert.equal(delays.length * delays[0], STOP_RELEASE_WAIT_MS, '轮数×周期＝等待窗口');
});

/* —— 再导出与常量约定 —— */

test('rootDigest：launch 的再导出与 server.js 定义是同一函数（单一权威）', () => {
  assert.equal(rootDigest, serverRootDigest);
  assert.equal(rootDigest('.'), serverRootDigest('.'));
});

test('端口段常量：基址 7330、试探 10 个（组合根与文档共用的契约值）', () => {
  assert.equal(DEFAULT_VIEWER_PORT, 7330);
  assert.equal(PORT_TRIES, 10);
});

/* —— 自动开窗构造（安静默认） —— */

test('viewerRootOf：显式与槽位 1 → main，槽位 k≥2 → s<k>，站点降级（无站点信息）→ main', () => {
  assert.equal(viewerRootOf({ siteMode: 'explicit', slot: null }), 'main');
  assert.equal(viewerRootOf({ siteMode: 'slot', slot: 1 }), 'main');
  assert.equal(viewerRootOf({ siteMode: 'slot', slot: 3 }), 's3');
  assert.equal(viewerRootOf({ siteMode: null, slot: null }), 'main');
});

test('buildViewerSpawn：root 映射三形态（explicit / slot1 / s≥2）进 --focus', () => {
  const argsFor = (site) => buildViewerSpawn({ ...site, ref: { id: 'c-abc' }, scriptPath: 'S' }).args;
  assert.deepEqual(argsFor({ siteMode: 'explicit', slot: null }), ['S', '--focus', 'main/c-abc']);
  assert.deepEqual(argsFor({ siteMode: 'slot', slot: 1 }), ['S', '--focus', 'main/c-abc']);
  assert.deepEqual(argsFor({ siteMode: 'slot', slot: 3 }), ['S', '--focus', 's3/c-abc']);
});

test('buildViewerSpawn：ref.root 注入值优先（与缺省推导同源）；id 缺省＝列表页不带 --focus', () => {
  assert.deepEqual(
    buildViewerSpawn({ siteMode: 'explicit', slot: null, ref: { root: 's4', id: 'c-1' }, scriptPath: 'S' }).args,
    ['S', '--focus', 's4/c-1'],
  );
  assert.deepEqual(buildViewerSpawn({ siteMode: 'slot', slot: 2, ref: null, scriptPath: 'S' }).args, ['S']);
  assert.deepEqual(buildViewerSpawn({ siteMode: 'slot', slot: 2, ref: { id: null }, scriptPath: 'S' }).args, ['S']);
});

test('buildViewerSpawn：env 三支——显式与站点降级不改写 WAYSTATION_HOME、槽位不注入，且不动父进程环境', () => {
  const saved = process.env.WAYSTATION_HOME;
  process.env.WAYSTATION_HOME = 'D:\\tmp\\ws-home';
  try {
    const explicit = buildViewerSpawn({ siteMode: 'explicit', slot: null, ref: null, scriptPath: 'S' });
    assert.equal(explicit.env.WAYSTATION_HOME, 'D:\\tmp\\ws-home', '显式模式自然继承，不改写');
    const degraded = buildViewerSpawn({ siteMode: null, slot: null, ref: null, scriptPath: 'S' });
    assert.equal(degraded.env.WAYSTATION_HOME, 'D:\\tmp\\ws-home', '站点降级（无站点信息）：活动目录由 env 决定（显式目录或主目录），子进程解析必须与父同址');
    const slot = buildViewerSpawn({ siteMode: 'slot', slot: 2, ref: null, scriptPath: 'S' });
    assert.equal(slot.env.WAYSTATION_HOME, undefined, '槽位模式不注入——子进程缺省解析＝主目录');
    assert.equal(process.env.WAYSTATION_HOME, 'D:\\tmp\\ws-home', '不得改写父进程环境');
  } finally {
    if (saved === undefined) {
      delete process.env.WAYSTATION_HOME;
    } else {
      process.env.WAYSTATION_HOME = saved;
    }
  }
});

test('buildViewerSpawn：command/options 契约（当前 node、detached＋windowsHide＋stdio ignore）', () => {
  const plan = buildViewerSpawn({ siteMode: 'explicit', slot: null, ref: { id: 'c-1' }, scriptPath: 'S' });
  assert.equal(plan.command, process.execPath);
  assert.deepEqual(plan.options, { detached: true, windowsHide: true, stdio: 'ignore' });
});

/* —— viewerAutoOpen 现读（读文件注入桩：本文件不碰真实文件系统） —— */

function readWith(content) {
  const warns = [];
  const value = readViewerAutoOpen({ dataDir: 'X', readFile: () => content, warn: (message) => warns.push(message) });
  return { value, warns };
}

test('readViewerAutoOpen：true/false 原值透传、不留告警', () => {
  assert.deepEqual(readWith('{"viewerAutoOpen": true}'), { value: true, warns: [] });
  assert.deepEqual(readWith('{"viewerAutoOpen": false}'), { value: false, warns: [] });
});

test('readViewerAutoOpen：缺失（无文件）/缺省（无字段）→ true 静默', () => {
  const missing = () => {
    const error = new Error('ENOENT');
    error.code = 'ENOENT';
    throw error;
  };
  const cases = [
    ['字段缺省', () => '{"identityName": "本机"}'],
    ['文件缺失', missing],
    ['根非对象（无字段）', () => '[true]'],
  ];
  for (const [name, readFile] of cases) {
    const warns = [];
    const value = readViewerAutoOpen({ dataDir: 'X', readFile, warn: (message) => warns.push(message) });
    assert.equal(value, true, `${name}：按默认开启`);
    assert.deepEqual(warns, [], `${name}：缺省不告警（沿 config 既有回落样式）`);
  }
});

test('readViewerAutoOpen：值非法（非布尔）/读不出解析不了 → true＋warn 一次', () => {
  const readFailure = (code) => () => {
    const error = new Error(code);
    error.code = code;
    throw error;
  };
  const cases = [
    ['值非法（字符串）', () => '{"viewerAutoOpen": "yes"}'],
    ['值非法（数字）', () => '{"viewerAutoOpen": 1}'],
    ['JSON 损坏', () => '{损坏'],
    ['读取故障（非 ENOENT）', readFailure('EACCES')],
  ];
  for (const [name, readFile] of cases) {
    const warns = [];
    const value = readViewerAutoOpen({ dataDir: 'X', readFile, warn: (message) => warns.push(message) });
    assert.equal(value, true, `${name}：按默认开启`);
    assert.equal(warns.length, 1, `${name}：warn 留痕一次`);
  }
});

/* —— 触发 B 的「进行中」筛选 —— */

test('inProgressCollabsOf：manager 含 proposed、member 排除；归档态两侧都不算', () => {
  const entries = [
    { collabId: 'm-proposed', role: 'manager', state: 'proposed' },
    { collabId: 'm-active', role: 'manager', state: 'active' },
    { collabId: 'm-frozen', role: 'manager', state: 'frozen' },
    { collabId: 'm-completed', role: 'manager', state: 'completed' },
    { collabId: 'm-terminated', role: 'manager', state: 'terminated' },
    { collabId: 'j-proposed', role: 'member', state: 'proposed' },
    { collabId: 'j-active', role: 'member', state: 'active' },
    { collabId: 'j-frozen', role: 'member', state: 'frozen' },
    { collabId: 'j-left', role: 'member', state: 'left' },
  ];
  assert.deepEqual(inProgressCollabsOf(entries).map((entry) => entry.collabId), [
    'm-proposed', 'm-active', 'm-frozen', 'j-active', 'j-frozen',
  ]);
  assert.deepEqual(inProgressCollabsOf([]), []);
  assert.deepEqual(inProgressCollabsOf(null), []);
});
