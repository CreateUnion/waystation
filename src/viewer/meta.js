/* 元状态取数（口径对齐 local.js 的 localNameOf / localStateOf）：站长席位名一律取台账
 * （localNameOf——名以台账为权威，「已退出」只改状态不改名源）；状态在成员记录为 left 时
 * 取 left（localStateOf 的退出优先），否则取台账状态；成员席位取参与记录的名与态；
 * 两者都不可读 = 未就绪。站长席位在台账缺失时退回参与记录（降级但不静默——状态按成员记录
 * 如实呈现）。「站长席位 + 已退出」此前名取参与记录、与 localNameOf 是两个来源（现形态下
 * 不可达的取数差异），对齐防后续把它当成有意口径。 */
export function metaViewOf(ledger, member) {
  if (member === null) {
    return ledger === null ? null : { name: ledger.name, state: ledger.status };
  }
  if (member.role === 'manager' && ledger !== null) {
    return { name: ledger.name, state: member.state === 'left' ? member.state : ledger.status };
  }
  return { name: member.name, state: member.state };
}
