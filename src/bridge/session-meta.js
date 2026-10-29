import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/* 桥侧读取 Claude Code 会话元数据：与 Claude 同用户、同环境，按内容里的 sessionId 匹配
 * （文件名是 PID，桥的 pid 是 MCP 子进程，不能按文件名命中）。名字 / kind 只用于本机 dispatch
 * 视图与交互式判定；kind 是 Claude 私有字段，不是安全边界。 */

export const SESSION_META_FRESH_MS = 5 * 60 * 1000;

/**
 * @param {{ env?: NodeJS.ProcessEnv, sessionId?: string, now?: number }} [options]
 * @returns {{ name: string | null, kind: string, entrypoint: string | null, status: string | null,
 *   updatedAt: number, fresh: boolean } | null}
 */
export function readClaudeSessionMeta({ env = process.env, sessionId, now = Date.now() } = {}) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    return null;
  }
  const matches = collectSessionMatches(sessionMetaDirOf(env), sessionId);
  if (matches.length === 0) {
    return null;
  }
  matches.sort(compareSessionMatches);
  const { raw, mtime } = matches[0];
  return {
    ...sessionMetaFieldsOf(raw),
    updatedAt: mtime,
    fresh: now - mtime <= SESSION_META_FRESH_MS,
  };
}

/** @param {{ env?: NodeJS.ProcessEnv, sessionId?: string, now?: number }} [options] */
export function bridgeMetaOf({ env = process.env, sessionId, now = Date.now() } = {}) {
  const file = readClaudeSessionMeta({ env, sessionId, now });
  return {
    role: roleOf(env),
    masterName: trimmedTextOf(env.WAYSTATION_MASTER),
    ...sessionReportOf(file),
  };
}

/**
 * @param {{ env?: NodeJS.ProcessEnv, sessionId?: string, intervalMs?: number,
 *   onChange?: (meta: any) => void, now?: () => number }} [options]
 * @returns {{ close: () => void }}
 */
export function createSessionMetaWatcher({ env = process.env, sessionId, intervalMs = 5000, onChange, now = Date.now } = {}) {
  let previous = JSON.stringify(bridgeMetaOf({ env, sessionId, now: now() }));
  const timer = setInterval(() => {
    const next = bridgeMetaOf({ env, sessionId, now: now() });
    const serialized = JSON.stringify(next);
    if (serialized === previous) {
      return;
    }
    previous = serialized;
    onChange?.(next);
  }, intervalMs);
  timer.unref?.();
  return { close() { clearInterval(timer); } };
}

/* Claude 配置根：CLAUDE_CONFIG_DIR（显式配置优先）或 ~/.claude；sessions/ 下的文件名是 PID。 */
function sessionMetaDirOf(env) {
  const root = typeof env.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR.trim() !== ''
    ? env.CLAUDE_CONFIG_DIR.trim()
    : join(homedir(), '.claude');
  return join(root, 'sessions');
}

/* 逐文件按内容匹配：坏 JSON / 非对象 / sessionId 不符一律跳过（会话文件是 Claude 私有面，
 * 单文件损坏不得牵连其余匹配）。 */
function collectSessionMatches(dir, sessionId) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const matches = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }
    const match = readSessionMatch(join(dir, entry.name), sessionId);
    if (match !== null) {
      matches.push(match);
    }
  }
  return matches;
}

function readSessionMatch(file, sessionId) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (raw === null || typeof raw !== 'object' || raw.sessionId !== sessionId) {
      return null;
    }
    return { raw, mtime: statSync(file).mtimeMs };
  } catch {
    return null;
  }
}

/* 同名多文件（Claude 崩溃残留/重开）时的择一：用户指定名优先，其次 mtime 新者。 */
function compareSessionMatches(left, right) {
  return nameRankOf(right.raw) - nameRankOf(left.raw) || right.mtime - left.mtime;
}

function nameRankOf(raw) {
  return raw.nameSource === 'user' ? 1 : 0;
}

/* 文本字段一律归一：空串 / 纯空白 → null。IPC hello/register-update 的 isShortText 拒空串，
 * 原样上报会让整帧被拒、该会话失去 waystation；name 早已按此口径。 */
function sessionMetaFieldsOf(raw) {
  return {
    name: trimmedTextOf(raw.name),
    kind: kindOf(raw.kind),
    entrypoint: trimmedTextOf(raw.entrypoint),
    status: trimmedTextOf(raw.status),
  };
}

function kindOf(value) {
  return value === 'interactive' || value === 'bg' ? value : 'unknown';
}

function trimmedTextOf(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function roleOf(env) {
  return env.WAYSTATION_ROLE === 'master' || env.WAYSTATION_ROLE === 'slave' ? env.WAYSTATION_ROLE : 'none';
}

/* 上报面：文件缺失/不可读时各字段回退未知值（kind 缺失按非交互式——失败关闭）。 */
function sessionReportOf(file) {
  if (file === null) {
    return { name: null, kind: 'unknown', entrypoint: null, status: null, metaUpdatedAt: 0 };
  }
  return {
    name: file.name,
    kind: file.kind,
    entrypoint: trimmedTextOf(file.entrypoint),
    status: trimmedTextOf(file.status),
    metaUpdatedAt: file.updatedAt,
  };
}
