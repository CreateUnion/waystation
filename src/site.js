/* 站点域（设计 §13 多站点，模型 A）：一台机器上的每个驿站进程 = 一个站点——
 * 独立数据目录 + 独立站点实例标识 + 独立 LAN 端口。本模块先落「锚点与槽位数学」；
 * 槽位解析（resolveSite）在同期的解析任务中追加于此。
 * 「默认端口」为内置常量：各端一致、不随任何配置变化——它是广播锚点与槽位段的基准
 * （发布前登记见设计 §18；数值的唯一权威源即本文件，config 的默认值引用它）。 */
export const ANCHOR_PORT = 7321;
export const SLOT_COUNT = 8;

/** 槽位 k（1..SLOT_COUNT）的默认端口：锚点起的连续段，槽位 1 = 锚点本身。
 * 非法槽位一律抛错（与路径层同思路：不做清洗，让编程错误当场显形）。 */
export function slotDefaultPort(slot) {
  if (!Number.isInteger(slot) || slot < 1 || slot > SLOT_COUNT) {
    throw new TypeError(`槽位非法（应为 1–${SLOT_COUNT} 的整数）：${String(slot)}`);
  }
  return ANCHOR_PORT + slot - 1;
}
