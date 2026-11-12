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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

// Commands that write the notebook — only these are worth a git commit.
// Kept in sync with the package's mutating verbs (add/vote/merge/rm/split/move/describe).
// `move` is the promotion verb (it keeps a lesson's score), so it must be committed too.
// src/cli/nb-bin.test.ts reads this line and fails when `nb --help` lists a mutating
// verb that is missing here, so keep it a single `new Set([...])` literal.
const MUTATING = new Set(['add', 'vote', 'merge', 'rm', 'split', 'move', 'describe']);

// The shelf that holds host-wide lessons. Written only by the curator/promotion run.
const GLOBAL_SHELF = 'fleet-global';

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

/**
 * Fallback alias lookup, used only when the shared layers module cannot be loaded:
 * legacy short slugs that still mean `slug` (e.g. `agent-notebook` for
 * `jeanibarz-agent-notebook`), read from plugin/notebooks/slug-aliases.json as
 * `{ "<legacy>": "<canonical slug>" }`. A missing or unparsable file means no aliases,
 * never an error. The file lives in the repo's plugin/ tree, so it is only found when
 * `nb` runs from a repo checkout, which is where Kookr runs it.
 */
function aliasesOf(slug) {
  try {
    const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'notebooks', 'slug-aliases.json');
    if (!existsSync(file)) return new Set();
    const map = JSON.parse(readFileSync(file, 'utf-8'));
    if (!map || typeof map !== 'object') return new Set();
    return new Set(Object.keys(map).filter((legacy) => map[legacy] === slug));
  } catch {
    return new Set();
  }
}

/**
 * The shared shelf classifier (plugin/hooks/lib/notebook-layers.mjs), or null when it
 * cannot be loaded. It is imported dynamically and guarded on purpose: this shim
 * wraps EVERY `nb` call, so a missing or broken plugin file must cost only the
 * advisory's precision (it falls back to the older first-`@`, case-sensitive check),
 * never a failed `nb` command. A static import would crash the shim at startup.
 */
async function loadLayers() {
  try {
    const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'hooks', 'lib', 'notebook-layers.mjs');
    return await import(pathToFileURL(file).href);
  } catch {
    return null;
  }
}

/**
 * True when `shelf` is a `<situation>@<other-slug>` shelf of a different repo than
 * `slug`; `shelfSlug` is the slug it is scoped to. With the shared module this uses the
 * same rules as the SessionStart index (last `@`, case-insensitive, trimmed, legacy
 * slugs resolved), so the two can never classify one shelf differently. Without it,
 * the older rules apply (first `@`, case-sensitive).
 */
async function foreignProjectShelf(shelf, slug) {
  const layers = await loadLayers();
  if (layers) {
    const aliases = layers.loadSlugAliases();
    const c = layers.classifyShelf(shelf, aliases);
    if (c.layer !== 'project') return null;
    return c.canonical === layers.canonicalSlug(slug, aliases) ? null : c.slug;
  }
  const at = shelf.indexOf('@');
  if (at <= 0) return null;
  const shelfSlug = shelf.slice(at + 1);
  return shelfSlug !== slug && !aliasesOf(slug).has(shelfSlug) ? shelfSlug : null;
}

// The flags of the package's own argument parser that take a value (its
// `VALUE_FLAGS`): the token after one of them is that value, never an option.
const NB_VALUE_FLAGS = new Set(['--reason', '--note', '--limit', '--since']);

/**
 * True when the call is a help request for a subcommand (`nb add <shelf> --help`
 * or `-h`). Since agent-notebook 0.8.0 such a call prints usage, exits 0 and
 * writes nothing, so nothing after it should treat it as a notebook change.
 * This follows the package's own scan (`helpRequest` in its cli.js): tokens after
 * the command word, up to a `--`, skipping the value of a value flag.
 */
function isHelpRequest(argv) {
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--') return false;
    if (NB_VALUE_FLAGS.has(argv[i])) i++;
    else if (argv[i] === '--help' || argv[i] === '-h') return true;
  }
  return false;
}

/**
 * One-line stderr advisories after a successful `nb add`. Never a refusal: the
 * lesson is already written and the shim stays fail-open. They only make a wrong
 * layer or another repo's shelf visible to the agent that just wrote it.
 */
async function adviseOnAdd(argv) {
  try {
    if ((argv[0] ?? '').trim() !== 'add') return;
    // First positional after `add`; `--reason`/`--note` take a value that is not the shelf.
    let shelf;
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === '--reason' || argv[i] === '--note') i++;
      else if (!argv[i].startsWith('--')) {
        shelf = argv[i];
        break;
      }
    }
    if (!shelf) return;
    if (shelf === GLOBAL_SHELF) {
      if (!process.env.KOOKR_NB_CURATOR) {
        console.error(
          `[nb] advisory: ${GLOBAL_SHELF} is written only by promotion (the curator run); ` +
            `add the lesson to <situation>@<slug> or the unscoped <situation> shelf instead.`,
        );
      }
      return;
    }
    const slug = (process.env.KOOKR_REPO_SLUG ?? '').trim();
    if (slug === '') return; // no repo slug to compare with
    const shelfSlug = await foreignProjectShelf(shelf, slug);
    if (shelfSlug !== null) {
      console.error(
        `[nb] advisory: shelf ${shelf} is scoped to '${shelfSlug}', but this repo's slug is '${slug}'; ` +
          `if the lesson is about this repo use <situation>@${slug}.`,
      );
    }
  } catch {
    /* an advisory must never fail an nb call */
  }
}

async function main() {
  // Pin the kookr notebooks location so dogfooding the package does not relocate
  // existing notebooks or the usage ring.
  if (!process.env.NB_DIR || process.env.NB_DIR.trim() === '') {
    process.env.NB_DIR = notebooksDir();
  }

  // No command interception: the shim is a thin wrapper that only pins NB_DIR
  // and git-backs mutating writes. Discovery (`nb list` and its `ls`/`roles`
  // aliases, with per-shelf descriptions) is now the package's own, so every
  // command passes straight through to it — nothing kookr-local shadows it.

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

  // A help request exits 0 but changed nothing: no advisory, and no commit (which
  // would otherwise sweep an unrelated uncommitted edit under this command's name).
  if (code !== 0 || isHelpRequest(argv)) return;

  await adviseOnAdd(argv);

  // One commit per successful notebook modification (Objective C).
  if (MUTATING.has((argv[0] ?? '').trim())) {
    autoCommit(process.env.NB_DIR, argv);
  }
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`nb: ${msg}`);
  process.exit(1);
});
