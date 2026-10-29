// Tests for kookr's notebook SessionStart injector (plugin/hooks/nb-inject.mjs).
//
// The injector is role-agnostic: it shells out to `nb list` and injects the
// INDEX (every shelf + description) into context for every session, or stays
// silent on an empty store / missing `nb`. It must never fail a session start.
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

const BIN = join(process.cwd(), 'bin/nb.js');
const HOOK = join(process.cwd(), 'plugin/hooks/nb-inject.mjs');

let dir: string; // NB_DIR
let binDir: string; // holds an `nb` symlink → bin/nb.js, prepended to PATH

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kookr-nb-inject-'));
  binDir = mkdtempSync(join(tmpdir(), 'kookr-nb-inject-bin-'));
  symlinkSync(BIN, join(binDir, 'nb')); // so the hook's `nb` resolves to this shim
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

/** Seed a shelf through the shim (honours NB_DIR). */
function seed(args: string[]): void {
  execFileSync('node', [BIN, ...args], { env: { ...process.env, NB_DIR: dir }, stdio: 'ignore' });
}

/** Run the injector hook; capture stdout + exit code. */
function inject(): { code: number; out: string } {
  try {
    const out = execFileSync('node', [HOOK], {
      env: { ...process.env, NB_DIR: dir, PATH: `${binDir}:${process.env.PATH ?? ''}` },
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer | string };
    return { code: err.status ?? -1, out: err.stdout?.toString() ?? '' };
  }
}

describe('nb-inject SessionStart hook', () => {
  test('injects the index header + the shelf names when the store is non-empty', () => {
    seed(['add', 'code-review', 'check off-by-one']);
    seed(['describe', 'code-review', 'review a diff']);
    seed(['add', 'patch-author', 'write the minimal fix']);
    const r = inject();
    expect(r.code).toBe(0);
    expect(r.out).toContain('## Your agent-notebook index');
    expect(r.out).toContain('nb show <shelf>'); // the instruction
    expect(r.out).toContain('code-review'); // the index itself, from `nb list`
    expect(r.out).toContain('patch-author');
    expect(r.out).toContain('review a diff'); // the description surfaces
  });

  test('injects nothing (silent, exit 0) on an empty store', () => {
    const r = inject();
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe('');
  });

  test('fails open (exit 0, no output) when `nb` is not on PATH', () => {
    // PATH has node's own dir (so the hook can launch) but NOT the `nb` symlink,
    // so the hook's `nb list` fails and it must inject nothing rather than error.
    let out = '';
    let code = 0;
    try {
      out = execFileSync('node', [HOOK], {
        env: { ...process.env, NB_DIR: dir, PATH: dirname(process.execPath) },
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (e) {
      const err = e as { status?: number; stdout?: Buffer | string };
      code = err.status ?? -1;
      out = err.stdout?.toString() ?? '';
    }
    expect(code).toBe(0);
    expect(out.trim()).toBe('');
  });
});
