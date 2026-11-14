import { describe, expect, it, vi } from 'vitest';
import { EXIT_OK, EXIT_SERVER_ERROR, EXIT_USER_ERROR, parseChainArgs, runChainCli } from './kookr-chain.js';

function io(env: Record<string, string> = {}, response: { status: number; body: unknown } = { status: 201, body: { id: 't1', chain: { maxIterations: 3 } } }) {
  const logs: string[] = [];
  const errors: string[] = [];
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(response.body), { status: response.status }));
  return {
    logs, errors, fetchImpl,
    io: { env, out: { log: (m: unknown) => logs.push(String(m)) }, err: { error: (m: unknown) => errors.push(String(m)) }, cwd: '/repo', fetchImpl: fetchImpl as unknown as typeof fetch },
  };
}

describe('parseChainArgs', () => {
  it('parses start with params, both bounds, scope and dir', () => {
    expect(parseChainArgs(['start', 'research.md', '--param', 'subject=memory', '--iterations', '5', '--hours', '6', '--scope', 'project', '-C', '../lra']))
      .toEqual({ kind: 'start', json: false, playbook: 'research.md', scope: 'project', params: { subject: 'memory' }, maxIterations: 5, durationMinutes: 360, dir: '../lra' });
  });

  it('passes agent, model and effort pins through', () => {
    expect(parseChainArgs(['start', 'p.md', '--iterations', '2', '--agent', 'claude-code', '--model', 'claude-haiku-5-5', '--effort', 'low']))
      .toMatchObject({ agent: 'claude-code', model: 'claude-haiku-5-5', effort: 'low' });
  });

  it('combines --hours and --minutes', () => {
    expect(parseChainArgs(['start', 'p.md', '--hours', '1.5', '--minutes', '10'])).toMatchObject({ durationMinutes: 100 });
  });

  it('requires a bound and a valid count', () => {
    expect(parseChainArgs(['start', 'p.md'])).toMatchObject({ kind: 'error' });
    expect(parseChainArgs(['start', 'p.md', '--iterations', '0'])).toMatchObject({ kind: 'error' });
    expect(parseChainArgs(['start', 'p.md', '--param', 'novalue', '--iterations', '2'])).toMatchObject({ kind: 'error' });
    expect(parseChainArgs(['launch', 'p.md'])).toMatchObject({ kind: 'error' });
  });
});

describe('runChainCli', () => {
  it('starts a chain against the configured server', async () => {
    const h = io({ KOOKR_PORT: '4801' });
    expect(await runChainCli(['start', 'research.md', '--iterations', '3'], h.io)).toBe(EXIT_OK);
    const [url, init] = h.fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:4801/api/playbook-chains');
    expect(JSON.parse(init.body as string)).toMatchObject({ playbookPath: 'research.md', cwd: '/repo', maxIterations: 3, parameterValues: {} });
    expect(h.logs[0]).toContain('Started chain t1');
  });

  it('stops the current task\'s chain as the agent when run inside a chain iteration', async () => {
    const h = io({ KOOKR_TASK_ID: 'tip-1' }, { status: 200, body: { ok: true, iteration: 4, tipTaskId: 'tip-1' } });
    expect(await runChainCli(['stop', '--reason', 'queue empty'], h.io)).toBe(EXIT_OK);
    const [url, init] = h.fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:4800/api/tasks/tip-1/chain/stop');
    expect(JSON.parse(init.body as string)).toEqual({ by: 'agent', reason: 'queue empty' });
  });

  it('records an explicit other task id as an operator stop', async () => {
    const h = io({ KOOKR_TASK_ID: 'me' }, { status: 200, body: { ok: true, iteration: 1 } });
    await runChainCli(['stop', 'other'], h.io);
    const [, init] = h.fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ by: 'operator' });
  });

  it('fails clearly without a task id, and surfaces server errors', async () => {
    expect(await runChainCli(['stop'], io().io)).toBe(EXIT_USER_ERROR);
    const h = io({}, { status: 409, body: { error: 'Chain already ended (stopped)' } });
    expect(await runChainCli(['stop', 'x'], h.io)).toBe(EXIT_SERVER_ERROR);
    expect(h.errors[0]).toContain('Chain already ended');
  });
});
