import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import {
  computeApiRouteDrift,
  extractDocumentedApiRoutes,
  extractPathConstants,
  extractRegisteredApiRoutes,
  verifyDocumentedApiRoutes,
} from './documented-api-route-verifier.js';

describe('extractRegisteredApiRoutes', () => {
  it('matches string-literal app.get/post/put/patch/delete registrations', () => {
    const content = [
      "app.get('/api/health', (c) => c.json({ ok: true }));",
      'app.post("/api/tasks", async (c) => {});',
      "app.put('/api/settings', handler);",
      "app.patch('/api/schedules/:id', handler);",
      "app.delete('/api/tasks/:id', handler);",
      // Not /api/*
      "app.get('/metrics', handler);",
      // Middleware wildcard — ignored
      "app.use('/api/*', middleware);",
    ].join('\n');

    expect(extractRegisteredApiRoutes(content)).toEqual([
      'DELETE /api/tasks/:id',
      'GET /api/health',
      'PATCH /api/schedules/:id',
      'POST /api/tasks',
      'PUT /api/settings',
    ]);
  });

  it('resolves same-file path constants and template suffixes', () => {
    const content = [
      "const ISSUE_CLAIMS_PATH = '/api/issue-claims';",
      'app.post(ISSUE_CLAIMS_PATH, async (c) => {});',
      'app.get(ISSUE_CLAIMS_PATH, (c) => {});',
      'app.post(`${ISSUE_CLAIMS_PATH}/exhausted`, async (c) => {});',
    ].join('\n');

    expect(extractRegisteredApiRoutes(content)).toEqual([
      'GET /api/issue-claims',
      'POST /api/issue-claims',
      'POST /api/issue-claims/exhausted',
    ]);
  });

  it('resolves imported path constants when a map is provided', () => {
    const content = "app.get(REQUEST_LATENCIES_ROUTE, (c) => c.json([]));";
    const constants = new Map([
      ['REQUEST_LATENCIES_ROUTE', '/api/diagnostics/request-latencies'],
    ]);
    expect(extractRegisteredApiRoutes(content, constants)).toEqual([
      'GET /api/diagnostics/request-latencies',
    ]);
  });

  it('ignores non-route call sites and dynamic first args', () => {
    expect(extractRegisteredApiRoutes("app.get(buildPath(), handler);")).toEqual([]);
    expect(extractRegisteredApiRoutes("const x = app.get;")).toEqual([]);
  });
});

describe('extractPathConstants', () => {
  it('collects exported and local absolute path string constants', () => {
    const content = [
      "export const REQUEST_LATENCIES_ROUTE = '/api/diagnostics/request-latencies';",
      "const ENVIRONMENT_BLOCKERS_PATH = '/api/environment-blockers';",
      "const notAPath = 'relative';",
      "const number = 3;",
    ].join('\n');

    expect(Object.fromEntries(extractPathConstants(content))).toEqual({
      REQUEST_LATENCIES_ROUTE: '/api/diagnostics/request-latencies',
      ENVIRONMENT_BLOCKERS_PATH: '/api/environment-blockers',
    });
  });
});

describe('extractDocumentedApiRoutes', () => {
  it('collects METHOD /api/... mentions from tables, headings, and prose', () => {
    const markdown = [
      '| `GET /api/health` | status |',
      '| `POST /api/tasks` | create |',
      '### `GET /api/tasks?view=compact`',
      'See also GET /api/tasks/:taskId/activity-diagnostics for counts.',
      'Not a route: GET /metrics',
      'Trailing junk: `DELETE /api/tasks/:id`.',
    ].join('\n');

    expect(extractDocumentedApiRoutes(markdown)).toEqual([
      'DELETE /api/tasks/:id',
      'GET /api/health',
      'GET /api/tasks',
      'GET /api/tasks/:taskId/activity-diagnostics',
      'POST /api/tasks',
    ]);
  });
});

describe('computeApiRouteDrift', () => {
  const base = {
    registered: ['GET /api/health'],
    documented: ['GET /api/health'],
    internalAllowlist: [] as string[],
  };

  it('passes cleanly when registered routes are documented', () => {
    expect(computeApiRouteDrift(base).issues).toEqual([]);
  });

  it('flags an undocumented registered route', () => {
    const result = computeApiRouteDrift({
      ...base,
      registered: ['GET /api/health', 'POST /api/secret'],
    });
    expect(result.issues).toEqual([
      expect.objectContaining({
        route: 'POST /api/secret',
        message: expect.stringContaining('not documented'),
      }),
    ]);
  });

  it('accepts allowlisted internal routes without documentation', () => {
    const result = computeApiRouteDrift({
      ...base,
      registered: ['GET /api/health', 'GET /api/ready'],
      internalAllowlist: ['GET /api/ready'],
    });
    expect(result.issues).toEqual([]);
    expect(result.checked).toBe(2);
  });

  it('flags a redundant internal allowlist entry that is now documented', () => {
    const result = computeApiRouteDrift({
      registered: ['GET /api/health'],
      documented: ['GET /api/health'],
      internalAllowlist: ['GET /api/health'],
    });
    expect(result.issues).toEqual([
      expect.objectContaining({
        route: 'GET /api/health',
        message: expect.stringContaining('INTERNAL_API_ROUTES'),
      }),
    ]);
  });
});

describe('verifyDocumentedApiRoutes', () => {
  it('reports undocumented routes against a temp repo', () => {
    const repoRoot = createRepo({
      source: [
        "import type { Hono } from 'hono';",
        'export function register(app: Hono) {',
        "  app.get('/api/health', (c) => c.json({ ok: true }));",
        "  app.post('/api/undocumented', (c) => c.json({}));",
        '}',
      ].join('\n'),
      docs: '| `GET /api/health` | status |\n',
    });

    const result = verifyDocumentedApiRoutes(repoRoot, {
      sourceRoots: ['src/server'],
      internalAllowlist: [],
    });

    expect(result.issues).toEqual([
      expect.objectContaining({ route: 'POST /api/undocumented' }),
    ]);
    expect(result.checked).toBe(2);
  });

  it('resolves cross-file path constants in a temp repo', () => {
    const repoRoot = createRepo({
      source: "app.get(REQUEST_LATENCIES_ROUTE, (c) => c.json([]));\n",
      docs: '| `GET /api/diagnostics/request-latencies` | latencies |\n',
      extraFiles: {
        'src/server/request-duration-metrics.ts':
          "export const REQUEST_LATENCIES_ROUTE = '/api/diagnostics/request-latencies';\n",
      },
    });

    const result = verifyDocumentedApiRoutes(repoRoot, {
      sourceRoots: ['src/server'],
      internalAllowlist: [],
    });
    expect(result.issues).toEqual([]);
    expect(result.registered).toEqual(['GET /api/diagnostics/request-latencies']);
  });

  it('passes against the real repository (baseline guard)', () => {
    const result = verifyDocumentedApiRoutes(process.cwd());
    expect(result.issues).toEqual([]);
    // Guard against a silent false-green where the scanner finds nothing.
    expect(result.checked).toBeGreaterThan(50);
  });
});

describe('verify-documented-api-routes CLI', () => {
  it('exits 0 and prints a pass message for the real repository', () => {
    const result = runCli(process.cwd());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Documented API-route verification passed.');
    expect(result.stderr).not.toContain('verification failed');
  });

  it('exits 1 and prints issues when routes drift', () => {
    const repoRoot = createRepo({
      source: "app.post('/api/undocumented', (c) => c.json({}));\n",
      docs: '# none\n',
    });

    const result = runCli(repoRoot);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Documented API-route verification failed:');
    expect(result.stderr).toContain('POST /api/undocumented');
  });
});

function createRepo(input: {
  source: string;
  docs: string;
  extraFiles?: Record<string, string>;
}): string {
  const repoRoot = join(
    tmpdir(),
    `kookr-doc-api-route-test-${process.pid}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(join(repoRoot, 'src', 'server', 'routes'), { recursive: true });
  mkdirSync(join(repoRoot, 'docs', 'reference'), { recursive: true });
  writeFileSync(join(repoRoot, 'src', 'server', 'routes', 'sample-routes.ts'), input.source);
  writeFileSync(join(repoRoot, 'docs', 'reference', 'api.md'), input.docs);
  for (const [rel, body] of Object.entries(input.extraFiles ?? {})) {
    const abs = join(repoRoot, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
  }
  return repoRoot;
}

function runCli(repoRoot: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', join(process.cwd(), 'scripts', 'verify-documented-api-routes.ts'), repoRoot],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
