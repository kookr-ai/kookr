import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OssAttemptStore } from '../../core/oss-attempt-store.js';
import { LedgerAnalytics } from '../../core/ledger-analytics.js';
import { registerProjectRoutes } from './project-routes.js';
import type { RouteDeps } from './shared.js';

function mkApp(deps: Partial<RouteDeps>): Hono {
  const app = new Hono();
  registerProjectRoutes(app, deps as unknown as RouteDeps);
  return app;
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
