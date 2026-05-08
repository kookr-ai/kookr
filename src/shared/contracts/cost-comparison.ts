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
 * Six-state discriminant per the RFC's §Aggregate metric shapes. Each state maps to
 * a distinct operator investigation path; tooltips differ per state on the panel.
 *
 * Adding a new state is a wire-compat change — frontend, aggregator, and tests
 * must all be updated in one PR.
 */
export type CostDataQuality =
  | 'complete'
  | 'unknown-pricing'
  | 'codex-parse-error'
  | 'codex-no-tokens'
  | 'codex-rollout-not-found'
  | 'codex-rollout-abandoned';

export type TimeWindow = '24h' | '7d' | '30d' | 'all';

export interface AggregateMetrics {
  agent: CostAgent;
  taskCount: number;
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

export interface CostComparisonResponse {
  scannedAt: string;
  scanDurationMs: number;
  perPlaybook: PerPlaybookRow[];
  aggregate: Partial<Record<CostAgent, AggregateMetrics>>;
  perTask: PerTaskRow[];
  notes: CostComparisonNote[];
}
