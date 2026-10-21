import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import {
  ID_PATTERN, MAX_ACTIVE_SEATS, MAX_REASON_CHARS, MAX_TOPIC_CHARS, PROTOCOL_VERSION,
  isCollabMode, isIdentityName, isPresentationText, newMsgId, withCollabCapability,
} from '../net/protocol.js';
import {
  CARRIER_FORMAT_INVITE_STUB, CARRIER_FORMAT_SESSION_SEATS, CARRIER_VERSION, readCarrier, readCarrierFormat, writeCarrier,
} from './carrier.js';
import { collabDir } from '../paths.js';
import {
  createInvitesFileStore, createJoiningFileStore, createJoinApplicationsStore, createJoinsStore, createPendingInvitesFileStore,
} from './joins.js';
import { joinDenyReasonOf } from './invites.js';
import { writeRecovery } from './migration.js';
import {
  currentManagerIdOf, isLocalArchivedState, isSeatArchived, listLocalSeatsOf, localModeOf, localNameOf, localRosterOf,
  localSeatOfLocal, localStateOf, localTopicOf, managerSeatOfLocal, persistMember, removeLocalSeat, retiredMuteHandle, seatsOfLocal,
  selfJoinedOf, upsertLocalSeat,
} from './local.js';
import { LOCAL_LEFT_STATE } from './model.js';
import { endpointFor, invitePayloadOf, mutateLedger } from './outgoing.js';
import { createPostsStore } from './posts.js';
import { createMembersStore } from './members.js';
import { createCounterStore } from './counter.js';
import { createInjectedStore } from './injected.js';
import { ledgerDigest, listLocalCollabIds, loadMember } from './store.js';
import { isSessionShortCode, matchSessionByToken, shortSessionId } from '../util/short-id.js';

/* 加入域服务（会话级加入 §2/§4）：会话申请 / 站长批准 / 接线 / 拒绝呈现 ＋ 讨论直连。
 * 两侧视角同域：发起机（申请、回执落地、接线）与站长机（待批准面、批准 / 拒绝回执）；
 * 网络三帧（join-request / join-grant / join-deny）由服务的消费面按类型转交本域。
 * 本机自批不经网络帧：准入门对「来源为本机」的申请一律自邀拒，本机会话对本站长协作的申请
 * 由本域直落待批准面，批准时本机直接完成接线（回执无从经网络回到自己）。
 * 依赖注入：state＝协作服务状态（注册表 / 本机身份 / 绑定表 / 计数）；send＝直投面（设计 §2
 * 不进 outbox 长队列——申请时限短于队列保留期，重发轮由本域按短节律自理）；openViewer＝
 * 「进入即见」出口；now＝时钟（时限与记录时刻共用同一基准）。 */

/* 申请时限缺省（config.joinRequestTtlMs 缺省同邀请时限）与重发节律（短节律起步、逐次加倍至上限）。 */
export const JOIN_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
export const JOIN_REQUEST_RETRY_MS = 30000;
export const JOIN_REQUEST_RETRY_MAX_MS = 300000;
/* 确认重发的停等宽限缺省（config.sessionSeatTimeoutMs 缺省同接管面）：grant 过期后停止重发，
 * 再等这么久仍无含本席的快照才回滚本机席位——给「站长已提交、快照丢帧」留重发取快照的窗口。 */
export const SEAT_TIMEOUT_FALLBACK_MS = 300000;

const JOIN_APPLICATION_LABEL = '加入申请';
const MAIN_VIEWER_ROOT = 'main';

/* 申请超时的如实提示（设计 §2 逐字）：时限内没等到任何回执——旧版对端不识 join 三帧时最可能的
 * 解释；「可能」不省（可达性 / 无人值守等同样成立，不指控、不定论）。 */
const JOIN_TIMEOUT_VERSION_HINT = '对端可能版本不支持加入申请（需 0.1.2+）';

/**
 * @param {{ state: any, send?: ((message: object) => any) | null, openViewer?: ((ref: object) => unknown) | null,
 *   log?: any, now?: () => number }} deps
 */
export function createJoinDomain({ state, send = null, openViewer = null, log = null, now = Date.now }) {
  /** @type {{ state: any, send: any, openViewer: any, log: any, now: () => number, stores: Map<string, any>,
   *   retries: Map<string, any>, knocks: Map<string, any>, books: Map<string, any>,
   *   pendingRequests: Map<string, Map<string, any>>, joinInvites: Map<string, any>, seatNames: Map<string, string>,
   *   confirmRetries: Map<string, any> }} */
  const joinState = {
    state,
    send: typeof send === 'function' ? send : null,
    openViewer: typeof openViewer === 'function' ? openViewer : null,
    log: log ?? state.log,
    now: typeof now === 'function' ? now : Date.now,
    stores: new Map(),      // collabId → 加入台账（惰性构造；写前 load 刷新，并入他域写入的获准）
    retries: new Map(),     // 申请重发轮（键＝协作 ＋ 会话）
    confirmRetries: new Map(),   // 入席确认重发轮（键＝协作 ＋ 会话；清除 unverified 前续发）
    knocks: new Map(),      // 讨论名 → 敲门登记（请求会话 ＋ 时刻：同意门落地时把席位交回请求会话）
    books: new Map(),       // collabId → { invites, pending, joining }（0.2.0 三份文件，每协作一份）
    pendingRequests: new Map(),   // collabId → Map(instanceId\0sessionId, 待批准申请；仅内存）
    joinInvites: new Map(),       // joinId → { inviteId, instanceId, sessionId }（确认后才登记已接受）
    seatNames: new Map(),         // joinId → 申请人身份名（joining 记录不落该字段）
  };
  state.joinApplications = state.joinApplications ?? createJoinApplicationsStore({ dataDir: state.dataDir, log: joinState.log });
  const domain = {
    request: (input) => requestJoin(joinState, input ?? {}),
    /* 兼容面：工具面传 managerSessionId 时走 0.2.0 两段式（beginJoining → join-grant）；
     * 旧直调（无 managerSessionId）仍走本地批准台账，供旧协作/旧测试的读侧行为保持。 */
    approve: (input) => (isSessionApprovalInput(input) ? approveJoinOf(joinState, input ?? {}) : approveJoinLegacy(joinState, input ?? {})),
    handleJoinRequest: (frame) => handleJoinRequest(joinState, frame),
    handleJoinGrant: (frame) => (isSessionGrantFrame(frame) ? handleJoinGrantOf(joinState, frame) : handleJoinGrantLegacy(joinState, frame)),
    handleJoinDeny: (frame) => (isSessionDenyFrame(frame) ? handleJoinDenyOf(joinState, frame) : handleJoinDenyLegacy(joinState, frame)),
    pendingJoinsOf: (collabId) => pendingJoinsOf(joinState, collabId),
    isGranted: (collabId, sessionId) => isGranted(joinState, collabId, sessionId),
    /* 讨论同意门落地后的收口（服务在邀请被批准时调用）：把敲门登记在册的请求会话接线。 */
    bindKnockedSession: (local, acceptedSessionId) => bindKnockedSession(joinState, local, acceptedSessionId),
    /* —— 会话级邀请与两段式入席（邀请簿记、挂起补投、join 两段式；设计 §4） —— */
    ...sessionJoinApiOf(joinState),
  };
  /* 准入门的上限判定注入面（待批准存活面）：门只调 list() 取数、不筛不删，过期待批准由本提供方剪除。 */
  state.pendingJoinsOf = domain.pendingJoinsOf;
  return domain;
}

function sessionJoinApiOf(joinState) {
  return {
    createInvite: (input) => createInviteOf(joinState, input ?? {}),
    openInitialInvite: (input) => openInitialInviteOf(joinState, input ?? {}),
    withdrawInitialInvite: (input) => withdrawInitialInviteOf(joinState, input ?? {}),
    acceptInvite: (input) => acceptInviteOf(joinState, input ?? {}),
    declineInvite: (input) => declineInviteOf(joinState, input ?? {}),
    requestJoin: (input) => requestJoinOf(joinState, input ?? {}),
    approveJoin: (input) => approveJoinOf(joinState, input ?? {}),
    confirmJoining: (joinId, sessionId, input) => confirmJoiningOf(joinState, joinId, sessionId, input ?? {}),
    /* 确认重发轮的显式驱动面（测试与运维可确定性推进；周期推进由本域定时器自理）。 */
    retryPendingConfirms: (at) => retryPendingConfirmsOf(joinState, at),
    withdrawInvite: (input) => withdrawInviteOf(joinState, input ?? {}),
    withdrawInviteByTarget: (input) => withdrawInviteByTargetOf(joinState, input ?? {}),
    withdrawPendingInvite: (input) => withdrawPendingInviteOf(joinState, input ?? {}),
    handleInviteDecline: (frame) => handleInviteDeclineOf(joinState, frame),
    expireInvites: (at) => expireInvitesOf(joinState, at),
    pruneTerminalPending: (at) => pruneTerminalPendingOf(joinState, at),
    pendingInviteList: (input) => pendingInviteListOf(joinState, input ?? {}),
    acceptedInvite: (input) => acceptedInviteOf(joinState, input ?? {}),
    pendingInviteCount: (at) => pendingInviteCountOf(joinState, at),
    knockedSession: (name) => knockedSessionOf(joinState, name),
    registerPendingInvite: (input) => registerPendingInviteOf(joinState, input ?? {}),
    handleInviteFrame: (frame) => handleInviteFrameOf(joinState, frame),
    handleInviteApproval: (frame) => handleInviteApprovalOf(joinState, frame),
    handleJoinConfirm: (frame) => handleJoinConfirmOf(joinState, frame),
    releaseJoining: (collabId, sessionId) => releaseJoiningOf(joinState, collabId, sessionId),
    unconfirmJoining: (joinId) => unconfirmJoiningOf(joinState, joinId),
    pendingJoiningProjection: (collabId) => pendingJoiningProjectionOf(joinState, collabId),
    pendingInvitesFor: (input) => pendingInvitesForOf(joinState, input ?? {}),
    replayPendingInvites: (sessionId, collabIds, deliver) => replayPendingInvitesOf(joinState, sessionId, collabIds, deliver),
    ensureJoinedCarrier: (collabId, sessionId) => ensureJoinedCarrierOf(joinState, collabId, sessionId),
    expireJoining: (at) => expireJoiningOf(joinState, at),
    expirePendingInvites: (at) => expirePendingInvitesOf(joinState, at),
    invalidateForManagerChange: (managerTerm, collabId) => invalidateForManagerChangeOf(joinState, managerTerm, collabId),
    invalidateInvitesForManagerChange: (collabId) => invalidateInvitesForManagerChangeOf(joinState, collabId),
    abortJoining: (joinId, reason) => abortJoiningOf(joinState, joinId, reason),
    pendingRequestsOf: (collabId) => pendingRequestsOf(joinState, collabId),
  };
}

/* —— 申请（发起侧） —— */

/* 申请入口（设计 §2 两段式）：collabId 直给＝跳过解析；只给名字＝本机同名在册者直取（在册面），
 * 否则按 target 单播解析（协作）或不带 target 走敲门（讨论）。 */
async function requestJoin(joinState, input) {
  const sessionId = idOf(input.sessionId);
  if (sessionId === null) {
    return { ok: false, message: '参数 sessionId 非法：需要会话标识（1–64 位字母数字与连字符）' };
  }
  const collabId = idOf(input.collabId);
  if (collabId !== null) {
    return requestForCollab(joinState, collabId, sessionId, null);
  }
  const name = nameOf(input.name);
  if (name === null) {
    return { ok: false, message: '参数非法：需要 collabId，或 name（协作 / 讨论名）＋可选 target（按名解析的目标端点）' };
  }
  const matched = matchLocalByName(joinState, name);
  if (matched.length > 1) {
    return { ok: false, message: `本机有多条同名协作（${matched.length} 条）——请用 collabId 指明要加入哪一条` };
  }
  if (matched.length === 1) {
    return requestForCollab(joinState, matched[0], sessionId, null);
  }
  const wanted = requestTargetOf(joinState, input.target);
  if (wanted.ok !== true) {
    return wanted;
  }
  if (wanted.target === null) {
    return knockByName(joinState, name, sessionId);
  }
  const resolved = await resolveCollabId(joinState, name, wanted.target);
  if (resolved.ok !== true) {
    return resolved;
  }
  return requestForCollab(joinState, resolved.collabId, sessionId, resolved.responder, resolved.participants);
}

/* 目标形态归一（设计 §6）：未给＝null（走敲门）；{address, port} 直取（IP 字面量 ＋ 端口）；
 * {instanceId} 经站点级已知主机清单解析端点（「实例标识 → 地址:端口」的既有学习面）。
 * 给了但解析不出＝如实报错——不静默改走敲门（打算解析 A 机却广播给全网是静默错向）。 */
function requestTargetOf(joinState, raw) {
  if (raw === undefined || raw === null) {
    return { ok: true, target: null };
  }
  const instanceId = idOf(raw.instanceId);
  if (instanceId !== null) {
    const known = lookupHostOf(joinState, instanceId);
    if (known === null) {
      return { ok: false, message: `目标实例的端点未知（${instanceId}）——先 ws_list_hosts 确认对方在线，或直接给 { address, port }` };
    }
    /* 保留实例标识：按名解析可据此做单播能力探测（participants 三态），不再只拿地址:端口。 */
    return { ok: true, target: { ...known, instanceId } };
  }
  const address = typeof raw.address === 'string' ? raw.address.trim() : '';
  const port = raw.port;
  return isIP(address) !== 0 && Number.isInteger(port) && port >= 1 && port <= 65535
    ? { ok: true, target: { address, port } }
    : { ok: false, message: '参数 target 非法：需要 { address, port }（IP 字面量 ＋ 1–65535 端口）或 { instanceId }（已知主机清单里的实例标识）' };
}

/* 已知主机清单的端点查取（形态不符 / 查不到一律 null）。 */
function lookupHostOf(joinState, instanceId) {
  const lookup = joinState.state.knownHosts?.lookup;
  const known = typeof lookup === 'function' ? lookup.call(joinState.state.knownHosts, instanceId) : null;
  if (known === null || known === undefined || typeof known.address !== 'string' || !Number.isInteger(known.port)) {
    return null;
  }
  return { address: known.address, port: known.port };
}

function matchLocalByName(joinState, name) {
  const matched = [];
  for (const local of joinState.state.collabs.values()) {
    if (localNameOf(local) === name) {
      matched.push(local.collabId);
    }
  }
  return matched;
}

/* 按名解析（设计 §2 第一段）：向 target 单播问「谁在 <协作名> 协作」，得 collabId 与应答者端点。
 * 返回面两个语义分别处置：降级 / 抛错（ok:false）原样透传；窗口内无应答（reply:null）如实报错。 */
async function resolveCollabId(joinState, name, target) {
  if (typeof joinState.state.requestJoinResolve !== 'function') {
    return { ok: false, message: '按名解析不可用（网络组件未注入）——改用 collabId，或稍后重试' };
  }
  let result;
  try {
    result = await joinState.state.requestJoinResolve({
      name, address: target.address, port: target.port,
      ...(target.instanceId === undefined ? {} : { instanceId: target.instanceId }),
    });
  } catch (error) {
    return { ok: false, message: `按名解析失败：${error?.message ?? '未知原因'}` };
  }
  if (result?.ok !== true) {
    return { ok: false, message: result?.message ?? '按名解析失败（网络面未返回原因）' };
  }
  return resolvedReplyOf(result.reply, name, target);
}

/* 应答面处置（设计 §2）：「窗口内无应答」与「答了未命中」是两个语义面，各自如实报错；
 * 命中须携合法协作标识与应答者实例——缺一即无从据以申请（应答者实例是申请帧的寻址依据）。 */
function resolvedReplyOf(reply, name, target) {
  if (reply === null || reply === undefined) {
    return { ok: false, message: `「${name}」的按名解析无应答（目标驿站不可达或未在运行）——稍后重试` };
  }
  if (reply.found !== true) {
    return { ok: false, message: `目标驿站没有名为「${name}」的协作（名称不符或该协作不在其册内）——若要找的是讨论，请不带 target 重试（讨论的加入走敲门广播）` };
  }
  const collabId = idOf(reply.collabId);
  const responder = responderOf(reply.responder, target);
  if (collabId === null || responder === null) {
    return { ok: false, message: '按名解析的应答形态不全（协作标识 / 应答者实例）——无法据以申请' };
  }
  /* participants 是 0.2.0 的加法能力字段（三态判定归 M12/M6）：这里只透传，不在名字解析面丢弃。 */
  return reply.participants === undefined
    ? { ok: true, collabId, responder }
    : { ok: true, collabId, responder, participants: reply.participants };
}

/* 应答者端点（未在席路径的唯一寻址信息：申请先于入席，本机没有该协作的记录可依）。 */
function responderOf(responder, target) {
  const instanceId = idOf(responder?.instanceId);
  if (instanceId === null) {
    return null;
  }
  const address = typeof responder?.address === 'string' ? responder.address : target.address;
  return { instanceId, address, port: Number.isInteger(responder?.port) ? responder.port : target.port };
}

/* 申请分派：在册记录 → 协作 / 讨论各自的分支；未在册但刚解析出 collabId → 未在席的直投分支。
 * 已归档（已结束 / 已退出 / 已终止）的实例不开新申请：接进去也是必然失败的路径，就地如实拒。 */
async function requestForCollab(joinState, collabId, sessionId, responder, participants = undefined) {
  const local = joinState.state.collabs.get(collabId);
  if (local === undefined) {
    if (responder === null) {
      return { ok: false, message: '本机没有该协作（collabId 不存在）——先看 ws_list_collabs，或用 name + target 按名解析' };
    }
    const result = await requestManaged(joinState, sessionId, { collabId, manager: responder });
    return participants === undefined ? result : { ...result, participants };
  }
  if (isLocalArchivedState(local)) {
    /* 已退出（left）的协作成员可重新申请（2026-10-19 产品裁定：终局行可再入席，站长批准制）；
     * 协作本身已结束 / 已终止，或讨论已退出（论坛重入走邀请路径）照旧如实拒。 */
    const rejoinable = local.role === 'member' && localModeOf(local) === 'managed' && localStateOf(local) === LOCAL_LEFT_STATE;
    if (!rejoinable) {
      return { ok: false, message: '该协作已结束（或本机已退出）——不再纳新，不能加入' };
    }
  }
  if (localModeOf(local) === 'forum') {
    return requestForum(joinState, local, sessionId);
  }
  return requestManaged(joinState, sessionId, { collabId, manager: managerSeatOf(joinState, local) });
}

/* 站长的可达端点（在席机器：协作端点表优先，回退站点级已知主机清单；本机即站长＝只给实例标识）。 */
function managerSeatOf(joinState, local) {
  const managerId = currentManagerIdOf(local);
  if (managerId === joinState.state.self.instanceId) {
    return { instanceId: managerId };
  }
  const endpoint = endpointFor(joinState.state, local, managerId);
  return endpoint === undefined ? null : { instanceId: managerId, address: endpoint.address, port: endpoint.port };
}

/* 协作申请（设计 §2）：本机即站长 → 直落待批准面（不经网络帧）；否则直投站长 ＋ 落申请台账 ＋
 * 短节律重发轮至申请时限。未决期内同会话重复申请＝幂等（不重发、只如实报「仍在等待」）。 */
async function requestManaged(joinState, sessionId, seat) {
  pruneApplications(joinState);
  if (findApplication(joinState, seat.collabId, sessionId) !== null) {
    return { ok: true, collabId: seat.collabId, sessionId, mode: 'managed', pending: true, idempotent: true, note: '本会话对该协作的申请仍在未决期内——不重复发送（同申请幂等）' };
  }
  if (seat.manager === null) {
    return { ok: false, message: '站长端点未知（协作端点表与已知主机清单都没有该实例）——稍后重试或先 ws_list_hosts 确认对方在线' };
  }
  if (seat.manager.instanceId === joinState.state.self.instanceId) {
    return addLocalPending(joinState, seat.collabId, sessionId);
  }
  return dispatchJoinRequest(joinState, { collabId: seat.collabId, sessionId, manager: seat.manager, sentAt: joinState.now() });
}

/* 本机自批（设计 §2「本机自批」）：申请直落本机待批准面——本机任意会话可批，批准即接线本会话。
 * 待批准条目与远端申请同形态（instanceId 记申请方机器＝本机），共用同一展示面与处置工具。 */
function addLocalPending(joinState, collabId, sessionId) {
  if (pendingRequestsOf(joinState, collabId).some((record) => record.sessionId === sessionId)) {
    return {
      ok: true, collabId, sessionId, mode: 'managed', pending: true, local: true, idempotent: true,
      note: '本会话对该协作的申请已在本机待批准面——不重复提交（重复申请幂等）',
    };
  }
  rememberPendingRequestOf(joinState, collabId, {
    instanceId: joinState.state.self.instanceId,
    identityName: joinState.state.self.identityName,
    sessionId,
    requestedAt: joinState.now(),
  });
  /* 同机申请也必须有「本机确实在等这家站长的回执」的申请记录：grant 经核内旁路回来时，
   * 加入域按它判断回执不是凭空可造的（与受邀同意补记的申请同一判据）。 */
  rememberLocalJoinApplicationOf(joinState, collabId, sessionId);
  return {
    ok: true, collabId, sessionId, mode: 'managed', pending: true, local: true,
    note: '本机是该协作的站长——申请已进本机待批准面（本机任意会话可批；批准即接线本会话）',
  };
}

function rememberLocalJoinApplicationOf(joinState, collabId, sessionId) {
  joinState.state.joinApplications.add({
    collabId,
    sessionId,
    managerInstanceId: joinState.state.self.instanceId,
    msgId: `local-join-${randomUUID()}`,
    sentAt: joinState.now(),
  });
}

/* 直投申请帧（设计 §2：有 collabId 的申请直投站长）：发送面返回的帧标识即申请记录的回执比对键
 * （回执携它命中本机唯一的申请记录）。 */
function dispatchJoinRequest(joinState, plan) {
  const result = sendJoinRequestOf(joinState, plan);
  if (result.ok !== true) {
    return { ok: false, message: `加入申请发送失败：${result.reason}——稍后重试` };
  }
  /* 站长端点随申请台账定格：后续 grant 到达时本机可能还没有该协作（冷启动），
   * 回执的寻址只能靠这条记录（协作记录建起来之前没有端点表可查）。 */
  joinState.state.joinApplications.add({
    collabId: plan.collabId,
    sessionId: plan.sessionId,
    managerInstanceId: plan.manager.instanceId,
    msgId: result.msgId,
    sentAt: plan.sentAt,
    ...(typeof plan.manager.address === 'string' ? { managerAddress: plan.manager.address } : {}),
    ...(Number.isInteger(plan.manager.port) ? { managerPort: plan.manager.port } : {}),
  });
  armRetry(joinState, plan);
  return {
    ok: true, collabId: plan.collabId, sessionId: plan.sessionId, mode: 'managed', pending: true,
    manager: { instanceId: plan.manager.instanceId }, msgId: result.msgId,
    note: '已直投站长——批准后经回执接线本会话；等待期间按短节律重发至申请时限',
  };
}

/* 申请帧发送（成功给帧标识；失败给原因，供调用方如实报错）。 */
function sendJoinRequestOf(joinState, plan) {
  if (joinState.send === null) {
    return { ok: false, reason: '直投面不可用（发送注入缺失）' };
  }
  const result = joinState.send({
    collabId: plan.collabId,
    to: { instanceId: plan.manager.instanceId, address: plan.manager.address, port: plan.manager.port },
    type: 'join-request',
    payload: { sessionId: plan.sessionId },
    fromSessionId: plan.sessionId,
  });
  if (result?.ok !== true || typeof result.msgId !== 'string') {
    joinState.log.warn(`${JOIN_APPLICATION_LABEL}帧发送失败`, { collabId: plan.collabId, sessionId: plan.sessionId, reason: result?.reason ?? '发送面未返回消息标识' });
    return { ok: false, reason: result?.reason ?? '发送面未返回消息标识' };
  }
  return { ok: true, msgId: result.msgId };
}

/* —— 申请重发轮（短节律至申请时限） —— */

/* 重发＝换记录里的帧标识（发送面每帧生成新标识），但保留首次发出时刻——时限基准不因重发续命；
 * 记录被回执收尾删掉或过剪除即停轮（定时器不阻止进程退出）。 */
function armRetry(joinState, plan) {
  const key = retryKeyOf(plan.collabId, plan.sessionId);
  if (joinState.retries.has(key)) {
    return;
  }
  /** @type {{ timer: any, delayMs: number, plan: any }} */
  const entry = { timer: null, delayMs: retryDelayOf(joinState), plan };
  joinState.retries.set(key, entry);
  entry.timer = setTimeout(() => runRetry(joinState, key, entry), entry.delayMs);
  unrefTimer(entry.timer);
}

function runRetry(joinState, key, entry) {
  entry.timer = null;
  /* 停轮前先判「是不是超时」：记录消失有两个来路——已落地（批准 / 拒绝，收尾时已停轮）与
   * 过时限剪除；只有后者留一行超时提示（已处置的申请不提示，避免「批准了还说超时」）。 */
  const held = findApplication(joinState, entry.plan.collabId, entry.plan.sessionId);
  const expired = held !== null && joinState.now() - held.sentAt >= ttlOf(joinState);
  pruneApplications(joinState);
  const record = findApplication(joinState, entry.plan.collabId, entry.plan.sessionId);
  if (record === null) {
    if (expired) {
      presentExpiry(joinState, held);
    }
    joinState.retries.delete(key);   // 已落地（批准 / 拒绝）或过时限剪除：停轮
    return;
  }
  const result = sendJoinRequestOf(joinState, entry.plan);
  if (result.ok === true) {
    replaceApplication(joinState, record, result.msgId);
  }
  entry.delayMs = Math.min(entry.delayMs * 2, retryCeilingOf(joinState));
  entry.timer = setTimeout(() => runRetry(joinState, key, entry), entry.delayMs);
  unrefTimer(entry.timer);
}

function stopRetry(joinState, collabId, sessionId) {
  const key = retryKeyOf(collabId, sessionId);
  const entry = joinState.retries.get(key);
  if (entry === undefined) {
    return false;
  }
  if (entry.timer !== null) {
    clearTimeout(entry.timer);
  }
  joinState.retries.delete(key);
  return true;
}

function retryKeyOf(collabId, sessionId) {
  return `${collabId}\u0000${sessionId}`;
}

/* 重发节律：短节律起步、逐次加倍至上限（短节律＝即时性，上限＝长待机下的开销封顶）。 */
function retryDelayOf(joinState) {
  const base = joinState.state.joinRequestRetryMs;
  return Math.min(Number.isFinite(base) && base > 0 ? base : JOIN_REQUEST_RETRY_MS, retryCeilingOf(joinState));
}

function retryCeilingOf(joinState) {
  const ceiling = joinState.state.joinRequestRetryMaxMs;
  return Number.isFinite(ceiling) && ceiling > 0 ? ceiling : JOIN_REQUEST_RETRY_MAX_MS;
}

function unrefTimer(timer) {
  if (typeof timer?.unref === 'function') {
    timer.unref();
  }
}

/* —— 申请台账（本机已发出的未决申请） —— */

/* 时限剪除（发起点与重发轮各一次）：时限取注入值，参数非法一律不剪（剪早了会打断仍在窗口内的链）。 */
function pruneApplications(joinState) {
  return joinState.state.joinApplications.pruneExpired(ttlOf(joinState), joinState.now());
}

function findApplication(joinState, collabId, sessionId) {
  return joinState.state.joinApplications.list().find((application) => application.collabId === collabId && application.sessionId === sessionId) ?? null;
}

/* 重发换帧标识：删旧（按旧帧标识）＋以同一条余下字段重入账（首次发出时刻原样保留）。 */
function replaceApplication(joinState, record, msgId) {
  joinState.state.joinApplications.remove(record.msgId);
  joinState.state.joinApplications.add({ ...record, msgId });
}

/* 申请记录收尾（批准 / 拒绝落地）：按（协作 ＋ 会话）全清并停轮——重发轮会留下多个帧标识的记录，
 * 残留会让已处置的申请在本机台账里滞留至时限。 */
function clearApplications(joinState, collabId, sessionId) {
  for (const record of joinState.state.joinApplications.list()) {
    if (record.collabId === collabId && record.sessionId === sessionId) {
      joinState.state.joinApplications.remove(record.msgId);
    }
  }
  stopRetry(joinState, collabId, sessionId);
}

/* —— 回执落地（发起机） —— */

/* 回执比对（与准入门同一判据：collabId ＋ 站长实例 ＋ 申请帧标识 ＋ 未过期；毫秒基准 now − sentAt < 时限）。
 * 准入门不回带命中记录，收尾（删记录 / 写绑定）在此复刻同一判据——判据同源，避免两处分叉。 */
function matchApplication(joinState, frame) {
  const managerInstanceId = frame?.from?.instanceId;
  const reqMsgId = frame?.payload?.reqMsgId;
  return joinState.state.joinApplications.list().find((application) =>
    application.collabId === frame?.collabId
    && application.managerInstanceId === managerInstanceId
    && application.msgId === reqMsgId
    && joinState.now() - application.sentAt < ttlOf(joinState)) ?? null;
}

/* 批准回执（设计 §2）：补本机席位（获准权威＝共享名单/本机席位）→ 写绑定（origin:grant——
 * 离线会话＝持久映射、重开即活）→ 删申请记录 → 开该协作页（「进入即见」）。授权对象＝回执
 * 携的会话，须与命中记录一致（准入门不比对会话标识，这一步在本域补：不一致的回执不得改
 * 他会话的绑定）。joins.json 的 approvals 已退役（契约 §4），回执不再写盘。 */
function handleJoinGrantLegacy(joinState, frame) {
  const record = matchGrantedApplication(joinState, frame);
  if (record === null) {
    return null;
  }
  const local = joinState.state.collabs.get(record.collabId);
  if (local !== undefined) {
    ensureBoundSeatOf(joinState, local, record.sessionId);
  }
  finishGranted(joinState, { collabId: record.collabId, sessionId: record.sessionId });
  return { ok: true, action: 'granted', collabId: record.collabId, sessionId: record.sessionId };
}

/* 回执与本机申请台账的比对（含授权会话一致性）：命中且一致才返回记录，否则留痕返回 null。 */
function matchGrantedApplication(joinState, frame) {
  const record = matchApplication(joinState, frame);
  if (record === null) {
    joinState.log.warn('加入批准回执与本机申请台账不匹配（未申请或已过期），忽略', { collabId: frame?.collabId, msgId: frame?.msgId });
    return null;
  }
  if (idOf(frame.payload?.sessionId) !== record.sessionId) {
    joinState.log.warn('加入批准回执的授权会话与命中记录不一致，忽略', { collabId: record.collabId, authorized: frame.payload?.sessionId });
    return null;
  }
  return record;
}

/* 拒绝回执（设计 §2）：删申请记录 ＋ 本机提示呈现拒绝与原因（沿既有本机提示先例）。 */
function handleJoinDenyLegacy(joinState, frame) {
  const record = matchApplication(joinState, frame);
  if (record === null) {
    joinState.log.warn('加入拒绝回执与本机申请台账不匹配（未申请或已过期），忽略', { collabId: frame?.collabId, msgId: frame?.msgId });
    return null;
  }
  clearApplications(joinState, record.collabId, record.sessionId);
  presentDenial(joinState, { collabId: record.collabId, sessionId: record.sessionId, reason: reasonOf(frame?.payload?.reason) });
  return { ok: true, action: 'denied', collabId: record.collabId, sessionId: record.sessionId };
}

/* 获准的接线收尾（批准回执与站长侧本机自批共用）：写绑定 → 删申请记录 → 开页。 */
function finishGranted(joinState, { collabId, sessionId }) {
  bindSession(joinState, { collabId, sessionId, origin: 'grant' });
  clearApplications(joinState, collabId, sessionId);
  openCollabView(joinState, collabId);
}

/* 接线（设计 §7）：绑定表直写——核心绑定表的 set 即含落盘（原子替换），本域不另写盘；
 * 休眠 / 离线会话＝写持久映射，该会话重开（重新注册）即活跃（活跃判定只认会话标识）。
 * 出处记录取会话当前桥，会话不在场时以会话标识兜底（形态仍是合法标识，加载面照收）。 */
function bindSession(joinState, { collabId, sessionId, origin }) {
  const bindings = joinState.state.bindings;
  if (bindings === null || typeof bindings?.set !== 'function') {
    joinState.log.warn('绑定表未注入——接线未落地（该会话收不到该协作的注入）', { collabId, sessionId, origin });
    return false;
  }
  bindings.set(collabId, { sessionId, bridgeId: bridgeIdOf(joinState, sessionId), boundAt: new Date(joinState.now()).toISOString(), origin });
  return true;
}

function bridgeIdOf(joinState, sessionId) {
  const resolve = joinState.state.bridgeIdOf;
  return (typeof resolve === 'function' ? idOf(resolve(sessionId)) : null) ?? sessionId;
}

/* 席位绑定的桥（运行态注入面用）：与服务装配处的注册表同源，缺省 null＝未注册。 */
function bridgeOfSeat(joinState, sessionId) {
  const bridges = joinState.state.sessionBridges;
  const bridgeId = bridges instanceof Map ? bridges.get(sessionId) : undefined;
  return typeof bridgeId === 'string' && bridgeId !== '' ? bridgeId : null;
}

function openCollabView(joinState, collabId) {
  if (joinState.openViewer !== null) {
    joinState.openViewer({ root: MAIN_VIEWER_ROOT, id: collabId });
  }
}

/* 拒绝呈现：一行本机提示（协作名 ＋ 本会话短码 ＋ 原因），按**申请会话**寻址投递——被拒会话
 * 尚未接线（申请被拒的常态），按绑定路由投不到它；帧携 targetSessionId，核心路由据其投该会话
 * 的桥。该会话不在场即由路由面按「指名会话不在场」丢弃留痕：不静默消失，也不把拒绝误投给
 * 持有该协作席位的他会话。 */
function presentDenial(joinState, { collabId, sessionId, reason }) {
  const local = joinState.state.collabs.get(collabId);
  const name = local === undefined ? collabId : localNameOf(local);
  const head = `加入申请被拒绝：协作「${name}」的站长拒绝了本会话（${shortSessionId(sessionId)}）的加入申请`;
  notifySession(joinState, local ?? { collabId }, sessionId, reason === undefined ? head : `${head}——原因：${reason}`);
}

/* 超时呈现（设计 §2：TTL 到期提示）：一行本机提示投**申请会话**（与拒绝呈现同一寻址形态——
 * 未接线的会话按绑定路由投不到，帧携 targetSessionId 由核心路由定向投桥）。协作名可查时带上，
 * 查不到（未在席路径）退回协作标识；短码与拒绝呈现同款（对外表示一律短码）。 */
function presentExpiry(joinState, record) {
  joinState.log.info('加入申请超时（时限到即剪除并停发）', { collabId: record.collabId, sessionId: record.sessionId });
  const local = joinState.state.collabs.get(record.collabId);
  const name = local === undefined ? record.collabId : localNameOf(local);
  const head = `加入申请超时：协作「${name}」在申请时限内未获批准（本会话 ${shortSessionId(record.sessionId)} 的申请已停止重发）`;
  notifySession(joinState, local ?? { collabId: record.collabId }, record.sessionId,
    `${head}——${JOIN_TIMEOUT_VERSION_HINT}；稍后可重新申请，或直接联系对方站长`);
}

/* 按会话寻址的本机提示（拒绝呈现的定向形态）：帧构造与投递口径沿既有本机提示先例（notifyLocal），
 * 只多一个指名面（payload.targetSessionId——与邀请面的目标同字段同语义）。提示是附属面：注入面
 * 缺位 / 抛错一律如实返回（申请记录已删的事实不受影响）。 */
function notifySession(joinState, local, sessionId, text) {
  const state = joinState.state;
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
      payload: { event: 'local-alert', text, targetSessionId: sessionId },
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

/* 拒绝原因的服务层预校验（与协议层 decline / stop 的原因同一判据；空串归一为未给出）。 */
function reasonOf(reason) {
  const validated = validateReason(reason);
  return validated.ok === true ? validated.reason : undefined;
}

function validateReason(reason) {
  const trimmed = typeof reason === 'string' ? reason.trim() : '';
  if (trimmed === '' || isPresentationText(trimmed, MAX_REASON_CHARS)) {
    return { ok: true, reason: trimmed === '' ? undefined : trimmed };
  }
  return { ok: false, message: `拒绝原因非法：需为 ≤${MAX_REASON_CHARS} 字符、不含换行 / 不可见字符的呈现文本` };
}

/* —— 讨论直连分支（模式＝forum；设计 §4） —— */

/* 在席＝本机接线立即（无批准门，写绑定 origin:join）；未在席＝敲门全流程封装
 * （复用敲门原语：广播按名 → 应答随带 collabId → 任一成员放行 → 同意门 → 历史回填。
 * 本域只到「等待放行」为止——接线在同意门，谁点头谁承接）。 */
async function requestForum(joinState, local, sessionId) {
  /* 讨论成员粒度＝会话：同机另一会话在席不能替本会话放行（无本会话 join 事件即走敲门）。 */
  if (selfJoinedOf(local, joinState.state.self.instanceId, sessionId)) {
    if (bindSession(joinState, { collabId: local.collabId, sessionId, origin: 'join' }) !== true) {
      return { ok: false, message: '接线未落地（绑定表不可用）——本会话收不到该讨论的注入' };
    }
    ensureBoundSeatOf(joinState, local, sessionId);
    return { ok: true, collabId: local.collabId, sessionId, mode: 'forum', bound: true, note: '讨论在席＝本机接线立即（无批准门）——本会话开始接收该讨论的注入' };
  }
  return knockByName(joinState, localNameOf(local), sessionId);
}

/* 接线成功后的本机席位（论坛加入在域内直接补齐）：席位是发邀请、状态栏与静音的取数面，
 * 只有绑定表记录而无席位会让已加入的成员「看不见也邀不了」。已有席位（含发起人的站长席）
 * 不覆盖角色。 */
function ensureBoundSeatOf(joinState, local, sessionId) {
  if (localSeatOfLocal(local, sessionId) !== null) {
    return;
  }
  upsertLocalSeat(local, {
    version: 1,
    sessionId,
    role: 'member',
    state: 'member',
    joinSeq: rosterJoinSeqOf(local, sessionId),
    joinedAt: new Date(joinState.now()).toISOString(),
    muted: true,
    unverified: false,
  }, seatWriteOptionsOf(joinState, sessionId));
}

/* 讨论入席后的落点升级（设计 §4.2）：论坛没有两段式 grant，同意即真正入席；落点不升级，
 * 目录重启后仍按邀请占位跳过，整条讨论在工具面静默消失。席位同时补齐——判档按
 * 「载体 ＋ 席位/快照证据」识别成员目录，论坛没有快照可依。 */
function ensureJoinedCarrierOf(joinState, collabId, rawSessionId) {
  const local = joinState.state.collabs.get(collabId);
  if (local === undefined || localModeOf(local) !== 'forum') {
    return false;
  }
  if (local.member === null || typeof local.member !== 'object' || local.member.decision !== 'approved') {
    return false;
  }
  const sessionId = joinedSessionOf(joinState, local, rawSessionId);
  if (sessionId === null) {
    return false;
  }
  ensureBoundSeatOf(joinState, local, sessionId);
  ensureSessionSeatsCarrierOf(joinState, local, null);
  return readCarrierFormat(collabDir(joinState.state.dataDir, collabId)) === CARRIER_FORMAT_SESSION_SEATS;
}

/* 升级使用的会话：调用方显式给出优先，其次本机席位，最后桥注册表（同意门落地时调用方
 * 可能还没穿过会话标识——旧直调路径）。 */
function joinedSessionOf(joinState, local, rawSessionId) {
  const explicit = idOf(rawSessionId);
  if (explicit !== null) {
    return explicit;
  }
  const seat = listLocalSeatsOf(local)[0];
  if (seat !== undefined) {
    return seat.sessionId;
  }
  const bridges = joinState.state.sessionBridges;
  if (bridges instanceof Map) {
    for (const sessionId of bridges.keys()) {
      if (idOf(sessionId) !== null) {
        return sessionId;
      }
    }
  }
  return null;
}

/* 席位整写选项（持久化 ＋ 当前桥）：upsertLocalSeat 的桥字段类型由 local.js 推断，
 * 这里以 any 传递运行期真实桥标识（null＝未注册）。 */
function seatWriteOptionsOf(joinState, sessionId) {
  return /** @type {any} */ ({
    persist: true,
    dataDir: joinState.state.dataDir,
    bridgeId: bridgeOfSeat(joinState, sessionId),
  });
}

function rosterJoinSeqOf(local, sessionId) {
  const row = rosterRowsOf(local).find((entry) => entry.sessionId === sessionId);
  return Number.isInteger(row?.joinSeq) ? row.joinSeq : seatsOfLocal(local).size + 1;
}

async function knockByName(joinState, name, sessionId) {
  /* 登记先于敲门：发现层若把敲门回送到本机（同机讨论 / 回环），放行指引才能按
   * (instanceId, sessionId) 指名请求会话；敲门失败时撤掉本次登记（不留没发出去的申请）。 */
  const registration = rememberKnock(joinState, name, sessionId);
  const knocked = await knockOf(joinState, name);
  if (knocked.ok !== true) {
    forgetKnock(joinState, name, registration);
    return knocked;
  }
  return { ok: true, mode: 'forum', sessionId, knocked: true, replies: knocked.replies, note: knockNoteOf(knocked.replies) };
}

/* 敲门登记（设计 §4 的「加入后本会话接线」）：请求会话 ↔ 讨论名——放行者与请求会话未必同一个
 * （敲门不指名，放行后的邀请广播给全部活跃会话），登记让同意门落地时把席位交回请求会话。
 * 同名后敲者覆盖先敲者（一个讨论只留最新的请求会话），登记按申请时限过期（放行来晚了不再接线）。 */
function rememberKnock(joinState, name, sessionId) {
  const registration = { sessionId, at: joinState.now() };
  joinState.knocks.set(name, registration);
  return registration;
}

/* 只撤本次登记（并发的新敲门已覆盖时不动新登记）。 */
function forgetKnock(joinState, name, registration) {
  if (joinState.knocks.get(name) === registration) {
    joinState.knocks.delete(name);
  }
}

/* 登记在册的请求会话（放行指引的指名面）：无登记 / 形态坏一律 null。 */
function knockedSessionOf(joinState, name) {
  const registered = typeof name === 'string' ? joinState.knocks.get(name) : undefined;
  return registered !== undefined && isIdentityName(registered.sessionId) ? registered.sessionId : null;
}

/* 同意门落地后的收口（服务在讨论邀请被批准时调用）：该讨论名登记在册的请求会话接线——放行者
 * 若恰是请求会话，同意门的写点已接线（此处幂等重写）；登记不存在 / 已过期 / 服务面缺位一律不动
 * （既有行为不变）。登记在**接线成功之后**才清除：瞬态不可用（绑定表缺位 / 写盘失败）不丢登记，
 * 待下次落地重试。返回接线到的会话标识，未接线返回 null。 */
function bindKnockedSession(joinState, local, acceptedSessionId = null) {
  if (local === undefined || localModeOf(local) !== 'forum') {
    return null;
  }
  const name = localNameOf(local);
  const registered = joinState.knocks.get(name);
  if (registered === undefined) {
    return null;
  }
  if (joinState.now() - registered.at >= ttlOf(joinState) || !isIdentityName(registered.sessionId)) {
    joinState.knocks.delete(name);   // 过期（放行来得太晚）或形态坏：登记作废
    return null;
  }
  /* 防幽灵席位（设计 §4.5）：只有点头的会话就是敲门会话，或敲门会话已有自己的 join 事件，
   * 才把席位交回它——其他会话接受未指名邀请时不得替敲门者建席（成员事件由各自会话作者发）。 */
  const accepted = idOf(acceptedSessionId);
  if (accepted !== registered.sessionId && !selfJoinedOf(local, joinState.state.self.instanceId, registered.sessionId)) {
    return null;   // 放行未指名到敲门会话：登记保留，等该会话自己同意
  }
  if (bindSession(joinState, { collabId: local.collabId, sessionId: registered.sessionId, origin: 'join' }) !== true) {
    return null;   // 接线未落地：登记保留（本会话待下次落地接线）
  }
  ensureBoundSeatOf(joinState, local, registered.sessionId);
  ensureJoinedCarrierOf(joinState, local.collabId, registered.sessionId);
  joinState.knocks.delete(name);   // 一次性登记：席位已交回，不重复接线
  return registered.sessionId;
}

/* 敲门原语调用（网络面缺位 / 降级 / 异常同归一处如实报错；无应答＝空清单，不是失败）。 */
async function knockOf(joinState, name) {
  if (typeof joinState.state.requestJoin !== 'function') {
    return { ok: false, message: '敲门面不可用（网络组件未注入）——稍后重试' };
  }
  let result;
  try {
    result = await joinState.state.requestJoin({ name });
  } catch (error) {
    return { ok: false, message: `敲门失败：${error?.message ?? '未知原因'}` };
  }
  if (result?.ok !== true) {
    return { ok: false, message: result?.message ?? '敲门失败（网络面未返回原因）' };
  }
  return { ok: true, replies: Array.isArray(result.replies) ? result.replies : [] };
}

function knockNoteOf(replies) {
  return replies.length === 0
    ? '敲门无人应答（对端未在运行或无人值守）——稍后重试或直接联系成员'
    : '已有成员应答——等待放行：放行＝成员邀请本机，入席在同意门，本会话随后接线';
}

/* —— 站长侧：申请入站与处置 —— */

/* 申请入站（设计 §2）：写待批准面（含申请帧标识——回执的回带凭据；展示面只取其中四项）。
 * 非站长机器不落（批准权不随数据副本走）——但回一支拒绝回执，静默丢弃会让申请人空等至申请时限、
 * 还把沉默误读成「对端版本不支持」；同会话重发＝就地刷新（台账按会话幂等），
 * 重发带来的新帧标识即最新回执比对键。 */
function handleJoinRequest(joinState, frame) {
  const collabId = frame.collabId;
  const local = joinState.state.collabs.get(collabId);
  /* 已结束/已退出的协作不再收申请：入站门可能放行 join-request，写面必须自行 fail-closed。 */
  if (local !== undefined && isLocalArchivedState(local)) {
    joinState.log.warn('加入申请未落待批准面（协作已结束）', { collabId });
    return { ok: false, action: 'join-refused', collabId, reason: 'archived' };
  }
  if (!isJoinManager(local)) {
    return refuseForeignJoin(joinState, frame, collabId);
  }
  const ids = joinIdsOf(frame);
  if (ids === null) {
    joinState.log.warn('加入申请形态不全（会话标识 / 来源实例缺失），未落待批准面', { collabId });
    return null;
  }
  /* 0.2.0 的待批准面只存内存（joins.json 的 pendingJoins 专用于未确认 joining）；
   * 旧 v1 待批准记录仍可读入，但不再新写——避免 v1 整档覆盖 v2 的在途 grant。 */
  rememberPendingRequestOf(joinState, collabId, pendingRecordOf(joinState, frame, ids));
  return { ok: true, action: 'join-requested', collabId, sessionId: ids.sessionId };
}

/* 批准权判据：有席位表时只认站长席位；无席位的旧记录退回角色缓存（兼容面）。 */
function isJoinManager(local) {
  if (local === undefined) {
    return false;
  }
  return seatsOfLocal(local).size === 0 ? local.role === 'manager' : managerSeatOfLocal(local) !== null;
}

/* 非站长机器收到申请：回一支拒收回执（reason 指路赶站长）——申请人台账里的 managerInstanceId
 * 恰是应答者实例、reqMsgId 即本帧，回执比对天然命中，24 小时静默空等换成即时可行动拒绝；
 * 申请人在本机侧经既有拒绝呈现看到原因并清掉申请记录。回不了（来源实例 / 帧标识形态坏、端点
 * 未知、发送面拒绝）只留痕：申请人仍由申请时限收敛，不因本机补答失败而更糟。 */
function refuseForeignJoin(joinState, frame, collabId) {
  const instanceId = idOf(frame.from?.instanceId);
  joinState.log.warn('加入申请未落待批准面（本机不是该协作的站长）', { collabId, from: instanceId });
  const reqMsgId = idOf(frame.msgId);
  const target = instanceId === null ? null : decisionTargetOf(joinState, collabId, instanceId);
  if (reqMsgId === null || target === null) {
    return null;
  }
  const validated = validateReason('本机不是该协作的站长——请向站长所在实例申请');
  if (validated.ok !== true) {
    return null;
  }
  const sent = sendFrameOf(joinState, {
    collabId, target, type: 'join-deny', payload: { reqMsgId, reason: validated.reason },
    fromSessionId: senderSessionOf(joinState, collabId) ?? undefined,
  });
  return sent.ok === true ? { ok: true, action: 'join-refused', collabId } : null;
}

/* 申请帧的两个标识（形态已由协议层把关，此处只兜注入面与直调的坏形态）。 */
function joinIdsOf(frame) {
  const sessionId = idOf(frame.payload?.sessionId);
  const instanceId = idOf(frame.from?.instanceId);
  return sessionId === null || instanceId === null ? null : { sessionId, instanceId };
}

/* 待批准条目（申请帧标识随条目落账：回执要把它原样回带，台账之外没有第二处记得住它；
 * 身份名可省——缺省者按会话短码呈现）。 */
function pendingRecordOf(joinState, frame, ids) {
  const record = { instanceId: ids.instanceId, sessionId: ids.sessionId, requestedAt: joinState.now(), reqMsgId: frame.msgId };
  if (isIdentityName(frame.from.identityName)) {
    record.identityName = frame.from.identityName;
  }
  return record;
}

/* 站长处置（设计 §2/§6）：批准＝授权申请人会话（写批准记录 ＋ 回 join-grant）；拒绝＝回 join-deny
 * （含原因）并出待批准面。申请人会话在本机（本机自批）时不投网络帧——批准即本机完成接线，
 * 拒绝即本机提示呈现原因。会话参数取全标识或唯一前缀（短码是对外表示）。 */
function approveJoinLegacy(joinState, input) {
  const refusal = approveRefusalOf(joinState, input);
  if (refusal !== null) {
    return refusal;
  }
  const store = storeOf(joinState, input.collabId);
  store.load();
  const pending = matchPending(joinState, pendingJoinsOf(joinState, input.collabId), input.sessionId);
  if (pending === null) {
    return { ok: false, message: '该会话没有待批准的加入申请（可能已过期、已处置，或会话标识不符）' };
  }
  const plan = { collabId: input.collabId, store, pending, approvedBy: input.approvedBy, grantedAt: joinState.now() };
  const result = input.approve === true ? grantPending(joinState, plan) : denyPending(joinState, plan, input.reason);
  if (result?.ok === true) {
    forgetPendingRequestOf(joinState, input.collabId, pending);
  }
  return result;
}

/* 处置前置拒绝：协作不在本机 / 本机非站长（批准权不随数据副本走）/ 批准者身份非法。null＝可处置。 */
function approveRefusalOf(joinState, input) {
  const local = joinState.state.collabs.get(input?.collabId);
  if (local === undefined) {
    return { ok: false, message: '本机没有该协作（collabId 不存在）——先看 ws_list_collabs' };
  }
  if (local.role !== 'manager') {
    return { ok: false, message: '本机不是该协作的站长（无批准权）——批准权不随数据副本走' };
  }
  if (!isIdentityName(input?.approvedBy)) {
    return { ok: false, message: '参数 approvedBy 非法：需要批准者身份（身份名或会话标识，非空白、不含不可见字符）' };
  }
  return null;
}

/* 待批准匹配：全标识精确命中优先，否则在待批准名单内做唯一前缀匹配（歧义 / 未命中一律按
 * 「没有该待批准」处置）；过期待批准视同不存在（与 pendingJoinsOf 的存活面同一时限判据）。 */
function matchPending(joinState, records, wanted) {
  const live = records.filter((record) => joinState.now() - record.requestedAt < ttlOf(joinState));
  const exact = live.find((record) => record.sessionId === wanted);
  if (exact !== undefined) {
    return exact;
  }
  if (idOf(wanted) === null) {
    return null;
  }
  const matched = live.filter((record) => record.sessionId.startsWith(wanted));
  return matched.length === 1 ? matched[0] : null;
}

/* 批准落地：申请人会话在本机（本机自批）＝本机直接接线（回执无从经网络回到自己）；
 * 远端申请人＝补入席（未在册时）＋投回执。approvals 已退役（契约 §4）：获准权威是共享名单
 * 与本机席位，批准不再写本地获准台账。 */
function grantPending(joinState, plan) {
  return plan.pending.instanceId === joinState.state.self.instanceId
    ? completeLocalGrant(joinState, plan)
    : completeRemoteGrant(joinState, plan);
}

function completeLocalGrant(joinState, plan) {
  const local = joinState.state.collabs.get(plan.collabId);
  if (local !== undefined) {
    ensureBoundSeatOf(joinState, local, plan.pending.sessionId);
  }
  plan.store.removePendingJoin(plan.pending.sessionId);
  finishGranted(joinState, { collabId: plan.collabId, sessionId: plan.pending.sessionId });
  return { ok: true, collabId: plan.collabId, sessionId: plan.pending.sessionId, local: true, bound: true };
}

/* 远端申请人：先补入席（申请人机器尚未在册时）、再投授权回执——回执 / 邀请发不出去都按
 * 「未处置」收口（待批准面保留，可重试）；批准记录不落本机（权威在共享名单与申请人席位）。 */
function completeRemoteGrant(joinState, plan) {
  const seated = ensureApplicantSeated(joinState, plan);
  if (seated.ok !== true) {
    return seated;
  }
  const sent = sendPendingDecision(joinState, plan, 'join-grant', { sessionId: plan.pending.sessionId });
  if (sent.ok !== true) {
    return sent;
  }
  plan.store.removePendingJoin(plan.pending.sessionId);
  return { ok: true, collabId: plan.collabId, sessionId: plan.pending.sessionId, sent: true, seated: seated.seated };
}

/* 批准一并完成入席（设计 §2）：申请人机器尚未在册（不在台账名单内）＝先把它登进台账名单为
 * invited、再经既有邀请通道把该机器请进来——受邀准入路径（handleInvite）负责对方本机协作注册
 * 与成员记录，载荷用既有构造（名单取自台账，含被邀者），并指名申请会话（点头权归它；离线时按
 * 既有的指名挂起补投）。机器已在册且非终局＝无需入席（新窗口跟进照旧只由批准回执接线）；
 * 终局行（declined / withdrawn / left）＝重邀把该行翻回 invited 再走邀请通道（2026-10-19
 * 产品裁定：终局行可再入席，站长批准制）。
 * 登记在先使受邀请链路闭环：申请人点头时站长侧按「名单内且 invited」定位回应方（否则按
 * eventMismatch 丢弃、名册永不收录该机器），且「已在册（非终局）」判据对同机器的新窗口立即成立（不重发）。 */
function ensureApplicantSeated(joinState, plan) {
  const local = joinState.state.collabs.get(plan.collabId);
  const held = localRosterOf(local).find((entry) => entry.instanceId === plan.pending.instanceId);
  if (held !== undefined && !isRejoinableMemberState(held.state)) {
    return { ok: true, seated: true };
  }
  const target = decisionTargetOf(joinState, plan.collabId, plan.pending.instanceId);
  if (target === null) {
    return { ok: false, message: `申请人端点未知（${plan.pending.instanceId}）——先 ws_list_hosts 确认对方在线，或让申请人重新申请（入站帧会带来端点）` };
  }
  /* 终局行重邀的回滚快照：投递失败时恢复原终局行（不是删行——历史不得因重试丢失）。 */
  const previous = held === undefined ? null : { ...held };
  if (!registerInvitedMember(joinState, local, plan.pending)) {
    return { ok: false, message: '受邀登记未落地（台账写入被暂停或失败）——未落处置，可稍后重试' };
  }
  const payload = { ...invitePayloadOf(local.ledger), targetSessionId: plan.pending.sessionId };
  const sent = sendFrameOf(joinState, {
    collabId: plan.collabId, target, type: 'invite', payload,
    fromSessionId: senderSessionOf(joinState, plan.collabId) ?? undefined,
  });
  if (sent.ok !== true) {
    rollbackInvitedMember(joinState, local, plan.pending, previous);
    return { ok: false, message: `入席邀请发送失败：${sent.reason}——未落处置，可稍后重试` };
  }
  joinState.state.counters.invitesSent++;
  return { ok: true, seated: false };
}

/* 可重入的终局行（2026-10-19 产品裁定：终止行可再入席，站长批准制）：重邀把该行翻回 invited，
 * 对方同意后照常经回应守卫入席。非终局行（invited / approved / member）不重写。 */
const REJOINABLE_MEMBER_STATES = new Set(['declined', 'withdrawn', 'left']);

function isRejoinableMemberState(state) {
  return REJOINABLE_MEMBER_STATES.has(state);
}

/* 受邀登记（创建流同形：role:'member' ＋ state:'invited' ＋ joinedAt，经台账写面落地并推快照）。
 * 已在名单且非终局不重写（approved / member 不得被翻转）；终局行（declined / withdrawn / left）
 * 重邀时翻回 invited（用户裁定放开的再入席路径）。
 * 返回是否已登记（写面被挂起 / 失败返回 false：调用方据此不投邀请，免得对方点头被拒）。 */
function registerInvitedMember(joinState, local, pending) {
  const held = localRosterOf(local).find((entry) => entry.instanceId === pending.instanceId);
  if (held !== undefined && !isRejoinableMemberState(held.state)) {
    return true;
  }
  const registered = mutateLedger(joinState.state, local, (ledger) => {
    const row = ledger.members.find((entry) => entry.instanceId === pending.instanceId);
    if (row === undefined) {
      ledger.members.push({
        instanceId: pending.instanceId,
        sessionId: pending.sessionId,
        identityName: applicantNameOf(pending),
        role: 'member',
        state: 'invited',
        joinedAt: new Date(joinState.now()).toISOString(),
      });
      return;
    }
    row.sessionId = pending.sessionId;
    row.state = 'invited';
    row.identityName = applicantNameOf(pending);
    row.joinedAt = new Date(joinState.now()).toISOString();
  });
  if (registered === null) {
    joinState.log.warn('受邀登记未落地（台账写被挂起）', { collabId: local.collabId, instanceId: pending.instanceId });
    return false;
  }
  return true;
}

/* 受邀登记回滚（邀请投递失败的收口）：摘除刚写入的 invited 行——登记先于投递，若留着这条孤儿行，
 * 「已在册」判据会让**重试**直接跳过邀请、只发出授权回执（申请人拿不到邀请却收到一发即落的回执
 * ＝悬空端态，正是该判据要防的那条路）。新登记行摘除；终局行重邀（previous 非空）还原原行——
 * 回滚只面对自己刚写的那一条，历史不得因一次投递失败丢失。回滚失败如实告警（不静默——孤儿行
 * 会让后续重试全部跳过邀请）。 */
/**
 * @param {any} joinState
 * @param {any} local
 * @param {any} pending
 * @param {object | null} [previous]
 */
function rollbackInvitedMember(joinState, local, pending, previous = null) {
  const held = local.ledger.members.find((entry) => entry.instanceId === pending.instanceId);
  if (held === undefined) {
    return true;
  }
  if (previous !== null) {
    const restored = mutateLedger(joinState.state, local, (ledger) => {
      ledger.members = ledger.members.map((entry) => (entry.instanceId === pending.instanceId ? { ...previous } : entry));
    });
    if (restored === null) {
      joinState.log.warn('受邀登记回滚失败（台账写被挂起）——重试可能跳过邀请，请核对名册', { collabId: local.collabId, instanceId: pending.instanceId });
      return false;
    }
    return true;
  }
  if (held.state !== 'invited') {
    return true;
  }
  const rolled = mutateLedger(joinState.state, local, (ledger) => {
    ledger.members = ledger.members.filter((entry) => entry.instanceId !== pending.instanceId);
  });
  if (rolled === null) {
    joinState.log.warn('受邀登记回滚失败（台账写被挂起）——重试可能跳过邀请，请核对名册', { collabId: local.collabId, instanceId: pending.instanceId });
    return false;
  }
  return true;
}

/* 被邀者身份名（邀请名单的形态判据要求可呈现）：受邀帧的 from 已过协议校验，缺名时退回实例标识。 */
function applicantNameOf(pending) {
  return isIdentityName(pending.identityName) ? pending.identityName : pending.instanceId;
}

/* 拒绝落地：本机自批＝本机提示呈现原因；远端申请人＝回 join-deny（含原因），发不出去即不落处置。 */
function denyPending(joinState, plan, reason) {
  const validated = validateReason(reason);
  if (validated.ok !== true) {
    return { ok: false, message: validated.message };
  }
  if (plan.pending.instanceId === joinState.state.self.instanceId) {
    plan.store.removePendingJoin(plan.pending.sessionId);
    presentDenial(joinState, { collabId: plan.collabId, sessionId: plan.pending.sessionId, reason: validated.reason });
    return { ok: true, collabId: plan.collabId, sessionId: plan.pending.sessionId, local: true };
  }
  const payload = validated.reason === undefined ? {} : { reason: validated.reason };
  const sent = sendPendingDecision(joinState, plan, 'join-deny', payload);
  if (sent.ok !== true) {
    return sent;
  }
  plan.store.removePendingJoin(plan.pending.sessionId);
  return { ok: true, collabId: plan.collabId, sessionId: plan.pending.sessionId, sent: true };
}

/* 回执直投（设计 §2：回执是即时帧）：申请帧标识 ＋ 回执特有载荷；端点未知 / 发送面拒绝都如实返回
 * 原因，调用方据此定「未处置」（待批准面保留，可重试）。 */
function sendPendingDecision(joinState, plan, type, payload) {
  if (typeof plan.pending.reqMsgId !== 'string') {
    return { ok: false, message: '该待批准条目缺申请帧标识（旧记录）——请申请人重新申请后再处置' };
  }
  const target = decisionTargetOf(joinState, plan.collabId, plan.pending.instanceId);
  if (target === null) {
    return { ok: false, message: `申请人端点未知（${plan.pending.instanceId}）——先 ws_list_hosts 确认对方在线，或让申请人重新申请（入站帧会带来端点）` };
  }
  const sent = sendFrameOf(joinState, {
    collabId: plan.collabId, target, type,
    payload: { reqMsgId: plan.pending.reqMsgId, ...payload },
    fromSessionId: senderSessionOf(joinState, plan.collabId) ?? undefined,
  });
  return sent.ok === true ? { ok: true } : { ok: false, message: `回执发送失败：${sent.reason}——未落处置，可稍后重试` };
}

/* 直投出口（批准回合的两个动作——入席邀请与授权回执——同走直投面：同通道同命运；发送面缺位 /
 * 拒绝都如实返回原因）。 */
function sendFrameOf(joinState, { collabId, target, type, payload, fromSessionId }) {
  if (joinState.send === null) {
    return { ok: false, reason: '直投面不可用（发送注入缺失）' };
  }
  const message = { collabId, to: target, type, payload };
  if (typeof fromSessionId === 'string') {
    message.fromSessionId = fromSessionId;
  }
  const result = joinState.send(message);
  return result?.ok === true
    ? { ok: true, msgId: result.msgId }
    : { ok: false, reason: result?.reason ?? '发送面未返回结果' };
}

function decisionTargetOf(joinState, collabId, instanceId) {
  const local = joinState.state.collabs.get(collabId);
  const endpoint = local === undefined ? undefined : endpointFor(joinState.state, local, instanceId);
  return endpoint === undefined ? null : { instanceId, address: endpoint.address, port: endpoint.port };
}

/* —— 待批准提供方与获准判据（准入门 / 核心 adopt 面的注入缝） —— */

/* 待批准存活面（准入门的上限判定注入面；展示面同一取数）：未知协作返空数组（不得抛）。
 * 0.2.0 的待批准面只存内存；旧 v1 条目仍可读，但这里只做读侧过滤，不落盘——写盘投影只归
 * joins.json v2，避免旧 v1 整档覆盖在途 joining。 */
/* 待批准存活面（展示面与准入门共用）：取数归 pendingRequestsOf 的同一口径——过期待批准在
 * 那里按申请时限剪除，本函数不再另拼一份判据（两份判据会分叉出「批准面已过期、展示面仍在」）。 */
function pendingJoinsOf(joinState, collabId) {
  if (joinState.state.collabs.get(collabId) === undefined) {
    return [];
  }
  return pendingRequestsOf(joinState, collabId);
}

/* 本机获准台账判据（设计 §5 的判据单点：adopt 收紧经核心注入本函数）：现读现判——获准的写入方
 * 不止本域（创建 / 同意邀请），缓存会陈旧。判据＝全量会话标识精确匹配（短码是展示面表示）。 */
function isGranted(joinState, collabId, sessionId) {
  if (idOf(collabId) === null || idOf(sessionId) === null || joinState.state.collabs.get(collabId) === undefined) {
    return false;
  }
  const store = storeOf(joinState, collabId);
  store.load();
  return store.isGranted(sessionId);
}

/* 加入台账（每协作）的惰性取数：进程内唯一写者（本域），实例缓存即可；
 * 写前一律 load 刷新（他域写的是同一份文件里的获准名单）。 */
function storeOf(joinState, collabId) {
  const held = joinState.stores.get(collabId);
  if (held !== undefined) {
    return held;
  }
  const store = createJoinsStore({ dataDir: joinState.state.dataDir, collabId, log: joinState.log });
  joinState.stores.set(collabId, store);
  return store;
}

/* —— 按名解析（被问者侧：发现层的命中回调注入面） —— */

/* 按名匹配**本机为该协作站长的** managed 在册协作：唯一命中给 {found:true, collabId, name}；
 * 无匹配 / 同名多义给 {found:false}（名字对不上唯一一条时，申请人无从判定该进哪一个）；已结束的
 * 实例不作命中（不该把人引向必然失败的路）。**只答站长机**：批准权在站长手（设计 §2「申请经
 * 网络直投站长」），成员机应答只会把申请人引向一条无人能批的路（申请被丢、重发至时限）。
 * 讨论不在此面：讨论的加入走敲门广播（应答随带 collabId）。
 * 名字形态非法返回 null＝不应答（缺省面语义；请求形态已由发现层校验，此处只兜底）。 */
export function resolveJoinTarget(state, input) {
  const name = nameOf(input?.name);
  if (name === null) {
    return null;
  }
  const matched = [];
  for (const local of state.collabs.values()) {
    if (isJoinManager(local) && localModeOf(local) === 'managed' && localNameOf(local) === name && !isLocalArchivedState(local)) {
      matched.push(local.collabId);
    }
  }
  return matched.length === 1 ? { found: true, collabId: matched[0], name } : { found: false };
}

/* —— 0.2.0 会话级邀请与两段式入席接线（设计 §4） —— */

const INVITE_TTL_FALLBACK_MS = 24 * 60 * 60 * 1000;
const JOINING_TTL_FALLBACK_MS = 60000;

/* 工具面带了站长会话＝走两段式；旧直调没有该字段，仍走本地批准台账（读侧兼容）。 */
function isSessionApprovalInput(input) {
  return typeof input?.managerSessionId === 'string' && input.managerSessionId !== '';
}

function isSessionGrantFrame(frame) {
  return typeof frame?.payload?.joinId === 'string' && idOf(frame?.payload?.manager?.instanceId) !== null;
}

function isSessionDenyFrame(frame) {
  return typeof frame?.payload?.joinId === 'string';
}

/* 每协作一份三账：[邀请簿记/挂起邀请/在途入席] 的唯一键都不含 collabId，跨协作复用会串台。
 * 首次取用时读盘恢复；恢复后与共享名单对账（已入名单的记录视为已确认并清出投影）。 */
function booksOf(joinState, collabId) {
  const held = joinState.books.get(collabId);
  if (held !== undefined) {
    return held;
  }
  const base = { dataDir: joinState.state.dataDir, collabId, log: joinState.log, now: joinState.now };
  const books = {
    invites: createInvitesFileStore({ ...base, ttlMs: inviteTtlOf(joinState) }),
    pending: createPendingInvitesFileStore({ ...base, capacity: pendingInvitesCapacityOf(joinState) }),
    joining: createJoiningFileStore({
      ...base, joiningTtlMs: joiningTtlOf(joinState), maxJoining: MAX_ACTIVE_SEATS, maxActiveSeats: MAX_ACTIVE_SEATS,
    }),
  };
  joinState.books.set(collabId, books);
  reconcileJoiningWithRoster(joinState, collabId, books);
  return books;
}

function booksForJoinId(joinState, joinId) {
  for (const [collabId, books] of joinState.books) {
    const record = books.joining.registry.get(joinId);
    if (record !== null) {
      return { collabId, books, record };
    }
  }
  for (const collabId of joinState.state.collabs.keys()) {
    const books = booksOf(joinState, collabId);
    const record = books.joining.registry.get(joinId);
    if (record !== null) {
      return { collabId, books, record };
    }
  }
  return null;
}

function reconcileJoiningWithRoster(joinState, collabId, books) {
  const local = joinState.state.collabs.get(collabId);
  if (local === undefined) {
    return;
  }
  let changed = false;
  const invalidated = books.joining.registry.invalidateForManagerChange(managerTermOf(local));
  if (invalidated.ok === true && invalidated.aborted.length > 0) {
    changed = true;
  }
  for (const record of books.joining.registry.list()) {
    if (isRosterMember(local, record.instanceId, record.sessionId)) {
      books.joining.registry.releaseJoining(collabId, record.sessionId);
      changed = true;
    }
  }
  if (changed) {
    books.joining.save();
  }
  /* 重启/重读后恢复确认重发轮：未确认席位必须在清除 unverified 前持续重发（设计 §4.4.6）。 */
  resumeConfirmRetriesOfLocal(joinState, local);
}

function inviteTtlOf(joinState) {
  const ttl = joinState.state.config?.inviteTtlMs;
  return Number.isInteger(ttl) && ttl > 0 ? ttl : INVITE_TTL_FALLBACK_MS;
}

function pendingInvitesCapacityOf(joinState) {
  const capacity = joinState.state.config?.pendingInvitesMax;
  return Number.isInteger(capacity) && capacity > 0 ? capacity : undefined;
}

function joiningTtlOf(joinState) {
  const ttl = joinState.state.config?.joinConfirmTtlMs;
  return Number.isInteger(ttl) && ttl > 0 ? ttl : JOINING_TTL_FALLBACK_MS;
}

function managerTermOf(local) {
  const term = local?.ledger?.managerTerm ?? local?.snapshot?.ledger?.managerTerm;
  return Number.isInteger(term) && term >= 1 ? term : 1;
}

function grantVersionOf(local) {
  const version = local?.ledger?.version ?? local?.snapshot?.ledger?.version;
  return Number.isInteger(version) && version >= 1 ? version : 1;
}

function rosterRowsOf(local) {
  if (local === undefined) {
    return [];
  }
  if (local.role === 'manager') {
    return local.ledger?.members ?? [];
  }
  return local.snapshot?.ledger?.members ?? local.member?.roster ?? [];
}

/* 名单已含本席（崩溃重放 / 重复 confirm 的短路判据）：只认共享名单 / 快照。
 * 本地席位文件不是成员权威——站长台账重建或回退到不含该席的快照后，旧席位文件仍可能写着
 * member；把它当成员会让批准与 confirm 短路而不写共享名单，形成「本机可见、对端不可见」的
 * 双权威分叉（I-10）。本地席位只服务「同 joinId 崩溃重放」的确认重发（resendConfirmForGrantOf
 * 按 joinId 匹配），不参与成员判定。 */
function isRosterMember(local, instanceId, sessionId) {
  if (local === undefined || idOf(instanceId) === null || idOf(sessionId) === null) {
    return false;
  }
  return rosterRowsOf(local).some((row) => row.instanceId === instanceId && row.sessionId === sessionId && row.state === 'member');
}

/* 容量口径（设计 §2.5/§4.4.2）：共享名单活跃席位数，**不含正在 joining 的本席**。
 * 旧台账行可能没有 sessionId：按机器去重，且已计入的机器不再用本地席位重复计数。 */
function activeSeatsCount(joinState, local, exclude) {
  const counted = countRosterSeats(rosterRowsOf(local), exclude);
  if (local === undefined || counted.instanceOnly) {
    return counted.count;
  }
  return counted.count + countLocalSeats(joinState, local, exclude, counted.seen);
}

function countRosterSeats(rows, exclude) {
  const seen = new Set();
  let count = 0;
  let instanceOnly = false;
  for (const row of rows) {
    if (!isCountableSeatRow(row, exclude)) {
      continue;
    }
    const key = `${row.instanceId}\u0000${row.sessionId ?? ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    count++;
    instanceOnly = instanceOnly || row.sessionId === undefined;
  }
  return { count, seen, instanceOnly };
}

function isCountableSeatRow(row, exclude) {
  if (row.state !== 'member') {
    return false;
  }
  return exclude === null || row.instanceId !== exclude.instanceId || row.sessionId !== exclude.sessionId;
}

function countLocalSeats(joinState, local, exclude, seenRoster) {
  let count = 0;
  for (const seat of seatsOfLocal(local).values()) {
    if (seat.state !== 'member' || isExcludedLocalSeat(joinState, seat, exclude)) {
      continue;
    }
    const key = `${joinState.state.self.instanceId}\u0000${seat.sessionId}`;
    if (!seenRoster.has(key)) {
      seenRoster.add(key);
      count++;
    }
  }
  return count;
}

function isExcludedLocalSeat(joinState, seat, exclude) {
  return exclude !== null && exclude.instanceId === joinState.state.self.instanceId && exclude.sessionId === seat.sessionId;
}

function managerSessionOf(joinState, local) {
  const seat = local === undefined ? null : managerSeatOfLocal(local);
  if (seat !== null) {
    return seat.sessionId;
  }
  return local?.role === 'manager' ? null : null;
}

/* 直投帧的签发会话：站长机固定站长席位，成员机取本机最早席位；无席位不臆造。 */
function senderSessionOf(joinState, collabId) {
  const local = joinState.state.collabs.get(collabId);
  if (local === undefined) {
    return null;
  }
  const manager = managerSessionOf(joinState, local);
  return manager ?? listLocalSeatsOf(local)[0]?.sessionId ?? null;
}

function isManagerSession(joinState, local, sessionId) {
  if (local === undefined || localModeOf(local) !== 'managed' || idOf(sessionId) === null) {
    return false;
  }
  const seat = managerSeatOfLocal(local);
  return seat === null ? local.role === 'manager' : seat.sessionId === sessionId;
}

function failureMessage(message, extra = {}) {
  return { ok: false, ...extra, message };
}

/* 席位直投：本机目标走本机旁路注入，远端一帧（toSessions 指名要投的会话）。
 * 本机注入面可能是异步的（准入/交付都要等桥面落定），因此本函数一律返回 Promise：
 * 调用方必须 await 到 resolve 值再决定成败与回滚，不得把「已排入」当成功。 */
async function sendSeatFrame(joinState, { collabId, instanceId, sessionId, type, payload, fromSessionId }) {
  if (instanceId !== joinState.state.self.instanceId) {
    return sendRemoteSeatFrame(joinState, { collabId, instanceId, sessionId, type, payload, fromSessionId });
  }
  return sessionId === undefined
    ? injectLocalBroadcast(joinState, { collabId, type, payload, fromSessionId })
    : injectSeatFrame(joinState, { collabId, sessionId, type, payload, fromSessionId });
}

/* 不指名邀请投本机时按全部已注册会话逐个注入（设计 §4.3）：目标会话可以不持有席位
 * （受邀未入席），因此目标面取注入面/桥注册表，而不是只枚举已有 member 席位。 */
async function injectLocalBroadcast(joinState, { collabId, type, payload, fromSessionId }) {
  const sessions = injectableSessionsOf(joinState, collabId).filter((sessionId) => sessionId !== fromSessionId);
  if (sessions.length === 0) {
    return { ok: false, reason: '本机没有可投递的活跃会话' };
  }
  const results = [];
  for (const sessionId of sessions) {
    results.push(await injectSeatFrame(joinState, { collabId, sessionId, type, payload, fromSessionId }));
  }
  const delivered = results.some((entry) => entry.ok === true);
  return delivered ? { ok: true, local: true, results } : { ok: false, reason: results[0]?.reason ?? '目标会话不可注入', results };
}

/* 本机可投递的会话标识：服务的注入目标面优先（席位 ∪ 桥注册的邀请目标），缺失时退回
 * 本机席位表与桥注册表——邀请注入不要求接收者已是席位（设计 §4.3）。 */
function injectableSessionsOf(joinState, collabId) {
  const state = joinState.state;
  const sessions = new Set();
  collectSessionIdsOf(sessions, state.listInjectableTargets, state, collabId);
  collectSessionIdsOf(sessions, state.listLocalSeats, state, collabId);
  collectLocalSeatIdsOf(sessions, state.collabs?.get?.(collabId));
  for (const sessionId of bridgeSessionIdsOf(state)) {
    sessions.add(sessionId);
  }
  return [...sessions];
}

function collectLocalSeatIdsOf(sessions, local) {
  for (const seat of local === undefined ? [] : listLocalSeatsOf(local)) {
    if (idOf(seat.sessionId) !== null) {
      sessions.add(seat.sessionId);
    }
  }
}

function collectSessionIdsOf(sessions, list, state, collabId) {
  if (typeof list !== 'function') {
    return;
  }
  for (const entry of safeSessionListOf(list, state, collabId)) {
    if (idOf(entry?.sessionId) !== null) {
      sessions.add(entry.sessionId);
    }
  }
}

/* 目标面是附属机制：读不出按「无可投递目标」处置，不打断发送主链。 */
function safeSessionListOf(list, state, collabId) {
  try {
    const entries = list.call(state, collabId);
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
}

function bridgeSessionIdsOf(state) {
  const bridges = state.sessionBridges;
  return bridges instanceof Map ? [...bridges.keys()] : [];
}

function sendRemoteSeatFrame(joinState, { collabId, instanceId, sessionId, type, payload, fromSessionId }) {
  const local = joinState.state.collabs.get(collabId);
  const endpoint = endpointForJoinOf(joinState, collabId, local, instanceId);
  if (endpoint === undefined) {
    return { ok: false, reason: '端点未知（先扫描或等对方联系）' };
  }
  const send = typeof joinState.send === 'function' ? joinState.send : joinState.state.send;
  if (typeof send !== 'function') {
    return { ok: false, reason: '直投面不可用（发送注入缺失）' };
  }
  const message = { collabId, to: { instanceId, address: endpoint.address, port: endpoint.port }, type, payload, fromSessionId };
  if (typeof sessionId === 'string') {
    message.toSessions = [sessionId];
  }
  const result = send(message);
  return result?.ok === true ? { ok: true, msgId: result.msgId } : { ok: false, reason: result?.reason ?? '发送面未返回结果' };
}

async function injectSeatFrame(joinState, { collabId, sessionId, type, payload, fromSessionId }) {
  const inject = joinState.state.injectLocalSeat;
  if (typeof inject !== 'function') {
    return { ok: false, reason: '本机注入面未接线（服务未提供 injectLocalSeat）' };
  }
  if (idOf(sessionId) === null) {
    return { ok: false, reason: '本机目标缺少会话标识' };
  }
  const frame = withCollabCapability({
    v: PROTOCOL_VERSION,
    msgId: newMsgId(),
    type,
    collabId,
    from: { ...joinState.state.self, sessionId: fromSessionId },
    ts: new Date(joinState.now()).toISOString(),
    payload,
  });
  return injectFrameNow(joinState, inject, { collabId, sessionId, type }, frame);
}

async function injectFrameNow(joinState, inject, { collabId, sessionId, type }, frame) {
  let result;
  try {
    result = inject(collabId, sessionId, frame);
  } catch (error) {
    return { ok: false, reason: error?.message ?? '本机注入异常' };
  }
  return resolveInjectionOf(joinState, result, { collabId, sessionId, type });
}

/* 注入结果以 resolve 值为准：异步面拒绝时通常**正常 resolve** `{ok:false,reason}`，
 * 把 thenable 当成功会让邀请/授权在未送达时留下 open 记录或幽灵 grant。 */
async function resolveInjectionOf(joinState, result, { collabId, sessionId, type }) {
  let settled = result;
  if (isThenable(result)) {
    try {
      settled = await result;
    } catch (error) {
      joinState.log.warn('本机席位注入失败', { collabId, sessionId, type, reason: error?.message });
      return { ok: false, reason: error?.message ?? '本机注入异常' };
    }
  }
  return settled?.ok === true
    ? { ok: true, local: true, result: settled }
    : { ok: false, reason: settled?.reason ?? '目标会话不可注入' };
}

function isThenable(value) {
  return value !== null && value !== undefined && typeof value.then === 'function';
}

function inviteTargetOf(input) {
  const instanceId = idOf(input?.targetInstanceId);
  if (instanceId === null) {
    return null;
  }
  const rawSession = input?.targetSessionId;
  if (rawSession === undefined || rawSession === null) {
    return { instanceId };
  }
  const targetSessionId = idOf(rawSession);
  return targetSessionId === null ? null : { instanceId, targetSessionId };
}

/* 指名目标的本机解析（短码或完整标识，精确匹配、歧义拒绝）：本机投递面按全量标识找桥，
 * 原样传短码必然投不出去；远端目标保持原样，由目标机按同一口径解析。 */
function resolveLocalInviteTargetOf(joinState, collabId, target) {
  if (target.targetSessionId === undefined || target.instanceId !== joinState.state.self.instanceId) {
    return { ok: true, target };
  }
  const token = target.targetSessionId;
  const sessions = injectableSessionsOf(joinState, collabId).map((sessionId) => ({ sessionId }));
  const matched = matchSessionByToken(sessions, token);
  if (matched !== null) {
    return { ok: true, target: { ...target, targetSessionId: matched } };
  }
  if (!isSessionShortCode(token)) {
    return { ok: true, target };   // 完整标识原样保留：目标会话尚未注册时由目标机补投路径判定
  }
  return unresolvedShortTargetOf(sessions, token);
}

function unresolvedShortTargetOf(sessions, token) {
  const ambiguous = sessions.filter((entry) => shortSessionId(entry.sessionId) === token).length > 1;
  return failureMessage(
    ambiguous
      ? `指名会话短码在本机有歧义（${token}）——请给完整会话标识`
      : `指名会话短码在本机没有匹配的已注册会话（${token}）`,
    { reason: 'target-session-unresolved' },
  );
}

function inviteIdsOf(input) {
  const collabId = idOf(input?.collabId);
  const managerSessionId = idOf(input?.managerSessionId);
  return collabId === null || managerSessionId === null ? null : { collabId, managerSessionId };
}

function seatMembersOf(joinState, local, managerSessionId) {
  const members = [];
  const seen = new Set();
  const add = (instanceId, sessionId, identityName) => {
    if (idOf(instanceId) === null || idOf(sessionId) === null || !isIdentityName(identityName)) {
      return;
    }
    const key = `${instanceId}\u0000${sessionId}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    members.push({ instanceId, sessionId, identityName });
  };
  add(joinState.state.self.instanceId, managerSessionId, joinState.state.self.identityName);
  for (const seat of listLocalSeatsOf(local)) {
    add(joinState.state.self.instanceId, seat.sessionId, joinState.state.self.identityName);
  }
  for (const row of rosterRowsOf(local)) {
    add(row.instanceId, row.sessionId, row.identityName ?? row.instanceId);
  }
  return members;
}

function invitePayloadV2Of(joinState, local, inviteId, target, managerSessionId) {
  return {
    name: localNameOf(local),
    topic: localTopicOf(local) ?? '',
    mode: 'managed',
    inviteId,
    targets: [target],
    members: seatMembersOf(joinState, local, managerSessionId),
  };
}

/* 建协首邀的最小簿记面（设计 §4.1）：出站层在发送前为每个 managed 目标开一条 open 记录并落盘，
 * 拿到 inviteId 才能组出可两段式同意的邀请。写入失败返回明确原因，调用方不得发出邀请——
 * 发得出去却无人能校验的记录会让受邀会话的 approve 永远被拒。 */
function openInitialInviteOf(joinState, input) {
  const context = initialInviteContextOf(joinState, input);
  if (context.ok !== true) {
    return context;
  }
  const { collabId, target } = /** @type {any} */ (context);
  const books = booksOf(joinState, collabId);
  const ttl = Number.isInteger(input.ttl) && input.ttl > 0 ? input.ttl : books.invites.ttlMs;
  const opened = books.invites.book.openInvite({
    targetInstanceId: target.instanceId,
    targetSessionId: target.targetSessionId,
    ttl,
    now: joinState.now(),
  });
  if (opened.ok !== true) {
    return failureMessage('邀请记录生成失败（目标形态不符）', { reason: opened.reason });
  }
  const saved = books.invites.save();
  if (saved.ok === true) {
    return { ok: true, inviteId: opened.inviteId, expiresAt: opened.expiresAt };
  }
  books.invites.book.withdrawInvite(opened.inviteId);
  return failureMessage(`邀请簿记写入失败：${saved.reason}——邀请未发出（避免重启后无从校验）`, { reason: 'bookkeeping-write-failed' });
}

/* 建协首邀簿记的前置：协作在册、managed、签发者是本站长、目标形态合法。 */
function initialInviteContextOf(joinState, input) {
  const collabId = idOf(input.collabId);
  const managerSessionId = idOf(input.managerSessionId);
  const target = inviteTargetOf(input);
  if (collabId === null || managerSessionId === null || target === null) {
    return failureMessage('参数非法：需要 collabId、站长会话标识与邀请目标');
  }
  const local = joinState.state.collabs.get(collabId);
  if (local === undefined) {
    return failureMessage('本机没有该协作（collabId 不存在）');
  }
  if (localModeOf(local) === 'forum') {
    return failureMessage('讨论无邀请簿记：forum 不生成、不返回 inviteId（设计 D18）', { code: 'forum-no-invite' });
  }
  if (!isManagerSession(joinState, local, managerSessionId)) {
    return failureMessage('只有站长会话可以建立邀请记录');
  }
  return { ok: true, collabId, managerSessionId, target };
}

/* 未投递邀请的撤回（建协首邀的失败收口）：只关 open 记录，已关闭/已撤回按记录状态如实回报。
 * 调用方据返回值决定是否留痕，不得把「记录已不可撤」误当发送成功。 */
function withdrawInitialInviteOf(joinState, input) {
  const collabId = idOf(input.collabId);
  const inviteId = idOf(input.inviteId);
  if (collabId === null || inviteId === null) {
    return failureMessage('参数非法：需要 collabId 与 inviteId');
  }
  const books = booksOf(joinState, collabId);
  const withdrawn = books.invites.book.withdrawInvite(inviteId);
  if (withdrawn.ok !== true) {
    return failureMessage(`邀请撤回失败：${withdrawn.reason}`, { reason: withdrawn.reason });
  }
  const saved = books.invites.save();
  if (saved.ok !== true) {
    return failureMessage(`邀请簿记撤回写入失败：${saved.reason}`, { reason: 'bookkeeping-write-failed' });
  }
  return { ok: true, inviteId, withdrawn: true, idempotent: withdrawn.idempotent === true };
}

async function createInviteOf(joinState, input) {
  const prechecked = createInviteContextOf(joinState, input);
  if (prechecked.ok !== true) {
    return prechecked;
  }
  const { ids, local, target } = /** @type {any} */ (prechecked);
  const books = booksOf(joinState, ids.collabId);
  const opened = books.invites.book.openInvite({
    targetInstanceId: target.instanceId, targetSessionId: target.targetSessionId, ttl: books.invites.ttlMs, now: joinState.now(),
  });
  if (opened.ok !== true) {
    return failureMessage('邀请记录生成失败（目标形态不符）');
  }
  const saved = books.invites.save();
  if (saved.ok !== true) {
    books.invites.book.withdrawInvite(opened.inviteId);
    return failureMessage(`邀请簿记写入失败：${saved.reason}——邀请未发出（避免重启后无从校验）`);
  }
  const payload = invitePayloadV2Of(joinState, local, opened.inviteId, target, ids.managerSessionId);
  return sendOpenedInviteOf(joinState, { ids, target, opened, books, payload });
}

/* 邀请记录已落盘后的投递与失败收口：同机目标先登记挂起邀请再投（核内旁路不会经历接收侧的
 * 「收到邀请帧即登记」那一面）；任一失败都撤回邀请簿记，同机目标还要撤回挂起记录。 */
async function sendOpenedInviteOf(joinState, { ids, target, opened, books, payload }) {
  const localTarget = target.instanceId === joinState.state.self.instanceId;
  const localError = localTarget
    ? registerLocalPendingInviteOf(joinState, ids.collabId, opened, target, ids.managerSessionId)
    : null;
  if (localError !== null) {
    rollbackUnsentInviteOf(books, ids.collabId, opened.inviteId, false);
    return localError;
  }
  const sent = await sendSeatFrame(joinState, {
    collabId: ids.collabId, instanceId: target.instanceId, sessionId: target.targetSessionId,
    type: 'invite', payload, fromSessionId: ids.managerSessionId,
  });
  if (sent.ok !== true) {
    /* 目标未注册 / 离线不是发送面故障：挂起邀请与邀请记录必须保留，等目标会话注册后补投
     * （设计 §4.2/§4.3）。只有目标形态非法或本机投递面缺失才回滚——那类失败重试也不会好。 */
    if (localTarget && isOfflineInviteFailureOf(sent)) {
      return {
        ok: true, inviteId: opened.inviteId, expiresAt: opened.expiresAt, target, pending: true,
        delivery: sent,
        note: '目标会话尚未注册或已离线——邀请已挂起，目标会话注册后自动补投',
      };
    }
    rollbackUnsentInviteOf(books, ids.collabId, opened.inviteId, localTarget);
    return failureMessage(`邀请发送失败：${sent.reason}——未留下未投递的邀请记录`);
  }
  return { ok: true, inviteId: opened.inviteId, expiresAt: opened.expiresAt, target, delivery: sent };
}

/* 同机投递的「离线类」失败词表：目标会话没有席位/桥、桥在线但交付失败、本机无活跃会话。
 * 这些失败由挂起邀请补投兜底；形态类（bad-session / not-invite-target / unknown-collab）
 * 与注入面缺失（未接线）不属于离线，重试也不会送达。 */
const OFFLINE_INVITE_FAILURE_REASONS = new Set(['no-seat', 'seat-offline', '本机没有可投递的活跃会话']);

function isOfflineInviteFailureOf(sent) {
  return sent?.ok !== true && OFFLINE_INVITE_FAILURE_REASONS.has(sent?.reason);
}

function rollbackUnsentInviteOf(books, collabId, inviteId, pendingLocal) {
  if (pendingLocal) {
    books.pending.store.withdrawPending({ collabId, inviteId });
    books.pending.save();
  }
  books.invites.book.withdrawInvite(inviteId);
  books.invites.save();
}

function registerLocalPendingInviteOf(joinState, collabId, opened, target, managerSessionId) {
  const registered = /** @type {any} */ (registerPendingInviteOf(joinState, {
    collabId,
    inviteId: opened.inviteId,
    fromManager: { instanceId: joinState.state.self.instanceId, sessionId: managerSessionId },
    targetSessionId: target.targetSessionId,
    expiresAt: opened.expiresAt,
  }));
  if (registered.ok === true) {
    return null;
  }
  return failureMessage(`同机挂起邀请登记失败：${registered.message}——邀请未发出`);
}

function createInviteContextOf(joinState, input) {
  const ids = inviteIdsOf(input);
  if (ids === null) {
    return failureMessage('参数非法：需要 collabId 与站长会话标识');
  }
  const local = joinState.state.collabs.get(ids.collabId);
  if (local === undefined) {
    return failureMessage('本机没有该协作（collabId 不存在）——先看 ws_list_collabs');
  }
  const refusal = inviteContextRefusalOf(joinState, local, ids);
  if (refusal !== null) {
    return refusal;
  }
  const target = inviteTargetOf(input);
  if (target === null) {
    return failureMessage('邀请目标非法：需要 targetInstanceId 与可选的 targetSessionId');
  }
  const resolved = /** @type {any} */ (resolveLocalInviteTargetOf(joinState, ids.collabId, target));
  return resolved.ok === true ? { ok: true, ids, local, target: resolved.target } : resolved;
}

/* 邀请前置拒绝：讨论无簿记 / 已结束 / 非站长会话 / 元状态缺失 / 席位已满。null＝可邀请。 */
function inviteContextRefusalOf(joinState, local, ids) {
  if (localModeOf(local) === 'forum') {
    return failureMessage('讨论无邀请簿记：forum 不生成、不返回 inviteId（设计 D18）', { code: 'forum-no-invite' });
  }
  if (isLocalArchivedState(local)) {
    return failureMessage('该协作已结束（或本机已退出）——不再发起邀请');
  }
  if (!isManagerSession(joinState, local, ids.managerSessionId)) {
    return failureMessage('只有站长会话可以邀请成员');
  }
  if (!isIdentityName(localNameOf(local)) || !isPresentationText(localTopicOf(local), MAX_TOPIC_CHARS)) {
    return failureMessage('本地记录缺协作名或主题（协议面无法组出合法邀请）——待元状态补齐后重试');
  }
  return activeSeatsCount(joinState, local, null) >= MAX_ACTIVE_SEATS
    ? failureMessage(`协作活跃席位已达上限（${MAX_ACTIVE_SEATS}）——不再发起新邀请`)
    : null;
}

async function acceptInviteOf(joinState, input) {
  const ids = acceptInviteIdsOf(input);
  if (ids.ok !== true) {
    return ids;
  }
  const { collabId, inviteId, sessionId } = /** @type {any} */ (ids);
  const local = joinState.state.collabs.get(collabId);
  if (local !== undefined && localModeOf(local) === 'forum') {
    return failureMessage('讨论无邀请簿记：forum 的同意走成员事件，不使用 inviteId（设计 D18）', { code: 'forum-no-invite' });
  }
  const books = booksOf(joinState, collabId);
  const visible = books.pending.store.matchPendingForSession({ collabId, sessionId, inviteId, now: joinState.now() });
  if (visible.length === 0) {
    return alreadyAcceptedInviteOf(joinState, books, { collabId, inviteId, sessionId });
  }
  const manager = visible[0].fromManager;
  const result = manager.instanceId === joinState.state.self.instanceId && isManagerSession(joinState, local, manager.sessionId)
    ? await acceptLocalInviteOf(joinState, { collabId, inviteId, sessionId, manager, books })
    : await acceptRemoteInviteOf(joinState, { collabId, inviteId, sessionId, manager, books });
  if (result.ok === true) {
    markMemberAcceptedOf(joinState, collabId);
  }
  return result;
}

/* 本机成员记录的同意落点（0.2.0 邀请接受）：决定状态归整机兼容记录；席位态与快照收敛
 * 各自由席位文件与快照采纳面维护。 */
function markMemberAcceptedOf(joinState, collabId) {
  const local = joinState.state.collabs.get(collabId);
  if (local?.member === null || typeof local?.member !== 'object' || local.member.decision === 'approved') {
    return;
  }
  local.member.decision = 'approved';
  persistMember(joinState.state, local);
}

/* 同会话重复接受：记录已被接受后 matchPending 不再冒泡，这里补回判据。
 * 已真正成席（席位 member 且 unverified 已清）＝幂等成功；尚未成席（approve/grant 丢帧）时
 * 必须重发 approve——只回「已接受」会让用户在没有席位的情况下无从恢复（C-3）。 */
async function alreadyAcceptedInviteOf(joinState, books, { collabId, inviteId, sessionId }) {
  const record = books.pending.store.get({ collabId, inviteId });
  if (record === null || !record.acceptedSessions.includes(sessionId)) {
    return failureMessage('邀请不存在、已过期或不属于本会话');
  }
  const local = joinState.state.collabs.get(collabId);
  const seat = local === undefined ? null : localSeatOfLocal(local, sessionId);
  return seatIsVerifiedMemberOf(seat)
    ? { ok: true, accepted: true, idempotent: true, inviteId }
    : resendAcceptOf(joinState, record, { collabId, inviteId, sessionId });
}

function seatIsVerifiedMemberOf(seat) {
  return seat !== null && seat.state === 'member' && seat.unverified !== true && !isSeatArchived(seat);
}

/* 未成席的重复接受：重发 approve，让站长重签 grant（或对已提交的 confirm 回快照）。 */
async function resendAcceptOf(joinState, record, { collabId, inviteId, sessionId }) {
  if (joinState.now() >= record.expiresAt) {
    return failureMessage('邀请已过期——需要新的邀请才能再次接受', { reason: 'expired', inviteId });
  }
  const manager = record.fromManager;
  if (idOf(manager.sessionId) === null) {
    return failureMessage('挂起邀请缺少邀请者会话标识——approve 无法重发（请重新邀请）', { reason: 'unknown-manager', inviteId });
  }
  const sent = await sendSeatFrame(joinState, {
    collabId, instanceId: manager.instanceId, sessionId: manager.sessionId, type: 'approve',
    payload: { inviteId }, fromSessionId: sessionId,
  });
  if (sent.ok !== true) {
    return failureMessage(`邀请接受帧重发失败：${sent.reason}——邀请记录仍在，可重试`, { reason: 'send-failed', inviteId });
  }
  return { ok: true, accepted: true, pending: true, idempotent: true, inviteId, resent: true, delivery: sent };
}

/* 拒绝席位邀请（0.2.0 邀请簿记）：本地拒绝先生效（挂起邀请消费 ＋ 本会话记入拒绝），再向邀请者
 * 补发 decline 帧作簿记——与讨论拒绝同一口径：簿记帧失败只如实标注，不改本地结论。重复拒绝按
 * 幂等返回且不重复投递——站长侧的 decline 计数只应记真实决定。 */
async function declineInviteOf(joinState, input) {
  const context = /** @type {any} */ (declineContextOf(joinState, input));
  if (context.ok !== true) {
    return context;
  }
  const { collabId, inviteId, sessionId } = context;
  const booked = /** @type {any} */ (declinePendingOf(joinState, { collabId, inviteId, sessionId }));
  if (booked.ok !== true) {
    return booked;
  }
  if (booked.declined.idempotent === true) {
    return { ok: true, declined: true, idempotent: true, consumed: booked.declined.consumed === true, inviteId };
  }
  return sendDeclineFrameOf(joinState, { ...context, booked });
}

/* 拒绝的前置面：参数形态、forum 无邀请簿记、原因按协议呈现判据校验（先校验，后落地拒绝）。 */
function declineContextOf(joinState, input) {
  const ids = /** @type {any} */ (acceptInviteIdsOf(input));
  if (ids.ok !== true) {
    return ids;
  }
  const local = joinState.state.collabs.get(ids.collabId);
  if (local !== undefined && localModeOf(local) === 'forum') {
    return failureMessage('讨论无邀请簿记：forum 的拒绝走成员事件，不使用 inviteId（设计 D18）', { code: 'forum-no-invite' });
  }
  const reason = validateReason(input.reason);
  return reason.ok === true ? { ...ids, reason: reason.reason } : failureMessage(reason.message);
}

/* 本地拒绝（先落账再发帧）：matchPending 取的是可见记录（用于取邀请者），declineForSession
 * 负责匹配目标会话与幂等 / 反向决定的判定。 */
function declinePendingOf(joinState, { collabId, inviteId, sessionId }) {
  const books = booksOf(joinState, collabId);
  const at = joinState.now();
  const visible = books.pending.store.matchPendingForSession({ collabId, sessionId, inviteId, now: at });
  const declined = books.pending.store.declineForSession({ collabId, inviteId, sessionId, now: at });
  if (declined.ok !== true) {
    return failureMessage(`邀请已不可拒绝：${declined.reason}`, { reason: declined.reason });
  }
  books.pending.save();
  return { ok: true, visible, declined };
}

/* decline 帧是簿记面：投递结果如实回传，失败不撤销已成立的本地拒绝。 */
async function sendDeclineFrameOf(joinState, { collabId, inviteId, sessionId, reason, booked }) {
  const base = {
    ok: true, declined: true, idempotent: false, consumed: booked.declined.consumed === true, inviteId,
  };
  const manager = booked.visible[0]?.fromManager;
  if (manager === undefined) {
    return { ...base, delivery: { ok: false, reason: '挂起记录缺少邀请者信息——decline 帧未发出' } };
  }
  /* 同机邀请者不投帧（投给会话面不会进入核内处理）：直接交发起侧拒绝处理，关闭邀请记录。 */
  if (manager.instanceId === joinState.state.self.instanceId) {
    return localDeclineDeliveryOf(joinState, { base, collabId, inviteId, sessionId, reason, manager });
  }
  /* inviteId 随拒绝帧回传：发起侧据此关闭对应邀请记录（拒绝不只是计数）。 */
  const sent = await sendSeatFrame(joinState, {
    collabId, instanceId: manager.instanceId, sessionId: manager.sessionId, type: 'decline',
    payload: { inviteId, ...(reason === undefined ? {} : { reason }) }, fromSessionId: sessionId,
  });
  return sent.ok === true
    ? { ...base, delivery: sent }
    : { ...base, delivery: sent, note: `拒绝已本地生效；decline 帧未送达：${sent.reason}` };
}

/* 同机拒绝的簿记收口（N-2）：先直接调用发起侧拒绝处理（等价于核内收到 decline 帧），
 * 不依赖「帧注入未入席会话」这条不存在的地面；随后照旧把帧交给本机邀请者会话
 * （展示与拒绝计数面——同机旁路的既有投递语义不变）。 */
async function localDeclineDeliveryOf(joinState, { base, collabId, inviteId, sessionId, reason, manager }) {
  const handled = handleInviteDeclineOf(joinState, {
    collabId,
    from: { instanceId: joinState.state.self.instanceId, sessionId },
    payload: { inviteId, ...(reason === undefined ? {} : { reason }) },
  });
  const sent = await sendSeatFrame(joinState, {
    collabId, instanceId: manager.instanceId, sessionId: manager.sessionId, type: 'decline',
    payload: { inviteId, ...(reason === undefined ? {} : { reason }) }, fromSessionId: sessionId,
  });
  const recordClosed = handled?.ok === true;
  /* 同机拒绝在核内直接完成：发起侧的「收到拒绝」计数在此记真（远端路径由事件面记账）。
   * 之后把帧交给本机邀请者会话时，重复处理按幂等返回、不再重复计数。 */
  if (recordClosed && handled.idempotent !== true) {
    joinState.state.counters.declinesIn = (joinState.state.counters.declinesIn ?? 0) + 1;
  }
  const delivery = { ...sent, local: true, recordClosed };
  if (recordClosed) {
    return { ...base, delivery };
  }
  return {
    ...base,
    delivery: { ...delivery, recordReason: handled?.reason ?? '本机发起侧记录不可关闭（非站长会话或讨论实例）' },
    note: '拒绝已本地生效；同机发起侧记录未能关闭',
  };
}

function acceptInviteIdsOf(input) {
  const collabId = idOf(input.collabId);
  const inviteId = idOf(input.inviteId);
  const sessionId = idOf(input.sessionId);
  return collabId === null || inviteId === null || sessionId === null
    ? failureMessage('参数非法：需要 collabId、inviteId 与会话标识')
    : { ok: true, collabId, inviteId, sessionId };
}

async function acceptRemoteInviteOf(joinState, { collabId, inviteId, sessionId, manager, books }) {
  rememberInviteAcceptanceOf(joinState, { collabId, sessionId, managerInstanceId: manager.instanceId });
  const sent = await sendSeatFrame(joinState, {
    collabId, instanceId: manager.instanceId, sessionId: manager.sessionId, type: 'approve', payload: { inviteId }, fromSessionId: sessionId,
  });
  if (sent.ok !== true) {
    forgetInviteAcceptanceOf(joinState, collabId, sessionId);
    return failureMessage(`邀请接受帧发送失败：${sent.reason}——邀请记录保留，可重试`);
  }
  const consumed = books.pending.store.consumeForSession({ collabId, inviteId, sessionId, declined: false, now: joinState.now() });
  if (consumed.ok !== true) {
    return failureMessage(`邀请已不可接受：${consumed.reason}`, { reason: consumed.reason });
  }
  books.pending.save();
  return { ok: true, accepted: true, inviteId, pending: true, delivery: sent };
}

/* 受邀会话没有 join-request 申请记录；先把「本机确实在等这家站长的 grant」落进申请台账，
 * 供 join-grant 的比对面命中（回执不是凭空可造的）。 */
function rememberInviteAcceptanceOf(joinState, { collabId, sessionId, managerInstanceId }) {
  joinState.state.joinApplications.add({
    collabId,
    sessionId,
    managerInstanceId,
    msgId: `invite-accept-${randomUUID()}`,
    sentAt: joinState.now(),
  });
}

function forgetInviteAcceptanceOf(joinState, collabId, sessionId) {
  for (const record of joinState.state.joinApplications.list()) {
    if (record.collabId === collabId && record.sessionId === sessionId) {
      joinState.state.joinApplications.remove(record.msgId);
    }
  }
}

/* 同机接受：两段式成功后才消费挂起邀请——先消费再批准会让 grant 发送/名单提交的瞬态失败
 * 把邀请一次烧掉（重试只剩「已接受（幂等）」）。失败保留 pending 供重试（C-3）。 */
async function acceptLocalInviteOf(joinState, { collabId, inviteId, sessionId, manager, books }) {
  rememberInviteAcceptanceOf(joinState, { collabId, sessionId, managerInstanceId: joinState.state.self.instanceId });
  const approved = await approveInviteForSeat(joinState, {
    collabId, inviteId, instanceId: joinState.state.self.instanceId, sessionId, managerSessionId: manager.sessionId,
    identityName: joinState.state.self.identityName,
  });
  if (approved.ok !== true) {
    forgetInviteAcceptanceOf(joinState, collabId, sessionId);
    return approved;
  }
  const consumed = books.pending.store.consumeForSession({ collabId, inviteId, sessionId, declined: false, now: joinState.now() });
  if (consumed.ok !== true) {
    /* 席位已成立才是权威事实；挂起记录若已被上次尝试消费（或已过期），只如实标注、不撤销入席。 */
    joinState.log.warn('邀请已入席但挂起记录消费失败（按已接受处置）', { collabId, inviteId, reason: consumed.reason });
    return { ...approved, accepted: true, inviteId, note: `席位已成立；挂起邀请状态未更新：${consumed.reason}` };
  }
  books.pending.save();
  return { ...approved, accepted: true, inviteId };
}

async function approveInviteForSeat(joinState, input) {
  const local = joinState.state.collabs.get(input.collabId);
  /* 终态协作不再受理邀请批准（入站门可能放行 approve，写面自行 fail-closed）。 */
  if (local !== undefined && isLocalArchivedState(local)) {
    return failureMessage('该协作已结束（或本机已退出）——不再处置邀请');
  }
  if (!isManagerSession(joinState, local, input.managerSessionId)) {
    return failureMessage('只有站长会话可以批准邀请');
  }
  const books = booksOf(joinState, input.collabId);
  const matched = books.invites.book.matchInvite(input.inviteId, {
    instanceId: input.instanceId, sessionId: input.sessionId, now: joinState.now(),
  });
  if (matched.ok !== true) {
    return failureMessage(`邀请不可用：${matched.reason}`, { reason: matched.reason });
  }
  if (isRosterMember(local, input.instanceId, input.sessionId)) {
    return { ok: true, member: true, alreadyMember: true, inviteId: input.inviteId };
  }
  const existing = books.joining.registry.find(input.collabId, input.sessionId);
  if (existing !== null) {
    return existing.instanceId === input.instanceId
      ? grantSeatOf(joinState, local, books, existing, input.managerSessionId, input.inviteId)
      : failureMessage('同一会话已有其他实例的在途 grant——拒绝覆盖（instance-mismatch）', { reason: 'instance-mismatch' });
  }
  const begun = await beginSeatJoiningOf(joinState, local, books, {
    collabId: input.collabId, instanceId: input.instanceId, sessionId: input.sessionId,
    managerSessionId: input.managerSessionId, inviteId: input.inviteId, identityName: input.identityName,
  });
  if (begun.ok !== true) {
    return begun;
  }
  return grantSeatOf(joinState, local, books, /** @type {any} */ (begun).record, input.managerSessionId, input.inviteId);
}

async function beginSeatJoiningOf(joinState, local, books, input) {
  const seat = { instanceId: input.instanceId, sessionId: input.sessionId };
  const begun = books.joining.registry.beginJoining({
    collabId: input.collabId,
    instanceId: input.instanceId,
    sessionId: input.sessionId,
    managerTerm: managerTermOf(local),
    grantVersion: grantVersionOf(local),
    activeSeats: activeSeatsCount(joinState, local, seat),
    now: joinState.now(),
  });
  if (begun.ok !== true) {
    return beginJoiningFailureOf(joinState, local, input, begun);
  }
  joinState.seatNames.set(begun.joinId, input.identityName ?? joinState.state.self.identityName);
  if (input.inviteId !== undefined) {
    joinState.joinInvites.set(begun.joinId, { inviteId: input.inviteId, instanceId: input.instanceId, sessionId: input.sessionId });
  }
  const saved = books.joining.save();
  if (saved.ok !== true) {
    books.joining.registry.abortJoining(begun.joinId, 'aborted');
    return failureMessage(`在途入席台账写入失败：${saved.reason}——未签发 join-grant`, { reason: 'persist-failed' });
  }
  return { ok: true, joinId: begun.joinId, record: books.joining.registry.get(begun.joinId) };
}

/* 批准失败：容量满回 join-deny(capacity)；形态/实例冲突如实回报，不覆盖他人 grant。 */
async function beginJoiningFailureOf(joinState, local, input, begun) {
  if (begun.reason === 'capacity') {
    await sendJoinDenyOf(joinState, local, input, denialJoinIdOf(), 'capacity');
    forgetPendingRequestOf(joinState, input.collabId, input);
    return failureMessage(`活跃席位已满（${MAX_ACTIVE_SEATS}）——已回 join-deny(capacity)`, { reason: 'capacity' });
  }
  if (begun.reason === 'instance-mismatch') {
    return failureMessage('同一会话已有其他实例的在途 grant——拒绝覆盖（instance-mismatch）', { reason: begun.reason });
  }
  return failureMessage('在途入席记录写入失败（参数非法）', { reason: begun.reason });
}

async function grantSeatOf(joinState, local, books, record, managerSessionId, inviteId) {
  if (record === null) {
    return failureMessage('在途入席记录不存在', { reason: 'unknown' });
  }
  const manager = {
    instanceId: joinState.state.self.instanceId,
    sessionId: managerSessionId ?? managerSessionOf(joinState, local) ?? record.sessionId,
    identityName: joinState.state.self.identityName,
  };
  const payload = {
    joinId: record.joinId,
    manager,
    managerTerm: record.managerTerm,
    version: record.grantVersion,
    sessionId: record.sessionId,
  };
  const sent = await sendSeatFrame(joinState, {
    collabId: record.collabId,
    instanceId: record.instanceId,
    sessionId: record.sessionId,
    type: 'join-grant',
    payload,
    fromSessionId: manager.sessionId,
  });
  if (sent.ok !== true) {
    books.joining.registry.abortJoining(record.joinId, 'aborted');
    books.joining.save();
    return failureMessage(`join-grant 发送失败：${sent.reason}——在途 grant 已作废`, { reason: 'send-failed' });
  }
  /* 同机旁路的发送返回时，grant → confirm → 名单提交整链已同步跑完：结果如实报「已入席」，
   * 调用方不必再自行 confirm（记录已按设计在确认后出表）。远端仍是「已签发、待确认」。 */
  return isRosterMember(local, record.instanceId, record.sessionId)
    ? { ok: true, member: true, alreadyMember: true, joinId: record.joinId, inviteId: inviteId ?? null, delivery: sent }
    : { ok: true, joining: true, joinId: record.joinId, inviteId: inviteId ?? null, delivery: sent };
}

function denialJoinIdOf() {
  return `join-deny-${randomUUID()}`;
}

async function sendJoinDenyOf(joinState, local, seat, joinId, reason, managerTerm = undefined) {
  const managerSessionId = managerSessionOf(joinState, local);
  if (managerSessionId === null) {
    return { ok: false, reason: '站长席位未知' };
  }
  const payload = { joinId, reason: joinDenyReasonOf(reason) };
  if (idOf(seat.sessionId) !== null) {
    payload.sessionId = seat.sessionId;
  }
  if (Number.isInteger(managerTerm)) {
    payload.managerTerm = managerTerm;
  }
  return sendSeatFrame(joinState, {
    collabId: local.collabId,
    instanceId: seat.instanceId,
    sessionId: seat.sessionId,
    type: 'join-deny',
    payload,
    fromSessionId: managerSessionId,
  });
}

async function approveJoinOf(joinState, input) {
  const context = approveJoinContextOf(joinState, input);
  if (context.ok !== true) {
    return context;
  }
  const { local, managerSessionId, wanted } = /** @type {any} */ (context);
  const found = findPendingRequestOf(joinState, local.collabId, wanted);
  if (found.ambiguous) {
    return failureMessage('申请人会话标识存在歧义——请给完整会话标识');
  }
  if (found.record === null) {
    return isRosterMember(local, joinState.state.self.instanceId, wanted)
      ? { ok: true, member: true, alreadyMember: true, sessionId: wanted }
      : failureMessage('该会话没有待批准的加入申请（可能已过期、已处置，或会话标识不符）');
  }
  return input.approve === false
    ? rejectPendingRequestOf(joinState, local, found.record, input.reason)
    : grantPendingRequestOf(joinState, local, found.record, managerSessionId, input.inviteId);
}

function approveJoinContextOf(joinState, input) {
  const collabId = idOf(input.collabId);
  const managerSessionId = idOf(input.managerSessionId);
  const wanted = idOf(input.sessionId);
  if (collabId === null || managerSessionId === null || wanted === null) {
    return failureMessage('参数非法：需要 collabId、站长会话标识与申请人会话标识');
  }
  const local = joinState.state.collabs.get(collabId);
  if (local === undefined) {
    return failureMessage('本机没有该协作（collabId 不存在）——先看 ws_list_collabs');
  }
  if (localModeOf(local) === 'forum') {
    return failureMessage('讨论无批准门：请用 ws_approve_invite（forum 不产生 inviteId）', { code: 'forum-no-invite' });
  }
  if (isLocalArchivedState(local)) {
    return failureMessage('该协作已结束（或本机已退出）——不再处置加入申请');
  }
  if (!isManagerSession(joinState, local, managerSessionId)) {
    return failureMessage('本机不是该协作的站长会话（无批准权）——批准权不随数据副本走');
  }
  return { ok: true, local, managerSessionId, wanted };
}

async function grantPendingRequestOf(joinState, local, request, managerSessionId, rawInviteId) {
  const inviteId = rawInviteId === undefined || rawInviteId === null ? null : idOf(rawInviteId);
  if (rawInviteId !== undefined && rawInviteId !== null && inviteId === null) {
    return failureMessage('inviteId 形态非法');
  }
  const result = inviteId === null
    ? await beginAndGrantPendingOf(joinState, local, request, managerSessionId)
    : await approveInviteForSeat(joinState, { ...request, collabId: local.collabId, inviteId, managerSessionId });
  if (result.ok === true) {
    forgetPendingRequestOf(joinState, local.collabId, request);
  }
  return result;
}

/* 批准申请：申请人可能从未收到过邀请（按名解析 → join-request 的冷启动路径），其本机还没有
 * 该协作的参与记录——grant 到达时会因无从核对而失败。因此先复用受邀入席（补一条指名邀请，
 * 由对方的事件面建立本地记录），再签发 grant；已在名单的申请人跳过这一步。 */
async function beginAndGrantPendingOf(joinState, local, request, managerSessionId) {
  const books = booksOf(joinState, local.collabId);
  if (isRosterMember(local, request.instanceId, request.sessionId)) {
    return { ok: true, member: true, alreadyMember: true, sessionId: request.sessionId };
  }
  const existing = books.joining.registry.find(local.collabId, request.sessionId);
  if (existing !== null) {
    return existing.instanceId === request.instanceId
      ? grantSeatOf(joinState, local, books, existing, managerSessionId, null)
      : failureMessage('同一会话已有其他实例的在途 grant——拒绝覆盖（instance-mismatch）', { reason: 'instance-mismatch' });
  }
  /* 容量先判：满员即回 deny，不再给注定失败的申请人补发邀请（邀请会先于 deny 到达）。 */
  const capacityRefusal = await capacityRefusalOf(joinState, local, request);
  if (capacityRefusal !== null) {
    return capacityRefusal;
  }
  /* 本机会话自批：本机已有该协作记录，grant 走核内旁路即可，不需要（也无从）再向自己发邀请。 */
  const seated = request.instanceId === joinState.state.self.instanceId
    ? { ok: true, seated: true }
    : await ensureApplicantInvitedOf(joinState, local, request);
  if (seated.ok !== true) {
    return seated;
  }
  const begun = await beginSeatJoiningOf(joinState, local, books, {
    collabId: local.collabId, instanceId: request.instanceId, sessionId: request.sessionId,
    managerSessionId, inviteId: undefined, identityName: request.identityName,
  });
  if (begun.ok !== true) {
    return begun;
  }
  return grantSeatOf(joinState, local, books, /** @type {any} */ (begun).record, managerSessionId, null);
}

/* 冷启动申请人的先期邀请（设计 §4.4 第 1 步）：按名解析 → join-request 的申请人本机还没有
 * 该协作的参与记录，grant 到达时无从核对。先补一条**指名邀请**（载荷带申请人自己的席位条目），
 * 由对方的事件面建立本地记录；共享名单是 active-only，批准前不得写入 invited 行
 * （名单形态只接受 state:'member'，写入即让台账在重启读回时判损坏）。 */
async function ensureApplicantInvitedOf(joinState, local, request) {
  const target = decisionTargetOf(joinState, local.collabId, request.instanceId);
  if (target === null) {
    return { ok: false, message: `申请人端点未知（${request.instanceId}）——先 ws_list_hosts 确认对方在线，或让申请人重新申请（入站帧会带来端点）` };
  }
  const extra = { instanceId: request.instanceId, sessionId: request.sessionId, identityName: applicantNameOf(request) };
  const payload = {
    ...invitePayloadOf(local.ledger, [extra]),
    targetSessionId: request.sessionId,
    targets: [{ instanceId: request.instanceId, targetSessionId: request.sessionId }],
  };
  const sent = await sendFrameOf(joinState, {
    collabId: local.collabId, target, type: 'invite', payload,
    fromSessionId: senderSessionOf(joinState, local.collabId) ?? undefined,
  });
  if (sent.ok !== true) {
    return { ok: false, message: `入席邀请发送失败：${sent.reason}——未落处置，可稍后重试` };
  }
  joinState.state.counters.invitesSent++;
  return { ok: true, seated: false };
}

/* 批准前的容量判定（口径与 beginJoining 一致：共享名单活跃席位，不含本席）。 */
async function capacityRefusalOf(joinState, local, request) {
  const seat = { instanceId: request.instanceId, sessionId: request.sessionId };
  if (activeSeatsCount(joinState, local, seat) < MAX_ACTIVE_SEATS) {
    return null;
  }
  await sendJoinDenyOf(joinState, local, request, denialJoinIdOf(), 'capacity');
  forgetPendingRequestOf(joinState, local.collabId, request);
  return failureMessage(`活跃席位已满（${MAX_ACTIVE_SEATS}）——已回 join-deny(capacity)`, { reason: 'capacity' });
}

async function rejectPendingRequestOf(joinState, local, request, reason) {
  const validated = validateReason(reason);
  if (validated.ok !== true) {
    return failureMessage(validated.message);
  }
  const sent = await sendJoinDenyOf(joinState, local, request, denialJoinIdOf(), 'aborted', managerTermOf(local));
  if (sent.ok !== true) {
    return failureMessage(`拒绝回执发送失败：${sent.reason}——未落处置，可稍后重试`);
  }
  forgetPendingRequestOf(joinState, local.collabId, request);
  return { ok: true, denied: true, sessionId: request.sessionId, reason: validated.reason ?? null };
}

/* 批准对象匹配：完整标识全等 / 8 位短码全等（matchSessionByToken 的同一口径，不做前缀展开）；
 * 短码多命中由本层报歧义，不回落任意一条。 */
function findPendingRequestOf(joinState, collabId, wanted) {
  const candidates = pendingRequestsOf(joinState, collabId);
  const exact = candidates.filter((record) => record.sessionId === wanted);
  if (exact.length > 0) {
    return exact.length === 1 ? { record: exact[0], ambiguous: false } : { record: null, ambiguous: true };
  }
  const matched = matchSessionByToken(candidates.map((record) => ({ sessionId: record.sessionId })), wanted);
  if (matched !== null) {
    return { record: candidates.find((record) => record.sessionId === matched) ?? null, ambiguous: false };
  }
  const ambiguous = isSessionShortCode(wanted)
    && candidates.filter((record) => shortSessionId(record.sessionId) === wanted).length > 1;
  return { record: null, ambiguous };
}

/* 待批准面：内存请求（0.2.0 写点）∪ 旧台账未过期条目（读侧兼容）；按 (instanceId,sessionId) 去重。
 * 过期的内存申请一并剪除：申请人侧的申请台账到时限即失效，对过期申请签发的 grant 只会得到
 * 空授权（对方拒收 confirm）。 */
function pendingRequestsOf(joinState, collabId) {
  const merged = new Map();
  const held = joinState.pendingRequests.get(collabId) ?? new Map();
  for (const [key, record] of held) {
    if (joinState.now() - record.requestedAt >= ttlOf(joinState)) {
      held.delete(key);
      continue;
    }
    merged.set(key, { ...record });
  }
  const store = legacyJoinsStoreOf(joinState, collabId);
  if (store !== null) {
    for (const record of store.pendingJoins()) {
      /* v2 的 pendingJoins 是已在途 joining，不是待批准申请；不得再次出现在批准面。 */
      if (typeof record.joinId === 'string' || joinState.now() - record.requestedAt >= ttlOf(joinState)) {
        continue;
      }
      const key = `${record.instanceId}\u0000${record.sessionId}`;
      if (!merged.has(key)) {
        merged.set(key, { ...record });
      }
    }
  }
  return [...merged.values()];
}

function rememberPendingRequestOf(joinState, collabId, record) {
  const held = joinState.pendingRequests.get(collabId) ?? new Map();
  held.set(`${record.instanceId}\u0000${record.sessionId}`, { ...record });
  joinState.pendingRequests.set(collabId, held);
}

function forgetPendingRequestOf(joinState, collabId, record) {
  joinState.pendingRequests.get(collabId)?.delete(`${record.instanceId}\u0000${record.sessionId}`);
}

function legacyJoinsStoreOf(joinState, collabId) {
  try {
    return storeOf(joinState, collabId);
  } catch {
    return null;
  }
}

/* —— 申请人 / 受邀会话的接线（发起、grant、confirm、deny） —— */

function requestJoinOf(joinState, input) {
  const collabId = idOf(input.collabId);
  const sessionId = idOf(input.sessionId);
  if (collabId === null || sessionId === null) {
    return failureMessage('参数非法：需要 collabId 与会话标识');
  }
  const local = joinState.state.collabs.get(collabId);
  if (local === undefined) {
    return failureMessage('本机没有该协作（collabId 不存在）——先看 ws_list_collabs，或用 name + target 按名解析');
  }
  if (isLocalArchivedState(local)) {
    return failureMessage('该协作已结束（或本机已退出）——不再纳新，不能加入');
  }
  if (localModeOf(local) === 'forum') {
    return requestForum(joinState, local, sessionId);
  }
  return requestManaged(joinState, sessionId, { collabId, manager: managerSeatOf(joinState, local) });
}

function confirmJoiningOf(joinState, joinId, sessionId, input) {
  const found = typeof joinId === 'string' ? booksForJoinId(joinState, joinId) : null;
  if (found === null) {
    return failureMessage('未知 joinId（已过期或已作废）', { reason: 'unknown' });
  }
  const prepared = confirmPreparedOf(joinState, found, sessionId, input);
  if (prepared.ok !== true) {
    return prepared;
  }
  const refusal = confirmStateRefusalOf(found, /** @type {any} */ (prepared), joinId);
  if (refusal !== null) {
    return refusal;
  }
  const confirmed = found.books.joining.registry.confirmJoining(joinId, sessionId, /** @type {any} */ (prepared).confirmInput);
  if (confirmed.ok !== true) {
    return confirmFailureOf(found, confirmed);
  }
  return finishConfirmOf(joinState, found, sessionId, prepared, joinId);
}

/* confirm 前的当前态校验（不依赖入站门）：协作归档/终态一律拒绝；未入名单的旧 grant 必须仍属
 * 本机当前任期——站长更替后旧 grant 不得在任期内落地（已入名单的席位保留，见设计 §4.4.8）。
 * fail-closed：两种拒绝都作废在途记录并落盘，避免幽灵 grant 滞留到下次清扫。 */
function confirmStateRefusalOf(found, prepared, joinId) {
  if (prepared.local === undefined || isLocalArchivedState(prepared.local)) {
    return refuseStaleJoinOf(found, joinId, 'aborted', '协作已结束（或本机已退出）——在途 grant 已作废');
  }
  if (prepared.alreadyMember !== true && found.record.managerTerm !== managerTermOf(prepared.local)) {
    return refuseStaleJoinOf(found, joinId, 'manager-changed', '站长任期已变更（managerTerm 不符）——旧 grant 已作废');
  }
  return null;
}

function refuseStaleJoinOf(found, joinId, reason, message) {
  found.books.joining.registry.abortJoining(joinId, reason);
  found.books.joining.save();
  return failureMessage(message, { reason });
}

function confirmPreparedOf(joinState, found, sessionId, input) {
  const local = joinState.state.collabs.get(found.collabId);
  const instanceId = idOf(input.instanceId);
  if (instanceId === null || idOf(sessionId) === null) {
    return failureMessage('参数非法：需要 instanceId 与会话标识', { reason: 'invalid' });
  }
  const alreadyMember = input.alreadyMember === true || isRosterMember(local, instanceId, sessionId);
  const activeSeats = alreadyMember ? undefined : activeSeatsCount(joinState, local, { instanceId, sessionId });
  return {
    ok: true,
    local,
    alreadyMember,
    confirmInput: {
      instanceId,
      managerTerm: input.managerTerm,
      ...(activeSeats === undefined ? {} : { activeSeats }),
      alreadyMember,
      ...(Number.isFinite(input.now) ? { now: input.now } : {}),
    },
  };
}

function finishConfirmOf(joinState, found, sessionId, prepared, joinId) {
  const preparedData = /** @type {any} */ (prepared);
  if (preparedData.alreadyMember) {
    found.books.joining.registry.releaseJoining(found.collabId, sessionId);
    found.books.joining.save();
    return { ok: true, member: true, alreadyMember: true, joinId };
  }
  /* 写点：confirm 成功与名单提交之间禁止写 joins.json——盘上保留 begin 时的未确认记录，
   * 崩溃后由 alreadyMember 重放收敛。 */
  const committed = commitSeatToRosterOf(joinState, preparedData.local, found.record, joinId);
  if (committed.ok !== true) {
    found.books.joining.registry.unconfirmJoining(joinId);
    found.books.joining.save();
    return committed.reason === 'archived'
      ? failureMessage('协作已结束——在途入席已作废', { reason: 'aborted' })
      : failureMessage('共享名单写入失败——在途 grant 已回滚为未确认，可重试', { reason: 'roster-write-failed' });
  }
  found.books.joining.registry.releaseJoining(found.collabId, sessionId);
  found.books.joining.save();
  markInviteAcceptedOf(joinState, found.books, joinId, found.record);
  markLocalSeatMemberOf(joinState, preparedData.local, found.record, committed.joinSeq);
  return { ok: true, member: true, joinId, joinSeq: committed.joinSeq, version: preparedData.local?.ledger?.version ?? null };
}

function confirmFailureOf(found, confirmed) {
  if (confirmed.reason === 'expired') {
    found.books.joining.save();
  }
  const messages = {
    expired: '在途入席已过期（joinId 已作废）',
    'manager-changed': '站长任期已变更（managerTerm 不符）',
    capacity: `活跃席位已满（${MAX_ACTIVE_SEATS}）`,
    'instance-mismatch': 'instanceId 与在途记录不符',
    'session-mismatch': '会话标识与在途记录不符',
    invalid: '确认参数非法（managerTerm / activeSeats 缺失或形态不符）',
  };
  return failureMessage(messages[confirmed.reason] ?? '在途入席确认失败', { reason: confirmed.reason });
}

function commitSeatToRosterOf(joinState, local, record, joinId) {
  if (local === undefined) {
    return { ok: false, reason: 'unknown-collab' };
  }
  if (localModeOf(local) === 'forum') {
    return { ok: false, reason: 'forum-no-roster' };
  }
  /* 终态台账不得再收席位（终态空名单/manager:null 是契约不变量）：入口已在归档时拒绝，
   * 这里是写面的最后一道 fail-closed——迟到 confirm 不得把成员写进已结束的协作。 */
  if (local.ledger?.status === 'completed' || local.ledger?.status === 'terminated') {
    return { ok: false, reason: 'archived' };
  }
  const identityName = joinState.seatNames.get(joinId) ?? nameForSeat(joinState, record);
  let joinSeq = null;
  const ledger = mutateLedger(joinState.state, local, (next) => {
    seedLedgerForSeat(next);
    joinSeq = upsertRosterRowOf(next, record, identityName, joinState.now());
    if (next.status === 'proposed') {
      next.status = 'active';
    }
  });
  return ledger === null ? { ok: false, reason: 'roster-write-failed' } : { ok: true, joinSeq };
}

function seedLedgerForSeat(ledger) {
  if (!Number.isInteger(ledger.managerTerm) || ledger.managerTerm < 1) {
    ledger.managerTerm = 1;
  }
  if (!Number.isInteger(ledger.joinSeqNext) || ledger.joinSeqNext < 2) {
    ledger.joinSeqNext = 2;
  }
  if (ledger.manager !== undefined && ledger.manager !== null && ledger.manager.term === undefined) {
    ledger.manager.term = ledger.managerTerm;
  }
}

function upsertRosterRowOf(ledger, record, identityName, at) {
  const row = ledger.members.find((entry) => entry.instanceId === record.instanceId && entry.sessionId === record.sessionId);
  if (row !== undefined) {
    row.role = 'member';
    row.state = 'member';
    row.identityName = row.identityName ?? identityName;
    if (!Number.isInteger(row.joinSeq)) {
      row.joinSeq = allocateJoinSeqOf(ledger);
    }
    row.joinedAt = row.joinedAt ?? new Date(at).toISOString();
    return row.joinSeq;
  }
  const joinSeq = allocateJoinSeqOf(ledger);
  ledger.members.push({
    instanceId: record.instanceId,
    sessionId: record.sessionId,
    identityName,
    role: 'member',
    state: 'member',
    joinSeq,
    joinedAt: new Date(at).toISOString(),
  });
  return joinSeq;
}

function allocateJoinSeqOf(ledger) {
  const seq = ledger.joinSeqNext;
  ledger.joinSeqNext = seq + 1;
  return seq;
}

function nameForSeat(joinState, record) {
  return record.instanceId === joinState.state.self.instanceId ? joinState.state.self.identityName : record.instanceId;
}

function markInviteAcceptedOf(joinState, books, joinId, record) {
  const held = joinState.joinInvites.get(joinId);
  if (held === undefined) {
    return;
  }
  joinState.joinInvites.delete(joinId);
  const accepted = books.invites.book.acceptInvite(held.inviteId, { instanceId: record.instanceId, sessionId: record.sessionId, now: joinState.now() });
  if (accepted.ok === true) {
    books.invites.save();
    return;
  }
  joinState.log.warn('邀请记录登记已接受失败（席位仍已入名单）', { inviteId: held.inviteId, reason: accepted.reason });
}

function markLocalSeatMemberOf(joinState, local, record, joinSeq) {
  if (local === undefined || record.instanceId !== joinState.state.self.instanceId) {
    return;
  }
  upsertLocalSeat(local, {
    version: 1,
    sessionId: record.sessionId,
    role: 'member',
    state: 'member',
    joinSeq,
    joinedAt: new Date(joinState.now()).toISOString(),
    muted: true,
    unverified: false,
  }, seatWriteOptionsOf(joinState, record.sessionId));
}

async function handleJoinConfirmOf(joinState, frame) {
  const context = joinConfirmContextOf(joinState, frame);
  if (context === null) {
    return null;
  }
  const found = booksForJoinId(joinState, context.joinId);
  if (found === null || found.collabId !== context.collabId) {
    return confirmUnknownJoinOf(joinState, context.local, context.joinId, context.seat);
  }
  return applyJoinConfirmOf(joinState, context, found);
}

function joinConfirmContextOf(joinState, frame) {
  const ids = joinConfirmIdsOf(frame);
  if (ids === null) {
    return null;
  }
  const local = joinState.state.collabs.get(ids.collabId);
  if (local === undefined || !isLocalManagedManager(local)) {
    return null;
  }
  return { ...ids, local, seat: { instanceId: ids.instanceId, sessionId: ids.sessionId }, managerTerm: frame.payload.managerTerm };
}

function joinConfirmIdsOf(frame) {
  const values = allIdsOf(idOf(frame?.collabId), idOf(frame?.payload?.joinId), idOf(frame?.from?.instanceId), idOf(frame?.from?.sessionId));
  return values === null ? null : { collabId: values[0], joinId: values[1], instanceId: values[2], sessionId: values[3] };
}

function isLocalManagedManager(local) {
  return localModeOf(local) === 'managed' && (managerSeatOfLocal(local) !== null || local.role === 'manager');
}

async function applyJoinConfirmOf(joinState, context, found) {
  const { local, joinId, seat } = context;
  if (found.record.instanceId !== seat.instanceId || found.record.sessionId !== seat.sessionId) {
    await sendJoinDenyOf(joinState, local, seat, joinId, 'aborted', found.record.managerTerm);
    return { ok: true, action: 'join-denied', joinId, reason: 'session-mismatch' };
  }
  const result = confirmJoiningOf(joinState, joinId, seat.sessionId, {
    instanceId: seat.instanceId, managerTerm: context.managerTerm,
    alreadyMember: isRosterMember(local, seat.instanceId, seat.sessionId),
  });
  if (result.ok !== true) {
    return confirmDeniedOf(joinState, local, found, joinId, seat, result);
  }
  await sendSnapshotToSeatOf(joinState, local, seat);
  return { ok: true, action: 'join-confirmed', joinId, alreadyMember: /** @type {any} */ (result).alreadyMember === true };
}

async function confirmUnknownJoinOf(joinState, local, joinId, seat) {
  if (isRosterMember(local, seat.instanceId, seat.sessionId)) {
    await sendSnapshotToSeatOf(joinState, local, seat);
    return { ok: true, action: 'join-confirmed', joinId, alreadyMember: true };
  }
  await sendJoinDenyOf(joinState, local, seat, joinId, 'aborted');
  return { ok: true, action: 'join-denied', joinId, reason: 'unknown' };
}

async function confirmDeniedOf(joinState, local, found, joinId, seat, result) {
  if (result.reason === 'roster-write-failed') {
    return { ok: false, action: 'join-retry', joinId, reason: result.reason, message: result.message };
  }
  await sendJoinDenyOf(joinState, local, seat, joinId, result.reason, found.record.managerTerm);
  return { ok: true, action: 'join-denied', joinId, reason: result.reason };
}

async function sendSnapshotToSeatOf(joinState, local, seat) {
  const ledger = local?.ledger;
  if (ledger === undefined || ledger === null) {
    return { ok: false, reason: '本机无台账' };
  }
  const payload = {
    kind: 'data',
    managerTerm: managerTermOf(local),
    version: ledger.version,
    digest: ledgerDigest(ledger),
    ledger: structuredClone(ledger),
    /* 窗口期 join-confirm 的快照必须与台账同窗：协议受理面要求任一侧存在即两侧一致，
     * 缺这个字段会让窗口期内新入席的成员收不到快照（一直停在 unverified）。 */
    ...(ledger.managerWindow === undefined ? {} : { managerWindow: structuredClone(ledger.managerWindow) }),
  };
  return sendSeatFrame(joinState, {
    collabId: local.collabId, instanceId: seat.instanceId, sessionId: seat.sessionId,
    type: 'snapshot', payload, fromSessionId: managerSessionOf(joinState, local) ?? seat.sessionId,
  });
}

async function handleJoinGrantOf(joinState, frame) {
  const context = joinGrantContextOf(joinState, frame);
  if (context === null) {
    return null;
  }
  const held = joinState.state.collabs.get(context.collabId);
  const application = matchSessionApplicationOf(joinState, frame, context.collabId, context.managerInstanceId);
  if (application === null) {
    if (held === undefined) {
      joinState.log.warn('join-grant 与本机申请台账不匹配（忽略）', { collabId: context.collabId, msgId: frame.msgId });
      return null;
    }
    return resendConfirmForGrantOf(joinState, held, context, frame);
  }
  const local = held ?? ensureLocalForGrantOf(joinState, frame, context, application);
  return beginLocalJoiningOf(joinState, local, application, context.joinId, frame.payload);
}

/* 冷启动 grant 的本地参与记录：按名解析 → join-request 的申请人本机此前没有该协作，
 * 邀请帧又没到（丢失/乱序/对端未走受邀入席）。建一条最小记录让两段式继续——协作名先以
 * 标识占位，名册与主题随后续快照补齐；不落地会让 grant 永远无从核对（unknown-collab 空等）。 */
function ensureLocalForGrantOf(joinState, frame, context, application) {
  const held = joinState.state.collabs.get(context.collabId);
  if (held !== undefined) {
    return held;
  }
  const dir = collabDir(joinState.state.dataDir, context.collabId);
  const stub = /** @type {any} */ (readCarrier(dir)).carrier;
  const created = provisionalLocalOf(joinState, context.collabId, frame.payload?.manager ?? {}, stub);
  seedManagerEndpointOf(joinState, created, context.managerInstanceId, application);
  joinState.state.collabs.set(context.collabId, created);
  /* 先落合法载体再写成员记录：只有 member.json 的目录会被判 0.1.x 归档；
   * 记录形态也要先合法（name/topic 不得为空），否则重启读不回。 */
  ensureSessionSeatsCarrierOf(joinState, created, frame.payload);
  persistMember(joinState.state, created);
  joinState.log.warn('收到加入授权但本机无该协作记录——已建最小参与记录（元数据待快照补齐）', {
    collabId: context.collabId, joinId: context.joinId,
  });
  return created;
}

/* 站长端点（回执寻址）：申请台账定格的端点优先，缺省退回已知主机清单。 */
function seedManagerEndpointOf(joinState, local, managerInstanceId, application) {
  const fromApplication = endpointPairOf(application?.managerAddress, application?.managerPort);
  const endpoint = fromApplication ?? endpointForJoinOf(joinState, local.collabId, local, managerInstanceId) ?? null;
  if (endpoint !== null) {
    local.endpoints.set(managerInstanceId, endpoint);
    /* 成员记录里的端点表是重启后的回执寻址来源（会话内 Map 不落盘）：两边同写，重启不丢。 */
    local.member.endpoints = { ...local.member.endpoints, [managerInstanceId]: endpoint };
  }
}

function endpointPairOf(address, port) {
  return typeof address === 'string' && isIP(address) !== 0 && Number.isInteger(port) && port >= 1 && port <= 65535
    ? { address, port }
    : null;
}

/* 加入域的端点取数：内存协作记录 → 盘上成员记录 → 已知主机清单。
 * 邀请占位目录重启后尚未载入内存（invite-stub 不参与注册表），但成员记录里已经存着
 * 邀请来源端点——接受邀请与冷启动回执都要靠它，不得只看内存。 */
function endpointForJoinOf(joinState, collabId, local, instanceId) {
  const inMemory = local === undefined ? undefined : endpointFor(joinState.state, local, instanceId);
  if (inMemory !== undefined) {
    return inMemory;
  }
  const record = loadMember(joinState.state.dataDir, collabId);
  const stored = record?.endpoints?.[instanceId];
  const pair = endpointPairOf(stored?.address, stored?.port);
  if (pair !== null) {
    return pair;
  }
  return lookupHostOf(joinState, instanceId) ?? undefined;
}

/** @param {any} carrier */
function provisionalLocalOf(joinState, collabId, manager, carrier = null) {
  const base = { dataDir: joinState.state.dataDir, collabId, log: joinState.log };
  const managerName = isIdentityName(manager.identityName) ? manager.identityName : manager.instanceId;
  /* 邀请占位载体带着真实名称与主题时优先采用；邀请丢失/乱序时以协作标识占位——
   * 两者都必须是合法呈现文本，否则成员记录读不回。 */
  const name = isIdentityName(carrier?.name) ? carrier.name : collabId;
  const now = new Date(joinState.now()).toISOString();
  return {
    collabId,
    role: 'member',
    ledger: null,
    member: {
      collabId,
      role: 'member',
      state: 'proposed',
      name,
      topic: isPresentationText(carrier?.topic, MAX_TOPIC_CHARS) ? carrier.topic : name,
      mode: isCollabMode(carrier?.mode) ? carrier.mode : 'managed',
      manager: { instanceId: manager.instanceId, identityName: managerName },
      roster: [{ instanceId: manager.instanceId, identityName: managerName }],
      endpoints: {},
      invitedAt: now,
      decision: null,
      provisional: true,
    },
    endpoints: new Map(),
    snapshot: null,
    posts: createPostsStore(base),
    members: createMembersStore(base),
    counter: createCounterStore(base),
    /* 退役 mute.json 的兼容句柄：静音权威是席位文件的 muted（契约 §8）。 */
    mute: retiredMuteHandle(),
    injected: createInjectedStore(base),
    suspended: null,
    staleManagerId: null,
  };
}

function joinGrantContextOf(joinState, frame) {
  const ids = joinGrantIdsOf(frame);
  if (ids === null) {
    return null;
  }
  if (frame.from.instanceId !== ids.managerInstanceId || idOf(frame.from.sessionId) !== ids.managerSessionId) {
    joinState.log.warn('join-grant 来源与载荷站长席位不符（忽略）', { collabId: ids.collabId, from: frame.from.instanceId });
    return null;
  }
  return ids;
}

function joinGrantIdsOf(frame) {
  const manager = frame?.payload?.manager;
  const values = allIdsOf(idOf(frame?.collabId), idOf(frame?.payload?.joinId), idOf(manager?.instanceId), idOf(manager?.sessionId));
  return values === null ? null : { collabId: values[0], joinId: values[1], managerInstanceId: values[2], managerSessionId: values[3] };
}

/* 重复 grant（首次 confirm 丢失）：本机席位已记同一 joinId 时重发 confirm，不重复建席位。 */
async function resendConfirmForGrantOf(joinState, local, context, frame) {
  const sessionId = idOf(frame?.payload?.sessionId);
  const seat = sessionId === null ? null : localSeatOfLocal(local, sessionId);
  if (seat === null || seat.joinId !== context.joinId) {
    joinState.log.warn('join-grant 与本机申请台账不匹配（忽略）', { collabId: context.collabId, msgId: frame.msgId });
    return null;
  }
  armConfirmRetryOf(joinState, local, seat.sessionId, context.joinId, {
    managerInstanceId: context.managerInstanceId,
    managerSessionId: context.managerSessionId,
    managerTerm: frame.payload.managerTerm,
    grantVersion: frame.payload.version,
  });
  const sent = await sendSeatFrame(joinState, {
    collabId: context.collabId, instanceId: context.managerInstanceId, sessionId: context.managerSessionId,
    type: 'join-confirm', payload: { joinId: context.joinId, managerTerm: frame.payload.managerTerm, version: frame.payload.version },
    fromSessionId: seat.sessionId,
  });
  return sent.ok === true
    ? { ok: true, action: 'joining', joinId: context.joinId, sessionId: seat.sessionId, resent: true }
    : { ok: false, action: 'join-failed', reason: sent.reason };
}

function matchSessionApplicationOf(joinState, frame, collabId, managerInstanceId) {
  const wanted = idOf(frame?.payload?.sessionId);
  return joinState.state.joinApplications.list().find((application) =>
    application.collabId === collabId
    && application.managerInstanceId === managerInstanceId
    && (wanted === null || application.sessionId === wanted)
    && joinState.now() - application.sentAt < ttlOf(joinState)) ?? null;
}

async function beginLocalJoiningOf(joinState, local, application, joinId, payload) {
  const seatOptions = seatWriteOptionsOf(joinState, application.sessionId);
  upsertLocalSeat(local, {
    version: 1,
    sessionId: application.sessionId,
    role: 'member',
    state: 'joining',
    joinId,
    grantVersion: payload.version,
    managerTerm: payload.managerTerm,
    joinedAt: new Date(joinState.now()).toISOString(),
    muted: true,
    unverified: false,
  }, seatOptions);
  /* 席位已落盘＝真正入席开始：邀请占位载体换成 session-seats，重启后按成员目录加载。 */
  ensureSessionSeatsCarrierOf(joinState, local, payload);
  clearApplications(joinState, application.collabId, application.sessionId);
  /* confirm 发出即转 member(unverified)：可接收注入、禁止发消息；快照到达后由快照消费面清除
   * unverified，回执失败则整席回滚。必须在发送前落位——同机旁路的发送会同步跑完
   * confirm → 名单提交 → 快照整链，快照先到时会因席位仍是 joining 而清不掉 unverified。
   * 合并必须带 sessionId：缺了它会以 undefined 为键新建匿名席位，原加入席停在 joining。 */
  upsertLocalSeat(local, {
    sessionId: application.sessionId,
    state: 'member',
    unverified: true,
  }, seatOptions);
  /* 首帧发出即挂重发轮：confirm 是幂等帧，单帧丢失/瞬态拒收不得让席位永久停在 unverified
   * （设计 §4.4.6/§4.4.8）。回执失败也保留席位与重发轮，由有界重发与超时回滚收口。 */
  armConfirmRetryOf(joinState, local, application.sessionId, joinId, {
    managerInstanceId: application.managerInstanceId,
    managerSessionId: payload.manager.sessionId,
    managerTerm: payload.managerTerm,
    grantVersion: payload.version,
  });
  const sent = await sendSeatFrame(joinState, {
    collabId: application.collabId,
    instanceId: application.managerInstanceId,
    sessionId: payload.manager.sessionId,
    type: 'join-confirm',
    payload: { joinId, managerTerm: payload.managerTerm, version: payload.version },
    fromSessionId: application.sessionId,
  });
  if (sent.ok !== true) {
    return { ok: false, action: 'join-failed', reason: sent.reason, retrying: true };
  }
  return { ok: true, action: 'joining', joinId, sessionId: application.sessionId, unverified: true };
}

/* —— 入席确认重发轮（设计 §4.4.6/§4.4.8） ——
 * 清除 unverified（收到含本席快照）前每 joinConfirmTtlMs/3 重发 join-confirm；grant 过期后停止
 * 重发，再等 sessionSeatTimeoutMs 宽限仍未见快照才回滚本机席位并提示——「站长已提交、快照丢帧」
 * 的窗口由重发取快照兜住，不因本地定时器到期就静默回滚（防幽灵席位）。 */

function confirmRetryKeyOf(collabId, sessionId) {
  return `${collabId}\u0000${sessionId}`;
}

/* 挂轮（幂等）：同一会话同一 joinId 已有轮次时不重开；换 joinId（站长重签）即替换。 */
function armConfirmRetryOf(joinState, local, sessionId, joinId, grant) {
  const collabId = local?.collabId;
  if (typeof collabId !== 'string' || idOf(sessionId) === null || idOf(joinId) === null) {
    return;
  }
  const key = confirmRetryKeyOf(collabId, sessionId);
  if (confirmRetryAlreadyHeldOf(joinState, key, joinId)) {
    return;
  }
  const entry = confirmRetryEntryOf(joinState, local, { collabId, sessionId, joinId }, grant);
  joinState.confirmRetries.set(key, entry);
  scheduleConfirmRetryOf(joinState, entry);
}

/* 已有轮次：同 joinId 视为已挂上；换 joinId（站长重签）即清掉旧轮次重新挂。 */
function confirmRetryAlreadyHeldOf(joinState, key, joinId) {
  const held = joinState.confirmRetries.get(key);
  if (held === undefined) {
    return false;
  }
  if (held.joinId === joinId) {
    return true;
  }
  clearTimeout(held.timer);
  joinState.confirmRetries.delete(key);
  return false;
}

function confirmRetryEntryOf(joinState, local, ids, grant) {
  const ttl = joiningTtlOf(joinState);
  const seat = localSeatOfLocal(local, ids.sessionId);
  return {
    timer: null,
    ...ids,
    managerInstanceId: idOf(grant?.managerInstanceId),
    managerSessionId: idOf(grant?.managerSessionId),
    managerTerm: positiveIntOrNull(grant?.managerTerm),
    grantVersion: positiveIntOrNull(grant?.grantVersion),
    delayMs: Math.max(1, Math.floor(ttl / 3)),
    expiresAt: seatStartedAtOf(seat, joinState.now()) + ttl,
    graceMs: seatTimeoutOf(joinState),
  };
}

function positiveIntOrNull(value) {
  return Number.isInteger(value) && value >= 1 ? value : null;
}

function seatStartedAtOf(seat, fallback) {
  const at = typeof seat?.joinedAt === 'string' ? Date.parse(seat.joinedAt) : Number.NaN;
  return Number.isFinite(at) ? at : fallback;
}

function seatTimeoutOf(joinState) {
  const timeout = joinState.state.config?.sessionSeatTimeoutMs;
  return Number.isFinite(timeout) && timeout > 0 ? timeout : SEAT_TIMEOUT_FALLBACK_MS;
}

function scheduleConfirmRetryOf(joinState, entry) {
  entry.timer = setTimeout(() => {
    void runConfirmRetryOf(joinState, entry);
  }, entry.delayMs);
  unrefTimer(entry.timer);
}

function clearConfirmRetryOf(joinState, collabId, sessionId) {
  const key = confirmRetryKeyOf(collabId, sessionId);
  const held = joinState.confirmRetries.get(key);
  if (held === undefined) {
    return false;
  }
  if (held.timer !== null) {
    clearTimeout(held.timer);
  }
  joinState.confirmRetries.delete(key);
  return true;
}

/* 一次推进：未确认且未过期 → 重发并续排；过期 → 只等宽限不再发帧；宽限过 → 回滚席位。
 * at 可显式给（测试确定性推进），缺省取注入时钟。 */
async function runConfirmRetryOf(joinState, entry, at = undefined) {
  clearEntryTimerOf(entry);
  const key = confirmRetryKeyOf(entry.collabId, entry.sessionId);
  if (joinState.confirmRetries.get(key) !== entry) {
    return CONFIRM_RETRY_IDLE;
  }
  const now = Number.isFinite(at) ? at : joinState.now();
  const local = joinState.state.collabs.get(entry.collabId);
  const seat = local === undefined ? null : localSeatOfLocal(local, entry.sessionId);
  if (!isUnverifiedSeatOf(seat, entry.joinId)) {
    joinState.confirmRetries.delete(key);
    return CONFIRM_RETRY_IDLE;
  }
  if (now >= entry.expiresAt + entry.graceMs) {
    rollbackUnverifiedSeatOf(joinState, local, seat);
    joinState.confirmRetries.delete(key);
    return { retried: false, rolledBack: true };
  }
  const retried = await confirmRetrySendOf(joinState, entry, seat.sessionId, now);
  if (joinState.confirmRetries.get(key) === entry) {
    scheduleConfirmRetryOf(joinState, entry);
  }
  return { retried, rolledBack: false };
}

const CONFIRM_RETRY_IDLE = { retried: false, rolledBack: false };

function clearEntryTimerOf(entry) {
  if (entry.timer !== null) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
}

/* grant 过期后只等宽限、不再发帧（设计 §4.4.8）；未过期则重发一次。 */
async function confirmRetrySendOf(joinState, entry, sessionId, now) {
  if (now >= entry.expiresAt) {
    return false;
  }
  const sent = await sendJoinConfirmOf(joinState, entry, sessionId);
  if (sent.ok !== true) {
    joinState.log.warn('join-confirm 重发失败（席位保留，按轮续试）', {
      collabId: entry.collabId, sessionId: entry.sessionId, reason: sent.reason,
    });
  }
  return true;
}

function isUnverifiedSeatOf(seat, joinId) {
  return seat !== null
    && seat.state === 'member'
    && seat.unverified === true
    && seat.joinId === joinId
    && !isSeatArchived(seat);
}

async function sendJoinConfirmOf(joinState, entry, sessionId) {
  if (entry.managerInstanceId === null || entry.managerSessionId === null || entry.managerTerm === null) {
    return { ok: false, reason: '站长席位信息未知（grant 记录不完整）' };
  }
  return sendSeatFrame(joinState, {
    collabId: entry.collabId,
    instanceId: entry.managerInstanceId,
    sessionId: entry.managerSessionId,
    type: 'join-confirm',
    payload: {
      joinId: entry.joinId,
      managerTerm: entry.managerTerm,
      ...(entry.grantVersion === null ? {} : { version: entry.grantVersion }),
    },
    fromSessionId: sessionId,
  });
}

/* 超时回滚（申请人侧）：删本机席位并留一行定向提示——可见的失败路径，不是静默消失。 */
function rollbackUnverifiedSeatOf(joinState, local, seat) {
  const name = localNameOf(local) ?? local.collabId;
  removeLocalSeat(local, seat.sessionId, { persist: true, dataDir: joinState.state.dataDir });
  joinState.log.info('入席确认超时：未确认席位已回滚', { collabId: local.collabId, sessionId: seat.sessionId, joinId: seat.joinId });
  notifySession(joinState, local, seat.sessionId,
    `入席未确认：协作「${name}」的站长在时限内未确认本会话（${shortSessionId(seat.sessionId)}）的入席——本机席位已回滚，请重新申请或联系站长`);
}

/* 重启恢复：按持久席位重建重发轮（joinId/grantVersion 在席位文件里；站长会话取自载体/快照）。 */
function resumeConfirmRetriesOfLocal(joinState, local) {
  if (local === undefined) {
    return;
  }
  for (const seat of seatsOfLocal(local).values()) {
    if (idOf(seat.joinId) === null || !isUnverifiedSeatOf(seat, seat.joinId)) {
      continue;
    }
    if (joinState.confirmRetries.has(confirmRetryKeyOf(local.collabId, seat.sessionId))) {
      continue;
    }
    const grant = resumeGrantOf(joinState, local);
    armConfirmRetryOf(joinState, local, seat.sessionId, seat.joinId, {
      managerInstanceId: grant?.instanceId,
      managerSessionId: grant?.sessionId,
      managerTerm: grant?.term,
      grantVersion: seat.grantVersion,
    });
  }
}

function resumeGrantOf(joinState, local) {
  const manager = readCarrier(collabDir(joinState.state.dataDir, local.collabId)).carrier?.manager;
  const instanceId = idOf(manager?.instanceId) ?? idOf(currentManagerIdOf(local));
  const sessionId = idOf(manager?.sessionId) ?? resumeManagerSessionIdOf(local);
  return instanceId === null || sessionId === null
    ? null
    : { instanceId, sessionId, term: resumeManagerTermOf(local, manager) };
}

function resumeManagerSessionIdOf(local) {
  return idOf(local.snapshot?.ledger?.manager?.sessionId) ?? idOf(local.ledger?.manager?.sessionId);
}

function resumeManagerTermOf(local, manager) {
  const carrierTerm = positiveIntOrNull(manager?.term);
  return carrierTerm ?? positiveIntOrNull(local.ledger?.manager?.term);
}

/* 显式推进面：重启后尚未被任何加入域操作触达的协作也能恢复轮次；定时器与测试共用。 */
async function retryPendingConfirmsOf(joinState, at = undefined) {
  for (const local of joinState.state.collabs.values()) {
    resumeConfirmRetriesOfLocal(joinState, local);
  }
  let retried = 0;
  let rolledBack = 0;
  for (const entry of [...joinState.confirmRetries.values()]) {
    const result = await runConfirmRetryOf(joinState, entry, at);
    if (result.retried) {
      retried++;
    }
    if (result.rolledBack) {
      rolledBack++;
    }
  }
  return { retried, rolledBack };
}

function handleJoinDenyOf(joinState, frame) {
  const ids = joinDenyIdsOf(frame);
  if (ids === null) {
    return null;
  }
  const payload = frame.payload;
  const local = joinState.state.collabs.get(ids.collabId);
  const sessionId = rollbackLocalJoiningOf(joinState, local, ids.joinId, idOf(payload?.sessionId));
  if (sessionId !== null) {
    clearApplications(joinState, ids.collabId, sessionId);
  }
  presentJoinDenyOf(joinState, ids.collabId, sessionId, payload?.reason);
  return { ok: true, action: 'join-denied', joinId: ids.joinId, reason: typeof payload?.reason === 'string' ? payload.reason : null };
}

function presentJoinDenyOf(joinState, collabId, sessionId, reason) {
  if (sessionId !== null) {
    presentDenial(joinState, { collabId, sessionId, reason: joinDenyTextOf(reason) });
  }
}

function joinDenyIdsOf(frame) {
  const collabId = idOf(frame?.collabId);
  const joinId = idOf(frame?.payload?.joinId);
  return collabId === null || joinId === null ? null : { collabId, joinId };
}

function rollbackLocalJoiningOf(joinState, local, joinId, explicitSessionId) {
  if (local === undefined) {
    return explicitSessionId;
  }
  const sessionId = explicitSessionId ?? findJoiningSessionOf(local, joinId);
  const seat = sessionId === null ? null : localSeatOfLocal(local, sessionId);
  const pendingSeat = seat !== null && (seat.state === 'joining' || (seat.state === 'member' && seat.unverified === true));
  if (pendingSeat && seat.joinId === joinId) {
    removeLocalSeat(local, seat.sessionId, { persist: true, dataDir: joinState.state.dataDir });
  }
  if (sessionId !== null) {
    clearConfirmRetryOf(joinState, local.collabId, sessionId);
  }
  return sessionId;
}

function findJoiningSessionOf(local, joinId) {
  for (const seat of seatsOfLocal(local).values()) {
    if (seat.joinId === joinId) {
      return seat.sessionId;
    }
  }
  return null;
}

function joinDenyTextOf(reason) {
  const labels = { expired: '在途入席已过期', aborted: '入席已中止', 'manager-changed': '站长已变更', capacity: '活跃席位已满' };
  return labels[reason] ?? (typeof reason === 'string' && reason !== '' ? reason : undefined);
}

function withdrawInviteOf(joinState, input) {
  const collabId = idOf(input.collabId);
  const managerSessionId = idOf(input.managerSessionId);
  const inviteId = idOf(input.inviteId);
  if (collabId === null || managerSessionId === null || inviteId === null) {
    return failureMessage('参数非法：需要 collabId、站长会话标识与 inviteId');
  }
  const local = joinState.state.collabs.get(collabId);
  if (local === undefined) {
    return failureMessage('本机没有该协作（collabId 不存在）');
  }
  if (localModeOf(local) === 'forum') {
    return failureMessage('讨论无共享邀请簿记：只撤销本机挂起记录，不产生 inviteId（设计 D18）', { code: 'forum-no-invite' });
  }
  if (!isManagerSession(joinState, local, managerSessionId)) {
    return failureMessage('只有站长会话可以撤回邀请');
  }
  const books = booksOf(joinState, collabId);
  const record = books.invites.book.get(inviteId);
  const withdrawn = books.invites.book.withdrawInvite(inviteId);
  if (withdrawn.ok !== true) {
    return failureMessage(`邀请不可撤回：${withdrawn.reason}`, { reason: withdrawn.reason });
  }
  books.invites.save();
  const aborted = abortJoiningsForInviteOf(joinState, local, books, collabId, record);
  if (withdrawn.idempotent !== true) {
    notifyWithdrawnTargetsOf(joinState, collabId, record, managerSessionId);
  }
  return {
    ok: true, inviteId, withdrawn: true, idempotent: withdrawn.idempotent === true,
    ...(aborted > 0 ? { joiningsAborted: aborted } : {}),
  };
}

/* 按目标机器撤回（工具面 target 参数）：0.2.0 的共享名单是 active-only，邀请在途态只在
 * invites.json——按目标逐条关闭 open 记录并停投，再补撤回帧。 */
function withdrawInviteByTargetOf(joinState, input) {
  const context = withdrawTargetContextOf(joinState, input);
  if (context.ok !== true) {
    return context;
  }
  const { local, books, collabId, managerSessionId, targetInstanceId } = /** @type {any} */ (context);
  const records = books.invites.book.list().filter((record) => record.state === 'open'
    && record.targets.some((target) => target.instanceId === targetInstanceId));
  if (records.length === 0) {
    return failureMessage(`没有该目标的待回应邀请记录（${targetInstanceId}）——邀请可能已被接受、拒绝、撤回或过期`);
  }
  const withdrawn = [];
  let aborted = 0;
  for (const record of records) {
    if (books.invites.book.withdrawInvite(record.inviteId).ok !== true) {
      continue;
    }
    withdrawn.push(record.inviteId);
    aborted += abortJoiningsForInviteOf(joinState, local, books, collabId, record);
    notifyWithdrawnTargetsOf(joinState, collabId, record, managerSessionId);
  }
  if (withdrawn.length === 0) {
    return failureMessage('邀请不可撤回（记录已关闭或已撤回）', { reason: 'closed' });
  }
  books.invites.save();
  return { ok: true, target: targetInstanceId, withdrawnInviteIds: withdrawn, joiningsAborted: aborted };
}

/* 按目标撤回的前置：标识形态、本机记录、managed、站长席位（与按 inviteId 同一判据）。 */
function withdrawTargetContextOf(joinState, input) {
  const collabId = idOf(input.collabId);
  const managerSessionId = idOf(input.managerSessionId);
  const targetInstanceId = idOf(input.target);
  if (collabId === null || managerSessionId === null || targetInstanceId === null) {
    return failureMessage('参数非法：需要 collabId、站长会话标识与 target（目标实例标识）');
  }
  const local = joinState.state.collabs.get(collabId);
  if (local === undefined) {
    return failureMessage('本机没有该协作（collabId 不存在）');
  }
  if (localModeOf(local) === 'forum') {
    return failureMessage('讨论无共享邀请簿记：forum 不产生 inviteId（设计 D18）', { code: 'forum-no-invite' });
  }
  if (!isManagerSession(joinState, local, managerSessionId)) {
    return failureMessage('只有站长会话可以撤回邀请');
  }
  return { ok: true, local, books: booksOf(joinState, collabId), collabId, managerSessionId, targetInstanceId };
}

/* 撤回的关联收尾：该邀请目标的在途 joining 作废并回 join-deny(aborted)——否则已签发 grant
 * 的会话仍可 confirm 入席（撤回语义失真）。 */
function abortJoiningsForInviteOf(joinState, local, books, collabId, record) {
  if (record === null) {
    return 0;
  }
  const aborted = [];
  for (const joining of books.joining.registry.list()) {
    if (joining.collabId !== collabId || !inviteTargetsJoiningOf(record, joining)) {
      continue;
    }
    if (books.joining.registry.abortJoining(joining.joinId, 'aborted').ok === true) {
      aborted.push(joining);
    }
  }
  if (aborted.length > 0) {
    books.joining.save();
    for (const joining of aborted) {
      void sendJoinDenyOf(joinState, local, joining, joining.joinId, 'aborted', joining.managerTerm)
        .catch((error) => joinState.log.warn('撤回后的 join-deny 发送失败', { collabId, joinId: joining.joinId, reason: error?.message }));
    }
  }
  return aborted.length;
}

function inviteTargetsJoiningOf(record, joining) {
  return record.targets.some((target) => target.instanceId === joining.instanceId
    && (target.targetSessionId === undefined || target.targetSessionId === joining.sessionId));
}

/* 撤回帧：目标端据此清挂起记录。同机目标不投帧（未入席会话没有可投面，N-2）——直接清本机
 * 挂起记录并同步本地参与记录的撤回结论。远端投递结果只留痕（撤回已在本地生效）。 */
function notifyWithdrawnTargetsOf(joinState, collabId, record, managerSessionId) {
  if (record === null) {
    return;
  }
  for (const target of record.targets) {
    if (target.instanceId === joinState.state.self.instanceId) {
      applyLocalWithdrawOf(joinState, { collabId, inviteId: record.inviteId });
      continue;
    }
    void sendSeatFrame(joinState, {
      collabId, instanceId: target.instanceId, sessionId: target.targetSessionId,
      type: 'withdraw', payload: { scope: 'single', inviteId: record.inviteId }, fromSessionId: managerSessionId,
    }).then((sent) => {
      if (sent.ok !== true) {
        joinState.log.warn('撤回帧未送达目标（本地撤回已生效）', { collabId, inviteId: record.inviteId, reason: sent.reason });
      }
    }).catch((error) => {
      joinState.log.warn('撤回帧发送异常（本地撤回已生效）', { collabId, inviteId: record.inviteId, reason: error?.message });
    });
  }
}

/* 同机撤回的本地收口：清挂起记录并同步本地参与记录（与远端 handleWithdrawInbound 同口径）。 */
function applyLocalWithdrawOf(joinState, { collabId, inviteId }) {
  const cleared = withdrawPendingInviteOf(joinState, { collabId, inviteId });
  if (cleared.ok !== true) {
    joinState.log.warn('同机撤回清理挂起邀请失败', { collabId, inviteId, reason: cleared.reason });
  }
  const local = joinState.state.collabs.get(collabId);
  if (local !== undefined && local.role === 'member' && (local.member?.decision ?? null) === null) {
    local.member.decision = 'withdrawn';
    persistMember(joinState.state, local);
  }
}

/* 目标端收到撤回：清对应挂起邀请（不按邀请记录冒充他人决定）。 */
function withdrawPendingInviteOf(joinState, input) {
  const collabId = idOf(input?.collabId);
  const inviteId = idOf(input?.inviteId);
  if (collabId === null || inviteId === null) {
    return failureMessage('参数非法：需要 collabId 与 inviteId');
  }
  const books = booksOf(joinState, collabId);
  const result = books.pending.store.withdrawPending({ collabId, inviteId });
  if (result.ok === true) {
    books.pending.save();
  }
  return result;
}

/* 发起侧收到拒绝帧：关闭对应邀请记录（指名邀请置 closed，不指名邀请保持 open 供其他会话）。
 * 返回 null＝不是 0.2.0 簿记帧（交旧回应路径计数）。 */
function handleInviteDeclineOf(joinState, frame) {
  const ids = inviteDeclineIdsOf(frame);
  if (ids === null) {
    return null;
  }
  const local = joinState.state.collabs.get(ids.collabId);
  if (local === undefined || local.role !== 'manager' || localModeOf(local) === 'forum') {
    return null;
  }
  const books = booksOf(joinState, ids.collabId);
  const result = books.invites.book.declineInvite(ids.inviteId, {
    instanceId: ids.instanceId, sessionId: ids.sessionId, now: joinState.now(),
  });
  if (result.ok === true) {
    books.invites.save();
  }
  return result;
}

function inviteDeclineIdsOf(frame) {
  const values = allIdsOf(idOf(frame?.collabId), idOf(frame?.payload?.inviteId), idOf(frame?.from?.instanceId), idOf(frame?.from?.sessionId));
  return values === null ? null : { collabId: values[0], inviteId: values[1], instanceId: values[2], sessionId: values[3] };
}

function registerPendingInviteOf(joinState, input) {
  const collabId = idOf(input.collabId);
  const inviteId = idOf(input.inviteId);
  if (collabId === null || inviteId === null) {
    return failureMessage('参数非法：需要 collabId 与 inviteId');
  }
  const expiresAt = Number.isInteger(input.expiresAt) && input.expiresAt > 0
    ? input.expiresAt
    : joinState.now() + inviteTtlOf(joinState);
  const books = booksOf(joinState, collabId);
  const applied = books.pending.store.applyPendingInvite({
    collabId,
    inviteId,
    fromManager: input.fromManager,
    targetSessionId: input.targetSessionId,
    expiresAt,
    now: joinState.now(),
  });
  if (applied.ok !== true) {
    return failureMessage(`挂起邀请登记失败：${applied.reason}`, { reason: applied.reason });
  }
  /* 落盘失败不得回报登记成功：调用方（邀请落点）据此中止落地，否则重启后这条邀请无从补投/校验。 */
  const saved = books.pending.save();
  if (saved.ok !== true) {
    return failureMessage(`挂起邀请写入失败：${saved.reason}`, { reason: 'persist-failed' });
  }
  return { ok: true, inviteId, duplicate: applied.duplicate === true, expiresAt };
}

function handleInviteFrameOf(joinState, frame) {
  /* 载体必须先于任何拒绝分支落成：事件面无论加入域结果如何都会建本地参与记录（member.json），
   * 只有成员记录的目录在重启时会被判成 0.1.x 协作并永久归档——歧义拒绝、无 inviteId 的讨论
   * 邀请都走这条统一的落点保障。 */
  const carrierReady = ensureInviteStubCarrierOf(joinState, frame);
  const inviteId = idOf(frame?.payload?.inviteId);
  if (inviteId === null) {
    /* 不带 inviteId 的邀请（0.1.x 对端 / 讨论）：没有挂起邀请簿记，只有载体。 */
    return carrierReady
      ? { ok: true, ignored: 'forum-no-invite' }
      : inviteCarrierFailureResult();
  }
  if (!carrierReady) {
    return inviteCarrierFailureResult();
  }
  const managerSessionId = idOf(frame?.from?.sessionId);
  if (managerSessionId === null) {
    return failureMessage('邀请帧缺少 from.sessionId');
  }
  const target = /** @type {any} */ (resolveIncomingTargetOf(joinState, frame));
  if (target.ok !== true) {
    return target;
  }
  return registerPendingInviteOf(joinState, {
    collabId: frame.collabId,
    inviteId,
    fromManager: { instanceId: frame.from.instanceId, sessionId: managerSessionId },
    targetSessionId: target.sessionId,
    now: joinState.now(),
  });
}

function inviteCarrierFailureResult() {
  return failureMessage(
    '邀请落点载体写入失败——目录已标记为恢复态（只读），本次邀请不可接受；请检查磁盘后重新受邀',
    { reason: 'carrier-write-failed' },
  );
}

/* 邀请落点的载体（设计 §4.2）：挂起邀请尚未真正入席，目录先以 invite-stub 标记——
 * 只有 member.json 的目录在重启时会被判成 0.1.x 协作并归档只读。已有载体不改写：
 * 重复邀请与已入席目录不得被降级回邀请形态。返回落点是否有合法载体（已有或刚写成）；
 * 写失败按创建路径的失败收口写 recovery 标记——目录显式只读可恢复，而不是静默变成 legacy。 */
function ensureInviteStubCarrierOf(joinState, frame) {
  const collabId = idOf(frame?.collabId);
  if (collabId === null) {
    return false;
  }
  if (hasActiveLocalParticipationOf(joinState, collabId)) {
    return true;
  }
  const dir = collabDir(joinState.state.dataDir, collabId);
  if (readCarrierFormat(dir) !== null) {
    return true;
  }
  return writeInviteStubOf(joinState, dir, collabId, frame?.payload ?? {});
}

function writeInviteStubOf(joinState, dir, collabId, payload) {
  if (writeCarrierQuietlyOf(joinState, dir, inviteStubCarrierOf(joinState, collabId, payload))) {
    return true;
  }
  markInviteLandingRecoveryOf(joinState, dir, collabId);
  return false;
}

function inviteStubCarrierOf(joinState, collabId, payload) {
  const name = isIdentityName(payload.name) ? payload.name : collabId;
  return {
    format: CARRIER_FORMAT_INVITE_STUB,
    version: CARRIER_VERSION,
    collabId,
    name,
    topic: isPresentationText(payload.topic, MAX_TOPIC_CHARS) ? payload.topic : name,
    mode: isCollabMode(payload.mode) ? payload.mode : 'managed',
    endpoints: {},
    snapshotVersion: 0,
    createdAt: new Date(joinState.now()).toISOString(),
  };
}

/* 载体写失败的收口：与新建路径同一口径（recovery.json ＋ 只读），让重启能把目录识别为
 * 「邀请落点半写」而不是旧版协作；标记也写不成时只留痕，进程内由写门按目录实况 fail-closed。 */
function markInviteLandingRecoveryOf(joinState, dir, collabId) {
  const written = writeRecovery(dir, { reason: 'carrier-write-failed', now: new Date(joinState.now()).toISOString() });
  if (written?.ok !== true) {
    joinState.state.counters.persistFailures = (joinState.state.counters.persistFailures ?? 0) + 1;
    joinState.log.warn('邀请落点载体与恢复标记都未能落盘（该目录按只读处理）', { collabId });
  }
}

/* 已在册的活跃参与（站长台账 / 席位）不得被一条重复邀请降级成邀请占位：
 * invite-stub 目录重启时按「未真正入席」读取，会把活协作藏起来。 */
function hasActiveLocalParticipationOf(joinState, collabId) {
  const held = joinState.state.collabs.get(collabId);
  return held !== undefined && (held.ledger !== null || held.role === 'manager' || seatsOfLocal(held).size > 0);
}

/* 真正入席的目录形态（设计 §4.2/§6.2）：受邀目录的 invite-stub 在拿到 grant 后原子换成
 * session-seats，否则该目录重启后仍按邀请占位读取，成员席位与快照不会被加载。
 * 已有 session-seats 载体时保留原档（元数据补齐由成员记录承担，避免每次入席重写载体）。 */
function ensureSessionSeatsCarrierOf(joinState, local, payload) {
  const dir = collabDir(joinState.state.dataDir, local.collabId);
  if (readCarrierFormat(dir) === CARRIER_FORMAT_SESSION_SEATS) {
    return;
  }
  writeCarrierQuietlyOf(joinState, dir, sessionSeatsCarrierOf(joinState, local, payload));
}

function sessionSeatsCarrierOf(joinState, local, payload) {
  const member = local.member ?? {};
  const name = isIdentityName(member.name) ? member.name : local.collabId;
  const manager = carrierManagerOf(payload);
  return {
    format: CARRIER_FORMAT_SESSION_SEATS,
    version: CARRIER_VERSION,
    collabId: local.collabId,
    name,
    topic: isPresentationText(member.topic, MAX_TOPIC_CHARS) ? member.topic : name,
    mode: isCollabMode(member.mode) ? member.mode : 'managed',
    endpoints: carrierEndpointsOf(local),
    ...(manager === null ? {} : { manager }),
    snapshotVersion: local.snapshot?.version ?? local.ledger?.version ?? 0,
    createdAt: new Date(joinState.now()).toISOString(),
  };
}

/* 载体里的站长条目须带任期（0.2.0 起 term 是必填面）；grant 载荷缺任期时省略该字段，
 * 由后续快照/对表补齐，不臆造 term。 */
function carrierManagerOf(payload) {
  const manager = payload?.manager;
  const sessionId = idOf(manager?.sessionId);
  if (idOf(manager?.instanceId) === null || sessionId === null || !Number.isInteger(payload?.managerTerm) || payload.managerTerm < 1) {
    return null;
  }
  return {
    instanceId: manager.instanceId,
    sessionId,
    identityName: isIdentityName(manager.identityName) ? manager.identityName : manager.instanceId,
    term: payload.managerTerm,
  };
}

function carrierEndpointsOf(local) {
  const endpoints = {};
  for (const [instanceId, endpoint] of local.endpoints ?? []) {
    const pair = endpointPairOf(endpoint?.address, endpoint?.port);
    if (idOf(instanceId) !== null && pair !== null) {
      endpoints[instanceId] = pair;
    }
  }
  return endpoints;
}

function writeCarrierQuietlyOf(joinState, dir, carrier) {
  try {
    writeCarrier(dir, carrier);
    return true;
  } catch (error) {
    joinState.state.counters.persistFailures++;
    joinState.log.warn('协作载体写入失败（内存态继续）', { collabId: carrier.collabId, reason: error.message });
    return false;
  }
}

/* 收到邀请的指名目标：本机可唯一解析的短码换成全量会话标识后落盘（补投与可见性比较按全量
 * 标识）；未命中时原样保留，由比较面的短码口径兜底（会话晚注册也能看到）。歧义必须拒绝：
 * 回落原 token 会让多个会话都看到本应只给一个会话的邀请。 */
function resolveIncomingTargetOf(joinState, frame) {
  const raw = namedTargetTokenOf(joinState, frame);
  if (raw === undefined || raw === null) {
    return { ok: true, sessionId: undefined };
  }
  const token = idOf(raw);
  if (token === null) {
    return failureMessage('邀请载荷的 targetSessionId 形态非法');
  }
  const sessions = injectableSessionsOf(joinState, frame.collabId).map((sessionId) => ({ sessionId }));
  if (sessions.some((entry) => entry.sessionId === token)) {
    return { ok: true, sessionId: token };
  }
  const shortHits = isSessionShortCode(token)
    ? sessions.filter((entry) => shortSessionId(entry.sessionId) === token)
    : [];
  if (shortHits.length > 1) {
    return failureMessage(`邀请载荷的 targetSessionId 短码（${token}）有歧义：在本机命中 ${shortHits.length} 个会话——无法确定指名目标，请改用完整会话标识`);
  }
  return { ok: true, sessionId: shortHits[0]?.sessionId ?? token };
}

/* 指名目标的取数面：0.2.0 邀请把目标写在 targets[]（按机器定位），旧版面带顶层 targetSessionId。
 * 本机目标项存在即以其为准——没有 targetSessionId 就是**不指名**（不得回落到顶层字段）。 */
function namedTargetTokenOf(joinState, frame) {
  const targets = frame?.payload?.targets;
  if (Array.isArray(targets)) {
    const own = targets.find((target) => target?.instanceId === joinState.state.self.instanceId);
    if (own !== undefined) {
      return own.targetSessionId;
    }
  }
  return frame?.payload?.targetSessionId;
}

function pendingInvitesForOf(joinState, input) {
  const collabId = idOf(input.collabId);
  const sessionId = idOf(input.sessionId);
  if (collabId === null || sessionId === null) {
    return [];
  }
  const books = booksOf(joinState, collabId);
  return books.pending.store.matchPendingForSession({ collabId, sessionId, inviteId: input.inviteId, now: joinState.now() });
}

/* 已接受邀请的原始记录（不按 matchPending 的「已接受/终态」过滤）：重启后 invite-stub 无本地
 * 记录时，服务层靠它仍能进入加入域——已成席则幂等，未成席（approve/grant 丢帧）则重发 approve。 */
function acceptedInviteOf(joinState, input) {
  const collabId = idOf(input.collabId);
  const inviteId = idOf(input.inviteId);
  const sessionId = idOf(input.sessionId);
  if (collabId === null || inviteId === null || sessionId === null) {
    return null;
  }
  const record = booksOf(joinState, collabId).pending.store.get({ collabId, inviteId });
  return record !== null && record.acceptedSessions.includes(sessionId) ? record : null;
}

/* 待回应邀请计数（上限判定面）：按挂起账的 open 且未过期记录计数——重启后由 pending-invites
 * 文件恢复，不依赖本地参与记录是否加载（invite-stub 不参与注册表加载）。
 * 无邀请簿记的旧版邀请（无 inviteId）仍按本地 proposed 记录计数，且不与挂起账重复计数。 */
function pendingInviteCountOf(joinState, at) {
  const now = Number.isFinite(at) ? at : joinState.now();
  const booked = bookedPendingInvitesOf(joinState, now);
  return booked.count + unbookedProposedInvitesOf(joinState, booked.collabIds);
}

function bookedPendingInvitesOf(joinState, now) {
  const collabIds = new Set();
  let count = 0;
  for (const [collabId, books] of allBooksOf(joinState)) {
    const open = books.pending.store.list().filter((record) => record.state === 'open' && now < record.expiresAt).length;
    if (open > 0) {
      collabIds.add(collabId);
      count += open;
    }
  }
  return { count, collabIds };
}

function unbookedProposedInvitesOf(joinState, bookedCollabIds) {
  let count = 0;
  for (const local of joinState.state.collabs.values()) {
    if (local.role === 'member' && local.member?.state === 'proposed' && (local.member.decision ?? null) === null
      && !bookedCollabIds.has(local.collabId)) {
      count++;
    }
  }
  return count;
}

/* 清单面（ws_list_collabs 的待回应邀请）：open 与已过期记录都要露面（设计 §9：含过期），
 * 至少给 inviteId / 目标会话 / 邀请者 / 有效期 / 状态——邀请消息丢失或核心重启后，
 * 这是用户唯一能拿到 inviteId 的入口。 */
function pendingInviteListOf(joinState, input) {
  const collabId = idOf(input.collabId);
  const sessionId = idOf(input.sessionId);
  if (collabId === null || sessionId === null) {
    return [];
  }
  const at = joinState.now();
  const books = booksOf(joinState, collabId);
  return books.pending.store.list()
    .filter((record) => record.collabId === collabId)
    .filter((record) => record.state === 'open' || record.state === 'expired')
    .filter((record) => !record.acceptedSessions.includes(sessionId))
    .filter((record) => record.targetSessionId === null || targetMatchesSessionOf(record.targetSessionId, sessionId))
    .map((record) => pendingInviteViewOf(record, at));
}

function pendingInviteViewOf(record, at) {
  const expired = record.state === 'expired' || at >= record.expiresAt;
  return {
    inviteId: record.inviteId,
    collabId: record.collabId,
    targetSessionId: record.targetSessionId,
    from: { instanceId: record.fromManager.instanceId, sessionId: record.fromManager.sessionId },
    expiresAt: new Date(record.expiresAt).toISOString(),
    state: expired ? 'expired' : record.state,
    expired,
  };
}

function targetMatchesSessionOf(target, sessionId) {
  if (target === sessionId) {
    return true;
  }
  return isSessionShortCode(target) && matchSessionByToken([{ sessionId }], target) === sessionId;
}

/* 会话注册补投（设计 §4.2）：桥注册时把本机挂起邀请按簿记语义重投一次——指名按
 * targetSessionId 精确匹配，不指名匹配当前注册会话。投出成功不消费记录（不指名邀请不因
 * 一次接受失效；指名邀请在接受/拒绝时才置终态），投不出去保留待下轮注册再试。 */
async function replayPendingInvitesOf(joinState, sessionId, collabIds, deliver) {
  const target = idOf(sessionId);
  if (target === null || !Array.isArray(collabIds) || typeof deliver !== 'function') {
    return { delivered: 0 };
  }
  let delivered = 0;
  for (const collabId of collabIds) {
    delivered += await replayCollabInvitesOf(joinState, collabId, target, deliver);
  }
  return { delivered };
}

async function replayCollabInvitesOf(joinState, collabId, target, deliver) {
  if (idOf(collabId) === null) {
    return 0;
  }
  const books = booksOf(joinState, collabId);
  const pending = books.pending.store.matchPendingForSession({ collabId, sessionId: target, now: joinState.now() });
  let delivered = 0;
  for (const record of pending) {
    const frame = replayInviteFrameOf(joinState, collabId, record);
    if (frame === null) {
      continue;
    }
    const result = await deliver(collabId, target, frame);
    if (result?.ok === true) {
      delivered++;
      joinState.state.counters.pendingInvitesReplayed = (joinState.state.counters.pendingInvitesReplayed ?? 0) + 1;
    }
  }
  return delivered;
}

/* 补投帧的组帧面：挂起记录只存簿记（inviteId/来源站长/目标会话），展示用的名称、主题与模式
 * 取落点载体（邀请到达时已定格）。载体读不出（半写/被删）时不组残缺帧，留给下一轮。 */
function replayInviteFrameOf(joinState, collabId, record) {
  const carrier = readCarrier(collabDir(joinState.state.dataDir, collabId)).carrier;
  if (carrier === null) {
    return null;
  }
  const manager = record.fromManager;
  const carrierManager = carrier.manager?.instanceId === manager.instanceId ? carrier.manager : null;
  /* 协作域帧的 from 必携 sessionId、members 为席位条目（协议层校验面）：旧挂起记录没有
   * manager.sessionId 时从载体补——都拿不到就不组残缺帧，留给下一轮（不为投递伪造来源）。 */
  const managerSessionId = idOf(manager.sessionId) ?? idOf(carrierManager?.sessionId);
  if (managerSessionId === null) {
    joinState.log.warn('挂起邀请缺少邀请者会话标识——补投帧无法组出合法 from.sessionId', { collabId, inviteId: record.inviteId });
    return null;
  }
  const identityName = isIdentityName(carrierManager?.identityName) ? carrierManager.identityName : manager.instanceId;
  return withCollabCapability({
    v: PROTOCOL_VERSION,
    msgId: newMsgId(),
    type: 'invite',
    collabId,
    from: { instanceId: manager.instanceId, identityName, sessionId: managerSessionId },
    ts: new Date(joinState.now()).toISOString(),
    payload: {
      name: carrier.name,
      topic: carrier.topic,
      mode: carrier.mode,
      inviteId: record.inviteId,
      targets: [{
        instanceId: joinState.state.self.instanceId,
        ...(typeof record.targetSessionId === 'string' ? { targetSessionId: record.targetSessionId } : {}),
      }],
      members: [{ instanceId: manager.instanceId, identityName, sessionId: managerSessionId }],
    },
  });
}

/* 站长侧收到受邀会话的 approve（approve 携 inviteId 时由事件面转交本域签发 grant）。
 * 终态拒绝必须回执（N-3）：目标端已消费挂起邀请并停在「已接受、待授权」，没有 grant 也不会
 * 自行收敛——不回收据就是用户可见死胡同。 */
async function handleInviteApprovalOf(joinState, frame) {
  const context = inviteApprovalContextOf(joinState, frame);
  if (context === null) {
    return null;
  }
  const { local, collabId, inviteId, instanceId, sessionId } = context;
  const managerSessionId = managerSessionOf(joinState, local);
  if (managerSessionId === null) {
    return failureMessage('站长席位未知——无法签发 join-grant');
  }
  const result = await approveInviteForSeat(joinState, {
    collabId, inviteId, instanceId, sessionId, managerSessionId,
    identityName: isIdentityName(frame.from.identityName) ? frame.from.identityName : instanceId,
  });
  if (result?.ok !== true) {
    const reason = /** @type {any} */ (result)?.reason;
    await sendInviteRejectionReceiptOf(joinState, { collabId, inviteId, instanceId, sessionId, managerSessionId, reason });
  }
  return result;
}

/* 终态拒绝的 join-deny 回执：只对「目标匹配但邀请已不可用」的失败回帧（撤回 / 过期 / 已关闭 /
 * 已接受未成席）；目标不符或形态类失败不回（坏目标隔离，不给伪造帧回执）。
 * 目标端 handleJoinDeny 以 payload.sessionId 回滚申请记录并提示；joinId 优先取该会话的在途记录，
 * 没有则用 inviteId 兜底（目标端本就没有在途 grant 可回滚）。 */
const INVITE_REJECTION_RECEIPT_REASONS = new Set(['expired', 'withdrawn', 'closed', 'already-accepted', 'already-declined']);

async function sendInviteRejectionReceiptOf(joinState, { collabId, inviteId, instanceId, sessionId, managerSessionId, reason }) {
  if (!INVITE_REJECTION_RECEIPT_REASONS.has(reason)) {
    return;
  }
  const joining = booksOf(joinState, collabId).joining.registry.find(collabId, sessionId);
  const joinId = joining !== null && joining.instanceId === instanceId ? joining.joinId : inviteId;
  await sendSeatFrame(joinState, {
    collabId, instanceId, sessionId, type: 'join-deny',
    payload: { joinId, reason: reason === 'expired' ? 'expired' : 'aborted', sessionId },
    fromSessionId: managerSessionId,
  }).catch((error) => joinState.log.warn('邀请终态拒绝回执发送失败', { collabId, inviteId, reason: error?.message }));
}

function inviteApprovalContextOf(joinState, frame) {
  const ids = inviteApprovalIdsOf(frame);
  if (ids === null) {
    return null;
  }
  const local = joinState.state.collabs.get(ids.collabId);
  return local === undefined || localModeOf(local) !== 'managed' ? null : { local, ...ids };
}

function inviteApprovalIdsOf(frame) {
  const values = allIdsOf(idOf(frame?.collabId), idOf(frame?.payload?.inviteId), idOf(frame?.from?.instanceId), idOf(frame?.from?.sessionId));
  return values === null ? null : { collabId: values[0], inviteId: values[1], instanceId: values[2], sessionId: values[3] };
}

/* 遍历本机已知协作的三账（已加载的 + 注册表在册但尚未取用的）：定时清理与站长更替作废
 * 不能只覆盖「碰巧已加载」的那几条。 */
function allBooksOf(joinState) {
  const collabIds = new Set([
    ...joinState.books.keys(),
    ...joinState.state.collabs.keys(),
    ...listLocalCollabIds(joinState.state.dataDir),
  ]);
  return [...collabIds].map((collabId) => [collabId, booksOf(joinState, collabId)]);
}

/* 作废面可限定到单条协作（站长更替只影响该协作的邀请）：未给 collabId 时覆盖全部
 * （仅供运维/测试的显式全量清扫）。 */
function booksScopeOf(joinState, collabId) {
  const scoped = idOf(collabId);
  return scoped === null ? allBooksOf(joinState) : [[scoped, booksOf(joinState, scoped)]];
}

async function expireJoiningOf(joinState, at) {
  let expired = 0;
  for (const [collabId, books] of allBooksOf(joinState)) {
    const local = joinState.state.collabs.get(collabId);
    const result = books.joining.registry.expireJoining(at);
    if (result.expired === 0) {
      continue;
    }
    books.joining.save();
    expired += result.expired;
    for (const record of result.records) {
      if (local !== undefined) {
        await sendJoinDenyOf(joinState, local, record, record.joinId, 'expired', record.managerTerm);
      }
    }
  }
  return { expired };
}

function expirePendingInvitesOf(joinState, at) {
  let expired = 0;
  for (const [, books] of allBooksOf(joinState)) {
    const result = books.pending.store.expirePending(at);
    if (result.expired > 0) {
      books.pending.save();
      expired += result.expired;
    }
  }
  return { expired };
}

/* 发起侧 invites.json 的到期清理（记录整体移除）：不清理会永久累积 open 记录，
 * 撤回/拒绝的定位面也会被过期记录污染。 */
function expireInvitesOf(joinState, at) {
  let expired = 0;
  for (const [, books] of allBooksOf(joinState)) {
    const result = books.invites.book.expireInvites(at);
    if (result.expired > 0) {
      books.invites.save();
      expired += result.expired;
    }
  }
  return { expired };
}

/* 目标侧终态挂起记录的保留窗：过期/消费/撤回后再留一天供观察窗解释去向，之后清理
 * （容量面另由 pending store 的终态优先回收兜底）。 */
const PENDING_TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000;

function pruneTerminalPendingOf(joinState, at) {
  const cutoff = at - PENDING_TERMINAL_RETENTION_MS;
  let pruned = 0;
  for (const [, books] of allBooksOf(joinState)) {
    const result = books.pending.store.pruneTerminal(cutoff);
    if (result.pruned > 0) {
      books.pending.save();
      pruned += result.pruned;
    }
  }
  return { pruned };
}

async function invalidateForManagerChangeOf(joinState, managerTerm, collabId = null) {
  let aborted = 0;
  for (const [scopedCollabId, books] of booksScopeOf(joinState, collabId)) {
    const local = joinState.state.collabs.get(scopedCollabId);
    const result = books.joining.registry.invalidateForManagerChange(managerTerm);
    if (result.ok !== true || result.aborted.length === 0) {
      continue;
    }
    books.joining.save();
    aborted += result.aborted.length;
    for (const record of result.abortedRecords) {
      if (local !== undefined) {
        await sendJoinDenyOf(joinState, local, record, record.joinId, 'manager-changed', record.managerTerm);
      }
    }
  }
  return { aborted };
}

/* 站长更替的邀请面作废（D5）：旧站长签发的 open 邀请记录全部关闭，待批准加入申请同步清空，
 * 由新站长按新名单重发。joining 的旧 term 作废由 invalidateForManagerChange 负责。 */
function invalidateInvitesForManagerChangeOf(joinState, collabId = null) {
  let withdrawn = 0;
  let clearedRequests = 0;
  for (const [scopedCollabId, books] of booksScopeOf(joinState, collabId)) {
    const open = books.invites.book.list().filter((record) => record.state === 'open');
    for (const record of open) {
      if (books.invites.book.withdrawInvite(record.inviteId).ok === true) {
        withdrawn++;
      }
    }
    if (open.length > 0) {
      books.invites.save();
    }
    const requests = joinState.pendingRequests.get(scopedCollabId);
    if (requests !== undefined && requests.size > 0) {
      clearedRequests += requests.size;
      joinState.pendingRequests.delete(scopedCollabId);
    }
  }
  return { withdrawn, clearedRequests };
}

function abortJoiningOf(joinState, joinId, reason) {
  const found = typeof joinId === 'string' ? booksForJoinId(joinState, joinId) : null;
  if (found === null) {
    return failureMessage('未知 joinId', { reason: 'unknown' });
  }
  const aborted = found.books.joining.registry.abortJoining(joinId, reason);
  if (aborted.ok !== true) {
    return failureMessage(`在途入席不可中止：${aborted.reason}`, { reason: aborted.reason });
  }
  found.books.joining.save();
  return { ok: true, joinId, reason: aborted.reason, record: aborted.record };
}

function releaseJoiningOf(joinState, collabId, sessionId) {
  const collab = idOf(collabId);
  const session = idOf(sessionId);
  if (collab === null || session === null) {
    return failureMessage('参数非法：需要 collabId 与会话标识');
  }
  const books = booksOf(joinState, collab);
  const released = books.joining.registry.releaseJoining(collab, session);
  if (released.ok === true && released.released === true) {
    books.joining.save();
  }
  return released;
}

function unconfirmJoiningOf(joinState, joinId) {
  const found = typeof joinId === 'string' ? booksForJoinId(joinState, joinId) : null;
  if (found === null) {
    return failureMessage('未知 joinId', { reason: 'unknown' });
  }
  const result = found.books.joining.registry.unconfirmJoining(joinId);
  if (result.ok === true && result.unconfirmed === true) {
    found.books.joining.save();
  }
  return result;
}

function pendingJoiningProjectionOf(joinState, collabId) {
  if (idOf(collabId) === null) {
    return [];
  }
  return booksOf(joinState, collabId).joining.registry.pendingJoins();
}

/* —— 形态与时限原语 —— */

function idOf(value) {
  return typeof value === 'string' && ID_PATTERN.test(value) ? value : null;
}

/* 多标识同时校验（逐项形态把关）；任一非法即 null——调用方据此整条拒绝，不做部分接受。 */
function allIdsOf(...values) {
  return values.includes(null) ? null : values;
}

function nameOf(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return isIdentityName(trimmed) ? trimmed : null;
}

/* 目标端点形态（按名解析的目标：IP 字面量与端口）——与网络层入口判据同一口径，形态不符即不发程。 */
/* 申请时限（毫秒）：准入门判据、台账剪除与站长侧待批准存活面共用同一注入值；非法 / 缺失回落缺省。 */
function ttlOf(joinState) {
  const ttlMs = joinState.state.joinRequestTtlMs;
  return Number.isFinite(ttlMs) && ttlMs >= 0 ? ttlMs : JOIN_REQUEST_TTL_MS;
}
