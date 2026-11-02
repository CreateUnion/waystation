import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createToolCatalog } from '../src/bridge/tool-catalog.js';
import { createBridgeRuntime } from '../src/bridge/main.js';
import { createMcpServer } from '../src/server.js';
import { makeTempDir, waitFor } from './helpers.js';

/* 已开会话的桥热刷新工具目录（core 换代后无需 /mcp 重连）：
 * 安装树 specs.js 变化 → 桥重新载入 TOOL_SPECS → registry.list 返回新目录 →
 * MCP 客户端收到 tools/list_changed 后重新拉取。 */

const QUIET_LOG = { info: () => {}, warn: () => {}, error: () => {} };

function writeSpecs(file, name) {
  writeFileSync(file, `export const TOOL_SPECS = [{ name: '${name}', description: '${name}', inputSchema: { type: 'object' } }];\n`, 'utf8');
  /* 显式推进 mtime：Windows 文件系统时间戳粒度可能让连续写落同一毫秒，热刷新会误判未变化。 */
  const future = new Date(Date.now() + 5000);
  utimesSync(file, future, future);
}

function catalogOf(t, initialSpecs) {
  const dir = makeTempDir(t);
  const file = join(dir, 'specs.mjs');
  writeSpecs(file, 'v1');
  let loads = 0;
  const catalog = createToolCatalog({
    specsUrl: pathToFileURL(file),
    initialSpecs,
    initialStamp: { mtimeMs: 0, size: 0 },
    load: async (url, stamp) => {
      loads += 1;
      const fresh = `${url.href}?v=${Math.round(stamp.mtimeMs)}-${stamp.size}-${loads}`;
      const module = await import(fresh);
      return module.TOOL_SPECS;
    },
    log: QUIET_LOG,
  });
  return { file, catalog, loads: () => loads };
}

test('工具目录热刷新：文件变化后重新载入；force 可无视时间戳强制重载', async (t) => {
  const old = [{ name: 'old', description: 'old', inputSchema: { type: 'object' } }];
  const { file, catalog, loads } = catalogOf(t, old);
  assert.equal(catalog.list()[0].name, 'old', '初始目录＝桥启动时载入的旧目录');

  const first = await catalog.refresh();
  assert.equal(first.changed, true, '文件已变化：首次刷新载入 v1');
  assert.equal(catalog.list()[0].name, 'v1');
  assert.equal(loads(), 1);

  const unchanged = await catalog.refresh();
  assert.equal(unchanged.changed, false, '文件未变化不重复载入');
  assert.equal(loads(), 1);

  writeSpecs(file, 'v2');
  const second = await catalog.refresh();
  assert.equal(second.changed, true);
  assert.equal(catalog.list()[0].name, 'v2');
  assert.equal(loads(), 2);

  const forced = await catalog.refresh({ force: true });
  assert.equal(forced.changed, false, '强制重读但内容未变：不通知客户端');
  assert.equal(loads(), 3, 'force 无视时间戳确实重新读取了文件');
  assert.equal(catalog.list()[0].name, 'v2');
});

test('工具目录热刷新：非法新目录 / 文件缺失时保留旧目录并给出原因', async (t) => {
  const old = [{ name: 'old', description: 'old', inputSchema: { type: 'object' } }];
  const { file, catalog } = catalogOf(t, old);
  await catalog.refresh();
  assert.equal(catalog.list()[0].name, 'v1');

  writeFileSync(file, 'export const TOOL_SPECS = [];\n', 'utf8');
  const future = new Date(Date.now() + 10000);
  utimesSync(file, future, future);
  const invalid = await catalog.refresh();
  assert.equal(invalid.changed, false);
  assert.equal(invalid.reason, 'invalid');
  assert.equal(catalog.list()[0].name, 'v1', '非法目录不得替换当前目录');

  rmSync(file, { force: true });
  const missing = await catalog.refresh();
  assert.equal(missing.changed, false);
  assert.equal(missing.reason, 'missing');
  assert.equal(catalog.list()[0].name, 'v1');
});

test('桥注册到换代核心：按 welcome.app 强制刷新目录并回调通知', async (t) => {
  const refreshes = [];
  const changed = [];
  let registered = null;
  const link = {
    setRegisteredHandler: (handler) => { registered = handler; },
    setPushHandler: () => {},
    sendRegisterUpdate: () => true,
    close: async () => {},
    ensureCore: async () => ({ ok: true }),
    call: async () => ({ ok: true, result: { content: [] } }),
    state: {},
  };
  const catalog = {
    list: () => [{ name: 'current', description: 'current', inputSchema: { type: 'object' } }],
    refresh: async (options) => {
      refreshes.push(options);
      return { changed: true };
    },
  };
  const runtime = createBridgeRuntime({
    link,
    log: QUIET_LOG,
    writer: { available: () => true, deliver: async () => ({ ok: true }) },
    dataDir: makeTempDir(t),
    heartbeat: false,
    sessionMetaWatcher: false,
    toolCatalog: catalog,
    onToolCatalogChanged: (result) => changed.push(result),
  });
  assert.equal(runtime.registry.list()[0].name, 'current', 'registry 数据源＝热刷新目录');
  registered({ app: '9.9.9', corePid: 1 }, { reborn: true });
  await waitFor(() => changed.length === 1, { timeoutMs: 1000 });
  assert.deepEqual(refreshes[0], { force: true }, 'welcome.app 与桥版本不同 → 强制刷新');
  await runtime.close();
});

test('桥注册到同版本核心：不强制刷新；刷新失败不通知客户端', async (t) => {
  const refreshes = [];
  let callbackCount = 0;
  let registered = null;
  const link = {
    setRegisteredHandler: (handler) => { registered = handler; },
    setPushHandler: () => {},
    sendRegisterUpdate: () => true,
    close: async () => {},
  };
  const result = { changed: false, reason: 'invalid' };
  const catalog = {
    list: () => [],
    refresh: async (options) => {
      refreshes.push(options);
      return result;
    },
  };
  const runtime = createBridgeRuntime({
    link,
    log: QUIET_LOG,
    writer: { available: () => true, deliver: async () => ({ ok: true }) },
    dataDir: makeTempDir(t),
    heartbeat: false,
    sessionMetaWatcher: false,
    toolCatalog: catalog,
    onToolCatalogChanged: () => { callbackCount++; },
  });
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  registered({ app: version, corePid: 1 }, { reborn: false });
  await waitFor(() => refreshes.length === 1, { timeoutMs: 1000 });
  assert.deepEqual(refreshes[0], { force: false }, '同版本只按文件时间戳判断');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(callbackCount, 0, '刷新失败（changed:false）不得通知客户端');
  await runtime.close();
});

test('MCP server：tools.listChanged 能力齐备，list 前刷新目录', async () => {
  let refreshes = 0;
  const registry = {
    list: () => [{ name: 'ws_status', description: 'd', inputSchema: { type: 'object', properties: {} } }],
    refresh: async () => {
      refreshes += 1;
      return { changed: false };
    },
    call: async () => ({ content: [] }),
  };
  const server = createMcpServer({ version: '0.0.0', registry, context: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'catalog-test', version: '0.0.0' }, { capabilities: {} });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    assert.deepEqual(client.getServerCapabilities().tools, { listChanged: true });
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name), ['ws_status']);
    assert.equal(refreshes, 1, '每次 tools/list 都先做一次热刷新检查');
  } finally {
    await client.close();
    await server.close();
  }
});
