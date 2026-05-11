/**
 * Pure-function aggregator for the Cost Comparison panel
 * (rfc-cost-comparison-panel.md, §Design "cost-comparison-aggregator.ts").
 *
 * Produces the full `CostComparisonResponse` body from:
 *   - Kookr `Task[]` snapshot (any agentType — both Claude and Codex)
 *   - Per-task token usage (`tokenTracker.getUsage(taskId)` for Claude;
 *     scanner bindings for Codex)
 *   - Codex scanner orphan/abandoned counts for the notes envelope
 *   - The window definition (`startMs`, `endMs`)
 *
 * No I/O. All I/O lives in `codex-rollout-scanner.ts` (Codex side) and the
 * route handler (`task-routes.ts`). Pure-function unit testing is materially
 * simpler against fixtures than against an HTTP-stack route handler — this
 * separation has been re-litigated three times and is intentional.
 *
 * R17 priority order for notes (server-side pre-sort):
 *   parse-error > unknown-pricing > pricing-stale > missing-tokens > data-staleness
 */

import type { Task } from './tasks.js';
import type { TokenUsage } from './types.js';
import type { Playbook } from '../shared/contracts/playbook.js';
import { lookupPricing, estimateCost, type ModelPricing } from './pricing-tables.js';
import type {
  AggregateMetrics,
  CostAgent,
  CostComparisonNote,
  CostComparisonResponse,
  CostDataQuality,
  PerPlaybookRow,
  PerTaskRow,
  UnboundCodexAggregate,
} from '../shared/contracts/cost-comparison.js';
import { isTerminalStatus } from '../shared/contracts/task-status.js';
import type { DiscoveryOutcome, OrphanBinding } from '../adapters/codex-rollout-scanner.js';

const PRICING_STALE_DAYS = 90;

export interface AggregatorInput {
  /** Task snapshot. Aggregator filters to `[startMs, endMs]` by createdAt. */
  tasks: Task[];
  /** Optional: agent filter ('claude-code' | 'codex-cli'). undefined = both. */
  agentFilter?: CostAgent;
  /** Optional: case-insensitive substring matched against task.name|task.prompt. */
  taskNameQuery?: string;

  windowStartMs: number;
  windowEndMs: number;

  /** Per-Claude-task token usage from TokenTracker.getUsage. Missing entries treated as no-data. */
  claudeUsage: Map<string, TokenUsage>;

  /**
   * Per-Claude-task model id (TokenTracker.getModel). Drives the R17
   * pricing-staleness banner for Anthropic rows; the per-task row itself
   * keeps `model: null` because dated Claude model ids don't round-trip
   * through the panel's strict-exact-match pricing path.
   */
  claudeModels?: Map<string, string | null>;

  /** Per-Codex-task scanner outcome. Missing entry => discovery never ran for this task. */
  codexOutcomes: Map<string, DiscoveryOutcome>;

  /** Discovered playbooks (id → display name). Missing id falls back to id-or-"<no-playbook>". */
  playbooksById: Map<string, Playbook>;

  /** Today's date used for pricing-staleness banner; injected for deterministic tests. */
  todayMs: number;

  /** Codex scanner stats (for the response envelope's notes section). */
  codexStats?: {
    rolloutCount: number;
    parseErrorCount: number;
    abandonedCount: number;
    /**
     * Top-level Codex threads not bound to any Kookr task — each entry covers
     * a parent rollout plus its recursively-summed sub-agents. Drives the
     * `unboundCodex` response field (rfc-cost-comparison-coverage-and-perf.md
     * §Change 2). Empty list ⇒ no orphan card and no "X rollouts not bound" note.
     */
    orphanBindings: OrphanBinding[];
  };

  /** Wall-clock for the response envelope. Allows the route to bracket I/O + aggregation. */
  scannedAt: string;
  scanDurationMs: number;
}

interface PerTaskComputed {
  row: PerTaskRow;
  /** True iff the row should be added to aggregate token sums (data is "complete" enough). */
  contributesToAggregate: boolean;
}

/** Top-level entry. Pure function. */
export function aggregate(input: AggregatorInput): CostComparisonResponse {
  const { windowStartMs, windowEndMs, agentFilter, taskNameQuery, scannedAt, scanDurationMs } = input;

  const queryLower = taskNameQuery?.toLowerCase().trim() ?? '';
  const filteredTasks = input.tasks.filter(t => {
    const created = t.createdAt instanceof Date ? t.createdAt.getTime() : new Date(t.createdAt).getTime();
    if (created < windowStartMs || created > windowEndMs) return false;
    if (agentFilter && t.agentType !== agentFilter) return false;
    if (queryLower) {
      const hay = `${t.name ?? ''} ${t.prompt ?? ''}`.toLowerCase();
      if (!hay.includes(queryLower)) return false;
    }
    return t.agentType === 'claude-code' || t.agentType === 'codex-cli';
  });

  const perTask: PerTaskRow[] = [];
  const aggregateInputs: Map<CostAgent, AggregateMetrics> = new Map();
  const perPlaybook: Map<string | null, PerPlaybookRow> = new Map();

  // Track unknown-model strings so we surface them once in notes (R17 ordering).
  const unknownModels = new Set<string>();
  const stalePricingByModel = new Map<string, string>();          // model -> ISO lastVerified
  const parseErrorPaths: string[] = [];

  for (const task of filteredTasks) {
    const agent = task.agentType as CostAgent;
    const computed = computePerTaskRow(task, agent, input);
    perTask.push(computed.row);

    if (computed.row.dataQuality === 'codex-parse-error' && computed.row.taskId) {
      const o = input.codexOutcomes.get(task.id);
      if (o?.kind === 'bound') parseErrorPaths.push(o.binding.parent.path);
    }
    if (computed.row.dataQuality === 'unknown-pricing' && computed.row.model) {
      unknownModels.add(computed.row.model);
    }
    // Pricing staleness is a separate concern from unknown-pricing (the row IS priced; the date is old).
    // For Codex, the row carries `model` directly. For Claude, dated model ids don't round-trip through
    // exact-match pricing, so we check staleness via the side-channel `claudeModels` map populated
    // by the route handler from TokenTracker.getModel.
    if (computed.row.dataQuality === 'complete' && computed.row.model) {
      const pricing = lookupPricing(computed.row.model);
      if (pricing && isPricingStale(pricing, input.todayMs)) {
        stalePricingByModel.set(computed.row.model, pricing.lastVerified);
      }
    }
    if (agent === 'claude-code' && input.claudeModels) {
      const claudeModel = input.claudeModels.get(task.id);
      if (claudeModel) {
        const pricing = lookupPricing(claudeModel);
        if (pricing && isPricingStale(pricing, input.todayMs)) {
          stalePricingByModel.set(claudeModel, pricing.lastVerified);
        }
      }
    }

    accumulateAggregate(agent, computed, aggregateInputs);
    accumulatePerPlaybook(task, agent, computed, perPlaybook, input.playbooksById);
  }

  // Finalize p50/p95/max + thumbsUpRate for aggregate + per-playbook.
  finalizeAggregateMetrics(aggregateInputs);
  for (const row of perPlaybook.values()) {
    for (const m of Object.values(row.perAgent) as AggregateMetrics[]) finalizeMetricsRow(m);
  }

  // Per-playbook: drop rows with no agent having ≥1 task in window (defensive — should not happen).
  // Then sort: bind-quality first (alphabetic by name).
  const perPlaybookList = Array.from(perPlaybook.values())
    .filter(r => Object.keys(r.perAgent).length > 0)
    .sort((a, b) => a.playbookName.localeCompare(b.playbookName));

  const aggregateOut: Partial<Record<CostAgent, AggregateMetrics>> = {};
  for (const [agent, metrics] of aggregateInputs) {
    aggregateOut[agent] = metrics;
  }

  // Unbound-Codex aggregate (rfc-cost-comparison-coverage-and-perf.md §Change 2).
  // Suppressed when the user filtered to "claude-code" — under that filter the
  // user is asking "show me Claude data," and unbound Codex is irrelevant.
  // Window-filter orphans by parent rollout start time so a 24h view can't
  // show a 26h-old orphan (collectPaths walks [start-1d, end+1d]).
  const allOrphanBindings = input.codexStats?.orphanBindings ?? [];
  const inWindowOrphans = allOrphanBindings.filter(b => {
    const t = b.parent.startedAt instanceof Date
      ? b.parent.startedAt.getTime()
      : new Date(b.parent.startedAt).getTime();
    return Number.isFinite(t) && t >= windowStartMs && t <= windowEndMs;
  });
  const unboundCodex = (agentFilter === 'claude-code' || inWindowOrphans.length === 0)
    ? undefined
    : computeUnboundCodexAggregate(inWindowOrphans, input.todayMs, unknownModels, stalePricingByModel);
  const visibleAbandonedCount = perTask.filter(r => r.dataQuality === 'codex-rollout-abandoned').length;

  const notes = buildNotes({
    parseErrorPaths,
    parseErrorCount: input.codexStats?.parseErrorCount ?? 0,
    unknownModels,
    stalePricingByModel,
    abandonedCount: visibleAbandonedCount,
    // Always emit the orphan note when there are in-window orphans. The note
    // and the coverage caveat complement each other: the caveat shows summed
    // metrics, the note states the count + diagnostic. Old clients ignore
    // `unboundCodex` and rely on the note alone to surface the signal.
    showOrphanNote: unboundCodex !== undefined,
    orphanCount: inWindowOrphans.length,
    codexHomeMissing: (input.codexStats?.rolloutCount ?? 0) === 0
                      && filteredTasks.some(t => t.agentType === 'codex-cli'),
  });
  const coverage = buildCoverage({
    perTask,
    visibleOrphanCount: unboundCodex ? inWindowOrphans.length : 0,
    abandonedCount: visibleAbandonedCount,
  });

  return {
    scannedAt,
    scanDurationMs,
    perPlaybook: perPlaybookList,
    aggregate: aggregateOut,
    perTask: sortPerTaskByStartedAt(perTask),
    notes,
    coverage,
    ...(unboundCodex ? { unboundCodex } : {}),
  };
}

function buildCoverage(input: {
  perTask: PerTaskRow[];
  visibleOrphanCount: number;
  abandonedCount: number;
}): CostComparisonResponse['coverage'] {
  const pricedTaskCount = input.perTask.filter(r => r.dataQuality === 'complete').length;
  const runningTaskCount = input.perTask.filter(r => r.status === 'inProgress').length;
  return {
    taskCount: input.perTask.length,
    pricedTaskCount,
    excludedTaskCount: input.perTask.length - pricedTaskCount,
    unboundCodexThreadCount: input.visibleOrphanCount,
    abandonedCodexRolloutCount: input.abandonedCount,
    runningTaskCount,
    liveData: runningTaskCount > 0,
  };
}

/**
 * Sum orphan bindings into the wire-shape `UnboundCodexAggregate`.
 *
 * Symmetry with bound `AggregateMetrics`:
 *   - Only `complete` rows contribute to `totalCostUsd` and the token sums.
 *     unknown-pricing / no-tokens / parse-error rows are excluded from the
 *     sums but counted in `dataQualityCounts`.
 *   - Unknown models flow into the shared `unknownModels` set so the existing
 *     R17 unknown-pricing banner enumerates them once across bound + unbound.
 *   - Stale-priced models flow into `stalePricingByModel` so the staleness
 *     banner fires when only the orphan corpus exercises a stale model.
 */
function computeUnboundCodexAggregate(
  orphanBindings: OrphanBinding[],
  todayMs: number,
  unknownModels: Set<string>,
  stalePricingByModel: Map<string, string>,
): UnboundCodexAggregate {
  let totalInput = 0;
  let totalOutput = 0;
  let totalCached = 0;
  let totalCostUsd = 0;
  const dataQualityCounts: UnboundCodexAggregate['dataQualityCounts'] = {
    'complete': 0,
    'unknown-pricing': 0,
    'codex-no-tokens': 0,
    'codex-parse-error': 0,
  };

  for (const b of orphanBindings) {
    if (b.hasParseError) {
      dataQualityCounts['codex-parse-error']++;
      continue;
    }
    if (!b.hasTokenData) {
      dataQualityCounts['codex-no-tokens']++;
      continue;
    }
    const pricing = b.model ? lookupPricing(b.model) : null;
    if (!pricing) {
      dataQualityCounts['unknown-pricing']++;
      if (b.model) unknownModels.add(b.model);
      continue;
    }
    if (isPricingStale(pricing, todayMs) && b.model) {
      stalePricingByModel.set(b.model, pricing.lastVerified);
    }
    const billedInput = Math.max(0, b.totalInputTokens - b.totalCachedInputTokens);
    totalInput += billedInput;
    totalOutput += b.totalOutputTokens;
    totalCached += b.totalCachedInputTokens;
    totalCostUsd += estimateCost(billedInput, b.totalOutputTokens, /* write */ 0, b.totalCachedInputTokens, pricing);
    dataQualityCounts['complete']++;
  }

  return {
    threadCount: orphanBindings.length,
    totalCostUsd,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    totalCachedInputTokens: totalCached,
    dataQualityCounts,
  };
}

function computePerTaskRow(task: Task, agent: CostAgent, input: AggregatorInput): PerTaskComputed {
  const startedAtMs = task.createdAt instanceof Date ? task.createdAt.getTime() : new Date(task.createdAt).getTime();
  const updatedAtMs = task.updatedAt instanceof Date ? task.updatedAt.getTime() : new Date(task.updatedAt).getTime();
  const isTerminal = isTerminalStatus(task.status);
  const durationMs = isTerminal && updatedAtMs > startedAtMs ? updatedAtMs - startedAtMs : null;

  if (agent === 'claude-code') {
    return computeClaudeRow(task, startedAtMs, durationMs, isTerminal, input);
  }
  return computeCodexRow(task, startedAtMs, durationMs, isTerminal, input);
}

function computeClaudeRow(
  task: Task, startedAtMs: number, durationMs: number | null, isTerminal: boolean, input: AggregatorInput,
): PerTaskComputed {
  // Prefer the live TokenTracker reading from claudeUsage; fall back to the persisted
  // `task.tokenUsage` snapshot for completed tasks whose transcript is no longer registered.
  // Missing usage is not a verified zero-cost task; surface it explicitly.
  const usage = input.claudeUsage.get(task.id) ?? task.tokenUsage ?? null;
  const fb = task.completionFeedback?.rating;
  const thumb: 'up' | 'down' | null = fb === 'up' ? 'up' : fb === 'down' ? 'down' : null;

  if (!usage) {
    return {
      row: {
        taskId: task.id, agent: 'claude-code', model: null, playbookId: task.playbookId ?? null,
        startedAt: new Date(startedAtMs).toISOString(), status: task.status, isTerminal, durationMs,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        estimatedCostUsd: null, thumb, dataQuality: 'missing-usage',
      },
      contributesToAggregate: false,
    };
  }

  return {
    row: {
      taskId: task.id, agent: 'claude-code', model: null, playbookId: task.playbookId ?? null,
      startedAt: new Date(startedAtMs).toISOString(), status: task.status, isTerminal, durationMs,
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens,
      estimatedCostUsd: usage.costUsd, thumb, dataQuality: 'complete',
    },
    contributesToAggregate: true,
  };
}

function computeCodexRow(
  task: Task, startedAtMs: number, durationMs: number | null, isTerminal: boolean, input: AggregatorInput,
): PerTaskComputed {
  const fb = task.completionFeedback?.rating;
  const thumb: 'up' | 'down' | null = fb === 'up' ? 'up' : fb === 'down' ? 'down' : null;
  const outcome = input.codexOutcomes.get(task.id);

  // Default: discovery did not match.
  if (!outcome) {
    return {
      row: {
        taskId: task.id, agent: 'codex-cli', model: null, playbookId: task.playbookId ?? null,
        startedAt: new Date(startedAtMs).toISOString(), status: task.status, isTerminal, durationMs,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        estimatedCostUsd: null, thumb, dataQuality: 'codex-rollout-not-found',
      },
      contributesToAggregate: false,
    };
  }

  if (outcome.kind === 'abandoned') {
    return {
      row: {
        taskId: task.id, agent: 'codex-cli', model: null, playbookId: task.playbookId ?? null,
        startedAt: new Date(startedAtMs).toISOString(), status: task.status, isTerminal, durationMs,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        estimatedCostUsd: null, thumb, dataQuality: 'codex-rollout-abandoned',
      },
      contributesToAggregate: false,
    };
  }

  if (outcome.kind === 'not-found') {
    return {
      row: {
        taskId: task.id, agent: 'codex-cli', model: null, playbookId: task.playbookId ?? null,
        startedAt: new Date(startedAtMs).toISOString(), status: task.status, isTerminal, durationMs,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        estimatedCostUsd: null, thumb, dataQuality: 'codex-rollout-not-found',
      },
      contributesToAggregate: false,
    };
  }

  const binding = outcome.binding;
  if (binding.hasParseError) {
    return {
      row: {
        taskId: task.id, agent: 'codex-cli', model: binding.model, playbookId: task.playbookId ?? null,
        startedAt: new Date(startedAtMs).toISOString(), status: task.status, isTerminal, durationMs,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        estimatedCostUsd: null, thumb, dataQuality: 'codex-parse-error',
      },
      contributesToAggregate: false,
    };
  }

  if (!binding.hasTokenData) {
    return {
      row: {
        taskId: task.id, agent: 'codex-cli', model: binding.model, playbookId: task.playbookId ?? null,
        startedAt: new Date(startedAtMs).toISOString(), status: task.status, isTerminal, durationMs,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        estimatedCostUsd: null, thumb, dataQuality: 'codex-no-tokens',
      },
      contributesToAggregate: false,
    };
  }

  // Pricing lookup (strict). Codex's gross input includes cached — pre-subtract before billing.
  // The wire shape stores the NET input on `inputTokens` (`gross - cached`) so cross-agent
  // aggregate sums are apples-to-apples with Claude's already-net `TokenUsage.inputTokens`.
  const pricing = binding.model ? lookupPricing(binding.model) : null;
  const billedInput = Math.max(0, binding.totalInputTokens - binding.totalCachedInputTokens);
  const estimatedCostUsd = pricing
    ? estimateCost(billedInput, binding.totalOutputTokens, /* write */ 0, binding.totalCachedInputTokens, pricing)
    : null;

  const dataQuality: CostDataQuality = pricing ? 'complete' : 'unknown-pricing';

  return {
    row: {
      taskId: task.id, agent: 'codex-cli', model: binding.model, playbookId: task.playbookId ?? null,
      startedAt: new Date(startedAtMs).toISOString(), status: task.status, isTerminal, durationMs,
      inputTokens: billedInput,
      outputTokens: binding.totalOutputTokens,
      cacheReadTokens: binding.totalCachedInputTokens,
      cacheWriteTokens: 0,                                                  // OpenAI rollouts do not bill cache writes
      estimatedCostUsd, thumb, dataQuality,
    },
    contributesToAggregate: dataQuality === 'complete',
  };
}

interface MetricsAccumulator extends AggregateMetrics {
  /** Internal: durations collected for percentile calc. */
  _durations: number[];
}

function accumulateAggregate(
  agent: CostAgent,
  computed: PerTaskComputed,
  acc: Map<CostAgent, AggregateMetrics>,
): void {
  let m = acc.get(agent) as MetricsAccumulator | undefined;
  if (!m) {
    m = makeEmptyMetrics(agent) as MetricsAccumulator;
    acc.set(agent, m);
  }
  m.taskCount++;
  if (computed.row.thumb === 'up') m.thumbsCount.up++;
  else if (computed.row.thumb === 'down') m.thumbsCount.down++;
  else m.thumbsCount.none++;

  if (computed.row.durationMs != null) m._durations.push(computed.row.durationMs);

  if (!computed.contributesToAggregate) return;
  m.pricedTaskCount++;
  m.totalCostUsd += computed.row.estimatedCostUsd ?? 0;
  m.inputTokens += computed.row.inputTokens;
  m.outputTokens += computed.row.outputTokens;
  m.cacheReadTokens += computed.row.cacheReadTokens;
  m.cacheWriteTokens += computed.row.cacheWriteTokens;
}

function accumulatePerPlaybook(
  task: Task, agent: CostAgent, computed: PerTaskComputed,
  perPlaybook: Map<string | null, PerPlaybookRow>,
  playbooksById: Map<string, Playbook>,
): void {
  const id = task.playbookId ?? null;
  const name = id == null
    ? '<no-playbook>'
    : (playbooksById.get(id)?.name ?? id);
  let row = perPlaybook.get(id);
  if (!row) {
    row = { playbookId: id, playbookName: name, perAgent: {} };
    perPlaybook.set(id, row);
  }
  let m = row.perAgent[agent] as MetricsAccumulator | undefined;
  if (!m) {
    m = makeEmptyMetrics(agent) as MetricsAccumulator;
    row.perAgent[agent] = m;
  }
  m.taskCount++;
  if (computed.row.thumb === 'up') m.thumbsCount.up++;
  else if (computed.row.thumb === 'down') m.thumbsCount.down++;
  else m.thumbsCount.none++;
  if (computed.row.durationMs != null) m._durations.push(computed.row.durationMs);
  if (!computed.contributesToAggregate) return;
  m.pricedTaskCount++;
  m.totalCostUsd += computed.row.estimatedCostUsd ?? 0;
  m.inputTokens += computed.row.inputTokens;
  m.outputTokens += computed.row.outputTokens;
  m.cacheReadTokens += computed.row.cacheReadTokens;
  m.cacheWriteTokens += computed.row.cacheWriteTokens;
}

function makeEmptyMetrics(agent: CostAgent): AggregateMetrics & { _durations: number[] } {
  return {
    agent, taskCount: 0, pricedTaskCount: 0,
    totalCostUsd: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    medianDurationMs: 0, p95DurationMs: 0, maxDurationMs: 0,
    thumbsUpRate: null, thumbsCount: { up: 0, down: 0, none: 0 },
    _durations: [],
  };
}

function finalizeAggregateMetrics(acc: Map<CostAgent, AggregateMetrics>): void {
  for (const m of acc.values()) finalizeMetricsRow(m);
}

function finalizeMetricsRow(m: AggregateMetrics): void {
  const am = m as MetricsAccumulator;
  if (am._durations.length) {
    const sorted = am._durations.slice().sort((a, b) => a - b);
    m.medianDurationMs = pct(sorted, 0.5);
    m.p95DurationMs = pct(sorted, 0.95);
    m.maxDurationMs = sorted[sorted.length - 1];
  }
  // thumbsUpRate denominator: tasks with a recorded thumb (up + down). Tasks without feedback
  // are excluded from the denominator so a low feedback-coverage agent isn't unfairly penalized.
  const fbDenom = m.thumbsCount.up + m.thumbsCount.down;
  m.thumbsUpRate = fbDenom > 0 ? m.thumbsCount.up / fbDenom : null;
  // Strip the internal accumulator fields so the wire shape is clean.
  delete (am as Partial<MetricsAccumulator>)._durations;
}

function pct(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  const frac = idx - lo;
  return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac;
}

function sortPerTaskByStartedAt(rows: PerTaskRow[]): PerTaskRow[] {
  return rows.slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function isPricingStale(p: ModelPricing, todayMs: number): boolean {
  const verified = new Date(p.lastVerified).getTime();
  if (!isFinite(verified)) return true;
  return (todayMs - verified) > PRICING_STALE_DAYS * 24 * 60 * 60 * 1000;
}

interface NotesInput {
  parseErrorPaths: string[];
  parseErrorCount: number;
  unknownModels: Set<string>;
  stalePricingByModel: Map<string, string>;
  abandonedCount: number;
  /** True when the orphan caveat is visible and the count should also surface as a note. */
  showOrphanNote: boolean;
  orphanCount: number;
  codexHomeMissing: boolean;
}

/**
 * Build the notes envelope per R17 priority order:
 *   parse-error > unknown-pricing > pricing-stale > missing-tokens > data-staleness
 * The frontend renders top 3 inline; the rest are collapsed under an expander.
 */
function buildNotes(input: NotesInput): CostComparisonNote[] {
  const out: CostComparisonNote[] = [];

  // 1. parse-error (highest priority — operator must investigate)
  if (input.parseErrorCount > 0) {
    out.push({
      message: `${input.parseErrorCount} Codex rollout file${input.parseErrorCount === 1 ? '' : 's'} had parse errors — see startup log`,
      paths: input.parseErrorPaths.slice(0, 5),
    });
  }

  // 2. unknown-pricing (panel needs a pricing-tables.ts entry for these models)
  if (input.unknownModels.size > 0) {
    const list = Array.from(input.unknownModels).sort();
    out.push({
      message: `Unknown pricing for model${list.length === 1 ? '' : 's'}: ${list.join(', ')} — add a row to pricing-tables.ts`,
    });
  }

  // 3. pricing-stale (rates may have shifted since lastVerified)
  if (input.stalePricingByModel.size > 0) {
    for (const [model, lastVerified] of input.stalePricingByModel) {
      out.push({
        message: `Pricing for ${model} was last verified on ${lastVerified}; re-check vendor pricing page`,
      });
    }
  }

  // 4. missing-tokens (Codex pre-Nov-2025 rollouts) — surfaced as a count-style note via abandoned + outcome states
  if (input.abandonedCount > 0) {
    out.push({
      message: `${input.abandonedCount} abandoned Codex rollout${input.abandonedCount === 1 ? '' : 's'} excluded (no terminal event, mtime > 24 h)`,
    });
  }

  // 5. data-staleness (Codex sessions outside Kookr — informational)
  if (input.codexHomeMissing) {
    out.push({
      message: 'Codex session directory not found — only Claude-side data is shown',
    });
  } else if (input.showOrphanNote) {
    out.push({
      message: `${input.orphanCount} Codex rollout${input.orphanCount === 1 ? '' : 's'} not bound to any Kookr task (interactive Codex usage, etc.) — see coverage caveats on the All filter`,
    });
  }

  return out;
}
