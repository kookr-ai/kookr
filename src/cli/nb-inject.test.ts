// Tests for kookr's notebook SessionStart injector (plugin/hooks/nb-inject.mjs).
//
// The injector is role-agnostic: it shells out to `nb list` and injects the
// INDEX (every shelf + description) into context for every session, or stays
// silent on an empty store / missing `nb`. It must never fail a session start.
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

const BIN = join(process.cwd(), 'bin/nb.js');
const HOOK = join(process.cwd(), 'plugin/hooks/nb-inject.mjs');

/** process.env minus the layering knobs, so these flat-index tests behave the same on a host (or CI) that sets them. */
function flatEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.KOOKR_REPO_SLUG;
  delete env.KOOKR_NB_LAYERS;
  return env;
}

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
      env: { ...flatEnv(), NB_DIR: dir, PATH: `${binDir}:${process.env.PATH ?? ''}` },
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
    // The two operational rules from agent-notebook's AGENTS.md contract (#3472):
    // vote by the printed <id> (not fuzzy text), and the one-line ≤200-char cap.
    expect(r.out).toContain('Vote by the `<id>`');
    expect(r.out).toContain('not a fuzzy text query'); // the vote-by-id rationale
    expect(r.out).toContain('one line, ≤200 characters'); // tight: not satisfied by e.g. ≤2000
    expect(r.out).toContain('rejected, not truncated');
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
    // An EMPTY directory as PATH: unlike node's own bin dir (which can hold a global
    // `nb`), nothing can resolve there. The guard below proves the premise, so this
    // test cannot pass vacuously on a host that has `nb` installed.
    const emptyDir = mkdtempSync(join(tmpdir(), 'kookr-nb-inject-empty-'));
    try {
      expect(() => execFileSync('nb', ['--version'], { env: { PATH: emptyDir }, stdio: 'ignore' })).toThrow();
      const out = execFileSync(process.execPath, [HOOK], {
        env: { ...flatEnv(), NB_DIR: dir, PATH: emptyDir },
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      expect(out).toBe(''); // silent: no index and no warning
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

describe('nb-inject — a failing `nb list` is reported, not mistaken for an empty store', () => {
  let stubDir: string;
  beforeEach(() => {
    stubDir = mkdtempSync(join(tmpdir(), 'kookr-nb-inject-stub-'));
  });
  afterEach(() => {
    rmSync(stubDir, { recursive: true, force: true });
  });

  /** Put a fake `nb` (a shell script) first on PATH and run the hook. */
  function injectWithStub(script: string): { code: number; out: string; err: string } {
    const nb = join(stubDir, 'nb');
    writeFileSync(nb, `#!/bin/sh\n${script}\n`);
    chmodSync(nb, 0o755);
    try {
      const out = execFileSync('node', [HOOK], {
        env: { ...flatEnv(), NB_DIR: dir, PATH: `${stubDir}:${dirname(process.execPath)}:/usr/bin:/bin` },
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, out, err: '' };
    } catch (e) {
      const err = e as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
      return { code: err.status ?? -1, out: err.stdout?.toString() ?? '', err: err.stderr?.toString() ?? '' };
    }
  }

  test('non-zero `nb list` -> a one-line warning on STDOUT (what the agent reads), exit 0', () => {
    const r = injectWithStub('echo "cannot read store: EACCES" >&2; exit 3');
    expect(r.code).toBe(0);
    expect(r.out).toContain('WARNING');
    expect(r.out).toContain('`nb list` exited with status 3');
    expect(r.out).toContain('cannot read store: EACCES');
    expect(r.out).toContain('not the same as an empty store');
    expect(r.out).not.toContain('Open the shelves that fit'); // no index instructions without an index
  });

  test('non-zero exit with empty stderr has no ": detail" suffix; only the first stderr line is used, capped at 200 chars', () => {
    const bare = injectWithStub('exit 4');
    expect(bare.out).toContain('exited with status 4. The notebook index');
    const multi = injectWithStub('printf "first line\\nsecond line\\n" >&2; exit 4');
    expect(multi.out).toContain('exited with status 4: first line.');
    expect(multi.out).not.toContain('second line');
    const long = injectWithStub(`printf '%s\\n' "$(printf 'x%.0s' $(seq 1 300))" >&2; exit 4`);
    expect(long.out).toContain(`: ${'x'.repeat(200)}.`);
    expect(long.out).not.toContain('x'.repeat(201));
  });

  test('a `nb` killed by a signal is reported by signal name', () => {
    const r = injectWithStub('kill -9 $$');
    expect(r.code).toBe(0);
    expect(r.out).toContain('was killed by SIGKILL');
  });

  test('a hung `nb list` -> warning that it timed out, exit 0', () => {
    // `exec sleep` replaces the shell, so no grandchild keeps the stdout pipe open
    // after the hook kills `nb` on timeout.
    const r = injectWithStub('exec sleep 30');
    expect(r.code).toBe(0);
    expect(r.out).toContain('WARNING');
    expect(r.out).toContain('timed out after 4s');
  }, 20_000);

  test('asks `nb list` for more than its default 50 rows so the 60-row cap is the effective one', () => {
    // The stub fails unless it receives exactly `list --limit 1000`.
    const r = injectWithStub(
      '[ "$1 $2 $3" = "list --limit 1000" ] || exit 9\necho "agent-notebook notebooks — 1 in /x"\necho "  shelf-a  1  a trigger"',
    );
    expect(r.out).toContain('shelf-a');
    expect(r.out).not.toContain('WARNING');
  });

  /** A stub that prints `n` indented rows of `pad` extra characters after a header. */
  function listStub(n: number, pad: number): string {
    return (
      `echo "agent-notebook notebooks — ${n} in /x"\n` +
      `i=1\nwhile [ $i -le ${n} ]; do printf '  shelf-%03d  1  %s\\n' $i "$(printf 'é%.0s' $(seq 1 ${pad}))"; i=$((i+1)); done`
    );
  }

  const rowsIn = (out: string): number => out.split('\n').filter((l) => /^ {2}shelf-\d+/.test(l)).length;

  test('caps the injected index at 60 rows and says how many were left out', () => {
    const r = injectWithStub(listStub(80, 5));
    expect(r.code).toBe(0);
    expect(rowsIn(r.out)).toBe(60);
    expect(r.out).toContain('shelf-060');
    expect(r.out).not.toContain('shelf-061');
    expect(r.out).toContain('20 more shelves not shown');
    expect(r.out).toContain('nb list');
  });

  test('uses the total in the header when `nb list` was itself truncated ("50 of 75")', () => {
    const r = injectWithStub(
      listStub(50, 5).replace('— 50 in', '— 50 of 75 in'),
    );
    expect(rowsIn(r.out)).toBe(50);
    expect(r.out).toContain('25 more shelves not shown');
  });

  test('singular: "1 more shelf" (not "1 more shelves")', () => {
    const r = injectWithStub(listStub(61, 5));
    expect(r.out).toContain('1 more shelf not shown');
    expect(r.out).not.toContain('1 more shelves');
  });

  test('a store under both caps is injected whole, with no "more" tail', () => {
    const r = injectWithStub(listStub(12, 5));
    expect(rowsIn(r.out)).toBe(12);
    expect(r.out).not.toContain('more shelves not shown');
  });

  test('caps the index at 8 KB (bytes, not characters) on whole rows', () => {
    // 40 rows of ~400 bytes each (200 two-byte chars): row cap not reached, byte cap is.
    const r = injectWithStub(listStub(40, 200));
    const index = r.out.slice(r.out.indexOf('agent-notebook notebooks'));
    expect(Buffer.byteLength(index)).toBeLessThanOrEqual(8 * 1024);
    const shown = rowsIn(r.out);
    // each row is 2+9+2+1+2+400 = ~416 bytes; budget 8192 - 96 (tail) - header
    expect(shown).toBeGreaterThanOrEqual(18);
    expect(shown).toBeLessThanOrEqual(19);
    expect(r.out).toContain(`${40 - shown} more shelves not shown`);
    // whole rows only: every shown row is complete (200 chars of padding)
    for (const row of r.out.split('\n').filter((l) => /^ {2}shelf-\d+/.test(l))) {
      expect(row.endsWith('é'.repeat(200))).toBe(true);
    }
  });
});

