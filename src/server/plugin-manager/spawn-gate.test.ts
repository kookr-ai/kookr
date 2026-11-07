import { describe, test, expect } from 'vitest';
import { withSpawnGate, spawnGateActive } from './loadout-store.js';
import { PluginMutationService } from './mutation-service.js';

describe('spawnGateActive', () => {
  test('active only when loadouts OR auto-update apply is enabled', () => {
    expect(spawnGateActive({})).toBe(false);
    expect(spawnGateActive({ KOOKR_PLUGIN_LOADOUTS: '1' })).toBe(true);
    expect(spawnGateActive({ KOOKR_PLUGIN_AUTO_UPDATE: 'true' })).toBe(true);
  });
});

describe('withSpawnGate', () => {
  test('inactive gate (or no mutation) just runs the fn — no lock taken', async () => {
    const mutation = new PluginMutationService();
    const out = await withSpawnGate(mutation, false, async () => {
      expect(mutation.isLocked).toBe(false);
      return 'ran';
    });
    expect(out).toBe('ran');
    expect(await withSpawnGate(undefined, true, async () => 'ran2')).toBe('ran2');
  });

  test('active gate commits the fn UNDER the shared lock', async () => {
    const mutation = new PluginMutationService();
    let lockedDuringFn = false;
    await withSpawnGate(mutation, true, async () => {
      lockedDuringFn = mutation.isLocked;
    });
    expect(lockedDuringFn).toBe(true);
    expect(mutation.isLocked).toBe(false); // released after
  });

  test('a busy lock makes the gate WAIT, then run after release (race closed)', async () => {
    const mutation = new PluginMutationService();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const holder = mutation.withLock('plugin-auto-update', () => held); // holds the lock

    let ran = false;
    // The injected sleep releases the holder, so the retry succeeds.
    const result = await withSpawnGate(
      mutation,
      true,
      async () => {
        ran = true;
        return 'recorded';
      },
      { sleep: async () => release() },
    );
    expect(result).toBe('recorded');
    expect(ran).toBe(true);
    await holder;
  });

  test('past the deadline it proceeds WITHOUT the gate rather than failing the spawn', async () => {
    const mutation = new PluginMutationService();
    const holder = mutation.withLock('plugin-update', () => new Promise<void>(() => {})); // never releases
    void holder;
    let ran = false;
    const result = await withSpawnGate(
      mutation,
      true,
      async () => {
        ran = true;
        return 'degraded';
      },
      { timeoutMs: 0 },
    );
    expect(result).toBe('degraded');
    expect(ran).toBe(true);
  });
});
