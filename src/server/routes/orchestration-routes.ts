/**
 * Orchestration pause/resume routes (issue #2672).
 *
 * A first-class, named surface over SAFE MODE so a human — or the orchestrator
 * itself on a soft-quota trigger — can pause/resume the fleet without
 * hand-editing the whole settings document. The underlying write still goes
 * through `PUT /api/settings`'s update path (no partial settings write); these
 * handlers add the durable pause record and the human-vs-soft-quota distinction.
 *
 *   POST /api/orchestration/pause    — engage SAFE MODE + write the pause record
 *   POST /api/orchestration/resume   — disengage SAFE MODE + clear the record
 *   GET  /api/orchestration/status   — safeMode + pause record + quota sample
 */

import type { Hono } from 'hono';
import type { RouteDeps } from './shared.js';
import { OrchestrationPauseService } from '../orchestration-pause-service.js';
import { resolveDefaultAgentQuotaSample, type OrchestrationPauseSource } from '../../core/orchestration-pause.js';

/** Build the pause service from route deps, or null when settings are unwired. */
function buildService(deps: RouteDeps): OrchestrationPauseService | null {
  if (!deps.settings || !deps.kookrDir) return null;
  const settings = deps.settings;
  const kookrDir = deps.kookrDir;
  return new OrchestrationPauseService({
    kookrDir,
    getSettings: () => settings.get(),
    updateSettings: (next) => settings.update(next),
    ...(settings.getLoadError ? { getSettingsLoadError: () => settings.getLoadError!() } : {}),
    getQuotaSample: () => {
      const agentType = deps.getDefaultAgentType?.() ?? settings.get().defaultAgentType;
      return resolveDefaultAgentQuotaSample(agentType, deps.getQuotaStatus?.() ?? null);
    },
  });
}

export function registerOrchestrationRoutes(app: Hono, deps: RouteDeps): void {
  app.get('/api/orchestration/status', (c) => {
    const service = buildService(deps);
    if (!service) return c.json({ error: 'Orchestration control not configured' }, 500);
    return c.json(service.status());
  });

  app.post('/api/orchestration/pause', async (c) => {
    const service = buildService(deps);
    if (!service) return c.json({ error: 'Orchestration control not configured' }, 500);
    let body: Record<string, unknown> = {};
    try {
      const parsed = await c.req.json();
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      // Empty/absent body is allowed — a bare pause defaults to a human pause.
    }
    const source: OrchestrationPauseSource =
      body.source === 'soft-quota' ? 'soft-quota' : 'human';
    const by = typeof body.by === 'string' && body.by.trim() ? body.by.trim() : 'operator';
    const reason =
      typeof body.reason === 'string' && body.reason.trim()
        ? body.reason.trim()
        : source === 'soft-quota'
          ? 'soft-quota stop: near-exhausted default-agent quota'
          : 'operator pause';
    const notes = Array.isArray(body.notes)
      ? body.notes.filter((n): n is string => typeof n === 'string')
      : undefined;
    try {
      const status = await service.pause({
        source,
        reason,
        by,
        ...(notes ? { notes } : {}),
      });
      return c.json(status);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post('/api/orchestration/resume', async (c) => {
    const service = buildService(deps);
    if (!service) return c.json({ error: 'Orchestration control not configured' }, 500);
    let body: Record<string, unknown> = {};
    try {
      const parsed = await c.req.json();
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      // Empty body → a human resume.
    }
    const by = typeof body.by === 'string' && body.by.trim() ? body.by.trim() : 'operator';
    const auto = body.auto === true;
    try {
      const result = await service.resume({ by, auto });
      // On the paused→live edge, run one bounded, idempotent refill pass so the
      // fleet does not silently sit idle with free slots after a pause
      // (issue #2797). Unlike the timer-driven post-recovery sibling, this pass
      // is edge-triggered inline on the resume request: the response
      // deliberately absorbs its bounded latency (a state read/write, and at
      // most `getSpawnBudget` launches when enabled). Best-effort: a refill
      // failure must never fail the resume.
      if (result.resumed && result.transitionId && deps.postResumeRefillService) {
        try {
          await deps.postResumeRefillService.onResumeTransition(result.transitionId);
        } catch {
          // Recorded in the refill health snapshot; the resume itself succeeded.
        }
      }
      return c.json({ ...result.status, resumed: result.resumed, ...(result.reason ? { resumeDeclinedReason: result.reason } : {}) });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });
}
