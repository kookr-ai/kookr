// Tests the bundled Stop-hook nudge at bin/kookr-stop-nudge.js (RFC:
// rfc-agent-signal-surface §7). Lives under src/server/ so it picks up the
// regular test glob. The script is hard fail-open — every path must exit 0;
// only the fully-qualified path emits a `decision:block` line.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, existsSync, readFileSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — JS module without bundled types.
import { resolveBaseUrl, markerPath, waitStampPath, isTerminalStatus, parseMinAge, waitingOnSubagent, runningSubagentIds, SUBAGENT_WAIT_BOUND_MS, NUDGE_REASON, LESSON_DECISION_TEMPLATE as NUDGE_LESSON_TEMPLATE } from '../../bin/kookr-stop-nudge.js';
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
  it('the subagent wait bound is the same in this script and in plugin/hooks/nb-retro.mjs (issue #4261)', () => {
    // The plugin ships without bin/, so the constant is duplicated by hand.
    const retro = readFileSync(resolve(NUDGE, '..', '..', 'plugin', 'hooks', 'nb-retro.mjs'), 'utf-8');
    const m = /const SUBAGENT_WAIT_BOUND_MS = ([^;]+);/.exec(retro);
    expect(m).not.toBeNull();
    expect(Function(`return (${m![1]});`)()).toBe(SUBAGENT_WAIT_BOUND_MS);
    expect(SUBAGENT_WAIT_BOUND_MS).toBe(30 * 60_000);
  });
  it('runningSubagentIds lists running subagents only, with a placeholder for a missing id', () => {
    expect(runningSubagentIds([
      { id: 'a', type: 'subagent', status: 'running' },
      { id: 'b', type: 'subagent', status: 'completed' },
      { id: 'c', type: 'shell', status: 'running' },
      { type: 'subagent', status: 'running' },
    ])).toEqual(['a', '(no id)']);
    for (const odd of [undefined, null, 'running', {}, [null]]) expect(runningSubagentIds(odd)).toEqual([]);
  });
  it('waitStampPath never names a task marker', () => {
    expect(waitStampPath('t-1')).toBe(`${markerPath('t-1')}.waiting`);
    expect(waitStampPath('a.waiting')).not.toBe(markerPath('a.waiting'));
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

  describe('the subagent deferral is bounded (issue #4261)', () => {
    const subagent = { id: 'a968876863f7fbf18', type: 'subagent', status: 'running', agent_type: 'general-purpose' };
    const waitingStdin = JSON.stringify({ stop_hook_active: false, background_tasks: [subagent] });
    const marker = () => join(home, '.kookr', 'stop-nudge', 't-1');
    const stamp = () => join(home, '.kookr', 'stop-nudge', 't-1.waiting');
    const backdate = (p: string, ms: number) => {
      const t = new Date(Date.now() - ms);
      utimesSync(p, t, t);
    };

    it('keeps deferring on repeated stops inside the bound', async () => {
      for (let i = 0; i < 3; i++) {
        const res = await run({ stdin: waitingStdin, env: baseEnv() });
        expect(res.status).toBe(0);
        expect(blocked(res.stdout)).toBe(false);
      }
      expect(existsSync(stamp())).toBe(true);
      expect(existsSync(marker())).toBe(false);
      backdate(stamp(), SUBAGENT_WAIT_BOUND_MS - 60_000);
      expect(blocked((await run({ stdin: waitingStdin, env: baseEnv() })).stdout)).toBe(false);
    });

    it('a subagent stuck `running` past the bound no longer withholds the reminder: it fires once', async () => {
      expect(blocked((await run({ stdin: waitingStdin, env: baseEnv() })).stdout)).toBe(false);
      backdate(stamp(), SUBAGENT_WAIT_BOUND_MS + 60_000);
      const late = await run({ stdin: waitingStdin, env: baseEnv() });
      expect(late.status).toBe(0);
      expect(blocked(late.stdout)).toBe(true);
      expect(existsSync(marker())).toBe(true);
      expect(existsSync(stamp())).toBe(false);
      // once per task still holds
      expect(blocked((await run({ stdin: waitingStdin, env: baseEnv() })).stdout)).toBe(false);
      expect(existsSync(stamp())).toBe(false);
    });

    it('the bound lifts only the deferral: the later gates still apply', async () => {
      expect(blocked((await run({ stdin: waitingStdin, env: baseEnv() })).stdout)).toBe(false);
      backdate(stamp(), SUBAGENT_WAIT_BOUND_MS + 60_000);
      task = { ...task, status: 'completed' };
      expect(blocked((await run({ stdin: waitingStdin, env: baseEnv() })).stdout)).toBe(false);
      expect(existsSync(marker())).toBe(false);
    });

    it('a stop with no running subagent clears the stamp, so a later genuine wait starts its own clock', async () => {
      mkdirSync(join(home, '.kookr', 'stop-nudge'), { recursive: true });
      writeFileSync(stamp(), 'old');
      backdate(stamp(), SUBAGENT_WAIT_BOUND_MS + 60_000);
      // idle stop, silenced by the activity gate: no marker, but the old stamp goes
      const idle = await run({
        stdin: JSON.stringify({ stop_hook_active: false, background_tasks: [] }),
        env: baseEnv({ KOOKR_NUDGE_MIN_TASK_AGE_MS: String(10 * 365 * 86_400_000) }),
      });
      expect(blocked(idle.stdout)).toBe(false);
      expect(existsSync(stamp())).toBe(false);
      expect(blocked((await run({ stdin: waitingStdin, env: baseEnv() })).stdout)).toBe(false);
      expect(existsSync(stamp())).toBe(true);
    });

    it('a subagent started after an earlier one finished gets its own clock (the old wait does not carry over)', async () => {
      const a = { ...subagent, id: 'A' };
      const b = { ...subagent, id: 'B' };
      expect(blocked((await run({ stdin: JSON.stringify({ background_tasks: [a] }), env: baseEnv() })).stdout)).toBe(false);
      backdate(stamp(), SUBAGENT_WAIT_BOUND_MS + 10 * 60_000);
      // A came back and the lead started B in the same turn: no idle stop in between.
      const chained = await run({ stdin: JSON.stringify({ background_tasks: [{ ...a, status: 'completed' }, b] }), env: baseEnv() });
      expect(blocked(chained.stdout)).toBe(false);
      expect(JSON.parse(readFileSync(stamp(), 'utf-8'))).toEqual(['B']);
      expect(existsSync(marker())).toBe(false);
      // B itself stuck past the bound: the reminder fires
      backdate(stamp(), SUBAGENT_WAIT_BOUND_MS + 60_000);
      expect(blocked((await run({ stdin: JSON.stringify({ background_tasks: [b] }), env: baseEnv() })).stdout)).toBe(true);
    });

    it('a stamp left by an earlier run (other ids, or the old format) does not cut a new wait short', async () => {
      mkdirSync(join(home, '.kookr', 'stop-nudge'), { recursive: true });
      for (const old of ['["gone"]', '2026-11-27T00:00:00.000Z']) {
        writeFileSync(stamp(), old);
        backdate(stamp(), SUBAGENT_WAIT_BOUND_MS + 60_000);
        expect(blocked((await run({ stdin: waitingStdin, env: baseEnv() })).stdout)).toBe(false);
        expect(JSON.parse(readFileSync(stamp(), 'utf-8'))).toEqual([subagent.id]);
      }
    });

    it('a running subagent with no id is still bounded', async () => {
      const noId = JSON.stringify({ background_tasks: [{ type: 'subagent', status: 'running' }] });
      expect(blocked((await run({ stdin: noId, env: baseEnv() })).stdout)).toBe(false);
      backdate(stamp(), SUBAGENT_WAIT_BOUND_MS + 60_000);
      expect(blocked((await run({ stdin: noId, env: baseEnv() })).stdout)).toBe(true);
    });

    it('writes no stamp outside a managed task or once the task was already reminded', async () => {
      expect(blocked((await run({ stdin: waitingStdin, env: baseEnv({ KOOKR_TASK_ID: '' }) })).stdout)).toBe(false);
      expect(existsSync(join(home, '.kookr', 'stop-nudge'))).toBe(false);
      mkdirSync(join(home, '.kookr', 'stop-nudge'), { recursive: true });
      writeFileSync(marker(), 'done');
      expect(blocked((await run({ stdin: waitingStdin, env: baseEnv() })).stdout)).toBe(false);
      expect(existsSync(stamp())).toBe(false);
    });
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
