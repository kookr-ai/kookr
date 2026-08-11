import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServerMessage } from '../shared/contracts/messages.js';
import { operationalAlertToSignal } from '../observability/signal-delivery/operational-alert-bridge.js';
import { writeOperatorSignal, readSignal, listSignalFiles } from '../observability/signal-delivery/operator-signal.js';
import {
  HungSuspectResidualAlerter,
  buildHungResidualAlert,
  buildHungResidualRecoveryAlert,
  formatSkipContextForPage,
  isOpenPrFailsafeDominatedLastPass,
  isOpenPrFailsafeOutcome,
  summarizeHungResidualSkipBreakdown,
  HUNG_RESIDUAL_ALERT_KEY,
  HUNG_RESIDUAL_METRIC,
  HUNG_RESIDUAL_SAMPLE_TASK_ID_CAP,
  OPEN_PR_FAILSAFE_DOMINANT_LABEL,
  DEFAULT_HUNG_RESIDUAL_COUNT_BOUND,
  DEFAULT_HUNG_RESIDUAL_STALE_MS,
  DEFAULT_HUNG_RESIDUAL_COOLDOWN_MS,
} from './hung-suspect-residual-alert.js';

describe('buildHungResidualAlert / clear (issue #1993)', () => {
  it('builds a fired operational alert with key hung:residual', () => {
    const alert = buildHungResidualAlert({
      residualCount: 4,
      countBound: 3,
      staleMs: 30 * 60_000,
      reclaimedCount: 0,
    });
    expect(alert.type).toBe('alert');
    expect(alert.severity).toBe('warning');
    expect(alert.operationalAlert).toEqual({
      key: HUNG_RESIDUAL_ALERT_KEY,
      metric: HUNG_RESIDUAL_METRIC,
      state: 'fired',
    });
    expect(alert.summary).toContain('hungSuspect residual high');
    expect(alert.details).toContain('residual=4');
    expect(alert.details).toContain('no lastOutcomes');
  });

  it('names open_pr_failsafe dominance and sample task ids (issue #2232)', () => {
    const alert = buildHungResidualAlert({
      residualCount: 4,
      countBound: 3,
      staleMs: 30 * 60_000,
      reclaimedCount: 0,
      lastOutcomes: [
        { taskId: 'task-a', outcome: 'skipped_open_pr_confirmed' },
        { taskId: 'task-b', outcome: 'skipped_open_pr_unknown' },
        { taskId: 'task-c', outcome: 'skipped_open_pr_failsafe' },
        { taskId: 'task-d', outcome: 'skipped_under_ttl' },
      ],
    });
    expect(alert.summary).toContain('open_pr_failsafe-dominated');
    expect(alert.details).toContain('Dominant skip reason: open_pr_failsafe (3/4 last pass)');
    expect(alert.details).toContain('Sample task ids: task-a, task-b, task-c');
    expect(alert.details).toContain('refresh GitHub PR state');
    expect(alert.details).toContain('Page only');
  });

  it('builds a recovered clear', () => {
    const alert = buildHungResidualRecoveryAlert();
    expect(alert.operationalAlert).toEqual({
      key: HUNG_RESIDUAL_ALERT_KEY,
      metric: HUNG_RESIDUAL_METRIC,
      state: 'recovered',
    });
    expect(alert.severity).toBe('info');
  });

  it('operational-alert bridge maps fire/clear to operator-signal keys', () => {
    const fire = operationalAlertToSignal(buildHungResidualAlert({
      residualCount: 4,
      countBound: 3,
      staleMs: 30 * 60_000,
      reclaimedCount: 1,
    }));
    expect(fire).toMatchObject({
      key: 'op:hung:residual:alert',
      kind: 'alert',
      source: HUNG_RESIDUAL_METRIC,
    });

    const clear = operationalAlertToSignal(buildHungResidualRecoveryAlert());
    expect(clear).toMatchObject({
      key: 'op:hung:residual:clear',
      kind: 'clear',
      source: HUNG_RESIDUAL_METRIC,
    });
  });
});

describe('HungSuspectResidualAlerter (issue #1993)', () => {
  let nowMs: number;
  let broadcast: ReturnType<typeof vi.fn>;
  let alerter: HungSuspectResidualAlerter;

  const STALE = 10_000;
  const COOLDOWN = 60_000;
  const BOUND = 3;

  beforeEach(() => {
    nowMs = 1_000_000;
    broadcast = vi.fn();
    alerter = new HungSuspectResidualAlerter({
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
    alerter.evaluate({ residualCount: 4, reclaimedCount: 0 });
    nowMs += STALE;
    alerter.evaluate({ residualCount: 4, reclaimedCount: 0 });
    expect(broadcast).toHaveBeenCalledTimes(1);
    const msg = broadcast.mock.calls[0][0];
    expect(msg.operationalAlert).toEqual({
      key: HUNG_RESIDUAL_ALERT_KEY,
      metric: HUNG_RESIDUAL_METRIC,
      state: 'fired',
    });
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

  it('clears when hungSuspect returns to 0', () => {
    alerter.evaluate({ residualCount: 4 });
    nowMs += STALE;
    alerter.evaluate({ residualCount: 4 });
    expect(broadcast).toHaveBeenCalledTimes(1);

    alerter.evaluate({ residualCount: 0 });
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(broadcast.mock.calls[1][0].operationalAlert).toEqual({
      key: HUNG_RESIDUAL_ALERT_KEY,
      metric: HUNG_RESIDUAL_METRIC,
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
    const local = new HungSuspectResidualAlerter({
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
    const local = new HungSuspectResidualAlerter({
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
    expect(DEFAULT_HUNG_RESIDUAL_COUNT_BOUND).toBe(3);
    expect(DEFAULT_HUNG_RESIDUAL_STALE_MS).toBe(30 * 60_000);
    expect(DEFAULT_HUNG_RESIDUAL_COOLDOWN_MS).toBe(60 * 60_000);

    const local = new HungSuspectResidualAlerter({
      broadcast,
      now: () => nowMs,
    });
    local.evaluate({ residualCount: 3 });
    nowMs += DEFAULT_HUNG_RESIDUAL_STALE_MS;
    local.evaluate({ residualCount: 3 });
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('pages with skip breakdown from lastOutcomes without terminating tasks (issue #2232)', () => {
    const outcomes = [
      { taskId: 't1', outcome: 'skipped_open_pr_confirmed' },
      { taskId: 't2', outcome: 'skipped_open_pr_unknown' },
      { taskId: 't3', outcome: 'skipped_open_pr_confirmed' },
      { taskId: 't4', outcome: 'skipped_under_ttl' },
    ];
    alerter.evaluate({ residualCount: 4, reclaimedCount: 0, lastOutcomes: outcomes });
    nowMs += STALE;
    alerter.evaluate({ residualCount: 4, reclaimedCount: 0, lastOutcomes: outcomes });
    expect(broadcast).toHaveBeenCalledTimes(1);
    const msg = broadcast.mock.calls[0][0];
    expect(msg.summary).toContain('open_pr_failsafe-dominated');
    expect(msg.details).toContain('Dominant skip reason: open_pr_failsafe');
    expect(msg.details).toContain('t1');
    expect(msg.details).toContain('t2');
    expect(msg.details).toContain('Page only');
  });

  it('synthetic residual high state spools operator signal once per cooldown (acceptance)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hung-residual-signal-'));
    try {
      const pending: Promise<unknown>[] = [];
      const bridgeBroadcast = (msg: Parameters<typeof operationalAlertToSignal>[0] & { type: string }) => {
        const input = operationalAlertToSignal(msg);
        if (input) pending.push(writeOperatorSignal(dir, input));
      };
      const local = new HungSuspectResidualAlerter({
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
      expect(files).toEqual(['op-hung-residual-alert.json']);
      const signal = await readSignal(dir, 'op-hung-residual-alert.json');
      expect(signal?.key).toBe('op:hung:residual:alert');
      expect(signal?.kind).toBe('alert');

      // Clear
      pending.length = 0;
      local.evaluate({ residualCount: 0 });
      await Promise.all(pending);
      const afterClear = await listSignalFiles(dir);
      expect(afterClear).toContain('op-hung-residual-clear.json');
      const clear = await readSignal(dir, 'op-hung-residual-clear.json');
      expect(clear?.key).toBe('op:hung:residual:clear');
      expect(clear?.kind).toBe('clear');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('open_pr_failsafe dominance threshold (issue #2232)', () => {
  it('recognizes confirmed/unknown/legacy open-PR outcomes', () => {
    expect(isOpenPrFailsafeOutcome('skipped_open_pr_failsafe')).toBe(true);
    expect(isOpenPrFailsafeOutcome('skipped_open_pr_confirmed')).toBe(true);
    expect(isOpenPrFailsafeOutcome('skipped_open_pr_unknown')).toBe(true);
    expect(isOpenPrFailsafeOutcome('skipped_under_ttl')).toBe(false);
    expect(isOpenPrFailsafeOutcome('selected')).toBe(false);
  });

  it('empty last pass is not dominated', () => {
    expect(isOpenPrFailsafeDominatedLastPass([])).toBe(false);
    expect(summarizeHungResidualSkipBreakdown(undefined).openPrFailsafeDominated).toBe(false);
    expect(summarizeHungResidualSkipBreakdown([]).dominantReason).toBeNull();
  });

  it('requires open_pr plurality (strict under-TTL majority is not dominated)', () => {
    expect(isOpenPrFailsafeDominatedLastPass([
      { outcome: 'skipped_under_ttl' },
      { outcome: 'skipped_under_ttl' },
      { outcome: 'skipped_open_pr_failsafe' },
    ])).toBe(false);
  });

  it('open_pr plurality (strict majority) is dominated', () => {
    expect(isOpenPrFailsafeDominatedLastPass([
      { outcome: 'skipped_open_pr_confirmed' },
      { outcome: 'skipped_open_pr_unknown' },
      { outcome: 'skipped_under_ttl' },
    ])).toBe(true);
  });

  it('tie for plurality still counts as open_pr_failsafe-dominated', () => {
    // Threshold: openPr >= maxOther (ties count).
    expect(isOpenPrFailsafeDominatedLastPass([
      { outcome: 'skipped_open_pr_failsafe' },
      { outcome: 'skipped_under_ttl' },
    ])).toBe(true);
  });

  it('zero open_pr outcomes is never dominated even when residual high', () => {
    expect(isOpenPrFailsafeDominatedLastPass([
      { outcome: 'skipped_under_ttl' },
      { outcome: 'skipped_no_liveness' },
      { outcome: 'skipped_provider_paused' },
    ])).toBe(false);
  });

  it('summarize collapses open-PR family and samples dominant task ids', () => {
    const breakdown = summarizeHungResidualSkipBreakdown([
      { taskId: 'a', outcome: 'skipped_open_pr_confirmed' },
      { taskId: 'b', outcome: 'skipped_open_pr_unknown' },
      { taskId: 'c', outcome: 'skipped_open_pr_failsafe' },
      { taskId: 'd', outcome: 'skipped_under_ttl' },
      { taskId: 'e', outcome: 'skipped_open_pr_confirmed' },
      { taskId: 'f', outcome: 'skipped_open_pr_confirmed' },
    ]);
    expect(breakdown.openPrFailsafeDominated).toBe(true);
    expect(breakdown.dominantReason).toBe(OPEN_PR_FAILSAFE_DOMINANT_LABEL);
    expect(breakdown.dominantCount).toBe(5);
    expect(breakdown.total).toBe(6);
    expect(breakdown.openPrFailsafeCount).toBe(5);
    expect(breakdown.sampleTaskIds).toEqual(['a', 'b', 'c', 'e', 'f'].slice(0, HUNG_RESIDUAL_SAMPLE_TASK_ID_CAP));
    expect(breakdown.sampleTaskIds).toHaveLength(HUNG_RESIDUAL_SAMPLE_TASK_ID_CAP);
    expect(formatSkipContextForPage(breakdown)).toContain('Dominant skip reason: open_pr_failsafe (5/6 last pass)');
    expect(formatSkipContextForPage(breakdown)).toContain('Sample task ids:');
  });

  it('summarize reports non-open_pr dominant reason when that is the plurality', () => {
    const breakdown = summarizeHungResidualSkipBreakdown([
      { taskId: 'u1', outcome: 'skipped_under_ttl' },
      { taskId: 'u2', outcome: 'skipped_under_ttl' },
      { taskId: 'p1', outcome: 'skipped_open_pr_confirmed' },
    ]);
    expect(breakdown.openPrFailsafeDominated).toBe(false);
    expect(breakdown.dominantReason).toBe('skipped_under_ttl');
    expect(breakdown.dominantCount).toBe(2);
    expect(breakdown.sampleTaskIds).toEqual(['u1', 'u2']);
    expect(formatSkipContextForPage(breakdown)).toContain('skipped_under_ttl (2/3 last pass)');
  });
});
