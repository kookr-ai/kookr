import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLucyInteractionLog,
  DISABLED_LUCY_INTERACTION_LOG,
  isLucyTelemetryType,
  countSpokenWords,
  sanitizeLucyUiEvent,
  MAX_PENDING_LUCY_LINES,
  type LucySaidRecordInput,
} from './lucy-interaction-log.js';

const said: LucySaidRecordInput = {
  clipId: 'clip-1',
  source: 'task_summary',
  taskId: 'task-1',
  taskName: 'Fix login',
  text: 'Fix login is done.',
  rawText: 'Fix login (#12) is done.',
  usedFallback: false,
  cached: false,
  voice: 'alba',
  llmMs: 120,
  ttsMs: 340,
  durationMs: 1800,
  words: 4,
};

describe('LucyInteractionLog', () => {
  let dir: string;
  let file: string;
  const now = () => new Date('2026-11-11T10:00:00.000Z');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lucy-log-'));
    file = join(dir, 'nested', 'lucy-interactions.jsonl');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function lines(): Array<Record<string, unknown>> {
    return readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  it('writes a said record with version and timestamp, and no audio', async () => {
    const log = createLucyInteractionLog({ filePath: file, now });
    log.recordSaid({ ...said, ...({ audioBase64: 'AAAA' } as object) });
    await log.flush();
    const [rec] = lines();
    expect(rec).toMatchObject({ v: 1, ts: '2026-11-11T10:00:00.000Z', kind: 'said', clipId: 'clip-1', source: 'task_summary', words: 4 });
    expect(rec.rawText).toBe('Fix login (#12) is done.');
    expect('audioBase64' in rec).toBe(false);
  });

  it('omits undefined optional fields', async () => {
    const log = createLucyInteractionLog({ filePath: file, now });
    log.recordSaid({ ...said, rawText: undefined, taskName: undefined });
    await log.flush();
    const [rec] = lines();
    expect('rawText' in rec).toBe(false);
    expect('taskName' in rec).toBe(false);
  });

  it('writes a ui record with the documented fields of the event', async () => {
    const log = createLucyInteractionLog({ filePath: file, now });
    const event = { type: 'lucy_clip_ended', clipId: 'clip-1', endedBy: 'user_stop', playedMs: 500, totalMs: 2000, timestamp: 't', sessionId: 's1', platform: 'linux' };
    log.recordUi('s1', event);
    await log.flush();
    expect(lines()).toEqual([{ v: 1, ts: '2026-11-11T10:00:00.000Z', kind: 'ui', sessionId: 's1', event }]);
  });

  it('keeps record order', async () => {
    const log = createLucyInteractionLog({ filePath: file, now });
    for (let i = 0; i < 20; i++) log.recordSaid({ ...said, clipId: `c${i}` });
    await log.flush();
    expect(lines().map((r) => r.clipId)).toEqual(Array.from({ length: 20 }, (_, i) => `c${i}`));
  });

  it('writes nothing while disabled and resumes when re-enabled', async () => {
    let on = false;
    const log = createLucyInteractionLog({ filePath: file, now, isEnabled: () => on });
    log.recordSaid(said);
    log.recordUi('s', { type: 'lucy_panel_action' });
    await log.flush();
    expect(existsSync(file)).toBe(false);
    on = true;
    log.recordSaid(said);
    await log.flush();
    expect(lines()).toHaveLength(1);
  });

  it('the disabled singleton is a no-op', async () => {
    DISABLED_LUCY_INTERACTION_LOG.recordSaid(said);
    DISABLED_LUCY_INTERACTION_LOG.recordUi('s', {});
    await expect(DISABLED_LUCY_INTERACTION_LOG.flush()).resolves.toBeUndefined();
  });

  it('rotates by size: newest in the live file, oldest generation gone, no line split', async () => {
    const log = createLucyInteractionLog({ filePath: file, now, maxBytes: 600, rotatedGenerations: 2 });
    for (let i = 0; i < 20; i++) log.recordSaid({ ...said, clipId: `c${i}` });
    await log.flush();
    const nested = join(dir, 'nested');
    expect(readdirSync(nested).sort()).toEqual(['lucy-interactions.jsonl', 'lucy-interactions.jsonl.1', 'lucy-interactions.jsonl.2']);
    const idsOf = (name: string) => readFileSync(join(nested, name), 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { clipId: string }).clipId);
    const live = idsOf('lucy-interactions.jsonl');
    const gen1 = idsOf('lucy-interactions.jsonl.1');
    const gen2 = idsOf('lucy-interactions.jsonl.2');
    expect(live).toContain('c19');
    expect(gen1.at(-1)).not.toBe('c19');
    const all = [...gen2, ...gen1, ...live];
    expect(all).not.toContain('c0');
    // Contiguous, ordered tail of the written sequence: nothing lost in between, nothing duplicated.
    const nums = all.map((id) => Number(id.slice(1)));
    expect(nums).toEqual(Array.from({ length: nums.length }, (_, i) => nums[0] + i));
    expect(nums.at(-1)).toBe(19);
    for (const name of readdirSync(nested)) {
      expect(statSync(join(nested, name)).size).toBeLessThanOrEqual(600);
    }
  });

  it('never throws and warns once per failure kind when the write fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    const log = createLucyInteractionLog({ filePath: file, now, appendLines: async () => { throw err; } });
    expect(() => {
      log.recordSaid(said);
      log.recordSaid(said);
      log.recordUi('s', { type: 'lucy_panel_action' });
    }).not.toThrow();
    await expect(log.flush()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('ENOSPC');
  });

  it('warns once per failure KIND: a second error code warns again, repeats do not', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const codes = ['ENOSPC', 'ENOSPC', 'EACCES', 'EACCES', 'ENOSPC'];
    let i = 0;
    const log = createLucyInteractionLog({
      filePath: file,
      now,
      appendLines: async () => { throw Object.assign(new Error('nope'), { code: codes[i++] }); },
    });
    for (let n = 0; n < codes.length; n++) log.recordSaid(said);
    await log.flush();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0][0])).toContain('ENOSPC');
    expect(String(warn.mock.calls[1][0])).toContain('EACCES');
  });

  it('a record that cannot be serialised is dropped with one warning and later records still write', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = createLucyInteractionLog({ filePath: file, now });
    log.recordSaid({ ...said, words: 10n as unknown as number });
    log.recordSaid({ ...said, words: 11n as unknown as number });
    log.recordSaid({ ...said, clipId: 'fine' });
    await log.flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('serialize-failed');
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('circular or BigInt values in a client ui event are stripped, not serialised or warned about', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = createLucyInteractionLog({ filePath: file, now });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    log.recordUi('s1', { type: 'lucy_clip_ended', clipId: 'c', endedBy: 'finished', playedMs: 5n, totalMs: 10, extra: circular });
    await log.flush();
    expect(warn).not.toHaveBeenCalled();
    const rec = JSON.parse(readFileSync(file, 'utf8')) as { event: Record<string, unknown> };
    expect(rec.event).toEqual({ type: 'lucy_clip_ended', clipId: 'c', endedBy: 'finished', totalMs: 10 });
  });

  it('re-reads isEnabled for every record, so flipping it between two calls takes effect', async () => {
    let on = true;
    const log = createLucyInteractionLog({ filePath: file, now, isEnabled: () => on });
    log.recordSaid({ ...said, clipId: 'first' });
    on = false;
    log.recordSaid({ ...said, clipId: 'second' });
    await log.flush();
    expect(lines().map((r) => r.clipId)).toEqual(['first']);
  });

  it('survives an unwritable directory without throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'x');
    const log = createLucyInteractionLog({ filePath: join(blocker, 'sub', 'l.jsonl'), now });
    log.recordSaid(said);
    await expect(log.flush()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('treats a throwing isEnabled as disabled', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = createLucyInteractionLog({ filePath: file, now, isEnabled: () => { throw new Error('boom'); } });
    log.recordSaid(said);
    await log.flush();
    expect(existsSync(file)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('LucyInteractionLog hardening (client-controlled input)', () => {
  let dir: string;
  let file: string;
  const now = () => new Date('2026-11-11T10:00:00.000Z');
  const base = { timestamp: '2026-11-11T10:00:00.000Z', sessionId: 's1', platform: 'linux' };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lucy-log-hard-'));
    file = join(dir, 'nested', 'lucy-interactions.jsonl');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function events(): Array<Record<string, unknown>> {
    return readFileSync(file, 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { event: Record<string, unknown> }).event);
  }

  it('keeps only the documented fields per event type', async () => {
    const log = createLucyInteractionLog({ filePath: file, now });
    log.recordUi('s1', { ...base, type: 'lucy_clip_unheard', clipId: 'c', reason: 'muted', payload: 'x'.repeat(10_000), nested: { a: 1 }, playedMs: 5 });
    log.recordUi('s1', { ...base, type: 'lucy_panel_action', action: 'move', tabVisible: true, endedBy: 'finished' });
    await log.flush();
    expect(events()).toEqual([
      { ...base, type: 'lucy_clip_unheard', clipId: 'c', reason: 'muted' },
      { ...base, type: 'lucy_panel_action', action: 'move' },
    ]);
  });

  it('drops events whose type is not a documented lucy_ type', async () => {
    const log = createLucyInteractionLog({ filePath: file, now });
    log.recordUi('s1', { ...base, type: 'lucy_made_up', clipId: 'c' });
    log.recordUi('s1', { ...base, type: 'constructor' });
    log.recordUi('s1', { ...base, type: 42 });
    await log.flush();
    expect(existsSync(file)).toBe(false);
  });

  it('replaces enum values outside the documented set with "other"', async () => {
    const log = createLucyInteractionLog({ filePath: file, now });
    log.recordUi('s1', { ...base, platform: 'plan9', type: 'lucy_clip_started', clipId: 'c', trigger: 'drag', panelState: '<script>', tabVisible: 'yes' });
    log.recordUi('s1', { ...base, type: 'lucy_clip_ended', clipId: 'c', endedBy: 'error', playedMs: 1, totalMs: 2 });
    log.recordUi('s1', { ...base, type: 'lucy_clip_unheard', clipId: 'c', reason: '__proto__' });
    log.recordUi('s1', { ...base, type: 'lucy_panel_action', action: 'constructor' });
    await log.flush();
    const [started, ended, unheard, action] = events();
    expect(started).toMatchObject({ platform: 'other', trigger: 'other', panelState: 'other' });
    expect('tabVisible' in started).toBe(false);
    expect(ended.endedBy).toBe('other');
    expect(unheard.reason).toBe('other');
    expect(action.action).toBe('other');
  });

  it('clamps strings to 64 chars', async () => {
    const log = createLucyInteractionLog({ filePath: file, now });
    log.recordUi('s'.repeat(500), { ...base, sessionId: 's'.repeat(500), timestamp: 't'.repeat(500), type: 'lucy_panel_action', action: 'move', clipId: 'c'.repeat(500) });
    await log.flush();
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { sessionId: string; event: Record<string, string> };
    expect(raw.sessionId).toHaveLength(64);
    expect(raw.event.clipId).toHaveLength(64);
    expect(raw.event.sessionId).toHaveLength(64);
    expect(raw.event.timestamp).toHaveLength(64);
  });

  it('keeps numbers finite and within 0..86_400_000', () => {
    const ended = (playedMs: unknown, totalMs: unknown) =>
      sanitizeLucyUiEvent({ ...base, type: 'lucy_clip_ended', clipId: 'c', endedBy: 'finished', playedMs, totalMs });
    expect(ended(-5, 1e15)).toMatchObject({ playedMs: 0, totalMs: 86_400_000 });
    const bad = ended(Number.NaN, Infinity)!;
    expect('playedMs' in bad).toBe(false);
    expect('totalMs' in bad).toBe(false);
    const strings = ended('100', null)!;
    expect('playedMs' in strings).toBe(false);
    expect(ended(1234, 5678)).toMatchObject({ playedMs: 1234, totalMs: 5678 });
  });

  it('caps the pending write queue, drops new lines, counts them and warns once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const written: string[] = [];
    const log = createLucyInteractionLog({
      filePath: file,
      now,
      appendLines: async (_f, line) => { await gate; written.push(line); },
    });
    const total = MAX_PENDING_LUCY_LINES + 25;
    for (let i = 0; i < total; i++) log.recordSaid({ ...said, clipId: `c${i}` });
    expect(log.droppedLines?.()).toBe(25);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('queue-full');
    release();
    await log.flush();
    expect(written).toHaveLength(MAX_PENDING_LUCY_LINES);
    expect(JSON.parse(written[0]).clipId).toBe('c0');
    // Queue drained: new lines are accepted again.
    log.recordSaid({ ...said, clipId: 'later' });
    await log.flush();
    expect(written).toHaveLength(MAX_PENDING_LUCY_LINES + 1);
    expect(log.droppedLines?.()).toBe(25);
  });

  it.skipIf(process.platform === 'win32')('creates the log owner-only (file 0600, new directory 0700)', async () => {
    const log = createLucyInteractionLog({ filePath: file, now });
    log.recordSaid(said);
    await log.flush();
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'nested')).mode & 0o777).toBe(0o700);
  });
});

describe('helpers', () => {
  it('recognises lucy telemetry types', () => {
    expect(isLucyTelemetryType('lucy_clip_started')).toBe(true);
    expect(isLucyTelemetryType('agent_clicked')).toBe(false);
    expect(isLucyTelemetryType(undefined)).toBe(false);
  });
  it('counts words', () => {
    expect(countSpokenWords('  one two\nthree ')).toBe(3);
    expect(countSpokenWords('')).toBe(0);
  });
});
