#!/usr/bin/env node
// disk-reclaim: classify reclaimable disk space by safety (SAFE / REVIEW / NEVER)
// and, on request, delete only the SAFE tier. Dependency-free, Node >= 20,
// Linux + macOS. Report mode is the default and deletes nothing.
//
// Usage: node disk-reclaim.mjs [--roots a,b] [--data-dir D] [--min-idle-days 2]
//   [--json] [--apply safe] [--until-free-percent 10] [--fetch]
//   [--concurrency 8] [--timeout-s 600] [--top 15]
import { execFile, spawn } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const usage =
  'Usage: node disk-reclaim.mjs [--roots a,b] [--data-dir D] [--min-idle-days 2] [--json] ' +
  '[--apply safe] [--until-free-percent 10] [--fetch] [--concurrency 8] [--timeout-s 600] [--top 15]\n' +
  '  --fetch runs `git fetch --prune` in every repo: it needs the network and UPDATES/DELETES remote-tracking refs.\n' +
  '  --apply safe deletes the SAFE tier only; without it nothing is deleted.';

const KIB = 1024;
const MIB = 1024 * KIB;
const GIB = 1024 * MIB;
const DAY_MS = 86_400_000;
/** REVIEW listing threshold: smaller leftovers are noise. */
export const MIN_REVIEW_BYTES = 500 * MIB;
/** SAFE items smaller than this are not worth a git/rm round trip. */
export const MIN_SAFE_BYTES = 20 * MIB;
/** Kookr admission floors (src/server/config.ts). Overridable by the same env vars Kookr reads. */
const DEFAULT_FLOOR_PERCENT = 5;
const DEFAULT_FLOOR_BYTES = 2 * GIB;
const TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'terminated']);
/** `terminated` tasks with these reasons are relaunched by crash recovery (isRecoverableTermination), so they count as live. */
const RECOVERABLE_TERMINATION = new Set(['server-restart', 'oom', 'timeout', 'unknown', undefined]); // undefined: server's isRecoverableTermination(undefined)
const RECOVERY_WINDOW_MS = 7 * 86_400_000;
/**
 * Lowered-age prune flags. Deletes up to ~29 days of finished-task history that
 * the operator's default policy keeps, so it is only ever offered as REVIEW.
 */
const PRUNE_FLAGS = [
  '--max-age-days', '1',
  '--playbook-max-age-days', '1',
  '--playbook-keep-last', '3',
  '--operator-signal-delivered-max-age-days', '1',
  '--atomic-temp-max-age-days', '1',
];

/**
 * `git worktree remove` deletes ALL git-ignored files, so a worktree is SAFE
 * only if every ignored entry is one of:
 *  - a `node_modules/` directory with a `package.json` AND a lockfile in its
 *    parent directory and no nested `.git` inside it (checked by the caller);
 *  - a tool-owned cache whose name never holds user data (listed below).
 * Everything else, notably `out/`, `build/`, `dist/`, `target/`, `.cache/`,
 * `.venv/`, `coverage/` (they routinely hold checkpoints, results or
 * hand-installed packages), is content and sends the worktree to REVIEW.
 */
const TOOL_CACHE_DIRS = new Set(['__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.turbo']);
const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lockb', 'bun.lock'];

/** @returns {'cache' | 'node_modules' | 'content'} */
export function classifyIgnoredEntry(entry) {
  const parts = entry.split('/').filter(Boolean);
  const last = parts[parts.length - 1] ?? '';
  if (entry.endsWith('/')) {
    if (last === 'node_modules') return 'node_modules';
    if (TOOL_CACHE_DIRS.has(last) || (last === 'cache' && parts[parts.length - 2] === '.next')) return 'cache';
    return 'content';
  }
  return last === '.eslintcache' || last.endsWith('.tsbuildinfo') ? 'cache' : 'content';
}

/** Paths per `git check-attr` call (keeps the argument list well under ARG_MAX). */
const ATTR_CHUNK = 1000;

/** Above this many distinct reflog tips the reflog check is skipped and the worktree treated as not SAFE. */
const REFLOG_TIP_LIMIT = 2000;

/** Test-only: extra environment for every spawned command (e.g. hermetic git config). */
let extraEnv = {};
export function setExecEnvForTests(env) {
  extraEnv = env ?? {};
}

export function parseArgs(argv, env = process.env, home = homedir()) {
  const o = {
    roots: [join(home, 'git')],
    dataDir: defaultDataDir(env, home),
    minIdleDays: 2,
    json: false,
    apply: false,
    untilFreePercent: 10,
    fetch: false,
    concurrency: 8,
    timeoutS: 600,
    top: 15,
    help: false,
    // Not CLI flags: size floors that tests lower so fixtures can stay tiny.
    minReviewBytes: MIN_REVIEW_BYTES,
    minSafeBytes: MIN_SAFE_BYTES,
  };
  const need = (i, flag) => {
    if (argv[i + 1] === undefined) throw new Error(`${flag} requires a value`);
    return argv[i + 1];
  };
  const num = (i, flag, min) => {
    const v = Number(need(i, flag));
    if (!Number.isFinite(v) || v < min) throw new Error(`${flag} must be a number >= ${min}`);
    return v;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--json') o.json = true;
    else if (a === '--fetch') o.fetch = true;
    else if (a === '--roots') o.roots = need(i++, a).split(',').filter(Boolean).map((p) => expandHome(p, home));
    else if (a === '--data-dir') o.dataDir = expandHome(need(i++, a), home);
    else if (a === '--min-idle-days') o.minIdleDays = num(i++, a, 0);
    else if (a === '--until-free-percent') o.untilFreePercent = num(i++, a, 0);
    else if (a === '--concurrency') o.concurrency = Math.max(1, Math.floor(num(i++, a, 1)));
    else if (a === '--timeout-s') o.timeoutS = num(i++, a, 1);
    else if (a === '--top') o.top = Math.floor(num(i++, a, 1));
    else if (a === '--apply') {
      if (need(i++, a) !== 'safe') throw new Error('--apply only accepts "safe"');
      o.apply = true;
    } else throw new Error(`Unknown argument: ${a}`);
  }
  o.roots = o.roots.map((r) => resolve(r));
  o.dataDir = resolve(o.dataDir);
  for (const r of o.roots) {
    if (r === '/' || r === resolve(home) || r === o.dataDir || under(o.dataDir, r) || under(join(home, '.ssh'), r) || under(join(home, '.config'), r)) {
      throw new Error(`refusing --roots entry ${r}: it is, or contains, the home directory, the data directory, ~/.ssh or ~/.config`);
    }
  }
  return o;
}

function defaultDataDir(env, home) {
  const port = env.KOOKR_PORT;
  if (port && /^\d+$/.test(port) && port !== '4800') return join(home, `.kookr-${port}`);
  return join(home, '.kookr');
}

function expandHome(p, home) {
  if (p === '~') return home;
  return p.startsWith('~/') ? join(home, p.slice(2)) : p;
}

// ---------------------------------------------------------------- helpers

/** Runs a command; never rejects. `code` is the exit status (number) or null. */
/** Drop variables that would point every `git -C <dir>` at some other repository (e.g. inside a git hook). */
function childEnv(env) {
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_NAMESPACE']) delete env[k];
  return env;
}

function exec(cmd, args, { cwd, timeoutMs = 60_000, env } = {}) {
  return new Promise((done) => {
    execFile(
      cmd,
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 256 * MIB,
        env: childEnv({ ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', ...extraEnv, ...env }),
      },
      (err, stdout, stderr) => {
        const timedOut = Boolean(err && err.killed);
        const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
        done({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), timedOut, spawnError: err && code === null && !timedOut ? err.message : null });
      },
    );
  });
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function under(path, dir) {
  return path === dir || path.startsWith(dir + sep);
}

function safeRealpath(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

export function fmtBytes(n) {
  if (n == null || !Number.isFinite(n)) return '?';
  if (n >= GIB) return `${(n / GIB).toFixed(1)} GiB`;
  if (n >= MIB) return `${(n / MIB).toFixed(0)} MiB`;
  return `${(n / KIB).toFixed(0)} KiB`;
}

/** `du -k -d 1 dir`: one walk gives the total and each immediate child. */
async function duTop(dir, timeoutMs) {
  const r = await exec('du', ['-k', '-d', '1', '--', dir], { timeoutMs });
  const sizes = new Map();
  for (const line of r.stdout.split('\n')) {
    const m = /^(\d+)\s+(.+)$/.exec(line);
    if (m) sizes.set(m[2], Number(m[1]) * KIB);
  }
  const total = sizes.get(dir) ?? null;
  return { total, sizes, timedOut: r.timedOut, failed: total == null };
}

async function duSingle(path, timeoutMs) {
  const r = await exec('du', ['-sk', '--', path], { timeoutMs });
  const m = /^(\d+)/.exec(r.stdout);
  return m ? Number(m[1]) * KIB : null;
}

// ---------------------------------------------------------------- default probes

export function realDeps(opts) {
  return {
    now: () => Date.now(),
    df: dfProbe,
    processCwds: processCwdsProbe,
    fetchTasks: () => fetchTasksProbe(process.env, opts.dataDir),
    runningInstalls: runningInstallsProbe,
    dockerInfo: dockerProbe,
    toolCaches: () => toolCachesProbe(opts),
    kookrPrune: (dataDir, o) => kookrPruneProbe(dataDir, o),
    homeReview: () => homeReviewProbe(opts),
    run: (cmd, args, o) => exec(cmd, args, { timeoutMs: 30 * 60_000, ...o }),
    removeDir: (p) => rmSync(p, { recursive: true, force: true }),
  };
}

export async function dfProbe(path) {
  const r = await exec('df', ['-Pk', path]);
  const line = r.stdout.trim().split('\n').pop() ?? '';
  const f = line.trim().split(/\s+/);
  if (f.length < 6 || !/^\d+$/.test(f[1])) throw new Error(`cannot parse df output for ${path}: ${r.stderr || r.stdout}`);
  const total = Number(f[1]) * KIB;
  const free = Number(f[3]) * KIB;
  return { device: f[0], mount: f.slice(5).join(' '), totalBytes: total, freeBytes: free, freePercent: total ? (free / total) * 100 : 0 };
}

export async function processCwdsProbe() {
  if (process.platform === 'linux' && existsSync('/proc/self/cwd')) {
    const paths = [];
    for (const pid of readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        paths.push(readlinkSync(`/proc/${pid}/cwd`));
      } catch {
        // process exited, or owned by another user
      }
    }
    return { ok: true, paths };
  }
  const r = await exec('lsof', ['-d', 'cwd', '-Fn'], { timeoutMs: 60_000 });
  if (r.spawnError || r.timedOut) return { ok: false, paths: [], error: r.spawnError ?? 'lsof timed out' };
  // lsof exits 1 when some processes are unreadable but still prints the rest.
  const paths = r.stdout.split('\n').filter((l) => l.startsWith('n/')).map((l) => l.slice(1));
  return { ok: paths.length > 0, paths, error: paths.length ? undefined : 'lsof returned no cwd entries' };
}

/**
 * The API port must belong to the data dir being cleaned: `~/.kookr` is port
 * 4800, `~/.kookr-<port>` is <port>. Returns { base } or { error } (fail closed).
 */
export function resolveApiBase(env, dataDir) {
  const name = basename(dataDir);
  const implied = name === '.kookr' ? 4800 : /^\.kookr-(\d+)$/.test(name) ? Number(/^\.kookr-(\d+)$/.exec(name)[1]) : null;
  let base = env.KOOKR_API_BASE_URL;
  let port = null;
  if (base) {
    try {
      const u = new URL(base);
      port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    } catch {
      return { error: `KOOKR_API_BASE_URL is not a valid URL: ${base}` };
    }
  } else if (env.KOOKR_PORT && /^\d+$/.test(env.KOOKR_PORT)) {
    port = Number(env.KOOKR_PORT);
    base = `http://127.0.0.1:${port}`;
  } else if (env.KOOKR_PORT) {
    return { error: `KOOKR_PORT=${env.KOOKR_PORT} is not numeric, so the API port cannot be matched to ${dataDir}` };
  } else if (implied != null) {
    port = implied;
    base = `http://127.0.0.1:${port}`;
  } else {
    return { error: `data dir ${dataDir} is not ~/.kookr[-<port>] and no KOOKR_PORT / KOOKR_API_BASE_URL says which instance owns it` };
  }
  if (implied != null && port !== implied) {
    return { error: `API port ${port} does not match data dir ${dataDir} (expects ${implied}); in-use state would come from another instance` };
  }
  return { base };
}

export async function fetchTasksProbe(env, dataDir) {
  const resolved = resolveApiBase(env, dataDir);
  if (resolved.error) return { ok: false, error: resolved.error, tasks: [] };
  const base = resolved.base;
  try {
    const res = await fetch(`${base}/api/tasks`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { ok: false, error: `${base}/api/tasks answered HTTP ${res.status}`, tasks: [] };
    const body = await res.json();
    const list = Array.isArray(body) ? body : body.tasks;
    if (!Array.isArray(list)) return { ok: false, error: 'unexpected /api/tasks payload', tasks: [] };
    return {
      ok: true,
      tasks: list.map((t) => ({
        id: t.id,
        status: t.status,
        cwd: t.cwd,
        sessionCwds: Array.isArray(t.sessions) ? t.sessions.map((x) => x?.cwd).filter(Boolean) : [],
        terminationReason: t.terminationReason,
        terminatedAt: t.terminatedAt,
      })),
    };
  } catch (e) {
    return { ok: false, error: `Kookr API unreachable at ${base}: ${e.message}`, tasks: [] };
  }
}

/** True for a package-manager / installer process (a cache prune could break it). */
const INSTALLER_RE = /^(pnpm|npm|npx|yarn|bun|pip3?|uv)(\.c?js)?$/;
export async function runningInstallsProbe() {
  const r = await exec('ps', ['-Ao', 'pid=,args=']);
  if (r.code !== 0) return { ok: false, procs: [], error: 'ps failed' };
  const procs = [];
  for (const line of r.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m || Number(m[1]) === process.pid) continue;
    const toks = m[2].split(/\s+/);
    if (toks.slice(0, 2).some((t) => INSTALLER_RE.test(basename(t)))) procs.push(m[2].slice(0, 100));
  }
  return { ok: true, procs };
}

const SIZE_UNITS = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12 };
function parseHumanSize(s) {
  const m = /^([\d.]+)\s*([kmgt]?b)/i.exec(String(s).trim());
  return m ? Math.round(Number(m[1]) * SIZE_UNITS[m[2].toLowerCase()]) : 0;
}

export async function dockerProbe() {
  const info = await exec('docker', ['info', '--format', '{{.OperatingSystem}}'], { timeoutMs: 20_000 });
  if (info.code !== 0) return null;
  const os = info.stdout.trim();
  if (/docker desktop/i.test(os)) return { os, desktop: true, reclaimable: [] };
  const df = await exec('docker', ['system', 'df', '--format', '{{json .}}'], { timeoutMs: 60_000 });
  const reclaimable = [];
  for (const line of df.stdout.split('\n').filter(Boolean)) {
    try {
      const row = JSON.parse(line);
      const bytes = parseHumanSize(row.Reclaimable);
      if (bytes > 0) reclaimable.push({ type: row.Type, bytes });
    } catch {
      // ignore unparsable row
    }
  }
  return { os, desktop: false, reclaimable };
}

const TOOL_CACHES = [
  { tool: 'pnpm', dirCmd: ['pnpm', 'store', 'path'], clean: ['pnpm', 'store', 'prune'], estimate: 'upper-bound' },
  { tool: 'npm', dirCmd: ['npm', 'config', 'get', 'cache'], clean: ['npm', 'cache', 'clean', '--force'], estimate: 'exact' },
  { tool: 'uv', dirCmd: ['uv', 'cache', 'dir'], clean: ['uv', 'cache', 'prune'], estimate: 'upper-bound' },
  { tool: 'pip', dirCmd: ['pip', 'cache', 'dir'], clean: ['pip', 'cache', 'purge'], estimate: 'exact' },
];

export async function toolCachesProbe() {
  const out = [];
  for (const t of TOOL_CACHES) {
    const r = await exec(t.dirCmd[0], t.dirCmd.slice(1), { timeoutMs: 20_000 });
    if (r.code !== 0) continue; // tool not installed
    const dir = r.stdout.trim().split('\n').pop();
    if (!dir || !existsSync(dir)) continue;
    const bytes = await duSingle(dir, 300_000);
    if (bytes != null) out.push({ tool: t.tool, dir, bytes, command: t.clean, estimate: t.estimate });
  }
  return out;
}

/** Dry-run `kookr maintenance prune`; `lowered` adds the aggressive age flags. */
export async function kookrPruneProbe(dataDir, { lowered = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'disk-reclaim-'));
  const file = join(dir, 'prune.json');
  const flags = lowered ? PRUNE_FLAGS : [];
  try {
    const fd = openSync(file, 'w');
    const code = await new Promise((done) => {
      const child = spawn('kookr', ['maintenance', 'prune', '--dry-run', '--json', '--dir', dataDir, ...flags], {
        stdio: ['ignore', fd, 'ignore'],
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
      child.on('error', () => done(null));
      child.on('close', (c) => {
        clearTimeout(timer);
        done(c);
      });
    });
    closeSync(fd);
    if (code !== 0) return null;
    const body = JSON.parse(readFileSync(file, 'utf8'));
    const planned = Array.isArray(body.planned) ? body.planned.reduce((n, x) => n + (x.bytes || 0), 0) : 0;
    return { bytes: Number.isFinite(body.reclaimedBytes) && body.reclaimedBytes > 0 ? body.reclaimedBytes : planned, command: ['kookr', 'maintenance', 'prune', '--dir', dataDir, ...flags] };
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Large home-directory items outside the roots. Report-only (REVIEW). */
export async function homeReviewProbe(opts, home = homedir()) {
  const candidates = [join(home, '.ollama')];
  const addChildren = (dir, skip = () => false) => {
    try {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory() && !skip(e.name)) candidates.push(join(dir, e.name));
      }
    } catch {
      // directory absent
    }
  };
  addChildren(join(home, '.cache'), (n) => ['pip', 'uv', 'pnpm'].includes(n));
  addChildren(join(home, '.rustup', 'toolchains'));
  addChildren(join(home, '.local', 'share'), (n) => n === 'pnpm');
  const pathDirs = (process.env.PATH || '').split(':');
  addChildren(join(home, '.nvm', 'versions', 'node'), (n) => {
    const dir = join(home, '.nvm', 'versions', 'node', n);
    return n === process.version || process.execPath.startsWith(dir + sep) || pathDirs.some((p) => under(p, dir));
  });
  const wanted = candidates.filter((p) => existsSync(p) && !opts.roots.some((r) => under(p, r)) && !under(p, opts.dataDir));
  const sized = await pool(wanted, opts.concurrency, async (path) => ({ path, bytes: await duSingle(path, opts.timeoutS * 1000) }));
  return sized.filter((s) => s.bytes != null && s.bytes >= opts.minReviewBytes);
}

// ---------------------------------------------------------------- scanning

/**
 * Inspect one top-level directory. `light` skips `du` (used by the apply-time
 * re-check, which only needs git/activity state).
 */
/**
 * Is it safe to treat this `node_modules` as rebuildable? Needs a nested-`.git`
 * search (no symlink following) that finds nothing and does not time out.
 * Returns null when fine, else a short reason.
 */
async function nodeModulesProblem(abs, timeoutMs) {
  const f = await exec('find', [abs, '-name', '.git', '-print', '-quit'], { timeoutMs });
  if (f.timedOut) return 'nested .git search timed out';
  if (f.code !== 0) return 'nested .git search failed';
  const hit = f.stdout.split('\n').filter(Boolean)[0];
  return hit ? `nested .git at ${hit}` : null;
}

export async function inspectDir(dir, opts, deps, { light = false, fetched = new Map() } = {}) {
  const deadline = deps.now() + opts.timeoutS * 1000;
  const left = () => Math.max(1000, deadline - deps.now());
  const e = {
    path: dir,
    realPath: safeRealpath(dir),
    name: basename(dir),
    sizeBytes: null,
    nodeModulesBytes: 0,
    hasNodeModules: false,
    kind: 'plain',
    branch: null,
    detached: false,
    dirty: false,
    stashCount: 0,
    inRemote: false,
    mergedIntoDefault: false,
    defaultRef: null,
    upstreamGone: false,
    mainRepo: null,
    ignoredEntries: [],
    ignoredBytes: 0,
    hiddenEdits: [],
    locked: false,
    hasPackageJson: false,
    hasLockfile: false,
    nodeModulesTracked: false,
    nodeModulesProblem: null,
    lastActivityMs: null,
    errors: [],
  };

  const nmPath = join(dir, 'node_modules');
  try {
    e.hasNodeModules = lstatSync(nmPath).isDirectory();
  } catch {
    e.hasNodeModules = false;
  }

  const nmMemo = new Map();
  const nmCheck = (abs) => {
    if (!nmMemo.has(abs)) nmMemo.set(abs, nodeModulesProblem(abs, left()));
    return nmMemo.get(abs);
  };
  e.hasPackageJson = existsSync(join(dir, 'package.json'));
  e.hasLockfile = LOCKFILES.some((f) => existsSync(join(dir, f)));

  const duPromise = light ? null : duTop(dir, left());
  const dirMtime = statSync(dir).mtimeMs;
  let activity = dirMtime;

  let gitStat = null;
  try {
    gitStat = lstatSync(join(dir, '.git'));
  } catch {
    gitStat = null;
  }
  if (gitStat) {
    e.kind = gitStat.isFile() ? 'worktree' : 'main';
    await inspectGit(dir, e, opts, deps, left, fetched, nmCheck);
    if (e.lastActivityMs != null) activity = Math.max(activity, e.lastActivityMs);
  }
  e.lastActivityMs = activity;
  if (e.hasNodeModules) e.nodeModulesProblem = await nmCheck(nmPath);

  if (duPromise) {
    const du = await duPromise;
    if (du.failed) e.errors.push(du.timedOut ? 'du timed out' : 'du failed');
    e.sizeBytes = du.total;
    if (e.hasNodeModules) e.nodeModulesBytes = du.sizes.get(nmPath) ?? 0;
  }
  return e;
}

/**
 * Non-LFS filters that apply to tracked files here, as git itself resolves them (committed and
 * nested `.gitattributes`, `info/attributes`, `core.attributesFile`, the default global file under
 * `$XDG_CONFIG_HOME/git` or `~/.config/git`, and the system file), and that git has a `clean` or
 * `process` command for. Returns null when the answer is unknown (then the caller fails closed).
 */
async function configuredCleanFilters(git) {
  const files = await git(['ls-files', '-z']);
  if (files.code !== 0) return null;
  const paths = files.stdout.split('\0').filter(Boolean);
  const names = new Set();
  for (let i = 0; i < paths.length; i += ATTR_CHUNK) {
    const r = await git(['check-attr', '-z', 'filter', '--', ...paths.slice(i, i + ATTR_CHUNK)]);
    if (r.code !== 0) return null;
    const f = r.stdout.split('\0');
    for (let j = 0; j + 2 < f.length; j += 3) {
      const value = f[j + 2];
      if (value && value !== 'unspecified' && value !== 'unset' && value !== 'lfs') names.add(value);
    }
  }
  const out = [];
  for (const name of names) {
    // `set` (a bare `filter` attribute) names no driver; keep it conservative and report it.
    const [clean, proc] = await Promise.all([git(['config', '--get', `filter.${name}.clean`]), git(['config', '--get', `filter.${name}.process`])]);
    if ((clean.code === 0 && clean.stdout.trim()) || (proc.code === 0 && proc.stdout.trim()) || name === 'set') out.push(name);
  }
  return out;
}

async function inspectGit(dir, e, opts, deps, left, fetched, nmCheck) {
  const git = (args) => exec('git', ['-C', dir, ...args], { timeoutMs: left() });
  const bail = (r, what) => {
    if (r.timedOut) e.errors.push(`git ${what} timed out`);
    return r.timedOut;
  };

  const common = await git(['rev-parse', '--git-common-dir']);
  if (common.code !== 0) {
    e.errors.push('not a usable git checkout');
    return;
  }
  const commonDir = resolve(dir, common.stdout.trim());
  if (basename(commonDir) === '.git') e.mainRepo = dirname(commonDir);

  if (opts.fetch) {
    if (!fetched.has(commonDir)) fetched.set(commonDir, git(['fetch', '--prune', '--quiet']));
    const f = await fetched.get(commonDir);
    if (f.code !== 0) e.errors.push('git fetch failed');
  }

  const [idx, ct, br, status, stash, remotes, symref, track, ignored, lsv, gitDir, nmTracked] = await Promise.all([
    git(['rev-parse', '--git-path', 'index']),
    git(['log', '-1', '--format=%ct']),
    git(['symbolic-ref', '--short', '-q', 'HEAD']),
    git(['status', '--porcelain', '--untracked-files=normal']),
    git(['stash', 'list', '--format=%gs']),
    git(['branch', '-r', '--contains', 'HEAD']),
    git(['symbolic-ref', '-q', 'refs/remotes/origin/HEAD']),
    git(['for-each-ref', '--format=%(refname)\t%(upstream:track)', 'refs/heads/']),
    e.kind === 'worktree' ? git(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory']) : Promise.resolve(null),
    e.kind === 'worktree' ? git(['ls-files', '-v']) : Promise.resolve(null),
    e.kind === 'worktree' ? git(['rev-parse', '--git-dir']) : Promise.resolve(null),
    e.hasNodeModules ? git(['ls-files', '--', 'node_modules']) : Promise.resolve(null),
  ]);
  e.nodeModulesTracked = Boolean(nmTracked && (nmTracked.code !== 0 || nmTracked.stdout.trim()));
  if (gitDir && gitDir.code === 0) e.locked = existsSync(join(resolve(dir, gitDir.stdout.trim()), 'locked'));
  if (lsv) {
    // Lowercase tags (assume-unchanged) and `S` (skip-worktree) hide edits from `git status` and from git's remove check.
    if (lsv.code !== 0) e.errors.push('git ls-files -v failed');
    else e.hiddenEdits = lsv.stdout.split('\n').filter((l) => l && (/^[a-z]/.test(l) || l[0] === 'S')).map((l) => l.slice(2));
  }
  if (e.kind === 'worktree' && gitDir && gitDir.code !== 0) e.errors.push(gitDir.timedOut ? 'git rev-parse --git-dir timed out' : 'git rev-parse --git-dir failed');
  if (e.kind === 'worktree' && gitDir && gitDir.code === 0) {
    const wtGitDir = resolve(dir, gitDir.stdout.trim());
    // An operation in progress holds state (todo lists, conflict resolutions) that removal discards.
    e.pendingOps = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG']
      .filter((f) => existsSync(join(wtGitDir, f)));
    // Commits kept alive only by this worktree's own reflogs (HEAD, its branch), ORIG_HEAD or
    // per-worktree refs die with it: after `reset --hard` or leaving a detached HEAD they are on
    // no branch, and `git gc` deletes them once removal drops the reflogs. Count any commit
    // those point at that no surviving branch, tag or remote-tracking ref contains.
    const lines = (r) => (r.code === 0 ? r.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : []);
    const branchName = br.code === 0 ? br.stdout.trim() || null : null;
    const [headLog, branchLog, orig, wtRefs] = await Promise.all([
      git(['log', '-g', '--format=%H', 'HEAD', '--']),
      // e.branch is assigned further down; read the branch from the symbolic-ref result here.
      branchName ? git(['log', '-g', '--format=%H', `refs/heads/${branchName}`, '--']) : Promise.resolve({ code: 0, stdout: '' }),
      git(['rev-parse', '-q', '--verify', 'ORIG_HEAD^{commit}']),
      git(['for-each-ref', '--format=%(objectname)', 'refs/worktree/', 'refs/bisect/']),
    ]);
    // Fail closed: if a reflog cannot be read, the commits it protects cannot be checked.
    if (headLog.code !== 0) e.errors.push(headLog.timedOut ? 'git reflog timed out' : 'git reflog (HEAD) unreadable');
    if (branchLog.code !== 0) e.errors.push(branchLog.timedOut ? 'git reflog timed out' : 'git reflog (branch) unreadable');
    const tips = [...new Set([...lines(headLog), ...lines(branchLog), ...lines(orig), ...lines(wtRefs)])];
    if (tips.length > REFLOG_TIP_LIMIT) e.reflogOnlyCommits = -1; // too many to check: treat as unknown
    else if (tips.length) {
      const r = await git(['rev-list', ...tips, '--not', '--branches', '--tags', '--remotes']);
      if (r.code !== 0) e.errors.push(r.timedOut ? 'git rev-list timed out' : 'git rev-list (reflog check) failed');
      else e.reflogOnlyCommits = lines(r).length;
    }
    // A clean filter (nbstripout-style) makes `git status` and git's own remove check compare the
    // FILTERED file, so working-copy-only content (notebook outputs, results) looks clean. Any
    // non-LFS filter that is both declared in an attributes file and configured with a clean
    // command makes the worktree not SAFE.
    const filters = await configuredCleanFilters(git);
    if (filters === null) e.errors.push('could not resolve git filter attributes');
    else e.cleanFilters = filters;
  }
  if (ignored) {
    if (ignored.code !== 0) e.errors.push(ignored.timedOut ? 'git ls-files timed out' : 'git ls-files failed');
    else {
      const raw = [];
      for (const entry of ignored.stdout.split('\n').filter(Boolean)) {
        const kind = classifyIgnoredEntry(entry);
        if (kind === 'cache') {
          // A tool cache is disposable only if nobody put a git repo inside it.
          const why = await nmCheck(join(dir, entry));
          if (!why) continue;
          raw.push(entry);
          e.ignoredEntries.push(`${entry} (${why})`);
          continue;
        }
        if (kind === 'content') {
          raw.push(entry);
          e.ignoredEntries.push(entry);
          continue;
        }
        const parent = join(dir, dirname(entry.replace(/\/$/, '')));
        let why = null;
        if (!existsSync(join(parent, 'package.json'))) why = 'no package.json beside it';
        else if (!LOCKFILES.some((f) => existsSync(join(parent, f)))) why = 'no lockfile beside it';
        else why = await nmCheck(join(dir, entry));
        if (why) {
          raw.push(entry);
          e.ignoredEntries.push(`${entry} (${why})`);
        }
      }
      if (raw.length) {
        const du = await exec('du', ['-sk', '--', ...raw.slice(0, 200).map((x) => `./${x}`)], { cwd: dir, timeoutMs: left() });
        e.ignoredBytes = du.stdout.split('\n').reduce((n, l) => n + (/^(\d+)/.test(l) ? Number(/^(\d+)/.exec(l)[1]) * KIB : 0), 0);
      }
    }
  }
  for (const [r, w] of [[status, 'status'], [stash, 'stash'], [remotes, 'branch -r']]) bail(r, w);

  if (idx.code === 0) {
    try {
      e.lastActivityMs = Math.max(e.lastActivityMs ?? 0, statSync(resolve(dir, idx.stdout.trim())).mtimeMs);
    } catch {
      // unborn index
    }
  }
  if (ct.code === 0 && /^\d+$/.test(ct.stdout.trim())) {
    e.lastActivityMs = Math.max(e.lastActivityMs ?? 0, Number(ct.stdout.trim()) * 1000);
  }
  e.branch = br.code === 0 ? br.stdout.trim() || null : null;
  e.detached = e.branch == null;

  if (status.code === 0) {
    const lines = status.stdout.split('\n').filter(Boolean);
    // A linked worktree is removed whole, so ANY untracked path is content, node_modules
    // included: an untracked (not ignored) node_modules never went through the manifest,
    // lockfile and nested-.git checks. In a main checkout only untracked node_modules
    // entries are ignorable (they are handled by the dependencies item's own checks).
    e.dirty = e.kind === 'worktree'
      ? lines.length > 0
      : lines.some((l) => !(l.startsWith('?? ') && /(^|\/)node_modules(\/|$)/.test(l.slice(3))));
  } else if (!status.timedOut) e.errors.push('git status failed');

  if (stash.code === 0) {
    const entries = stash.stdout.split('\n').filter(Boolean);
    // refs/stash is shared by every worktree of a repo; attribute entries by branch name.
    const mine = (s) => (e.branch ? new RegExp(`^(WIP on |On )${e.branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`).test(s) : /^(WIP on |On )\(no branch\)/.test(s));
    e.stashCount = e.kind === 'main' ? entries.length : entries.filter(mine).length;
  }

  e.inRemote = remotes.code === 0 && remotes.stdout.split('\n').some((l) => l.trim() && !l.includes('->'));

  let defaultRef = symref.code === 0 ? symref.stdout.trim() : null;
  if (!defaultRef) {
    for (const cand of ['refs/remotes/origin/main', 'refs/remotes/origin/master']) {
      if ((await git(['rev-parse', '--verify', '-q', cand])).code === 0) {
        defaultRef = cand;
        break;
      }
    }
  }
  if (defaultRef) {
    e.defaultRef = defaultRef.replace('refs/remotes/', '');
    e.mergedIntoDefault = (await git(['merge-base', '--is-ancestor', 'HEAD', defaultRef])).code === 0;
  }

  if (e.branch && track.code === 0) {
    const row = track.stdout.split('\n').find((l) => l.startsWith(`refs/heads/${e.branch}\t`));
    e.upstreamGone = Boolean(row) && row.split('\t')[1] === '[gone]'; // exact field, not a substring of the branch name
  }
}

// ---------------------------------------------------------------- classification

/** A task is live if it is non-terminal, or was killed for a reason crash recovery will relaunch. */
export function isLiveTask(t, nowMs) {
  if (!TERMINAL_STATUSES.has(t.status)) return true;
  if (t.status !== 'terminated' || !RECOVERABLE_TERMINATION.has(t.terminationReason)) return false;
  const at = Date.parse(t.terminatedAt ?? '');
  return Number.isNaN(at) || nowMs - at < RECOVERY_WINDOW_MS;
}

/**
 * In-use lookup. A live task occupies its `cwd` AND every session `cwd`
 * (tasks create sibling worktrees while `task.cwd` stays the main checkout).
 */
export function buildUsage(procs, tasksResult, nowMs = Date.now(), installs = { ok: true, procs: [] }) {
  const live = tasksResult.ok ? tasksResult.tasks.filter((t) => isLiveTask(t, nowMs)) : [];
  const taskCwds = live.flatMap((t) => [t.cwd, ...(t.sessionCwds ?? [])].filter(Boolean).map((c) => ({ id: t.id, cwd: safeRealpath(c) })));
  const repoRootMemo = new Map();
  const isRepoRoot = (c) => {
    if (!repoRootMemo.has(c)) repoRootMemo.set(c, existsSync(join(c, '.git')));
    return repoRootMemo.get(c);
  };
  return {
    procsOk: procs.ok,
    tasksOk: tasksResult.ok,
    tasksError: tasksResult.error,
    unknown: !procs.ok || !tasksResult.ok,
    liveTaskCount: live.length,
    installers: installs.ok ? installs.procs : null,
    inUse(realPath) {
      const by = [];
      // A cwd that is an ANCESTOR counts only when it is a repo/worktree root, not a container like ~/git.
      const covers = (c) => under(c, realPath) || (under(realPath, c) && isRepoRoot(c));
      const proc = procs.paths.find(covers);
      if (proc) by.push(`process cwd ${proc}`);
      const task = taskCwds.find((t) => covers(t.cwd));
      if (task) by.push(`task ${task.id}`);
      if (by.length) return { state: 'yes', detail: by.join(', ') };
      if (!procs.ok || !tasksResult.ok) return { state: 'unknown', detail: tasksResult.ok ? 'process probe failed' : tasksResult.error ?? 'Kookr API unreachable' };
      return { state: 'no', detail: '' };
    },
    /** Why a shared package cache must not be pruned right now, or null. */
    cacheBlocker() {
      if (!procs.ok || !tasksResult.ok) return `in-use state unknown (${!tasksResult.ok ? tasksResult.error : 'process probe failed'})`;
      if (live.length) return `${live.length} live Kookr task(s) may be installing`;
      if (installs.ok === false) return 'cannot list running processes to rule out a live install';
      if (installs.procs.length) return `package manager running: ${installs.procs[0]}`;
      return null;
    },
  };
}

/** Turn one scanned directory into zero or more SAFE/REVIEW items. */
export function classifyEntry(e, opts, usage, nowMs) {
  const idleDays = (nowMs - e.lastActivityMs) / DAY_MS;
  const idleOk = idleDays >= opts.minIdleDays;
  const use = usage.inUse(e.realPath);
  const items = [];
  const size = e.sizeBytes ?? 0;
  const base = { path: e.path, idleDays: Math.round(idleDays * 10) / 10 };

  const blockers = [];
  if (e.errors.length) blockers.push(`scan incomplete (${e.errors.join('; ')})`);
  if (use.state === 'yes') blockers.push(`in use (${use.detail})`);
  else if (use.state === 'unknown') blockers.push(`in-use status unknown (${use.detail})`);
  if (!idleOk) blockers.push(`active ${idleDays.toFixed(1)}d ago (< ${opts.minIdleDays}d idle)`);

  // SAFE: whole finished worktree.
  const why = [];
  if (e.kind === 'worktree') {
    const wt = [...blockers];
    if (e.dirty) wt.push('uncommitted changes');
    if (e.locked) wt.push('worktree is locked');
    if (e.hiddenEdits.length) wt.push(`edits hidden by skip-worktree/assume-unchanged: ${e.hiddenEdits.slice(0, 3).join(', ')}`);
    if (e.pendingOps?.length) wt.push(`git operation in progress: ${e.pendingOps.join(', ')}`);
    if (e.cleanFilters?.length) wt.push(`clean filter configured (${e.cleanFilters.join(', ')}): working files may hold content git status does not show`);
    if (e.reflogOnlyCommits === -1) wt.push('reflog too long to check for commits on no branch');
    else if (e.reflogOnlyCommits > 0) wt.push(`${e.reflogOnlyCommits} commit${e.reflogOnlyCommits === 1 ? '' : 's'} only in this worktree's reflog or ORIG_HEAD (on no branch, tag or remote; e.g. after reset or rebase)`);
    if (e.ignoredEntries.length) {
      const shown = e.ignoredEntries.slice(0, 3).join(', ');
      const more = e.ignoredEntries.length > 3 ? ` (+${e.ignoredEntries.length - 3} more)` : '';
      wt.push(`holds ignored files that would be deleted: ${shown}${more}, ${fmtBytes(e.ignoredBytes)}`);
    }
    if (e.stashCount > 0) wt.push(`${e.stashCount} stash entr${e.stashCount === 1 ? 'y' : 'ies'}`);
    let mergedReason = null;
    if (e.mergedIntoDefault) mergedReason = `HEAD merged into ${e.defaultRef}`;
    else if (e.upstreamGone && !e.detached) mergedReason = 'upstream branch gone (merged or deleted on the remote); local branch is kept unless merged';
    else wt.push(e.inRemote ? 'pushed but not merged' : 'unpushed commits');
    if (!e.mainRepo) wt.push('main repository not locatable');
    if (!wt.length && size >= opts.minSafeBytes) {
      return [{ ...base, tier: 'SAFE', kind: 'worktree', bytes: size, reason: `finished worktree: clean, no stash, ${mergedReason}`, branch: e.branch, mainRepo: e.mainRepo }];
    }
    why.push(...wt);
  } else if (e.kind === 'plain') why.push('not a git checkout');
  else why.push('main checkout');

  // SAFE: dependencies in any checkout that is not removed whole.
  const depsBlockers = [...blockers];
  if (e.hasNodeModules) {
    if (!e.hasPackageJson) depsBlockers.push('no package.json beside node_modules');
    if (!e.hasLockfile) depsBlockers.push('no lockfile beside node_modules (cannot rebuild reproducibly)');
    if (e.nodeModulesTracked) depsBlockers.push('node_modules is tracked by git');
    if (e.nodeModulesProblem) depsBlockers.push(`node_modules: ${e.nodeModulesProblem}`);
    if (e.kind === 'worktree' && e.locked) depsBlockers.push('worktree is locked');
  }
  if (e.hasNodeModules && e.nodeModulesBytes >= opts.minSafeBytes && depsBlockers.length > blockers.length) {
    why.push(`node_modules kept: ${depsBlockers.slice(blockers.length).join('; ')}`);
  }
  let depsSafe = false;
  if (e.hasNodeModules && !depsBlockers.length && e.nodeModulesBytes >= opts.minSafeBytes) {
    depsSafe = true;
    items.push({
      ...base,
      tier: 'SAFE',
      kind: 'dependencies',
      path: join(e.path, 'node_modules'),
      checkoutPath: e.path,
      bytes: e.nodeModulesBytes,
      reason: 'node_modules is rebuildable (pnpm install / npm ci) and the checkout is idle and unused',
    });
  }
  items.push(...reviewFor(e, base, size - (depsSafe ? e.nodeModulesBytes : 0), why, opts));
  return items;
}

function reviewFor(e, base, bytes, reasons, opts) {
  if (bytes < opts.minReviewBytes) return [];
  return [{ ...base, tier: 'REVIEW', kind: e.kind === 'worktree' ? 'worktree' : e.kind === 'main' ? 'checkout' : 'directory', bytes, branch: e.branch, reason: reasons.join('; ') || 'large; no automatic rule applies' }];
}

// ---------------------------------------------------------------- report

export async function buildReport(opts, deps) {
  const now = deps.now();
  const dataFs = await deps.df(opts.dataDir);
  let dataDev = null;
  try {
    dataDev = statSync(opts.dataDir).dev;
  } catch {
    dataDev = null;
  }
  const sameFs = (p) => {
    try {
      return dataDev != null && statSync(p).dev === dataDev;
    } catch {
      return false;
    }
  };

  const [procs, tasks, docker, installs] = await Promise.all([
    deps.processCwds().catch((err) => ({ ok: false, paths: [], error: err.message })),
    deps.fetchTasks(),
    deps.dockerInfo().catch(() => null),
    deps.runningInstalls().catch(() => ({ ok: false, procs: [] })),
  ]);
  const usage = buildUsage(procs, tasks, now, installs);

  const rootsInfo = [];
  const dirs = [];
  for (const root of opts.roots) {
    const info = { path: root, sharesDataDirFilesystem: sameFs(root), exists: existsSync(root) };
    rootsInfo.push(info);
    if (!info.exists) continue;
    for (const d of readdirSync(root, { withFileTypes: true })) {
      if (d.isDirectory() && !d.isSymbolicLink()) dirs.push({ path: join(root, d.name), sameFs: sameFs(join(root, d.name)) });
    }
  }

  const fetched = new Map();
  const scanErrors = [];
  const entries = await pool(dirs, opts.concurrency, async (d) => {
    try {
      const entry = await inspectDir(d.path, opts, deps, { fetched });
      entry.sameFs = d.sameFs;
      return entry;
    } catch (err) {
      scanErrors.push({ path: d.path, error: err.message });
      return null;
    }
  });

  let items = [];
  for (const entry of entries.filter(Boolean)) {
    for (const it of classifyEntry(entry, opts, usage, now)) items.push({ ...it, sameFs: entry.sameFs });
  }

  const [caches, prune, pruneLow, home] = await Promise.all([
    deps.toolCaches().catch(() => []),
    deps.kookrPrune(opts.dataDir, { lowered: false }).catch(() => null),
    deps.kookrPrune(opts.dataDir, { lowered: true }).catch(() => null),
    deps.homeReview().catch(() => []),
  ]);
  for (const c of caches) {
    const blocker = usage.cacheBlocker();
    items.push({
      tier: blocker ? 'REVIEW' : 'SAFE', kind: 'tool-cache', path: c.dir, bytes: c.bytes, sameFs: sameFs(c.dir), tool: c.tool, command: c.command, estimate: c.estimate,
      reason: `${c.tool} cache, re-downloaded on demand${c.estimate === 'upper-bound' ? ' (size is an upper bound; the tool prunes only unreferenced entries)' : ''}${blocker ? `; not SAFE now: ${blocker}` : ''}`,
    });
  }
  if (prune && prune.bytes > 0) {
    items.push({
      tier: usage.unknown ? 'REVIEW' : 'SAFE', kind: 'kookr-data', path: opts.dataDir, bytes: prune.bytes, sameFs: true, command: prune.command,
      reason: `aged Kookr artifacts via \`kookr maintenance prune\` with the default ages${usage.unknown ? '; not SAFE now: in-use state unknown' : ''}`,
    });
  }
  if (pruneLow && pruneLow.bytes > (prune?.bytes ?? 0)) {
    items.push({
      tier: 'REVIEW', kind: 'kookr-data-aggressive', path: opts.dataDir, bytes: pruneLow.bytes - (prune?.bytes ?? 0), sameFs: true, command: pruneLow.command,
      reason: `lowered-age prune also deletes finished-task history (up to ~29 days) that the default policy keeps; run: ${pruneLow.command.join(' ')}`,
    });
  }
  for (const h of home) {
    items.push({ tier: 'REVIEW', kind: 'home-directory', path: h.path, bytes: h.bytes, sameFs: sameFs(h.path), reason: 'large directory outside the roots; owned by another tool' });
  }
  if (docker && !docker.desktop) {
    for (const r of docker.reclaimable) {
      items.push({ tier: 'REVIEW', kind: 'docker', path: `docker:${r.type}`, bytes: r.bytes, sameFs: true, reason: `docker system df reclaimable (${r.type}); not pruned automatically` });
    }
  }

  items.sort((a, b) => b.bytes - a.bytes);
  const counted = items.filter((i) => i.sameFs);
  const safe = counted.filter((i) => i.tier === 'SAFE');
  const review = counted.filter((i) => i.tier === 'REVIEW');
  const byKind = {};
  for (const i of safe) byKind[i.kind] = (byKind[i.kind] ?? 0) + i.bytes;

  return {
    generatedAt: new Date(now).toISOString(),
    options: { roots: opts.roots, dataDir: opts.dataDir, minIdleDays: opts.minIdleDays, untilFreePercent: opts.untilFreePercent },
    filesystem: { ...dataFs, dataDir: opts.dataDir, floors: floors(), critical: isCritical(dataFs), roots: rootsInfo },
    inUseProbes: {
      liveTasks: usage.liveTaskCount, processes: procs.ok ? 'ok' : `failed: ${procs.error ?? 'unknown'}`, kookrTasks: tasks.ok ? `ok (${tasks.tasks.length} tasks)` : `failed: ${tasks.error}` },
    docker: docker ? { os: docker.os, desktop: docker.desktop, note: docker.desktop ? 'Docker Desktop keeps images and volumes in its own VM disk; docker prune does NOT free this Linux filesystem.' : undefined } : null,
    totals: { safeBytes: safe.reduce((s, i) => s + i.bytes, 0), safeByKind: byKind, reviewBytes: review.reduce((s, i) => s + i.bytes, 0) },
    safe,
    review,
    otherFilesystem: items.filter((i) => !i.sameFs),
    never: [opts.dataDir + ' (only via `kookr maintenance prune`)', '~/.ssh', '~/.config', 'everything outside the roots except the cache tools'],
    scanErrors,
    scanned: dirs.length,
  };
}

function floors(env = process.env) {
  const pct = Number(env.KOOKR_ADMISSION_DATA_DIR_FREE_PERCENT ?? env.KOOKR_ALERT_DATA_DIR_FREE_PERCENT ?? DEFAULT_FLOOR_PERCENT);
  const bytes = Number(env.KOOKR_ADMISSION_DATA_DIR_FREE_BYTES ?? env.KOOKR_ALERT_DATA_DIR_FREE_BYTES ?? DEFAULT_FLOOR_BYTES);
  return { percent: pct, bytes };
}

function isCritical(fs) {
  const f = floors();
  return (f.percent > 0 && fs.freePercent <= f.percent) || (f.bytes > 0 && fs.freeBytes <= f.bytes);
}

// ---------------------------------------------------------------- apply

/**
 * Perform the SAFE actions, biggest first (tool caches last: pnpm's store only
 * shrinks after dependency removal drops its hard links). Every item is
 * re-verified immediately before acting.
 */
export async function applySafe(report, opts, deps) {
  const logFile = join(opts.dataDir, 'disk-reclaim.log');
  const phase = (i) => (i.kind === 'tool-cache' ? 1 : 0);
  const queue = [...report.safe].sort((a, b) => phase(a) - phase(b) || b.bytes - a.bytes);
  const before = await deps.df(opts.dataDir);
  const freedByTier = {};
  const actions = [];
  let current = before;

  const audit = (line) => appendFileSync(logFile, `${JSON.stringify(line)}\n`);

  for (const item of queue) {
    if (current.freePercent >= opts.untilFreePercent) break;
    const log = { phase: 'outcome', ts: new Date(deps.now()).toISOString(), path: item.path, tier: item.tier, kind: item.kind, bytes: item.bytes, command: null, ok: false };
    const freeBefore = current.freeBytes;
    let verdict = null;
    try {
      if (item.tier !== 'SAFE') throw new Error('refusing: item is not tier SAFE');
      verdict = await recheck(item, opts, deps);
      if (verdict) log.error = `skipped: ${verdict}`;
    } catch (err) {
      verdict = err.message;
      log.error = err.message;
    }
    if (!verdict) {
      // Write-ahead audit: if the intent cannot be recorded (disk full, no inodes), delete nothing more.
      try {
        audit({ phase: 'intent', ts: log.ts, path: item.path, tier: item.tier, kind: item.kind, bytes: item.bytes, command: describeCommand(item) });
      } catch (err) {
        throw new Error(`cannot write the audit log ${logFile} (${err.message}); aborting before acting on ${item.path}`);
      }
      try {
        await execute(item, log, opts, deps);
        log.ok = true;
      } catch (err) {
        log.ok = false;
        log.error = err.message;
      }
    }
    current = await deps.df(opts.dataDir);
    log.freeDeltaBytes = current.freeBytes - freeBefore;
    if (log.ok) freedByTier[item.kind] = (freedByTier[item.kind] ?? 0) + item.bytes;
    actions.push(log);
    try {
      audit(log);
    } catch (err) {
      log.auditError = err.message; // the action already happened; the next intent write will abort if the log is still broken
    }
  }
  return { before, after: current, freedByKind: freedByTier, actions, logFile };
}

/** Returns a reason string if the item must NOT be acted on, else null. */
async function recheck(item, opts, deps) {
  const [procs, tasks, installs] = await Promise.all([
    deps.processCwds().catch((err) => ({ ok: false, paths: [], error: err.message })),
    deps.fetchTasks(),
    deps.runningInstalls().catch(() => ({ ok: false, procs: [] })),
  ]);
  const usage = buildUsage(procs, tasks, deps.now(), installs);
  if (item.kind === 'tool-cache') {
    const blocker = usage.cacheBlocker();
    return blocker ? `not SAFE now: ${blocker}` : null;
  }
  if (item.kind === 'kookr-data') return usage.unknown ? 'in-use state unknown' : null;
  const dir = item.kind === 'dependencies' ? item.checkoutPath : item.path;
  if (!opts.roots.some((r) => under(safeRealpath(dir), safeRealpath(r)) && dirname(resolve(dir)) === resolve(r))) return 'path is not a direct child of a scanned root';
  const fresh = await inspectDir(dir, opts, deps, { light: true });
  // Light inspection has no size: carry the scan-time sizes so thresholds still hold.
  fresh.sizeBytes = item.bytes;
  fresh.nodeModulesBytes = item.kind === 'dependencies' ? item.bytes : 0;
  const again = classifyEntry(fresh, opts, usage, deps.now()).find((i) => i.tier === 'SAFE' && i.kind === item.kind && i.path === item.path);
  if (again) return null;
  const why = classifyEntry(fresh, opts, usage, deps.now()).map((i) => i.reason).join('; ');
  return `no longer SAFE (${why || 'state changed'})`;
}

/** The command an item will run, for the write-ahead audit line. */
function describeCommand(item) {
  if (item.kind === 'worktree') {
    return `git -c status.showUntrackedFiles=normal -C ${item.mainRepo} worktree remove ${item.path}${item.branch ? ` && git -C ${item.mainRepo} branch -d ${item.branch}` : ''}`;
  }
  if (item.kind === 'dependencies') return `rm -rf ${item.path}`;
  return Array.isArray(item.command) ? item.command.join(' ') : String(item.kind);
}

async function execute(item, log, opts, deps) {
  if (item.kind === 'worktree') {
    if (!item.mainRepo) throw new Error("refusing: main repository unknown");
    // No --force: git refuses dirty or locked trees. Force untracked files to be shown so a
    // repo with status.showUntrackedFiles=no cannot switch that refusal off.
    const wtArgs = ['-c', 'status.showUntrackedFiles=normal', '-C', item.mainRepo, 'worktree', 'remove', item.path];
    log.command = ['git', ...wtArgs].join(' ');
    const r = await deps.run('git', wtArgs);
    if (r.code !== 0) throw new Error(`git worktree remove failed: ${r.stderr.trim() || r.stdout.trim()}`);
    if (item.branch) {
      const brArgs = ['-C', item.mainRepo, 'branch', '-d', item.branch]; // never -D
      log.command += ` && git ${brArgs.join(' ')}`;
      const b = await deps.run('git', brArgs);
      if (b.code !== 0) log.note = `branch kept (not merged locally): ${b.stderr.trim()}`;
    }
  } else if (item.kind === 'dependencies') {
    if (basename(item.path) !== 'node_modules' || lstatSync(item.path).isSymbolicLink()) throw new Error('refusing: not a plain node_modules directory');
    log.command = `rm -rf ${item.path}`;
    deps.removeDir(item.path);
  } else if (item.kind === 'tool-cache' || item.kind === 'kookr-data') {
    const [cmd, ...args] = item.command;
    log.command = item.command.join(' ');
    const r = await deps.run(cmd, args);
    if (r.code !== 0) throw new Error(`${cmd} failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  } else {
    throw new Error(`no apply action for kind ${item.kind}`);
  }
}

// ---------------------------------------------------------------- rendering

export function renderHuman(report, opts, applied) {
  const L = [];
  const fs = report.filesystem;
  L.push('== Filesystem ==');
  L.push(`Data dir ${fs.dataDir} on ${fs.device} (${fs.mount}): ${fmtBytes(fs.freeBytes)} free of ${fmtBytes(fs.totalBytes)} (${fs.freePercent.toFixed(1)}% free)`);
  L.push(`Kookr refuses launches at <= ${fs.floors.percent || 'off'}% or <= ${fmtBytes(fs.floors.bytes)} free: ${fs.critical ? 'CRITICAL (launches are refused now)' : 'ok'}`);
  for (const r of fs.roots) L.push(`Root ${r.path}: ${!r.exists ? 'missing' : r.sharesDataDirFilesystem ? 'same filesystem as the data dir' : 'DIFFERENT filesystem; freeing it does not help the data dir'}`);
  L.push(`In-use probes: processes ${report.inUseProbes.processes}; Kookr tasks ${report.inUseProbes.kookrTasks}`);
  if (report.inUseProbes.kookrTasks.startsWith('failed')) L.push('  => in-use state is unknown, so every checkout is treated as possibly in use (nothing is SAFE).');
  if (report.docker?.note) L.push(`Docker: ${report.docker.os}. ${report.docker.note}`);
  L.push('');
  L.push('== Totals (same-filesystem items only) ==');
  const kinds = Object.entries(report.totals.safeByKind).map(([k, v]) => `${k} ${fmtBytes(v)}`).join(', ');
  L.push(`SAFE   ${fmtBytes(report.totals.safeBytes)}${kinds ? ` (${kinds})` : ''}`);
  L.push(`REVIEW ${fmtBytes(report.totals.reviewBytes)} (never deleted by this script)`);
  L.push(`Scanned ${report.scanned} directories; ${report.scanErrors.length} scan failures.`);
  L.push('');
  const table = (title, rows) => {
    L.push(`== ${title} ==`);
    if (!rows.length) L.push('(none)');
    for (const i of rows.slice(0, opts.top)) {
      L.push(`${fmtBytes(i.bytes).padStart(9)}  ${i.kind.padEnd(12)} ${i.path}`);
      L.push(`           ${i.reason}${i.idleDays != null ? ` [idle ${i.idleDays}d]` : ''}`);
    }
    if (rows.length > opts.top) L.push(`... ${rows.length - opts.top} more (raise --top, or use --json)`);
    L.push('');
  };
  table(`Top SAFE candidates (${report.safe.length})`, report.safe);
  table(`Top REVIEW candidates (${report.review.length})`, report.review);
  if (report.otherFilesystem.length) L.push(`${report.otherFilesystem.length} candidates are on another filesystem and are excluded from totals and --apply.`, '');
  if (applied) {
    L.push('== Applied ==');
    L.push(`Free before ${fmtBytes(applied.before.freeBytes)} (${applied.before.freePercent.toFixed(1)}%), after ${fmtBytes(applied.after.freeBytes)} (${applied.after.freePercent.toFixed(1)}%), net ${fmtBytes(applied.after.freeBytes - applied.before.freeBytes)}`);
    for (const [k, v] of Object.entries(applied.freedByKind)) L.push(`  ${k}: ~${fmtBytes(v)} (estimated by size)`);
    const bad = applied.actions.filter((a) => !a.ok);
    L.push(`${applied.actions.length - bad.length} actions ok, ${bad.length} skipped or failed. Audit log: ${applied.logFile}`);
    for (const a of bad) L.push(`  ${a.path}: ${a.error}`);
  } else {
    L.push('Report mode: nothing was deleted. Re-run with --apply safe to reclaim the SAFE tier.');
  }
  return L.join('\n');
}

// ---------------------------------------------------------------- main

export async function main(argv, depsOverride = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`${err.message}\n${usage}`);
    return 2;
  }
  if (opts.help) {
    console.log(usage);
    return 0;
  }
  const deps = { ...realDeps(opts), ...depsOverride };
  const report = await buildReport(opts, deps);
  const applied = opts.apply ? await applySafe(report, opts, deps) : null;
  if (opts.json) process.stdout.write(`${JSON.stringify({ ...report, applied }, null, 2)}\n`);
  else console.log(renderHuman(report, opts, applied));
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code; // not process.exit(): it can truncate large piped output
    },
    (err) => {
      console.error(err.stack || String(err));
      process.exit(1);
    },
  );
}
