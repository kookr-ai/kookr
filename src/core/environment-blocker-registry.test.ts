import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EnvironmentBlockerRegistry,
  ENVIRONMENT_BLOCKER_REGISTRY_FILE,
  DEFAULT_STALE_ESCALATION_TTL_MS,
  environmentBlockerKey,
  type EnvironmentBlocker,
  type EnvironmentBlockerEscalation,
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
    expect(notify.mock.calls[0][0].blocker.key).toBe('ci-billing:github-actions');
    expect(notify.mock.calls[0][0].kind).toBe('initial');
    expect(notify.mock.calls[0][0].escalationCount).toBe(1);
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

  describe('re-escalation heartbeat for requires_human blockers (issue #1702)', () => {
    test('an ordinary blocker is single-shot — heartbeat never re-escalates it', async () => {
      let now = Date.parse('2026-07-30T00:00:00.000Z');
      const notify = vi.fn();
      const registry = new EnvironmentBlockerRegistry(tempDir, { notify, now: () => now });
      await registry.register({ type: 'ci-billing', scope: 'github-actions' });
      expect(notify).toHaveBeenCalledTimes(1);

      // Advance well past the TTL — an ordinary (non-human) blocker stays quiet.
      now += DEFAULT_STALE_ESCALATION_TTL_MS * 3;
      const fired = await registry.heartbeat();
      expect(fired).toHaveLength(0);
      expect(notify).toHaveBeenCalledTimes(1);
    });

    test('a requires_human blocker re-escalates once the staleness TTL elapses', async () => {
      let now = Date.parse('2026-07-30T00:00:00.000Z');
      const notify = vi.fn();
      const registry = new EnvironmentBlockerRegistry(tempDir, {
        notify,
        now: () => now,
        staleTtlMs: 24 * 60 * 60 * 1000,
      });
      await registry.register({ type: 'ci-billing', scope: 'github-actions', requiresHuman: true });
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify.mock.calls[0][0].kind).toBe('initial');

      // Not yet stale: 12h in, heartbeat is a no-op.
      now += 12 * 60 * 60 * 1000;
      expect(await registry.heartbeat()).toHaveLength(0);
      expect(notify).toHaveBeenCalledTimes(1);

      // Past the TTL: re-escalate exactly once with an incremented count.
      now += 13 * 60 * 60 * 1000;
      const fired = await registry.heartbeat();
      expect(fired).toHaveLength(1);
      expect(notify).toHaveBeenCalledTimes(2);
      const second = notify.mock.calls[1][0] as EnvironmentBlockerEscalation;
      expect(second.kind).toBe('re-escalation');
      expect(second.escalationCount).toBe(2);

      // Immediately after, not stale again — no double-fire.
      expect(await registry.heartbeat()).toHaveLength(0);
      expect(notify).toHaveBeenCalledTimes(2);
    });

    test('re-escalation state survives a restart (lastEscalatedAt persisted)', async () => {
      let now = Date.parse('2026-07-30T00:00:00.000Z');
      const notify = vi.fn();
      const registry = new EnvironmentBlockerRegistry(tempDir, {
        notify,
        now: () => now,
      });
      await registry.register({ type: 'ci-billing', scope: 'github-actions', requiresHuman: true });
      expect(notify).toHaveBeenCalledTimes(1);

      // Reload; the reloaded registry sees a recent lastEscalatedAt and stays quiet.
      const reloaded = new EnvironmentBlockerRegistry(tempDir, { notify, now: () => now });
      await reloaded.load();
      now += 1 * 60 * 60 * 1000;
      expect(await reloaded.heartbeat()).toHaveLength(0);
      expect(notify).toHaveBeenCalledTimes(1);

      // Once the TTL elapses across the restart boundary, it re-escalates.
      now += DEFAULT_STALE_ESCALATION_TTL_MS;
      expect(await reloaded.heartbeat()).toHaveLength(1);
      expect(notify).toHaveBeenCalledTimes(2);
    });

    test('the staleness boundary is inclusive: fires at exactly the TTL, not one ms before', async () => {
      let now = Date.parse('2026-07-30T00:00:00.000Z');
      const ttl = 24 * 60 * 60 * 1000;
      const notify = vi.fn();
      const registry = new EnvironmentBlockerRegistry(tempDir, {
        notify,
        now: () => now,
        staleTtlMs: ttl,
      });
      await registry.register({ type: 'ci-billing', scope: 'github-actions', requiresHuman: true });
      expect(notify).toHaveBeenCalledTimes(1);

      // One ms short of the TTL: not due.
      now += ttl - 1;
      expect(await registry.heartbeat()).toHaveLength(0);
      expect(notify).toHaveBeenCalledTimes(1);

      // Exactly the TTL (now - lastEscalatedAt === ttl): due (>= is inclusive).
      now += 1;
      expect(await registry.heartbeat()).toHaveLength(1);
      expect(notify).toHaveBeenCalledTimes(2);
    });

    test('a blocker cleared mid-sweep is not escalated (snapshot vs live map)', async () => {
      let now = Date.parse('2026-07-30T00:00:00.000Z');
      const notify = vi.fn();
      // Once armed, escalating the FIRST blocker clears the SECOND mid-sweep.
      // The heartbeat iterates a snapshot taken before the clear, so without the
      // live has() re-check it would deliver a spurious escalation for the
      // just-cleared blocker.
      let armed = false;
      const registry: EnvironmentBlockerRegistry = new EnvironmentBlockerRegistry(tempDir, {
        notify,
        now: () => now,
        costProvider: async () => {
          if (armed) {
            armed = false; // only clear once, during the first escalation of the sweep
            await registry.clear('search-quota', 'brave');
          }
          return { ciBlindMergeCount: 0, retroVerifyQueueDepth: 0 };
        },
      });
      await registry.register({ type: 'ci-billing', scope: 'github-actions', requiresHuman: true });
      await registry.register({ type: 'search-quota', scope: 'brave', requiresHuman: true });
      notify.mockClear();

      now += 2 * 24 * 60 * 60 * 1000;
      armed = true;
      const fired = await registry.heartbeat();

      // Only the first (still-active) blocker re-escalated.
      expect(fired).toHaveLength(1);
      expect(fired[0]!.blocker.key).toBe('ci-billing:github-actions');
      expect(notify).toHaveBeenCalledTimes(1);
      expect(registry.get('search-quota', 'brave')).toBeUndefined();
    });
  });

  describe('escalation cost payload (issue #1702)', () => {
    test('escalation carries CI-blind merge count, retro-verify depth, and blocked capabilities', async () => {
      const notify = vi.fn();
      // Distinct values so a field swap/conflation in buildCost cannot pass.
      const costProvider = vi
        .fn()
        .mockResolvedValue({ ciBlindMergeCount: 7, retroVerifyQueueDepth: 3 });
      const registry = new EnvironmentBlockerRegistry(tempDir, { notify, costProvider });

      await registry.register({
        type: 'ci-billing',
        scope: 'github-actions',
        requiresHuman: true,
        blockedCapability: 'ci',
      });
      await registry.register({
        type: 'search-quota',
        scope: 'brave',
        blockedCapability: 'web-search',
      });

      const escalation = notify.mock.calls[0][0] as EnvironmentBlockerEscalation;
      expect(escalation.cost.ciBlindMergeCount).toBe(7);
      expect(escalation.cost.retroVerifyQueueDepth).toBe(3);
      // Blocked-capability list spans every active blocker, sorted + deduped.
      const latest = notify.mock.calls.at(-1)![0] as EnvironmentBlockerEscalation;
      expect(latest.cost.blockedCapabilities).toEqual(['ci', 'web-search']);
    });

    test('a cost-provider failure does not block escalation — cost falls back to zero', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const notify = vi.fn();
      const costProvider = vi.fn().mockRejectedValue(new Error('spool unreadable'));
      const registry = new EnvironmentBlockerRegistry(tempDir, { notify, costProvider });

      await registry.register({ type: 'ci-billing', scope: 'github-actions', blockedCapability: 'ci' });
      expect(notify).toHaveBeenCalledTimes(1);
      const escalation = notify.mock.calls[0][0] as EnvironmentBlockerEscalation;
      expect(escalation.cost.ciBlindMergeCount).toBe(0);
      expect(escalation.cost.retroVerifyQueueDepth).toBe(0);
      expect(escalation.cost.blockedCapabilities).toEqual(['ci']);
      errorSpy.mockRestore();
    });

    test('a NaN/undefined cost figure is coerced to 0, not leaked into the payload', async () => {
      const notify = vi.fn();
      const costProvider = vi
        .fn()
        .mockResolvedValue({ ciBlindMergeCount: Number.NaN, retroVerifyQueueDepth: undefined });
      const registry = new EnvironmentBlockerRegistry(tempDir, { notify, costProvider });

      await registry.register({ type: 'ci-billing', scope: 'github-actions' });
      const escalation = notify.mock.calls[0][0] as EnvironmentBlockerEscalation;
      expect(escalation.cost.ciBlindMergeCount).toBe(0);
      expect(escalation.cost.retroVerifyQueueDepth).toBe(0);
    });
  });

  describe('tolerance-regime tracking (issue #1702)', () => {
    test('recordRegimeEntry appends deduped refs; hasRegime flips once one exists', async () => {
      const registry = new EnvironmentBlockerRegistry(tempDir);
      await registry.register({ type: 'ci-billing', scope: 'github-actions', requiresHuman: true });

      expect(registry.hasRegime('ci-billing', 'github-actions')).toBe(false);

      const first = await registry.recordRegimeEntry('ci-billing', 'github-actions', '#1688');
      expect(first.recorded).toBe(true);
      expect(registry.hasRegime('ci-billing', 'github-actions')).toBe(true);

      // Idempotent: the same ref is not appended twice.
      const dup = await registry.recordRegimeEntry('ci-billing', 'github-actions', '#1688');
      expect(dup.recorded).toBe(false);
      await registry.recordRegimeEntry('ci-billing', 'github-actions', '#1691');
      expect(registry.getRegime('ci-billing', 'github-actions')).toEqual(['#1688', '#1691']);

      // Persisted across a restart.
      const reloaded = new EnvironmentBlockerRegistry(tempDir);
      await reloaded.load();
      expect(reloaded.getRegime('ci-billing', 'github-actions')).toEqual(['#1688', '#1691']);
    });

    test('recordRegimeEntry on an unknown blocker is a no-op', async () => {
      const registry = new EnvironmentBlockerRegistry(tempDir);
      const result = await registry.recordRegimeEntry('ci-billing', 'github-actions', '#1');
      expect(result).toEqual({ recorded: false, regime: [] });
      expect(registry.hasRegime('ci-billing', 'github-actions')).toBe(false);
    });
  });
});
