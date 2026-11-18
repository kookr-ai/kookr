#!/usr/bin/env node
// `pnpm deliver` — run the delivery bookkeeping steps of a branch in order (issue #4180).
//
// Delivering a branch in this repository takes seven mechanical steps that each
// already have their own command: the review marker, the PR gate marker, the PR
// body checklist, the push, opening or updating the pull request, waiting for the
// independent-review verdict, and the merge. This script runs them in that order
// and stops at the first step that fails or that needs a decision from the person
// (or agent) delivering — for example a PR body that still has TODO rows, or a
// review verdict that has not been posted yet. Every step stays callable on its
// own; this is only the conductor.
//
// It never starts a reviewer and never posts a verdict: since #3792 the reviewer
// posts its own verdict comment, and step `wait-verdict` only waits for it.
//
// Usage: see HELP_TEXT below, or docs/reference/cli.md ("pnpm deliver").
//
// Exit codes:
//   0   every selected step finished
//   3   stopped: no independent-review verdict for the current head (before merge)
//   4   stopped: a step needs a decision (BLOCK verdict, missing review input,
//       no branch or PR to work on)
//   64  usage error
//   N   a step's command failed; N is that command's own exit code

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  evaluateMergeReviewGate,
  type ReviewComment,
} from '../src/core/independent-review.js';

export const EXIT_OK = 0;
export const EXIT_NO_VERDICT = 3;
export const EXIT_NEEDS_DECISION = 4;
export const EXIT_USAGE = 64;

/** The ordered step ids. `--from` / `--to` take these names. */
export const STEP_NAMES = [
  'review-marker',
  'pr-gate-marker',
  'pr-body',
  'push',
  'pr',
  'wait-verdict',
  'merge',
] as const;
export type StepName = (typeof STEP_NAMES)[number];

const HELP_TEXT = `pnpm deliver — run the delivery steps of the current branch in order.

Usage:
  pnpm deliver [options]

Steps (in order; the run stops at the first one that fails or needs a decision):
  review-marker   bash scripts/write-review-state-marker.sh (needs --specialists or --bypass-reason)
  pr-gate-marker  bash scripts/write-pr-gate-marker.sh
  pr-body         kookr pr-checklist scaffold into the body file (only if it does not exist yet),
                  then kookr pr-checklist verify --pr-body <file>
  push            git push --set-upstream origin <branch>
  pr              gh pr create, or gh pr edit when the branch already has an open PR
  wait-verdict    wait for the independent-review verdict comment bound to the PR head
  merge           kookr merge <PR>

Options:
  --dry-run               Print the steps and their arguments; run nothing, write nothing.
  --from <step>           Start at this step (resume after a stop).
  --to <step>             Stop after this step.
  --specialists <list>    Review roles that ran, for the approved review marker
                          (for example: independent-review).
  --bypass-reason <text>  Write a bypass review marker with this reason instead.
  --body-file <path>      PR body file (default: .tmp/kookr-deliver-<branch>.md in the
                          repository root, git-ignored).
  --title <text>          PR title (default: subject of the last commit).
  --base <branch>         PR base branch (default: main).
  --repo <owner/name>     Repository for gh and kookr merge (default: the current one).
  --pr <number>           PR number (default: the open PR of the current branch).
  --wait-timeout <sec>    How long wait-verdict waits (default: 1800; 0 checks once).
  --poll-interval <sec>   Seconds between verdict checks (default: 30).
  -h, --help              Show this help.

Exit: 0 done · 3 no verdict for the current head · 4 needs a decision · 64 usage ·
any other code is the exit code of the step command that failed.`;

export interface DeliverOptions {
  dryRun: boolean;
  from: StepName;
  to: StepName;
  specialists?: string;
  bypassReason?: string;
  bodyFile?: string;
  title?: string;
  base: string;
  repo?: string;
  pr?: string;
  waitTimeoutSec: number;
  pollIntervalSec: number;
  help: boolean;
}

export class UsageError extends Error {}

function parseSeconds(flag: string, value: string): number {
  if (!/^\d+$/.test(value)) throw new UsageError(`${flag} must be a whole number of seconds, got: ${value}`);
  return Number(value);
}

function parseStep(flag: string, value: string): StepName {
  if (!(STEP_NAMES as readonly string[]).includes(value)) {
    throw new UsageError(`${flag}: unknown step "${value}" (steps: ${STEP_NAMES.join(', ')})`);
  }
  return value as StepName;
}

export function parseArgs(argv: string[]): DeliverOptions {
  const opts: DeliverOptions = {
    dryRun: false,
    from: STEP_NAMES[0],
    to: STEP_NAMES[STEP_NAMES.length - 1],
    base: 'main',
    waitTimeoutSec: 1800,
    pollIntervalSec: 30,
    help: false,
  };
  // `pnpm deliver -- --dry-run` passes a leading `--` through; ignore it.
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  for (let i = 0; i < args.length; i++) {
    const raw = args[i];
    const eq = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const flag = eq > 0 ? raw.slice(0, eq) : raw;
    const takeValue = (): string => {
      const value = eq > 0 ? raw.slice(eq + 1) : args[i + 1];
      if (value === undefined || value === '' || (eq < 0 && value.startsWith('--'))) {
        throw new UsageError(`${flag} needs a value`);
      }
      if (eq < 0) i++;
      return value;
    };
    switch (flag) {
      case '--dry-run': opts.dryRun = true; break;
      case '-h':
      case '--help': opts.help = true; break;
      case '--from': opts.from = parseStep(flag, takeValue()); break;
      case '--to': opts.to = parseStep(flag, takeValue()); break;
      case '--specialists': opts.specialists = takeValue(); break;
      case '--bypass-reason': opts.bypassReason = takeValue(); break;
      case '--body-file': opts.bodyFile = takeValue(); break;
      case '--title': opts.title = takeValue(); break;
      case '--base': opts.base = takeValue(); break;
      case '--repo': opts.repo = takeValue(); break;
      case '--pr': {
        const v = takeValue();
        if (!/^\d+$/.test(v)) throw new UsageError(`--pr must be a PR number, got: ${v}`);
        opts.pr = v;
        break;
      }
      case '--wait-timeout': opts.waitTimeoutSec = parseSeconds(flag, takeValue()); break;
      case '--poll-interval': opts.pollIntervalSec = parseSeconds(flag, takeValue()); break;
      default: throw new UsageError(`unknown argument: ${raw}`);
    }
  }
  if (STEP_NAMES.indexOf(opts.from) > STEP_NAMES.indexOf(opts.to)) {
    throw new UsageError(`--from ${opts.from} comes after --to ${opts.to}`);
  }
  if (opts.specialists !== undefined && opts.bypassReason !== undefined) {
    throw new UsageError('--specialists and --bypass-reason are mutually exclusive');
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Side-effect boundary. Everything that touches git, gh, the file system or the
// clock goes through these injected functions, so tests can record the calls
// (and the dry-run test can make every one of them throw).

export interface RunResult {
  code: number;
  stdout: string;
}

export interface DeliverDeps {
  /**
   * Run a command with array arguments (never a shell string). `capture: true`
   * returns stdout instead of streaming it to the terminal; stderr always streams.
   */
  run(cmd: string, args: string[], opts?: { capture?: boolean }): RunResult;
  /** Write a file, creating its parent directory when it does not exist. */
  writeFile(path: string, content: string): void;
  fileExists(path: string): boolean;
  sleep(ms: number): Promise<void>;
  now(): number;
  log(line: string): void;
}

export function realDeps(): DeliverDeps {
  return {
    run(cmd, args, opts = {}) {
      const r = spawnSync(cmd, args, {
        stdio: opts.capture ? ['inherit', 'pipe', 'inherit'] : 'inherit',
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      if (r.error) {
        process.stderr.write(`deliver: could not run ${cmd}: ${r.error.message}\n`);
        return { code: 127, stdout: '' };
      }
      return { code: r.status ?? 1, stdout: r.stdout ?? '' };
    },
    writeFile(path, content) {
      // A fresh worktree has no `.tmp/` yet (issue #4200).
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    },
    fileExists: (path) => existsSync(path),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    log: (line) => process.stdout.write(`${line}\n`),
  };
}

// ---------------------------------------------------------------------------
// Steps.

/** Where the repo-local scripts and bin/kookr.js live (this file's checkout). */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export interface Commands {
  bash: string;
  node: string;
  repoRoot: string;
}

const DEFAULT_COMMANDS: Commands = { bash: 'bash', node: process.execPath, repoRoot: REPO_ROOT };

/** A step's outcome. `stop` ends the run with that exit code and message. */
type StepOutcome = { ok: true } | { ok: false; code: number; message: string };

/** Values resolved lazily (git/gh calls), cached across steps of one run. */
interface RunContext {
  opts: DeliverOptions;
  deps: DeliverDeps;
  cmds: Commands;
  branch?: string;
  pr?: string;
}

interface Step {
  name: StepName;
  /** Commands this step would run, for --dry-run. Must not call deps. */
  plan(opts: DeliverOptions, cmds: Commands): string[];
  execute(ctx: RunContext): Promise<StepOutcome>;
}

const P_BRANCH = '<current-branch>';
const P_PR = '<pr>';

function kookr(cmds: Commands, ...args: string[]): [string, string[]] {
  return [cmds.node, [join(cmds.repoRoot, 'bin', 'kookr.js'), ...args]];
}

function repoArgs(opts: DeliverOptions): string[] {
  return opts.repo ? ['--repo', opts.repo] : [];
}

function sanitize(branch: string): string {
  return branch.replace(/[^A-Za-z0-9.-]/g, '_');
}

/**
 * The PR body file. The default sits in the repository's git-ignored `.tmp/`:
 * inside the worktree, because `kookr pr-checklist verify` only reads body files
 * there (issue #4200), and ignored by git, so it does not change the commit the
 * markers are bound to. `branch` is null in a dry run, which prints a placeholder.
 */
export function bodyFilePath(opts: DeliverOptions, cmds: Commands, branch: string | null): string {
  return opts.bodyFile ?? join(cmds.repoRoot, '.tmp', `kookr-deliver-${branch === null ? P_BRANCH : sanitize(branch)}.md`);
}

function show(cmd: string, args: string[]): string {
  return [cmd, ...args].map((a) => (/^[\w@%+=:,./<>-]+$/.test(a) ? a : JSON.stringify(a))).join(' ');
}

function failed(step: StepName, code: number): StepOutcome {
  return { ok: false, code: code === 0 ? 1 : code, message: `step ${step} failed (exit ${code})` };
}

function runStep(ctx: RunContext, step: StepName, cmd: string, args: string[]): StepOutcome {
  ctx.deps.log(`deliver: $ ${show(cmd, args)}`);
  const r = ctx.deps.run(cmd, args);
  return r.code === 0 ? { ok: true } : failed(step, r.code);
}

function capture(ctx: RunContext, cmd: string, args: string[]): RunResult {
  return ctx.deps.run(cmd, args, { capture: true });
}

function resolveBranch(ctx: RunContext): string | null {
  if (ctx.branch) return ctx.branch;
  const r = capture(ctx, 'git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = r.stdout.trim();
  if (r.code !== 0 || !branch || branch === 'HEAD') return null;
  ctx.branch = branch;
  return branch;
}

/** The open PR of the current branch, or `--pr`. Null when there is none. */
function resolvePr(ctx: RunContext): string | null {
  if (ctx.pr) return ctx.pr;
  if (ctx.opts.pr) return (ctx.pr = ctx.opts.pr);
  const branch = resolveBranch(ctx);
  if (!branch) return null;
  const r = capture(ctx, 'gh', [
    'pr', 'list', '--head', branch, '--state', 'open', '--json', 'number', '--jq', '.[0].number // empty',
    ...repoArgs(ctx.opts),
  ]);
  const n = r.stdout.trim();
  if (r.code !== 0 || !/^\d+$/.test(n)) return null;
  ctx.pr = n;
  return n;
}

const noBranch = (step: StepName): StepOutcome => ({
  ok: false,
  code: EXIT_NEEDS_DECISION,
  message: `step ${step}: cannot resolve the current branch (detached HEAD?) — check out the branch to deliver`,
});

function reviewMarkerArgs(opts: DeliverOptions, cmds: Commands): string[] | null {
  const script = join(cmds.repoRoot, 'scripts', 'write-review-state-marker.sh');
  if (opts.bypassReason !== undefined) return [script, '--status', 'bypass', '--reason', opts.bypassReason];
  if (opts.specialists !== undefined) return [script, '--status', 'approved', '--specialists', opts.specialists];
  return null;
}

export const STEPS: readonly Step[] = [
  {
    name: 'review-marker',
    plan(opts, cmds) {
      const args = reviewMarkerArgs(opts, cmds);
      return args
        ? [show(cmds.bash, args)]
        : ['(stops: pass --specialists <roles> once the review was started, or --bypass-reason <text>)'];
    },
    async execute(ctx) {
      const args = reviewMarkerArgs(ctx.opts, ctx.cmds);
      if (!args) {
        // The marker is signed and says a review was started on this head. This
        // command never starts one, so it does not write the marker by default.
        return {
          ok: false,
          code: EXIT_NEEDS_DECISION,
          message:
            'step review-marker needs a decision: start the independent reviewer on HEAD, then pass ' +
            '--specialists independent-review (or --bypass-reason "<why>" for a trivial change)',
        };
      }
      return runStep(ctx, 'review-marker', ctx.cmds.bash, args);
    },
  },
  {
    name: 'pr-gate-marker',
    plan: (_opts, cmds) => [show(cmds.bash, [join(cmds.repoRoot, 'scripts', 'write-pr-gate-marker.sh')])],
    async execute(ctx) {
      return runStep(ctx, 'pr-gate-marker', ctx.cmds.bash, [join(ctx.cmds.repoRoot, 'scripts', 'write-pr-gate-marker.sh')]);
    },
  },
  {
    name: 'pr-body',
    plan(opts, cmds) {
      const file = bodyFilePath(opts, cmds, null);
      return [
        `${show(...kookr(cmds, 'pr-checklist', 'scaffold', '--base', opts.base))} > ${file}   (only if ${file} does not exist)`,
        show(...kookr(cmds, 'pr-checklist', 'verify', '--pr-body', file, '--base', opts.base)),
      ];
    },
    async execute(ctx) {
      const branch = resolveBranch(ctx);
      if (!branch) return noBranch('pr-body');
      const file = bodyFilePath(ctx.opts, ctx.cmds, branch);
      if (ctx.deps.fileExists(file)) {
        // An existing body is the one being edited after an earlier stop: keep it.
        ctx.deps.log(`deliver: PR body ${file} exists — verifying it as is`);
      } else {
        const [cmd, args] = kookr(ctx.cmds, 'pr-checklist', 'scaffold', '--base', ctx.opts.base);
        ctx.deps.log(`deliver: $ ${show(cmd, args)} > ${file}`);
        const r = ctx.deps.run(cmd, args, { capture: true });
        if (r.code !== 0) return failed('pr-body', r.code);
        ctx.deps.writeFile(file, r.stdout);
      }
      const [cmd, args] = kookr(ctx.cmds, 'pr-checklist', 'verify', '--pr-body', file, '--base', ctx.opts.base);
      const outcome = runStep(ctx, 'pr-body', cmd, args);
      if (!outcome.ok) {
        return {
          ...outcome,
          message: `${outcome.message} — edit ${file} (replace each TODO, write the summary), then rerun with --from pr-body`,
        };
      }
      return outcome;
    },
  },
  {
    name: 'push',
    plan: () => [show('git', ['push', '--set-upstream', 'origin', P_BRANCH])],
    async execute(ctx) {
      const branch = resolveBranch(ctx);
      if (!branch) return noBranch('push');
      return runStep(ctx, 'push', 'git', ['push', '--set-upstream', 'origin', branch]);
    },
  },
  {
    name: 'pr',
    plan(opts, cmds) {
      const file = bodyFilePath(opts, cmds, null);
      const title = opts.title ?? '<last commit subject>';
      return [
        `${show('gh', ['pr', 'list', '--head', P_BRANCH, '--state', 'open', ...repoArgs(opts)])}   (find the open PR)`,
        `${show('gh', ['pr', 'create', '--base', opts.base, '--head', P_BRANCH, '--title', title, '--body-file', file, ...repoArgs(opts)])}   (no open PR)`,
        `${show('gh', ['pr', 'edit', opts.pr ?? P_PR, '--title', title, '--body-file', file, ...repoArgs(opts)])}   (open PR exists)`,
      ];
    },
    async execute(ctx) {
      const branch = resolveBranch(ctx);
      if (!branch) return noBranch('pr');
      const file = bodyFilePath(ctx.opts, ctx.cmds, branch);
      if (!ctx.deps.fileExists(file)) {
        return { ok: false, code: EXIT_NEEDS_DECISION, message: `step pr: PR body ${file} is missing — run --from pr-body first` };
      }
      let title = ctx.opts.title;
      if (!title) {
        const r = capture(ctx, 'git', ['log', '-1', '--format=%s']);
        if (r.code !== 0) return failed('pr', r.code);
        title = r.stdout.trim();
      }
      const existing = resolvePr(ctx);
      if (existing) {
        return runStep(ctx, 'pr', 'gh', ['pr', 'edit', existing, '--title', title, '--body-file', file, ...repoArgs(ctx.opts)]);
      }
      return runStep(ctx, 'pr', 'gh', [
        'pr', 'create', '--base', ctx.opts.base, '--head', branch, '--title', title, '--body-file', file, ...repoArgs(ctx.opts),
      ]);
    },
  },
  {
    name: 'wait-verdict',
    plan(opts) {
      return [
        `${show('gh', ['pr', 'view', opts.pr ?? P_PR, '--json', 'comments,commits', ...repoArgs(opts)])}` +
          `   (every ${opts.pollIntervalSec}s for up to ${opts.waitTimeoutSec}s, until a verdict bound to the PR head)`,
      ];
    },
    async execute(ctx) {
      const pr = resolvePr(ctx);
      if (!pr) {
        return { ok: false, code: EXIT_NEEDS_DECISION, message: 'step wait-verdict: no open PR for this branch (pass --pr <number>)' };
      }
      const { opts, deps } = ctx;
      const deadline = deps.now() + opts.waitTimeoutSec * 1000;
      let lastReason = '';
      for (;;) {
        const r = capture(ctx, 'gh', ['pr', 'view', pr, '--json', 'comments,commits', ...repoArgs(opts)]);
        if (r.code !== 0) return failed('wait-verdict', r.code);
        const state = verdictState(r.stdout);
        if (state.kind === 'pass') {
          deps.log(`deliver: PR #${pr}: independent-review PASS for head ${state.head.slice(0, 12)}`);
          return { ok: true };
        }
        if (state.kind === 'block') {
          return {
            ok: false,
            code: EXIT_NEEDS_DECISION,
            message: `step wait-verdict: ${state.reason} — fix or rebut the findings, push, and rerun with --from review-marker`,
          };
        }
        lastReason = state.reason;
        if (deps.now() >= deadline) break;
        deps.log(`deliver: PR #${pr}: waiting for the verdict (${state.reason})`);
        await deps.sleep(opts.pollIntervalSec * 1000);
      }
      return {
        ok: false,
        code: EXIT_NO_VERDICT,
        message: `step wait-verdict: no independent-review verdict for the PR head after ${opts.waitTimeoutSec}s (${lastReason}) — not merging; rerun with --from wait-verdict`,
      };
    },
  },
  {
    name: 'merge',
    plan: (opts, cmds) => [show(...kookr(cmds, 'merge', opts.pr ?? P_PR, ...repoArgs(opts)))],
    async execute(ctx) {
      const pr = resolvePr(ctx);
      if (!pr) return { ok: false, code: EXIT_NEEDS_DECISION, message: 'step merge: no open PR for this branch (pass --pr <number>)' };
      const [cmd, args] = kookr(ctx.cmds, 'merge', pr, ...repoArgs(ctx.opts));
      return runStep(ctx, 'merge', cmd, args);
    },
  },
];

export type VerdictState =
  | { kind: 'pass'; head: string }
  | { kind: 'block'; reason: string }
  | { kind: 'wait'; reason: string };

/**
 * Classify `gh pr view --json comments,commits` output with the same decision
 * table `kookr merge` uses (evaluateMergeReviewGate), except that a BLOCK bound
 * to an older head means "wait": after a fix is pushed, the old BLOCK stays the
 * latest verdict until the reviewer posts on the new head. A BLOCK that names no
 * head cannot be tied to an older one, so it stops the run like a current one.
 */
export function verdictState(viewJson: string): VerdictState {
  let view: { comments?: Array<{ body?: string; createdAt?: string }>; commits?: Array<{ oid?: string }> };
  try {
    view = JSON.parse(viewJson);
  } catch {
    return { kind: 'wait', reason: 'unreadable gh pr view output' };
  }
  const head = (view.commits?.at(-1)?.oid ?? '').toLowerCase();
  if (!head) return { kind: 'wait', reason: 'PR head SHA unknown' };
  const comments: ReviewComment[] = (view.comments ?? []).map((c) => ({ body: c.body ?? '', createdAt: c.createdAt }));
  const gate = evaluateMergeReviewGate({ comments, labels: [], headSha: head });
  if (gate.allowed) return { kind: 'pass', head };
  if (gate.code === 'sticky-block' || (gate.code === 'blocked-finding' && (gate.verdict?.headSha === head || !gate.verdict?.headSha))) {
    return { kind: 'block', reason: `independent-review verdict is BLOCK for head ${head.slice(0, 12)}` };
  }
  return { kind: 'wait', reason: gate.code };
}

export function selectSteps(opts: DeliverOptions): Step[] {
  const from = STEP_NAMES.indexOf(opts.from);
  const to = STEP_NAMES.indexOf(opts.to);
  return STEPS.filter((s) => {
    const i = STEP_NAMES.indexOf(s.name);
    return i >= from && i <= to;
  });
}

/** Print the plan. Calls nothing but `log`. */
export function dryRun(opts: DeliverOptions, log: (line: string) => void, cmds: Commands = DEFAULT_COMMANDS): void {
  log('deliver --dry-run: these steps would run, in order (nothing is executed):');
  selectSteps(opts).forEach((step, i) => {
    log(`${i + 1}. ${step.name}`);
    for (const line of step.plan(opts, cmds)) log(`     ${line}`);
  });
}

export async function deliver(
  opts: DeliverOptions,
  deps: DeliverDeps,
  cmds: Commands = DEFAULT_COMMANDS,
): Promise<number> {
  if (opts.dryRun) {
    dryRun(opts, deps.log, cmds);
    return EXIT_OK;
  }
  const ctx: RunContext = { opts, deps, cmds };
  for (const step of selectSteps(opts)) {
    deps.log(`deliver: ▶ ${step.name}`);
    let outcome: StepOutcome;
    try {
      outcome = await step.execute(ctx);
    } catch (error) {
      // An unexpected throw (a file write, say) ends the run like a failed step,
      // with the usual stop line, not an uncaught stack trace.
      const reason = error instanceof Error ? error.message : String(error);
      outcome = { ok: false, code: 1, message: `step ${step.name} threw: ${reason}` };
    }
    if (!outcome.ok) {
      deps.log(`deliver: ✖ stopped at ${step.name}: ${outcome.message}`);
      return outcome.code;
    }
    deps.log(`deliver: ✔ ${step.name}`);
  }
  deps.log(`deliver: done (${opts.from} → ${opts.to})`);
  return EXIT_OK;
}

export async function main(argv = process.argv.slice(2), deps: DeliverDeps = realDeps()): Promise<number> {
  let opts: DeliverOptions;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`deliver: ${error.message}\n\n${HELP_TEXT}\n`);
      return EXIT_USAGE;
    }
    throw error;
  }
  if (opts.help) {
    deps.log(HELP_TEXT);
    return EXIT_OK;
  }
  return deliver(opts, deps);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code));
}
