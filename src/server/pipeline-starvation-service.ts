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
 */

import { join } from 'node:path';
import { appendAuditRow } from '../core/audit-log.js';
import {
  defaultCheckoutGuess,
  evaluatePipelineStarvationRefill,
  nextPipelineStarvationState,
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
import { OPERATIONAL_ALERT_AGENT_ID } from './operational-alert-rules.js';
import { preparePlaybookLaunchWithMetadata } from './use-cases/playbook-launch.js';

export const STARVATION_TRIGGER_PROVENANCE = 'starvation-trigger' as const;

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
}

export interface HandleBatchOutcomeResult {
  decision: PipelineStarvationDecision;
  state: PipelineStarvationRepoState;
  spawnedScoutTaskId?: string;
  scoutQueued?: boolean;
  alertEmitted: boolean;
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

    const decisionInputs = {
      scoutInFlight,
      recentEligibleIdeationAt: ideationHit
        ? new Date(ideationHit.atMs).toISOString()
        : null,
      issueCreatedCountInLookback: ideationHit?.issueCreatedCount ?? 0,
      ideationRunKey: ideationHit?.runKey ?? null,
      disqualifierSummary: summarizeDisqualifiers(outcome.disqualified),
    };

    // Always audit the decision path (RFC overnight-throughput PR1 R2) —
    // including non-applicable and alreadyHandled so nights are debuggable.
    await appendAuditRow(this.auditPath(), {
      action: 'pipeline_starvation_decision',
      provenance: STARVATION_TRIGGER_PROVENANCE,
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

    if (!decision.applicable) {
      return {
        decision,
        state: prior,
        alertEmitted: false,
        summary: `pipeline-starvation: skipped (outcome=${outcome.outcome})`,
      };
    }

    // Idempotent replay of the same runKey: no side effects, no ledger rewrite.
    if (decision.alreadyHandled) {
      return {
        decision,
        state: prior,
        spawnedScoutTaskId: prior.lastStarvationScoutTaskId,
        alertEmitted: false,
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
          provenance: STARVATION_TRIGGER_PROVENANCE,
          repo: outcome.repo,
          runKey: outcome.runKey,
          taskId: spawnedScoutTaskId,
          queued: scoutQueued === true,
          openIssueCount: outcome.openIssueCount ?? null,
          disqualifierSummary: decisionInputs.disqualifierSummary,
          at: new Date(nowMs).toISOString(),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        spawnError = message;
        this.deps.log?.(`[pipeline-starvation] scout spawn failed for ${outcome.repo}: ${message}`);
        await appendAuditRow(this.auditPath(), {
          action: 'pipeline_starvation_scout_spawn_failed',
          provenance: STARVATION_TRIGGER_PROVENANCE,
          repo: outcome.repo,
          runKey: outcome.runKey,
          error: message,
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
        provenance: STARVATION_TRIGGER_PROVENANCE,
        repo: outcome.repo,
        runKey: outcome.runKey,
        consecutiveBlockedEmpty: decision.consecutiveBlockedEmpty,
        openIssueCount: outcome.openIssueCount ?? null,
        disqualifierSummary: decisionInputs.disqualifierSummary,
        spawnSkipReason: decision.spawnSkipReason ?? null,
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
    });
    return {
      decision,
      state,
      spawnedScoutTaskId,
      scoutQueued,
      alertEmitted,
      summary,
    };
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

function formatHandleSummary(
  decision: PipelineStarvationDecision,
  bits: {
    spawnedScoutTaskId?: string;
    scoutQueued?: boolean;
    alertEmitted: boolean;
    spawnError?: string;
  },
): string {
  const parts: string[] = [
    `pipeline-starvation: consecutive=${decision.consecutiveBlockedEmpty}`,
  ];
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
