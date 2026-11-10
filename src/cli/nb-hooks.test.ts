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
  for (const k of ['NB_DIR', 'NB_RETRO_DISABLED', 'NB_RETRO_TTL_DAYS', 'KOOKR_REPO_SLUG']) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('nb-retro Stop/SubagentStop hook', () => {
  const hook = join(process.cwd(), 'plugin/hooks/nb-retro.mjs');

  /** Hook env: the ambient Kookr task env must not leak the slug / TTL / opt-out in. */
  function retroEnv(env: Record<string, string>): NodeJS.ProcessEnv {
    const base = { ...process.env };
    delete base.KOOKR_REPO_SLUG;
    delete base.NB_RETRO_TTL_DAYS;
    delete base.NB_RETRO_DISABLED;
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

  test.each(['soon', '0', '-3'])('an invalid NB_RETRO_TTL_DAYS (%s) falls back to 7 days', (bad) => {
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

  test('an existing sentinel (another agent already nudged) exits silently', () => {
    writeFileSync(join(dir, '.retro-sess-taken'), 'x');
    const r = runRetro({ NB_DIR: dir }, { session_id: 'sess-taken' });
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
  });

  test('fan-out: the first agent to stop (a subagent) gets the single nudge, with the placement rule', () => {
    // SubagentStop fires with the PARENT's session id. The first stop of the session
    // is usually a subagent that never saw the SessionStart index, so the nudge text
    // itself must carry the placement rule; every later stop is let through.
    const env = { NB_DIR: dir, KOOKR_REPO_SLUG: 'acme-widgets' };
    const first = runRetro(env, { hook_event_name: 'SubagentStop', session_id: 'sess-fan' });
    expect(first.code).toBe(2);
    expect(first.err).toContain('<situation>@<slug>');
    expect(first.err).toMatch(/Never write fleet-global directly/);
    expect(runRetro(env, { hook_event_name: 'SubagentStop', session_id: 'sess-fan' }).code).toBe(0); // 2nd subagent
    expect(runRetro(env, { hook_event_name: 'Stop', session_id: 'sess-fan' }).code).toBe(0); // the main agent
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
