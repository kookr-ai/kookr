/**
 * Core-owned contract for Codex rollout data consumed by cost comparison.
 *
 * The scanner adapter owns how rollout JSONL files are discovered and parsed;
 * the core aggregator owns the accounting rules. Keep this module limited to
 * the DTO shape needed at that boundary so core code does not import adapters.
 */

/** Per-rollout token snapshot, sourced from the last token-count event with non-null info. */
export interface CodexTokenSnapshot {
  /** Codex's input total is gross and includes cached input. Aggregation subtracts cached input before billing. */
  inputTokens: number;
  outputTokens: number;
  /** Subset of inputTokens that was served from prompt cache. */
  cachedInputTokens: number;
  reasoningOutputTokens: number;
}

/** Result of parsing a single Codex rollout file. */
export interface CodexRolloutMeta {
  /** Absolute path to the rollout file. */
  path: string;
  /** Session id, used as the parent_thread_id target by sub-agents. */
  id: string;
  /** Working directory Codex was launched into. */
  cwd: string;
  /** Rollout start time parsed as UTC. */
  startedAt: Date;
  /** Codex CLI version, surfaced for diagnostics and future compatibility. */
  cliVersion: string | null;
  /** Forked-from id chain link for resumed sessions. */
  forkedFromId: string | null;
  /** Sub-agent parent thread id; null on top-level rollouts. */
  parentThreadId: string | null;
  /** Sub-agent nickname when present. */
  agentNickname: string | null;
  /** First non-null model observed in the rollout. */
  model: string | null;
  /** Last-seen token snapshot; null when the rollout has no token telemetry yet. */
  totalUsage: CodexTokenSnapshot | null;
  /** True iff the rollout has a terminal event. */
  hasTerminalEvent: boolean;
  /** File mtime in ms-since-epoch. */
  mtimeMs: number;
  /** Structural parse/schema problem, when present. */
  parseError: string | null;
}

/** Aggregated tokens for a Kookr task: parent rollout plus recursively-bound sub-agents. */
export interface BoundTaskTokens {
  taskId: string;
  parent: CodexRolloutMeta;
  subagents: CodexRolloutMeta[];
  /** Sum of input tokens across parent and sub-agents, gross and still including cached input. */
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedInputTokens: number;
  /**
   * Sum of `reasoning_output_tokens` across parent and sub-agents. Reported
   * separately from `totalOutputTokens` so callers that bill reasoning as
   * output (task metering, issue #1307) can add it while the cost-comparison
   * panel keeps its existing visible-output accounting. Optional for
   * backward-compatibility with bindings constructed before this field.
   */
  totalReasoningOutputTokens?: number;
  /** First non-null model among parent and sub-agents, parent first. */
  model: string | null;
  /** True iff at least one rollout in the binding had token telemetry. */
  hasTokenData: boolean;
  /** True iff at least one rollout in the binding had a parse error. */
  hasParseError: boolean;
}

/**
 * Top-level rollout chain that no Kookr task claimed.
 *
 * Same accounting shape as BoundTaskTokens minus taskId.
 */
export interface OrphanBinding {
  parent: CodexRolloutMeta;
  subagents: CodexRolloutMeta[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedInputTokens: number;
  // Reasoning is summed by the shared thread accountant but orphan bindings feed
  // only the cost-comparison panel, which stays on visible-output accounting, so
  // no `totalReasoningOutputTokens` is surfaced here (it lives on BoundTaskTokens).
  model: string | null;
  hasTokenData: boolean;
  hasParseError: boolean;
}

/** Per-rollout discovery result for a Kookr task. */
export type DiscoveryOutcome =
  | { kind: 'bound'; binding: BoundTaskTokens }
  | { kind: 'not-found'; reason: 'no-candidates' | 'ambiguous'; candidateCount: number }
  | { kind: 'abandoned'; mostRecentRolloutMtimeMs: number };
