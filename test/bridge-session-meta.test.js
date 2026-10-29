import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir } from './helpers.js';
import { bridgeMetaOf, createSessionMetaWatcher, readClaudeSessionMeta } from '../src/bridge/session-meta.js';

/* 桥侧 Claude 会话元数据读取的判别测试：按内容 sessionId 匹配（文件名是 PID，不可命中桥的
 * MCP 子进程）、坏文件与缺字段回退、角色只认环境变量、watcher 变化即上报一次。 */

test('按内容 sessionId 匹配，不按文件名 PID；CLAUDE_CONFIG_DIR 优先', (t) => {
  const root = makeTempDir(t);
  const dir = join(root, 'sessions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '999.json'), JSON.stringify({
    sessionId: 'sess-a', name: 'worker-1', kind: 'interactive', entrypoint: 'cli', status: 'idle',
  }));
  const meta = readClaudeSessionMeta({ env: { CLAUDE_CONFIG_DIR: root }, sessionId: 'sess-a', now: Date.now() });
  assert.equal(meta.name, 'worker-1');
  assert.equal(meta.kind, 'interactive');
  assert.equal(meta.entrypoint, 'cli');
});

test('无匹配 / 坏 JSON / 缺 sessionId 返回 null；角色只认环境变量', (t) => {
  const root = makeTempDir(t);
  mkdirSync(join(root, 'sessions'), { recursive: true });
  writeFileSync(join(root, 'sessions', '1.json'), '{bad json');
  assert.equal(readClaudeSessionMeta({ env: { CLAUDE_CONFIG_DIR: root }, sessionId: 'sess-a' }), null);
  const meta = bridgeMetaOf({ env: { WAYSTATION_ROLE: 'master', WAYSTATION_MASTER: ' boss ' }, sessionId: 'sess-a' });
  assert.equal(meta.role, 'master');
  assert.equal(meta.masterName, 'boss');
  assert.equal(meta.kind, 'unknown');
  assert.equal(bridgeMetaOf({ env: { WAYSTATION_ROLE: 'root' }, sessionId: 'sess-a' }).role, 'none');
});

test('watcher：文件变化时上报一次', async (t) => {
  const root = makeTempDir(t);
  const dir = join(root, 'sessions');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, '1.json');
  writeFileSync(file, JSON.stringify({ sessionId: 'sess-a', name: 'before', kind: 'interactive' }));
  const changes = [];
  const watcher = createSessionMetaWatcher({
    env: { CLAUDE_CONFIG_DIR: root }, sessionId: 'sess-a', intervalMs: 10,
    onChange: (meta) => changes.push(meta),
  });
  t.after(() => watcher.close());
  writeFileSync(file, JSON.stringify({ sessionId: 'sess-a', name: 'after', kind: 'interactive' }));
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(changes.some((meta) => meta.name === 'after'), true);
});
