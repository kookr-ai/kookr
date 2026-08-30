import type { AgentSelection, AgentType } from './agent-types.js';
import type { ModelTier } from './model-tier.js';
import type { LaunchDependency } from './playbook.js';
import type { AgentSubstitutionHop, TaskLaunchAdmission, TaskLaunchSource, TaskMetadataIntent } from './task.js';

/**
 * Upper bound on an accepted `idempotencyKey` (issue #1526 Phase B). Single
 * source of truth for both route-level body validation
 * (`routes/task-routes.ts`) and `IdempotencyLedger` — same convention as
 * `MAX_AGENT_SIGNAL_NOTE_LENGTH` in `agent-signal.ts`.
 */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

export interface LaunchOpts {
  prompt: string;
  cwd: string;
  criteria?: string;
  parentTaskId?: string;
  /**
   * Cross-agent migration lineage (RFC: rfc-cross-agent-task-migration). When
   * set, the created task records this as the interrupted task it continues
   * (`Task.migratedFromTaskId`). The migration use-case also stamps a
   * `task_migrate` hop via {@link LaunchOpts.priorAgentSubstitutions}.
   */
  migratedFromTaskId?: string;
  /** Pre-set task name (e.g. from playbooks). Skips AI naming when set. */
  name?: string;
  /** Playbook identifier for traceability. */
  playbookId?: string;
  /** Original playbook parameter values, for relaunch pre-fill. */
  playbookParameterValues?: Record<string, string>;
  /**
   * Agent to launch. Defaults to the configured default agent. May be the
   * `round-robin` sentinel, which the server resolves to a concrete agent.
   */
  agentType?: AgentSelection;
  /** Provider-neutral model intent resolved after the final agent is known. */
  modelTier?: ModelTier;
  /**
   * Internal replay marker: model/effort came from a validated persisted
   * launch intent, not an untrusted raw request.
   */
  replayResolvedPins?: boolean;
  /**
   * Optional per-task reasoning-effort override (#681). Wins over the
   * configured per-agent-type default for this one launch. Validated against
   * the *resolved* agent's allowed set inside `launchTask` (after any
   * round-robin resolution) — an invalid value throws `EffortValidationError`,
   * which the API maps to 400. When undefined, the per-agent-type default (or
   * unset) applies.
   */
  effort?: string;
  /**
   * Optional per-task model pin (#1518). Wins over any per-schedule value and
   * the agent CLI's own default for this one launch. Validated against the
   * *resolved* agent's known-model allowlist inside `launchTask` — an invalid
   * value throws `ModelValidationError` (API → 400). When undefined, the agent
   * CLI / env default applies (claude-code: user Claude config; codex-cli:
   * `KOOKR_CODEX_MODEL`; grok-build: `KOOKR_GROK_MODEL`). Resolution order:
   * per-task → per-schedule → global agent-type default → unset.
   */
  model?: string;
  /** When true, always create a new task instead of returning an existing active duplicate. */
  disableDedup?: boolean;
  /** Explicit operator intent for duplicate-preserving launches. */
  metadataIntent?: TaskMetadataIntent;
  /** Explicit project ID (e.g., github.com/owner/repo) — skips CWD-based inference. */
  projectId?: string;
  /**
   * Where the launch came from — server-side log provenance, the per-source
   * spawn-budget bucket (issue #1526 Phase C / C3), and the
   * `metadata.launchSource` stamp on the created task. Default: 'api'.
   * `schedule` additionally exempts the launch from the spawn burst budget
   * (schedules have their own coalescing — see `spawnBurstLimit` docs).
   */
  launchSource?: TaskLaunchSource;
  /**
   * scheduleId of the firing schedule (issue #1583). Set only by the schedule
   * runner alongside `launchSource: 'schedule'`; becomes the `sourceId` of the
   * created task's `schedule` provenance so a rollup can attribute output back
   * to the schedule. Ignored for non-schedule launches.
   */
  scheduleId?: string;
  /**
   * Attributed caller id for actor-qualified spawn budgets (issue #1526
   * Phase C / C3). Resolved server-side from the Phase B `X-Kookr-Actor`
   * header when present — never trusted further than bucketing: with it,
   * 'lucy' burns her own budget instead of sharing the anonymous `api`
   * bucket. Absent ⇒ the bare `launchSource` bucket.
   */
  launchActorId?: string;
  /** External services the launch should check and surface as launch health. */
  dependencies?: LaunchDependency[];
  /**
   * When true, inject `RALPH_VERDICT_FILE` and `RALPH_ITERATION` env into
   * the spawned agent so iteration 0 of a Ralph loop can write a verdict.
   */
  ralphVerdictEnv?: boolean;
  /** Launch inside the restricted sandbox profile for per-task reflection worktrees. */
  sandboxProfile?: 'reflect';
  /**
   * When true, the task auto-completes after its agent's `completion_ready`
   * signal has been pending for the grace period, rather than waiting
   * indefinitely for manual review. When undefined, the task inherits its
   * parent's policy (so it propagates through self-continuation chains). Set
   * explicitly to `false` to opt a successor out.
   * See docs/reference/auto-close-on-signal.md.
   */
  autoCloseOnSignal?: boolean;
  /**
   * Marks the launch as unattended/autonomous (issue #1562). When true, the
   * spawned agent's injected `--settings` gain permission `deny` rules for
   * interactive tools (`AskUserQuestion` and equivalents) so a blocking call
   * fails fast and flags the task operator-needed, instead of hanging forever
   * on an unanswerable prompt. Inherited from the parent task when spawning a
   * successor unless explicitly overridden (so it propagates down a
   * self-continuation chain); set `false` to opt a successor back out. Default
   * (undefined, no unattended parent) ⇒ attended, unchanged.
   */
  unattended?: boolean;
  /**
   * Optional idempotency key (issue #1526 Phase B / FM2, FM3). A caller that
   * retries an identical launch request — e.g. after its own client timeout
   * fired against an overloaded server that had already created the task —
   * passes the SAME key on every attempt. The first request runs normal launch
   * handling, which may create a task or find an active prompt duplicate. Any
   * later request for the same key (including one racing concurrently with the
   * first) returns the same task and preserves that outcome, with
   * {@link LaunchResult.idempotentReplay} set. Distinct from the
   * prompt+cwd+agentType dedup in
   * `checkSubmission`: that dedup is defeated when the prompt varies between
   * attempts (e.g. an embedded random branch suffix); an idempotency key
   * protects retries of the exact same logical request regardless of prompt
   * content. Bounded to {@link MAX_IDEMPOTENCY_KEY_LENGTH}. Omitted ⇒ no
   * idempotency protection (today's behavior, unchanged). See
   * `IdempotencyLedger` (`core/idempotency-ledger.ts`) for the reserve/TTL
   * mechanics.
   */
  idempotencyKey?: string;
  /**
   * Hot-path issue claim (RFC rfc-issue-ownership-lock PR 1b). When set and
   * `KOOKR_ISSUE_CLAIMS` is on, `launchTask` resolves the claim key (async)
   * then interleaves a synchronous CAS with `createTask` so a held issue
   * never produces a task record. When the flag is off the field is a
   * strict no-op (R7). `repo` is optional — omitted keys resolve from cwd
   * (playbooks typically pass the playbook's repo parameter).
   */
  claimIssue?: {
    number: number;
    repo?: string;
  };
  /**
   * Prior agent substitution hops already applied before this launch
   * (issue #2001). Schedule WS1.3 stamps a `schedule_sub` hop when it
   * substitutes an unavailable pin; launch-service appends a `quota_rotate`
   * hop if plan-quota admission rotates further, and persists the full chain
   * on task metadata.
   */
  priorAgentSubstitutions?: readonly AgentSubstitutionHop[];
}

/**
 * Structured spawn-admission outcome for Anthropic plan-quota exhaustion
 * (issue #1936). Surfaced on successful rotation responses and on the 429
 * reject body so supervisors/feeder can log and avoid blind retries without
 * re-parsing free-text error strings.
 */
export type LaunchAdmissionDecision = 'rotated' | 'rejected';
export type LaunchAdmissionReason = 'plan_quota';

export interface LaunchResult<TaskShape extends { id: string } = { id: string }> {
  task: TaskShape;
  queued: boolean;
  /** True when dependency admission parked the task without starting a worker. */
  parked?: boolean;
  /** Machine-readable reason/state for a dependency-parked launch. */
  dependencyAdmission?: TaskLaunchAdmission;
  /** True when an active task with the same prompt already exists. */
  duplicate?: boolean;
  /**
   * True when this call replayed an earlier outcome under the same
   * `idempotencyKey` (issue #1526 Phase B). A created-task replay has only this
   * flag. If the earlier outcome was prompt dedup, `duplicate` is also true so
   * clients can repeat their duplicate-confirmation flow after restarting.
   */
  idempotentReplay?: boolean;
  /**
   * Plan-quota admission decision when a claude-code launch was rotated to a
   * healthy alternate instead of rejected (issue #1936). Success path only
   * ever sets `'rotated'`; rejects carry `admission: 'rejected'` on the error
   * / 429 body, not on {@link LaunchResult}.
   */
  admission?: 'rotated';
  /** Machine-readable reason paired with {@link admission}. */
  reason?: LaunchAdmissionReason;
  /** Agent that was requested (or resolved) before plan-quota rotation. */
  fromAgent?: AgentType;
  /** Agent that actually received the launch after rotation. */
  toAgent?: AgentType;
  /** Highest plan-window utilization that triggered the rotation. */
  maxUtilization?: number;
  /** Exhaustion threshold that was met or exceeded. */
  threshold?: number;
  /** Binding-window reset time when known (ISO 8601). */
  resetsAt?: string | null;
  /**
   * Full agent substitution chain for this launch (issue #2001), including
   * any `priorAgentSubstitutions` plus a plan-quota hop when rotation ran.
   * Absent when the requested agent launched unchanged.
   */
  agentSubstitutionChain?: AgentSubstitutionHop[];
}
