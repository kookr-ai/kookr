import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLucyInteractionLog,
  DISABLED_LUCY_INTERACTION_LOG,
  isLucyTelemetryType,
  countSpokenWords,
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

  it('writes a ui record with the event as received', async () => {
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

  it('rotates by size, keeping the configured generations', async () => {
    const log = createLucyInteractionLog({ filePath: file, now, maxBytes: 600, rotatedGenerations: 2 });
    for (let i = 0; i < 20; i++) log.recordSaid({ ...said, clipId: `c${i}` });
    await log.flush();
    const names = readdirSync(join(dir, 'nested')).sort();
    expect(names).toEqual(['lucy-interactions.jsonl', 'lucy-interactions.jsonl.1', 'lucy-interactions.jsonl.2']);
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
