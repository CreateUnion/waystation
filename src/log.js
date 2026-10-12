import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const LOG_FILE_NAME = 'waystation.log';

/* 文件日志（设计 §13：按大小轮转、上限可配）。
 * stdout 是 stdio MCP 的协议通道——日志只允许写文件；warn/error 另镜像 stderr（任何时刻合法的诊断通道）。
 * 所有写路径吞掉异常：序列化失败 / 磁盘满 / 权限不足 / 目录不可用都不得打断主流程（设计 §6 健壮性硬性要求）；
 * 兜底范围是 I/O 与序列化异常——缺参属调用方编程错误，直接抛 TypeError。
 * 默认值不在本模块定义——maxBytes/maxFiles 由调用方从 config 传入（默认值权威源在 config.buildDefaults）。 */
export function createLogger({ logDir, maxBytes, maxFiles }) {
  const limits = { filePath: join(logDir, LOG_FILE_NAME), maxBytes, maxFiles };
  try {
    mkdirSync(logDir, { recursive: true });
  } catch {
    // 目录建不出来时保持降级：后续写入会失败并被吞掉，warn/error 的 stderr 镜像仍工作
  }
  return {
    info: (message, fields = {}) => writeLine(limits, 'info', message, fields),
    warn: (message, fields = {}) => writeLine(limits, 'warn', message, fields),
    error: (message, fields = {}) => writeLine(limits, 'error', message, fields),
  };
}

function writeLine(limits, level, message, fields) {
  try {
    const line = JSON.stringify({ ...fields, ts: new Date().toISOString(), level, msg: message }) + '\n';
    rotateIfNeeded(limits);
    appendFileSync(limits.filePath, line);
  } catch {
    // 序列化失败（循环引用 / BigInt 字段）或写盘失败：info 静默、warn/error 仍走下面的 stderr 镜像
  }
  if (level !== 'info') {
    try {
      console.error(`[waystation:${level}] ${message}`);
    } catch {
      // stderr 不可用时放弃输出
    }
  }
}

function rotateIfNeeded({ filePath, maxBytes, maxFiles }) {
  let size = 0;
  try {
    size = statSync(filePath).size;
  } catch {
    // 尚无日志文件：size 保持 0，等价于「不需要轮转」
  }
  if (size < maxBytes) {
    return;
  }
  rmSync(`${filePath}.${maxFiles}`, { force: true });
  for (let index = maxFiles - 1; index >= 1; index--) {
    try {
      renameSync(`${filePath}.${index}`, `${filePath}.${index + 1}`);
    } catch {
      // 该归档份不存在：跳过
    }
  }
  try {
    renameSync(filePath, `${filePath}.1`);
  } catch {
    // 轮转失败不阻塞本次写入：当前文件继续增长，下次写前再试
  }
}
