import { describe, it, expect, vi, beforeEach } from 'vitest';
import { operationalAlertToSignal } from '../observability/signal-delivery/operational-alert-bridge.js';
import {
  ProviderPausedOccupancyAlerter,
  buildProviderPausedOccupancyAlert,
  buildProviderPausedOccupancyRecoveryAlert,
  PROVIDER_PAUSED_OCCUPANCY_ALERT_KEY,
  PROVIDER_PAUSED_OCCUPANCY_METRIC,
} from './provider-paused-occupancy-alert.js';

describe('buildProviderPausedOccupancyAlert / clear (issue #2079)', () => {
  it('builds a fired operational alert with key provider:paused-occupancy', () => {
    const alert = buildProviderPausedOccupancyAlert({
      occupancyCount: 4,
      countBound: 3,
      staleMs: 30 * 60_000,
      reclaimedCount: 0,
      oldestPauseAgeMs: 90 * 60_000,
    });
    expect(alert.type).toBe('alert');
    expect(alert.severity).toBe('warning');
    expect(alert.operationalAlert).toEqual({
      key: PROVIDER_PAUSED_OCCUPANCY_ALERT_KEY,
      metric: PROVIDER_PAUSED_OCCUPANCY_METRIC,
      state: 'fired',
    });
    expect(alert.summary).toContain('provider_paused occupancy high');
    expect(alert.details).toContain('occupancy=4');
    expect(alert.details).toContain('oldest pause age≈90m');
  });

  it('builds a recovered clear', () => {
    const alert = buildProviderPausedOccupancyRecoveryAlert();
    expect(alert.operationalAlert).toEqual({
      key: PROVIDER_PAUSED_OCCUPANCY_ALERT_KEY,
      metric: PROVIDER_PAUSED_OCCUPANCY_METRIC,
      state: 'recovered',
    });
    expect(alert.severity).toBe('info');
  });

  it('operational-alert bridge maps fire/clear to operator-signal keys', () => {
    const fire = operationalAlertToSignal(
      buildProviderPausedOccupancyAlert({
        occupancyCount: 4,
        countBound: 3,
        staleMs: 30 * 60_000,
        reclaimedCount: 1,
        oldestPauseAgeMs: null,
      }),
    );
    expect(fire).toMatchObject({
      key: 'op:provider:paused-occupancy:alert',
      kind: 'alert',
      source: PROVIDER_PAUSED_OCCUPANCY_METRIC,
    });

    const clear = operationalAlertToSignal(buildProviderPausedOccupancyRecoveryAlert());
    expect(clear).toMatchObject({
      key: 'op:provider:paused-occupancy:clear',
      kind: 'clear',
      source: PROVIDER_PAUSED_OCCUPANCY_METRIC,
    });
  });
});

describe('ProviderPausedOccupancyAlerter (issue #2079)', () => {
  let nowMs: number;
  let broadcast: ReturnType<typeof vi.fn>;
  let alerter: ProviderPausedOccupancyAlerter;

  const STALE = 10_000;
  const COOLDOWN = 60_000;
  const BOUND = 3;

  beforeEach(() => {
    nowMs = 1_000_000;
    broadcast = vi.fn();
    alerter = new ProviderPausedOccupancyAlerter({
      broadcast,
      getCountBound: () => BOUND,
      getStaleMs: () => STALE,
      getCooldownMs: () => COOLDOWN,
      now: () => nowMs,
    });
  });

  it('does not page while occupancy is high but younger than the stale window', () => {
    alerter.evaluate({ occupancyCount: 4 });
    nowMs += STALE - 1;
    alerter.evaluate({ occupancyCount: 4 });
    expect(broadcast).not.toHaveBeenCalled();
    expect(alerter.stats().firing).toBe(false);
  });

  it('emits fire once occupancy stays ≥ bound without decreasing for staleMs', () => {
    alerter.evaluate({ occupancyCount: 4 });
    nowMs += STALE;
    alerter.evaluate({ occupancyCount: 4, oldestPauseAgeMs: 40 * 60_000 });
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast.mock.calls[0][0].operationalAlert).toEqual({
      key: PROVIDER_PAUSED_OCCUPANCY_ALERT_KEY,
      metric: PROVIDER_PAUSED_OCCUPANCY_METRIC,
      state: 'fired',
    });
    expect(alerter.stats().firing).toBe(true);
  });

  it('emits once per cooldown while occupancy stays high', () => {
    alerter.evaluate({ occupancyCount: 4 });
    nowMs += STALE;
    alerter.evaluate({ occupancyCount: 4 });
    expect(broadcast).toHaveBeenCalledTimes(1);

    nowMs += COOLDOWN - 1;
    alerter.evaluate({ occupancyCount: 5 });
    expect(broadcast).toHaveBeenCalledTimes(1);

    nowMs += 1;
    alerter.evaluate({ occupancyCount: 5 });
    expect(broadcast).toHaveBeenCalledTimes(2);
  });

  it('resets the stale clock when occupancy decreases', () => {
    alerter.evaluate({ occupancyCount: 5 });
    nowMs += STALE - 1;
    alerter.evaluate({ occupancyCount: 4, reclaimedCount: 1 });
    nowMs += STALE - 1;
    alerter.evaluate({ occupancyCount: 4 });
    expect(broadcast).not.toHaveBeenCalled();

    nowMs += 1;
    alerter.evaluate({ occupancyCount: 4 });
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('clears when occupancy returns to 0', () => {
    alerter.evaluate({ occupancyCount: 4 });
    nowMs += STALE;
    alerter.evaluate({ occupancyCount: 4 });
    expect(broadcast).toHaveBeenCalledTimes(1);

    alerter.evaluate({ occupancyCount: 0 });
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(broadcast.mock.calls[1][0].operationalAlert.state).toBe('recovered');
    expect(alerter.stats().firing).toBe(false);
  });

  it('does not page when occupancy is below bound', () => {
    alerter.evaluate({ occupancyCount: 2 });
    nowMs += STALE * 5;
    alerter.evaluate({ occupancyCount: 2 });
    expect(broadcast).not.toHaveBeenCalled();
  });
});
