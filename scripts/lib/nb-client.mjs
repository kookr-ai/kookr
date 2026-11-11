// nb-client — the I/O side shared by the notebook store scripts
// (migrate-notebook-slugs.mjs, promote-notebook-lessons.mjs): run `nb`, read the
// store into the in-memory model from nb-sim.mjs, and handle the store's own
// git repo (tag before --apply, commit the one deletion the scripts make).
//
// Every write goes through the `nb` CLI, never by editing a shelf file. By
// default that CLI is the repo shim (bin/nb.js), because the shim commits each
// successful mutation to the store's git repo (one commit per `nb move`), which
// is what makes a migration revertable. `--nb <path>` swaps it (tests use the
// raw package CLI).
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { entryId } from './nb-sim.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** The Kookr `nb` shim: pins NB_DIR and commits every mutation. */
export const DEFAULT_NB = join(REPO_ROOT, 'bin', 'nb.js');

// Mirrors bin/nb.js: inherited GIT_* variables would override `git -C <dir>` and
// aim our tag/commit at the wrong repository (a pre-push hook exports them).
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

function gitEnv() {
  const env = { ...process.env };
  for (const name of NESTED_GIT_ENV_VARS) delete env[name];
  return env;
}

/** Run git against the notebooks repo. Never throws; returns `{ ok, stdout, stderr }`. */
export function git(dir, args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf-8', env: gitEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  return { ok: r.status === 0, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
}

/** True when `dir` is itself a git work tree root (the shim's own test: `<dir>/.git` exists). */
export function isStoreGitRepo(dir) {
  return existsSync(join(dir, '.git')) && git(dir, ['rev-parse', '--git-dir']).ok;
}

function commitArgs(dir) {
  // Fall back to a generic identity only when git has none configured, so a
  // fresh store repo does not make the script's own commit fail.
  const hasName = git(dir, ['config', 'user.name']).stdout !== '';
  const hasEmail = git(dir, ['config', 'user.email']).stdout !== '';
  return [...(hasName ? [] : ['-c', 'user.name=kookr-nb-tooling']), ...(hasEmail ? [] : ['-c', 'user.email=kookr-nb-tooling@localhost'])];
}

/** Stage everything and commit if anything is staged. Returns true when a commit was made. */
export function commitAll(dir, message) {
  if (!git(dir, ['add', '-A']).ok) return false;
  if (git(dir, ['diff', '--cached', '--quiet']).ok) return false; // nothing staged
  return git(dir, [...commitArgs(dir), 'commit', '--quiet', '-m', message]).ok;
}

/**
 * Commit only the named paths (relative to `dir`), leaving any other pending
 * change (an agent's write in flight) for its own commit. Returns true when a
 * commit was made.
 */
export function commitPaths(dir, paths, message) {
  if (!git(dir, ['add', '-A', '--', ...paths]).ok) return false;
  if (git(dir, ['diff', '--cached', '--quiet', '--', ...paths]).ok) return false; // nothing staged for these paths
  return git(dir, [...commitArgs(dir), 'commit', '--quiet', '-m', message, '--', ...paths]).ok;
}

/**
 * Tag the store's git repo so the run has a rollback anchor. Uncommitted store
 * changes are committed first (what the daily backup does anyway) so the tag
 * names a state that includes them. An existing tag is kept (a resumed run must
 * not move the anchor). Returns `{ ok, created, snapshotCommitted, error }`.
 */
export function tagStore(dir, tag) {
  if (!isStoreGitRepo(dir)) return { ok: false, created: false, snapshotCommitted: false, error: `${dir} is not a git repository` };
  if (git(dir, ['rev-parse', '-q', '--verify', `refs/tags/${tag}`]).ok) {
    return { ok: true, created: false, snapshotCommitted: false };
  }
  const snapshotCommitted = commitAll(dir, `snapshot before ${tag}`);
  const r = git(dir, ['tag', tag]);
  return r.ok ? { ok: true, created: true, snapshotCommitted } : { ok: false, created: false, snapshotCommitted, error: r.stderr };
}

/**
 * Delete a leftover 0-byte shelf file (nb 0.7.0's `move` leaves one when it
 * moves a shelf's last lesson; only `rm` deletes it, and the `move` fix is not
 * released). Guarded three ways, because this is the one place a script deletes
 * a file: it must resolve INSIDE `dir`, be named exactly `<shelf>.md`, and be a
 * regular file of size 0. A file with any content (a description, a lesson) is
 * never touched. Returns `'deleted' | 'absent' | 'not-empty' | 'refused'`.
 */
export function reapZeroByteShelf(dir, shelf) {
  const root = resolve(dir) + sep;
  const file = resolve(dir, `${shelf}.md`);
  if (!file.startsWith(root) || basename(file) !== `${shelf}.md` || shelf === '' || shelf.includes('/') || shelf.includes('\\')) {
    return 'refused';
  }
  if (!existsSync(file)) return 'absent';
  const st = lstatSync(file);
  if (!st.isFile()) return 'refused';
  if (st.size !== 0) return 'not-empty';
  unlinkSync(file);
  return 'deleted';
}

// ---------------------------------------------------------------------------
// running nb
// ---------------------------------------------------------------------------

/** A runner for one notebooks directory. */
export function createNbClient({ dir, nb = DEFAULT_NB, env = process.env } = {}) {
  const runEnv = { ...env };
  if (dir) runEnv.NB_DIR = dir;
  const isScript = /\.(?:m?js|cjs)$/i.test(nb);
  const command = isScript ? process.execPath : nb;
  const prefix = isScript ? [nb] : [];

  function run(args) {
    const r = spawnSync(command, [...prefix, ...args], { encoding: 'utf-8', env: runEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: r.status, stdout: r.stdout ?? '', stderr: (r.stderr ?? '').trim(), error: r.error };
  }

  function runJson(args) {
    const r = run(args);
    if (r.error) return { ok: false, error: r.error.message, ...r };
    try {
      return { ok: true, json: JSON.parse(r.stdout), ...r };
    } catch {
      return { ok: false, error: r.stderr || `non-JSON output from nb ${args[0]}`, ...r };
    }
  }

  /**
   * With the default shim, every successful mutation is a git commit unless
   * NB_GIT_AUTOCOMMIT=0. The scripts' rollback story depends on those commits,
   * so --apply refuses when they are switched off. (A custom --nb is the caller's
   * responsibility.)
   */
  const autocommitOff = nb === DEFAULT_NB && runEnv.NB_GIT_AUTOCOMMIT === '0';
  return { run, runJson, dir: runEnv.NB_DIR, autocommitOff };
}

// ---------------------------------------------------------------------------
// reading the store
// ---------------------------------------------------------------------------

const META_RE = /^#\s*([a-z][a-z0-9_-]*):\s?(.*)$/;

/**
 * Entry ids of a shelf file in FILE order (least-recently-touched first), parsed
 * read-only the way `nb` parses it (leading `# key:` lines are metadata; every
 * later non-blank line is `<score>\t<lesson>`). `nb show --json` lists highest
 * score first and drops this order, but eviction ties and the one-point aging
 * both depend on it, so the simulation needs it. Returns `null` if unreadable.
 */
export function readFileOrderIds(dir, shelf) {
  let body;
  try {
    body = readFileSync(join(dir, `${shelf}.md`), 'utf-8');
  } catch {
    return null;
  }
  const ids = [];
  let inMeta = true;
  for (const line of body.split('\n')) {
    if (inMeta && META_RE.test(line)) continue;
    inMeta = false;
    if (line.trim() === '') continue;
    const tab = line.indexOf('\t');
    const text = (tab === -1 ? line : line.slice(tab + 1)).replace(/[\t\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (text !== '') ids.push(entryId(text));
  }
  return ids;
}

/**
 * Read one shelf: entries in file order. Falls back to display order (and flags
 * `approximateOrder`) when the file's ids do not match `nb show --json`, so a
 * parse drift can never silently produce a confident but wrong simulation.
 */
export function readShelf(client, dir, shelf) {
  const r = client.runJson(['show', shelf, '--json']);
  if (!r.ok || !Array.isArray(r.json?.entries)) {
    return { ok: false, error: r.error ?? `nb show ${shelf} failed` };
  }
  const shown = r.json.entries.map((e) => ({ id: e.id, score: e.score, text: e.text }));
  const order = readFileOrderIds(dir, shelf);
  let entries = shown;
  let approximateOrder = true;
  if (order && order.length === shown.length) {
    const byId = new Map();
    for (const e of shown) {
      if (!byId.has(e.id)) byId.set(e.id, []);
      byId.get(e.id).push(e);
    }
    const arranged = [];
    let consistent = true;
    for (const id of order) {
      const bucket = byId.get(id);
      if (!bucket || bucket.length === 0) {
        consistent = false;
        break;
      }
      arranged.push(bucket.shift());
    }
    if (consistent) {
      entries = arranged;
      approximateOrder = false;
    }
  }
  return {
    ok: true,
    entries,
    description: r.json.description ?? null,
    exists: r.json.exists !== false,
    approximateOrder,
  };
}

/**
 * Snapshot the whole store: every shelf `nb list` shows, plus the shelf files on
 * disk that it hides (0-byte leftovers). Returns
 * `{ dir, store, descriptions, zeroByte, approximateOrder }`.
 */
export function snapshotStore(client) {
  // `nb list` shows only 50 rows unless told otherwise; a truncated index would
  // make the plan silently ignore shelves, so ask for everything and verify.
  const listed = client.runJson(['list', '--json', '--limit', '100000']);
  if (!listed.ok || !Array.isArray(listed.json?.rows)) {
    throw new Error(`nb list --json failed: ${listed.error ?? 'unexpected output'}`);
  }
  if (typeof listed.json.total === 'number' && listed.json.rows.length < listed.json.total) {
    throw new Error(`nb list --json returned ${listed.json.rows.length} of ${listed.json.total} shelves; refusing to plan from a partial index`);
  }
  const dir = listed.json.dir;
  const store = new Map();
  const descriptions = new Map();
  const approximateOrder = [];
  for (const row of listed.json.rows) {
    const shelf = row.shelf ?? row.role;
    const r = readShelf(client, dir, shelf);
    if (!r.ok) throw new Error(r.error);
    store.set(shelf, r.entries);
    descriptions.set(shelf, r.description);
    if (r.approximateOrder && r.entries.length > 1) approximateOrder.push(shelf);
  }
  const listedNames = new Set(store.keys());
  const zeroByte = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    const name = f.slice(0, -3);
    if (listedNames.has(name)) continue;
    try {
      if (statSync(join(dir, f)).size === 0) zeroByte.push(name);
    } catch {
      /* raced with a delete */
    }
  }
  return { dir, store, descriptions, zeroByte, approximateOrder };
}

/** Re-read just these shelves into `store` (a shelf that vanished becomes empty). */
export function refreshShelves(client, dir, store, shelves) {
  for (const shelf of shelves) {
    const r = readShelf(client, dir, shelf);
    if (!r.ok) throw new Error(r.error);
    store.set(shelf, r.entries);
  }
}

// ---------------------------------------------------------------------------
// writing through nb
// ---------------------------------------------------------------------------

/**
 * Run `nb move` and classify the result from its `--json` output. The exit code
 * is never used: a refused move (`reason: "duplicate"`) prints "skipped" and
 * exits 0. Anything whose `reason` is not exactly "moved" is a skip.
 * Returns `{ moved, reason, evicted, result, error }`.
 */
export function nbMove(client, from, to, id, { reason = 'consolidate', note } = {}) {
  const args = ['move', from, to, id, '--json', '--reason', reason];
  if (note) args.push('--note', note);
  const r = client.runJson(args);
  if (!r.ok) return { moved: false, reason: 'error', error: r.error ?? r.stderr, evicted: null };
  const reasonField = r.json?.reason;
  return {
    moved: reasonField === 'moved',
    reason: typeof reasonField === 'string' ? reasonField : 'unknown',
    evicted: r.json?.evicted ?? null,
    result: r.json,
  };
}

/** Run `nb rm <shelf> <id> --reason obsolete --note duplicate`. Returns `{ ok, error }`. */
export function nbRemoveDuplicate(client, shelf, id) {
  const r = client.run(['rm', shelf, id, '--reason', 'obsolete', '--note', 'duplicate']);
  return r.status === 0 ? { ok: true } : { ok: false, error: r.stderr || `nb rm exited ${r.status}` };
}

/** The `nb` command line a human could run for a move (printed in dry-run plans). */
export function moveCommand(from, to, id, reason = 'consolidate') {
  return `nb move ${from} ${to} ${id} --reason ${reason}`;
}

/** The `nb rm` command line for removing a duplicate copy. */
export function removeCommand(shelf, id) {
  return `nb rm ${shelf} ${id} --reason obsolete --note duplicate`;
}

