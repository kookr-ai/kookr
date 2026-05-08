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

describe('parseIterationRecord — new stall-handling exit reasons', () => {
  it('round-trips target_stalled', () => {
    const record = sampleRecord({ exitReason: 'target_stalled' });
    const line = JSON.stringify(record);
    expect(parseIterationRecord(line)).toEqual(record);
  });

  it('round-trips all_targets_stalled', () => {
    const record = sampleRecord({ exitReason: 'all_targets_stalled' });
    const line = JSON.stringify(record);
    expect(parseIterationRecord(line)).toEqual(record);
  });

  it('round-trips iteration_cost_cap', () => {
    const record = sampleRecord({ exitReason: 'iteration_cost_cap' });
    const line = JSON.stringify(record);
    expect(parseIterationRecord(line)).toEqual(record);
  });

  it('round-trips a record with a stalled verdict', () => {
    const record = sampleRecord({
      exitReason: 'target_stalled',
      verdict: { verdict: 'stalled', iteration: 1, target: '154', reason: 'tests fail to compile', blockers: ['missing dep:foo'] },
    });
    const line = JSON.stringify(record);
    expect(parseIterationRecord(line)).toEqual(record);
  });

  it('round-trips a record with a progress verdict (target only)', () => {
    const record = sampleRecord({
      verdict: { verdict: 'progress', iteration: 1, target: '153' },
    });
    expect(parseIterationRecord(JSON.stringify(record))).toEqual(record);
  });

  it('round-trips a record with a complete verdict (no target)', () => {
    const record = sampleRecord({
      exitReason: 'predicate_satisfied',
      verdict: { verdict: 'complete', iteration: 1, reason: 'all targets shipped' },
    });
    expect(parseIterationRecord(JSON.stringify(record))).toEqual(record);
  });

  it('round-trips costDeltaUsd including null and forward-compat omit', () => {
    const known = sampleRecord({ costDeltaUsd: 0.05 });
    expect(parseIterationRecord(JSON.stringify(known))?.costDeltaUsd).toBe(0.05);

    const unknown = sampleRecord({ costDeltaUsd: null });
    expect(parseIterationRecord(JSON.stringify(unknown))?.costDeltaUsd).toBeNull();

    // Legacy log records (pre-PR1, no costDeltaUsd field) parse cleanly with
    // the field absent — same forward-compat behavior as `verdict`.
    const legacy = sampleRecord();
    const legacyJson = JSON.stringify(legacy);
    expect(legacyJson).not.toContain('costDeltaUsd');
    const parsed = parseIterationRecord(legacyJson);
    expect(parsed).not.toBeNull();
    expect(parsed!.costDeltaUsd).toBeUndefined();
  });

  it('drops malformed verdict but keeps the rest of the record', () => {
    // Legacy log records (no verdict field) parse cleanly.
    const legacy = sampleRecord();
    expect(parseIterationRecord(JSON.stringify(legacy))?.verdict).toBeUndefined();

    // Future-or-corrupt verdict shape: silently dropped, record otherwise valid.
    const withGarbage = { ...sampleRecord(), verdict: { verdict: 'unknown', iteration: 1 } };
    const parsed = parseIterationRecord(JSON.stringify(withGarbage));
    expect(parsed).not.toBeNull();
    expect(parsed!.verdict).toBeUndefined();
    expect(parsed!.iterationNumber).toBe(1);
  });

  it('rejects stalled verdict missing required target field but keeps surrounding record', () => {
    // A "stalled" verdict without `target` is malformed by schema; the field
    // is dropped. The surrounding record stays valid.
    const record = { ...sampleRecord(), verdict: { verdict: 'stalled', iteration: 1, reason: 'no target' } };
    const parsed = parseIterationRecord(JSON.stringify(record));
    expect(parsed).not.toBeNull();
    expect(parsed!.verdict).toBeUndefined();
    expect(parsed!.iterationNumber).toBe(1);
  });
});
