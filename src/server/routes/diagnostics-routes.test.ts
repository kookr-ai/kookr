import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskStore } from '../../core/tasks.js';
import { CircuitBreaker, CircuitBreakerRegistry } from '../../core/circuit-breaker.js';
import { ShadowDetectorRegistry } from '../../core/shadow-detector.js';
import { GitHubStateStore } from '../../core/github-state-store.js';
import { registerDiagnosticsRoutes } from './diagnostics-routes.js';
import type { RouteDeps } from './shared.js';
import type { LlmClient } from '../../core/llm-client.js';

function mkApp(deps: Partial<RouteDeps>): Hono {
  const app = new Hono();
  registerDiagnosticsRoutes(app, deps as unknown as RouteDeps);
  return app;
}

function fakeLlm(output: string | null): LlmClient {
  return {
    provider: 'fake-provider',
    model: 'fake-model',
    complete: vi.fn(async () => output),
  };
}

describe('diagnostics routes', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'diag-routes-test-'));
    delete process.env.KOOKR_FINDING_REVIEW_ENABLED;
    delete process.env.KOOKR_FINDING_REVIEW_DAILY_COST_CENTS;
    delete process.env.KOOKR_FINDING_REVIEW_TOKEN;
    delete process.env.KOOKR_FINDING_REVIEW_ADMIN_TOKEN;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env.KOOKR_FINDING_REVIEW_ENABLED;
    delete process.env.KOOKR_FINDING_REVIEW_DAILY_COST_CENTS;
    delete process.env.KOOKR_FINDING_REVIEW_TOKEN;
    delete process.env.KOOKR_FINDING_REVIEW_ADMIN_TOKEN;
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
  // GET /api/finding-evidence-audit
  // ---------------------------------------------------------------------------
  describe('GET /api/finding-evidence-audit', () => {
    test('returns records and review candidates from the monitor', async () => {
      const record = {
        id: 'finding-1',
        agentId: 'agent-1',
        anomalyType: 'needs_input',
        explanation: 'Waiting',
        detectedAt: '2026-05-18T10:00:00.000Z',
        updatedAt: '2026-05-18T10:00:05.000Z',
        status: 'active',
        verdict: 'supports_finding',
        observations: [],
        notes: [],
      };
      const monitor = {
        getFindingEvidenceAuditRecords: () => [record],
        getFindingEvidenceReviewCandidates: (limit: number) => [{ ...record, id: `candidate-${limit}` }],
      };

      const res = await mkApp({ monitor: monitor as never }).request('/api/finding-evidence-audit');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        records: [record],
        reviewCandidates: [{ ...record, id: 'candidate-20' }],
      });
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/finding-evidence-review
  // ---------------------------------------------------------------------------
  describe('POST /api/finding-evidence-review', () => {
    function reviewRecord() {
      return {
        id: 'finding-1',
        agentId: 'agent-1',
        anomalyType: 'needs_input',
        explanation: 'Raw explanation must stay private',
        detectedAt: '2026-05-18T10:00:00.000Z',
        updatedAt: '2026-05-18T10:00:12.000Z',
        status: 'active',
        verdict: 'possible_false_positive',
        observations: [
          {
            sampledAt: '2026-05-18T10:00:12.000Z',
            ageMs: 12_000,
            source: 'watchdog_tick',
            anomalyStillPresent: true,
            lastEventType: 'tool_use',
            eventCount: 5,
            paneExcerpt: 'Raw terminal text must stay private',
          },
        ],
        notes: ['private note'],
      };
    }

    function reviewDeps(llmClient: LlmClient | null = fakeLlm(null)): Partial<RouteDeps> {
      const monitor = {
        getFindingEvidenceReviewCandidates: () => [reviewRecord()],
        getFindingEvidenceAuditRecords: () => [reviewRecord()],
      };
      return {
        monitor: monitor as never,
        llmClient,
        kookrDir: tempDir,
        findingEvidenceReviewHmacKey: Buffer.from('0123456789abcdef0123456789abcdef'),
        buildInfo: {
          commitHash: 'abc123',
          commitShort: 'abc123',
          branch: 'test',
          buildTimestamp: '',
          version: 'test',
        },
      };
    }

    test('fails closed when the feature flag is disabled', async () => {
      const res = await mkApp(reviewDeps()).request('http://127.0.0.1/api/finding-evidence-review', {
        method: 'POST',
      });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'finding-review-disabled' });
    });

    test('requires an LLM provider even for estimate_only', async () => {
      process.env.KOOKR_FINDING_REVIEW_ENABLED = 'true';
      const res = await mkApp(reviewDeps(null)).request('http://127.0.0.1/api/finding-evidence-review', {
        method: 'POST',
      });

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'finding-review-llm-unavailable' });
    });

    test('rejects non-loopback requests and ignores forwarded loopback headers', async () => {
      process.env.KOOKR_FINDING_REVIEW_ENABLED = 'true';
      const res = await mkApp(reviewDeps()).request('http://example.com/api/finding-evidence-review', {
        method: 'POST',
        headers: { 'x-forwarded-for': '127.0.0.1' },
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'finding-review-forbidden' });
    });

    test('allows a configured admin token on a non-loopback request', async () => {
      process.env.KOOKR_FINDING_REVIEW_ENABLED = 'true';
      process.env.KOOKR_FINDING_REVIEW_ADMIN_TOKEN = 'admin-secret';
      const res = await mkApp(reviewDeps()).request('http://example.com/api/finding-evidence-review', {
        method: 'POST',
        headers: { 'x-kookr-admin-token': 'admin-secret' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.mode).toBe('estimate_only');
    });

    test('rejects missing or wrong review CSRF token when configured', async () => {
      process.env.KOOKR_FINDING_REVIEW_ENABLED = 'true';
      process.env.KOOKR_FINDING_REVIEW_ADMIN_TOKEN = 'admin-secret';
      process.env.KOOKR_FINDING_REVIEW_TOKEN = 'csrf-secret';

      const missing = await mkApp(reviewDeps()).request('http://example.com/api/finding-evidence-review', {
        method: 'POST',
        headers: { 'x-kookr-admin-token': 'admin-secret' },
      });
      expect(missing.status).toBe(403);
      expect(await missing.json()).toEqual({ error: 'invalid-finding-review-token' });

      const wrong = await mkApp(reviewDeps()).request('http://example.com/api/finding-evidence-review', {
        method: 'POST',
        headers: {
          'x-kookr-admin-token': 'admin-secret',
          'x-kookr-finding-review-token': 'wrong',
        },
      });
      expect(wrong.status).toBe(403);
      expect(await wrong.json()).toEqual({ error: 'invalid-finding-review-token' });
    });

    test('rejects malformed JSON and invalid mode before service execution', async () => {
      process.env.KOOKR_FINDING_REVIEW_ENABLED = 'true';
      process.env.KOOKR_FINDING_REVIEW_ADMIN_TOKEN = 'admin-secret';

      const invalidJson = await mkApp(reviewDeps()).request('http://example.com/api/finding-evidence-review', {
        method: 'POST',
        headers: { 'x-kookr-admin-token': 'admin-secret' },
        body: '{',
      });
      expect(invalidJson.status).toBe(400);
      expect(await invalidJson.json()).toEqual({ error: 'invalid-json' });

      const invalidMode = await mkApp(reviewDeps()).request('http://example.com/api/finding-evidence-review', {
        method: 'POST',
        headers: { 'x-kookr-admin-token': 'admin-secret' },
        body: JSON.stringify({ mode: 'unexpected_mode' }),
      });
      expect(invalidMode.status).toBe(400);
      expect(await invalidMode.json()).toEqual({ error: 'invalid-mode' });
    });

    test('estimate_only returns safe projection by default', async () => {
      process.env.KOOKR_FINDING_REVIEW_ENABLED = 'true';
      process.env.KOOKR_FINDING_REVIEW_ADMIN_TOKEN = 'admin-secret';
      const res = await mkApp(reviewDeps()).request('http://example.com/api/finding-evidence-review', {
        method: 'POST',
        headers: { 'x-kookr-admin-token': 'admin-secret' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.mode).toBe('estimate_only');
      expect(body.dryRun.candidates).toEqual([
        expect.objectContaining({
          candidateId: 'finding-1',
          anomalyType: 'needs_input',
          auditVerdict: 'possible_false_positive',
          inputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      ]);
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain('Raw explanation');
      expect(serialized).not.toContain('Raw terminal text');
      expect(serialized).not.toContain('explanationHash');
    });

    test('model_review requires positive budget before model call', async () => {
      process.env.KOOKR_FINDING_REVIEW_ENABLED = 'true';
      process.env.KOOKR_FINDING_REVIEW_ADMIN_TOKEN = 'admin-secret';
      const model = fakeLlm(JSON.stringify({}));
      const res = await mkApp(reviewDeps(model)).request('http://example.com/api/finding-evidence-review', {
        method: 'POST',
        headers: { 'x-kookr-admin-token': 'admin-secret' },
        body: JSON.stringify({ mode: 'model_review' }),
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'finding-review-budget-required' });
      expect(model.complete).not.toHaveBeenCalled();
    });

    test('invalid model output returns invalid-attempt result', async () => {
      process.env.KOOKR_FINDING_REVIEW_ENABLED = 'true';
      process.env.KOOKR_FINDING_REVIEW_ADMIN_TOKEN = 'admin-secret';
      process.env.KOOKR_FINDING_REVIEW_DAILY_COST_CENTS = '5';
      const res = await mkApp(reviewDeps(fakeLlm('not-json'))).request('http://example.com/api/finding-evidence-review', {
        method: 'POST',
        headers: { 'x-kookr-admin-token': 'admin-secret' },
        body: JSON.stringify({ mode: 'model_review' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results).toEqual([
        {
          status: 'invalid_attempt',
          attempt: expect.objectContaining({
            schemaVersion: 'finding-evidence-review-invalid-attempt.v1',
            candidateId: 'finding-1',
            failureKind: 'malformed_json',
            rawOutputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
            error: 'model output was not valid JSON',
          }),
        },
      ]);
    });

    test('persisted_review appends valid reviews and invalid attempts to diagnostics JSONL', async () => {
      process.env.KOOKR_FINDING_REVIEW_ENABLED = 'true';
      process.env.KOOKR_FINDING_REVIEW_ADMIN_TOKEN = 'admin-secret';
      process.env.KOOKR_FINDING_REVIEW_DAILY_COST_CENTS = '5';

      const valid = await mkApp(reviewDeps(fakeLlm(JSON.stringify({
        candidateId: 'finding-1',
        verdict: 'likely_false_positive',
        confidence: 'medium',
        evidenceRefs: ['finding-1:observation:1'],
        rationale: 'terminal activity continued after the finding',
      })))).request('http://example.com/api/finding-evidence-review', {
        method: 'POST',
        headers: { 'x-kookr-admin-token': 'admin-secret' },
        body: JSON.stringify({ mode: 'persisted_review' }),
      });
      expect(valid.status).toBe(200);
      expect(await valid.json()).toEqual(expect.objectContaining({
        mode: 'persisted_review',
        reviewLog: { appendedRecords: 1 },
      }));

      const invalid = await mkApp(reviewDeps(fakeLlm('not-json'))).request('http://example.com/api/finding-evidence-review', {
        method: 'POST',
        headers: { 'x-kookr-admin-token': 'admin-secret' },
        body: JSON.stringify({ mode: 'persisted_review' }),
      });
      expect(invalid.status).toBe(200);

      type ReviewLogLine = {
        kind: string;
        inputHash: string;
        review?: unknown;
        attempt?: { failureKind: string; rawOutputHash: string };
      };
      const rawLog = readFileSync(join(tempDir, 'finding-evidence-reviews.jsonl'), 'utf8');
      const lines = rawLog
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as ReviewLogLine);
      expect(lines).toEqual([
        expect.objectContaining({
          kind: 'valid_review',
          inputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          review: expect.objectContaining({ verdict: 'likely_false_positive' }),
        }),
        expect.objectContaining({
          kind: 'invalid_attempt',
          inputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          attempt: expect.objectContaining({
            failureKind: 'malformed_json',
            rawOutputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          }),
        }),
      ]);
    });

    test('review-log diagnostics route skips invalid lines without requiring runtime state', async () => {
      process.env.KOOKR_FINDING_REVIEW_ADMIN_TOKEN = 'admin-secret';
      writeFileSync(join(tempDir, 'finding-evidence-reviews.jsonl'), [
        '{bad-json',
        JSON.stringify({ schemaVersion: 'finding-evidence-review-log-record.v1', kind: 'invalid_attempt' }),
      ].join('\n'));

      const res = await mkApp(reviewDeps(null)).request('http://example.com/api/finding-evidence-review-log?limit=10', {
        headers: { 'x-kookr-admin-token': 'admin-secret' },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        schemaVersion: 'finding-evidence-review-log-read.v1',
        records: [],
        diagnostics: [
          { lineNumber: 1, failureKind: 'malformed_json', message: 'line was not valid JSON' },
          { lineNumber: 2, failureKind: 'invalid_record', message: 'line did not match finding evidence review log schema' },
        ],
      });
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
  // POST /api/hook-event/:sessionId
  // ---------------------------------------------------------------------------
  describe('POST /api/hook-event/:sessionId', () => {
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

    test('rejects unsafe session ids before ingestion', async () => {
      const ingestFromHttp = vi.fn();
      const res = await mkApp({ hookIngestion: { ingestFromHttp } as never })
        .request('/api/hook-event/..%2Fescape', {
          method: 'POST',
          body: JSON.stringify({ hook_event_name: 'PreToolUse' }),
        });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid session id' });
      expect(ingestFromHttp).not.toHaveBeenCalled();
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
