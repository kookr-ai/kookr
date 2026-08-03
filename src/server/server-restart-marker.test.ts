import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  SERVER_RESTARTING_MARKER_FILE,
  SERVER_RESTARTING_MARKER_MAX_AGE_MS,
  isServerRestartingActive,
  readServerRestartingMarker,
} from './server-restart-marker.js';

describe('server-restart-marker (issue #1983)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kookr-restart-marker-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns null when the marker file is absent', () => {
    expect(readServerRestartingMarker(dir)).toBeNull();
    expect(isServerRestartingActive(dir)).toBe(false);
  });

  it('reads a fresh prod-restart marker', async () => {
    const at = new Date('2026-08-04T12:00:00.000Z').toISOString();
    await writeFile(
      join(dir, SERVER_RESTARTING_MARKER_FILE),
      JSON.stringify({
        schemaVersion: 'server-restarting.v1',
        reason: 'server_restarting',
        at,
        source: 'prod-restart',
      }),
    );

    const now = Date.parse(at) + 1_000;
    expect(readServerRestartingMarker(dir, now)).toEqual({
      schemaVersion: 'server-restarting.v1',
      reason: 'server_restarting',
      at,
      source: 'prod-restart',
    });
    expect(isServerRestartingActive(dir, now)).toBe(true);
  });

  it('ignores markers past the max-age window', async () => {
    const at = new Date('2026-08-04T12:00:00.000Z').toISOString();
    await writeFile(
      join(dir, SERVER_RESTARTING_MARKER_FILE),
      JSON.stringify({
        schemaVersion: 'server-restarting.v1',
        reason: 'server_restarting',
        at,
      }),
    );

    const now = Date.parse(at) + SERVER_RESTARTING_MARKER_MAX_AGE_MS + 1;
    expect(readServerRestartingMarker(dir, now)).toBeNull();
    expect(isServerRestartingActive(dir, now)).toBe(false);
  });

  it('ignores malformed JSON and wrong schema/reason', async () => {
    await writeFile(join(dir, SERVER_RESTARTING_MARKER_FILE), 'not-json{');
    expect(readServerRestartingMarker(dir)).toBeNull();

    await writeFile(
      join(dir, SERVER_RESTARTING_MARKER_FILE),
      JSON.stringify({
        schemaVersion: 'other.v1',
        reason: 'server_restarting',
        at: new Date().toISOString(),
      }),
    );
    expect(readServerRestartingMarker(dir)).toBeNull();

    await writeFile(
      join(dir, SERVER_RESTARTING_MARKER_FILE),
      JSON.stringify({
        schemaVersion: 'server-restarting.v1',
        reason: 'draining',
        at: new Date().toISOString(),
      }),
    );
    expect(readServerRestartingMarker(dir)).toBeNull();
  });

  it('does not require the parent directory beyond kookrDir itself', async () => {
    // Marker lives directly under kookrDir (same as last-restart-metrics.json).
    await mkdir(join(dir, 'nested'), { recursive: true });
    expect(isServerRestartingActive(join(dir, 'nested'))).toBe(false);
  });
});
