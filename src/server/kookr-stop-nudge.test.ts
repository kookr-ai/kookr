// Tests the bundled Stop-hook nudge at bin/kookr-stop-nudge.js (RFC:
// rfc-agent-signal-surface §7). Lives under src/server/ so it picks up the
// regular test glob. The script is hard fail-open — every path must exit 0;
// only the fully-qualified path emits a `decision:block` line.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — JS module without bundled types.
import { resolveBaseUrl, markerPath, isTerminalStatus, parseMinAge, waitingOnSubagent, NUDGE_REASON, LESSON_DECISION_TEMPLATE as NUDGE_LESSON_TEMPLATE } from '../../bin/kookr-stop-nudge.js';
import { LESSON_DECISION_TEMPLATE } from '../core/lesson-decision.js';

const NUDGE = resolve(fileURLToPath(import.meta.url), '..', '..', '..', 'bin', 'kookr-stop-nudge.js');
const OLD_CREATED_AT = '2020-01-01T00:00:00.000Z';

// Async spawn (NOT spawnSync) so the parent event loop keeps serving the
// in-process mock server the nudge's fetch hits.
function run({ stdin, env }: { stdin: string; env: Record<string, string> }): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [NUDGE], { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

function blocked(stdout: string): boolean {
  try {
    return JSON.parse(stdout)?.decision === 'block';
  } catch {
    return false;
  }
}

describe('kookr-stop-nudge pure helpers', () => {
  it('resolveBaseUrl prefers KOOKR_API_BASE_URL, then KOOKR_PORT', () => {
    expect(resolveBaseUrl({ KOOKR_API_BASE_URL: 'http://x/' })).toBe('http://x');
    expect(resolveBaseUrl({ KOOKR_PORT: '4800' })).toBe('http://127.0.0.1:4800');
    expect(resolveBaseUrl({})).toBeNull();
    expect(resolveBaseUrl({ KOOKR_PORT: 'nope' })).toBeNull();
  });
  it('isTerminalStatus matches the three terminal states', () => {
    for (const s of ['completed', 'cancelled', 'terminated']) expect(isTerminalStatus(s)).toBe(true);
    for (const s of ['open', 'pending', 'inProgress']) expect(isTerminalStatus(s)).toBe(false);
  });
  it('parseMinAge falls back to default on bad input', () => {
    expect(parseMinAge('1000')).toBe(1000);
    expect(parseMinAge('')).toBe(45_000);
    expect(parseMinAge('nope')).toBe(45_000);
  });
  it('markerPath sanitizes the task id', () => {
    expect(markerPath('../etc/passwd')).not.toContain('..');
  });
  it('waitingOnSubagent counts only a running subagent (issue #4231)', () => {
    expect(waitingOnSubagent([{ type: 'subagent', status: 'running' }])).toBe(true);
    expect(waitingOnSubagent([{ type: 'shell', status: 'running' }, { type: 'subagent', status: 'running' }])).toBe(true);
    expect(waitingOnSubagent([{ type: 'subagent', status: 'completed' }])).toBe(false);
    expect(waitingOnSubagent([{ type: 'shell', status: 'running' }, { type: 'monitor', status: 'running' }])).toBe(false);
    for (const odd of [undefined, null, [], 'running', {}, [null]]) expect(waitingOnSubagent(odd)).toBe(false);
  });
});

describe('kookr-stop-nudge behavior (subprocess, hard fail-open)', () => {
  let server: Server;
  let baseUrl: string;
  let home: string;
  let task: Record<string, unknown>;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'kookr-nudge-home-'));
    task = { id: 't-1', status: 'inProgress', createdAt: OLD_CREATED_AT };
    server = createServer((req, res) => {
      if (req.url === '/api/tasks') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify([task]));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterEach(() => {
    server.close();
    rmSync(home, { recursive: true, force: true });
  });

  function baseEnv(extra: Record<string, string> = {}) {
    return { HOME: home, KOOKR_TASK_ID: 't-1', KOOKR_API_BASE_URL: baseUrl, ...extra };
  }

  it('blocks once for an eligible task, then dedupes on the next stop', async () => {
    const first = await run({ stdin: JSON.stringify({ stop_hook_active: false }), env: baseEnv() });
    expect(first.status).toBe(0);
    expect(blocked(first.stdout)).toBe(true);
    expect(existsSync(join(home, '.kookr', 'stop-nudge', 't-1'))).toBe(true);

    const second = await run({ stdin: JSON.stringify({ stop_hook_active: false }), env: baseEnv() });
    expect(second.status).toBe(0);
    expect(blocked(second.stdout)).toBe(false);
  });

  it('does not spend the reminder while a background subagent is running; the next idle stop gets it (issue #4231)', async () => {
    const subagent = { id: 'a968876863f7fbf18', type: 'subagent', status: 'running', agent_type: 'general-purpose' };
    const waiting = await run({
      stdin: JSON.stringify({ stop_hook_active: false, background_tasks: [subagent] }),
      env: baseEnv(),
    });
    expect(waiting.status).toBe(0);
    expect(blocked(waiting.stdout)).toBe(false);
    expect(existsSync(join(home, '.kookr', 'stop-nudge', 't-1'))).toBe(false);

    const idle = await run({
      stdin: JSON.stringify({ stop_hook_active: false, background_tasks: [{ ...subagent, status: 'completed' }] }),
      env: baseEnv(),
    });
    expect(blocked(idle.stdout)).toBe(true);
    expect(existsSync(join(home, '.kookr', 'stop-nudge', 't-1'))).toBe(true);
  });

  it('a running background shell does not defer the reminder (only subagents do)', async () => {
    const res = await run({
      stdin: JSON.stringify({ stop_hook_active: false, background_tasks: [{ id: 'b1', type: 'shell', status: 'running' }] }),
      env: baseEnv(),
    });
    expect(blocked(res.stdout)).toBe(true);
  });

  it('never re-blocks when stop_hook_active is true', async () => {
    const res = await run({ stdin: JSON.stringify({ stop_hook_active: true }), env: baseEnv() });
    expect(res.status).toBe(0);
    expect(blocked(res.stdout)).toBe(false);
  });

  it('does not nudge without KOOKR_TASK_ID', async () => {
    const res = await run({ stdin: JSON.stringify({ stop_hook_active: false }), env: { HOME: home, KOOKR_API_BASE_URL: baseUrl } });
    expect(res.status).toBe(0);
    expect(blocked(res.stdout)).toBe(false);
  });

  it('does not nudge a terminal task', async () => {
    task.status = 'completed';
    const res = await run({ stdin: JSON.stringify({ stop_hook_active: false }), env: baseEnv() });
    expect(res.status).toBe(0);
    expect(blocked(res.stdout)).toBe(false);
  });

  it('does not nudge when a signal is already raised', async () => {
    task.pendingSignal = { kind: 'completion_ready', raisedAt: OLD_CREATED_AT };
    const res = await run({ stdin: JSON.stringify({ stop_hook_active: false }), env: baseEnv() });
    expect(res.status).toBe(0);
    expect(blocked(res.stdout)).toBe(false);
  });

  it('does not re-nudge after an accepted completion_ready is acked and cleared (issue #1538 defect B)', async () => {
    // First stop while completion_ready is pending: stay silent AND persist the
    // once-per-task marker so the silence survives the signal being cleared.
    task.pendingSignal = { kind: 'completion_ready', raisedAt: OLD_CREATED_AT };
    const first = await run({ stdin: JSON.stringify({ stop_hook_active: false }), env: baseEnv() });
    expect(first.status).toBe(0);
    expect(blocked(first.stdout)).toBe(false);
    expect(existsSync(join(home, '.kookr', 'stop-nudge', 't-1'))).toBe(true);

    // The signal is acked/cleared but the task is still non-terminal (e.g. a
    // follow-up turn). The next stop must NOT re-prompt the whole ritual.
    delete task.pendingSignal;
    const second = await run({ stdin: JSON.stringify({ stop_hook_active: false }), env: baseEnv() });
    expect(second.status).toBe(0);
    expect(blocked(second.stdout)).toBe(false);
  });

  it('honors the KOOKR_NUDGE_DISABLED kill switch', async () => {
    const res = await run({ stdin: JSON.stringify({ stop_hook_active: false }), env: baseEnv({ KOOKR_NUDGE_DISABLED: '1' }) });
    expect(res.status).toBe(0);
    expect(blocked(res.stdout)).toBe(false);
  });

  it('respects the activity gate for very young tasks', async () => {
    task.createdAt = new Date().toISOString();
    const res = await run({ stdin: JSON.stringify({ stop_hook_active: false }), env: baseEnv() });
    expect(res.status).toBe(0);
    expect(blocked(res.stdout)).toBe(false);
  });

  it('exits 0 without blocking when the server is unreachable (never nudge blind)', async () => {
    const res = await run({
      stdin: JSON.stringify({ stop_hook_active: false }),
      env: { HOME: home, KOOKR_TASK_ID: 't-1', KOOKR_API_BASE_URL: 'http://127.0.0.1:1' },
    });
    expect(res.status).toBe(0);
    expect(blocked(res.stdout)).toBe(false);
  });

  it('exits 0 on malformed stdin', async () => {
    const res = await run({ stdin: 'not json', env: baseEnv() });
    expect(res.status).toBe(0);
    expect(blocked(res.stdout)).toBe(false);
  });
});

describe('lesson decision template in the nudge (issue #3695)', () => {
  it('matches the server template exactly, so the first write is the one the gate expects', () => {
    expect(NUDGE_LESSON_TEMPLATE).toBe(LESSON_DECISION_TEMPLATE);
    expect(NUDGE_REASON).toContain(LESSON_DECISION_TEMPLATE);
  });
});

describe('idea prompt in the nudge (issue #4250)', () => {
  it('asks for a simplification idea before the completion signal, not for a feature', () => {
    // Any tool call after the signal clears it, so the idea step must come first.
    const idea = NUDGE_REASON.indexOf('kookr idea add');
    expect(idea).toBeGreaterThan(-1);
    expect(idea).toBeLessThan(NUDGE_REASON.indexOf('kookr signal completion-ready'));
    expect(NUDGE_REASON).toContain('not a new feature');
    expect(NUDGE_REASON).toContain('most tasks have none');
  });
});
