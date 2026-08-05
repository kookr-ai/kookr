import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  PrLessonsDiscovery,
  PrLessonsStateHolder,
  type PrLessonsDiscoveryResult,
} from './pr-lessons-discovery.js';

describe('PrLessonsDiscovery.discover', () => {
  let claudeDir: string;

  beforeEach(() => {
    claudeDir = mkdtempSync(join(tmpdir(), 'pr-lessons-disc-'));
  });

  afterEach(() => {
    rmSync(claudeDir, { recursive: true, force: true });
  });

  function writeLessons(slug: string, state: unknown, rawLearnings?: string): void {
    const dir = join(claudeDir, `${slug}-pr-lessons`);
    mkdirSync(dir, { recursive: true });
    const raw = typeof state === 'string' ? state : JSON.stringify(state);
    writeFileSync(join(dir, 'state.json'), raw, 'utf-8');
    if (rawLearnings !== undefined) {
      writeFileSync(join(dir, 'learnings-raw.md'), rawLearnings, 'utf-8');
    }
  }

  test('discovers PR lessons state for the happy path with raw learnings line count', async () => {
    writeLessons(
      'owner-repo',
      { repo: 'owner/repo', total_processed: 12, distillation_count: 3 },
      'a\nb\nc',
    );

    const result = await new PrLessonsDiscovery(claudeDir).discover();

    expect(result.warnings).toEqual([]);
    expect(result.scannedAt).toBeTruthy();
    expect([...result.states.keys()]).toEqual(['github.com/owner/repo']);
    expect(result.states.get('github.com/owner/repo')).toEqual({
      totalProcessed: 12,
      distillationCount: 3,
      rawLearningsLines: 3,
    });
  });

  test('normalizes the repo slug to lowercase in the project id', async () => {
    writeLessons('Mixed-Case', { repo: 'Owner/Repo', total_processed: 1, distillation_count: 0 });

    const result = await new PrLessonsDiscovery(claudeDir).discover();

    expect([...result.states.keys()]).toEqual(['github.com/owner/repo']);
  });

  test('reports zero raw learnings lines when learnings-raw.md is missing', async () => {
    writeLessons('owner-repo', { repo: 'owner/repo', total_processed: 4, distillation_count: 1 });

    const result = await new PrLessonsDiscovery(claudeDir).discover();

    expect(result.states.get('github.com/owner/repo')?.rawLearningsLines).toBe(0);
  });

  test('treats a missing ~/.claude directory as empty without error', async () => {
    const result = await new PrLessonsDiscovery(join(claudeDir, 'does-not-exist')).discover();

    expect(result.states.size).toBe(0);
    expect(result.warnings).toEqual([]);
    expect(result.scannedAt).toBeTruthy();
  });

  test('ignores directories that do not end in -pr-lessons', async () => {
    mkdirSync(join(claudeDir, 'skills'), { recursive: true });
    mkdirSync(join(claudeDir, 'owner-repo-recon'), { recursive: true });
    writeLessons('real-repo', { repo: 'real/repo', total_processed: 2, distillation_count: 0 });

    const result = await new PrLessonsDiscovery(claudeDir).discover();

    expect([...result.states.keys()]).toEqual(['github.com/real/repo']);
    expect(result.warnings).toEqual([]);
  });

  test('ignores a file (non-directory) whose name ends in -pr-lessons', async () => {
    writeFileSync(join(claudeDir, 'rogue-pr-lessons'), 'not a dir', 'utf-8');
    writeLessons('real-repo', { repo: 'real/repo', total_processed: 1, distillation_count: 1 });

    const result = await new PrLessonsDiscovery(claudeDir).discover();

    expect([...result.states.keys()]).toEqual(['github.com/real/repo']);
    expect(result.warnings).toEqual([]);
  });

  test('warns and continues when state.json is not readable', async () => {
    // Directory exists but has no state.json → readFile rejects.
    mkdirSync(join(claudeDir, 'no-state-pr-lessons'), { recursive: true });

    const result = await new PrLessonsDiscovery(claudeDir).discover();

    expect(result.states.size).toBe(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toBe('no-state-pr-lessons: state.json not readable');
  });

  test('warns and continues when state.json is not valid JSON', async () => {
    writeLessons('bad-json', '{ not valid json ');

    const result = await new PrLessonsDiscovery(claudeDir).discover();

    expect(result.states.size).toBe(0);
    expect(result.warnings).toEqual(['bad-json-pr-lessons: state.json is not valid JSON']);
  });

  test('warns and continues when state.json is valid JSON but not an object', async () => {
    writeLessons('scalar', '"just a string"');
    writeLessons('null-state', 'null');

    const result = await new PrLessonsDiscovery(claudeDir).discover();

    expect(result.states.size).toBe(0);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings).toContain('scalar-pr-lessons: state.json is not an object');
    expect(result.warnings).toContain('null-state-pr-lessons: state.json is not an object');
  });

  test('warns and continues when the repo field is invalid or missing', async () => {
    writeLessons('no-repo', { total_processed: 5, distillation_count: 2 });
    writeLessons('bad-slug', { repo: 'not-a-valid-slug', total_processed: 1, distillation_count: 0 });

    const result = await new PrLessonsDiscovery(claudeDir).discover();

    expect(result.states.size).toBe(0);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings).toContain('no-repo-pr-lessons: invalid or missing repo field');
    expect(result.warnings).toContain('bad-slug-pr-lessons: invalid or missing repo field');
  });

  test('defaults missing or non-numeric counters to zero', async () => {
    writeLessons('missing-counts', { repo: 'owner/repo' });
    writeLessons('string-counts', {
      repo: 'other/repo',
      total_processed: '7',
      distillation_count: null,
    });

    const result = await new PrLessonsDiscovery(claudeDir).discover();

    expect(result.warnings).toEqual([]);
    expect(result.states.get('github.com/owner/repo')).toEqual({
      totalProcessed: 0,
      distillationCount: 0,
      rawLearningsLines: 0,
    });
    expect(result.states.get('github.com/other/repo')).toEqual({
      totalProcessed: 0,
      distillationCount: 0,
      rawLearningsLines: 0,
    });
  });

  test('collects multiple valid projects alongside a degraded one', async () => {
    writeLessons('a-a', { repo: 'a/a', total_processed: 1, distillation_count: 1 });
    writeLessons('b-b', { repo: 'b/b', total_processed: 2, distillation_count: 0 });
    writeLessons('bad', '{ broken ');

    const result = await new PrLessonsDiscovery(claudeDir).discover();

    expect([...result.states.keys()].sort()).toEqual(['github.com/a/a', 'github.com/b/b']);
    expect(result.warnings).toEqual(['bad-pr-lessons: state.json is not valid JSON']);
  });
});

describe('PrLessonsStateHolder', () => {
  let claudeDir: string;

  beforeEach(() => {
    claudeDir = mkdtempSync(join(tmpdir(), 'pr-lessons-state-'));
  });

  afterEach(() => {
    rmSync(claudeDir, { recursive: true, force: true });
  });

  function writeLessons(slug: string, state: unknown): void {
    const dir = join(claudeDir, `${slug}-pr-lessons`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state), 'utf-8');
  }

  test('initial snapshot is empty until the first rescan', () => {
    const holder = new PrLessonsStateHolder(new PrLessonsDiscovery(claudeDir));
    const snap = holder.getSnapshot();
    expect(snap.states.size).toBe(0);
    expect(snap.warnings).toEqual([]);
    expect(snap.scannedAt).toBeUndefined();
    expect(snap.lastError).toBeUndefined();
    expect(holder.getForProject('github.com/owner/repo')).toBeUndefined();
  });

  test('rescan swaps in a fresh snapshot', async () => {
    writeLessons('owner-repo', { repo: 'owner/repo', total_processed: 9, distillation_count: 4 });
    const holder = new PrLessonsStateHolder(new PrLessonsDiscovery(claudeDir));

    await holder.rescan();

    const snap = holder.getSnapshot();
    expect([...snap.states.keys()]).toEqual(['github.com/owner/repo']);
    expect(snap.scannedAt).toBeTruthy();
    expect(snap.lastError).toBeUndefined();
    expect(holder.getForProject('github.com/owner/repo')).toEqual({
      totalProcessed: 9,
      distillationCount: 4,
      rawLearningsLines: 0,
    });
  });

  test('getSnapshot returns copies that cannot mutate holder state', async () => {
    writeLessons('owner-repo', { repo: 'owner/repo', total_processed: 1, distillation_count: 0 });
    const holder = new PrLessonsStateHolder(new PrLessonsDiscovery(claudeDir));
    await holder.rescan();

    const snap = holder.getSnapshot();
    snap.states.delete('github.com/owner/repo');
    snap.warnings.push('mutated');

    const fresh = holder.getSnapshot();
    expect([...fresh.states.keys()]).toEqual(['github.com/owner/repo']);
    expect(fresh.warnings).toEqual([]);
  });

  test('concurrent rescans coalesce into a single in-flight scan', async () => {
    let callCount = 0;
    const slowDiscovery = {
      discover: async (): Promise<PrLessonsDiscoveryResult> => {
        callCount++;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          states: new Map([['github.com/x/y', { totalProcessed: 1, distillationCount: 0, rawLearningsLines: 0 }]]),
          warnings: [],
          scannedAt: new Date().toISOString(),
        };
      },
    } as unknown as PrLessonsDiscovery;

    const holder = new PrLessonsStateHolder(slowDiscovery);
    await Promise.all([holder.rescan(), holder.rescan(), holder.rescan()]);

    expect(callCount).toBe(1);
    expect([...holder.getSnapshot().states.keys()]).toEqual(['github.com/x/y']);
  });

  test('a throwing scan preserves the last-known-good state and records lastError', async () => {
    writeLessons('keeper', { repo: 'keeper/repo', total_processed: 5, distillation_count: 2 });
    const holder = new PrLessonsStateHolder(new PrLessonsDiscovery(claudeDir));

    // Seed last-known-good with a real discovery first.
    await holder.rescan();
    expect([...holder.getSnapshot().states.keys()]).toEqual(['github.com/keeper/repo']);

    // Swap in a failing discovery behind the scenes and rescan.
    const throwingDiscovery = {
      discover: async (): Promise<PrLessonsDiscoveryResult> => {
        throw new Error('boom');
      },
    } as unknown as PrLessonsDiscovery;
    (holder as unknown as { discovery: PrLessonsDiscovery }).discovery = throwingDiscovery;

    await holder.rescan();

    const snap = holder.getSnapshot();
    expect([...snap.states.keys()]).toEqual(['github.com/keeper/repo']);
    expect(snap.lastError).toBe('boom');
    expect(holder.getForProject('github.com/keeper/repo')).toEqual({
      totalProcessed: 5,
      distillationCount: 2,
      rawLearningsLines: 0,
    });
  });

  test('a non-Error thrown value is stringified into lastError', async () => {
    const holder = new PrLessonsStateHolder(new PrLessonsDiscovery(claudeDir));
    const throwingDiscovery = {
      discover: async (): Promise<PrLessonsDiscoveryResult> => {
        throw 'plain string failure';
      },
    } as unknown as PrLessonsDiscovery;
    (holder as unknown as { discovery: PrLessonsDiscovery }).discovery = throwingDiscovery;

    await holder.rescan();

    expect(holder.getSnapshot().lastError).toBe('plain string failure');
  });

  test('a successful rescan after a failure clears lastError', async () => {
    writeLessons('owner-repo', { repo: 'owner/repo', total_processed: 3, distillation_count: 1 });
    const realDiscovery = new PrLessonsDiscovery(claudeDir);
    const holder = new PrLessonsStateHolder(realDiscovery);

    // First, force an error.
    const throwingDiscovery = {
      discover: async (): Promise<PrLessonsDiscoveryResult> => {
        throw new Error('boom');
      },
    } as unknown as PrLessonsDiscovery;
    (holder as unknown as { discovery: PrLessonsDiscovery }).discovery = throwingDiscovery;
    await holder.rescan();
    expect(holder.getSnapshot().lastError).toBe('boom');

    // Restore the real discovery and rescan successfully.
    (holder as unknown as { discovery: PrLessonsDiscovery }).discovery = realDiscovery;
    await holder.rescan();

    const snap = holder.getSnapshot();
    expect(snap.lastError).toBeUndefined();
    expect([...snap.states.keys()]).toEqual(['github.com/owner/repo']);
  });

  test('rescan after a project directory is removed updates the snapshot to empty', async () => {
    writeLessons('temp', { repo: 'temp/repo', total_processed: 1, distillation_count: 0 });
    const holder = new PrLessonsStateHolder(new PrLessonsDiscovery(claudeDir));
    await holder.rescan();
    expect([...holder.getSnapshot().states.keys()]).toEqual(['github.com/temp/repo']);

    rmSync(join(claudeDir, 'temp-pr-lessons'), { recursive: true, force: true });
    await holder.rescan();

    expect(holder.getSnapshot().states.size).toBe(0);
    expect(holder.getForProject('github.com/temp/repo')).toBeUndefined();
  });
});
