import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServerMessage } from '../shared/contracts/messages.js';
import { operationalAlertToSignal } from '../observability/signal-delivery/operational-alert-bridge.js';
import { writeOperatorSignal, readSignal, listSignalFiles } from '../observability/signal-delivery/operator-signal.js';
import {
  FinishedAwaitingAckResidualAlerter,
  buildFaaResidualAlert,
  buildFaaResidualRecoveryAlert,
  FAA_RESIDUAL_ALERT_KEY,
  FAA_RESIDUAL_METRIC,
  DEFAULT_FAA_RESIDUAL_COUNT_BOUND,
  DEFAULT_FAA_RESIDUAL_STALE_MS,
  DEFAULT_FAA_RESIDUAL_COOLDOWN_MS,
} from './finished-awaiting-ack-residual-alert.js';

describe('buildFaaResidualAlert / clear (issue #2077)', () => {
  it('builds a fired operational alert with key faa:residual', () => {
    const alert = buildFaaResidualAlert({
      residualCount: 4,
      countBound: 3,
      staleMs: 30 * 60_000,
      reclaimedCount: 0,
      oldestAgeMs: 9_118_530,
    });
    expect(alert.type).toBe('alert');
    expect(alert.severity).toBe('warning');
    expect(alert.operationalAlert).toEqual({
      key: FAA_RESIDUAL_ALERT_KEY,
      metric: FAA_RESIDUAL_METRIC,
      state: 'fired',
    });
    expect(alert.summary).toContain('finishedAwaitingAck residual high');
    expect(alert.details).toContain('residual=4');
    expect(alert.details).toContain('oldestAgeMs=9118530');
  });

  it('builds a recovered clear', () => {
    const alert = buildFaaResidualRecoveryAlert();
    expect(alert.operationalAlert).toEqual({
      key: FAA_RESIDUAL_ALERT_KEY,
      metric: FAA_RESIDUAL_METRIC,
      state: 'recovered',
    });
    expect(alert.severity).toBe('info');
  });

  it('operational-alert bridge maps fire/clear to operator-signal keys', () => {
    const fire = operationalAlertToSignal(buildFaaResidualAlert({
      residualCount: 4,
      countBound: 3,
      staleMs: 30 * 60_000,
      reclaimedCount: 1,
    }));
    expect(fire).toMatchObject({
      key: 'op:faa:residual:alert',
      kind: 'alert',
      source: FAA_RESIDUAL_METRIC,
    });

    const clear = operationalAlertToSignal(buildFaaResidualRecoveryAlert());
    expect(clear).toMatchObject({
      key: 'op:faa:residual:clear',
      kind: 'clear',
      source: FAA_RESIDUAL_METRIC,
    });
  });
});

describe('FinishedAwaitingAckResidualAlerter (issue #2077)', () => {
  let nowMs: number;
  let broadcast: ReturnType<typeof vi.fn>;
  let alerter: FinishedAwaitingAckResidualAlerter;

  const STALE = 10_000;
  const COOLDOWN = 60_000;
  const BOUND = 3;

  beforeEach(() => {
    nowMs = 1_000_000;
    broadcast = vi.fn();
    alerter = new FinishedAwaitingAckResidualAlerter({
      broadcast,
      getCountBound: () => BOUND,
      getStaleMs: () => STALE,
      getCooldownMs: () => COOLDOWN,
      now: () => nowMs,
    });
  });

  it('does not page while residual is high but younger than the stale window', () => {
    alerter.evaluate({ residualCount: 4, reclaimedCount: 0 });
    nowMs += STALE - 1;
    alerter.evaluate({ residualCount: 4, reclaimedCount: 0 });
    expect(broadcast).not.toHaveBeenCalled();
    expect(alerter.stats().firing).toBe(false);
  });

  it('emits fire once residual stays ≥ bound without decreasing for staleMs', () => {
    alerter.evaluate({ residualCount: 4, reclaimedCount: 0, oldestAgeMs: 2_000_000 });
    nowMs += STALE;
    alerter.evaluate({ residualCount: 4, reclaimedCount: 0, oldestAgeMs: 2_000_000 });
    expect(broadcast).toHaveBeenCalledTimes(1);
    const msg = broadcast.mock.calls[0][0];
    expect(msg.operationalAlert).toEqual({
      key: FAA_RESIDUAL_ALERT_KEY,
      metric: FAA_RESIDUAL_METRIC,
      state: 'fired',
    });
    expect(msg.details).toContain('oldestAgeMs=2000000');
    expect(alerter.stats().firing).toBe(true);
  });

  it('emits once per cooldown while residual stays high (no tick spam)', () => {
    alerter.evaluate({ residualCount: 4 });
    nowMs += STALE;
    alerter.evaluate({ residualCount: 4 });
    expect(broadcast).toHaveBeenCalledTimes(1);

    // Still high, inside cooldown — no re-page
    nowMs += COOLDOWN - 1;
    alerter.evaluate({ residualCount: 5 });
    expect(broadcast).toHaveBeenCalledTimes(1);

    // Cooldown elapsed — re-page
    nowMs += 1;
    alerter.evaluate({ residualCount: 5 });
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(broadcast.mock.calls[1][0].operationalAlert.state).toBe('fired');
  });

  it('resets the stale clock when residual decreases (reclaim reduced residual)', () => {
    alerter.evaluate({ residualCount: 5 });
    nowMs += STALE - 1;
    // Reclaim dropped residual but still ≥ bound
    alerter.evaluate({ residualCount: 4, reclaimedCount: 1 });
    // One more almost-stale window from the decrease — must not fire yet
    nowMs += STALE - 1;
    alerter.evaluate({ residualCount: 4 });
    expect(broadcast).not.toHaveBeenCalled();

    nowMs += 1;
    alerter.evaluate({ residualCount: 4 });
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('clears when finishedAwaitingAck returns to 0', () => {
    alerter.evaluate({ residualCount: 4 });
    nowMs += STALE;
    alerter.evaluate({ residualCount: 4 });
    expect(broadcast).toHaveBeenCalledTimes(1);

    alerter.evaluate({ residualCount: 0 });
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(broadcast.mock.calls[1][0].operationalAlert).toEqual({
      key: FAA_RESIDUAL_ALERT_KEY,
      metric: FAA_RESIDUAL_METRIC,
      state: 'recovered',
    });
    expect(alerter.stats().firing).toBe(false);
    expect(alerter.stats().lastCount).toBe(0);
  });

  it('does not clear when residual drops below bound but not to 0', () => {
    alerter.evaluate({ residualCount: 4 });
    nowMs += STALE;
    alerter.evaluate({ residualCount: 4 });
    expect(broadcast).toHaveBeenCalledTimes(1);

    alerter.evaluate({ residualCount: 1 });
    expect(broadcast).toHaveBeenCalledTimes(1); // no clear
    expect(alerter.stats().firing).toBe(true);

    alerter.evaluate({ residualCount: 0 });
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(broadcast.mock.calls[1][0].operationalAlert.state).toBe('recovered');
  });

  it('does not page when residual is below bound', () => {
    alerter.evaluate({ residualCount: 2 });
    nowMs += STALE * 5;
    alerter.evaluate({ residualCount: 2 });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('never terminates tasks — broadcast is the only side effect', () => {
    const sideEffects: string[] = [];
    const local = new FinishedAwaitingAckResidualAlerter({
      broadcast: (msg) => {
        sideEffects.push(msg.type);
      },
      getCountBound: () => BOUND,
      getStaleMs: () => STALE,
      getCooldownMs: () => COOLDOWN,
      now: () => nowMs,
    });
    local.evaluate({ residualCount: 4 });
    nowMs += STALE;
    local.evaluate({ residualCount: 4 });
    local.evaluate({ residualCount: 0 });
    expect(sideEffects).toEqual(['alert', 'alert']);
  });

  it('ignores broadcast throws so the liveness tick cannot fail', () => {
    const local = new FinishedAwaitingAckResidualAlerter({
      broadcast: () => {
        throw new Error('ws down');
      },
      getCountBound: () => BOUND,
      getStaleMs: () => STALE,
      getCooldownMs: () => COOLDOWN,
      now: () => nowMs,
    });
    local.evaluate({ residualCount: 4 });
    nowMs += STALE;
    expect(() => local.evaluate({ residualCount: 4 })).not.toThrow();
  });

  it('uses default bounds when getters are absent', () => {
    expect(DEFAULT_FAA_RESIDUAL_COUNT_BOUND).toBe(3);
    expect(DEFAULT_FAA_RESIDUAL_STALE_MS).toBe(30 * 60_000);
    expect(DEFAULT_FAA_RESIDUAL_COOLDOWN_MS).toBe(60 * 60_000);

    const local = new FinishedAwaitingAckResidualAlerter({
      broadcast,
      now: () => nowMs,
    });
    local.evaluate({ residualCount: 3 });
    nowMs += DEFAULT_FAA_RESIDUAL_STALE_MS;
    local.evaluate({ residualCount: 3 });
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('synthetic residual high state spools operator signal once per cooldown (acceptance)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'faa-residual-signal-'));
    try {
      const pending: Promise<unknown>[] = [];
      const bridgeBroadcast = (msg: Parameters<typeof operationalAlertToSignal>[0] & { type: string }) => {
        const input = operationalAlertToSignal(msg);
        if (input) pending.push(writeOperatorSignal(dir, input));
      };
      const local = new FinishedAwaitingAckResidualAlerter({
        broadcast: bridgeBroadcast as (msg: ServerMessage) => void,
        getCountBound: () => BOUND,
        getStaleMs: () => STALE,
        getCooldownMs: () => COOLDOWN,
        now: () => nowMs,
      });

      local.evaluate({ residualCount: 4 });
      nowMs += STALE;
      local.evaluate({ residualCount: 4 });
      // Second tick inside cooldown
      nowMs += 1_000;
      local.evaluate({ residualCount: 4 });
      await Promise.all(pending);
      // writeOperatorSignal overwrites by key — also assert emission count
      expect(pending).toHaveLength(1);

      const files = await listSignalFiles(dir);
      expect(files).toEqual(['op-faa-residual-alert.json']);
      const signal = await readSignal(dir, 'op-faa-residual-alert.json');
      expect(signal?.key).toBe('op:faa:residual:alert');
      expect(signal?.kind).toBe('alert');

      // Clear
      pending.length = 0;
      local.evaluate({ residualCount: 0 });
      await Promise.all(pending);
      const afterClear = await listSignalFiles(dir);
      expect(afterClear).toContain('op-faa-residual-clear.json');
      const clear = await readSignal(dir, 'op-faa-residual-clear.json');
      expect(clear?.key).toBe('op:faa:residual:clear');
      expect(clear?.kind).toBe('clear');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
