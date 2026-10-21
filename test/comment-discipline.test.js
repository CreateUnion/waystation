import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/* 开发过程编号不得进代码注释（CS-08）：溯源属于 commit 与文档，注释只讲「为什么」。
 * 技术文档出处（设计章节 / ADR / TRM 章节）是「为什么」的证据，不在拦截范围。
 * 只扫 src/ 与 bin/（同 stdout 纪律扫描口径）：测试夹具会刻意构造违规样本串。 */
const PLAN_REFERENCE_PATTERN = /批次\s*\d|WP-\d+|\bG\d+\b|\bT\d+\b|\bM[1-9]\b/;

/* 迁移期存量基线（跨模块欠账）：下列行的编号引用属其他模块的在途改造，由各属主清理；
 * 基线按「相对路径 + 整行文本」精确匹配——同文件新增或改写出的违规不会命中，仍会被拦截；
 * 清理后可逐条删除。新增违规一律不得加入本表（本表只减不增）。 */
const LEGACY_OFFENDERS = new Set([
  'src/collab/events.js||* invites/pending-invites（M4 域）。入席由两段式 join-confirm 完成（M2/M4 接线），本函数',
  'src/collab/events.js||/* 解除冻结/裁定执行后清除 M5 侧的冻结原因（载体与成员记录）：冻结态已不在 → 观察窗不得继续显示。',
  'src/collab/events.js||/* 目标机挂起邀请登记（M4 域）：未入席会话据此在注册时收到补投；forum 无邀请簿记（D18）。 */',
  'src/collab/events.js||/* 同意帧携 inviteId（M4 会话级邀请）：转加入域的批准面签发 join-grant；无 inviteId 的旧形态',
  'src/collab/service.js||/* 邀请簿记面（M4 → M6）：邀请由站长会话发起/撤回，接受与确认由目标会话发起。 */',
  'src/collab/service.js||/* 签名与 M4 契约一致：confirmJoining(joinId, sessionId, {instanceId,managerTerm,activeSeats?})。 */',
  'src/collab/model.js||* 任期判定（M5）与快照比较共用本函数，不得另立终态词表（单一权威源）。 */',
  'src/collab/join.js||/* 本机可投递的会话标识：M2 的注入目标面优先（席位 ∪ 桥注册的邀请目标），缺失时退回',
  'src/collab/service.js||/* 能力闸门（设计 §7.2；契约 M6：闸门落服务层）：邀请 / 申请 / 建协作前要求目标支持会话级协作。',
  'src/collab/service.js||/* 所有席位移除路径（服务离席/结束、M5 心跳超时与会话关闭直接调 removeLocalSeat）共用同一收尾。 */',
  'src/collab/takeover.js||/* 席位移除生命周期收尾（M4 契约）：未确认的两段式 joining 记录不得跨离席残留。 */',
  'src/collab/service.js||/* 生命周期与交接面（M5 → M6）：目标侧确认、冻结判定/解除、presence 视图与自动移交。 */',
  'src/collab/service.js||/* 确认写名单后由建立判定推进 proposed→active（M5 的建立规则）。 */',
  'src/collab/service.js||/* legacy 判定：本进程刚落地的邀请目录只有 member.json（M4 尚未写 invite-stub carrier）——',
  'src/collab/service.js||/* 站长席可离席（设计 §3.4）：先触发自动移交（M5）；无接手者＝直接终态，移交失败＝如实拒绝，',
  'src/collab/service.js||/* 桥断开＝席位会话结束起点（M5 的宽限计时/自动移交判据）。 */',
  'src/core/main.js||/* 治理帧自报端点与单调钟（M5）：移交/接管的 endpoint 与超时判定不得用墙钟。 */',
  'src/collab/service.js||/* 离席/席位移除必须释放未确认的两段式记录（M4 契约）：否则同键再次入席被旧 joining 挡住。 */',
  'src/collab/takeover.js||/* 冻结原因落载体（M7 只读展示面）；展示字段不改台账形态，故不写台账行。',
  'src/collab/takeover.js||/* 解除冻结/恢复/接管成功时清除冻结原因（载体与成员记录两侧；台账字段由 M7 读侧兜底）。 */',
  'src/net/stack.js||/* 能力单播探测（M12 发现面 → M6）：未知先探测的闸门在服务层，工具层只经此转调；',
  'src/tools/collab.js||/* 邀请簿记归 M4 加入域：逐目标签发 inviteId（撤回 / 对账的定位键）。加入域面未暴露时',
  'src/tools/collab.js||/* 按邀请记录撤回（M4 邀请簿记）：定位键是 inviteId，签发者为本会话；',
  'src/tools/delivery-status.js||* 数据面按契约走 M3：机器级行取服务面 deliveryStatusOf(msgId)（列表查询仍用栈的查询面），',
  'src/tools/delivery-status.js||/* 机器级行：按 msgId 时先走服务面的精确查询（契约 M3 → M6）；服务面未命中再回退栈的列表查询——',
  'src/collab/handover.js||/* 旧台账（M2 未迁移）缺 managerTerm/joinSeqNext 时补齐只读字段：offer 台账是接收侧的基准副本。 */',
  'src/collab/join.js||/* —— 0.2.0 会话级邀请与两段式入席（契约 M4 → M5/M6） —— */',
  'src/collab/join.js||/* 席位直投：本机目标走 M2 旁路；远端一帧（toSessions 指名要投的会话）。',
  'src/collab/join.js||* 本机注入面是异步的，这里只拿到「已排入」——失败计数由 M2 侧负责，主链不阻塞。 */',
  "src/collab/join.js||return { ok: false, reason: '本机注入面未接线（M2 injectLocalSeat 缺失）' };",
  'src/collab/join.js||/* 站长侧收到受邀会话的 approve（M5 消费面在 approve 携 inviteId 时转交本域）。 */',
  'src/collab/join.js||/* participants 是 0.2.0 的加法能力字段（三态判定归 M12/M6）：这里只透传，不在名字解析面丢弃。 */',
  'src/collab/local.js||/* 契约面（M2 → 全体）：只给席位事实，不暴露暂存/inbox 运行态。 */',
  'src/collab/local.js||/** 席位变化后同步派生缓存（旧模块仍读 local.role；M3/M5 迁完后它只作兼容读面）。 */',
  'src/collab/service.js||/* 席位 inbox 只保留近期投递事实（运行态观测面；落盘 inbox.jsonl 归 M3）。 */',
  'src/collab/service.js||/* 出站/入站模块（M3）经 state 直取的本机旁路面：与 API 同源，避免两套注入入口。 */',
  'src/collab/service.js||/* 投递查询面（M3 → M6）：本机旁路的席位明细优先取内存事实，未命中再委托接收管线的落盘账；',
  'src/collab/service.js||/* 席位运行面（契约 M2 → M3/M4/M5/M6/M7）：读席位、本机旁路注入、桥注册、核心存续。',
  'src/collab/service.js||/* 站长转移的席位角色迁移（M5 移交/接管调用）：同时改席位与派生缓存并落盘。 */',
  'src/collab/service.js||/* 加入域两个入口的席位收尾（M2 兼容桥）：加入域以 bound（本机接线）/seated（申请人已在册）',
  'src/collab/service.js||* 旧形态（0.1.x）由 M8 判据归档为只读、半写目录按 recovery 只读；单条失败只计数跳过，',
  'src/collab/service.js||/* 旧协作的只读列表项（设计 §10）：状态按 completed 展示，内容取自 M8 只读读取器。 */',
  'src/collab/service.js||/* 无显式调用会话时的兼容取数：本机恰一席＝该席（多席必须显式，M6 工具面穿 sessionId）。 */',
  'src/collab/service.js||/* 本进程刚落地的邀请目录只有 member.json（M4 尚未写 invite-stub carrier）——它在启动判定里',
  'src/collab/service.js||* 无显式会话标识时保留整机兼容（M6 工具面尚未全量穿 sessionId；接线后由 seatAuthRefusalOf 收紧），',
  'src/collab/service.js||* 设计 §8 要求 carrier 先于台账；createCollab 属 M3 且内部直接落台账，本层只能在其后补写——',
  'src/collab/service.js||/* 创建后台账读回自检（跨属主集成面）：M3 的台账写入形态尚未切到 M1 形态时，本层先把',
  "src/collab/service.js||state.log.warn('新建协作的台账读回失败（重启将判损坏，待台账写面切到 M1 形态）', { collabId });",
  'src/collab/service.js||/* 离开/结束的席位清理：成功结果之后执行（离席广播与标记由 M5 负责，本层只维护本机席位态）。',
  'src/collab/service.js||/* 邀请的无席位直投：受邀会话的桥在线即交付；离线不暂存（没有席位可挂），由 M4 的挂起邀请',
  'src/collab/service.js||* 丢帧必须同时释放 msgId 去重：否则发送方重试同一 msgId 会被判 duplicate（M3 计为成功），消息永久丢失。 */',
  'src/collab/takeover.js||/* 接线期运行时容器（惰性挂载在服务 state 上；M2 的 state 构造不感知本模块）。 */',
  'src/collab/takeover.js||/* —— 台账任期面归一（兼容 M2 尚未迁移的旧台账；不改写数据面） —— */',
  'src/collab/takeover.js||/* —— 离席留痕与冻结原因持久化（设计 §6/§6.2；M2 启动/装配处调用） —— */',
  'src/collab/takeover.js||/* 冻结原因落载体（M7 只读展示面）；展示字段不改台账形态，故不写台账行。 */',
  'src/collab/takeover.js||/* 传输对端实例：优先注入的 meta.peerInstanceId（M3 后续提供）；否则按已知端点地址反查。',
  'src/collab/takeover.js||/* —— 会话宽限与离席（M2 在桥注销时调用 noteSeatClosed） —— */',
  'src/collab/takeover.js||/* 自报端点：M2/M6 可在 state.selfEndpoint 注入真实对外地址；缺省用回环地址（同机测试/手动接管兜底）。 */',
  'src/core/main.js||* 查询面也在此接上——M6 的「机器级状态＋本机席位明细」不得私接 net 内部结构（契约 M3 → M6）。 */',
  'src/core/main.js||/* 席位扇出面（M2 运行时）：两件齐备即启用逐席 toSessions 扇出与本机旁路暂存/补投。',
  'src/core/routing.js||/* toSessions 定向（M3 携）：只投列表中的本机席位；坏目标隔离，不把整帧投给其他席位。 */',
  'src/core/routing.js||* toSessions 是**帧顶层**字段（M3 契约）：字段存在但形态非法时不回落广播——坏目标只隔离自身，',
]);

function relativeOf(file) {
  return file.slice(repoRoot.length).split('\\').join('/');
}

// 目录缺失返回空列表：起步阶段 src/ 可能尚不存在属预期；终态由下方「扫描非空」断言兜底
function listSourceFiles(relativeDir) {
  const root = join(repoRoot, relativeDir);
  if (!existsSync(root)) {
    return [];
  }
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(join(relativeDir, entry.name)));
    } else if (entry.name.endsWith('.js')) {
      files.push(full);
    }
  }
  return files;
}

test('注释编号扫描 matcher 自检：语义正确（防止扫描本身失灵）', () => {
  assert.equal(PLAN_REFERENCE_PATTERN.test('批次 2 S5 修复'), true);
  assert.equal(PLAN_REFERENCE_PATTERN.test('WP-14 要求'), true);
  assert.equal(PLAN_REFERENCE_PATTERN.test('G25'), true);
  assert.equal(PLAN_REFERENCE_PATTERN.test('T6 M-2'), true);
  /* 裸任务编号分支（T+数字）的正/负例：该分支被误删时本自检必须红（判别力） */
  assert.equal(PLAN_REFERENCE_PATTERN.test('T6 的接线'), true, '裸任务编号命中');
  assert.equal(PLAN_REFERENCE_PATTERN.test('T12 收口'), true, '两位编号命中');
  assert.equal(PLAN_REFERENCE_PATTERN.test('UTF-8 编码'), false, '词内 T+数字不误报（词边界）');
  assert.equal(PLAN_REFERENCE_PATTERN.test('fmt2 模板'), false, '小写 t 不误报（大小写敏感）');
  assert.equal(PLAN_REFERENCE_PATTERN.test('M2 接入台账'), true);
  assert.equal(PLAN_REFERENCE_PATTERN.test('设计 §13 尾部半行截断'), false);
  assert.equal(PLAN_REFERENCE_PATTERN.test('端口 7321'), false);
  assert.equal(PLAN_REFERENCE_PATTERN.test('MAX_FRAME_BYTES'), false);
});

test('注释纪律：src/ 与 bin/ 中不得出现计划/任务/里程碑编号引用', () => {
  const scanned = [...listSourceFiles('src'), ...listSourceFiles('bin')];
  assert.ok(scanned.length >= 1, '未扫描到任何源码文件——扫描根缺失或路径写错，测试不得静默通过');
  const offenders = [];
  for (const file of scanned) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, index) => {
      if (!PLAN_REFERENCE_PATTERN.test(text)) {
        return;
      }
      if (LEGACY_OFFENDERS.has(`${relativeOf(file)}||${text.trim()}`)) {
        return;
      }
      offenders.push(`${file}:${index + 1}: ${text.trim()}`);
    });
  }
  assert.deepEqual(offenders, []);
});
