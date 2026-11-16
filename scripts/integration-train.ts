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
import { defaultOperatorSignalDir, writeOperatorSignal } from '../src/observability/signal-delivery/operator-signal.js';
import {
  integrationTrainBaseDir,
  integrationTrainPaths,
  integrationTrainStateDir,
  isIntegrationTrainProcess,
  readIntegrationTrainStatus,
  readPidFile,
  readProcessArgv,
  resolveRepoKey,
} from '../src/server/integration-train-runtime.js';
import {
  type ClosingIssue,
  type GitResult,
  type TrainDeps,
  type TrainEventKind,
  type TrainState,
  type VerifyReport,
  type VerifyResult,
  type VerifyScope,
  closingIssueNumbersFromText,
  emptyTrainState,
  isOutdatedLockfileFailure,
  normalizeTrainState,
  parseSpawnOutput,
  parseVerifyReport,
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
  /** `restart --now`: stop at once, even mid-verify, instead of after the cycle. */
  now: boolean;
}

/**
 * The options that take a value, and how each one sets it. `parseArgs` and
 * `withoutNowFlag` both read this one table, so a new option cannot be added
 * to one and missed in the other (issue #3851).
 */
const VALUE_OPTIONS: ReadonlyMap<string, (opts: Options, value: string) => void> = new Map([
  ['--interval', (o: Options, v: string) => { o.intervalSec = Math.max(1, Number(v) || 60); }],
  ['--worktree', (o: Options, v: string) => { o.worktree = resolve(v); }],
  ['--verify-cmd', (o: Options, v: string) => { o.verifyCmd = v; }],
  ['--workers', (o: Options, v: string) => { o.workers = Math.max(1, Number(v) || o.workers); }],
]);

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    command: argv[0] ?? 'status',
    intervalSec: 60,
    worktree: null,
    verifyCmd: 'pnpm verify',
    // Measured on a loaded 16-CPU host (issue #3794, one unit-suite run per
    // setting): 8 workers was the fastest of 4, 6, 8 and 12, and 12 used about
    // 17% more CPU than 8, which slows every other task on the host.
    workers: Math.min(8, Math.max(4, cpus().length - 4)),
    now: false,
  };
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    const set = VALUE_OPTIONS.get(flag);
    if (set) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      set(opts, v);
    } else if (flag === '--now' && opts.command === 'restart') opts.now = true;
    else throw new Error(`unknown option ${flag}`);
  }
  return opts;
}

function kookrDir(): string {
  return process.env.KOOKR_DIR ?? join(homedir(), '.kookr');
}

/**
 * The state directory of this repository's train:
 * `<KOOKR_DIR>/integration-train/<owner-name>/`. Keyed by repository so trains
 * of two repositories never share a lock or a halt (issue #3796).
 */
function stateDir(): string {
  return integrationTrainStateDir(kookrDir(), resolveRepoKey(process.cwd()));
}

/**
 * Before issue #3796 every train used `<KOOKR_DIR>/integration-train/` itself.
 * A train started by older code keeps using it until it is restarted.
 */
function legacyDir(): string {
  return integrationTrainBaseDir(kookrDir());
}

const paths = integrationTrainPaths;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const readPid = readPidFile;

/** Pid of a train that still runs from the pre-#3796 shared directory, or null. */
function legacyTrainPid(): number | null {
  const lp = paths(legacyDir());
  for (const file of [lp.pid, lp.lock]) {
    const pid = readPid(file);
    if (pid !== null && pid !== process.pid && isIntegrationTrainProcess(pid)) return pid;
  }
  return null;
}

/**
 * Move a pre-#3796 shared state directory into this repository's keyed one, so
 * a standing halt, the fix-task budget and the alert flag survive the upgrade.
 * Runs only when no train is using the old directory any more and the keyed
 * directory has no state yet. The old pid and lock files are dropped: their
 * process is gone.
 */
function migrateLegacyState(dir: string): void {
  const old = legacyDir();
  if (!existsSync(join(old, 'state.json')) || existsSync(join(dir, 'state.json'))) return;
  if (legacyTrainPid() !== null) return;
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(old)) {
    const isStateFile = name === 'state.json' || name === 'events.jsonl' || name === 'train.log'
      || /^verify-.*\.log$/.test(name) || name.endsWith('.prompt.md');
    if (!isStateFile) continue;
    try { renameSync(join(old, name), join(dir, name)); } catch { /* raced or vanished */ }
  }
  for (const name of ['train.pid', 'train.lock']) rmSync(join(old, name), { force: true });
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
    } catch (err) {
      // Only "the lock exists" means someone else may hold it. Anything else
      // (disk full, a filesystem without hard links) must be loud: returning
      // "held" would make the train silently do nothing forever.
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new Error(`cannot create the train lock ${lockPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
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
  try {
    writeFileSync(join(gitDir, TRAIN_MARKER), `created ${new Date().toISOString()}\n`);
  } catch (err) {
    // Without its marker the next run would refuse this worktree forever.
    await run('git', ['worktree', 'remove', '--force', wt], root);
    throw err;
  }
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

/** The report file scripts/verify.sh writes next to a verify log (issue #3995). */
const reportFileFor = (logFile: string): string => logFile.replace(/\.log$/, '.report.json');

/** Keeps the `keep` newest verify logs, and the report file of each. */
function pruneVerifyLogs(dir: string, keep: number): void {
  try {
    const files = readdirSync(dir)
      .filter((f) => /^verify-.*\.log$/.test(f))
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const old of files.slice(keep)) {
      rmSync(join(dir, old.f), { force: true });
      rmSync(join(dir, reportFileFor(old.f)), { force: true });
    }
  } catch { /* best effort */ }
}

const VERIFY_TIMEOUT_MS = 90 * 60 * 1000;

// What a stop signal has to clean up: the verify process group (it runs detached,
// so it would otherwise keep using the train worktree after the loop exits) and
// the single-instance lock.
let activeChildPid: number | null = null;
let activeRelease: (() => void) | null = null;
let inCycle = false;
let stopRequested = false;
// The successor started by `reexec` (issue #3841), from its spawn until this
// process exits; `handoverConfirmed` once it has been recorded in `train.pid`.
let handoverChildPid: number | null = null;
let handoverConfirmed = false;

/**
 * Stop cleanly. Three moments, three behaviours:
 * - a verify is running: kill its process group and exit. Nothing has been
 *   pushed for that commit yet, so nothing is left half-done;
 * - a cycle is between verifies (pushing a revert, commenting, spawning the fix
 *   task; a few seconds): let it finish, then exit, so a revert is never pushed
 *   without its issue comment and fix task;
 * - idle between cycles: exit now.
 */
function installSignalHandlers(): void {
  const onSignal = (signal: NodeJS.Signals): void => {
    const code = signal === 'SIGINT' ? 130 : 143;
    // A stop during a hand-over stops both processes: until the successor is
    // confirmed, `train.pid` names this one, so it is the one `stop` signals.
    // An unconfirmed successor has not started a cycle (it waits for this
    // process to exit first, issue #3848), so killing it outright loses
    // nothing. A confirmed one is the train now: it gets the same SIGTERM, and
    // stops the way any train does.
    if (handoverChildPid !== null) {
      try {
        if (handoverConfirmed) process.kill(handoverChildPid, 'SIGTERM');
        else process.kill(-handoverChildPid, 'SIGKILL');
      } catch { /* already gone */ }
      process.exit(code);
    }
    if (activeChildPid !== null) {
      try { process.kill(-activeChildPid, 'SIGKILL'); } catch { /* already gone */ }
      if (activeRelease) activeRelease();
      process.exit(code);
    }
    if (inCycle) {
      stopRequested = true;
      return;
    }
    process.exit(code);
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

/** Most failing test files reported for one red run (the log is the full record). */
const MAX_FAILING_FILES = 20;

/**
 * Test files a verify log reports as failed: vitest's `FAIL  <file> > <test>`
 * lines, which `scripts/verify.sh` may prefix with the lane (`[unit_lane] `)
 * and vitest with the project (`|serial| `). Sorted, without duplicates (a
 * failed lane's output is printed twice).
 */
function failingTestFiles(text: string): string[] {
  const files = new Set<string>();
  const plain = text.replace(/\x1b\[[0-9;]*m/g, '');
  for (const m of plain.matchAll(/\bFAIL\s+(?:\|[^|\s]+\|\s+)?(\S+\.(?:test|spec)\.[cm]?[jt]sx?)(?=\s|$)/gm)) {
    files.add(m[1]);
  }
  return [...files].sort().slice(0, MAX_FAILING_FILES);
}

function buildDeps(opts: Options, dir: string, root: string, wt: string): TrainDeps {
  const p = paths(dir);
  const log = makeLogger(p.log);
  const git = (args: string[]): Promise<GitResult> => run('git', args, wt);
  const state = { load: () => loadState(p.state), save: (s: TrainState) => saveState(p.state, s) };

  // Runs of each SHA in this cycle: how many, and whether the last one was red.
  const runs = new Map<string, { count: number; red: boolean }>();

  /**
   * A SHA is verified again after a red run (the head's flake re-run, or a
   * culprit's re-run). That run must not overwrite the red run's output: the
   * red log is kept as `verify-<sha>.run<n>.log`, and its report file (the
   * failed lanes and test files, from scripts/verify.sh) as
   * `verify-<sha>.run<n>.report.json`. When the re-run is green, the
   * failing test files of the red run go to the train log and the events file,
   * so load-sensitive tests can be found and fixed.
   * A narrow run (a scope, issue #3995) has a log and a count of its own,
   * `verify-<sha>.narrow.log`, so it never moves a full run's log or report.
   */
  const verify = async (sha: string, scope?: VerifyScope): Promise<VerifyResult> => {
    const short = sha.slice(0, 10);
    const name = scope ? `${short}.narrow` : short;
    const runKey = scope ? `${sha}:narrow` : sha;
    const logFile = join(dir, `verify-${name}.log`);
    const prev = runs.get(runKey);
    let redLog: string | null = null;
    if (prev?.red) {
      redLog = join(dir, `verify-${name}.run${prev.count}.log`);
      try { renameSync(logFile, redLog); } catch { redLog = null; }
      if (redLog) {
        try { renameSync(reportFileFor(logFile), reportFileFor(redLog)); } catch { /* the run wrote none */ }
      }
    }
    const result = await runVerify(sha, logFile, scope);
    runs.set(runKey, { count: (prev?.count ?? 0) + 1, red: !result.ok });
    if (result.ok && prev?.red) {
      let text = '';
      try { if (redLog) text = readFileSync(redLog, 'utf8'); } catch { /* unreadable */ }
      const files = failingTestFiles(text);
      const detail = `${short} was red, then green on re-run; failing test files of the red run: `
        + `${files.length > 0 ? files.join(', ') : 'none found in its log'} (log: ${redLog ?? 'not kept'})`;
      log(detail);
      try {
        appendFileSync(p.events, `${JSON.stringify({
          at: new Date().toISOString(), kind: 'red-then-green', detail, sha, files, log: redLog,
        })}\n`);
      } catch { /* the train log has it */ }
    }
    return result;
  };

  const runVerify = async (sha: string, logFile: string, scope?: VerifyScope): Promise<VerifyResult> => {
    writeFileSync(logFile, '');
    // A report left by an earlier run of this SHA must not describe this one
    // (a failed checkout or install never reaches scripts/verify.sh).
    rmSync(reportFileFor(logFile), { force: true });
    const checkout = await git(['checkout', '--detach', '--force', '-q', sha]);
    // A failed checkout or install means the suite never ran. Report it as an
    // infrastructure failure so the train halts instead of blaming the commit.
    if (!checkout.ok) return { ok: false, infra: true, tail: `checkout failed: ${checkout.stderr}` };
    // Same environment a developer's `pnpm verify` gets, plus the worker count:
    // no CI flag, so the train checks exactly what the local gate used to.
    // KOOKR_VERIFY_FLAKY_RERUN: scripts/verify.sh then applies the pre-push
    // hook's flaky policy to the unit lane (a few failed files are re-run once).
    // KOOKR_VERIFY_REPORT_FILE: scripts/verify.sh writes which lanes and test
    // files failed to `verify-<sha>.report.json`, next to the log.
    // KOOKR_VERIFY_ONLY_STEPS / KOOKR_VERIFY_UNIT_FILES: a narrow run's steps
    // and unit test files, one per line. Always set, and empty for a full run,
    // so a value inherited from the train's own environment never narrows the
    // run that decides a promotion.
    const env: NodeJS.ProcessEnv = {
      ...gitExecEnv(), KOOKR_VITEST_MAX_WORKERS: String(opts.workers), KOOKR_VERIFY_FLAKY_RERUN: '1',
      KOOKR_VERIFY_REPORT_FILE: reportFileFor(logFile),
      KOOKR_VERIFY_ONLY_STEPS: scope ? scope.steps.join('\n') : '',
      KOOKR_VERIFY_UNIT_FILES: scope ? scope.testFiles.join('\n') : '',
    };

    const lockHash = (() => {
      try { return createHash('sha256').update(readFileSync(join(wt, 'pnpm-lock.yaml'))).digest('hex'); } catch { return ''; }
    })();
    // The last-installed lockfile hash lives in the worktree's private git
    // directory (next to the ownership marker), so it lives and dies with the
    // worktree: a recreated worktree has no node_modules and must reinstall.
    const gitDirResult = await git(['rev-parse', '--path-format=absolute', '--git-dir']);
    const hashFile = gitDirResult.ok ? join(gitDirResult.stdout.trim(), 'last-install-hash') : null;
    let lastHash = '';
    try { if (hashFile) lastHash = readFileSync(hashFile, 'utf8').trim(); } catch { /* first run */ }
    if (lockHash !== lastHash || !hashFile) {
      const installed = await runLogged('pnpm install --frozen-lockfile --prefer-offline', wt, env, logFile);
      if (!installed) {
        let text = '';
        try { text = readFileSync(logFile, 'utf8'); } catch { /* no output */ }
        // A lockfile that does not match package.json is a defect of this commit
        // (it can be bisected and reverted); any other failure is an outage.
        return { ...finish(logFile, sha, false), infra: !isOutdatedLockfileFailure(text) };
      }
      if (hashFile) writeFileSync(hashFile, lockHash);
    }
    const ok = await runLogged(opts.verifyCmd, wt, env, logFile);
    return finish(logFile, sha, ok);
  };

  function finish(logFile: string, sha: string, ok: boolean): VerifyResult {
    pruneVerifyLogs(dir, 20);
    let text = '';
    try { text = readFileSync(logFile, 'utf8'); } catch { /* no output */ }
    log(`verify output for ${sha.slice(0, 10)}: ${logFile}`);
    let report: VerifyReport | null = null;
    try { report = parseVerifyReport(readFileSync(reportFileFor(logFile), 'utf8')); } catch { /* none written */ }
    return { ok, tail: tailForComment(text), ...(report ? { report } : {}) };
  }

  const gh = async (args: string[]): Promise<string> => {
    const r = await run('gh', args, root);
    if (!r.ok) throw new Error(`gh ${args.join(' ')}: ${r.stderr.trim()}`);
    return r.stdout;
  };

  // `owner/name` of the current repository, fetched once.
  let currentRepo: string | null = null;
  const repoName = async (): Promise<string | null> => {
    if (currentRepo === null) {
      try {
        const v = JSON.parse(await gh(['repo', 'view', '--json', 'nameWithOwner'])) as { nameWithOwner?: string };
        currentRepo = v.nameWithOwner?.toLowerCase() ?? null;
      } catch { /* unknown: cross-repository references are then dropped */ }
    }
    return currentRepo;
  };

  const github: TrainDeps['github'] = {
    async closingIssues(pr): Promise<ClosingIssue[]> {
      // GitHub returns no closing references for a PR whose base is not the
      // default branch, so the PR body is read for closing keywords as well.
      const json = JSON.parse(await gh(['pr', 'view', String(pr), '--json', 'closingIssuesReferences,body'])) as {
        closingIssuesReferences?: Array<{ number: number; repository?: { name?: string; owner?: { login?: string } } }>;
        body?: string | null;
      };
      const numbers = new Set<number>();
      const refs = json.closingIssuesReferences ?? [];
      if (refs.length > 0) {
        const repo = await repoName();
        for (const ref of refs) {
          const full = `${ref.repository?.owner?.login ?? ''}/${ref.repository?.name ?? ''}`.toLowerCase();
          if (repo !== null && full === repo) numbers.add(ref.number);
        }
      }
      for (const n of closingIssueNumbersFromText(json.body ?? '')) numbers.add(n);
      const issues: ClosingIssue[] = [];
      for (const n of [...numbers].sort((a, b) => a - b)) {
        try {
          // The REST issue endpoint answers for pull requests too and marks
          // them with a `pull_request` field. The issue calls below must never
          // close, reopen or comment on a pull request, so those are dropped
          // (the train reports on pull requests only through commentPullRequest).
          const view = JSON.parse(await gh(['api', `repos/{owner}/{repo}/issues/${n}`])) as {
            state?: string; pull_request?: unknown;
          };
          if (view.pull_request !== undefined && view.pull_request !== null) continue;
          if (typeof view.state !== 'string') continue;
          issues.push({ number: n, state: view.state.toLowerCase() === 'open' ? 'open' : 'closed' });
        } catch { /* not an issue we can read (a typo, no access): skip it */ }
      }
      return issues;
    },
    async reopenIssue(n) { await gh(['issue', 'reopen', String(n)]); },
    async closeIssue(n, comment) { await gh(['issue', 'close', String(n), '--comment', comment]); },
    async commentIssue(n, body) { await gh(['issue', 'comment', String(n), '--body', body]); },
    async commentPullRequest(pr, marker, body) {
      // Read the existing comments first: a report already posted (before a
      // crash or a restart) is not posted again. A failed read posts nothing.
      const bodies = await gh(['api', '--paginate', `repos/{owner}/{repo}/issues/${pr}/comments`, '--jq', '.[].body']);
      if (bodies.includes(marker)) return;
      await gh(['pr', 'comment', String(pr), '--body', body]);
    },
  };

  const spawner: TrainDeps['spawner'] = {
    async spawn({ idempotencyKey, prompt }) {
      const file = join(dir, `${idempotencyKey}.prompt.md`);
      writeFileSync(file, prompt);
      // Launched from the repo root so the task lands in the right project.
      // `--json` says whether the key replayed an earlier task (issue #3986).
      const r = await run('kookr', [
        'spawn', '--prompt-file', file, '--idempotency-key', idempotencyKey, '--no-parent-task', '--unattended', '--json',
      ], root);
      return parseSpawnOutput(r);
    },
  };

  // Operator signal outbox (the delivery service pushes each new file to the
  // operator's channels). Every event gets a file of its own: the outbox keeps
  // one file per key, so a shared key would let a second event overwrite the
  // first before it was delivered. The core decides when recovery is due
  // (once, after an alert, never while halted).
  const signalDir = defaultOperatorSignalDir(process.env);
  let signalSeq = 0;
  const signal = async (name: string, kind: 'alert' | 'clear' | 'info', title: string, detail: string): Promise<void> => {
    // Time first: the delivery service sends a batch in file-name order, so a
    // `reverted` alert and the recovery after it arrive in the order they happened.
    const key = `integration-train:${String(Date.now()).padStart(15, '0')}-${process.pid}-${String(signalSeq++).padStart(6, '0')}:${name}`;
    await writeOperatorSignal(signalDir, { key, kind, source: 'integration-train', title, detail: detail.slice(0, 2000) });
  };

  const notifier: TrainDeps['notifier'] = {
    async notify(kind: TrainEventKind, detail: string) {
      appendFileSync(p.events, `${JSON.stringify({ at: new Date().toISOString(), kind, detail })}\n`);
      // `main-bypassed` is a notice (nothing to recover from); every other event is an alert.
      await signal(kind, kind === 'main-bypassed' ? 'info' : 'alert', `integration train: ${kind}`, detail);
    },
    async healthy() {
      await signal('recovered', 'clear', 'integration train recovered', 'a healthy cycle ran after the last alert');
    },
  };

  // The plugin version bump (issue #3793) is the only file the train writes itself.
  const writeFile = async (path: string, content: string): Promise<void> => {
    writeFileSync(join(wt, path), content);
  };

  return { git, writeFile, verify, github, spawner, notifier, state, log, now: () => new Date() };
}

function writeLastCycle(file: string, result: { outcome: string; reason?: string; detail?: string }): void {
  try {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({
      at: new Date().toISOString(),
      outcome: result.outcome,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.detail ? { detail: result.detail.slice(0, 2000) } : {}),
    }, null, 2));
    renameSync(tmp, file);
  } catch { /* status only; must not break a cycle */ }
}

async function cycleOnce(opts: Options): Promise<number> {
  const dir = stateDir();
  // A train started by older code still works from the shared directory, with
  // a different lock file: wait for it to exit rather than run beside it.
  if (legacyTrainPid() !== null) return 0;
  migrateLegacyState(dir);
  mkdirSync(dir, { recursive: true });
  const p = paths(dir);
  const release = acquireLock(p.lock);
  if (!release) return 0; // another instance is working; exit quietly
  activeRelease = release;
  inCycle = true;
  try {
    const root = await repoRoot();
    // Default: a sibling of the launching checkout (`<repo>-train`), not inside
    // the Kookr data directory, where pruning and disk-reclaim jobs operate.
    const wt = opts.worktree ?? `${root}-train`;
    await ensureWorktree(root, wt);
    const deps = buildDeps(opts, dir, root, wt);
    const result = await runTrainCycle(deps);
    deps.log(`cycle: ${result.outcome}${result.reason ? ` (${result.reason})` : ''}${result.detail ? ` - ${result.detail}` : ''}`);
    writeLastCycle(p.lastCycle, result);
  } finally {
    inCycle = false;
    activeRelease = null;
    release();
  }
  return 0;
}

/** `HEAD` of the checkout the train was launched from (not of its worktree), or null when unreadable. */
async function checkoutHead(): Promise<string | null> {
  const r = await run('git', ['rev-parse', 'HEAD'], process.cwd());
  return r.ok ? r.stdout.trim() : null;
}

interface RestartRequest {
  requestedAt: string;
  /** Options given to `restart`; empty means "keep the running train's". */
  args: string[];
  /** The checkout `restart` ran from, and its copy of this script: the new code. */
  cwd: string;
  script: string;
  /** Hand-overs already tried for this request that failed (issue #3850). */
  attempts: number;
  lastError?: string;
}

/** Hand-overs tried for one restart request before it is dropped (issue #3850). */
const RESTART_ATTEMPTS = 3;

function readRestartRequest(file: string): RestartRequest | null {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<RestartRequest>;
    if (typeof raw.requestedAt !== 'string') return null;
    return {
      requestedAt: raw.requestedAt,
      args: Array.isArray(raw.args) && raw.args.every((a) => typeof a === 'string') ? raw.args : [],
      cwd: typeof raw.cwd === 'string' ? raw.cwd : process.cwd(),
      script: typeof raw.script === 'string' ? raw.script : fileURLToPath(import.meta.url),
      attempts: typeof raw.attempts === 'number' && raw.attempts > 0 ? Math.floor(raw.attempts) : 0,
      ...(typeof raw.lastError === 'string' ? { lastError: raw.lastError } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Launch `run` detached from `cwd` with `script`, record its pid and options,
 * and return the pid. The loader flags of this process (`--import tsx`, or an
 * absolute loader URL) are passed on, so the child resolves TypeScript the same way.
 */
function spawnTrain(args: string[], cwd: string, script: string, record = true): number {
  const p = paths(stateDir());
  const out = openSync(p.log, 'a');
  let child;
  try {
    child = spawn(
      process.execPath,
      [...process.execArgv, script, 'run', ...args],
      { cwd, detached: true, stdio: ['ignore', out, out], env: process.env },
    );
  } finally {
    closeSync(out);
  }
  // An asynchronous spawn failure must not crash the caller (a running train
  // handing over); the missing pid below, or the hand-over check, reports it.
  child.on('error', () => { /* reported by the caller */ });
  child.unref();
  if (child.pid === undefined) throw new Error(`could not start ${script}`);
  if (record) recordTrain(p, child.pid, args);
  return child.pid;
}

function recordTrain(p: ReturnType<typeof paths>, pid: number, args: string[]): void {
  writeFileSync(p.pid, String(pid));
  writeFileSync(p.startArgs, JSON.stringify(args));
}

/**
 * Wait out the interval between two cycles. Returns why the train must
 * re-execute itself instead of running another cycle, or null: a `restart`
 * request (checked every second, so an idle or halted train restarts at once;
 * a request whose hand-over already failed is retried once the interval is
 * over, after the next cycle), or a launching checkout whose `HEAD` is no
 * longer the one this process started on (a deploy whose restart request
 * never arrived).
 */
async function waitBetweenCycles(intervalSec: number, requestFile: string, startHead: string | null): Promise<string | null> {
  const deadline = Date.now() + intervalSec * 1000;
  for (;;) {
    if (existsSync(requestFile) && (readRestartRequest(requestFile)?.attempts ?? 0) === 0) return 'restart requested';
    const left = deadline - Date.now();
    if (left <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(1000, left)));
  }
  const retry = readRestartRequest(requestFile);
  if (retry !== null) return `restart requested, attempt ${retry.attempts + 1} of ${RESTART_ATTEMPTS}`;
  const head = await checkoutHead();
  if (startHead !== null && head !== null && head !== startHead) {
    return `checkout HEAD moved from ${startHead.slice(0, 10)} to ${head.slice(0, 10)}`;
  }
  return null;
}

/** How long a successor gets to show it is up (its run loop writes `run-info.json`). */
const HANDOVER_TIMEOUT_MS = 60_000;

/**
 * Hand over to a new process running the deployed code (issue #3841). Called
 * only between cycles, so no verify is in flight and the lock is released.
 * This process exits only once the successor's run loop has recorded itself.
 * A successor that fails to start (bad options, or a deploy still installing
 * its dependencies) is killed and false is returned: the caller keeps running
 * the old code rather than leaving no train at all. A moved `HEAD` makes it
 * try again after the next cycle, and so does a restart request, which is put
 * back with its failed attempts counted, up to RESTART_ATTEMPTS (issue #3850).
 */
async function reexec(reason: string, runArgs: string[], log: (m: string) => void): Promise<boolean> {
  const p = paths(stateDir());
  const request = readRestartRequest(p.restartRequest);
  // Consumed first: a request left behind would restart the successor again.
  rmSync(p.restartRequest, { force: true });
  // The options are checked by the successor's own (new) code, not by this one.
  const args = request && request.args.length > 0 ? request.args : runArgs;
  const cwd = request && existsSync(request.cwd) ? request.cwd : process.cwd();
  const script = request && existsSync(request.script) ? request.script : fileURLToPath(import.meta.url);
  log(`re-executing after the cycle (${reason}): ${script} from ${cwd}`);
  let pid: number | null = null;
  try {
    // `train.pid` keeps naming this process until the successor is confirmed,
    // so a `stop` meanwhile reaches this process, which then stops both.
    pid = spawnTrain(args, cwd, script, false);
    handoverChildPid = pid;
    const deadline = Date.now() + HANDOVER_TIMEOUT_MS;
    while (Date.now() < deadline && isAlive(pid) && runInfoPid(p.runInfo) !== pid) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (runInfoPid(p.runInfo) !== pid) throw new Error(`pid ${pid} did not start its run loop`);
    recordTrain(p, pid, args);
    // Kept set: a stop that reaches this process before it exits is passed on
    // to the successor (issue #3847).
    handoverConfirmed = true;
    log(`handed over to pid ${pid}; pid ${process.pid} exits`);
    return true;
  } catch (err) {
    if (pid !== null) {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    handoverChildPid = null;
    const message = err instanceof Error ? err.message : String(err);
    // `run-info.json` may name the killed successor: point it back at this
    // process, which keeps running and still honours restart requests.
    writeRunInfo(p.runInfo, runInfoHead);
    log(`re-execution failed, this process keeps running: ${message}`);
    if (request) keepFailedRequest(p, request, message, log);
    return false;
  }
}

/**
 * Put back a restart request whose hand-over failed, so it is tried again
 * after the next cycle, unless it has failed RESTART_ATTEMPTS times. Then it
 * is dropped, and the events file records it. A newer request written by
 * `restart` in the meantime is never overwritten.
 */
function keepFailedRequest(p: ReturnType<typeof paths>, request: RestartRequest, error: string, log: (m: string) => void): void {
  const attempts = request.attempts + 1;
  const event = (detail: string): void => {
    try {
      appendFileSync(p.events, `${JSON.stringify({ at: new Date().toISOString(), kind: 'restart-failed', detail })}\n`);
    } catch { /* the train log has it */ }
  };
  if (attempts >= RESTART_ATTEMPTS) {
    const detail = `restart requested at ${request.requestedAt} failed ${attempts} times, giving up: ${error}`;
    log(detail);
    event(detail);
    return;
  }
  const tmp = `${p.restartRequest}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ ...request, attempts, lastError: error }, null, 2));
    linkSync(tmp, p.restartRequest); // atomic, and fails when a newer request is there
    const detail = `restart requested at ${request.requestedAt} failed (attempt ${attempts} of ${RESTART_ATTEMPTS}); `
      + `trying again after the next cycle: ${error}`;
    log(detail);
    event(detail);
  } catch (err) {
    log((err as NodeJS.ErrnoException).code === 'EEXIST'
      ? 'a newer restart request arrived meanwhile; it replaces the failed one'
      : `could not put the failed restart request back: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    try { unlinkSync(tmp); } catch { /* already gone */ }
  }
}

/** Head of the checkout this run loop started from, as written in `run-info.json`. */
let runInfoHead: string | null = null;

/** Tells `restart` that this train honours restart requests (old code does not). */
function writeRunInfo(file: string, head: string | null): void {
  try {
    writeFileSync(file, JSON.stringify({
      pid: process.pid, head, startedAt: new Date().toISOString(), restartRequests: true,
    }));
  } catch { /* status only */ }
}

async function runForever(opts: Options, runArgs: string[]): Promise<void> {
  installSignalHandlers();
  const dir = stateDir();
  mkdirSync(dir, { recursive: true });
  const p = paths(dir);
  const log = makeLogger(p.log);
  // Read first: once a predecessor that handed over exits, this becomes 1.
  const parent = process.ppid;
  const startHead = await checkoutHead();
  runInfoHead = startHead;
  writeRunInfo(p.runInfo, startHead);
  log(`run loop started, interval ${opts.intervalSec}s, checkout HEAD ${startHead?.slice(0, 10) ?? 'unknown'}`);
  // Started by a train handing over (issue #3848): no cycle until it has
  // exited. Until then a stop reaches it first and may kill this process
  // outright, which must never happen mid-cycle. `run-info.json` is written
  // before this wait, because the predecessor exits only once it has seen it.
  if (parent > 1 && isIntegrationTrainProcess(parent)) {
    log(`waiting for pid ${parent} to finish handing over`);
    const exited = await waitForExit(parent, HANDOVER_TIMEOUT_MS);
    log(exited ? `pid ${parent} has exited; first cycle starts` : `pid ${parent} is still running; starting anyway`);
  }
  for (;;) {
    try {
      await cycleOnce(opts);
    } catch (err) {
      log(`cycle crashed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    }
    if (stopRequested) {
      log('stop requested during a cycle; exiting after it finished');
      return;
    }
    const why = await waitBetweenCycles(opts.intervalSec, p.restartRequest, startHead);
    if (why !== null && await reexec(why, runArgs, log)) return;
  }
}

/**
 * Live trains of this repository: the pid in `train.pid`, and the one in
 * `run-info.json`. They differ for a moment during a hand-over, when the
 * successor's run loop has recorded itself in `run-info.json` and `train.pid`
 * still names its predecessor (issues #3847, #3849). A pid whose process is
 * not the train's run loop does not count.
 */
function runningTrainPids(dir: string): number[] {
  const p = paths(dir);
  const pids: number[] = [];
  for (const pid of [readPid(p.pid), runInfoPid(p.runInfo)]) {
    if (pid !== null && !pids.includes(pid) && isIntegrationTrainProcess(pid)) pids.push(pid);
  }
  return pids;
}

function startDetached(args: string[], stopping: ReadonlySet<number> = new Set()): void {
  const dir = stateDir();
  mkdirSync(dir, { recursive: true });
  const p = paths(dir);
  // A train that was just told to stop may still be finishing its cycle. The
  // new one starts anyway: it waits for the lock (or for the old shared
  // directory to be released) before its first cycle.
  const existing = [...runningTrainPids(dir), legacyTrainPid()].find((x) => x !== null && !stopping.has(x)) ?? null;
  if (existing !== null) {
    console.log(`integration train already running (pid ${existing})`);
    return;
  }
  parseArgs(['run', ...args]); // reject bad options before detaching
  // A request left by a train that is gone would restart the new one at once.
  rmSync(p.restartRequest, { force: true });
  const pid = spawnTrain(args, process.cwd(), fileURLToPath(import.meta.url));
  console.log(`integration train started (pid ${pid}), log: ${p.log}`);
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Not "is the pid alive": an exited child not yet reaped by its parent
    // still answers kill(0), but it no longer has a command line.
    if (!isIntegrationTrainProcess(pid)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return !isIntegrationTrainProcess(pid);
}

/**
 * Signal this repository's train, and a train still running from the pre-#3796
 * shared directory. Only a process whose command line is the train's run loop
 * is signalled: a stale pid file may name a pid the system has reused.
 * Waits up to `waitMs` for it to exit (a train between two verifies finishes
 * its cycle first, normally within seconds).
 *
 * A hand-over can complete while this waits: the old train records its
 * successor and exits. The pid files are therefore read again after each
 * round, a successor found there is stopped too, and `train.pid` is removed
 * only when it names a process this stop signalled, or none at all (issue #3847).
 */
async function stop(waitMs = 30_000): Promise<Set<number>> {
  const dir = stateDir();
  const p = paths(dir);
  const signalled = new Set<number>();
  for (let round = 0; round < 5; round++) {
    const targets = [...runningTrainPids(dir), legacyTrainPid()]
      .filter((x): x is number => x !== null && !signalled.has(x));
    if (targets.length === 0) break;
    for (const pid of targets) {
      signalled.add(pid);
      try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
      const exited = await waitForExit(pid, waitMs);
      console.log(exited
        ? `stopped integration train (pid ${pid})`
        : `integration train (pid ${pid}) is finishing its cycle; it exits when the cycle ends`);
    }
  }
  const filed = readPid(p.pid);
  if (signalled.size === 0) {
    if (filed !== null && isAlive(filed)) {
      console.log(`pid ${filed} in ${p.pid} is not the integration train; not signalling it`);
    } else {
      console.log('integration train is not running');
    }
    rmSync(p.pid, { force: true });
    rmSync(p.restartRequest, { force: true });
    return new Set();
  }
  if (filed === null || signalled.has(filed) || !isIntegrationTrainProcess(filed)) rmSync(p.pid, { force: true });
  // A stale `run-info.json` would make a later `start` or `restart` treat a reused pid as the train.
  const info = runInfoPid(p.runInfo);
  if (info !== null && signalled.has(info)) rmSync(p.runInfo, { force: true });
  rmSync(p.restartRequest, { force: true });
  rmSync(paths(legacyDir()).pid, { force: true });
  return signalled;
}

/** Options to restart with: the ones given, else those of the last start, else those of the live process. */
function restartArgs(given: string[], dir: string): string[] {
  if (given.length > 0) return given;
  try {
    const saved = JSON.parse(readFileSync(paths(dir).startArgs, 'utf8')) as unknown;
    if (Array.isArray(saved) && saved.every((a) => typeof a === 'string')) return saved;
  } catch { /* none saved */ }
  const pid = runningTrainPids(dir)[0] ?? legacyTrainPid();
  const argv = pid === null ? null : readProcessArgv(pid);
  const at = argv?.indexOf('run') ?? -1;
  return argv && at >= 0 ? argv.slice(at + 1) : [];
}

/** Pid named by `run-info.json`, written by a run loop that honours restart requests. */
function runInfoPid(file: string): number | null {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { pid?: unknown; restartRequests?: unknown };
    return raw.restartRequests === true && typeof raw.pid === 'number' ? raw.pid : null;
  } catch {
    return null;
  }
}

/**
 * Make the train run this checkout's code. `scripts/prod-restart.sh` calls it
 * after every deploy (issue #3841):
 * - a train that honours restart requests (its run loop is the one named in
 *   `run-info.json`, even while `train.pid` still names its predecessor during
 *   a hand-over, issue #3849) gets one and this returns at once.
 *   It finishes its current cycle (verify, promote or revert), then
 *   re-executes itself from this checkout with the same options;
 * - no train running: start one;
 * - `--now`, or a train started by older code that would ignore the request:
 *   stop it (killing a verify in flight) and start a new one.
 */
async function restart(given: string[], now: boolean): Promise<void> {
  const dir = stateDir();
  const p = paths(dir);
  const pid = runInfoPid(p.runInfo);
  if (!now && pid !== null && legacyTrainPid() === null && isIntegrationTrainProcess(pid)) {
    if (given.length > 0) parseArgs(['run', ...given]); // reject bad options now, not in the train
    const request: RestartRequest = {
      requestedAt: new Date().toISOString(), args: given, cwd: process.cwd(), script: fileURLToPath(import.meta.url),
      attempts: 0,
    };
    const tmp = `${p.restartRequest}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(request, null, 2));
    renameSync(tmp, p.restartRequest);
    console.log(`restart requested: integration train (pid ${pid}) re-executes from ${process.cwd()} once its current cycle ends`);
    return;
  }
  const args = restartArgs(given, dir);
  const signalled = await stop();
  startDetached(args, signalled);
}

function status(): void {
  const dir = stateDir();
  const p = paths(dir);
  const legacy = legacyTrainPid();
  console.log(JSON.stringify({
    ...readIntegrationTrainStatus(dir),
    ...(legacy !== null ? { legacyTrainPid: legacy, legacyStateDir: legacyDir() } : {}),
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
  const dir = stateDir();
  migrateLegacyState(dir);
  const p = paths(dir);
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

/** The options without `--now`, keeping an option value that happens to read `--now`. */
function withoutNowFlag(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (VALUE_OPTIONS.has(args[i]) && i + 1 < args.length) out.push(args[i], args[++i]);
    else if (args[i] !== '--now') out.push(args[i]);
  }
  return out;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);
  switch (opts.command) {
    case 'cycle': installSignalHandlers(); process.exitCode = await cycleOnce(opts); return;
    case 'run': await runForever(opts, argv.slice(1)); return;
    case 'start': startDetached(argv.slice(1)); return;
    case 'restart': await restart(withoutNowFlag(argv.slice(1)), opts.now); return;
    case 'stop': await stop(); return;
    case 'status': status(); return;
    case 'logs': logs(); return;
    case 'resume': resume(); return;
    default:
      console.error('usage: integration-train <cycle|run|start|restart [--now]|stop|status|logs|resume> [--interval <sec>] [--worktree <path>] [--verify-cmd "<cmd>"] [--workers <n>]');
      process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
