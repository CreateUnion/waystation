import { isIP } from 'node:net';
import { COLLAB_MODES, DEFAULT_COLLAB_MODE, ID_PATTERN, MAX_COLLAB_MEMBERS, MAX_MESSAGE_TEXT_CHARS, MAX_REASON_CHARS, MAX_TOPIC_CHARS, POST_KINDS, PROTOCOL_VERSION, isCollabMode, isIdentityName, isPort, isPresentationText, newMsgId, withCollabCapability } from '../net/protocol.js';
import { MAX_FORUM_MEMBERS, MAX_LOCAL_COLLABS, canTransition, isArchived, newCollabId } from './model.js';
import { createPostsStore, displayOrderOf, newPostId } from './posts.js';
import { createMembersStore } from './members.js';
import { createCounterStore, notifyIndicatorChange } from './counter.js';
import { forgetMuteBaselinesOfCollab, rememberMuteBaselineIfAbsent } from './mute.js';
import { createInjectedStore } from './injected.js';
import { consumeInviteChallenge, consumeInviteWaiver, issueInviteChallenge } from './consent.js';
import { ledgerDigest, removeLedgerFile } from './store.js';
import { archiveLocalSeatsOfState, currentManagerIdOf, emitOwnMemberEvent, foldedMembersOf, forumReachIdsOf, isLocalArchivedState, localModeOf, localNameOf, localRosterOf, localSeatOfLocal, localStateOf, localTopicOf, memberStateFor, persistLedger, persistMember, persistSnapshot, relayDepartedOf, relayPeerOf, rememberKnownHost, retiredMuteHandle, seatsOfLocal, selfJoinedOf, upsertLocalSeat } from './local.js';
import { matchConflictCollabs } from './gate.js';
import { CARRIER_FORMAT_INVITE_STUB, CARRIER_FORMAT_SESSION_SEATS, readCarrier, writeCarrier } from './carrier.js';
import { collabDir } from '../paths.js';
import { ledgerTermOf, writeLocalTerminalCopy } from './takeover.js';
import { createInvitesFileStore } from './joins.js';
import { matchSessionByToken } from '../util/short-id.js';

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

/* 入席默认静音（设计 §3.1）：本机成为参与者时把默认静音落到**本会话席位**（席位文件的 muted
 * 是唯一权威，契约 §8），基线 = 写入时刻的当下累计读数（进程内按席位记录）。
 * 返回本次是否真写了（前态未静音或基线首次建立即本次落笔）——提醒据此如实给，不虚报。
 * 只在「创建成功」与「同意加入成功」两处调用——挂到记录创建 / 成员落盘这类宽调用点，
 * 会把受邀未同意者也静音（本机不同意还被静音的故障形态）。
 * managed 两段式在同意时尚未建席：基线按调用会话先记下，席位由加入域建席时落 muted:true。 */
function applyDefaultMute(state, local, sessionId) {
  const target = defaultMuteSessionOf(local, sessionId);
  if (target === null) {
    return false;
  }
  const firstApplication = rememberMuteBaselineIfAbsent(state, local.collabId, target, contentCountOf(local));
  const seat = localSeatOfLocal(local, target);
  if (seat === null) {
    return firstApplication;
  }
  const wrote = seat.muted !== true;
  if (wrote) {
    seat.muted = true;
    upsertLocalSeat(local, { sessionId: target, muted: true }, { persist: true, dataDir: state.dataDir });
  }
  return wrote || firstApplication;
}

/* 默认静音的落点：调用会话自己的席位；无会话标识时仅在恰一席的兼容路径下取该席。 */
function defaultMuteSessionOf(local, sessionId) {
  if (typeof sessionId === 'string' && sessionId !== '') {
    return sessionId;
  }
  const seats = [...seatsOfLocal(local).values()];
  return seats.length === 1 ? seats[0].sessionId : null;
}

/* 获准台账不在本模块落笔：joins.json 的单一写者是加入域（凭 v2 形态整档写）。
 * 本模块只经加入域接口读取/使用获准事实，避免两套 writer 互相覆盖。 */

export function createCollab(state, { name, topic, targets, mode, sessionId }) {
  const collabMode = mode ?? DEFAULT_COLLAB_MODE;
  if (typeof sessionId !== 'string' || !ID_PATTERN.test(sessionId)) {
    return { ok: false, message: '缺少调用会话标识（sessionId）——无标识不得创建协作（设计 §1.1）' };
  }
  const rejected = createRejection(state, name, topic, targets, collabMode);
  if (rejected !== null) {
    return { ok: false, message: rejected };
  }
  const ledger = freshLedgerOf(state, name, topic, collabMode, sessionId);
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
    /* 退役 mute.json 的兼容句柄（仅供尚未迁出的清理调用点）；静音权威是席位文件。 */
    mute: retiredMuteHandle(),
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
    emitOwnMemberEvent(state, local, 'join', sessionId);   // 发起人自创建即在成员表内（"第一个"，设计 §5.1）
  }
  persistMember(state, local);
  persistLedger(state, local);
  const invited = initialInvitesOf(state, local, ledger, targets, collabMode, sessionId);
  state.counters.collabsCreated++;
  applyDefaultMute(state, local, sessionId);   // 写点一：创建成功（邀请发送结果不影响入席事实）
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

/* 首邀发送前的席位前提：创建者席位必须先落盘（邀请帧的签发席位就是它）；落盘失败则不发邀请——
 * 不能一边承诺「邀请已发出」一边没有可核查的发送身份。 */
function initialInvitesOf(state, local, ledger, targets, collabMode, sessionId) {
  if (!persistCreatorSeat(state, local, sessionId)) {
    return targets.map((target) => ({ instanceId: target.instanceId, ok: false, reason: '创建者席位落盘失败——邀请未发出' }));
  }
  return inviteInitialTargets(state, ledger, targets, collabMode, local, sessionId);
}

/* 创建者席位（首个席位、站长角色）：建协路径的席位写点。服务层创建收尾会再 upsert 一次
 * （幂等合并），这里先写是为了让首邀有可核查的签发身份，且崩溃时席位文件已在盘上。 */
function persistCreatorSeat(state, local, sessionId) {
  const before = local.seatPersistFailures ?? 0;
  upsertLocalSeat(local, {
    version: 1,
    sessionId,
    role: 'manager',
    state: 'member',
    joinSeq: 1,
    joinedAt: new Date().toISOString(),
    muted: true,
    unverified: false,
  }, { persist: true, dataDir: state.dataDir, bridgeId: bridgeIdOfSession(state, sessionId) });
  const persisted = (local.seatPersistFailures ?? 0) === before;
  if (!persisted) {
    state.log.warn('创建者席位落盘失败，首邀不发（席位文件是邀请签发身份的证据面）', {
      collabId: local.collabId,
      reason: local.lastSeatPersistError,
    });
  }
  return persisted;
}

function bridgeIdOfSession(state, sessionId) {
  const held = state.sessionBridges;
  return held instanceof Map ? (held.get(sessionId) ?? null) : null;
}

/* 创建邀请的发送面：managed 先为每个目标落邀请簿记再发帧——帧携 inviteId，受邀会话才能走
 * approve 两段式（设计 §4.2/§4.4）。簿记写失败不发；发送失败撤回该条，不留「可接受却已无人
 * 投递」的 open 记录。forum 无邀请簿记（D18），载荷与返回条目都不出现 inviteId。
 * 建协目标经形态校验排除本机（targetsRejectionOf），因此这里只有远端目标；同机邀请走
 * join.createInvite 的核内旁路。单条失败只如实标注，不回滚已建协作。 */
function inviteInitialTargets(state, ledger, targets, collabMode, local, sessionId) {
  const invited = [];
  for (const target of targets) {
    const opened = collabMode === 'forum'
      ? { ok: true, inviteId: undefined }
      : initialInviteRecordOf(state, ledger.collabId, target, sessionId);
    if (opened.ok !== true) {
      invited.push({ instanceId: target.instanceId, ok: false, reason: opened.reason });
      continue;
    }
    const payload = initialInvitePayloadOf(state, ledger, target, collabMode, local, opened.inviteId);
    const result = sendTo(state, ledger.collabId, target.instanceId, { address: target.address, port: target.port }, 'invite', payload, { fromSessionId: sessionId });
    if (result.ok !== true && opened.inviteId !== undefined) {
      withdrawInitialInviteRecordOf(state, ledger.collabId, opened.inviteId);
    }
    invited.push(invitedEntryOf(target, opened, result));
    state.counters.invitesSent++;
  }
  return invited;
}

/* managed 邀请簿记（建协首邀与既有协作增邀共用）：加入域是邀请记录的唯一写者，出站层只经其
 * 最小 API 开/撤记录。state.join 缺失只出现在直调 createCollab / inviteMembers 的单元状态
 * （非服务装配）——按旧行为发帧，生产组合根恒定装配加入域，不会走到这个兜底。 */
function initialInviteRecordOf(state, collabId, target, managerSessionId) {
  const open = state.join?.openInitialInvite;
  if (typeof open !== 'function') {
    return { ok: true, inviteId: undefined };
  }
  const opened = open({
    collabId,
    managerSessionId,
    targetInstanceId: target.instanceId,
    targetSessionId: target.targetSessionId,
  });
  return opened?.ok === true
    ? { ok: true, inviteId: opened.inviteId, expiresAt: opened.expiresAt }
    : { ok: false, reason: opened?.message ?? '邀请簿记写入失败——邀请未发出' };
}

function withdrawInitialInviteRecordOf(state, collabId, inviteId) {
  const withdraw = state.join?.withdrawInitialInvite;
  if (typeof withdraw !== 'function') {
    return;
  }
  const withdrawn = withdraw({ collabId, inviteId });
  if (withdrawn?.ok !== true) {
    state.log.warn('未投递邀请的簿记撤回失败（记录可能仍为 open）', {
      collabId,
      inviteId,
      reason: withdrawn?.reason ?? '撤回面未返回结果',
    });
  }
}

function initialInvitePayloadOf(state, ledger, target, collabMode, local, inviteId) {
  const payload = applyInviteNaming(invitePayloadOf(ledger, [], forumEndpointsOf(collabMode, local)), target);
  if (collabMode === 'forum') {
    payload.originator = { instanceId: state.self.instanceId, identityName: state.self.identityName };
    return payload;
  }
  if (inviteId !== undefined) {
    payload.inviteId = inviteId;
  }
  return payload;
}

/* 返回条目：inviteId/expiresAt 是加法字段，既有 instanceId/ok/msgId/reason 不变。 */
function invitedEntryOf(target, opened, result) {
  const entry = { instanceId: target.instanceId, ok: result.ok === true, msgId: result.msgId, reason: result.reason };
  if (opened.inviteId !== undefined) {
    entry.inviteId = opened.inviteId;
    entry.expiresAt = opened.expiresAt;
  }
  return entry;
}

/* 指名会话随邀请帧（会话级加入 §3 发送面）：targets 项带 targetSessionId 即写入载荷顶层
 * payload.targetSessionId——接收侧据此只投该会话（不在场＝登记挂起、该会话注册时补投），
 * 且只有它能点头；省略＝不指名（照旧投目标机全部活跃会话，谁点头谁承接）。
 * 旧版对端忽略该加法字段，按未指名处理（等同不指名，如实）。 */
function applyInviteNaming(payload, target) {
  if (typeof target?.targetSessionId === 'string') {
    payload.targetSessionId = target.targetSessionId;
  }
  /* targets 是邀请帧的标准目标描述（唯一性键 instanceId + targetSessionId）：接收侧据此核对
   * 目标机器/指名会话，旧字段 targetSessionId 仍随带作兼容与投递过滤。 */
  payload.targets = [{ instanceId: target.instanceId, ...(typeof target.targetSessionId === 'string' ? { targetSessionId: target.targetSessionId } : {}) }];
  return payload;
}

/* 讨论邀请随带的端点表（设计 §5.1：现成员表与端点表——被邀者据此取得寻址信息）；managed 不带。 */
function forumEndpointsOf(mode, local) {
  return mode === 'forum' ? Object.fromEntries(local.endpoints) : null;
}

/* 新建台账（共享名单形态：active-only 席位、managerTerm、joinSeqNext；模式创建时定死）。
 * 受邀目标不写入共享名单——邀请簿记归 invites/pending-invites，真正入席（两段式确认）后才成席位；
 * 名单出现非 member 行会被载入校验判损坏（设计 §2.1/§4）。讨论模式发起人同样是 manager 记录，
 * 只是不参与移交流程。 */
function freshLedgerOf(state, name, topic, mode, sessionId) {
  const now = new Date().toISOString();
  return {
    version: 1,
    collabId: newCollabId(),
    name,
    topic,
    mode,
    status: 'proposed',
    managerTerm: 1,
    manager: { instanceId: state.self.instanceId, sessionId, identityName: state.self.identityName, term: 1 },
    joinSeqNext: 2,
    members: [
      {
        instanceId: state.self.instanceId,
        sessionId,
        identityName: state.self.identityName,
        role: mode === 'forum' ? 'member' : 'manager',   // 讨论无站长：名单行不得带 manager 角色
        state: 'member',
        joinSeq: 1,
        joinedAt: now,
      },
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
export function inviteMembers(state, { collabId, targets, sessionId }) {
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
  const sender = inviteSenderSeatOf(local, sessionId);
  if (sender.ok !== true) {
    return { ok: false, message: sender.reason };
  }
  return localModeOf(local) === 'forum'
    ? inviteForumMembers(state, local, targets, sender.sessionId)
    : inviteManagedMembers(state, local, targets, sender.sessionId);
}

/* 讨论邀请（既有路径保持不变）：任何成员可发起；名额数据源＝折叠成员表（被拒/被撤回者不占名额）。 */
function inviteForumMembers(state, local, targets, fromSessionId) {
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
    const payload = applyInviteNaming(forumInvitePayloadOf(state, local, topic), target);
    const result = sendTo(state, local.collabId, target.instanceId, { address: target.address, port: target.port }, 'invite', payload, { fromSessionId });
    invited.push({ instanceId: target.instanceId, ok: result.ok === true, msgId: result.msgId, reason: result.reason });
    state.counters.invitesSent++;
  }
  return { ok: true, collabId: local.collabId, invited };
}

/* 协作增员（站长制）：目标机器已有活跃席位＝如实拒——该机器的新会话应走 ws_join 申请
 * （站长批准走 join-grant，不扰动既有席位行）。邀请只写 invites/pending-invites（邀请簿记），
 * **不写共享台账**：名单只允许 state=member 的活跃席位，受邀未入席者不是成员。
 * 每个目标先开邀请记录再发帧（设计 §4.1/§4.4）：帧携 inviteId，受邀会话才能走 approve 两段式；
 * 簿记写失败不发，发送失败撤回该条——不留「可接受却无人投递」的 open 记录。 */
function inviteManagedMembers(state, local, targets, fromSessionId) {
  if (local.role !== 'manager') {
    return { ok: false, message: '只有站长可以邀请成员加入协作——成员会话请让目标走 ws_join 申请（由站长批准）' };
  }
  for (const target of targets) {
    const held = local.ledger.members.find((entry) => entry.instanceId === target.instanceId);
    if (held !== undefined) {
      return { ok: false, message: `目标已在协作名单内（${target.identityName ?? target.instanceId}）——其新会话请走 ws_join 申请（或由站长批准）` };
    }
  }
  if (local.ledger.members.length + targets.length > MAX_COLLAB_MEMBERS) {
    return { ok: false, message: `协作成员已达上限（${MAX_COLLAB_MEMBERS}）——不再发起新邀请` };
  }
  const base = invitePayloadOf(local.ledger, [], null);
  const invited = [];
  for (const target of targets) {
    invited.push(inviteManagedTargetOf(state, local, base, target, fromSessionId));
    state.counters.invitesSent++;
  }
  return { ok: true, collabId: local.collabId, invited };
}

/* 单个目标：先开邀请记录再发帧；簿记写失败不发，发送失败撤回该条。返回条目始终携带可追溯的
 * inviteId（发送失败时仍能定位被撤回的那条）。 */
function inviteManagedTargetOf(state, local, base, target, fromSessionId) {
  const opened = initialInviteRecordOf(state, local.collabId, target, fromSessionId);
  if (opened.ok !== true) {
    return { instanceId: target.instanceId, ok: false, reason: opened.reason };
  }
  const payload = applyInviteNaming({ ...base, members: base.members.map((entry) => ({ ...entry })) }, target);
  if (opened.inviteId !== undefined) {
    payload.inviteId = opened.inviteId;
  }
  const result = sendTo(state, local.collabId, target.instanceId, { address: target.address, port: target.port }, 'invite', payload, { fromSessionId });
  if (result.ok !== true && opened.inviteId !== undefined) {
    withdrawInitialInviteRecordOf(state, local.collabId, opened.inviteId);
  }
  return invitedEntryOf(target, opened, result);
}

/* 讨论邀请载荷（发送侧公共构造）：名/主题/模式 + **发起人实例标识（中继归属）** +
 * **折叠成员表的席位条目** + 现端点表。目标机器另由 targets 描述（设计 §2.2），不要求出现在
 * members 中——成员条目必须能通过协议层的席位键校验。
 * 发起人标识随最新邀请定格（中继归属不得由邀请者推断——邀请者≠发起人）；本机未知时省略
 * （不臆造——被邀者按「中继未知」降级直投，待对表补学）。 */
function forumInvitePayloadOf(state, local, topic) {
  const members = forumSeatEntriesOf(local);
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

/* 邀请名单条目（设计 D13/§2.2）：折叠成员表按席位键去重后转协议条目；缺 sessionId 的旧事件
 * 不编造条目——协议层要求每项 instanceId + sessionId + identityName，混入残缺条目会让整帧被拒。
 * 本次邀请的目标机器另由 targets 描述，不要求出现在 members 中。 */
function forumSeatEntriesOf(local) {
  const seen = new Set();
  const members = [];
  for (const member of foldedMembersOf(local)) {
    const entry = seatEntryOf(member);
    if (typeof entry.sessionId !== 'string') {
      continue;
    }
    const key = `${entry.instanceId}\u0000${entry.sessionId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    members.push(entry);
  }
  return members;
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
 * 获准台账不在此处写：joins.json 的单一写者是加入域（v2 整档写），本模块只经加入域接口使用。 */
function applyInviteDecision(state, local, approve, wanted, reason, sessionId) {
  const result = localModeOf(local) === 'forum'
    ? decideForumInvite(state, local, wanted, reason, sessionId)
    : sendDecision(state, local, approve, wanted, reason, sessionId);
  if (wanted !== 'approved' || result.ok !== true) {
    return result;
  }
  const wrote = applyDefaultMute(state, local, sessionId);   // 写点二：同意加入成功
  state.openViewer?.({ root: state.viewerRoot, id: local.collabId });   // 触发 A：同意入席即开该协作页（开关在出口内现读）
  /* 提醒只在本次真的写了静音时给：幂等重入的早返回根本到不了这里（本次什么都没写），
   * 说「已默认静音」会与事实相反。 */
  return wrote ? { ...result, notice: DEFAULT_MUTE_NOTICE } : result;
}

/* 讨论的邀请回应（设计 §5.1/§5.4）：同意 = 加入**立即生效**——本地转进行中、自播 join
 * （携身份；端点经既有学习面散布）、未收敛前递增间隔重播；生效不依赖邀请者在场。
 * approve/decline 帧仍发回邀请者作簿记（best-effort——端点未知不构成失败）。
 * joined 标记供服务层在加入后驱动一轮回填对表（显式契约，不越模块边界）。 */
function decideForumInvite(state, local, wanted, reason, sessionId) {
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
    upgradeInviteStubCarrier(state, local, sessionId);
    const event = emitOwnMemberEvent(state, local, 'join', sessionId);
    if (event !== null) {
      state.counters.forumJoinsOut++;
      startJoinReplay(state, local, event, sessionId);
    }
  }
  const bookkeeping = sendInviteBookkeeping(state, local, wanted, validated.reason, sessionId);
  state.counters.decisionsSent++;
  return { ok: true, decision: wanted, joined: wanted === 'approved', bookkeeping };
}

/* 讨论邀请的落点从 invite-stub 升为 session-seats（设计 §4.2）：论坛没有两段式 grant，
 * 同意即入席；不升级则该目录重启后仍按邀请占位读取，参与不会被加载。保留 stub 已有的
 * 元数据（创建时间/发起人/讨论元信息），只补入席后的必需面。 */
function upgradeInviteStubCarrier(state, local, sessionId) {
  const dir = collabDir(state.dataDir, local.collabId);
  const base = inviteStubCarrierOf(dir);
  if (base === null) {
    return false;
  }
  try {
    writeCarrier(dir, sessionSeatsCarrierFrom(state, local, base));
  } catch (error) {
    state.counters.inviteCarrierUpgradeFailures = (state.counters.inviteCarrierUpgradeFailures ?? 0) + 1;
    state.log.warn('邀请占位载体升级失败（重启后该参与可能不被加载）', { collabId: local.collabId, reason: error?.message });
    return false;
  }
  ensureJoinedSeatOf(state, local, sessionId);
  state.counters.inviteCarriersUpgraded = (state.counters.inviteCarriersUpgraded ?? 0) + 1;
  return true;
}

/* 入席必需面：判档要求载体之外还有「已参与」证据（席位或快照）——论坛没有快照，
 * 补一条本会话席位使目录重启后按 session-seats 正常加载。 */
function ensureJoinedSeatOf(state, local, sessionId) {
  const target = typeof sessionId === 'string' && sessionId !== '' ? sessionId : firstActiveSessionIdOf(local);
  if (typeof target !== 'string' || target === '') {
    return;
  }
  upsertLocalSeat(local, {
    sessionId: target,
    role: 'member',
    state: 'member',
    joinSeq: 1,
    joinedAt: new Date().toISOString(),
    muted: true,
  }, { persist: true, dataDir: state.dataDir, bridgeId: bridgeIdOfSession(state, target) });
}

function inviteStubCarrierOf(dir) {
  const held = readCarrier(dir);
  if (held.status !== 'ok' || held.carrier === null) {
    return null;
  }
  return held.carrier.format === CARRIER_FORMAT_INVITE_STUB ? held.carrier : null;
}

function sessionSeatsCarrierFrom(state, local, base) {
  const member = local.member ?? {};
  return {
    ...base,
    format: CARRIER_FORMAT_SESSION_SEATS,
    name: nonEmptyTextOr(member.name, base.name),
    topic: nonEmptyTextOr(member.topic, base.topic),
    mode: localModeOf(local),
    endpoints: Object.fromEntries(local.endpoints ?? []),
    snapshotVersion: local.snapshot?.version ?? 0,
  };
}

function nonEmptyTextOr(value, fallback) {
  return typeof value === 'string' && value !== '' ? value : fallback;
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
function sendInviteBookkeeping(state, local, wanted, reason, sessionId) {
  const managerId = local.member.manager?.instanceId;
  const endpoint = typeof managerId === 'string' ? local.endpoints.get(managerId) : undefined;
  if (endpoint === undefined) {
    return { delivered: false, reason: '邀请者端点未知（簿记帧未发出——加入 / 拒绝已本地生效）' };
  }
  const payload = wanted === 'approved' || reason === undefined ? {} : { reason };
  const sent = sendTo(state, local.collabId, managerId, endpoint, wanted === 'approved' ? 'approve' : 'decline', payload, { fromSessionId: sessionId });
  return { delivered: sent.ok === true, msgId: sent.msgId, reason: sent.reason };
}

/* 决策发帧：先定格 decision（本地状态即真相），再入队；邀请者端点未知给出明确指引。
 * 拒绝原因按协议呈现判据先行校验（超限 / 换行在入队侧会被拒——不得先定格、后静默失败）。 */
function sendDecision(state, local, approve, wanted, reason, sessionId) {
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
  const sent = sendTo(state, local.collabId, local.member.manager.instanceId, endpoint, approve ? 'approve' : 'decline', payload, { fromSessionId: sessionId });
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

export async function sendMessage(state, { collabId, text, type, to, toSessionId, sessionId }) {
  const local = state.collabs.get(collabId);
  if (local === undefined) {
    return { ok: false, message: '本机没有该协作（先 ws_list_collabs）' };
  }
  if (local.suspended !== null) {
    return { ok: false, message: '协作对外写已暂停（在途抢接或未能对表）——收敛后恢复' };
  }
  if (localModeOf(local) === 'forum') {
    if (typeof toSessionId === 'string' && toSessionId !== '') {
      return { ok: false, message: '讨论不设定向消息（toSessionId 仅协作模式可用）' };
    }
    return await sendForumPost(state, local, { text, type, to, sessionId });
  }
  return sendManagedMessage(state, local, { text, type, to, toSessionId, fromSessionId: sessionId });
}

/* 协作模式的发送路径（星型路由与状态门控；讨论模式的发帖路径见 sendForumPost）。 */
async function sendManagedMessage(state, local, { text, type, to, toSessionId, fromSessionId }) {
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
  /* 有运行时席位表时必须显式指定发送会话（设计 §1.2「无 sessionId 的调用拒绝」）：
   * 缺省兜底会把成员消息署成站长或替调用方猜席位，发送身份可被顶替。无席位表的旧单席记录
   * （会话级运行时尚未接线的历史数据）仍按成员记录兼容签名。 */
  const sender = resolveSenderSeat(local, fromSessionId, { requireExplicit: localSeatsOf(local).length > 0 });
  if (sender.ok !== true) {
    return { ok: false, message: sender.reason };
  }
  const routed = recipientsOf(state, local, to, toSessionId, sender.sessionId);
  if (routed.error !== undefined) {
    return { ok: false, message: routed.error };
  }
  if (messageType === 'topic' && local.role === 'manager') {
    mutateLedger(state, local, (ledger) => {
      ledger.topic = text;
    });
  }
  return deliverMessage(state, local, messageType, text, routed.targets, sender.sessionId);
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

/* 按机器分组的发送与结果归并（部分成功按成功返回；全部失败给出逐机器原因）。
 * 本机目标走旁路注入（不经 dispatch.send），远端每机器一帧、帧携 toSessions（D11）。 */
async function deliverMessage(state, local, type, text, targets, fromSessionId) {
  const payload = payloadOf(type, text);
  const sent = await sendToSeats(state, { collabId: local.collabId, fromSessionId, type, payload, targets });
  if (sent.ok !== true) {
    return { ok: false, message: `消息未入队（${failuresTextOf(sent)}）` };
  }
  const delivered = sent.results.filter((entry) => entry.ok === true);
  const failed = sent.results.filter((entry) => entry.ok !== true);
  return {
    ok: true,
    msgId: delivered.find((entry) => typeof entry.msgId === 'string')?.msgId,
    tier: 'queued',
    to: delivered.map((entry) => entry.instanceId),
    /* 逐机器结果保留全部条目（成功带 msgId、失败带 reason）：部分失败不得被「ok:true」吞掉。 */
    results: sent.results.map((entry) => ({
      instanceId: entry.instanceId,
      sessionIds: entry.sessionIds,
      ok: entry.ok === true,
      msgId: entry.msgId,
      local: entry.local === true,
      reason: entry.reason,
      results: entry.results,
    })),
    ...(failed.length === 0 ? {} : { failed: failed.map((entry) => ({ instanceId: entry.instanceId, reason: entry.reason ?? '未知原因' })) }),
    note: failed.length === 0
      ? '已排队（对方离线时后台重试、对方重开后送达；档位可用 ws_delivery_status 查询）'
      : `部分目标未受理（${failuresTextOf(sent)}）；其余已排队，档位可用 ws_delivery_status 查询`,
  };
}

/* 失败原因归并（逐机器）：全部失败时给调用方可读的拒绝原因。 */
function failuresTextOf(sent) {
  const reasons = sent.results.filter((entry) => entry.ok !== true).map((entry) => entry.reason ?? '未知原因');
  return reasons.length === 0 ? sent.reason ?? '未知原因' : reasons.join('；');
}

/* 讨论模式发帖（设计 §5.2）：to 一律拒绝（讨论不设定向）；kind 按徽标词表、text 沿消息文本
 * 上限（不走 topic/stop 的呈现限制、不触发 task 的 taskId 分支）；先本地落列（postId / 序号 /
 * ts 分配即定）再按路由投递——帖的事务点在本机列表，投递失败不回滚（收敛由拉取兜底）。
 * 帖不进会话注入以外的任何元状态面：topic 帖亦按普通帖处理（主题创建时定死）。
 * 路由 = 中继分发（默认）/ 直接扇出（中继本机）/ 降级直投（中继不可达或未知，见 routeForumPost）。 */
async function sendForumPost(state, local, { text, type, to, sessionId }) {
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
  const sender = forumPostSenderOf(state, local, text, sessionId);
  if (sender.ok !== true) {
    return { ok: false, message: sender.message };
  }
  const post = allocateOwnPost(state, local, kind, text);
  const routed = await routeForumPost(state, local, post, sender.sessionId);
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

/* 发帖前置与签发席位：成员资格、正文、发送席位三查都必须在分配 post 之前。发帖也是成员会话的
 * 行为——有运行时席位表时必须显式给本机活跃席位：缺标识会把「调用者没穿会话」误报成中继降级，
 * 冒名会话则会拿别人的席位盖章直投。 */
function forumPostSenderOf(state, local, text, sessionId) {
  if (!selfJoinedOf(local, state.self.instanceId)) {
    return { ok: false, message: '本机尚未加入该讨论（等待邀请或先回应邀请）——加入后才能发言' };
  }
  const textRejection = textRejectionOf('reply', text);
  if (textRejection !== null) {
    return { ok: false, message: textRejection };
  }
  const sender = resolveSenderSeat(local, sessionId, { requireExplicit: localSeatsOf(local).length > 0 });
  return sender.ok === true ? sender : { ok: false, message: sender.reason };
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
async function routeForumPost(state, local, post, fromSessionId) {
  const relay = relayPeerOf(local, state.self);
  if (relay === null) {
    return degradedRoute(state, local, post, '中继未知（发起人标识尚未学到）——先直投，待邀请/对表补学后自动回中继', fromSessionId);
  }
  if (relay.instanceId === state.self.instanceId) {
    return {
      route: 'fanout',
      results: fanOutPost(state, local, post, fromSessionId),
      note: '已直接扇出（本机即中继）——在线尽力 + 短重试，不落持久队列；未达者由对方周期对表拉取收敛',
    };
  }
  const fallback = relayFallbackReason(state, local, relay);
  if (fallback !== null) {
    return degradedRoute(state, local, post, fallback, fromSessionId);
  }
  const endpoint = endpointFor(state, local, relay.instanceId);
  const verdict = await relayVerdict(state, endpoint);
  if (verdict.ok !== true) {
    state.relayDown.add(local.collabId);
    state.counters.relayDegrades++;
    return degradedRoute(state, local, post, `${verdict.reason}——已当场降级直投`, fromSessionId);
  }
  const submitted = submitToRelay(state, local, relay, endpoint, post, fromSessionId);
  if (submitted.ok === true) {
    state.counters.relayPostsSent++;
    return {
      route: 'relay',
      results: [submitted],
      note: `已发中继（发起人 ${relay.identityName}）——成员级投递结果由中继聚合捎回（尽力而为）；离线成员待对表收敛；「已投进对方会话」≠ 已读`,
    };
  }
  return degradedRoute(state, local, post, `投稿未受理（${submitted.reason}）`, fromSessionId);
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
function submitToRelay(state, local, relay, endpoint, post, fromSessionId) {
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
    fromSessionId,
  });
  return { instanceId: relay.instanceId, ok: sent.ok === true, msgId: sent.msgId, reason: sent.reason };
}

/* 降级直投一帖（设计 §5.2「当场降级=对全成员直投」，复用既有直投通道）：帖已落本机列表，
 * 直投对端点已知成员逐份发出；未达者由对表收敛。两态可观测：降级帖计数 + 结果逐目标标注。 */
function degradedRoute(state, local, post, reason, fromSessionId) {
  state.counters.relayDegradedPosts++;
  return {
    route: 'degraded',
    results: fanOutPost(state, local, post, fromSessionId),
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
  if (typeof frame.from.sessionId === 'string') {
    origin.sessionId = frame.from.sessionId;
  }
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
    const sent = sendTo(state, collabId, author.instanceId, endpoint, 'delivery-status', { refMsgId: originMsgId, tier: 'session' }, {
      fromSessionId: firstActiveSessionIdOf(local) ?? undefined,
    });
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
function fanOutPost(state, local, post, fromSessionId) {
  const results = [];
  for (const entry of forumRecipientsOf(state, local)) {
    results.push(deliverPostTo(state, local, entry.instanceId, post, fromSessionId));
  }
  return results;
}

/* 帖的收件人 = 折叠成员表（除本机）：被拒 / 被撤回 / 已退出者不收帖——成员语义的单一取数面
 * （名单口径含 invited 的临时形态就此勘正——被拒/被撤回/已退出者不收帖）。 */
function forumRecipientsOf(state, local) {
  return foldedMembersOf(local).filter((entry) => entry.instanceId !== state.self.instanceId);
}

function deliverPostTo(state, local, instanceId, post, fromSessionId) {
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
    fromSessionId,
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
    return endProposedManaged(state, local, collabId);
  }
  if (status !== 'active' && status !== 'frozen') {
    return { ok: false, message: '协作已结束（或已终止）' };
  }
  mutateLedger(state, local, (ledger) => {
    ledger.status = 'completed';
    ledger.endedAt = new Date().toISOString();
    /* 终态形态（设计 §3.4/D17）：manager 必须为 null，名单不得残留站长行，窗口不得保留。
     * 名单行降为 member 而非清空：终态快照与 end 通告仍要投给原参与者（投递面在清空后会丢收件人）。 */
    ledger.manager = null;
    delete ledger.managerWindow;
    for (const member of ledger.members) {
      member.role = 'member';
    }
  });
  local.member.state = 'completed';
  local.member.archivedAt = new Date().toISOString();
  persistMember(state, local);
  stopJoinReplay(state, local);
  broadcastCollabEnd(state, local, collabId);   // 双通道之一：在线广播（豁免 TTL/上限）
  state.counters.ended++;
  return { ok: true };
}

/* proposed managed 的取消（设计 §3.4 用户裁定）：协作尚未建立、名单只有创建者，创建者会话可
 * 直接收尾——台账转 terminated 终态、撤回全部 open 邀请记录、向已知邀请目标广播 end。
 * 不删除协作目录 / 席位文件 / 邀请记录：终态与撤回态本身是留痕，删除属用户数据删除。
 * 非创建者会话的拒绝在服务层按席位完成（seatGovernedWrite），本函数只管创建者路径。 */
function endProposedManaged(state, local, collabId) {
  if (localModeOf(local) !== 'managed') {
    return { ok: false, message: '协作尚未建立——取消请用 ws_withdraw_invite（整条撤回）' };
  }
  const targets = knownInviteTargetsOf(state, collabId);
  mutateLedger(state, local, (ledger) => {
    ledger.status = 'terminated';
    ledger.endedAt = new Date().toISOString();
    /* 终态形态（设计 §3.4）：manager 必须为 null，名单不得残留站长行，窗口不得保留。 */
    ledger.manager = null;
    delete ledger.managerWindow;
    for (const member of ledger.members) {
      member.role = 'member';
    }
  });
  local.member.state = 'terminated';
  local.member.archivedAt = new Date().toISOString();
  persistMember(state, local);
  stopJoinReplay(state, local);
  withdrawOpenInvitesOf(state, collabId);
  broadcastEndToInviteTargets(state, local, targets);
  state.counters.ended++;
  return { ok: true };
}

/* 已知邀请目标（end 广播的收件人）：邀请记录的全量目标（含已撤回，收件侧无记录时幂等忽略）。
 * 记录文件是邀请目标的唯一权威面——proposed 台账的名单只有创建者，拿名单取收件人会漏发。 */
function knownInviteTargetsOf(state, collabId) {
  const targets = new Set();
  for (const record of inviteRecordsOf(state, collabId)) {
    for (const target of record.targets) {
      if (target.instanceId !== state.self.instanceId) {
        targets.add(target.instanceId);
      }
    }
  }
  return [...targets];
}

function inviteRecordsOf(state, collabId) {
  return createInvitesFileStore({ dataDir: state.dataDir, collabId, log: state.log }).list();
}

/* 撤回该协作全部 open 邀请记录：经加入域的撤回面落笔（in-memory 账与文件同源，避免另一处
 * 缓存的 open 记录在后续保存时复活）。无加入域的单元装配没有 0.2.0 邀请记录，如实跳过。 */
function withdrawOpenInvitesOf(state, collabId) {
  const open = inviteRecordsOf(state, collabId).filter((record) => record.state === 'open');
  const withdraw = state.join?.withdrawInitialInvite;
  if (typeof withdraw !== 'function') {
    if (open.length > 0) {
      state.log.warn('取消协作时缺少加入域撤回面（open 邀请记录未撤回）', { collabId, count: open.length });
    }
    return;
  }
  for (const record of open) {
    const withdrawn = withdraw({ collabId, inviteId: record.inviteId });
    if (withdrawn?.ok !== true) {
      state.log.warn('取消协作时撤回邀请记录失败（记录可能仍为 open）', {
        collabId,
        inviteId: record.inviteId,
        reason: withdrawn?.reason ?? '撤回面未返回结果',
      });
    }
  }
}

function broadcastEndToInviteTargets(state, local, instanceIds) {
  const fromSessionId = managerSessionIdOf(local) ?? undefined;
  for (const instanceId of instanceIds) {
    const endpoint = endpointFor(state, local, instanceId);
    if (endpoint === undefined) {
      continue;
    }
    sendTo(state, local.collabId, instanceId, endpoint, 'end', {}, { fromSessionId });
  }
}

/* 结束广播（设计 §5.5 控制事件类；end 豁免 TTL/上限）：讨论经折叠成员表出口（端点未知者
 * 跳过计数），managed 沿既有名册出口（仅端点已知者，快照与通告兜底可见性）。 */
function broadcastCollabEnd(state, local, collabId) {
  if (localModeOf(local) === 'forum') {
    broadcastToForumMembers(state, local, 'end', {});
    return;
  }
  const fromSessionId = managerSessionIdOf(local) ?? undefined;
  for (const instanceId of memberIdsOf(state, local)) {
    const endpoint = local.endpoints.get(instanceId);
    if (endpoint !== undefined) {
      sendTo(state, collabId, instanceId, endpoint, 'end', {}, { fromSessionId });
    }
  }
}

export function leaveCollab(state, { collabId, sessionId }) {
  const local = state.collabs.get(collabId);
  if (local === undefined) {
    return { ok: false, message: '本机没有该协作' };
  }
  if (localModeOf(local) === 'forum') {
    return leaveForum(state, local, sessionId);
  }
  if (local.role === 'manager') {
    return { ok: false, message: '站长席位不可退出——请先结束协作（显式交接属治理事项）' };
  }
  if (isLocalArchivedState(local)) {
    return { ok: false, message: '协作已结束（或已退出）' };
  }
  const fromSessionId = sessionId ?? firstActiveSessionIdOf(local) ?? undefined;
  const delivered = deliverLeaveOfSeat(state, local, collabId, fromSessionId);
  local.member.state = 'left';
  local.member.archivedAt = new Date().toISOString();
  persistMember(state, local);
  state.counters.left++;
  /* 站长不可达（无端点或发送失败）且本机最后一人离席：写本地只读终态副本（设计 §3.4），
   * 不冒充权威台账——权威台账仍归站长机，恢复接触后由更高版本快照覆盖。 */
  if (!delivered && isLastLocalSeatLeaving(local, fromSessionId)) {
    writeLocalTerminalCopy(state, local);
  }
  return { ok: true, delivered };
}

/* 离席的两条落地面：本机就是站长核时由本核移除共享名单行（设计 §3.2）；否则把 leave 帧
 * 定向发给现任站长。返回离席事实是否已交付（本核写名单视为已交付）。 */
function deliverLeaveOfSeat(state, local, collabId, sessionId) {
  if (removeOwnRosterRowOnManagerCore(state, local, sessionId)) {
    return true;
  }
  const managerId = local.member.manager.instanceId;
  const endpoint = local.endpoints.get(managerId);
  return endpoint !== undefined && sendTo(state, collabId, managerId, endpoint, 'leave', {}, { fromSessionId: sessionId }).ok === true;
}

/* 站长核上的成员席位离席：移除共享名单行、追加 leave 事件、广播名单版本（设计 §3.2）。
 * 只处理本机成员席位（站长席位走自动移交，不在这里删行）。返回是否由本核完成写入。 */
function removeOwnRosterRowOnManagerCore(state, local, sessionId) {
  if (local.ledger === null || typeof sessionId !== 'string' || sessionId === '') {
    return false;
  }
  const row = local.ledger.members.find((member) => member.instanceId === state.self.instanceId
    && member.role !== 'manager'
    && member.sessionId === sessionId);
  if (row === undefined) {
    return false;
  }
  const applied = mutateLedger(state, local, (ledger) => {
    ledger.members = ledger.members.filter((member) => member !== row);
    ledger.events = [...(Array.isArray(ledger.events) ? ledger.events : []), {
      type: 'leave',
      seat: { instanceId: row.instanceId, sessionId: row.sessionId, identityName: row.identityName },
      reason: 'left',
      term: ledgerTermOf(ledger),
      at: new Date().toISOString(),
    }];
  });
  if (applied === null) {
    return false;
  }
  releaseJoiningOfSeat(state, local.collabId, row.sessionId);
  sendRosterVersion(state, local);
  state.counters.rostersLocalLeave++;
  return true;
}

function releaseJoiningOfSeat(state, collabId, sessionId) {
  try {
    state.join?.releaseJoining?.(collabId, sessionId);
  } catch (error) {
    state.counters.eventFailures++;
    state.log.warn('未确认入席记录释放失败（已隔离）', { collabId, sessionId, reason: error?.message });
  }
}

/* 名单版本通告（managed）：一机一帧，除本机与站长签发席位外逐个已知端点发送。 */
function sendRosterVersion(state, local) {
  const fromSessionId = managerSessionIdOf(local) ?? undefined;
  const notified = new Set();
  for (const member of local.ledger.members) {
    if (member.instanceId === state.self.instanceId || notified.has(member.instanceId)) {
      continue;
    }
    notified.add(member.instanceId);
    const endpoint = local.endpoints.get(member.instanceId);
    if (endpoint !== undefined) {
      sendTo(state, local.collabId, member.instanceId, endpoint, 'notice', { event: 'roster', version: local.ledger.version }, { fromSessionId });
    }
  }
}

/* 本次离席后本机是否再无席位：会话级席位表是权威；无席位表的旧单席记录按整机唯一成员处理。 */
function isLastLocalSeatLeaving(local, leavingSessionId) {
  const seats = localSeatsOf(local);
  if (seats.length === 0) {
    return true;
  }
  return seats.length === 1 && seats[0].sessionId === leavingSessionId;
}

/* 讨论退出（设计 §5.4/§6/§9.1）：leave 事件照走（自播广播、豁免 TTL/上限）；**发起人同普通成员**
 * ——退出即放弃结束权与中继职责（中继无迁移：退出后讨论进入无中继直投、无人可 end 的自然消亡
 * 形态；结束权守卫在 endCollab，本机归档后调用被拒属状态面）。退出后讨论存续；本机归档，不再对表与重播。 */
function leaveForum(state, local, sessionId) {
  if (isLocalArchivedState(local)) {
    return { ok: false, message: '讨论已结束（或已退出）' };
  }
  stopJoinReplay(state, local);
  const event = emitOwnMemberEvent(state, local, 'leave', sessionId ?? firstActiveSessionIdOf(local) ?? undefined);
  if (event !== null) {
    state.counters.forumLeavesOut++;
  }
  const delivered = event === null ? 0 : broadcastMemberEvent(state, local, 'leave', event, sessionId ?? firstActiveSessionIdOf(local) ?? undefined);
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
    sendSnapshotRequest(state, local, collabId, managerId, endpoint);
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

/* 快照推送（设计 §8）：每次台账变更推全体成员（除本机）——按机器分组，一机一帧并携 toSessions
 * （D11 机器级记账：同机多席不得各收一帧、不得产生多个 msgId）。端点已知者入可靠队列；
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
  const fromSessionId = managerSessionIdOf(local) ?? undefined;
  const payload = snapshotDataPayloadOf(frozen, local.snapshot.digest);
  for (const [instanceId, sessionIds] of snapshotGroupsOf(state, local)) {
    const endpoint = local.endpoints.get(instanceId);
    if (endpoint === undefined) {
      state.counters.snapshotSkipped++;
      continue;
    }
    sendTo(state, local.collabId, instanceId, endpoint, 'snapshot', payload, {
      fromSessionId,
      ...(sessionIds.length > 0 ? { toSessions: sessionIds } : {}),
    });
    state.counters.snapshotSent++;
  }
}

/* 名单按机器分组（D11「一机一帧」）：同机多席合成一帧并携 toSessions；本机行跳过。
 * 旧行缺 sessionId 时该机器仍收一帧但不收窄目标（接收核按活跃席位扇出）。 */
function snapshotGroupsOf(state, local) {
  const groups = new Map();
  for (const member of local.ledger.members) {
    if (member.instanceId === state.self.instanceId) {
      continue;
    }
    const sessions = groups.get(member.instanceId) ?? [];
    if (typeof member.sessionId === 'string' && !sessions.includes(member.sessionId)) {
      sessions.push(member.sessionId);
    }
    groups.set(member.instanceId, sessions);
  }
  return groups;
}

/* 快照数据帧（协议形态）：managerTerm / version / digest / ledger 必填；managerWindow 与台账
 * 任一侧存在即须一致（受理由协议层按同口径校验）。 */
function snapshotDataPayloadOf(ledger, digest) {
  return {
    kind: 'data',
    managerTerm: ledger.managerTerm,
    version: ledger.version,
    digest,
    ledger,
    ...(ledger.managerWindow === undefined ? {} : { managerWindow: ledger.managerWindow }),
  };
}

/* 快照请求帧（协议形态）：managerTerm / version 是请求方的已知基线。本机尚无台账/快照基线时
 * 不编造——跳过并计数，等对表/首份快照建立基线后再请求。 */
function snapshotRequestPayloadOf(local) {
  const ledger = local.role === 'manager' ? local.ledger : local.snapshot?.ledger;
  if (ledger === undefined || ledger === null) {
    return null;
  }
  if (!Number.isInteger(ledger.managerTerm) || ledger.managerTerm < 1 || !Number.isInteger(ledger.version)) {
    return null;
  }
  return { kind: 'request', managerTerm: ledger.managerTerm, version: ledger.version };
}

/* 发送包装（注入的 dispatch.send 的统一入口）：结果只计数不抛出——协作操作不因单条入队失败而回滚。
 * options.from：转达帧的原发身份（治理转达原样携带发起者 from——身份语义定义在 from 上，
 * 不得改写为转达者；普通发送不携带，由发送侧以本机身份盖章）。 */
export function sendTo(state, collabId, instanceId, endpoint, type, payload, options = {}) {
  const message = { collabId, to: { instanceId, address: endpoint.address, port: endpoint.port }, type, payload };
  if (options.from !== undefined) {
    message.from = options.from;
  }
  /* 发送席位：显式优先（转达帧的 from.sessionId 即原发席位）；缺省只接受「本机恰一席 / 旧单席
   * 记录」这一无歧义情形——不再按站长身份兜底（同机多席时冒名会把成员消息署成站长）。 */
  const fromSessionId = options.fromSessionId ?? defaultSenderSessionOf(state, collabId);
  if (fromSessionId !== undefined) {
    message.fromSessionId = fromSessionId;
  }
  if (options.toSessions !== undefined) {
    message.toSessions = options.toSessions;
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

/* 缺省发送席位的窄口径：本机恰一席才采用；多席必须显式穿参（无 sessionId 不再猜站长）。
 * 无席位表的旧单席记录以其 sessionId 兼容。 */
function defaultSenderSessionOf(state, collabId) {
  const local = state.collabs?.get(collabId);
  if (local === undefined) {
    return undefined;
  }
  const sender = defaultSenderSeat(local, localSeatsOf(local));
  return sender.ok === true ? sender.sessionId : undefined;
}

/* 邀请签发席位：点名会话优先校验；未穿参时按模式取唯一的合法签发者——managed 只能站长席位
 * （设计 §7.1 的 invite 签发规则），forum 取本机任一活跃成员席位。 */
function inviteSenderSeatOf(local, sessionId) {
  if (typeof sessionId === 'string' && sessionId.trim() !== '') {
    return resolveSenderSeat(local, sessionId, { requireExplicit: true });
  }
  if (localModeOf(local) === 'managed') {
    const manager = managerSessionIdOf(local);
    return manager === null
      ? { ok: false, reason: '站长席位未知（等待对表）——无法签发邀请' }
      : { ok: true, sessionId: manager };
  }
  const member = firstActiveSessionIdOf(local);
  return member === null
    ? { ok: false, reason: '本机没有活跃席位——无法签发邀请' }
    : { ok: true, sessionId: member };
}

/* 站长席位会话：运行态席位优先，其次旧成员记录 / 台账 manager 行。 */
function managerSessionIdOf(local) {
  const seat = localSeatsOf(local).find((candidate) => candidate.role === 'manager' && candidate.state === 'member');
  if (seat !== undefined) {
    return seat.sessionId;
  }
  if (typeof local?.member?.sessionId === 'string') {
    return local.member.sessionId;
  }
  const ledgerSession = local?.ledger?.manager?.sessionId;
  return typeof ledgerSession === 'string' ? ledgerSession : null;
}

/* 本机首个活跃席位（同机多席时仅作治理/成员事件的兼容签发面；调用方应尽量显式穿参）。 */
function firstActiveSessionIdOf(local) {
  const seat = localSeatsOf(local).find((candidate) => candidate.state === 'member' && candidate.unverified !== true);
  if (seat !== undefined) {
    return seat.sessionId;
  }
  return typeof local?.member?.sessionId === 'string' ? local.member.sessionId : null;
}

/* 席位定向发送（契约发送面）：targets = [{instanceId, sessionId}]。
 * 按机器分组：本机目标逐席走旁路注入（不调用 dispatch.send），远端每机器一帧并携 toSessions。
 * 返回逐机器结果（msgId 逐机器；本机结果带 local:true）；任一机器受理即 ok。
 * 发送会话必须是本机活跃席位（member 且未标记 unverified）——非成员/未收敛一律拒绝。 */
export async function sendToSeats(state, { collabId, fromSessionId, type, payload, targets }) {
  const local = state.collabs?.get(collabId);
  if (local === undefined) {
    return { ok: false, reason: '本机没有该协作（未知 collabId）', results: [] };
  }
  /* 有席位表（运行时席位）时必须显式给 fromSessionId；无席位表的历史调用链按兼容席位兜底，
   * 避免把「会话级运行时尚未接线」误判成发送会话非法。 */
  const sender = resolveSenderSeat(local, fromSessionId, { requireExplicit: localSeatsOf(local).length > 0 });
  if (sender.ok !== true) {
    return { ok: false, reason: sender.reason, results: [] };
  }
  const groups = groupTargetsOf(targets);
  if (groups === null) {
    return { ok: false, reason: `targets 非法（须为 1–${MAX_COLLAB_MEMBERS} 项 {instanceId, sessionId?} 的目标列表）`, results: [] };
  }
  const results = [];
  for (const [instanceId, sessionIds] of groups) {
    if (instanceId === state.self.instanceId) {
      results.push(await injectLocalTargets(state, local, sender.sessionId, { type, payload, instanceId, sessionIds }));
      continue;
    }
    const endpoint = endpointFor(state, local, instanceId);
    if (endpoint === undefined) {
      results.push({ instanceId, sessionIds, ok: false, reason: '端点未知（先扫描或等对方联系）' });
      continue;
    }
    const sent = sendTo(state, collabId, instanceId, endpoint, type, payload, {
      fromSessionId: sender.sessionId,
      ...(sessionIds.length > 0 ? { toSessions: sessionIds } : {}),
    });
    results.push({ instanceId, sessionIds, ok: sent.ok === true, msgId: sent.msgId, reason: sent.reason });
  }
  const ok = results.some((entry) => entry.ok === true);
  return { ok, fromSessionId: sender.sessionId, results, ...(ok ? {} : { reason: failuresTextOf({ results }) }) };
}

/* 治理帧发送（同一分组/旁路语义，供站长变更、快照、握手等治理发送面使用）：全部目标同属机器级。 */
export async function sendGovernance(state, input) {
  return sendToSeats(state, input);
}

/* 本机旁路投递账（设计 §5.3 第 4 条）：发送核按 (msgId, sessionId) 记录本机目标的注入结果，
 * 机器级终态立即成立（不经 dispatch 队列）。内存短时保留、按插入序淘汰——查询面与持久队列分开。 */
const LOCAL_DELIVERY_MAX = 512;

function localDeliveriesOf(state) {
  if (!(state.localDeliveries instanceof Map)) {
    state.localDeliveries = new Map();
  }
  return state.localDeliveries;
}

function rememberLocalDelivery(state, { collabId, fromSessionId, type, toSessions, results, msgId, createdAt }) {
  const ledger = localDeliveriesOf(state);
  ledger.delete(msgId);
  ledger.set(msgId, {
    collabId,
    fromSessionId,
    type,
    toSessions,
    createdAt,
    outcomes: new Map(results.map((entry) => [entry.sessionId, entry.status ?? (entry.ok === true ? 'injected' : 'dropped')])),
  });
  while (ledger.size > LOCAL_DELIVERY_MAX) {
    ledger.delete(ledger.keys().next().value);
  }
}

function localDeliveryOf(state, msgId) {
  const ledger = localDeliveriesOf(state);
  return typeof msgId === 'string' ? ledger.get(msgId) ?? null : null;
}

function localDeliveryRowOf(state, msgId) {
  const entry = localDeliveryOf(state, msgId);
  if (entry === null) {
    return null;
  }
  return {
    msgId,
    collabId: entry.collabId,
    type: entry.type,
    toInstanceId: state.self.instanceId,
    fromSessionId: entry.fromSessionId ?? null,
    toSessions: entry.toSessions,
    tier: 'session',
    expired: false,
    attempts: 0,
    createdAt: entry.createdAt,
    nextAttemptAt: null,
    ackedAt: null,
    deliveredAt: entry.createdAt,
    note: '本机旁路投递（机器级终态立即成立）',
  };
}

/* 机器级投递状态（按 msgId）：本机旁路账优先，其次发送调度器的队列行；未接线返回 null。 */
export function deliveryStatusOf(state, msgId) {
  const localRow = localDeliveryRowOf(state, msgId);
  if (localRow !== null) {
    return localRow;
  }
  if (typeof state.deliveryStatusOf === 'function') {
    return state.deliveryStatusOf(msgId);
  }
  if (typeof state.dispatch?.deliveryStatusOf === 'function') {
    return state.dispatch.deliveryStatusOf(msgId);
  }
  return null;
}

/* 本机席位投递明细：本机旁路账优先；其余委托接收管线的 fanout 事实（接线注入）；
 * 未接线返回 unknown。 */
export function localSeatDeliveryOf(state, msgId, sessionId) {
  const entry = localDeliveryOf(state, msgId);
  if (entry !== null) {
    return {
      collabId: entry.collabId,
      msgId,
      sessionId,
      status: entry.outcomes.get(sessionId) ?? 'unknown',
      complete: true,
    };
  }
  if (typeof state.localSeatDeliveryOf === 'function') {
    return state.localSeatDeliveryOf(msgId, sessionId);
  }
  return { collabId: null, msgId, sessionId, status: 'unknown', complete: false };
}

/* 目标分组：instanceId → sessionId 列表（去重保持顺序）；同机器多目标不拆帧。
 * 条目的 sessionId 缺省 = 该机器级目标（帧不带 toSessions，由接收核按活跃席位扇出）。 */
function groupTargetsOf(targets) {
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > MAX_COLLAB_MEMBERS) {
    return null;
  }
  const groups = new Map();
  for (const target of targets) {
    if (!isTargetShape(target)) {
      return null;
    }
    const sessions = groups.get(target.instanceId) ?? [];
    if (typeof target.sessionId === 'string' && !sessions.includes(target.sessionId)) {
      sessions.push(target.sessionId);
    }
    groups.set(target.instanceId, sessions);
  }
  return groups;
}

function isTargetShape(target) {
  if (target === null || typeof target !== 'object') {
    return false;
  }
  if (typeof target.instanceId !== 'string' || !ID_PATTERN.test(target.instanceId)) {
    return false;
  }
  return target.sessionId === undefined || (typeof target.sessionId === 'string' && ID_PATTERN.test(target.sessionId));
}

/* 本机旁路（设计 §1.2/§5.2）：逐席注入，不经过 dispatch.send（跨机发送拒绝本机目标）。
 * 注入面由运行时席位层提供；未接线时如实失败并计数，不退化成网络投递。
 * 内容类帧逐席过静音门（与接收扇出同一判据），治理/邀请类豁免；每个本机目标写入投递账。 */
async function injectLocalTargets(state, local, fromSessionId, { type, payload, instanceId, sessionIds }) {
  const inject = localInjectorOf(state, local, type);
  const sessions = sessionIds.length > 0 ? sessionIds : localActiveSeatIds(local);
  const frame = localFrameOf(state, local, fromSessionId, { type, payload });
  const results = inject === null
    ? sessions.map((sessionId) => ({ sessionId, ok: false, status: 'dropped', reason: '本机旁路注入面未接线' }))
    : await injectEachSeat(state, local, inject, sessions, fromSessionId, frame, type);
  rememberLocalDelivery(state, {
    collabId: local.collabId,
    fromSessionId,
    type,
    toSessions: sessions,
    results,
    msgId: frame.msgId,
    createdAt: frame.ts,
  });
  /* 静音抑制是「已受理但未注入」：对发送方仍是本机受理成功（机器级终态），不能报入队失败。 */
  const ok = results.some((entry) => (entry.ok === true && entry.skipped !== 'self') || entry.status === 'gated');
  return { instanceId, sessionIds: sessions, ok, local: true, msgId: frame.msgId, results };
}

async function injectEachSeat(state, local, inject, sessions, fromSessionId, frame, type) {
  const results = [];
  for (const sessionId of sessions) {
    results.push(await injectOneSeatWithGate(state, local, inject, { sessionId, fromSessionId, frame, type }));
  }
  return results;
}

/* 单席注入：自己跳过；内容类按收件席位静音门抑制（豁免词表与接收扇出同源：post 与帖子类型）。 */
async function injectOneSeatWithGate(state, local, inject, { sessionId, fromSessionId, frame, type }) {
  if (sessionId === fromSessionId) {
    return { sessionId, ok: true, skipped: 'self', status: 'skipped' };
  }
  if (isMutedLocalSeat(local, type, sessionId)) {
    state.counters.localSeatsGated = (state.counters.localSeatsGated ?? 0) + 1;
    return { sessionId, ok: false, status: 'gated', reason: '收件席位已静音' };
  }
  return injectOneSeat(inject, local.collabId, sessionId, frame);
}

/* 内容类判定与静音门：治理 / 邀请 / 离席 / 结束不受静音抑制（与接收侧豁免清单同一原则）。 */
function isMutedLocalSeat(local, type, sessionId) {
  if (!isContentType(type)) {
    return false;
  }
  const seat = localSeatsOf(local).find((candidate) => candidate.sessionId === sessionId);
  return seat?.muted === true;
}

function isContentType(type) {
  return type === 'post' || POST_KINDS.includes(type);
}

function localInjectorOf(state, local, type) {
  if (typeof state.injectLocalSeat === 'function') {
    return state.injectLocalSeat;
  }
  state.counters.sendFailures++;
  state.log.warn('本机旁路注入面未接线（injectLocalSeat 缺失）', { collabId: local.collabId, type });
  return null;
}

function localFrameOf(state, local, fromSessionId, { type, payload }) {
  return withCollabCapability({
    v: PROTOCOL_VERSION,
    msgId: newMsgId(),
    type,
    collabId: local.collabId,
    from: { instanceId: state.self.instanceId, identityName: state.self.identityName, port: state.self.port, sessionId: fromSessionId },
    ts: new Date().toISOString(),
    payload,
  });
}

async function injectOneSeat(inject, collabId, sessionId, frame) {
  try {
    const result = await inject(collabId, sessionId, frame);
    return {
      sessionId,
      ok: result?.ok === true,
      delivered: result?.delivered === true,
      staged: result?.staged === true,
      status: injectionStatusOf(result),
      reason: result?.reason,
    };
  } catch (error) {
    return { sessionId, ok: false, status: 'dropped', reason: `本机注入异常：${error?.message ?? '未知原因'}` };
  }
}

/* 注入结果 → 查询面档位（与接收扇出 outcomes 同口径）：injected / staged / injected（重复）/ dropped。 */
function injectionStatusOf(result) {
  if (result?.ok !== true) {
    return 'dropped';
  }
  if (result.duplicate === true || result.delivered === true) {
    return 'injected';
  }
  return result.staged === true ? 'staged' : 'injected';
}

/* 本机活跃席位（旁路缺省目标）：运行态席位表是权威；无席位表时退回旧单席记录。 */
function localActiveSeatIds(local) {
  return localSeatsOf(local).filter((seat) => seat.state === 'member').map((seat) => seat.sessionId);
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
 * 席位变更通告）的统一出口；端点未知者跳过——可见性由转达与对等回执机制兜底（设计 §9 步骤 1/5）。
 * 返回值＝**远端**已受理的机器组数：本机旁路只是已排入注入（结果异步落 rosterLocalFailures），
 * 不计为「已触达远端」——否则只有本机成员时握手会被误判为已发出而漏掉 unresolved 收敛。 */
export function sendToRoster(state, local, type, payload, options = {}) {
  const sender = resolveSenderSeat(local, options.fromSessionId);
  if (sender.ok !== true || typeof sender.sessionId !== 'string') {
    state.log.warn('治理广播缺少发送席位（fromSessionId），未发送', {
      collabId: local.collabId,
      type,
      reason: sender.ok === true ? '未解析出会话标识' : sender.reason,
    });
    return 0;
  }
  let sent = 0;
  for (const [instanceId, sessionIds] of rosterGroupsOf(state, local, options.exclude ?? new Set())) {
    if (sendRosterGroup(state, local, sender.sessionId, { type, payload, instanceId, sessionIds })) {
      sent++;
    }
  }
  return sent;
}

/* 单个机器组的治理广播：本机组走逐席旁路注入（异步尽力而为），远端组一帧一机。
 * 本机注入不阻塞主链，但结果必须计数留痕——否则返回值把「未注入」也算成已发送。 */
function sendRosterGroup(state, local, fromSessionId, { type, payload, instanceId, sessionIds }) {
  if (instanceId === state.self.instanceId) {
    injectLocalTargets(state, local, fromSessionId, { type, payload, instanceId, sessionIds })
      .then((result) => noteRosterLocalOutcome(state, local, type, result))
      .catch((error) => {
        state.counters.sendFailures++;
        state.counters.rosterLocalFailures = (state.counters.rosterLocalFailures ?? 0) + 1;
        state.log.warn('本机治理广播注入异常（已隔离）', { collabId: local.collabId, type, reason: error?.message });
      });
    return false;   // 本机旁路不是远端触达：调用方（握手）据 0 进入 unresolved 收敛
  }
  const endpoint = endpointFor(state, local, instanceId);
  if (endpoint === undefined) {
    state.counters.rosterSkipped++;   // 治理触达不可及的观测面（跳过不静默）
    return false;
  }
  const result = sendTo(state, local.collabId, instanceId, endpoint, type, payload, {
    fromSessionId,
    ...(sessionIds.length > 0 ? { toSessions: sessionIds } : {}),
  });
  return result.ok === true;
}

/* 本机治理广播的异步收尾：成功（含静音抑制）不计数；否则记失败并保留逐席原因供排查。 */
function noteRosterLocalOutcome(state, local, type, result) {
  if (result?.ok === true) {
    return;
  }
  state.counters.rosterLocalFailures = (state.counters.rosterLocalFailures ?? 0) + 1;
  state.log.warn('本机治理广播注入未成功（已计数）', {
    collabId: local.collabId,
    type,
    results: result?.results ?? [],
  });
}

/* 名册按机器分组（含本机组；排除被点名排除者）：同机多席只发一帧并携 toSessions。
 * 本机席位表是运行态权威——名单未含的本机新席位也要收到治理广播。 */
function rosterGroupsOf(state, local, exclude) {
  const groups = new Map();
  const add = (instanceId, sessionId) => {
    const sessions = groups.get(instanceId) ?? [];
    if (typeof sessionId === 'string' && !sessions.includes(sessionId)) {
      sessions.push(sessionId);
    }
    groups.set(instanceId, sessions);
  };
  for (const entry of localRosterOf(local)) {
    if (!exclude.has(entry.instanceId)) {
      add(entry.instanceId, entry.sessionId);
    }
  }
  if (!exclude.has(state.self.instanceId)) {
    for (const seat of localSeatsOf(local)) {
      if (seat.state === 'member' && seat.unverified !== true) {
        add(state.self.instanceId, seat.sessionId);
      }
    }
  }
  return groups;
}

/* —— 讨论的成员事件广播与 join 未收敛重播 —— */

/* 成员事件广播（join / leave；设计 §5.4）：发给群体可达面（折叠成员表 ∪ 邀请者引用 ∪
 * 端点表已知者）中端点已知者与应用层广播豁免（豁免 TTL/上限）。 */
export function broadcastMemberEvent(state, local, type, event, fromSessionId) {
  return broadcastToForumMembers(state, local, type, { eventId: event.eventId, ts: event.ts }, fromSessionId);
}

/* 讨论控制事件广播出口（join / leave / end 共用）：群体可达面（折叠成员表 ∪ 邀请者引用 ∪
 * 端点表已知者，见 local.forumReachIdsOf）——新成员刚加入时折叠表只有自己，只发邀请者会让
 * 邀请者离线即隔离新人（设计 §5.1「被邀者据此取得入群所需的成员与寻址信息」的落点）。 */
export function broadcastToForumMembers(state, local, type, payload, fromSessionId) {
  const signer = fromSessionId ?? firstActiveSessionIdOf(local) ?? undefined;
  let sent = 0;
  for (const instanceId of forumReachIdsOf(local, state.self.instanceId)) {
    const endpoint = endpointFor(state, local, instanceId);
    if (endpoint === undefined) {
      state.counters.forumBroadcastSkipped++;
      continue;
    }
    const result = sendTo(state, local.collabId, instanceId, endpoint, type, payload, { fromSessionId: signer });
    if (result.ok === true) {
      sent++;
    }
  }
  return sent;
}

/* join 未收敛重播（设计 §5.4 防幽灵成员）：同一事件原样重发（事件 id 幂等并集吸收）、
 * 递增间隔有界（每轮至多 intervals.length 次）；确认（对表拉回的成员表含自己）或退出即停，
 * 每轮对表若仍未收敛则由收敛判定重新起一轮。 */
export function startJoinReplay(state, local, event, fromSessionId) {
  if (state.joinReplays.has(local.collabId)) {
    return false;   // 一轮在跑：不叠加（防风暴）
  }
  state.joinReplays.set(local.collabId, { timer: null, attempts: 0, fromSessionId });
  state.counters.joinReplays++;
  broadcastMemberEvent(state, local, 'join', event, fromSessionId);
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
    broadcastMemberEvent(state, local, 'join', event, held.fromSessionId);
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
  /* 成员侧以最近快照名单为准：member.roster 只在邀请时定格，转达/广播若照它取收件人，
   * 后加入的成员会被漏发（设计 §2A.8④ 的「其余成员」）。 */
  const roster = local.role === 'member' && Array.isArray(local.snapshot?.ledger?.members)
    ? local.snapshot.ledger.members
    : localRosterOf(local);
  for (const entry of roster) {
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
   * 接收方把转达者当作新站长（身份归因错位）；只取协议定义的身份字段（含发送会话），
   * 不夹带来源帧其它字段——否则经转达的治理帧无法按来源席位校验。 */
  const originFrom = { instanceId: frame.from.instanceId, identityName: frame.from.identityName, port: frame.from.port };
  if (typeof frame.from.sessionId === 'string') {
    originFrom.sessionId = frame.from.sessionId;
  }
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
/* 冻结广播的签发席位：协议层要求协作帧携 from.sessionId，缺了整帧被接收侧拒收。
 * 提议期冲突的本地记录还没有本协作席位，回退到本机任一活跃席位——冻结是机器级的冲突通告，
 * 不绑定单条协作的席位；一个活跃席位都没有时如实不带（发送侧会失败，不冒名）。 */
function freezeSignerSessionOf(state, frozenLocal) {
  if (frozenLocal.role === 'manager') {
    return managerSessionIdOf(frozenLocal) ?? anyActiveLocalSessionOf(state);
  }
  return firstActiveSessionIdOf(frozenLocal) ?? anyActiveLocalSessionOf(state);
}

function anyActiveLocalSessionOf(state) {
  for (const local of state.collabs.values()) {
    const sessionId = firstActiveSessionIdOf(local);
    if (sessionId !== null) {
      return sessionId;
    }
  }
  return undefined;
}

/** @param {Array<{ instanceId: string, sessionId: string, identityName: string }> | null} [participants] */
export function broadcastFreeze(state, frozenLocal, reason, participants = null) {
  /* 席位条目形态（设计 §2.2/D13）：freeze.members 按 (instanceId,sessionId) 校验，丢 sessionId
   * 的帧会被接收侧协议层整帧拒收，冲突传播到此中断。参与者集合由检出方给出时（同一冲突涉及
   * 多条本地副本）原样使用——对端据此在任一副本上命中。 */
  const members = participants !== null && participants.length > 0 ? participants : localRosterOf(frozenLocal).map((entry) => ({
    instanceId: entry.instanceId,
    ...(typeof entry.sessionId === 'string' ? { sessionId: entry.sessionId } : {}),
    identityName: entry.identityName,
  }));
  const payload = {
    name: localNameOf(frozenLocal),
    members,
    reason,
  };
  if (frozenLocal.role === 'manager') {
    payload.createdAt = frozenLocal.ledger.createdAt;
    payload.manager = { instanceId: frozenLocal.ledger.manager.instanceId, identityName: frozenLocal.ledger.manager.identityName };
  }
  const fromSessionId = freezeSignerSessionOf(state, frozenLocal);
  let sent = 0;
  for (const [instanceId, endpoint] of collectFreezeTargets(state, frozenLocal, members)) {
    const result = sendTo(state, frozenLocal.collabId, instanceId, endpoint, 'freeze', payload, { fromSessionId });
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
 * 消息广播与通告的收件人集合；提议中协作的「未回应」成员也在集内（提议中亦可沟通）。
 * 按机器去重（D11）：同机多席在名单里各占一行，但不能因此向同一台机器发多帧。 */
export function memberIdsOf(state, local) {
  if (local.role !== 'manager') {
    return [];
  }
  const ids = new Set();
  for (const entry of local.ledger.members) {
    if (entry.instanceId !== state.self.instanceId && MESSAGING_MEMBER_STATES.includes(entry.state)) {
      ids.add(entry.instanceId);
    }
  }
  return [...ids];
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
  /* 角色派生只看席位：不同步席位角色，后续任一 syncLocalRole 都会把本机改回成员。 */
  applyManagerSeatRoles(state, local, ledger);
  persistMember(state, local);
  persistLedger(state, local);
  pushSnapshot(state, local);
}

/* 站长转移的席位侧同步：台账 manager 席位置 manager、其余本机席位回落 member；台账里有席位行
 * 但运行态缺席时按台账行补建（受让会话尚未在本机建席的窗口）——否则派生角色仍是成员。 */
function applyManagerSeatRoles(state, local, ledger) {
  const managerSessionId = ledger.manager?.sessionId;
  if (typeof managerSessionId !== 'string') {
    return;
  }
  const seats = localSeatsOf(local);
  for (const seat of seats) {
    const role = seat.sessionId === managerSessionId ? 'manager' : 'member';
    if (seat.role !== role) {
      upsertLocalSeat(local, { sessionId: seat.sessionId, role }, { persist: true, dataDir: state.dataDir });
    }
  }
  if (seats.some((seat) => seat.sessionId === managerSessionId)) {
    return;
  }
  const row = ledger.members.find((entry) => entry.instanceId === state.self.instanceId && entry.sessionId === managerSessionId);
  if (row === undefined) {
    return;
  }
  upsertLocalSeat(local, {
    version: 1,
    sessionId: managerSessionId,
    role: 'manager',
    state: 'member',
    joinSeq: row.joinSeq,
    joinedAt: row.joinedAt,
    muted: true,
    unverified: false,
  }, { persist: true, dataDir: state.dataDir, bridgeId: bridgeIdOfSession(state, managerSessionId) });
}

/* 席位变更后的名册角色同步：台账 manager 与 members[].role 恒一致——只把 manager 对应的
 * 那一行置 manager，其余行（含同机其他会话）一律回 member。按 instanceId 判定会把同机两席
 * 同时升为 manager，写出两份 manager 行的非法台账。 */
function syncRosterRoles(ledger) {
  const manager = ledger?.manager;
  if (typeof manager !== 'object' || manager === null || typeof manager.instanceId !== 'string') {
    return;
  }
  for (const member of ledger.members) {
    if (isManagerRoleRow(member, manager)) {
      member.role = 'manager';
    } else if (member.role !== 'member') {
      member.role = 'member';
    }
  }
}

/* 旧台账可能缺 sessionId：此时按实例匹配（每机一席的兼容面）；有 sessionId 即精确到席位。 */
function isManagerRoleRow(member, manager) {
  if (member.instanceId !== manager.instanceId) {
    return false;
  }
  if (typeof manager.sessionId !== 'string' || manager.sessionId === '') {
    return true;
  }
  return member.sessionId === undefined || member.sessionId === manager.sessionId;
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
  demoteLocalSeats(state, local);
  local.suspended = null;
  persistMember(state, local);
  retargetStaleQueue(state, local, formerManagerId, managerPeer.instanceId);
  requestCurrentView(state, local);
  state.counters.downgrades++;
}

/* 降级为成员时的席位侧同步：本机所有席位角色回落 member——残留 manager 席位会被
 * syncLocalRole 重新派生成站长，随后访问已被删除的 local.ledger（空引用）。 */
function demoteLocalSeats(state, local) {
  for (const seat of localSeatsOf(local)) {
    if (seat.role !== 'member') {
      upsertLocalSeat(local, { sessionId: seat.sessionId, role: 'member' }, { persist: true, dataDir: state.dataDir });
    }
  }
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
  sendSnapshotRequest(state, local, local.collabId, managerId, endpoint);
}

/* 快照请求的统一发送面：缺基线不编造字段（协议层会按 managerTerm/version 必填拒收）。 */
function sendSnapshotRequest(state, local, collabId, managerId, endpoint) {
  const payload = snapshotRequestPayloadOf(local);
  if (payload === null) {
    state.counters.snapshotSkipped++;
    state.log.warn('快照请求缺少本地基线（managerTerm/version 未知），跳过', { collabId });
    return null;
  }
  return sendTo(state, collabId, managerId, endpoint, 'snapshot', payload, {
    fromSessionId: firstActiveSessionIdOf(local) ?? undefined,
  });
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
  }, { fromSessionId: firstActiveSessionIdOf(local) ?? undefined });
}

/* 本机提示（会话注入面；不经出站队列、不上网络）：notify 注入缺失或投递失败只计数与日志。
 * 帧形态为 notice + event:'local-alert'——该事件不入协议表（外发不存在；伪造入站被协议拒收）。
 * options.targetSessionId：指名接收会话（路由按会话寻址优先于调用者/绑定归属；同机移交的
 * 目标会话据此能收到 offerId）。
 * 返回值契约（join-ack 判据的通道，单核路由面消费）：false = 提示无接收者（路由面明示
 * 「绑定会话不活跃 / 无绑定 / 调用者桥不在线」）；其余（true / undefined / 旧式注入面返回值）
 * = 按已投出处理——旧注入面（如既有的 deliverFrame）零改动，只有显式 false 才是否决信号。 */
export function notifyLocal(state, local, text, options = {}) {
  if (typeof state.notify !== 'function') {
    return undefined;
  }
  const targetSessionId = options?.targetSessionId;
  try {
    const routed = state.notify({
      v: PROTOCOL_VERSION,
      type: 'notice',
      msgId: newMsgId(),
      from: state.self,
      collabId: local.collabId,
      ts: new Date().toISOString(),
      payload: {
        event: 'local-alert',
        text,
        ...(typeof targetSessionId === 'string' && targetSessionId !== '' ? { targetSessionId } : {}),
      },
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

/* 星型路由（设计 §5.2）：成员只发给站长所在机器（省略 to 或显式 = 站长机器）；
 * 站长省略 to = 全体其他活跃席位（同机多席也在内，本机走旁路），显式 to = 该机器上的席位。
 * toSessionId（短码/完整标识，精确匹配）必须与 to 同时给出（D7）；歧义/无匹配一律拒绝。 */
function recipientsOf(state, local, to, toSessionId, fromSessionId) {
  const route = routingParamsOf(to, toSessionId);
  if (route.error !== undefined) {
    return route;
  }
  const manager = managerTargetOf(state, local);
  if (manager === null) {
    return { error: '站长席位未知（等待对表）' };
  }
  if (local.role !== 'manager') {
    return memberTargetsOf(state, local, route, manager);
  }
  if (route.explicit !== null) {
    return resolveTargetOnMachine(state, local, route.explicit, route.directed, null);
  }
  const targets = otherActiveSeatsOf(state, local, fromSessionId);
  return targets.length === 0 ? { error: '协作内没有其他活跃席位' } : { targets };
}

/* 定向参数形态（D7）：toSessionId 必须与 to 同时给出；两者都可缺省。 */
function routingParamsOf(to, toSessionId) {
  const explicit = typeof to === 'string' && to.trim() !== '' ? to.trim() : null;
  const directed = typeof toSessionId === 'string' && toSessionId.trim() !== '' ? toSessionId.trim() : null;
  if (directed !== null && explicit === null) {
    return { error: 'toSessionId 必须与 to 同时给出（先指定目标机器，再指定会话）' };
  }
  if (explicit !== null && !ID_PATTERN.test(explicit)) {
    return { error: 'to 非法（1–64 位字母数字与连字符的实例标识）' };
  }
  return { explicit, directed };
}

/* 成员的发件目标：只能到站长所在机器，且定向只能落在站长席位本身——同机其他成员席位不是
 * 星型路由的合法终点（成员 → 站长的唯一上行边）。 */
function memberTargetsOf(state, local, route, manager) {
  if (route.explicit !== null && route.explicit !== manager.instanceId) {
    return { error: '成员只能发给站长所在机器（星型路由）' };
  }
  if (route.directed !== null && typeof manager.sessionId !== 'string') {
    return { error: '站长席位未知（等待对表）——无法定向到站长' };
  }
  const resolved = resolveTargetOnMachine(state, local, manager.instanceId, route.directed, manager);
  if (resolved.error !== undefined || route.directed === null) {
    return resolved;
  }
  return resolved.targets[0]?.sessionId === manager.sessionId
    ? resolved
    : { error: '成员只能定向到站长席位（不能指名站长所在机器的其他成员会话）' };
}

/* 机器内定向：未给会话参数 = 该机器全部活跃席位（接收核按 toSessions 扇出）；
 * 给了会话参数 = 精确匹配一个席位（短码歧义 / 无匹配拒绝）。 */
function resolveTargetOnMachine(state, local, instanceId, directed, preferred) {
  const candidates = activeSeatsOn(state, local, instanceId);
  if (directed === null) {
    if (preferred !== null) {
      return { targets: [preferred] };
    }
    return candidates.length === 0
      ? { error: '目标不在协作名单中（或不在活跃席位内）' }
      : { targets: candidates };
  }
  const matched = matchSessionByToken(candidates, directed);
  if (matched === null) {
    return { error: '会话短码无匹配或存在歧义（改用完整会话标识，或不指定会话）' };
  }
  return { targets: [{ instanceId, sessionId: matched }] };
}

/* 某机器上的活跃席位（名单行 ∪ 本机席位表；同机多会话各自成席）。 */
function activeSeatsOn(state, local, instanceId) {
  const targets = [];
  const seen = new Set();
  for (const target of allActiveSeatTargets(state, local)) {
    if (target.instanceId !== instanceId) {
      continue;
    }
    const key = target.sessionId ?? '';
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    targets.push(target);
  }
  return targets;
}

/* 站长席位目标：本机席位表优先（运行态权威），其次名单 manager 行，最后兼容成员记录。 */
function managerTargetOf(state, local) {
  const managerSeat = localSeatsOf(local).find((seat) => seat.role === 'manager' && seat.state === 'member');
  if (managerSeat !== undefined) {
    return { instanceId: state.self.instanceId, sessionId: managerSeat.sessionId };
  }
  const roster = localRosterOf(local);
  const managerRow = roster.find((row) => row?.role === 'manager' && isMessagingState(row.state));
  if (managerRow !== undefined) {
    return { instanceId: managerRow.instanceId, ...(typeof managerRow.sessionId === 'string' ? { sessionId: managerRow.sessionId } : {}) };
  }
  const legacy = local.member?.manager;
  if (legacy !== undefined && typeof legacy.instanceId === 'string') {
    return { instanceId: legacy.instanceId, ...(typeof legacy.sessionId === 'string' ? { sessionId: legacy.sessionId } : {}) };
  }
  return null;
}

/* 除发送会话自身外的全部活跃席位（同机其他会话也在内）。 */
function otherActiveSeatsOf(state, local, fromSessionId) {
  return allActiveSeatTargets(state, local).filter((target) => {
    if (target.instanceId !== state.self.instanceId) {
      return true;
    }
    return typeof target.sessionId === 'string' && target.sessionId !== fromSessionId;
  });
}

/* 活跃席位目标全集：名单行（active-only）∪ 本机席位表（成员态）。 */
function allActiveSeatTargets(state, local) {
  const targets = [];
  const seen = new Set();
  const add = (target) => {
    if (typeof target?.instanceId !== 'string') {
      return;
    }
    const key = `${target.instanceId}\u0000${target.sessionId ?? ''}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    targets.push(target);
  };
  for (const row of localRosterOf(local)) {
    if (!isMessagingState(row?.state)) {
      continue;
    }
    add({ instanceId: row.instanceId, ...(typeof row.sessionId === 'string' ? { sessionId: row.sessionId } : {}) });
  }
  for (const seat of localSeatsOf(local)) {
    if (seat.state !== 'member') {
      continue;
    }
    add({ instanceId: state.self.instanceId, sessionId: seat.sessionId });
  }
  return targets;
}

function isMessagingState(stateName) {
  return stateName === undefined || MESSAGING_MEMBER_STATES.includes(stateName);
}

/* 本机席位表（运行时状态）：无席位表返回空——调用方按兼容成员记录处理。 */
function localSeatsOf(local) {
  return local?.seats instanceof Map ? [...local.seats.values()] : [];
}

/* 发送席位解析：显式 fromSessionId 必须是本机活跃成员席位（unverified/joining 不得发）；
 * 缺省时取本机站长席位、否则最早加入的活动席位（兼容未穿参的治理发送面）。
 * 无席位表且无显式会话＝旧单席模式（回退成员记录，不阻断既有调用链）。 */
function resolveSenderSeat(local, fromSessionId, { requireExplicit = false } = {}) {
  const seats = localSeatsOf(local);
  const explicit = typeof fromSessionId === 'string' && fromSessionId.trim() !== '' ? fromSessionId.trim() : null;
  if (explicit !== null) {
    return explicitSenderSeat(local, seats, explicit);
  }
  if (requireExplicit) {
    return { ok: false, reason: '缺少发送会话标识（fromSessionId）' };
  }
  return defaultSenderSeat(local, seats);
}

function explicitSenderSeat(local, seats, explicit) {
  if (!ID_PATTERN.test(explicit)) {
    return { ok: false, reason: '发送会话标识非法（1–64 位字母数字与连字符）' };
  }
  if (seats.length === 0) {
    return legacySenderSeatOf(local, explicit);
  }
  const seat = seats.find((candidate) => candidate.sessionId === explicit);
  if (seat === undefined) {
    return { ok: false, reason: '发送会话不在本机席位表中（非本机成员）' };
  }
  if (seat.state !== 'member' || seat.unverified === true) {
    return { ok: false, reason: '发送会话尚未收敛（joining / unverified）——收敛后再发送' };
  }
  return { ok: true, sessionId: explicit };
}

/* 无席位表的兼容路径：旧单席记录能对上的放行，否则拒绝（不臆断成员资格）。 */
function legacySenderSeatOf(local, explicit) {
  const legacySession = local?.member?.sessionId;
  if (typeof legacySession === 'string' && legacySession !== explicit) {
    return { ok: false, reason: '发送会话不在本机席位表中（非本机成员）' };
  }
  return { ok: true, sessionId: explicit };
}

/* 未穿参的发送面（治理广播等）：站长席位（治理帧的法定签发者）优先；无站长席时仅当本机
 * 恰一席才采用；旧单席记录兜底。多席且无站长席 = 无歧义的签发者不存在，拒绝猜测。 */
function defaultSenderSeat(local, seats) {
  const memberSeats = seats.filter((seat) => seat.state === 'member' && seat.unverified !== true);
  const managerSeat = memberSeats.find((seat) => seat.role === 'manager');
  if (managerSeat !== undefined) {
    return { ok: true, sessionId: managerSeat.sessionId };
  }
  if (memberSeats.length === 1) {
    return { ok: true, sessionId: memberSeats[0].sessionId };
  }
  if (memberSeats.length > 1) {
    return { ok: false, reason: '同机多席位缺省发送会话有歧义——必须显式给 fromSessionId' };
  }
  const legacySession = local?.member?.sessionId;
  return typeof legacySession === 'string'
    ? { ok: true, sessionId: legacySession }
    : { ok: false, reason: '缺少发送会话标识（fromSessionId）' };
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
    sessionId: ledger.manager.sessionId,
    manager: { instanceId: ledger.manager.instanceId, sessionId: ledger.manager.sessionId, identityName: ledger.manager.identityName },
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
  /* 名单按协议席位条目形态（instanceId + sessionId + identityName）：邀请准入按席位键校验，
   * 缺 sessionId 的邀请会被对端协议层整帧拒收。 */
  const seen = new Set(ledger.members.map((member) => `${member.instanceId}\u0000${member.sessionId ?? ''}`));
  const members = ledger.members.map((member) => seatEntryOf(member));
  for (const extra of extraMembers) {
    const entry = seatEntryOf(extra);
    const key = `${entry.instanceId}\u0000${entry.sessionId ?? ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      members.push(entry);
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

/* 席位条目（邀请载荷的名单行）：只取协议定义字段；缺 sessionId 的旧行不编造——
 * 调用方按「无法形成合法条目」跳过，绝不借用同机其他会话的标识。 */
function seatEntryOf(member) {
  const sessionId = typeof member.sessionId === 'string' ? member.sessionId : member.targetSessionId;
  return {
    instanceId: member.instanceId,
    ...(typeof sessionId === 'string' ? { sessionId } : {}),
    identityName: member.identityName,
  };
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
    : sendTo(state, local.collabId, targetId, endpoint, 'withdraw', { scope: 'single' }, { fromSessionId: managerSessionIdOf(local) ?? undefined });
  state.counters.withdrawn++;
  return { ok: true, scope: 'single', withdrawn: [targetId], delivered: sent.ok === true };
}

function withdrawAll(state, local) {
  /* 整条取消的通告面 = 全体非本机成员（含已单条撤回 / 已拒绝者——它们也应得知该协作已不存在） */
  const recipients = local.ledger.members.filter((entry) => entry.instanceId !== state.self.instanceId);
  /* 签发席位在清空站长引用前定格：台账 manager 是最后的兜底来源，清空后再算会丢掉会话标识。 */
  const fromSessionId = managerSessionIdOf(local) ?? undefined;
  mutateLedger(state, local, (ledger) => {
    ledger.status = 'terminated';
    /* 终态形态（设计 §3.4）：撤回通告的收件人已在上面定格，台账不再需要站长引用/接管窗口；
     * 名单行降为成员——残留站长行或窗口会让落盘行过不了形态校验，重启时回退到撤回前的行。 */
    ledger.manager = null;
    delete ledger.managerWindow;
    for (const member of ledger.members) {
      member.role = 'member';
      if (member.state === 'invited' || member.state === 'approved') {
        member.state = 'withdrawn';
      }
    }
  });
  local.member.state = 'terminated';
  local.member.archivedAt = new Date().toISOString();
  persistMember(state, local);
  /* 终态归档本机席位（保留历史，不删除用户数据）：写 archivedAt 并退出活跃判定。 */
  archiveLocalSeatsOfState(state, local);
  forgetMuteBaselinesOfCollab(state, local.collabId);
  for (const member of recipients) {
    const endpoint = local.endpoints.get(member.instanceId);
    if (endpoint !== undefined) {
      sendTo(state, local.collabId, member.instanceId, endpoint, 'withdraw', { scope: 'all' }, { fromSessionId });
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
function collectFreezeTargets(state, frozenLocal, members = localRosterOf(frozenLocal)) {
  const ids = members.map((entry) => entry.instanceId);
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
