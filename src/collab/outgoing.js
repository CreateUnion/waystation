import { isIP } from 'node:net';
import { COLLAB_MODES, DEFAULT_COLLAB_MODE, ID_PATTERN, MAX_COLLAB_MEMBERS, MAX_MESSAGE_TEXT_CHARS, MAX_REASON_CHARS, MAX_TOPIC_CHARS, POST_KINDS, PROTOCOL_VERSION, isCollabMode, isIdentityName, isPort, isPresentationText, newMsgId } from '../net/protocol.js';
import { MAX_FORUM_MEMBERS, MAX_LOCAL_COLLABS, canTransition, isArchived, newCollabId } from './model.js';
import { createPostsStore, displayOrderOf, newPostId } from './posts.js';
import { createMembersStore } from './members.js';
import { createCounterStore, notifyIndicatorChange } from './counter.js';
import { createMuteStore } from './mute.js';
import { createInjectedStore } from './injected.js';
import { createJoinsStore } from './joins.js';
import { consumeInviteChallenge, consumeInviteWaiver, issueInviteChallenge } from './consent.js';
import { ledgerDigest, removeLedgerFile } from './store.js';
import { currentManagerIdOf, emitOwnMemberEvent, foldedMembersOf, forumReachIdsOf, isLocalArchivedState, localModeOf, localNameOf, localRosterOf, localStateOf, localTopicOf, memberStateFor, persistLedger, persistMember, persistSnapshot, relayDepartedOf, relayPeerOf, rememberKnownHost, selfJoinedOf } from './local.js';
import { matchConflictCollabs } from './gate.js';

/* 对外操作与协作态变更实现（服务公共 API 的落点）：请求来自本机会话（工具面）——
 * 参数不符合即返回 { ok:false, message }（由工具层呈现为 isError）；发送一律经注入的
 * dispatch.send（可靠队列），单条入队失败只计数不回滚已完成的本地状态。 */

/* 可投递成员状态集（消息广播与通告的收件人口径）。 */
const MESSAGING_MEMBER_STATES = ['invited', 'approved', 'member'];

/* 已转达 originMsgId 集上限：转达防环与防重复的记录面（进程内、插入序淘汰）——
 * 每条治理通告的每跳只在首次收到时转达一次，重复副本不再向外扩散（本地应用仍幂等执行）。 */
const RELAYED_ORIGINS_MAX = 256;

/* 本机该协作的内容累计读数（讨论 = 帖子列表 size（含回填帖）、managed = 内容消息计数）。
 * 静音基线与取消摘要、入席默认静音的基线都必须经这一处取数——两处各算一次必然分叉，
 * 随后就是「默认静音的窗口起点与 /ws-mute 对不上」这类难查的错位。 */
export function contentCountOf(local) {
  return localModeOf(local) === 'forum' ? local.posts.size() : local.counter.count();
}

/* 提醒文案（设计 §3.3 的承载形态）：要素写死——已默认静音／消息不注入本会话／实时观看走
 * 观察窗（/ws-view）／要本会话实时跟进用 /ws-mute 取消静音。随成功载荷的 notice 字段承载；
 * 与静音写入同谓词产出（工具层只做输出封装，不另立一份「本次是否写了静音」的判定）。 */
const DEFAULT_MUTE_NOTICE = '已默认静音——消息不注入本会话；实时观看走观察窗（/ws-view），要本会话实时跟进用 /ws-mute 取消静音';

/* 入席默认静音（设计 §3.1）：本机成为参与者时默认写入静音，基线 = 写入时刻的当下累计读数。
 * 返回本次是否真写了（前态未静音即本次落笔；已在静音中不重复写）——提醒据此如实给，不虚报。
 * 只在「创建成功」与「同意加入成功」两处调用——挂到记录创建 / 成员落盘这类宽调用点，
 * 会把受邀未同意者也静音、在拒绝路径留下 mute.json 残留（本机不同意还被静音的故障形态）。 */
function applyDefaultMute(local) {
  const before = local.mute.setMuted(true, contentCountOf(local));
  return before.wasMuted !== true;
}

/* 获准写点（设计 §5:58 明文三处：create＝发起会话 / invite＝点头会话 / grant＝获批会话〔加入域〕）：
 * 写本机获准台账（collabs/<id>/joins.json 的 approvals）——adopt 收紧的唯一判据。只记协作
 * （讨论无批准门、不产获准段，如实不写）；会话标识缺省 / 形态坏＝没有会话可授予，不写。
 * 台账是权限记录、不是主链事实：写不进只留痕，创建 / 入席照旧成立（未获准的会话仍可 ws_join 申请）。
 * approvedBy 记点头者会话（工具面穿参的自然结果——创建即发起会话、同意即点头会话）。 */
function writeGrantApproval(state, local, sessionId, origin) {
  if (localModeOf(local) !== 'managed' || typeof sessionId !== 'string' || !ID_PATTERN.test(sessionId)) {
    return false;
  }
  try {
    const store = createJoinsStore({ dataDir: state.dataDir, collabId: local.collabId, log: state.log });
    if (store.addApproval({
      instanceId: state.self.instanceId,
      sessionId,
      origin,
      grantedAt: nowMsOf(state),
      approvedBy: sessionId,
    }) !== true) {
      state.log.warn('获准条目形态不符，未入账（该会话未获准）', { collabId: local.collabId, sessionId, origin });
      return false;
    }
    return true;
  } catch (error) {
    state.log.warn('获准台账写入失败（已忽略——未获准会话仍可 ws_join 申请）', { collabId: local.collabId, sessionId, origin, reason: error?.message });
    return false;
  }
}

/* 时刻（毫秒）：与加入域同一时钟基准（服务注入的 now；直调免注入时退回系统时钟）。 */
function nowMsOf(state) {
  return typeof state.clock === 'function' ? state.clock() : Date.now();
}

export function createCollab(state, { name, topic, targets, mode, sessionId }) {
  const collabMode = mode ?? DEFAULT_COLLAB_MODE;
  const rejected = createRejection(state, name, topic, targets, collabMode);
  if (rejected !== null) {
    return { ok: false, message: rejected };
  }
  const ledger = freshLedgerOf(state, name, topic, targets, collabMode);
  const local = {
    collabId: ledger.collabId,
    role: 'manager',
    ledger,
    member: managerRecordOf(ledger),
    endpoints: new Map(),
    snapshot: null,
    posts: createPostsStore({ dataDir: state.dataDir, collabId: ledger.collabId, log: state.log, onChange: () => notifyIndicatorChange(state) }),
    members: createMembersStore({ dataDir: state.dataDir, collabId: ledger.collabId, log: state.log, onChange: () => notifyIndicatorChange(state) }),
    counter: createCounterStore({ dataDir: state.dataDir, collabId: ledger.collabId, log: state.log, onChange: () => notifyIndicatorChange(state) }),
    mute: createMuteStore({ dataDir: state.dataDir, collabId: ledger.collabId, log: state.log }),
    injected: createInjectedStore({ dataDir: state.dataDir, collabId: ledger.collabId, log: state.log }),
    suspended: null,
    staleManagerId: null,
  };
  registerCreateTargets(state, local, targets);
  state.collabs.set(ledger.collabId, local);
  if (collabMode === 'forum') {
    /* 发起人实例标识 = 中继归属（设计 §5.1/§5.3）：本机即中继，随记录持久化
     * （随即发出的邀请载荷与 bundle 元状态携带它；成员据此定位中继）。 */
    local.member.originator = { instanceId: state.self.instanceId, identityName: state.self.identityName };
    emitOwnMemberEvent(state, local, 'join');   // 发起人自创建即在成员表内（"第一个"，设计 §5.1）
  }
  persistMember(state, local);
  persistLedger(state, local);
  const invited = inviteInitialTargets(state, ledger, targets, collabMode, local);
  state.counters.collabsCreated++;
  applyDefaultMute(local);   // 写点一：创建成功（邀请发送结果不影响入席事实）
  writeGrantApproval(state, local, sessionId, 'create');   // 获准写点一：发起会话（设计 §5）
  state.openViewer?.({ root: state.viewerRoot, id: ledger.collabId });   // 触发 A：建立即开该协作页（开关在出口内现读）
  /* 新建实例的静音状态必为空（新 collabId 无旧文件），写点一的默认静音必然落笔——提醒同发。 */
  return { ok: true, collabId: ledger.collabId, invited, notice: DEFAULT_MUTE_NOTICE };
}

/* 建协目标登记（端点表 ＋ 已知主机学习；台账名单由 freshLedgerOf 定格）。 */
function registerCreateTargets(state, local, targets) {
  for (const target of targets) {
    local.endpoints.set(target.instanceId, { address: target.address, port: target.port });
    rememberKnownHost(state, { address: target.address, port: target.port, instanceId: target.instanceId, identityName: target.identityName });
  }
  local.member.endpoints = Object.fromEntries(local.endpoints);
}

/* 创建邀请的发送面：逐目标发 invite（单条入队失败只如实标注，不回滚已建协作）；
 * 讨论邀请同携发起人实例标识（= 中继归属；创建者即发起人——与增邀 ws_invite 同款）。 */
function inviteInitialTargets(state, ledger, targets, collabMode, local) {
  const invited = [];
  for (const target of targets) {
    const payload = applyInviteNaming(invitePayloadOf(ledger, [], forumEndpointsOf(collabMode, local)), target);
    if (collabMode === 'forum') {
      payload.originator = { instanceId: state.self.instanceId, identityName: state.self.identityName };
    }
    const result = sendTo(state, ledger.collabId, target.instanceId, { address: target.address, port: target.port }, 'invite', payload);
    invited.push({ instanceId: target.instanceId, ok: result.ok === true, msgId: result.msgId, reason: result.reason });
    state.counters.invitesSent++;
  }
  return invited;
}

/* 指名会话随邀请帧（会话级加入 §3 发送面）：targets 项带 targetSessionId 即写入载荷顶层
 * payload.targetSessionId——接收侧据此只投该会话（不在场＝登记挂起、该会话注册时补投），
 * 且只有它能点头；省略＝不指名（照旧投目标机全部活跃会话，谁点头谁承接）。
 * 旧版对端忽略该加法字段，按未指名处理（等同不指名，如实）。 */
function applyInviteNaming(payload, target) {
  if (typeof target?.targetSessionId === 'string') {
    payload.targetSessionId = target.targetSessionId;
  }
  return payload;
}

/* 讨论邀请随带的端点表（设计 §5.1：现成员表与端点表——被邀者据此取得寻址信息）；managed 不带。 */
function forumEndpointsOf(mode, local) {
  return mode === 'forum' ? Object.fromEntries(local.endpoints) : null;
}

/* 新建台账（v1 proposed；名单 = 本机〔manager〕+ 各目标〔invited〕；模式创建时定死）。
 * 讨论模式的角色名沿用既有结构（发起人 = 本机 manager 记录）——平权语义与角色重命名归各模式链路
 * 落地阶段，本表只保证 mode 字段随实例走。 */
function freshLedgerOf(state, name, topic, targets, mode) {
  const now = new Date().toISOString();
  return {
    version: 1,
    collabId: newCollabId(),
    name,
    topic,
    mode,
    status: 'proposed',
    manager: { instanceId: state.self.instanceId, identityName: state.self.identityName },
    members: [
      { instanceId: state.self.instanceId, identityName: state.self.identityName, role: 'manager', state: 'member', joinedAt: now },
      ...targets.map((target) => ({ instanceId: target.instanceId, identityName: target.identityName, role: 'member', state: 'invited', joinedAt: now })),
    ],
    board: [],
    createdAt: now,
    updatedAt: now,
  };
}

/* 邀请成员加入既有讨论 / 既有协作（邀请入口的发送侧）。两模式权限与名单语义不同：
 * 讨论＝**任何成员可发起**（平权，设计 §5.1），名单以折叠成员表为准、邀请不改本地成员表；
 * 协作＝**仅站长可发起**（治理模式），目标机器须不在有效名单内（已入席机器的新会话走 ws_join
 * 申请、站长批准），受邀行先登记为 invited 再发帧（载荷名单须含目标——被邀者准入判据），
 * 终局行（declined/withdrawn/left）可重邀翻回 invited。 */
export function inviteMembers(state, { collabId, targets }) {
  const local = state.collabs.get(collabId);
  if (local === undefined) {
    return { ok: false, message: '本机没有该协作或讨论（collabId 不存在）——先看 ws_list_collabs' };
  }
  if (isLocalArchivedState(local)) {
    return { ok: false, message: '该协作或讨论已结束（或已终止 / 已退出）——不再受理邀请动作' };
  }
  const targetsRejection = targetsRejectionOf(targets, state.self.instanceId);
  if (targetsRejection !== null) {
    return { ok: false, message: targetsRejection };
  }
  return localModeOf(local) === 'forum'
    ? inviteForumMembers(state, local, targets)
    : inviteManagedMembers(state, local, targets);
}

/* 讨论邀请（既有路径保持不变）：任何成员可发起；名额数据源＝折叠成员表（被拒/被撤回者不占名额）。 */
function inviteForumMembers(state, local, targets) {
  if (!selfJoinedOf(local, state.self.instanceId)) {
    return { ok: false, message: '本机尚未加入该讨论（等待邀请或先回应邀请）——加入为成员后才能邀请他人' };
  }
  /* 上限检查点在放行/邀请步之前（设计 §5.6）；名额数据源 = 折叠成员表（含 invited 的旧名单口径
   * 会让被拒者永久占用名额）。 */
  if (foldedMembersOf(local).length >= MAX_FORUM_MEMBERS) {
    return { ok: false, message: `该讨论成员表已达上限（${MAX_FORUM_MEMBERS}）——不再发起新邀请` };
  }
  const topic = localTopicOf(local);
  if (topic === null) {
    return { ok: false, message: '本地记录缺讨论主题（等待对表拉回讨论元状态后重试）——不代发残缺帧' };
  }
  const invited = [];
  for (const target of targets) {
    const payload = applyInviteNaming(forumInvitePayloadOf(state, local, topic, targets), target);
    const result = sendTo(state, local.collabId, target.instanceId, { address: target.address, port: target.port }, 'invite', payload);
    invited.push({ instanceId: target.instanceId, ok: result.ok === true, msgId: result.msgId, reason: result.reason });
    state.counters.invitesSent++;
  }
  return { ok: true, collabId: local.collabId, invited };
}

/* 协作增员（站长制）：目标已在有效名单（invited / approved / member）＝如实拒——该机器的新会话
 * 应走 ws_join 申请（站长批准走 join-grant，不扰动既有成员行）；终局行重邀翻回 invited。 */
function inviteManagedMembers(state, local, targets) {
  if (local.role !== 'manager') {
    return { ok: false, message: '只有站长可以邀请成员加入协作——成员会话请让目标走 ws_join 申请（由站长批准）' };
  }
  const activeStates = new Set(['invited', 'approved', 'member']);
  for (const target of targets) {
    const held = local.ledger.members.find((entry) => entry.instanceId === target.instanceId);
    if (held !== undefined && held.role !== 'manager' && activeStates.has(held.state)) {
      return { ok: false, message: `目标已在协作名单内（${target.identityName ?? target.instanceId}，${held.state}）——其新会话请走 ws_join 申请（或由站长批准）` };
    }
  }
  const additions = targets.filter((target) => !local.ledger.members.some((entry) => entry.instanceId === target.instanceId));
  if (local.ledger.members.length + additions.length > MAX_COLLAB_MEMBERS) {
    return { ok: false, message: `协作成员已达上限（${MAX_COLLAB_MEMBERS}）——不再发起新邀请` };
  }
  const registered = registerManagedInvites(state, local, targets, new Date().toISOString());
  if (registered === null) {
    return { ok: false, message: '受邀登记未落地（台账写入被挂起或失败）——未发邀请，可稍后重试' };
  }
  const base = invitePayloadOf(local.ledger, [], null);
  const invited = [];
  for (const target of targets) {
    const payload = applyInviteNaming({ ...base, members: base.members.map((entry) => ({ ...entry })) }, target);
    const result = sendTo(state, local.collabId, target.instanceId, { address: target.address, port: target.port }, 'invite', payload);
    invited.push({ instanceId: target.instanceId, ok: result.ok === true, msgId: result.msgId, reason: result.reason });
    state.counters.invitesSent++;
  }
  return { ok: true, collabId: local.collabId, invited };
}

/* 协作增员的受邀登记：新目标入表为 invited；终局行重邀翻回 invited（非终局行已在上层拒绝）。 */
function registerManagedInvites(state, local, targets, now) {
  return mutateLedger(state, local, (ledger) => {
    for (const target of targets) {
      const row = ledger.members.find((entry) => entry.instanceId === target.instanceId);
      if (row === undefined) {
        ledger.members.push({ instanceId: target.instanceId, identityName: target.identityName, role: 'member', state: 'invited', joinedAt: now });
        continue;
      }
      /* 终局行重邀（2026-10-19 产品裁定）：翻回 invited；非终局行已在上层拒绝。 */
      row.state = 'invited';
      row.identityName = target.identityName;
      row.joinedAt = now;
    }
  });
}

/* 讨论邀请载荷（发送侧公共构造）：名/主题/模式 + **发起人实例标识（中继归属）** +
 * **折叠成员表 ∪ 本次目标**（被邀者据此校验名单含自己与来源）+ 现端点表。
 * 发起人标识随最新邀请定格（中继归属不得由邀请者推断——邀请者≠发起人）；本机未知时省略
 * （不臆造——被邀者按「中继未知」降级直投，待对表补学）。名单 2–32 由协议层照旧校验。 */
function forumInvitePayloadOf(state, local, topic, targets) {
  const members = foldedMembersOf(local).map((member) => ({ instanceId: member.instanceId, identityName: member.identityName }));
  const seen = new Set(members.map((member) => member.instanceId));
  for (const target of targets) {
    if (!seen.has(target.instanceId)) {
      seen.add(target.instanceId);
      members.push({ instanceId: target.instanceId, identityName: target.identityName });
    }
  }
  const payload = {
    name: localNameOf(local),
    topic,
    mode: 'forum',
    members,
    endpoints: Object.fromEntries(local.endpoints),
  };
  const relay = relayPeerOf(local, state.self);
  if (relay !== null) {
    payload.originator = { instanceId: relay.instanceId, identityName: relay.identityName };
  }
  return payload;
}

/* —— 主动加入（设计 §5.6）：成员侧敲门命中处理 —— */

/* 发现层经注入回调调用（本层不 import 发现层）：逐本机讨论实例按讨论名匹配；命中即向本机会话
 * 注入一行放行指引（放行实质 = 本机人确认后执行 ws_invite），并在本地元数据可答时生成 join-ack
 * 应答载荷交发现层回发。提示属「状态与待办」类（放行是待办动作）——经 notifyLocal 直投，
 * 属放行链的触发面，不因静音被抑制。
 * 本地元数据不全（主题 / 发起人标识未知）的实例仍提示、但**不代发残缺应答**（沿邀请侧
 * 「不代发残缺帧」先例）：提示照发（放行路径不依赖应答内容），应答跳过并计数留痕——
 * 由申请人稍后重敲或待对表补齐后再答。
 * 应答前件（单核路由面）：提示须有接收者（该协作的绑定会话活跃）——无接收者不回 join-ack，
 * 提示照常经路由面按「丢弃＋留痕」处置（见 notifyLocal 返回值契约）。 */
export function handleJoinKnock(state, knock) {
  const replies = [];
  for (const local of state.collabs.values()) {
    if (!matchesJoinKnock(state, local, knock.name)) {
      continue;
    }
    state.counters.joinKnockMatches++;
    /* 应答判据＝该协作的绑定会话是否活跃（经提示面的路由结论表达）：无接收者不回 join-ack——
     * 如实表达无人值守，避免对端得到「有人应答但无人放行」的悬置态；休眠期丢弃由路由面留痕。 */
    if (notifyLocal(state, local, joinKnockNoticeText(knock, localNameOf(local))) === false) {
      state.log.warn('敲门命中但该协作无活跃绑定会话——不回应答（无人值守）', { collabId: local.collabId });
      continue;
    }
    const reply = joinKnockReplyOf(state, local);
    if (reply === null) {
      state.counters.joinKnockAckSkipped++;
      state.log.warn('敲门命中讨论但本地元数据不全，不回应答（提示照发）', { collabId: local.collabId });
      continue;
    }
    replies.push(reply);
  }
  return replies;
}

/* 命中判据：本机**已加入**的讨论实例（forum、本机已加入、未归档 / 未退出）且讨论名相等。
 * 已结束 / 已退出 / 已终止的实例不再纳新（应答指向的加入路径必然失败）；受邀未同意者尚非成员、
 * 无权放行；managed 实例与讨论名同形也不命中（主动加入是讨论模式的能力）。 */
function matchesJoinKnock(state, local, name) {
  return localModeOf(local) === 'forum'
    && !isLocalArchivedState(local)
    && selfJoinedOf(local, state.self.instanceId)
    && localNameOf(local) === name;
}

/* 应答载荷（不可截字段在此定格：collabId / 成员数 / 发起人标识；主题与名称的截断归发现层的
 * 体积整形）。主题或发起人标识未知 → null（不代发残缺应答）。 */
function joinKnockReplyOf(state, local) {
  const topic = localTopicOf(local);
  const originator = relayPeerOf(local, state.self);
  if (topic === null || originator === null) {
    return null;
  }
  return {
    collabId: local.collabId,
    name: localNameOf(local),
    topic,
    memberCount: foldedMembersOf(local).length,
    originator: { instanceId: originator.instanceId, identityName: originator.identityName },
  };
}

/* 放行指引文案：申请人身份（含实例标识）与来源端点（放行时作 ws_invite 的 targets 项）、讨论名。
 * 同意门仍在申请人一侧——本机放行只是发出正式邀请。 */
function joinKnockNoticeText(knock, name) {
  return `收到加入申请：「${knock.identityName}」（实例 ${knock.instanceId}，端点 ${knock.address}:${knock.port}）想加入讨论「${name}」——放行 = 本机用 ws_invite 邀请它（targets 用该身份与端点），随后由对方的同意门定夺`;
}

export function approveInvite(state, { collabId, approve, reason, sessionId, confirmToken }) {
  const local = state.collabs.get(collabId);
  if (local === undefined) {
    return { ok: false, message: '本机没有该协作（collabId 不存在）——先看 ws_list_collabs' };
  }
  if (local.role !== 'member' || local.member.state !== 'proposed') {
    return { ok: false, message: '该协作不在待回应邀请状态' };
  }
  const wanted = approve ? 'approved' : 'declined';
  const decided = local.member.decision ?? null;
  if (decided === wanted) {
    return { ok: true, decision: wanted };
  }
  if (decided !== null) {
    return { ok: false, message: `已回应过（${decided}）——不能改口` };
  }
  /* 用户确认门（2026-10-19 产品裁定）：带会话标识的决定必须先拿一次性确认挑战或豁免。
   * 首次调用只签发挑战、不改任何状态——代理须把邀请转述给用户并取得明确同意后携令牌重试。 */
  const consent = inviteConsentGate(state, local, sessionId, confirmToken);
  if (consent !== null) {
    return consent;
  }
  return applyInviteDecision(state, local, approve, wanted, reason, sessionId);
}

/* 确认门判定：无会话标识（服务直调/旧路径）不设门；有豁免直接放行；有有效挑战放行；
 * 否则签发新挑战并返回需要用户确认的结构化结果（邀请摘要供代理转述）。 */
function inviteConsentGate(state, local, sessionId, confirmToken) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    return null;
  }
  if (consumeInviteWaiver(state, { sessionId })) {
    return null;
  }
  if (consumeInviteChallenge(state, { sessionId, collabId: local.collabId, token: confirmToken })) {
    return null;
  }
  const token = issueInviteChallenge(state, { sessionId, collabId: local.collabId });
  return {
    ok: false,
    needsUserConfirmation: true,
    confirmToken: token,
    invite: inviteSummaryOf(local),
    message: '同意 / 拒绝邀请需要用户明确确认：请把邀请信息转述给用户，取得明确同意后携带 confirmToken 重试；若用户明确表示下一次无需确认，可先用 ws_allow_next_invite 登记一次性豁免',
  };
}

/* 邀请摘要（供代理向用户转述）：名/模式/主题/邀请者与有效期。 */
function inviteSummaryOf(local) {
  const manager = local.member?.manager;
  return {
    collabId: local.collabId,
    name: localNameOf(local),
    mode: localModeOf(local),
    topic: local.member?.topic ?? null,
    manager: manager === undefined ? null : { instanceId: manager.instanceId, identityName: manager.identityName },
    invitedAt: local.member?.invitedAt ?? null,
    expiresAt: local.member?.expiresAt ?? null,
  };
}

/* 表态的落地与入席副作用（设计 §3.1/§3.3）：分派到讨论 / 协作各自的实现；同意且实现成功时
 * 写默认静音、给一行提醒。入席、写静音、提醒三者同谓词——判据取**决策结果**（wanted）而非
 * 原始入参的真值：服务 API 直调传非布尔真值时入席照旧生效，静音与提醒必须跟着生效，
 * 不得只剩半套（拒绝、参数非法、端点未知等分支则一律不写，不留残留）。
 * 获准写点二（设计 §5:58）：同意邀请成功的**点头会话**入本机获准台账（origin:invite）——
 * 会话标识由工具面穿参（缺省＝无会话标识，如实不写；见 writeGrantApproval）。 */
function applyInviteDecision(state, local, approve, wanted, reason, sessionId) {
  const result = localModeOf(local) === 'forum'
    ? decideForumInvite(state, local, wanted, reason)
    : sendDecision(state, local, approve, wanted, reason);
  if (wanted !== 'approved' || result.ok !== true) {
    return result;
  }
  const wrote = applyDefaultMute(local);   // 写点二：同意加入成功
  writeGrantApproval(state, local, sessionId, 'invite');
  state.openViewer?.({ root: state.viewerRoot, id: local.collabId });   // 触发 A：同意入席即开该协作页（开关在出口内现读）
  /* 提醒只在本次真的写了静音时给：幂等重入的早返回根本到不了这里（本次什么都没写），
   * 说「已默认静音」会与事实相反。 */
  return wrote ? { ...result, notice: DEFAULT_MUTE_NOTICE } : result;
}

/* 讨论的邀请回应（设计 §5.1/§5.4）：同意 = 加入**立即生效**——本地转进行中、自播 join
 * （携身份；端点经既有学习面散布）、未收敛前递增间隔重播；生效不依赖邀请者在场。
 * approve/decline 帧仍发回邀请者作簿记（best-effort——端点未知不构成失败）。
 * joined 标记供服务层在加入后驱动一轮回填对表（显式契约，不越模块边界）。 */
function decideForumInvite(state, local, wanted, reason) {
  const validated = validateDeclineReason(reason);
  if (validated.ok !== true) {
    return { ok: false, message: validated.message };
  }
  local.member.decision = wanted;
  if (wanted === 'approved') {
    local.member.state = 'active';
    local.joinConfirmed = false;   // 新加入：未确认（重播/对表自愈的判据位）
  }
  persistMember(state, local);
  if (wanted === 'approved') {
    const event = emitOwnMemberEvent(state, local, 'join');
    if (event !== null) {
      state.counters.forumJoinsOut++;
      startJoinReplay(state, local, event);
    }
  }
  const bookkeeping = sendInviteBookkeeping(state, local, wanted, validated.reason);
  state.counters.decisionsSent++;
  return { ok: true, decision: wanted, joined: wanted === 'approved', bookkeeping };
}

/* 拒绝原因的服务层预校验（与 sendDecision 同一判据；空串归一为未给出）。 */
function validateDeclineReason(reason) {
  const trimmed = typeof reason === 'string' ? reason.trim() : '';
  if (trimmed !== '' && !isPresentationText(trimmed, MAX_REASON_CHARS)) {
    return { ok: false, message: `拒绝原因非法：需为 ≤${MAX_REASON_CHARS} 字符、不含换行 / 不可见字符的呈现文本` };
  }
  return { ok: true, reason: trimmed === '' ? undefined : trimmed };
}

/* 邀请回执的簿记面（approve / decline 发回邀请者；加入生效不依赖它）。 */
function sendInviteBookkeeping(state, local, wanted, reason) {
  const managerId = local.member.manager?.instanceId;
  const endpoint = typeof managerId === 'string' ? local.endpoints.get(managerId) : undefined;
  if (endpoint === undefined) {
    return { delivered: false, reason: '邀请者端点未知（簿记帧未发出——加入 / 拒绝已本地生效）' };
  }
  const payload = wanted === 'approved' || reason === undefined ? {} : { reason };
  const sent = sendTo(state, local.collabId, managerId, endpoint, wanted === 'approved' ? 'approve' : 'decline', payload);
  return { delivered: sent.ok === true, msgId: sent.msgId, reason: sent.reason };
}

/* 决策发帧：先定格 decision（本地状态即真相），再入队；邀请者端点未知给出明确指引。
 * 拒绝原因按协议呈现判据先行校验（超限 / 换行在入队侧会被拒——不得先定格、后静默失败）。 */
function sendDecision(state, local, approve, wanted, reason) {
  const validated = validateDeclineReason(approve ? undefined : reason);
  if (validated.ok !== true) {
    return { ok: false, message: validated.message };
  }
  const endpoint = local.endpoints.get(local.member.manager.instanceId);
  if (endpoint === undefined) {
    return { ok: false, message: '邀请者端点未知（邀请可能不完整）——请重新扫描后请对方重发邀请' };
  }
  local.member.decision = wanted;
  persistMember(state, local);
  const payload = approve || validated.reason === undefined ? {} : { reason: validated.reason };
  const sent = sendTo(state, local.collabId, local.member.manager.instanceId, endpoint, approve ? 'approve' : 'decline', payload);
  state.counters.decisionsSent++;
  return { ok: true, decision: wanted, msgId: sent.msgId };
}

export function withdrawInvite(state, { collabId, target }) {
  const local = state.collabs.get(collabId);
  if (local === undefined || local.role !== 'manager') {
    return { ok: false, message: '只有站长（讨论为发起人）可以撤回邀请' };
  }
  /* 挂起期明确拒绝（与 sendMessage 同一口径）：撤回含台账写 + 通告面，收敛等待中会被
   * 暂停守卫截成半执行（撤回帧已发、台账未变）——待收敛后再试。 */
  if (local.suspended !== null) {
    return { ok: false, message: '协作对外写已暂停（在途抢接或未能对表）——收敛后恢复' };
  }
  if (local.ledger.status !== 'proposed') {
    const hint = local.ledger.status === 'active' ? '协作已建立——结束请用 ws_end_collab' : '当前状态不可撤回';
    return { ok: false, message: hint };
  }
  /* 省略 target = 整条撤回；「已提供但非法」明确拒绝——不得静默归并到最具破坏性的整条撤回路径
   * （服务会被夹具直调，形态把关不能只靠工具层）。 */
  if (target === undefined || target === null) {
    return withdrawAll(state, local);
  }
  const targetId = typeof target === 'string' ? target.trim() : '';
  if (!ID_PATTERN.test(targetId)) {
    return { ok: false, message: 'target 非法（1–64 位字母数字与连字符的实例标识）——整条撤回请省略 target' };
  }
  return withdrawOne(state, local, targetId);
}

export async function sendMessage(state, { collabId, text, type, to }) {
  const local = state.collabs.get(collabId);
  if (local === undefined) {
    return { ok: false, message: '本机没有该协作（先 ws_list_collabs）' };
  }
  if (local.suspended !== null) {
    return { ok: false, message: '协作对外写已暂停（在途抢接或未能对表）——收敛后恢复' };
  }
  if (localModeOf(local) === 'forum') {
    return await sendForumPost(state, local, { text, type, to });
  }
  return sendManagedMessage(state, local, { text, type, to });
}

/* 协作模式的发送路径（星型路由与状态门控；讨论模式的发帖路径见 sendForumPost）。 */
function sendManagedMessage(state, local, { text, type, to }) {
  const messageType = type ?? 'reply';
  const stateName = localStateOf(local);
  if (stateName === 'frozen') {
    return { ok: false, message: '协作已冻结：仅允许读台账 / 裁定 / 退出 / 终止' };
  }
  if (isArchived(stateName)) {
    return { ok: false, message: '协作已结束（或已退出）——不再接受协作域消息' };
  }
  const textRejection = textRejectionOf(messageType, text);
  if (textRejection !== null) {
    return { ok: false, message: textRejection };
  }
  const routed = recipientsOf(state, local, to);
  if (routed.error !== undefined) {
    return { ok: false, message: routed.error };
  }
  if (messageType === 'topic' && local.role === 'manager') {
    mutateLedger(state, local, (ledger) => {
      ledger.topic = text;
    });
  }
  return deliverMessage(state, local, messageType, text, routed.targets);
}

/* 消息文本的服务层预校验（与协议校验器同一权威）：本机入口先行拒绝——绝不让「发送会被拒」
 * 的变更先落本地台账（非法主题会毒化台账行：重载时整行不过形态校验、后续变更静默回滚）。
 * 呈现面类型（topic / stop）按呈现文本判据；其余按正文上限。 */
function textRejectionOf(type, text) {
  const presentationMax = type === 'topic' ? MAX_TOPIC_CHARS : type === 'stop' ? MAX_REASON_CHARS : null;
  if (presentationMax !== null) {
    if (!isPresentationText(text, presentationMax)) {
      return `text 非法：需为非空、≤${presentationMax} 字符、不含换行 / 不可见字符的呈现文本`;
    }
    return null;
  }
  if (typeof text !== 'string' || text.trim() === '' || text.length > MAX_MESSAGE_TEXT_CHARS) {
    return `text 非法：需为非空、≤${MAX_MESSAGE_TEXT_CHARS} 字符`;
  }
  return null;
}

/* 逐目标入队与结果归并（部分成功按成功返回；全部失败给出逐目标原因）。 */
function deliverMessage(state, local, type, text, targets) {
  const payload = payloadOf(type, text);
  const results = targets.map((targetId) => sendToTarget(state, local, type, payload, targetId));
  const delivered = results.filter((entry) => entry.ok === true);
  if (delivered.length === 0) {
    return { ok: false, message: `消息未入队（${results.map((entry) => entry.reason ?? '未知原因').join('；')}）` };
  }
  return {
    ok: true,
    msgId: delivered[0].msgId,
    tier: 'queued',
    to: results.map((entry) => entry.instanceId),
    results,
    note: '已排队（对方离线时后台重试、对方重开后送达；档位可用 ws_delivery_status 查询）',
  };
}

function sendToTarget(state, local, type, payload, targetId) {
  const endpoint = local.endpoints.get(targetId);
  if (endpoint === undefined) {
    return { instanceId: targetId, ok: false, reason: '端点未知（先扫描或等对方联系）' };
  }
  const sent = sendTo(state, local.collabId, targetId, endpoint, type, payload);
  return { instanceId: targetId, ok: sent.ok === true, msgId: sent.msgId, reason: sent.reason };
}

/* 讨论模式发帖（设计 §5.2）：to 一律拒绝（讨论不设定向）；kind 按徽标词表、text 沿消息文本
 * 上限（不走 topic/stop 的呈现限制、不触发 task 的 taskId 分支）；先本地落列（postId / 序号 /
 * ts 分配即定）再按路由投递——帖的事务点在本机列表，投递失败不回滚（收敛由拉取兜底）。
 * 帖不进会话注入以外的任何元状态面：topic 帖亦按普通帖处理（主题创建时定死）。
 * 路由 = 中继分发（默认）/ 直接扇出（中继本机）/ 降级直投（中继不可达或未知，见 routeForumPost）。 */
async function sendForumPost(state, local, { text, type, to }) {
  const routedTo = typeof to === 'string' ? to.trim() : to ?? '';
  if (routedTo !== '') {
    return { ok: false, message: '讨论不设定向消息（to 参数一律拒绝）——发言即广播，移除 to 后重试' };
  }
  const kind = type ?? 'reply';
  if (typeof kind !== 'string' || !POST_KINDS.includes(kind)) {
    return { ok: false, message: `消息类型非法：可选值为 ${POST_KINDS.join(' / ')}（缺省 reply）` };
  }
  if (isArchived(localStateOf(local))) {
    return { ok: false, message: '讨论已结束（或已终止）——不再接受新帖' };
  }
  /* 发帖是成员行为：本机未加入（仅受邀）不发帖——发出去也无人收（扇出按折叠成员表）。 */
  if (!selfJoinedOf(local, state.self.instanceId)) {
    return { ok: false, message: '本机尚未加入该讨论（等待邀请或先回应邀请）——加入后才能发言' };
  }
  const textRejection = textRejectionOf('reply', text);
  if (textRejection !== null) {
    return { ok: false, message: textRejection };
  }
  const post = allocateOwnPost(state, local, kind, text);
  const routed = await routeForumPost(state, local, post);
  state.counters.postsSent++;
  return {
    ok: true,
    postId: post.postId,
    seq: post.seq,
    ts: post.ts,
    route: routed.route,
    to: routed.results.map((entry) => entry.instanceId),
    results: routed.results,
    note: routed.note,
  };
}

/* —— 讨论的中继分发（设计 §5.2/§9.1：中继 = 发起人，无选举无迁移） —— */

/* 帖载荷构造（直接扇出 / 投稿 / 转达三处共用）：只取帖形态四字段，不夹带来源帧其它字段。 */
function postPayloadOf(post) {
  return { post: { postId: post.postId, seq: post.seq, kind: post.kind, text: post.text } };
}

/* 本机是否即该讨论的中继（发起人）——中继转达的前提判据（成员侧不转达）。 */
export function selfIsRelay(state, local) {
  return relayPeerOf(local, state.self)?.instanceId === state.self.instanceId;
}

/* 发帖路由（设计 §5.2 降级/恢复闭环）：成员发帖 → 发中继；中继自帖 → 直接扇出；
 * 中继不可达（拨号失败/探测不可达）→ 当场降级＝本次即走直投，并置降级态等待后台恢复检测。
 * 降级态由周期对表 tick 的恢复检测清除（checkRelayRecovery）；两态各有计数可观测。
 * 探测面缺失（未注入）时以投稿受理结果为判据：受理被拒则本次直投（不置降级态——
 * 「受理被拒」不等于不可达，可能是形态/端点类拒绝）。
 * 档位口径（设计 §5.2「面向最终成员」）：作者→中继段走既有直投回执（「已到对方驿站」=
 * 投稿达中继；「已投进对方会话」= 中继侧会话收到），成员级送达结果留在中继侧投递记录里——
 * 作者侧不把「达中继」当成「达成员」，未达者如实呈现「待对表收敛」；到会话 ≠ 已读。 */
async function routeForumPost(state, local, post) {
  const relay = relayPeerOf(local, state.self);
  if (relay === null) {
    return degradedRoute(state, local, post, '中继未知（发起人标识尚未学到）——先直投，待邀请/对表补学后自动回中继');
  }
  if (relay.instanceId === state.self.instanceId) {
    return {
      route: 'fanout',
      results: fanOutPost(state, local, post),
      note: '已直接扇出（本机即中继）——在线尽力 + 短重试，不落持久队列；未达者由对方周期对表拉取收敛',
    };
  }
  const fallback = relayFallbackReason(state, local, relay);
  if (fallback !== null) {
    return degradedRoute(state, local, post, fallback);
  }
  const endpoint = endpointFor(state, local, relay.instanceId);
  const verdict = await relayVerdict(state, endpoint);
  if (verdict.ok !== true) {
    state.relayDown.add(local.collabId);
    state.counters.relayDegrades++;
    return degradedRoute(state, local, post, `${verdict.reason}——已当场降级直投`);
  }
  const submitted = submitToRelay(state, local, relay, endpoint, post);
  if (submitted.ok === true) {
    state.counters.relayPostsSent++;
    return {
      route: 'relay',
      results: [submitted],
      note: `已发中继（发起人 ${relay.identityName}）——成员级投递结果由中继聚合捎回（尽力而为）；离线成员待对表收敛；「已投进对方会话」≠ 已读`,
    };
  }
  return degradedRoute(state, local, post, `投稿未受理（${submitted.reason}）`);
}

/* 不走中继的常态判据（返回原因文案；null = 走中继路径）：发起人已退出（永久放弃中继职责，
 * 非错误——直投 + 对表收敛兜底照常送达）或降级态（上次探测不可达；避免每帖重复探测，
 * 等周期对表 tick 的恢复检测切回）。 */
function relayFallbackReason(state, local, relay) {
  if (relayDepartedOf(local, relay.instanceId)) {
    return '发起人已退出讨论（永久放弃中继职责）——直投兜底';
  }
  if (state.relayDown.has(local.collabId)) {
    return '中继降级中（上次探测不可达）——直投，待恢复检测切回';
  }
  return null;
}

/* 中继可达性判定：端点未知即不可达（跳过不静默——不得静默死等，未达者由对方对表追平）；
 * 有探测面则探测，无探测面时放行至投稿受理（唯一可用信号）。 */
async function relayVerdict(state, endpoint) {
  if (endpoint === undefined) {
    state.counters.relayEndpointUnknown++;
    return { ok: false, reason: '中继端点未知' };
  }
  if (typeof state.probe !== 'function') {
    return { ok: true };
  }
  const result = await probeRelay(state, endpoint);
  if (result.reachable === true) {
    return { ok: true, rttMs: result.rttMs };
  }
  return { ok: false, reason: `中继探测不可达（${result.reason ?? '未知原因'}）` };
}

/* 中继探测出口（注入的 probe；统一包一层——异常一律归「不可达」，与失联判定的探测口径一致）。 */
async function probeRelay(state, endpoint) {
  try {
    return await state.probe(endpoint.address, endpoint.port);
  } catch (error) {
    return { reachable: false, reason: `探测异常：${error?.message ?? '未知原因'}` };
  }
}

/* 投稿提交（成员 → 中继）：payload.relay 标记即「投稿转发」的识别形态（中继据此扇出转达；
 * 接收端既有（作者, postId）去重与显示不受影响——帖形态四字段原样）。 */
function submitToRelay(state, local, relay, endpoint, post) {
  if (typeof state.sendDirect !== 'function') {
    state.counters.postFanoutSkipped++;
    return { instanceId: relay.instanceId, ok: false, reason: '直投面不可用（发送注入缺失）——待对表收敛' };
  }
  const sent = state.sendDirect({
    collabId: local.collabId,
    to: { instanceId: relay.instanceId, address: endpoint.address, port: endpoint.port },
    type: 'post',
    payload: { ...postPayloadOf(post), relay: true },
    createdAt: post.ts,   // 帧 ts 随帖携带（接收端显示序与作者内序的依据）
  });
  return { instanceId: relay.instanceId, ok: sent.ok === true, msgId: sent.msgId, reason: sent.reason };
}

/* 降级直投一帖（设计 §5.2「当场降级=对全成员直投」，复用既有直投通道）：帖已落本机列表，
 * 直投对端点已知成员逐份发出；未达者由对表收敛。两态可观测：降级帖计数 + 结果逐目标标注。 */
function degradedRoute(state, local, post, reason) {
  state.counters.relayDegradedPosts++;
  return {
    route: 'degraded',
    results: fanOutPost(state, local, post),
    note: `中继未用（${reason}）——已直投全体成员（在线尽力 + 短重试）；未达者由对方周期对表拉取收敛`,
  };
}

/* 投稿转达（中继侧，设计 §5.2）：中继收到投稿 → 对折叠成员表逐成员直投一份（除本机与原作者
 * ——作者已持该帖），转达帧 from 保原作者、随带 originMsgId（转达副本的既有判别面：接收端据此
 * 不做端点学习、投递回报沿原路回执）、ts 取原帖帧 ts（接收端以帧 ts 落条目——显示序跨副本
 * 一致的前提）。端点未知者跳过并计入 relayFanoutSkipped（跳过不静默、不阻塞其余目标——对方经
 * 周期对表追平）。**降级期经直投已到中继的副本不再转达**（设计留白两可项的实现选定）：
 * 投稿标记（payload.relay）是唯一转达触发——直投副本与转达目标重叠，再转达只增重复流量，
 * 漏者由对表兜底。 */
export function relayRedistribute(state, local, frame) {
  state.counters.relayRedistributed++;
  if (typeof state.sendDirect !== 'function') {
    state.counters.postFanoutSkipped++;   // 转达面缺失同帖直投面口径（计数留痕、不静默）
    return 0;
  }
  const origin = { instanceId: frame.from.instanceId, identityName: frame.from.identityName, port: frame.from.port };
  let relayed = 0;
  for (const entry of forumRecipientsOf(state, local)) {
    if (entry.instanceId === frame.from.instanceId) {
      continue;   // 原作者已持该帖
    }
    const endpoint = endpointFor(state, local, entry.instanceId);
    if (endpoint === undefined) {
      state.counters.relayFanoutSkipped++;
      continue;
    }
    const sent = state.sendDirect({
      collabId: local.collabId,
      to: { instanceId: entry.instanceId, address: endpoint.address, port: endpoint.port },
      type: 'post',
      payload: { ...postPayloadOf(frame.payload.post), originMsgId: frame.msgId },
      createdAt: frame.ts,
      from: origin,
    });
    if (sent.ok === true) {
      relayed++;
    }
  }
  return relayed;
}

/* 后台恢复检测（设计 §5.2：恢复检测通过后自动回中继路径）：由周期对表 tick 顺带执行
 * （每轮对表先探一次）——降级态下探测中继，可达即清除降级态并计数，下一帖回中继路径。
 * 探测面缺失或中继端点未知 → 保持降级（无从判定；服务重启后按中继路径重试）。 */
export async function checkRelayRecovery(state, local) {
  if (!state.relayDown.has(local.collabId)) {
    return false;
  }
  const relay = relayPeerOf(local, state.self);
  if (relay === null || typeof state.probe !== 'function') {
    return false;
  }
  const endpoint = endpointFor(state, local, relay.instanceId);
  if (endpoint === undefined) {
    return false;
  }
  const result = await probeRelay(state, endpoint);
  if (result.reachable !== true) {
    return false;
  }
  state.relayDown.delete(local.collabId);
  state.counters.relayRecoveries++;
  state.log.info('中继恢复可达——投递切回中继路径', { collabId: local.collabId, relay: relay.instanceId });
  return true;
}

/* 聚合捎回（设计 §5.2「成员级投递结果由中继聚合捎回」）：中继把「某成员会话已收到某转达副本」
 * 的既有第三档回报译回原作者——以既有 delivery-status 帧（refMsgId = 原投稿帧 msgId、
 * tier = session）经既有可靠发送面（入队重试）发给原作者；作者侧按既有回报机制幂等吸收
 * （重复回报无副作用、不产生第二帧）。触发点在网层回报路径的首次跃迁（net/dispatch 的注入面），
 * 本函数只做寻址与发送，尽力而为：端点未知跳过并计数（不臆造地址——沿用既有教训口径）、
 * 入队失败只计数告警（sendTo 已留痕），异常一律隔离——绝不影响回报主链。 */
export function applyRelayedReport(state, { collabId, originMsgId, author }) {
  try {
    const local = state.collabs.get(collabId);
    if (local === undefined || localModeOf(local) !== 'forum') {
      return;   // 非本机在册协作 / 非讨论实例：不臆造（防御面；帖转达副本只出现在讨论）
    }
    const endpoint = endpointFor(state, local, author.instanceId);
    if (endpoint === undefined) {
      state.counters.relayReportSkipped++;
      return;
    }
    const sent = sendTo(state, collabId, author.instanceId, endpoint, 'delivery-status', { refMsgId: originMsgId, tier: 'session' });
    if (sent.ok === true) {
      state.counters.relayReportSent++;
    } else {
      state.counters.relayReportFailed++;
    }
  } catch (error) {
    state.counters.relayReportFailed++;
    state.log.warn('聚合回报发送异常（已隔离）', { collabId, reason: error?.message });
  }
}

/* 帖分配与本地落列（设计 §5.2）：postId 一次生成、序号严格递增、ts 强制单调——
 * 回拨时取 max(上一条 ts + 1ms, now)；三者以本机已落列表的该作者基线为准，落列即定。 */
function allocateOwnPost(state, local, kind, text) {
  const baseline = local.posts.ownBaseline(state.self.instanceId);
  const nowMs = Date.now();
  const monotonicMs = baseline.ts === null ? nowMs : Math.max(Date.parse(baseline.ts) + 1, nowMs);
  const post = { postId: newPostId(), seq: (baseline.seq ?? 0) + 1, ts: new Date(monotonicMs).toISOString(), kind, text };
  local.posts.append({
    entryId: post.postId,
    seq: post.seq,
    ts: post.ts,
    from: { instanceId: state.self.instanceId, identityName: state.self.identityName },
    kind,
    text,
  });
  return post;
}

/* 直投扇出：对折叠成员表逐成员直发一份（除本机）——不走持久队列、无逐帖排队；
 * 端点未知者如实记「待对表收敛」，由对方周期拉取兜底。 */
function fanOutPost(state, local, post) {
  const results = [];
  for (const entry of forumRecipientsOf(state, local)) {
    results.push(deliverPostTo(state, local, entry.instanceId, post));
  }
  return results;
}

/* 帖的收件人 = 折叠成员表（除本机）：被拒 / 被撤回 / 已退出者不收帖——成员语义的单一取数面
 * （名单口径含 invited 的临时形态就此勘正——被拒/被撤回/已退出者不收帖）。 */
function forumRecipientsOf(state, local) {
  return foldedMembersOf(local).filter((entry) => entry.instanceId !== state.self.instanceId);
}

function deliverPostTo(state, local, instanceId, post) {
  if (typeof state.sendDirect !== 'function') {
    state.counters.postFanoutSkipped++;
    return { instanceId, ok: false, reason: '直投面不可用（发送注入缺失）——待对表收敛' };
  }
  const endpoint = endpointFor(state, local, instanceId);
  if (endpoint === undefined) {
    return { instanceId, ok: false, reason: '端点未知——待对表收敛' };
  }
  const sent = state.sendDirect({
    collabId: local.collabId,
    to: { instanceId, address: endpoint.address, port: endpoint.port },
    type: 'post',
    payload: { post: { postId: post.postId, seq: post.seq, kind: post.kind, text: post.text } },
    createdAt: post.ts,   // 帧 ts 随帖携带（作者侧强制单调的落盘 ts，接收端显示序与作者内序的依据）
  });
  return { instanceId, ok: sent.ok === true, msgId: sent.msgId, reason: sent.reason };
}

export function endCollab(state, { collabId }) {
  const local = state.collabs.get(collabId);
  if (local === undefined || local.role !== 'manager') {
    /* 讨论的发起人 = 本机 manager 记录（role 创建时定死）；非发起人（成员记录）一律拒绝并给
     * 替代动作——成员想离开讨论走 ws_leave_collab（设计 §6「结束权归发起人」）。 */
    const message = local !== undefined && localModeOf(local) === 'forum'
      ? '只有发起人可以结束讨论（结束权归发起人）——成员退出请用 ws_leave_collab'
      : '只有站长席位可以结束协作';
    return { ok: false, message };
  }
  /* 讨论的发起人退出即放弃结束权（设计 §6）：本机已退出该讨论 → end 不再受理（状态面）。 */
  if (local.member.state === 'left') {
    return { ok: false, message: '本机已退出该讨论——发起人退出即放弃结束权（讨论存续，结束不再受理）' };
  }
  /* 挂起期明确拒绝（与 sendMessage 同一口径）：收敛等待中的结束会半执行——台账写被暂停守卫
   * 拦下，成员记录与通告却照发，产出「成员已归档、站长仍活跃」的僵尸协作。 */
  if (local.suspended !== null) {
    return { ok: false, message: '协作对外写已暂停（在途抢接或未能对表）——收敛后恢复' };
  }
  const status = local.ledger.status;
  if (status === 'proposed') {
    return { ok: false, message: '协作尚未建立——取消请用 ws_withdraw_invite（整条撤回）' };
  }
  if (status !== 'active' && status !== 'frozen') {
    return { ok: false, message: '协作已结束（或已终止）' };
  }
  mutateLedger(state, local, (ledger) => {
    ledger.status = 'completed';
    ledger.endedAt = new Date().toISOString();
  });
  local.member.state = 'completed';
  local.member.archivedAt = new Date().toISOString();
  persistMember(state, local);
  local.mute.clear();
  stopJoinReplay(state, local);
  broadcastCollabEnd(state, local, collabId);   // 双通道之一：在线广播（豁免 TTL/上限）
  state.counters.ended++;
  return { ok: true };
}

/* 结束广播（设计 §5.5 控制事件类；end 豁免 TTL/上限）：讨论经折叠成员表出口（端点未知者
 * 跳过计数），managed 沿既有名册出口（仅端点已知者，快照与通告兜底可见性）。 */
function broadcastCollabEnd(state, local, collabId) {
  if (localModeOf(local) === 'forum') {
    broadcastToForumMembers(state, local, 'end', {});
    return;
  }
  for (const instanceId of memberIdsOf(state, local)) {
    const endpoint = local.endpoints.get(instanceId);
    if (endpoint !== undefined) {
      sendTo(state, collabId, instanceId, endpoint, 'end', {});
    }
  }
}

export function leaveCollab(state, { collabId }) {
  const local = state.collabs.get(collabId);
  if (local === undefined) {
    return { ok: false, message: '本机没有该协作' };
  }
  if (localModeOf(local) === 'forum') {
    return leaveForum(state, local);
  }
  if (local.role === 'manager') {
    return { ok: false, message: '站长席位不可退出——请先结束协作（显式交接属治理事项）' };
  }
  if (isLocalArchivedState(local)) {
    return { ok: false, message: '协作已结束（或已退出）' };
  }
  const managerId = local.member.manager.instanceId;
  const endpoint = local.endpoints.get(managerId);
  if (endpoint !== undefined) {
    sendTo(state, collabId, managerId, endpoint, 'leave', {});
  }
  local.member.state = 'left';
  local.member.archivedAt = new Date().toISOString();
  persistMember(state, local);
  local.mute.clear();
  state.counters.left++;
  return { ok: true, delivered: endpoint !== undefined };
}

/* 讨论退出（设计 §5.4/§6/§9.1）：leave 事件照走（自播广播、豁免 TTL/上限）；**发起人同普通成员**
 * ——退出即放弃结束权与中继职责（中继无迁移：退出后讨论进入无中继直投、无人可 end 的自然消亡
 * 形态；结束权守卫在 endCollab，本机归档后调用被拒属状态面）。退出后讨论存续；本机归档，不再对表与重播。 */
function leaveForum(state, local) {
  if (isLocalArchivedState(local)) {
    return { ok: false, message: '讨论已结束（或已退出）' };
  }
  stopJoinReplay(state, local);
  const event = emitOwnMemberEvent(state, local, 'leave');
  if (event !== null) {
    state.counters.forumLeavesOut++;
  }
  const delivered = event === null ? 0 : broadcastMemberEvent(state, local, 'leave', event);
  local.member.state = 'left';
  local.member.archivedAt = new Date().toISOString();
  persistMember(state, local);
  local.mute.clear();
  state.counters.left++;
  return { ok: true, delivered, eventId: event?.eventId ?? null };
}

export async function viewLedger(state, { collabId }) {
  const local = state.collabs.get(collabId);
  if (local === undefined) {
    return { ok: false, message: '本机没有该协作（先 ws_list_collabs）' };
  }
  if (localModeOf(local) === 'forum') {
    return forumViewOf(local);
  }
  if (local.role === 'manager') {
    return { ok: true, source: 'local', version: local.ledger.version, archived: isArchived(local.ledger.status), ledger: local.ledger };
  }
  const archived = isLocalArchivedState(local);
  const managerId = local.member.manager.instanceId;
  const endpoint = local.endpoints.get(managerId);
  if (!archived && endpoint !== undefined) {
    sendTo(state, collabId, managerId, endpoint, 'snapshot', { kind: 'request' });
    const live = await waitForSnapshot(state, collabId);
    if (live !== null) {
      return { ok: true, source: 'live', version: live.version, ledger: live.ledger };
    }
  }
  const stored = local.snapshot;
  if (stored !== null) {
    return { ok: true, source: 'snapshot', version: stored.version, note: `快照，版本 ${stored.version}，可能非最新`, archived, ledger: stored.ledger };
  }
  return { ok: false, message: archived ? '协作已归档且本机无可用快照' : '站长离线且本机无快照——没有可读台账' };
}

/* 讨论的本地合并视图（设计 §7 工具面）：本地帖子列表（显示序）+ 折叠成员表 + 端点 + 主题——
 * 标注「本地视图，未与全员核对」（收敛由各节点周期对表推进，本机副本可能暂时落后）；
 * 不向任何成员拉取（拉取机制属对表链路）。 */
function forumViewOf(local) {
  return {
    ok: true,
    mode: 'forum',
    source: 'local',
    archived: isLocalArchivedState(local),
    note: '本地视图，未与全员核对——收敛由各节点周期对表推进，本机副本可能暂时落后',
    name: localNameOf(local),
    topic: localTopicOf(local),
    state: localStateOf(local),
    members: foldedMembersOf(local),
    endpoints: Object.fromEntries(local.endpoints),
    posts: displayOrderOf(local.posts.entries()),
  };
}

/* 在线拉取的等待面：回应经接收管线到达（快照接收路径统一 resolve）；超时按快照回退。
 * 等待面按协作持列表——并发 view 各自解挂（先到者不被后来者顶掉、定时器到期只摘自己）；
 * 定时器保持引用（等待面是调用链的一环，事件循环留存至判定完成），服务 close 时统一清理。 */
function waitForSnapshot(state, collabId) {
  return new Promise((resolve) => {
    const waiter = {
      resolve,
      timer: setTimeout(() => {
        dropSnapshotWaiter(state, collabId, waiter);
        resolve(null);
      }, state.ledgerFetchTimeoutMs),
    };
    const held = state.pendingViews.get(collabId);
    if (held === undefined) {
      state.pendingViews.set(collabId, [waiter]);
    } else {
      held.push(waiter);
    }
  });
}

function dropSnapshotWaiter(state, collabId, waiter) {
  const held = state.pendingViews.get(collabId);
  if (held === undefined) {
    return;
  }
  const rest = held.filter((candidate) => candidate !== waiter);
  if (rest.length === 0) {
    state.pendingViews.delete(collabId);
  } else {
    state.pendingViews.set(collabId, rest);
  }
}

/* 台账变更的统一入口（单写者纪律）：打补丁 → version 自增 → updatedAt → 落盘 → 推快照。
 * 补丁函数直接改写台账字段（调用方可借闭包引用名单条目）；推快照失败不影响本地状态。
 * 暂停守卫：本机进入收敛等待（在途抢接 / 未对表）时拒绝一切非治理写——治理动作（冻结 / 解冻 /
 * 裁定执行 / 席位恢复）经 options.governance 放行：收敛本身依赖这些写入，暂停不得阻断收敛。
 * 讨论实例不推快照（设计 §5.5 讨论内 snapshot 弃用；成员状态经 bundle 元状态与事件集收敛）。 */
export function mutateLedger(state, local, apply, options = {}) {
  if (local.suspended !== null && options.governance !== true) {
    state.counters.mutationSuspended++;
    state.log.warn('协作写被暂停（收敛等待中）', { collabId: local.collabId, reason: local.suspended.reason });
    return null;
  }
  apply(local.ledger);
  local.ledger.version++;
  local.ledger.updatedAt = new Date().toISOString();
  persistLedger(state, local);
  state.counters.ledgerMutations++;
  if (localModeOf(local) !== 'forum') {
    pushSnapshot(state, local);
  }
  return local.ledger;
}

/* 快照推送（设计 §8）：每次台账变更推全体成员（除本机）——端点已知者入可靠队列；
 * 端点未知者计数跳过（成员从未联系过站长席位的窗口）。站长席位同步留存自身最近快照。
 * 载荷冻结：帧在调度侧才序列化（入队落盘与上线各一次），活引用会让「摘要 ↔ 内容」分叉——
 * 台账被后续变更改写后，先入队的帧会以「摘要不符」被接收侧丢弃（本函数先深拷贝再入队）。 */
export function pushSnapshot(state, local) {
  const frozen = structuredClone(local.ledger);
  local.snapshot = {
    version: frozen.version,
    digest: ledgerDigest(frozen),
    receivedAt: new Date().toISOString(),
    from: { instanceId: state.self.instanceId, identityName: state.self.identityName },
    ledger: frozen,
  };
  persistSnapshot(state, local);
  for (const member of local.ledger.members) {
    if (member.instanceId === state.self.instanceId) {
      continue;
    }
    const endpoint = local.endpoints.get(member.instanceId);
    if (endpoint === undefined) {
      state.counters.snapshotSkipped++;
      continue;
    }
    sendTo(state, local.collabId, member.instanceId, endpoint, 'snapshot', { kind: 'data', version: frozen.version, digest: local.snapshot.digest, ledger: frozen });
    state.counters.snapshotSent++;
  }
}

/* 发送包装（注入的 dispatch.send 的统一入口）：结果只计数不抛出——协作操作不因单条入队失败而回滚。
 * options.from：转达帧的原发身份（治理转达原样携带发起者 from——身份语义定义在 from 上，
 * 不得改写为转达者；普通发送不携带，由发送侧以本机身份盖章）。 */
export function sendTo(state, collabId, instanceId, endpoint, type, payload, options = {}) {
  const message = { collabId, to: { instanceId, address: endpoint.address, port: endpoint.port }, type, payload };
  if (options.from !== undefined) {
    message.from = options.from;
  }
  const result = state.send(message);
  if (result.ok === true) {
    state.counters.messagesSent++;
    return result;
  }
  state.counters.sendFailures++;
  state.log.warn('协作消息入队失败', { collabId, type, to: instanceId, reason: result.reason });
  return result;
}

/* 治理寻址（跨协作回退）：协作内端点表优先；未学到时回退站点级已知主机清单（含其他协作与
 * 发现链路学到的「实例标识 → 地址:端口」）——治理转达 / 席位转移的触达由此不局限于单一协作的
 * 直接接触史（设计 §5 清单随协作参与关系更新的治理消费面）。未见过返回 undefined（调用方跳过）。 */
export function endpointFor(state, local, instanceId) {
  const held = local.endpoints.get(instanceId);
  if (held !== undefined) {
    return held;
  }
  if (typeof state.knownHosts?.lookup !== 'function') {
    return undefined;
  }
  const fallback = state.knownHosts.lookup(instanceId);
  return fallback ?? undefined;
}

/* 发给协作名册中全部已知端点的参与者（除本机与被排除者）：治理广播（抢接 / 裁定 / 握手 /
 * 席位变更通告）的统一出口；端点未知者跳过——可见性由转达与对等回执机制兜底（设计 §9 步骤 1/5）。 */
export function sendToRoster(state, local, type, payload, options = {}) {
  const exclude = options.exclude ?? new Set();
  let sent = 0;
  for (const entry of localRosterOf(local)) {
    const instanceId = entry.instanceId;
    if (instanceId === state.self.instanceId || exclude.has(instanceId)) {
      continue;
    }
    const endpoint = endpointFor(state, local, instanceId);
    if (endpoint === undefined) {
      state.counters.rosterSkipped++;   // 治理触达不可及的观测面（跳过不静默）
      continue;
    }
    const result = sendTo(state, local.collabId, instanceId, endpoint, type, payload);
    if (result.ok === true) {
      sent++;
    }
  }
  return sent;
}

/* —— 讨论的成员事件广播与 join 未收敛重播 —— */

/* 成员事件广播（join / leave；设计 §5.4）：发给群体可达面（折叠成员表 ∪ 邀请者引用 ∪
 * 端点表已知者）中端点已知者与应用层广播豁免（豁免 TTL/上限）。 */
export function broadcastMemberEvent(state, local, type, event) {
  return broadcastToForumMembers(state, local, type, { eventId: event.eventId, ts: event.ts });
}

/* 讨论控制事件广播出口（join / leave / end 共用）：群体可达面（折叠成员表 ∪ 邀请者引用 ∪
 * 端点表已知者，见 local.forumReachIdsOf）——新成员刚加入时折叠表只有自己，只发邀请者会让
 * 邀请者离线即隔离新人（设计 §5.1「被邀者据此取得入群所需的成员与寻址信息」的落点）。 */
export function broadcastToForumMembers(state, local, type, payload) {
  let sent = 0;
  for (const instanceId of forumReachIdsOf(local, state.self.instanceId)) {
    const endpoint = endpointFor(state, local, instanceId);
    if (endpoint === undefined) {
      state.counters.forumBroadcastSkipped++;
      continue;
    }
    const result = sendTo(state, local.collabId, instanceId, endpoint, type, payload);
    if (result.ok === true) {
      sent++;
    }
  }
  return sent;
}

/* join 未收敛重播（设计 §5.4 防幽灵成员）：同一事件原样重发（事件 id 幂等并集吸收）、
 * 递增间隔有界（每轮至多 intervals.length 次）；确认（对表拉回的成员表含自己）或退出即停，
 * 每轮对表若仍未收敛则由收敛判定重新起一轮。 */
export function startJoinReplay(state, local, event) {
  if (state.joinReplays.has(local.collabId)) {
    return false;   // 一轮在跑：不叠加（防风暴）
  }
  state.joinReplays.set(local.collabId, { timer: null, attempts: 0 });
  state.counters.joinReplays++;
  broadcastMemberEvent(state, local, 'join', event);
  scheduleJoinReplayStep(state, local, event, 0);
  return true;
}

function scheduleJoinReplayStep(state, local, event, step) {
  const intervals = state.joinReplayIntervalsMs;
  if (step >= intervals.length) {
    state.joinReplays.delete(local.collabId);
    return;
  }
  const timer = setTimeout(() => {
    const held = state.joinReplays.get(local.collabId);
    if (held === undefined || held.timer !== timer) {
      return;
    }
    held.timer = null;
    held.attempts = step + 1;
    state.counters.joinReplays++;
    broadcastMemberEvent(state, local, 'join', event);
    scheduleJoinReplayStep(state, local, event, step + 1);
  }, intervals[step]);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  const held = state.joinReplays.get(local.collabId);
  if (held !== undefined) {
    held.timer = timer;
  }
}

/* 重播停止（已收敛 / 退出 / 结束 / 服务关闭）：清除挂起定时器。 */
export function stopJoinReplay(state, local) {
  const held = state.joinReplays.get(local.collabId);
  if (held === undefined) {
    return false;
  }
  if (held.timer !== null) {
    clearTimeout(held.timer);
  }
  state.joinReplays.delete(local.collabId);
  return true;
}

export function stopJoinReplays(state) {
  for (const held of state.joinReplays.values()) {
    if (held.timer !== null) {
      clearTimeout(held.timer);
    }
  }
  state.joinReplays.clear();
}

/* 治理转达目标集：名册中全部端点可寻址的参与者（除本机与来源由 relayGovernance 过滤）；
 * 逐目标归属的本地协作信息供转达帧寻址。 */
export function governanceTargets(state, local) {
  const targets = new Map();
  for (const entry of localRosterOf(local)) {
    const endpoint = endpointFor(state, local, entry.instanceId);
    if (endpoint !== undefined) {
      targets.set(entry.instanceId, { address: endpoint.address, port: endpoint.port, collabId: local.collabId });
    }
  }
  return targets;
}

/* 治理转达（设计 §10 治理类例外）：逐目标独立入队——防环与防重复由 originMsgId 已转达集承载
 * （同 originMsgId 的重复副本不再向外扩散；发送队列以 msgId 为唯一键，多目标无法共用同一 msgId）。
 * targets：Map<instanceId, { address, port, collabId }>（逐目标归属的本地协作）。 */
export function relayGovernance(state, frame, targets) {
  const origin = typeof frame.payload.originMsgId === 'string' && frame.payload.originMsgId !== '' ? frame.payload.originMsgId : frame.msgId;
  if (state.relayedOrigins.has(origin)) {
    return 0;
  }
  rememberRelayedOrigin(state, origin);
  /* 转达原样携带原发身份（设计 §9）：帧的 from 是候选人 / 站长的权威身份——改写为转达者会让
   * 接收方把转达者当作新站长（身份归因错位）；只取协议定义的三字段，不夹带来源帧其它字段。 */
  const originFrom = { instanceId: frame.from.instanceId, identityName: frame.from.identityName, port: frame.from.port };
  let relayed = 0;
  for (const [instanceId, target] of targets) {
    if (instanceId === state.self.instanceId || instanceId === frame.from.instanceId) {
      continue;
    }
    const result = sendTo(state, target.collabId, instanceId, { address: target.address, port: target.port }, frame.type, { ...frame.payload, originMsgId: origin }, { from: originFrom });
    if (result.ok === true) {
      relayed++;
    }
  }
  return relayed;
}

/* 已转达集登记（插入序淘汰——表满丢最旧）。 */
export function rememberRelayedOrigin(state, origin) {
  state.relayedOrigins.delete(origin);
  state.relayedOrigins.set(origin, Date.now());
  while (state.relayedOrigins.size > RELAYED_ORIGINS_MAX) {
    const oldest = state.relayedOrigins.keys().next().value;
    state.relayedOrigins.delete(oldest);
  }
}

/* 冻结广播（设计 §6）：发给涉及两条协作的全部已知端点（除本机）——被冻那条的成员端点 ∪
 * 同名交集协作的成员端点；端点未知者跳过（转达与快照机制兜底可见性）。
 * 站长席位侧检出时随带被冻条的发起时间与站长（合流并集与保留方判定的参考数据；
 * 成员侧检出无从提供——接收侧按数据缺省保守处理）。 */
export function broadcastFreeze(state, frozenLocal, reason) {
  const payload = {
    name: localNameOf(frozenLocal),
    members: localRosterOf(frozenLocal).map((entry) => ({ instanceId: entry.instanceId, identityName: entry.identityName })),
    reason,
  };
  if (frozenLocal.role === 'manager') {
    payload.createdAt = frozenLocal.ledger.createdAt;
    payload.manager = { instanceId: frozenLocal.ledger.manager.instanceId, identityName: frozenLocal.ledger.manager.identityName };
  }
  let sent = 0;
  for (const [instanceId, endpoint] of collectFreezeTargets(state, frozenLocal)) {
    const result = sendTo(state, frozenLocal.collabId, instanceId, endpoint, 'freeze', payload);
    if (result.ok === true) {
      sent++;
    }
  }
  return sent;
}

/* 本地冻结：站长席位冻台账（version 推进 + 快照）、成员冻本地记录；已冻结或迁移不允许时幂等返回 false。
 * 冻结标记（frozenAt / frozenFrom）随冻结写入——48 小时无裁定提示与「回冻结前状态」的依据。 */
export function applyFreezeLocally(state, local, reason) {
  if (localStateOf(local) === 'frozen') {
    return false;
  }
  const now = new Date().toISOString();
  if (local.role === 'manager') {
    if (!canTransition(local.ledger.status, 'frozen', localModeOf(local))) {
      return false;
    }
    const from = local.ledger.status;
    mutateLedger(state, local, (ledger) => {
      ledger.status = 'frozen';
      ledger.frozenAt = now;
      ledger.frozenFrom = from;
    }, { governance: true });
  } else {
    const from = local.member.state;
    local.member.state = 'frozen';
    local.member.frozenAt = now;
    local.member.frozenFrom = memberStateFor(from);
    persistMember(state, local);
  }
  state.log.warn('协作已冻结（同名并发冲突）', { collabId: local.collabId, reason });
  return true;
}

/* manager 记录视角的可投递成员标识（除本机；终态成员——被拒 / 被撤回 / 已退出——不投消息）：
 * 消息广播与通告的收件人集合；提议中协作的「未回应」成员也在集内（提议中亦可沟通）。 */
export function memberIdsOf(state, local) {
  if (local.role !== 'manager') {
    return [];
  }
  return local.ledger.members
    .filter((entry) => entry.instanceId !== state.self.instanceId && MESSAGING_MEMBER_STATES.includes(entry.state))
    .map((entry) => entry.instanceId);
}

/* 非归档协作数（发现层 getCollabCount 的计数口径：提议中 / 进行中 / 冻结）。 */
export function countLiveCollabs(state) {
  let count = 0;
  for (const local of state.collabs.values()) {
    if (!isLocalArchivedState(local)) {
      count++;
    }
  }
  return count;
}

/* 席位转移原语（接管生效 / 移交受让共用）：以给定台账担任站长席位——本地记录转站长、
 * 台账落盘（本机成为单一写者）、自身留存并推送当前视图（成员由此学习新站长端点）。 */
export function promoteToManager(state, local, ledger) {
  syncRosterRoles(ledger);
  /* 席位变更（受让 / 接管）作废本机关于他方候选的生效抢接记录（指向本机自身的新记录
   * 由抢接生效路径随后登记）——陈旧记录继续随握手外传会让对手方按已翻页的席位收敛。 */
  invalidateEffectiveTakeovers(state, local, state.self.instanceId);
  local.role = 'manager';
  local.ledger = ledger;
  local.member = managerRecordOf(ledger);
  local.member.endpoints = Object.fromEntries(local.endpoints);
  local.member.managerSinceVersion = ledger.version;   // 席位时钟：本次席位变更的台账基准版本
  local.suspended = null;
  local.staleManagerId = null;
  persistMember(state, local);
  persistLedger(state, local);
  pushSnapshot(state, local);
}

/* 席位变更后的名册角色同步：台账 manager 与 members[].role 恒一致——新任站长置 manager、
 * 其余旧 manager 位回落 member（否则旧站长被移交前置按 role 误拒，交回路径永久不可达）。 */
function syncRosterRoles(ledger) {
  for (const member of ledger.members) {
    if (member.instanceId === ledger.manager.instanceId) {
      member.role = 'manager';
    } else if (member.role === 'manager') {
      member.role = 'member';
    }
  }
}

/* 生效抢接记录的席位翻页作废：keepCandidateId 指保留「关于该候选」的记录（传 null 清空全部）。
 * 生效记录是进程内的席位主张面——任何本机席位变更（受让 / 让位 / 采纳新站长）即告翻页；
 * 不清理会让组合链（抢占 × 移交）里已翻页的记录继续经握手传播，把新站长按旧记录拉下席位。 */
function invalidateEffectiveTakeovers(state, local, keepCandidateId) {
  const held = state.effectiveTakeovers.get(local.collabId);
  if (held === undefined) {
    return;
  }
  if (keepCandidateId === null || held.candidate.instanceId !== keepCandidateId) {
    state.effectiveTakeovers.delete(local.collabId);
  }
}

/* 降级为成员（被替换 / 合流让位的落点）：站长席位——以台账定格名单转成员记录、删除本地台账
 * （单副本纪律：台账随后任站长走；本机快照保留为成员备份）；成员——仅更新站长引用。
 * 随后重定向陈旧出站队列（发往旧站长的未确认消息改投新站长——不静默丢弃）并拉取现任视图。
 * 席位变更（让位）作废本机生效抢接记录并推进席位时钟（陈旧判据的本机已知面）。 */
export function downgradeToMember(state, local, managerPeer, version) {
  invalidateEffectiveTakeovers(state, local, null);
  const formerManagerId = currentManagerIdOf(local);
  if (local.role === 'manager') {
    local.member = memberRecordOf(local, managerPeer);
    local.ledger = null;
    local.role = 'member';
    if (!removeLedgerFile(state.dataDir, local.collabId)) {
      state.log.warn('台账文件删除失败（保守保留）', { collabId: local.collabId });
    }
  } else {
    local.member.manager = { instanceId: managerPeer.instanceId, identityName: managerPeer.identityName };
  }
  if (Number.isInteger(version)) {
    local.member.managerSinceVersion = version;
  }
  local.suspended = null;
  persistMember(state, local);
  retargetStaleQueue(state, local, formerManagerId, managerPeer.instanceId);
  requestCurrentView(state, local);
  state.counters.downgrades++;
}

/* 陈旧出站队列重定向：发往旧站长的未确认条目改投新站长（同 msgId 保持——进行中消息在新席位
 * 上等价有效且不产生重复投递）；新站长端点未知先暂存 staleManagerId、待端点学习后补投。 */
export function retargetStaleQueue(state, local, fromInstanceId, toInstanceId) {
  if (fromInstanceId === toInstanceId) {
    return;
  }
  const endpoint = endpointFor(state, local, toInstanceId);
  if (endpoint === undefined || typeof state.reassign !== 'function') {
    local.staleManagerId = fromInstanceId;
    state.counters.queueStaleKept++;
    return;
  }
  const result = state.reassign({
    collabId: local.collabId,
    fromInstanceId,
    to: { instanceId: toInstanceId, address: endpoint.address, port: endpoint.port },
  });
  if (result.ok === true) {
    state.counters.queueRetargeted += result.moved;
    local.staleManagerId = null;
  } else {
    local.staleManagerId = fromInstanceId;
    state.counters.queueStaleKept++;
  }
}

/* 端点学习后的补投（applyEndpoint 的挂点）：暂存的旧站长队列等到新站长端点即可重定向。 */
export function resumeStaleRetarget(state, local) {
  if (local.staleManagerId === null || local.staleManagerId === undefined) {
    return;
  }
  retargetStaleQueue(state, local, local.staleManagerId, currentManagerIdOf(local));
}

/* 端点学习（协作端点表入口——直连帧学习与治理载荷学习共用）：记录「实例标识 → 地址:端口」，
 * 仅在变化时写 member.json；学到现任站长端点时补做陈旧队列重定向（互盲解除后改投立即发生）。
 * 返回是否发生更新（调用方据此决定补发生效通告等后续动作）。 */
export function applyEndpoint(state, local, peer, address, port) {
  const held = local.endpoints.get(peer.instanceId);
  const changed = held === undefined || held.address !== address || held.port !== port;
  if (changed) {
    local.endpoints.set(peer.instanceId, { address, port });
    local.member.endpoints = Object.fromEntries(local.endpoints);
    persistMember(state, local);
    if (peer.instanceId === currentManagerIdOf(local)) {
      resumeStaleRetarget(state, local);
    }
  }
  rememberKnownHost(state, { address, port, instanceId: peer.instanceId, identityName: peer.identityName });
  return changed;
}

/* 向现任站长拉取当前视图（快照请求；端点未知静默跳过——对方主动联系时端点自然学习）。 */
export function requestCurrentView(state, local) {
  const managerId = local.member.manager.instanceId;
  const endpoint = endpointFor(state, local, managerId);
  if (endpoint === undefined) {
    return;
  }
  sendTo(state, local.collabId, managerId, endpoint, 'snapshot', { kind: 'request' });
}

/* 站长引用更新（成员侧；移交 / 抢接 / 握手共用）：更新记录、重定向陈旧队列并留痕；
 * 是否拉取当前视图由调用方决定（对表路径按版本差决定）。 */
export function adoptNewManager(state, local, managerPeer, remoteVersion) {
  if (local.role !== 'member') {
    return false;
  }
  const oldId = local.member.manager.instanceId;
  if (oldId === managerPeer.instanceId) {
    return false;
  }
  /* 席位变更（采纳新站长）作废关于其它候选的生效记录（关于新站长本人的记录保留——它是
   * 本机对「发生过抢接」的如实知识，继续随握手外传供他方收敛）；并推进席位时钟
   * （陈旧判据的本机已知面：早于或等于该次变更的席位主张与记录不再回翻本机引用）。 */
  invalidateEffectiveTakeovers(state, local, managerPeer.instanceId);
  local.member.manager = { instanceId: managerPeer.instanceId, identityName: managerPeer.identityName };
  if (Number.isInteger(remoteVersion)) {
    local.member.managerSinceVersion = remoteVersion;
  }
  persistMember(state, local);
  retargetStaleQueue(state, local, oldId, managerPeer.instanceId);
  state.counters.managerChangedIn++;
  state.log.info('站长引用已更新', { collabId: local.collabId, from: oldId, to: managerPeer.instanceId, version: remoteVersion });
  return true;
}

/* 合流递交（设计 §9 步骤 4）：把本地 diverged 台账整份发给现任站长、由其本机人裁定采纳 / 丢弃。
 * 不走快照通道——快照通道的「版本不倒退即收」会让 diverged 内容静默覆盖（禁止静默覆盖）。 */
export function sendMergeOffer(state, local, managerPeer, baseVersion) {
  const source = local.role === 'manager' ? local.ledger : (local.snapshot === null ? null : local.snapshot.ledger);
  if (source === null) {
    return { ok: false, reason: '无可递交的台账' };
  }
  const endpoint = local.endpoints.get(managerPeer.instanceId);
  if (endpoint === undefined) {
    return { ok: false, reason: '端点未知' };
  }
  const frozen = structuredClone(source);
  return sendTo(state, local.collabId, managerPeer.instanceId, endpoint, 'notice', {
    event: 'merge-request',
    baseVersion,
    version: frozen.version,
    digest: ledgerDigest(frozen),
    ledger: frozen,
  });
}

/* 本机提示（会话注入面；不经出站队列、不上网络）：notify 注入缺失或投递失败只计数与日志。
 * 帧形态为 notice + event:'local-alert'——该事件不入协议表（外发不存在；伪造入站被协议拒收）。
 * 返回值契约（join-ack 判据的通道，单核路由面消费）：false = 提示无接收者（路由面明示
 * 「绑定会话不活跃 / 无绑定 / 调用者桥不在线」）；其余（true / undefined / 旧式注入面返回值）
 * = 按已投出处理——旧注入面（如既有的 deliverFrame）零改动，只有显式 false 才是否决信号。 */
export function notifyLocal(state, local, text) {
  if (typeof state.notify !== 'function') {
    return undefined;
  }
  try {
    const routed = state.notify({
      v: PROTOCOL_VERSION,
      type: 'notice',
      msgId: newMsgId(),
      from: state.self,
      collabId: local.collabId,
      ts: new Date().toISOString(),
      payload: { event: 'local-alert', text },
    });
    if (routed === false) {
      return false;
    }
    state.counters.notificationsSent++;
    return true;
  } catch (error) {
    state.counters.notificationsDropped++;
    state.log.warn('本机提示投递失败（已忽略）', { collabId: local.collabId, reason: error.message });
    return false;
  }
}

/* 星型路由（设计 §10）：成员只发给站长（省略 to 或显式 = 站长）；站长发给任一人、
 * 省略 to = 全体已建立成员（不含本机）。 */
function recipientsOf(state, local, to) {
  const managerId = local.member.manager.instanceId;
  const explicit = typeof to === 'string' && to.trim() !== '' ? to.trim() : null;
  if (local.role === 'member') {
    if (explicit !== null && explicit !== managerId) {
      return { error: '成员只能发给站长（星型路由）' };
    }
    return { targets: [managerId] };
  }
  if (explicit !== null) {
    const exists = local.ledger.members.some((entry) => entry.instanceId === explicit);
    return exists ? { targets: [explicit] } : { error: '目标不在协作名单中' };
  }
  return { targets: memberIdsOf(state, local) };
}

/* 协作类载荷构造：topic 走呈现文本、task 生成任务标识、stop 的正文即原因、其余为正文 text。 */
function payloadOf(type, text) {
  if (type === 'topic') {
    return { text };
  }
  if (type === 'task') {
    return { taskId: newCollabId(), text };
  }
  if (type === 'stop') {
    return { reason: text };
  }
  return { text };
}

/* manager 记录（含移交受让与接管恢复的构造面）：roster = 台账定格名单，endpoints 由调用方补。
 * topic 随记录定格（讨论成员侧发起邀请的取数面；managed 记录同样携带——形态无差别）。 */
export function managerRecordOf(ledger) {
  return {
    collabId: ledger.collabId,
    role: 'manager',
    state: ledger.status,
    name: ledger.name,
    topic: ledger.topic,
    mode: ledger.mode ?? DEFAULT_COLLAB_MODE,
    manager: { instanceId: ledger.manager.instanceId, identityName: ledger.manager.identityName },
    roster: ledger.members.map((member) => ({ instanceId: member.instanceId, identityName: member.identityName })),
    endpoints: {},
    decision: null,
  };
}

/* 成员记录（降级 / 让位的构造面）：以台账定格名单为 roster（不随台账逐次更新）；模式随本地视角定格。 */
function memberRecordOf(local, managerPeer) {
  const status = localStateOf(local);
  const record = {
    collabId: local.collabId,
    role: 'member',
    state: memberStateFor(status),
    name: localNameOf(local),
    topic: localTopicOf(local) ?? undefined,
    mode: localModeOf(local),
    manager: { instanceId: managerPeer.instanceId, identityName: managerPeer.identityName },
    roster: localRosterOf(local).map((entry) => ({ instanceId: entry.instanceId, identityName: entry.identityName })),
    endpoints: Object.fromEntries(local.endpoints),
    decision: null,
  };
  if (record.state === 'completed' || record.state === 'terminated') {
    record.archivedAt = new Date().toISOString();
  }
  return record;
}

/* 邀请帧的载荷构造（创建邀请与既有协作的增邀共用）：随带模式（被邀者据此按模式建记录；
 * 缺省 managed = 旧行为）。extraMembers = 尚未进本地名单的本次被邀目标——被邀方须能在名单中
 * 看到自己与邀请者（接收侧名单校验），按实例标识去重（协议层拒绝重复名单）。
 * endpoints（可选，讨论携带）：现成员端点表 → 被邀者据此取得入群寻址信息。 */
/**
 * @param {any} ledger
 * @param {any[]} [extraMembers]
 * @param {Record<string, { address: string, port: number }> | null} [endpoints]
 */
export function invitePayloadOf(ledger, extraMembers = [], endpoints = null) {
  const seen = new Set(ledger.members.map((member) => member.instanceId));
  const members = ledger.members.map((member) => ({ instanceId: member.instanceId, identityName: member.identityName }));
  for (const extra of extraMembers) {
    if (!seen.has(extra.instanceId)) {
      seen.add(extra.instanceId);
      members.push({ instanceId: extra.instanceId, identityName: extra.identityName });
    }
  }
  const payload = {
    name: ledger.name,
    topic: ledger.topic,
    mode: ledger.mode ?? DEFAULT_COLLAB_MODE,
    members,
  };
  if (endpoints !== null) {
    payload.endpoints = endpoints;
  }
  return payload;
}

function withdrawOne(state, local, targetId) {
  const member = local.ledger.members.find((entry) => entry.instanceId === targetId);
  if (member === undefined) {
    return { ok: false, message: '名单里没有该成员' };
  }
  if (member.state !== 'invited') {
    return { ok: false, message: `该成员已回应（${member.state}）——不可撤回` };
  }
  mutateLedger(state, local, () => {
    member.state = 'withdrawn';
  });
  const endpoint = local.endpoints.get(targetId);
  const sent = endpoint === undefined
    ? { ok: false, reason: '端点未知' }
    : sendTo(state, local.collabId, targetId, endpoint, 'withdraw', { scope: 'single' });
  state.counters.withdrawn++;
  return { ok: true, scope: 'single', withdrawn: [targetId], delivered: sent.ok === true };
}

function withdrawAll(state, local) {
  /* 整条取消的通告面 = 全体非本机成员（含已单条撤回 / 已拒绝者——它们也应得知该协作已不存在） */
  const recipients = local.ledger.members.filter((entry) => entry.instanceId !== state.self.instanceId);
  mutateLedger(state, local, (ledger) => {
    ledger.status = 'terminated';
    for (const member of ledger.members) {
      if (member.state === 'invited' || member.state === 'approved') {
        member.state = 'withdrawn';
      }
    }
  });
  local.member.state = 'terminated';
  local.member.archivedAt = new Date().toISOString();
  persistMember(state, local);
  local.mute.clear();
  for (const member of recipients) {
    const endpoint = local.endpoints.get(member.instanceId);
    if (endpoint !== undefined) {
      sendTo(state, local.collabId, member.instanceId, endpoint, 'withdraw', { scope: 'all' });
    }
  }
  state.counters.withdrawn += recipients.length;
  return { ok: true, scope: 'all', withdrawn: recipients.map((member) => member.instanceId) };
}

/* 创建前置检查：模式合法后走形态面；本机同名交集冲突（防重复发起——同名且参与者有交集的协作
 * 在本机再次创建必然构成设计 §6 的冲突面，直接拒绝给出明确指引）只施于 managed：讨论创建跳过
 * 冲突检测（讨论不参与同名冲突匹配，任何方向）。 */
function createRejection(state, name, topic, targets, mode) {
  if (!isCollabMode(mode)) {
    return `模式非法：可选值 ${COLLAB_MODES.join(' / ')}（缺省 ${DEFAULT_COLLAB_MODE}）`;
  }
  const shapeRejection = createShapeRejection(state, name, topic, targets, mode);
  if (shapeRejection !== null) {
    return shapeRejection;
  }
  if (mode === 'forum') {
    return null;
  }
  const conflict = matchConflictCollabs(state, name, [state.self.instanceId, ...targets.map((target) => target.instanceId)]);
  if (conflict.length > 0) {
    return `本机已有同名且参与者有交集的协作（${conflict[0].collabId}）——请换名或先处理既有协作`;
  }
  return null;
}

/* 创建形态面（模式无关的判据 + 讨论参与者上限）：名 / 主题呈现判据、目标形态与去重、本机协作
 * 总数上限。协议层名单硬顶（32）照旧校验——此处的 16 是讨论模式的策略校验点（含发起人）。 */
function createShapeRejection(state, name, topic, targets, mode) {
  if (typeof name !== 'string' || !isIdentityName(name)) {
    return '项目名非法：需为非空、≤64 字符、不含控制 / 不可见格式 / 行段分隔字符（同身份名呈现判据）';
  }
  if (typeof topic !== 'string' || !isPresentationText(topic, MAX_TOPIC_CHARS)) {
    return `主题非法：需为非空、≤${MAX_TOPIC_CHARS} 字符的呈现文本`;
  }
  if (mode === 'forum') {
    const forumRejection = forumTargetsRejection(targets);
    if (forumRejection !== null) {
      return forumRejection;
    }
  }
  const targetsRejection = targetsRejectionOf(targets, state.self.instanceId);
  if (targetsRejection !== null) {
    return targetsRejection;
  }
  if (countLiveCollabs(state) >= MAX_LOCAL_COLLABS) {
    return `本机参与协作数已达上限（${MAX_LOCAL_COLLABS}）——先结束或退出旧协作`;
  }
  return null;
}

/* 讨论参与者上限（16 含发起人，设计 §9 邀请侧软约束的创建侧表达）。 */
function forumTargetsRejection(targets) {
  if (Array.isArray(targets) && targets.length > MAX_FORUM_MEMBERS - 1) {
    return `讨论参与者上限 ${MAX_FORUM_MEMBERS}（含发起人）——targets 至多 ${MAX_FORUM_MEMBERS - 1} 项`;
  }
  return null;
}

/* 目标数组形态与去重（含本机排除）。 */
function targetsRejectionOf(targets, selfId) {
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > MAX_COLLAB_MEMBERS - 1) {
    return `目标非法：需要 1–${MAX_COLLAB_MEMBERS - 1} 项`;
  }
  const seen = new Set([selfId]);
  for (const target of targets) {
    const reason = targetRejection(target, seen);
    if (reason !== null) {
      return reason;
    }
  }
  return null;
}

function targetRejection(target, seen) {
  if (typeof target !== 'object' || target === null) {
    return '目标条目非法';
  }
  if (typeof target.instanceId !== 'string' || !ID_PATTERN.test(target.instanceId)) {
    return '目标实例标识非法（1–64 位字母数字与连字符）';
  }
  if (typeof target.identityName !== 'string' || !isIdentityName(target.identityName)) {
    return '目标身份名非法（呈现判据）';
  }
  if (!isEndpointValue(target)) {
    return '目标端点非法（地址需 IP 字面量、端口 1–65535）';
  }
  const naming = namingRejectionOf(target);
  if (naming !== null) {
    return naming;
  }
  if (seen.has(target.instanceId)) {
    return '目标重复（或包含本机）';
  }
  seen.add(target.instanceId);
  return null;
}

/* 可选指名会话（targetSessionId）的形态把关：未给＝不指名（null）；给了须为标识形态（短码是
 * 标识前缀，同一判据）——给了坏形态即拒（不得静默丢字段，丢字段＝把指名邀请变回广播）。 */
function namingRejectionOf(target) {
  if (target.targetSessionId === undefined) {
    return null;
  }
  return typeof target.targetSessionId === 'string' && ID_PATTERN.test(target.targetSessionId)
    ? null
    : '目标指名会话非法（1–64 位字母数字与连字符的会话标识 / 短码）';
}

function isEndpointValue(target) {
  if (typeof target.address !== 'string' || isIP(target.address) === 0) {
    return false;
  }
  return isPort(target.port);
}

/* 冻结目标集：被冻协作成员端点 ∪ 同名交集协作成员端点（去重、除本机）。 */
function collectFreezeTargets(state, frozenLocal) {
  const ids = localRosterOf(frozenLocal).map((entry) => entry.instanceId);
  const targets = new Map();
  addTargetsOf(state, frozenLocal, targets);
  for (const other of matchConflictCollabs(state, localNameOf(frozenLocal), ids)) {
    if (other.collabId !== frozenLocal.collabId) {
      addTargetsOf(state, other, targets);
    }
  }
  targets.delete(state.self.instanceId);
  return targets;
}

function addTargetsOf(state, local, targets) {
  for (const [instanceId, endpoint] of local.endpoints) {
    if (instanceId !== state.self.instanceId && !targets.has(instanceId)) {
      targets.set(instanceId, endpoint);
    }
  }
}
