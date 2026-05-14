import type { CompletionDigest } from './completion-digest.js';
import type { AgentType } from './agent-types.js';
import type { SessionInfo } from './session-read-model.js';
import type { TaskStatus } from './task-status.js';
import type { TokenUsage } from './usage-types.js';

/**
 * User feedback on a completed task. Drives the per-task self-reflect loop.
 * `rating` is always required; `note` and `downReason` are optional enrichment.
 * Stored on `Task.completionFeedback` and persisted to the interaction log.
 */
export interface TaskCompletionFeedback {
  rating: 'up' | 'down';
  /** Free-text note, sanitized server-side before persistence. */
  note?: string;
  /** Only meaningful when rating === 'down'. */
  downReason?: 'agent_behavior' | 'my_prompt';
}

/**
 * Marker for a reflect task spawned to analyze a completed source task.
 * Persisted on the spawned task itself so cleanup logic can identify reflect tasks
 * by their relationship to a source task.
 */
export interface ReflectMeta {
  /** Source task this reflect is analyzing. */
  sourceTaskId: string;
  /** Path to the immutable feedback bundle dir the reflect was launched against. */
  bundlePath: string;
  /** 'up' triggers reinforcement branch in the skill; 'down' triggers fix-proposal branch. */
  direction: 'up' | 'down';
}

/**
 * Lifecycle status of a Ralph Wiggum-style iteration loop attached to a task.
 * See issue #440. Terminal states (`completed`, `failed`, `cancelled`) prevent
 * further iteration injection on Stop events.
 */
export type RalphLoopStatus =
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * Per-task Ralph loop state. Drives the on-Stop iteration cycle: when the
 * agent emits Stop and `status === 'running'`, the controller evaluates the
 * iteration cap and the optional shell `stopPredicate`, then either re-injects
 * `prompt` or terminates the loop.
 *
 * All timestamps are ms-since-epoch numbers so the field round-trips through
 * JSON persistence without extra deserialization (Date objects would need
 * manual reconstruction in `loadTasks`).
 *
 * Fields are deliberately small - the iteration audit trail lives in a
 * separate JSONL file (`<task-dir>/ralph-iterations.jsonl`), not in this
 * struct, so per-task JSON does not balloon as iterations accumulate.
 */
export interface RalphZeroDiffConvergenceConfig {
  consecutiveIterations: number;
}

/**
 * Per-loop stall configuration. See rfc-ralph-loop-stall-handling.md.
 *
 * `loopShape` defaults to 'single-target' (fail-safe - production-observed
 * failure pattern is single-target loops spinning to iteration cap; safe
 * default terminates eagerly).
 */
export interface RalphStallConfig {
  /** Default 2 - consecutive stall verdicts before a target is burned. */
  consecutiveStallsPerTarget?: number;
  /** Default 'single-target'. */
  loopShape?: 'single-target' | 'multi-target';
  /**
   * Default 3. Only applies when loopShape='single-target'. The terminal
   * threshold for single-target loops.
   */
  consecutiveStallsForSingleTargetTermination?: number;
  /**
   * For multi-target loops only. When every declared target has been burned,
   * the engine terminates with `all_targets_stalled` instead of spinning to
   * iteration cap. Without this list, multi-target loops have no all-burned
   * signal and rely on `verdict.complete` or iteration cap.
   */
  declaredTargets?: string[];
  /**
   * Optional iterations-since-last-attempt threshold for un-burning a target.
   * Default undefined (no decay). Useful for transient blockers (CI flake).
   */
  burnedTargetDecayIterations?: number;
  /**
   * Optional per-iteration cost cap in USD. Decoupled from stall machinery -
   * over-cap iterations have their own counter and exit reason.
   */
  iterationCostCapUsd?: number;
  /** Default 2. Consecutive over-cap iterations before terminating. */
  consecutiveIterationCostCapHits?: number;
}

/**
 * Per-target stall record. The engine maintains one row per canonicalized
 * target the agent has reported `verdict: stalled` for. `consecutiveStallCount`
 * is the burn-threshold counter; `totalStallCount` is for dashboard display.
 */
export interface BurnedOutTarget {
  /** Canonicalized: trim().toLowerCase().replace(/^#/, ''). */
  target: string;
  /**
   * Consecutive stall count for this specific target. Resets to 0 on any
   * `progress` verdict for the same canonicalized target. Stalls on different
   * targets do NOT reset this counter (different targets are independent).
   */
  consecutiveStallCount: number;
  /** Lifetime total - never decremented. */
  totalStallCount: number;
  firstStalledAtIteration: number;
  lastStallReason: string;
  lastStallBlockers: string[];
  /** True once consecutiveStallCount >= consecutiveStallsPerTarget. */
  burned: boolean;
  /**
   * True when the burn was triggered by a `verdict.stalled` with
   * `permanent: true` (agent's structural-unfitness claim). Sticky: decay
   * skips rows with this flag so a permanent burn doesn't silently revert.
   * A subsequent `progress` verdict for the same target still un-burns
   * unconditionally - the agent can self-correct. Absent on rows burned via
   * the count threshold.
   */
  permanent?: boolean;
  /** Iteration number when this target was last stalled (for decay). */
  lastAttemptedIteration: number;
}

export interface RalphLoopState {
  /** Verbatim user prompt re-injected on every iteration. No length cap. */
  prompt: string;
  /** Hard ceiling. Always-checked, separate from any predicate. */
  iterationCap: number;
  /**
   * Optional user-supplied shell command. Exit code 0 = stop; non-zero or
   * timeout = keep looping. Executed with cwd = task workdir, env
   * `RALPH_ITERATION` and `RALPH_LAST_OUTPUT_FILE`. 5s timeout enforced
   * by the controller (not encoded here).
   */
  stopPredicate?: string;
  /**
   * Optional engine-only stall predicate. Exit 0 = treat the iteration as a
   * stall verdict (single-target attribution). Sibling of `stopPredicate`,
   * same execution semantics. Only fires when `stopPredicate` did not exit 0
   * and no `verdict.stalled` was produced via the verdict file.
   */
  stallPredicate?: string;
  /** Optional convergence config - stop when N consecutive iterations produce zero diff. */
  zeroDiffConvergence?: RalphZeroDiffConvergenceConfig;
  /** Optional best-effort cost cap in USD. Fails closed when cost is unknown. */
  costCapUsd?: number;
  /** Current consecutive zero-diff streak. Reset on any non-zero diff. */
  zeroDiffStreak?: number;
  /** 0-based count of iterations that have started. Incremented on each re-inject. */
  currentIteration: number;
  status: RalphLoopStatus;
  /** When the most recent iteration was injected. 0 before the first iteration. */
  lastIterationStartedAt: number;
  /** Fingerprint of the last Stop event that was fully handled (launch + cleanup). */
  lastHandledStopFingerprint?: string;
  /** Fingerprint of the Stop event currently being handled (in-flight dedup guard). */
  handlingStopFingerprint?: string;
  /** Terminal session ID that owns this loop's conversation context. */
  ownerSessionId?: string;
  /**
   * Sum of iterations across the loop's lifetime, including any iterations
   * before a pause/resume cycle. `currentIteration` is reset by re-arm; this
   * counter is not.
   */
  cumulativeIterations: number;
  /** Stall detection configuration. Defaults applied at attach time. */
  stallConfig?: RalphStallConfig;
  /** One row per target the agent has reported stalled. */
  burnedOutTargets?: BurnedOutTarget[];
  /**
   * Number of consecutive iterations whose cost delta exceeded
   * `stallConfig.iterationCostCapUsd`. Reset to 0 on any iteration whose
   * delta is below the cap (or whose delta is unknown).
   */
  consecutiveIterationCostCapStreak?: number;
  /**
   * Cumulative cost of the most recent fully-handled iteration. The cycler
   * uses this to compute per-iteration cost deltas without re-reading the
   * iteration log. `undefined` when no prior iteration reported a known
   * cumulative cost (first iteration, or cost source unavailable).
   */
  lastCumulativeCostUsd?: number;
  /** Cumulative count of malformed/oversize/etc verdict files (operability). */
  verdictWarningCount?: number;
  /** Cumulative count of over-cap iterations (operability). */
  iterationCostWarningCount?: number;
  /** The most recent verdict warning reason - for quick triage in the API/dashboard. */
  lastVerdictWarningReason?: string;
}

export interface CreateTaskOptions {
  prompt: string;
  cwd: string;
  criteria?: string;
  parentTaskId?: string;
  agentType?: AgentType;
  /** Original playbook parameter values, for relaunch pre-fill. */
  playbookParameterValues?: Record<string, string>;
  /** Advisory diagnostics captured during launch without changing task identity. */
  launchHealthSummary?: TaskLaunchHealthSummary;
  /** Warning text prepended to the first agent prompt, but not stored in `prompt`. */
  launchNote?: string;
}

export interface TaskLaunchHealthSummary {
  degradedDependencies: string[];
  findings: TaskLaunchHealthFinding[];
}

export interface TaskLaunchHealthFinding {
  dependency: string;
  status: 'failed';
  category: string;
  summary: string;
  detail?: string;
  recommendedAction: string;
}

export interface Task {
  id: string;
  name?: string;
  prompt: string;
  cwd: string;
  criteria?: string;
  agentType: AgentType;
  playbookId?: string;
  /** Original playbook parameter values, for relaunch pre-fill. */
  playbookParameterValues?: Record<string, string>;
  /** Advisory launch diagnostics. Does not affect duplicate detection. */
  launchHealthSummary?: TaskLaunchHealthSummary;
  /** Warning text prepended to the actual launch prompt, but not part of `prompt`. */
  launchNote?: string;
  parentTaskId?: string;
  childTaskIds?: string[];
  /** Normalized project identifier (e.g. "github.com/owner/repo" or "local/dirname"). */
  projectId?: string;
  status: TaskStatus;
  sessions: SessionInfo[];
  tokenUsage?: TokenUsage;
  /** Summary of what the agent accomplished, generated on task completion. */
  completionDigest?: CompletionDigest;
  /** User feedback on the completed task. Drives the per-task self-reflect loop. */
  completionFeedback?: TaskCompletionFeedback;
  /** Marker present iff this task is itself a reflect spawn analyzing another task. */
  reflectMeta?: ReflectMeta;
  createdAt: Date;
  updatedAt: Date;
  /** Set when the task transitions to 'terminated' via reconciliation. */
  terminatedAt?: Date;
  /**
   * Ralph Wiggum-style iteration loop state. Present only when the task was
   * launched (or upgraded) into Ralph mode. Absence = no loop. See issue #440.
   */
  ralphLoop?: RalphLoopState;
}
