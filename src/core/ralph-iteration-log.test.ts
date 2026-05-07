import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendIterationRecord,
  iterationLogPath,
  parseIterationRecord,
  type RalphIterationRecord,
} from './ralph-iteration-log.js';

const sampleRecord = (overrides: Partial<RalphIterationRecord> = {}): RalphIterationRecord => ({
  iterationNumber: 1,
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_005_000,
  exitReason: 'continued',
  cumulativeCostUsd: 0.42,
  gitBaselineRef: 'ralph/iter-1-start',
  diffStats: { filesChanged: 3, insertions: 12, deletions: 4 },
  ...overrides,
});

describe('iterationLogPath', () => {
  it('returns the canonical path inside the task dir', () => {
    expect(iterationLogPath('/tmp/task-abc')).toBe('/tmp/task-abc/ralph-iterations.jsonl');
  });

  it('strips trailing slashes so the result is normalized', () => {
    expect(iterationLogPath('/tmp/task-abc/')).toBe('/tmp/task-abc/ralph-iterations.jsonl');
    expect(iterationLogPath('/tmp/task-abc///')).toBe('/tmp/task-abc/ralph-iterations.jsonl');
  });
});

describe('appendIterationRecord', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ralph-iter-log-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes one JSONL line per record', async () => {
    await appendIterationRecord(dir, sampleRecord({ iterationNumber: 1 }));
    await appendIterationRecord(dir, sampleRecord({ iterationNumber: 2 }));

    const raw = await readFile(iterationLogPath(dir), 'utf-8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).iterationNumber).toBe(1);
    expect(JSON.parse(lines[1]).iterationNumber).toBe(2);
  });

  it('terminates each record with a single newline so the file is valid JSONL', async () => {
    await appendIterationRecord(dir, sampleRecord());
    const raw = await readFile(iterationLogPath(dir), 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.includes('\n\n')).toBe(false);
  });

  it('round-trips all fields including null sentinels', async () => {
    const record = sampleRecord({
      cumulativeCostUsd: null,
      gitBaselineRef: null,
      diffStats: null,
      exitReason: 'predicate_timeout',
    });
    await appendIterationRecord(dir, record);

    const raw = await readFile(iterationLogPath(dir), 'utf-8');
    const parsed = JSON.parse(raw.trim()) as RalphIterationRecord;
    expect(parsed.cumulativeCostUsd).toBeNull();
    expect(parsed.gitBaselineRef).toBeNull();
    expect(parsed.diffStats).toBeNull();
    expect(parsed.exitReason).toBe('predicate_timeout');
  });

  it('creates the parent directory if it does not exist', async () => {
    const nested = join(dir, 'task-deep', 'workspace');
    await appendIterationRecord(nested, sampleRecord());
    await expect(access(iterationLogPath(nested))).resolves.toBeUndefined();
  });

  it('appends rather than overwriting on subsequent calls', async () => {
    for (let i = 1; i <= 5; i++) {
      await appendIterationRecord(dir, sampleRecord({ iterationNumber: i }));
    }
    const raw = await readFile(iterationLogPath(dir), 'utf-8');
    const numbers = raw
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as RalphIterationRecord).iterationNumber);
    expect(numbers).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('parseIterationRecord', () => {
  function row(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      iterationNumber: 1,
      startedAt: 100,
      endedAt: 200,
      exitReason: 'continued',
      cumulativeCostUsd: null,
      gitBaselineRef: null,
      diffStats: null,
      ...overrides,
    });
  }

  it('parses the new replaced_by_user exit reason', () => {
    const parsed = parseIterationRecord(row({ exitReason: 'replaced_by_user' }));
    expect(parsed?.exitReason).toBe('replaced_by_user');
  });

  it('maps unknown exit reasons to "unknown" instead of dropping the row', () => {
    const parsed = parseIterationRecord(row({ exitReason: 'something_a_future_kookr_invented' }));
    expect(parsed).not.toBeNull();
    expect(parsed?.exitReason).toBe('unknown');
    // Other fields preserved verbatim.
    expect(parsed?.iterationNumber).toBe(1);
  });

  it('still rejects rows with missing or malformed fields (only the exit reason is forward-compat)', () => {
    expect(parseIterationRecord('not json at all')).toBeNull();
    expect(parseIterationRecord(row({ iterationNumber: 'one' }))).toBeNull();
    expect(parseIterationRecord(row({ startedAt: 'soon' }))).toBeNull();
    expect(parseIterationRecord(row({ exitReason: 42 }))).toBeNull();
  });
});
