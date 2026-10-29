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
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

let dir: string;
const SAVED = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kookr-nb-hooks-'));
  process.env.NB_DIR = dir;
});
afterEach(() => {
  for (const k of ['NB_DIR', 'NB_RETRO_DISABLED']) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('nb-retro Stop/SubagentStop hook', () => {
  const hook = join(process.cwd(), 'plugin/hooks/nb-retro.mjs');

  function runRetro(env: Record<string, string>, event: unknown): { code: number; err: string } {
    try {
      execFileSync('node', [hook], {
        input: JSON.stringify(event),
        env: { ...process.env, ...env },
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

  test('prunes stale .retro-* sentinels older than 24h', () => {
    const stale = join(dir, '.retro-old');
    writeFileSync(stale, 'x');
    const old = Date.now() / 1000 - 48 * 3600; // 48h ago (seconds)
    utimesSync(stale, old, old);
    runRetro({ NB_DIR: dir }, { session_id: 'sess-C' }); // triggers prune
    expect(existsSync(stale)).toBe(false);
    // the current session's sentinel survives
    expect(readdirSync(dir).some((f) => f.startsWith('.retro-sess-C'))).toBe(true);
  });
});
