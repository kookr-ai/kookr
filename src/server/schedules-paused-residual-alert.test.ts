import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServerMessage } from '../shared/contracts/messages.js';
import { operationalAlertToSignal } from '../observability/signal-delivery/operational-alert-bridge.js';
import { writeOperatorSignal, readSignal, listSignalFiles } from '../observability/signal-delivery/operator-signal.js';
import {
  SchedulesPausedResidualAlerter,
  buildSchedulesPausedResidualAlert,
  buildSchedulesPausedResidualRecoveryAlert,
  formatPausedScheduleLines,
  SCHEDULES_PAUSED_RESIDUAL_ALERT_KEY,
  SCHEDULES_PAUSED_RESIDUAL_METRIC,
  SCHEDULES_PAUSED_SAMPLE_CAP,
  DEFAULT_SCHEDULES_PAUSED_COUNT_BOUND,
  DEFAULT_SCHEDULES_PAUSED_COOLDOWN_MS,
  DEFAULT_SCHEDULES_PAUSED_ESCALATION_LADDER,
  CASCADE_BATCH_REENABLE_COMMAND,
  resolveEscalationTier,
  formatEpisodeAge,
  type PausedScheduleSample,
} from './schedules-paused-residual-alert.js';

function paused(
  overrides: Partial<PausedScheduleSample> & Pick<PausedScheduleSample, 'id'>,
): PausedScheduleSample {
  return {
    name: overrides.name ?? overrides.id,
    consecutiveFailures: overrides.consecutiveFailures ?? 3,
    ...overrides,
  };
}

function threePaused(): PausedScheduleSample[] {
  return [
    paused({ id: 'sched-a', name: 'orchestrator', consecutiveFailures: 5 }),
    paused({ id: 'sched-b', name: 'smoke tick', consecutiveFailures: 3 }),
    paused({ id: 'sched-c', name: 'daily recon', consecutiveFailures: 4 }),
  ];
}

describe('buildSchedulesPausedResidualAlert / clear (issue #2426)', () => {
  it('builds a fired operational alert with key schedules:paused:residual', () => {
    const alert = buildSchedulesPausedResidualAlert({
      paused: threePaused(),
      countBound: 3,
    });
    expect(alert.type).toBe('alert');
    expect(alert.severity).toBe('warning');
    expect(alert.operationalAlert).toEqual({
      key: SCHEDULES_PAUSED_RESIDUAL_ALERT_KEY,
      metric: SCHEDULES_PAUSED_RESIDUAL_METRIC,
      state: 'fired',
    });
    expect(alert.summary).toContain('schedules fail-closed paused');
    expect(alert.summary).toContain('3 schedule');
    expect(alert.details).toContain('orchestrator');
    expect(alert.details).toContain('consecutiveFailures=5');
    expect(alert.details).toContain('kookr schedule enable sched-a');
    expect(alert.details).toContain('kookr schedule enable sched-b');
    expect(alert.details).toContain('kookr schedule enable sched-c');
    expect(alert.details).toContain('Page only');
    expect(alert.details).not.toContain('auto-resum');
  });

  it('builds a recovered clear that does not claim any schedule was re-enabled', () => {
    const alert = buildSchedulesPausedResidualRecoveryAlert();
    expect(alert.operationalAlert).toEqual({
      key: SCHEDULES_PAUSED_RESIDUAL_ALERT_KEY,
      metric: SCHEDULES_PAUSED_RESIDUAL_METRIC,
      state: 'recovered',
    });
    expect(alert.severity).toBe('info');
    expect(alert.details).toContain('No schedule was auto-resumed');
  });

  it('operational-alert bridge maps fire/clear to operator-signal keys', () => {
    const fire = operationalAlertToSignal(buildSchedulesPausedResidualAlert({
      paused: threePaused(),
      countBound: 3,
    }));
    expect(fire).toMatchObject({
      key: 'op:schedules:paused:residual:alert',
      kind: 'alert',
      source: SCHEDULES_PAUSED_RESIDUAL_METRIC,
    });

    const clear = operationalAlertToSignal(buildSchedulesPausedResidualRecoveryAlert());
    expect(clear).toMatchObject({
      key: 'op:schedules:paused:residual:clear',
      kind: 'clear',
      source: SCHEDULES_PAUSED_RESIDUAL_METRIC,
    });
  });

  it('caps the Discord list and notes the remainder', () => {
    const many = Array.from({ length: SCHEDULES_PAUSED_SAMPLE_CAP + 3 }, (_, i) =>
      paused({ id: `s${i}`, name: `sched-${i}`, consecutiveFailures: 3 }),
    );
    const lines = formatPausedScheduleLines(many);
    expect(lines).toContain('kookr schedule enable s0');
    expect(lines).toContain(`kookr schedule enable s${SCHEDULES_PAUSED_SAMPLE_CAP - 1}`);
    expect(lines).not.toContain(`kookr schedule enable s${SCHEDULES_PAUSED_SAMPLE_CAP}`);
    expect(lines).toContain('(+3 more not listed)');
  });
});

describe('SchedulesPausedResidualAlerter (issue #2426)', () => {
  let nowMs: number;
  let broadcast: ReturnType<typeof vi.fn>;
  let alerter: SchedulesPausedResidualAlerter;

  const COOLDOWN = 60_000;
  const BOUND = 3;

  beforeEach(() => {
    nowMs = 1_000_000;
    broadcast = vi.fn();
    alerter = new SchedulesPausedResidualAlerter({
      broadcast,
      getCountBound: () => BOUND,
      getCooldownMs: () => COOLDOWN,
      now: () => nowMs,
    });
  });

  it('emits fire once paused count crosses the bound', () => {
    alerter.evaluate({ paused: threePaused() });
    expect(broadcast).toHaveBeenCalledTimes(1);
    const msg = broadcast.mock.calls[0][0];
    expect(msg.operationalAlert).toEqual({
      key: SCHEDULES_PAUSED_RESIDUAL_ALERT_KEY,
      metric: SCHEDULES_PAUSED_RESIDUAL_METRIC,
      state: 'fired',
    });
    expect(msg.details).toContain('kookr schedule enable sched-a');
    expect(alerter.stats().firing).toBe(true);
    expect(alerter.stats().lastCount).toBe(3);
  });

  it('emits once per cooldown while the count stays high (no tick spam)', () => {
    alerter.evaluate({ paused: threePaused() });
    expect(broadcast).toHaveBeenCalledTimes(1);

    nowMs += COOLDOWN - 1;
    alerter.evaluate({
      paused: [...threePaused(), paused({ id: 'sched-d', name: 'extra', consecutiveFailures: 6 })],
    });
    expect(broadcast).toHaveBeenCalledTimes(1);

    nowMs += 1;
    alerter.evaluate({
      paused: [...threePaused(), paused({ id: 'sched-d', name: 'extra', consecutiveFailures: 6 })],
    });
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(broadcast.mock.calls[1][0].operationalAlert.state).toBe('fired');
  });

  it('clears when paused count returns to 0', () => {
    alerter.evaluate({ paused: threePaused() });
    expect(broadcast).toHaveBeenCalledTimes(1);

    alerter.evaluate({ paused: [] });
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(broadcast.mock.calls[1][0].operationalAlert).toEqual({
      key: SCHEDULES_PAUSED_RESIDUAL_ALERT_KEY,
      metric: SCHEDULES_PAUSED_RESIDUAL_METRIC,
      state: 'recovered',
    });
    expect(alerter.stats().firing).toBe(false);
    expect(alerter.stats().lastCount).toBe(0);
  });

  it('does not clear when count drops below bound but not to 0', () => {
    alerter.evaluate({ paused: threePaused() });
    expect(broadcast).toHaveBeenCalledTimes(1);

    alerter.evaluate({ paused: [paused({ id: 'sched-a', name: 'orchestrator' })] });
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(alerter.stats().firing).toBe(true);

    alerter.evaluate({ paused: [] });
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(broadcast.mock.calls[1][0].operationalAlert.state).toBe('recovered');
  });

  it('does not page or recover on a cold-start empty list', () => {
    alerter.evaluate({ paused: [] });
    expect(broadcast).not.toHaveBeenCalled();
    expect(alerter.stats().firing).toBe(false);
    expect(alerter.stats().lastCount).toBe(0);
  });

  it('does not page when paused count is below bound', () => {
    alerter.evaluate({
      paused: [
        paused({ id: 'sched-a', name: 'orchestrator' }),
        paused({ id: 'sched-b', name: 'smoke tick' }),
      ],
    });
    nowMs += COOLDOWN * 5;
    alerter.evaluate({
      paused: [
        paused({ id: 'sched-a', name: 'orchestrator' }),
        paused({ id: 'sched-b', name: 'smoke tick' }),
      ],
    });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('pages again after a recovered episode when the bound is re-crossed', () => {
    alerter.evaluate({ paused: threePaused() });
    alerter.evaluate({ paused: [] });
    expect(broadcast).toHaveBeenCalledTimes(2);

    nowMs += 1;
    alerter.evaluate({ paused: threePaused() });
    expect(broadcast).toHaveBeenCalledTimes(3);
    expect(broadcast.mock.calls[2][0].operationalAlert.state).toBe('fired');
  });

  it('never re-enables a schedule — broadcast is the only side effect', () => {
    const sideEffects: string[] = [];
    const local = new SchedulesPausedResidualAlerter({
      broadcast: (msg) => {
        sideEffects.push(msg.type);
      },
      getCountBound: () => BOUND,
      getCooldownMs: () => COOLDOWN,
      now: () => nowMs,
    });
    local.evaluate({ paused: threePaused() });
    local.evaluate({ paused: [] });
    expect(sideEffects).toEqual(['alert', 'alert']);
  });

  it('ignores broadcast throws so the liveness tick cannot fail', () => {
    const local = new SchedulesPausedResidualAlerter({
      broadcast: () => {
        throw new Error('ws down');
      },
      getCountBound: () => BOUND,
      getCooldownMs: () => COOLDOWN,
      now: () => nowMs,
    });
    expect(() => local.evaluate({ paused: threePaused() })).not.toThrow();
  });

  it('uses default bounds when getters are absent or invalid', () => {
    expect(DEFAULT_SCHEDULES_PAUSED_COUNT_BOUND).toBe(3);
    expect(DEFAULT_SCHEDULES_PAUSED_COOLDOWN_MS).toBe(60 * 60_000);

    const local = new SchedulesPausedResidualAlerter({
      broadcast,
      getCountBound: () => 0,
      now: () => nowMs,
    });
    local.evaluate({ paused: threePaused() });
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('falls back to id when name is empty and floors non-finite consecutiveFailures', () => {
    alerter.evaluate({
      paused: [
        paused({ id: 'sched-a', name: '', consecutiveFailures: Number.NaN }),
        paused({ id: 'sched-b', name: 'smoke tick', consecutiveFailures: -2 }),
        paused({ id: 'sched-c', name: 'daily recon', consecutiveFailures: 4.9 }),
      ],
    });
    expect(broadcast).toHaveBeenCalledTimes(1);
    const details = broadcast.mock.calls[0][0].details as string;
    expect(details).toContain('sched-a (sched-a): consecutiveFailures=0');
    expect(details).toContain('smoke tick (sched-b): consecutiveFailures=0');
    expect(details).toContain('daily recon (sched-c): consecutiveFailures=4');
  });

  it('drops rows with empty ids and still pages on the remaining bound-crossing set', () => {
    alerter.evaluate({
      paused: [
        paused({ id: '', name: 'ghost' }),
        ...threePaused(),
      ],
    });
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast.mock.calls[0][0].details).not.toContain('ghost');
    expect(alerter.stats().lastCount).toBe(3);
  });

  it('synthetic residual high state spools operator signal once per cooldown (acceptance)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'schedules-paused-residual-signal-'));
    try {
      const pending: Promise<unknown>[] = [];
      const bridgeBroadcast = (msg: Parameters<typeof operationalAlertToSignal>[0] & { type: string }) => {
        const input = operationalAlertToSignal(msg);
        if (input) pending.push(writeOperatorSignal(dir, input));
      };
      const local = new SchedulesPausedResidualAlerter({
        broadcast: bridgeBroadcast as (msg: ServerMessage) => void,
        getCountBound: () => BOUND,
        getCooldownMs: () => COOLDOWN,
        now: () => nowMs,
      });

      local.evaluate({ paused: threePaused() });
      nowMs += 1_000;
      local.evaluate({ paused: threePaused() });
      await Promise.all(pending);
      expect(pending).toHaveLength(1);

      const files = await listSignalFiles(dir);
      expect(files).toEqual(['op-schedules-paused-residual-alert.json']);
      const signal = await readSignal(dir, 'op-schedules-paused-residual-alert.json');
      expect(signal?.key).toBe('op:schedules:paused:residual:alert');
      expect(signal?.kind).toBe('alert');
      expect(signal?.detail).toContain('kookr schedule enable sched-a');

      pending.length = 0;
      local.evaluate({ paused: [] });
      await Promise.all(pending);
      const afterClear = await listSignalFiles(dir);
      expect(afterClear).toContain('op-schedules-paused-residual-clear.json');
      const clear = await readSignal(dir, 'op-schedules-paused-residual-clear.json');
      expect(clear?.key).toBe('op:schedules:paused:residual:clear');
      expect(clear?.kind).toBe('clear');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('age-based escalation ladder (issue #2531)', () => {
  const HOUR = 60 * 60_000;

  it('resolveEscalationTier climbs the default ladder by episode age', () => {
    expect(resolveEscalationTier(0)).toBe(0);
    expect(resolveEscalationTier(HOUR)).toBe(0);
    expect(resolveEscalationTier(6 * HOUR)).toBe(1);
    expect(resolveEscalationTier(11 * HOUR)).toBe(1);
    expect(resolveEscalationTier(12 * HOUR)).toBe(2);
    expect(resolveEscalationTier(48 * HOUR)).toBe(2);
    // Negative / NaN floor to step 0.
    expect(resolveEscalationTier(-1)).toBe(0);
    expect(resolveEscalationTier(Number.NaN)).toBe(0);
  });

  it('formatEpisodeAge renders coarse h/m strings', () => {
    expect(formatEpisodeAge(0)).toBe('0m');
    expect(formatEpisodeAge(90_000)).toBe('1m');
    expect(formatEpisodeAge(6 * HOUR)).toBe('6h');
    expect(formatEpisodeAge(6 * HOUR + 30 * 60_000)).toBe('6h30m');
  });

  it('the tier-0 page embeds the one-command batch re-enable and stays warning severity', () => {
    const alert = buildSchedulesPausedResidualAlert({
      paused: [paused({ id: 'sched-a', name: 'orchestrator', consecutiveFailures: 5 })],
      countBound: 3,
    });
    expect(alert.severity).toBe('warning');
    expect(alert.details).toContain(CASCADE_BATCH_REENABLE_COMMAND);
    // Batch command must reference #2517-safety and still list per-id fallback.
    expect(alert.details).toContain('#2517');
    expect(alert.details).toContain('kookr schedule enable sched-a');
  });

  it('escalated pages raise severity to critical and surface the urgency + age', () => {
    const alert = buildSchedulesPausedResidualAlert({
      paused: [paused({ id: 'sched-a' })],
      countBound: 3,
      tier: 2,
      ageMs: 13 * HOUR,
    });
    expect(alert.severity).toBe('critical');
    expect(alert.summary).toContain('SEVERE');
    expect(alert.summary).toContain('13h');
    expect(alert.details).toContain(CASCADE_BATCH_REENABLE_COMMAND);
  });

  it('re-raises with rising urgency as one unrecovered episode ages (simulated clock)', () => {
    let nowMs = 5_000_000;
    const broadcast = vi.fn();
    // A 24h re-page cooldown much longer than the ladder boundaries, so the
    // ONLY thing that can page at +6h/+12h is the escalation edge — not the
    // same-tier cooldown. This isolates the `escalated` bypass branch: with the
    // bypass removed, none of these re-raises would fire.
    const alerter = new SchedulesPausedResidualAlerter({
      broadcast,
      getCountBound: () => 3,
      getCooldownMs: () => 24 * HOUR,
      now: () => nowMs,
    });

    // t0: first fire — tier 0, warning.
    alerter.evaluate({ paused: threePaused() });
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast.mock.calls[0][0].severity).toBe('warning');
    expect(alerter.stats().escalationTier).toBe(0);

    // +6h: episode aged into tier 1 — escalation edge pages immediately even
    // though the 24h re-page cooldown has NOT elapsed; severity bumps to critical.
    nowMs += 6 * HOUR;
    alerter.evaluate({ paused: threePaused() });
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(broadcast.mock.calls[1][0].severity).toBe('critical');
    expect(broadcast.mock.calls[1][0].summary).toContain('HIGH');
    expect(alerter.stats().escalationTier).toBe(1);

    // +5m within the same tier and far inside the cooldown: no spam.
    nowMs += 5 * 60_000;
    alerter.evaluate({ paused: threePaused() });
    expect(broadcast).toHaveBeenCalledTimes(2);

    // +12h total: tier 2 — escalation edge fires again (still inside cooldown)
    // to SEVERE.
    nowMs = 5_000_000 + 12 * HOUR;
    alerter.evaluate({ paused: threePaused() });
    expect(broadcast).toHaveBeenCalledTimes(3);
    expect(broadcast.mock.calls[2][0].summary).toContain('SEVERE');
    expect(alerter.stats().escalationTier).toBe(2);
  });

  it('honors an injected custom escalation ladder', () => {
    let nowMs = 7_000_000;
    const broadcast = vi.fn();
    // A single-step ladder that never escalates past warning, injected via the
    // getEscalationLadder seam.
    const alerter = new SchedulesPausedResidualAlerter({
      broadcast,
      getCountBound: () => 3,
      getCooldownMs: () => 72 * HOUR,
      getEscalationLadder: () => [{ afterMs: 0, severity: 'warning', urgency: 'FLAT' }],
      now: () => nowMs,
    });

    alerter.evaluate({ paused: threePaused() });
    // Even 30h in, the custom ladder has no higher step — no escalation edge,
    // and the 72h cooldown has not elapsed, so no re-page and severity stays warning.
    nowMs += 30 * HOUR;
    alerter.evaluate({ paused: threePaused() });
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast.mock.calls[0][0].severity).toBe('warning');
    expect(alerter.stats().escalationTier).toBe(0);
  });

  it('recovery is the ack: clearing resets the episode clock and tier', () => {
    let nowMs = 9_000_000;
    const broadcast = vi.fn();
    const alerter = new SchedulesPausedResidualAlerter({
      broadcast,
      getCountBound: () => 3,
      getCooldownMs: () => HOUR,
      now: () => nowMs,
    });

    alerter.evaluate({ paused: threePaused() });
    nowMs += 12 * HOUR;
    alerter.evaluate({ paused: threePaused() });
    expect(alerter.stats().escalationTier).toBe(2);

    // Operator runs the batch command → count drops to 0 → recovery.
    nowMs += 60_000;
    alerter.evaluate({ paused: [] });
    expect(alerter.stats().firing).toBe(false);
    expect(alerter.stats().escalationTier).toBe(0);
    expect(alerter.stats().episodeStartedAtMs).toBeNull();

    // A brand-new episode starts the ladder over at tier 0 / warning.
    nowMs += 1;
    alerter.evaluate({ paused: threePaused() });
    const last = broadcast.mock.calls.at(-1)?.[0];
    expect(last.severity).toBe('warning');
    expect(alerter.stats().escalationTier).toBe(0);
  });

  it('exposes a sane default ladder', () => {
    expect(DEFAULT_SCHEDULES_PAUSED_ESCALATION_LADDER[0]).toMatchObject({ afterMs: 0, severity: 'warning' });
    expect(DEFAULT_SCHEDULES_PAUSED_ESCALATION_LADDER.at(-1)?.severity).toBe('critical');
  });
});
