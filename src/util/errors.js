/* 工具面错误响应契约（单一权威）：失败一律 { ok:false, code, message, hint }。
 * code 是稳定的机器可读标识（kebab-case），message 是给人看的描述，hint 是下一步怎么修；
 * 成功载荷不经本模块——各工具成功返回结构保持原样。
 *
 * 为什么把 hint 放在核心侧：调用方往往是另一个会话的模型，只拿到「不在线或不可见」无法判断
 * 该重试、该重连桥还是该换目标；修复建议必须和失败事实同一出处，避免文档与实现漂移。
 * 桥与核心共用本模块：核心不可达等桥侧差错与工具内失败因此同构。 */

export const FALLBACK_ERROR_CODE = 'request-rejected';

export const FALLBACK_ERROR_HINT = '按 message 修正后重试；若为业务状态变化，先用只读工具（ws_status / ws_list_collabs）核实当前状态。';

/* code → 修复建议。新增 code 必须在这里配一句可执行建议；调用点可传更具体的 hint 覆盖。 */
export const ERROR_HINTS = Object.freeze({
  'request-rejected': FALLBACK_ERROR_HINT,

  /* dispatch 域：调度生命周期与权限 */
  'dispatch-lost': '调用 ws_status 确认调度是否已结束或核心是否重启；需要继续编排，请由调度长重新创建（ws_create_collab { mode: "dispatch" }）。',
  'dispatch-taken-over': '调用 ws_status / ws_list_collabs 确认现任调度长；旧调度长不要再派发，改由现任调度长操作。',
  'dispatch-master-required': '调度（dispatch）只允许启动期 WAYSTATION_ROLE=master 的会话操作；请用调度长会话重试（工具参数无法声明角色）。',
  'dispatch-master-active': '现任调度长仍在线（心跳未超时）：等待其心跳超时后再接管，或让现任调度长结束调度。',
  'dispatch-already-created': '直接复用现有调度（ws_status 可查 collabId）；一个核心同一时刻只允许一个调度。',
  'dispatch-master-cannot-leave': '调度长不能 leave：整体结束请用 ws_end_collab。',
  'dispatch-targets-refused': '调度（dispatch）不接受 targets / to / toSessionId；首建后用 ws_dispatch_claim 收编，定向用 toSessionIds。',
  'dispatch-field-refused': '这些字段只用于调度（dispatch）模式：managed / forum 请用 to + toSessionId，调度请用 toSessionIds / taskId。',
  'invalid-dispatch-name': '名称需 1–64 字符且不含控制字符；缩短或去掉控制字符后重试。',
  'invalid-topic': '主题需不超过 200 字符；缩短后重试（调度可省略 topic）。',

  /* dispatch 域：收编 */
  'session-not-visible': '目标会话不在本机注册表：确认会话仍在运行且 waystation 桥已连接；让该会话调用任意 ws_* 工具重连，仍不行则重启该会话的 waystation 桥。',
  'bridge-stale': '目标会话的桥连接已断或已过期：让该会话调用任意 ws_* 工具触发桥重连；仍不行则重启该会话的 waystation 桥（重开 MCP 连接）。',
  'session-id-required': '本会话没有会话标识：请从带 CLAUDE_CODE_SESSION_ID 的 Claude Code 会话调用；重开该会话的 MCP 连接后重试。',
  'invalid-session-ids': '提供 1–32 项非空会话标识（取自 ws_dispatch_scan 的 sessionCode 或 sessionId）。',
  'invalid-session-id': '提供非空会话标识（取自 ws_dispatch_scan 的 sessionCode 或 sessionId）。',
  'invalid-claim-id': 'claimId 需为非空字符串（取自收编返回或核心注入的确认提示）。',
  'claim-rejected': '收编被拒：先看 message 中的原因；只收编 ws_dispatch_scan 里 claimable: true 的会话，必要时按提示调整目标。',
  'claim-not-found': '收编申请可能已过期或已处置：让调度长重新 ws_dispatch_claim，目标会话再走 approve。',
  'claim-not-yours': '只有被收编的目标会话能确认：核对 sessionCode 后让目标会话调用 ws_dispatch_approve。',
  'claim-expired': '收编申请已超过 10 分钟：请调度长重新发起 ws_dispatch_claim。',
  'invalid-approve': 'approve 必须是布尔值 true / false。',
  'confirm-token-invalid': '重新调用 ws_dispatch_approve（不带 confirmToken）获取新令牌，向用户确认后携新令牌重试。',

  /* dispatch 域：消息与回执 */
  'dispatch-empty': '当前没有已收编组员：先 ws_dispatch_scan 扫描并用 ws_dispatch_claim 收编，再发送消息。',
  'target-not-in-dispatch': '目标不在当前调度：核对 ws_status 的 dispatch.slaves.sessionCode；不在册则先收编。',
  'not-dispatch-member': '本会话不是该调度成员：确认 collabId 正确；需要参与请由调度长收编。',
  'slave-target-refused': '组员只能回复调度长：省略 toSessionIds 即回调度长，不要给其他组员发消息。',
  'session-not-in-dispatch': '目标不在当前调度：用 ws_status 的 dispatch.slaves.sessionCode 核对后重试。',
  'invalid-require-ack': 'requireAck 需要布尔值；仅调度长发出的 task 可以要求回执。',
  'invalid-message-text': 'text 需为非空白字符串（≤4000 字符）；带 report 时可为空串或省略。',
  'invalid-message-type': '调度的 type 只能是 task / progress / result / error。',
  'invalid-task-id': 'taskId 需为 1–64 字符的非空白字符串。',
  'message-too-long': '把长内容写文件，消息里只发摘要 + 文件路径；阈值见 config.dispatch.message_limits（progress 800 / result 3000 / text 4000，范围 64–20000）。',
  'report-not-allowed': 'report 仅用于调度（dispatch）的 progress / result；其他模式或类型请把内容写进 text。',
  'invalid-report': 'report 形态：{ summary?: ≤200 字符, done?: 字符串数组, blockers?: 字符串数组, next?: 字符串数组 }（各数组 ≤20 项、单项 ≤200 字符）。',
  'evidence-not-allowed': 'evidence 仅用于调度（dispatch）的 result。',
  'invalid-evidence': 'evidence 形态：{ commit?: 字符串, tests?: { pass, fail, command? }, artifacts?: 字符串数组, gates?: 字符串数组 }，逐项校验、未知字段拒绝。',
  'acceptance-not-allowed': 'acceptance 仅用于调度（dispatch）的 task。',
  'invalid-acceptance': 'acceptance 需为 1–20 项非空字符串（验收标准）。',
  'require-ack-not-allowed': 'requireAck 仅适用于调度长发出的 task 消息；其他角色或类型请去掉该字段。',
  'task-table-full': '任务表已达上限：先完成或清理在途任务，或换一个 taskId。',
  'invalid-ack-for': 'ackFor 需要消息标识（1–64 位字母数字与连字符，取自回执指引）。',
  'ack-for-conflict': 'ackFor 是独立回执动作：不要与 type / toSessionIds / taskId / requireAck 同时使用。',
  'ack-not-found': '该回执没有对应的待确认消息：可能已确认或已超时；核对 msgId 或让调度长重新发送。',
  'ack-not-yours': '只有该消息的目标会话能回执：核对本会话 sessionCode 与消息目标。',

  /* 核心与桥的常见失败 */
  'core-unavailable': '核心不可达或重启中：稍后重试；多次失败请检查 ~/.waystation/run/core.json 与核心日志，或重启核心（桥会尝试冷启）。',
  'core-starting': '核心正在启动：等几秒重试；长时间无响应请检查 run/core.json 与启动日志。',
  'core-changeover': '核心正在换代：等数秒后重试，数据不会丢失。',
  'core-startup-failed': '核心启动失败：查看核心日志与 run/core.json 的 startupError，处理后重试。',
  'core-version-unsupported': '当前核心版本不支持该能力：升级 waystation 并重开会话（核心与桥版本需一致）。',
  'tool-timeout': '操作可能仍在后台继续：稍后用 ws_status / ws_list_collabs 核实，避免立即重复写操作。',
  'unknown-tool': '工具名未知：调用 tools/list 核对可用工具与版本。',
  'internal-error': '工具执行异常：查看核心日志；如可复现请记录工具名与参数。',
  'user-confirmation-required': '这是需要用户确认的中间态，不是失败：先向用户转述请求，取得明确同意后携 confirmToken 重试。',
  'probe-failed': '探测失败：确认对端驿站在线、地址与端口取自 ws_list_hosts；仍失败请检查局域网连通性。',
  'network-scan-failed': '局域网扫描失败：确认本机网络与端口可用，稍后重试；仍失败请查看核心日志。',
  'invalid-view': 'view 只接受 "compact"（缺省）或 "full"；完整计数器请用 ws_status { view: "full" }。',

  /* 其他既有域错误码（经 resultOf 透传） */
  'forum-no-invite': '讨论（forum）模式没有邀请簿记：加入 / 同意 / 拒绝走 ws_join 与 ws_approve_invite 的成员事件路径，不要使用 inviteId。',
});

const ERROR_CODE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isErrorCode(value) {
  return typeof value === 'string' && ERROR_CODE_PATTERN.test(value);
}

/* 失败载荷归一：非法/缺失 code 落到兜底 code；message 缺失时给一句通用描述；
 * 未显式给 hint 时取该 code 的登记建议，保证每个对外错误都可操作。 */
export function errorOf(code, message, hint) {
  const normalizedCode = isErrorCode(code) ? code : FALLBACK_ERROR_CODE;
  return {
    ok: false,
    code: normalizedCode,
    message: typeof message === 'string' && message.trim() !== '' ? message : '请求失败',
    hint: typeof hint === 'string' ? hint : (ERROR_HINTS[normalizedCode] ?? FALLBACK_ERROR_HINT),
  };
}

/* 服务层失败结果 → 对外错误载荷：保留结果里的附加字段（兼容旧调用方），
 * 再覆盖统一的 ok / code / message / hint 四字段。 */
export function errorPayloadOf(result) {
  return { ...(result ?? {}), ...errorOf(result?.code, result?.message, result?.hint) };
}

export function errorResultOf(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true };
}
