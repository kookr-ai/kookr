import type { Hono } from 'hono';
import { saveTasks, serializeSnoozed } from '../../core/task-persistence.js';
import {
  isTaskRelationLifecycle,
  isTaskRelationSource,
  isTaskRelationType,
  type TaskRelationInput,
} from '../../shared/contracts/task-relations.js';
import type { TaskRelationsRouteDeps } from './shared.js';

// ---------------------------------------------------------------------------
// Typed task-relation graph (issue #599). Read endpoint returns the full
// graph; write endpoint upserts a single relation keyed by
// (sourceTaskId, targetTaskId, type) so duplicate submissions are idempotent.
// ---------------------------------------------------------------------------

const MAX_RELATION_EVIDENCE_ENTRIES = 16;
const MAX_RELATION_EVIDENCE_FIELD_LENGTH = 4096;

export function registerTaskRelationsRoutes(app: Hono, deps: TaskRelationsRouteDeps): void {
  const { taskStore } = deps;

  app.get('/api/task-relations', (c) => {
    const sourceTaskId = c.req.query('sourceTaskId') || undefined;
    const targetTaskId = c.req.query('targetTaskId') || undefined;
    const taskId = c.req.query('taskId') || undefined;
    const rawType = c.req.query('type');
    if (rawType !== undefined && !isTaskRelationType(rawType)) {
      return c.json({ error: 'invalid relation type' }, 400);
    }
    const relations = taskStore.listRelations({
      sourceTaskId,
      targetTaskId,
      taskId,
      type: rawType,
    });
    return c.json({ relations });
  });

  app.post('/api/task-relations', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json() as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const input = parseTaskRelationInput(body);
    if (input instanceof Error) return c.json({ error: input.message }, 400);
    if (!taskStore.getTask(input.sourceTaskId)) {
      return c.json({ error: `Source task not found: ${input.sourceTaskId}` }, 404);
    }
    if (!taskStore.getTask(input.targetTaskId)) {
      return c.json({ error: `Target task not found: ${input.targetTaskId}` }, 404);
    }
    const relation = taskStore.upsertRelation(input);
    if (deps.tasksFile) {
      const snoozes = deps.queue ? serializeSnoozed(deps.queue, taskStore) : undefined;
      const suppressionState = deps.suppressionTracker?.export();
      await saveTasks(
        taskStore.getAllTasks(),
        deps.tasksFile,
        taskStore.getLifetimeSpendUsd(),
        snoozes,
        suppressionState,
        taskStore.listRelations(),
      );
    }
    return c.json({ ok: true, relation });
  });
}

function parseTaskRelationInput(body: Record<string, unknown>): TaskRelationInput | Error {
  if (typeof body.sourceTaskId !== 'string' || body.sourceTaskId.length === 0) {
    return new Error('sourceTaskId is required and must be a string');
  }
  if (typeof body.targetTaskId !== 'string' || body.targetTaskId.length === 0) {
    return new Error('targetTaskId is required and must be a string');
  }
  if (body.sourceTaskId === body.targetTaskId) {
    return new Error('sourceTaskId and targetTaskId must differ');
  }
  if (!isTaskRelationType(body.type)) {
    return new Error('type is required and must be a valid relation type');
  }
  if (typeof body.confidence !== 'number' || !Number.isFinite(body.confidence) || body.confidence < 0 || body.confidence > 1) {
    return new Error('confidence is required and must be a number in [0, 1]');
  }
  if (!isTaskRelationSource(body.source)) {
    return new Error('source is required and must be a valid relation source');
  }
  if (body.lifecycle !== undefined && !isTaskRelationLifecycle(body.lifecycle)) {
    return new Error('lifecycle must be active, superseded, or rejected');
  }
  const evidence: TaskRelationInput['evidence'] = [];
  if (body.evidence !== undefined) {
    if (!Array.isArray(body.evidence)) return new Error('evidence must be an array');
    if (body.evidence.length > MAX_RELATION_EVIDENCE_ENTRIES) {
      return new Error(`evidence cannot contain more than ${MAX_RELATION_EVIDENCE_ENTRIES} entries`);
    }
    for (const entry of body.evidence) {
      if (!entry || typeof entry !== 'object') return new Error('evidence entries must be objects');
      const e = entry as { snippet?: unknown; path?: unknown; observedAt?: unknown };
      if (typeof e.observedAt !== 'string' || e.observedAt.length === 0) {
        return new Error('evidence.observedAt is required and must be a string');
      }
      if (e.snippet !== undefined && (typeof e.snippet !== 'string' || e.snippet.length > MAX_RELATION_EVIDENCE_FIELD_LENGTH)) {
        return new Error(`evidence.snippet must be a string of at most ${MAX_RELATION_EVIDENCE_FIELD_LENGTH} chars`);
      }
      if (e.path !== undefined && (typeof e.path !== 'string' || e.path.length > MAX_RELATION_EVIDENCE_FIELD_LENGTH)) {
        return new Error(`evidence.path must be a string of at most ${MAX_RELATION_EVIDENCE_FIELD_LENGTH} chars`);
      }
      evidence.push({
        ...(typeof e.snippet === 'string' ? { snippet: e.snippet } : {}),
        ...(typeof e.path === 'string' ? { path: e.path } : {}),
        observedAt: e.observedAt,
      });
    }
  }
  return {
    sourceTaskId: body.sourceTaskId,
    targetTaskId: body.targetTaskId,
    type: body.type,
    confidence: body.confidence,
    source: body.source,
    evidence,
    ...(isTaskRelationLifecycle(body.lifecycle) ? { lifecycle: body.lifecycle } : {}),
  };
}
