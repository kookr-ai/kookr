/**
 * Pipeline starvation refill (issue #1715).
 *
 * When a parallel-issue-batch run terminates with a machine-readable
 * `blocked-empty` outcome (#1714), this module decides whether to:
 *   1. Spawn an on-demand repository-idea-scout for that repo (queue refill), and/or
 *   2. Raise a pipeline-starvation operational alert (second consecutive empty
 *      within the alert window).
 *
 * Pure decision logic is exported for unit tests; durable state + spawn/alert
 * side effects live in the server service that calls {@link evaluatePipelineStarvationRefill}.
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { projectIdFromRepoSpecifier } from './project-identity.js';
import { isTerminalStatus } from './task-status.js';

/**
 * Baseline starvation-triggered scout cooldown (issue #1715). One scout per
 * repo per this window at the shallow end of a drought; the effective window
 * shrinks as the drought deepens — see {@link effectiveStarvationScoutCooldownMs}.
 */
export const STARVATION_SCOUT_DEDUP_MS = 4 * 60 * 60 * 1000; // 4h

/**
 * Hard floor for the adaptive starvation-scout cooldown (issue #2171). The
 * cooldown never shrinks below this, so the worst case is bounded (at most one
 * extra scout per repo per floor). Kept ≥ {@link SCOUT_ANTI_THRASH_MS} so the
 * belt-empty residual bypass floor never outlasts the cooldown floor.
 */
export const STARVATION_SCOUT_COOLDOWN_FLOOR_MS = 30 * 60 * 1000; // 30m

/**
 * Consecutive product blocked-empty events per cooldown halving (issue #2171).
 * The cooldown halves once per this many consecutive empties: baseline at 0–1,
 * ½ at 2–3, ¼ at 4–5, … down to the floor.
 */
export const STARVATION_SCOUT_COOLDOWN_HALVING_STEP = 2;

/**
 * Adaptive starvation-scout cooldown (issue #2171).
 *
 * The fixed 4h cooldown outlasted the drought: the idea belt emptied faster
 * than a 4h cooldown could refill it, so `consecutiveBlockedEmpty` climbed to
 * 6/8 while every refill attempt was skipped with "already spawned within last
 * 4h" — the cooldown defeated the very trigger it exists to serve. Shrink the
 * cooldown as the drought deepens: halve per
 * {@link STARVATION_SCOUT_COOLDOWN_HALVING_STEP} consecutive blocked-empty
 * events, with a hard {@link STARVATION_SCOUT_COOLDOWN_FLOOR_MS} floor so the
 * blast radius stays bounded.
 *
 * With the defaults (baseline 4h, step 2, floor 30m):
 *   consecutive 0–1 → 4h, 2–3 → 2h, 4–5 → 1h, 6–7 → 30m, 8+ → 30m (floor).
 */
export function effectiveStarvationScoutCooldownMs(
  consecutiveBlockedEmpty: number,
  opts?: { baselineMs?: number; floorMs?: number; halvingStep?: number },
): number {
  const baseline = opts?.baselineMs ?? STARVATION_SCOUT_DEDUP_MS;
  const floor = opts?.floorMs ?? STARVATION_SCOUT_COOLDOWN_FLOOR_MS;
  const step = opts?.halvingStep ?? STARVATION_SCOUT_COOLDOWN_HALVING_STEP;
  const consec =
    Number.isFinite(consecutiveBlockedEmpty) && consecutiveBlockedEmpty > 0
      ? Math.floor(consecutiveBlockedEmpty)
      : 0;
  // A non-positive step disables shrinking — never below the floor.
  if (step <= 0) return Math.max(baseline, floor);
  const halvings = Math.floor(consec / step);
  const shrunk = baseline / 2 ** halvings;
  return Math.max(floor, shrunk);
}

/** Human label for a cooldown window used in spawn-skip reasons ("4h", "30m"). */
function formatCooldownLabel(ms: number): string {
  if (ms > 0 && ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  return `${Math.round(ms / 60_000)}m`;
}

/**
 * "Successful ideation" lookback: if a scout completed for the repo inside
 * this window, do not re-trigger on-demand — **unless** capacity shows the
 * ideation left no implementable work (see {@link isIdeationSuccessEmptyQueue}).
 */
export const SUCCESSFUL_IDEATION_LOOKBACK_MS = STARVATION_SCOUT_DEDUP_MS;

/**
 * Free-slot floor for treating recent ideation as non-refilling (issue #2043).
 * Matches queue-feeder idle-capacity gate (`DEFAULT_FREE_SLOTS_THRESHOLD`).
 * When free ≥ this and pendingQueueDepth == 0, a 4h "successful ideation"
 * suppress must not block re-scout: batch kicks cannot create issues.
 *
 * Same floor for belt-empty residual scout-dedup bypass (#2068 / #2071):
 * free capacity + empty queue means the prior scout did not leave work.
 */
export const EMPTY_IDEATION_FREE_SLOTS_THRESHOLD = 3;

/**
 * Anti-thrash floor inside the nominal 4h scout-spawn window (issues #2068, #2071).
 * After a starvation scout completes, block immediate re-fire for this long even
 * when capacity shows belt empty — prevents double-spawn thrash. Once elapsed,
 * free≥{@link EMPTY_IDEATION_FREE_SLOTS_THRESHOLD} + pendingQueueDepth==0 may
 * bypass the remaining 4h gate so free slots are not wasted for hours.
 */
export const SCOUT_ANTI_THRASH_MS = 25 * 60 * 1000; // 25m

/**
 * Minimum consecutive product blocked-empty events (including current) required
 * for the refill postcondition bypass of the 4h scout-spawn gate (#2071).
 * Second empty after a recent scout is enough signal that leaves burned / belt
 * stayed empty.
 */
export const REFILL_POSTCONDITION_MIN_CONSECUTIVE = 2;

/** Second consecutive blocked-empty inside this window raises the alert. */
export const STARVATION_ALERT_WINDOW_MS = 12 * 60 * 60 * 1000; // 12h

/**
 * Per-repo cooldown between starvation-triggered batch kicks (RFC R5).
 * Prevents thrash when handle + scout-complete both fire close together.
 */
export const BATCH_KICK_COOLDOWN_MS = 30 * 60 * 1000; // 30m

/**
 * Max age of `kickBatchWhenScoutCompletes` before it is cleared without a kick
 * (scout never terminal, or stuck pending flag).
 */
export const KICK_BATCH_PENDING_TTL_MS = STARVATION_SCOUT_DEDUP_MS; // 4h

/** Schema version for durable per-repo state files. */
export const PIPELINE_STARVATION_STATE_SCHEMA = 1 as const;

/** Schema version for batch outcome records (shared with #1714 playbook). */
export const BATCH_OUTCOME_SCHEMA_VERSION = 1 as const;

export type BatchOutcomeKind = 'blocked-empty' | 'done' | 'blocked';

/**
 * Distinguishes concurrent-batch NO-OPs from product empty backlog (RFC
 * overnight-throughput PR2). Omitted on legacy writers → treated as product.
 * Concurrent empties must not inflate product starvation consecutive/spawn/alert.
 */
export type BatchEmptyClass = 'concurrent' | 'product';

export interface BatchOutcomeDisqualified {
  issue: number;
  title?: string;
  reason: string;
}

/**
 * Machine-readable batch outcome written to
 * `~/.kookr/playbook-state/parallel-issue-batch/<slug>/<runKey>/outcome.json`
 * by the parallel-issue-batch playbook (#1714).
 */
export interface BatchOutcomeRecord {
  schemaVersion: typeof BATCH_OUTCOME_SCHEMA_VERSION;
  outcome: BatchOutcomeKind;
  repo: string;
  runKey: string;
  headless?: boolean;
  provenance?: string;
  onAmbiguity?: string;
  reason?: string;
  openIssueCount?: number;
  disqualified?: BatchOutcomeDisqualified[];
  generatedAt: string;
  /** Optional absolute checkout path the batch used (helps spawn the scout). */
  localPath?: string;
  /**
   * Product vs concurrent empty (PR2). Legacy outcomes without this field are
   * classified via {@link resolveBatchEmptyClass} (reason/heuristic fallback).
   */
  emptyClass?: BatchEmptyClass;
}

export interface PipelineStarvationRepoState {
  schemaVersion: typeof PIPELINE_STARVATION_STATE_SCHEMA;
  repo: string;
  /** ISO timestamps of recent blocked-empty outcomes (newest last), pruned to alert window. */
  blockedEmptyAt: string[];
  /**
   * Batch runKeys already counted toward `blockedEmptyAt` (newest last).
   * Retries of the same outcome must not inflate consecutive count / false-alert.
   * Bounded to the same window as `blockedEmptyAt`.
   */
  handledRunKeys: string[];
  /** When we last spawned a starvation-triggered scout for this repo. */
  lastStarvationScoutAt?: string;
  /** Task id of the last starvation-triggered scout (audit / state.md). */
  lastStarvationScoutTaskId?: string;
  /** When we last emitted a pipeline-starvation alert for this repo. */
  lastStarvationAlertAt?: string;
  /**
   * Last spawn skip reason from handle (RFC overnight-throughput PR1).
   * Durable so /api/health can answer "why no scout?" without reading audit.jsonl.
   */
  lastSpawnSkipReason?: string;
  /** When lastSpawnSkipReason was written. */
  lastSpawnSkipAt?: string;
  /**
   * When we last capacity-gated kicked a parallel-issue-batch for this repo (PR4 / R5).
   * Used for kick cooldown; last result lives in audit, not a state forest.
   */
  lastBatchKickAt?: string;
  /**
   * When true, try batch kick when the starvation scout (or matching idea-scout)
   * completes. Armed when a starvation scout is spawned; cleared on terminal
   * success/failure + max-age TTL (PR4 / R5).
   */
  kickBatchWhenScoutCompletes?: boolean;
  /** When kickBatchWhenScoutCompletes was armed (for TTL). */
  kickBatchWhenScoutCompletesAt?: string;
  /**
   * Times we skipped a starvation scout because of the 4h/anti-thrash gate
   * while capacity already showed belt empty (free≥threshold + pending=0).
   * Surfaced on `/api/health` for L3/reflection (#2068).
   */
  scoutCooldownSkipsWhileBeltEmpty?: number;
  updatedAt: string;
}

/**
 * Result enum for `pipeline_starvation_batch_kick` audit rows (PR4 / R5).
 */
export type PipelineBatchKickResult =
  | 'batch_kicked'
  | 'batch_skipped_flag_off'
  | 'batch_skipped_concurrent'
  | 'batch_skipped_cooldown'
  | 'batch_kick_failed';

/**
 * Minimal capacity inputs for empty-queue ideation override (issue #2043).
 * Callers pass free + pending from the live capacity ledger.
 */
export interface PipelineStarvationCapacitySnapshot {
  free: number;
  pendingQueueDepth: number;
}

export interface PipelineStarvationContext {
  nowMs: number;
  /**
   * Timestamp (ms) of the most recent successful idea-scout completion for
   * this repo, or null if none in lookback / unknown.
   */
  recentSuccessfulIdeationAtMs: number | null;
  /** True when a scout for this repo is already running or queued. */
  scoutInFlight: boolean;
  /**
   * Prior durable state for the repo (may be empty). The current event is
   * NOT yet appended — the evaluator appends conceptually when counting.
   */
  prior: PipelineStarvationRepoState | null;
  /**
   * Live capacity snapshot (issue #2043). When free ≥ threshold and
   * pendingQueueDepth == 0, recent "successful ideation" does **not** suppress
   * re-scout — empty queue means the ideation did not leave implementable work.
   * Omitted/null keeps legacy thrash-prevention (honor 4h ideation suppress).
   */
  capacity?: PipelineStarvationCapacitySnapshot | null;
}

/**
 * Light starvation class for audit + spawn policy (RFC overnight-throughput PR3).
 * Not a full taxonomy — only what changes spawn behavior in the first ship.
 */
export type StarvationClass =
  | 'waiting_on_open_prs'
  | 'umbrella_only'
  | 'other';

/**
 * Follow-on action hint for handle/service (PR3 audit; PR4 batch kick).
 * - `idea_scout` — spawn on-demand idea-scout
 * - `cannot_refill` — policy terminal (e.g. all open PRs); do not thrash scouts
 * - `batch_kick_only` — recent eligible ideation exists; kick implement, not scout
 * - `none` — no product action
 */
export type StarvationFollowOnAction =
  | 'idea_scout'
  | 'cannot_refill'
  | 'batch_kick_only'
  | 'none';

export interface PipelineStarvationDecision {
  /**
   * Only true for **product** `blocked-empty`. Concurrent empties and non-empty
   * outcomes are not applicable (no ledger inflate / spawn / product alert).
   */
  applicable: boolean;
  /**
   * True when this exact outcome.runKey was already applied to the ledger.
   * Callers must skip side effects (no re-spawn attempt beyond normal dedup,
   * no re-alert, no ledger append) and return the prior state unchanged.
   */
  alreadyHandled: boolean;
  spawnScout: boolean;
  spawnSkipReason?: string;
  emitStarvationAlert: boolean;
  alertSkipReason?: string;
  /** Count of blocked-empty events in the alert window after including current. */
  consecutiveBlockedEmpty: number;
  /** ISO timestamps in the alert window after including current (newest last). */
  blockedEmptyAtAfter: string[];
  /** runKeys in the alert window after including current (newest last). */
  handledRunKeysAfter: string[];
  /** Resolved empty class for blocked-empty (audit / callers). */
  emptyClass?: BatchEmptyClass;
  /** Light product class (PR3) — audit + spawn suppress. */
  starvationClass?: StarvationClass;
  /** Derived follow-on for service/audit (PR3/PR4). */
  followOnAction?: StarvationFollowOnAction;
  /**
   * True when recent successful ideation was present but capacity shows empty
   * queue + idle free slots, so the 4h ideation suppress was overridden (#2043).
   * Surfaced on `pipeline_starvation_decision` audit as `ideationSuccessEmptyQueue`.
   */
  ideationSuccessEmptyQueue?: boolean;
  /**
   * True when the nominal 4h starvation-scout spawn gate was bypassed because
   * capacity shows belt empty after the anti-thrash floor (#2068 / #2071).
   */
  scoutDedupBypassedForBeltEmpty?: boolean;
  /**
   * True when we skipped spawn due to scout cooldown/anti-thrash while capacity
   * already showed free≥threshold + empty queue (#2068 observability).
   */
  scoutCooldownSkipWhileBeltEmpty?: boolean;
  /**
   * Refill postcondition outcome for this tick (#2071): whether idle capacity
   * + empty queue produced a scout emit *attempt* (pass) or was still blocked
   * (fail). Omitted when capacity is not idle-empty (not applicable).
   */
  starvationRefillPostcondition?: 'pass' | 'fail';
  /**
   * Effective starvation-scout cooldown applied this tick (issue #2171),
   * derived from {@link consecutiveBlockedEmpty}. Surfaced for audit/health so
   * an operator can see the cooldown adapting instead of a static 4h. Present
   * for every applicable, non-replay blocked-empty.
   */
  effectiveScoutCooldownMs?: number;
}

/**
 * Patterns from overnight concurrent-batch NO-OP outcomes (user-note guards /
 * sibling PIB supervisors). Used when `emptyClass` is omitted (legacy writers).
 */
const CONCURRENT_EMPTY_REASON_RE =
  /inProgress\s+Parallel\s+Issue\s+Batch|concurrent[- ]batch(?:\s+guard)?|sibling(?:\s+Parallel\s+Issue\s+Batch|\s+batch)|NO-OP:\s*another\s+inProgress|another\s+inProgress\s+Parallel\s+Issue\s+Batch/i;

/**
 * Resolve whether a blocked-empty is product starvation or a concurrent-batch
 * NO-OP. Explicit `emptyClass` wins; otherwise reason/disqualifier heuristics
 * detect concurrent so server-first hygiene works before playbook emit.
 */
export function resolveBatchEmptyClass(outcome: BatchOutcomeRecord): BatchEmptyClass | undefined {
  if (outcome.outcome !== 'blocked-empty') return undefined;
  if (outcome.emptyClass === 'concurrent' || outcome.emptyClass === 'product') {
    return outcome.emptyClass;
  }
  if (looksLikeConcurrentBatchEmpty(outcome)) return 'concurrent';
  return 'product';
}

/** True when reason/disqualifiers match overnight concurrent-batch NO-OP prose. */
export function looksLikeConcurrentBatchEmpty(outcome: BatchOutcomeRecord): boolean {
  if (outcome.reason && CONCURRENT_EMPTY_REASON_RE.test(outcome.reason)) return true;
  for (const row of outcome.disqualified ?? []) {
    if (row.reason && CONCURRENT_EMPTY_REASON_RE.test(row.reason)) return true;
    if (row.title && CONCURRENT_EMPTY_REASON_RE.test(row.title)) return true;
  }
  return false;
}

const OPEN_PR_DISQUALIFIER_RE = /already has open PR|open PR #|has open pull request/i;
const UMBRELLA_DISQUALIFIER_RE = /umbrella|tracking\/meta|label:umbrella|not a single-PR/i;

/**
 * Light starvation class from disqualifier histogram (PR3).
 * - waiting_on_open_prs: every itemized disqualifier is open-PR covered
 * - umbrella_only: every itemized disqualifier is umbrella/meta (no open-PR mix)
 * - other: mixed / empty / unknown
 */
export function classifyStarvationLight(outcome: BatchOutcomeRecord): StarvationClass {
  const rows = outcome.disqualified ?? [];
  if (rows.length === 0) return 'other';
  const allOpenPr = rows.every((r) => OPEN_PR_DISQUALIFIER_RE.test(r.reason || ''));
  if (allOpenPr) return 'waiting_on_open_prs';
  const allUmbrella = rows.every((r) => UMBRELLA_DISQUALIFIER_RE.test(r.reason || '')
    || UMBRELLA_DISQUALIFIER_RE.test(r.title || ''));
  if (allUmbrella) return 'umbrella_only';
  return 'other';
}

/** Default path for a batch run's outcome.json (runKey usually = task id). */
export function defaultParallelIssueBatchOutcomePath(
  repo: string,
  runKey: string,
  home = homedir(),
): string {
  return join(
    home,
    '.kookr',
    'playbook-state',
    'parallel-issue-batch',
    repoToPlaybookSlug(repo),
    runKey,
    'outcome.json',
  );
}

export function isParallelIssueBatchPlaybookId(playbookId: string | undefined): boolean {
  if (!playbookId) return false;
  const base = playbookId.replace(/\\/g, '/').split('/').pop() ?? playbookId;
  return base === 'parallel-issue-batch.md' || base === 'parallel-issue-batch';
}

/** True when playbookId looks like repository-idea-scout (starvation or scheduled). */
export function isIdeaScoutPlaybookId(playbookId: string | undefined): boolean {
  if (!playbookId) return false;
  const lower = playbookId.replace(/\\/g, '/').toLowerCase();
  const base = lower.split('/').pop() ?? lower;
  return (
    base === 'repository-idea-scout.md'
    || base === 'repository-idea-scout'
    || base.includes('idea-scout')
  );
}

/**
 * Feature flag for R5 batch re-entry. Default **off** (unset / `0` / `false`).
 * Enable with `KOOKR_PIPELINE_BATCH_KICK=1` (or `true` / `on` / `yes`).
 */
export function isPipelineBatchKickEnabled(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  const raw = env.KOOKR_PIPELINE_BATCH_KICK;
  if (raw === undefined || raw === null) return false;
  const v = String(raw).trim().toLowerCase();
  if (v === '' || v === '0' || v === 'false' || v === 'off' || v === 'no') return false;
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

/**
 * True when any non-terminal task is a parallel-issue-batch for the given repo
 * (playbookId + repoFullName / projectId / name+prompt fallback).
 * Shared concurrent single-flight for schedules and starvation kicks (R5).
 */
export function isParallelIssueBatchInFlightForRepo(
  repo: string,
  tasks: readonly {
    status: string;
    playbookId?: string;
    projectId?: string;
    name?: string;
    prompt?: string;
    playbookParameterValues?: Record<string, string>;
  }[],
): boolean {
  const projectId = projectIdFromRepoSpecifier(repo)?.toLowerCase() ?? null;
  const slug = repoToPlaybookSlug(repo);
  const repoLower = repo.trim().toLowerCase();

  for (const task of tasks) {
    if (isTerminalStatus(task.status as Parameters<typeof isTerminalStatus>[0])) continue;
    if (!isParallelIssueBatchPlaybookId(task.playbookId)) continue;

    const paramRepo = (
      task.playbookParameterValues?.repoFullName
      ?? task.playbookParameterValues?.repo
      ?? ''
    ).trim().toLowerCase();
    if (paramRepo && paramRepo === repoLower) return true;
    if (projectId && task.projectId?.toLowerCase() === projectId) return true;
    const hay = `${task.projectId ?? ''} ${task.name ?? ''} ${task.prompt ?? ''}`.toLowerCase();
    if (hay.includes(repoLower) || hay.includes(slug)) return true;
  }
  return false;
}

/**
 * Whether a pending scout-complete kick is still armed (flag true and within TTL).
 */
export function isKickBatchPendingArmed(
  state: PipelineStarvationRepoState | null | undefined,
  nowMs: number,
): boolean {
  if (!state?.kickBatchWhenScoutCompletes) return false;
  if (!state.kickBatchWhenScoutCompletesAt) return true;
  const armedMs = Date.parse(state.kickBatchWhenScoutCompletesAt);
  if (!Number.isFinite(armedMs)) return true;
  return nowMs - armedMs < KICK_BATCH_PENDING_TTL_MS;
}

/**
 * Open product-starvation episode: at least one blocked-empty still inside the
 * alert window (used for scout-complete re-entry after scheduled scouts).
 */
export function hasOpenStarvationEpisode(
  state: PipelineStarvationRepoState | null | undefined,
  nowMs: number,
): boolean {
  if (!state?.blockedEmptyAt?.length) return false;
  const windowStart = nowMs - STARVATION_ALERT_WINDOW_MS;
  for (let i = state.blockedEmptyAt.length - 1; i >= 0; i--) {
    const ms = Date.parse(state.blockedEmptyAt[i]!);
    if (Number.isFinite(ms) && ms >= windowStart) return true;
  }
  return false;
}

/** True when last batch kick is still inside the per-repo cooldown. */
export function isBatchKickInCooldown(
  state: PipelineStarvationRepoState | null | undefined,
  nowMs: number,
): boolean {
  if (!state?.lastBatchKickAt) return false;
  const lastMs = Date.parse(state.lastBatchKickAt);
  if (!Number.isFinite(lastMs)) return false;
  return nowMs - lastMs < BATCH_KICK_COOLDOWN_MS;
}

const REPO_FULL_NAME_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Normalize owner/repo → playbook-state directory slug
 * (`owner/repo` → `owner-repo`, dots → hyphens).
 */
export function repoToPlaybookSlug(repo: string): string {
  return repo.trim().toLowerCase().replace(/[/.]/g, '-');
}

export function isValidRepoFullName(repo: string): boolean {
  return REPO_FULL_NAME_RE.test(repo.trim());
}

/**
 * Compact disqualifier summary for alerts and audit rows — top N reasons by
 * count, e.g. `"already has open PR×12, label:blocked×5, other-author×7"`.
 */
export function summarizeDisqualifiers(
  disqualified: BatchOutcomeDisqualified[] | undefined,
  maxReasons = 6,
): string {
  if (!disqualified || disqualified.length === 0) return 'none itemized';
  const counts = new Map<string, number>();
  for (const row of disqualified) {
    const key = (row.reason || 'unspecified').trim() || 'unspecified';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const top = ranked.slice(0, maxReasons).map(([reason, n]) => `${reason}×${n}`);
  const extra = ranked.length - top.length;
  return extra > 0 ? `${top.join(', ')}, +${extra} more` : top.join(', ');
}

/**
 * True when capacity shows idle free slots and an empty pending queue —
 * recent ideation did not leave implementable work (issue #2043).
 * Missing capacity snapshot → false (preserve 4h suppress).
 *
 * Also the belt-empty residual signal for scout-spawn cooldown bypass
 * (#2068 / #2071): free slots + empty queue means the belt has no work.
 */
export function isIdeationSuccessEmptyQueue(
  capacity: PipelineStarvationCapacitySnapshot | null | undefined,
  opts?: { freeSlotsThreshold?: number },
): boolean {
  if (!capacity) return false;
  const free = capacity.free;
  const pending = capacity.pendingQueueDepth;
  if (!Number.isFinite(free) || !Number.isFinite(pending)) return false;
  if (pending < 0 || free < 0) return false;
  const threshold = opts?.freeSlotsThreshold ?? EMPTY_IDEATION_FREE_SLOTS_THRESHOLD;
  return free >= threshold && pending === 0;
}

/**
 * Whether the 4h starvation-scout spawn gate may be bypassed for belt-empty
 * residual (#2068) / refill postcondition (#2071).
 *
 * Requires:
 *   - capacity free ≥ threshold and pendingQueueDepth == 0
 *   - anti-thrash floor elapsed since last starvation scout spawn
 *   - consecutive product blocked-empty (incl. current) ≥ min consecutive
 *
 * Missing capacity or lastScoutMs → false (preserve 4h gate).
 */
export function isScoutDedupBeltEmptyBypass(
  capacity: PipelineStarvationCapacitySnapshot | null | undefined,
  opts: {
    nowMs: number;
    lastStarvationScoutAtMs: number | null;
    consecutiveBlockedEmpty: number;
    freeSlotsThreshold?: number;
    antiThrashMs?: number;
    minConsecutive?: number;
  },
): boolean {
  if (!isIdeationSuccessEmptyQueue(capacity, {
    freeSlotsThreshold: opts.freeSlotsThreshold,
  })) {
    return false;
  }
  const lastMs = opts.lastStarvationScoutAtMs;
  if (lastMs === null || !Number.isFinite(lastMs)) return false;
  const antiThrash = opts.antiThrashMs ?? SCOUT_ANTI_THRASH_MS;
  if (opts.nowMs - lastMs < antiThrash) return false;
  const minConsec = opts.minConsecutive ?? REFILL_POSTCONDITION_MIN_CONSECUTIVE;
  if (opts.consecutiveBlockedEmpty < minConsec) return false;
  return true;
}

/**
 * Pure decision function — no I/O. See issue #1715 acceptance criteria and
 * RFC overnight-throughput closed loop (PR1 lookback semantics live in
 * {@link findRecentSuccessfulIdeationAtMs}: requires issue-created ≥1).
 *
 * Spawn when:
 *   - outcome is blocked-empty, AND
 *   - no scout currently running/queued for the repo, AND
 *   - no successful ideation (with published issues) in the last 4h
 *     **unless** capacity is idle+empty-queue (issue #2043 — empty-queue
 *     ideation is not a refill), AND
 *   - no starvation-triggered scout inside the **adaptive** cooldown window
 *     (issue #2171 — {@link effectiveStarvationScoutCooldownMs}: baseline 4h,
 *     halving as consecutiveBlockedEmpty grows, floored)
 *     **unless** capacity is still idle+empty after the anti-thrash floor
 *     (issues #2068 / #2071 — scout-spawned is not belt-refilled).
 *
 * Alert when:
 *   - this is at least the second blocked-empty for the repo inside 12h
 *     (first does not alert).
 */
export function evaluatePipelineStarvationRefill(
  outcome: BatchOutcomeRecord,
  ctx: PipelineStarvationContext,
): PipelineStarvationDecision {
  if (outcome.outcome !== 'blocked-empty') {
    return {
      applicable: false,
      alreadyHandled: false,
      spawnScout: false,
      spawnSkipReason: `outcome is ${outcome.outcome}, not blocked-empty`,
      emitStarvationAlert: false,
      alertSkipReason: 'not applicable',
      consecutiveBlockedEmpty: 0,
      blockedEmptyAtAfter: ctx.prior?.blockedEmptyAt ?? [],
      handledRunKeysAfter: ctx.prior?.handledRunKeys ?? [],
    };
  }

  const nowMs = ctx.nowMs;
  const currentIso = new Date(nowMs).toISOString();
  const alertWindowStart = nowMs - STARVATION_ALERT_WINDOW_MS;

  const priorTimes = (ctx.prior?.blockedEmptyAt ?? [])
    .map((iso) => ({ iso, ms: Date.parse(iso) }))
    .filter((row) => Number.isFinite(row.ms) && row.ms >= alertWindowStart)
    .map((row) => row.iso);

  // Keep runKeys aligned with the pruned timestamp window. Older keys outside
  // the window are dropped so the list cannot grow unbounded.
  const priorKeys = (ctx.prior?.handledRunKeys ?? []).filter((key) => typeof key === 'string' && key.length > 0);
  // When counts diverge (legacy state without handledRunKeys), prefer the
  // longer of the two after window pruning — timestamps still drive consecutive.
  const alignedKeys = priorKeys.slice(-priorTimes.length);

  const emptyClass = resolveBatchEmptyClass(outcome) ?? 'product';

  // Concurrent-batch NO-OPs are not product starvation (PR2). Do not inflate
  // consecutive count, spawn scout, or fire product alert — even when the
  // outcome kind is still `blocked-empty` (legacy playbook shape).
  if (emptyClass === 'concurrent') {
    return {
      applicable: false,
      alreadyHandled: false,
      spawnScout: false,
      spawnSkipReason: 'emptyClass=concurrent — not product starvation',
      emitStarvationAlert: false,
      alertSkipReason: 'concurrent batch NO-OP — not product starvation',
      consecutiveBlockedEmpty: priorTimes.length,
      blockedEmptyAtAfter: priorTimes,
      handledRunKeysAfter: priorKeys,
      emptyClass,
    };
  }

  if (alignedKeys.includes(outcome.runKey) || priorKeys.includes(outcome.runKey)) {
    return {
      applicable: true,
      alreadyHandled: true,
      spawnScout: false,
      spawnSkipReason: `runKey ${outcome.runKey} already handled (idempotent replay)`,
      emitStarvationAlert: false,
      alertSkipReason: 'runKey already handled — no re-alert on replay',
      consecutiveBlockedEmpty: priorTimes.length,
      blockedEmptyAtAfter: priorTimes,
      handledRunKeysAfter: priorKeys,
      emptyClass,
    };
  }

  const blockedEmptyAtAfter = [...priorTimes, currentIso];
  const handledRunKeysAfter = [...priorKeys, outcome.runKey].slice(-blockedEmptyAtAfter.length);
  const consecutiveBlockedEmpty = blockedEmptyAtAfter.length;

  const starvationClass = classifyStarvationLight(outcome);

  // Adaptive scout cooldown (issue #2171): shrinks with the drought depth so a
  // fixed 4h window cannot outlast an emptying belt. Computed here so it is
  // available to the gate below and surfaced on the decision for audit/health.
  const effectiveScoutCooldownMs = effectiveStarvationScoutCooldownMs(consecutiveBlockedEmpty);

  // --- spawn decision ---
  let spawnScout = true;
  let spawnSkipReason: string | undefined;
  let followOnAction: StarvationFollowOnAction = 'idea_scout';
  // True only when the belt-empty residual bypass (#2068/#2071) actually fired,
  // i.e. we spawned despite still being inside the effective cooldown window.
  let beltEmptyBypassApplied = false;

  const recentIdeation =
    ctx.recentSuccessfulIdeationAtMs !== null
    && nowMs - ctx.recentSuccessfulIdeationAtMs < SUCCESSFUL_IDEATION_LOOKBACK_MS;
  // Issue #2043: treat ideation as a refill only when the queue still has work
  // or capacity is busy. Idle free slots + empty queue after "success" means
  // batch_kick_only would thrash with no implementable leaves — re-open scout.
  const ideationSuccessEmptyQueue = recentIdeation && isIdeationSuccessEmptyQueue(ctx.capacity);

  // PR3: all open-PR covered → cannot_refill (no thrash scouts).
  if (starvationClass === 'waiting_on_open_prs') {
    spawnScout = false;
    spawnSkipReason = 'starvationClass=waiting_on_open_prs — all itemized issues already have open PRs';
    followOnAction = 'cannot_refill';
  } else if (ctx.scoutInFlight) {
    spawnScout = false;
    spawnSkipReason = 'scout already running or queued for this repo';
    followOnAction = 'none';
  } else if (recentIdeation && !ideationSuccessEmptyQueue) {
    spawnScout = false;
    spawnSkipReason = `successful ideation within last ${Math.round(SUCCESSFUL_IDEATION_LOOKBACK_MS / 3_600_000)}h`;
    // PR4: kick implement instead of re-scouting when supply already exists.
    followOnAction = 'batch_kick_only';
  } else {
    // Adaptive starvation-scout dedup (#2171): the cooldown shrinks as
    // consecutiveBlockedEmpty grows, so a deepening drought is refilled sooner
    // instead of being blocked by a static 4h window. Belt-empty residual
    // bypass (#2068 / #2071) still lets an idle+empty belt re-scout even inside
    // the (now shorter) cooldown once the anti-thrash floor elapses.
    const lastScoutMs = ctx.prior?.lastStarvationScoutAt
      ? Date.parse(ctx.prior.lastStarvationScoutAt)
      : NaN;
    if (Number.isFinite(lastScoutMs) && nowMs - lastScoutMs < effectiveScoutCooldownMs) {
      const beltEmptyBypass = isScoutDedupBeltEmptyBypass(ctx.capacity, {
        nowMs,
        lastStarvationScoutAtMs: lastScoutMs,
        consecutiveBlockedEmpty,
      });
      if (beltEmptyBypass) {
        // Keep spawnScout=true; mark bypass for audit/health.
        beltEmptyBypassApplied = true;
        followOnAction = 'idea_scout';
      } else {
        spawnScout = false;
        spawnSkipReason =
          `starvation-triggered scout already spawned within last `
          + `${formatCooldownLabel(effectiveScoutCooldownMs)} `
          + `(adaptive cooldown, consecutiveBlockedEmpty=${consecutiveBlockedEmpty})`;
        followOnAction = 'none';
      }
    }
  }

  // --- alert decision ---
  // Policy cannot_refill (waiting_on_open_prs): still ledger the empty, but do not
  // fire warning-level product starvation alert (info path left to recovered/ops).
  let emitStarvationAlert = consecutiveBlockedEmpty >= 2
    && starvationClass !== 'waiting_on_open_prs';
  let alertSkipReason: string | undefined;
  if (starvationClass === 'waiting_on_open_prs') {
    alertSkipReason = 'waiting_on_open_prs — policy terminal, no product starvation warning';
  } else if (!emitStarvationAlert) {
    alertSkipReason = consecutiveBlockedEmpty === 1
      ? 'first blocked-empty in window — alert deferred until second consecutive'
      : 'no blocked-empty events in window';
  } else if (ctx.prior?.lastStarvationAlertAt) {
    // Edge-trigger within an episode: if we already alerted for a prior event
    // still inside the window, do not re-fire on every subsequent empty.
    // A new episode starts after the window rolls past the last alert.
    const lastAlertMs = Date.parse(ctx.prior.lastStarvationAlertAt);
    if (Number.isFinite(lastAlertMs) && lastAlertMs >= alertWindowStart) {
      emitStarvationAlert = false;
      alertSkipReason = 'pipeline-starvation alert already emitted for this episode';
    }
  }

  const beltEmptyCapacity = isIdeationSuccessEmptyQueue(ctx.capacity);
  // The residual bypass counter tracks only the case where we spawned *despite*
  // still being inside the (adaptive) cooldown — a normal spawn after the
  // cooldown elapsed is not a bypass, even with the belt empty (#2171).
  const scoutDedupBypassedForBeltEmpty = spawnScout && beltEmptyBypassApplied;
  // Cooldown residual while belt empty: skipped for cooldown/anti-thrash (not other reasons).
  const scoutCooldownSkipWhileBeltEmpty =
    !spawnScout
    && beltEmptyCapacity
    && typeof spawnSkipReason === 'string'
    && /already spawned within last/i.test(spawnSkipReason);
  // #2071: when capacity is idle+empty, did this tick produce a refill attempt?
  const starvationRefillPostcondition: 'pass' | 'fail' | undefined = beltEmptyCapacity
    ? (spawnScout ? 'pass' : 'fail')
    : undefined;

  return {
    applicable: true,
    alreadyHandled: false,
    spawnScout,
    spawnSkipReason,
    emitStarvationAlert,
    alertSkipReason,
    consecutiveBlockedEmpty,
    blockedEmptyAtAfter,
    handledRunKeysAfter,
    emptyClass,
    starvationClass,
    followOnAction: spawnScout ? 'idea_scout' : followOnAction,
    effectiveScoutCooldownMs,
    ...(ideationSuccessEmptyQueue ? { ideationSuccessEmptyQueue: true } : {}),
    ...(scoutDedupBypassedForBeltEmpty ? { scoutDedupBypassedForBeltEmpty: true } : {}),
    ...(scoutCooldownSkipWhileBeltEmpty ? { scoutCooldownSkipWhileBeltEmpty: true } : {}),
    ...(starvationRefillPostcondition ? { starvationRefillPostcondition } : {}),
  };
}

/**
 * Apply a decision onto prior state, producing the next durable record.
 * Callers persist this after successful side effects (or always, for the
 * blocked-empty ledger itself — the ledger is written even when spawn is skipped).
 */
export function nextPipelineStarvationState(
  repo: string,
  prior: PipelineStarvationRepoState | null,
  decision: PipelineStarvationDecision,
  opts: {
    nowMs: number;
    spawnedTaskId?: string;
    alertEmitted?: boolean;
    /** True when a batch was successfully kicked in this handle (PR4). */
    batchKicked?: boolean;
  },
): PipelineStarvationRepoState {
  const nowIso = new Date(opts.nowMs).toISOString();
  const priorCooldownSkips = prior?.scoutCooldownSkipsWhileBeltEmpty ?? 0;
  const next: PipelineStarvationRepoState = {
    schemaVersion: PIPELINE_STARVATION_STATE_SCHEMA,
    repo,
    blockedEmptyAt: decision.blockedEmptyAtAfter,
    handledRunKeys: decision.handledRunKeysAfter,
    lastStarvationScoutAt: prior?.lastStarvationScoutAt,
    lastStarvationScoutTaskId: prior?.lastStarvationScoutTaskId,
    lastStarvationAlertAt: prior?.lastStarvationAlertAt,
    lastBatchKickAt: prior?.lastBatchKickAt,
    kickBatchWhenScoutCompletes: prior?.kickBatchWhenScoutCompletes,
    kickBatchWhenScoutCompletesAt: prior?.kickBatchWhenScoutCompletesAt,
    scoutCooldownSkipsWhileBeltEmpty: priorCooldownSkips > 0 ? priorCooldownSkips : undefined,
    updatedAt: nowIso,
  };
  if (opts.spawnedTaskId) {
    next.lastStarvationScoutAt = nowIso;
    next.lastStarvationScoutTaskId = opts.spawnedTaskId;
    // Clear skip reason when we successfully spawn.
    next.lastSpawnSkipReason = undefined;
    next.lastSpawnSkipAt = undefined;
    // Arm scout-complete batch kick (PR4 / R5).
    next.kickBatchWhenScoutCompletes = true;
    next.kickBatchWhenScoutCompletesAt = nowIso;
  } else if (decision.spawnSkipReason && decision.applicable && !decision.alreadyHandled) {
    next.lastSpawnSkipReason = decision.spawnSkipReason;
    next.lastSpawnSkipAt = nowIso;
  } else {
    next.lastSpawnSkipReason = prior?.lastSpawnSkipReason;
    next.lastSpawnSkipAt = prior?.lastSpawnSkipAt;
  }
  // #2068: durable residual counter for L3/health when cooldown blocks belt-empty.
  if (decision.scoutCooldownSkipWhileBeltEmpty && decision.applicable && !decision.alreadyHandled) {
    next.scoutCooldownSkipsWhileBeltEmpty = priorCooldownSkips + 1;
  }
  if (opts.batchKicked) {
    next.lastBatchKickAt = nowIso;
    // Handle-time kick already re-entered implement — clear pending scout flag.
    next.kickBatchWhenScoutCompletes = undefined;
    next.kickBatchWhenScoutCompletesAt = undefined;
  }
  if (opts.alertEmitted) {
    next.lastStarvationAlertAt = nowIso;
  }
  return next;
}

/**
 * Clear pending scout-complete kick flag (and optionally stamp lastBatchKickAt).
 * Used by scout-terminal path on success/failure/TTL expiry.
 */
export function clearKickBatchPending(
  state: PipelineStarvationRepoState,
  opts: { nowMs: number; batchKicked?: boolean },
): PipelineStarvationRepoState {
  const nowIso = new Date(opts.nowMs).toISOString();
  return {
    ...state,
    kickBatchWhenScoutCompletes: undefined,
    kickBatchWhenScoutCompletesAt: undefined,
    lastBatchKickAt: opts.batchKicked ? nowIso : state.lastBatchKickAt,
    updatedAt: nowIso,
  };
}

/** Idempotency key for starvation-triggered batch kicks (per-repo cooldown bucket). */
export function starvationBatchKickIdempotencyKey(repo: string, nowMs: number): string {
  const bucket = Math.floor(nowMs / BATCH_KICK_COOLDOWN_MS);
  return `starvation-batch-kick:${repoToPlaybookSlug(repo)}:${bucket}`;
}

/** Default durable state root under the user-scoped playbook-state tree. */
export function defaultPipelineStarvationStateDir(home = homedir()): string {
  return join(home, '.kookr', 'playbook-state', 'pipeline-starvation');
}

export function pipelineStarvationStatePath(stateDir: string, repo: string): string {
  return join(stateDir, `${repoToPlaybookSlug(repo)}.json`);
}

/** Default idea-scout state root for a repo. */
export function defaultIdeaScoutRepoStateDir(repo: string, home = homedir()): string {
  return join(home, '.kookr', 'playbook-state', 'repository-idea-scout', repoToPlaybookSlug(repo));
}

/**
 * Parse a batch outcome record from unknown JSON. Returns null when the
 * payload is not a usable outcome (wrong shape / missing required fields).
 */
export function parseBatchOutcomeRecord(raw: unknown): BatchOutcomeRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.schemaVersion !== BATCH_OUTCOME_SCHEMA_VERSION) return null;
  if (o.outcome !== 'blocked-empty' && o.outcome !== 'done' && o.outcome !== 'blocked') return null;
  if (typeof o.repo !== 'string' || !isValidRepoFullName(o.repo)) return null;
  if (typeof o.runKey !== 'string' || o.runKey.length === 0) return null;
  if (typeof o.generatedAt !== 'string' || !Number.isFinite(Date.parse(o.generatedAt))) return null;

  const disqualified = Array.isArray(o.disqualified)
    ? o.disqualified
      .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
      .map((row) => ({
        issue: typeof row.issue === 'number' ? row.issue : Number(row.issue),
        title: typeof row.title === 'string' ? row.title : undefined,
        reason: typeof row.reason === 'string' ? row.reason : 'unspecified',
      }))
      .filter((row) => Number.isFinite(row.issue))
    : undefined;

  const emptyClass =
    o.emptyClass === 'concurrent' || o.emptyClass === 'product'
      ? o.emptyClass
      : undefined;

  return {
    schemaVersion: BATCH_OUTCOME_SCHEMA_VERSION,
    outcome: o.outcome,
    repo: o.repo.trim(),
    runKey: o.runKey,
    headless: typeof o.headless === 'boolean' ? o.headless : undefined,
    provenance: typeof o.provenance === 'string' ? o.provenance : undefined,
    onAmbiguity: typeof o.onAmbiguity === 'string' ? o.onAmbiguity : undefined,
    reason: typeof o.reason === 'string' ? o.reason : undefined,
    openIssueCount: typeof o.openIssueCount === 'number' ? o.openIssueCount : undefined,
    disqualified,
    generatedAt: o.generatedAt,
    localPath: typeof o.localPath === 'string' ? o.localPath : undefined,
    emptyClass,
  };
}

export function emptyPipelineStarvationState(repo: string, nowMs: number): PipelineStarvationRepoState {
  return {
    schemaVersion: PIPELINE_STARVATION_STATE_SCHEMA,
    repo,
    blockedEmptyAt: [],
    handledRunKeys: [],
    updatedAt: new Date(nowMs).toISOString(),
  };
}

/**
 * Guess a local checkout path for owner/repo. Matches the idea-scout playbook's
 * default of `~/git/<owner-repo>` (slash → hyphen), not bare `~/git/<repo>`.
 */
export function defaultCheckoutGuess(repo: string, home = homedir()): string {
  return join(home, 'git', repoToPlaybookSlug(repo));
}

/**
 * Idempotency key bucket for starvation-triggered scouts — one key per repo
 * per anti-thrash window so true double-fires collapse, while a deliberate
 * belt-empty residual re-scout after {@link SCOUT_ANTI_THRASH_MS} (#2068 /
 * #2071) gets a distinct key and is not replayed as the prior terminal scout.
 *
 * Must stay aligned with the decision thrash floor: a 4h-stable key would
 * defeat the in-window bypass via launch-path idempotentReplay.
 */
export function starvationScoutIdempotencyKey(repo: string, nowMs: number): string {
  const bucket = Math.floor(nowMs / SCOUT_ANTI_THRASH_MS);
  return `starvation-scout:${repoToPlaybookSlug(repo)}:${bucket}`;
}
