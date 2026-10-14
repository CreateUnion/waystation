/* 呈现文本的字符策略（终端查看器与 Web 观察窗共用——单一权威，防两个查看器口径漂移）。
 *
 * 控制类（C0 / DEL / C1，含可作终端 CSI 的 U+009B）与格式类（Cf——双向文本重排、零宽类，
 * Trojan Source 一类）字符剔除：远程内容不可信，终端控制与显示重排一律不得进查看器输出。
 * U+200D（零宽连接符）同属 Cf 但有意保留：ZWJ emoji 组合序列靠它成串，剥掉会把一个合法表情
 * 拆散——渲染失真的代价高于该字符本身的可滥用面。
 * 换行类字符（LF / CR / U+2028 / U+2029）按呈现形态分口径：
 * 'marker'（终端）：替换为 ⏎——一帖一行是两栏形态的约束；
 * 'keep'（Web）：归一为 \n 后保留——网页按换行自然断行；\r\n 须先行整体归一，
 * 逐字符分头换算会把 CRLF 变成两个换行。 */

const CONTROL_OR_FORMAT = /^[\p{Cc}\p{Cf}]$/u;
const ZERO_WIDTH_JOINER = '\u200d';

/**
 * 正文按呈现形态转写：控制 / 格式类字符一律剔除，换行类字符按 newlines 口径处理。
 * @param {string} text 原始正文
 * @param {{ newlines: 'marker' | 'keep' }} options 换行口径——'marker'：换行替换为 ⏎（终端单行帖流）；
 *   'keep'：换行（\r\n、孤立 \r、U+2028 / U+2029）归一为 \n 后保留（Web 渲染按换行断行）
 * @returns {string} 可呈现文本
 */
export function displayText(text, { newlines }) {
  const source = newlines === 'keep' ? text.replace(/\r\n|[\r\u2028\u2029]/g, '\n') : text;
  let presented = '';
  for (const char of source) {
    const code = char.codePointAt(0);
    if (code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029) {
      presented += newlines === 'keep' ? '\n' : '⏎';
    } else if (char === ZERO_WIDTH_JOINER || !CONTROL_OR_FORMAT.test(char)) {
      presented += char;
    }
  }
  return presented;
}
