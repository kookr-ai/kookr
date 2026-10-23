/**
 * Integration test for bin/kb-spool-shim.js dual-checkout PATH resolution.
 *
 * Reproduces the fork-bomb precondition: two Kookr launcher bins on PATH
 * (e.g. kookr + kookr-prod) each shipping `kb` + `kb-spool-shim.js`. The
 * shim must skip peer launcher bins and land on a real `kb` further down
 * PATH — not recurse into the sibling checkout.
 *
 * Run: node --test bin/kb-spool-shim.test.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync, rmSync, copyFileSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const realShim = join(here, 'kb-spool-shim.js');
const realShellKb = join(here, 'kb');

function makeLauncherBin(root, name) {
  const checkout = join(root, name);
  const bin = join(checkout, 'bin');
  mkdirSync(bin, { recursive: true });
  // The shim is ESM (`import`); outside the real package tree Node needs a
  // nearby `"type": "module"` marker (same as kookr's package.json).
  writeFileSync(join(checkout, 'package.json'), JSON.stringify({ type: 'module' }));
  copyFileSync(realShim, join(bin, 'kb-spool-shim.js'));
  copyFileSync(realShellKb, join(bin, 'kb'));
  chmodSync(join(bin, 'kb'), 0o755);
  chmodSync(join(bin, 'kb-spool-shim.js'), 0o755);
  return bin;
}

function makeRealKb(root) {
  const bin = join(root, 'real', 'bin');
  mkdirSync(bin, { recursive: true });
  const kb = join(bin, 'kb');
  writeFileSync(
    kb,
    `#!/bin/sh\necho "REAL_KB_OK argv=$*"\nexit 0\n`,
  );
  chmodSync(kb, 0o755);
  return bin;
}

test('dual kookr launcher bins on PATH resolve to real kb (no recursion)', () => {
  const root = mkdtempSync(join(tmpdir(), 'kb-shim-dual-'));
  try {
    const a = makeLauncherBin(root, 'kookr-a');
    const b = makeLauncherBin(root, 'kookr-b');
    const real = makeRealKb(root);
    const path = [a, b, real, '/usr/bin', '/bin'].join(':');

    // Use process.execPath so a synthetic PATH without modern Node still
    // runs the shim under the same runtime as this test file.
    const result = spawnSync(process.execPath, [join(a, 'kb-spool-shim.js'), '--version'], {
      env: { ...process.env, PATH: path, KOOKR_KB_SHIM_DEPTH: '0' },
      encoding: 'utf8',
      timeout: 5000,
    });

    assert.equal(result.status, 0, `exit=${result.status} stderr=${result.stderr}`);
    assert.match(result.stdout, /REAL_KB_OK argv=--version/);
    assert.doesNotMatch(result.stderr ?? '', /recursion depth exceeded/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('remember does not hang when stdin never reaches EOF (agent-harness socket / char device)', () => {
  // Regression: the spool shim read stdin unconditionally for `remember`,
  // resolving only on EOF (with a lone isTTY escape hatch). Under the Kookr
  // agent harness stdin is an inherited socket that is held open and never
  // sends EOF, so the read parked in epoll_wait forever — stranding every
  // lesson write (and leaking a stuck node process per call). A never-EOF
  // char device (/dev/zero) reproduces the same non-pipe, no-EOF stdin shape.
  const root = mkdtempSync(join(tmpdir(), 'kb-shim-stdin-'));
  const zero = openSync('/dev/zero', 'r');
  try {
    const a = makeLauncherBin(root, 'kookr-a');
    const real = makeRealKb(root);
    const path = [a, real, '/usr/bin', '/bin'].join(':');

    const result = spawnSync(
      process.execPath,
      [
        join(a, 'kb-spool-shim.js'),
        'remember',
        '--kb=agent-task-lessons',
        'a lesson passed as an argv, not piped on stdin',
      ],
      {
        env: { ...process.env, PATH: path, KOOKR_KB_SHIM_DEPTH: '0' },
        stdio: [zero, 'pipe', 'pipe'],
        encoding: 'utf8',
        timeout: 8000,
      },
    );

    // The shim must terminate on its own, NOT be killed by the timeout. Its
    // exit code depends on wrap-module availability (irrelevant here); the
    // regression is purely that it does not block on the never-EOF stdin.
    assert.equal(
      result.signal,
      null,
      `shim hung on a never-EOF stdin (killed by timeout): signal=${result.signal} stderr=${result.stderr}`,
    );
  } finally {
    closeSync(zero);
    rmSync(root, { recursive: true, force: true });
  }
});

test('depth guard aborts if a peer shim is still selected', () => {
  const root = mkdtempSync(join(tmpdir(), 'kb-shim-depth-'));
  try {
    // Two launcher bins only — no real kb. Without the dir skip this would
    // recurse; with the skip, resolve fails closed at 127. Here we verify a
    // pure-shim PATH exits 127 (no real kb) without hanging.
    const a = makeLauncherBin(root, 'kookr-a');
    const b = makeLauncherBin(root, 'kookr-b');
    const path = [a, b].join(':');

    const result = spawnSync(process.execPath, [join(a, 'kb-spool-shim.js'), '--version'], {
      env: {
        ...process.env,
        PATH: path,
        HOME: join(root, 'no-home'),
        KOOKR_KB_SHIM_DEPTH: '0',
      },
      encoding: 'utf8',
      timeout: 5000,
    });

    assert.equal(result.status, 127);
    assert.match(result.stderr ?? '', /real `kb` binary not found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
