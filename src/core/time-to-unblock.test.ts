import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { InteractionEvent } from './interaction-log.js';
import {
  formatTimeToUnblockChipLabel,
  formatTimeToUnblockChipTitle,
  formatUnblockWait,
} from '../shared/contracts/time-to-unblock.js';
import {
  collectInputResolutionDurations,
  computeTimeToUnblockFromDir,
  computeTimeToUnblockSnapshot,
  medianOf,
} from './time-to-unblock.js';

const NOW = Date.parse('2026-08-17T15:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function resolved(
  overrides: Partial<Extract<InteractionEvent, { type: 'finding_resolved' }>> = {},
): InteractionEvent {
  return {
    type: 'finding_resolved',
    agentId: 'agent-1',
    anomalyType: 'needs_input',
    method: 'input',
    durationMs: 60_000,
    timestamp: new Date(NOW - 10 * 60_000).toISOString(),
    ...overrides,
  };
}

describe('collectInputResolutionDurations', () => {
  test('empty log yields no samples', () => {
    expect(collectInputResolutionDurations([], { nowMs: NOW })).toEqual([]);
  });

  test('keeps only method=input with a finite duration inside the window', () => {
    const events: InteractionEvent[] = [
      resolved({ agentId: 'keep-1', durationMs: 10_000 }),
      resolved({ agentId: 'skip', method: 'skip', durationMs: 1_000 }),
      resolved({ agentId: 'snooze', method: 'snooze', durationMs: 2_000 }),
      resolved({ agentId: 'auto', method: 'auto_clear', durationMs: 3_000 }),
      resolved({ agentId: 'fp', method: 'false_positive', durationMs: 4_000 }),
      resolved({ agentId: 'infinite', durationMs: Number.POSITIVE_INFINITY }),
      resolved({ agentId: 'nan', durationMs: Number.NaN }),
      resolved({
        agentId: 'old',
        durationMs: 99_000,
        timestamp: new Date(NOW - 25 * HOUR).toISOString(),
      }),
      resolved({
        agentId: 'future',
        durationMs: 5_000,
        timestamp: new Date(NOW + HOUR).toISOString(),
      }),
      { type: 'finding_skipped', agentId: 'other', anomalyType: 'needs_input', timestamp: new Date(NOW).toISOString() },
      resolved({ agentId: 'keep-2', durationMs: 20_000 }),
    ];

    expect(collectInputResolutionDurations(events, { nowMs: NOW })).toEqual([10_000, 20_000]);
  });
});

describe('medianOf', () => {
  test('empty is null', () => {
    expect(medianOf([])).toBeNull();
  });

  test('known odd-length fixture is the middle value', () => {
    // 2m, 5m, 12m, 40m, 3h — one long wait must not pull the median to hours.
    expect(medianOf([3 * HOUR, 2 * 60_000, 12 * 60_000, 40 * 60_000, 5 * 60_000])).toBe(12 * 60_000);
  });

  test('even-length fixture averages the two middle values', () => {
    expect(medianOf([1, 3, 7, 9])).toBe(5);
  });
});

describe('computeTimeToUnblockSnapshot', () => {
  test('empty log returns a zero-sample snapshot', () => {
    expect(computeTimeToUnblockSnapshot([], { nowMs: NOW })).toEqual({
      schemaVersion: 'time-to-unblock.v1',
      medianMs: null,
      sampleCount: 0,
      windowMs: 24 * HOUR,
      generatedAt: new Date(NOW).toISOString(),
    });
  });

  test('mixed methods do not change the known median fixture', () => {
    const events: InteractionEvent[] = [
      resolved({ durationMs: 2 * 60_000, timestamp: new Date(NOW - 5 * 60_000).toISOString() }),
      resolved({ durationMs: 5 * 60_000, timestamp: new Date(NOW - 4 * 60_000).toISOString() }),
      resolved({ durationMs: 12 * 60_000, timestamp: new Date(NOW - 3 * 60_000).toISOString() }),
      resolved({ durationMs: 40 * 60_000, timestamp: new Date(NOW - 2 * 60_000).toISOString() }),
      resolved({ durationMs: 3 * HOUR, timestamp: new Date(NOW - 60_000).toISOString() }),
      resolved({ method: 'skip', durationMs: 1, timestamp: new Date(NOW - 30_000).toISOString() }),
    ];

    const snapshot = computeTimeToUnblockSnapshot(events, { nowMs: NOW });
    expect(snapshot.sampleCount).toBe(5);
    expect(snapshot.medianMs).toBe(12 * 60_000);
  });
});

describe('formatUnblockWait', () => {
  test('formats seconds, minutes, hours, and days', () => {
    expect(formatUnblockWait(45_000)).toBe('45s');
    expect(formatUnblockWait(12 * 60_000)).toBe('12m');
    expect(formatUnblockWait(HOUR + 5 * 60_000)).toBe('1h 5m');
    expect(formatUnblockWait(2 * 24 * HOUR)).toBe('2d');
  });

  test('non-finite and negative waits render as an em dash', () => {
    expect(formatUnblockWait(Number.NaN)).toBe('—');
    expect(formatUnblockWait(-1)).toBe('—');
  });
});

describe('formatTimeToUnblockChipLabel', () => {
  test('puts volume next to median when samples exist', () => {
    expect(formatTimeToUnblockChipLabel(12, 8 * 60_000)).toBe('12 unblocked (24h) · median 8m');
  });

  test('omits the count copy when sampleCount is 0', () => {
    expect(formatTimeToUnblockChipLabel(0, 8 * 60_000)).toBe('median 8m');
    expect(formatTimeToUnblockChipLabel(0, 8 * 60_000)).not.toContain('unblocked');
  });

  test('labels a non-default window from windowMs', () => {
    expect(formatTimeToUnblockChipLabel(12, 8 * 60_000, 12 * 3_600_000)).toBe(
      '12 unblocked (12h) · median 8m',
    );
  });
});

describe('formatTimeToUnblockChipTitle', () => {
  test('explains the rolling 24-hour window and excludes skip/snooze', () => {
    expect(formatTimeToUnblockChipTitle(12, 8 * 60_000)).toBe(
      '12 findings unblocked by a human reply over the last 24 hours; median wait 8m. Skip and snooze are not counted.',
    );
  });

  test('omits volume from the title when sampleCount is 0', () => {
    expect(formatTimeToUnblockChipTitle(0, 8 * 60_000)).toBe(
      'Median time a finding waited for a human reply over the last 24 hours',
    );
  });

  test('names a non-default window in hours', () => {
    expect(formatTimeToUnblockChipTitle(12, 8 * 60_000, 12 * 3_600_000)).toContain('last 12 hours');
  });
});

describe('computeTimeToUnblockFromDir', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  test('reads session JSONL and ignores stale session files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kookr-ttu-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'sessions', 'fresh'), { recursive: true });
    mkdirSync(join(dir, 'sessions', 'stale'), { recursive: true });

    writeFileSync(
      join(dir, 'sessions', 'fresh', 'interactions.jsonl'),
      [
        JSON.stringify(resolved({ durationMs: 8 * 60_000 })),
        JSON.stringify(resolved({ durationMs: 12 * 60_000, agentId: 'a2' })),
        JSON.stringify(resolved({ durationMs: 20 * 60_000, agentId: 'a3' })),
      ].join('\n') + '\n',
    );
    writeFileSync(
      join(dir, 'interaction-log.jsonl'),
      JSON.stringify(resolved({ durationMs: 10 * 60_000, agentId: 'root' })) + '\n',
    );

    const stalePath = join(dir, 'sessions', 'stale', 'interactions.jsonl');
    writeFileSync(
      stalePath,
      JSON.stringify(resolved({
        durationMs: 99 * 60_000,
        timestamp: new Date(NOW - 30 * HOUR).toISOString(),
      })) + '\n',
    );
    // Force the stale file's mtime outside the 24h window.
    const { utimesSync } = await import('node:fs');
    utimesSync(stalePath, new Date(NOW - 30 * HOUR), new Date(NOW - 30 * HOUR));

    const snapshot = await computeTimeToUnblockFromDir(dir, { nowMs: NOW });
    expect(snapshot.sampleCount).toBe(4);
    expect(snapshot.medianMs).toBe(11 * 60_000);
  });

  test('missing sessions directory is an empty snapshot, not an error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kookr-ttu-empty-'));
    dirs.push(dir);
    await expect(computeTimeToUnblockFromDir(dir, { nowMs: NOW })).resolves.toMatchObject({
      medianMs: null,
      sampleCount: 0,
    });
  });
});
