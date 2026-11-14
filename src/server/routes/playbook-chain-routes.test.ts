import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { registerPlaybookChainRoutes } from './playbook-chain-routes.js';
import { AutomationKillSwitchError } from '../launch-service.js';
import { PlaybookChainError } from '../playbook-chain-service.js';

function app(service?: Parameters<typeof registerPlaybookChainRoutes>[1]['playbookChainService']) {
  const a = new Hono();
  registerPlaybookChainRoutes(a, { playbookChainService: service });
  return a;
}
const post = (a: Hono, path: string, body: unknown, headers: Record<string, string> = {}) =>
  a.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

const okStart = () => vi.fn(async () => ({ task: { id: 't1', chain: { maxIterations: 3 } }, queued: false }) as never);

describe('POST /api/playbook-chains', () => {
  it('starts a chain and returns the first task, tagged with the CLI launch source', async () => {
    const startChain = okStart();
    const res = await post(app({ startChain, stopChain: vi.fn() }), '/api/playbook-chains',
      { playbookPath: 'r.md', cwd: '/repo', parameterValues: { subject: 'x' }, maxIterations: 3 }, { 'X-Kookr-Launch-Source': 'cli' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ id: 't1', chain: { maxIterations: 3 } });
    expect(startChain).toHaveBeenCalledWith(expect.objectContaining({
      playbookPath: 'r.md', cwd: '/repo', parameterValues: { subject: 'x' }, spec: { maxIterations: 3 }, launchSource: 'cli',
    }));
  });

  it('rejects malformed bodies with 400 before launching', async () => {
    const startChain = okStart();
    const a = app({ startChain, stopChain: vi.fn() });
    for (const body of [
      { cwd: '/repo', maxIterations: 3 },
      { playbookPath: 'r.md', maxIterations: 3 },
      { playbookPath: 'r.md', cwd: '/repo' },
      { playbookPath: 'r.md', cwd: '/repo', maxIterations: 0 },
      { playbookPath: 'r.md', cwd: '/repo', maxIterations: 3, scope: 'global' },
      { playbookPath: 'r.md', cwd: '/repo', maxIterations: 3, parameterValues: { n: 1 } },
    ]) {
      expect((await post(a, '/api/playbook-chains', body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(startChain).not.toHaveBeenCalled();
  });

  it('maps a dedup refusal to 409, a held launch to 503, other failures to 400, and no service to 503', async () => {
    const body = { playbookPath: 'r.md', cwd: '/repo', maxIterations: 3 };
    const failing = (err: Error) => app({ startChain: vi.fn(async () => { throw err; }), stopChain: vi.fn() });
    expect((await post(failing(new PlaybookChainError('dup', 409)), '/api/playbook-chains', body)).status).toBe(409);
    expect((await post(failing(new AutomationKillSwitchError('safe_mode')), '/api/playbook-chains', body)).status).toBe(503);
    expect((await post(failing(new Error('Invalid playbook path')), '/api/playbook-chains', body)).status).toBe(400);
    expect((await post(app(undefined), '/api/playbook-chains', body)).status).toBe(503);
  });
});

describe('POST /api/tasks/:id/chain/stop', () => {
  it('records the requester and returns the fields the CLI prints', async () => {
    const stopChain = vi.fn(() => ({ ok: true as const, tip: { id: 'tip', chain: { chainId: 'c', iteration: 4 } } as never, alreadyRequested: false }));
    const res = await post(app({ startChain: okStart(), stopChain }), '/api/tasks/any/chain/stop', { by: 'agent', reason: 'done' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, chainId: 'c', tipTaskId: 'tip', iteration: 4, alreadyRequested: false });
    expect(stopChain).toHaveBeenCalledWith('any', 'agent', 'done');
  });

  it('defaults to an operator stop with an empty body, and passes through 404/409', async () => {
    const stopChain = vi.fn()
      .mockReturnValueOnce({ ok: true, tip: { id: 'tip', chain: { chainId: 'c', iteration: 1 } }, alreadyRequested: true })
      .mockReturnValueOnce({ ok: false, status: 404, error: 'Task not found: x' })
      .mockReturnValueOnce({ ok: false, status: 409, error: 'Chain already ended (stopped)' });
    const a = app({ startChain: okStart(), stopChain });
    const empty = await a.request('/api/tasks/t/chain/stop', { method: 'POST' });
    expect(empty.status).toBe(200);
    expect(stopChain).toHaveBeenLastCalledWith('t', 'operator', undefined);
    expect((await post(a, '/api/tasks/x/chain/stop', {})).status).toBe(404);
    expect((await post(a, '/api/tasks/x/chain/stop', {})).status).toBe(409);
    expect((await post(a, '/api/tasks/x/chain/stop', { by: 'robot' })).status).toBe(400);
  });
});
