import { MAX_ACTIVE_SEATS } from '../net/protocol.js';
import { MAX_BOARD_ENTRIES, canTransition, isLedgerShape } from './model.js';
import { archiveLocalSeatsOfState, inferredFrozenFrom, isLocalArchivedState, localNameOf, localRosterOf, localStateOf, managerSeatOfLocal, persistLedger, persistMember, persistSnapshot } from './local.js';
import { forgetMuteBaselinesOfCollab } from './mute.js';
import { ledgerDigest } from './store.js';
import { managerFreezeReasonOf, matchConflictCollabs, noteForumGovernanceIgnored } from './gate.js';
import { endpointFor, governanceTargets, invitePayloadOf, mutateLedger, notifyLocal, relayGovernance, sendTo, sendToRoster } from './outgoing.js';

/* 冻结裁定流（设计 §6 的补全）：合并 / 保持两条 / 终止的执行、unfreeze 处理、48 小时单方处置提示、
 * 合流递交（merge-request）的人裁定与看板增量采纳。
 * 匹配一律用同名 + 成员交集（与冻结检出同一判据）；系统不自动仲裁——本地已处置者以本地为准，
 * 收到相抵的远端裁定不改本地状态（冲突计数留痕，由人继续谈）。 */

/* 48 小时无裁定提示：站长侧取台账 frozenAt、成员侧取记录 frozenAt；旧数据缺标记时进程内自见到起算
 * （重启重计——提示至多延后，不会误报）。提示一次即停，解除冻结后复位。 */
export function checkFrozenDeadlines(state, now) {
  for (const local of state.collabs.values()) {
    if (localStateOf(local) !== 'frozen' || local.freezeDeadlineNotified === true) {
      continue;
    }
    if (now - frozenStartOf(state, local, now) < state.config.freezeUnresolvedMs) {
      continue;
    }
    local.freezeDeadlineNotified = true;
    state.counters.freezeUnresolved++;
    state.log.warn('冻结超时无裁定——提示双方处置', { collabId: local.collabId });
    notifyLocal(state, local, `协作「${localNameOf(local)}」冻结已超时限仍无裁定：可由任一方选择终止自己那条（ws_decide choice=terminate）或维持冻结（不动作）。`);
  }
}

function frozenStartOf(state, local, now) {
  const raw = local.role === 'manager' ? local.ledger.frozenAt : local.member.frozenAt;
  const parsed = typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  if (!Number.isFinite(local.frozenSinceMs)) {
    local.frozenSinceMs = now;
  }
  return local.frozenSinceMs;
}

/* 冻结前状态读法（标记缺省时的兜底推测见 local.inferredFrozenFrom）。 */
function frozenFromOf(local) {
  const raw = local.role === 'manager' ? local.ledger.frozenFrom : local.member.frozenFrom;
  if (raw === 'proposed' || raw === 'active') {
    return raw;
  }
  return inferredFrozenFrom(local);
}

/* 解除冻结：回冻结前状态（冻结标记清除）；仅冻结态有效，幂等。 */
export function unfreezeLocal(state, local, reason) {
  if (localStateOf(local) !== 'frozen') {
    return false;
  }
  if (local.role === 'manager') {
    const from = frozenFromOf(local);
    mutateLedger(state, local, (ledger) => {
      ledger.status = canTransition('frozen', from) ? from : 'active';
      delete ledger.frozenAt;
      delete ledger.frozenFrom;
    }, { governance: true });
  } else {
    local.member.state = frozenFromOf(local);
    delete local.member.frozenAt;
    delete local.member.frozenFrom;
    persistMember(state, local);
  }
  local.freezeDeadlineNotified = false;
  state.log.info('协作解除冻结', { collabId: local.collabId, reason });
  return true;
}

/* 本地终止一条（冻结单方处置 / 终止裁定 / 被并入条的执行落点）：转终态并归档。
 * localOnly：任期分叉的用户裁定只归档本机副本——不推快照、不广播（设计 §1.3/§2A.3）。 */
export function terminateLocalCopy(state, local, reason, { localOnly = false } = {}) {
  if (isLocalArchivedState(local)) {
    return false;
  }
  clearTerminalFreezeMarks(local);
  if (local.role === 'manager') {
    if (localOnly) {
      applyTerminalLedgerFields(local.ledger);
      local.ledger.version++;
      local.ledger.updatedAt = new Date().toISOString();
      persistLedger(state, local);
    } else {
      mutateLedger(state, local, applyTerminalLedgerFields, { governance: true });
    }
    local.member.state = 'terminated';
    local.member.archivedAt = new Date().toISOString();
    persistMember(state, local);
  } else {
    local.member.state = 'terminated';
    local.member.archivedAt = new Date().toISOString();
    delete local.member.frozenAt;
    delete local.member.frozenFrom;
    persistMember(state, local);
    persistLocalTerminalSnapshot(state, local);
  }
  /* 终态归档与 end 帧入口同口径：本机席位写 archivedAt（退出注入与静音聚合）、清本协作的
   * 静音基线；席位文件保留（契约 §8，删除属停点）。 */
  archiveLocalSeatsOfState(state, local);
  forgetMuteBaselinesOfCollab(state, local.collabId);
  state.counters.freezeTerminatedLocal++;
  state.log.warn('本机该条协作已终止', { collabId: local.collabId, reason });
  return true;
}

/* 终态形态（设计 §3.4）：站长引用与接管窗口必须清空，名单行降为成员。名单不清空是为了
 * 终止通告仍投给原参与者；残留站长行会让落盘行过不了形态校验，重启时静默回退到终止前的行。 */
function applyTerminalLedgerFields(ledger) {
  ledger.status = 'terminated';
  delete ledger.frozenAt;
  delete ledger.frozenFrom;
  ledger.manager = null;
  delete ledger.managerWindow;
  for (const member of ledger.members) {
    member.role = 'member';
  }
}

/* 冻结标记随归档清理：终态不再展示冻结原因（载体的历史值由冻结持久化面收尾）。 */
function clearTerminalFreezeMarks(local) {
  delete local.freezeReason;
  if (local.member !== null && typeof local.member === 'object') {
    delete local.member.freezeReason;
  }
}

/* 成员侧本地终态副本（设计 §3.4）：成员核没有权威台账，归档事实写进快照才能跨重启保留
 * 「已终止」读数。共享名单清空、manager:null、managerTerm 保留、version 递增，附 localTerminal
 * 标记；其他核不以成员侧副本作权威（快照受理门在接收侧）。 */
function persistLocalTerminalSnapshot(state, local) {
  const base = local.snapshot?.ledger;
  if (base === null || typeof base !== 'object' || Array.isArray(base)) {
    return false;
  }
  const ledger = {
    ...structuredClone(base),
    status: 'terminated',
    manager: null,
    version: base.version + 1,
    updatedAt: new Date().toISOString(),
    members: [],
    localTerminal: true,
  };
  delete ledger.managerWindow;
  delete ledger.frozenAt;
  delete ledger.frozenFrom;
  local.snapshot = {
    version: ledger.version,
    digest: ledgerDigest(ledger),
    receivedAt: new Date().toISOString(),
    from: { instanceId: state.self.instanceId, identityName: state.self.identityName },
    ledger,
  };
  persistSnapshot(state, local);
  return true;
}

/* —— 裁定工具（站长席位）—— */

export function decide(state, { collabId, choice }) {
  const local = state.collabs.get(collabId);
  if (local === undefined) {
    return { ok: false, message: '本机没有该协作（先 ws_list_collabs）' };
  }
  if (isLocalArchivedState(local)) {
    return { ok: false, message: '本机该条协作已归档（结束 / 终止）——无需再裁定' };
  }
  /* 任期分叉（设计 §1.3/§2A.3 的工具出口）：terminate 只终止本方分支并在本地归档，不合并、
   * 不广播；merge/keep 无共同台账基准，不适用。成员侧同样可执行（分叉不是站长权限问题）。 */
  if (managerFreezeReasonOf(state, local.collabId) === 'manager-fork') {
    if (choice !== 'terminate') {
      return { ok: false, message: '任期分叉下只支持 choice:terminate（本地归档本方分支；merge / keep 不适用）' };
    }
    return terminateForkBranch(state, local);
  }
  if (local.role !== 'manager') {
    return { ok: false, message: '裁定由站长席位执行（成员的路径是退出该协作）' };
  }
  if (localStateOf(local) !== 'frozen') {
    return { ok: false, message: '只有冻结中的协作需要裁定（当前未冻结）' };
  }
  if (choice === 'keep') {
    return executeKeep(state, local);
  }
  if (choice === 'terminate') {
    return executeTerminate(state, local);
  }
  if (choice === 'merge') {
    return executeMerge(state, local);
  }
  return { ok: false, message: 'choice 非法（merge / keep / terminate）' };
}

function terminateForkBranch(state, local) {
  const done = terminateLocalCopy(state, local, '裁定：终止任期分叉的本方分支', { localOnly: true });
  if (!done) {
    return { ok: false, message: '本机该条已归档——无需再终止' };
  }
  state.counters.freezeForkTerminated = (state.counters.freezeForkTerminated ?? 0) + 1;
  return { ok: true, choice: 'terminate', message: '本方分支已终止并本地归档（不合并、不广播）' };
}

function rosterRefs(local) {
  return localRosterOf(local).map((entry) => ({
    instanceId: entry.instanceId,
    ...(typeof entry.sessionId === 'string' ? { sessionId: entry.sessionId } : {}),
    identityName: entry.identityName,
  }));
}

/* 裁定帧的匹配名单：本方席位 ∪ 检出时记下的对端席位 ∪ 对端意向席位。只带本方名单时，
 * 被并入条与执行方名单没有席位交集，裁定帧到不了对端副本（同一条裁定必须同时命中两侧，
 * 接收侧才能「保留方解冻、被并入条终止」）。缺席位键的条目造不出合法名单，跳过。 */
function decisionMembersOf(local) {
  const union = new Map();
  const remember = (entry) => {
    if (union.size >= MAX_ACTIVE_SEATS) {
      return;
    }
    if (typeof entry?.instanceId !== 'string' || typeof entry?.sessionId !== 'string' || typeof entry?.identityName !== 'string') {
      return;
    }
    const key = `${entry.instanceId}\u0000${entry.sessionId}`;
    if (!union.has(key)) {
      union.set(key, { instanceId: entry.instanceId, sessionId: entry.sessionId, identityName: entry.identityName });
    }
  };
  for (const entry of rosterRefs(local)) {
    remember(entry);
  }
  for (const source of [local.conflictRival, local.mergeIntent]) {
    for (const entry of source?.members ?? []) {
      remember(entry);
    }
  }
  const merged = [...union.values()];
  return merged.length > 0 ? merged : rosterRefs(local);
}

/* 保持两条：解除冻结并广播 unfreeze（对端同判据解除；两套名字/名单各自保留）。 */
function executeKeep(state, local) {
  unfreezeLocal(state, local, '裁定：保持两条');
  sendToRoster(state, local, 'unfreeze', { name: localNameOf(local), members: decisionMembersOf(local), reason: '裁定：保持两条' });
  state.counters.freezeDecisionsOut++;
  return { ok: true, choice: 'keep', message: '已解除冻结并广播——两条协作各自继续（名称建议加后缀区分）' };
}

/* 终止：本机该条转终态并广播（对端同 collabId 副本终止、其余匹配条解除冻结）。 */
function executeTerminate(state, local) {
  const collabId = local.collabId;
  const members = decisionMembersOf(local);
  const name = localNameOf(local);
  terminateLocalCopy(state, local, '裁定：终止本方一条');
  sendToRoster(state, local, 'decision', { choice: 'terminate', name, members, collabId, executed: true });
  state.counters.freezeDecisionsOut++;
  return { ok: true, choice: 'terminate', message: '本机该条已终止；对端收到裁定后解除冻结' };
}

/* 合并（保留方执行）：保留条解除冻结；名单取并集——新增参与者只发邀请（同意门后由入席路径
 * 写名单），共享名单不得出现非 member 行（设计 §2.1 D1）；本机持有的被并入条转终止；
 * 广播执行帧（对端：winner 条解冻、其余匹配条终止）。
 * 保留方判定（设计默认建议「发起更早者任站长」的最佳努力面）：对端数据齐备时先算后执行，
 * 本机非保留方改发意向帧；数据缺省（成员侧检出）以先执行方为准——建议规则由工具文案提示。 */
function executeMerge(state, local) {
  if (mergeWinnerOf(state, local) === 'rival') {
    sendMergeIntent(state, local);
    return { ok: true, choice: 'merge', message: '本机非保留方（对端发起更早）——已广播合并意向，由保留方确认执行' };
  }
  unfreezeLocal(state, local, '裁定：合并（保留方执行）');
  const additions = collectMergeAdditions(state, local);
  if (additions.length > 0) {
    sendMergeInvites(state, local, additions);
  }
  terminateLocalCopies(state, local);
  const winner = local.collabId;
  sendToRoster(state, local, 'decision', {
    choice: 'merge', name: localNameOf(local), members: decisionMembersOf(local), winner, executed: true, createdAt: local.ledger.createdAt,
  });
  state.counters.freezeDecisionsOut++;
  local.mergeIntent = null;
  local.conflictRival = null;
  return { ok: true, choice: 'merge', message: `合并已执行：本机为保留条站长；已向 ${additions.length} 名参与者发出邀请（同意后入席）` };
}

/* 保留方判定：对端数据（发起时间 + 站长）齐备才判定；同时间按站长实例标识码位序小者优先
 * （与抢接优先序同向）。数据缺省返回 'self'（以先执行方为准——「建议」的如实边界）。 */
function mergeWinnerOf(state, local) {
  const rival = local.conflictRival;
  if (rival === null || rival === undefined) {
    return 'self';
  }
  if (typeof rival.createdAt !== 'string' || typeof rival.managerInstanceId !== 'string') {
    return 'self';
  }
  const mine = Date.parse(local.ledger.createdAt);
  const theirs = Date.parse(rival.createdAt);
  if (mine !== theirs) {
    return mine < theirs ? 'self' : 'rival';
  }
  return local.ledger.manager.instanceId < rival.managerInstanceId ? 'self' : 'rival';
}

/* 非保留方的表态：广播意向帧（executed:false，随带本机发起时间）——保留方收到后提示其本机人执行。 */
function sendMergeIntent(state, local) {
  sendToRoster(state, local, 'decision', {
    choice: 'merge', name: localNameOf(local), members: decisionMembersOf(local), winner: local.collabId, executed: false, createdAt: local.ledger.createdAt,
  });
  state.counters.freezeDecisionsOut++;
}

/* 并集新增项：本方名单 ∪ 冻结检出时记下的对端名单 ∪ 对端意向帧名单（缺身份名者跳过——由人另行邀请）。
 * 席位标识随带：对端席位名可指名邀请；旧检出面缺 sessionId 时退回整机不指名。 */
function collectMergeAdditions(state, local) {
  const union = new Map();
  const remember = (entry) => {
    if (!union.has(entry.instanceId) && typeof entry.identityName === 'string') {
      union.set(entry.instanceId, {
        instanceId: entry.instanceId,
        identityName: entry.identityName,
        ...(typeof entry.sessionId === 'string' ? { sessionId: entry.sessionId } : {}),
      });
    }
  };
  for (const entry of localRosterOf(local)) {
    remember(entry);
  }
  for (const source of [local.conflictRival, local.mergeIntent]) {
    if (source === null || source === undefined) {
      continue;
    }
    for (const entry of source.members) {
      remember(entry);
    }
  }
  return [...union.values()].filter((entry) => entry.instanceId !== state.self.instanceId
    && !local.ledger.members.some((member) => member.instanceId === entry.instanceId));
}

/* 合流邀请：目标走同意门（设计 §2.1 D1——受邀未入席者不是成员，不写共享名单）。
 * payload.targets 是目标机器的准入依据；对端席位名已知时同时指名该会话。 */
function sendMergeInvites(state, local, additions) {
  for (const entry of additions) {
    const endpoint = endpointFor(state, local, entry.instanceId);
    if (endpoint === undefined) {
      state.counters.mergeInviteSkipped++;
      state.log.warn('合并新增成员端点未知（暂缓邀请）', { collabId: local.collabId, member: entry.instanceId });
      continue;
    }
    const payload = mergeInvitePayloadOf(local, entry);
    sendTo(state, local.collabId, entry.instanceId, endpoint, 'invite', payload, { fromSessionId: managerSessionOf(local) });
  }
}

function mergeInvitePayloadOf(local, entry) {
  const payload = invitePayloadOf(local.ledger);
  const target = { instanceId: entry.instanceId };
  if (typeof entry.sessionId === 'string') {
    target.targetSessionId = entry.sessionId;
    payload.targetSessionId = entry.sessionId;
  }
  payload.targets = [target];
  return payload;
}

/* 邀请签发席位：台账站长引用优先（新形态带 sessionId），旧形态退回本机站长席位。 */
function managerSessionOf(local) {
  const fromLedger = local.ledger?.manager?.sessionId;
  if (typeof fromLedger === 'string') {
    return fromLedger;
  }
  return managerSeatOfLocal(local)?.sessionId;
}

/* 本机持有的被并入条（同名交集的其他本地协作）转终止。匹配按席位键（设计 D13）：同机两会话
 * 同名但席位不相交时不得按实例键误终止；旧数据缺 sessionId 时仍退回实例键。 */
function terminateLocalCopies(state, local) {
  const seats = localRosterOf(local).map((entry) => ({
    instanceId: entry.instanceId,
    ...(typeof entry.sessionId === 'string' && entry.sessionId !== '' ? { sessionId: entry.sessionId } : {}),
  }));
  for (const other of matchConflictCollabs(state, localNameOf(local), seats)) {
    if (other.collabId !== local.collabId) {
      terminateLocalCopy(state, other, '裁定合并：被并入条转终止');
    }
  }
}

/* —— 裁定 / 解冻报文接收 —— */

export async function handleDecision(state, frame) {
  const payload = frame.payload;
  const memberIds = payload.members.map((entry) => entry.instanceId);
  const matched = matchConflictCollabs(state, payload.name, memberIds);
  if (matched.length === 0) {
    if (noteForumGovernanceIgnored(state, frame)) {
      return { sessionDeliver: false };   // 讨论侧忽略的裁定帧不注入会话（设计 §5.7）
    }
    state.counters.freezeUnmatched++;
    return;
  }
  if (payload.executed !== true) {
    state.counters.freezeIntentsIn++;
    for (const local of matched) {
      armMergeIntent(state, local, frame, payload);
    }
    relayMatched(state, matched, frame);
    return;
  }
  state.counters.freezeDecisionsIn++;
  for (const local of matched) {
    try {
      applyDecisionTo(state, local, frame, payload);
    } catch (error) {
      state.counters.eventFailures++;
      state.log.error('裁定应用异常（该条隔离，继续其余匹配条）', { collabId: local.collabId, choice: payload.choice, reason: error.message });
    }
  }
  relayMatched(state, matched, frame);
}

/* 意向帧（executed:false）：记录对端数据供保留方判定与并集，并提示本机人（不自动执行）。 */
function armMergeIntent(state, local, frame, payload) {
  if (local.role !== 'manager' || localStateOf(local) !== 'frozen') {
    return;
  }
  if (payload.choice === 'merge') {
    local.mergeIntent = {
      createdAt: payload.createdAt,
      managerInstanceId: frame.from.instanceId,
      members: payload.members.map((entry) => ({
        instanceId: entry.instanceId,
        ...(typeof entry.sessionId === 'string' ? { sessionId: entry.sessionId } : {}),
        identityName: entry.identityName,
      })),
    };
  }
  notifyLocal(state, local, `对端选择了「${choiceTextOf(payload.choice)}」——如本机同意，用 ws_decide 执行；不同意可维持冻结（系统不自动仲裁）。`);
}

function choiceTextOf(choice) {
  if (choice === 'merge') {
    return '合并';
  }
  if (choice === 'keep') {
    return '保持两条';
  }
  return '终止';
}

function applyDecisionTo(state, local, frame, payload) {
  if (localStateOf(local) !== 'frozen') {
    if (!isLocalArchivedState(local)) {
      state.counters.freezeDecisionConflicts++;
      state.log.warn('收到与本地已处置状态相抵的裁定（以本地为准，不自动回退）', { collabId: local.collabId, choice: payload.choice });
    }
    return;
  }
  if (payload.choice === 'terminate') {
    if (payload.collabId === local.collabId) {
      terminateLocalCopy(state, local, '收到终止裁定');
    } else {
      unfreezeLocal(state, local, '对方条终止——本方解除冻结');
    }
    return;
  }
  if (payload.choice === 'merge') {
    if (payload.winner === local.collabId) {
      unfreezeLocal(state, local, '本机为保留条——解除冻结');
      return;
    }
    if (mergeOrderRefuses(state, local, frame, payload)) {
      return;
    }
    terminateLocalCopy(state, local, '被并入条转终止');
  }
}

/* 接收侧顺序校验（仅站长席位侧可判——成员侧无「本条发起时间」数据、不做校验）：
 * 执行方条并不比本机更早 → 本机按建议应为保留方，拒绝被并入（保持冻结、冲突留痕，
 * 由人继续谈——「两边裁定矛盾时保持冻结」的机器化面）。 */
function mergeOrderRefuses(state, local, frame, payload) {
  if (local.role !== 'manager') {
    return false;
  }
  if (typeof payload.createdAt !== 'string' || typeof local.ledger.createdAt !== 'string') {
    return false;
  }
  const mine = Date.parse(local.ledger.createdAt);
  const theirs = Date.parse(payload.createdAt);
  const theirsEarlier = theirs < mine || (theirs === mine && frame.from.instanceId < local.ledger.manager.instanceId);
  if (theirsEarlier) {
    return false;
  }
  state.counters.freezeDecisionConflicts++;
  state.log.warn('合并声明与本地发起顺序相抵（本机更早）——保持冻结，由人继续谈', { collabId: local.collabId });
  notifyLocal(state, local, '收到合并裁定但本机条发起更早（按建议应由本机保留）——已保持冻结，请与对方沟通后重议。');
  return true;
}

export async function handleUnfreeze(state, frame) {
  const payload = frame.payload;
  const matched = matchConflictCollabs(state, payload.name, payload.members.map((entry) => entry.instanceId));
  if (matched.length === 0) {
    if (noteForumGovernanceIgnored(state, frame)) {
      return { sessionDeliver: false };   // 讨论侧忽略的解冻帧不注入会话（设计 §5.7）
    }
    state.counters.freezeUnmatched++;
    return;
  }
  state.counters.unfreezesIn++;
  for (const local of matched) {
    try {
      unfreezeLocal(state, local, '收到解除冻结广播');
    } catch (error) {
      state.counters.eventFailures++;
      state.log.error('解冻应用异常（该条隔离，继续其余匹配条）', { collabId: local.collabId, reason: error.message });
    }
  }
  relayMatched(state, matched, frame);
}

/* 转达（治理类例外）：把本次受理的匹配协作端点并集交给通用转达出口。 */
function relayMatched(state, matched, frame) {
  const targets = new Map();
  for (const local of matched) {
    for (const [instanceId, target] of governanceTargets(state, local)) {
      if (!targets.has(instanceId)) {
        targets.set(instanceId, target);
      }
    }
  }
  state.counters.freezeRelayed += relayGovernance(state, frame, targets);
}

/* —— 合流递交与裁定 —— */

export async function handleMergeRequest(state, frame) {
  const local = state.collabs.get(frame.collabId);
  if (local === undefined) {
    return;
  }
  state.counters.mergeRequestsIn++;
  if (local.role !== 'manager') {
    state.log.warn('收到合流递交但本机不是站长席位（忽略）', { collabId: frame.collabId, from: frame.from.instanceId });
    return;
  }
  const payload = frame.payload;
  const offered = payload.ledger;
  const coherent = isLedgerShape(offered)
    && offered.collabId === frame.collabId
    && offered.version === payload.version
    && ledgerDigest(offered) === payload.digest;
  if (!coherent || payload.version <= payload.baseVersion) {
    state.counters.mergeCorrupt++;
    state.log.warn('合流递交不合自洽（形态 / 摘要 / 版本），拒绝', { collabId: frame.collabId, version: payload.version });
    return;
  }
  local.pendingMerge = {
    from: { instanceId: frame.from.instanceId, identityName: frame.from.identityName },
    baseVersion: payload.baseVersion,
    version: payload.version,
    ledger: offered,
  };
  notifyLocal(state, local, `收到「${frame.from.identityName}」的合流递交（版本 ${payload.version}，基准 ${payload.baseVersion}）——可用 ws_decide mergeOffer=accept 采纳看板增量，或 reject 丢弃。`);
}

export function decideMergeOffer(state, { collabId, mergeOffer }) {
  const local = state.collabs.get(collabId);
  if (local === undefined) {
    return { ok: false, message: '本机没有该协作（先 ws_list_collabs）' };
  }
  if (local.role !== 'manager') {
    return { ok: false, message: '合流裁定由站长席位执行' };
  }
  const pending = local.pendingMerge;
  if (pending === null || pending === undefined) {
    return { ok: false, message: '没有待裁定的合流递交' };
  }
  if (mergeOffer === 'reject') {
    local.pendingMerge = null;
    state.counters.mergeDiscarded++;
    sendMergeOutcome(state, local, pending, false);
    return { ok: true, choice: 'reject', message: '已丢弃该合流递交（零看板变更，留痕）' };
  }
  if (mergeOffer !== 'accept') {
    return { ok: false, message: 'mergeOffer 非法（accept / reject）' };
  }
  const adopted = adoptBoardEntries(state, local, pending.ledger);
  local.pendingMerge = null;
  state.counters.mergeAdopted++;
  sendMergeOutcome(state, local, pending, true);
  return { ok: true, choice: 'accept', adopted, message: `已采纳看板增量 ${adopted} 条（经版本重编入账）` };
}

/* 采纳 = 看板条目增量（按 entryId 去重追加、超上限同规则裁剪、经正常变更路径重编版本号）。
 * 主题 / 名单等差异不自动合并——统一由日志留痕、由人以常规操作补齐（禁止静默覆盖的落实面）。 */
function adoptBoardEntries(state, local, offered) {
  const existing = new Set(local.ledger.board.map((entry) => entry.entryId));
  const additions = offered.board.filter((entry) => !existing.has(entry.entryId));
  if (additions.length === 0) {
    return 0;
  }
  let added = 0;
  mutateLedger(state, local, (ledger) => {
    for (const entry of additions) {
      ledger.board.push({ entryId: entry.entryId, ts: entry.ts, from: { ...entry.from }, kind: entry.kind, text: entry.text });
      added++;
      while (ledger.board.length > MAX_BOARD_ENTRIES) {
        ledger.board.shift();
        state.counters.boardEvicted++;
      }
    }
  }, { governance: true });
  return added;
}

function sendMergeOutcome(state, local, pending, adopted) {
  const endpoint = local.endpoints.get(pending.from.instanceId);
  if (endpoint === undefined) {
    return;
  }
  sendTo(state, local.collabId, pending.from.instanceId, endpoint, 'notice', { event: 'merge-outcome', adopted });
}

export async function handleMergeOutcome(state, frame) {
  const local = state.collabs.get(frame.collabId);
  if (local === undefined) {
    return;
  }
  state.counters.mergeOutcomesIn++;
  const adopted = frame.payload.adopted === true;
  state.log.info('合流裁定结果（留痕）', { collabId: frame.collabId, adopted, manager: frame.from.instanceId });
  notifyLocal(state, local, adopted ? '合流递交已被采纳（超出部分经重编入账）。' : '合流递交已被丢弃（以现任台账为准）。');
}
