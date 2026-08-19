import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_SETTINGS, type KookrSettings } from '../../core/settings-store.js';
import { applyKillSwitchTransition } from '../../core/automation-kill-switch.js';
import type { QuotaStatus } from '../../core/quota-types.js';
import { resolveOrchestrationPausePath } from '../../core/orchestration-pause.js';
import type { RouteDeps } from './shared.js';
import { registerOrchestrationRoutes } from './orchestration-routes.js';

function mkDeps(dir: string, options: {
  initial?: Partial<KookrSettings>;
  quota?: QuotaStatus | null;
  defaultAgentType?: KookrSettings['defaultAgentType'];
} = {}): Partial<RouteDeps> {
  let committed: KookrSettings = { ...DEFAULT_SETTINGS, ...options.initial };
  return {
    kookrDir: dir,
    getQuotaStatus: () => options.quota ?? null,
    getDefaultAgentType: () => options.defaultAgentType ?? committed.defaultAgentType,
    settings: {
      get: () => committed,
      getLoadedFromDefaults: () => false,
      getLoadWarnings: () => [],
      update: async (next: KookrSettings) => {
        committed = applyKillSwitchTransition(
          committed,
          { ...next, roundRobinIndex: committed.roundRobinIndex },
          '2026-08-19T00:00:00.000Z',
        );
        return [];
      },
    },
  };
}

function mkApp(deps: Partial<RouteDeps>): Hono {
  const app = new Hono();
  registerOrchestrationRoutes(app, deps as unknown as RouteDeps);
  return app;
}

describe('orchestration routes (issue #2672)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orch-routes-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('POST /pause engages SAFE MODE, writes the record, and status reflects it', async () => {
    const deps = mkDeps(dir, { defaultAgentType: 'grok-build' });
    const app = mkApp(deps);

    const pauseRes = await app.request('/api/orchestration/pause', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'quota reset', by: 'jean' }),
    });
    expect(pauseRes.status).toBe(200);
    const pauseBody = await pauseRes.json();
    expect(pauseBody.paused).toBe(true);
    expect(pauseBody.safeMode.engaged).toBe(true);
    expect(pauseBody.pause).toMatchObject({ source: 'human', reason: 'quota reset', pausedBy: 'jean' });
    expect(existsSync(resolveOrchestrationPausePath(dir))).toBe(true);

    // Underlying settings write engaged SAFE MODE.
    expect(deps.settings!.get().automationKillSwitch).toBe(true);

    const statusRes = await app.request('/api/orchestration/status');
    const statusBody = await statusRes.json();
    expect(statusBody.paused).toBe(true);
    // Grok default ⇒ quota sample unsupported (no XAI_API_KEY path).
    expect(statusBody.quota).toMatchObject({ agentType: 'grok-build', supported: false });
  });

  it('POST /resume disengages SAFE MODE and clears the record', async () => {
    const deps = mkDeps(dir, { initial: { automationKillSwitch: true } });
    const app = mkApp(deps);
    await app.request('/api/orchestration/pause', { method: 'POST', body: JSON.stringify({ by: 'jean' }) });

    const res = await app.request('/api/orchestration/resume', {
      method: 'POST',
      body: JSON.stringify({ by: 'jean' }),
    });
    const body = await res.json();
    expect(body.resumed).toBe(true);
    expect(body.paused).toBe(false);
    expect(deps.settings!.get().automationKillSwitch).toBe(false);
    expect(existsSync(resolveOrchestrationPausePath(dir))).toBe(false);
  });

  it('a soft auto-resume declines to lift a human pause', async () => {
    const deps = mkDeps(dir);
    const app = mkApp(deps);
    await app.request('/api/orchestration/pause', { method: 'POST', body: JSON.stringify({ source: 'human', by: 'jean' }) });

    const res = await app.request('/api/orchestration/resume', {
      method: 'POST',
      body: JSON.stringify({ auto: true, by: 'orchestrator' }),
    });
    const body = await res.json();
    expect(body.resumed).toBe(false);
    expect(body.resumeDeclinedReason).toContain('human pause is sticky');
    expect(deps.settings!.get().automationKillSwitch).toBe(true);
  });

  it('status surfaces a claude-code quota sample + soft-quota recommendation', async () => {
    const quota: QuotaStatus = {
      fiveHour: { utilization: 20, resetsAt: '2026-08-19T05:00:00.000Z' },
      sevenDay: { utilization: 97, resetsAt: '2026-08-25T00:00:00.000Z' },
      updatedAt: 0,
    };
    const deps = mkDeps(dir, { defaultAgentType: 'claude-code', quota });
    const app = mkApp(deps);

    const res = await app.request('/api/orchestration/status');
    const body = await res.json();
    expect(body.quota).toMatchObject({ agentType: 'claude-code', supported: true, utilization: 97, window: 'seven-day' });
    // Not paused + 97% ≥ 95% ⇒ recommend pause.
    expect(body.recommendation.action).toBe('pause');
  });

  it('500s when orchestration control is unconfigured (no settings/kookrDir)', async () => {
    const app = mkApp({});
    const res = await app.request('/api/orchestration/status');
    expect(res.status).toBe(500);
  });
});
