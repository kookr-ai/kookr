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
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appendAuditRow } from '../core/audit-log.js';
import {
  defaultCheckoutGuess,
  defaultParallelIssueBatchOutcomePath,
  evaluatePipelineStarvationRefill,
  isParallelIssueBatchPlaybookId,
  nextPipelineStarvationState,
  parseBatchOutcomeRecord,
  resolveBatchEmptyClass,
  STARVATION_ALERT_WINDOW_MS,
  starvationScoutIdempotencyKey,
  summarizeDisqualifiers,
  type BatchOutcomeRecord,
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
  /** Human-readable one-liner for the batch state.md. */
  summary: string;
}

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
    });
    await savePipelineStarvationState(state, { stateDir: this.deps.stateDir });

    const summary = formatHandleSummary(decision, {
      spawnedScoutTaskId,
      scoutQueued,
      alertEmitted,
      spawnError,
      source,
    });
    return {
      decision,
      state,
      spawnedScoutTaskId,
      scoutQueued,
      alertEmitted,
      recoveredAlertEmitted,
      summary,
    };
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
        workloadSize: 'full-day',
        // Publish safe ideas so the batch engine has real issues to pick up —
        // matching the production Lucy twice-daily scout schedule defaults.
        publishBehavior: 'publish-safe',
        minimumIssueScan: '100',
        useKnowledgeBase: 'auto',
        extraInstruction:
          `On-demand refill triggered by parallel-issue-batch blocked-empty `
          + `(runKey=${outcome.runKey}, provenance=${STARVATION_TRIGGER_PROVENANCE}). `
          + `Prior open issues were all disqualified: ${summarizeDisqualifiers(outcome.disqualified)}.`,
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
  if (bits.alertEmitted) {
    parts.push('starvation alert emitted');
  } else if (decision.alertSkipReason) {
    parts.push(`alert skipped (${decision.alertSkipReason})`);
  }
  return parts.join('; ');
}
