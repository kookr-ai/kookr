import type { TaskStatus } from '../../core/types.js';

/**
 * Wire types for the Cost Comparison panel.
 *
 * See docs/rfc/rfc-cost-comparison-panel.md §Aggregate metric shapes for the
 * canonical definitions; these types are imported by both the server (via
 * `core/cost-comparison-aggregator.ts`) and the frontend (via
 * `frontend/components/CostComparisonPanel.tsx`), and must stay byte-identical
 * on the wire.
 */

export type CostAgent = 'claude-code' | 'codex-cli';

/**
 * Seven-state discriminant per the RFC's §Aggregate metric shapes. Each state maps to
 * a distinct operator investigation path; tooltips differ per state on the panel.
 *
 * Adding a new state is a wire-compat change — frontend, aggregator, and tests
 * must all be updated in one PR.
 */
export type CostDataQuality =
  | 'complete'
  | 'missing-usage'
  | 'unknown-pricing'
  | 'codex-parse-error'
  | 'codex-no-tokens'
  | 'codex-rollout-not-found'
  | 'codex-rollout-abandoned';

export type TimeWindow = '24h' | '7d' | '30d' | 'all';

export type CostTaskStatus = TaskStatus;

export interface AggregateMetrics {
  agent: CostAgent;
  /** All task rows for this agent, including rows excluded from cost/token sums. */
  taskCount: number;
  /** Rows whose dataQuality === 'complete'; this is the denominator for cost averages. */
  pricedTaskCount: number;
  /** Estimated dollars; excludes tasks whose dataQuality !== 'complete'. */
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  medianDurationMs: number;
  p95DurationMs: number;
  maxDurationMs: number;
  /** null when no feedback has been recorded in the window. */
  thumbsUpRate: number | null;
  thumbsCount: { up: number; down: number; none: number };
}

export interface PerPlaybookRow {
  /** null bucket = tasks with no playbookId. */
  playbookId: string | null;
  playbookName: string;
  perAgent: Partial<Record<CostAgent, AggregateMetrics>>;
}

export interface PerTaskRow {
  taskId: string;
  agent: CostAgent;
  model: string | null;
  playbookId: string | null;
  startedAt: string;
  status: CostTaskStatus;
  isTerminal: boolean;
  durationMs: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** null when dataQuality blocks pricing. */
  estimatedCostUsd: number | null;
  thumb: 'up' | 'down' | null;
  dataQuality: CostDataQuality;
}

/**
 * Operator-facing note attached to a response. Server pre-sorts by R17 priority
 * (parse-error > unknown-pricing > pricing-stale > missing-tokens > data-staleness);
 * the client renders top 3 inline and collapses the rest.
 */
export interface CostComparisonNote {
  message: string;
  paths?: string[];
}

export interface CostComparisonCoverage {
  taskCount: number;
  pricedTaskCount: number;
  excludedTaskCount: number;
  unboundCodexThreadCount: number;
  abandonedCodexRolloutCount: number;
  runningTaskCount: number;
  liveData: boolean;
}

/**
 * Aggregate of Codex threads that exist on disk but bind to no Kookr task —
 * either swept tasks whose snapshot has rolled out of retention, or interactive
 * Codex sessions started outside Kookr. Surfaced as a coverage caveat so
 * cross-agent spend totals remain truthful without polluting per-playbook attribution
 * (rfc-cost-comparison-coverage-and-perf.md §Change 2).
 *
 * Suppressed when the agent filter is "claude-code" — under that filter the
 * user is asking "show me Claude data," and unbound Codex is irrelevant.
 *
 * Cost contract (matches the bound `AggregateMetrics` convention):
 *   - `totalCostUsd` is the sum across rows whose `dataQuality === 'complete'`.
 *     Rows with unknown-pricing / no-tokens / parse-error contribute 0.
 *   - `dataQualityCounts.unknown-pricing` lets the user tell whether the total
 *     is a complete picture or a known-incomplete lower bound. The R17
 *     unknown-pricing banner in `notes` enumerates the missing models.
 *
 * `threadCount` counts top-level Codex threads (parent rollout + recursively
 * summed sub-agents = 1 thread). A single interactive session that spawned
 * 50 sub-agents counts as 1, not 51 — matches the bound-task accounting.
 */
export interface UnboundCodexAggregate {
  /** Top-level threads in the bucket (parent + sub-agent thread = 1). */
  threadCount: number;
  /**
   * Sum across `complete` rows only. `0` when the bucket has no priced rows
   * (vs. bound aggregate this means the same thing it does there).
   */
  totalCostUsd: number;
  /** Net input tokens (gross minus cached) summed across `complete` rows only. */
  totalInputTokens: number;
  /** Output tokens summed across `complete` rows only. */
  totalOutputTokens: number;
  /** Cached-input tokens summed across `complete` rows only. */
  totalCachedInputTokens: number;
  /** Counts of threads by data quality. Excluded states (abandoned, rollout-not-found) are not in the bucket. */
  dataQualityCounts: {
    complete: number;
    'unknown-pricing': number;
    'codex-no-tokens': number;
    'codex-parse-error': number;
  };
}

export interface CostComparisonResponse {
  scannedAt: string;
  scanDurationMs: number;
  perPlaybook: PerPlaybookRow[];
  aggregate: Partial<Record<CostAgent, AggregateMetrics>>;
  perTask: PerTaskRow[];
  notes: CostComparisonNote[];
  coverage?: CostComparisonCoverage;
  /** Optional — present when the agent filter is "all" or "codex-cli" and at least one orphan rollout was scanned. */
  unboundCodex?: UnboundCodexAggregate;
}
