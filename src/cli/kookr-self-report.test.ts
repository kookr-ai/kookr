import { describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { runSelfReportCli } from '../../bin/kookr-self-report.js';
import {
  registerSelfReportRoutes,
  SELF_REPORT_PATH,
} from '../server/routes/self-report-routes.js';

/**
 * The shim is the only path a real agent takes, and it duplicates the wire
 * contract — the kind list and the route path — because it must keep working
 * when a build has not. These tests tie the copies together by running the
 * shim against the real route handler, so a rename on either side fails here
 * rather than in production at the moment an agent is already in trouble.
 */
function routeUnderTest() {
  const received: Array<{ url: string; body: unknown; auth?: string }> = [];
  const app = new Hono();
  registerSelfReportRoutes(app, {
    emitOperationalAlert: () => {},
    log: { warn: vi.fn() },
  });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    received.push({
      url,
      body: JSON.parse(String(init?.body ?? 'null')),
      auth: new Headers(init?.headers).get('authorization') ?? undefined,
    });
    return app.request(new URL(url).pathname, {
      method: init?.method,
      headers: init?.headers as HeadersInit,
      body: init?.body as BodyInit,
    });
  };
  return { received, fetchImpl };
}

const SESSION_ENV = {
  KOOKR_AGENT_ID: 'kookr-abc123',
  KOOKR_API_BASE_URL: 'http://127.0.0.1:4317',
};

describe('kookr-self-report shim (#2977)', () => {
  test('posts a report the real route accepts', async () => {
    const { received, fetchImpl } = routeUnderTest();
    const out = vi.fn();

    const code = await runSelfReportCli({
      argv: ['the prompt stops mid-sentence'],
      env: SESSION_ENV,
      fetchImpl,
      out,
      err: vi.fn(),
    });

    expect(code).toBe(0);
    expect(received).toHaveLength(1);
    // The route path and the body's field names are a contract between two
    // files that share no code; this is what pins them together.
    expect(new URL(received[0]!.url).pathname).toBe(SELF_REPORT_PATH);
    expect(received[0]!.body).toEqual({
      agentId: 'kookr-abc123',
      kind: 'prompt_unusable',
      detail: 'the prompt stops mid-sentence',
    });
    expect(out).toHaveBeenCalledWith(expect.stringContaining('recorded prompt_unusable'));
  });

  test('both --kind spellings select the kind', async () => {
    for (const argv of [
      ['--kind', 'environment_broken', 'no origin remote'],
      ['--kind=environment_broken', 'no origin remote'],
    ]) {
      const { received, fetchImpl } = routeUnderTest();
      const code = await runSelfReportCli({ argv, env: SESSION_ENV, fetchImpl, out: vi.fn(), err: vi.fn() });
      expect(code).toBe(0);
      expect(received[0]!.body).toMatchObject({ kind: 'environment_broken', detail: 'no origin remote' });
    }
  });

  test('a --kind that swallowed the detail reports the kind, not a missing detail', async () => {
    // `--kind "my prompt is broken"` eats the detail. Complaining about a
    // missing detail there sends the agent looking for the wrong mistake.
    const { received, fetchImpl } = routeUnderTest();
    const err = vi.fn();

    const code = await runSelfReportCli({
      argv: ['--kind', 'my prompt is broken'],
      env: SESSION_ENV,
      fetchImpl,
      out: vi.fn(),
      err,
    });

    expect(code).toBe(2);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('--kind must be one of'));
    expect(received).toHaveLength(0);
  });

  test('a bearer token is forwarded when the server requires one', async () => {
    const { received, fetchImpl } = routeUnderTest();

    await runSelfReportCli({
      argv: ['broken'],
      env: { ...SESSION_ENV, KOOKR_API_TOKEN: 'secret-token' },
      fetchImpl,
      out: vi.fn(),
      err: vi.fn(),
    });

    // Without this the escape hatch 401s on every non-loopback deployment —
    // exactly the unattended ones where nobody is watching the terminal.
    expect(received[0]!.auth).toBe('Bearer secret-token');
  });

  test('outside a Kookr session it refuses rather than posting somewhere', async () => {
    const { received, fetchImpl } = routeUnderTest();
    const err = vi.fn();

    const code = await runSelfReportCli({ argv: ['broken'], env: {}, fetchImpl, out: vi.fn(), err });

    expect(code).toBe(2);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('KOOKR_AGENT_ID'));
    expect(received).toHaveLength(0);
  });

  test('a refused report exits non-zero and says what the server said', async () => {
    const err = vi.fn();
    const code = await runSelfReportCli({
      argv: ['broken'],
      env: SESSION_ENV,
      fetchImpl: async () => new Response('nope', { status: 500 }),
      out: vi.fn(),
      err,
    });

    expect(code).toBe(1);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('500'));
  });

  test('an unreachable server exits non-zero instead of throwing', async () => {
    const err = vi.fn();
    const code = await runSelfReportCli({
      argv: ['broken'],
      env: SESSION_ENV,
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
      out: vi.fn(),
      err,
    });

    expect(code).toBe(1);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
  });
});
