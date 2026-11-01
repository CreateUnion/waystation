import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCollabService } from '../../src/collab/service.js';
import { sessionNodeConfig } from './session-participants.js';

export function makeDispatchNode(t, options = {}) {
  /* options.dataDir：复用既有数据根（持久化恢复 / 重启类用例）；缺省每个节点独立临时目录。
   * 复用时由调用方负责收尾，这里不再重复注册删除钩子。 */
  const shared = options.dataDir !== undefined;
  const dataDir = shared ? options.dataDir : mkdtempSync(join(tmpdir(), 'waystation-dispatch-'));
  if (!shared) {
    t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  }
  let now = options.now ?? 1000;
  const meta = metaMapOf(options, now);
  const notices = [];
  const logs = [];
  let notifyResult = options.notifyResult !== false;
  const notify = (frame) => {
    notices.push(frame);
    return notifyResult;
  };
  const log = options.log ?? {
    info: (message, fields = {}) => logs.push({ level: 'info', message, fields }),
    warn: (message, fields = {}) => logs.push({ level: 'warn', message, fields }),
    error: (message, fields = {}) => logs.push({ level: 'error', message, fields }),
  };
  const service = createCollabService(serviceOptionsOf({ dataDir, options, meta, notify, nowOf: () => now, log }));
  return {
    service, notices, meta, dataDir, logs,
    advance(ms) {
      now += ms;
      for (const entry of meta.values()) {
        entry.metaUpdatedAt = now;
      }
    },
    setNotifyResult(value) { notifyResult = value; },
    now() { return now; },
  };
}

function metaMapOf(options, now) {
  /* metaPreset:false ＝ 不预置默认会话（模拟核心刚启动、桥尚未注册的注册表面）。 */
  const meta = options.metaPreset === false ? new Map() : new Map([
    ['master-1', { sessionId: 'master-1', role: 'master', name: 'master', kind: 'interactive', entrypoint: 'cli', status: 'idle', metaUpdatedAt: now }],
    ['worker-1', { sessionId: 'worker-1', role: 'slave', name: 'worker-1', kind: 'bg', entrypoint: 'sdk-cli', status: 'idle', metaUpdatedAt: now }],
    ['human-1', { sessionId: 'human-1', role: 'none', name: 'human', kind: 'interactive', entrypoint: 'cli', status: 'idle', metaUpdatedAt: now }],
    ['headless-1', { sessionId: 'headless-1', role: 'none', name: 'headless', kind: 'bg', entrypoint: 'sdk-cli', status: 'idle', metaUpdatedAt: now }],
  ]);
  for (const [id, value] of options.meta ?? []) {
    meta.set(id, value);
  }
  return meta;
}

function serviceOptionsOf({ dataDir, options, meta, notify, nowOf, log }) {
  return {
    dataDir,
    config: sessionNodeConfig({ sessionSeatGraceMs: 1000, ...(options.config ?? {}) }),
    self: { instanceId: 'inst-self', identityName: '本机', port: 7321 },
    send: () => ({ ok: true, msgId: 'msg-1' }),
    sendDirect: () => ({ ok: true, msgId: 'direct-1' }),
    knownHosts: { remember: () => {}, lookup: () => undefined },
    notify,
    deliverSeat: () => true,
    log,
    syncPeerPicker: () => [],
    now: nowOf,
    sessionMetaOf: (sessionId) => meta.get(sessionId) ?? null,
    listSessionIds: () => [...meta.keys()],
  };
}
