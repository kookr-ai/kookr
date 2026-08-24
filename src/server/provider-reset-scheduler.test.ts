import { describe, it, expect, beforeEach } from 'vitest';

import {
  ProviderResetScheduler,
  resolveProviderResetMs,
  buildProviderResumeLaunch,
  BINDING_WINDOW_UTILIZATION,
  DEFAULT_RESUME_RATE_PER_WINDOW,
  DEFAULT_RESUME_REFILL_WINDOW_MS,
  DEFAULT_RESUME_MAX_JITTER_MS,
  DEFAULT_UNKNOWN_RESET_COOLDOWN_MS,
  type ProviderResetEntry,
  type ProviderResetEvent,
} from './provider-reset-scheduler.js';
import type { ClaimKey } from '../core/issue-claim-types.js';
import { claimKeyString } from '../core/issue-claim-types.js';
import { RelaunchArbiter } from './relaunch-arbiter.js';
import type { RelaunchEvaluateResult, RelaunchLease } from './relaunch-arbiter.js';
import type { LaunchOpts } from '../shared/contracts/launch.js';

const REPO = 'github.com/kookr-ai/kookr';

function key(number: number): ClaimKey {
  return { repo: REPO, number };
}

function relaunchFor(number: number): LaunchOpts {
  return {
    prompt: `resume issue ${number}`,
    cwd: '/repo/kookr',
    claimIssue: { number, repo: REPO },
    launchSource: 'schedule',
    disableDedup: true,
  };
}

function entry(number: number, resetsAt: number, extra?: Partial<ProviderResetEntry>): ProviderResetEntry {
  return {
    key: key(number),
    resetsAt,
    relaunch: relaunchFor(number),
    ...extra,
  };
}

/** Arbiter stub — evaluate()/getLease() driven by a per-key verdict map (default admit). */
class StubArbiter {
  private verdicts = new Map<string, RelaunchEvaluateResult>();
  set(k: ClaimKey, verdict: RelaunchEvaluateResult): void {
    this.verdicts.set(claimKeyString(k), verdict);
  }
  /** Convenience: mark a key held by `holderId`. */
  setHeld(k: ClaimKey, holderId: string): void {
    this.set(k, {
      admit: false,
      reason: 'held',
      lease: { key: k, holderId, acquiredAt: '2026-08-02T00:00:00.000Z' },
    });
  }
  evaluate(k: ClaimKey): RelaunchEvaluateResult {
    return this.verdicts.get(claimKeyString(k)) ?? { admit: true };
  }
  getLease(k: ClaimKey): RelaunchLease | null {
    const v = this.verdicts.get(claimKeyString(k));
    return v && !v.admit && v.reason === 'held' ? v.lease : null;
  }
}

describe('ProviderResetScheduler', () => {
  let now: number;
  let rand: number;
  let arbiter: StubArbiter;
  let launched: LaunchOpts[];
  let events: ProviderResetEvent[];

  const makeScheduler = (opts?: Partial<ConstructorParameters<typeof ProviderResetScheduler>[0]>) =>
    new ProviderResetScheduler({
      arbiter,
      launch: async (o) => {
        launched.push(o);
      },
      now: () => now,
      random: () => rand,
      maxJitterMs: 0, // deterministic unless a test opts into jitter
      onEvent: (e) => events.push(e),
      ...opts,
    });

  beforeEach(() => {
    now = 1_000_000;
    rand = 0;
    arbiter = new StubArbiter();
    launched = [];
    events = [];
  });

  describe('record', () => {
    it('tracks a new entry and reports it as new with the latched reset', () => {
      const s = makeScheduler();
      const res = s.record(entry(1, now + 1000));
      expect(res.created).toBe(true);
      expect(res.resetsAt).toBe(now + 1000);
      expect(s.has(key(1))).toBe(true);
      expect(s.size()).toBe(1);
    });

    it('is idempotent per claim key — a repeat record refreshes, does not duplicate', () => {
      const s = makeScheduler();
      s.record(entry(1, now + 1000));
      // Re-record with the SAME reset (the reaper re-detecting the pause on the
      // next liveness tick): no new entry, resume time unchanged.
      const second = s.record(entry(1, now + 1000));
      expect(second.created).toBe(false);
      expect(s.size()).toBe(1);
      now += 2000;
      const summary = s.sweep();
      expect(summary.resumed).toBe(1);
    });

    it('applies jitter within [0, maxJitterMs) so co-resetting providers spread out', () => {
      rand = 0.5;
      const s = makeScheduler({ maxJitterMs: 10_000 });
      s.record(entry(1, now)); // resetsAt = now, jitter = floor(0.5 * 10000) = 5000
      // Not due yet at resetsAt (jitter delays it).
      expect(s.sweep(now).resumed).toBe(0);
      expect(s.sweep(now + 4999).resumed).toBe(0);
      expect(s.sweep(now + 5000).resumed).toBe(1);
    });
  });

  describe('resume at reset (AC1)', () => {
    it('does not resume before resetsAt', () => {
      const s = makeScheduler();
      s.record(entry(1, now + 10_000));
      expect(s.sweep().resumed).toBe(0);
      expect(launched).toHaveLength(0);
      expect(s.has(key(1))).toBe(true);
    });

    it('resumes exactly once at/after resetsAt without operator action', async () => {
      const s = makeScheduler();
      s.record(entry(1, now + 10_000));
      now += 10_000;
      const summary = s.sweep();
      expect(summary.resumed).toBe(1);
      await Promise.resolve();
      await Promise.resolve();
      expect(launched).toHaveLength(1);
      expect(launched[0]).toMatchObject({ claimIssue: { number: 1, repo: REPO }, disableDedup: true });
      // Entry is consumed — a second sweep does not double-launch.
      expect(s.sweep().resumed).toBe(0);
      expect(s.has(key(1))).toBe(false);
    });
  });

  describe('lease-keyed dedup / no duplicate on replay (AC3)', () => {
    it('drops a due entry when the lease is held by a DIFFERENT task (dedup)', () => {
      const s = makeScheduler();
      s.record(entry(1, now, { recordedTaskId: 'paused-task' }));
      arbiter.setHeld(key(1), 'other-task');
      const summary = s.sweep(now);
      expect(summary.deduped).toBe(1);
      expect(summary.resumed).toBe(0);
      expect(launched).toHaveLength(0);
      expect(s.has(key(1))).toBe(false); // covered by the live owner — dropped
      expect(events.some((e) => e.type === 'deduped')).toBe(true);
    });

    it('DEFERS (keeps) a due entry while the lease is still held by the paused recorder itself', () => {
      // The paused delivery task holds its own relaunch lease until the reaper
      // reaps it at reset. The sweep must NOT dedup against that self-held lease
      // — it must wait for the hand-off. This is the core fix for AC1.
      const s = makeScheduler();
      s.record(entry(1, now, { recordedTaskId: 'paused-task' }));
      arbiter.setHeld(key(1), 'paused-task'); // holder === recorder
      const summary = s.sweep(now);
      expect(summary.deferred).toBe(1);
      expect(summary.deduped).toBe(0);
      expect(summary.resumed).toBe(0);
      expect(s.has(key(1))).toBe(true); // kept — waiting for the reaper hand-off

      // Once the reaper reaps the paused task, the lease frees and the next
      // sweep resumes the issue under a fresh task.
      arbiter.set(key(1), { admit: true });
      expect(s.sweep(now).resumed).toBe(1);
      expect(launched[0].claimIssue).toEqual({ number: 1, repo: REPO });
    });

    it('with no recordedTaskId, a held lease is treated conservatively as dedup', () => {
      const s = makeScheduler();
      s.record(entry(1, now)); // no recordedTaskId
      arbiter.setHeld(key(1), 'someone');
      const summary = s.sweep(now);
      expect(summary.deduped).toBe(1);
      expect(s.has(key(1))).toBe(false);
    });

    it('defers (keeps) a due entry while the lease is in post-release backoff', () => {
      const s = makeScheduler();
      s.record(entry(1, now));
      arbiter.set(key(1), {
        admit: false,
        reason: 'backoff',
        retryAfterMs: 60_000,
        cooldownUntil: new Date(now + 60_000).toISOString(),
      });
      const summary = s.sweep(now);
      expect(summary.deferred).toBe(1);
      expect(summary.resumed).toBe(0);
      expect(s.has(key(1))).toBe(true); // retried once the window clears

      // Once the arbiter admits, the next sweep resumes it.
      arbiter.set(key(1), { admit: true });
      expect(s.sweep(now).resumed).toBe(1);
    });

    it('a replay after a multi-day pause does not duplicate work — the lease, not a 24h ledger, gates it', async () => {
      const s = makeScheduler();
      const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
      s.record(entry(1, now + threeDaysMs, { recordedTaskId: 'paused-task' }));
      // Simulate a competing actuator (crash-recovery / manual re-dispatch)
      // having already re-claimed the issue during the long pause — a DIFFERENT
      // holder than the paused recorder. The 24h launch ledger could not dedup a
      // 3-day-old launch; the lease does.
      arbiter.setHeld(key(1), 'crash-recovery-task');
      now += threeDaysMs + 1;
      const summary = s.sweep();
      expect(summary.resumed).toBe(0);
      expect(summary.deduped).toBe(1);
      expect(launched).toHaveLength(0);
    });
  });

  describe('end-to-end hand-off with the real RelaunchArbiter (AC1)', () => {
    it('defers while the paused task holds its own lease, then resumes after reap → backoff → admit', () => {
      // Model the true production chain (no StubArbiter): the paused delivery
      // task holds its own relaunch lease; the reaper reaps it at reset, which
      // frees the lease via orphan-reclaim and starts the 15-min backoff; the
      // resume lands once that backoff clears.
      const live = new Set<string>(['paused-task']);
      const backoffMs = 15 * 60_000;
      const realArbiter = new RelaunchArbiter({
        backoffMs,
        now: () => now,
        isHolderLive: (id) => live.has(id),
      });
      // The paused task acquired the lease at its original launch.
      expect(realArbiter.tryAcquire(key(1), 'paused-task').ok).toBe(true);

      const s = new ProviderResetScheduler({
        arbiter: realArbiter,
        launch: async (o) => {
          launched.push(o);
        },
        now: () => now,
        random: () => 0,
        maxJitterMs: 0,
        ratePerWindow: 5,
        refillWindowMs: 60_000,
      });
      s.record(entry(1, now, { recordedTaskId: 'paused-task' }));

      // 1) Paused task still alive & holding → deferred (self-held), NOT deduped.
      expect(s.sweep(now)).toMatchObject({ resumed: 0, deferred: 1, deduped: 0 });
      expect(s.has(key(1))).toBe(true);

      // 2) Reaper reaps the paused task: it goes terminal (no longer live). The
      //    next sweep's evaluate() orphan-reclaims the dead holder's lease and
      //    starts the backoff → deferred (backoff), still kept.
      live.delete('paused-task');
      expect(s.sweep(now)).toMatchObject({ resumed: 0, deferred: 1 });
      expect(s.has(key(1))).toBe(true);
      expect(launched).toHaveLength(0);

      // 3) Once the post-reclaim backoff clears, the lease is free → resume.
      now += backoffMs + 1;
      expect(s.sweep(now)).toMatchObject({ resumed: 1 });
      expect(launched).toHaveLength(1);
      expect(launched[0].claimIssue).toEqual({ number: 1, repo: REPO });
    });
  });

  describe('jitter + token-bucket bounding (AC2)', () => {
    it('resumes at most ratePerWindow entries in a single sweep', async () => {
      const s = makeScheduler({ ratePerWindow: 2, refillWindowMs: 60_000 });
      for (let i = 1; i <= 5; i++) s.record(entry(i, now));
      const summary = s.sweep(now);
      expect(summary.resumed).toBe(2);
      expect(summary.rateLimited).toBe(3);
      // The rate-limited entries remain tracked for the next window.
      expect(s.size()).toBe(3);
    });

    it('drains the backlog across windows as the bucket refills', () => {
      const s = makeScheduler({ ratePerWindow: 2, refillWindowMs: 60_000 });
      for (let i = 1; i <= 5; i++) s.record(entry(i, now));
      expect(s.sweep(now).resumed).toBe(2); // bucket 2 -> 0
      // Half a window later: one token refilled (60000/2 = 30000 per token).
      expect(s.sweep(now + 30_000).resumed).toBe(1);
      // A further window: remaining drain.
      expect(s.sweep(now + 120_000).resumed).toBe(2);
      expect(s.size()).toBe(0);
    });

    it('spends a token only on a genuine launch — dedup skips do not drain the bucket', () => {
      const s = makeScheduler({ ratePerWindow: 1, refillWindowMs: 60_000 });
      arbiter.set(key(1), {
        admit: false,
        reason: 'held',
        lease: { key: key(1), holderId: 'x', acquiredAt: new Date(now).toISOString() },
      });
      s.record(entry(1, now)); // will dedup (held)
      s.record(entry(2, now)); // should still get the single token
      const summary = s.sweep(now);
      expect(summary.deduped).toBe(1);
      expect(summary.resumed).toBe(1);
      expect(launched).toHaveLength(1);
      expect(launched[0].claimIssue).toEqual({ number: 2, repo: REPO });
    });
  });

  describe('shouldResume guard', () => {
    it('drops a due entry whose recorder has gone terminal (no re-dispatch of completed work)', () => {
      const terminal = new Set<string>(['task-done']);
      const s = makeScheduler({
        shouldResume: (e) => !(e.recordedTaskId !== undefined && terminal.has(e.recordedTaskId)),
      });
      s.record(entry(1, now, { recordedTaskId: 'task-done' }));
      const summary = s.sweep(now);
      expect(summary.dropped).toBe(1);
      expect(summary.resumed).toBe(0);
      expect(s.has(key(1))).toBe(false);
      expect(events.some((e) => e.type === 'dropped')).toBe(true);
    });

    it('resumes when the recorder is still live', () => {
      const s = makeScheduler({ shouldResume: () => true });
      s.record(entry(1, now, { recordedTaskId: 'task-live' }));
      expect(s.sweep(now).resumed).toBe(1);
    });
  });

  describe('failure handling', () => {
    it('re-queues an entry one refill window out when the launch rejects', async () => {
      const s = new ProviderResetScheduler({
        arbiter,
        launch: async () => {
          throw new Error('launch boom');
        },
        now: () => now,
        random: () => rand,
        maxJitterMs: 0,
        refillWindowMs: 60_000,
        onEvent: (e) => events.push(e),
      });
      s.record(entry(1, now));
      expect(s.sweep(now).resumed).toBe(1);
      // Let the rejected launch promise settle.
      await Promise.resolve();
      await Promise.resolve();
      expect(events.some((e) => e.type === 'resume_failed')).toBe(true);
      // Re-queued, not lost — but not due until a window later.
      expect(s.has(key(1))).toBe(true);
      expect(s.sweep(now).resumed).toBe(0);
      expect(s.sweep(now + 60_000).resumed).toBe(1);
    });
  });

  describe('forget', () => {
    it('stops tracking an issue', () => {
      const s = makeScheduler();
      s.record(entry(1, now));
      expect(s.forget(key(1))).toBe(true);
      expect(s.has(key(1))).toBe(false);
      expect(s.sweep(now).resumed).toBe(0);
    });
  });

  describe('record latches the reset (enables "elapsed" detection)', () => {
    it('returns the SAME latched reset on every re-record, regardless of the new value', () => {
      const s = makeScheduler();
      const first = s.record(entry(1, now + 100_000));
      expect(first.resetsAt).toBe(now + 100_000);
      // The reaper re-records each tick with a freshly-resolved (always-future)
      // reset; the latched value must NOT move, or "now >= latched" never fires.
      expect(s.record(entry(1, now + 999_999)).resetsAt).toBe(now + 100_000);
      expect(s.record(entry(1, now + 5)).resetsAt).toBe(now + 100_000);
    });

    it('keeps the original resume time across re-records (no push-out, no pull-in)', () => {
      const s = makeScheduler();
      s.record(entry(1, now + 100_000));
      s.record(entry(1, now + 999_999)); // later — ignored (would push resume out)
      s.record(entry(1, now)); // earlier — ignored (would pull resume in)
      expect(s.sweep(now).resumed).toBe(0); // not pulled in to `now`
      // Due at the FIRST latched reset — proves it was neither pushed to 999_999
      // (else this is 0) nor pulled in to `now` (else the prior sweep resumed it).
      expect(s.sweep(now + 100_000).resumed).toBe(1);
    });
  });

  describe('defaults', () => {
    it('exports sane defaults', () => {
      expect(DEFAULT_RESUME_RATE_PER_WINDOW).toBe(3);
      expect(DEFAULT_RESUME_REFILL_WINDOW_MS).toBe(60_000);
      expect(DEFAULT_RESUME_MAX_JITTER_MS).toBe(5 * 60_000);
      expect(DEFAULT_UNKNOWN_RESET_COOLDOWN_MS).toBe(60 * 60_000);
    });
  });

  describe('resolveProviderResetMs (utilization 0–100)', () => {
    const base = 2_000_000;
    const win = (utilization: number, at: number) => ({ utilization, resetsAt: new Date(at).toISOString() });

    it('falls back to a cooldown when no quota snapshot is available', () => {
      expect(resolveProviderResetMs(null, base)).toBe(base + DEFAULT_UNKNOWN_RESET_COOLDOWN_MS);
      expect(resolveProviderResetMs(undefined, base, 5_000)).toBe(base + 5_000);
    });

    it('falls back when the exhausted window reset is in the past (billing/credit pause)', () => {
      const quota = { fiveHour: win(100, base - 10_000), sevenDay: null };
      expect(resolveProviderResetMs(quota, base, 5_000)).toBe(base + 5_000);
    });

    it('picks the EXHAUSTED (binding) future window, not a soon-resetting non-exhausted one', () => {
      const soon = base + 30 * 60_000; // non-exhausted 5h window resets soon
      const later = base + 2 * 24 * 60 * 60_000; // exhausted 7d window resets later
      const quota = { fiveHour: win(40, soon), sevenDay: win(100, later) };
      expect(resolveProviderResetMs(quota, base)).toBe(later);
    });

    it('ignores a high-but-not-exhausted window (util < BINDING_WINDOW_UTILIZATION)', () => {
      // 80% is "high" but not the reason the provider is paused; must not be
      // mistaken for when capacity returns → fall back to the cooldown.
      const soon = base + 30 * 60_000;
      const quota = { fiveHour: win(80, soon), sevenDay: null };
      expect(resolveProviderResetMs(quota, base, 5_000)).toBe(base + 5_000);
    });

    it('picks the LATEST reset among several exhausted windows (never under-wait)', () => {
      const soon = base + 60_000;
      const later = base + 120_000;
      const quota = { fiveHour: win(96, soon), sevenDay: win(99, later) };
      expect(resolveProviderResetMs(quota, base)).toBe(later);
    });

    it('ignores an unparseable resetsAt', () => {
      const later = base + 60_000;
      const quota = { fiveHour: { utilization: 100, resetsAt: 'not-a-date' }, sevenDay: win(100, later) };
      expect(resolveProviderResetMs(quota, base)).toBe(later);
    });

    it('exposes BINDING_WINDOW_UTILIZATION on the 0–100 scale', () => {
      expect(BINDING_WINDOW_UTILIZATION).toBe(90);
    });
  });

  describe('buildProviderResumeLaunch', () => {
    const src = {
      id: 'paused-1',
      prompt: 'do issue 42',
      cwd: '/repo/kookr',
      criteria: 'PR merged',
      name: 'Fix 42',
      playbookId: 'pb-implement',
      playbookParameterValues: { issue: '42' },
      projectId: 'github.com/kookr-ai/kookr',
      agentType: 'claude-code' as const,
      effort: 'high',
      model: 'claude-fable-5',
      autoCloseOnSignal: true,
      issueClaim: { repo: REPO, number: 42 },
      provenance: { kind: 'schedule', sourceId: 'sched-9' },
    };

    it('replays the launch shape with lease-keyed dedup fields', () => {
      const opts = buildProviderResumeLaunch(src);
      // The two fields that make lease-dedup + ledger-bypass work:
      expect(opts.claimIssue).toEqual({ number: 42, repo: REPO });
      expect(opts.disableDedup).toBe(true);
      expect(opts.launchSource).toBe('schedule');
      // Faithful replay of the original launch shape:
      expect(opts.prompt).toBe('do issue 42');
      expect(opts.cwd).toBe('/repo/kookr');
      expect(opts.criteria).toBe('PR merged');
      expect(opts.name).toBe('Fix 42');
      expect(opts.playbookId).toBe('pb-implement');
      expect(opts.playbookParameterValues).toEqual({ issue: '42' });
      expect(opts.projectId).toBe('github.com/kookr-ai/kookr');
      expect(opts.agentType).toBe('claude-code');
      expect(opts.effort).toBe('high');
      expect(opts.model).toBe('claude-fable-5');
      expect(opts.autoCloseOnSignal).toBe(true);
      // scheduleId is carried only from schedule provenance:
      expect(opts.scheduleId).toBe('sched-9');
    });

    it('omits scheduleId for non-schedule provenance and omits absent optionals', () => {
      const opts = buildProviderResumeLaunch({
        id: 'paused-2',
        prompt: 'p',
        cwd: '/repo',
        issueClaim: { repo: REPO, number: 7 },
        provenance: { kind: 'parent', sourceId: 'parent-1' },
      });
      expect(opts.scheduleId).toBeUndefined();
      expect(opts.criteria).toBeUndefined();
      expect(opts.playbookId).toBeUndefined();
      expect(opts.agentType).toBeUndefined();
      expect(opts.effort).toBeUndefined();
      expect(opts.model).toBeUndefined();
      expect(opts.autoCloseOnSignal).toBeUndefined();
      expect(opts.claimIssue).toEqual({ number: 7, repo: REPO });
      expect(opts.disableDedup).toBe(true);
    });
  });
});
