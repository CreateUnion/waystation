import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freeMemMBOf, hostResourcesOf, parseProcessListing } from '../src/host-resources.js';

/* #14 资源感知的基础面：内存来自 node:os 的 freemem/totalmem；进程数来自系统进程清单。
 * 清单解析是纯函数（可注入平台与文本），生产默认值另走 tasklist / ps，失败计零不阻断 ws_status。 */

const MIB = 1024 * 1024;

test('hostResourcesOf：freemem/totalmem 换算为取整 MB，字段形状固定', () => {
  const resources = hostResourcesOf({
    freeMemBytesOf: () => 1536.6 * MIB,
    totalMemBytesOf: () => 8192 * MIB,
    processList: '',
  });
  assert.deepEqual(resources, {
    freeMemMB: 1537,
    totalMemMB: 8192,
    claudeProcs: 0,
    nodeProcs: 0,
  });
});

test('进程清单解析：Windows tasklist CSV 按进程名计数（大小写不敏感）', () => {
  const listing = [
    '"claude.exe","100","Console","1","1,000 K"',
    '"node.exe","101","Console","1","1,000 K"',
    '"Node.EXE","102","Console","1","1,000 K"',
    '"notepad.exe","103","Console","1","1,000 K"',
    '',
  ].join('\r\n');
  assert.deepEqual(parseProcessListing(listing, 'win32'), { claudeProcs: 1, nodeProcs: 2 });
});

test('进程清单解析：POSIX ps 输出按 basename 计数，只认 claude / node 前缀', () => {
  const listing = [
    'node',
    'claude',
    'python3',
    '/usr/local/bin/node',
    'claudia',
    'node_exporter',
  ].join('\n');
  assert.deepEqual(parseProcessListing(listing, 'linux'), { claudeProcs: 1, nodeProcs: 2 });
});

test('进程清单为空 / 缺失 / 乱码：计零，不抛错', () => {
  for (const listing of ['', undefined, null, '\r\n\n', '???,,,']) {
    assert.deepEqual(parseProcessListing(listing, 'win32'), { claudeProcs: 0, nodeProcs: 0 }, String(listing));
  }
});

test('freeMemMBOf：按注入的 freemem 取整 MB', () => {
  assert.equal(freeMemMBOf(() => 2.5 * MIB), 3);
  assert.equal(freeMemMBOf(() => 0), 0);
});

test('hostResourcesOf：真实环境返回有限非负字段（进程清单失败时计零）', () => {
  const resources = hostResourcesOf();
  assert.equal(Number.isFinite(resources.freeMemMB) && resources.freeMemMB >= 0, true);
  assert.equal(Number.isFinite(resources.totalMemMB) && resources.totalMemMB > 0, true);
  assert.equal(Number.isInteger(resources.claudeProcs) && resources.claudeProcs >= 0, true);
  assert.equal(Number.isInteger(resources.nodeProcs) && resources.nodeProcs >= 0, true);
});

test('hostResourcesOf：进程清单短时缓存——连续调用仍返回同一形状', () => {
  const first = hostResourcesOf();
  const second = hostResourcesOf();
  assert.deepEqual(Object.keys(second).sort(), ['claudeProcs', 'freeMemMB', 'nodeProcs', 'totalMemMB']);
  assert.equal(second.totalMemMB, first.totalMemMB, '缓存窗口内总内存不变');
  assert.equal(Number.isInteger(second.claudeProcs) && Number.isInteger(second.nodeProcs), true);
});
