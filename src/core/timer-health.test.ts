import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  TIMER_HEALTH_OVERDUE_INTERVALS,
  TIMER_HEALTH_PERSIST_FILE_MODE,
  TIMER_HEALTH_PERSIST_SCHEMA_VERSION,
  TIMER_HEALTH_PERSIST_SIZE_CAP_BYTES,
  TIMER_HEALTH_SCHEMA_VERSION,
  TIMER_HEALTH_STATE_FILE,
  summarizeTimerHealth,
  timerHealthStatePath,
  TimerHealthTracker,
} from './timer-health.js';

describe('TimerHealthTracker (issue #1771)', () => {
  test('registers loops, stamps lastFiredAt, and computes overdue from last fire', () => {
    let nowMs = Date.parse('2026-08-01T10:00:00.000Z');
    const tracker = new TimerHealthTracker(() => nowMs);

    tracker.register('tokenScan', 5_000);
    tracker.register('save', 60_000);

    let snap = tracker.snapshot();
    expect(snap.schemaVersion).toBe(TIMER_HEALTH_SCHEMA_VERSION);
    expect(snap.loops).toHaveLength(2);
    expect(snap.loops.find((l) => l.name === 'tokenScan')).toMatchObject({
      lastFiredAt: null,
      expectedIntervalMs: 5_000,
      overdue: false,
    });

    nowMs += 1_000;
    tracker.recordFire('tokenScan');
    snap = tracker.snapshot();
    expect(snap.loops.find((l) => l.name === 'tokenScan')).toMatchObject({
      lastFiredAt: '2026-08-01T10:00:01.000Z',
      overdue: false,
    });

    // Just past 2× cadence since last fire → overdue.
    nowMs += 5_000 * TIMER_HEALTH_OVERDUE_INTERVALS + 1;
    snap = tracker.snapshot();
    expect(snap.loops.find((l) => l.name === 'tokenScan')?.overdue).toBe(true);
    // save never fired but age since register is still under 2× 60s.
    expect(snap.loops.find((l) => l.name === 'save')?.overdue).toBe(false);
  });

  test('never-fired loop becomes overdue after 2× expected interval from register', () => {
    let nowMs = Date.parse('2026-08-01T12:00:00.000Z');
    const tracker = new TimerHealthTracker(() => nowMs);
    tracker.register('liveness', 10_000);

    nowMs += 10_000 * TIMER_HEALTH_OVERDUE_INTERVALS;
    expect(tracker.snapshot().loops[0]?.overdue).toBe(false);

    nowMs += 1;
    expect(tracker.snapshot().loops[0]?.overdue).toBe(true);
    expect(tracker.snapshot().loops[0]?.lastFiredAt).toBeNull();
  });

  test('recordFire can refresh expectedIntervalMs for adaptive quota poll', () => {
    let nowMs = Date.parse('2026-08-01T14:00:00.000Z');
    const tracker = new TimerHealthTracker(() => nowMs);
    tracker.register('quotaPoll', 120_000);
    tracker.recordFire('quotaPoll', 240_000);
    expect(tracker.snapshot().loops[0]).toMatchObject({
      name: 'quotaPoll',
      expectedIntervalMs: 240_000,
      lastFiredAt: '2026-08-01T14:00:00.000Z',
      overdue: false,
    });
  });

  test('snapshot lists loops in stable name order', () => {
    const tracker = new TimerHealthTracker(() => Date.parse('2026-08-01T00:00:00.000Z'));
    tracker.register('watchdog', 5_000);
    tracker.register('liveness', 15_000);
    tracker.register('save', 60_000);
    expect(tracker.snapshot().loops.map((l) => l.name)).toEqual([
      'liveness',
      'save',
      'watchdog',
    ]);
  });
});

describe('TimerHealthTracker.summary (issue #2636)', () => {
  test('counts registered / overdue / neverFired without treating a fresh boot as overdue', () => {
    let nowMs = Date.parse('2026-08-18T04:00:00.000Z');
    const tracker = new TimerHealthTracker(() => nowMs);
    tracker.register('save', 60_000);
    tracker.register('maintenancePrune', 3_600_000);
    tracker.register('watchdog', 5_000);
    tracker.recordFire('watchdog');

    // Still inside the first save interval and well under 2× watchdog cadence.
    nowMs += 4_000;
    expect(tracker.summary()).toEqual({
      registered: 3,
      overdue: 0,
      neverFired: 2,
      oldestNeverFiredName: 'maintenancePrune',
      oldestOverdueName: null,
    });
    expect(tracker.summary()).not.toHaveProperty('loops');
  });

  test('names the oldest never-fired loop by register time, not name order', () => {
    let nowMs = Date.parse('2026-08-18T04:00:00.000Z');
    const tracker = new TimerHealthTracker(() => nowMs);
    tracker.register('watchdog', 3_600_000);
    nowMs += 1_000;
    tracker.register('maintenancePrune', 3_600_000);

    const summary = tracker.summary();
    expect(summary.neverFired).toBe(2);
    expect(summary.oldestNeverFiredName).toBe('watchdog');
  });

  test('counts a never-fired loop overdue only after 2× its expected interval', () => {
    let nowMs = Date.parse('2026-08-18T04:00:00.000Z');
    const tracker = new TimerHealthTracker(() => nowMs);
    tracker.register('maintenancePrune', 3_600_000);

    nowMs += 3_600_000;
    expect(tracker.summary()).toMatchObject({ overdue: 0, neverFired: 1 });

    nowMs += 3_600_000 + 1;
    expect(tracker.summary()).toEqual({
      registered: 1,
      overdue: 1,
      neverFired: 1,
      oldestNeverFiredName: 'maintenancePrune',
      oldestOverdueName: 'maintenancePrune',
    });
  });

  test('names the oldest overdue loop that has already fired', () => {
    let nowMs = Date.parse('2026-08-18T04:00:00.000Z');
    const tracker = new TimerHealthTracker(() => nowMs);
    tracker.register('save', 60_000);
    tracker.register('tokenScan', 5_000);
    tracker.recordFire('save');
    tracker.recordFire('tokenScan');

    nowMs += 5_000 * TIMER_HEALTH_OVERDUE_INTERVALS + 1;
    // tokenScan is overdue; save (60s cadence) is not yet.
    expect(tracker.summary()).toMatchObject({
      overdue: 1,
      neverFired: 0,
      oldestNeverFiredName: null,
      oldestOverdueName: 'tokenScan',
    });
  });

  test('picks the older progress stamp when two loops are overdue', () => {
    let nowMs = Date.parse('2026-08-18T04:00:00.000Z');
    const tracker = new TimerHealthTracker(() => nowMs);
    tracker.register('save', 10_000);
    tracker.register('tokenScan', 10_000);
    tracker.recordFire('save');
    nowMs += 1_000;
    tracker.recordFire('tokenScan');

    nowMs += 10_000 * TIMER_HEALTH_OVERDUE_INTERVALS + 1;
    expect(tracker.summary()).toMatchObject({
      overdue: 2,
      neverFired: 0,
      oldestOverdueName: 'save',
    });
  });

  test('summary walks memory only and does not queue a persist write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'timer-health-summary-'));
    try {
      const pendingWrites: Array<() => void> = [];
      let nowMs = Date.parse('2026-08-18T04:00:00.000Z');
      const tracker = new TimerHealthTracker(() => nowMs, {
        persistPath: timerHealthStatePath(dir),
        scheduleWrite: (work) => { pendingWrites.push(work); },
      });
      tracker.register('save', 60_000);
      tracker.recordFire('save');
      pendingWrites.splice(0);
      nowMs += 1_000;
      expect(tracker.summary().registered).toBe(1);
      expect(pendingWrites).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('summarizeTimerHealth from a snapshot (issue #2636)', () => {
  test('falls back to name order when register time is not on the snapshot', () => {
    expect(summarizeTimerHealth({
      loops: [
        {
          name: 'watchdog',
          lastFiredAt: null,
          expectedIntervalMs: 5_000,
          overdue: false,
        },
        {
          name: 'maintenancePrune',
          lastFiredAt: null,
          expectedIntervalMs: 3_600_000,
          overdue: false,
        },
      ],
    })).toEqual({
      registered: 2,
      overdue: 0,
      neverFired: 2,
      oldestNeverFiredName: 'maintenancePrune',
      oldestOverdueName: null,
    });
  });

  test('counts overdue loops and names the one with the oldest lastFiredAt', () => {
    expect(summarizeTimerHealth({
      loops: [
        {
          name: 'save',
          lastFiredAt: '2026-08-18T08:00:00.000Z',
          expectedIntervalMs: 60_000,
          overdue: true,
        },
        {
          name: 'tokenScan',
          lastFiredAt: '2026-08-18T09:00:00.000Z',
          expectedIntervalMs: 5_000,
          overdue: true,
        },
        {
          name: 'watchdog',
          lastFiredAt: '2026-08-18T10:00:00.000Z',
          expectedIntervalMs: 5_000,
          overdue: false,
        },
      ],
    })).toEqual({
      registered: 3,
      overdue: 2,
      neverFired: 0,
      oldestNeverFiredName: null,
      oldestOverdueName: 'save',
    });
  });
});

describe('TimerHealthTracker persist (issue #2638)', () => {
  let dir: string;
  let persistPath: string;
  let pendingWrites: Array<() => void>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'timer-health-'));
    persistPath = timerHealthStatePath(dir);
    pendingWrites = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function drainWrites(): void {
    const queued = pendingWrites.splice(0);
    for (const work of queued) work();
  }

  function makeTracker(now: () => number): TimerHealthTracker {
    return new TimerHealthTracker(now, {
      persistPath,
      scheduleWrite: (work) => pendingWrites.push(work),
    });
  }

  test('survives a hard kill: reloaded tracker shows the pre-crash last-fired time', () => {
    const firedAt = Date.parse('2026-08-18T02:00:00.000Z');
    const first = makeTracker(() => firedAt);
    first.register('maintenancePrune', 3_600_000);
    first.recordFire('maintenancePrune');
    drainWrites();

    const restartNow = Date.parse('2026-08-18T02:05:00.000Z');
    const restarted = makeTracker(() => restartNow);
    restarted.register('maintenancePrune', 3_600_000);
    const prune = restarted.snapshot().loops.find((l) => l.name === 'maintenancePrune');
    expect(prune?.lastFiredAt).toBe('2026-08-18T02:00:00.000Z');
    expect(prune?.overdue).toBe(false);
  });

  test('reload is history, not a new fire: lastFiredAt stays pre-crash and register does not rewrite', () => {
    const firedAt = Date.parse('2026-08-18T03:00:00.000Z');
    const first = makeTracker(() => firedAt);
    first.register('prodSmokeTick', 3_600_000);
    first.recordFire('prodSmokeTick');
    drainWrites();
    const before = readFileSync(persistPath, 'utf8');

    const restartNow = Date.parse('2026-08-18T03:10:00.000Z');
    const restarted = makeTracker(() => restartNow);
    restarted.register('prodSmokeTick', 3_600_000);
    expect(pendingWrites).toHaveLength(0);
    expect(readFileSync(persistPath, 'utf8')).toBe(before);
    expect(restarted.snapshot().loops[0]?.lastFiredAt).toBe('2026-08-18T03:00:00.000Z');
  });

  test('overdue becomes true when now minus the persisted stamp exceeds 2× interval', () => {
    const intervalMs = 3_600_000;
    const firedAt = Date.parse('2026-08-18T00:00:00.000Z');
    const first = makeTracker(() => firedAt);
    first.register('deployLagDetector', intervalMs);
    first.recordFire('deployLagDetector');
    drainWrites();

    let nowMs = firedAt + intervalMs * TIMER_HEALTH_OVERDUE_INTERVALS;
    const restarted = makeTracker(() => nowMs);
    restarted.register('deployLagDetector', intervalMs);
    expect(restarted.snapshot().loops[0]?.overdue).toBe(false);

    nowMs += 1;
    expect(restarted.snapshot().loops[0]?.overdue).toBe(true);
    expect(restarted.snapshot().loops[0]?.lastFiredAt).toBe('2026-08-18T00:00:00.000Z');
  });

  test('recordFire queues the write and does not wait on disk', () => {
    const tracker = makeTracker(() => Date.parse('2026-08-18T04:00:00.000Z'));
    tracker.register('save', 60_000);
    tracker.recordFire('save');
    expect(existsSync(persistPath)).toBe(false);
    expect(tracker.snapshot().loops[0]?.lastFiredAt).toBe('2026-08-18T04:00:00.000Z');
    drainWrites();
    expect(existsSync(persistPath)).toBe(true);
  });

  test('default scheduler writes after recordFire returns', async () => {
    const tracker = new TimerHealthTracker(() => Date.parse('2026-08-18T04:30:00.000Z'), {
      persistPath,
    });
    tracker.register('save', 60_000);
    tracker.recordFire('save');
    expect(existsSync(persistPath)).toBe(false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(existsSync(persistPath)).toBe(true);
  });

  test('writes owner-only mode 0600 and stays under the size cap', () => {
    const tracker = makeTracker(() => Date.parse('2026-08-18T05:00:00.000Z'));
    tracker.register('save', 60_000);
    tracker.recordFire('save');
    drainWrites();
    expect(statSync(persistPath).mode & 0o777).toBe(TIMER_HEALTH_PERSIST_FILE_MODE);
    expect(statSync(persistPath).size).toBeLessThanOrEqual(TIMER_HEALTH_PERSIST_SIZE_CAP_BYTES);
    expect(persistPath.endsWith(TIMER_HEALTH_STATE_FILE)).toBe(true);
    const raw = JSON.parse(readFileSync(persistPath, 'utf8')) as {
      schemaVersion: string;
      loops: { save: { lastFiredAtMs: number } };
    };
    expect(raw.schemaVersion).toBe(TIMER_HEALTH_PERSIST_SCHEMA_VERSION);
    expect(raw.loops.save.lastFiredAtMs).toBe(Date.parse('2026-08-18T05:00:00.000Z'));
  });

  test('skips write when serialized stamps would exceed the injected cap', () => {
    const tracker = new TimerHealthTracker(() => Date.parse('2026-08-18T05:15:00.000Z'), {
      persistPath,
      scheduleWrite: (work) => pendingWrites.push(work),
      sizeCapBytes: 20,
    });
    tracker.register('save', 60_000);
    tracker.recordFire('save');
    drainWrites();
    expect(existsSync(persistPath)).toBe(false);
  });

  test('tightens a leftover world-readable stamp file to 0600 on the next fire', () => {
    const tracker = makeTracker(() => Date.parse('2026-08-18T05:30:00.000Z'));
    tracker.register('save', 60_000);
    tracker.recordFire('save');
    drainWrites();
    chmodSync(persistPath, 0o644);
    tracker.recordFire('save');
    drainWrites();
    expect(statSync(persistPath).mode & 0o777).toBe(TIMER_HEALTH_PERSIST_FILE_MODE);
  });

  test('corrupt JSON does not block startup (fail-open, lastFiredAt stays null)', () => {
    writeFileSync(persistPath, '{not json', 'utf8');
    const tracker = makeTracker(() => Date.parse('2026-08-18T06:00:00.000Z'));
    tracker.register('maintenancePrune', 3_600_000);
    expect(tracker.snapshot().loops[0]?.lastFiredAt).toBeNull();
    expect(tracker.snapshot().loops[0]?.overdue).toBe(false);
  });

  test('wrong schema version fails open', () => {
    writeFileSync(persistPath, JSON.stringify({
      schemaVersion: 'nope',
      loops: { save: { lastFiredAtMs: 1 } },
    }));
    const wrongSchema = makeTracker(() => Date.parse('2026-08-18T07:00:00.000Z'));
    wrongSchema.register('save', 60_000);
    expect(wrongSchema.snapshot().loops[0]?.lastFiredAt).toBeNull();
  });

  test('oversized but valid persist file fails open (size check, not parse)', () => {
    const firedAt = Date.parse('2026-08-18T01:00:00.000Z');
    const payload = JSON.stringify({
      schemaVersion: TIMER_HEALTH_PERSIST_SCHEMA_VERSION,
      loops: { save: { lastFiredAtMs: firedAt } },
    });
    writeFileSync(persistPath, payload);
    const oversized = new TimerHealthTracker(() => Date.parse('2026-08-18T07:01:00.000Z'), {
      persistPath,
      scheduleWrite: (work) => pendingWrites.push(work),
      sizeCapBytes: Buffer.byteLength(payload, 'utf8') - 1,
    });
    oversized.register('save', 60_000);
    expect(oversized.snapshot().loops[0]?.lastFiredAt).toBeNull();
  });

  test('unknown loop names and non-finite stamps are ignored', () => {
    writeFileSync(persistPath, JSON.stringify({
      schemaVersion: TIMER_HEALTH_PERSIST_SCHEMA_VERSION,
      loops: {
        notALoop: { lastFiredAtMs: Date.parse('2026-08-18T01:00:00.000Z') },
        save: { lastFiredAtMs: Number.NaN },
        liveness: { lastFiredAtMs: Date.parse('2026-08-18T01:05:00.000Z') },
      },
    }));
    const tracker = makeTracker(() => Date.parse('2026-08-18T08:00:00.000Z'));
    tracker.register('save', 60_000);
    tracker.register('liveness', 15_000);
    const byName = Object.fromEntries(tracker.snapshot().loops.map((l) => [l.name, l.lastFiredAt]));
    expect(byName.save).toBeNull();
    expect(byName.liveness).toBe('2026-08-18T01:05:00.000Z');
    expect(tracker.snapshot().loops.find((l) => l.name === 'notALoop')).toBeUndefined();
  });

  test('a disk error on the queued write does not throw from recordFire', () => {
    const blocker = join(dir, 'not-a-dir');
    writeFileSync(blocker, 'file');
    const tracker = new TimerHealthTracker(() => Date.parse('2026-08-18T09:00:00.000Z'), {
      persistPath: join(blocker, TIMER_HEALTH_STATE_FILE),
      scheduleWrite: (work) => pendingWrites.push(work),
    });
    tracker.register('save', 60_000);
    expect(() => tracker.recordFire('save')).not.toThrow();
    expect(() => drainWrites()).not.toThrow();
  });

  test('unregistered persisted loops stay off the snapshot until register', () => {
    const firedAt = Date.parse('2026-08-18T10:00:00.000Z');
    const first = makeTracker(() => firedAt);
    first.register('quotaPoll', 120_000);
    first.recordFire('quotaPoll');
    drainWrites();

    const restarted = makeTracker(() => Date.parse('2026-08-18T10:01:00.000Z'));
    expect(restarted.snapshot().loops).toEqual([]);
    restarted.register('quotaPoll', 120_000);
    expect(restarted.snapshot().loops[0]?.lastFiredAt).toBe('2026-08-18T10:00:00.000Z');
  });
});
