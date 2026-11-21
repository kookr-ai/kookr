import type { Hono } from 'hono';
import type { TaskStore } from '../../core/tasks.js';
import { appendAuditRow } from '../../core/audit-log.js';
import { nowISO } from '../../core/interaction-log.js';
import {
  MAX_REAP_VETOES,
  type ReapWarningCoordinator,
} from '../../core/reap-warning-coordinator.js';
import { DEFAULT_LONG_RUNNING_JOB_CAP_MS } from '../../core/long-running-jobs.js';
import {
  authorizeKeepAlive,
  parseKeepAliveRequest,
  resolveTaskIdRef,
} from '../../core/keep-alive-policy.js';

export interface KeepAliveRouteDeps {
  taskStore: TaskStore;
  auditLogPath?: string;
  /** The hungSuspect TTL reclaim's coordinator (issue #4241). */
  hungSuspectTtlReapWarningCoordinator?: ReapWarningCoordinator;
  /** The 3h hung-task reaper's coordinator. */
  reapWarningCoordinator?: ReapWarningCoordinator;
  /** Absolute cap on a task's silence, shared with the long-running-job hold (#4237). */
  getLongRunningJobReclaimCapMs?: () => number;
  now?: () => number;
}

/**
 * `POST /api/tasks/:id/keep-alive` (issue #4241): extend the deadline of a task
 * that a reclaim has warned. Body: `{ forMs, reason, callerTaskId? }`. The
 * caller is the operator (no `callerTaskId`) or the task's parent; the task
 * itself and unrelated tasks get 403 (see `core/keep-alive-policy.ts`).
 *
 * Bounds: one call extends by at most 60 min, a warning cycle takes at most
 * {@link MAX_REAP_VETOES} extensions (dashboard clicks included), and no
 * deadline goes past the task's silence start plus the long-running-job cap
 * (12 h by default). Past either cap the call is refused with 409 and the
 * reclaim proceeds at the current deadline.
 */
export function registerKeepAliveRoutes(app: Hono, deps: KeepAliveRouteDeps): void {
  app.post('/api/tasks/:id/keep-alive', async (c) => {
    const ref = c.req.param('id');
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body', code: 'invalid_body' }, 400);
    }
    const parsed = parseKeepAliveRequest(body);
    if (!parsed.ok) return c.json({ error: parsed.message, code: 'invalid_body' }, 400);

    const tasks = deps.taskStore.viewTasks();
    const resolved = resolveTaskIdRef(tasks.map((t) => t.id), ref);
    if (resolved.kind === 'none') return c.json({ error: `Task not found: ${ref}`, code: 'not_found' }, 404);
    if (resolved.kind === 'ambiguous') {
      return c.json(
        { error: `Task id prefix ${ref} matches several tasks: ${resolved.ids.join(', ')}`, code: 'ambiguous' },
        409,
      );
    }
    const target = deps.taskStore.getTask(resolved.id);
    if (!target) return c.json({ error: `Task not found: ${ref}`, code: 'not_found' }, 404);

    const auth = authorizeKeepAlive({
      target,
      callerTaskId: parsed.callerTaskId,
      getTask: (id) => deps.taskStore.getTask(id),
    });
    if (!auth.ok) return c.json({ error: auth.message, code: auth.code }, auth.status);

    if (target.status !== 'inProgress') {
      return c.json(
        { error: `Task ${target.id} is ${target.status}; there is nothing to keep alive.`, code: 'task_not_active' },
        409,
      );
    }

    const ttl = deps.hungSuspectTtlReapWarningCoordinator;
    const hung = deps.reapWarningCoordinator;
    const [coordinator, reaper] = ttl?.getWarning(target.id)
      ? [ttl, 'hung_suspect_ttl' as const]
      : hung?.getWarning(target.id)
        ? [hung, 'hung_task' as const]
        : [undefined, undefined];
    const warning = coordinator?.getWarning(target.id);
    if (!coordinator || !warning || !reaper) {
      return c.json(
        { error: `Task ${target.id} is not scheduled to be closed; there is nothing to extend.`, code: 'no_warning' },
        409,
      );
    }

    const now = deps.now?.() ?? Date.now();
    const capMs = deps.getLongRunningJobReclaimCapMs?.() ?? DEFAULT_LONG_RUNNING_JOB_CAP_MS;
    const ceilingAt = warning.silentSinceAt + capMs;
    const result = coordinator.agentVeto(target.id, {
      now,
      extensionMs: parsed.forMs,
      ceilingAt,
      actor: auth.actor,
      actorName: auth.actorName,
      reason: parsed.reason,
    });
    if (!result.accepted) {
      const deadline = result.warning ? new Date(result.warning.deadlineAt).toISOString() : undefined;
      const message = result.reason === 'cap_reached'
        ? `Task ${target.id} has already been kept alive ${MAX_REAP_VETOES} times in this cycle; it will be closed at ${deadline}.`
        : result.reason === 'ceiling_reached'
          ? `Task ${target.id} has been silent for the ${Math.round(capMs / 3_600_000)}h cap; it will be closed at ${deadline}.`
          : `Task ${target.id} is not scheduled to be closed; there is nothing to extend.`;
      return c.json({ error: message, code: result.reason, ...(deadline ? { deadlineAt: deadline } : {}) }, 409);
    }

    const until = new Date(result.warning.deadlineAt).toISOString();
    console.log(
      `[keep-alive] task ${target.id} kept alive by ${auth.actor} until ${until} ` +
        `(${reaper}, extension #${result.warning.keptAliveCount}): ${parsed.reason}`,
    );
    await appendAuditRow(deps.auditLogPath, {
      type: reaper === 'hung_suspect_ttl' ? 'task.hungSuspectTtlReapKeptAlive' : 'task.hungTaskReapKeptAlive',
      timestamp: nowISO(),
      actor: auth.actor,
      taskId: target.id,
      reason: parsed.reason,
      deadlineAt: until,
      keptAliveCount: result.warning.keptAliveCount,
    });
    return c.json({
      taskId: target.id,
      reaper,
      keptAliveBy: auth.actorName,
      deadlineAt: until,
      keptAliveCount: result.warning.keptAliveCount,
      remainingKeepAlives: Math.max(0, MAX_REAP_VETOES - result.warning.keptAliveCount),
    });
  });
}
