/* dispatch 消息机制化字段（问题 2-B / 5-A / 5-C）：report / evidence / acceptance 的
 * 形态校验与人类可读渲染。纯数据助手——无文件、网络或服务依赖，工具层（参数预检）、
 * 协作服务（业务判定与投递文本）与持久化层（状态文件校验）共用同一套口径，避免三处漂移。
 *
 * 校验一律「严格形态、明确理由、失败不静默」：未知键、超长项、超量数组都拒绝，调用方
 * 按键修正；渲染只负责把已校验的数据变成人可读文本。 */

export const DISPATCH_REPORT_ITEM_MAX_CHARS = 200;
export const DISPATCH_REPORT_ARRAY_MAX = 20;
export const DISPATCH_ACCEPTANCE_MAX = 20;
export const DISPATCH_EVIDENCE_ARRAY_MAX = 20;
export const DISPATCH_EVIDENCE_ITEM_MAX_CHARS = 500;
export const DISPATCH_EVIDENCE_COMMIT_MAX_CHARS = 128;
export const DISPATCH_EVIDENCE_COMMAND_MAX_CHARS = 1000;
const DISPATCH_EVIDENCE_COUNT_MAX = 1000000000;

const REPORT_KEYS = ['summary', 'done', 'blockers', 'next'];
const EVIDENCE_KEYS = ['commit', 'tests', 'artifacts', 'gates'];
const EVIDENCE_TEST_KEYS = ['pass', 'fail', 'command'];
const REPORT_ARRAY_KEYS = ['done', 'blockers', 'next'];

/** @returns {{ ok: true, value: object } | { ok: false, reason: string }} */
export function validateReport(value) {
  if (!isPlainObject(value)) {
    return invalid('需要对象 { summary?, done?, blockers?, next? }');
  }
  const unknown = Object.keys(value).find((key) => !REPORT_KEYS.includes(key));
  if (unknown !== undefined) {
    return invalid(`未知字段 ${unknown}（可用 summary / done / blockers / next）`);
  }
  const summary = validateOptionalText(value.summary, DISPATCH_REPORT_ITEM_MAX_CHARS, 'summary');
  if (summary.ok === false) {
    return summary;
  }
  const arrays = validateReportArrays(value);
  if (arrays.ok === false) {
    return arrays;
  }
  const normalized = arrays.value;
  if (summary.value !== undefined) {
    normalized.summary = summary.value;
  }
  if (!reportHasContent(normalized)) {
    return invalid('报告为空：summary / done / blockers / next 至少给一项');
  }
  return { ok: true, value: normalized };
}

/** @returns {{ ok: true, value: Record<string, any> } | { ok: false, reason: string }} */
function validateReportArrays(value) {
  /** @type {Record<string, any>} */
  const normalized = {};
  for (const key of REPORT_ARRAY_KEYS) {
    const checked = validateStringArray(value[key], {
      label: key,
      maxItems: DISPATCH_REPORT_ARRAY_MAX,
      maxItemChars: DISPATCH_REPORT_ITEM_MAX_CHARS,
    });
    if (checked.ok === false) {
      return checked;
    }
    if (checked.value !== undefined) {
      normalized[key] = checked.value;
    }
  }
  return { ok: true, value: normalized };
}

function reportHasContent(report) {
  if (typeof report.summary === 'string' && report.summary !== '') {
    return true;
  }
  return REPORT_ARRAY_KEYS.some((key) => (report[key]?.length ?? 0) > 0);
}

/** @returns {{ ok: true, value: object } | { ok: false, reason: string }} */
export function validateEvidence(value) {
  if (!isPlainObject(value)) {
    return invalid('需要对象 { commit?, tests?, artifacts?, gates? }');
  }
  const unknown = Object.keys(value).find((key) => !EVIDENCE_KEYS.includes(key));
  if (unknown !== undefined) {
    return invalid(`未知字段 ${unknown}（可用 commit / tests / artifacts / gates）`);
  }
  const fields = validateEvidenceFields(value);
  if (fields.ok === false) {
    return fields;
  }
  if (!evidenceHasContent(fields.value)) {
    return invalid('证据为空：commit / tests / artifacts / gates 至少给一项');
  }
  return { ok: true, value: fields.value };
}

/** @returns {{ ok: true, value: Record<string, any> } | { ok: false, reason: string }} */
function validateEvidenceFields(value) {
  /** @type {Record<string, any>} */
  const normalized = {};
  const checks = {
    commit: validateOptionalText(value.commit, DISPATCH_EVIDENCE_COMMIT_MAX_CHARS, 'commit'),
    tests: validateEvidenceTests(value.tests),
    artifacts: validateEvidenceArray(value.artifacts, 'artifacts'),
    gates: validateEvidenceArray(value.gates, 'gates'),
  };
  for (const [key, checked] of Object.entries(checks)) {
    if (checked.ok === false) {
      return checked;
    }
    if (checked.value !== undefined) {
      normalized[key] = checked.value;
    }
  }
  return { ok: true, value: normalized };
}

function validateEvidenceArray(value, label) {
  return validateStringArray(value, {
    label,
    maxItems: DISPATCH_EVIDENCE_ARRAY_MAX,
    maxItemChars: DISPATCH_EVIDENCE_ITEM_MAX_CHARS,
  });
}

/** @returns {{ ok: true, value: { pass: number, fail: number, command?: string } | undefined } | { ok: false, reason: string }} */
function validateEvidenceTests(value) {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (!isPlainObject(value)) {
    return invalid('tests 需要对象 { pass, fail, command? }');
  }
  const unknown = Object.keys(value).find((key) => !EVIDENCE_TEST_KEYS.includes(key));
  if (unknown !== undefined) {
    return invalid(`tests 含未知字段 ${unknown}（可用 pass / fail / command）`);
  }
  const pass = validateCount(value.pass, 'tests.pass');
  if (pass.ok === false) {
    return pass;
  }
  const fail = validateCount(value.fail, 'tests.fail');
  if (fail.ok === false) {
    return fail;
  }
  const command = validateOptionalText(value.command, DISPATCH_EVIDENCE_COMMAND_MAX_CHARS, 'tests.command');
  if (command.ok === false) {
    return command;
  }
  return {
    ok: true,
    value: {
      pass: pass.value,
      fail: fail.value,
      ...(command.value === undefined ? {} : { command: command.value }),
    },
  };
}

/** @returns {{ ok: true, value: number } | { ok: false, reason: string }} */
function validateCount(value, label) {
  return Number.isInteger(value) && value >= 0 && value <= DISPATCH_EVIDENCE_COUNT_MAX
    ? { ok: true, value }
    : invalid(`${label} 需为非负整数`);
}

function evidenceHasContent(evidence) {
  if (typeof evidence.commit === 'string') {
    return true;
  }
  if (isPlainObject(evidence.tests)) {
    return true;
  }
  return (evidence.artifacts?.length ?? 0) > 0 || (evidence.gates?.length ?? 0) > 0;
}

/** acceptance：1–20 项非空字符串（单项长度由消息总长度上限兜底）。 */
/** @returns {{ ok: true, value: string[] } | { ok: false, reason: string }} */
export function validateAcceptance(value) {
  if (!Array.isArray(value)) {
    return invalid('需要字符串数组');
  }
  if (value.length === 0 || value.length > DISPATCH_ACCEPTANCE_MAX) {
    return invalid(`需要 1–${DISPATCH_ACCEPTANCE_MAX} 项`);
  }
  const items = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      return invalid('每项须为非空字符串');
    }
    items.push(item.trim());
  }
  return { ok: true, value: items };
}

/** 可选的文本字段：未给＝undefined；给了必须是非空字符串且不超长。
 * @returns {{ ok: true, value: string | undefined } | { ok: false, reason: string }} */
function validateOptionalText(value, maxChars, label) {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (typeof value !== 'string') {
    return invalid(`${label} 需为字符串`);
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return invalid(`${label} 不得为空`);
  }
  if (trimmed.length > maxChars) {
    return invalid(`${label} 超过 ${maxChars} 字符`);
  }
  return { ok: true, value: trimmed };
}

/** 可选字符串数组：未给＝undefined；给了必须是数组，逐项非空且不超长。
 * @returns {{ ok: true, value: string[] | undefined } | { ok: false, reason: string }} */
function validateStringArray(value, { label, maxItems, maxItemChars }) {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (!Array.isArray(value)) {
    return invalid(`${label} 需为字符串数组`);
  }
  if (value.length > maxItems) {
    return invalid(`${label} 至多 ${maxItems} 项`);
  }
  const items = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      return invalid(`${label} 每项须为非空字符串`);
    }
    const trimmed = item.trim();
    if (trimmed.length > maxItemChars) {
      return invalid(`${label} 单项不得超过 ${maxItemChars} 字符`);
    }
    items.push(trimmed);
  }
  return { ok: true, value: items };
}

/* —— 人类可读渲染（投递文本） —— */

export function renderReport(report) {
  const lines = [];
  if (report.summary !== undefined) {
    lines.push(`摘要：${report.summary}`);
  }
  appendListLines(lines, '已完成', report.done);
  appendListLines(lines, '受阻', report.blockers);
  appendListLines(lines, '下一步', report.next);
  return lines.join('\n');
}

export function renderAcceptance(acceptance) {
  return ['验收标准：', ...acceptance.map((item) => `- ${item}`)].join('\n');
}

export function renderEvidence(evidence) {
  const lines = ['证据：'];
  if (evidence.commit !== undefined) {
    lines.push(`- commit：${evidence.commit}`);
  }
  if (evidence.tests !== undefined) {
    const command = evidence.tests.command === undefined ? '' : `（${evidence.tests.command}）`;
    lines.push(`- 测试：${evidence.tests.pass} 通过 / ${evidence.tests.fail} 失败${command}`);
  }
  appendListLines(lines, '产物', evidence.artifacts);
  appendListLines(lines, '门禁', evidence.gates);
  return lines.join('\n');
}

function appendListLines(lines, label, items) {
  if (!Array.isArray(items) || items.length === 0) {
    return;
  }
  lines.push(`${label}：`);
  for (const item of items) {
    lines.push(`- ${item}`);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @returns {{ ok: false, reason: string }} */
function invalid(reason) {
  return { ok: false, reason };
}
