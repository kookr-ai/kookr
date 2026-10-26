#!/usr/bin/env node
// nb — the Agent Notebook CLI. A role's bounded, voted, plain-text memory.
//
// Kookr DOGFOODS its own published tool: this shim resolves and runs the public
// `agent-notebook` npm package (the spin-out of this very tool) rather than a
// vendored fork. The package exposes `runNbCli` from its compiled `dist/cli.js`.
// Its `exports` map only publishes the main entry, so we resolve the main module
// and derive the sibling `cli.js` path, then import it by absolute path (which
// bypasses the `exports` restriction).
//
// Two kookr-local behaviors wrap the package:
//   1. NB_DIR defaults to ~/.kookr/notebooks (the package default is
//      ~/.agent-notebook/notebooks). Pinning it preserves every existing
//      notebook, the usage ring, and the retro-hook sentinel location.
//   2. When NB_DIR is a git repo, a successful mutating command is committed
//      (one commit per notebook modification). A daily job pushes those commits
//      to the private remote — see scripts/nb-backup.sh. Fail-open: a git error
//      never fails the `nb` call (the change is already on disk).

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

// Commands that write the notebook — only these are worth a git commit.
const MUTATING = new Set(['add', 'vote', 'merge', 'rm']);

// Inherited GIT_* vars pin git to a specific repo/worktree/index and would
// OVERRIDE our `-C <NB_DIR>`. When `nb` runs from inside a git hook or any
// context that exports these (e.g. a pre-push hook running tests), an unstripped
// `git -C <NB_DIR> add -A` commits to the WRONG repo. Strip them so the commit
// always targets the notebook repo. (Mirrors src/core/git-helpers NESTED_GIT_ENV_VARS.)
const NESTED_GIT_ENV_VARS = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_WORK_TREE',
];

function cleanGitEnv() {
  const env = { ...process.env };
  for (const name of NESTED_GIT_ENV_VARS) delete env[name];
  return env;
}

/** Resolve the installed `agent-notebook` package's compiled CLI entry. */
function resolveNbCliEntry() {
  const require = createRequire(import.meta.url);
  // Main export → .../dist/notebook.js; the CLI is its sibling dist/cli.js.
  const main = require.resolve('agent-notebook');
  const entry = join(dirname(main), 'cli.js');
  if (!existsSync(entry)) {
    throw new Error(`agent-notebook CLI not found at ${entry}`);
  }
  return entry;
}

/** The notebooks directory the CLI will use (mirrors the package's resolution). */
function notebooksDir() {
  const fromEnv = process.env.NB_DIR;
  return fromEnv && fromEnv.trim() !== '' ? fromEnv : join(homedir(), '.kookr', 'notebooks');
}

/**
 * `nb roles` — list the roles that already have a notebook, richest first, so a
 * caller can DISCOVER and REUSE an existing role instead of minting a
 * near-duplicate (role resolution is exact-string, so a typo silently creates a
 * new orphan notebook). Read-only: never commits. This is a kookr-local command
 * because the dogfooded `agent-notebook` package CLI has no listing command; if
 * it gains one upstream, this intercept can be retired.
 */
function listRoles(dir) {
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    files = [];
  }
  if (files.length === 0) {
    process.stdout.write(`(no notebooks yet in ${dir})\n`);
    return 0;
  }
  const rows = files.map((f) => {
    const role = f.slice(0, -'.md'.length);
    let count = 0;
    try {
      count = readFileSync(join(dir, f), 'utf-8')
        .split('\n')
        .filter((l) => l.trim() !== '').length;
    } catch {
      /* unreadable file → report 0 rather than crash the whole listing */
    }
    return { role, count };
  });
  // Richest first (most useful to reuse); ties broken by name for determinism.
  rows.sort((a, b) => b.count - a.count || a.role.localeCompare(b.role));
  const width = rows.reduce((w, r) => Math.max(w, r.role.length), 0);
  process.stdout.write(`agent-notebook roles — ${rows.length} in ${dir}\n`);
  for (const r of rows) {
    process.stdout.write(`  ${r.role.padEnd(width)}  ${r.count} lesson${r.count === 1 ? '' : 's'}\n`);
  }
  return 0;
}

/**
 * Commit a notebook modification when NB_DIR is a git repo. Best-effort and
 * fail-open: any failure (not a repo, no identity, index lock, nothing staged)
 * is swallowed — the lesson is already written to disk, and the daily backup
 * job will pick up any straggler. Opt out with NB_GIT_AUTOCOMMIT=0.
 */
function autoCommit(dir, argv) {
  if (process.env.NB_GIT_AUTOCOMMIT === '0') return;
  if (!existsSync(join(dir, '.git'))) return;
  // Bounded + non-interactive: a hung pre-commit hook or a credential/pinentry
  // prompt must never wedge this inline hot path. stdin is ignored and each git
  // call has a short timeout; on timeout execFileSync throws and the catch below
  // makes it fail-open (the lesson is already on disk; the daily job sweeps it).
  const gitEnv = cleanGitEnv();
  const run = (args) =>
    execFileSync('git', ['-C', dir, ...args], {
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 5000,
      env: gitEnv,
    });
  try {
    run(['add', '-A']);
    // `diff --cached --quiet` exits 1 when there IS something staged.
    try {
      run(['diff', '--cached', '--quiet']);
      return; // exit 0 → nothing staged → nothing to commit
    } catch {
      /* staged changes present — fall through to commit */
    }
    const cmd = (argv[0] ?? '').trim();
    const role = (argv[1] ?? '').trim();
    const msg = `nb ${cmd}${role ? ` ${role}` : ''}`.slice(0, 72);
    run(['commit', '--quiet', '-m', msg]);
  } catch {
    /* fail-open: never fail an nb call because the backup commit failed */
  }
}

async function main() {
  // Pin the kookr notebooks location so dogfooding the package does not relocate
  // existing notebooks or the usage ring.
  if (!process.env.NB_DIR || process.env.NB_DIR.trim() === '') {
    process.env.NB_DIR = notebooksDir();
  }

  // `nb roles` is handled here, before delegating to the package CLI (which has
  // no such command). Read-only discovery so new agents reuse existing roles.
  if ((process.argv[2] ?? '').trim() === 'roles') {
    process.exitCode = listRoles(process.env.NB_DIR);
    return;
  }

  let entry;
  try {
    entry = resolveNbCliEntry();
  } catch (e) {
    console.error(`[nb] ${e instanceof Error ? e.message : String(e)}`);
    console.error('[nb] Run `pnpm install` so the agent-notebook package is present.');
    process.exit(1);
  }

  const mod = await import(pathToFileURL(entry).href);
  const argv = process.argv.slice(2);
  const code = await mod.runNbCli(argv);
  process.exitCode = code;

  // One commit per successful notebook modification (Objective C).
  if (code === 0 && MUTATING.has((argv[0] ?? '').trim())) {
    autoCommit(process.env.NB_DIR, argv);
  }
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`nb: ${msg}`);
  process.exit(1);
});
