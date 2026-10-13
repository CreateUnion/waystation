import { isIP } from 'node:net';
import { isPort } from '../net/protocol.js';
import { isSnapshotShape } from './model.js';
import { currentManagerIdOf, isLocalArchivedState, localNameOf, localRosterOf, localStateOf } from './local.js';
import { ledgerDigest } from './store.js';
import { adoptNewManager, applyEndpoint, downgradeToMember, endpointFor, notifyLocal, promoteToManager, sendTo, sendToRoster } from './outgoing.js';
import { probePeer, resumeLocal, suspendLocal } from './takeover.js';

/* 显式移交（设计 §9 + §8「先确认后删除」）：管理席位携带整份台账发起 → 目标校验并回执 →
 * 旧席位收到确认后才清理本地台账并转成员 → 全体通告「驿丞已变更」。
 * 目标离线当场拒绝（应急走抢接）；无回执不删除（台账保持）；双方消息流水与日志留痕——
 * 移交方记「已移交并清理（版本号、去向机器、摘要值）」，接收方记「已接收（同上）」。 */

/* 回执等待上限（模块默认值；服务注入缝 handoverConfirmTimeoutMs 可覆盖、供测试收敛）。 */
export const HANDOVER_CONFIRM_TIMEOUT_MS = 5000;

export async function handover(state, { collabId, target }) {
  const local = state.collabs.get(collabId);
  if (local === undefined) {
    return { ok: false, message: '本机没有该协作（先 ws_list_collabs）' };
  }
  if (local.role !== 'manager') {
    return { ok: false, message: '只有管理席位可以移交' };
  }
  const preflight = await handoverPreflight(state, local, target);
  if (preflight.error !== undefined) {
    return { ok: false, message: preflight.error };
  }
  const { targetId, member, endpoint } = preflight;
  const frozen = structuredClone(local.ledger);
  /* 端点互盲修复（辅修）：offer 随带本机视角的协作端点全表——受让方逐项学习后立即可直投
   * 全部老成员，不等广播往返（均为本机已学得的可信项）。 */
  const sent = sendTo(state, collabId, targetId, endpoint, 'handover', {
    kind: 'offer',
    version: frozen.version,
    digest: ledgerDigest(frozen),
    ledger: frozen,
    endpoints: Object.fromEntries(local.endpoints),
  });
  if (sent.ok !== true) {
    return { ok: false, message: `移交提议入队失败：${sent.reason}` };
  }
  state.counters.handoverOffered++;
  /* 等待期挂起：回执到达前的任一常规写都会让「版本 + 摘要」确认面失效，造成受让方已承担、
   * 旧席位保守不删的单边孤儿——等待期拒绝一切非治理写（治理写穿透属罕见口径，登记）；
   * 截止 = 确认窗 + 在途拨号余量（accept/reject/超时/close 路径统一解挂）。 */
  suspendLocal(state, local, 'handover-pending', Date.now() + state.handoverConfirmTimeoutMs + (state.config.dialTimeoutMs ?? 0));
  const settled = await settleHandover(state, local, targetId, member);
  resumeLocal(state, local, 'handover-settled');
  return settled;
}

/* 移交前置：名单 / 端点 / 在线三项校验（任何一项不过即返回错误文案）。 */
async function handoverPreflight(state, local, target) {
  const targetId = typeof target === 'string' ? target.trim() : '';
  const rejection = handoverRejection(state, local, targetId);
  if (rejection !== null) {
    return { error: rejection };
  }
  const member = local.ledger.members.find((entry) => entry.instanceId === targetId);
  if (member === undefined || member.role === 'manager' || member.state !== 'member') {
    return { error: '目标不在可移交名单（需为已建立成员；征求同意请走邀请流程）' };
  }
  const endpoint = endpointFor(state, local, targetId);
  if (endpoint === undefined) {
    return { error: '目标端点未知——请先扫描或等对方联系后再移交' };
  }
  const probeResult = await probePeer(state, endpoint);
  if (probeResult.reachable !== true) {
    state.counters.handoverRejected++;
    return { error: '目标离线——交接要求目标在线（应急：用 ws_take_over 走抢接）' };
  }
  return { targetId, member, endpoint };
}

/* 等待回执并按结局收口（未确认 / 被拒绝 / 版本不符一律保守不删）。 */
async function settleHandover(state, local, targetId, member) {
  const answer = await waitForHandoverAnswer(state, local.collabId, targetId);
  if (answer === null) {
    state.counters.handoverTimeouts++;
    return { ok: false, message: '未收到对方确认（超时）——移交未完成：本机台账保持（先确认后删除不破）' };
  }
  if (answer.kind === 'reject') {
    state.counters.handoverRejected++;
    return { ok: false, message: `对方拒绝移交：${answer.reason ?? '未说明'}` };
  }
  const done = completeHandover(state, local, {
    version: answer.version,
    digest: answer.digest,
    managerPeer: { instanceId: targetId, identityName: member.identityName },
  });
  if (!done) {
    return { ok: false, message: '确认与当前台账版本不符（期间已有变更）——本次移交作废，可重试' };
  }
  return { ok: true, message: `移交完成：驿丞已变更为「${member.identityName}」——本机台账已清理并转协作者` };
}

function handoverRejection(state, local, targetId) {
  if (local.suspended !== null) {
    return '协作对外写已暂停（收敛等待中）——暂不可移交';
  }
  if (local.ledger.status !== 'active') {
    return '移交要求协作处于进行中（提议中可直接撤回；冻结中先裁定）';
  }
  if (targetId === '') {
    return 'target 非法：需要成员的实例标识（取自 ws_view_ledger 的名单）';
  }
  if (targetId === state.self.instanceId) {
    return '不能移交给本机';
  }
  if (typeof state.probe !== 'function') {
    return '本机未接线探测能力——无法校验目标在线，移交不可行';
  }
  return null;
}

/* 回执等待面：accept / reject 到达统一 resolve（记目标标识——来源校验用）；超时按未确认处理；
 * 服务 close 时统一解挂。 */
function waitForHandoverAnswer(state, collabId, targetId) {
  return new Promise((resolve) => {
    const held = state.pendingHandovers.get(collabId);
    if (held !== undefined) {
      clearTimeout(held.timer);
      held.resolve(null);
    }
    const timer = setTimeout(() => {
      state.pendingHandovers.delete(collabId);
      resolve(null);
    }, state.handoverConfirmTimeoutMs);
    state.pendingHandovers.set(collabId, { resolve, timer, targetId });
  });
}

/* 完成移交（确认到手之后）：先确认后删除——删除本地台账文件、转成员记录、广播「驿丞已变更」。 */
export function completeHandover(state, local, accept) {
  if (local.role !== 'manager' || local.ledger === null) {
    return false;
  }
  if (accept.version !== local.ledger.version || accept.digest !== ledgerDigest(local.ledger)) {
    state.log.warn('移交回执与当前台账不符（保守放弃：先确认后删除不破）', { collabId: local.collabId });
    return false;
  }
  const name = localNameOf(local);
  /* 端点互盲修复（主修）：新驿丞端点随「驿丞已变更」通告下发——旧驿丞与新驿丞刚直连过、
   * 端点已知；只与旧驿丞通信过的成员据此学到新驿丞端点，否则双方互盲且无自愈路径。
   * 端点未知时省略该字段（旧载荷形态不变，接收侧按可选处理）。 */
  const managerEndpoint = local.endpoints.get(accept.managerPeer.instanceId);
  state.counters.handoverCompleted++;
  state.log.info('已移交并清理（版本 / 去向 / 摘要）', {
    collabId: local.collabId,
    version: accept.version,
    to: accept.managerPeer.instanceId,
    digest: accept.digest,
  });
  downgradeToMember(state, local, accept.managerPeer, accept.version);
  const changedPayload = {
    event: 'manager-changed',
    version: accept.version,
    manager: { instanceId: accept.managerPeer.instanceId, identityName: accept.managerPeer.identityName },
  };
  if (managerEndpoint !== undefined) {
    changedPayload.endpoint = { address: managerEndpoint.address, port: managerEndpoint.port };
  }
  sendToRoster(state, local, 'notice', changedPayload);
  notifyLocal(state, local, `移交完成：协作「${name}」的驿丞已变为「${accept.managerPeer.identityName}」；本机已转协作者。`);
  return true;
}

/* 移交报文接收：offer（目标侧）/ accept（旧席位侧）/ reject（旧席位侧）。 */
export async function handleHandover(state, frame) {
  const local = state.collabs.get(frame.collabId);
  if (local === undefined) {
    return;
  }
  const payload = frame.payload;
  if (payload.kind === 'offer') {
    handleOffer(state, local, frame);
    return;
  }
  if (payload.kind === 'accept') {
    handleAccept(state, local, frame);
    return;
  }
  if (payload.kind === 'reject') {
    handleReject(state, local, frame);
  }
}

/* 受理（目标侧）：来源必须为现任驿丞；校验形态 / 摘要 / 版本自洽；通过即承担管理席位并回执。 */
function handleOffer(state, local, frame) {
  if (frame.from.instanceId !== currentManagerIdOf(local)) {
    state.counters.handoverRejected++;
    state.log.warn('移交提议来源不是现任驿丞（忽略）', { collabId: local.collabId, from: frame.from.instanceId });
    return;
  }
  const guard = offerLocalGuard(state, local);
  if (guard !== null) {
    sendHandoverReject(state, local, frame, guard);
    return;
  }
  const rejection = offerValidation(offerRecordOf(frame), frame.collabId);
  if (rejection !== null) {
    sendHandoverReject(state, local, frame, rejection);
    return;
  }
  acceptOffer(state, local, frame);
}

function offerLocalGuard(state, local) {
  if (local.role === 'manager') {
    return '本机已是驿丞';
  }
  if (isLocalArchivedState(local)) {
    return '本机该协作已归档';
  }
  if (localStateOf(local) === 'frozen') {
    return '本机该协作冻结中——请先裁定';
  }
  return null;
}

/* 受理记录成形：与快照接收同一形态与校验链（形态 → 版本自洽 → 摘要重算）。 */
function offerRecordOf(frame) {
  return {
    version: frame.payload.version,
    digest: frame.payload.digest,
    receivedAt: new Date().toISOString(),
    from: { instanceId: frame.from.instanceId, identityName: frame.from.identityName },
    ledger: frame.payload.ledger,
  };
}

function offerValidation(record, collabId) {
  if (!isSnapshotShape(record) || record.version !== record.ledger.version || record.ledger.collabId !== collabId) {
    return '台账形态或版本自洽校验不通过';
  }
  if (ledgerDigest(record.ledger) !== record.digest) {
    return '台账摘要不符';
  }
  return null;
}

/* 受理成立：承担管理席位（台账换本机为管理者 + 落盘 + 推送当前视图）并回执「已接收（版本 / 来源 / 摘要）」。 */
function acceptOffer(state, local, frame) {
  const payload = frame.payload;
  const ledger = structuredClone(payload.ledger);
  ledger.manager = { instanceId: state.self.instanceId, identityName: state.self.identityName };
  ledger.updatedAt = new Date().toISOString();
  promoteToManager(state, local, ledger);
  learnOfferedEndpoints(state, local, payload);
  state.counters.handoverAccepted++;
  state.log.info('已接收移交并承担驿丞席位（版本 / 来源 / 摘要）', {
    collabId: local.collabId,
    version: payload.version,
    from: frame.from.instanceId,
    digest: payload.digest,
  });
  const endpoint = local.endpoints.get(frame.from.instanceId);
  if (endpoint !== undefined) {
    sendTo(state, local.collabId, frame.from.instanceId, endpoint, 'handover', { kind: 'accept', version: payload.version, digest: payload.digest });
  }
  notifyLocal(state, local, `已接手驿丞席位（来自「${frame.from.identityName}」，版本 ${payload.version}）。`);
}

/* 端点互盲修复（辅修）：逐项学习旧驿丞随 offer 下发的端点全表（均为其已学得的可信项）——
 * 新驿丞立即具备直投全部老成员的寻址，不等广播往返；名单缺身份名或地址 / 端口非法项
 * 跳过并计数（留痕，不污染端点表）。 */
function learnOfferedEndpoints(state, local, payload) {
  if (payload.endpoints === undefined) {
    return;
  }
  const names = new Map(localRosterOf(local).map((entry) => [entry.instanceId, entry.identityName]));
  for (const [instanceId, endpoint] of Object.entries(payload.endpoints)) {
    const identityName = names.get(instanceId);
    if (identityName === undefined) {
      state.counters.endpointRejected++;
      state.log.warn('交接端点表含名单外实例（忽略）', { collabId: local.collabId, peer: instanceId });
      continue;
    }
    learnPayloadEndpoint(state, local, instanceId, identityName, endpoint);
  }
}

/* 治理载荷携带的端点条目：校验并学习（地址须为 IP 字面量、端口合法）——非法项留痕忽略
 * （端点属辅助面，不阻断所在帧的主语义）。 */
function learnPayloadEndpoint(state, local, instanceId, identityName, endpoint) {
  if (typeof endpoint?.address !== 'string' || isIP(endpoint.address) === 0 || !isPort(endpoint.port)) {
    state.counters.endpointRejected++;
    state.log.warn('治理载荷携带的端点非法（忽略）', { collabId: local.collabId, peer: instanceId });
    return;
  }
  applyEndpoint(state, local, { instanceId, identityName }, endpoint.address, endpoint.port);
}

function sendHandoverReject(state, local, frame, reason) {
  const endpoint = local.endpoints.get(frame.from.instanceId);
  if (endpoint === undefined) {
    return;
  }
  sendTo(state, local.collabId, frame.from.instanceId, endpoint, 'handover', { kind: 'reject', reason });
}

/* 回执到达（旧席位侧）：有等待者交给等待面统一完成（来源须为本次目标——先后向不同目标发起时
 * 防名义收口错挂）；无等待者（重启后迟到回执）就地做版本自洽校验后完成。 */
function handleAccept(state, local, frame) {
  const payload = frame.payload;
  const held = state.pendingHandovers.get(local.collabId);
  if (held !== undefined) {
    if (!isHandoverAnswerFrom(state, held, frame)) {
      return;
    }
    state.pendingHandovers.delete(local.collabId);
    clearTimeout(held.timer);
    held.resolve(payload);
    return;
  }
  completeHandover(state, local, {
    version: payload.version,
    digest: payload.digest,
    managerPeer: { instanceId: frame.from.instanceId, identityName: frame.from.identityName },
  });
}

function handleReject(state, local, frame) {
  const held = state.pendingHandovers.get(local.collabId);
  if (held !== undefined && isHandoverAnswerFrom(state, held, frame)) {
    state.pendingHandovers.delete(local.collabId);
    clearTimeout(held.timer);
    held.resolve(frame.payload);
  }
}

/* 回执来源校验：必须来自本次在途移交的目标（不符即忽略并计数——不消费等待面）。 */
function isHandoverAnswerFrom(state, held, frame) {
  if (held.targetId === frame.from.instanceId) {
    return true;
  }
  state.counters.eventMismatch++;
  state.log.warn('移交回执来源与本次目标不符（忽略）', { from: frame.from.instanceId, target: held.targetId });
  return false;
}

/* 「驿丞已变更」通告（成员侧）：来源须为本地记录的现任驿丞（旧席位广播），随后更新引用。 */
export async function handleManagerChanged(state, frame) {
  const local = state.collabs.get(frame.collabId);
  if (local === undefined) {
    return;
  }
  if (local.role === 'manager') {
    state.counters.eventMismatch++;
    state.log.warn('管理席位收到驿丞变更通告（忽略）', { collabId: local.collabId });
    return;
  }
  if (frame.from.instanceId !== currentManagerIdOf(local)) {
    state.counters.eventMismatch++;
    state.log.warn('驿丞变更通告来源与本地记录不符（忽略）', { collabId: local.collabId, from: frame.from.instanceId });
    return;
  }
  adoptNewManager(state, local, frame.payload.manager, frame.payload.version);
  /* 端点互盲修复（主修接收侧）：通告携带的新驿丞端点（可选字段）在采纳后立即学习——
   * 成员由此不再与现任驿丞互盲（端点学得即触发陈旧队列重定向，探测 / 握手 / 消息路径同时可达）。 */
  if (frame.payload.endpoint !== undefined) {
    learnPayloadEndpoint(state, local, frame.payload.manager.instanceId, frame.payload.manager.identityName, frame.payload.endpoint);
  }
}
