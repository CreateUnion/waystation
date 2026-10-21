import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import {
  COLLAB_CAPABILITY, ID_PATTERN, MAX_ACTIVE_SEATS, MAX_REASON_CHARS, MAX_TOPIC_CHARS, PROTOCOL_VERSION,
  isIdentityName, isPresentationText, newMsgId,
} from '../net/protocol.js';
import {
  createInvitesFileStore, createJoiningFileStore, createJoinApplicationsStore, createJoinsStore, createPendingInvitesFileStore,
} from './joins.js';
import { joinDenyReasonOf } from './invites.js';
import {
  currentManagerIdOf, isLocalArchivedState, listLocalSeatsOf, localModeOf, localNameOf, localRosterOf, localSeatOfLocal,
  localStateOf, localTopicOf, managerSeatOfLocal, removeLocalSeat, seatsOfLocal, selfJoinedOf, upsertLocalSeat,
} from './local.js';
import { LOCAL_LEFT_STATE } from './model.js';
import { endpointFor, invitePayloadOf, mutateLedger } from './outgoing.js';
import { ledgerDigest } from './store.js';
import { shortSessionId } from '../util/short-id.js';

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
   *   pendingRequests: Map<string, Map<string, any>>, joinInvites: Map<string, any>, seatNames: Map<string, string> }} */
  const joinState = {
    state,
    send: typeof send === 'function' ? send : null,
    openViewer: typeof openViewer === 'function' ? openViewer : null,
    log: log ?? state.log,
    now: typeof now === 'function' ? now : Date.now,
    stores: new Map(),      // collabId → 加入台账（惰性构造；写前 load 刷新，并入他域写入的获准）
    retries: new Map(),     // 申请重发轮（键＝协作 ＋ 会话）
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
    bindKnockedSession: (local) => bindKnockedSession(joinState, local),
    /* —— 0.2.0 会话级邀请与两段式入席（契约 M4 → M5/M6） —— */
    ...sessionJoinApiOf(joinState),
  };
  /* 准入门的上限判定注入面（待批准存活面）：门只调 list() 取数、不筛不删，过期待批准由本提供方剪除。 */
  state.pendingJoinsOf = domain.pendingJoinsOf;
  return domain;
}

function sessionJoinApiOf(joinState) {
  return {
    createInvite: (input) => createInviteOf(joinState, input ?? {}),
    acceptInvite: (input) => acceptInviteOf(joinState, input ?? {}),
    requestJoin: (input) => requestJoinOf(joinState, input ?? {}),
    approveJoin: (input) => approveJoinOf(joinState, input ?? {}),
    confirmJoining: (joinId, sessionId, input) => confirmJoiningOf(joinState, joinId, sessionId, input ?? {}),
    withdrawInvite: (input) => withdrawInviteOf(joinState, input ?? {}),
    registerPendingInvite: (input) => registerPendingInviteOf(joinState, input ?? {}),
    handleInviteFrame: (frame) => handleInviteFrameOf(joinState, frame),
    handleInviteApproval: (frame) => handleInviteApprovalOf(joinState, frame),
    handleJoinConfirm: (frame) => handleJoinConfirmOf(joinState, frame),
    releaseJoining: (collabId, sessionId) => releaseJoiningOf(joinState, collabId, sessionId),
    unconfirmJoining: (joinId) => unconfirmJoiningOf(joinState, joinId),
    pendingJoiningProjection: (collabId) => pendingJoiningProjectionOf(joinState, collabId),
    pendingInvitesFor: (input) => pendingInvitesForOf(joinState, input ?? {}),
    expireJoining: (at) => expireJoiningOf(joinState, at),
    expirePendingInvites: (at) => expirePendingInvitesOf(joinState, at),
    invalidateForManagerChange: (managerTerm) => invalidateForManagerChangeOf(joinState, managerTerm),
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
  return {
    ok: true, collabId, sessionId, mode: 'managed', pending: true, local: true,
    note: '本机是该协作的站长——申请已进本机待批准面（本机任意会话可批；批准即接线本会话）',
  };
}

/* 直投申请帧（设计 §2：有 collabId 的申请直投站长）：发送面返回的帧标识即申请记录的回执比对键
 * （回执携它命中本机唯一的申请记录）。 */
function dispatchJoinRequest(joinState, plan) {
  const result = sendJoinRequestOf(joinState, plan);
  if (result.ok !== true) {
    return { ok: false, message: `加入申请发送失败：${result.reason}——稍后重试` };
  }
  joinState.state.joinApplications.add({
    collabId: plan.collabId,
    sessionId: plan.sessionId,
    managerInstanceId: plan.manager.instanceId,
    msgId: result.msgId,
    sentAt: plan.sentAt,
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

/* 批准回执（设计 §2）：写本机获准台账 → 写绑定（origin:grant——离线会话＝持久映射、重开即活）
 * → 删申请记录 → 开该协作页（「进入即见」）。授权对象＝回执携的会话，须与命中记录一致
 * （准入门不比对会话标识，这一步在本域补：不一致的回执不得改他会话的绑定）。
 * 获准入账被拒即整条回执不落地（不接线、不删申请记录：杜绝「已接线未获准」）。 */
function handleJoinGrantLegacy(joinState, frame) {
  const record = matchGrantedApplication(joinState, frame);
  if (record === null) {
    return null;
  }
  const written = writeApproval(joinState, {
    collabId: record.collabId,
    instanceId: joinState.state.self.instanceId,
    sessionId: record.sessionId,
    origin: 'grant',
    grantedAt: joinState.now(),
    approvedBy: approverOf(frame?.from),
  });
  if (written !== true) {
    joinState.log.warn('获准条目形态不符，回执未落地（不接线、申请记录保留）', { collabId: record.collabId, sessionId: record.sessionId });
    return null;
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

/* 批准人（获准台账的 approvedBy）：join-grant 不携该字段，取回执帧的来处——身份名优先（人读面），
 * 缺失退回实例标识（两者同过身份名白名单）。 */
function approverOf(from) {
  return isIdentityName(from?.identityName) ? from.identityName : idOf(from?.instanceId);
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

function openCollabView(joinState, collabId) {
  if (joinState.openViewer !== null) {
    joinState.openViewer({ root: MAIN_VIEWER_ROOT, id: collabId });
  }
}

/* 获准入账（设计 §7）：写前 load 刷新——同一份台账另有两个获准写入点（创建 / 同意邀请），
 * 就地写回会用陈旧内存覆盖他域刚写的获准名单。 */
function writeApproval(joinState, approval) {
  const store = storeOf(joinState, approval.collabId);
  store.load();
  const written = store.addApproval({
    instanceId: approval.instanceId,
    sessionId: approval.sessionId,
    origin: approval.origin,
    grantedAt: approval.grantedAt,
    approvedBy: approval.approvedBy,
  });
  if (!written) {
    joinState.log.warn('获准条目形态不符，未入账（该会话未获准）', { collabId: approval.collabId, sessionId: approval.sessionId });
  }
  return written;
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
  if (selfJoinedOf(local, joinState.state.self.instanceId)) {
    if (bindSession(joinState, { collabId: local.collabId, sessionId, origin: 'join' }) !== true) {
      return { ok: false, message: '接线未落地（绑定表不可用）——本会话收不到该讨论的注入' };
    }
    return { ok: true, collabId: local.collabId, sessionId, mode: 'forum', bound: true, note: '讨论在席＝本机接线立即（无批准门）——本会话开始接收该讨论的注入' };
  }
  return knockByName(joinState, localNameOf(local), sessionId);
}

async function knockByName(joinState, name, sessionId) {
  const knocked = await knockOf(joinState, name);
  if (knocked.ok !== true) {
    return knocked;
  }
  rememberKnock(joinState, name, sessionId);
  return { ok: true, mode: 'forum', sessionId, knocked: true, replies: knocked.replies, note: knockNoteOf(knocked.replies) };
}

/* 敲门登记（设计 §4 的「加入后本会话接线」）：请求会话 ↔ 讨论名——放行者与请求会话未必同一个
 * （敲门不指名，放行后的邀请广播给全部活跃会话），登记让同意门落地时把席位交回请求会话。
 * 同名后敲者覆盖先敲者（一个讨论只留最新的请求会话），登记按申请时限过期（放行来晚了不再接线）。 */
function rememberKnock(joinState, name, sessionId) {
  joinState.knocks.set(name, { sessionId, at: joinState.now() });
}

/* 同意门落地后的收口（服务在讨论邀请被批准时调用）：该讨论名登记在册的请求会话接线——放行者
 * 若恰是请求会话，同意门的写点已接线（此处幂等重写）；登记不存在 / 已过期 / 服务面缺位一律不动
 * （既有行为不变）。登记在**接线成功之后**才清除：瞬态不可用（绑定表缺位 / 写盘失败）不丢登记，
 * 待下次落地重试。返回接线到的会话标识，未接线返回 null。 */
function bindKnockedSession(joinState, local) {
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
  if (bindSession(joinState, { collabId: local.collabId, sessionId: registered.sessionId, origin: 'join' }) !== true) {
    return null;   // 接线未落地：登记保留（本会话待下次落地接线）
  }
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
 * 远端申请人＝补入席（未在册时）＋投回执＋落批准记录。获准入账被拒一律不接线。 */
function grantPending(joinState, plan) {
  return plan.pending.instanceId === joinState.state.self.instanceId
    ? completeLocalGrant(joinState, plan)
    : completeRemoteGrant(joinState, plan);
}

function completeLocalGrant(joinState, plan) {
  if (writeApproval(joinState, approvalOf(plan, plan.pending.instanceId)) !== true) {
    return { ok: false, message: '获准条目形态不符，未入账（未接线）——待批准面保留，可重试' };
  }
  plan.store.removePendingJoin(plan.pending.sessionId);
  finishGranted(joinState, { collabId: plan.collabId, sessionId: plan.pending.sessionId });
  return { ok: true, collabId: plan.collabId, sessionId: plan.pending.sessionId, local: true, bound: true };
}

/* 远端申请人：先补入席（申请人机器尚未在册时）、再投授权回执、最后落批准记录——回执 / 邀请发不
 * 出去都按「未处置」收口（待批准面保留，可重试），获准入账失败同样不接线。 */
function completeRemoteGrant(joinState, plan) {
  const seated = ensureApplicantSeated(joinState, plan);
  if (seated.ok !== true) {
    return seated;
  }
  const sent = sendPendingDecision(joinState, plan, 'join-grant', { sessionId: plan.pending.sessionId });
  if (sent.ok !== true) {
    return sent;
  }
  if (writeApproval(joinState, approvalOf(plan, plan.pending.instanceId)) !== true) {
    return { ok: false, message: '获准条目形态不符，未入账（未接线）——待批准面保留，可重试' };
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
        identityName: applicantNameOf(pending),
        role: 'member',
        state: 'invited',
        joinedAt: new Date(joinState.now()).toISOString(),
      });
      return;
    }
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

function approvalOf(plan, instanceId) {
  return {
    collabId: plan.collabId,
    instanceId,
    sessionId: plan.pending.sessionId,
    origin: 'grant',
    grantedAt: plan.grantedAt,
    approvedBy: plan.approvedBy,
  };
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
function pendingJoinsOf(joinState, collabId) {
  if (joinState.state.collabs.get(collabId) === undefined) {
    return [];
  }
  const live = [];
  for (const record of storeOf(joinState, collabId).pendingJoins()) {
    if (typeof record.joinId === 'string' || joinState.now() - record.requestedAt >= ttlOf(joinState)) {
      continue;
    }
    live.push(record);
  }
  for (const record of (joinState.pendingRequests.get(collabId) ?? new Map()).values()) {
    if (!live.some((held) => held.instanceId === record.instanceId && held.sessionId === record.sessionId)) {
      live.push({ ...record });
    }
  }
  return live;
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
const SHORT_SESSION_CODE_CHARS = 8;

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
    if (isRosterMember(joinState, local, record.instanceId, record.sessionId)) {
      books.joining.registry.releaseJoining(collabId, record.sessionId);
      changed = true;
    }
  }
  if (changed) {
    books.joining.save();
  }
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

/* 名单已含本席（崩溃重放 / 重复 confirm 的短路判据）：只认活跃席位，不看本地席位缓存。 */
function isRosterMember(joinState, local, instanceId, sessionId) {
  if (local === undefined || idOf(instanceId) === null || idOf(sessionId) === null) {
    return false;
  }
  const rows = rosterRowsOf(local);
  if (rows.some((row) => row.instanceId === instanceId && row.sessionId === sessionId && row.state === 'member')) {
    return true;
  }
  const seat = localSeatOfLocal(local, sessionId);
  return instanceId === joinState.state.self.instanceId && seat !== null && seat.state === 'member';
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

/* 席位直投：本机目标走 M2 旁路；远端一帧（toSessions 指名要投的会话）。
 * 本机注入面是异步的，这里只拿到「已排入」——失败计数由 M2 侧负责，主链不阻塞。 */
function sendSeatFrame(joinState, { collabId, instanceId, sessionId, type, payload, fromSessionId }) {
  if (instanceId !== joinState.state.self.instanceId) {
    return sendRemoteSeatFrame(joinState, { collabId, instanceId, sessionId, type, payload, fromSessionId });
  }
  return sessionId === undefined
    ? injectLocalBroadcast(joinState, { collabId, type, payload, fromSessionId })
    : injectSeatFrame(joinState, { collabId, sessionId, type, payload, fromSessionId });
}

/* 不指名邀请投本机时按活跃会话逐个注入（设计 §4.3：投目标机当前全部已注册会话）。 */
function injectLocalBroadcast(joinState, { collabId, type, payload, fromSessionId }) {
  const local = joinState.state.collabs.get(collabId);
  const sessions = (typeof joinState.state.listLocalSeats === 'function'
    ? joinState.state.listLocalSeats(collabId)
    : (local === undefined ? [] : listLocalSeatsOf(local)))
    .filter((seat) => seat.state === 'member' && seat.sessionId !== fromSessionId);
  if (sessions.length === 0) {
    return { ok: false, reason: '本机没有可投递的活跃会话' };
  }
  const results = sessions.map((seat) => injectSeatFrame(joinState, { collabId, sessionId: seat.sessionId, type, payload, fromSessionId }));
  return { ok: results.some((entry) => entry.ok === true), local: true, results };
}

function sendRemoteSeatFrame(joinState, { collabId, instanceId, sessionId, type, payload, fromSessionId }) {
  const local = joinState.state.collabs.get(collabId);
  const endpoint = local === undefined ? undefined : endpointFor(joinState.state, local, instanceId);
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

function injectSeatFrame(joinState, { collabId, sessionId, type, payload, fromSessionId }) {
  const inject = joinState.state.injectLocalSeat;
  if (typeof inject !== 'function') {
    return { ok: false, reason: '本机注入面未接线（M2 injectLocalSeat 缺失）' };
  }
  if (idOf(sessionId) === null) {
    return { ok: false, reason: '本机目标缺少会话标识' };
  }
  const frame = {
    v: PROTOCOL_VERSION,
    cap: COLLAB_CAPABILITY,
    msgId: newMsgId(),
    type,
    collabId,
    from: { ...joinState.state.self, sessionId: fromSessionId },
    ts: new Date(joinState.now()).toISOString(),
    payload,
  };
  return injectFrameNow(joinState, inject, { collabId, sessionId, type }, frame);
}

function injectFrameNow(joinState, inject, { collabId, sessionId, type }, frame) {
  let result;
  try {
    result = inject(collabId, sessionId, frame);
  } catch (error) {
    return { ok: false, reason: error?.message ?? '本机注入异常' };
  }
  return resolveInjectionOf(joinState, result, { collabId, sessionId, type });
}

function resolveInjectionOf(joinState, result, { collabId, sessionId, type }) {
  if (isThenable(result)) {
    result.catch((error) => joinState.log.warn('本机席位注入失败（已计数）', { collabId, sessionId, type, reason: error?.message }));
    return { ok: true, local: true, scheduled: true };
  }
  return result?.ok === true ? { ok: true, local: true, result } : { ok: false, reason: result?.reason ?? '目标会话不可注入' };
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

function createInviteOf(joinState, input) {
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
  const sent = sendSeatFrame(joinState, {
    collabId: ids.collabId, instanceId: target.instanceId, sessionId: target.targetSessionId,
    type: 'invite', payload, fromSessionId: ids.managerSessionId,
  });
  if (sent.ok !== true) {
    books.invites.book.withdrawInvite(opened.inviteId);
    books.invites.save();
    return failureMessage(`邀请发送失败：${sent.reason}——未留下未投递的邀请记录`);
  }
  return { ok: true, inviteId: opened.inviteId, expiresAt: opened.expiresAt, target, delivery: sent };
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
  if (localModeOf(local) === 'forum') {
    return failureMessage('讨论无邀请簿记：forum 不生成、不返回 inviteId（设计 D18）', { code: 'forum-no-invite' });
  }
  if (!isManagerSession(joinState, local, ids.managerSessionId)) {
    return failureMessage('只有站长会话可以邀请成员');
  }
  if (!isIdentityName(localNameOf(local)) || !isPresentationText(localTopicOf(local), MAX_TOPIC_CHARS)) {
    return failureMessage('本地记录缺协作名或主题（协议面无法组出合法邀请）——待元状态补齐后重试');
  }
  if (activeSeatsCount(joinState, local, null) >= MAX_ACTIVE_SEATS) {
    return failureMessage(`协作活跃席位已达上限（${MAX_ACTIVE_SEATS}）——不再发起新邀请`);
  }
  const target = inviteTargetOf(input);
  return target === null
    ? failureMessage('邀请目标非法：需要 targetInstanceId 与可选的 targetSessionId')
    : { ok: true, ids, local, target };
}

function acceptInviteOf(joinState, input) {
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
    return alreadyAcceptedInviteOf(books, { collabId, inviteId, sessionId });
  }
  const manager = visible[0].fromManager;
  if (manager.instanceId === joinState.state.self.instanceId && isManagerSession(joinState, local, manager.sessionId)) {
    return acceptLocalInviteOf(joinState, { collabId, inviteId, sessionId, manager, books });
  }
  return acceptRemoteInviteOf(joinState, { collabId, inviteId, sessionId, manager, books });
}

/* 同会话重复接受＝幂等成功（不产生第二席）；记录已被接受后 matchPending 不再冒泡，这里补回判据。 */
function alreadyAcceptedInviteOf(books, { collabId, inviteId, sessionId }) {
  const record = books.pending.store.get({ collabId, inviteId });
  return record !== null && record.acceptedSessions.includes(sessionId)
    ? { ok: true, accepted: true, idempotent: true, inviteId }
    : failureMessage('邀请不存在、已过期或不属于本会话');
}

function acceptInviteIdsOf(input) {
  const collabId = idOf(input.collabId);
  const inviteId = idOf(input.inviteId);
  const sessionId = idOf(input.sessionId);
  return collabId === null || inviteId === null || sessionId === null
    ? failureMessage('参数非法：需要 collabId、inviteId 与会话标识')
    : { ok: true, collabId, inviteId, sessionId };
}

function acceptRemoteInviteOf(joinState, { collabId, inviteId, sessionId, manager, books }) {
  rememberInviteAcceptanceOf(joinState, { collabId, sessionId, managerInstanceId: manager.instanceId });
  const sent = sendSeatFrame(joinState, {
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

function acceptLocalInviteOf(joinState, { collabId, inviteId, sessionId, manager, books }) {
  const consumed = books.pending.store.consumeForSession({ collabId, inviteId, sessionId, declined: false, now: joinState.now() });
  if (consumed.ok !== true) {
    return failureMessage(`邀请已不可接受：${consumed.reason}`, { reason: consumed.reason });
  }
  books.pending.save();
  rememberInviteAcceptanceOf(joinState, { collabId, sessionId, managerInstanceId: joinState.state.self.instanceId });
  const approved = approveInviteForSeat(joinState, {
    collabId, inviteId, instanceId: joinState.state.self.instanceId, sessionId, managerSessionId: manager.sessionId,
    identityName: joinState.state.self.identityName,
  });
  return approved.ok === true ? { ...approved, accepted: true, inviteId } : approved;
}

function approveInviteForSeat(joinState, input) {
  const local = joinState.state.collabs.get(input.collabId);
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
  if (isRosterMember(joinState, local, input.instanceId, input.sessionId)) {
    return { ok: true, member: true, alreadyMember: true, inviteId: input.inviteId };
  }
  const existing = books.joining.registry.find(input.collabId, input.sessionId);
  if (existing !== null) {
    return existing.instanceId === input.instanceId
      ? grantSeatOf(joinState, local, books, existing, input.managerSessionId, input.inviteId)
      : failureMessage('同一会话已有其他实例的在途 grant——拒绝覆盖（instance-mismatch）', { reason: 'instance-mismatch' });
  }
  const begun = beginSeatJoiningOf(joinState, local, books, {
    collabId: input.collabId, instanceId: input.instanceId, sessionId: input.sessionId,
    managerSessionId: input.managerSessionId, inviteId: input.inviteId, identityName: input.identityName,
  });
  if (begun.ok !== true) {
    return begun;
  }
  return grantSeatOf(joinState, local, books, /** @type {any} */ (begun).record, input.managerSessionId, input.inviteId);
}

function beginSeatJoiningOf(joinState, local, books, input) {
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
function beginJoiningFailureOf(joinState, local, input, begun) {
  if (begun.reason === 'capacity') {
    sendJoinDenyOf(joinState, local, input, denialJoinIdOf(), 'capacity');
    forgetPendingRequestOf(joinState, input.collabId, input);
    return failureMessage(`活跃席位已满（${MAX_ACTIVE_SEATS}）——已回 join-deny(capacity)`, { reason: 'capacity' });
  }
  if (begun.reason === 'instance-mismatch') {
    return failureMessage('同一会话已有其他实例的在途 grant——拒绝覆盖（instance-mismatch）', { reason: begun.reason });
  }
  return failureMessage('在途入席记录写入失败（参数非法）', { reason: begun.reason });
}

function grantSeatOf(joinState, local, books, record, managerSessionId, inviteId) {
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
  const sent = sendSeatFrame(joinState, {
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
  return { ok: true, joining: true, joinId: record.joinId, inviteId: inviteId ?? null, delivery: sent };
}

function denialJoinIdOf() {
  return `join-deny-${randomUUID()}`;
}

function sendJoinDenyOf(joinState, local, seat, joinId, reason, managerTerm = undefined) {
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

function approveJoinOf(joinState, input) {
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
    return isRosterMember(joinState, local, joinState.state.self.instanceId, wanted)
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
  if (!isManagerSession(joinState, local, managerSessionId)) {
    return failureMessage('本机不是该协作的站长会话（无批准权）——批准权不随数据副本走');
  }
  return { ok: true, local, managerSessionId, wanted };
}

function grantPendingRequestOf(joinState, local, request, managerSessionId, rawInviteId) {
  const inviteId = rawInviteId === undefined || rawInviteId === null ? null : idOf(rawInviteId);
  if (rawInviteId !== undefined && rawInviteId !== null && inviteId === null) {
    return failureMessage('inviteId 形态非法');
  }
  const result = inviteId === null
    ? beginAndGrantPendingOf(joinState, local, request, managerSessionId)
    : approveInviteForSeat(joinState, { ...request, collabId: local.collabId, inviteId, managerSessionId });
  if (result.ok === true) {
    forgetPendingRequestOf(joinState, local.collabId, request);
  }
  return result;
}

function beginAndGrantPendingOf(joinState, local, request, managerSessionId) {
  const books = booksOf(joinState, local.collabId);
  if (isRosterMember(joinState, local, request.instanceId, request.sessionId)) {
    return { ok: true, member: true, alreadyMember: true, sessionId: request.sessionId };
  }
  const existing = books.joining.registry.find(local.collabId, request.sessionId);
  if (existing !== null) {
    return existing.instanceId === request.instanceId
      ? grantSeatOf(joinState, local, books, existing, managerSessionId, null)
      : failureMessage('同一会话已有其他实例的在途 grant——拒绝覆盖（instance-mismatch）', { reason: 'instance-mismatch' });
  }
  const begun = beginSeatJoiningOf(joinState, local, books, {
    collabId: local.collabId, instanceId: request.instanceId, sessionId: request.sessionId,
    managerSessionId, inviteId: undefined, identityName: request.identityName,
  });
  if (begun.ok !== true) {
    return begun;
  }
  return grantSeatOf(joinState, local, books, /** @type {any} */ (begun).record, managerSessionId, null);
}

function rejectPendingRequestOf(joinState, local, request, reason) {
  const validated = validateReason(reason);
  if (validated.ok !== true) {
    return failureMessage(validated.message);
  }
  const sent = sendJoinDenyOf(joinState, local, request, denialJoinIdOf(), 'aborted', managerTermOf(local));
  if (sent.ok !== true) {
    return failureMessage(`拒绝回执发送失败：${sent.reason}——未落处置，可稍后重试`);
  }
  forgetPendingRequestOf(joinState, local.collabId, request);
  return { ok: true, denied: true, sessionId: request.sessionId, reason: validated.reason ?? null };
}

function findPendingRequestOf(joinState, collabId, wanted) {
  const candidates = pendingRequestsOf(joinState, collabId);
  const exact = candidates.filter((record) => record.sessionId === wanted);
  if (exact.length > 0) {
    return exact.length === 1 ? { record: exact[0], ambiguous: false } : { record: null, ambiguous: true };
  }
  const short = candidates.filter((record) => record.sessionId.slice(0, SHORT_SESSION_CODE_CHARS) === wanted);
  if (short.length > 1) {
    return { record: null, ambiguous: true };
  }
  return { record: short[0] ?? null, ambiguous: false };
}

/* 待批准面：内存请求（0.2.0 写点）∪ 旧台账未过期条目（读侧兼容）；按 (instanceId,sessionId) 去重。 */
function pendingRequestsOf(joinState, collabId) {
  const merged = new Map();
  for (const record of (joinState.pendingRequests.get(collabId) ?? new Map()).values()) {
    merged.set(`${record.instanceId}\u0000${record.sessionId}`, { ...record });
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
  const confirmed = found.books.joining.registry.confirmJoining(joinId, sessionId, /** @type {any} */ (prepared).confirmInput);
  if (confirmed.ok !== true) {
    return confirmFailureOf(found, confirmed);
  }
  return finishConfirmOf(joinState, found, sessionId, prepared, joinId);
}

function confirmPreparedOf(joinState, found, sessionId, input) {
  const local = joinState.state.collabs.get(found.collabId);
  const instanceId = idOf(input.instanceId);
  if (instanceId === null || idOf(sessionId) === null) {
    return failureMessage('参数非法：需要 instanceId 与会话标识', { reason: 'invalid' });
  }
  const alreadyMember = input.alreadyMember === true || isRosterMember(joinState, local, instanceId, sessionId);
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
    return failureMessage('共享名单写入失败——在途 grant 已回滚为未确认，可重试', { reason: 'roster-write-failed' });
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
  }, { persist: true, dataDir: joinState.state.dataDir });
}

function handleJoinConfirmOf(joinState, frame) {
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

function applyJoinConfirmOf(joinState, context, found) {
  const { local, joinId, seat } = context;
  if (found.record.instanceId !== seat.instanceId || found.record.sessionId !== seat.sessionId) {
    sendJoinDenyOf(joinState, local, seat, joinId, 'aborted', found.record.managerTerm);
    return { ok: true, action: 'join-denied', joinId, reason: 'session-mismatch' };
  }
  const result = confirmJoiningOf(joinState, joinId, seat.sessionId, {
    instanceId: seat.instanceId, managerTerm: context.managerTerm,
    alreadyMember: isRosterMember(joinState, local, seat.instanceId, seat.sessionId),
  });
  if (result.ok !== true) {
    return confirmDeniedOf(joinState, local, found, joinId, seat, result);
  }
  sendSnapshotToSeatOf(joinState, local, seat);
  return { ok: true, action: 'join-confirmed', joinId, alreadyMember: /** @type {any} */ (result).alreadyMember === true };
}

function confirmUnknownJoinOf(joinState, local, joinId, seat) {
  if (isRosterMember(joinState, local, seat.instanceId, seat.sessionId)) {
    sendSnapshotToSeatOf(joinState, local, seat);
    return { ok: true, action: 'join-confirmed', joinId, alreadyMember: true };
  }
  sendJoinDenyOf(joinState, local, seat, joinId, 'aborted');
  return { ok: true, action: 'join-denied', joinId, reason: 'unknown' };
}

function confirmDeniedOf(joinState, local, found, joinId, seat, result) {
  if (result.reason === 'roster-write-failed') {
    return { ok: false, action: 'join-retry', joinId, reason: result.reason, message: result.message };
  }
  sendJoinDenyOf(joinState, local, seat, joinId, result.reason, found.record.managerTerm);
  return { ok: true, action: 'join-denied', joinId, reason: result.reason };
}

function sendSnapshotToSeatOf(joinState, local, seat) {
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

function handleJoinGrantOf(joinState, frame) {
  const context = joinGrantContextOf(joinState, frame);
  if (context === null) {
    return null;
  }
  const local = joinState.state.collabs.get(context.collabId);
  if (local === undefined) {
    return { ok: false, action: 'join-failed', reason: 'unknown-collab' };
  }
  const application = matchSessionApplicationOf(joinState, frame, context.collabId, context.managerInstanceId);
  if (application === null) {
    return resendConfirmForGrantOf(joinState, local, context, frame);
  }
  return beginLocalJoiningOf(joinState, local, application, context.joinId, frame.payload);
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
function resendConfirmForGrantOf(joinState, local, context, frame) {
  const sessionId = idOf(frame?.payload?.sessionId);
  const seat = sessionId === null ? null : localSeatOfLocal(local, sessionId);
  if (seat === null || seat.joinId !== context.joinId) {
    joinState.log.warn('join-grant 与本机申请台账不匹配（忽略）', { collabId: context.collabId, msgId: frame.msgId });
    return null;
  }
  const sent = sendSeatFrame(joinState, {
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

function beginLocalJoiningOf(joinState, local, application, joinId, payload) {
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
  }, { persist: true, dataDir: joinState.state.dataDir });
  clearApplications(joinState, application.collabId, application.sessionId);
  const sent = sendSeatFrame(joinState, {
    collabId: application.collabId,
    instanceId: application.managerInstanceId,
    sessionId: payload.manager.sessionId,
    type: 'join-confirm',
    payload: { joinId, managerTerm: payload.managerTerm, version: payload.version },
    fromSessionId: application.sessionId,
  });
  if (sent.ok !== true) {
    removeLocalSeat(local, application.sessionId, { persist: true, dataDir: joinState.state.dataDir });
    return { ok: false, action: 'join-failed', reason: sent.reason };
  }
  /* 发出 confirm 后立即转 member(unverified)：可接收注入、禁止发消息；收到含本席快照后由
   * 快照消费面清除 unverified；回执失败时按同一 joinId 回滚。 */
  upsertLocalSeat(local, {
    state: 'member',
    unverified: true,
  }, { persist: true, dataDir: joinState.state.dataDir });
  return { ok: true, action: 'joining', joinId, sessionId: application.sessionId, unverified: true };
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
  const withdrawn = books.invites.book.withdrawInvite(inviteId);
  if (withdrawn.ok !== true) {
    return failureMessage(`邀请不可撤回：${withdrawn.reason}`, { reason: withdrawn.reason });
  }
  books.invites.save();
  return { ok: true, inviteId, withdrawn: true, idempotent: withdrawn.idempotent === true };
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
  books.pending.save();
  return { ok: true, inviteId, duplicate: applied.duplicate === true, expiresAt };
}

function handleInviteFrameOf(joinState, frame) {
  const inviteId = idOf(frame?.payload?.inviteId);
  if (inviteId === null) {
    return { ok: true, ignored: 'forum-no-invite' };
  }
  const managerSessionId = idOf(frame?.from?.sessionId);
  if (managerSessionId === null) {
    return failureMessage('邀请帧缺少 from.sessionId');
  }
  return registerPendingInviteOf(joinState, {
    collabId: frame.collabId,
    inviteId,
    fromManager: { instanceId: frame.from.instanceId, sessionId: managerSessionId },
    targetSessionId: frame.payload?.targetSessionId,
    now: joinState.now(),
  });
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

/* 站长侧收到受邀会话的 approve（M5 消费面在 approve 携 inviteId 时转交本域）。 */
function handleInviteApprovalOf(joinState, frame) {
  const context = inviteApprovalContextOf(joinState, frame);
  if (context === null) {
    return null;
  }
  const { local, collabId, inviteId, instanceId, sessionId } = context;
  const managerSessionId = managerSessionOf(joinState, local);
  if (managerSessionId === null) {
    return failureMessage('站长席位未知——无法签发 join-grant');
  }
  return approveInviteForSeat(joinState, {
    collabId, inviteId, instanceId, sessionId, managerSessionId,
    identityName: isIdentityName(frame.from.identityName) ? frame.from.identityName : instanceId,
  });
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
  const collabIds = new Set([...joinState.books.keys(), ...joinState.state.collabs.keys()]);
  return [...collabIds].map((collabId) => [collabId, booksOf(joinState, collabId)]);
}

function expireJoiningOf(joinState, at) {
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
        sendJoinDenyOf(joinState, local, record, record.joinId, 'expired', record.managerTerm);
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

function invalidateForManagerChangeOf(joinState, managerTerm) {
  let aborted = 0;
  for (const [collabId, books] of allBooksOf(joinState)) {
    const local = joinState.state.collabs.get(collabId);
    const result = books.joining.registry.invalidateForManagerChange(managerTerm);
    if (result.ok !== true || result.aborted.length === 0) {
      continue;
    }
    books.joining.save();
    aborted += result.aborted.length;
    for (const record of result.abortedRecords) {
      if (local !== undefined) {
        sendJoinDenyOf(joinState, local, record, record.joinId, 'manager-changed', record.managerTerm);
      }
    }
  }
  return { aborted };
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
