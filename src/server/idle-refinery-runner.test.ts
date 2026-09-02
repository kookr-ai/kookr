import { describe, expect, it, vi } from 'vitest';
import { IdleRefineryRunner, type IdleRefineryRunnerDeps } from './idle-refinery-runner.js';
import type { CapacityLedger } from '../core/capacity-ledger.js';
import type { LaunchOpts, LaunchResult } from './launch-service.js';
import type { ResolvedRefineryLaunch } from './umbrella-decompose-launch.js';

function ledger(overrides: Partial<CapacityLedger> = {}): CapacityLedger {
  return {
    maxActiveTasks: 10,
    active: 4,
    free: 6,
    byClass: { working: 4, finishedAwaitingAck: 0, hungSuspect: 0, launching: 0 },
    pendingQueueDepth: 0,
    oldestPendingAgeMs: null,
    oldestFinishedAwaitingAckAgeMs: null,
    ...overrides,
  };
}

const RESOLVED: ResolvedRefineryLaunch = {
  prompt: 'decompose one umbrella',
  cwd: '/repo',
  criteria: 'leaf issues filed',
  name: 'Umbrella Decompose',
  playbookId: 'umbrella-decompose.md',
  playbookSource: {
    id: 'umbrella-decompose.md',
    scope: 'plugin',
    sourceCwd: '/plugin/playbooks',
    sourceDigest: 'sha256:original',
  },
  playbookParameterValues: { repo: 'owner/repo' },
};

function makeDeps(overrides: Partial<IdleRefineryRunnerDeps> = {}): {
  deps: IdleRefineryRunnerDeps;
  launcher: ReturnType<typeof vi.fn>;
  clock: { t: number };
} {
  const clock = { t: 1_000_000 };
  const launcher = vi.fn(async (opts: LaunchOpts): Promise<LaunchResult> => ({
    task: { id: `task-${opts.launchSource}` } as LaunchResult['task'],
    queued: false,
  }));
  const deps: IdleRefineryRunnerDeps = {
    getConfig: () => ({ enabled: true, minFreeSlots: 3, cooldownMs: 120 * 60_000 }),
    getCapacityLedger: () => ledger(),
    countActiveRefineryTasks: () => 0,
    resolveLaunch: async () => RESOLVED,
    launcher,
    now: () => clock.t,
    ...overrides,
  };
  return { deps, launcher, clock };
}

describe('IdleRefineryRunner', () => {
  it('spawns an umbrella-decompose task when idle with an empty queue', async () => {
    const { deps, launcher } = makeDeps();
    const runner = new IdleRefineryRunner(deps);
    const result = await runner.tick();

    expect(result).toEqual({ spawned: true, reason: 'spawn' });
    expect(launcher).toHaveBeenCalledTimes(1);
    const opts = launcher.mock.calls[0][0] as LaunchOpts;
    expect(opts.launchSource).toBe('idle-refinery');
    expect(opts.disableDedup).toBe(true);
    expect(opts.playbookId).toBe('umbrella-decompose.md');
    expect(opts.playbookSource).toEqual(RESOLVED.playbookSource);
    expect(opts.playbookParameterValues).toEqual({ repo: 'owner/repo' });
    expect(opts.prompt).toBe('decompose one umbrella');
    // Resolved criteria/name must reach the launcher (conditional pass-through).
    expect(opts.criteria).toBe('leaf issues filed');
    expect(opts.name).toBe('Umbrella Decompose');
  });

  it('spawns when the drain and SAFE-MODE gates are present and permissive', () => {
    // Covers the accepting branch of the safety gates, not just their absence.
    const { deps, launcher } = makeDeps({
      isAccepting: () => true,
      isAutomationEnabled: () => true,
    });
    return new IdleRefineryRunner(deps).tick().then((result) => {
      expect(result.spawned).toBe(true);
      expect(launcher).toHaveBeenCalledTimes(1);
    });
  });

  it('does not spawn when disabled', async () => {
    const { deps, launcher } = makeDeps({ getConfig: () => ({ enabled: false, minFreeSlots: 3, cooldownMs: 0 }) });
    const result = await new IdleRefineryRunner(deps).tick();
    expect(result.spawned).toBe(false);
    expect(launcher).not.toHaveBeenCalled();
  });

  it('is suppressed while the node is draining', async () => {
    const { deps, launcher } = makeDeps({ isAccepting: () => false });
    expect((await new IdleRefineryRunner(deps).tick()).spawned).toBe(false);
    expect(launcher).not.toHaveBeenCalled();
  });

  it('is suppressed while SAFE MODE is engaged', async () => {
    const { deps, launcher } = makeDeps({ isAutomationEnabled: () => false });
    expect((await new IdleRefineryRunner(deps).tick()).spawned).toBe(false);
    expect(launcher).not.toHaveBeenCalled();
  });

  it('is suppressed when the Kookr project is paused', async () => {
    const { deps, launcher } = makeDeps({
      getPausedProjectIds: () => new Set(['github.com/kookr-ai/kookr']),
      getAutomationProjectId: () => 'github.com/kookr-ai/kookr',
    });
    expect((await new IdleRefineryRunner(deps).tick()).spawned).toBe(false);
    expect(launcher).not.toHaveBeenCalled();
  });

  it('still spawns when Lucy is paused (refinery is Kookr-homed)', async () => {
    const { deps, launcher } = makeDeps({
      getPausedProjectIds: () => new Set(['github.com/jeanibarz/lucy']),
      getAutomationProjectId: () => 'github.com/kookr-ai/kookr',
    });
    expect((await new IdleRefineryRunner(deps).tick()).spawned).toBe(true);
    expect(launcher).toHaveBeenCalledTimes(1);
  });

  it('does not spawn while a refinery task is already in flight', async () => {
    const { deps, launcher } = makeDeps({ countActiveRefineryTasks: () => 1 });
    expect((await new IdleRefineryRunner(deps).tick()).reason).toBe('refinery_in_flight');
    expect(launcher).not.toHaveBeenCalled();
  });

  it('honors the cooldown between successive spawns', async () => {
    const { deps, launcher, clock } = makeDeps();
    const runner = new IdleRefineryRunner(deps);

    expect((await runner.tick()).spawned).toBe(true);
    expect(launcher).toHaveBeenCalledTimes(1);

    // 30 min later — still cooling down.
    clock.t += 30 * 60_000;
    expect((await runner.tick()).reason).toBe('cooldown');
    expect(launcher).toHaveBeenCalledTimes(1);

    // Past the 120-min cooldown — fires again.
    clock.t += 91 * 60_000;
    expect((await runner.tick()).spawned).toBe(true);
    expect(launcher).toHaveBeenCalledTimes(2);
  });

  it('stays inert (warns once) when the playbook cannot be resolved', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { deps, launcher } = makeDeps({ resolveLaunch: async () => null });
    const runner = new IdleRefineryRunner(deps);

    expect((await runner.tick()).spawned).toBe(false);
    expect((await runner.tick()).spawned).toBe(false);
    expect(launcher).not.toHaveBeenCalled();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('not resolvable')).length).toBe(1);
    warn.mockRestore();
  });

  it('swallows a launcher refusal and paces the retry to the cooldown', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const launcher = vi.fn(async () => {
      throw new Error('spawn budget exhausted');
    });
    const { deps, clock } = makeDeps({ launcher });
    const runner = new IdleRefineryRunner(deps);

    const first = await runner.tick();
    expect(first.spawned).toBe(false);
    // A refused launch engages the cooldown so a persistent refusal is not
    // retried (and re-logged) every tick.
    const second = await runner.tick();
    expect(second.reason).toBe('cooldown');
    expect(launcher).toHaveBeenCalledTimes(1);

    // Once the cooldown elapses it retries.
    clock.t += 121 * 60_000;
    await runner.tick();
    expect(launcher).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('notifies onSpawn with the created task id', async () => {
    const onSpawn = vi.fn();
    const { deps } = makeDeps({ onSpawn });
    await new IdleRefineryRunner(deps).tick();
    expect(onSpawn).toHaveBeenCalledWith('task-idle-refinery');
  });
});
