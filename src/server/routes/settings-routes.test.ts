import { describe, test, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { DEFAULT_SETTINGS, type KookrSettings } from '../../core/settings-store.js';
import { registerSettingsRoutes } from './settings-routes.js';
import type { RouteDeps } from './shared.js';

function mkApp(deps: Partial<RouteDeps>): Hono {
  const app = new Hono();
  registerSettingsRoutes(app, deps as unknown as RouteDeps);
  return app;
}

function mkSettings(overrides: Partial<KookrSettings> = {}): KookrSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...overrides,
  };
}

function mkRouteDeps(options: {
  initialSettings?: KookrSettings;
  loadWarnings?: string[];
  updateWarnings?: string[];
  loadedFromDefaults?: boolean;
} = {}): Partial<RouteDeps> & {
  settings: NonNullable<RouteDeps['settings']>;
  broadcastToAll: ReturnType<typeof vi.fn>;
  getUpdateCalls: () => KookrSettings[];
} {
  let committed = options.initialSettings ?? mkSettings();
  const updateCalls: KookrSettings[] = [];
  const broadcastToAll = vi.fn();

  return {
    serverCwd: '/repo',
    sttUrl: 'ws://127.0.0.1:4010/stt',
    monitor: { getSnapshot: () => [] } as unknown as RouteDeps['monitor'],
    taskStore: { listRelations: () => [] } as unknown as RouteDeps['taskStore'],
    getMaxActiveTasks: () => committed.maxActiveTasks,
    broadcastToAll,
    settings: {
      get: () => committed,
      getLoadedFromDefaults: () => options.loadedFromDefaults ?? false,
      getLoadWarnings: () => options.loadWarnings ?? [],
      update: vi.fn(async (settings: KookrSettings) => {
        updateCalls.push(settings);
        committed = {
          ...settings,
          roundRobinIndex: committed.roundRobinIndex,
        };
        return options.updateWarnings ?? [];
      }),
    },
    getUpdateCalls: () => updateCalls,
  };
}

describe('settings routes', () => {
  test('GET /api/settings returns committed settings, defaults marker, and load warnings', async () => {
    const deps = mkRouteDeps({
      initialSettings: mkSettings({
        githubPollingEnabled: false,
        maxActiveTasks: 12,
        defaultAgentType: 'codex-cli',
        replySnippets: [{ label: 'Continue', text: 'continue' }],
      }),
      loadedFromDefaults: true,
      loadWarnings: ['Shortcut "quick_launch" in mac bindings has invalid binding "N"; ignored'],
    });

    const res = await mkApp(deps).request('/api/settings');

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      githubPollingEnabled: false,
      maxActiveTasks: 12,
      defaultAgentType: 'codex-cli',
      replySnippets: [{ label: 'Continue', text: 'continue' }],
      loadedFromDefaults: true,
      warnings: ['Shortcut "quick_launch" in mac bindings has invalid binding "N"; ignored'],
    });
  });

  test('PUT /api/settings rejects non-object bodies without updating or broadcasting', async () => {
    const deps = mkRouteDeps({
      initialSettings: mkSettings({ maxActiveTasks: 6 }),
    });

    const res = await mkApp(deps).request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(['not', 'an', 'object']),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'Body must be a JSON object' });
    expect(deps.settings.update).not.toHaveBeenCalled();
    expect(deps.broadcastToAll).not.toHaveBeenCalled();
    expect(deps.settings.get().maxActiveTasks).toBe(6);
  });

  test('PUT /api/settings persists validated settings and returns the committed server-managed fields', async () => {
    const deps = mkRouteDeps({
      initialSettings: mkSettings({
        maxActiveTasks: 4,
        roundRobinIndex: 7,
      }),
      updateWarnings: ['persisted with test warning'],
    });

    const res = await mkApp(deps).request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        githubPollingEnabled: false,
        githubPollingIntervalSec: 5,
        maxActiveTasks: 18,
        roundRobinIndex: 999,
        shortcutBindings: {
          mac: {
            next_bottleneck: 'Cmd+Ctrl+Space',
            quick_launch: 'Cmd+Ctrl+Space',
          },
        },
        replySnippets: [
          { label: ' Continue ', text: ' continue ' },
          { label: 'Bad', text: '' },
        ],
        unknownSetting: 'ignored',
      }),
    });

    expect(res.status).toBe(200);
    expect(deps.getUpdateCalls()).toEqual([
      mkSettings({
        githubPollingEnabled: false,
        githubPollingIntervalSec: 15,
        maxActiveTasks: 18,
        roundRobinIndex: 999,
        shortcutBindings: {
          mac: {
            next_bottleneck: 'Cmd+Ctrl+Space',
          },
        },
        replySnippets: [
          { label: 'Continue', text: 'continue' },
        ],
      }),
    ]);

    await expect(res.json()).resolves.toMatchObject({
      githubPollingEnabled: false,
      githubPollingIntervalSec: 15,
      maxActiveTasks: 18,
      roundRobinIndex: 7,
      shortcutBindings: {
        mac: {
          next_bottleneck: 'Cmd+Ctrl+Space',
        },
      },
      replySnippets: [
        { label: 'Continue', text: 'continue' },
      ],
      warnings: [
        'Shortcut "quick_launch" in mac bindings conflicts with "next_bottleneck" on Cmd+Ctrl+Space; ignored',
        'Invalid replySnippets[1] (label and text must be non-empty strings); ignored',
        'persisted with test warning',
      ],
    });
  });

  test('PUT /api/settings supports reply snippet create, update, and delete through settings CRUD', async () => {
    const deps = mkRouteDeps();
    const app = mkApp(deps);

    const createRes = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        replySnippets: [
          { label: ' Continue ', text: ' continue ' },
          { label: 'Tests', text: 'run pnpm test' },
        ],
      }),
    });
    expect(createRes.status).toBe(200);
    await expect(createRes.json()).resolves.toMatchObject({
      replySnippets: [
        { label: 'Continue', text: 'continue' },
        { label: 'Tests', text: 'run pnpm test' },
      ],
      warnings: [],
    });

    const updateRes = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...deps.settings.get(),
        replySnippets: [{ label: 'Proceed', text: 'yes proceed' }],
      }),
    });
    expect(updateRes.status).toBe(200);
    await expect(updateRes.json()).resolves.toMatchObject({
      replySnippets: [{ label: 'Proceed', text: 'yes proceed' }],
    });

    const deleteRes = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...deps.settings.get(),
        replySnippets: [],
      }),
    });
    expect(deleteRes.status).toBe(200);
    await expect(deleteRes.json()).resolves.toMatchObject({ replySnippets: [] });
  });

  test('PUT /api/settings broadcasts one snapshot carrying committed settings dependencies', async () => {
    const deps = mkRouteDeps({
      initialSettings: mkSettings({ maxActiveTasks: 3 }),
    });

    const res = await mkApp(deps).request('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        maxActiveTasks: 21,
      }),
    });

    expect(res.status).toBe(200);
    expect(deps.broadcastToAll).toHaveBeenCalledOnce();
    expect(deps.broadcastToAll).toHaveBeenCalledWith(expect.objectContaining({
      type: 'snapshot',
      serverCwd: '/repo',
      sttEnabled: true,
      sttUrl: 'ws://127.0.0.1:4010/stt',
      maxActiveTasks: 21,
      taskRelations: [],
    }));
  });
});
