/**
 * Server-side pipeline starvation refill (issue #1715).
 *
 * Consumes a parallel-issue-batch `blocked-empty` outcome record, decides
 * (via pure core) whether to spawn an on-demand idea-scout and/or raise a
 * pipeline-starvation alert, then performs the side effects:
 *   - spawn repository-idea-scout via the normal launch path
 *   - broadcast an operational alert (dashboard / future delivery bridge)
 *   - append audit.jsonl with provenance `starvation-trigger`
 *   - update the durable per-repo starvation ledger
 *
 * PR2 (overnight-throughput): concurrent emptyClass ignored for product
 * starvation; terminal reconcile for missed product blocked-empty handles.
 *
 * PR4 (overnight-throughput R5): capacity-gated parallel-issue-batch re-entry
 * on `batch_kick_only` handle path and on idea-scout terminal, behind
 * `KOOKR_PIPELINE_BATCH_KICK` (default off).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appendAuditRow } from '../core/audit-log.js';
import {
  clearKickBatchPending,
  defaultCheckoutGuess,
  defaultParallelIssueBatchOutcomePath,
  evaluatePipelineStarvationRefill,
  hasOpenStarvationEpisode,
  isBatchKickInCooldown,
  isIdeaScoutPlaybookId,
  isKickBatchPendingArmed,
  isParallelIssueBatchInFlightForRepo,
  isParallelIssueBatchPlaybookId,
  isPipelineBatchKickEnabled,
  nextPipelineStarvationState,
  parseBatchOutcomeRecord,
  resolveBatchEmptyClass,
  STARVATION_ALERT_WINDOW_MS,
  starvationBatchKickIdempotencyKey,
  starvationScoutIdempotencyKey,
  summarizeDisqualifiers,
  type BatchOutcomeRecord,
  type PipelineBatchKickResult,
  type PipelineStarvationDecision,
  type PipelineStarvationRepoState,
} from '../core/pipeline-starvation.js';
import {
  findRecentSuccessfulIdeationDetails,
  isIdeaScoutInFlightForRepo,
} from '../core/pipeline-starvation-ideation.js';
import {
  loadPipelineStarvationState,
  savePipelineStarvationState,
} from '../core/pipeline-starvation-state.js';
import { projectIdFromRepoSpecifier } from '../core/project-identity.js';
import type { Task, TaskStore } from '../core/tasks.js';
import type { LaunchOpts, LaunchResult } from '../shared/contracts/launch.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
import type { TelegramTaskOutcome } from '../shared/contracts/telegram.js';
import { OPERATIONAL_ALERT_AGENT_ID } from './operational-alert-rules.js';
import { preparePlaybookLaunchWithMetadata } from './use-cases/playbook-launch.js';

export const STARVATION_TRIGGER_PROVENANCE = 'starvation-trigger' as const;
/** Safety-net handle invoked when a batch task terminals without a prior handle. */
export const RECONCILE_TERMINAL_SOURCE = 'reconcile_terminal' as const;
/** Batch kick triggered from handle-time `batch_kick_only` follow-on. */
export const BATCH_KICK_HANDLE_SOURCE = 'batch_kick_handle' as const;
/** Batch kick triggered when an idea-scout for an open episode completes. */
export const BATCH_KICK_SCOUT_COMPLETE_SOURCE = 'batch_kick_scout_complete' as const;

export type PipelineStarvationHandleSource =
  | typeof STARVATION_TRIGGER_PROVENANCE
  | typeof RECONCILE_TERMINAL_SOURCE
  | string;

export interface PipelineStarvationServiceDeps {
  taskStore: TaskStore;
  /** Launch a prepared playbook (normally `launchTask`). */
  launcher: (opts: LaunchOpts) => Promise<LaunchResult<Task>>;
  broadcast: (msg: ServerMessage) => void;
  /** `~/.kookr` (or per-port dir) for audit.jsonl. */
  kookrDir?: string;
  /** Override durable starvation ledger dir (tests). */
  stateDir?: string;
  /** Override home-based idea-scout state discovery root parent (tests). */
  ideaScoutStateDirForRepo?: (repo: string) => string;
  /**
   * Override batch outcome.json path resolution (tests).
   * Default: `~/.kookr/playbook-state/parallel-issue-batch/<slug>/<runKey>/outcome.json`
   * with runKey = task.id and repo from playbookParameterValues.repoFullName.
   */
  resolveBatchOutcomePath?: (task: Task) => string | null;
  /** Override home for default playbook-state paths (tests). */
  homeDir?: string;
  now?: () => number;
  log?: (line: string) => void;
}

export interface HandleBatchOutcomeInput {
  outcome: BatchOutcomeRecord;
  /** Absolute checkout path for the target repo (from batch params / outcome). */
  localPath?: string;
  /** Parent batch task id — links the scout as a child for auditability. */
  parentTaskId?: string;
  /** Agent for the on-demand scout; default = server default. */
  agentType?: LaunchOpts['agentType'];
  /**
   * Provenance/source for audit rows. Playbook POSTs use the default
   * starvation-trigger; terminal safety-net uses `reconcile_terminal`.
   */
  source?: PipelineStarvationHandleSource;
}

export interface HandleBatchOutcomeResult {
  decision: PipelineStarvationDecision;
  state: PipelineStarvationRepoState;
  spawnedScoutTaskId?: string;
  scoutQueued?: boolean;
  alertEmitted: boolean;
  recoveredAlertEmitted?: boolean;
  /** Result of an attempted batch re-entry kick (PR4), if considered. */
  batchKickResult?: PipelineBatchKickResult;
  batchKickTaskId?: string;
  /** Human-readable one-liner for the batch state.md. */
  summary: string;
}

export interface BatchKickAttemptResult {
  result: PipelineBatchKickResult;
  taskId?: string;
  queued?: boolean;
  error?: string;
}

export type BatchKickTrigger =
  | typeof BATCH_KICK_HANDLE_SOURCE
  | typeof BATCH_KICK_SCOUT_COMPLETE_SOURCE
  | string;

export class PipelineStarvationService {
  private readonly deps: PipelineStarvationServiceDeps;

  constructor(deps: PipelineStarvationServiceDeps) {
    this.deps = deps;
  }

  async handleBatchOutcome(input: HandleBatchOutcomeInput): Promise<HandleBatchOutcomeResult> {
    const nowMs = this.deps.now?.() ?? Date.now();
    const { outcome } = input;
    const source = input.source ?? STARVATION_TRIGGER_PROVENANCE;
    const prior = await loadPipelineStarvationState(outcome.repo, {
      stateDir: this.deps.stateDir,
      nowMs,
    });

    const ideaScoutDir = this.deps.ideaScoutStateDirForRepo?.(outcome.repo);
    const ideationHit = await findRecentSuccessfulIdeationDetails(outcome.repo, {
      nowMs,
      ideaScoutStateDir: ideaScoutDir,
    });
    const recentSuccessfulIdeationAtMs = ideationHit?.atMs ?? null;
    const scoutInFlight = isIdeaScoutInFlightForRepo(outcome.repo, this.deps.taskStore.listTasks());

    const decision = evaluatePipelineStarvationRefill(outcome, {
      nowMs,
      recentSuccessfulIdeationAtMs,
      scoutInFlight,
      prior,
    });

    const emptyClass = decision.emptyClass ?? resolveBatchEmptyClass(outcome) ?? null;

    const decisionInputs = {
      scoutInFlight,
      recentEligibleIdeationAt: ideationHit
        ? new Date(ideationHit.atMs).toISOString()
        : null,
      issueCreatedCountInLookback: ideationHit?.issueCreatedCount ?? 0,
      ideationRunKey: ideationHit?.runKey ?? null,
      disqualifierSummary: summarizeDisqualifiers(outcome.disqualified),
      emptyClass,
      source,
    };

    const batchKickEnabled = isPipelineBatchKickEnabled();
    // When followOn would kick implement but flag is off, surface that on the
    // decision row (RFC PR4) so dry-run nights stay forensically complete.
    const batchKickSkipped =
      decision.followOnAction === 'batch_kick_only' && !batchKickEnabled
        ? 'flag_off'
        : null;

    // Always audit the decision path (RFC overnight-throughput PR1 R2) —
    // including non-applicable and alreadyHandled so nights are debuggable.
    await appendAuditRow(this.auditPath(), {
      action: 'pipeline_starvation_decision',
      provenance: source === RECONCILE_TERMINAL_SOURCE
        ? RECONCILE_TERMINAL_SOURCE
        : STARVATION_TRIGGER_PROVENANCE,
      repo: outcome.repo,
      runKey: outcome.runKey,
      outcome: outcome.outcome,
      applicable: decision.applicable,
      alreadyHandled: decision.alreadyHandled,
      spawnScout: decision.spawnScout,
      spawnSkipReason: decision.spawnSkipReason ?? null,
      emitStarvationAlert: decision.emitStarvationAlert,
      alertSkipReason: decision.alertSkipReason ?? null,
      consecutiveBlockedEmpty: decision.consecutiveBlockedEmpty,
      openIssueCount: outcome.openIssueCount ?? null,
      starvationClass: decision.starvationClass ?? null,
      followOnAction: decision.followOnAction ?? null,
      batchKickSkipped,
      batchKickEnabled,
      ...decisionInputs,
      at: new Date(nowMs).toISOString(),
    });

    // Product work returned after a starvation episode → recovered alert (PR2).
    let recoveredAlertEmitted = false;
    if (outcome.outcome === 'done') {
      recoveredAlertEmitted = await this.maybeEmitRecoveredAlert(outcome, prior, nowMs, source);
    }

    if (!decision.applicable) {
      return {
        decision,
        state: prior,
        alertEmitted: false,
        recoveredAlertEmitted,
        summary: emptyClass === 'concurrent'
          ? `pipeline-starvation: skipped (emptyClass=concurrent — not product starvation)`
          : `pipeline-starvation: skipped (outcome=${outcome.outcome})`,
      };
    }

    // Idempotent replay of the same runKey: no side effects, no ledger rewrite.
    if (decision.alreadyHandled) {
      return {
        decision,
        state: prior,
        spawnedScoutTaskId: prior.lastStarvationScoutTaskId,
        alertEmitted: false,
        recoveredAlertEmitted,
        summary:
          `pipeline-starvation: already handled runKey=${outcome.runKey}`
          + (prior.lastStarvationScoutTaskId
            ? `; prior scout taskId=${prior.lastStarvationScoutTaskId}`
            : ''),
      };
    }

    let spawnedScoutTaskId: string | undefined;
    let scoutQueued: boolean | undefined;
    let spawnError: string | undefined;
    let alertEmitted = false;
    let batchKickResult: PipelineBatchKickResult | undefined;
    let batchKickTaskId: string | undefined;

    if (decision.spawnScout) {
      try {
        const launch = await this.spawnIdeaScout(input, nowMs);
        spawnedScoutTaskId = launch.task.id;
        scoutQueued = launch.queued === true;
        this.deps.log?.(
          `[pipeline-starvation] spawned idea-scout for ${outcome.repo} → task ${spawnedScoutTaskId}`
          + `${scoutQueued ? ' (queued)' : ''}`,
        );
        await appendAuditRow(this.auditPath(), {
          action: 'pipeline_starvation_scout_spawn',
          provenance: source === RECONCILE_TERMINAL_SOURCE
            ? RECONCILE_TERMINAL_SOURCE
            : STARVATION_TRIGGER_PROVENANCE,
          repo: outcome.repo,
          runKey: outcome.runKey,
          taskId: spawnedScoutTaskId,
          queued: scoutQueued === true,
          openIssueCount: outcome.openIssueCount ?? null,
          disqualifierSummary: decisionInputs.disqualifierSummary,
          source,
          at: new Date(nowMs).toISOString(),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        spawnError = message;
        this.deps.log?.(`[pipeline-starvation] scout spawn failed for ${outcome.repo}: ${message}`);
        await appendAuditRow(this.auditPath(), {
          action: 'pipeline_starvation_scout_spawn_failed',
          provenance: source === RECONCILE_TERMINAL_SOURCE
            ? RECONCILE_TERMINAL_SOURCE
            : STARVATION_TRIGGER_PROVENANCE,
          repo: outcome.repo,
          runKey: outcome.runKey,
          error: message,
          source,
          at: new Date(nowMs).toISOString(),
        });
        // Fall through — still record the blocked-empty and maybe alert.
      }
    }

    // PR4 / R5: handle-time batch re-entry when recent eligible ideation exists.
    // Always audit when followOn is batch_kick_only (including flag_off).
    if (decision.followOnAction === 'batch_kick_only') {
      const kick = await this.tryKickBatch({
        repo: outcome.repo,
        localPath: input.localPath?.trim() || outcome.localPath?.trim() || undefined,
        parentTaskId: input.parentTaskId,
        agentType: input.agentType,
        trigger: BATCH_KICK_HANDLE_SOURCE,
        runKey: outcome.runKey,
        priorState: prior,
        nowMs,
      });
      batchKickResult = kick.result;
      batchKickTaskId = kick.taskId;
    }

    if (decision.emitStarvationAlert) {
      const alert = buildPipelineStarvationAlert(outcome, decision);
      this.deps.broadcast(alert);
      alertEmitted = true;
      await appendAuditRow(this.auditPath(), {
        action: 'pipeline_starvation_alert',
        provenance: source === RECONCILE_TERMINAL_SOURCE
          ? RECONCILE_TERMINAL_SOURCE
          : STARVATION_TRIGGER_PROVENANCE,
        repo: outcome.repo,
        runKey: outcome.runKey,
        consecutiveBlockedEmpty: decision.consecutiveBlockedEmpty,
        openIssueCount: outcome.openIssueCount ?? null,
        disqualifierSummary: decisionInputs.disqualifierSummary,
        spawnSkipReason: decision.spawnSkipReason ?? null,
        source,
        at: new Date(nowMs).toISOString(),
      });
    }

    const state = nextPipelineStarvationState(outcome.repo, prior, decision, {
      nowMs,
      spawnedTaskId: spawnedScoutTaskId,
      alertEmitted,
      batchKicked: batchKickResult === 'batch_kicked',
    });
    await savePipelineStarvationState(state, { stateDir: this.deps.stateDir });

    const summary = formatHandleSummary(decision, {
      spawnedScoutTaskId,
      scoutQueued,
      alertEmitted,
      spawnError,
      source,
      batchKickResult,
      batchKickTaskId,
    });
    return {
      decision,
      state,
      spawnedScoutTaskId,
      scoutQueued,
      alertEmitted,
      recoveredAlertEmitted,
      batchKickResult,
      batchKickTaskId,
      summary,
    };
  }

  /**
   * Scout-complete batch kick (RFC R5 trigger 1): when an idea-scout for a
   * repo terminals successfully and starvation state has a pending kick flag,
   * matching lastStarvationScoutTaskId, or an open episode, try the same
   * admission-gated batch launch. Always clears the pending flag on terminal
   * (success or failure) + drops TTL-expired arms without kicking.
   *
   * Safe to call from onTaskOutcome — never throws to the caller.
   */
  async maybeKickBatchOnScoutTerminal(
    taskId: string,
    terminalOutcome: TelegramTaskOutcome,
  ): Promise<BatchKickAttemptResult | null> {
    if (
      terminalOutcome.kind !== 'completed'
      && terminalOutcome.kind !== 'failed'
      && terminalOutcome.kind !== 'cancelled'
    ) {
      return null;
    }

    const task = this.deps.taskStore.getTask(taskId);
    if (!task) return null;
    if (!isIdeaScoutPlaybookId(task.playbookId)) {
      // Prompt fallback for CLI-spawned scouts without playbookId stamp.
      const prompt = (task.prompt ?? '').toLowerCase();
      if (!prompt.includes('repository idea scout') && !prompt.includes('idea-scout')) {
        return null;
      }
    }

    const repo = resolveRepoFromTask(task);
    if (!repo) return null;

    const nowMs = this.deps.now?.() ?? Date.now();
    const prior = await loadPipelineStarvationState(repo, {
      stateDir: this.deps.stateDir,
      nowMs,
    });

    const pendingArmed = isKickBatchPendingArmed(prior, nowMs);
    const matchesStarvationScout = prior.lastStarvationScoutTaskId === taskId;
    const openEpisode = hasOpenStarvationEpisode(prior, nowMs);
    const shouldConsiderKick =
      pendingArmed || matchesStarvationScout || (openEpisode && terminalOutcome.kind === 'completed');

    // Always clear a stale/TTL-expired or terminal pending arm.
    const hadPending = prior.kickBatchWhenScoutCompletes === true;
    if (!shouldConsiderKick && !hadPending) {
      return null;
    }

    // Terminal failure/cancel: clear flag only, no kick.
    if (terminalOutcome.kind !== 'completed') {
      if (hadPending) {
        const cleared = clearKickBatchPending(prior, { nowMs });
        await savePipelineStarvationState(cleared, { stateDir: this.deps.stateDir });
        this.deps.log?.(
          `[pipeline-starvation] scout terminal=${terminalOutcome.kind} for ${repo} `
          + `— cleared kickBatchWhenScoutCompletes without kick`,
        );
      }
      return null;
    }

    if (!shouldConsiderKick) {
      // Pending flag set but TTL expired and no other trigger.
      if (hadPending) {
        const cleared = clearKickBatchPending(prior, { nowMs });
        await savePipelineStarvationState(cleared, { stateDir: this.deps.stateDir });
      }
      return null;
    }

    const localPath =
      task.playbookParameterValues?.localPath?.trim()
      || task.cwd
      || undefined;

    const kick = await this.tryKickBatch({
      repo,
      localPath,
      parentTaskId: taskId,
      trigger: BATCH_KICK_SCOUT_COMPLETE_SOURCE,
      runKey: taskId,
      priorState: prior,
      nowMs,
    });

    const next = clearKickBatchPending(prior, {
      nowMs,
      batchKicked: kick.result === 'batch_kicked',
    });
    await savePipelineStarvationState(next, { stateDir: this.deps.stateDir });
    return kick;
  }

  /**
   * Shared admission + launch for starvation batch re-entry (R5).
   * Concurrent single-flight + optional cooldown; flag default off.
   */
  async tryKickBatch(input: {
    repo: string;
    localPath?: string;
    parentTaskId?: string;
    agentType?: LaunchOpts['agentType'];
    trigger: BatchKickTrigger;
    runKey?: string;
    priorState?: PipelineStarvationRepoState | null;
    nowMs?: number;
  }): Promise<BatchKickAttemptResult> {
    const nowMs = input.nowMs ?? this.deps.now?.() ?? Date.now();
    const prior = input.priorState
      ?? await loadPipelineStarvationState(input.repo, {
        stateDir: this.deps.stateDir,
        nowMs,
      });

    if (!isPipelineBatchKickEnabled()) {
      const result: PipelineBatchKickResult = 'batch_skipped_flag_off';
      await this.auditBatchKick({
        repo: input.repo,
        result,
        trigger: input.trigger,
        runKey: input.runKey,
        nowMs,
      });
      return { result };
    }

    if (isParallelIssueBatchInFlightForRepo(input.repo, this.deps.taskStore.listTasks())) {
      const result: PipelineBatchKickResult = 'batch_skipped_concurrent';
      await this.auditBatchKick({
        repo: input.repo,
        result,
        trigger: input.trigger,
        runKey: input.runKey,
        nowMs,
      });
      return { result };
    }

    if (isBatchKickInCooldown(prior, nowMs)) {
      const result: PipelineBatchKickResult = 'batch_skipped_cooldown';
      await this.auditBatchKick({
        repo: input.repo,
        result,
        trigger: input.trigger,
        runKey: input.runKey,
        nowMs,
        lastBatchKickAt: prior.lastBatchKickAt,
      });
      return { result };
    }

    try {
      const launch = await this.spawnParallelIssueBatch({
        repo: input.repo,
        localPath: input.localPath,
        parentTaskId: input.parentTaskId,
        agentType: input.agentType,
        nowMs,
        trigger: input.trigger,
      });
      const taskId = launch.task.id;
      this.deps.log?.(
        `[pipeline-starvation] batch kick for ${input.repo} → task ${taskId}`
        + `${launch.queued ? ' (queued)' : ''} trigger=${input.trigger}`,
      );
      await this.auditBatchKick({
        repo: input.repo,
        result: 'batch_kicked',
        trigger: input.trigger,
        runKey: input.runKey,
        taskId,
        queued: launch.queued === true,
        nowMs,
      });
      return {
        result: 'batch_kicked',
        taskId,
        queued: launch.queued === true,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.log?.(
        `[pipeline-starvation] batch kick failed for ${input.repo}: ${message}`,
      );
      await this.auditBatchKick({
        repo: input.repo,
        result: 'batch_kick_failed',
        trigger: input.trigger,
        runKey: input.runKey,
        error: message,
        nowMs,
      });
      return { result: 'batch_kick_failed', error: message };
    }
  }

  private async auditBatchKick(row: {
    repo: string;
    result: PipelineBatchKickResult;
    trigger: BatchKickTrigger;
    runKey?: string;
    taskId?: string;
    queued?: boolean;
    error?: string;
    lastBatchKickAt?: string;
    nowMs: number;
  }): Promise<void> {
    await appendAuditRow(this.auditPath(), {
      action: 'pipeline_starvation_batch_kick',
      provenance: STARVATION_TRIGGER_PROVENANCE,
      repo: row.repo,
      result: row.result,
      trigger: row.trigger,
      runKey: row.runKey ?? null,
      taskId: row.taskId ?? null,
      queued: row.queued ?? false,
      error: row.error ?? null,
      lastBatchKickAt: row.lastBatchKickAt ?? null,
      at: new Date(row.nowMs).toISOString(),
    });
  }

  private async spawnParallelIssueBatch(input: {
    repo: string;
    localPath?: string;
    parentTaskId?: string;
    agentType?: LaunchOpts['agentType'];
    nowMs: number;
    trigger: BatchKickTrigger;
  }): Promise<LaunchResult<Task>> {
    const localPath = input.localPath?.trim() || '';
    const projectId = projectIdFromRepoSpecifier(input.repo) ?? undefined;
    const taskTargetCwd = localPath || defaultCheckoutGuess(input.repo);

    // Production schedule defaults for lucy-class batches: modest target,
    // merge when safe, autonomous headless-safe onAmbiguity (headless gate
    // also covers ask, but prefer auto-safe-subset for starvation kicks).
    const prepared = await preparePlaybookLaunchWithMetadata({
      cwd: taskTargetCwd,
      playbookPath: 'parallel-issue-batch.md',
      scope: 'plugin',
      parameterValues: {
        repoFullName: input.repo,
        localPath: localPath || '',
        issueSelector: '',
        targetIssueCount: '4',
        maxConcurrentTasks: '3',
        mergeAfterImplementation: 'true',
        allowOtherAuthors: 'false',
        childAgent: 'default',
        onAmbiguity: 'auto-safe-subset',
        extraInstruction:
          `On-demand batch re-entry after pipeline starvation refill `
          + `(trigger=${input.trigger}, provenance=${STARVATION_TRIGGER_PROVENANCE}). `
          + `Prefer single-PR-safe leaves; do not invent low-product work.`,
      },
      taskTargetCwd,
      taskTargetCwdExplicit: true,
      agentType: input.agentType,
    });

    const launchOpts: LaunchOpts = {
      ...prepared.launchOpts,
      parentTaskId: input.parentTaskId,
      playbookId: prepared.launchOpts.playbookId ?? 'parallel-issue-batch.md',
      projectId: prepared.launchOpts.projectId ?? projectId,
      launchSource: 'api',
      disableDedup: true,
      autoCloseOnSignal: true,
      idempotencyKey: starvationBatchKickIdempotencyKey(input.repo, input.nowMs),
      name: `Parallel issue batch (starvation kick): ${input.repo}`,
    };

    return this.deps.launcher(launchOpts);
  }

  /**
   * Terminal safety net (RFC R6 / PR2): when a parallel-issue-batch task
   * reaches a terminal lifecycle outcome, if its outcome.json is a **product**
   * blocked-empty and runKey ∉ handledRunKeys, invoke handle once with
   * source=`reconcile_terminal`. Concurrent empties are ignored.
   *
   * Safe to call from onTaskOutcome — never throws to the caller.
   */
  async maybeReconcileBatchTaskTerminal(
    taskId: string,
    terminalOutcome: TelegramTaskOutcome,
  ): Promise<HandleBatchOutcomeResult | null> {
    if (
      terminalOutcome.kind !== 'completed'
      && terminalOutcome.kind !== 'failed'
      && terminalOutcome.kind !== 'cancelled'
    ) {
      return null;
    }

    const task = this.deps.taskStore.getTask(taskId);
    if (!task) return null;
    if (!isParallelIssueBatchPlaybookId(task.playbookId)) return null;

    const outcomePath = this.resolveOutcomePathForTask(task);
    if (!outcomePath) return null;

    let raw: string;
    try {
      raw = await readFile(outcomePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      this.deps.log?.(
        `[pipeline-starvation] reconcile: failed to read ${outcomePath}: `
        + (err instanceof Error ? err.message : String(err)),
      );
      return null;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      this.deps.log?.(`[pipeline-starvation] reconcile: invalid JSON at ${outcomePath}`);
      return null;
    }

    const record = parseBatchOutcomeRecord(parsedJson);
    if (!record || record.outcome !== 'blocked-empty') return null;

    const emptyClass = resolveBatchEmptyClass(record);
    if (emptyClass === 'concurrent') {
      await appendAuditRow(this.auditPath(), {
        action: 'pipeline_starvation_decision',
        provenance: RECONCILE_TERMINAL_SOURCE,
        repo: record.repo,
        runKey: record.runKey,
        outcome: record.outcome,
        applicable: false,
        alreadyHandled: false,
        spawnScout: false,
        spawnSkipReason: 'emptyClass=concurrent — reconcile skipped',
        emitStarvationAlert: false,
        alertSkipReason: 'concurrent batch NO-OP',
        consecutiveBlockedEmpty: 0,
        emptyClass: 'concurrent',
        source: RECONCILE_TERMINAL_SOURCE,
        taskId,
        at: new Date(this.deps.now?.() ?? Date.now()).toISOString(),
      });
      return null;
    }

    const nowMs = this.deps.now?.() ?? Date.now();
    const prior = await loadPipelineStarvationState(record.repo, {
      stateDir: this.deps.stateDir,
      nowMs,
    });
    if (prior.handledRunKeys.includes(record.runKey)) {
      return null;
    }

    this.deps.log?.(
      `[pipeline-starvation] reconcile_terminal: unhandled product blocked-empty `
      + `runKey=${record.runKey} repo=${record.repo} taskId=${taskId}`,
    );

    return this.handleBatchOutcome({
      outcome: record,
      localPath: record.localPath?.trim() || task.cwd || undefined,
      parentTaskId: task.id,
      source: RECONCILE_TERMINAL_SOURCE,
    });
  }

  private resolveOutcomePathForTask(task: Task): string | null {
    if (this.deps.resolveBatchOutcomePath) {
      return this.deps.resolveBatchOutcomePath(task);
    }
    const repo =
      task.playbookParameterValues?.repoFullName?.trim()
      || task.playbookParameterValues?.repo?.trim()
      || '';
    if (!repo || !repo.includes('/')) return null;
    const runKey = task.id;
    return defaultParallelIssueBatchOutcomePath(repo, runKey, this.deps.homeDir);
  }

  private async maybeEmitRecoveredAlert(
    outcome: BatchOutcomeRecord,
    prior: PipelineStarvationRepoState,
    nowMs: number,
    source: PipelineStarvationHandleSource,
  ): Promise<boolean> {
    if (!prior.lastStarvationAlertAt) return false;
    const lastAlertMs = Date.parse(prior.lastStarvationAlertAt);
    if (!Number.isFinite(lastAlertMs)) return false;
    if (nowMs - lastAlertMs > STARVATION_ALERT_WINDOW_MS) return false;

    const alert = buildPipelineStarvationRecoveredAlert(outcome.repo);
    this.deps.broadcast(alert);
    await appendAuditRow(this.auditPath(), {
      action: 'pipeline_starvation_alert_recovered',
      provenance: source === RECONCILE_TERMINAL_SOURCE
        ? RECONCILE_TERMINAL_SOURCE
        : STARVATION_TRIGGER_PROVENANCE,
      repo: outcome.repo,
      runKey: outcome.runKey,
      source,
      lastStarvationAlertAt: prior.lastStarvationAlertAt,
      at: new Date(nowMs).toISOString(),
    });
    return true;
  }

  private auditPath(): string | undefined {
    return this.deps.kookrDir ? join(this.deps.kookrDir, 'audit.jsonl') : undefined;
  }

  private async spawnIdeaScout(
    input: HandleBatchOutcomeInput,
    nowMs: number,
  ): Promise<LaunchResult<Task>> {
    const { outcome } = input;
    const localPath = input.localPath?.trim() || outcome.localPath?.trim() || '';
    // Derived from the outcome repo string only — do not pass as an explicit
    // projectId into preparePlaybookLaunch, which would also require the
    // checkout's git remote to match (breaks temp/cloned paths).
    const projectId = projectIdFromRepoSpecifier(outcome.repo) ?? undefined;

    // Prefer an existing checkout path; fall back to ~/git/<owner-repo> which
    // matches the idea-scout playbook's default REPO_SLUG layout.
    const taskTargetCwd = localPath || defaultCheckoutGuess(outcome.repo);

    const prepared = await preparePlaybookLaunchWithMetadata({
      // cwd is required by normalizePlaybookLaunchInput even for plugin-scope
      // launches (it seeds playbookSourceCwd when scope resolves its own dir).
      cwd: taskTargetCwd,
      playbookPath: 'repository-idea-scout.md',
      scope: 'plugin',
      parameterValues: {
        repoFullName: outcome.repo,
        localPath: localPath || '',
        workProfile: 'balanced',
        // PR3: starvation refill uses quick-shortlist (valid enum) rather than
        // full-day — overnight top-up, not a full dual-daily scout.
        workloadSize: 'quick-shortlist',
        // Publish safe ideas so the batch engine has real issues to pick up —
        // matching the production Lucy twice-daily scout schedule defaults.
        publishBehavior: 'publish-safe',
        minimumIssueScan: '100',
        useKnowledgeBase: 'auto',
        extraInstruction:
          `On-demand refill triggered by parallel-issue-batch blocked-empty `
          + `(runKey=${outcome.runKey}, provenance=${STARVATION_TRIGGER_PROVENANCE}). `
          + `Prior open issues were all disqualified: ${summarizeDisqualifiers(outcome.disqualified)}. `
          + `Prefer single-PR-safe leaves, not umbrella/tracking issues.`,
      },
      taskTargetCwd,
      taskTargetCwdExplicit: true,
      agentType: input.agentType,
    });

    const launchOpts: LaunchOpts = {
      ...prepared.launchOpts,
      parentTaskId: input.parentTaskId,
      // Stamp playbook id explicitly so in-flight detection is reliable.
      playbookId: prepared.launchOpts.playbookId ?? 'repository-idea-scout.md',
      projectId: prepared.launchOpts.projectId ?? projectId,
      launchSource: 'api',
      disableDedup: true,
      autoCloseOnSignal: true,
      idempotencyKey: starvationScoutIdempotencyKey(outcome.repo, nowMs),
      name:
        `Idea scout (starvation refill): ${outcome.repo}`,
    };

    return this.deps.launcher(launchOpts);
  }
}

function buildPipelineStarvationAlert(
  outcome: BatchOutcomeRecord,
  decision: PipelineStarvationDecision,
): Extract<ServerMessage, { type: 'alert' }> {
  const disqualifierSummary = summarizeDisqualifiers(outcome.disqualified);
  const open = outcome.openIssueCount ?? outcome.disqualified?.length ?? 0;
  return {
    type: 'alert',
    agentId: OPERATIONAL_ALERT_AGENT_ID,
    summary:
      `Pipeline starvation: ${outcome.repo} — ${decision.consecutiveBlockedEmpty} consecutive `
      + `empty batches (open issues: ${open})`,
    details:
      `Issue #1715 pipeline-starvation refill: repo ${outcome.repo} hit blocked-empty `
      + `${decision.consecutiveBlockedEmpty} times within 12h. `
      + `Latest runKey=${outcome.runKey}. `
      + `Open issues: ${open}. Disqualifiers: ${disqualifierSummary}. `
      + (outcome.reason ? `Reason: ${outcome.reason}. ` : '')
      + 'An on-demand idea-scout is (or was recently) triggered when dedup allows; '
      + 'inspect playbook-state/pipeline-starvation and audit.jsonl provenance=starvation-trigger.',
    severity: 'warning',
    operationalAlert: {
      key: `pipeline:starvation:${outcome.repo}`,
      metric: 'pipeline_starvation',
      state: 'fired',
    },
  };
}

function buildPipelineStarvationRecoveredAlert(
  repo: string,
): Extract<ServerMessage, { type: 'alert' }> {
  return {
    type: 'alert',
    agentId: OPERATIONAL_ALERT_AGENT_ID,
    summary: `Recovered: pipeline work resumed for ${repo}`,
    details:
      `Pipeline starvation episode cleared for ${repo}: a batch completed with `
      + `outcome=done after a prior starvation alert within the 12h window. `
      + 'Inspect playbook-state/pipeline-starvation and recent batch outcomes.',
    severity: 'info',
    operationalAlert: {
      key: `pipeline:starvation:${repo}`,
      metric: 'pipeline_starvation',
      state: 'recovered',
    },
  };
}

function formatHandleSummary(
  decision: PipelineStarvationDecision,
  bits: {
    spawnedScoutTaskId?: string;
    scoutQueued?: boolean;
    alertEmitted: boolean;
    spawnError?: string;
    source?: string;
    batchKickResult?: PipelineBatchKickResult;
    batchKickTaskId?: string;
  },
): string {
  const parts: string[] = [
    `pipeline-starvation: consecutive=${decision.consecutiveBlockedEmpty}`,
  ];
  if (bits.source === RECONCILE_TERMINAL_SOURCE) {
    parts.push('source=reconcile_terminal');
  }
  if (bits.spawnedScoutTaskId) {
    parts.push(
      `spawned scout taskId=${bits.spawnedScoutTaskId}`
      + `${bits.scoutQueued ? ' (queued)' : ''}`,
    );
  } else if (bits.spawnError) {
    parts.push(`scout spawn failed (${bits.spawnError})`);
  } else if (decision.spawnSkipReason) {
    parts.push(`scout skipped (${decision.spawnSkipReason})`);
  }
  if (bits.batchKickResult === 'batch_kicked' && bits.batchKickTaskId) {
    parts.push(`batch kicked taskId=${bits.batchKickTaskId}`);
  } else if (bits.batchKickResult) {
    parts.push(`batch kick ${bits.batchKickResult}`);
  }
  if (bits.alertEmitted) {
    parts.push('starvation alert emitted');
  } else if (decision.alertSkipReason) {
    parts.push(`alert skipped (${decision.alertSkipReason})`);
  }
  return parts.join('; ');
}

/** Extract owner/repo from a task's playbook params / projectId / name / prompt. */
function resolveRepoFromTask(task: Task): string | null {
  const fromParams =
    task.playbookParameterValues?.repoFullName?.trim()
    || task.playbookParameterValues?.repo?.trim()
    || '';
  if (fromParams.includes('/')) return fromParams;

  // projectId is often github.com/owner/repo
  const pid = task.projectId?.trim() ?? '';
  const pidMatch = pid.match(/(?:github\.com\/)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/i);
  if (pidMatch?.[1]) return pidMatch[1];

  const hay = `${task.name ?? ''} ${task.prompt ?? ''}`;
  const nameMatch = hay.match(/\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\b/);
  return nameMatch?.[1] ?? null;
}
