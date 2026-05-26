import type { Hono } from 'hono';
import { buildCoordinatorDetectorTasks, createSnapshotMessage, getSnapshotAgentsRaw } from '../use-cases/get-snapshot.js';
import { completeTask as completeTaskLifecycle } from '../agent-lifecycle.js';
import { buildCoordinatorSnapshotState } from '../coordinator/detectors.js';
import { CoordinatorSuppressionStore } from '../coordinator/suppression-store.js';
import type { CoordinatorRouteDeps } from './shared.js';

export function registerCoordinatorRoutes(app: Hono, deps: CoordinatorRouteDeps): void {
  const { taskStore, monitor, adapter, hookWatcher, watchdog, interactionLog, broadcastToAll, serverCwd, hookIngestion } = deps;
  const coordinatorSuppressions = deps.coordinatorSuppressions ?? new CoordinatorSuppressionStore(deps.kookrDir ?? serverCwd);

  function coordinatorSnapshot() {
    const agents = getSnapshotAgentsRaw({ monitor, activityMetaProvider: hookIngestion });
    return buildCoordinatorSnapshotState(
      { tasks: buildCoordinatorDetectorTasks(taskStore.listTasks(), agents) },
      hookIngestion?.getCoordinatorAuditTail() ?? [],
      { suppressions: coordinatorSuppressions },
    );
  }

  function broadcastSnapshotWithCoordinator(): void {
    broadcastToAll(createSnapshotMessage({
      monitor,
      serverCwd,
      activityMetaProvider: hookIngestion,
      coordinator: { taskStore, auditTailProvider: hookIngestion, suppressions: coordinatorSuppressions },
      relationTaskStore: taskStore,
    }));
  }

  app.post('/api/coordinator/suppressions', async (c) => {
    let body: { taskId?: unknown; detectorId?: unknown; agentType?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if (!isCoordinatorDetectorId(body.detectorId)) return c.json({ error: 'detectorId is required' }, 400);
    const task = typeof body.taskId === 'string' ? taskStore.getTask(body.taskId) : undefined;
    const agentType = isAgentType(body.agentType) ? body.agentType : task?.agentType;
    if (!agentType) return c.json({ error: 'agentType or valid taskId is required' }, 400);

    const suppression = coordinatorSuppressions.suppress(body.detectorId, agentType);
    broadcastSnapshotWithCoordinator();
    return c.json({ ok: true, suppression });
  });

  app.post('/api/coordinator/acknowledgements', async (c) => {
    let body: { taskId?: unknown; detectorId?: unknown; agentType?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if (typeof body.taskId !== 'string') return c.json({ error: 'taskId is required' }, 400);
    if (!isCoordinatorDetectorId(body.detectorId)) return c.json({ error: 'detectorId is required' }, 400);
    const task = taskStore.getTask(body.taskId);
    if (!task) return c.json({ error: 'Task not found' }, 404);
    const agentType = isAgentType(body.agentType) ? body.agentType : task.agentType;

    const acknowledgement = coordinatorSuppressions.acknowledgeTask(body.detectorId, agentType, task.id);
    broadcastSnapshotWithCoordinator();
    return c.json({ ok: true, acknowledgement });
  });

  app.post('/api/coordinator/mark-prior-done', async (c) => {
    let body: { taskId?: unknown; priorTaskIds?: unknown; concurrencyToken?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if (typeof body.taskId !== 'string') return c.json({ error: 'taskId is required' }, 400);
    if (!Array.isArray(body.priorTaskIds) || !body.priorTaskIds.every((id) => typeof id === 'string')) {
      return c.json({ error: 'priorTaskIds must be a string array' }, 400);
    }
    if (typeof body.concurrencyToken !== 'string') return c.json({ error: 'concurrencyToken is required' }, 400);
    if (!taskStore.getTask(body.taskId)) return c.json({ error: 'Task not found' }, 404);

    for (const priorTaskId of body.priorTaskIds) {
      await deps.githubScanner.refreshTaskState(priorTaskId);
    }

    const fresh = coordinatorSnapshot();
    const chain = fresh.chains[body.taskId];
    if (!chain || chain.concurrencyToken !== body.concurrencyToken) {
      return c.json({ error: 'Coordinator state changed; review the refreshed chain strip before applying the batch action.' }, 409);
    }
    if (!sameStringSet(body.priorTaskIds, chain.priorTaskIds)) {
      return c.json({ error: 'Submitted prior tasks no longer match the refreshed chain strip.' }, 409);
    }

    for (const priorTaskId of body.priorTaskIds) {
      const prior = taskStore.getTask(priorTaskId);
      if (!prior) return c.json({ error: `Prior task not found: ${priorTaskId}` }, 409);
      if (prior.status !== 'terminated' && prior.status !== 'completed') {
        return c.json({ error: `Prior task ${priorTaskId.slice(0, 8)} is ${prior.status}; only terminated tasks can be marked done automatically.` }, 409);
      }
      const gh = deps.githubStateStore.getTaskState(priorTaskId);
      const merged = gh.prs.find((pr) => pr.status === 'merged');
      if (!merged) {
        return c.json({ error: `Prior task ${priorTaskId.slice(0, 8)} has no freshly verified merged PR.` }, 409);
      }
      const failedCheck = merged.checks.find((check) => (
        check.status !== 'completed'
        || (check.conclusion !== 'success' && check.conclusion !== 'neutral' && check.conclusion !== 'skipped')
      ));
      if (failedCheck) {
        return c.json({ error: `Prior task ${priorTaskId.slice(0, 8)} has non-passing post-merge CI: ${failedCheck.name}.` }, 409);
      }
      const dirtySession = prior.sessions.find((session) => session.worktreeHealth && session.worktreeHealth !== 'ok');
      if (dirtySession) {
        return c.json({ error: `Prior task ${priorTaskId.slice(0, 8)} worktree is ${dirtySession.worktreeHealth}.` }, 409);
      }
    }

    for (const priorTaskId of body.priorTaskIds) {
      const prior = taskStore.getTask(priorTaskId);
      if (prior && prior.status !== 'completed') {
        await completeTaskLifecycle(priorTaskId, {
          adapter,
          monitor,
          taskStore,
          interactionLog,
          hookWatcher,
          watchdog,
          shadowRegistry: deps.shadowRegistry,
          suppressionTracker: deps.suppressionTracker,
          queue: deps.queue,
        });
      }
    }
    broadcastSnapshotWithCoordinator();
    return c.json({ ok: true, completedTaskIds: body.priorTaskIds });
  });
}

function isCoordinatorDetectorId(value: unknown): value is 'declared_edge' | 'stale' | 'duplicate' | 'done_not_cleared' {
  return value === 'declared_edge' || value === 'stale' || value === 'duplicate' || value === 'done_not_cleared';
}

function isAgentType(value: unknown): value is 'claude-code' | 'codex-cli' {
  return value === 'claude-code' || value === 'codex-cli';
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  if (new Set(left).size !== left.length || new Set(right).size !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((item) => rightSet.has(item));
}
