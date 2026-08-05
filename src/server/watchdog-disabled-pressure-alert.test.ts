import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServerMessage } from '../shared/contracts/messages.js';
import { operationalAlertToSignal } from '../observability/signal-delivery/operational-alert-bridge.js';
import {
  writeOperatorSignal,
  readSignal,
  listSignalFiles,
} from '../observability/signal-delivery/operator-signal.js';
import {
  WatchdogDisabledPressureAlerter,
  buildWatchdogDisabledPressureAlert,
  buildWatchdogDisabledPressureRecoveryAlert,
  WATCHDOG_DISABLED_PRESSURE_ALERT_KEY,
  WATCHDOG_DISABLED_PRESSURE_METRIC,
  DEFAULT_WATCHDOG_DISABLED_PRESSURE_STALE_MS,
  DEFAULT_WATCHDOG_DISABLED_PRESSURE_COOLDOWN_MS,
} from './watchdog-disabled-pressure-alert.js';

describe('buildWatchdogDisabledPressureAlert / clear (issue #2078)', () => {
  it('builds a fired operational alert with key resource:watchdog_disabled_pressure', () => {
    const alert = buildWatchdogDisabledPressureAlert({
      reason: 'staleProcesses.dtach.count=32 ≥ soft bound 20 while resourceWatchdog is disabled',
      staleMs: 30 * 60_000,
      dtachCount: 32,
    });
    expect(alert.type).toBe('alert');
    expect(alert.severity).toBe('warning');
    expect(alert.operationalAlert).toEqual({
      key: WATCHDOG_DISABLED_PRESSURE_ALERT_KEY,
      metric: WATCHDOG_DISABLED_PRESSURE_METRIC,
      state: 'fired',
    });
    expect(alert.summary).toContain('resourceWatchdog disabled under pressure');
    expect(alert.details).toContain('staleProcesses.dtach.count=32');
    expect(alert.details).toContain('Page only');
    expect(alert.details).toContain('enable remains an operator decision');
    // Page-only: never claims to spawn or enable the actuator.
    expect(alert.details).not.toMatch(/spawned|auto-enabl/i);
  });

  it('builds a recovered clear', () => {
    const alert = buildWatchdogDisabledPressureRecoveryAlert();
    expect(alert.operationalAlert).toEqual({
      key: WATCHDOG_DISABLED_PRESSURE_ALERT_KEY,
      metric: WATCHDOG_DISABLED_PRESSURE_METRIC,
      state: 'recovered',
    });
    expect(alert.severity).toBe('info');
  });

  it('operational-alert bridge maps fire/clear to operator-signal keys', () => {
    const fire = operationalAlertToSignal(
      buildWatchdogDisabledPressureAlert({
        reason: 'pressure',
        staleMs: 30 * 60_000,
        dtachCount: 21,
      }),
    );
    expect(fire).toMatchObject({
      key: 'op:resource:watchdog_disabled_pressure:alert',
      kind: 'alert',
      source: WATCHDOG_DISABLED_PRESSURE_METRIC,
    });

    const clear = operationalAlertToSignal(buildWatchdogDisabledPressureRecoveryAlert());
    expect(clear).toMatchObject({
      key: 'op:resource:watchdog_disabled_pressure:clear',
      kind: 'clear',
      source: WATCHDOG_DISABLED_PRESSURE_METRIC,
    });
  });
});

describe('WatchdogDisabledPressureAlerter (issue #2078)', () => {
  let nowMs: number;
  let broadcast: ReturnType<typeof vi.fn>;
  let alerter: WatchdogDisabledPressureAlerter;

  const STALE = 10_000;
  const COOLDOWN = 60_000;
  const PRESSURE = {
    pressureWhileDisabled: true,
    reason: 'staleProcesses.dtach.count=32 ≥ soft bound 20',
    dtachCount: 32,
  } as const;

  beforeEach(() => {
    nowMs = 1_000_000;
    broadcast = vi.fn();
    alerter = new WatchdogDisabledPressureAlerter({
      broadcast,
      getStaleMs: () => STALE,
      getCooldownMs: () => COOLDOWN,
      now: () => nowMs,
    });
  });

  it('does not page while pressure is true but younger than the stale window', () => {
    alerter.evaluate(PRESSURE);
    nowMs += STALE - 1;
    alerter.evaluate(PRESSURE);
    expect(broadcast).not.toHaveBeenCalled();
    expect(alerter.stats().firing).toBe(false);
  });

  it('emits fire once pressure stays true for staleMs', () => {
    alerter.evaluate(PRESSURE);
    nowMs += STALE;
    alerter.evaluate(PRESSURE);
    expect(broadcast).toHaveBeenCalledTimes(1);
    const msg = broadcast.mock.calls[0]![0];
    expect(msg.operationalAlert).toEqual({
      key: WATCHDOG_DISABLED_PRESSURE_ALERT_KEY,
      metric: WATCHDOG_DISABLED_PRESSURE_METRIC,
      state: 'fired',
    });
    expect(alerter.stats().firing).toBe(true);
  });

  it('emits once per cooldown while pressure stays true (no tick spam)', () => {
    alerter.evaluate(PRESSURE);
    nowMs += STALE;
    alerter.evaluate(PRESSURE);
    expect(broadcast).toHaveBeenCalledTimes(1);

    // Still high, inside cooldown — no re-page
    nowMs += COOLDOWN - 1;
    alerter.evaluate(PRESSURE);
    expect(broadcast).toHaveBeenCalledTimes(1);

    // Cooldown elapsed — re-page
    nowMs += 1;
    alerter.evaluate(PRESSURE);
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(broadcast.mock.calls[1]![0].operationalAlert.state).toBe('fired');
  });

  it('clears when pressure clears (dtach drops / soft bound no longer hit)', () => {
    alerter.evaluate(PRESSURE);
    nowMs += STALE;
    alerter.evaluate(PRESSURE);
    expect(broadcast).toHaveBeenCalledTimes(1);

    alerter.evaluate({
      pressureWhileDisabled: false,
      reason: null,
      dtachCount: 5,
    });
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(broadcast.mock.calls[1]![0].operationalAlert).toEqual({
      key: WATCHDOG_DISABLED_PRESSURE_ALERT_KEY,
      metric: WATCHDOG_DISABLED_PRESSURE_METRIC,
      state: 'recovered',
    });
    expect(alerter.stats().firing).toBe(false);
    expect(alerter.stats().pressureSinceMs).toBeNull();
  });

  it('clears when watchdog is enabled (pressureWhileDisabled becomes false)', () => {
    alerter.evaluate(PRESSURE);
    nowMs += STALE;
    alerter.evaluate(PRESSURE);
    expect(broadcast).toHaveBeenCalledTimes(1);

    // Enabling the actuator makes evaluatePressureWhileDisabled return false.
    alerter.evaluate({
      pressureWhileDisabled: false,
      reason: null,
      dtachCount: 99,
    });
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(broadcast.mock.calls[1]![0].operationalAlert.state).toBe('recovered');
  });

  it('does not page when pressure is false', () => {
    alerter.evaluate({
      pressureWhileDisabled: false,
      reason: null,
      dtachCount: 100,
    });
    nowMs += STALE * 5;
    alerter.evaluate({
      pressureWhileDisabled: false,
      reason: null,
      dtachCount: 100,
    });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('requires a full stale window again after a clear before re-paging', () => {
    alerter.evaluate(PRESSURE);
    nowMs += STALE;
    alerter.evaluate(PRESSURE);
    expect(broadcast).toHaveBeenCalledTimes(1);

    alerter.evaluate({ pressureWhileDisabled: false, reason: null });
    expect(broadcast).toHaveBeenCalledTimes(2);

    // New episode — must wait full stale window (cooldown does not apply when !firing)
    alerter.evaluate(PRESSURE);
    nowMs += STALE - 1;
    alerter.evaluate(PRESSURE);
    expect(broadcast).toHaveBeenCalledTimes(2);

    nowMs += 1;
    alerter.evaluate(PRESSURE);
    expect(broadcast).toHaveBeenCalledTimes(3);
    expect(broadcast.mock.calls[2]![0].operationalAlert.state).toBe('fired');
  });

  it('never spawns tasks — broadcast is the only side effect', () => {
    const sideEffects: string[] = [];
    const local = new WatchdogDisabledPressureAlerter({
      broadcast: (msg) => {
        sideEffects.push(msg.type);
      },
      getStaleMs: () => STALE,
      getCooldownMs: () => COOLDOWN,
      now: () => nowMs,
    });
    local.evaluate(PRESSURE);
    nowMs += STALE;
    local.evaluate(PRESSURE);
    local.evaluate({ pressureWhileDisabled: false, reason: null });
    expect(sideEffects).toEqual(['alert', 'alert']);
  });

  it('ignores broadcast throws so the resource-watchdog tick cannot fail', () => {
    const local = new WatchdogDisabledPressureAlerter({
      broadcast: () => {
        throw new Error('ws down');
      },
      getStaleMs: () => STALE,
      getCooldownMs: () => COOLDOWN,
      now: () => nowMs,
    });
    local.evaluate(PRESSURE);
    nowMs += STALE;
    expect(() => local.evaluate(PRESSURE)).not.toThrow();
  });

  it('uses default bounds when getters are absent', () => {
    expect(DEFAULT_WATCHDOG_DISABLED_PRESSURE_STALE_MS).toBe(30 * 60_000);
    expect(DEFAULT_WATCHDOG_DISABLED_PRESSURE_COOLDOWN_MS).toBe(60 * 60_000);

    const local = new WatchdogDisabledPressureAlerter({
      broadcast,
      now: () => nowMs,
    });
    local.evaluate(PRESSURE);
    nowMs += DEFAULT_WATCHDOG_DISABLED_PRESSURE_STALE_MS;
    local.evaluate(PRESSURE);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('synthetic pressure state spools operator signal once per cooldown (acceptance)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'watchdog-disabled-pressure-signal-'));
    try {
      const pending: Promise<unknown>[] = [];
      const bridgeBroadcast = (
        msg: Parameters<typeof operationalAlertToSignal>[0] & { type: string },
      ) => {
        const input = operationalAlertToSignal(msg);
        if (input) pending.push(writeOperatorSignal(dir, input));
      };
      const local = new WatchdogDisabledPressureAlerter({
        broadcast: bridgeBroadcast as (msg: ServerMessage) => void,
        getStaleMs: () => STALE,
        getCooldownMs: () => COOLDOWN,
        now: () => nowMs,
      });

      local.evaluate(PRESSURE);
      nowMs += STALE;
      local.evaluate(PRESSURE);
      // Second tick inside cooldown
      nowMs += 1_000;
      local.evaluate(PRESSURE);
      await Promise.all(pending);
      expect(pending).toHaveLength(1);

      const files = await listSignalFiles(dir);
      expect(files).toEqual(['op-resource-watchdog_disabled_pressure-alert.json']);
      const signal = await readSignal(dir, 'op-resource-watchdog_disabled_pressure-alert.json');
      expect(signal?.key).toBe('op:resource:watchdog_disabled_pressure:alert');
      expect(signal?.kind).toBe('alert');

      // Clear
      pending.length = 0;
      local.evaluate({ pressureWhileDisabled: false, reason: null });
      await Promise.all(pending);
      const afterClear = await listSignalFiles(dir);
      expect(afterClear).toContain('op-resource-watchdog_disabled_pressure-clear.json');
      const clear = await readSignal(dir, 'op-resource-watchdog_disabled_pressure-clear.json');
      expect(clear?.key).toBe('op:resource:watchdog_disabled_pressure:clear');
      expect(clear?.kind).toBe('clear');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
