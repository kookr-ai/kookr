import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DeployConvergenceController,
  DEPLOY_STALE_RESIDUAL_ALERT_KEY,
  resolveDeployConvergenceSettings,
  type DeployStatusSnapshot,
} from './deploy-convergence-controller.js';

const T0 = Date.parse('2026-08-11T08:00:00.000Z');

function makeController(overrides: {
  status?: DeployStatusSnapshot;
  servingSha?: string | null;
  targetSha?: string | null;
  targetCommittedAtMs?: number | null;
  isAncestor?: boolean;
  act?: boolean;
  holdPath?: string | null;
  graceMinutes?: number;
  residualStaleMs?: number;
  intervalMs?: number;
  nowMs?: number;
  broadcast?: (msg: unknown) => void;
  triggerRedeploy?: ReturnType<typeof vi.fn>;
}) {
  const triggerRedeploy =
    overrides.triggerRedeploy ??
    vi.fn(async () => ({ ok: true as const, status: 200 }));
  const broadcasts: unknown[] = [];
  const broadcast =
    overrides.broadcast ??
    ((msg: unknown) => {
      broadcasts.push(msg);
    });

  const controller = new DeployConvergenceController({
    repoPath: '/tmp/kookr-fake',
    getRunningSha: () => overrides.servingSha ?? 'aaaaaaaa',
    getDeployStatus: async () =>
      overrides.status ?? { behindCount: 3, deploying: false },
    triggerRedeploy,
    broadcast,
    act: overrides.act,
    holdPath: overrides.holdPath === undefined ? null : overrides.holdPath,
    intervalMs: overrides.intervalMs ?? 1, // tests call runOnce directly
    overallTimeoutMs: 5_000,
    now: () => overrides.nowMs ?? T0,
    fetchBeforeCompare: false,
    convergenceThresholds: {
      divergenceGraceMinutes: overrides.graceMinutes ?? 15,
    },
    residualThresholds: {
      staleMs: overrides.residualStaleMs ?? 20 * 60_000,
      minBehindCount: 1,
      cooldownMs: 60 * 60_000,
    },
    resolveTargetSha: async () => ({
      sha: overrides.targetSha ?? 'bbbbbbbb',
      committedAtMs: overrides.targetCommittedAtMs ?? T0 - 30 * 60_000,
    }),
    isAncestor: async () => overrides.isAncestor ?? false,
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });

  return { controller, triggerRedeploy, broadcasts };
}

describe('DeployConvergenceController (issue #2226)', () => {
  it('triggers redeploy when DIVERGENT past grace and not deploying', async () => {
    const { controller, triggerRedeploy } = makeController({
      servingSha: 'aaaaaaaa',
      targetSha: 'bbbbbbbb',
      isAncestor: false,
      targetCommittedAtMs: T0 - 30 * 60_000, // 30m > 15m grace
      status: { behindCount: 5, deploying: false },
      graceMinutes: 15,
    });

    const result = await controller.runOnce(T0);
    expect(result.convergence?.action).toBe('redeploy');
    expect(result.redeployRequested).toBe(true);
    expect(triggerRedeploy).toHaveBeenCalledTimes(1);
  });

  it('does not trigger while still inside grace (diverging)', async () => {
    const { controller, triggerRedeploy } = makeController({
      servingSha: 'aaaaaaaa',
      targetSha: 'bbbbbbbb',
      isAncestor: false,
      targetCommittedAtMs: T0 - 5 * 60_000, // 5m < 15m grace
      status: { behindCount: 2, deploying: false },
      graceMinutes: 15,
    });

    const result = await controller.runOnce(T0);
    expect(result.convergence?.state).toBe('diverging');
    expect(result.redeployRequested).toBe(false);
    expect(triggerRedeploy).not.toHaveBeenCalled();
  });

  it('does not trigger when deploying=true', async () => {
    const { controller, triggerRedeploy } = makeController({
      servingSha: 'aaaaaaaa',
      targetSha: 'bbbbbbbb',
      isAncestor: false,
      targetCommittedAtMs: T0 - 60 * 60_000,
      status: { behindCount: 10, deploying: true },
    });

    const result = await controller.runOnce(T0);
    expect(result.redeployRequested).toBe(false);
    expect(triggerRedeploy).not.toHaveBeenCalled();
  });

  it('does not trigger when act=false (detect-only)', async () => {
    const { controller, triggerRedeploy } = makeController({
      act: false,
      servingSha: 'aaaaaaaa',
      targetSha: 'bbbbbbbb',
      isAncestor: false,
      targetCommittedAtMs: T0 - 60 * 60_000,
      status: { behindCount: 4, deploying: false },
    });

    const result = await controller.runOnce(T0);
    expect(result.convergence?.action).toBe('redeploy');
    expect(result.redeployRequested).toBe(false);
    expect(triggerRedeploy).not.toHaveBeenCalled();
  });

  it('hold file suppresses redeploy but residual still alerts', async () => {
    const holdDir = mkdtempSync(join(tmpdir(), 'kookr-deploy-hold-'));
    const holdPath = join(holdDir, 'hold');
    writeFileSync(holdPath, 'operator hold\n');
    const broadcasts: unknown[] = [];
    const { controller, triggerRedeploy } = makeController({
      holdPath,
      servingSha: 'aaaaaaaa',
      targetSha: 'bbbbbbbb',
      isAncestor: false,
      targetCommittedAtMs: T0 - 60 * 60_000,
      residualStaleMs: 1_000,
      status: { behindCount: 7, deploying: false },
      broadcast: (m) => broadcasts.push(m),
    });

    await controller.runOnce(T0);
    const r2 = await controller.runOnce(T0 + 5_000);
    expect(r2.held).toBe(true);
    expect(r2.redeployRequested).toBe(false);
    expect(triggerRedeploy).not.toHaveBeenCalled();
    expect(r2.residualAction).toBe('alert');
    expect(
      broadcasts.some(
        (b) =>
          (b as { operationalAlert?: { key: string; state: string } }).operationalAlert?.key ===
            DEPLOY_STALE_RESIDUAL_ALERT_KEY &&
          (b as { operationalAlert?: { state: string } }).operationalAlert?.state === 'fired',
      ),
    ).toBe(true);
  });

  it('does not double-trigger inside the grace cooldown window', async () => {
    const triggerRedeploy = vi.fn(async () => ({ ok: true as const, status: 200 }));
    const { controller } = makeController({
      servingSha: 'aaaaaaaa',
      targetSha: 'bbbbbbbb',
      isAncestor: false,
      targetCommittedAtMs: T0 - 60 * 60_000,
      graceMinutes: 15,
      intervalMs: 5 * 60_000,
      status: { behindCount: 5, deploying: false },
      triggerRedeploy,
    });

    const r1 = await controller.runOnce(T0);
    expect(r1.redeployRequested).toBe(true);
    expect(triggerRedeploy).toHaveBeenCalledTimes(1);

    // 5m later (deploy-routes safety may have cleared deploying=false already)
    // but still inside the 15m grace cooldown — must not re-fire.
    const r2 = await controller.runOnce(T0 + 5 * 60_000);
    expect(r2.redeployRequested).toBe(false);
    expect(triggerRedeploy).toHaveBeenCalledTimes(1);

    // After full grace window, another trigger is allowed.
    const r3 = await controller.runOnce(T0 + 15 * 60_000);
    expect(r3.redeployRequested).toBe(true);
    expect(triggerRedeploy).toHaveBeenCalledTimes(2);
  });

  it('skips trigger when converged', async () => {
    const { controller, triggerRedeploy } = makeController({
      servingSha: 'aaaaaaaa',
      targetSha: 'aaaaaaaa',
      isAncestor: true,
      status: { behindCount: 0, deploying: false },
    });

    const result = await controller.runOnce(T0);
    expect(result.convergence?.converged).toBe(true);
    expect(result.redeployRequested).toBe(false);
    expect(triggerRedeploy).not.toHaveBeenCalled();
  });

  it('alerts residual when behindCount>0 + deploying=false for T', async () => {
    // Residual uses process memory for behindIdleSinceMs. First tick starts clock.
    const broadcasts: unknown[] = [];
    const { controller, triggerRedeploy } = makeController({
      servingSha: 'aaaaaaaa',
      targetSha: 'bbbbbbbb',
      isAncestor: false,
      // Keep target recent so residual is what we test (not redeploy race)
      targetCommittedAtMs: T0 - 1_000,
      graceMinutes: 60, // long grace so action stays none
      residualStaleMs: 10 * 60_000,
      status: { behindCount: 19, deploying: false },
      broadcast: (m) => broadcasts.push(m),
    });

    // Tick 1: start residual clock at T0
    const r1 = await controller.runOnce(T0);
    expect(r1.residualAction).toBe('none');
    expect(broadcasts).toHaveLength(0);

    // Tick 2: 20m later → past 10m residual stale
    const r2 = await controller.runOnce(T0 + 20 * 60_000);
    expect(r2.residualAction).toBe('alert');
    expect(broadcasts).toHaveLength(1);
    const msg = broadcasts[0] as { operationalAlert?: { key: string; state: string }; severity?: string };
    expect(msg.operationalAlert?.key).toBe(DEPLOY_STALE_RESIDUAL_ALERT_KEY);
    expect(msg.operationalAlert?.state).toBe('fired');
    expect(msg.severity).toBe('critical');
    // Grace still open for redeploy (target 1s old + 20m tick = ~20m; grace 60m)
    expect(triggerRedeploy).not.toHaveBeenCalled();
  });

  it('recovers residual when behindCount returns to 0', async () => {
    const broadcasts: unknown[] = [];
    let status: DeployStatusSnapshot = { behindCount: 5, deploying: false };
    const controller = new DeployConvergenceController({
      repoPath: '/tmp/kookr-fake',
      getRunningSha: () => 'aaaaaaaa',
      getDeployStatus: async () => status,
      triggerRedeploy: async () => ({ ok: true, status: 200 }),
      broadcast: (m) => broadcasts.push(m),
      holdPath: null,
      intervalMs: 1,
      fetchBeforeCompare: false,
      residualThresholds: { staleMs: 1_000, minBehindCount: 1, cooldownMs: 60_000 },
      convergenceThresholds: { divergenceGraceMinutes: 999 },
      resolveTargetSha: async () => ({ sha: 'bbbbbbbb', committedAtMs: T0 }),
      isAncestor: async () => false,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    });

    await controller.runOnce(T0);
    await controller.runOnce(T0 + 5_000);
    expect(broadcasts.some((b) => (b as { operationalAlert?: { state: string } }).operationalAlert?.state === 'fired')).toBe(
      true,
    );

    status = { behindCount: 0, deploying: false };
    const r = await controller.runOnce(T0 + 10_000);
    expect(r.residualAction).toBe('recover');
    expect(
      broadcasts.some(
        (b) => (b as { operationalAlert?: { state: string } }).operationalAlert?.state === 'recovered',
      ),
    ).toBe(true);
  });
});

describe('resolveDeployConvergenceSettings', () => {
  it('enables by default only on port 4800', () => {
    expect(resolveDeployConvergenceSettings({}, 4800).enabled).toBe(true);
    expect(resolveDeployConvergenceSettings({}, 4801).enabled).toBe(false);
  });

  it('honors force on/off and act flag', () => {
    expect(resolveDeployConvergenceSettings({ KOOKR_DEPLOY_CONVERGENCE: '1' }, 4801).enabled).toBe(
      true,
    );
    expect(resolveDeployConvergenceSettings({ KOOKR_DEPLOY_CONVERGENCE: '0' }, 4800).enabled).toBe(
      false,
    );
    expect(resolveDeployConvergenceSettings({ KOOKR_DEPLOY_CONVERGENCE_ACT: 'false' }, 4800).act).toBe(
      false,
    );
  });

  it('disables on non-positive interval minutes', () => {
    expect(
      resolveDeployConvergenceSettings({ KOOKR_DEPLOY_CONVERGENCE_INTERVAL_MINUTES: '0' }, 4800)
        .enabled,
    ).toBe(false);
  });
});
