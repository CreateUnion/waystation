import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const DATA_DIR_ENV = 'WAYSTATION_HOME';
export const LOGS_DIR_NAME = 'logs';
export const COLLABS_DIR_NAME = 'collabs';

/* 数据目录：配置文件就住在数据目录里，所以目录位置只能由环境变量先定，不能在配置里配。
 * WAYSTATION_HOME 优先（设计 §14：数据目录可单独改），默认 ~/.waystation；
 * 相对值按进程 CWD 解析——此处没有更早的锚点，配置方应给绝对路径 */
export function resolveDataDir(env) {
  const configured = env[DATA_DIR_ENV];
  if (typeof configured === 'string' && configured.trim() !== '') {
    return resolve(configured.trim());
  }
  return join(homedir(), '.waystation');
}

/** 日志目录：配置项优先，默认 <dataDir>/logs（设计 §14：日志目录可单独改）。
 * 相对配置值以 dataDir 为锚点——不能按进程 CWD 解析：MCP 子进程的 CWD 是会话工作目录（不稳定） */
export function resolveLogDir(dataDir, configuredLogDir) {
  if (typeof configuredLogDir === 'string' && configuredLogDir.trim() !== '') {
    return resolve(dataDir, configuredLogDir.trim());
  }
  return join(dataDir, LOGS_DIR_NAME);
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}
