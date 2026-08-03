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

/** Max one starvation-triggered scout per repo per this window. */
export const STARVATION_SCOUT_DEDUP_MS = 4 * 60 * 60 * 1000; // 4h

/**
 * "Successful ideation" lookback: if a scout completed for the repo inside
 * this window, do not re-trigger on-demand.
 */
export const SUCCESSFUL_IDEATION_LOOKBACK_MS = STARVATION_SCOUT_DEDUP_MS;

/** Second consecutive blocked-empty inside this window raises the alert. */
export const STARVATION_ALERT_WINDOW_MS = 12 * 60 * 60 * 1000; // 12h

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
  updatedAt: string;
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
}

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
 * Pure decision function — no I/O. See issue #1715 acceptance criteria and
 * RFC overnight-throughput closed loop (PR1 lookback semantics live in
 * {@link findRecentSuccessfulIdeationAtMs}: requires issue-created ≥1).
 *
 * Spawn when:
 *   - outcome is blocked-empty, AND
 *   - no scout currently running/queued for the repo, AND
 *   - no successful ideation (with published issues) in the last 4h, AND
 *   - no starvation-triggered scout in the last 4h.
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

  // --- spawn decision ---
  let spawnScout = true;
  let spawnSkipReason: string | undefined;

  if (ctx.scoutInFlight) {
    spawnScout = false;
    spawnSkipReason = 'scout already running or queued for this repo';
  } else if (
    ctx.recentSuccessfulIdeationAtMs !== null
    && nowMs - ctx.recentSuccessfulIdeationAtMs < SUCCESSFUL_IDEATION_LOOKBACK_MS
  ) {
    spawnScout = false;
    spawnSkipReason = `successful ideation within last ${Math.round(SUCCESSFUL_IDEATION_LOOKBACK_MS / 3_600_000)}h`;
  } else {
    const lastScoutMs = ctx.prior?.lastStarvationScoutAt
      ? Date.parse(ctx.prior.lastStarvationScoutAt)
      : NaN;
    if (Number.isFinite(lastScoutMs) && nowMs - lastScoutMs < STARVATION_SCOUT_DEDUP_MS) {
      spawnScout = false;
      spawnSkipReason = `starvation-triggered scout already spawned within last ${Math.round(STARVATION_SCOUT_DEDUP_MS / 3_600_000)}h`;
    }
  }

  // --- alert decision ---
  let emitStarvationAlert = consecutiveBlockedEmpty >= 2;
  let alertSkipReason: string | undefined;
  if (!emitStarvationAlert) {
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
  },
): PipelineStarvationRepoState {
  const nowIso = new Date(opts.nowMs).toISOString();
  const next: PipelineStarvationRepoState = {
    schemaVersion: PIPELINE_STARVATION_STATE_SCHEMA,
    repo,
    blockedEmptyAt: decision.blockedEmptyAtAfter,
    handledRunKeys: decision.handledRunKeysAfter,
    lastStarvationScoutAt: prior?.lastStarvationScoutAt,
    lastStarvationScoutTaskId: prior?.lastStarvationScoutTaskId,
    lastStarvationAlertAt: prior?.lastStarvationAlertAt,
    updatedAt: nowIso,
  };
  if (opts.spawnedTaskId) {
    next.lastStarvationScoutAt = nowIso;
    next.lastStarvationScoutTaskId = opts.spawnedTaskId;
    // Clear skip reason when we successfully spawn.
    next.lastSpawnSkipReason = undefined;
    next.lastSpawnSkipAt = undefined;
  } else if (decision.spawnSkipReason && decision.applicable && !decision.alreadyHandled) {
    next.lastSpawnSkipReason = decision.spawnSkipReason;
    next.lastSpawnSkipAt = nowIso;
  } else {
    next.lastSpawnSkipReason = prior?.lastSpawnSkipReason;
    next.lastSpawnSkipAt = prior?.lastSpawnSkipAt;
  }
  if (opts.alertEmitted) {
    next.lastStarvationAlertAt = nowIso;
  }
  return next;
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
 * per 4h wall-clock bucket so retries of the same logical trigger do not
 * create a second scout.
 */
export function starvationScoutIdempotencyKey(repo: string, nowMs: number): string {
  const bucket = Math.floor(nowMs / STARVATION_SCOUT_DEDUP_MS);
  return `starvation-scout:${repoToPlaybookSlug(repo)}:${bucket}`;
}
