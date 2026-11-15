#!/usr/bin/env node
// Integration train CLI (issue #3788). Decision logic lives in
// scripts/lib/integration-train-core.ts; this file only wires real
// dependencies (git, pnpm, gh, kookr) and manages the process lifecycle.
// See docs/reference/integration-train.md.

import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync,
  linkSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { cpus, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gitExecEnv } from '../src/core/git-helpers.js';
import {
  type ClosingIssue,
  type GitResult,
  type TrainDeps,
  type TrainEventKind,
  type TrainState,
  type VerifyResult,
  emptyTrainState,
  normalizeTrainState,
  runTrainCycle,
  tailForComment,
} from './lib/integration-train-core.js';

const execFileAsync = promisify(execFile);

interface Options {
  command: string;
  intervalSec: number;
  worktree: string | null;
  verifyCmd: string;
  workers: number;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    command: argv[0] ?? 'status',
    intervalSec: 60,
    worktree: null,
    verifyCmd: 'pnpm verify',
    workers: Math.max(4, cpus().length - 4),
  };
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    if (flag === '--interval') opts.intervalSec = Math.max(1, Number(next()) || 60);
    else if (flag === '--worktree') opts.worktree = resolve(next());
    else if (flag === '--verify-cmd') opts.verifyCmd = next();
    else if (flag === '--workers') opts.workers = Math.max(1, Number(next()) || opts.workers);
    else throw new Error(`unknown option ${flag}`);
  }
  return opts;
}

function stateDir(): string {
  return join(process.env.KOOKR_DIR ?? join(homedir(), '.kookr'), 'integration-train');
}

function paths(dir: string) {
  return {
    state: join(dir, 'state.json'),
    log: join(dir, 'train.log'),
    pid: join(dir, 'train.pid'),
    lock: join(dir, 'train.lock'),
    events: join(dir, 'events.jsonl'),
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(file: string): number | null {
  try {
    const n = Number(readFileSync(file, 'utf8').trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Single-instance lock. Returns a release function, or null when another live
 * process holds it.
 *
 * The lock file is created by hard-linking a temp file that already contains
 * our pid, so it never exists empty: a second process can not mistake a lock
 * that is still being written for a stale one. A lock whose pid is dead is
 * removed only if it still names that same dead pid when re-read just before
 * the unlink, which keeps a slow cleaner from deleting a lock a faster one has
 * just taken.
 */
function acquireLock(lockPath: string): (() => void) | null {
  const tmp = `${lockPath}.${process.pid}.tmp`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(tmp, String(process.pid));
      try {
        linkSync(tmp, lockPath); // atomic; throws EEXIST when the lock is held
      } finally {
        try { unlinkSync(tmp); } catch { /* already gone */ }
      }
      return () => {
        try {
          if (readPid(lockPath) === process.pid) unlinkSync(lockPath);
        } catch { /* already gone */ }
      };
    } catch {
      const holder = readPid(lockPath);
      if (holder !== null && isAlive(holder)) return null;
      try {
        if (readPid(lockPath) === holder) unlinkSync(lockPath);
      } catch { /* raced with another cleaner */ }
    }
  }
  return null;
}

async function run(cmd: string, args: string[], cwd: string): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd, env: { ...gitExecEnv(), GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true, stdout, stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, stdout: e.stdout ?? '', stderr: e.stderr ?? e.message ?? '' };
  }
}

async function repoRoot(): Promise<string> {
  const r = await run('git', ['rev-parse', '--show-toplevel'], process.cwd());
  if (!r.ok) throw new Error('run the integration train from inside a Kookr checkout');
  return r.stdout.trim();
}

const TRAIN_MARKER = 'kookr-integration-train';

/**
 * Create the train's dedicated linked worktree on first use, and refuse to use
 * a directory the train did not create. Every cycle runs `reset --hard` and
 * `checkout --force` there, so pointing it at someone's working checkout would
 * destroy their changes. The proof of ownership is a marker file in the
 * worktree's private git directory, plus the same git common directory as the
 * launching checkout.
 */
async function ensureWorktree(root: string, wt: string): Promise<void> {
  const gitPath = async (cwd: string, flag: string): Promise<string | null> => {
    const r = await run('git', ['rev-parse', '--path-format=absolute', flag], cwd);
    return r.ok ? r.stdout.trim() : null;
  };
  if (existsSync(wt)) {
    const [wtCommon, rootCommon, wtGitDir] = await Promise.all([
      gitPath(wt, '--git-common-dir'), gitPath(root, '--git-common-dir'), gitPath(wt, '--git-dir'),
    ]);
    if (!wtCommon || wtCommon !== rootCommon || !wtGitDir || !existsSync(join(wtGitDir, TRAIN_MARKER))) {
      throw new Error(
        `${wt} exists but is not a worktree created by the integration train; ` +
        'refusing to reset it. Remove it or pass --worktree <another path>.',
      );
    }
    return;
  }
  mkdirSync(resolve(wt, '..'), { recursive: true });
  const base = (await run('git', ['rev-parse', '--verify', '--quiet', 'origin/main'], root)).ok ? 'origin/main' : 'HEAD';
  const r = await run('git', ['worktree', 'add', '--detach', wt, base], root);
  if (!r.ok) throw new Error(`could not create the train worktree: ${r.stderr.trim()}`);
  const gitDir = await gitPath(wt, '--git-dir');
  if (!gitDir) throw new Error('could not locate the git directory of the new train worktree');
  writeFileSync(join(gitDir, TRAIN_MARKER), `created ${new Date().toISOString()}\n`);
}

function makeLogger(logPath: string): (m: string) => void {
  return (message) => {
    const line = `${new Date().toISOString()} ${message}\n`;
    try { appendFileSync(logPath, line); } catch { /* logging must not break a cycle */ }
    if (process.stdout.isTTY) process.stdout.write(line);
  };
}

function loadState(file: string): TrainState {
  try {
    return normalizeTrainState(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return emptyTrainState();
  }
}

function saveState(file: string, state: TrainState): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, file);
}

function pruneVerifyLogs(dir: string, keep: number): void {
  try {
    const files = readdirSync(dir)
      .filter((f) => /^verify-.*\.log$/.test(f))
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const old of files.slice(keep)) rmSync(join(dir, old.f), { force: true });
  } catch { /* best effort */ }
}

const VERIFY_TIMEOUT_MS = 90 * 60 * 1000;

// What a stop signal has to clean up: the verify process group (it runs detached,
// so it would otherwise keep using the train worktree after the loop exits) and
// the single-instance lock.
let activeChildPid: number | null = null;
let activeRelease: (() => void) | null = null;

function installSignalHandlers(): void {
  const onSignal = (signal: NodeJS.Signals): void => {
    if (activeChildPid !== null) {
      try { process.kill(-activeChildPid, 'SIGKILL'); } catch { /* already gone */ }
    }
    if (activeRelease) activeRelease();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
}

function runLogged(cmd: string, cwd: string, env: NodeJS.ProcessEnv, logFile: string): Promise<boolean> {
  return new Promise((done) => {
    const fd = openSync(logFile, 'a');
    // stdin from /dev/null: a verify step must never wait on a prompt.
    // Own process group, so a timeout kills the whole tree (shell, pnpm, vitest
    // workers) and not just the shell.
    const child = spawn(cmd, { cwd, env, shell: true, detached: true, stdio: ['ignore', fd, fd] });
    activeChildPid = child.pid ?? null;
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, VERIFY_TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      activeChildPid = null;
      closeSync(fd);
      done(code === 0);
    });
    child.on('error', () => {
      clearTimeout(timer);
      closeSync(fd);
      done(false);
    });
  });
}

function buildDeps(opts: Options, dir: string, root: string, wt: string): TrainDeps {
  const p = paths(dir);
  const log = makeLogger(p.log);
  const git = (args: string[]): Promise<GitResult> => run('git', args, wt);
  const state = { load: () => loadState(p.state), save: (s: TrainState) => saveState(p.state, s) };

  const verify = async (sha: string): Promise<VerifyResult> => {
    const logFile = join(dir, `verify-${sha.slice(0, 10)}.log`);
    writeFileSync(logFile, '');
    const checkout = await git(['checkout', '--detach', '--force', '-q', sha]);
    // A failed checkout or install means the suite never ran. Report it as an
    // infrastructure failure so the train halts instead of blaming the commit.
    if (!checkout.ok) return { ok: false, infra: true, tail: `checkout failed: ${checkout.stderr}` };
    // Same environment a developer's `pnpm verify` gets, plus the worker count:
    // no CI flag, so the train checks exactly what the local gate used to.
    const env: NodeJS.ProcessEnv = { ...gitExecEnv(), KOOKR_VITEST_MAX_WORKERS: String(opts.workers) };

    const lockHash = (() => {
      try { return createHash('sha256').update(readFileSync(join(wt, 'pnpm-lock.yaml'))).digest('hex'); } catch { return ''; }
    })();
    // The last-installed lockfile hash lives in its own file, not in state.json:
    // the cycle saves its in-memory state at the end and would clobber it.
    const hashFile = join(dir, 'last-install-hash');
    let lastHash = '';
    try { lastHash = readFileSync(hashFile, 'utf8').trim(); } catch { /* first run */ }
    if (lockHash !== lastHash) {
      const installed = await runLogged('pnpm install --frozen-lockfile --prefer-offline', wt, env, logFile);
      if (!installed) return { ...finish(logFile, sha, false), infra: true };
      writeFileSync(hashFile, lockHash);
    }
    const ok = await runLogged(opts.verifyCmd, wt, env, logFile);
    return finish(logFile, sha, ok);
  };

  function finish(logFile: string, sha: string, ok: boolean): VerifyResult {
    pruneVerifyLogs(dir, 20);
    let text = '';
    try { text = readFileSync(logFile, 'utf8'); } catch { /* no output */ }
    log(`verify output for ${sha.slice(0, 10)}: ${logFile}`);
    return { ok, tail: tailForComment(text) };
  }

  const gh = async (args: string[]): Promise<string> => {
    const r = await run('gh', args, root);
    if (!r.ok) throw new Error(`gh ${args.join(' ')}: ${r.stderr.trim()}`);
    return r.stdout;
  };

  const github: TrainDeps['github'] = {
    async closingIssues(pr): Promise<ClosingIssue[]> {
      const json = JSON.parse(await gh(['pr', 'view', String(pr), '--json', 'closingIssuesReferences'])) as {
        closingIssuesReferences?: Array<{ number: number }>;
      };
      const issues: ClosingIssue[] = [];
      for (const ref of json.closingIssuesReferences ?? []) {
        const view = JSON.parse(await gh(['issue', 'view', String(ref.number), '--json', 'state'])) as { state: string };
        issues.push({ number: ref.number, state: view.state.toUpperCase() === 'OPEN' ? 'open' : 'closed' });
      }
      return issues;
    },
    async reopenIssue(n) { await gh(['issue', 'reopen', String(n)]); },
    async closeIssue(n, comment) { await gh(['issue', 'close', String(n), '--comment', comment]); },
    async commentIssue(n, body) { await gh(['issue', 'comment', String(n), '--body', body]); },
  };

  const spawner: TrainDeps['spawner'] = {
    async spawn({ idempotencyKey, prompt }) {
      const file = join(dir, `${idempotencyKey}.prompt.md`);
      writeFileSync(file, prompt);
      // Launched from the repo root so the task lands in the right project.
      const r = await run('kookr', [
        'spawn', '--prompt-file', file, '--idempotency-key', idempotencyKey, '--no-parent-task', '--unattended',
      ], root);
      if (!r.ok) throw new Error(`kookr spawn failed: ${r.stderr.trim()}`);
    },
  };

  const notifier: TrainDeps['notifier'] = {
    async notify(kind: TrainEventKind, detail: string) {
      appendFileSync(p.events, `${JSON.stringify({ at: new Date().toISOString(), kind, detail })}\n`);
      // Best effort: surface in the operator signal outbox. Every train event
      // needs a human eye, so they are all alerts.
      await run('kookr', [
        'signal-emit', 'transition', '--source', 'integration-train', '--status', 'alert',
        '--detail', `${kind}: ${detail}`.slice(0, 500),
      ], root);
    },
  };

  return { git, verify, github, spawner, notifier, state, log, now: () => new Date() };
}

async function cycleOnce(opts: Options): Promise<number> {
  const dir = stateDir();
  mkdirSync(dir, { recursive: true });
  const p = paths(dir);
  const release = acquireLock(p.lock);
  if (!release) return 0; // another instance is working; exit quietly
  activeRelease = release;
  try {
    const root = await repoRoot();
    // Default: a sibling of the launching checkout (`<repo>-train`), not inside
    // the Kookr data directory, where pruning and disk-reclaim jobs operate.
    const wt = opts.worktree ?? `${root}-train`;
    await ensureWorktree(root, wt);
    const deps = buildDeps(opts, dir, root, wt);
    const result = await runTrainCycle(deps);
    deps.log(`cycle: ${result.outcome}${result.reason ? ` (${result.reason})` : ''}${result.detail ? ` - ${result.detail}` : ''}`);
  } finally {
    activeRelease = null;
    release();
  }
  return 0;
}

async function runForever(opts: Options): Promise<void> {
  installSignalHandlers();
  const dir = stateDir();
  mkdirSync(dir, { recursive: true });
  const log = makeLogger(paths(dir).log);
  log(`run loop started, interval ${opts.intervalSec}s`);
  for (;;) {
    try {
      await cycleOnce(opts);
    } catch (err) {
      log(`cycle crashed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    }
    await new Promise((r) => setTimeout(r, opts.intervalSec * 1000));
  }
}

function startDetached(argv: string[]): void {
  const dir = stateDir();
  mkdirSync(dir, { recursive: true });
  const p = paths(dir);
  const existing = readPid(p.pid);
  if (existing !== null && isAlive(existing)) {
    console.log(`integration train already running (pid ${existing})`);
    return;
  }
  const out = openSync(p.log, 'a');
  const forwarded = argv.slice(1);
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(import.meta.url), 'run', ...forwarded],
    { cwd: process.cwd(), detached: true, stdio: ['ignore', out, out], env: process.env },
  );
  child.unref();
  writeFileSync(p.pid, String(child.pid));
  console.log(`integration train started (pid ${child.pid}), log: ${p.log}`);
}

function stop(): void {
  const p = paths(stateDir());
  const pid = readPid(p.pid);
  if (pid !== null && isAlive(pid)) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
    console.log(`stopped integration train (pid ${pid})`);
  } else {
    console.log('integration train is not running');
  }
  rmSync(p.pid, { force: true });
}

function status(): void {
  const dir = stateDir();
  const p = paths(dir);
  const pid = readPid(p.pid);
  console.log(JSON.stringify({
    running: pid !== null && isAlive(pid),
    pid,
    stateDir: dir,
    state: loadState(p.state),
  }, null, 2));
}

function logs(): void {
  try {
    console.log(readFileSync(paths(stateDir()).log, 'utf8').split('\n').filter(Boolean).slice(-120).join('\n'));
  } catch {
    console.log('no log yet');
  }
}

function resume(): void {
  const p = paths(stateDir());
  const st = loadState(p.state);
  if (!st.halted) {
    console.log('integration train is not halted');
    return;
  }
  const was = st.halted.reason;
  st.halted = null;
  saveState(p.state, st);
  console.log(`cleared halt "${was}"; the next cycle will run`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);
  switch (opts.command) {
    case 'cycle': process.exitCode = await cycleOnce(opts); return;
    case 'run': await runForever(opts); return;
    case 'start': startDetached(argv); return;
    case 'stop': stop(); return;
    case 'status': status(); return;
    case 'logs': logs(); return;
    case 'resume': resume(); return;
    default:
      console.error('usage: integration-train <cycle|run|start|stop|status|logs|resume> [--interval <sec>] [--worktree <path>] [--verify-cmd "<cmd>"] [--workers <n>]');
      process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
