// src/server/provider-reset-scheduler.ts — re-queue-after-reset scheduler
// (issue #1896 / #1699 WS1.4).
//
// When a provider is paused until `resetsAt`, the paused delivery-owning task
// keeps its slot (the reaper refuses to reap a `provider_paused` task —
// `lifecycle-timers.ts`, "holding slot for resume") but nothing re-dispatches
// the work once the quota window resets: today the operator must re-dispatch by
// hand. This scheduler closes that gap.
//
// Design (satisfies the four AC of #1896):
//   1. Auto-resume at reset — a paused issue is `record()`ed with its
//      `resetsAt`; a periodic `sweep()` (piggybacked on the schedule-runner
//      tick, no timer of its own) re-launches it once the reset time passes.
//   2. Jitter — each entry's effective resume time is `resetsAt + rand*jitter`,
//      so N providers whose windows reset at the same instant do NOT all fire on
//      the same tick.
//   3. Token bucket — a global bucket bounds how many resumes a single sweep may
//      launch, so even past the jitter a backlog drains at a bounded rate rather
//      than thundering-herd re-parking under load.
//   4. Lease-keyed dedup — admission is gated on the issue-claim relaunch lease
//      (`RelaunchArbiter.evaluate`/`getLease`), NOT the 24h launch
//      `IdempotencyLedger`. A lease survives a multi-day pause, so a replay after
//      a long pause cannot duplicate work: if a DIFFERENT task already owns the
//      issue the entry is dropped (deduped); the re-dispatch itself re-acquires
//      the lease under the new task.
//
// Handoff from the paused task. The paused delivery task itself holds the
// relaunch lease (acquired under its own id at launch, released only when it
// goes terminal). So at reset the lease is "held by the recorder". The reaper
// (`lifecycle-timers.ts`) stops holding the slot once the reset elapses and
// reaps the wedged task, which frees the lease (and starts the arbiter's
// post-release backoff). `sweep()` therefore treats a lease still held by the
// recorder as "not yet reaped — defer", and only launches once the lease frees
// and the backoff clears. A lease held by a *different* task is a genuine
// dedup. This is what makes AC1 (auto-resume without operator action) actually
// fire rather than deduping against the paused task's own lease.
//
// In-memory only — same posture as {@link RelaunchArbiter}: a process restart
// clears tracked entries, which errs toward re-detection (the reaper re-records
// a still-paused task on its next liveness pass) rather than duplicate work
// (the durable-enough lease still gates any concurrent actuator).

import { claimKeyString, type ClaimKey } from '../core/issue-claim-types.js';
import type { AgentType } from '../shared/contracts/agent-types.js';
import type { LaunchOpts } from '../shared/contracts/launch.js';
import type { RelaunchArbiter } from './relaunch-arbiter.js';

/** Default per-window resume budget (token-bucket capacity). */
export const DEFAULT_RESUME_RATE_PER_WINDOW = 3;
/** Default token-bucket refill window. */
export const DEFAULT_RESUME_REFILL_WINDOW_MS = 60_000;
/** Default maximum random jitter added on top of `resetsAt` (5 minutes). */
export const DEFAULT_RESUME_MAX_JITTER_MS = 5 * 60_000;
/**
 * Fallback cooldown when no concrete provider reset time is known — e.g. a
 * billing/credit pause, which is an account-level block no quota window
 * describes (1 hour).
 */
export const DEFAULT_UNKNOWN_RESET_COOLDOWN_MS = 60 * 60_000;

/**
 * Utilization (0–100 scale, per `QuotaWindow`) at or above which a window is
 * treated as the exhausted, pause-causing ("binding") window. Below this a
 * high-but-not-exhausted window is NOT the reason the provider is paused, so
 * its reset must not be mistaken for when capacity returns.
 */
export const BINDING_WINDOW_UTILIZATION = 90;

/** Minimal shape of a quota window — a subset of `QuotaWindow` (utilization 0–100). */
interface ResetWindow {
  utilization: number;
  resetsAt: string;
}

/**
 * Resolve the epoch-ms reset time for a provider pause from the latest quota
 * snapshot. Picks the reset of the BINDING window — an *exhausted*
 * (`utilization >= BINDING_WINDOW_UTILIZATION`) window whose reset is still in
 * the future; among several, the LATEST reset (never under-wait). A merely-high
 * but non-exhausted window is ignored: it is not what paused the provider, so
 * resuming at its reset would just re-pause. When no exhausted window resets in
 * the future — the account-level billing/credit case, which no quota window
 * describes — falls back to a bounded cooldown.
 */
export function resolveProviderResetMs(
  quota: { fiveHour: ResetWindow | null; sevenDay: ResetWindow | null } | null | undefined,
  now: number,
  fallbackCooldownMs: number = DEFAULT_UNKNOWN_RESET_COOLDOWN_MS,
): number {
  let latestExhaustedReset: number | undefined;
  for (const window of [quota?.fiveHour, quota?.sevenDay]) {
    if (!window) continue;
    if (window.utilization < BINDING_WINDOW_UTILIZATION) continue;
    const at = Date.parse(window.resetsAt);
    if (!Number.isFinite(at) || at <= now) continue;
    if (latestExhaustedReset === undefined || at > latestExhaustedReset) {
      latestExhaustedReset = at;
    }
  }
  return latestExhaustedReset ?? now + fallbackCooldownMs;
}

/** Minimal task shape needed to replay a provider-paused issue's launch. */
export interface ProviderResumeSource {
  id: string;
  prompt: string;
  cwd: string;
  criteria?: string;
  name?: string;
  playbookId?: string;
  playbookParameterValues?: Record<string, string>;
  projectId?: string;
  agentType?: AgentType;
  /** Independent pins copied from the persisted launch intent. */
  model?: string;
  effort?: string;
  autoCloseOnSignal?: boolean;
  /** The issue claim the resume dedups on — required (no claim ⇒ no resume). */
  issueClaim: { repo: string; number: number };
  provenance?: { kind: string; sourceId?: string };
}

/**
 * Build the {@link LaunchOpts} that resume a provider-paused issue. Mirrors the
 * launch-shape replay in `provider-transient-retry`, plus:
 *  - `claimIssue` so the resume re-acquires the relaunch lease (the sole dedup);
 *  - `disableDedup` so the 24h launch ledger — which cannot span a multi-day
 *    pause — does not suppress a legitimate resume;
 *  - `launchSource: 'schedule'` so the resume is spawn-budget-exempt like a cron
 *    fire and (correctly) still subject to the automation kill-switch.
 */
export function buildProviderResumeLaunch(task: ProviderResumeSource): LaunchOpts {
  const scheduleId = task.provenance?.kind === 'schedule' ? task.provenance.sourceId : undefined;
  return {
    prompt: task.prompt,
    cwd: task.cwd,
    ...(task.criteria ? { criteria: task.criteria } : {}),
    ...(task.name ? { name: task.name } : {}),
    ...(task.playbookId ? { playbookId: task.playbookId } : {}),
    // Detach from the source record (issue #2413): callers may pass a live
    // store ref (non-cloning views), and this LaunchOpts is retained by the
    // scheduler until the provider reset — potentially days.
    ...(task.playbookParameterValues
      ? { playbookParameterValues: structuredClone(task.playbookParameterValues) }
      : {}),
    ...(task.projectId ? { projectId: task.projectId } : {}),
    ...(task.agentType ? { agentType: task.agentType } : {}),
    ...(task.model !== undefined ? { model: task.model } : {}),
    ...(task.effort !== undefined ? { effort: task.effort } : {}),
    claimIssue: { number: task.issueClaim.number, repo: task.issueClaim.repo },
    disableDedup: true,
    launchSource: 'schedule',
    ...(scheduleId ? { scheduleId } : {}),
    ...(task.autoCloseOnSignal !== undefined ? { autoCloseOnSignal: task.autoCloseOnSignal } : {}),
  };
}

/** A paused issue registered for re-queue at its provider reset. */
export interface ProviderResetEntry {
  /** Issue-claim identity the resume dedups on. */
  key: ClaimKey;
  /**
   * Task that recorded the pause (the slot-holder). Used by the optional
   * {@link ProviderResetSchedulerOptions.shouldResume} guard to drop an entry
   * whose recorder has since gone terminal (delivered / failed) so a completed
   * issue is not re-dispatched.
   */
  recordedTaskId?: string;
  /** Provider reset time in epoch ms — resume becomes eligible at/after this. */
  resetsAt: number;
  /**
   * Launch options replayed on resume. MUST carry `claimIssue` so the replay
   * re-acquires the relaunch lease (and so the dedup keys on the lease, not the
   * 24h ledger); `disableDedup: true` is expected so the launch ledger — which
   * cannot span a multi-day pause — does not suppress a legitimate resume.
   */
  relaunch: LaunchOpts;
}

/** Outcome of a single {@link ProviderResetScheduler.sweep}. */
export interface ProviderResetSweepSummary {
  /** Entries re-launched this sweep. */
  resumed: number;
  /** Due entries dropped because the lease is held by a DIFFERENT task (dedup). */
  deduped: number;
  /**
   * Due entries left for a later sweep — either the lease is still held by the
   * paused recorder (not yet reaped) or it is in post-release backoff.
   */
  deferred: number;
  /** Due entries left because the token bucket was empty (rate limited). */
  rateLimited: number;
  /** Due entries dropped by the {@link ProviderResetSchedulerOptions.shouldResume} guard. */
  dropped: number;
}

/** Structured transition for durable/observable sinks. */
export type ProviderResetEvent =
  | { type: 'record'; key: ClaimKey; resumeAt: number }
  | { type: 'resume'; key: ClaimKey; resumeAt: number }
  | { type: 'resume_failed'; key: ClaimKey; error: string }
  | { type: 'deduped'; key: ClaimKey }
  | { type: 'dropped'; key: ClaimKey };

export interface ProviderResetSchedulerOptions {
  /**
   * Lease inspection (issue #1711 arbiter). `evaluate` is the non-mutating
   * admission check; `getLease` identifies the current holder so the sweep can
   * tell "held by the paused recorder itself — defer until it is reaped" from
   * "held by a different task — genuine dedup". The scheduler never *acquires*
   * the lease: acquisition happens inside the replayed `launch` under the fresh
   * task's id (holding it here would deny the very launch it triggers).
   */
  arbiter: Pick<RelaunchArbiter, 'evaluate' | 'getLease'>;
  /**
   * Replays a paused issue's launch. Rejection re-queues the entry (bumped one
   * refill window forward) so a transient launch failure retries — bounded by
   * the token bucket, never a tight loop.
   */
  launch: (opts: LaunchOpts) => Promise<unknown>;
  /** Resumes admitted per refill window. Default {@link DEFAULT_RESUME_RATE_PER_WINDOW}. */
  ratePerWindow?: number;
  /** Token-bucket refill window in ms. Default {@link DEFAULT_RESUME_REFILL_WINDOW_MS}. */
  refillWindowMs?: number;
  /** Max random jitter added to `resetsAt`. Default {@link DEFAULT_RESUME_MAX_JITTER_MS}. */
  maxJitterMs?: number;
  /** Injected clock (epoch ms). Default `Date.now`. */
  now?: () => number;
  /** Injected RNG in [0,1). Default `Math.random`. Used only for jitter. */
  random?: () => number;
  /**
   * Optional sync guard evaluated per due entry. Return `false` to drop the
   * entry without re-launching (e.g. the recording task went terminal, so the
   * work was either delivered or is being relaunched by another actuator).
   * Default: always resumable.
   */
  shouldResume?: (entry: ProviderResetEntry) => boolean;
  /** Optional observer for transitions. Must not throw. */
  onEvent?: (event: ProviderResetEvent) => void;
}

interface Tracked {
  key: ClaimKey;
  recordedTaskId: string | undefined;
  /** Raw provider reset time (epoch ms), before jitter. */
  resetsAt: number;
  /** Stable jitter offset (ms) — rolled once at first record, never re-rolled. */
  jitterMs: number;
  /** Effective resume time = `resetsAt + jitterMs`. Due when `now >= resumeAt`. */
  resumeAt: number;
  relaunch: LaunchOpts;
}

/**
 * Lazy-refill global token bucket (mirrors the telegram
 * `createTokenBucket` idiom, single-bucket + injected clock).
 */
class TokenBucket {
  private tokens: number;
  private lastRefillAt: number;
  private readonly refillIntervalMs: number;

  constructor(
    private readonly capacity: number,
    refillWindowMs: number,
    startAt: number,
  ) {
    this.tokens = capacity;
    this.lastRefillAt = startAt;
    // Time to regain one token: the full window spread evenly across capacity.
    this.refillIntervalMs = refillWindowMs / Math.max(1, capacity);
  }

  private refill(now: number): void {
    const elapsed = now - this.lastRefillAt;
    if (elapsed <= 0) return;
    const gained = Math.floor(elapsed / this.refillIntervalMs);
    if (gained > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + gained);
      this.lastRefillAt += gained * this.refillIntervalMs;
    }
  }

  take(now: number): boolean {
    this.refill(now);
    if (this.tokens <= 0) return false;
    this.tokens -= 1;
    return true;
  }
}

/**
 * Re-queue-after-reset scheduler (issue #1896). See file header for the design.
 */
export class ProviderResetScheduler {
  private readonly tracked = new Map<string, Tracked>();
  private readonly bucket: TokenBucket;
  private readonly maxJitterMs: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly arbiter: Pick<RelaunchArbiter, 'evaluate' | 'getLease'>;
  private readonly launch: (opts: LaunchOpts) => Promise<unknown>;
  private readonly refillWindowMs: number;
  private readonly shouldResume: ((entry: ProviderResetEntry) => boolean) | undefined;
  private readonly onEvent: ((event: ProviderResetEvent) => void) | undefined;

  constructor(opts: ProviderResetSchedulerOptions) {
    this.arbiter = opts.arbiter;
    this.launch = opts.launch;
    this.now = opts.now ?? (() => Date.now());
    this.random = opts.random ?? Math.random;
    this.maxJitterMs = Math.max(0, opts.maxJitterMs ?? DEFAULT_RESUME_MAX_JITTER_MS);
    this.refillWindowMs = opts.refillWindowMs ?? DEFAULT_RESUME_REFILL_WINDOW_MS;
    const rate = Math.max(1, opts.ratePerWindow ?? DEFAULT_RESUME_RATE_PER_WINDOW);
    this.bucket = new TokenBucket(rate, this.refillWindowMs, this.now());
    this.shouldResume = opts.shouldResume;
    this.onEvent = opts.onEvent;
  }

  /**
   * Register (or refresh) a paused issue for re-queue at its reset. Idempotent
   * per issue-claim key, and — critically — the reset time is LATCHED at first
   * record: a repeat record for an already-tracked issue refreshes the launch
   * payload / recorder but NEVER changes the stored `resetsAt`/`resumeAt`/jitter.
   *
   * Latching is what lets the caller detect "the reset has elapsed": the reaper
   * re-records a still-paused task on every liveness tick with a freshly-resolved
   * (always-future) reset time, and compares `now` against the returned latched
   * value. If `record` re-derived the reset each tick, that value would forever
   * stay in the future and the "elapsed" transition would never be observable —
   * the hand-off would be dead code (the resume would never fire).
   *
   * @returns the latched reset time and whether a NEW entry was created.
   */
  record(entry: ProviderResetEntry): { created: boolean; resetsAt: number } {
    const k = claimKeyString(entry.key);
    const existing = this.tracked.get(k);
    if (existing) {
      existing.relaunch = entry.relaunch;
      existing.recordedTaskId = entry.recordedTaskId;
      return { created: false, resetsAt: existing.resetsAt };
    }
    const jitterMs = this.maxJitterMs > 0 ? Math.floor(this.random() * this.maxJitterMs) : 0;
    const resumeAt = entry.resetsAt + jitterMs;
    this.tracked.set(k, {
      key: { repo: entry.key.repo, number: entry.key.number },
      recordedTaskId: entry.recordedTaskId,
      resetsAt: entry.resetsAt,
      jitterMs,
      resumeAt,
      relaunch: entry.relaunch,
    });
    this.onEvent?.({ type: 'record', key: entry.key, resumeAt });
    return { created: true, resetsAt: entry.resetsAt };
  }

  /** Stop tracking an issue (e.g. it resumed or completed by another path). */
  forget(key: ClaimKey): boolean {
    return this.tracked.delete(claimKeyString(key));
  }

  /** True when an issue is currently tracked for resume. */
  has(key: ClaimKey): boolean {
    return this.tracked.has(claimKeyString(key));
  }

  /** Number of issues currently tracked. */
  size(): number {
    return this.tracked.size;
  }

  /**
   * Re-launch every due entry, bounded by jitter (already baked into each
   * entry's resume time), the token bucket, and the lease. Never throws — the
   * launch is fire-and-forget with its own rejection handler. Safe to call on
   * every scheduler tick.
   */
  sweep(nowMs?: number): ProviderResetSweepSummary {
    const now = nowMs ?? this.now();
    const summary: ProviderResetSweepSummary = {
      resumed: 0,
      deduped: 0,
      deferred: 0,
      rateLimited: 0,
      dropped: 0,
    };
    // Earliest-due first so a full backlog drains fairly under the rate cap.
    const due = [...this.tracked.values()]
      .filter((t) => t.resumeAt <= now)
      .sort((a, b) => a.resumeAt - b.resumeAt);

    for (const t of due) {
      const k = claimKeyString(t.key);

      // Stale-entry guard: recorder delivered/failed → do not re-dispatch.
      if (this.shouldResume && !this.shouldResume(this.toEntry(t))) {
        this.tracked.delete(k);
        this.onEvent?.({ type: 'dropped', key: t.key });
        summary.dropped++;
        continue;
      }

      // Lease-keyed dedup (NOT the 24h launch ledger).
      const admission = this.arbiter.evaluate(t.key);
      if (!admission.admit) {
        if (admission.reason === 'held') {
          const holderId = this.arbiter.getLease(t.key)?.holderId;
          if (holderId !== undefined && holderId === t.recordedTaskId) {
            // Held by the paused recorder itself — it has not been reaped yet.
            // Defer (keep the entry): once the reaper frees the lease at/after
            // reset, a later sweep resumes. Dropping here would strand the
            // resume against the paused task's own lease (AC1 would never fire).
            summary.deferred++;
          } else {
            // Held by a DIFFERENT task — another actuator owns the issue, the
            // work is covered. Drop (dedup) — no duplicate re-dispatch.
            this.tracked.delete(k);
            this.onEvent?.({ type: 'deduped', key: t.key });
            summary.deduped++;
          }
        } else {
          // Post-release backoff (e.g. just reaped) — retry once it clears.
          summary.deferred++;
        }
        continue;
      }

      // Global rate limit — spend a token only on a genuine re-launch.
      if (!this.bucket.take(now)) {
        summary.rateLimited++;
        continue;
      }

      this.tracked.delete(k);
      summary.resumed++;
      this.onEvent?.({ type: 'resume', key: t.key, resumeAt: t.resumeAt });
      this.dispatch(t);
    }

    return summary;
  }

  /** Fire-and-forget launch with retry-on-failure re-queue. */
  private dispatch(t: Tracked): void {
    const onFailure = (err: unknown): void => {
      const message = err instanceof Error ? err.message : String(err);
      this.onEvent?.({ type: 'resume_failed', key: t.key, error: message });
      // Re-queue one refill window out so a transient failure retries without a
      // tight loop; skip if a fresh record for the same issue arrived meanwhile.
      const k = claimKeyString(t.key);
      if (!this.tracked.has(k)) {
        this.tracked.set(k, { ...t, resumeAt: this.now() + this.refillWindowMs });
      }
    };
    try {
      // Start the launch synchronously so the pipeline begins within this tick;
      // its rejection (or a sync throw) is handled off the sweep's critical path.
      void Promise.resolve(this.launch(t.relaunch)).catch(onFailure);
    } catch (err) {
      onFailure(err);
    }
  }

  private toEntry(t: Tracked): ProviderResetEntry {
    return {
      key: t.key,
      ...(t.recordedTaskId !== undefined ? { recordedTaskId: t.recordedTaskId } : {}),
      resetsAt: t.resetsAt,
      relaunch: t.relaunch,
    };
  }
}
