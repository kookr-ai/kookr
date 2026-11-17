import type { Task, TaskStore } from '../core/tasks.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
import type { TaskDisposition, TaskReapOutcome } from '../shared/contracts/task.js';
import type { MergedPrAttribution } from '../core/completion/index.js';
import type { HungTaskLivenessEvidence } from '../core/hung-task-reaper.js';
import {
  DEFAULT_PROVIDER_PAUSED_HARD_TTL_MS,
  DEFAULT_PROVIDER_PAUSED_SOFT_TTL_MS,
  MAX_PROVIDER_PAUSED_HARD_TTL_MS,
  effectiveProviderPausedStartMs,
  PROVIDER_RESET_HOLD_GRACE_MS,
  emptyProviderPausedTtlSkipCounts,
  effectiveProviderPausedTtlMs,
  isFirstPartyProviderPauseDetail,
  providerPausedOpenPrFailsafeSkipTotal,
  selectExpiredProviderPausedTasks,
  summarizeOpenPrFailsafeHoldAge,
  summarizeProviderPausedOccupancy,
  type OpenPrFailsafeHoldAgeSummary,
  type ProviderPausedOccupancySnapshot,
  type ProviderPausedTtlCandidateOutcome,
  type ProviderPausedTtlSkipCounts,
  type ProviderResetState,
} from '../core/provider-paused-ttl.js';
import type { PollerState } from '../adapters/quota-adapter.js';
import type { QuotaStatus } from '../shared/contracts/quota.js';
import { listExhaustedProviderResetsMs } from './provider-reset-scheduler.js';
import { appendAuditRow } from '../core/audit-log.js';
import { appendDispositionEntry, type DispositionEntry } from '../core/disposition-ledger.js';
import { nowISO } from '../core/interaction-log.js';
import { terminateTask, type LifecycleDeps } from './agent-lifecycle.js';
import { readStoreDeliveredPr, resolveReapDeliveredPr } from './hung-suspect-ttl-sweep.js';

/** Cap last-pass outcome samples on health (issue #2079 audit). */
const MAX_LAST_OUTCOMES = 16;

/**
 * First-observed continuous pause start per task (issue #2079).
 *
 * Latches `pauseStartedAt` the first time a task is observed provider_paused
 * while inProgress; clears when the task leaves pause or leaves inProgress
 * so a later pause gets a fresh clock. Process-memory only — restart re-latches
 * on the next tick (same trade-off as delivered-completion firstObserved map).
 */
export class ProviderPausedStartTracker {
  private readonly pauseStartedAt = new Map<string, number>();
  /**
   * Latest known provider reset observed during the current pause (issue
   * #3562). Latched because once the window resets, a fresh quota snapshot no
   * longer names it — without the latch the task would be reclaimed on the
   * first tick after the reset, just as the CLI resumes. Cleared with the
   * pause start.
   */
  private readonly knownResetAt = new Map<string, number>();
  /**
   * Tasks whose current pause showed a first-party stop_failure (billing,
   * auth or quota error, issue #4050, or a rate limit, issue #4082) at least
   * once. Latched because the pause detail is read from a recent-events
   * window: a later error event or tool result can become the newest match
   * and hide the stop_failure, which would bring the healthy-quota hold back.
   * The latch is set on every pass, poller healthy or not, so a pause seen
   * only while the poller backed off keeps it once the window rolls over.
   * Cleared with the pause start.
   */
  private readonly firstPartyEvidence = new Set<string>();

  /**
   * Observe one task: latch start if paused+inProgress, else clear.
   * Returns the latched start ms when currently paused, else undefined.
   */
  observe(task: Task, isPaused: boolean, nowMs: number): number | undefined {
    if (task.status !== 'inProgress' || task.pendingSignal?.kind === 'completion_ready') {
      this.clear(task.id);
      return undefined;
    }
    if (!isPaused) {
      this.clear(task.id);
      return undefined;
    }
    const existing = this.pauseStartedAt.get(task.id);
    if (existing !== undefined) return existing;
    const start = Number.isFinite(nowMs) ? nowMs : Date.now();
    this.pauseStartedAt.set(task.id, start);
    return start;
  }

  /** Read latched start without mutating (for selection after observe). */
  getPauseStartedAtMs(taskId: string): number | undefined {
    return this.pauseStartedAt.get(taskId);
  }

  /**
   * Record a known provider reset for a currently paused task (issue #3562).
   * Keeps the latest one seen during this pause (never under-wait). Ignored
   * when the task has no latched pause start.
   */
  latchKnownReset(taskId: string, resetsAtMs: number): void {
    if (!this.pauseStartedAt.has(taskId) || !Number.isFinite(resetsAtMs)) return;
    const existing = this.knownResetAt.get(taskId);
    if (existing === undefined || resetsAtMs > existing) {
      this.knownResetAt.set(taskId, resetsAtMs);
    }
  }

  /** Latched known provider reset for the current pause, if any (issue #3562). */
  getKnownResetMs(taskId: string): number | undefined {
    return this.knownResetAt.get(taskId);
  }

  /**
   * Record that the current pause showed a first-party stop_failure (issues
   * #4050, #4082). Ignored when the task has no latched pause start.
   */
  latchFirstPartyEvidence(taskId: string): void {
    if (!this.pauseStartedAt.has(taskId)) return;
    this.firstPartyEvidence.add(taskId);
  }

  /** Whether the current pause showed a first-party stop_failure (issues #4050, #4082). */
  hasFirstPartyEvidence(taskId: string): boolean {
    return this.firstPartyEvidence.has(taskId);
  }

  /** Drop a task (after reclaim / terminal). */
  clear(taskId: string): void {
    this.pauseStartedAt.delete(taskId);
    this.knownResetAt.delete(taskId);
    this.firstPartyEvidence.delete(taskId);
  }

  /**
   * Sweep all tasks once: latch/clear pause starts, return a getter for
   * selection + occupancy summary on the same pass.
   */
  observeAll(
    tasks: readonly Task[],
    isProviderPaused: (task: Task) => boolean,
    nowMs: number,
  ): (task: Task) => number | undefined {
    const liveIds = new Set<string>();
    for (const task of tasks) {
      liveIds.add(task.id);
      this.observe(task, isProviderPaused(task), nowMs);
    }
    // Drop starts for tasks no longer in the store (completed/pruned elsewhere).
    for (const id of this.pauseStartedAt.keys()) {
      if (!liveIds.has(id)) this.clear(id);
    }
    return (task: Task) => this.getPauseStartedAtMs(task.id);
  }
}

/**
 * Quota-poller view the reclaim reads to learn when a pause lifts (issue
 * #3562). `quota` is the last successful snapshot (`QuotaAdapter.getLatest()`),
 * `pollerState` the poller's current state (`QuotaAdapter.getState()`).
 */
export interface ProviderResetSource {
  quota: Pick<QuotaStatus, 'fiveHour' | 'sevenDay' | 'updatedAt'> | null;
  pollerState: PollerState;
}

/**
 * Classify what a quota snapshot says about a paused task's reset (issue
 * #3562). A stale snapshot can prove a reset is pending (the timestamp is
 * fixed) but never that none is, so:
 *
 * - an exhausted window whose reset (+ grace) lands within the 6h max of the
 *   pause start → `known`, whatever the poller state. With several, the
 *   latest that fits: a weekly window at 90%+ resetting in days must not hide
 *   the 5-hour reset the CLI resumes at;
 * - exhausted windows that all reset beyond that ceiling → `unresolved`: the
 *   CLI will not resume within any hold we allow, and the 90% binding
 *   threshold cannot tell us which window actually paused it, so keep the
 *   soft bound off and let the hard TTL decide;
 * - a `disabled` poller (no OAuth credentials file — e.g. Keychain, API-key
 *   or Bedrock installs) → `none`: there is no quota source at all, so keep
 *   the pre-#3562 behavior rather than disable soft reclaim forever;
 * - no snapshot, a poller that is not healthy (backoff, auth-failed, idle),
 *   or a snapshot last refreshed before the pause began → `unresolved`;
 * - otherwise (fresh, healthy, no binding window) → `quota_healthy` (issue
 *   #3574): the quota contradicts the pause. The sweep downgrades it to `none`
 *   when a reset was latched earlier in this pause — then the window rolled
 *   over and the pause was real — and when the pause showed a first-party
 *   stop_failure: a billing, auth or quota error (issue #4050) or a rate
 *   limit (issue #4082), which a later healthy snapshot cannot contradict.
 */
export function classifyProviderResetState(input: {
  source: ProviderResetSource;
  nowMs: number;
  /**
   * Effective pause start — the same activity-advanced start the selector
   * measures pause age and the 6h hold cap from
   * ({@link effectiveProviderPausedStartMs}).
   */
  pauseStartedAtMs?: number;
}): ProviderResetState {
  const { quota, pollerState } = input.source;
  const exhausted = listExhaustedProviderResetsMs(quota, input.nowMs);
  if (exhausted.length > 0) {
    const start = input.pauseStartedAtMs ?? input.nowMs;
    const fitting = exhausted.filter(
      (at) => at + PROVIDER_RESET_HOLD_GRACE_MS - start <= MAX_PROVIDER_PAUSED_HARD_TTL_MS,
    );
    if (fitting.length === 0) return { kind: 'unresolved' };
    return { kind: 'known', resetsAtMs: Math.max(...fitting) };
  }
  if (pollerState === 'disabled') return { kind: 'none' };
  if (!quota) return { kind: 'unresolved' };
  if (pollerState !== 'healthy' && pollerState !== 'polling') return { kind: 'unresolved' };
  if (
    typeof input.pauseStartedAtMs === 'number'
    && (!Number.isFinite(quota.updatedAt) || quota.updatedAt < input.pauseStartedAtMs)
  ) {
    return { kind: 'unresolved' };
  }
  return { kind: 'quota_healthy' };
}

/**
 * The quota poller reads the Claude account's usage, so it only describes
 * Claude Code sessions. Other agent types keep today's soft/hard behavior
 * (issue #3562). A task with no recorded agentType is a legacy Claude task.
 */
function taskUsesClaudeQuota(task: Task): boolean {
  return task.agentType === undefined || task.agentType === 'claude-code';
}

/**
 * In-memory snapshot for `/api/health` + `/metrics` (issue #2079).
 * Process-lifetime cumulative counters — restart zeros them.
 */
export interface ProviderPausedOccupancyMetricsSnapshot {
  /** Live occupancy from the last observe pass. */
  count: number;
  oldestPauseAgeMs: number | null;
  taskIds: string[];
  /** Cumulative hard-TTL terminates since process start. */
  reclaimedTotal: number;
  reclaimAttempted: number;
  reclaimSucceeded: number;
  skippedUnderTtl: number;
  /**
   * Aggregate open-PR fail-safe skips (`confirmed + unknown`) for scraper
   * compat. Prefer {@link skippedOpenPrConfirmed} / {@link skippedOpenPrUnknown}
   * when attributing residual (issue #2228).
   */
  skippedOpenPrFailsafe: number;
  /** Confirmed-open PR hold (`isHoldingOpenPr === true`) — issue #2228. */
  skippedOpenPrConfirmed: number;
  /** Unknown/unwired PR hold (GitHub state lag or predicate omitted) — issue #2228. */
  skippedOpenPrUnknown: number;
  skippedNoPauseStart: number;
  /**
   * Holds waiting on a provider reset: the #1896 auto-resume hold, plus (issue
   * #3562) any task, issueClaim or not, whose known reset is still ahead.
   */
  skippedAwaitingProviderReset: number;
  /**
   * Soft-bound reclaims withheld because the reset could not be resolved (no
   * or untrustworthy quota snapshot) — issue #3562. Distinct from
   * {@link skippedAwaitingProviderReset}: this one is "unknown", not "known
   * and pending". The hard TTL still reclaims these.
   */
  skippedProviderResetUnresolved: number;
  /**
   * Reclaims withheld because the quota poller is healthy and no window is
   * exhausted, so the quota contradicts the pause (issue #3574). Held on both
   * bounds up to the 6h max from the effective pause start.
   */
  skippedProviderQuotaHealthy: number;
  /**
   * Oldest current open-PR fail-safe hold age (ms) — the max `pausedForMs`
   * among `skipped_open_pr_*` outcomes on the last selection pass, or `null`
   * when nothing is held. Surfaces a task pinned by the open-PR exemption past
   * the TTL a normal pause would reclaim at (issue #3115).
   */
  oldestOpenPrFailsafeHoldMs: number | null;
  /**
   * Count of open-PR fail-safe holds whose pause age has passed the hard TTL on
   * the last selection pass (issue #3115). > 0 means a slot is held past the
   * bound a normal pause would reclaim at; the exemption is still respected.
   */
  openPrFailsafeOverHardTtlCount: number;
  lastCandidatesConsidered: number;
  lastOutcomes: ProviderPausedTtlCandidateOutcome[];
  lastAttemptedTaskIds: string[];
  /** Configured hard TTL (ms) last used for selection. */
  hardTtlMs: number;
  /**
   * Soft TTL (ms) for capacity-aware early reclaim (issue #2225). Present when
   * the sweep supports soft reclaim; equals the soft bound even when the last
   * pass used the hard TTL only.
   */
  softTtlMs: number;
  /** Effective TTL used on the last selection pass (hard or min(hard, soft)). */
  effectiveTtlMs: number;
  /** Whether the last pass enabled capacity-aware early reclaim (issue #2225). */
  capacityEarlyReclaim: boolean;
}

/**
 * Process-lifetime counters + last occupancy for provider_paused bound
 * (issue #2079). One instance at bootstrap, threaded into the sweep,
 * `/api/health`, and `/metrics`.
 */
export class ProviderPausedOccupancyMetrics {
  private reclaimedTotal = 0;
  private reclaimAttempted = 0;
  private skips: ProviderPausedTtlSkipCounts = emptyProviderPausedTtlSkipCounts();
  private lastCandidatesConsidered = 0;
  private lastOutcomes: ProviderPausedTtlCandidateOutcome[] = [];
  private lastAttemptedTaskIds: string[] = [];
  /** Last-pass open-PR fail-safe hold age summary (issue #3115). */
  private lastOpenPrFailsafeHoldAge: OpenPrFailsafeHoldAgeSummary = {
    oldestHoldMs: null,
    holdCount: 0,
    overHardTtlCount: 0,
  };
  private lastOccupancy: ProviderPausedOccupancySnapshot = {
    count: 0,
    oldestPauseAgeMs: null,
    taskIds: [],
  };
  private hardTtlMs = DEFAULT_PROVIDER_PAUSED_HARD_TTL_MS;
  private softTtlMs = DEFAULT_PROVIDER_PAUSED_SOFT_TTL_MS;
  private effectiveTtlMs = DEFAULT_PROVIDER_PAUSED_HARD_TTL_MS;
  private capacityEarlyReclaim = false;

  recordOccupancy(snapshot: ProviderPausedOccupancySnapshot): void {
    this.lastOccupancy = {
      count: snapshot.count,
      oldestPauseAgeMs: snapshot.oldestPauseAgeMs,
      taskIds: [...snapshot.taskIds],
    };
  }

  recordHardTtlMs(ttlMs: number): void {
    if (typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs > 0) {
      this.hardTtlMs = Math.floor(ttlMs);
    }
  }

  /** Soft TTL + capacity gate for the last selection pass (issue #2225). */
  recordSoftTtlPolicy(opts: {
    softTtlMs?: number;
    capacityAllowsEarlyReclaim?: boolean;
    effectiveTtlMs?: number;
  }): void {
    if (typeof opts.softTtlMs === 'number' && Number.isFinite(opts.softTtlMs) && opts.softTtlMs > 0) {
      this.softTtlMs = Math.floor(opts.softTtlMs);
    }
    this.capacityEarlyReclaim = opts.capacityAllowsEarlyReclaim === true;
    if (
      typeof opts.effectiveTtlMs === 'number'
      && Number.isFinite(opts.effectiveTtlMs)
      && opts.effectiveTtlMs > 0
    ) {
      this.effectiveTtlMs = Math.floor(opts.effectiveTtlMs);
    } else {
      this.effectiveTtlMs = effectiveProviderPausedTtlMs({
        ttlMs: this.hardTtlMs,
        softTtlMs: this.softTtlMs,
        capacityAllowsEarlyReclaim: this.capacityEarlyReclaim,
      });
    }
  }

  recordReclaimed(count: number): void {
    if (count > 0) this.reclaimedTotal += count;
  }

  recordAttempted(count: number): void {
    if (count > 0) this.reclaimAttempted += count;
  }

  recordSelection(selection: {
    candidatesConsidered: number;
    skips: ProviderPausedTtlSkipCounts;
    outcomes?: readonly ProviderPausedTtlCandidateOutcome[];
  }): void {
    this.lastCandidatesConsidered = selection.candidatesConsidered;
    this.skips.skipped_under_ttl += selection.skips.skipped_under_ttl;
    this.skips.skipped_open_pr_confirmed += selection.skips.skipped_open_pr_confirmed;
    this.skips.skipped_open_pr_unknown += selection.skips.skipped_open_pr_unknown;
    this.skips.skipped_no_pause_start += selection.skips.skipped_no_pause_start;
    this.skips.skipped_awaiting_provider_reset +=
      selection.skips.skipped_awaiting_provider_reset;
    this.skips.skipped_provider_reset_unresolved +=
      selection.skips.skipped_provider_reset_unresolved;
    this.skips.skipped_provider_quota_healthy +=
      selection.skips.skipped_provider_quota_healthy;
    const outcomes = selection.outcomes ?? [];
    this.lastOutcomes = outcomes.slice(0, MAX_LAST_OUTCOMES).map((o) => ({ ...o }));
    this.lastAttemptedTaskIds = outcomes
      .filter((o) => o.outcome === 'selected')
      .map((o) => o.taskId)
      .slice(0, MAX_LAST_OUTCOMES);
    // Issue #3115: compute open-PR fail-safe hold age from the *full* outcome
    // list (not the capped lastOutcomes) so an oldest hold beyond the sample cap
    // is still counted. Uses the hard TTL recorded earlier this pass.
    this.lastOpenPrFailsafeHoldAge = summarizeOpenPrFailsafeHoldAge(
      outcomes,
      this.hardTtlMs,
    );
  }

  getSnapshot(): ProviderPausedOccupancyMetricsSnapshot {
    return {
      count: this.lastOccupancy.count,
      oldestPauseAgeMs: this.lastOccupancy.oldestPauseAgeMs,
      taskIds: [...this.lastOccupancy.taskIds],
      reclaimedTotal: this.reclaimedTotal,
      reclaimAttempted: this.reclaimAttempted,
      reclaimSucceeded: this.reclaimedTotal,
      skippedUnderTtl: this.skips.skipped_under_ttl,
      skippedOpenPrFailsafe: providerPausedOpenPrFailsafeSkipTotal(this.skips),
      skippedOpenPrConfirmed: this.skips.skipped_open_pr_confirmed,
      skippedOpenPrUnknown: this.skips.skipped_open_pr_unknown,
      skippedNoPauseStart: this.skips.skipped_no_pause_start,
      skippedAwaitingProviderReset: this.skips.skipped_awaiting_provider_reset,
      skippedProviderResetUnresolved: this.skips.skipped_provider_reset_unresolved,
      skippedProviderQuotaHealthy: this.skips.skipped_provider_quota_healthy,
      oldestOpenPrFailsafeHoldMs: this.lastOpenPrFailsafeHoldAge.oldestHoldMs,
      openPrFailsafeOverHardTtlCount:
        this.lastOpenPrFailsafeHoldAge.overHardTtlCount,
      lastCandidatesConsidered: this.lastCandidatesConsidered,
      lastOutcomes: this.lastOutcomes.map((o) => ({ ...o })),
      lastAttemptedTaskIds: [...this.lastAttemptedTaskIds],
      hardTtlMs: this.hardTtlMs,
      softTtlMs: this.softTtlMs,
      effectiveTtlMs: this.effectiveTtlMs,
      capacityEarlyReclaim: this.capacityEarlyReclaim,
    };
  }
}

export interface ReclaimProviderPausedTasksDeps {
  taskStore: TaskStore;
  lifecycleDeps?: LifecycleDeps;
  auditLogPath?: string;
  dispositionLedgerPath?: string;
  broadcastToAll?: (msg: ServerMessage) => void;
  isProviderPaused: (task: Task) => boolean;
  /** First-observed pause start tracker (shared across ticks). */
  pauseStartTracker: ProviderPausedStartTracker;
  /**
   * Optional liveness evidence — used so hard-TTL age follows last activity
   * when sticky billing events remain in the event window (issue #2079).
   */
  getLiveness?: (task: Task) => HungTaskLivenessEvidence | undefined;
  /**
   * Provider-reset registration (#1896). Same contract as the hung-task
   * reaper's `recordProviderPause`: returns whether to keep holding for resume.
   * When holdForResume is true, reclaim skips only while pause age is still
   * under the hard TTL so auto-resume can fire at reset (issue #2423). After
   * the hard bound, a missing reset no longer occupies the slot. When false
   * (reset elapsed), reclaim proceeds and frees the lease for the scheduled
   * relaunch.
   */
  recordProviderPause?: (
    task: Task,
    detail?: string,
  ) => { holdForResume: boolean } | void;
  isHoldingOpenPr?: (task: Task) => boolean | undefined;
  /**
   * Quota-poller view used to hold paused tasks on a known provider reset and
   * to keep the soft bound off an unresolvable one (issue #3562). Read once
   * per pass. Omitted → no reset-based holds (pre-#3562 behavior).
   */
  getProviderResetSource?: () => ProviderResetSource;
  /**
   * Which evidence classified the task as paused — the `detail` of
   * `classifyProviderPause` (issue #4050). A first-party stop_failure seen
   * during a pause — billing, auth or quota (#4050) or rate limit (#4082) —
   * turns the healthy-quota hold (#3574) off for that pause, so it is
   * reclaimed at the soft or hard TTL like before #3574. Omitted, or
   * undefined for a task → the hold still applies.
   */
  getProviderPauseDetail?: (task: Task) => string | undefined;
  /**
   * Delivery attribution for the disposition label only (issue #3578) — the
   * same in-memory probe the hungSuspect TTL reclaim uses. A merged PR turns
   * the label into `delivered_then_hung` / ledger `obsolete`; the task is
   * still terminated and never auto-completed on a billing/quota hold.
   */
  resolveMergedPr?: (task: Task) => MergedPrAttribution | null;
  /**
   * Branch-keyed fallback for {@link resolveMergedPr} (issue #3578). Same
   * label-only contract; consulted after the terminate, bounded.
   */
  resolveMergedPrByBranch?: (task: Task) => Promise<MergedPrAttribution | null>;
  /**
   * Soft TTL for capacity-aware early reclaim (issue #2225). Defaults to
   * {@link DEFAULT_PROVIDER_PAUSED_SOFT_TTL_MS} when capacity allows early reclaim.
   */
  softTtlMs?: number;
  /**
   * When true, select at the soft TTL instead of only the hard 2h bound
   * (issue #2225). Wire from capacity ledger + occupancy.
   */
  capacityAllowsEarlyReclaim?: boolean;
  metrics?: Pick<
    ProviderPausedOccupancyMetrics,
    | 'recordReclaimed'
    | 'recordAttempted'
    | 'recordSelection'
    | 'recordOccupancy'
    | 'recordHardTtlMs'
    | 'recordSoftTtlPolicy'
  >;
}

export interface ReclaimProviderPausedTasksResult {
  reclaimedTaskIds: string[];
  occupancy: ProviderPausedOccupancySnapshot;
  selection?: {
    candidatesConsidered: number;
    skips: ProviderPausedTtlSkipCounts;
    selectedCount: number;
    outcomes: ProviderPausedTtlCandidateOutcome[];
  };
}

/**
 * Build the task.disposition for a provider_paused hard-TTL reclaim (issue #2079).
 *
 * The reclaim never force-completes a task. The label still has to be true,
 * though (issue #3578): when the task's PR had already merged before the
 * billing/quota hold, record `delivered_then_hung` with `deliveredPr` so the
 * operator does not go looking for work to recover. Otherwise `terminated` /
 * needs-human, as before.
 */
export function buildProviderPausedTtlDisposition(
  at: string,
  merged?: MergedPrAttribution | null,
): TaskDisposition {
  const outcome: TaskReapOutcome = merged ? 'delivered_then_hung' : 'terminated';
  const disposition: TaskDisposition = {
    reason: 'provider_paused_ttl',
    at,
    source: 'provider-paused-ttl',
    outcome,
  };
  if (merged) {
    disposition.deliveredPr = {
      number: merged.prNumber,
      ...(merged.prUrl ? { url: merged.prUrl } : {}),
    };
    disposition.detail =
      `Delivered PR #${merged.prNumber} before the billing/quota hold; reclaimed after `
      + 'provider_paused TTL (terminated, not auto-completed).';
  } else {
    disposition.detail =
      'Reclaimed after provider_paused hard TTL with no auto-complete — needs human review '
      + '(billing/quota hold, not delivered).';
  }
  return disposition;
}

/**
 * Observe provider_paused occupancy and hard-TTL reclaim (issue #2079).
 *
 * Soft reclaim: terminates the session (frees the concurrency slot) without
 * force-completing incomplete work. Each reclaimed task gets:
 *
 * - `task.disposition` reason `provider_paused_ttl` (first-write-wins);
 * - an audit.jsonl row, actor `system:provider-paused-ttl`;
 * - a disposition-ledger entry: `obsolete` when the task's PR had already
 *   merged (issue #3578), else `needs-human`.
 *
 * Open-PR fail-safe protects in-flight delivery; this function only executes
 * what the pure selector already cleared. One summary alert per reclaim batch.
 */
export async function reclaimAgedProviderPausedTasks(
  deps: ReclaimProviderPausedTasksDeps,
  opts: {
    now?: Date;
    ttlMs?: number;
    softTtlMs?: number;
    capacityAllowsEarlyReclaim?: boolean;
  } = {},
): Promise<ReclaimProviderPausedTasksResult> {
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const hardTtlMs = opts.ttlMs ?? DEFAULT_PROVIDER_PAUSED_HARD_TTL_MS;
  const softTtlMs =
    opts.softTtlMs
    ?? deps.softTtlMs
    ?? DEFAULT_PROVIDER_PAUSED_SOFT_TTL_MS;
  const capacityAllowsEarlyReclaim =
    opts.capacityAllowsEarlyReclaim
    ?? deps.capacityAllowsEarlyReclaim
    ?? false;
  const ttlMs = effectiveProviderPausedTtlMs({
    ttlMs: hardTtlMs,
    softTtlMs,
    capacityAllowsEarlyReclaim,
  });
  const tasks = deps.taskStore.viewTasks();

  const getPauseStartedAtMs = deps.pauseStartTracker.observeAll(
    tasks,
    deps.isProviderPaused,
    nowMs,
  );

  const occupancy = summarizeProviderPausedOccupancy(tasks, {
    now,
    isProviderPaused: deps.isProviderPaused,
    getPauseStartedAtMs: (task) => getPauseStartedAtMs(task),
  });
  deps.metrics?.recordOccupancy(occupancy);
  deps.metrics?.recordHardTtlMs(hardTtlMs);
  deps.metrics?.recordSoftTtlPolicy({
    softTtlMs,
    capacityAllowsEarlyReclaim,
    effectiveTtlMs: ttlMs,
  });

  const lifecycleDeps = deps.lifecycleDeps;
  if (!lifecycleDeps) {
    return { reclaimedTaskIds: [], occupancy };
  }

  const getLastActivityAtMs = (task: Task): number | undefined => {
    const liveness = deps.getLiveness?.(task);
    if (!liveness) return undefined;
    const last = Math.max(
      liveness.lastHookEventAt,
      liveness.lastPaneChangeAt,
      liveness.lastTokenActivityAt,
    );
    return last > 0 ? last : undefined;
  };

  // Issue #3562: classify every paused task's reset each pass and latch a
  // known reset as soon as it is seen, so a later poller backoff — or the
  // window resetting and vanishing from the snapshot — cannot lose it.
  // Measured from the same effective (activity-advanced) pause start the
  // selector uses, so the 6h-fit filter and snapshot freshness agree with
  // `knownProviderResetHoldApplies`.
  const resetSource = readProviderResetSource(deps);
  const resetStates = new Map<string, ProviderResetState>();
  if (resetSource) {
    for (const task of tasks) {
      const latchedStartMs = getPauseStartedAtMs(task);
      if (latchedStartMs === undefined || !taskUsesClaudeQuota(task)) continue;
      if (isFirstPartyProviderPauseDetail(readProviderPauseDetail(deps, task))) {
        deps.pauseStartTracker.latchFirstPartyEvidence(task.id);
      }
      const fresh = classifyProviderResetState({
        source: resetSource,
        nowMs,
        pauseStartedAtMs: effectiveProviderPausedStartMs(
          latchedStartMs,
          getLastActivityAtMs(task),
        ),
      });
      if (fresh.kind === 'known') {
        deps.pauseStartTracker.latchKnownReset(task.id, fresh.resetsAtMs);
      }
      const latched = deps.pauseStartTracker.getKnownResetMs(task.id);
      let state: ProviderResetState = fresh;
      if (latched !== undefined) {
        if (nowMs < latched + PROVIDER_RESET_HOLD_GRACE_MS) {
          state = { kind: 'known', resetsAtMs: latched };
        } else if (fresh.kind === 'quota_healthy') {
          // Issue #3574: the window this pause waited on has reset, so a
          // healthy snapshot is expected now, not a sign the pause was false.
          // Past the grace the normal soft/hard TTL applies again (#3562).
          state = { kind: 'none' };
        }
      }
      if (
        state.kind === 'quota_healthy'
        && deps.pauseStartTracker.hasFirstPartyEvidence(task.id)
      ) {
        // Issue #4050: a billing, auth or quota stop_failure is the CLI's own
        // report that the account is blocked. The 5-hour and 7-day windows do
        // not show that, so a healthy snapshot does not contradict it.
        // Issue #4082: the same goes for a rate-limit stop_failure. If the
        // poller backed off for the whole pause, it never saw the exhausted
        // window, and its first healthy snapshot comes after the rollover.
        // Apply the normal soft/hard TTL instead of holding up to 6h.
        state = { kind: 'none' };
      }
      resetStates.set(task.id, state);
    }
  }

  const selection = selectExpiredProviderPausedTasks(tasks, {
    now,
    ttlMs: hardTtlMs,
    softTtlMs,
    capacityAllowsEarlyReclaim,
    isProviderPaused: deps.isProviderPaused,
    getPauseStartedAtMs: (task) => getPauseStartedAtMs(task),
    getLastActivityAtMs,
    isAwaitingProviderReset: (task) => {
      if (!deps.recordProviderPause) return false;
      // Production recordProviderPause returns holdForResume:true for tasks
      // with no issueClaim (hung reaper keeps holding forever — no resume to
      // schedule), so it cannot tell whether a reset is actually pending.
      // Only skip here when a real #1896 resume path can exist; unclaimed
      // tasks are held on a *known* reset via getProviderResetState (#3562).
      if (!task.issueClaim) return false;
      try {
        const decision = deps.recordProviderPause(task, 'provider_paused_ttl');
        return decision?.holdForResume === true;
      } catch (err) {
        // Fail-safe: if registration throws, hold rather than reclaim out
        // from under a possible auto-resume path (#1896).
        console.error(
          `[provider-paused-ttl] recordProviderPause failed for task ${task.id}:`,
          err,
        );
        return true;
      }
    },
    getProviderResetState: (task) => resetStates.get(task.id),
    isHoldingOpenPr: deps.isHoldingOpenPr,
  });

  deps.metrics?.recordSelection(selection);
  deps.metrics?.recordAttempted(selection.expired.length);

  const reclaimedTaskIds: string[] = [];
  let deliveredCount = 0;
  const terminated: Array<{
    task: Task;
    pausedForMs: number;
    storeMerged: MergedPrAttribution | null;
  }> = [];
  for (const { task, pausedForMs } of selection.expired) {
    // Read the in-memory attribution before terminating, as the hungSuspect
    // reclaim does. Label only — a billing hold never auto-completes.
    const storeMerged = readStoreDeliveredPr(task, deps.resolveMergedPr, '[provider-paused-ttl]');

    try {
      await terminateTask(task.id, lifecycleDeps, {
        reason: 'timeout',
        detail:
          `provider-paused-ttl: paused for ${Math.round(pausedForMs / 1000)}s `
          + `(threshold ${Math.round(ttlMs / 1000)}s`
          + (capacityAllowsEarlyReclaim && ttlMs < hardTtlMs ? ', soft/capacity' : '')
          + `)`,
      });
    } catch (err) {
      console.warn(
        `[provider-paused-ttl] could not reclaim task ${task.id}:`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }
    terminated.push({ task, pausedForMs, storeMerged });
  }

  // Branch-keyed fallback for the label (issue #3578): after every terminate,
  // concurrently, bounded — never delays another task's reclaim.
  const deliveredPrs = await Promise.all(
    terminated.map(({ task, storeMerged }) =>
      resolveReapDeliveredPr(task, storeMerged, deps.resolveMergedPrByBranch, {
        logPrefix: '[provider-paused-ttl]',
      })),
  );

  for (const [index, { task, pausedForMs }] of terminated.entries()) {
    const merged = deliveredPrs[index] ?? null;
    const disposition = buildProviderPausedTtlDisposition(now.toISOString(), merged);
    if (merged) deliveredCount += 1;
    deps.taskStore.setDisposition(task.id, disposition);
    deps.pauseStartTracker.clear(task.id);

    await writeProviderPausedDispositionEntry(task.id, pausedForMs, disposition, deps, now).catch(
      (err) => {
        console.error(
          `[provider-paused-ttl] failed to record disposition-ledger entry for task ${task.id}:`,
          err,
        );
      },
    );

    reclaimedTaskIds.push(task.id);
    console.warn(
      `[provider-paused-ttl] reclaimed task ${task.id} — provider_paused ${Math.round(pausedForMs / 60_000)}m`,
    );

    await appendAuditRow(deps.auditLogPath, {
      type: 'task.providerPausedTtlReclaimed',
      timestamp: nowISO(),
      actor: 'system:provider-paused-ttl',
      taskId: task.id,
      reason: 'provider_paused_ttl',
      pausedForMs,
      outcome: disposition.outcome ?? 'terminated',
      ...(disposition.deliveredPr ? { deliveredPr: disposition.deliveredPr } : {}),
      ttlMs,
    });
  }

  deps.metrics?.recordReclaimed(reclaimedTaskIds.length);

  // Recompute occupancy after reclaim so health reflects freed slots this tick.
  if (reclaimedTaskIds.length > 0) {
    const postTasks = deps.taskStore.viewTasks();
    const postOccupancy = summarizeProviderPausedOccupancy(postTasks, {
      now,
      isProviderPaused: deps.isProviderPaused,
      getPauseStartedAtMs: (task) => deps.pauseStartTracker.getPauseStartedAtMs(task.id),
    });
    deps.metrics?.recordOccupancy(postOccupancy);

    deps.broadcastToAll?.({
      type: 'alert',
      agentId: '',
      summary:
        `Reclaimed ${reclaimedTaskIds.length} provider_paused task(s) `
        + (capacityAllowsEarlyReclaim && ttlMs < hardTtlMs
          ? '(soft TTL / capacity)'
          : '(hard TTL)'),
      details:
        'These tasks were provider_paused (billing/quota) past the effective TTL '
        + `(${Math.round(ttlMs / 60_000)}m`
        + (capacityAllowsEarlyReclaim && ttlMs < hardTtlMs
          ? `; soft capacity-aware bound, hard ${Math.round(hardTtlMs / 60_000)}m`
          : '')
        + ') and were terminated to free active concurrency slots. None were auto-completed. '
        + (deliveredCount > 0
          ? `${deliveredCount} had already merged their PR (recorded delivered_then_hung); `
            + `${reclaimedTaskIds.length - deliveredCount} need human review. `
          : 'All need human review. ')
        + 'Review the disposition ledger.',
      severity: 'warning',
    });

    return {
      reclaimedTaskIds,
      occupancy: postOccupancy,
      selection: {
        candidatesConsidered: selection.candidatesConsidered,
        skips: selection.skips,
        selectedCount: selection.expired.length,
        outcomes: selection.outcomes,
      },
    };
  }

  return {
    reclaimedTaskIds,
    occupancy,
    selection: {
      candidatesConsidered: selection.candidatesConsidered,
      skips: selection.skips,
      selectedCount: selection.expired.length,
      outcomes: selection.outcomes,
    },
  };
}

function readProviderPauseDetail(
  deps: ReclaimProviderPausedTasksDeps,
  task: Task,
): string | undefined {
  if (!deps.getProviderPauseDetail) return undefined;
  try {
    return deps.getProviderPauseDetail(task);
  } catch (err) {
    // Fail toward today's behavior (#3574 hold) rather than abort the sweep.
    console.error(
      `[provider-paused-ttl] getProviderPauseDetail failed for task ${task.id}:`,
      err,
    );
    return undefined;
  }
}

function readProviderResetSource(
  deps: ReclaimProviderPausedTasksDeps,
): ProviderResetSource | undefined {
  if (!deps.getProviderResetSource) return undefined;
  try {
    return deps.getProviderResetSource();
  } catch (err) {
    // Fail toward holding: an unreadable poller is an unresolved reset.
    console.error('[provider-paused-ttl] getProviderResetSource failed:', err);
    return { quota: null, pollerState: 'backoff' };
  }
}

async function writeProviderPausedDispositionEntry(
  taskId: string,
  pausedForMs: number,
  taskDisposition: TaskDisposition,
  deps: ReclaimProviderPausedTasksDeps,
  now: Date,
): Promise<void> {
  if (!deps.dispositionLedgerPath) return;
  const pausedMinutes = Math.round(pausedForMs / 60_000);
  const entry: DispositionEntry = taskDisposition.deliveredPr
    ? {
        schemaVersion: 'disposition-ledger.v1',
        taskId,
        disposition: 'obsolete',
        detail:
          `obsolete-because: delivered PR #${taskDisposition.deliveredPr.number} before the `
          + `billing/quota hold; provider_paused TTL reclaim after ${pausedMinutes}m (not auto-completed)`,
        incidentId: providerPausedIncidentId(now),
        source: 'provider-paused-ttl',
        at: now.toISOString(),
      }
    : {
        schemaVersion: 'disposition-ledger.v1',
        taskId,
        disposition: 'needs-human',
        detail:
          `needs-human: provider_paused hard TTL reclaimed after ${pausedMinutes}m of billing/quota hold `
          + '(never auto-completed as delivered)',
        incidentId: providerPausedIncidentId(now),
        source: 'provider-paused-ttl',
        at: now.toISOString(),
      };
  await appendDispositionEntry(deps.dispositionLedgerPath, entry);
}

function providerPausedIncidentId(now: Date): string {
  return `provider-paused-ttl-${now.toISOString().slice(0, 10)}`;
}
