import { isIP } from 'node:net';
import { ID_PATTERN, MAX_REASON_CHARS, PROTOCOL_VERSION, isIdentityName, isPresentationText, newMsgId } from '../net/protocol.js';
import { createJoinApplicationsStore, createJoinsStore } from './joins.js';
import { currentManagerIdOf, isLocalArchivedState, localModeOf, localNameOf, localRosterOf, selfJoinedOf } from './local.js';
import { endpointFor, invitePayloadOf } from './outgoing.js';
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

/**
 * @param {{ state: any, send?: ((message: object) => any) | null, openViewer?: ((ref: object) => unknown) | null,
 *   log?: any, now?: () => number }} deps
 */
export function createJoinDomain({ state, send = null, openViewer = null, log = null, now = Date.now }) {
  /** @type {{ state: any, send: any, openViewer: any, log: any, now: () => number, stores: Map<string, any>, retries: Map<string, any>, knocks: Map<string, any> }} */
  const joinState = {
    state,
    send: typeof send === 'function' ? send : null,
    openViewer: typeof openViewer === 'function' ? openViewer : null,
    log: log ?? state.log,
    now: typeof now === 'function' ? now : Date.now,
    stores: new Map(),      // collabId → 加入台账（惰性构造；写前 load 刷新，并入他域写入的获准）
    retries: new Map(),     // 申请重发轮（键＝协作 ＋ 会话）
    knocks: new Map(),      // 讨论名 → 敲门登记（请求会话 ＋ 时刻：同意门落地时把席位交回请求会话）
  };
  state.joinApplications = state.joinApplications ?? createJoinApplicationsStore({ dataDir: state.dataDir, log: joinState.log });
  const domain = {
    request: (input) => requestJoin(joinState, input ?? {}),
    approve: (input) => approveJoin(joinState, input ?? {}),
    handleJoinRequest: (frame) => handleJoinRequest(joinState, frame),
    handleJoinGrant: (frame) => handleJoinGrant(joinState, frame),
    handleJoinDeny: (frame) => handleJoinDeny(joinState, frame),
    pendingJoinsOf: (collabId) => pendingJoinsOf(joinState, collabId),
    isGranted: (collabId, sessionId) => isGranted(joinState, collabId, sessionId),
    /* 讨论同意门落地后的收口（服务在邀请被批准时调用）：把敲门登记在册的请求会话接线。 */
    bindKnockedSession: (local) => bindKnockedSession(joinState, local),
  };
  /* 准入门的上限判定注入面（待批准存活面）：门只调 list() 取数、不筛不删，过期待批准由本提供方剪除。 */
  state.pendingJoinsOf = domain.pendingJoinsOf;
  return domain;
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
  const target = targetOf(input.target);
  if (target === null) {
    return knockByName(joinState, name, sessionId);
  }
  const resolved = await resolveCollabId(joinState, name, target);
  if (resolved.ok !== true) {
    return resolved;
  }
  return requestForCollab(joinState, resolved.collabId, sessionId, resolved.responder);
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
    result = await joinState.state.requestJoinResolve({ name, address: target.address, port: target.port });
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
    return { ok: false, message: `目标驿站没有名为「${name}」的协作（名称不符或该协作不在其册内）` };
  }
  const collabId = idOf(reply.collabId);
  const responder = responderOf(reply.responder, target);
  if (collabId === null || responder === null) {
    return { ok: false, message: '按名解析的应答形态不全（协作标识 / 应答者实例）——无法据以申请' };
  }
  return { ok: true, collabId, responder };
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
async function requestForCollab(joinState, collabId, sessionId, responder) {
  const local = joinState.state.collabs.get(collabId);
  if (local === undefined) {
    if (responder === null) {
      return { ok: false, message: '本机没有该协作（collabId 不存在）——先看 ws_list_collabs，或用 name + target 按名解析' };
    }
    return requestManaged(joinState, sessionId, { collabId, manager: responder });
  }
  if (isLocalArchivedState(local)) {
    return { ok: false, message: '该协作已结束（或本机已退出）——不再纳新，不能加入' };
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
  const store = storeOf(joinState, collabId);
  store.load();
  if (store.pendingJoins().some((record) => record.sessionId === sessionId)) {
    return {
      ok: true, collabId, sessionId, mode: 'managed', pending: true, local: true, idempotent: true,
      note: '本会话对该协作的申请已在本机待批准面——不重复提交（重复申请幂等）',
    };
  }
  const added = store.addPendingJoin({
    instanceId: joinState.state.self.instanceId,
    identityName: joinState.state.self.identityName,
    sessionId,
    requestedAt: joinState.now(),
  });
  if (!added) {
    return { ok: false, message: '申请条目形态不符，未入账（待批准面未生成）' };
  }
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
  pruneApplications(joinState);
  const record = findApplication(joinState, entry.plan.collabId, entry.plan.sessionId);
  if (record === null) {
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
function handleJoinGrant(joinState, frame) {
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
function handleJoinDeny(joinState, frame) {
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
 * （既有行为不变）。返回接线到的会话标识，未接线返回 null。 */
function bindKnockedSession(joinState, local) {
  if (local === undefined || localModeOf(local) !== 'forum') {
    return null;
  }
  const name = localNameOf(local);
  const registered = joinState.knocks.get(name);
  if (registered === undefined) {
    return null;
  }
  joinState.knocks.delete(name);   // 一次性登记：席位已交回，不重复接线
  if (joinState.now() - registered.at >= ttlOf(joinState) || !isIdentityName(registered.sessionId)) {
    return null;   // 登记过期（放行来得太晚）或形态坏：按未登记处置
  }
  return bindSession(joinState, { collabId: local.collabId, sessionId: registered.sessionId, origin: 'join' }) === true
    ? registered.sessionId
    : null;
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
 * 非站长机器不落（批准权不随数据副本走）；同会话重发＝就地刷新（台账按会话幂等），
 * 重发带来的新帧标识即最新回执比对键。 */
function handleJoinRequest(joinState, frame) {
  const collabId = frame.collabId;
  const local = joinState.state.collabs.get(collabId);
  if (!isJoinManager(local)) {
    joinState.log.warn('加入申请未落待批准面（本机不是该协作的站长）', { collabId, from: frame.from?.instanceId });
    return null;
  }
  const ids = joinIdsOf(frame);
  if (ids === null) {
    joinState.log.warn('加入申请形态不全（会话标识 / 来源实例缺失），未落待批准面', { collabId });
    return null;
  }
  const store = storeOf(joinState, collabId);
  store.load();
  if (!store.addPendingJoin(pendingRecordOf(joinState, frame, ids))) {
    joinState.log.warn('待批准条目形态不符，未入账', { collabId, sessionId: ids.sessionId });
    return null;
  }
  return { ok: true, action: 'join-requested', collabId, sessionId: ids.sessionId };
}

function isJoinManager(local) {
  return local !== undefined && local.role === 'manager';
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
function approveJoin(joinState, input) {
  const refusal = approveRefusalOf(joinState, input);
  if (refusal !== null) {
    return refusal;
  }
  const store = storeOf(joinState, input.collabId);
  store.load();
  const pending = matchPending(joinState, store.pendingJoins(), input.sessionId);
  if (pending === null) {
    return { ok: false, message: '该会话没有待批准的加入申请（可能已过期、已处置，或会话标识不符）' };
  }
  const plan = { collabId: input.collabId, store, pending, approvedBy: input.approvedBy, grantedAt: joinState.now() };
  return input.approve === true ? grantPending(joinState, plan) : denyPending(joinState, plan, input.reason);
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

/* 批准一并完成入席（设计 §2）：申请人机器尚未在册（不在台账名单内）＝经既有邀请通道把该机器
 * 请进来——受邀准入路径（handleInvite）负责本机协作注册与成员记录，载荷用既有构造（名单须含
 * 被邀者），并指名申请会话（点头权归它；离线时按既有的指名挂起补投）。机器已在册＝无需入席
 * （新窗口跟进照旧只由批准回执接线）。 */
function ensureApplicantSeated(joinState, plan) {
  const local = joinState.state.collabs.get(plan.collabId);
  if (localRosterOf(local).some((entry) => entry.instanceId === plan.pending.instanceId)) {
    return { ok: true, seated: true };
  }
  const target = decisionTargetOf(joinState, plan.collabId, plan.pending.instanceId);
  if (target === null) {
    return { ok: false, message: `申请人端点未知（${plan.pending.instanceId}）——先 ws_list_hosts 确认对方在线，或让申请人重新申请（入站帧会带来端点）` };
  }
  const applicant = { instanceId: plan.pending.instanceId, identityName: applicantNameOf(plan.pending) };
  const payload = { ...invitePayloadOf(local.ledger, [applicant]), targetSessionId: plan.pending.sessionId };
  const sent = sendFrameOf(joinState, { collabId: plan.collabId, target, type: 'invite', payload });
  if (sent.ok !== true) {
    return { ok: false, message: `入席邀请发送失败：${sent.reason}——未落处置，可稍后重试` };
  }
  joinState.state.counters.invitesSent++;
  return { ok: true, seated: false };
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
  const sent = sendFrameOf(joinState, { collabId: plan.collabId, target, type, payload: { reqMsgId: plan.pending.reqMsgId, ...payload } });
  return sent.ok === true ? { ok: true } : { ok: false, message: `回执发送失败：${sent.reason}——未落处置，可稍后重试` };
}

/* 直投出口（批准回合的两个动作——入席邀请与授权回执——同走直投面：同通道同命运；发送面缺位 /
 * 拒绝都如实返回原因）。 */
function sendFrameOf(joinState, { collabId, target, type, payload }) {
  if (joinState.send === null) {
    return { ok: false, reason: '直投面不可用（发送注入缺失）' };
  }
  const result = joinState.send({ collabId, to: target, type, payload });
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

/* 待批准存活面（准入门的上限判定注入面；展示面同一取数）：未知协作返空数组（不得抛）；
 * 过期待批准按申请时限剪除（剪除即落盘）。取数走本域缓存的加入台账（进程内唯一写者），
 * 不逐次读盘——门槛路径每帧一次调用，读盘会成写放大面。 */
function pendingJoinsOf(joinState, collabId) {
  if (joinState.state.collabs.get(collabId) === undefined) {
    return [];
  }
  const store = storeOf(joinState, collabId);
  const live = [];
  const expired = [];
  for (const record of store.pendingJoins()) {
    (joinState.now() - record.requestedAt < ttlOf(joinState) ? live : expired).push(record);
  }
  for (const record of expired) {
    store.removePendingJoin(record.sessionId);
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

/* 按名匹配本机 managed 在册协作：唯一命中给 {found:true, collabId, name}；无匹配 / 同名多义给
 * {found:false}（名字对不上唯一一条时，申请人无从判定该进哪一个）；已结束的实例不作命中
 * （不该把人引向必然失败的路）。讨论不在此面：讨论的加入走敲门广播（应答随带 collabId）。
 * 名字形态非法返回 null＝不应答（缺省面语义；请求形态已由发现层校验，此处只兜底）。 */
export function resolveJoinTarget(state, input) {
  const name = nameOf(input?.name);
  if (name === null) {
    return null;
  }
  const matched = [];
  for (const local of state.collabs.values()) {
    if (localModeOf(local) === 'managed' && localNameOf(local) === name && !isLocalArchivedState(local)) {
      matched.push(local.collabId);
    }
  }
  return matched.length === 1 ? { found: true, collabId: matched[0], name } : { found: false };
}

/* —— 形态与时限原语 —— */

function idOf(value) {
  return typeof value === 'string' && ID_PATTERN.test(value) ? value : null;
}

function nameOf(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return isIdentityName(trimmed) ? trimmed : null;
}

/* 目标端点形态（按名解析的目标：IP 字面量与端口）——与网络层入口判据同一口径，形态不符即不发程。 */
function targetOf(target) {
  const address = typeof target?.address === 'string' ? target.address.trim() : '';
  const port = target?.port;
  return isIP(address) !== 0 && Number.isInteger(port) && port >= 1 && port <= 65535 ? { address, port } : null;
}

/* 申请时限（毫秒）：准入门判据、台账剪除与站长侧待批准存活面共用同一注入值；非法 / 缺失回落缺省。 */
function ttlOf(joinState) {
  const ttlMs = joinState.state.joinRequestTtlMs;
  return Number.isFinite(ttlMs) && ttlMs >= 0 ? ttlMs : JOIN_REQUEST_TTL_MS;
}
