// Tests for kookr's notebook Stop hook (plugin/hooks/nb-retro.mjs).
//
// The `nb` CLI itself is no longer vendored here — kookr dogfoods the public
// `agent-notebook` package, which carries its own CLI/core unit tests upstream.
// What stays kookr-owned is the ritual wiring: the Stop hook that nudges the
// end-of-task retrospective. The rerouted `bin/nb.js` shim is covered by
// nb-bin.test.ts.
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
  for (const k of ['NB_DIR', 'NB_ROLE', 'NB_RETRO_DISABLED']) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('nb-retro Stop hook', () => {
  const hook = join(process.cwd(), 'plugin/hooks/nb-retro.mjs');

  function runRetro(env: Record<string, string>, event: unknown): { code: number; err: string } {
    try {
      // Merge over the real env for PATH etc., but let the caller's env be
      // authoritative for NB_ROLE: a caller that omits it means "unset", which
      // must hold even when the ambient process has NB_ROLE set (e.g. inside a
      // kookr-launched session running under `orchestrator@<repo>`). Without
      // this, the second `...process.env` spread would silently re-introduce
      // the ambient NB_ROLE and the "no-op when unset" case could never be
      // exercised off-CI.
      const mergedEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
      if (!('NB_ROLE' in env)) delete mergedEnv.NB_ROLE;
      execFileSync('node', [hook], {
        input: JSON.stringify(event),
        env: mergedEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { code: 0, err: '' };
    } catch (e) {
      const err = e as { status?: number; stderr?: Buffer };
      return { code: err.status ?? -1, err: err.stderr?.toString() ?? '' };
    }
  }

  test('no-op (exit 0) when NB_ROLE is unset', () => {
    const env = { ...process.env } as Record<string, string>;
    delete env.NB_ROLE;
    env.NB_DIR = dir;
    expect(runRetro(env, { session_id: 's1' }).code).toBe(0);
  });

  test('blocks the first stop (exit 2) then allows the second (fires once per session)', () => {
    const env = { NB_ROLE: 'patcher', NB_DIR: dir };
    expect(runRetro(env, { session_id: 'sess-A' }).code).toBe(2);
    expect(runRetro(env, { session_id: 'sess-A' }).code).toBe(0);
    // a different session blocks again
    expect(runRetro(env, { session_id: 'sess-B' }).code).toBe(2);
  });

  test('the block names the full maintenance cycle (add/upvote/downvote/remove/merge)', () => {
    const r = runRetro({ NB_ROLE: 'patcher', NB_DIR: dir }, { session_id: 'sess-cycle' });
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/nb add/);
    expect(r.err).toMatch(/\+1/);
    expect(r.err).toMatch(/-1/);
    expect(r.err).toMatch(/nb rm/); // remove an incorrect lesson, first-class
    expect(r.err).toMatch(/nb merge/);
  });

  test('NB_RETRO_DISABLED opts out (always allows the stop)', () => {
    const env = { NB_ROLE: 'patcher', NB_DIR: dir, NB_RETRO_DISABLED: '1' };
    expect(runRetro(env, { session_id: 'sess-off' }).code).toBe(0);
  });

  test('prunes stale .retro-* sentinels older than 24h', () => {
    const stale = join(dir, '.retro-old');
    writeFileSync(stale, 'x');
    const old = Date.now() / 1000 - 48 * 3600; // 48h ago (seconds)
    utimesSync(stale, old, old);
    runRetro({ NB_ROLE: 'patcher', NB_DIR: dir }, { session_id: 'sess-C' }); // triggers prune
    expect(existsSync(stale)).toBe(false);
    // the current session's sentinel survives
    expect(readdirSync(dir).some((f) => f.startsWith('.retro-sess-C'))).toBe(true);
  });
});
