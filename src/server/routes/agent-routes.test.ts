import { describe, test, expect, vi } from 'vitest';
import { Hono } from 'hono';
import type { AgentRouteDeps } from './shared.js';
import { registerAgentRoutes } from './agent-routes.js';

function mkApp(deps: Partial<AgentRouteDeps>): Hono {
  const app = new Hono();
  registerAgentRoutes(app, deps as unknown as AgentRouteDeps);
  return app;
}

describe('GET /api/sessions/:sessionId/effective-hook-settings', () => {
  function mkAdapterReturning(effective: unknown) {
    return {
      agentType: 'claude-code' as const,
      launch: vi.fn(),
      sendInput: vi.fn(),
      sendKeystroke: vi.fn(),
      stop: vi.fn(),
      captureDisplay: vi.fn(),
      onEvent: vi.fn(),
      onRefreshNeeded: vi.fn(),
      injectHookEvent: vi.fn(),
      getEffectiveHookSettings: vi.fn(() => effective as ReturnType<typeof vi.fn>['_type']),
    };
  }

  test('returns 200 with adapter payload for a known session id', async () => {
    const payload = {
      content: { hooks: { SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'x' }] }] } },
      agentType: 'claude-code',
      settingsPath: '/home/u/.kookr/settings/kookr-abc.json',
    };
    const adapter = mkAdapterReturning(payload);
    const res = await mkApp({ adapter: adapter as never }).request(
      '/api/sessions/kookr-abc/effective-hook-settings',
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(payload);
    expect(adapter.getEffectiveHookSettings).toHaveBeenCalledWith('kookr-abc');
  });

  test('returns 404 for an unknown session id', async () => {
    const adapter = mkAdapterReturning(undefined);
    const res = await mkApp({ adapter: adapter as never }).request(
      '/api/sessions/kookr-nope/effective-hook-settings',
    );
    expect(res.status).toBe(404);
  });

  test.each([
    { label: 'space (decoded)', id: 'has%20space' },
    { label: 'encoded traversal', id: '..%2F..%2Fetc%2Fpasswd' },
    { label: 'null byte', id: 'good%00' },
    { label: 'tilde', id: '~root' },
  ])('rejects invalid session id without calling the adapter: $label', async ({ id }) => {
    const adapter = mkAdapterReturning(undefined);
    const res = await mkApp({ adapter: adapter as never }).request(
      `/api/sessions/${id}/effective-hook-settings`,
    );
    // 400 when the regex rejects the decoded id; 404 when the URL router
    // normalizes/strips the path before the handler matches. Either is a
    // safe outcome — the adapter must never be consulted.
    expect([400, 404]).toContain(res.status);
    expect(adapter.getEffectiveHookSettings).not.toHaveBeenCalled();
  });

  test('returns 400 for session ids that exceed the length cap', async () => {
    const adapter = mkAdapterReturning(undefined);
    const long = 'a'.repeat(129);
    const res = await mkApp({ adapter: adapter as never }).request(
      `/api/sessions/${long}/effective-hook-settings`,
    );
    expect(res.status).toBe(400);
    expect(adapter.getEffectiveHookSettings).not.toHaveBeenCalled();
  });
});
