#!/usr/bin/env node
/**
 * PATH-level `kb` wrapper for Kookr-spawned agents (issue #1519).
 *
 * For non-remember commands (and non-lesson remember), this is a transparent
 * exec of the real `kb` binary found later on PATH. For lesson writes
 * (`kb remember --lesson` or `--kb=agent-task-lessons`), a runtime failure
 * appends the lesson to the durable local spool instead of dropping it.
 *
 * Healthy-path cost: one extra process hop. No spool I/O on success.
 *
 * The agent-launch context prepends Kookr's `bin/` to PATH. This file is
 * invoked via the POSIX `bin/kb` shim in that directory.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, delimiter, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  const argv = process.argv.slice(2);
  const realKb = resolveRealKb(process.env);
  if (!realKb) {
    process.stderr.write(
      '[kookr] kb spool shim: real `kb` binary not found on PATH (after removing Kookr bin).\n',
    );
    process.exit(127);
  }

  // Replay already owns the pending entry. Wrapping it again could convert a
  // failed real write into a successful duplicate spool append, after which
  // the drain would delete the only pending copy.
  const skipSpool = process.env.KOOKR_KB_SKIP_SPOOL === '1';

  // Fast path: anything that is not `kb remember …`, plus replay calls that
  // explicitly own their retry state — pure exec, no spool-module load.
  if (argv[0] !== 'remember' || skipSpool) {
    process.exitCode = await execReal(realKb, argv, process.env);
    return;
  }

  // Lesson-targeting remember: wrap with spool-on-failure. Non-lesson remember
  // still goes through wrap (which pass-throughs without spooling).
  const stdinBody = await readStdin();
  const wrap = await loadWrapModule();
  const result = await wrap.wrapLessonRemember({
    argv,
    stdinBody,
    realKbBin: realKb,
    env: process.env,
    taskId: process.env.KOOKR_TASK_ID,
  });
  process.exit(result.exitCode);
}

function resolveRealKb(env) {
  const pathEnv = env.PATH ?? '';
  const parts = pathEnv.split(delimiter).filter(Boolean);
  // Skip our own bin dir so we don't recurse into this shim.
  // Also skip EVERY Kookr launcher bin (any directory that contains
  // kb-spool-shim.js). When both `kookr` and `kookr-prod` (or any two
  // checkouts) appear on PATH, each shim used to resolve the other as the
  // "real" kb and spawn an unbounded process chain (fork bomb).
  const selfDir = realpathSafe(here);
  for (const dir of parts) {
    const resolvedDir = realpathSafe(dir);
    if (resolvedDir === selfDir) continue;
    if (isKookrLauncherBinDir(resolvedDir)) continue;
    for (const name of ['kb', 'kb.js']) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  // Last resort: common npm-global locations without relying on PATH order.
  const home = env.HOME ?? homedir();
  const fallbacks = [
    join(home, '.local', 'bin', 'kb'),
    '/usr/local/bin/kb',
  ];
  for (const candidate of fallbacks) {
    if (!existsSync(candidate)) continue;
    const candidateDir = realpathSafe(dirname(candidate));
    if (candidateDir === selfDir) continue;
    if (isKookrLauncherBinDir(candidateDir)) continue;
    return candidate;
  }
  return null;
}

/**
 * True when `dir` is a Kookr agent-launcher bin (ships `kb-spool-shim.js`).
 * Used to skip peer checkouts that would otherwise recurse into each other.
 */
function isKookrLauncherBinDir(dir) {
  try {
    return existsSync(join(dir, 'kb-spool-shim.js'));
  } catch {
    return false;
  }
}

function realpathSafe(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function execReal(bin, argv, env) {
  return new Promise((resolve) => {
    // Depth guard: if a peer shim still slips through (e.g. renamed without
    // the marker file), refuse to chain forever.
    const depth = Number.parseInt(env.KOOKR_KB_SHIM_DEPTH ?? '0', 10);
    if (Number.isFinite(depth) && depth >= 3) {
      process.stderr.write(
        '[kookr] kb spool shim: recursion depth exceeded while resolving real `kb`.\n',
      );
      resolve(127);
      return;
    }
    const childEnv = {
      ...env,
      KOOKR_KB_SHIM_DEPTH: String((Number.isFinite(depth) ? depth : 0) + 1),
    };
    const child = spawn(bin, argv, {
      env: childEnv,
      stdio: 'inherit',
    });
    child.on('error', (err) => {
      process.stderr.write(`[kookr] failed to exec real kb: ${err.message}\n`);
      resolve(127);
    });
    child.on('close', (code, signal) => {
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(chunks.join('')));
    process.stdin.on('error', reject);
    // If stdin is a TTY (interactive), don't hang — remember requires --stdin.
    if (process.stdin.isTTY) {
      resolve('');
    }
  });
}

async function loadWrapModule() {
  // Prefer compiled dist (production). Fall back to tsx/source for dev.
  const dist = join(here, '..', 'dist', 'core', 'kb-remember-spool-wrap.js');
  if (existsSync(dist)) {
    return import(pathToFileURL(dist).href);
  }
  // Dev / test: load TypeScript via the package's tsx register if available.
  try {
    const require = createRequire(import.meta.url);
    require.resolve('tsx/cjs');
    process.env.TSX_TSCONFIG_PATH = process.env.TSX_TSCONFIG_PATH
      ?? join(here, '..', 'tsconfig.json');
    // Dynamic import of .ts works when node is started with --import tsx;
    // for the shim we re-exec under tsx only if needed — prefer dist.
  } catch {
    // ignore
  }
  const src = join(here, '..', 'src', 'core', 'kb-remember-spool-wrap.ts');
  if (existsSync(src)) {
    try {
      return await import(pathToFileURL(src).href);
    } catch {
      // fall through
    }
  }
  throw new Error(
    'kb spool shim: compiled wrap module not found. Run `pnpm build:server` first.',
  );
}

main().catch((err) => {
  process.stderr.write(`[kookr] kb spool shim fatal: ${err instanceof Error ? err.stack ?? err.message : err}\n`);
  process.exit(1);
});
