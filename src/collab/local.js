import { DEFAULT_COLLAB_MODE } from '../net/protocol.js';
import { appendLedger, ensureCollabDir, saveMember, saveSnapshot } from './store.js';
import { isArchived } from './model.js';
import { newMemberEventId } from './members.js';

/* 本地协作态与持久化的共享原语（服务内多模块共用）：状态读法（管理席位以台账为权威、
 * 成员以本地记录为权威）与「只计数告警、绝不抛出」的写盘包装（健壮性硬性要求——
 * 写盘失败不得让协作事件处理或消息主链中断）。写包装统一先确保协作目录存在（写路径自足）。 */

/* 状态读法：管理席位以台账为权威；「已退出」是成员记录的本地终态，对**讨论的发起人**同样可达
 * （发起人可退出——退出即放弃结束权，设计 §6），故管理席位以 member.state 的 left 标记优先。 */
export function localStateOf(local) {
  if (local.role === 'manager' && local.member.state !== 'left') {
    return local.ledger.status;
  }
  return local.member.state;
}

/* 模式读法（两侧视角统一）：管理席位取台账、成员取本地记录；缺省 managed（旧数据兼容，
 * 创建时定死不可变——本函数是全部模式判定的单一入口）。 */
export function localModeOf(local) {
  const raw = local.role === 'manager' ? local.ledger.mode : local.member.mode;
  return raw ?? DEFAULT_COLLAB_MODE;
}

export function isLocalArchivedState(local) {
  return isArchived(localStateOf(local));
}

export function localNameOf(local) {
  return local.role === 'manager' ? local.ledger.name : local.member.name;
}

export function localRosterOf(local) {
  if (local.role === 'manager') {
    return local.ledger.members;
  }
  return local.member.roster ?? [];
}

/* 讨论的当前成员表 = 成员事件日志按事件折叠（设计 §5.4；每成员取自身最新事件、join 者入表）。
 * 这是讨论模式成员语义的单一取数面：邀请名额判定、帖扇出、控制事件广播都经它——
 * managed 的 roster/台账名单不再是讨论成员关系的权威（被拒/被撤回者不占名额、退出者即时出表）。 */
export function foldedMembersOf(local) {
  return local.members.fold();
}

/* 讨论的群体可达面（控制事件广播 / 对表候选 / 拉取应答准入的共用成员集）：
 * 折叠成员表 ∪ 邀请者引用 ∪ 端点表已知者（除本机）。
 * 端点表是邀请随带的寻址信息的落点（设计 §5.1「被邀者据此取得入群所需的成员与寻址信息」）——
 * 新成员刚加入时折叠表只有自己，可达面若只到邀请者，邀请者离线即把成员钉成孤点：join 达不到
 * 其余成员、回填无从发起、对全员不可见；端点表已知者即从邀请面可寻址的成员/受邀者，
 * 端点未知者由对方主动联系或后续对表补学（跳过不阻塞其余目标）。 */
export function forumReachIdsOf(local, selfId) {
  const ids = new Set();
  for (const member of local.members.fold()) {
    ids.add(member.instanceId);
  }
  if (local.role === 'member' && typeof local.member?.manager?.instanceId === 'string') {
    ids.add(local.member.manager.instanceId);
  }
  for (const instanceId of local.endpoints.keys()) {
    ids.add(instanceId);
  }
  ids.delete(selfId);
  return [...ids];
}

/* 本机是否已在折叠成员表内（讨论的「已加入」判据：发帖与发 join 重播的前置）。 */
export function selfJoinedOf(local, selfId) {
  return local.members.includes(selfId);
}

/* 讨论的中继（= 发起人）身份读法（设计 §5.2/§9.1）：发起人本机即中继；成员取本地记录里
 * 随邀请载荷 / bundle 元状态学得的 originator（与「邀请者引用」member.manager 是不同字段
 * ——邀请者≠发起人，中继归属不得由邀请者推断）。未知返回 null——投递按降级直投处理。 */
export function relayPeerOf(local, self) {
  if (localModeOf(local) === 'forum' && local.role === 'manager') {
    return { instanceId: self.instanceId, identityName: self.identityName };
  }
  const originator = local.member?.originator;
  if (originator !== undefined && typeof originator.instanceId === 'string') {
    return { instanceId: originator.instanceId, identityName: originator.identityName };
  }
  return null;
}

/* 发起人是否已放弃中继职责（设计 §5.2/§9.1：发起人退出＝永久放弃 → 直投兜底）。
 * 判据 = 本机成员事件集里该发起人最近一条事件为 leave；事件未到 / 从未见过该实例 → false
 * （不臆断，按可达处理——新加入者在成员事件收敛前也须照常经中继）。 */
export function relayDepartedOf(local, relayId) {
  const latest = local.members.latestEventOf(relayId);
  return latest !== null && latest.kind === 'leave';
}

/* 主题读法（两侧视角统一）：管理席位取台账、成员取本地记录（邀请载荷/对表元状态写入）。 */
export function localTopicOf(local) {
  const raw = local.role === 'manager' ? local.ledger.topic : local.member.topic;
  return typeof raw === 'string' ? raw : null;
}

/* 本机自播成员事件（设计 §5.4/§5.5）：join/leave 由成员本人发出——事件时刻取该作者的
 * 单调基线（帖子与事件共用：与帖子序同源、跨重启落盘）。
 * 返回事件（已并入本地日志）或 null（形态异常/重复——新事件 id 不会重复）。 */
export function emitOwnMemberEvent(state, local, kind) {
  const event = {
    eventId: newMemberEventId(),
    kind,
    instanceId: state.self.instanceId,
    identityName: state.self.identityName,
    ts: allocateOwnEventStamp(state, local),
  };
  return local.members.apply(event) === 'added' ? event : null;
}

/* 作者局部单调 ts 分配：以本机已落盘的帖子 + 成员事件的最大 ts 为基线，回拨时取基线 + 1ms。 */
function allocateOwnEventStamp(state, local) {
  const postTs = local.posts.ownBaseline(state.self.instanceId).ts;
  const eventTs = local.members.baselineTsOf(state.self.instanceId);
  const postMs = typeof postTs === 'string' ? Date.parse(postTs) : Number.NEGATIVE_INFINITY;
  const eventMs = typeof eventTs === 'string' ? Date.parse(eventTs) : Number.NEGATIVE_INFINITY;
  const baseMs = Math.max(postMs, eventMs);
  const nowMs = Date.now();
  const stampMs = Number.isFinite(baseMs) ? Math.max(baseMs + 1, nowMs) : nowMs;
  return new Date(stampMs).toISOString();
}

/* 本机持有的当前汇报版本：管理席位取台账版本；成员取最近一次校验通过的快照版本（无快照为 null）。
 * 抢接优先序与合流判定都以它为「本机版本」口径。 */
export function localVersionOf(local) {
  if (local.role === 'manager') {
    return local.ledger.version;
  }
  return local.snapshot === null ? null : local.snapshot.version;
}

/* 现任驿丞标识（两侧视角统一读法）。 */
export function currentManagerIdOf(local) {
  if (local.role === 'manager') {
    return local.ledger.manager.instanceId;
  }
  return local.member.manager.instanceId;
}

export function persistMember(state, local) {
  try {
    ensureCollabDir(state.dataDir, local.collabId);
    saveMember(state.dataDir, local.member);
  } catch (error) {
    state.counters.persistFailures++;
    state.log.warn('成员记录写入失败（内存态继续）', { collabId: local.collabId, reason: error.message });
  }
}

export function persistLedger(state, local) {
  try {
    ensureCollabDir(state.dataDir, local.collabId);
    appendLedger(state.dataDir, local.ledger);
  } catch (error) {
    state.counters.persistFailures++;
    state.log.warn('台账写入失败（内存态继续）', { collabId: local.collabId, reason: error.message });
  }
}

export function persistSnapshot(state, local) {
  if (local.snapshot === null) {
    return;
  }
  try {
    ensureCollabDir(state.dataDir, local.collabId);
    saveSnapshot(state.dataDir, local.collabId, local.snapshot);
  } catch (error) {
    state.counters.persistFailures++;
    state.log.warn('快照写入失败（内存态继续）', { collabId: local.collabId, reason: error.message });
  }
}

export function rememberKnownHost(state, entry) {
  try {
    state.knownHosts.remember(entry);
  } catch (error) {
    state.counters.persistFailures++;
    state.log.warn('已知主机清单更新失败（已忽略）', { reason: error.message });
  }
}

/* 由台账状态映射成员侧本地状态（席位转移——接管 / 移交 / 抢接降级——的共用量规）：
 * 成员记录是本地视角，其 state 取当前公开状态的映射；left 是成员本地终态、不由映射产生。 */
export function memberStateFor(status) {
  if (status === 'completed' || status === 'terminated') {
    return status;
  }
  if (status === 'frozen') {
    return 'frozen';
  }
  if (status === 'active') {
    return 'active';
  }
  return 'proposed';
}

/* 冻结前状态的兜底推测（旧数据缺 frozenFrom 标记时）：成员侧已回应过邀请即视为 active，
 * 未回应视为 proposed；管理侧存在非邀请态成员即视为 active，否则 proposed。 */
export function inferredFrozenFrom(local) {
  if (local.role === 'manager') {
    const settled = local.ledger.members.some((entry) => entry.role !== 'manager' && entry.state !== 'invited' && entry.state !== 'left');
    return settled ? 'active' : 'proposed';
  }
  const decision = local.member.decision ?? null;
  return decision === 'approved' || decision === 'withdrawn' ? 'active' : 'proposed';
}
