/**
 * Regression: GET /api/diagnostics/lesson-yield must return a valid,
 * semantically-unchanged snapshot for a large real hook-log corpus, within the
 * 10s acceptance ceiling (issue #1585, prod re-confirmed 2026-07-26 — curl exit
 * 000 past a 10s cap). Unlike the mocked scheduling contract test, this drives
 * the REAL scan end-to-end against an oversized on-disk fixture to lock the AC's
 * "valid response + unchanged metric semantics" properties against real I/O.
 *
 * The request-path *bound* itself (an over-budget scan yields 503 warming
 * instead of blocking on the full scan) is guarded deterministically by the
 * fake-timer budget test in diagnostics-routes.lesson-yield.test.ts — a few-MB
 * fixture scans in milliseconds and cannot exercise the 8s budget here. The
 * sub-ceiling response-time assertion below is therefore a coarse smoke bound,
 * not the primary hang guard.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { AttentionQueue } from '../../core/attention-queue.js';
import { registerDiagnosticsRoutes } from './diagnostics-routes.js';
import type { RouteDeps } from './shared.js';
import { LESSON_YIELD_SCHEMA_VERSION } from '../../core/lesson-decision.js';

function preToolBash(command: string): string {
  return JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
  });
}

/** ~2 MB of non-decisive Bash lines followed by a single lesson-write. */
function oversizedHookLog(): string {
  const filler = preToolBash('echo working on the task; ls -la; grep -r foo .');
  const lines: string[] = [];
  for (let i = 0; i < 20_000; i++) lines.push(filler);
  // Decisive line last: the scan reads the whole file before it early-breaks,
  // i.e. the worst case for a single file of this size (no early exit).
  lines.push(preToolBash('kb remember --kb=agent-task-lessons --title="t" --stdin --yes'));
  lines.push('');
  return lines.join('\n');
}

describe('GET /api/diagnostics/lesson-yield oversized-scan bound (issue #1585)', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `kookr-lesson-yield-bound-${process.pid}-${process.hrtime.bigint()}`);
    mkdirSync(join(dir, 'hooks'), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('returns a valid snapshot for a completed task with a huge hook log, within the ceiling', async () => {
    const session = 'oversized-session';
    writeFileSync(join(dir, 'hooks', `${session}.jsonl`), oversizedHookLog(), 'utf8');

    const task = {
      id: 'bound-task',
      status: 'completed',
      updatedAt: new Date().toISOString(),
      sessions: [{ tmuxSession: session }],
    };
    const deps = {
      taskStore: { listTasks: () => [task] },
      queue: new AttentionQueue(),
      buildInfo: {},
      kookrDir: dir,
    } as unknown as RouteDeps;

    const app = new Hono();
    registerDiagnosticsRoutes(app, deps);

    const startedAt = Date.now();
    const res = await app.request('/api/diagnostics/lesson-yield?days=2');
    const elapsedMs = Date.now() - startedAt;

    // The request path must never approach the 30s scan bound. AC ceiling is
    // 10s; a bounded scan of a few-MB fixture returns comfortably under it.
    expect(elapsedMs).toBeLessThan(9_000);
    expect(res.status).toBe(200);

    const body = await res.json() as {
      schemaVersion: string;
      windowDays: number;
      completedInWindow: number;
      decided: number;
      yieldRate: number;
      buckets: { wroteLesson: number };
    };
    // Semantics unchanged from lesson-yield.v1 (#1543): one completed task,
    // one lesson written → fully decided.
    expect(body.schemaVersion).toBe(LESSON_YIELD_SCHEMA_VERSION);
    expect(body.windowDays).toBe(2);
    expect(body.completedInWindow).toBe(1);
    expect(body.decided).toBe(1);
    expect(body.yieldRate).toBe(1);
    expect(body.buckets.wroteLesson).toBe(1);
  });
});
