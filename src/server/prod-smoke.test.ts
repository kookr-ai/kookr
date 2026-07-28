import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ALERT_SCHEMA_VERSION,
  buildAlertArtifact,
  mergeAlertArtifact,
  readAlertArtifact,
  writeAlertArtifact,
  type AlertArtifact,
  type CheckResult,
} from './prod-smoke.js';

// The pure check functions (isValidAdapterVersion, parseAdapterVersionsFromLog,
// evaluateLogContinuity, isWithinLatencyBound, checkAdapterVersionSanity,
// buildAlertArtifact) and the deploy-gate integration flow are covered by
// scripts/prod-smoke.test.ts, which imports the same symbols via the re-export
// in scripts/prod-smoke.ts. This file covers the hourly-tick continuity
// helpers added in issue #1593.

const okChecks: CheckResult[] = [{ name: 'health', ok: true, detail: 'ok' }];
const failChecks: CheckResult[] = [
  { name: 'health', ok: false, detail: 'timed out' },
  { name: 'ready', ok: true, detail: 'ok' },
];

describe('mergeAlertArtifact (issue #1593)', () => {
  it('starts a fresh failing streak when there is no prior artifact', () => {
    const next = buildAlertArtifact(failChecks, '2026-07-27T01:00:00.000Z');
    const merged = mergeAlertArtifact(null, next);
    expect(merged.status).toBe('alert');
    expect(merged.consecutiveFailures).toBe(1);
    expect(merged.firstFailedAt).toBe('2026-07-27T01:00:00.000Z');
  });

  it('starts a fresh streak when the prior artifact was healthy', () => {
    const prev = buildAlertArtifact(okChecks, '2026-07-27T00:00:00.000Z');
    const next = buildAlertArtifact(failChecks, '2026-07-27T01:00:00.000Z');
    const merged = mergeAlertArtifact(prev, next);
    expect(merged.consecutiveFailures).toBe(1);
    expect(merged.firstFailedAt).toBe('2026-07-27T01:00:00.000Z');
  });

  it('carries firstFailedAt forward and increments on a consecutive failure', () => {
    const first = mergeAlertArtifact(null, buildAlertArtifact(failChecks, '2026-07-27T01:00:00.000Z'));
    const second = mergeAlertArtifact(first, buildAlertArtifact(failChecks, '2026-07-27T02:00:00.000Z'));
    const third = mergeAlertArtifact(second, buildAlertArtifact(failChecks, '2026-07-27T03:00:00.000Z'));
    expect(second.consecutiveFailures).toBe(2);
    expect(second.firstFailedAt).toBe('2026-07-27T01:00:00.000Z');
    expect(third.consecutiveFailures).toBe(3);
    expect(third.firstFailedAt).toBe('2026-07-27T01:00:00.000Z');
    // The generatedAt still tracks the latest run so operators see freshness.
    expect(third.generatedAt).toBe('2026-07-27T03:00:00.000Z');
  });

  it('clears the streak on recovery', () => {
    const failing = mergeAlertArtifact(null, buildAlertArtifact(failChecks, '2026-07-27T01:00:00.000Z'));
    const recovered = mergeAlertArtifact(failing, buildAlertArtifact(okChecks, '2026-07-27T02:00:00.000Z'));
    expect(recovered.status).toBe('ok');
    expect(recovered.consecutiveFailures).toBe(0);
    expect(recovered.firstFailedAt).toBeUndefined();
  });

  it('defaults a prior alert with no recorded count to a streak of 1', () => {
    // Legacy/deploy-gate artifact: status alert but no consecutiveFailures field.
    const legacy: AlertArtifact = buildAlertArtifact(failChecks, '2026-07-27T01:00:00.000Z');
    expect(legacy.consecutiveFailures).toBeUndefined();
    const merged = mergeAlertArtifact(legacy, buildAlertArtifact(failChecks, '2026-07-27T02:00:00.000Z'));
    expect(merged.consecutiveFailures).toBe(2);
    expect(merged.firstFailedAt).toBe('2026-07-27T01:00:00.000Z');
  });
});

describe('readAlertArtifact (issue #1593)', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a written artifact', () => {
    dir = mkdtempSync(join(tmpdir(), 'smoke-read-'));
    const path = join(dir, 'prod-smoke-tick-alert.json');
    const artifact = mergeAlertArtifact(null, buildAlertArtifact(failChecks, '2026-07-27T01:00:00.000Z'));
    writeAlertArtifact(path, artifact);
    const read = readAlertArtifact(path);
    expect(read).not.toBeNull();
    expect(read?.status).toBe('alert');
    expect(read?.consecutiveFailures).toBe(1);
    expect(read?.failingChecks).toEqual(['health']);
  });

  it('returns null for a missing file', () => {
    dir = mkdtempSync(join(tmpdir(), 'smoke-read-'));
    expect(readAlertArtifact(join(dir, 'does-not-exist.json'))).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    dir = mkdtempSync(join(tmpdir(), 'smoke-read-'));
    const path = join(dir, 'bad.json');
    writeFileSync(path, '{not json');
    expect(readAlertArtifact(path)).toBeNull();
  });

  it('returns null when the schema version does not match', () => {
    dir = mkdtempSync(join(tmpdir(), 'smoke-read-'));
    const path = join(dir, 'wrong-schema.json');
    writeFileSync(path, JSON.stringify({ schemaVersion: 'other.v9', status: 'alert', checks: [], failingChecks: [] }));
    expect(readAlertArtifact(path)).toBeNull();
  });

  it('returns null when checks/failingChecks are not arrays (tampered artifact)', () => {
    dir = mkdtempSync(join(tmpdir(), 'smoke-read-'));
    const path = join(dir, 'tampered.json');
    writeFileSync(
      path,
      JSON.stringify({ schemaVersion: ALERT_SCHEMA_VERSION, status: 'alert', checks: 'nope', failingChecks: 1 }),
    );
    expect(readAlertArtifact(path)).toBeNull();
  });

  it('accepts the current schema version constant', () => {
    dir = mkdtempSync(join(tmpdir(), 'smoke-read-'));
    const path = join(dir, 'ok.json');
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: ALERT_SCHEMA_VERSION,
        status: 'ok',
        generatedAt: '2026-07-27T00:00:00.000Z',
        checks: [],
        failingChecks: [],
      }),
    );
    expect(readAlertArtifact(path)?.status).toBe('ok');
  });
});
