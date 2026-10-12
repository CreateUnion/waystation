import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToolRegistry } from '../src/tools/registry.js';

function probeTool(handler) {
  return {
    name: 'probe',
    description: '测试探针工具',
    inputSchema: { type: 'object', properties: {} },
    handler,
  };
}

test('注册与列表：返回 name/description/inputSchema', () => {
  const registry = createToolRegistry();
  registry.register(probeTool(async () => ({ content: [{ type: 'text', text: 'ok' }] })));
  assert.deepEqual(registry.list(), [
    { name: 'probe', description: '测试探针工具', inputSchema: { type: 'object', properties: {} } },
  ]);
});

test('重名注册：抛出', () => {
  const registry = createToolRegistry();
  registry.register(probeTool(async () => ({ content: [] })));
  assert.throws(() => registry.register(probeTool(async () => ({ content: [] }))), /工具名重复注册/);
});

test('未知工具：isError 且文本含工具名', async () => {
  const registry = createToolRegistry();
  const called = await registry.call('not_registered', {}, {});
  assert.equal(called.isError, true);
  assert.ok(called.content[0].text.includes('not_registered'));
});

test('handler 收到 args 与 context 原样对象', async () => {
  const registry = createToolRegistry();
  const seen = {};
  registry.register(
    probeTool(async (args, context) => {
      seen.args = args;
      seen.context = context;
      return { content: [{ type: 'text', text: 'ok' }] };
    }),
  );
  const context = { version: '0.1.0' };
  const called = await registry.call('probe', { value: 1 }, context);
  assert.equal(called.content[0].text, 'ok');
  assert.deepEqual(seen.args, { value: 1 });
  assert.equal(seen.context, context);
});

test('handler 抛错：兜底为 isError，不外溢（不让异常穿到 SDK）', async () => {
  const registry = createToolRegistry();
  registry.register(
    probeTool(async () => {
      throw new Error('内部爆炸');
    }),
  );
  const called = await registry.call('probe', {}, {});
  assert.equal(called.isError, true);
  assert.ok(called.content[0].text.includes('内部爆炸'));
});
