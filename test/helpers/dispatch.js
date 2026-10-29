import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCollabService } from '../../src/collab/service.js';
import { sessionNodeConfig } from './session-participants.js';

export function makeDispatchNode(t, options = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'waystation-dispatch-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  let now = options.now ?? 1000;
  const meta = metaMapOf(options, now);
  const notices = [];
  let notifyResult = options.notifyResult !== false;
  const notify = (frame) => {
    notices.push(frame);
    return notifyResult;
  };
  const service = createCollabService(serviceOptionsOf({ dataDir, options, meta, notify, nowOf: () => now }));
  return {
    service, notices, meta, dataDir,
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
  const meta = new Map([
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

function serviceOptionsOf({ dataDir, options, meta, notify, nowOf }) {
  return {
    dataDir,
    config: sessionNodeConfig({ sessionSeatGraceMs: 1000, ...(options.config ?? {}) }),
    self: { instanceId: 'inst-self', identityName: '本机', port: 7321 },
    send: () => ({ ok: true, msgId: 'msg-1' }),
    sendDirect: () => ({ ok: true, msgId: 'direct-1' }),
    knownHosts: { remember: () => {}, lookup: () => undefined },
    notify,
    deliverSeat: () => true,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    syncPeerPicker: () => [],
    now: nowOf,
    sessionMetaOf: (sessionId) => meta.get(sessionId) ?? null,
    listSessionIds: () => [...meta.keys()],
  };
}
