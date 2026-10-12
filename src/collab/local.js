import { isArchived } from './model.js';
import { appendLedger, ensureCollabDir, saveMember, saveSnapshot } from './store.js';

/* 本地协作态与持久化的共享原语（服务内多模块共用）：状态读法（管理席位以台账为权威、
 * 成员以本地记录为权威）与「只计数告警、绝不抛出」的写盘包装（健壮性硬性要求——
 * 写盘失败不得让协作事件处理或消息主链中断）。写包装统一先确保协作目录存在（写路径自足）。 */

export function localStateOf(local) {
  return local.role === 'manager' ? local.ledger.status : local.member.state;
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
