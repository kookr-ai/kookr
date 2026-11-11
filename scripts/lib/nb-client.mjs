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
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { basename, delimiter, dirname, join, resolve, sep } from 'node:path';
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

/**
 * True when `dir` is itself the root of a git work tree. `<dir>/.git` must exist
 * (the shim's own test) AND git must report `dir` as its own top level, so a
 * stray `.git` that is not a repository, or a store that merely sits inside some
 * other repository, never gets that other repository tagged and committed to.
 */
export function isStoreGitRepo(dir) {
  if (!existsSync(join(dir, '.git'))) return false;
  const top = git(dir, ['rev-parse', '--show-toplevel']);
  if (!top.ok || top.stdout === '') return false;
  try {
    return realpathSync(top.stdout) === realpathSync(dir);
  } catch {
    return false;
  }
}

/** The store repository's current HEAD commit, or null (no commits yet, or not a repo). */
export function headSha(dir) {
  const r = git(dir, ['rev-parse', '-q', '--verify', 'HEAD']);
  return r.ok ? r.stdout : null;
}

function commitArgs(dir) {
  // Fall back to a generic identity only when git has none configured, so a
  // fresh store repo does not make the script's own commit fail.
  const hasName = git(dir, ['config', 'user.name']).stdout !== '';
  const hasEmail = git(dir, ['config', 'user.email']).stdout !== '';
  return [...(hasName ? [] : ['-c', 'user.name=kookr-nb-tooling']), ...(hasEmail ? [] : ['-c', 'user.email=kookr-nb-tooling@localhost'])];
}

/**
 * Stage everything and commit if anything is staged. Returns `'committed'`,
 * `'nothing'` (nothing was staged) or `'failed'` (git refused: a hook, a lock
 * file, no identity).
 */
export function commitAll(dir, message) {
  if (!git(dir, ['add', '-A']).ok) return 'failed';
  if (git(dir, ['diff', '--cached', '--quiet']).ok) return 'nothing';
  return git(dir, [...commitArgs(dir), 'commit', '--quiet', '-m', message]).ok ? 'committed' : 'failed';
}

/**
 * Commit only the named paths (relative to `dir`), leaving any other pending
 * change (an agent's write in flight) for its own commit. Returns
 * `'committed' | 'nothing' | 'failed'` as {@link commitAll} does.
 */
export function commitPaths(dir, paths, message) {
  if (!git(dir, ['add', '-A', '--', ...paths]).ok) return 'failed';
  if (git(dir, ['diff', '--cached', '--quiet', '--', ...paths]).ok) return 'nothing'; // nothing staged for these paths
  return git(dir, [...commitArgs(dir), 'commit', '--quiet', '-m', message, '--', ...paths]).ok ? 'committed' : 'failed';
}

/**
 * Tag the store's git repo so the run has a rollback anchor. Uncommitted store
 * changes are committed first (what the daily backup does anyway) so the tag
 * names a state that includes them; if that commit FAILS the run is refused,
 * because a tag on the older HEAD would leave those changes outside the rollback.
 * An existing tag is kept (a resumed run must not move the anchor). Returns
 * `{ ok, created, snapshotCommitted, error }`.
 */
export function tagStore(dir, tag) {
  if (!isStoreGitRepo(dir)) return { ok: false, created: false, snapshotCommitted: false, error: `${dir} is not a git repository` };
  if (git(dir, ['rev-parse', '-q', '--verify', `refs/tags/${tag}`]).ok) {
    return { ok: true, created: false, snapshotCommitted: false };
  }
  const snapshot = commitAll(dir, `snapshot before ${tag}`);
  if (snapshot === 'failed') {
    return { ok: false, created: false, snapshotCommitted: false, error: 'git could not commit the store\'s pending changes (a failing hook, a stale index.lock, or no git identity?); fix that and re-run' };
  }
  const snapshotCommitted = snapshot === 'committed';
  const r = git(dir, ['tag', '--', tag]);
  if (r.ok && !git(dir, ['rev-parse', '-q', '--verify', `refs/tags/${tag}`]).ok) {
    return { ok: false, created: false, snapshotCommitted, error: `git did not create tag ${JSON.stringify(tag)}` };
  }
  return r.ok ? { ok: true, created: true, snapshotCommitted } : { ok: false, created: false, snapshotCommitted, error: r.stderr };
}

/**
 * Take nb's own store lock (`<dir>/.nb.lock`, an atomic mkdir; the protocol is
 * agent-notebook's `withLock`) for a short synchronous critical section. Returns
 * a release function, or null if the lock stayed busy for about three seconds
 * (an `nb` call in flight, or a crashed holder: nb itself steals stale locks, we
 * simply decline).
 */
function takeStoreLock(dir) {
  const lock = join(dir, '.nb.lock');
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      mkdirSync(lock);
      return () => {
        try {
          rmdirSync(lock);
        } catch {
          /* already gone */
        }
      };
    } catch {
      Atomics.wait(pause, 0, 0, 25);
    }
  }
  return null;
}

/**
 * Delete a leftover 0-byte shelf file (nb 0.7.0's `move` leaves one when it
 * moves a shelf's last lesson; only `rm` deletes it, and the `move` fix is not
 * released). Guarded, because this is the one place a script deletes a file: it
 * must resolve INSIDE `dir`, be named exactly `<shelf>.md`, and be a regular
 * file of size 0, re-checked while holding nb's store lock so an `nb add` that
 * lands in between cannot be deleted with it. A file with any content (a
 * description, a lesson) is never touched.
 * Returns `'deleted' | 'absent' | 'not-empty' | 'refused' | 'locked'`.
 */
export function reapZeroByteShelf(dir, shelf) {
  const root = resolve(dir) + sep;
  const file = resolve(dir, `${shelf}.md`);
  if (!file.startsWith(root) || basename(file) !== `${shelf}.md` || shelf === '' || shelf.includes('/') || shelf.includes('\\')) {
    return 'refused';
  }
  if (!existsSync(file)) return 'absent';
  const release = takeStoreLock(dir);
  if (!release) return 'locked';
  try {
    if (!existsSync(file)) return 'absent';
    const st = lstatSync(file);
    if (!st.isFile()) return 'refused';
    if (st.size !== 0) return 'not-empty';
    unlinkSync(file);
    return 'deleted';
  } finally {
    release();
  }
}

/**
 * A set-but-blank NB_DIR (`NB_DIR="$COPY"` with COPY unset) is treated by `nb`
 * as unset and falls back to the live store. Returns an error message for that
 * case, else null.
 */
export function blankNbDir(env = process.env) {
  return env.NB_DIR !== undefined && env.NB_DIR.trim() === ''
    ? 'NB_DIR is set but empty (is a shell variable unset?); nb would fall back to the live notebooks directory. Unset it or point it at a store.'
    : null;
}

/**
 * Strictly validate a command line: every token must be a known switch, a known
 * value flag, or the value right after one. Returns an error message or null.
 *
 * Why strict. These scripts can move and remove lessons, and a restricted run
 * must never silently become a broader one. A flag that was misspelled
 * (`--onyl`), written with `=` (`--only=c-1`) or given an empty value (`--only
 * "$IDS"` with IDS unset) would otherwise be ignored, and the run would proceed
 * as a plain `--apply`.
 */
export function checkArgv(argv, { switches = [], values = [] }) {
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (switches.includes(a)) continue;
    if (values.includes(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.trim() === '' || v.startsWith('-')) {
        return `${a} needs a value${v === '' ? ' (it was empty: is a shell variable unset?)' : ''}${v?.startsWith('-') ? ` (got "${v}", which looks like a flag)` : ''}`;
      }
      // Only the first occurrence of a value flag would be read, so a repeat
      // would be silently dropped (`--only a --only b` applying just a).
      if (seen.has(a)) return `${a} was given more than once; pass one value (comma-separated for several ids)`;
      seen.add(a);
      i++;
      continue;
    }
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq > 2 && values.includes(a.slice(0, eq))) {
      return `unknown argument ${JSON.stringify(a)}: write "${a.slice(0, eq)} ${a.slice(eq + 1)}" with a space`;
    }
    return `unknown argument ${JSON.stringify(a)}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// running nb
// ---------------------------------------------------------------------------

/** The file a command name refers to: itself if it has a path separator, else the first match on PATH (like a shell). */
function resolveCommand(cmd, env = process.env) {
  if (cmd.includes('/') || cmd.includes(sep)) return cmd;
  for (const d of (env.PATH ?? '').split(delimiter)) {
    if (d === '') continue;
    const candidate = join(d, cmd);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* not here */
    }
  }
  return cmd;
}

/** True when two paths name the same file, following symlinks (`which nb` is a symlink to the shim). */
function samePath(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
}

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
  const usesShim = samePath(resolveCommand(nb, runEnv), DEFAULT_NB);
  const autocommitOff = usesShim && runEnv.NB_GIT_AUTOCOMMIT === '0';
  return { run, runJson, dir: runEnv.NB_DIR, autocommitOff, expectsCommits: usesShim && !autocommitOff };
}

// ---------------------------------------------------------------------------
// reading the store
// ---------------------------------------------------------------------------

const META_RE = /^#\s*([a-z][a-z0-9_-]*):\s?(.*)$/;

/**
 * Parse the text of a shelf file, read-only, the way `nb` does: leading `# key:`
 * lines are metadata, every later non-blank line is `<score>\t<lesson>`.
 * Returns entries `{ id, score, text }` in FILE order (least-recently-touched first).
 */
export function parseShelfText(body) {
  const entries = [];
  let inMeta = true;
  for (const line of body.split('\n')) {
    if (inMeta && META_RE.test(line)) continue;
    inMeta = false;
    if (line.trim() === '') continue;
    const tab = line.indexOf('\t');
    const text = (tab === -1 ? line : line.slice(tab + 1)).replace(/[\t\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (text === '') continue;
    const n = tab === -1 ? 0 : Number.parseInt(line.slice(0, tab), 10);
    entries.push({ id: entryId(text), score: Number.isFinite(n) ? n : 0, text });
  }
  return entries;
}

/**
 * Entry ids of a shelf file in FILE order (least-recently-touched first), parsed
 * read-only. `nb show --json` lists highest score first and drops this order, but
 * eviction ties and the one-point aging both depend on it, so the simulation needs
 * it. Returns `null` if the file is unreadable.
 */
export function readFileOrderIds(dir, shelf) {
  let body;
  try {
    body = readFileSync(join(dir, `${shelf}.md`), 'utf-8');
  } catch {
    return null;
  }
  return parseShelfText(body).map((e) => e.id);
}

/**
 * The store as it was at git ref `tag` (a rollback tag), for `shelves`: a
 * Map<shelf, entries in file order>. Returns `null` when the tag does not exist.
 * A resumed run judges its moves against this baseline, not against the store as
 * the earlier part of the run left it, so the one-point aging that earlier moves
 * caused cannot lower the bar for the rest.
 */
export function storeAtTag(dir, tag, shelves) {
  if (!git(dir, ['rev-parse', '-q', '--verify', `refs/tags/${tag}`]).ok) return null;
  const store = new Map();
  for (const shelf of shelves) {
    const r = git(dir, ['show', `refs/tags/${tag}:${shelf}.md`]);
    store.set(shelf, r.ok ? parseShelfText(r.stdout) : []);
  }
  return store;
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

