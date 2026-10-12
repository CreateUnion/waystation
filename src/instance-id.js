import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const INSTANCE_ID_FILE = 'instance-id';

/* 机器实例标识：首跑生成一次、此后终身不变（设计 §5/§14）。
 * 单独成文件而非 config.json 字段：配置是用户可改的整份替换，标识必须结构性地改不掉、不被配置重写波及。
 * 并发保护：'wx' 独占创建——同机并发首跑只有一个创建者成功，输的一方读取胜者的值。 */
export function loadOrCreateInstanceId(dataDir) {
  const file = join(dataDir, INSTANCE_ID_FILE);
  const existing = readExistingId(file);
  if (existing !== null) {
    return existing;
  }
  const id = randomUUID();
  try {
    writeFileSync(file, id + '\n', { flag: 'wx' });
    return id;
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
    const raced = readExistingId(file);
    if (raced !== null) {
      return raced;
    }
    // 存在的文件为空（创建后未写入完成）：视为未生成——补写后回读磁盘值并以其为准
    // （并发首跑下 last-writer-wins 收敛：无论谁最后写入，双方采用的都是磁盘上的同一值）
    writeFileSync(file, id + '\n');
    return readExistingId(file) ?? id;
  }
}

function readExistingId(file) {
  try {
    const text = readFileSync(file, 'utf8').trim();
    return text === '' ? null : text;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}
