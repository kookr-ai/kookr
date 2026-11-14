/**
 * HTTP surface for playbook chains (RFC: docs/rfc/rfc-playbook-chains.md).
 *
 *  - `POST /api/playbook-chains` — launch iteration 1 of a chain.
 *  - `POST /api/tasks/:id/chain/stop` — stop the chain containing that task
 *    after its current iteration.
 *
 * Both delegate to {@link PlaybookChainService}, which owns all chain state;
 * these handlers only validate input and map errors to status codes.
 */

import type { Hono } from 'hono';
import { normalizeAgentSelection } from '../../core/agent-types.js';
import { validateChainSpec } from '../../core/playbook-chain.js';
import type { PlaybookScope } from '../../shared/contracts/playbook.js';
import {
  AutomationKillSwitchError,
  DrainModeError,
  HostLoadAdmissionError,
  PendingQueueFullError,
  QuotaHeadroomAdmissionError,
  SpawnBurstLimitError,
} from '../launch-service.js';
import { PlaybookChainError, type PlaybookChainService } from '../playbook-chain-service.js';

export interface PlaybookChainRouteDeps {
  playbookChainService?: Pick<PlaybookChainService, 'startChain' | 'stopChain'>;
  requestSnapshotBroadcast?: () => void;
}

const SCOPES = new Set<PlaybookScope>(['project', 'user', 'plugin']);

function isBusyError(err: unknown): boolean {
  return err instanceof AutomationKillSwitchError
    || err instanceof DrainModeError
    || err instanceof HostLoadAdmissionError
    || err instanceof PendingQueueFullError
    || err instanceof QuotaHeadroomAdmissionError
    || err instanceof SpawnBurstLimitError;
}

export function registerPlaybookChainRoutes(app: Hono, deps: PlaybookChainRouteDeps): void {
  app.post('/api/playbook-chains', async (c) => {
    const service = deps.playbookChainService;
    if (!service) return c.json({ error: 'playbook chains are not available on this server' }, 503);
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return c.json({ error: 'body must be a JSON object' }, 400);
    }
    const { playbookPath, scope, cwd, parameterValues, agentType, model, effort } = body;
    if (typeof playbookPath !== 'string' || playbookPath.trim() === '') {
      return c.json({ error: 'playbookPath must be a non-empty string' }, 400);
    }
    if (typeof cwd !== 'string' || cwd.trim() === '') {
      return c.json({ error: 'cwd must be a non-empty string' }, 400);
    }
    if (scope !== undefined && !SCOPES.has(scope as PlaybookScope)) {
      return c.json({ error: 'scope must be project, user, or plugin' }, 400);
    }
    if (parameterValues !== undefined && (
      typeof parameterValues !== 'object' || parameterValues === null || Array.isArray(parameterValues)
      || Object.values(parameterValues).some((v) => typeof v !== 'string')
    )) {
      return c.json({ error: 'parameterValues must be an object of strings' }, 400);
    }
    for (const [name, value] of [['agentType', agentType], ['model', model], ['effort', effort]] as const) {
      if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
        return c.json({ error: `${name} must be a non-empty string` }, 400);
      }
    }
    const spec = validateChainSpec({ maxIterations: body.maxIterations, durationMinutes: body.durationMinutes });
    if (!spec.ok) return c.json({ error: spec.error }, 400);

    const rawSource = c.req.header('X-Kookr-Launch-Source');
    const launchSource = rawSource === 'cli' || rawSource === 'ui' ? rawSource : 'api';
    try {
      const result = await service.startChain({
        cwd: cwd.trim(),
        playbookPath: playbookPath.trim(),
        ...(scope !== undefined ? { scope: scope as PlaybookScope } : {}),
        parameterValues: (parameterValues as Record<string, string> | undefined) ?? {},
        ...(typeof agentType === 'string' ? { agentType: normalizeAgentSelection(agentType) } : {}),
        ...(typeof model === 'string' ? { model } : {}),
        ...(typeof effort === 'string' ? { effort } : {}),
        spec: spec.value,
        launchSource,
      });
      deps.requestSnapshotBroadcast?.();
      return c.json({ ...result.task, ...(result.queued ? { queued: true } : {}) }, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof PlaybookChainError) return c.json({ error: message }, err.status);
      if (isBusyError(err)) return c.json({ error: message }, 503);
      return c.json({ error: `Could not start chain: ${message}` }, 400);
    }
  });

  app.post('/api/tasks/:id/chain/stop', async (c) => {
    const service = deps.playbookChainService;
    if (!service) return c.json({ error: 'playbook chains are not available on this server' }, 503);
    let body: Record<string, unknown> = {};
    try {
      const text = await c.req.text();
      if (text.trim() !== '') body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return c.json({ error: 'body must be a JSON object' }, 400);
    }
    if (body.reason !== undefined && typeof body.reason !== 'string') {
      return c.json({ error: 'reason must be a string' }, 400);
    }
    if (body.by !== undefined && body.by !== 'operator' && body.by !== 'agent') {
      return c.json({ error: 'by must be operator or agent' }, 400);
    }
    const result = service.stopChain(
      c.req.param('id'),
      body.by === 'agent' ? 'agent' : 'operator',
      typeof body.reason === 'string' ? body.reason : undefined,
    );
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({
      ok: true,
      chainId: result.tip.chain?.chainId,
      tipTaskId: result.tip.id,
      iteration: result.tip.chain?.iteration,
      alreadyRequested: result.alreadyRequested,
    });
  });
}
