import { randomUUID } from 'node:crypto';
import { open, readFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentSelection } from './agent-types.js';
import { DEFAULT_AGENT_TYPE, normalizeAgentSelection } from './agent-types.js';
import { isValidCron, nextRun, describeCron } from './cron.js';
import type { PlaybookScope } from './playbook.js';
import type { TokenUsage } from './usage-types.js';
import type { LaunchPhaseTimings } from './launch-phase-timings.js';
import { ScheduleRollupStore, type ScheduleRollup } from './schedule-rollup.js';

export interface SchedulePlaybook {
  path: string;
  parameters: Record<string, string>;
  /**
   * Pinned tier the playbook is resolved from (`project` | `user` | `plugin`).
   * Optional and additive: a schedule with no `scope` (un-migrated legacy)
   * resolves from the project tier only, exactly as before. See
   * rfc-schedule-playbook-resolution R2/R3.
   */
  scope?: PlaybookScope;
}

export type ScheduleStopReason = 'trigger_limit_reached';
export type ScheduleExecutionTrigger = 'cron' | 'manual';
export type ScheduleExecutionDecision = 'cron_due' | 'manual_run' | 'catch_up' | 'manual_catch_up' | 'stale_catch_up';
export type ScheduleExecutionOutcome =
  /**
   * @deprecated No longer produced (issue #1526 Phase A) — a capacity-queued
   * fire now records {@link queued_capacity} instead, which carries the same
   * meaning plus an explicit reason. Kept in the type only so historical
   * ledger rows persisted before this change still deserialize/render.
   */
  | 'queued'
  /**
   * A schedule fire went through the normal task-submission path and landed
   * as a pending task because the node was at capacity (issue #1526 Phase A
   * / FM8). It queues instead of being dropped — the scheduler's promotion
   * loop launches it once a slot frees.
   */
  | 'queued_capacity'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'deduplicated'
  | 'dispatch_failed'
  | 'skipped_active'
  /**
   * @deprecated No longer produced (issue #1526 Phase A) — a capacity fire
   * now goes through the launcher and records `queued_capacity` instead of
   * being dropped. Kept in the type only for historical ledger rows.
   */
  | 'skipped_capacity'
  | 'skipped_draining'
  | 'skipped_manual'
  | 'skipped_stale'
  /**
   * Coalesced (issue #1526 Phase A): the previous fire's task is still
   * `pending` (queued_capacity, not yet launched). Distinct from
   * `skipped_active` (previous run actively running) so at most one
   * outstanding queued fire per schedule ever exists — a second fire is
   * skipped rather than stacking another pending task behind the first.
   */
  | 'skipped_coalesced'
  | 'unknown_after_restart';

export type ScheduleExecutionReasonCode =
  | 'none'
  | 'capacity'
  | 'draining'
  | 'previous_run_active'
  /** Reason code for {@link ScheduleExecutionOutcome.skipped_coalesced}. */
  | 'previous_run_pending'
  | 'manual_catch_up_required'
  | 'missing_cwd'
  | 'missing_playbook'
  | 'validation'
  | 'deduplicated'
  | 'launch_error'
  /**
   * Reason code for a `dispatch_failed` fire rejected by the pending-queue
   * depth limit (issue #1526 Phase C / C3): the node was at capacity AND the
   * pending queue already held `maxPendingTasks` tasks, so queueing the fire
   * was refused. Distinct from generic `launch_error` so schedule ledgers
   * (and the dead-man switch's operator) can see backpressure, not a broken
   * launcher.
   */
  | 'pending_queue_full'
  | 'stale_catch_up'
  | 'reconciled_after_restart'
  | 'unknown_after_restart';

export interface ScheduleExecutionLedgerEntry {
  id: string;
  scheduleId: string;
  receiptId?: string;
  executionToken?: string;
  trigger: ScheduleExecutionTrigger;
  decision: ScheduleExecutionDecision;
  scheduledFor?: string;
  evaluatedAt: string;
  completedAt?: string;
  taskId?: string;
  blockingTaskId?: string;
  outcome: ScheduleExecutionOutcome;
  reasonCode?: ScheduleExecutionReasonCode;
  message?: string;
  /**
   * Cost/token closeout joined from the fire's task at ledger-write time
   * (issue #1582), so schedule ROI is readable straight off the ledger.
   * Absent when the task carried no `tokenUsage` (e.g. `dispatch_failed`, or a
   * task whose transcript never yielded usage) — never a fabricated zero, so a
   * missing field means "not measured", not "$0 spent".
   */
  tokenUsage?: TokenUsage;
  /**
   * Links to artifacts the fire produced — PR URLs today, extensible to issue
   * URLs / receipt paths — joined from the task's completion digest at
   * ledger-write time (issue #1582). Absent/empty when the task recorded none.
   */
  artifacts?: string[];
  /**
   * Per-phase launch timings for a `dispatch_failed` fire (issue #1589), so a
   * failed launch is diagnosable straight from the ledger without server logs:
   * {@link LaunchPhaseTimings.incompletePhase} names the phase that consumed the
   * time (e.g. the 180s `launch_error` class). Absent on fires that never hit a
   * launch (validation/backpressure rejections) or that succeeded.
   */
  launchPhaseTimings?: LaunchPhaseTimings;
  /**
   * Merge commit SHA of the delivery unit this fire produced (issue #1596),
   * joined from the task's completion digest at ledger-write time. Present only
   * for a fire whose PR MERGED — its absence means "not a merged unit", never a
   * fabricated value. This is the containment key the ROI rollup tests against
   * the last smoke-gate-passed prod SHA to distinguish `merged` from
   * `live-verified` delivery.
   */
  mergeCommit?: string;
}

/**
 * Per-schedule cap on persisted {@link ScheduleExecutionLedgerEntry} rows
 * (issue #1392). A once-per-minute schedule accrues ~1,440 entries/day, held in
 * memory and re-serialized in full on every reservation — unbounded memory and
 * O(ledger) fsync cost on a long-running node. Bounding the ledger to the
 * newest N rows makes both flat.
 *
 * Consequence for the ROI rollup (issue #1584): `computeScheduleRollup` derives
 * from this ledger and is already a WINDOWED view (it carries `windowStart` /
 * `windowEnd`), so the cap simply narrows that window to the retained rows — it
 * does not break a lifetime contract the rollup never made. At 500 the window
 * spans ~8h for a per-minute schedule and is effectively unbounded for the
 * hourly/daily cadences that dominate, while keeping the per-tick serialization
 * cost a constant rather than O(age).
 */
export const MAX_LEDGER_ENTRIES = 500;

/**
 * Outcomes a ledger row can carry while its run is still mid-flight — the
 * server has recorded a reservation/launch but no terminal result yet. A later
 * completion (`recordTaskTerminalOutcome`) or post-restart reconcile
 * (`reconcileOnStartup`) resolves the row in place by `taskId`, so these rows
 * MUST survive pruning even when they fall outside the newest-N window; dropping
 * one would silently lose the receipt the reconcile depends on. Mirrors the
 * mid-flight set `reconcileOnStartup` keys off (issue #1392 / #1526 Phase A).
 */
const PENDING_LEDGER_OUTCOMES: ReadonlySet<ScheduleExecutionOutcome> = new Set([
  'running',
  'queued',
  'queued_capacity',
]);

/**
 * True when a ledger row is still awaiting a terminal outcome — see
 * {@link PENDING_LEDGER_OUTCOMES}.
 */
export function isPendingLedgerEntry(entry: ScheduleExecutionLedgerEntry): boolean {
  return PENDING_LEDGER_OUTCOMES.has(entry.outcome);
}

/**
 * Bound a schedule's execution ledger to {@link MAX_LEDGER_ENTRIES} (issue
 * #1392). Keeps the newest `cap` rows (ledger order is chronological — appends
 * push to the tail, in-place updates preserve position) PLUS any pending/
 * unresolved row that would otherwise be pruned, so a live receipt a later
 * reconcile keys off is never dropped. Chronological order is preserved:
 * surviving pending rows from the pruned prefix stay ahead of the retained
 * tail. A no-op when the ledger is already within the cap.
 */
export function pruneExecutionLedger(
  ledger: ScheduleExecutionLedgerEntry[],
  cap: number = MAX_LEDGER_ENTRIES,
): ScheduleExecutionLedgerEntry[] {
  if (cap < 0 || ledger.length <= cap) return ledger;
  const cutoff = ledger.length - cap;
  const tail = ledger.slice(cutoff);
  const survivingPending = ledger.slice(0, cutoff).filter(isPendingLedgerEntry);
  return survivingPending.length === 0 ? tail : [...survivingPending, ...tail];
}

export interface ScheduleExecutionReceipt {
  id: string;
  scheduleId: string;
  executionToken: string;
  trigger: ScheduleExecutionTrigger;
  decision: ScheduleExecutionDecision;
  scheduledFor?: string;
  evaluatedAt: string;
  taskId?: string;
  status: 'reserved' | 'accepted' | 'terminal' | 'unknown_after_restart';
}

export interface ScheduleLatestExecutionStatus {
  receiptId?: string;
  executionToken: string;
  scheduledFor?: string;
  evaluatedAt: string;
  triggeredAt?: string;
  trigger: ScheduleExecutionTrigger;
  taskId?: string;
  outcome: ScheduleExecutionOutcome;
  reasonCode?: ScheduleExecutionReasonCode;
  message?: string;
}

export interface Schedule {
  id: string;
  name: string;
  enabled: boolean;
  cron: string;
  maxTriggers?: number;
  remainingTriggers?: number;
  stopReason?: ScheduleStopReason;
  exhaustedAt?: string;
  playbook: SchedulePlaybook;
  cwd: string;
  /** Agent for each scheduled run; `round-robin` alternates per run. */
  agentType: AgentSelection;
  /**
   * Optional per-schedule reasoning-effort pin (#1518). Forwarded into each
   * spawned task as the launch `effort` (wins over the global per-agent-type
   * default; a per-task override would still win if one were supplied).
   */
  effort?: string;
  /**
   * Optional per-schedule model pin (#1518). Forwarded into each spawned task
   * as the launch `model` (e.g. `claude-fable-5`). No-op when omitted — the
   * agent CLI / env default applies.
   */
  model?: string;
  /** Legacy dispatch fields kept for migration compatibility. */
  lastRunAt?: string;
  lastRunTaskId?: string;
  lastRunStatus?: 'completed' | 'cancelled' | 'failed';
  /**
   * Count of consecutive non-`completed` terminal runs (issue #1665). Bumped
   * whenever `lastRunStatus` is written to anything other than `completed` (a
   * `failed` dispatch/skip outcome or a `cancelled` run) and reset to 0 on a
   * `completed` run. Drives the per-schedule failure alert (see
   * `ScheduleService`) and surfaces schedule health without hand-reading the
   * store. Absent until the schedule has recorded its first terminal run.
   */
  consecutiveFailures?: number;
  /** Cron watermark — used for cadence computation, not UI status. */
  lastScheduledFor?: string;
  lastCronEvaluatedAt?: string;
  latestExecution?: ScheduleLatestExecutionStatus;
  currentExecution?: ScheduleExecutionReceipt;
  executionLedger: ScheduleExecutionLedgerEntry[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Tri-state playbook resolution health. A cache miss (the window before the
 * first scheduler tick, or right after a cwd/path/scope edit) is `unknown` and
 * renders neutral — never `broken`. See rfc-schedule-playbook-resolution R9.
 */
export type PlaybookResolutionState = 'unknown' | 'resolvable' | 'unresolvable';

/**
 * Cache key for a schedule's resolution health. Includes the inputs that
 * determine resolvability, so a cwd/path/scope edit invalidates the cached
 * value (the stale entry no longer matches → `unknown`).
 */
export function scheduleResolutionSignature(schedule: Pick<Schedule, 'playbook' | 'cwd'>): string {
  const scope = schedule.playbook.scope ?? 'project';
  return [schedule.playbook.path, scope, schedule.cwd].join('\u0000');
}

/** Schedule enriched with computed fields for API responses. */
export interface ScheduleResponse extends Schedule {
  nextRunAt: string | null;
  cronDescription: string;
  /**
   * Cached, off-hot-path playbook resolution health (R9). Computed on the
   * scheduler tick cadence — `enrichSchedule` only reads the cache, never the
   * filesystem. Optional/additive: older servers omit it (treat as `unknown`).
   */
  playbookResolution?: PlaybookResolutionState;
}

export interface ScheduleStatusSnapshot {
  timezone: string;
  runnerStartedAt?: string;
  lastTickCompletedAt?: string;
  catchUpMode: 'auto' | 'manual' | 'off';
  catchUpEnabled: boolean;
  schedulerHealthy: boolean;
  loadError?: string;
  lastError?: string;
}

export interface ScheduleListResponse {
  revision: number;
  schedules: ScheduleResponse[];
  status: ScheduleStatusSnapshot;
}

export interface CreateScheduleInput {
  name: string;
  cron: string;
  maxTriggers?: number;
  playbook: SchedulePlaybook;
  cwd: string;
  agentType?: AgentSelection;
  /** Optional reasoning-effort pin for every run of this schedule (#1518). */
  effort?: string;
  /** Optional model pin for every run of this schedule (#1518). */
  model?: string;
  enabled?: boolean;
}

export interface UpdateScheduleDefinitionInput {
  name?: string;
  cron?: string;
  maxTriggers?: number | null;
  playbook?: SchedulePlaybook;
  cwd?: string;
  agentType?: AgentSelection;
  /** Set to a string to pin; omit to leave unchanged. */
  effort?: string;
  /** Set to a string to pin; omit to leave unchanged. */
  model?: string;
}

export class ScheduleValidationError extends Error {
  fieldErrors?: Record<string, string>;

  constructor(message: string, fieldErrors?: Record<string, string>) {
    super(message);
    this.name = 'ScheduleValidationError';
    this.fieldErrors = fieldErrors;
  }
}

export function isValidMaxTriggers(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export function isTriggerLimitExhausted(schedule: Pick<Schedule, 'maxTriggers' | 'remainingTriggers'>): boolean {
  if (schedule.maxTriggers === undefined) return false;
  return (schedule.remainingTriggers ?? schedule.maxTriggers) <= 0;
}

export class ScheduleStore {
  private schedules = new Map<string, Schedule>();
  private filePath: string;
  private persistChain: Promise<void> = Promise.resolve();
  private revision = 0;
  private loadError?: string;
  /**
   * Off-hot-path resolution-health cache (R9), keyed by schedule id. The
   * scheduler tick writes it; `enrichSchedule` reads it without any FS access.
   * A stale entry (signature mismatch after an edit) reads back as `unknown`.
   */
  private resolutionCache = new Map<string, { signature: string; resolvable: boolean }>();
  /**
   * Durable per-schedule ROI rollup (issue #1584). Materialized incrementally
   * at ledger-write time and reconciled from the ledger on {@link load}, so
   * schedule ROI is readable in O(1) without any on-request scan.
   */
  private rollupStore: ScheduleRollupStore;

  constructor(kookrDir: string) {
    this.filePath = join(kookrDir, 'schedules.json');
    this.rollupStore = new ScheduleRollupStore(kookrDir);
  }

  async load(): Promise<void> {
    try {
      const content = await readFile(this.filePath, 'utf-8');
      const data = JSON.parse(content);
      if (Array.isArray(data)) {
        for (const raw of data) {
          const schedule = normalizeSchedule(raw);
          if (schedule) {
            this.schedules.set(schedule.id, schedule);
          }
        }
      } else {
        this.loadError = `Unexpected schedule file format: ${this.filePath}`;
      }
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
        this.loadError = undefined;
      } else {
        this.loadError = err instanceof Error
          ? `Failed to load schedules: ${err.message}`
          : `Failed to load schedules: ${String(err)}`;
        this.schedules.clear();
      }
    } finally {
      this.bumpRevision();
    }
    // Reconcile the durable rollup against the freshly-loaded ledger — a
    // missing/deleted/corrupt/stale rollup store self-heals from the ledger.
    await this.rollupStore.load(this.list());
  }

  /** Materialized ROI rollup for one schedule (O(1); no ledger scan). */
  getRollup(id: string): ScheduleRollup | undefined {
    return this.rollupStore.get(id);
  }

  /** Materialized ROI rollups for the whole fleet (O(n); no ledger scan). */
  listRollups(): ScheduleRollup[] {
    return this.rollupStore.list();
  }

  /**
   * Record a passed post-deploy smoke gate at `deployedSha` (issue #1596),
   * flipping every merged unit whose merge commit that SHA contains to
   * live-verified. The `isContained` predicate answers "is this merge commit an
   * ancestor of the deployed SHA?" — resolved by the caller via git ancestry,
   * OFF the request path (a deploy event, not a hot-path read). This store owns
   * the schedule ledgers, so it enumerates every merged unit's commit here and
   * hands the resolved live set to the rollup store; a failed smoke gate never
   * calls this, so counts stay unchanged (the failed-deploy invariant).
   */
  async recordDeployVerification(
    deployedSha: string,
    isContained: (mergeCommit: string) => boolean | Promise<boolean>,
  ): Promise<void> {
    // Unique merge commits across the fleet — each tested for containment once.
    const candidates = new Set<string>();
    for (const schedule of this.schedules.values()) {
      for (const entry of schedule.executionLedger) {
        if (entry.mergeCommit) candidates.add(entry.mergeCommit);
      }
    }
    const verified: string[] = [];
    for (const commit of candidates) {
      if (await isContained(commit)) verified.push(commit);
    }
    this.rollupStore.applyDeployVerification(this.list(), deployedSha, verified);
    this.bumpRevision();
  }

  getLoadError(): string | undefined {
    return this.loadError;
  }

  list(): Schedule[] {
    return Array.from(this.schedules.values());
  }

  listWithComputed(): ScheduleResponse[] {
    return this.list().map((s) => enrichSchedule(s, this.resolutionStateFor(s)));
  }

  get(id: string): Schedule | undefined {
    return this.schedules.get(id);
  }

  getWithComputed(id: string): ScheduleResponse | undefined {
    const s = this.schedules.get(id);
    return s ? enrichSchedule(s, this.resolutionStateFor(s)) : undefined;
  }

  /**
   * Record the tick-cadence resolution-health result for a schedule (R9).
   * Called by the scheduler runner; never reads the filesystem here.
   */
  setPlaybookResolution(id: string, signature: string, resolvable: boolean): void {
    this.resolutionCache.set(id, { signature, resolvable });
  }

  private resolutionStateFor(s: Schedule): PlaybookResolutionState {
    const entry = this.resolutionCache.get(s.id);
    if (!entry || entry.signature !== scheduleResolutionSignature(s)) return 'unknown';
    return entry.resolvable ? 'resolvable' : 'unresolvable';
  }

  getRevision(): number {
    return this.revision;
  }

  create(input: CreateScheduleInput): Schedule {
    if (!input.name?.trim()) throw new ScheduleValidationError('name is required', { name: 'Required' });
    if (!isValidCron(input.cron)) throw new ScheduleValidationError('Invalid cron expression', { cron: 'Invalid cron expression' });
    if (input.maxTriggers !== undefined && !isValidMaxTriggers(input.maxTriggers)) {
      throw new ScheduleValidationError('Invalid trigger limit', { maxTriggers: 'Must be a positive integer' });
    }
    if (!input.playbook?.path) throw new ScheduleValidationError('playbook.path is required', { playbook: 'Required' });
    if (!input.cwd?.trim()) throw new ScheduleValidationError('cwd is required', { cwd: 'Required' });

    const now = new Date().toISOString();
    const schedule: Schedule = {
      id: randomUUID(),
      name: input.name.trim(),
      enabled: input.enabled ?? true,
      cron: input.cron.trim(),
      ...(input.maxTriggers !== undefined ? {
        maxTriggers: input.maxTriggers,
        remainingTriggers: input.maxTriggers,
      } : {}),
      playbook: {
        path: input.playbook.path,
        parameters: { ...(input.playbook.parameters ?? {}) },
        ...(input.playbook.scope ? { scope: input.playbook.scope } : {}),
      },
      cwd: input.cwd,
      agentType: input.agentType ?? DEFAULT_AGENT_TYPE,
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      executionLedger: [],
      createdAt: now,
      updatedAt: now,
    };

    this.schedules.set(schedule.id, schedule);
    this.rollupStore.updateFromSchedule(schedule);
    this.bumpRevision();
    return schedule;
  }

  updateDefinition(id: string, patch: UpdateScheduleDefinitionInput): Schedule {
    const existing = this.schedules.get(id);
    if (!existing) throw new ScheduleValidationError(`Schedule not found: ${id}`);

    if (patch.cron !== undefined && !isValidCron(patch.cron)) {
      throw new ScheduleValidationError('Invalid cron expression', { cron: 'Invalid cron expression' });
    }
    if (patch.maxTriggers !== undefined && patch.maxTriggers !== null && !isValidMaxTriggers(patch.maxTriggers)) {
      throw new ScheduleValidationError('Invalid trigger limit', { maxTriggers: 'Must be a positive integer' });
    }

    const { maxTriggers, ...rest } = patch;
    const nextTriggerState = computeUpdatedTriggerState(existing, maxTriggers, new Date().toISOString());
    const updated: Schedule = {
      ...existing,
      ...rest,
      ...nextTriggerState,
      ...(patch.playbook ? {
        playbook: {
          path: patch.playbook.path,
          parameters: { ...(patch.playbook.parameters ?? {}) },
          // Merge-carry, never reconstruct-and-drop: an update that omits
          // `scope` preserves the already-pinned tier (R2). Prevents an API
          // client sending only path+parameters from un-pinning a schedule.
          ...((patch.playbook.scope ?? existing.playbook.scope)
            ? { scope: patch.playbook.scope ?? existing.playbook.scope }
            : {}),
        },
      } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.schedules.set(id, updated);
    this.rollupStore.updateFromSchedule(updated);
    this.bumpRevision();
    return updated;
  }

  setEnabled(id: string, enabled: boolean): Schedule {
    const existing = this.schedules.get(id);
    if (!existing) throw new ScheduleValidationError(`Schedule not found: ${id}`);
    const updated = {
      ...existing,
      enabled,
      updatedAt: new Date().toISOString(),
    };
    this.schedules.set(id, updated);
    this.rollupStore.updateFromSchedule(updated);
    this.bumpRevision();
    return updated;
  }

  delete(id: string): boolean {
    const deleted = this.schedules.delete(id);
    if (deleted) {
      this.resolutionCache.delete(id);
      this.rollupStore.remove(id);
      this.bumpRevision();
    }
    return deleted;
  }

  replace(schedule: Schedule): void {
    const stored: Schedule = {
      ...schedule,
      updatedAt: new Date().toISOString(),
    };
    this.schedules.set(schedule.id, stored);
    // Incremental, bounded write-path update: recompute only THIS schedule's
    // rollup from its ledger — never a full-fleet rescan (issue #1584).
    this.rollupStore.updateFromSchedule(stored);
    this.bumpRevision();
  }

  async persist(): Promise<void> {
    const write = this.persistChain.then(async () => {
      await this.writeSchedules();
      // Persist the derived rollup alongside the ledger so it survives a
      // restart. It is always reconciled against the ledger on load, so a
      // failed/partial rollup write self-heals on next boot.
      await this.rollupStore.persist();
    });
    // Keep the internal tail usable after a failed write, while callers still observe this write's rejection.
    this.persistChain = write.catch(() => {});
    return write;
  }

  private async writeSchedules(): Promise<void> {
    const data = JSON.stringify(this.list(), null, 2);
    const tmpPath = join(dirname(this.filePath), `.schedules-${randomUUID()}.tmp`);
    await mkdir(dirname(this.filePath), { recursive: true });
    const fh = await open(tmpPath, 'w');
    try {
      await fh.writeFile(data, 'utf-8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmpPath, this.filePath);
  }

  private bumpRevision(): void {
    this.revision += 1;
  }
}

function normalizeSchedule(raw: unknown): Schedule | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Partial<Schedule>;
  if (!candidate.id || !candidate.cron || !candidate.playbook?.path || !candidate.cwd) {
    return null;
  }

  const normalized: Schedule = {
    id: String(candidate.id),
    name: typeof candidate.name === 'string' ? candidate.name : 'Unnamed schedule',
    enabled: candidate.enabled ?? true,
    cron: String(candidate.cron),
    ...normalizeTriggerState(candidate),
    playbook: {
      path: String(candidate.playbook.path),
      parameters: { ...(candidate.playbook.parameters ?? {}) },
      // Carry an already-persisted scope through normalization so it survives
      // a reload (R2). Preserved as-is (even an unrecognised value) so the
      // resolver — not normalization — decides resolvability.
      ...(typeof candidate.playbook.scope === 'string'
        ? { scope: candidate.playbook.scope as PlaybookScope }
        : {}),
    },
    cwd: String(candidate.cwd),
    agentType: normalizeAgentSelection(candidate.agentType),
    ...(typeof candidate.effort === 'string' ? { effort: candidate.effort } : {}),
    ...(typeof candidate.model === 'string' ? { model: candidate.model } : {}),
    createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : new Date().toISOString(),
    updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : new Date().toISOString(),
    ...(typeof candidate.lastRunAt === 'string' ? { lastRunAt: candidate.lastRunAt } : {}),
    ...(typeof candidate.lastRunTaskId === 'string' ? { lastRunTaskId: candidate.lastRunTaskId } : {}),
    ...(candidate.lastRunStatus ? { lastRunStatus: candidate.lastRunStatus } : {}),
    ...(typeof candidate.consecutiveFailures === 'number'
      && Number.isFinite(candidate.consecutiveFailures)
      && candidate.consecutiveFailures > 0
      ? { consecutiveFailures: Math.floor(candidate.consecutiveFailures) }
      : {}),
    ...(typeof candidate.lastScheduledFor === 'string' ? { lastScheduledFor: candidate.lastScheduledFor } : {}),
    ...(typeof candidate.lastCronEvaluatedAt === 'string' ? { lastCronEvaluatedAt: candidate.lastCronEvaluatedAt } : {}),
    ...(candidate.latestExecution ? { latestExecution: normalizeLatestExecution(candidate.latestExecution) } : {}),
    ...(candidate.currentExecution ? { currentExecution: normalizeCurrentExecution(candidate.currentExecution) } : {}),
    executionLedger: normalizeExecutionLedger(candidate.executionLedger),
  };

  return normalized;
}

function normalizeExecutionLedger(raw: unknown): ScheduleExecutionLedgerEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries = raw.flatMap((item) => {
    const entry = normalizeExecutionLedgerEntry(item);
    return entry ? [entry] : [];
  });
  // Bound a legacy ledger that grew unbounded before the cap existed (issue
  // #1392) — a node loading an oversized schedules.json converges to the cap on
  // first read rather than carrying the bloat forward.
  return pruneExecutionLedger(entries);
}

function normalizeExecutionLedgerEntry(raw: unknown): ScheduleExecutionLedgerEntry | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const candidate = raw as Partial<ScheduleExecutionLedgerEntry>;
  if (
    !candidate.id
    || !candidate.scheduleId
    || !candidate.trigger
    || !candidate.decision
    || !candidate.evaluatedAt
    || !candidate.outcome
  ) {
    return undefined;
  }
  // Optional enrichment (issue #1582). Legacy ledgers predate these fields, so
  // both must load cleanly when absent and be dropped rather than trusted when
  // malformed — no migration, no fabricated cost.
  const tokenUsage = normalizeLedgerTokenUsage(candidate.tokenUsage);
  const artifacts = normalizeLedgerArtifacts(candidate.artifacts);
  const mergeCommit = typeof candidate.mergeCommit === 'string' && candidate.mergeCommit.length > 0
    ? candidate.mergeCommit
    : undefined;
  return {
    id: String(candidate.id),
    scheduleId: String(candidate.scheduleId),
    trigger: candidate.trigger,
    decision: candidate.decision,
    evaluatedAt: candidate.evaluatedAt,
    outcome: candidate.outcome,
    ...(candidate.receiptId ? { receiptId: candidate.receiptId } : {}),
    ...(candidate.executionToken ? { executionToken: candidate.executionToken } : {}),
    ...(candidate.scheduledFor ? { scheduledFor: candidate.scheduledFor } : {}),
    ...(candidate.completedAt ? { completedAt: candidate.completedAt } : {}),
    ...(candidate.taskId ? { taskId: candidate.taskId } : {}),
    ...(candidate.blockingTaskId ? { blockingTaskId: candidate.blockingTaskId } : {}),
    ...(candidate.reasonCode ? { reasonCode: candidate.reasonCode } : {}),
    ...(candidate.message ? { message: candidate.message } : {}),
    ...(tokenUsage ? { tokenUsage } : {}),
    ...(artifacts ? { artifacts } : {}),
    ...(mergeCommit ? { mergeCommit } : {}),
  };
}

/**
 * Coerce a persisted ledger `tokenUsage` blob (issue #1582). Returns undefined
 * unless every required numeric field is present and numeric — a partial or
 * malformed record is dropped, never patched with zeros that would read as a
 * measured $0 cost.
 */
function normalizeLedgerTokenUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const c = raw as Partial<TokenUsage>;
  if (
    typeof c.inputTokens !== 'number'
    || typeof c.outputTokens !== 'number'
    || typeof c.cacheReadTokens !== 'number'
    || typeof c.cacheWriteTokens !== 'number'
    || typeof c.costUsd !== 'number'
  ) {
    return undefined;
  }
  return {
    inputTokens: c.inputTokens,
    outputTokens: c.outputTokens,
    cacheReadTokens: c.cacheReadTokens,
    cacheWriteTokens: c.cacheWriteTokens,
    costUsd: c.costUsd,
    ...(c.provider === 'openai' || c.provider === 'anthropic' ? { provider: c.provider } : {}),
    ...(typeof c.model === 'string' ? { model: c.model } : {}),
    ...(c.pricingQuality === 'exact' || c.pricingQuality === 'fallback' ? { pricingQuality: c.pricingQuality } : {}),
  };
}

/**
 * Coerce a persisted ledger `artifacts` list (issue #1582). Keeps only
 * non-empty strings; returns undefined when nothing survives so the field
 * stays absent rather than an empty array.
 */
function normalizeLedgerArtifacts(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const artifacts = raw.filter((v): v is string => typeof v === 'string' && v.length > 0);
  return artifacts.length > 0 ? artifacts : undefined;
}

function normalizeLatestExecution(raw: unknown): ScheduleLatestExecutionStatus | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const candidate = raw as Partial<ScheduleLatestExecutionStatus>;
  if (!candidate.executionToken || !candidate.evaluatedAt || !candidate.trigger || !candidate.outcome) {
    return undefined;
  }
  return {
    executionToken: candidate.executionToken,
    evaluatedAt: candidate.evaluatedAt,
    trigger: candidate.trigger,
    outcome: candidate.outcome,
    ...(candidate.receiptId ? { receiptId: candidate.receiptId } : {}),
    ...(candidate.scheduledFor ? { scheduledFor: candidate.scheduledFor } : {}),
    ...(candidate.triggeredAt ? { triggeredAt: candidate.triggeredAt } : {}),
    ...(candidate.taskId ? { taskId: candidate.taskId } : {}),
    ...(candidate.reasonCode ? { reasonCode: candidate.reasonCode } : {}),
    ...(candidate.message ? { message: candidate.message } : {}),
  };
}

function normalizeCurrentExecution(raw: unknown): ScheduleExecutionReceipt | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const candidate = raw as Partial<ScheduleExecutionReceipt>;
  if (!candidate.id || !candidate.executionToken || !candidate.scheduleId || !candidate.trigger || !candidate.evaluatedAt || !candidate.status) {
    return undefined;
  }
  return {
    id: candidate.id,
    executionToken: candidate.executionToken,
    scheduleId: candidate.scheduleId,
    trigger: candidate.trigger,
    decision: candidate.decision ?? (candidate.trigger === 'manual' ? 'manual_run' : 'cron_due'),
    evaluatedAt: candidate.evaluatedAt,
    status: candidate.status,
    ...(candidate.scheduledFor ? { scheduledFor: candidate.scheduledFor } : {}),
    ...(candidate.taskId ? { taskId: candidate.taskId } : {}),
  };
}

function normalizeTriggerState(candidate: Partial<Schedule>): Pick<Schedule, 'maxTriggers' | 'remainingTriggers' | 'stopReason' | 'exhaustedAt'> {
  const maxTriggers = isValidMaxTriggers(candidate.maxTriggers) ? candidate.maxTriggers : undefined;
  if (maxTriggers === undefined) {
    return {
      maxTriggers: undefined,
      remainingTriggers: undefined,
      stopReason: undefined,
      exhaustedAt: undefined,
    };
  }

  const remainingTriggers = isValidRemainingTriggers(candidate.remainingTriggers)
    ? Math.min(candidate.remainingTriggers, maxTriggers)
    : maxTriggers;
  return {
    maxTriggers,
    remainingTriggers,
    stopReason: candidate.stopReason === 'trigger_limit_reached' ? candidate.stopReason : undefined,
    exhaustedAt: typeof candidate.exhaustedAt === 'string' ? candidate.exhaustedAt : undefined,
  };
}

function isValidRemainingTriggers(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * True when the schedule was auto-disabled by hitting its trigger budget.
 * Exhaustion markers are the only auto-exhaust signal (no separate operator flag);
 * either marker alone counts so partial persisted state still re-arms.
 */
function wasAutoExhausted(existing: Pick<Schedule, 'stopReason' | 'exhaustedAt'>): boolean {
  return existing.stopReason === 'trigger_limit_reached' || existing.exhaustedAt !== undefined;
}

function computeUpdatedTriggerState(
  existing: Schedule,
  nextMaxTriggers: number | null | undefined,
  now: string,
): Pick<Schedule, 'maxTriggers' | 'remainingTriggers' | 'stopReason' | 'exhaustedAt'> & Partial<Pick<Schedule, 'enabled'>> {
  if (nextMaxTriggers === undefined) {
    return {
      maxTriggers: existing.maxTriggers,
      remainingTriggers: existing.remainingTriggers,
      stopReason: existing.stopReason,
      exhaustedAt: existing.exhaustedAt,
    };
  }

  if (nextMaxTriggers === null) {
    // Unlimited budget — re-enable only if previously auto-exhausted (not operator-disabled).
    return {
      maxTriggers: undefined,
      remainingTriggers: undefined,
      stopReason: undefined,
      exhaustedAt: undefined,
      ...(wasAutoExhausted(existing) ? { enabled: true } : {}),
    };
  }

  const consumed = existing.maxTriggers === undefined
    ? 0
    : Math.max(existing.maxTriggers - (existing.remainingTriggers ?? existing.maxTriggers), 0);
  const remainingTriggers = Math.max(nextMaxTriggers - consumed, 0);
  if (remainingTriggers === 0) {
    return {
      maxTriggers: nextMaxTriggers,
      remainingTriggers,
      stopReason: 'trigger_limit_reached',
      exhaustedAt: existing.exhaustedAt ?? now,
      enabled: false,
    };
  }

  // Fresh budget — re-enable only if previously auto-exhausted (not operator-disabled).
  return {
    maxTriggers: nextMaxTriggers,
    remainingTriggers,
    stopReason: undefined,
    exhaustedAt: undefined,
    ...(wasAutoExhausted(existing) ? { enabled: true } : {}),
  };
}

/** Enrich a schedule with computed nextRunAt, cronDescription and cached health. */
function enrichSchedule(
  s: Schedule,
  playbookResolution: PlaybookResolutionState = 'unknown',
): ScheduleResponse {
  const after = s.lastScheduledFor ? new Date(s.lastScheduledFor) : new Date(s.createdAt);
  const next = s.enabled && !isTriggerLimitExhausted(s) ? nextRun(s.cron, after) : null;
  const effectiveNext = next && next.getTime() <= Date.now()
    ? nextRun(s.cron, new Date())
    : next;
  return {
    ...s,
    nextRunAt: effectiveNext?.toISOString() ?? null,
    cronDescription: describeCron(s.cron),
    playbookResolution,
  };
}
