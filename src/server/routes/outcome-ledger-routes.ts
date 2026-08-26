import type { Hono } from 'hono';
import { buildOutcomeLedger } from '../../core/outcome-ledger.js';
import { readInteractionLog } from '../../core/interaction-log.js';
import type { TokenUsage } from '../../core/usage-types.js';
import type { TimeWindow } from '../../shared/contracts/cost-comparison.js';
import type { OutcomeLedgerProjectScope } from '../../shared/contracts/outcome-ledger.js';
import { loadHistoricalTasks } from '../use-cases/load-historical-tasks.js';
import type { OutcomeLedgerRouteDeps } from './shared.js';

const WINDOWS: ReadonlySet<TimeWindow> = new Set(['24h', '7d', '30d', 'all']);

export function registerOutcomeLedgerRoutes(app: Hono, deps: OutcomeLedgerRouteDeps): void {
  app.get('/api/outcome-ledger', async (c) => {
    const window = parseWindow(c.req.query('window'));
    const scopeResult = parseProjectScope(c.req.query('projectScope'), c.req.query('projectId'));
    if (!scopeResult.ok) {
      return c.json({ error: scopeResult.error, message: scopeResult.message }, 400);
    }
    const projectScope = scopeResult.scope;
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
      projectScope,
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

type ProjectScopeParse =
  | { ok: true; scope: OutcomeLedgerProjectScope }
  | { ok: false; error: string; message: string };

/**
 * Resolve the `projectScope` + `projectId` query pair into a scope, rejecting
 * ambiguous or conflicting combinations with a client error (issue #2850).
 *
 * `projectId` carries identity only; the scope kind is a separate discriminant,
 * so `Unassigned` needs no magic ID and an assigned scope never collides with a
 * reserved word. A `projectId` present without `projectScope=assigned` — or an
 * `assigned` scope with no `projectId` — is a conflict, not a silent fallback.
 */
function parseProjectScope(
  scopeValue: string | undefined,
  projectId: string | undefined,
): ProjectScopeParse {
  const hasProjectId = projectId !== undefined && projectId !== '';

  if (scopeValue === undefined || scopeValue === 'all') {
    if (hasProjectId) {
      return {
        ok: false,
        error: 'conflicting-project-scope',
        message: 'projectId is only valid with projectScope=assigned.',
      };
    }
    return { ok: true, scope: { kind: 'all' } };
  }

  if (scopeValue === 'unassigned') {
    if (hasProjectId) {
      return {
        ok: false,
        error: 'conflicting-project-scope',
        message: 'projectId must not be supplied with projectScope=unassigned.',
      };
    }
    return { ok: true, scope: { kind: 'unassigned' } };
  }

  if (scopeValue === 'assigned') {
    if (!hasProjectId) {
      return {
        ok: false,
        error: 'missing-project-id',
        message: 'projectScope=assigned requires a non-empty projectId.',
      };
    }
    return { ok: true, scope: { kind: 'assigned', projectId } };
  }

  return {
    ok: false,
    error: 'invalid-project-scope',
    message: `Unknown projectScope "${scopeValue}"; expected all, assigned, or unassigned.`,
  };
}
