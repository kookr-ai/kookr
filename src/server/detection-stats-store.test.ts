import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DetectionStatsStore,
  DETECTION_STATS_FILE,
  DETECTION_STATS_SCHEMA_VERSION,
} from './detection-stats-store.js';
import {
  getDetectionStats,
  hydrateDetectionStats,
  recordDetectionCheck,
  recordDetectionFire,
  recordFalsePositive,
  recordSuppression,
  recordSubagentOrphans,
  resetDetectionStats,
  type DetectionStats,
} from '../core/detection-stats.js';

describe('DetectionStatsStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kookr-detection-stats-'));
    resetDetectionStats();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    resetDetectionStats();
  });

  test('save then load round-trips the counters', async () => {
    const store = DetectionStatsStore.forKookrDir(dir);
    recordDetectionCheck('hook_disconnected');
    recordDetectionFire('hook_disconnected');
    recordFalsePositive('hook_disconnected');
    recordSuppression('hook_disconnected', 'snooze_false_positive');
    recordSubagentOrphans(2, 1);
    const snapshot = getDetectionStats();

    await store.save(snapshot);
    const loaded = await store.load();

    expect(loaded).toEqual(snapshot);
    expect(loaded?.falsePositives.hook_disconnected).toBe(1);
    expect(loaded?.suppressionReasons.hook_disconnected.snooze_false_positive).toBe(1);
    expect(loaded?.subagentOrphans).toBe(2);
    expect(loaded?.subagentSessionsWithOrphans).toBe(1);
  });

  test('persists with the schema version envelope', async () => {
    const store = DetectionStatsStore.forKookrDir(dir);
    await store.save(getDetectionStats());

    const raw = JSON.parse(await readFile(join(dir, DETECTION_STATS_FILE), 'utf8'));
    expect(raw.schemaVersion).toBe(DETECTION_STATS_SCHEMA_VERSION);
    expect(raw.stats).toBeTypeOf('object');
  });

  test('load returns null when the file is absent', async () => {
    const store = DetectionStatsStore.forKookrDir(dir);
    expect(await store.load()).toBeNull();
  });

  test('load returns null on corrupt JSON', async () => {
    await writeFile(join(dir, DETECTION_STATS_FILE), '{ not valid json', 'utf8');
    const store = DetectionStatsStore.forKookrDir(dir);
    expect(await store.load()).toBeNull();
  });

  test('load returns null on a mismatched schema version', async () => {
    await writeFile(
      join(dir, DETECTION_STATS_FILE),
      JSON.stringify({ schemaVersion: 'detection-stats.v0', stats: {} }),
      'utf8',
    );
    const store = DetectionStatsStore.forKookrDir(dir);
    expect(await store.load()).toBeNull();
  });

  test('survives a simulated restart: save -> fresh load -> hydrate restores counters', async () => {
    // The wiring index.ts performs at boot, end-to-end: the value the whole
    // feature exists to deliver (rates survive restart).
    recordDetectionCheck('hook_disconnected');
    recordDetectionFire('hook_disconnected');
    recordFalsePositive('hook_disconnected');
    recordSubagentOrphans(4, 2);
    await DetectionStatsStore.forKookrDir(dir).save(getDetectionStats());

    // Simulate process restart: counters reset, a brand-new store reads disk.
    resetDetectionStats();
    expect(getDetectionStats().falsePositives.hook_disconnected).toBe(0);

    const persisted = await DetectionStatsStore.forKookrDir(dir).load();
    expect(persisted).not.toBeNull();
    if (persisted) hydrateDetectionStats(persisted);

    const live = getDetectionStats();
    expect(live.checks.hook_disconnected).toBe(1);
    expect(live.fires.hook_disconnected).toBe(1);
    expect(live.falsePositives.hook_disconnected).toBe(1);
    expect(live.subagentOrphans).toBe(4);
    expect(live.subagentSessionsWithOrphans).toBe(2);
  });

  test('serialized saves do not interleave or corrupt the file', async () => {
    const store = DetectionStatsStore.forKookrDir(dir);
    const a = getDetectionStats();
    recordDetectionCheck('needs_input');
    const b = getDetectionStats();
    await Promise.all([store.save(a), store.save(b)]);

    const loaded = await store.load();
    // Last write wins; the file is always a complete, parseable snapshot.
    expect(loaded).toEqual(b);
  });
});

describe('hydrateDetectionStats', () => {
  beforeEach(() => resetDetectionStats());
  afterEach(() => resetDetectionStats());

  test('replaces the in-memory counters from a snapshot', () => {
    const snapshot = getDetectionStats();
    snapshot.checks.stale_agent = 7;
    snapshot.fires.stale_agent = 4;
    snapshot.falsePositives.stale_agent = 1;
    snapshot.suppressed.stale_agent = 2;
    snapshot.suppressionReasons.stale_agent.subagent_running = 2;
    snapshot.subagentOrphans = 3;
    snapshot.subagentTtlEvictions = 2;

    hydrateDetectionStats(snapshot);

    const live = getDetectionStats();
    expect(live.checks.stale_agent).toBe(7);
    expect(live.fires.stale_agent).toBe(4);
    expect(live.falsePositives.stale_agent).toBe(1);
    expect(live.suppressed.stale_agent).toBe(2);
    expect(live.suppressionReasons.stale_agent.subagent_running).toBe(2);
    expect(live.subagentOrphans).toBe(3);
    expect(live.subagentTtlEvictions).toBe(2);
  });

  test('hydrates known buckets from a partial snapshot and leaves the rest at zero', () => {
    hydrateDetectionStats({ checks: { hook_disconnected: 5 } as DetectionStats['checks'] });
    const live = getDetectionStats();
    expect(live.checks.hook_disconnected).toBe(5);
    expect(live.checks.needs_input).toBe(0);
    expect(live.fires.hook_disconnected).toBe(0);
    expect(live.suppressionReasons.hook_disconnected.subagent_running).toBe(0);
  });

  test('treats missing persisted suppressionReasons as an empty breakdown', () => {
    hydrateDetectionStats({
      suppressed: { hook_disconnected: 4 } as DetectionStats['suppressed'],
    });
    const live = getDetectionStats();
    expect(live.suppressed.hook_disconnected).toBe(4);
    expect(live.suppressionReasons.hook_disconnected.subagent_running).toBe(0);
  });

  test('hydrates known suppression reason keys and ignores stale reason keys', () => {
    hydrateDetectionStats({
      suppressionReasons: {
        hook_disconnected: {
          subagent_running: 2,
          systemic_hook_stall: 1,
          future_reason: 9,
        },
      } as unknown as DetectionStats['suppressionReasons'],
    });
    const live = getDetectionStats();
    expect(live.suppressionReasons.hook_disconnected.subagent_running).toBe(2);
    expect(live.suppressionReasons.hook_disconnected.systemic_hook_stall).toBe(1);
    expect((live.suppressionReasons.hook_disconnected as Record<string, number>).future_reason).toBeUndefined();
  });

  test('ignores negative, non-finite, and non-numeric values', () => {
    hydrateDetectionStats({
      checks: { needs_input: -3, stale_agent: Number.NaN } as unknown as DetectionStats['checks'],
      subagentOrphans: Number.POSITIVE_INFINITY,
    });
    const live = getDetectionStats();
    expect(live.checks.needs_input).toBe(0);
    expect(live.checks.stale_agent).toBe(0);
    expect(live.subagentOrphans).toBe(0);
  });

  test('ignores unknown keys in a stale snapshot', () => {
    hydrateDetectionStats({
      checks: { some_future_type: 9, needs_input: 2 } as unknown as DetectionStats['checks'],
    });
    const live = getDetectionStats();
    expect(live.checks.needs_input).toBe(2);
    expect((live.checks as Record<string, number>).some_future_type).toBeUndefined();
  });

  test('folds deprecated tmux_unresponsive counts into backend_unreachable', () => {
    hydrateDetectionStats({
      checks: {
        tmux_unresponsive: 3,
        backend_unreachable: 2,
      } as unknown as DetectionStats['checks'],
      fires: {
        tmux_unresponsive: 1,
      } as unknown as DetectionStats['fires'],
      suppressionReasons: {
        tmux_unresponsive: {
          subagent_running: 4,
        },
      } as unknown as DetectionStats['suppressionReasons'],
    });
    const live = getDetectionStats();
    expect(live.checks.backend_unreachable).toBe(5);
    expect(live.fires.backend_unreachable).toBe(1);
    expect(live.suppressionReasons.backend_unreachable.subagent_running).toBe(4);
    expect((live.checks as Record<string, number>).tmux_unresponsive).toBeUndefined();
  });
});
