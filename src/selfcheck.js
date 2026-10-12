import { randomUUID } from 'node:crypto';
import { unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/* 启动自检（设计 §13）：在目标目录真实落盘一个探针文件后删除。
 * 磁盘满 / 目录权限不足 / 路径非法都会在这一步暴露——成功即证明「能建文件、能写内容」。
 * 返回结果而非抛错：是否拒绝服务、如何报错由启动序列决定。 */
export function checkWritableDir(dir) {
  const probe = join(dir, `.write-probe-${process.pid}-${randomUUID()}`);
  try {
    writeFileSync(probe, 'waystation write probe\n');
  } catch (error) {
    return { ok: false, message: `无法写入目录 ${dir}（${error.message}），请检查目录权限与磁盘空间` };
  }
  try {
    unlinkSync(probe);
  } catch {
    // 探针残留不影响判定，下次启动不会再撞名（名字含随机 UUID）
  }
  return { ok: true, message: '' };
}
