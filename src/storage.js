import { appendFileSync, closeSync, ftruncateSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/* JSONL 存储层（设计 §15 定案的两条写入路径）：
 *   追加写——台账 / 队列 / 流水；整体替换——config.json / 快照。
 * 写入类接口失败向上抛错：是否兜底（绝不因写盘失败退出进程）由调用方按模块语境决定。 */

/** 追加写：一次 appendFileSync 写入「序列化 + 换行」，单次调用把半行窗口压到最小。
 * 两道写前守卫：顶层只收非 null 对象（标量、undefined、函数等一律抛出——静默写 "undefined"
 * 会变成下次读取的坏行，标量则不是本存储的条目形态）；序列化结果再查 undefined / 字面 "null"
 * （toJSON 能绕过形态守卫，而 "null" 行会被 loadLines 判为坏行）。序列化只做一次、结果复用 */
export function appendLine(filePath, value) {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('appendLine：值必须是非 null 对象');
  }
  const json = JSON.stringify(value);
  if (json === undefined || json === 'null') {
    throw new TypeError('appendLine：序列化结果为 undefined 或 null——值必须可序列化为非 null JSON');
  }
  appendFileSync(filePath, json + '\n');
}

/**
 * 读全部完整行（设计 §13：尾部半写 → 截断至最后完整行、丢尾条）。
 * 尾部半行：上报 tailDropped 并把文件截断到最后一条完整行（修复，避免后续追加粘连成坏行）；
 * 中间坏行：完整但不可解析（含字面 null）→ 计入 corruptLines 上报，不改动文件——
 * 结构性损坏的重建（保留副本 + 从快照恢复）属后续台账层实现，本层只提供事实。
 * 并发约定：单写者（同一文件同一时刻只有一个写入者；使用流程为先 loadLines 后 appendLine）。
 */
export function loadLines(filePath) {
  let raw = null;
  try {
    raw = readFileSync(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { entries: [], tailDropped: false, corruptLines: [] };
    }
    throw error;
  }
  // 文件大小以原始字节为准（raw.length）：被截断的多字节字符在 utf8 解码后变成替换符（U+FFFD），
  // 重编码长度会变——不能用解码串换算，否则守卫永远判「文件已变」而放弃修复
  const content = raw.toString('utf8');
  const loaded = { entries: [], tailDropped: false, corruptLines: [] };
  let complete = content;
  if (content !== '' && !content.endsWith('\n')) {
    complete = content.slice(0, content.lastIndexOf('\n') + 1);
    loaded.tailDropped = true;
    truncateTo(filePath, complete, raw.length);
  }
  const lines = complete.split('\n');
  lines.pop(); // 收尾换行切出的空串
  for (let index = 0; index < lines.length; index++) {
    const text = lines[index];
    if (text.trim() === '') {
      continue;
    }
    const parsed = parseLine(text);
    if (parsed.ok) {
      loaded.entries.push(parsed.value);
    } else {
      loaded.corruptLines.push({ lineNumber: index + 1, text });
    }
  }
  return loaded;
}

/**
 * 整体替换：同目录临时文件写全 + rename 覆盖（同卷 rename 在 Windows/Linux 均覆盖既有文件）。
 * 崩溃最坏情形是留下一份孤儿临时文件，目标文件永远是完整旧版或完整新版。
 */
export function replaceFile(filePath, content) {
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, content);
    renameSync(tempPath, filePath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

/** 整体替换为 JSON 文本（config.json / 快照）。
 * 两道写前守卫：顶层非 null 对象——JSON.stringify(undefined) 返回 undefined，拼上换行
 * 会把文件替换成字面 "undefined"，原子替换落盘即不可回头，必须写前拦截；
 * 序列化结果再查 undefined / 字面 "null"（toJSON 能绕过形态守卫）。序列化只做一次、结果复用 */
export function writeJsonAtomic(filePath, value) {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('writeJsonAtomic：值必须是非 null 对象');
  }
  const json = JSON.stringify(value, null, 2);
  if (json === undefined || json === 'null') {
    throw new TypeError('writeJsonAtomic：序列化结果为 undefined 或 null——值必须可序列化为非 null JSON');
  }
  replaceFile(filePath, json + '\n');
}

function parseLine(text) {
  try {
    const value = JSON.parse(text);
    if (value === null) {
      return { ok: false };
    }
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

/* 按字节截断（多字节中文下字符串长度 ≠ 字节数，必须换算）。
 * 修复前核对文件大小仍等于读取时的大小（originalBytes 由调用方传读取到的原始字节数）：
 * 单写者约定下的防御——若有并发写者在读取与截断之间追加了完整行，只放弃本次修复
 * （宁留半行不吞正确数据）。
 * 截断失败只影响修复，不影响本次读取结果——下次读取会再试 */
function truncateTo(filePath, complete, originalBytes) {
  const bytes = Buffer.byteLength(complete, 'utf8');
  try {
    if (statSync(filePath).size !== originalBytes) {
      return;
    }
    const fd = openSync(filePath, 'r+');
    try {
      ftruncateSync(fd, bytes);
    } finally {
      closeSync(fd);
    }
  } catch {
    // 修复失败保持原样，由下一次读取重试
  }
}
