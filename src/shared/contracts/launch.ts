import type { AgentSelection } from './agent-types.js';
import type { LaunchDependency } from './playbook.js';
import type { TaskMetadataIntent } from './task.js';

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
  /** Where the launch came from — for server-side log provenance. Default: 'api'. */
  launchSource?: 'cli' | 'ui' | 'api' | 'remote-chat-telegram' | 'remote-relay';
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
   * Optional idempotency key (issue #1526 Phase B / FM2, FM3). A caller that
   * retries an identical launch request — e.g. after its own client timeout
   * fired against an overloaded server that had already created the task —
   * passes the SAME key on every attempt. The first request for a key
   * creates the task as normal; any later request for the same key
   * (including one racing concurrently with the first) returns the same
   * task with {@link LaunchResult.idempotentReplay} set instead of creating a
   * duplicate. Distinct from the prompt+cwd+agentType dedup in
   * `checkSubmission`: that dedup is defeated when the prompt varies between
   * attempts (e.g. an embedded random branch suffix); an idempotency key
   * protects retries of the exact same logical request regardless of prompt
   * content. Bounded to {@link MAX_IDEMPOTENCY_KEY_LENGTH}. Omitted ⇒ no
   * idempotency protection (today's behavior, unchanged). See
   * `IdempotencyLedger` (`core/idempotency-ledger.ts`) for the reserve/TTL
   * mechanics.
   */
  idempotencyKey?: string;
}

export interface LaunchResult<TaskShape extends { id: string } = { id: string }> {
  task: TaskShape;
  queued: boolean;
  /** True when an active task with the same prompt already exists. */
  duplicate?: boolean;
  /**
   * True when `task` was NOT created by this call — an earlier launch with
   * the same `idempotencyKey` already produced it (issue #1526 Phase B).
   * Distinct from `duplicate` (prompt+cwd+agentType dedup): a replay is a
   * retry of the same logical request, not a coincidentally identical new
   * one, so it never triggers the interactive/CLI duplicate-confirmation UX.
   */
  idempotentReplay?: boolean;
}
