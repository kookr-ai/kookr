/**
 * HTTP surface for pipeline-starvation refill (issue #1715).
 *
 * POST /api/pipeline-starvation/handle
 *   Body: { outcome: BatchOutcomeRecord, localPath?, parentTaskId?, agentType? }
 *   Called by the parallel-issue-batch playbook after writing a blocked-empty
 *   outcome.json so the engine can spawn an on-demand idea-scout and/or raise
 *   a pipeline-starvation alert under durable dedup.
 */

import type { Hono } from 'hono';
import { parseBatchOutcomeRecord } from '../../core/pipeline-starvation.js';
import type { PipelineStarvationService } from '../pipeline-starvation-service.js';
import type { AgentSelection } from '../../core/agent-types.js';
import { normalizeAgentSelection } from '../../core/agent-types.js';

export interface PipelineStarvationRouteDeps {
  pipelineStarvation: PipelineStarvationService;
}

export function registerPipelineStarvationRoutes(
  app: Hono,
  deps: PipelineStarvationRouteDeps,
): void {
  app.post('/api/pipeline-starvation/handle', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if (!body || typeof body !== 'object') {
      return c.json({ error: 'body must be an object' }, 400);
    }
    const rec = body as Record<string, unknown>;
    const outcome = parseBatchOutcomeRecord(rec.outcome ?? rec);
    if (!outcome) {
      return c.json({
        error: 'invalid outcome record — require schemaVersion=1, outcome, repo (owner/repo), runKey, generatedAt',
      }, 400);
    }

    let agentType: AgentSelection | undefined;
    if (rec.agentType !== undefined) {
      if (typeof rec.agentType !== 'string') {
        return c.json({ error: 'agentType must be a string' }, 400);
      }
      try {
        agentType = normalizeAgentSelection(rec.agentType);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : 'invalid agentType' }, 400);
      }
    }

    const localPath = typeof rec.localPath === 'string' ? rec.localPath : undefined;
    const parentTaskId = typeof rec.parentTaskId === 'string' ? rec.parentTaskId : undefined;

    try {
      const result = await deps.pipelineStarvation.handleBatchOutcome({
        outcome,
        localPath,
        parentTaskId,
        agentType,
      });
      return c.json({
        ok: true,
        applicable: result.decision.applicable,
        spawnScout: result.decision.spawnScout,
        spawnSkipReason: result.decision.spawnSkipReason ?? null,
        emitStarvationAlert: result.decision.emitStarvationAlert,
        alertSkipReason: result.decision.alertSkipReason ?? null,
        consecutiveBlockedEmpty: result.decision.consecutiveBlockedEmpty,
        effectiveScoutCooldownMs: result.decision.effectiveScoutCooldownMs ?? null,
        spawnedScoutTaskId: result.spawnedScoutTaskId ?? null,
        scoutQueued: result.scoutQueued ?? null,
        alertEmitted: result.alertEmitted,
        summary: result.summary,
        state: result.state,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[pipeline-starvation] handle failed:', message);
      return c.json({ error: message }, 500);
    }
  });
}
