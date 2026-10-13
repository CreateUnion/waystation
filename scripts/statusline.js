import { readFileSync } from 'node:fs';
import { resolveDataDir, sessionFilePath } from '../src/paths.js';
import { SESSION_STATUS_STALE_MS } from '../src/session-status.js';
import { ID_PATTERN } from '../src/net/protocol.js';

/* statusline 读取脚本（状态栏「协作中」指示的读取端）：Claude Code 每次刷新把会话 JSON 经 stdin 送来，
 * 本脚本取其中的会话标识命中会话状态文件、渲染一行指示。
 * 契约：任何异常一律空输出 + 退出码 0——状态栏是观察面，绝不因指示失败干扰界面；
 * 无协作 / 无文件 / 文件陈旧 / 解析失败 都输出空串（状态行没有「错误态」语义）。
 * 集成属客户端配置（两条路径都不改本脚本）：独立 statusLine 直接指定本脚本；claude-hud 等
 * 组合式状态栏经其扩展能力对接（组合形态由客户端能力决定，端到端未实测——README 如实标注）。 */

const ROLE_LABELS = { manager: '驿丞', member: '协作者' };
const STATE_LABELS = { proposed: '待同意', frozen: '冻结' };
const MAX_INPUT_BYTES = 262144;   // 状态栏 JSON 体量上限：超限按解析失败处理，不做无界读

async function readInput() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > MAX_INPUT_BYTES) {
      return '';
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseJsonOrNull(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readStatusFile(dataDir, sessionId) {
  try {
    return parseJsonOrNull(readFileSync(sessionFilePath(dataDir, sessionId), 'utf8'));
  } catch {
    return null;
  }
}

function isFresh(status) {
  const updatedAtMs = typeof status?.updatedAt === 'string' ? Date.parse(status.updatedAt) : Number.NaN;
  return Number.isFinite(updatedAtMs) && Date.now() - updatedAtMs <= SESSION_STATUS_STALE_MS;
}

function renderItem(entry) {
  const role = ROLE_LABELS[entry?.role] ?? '协作者';
  const parts = [role];
  const stateLabel = STATE_LABELS[entry?.state];
  if (stateLabel !== undefined) {
    parts.push(stateLabel);
  }
  const name = typeof entry?.name === 'string' && entry.name !== '' ? entry.name : '未命名';
  const size = Number.isInteger(entry?.memberCount) ? `${entry.memberCount} 人` : '人数未知';
  return `${name}（${parts.join('，')}，${size}）`;
}

function lineFromStatusFile(sessionId) {
  const status = readStatusFile(resolveDataDir(process.env), sessionId);
  if (status === null || !isFresh(status) || !Array.isArray(status.collabs) || status.collabs.length === 0) {
    return '';
  }
  return `协作中：${status.collabs.map((entry) => renderItem(entry)).join(' ｜ ')}`;
}

function statusLineFor(inputText) {
  if (inputText.trim() === '') {
    return '';
  }
  const payload = parseJsonOrNull(inputText);
  const sessionId = typeof payload?.session_id === 'string' ? payload.session_id : '';
  if (sessionId === '' || !ID_PATTERN.test(sessionId)) {
    return '';
  }
  return lineFromStatusFile(sessionId);
}

async function main() {
  try {
    return statusLineFor(await readInput());
  } catch {
    return '';   // 兜底：任何未预期异常都归空输出
  }
}

process.stdout.write(await main());
