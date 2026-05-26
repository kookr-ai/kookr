import type { Hono } from 'hono';
import { discoverPlaybooks } from '../../core/playbook-discovery.js';
import { CodexRolloutScanner } from '../../adapters/codex-rollout-scanner.js';
import { aggregate as aggregateCostComparison } from '../../core/cost-comparison-aggregator.js';
import type { CostAgent, TimeWindow } from '../../shared/contracts/cost-comparison.js';
import { clampScanStart, loadHistoricalTasks } from '../use-cases/load-historical-tasks.js';
import type { CostComparisonRouteDeps } from './shared.js';

// ---------------------------------------------------------------------------
// Cost comparison (rfc-cost-comparison-panel.md). Read-only telemetry route.
// Originally flag-gated behind KOOKR_COST_PANEL=1 for PR 3 rollback safety;
// ungated post-merge once the panel proved stable.
// ---------------------------------------------------------------------------

export function registerCostComparisonRoutes(app: Hono, deps: CostComparisonRouteDeps): void {
  const { taskStore, serverCwd } = deps;

  app.get('/api/cost-comparison', async (c) => {
    const tokenTracker = deps.tokenTracker;
    if (!tokenTracker) return c.json({ error: 'token tracker not wired' }, 500);

    const window = (c.req.query('window') ?? '7d') as TimeWindow;
    const agentParam = c.req.query('agent');
    const agentFilter: CostAgent | undefined =
      agentParam === 'claude-code' || agentParam === 'codex-cli' ? agentParam : undefined;
    const taskNameQuery = c.req.query('q');

    const now = Date.now();
    const windowEndMs = now;
    const windowStartMs =
      window === '24h' ? now - 24 * 60 * 60 * 1000
      : window === '7d' ? now - 7 * 24 * 60 * 60 * 1000
      : window === '30d' ? now - 30 * 24 * 60 * 60 * 1000
      : 0;                                                          // 'all' → epoch

    // Codex side: scan + bind. The scanner is a per-route singleton so its
    // (path, mtime) cache survives across requests.
    const scanner = costScannerSingleton;
    // Union live + on-disk snapshots. The live store only holds currently-visible
    // tasks; everything swept lives in tasks.json.daily.* / tasks.json.predelete.*.
    // Without this union the panel renders structurally empty against any swept
    // task history (rfc-cost-comparison-coverage-and-perf.md §Change 1).
    const liveTasks = taskStore.listTasks();
    const tasks = deps.tasksFile
      ? await loadHistoricalTasks(liveTasks, deps.tasksFile)
      : liveTasks;
    const codexTasks = tasks
      .filter(t => t.agentType === 'codex-cli')
      .map(t => {
        // Use the first session's cwd (the actual cwd Codex saw) when present;
        // task.cwd is the user-supplied launch cwd which may differ.
        const sessionCwd = t.sessions[0]?.cwd;
        const created = t.createdAt instanceof Date ? t.createdAt.getTime() : new Date(t.createdAt).getTime();
        return { taskId: t.id, cwd: sessionCwd ?? t.cwd, createdAtMs: created };
      });

    // Clamp the directory walk so window=all stops walking 57 years of empty
    // UTC date directories (rfc-cost-comparison-coverage-and-perf.md §Change 3).
    const effectiveScanStartMs = clampScanStart(windowStartMs, windowEndMs, tasks);

    const scanStart = Date.now();
    let scan;
    try {
      scan = await scanner.scan(effectiveScanStartMs, windowEndMs, { signal: c.req.raw.signal });
    } catch (err) {
      if (isAbortError(err)) {
        return new Response(null, { status: 499 });
      }
      throw err;
    }
    const { outcomes, orphanBindings } = scanner.bindTasks(scan.rollouts, codexTasks);

    // Claude side: pull live token usage and the resolved model id (used by the aggregator
    // to drive the R17 pricing-staleness banner — Claude per-task rows themselves keep
    // model:null because dated Claude ids don't round-trip through exact-match pricing).
    const claudeUsage = new Map<string, NonNullable<ReturnType<typeof tokenTracker.getUsage>>>();
    const claudeModels = new Map<string, string | null>();
    for (const t of tasks) {
      if (t.agentType !== 'claude-code') continue;
      const u = tokenTracker.getUsage(t.id);
      if (u) claudeUsage.set(t.id, u);
      claudeModels.set(t.id, tokenTracker.getModel(t.id));
    }

    // Resolve playbooks for displayName. discoverPlaybooks reads .kookr/playbooks/
    // in the server cwd; missing entries fall back to the id string.
    let playbooksById = new Map<string, import('../../shared/contracts/playbook.js').Playbook>();
    try {
      const playbooks = await discoverPlaybooks(serverCwd);
      playbooksById = new Map(playbooks.map(p => [p.id, p]));
    } catch {
      // discovery failure is non-fatal — the panel still renders with id strings.
    }

    const response = aggregateCostComparison({
      tasks, agentFilter, taskNameQuery,
      windowStartMs, windowEndMs,
      claudeUsage, claudeModels, codexOutcomes: outcomes,
      playbooksById,
      todayMs: now,
      codexStats: {
        rolloutCount: scan.stats.rolloutCount,
        parseErrorCount: scan.stats.parseErrorCount,
        abandonedCount: scan.stats.abandonedCount,
        orphanBindings,
      },
      scannedAt: new Date().toISOString(),
      scanDurationMs: Date.now() - scanStart,
    });

    return c.json(response);
  });
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

// Singleton scanner — its in-memory (path, mtime) cache outlives a single
// request so warm scans hit the < 200 ms target (R6).
const costScannerSingleton = new CodexRolloutScanner();
