import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  emptyResourceWatchdogState,
  FileResourceWatchdogStateStore,
  isResourceWatchdogPersistedState,
  recordSpawn,
} from './resource-watchdog-state.js';

describe('FileResourceWatchdogStateStore', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rw-state-'));
    path = join(dir, 'resource-watchdog.state.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('load returns empty state when file is missing', () => {
    const store = new FileResourceWatchdogStateStore(path);
    expect(store.load()).toEqual(emptyResourceWatchdogState());
  });

  test('save then load round-trips; throttle survives simulated restart', () => {
    const store = new FileResourceWatchdogStateStore(path);
    const nowMs = Date.parse('2026-07-31T12:00:00.000Z');
    const written = recordSpawn({
      state: emptyResourceWatchdogState(),
      nowIso: new Date(nowMs).toISOString(),
      nowMs,
      kind: 'investigation',
      taskId: 'abc',
      triggerReasons: ['swap_percent'],
      retainMs: 24 * 60 * 60 * 1000,
    });
    store.save(written);

    // Simulated restart: new store instance, same path.
    const reloaded = new FileResourceWatchdogStateStore(path).load();
    expect(reloaded.lastSpawnAt).toBe(written.lastSpawnAt);
    expect(reloaded.spawnTimestamps).toEqual(written.spawnTimestamps);
    expect(reloaded.lastSpawnTaskId).toBe('abc');
    expect(existsSync(path)).toBe(true);
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    expect(isResourceWatchdogPersistedState(raw)).toBe(true);
  });

  test('corrupt JSON yields empty state (fail-open)', () => {
    writeFileSync(path, '{not json', 'utf-8');
    const store = new FileResourceWatchdogStateStore(path);
    expect(store.load()).toEqual(emptyResourceWatchdogState());
  });

  test('wrong schema version yields empty state', () => {
    writeFileSync(path, JSON.stringify({ schemaVersion: 99, spawnTimestamps: [] }), 'utf-8');
    const store = new FileResourceWatchdogStateStore(path);
    expect(store.load()).toEqual(emptyResourceWatchdogState());
  });
});
