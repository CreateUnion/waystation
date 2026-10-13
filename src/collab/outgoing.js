import { isIP } from 'node:net';
import { COLLAB_MODES, DEFAULT_COLLAB_MODE, ID_PATTERN, MAX_COLLAB_MEMBERS, MAX_MESSAGE_TEXT_CHARS, MAX_REASON_CHARS, MAX_TOPIC_CHARS, POST_KINDS, PROTOCOL_VERSION, isCollabMode, isIdentityName, isPort, isPresentationText, newMsgId } from '../net/protocol.js';
import { MAX_FORUM_MEMBERS, MAX_LOCAL_COLLABS, canTransition, isArchived, newCollabId } from './model.js';
import { createPostsStore, displayOrderOf, newPostId } from './posts.js';
import { createMembersStore } from './members.js';
import { ledgerDigest, removeLedgerFile } from './store.js';
import { currentManagerIdOf, emitOwnMemberEvent, foldedMembersOf, isLocalArchivedState, localModeOf, localNameOf, localRosterOf, localStateOf, localTopicOf, memberStateFor, persistLedger, persistMember, persistSnapshot, rememberKnownHost, selfJoinedOf } from './local.js';
import { matchConflictCollabs } from './gate.js';

/* 对外操作与协作态变更实现（服务公共 API 的落点）：请求来自本机会话（工具面）——
 * 参数不符合即返回 { ok:false, message }（由工具层呈现为 isError）；发送一律经注入的
 * dispatch.send（可靠队列），单条入队失败只计数不回滚已完成的本地状态。 */

/* 可投递成员状态集（消息广播与通告的收件人口径）。 */
const MESSAGING_MEMBER_STATES = ['invited', 'approved', 'member'];

/* 已转达 originMsgId 集上限：转达防环与防重复的记录面（进程内、插入序淘汰）——
 * 每条治理通告的每跳只在首次收到时转达一次，重复副本不再向外扩散（本地应用仍幂等执行）。 */
const RELAYED_ORIGINS_MAX = 256;

export function createCollab(state, { name, topic, targets, mode }) {
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
    posts: createPostsStore({ dataDir: state.dataDir, collabId: ledger.collabId, log: state.log }),
    members: createMembersStore({ dataDir: state.dataDir, collabId: ledger.collabId, log: state.log }),
    suspended: null,
    staleManagerId: null,
  };
  for (const target of targets) {
    local.endpoints.set(target.instanceId, { address: target.address, port: target.port });
    rememberKnownHost(state, { address: target.address, port: target.port, instanceId: target.instanceId, identityName: target.identityName });
  }
  local.member.endpoints = Object.fromEntries(local.endpoints);
  state.collabs.set(ledger.collabId, local);
  if (collabMode === 'forum') {
    emitOwnMemberEvent(state, local, 'join');   // 发起人自创建即在成员表内（"第一个"，设计 §5.1）
  }
  persistMember(state, local);
  persistLedger(state, local);
  const invited = [];
  for (const target of targets) {
    const result = sendTo(state, ledger.collabId, target.instanceId, { address: target.address, port: target.port }, 'invite', invitePayloadOf(ledger, [], forumEndpointsOf(collabMode, local)));
    invited.push({ instanceId: target.instanceId, ok: result.ok === true, msgId: result.msgId, reason: result.reason });
    state.counters.invitesSent++;
  }
  state.counters.collabsCreated++;
  return { ok: true, collabId: ledger.collabId, invited };
}

/* 讨论邀请随带的端点表（设计 §5.1：现成员表与端点表——被邀者据此取得寻址信息）；managed 不带。 */
function forumEndpointsOf(mode, local) {
  return mode === 'forum' ? Object.fromEntries(local.endpoints) : null;
}

/* 新建台账（v1 proposed；名单 = 本机〔manager〕+ 各目标〔invited〕；模式创建时定死）。
 * 讨论模式的角色名沿用既有结构（发起人 = 本机管理席位）——平权语义与角色重命名归各模式链路
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

/* 邀请成员加入既有的讨论（邀请入口的发送侧）：**任何成员可发起**（平权，设计 §5.1）——
 * 邀请帧复用既有构造、对既有 collabId 发出、重复邀请幂等（本地成员表不由邀请动作改写——
 * 成员关系由加入事件推进）。名单与名额以**折叠成员表**为准（被拒/被撤回者不占名额）；
 * 成员侧的主题等元数据取本地记录（邀请载荷/对表元状态写入的落点——成员侧无主题可取的缺口由此闭合）。 */
export function inviteMembers(state, { collabId, targets }) {
  const local = state.collabs.get(collabId);
  if (local === undefined) {
    return { ok: false, message: '本机没有该讨论（collabId 不存在）——先看 ws_list_collabs' };
  }
  if (localModeOf(local) !== 'forum') {
    return { ok: false, message: `协作模式（${DEFAULT_COLLAB_MODE}）的增员补齐另立任务中——ws_invite 当前仅用于讨论模式` };
  }
  if (isLocalArchivedState(local)) {
    return { ok: false, message: '讨论已结束（或已终止 / 已退出）——不再受理邀请动作' };
  }
  if (!selfJoinedOf(local, state.self.instanceId)) {
    return { ok: false, message: '本机尚未加入该讨论（等待邀请或先回应邀请）——加入为成员后才能邀请他人' };
  }
  const targetsRejection = targetsRejectionOf(targets, state.self.instanceId);
  if (targetsRejection !== null) {
    return { ok: false, message: targetsRejection };
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
    const payload = forumInvitePayloadOf(state, local, topic, targets);
    const result = sendTo(state, collabId, target.instanceId, { address: target.address, port: target.port }, 'invite', payload);
    invited.push({ instanceId: target.instanceId, ok: result.ok === true, msgId: result.msgId, reason: result.reason });
    state.counters.invitesSent++;
  }
  return { ok: true, collabId, invited };
}

/* 讨论邀请载荷（发送侧公共构造）：名/主题/模式 + **折叠成员表 ∪ 本次目标**（被邀者据此校验
 * 名单含自己与来源）+ 现端点表。名单 2–32 由协议层照旧校验（折叠表 ≥2：本机 + 至少一个目标）。 */
function forumInvitePayloadOf(state, local, topic, targets) {
  const members = foldedMembersOf(local).map((member) => ({ instanceId: member.instanceId, identityName: member.identityName }));
  const seen = new Set(members.map((member) => member.instanceId));
  for (const target of targets) {
    if (!seen.has(target.instanceId)) {
      seen.add(target.instanceId);
      members.push({ instanceId: target.instanceId, identityName: target.identityName });
    }
  }
  return {
    name: localNameOf(local),
    topic,
    mode: 'forum',
    members,
    endpoints: Object.fromEntries(local.endpoints),
  };
}

export function approveInvite(state, { collabId, approve, reason }) {
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
  if (localModeOf(local) === 'forum') {
    return decideForumInvite(state, local, wanted, reason);
  }
  return sendDecision(state, local, approve, wanted, reason);
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

/* 决策发帧：先定格 decision（本地状态即真相），再入队；管理者端点未知给出明确指引。
 * 拒绝原因按协议呈现判据先行校验（超限 / 换行在入队侧会被拒——不得先定格、后静默失败）。 */
function sendDecision(state, local, approve, wanted, reason) {
  const validated = validateDeclineReason(approve ? undefined : reason);
  if (validated.ok !== true) {
    return { ok: false, message: validated.message };
  }
  const endpoint = local.endpoints.get(local.member.manager.instanceId);
  if (endpoint === undefined) {
    return { ok: false, message: '管理者端点未知（邀请可能不完整）——请重新扫描后请对方重发邀请' };
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
    return { ok: false, message: '只有管理席位可以撤回邀请' };
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

export function sendMessage(state, { collabId, text, type, to }) {
  const local = state.collabs.get(collabId);
  if (local === undefined) {
    return { ok: false, message: '本机没有该协作（先 ws_list_collabs）' };
  }
  if (local.suspended !== null) {
    return { ok: false, message: '协作对外写已暂停（在途抢接或未能对表）——收敛后恢复' };
  }
  if (localModeOf(local) === 'forum') {
    return sendForumPost(state, local, { text, type, to });
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
 * ts 分配即定）再扇出直投——帖的事务点在本机列表，直投失败不回滚。
 * 帖不进会话注入以外的任何元状态面：topic 帖亦按普通帖处理（主题创建时定死）。 */
function sendForumPost(state, local, { text, type, to }) {
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
  const results = fanOutPost(state, local, post);
  state.counters.postsSent++;
  return {
    ok: true,
    postId: post.postId,
    seq: post.seq,
    ts: post.ts,
    to: results.map((entry) => entry.instanceId),
    results,
    note: '已直投（在线尽力 + 短重试，不落持久队列）——未达者由对方周期对表拉取收敛；投递结果可用 ws_delivery_status 查询',
  };
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
    return { ok: false, message: '只有管理席位可以结束协作' };
  }
  /* 讨论的发起人退出即放弃结束权（设计 §6）：本机已退出该讨论 → end 不再受理（状态面）。 */
  if (local.member.state === 'left') {
    return { ok: false, message: '本机已退出该讨论——发起人退出即放弃结束权（讨论存续，结束不再受理）' };
  }
  /* 挂起期明确拒绝（与 sendMessage 同一口径）：收敛等待中的结束会半执行——台账写被暂停守卫
   * 拦下，成员记录与通告却照发，产出「成员已归档、驿丞仍活跃」的僵尸协作。 */
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
    return { ok: false, message: '管理席位不可退出——请先结束协作（显式交接属治理事项）' };
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
  state.counters.left++;
  return { ok: true, delivered: endpoint !== undefined };
}

/* 讨论退出（设计 §5.4/§6）：leave 事件照走（自播广播、豁免 TTL/上限）；**发起人同普通成员**
 * ——退出即放弃结束权（本批无中继，即放弃结束权；本机归档后 end 调用被拒属状态面，
 * 工具面守卫随后续任务收口）。退出后讨论存续；本机归档，不再对表与重播。 */
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
  return { ok: false, message: archived ? '协作已归档且本机无可用快照' : '管理者离线且本机无快照——没有可读台账' };
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
 * 端点未知者计数跳过（成员从未联系过管理席位的窗口）。管理席位同步留存自身最近快照。
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

/* 成员事件广播（join / leave；设计 §5.4）：发给折叠成员表（除本机）中端点已知者——
 * 未收敛时另经发起人引用补达（成员刚加入、对端事件尚未拉回）与应用层广播豁免（豁免 TTL/上限）。 */
export function broadcastMemberEvent(state, local, type, event) {
  return broadcastToForumMembers(state, local, type, { eventId: event.eventId, ts: event.ts });
}

/* 讨论控制事件广播出口（join / leave / end 共用）：折叠成员表 ∪ 本机记录的发起人引用。 */
export function broadcastToForumMembers(state, local, type, payload) {
  let sent = 0;
  for (const instanceId of forumBroadcastTargets(state, local)) {
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

function forumBroadcastTargets(state, local) {
  const ids = new Set();
  for (const member of foldedMembersOf(local)) {
    ids.add(member.instanceId);
  }
  if (local.role === 'member' && typeof local.member?.manager?.instanceId === 'string') {
    ids.add(local.member.manager.instanceId);
  }
  ids.delete(state.self.instanceId);
  return [...ids];
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
  /* 转达原样携带原发身份（设计 §9）：帧的 from 是候选人 / 驿丞的权威身份——改写为转达者会让
   * 接收方把转达者当作新驿丞（身份归因错位）；只取协议定义的三字段，不夹带来源帧其它字段。 */
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
 * 管理席位侧检出时随带被冻条的发起时间与管理者（合流并集与保留方判定的参考数据；
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

/* 本地冻结：管理席位冻台账（version 推进 + 快照）、成员冻本地记录；已冻结或迁移不允许时幂等返回 false。
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

/* 管理席位视角的可投递成员标识（除本机；终态成员——被拒 / 被撤回 / 已退出——不投消息）：
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

/* 席位转移原语（接管生效 / 移交受让共用）：以给定台账承担管理席位——本地记录转管理、
 * 台账落盘（本机成为单一写者）、自身留存并推送当前视图（成员由此学习新驿丞端点）。 */
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

/* 席位变更后的名册角色同步：台账 manager 与 members[].role 恒一致——新任驿丞置 manager、
 * 其余旧 manager 位回落 member（否则旧驿丞被移交前置按 role 误拒，交回路径永久不可达）。 */
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
 * 生效记录是进程内的席位主张面——任何本机席位变更（受让 / 让位 / 采纳新驿丞）即告翻页；
 * 不清理会让组合链（抢占 × 移交）里已翻页的记录继续经握手传播，把新驿丞按旧记录拉下席位。 */
function invalidateEffectiveTakeovers(state, local, keepCandidateId) {
  const held = state.effectiveTakeovers.get(local.collabId);
  if (held === undefined) {
    return;
  }
  if (keepCandidateId === null || held.candidate.instanceId !== keepCandidateId) {
    state.effectiveTakeovers.delete(local.collabId);
  }
}

/* 降级为成员（被替换 / 合流让位的落点）：管理席位——以台账定格名单转成员记录、删除本地台账
 * （单副本纪律：台账随后任驿丞走；本机快照保留为成员备份）；成员——仅更新驿丞引用。
 * 随后重定向陈旧出站队列（发往旧驿丞的未确认消息改投新驿丞——不静默丢弃）并拉取现任视图。
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

/* 陈旧出站队列重定向：发往旧驿丞的未确认条目改投新驿丞（同 msgId 保持——进行中消息在新席位
 * 上等价有效且不产生重复投递）；新驿丞端点未知先暂存 staleManagerId、待端点学习后补投。 */
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

/* 端点学习后的补投（applyEndpoint 的挂点）：暂存的旧驿丞队列等到新驿丞端点即可重定向。 */
export function resumeStaleRetarget(state, local) {
  if (local.staleManagerId === null || local.staleManagerId === undefined) {
    return;
  }
  retargetStaleQueue(state, local, local.staleManagerId, currentManagerIdOf(local));
}

/* 端点学习（协作端点表入口——直连帧学习与治理载荷学习共用）：记录「实例标识 → 地址:端口」，
 * 仅在变化时写 member.json；学到现任驿丞端点时补做陈旧队列重定向（互盲解除后改投立即发生）。
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

/* 向现任驿丞拉取当前视图（快照请求；端点未知静默跳过——对方主动联系时端点自然学习）。 */
export function requestCurrentView(state, local) {
  const managerId = local.member.manager.instanceId;
  const endpoint = endpointFor(state, local, managerId);
  if (endpoint === undefined) {
    return;
  }
  sendTo(state, local.collabId, managerId, endpoint, 'snapshot', { kind: 'request' });
}

/* 驿丞引用更新（成员侧；移交 / 抢接 / 握手共用）：更新记录、重定向陈旧队列并留痕；
 * 是否拉取当前视图由调用方决定（对表路径按版本差决定）。 */
export function adoptNewManager(state, local, managerPeer, remoteVersion) {
  if (local.role !== 'member') {
    return false;
  }
  const oldId = local.member.manager.instanceId;
  if (oldId === managerPeer.instanceId) {
    return false;
  }
  /* 席位变更（采纳新驿丞）作废关于其它候选的生效记录（关于新驿丞本人的记录保留——它是
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
  state.log.info('驿丞引用已更新', { collabId: local.collabId, from: oldId, to: managerPeer.instanceId, version: remoteVersion });
  return true;
}

/* 合流递交（设计 §9 步骤 4）：把本地 diverged 台账整份发给现任驿丞、由其本机人裁定采纳 / 丢弃。
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
 * 帧形态为 notice + event:'local-alert'——该事件不入协议表（外发不存在；伪造入站被协议拒收）。 */
export function notifyLocal(state, local, text) {
  if (typeof state.notify !== 'function') {
    return;
  }
  try {
    state.notify({
      v: PROTOCOL_VERSION,
      type: 'notice',
      msgId: newMsgId(),
      from: state.self,
      collabId: local.collabId,
      ts: new Date().toISOString(),
      payload: { event: 'local-alert', text },
    });
    state.counters.notificationsSent++;
  } catch (error) {
    state.counters.notificationsDropped++;
    state.log.warn('本机提示投递失败（已忽略）', { collabId: local.collabId, reason: error.message });
  }
}

/* 星型路由（设计 §10）：成员只发给管理者（省略 to 或显式 = 管理者）；管理者发给任一人、
 * 省略 to = 全体已建立成员（不含本机）。 */
function recipientsOf(state, local, to) {
  const managerId = local.member.manager.instanceId;
  const explicit = typeof to === 'string' && to.trim() !== '' ? to.trim() : null;
  if (local.role === 'member') {
    if (explicit !== null && explicit !== managerId) {
      return { error: '成员只能发给管理者（星型路由）' };
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

/* 管理席位记录（含移交受让与接管恢复的构造面）：roster = 台账定格名单，endpoints 由调用方补。
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
  if (seen.has(target.instanceId)) {
    return '目标重复（或包含本机）';
  }
  seen.add(target.instanceId);
  return null;
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
