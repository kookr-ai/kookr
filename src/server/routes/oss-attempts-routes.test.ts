import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { OssAttemptStore } from '../../core/oss-attempt-store.js';
import { OssRefresher } from '../oss-refresh.js';
import { registerOssAttemptRoutes } from './oss-attempts-routes.js';

function mkApp(overrides: Record<string, unknown> = {}) {
  const app = new Hono();
  const broadcasts: number[] = [];
  registerOssAttemptRoutes(app, {
    // Only fill the fields the routes use; the rest are ignored at runtime.
    broadcastOssAttempts: () => broadcasts.push(Date.now()),
    ...(overrides as Parameters<typeof registerOssAttemptRoutes>[1]),
  } as Parameters<typeof registerOssAttemptRoutes>[1]);
  return { app, broadcasts };
}

describe('registerOssAttemptRoutes', () => {
  let tempDir: string;
  let store: OssAttemptStore;
  let registryPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'oss-routes-test-'));
    store = new OssAttemptStore(tempDir);
    registryPath = join(tempDir, 'oss-repos.json');
    writeFileSync(
      registryPath,
      JSON.stringify({ version: 1, repos: { 'grafana/grafana': { status: 'active' } } }),
    );
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('GET /api/oss-attempts returns empty snapshot when store is missing', async () => {
    const { app } = mkApp();
    const res = await app.request('/api/oss-attempts');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.attempts).toEqual([]);
    expect(body.registryActiveRepos).toEqual([]);
    expect(body.lastRefreshAt).toBeNull();
    expect(body.lastRefreshIssueCheckErrors).toEqual([]);
  });

  test('GET /api/oss-attempts returns the store snapshot', async () => {
    await store.load();
    store.upsertPr({
      repo: 'grafana/grafana',
      prNumber: 1,
      prUrl: 'https://github.com/grafana/grafana/pull/1',
      prTitle: 'Fix',
      source: 'posttool_hook',
    });
    const { app } = mkApp({
      ossAttemptStore: store,
      getRegistryActiveRepos: () => ['grafana/grafana'],
    });
    const res = await app.request('/api/oss-attempts');
    const body = await res.json();
    expect(body.attempts).toHaveLength(1);
    expect(body.registryActiveRepos).toEqual(['grafana/grafana']);
    expect(body.attempts[0].id).toBe('grafana/grafana#1');
  });

  test('POST /api/oss-attempts/events accepts a pr_open event and broadcasts', async () => {
    await store.load();
    const { app, broadcasts } = mkApp({ ossAttemptStore: store });
    const res = await app.request('/api/oss-attempts/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'pr_open',
        repo: 'grafana/grafana',
        prNumber: 42,
        prUrl: 'https://github.com/grafana/grafana/pull/42',
        prTitle: 'Hi',
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accepted).toBe(true);
    expect(body.id).toBe('grafana/grafana#42');
    expect(store.getAllAttempts()).toHaveLength(1);
    expect(broadcasts).toHaveLength(1);
  });

  test('POST /api/oss-attempts/events silently skips own-namespace repos', async () => {
    await store.load();
    const { app } = mkApp({ ossAttemptStore: store });
    const res = await app.request('/api/oss-attempts/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'pr_open',
        repo: 'kookr-ai/kookr',
        prNumber: 1,
        prUrl: 'https://github.com/kookr-ai/kookr/pull/1',
        prTitle: 'x',
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accepted).toBe(false);
    expect(body.reason).toBe('own-namespace');
    expect(store.getAllAttempts()).toHaveLength(0);
  });

  test('POST /api/oss-attempts/events rejects invalid kind', async () => {
    await store.load();
    const { app } = mkApp({ ossAttemptStore: store });
    const res = await app.request('/api/oss-attempts/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'wat' }),
    });
    expect(res.status).toBe(400);
  });

  test('POST /api/oss-attempts/events accepts scouted events', async () => {
    await store.load();
    const { app } = mkApp({ ossAttemptStore: store });
    const res = await app.request('/api/oss-attempts/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'scouted',
        repo: 'grafana/grafana',
        issueNumber: 100,
        issueUrl: 'https://github.com/grafana/grafana/issues/100',
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accepted).toBe(true);
    expect(body.id).toBe('grafana/grafana#issue-100');
  });

  test('POST /api/oss-attempts/refresh runs the refresher', async () => {
    await store.load();
    const refresher = new OssRefresher({
      store,
      registryPath,
      runGh: async () => ({ stdout: '[]', stderr: '' }),
    });
    const { app, broadcasts } = mkApp({ ossAttemptStore: store, ossRefresher: refresher });
    const res = await app.request('/api/oss-attempts/refresh', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(broadcasts).toHaveLength(1);
  });

  test('POST /api/oss-attempts/refresh returns 503 when refresher is not configured', async () => {
    const { app } = mkApp();
    const res = await app.request('/api/oss-attempts/refresh', { method: 'POST' });
    expect(res.status).toBe(503);
  });
});
