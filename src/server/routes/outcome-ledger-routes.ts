import type { Hono } from 'hono';
import { buildOutcomeLedger } from '../../core/outcome-ledger.js';
import { readInteractionLog } from '../../core/interaction-log.js';
import type { TokenUsage } from '../../core/usage-types.js';
import type { TimeWindow } from '../../shared/contracts/cost-comparison.js';
import { loadHistoricalTasks } from '../use-cases/load-historical-tasks.js';
import type { OutcomeLedgerRouteDeps } from './shared.js';

const WINDOWS: ReadonlySet<TimeWindow> = new Set(['24h', '7d', '30d', 'all']);

export function registerOutcomeLedgerRoutes(app: Hono, deps: OutcomeLedgerRouteDeps): void {
  app.get('/api/outcome-ledger', async (c) => {
    const window = parseWindow(c.req.query('window'));
    const now = Date.now();
    const windowEndMs = now;
    const windowStartMs = window === '24h' ? now - 24 * 60 * 60 * 1000
      : window === '7d' ? now - 7 * 24 * 60 * 60 * 1000
      : window === '30d' ? now - 30 * 24 * 60 * 60 * 1000
      : 0;

    const liveTasks = deps.taskStore.listTasks();
    const liveTaskIds = new Set(liveTasks.map((task) => task.id));
    const tasks = deps.tasksFile
      ? await loadHistoricalTasks(liveTasks, deps.tasksFile)
      : liveTasks;

    const liveUsage = new Map<string, TokenUsage>();
    if (deps.tokenTracker) {
      for (const task of tasks) {
        const usage = deps.tokenTracker.getUsage(task.id);
        if (usage) liveUsage.set(task.id, usage);
      }
    }

    const interactionPath = deps.interactionLog?.getFilePath();
    const interactionEvents = interactionPath ? await readInteractionLog(interactionPath) : undefined;

    return c.json(buildOutcomeLedger({
      tasks,
      window,
      windowStartMs,
      windowEndMs,
      liveUsage,
      liveTaskIds,
      interactionEvents,
      interactionTaskIds: interactionEvents ? liveTaskIds : undefined,
    }));
  });
}

function parseWindow(value: string | undefined): TimeWindow {
  if (value && WINDOWS.has(value as TimeWindow)) return value as TimeWindow;
  return '7d';
}
