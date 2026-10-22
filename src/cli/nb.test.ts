import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { runNbCli } from './nb.js';

let dir: string;
const SAVED = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kookr-nb-cli-'));
  process.env.NB_DIR = dir;
});
afterEach(() => {
  for (const k of ['NB_DIR', 'NB_MAX_LINES', 'NB_ROLE']) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

/** Run runNbCli with stdout/stderr captured. */
async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  // @ts-expect-error — test shim for capturing writes
  process.stdout.write = (s: string) => ((out += s), true);
  // @ts-expect-error — test shim for capturing writes
  process.stderr.write = (s: string) => ((err += s), true);
  try {
    const code = await runNbCli(argv);
    return { code, out, err };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

describe('runNbCli', () => {
  test('--help and no-args print usage and exit 0', async () => {
    expect((await run(['--help'])).code).toBe(0);
    const r = await run([]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('nb — the Agent Notebook');
  });

  test('add then show round-trips a lesson', async () => {
    expect((await run(['add', 'patcher', 'prefer execFileSync, array args'])).code).toBe(0);
    const show = await run(['show', 'patcher']);
    expect(show.code).toBe(0);
    expect(show.out).toContain('prefer execFileSync, array args');
    expect(show.out).toMatch(/1\. \[\+1\]/);
  });

  test('vote adjusts the score shown', async () => {
    await run(['add', 'patcher', 'run lint before done']);
    const v = await run(['vote', 'patcher', 'lint', '+1']);
    expect(v.code).toBe(0);
    expect(v.out).toContain('[+2]');
  });

  test('stats --since labels the window and returns 0', async () => {
    await run(['add', 'patcher', 'x']);
    const s = await run(['stats', 'patcher', '--since', '30m']);
    expect(s.code).toBe(0);
    expect(s.out).toContain('window 30m');
  });

  test('unknown command exits 2', async () => {
    const r = await run(['frobnicate', 'patcher']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('unknown command');
  });

  test('a missing required argument exits 1', async () => {
    const r = await run(['show']); // no role
    expect(r.code).toBe(1);
    expect(r.err).toContain('missing <role>');
  });

  test('a bad vote direction exits 1', async () => {
    await run(['add', 'patcher', 'x']);
    const r = await run(['vote', 'patcher', 'x', '2']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('+1 or -1');
  });
});

describe('nb-retro Stop hook', () => {
  const hook = join(process.cwd(), 'plugin/hooks/nb-retro.mjs');

  function runRetro(env: Record<string, string>, event: unknown): number {
    try {
      execFileSync('node', [hook], {
        input: JSON.stringify(event),
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return 0;
    } catch (e) {
      return (e as { status?: number }).status ?? -1;
    }
  }

  test('no-op (exit 0) when NB_ROLE is unset', () => {
    const env = { ...process.env } as Record<string, string>;
    delete env.NB_ROLE;
    env.NB_DIR = dir;
    expect(runRetro(env, { session_id: 's1' })).toBe(0);
  });

  test('blocks the first stop (exit 2) then allows the second (fires once per session)', () => {
    const env = { NB_ROLE: 'patcher', NB_DIR: dir };
    expect(runRetro(env, { session_id: 'sess-A' })).toBe(2);
    expect(runRetro(env, { session_id: 'sess-A' })).toBe(0);
    // a different session blocks again
    expect(runRetro(env, { session_id: 'sess-B' })).toBe(2);
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
