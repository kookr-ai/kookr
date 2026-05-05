import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskStore } from '../../core/tasks.js';
import { CircuitBreaker, CircuitBreakerRegistry } from '../../core/circuit-breaker.js';
import { ShadowDetectorRegistry } from '../../core/shadow-detector.js';
import { GitHubStateStore } from '../../core/github-state-store.js';
import { registerDiagnosticsRoutes } from './diagnostics-routes.js';
import type { RouteDeps } from './shared.js';

function mkApp(deps: Partial<RouteDeps>): Hono {
  const app = new Hono();
  registerDiagnosticsRoutes(app, deps as unknown as RouteDeps);
  return app;
}

describe('diagnostics routes', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'diag-routes-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // GET /api/health/stt
  // ---------------------------------------------------------------------------
  describe('GET /api/health/stt', () => {
    test('returns {status:"disabled"} when sttUrl is not configured', async () => {
      const res = await mkApp({}).request('/api/health/stt');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'disabled' });
    });

    test('returns {status:"unavailable"} with 200 when STT service is unreachable', async () => {
      // Connecting to port 1 on loopback fails fast with ECONNREFUSED —
      // handler is documented to return 200 with status:"unavailable" so the
      // polling UI does not fire fetch() error handlers.
      const res = await mkApp({ sttUrl: 'ws://127.0.0.1:1' }).request('/api/health/stt');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('unavailable');
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/anomaly-stats
  // ---------------------------------------------------------------------------
  describe('GET /api/anomaly-stats', () => {
    test('returns current DetectionStats shape', async () => {
      const res = await mkApp({}).request('/api/anomaly-stats');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual(expect.objectContaining({
        checks: expect.any(Object),
        fires: expect.any(Object),
        falsePositives: expect.any(Object),
        suppressed: expect.any(Object),
        subagentOrphans: expect.any(Number),
        subagentSessionsWithOrphans: expect.any(Number),
        subagentTtlEvictions: expect.any(Number),
      }));
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/circuit-breakers
  // ---------------------------------------------------------------------------
  describe('GET /api/circuit-breakers', () => {
    test('returns [] when no registry is wired', async () => {
      const res = await mkApp({}).request('/api/circuit-breakers');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    });

    test('returns snapshots for all registered breakers', async () => {
      const registry = new CircuitBreakerRegistry();
      registry.register(new CircuitBreaker({ name: 'gh-api' }));
      registry.register(new CircuitBreaker({ name: 'worktree' }));

      const res = await mkApp({ circuitBreakerRegistry: registry }).request('/api/circuit-breakers');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveLength(2);
      const names = body.map((b: { name: string }) => b.name).sort();
      expect(names).toEqual(['gh-api', 'worktree']);
      expect(body[0]).toEqual(expect.objectContaining({
        state: 'closed',
        failureCount: 0,
      }));
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/hook-event/:tmuxName
  // ---------------------------------------------------------------------------
  describe('POST /api/hook-event/:tmuxName', () => {
    test('returns 200 and records arrival when body is non-empty', async () => {
      const arrivals: Array<{ tmux: string; body: string }> = [];
      const httpPushTracker = {
        recordHttpArrival: (tmux: string, body: string) => {
          arrivals.push({ tmux, body });
        },
      };
      const res = await mkApp({ httpPushTracker: httpPushTracker as never })
        .request('/api/hook-event/kookr-abc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hook_event_name: 'PreToolUse' }),
        });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'received' });
      expect(arrivals).toHaveLength(1);
      expect(arrivals[0].tmux).toBe('kookr-abc');
    });

    test('returns 400 with {status:"empty"} when body is blank', async () => {
      const res = await mkApp({}).request('/api/hook-event/kookr-abc', {
        method: 'POST',
        body: '   \n',
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ status: 'empty' });
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/shadow-report
  // ---------------------------------------------------------------------------
  describe('GET /api/shadow-report', () => {
    test('returns 404 when shadowRegistry is not wired', async () => {
      const res = await mkApp({}).request('/api/shadow-report');
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Shadow detection not configured' });
    });

    test('returns a JSON report when the shadow log exists', async () => {
      const logPath = join(tempDir, 'shadow.jsonl');
      writeFileSync(logPath, ''); // empty but readable
      const registry = new ShadowDetectorRegistry(logPath);

      const res = await mkApp({ shadowRegistry: registry }).request('/api/shadow-report');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual(expect.objectContaining({
        generatedAt: expect.any(String),
        strategies: expect.any(Array),
        totalEntries: expect.any(Number),
        parseErrors: expect.any(Number),
      }));
    });

    test('returns text/plain when ?format=text is passed', async () => {
      const logPath = join(tempDir, 'shadow.jsonl');
      writeFileSync(logPath, '');
      const registry = new ShadowDetectorRegistry(logPath);

      const res = await mkApp({ shadowRegistry: registry }).request('/api/shadow-report?format=text');
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('Shadow Detection Report');
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/telemetry/report
  // ---------------------------------------------------------------------------
  describe('GET /api/telemetry/report', () => {
    test('returns an empty report when interactionLog has no file yet', async () => {
      const interactionLog = { getFilePath: () => null };
      const res = await mkApp({ interactionLog: interactionLog as never })
        .request('/api/telemetry/report');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual(expect.objectContaining({
        totalEvents: 0,
        timeRange: null,
        eventCounts: expect.any(Object),
      }));
    });

    test('reads the telemetry file next to the interaction log', async () => {
      const sessionDir = join(tempDir, 'session-1');
      mkdirSync(sessionDir, { recursive: true });
      const interactionsPath = join(sessionDir, 'interactions.jsonl');
      const telemetryPath = join(sessionDir, 'telemetry.jsonl');
      writeFileSync(interactionsPath, ''); // presence is enough
      writeFileSync(telemetryPath, JSON.stringify({
        type: 'tab_switched',
        timestamp: '2026-04-06T09:00:00.000Z',
        data: { from: 'a', to: 'b' },
      }) + '\n');

      const interactionLog = { getFilePath: () => interactionsPath };
      const res = await mkApp({ interactionLog: interactionLog as never })
        .request('/api/telemetry/report');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.totalEvents).toBe(1);
      expect(body.eventCounts.tab_switched).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/github/:taskId and GET /api/github
  // ---------------------------------------------------------------------------
  describe('GET /api/github/:taskId', () => {
    test('returns 404 when the task is unknown', async () => {
      const taskStore = new TaskStore();
      const githubStateStore = new GitHubStateStore();
      const res = await mkApp({ taskStore, githubStateStore })
        .request('/api/github/does-not-exist');
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Task not found' });
    });

    test('returns the task state when the task exists', async () => {
      const taskStore = new TaskStore();
      const task = taskStore.createTask('Known task', '/tmp');
      const githubStateStore = new GitHubStateStore();
      const res = await mkApp({ taskStore, githubStateStore })
        .request(`/api/github/${task.id}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.taskId).toBe(task.id);
      expect(body.prs).toEqual([]);
      expect(body.issues).toEqual([]);
    });
  });

  describe('GET /api/github (all)', () => {
    test('returns [] when no references have been detected', async () => {
      const taskStore = new TaskStore();
      const githubStateStore = new GitHubStateStore();
      const res = await mkApp({ taskStore, githubStateStore }).request('/api/github');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    });

    test('returns one entry per task that has references', async () => {
      const taskStore = new TaskStore();
      const githubStateStore = new GitHubStateStore();
      githubStateStore.addReference({
        type: 'pr',
        owner: 'kookr-ai',
        repo: 'kookr',
        number: 1,
        url: 'https://github.com/kookr-ai/kookr/pull/1',
        detectedAt: new Date(),
        detectedFrom: 'kookr-abc',
        taskId: 'task-xyz',
      });

      const res = await mkApp({ taskStore, githubStateStore }).request('/api/github');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveLength(1);
      expect(body[0].taskId).toBe('task-xyz');
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/diagnostic and POST /api/diagnostic/run
  // ---------------------------------------------------------------------------
  describe('GET /api/diagnostic', () => {
    test('returns {report:null, lastError:null} when runner is not wired', async () => {
      const res = await mkApp({}).request('/api/diagnostic');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ report: null, lastError: null });
    });

    test('returns the runner status when wired', async () => {
      const diagnosticRunner = {
        getStatus: () => ({ report: { findings: [] }, lastError: null }),
      };
      const res = await mkApp({ diagnosticRunner: diagnosticRunner as never })
        .request('/api/diagnostic');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.report).toEqual({ findings: [] });
      expect(body.lastError).toBeNull();
    });
  });

  describe('POST /api/diagnostic/run', () => {
    test('returns 503 when runner is not wired', async () => {
      const res = await mkApp({}).request('/api/diagnostic/run', { method: 'POST' });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'Diagnostic runner not available' });
    });

    test('invokes runNow and returns the report', async () => {
      let called = 0;
      const diagnosticRunner = {
        getStatus: () => ({ report: null, lastError: null }),
        runNow: () => {
          called++;
          return { findings: [{ type: 'slow-route', severity: 'warn' }] };
        },
      };
      const res = await mkApp({ diagnosticRunner: diagnosticRunner as never })
        .request('/api/diagnostic/run', { method: 'POST' });
      expect(res.status).toBe(200);
      expect(called).toBe(1);
      const body = await res.json();
      expect(body.report.findings).toHaveLength(1);
    });
  });

});
