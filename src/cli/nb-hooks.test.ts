// Tests for kookr's notebook retrospective hook (plugin/hooks/nb-retro.mjs).
//
// The `nb` CLI itself is no longer vendored here — kookr dogfoods the public
// `agent-notebook` package, which carries its own CLI/core unit tests upstream.
// What stays kookr-owned is the ritual wiring: the Stop / SubagentStop hook that
// nudges the end-of-task retrospective. The rerouted `bin/nb.js` shim is covered
// by nb-bin.test.ts.
//
// The hook is now role-agnostic: it fires for EVERY session (there is no NB_ROLE
// gate), blocking the first stop once per session via a per-session sentinel.
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync, utimesSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

let dir: string;
const SAVED = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kookr-nb-hooks-'));
  process.env.NB_DIR = dir;
});
afterEach(() => {
  for (const k of ['NB_DIR', 'NB_RETRO_DISABLED', 'NB_RETRO_TTL_DAYS', 'KOOKR_REPO_SLUG', 'KOOKR_TASK_ID']) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('nb-retro Stop hook (SubagentStop is let through)', () => {
  const hook = join(process.cwd(), 'plugin/hooks/nb-retro.mjs');

  /** Hook env: the ambient Kookr task env must not leak the slug / TTL / opt-out in. */
  function retroEnv(env: Record<string, string>): NodeJS.ProcessEnv {
    const base = { ...process.env };
    delete base.KOOKR_REPO_SLUG;
    delete base.NB_RETRO_TTL_DAYS;
    delete base.NB_RETRO_DISABLED;
    delete base.KOOKR_TASK_ID;
    return { ...base, ...env };
  }

  /** Spawn the hook without blocking, so several can race on one session id. */
  function runRetroAsync(
    env: Record<string, string>,
    event: unknown,
    nodeArgs: string[] = [],
  ): Promise<{ code: number; err: string }> {
    return new Promise((resolve) => {
      const child = spawn('node', [...nodeArgs, hook], { env: retroEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
      let err = '';
      child.stderr.on('data', (d) => (err += d.toString()));
      child.on('close', (code) => resolve({ code: code ?? -1, err }));
      child.stdin.end(JSON.stringify(event));
    });
  }

  function runRetro(env: Record<string, string>, event: unknown): { code: number; err: string } {
    try {
      execFileSync('node', [hook], {
        input: JSON.stringify(event),
        env: retroEnv(env),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { code: 0, err: '' };
    } catch (e) {
      const err = e as { status?: number; stderr?: Buffer };
      return { code: err.status ?? -1, err: err.stderr?.toString() ?? '' };
    }
  }

  test('fires for every session regardless of role (no NB_ROLE gate)', () => {
    // The old behaviour no-op'd unless NB_ROLE was set; the role-agnostic hook
    // now blocks the first stop of any session so the retrospective is offered.
    expect(runRetro({ NB_DIR: dir }, { session_id: 's1' }).code).toBe(2);
  });

  test('blocks the first stop (exit 2) then allows the second (fires once per session)', () => {
    const env = { NB_DIR: dir };
    expect(runRetro(env, { session_id: 'sess-A' }).code).toBe(2);
    expect(runRetro(env, { session_id: 'sess-A' }).code).toBe(0);
    // a different session blocks again
    expect(runRetro(env, { session_id: 'sess-B' }).code).toBe(2);
  });

  test('stop_hook_active short-circuits to allow (never block twice in a row)', () => {
    // Claude Code sets stop_hook_active while re-running after a block; the hook
    // must let that stop through even on a fresh session id.
    expect(runRetro({ NB_DIR: dir }, { session_id: 'sess-active', stop_hook_active: true }).code).toBe(0);
  });

  test('the block names the full maintenance cycle (add/upvote/downvote/remove/merge/split)', () => {
    const r = runRetro({ NB_DIR: dir }, { session_id: 'sess-cycle' });
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/nb add/);
    expect(r.err).toMatch(/\+1/);
    expect(r.err).toMatch(/-1/);
    expect(r.err).toMatch(/nb rm/); // remove an incorrect lesson, first-class
    expect(r.err).toMatch(/--reason/); // reasons feed the usage log / surfacing metrics
    expect(r.err).toMatch(/nb merge/);
    expect(r.err).toMatch(/split/);
    expect(r.err).toMatch(/shelf/); // kookr vocabulary
    // A session that opened no shelf must still be allowed to seed a first lesson;
    // otherwise an empty store (or a repo with no shelf yet) never gets one.
    expect(r.err).not.toMatch(/skip it entirely/);
    // A lesson must outlive the commit it was learned at (benchmark runs wrote lessons about code the
    // session had just added, which later tasks starting from older commits do not have).
    expect(r.err).toMatch(/stays true at another commit and on another task/);
    expect(r.err).toMatch(/Never what you just changed or how this task was fixed/);
    expect(r.err).toMatch(/if you opened none, skip them, but step 5 still applies/);
    // ...and that first lesson goes on a fitting existing shelf, not an invented synonym
    // shelf (issue #4203): a new shelf only when no shelf in the session index fits.
    expect(r.err).toMatch(/shelf from the session index \(`nb list` shows it\) if one fits/);
    expect(r.err).toMatch(/create a new shelf \(it is created on its first add\) only if none does/);
  });

  test('NB_RETRO_DISABLED opts out (always allows the stop)', () => {
    const env = { NB_DIR: dir, NB_RETRO_DISABLED: '1' };
    expect(runRetro(env, { session_id: 'sess-off' }).code).toBe(0);
  });

  function ageSentinel(name: string, hours: number): string {
    const p = join(dir, name);
    writeFileSync(p, 'x');
    const t = Date.now() / 1000 - hours * 3600; // seconds
    utimesSync(p, t, t);
    return p;
  }

  test('the default TTL is 7 days: a 6-day-old sentinel survives, an 8-day-old one does not', () => {
    const six = ageSentinel('.retro-six-days', 6 * 24);
    const eight = ageSentinel('.retro-eight-days', 8 * 24);
    runRetro({ NB_DIR: dir }, { session_id: 'sess-ttl' });
    expect(existsSync(six)).toBe(true);
    expect(existsSync(eight)).toBe(false);
  });

  test('keeps a sentinel 48h old (a session can run longer than a day) but prunes one older than 7 days', () => {
    const twoDays = ageSentinel('.retro-two-days', 48);
    const eightDays = ageSentinel('.retro-eight-days', 8 * 24);
    runRetro({ NB_DIR: dir }, { session_id: 'sess-C' }); // triggers the prune
    expect(existsSync(twoDays)).toBe(true);
    expect(existsSync(eightDays)).toBe(false);
    // the current session's sentinel survives
    expect(readdirSync(dir).some((f) => f.startsWith('.retro-sess-C'))).toBe(true);
  });

  test('NB_RETRO_TTL_DAYS shortens the prune window', () => {
    const twoDays = ageSentinel('.retro-two-days', 48);
    runRetro({ NB_DIR: dir, NB_RETRO_TTL_DAYS: '1' }, { session_id: 'sess-D' });
    expect(existsSync(twoDays)).toBe(false);
  });

  test('NB_RETRO_TTL_DAYS=Infinity never prunes', () => {
    const old = ageSentinel('.retro-a-year', 365 * 24);
    const r = runRetro({ NB_DIR: dir, NB_RETRO_TTL_DAYS: 'Infinity' }, { session_id: 'sess-inf' });
    expect(r.code).toBe(2); // the nudge itself is unchanged
    expect(existsSync(old)).toBe(true);
  });

  test.each(['soon', '0', '-3', '-Infinity'])('an invalid NB_RETRO_TTL_DAYS (%s) falls back to 7 days', (bad) => {
    const twoDays = ageSentinel('.retro-two-days', 48);
    const eight = ageSentinel('.retro-eight-days', 8 * 24);
    runRetro({ NB_DIR: dir, NB_RETRO_TTL_DAYS: bad }, { session_id: 'sess-E' });
    expect(existsSync(twoDays)).toBe(true);
    expect(existsSync(eight)).toBe(false);
  });

  test('the nudge teaches batch votes, reason codes, ~150 chars and the placement rule', () => {
    const r = runRetro({ NB_DIR: dir }, { session_id: 'sess-text' });
    expect(r.code).toBe(2);
    expect(r.err).toContain('nb vote <shelf> <id1,id2,…> +1'); // batch vote by id
    expect(r.err).toContain('nb vote <shelf> <id1,id2,…> -1');
    expect(r.err).toContain('--reason wrong|obsolete'); // codes nb knows, not free text
    expect(r.err).not.toContain('--reason "<why>"');
    expect(r.err).toContain('~150'); // the length target
    expect(r.err).not.toMatch(/<=\s*200|≤\s*200/); // no restated cap
    // placement rule
    expect(r.err).toContain('<situation>@<slug>');
    expect(r.err).toContain('$KOOKR_REPO_SLUG');
    expect(r.err).toMatch(/true in another repo/);
    expect(r.err).toMatch(/unscoped <situation> shelf/);
    expect(r.err).toMatch(/Never write fleet-global directly/);
  });

  test('the nudge names the concrete slug when KOOKR_REPO_SLUG is set', () => {
    const r = runRetro({ NB_DIR: dir, KOOKR_REPO_SLUG: 'acme-widgets' }, { session_id: 'sess-slug' });
    expect(r.err).toContain('(here: acme-widgets)');
    const bare = runRetro({ NB_DIR: dir }, { session_id: 'sess-noslug' });
    expect(bare.err).not.toContain('(here:');
  });

  test('in a Kookr task the nudge ends by telling the task to re-signal completion-ready last (#4141)', () => {
    const r = runRetro({ NB_DIR: dir, KOOKR_TASK_ID: 'task-123' }, { session_id: 'sess-task' });
    expect(r.code).toBe(2);
    const lines = r.err.trimEnd().split('\n');
    const last = lines[lines.length - 1];
    expect(last).toContain('kookr signal completion-ready');
    expect(last).toMatch(/already run/);
    expect(last).toMatch(/LAST call/);
    // The rest of the retrospective text is the same as outside a task.
    const bare = runRetro({ NB_DIR: dir }, { session_id: 'sess-notask' });
    expect(lines.slice(0, -1).join('\n')).toBe(bare.err.trimEnd());
  });

  test('outside a Kookr task (KOOKR_TASK_ID unset or blank) the nudge does not mention the completion signal', () => {
    for (const [sid, env] of [
      ['sess-unset', { NB_DIR: dir }],
      ['sess-blank', { NB_DIR: dir, KOOKR_TASK_ID: '  ' }],
    ] as const) {
      const r = runRetro(env, { session_id: sid });
      expect(r.code).toBe(2);
      expect(r.err).not.toContain('completion-ready');
      expect(r.err.trimEnd().endsWith("this reminder won't repeat this session.")).toBe(true);
    }
  });

  test('claims the sentinel atomically: N hooks racing on one session id yield exactly one nudge', async () => {
    // A check-then-write (existsSync + writeFile) lets several racers pass the check
    // and all nudge; only an exclusive create (`wx`) leaves exactly one winner. The
    // race window is microseconds, so a preload widens it: it delays every
    // fs.writeFileSync by 150ms, which makes all racers pass any "does it exist?"
    // check before the first write lands. With `wx` the open still fails for all but one.
    const preloadDir = mkdtempSync(join(tmpdir(), 'kookr-nb-preload-'));
    const preload = join(preloadDir, 'slow-write.cjs');
    writeFileSync(
      preload,
      `const fs = require('node:fs');
       const real = fs.writeFileSync;
       fs.writeFileSync = function (...a) {
         Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
         return real.apply(this, a);
       };`,
    );
    try {
      const results = await Promise.all(
        Array.from({ length: 12 }, () =>
          runRetroAsync({ NB_DIR: dir }, { session_id: 'sess-race' }, ['-r', preload]),
        ),
      );
      expect(results.filter((r) => r.code === 2)).toHaveLength(1);
      expect(results.filter((r) => r.code === 0)).toHaveLength(11);
      expect(readdirSync(dir).filter((f) => f === '.retro-sess-race')).toHaveLength(1);
    } finally {
      rmSync(preloadDir, { recursive: true, force: true });
    }
  });

  test('NB_DIR with a leading ~ puts the sentinel under the home directory, not under a literal ~ directory', () => {
    // Issue #3673 item 4: NB_DIR set where no shell expands it reaches the hook as `~/…`.
    const cwd = mkdtempSync(join(tmpdir(), 'kookr-nb-hooks-cwd-'));
    try {
      let code = 0;
      try {
        execFileSync('node', [hook], {
          cwd,
          input: JSON.stringify({ session_id: 'tilde' }),
          env: retroEnv({ HOME: dir, NB_DIR: '~/store' }),
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (e) {
        code = (e as { status?: number }).status ?? -1;
      }
      expect(code).toBe(2); // the first stop is nudged
      expect(existsSync(join(dir, 'store', '.retro-tilde'))).toBe(true);
      expect(existsSync(join(cwd, '~'))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('NB_DIR=~ (bare) puts the sentinel in the home directory itself', () => {
    // Issue #3838: only `~/…` was covered; a bare `~` is expanded to the home directory too.
    const cwd = mkdtempSync(join(tmpdir(), 'kookr-nb-hooks-cwd-'));
    try {
      let code = 0;
      try {
        execFileSync('node', [hook], {
          cwd,
          input: JSON.stringify({ session_id: 'bare-tilde' }),
          env: retroEnv({ HOME: dir, NB_DIR: '~' }),
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (e) {
        code = (e as { status?: number }).status ?? -1;
      }
      expect(code).toBe(2); // the first stop is nudged
      expect(existsSync(join(dir, '.retro-bare-tilde'))).toBe(true);
      expect(existsSync(join(cwd, '~'))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('an existing sentinel (another agent already nudged) exits silently', () => {
    writeFileSync(join(dir, '.retro-sess-taken'), 'x');
    const r = runRetro({ NB_DIR: dir }, { session_id: 'sess-taken' });
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
  });

  // Recorded Claude Code 2.1.x payload entries (issue #4231).
  const runningSubagent = { id: 'a968876863f7fbf18', type: 'subagent', status: 'running', agent_type: 'general-purpose' };
  const runningShell = { id: 'b4oxl3awv', type: 'shell', status: 'running', command: 'npm ci' };

  test('a lead Stop while a background subagent is running is let through and does not spend the nudge (#4231)', () => {
    const env = { NB_DIR: dir };
    const waiting = runRetro(env, { hook_event_name: 'Stop', session_id: 'sess-wait', background_tasks: [runningSubagent] });
    expect(waiting).toEqual({ code: 0, err: '' });
    expect(existsSync(join(dir, '.retro-sess-wait'))).toBe(false);
    // The delegated work has come back: the next stop gets the nudge, once.
    const done = { ...runningSubagent, status: 'completed' };
    expect(runRetro(env, { hook_event_name: 'Stop', session_id: 'sess-wait', background_tasks: [done] }).code).toBe(2);
    expect(runRetro(env, { hook_event_name: 'Stop', session_id: 'sess-wait', background_tasks: [] }).code).toBe(0);
  });

  test('only a running SUBAGENT defers the nudge: a running shell, or no/odd background_tasks, still nudges', () => {
    const env = { NB_DIR: dir };
    expect(runRetro(env, { session_id: 'sess-shell', background_tasks: [runningShell] }).code).toBe(2);
    expect(runRetro(env, { session_id: 'sess-monitor', background_tasks: [{ id: 'm1', type: 'monitor', status: 'running' }] }).code).toBe(2);
    expect(runRetro(env, { session_id: 'sess-empty', background_tasks: [] }).code).toBe(2);
    expect(runRetro(env, { session_id: 'sess-odd', background_tasks: 'running' }).code).toBe(2);
    expect(runRetro(env, { session_id: 'sess-null-entry', background_tasks: [null] }).code).toBe(2);
  });

  test('fan-out: SubagentStop never takes the nudge, so the lead gets it at its first stop with nothing running (#4231)', () => {
    // SubagentStop fires with the PARENT's session id. A subagent that took the one
    // nudge left the lead without one, and its answer displaced its report.
    const env = { NB_DIR: dir, KOOKR_REPO_SLUG: 'acme-widgets' };
    const sid = 'sess-fan';
    // 1. the lead stops to wait for its subagents
    expect(runRetro(env, { hook_event_name: 'Stop', session_id: sid, background_tasks: [runningSubagent] }).code).toBe(0);
    // 2. the subagent finishes (its own entry is still `running` at SubagentStop)
    const sub = runRetro(env, {
      hook_event_name: 'SubagentStop',
      session_id: sid,
      agent_id: runningSubagent.id,
      agent_type: 'general-purpose',
      background_tasks: [runningSubagent],
    });
    expect(sub).toEqual({ code: 0, err: '' });
    // a SubagentStop with nothing else running does not claim it either
    expect(runRetro(env, { hook_event_name: 'SubagentStop', session_id: sid }).code).toBe(0);
    expect(existsSync(join(dir, `.retro-${sid}`))).toBe(false);
    // 3. the lead's next stop, with nothing running, gets the single nudge with the placement rule
    const lead = runRetro(env, { hook_event_name: 'Stop', session_id: sid, background_tasks: [] });
    expect(lead.code).toBe(2);
    expect(lead.err).toContain('<situation>@<slug>');
    expect(lead.err).toMatch(/Never write fleet-global directly/);
    // 4. and never again
    expect(runRetro(env, { hook_event_name: 'Stop', session_id: sid }).code).toBe(0);
  });

  test('a SubagentStop is let through even on a fresh session with no sentinel', () => {
    expect(runRetro({ NB_DIR: dir }, { hook_event_name: 'SubagentStop', session_id: 'sess-sub-only' })).toEqual({ code: 0, err: '' });
    expect(readdirSync(dir).filter((f) => f.startsWith('.retro-'))).toEqual([]);
  });

  test('the nudge asks a subagent to end with its full report, before the #4141 re-signal line (#4231)', () => {
    const r = runRetro({ NB_DIR: dir, KOOKR_TASK_ID: 'task-9' }, { session_id: 'sess-report' });
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/If you are a subagent, end by repeating your full final report after the retrospective/);
    expect(r.err).toMatch(/your last message is all your caller receives/);
    const lines = r.err.trimEnd().split('\n');
    expect(lines[lines.length - 1]).toContain('kookr signal completion-ready');
  });

  test.skipIf(process.getuid?.() === 0)('fails open (allows the stop, no nudge) when the sentinel cannot be written', () => {
    // skipped as root: root ignores directory permissions
    chmodSync(dir, 0o500);
    try {
      expect(runRetro({ NB_DIR: dir }, { session_id: 'sess-ro' }).code).toBe(0);
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});
