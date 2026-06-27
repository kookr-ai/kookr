import { describe, expect, test } from 'vitest';
import { Hono } from 'hono';
import { createRoutes } from './routes.js';
import type { RouteDeps } from './routes/shared.js';
import {
  InFlightRequestRegistry,
  createInFlightRequestMiddleware,
  inFlightRequestRegistry,
  startInFlightRequestShutdownLogger,
} from './in-flight-request-registry.js';

describe('InFlightRequestRegistry', () => {
  test('tracks active HTTP requests and clears them when handlers finish', async () => {
    const registry = new InFlightRequestRegistry({ nowMs: () => 100 });
    const app = new Hono();
    let releaseHandler: (() => void) | undefined;
    let seenDuringHandler = 0;

    app.use('*', createInFlightRequestMiddleware(registry));
    app.get('/api/tasks/:taskId', async (c) => {
      seenDuringHandler = registry.size();
      await new Promise<void>((resolve) => {
        releaseHandler = resolve;
      });
      return c.json({ id: c.req.param('taskId') });
    });

    const responsePromise = app.request('/api/tasks/alpha?token=secret');
    await waitFor(() => releaseHandler !== undefined);

    expect(seenDuringHandler).toBe(1);
    expect(registry.snapshot({ nowMs: 150 })).toEqual([{
      id: 1,
      method: 'GET',
      route: '/api/tasks/:taskId',
      startedAtMs: 100,
      elapsedMs: 50,
    }]);

    releaseHandler?.();
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(registry.snapshot({ nowMs: 175 })).toEqual([]);
  });

  test('clears active HTTP requests when a handler throws', async () => {
    const registry = new InFlightRequestRegistry({ nowMs: () => 100 });
    const app = new Hono();

    app.use('*', createInFlightRequestMiddleware(registry));
    app.get('/api/fails', () => {
      throw new Error('boom');
    });

    const response = await app.request('/api/fails');

    expect(response.status).toBe(500);
    expect(registry.snapshot({ nowMs: 150 })).toEqual([]);
  });

  test('createRoutes installs the in-flight request middleware in the runtime route stack', async () => {
    const app = createRoutes({
      frontendDir: '/nonexistent-frontend',
      serverCwd: '/repo',
      serverPort: 4800,
    } as unknown as RouteDeps);
    let releaseHandler: (() => void) | undefined;

    app.get('/api/__inflight-test/:id', async (c) => {
      await new Promise<void>((resolve) => {
        releaseHandler = resolve;
      });
      return c.json({ id: c.req.param('id') });
    });

    const responsePromise = app.request('/api/__inflight-test/alpha?token=secret');
    await waitFor(() => releaseHandler !== undefined);

    expect(inFlightRequestRegistry.snapshot()).toEqual([expect.objectContaining({
      method: 'GET',
      route: '/api/__inflight-test/:id',
    })]);

    releaseHandler?.();
    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(inFlightRequestRegistry.snapshot()).toEqual([]);
  });

  test('createRoutes tracks requests while body-limit middleware is still reading the body', async () => {
    const app = createRoutes({
      frontendDir: '/nonexistent-frontend',
      serverCwd: '/repo',
      serverPort: 4800,
      requestBodyLimitBytes: 1_024,
    } as unknown as RouteDeps);
    let releaseBody: (() => void) | undefined;

    app.post('/api/__inflight-body-test', (c) => c.json({ ok: true }));

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"payload":"'));
        releaseBody = () => {
          controller.enqueue(new TextEncoder().encode('done"}'));
          controller.close();
        };
      },
    });
    const responsePromise = app.request('http://localhost/api/__inflight-body-test?token=secret', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      duplex: 'half',
    } as RequestInit);
    await waitFor(() => releaseBody !== undefined);

    expect(inFlightRequestRegistry.snapshot()).toEqual([expect.objectContaining({
      method: 'POST',
      route: '/api/__inflight-body-test',
    })]);

    releaseBody?.();
    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(inFlightRequestRegistry.snapshot()).toEqual([]);
  });

  test('shutdown logger emits the longest-running in-flight requests without query strings', () => {
    const registry = new InFlightRequestRegistry();
    const logs: string[] = [];

    registry.start({ method: 'post', route: '/api/speech/synthesize?token=secret', startedAtMs: 1_000 });
    registry.start({ method: 'get', route: '/api/cost-comparison', startedAtMs: 500 });

    const stop = startInFlightRequestShutdownLogger(registry, {
      topN: 1,
      nowMs: () => 2_000,
      log: (message) => logs.push(message),
    });
    stop();

    expect(logs).toEqual([
      '[shutdown] Waiting for 2 in-flight HTTP request(s): GET /api/cost-comparison elapsedMs=1500',
    ]);
    expect(logs[0]).not.toContain('token=secret');
  });

  test('shutdown logger is quiet when no requests are in flight', () => {
    const registry = new InFlightRequestRegistry();
    const logs: string[] = [];

    const stop = startInFlightRequestShutdownLogger(registry, {
      nowMs: () => 2_000,
      log: (message) => logs.push(message),
    });
    stop();

    expect(logs).toEqual([]);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for predicate');
}
