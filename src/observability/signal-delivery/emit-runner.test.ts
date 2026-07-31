import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { listSignalFiles, readSignal } from './operator-signal.js';
import { runLivenessEmit, runTransitionEmit } from './emit-runner.js';
import type { LivenessRegistryEntry } from './liveness.js';

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'kookr-emit-runner-'));
}

describe('runTransitionEmit — persists last-known status across calls', () => {
  test('first ok records, then ok→alert spools an alert, then alert→ok spools a clear', async () => {
    const dir = await tempDir();

    const r0 = await runTransitionEmit({ dir, source: 'deploy-lag', curr: 'ok' });
    expect(r0.emitted).toBe(false);
    expect(await listSignalFiles(dir)).toEqual([]);

    const r1 = await runTransitionEmit({ dir, source: 'deploy-lag', curr: 'alert', detail: '7 behind' });
    expect(r1.emitted).toBe(true);
    expect(await readSignal(dir, 'deploy-lag-alert.json')).not.toBeNull();

    const r2 = await runTransitionEmit({ dir, source: 'deploy-lag', curr: 'ok' });
    expect(r2.emitted).toBe(true);
    expect(await readSignal(dir, 'deploy-lag-clear.json')).not.toBeNull();
  });

  test('repeated alert readings emit only once', async () => {
    const dir = await tempDir();
    await runTransitionEmit({ dir, source: 's', curr: 'ok' });
    expect((await runTransitionEmit({ dir, source: 's', curr: 'alert' })).emitted).toBe(true);
    expect((await runTransitionEmit({ dir, source: 's', curr: 'alert' })).emitted).toBe(false);
  });
});

describe('runLivenessEmit — persists per-artifact state across calls', () => {
  const gate: LivenessRegistryEntry = { name: 'gate-heartbeat', maxAgeMs: 60 * 60 * 1000 };

  test('emits once when stale, not again before 6h, then again after 6h', async () => {
    const dir = await tempDir();
    let nowMs = 0;
    const now = () => new Date(nowMs);
    const stale = () => 90 * 60 * 1000;

    expect((await runLivenessEmit({ dir, registry: [gate], ageMsOf: stale, now })).emitted).toBe(1);

    nowMs += 3 * 60 * 60 * 1000; // +3h
    expect((await runLivenessEmit({ dir, registry: [gate], ageMsOf: stale, now })).emitted).toBe(0);

    nowMs += 4 * 60 * 60 * 1000; // now +7h total → past 6h
    expect((await runLivenessEmit({ dir, registry: [gate], ageMsOf: stale, now })).emitted).toBe(1);
  });
});
