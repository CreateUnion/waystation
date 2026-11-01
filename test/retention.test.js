import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { runRetentionCleanup } from '../src/retention.js';
import { makeTempDir } from './helpers.js';
import { makeLedger } from './helpers/session-participants.js';

/* 保留期（问题 19）：完成/终止且超期的协作目录先归档再删除；活跃/在途永不清理；
 * 日志按时间清理；dry-run 只报告不删除。 */

const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

function makeLogs() {
  const entries = [];
  return {
    entries,
    log: {
      info: (message, fields = {}) => entries.push({ level: 'info', message, fields }),
      warn: (message, fields = {}) => entries.push({ level: 'warn', message, fields }),
      error: (message, fields = {}) => entries.push({ level: 'error', message, fields }),
    },
  };
}

function writeMember(dataDir, collabId, record = {}) {
  const dir = join(dataDir, 'collabs', collabId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'member.json'), JSON.stringify({
    collabId,
    name: `协作-${collabId}`,
    role: 'member',
    state: 'completed',
    manager: { instanceId: 'inst-1', identityName: '站长' },
    endpoints: {},
    roster: [{ instanceId: 'inst-1', identityName: '站长' }],
    mode: 'managed',
    ...record,
  }), 'utf8');
  return dir;
}

function writeSeat(dataDir, collabId, sessionId, archivedAt) {
  const dir = join(dataDir, 'collabs', collabId, 'seats');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.json`), JSON.stringify({ sessionId, ...(archivedAt === null ? {} : { archivedAt }) }), 'utf8');
}

function configOf(retention = {}) {
  return { retention: { dispatch_hours: 24, collabs_days: 30, logs_days: 14, cleanup_interval_h: 6, dry_run: false, ...retention } };
}

function run(dataDir, extra = {}) {
  const { entries, log } = makeLogs();
  const stats = runRetentionCleanup({
    dataDir,
    logDir: extra.logDir ?? join(dataDir, 'logs'),
    config: configOf(extra.retention ?? {}),
    log,
    now: extra.now ?? NOW,
    dryRun: extra.dryRun,
  });
  return { stats, entries };
}

test('已完成且超期：先归档为 .json.gz，再删除原协作目录', (t) => {
  const dataDir = makeTempDir(t);
  const dir = writeMember(dataDir, 'c-old', { state: 'completed', archivedAt: iso(40 * DAY_MS) });
  writeSeat(dataDir, 'c-old', 'sess-1', iso(40 * DAY_MS));
  const ledger = makeLedger({ collabId: 'c-old', status: 'completed' });
  writeFileSync(join(dir, 'ledger.jsonl'), `${JSON.stringify(ledger)}\n`, 'utf8');

  const { stats, entries } = run(dataDir);
  assert.equal(existsSync(dir), false, '超期完成目录须删除');
  assert.equal(stats.collabs.archived, 1);
  const archive = join(dataDir, 'archive', 'collabs', 'c-old.json.gz');
  assert.equal(existsSync(archive), true, '删除前必须落归档');
  const payload = JSON.parse(gunzipSync(readFileSync(archive)).toString('utf8'));
  assert.equal(payload.collabId, 'c-old');
  const decoded = (key) => Buffer.from(payload.files[key], 'base64').toString('utf8');
  assert.match(decoded('member.json'), /协作-c-old/);
  assert.match(decoded('ledger.jsonl'), /"status":"completed"/);
  assert.equal(entries.some((entry) => entry.level === 'info' && entry.message.includes('保留期清理')), true, '每轮写日志');
});

test('终止态同样清理；frozen / active / proposed 永不清理', (t) => {
  const dataDir = makeTempDir(t);
  const terminated = writeMember(dataDir, 'c-terminated', { state: 'terminated', archivedAt: iso(40 * DAY_MS) });
  const frozen = writeMember(dataDir, 'c-frozen', { state: 'frozen', archivedAt: iso(40 * DAY_MS) });
  const active = writeMember(dataDir, 'c-active', { state: 'active', archivedAt: iso(40 * DAY_MS) });
  const proposed = writeMember(dataDir, 'c-proposed', { state: 'proposed' });
  run(dataDir);
  assert.equal(existsSync(terminated), false);
  for (const dir of [frozen, active, proposed]) {
    assert.equal(existsSync(dir), true, `活跃/在途目录不得清理：${dir}`);
  }
});

test('席位未归档：即使 member 是完成态也不清理（仍有活跃席位）', (t) => {
  const dataDir = makeTempDir(t);
  const dir = writeMember(dataDir, 'c-seat', { state: 'completed', archivedAt: iso(40 * DAY_MS) });
  writeSeat(dataDir, 'c-seat', 'sess-1', null);
  run(dataDir);
  assert.equal(existsSync(dir), true, '存在未归档席位＝仍在途');
});

test('recovery / 无 member.json 的未知目录 / 损坏 member.json：一律不清理', (t) => {
  const dataDir = makeTempDir(t);
  const recovery = writeMember(dataDir, 'c-recovery', { state: 'completed', archivedAt: iso(40 * DAY_MS) });
  writeFileSync(join(recovery, 'recovery.json'), '{}', 'utf8');
  const legacy = join(dataDir, 'collabs', 'c-legacy');
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, 'old-ledger.jsonl'), '{}\n', 'utf8');
  const corrupt = writeMember(dataDir, 'c-corrupt', { state: 'completed', archivedAt: iso(40 * DAY_MS) });
  writeFileSync(join(corrupt, 'member.json'), '{broken', 'utf8');
  run(dataDir);
  for (const dir of [recovery, legacy, corrupt]) {
    assert.equal(existsSync(dir), true, `未知/恢复/损坏目录不得删除：${dir}`);
  }
});

test('dry-run：只统计与写日志，不归档、不删除', (t) => {
  const dataDir = makeTempDir(t);
  const dir = writeMember(dataDir, 'c-dry', { state: 'completed', archivedAt: iso(40 * DAY_MS) });
  const { stats, entries } = run(dataDir, { dryRun: true });
  assert.equal(existsSync(dir), true);
  assert.equal(existsSync(join(dataDir, 'archive', 'collabs', 'c-dry.json.gz')), false);
  assert.equal(stats.dryRun, true);
  assert.equal(stats.collabs.archived, 1, 'dry-run 仍报告将归档数');
  assert.equal(entries.some((entry) => entry.message.includes('保留期清理') && entry.fields?.dryRun === true), true);
});

test('collabs_days=0：完成态立即归档删除（archivedAt 早于当前时刻）', (t) => {
  const dataDir = makeTempDir(t);
  const dir = writeMember(dataDir, 'c-zero', { state: 'completed', archivedAt: iso(1000) });
  run(dataDir, { retention: { collabs_days: 0 } });
  assert.equal(existsSync(dir), false);
});

test('归档文件本身受 collabs_days 窗口约束：超期归档删除', (t) => {
  const dataDir = makeTempDir(t);
  const archiveDir = join(dataDir, 'archive', 'collabs');
  mkdirSync(archiveDir, { recursive: true });
  const archive = join(archiveDir, 'old.json.gz');
  writeFileSync(archive, 'old', 'utf8');
  const old = new Date(NOW - 40 * DAY_MS);
  utimesSync(archive, old, old);
  const { stats } = run(dataDir);
  assert.equal(existsSync(archive), false);
  assert.equal(stats.archives.deleted, 1);
});

test('日志清理：超过 logs_days 的 waystation.log / 轮转文件删除；新日志与无关文件保留', (t) => {
  const dataDir = makeTempDir(t);
  const logDir = join(dataDir, 'custom-logs');
  mkdirSync(logDir, { recursive: true });
  const oldLog = join(logDir, 'waystation.log');
  const oldRotated = join(logDir, 'waystation.log.3');
  const freshLog = join(logDir, 'waystation.log.1');
  const unrelated = join(logDir, 'notes.txt');
  for (const file of [oldLog, oldRotated, freshLog, unrelated]) {
    writeFileSync(file, 'x', 'utf8');
  }
  const old = new Date(NOW - 20 * DAY_MS);
  utimesSync(oldLog, old, old);
  utimesSync(oldRotated, old, old);
  utimesSync(unrelated, old, old);
  const { stats } = run(dataDir, { logDir });
  assert.equal(existsSync(oldLog), false, '超期主日志删除');
  assert.equal(existsSync(oldRotated), false, '超期轮转文件删除');
  assert.equal(existsSync(freshLog), true, '未超期轮转文件保留');
  assert.equal(existsSync(unrelated), true, '非日志文件不得误删');
  assert.equal(stats.logs.deleted, 2);
  assert.ok(statSync(freshLog).size > 0);
});

test('日志 dry-run：不删除', (t) => {
  const dataDir = makeTempDir(t);
  const logDir = join(dataDir, 'logs');
  mkdirSync(logDir, { recursive: true });
  const oldLog = join(logDir, 'waystation.log');
  writeFileSync(oldLog, 'x', 'utf8');
  const old = new Date(NOW - 20 * DAY_MS);
  utimesSync(oldLog, old, old);
  const { stats } = run(dataDir, { logDir, dryRun: true });
  assert.equal(existsSync(oldLog), true);
  assert.equal(stats.logs.deleted, 1);
});

test('归档失败则不删除原目录（保守保留）', (t) => {
  const dataDir = makeTempDir(t);
  const dir = writeMember(dataDir, 'c-blocked', { state: 'completed', archivedAt: iso(40 * DAY_MS) });
  // 用文件占住 archive/collabs 父路径，令归档写入必然失败。
  mkdirSync(join(dataDir, 'archive'), { recursive: true });
  writeFileSync(join(dataDir, 'archive', 'collabs'), 'blocker', 'utf8');
  const { stats, entries } = run(dataDir);
  assert.equal(existsSync(dir), true, '归档失败必须保留原目录');
  assert.equal(stats.collabs.archived, 0);
  assert.equal(entries.some((entry) => entry.level === 'warn' && entry.message.includes('归档')), true);
});
