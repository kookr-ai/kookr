import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  TaskTailStore,
  boundTailText,
  truncateTextToMaxBytes,
  parseTailLinesQuery,
  readTaskTailConfigFromEnv,
  DEFAULT_TASK_TAIL_RETENTION_DAYS,
  DEFAULT_TASK_TAIL_MAX_BYTES,
} from './task-tail-store.js';

describe('task-tail-store helpers', () => {
  test('boundTailText keeps the last N lines', () => {
    const text = ['a', 'b', 'c', 'd', 'e'].join('\n');
    const bound = boundTailText(text, 2);
    expect(bound.text).toBe('d\ne');
    expect(bound.totalLines).toBe(5);
    expect(bound.shownLines).toBe(2);
  });

  test('boundTailText drops trailing blank padding', () => {
    const bound = boundTailText('hello\n\n', 10);
    expect(bound.text).toBe('hello');
    expect(bound.totalLines).toBe(1);
  });

  test('truncateTextToMaxBytes keeps a UTF-8 suffix', () => {
    const text = 'abc' + 'x'.repeat(100);
    const { text: out, truncated } = truncateTextToMaxBytes(text, 10);
    expect(truncated).toBe(true);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(10);
    expect(out.endsWith('x')).toBe(true);
  });

  test('parseTailLinesQuery clamps and validates', () => {
    expect(parseTailLinesQuery(undefined)).toBe(80);
    expect(parseTailLinesQuery('40')).toBe(40);
    expect(parseTailLinesQuery('0')).toBeInstanceOf(Error);
    expect(parseTailLinesQuery('nope')).toBeInstanceOf(Error);
    expect(parseTailLinesQuery('2001')).toBeInstanceOf(Error);
  });

  test('readTaskTailConfigFromEnv applies defaults and overrides', () => {
    const cfg = readTaskTailConfigFromEnv({}, '/data/kookr');
    expect(cfg.dir).toBe(join('/data/kookr', 'task-tails'));
    expect(cfg.retentionDays).toBe(DEFAULT_TASK_TAIL_RETENTION_DAYS);
    expect(cfg.maxBytes).toBe(DEFAULT_TASK_TAIL_MAX_BYTES);

    const custom = readTaskTailConfigFromEnv({
      KOOKR_TASK_TAIL_DIR: '/tmp/tails',
      KOOKR_TASK_TAIL_RETENTION_DAYS: '14',
      KOOKR_TASK_TAIL_MAX_BYTES: '1024',
      KOOKR_TASK_TAIL_PURGE_INTERVAL_MS: '0',
    }, '/data/kookr');
    expect(custom.dir).toBe('/tmp/tails');
    expect(custom.retentionDays).toBe(14);
    expect(custom.maxBytes).toBe(1024);
    expect(custom.purgeIntervalMs).toBe(0);
  });
});

describe('TaskTailStore', () => {
  let dir: string;
  let nowMs: number;
  let store: TaskTailStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kookr-task-tail-'));
    nowMs = Date.parse('2026-07-23T12:00:00.000Z');
    store = new TaskTailStore({
      dir,
      retentionDays: 7,
      maxBytes: 1024,
      now: () => nowMs,
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('save and getByTaskId / getBySessionId round-trip', async () => {
    const saved = await store.save({
      taskId: 'task-1',
      sessionId: 'kookr-sess-1',
      text: 'line one\nline two\n',
    });
    expect(saved.byteLength).toBeGreaterThan(0);
    expect(saved.schemaVersion).toBe('task-tail.v1');

    const byTask = await store.getByTaskId('task-1');
    expect(byTask?.text).toContain('line two');
    expect(byTask?.sessionId).toBe('kookr-sess-1');

    const bySession = await store.getBySessionId('kookr-sess-1');
    expect(bySession?.taskId).toBe('task-1');
    expect(existsSync(join(dir, 'task-1.json'))).toBe(true);
    expect(existsSync(join(dir, 'by-session', 'kookr-sess-1.json'))).toBe(true);
  });

  test('overwrites previous tail for the same task', async () => {
    await store.save({ taskId: 'task-1', sessionId: 'kookr-a', text: 'first' });
    await store.save({ taskId: 'task-1', sessionId: 'kookr-b', text: 'second' });
    const byTask = await store.getByTaskId('task-1');
    expect(byTask?.text).toBe('second');
    expect(byTask?.sessionId).toBe('kookr-b');
  });

  test('truncates oversized text to maxBytes', async () => {
    const text = 'Z'.repeat(5000);
    const saved = await store.save({ taskId: 'task-1', sessionId: 'kookr-a', text });
    expect(saved.truncated).toBe(true);
    expect(saved.byteLength).toBeLessThanOrEqual(1024);
  });

  test('expired records are deleted on read and by purgeExpired', async () => {
    await store.save({
      taskId: 'task-old',
      sessionId: 'kookr-old',
      text: 'ancient output',
      capturedAt: new Date(nowMs - 8 * 24 * 60 * 60 * 1000),
    });
    await store.save({
      taskId: 'task-new',
      sessionId: 'kookr-new',
      text: 'fresh output',
      capturedAt: new Date(nowMs - 1 * 24 * 60 * 60 * 1000),
    });

    expect(await store.getByTaskId('task-old')).toBeNull();
    expect(await store.getByTaskId('task-new')).not.toBeNull();

    // Re-seed an expired file and purge via sweep.
    await store.save({
      taskId: 'task-old2',
      sessionId: 'kookr-old2',
      text: 'gone',
      capturedAt: new Date(nowMs - 10 * 24 * 60 * 60 * 1000),
    });
    const removed = await store.purgeExpired();
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await store.getByTaskId('task-old2')).toBeNull();
  });

  test('removeByTaskId deletes both primary and session index', async () => {
    await store.save({ taskId: 'task-1', sessionId: 'kookr-s', text: 'x' });
    await store.removeByTaskId('task-1');
    expect(await store.getByTaskId('task-1')).toBeNull();
    expect(await store.getBySessionId('kookr-s')).toBeNull();
  });

  test('default retention is 7 days for expiresAt math', () => {
    const expires = store.retentionExpiresAt('2026-07-23T12:00:00.000Z');
    expect(expires).toBe('2026-07-30T12:00:00.000Z');
  });

  test('persisted JSON is valid task-tail.v1', async () => {
    await store.save({ taskId: 't', sessionId: 's', text: 'hi' });
    const raw = JSON.parse(readFileSync(join(dir, 't.json'), 'utf8'));
    expect(raw.schemaVersion).toBe('task-tail.v1');
    expect(raw.text).toBe('hi');
  });

  test('save writes compact JSON without pretty-print indentation (issue #2176)', async () => {
    await store.save({ taskId: 't', sessionId: 's', text: 'hi' });
    const raw = readFileSync(join(dir, 't.json'), 'utf8');
    // Compact form has no 2-space indent after newlines (pretty-print marker).
    expect(raw).not.toMatch(/\n {2}"/);
    // Schema fields still present and parseable.
    expect(raw).toContain('"schemaVersion":"task-tail.v1"');
    const parsed = JSON.parse(raw);
    expect(parsed.text).toBe('hi');
    expect(parsed.taskId).toBe('t');
  });
});
