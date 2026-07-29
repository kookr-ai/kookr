import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EnvironmentBlockerRegistry,
  ENVIRONMENT_BLOCKER_REGISTRY_FILE,
  environmentBlockerKey,
  type EnvironmentBlocker,
} from './environment-blocker-registry.js';

describe('EnvironmentBlockerRegistry', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'environment-blocker-registry-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function readFile(): { schemaVersion: string; blockers: Record<string, EnvironmentBlocker> } {
    const raw = readFileSync(join(tempDir, ENVIRONMENT_BLOCKER_REGISTRY_FILE), 'utf-8');
    return JSON.parse(raw);
  }

  test('environmentBlockerKey composes type:scope', () => {
    expect(environmentBlockerKey('ci-billing', 'github-actions')).toBe('ci-billing:github-actions');
  });

  test('register creates a blocker and reports newlyRegistered', async () => {
    const registry = new EnvironmentBlockerRegistry(tempDir);
    const result = await registry.register({
      type: 'ci-billing',
      scope: 'github-actions',
      detectedBy: 'task-1',
      probe: 'gh run list',
      reason: 'every run dies in 3s',
    });
    expect(result.newlyRegistered).toBe(true);
    expect(result.blocker.key).toBe('ci-billing:github-actions');
    expect(result.blocker.type).toBe('ci-billing');
    expect(result.blocker.detectedBy).toBe('task-1');
    expect(result.blocker.probe).toBe('gh run list');
    expect(registry.size()).toBe(1);
  });

  test('register is idempotent (register-once) — second detector does not duplicate', async () => {
    const registry = new EnvironmentBlockerRegistry(tempDir);
    const first = await registry.register({ type: 'ci-billing', scope: 'github-actions', detectedBy: 'task-1' });
    const second = await registry.register({ type: 'ci-billing', scope: 'github-actions', detectedBy: 'task-2' });

    expect(first.newlyRegistered).toBe(true);
    expect(second.newlyRegistered).toBe(false);
    // Register-once: original detector and detectedAt preserved, not overwritten.
    expect(second.blocker.detectedBy).toBe('task-1');
    expect(second.blocker.detectedAt).toBe(first.blocker.detectedAt);
    expect(registry.size()).toBe(1);
  });

  test('consult returns blocked_external for an active blocker, not-blocked otherwise', async () => {
    const registry = new EnvironmentBlockerRegistry(tempDir);
    expect(registry.consult('ci-billing', 'github-actions')).toEqual({ blocked: false });

    await registry.register({ type: 'ci-billing', scope: 'github-actions' });

    const disposition = registry.consult('ci-billing', 'github-actions');
    expect(disposition.blocked).toBe(true);
    if (disposition.blocked) {
      expect(disposition.state).toBe('blocked_external');
      expect(disposition.blocker.key).toBe('ci-billing:github-actions');
    }
    // A different scope is not blocked.
    expect(registry.consult('ci-billing', 'circleci')).toEqual({ blocked: false });
  });

  test('emits exactly one notification per active blocker across many register calls', async () => {
    const notify = vi.fn();
    const registry = new EnvironmentBlockerRegistry(tempDir, { notify });

    await registry.register({ type: 'ci-billing', scope: 'github-actions', detectedBy: 'task-1' });
    await registry.register({ type: 'ci-billing', scope: 'github-actions', detectedBy: 'task-2' });
    await registry.register({ type: 'ci-billing', scope: 'github-actions', detectedBy: 'task-3' });

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0].key).toBe('ci-billing:github-actions');
    // notifiedAt recorded and persisted.
    expect(registry.get('ci-billing', 'github-actions')?.notifiedAt).toBeDefined();
    expect(readFile().blockers['ci-billing:github-actions'].notifiedAt).toBeDefined();
  });

  test('concurrent registrations of the same new blocker notify exactly once (async sink)', async () => {
    // The `notifiedAt` stamp is written only after the sink resolves, so an
    // async sink opens a window where a second concurrent register() could
    // deliver a duplicate. Hold the sink open with a gate and fire two
    // registrations for the same key; the in-flight guard must collapse them
    // to a single delivery — the exact many-detectors-at-once scenario.
    let openGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const notify = vi.fn().mockImplementation(() => gate);
    const registry = new EnvironmentBlockerRegistry(tempDir, { notify });

    const p1 = registry.register({ type: 'ci-billing', scope: 'github-actions', detectedBy: 'task-1' });
    const p2 = registry.register({ type: 'ci-billing', scope: 'github-actions', detectedBy: 'task-2' });
    openGate();
    await Promise.all([p1, p2]);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(registry.get('ci-billing', 'github-actions')?.notifiedAt).toBeDefined();
  });

  test('distinct blockers each get their own single notification', async () => {
    const notify = vi.fn();
    const registry = new EnvironmentBlockerRegistry(tempDir, { notify });

    await registry.register({ type: 'ci-billing', scope: 'github-actions' });
    await registry.register({ type: 'github-incident', scope: 'github-actions' });

    expect(notify).toHaveBeenCalledTimes(2);
    expect(registry.size()).toBe(2);
  });

  test('a failed notifier is retried on the next register until it delivers', async () => {
    const notify = vi
      .fn()
      .mockRejectedValueOnce(new Error('relay down'))
      .mockResolvedValueOnce(undefined);
    const registry = new EnvironmentBlockerRegistry(tempDir, { notify });

    const first = await registry.register({ type: 'ci-billing', scope: 'github-actions' });
    // First attempt threw — notifiedAt stays unset so a retry is possible.
    expect(first.blocker.notifiedAt).toBeUndefined();

    await registry.register({ type: 'ci-billing', scope: 'github-actions' });
    expect(notify).toHaveBeenCalledTimes(2);
    expect(registry.get('ci-billing', 'github-actions')?.notifiedAt).toBeDefined();

    // Once delivered, no further attempts.
    await registry.register({ type: 'ci-billing', scope: 'github-actions' });
    expect(notify).toHaveBeenCalledTimes(2);
  });

  test('recordProbeResult(success=true) clears the blocker and releases consulters', async () => {
    const registry = new EnvironmentBlockerRegistry(tempDir);
    await registry.register({ type: 'ci-billing', scope: 'github-actions' });
    expect(registry.consult('ci-billing', 'github-actions').blocked).toBe(true);

    const result = await registry.recordProbeResult('ci-billing', 'github-actions', true);
    expect(result.cleared).toBe(true);
    expect(result.blocker?.key).toBe('ci-billing:github-actions');
    // Auto-cleared: parked agents are released (consult now not-blocked).
    expect(registry.consult('ci-billing', 'github-actions')).toEqual({ blocked: false });
    expect(registry.size()).toBe(0);
  });

  test('recordProbeResult(success=false) keeps the blocker active', async () => {
    const registry = new EnvironmentBlockerRegistry(tempDir);
    await registry.register({ type: 'ci-billing', scope: 'github-actions' });

    const result = await registry.recordProbeResult('ci-billing', 'github-actions', false);
    expect(result.cleared).toBe(false);
    expect(registry.consult('ci-billing', 'github-actions').blocked).toBe(true);
  });

  test('recordProbeResult / clear on an unknown blocker is a no-op', async () => {
    const registry = new EnvironmentBlockerRegistry(tempDir);
    expect(await registry.recordProbeResult('ci-billing', 'github-actions', true)).toEqual({ cleared: false });
    expect(await registry.clear('ci-billing', 'github-actions')).toEqual({ cleared: false });
  });

  test('a cleared blocker can be re-registered and re-notified', async () => {
    const notify = vi.fn();
    const registry = new EnvironmentBlockerRegistry(tempDir, { notify });
    await registry.register({ type: 'ci-billing', scope: 'github-actions' });
    await registry.clear('ci-billing', 'github-actions');

    await registry.register({ type: 'ci-billing', scope: 'github-actions' });
    // A genuinely new blocker instance ⇒ a fresh single notification.
    expect(notify).toHaveBeenCalledTimes(2);
  });

  describe('durability across restart', () => {
    test('active blockers survive a reload (new instance, same dir)', async () => {
      const notify = vi.fn();
      const registry = new EnvironmentBlockerRegistry(tempDir, { notify });
      await registry.register({ type: 'ci-billing', scope: 'github-actions', detectedBy: 'task-1', probe: 'gh run list' });

      const reloaded = new EnvironmentBlockerRegistry(tempDir, { notify });
      await reloaded.load();

      expect(reloaded.size()).toBe(1);
      const blocker = reloaded.get('ci-billing', 'github-actions');
      expect(blocker?.detectedBy).toBe('task-1');
      expect(blocker?.probe).toBe('gh run list');
      expect(reloaded.consult('ci-billing', 'github-actions').blocked).toBe(true);
    });

    test('a restart never re-notifies an already-notified blocker', async () => {
      const notify = vi.fn();
      const registry = new EnvironmentBlockerRegistry(tempDir, { notify });
      await registry.register({ type: 'ci-billing', scope: 'github-actions' });
      expect(notify).toHaveBeenCalledTimes(1);

      const reloaded = new EnvironmentBlockerRegistry(tempDir, { notify });
      await reloaded.load();
      // The reloaded registry sees notifiedAt and does not re-escalate.
      await reloaded.register({ type: 'ci-billing', scope: 'github-actions' });
      expect(notify).toHaveBeenCalledTimes(1);
    });

    test('on-disk file carries the schema envelope', async () => {
      const registry = new EnvironmentBlockerRegistry(tempDir);
      await registry.register({ type: 'ci-billing', scope: 'github-actions' });
      const file = readFile();
      expect(file.schemaVersion).toBe('environment-blocker-registry.v1');
      expect(file.blockers['ci-billing:github-actions']).toBeDefined();
    });
  });

  describe('corruption / schema handling', () => {
    test('missing file ⇒ empty registry', async () => {
      const registry = new EnvironmentBlockerRegistry(tempDir);
      await registry.load();
      expect(registry.size()).toBe(0);
    });

    test('unknown schemaVersion ⇒ starts empty (warned)', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { writeFileSync } = await import('node:fs');
      writeFileSync(
        join(tempDir, ENVIRONMENT_BLOCKER_REGISTRY_FILE),
        JSON.stringify({ schemaVersion: 'environment-blocker-registry.v999', blockers: {} }),
      );
      const registry = new EnvironmentBlockerRegistry(tempDir);
      await registry.load();
      expect(registry.size()).toBe(0);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    test('invalid entries are skipped on load', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { writeFileSync } = await import('node:fs');
      writeFileSync(
        join(tempDir, ENVIRONMENT_BLOCKER_REGISTRY_FILE),
        JSON.stringify({
          schemaVersion: 'environment-blocker-registry.v1',
          blockers: {
            good: { key: 'ci-billing:github-actions', type: 'ci-billing', scope: 'github-actions', detectedAt: new Date().toISOString() },
            bad: { type: '', scope: 'x', detectedAt: 'not-a-date' },
          },
        }),
      );
      const registry = new EnvironmentBlockerRegistry(tempDir);
      await registry.load();
      expect(registry.size()).toBe(1);
      expect(registry.get('ci-billing', 'github-actions')).toBeDefined();
      warn.mockRestore();
    });
  });

  test('persist failure does not throw to the caller', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Point the registry at a non-existent nested dir so atomicWriteFile ENOENTs.
    const registry = new EnvironmentBlockerRegistry(join(tempDir, 'does', 'not', 'exist'));
    await expect(
      registry.register({ type: 'ci-billing', scope: 'github-actions' }),
    ).resolves.toMatchObject({ newlyRegistered: true });
    // In-memory state is still authoritative despite the failed disk write.
    expect(registry.consult('ci-billing', 'github-actions').blocked).toBe(true);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
