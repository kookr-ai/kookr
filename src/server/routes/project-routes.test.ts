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

describe('GET /api/projects', () => {
  let tempDir: string;
  let ossAttemptStore: OssAttemptStore;
  let ledgerAnalytics: LedgerAnalytics;
  let projectConfigStore: ProjectConfigStore;
  let taskStore: TaskStore;
  let queue: AttentionQueue;
  let monitor: Monitor;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'proj-route-test-'));
    ossAttemptStore = new OssAttemptStore(tempDir);
    ledgerAnalytics = new LedgerAnalytics(ossAttemptStore);
    projectConfigStore = new ProjectConfigStore(tempDir);
    taskStore = new TaskStore();
    queue = new AttentionQueue({
      taskIdFor: (agentId) => taskStore.findTaskBySession(agentId)?.id ?? null,
    });
    monitor = new Monitor(taskStore, queue);
    await ossAttemptStore.load();
    await projectConfigStore.load();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('tracked=true returns explicitly tracked, active own, and live local projects only', async () => {
    const liveLocalPath = join(tempDir, 'tmp-local-work');
    mkdirSync(liveLocalPath);
    projectConfigStore.setConfig('github.com/acme/tracked', { tracked: true });
    projectConfigStore.setConfig('github.com/acme/notes-only', { notes: 'config row, not tracked' });
    projectConfigStore.setConfig('local/tmp-local-work', { notes: 'local checkout', localPath: liveLocalPath });
    projectConfigStore.setConfig('local/dead-local-work', {
      notes: 'deleted checkout',
      localPath: join(tempDir, 'missing-local-work'),
    });
    const active = taskStore.createTask({
      prompt: 'Active task',
      cwd: '/cwd/active',
      projectId: 'github.com/acme/active',
    });
    taskStore.addSession(active.id, {
      tmuxSession: 'active-session',
      agentType: 'claude-code',
      cwd: '/cwd/active',
      createdAt: new Date(),
    });
    monitor.registerAgent('active-session');

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
      'github.com/acme/active',
      'github.com/acme/tracked',
      'local/tmp-local-work',
    ]);
  });

  test('keeps missing-path local projects when an in-progress task is snoozed', async () => {
    projectConfigStore.setConfig('local/snoozed-work', {
      notes: 'deleted checkout with a live task',
      localPath: join(tempDir, 'missing-snoozed-work'),
    });
    const task = taskStore.createTask({
      prompt: 'Snoozed task',
      cwd: '/cwd/snoozed',
      projectId: 'local/snoozed-work',
    });
    taskStore.addSession(task.id, {
      tmuxSession: 'snoozed-session',
      agentType: 'claude-code',
      cwd: '/cwd/snoozed',
      createdAt: new Date(),
    });
    monitor.registerAgent('snoozed-session');
    queue.snooze('snoozed-session', 60_000);

    const app = mkApp(mkProjectDeps({
      taskStore,
      monitor,
      ledgerAnalytics,
      projectConfigStore,
    }));

    const res = await app.request('/api/projects?tracked=true');

    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ project: string; activeAgents: number }>;
    expect(body).toEqual([
      expect.objectContaining({
        project: 'local/snoozed-work',
        activeAgents: 0,
      }),
    ]);
  });
});
