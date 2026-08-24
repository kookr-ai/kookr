import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OssAttemptStore } from '../../core/oss-attempt-store.js';
import { LedgerAnalytics } from '../../core/ledger-analytics.js';
import { ProjectConfigStore } from '../../core/project-config-store.js';
import { TaskStore } from '../../core/tasks.js';
import { AttentionQueue } from '../../core/attention-queue.js';
import { Monitor } from '../../core/monitor.js';
import { registerProjectRoutes } from './project-routes.js';
import type { RouteDeps } from './shared.js';

function mkApp(deps: Partial<RouteDeps>): Hono {
  const app = new Hono();
  registerProjectRoutes(app, deps as unknown as RouteDeps);
  return app;
}

function mkProjectDeps(deps: Partial<RouteDeps> & {
  taskStore: TaskStore;
  monitor: Monitor;
  ledgerAnalytics: LedgerAnalytics;
  projectConfigStore: ProjectConfigStore;
}): Partial<RouteDeps> {
  return {
    githubScanner: { getRepoHealthSnapshot: () => new Map() } as never,
    githubStateStore: { getReferences: () => [], isRefOpen: () => undefined } as never,
    ...deps,
  };
}

describe('GET /api/projects/contributions', () => {
  let tempDir: string;
  let store: OssAttemptStore;
  let ledgerAnalytics: LedgerAnalytics;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'proj-contrib-test-'));
    store = new OssAttemptStore(tempDir);
    ledgerAnalytics = new LedgerAnalytics(store);
    await store.load();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('returns [] when ossAttemptStore is not wired', async () => {
    const res = await mkApp({}).request('/api/projects/contributions');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test('filters out scouted attempts when no ?project is passed', async () => {
    // Scouted — should be filtered out
    store.upsertScouted({
      repo: 'grafana/grafana',
      issueNumber: 1,
      issueUrl: 'https://github.com/grafana/grafana/issues/1',
    });
    // PR-keyed — should be returned
    store.upsertPr({
      repo: 'grafana/grafana',
      prNumber: 42,
      prUrl: 'https://github.com/grafana/grafana/pull/42',
      prTitle: 'Fix something',
      source: 'posttool_hook',
    });

    const res = await mkApp({ ossAttemptStore: store, ledgerAnalytics }).request('/api/projects/contributions');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].prNumber).toBe(42);
    expect(body[0].state).not.toBe('scouted');
  });

  test('returns recent attempts for a specific project when ?project is set', async () => {
    store.upsertPr({
      repo: 'grafana/grafana',
      prNumber: 1,
      prUrl: 'https://github.com/grafana/grafana/pull/1',
      prTitle: 'A',
      source: 'posttool_hook',
    });
    store.upsertPr({
      repo: 'denoland/deno',
      prNumber: 2,
      prUrl: 'https://github.com/denoland/deno/pull/2',
      prTitle: 'B',
      source: 'posttool_hook',
    });

    const res = await mkApp({ ossAttemptStore: store, ledgerAnalytics })
      .request('/api/projects/contributions?project=github.com/grafana/grafana');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].repo).toBe('grafana/grafana');
  });
});

describe('POST /api/projects/configs webhook routing', () => {
  let tempDir: string;
  let projectConfigStore: ProjectConfigStore;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'proj-config-route-test-'));
    projectConfigStore = new ProjectConfigStore(tempDir);
    await projectConfigStore.load();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('persists per-project webhook routing without URL or secret fields', async () => {
    const res = await mkApp({
      projectConfigStore,
      broadcastProjectSummaries: () => {},
    }).request('/api/projects/configs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project: 'github.com/kookr-ai/kookr',
        webhook: {
          enabled: false,
          minSeverity: 'critical',
          url: 'https://receiver.example/secret',
          secret: 'do-not-leak',
        },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      project: 'github.com/kookr-ai/kookr',
      webhook: {
        enabled: false,
        minSeverity: 'critical',
      },
    });
    expect(body.webhook).not.toHaveProperty('url');
    expect(body.webhook).not.toHaveProperty('secret');
    expect(projectConfigStore.getConfig('github.com/kookr-ai/kookr')?.webhook).toEqual({
      enabled: false,
      minSeverity: 'critical',
    });

    const reloaded = new ProjectConfigStore(tempDir);
    await reloaded.load();
    expect(reloaded.getConfig('github.com/kookr-ai/kookr')?.webhook).toEqual({
      enabled: false,
      minSeverity: 'critical',
    });
  });

  test('persists a zero-drain issue limit and rejects only the configured deployment ceiling', async () => {
    const unlimited = await mkApp({
      projectConfigStore,
      broadcastProjectSummaries: () => {},
    }).request('/api/projects/configs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'github.com/kookr-ai/unlimited', zeroDrainIssueLimit: -1 }),
    });
    expect(unlimited.status).toBe(200);
    expect((await unlimited.json()).zeroDrainIssueLimit).toBe(-1);

    const cappedStore = new ProjectConfigStore(tempDir, { maxZeroDrainIssueLimit: 1000 });
    await cappedStore.load();
    const app = mkApp({ projectConfigStore: cappedStore, broadcastProjectSummaries: () => {} });

    const accepted = await app.request('/api/projects/configs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'github.com/kookr-ai/maison', zeroDrainIssueLimit: 1000 }),
    });
    expect(accepted.status).toBe(200);
    expect((await accepted.json()).zeroDrainIssueLimit).toBe(1000);

    const rejected = await app.request('/api/projects/configs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'github.com/kookr-ai/maison', zeroDrainIssueLimit: 1001 }),
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ field: 'zeroDrainIssueLimit', maximum: 1000 });

    const unlimitedRejected = await app.request('/api/projects/configs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'github.com/kookr-ai/maison', zeroDrainIssueLimit: -1 }),
    });
    expect(unlimitedRejected.status).toBe(400);
    expect(await unlimitedRejected.json()).toMatchObject({ field: 'zeroDrainIssueLimit', maximum: 1000 });

    const invalid = await app.request('/api/projects/configs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'github.com/kookr-ai/maison', zeroDrainIssueLimit: 1.5 }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: expect.stringContaining('safe integer') });

    const belowSentinel = await app.request('/api/projects/configs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'github.com/kookr-ai/maison', zeroDrainIssueLimit: -2 }),
    });
    expect(belowSentinel.status).toBe(400);
    expect(await belowSentinel.json()).toMatchObject({ error: expect.stringContaining('-1') });
  });
});

describe('GET /api/projects', () => {
  let tempDir: string;
  let ossAttemptStore: OssAttemptStore;
  let ledgerAnalytics: LedgerAnalytics;
  let projectConfigStore: ProjectConfigStore;
  let taskStore: TaskStore;
  let monitor: Monitor;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'proj-route-test-'));
    ossAttemptStore = new OssAttemptStore(tempDir);
    ledgerAnalytics = new LedgerAnalytics(ossAttemptStore);
    projectConfigStore = new ProjectConfigStore(tempDir);
    taskStore = new TaskStore();
    monitor = new Monitor(taskStore, new AttentionQueue());
    await ossAttemptStore.load();
    await projectConfigStore.load();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('tracked=true returns explicitly tracked and local projects only', async () => {
    const liveLocalPath = join(tempDir, 'live-local-work');
    mkdirSync(liveLocalPath);
    projectConfigStore.setConfig('github.com/acme/tracked', { tracked: true });
    projectConfigStore.setConfig('github.com/acme/notes-only', { notes: 'config row, not tracked' });
    projectConfigStore.setConfig('local/live-local-work', { notes: 'local checkout', localPath: liveLocalPath });
    projectConfigStore.setConfig('local/dead-local-work', {
      notes: 'deleted checkout',
      localPath: join(tempDir, 'missing-local-work'),
    });

    const app = mkApp(mkProjectDeps({
      taskStore,
      monitor,
      ledgerAnalytics,
      projectConfigStore,
      getRegistryActiveProjects: () => ['github.com/registry/seeded'],
      skillDiscoveryState: { getProjects: () => ['github.com/skill/seeded'] } as never,
      projectSidebarStore: { getSeedProjects: () => ['github.com/sidebar/seeded'] } as never,
    }));

    const res = await app.request('/api/projects?tracked=true');

    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ project: string }>;
    expect(body.map((project) => project.project).sort()).toEqual([
      'github.com/acme/tracked',
      'local/live-local-work',
    ]);
  });

  test('omits dead local projects by default', async () => {
    const liveLocalPath = join(tempDir, 'live-local-work');
    mkdirSync(liveLocalPath);
    projectConfigStore.setConfig('local/live-local-work', { notes: 'live checkout', localPath: liveLocalPath });
    projectConfigStore.setConfig('local/dead-local-work', {
      notes: 'deleted checkout',
      localPath: join(tempDir, 'missing-local-work'),
    });

    const app = mkApp(mkProjectDeps({
      taskStore,
      monitor,
      ledgerAnalytics,
      projectConfigStore,
    }));

    const res = await app.request('/api/projects');

    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ project: string }>;
    expect(body.map((project) => project.project).sort()).toEqual(['local/live-local-work']);
  });
});
