import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  LastGoodHealthWriter,
  LAST_GOOD_HEALTH_FILE_MODE,
  LAST_GOOD_HEALTH_SCHEMA_VERSION,
  LAST_GOOD_HEALTH_SIZE_CAP_BYTES,
  lastGoodHealthPath,
  readLastGoodHealth,
  redactSecretFields,
  type LastGoodHealthSnapshot,
} from './last-good-health.js';

function baseHealth(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'ok',
    agents: 3,
    serverStartedAt: '2026-08-17T00:00:00.000Z',
    build: { version: 'abc123' },
    attentionQueue: { activeFindingDepth: 1, oldestFindingAgeMs: 42 },
    capacity: { active: 3, free: 9 },
    ...overrides,
  };
}

function readFile(dir: string): LastGoodHealthSnapshot {
  return JSON.parse(readFileSync(lastGoodHealthPath(dir), 'utf8')) as LastGoodHealthSnapshot;
}

describe('LastGoodHealthWriter', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'last-good-health-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('writes a schema-tagged, redacted snapshot after a successful assembly', () => {
    let t = 1_000;
    const writer = new LastGoodHealthWriter({ kookrDir: dir, now: () => t });
    writer.record(baseHealth());
    const snap = readFile(dir);
    expect(snap.schemaVersion).toBe(LAST_GOOD_HEALTH_SCHEMA_VERSION);
    expect(snap.truncated).toBe(false);
    expect(snap.capturedAt).toBe(new Date(1_000).toISOString());
    expect(snap.health.status).toBe('ok');
    expect(snap.health.agents).toBe(3);
  });

  test('redacts credential-looking fields before persisting', () => {
    const writer = new LastGoodHealthWriter({ kookrDir: dir, now: () => 1 });
    writer.record(baseHealth({
      relay: {
        Authorization: 'Bearer secret-token',
        apiKey: 'sk-live-1234567890abcdef',
        nested: { csrfSecret: 'zzz', keep: 'visible' },
      },
    }));
    const raw = readFileSync(lastGoodHealthPath(dir), 'utf8');
    expect(raw).not.toContain('secret-token');
    expect(raw).not.toContain('sk-live-1234567890abcdef');
    expect(raw).not.toContain('zzz');
    const snap = readFile(dir);
    const relay = snap.health.relay as Record<string, unknown>;
    expect(relay.Authorization).toBe('[REDACTED]');
    expect(relay.apiKey).toBe('[REDACTED]');
    expect((relay.nested as Record<string, unknown>).keep).toBe('visible');
  });

  test('scrubs secrets smuggled into a non-secret key value', () => {
    const writer = new LastGoodHealthWriter({ kookrDir: dir, now: () => 1 });
    // `lastError` is a legitimate health field whose value could carry a token.
    writer.record(baseHealth({
      terminalBackend: { lastError: 'connect failed: Authorization: Bearer tok-abc123xyz' },
    }));
    const raw = readFileSync(lastGoodHealthPath(dir), 'utf8');
    expect(raw).not.toContain('tok-abc123xyz');
    expect(raw).toContain('[REDACTED]');
  });

  test('caps file size, falling back to a gauge-only truncated snapshot', () => {
    const writer = new LastGoodHealthWriter({ kookrDir: dir, now: () => 1 });
    // A blob well over the 32 KiB cap forces the truncated path.
    writer.record(baseHealth({ blob: 'x'.repeat(50 * 1024) }));
    const bytes = statSync(lastGoodHealthPath(dir)).size;
    expect(bytes).toBeLessThanOrEqual(LAST_GOOD_HEALTH_SIZE_CAP_BYTES);
    const snap = readFile(dir);
    expect(snap.truncated).toBe(true);
    expect(snap.health.blob).toBeUndefined();
    // Gauges survive truncation.
    expect(snap.health.status).toBe('ok');
    expect(snap.health.agents).toBe(3);
    expect(snap.health.build).toEqual({ version: 'abc123' });
  });

  test('keeps timerHealth counts when the full body is truncated (issue #2636)', () => {
    const writer = new LastGoodHealthWriter({ kookrDir: dir, now: () => 1 });
    writer.record(baseHealth({
      blob: 'x'.repeat(50 * 1024),
      timerHealth: {
        registered: 8,
        overdue: 1,
        neverFired: 2,
        oldestNeverFiredName: 'maintenancePrune',
        oldestOverdueName: 'save',
      },
    }));
    const snap = readFile(dir);
    expect(snap.truncated).toBe(true);
    expect(snap.health.timerHealth).toEqual({
      registered: 8,
      overdue: 1,
      neverFired: 2,
      oldestNeverFiredName: 'maintenancePrune',
      oldestOverdueName: 'save',
    });
  });

  test('forces an out-of-band write when timerHealth neverFired flips', () => {
    let t = 0;
    const writer = new LastGoodHealthWriter({ kookrDir: dir, now: () => t });
    writer.record(baseHealth({
      timerHealth: {
        registered: 8,
        overdue: 0,
        neverFired: 1,
        oldestNeverFiredName: 'maintenancePrune',
        oldestOverdueName: null,
      },
    }));
    t = 1_000;
    writer.record(baseHealth({
      timerHealth: {
        registered: 8,
        overdue: 0,
        neverFired: 0,
        oldestNeverFiredName: null,
        oldestOverdueName: null,
      },
    }));
    expect(readFile(dir).capturedAt).toBe(new Date(1_000).toISOString());
    expect((readFile(dir).health.timerHealth as { neverFired: number }).neverFired).toBe(0);
  });

  test('forces an out-of-band write when timerHealth overdue flips', () => {
    let t = 0;
    const writer = new LastGoodHealthWriter({ kookrDir: dir, now: () => t });
    writer.record(baseHealth({
      timerHealth: {
        registered: 8,
        overdue: 0,
        neverFired: 1,
        oldestNeverFiredName: 'maintenancePrune',
        oldestOverdueName: null,
      },
    }));
    t = 1_000;
    writer.record(baseHealth({
      timerHealth: {
        registered: 8,
        overdue: 1,
        neverFired: 1,
        oldestNeverFiredName: 'maintenancePrune',
        oldestOverdueName: 'maintenancePrune',
      },
    }));
    const snap = readFile(dir);
    expect(snap.capturedAt).toBe(new Date(1_000).toISOString());
    expect((snap.health.timerHealth as { overdue: number }).overdue).toBe(1);
  });

  test('keeps helperLlm pause state when the full body is truncated (issue #2641)', () => {
    const writer = new LastGoodHealthWriter({ kookrDir: dir, now: () => 1 });
    writer.record(baseHealth({
      blob: 'x'.repeat(50 * 1024),
      helperLlm: {
        paused: [{ provider: 'groq', model: 'llama', category: 'auth', pausedUntil: '2026-08-18T02:22:00.000Z' }],
        stormsSuppressed: 1,
      },
    }));
    const snap = readFile(dir);
    expect(snap.truncated).toBe(true);
    expect(snap.health.helperLlm).toEqual({
      paused: [{ provider: 'groq', model: 'llama', category: 'auth', pausedUntil: '2026-08-18T02:22:00.000Z' }],
      stormsSuppressed: 1,
    });
  });

  test('forces an out-of-band write when helper-LLM pause state flips', () => {
    let t = 0;
    const writer = new LastGoodHealthWriter({ kookrDir: dir, now: () => t });
    writer.record(baseHealth({ helperLlm: { paused: [], stormsSuppressed: 0 } }));
    t = 1_000;
    writer.record(baseHealth({
      helperLlm: {
        paused: [{ provider: 'groq', model: 'llama', category: 'auth', pausedUntil: '2026-08-18T02:22:00.000Z' }],
        stormsSuppressed: 0,
      },
    }));
    const snap = readFile(dir);
    expect(snap.capturedAt).toBe(new Date(1_000).toISOString());
    expect((snap.health.helperLlm as { paused: Array<{ provider: string }> }).paused[0]?.provider).toBe('groq');
  });

  test('forces an out-of-band write when stormsSuppressed flips', () => {
    let t = 0;
    const writer = new LastGoodHealthWriter({ kookrDir: dir, now: () => t });
    writer.record(baseHealth({ helperLlm: { paused: [], stormsSuppressed: 0 } }));
    t = 1_000;
    writer.record(baseHealth({ helperLlm: { paused: [], stormsSuppressed: 7 } }));
    expect(readFile(dir).capturedAt).toBe(new Date(1_000).toISOString());
    expect((readFile(dir).health.helperLlm as { stormsSuppressed: number }).stormsSuppressed).toBe(7);
  });

  test('throttles writes within the interval when gauges are unchanged', () => {
    let t = 0;
    const writer = new LastGoodHealthWriter({ kookrDir: dir, now: () => t });
    writer.record(baseHealth());
    const first = readFile(dir).capturedAt;
    t = 2_000; // < 5s and same gauges → no write
    writer.record(baseHealth());
    expect(readFile(dir).capturedAt).toBe(first);
    t = 6_000; // past the interval → write
    writer.record(baseHealth());
    expect(readFile(dir).capturedAt).toBe(new Date(6_000).toISOString());
  });

  test('writes exactly at the throttle boundary (interval is not-strict)', () => {
    let t = 0;
    const writer = new LastGoodHealthWriter({ kookrDir: dir, now: () => t });
    writer.record(baseHealth());
    // Predicate is `now - lastWrite < interval`, so `5000 < 5000` is false → write.
    t = 5_000;
    writer.record(baseHealth());
    expect(readFile(dir).capturedAt).toBe(new Date(5_000).toISOString());
  });

  test('forces an out-of-band write on a gauge edge inside the throttle window', () => {
    let t = 0;
    const writer = new LastGoodHealthWriter({ kookrDir: dir, now: () => t });
    writer.record(baseHealth({ status: 'ok' }));
    t = 1_000; // < 5s but status flips → edge forces a write
    writer.record(baseHealth({ status: 'degraded' }));
    const snap = readFile(dir);
    expect(snap.health.status).toBe('degraded');
    expect(snap.capturedAt).toBe(new Date(1_000).toISOString());
  });

  test('never throws when the target path cannot be written', () => {
    // Point the writer at a path whose parent is a file, so mkdir/rename fail.
    const filePath = join(dir, 'a-file');
    writeFileSync(filePath, 'not a dir');
    const writer = new LastGoodHealthWriter({ kookrDir: join(filePath, 'nested') });
    expect(() => writer.record(baseHealth())).not.toThrow();
  });

  test('writes last-good-health.json owner-only (mode 0o600)', () => {
    const writer = new LastGoodHealthWriter({ kookrDir: dir, now: () => 1 });
    writer.record(baseHealth());
    expect(statSync(lastGoodHealthPath(dir)).mode & 0o777).toBe(LAST_GOOD_HEALTH_FILE_MODE);
  });

  test('tightens a pre-existing world-readable snapshot to 0o600', () => {
    const writer = new LastGoodHealthWriter({ kookrDir: dir, now: () => 1 });
    writer.record(baseHealth());
    chmodSync(lastGoodHealthPath(dir), 0o644);
    expect(statSync(lastGoodHealthPath(dir)).mode & 0o777).toBe(0o644);
    // Gauge edge forces a rewrite inside the throttle window.
    writer.record(baseHealth({ status: 'degraded' }));
    expect(statSync(lastGoodHealthPath(dir)).mode & 0o777).toBe(LAST_GOOD_HEALTH_FILE_MODE);
  });

  test('forces 0o600 even when umask would leave the file world-readable', () => {
    const previousUmask = process.umask(0o000);
    try {
      const writer = new LastGoodHealthWriter({ kookrDir: dir, now: () => 1 });
      writer.record(baseHealth());
      expect(statSync(lastGoodHealthPath(dir)).mode & 0o777).toBe(LAST_GOOD_HEALTH_FILE_MODE);
    } finally {
      process.umask(previousUmask);
    }
  });
});

describe('redactSecretFields', () => {
  test('walks arrays and nested objects', () => {
    const out = redactSecretFields({
      list: [{ token: 'a', ok: 1 }, { password: 'b' }],
      ok: 'keep',
    }) as Record<string, unknown>;
    expect((out.list as Array<Record<string, unknown>>)[0].token).toBe('[REDACTED]');
    expect((out.list as Array<Record<string, unknown>>)[0].ok).toBe(1);
    expect((out.list as Array<Record<string, unknown>>)[1].password).toBe('[REDACTED]');
    expect(out.ok).toBe('keep');
  });
});

describe('readLastGoodHealth', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'last-good-health-read-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('returns null when the file is absent', () => {
    expect(readLastGoodHealth(dir)).toBeNull();
  });

  test('returns null for malformed JSON or an unknown schema', () => {
    writeFileSync(lastGoodHealthPath(dir), '{not json');
    expect(readLastGoodHealth(dir)).toBeNull();
    writeFileSync(lastGoodHealthPath(dir), JSON.stringify({ schemaVersion: 'nope' }));
    expect(readLastGoodHealth(dir)).toBeNull();
  });

  test('returns the snapshot with a non-negative age relative to now', () => {
    const writer = new LastGoodHealthWriter({ kookrDir: dir, now: () => 1 });
    writer.record(baseHealth());
    // Pin mtime so age is deterministic.
    const mtimeSec = 1_000;
    utimesSync(lastGoodHealthPath(dir), mtimeSec, mtimeSec);
    const read = readLastGoodHealth(dir, { now: mtimeSec * 1000 + 5_000 });
    expect(read).not.toBeNull();
    expect(read!.snapshot.schemaVersion).toBe(LAST_GOOD_HEALTH_SCHEMA_VERSION);
    expect(read!.ageMs).toBe(5_000);
    expect(read!.snapshot.health.status).toBe('ok');
  });

  test('clamps age to zero for a file dated in the future', () => {
    const writer = new LastGoodHealthWriter({ kookrDir: dir, now: () => 1 });
    writer.record(baseHealth());
    const read = readLastGoodHealth(dir, { now: 0 });
    expect(read!.ageMs).toBe(0);
  });
});
