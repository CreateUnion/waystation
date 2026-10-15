/* 数据根摘要（8 hex）的中立定义模块：观察窗（health 字段、端口自发现与 --stop 根匹配）
 * 与核心（IPC 端点命名）共同导入，防止多处口径漂移。
 *
 * 规范化口径：绝对化后按平台大小写折叠（Windows 路径大小写不敏感，同一目录的不同写法必须得同摘要——
 * 根匹配依赖它）再哈希。消费方一律经本模块引用，不再各自实现。 */

import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

/* 8 hex＝32 bit：摘要只作本机自发现的根标记（是否同根），不承担防碰撞职责。 */
const ROOT_DIGEST_CHARS = 8;

/**
 * 数据根的摘要（8 hex）。
 * @param {string} dataDir 数据根；相对路径按进程 cwd 解析
 * @returns {string}
 */
export function rootDigest(dataDir) {
  const absolute = resolve(dataDir);
  const normalized = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  return createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, ROOT_DIGEST_CHARS);
}
