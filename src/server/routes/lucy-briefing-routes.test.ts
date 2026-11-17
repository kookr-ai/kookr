import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';
import type { OperatorBriefingInput } from '../../core/lucy-operator/operator-briefing.js';
import { LUCY_BRIEFING_PATH } from '../../shared/contracts/lucy-briefing.js';
import { createApiAuthMiddleware, type ApiAuthConfig } from '../auth.js';
import type { LucyOperatorService } from '../lucy-operator/service.js';
import { operatorBriefingInput } from '../lucy-operator/briefing-source.js';
import { registerLucyBriefingRoutes, type LucyBriefingRouteDeps } from './lucy-briefing-routes.js';

const NOW = 2_000_000_000_000;
const service = {} as LucyOperatorService;
const waiting: OperatorBriefingInput = {
  tasks: [
    { id: 't1', name: 'Docs link audit', status: 'inProgress', attention: 'wants_review' },
    { id: 't2', name: 'Billing migration', status: 'inProgress' },
  ],
};

function appWith(deps: LucyBriefingRouteDeps): Hono {
  const app = new Hono();
  registerLucyBriefingRoutes(app, deps);
  return app;
}
const get = (app: Hono, headers: Record<string, string> = {}): Promise<Response> => app.request(`http://localhost${LUCY_BRIEFING_PATH}`, { headers });

describe('GET /api/lucy/briefing', () => {
  test('returns the briefing built from the current state, with no model call to make', async () => {
    const getInput = vi.fn(() => waiting);
    const res = await get(appWith({ lucyOperator: { service }, getInput, now: () => NOW }));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      text: 'Docs link audit says it is finished and wants your review. One more is working.',
      chips: ['What wants my review?', 'What is everyone working on?'],
      signature: expect.stringMatching(/^[0-9a-f]{16}$/),
      at: NOW,
    });
    expect(getInput).toHaveBeenCalledTimes(1);
  });

  test('reads the state again on every request', async () => {
    let input = waiting;
    const app = appWith({ lucyOperator: { service }, getInput: () => input, now: () => NOW });
    const first = await (await get(app)).json() as { signature: string };
    input = { tasks: [] };
    const second = await (await get(app)).json() as { text: string; signature: string };
    expect(second.text).toBe('All clear: nothing needs you. Nothing is running.');
    expect(second.signature).not.toBe(first.signature);
  });

  test('with Lucy\'s conversation off it answers 404 and reads nothing', async () => {
    const getInput = vi.fn(() => waiting);
    const res = await get(appWith({ getInput }));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'lucy_operator_disabled' });
    expect(getInput).not.toHaveBeenCalled();
  });

  test('switched on but unusable: 503 with the reason, like the turn route', async () => {
    const res = await get(appWith({ lucyOperator: { unavailableReason: 'Lucy\'s conversation needs an OpenRouter key.' }, getInput: () => waiting }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'lucy_operator_unavailable', message: 'Lucy\'s conversation needs an OpenRouter key.' });
  });

  test('is denied to a read-only viewer and to a caller with no credential, like the other Lucy routes', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config: ApiAuthConfig = {
      required: true,
      token: 'owner-secret',
      resolveViewer: (t) => (t === 'viewer-tok' ? { kind: 'valid', grantId: 'g1', scope: { kind: 'all' } } : { kind: 'not-found' }),
    };
    const getInput = vi.fn(() => waiting);
    const app = new Hono();
    app.use('*', createApiAuthMiddleware(config));
    registerLucyBriefingRoutes(app, { lucyOperator: { service }, getInput });
    const as = (token?: string): Promise<Response> =>
      app.request(`http://lan.example${LUCY_BRIEFING_PATH}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    expect((await as()).status).toBe(401);
    expect((await as('viewer-tok')).status).toBe(403);
    expect(getInput).not.toHaveBeenCalled();
    expect((await as('owner-secret')).status).toBe(200);
  });
});

describe('operatorBriefingInput', () => {
  test('maps the task list, the findings and the review signal onto what the briefing reads', () => {
    const input = operatorBriefingInput(
      [
        { id: 't1', name: 'Fix login', status: 'inProgress', updatedAt: NOW, sessions: [{ tmuxSession: 's1' }] },
        { id: 't2', name: 'Docs link audit', status: 'inProgress', updatedAt: NOW, sessions: [{ tmuxSession: 's2' }], pendingSignal: { kind: 'completion_ready' } },
        { id: 't3', status: 'completed', updatedAt: NOW, finishedAt: new Date(NOW - 5_000), sessions: [] },
        { id: 't4', name: 'Worker', status: 'inProgress', updatedAt: NOW, sessions: [{ tmuxSession: 's4' }], prompt: 'secret prompt', cwd: '/srv/app' },
      ],
      [{ agentId: 's1', anomaly: { type: 'permission_blocked', explanation: 'Agent is blocked on permission for tool: Bash' } }],
      [],
    );
    expect(input).toEqual({
      tasks: [
        { id: 't1', name: 'Fix login', status: 'inProgress', attention: 'permission_blocked' },
        { id: 't2', name: 'Docs link audit', status: 'inProgress', attention: 'wants_review' },
        { id: 't3', status: 'completed', endedAt: NOW - 5_000 },
        { id: 't4', name: 'Worker', status: 'inProgress' },
      ],
      asks: [],
    });
  });
});
