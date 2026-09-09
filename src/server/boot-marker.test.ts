import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BootMarkerStore,
  bootMarkerPath,
  classifyBoot,
  parseBootMarker,
  readBootMarker,
  BOOT_MARKER_SCHEMA_VERSION,
  type BootMarkerFile,
} from './boot-marker.js';

/**
 * Issue #2790: the persisted clean-shutdown marker must let a fresh boot tell a
 * graceful restart from a crash/OOM/SIGKILL, and must be fail-safe on every
 * disk error.
 */

describe('classifyBoot', () => {
  it('reports unknown/no_prior_marker when there is no previous marker', () => {
    expect(classifyBoot({ marker: null, unreadable: false })).toEqual({
      status: 'unknown',
      reason: 'no_prior_marker',
      previousStartedAt: null,
      previousShutdownAt: null,
      previousSignal: null,
      dirtyStreak: 0,
    });
  });

  it('reports unknown/marker_unreadable when the previous marker was corrupt', () => {
    expect(classifyBoot({ marker: null, unreadable: true })).toEqual({
      status: 'unknown',
      reason: 'marker_unreadable',
      previousStartedAt: null,
      previousShutdownAt: null,
      previousSignal: null,
      dirtyStreak: 0,
    });
  });

  it('reports clean when the previous marker recorded a graceful shutdown', () => {
    const marker: BootMarkerFile = {
      schemaVersion: BOOT_MARKER_SCHEMA_VERSION,
      state: 'clean',
      bootId: 'b1',
      startedAt: '2026-09-02T10:00:00.000Z',
      pid: 111,
      shutdownAt: '2026-09-02T11:00:00.000Z',
      signal: 'SIGTERM',
      dirtyStreak: 0,
    };
    expect(classifyBoot({ marker, unreadable: false })).toEqual({
      status: 'clean',
      reason: 'clean_shutdown',
      previousStartedAt: '2026-09-02T10:00:00.000Z',
      previousShutdownAt: '2026-09-02T11:00:00.000Z',
      previousSignal: 'SIGTERM',
      dirtyStreak: 0,
    });
  });

  it('reports dirty when the previous marker was still running (crash/OOM/SIGKILL)', () => {
    const marker: BootMarkerFile = {
      schemaVersion: BOOT_MARKER_SCHEMA_VERSION,
      state: 'running',
      bootId: 'b2',
      startedAt: '2026-09-02T09:00:00.000Z',
      pid: 222,
      dirtyStreak: 0,
    };
    expect(classifyBoot({ marker, unreadable: false })).toEqual({
      status: 'dirty',
      reason: 'unclean_exit',
      previousStartedAt: '2026-09-02T09:00:00.000Z',
      previousShutdownAt: null,
      previousSignal: null,
      dirtyStreak: 1,
    });
  });

  it('increments dirtyStreak from the previous marker on a consecutive dirty boot (issue #3077)', () => {
    const marker: BootMarkerFile = {
      schemaVersion: BOOT_MARKER_SCHEMA_VERSION,
      state: 'running',
      bootId: 'b3',
      startedAt: '2026-09-02T09:00:00.000Z',
      pid: 333,
      dirtyStreak: 4,
    };
    expect(classifyBoot({ marker, unreadable: false }).dirtyStreak).toBe(5);
  });

  it('resets dirtyStreak to 0 on a clean boot even after a prior streak (issue #3077)', () => {
    const marker: BootMarkerFile = {
      schemaVersion: BOOT_MARKER_SCHEMA_VERSION,
      state: 'clean',
      bootId: 'b4',
      startedAt: '2026-09-02T10:00:00.000Z',
      pid: 444,
      shutdownAt: '2026-09-02T11:00:00.000Z',
      signal: 'SIGTERM',
      dirtyStreak: 7,
    };
    expect(classifyBoot({ marker, unreadable: false }).dirtyStreak).toBe(0);
  });
});

describe('parseBootMarker', () => {
  it('rejects an unknown schema version', () => {
    expect(parseBootMarker({ schemaVersion: 'other', state: 'running', bootId: 'x', startedAt: 's', pid: 1 })).toBeNull();
  });

  it('rejects a missing/invalid state', () => {
    expect(parseBootMarker({ schemaVersion: BOOT_MARKER_SCHEMA_VERSION, state: 'weird', bootId: 'x', startedAt: 's', pid: 1 })).toBeNull();
  });

  it('rejects a non-object', () => {
    expect(parseBootMarker('nope')).toBeNull();
    expect(parseBootMarker(null)).toBeNull();
  });

  it('accepts a well-formed running marker without shutdown fields', () => {
    const parsed = parseBootMarker({
      schemaVersion: BOOT_MARKER_SCHEMA_VERSION,
      state: 'running',
      bootId: 'x',
      startedAt: 's',
      pid: 7,
      dirtyStreak: 3,
    });
    expect(parsed).toEqual({
      schemaVersion: BOOT_MARKER_SCHEMA_VERSION,
      state: 'running',
      bootId: 'x',
      startedAt: 's',
      pid: 7,
      dirtyStreak: 3,
    });
  });

  it('self-heals dirtyStreak to 0 for a legacy marker missing the field (issue #3077)', () => {
    const parsed = parseBootMarker({
      schemaVersion: BOOT_MARKER_SCHEMA_VERSION,
      state: 'running',
      bootId: 'x',
      startedAt: 's',
      pid: 7,
    });
    expect(parsed?.dirtyStreak).toBe(0);
  });

  // Number.MAX_SAFE_INTEGER + 1 (2^53) survives Number.isInteger but not
  // isSafeInteger: incrementing it by 1 is a float-precision no-op, so if it
  // were accepted the streak would freeze there forever and never self-heal.
  // Number.POSITIVE_INFINITY is the same hazard from the other direction.
  it.each([-1, 2.5, Number.NaN, 'lots', null, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY])(
    'self-heals a corrupt dirtyStreak (%p) to 0 without rejecting the marker (issue #3077)',
    (bad) => {
      const parsed = parseBootMarker({
        schemaVersion: BOOT_MARKER_SCHEMA_VERSION,
        state: 'running',
        bootId: 'x',
        startedAt: 's',
        pid: 7,
        dirtyStreak: bad,
      });
      // The marker is still accepted (not null) — only the streak degrades.
      expect(parsed).not.toBeNull();
      expect(parsed?.dirtyStreak).toBe(0);
    },
  );
});

describe('BootMarkerStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'boot-marker-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeStore(pid = 4242): BootMarkerStore {
    let t = 1_000;
    return new BootMarkerStore({
      kookrDir: dir,
      pid,
      now: () => (t += 1_000),
      bootId: () => `boot-${pid}`,
    });
  }

  it('classifies a first boot as unknown and writes a running marker at 0o600', () => {
    const store = makeStore();
    const classification = store.recordBoot();
    expect(classification.status).toBe('unknown');
    expect(classification.reason).toBe('no_prior_marker');
    expect(classification.dirtyStreak).toBe(0);
    expect(readBootMarker(dir).marker?.dirtyStreak).toBe(0);

    const onDisk = readBootMarker(dir);
    expect(onDisk.marker?.state).toBe('running');
    expect(onDisk.marker?.pid).toBe(4242);
    // Owner-only permissions.
    const mode = statSync(bootMarkerPath(dir)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('classifies the next boot as clean after a recorded graceful shutdown', () => {
    // Previous process: boot then clean shutdown.
    const prev = makeStore(100);
    prev.recordBoot();
    prev.recordCleanShutdown('SIGTERM');

    // Next process reads the clean marker.
    const next = makeStore(200);
    const classification = next.recordBoot();
    expect(classification.status).toBe('clean');
    expect(classification.reason).toBe('clean_shutdown');
    expect(classification.previousSignal).toBe('SIGTERM');
    expect(classification.previousStartedAt).not.toBeNull();

    // And it re-stamps a fresh running marker for itself.
    expect(readBootMarker(dir).marker?.state).toBe('running');
    expect(readBootMarker(dir).marker?.pid).toBe(200);
  });

  it('classifies the next boot as dirty when the previous process never shut down cleanly', () => {
    const prev = makeStore(100);
    prev.recordBoot(); // no recordCleanShutdown — simulates crash/OOM/SIGKILL

    const next = makeStore(200);
    const classification = next.recordBoot();
    expect(classification.status).toBe('dirty');
    expect(classification.reason).toBe('unclean_exit');
    expect(classification.previousStartedAt).not.toBeNull();
    expect(classification.dirtyStreak).toBe(1);
  });

  it('grows dirtyStreak across a crash loop and resets it on a clean boot (issue #3077)', () => {
    // First boot: no prior marker → streak 0.
    expect(makeStore(1).recordBoot().dirtyStreak).toBe(0);
    // Each subsequent boot finds a still-`running` marker (crash — no clean
    // shutdown ran) and extends the streak.
    expect(makeStore(2).recordBoot().dirtyStreak).toBe(1);
    expect(makeStore(3).recordBoot().dirtyStreak).toBe(2);
    expect(makeStore(4).recordBoot().dirtyStreak).toBe(3);
    // The persisted marker carries the current streak forward.
    expect(readBootMarker(dir).marker?.dirtyStreak).toBe(3);

    // A graceful shutdown then a fresh boot breaks the loop back to 0.
    const graceful = makeStore(5);
    graceful.recordBoot(); // dirty streak 4 on disk
    graceful.recordCleanShutdown('SIGTERM');
    const afterClean = makeStore(6).recordBoot();
    expect(afterClean.status).toBe('clean');
    expect(afterClean.dirtyStreak).toBe(0);
    expect(readBootMarker(dir).marker?.dirtyStreak).toBe(0);

    // And the streak counts up again from the clean baseline.
    expect(makeStore(7).recordBoot().dirtyStreak).toBe(1);
  });

  it('self-heals a legacy on-disk marker (no dirtyStreak) to streak 1 on a dirty boot (issue #3077)', () => {
    // A `v1` marker written before the field existed: valid JSON, still
    // `running`, but no `dirtyStreak`. Exercises the full read path end-to-end
    // (readBootMarker → parseBootMarker self-heal → classifyBoot +1), not just
    // the pure functions — the streak degrades to 0 on read, so this dirty boot
    // reports 1.
    writeFileSync(
      bootMarkerPath(dir),
      `${JSON.stringify({
        schemaVersion: BOOT_MARKER_SCHEMA_VERSION,
        state: 'running',
        bootId: 'legacy',
        startedAt: '2026-09-01T00:00:00.000Z',
        pid: 999,
      })}\n`,
      'utf8',
    );
    const classification = makeStore(200).recordBoot();
    expect(classification.status).toBe('dirty');
    expect(classification.dirtyStreak).toBe(1);
    expect(readBootMarker(dir).marker?.dirtyStreak).toBe(1);
  });

  it('classifies a corrupt marker as unknown/marker_unreadable', () => {
    writeFileSync(bootMarkerPath(dir), '{ this is not json', 'utf8');
    const store = makeStore();
    const classification = store.recordBoot();
    expect(classification.status).toBe('unknown');
    expect(classification.reason).toBe('marker_unreadable');
    // Still overwrites with a valid running marker.
    expect(readBootMarker(dir).marker?.state).toBe('running');
  });

  it('recordCleanShutdown writes a clean marker even if recordBoot never ran', () => {
    const store = makeStore();
    store.recordCleanShutdown('SIGINT');
    const onDisk = readBootMarker(dir);
    expect(onDisk.marker?.state).toBe('clean');
    expect(onDisk.marker?.signal).toBe('SIGINT');
    expect(onDisk.marker?.shutdownAt).toBeTruthy();
  });

  it('never throws when the state dir is unwritable, and still classifies', () => {
    // Make the dir read-only so writes fail; recordBoot must still return a
    // real classification (fail-safe: swallow the write error, never drop the
    // verdict). A fresh dir has no prior marker, so the verdict is unknown.
    // Note: as uid 0 (some CI containers) 0o500 does not block writes, so the
    // write path is not exercised there — but the classification assertion
    // still holds, which is the guarantee we care about.
    chmodSync(dir, 0o500);
    try {
      const store = makeStore();
      let classification: ReturnType<typeof store.recordBoot> | undefined;
      expect(() => {
        classification = store.recordBoot();
      }).not.toThrow();
      expect(classification).toEqual({
        status: 'unknown',
        reason: 'no_prior_marker',
        previousStartedAt: null,
        previousShutdownAt: null,
        previousSignal: null,
        dirtyStreak: 0,
      });
      expect(() => store.recordCleanShutdown('SIGTERM')).not.toThrow();
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});

describe('readBootMarker', () => {
  it('distinguishes an absent file from a corrupt one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'boot-marker-read-'));
    try {
      expect(readBootMarker(dir)).toEqual({ marker: null, unreadable: false });
      writeFileSync(bootMarkerPath(dir), 'not json at all', 'utf8');
      expect(readBootMarker(dir)).toEqual({ marker: null, unreadable: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
