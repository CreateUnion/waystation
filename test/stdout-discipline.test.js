import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/* 白名单式拦截：console 只有 error/warn/trace/assert 写 stderr（已实测，允许）；
 * 其余方法（log/info/debug/dir/table/count/group/time/profile 等）与 process.stdout、动态下标访问 console[...]
 * 都写 stdout——一律违例。白名单取反意味着新增 console 方法默认被拦截（保守正确）。 */
const STDOUT_PATTERN = /console\.(?!(?:error|warn|trace|assert)\b)[A-Za-z_$][\w$]*|console\s*\[|process\.stdout/;

/* 扫描豁免（显式、可审）：src/uninstall.js 是 CLI 子命令模块——stdout 是它的用户输出通道、
 * 不是 MCP 协议通道；该模块仅由 bin 在 uninstall 分支动态导入，不参与服务路径（index.js 不引用它）。
 * src/claude-commands.js 是斜杠命令随安装分发的 CLI 模块，同理——stdout 是它的用户/脚本输出通道
 * （安装脚本经进程调用逐行转发），它只 import node 内置模块、不参与服务路径。
 * src/purge.js 是 purge-data 子命令的 CLI 模块，同型——stdout 是它的用户输出通道，
 * 仅由 bin 在 purge-data 分支动态导入，不参与服务路径。
 * src/install-shims.js 是观察窗启动器随安装分发的 CLI 模块，同型——stdout 是它的用户/脚本
 * 输出通道（安装脚本经进程调用逐行转发），只 import node 内置模块、不参与服务路径。
 * src/core-cli.js 是 `waystation core status|stop` 子命令的 CLI 模块，同型——stdout 是它的用户
 * 输出通道，仅由 bin 在 core 分支动态导入；它 import 核心侧模块（IPC 客户端/生命周期原语）但
 * 不参与服务路径（index.js 不引用它）。 */
const STDOUT_EXEMPT_FILES = ['src/uninstall.js', 'src/claude-commands.js', 'src/purge.js', 'src/install-shims.js', 'src/core-cli.js'];

// 目录缺失时返回空列表：起步阶段 src/ 可能尚不存在属预期；终态由下方「扫描非空」断言兜底
function listSourceFiles(relativeDir) {
  const root = join(repoRoot, relativeDir);
  if (!existsSync(root)) {
    return [];
  }
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(join(relativeDir, entry.name)));
    } else if (entry.name.endsWith('.js')) {
      files.push(full);
    }
  }
  return files;
}

test('stdout 纪律 matcher 自检：白名单语义正确（防止扫描本身失灵）', () => {
  assert.equal(STDOUT_PATTERN.test('console.log(1)'), true);
  assert.equal(STDOUT_PATTERN.test('console.debug(1)'), true);
  assert.equal(STDOUT_PATTERN.test('console.table([1])'), true);
  assert.equal(STDOUT_PATTERN.test("console['log'](1)"), true);
  assert.equal(STDOUT_PATTERN.test('process.stdout.write("")'), true);
  assert.equal(STDOUT_PATTERN.test('console.error(1)'), false);
  assert.equal(STDOUT_PATTERN.test('console.warn(1)'), false);
  assert.equal(STDOUT_PATTERN.test('console.trace(1)'), false);
  assert.equal(STDOUT_PATTERN.test('console.assert(1)'), false);
});

test('stdout 纪律：src/ 与 bin/ 中不得出现写 stdout 的 console 方法或 process.stdout（豁免清单除外）', () => {
  const scanned = [...listSourceFiles('src'), ...listSourceFiles('bin')];
  assert.ok(scanned.length >= 1, '未扫描到任何源码文件——扫描根缺失或路径写错，测试不得静默通过');
  const exempt = new Set(STDOUT_EXEMPT_FILES.map((rel) => join(repoRoot, rel)));
  for (const file of exempt) {
    assert.equal(existsSync(file), true, `豁免条目必须指向存在的文件（防清单腐化）：${file}`);
  }
  const offenders = scanned
    .filter((file) => !exempt.has(file))
    .filter((file) => STDOUT_PATTERN.test(readFileSync(file, 'utf8')));
  assert.deepEqual(offenders, []);
});
