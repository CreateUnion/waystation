import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ID_PATTERN, MAX_TOPIC_CHARS, isCollabMode, isIdentityName, isPort, isPresentationText } from '../net/protocol.js';
import { CARRIER_FILE_NAME } from '../paths.js';
import { writeJsonAtomic } from '../storage.js';

/* 协作载体文件（设计 §6.2）：0.2.0 起每个协作目录的第一份落盘文件。
 * 它只描述「这个目录是什么形态、谁的协作」——席位态、台账、邀请簿记分别归各自文件。
 * 新协作先写 carrier 再写台账；两步之间崩溃的目录由 recovery.json 标记（migration.js）。
 * 形态不符一律拒绝（与本地其它文件同一纪律），不做清洗。
 *
 * 旧 member.json 字段去向：role/state/joinSeq/joinedAt/muted/decision → seats/<sessionId>.json；
 * manager/originator/forumMeta/syncCursor/name/topic/mode/endpoints → 本文件；
 * roster → 共享快照/peerView；pendingInvites/targetSessionId → pending-invites.json。 */

/* 文件名权威在路径层；这里只转出给 legacy 只读读取器的消费方，避免与 paths.js 的常量漂移。 */
export { CARRIER_FILE_NAME };
export const CARRIER_FORMAT_SESSION_SEATS = 'session-seats';
export const CARRIER_FORMAT_INVITE_STUB = 'invite-stub';
export const CARRIER_FORMATS = [CARRIER_FORMAT_SESSION_SEATS, CARRIER_FORMAT_INVITE_STUB];
/* 本文件自身的形态版本：0.2.0 首次引入，后续形态变更递增。读到更高版本按不可用处理
 * （fail-safe：不静默降级重写，避免把未来版本的文件覆盖成旧形态）。 */
export const CARRIER_VERSION = 1;

/* 等价于路径层的 carrierFilePath(dataDir, collabId)，本模块的读写面只收已经拼好的目录。 */
export function carrierPath(dir) {
  return join(dir, CARRIER_FILE_NAME);
}

export function isCarrierFormat(value) {
  return CARRIER_FORMATS.includes(value);
}

/* 形态校验：format/version/collabId/name/topic/mode/endpoints/snapshotVersion/createdAt 必填；
 * manager/originator/forumMeta/syncCursor 可选（旧 member.json 的对应字段迁到 carrier）。 */
export function isCarrierShape(carrier) {
  if (!isPlainObject(carrier) || !isCarrierHeadShape(carrier)) {
    return false;
  }
  if (!isCarrierManagerShape(carrier.manager)) {
    return false;
  }
  return isCarrierExtrasShape(carrier);
}

function isCarrierHeadShape(carrier) {
  if (!isCarrierTextShape(carrier) || !isCarrierVersionShape(carrier)) {
    return false;
  }
  return isCollabMode(carrier.mode) && isEndpointsShape(carrier.endpoints) && isTimestamp(carrier.createdAt);
}

function isCarrierTextShape(carrier) {
  return isCarrierFormat(carrier.format)
    && isId(carrier.collabId)
    && isIdentityName(carrier.name)
    && isPresentationText(carrier.topic, MAX_TOPIC_CHARS);
}

function isCarrierVersionShape(carrier) {
  if (!Number.isInteger(carrier.version) || carrier.version < 1 || carrier.version > CARRIER_VERSION) {
    return false;
  }
  if (!Number.isInteger(carrier.snapshotVersion) || carrier.snapshotVersion < 0) {
    return false;
  }
  /* 邀请占位尚无快照：固定 0，防止把「已入席后」的载体误标成 stub。 */
  return carrier.format !== CARRIER_FORMAT_INVITE_STUB || carrier.snapshotVersion === 0;
}

/* 站长席位：0.2.0 起必须带 sessionId 与单调任期 term（旧形态只有 instanceId/identityName）。 */
function isCarrierManagerShape(manager) {
  if (manager === undefined) {
    return true;
  }
  return isPlainObject(manager)
    && isId(manager.instanceId)
    && isId(manager.sessionId)
    && isIdentityName(manager.identityName)
    && Number.isInteger(manager.term)
    && manager.term >= 1;
}

function isCarrierExtrasShape(carrier) {
  return isOriginatorShape(carrier.originator)
    && isForumMetaShape(carrier.forumMeta)
    && isSyncCursorShape(carrier.syncCursor);
}

function isOriginatorShape(originator) {
  if (originator === undefined) {
    return true;
  }
  return isPlainObject(originator)
    && isId(originator.instanceId)
    && isId(originator.sessionId)
    && isIdentityName(originator.identityName);
}

function isForumMetaShape(meta) {
  if (meta === undefined) {
    return true;
  }
  if (!isPlainObject(meta)) {
    return false;
  }
  return ['createdAt', 'establishedAt', 'endedAt'].every((field) => meta[field] === undefined || isTimestamp(meta[field]));
}

function isSyncCursorShape(cursor) {
  if (cursor === undefined || cursor === null) {
    return true;
  }
  if (!isPlainObject(cursor)) {
    return false;
  }
  return isTimestamp(cursor.ts) && typeof cursor.postId === 'string' && ID_PATTERN.test(cursor.postId);
}

function isEndpointsShape(endpoints) {
  if (!isPlainObject(endpoints)) {
    return false;
  }
  for (const [instanceId, endpoint] of Object.entries(endpoints)) {
    if (!isId(instanceId) || !isEndpointShape(endpoint)) {
      return false;
    }
  }
  return true;
}

function isEndpointShape(endpoint) {
  if (!isPlainObject(endpoint) || typeof endpoint.address !== 'string' || endpoint.address === '') {
    return false;
  }
  return isPort(endpoint.port);
}

/** 读取 carrier.json：status='ok' 只表示整档形态通过；missing 与 corrupt 分开返回，
 * 让调用方自行决定「无标记」与「有文件但不可用」的不同处置（legacy 判据只看 format 标记）。 */
export function readCarrier(dir) {
  const raw = loadRawCarrier(dir);
  if (raw.missing) {
    return { status: 'missing', carrier: null };
  }
  if (raw.error !== undefined) {
    return { status: 'corrupt', carrier: null, error: errorTextOf(raw.error) };
  }
  if (!isCarrierShape(raw.value)) {
    return { status: 'corrupt', carrier: null, error: 'carrier.json 形态不符' };
  }
  return { status: 'ok', carrier: raw.value };
}

/** 只取 format 标记（不要求整档形态）：空协作/半写目录的判据需要「有标记」这一事实本身。 */
export function readCarrierFormat(dir) {
  const raw = loadRawCarrier(dir);
  if (!isPlainObject(raw.value)) {
    return null;
  }
  return isCarrierFormat(raw.value.format) ? raw.value.format : null;
}

/** 原子写：目录按需创建（carrier 是新协作目录的第一份文件），整档替换走 storage 的临时文件 + rename。 */
export function writeCarrier(dir, carrier) {
  if (!isCarrierShape(carrier)) {
    throw new TypeError('carrier.json 形态非法，拒绝写入');
  }
  mkdirSync(dir, { recursive: true });
  writeJsonAtomic(carrierPath(dir), carrier);
  return carrier;
}

/** @returns {{ value?: any, error?: any, missing?: boolean }} */
function loadRawCarrier(dir) {
  try {
    return { value: JSON.parse(readFileSync(carrierPath(dir), 'utf8')) };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { missing: true };
    }
    return { error };
  }
}

function errorTextOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function isTimestamp(value) {
  return typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value));
}
