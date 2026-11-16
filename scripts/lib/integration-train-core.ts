// Integration train: decision logic (issue #3788).
//
// Pull requests merge into an integration branch (named in
// `.kookr/delivery-gate.json` on origin/main). The train is a deterministic
// loop, not an agent: it runs the full verify on the integration head,
// fast-forwards `main` to that exact SHA when green, and on red finds the
// offending commit by bisection and reverts it on the integration branch.
// The invariant it protects: `main` only ever receives a SHA the train itself
// verified green.
//
// Every side effect is injected through `TrainDeps` so the whole policy can be
// tested against real git in temp directories with a fake verify. This file
// must not import child_process, fs or the network.

import { parseIntegrationBranch } from '../../src/core/integration-branch.js';
import { AUTOMATION_MARKER } from '../../src/core/opinion-requests.js';

/** Mirrors `delivery_gate_integration_branch` in scripts/lib/delivery-gate.sh. */
export { parseIntegrationBranch };

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface VerifyResult {
  ok: boolean;
  /** Last lines of the verify output; used in issue comments when red. */
  tail: string;
  /**
   * True when the suite never ran: the checkout or the dependency install
   * failed. That says nothing about the commit, so the train halts instead of
   * treating it as a red test and bisecting.
   */
  infra?: boolean;
  /**
   * What scripts/verify.sh wrote to its report file for this run (issue
   * #3995), or undefined when it wrote none (killed, an older verify.sh, a
   * failed checkout or install, or a report that does not parse).
   */
  report?: VerifyReport;
}

/** One failed step of a verify run, as scripts/verify-report.mjs names it. */
export interface VerifyFailure {
  /** Lane function in scripts/verify.sh (`static_checks`, `unit_lane`, ...). */
  lane: string;
  /** Label the step prints after `==>`. */
  step: string;
  /** What the step runs (`pnpm validate:docs-env-vars`, or `unit_tests` for the unit lane). */
  command: string;
  /** Unit lane only, and only when the run summary named every failing file. */
  testFiles?: string[];
}

/** The machine-readable result of one scripts/verify.sh run (format: scripts/verify-report.mjs). */
export interface VerifyReport {
  head: string;
  status: 'passed' | 'failed' | 'interrupted';
  failures: VerifyFailure[];
}

/**
 * A narrow verify (issue #3995): only these steps of scripts/verify.sh, and
 * for the unit lane only these test files. The server build always runs too.
 */
export interface VerifyScope {
  /** Step commands, as `VerifyFailure.command` names them. */
  steps: string[];
  /** Unit test files; set exactly when `steps` includes `unit_tests`. */
  testFiles: string[];
}

/** The unit lane's step command in scripts/verify.sh. */
const UNIT_STEP = 'unit_tests';

/** Parses a verify report file; null when it is not one this train can trust. */
export function parseVerifyReport(text: string): VerifyReport | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { version?: unknown; head?: unknown; status?: unknown; failures?: unknown };
  if (r.version !== 1 || typeof r.head !== 'string') return null;
  if (r.status !== 'passed' && r.status !== 'failed' && r.status !== 'interrupted') return null;
  if (!Array.isArray(r.failures)) return null;
  const failures: VerifyFailure[] = [];
  for (const f of r.failures as unknown[]) {
    if (!f || typeof f !== 'object') return null;
    const { lane, step, command, testFiles } = f as Record<string, unknown>;
    if (typeof lane !== 'string' || typeof step !== 'string' || typeof command !== 'string') return null;
    const failure: VerifyFailure = { lane, step, command };
    if (testFiles !== undefined) {
      if (!Array.isArray(testFiles) || !testFiles.every((t) => typeof t === 'string' && t !== '')) return null;
      failure.testFiles = testFiles as string[];
    }
    failures.push(failure);
  }
  return { head: r.head, status: r.status, failures };
}

/**
 * The narrow verify for a head that failed twice, from the reports of both
 * red runs, or null when the failing part cannot be identified and the train
 * must bisect with the full suite. Null when a report is missing, describes
 * another commit, did not fail (`interrupted`: a signal stopped the run, so the
 * steps it lists as unfinished did not fail), or names no failing step; when a
 * unit-lane failure does not name its test files; or when the two runs share
 * no failing step. Only what failed in both runs is kept: a step or a test
 * file that failed once is noise the bisect must not chase.
 */
export function narrowScope(reports: ReadonlyArray<VerifyReport | undefined>, head: string): VerifyScope | null {
  if (reports.length === 0) return null;
  let steps: Set<string> | null = null;
  let files: Set<string> | null = null;
  for (const report of reports) {
    if (!report || report.head !== head || report.status !== 'failed' || report.failures.length === 0) return null;
    const runSteps = new Set<string>();
    const runFiles = new Set<string>();
    for (const f of report.failures) {
      // One per line in the narrow run's environment, so no line breaks.
      if (f.command.trim() === '' || f.command.includes('\n')) return null;
      if (f.command === UNIT_STEP) {
        if (!f.testFiles || f.testFiles.length === 0 || f.testFiles.some((t) => t.includes('\n'))) return null;
        for (const t of f.testFiles) runFiles.add(t);
      }
      runSteps.add(f.command);
    }
    const prevSteps: Set<string> | null = steps;
    const prevFiles: Set<string> | null = files;
    steps = prevSteps === null ? runSteps : new Set(Array.from(prevSteps).filter((c) => runSteps.has(c)));
    files = prevFiles === null ? runFiles : new Set(Array.from(prevFiles).filter((t) => runFiles.has(t)));
  }
  if (steps === null || files === null || steps.size === 0) return null;
  if (steps.has(UNIT_STEP) && files.size === 0) return null;
  return { steps: Array.from(steps).sort(), testFiles: steps.has(UNIT_STEP) ? Array.from(files).sort() : [] };
}

/** One line naming a scope, for the train log. */
function describeScope(scope: VerifyScope): string {
  return scope.steps.map((c) => (c === UNIT_STEP ? `${c} (${scope.testFiles.join(', ')})` : c)).join('; ');
}

export interface ClosingIssue {
  number: number;
  state: 'open' | 'closed';
}

export interface TrainGithub {
  closingIssues(pr: number): Promise<ClosingIssue[]>;
  reopenIssue(issue: number): Promise<void>;
  closeIssue(issue: number, comment: string): Promise<void>;
  commentIssue(issue: number, body: string): Promise<void>;
  /**
   * Comments on pull request `pr`, unless one of its comments already contains
   * `marker`. The marker names the event and the commit, so a retried or
   * restarted cycle never posts the same report twice.
   */
  commentPullRequest(pr: number, marker: string, body: string): Promise<void>;
}

/** What `kookr spawn` did with a fix-task request. */
export interface TrainSpawnResult {
  /**
   * True when the server returned the task it already holds for this
   * idempotency key instead of starting a new one. `kookr spawn` itself
   * re-sends a request that timed out, so this does not prove that an
   * earlier run of the train used the key.
   */
  replayed: boolean;
  /** Id of the task started or replayed, when the server named it. */
  taskId?: string | null;
}

/**
 * Reads the outcome of `kookr spawn --json` (one JSON envelope on stdout:
 * `{ ok, code, message, details }`). Throws, so the train says
 * `fix-spawn-failed` rather than assume a fix task is on its way, when the
 * spawn failed, when it exited 0 without an envelope that names a task, and
 * when the key returned a task that was terminated or cancelled.
 */
export function parseSpawnOutput(r: GitResult): TrainSpawnResult {
  let envelope: {
    ok?: unknown; message?: unknown;
    details?: { taskId?: unknown; idempotentReplay?: unknown; task?: { status?: unknown } };
  } | null = null;
  for (const line of r.stdout.split('\n').reverse()) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    try { envelope = JSON.parse(text); break; } catch { /* not the envelope */ }
  }
  const message = typeof envelope?.message === 'string' ? envelope.message : '';
  if (!r.ok) throw new Error(`kookr spawn failed: ${message || r.stderr.trim()}`);
  const details = envelope?.details;
  if (envelope?.ok !== true || !details || typeof details.taskId !== 'string' || details.taskId === '') {
    throw new Error(`kookr spawn exited 0 without naming a task: ${(r.stdout.trim() || r.stderr.trim()).slice(-300)}`);
  }
  const replayed = details.idempotentReplay === true;
  // The server also replays a task whose launch failed (it keeps the key on
  // the disposed task). That task does no work, so it is no fix task.
  const status = details.task?.status;
  if (replayed && (status === 'terminated' || status === 'cancelled')) {
    throw new Error(`kookr spawn returned task ${details.taskId} for this key, which is ${status}: no fix task is running`);
  }
  return { replayed, taskId: details.taskId };
}

export interface TrainSpawner {
  spawn(request: { idempotencyKey: string; prompt: string }): Promise<TrainSpawnResult>;
}

export type TrainEventKind =
  | 'halted'
  | 'reverted'
  | 'fix-budget-exhausted'
  | 'fix-spawn-failed'
  /** A verified revert's push was rejected twice in a row; the train keeps re-applying it. */
  | 'revert-push-rejected'
  /** Commits reached main without the train (informational; nothing halts). */
  | 'main-bypassed';

export interface TrainNotifier {
  /** Something needs a human: raise an alert. */
  notify(kind: TrainEventKind, detail: string): Promise<void>;
  /** The train is healthy again (an idle, promoting or reconciling cycle): clear the alert. */
  healthy(): Promise<void>;
}

export interface TrainHalt {
  reason: string;
  main: string;
  integration: string;
  at: string;
}

/**
 * A culprit the train confirmed (red twice) but whose revert is not on the
 * integration branch yet (issue #4014). Saved as soon as it is confirmed, so a
 * rejected push, a restart or a crash resumes at the revert instead of
 * bisecting again.
 */
export interface PendingRevert {
  culprit: string;
  /** True once a revert of the culprit passed the full suite. */
  verified: boolean;
  /** Failing output of the culprit, quoted in the issue and fix-task texts. */
  failTail: string;
  /** Revert pushes rejected in a row for this culprit. */
  rejections: number;
  /** The `revert-push-rejected` alert was sent for this culprit. */
  alerted: boolean;
  /**
   * Integration head last verified red with the culprit on it, or null when
   * unknown (a state file written before #4031). A later cycle that finds the
   * head moved verifies it before reverting: a fix pushed by hand meanwhile
   * may have made the revert unnecessary.
   */
  redHead: string | null;
}

export interface TrainState {
  halted: TrainHalt | null;
  /** SHAs the train verified green (newest last, capped). */
  verifiedGreen: string[];
  /** Heads that were red once and green on the immediate re-run. */
  flakyHeads: string[];
  /**
   * Fix-task budget: key -> automatic re-lands already spawned, at most
   * `MAX_AUTOMATIC_RELANDS`. The key is the linked issue (`issue-<n>`) when the
   * reverted PR has one, because a re-land is a new PR with a new number but
   * closes the same issue. Otherwise it is `ref-<n>`, where `<n>` is the first
   * reference in the commit subject, or the PR number when there is none.
   * A count is never cleared, so it covers every revert of that issue, not
   * only the current one.
   */
  fixTasks: Record<string, number>;
  /**
   * True from the first alert until a healthy cycle has reported recovery, so
   * "recovered" is sent once per problem, never while still halted, and never
   * on an ordinary idle cycle.
   */
  alerting: boolean;
  /** Consecutive cycles that ended on a rejected push; reset by a successful push. */
  pushRejections: number;
  /** A confirmed culprit whose revert still has to be pushed, or null. */
  pendingRevert: PendingRevert | null;
}

export interface TrainStateStore {
  load(): TrainState;
  save(state: TrainState): void;
}

export interface TrainDeps {
  /** Runs git inside the train's dedicated worktree. */
  git(args: string[]): Promise<GitResult>;
  /** Writes a file at `path`, relative to the train's worktree (the plugin version bump). */
  writeFile(path: string, content: string): Promise<void>;
  /**
   * Verifies the given SHA (checks it out in the worktree, runs the suite).
   * With a scope, runs only that part of the suite (issue #3995). A narrow
   * green proves nothing about the rest, so the train never promotes on one.
   */
  verify(sha: string, scope?: VerifyScope): Promise<VerifyResult>;
  github: TrainGithub;
  spawner: TrainSpawner;
  notifier: TrainNotifier;
  state: TrainStateStore;
  log(message: string): void;
  now(): Date;
}

export type CycleOutcome =
  | 'not-configured'
  | 'fetch-failed'
  | 'halted'
  | 'idle'
  | 'reconciled'
  /** The train pushed a plugin version bump to the integration branch; the next cycle verifies it. */
  | 'version-bumped'
  | 'promoted'
  | 'reverted'
  | 'retry';

export interface CycleResult {
  outcome: CycleOutcome;
  /** Reason code when this cycle halted, or the standing halt reason. */
  reason?: string;
  detail?: string;
}

/** Thrown by the cycle's verify wrapper when the suite could not run at all. */
class VerifyInfraError extends Error {}

const VERIFIED_GREEN_CAP = 200;
const FLAKY_CAP = 50;
const COMMENT_TAIL_LINES = 60;
const COMMENT_TAIL_CHARS = 4000;
/** How far back main's history is searched for a commit the train verified. */
const UNVERIFIED_SCAN = 50;
/** Commit subjects listed in a notification about commits that skipped the train. */
const LISTED_SUBJECTS = 20;
/** Cycles in a row that may end on a rejected push before the train halts. */
export const PUSH_REJECT_LIMIT = 3;
/**
 * Times one cycle re-applies a rejected revert on the moved integration head
 * and pushes it again, before it leaves the revert to the next cycle.
 */
export const REVERT_REAPPLY_ATTEMPTS = 3;
/** Revert pushes rejected in a row before the operator is alerted (once per culprit). */
const REVERT_REJECT_ALERT = 2;
/**
 * Halts that keep a remembered culprit: they say nothing about it (the suite
 * or git could not run, a push was refused, a merge of main conflicted). Every
 * other halt drops it, so the cycle after a person clears the halt starts over.
 */
const HALTS_KEEPING_PENDING_REVERT = new Set(['verify-infra', 'push-rejected', 'train-error', 'reconcile-conflict']);

export function emptyTrainState(): TrainState {
  return {
    halted: null, verifiedGreen: [], flakyHeads: [], fixTasks: {}, alerting: false, pushRejections: 0,
    pendingRevert: null,
  };
}

function normalizePendingRevert(raw: unknown): PendingRevert | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Partial<PendingRevert>;
  if (typeof p.culprit !== 'string' || !/^[0-9a-f]{40}$/.test(p.culprit)) return null;
  return {
    culprit: p.culprit,
    verified: p.verified === true,
    failTail: typeof p.failTail === 'string' ? p.failTail : '',
    rejections: Number.isInteger(p.rejections) && (p.rejections as number) > 0 ? p.rejections as number : 0,
    alerted: p.alerted === true,
    redHead: typeof p.redHead === 'string' && /^[0-9a-f]{40}$/.test(p.redHead) ? p.redHead : null,
  };
}

export function normalizeTrainState(raw: Partial<TrainState> | null | undefined): TrainState {
  const base = emptyTrainState();
  if (!raw || typeof raw !== 'object') return base;
  return {
    halted: raw.halted ?? null,
    verifiedGreen: Array.isArray(raw.verifiedGreen) ? raw.verifiedGreen : base.verifiedGreen,
    flakyHeads: Array.isArray(raw.flakyHeads) ? raw.flakyHeads : base.flakyHeads,
    fixTasks: raw.fixTasks && typeof raw.fixTasks === 'object' ? raw.fixTasks : base.fixTasks,
    alerting: raw.alerting === true,
    pushRejections: Number.isInteger(raw.pushRejections) && (raw.pushRejections as number) > 0
      ? raw.pushRejections as number
      : 0,
    pendingRevert: normalizePendingRevert(raw.pendingRevert),
  };
}

/** Trailing `(#123)` of a squash-merge subject. */
export function prNumberFromSubject(subject: string): number | null {
  const m = /\(#(\d+)\)\s*$/.exec(subject.trim());
  return m ? Number(m[1]) : null;
}

/**
 * The first `(#N)` in a squash subject. By this repo's convention that is the
 * issue (`fix: … (#issue) (#pr)`), and a re-land made by cherry-picking keeps
 * the original subject in front of its own PR number, so this reference stays
 * the same across re-lands where the trailing PR number does not.
 */
export function firstReferenceFromSubject(subject: string): number | null {
  const m = /\(#(\d+)\)/.exec(subject);
  return m ? Number(m[1]) : null;
}

/**
 * The prose of a pull request body: what is left after removing everything a
 * reader does not see as a sentence of the author's. Fenced code blocks at any
 * indentation (an unclosed one runs to the end), indented code blocks (4+
 * spaces after a blank line, outside a list), quoted lines (`>`) with the
 * lines that continue them, and inline code spans (which may wrap onto the
 * next line) are removed first, then HTML comments and `<pre>` blocks (an
 * unclosed one runs to the end). Code goes first so that a `<!--` written as
 * code does not hide the rest. A body that
 * quotes a commit list such as `fix: resolve #77 crash` inside a code block
 * then closes nothing. `body_closing_numbers` in scripts/kookr-merge.sh applies
 * the same rules; the two are tested against one table of bodies.
 */
export function prBodyProse(text: string): string {
  const kept: string[] = [];
  let fence: string | null = null;
  let prevBlank = true; // the start of the body counts as after a blank line
  let indentedCode = false;
  let quote = false;
  let list = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    // Any indentation: a fence inside a nested list item is indented 4+ spaces.
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1] ?? null;
    const blank = line.trim() === '';
    const indented = /^( {4}|\t)/.test(line);
    if (fence !== null) {
      // A closing fence: the same character, at least as long, nothing after it.
      if (marker !== null && marker[0] === fence[0] && marker.length >= fence.length && /^\s*[`~]+\s*$/.test(line)) {
        fence = null;
        prevBlank = true;
      }
      continue;
    }
    if (indentedCode && (blank || indented)) {
      prevBlank = blank;
      continue;
    }
    indentedCode = false;
    if (marker !== null) {
      fence = marker;
      quote = false;
      continue;
    }
    if (blank) {
      prevBlank = true;
      quote = false;
      kept.push(line);
      continue;
    }
    // An indented code block starts after a blank line, outside a list (where
    // indentation continues the list item instead).
    if (indented && prevBlank && !list) {
      indentedCode = true;
      prevBlank = false;
      continue;
    }
    prevBlank = false;
    if (/^\s*>/.test(line)) {
      quote = true;
      continue;
    }
    const item = /^\s*(?:[-*+]|\d{1,9}[.)])\s/.test(line);
    // A line right after a quoted line continues the quote ("lazy"
    // continuation) unless it starts a list item or a heading.
    if (quote && !item && !/^\s{0,3}#{1,6}(\s|$)/.test(line)) continue;
    quote = false;
    if (item) list = true;
    else if (!indented) list = false;
    kept.push(line);
  }
  return kept.join('\n')
    // Inline code may wrap onto the next line, but never across a blank line.
    .replace(/(`+)(?:(?!\n[ \t]*\n)[\s\S])*?\1/g, ' ')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    .replace(/<pre(?:\s[^>]*)?>[\s\S]*?(?:<\/pre\s*>|$)/gi, ' ');
}

/**
 * Issue numbers a pull request body closes by the standard keywords
 * (`close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved`, any case,
 * an optional colon, then `#<number>`). GitHub reports no closing references for
 * a pull request whose base is not the default branch, which is every pull
 * request once they target the integration branch, so the train reads the body
 * itself. Only the prose counts (see `prBodyProse`): code, comments and quotes
 * are ignored. `owner/repo#n`, URLs, numbers longer than 9 digits and a keyword
 * that is only the end of a longer word (`prefixes #3`) are ignored too. A
 * number may still be a pull request; the caller checks that with GitHub.
 */
export function closingIssueNumbersFromText(text: string): number[] {
  const re = /(?<![A-Za-z0-9_])(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s*:?\s+#(\d+)(?![A-Za-z0-9_])/gi;
  const found: number[] = [];
  for (const m of prBodyProse(text).matchAll(re)) {
    if (m[1].length > 9) continue;
    const n = Number(m[1]);
    if (n > 0 && !found.includes(n)) found.push(n);
  }
  return found;
}

/**
 * True when a failed `pnpm install --frozen-lockfile` failed because the lockfile
 * does not match package.json. That is a defect of the commit (it can be
 * bisected and reverted), not an outage of the machine.
 */
export function isOutdatedLockfileFailure(installOutput: string): boolean {
  return installOutput.includes('ERR_PNPM_OUTDATED_LOCKFILE');
}

/** The kookr-toolkit plugin manifest whose `version` the train bumps (issue #3793). */
export const PLUGIN_JSON_PATH = 'plugin/.claude-plugin/plugin.json';

/** Trailer on the train's plugin version bump commits. */
export const TRAIN_VERSION_BUMP_TRAILER = 'Kookr-Integration-Train: plugin-version-bump';

const PLUGIN_VERSION_RE = /("version"\s*:\s*")([^"]*)(")/;

/** The `version` value of a plugin.json text, or null when it has none. */
export function pluginVersionOf(json: string): string | null {
  return PLUGIN_VERSION_RE.exec(json)?.[2] ?? null;
}

/** `MAJOR.MINOR.PATCH` as numbers, or null for anything else (pre-release tags included). */
function versionParts(version: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * The version the integration head must ship, or null when it needs no bump.
 * A bump is needed when the head's version is not numerically greater than
 * main's (`0.16.114` is greater than `0.16.99`). The new version is main's with
 * the patch number plus one. Null too when either value is not a plain
 * `MAJOR.MINOR.PATCH`: the train does not guess, a person bumps by hand.
 */
export function nextPluginVersion(mainVersion: string, headVersion: string): string | null {
  const m = versionParts(mainVersion);
  const h = versionParts(headVersion);
  if (!m || !h) return null;
  for (let i = 0; i < 3; i++) {
    if (h[i] > m[i]) return null;
    if (h[i] < m[i]) break;
  }
  return `${m[0]}.${m[1]}.${m[2] + 1}`;
}

/** The plugin.json text with only its first `version` value replaced. */
export function withPluginVersion(json: string, version: string): string {
  return json.replace(PLUGIN_VERSION_RE, (_all, pre: string, _old: string, post: string) => `${pre}${version}${post}`);
}

/** Trailer the train puts on its own revert commits, so it can recognise them later. */
export const TRAIN_REVERT_TRAILER = 'Kookr-Integration-Train: revert';

/**
 * Automatic fix-and-re-land tasks the train starts for one linked issue before
 * it stops and asks for a human (`fix-budget-exhausted`).
 */
export const MAX_AUTOMATIC_RELANDS = 3;

/** Lines of failing output quoted in a pull-request comment (the issue comment quotes more). */
const PR_COMMENT_TAIL_LINES = 20;

/** Hidden marker of the train's pull-request comment about `event` for commit `sha`. */
export function trainPrCommentMarker(event: 'promoted' | 'reverted', sha: string): string {
  return `<!-- kookr-integration-train:${event}:${sha} -->`;
}

/** Posts one train report on a pull request, once per event and commit. Best effort. */
async function commentPullRequestOnce(
  deps: TrainDeps, pr: number, event: 'promoted' | 'reverted', sha: string, lines: string[],
): Promise<void> {
  const marker = trainPrCommentMarker(event, sha);
  await safe(deps, () => deps.github.commentPullRequest(pr, marker, [...lines, '', marker].join('\n')));
}

/**
 * An issue comment of the train's, marked as automation (issue #4033). The
 * train posts with the operator's GitHub account, so `kookr opinion sweep`
 * would otherwise read it as the operator's reply to an opinion request.
 */
export function automationComment(text: string): string {
  return `<!-- ${AUTOMATION_MARKER} -->\n${text}`;
}

/** The comment the train closes an issue with once its change reached main. */
export function verifiedOnMainComment(shortSha: string): string {
  return automationComment(`Verified on main in ${shortSha}.`);
}

export function tailForComment(output: string): string {
  const lines = output.split('\n').slice(-COMMENT_TAIL_LINES).join('\n');
  return lines.length > COMMENT_TAIL_CHARS ? lines.slice(lines.length - COMMENT_TAIL_CHARS) : lines;
}

function pushCapped(list: string[], sha: string, cap: number): void {
  const idx = list.indexOf(sha);
  if (idx >= 0) list.splice(idx, 1);
  list.push(sha);
  while (list.length > cap) list.shift();
}

export async function runTrainCycle(deps: TrainDeps): Promise<CycleResult> {
  const state = normalizeTrainState(deps.state.load());
  try {
    const result = await cycle(deps, state);
    // A standing halt stays quiet: it was announced when it started. Recovery
    // is reported once, by the first healthy cycle after an alert; a failed
    // report is tried again by the next healthy cycle.
    const healthy = result.outcome === 'idle' || result.outcome === 'promoted' || result.outcome === 'reconciled'
      || result.outcome === 'version-bumped';
    if (healthy && state.alerting && !state.halted) {
      const sent = await safe(deps, async () => { await deps.notifier.healthy(); return true; });
      if (sent === true) state.alerting = false;
    }
    return result;
  } finally {
    deps.state.save(state);
  }
}

async function cycle(deps: TrainDeps, state: TrainState): Promise<CycleResult> {
  const { git, log } = deps;
  const out = async (args: string[]): Promise<string> => {
    const r = await git(args);
    if (!r.ok) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
    return r.stdout.trim();
  };

  // A previous cycle may have died mid-merge or mid-revert; start clean.
  await git(['merge', '--abort']);
  await git(['revert', '--abort']);
  await git(['reset', '--hard', '-q']);

  // 1. Fetch and read the configuration from origin/main.
  const fetchMain = await git(['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
  if (!fetchMain.ok) {
    log(`fetch of main failed: ${fetchMain.stderr.trim()}`);
    return { outcome: 'fetch-failed' };
  }
  const config = await git(['show', 'origin/main:.kookr/delivery-gate.json']);
  const integration = config.ok ? parseIntegrationBranch(config.stdout) : null;
  if (!integration) return { outcome: 'not-configured', detail: 'no integration branch configured on origin/main' };

  const remote = await git(['ls-remote', '--heads', 'origin', `refs/heads/${integration}`]);
  if (!remote.ok) {
    log(`ls-remote failed: ${remote.stderr.trim()}`);
    return { outcome: 'fetch-failed' };
  }
  if (remote.stdout.trim() === '') {
    return { outcome: 'not-configured', detail: `origin has no branch ${integration}` };
  }
  const fetchInt = await git([
    'fetch', '--no-tags', 'origin', `+refs/heads/${integration}:refs/remotes/origin/${integration}`,
  ]);
  if (!fetchInt.ok) {
    log(`fetch of ${integration} failed: ${fetchInt.stderr.trim()}`);
    return { outcome: 'fetch-failed' };
  }

  const intRef = `origin/${integration}`;
  let mainSha = '';
  let headSha = '';

  const halt = async (reason: string, main: string, int: string, detail: string): Promise<CycleResult> => {
    state.halted = { reason, main, integration: int, at: deps.now().toISOString() };
    state.pushRejections = 0;
    if (!HALTS_KEEPING_PENDING_REVERT.has(reason)) state.pendingRevert = null;
    log(`HALT ${reason}: ${detail}`);
    await raise(deps, state, 'halted', `${reason}: ${detail}`);
    return { outcome: 'halted', reason, detail };
  };

  try {
    mainSha = await out(['rev-parse', 'origin/main']);
    headSha = await out(['rev-parse', intRef]);
  } catch (err) {
    // The refs cannot even be named, so a standing halt cannot be checked
    // against them. Keep a standing halt quiet; otherwise halt once and tell
    // the operator instead of failing the same way every interval.
    if (state.halted) return { outcome: 'halted', reason: state.halted.reason };
    return halt('train-error', mainSha, headSha, err instanceof Error ? err.message : String(err));
  }

  // 2. Standing halt: only a moved ref clears it.
  if (state.halted) {
    if (state.halted.main === mainSha && state.halted.integration === headSha) {
      return { outcome: 'halted', reason: state.halted.reason };
    }
    log(`halt "${state.halted.reason}" cleared: a ref moved`);
    state.halted = null;
  }

  // Commits on main since the newest commit the train verified, newest first.
  // The train only moves main to a commit it verified, so these reached main
  // without it (a merge straight into main, or a direct push).
  const mainUnverified = !state.verifiedGreen.includes(mainSha);
  const unverifiedOnMain = async (): Promise<string> => {
    const listed = (await out(['log', '--first-parent', `-n${UNVERIFIED_SCAN}`, '--format=%H %s', mainSha]))
      .split('\n').filter(Boolean);
    const lines: string[] = [];
    let found = false;
    for (const line of listed) {
      const sha = line.slice(0, 40);
      if (state.verifiedGreen.includes(sha)) { found = true; break; }
      lines.push(`${sha.slice(0, 10)} ${line.slice(41)}`);
    }
    const shown = lines.slice(0, LISTED_SUBJECTS);
    const more = lines.length - shown.length;
    const tail = found
      ? (more > 0 ? `; and ${more} more` : '')
      : `; no train-verified commit in the last ${listed.length} on main, list may be incomplete`;
    return `${shown.join('; ')}${tail}`;
  };

  // 3. Both branches agree. If the train never verified that commit, main
  // moved without it (#3803): verify main now. Green: record it. Red: halt, so
  // nothing is promoted on top of an unverified red main.
  if (mainSha === headSha) {
    state.pushRejections = 0;
    // Nothing is left on the integration branch to revert.
    state.pendingRevert = null;
    if (!mainUnverified) return { outcome: 'idle' };
    try {
      const r = await deps.verify(mainSha);
      if (r.infra) {
        return halt('verify-infra', mainSha, headSha, `verify could not run for ${mainSha.slice(0, 10)}: ${r.tail.slice(-400)}`);
      }
      log(`verify of unverified main ${mainSha.slice(0, 10)}: ${r.ok ? 'green' : 'red'}`);
      if (r.ok) {
        pushCapped(state.verifiedGreen, mainSha, VERIFIED_GREEN_CAP);
        return { outcome: 'idle', detail: `verified main ${mainSha.slice(0, 10)}, which reached main without the train` };
      }
      return halt(
        'main-unverified-red', mainSha, headSha,
        `main ${mainSha.slice(0, 10)} reached main without the train and fails verify. Commits that reached main without the train: ${await unverifiedOnMain()}`,
      );
    } catch (err) {
      return halt('train-error', mainSha, headSha, err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * A push was rejected. The next cycle retries, but a push that is rejected
   * PUSH_REJECT_LIMIT cycles in a row (branch protection, lost credentials)
   * will not go through by retrying: halt and tell the operator.
   */
  const rejected = async (what: string, push: GitResult): Promise<CycleResult> => {
    log(`${what} rejected: ${push.stderr.trim()}`);
    state.pushRejections += 1;
    if (state.pushRejections >= PUSH_REJECT_LIMIT) {
      return halt(
        'push-rejected', mainSha, headSha,
        `${what} rejected ${state.pushRejections} cycles in a row: ${push.stderr.trim().slice(-300)}`,
      );
    }
    return { outcome: 'retry', detail: `${what} rejected` };
  };
  const push = async (refspec: string): Promise<GitResult> => {
    const r = await pushRef(deps, refspec);
    if (r.ok) state.pushRejections = 0;
    return r;
  };

  // Steps 4 and 5 run inside the same error handler as the decision steps
  // below, so an unexpected git failure halts as train-error.
  const reconcileAndList = async (): Promise<CycleResult | string[]> => {
  // 4. Someone merged straight into main: fold it into the integration branch.
  const ancestor = await git(['merge-base', '--is-ancestor', 'origin/main', intRef]);
  if (!ancestor.ok) {
    // Commits on main the integration branch lacks: the train did not promote them.
    const bypassed = (await out(['log', '--first-parent', '--format=%h %s', `${intRef}..origin/main`]))
      .split('\n').filter(Boolean);
    const bypassList = bypassed.slice(0, LISTED_SUBJECTS).join('; ') +
      (bypassed.length > LISTED_SUBJECTS ? `; and ${bypassed.length - LISTED_SUBJECTS} more` : '');
    await out(['checkout', '--detach', '-q', headSha]);
    const merge = await git(['merge', '--no-edit', 'origin/main']);
    if (!merge.ok) {
      // Only unmerged paths make it a conflict. Anything else (no committer
      // identity, a broken worktree) is an unexpected failure.
      const unmerged = await git(['diff', '--name-only', '--diff-filter=U']);
      await git(['merge', '--abort']);
      if (unmerged.ok && unmerged.stdout.trim() !== '') {
        return halt(
          'reconcile-conflict', mainSha, headSha,
          `merging origin/main into the integration branch conflicts. Commits that reached main without the train: ${bypassList}`,
        );
      }
      return halt('train-error', mainSha, headSha, `merging origin/main into the integration branch failed: ${merge.stderr.trim()}`);
    }
    const pushed = await push(`HEAD:refs/heads/${integration}`);
    if (!pushed.ok) return rejected('reconcile push', pushed);
    log(`reconciled ${integration} with main`);
    // A notice, not an alert: nothing is wrong with the train, but a merge
    // skipped it and the operator should know. Sent once, after the push, so a
    // rejected push that is retried does not repeat it.
    await safe(deps, () => deps.notifier.notify(
      'main-bypassed',
      `${bypassed.length} commit(s) reached main without the integration train: ${bypassList}`,
    ));
    return { outcome: 'reconciled' };
  }

  // 4b. Plugin version (issue #3793). Pull requests no longer bump
  // plugin.json#version: two that bump to the same value ship one change
  // unbumped, and two that bump differently conflict. The train bumps once per
  // promotion instead. It does so here, before verify, so main still only
  // receives a commit the train verified: push the bump and let the next cycle
  // verify and promote it, the way a reconcile does.
  const bumped = await bumpPluginVersion();
  if (bumped) return bumped;

  // 5. Only commits that contain main. After a reconcile merge (step 4) the
  // commits older than that merge do not include main's changes, so "main is
  // green" proves nothing about them: testing them could fail for a reason main
  // already fixed, and an innocent commit would be blamed. `--ancestry-path`
  // leaves the merge commit and everything after it; if the merge itself is the
  // first bad commit the train halts (culprit-is-merge) for a human.
  return (await out([
    'rev-list', '--first-parent', '--ancestry-path', '--reverse', `origin/main..${intRef}`,
  ])).split('\n').filter(Boolean);
  };

  /**
   * When the integration head changes plugin content (anything under plugin/
   * other than plugin.json) and its version is not above main's, commit main's
   * version plus one patch on top of the head and push it to the integration
   * branch. Returns null when no bump is needed or possible.
   */
  const bumpPluginVersion = async (): Promise<CycleResult | null> => {
    const changed = (await out(['diff', '--name-only', mainSha, headSha, '--', 'plugin/']))
      .split('\n').filter((p) => p !== '' && p !== PLUGIN_JSON_PATH);
    if (changed.length === 0) return null;
    const mainJson = await git(['show', `${mainSha}:${PLUGIN_JSON_PATH}`]);
    const headJson = await git(['show', `${headSha}:${PLUGIN_JSON_PATH}`]);
    if (!mainJson.ok || !headJson.ok) return null; // no manifest on one side: nothing to compare
    const mainVersion = pluginVersionOf(mainJson.stdout);
    const headVersion = pluginVersionOf(headJson.stdout);
    if (mainVersion === null || headVersion === null) {
      log(`plugin version bump skipped: no "version" in ${PLUGIN_JSON_PATH}`);
      return null;
    }
    const next = nextPluginVersion(mainVersion, headVersion);
    if (next === null) {
      if (versionParts(mainVersion) === null || versionParts(headVersion) === null) {
        log(`plugin version bump skipped: "${mainVersion}" (main) or "${headVersion}" (head) is not MAJOR.MINOR.PATCH`);
      }
      return null;
    }
    await out(['checkout', '--detach', '-q', headSha]);
    await deps.writeFile(PLUGIN_JSON_PATH, withPluginVersion(headJson.stdout, next));
    await out(['add', '--', PLUGIN_JSON_PATH]);
    await out([
      'commit', '-q', '-m', `chore(plugin): bump kookr-toolkit to ${next}`,
      '-m', `The integration branch changes plugin content since main (${mainVersion}); ` +
        'installed plugins only update when the version changes.',
      '-m', TRAIN_VERSION_BUMP_TRAILER,
    ]);
    const bumpSha = await out(['rev-parse', 'HEAD']);
    // A plain push: if a merge moved the integration branch meanwhile, it is
    // rejected and the next cycle bumps on top of the new head.
    const pushed = await push(`${bumpSha}:refs/heads/${integration}`);
    if (!pushed.ok) return rejected('plugin version bump push', pushed);
    log(`bumped plugin version ${headVersion} -> ${next} on ${integration} (${bumpSha.slice(0, 10)})`);
    return { outcome: 'version-bumped', detail: `plugin version ${next}` };
  };

  // Verify bookkeeping for this cycle. Only full runs (`verify`) are recorded
  // as results or as verified green: a commit is promoted only on a full green.
  const results = new Map<string, boolean>();
  const redTails = new Map<string, string>();
  /** The report of each red full run, per SHA, oldest first (issue #3995). */
  const redReports = new Map<string, Array<VerifyReport | undefined>>();
  const verify = async (sha: string): Promise<boolean> => {
    const r = await deps.verify(sha);
    if (r.infra) throw new VerifyInfraError(`verify could not run for ${sha.slice(0, 10)}: ${r.tail.slice(-400)}`);
    results.set(sha, r.ok);
    if (r.ok) pushCapped(state.verifiedGreen, sha, VERIFIED_GREEN_CAP);
    else {
      redTails.set(sha, r.tail);
      redReports.set(sha, [...(redReports.get(sha) ?? []), r.report]);
    }
    log(`verify ${sha.slice(0, 10)}: ${r.ok ? 'green' : 'red'}`);
    return r.ok;
  };
  /**
   * Runs only `scope` of the suite on `sha` (issue #3995). Its green is no
   * verification: it never reaches `results` or `verifiedGreen`. Its red output
   * is kept, since it is the failure the culprit's issue comment quotes.
   */
  const verifyNarrow = async (sha: string, scope: VerifyScope): Promise<boolean> => {
    const r = await deps.verify(sha, scope);
    if (r.infra) throw new VerifyInfraError(`verify could not run for ${sha.slice(0, 10)}: ${r.tail.slice(-400)}`);
    if (!r.ok) redTails.set(sha, r.tail);
    log(`narrow verify ${sha.slice(0, 10)}: ${r.ok ? 'green' : 'red'}`);
    return r.ok;
  };
  const isGreen = (sha: string): boolean => results.get(sha) === true || state.verifiedGreen.includes(sha);

  /** Fast-forward main to a verified SHA. Returns the push result. */
  const promote = async (sha: string): Promise<GitResult> => {
    if (!isGreen(sha)) throw new Error(`refusing to promote ${sha}: not verified green by the train`);
    const fresh = (await out(['rev-list', '--first-parent', '--reverse', `origin/main..${sha}`]))
      .split('\n').filter(Boolean);
    // --no-verify: the repo's pre-push hook demands a reviewer marker and runs
    // the test suite; the train's push is itself the verified promotion, so it
    // must bypass the hook. Plain fast-forward, never forced.
    const pushed = await push(`${sha}:refs/heads/main`);
    if (!pushed.ok) return pushed;
    mainSha = sha;
    pushCapped(state.verifiedGreen, sha, VERIFIED_GREEN_CAP);
    log(`promoted ${sha.slice(0, 10)} to main`);
    await reportPromoted(deps, fresh, sha, integration);
    return pushed;
  };

  // Steps 4-9. An arrow function, so the narrowed types above stay narrowed.
  const decide = async (): Promise<CycleResult> => {
  const listed = await reconcileAndList();
  if (!Array.isArray(listed)) return listed;
  const candidates = listed;

  // 5b. A culprit confirmed by an earlier cycle whose revert was never pushed
  // (#4014): go straight to the revert, with no bisect, unless the culprit has
  // left the branch, reached main or was reverted meanwhile.
  if (state.pendingRevert) {
    const gone = await culpritGone(state.pendingRevert.culprit);
    if (gone !== null) {
      log(`remembered culprit ${state.pendingRevert.culprit.slice(0, 10)} dropped: ${gone}`);
      state.pendingRevert = null;
    } else {
      const pending = state.pendingRevert;
      // The head moved since it was last seen red (#4031): a fix pushed by hand
      // meanwhile may have made the revert unnecessary, and reverting then
      // would undo a change that no longer breaks anything, reopen its issue
      // and start a fix task for nothing. So verify the moved head once. Green:
      // promote it and forget the culprit. Red: revert, as before.
      if (pending.redHead !== headSha) {
        log(`integration head moved to ${headSha.slice(0, 10)} since culprit ${pending.culprit.slice(0, 10)} was confirmed; verifying it before reverting`);
        if (await verify(headSha)) {
          log(`remembered culprit ${pending.culprit.slice(0, 10)} dropped: the moved head passes`);
          state.pendingRevert = null;
          const promoted = await promote(headSha);
          if (!promoted.ok) return rejected('promotion push', promoted);
          return { outcome: 'promoted', detail: `the head passes; the revert of ${pending.culprit.slice(0, 10)} was not needed` };
        }
        pending.redHead = headSha;
        deps.state.save(state);
      }
      log(`resuming the revert of confirmed culprit ${pending.culprit.slice(0, 10)}; no bisect`);
      const resumed = await revertCulprit(pending, true);
      if (resumed) return resumed;
    }
  }

  // 6. Verify the head.
  if (await verify(headSha)) {
    const promoted = await promote(headSha);
    if (!promoted.ok) return rejected('promotion push', promoted);
    return { outcome: 'promoted' };
  }

  // 7. One re-run to separate a flake from a real failure.
  log(`head ${headSha.slice(0, 10)} red; re-running once`);
  const firstRedTail = redTails.get(headSha) ?? '';
  if (await verify(headSha)) {
    pushCapped(state.flakyHeads, headSha, FLAKY_CAP);
    const promoted = await promote(headSha);
    if (!promoted.ok) return rejected('promotion push', promoted);
    return { outcome: 'promoted', detail: 'flaky' };
  }
  if (!redTails.get(headSha)) redTails.set(headSha, firstRedTail);

  // 7b. Bisect with the failing part only (issue #3995). The reports of the
  // head's two red runs name the steps that failed and, for the unit lane, the
  // test files. A full run takes about ten minutes; those steps alone take a
  // fraction of that. They must fail on the head when run alone, or they are
  // not what makes it red: the bisect then uses the full suite, as before.
  // The narrow runs only find the culprit. Nothing is promoted on one: the
  // revert of the culprit is verified with the full suite before it is pushed.
  let scope = narrowScope(redReports.get(headSha) ?? [], headSha);
  if (scope === null) {
    log('the red runs do not identify the failing part; bisecting with the full suite');
  } else {
    log(`head ${headSha.slice(0, 10)} failed in ${describeScope(scope)}; re-running only that on it`);
    if (await verifyNarrow(headSha, scope)) {
      log('the failing part passes alone on the head; bisecting with the full suite');
      scope = null;
    } else {
      log('the failing part fails alone on the head; bisecting with it');
    }
  }

  // 8. Is main itself red right now? Always re-run it, even when the train
  // verified this SHA earlier: a full disk, a dead network or an overloaded
  // host fails every commit alike, and bisecting through that would blame and
  // revert an innocent change. A red base means "environment", so halt. With a
  // narrow scope, main runs the failing part only; when that is red, the full
  // suite decides, because a halt stops every promotion and only a full red
  // run may cause one. A main the train never verified always gets the full suite.
  let baseGreen: boolean;
  if (scope !== null && !mainUnverified) {
    baseGreen = await verifyNarrow(mainSha, scope);
    if (!baseGreen) {
      log(`main ${mainSha.slice(0, 10)} fails the narrow run; checking it with the full suite`);
      scope = null;
      baseGreen = await verify(mainSha);
    }
  } else {
    baseGreen = await verify(mainSha);
  }
  if (!baseGreen) {
    // A red main the train never verified is not the environment: it reached
    // main without the train, so name what did.
    if (mainUnverified) {
      return halt(
        'main-unverified-red', mainSha, headSha,
        `main ${mainSha.slice(0, 10)} reached main without the train and fails verify; nothing reverted. Commits that reached main without the train: ${await unverifiedOnMain()}`,
      );
    }
    return halt('base-red', mainSha, headSha, `main ${mainSha.slice(0, 10)} fails verify; nothing reverted`);
  }

  // The bisect below indexes the candidate list, which must end at the head.
  // It does not when main is reachable from the head only through a second
  // parent (a merge commit made by hand or by the GitHub UI rather than a
  // squash): `--first-parent --ancestry-path` then lists nothing useful. A green
  // head in that shape is promoted correctly above; a red one needs a human.
  if (candidates.length === 0 || candidates[candidates.length - 1] !== headSha) {
    return halt(
      'history-shape', mainSha, headSha,
      'the integration branch is not a first-parent line from main (a non-squash merge?); cannot bisect',
    );
  }

  // 9a. A revert the train made earlier may still be in the range (main has not
  // caught up with it yet). Every commit between the reverted change and that
  // revert is red because of the reverted change, so a bisect across them
  // would blame it again. Start after the newest such revert instead. If the
  // revert itself is red, a second change between the reverted one and its
  // revert is failing too (typically one that merged while the revert was
  // being verified, under which the revert was then re-applied): look for it
  // with the first change reverted (#4031), and halt only when that fails.
  let lo = -1;
  const earlier = await newestRevertIndex(deps, candidates);
  if (earlier !== null) {
    const revertIdx = earlier.index;
    const revertCommit = candidates[revertIdx];
    if (revertCommit === headSha || !(await verify(revertCommit))) {
      const second = await secondCulprit(candidates, earlier.reverted, revertIdx);
      if ('halt' in second) {
        return halt(
          'multiple-failures', mainSha, headSha,
          `still red at ${revertCommit.slice(0, 10)}, which already reverts an earlier culprit; ` +
            `another change is failing too and the train cannot find it: ${second.halt}`,
        );
      }
      if ('flaky' in second) {
        log('second culprit passed on re-run; treating the failure as flaky, nothing reverted');
        return { outcome: 'retry', detail: 'second culprit passed on re-run' };
      }
      log(`second culprit ${second.culprit.slice(0, 10)}, below the revert of ${earlier.reverted.slice(0, 10)}`);
      state.pendingRevert = {
        culprit: second.culprit, verified: false, rejections: 0, alerted: false, redHead: headSha,
        failTail: tailForComment(second.tail),
      };
      deps.state.save(state);
      // Nothing to promote first: every commit below the head still contains
      // one of the two culprits.
      return (await revertCulprit(state.pendingRevert, false)) as CycleResult;
    }
    const promoted = await promote(revertCommit);
    if (!promoted.ok) return rejected('promotion of the reverted head', promoted);
    lo = revertIdx;
  }

  // 9b. Bisect. The commit at `lo` (or main) is good, the head is bad; assume a
  // single transition between them. With a scope (step 7b), each step runs
  // only the failing part.
  const bisectScope = scope;
  const probe = (sha: string): Promise<boolean> => (bisectScope === null ? verify(sha) : verifyNarrow(sha, bisectScope));
  let hi = candidates.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (await probe(candidates[mid])) lo = mid;
    else hi = mid;
  }
  const culprit = candidates[hi];
  const lastGood = lo >= 0 ? candidates[lo] : mainSha;
  log(`culprit ${culprit.slice(0, 10)}, last good ${lastGood.slice(0, 10)}`);

  // Confirm before reverting someone's work: the culprit must fail a second
  // time. The head already failed twice in steps 6 and 7; any other commit was
  // seen red only once during the bisect. A green re-run means a flaky test
  // steered the bisect, so revert nothing and let the next cycle start over.
  if (culprit !== headSha && (await probe(culprit))) {
    log(`culprit ${culprit.slice(0, 10)} passed on re-run; treating the failure as flaky, nothing reverted`);
    return { outcome: 'retry', detail: 'culprit passed on re-run' };
  }

  // Remember the confirmed culprit now, and save it at once (#4014): a cycle
  // that ends before the revert is pushed (a rejected push, a restart, a crash)
  // must not pay for the bisect again. The next cycle resumes at step 5b.
  state.pendingRevert = {
    culprit, verified: false, rejections: 0, alerted: false, redHead: headSha,
    failTail: tailForComment(redTails.get(culprit) ?? redTails.get(headSha) ?? ''),
  };
  deps.state.save(state);

  // Promote the last good commit so main keeps moving while the culprit is
  // dealt with. Candidates are limited to commits that contain main, so this is
  // always a fast-forward. After a narrow bisect the last good commit passed
  // only the failing part, which is no verification: it is not promoted, and
  // main moves with the verified revert instead, which contains it.
  if (lastGood !== mainSha) {
    if (isGreen(lastGood)) {
      const promoted = await promote(lastGood);
      if (!promoted.ok) return rejected('promotion of last good', promoted);
    } else {
      log(`last good ${lastGood.slice(0, 10)} passed only the narrow run; not promoted on its own`);
    }
  }

  return (await revertCulprit(state.pendingRevert, false)) as CycleResult;
  };

  /**
   * Step 9a, when the train's revert of `reverted` (at `revertIdx` in the
   * candidates) is red: finds the first commit between the two that is red
   * even with `reverted` undone. Each probe is that commit with `reverted`
   * reverted on top, built in the train's worktree and never pushed. The
   * reverted commit itself is the good end (with itself undone it is its
   * parent, which the bisect that found it saw green); the train's revert is
   * the bad end, and the probe just below it has its tree, so it is red
   * without a run. The found commit is confirmed by a second red run, like
   * any culprit; the head's two runs in steps 6 and 7 count when the probe has
   * the head's tree. revertCulprit then verifies the revert of the found commit
   * on the real head before pushing anything.
   * Returns `halt` with the reason when it cannot search: no commit between
   * the two, another train revert between them (its probes would still hold
   * that earlier culprit), or a probe that cannot be built (conflict, or
   * `reverted` already undone). Returns `flaky` when the confirming run passes.
   */
  const secondCulprit = async (
    candidates: string[], reverted: string, revertIdx: number,
  ): Promise<{ culprit: string; tail: string } | { flaky: true } | { halt: string }> => {
    const cIdx = candidates.indexOf(reverted);
    if (cIdx < 0 || revertIdx - cIdx < 2) return { halt: 'no commit lies between the reverted change and its revert' };
    for (let i = cIdx + 1; i < revertIdx; i++) {
      const body = await git(['log', '-1', '--format=%B', candidates[i]]);
      if (body.ok && body.stdout.includes(TRAIN_REVERT_TRAILER)) {
        return { halt: `another train revert, ${candidates[i].slice(0, 10)}, lies between them` };
      }
    }
    const subject = await out(['log', '-1', '--format=%s', reverted]);
    const revertCommit = candidates[revertIdx];
    // The probe of the commit just below the train's revert has the revert's
    // tree, which this cycle already saw red: no need to run it again.
    const revertTree = await out(['rev-parse', `${revertCommit}^{tree}`]);
    const probes = new Map<number, string>();
    const sameAsRevert = new Set<number>();
    const probe = async (i: number): Promise<boolean | string> => {
      const built = await buildRevert(candidates[i], reverted, subject);
      if (built === 'conflict' || built === 'empty') {
        return `reverting ${reverted.slice(0, 10)} on ${candidates[i].slice(0, 10)} ${built === 'conflict' ? 'conflicts' : 'changes nothing'}`;
      }
      probes.set(i, built);
      if ((await out(['rev-parse', `${built}^{tree}`])) === revertTree) {
        sameAsRevert.add(i);
        return false;
      }
      return verify(built);
    };
    let good = cIdx;
    let bad = revertIdx;
    while (bad - good > 1) {
      const mid = (good + bad) >> 1;
      const green = await probe(mid);
      if (typeof green === 'string') return { halt: green };
      if (green) good = mid;
      else bad = mid;
    }
    if (bad === revertIdx) return { halt: 'no commit below the revert is red with the reverted change undone' };
    const probed = probes.get(bad) as string;
    const tail = redTails.get(probed) ?? redTails.get(revertCommit) ?? '';
    // Confirmed already when the probe is the head's tree (red twice in steps 6 and 7).
    const redTwice = sameAsRevert.has(bad) && revertCommit === headSha;
    log(`commit ${candidates[bad].slice(0, 10)} is red with ${reverted.slice(0, 10)} reverted` +
      (redTwice ? '' : '; re-running to confirm'));
    if (!redTwice && await verify(probed)) return { flaky: true };
    return { culprit: candidates[bad], tail };
  };

  /**
   * Why a remembered culprit no longer needs reverting on the current head, or
   * null when it still does.
   */
  const culpritGone = async (culprit: string): Promise<string | null> => {
    if (!(await git(['merge-base', '--is-ancestor', culprit, headSha])).ok) {
      return `it is no longer on ${integration}`;
    }
    if ((await git(['merge-base', '--is-ancestor', culprit, mainSha])).ok) return 'it is already on main';
    const reverts = await out(['rev-list', '-n', '1', `--grep=^This reverts commit ${culprit}`, `${culprit}..${headSha}`]);
    return reverts !== '' ? `${reverts.slice(0, 10)} already reverts it` : null;
  };

  /**
   * Commits a revert of `culprit` on top of `base` (detached, in the train's
   * worktree) with the train's trailer. Returns its SHA, 'conflict' (aborted),
   * or 'empty' when the revert changes nothing (the culprit was already undone
   * or fixed forward; the worktree is reset to `base`).
   */
  const buildRevert = async (base: string, culprit: string, subject: string): Promise<string> => {
    await out(['checkout', '--detach', '-q', base]);
    const revert = await git(['revert', '--no-commit', culprit]);
    if (!revert.ok) {
      await git(['revert', '--abort']);
      return 'conflict';
    }
    // `--allow-empty` because a culprit that was already fixed forward reverts
    // to nothing; that case is reported as 'empty' rather than failing here as
    // an unexpected git error. Step 9a recognises only the trailer: a revert a
    // person made of some unrelated change says nothing about which commits in
    // the range are known-bad.
    await out([
      'commit', '-q', '--allow-empty', '-m', `Revert "${subject}"`,
      '-m', `This reverts commit ${culprit}.`,
      '-m', TRAIN_REVERT_TRAILER,
    ]);
    const sha = await out(['rev-parse', 'HEAD']);
    if ((await out(['rev-parse', `${sha}^{tree}`])) === (await out(['rev-parse', `${base}^{tree}`]))) {
      await git(['reset', '--hard', '-q', base]);
      return 'empty';
    }
    return sha;
  };

  /**
   * Step 9c: revert the confirmed culprit on the integration head, verify the
   * revert with the full suite unless a revert of it already passed, push it,
   * then report it. Used right after the bisect and by a resumed cycle
   * (`resumed`), which returns null when the revert turns out to change nothing
   * so the caller carries on with an ordinary cycle.
   */
  const revertCulprit = async (pending: PendingRevert, resumed: boolean): Promise<CycleResult | null> => {
  const { culprit } = pending;
  const parents = (await out(['rev-list', '--parents', '-n', '1', culprit])).split(/\s+/).filter(Boolean);
  if (parents.length > 2) {
    return halt('culprit-is-merge', mainSha, headSha, `culprit ${culprit.slice(0, 10)} is a merge commit`);
  }

  const subject = await out(['log', '-1', '--format=%s', culprit]);
  const built = await buildRevert(headSha, culprit, subject);
  if (built === 'conflict') {
    return halt('revert-conflict', mainSha, headSha, `reverting ${culprit.slice(0, 10)} conflicts`);
  }
  // A revert that changes nothing (the culprit was already undone or fixed
  // forward) cannot be what makes the head pass. Do not even verify it: the
  // tree is the head's, which failed twice, and a flaky green run here would
  // push an empty revert and reopen an issue for nothing.
  if (built === 'empty') {
    if (resumed) {
      log(`remembered culprit ${culprit.slice(0, 10)} dropped: reverting it changes nothing on ${headSha.slice(0, 10)}`);
      state.pendingRevert = null;
      return null;
    }
    return halt(
      'revert-not-sufficient', mainSha, headSha,
      `reverting suspected culprit ${culprit.slice(0, 10)} (${subject}) changes nothing; nothing pushed`,
    );
  }
  let revertSha = built;

  // The bisect assumes one good-to-bad transition. When the head is red for a
  // reason that is not the culprit (the culprit was fixed forward, then something
  // else broke), the revert would not help and the culprit's issue would be
  // reopened for nothing. So the revert itself must pass before it is pushed,
  // once: a revert re-applied on a moved head is pushed without a second run.
  let promotable = false;
  if (!pending.verified) {
    if (!(await verify(revertSha))) {
      await git(['reset', '--hard', '-q', headSha]);
      return halt(
        'revert-not-sufficient', mainSha, headSha,
        `reverting suspected culprit ${culprit.slice(0, 10)} (${subject}) does not make the head pass; nothing pushed`,
      );
    }
    pending.verified = true;
    promotable = true;
    deps.state.save(state);
  }

  // A merge into the integration branch during the verify rejects the push
  // (#4014). Throwing the verified revert away would restart the whole search,
  // and at the usual merge rate that can repeat without end. Instead re-apply
  // the same revert on the new head and push it at once. It is not verified
  // again, so it is not promoted: the next cycle verifies the new head before
  // anything reaches main.
  let pushed = await push(`${revertSha}:refs/heads/${integration}`);
  for (let attempt = 1; !pushed.ok; attempt++) {
    pending.rejections += 1;
    log(`revert push rejected (${pending.rejections} in a row): ${pushed.stderr.trim()}`);
    if (pending.rejections >= REVERT_REJECT_ALERT && !pending.alerted) {
      pending.alerted = true;
      await raise(
        deps, state, 'revert-push-rejected',
        `the push of the verified revert of ${culprit.slice(0, 10)} (${subject}) to ${integration} was rejected ` +
          `${pending.rejections} times in a row (last: ${pushed.stderr.trim().slice(-200)}). The train keeps the revert ` +
          `and pushes it again, re-applied on the new ${integration} head when the branch moved, without another full ` +
          'verify; the next cycle verifies the head before anything is promoted.',
      );
    }
    if (attempt > REVERT_REAPPLY_ATTEMPTS) break;
    const fetched = await git([
      'fetch', '--no-tags', 'origin', `+refs/heads/${integration}:refs/remotes/origin/${integration}`,
    ]);
    if (!fetched.ok) break;
    const newHead = await out(['rev-parse', intRef]);
    // The head did not move: the push was refused for another reason (branch
    // protection, credentials), which re-applying cannot fix.
    if (newHead === headSha) break;
    headSha = newHead;
    const gone = await culpritGone(culprit);
    if (gone !== null) {
      log(`remembered culprit ${culprit.slice(0, 10)} dropped: ${gone}`);
      state.pendingRevert = null;
      return { outcome: 'retry', detail: `revert of ${culprit.slice(0, 10)} not needed: ${gone}` };
    }
    const again = await buildRevert(headSha, culprit, subject);
    if (again === 'conflict') {
      return halt(
        'revert-conflict', mainSha, headSha,
        `re-applying the verified revert of ${culprit.slice(0, 10)} on the new ${integration} head ${headSha.slice(0, 10)} conflicts`,
      );
    }
    if (again === 'empty') {
      log(`remembered culprit ${culprit.slice(0, 10)} dropped: reverting it changes nothing on ${headSha.slice(0, 10)}`);
      state.pendingRevert = null;
      return { outcome: 'retry', detail: `revert of ${culprit.slice(0, 10)} not needed: it changes nothing on the new head` };
    }
    revertSha = again;
    promotable = false;
    log(`re-applied the revert of ${culprit.slice(0, 10)} on ${headSha.slice(0, 10)} as ${revertSha.slice(0, 10)}`);
    pushed = await push(`${revertSha}:refs/heads/${integration}`);
  }
  // The culprit stays remembered: the next cycle resumes here, without a bisect.
  if (!pushed.ok) return rejected('revert push', pushed);
  state.pendingRevert = null;

  // A revert verified green contains main: promote it right away. A rejected
  // push is not an error; the next cycle promotes it (and counts it towards
  // PUSH_REJECT_LIMIT).
  let revertPromoted = false;
  if (promotable) {
    const revertPromotion = await promote(revertSha);
    revertPromoted = revertPromotion.ok;
    if (!revertPromoted) {
      log(`promotion of the revert rejected: ${revertPromotion.stderr.trim()}`);
      state.pushRejections += 1;
    }
  }

  const pr = prNumberFromSubject(subject);
  const failTail = pending.failTail;
  let fixNote = '';
  // What happens next, in the words of the pull-request comment.
  let prNextStep = '';
  if (pr === null) {
    fixNote = 'no PR number in the subject; no issue handling and no fix task';
  } else {
    const body = automationComment(
      `Integration train: commit ${culprit} (PR #${pr}) failed verification and was reverted ` +
      `on \`${integration}\` by ${revertSha}.\n\nLast lines of the failing verify output:\n\n` +
      '```\n' + failTail + '\n```',
    );
    const issues = await safe(deps, () => deps.github.closingIssues(pr)) ?? [];
    for (const issue of issues) {
      if (issue.state === 'closed') await safe(deps, () => deps.github.reopenIssue(issue.number));
      await safe(deps, () => deps.github.commentIssue(issue.number, body));
    }

    // Budget by issue when there is one: the re-land is a new PR, so a count
    // kept per PR number would never reach its limit.
    const issueNumbers = issues.map((i) => i.number).sort((a, b) => a - b);
    // With no linked issue (or when GitHub could not be asked), fall back to
    // the first reference in the subject, which a cherry-picked re-land keeps.
    const budgetKey = issueNumbers.length > 0
      ? `issue-${issueNumbers[0]}`
      : `ref-${firstReferenceFromSubject(subject) ?? pr}`;
    const spawned = state.fixTasks[budgetKey] ?? 0;
    if (spawned < MAX_AUTOMATIC_RELANDS) {
      const attempt = spawned + 1;
      // The key names the failure, not only the attempt (issue #3986). When
      // `state.json` loses `fixTasks`, an attempt number comes round again;
      // a key of budget and attempt alone would then make the server return
      // the earlier task (its idempotency window is 24 hours) and no task
      // would start for this failure. With the culprit in the key, a replay
      // can only be this failure's own task: a retry of the same request
      // (`kookr spawn` re-sends after a timeout) or a re-run of this step.
      const key = `train-fix-${budgetKey}-${attempt}-${culprit.slice(0, 10)}`;
      const result = await safe(deps, () => deps.spawner.spawn({
        idempotencyKey: key,
        prompt: fixPrompt({ pr, culprit, revertSha, integration, failTail, issues: issueNumbers, attempt }),
      }));
      if (result !== undefined) {
        // The budget is consumed only by a task that exists.
        state.fixTasks[budgetKey] = attempt;
        fixNote = `fix task ${key} spawned (automatic re-land ${attempt} of ${MAX_AUTOMATIC_RELANDS})` +
          (result.replayed ? `; the server returned the task already started for this failure (${result.taskId ?? 'no id'})` : '');
        prNextStep = `the train started fix task \`${key}\` (automatic re-land ${attempt} of ${MAX_AUTOMATIC_RELANDS}). ` +
          'It re-applies this change, fixes the failure and delivers it in a new pull request. ' +
          (issueNumbers.length > 0 ? `Issue(s) ${issueNumbers.map((n) => `#${n}`).join(', ')} stay open until then.` : '');
      } else {
        fixNote = `fix task ${key} could not be spawned`;
        prNextStep = `needs a human: the train could not start fix task \`${key}\`. The operator has been alerted.`;
        await raise(
          deps, state, 'fix-spawn-failed',
          `PR #${pr} reverted as ${revertSha}; fix task ${key} could not be spawned. Needs a human.`,
        );
      }
    } else {
      fixNote = `fix budget exhausted for ${budgetKey} (PR #${pr})`;
      const scope = issueNumbers.length > 0 ? 'this issue' : 'this change';
      prNextStep = `needs a human: ${spawned} automatic fix task(s), the limit of ${MAX_AUTOMATIC_RELANDS}, were already started for ${scope}, ` +
        'so the train starts no more. The operator has been alerted.';
      await raise(
        deps, state, 'fix-budget-exhausted',
        `PR #${pr} failed; ${spawned} automatic fix task(s), the limit, were already started for ${scope}; reverted ${culprit} (${revertSha}). Needs a human.`,
      );
    }
  }
  if (pr !== null) {
    const shortTail = failTail.split('\n').slice(-PR_COMMENT_TAIL_LINES).join('\n');
    await commentPullRequestOnce(deps, pr, 'reverted', culprit, [
      `**Integration train: reverted.** This pull request's commit ${culprit} failed the full test suite on \`${integration}\`, ` +
        `so the train reverted it with ${revertSha}. \`main\` does not contain this change.`,
      '',
      'Last lines of the failing output:',
      '',
      '```',
      shortTail,
      '```',
      '',
      `Next: ${prNextStep}`,
    ]);
  }
  if (!promotable) {
    fixNote += '; the revert was re-applied after a rejected push and is not verified on this head yet, the next cycle verifies it before promoting';
  } else if (!revertPromoted) {
    fixNote += '; promotion of the revert rejected, the next cycle retries';
  }
  await raise(deps, state, 'reverted', `reverted ${culprit} as ${revertSha} on ${integration}; ${fixNote}`);
  return { outcome: 'reverted', detail: fixNote };
  };

  try {
    return await decide();
  } catch (err) {
    // The suite could not run (checkout or install failed): halt, blame nothing.
    if (err instanceof VerifyInfraError) return halt('verify-infra', mainSha, headSha, err.message);
    // Anything else (a failing checkout or commit, no committer identity): halt
    // and tell the operator, instead of crashing and re-running every verify on
    // each interval with nobody notified.
    return halt('train-error', mainSha, headSha, err instanceof Error ? err.message : String(err));
  }
}

/** Index in `candidates` of the newest train-made revert of another candidate, and the commit it reverts; or null. */
async function newestRevertIndex(
  deps: TrainDeps, candidates: string[],
): Promise<{ index: number; reverted: string } | null> {
  const inRange = new Set(candidates);
  for (let i = candidates.length - 1; i >= 0; i--) {
    const body = await deps.git(['log', '-1', '--format=%B', candidates[i]]);
    const m = body.ok ? /^This reverts commit ([0-9a-f]{40})\b/m.exec(body.stdout) : null;
    if (m && inRange.has(m[1]) && body.stdout.includes(TRAIN_REVERT_TRAILER)) return { index: i, reverted: m[1] };
  }
  return null;
}

function fixPrompt(p: {
  pr: number; culprit: string; revertSha: string; integration: string; failTail: string; issues: number[];
  attempt: number;
}): string {
  // A later attempt must not repeat an earlier fix that failed. The count never
  // resets, so an earlier fix may have landed and stayed: say only that the
  // earlier tasks were started, and let the task check what became of them.
  const subject = p.issues.length > 0 ? 'this issue' : 'this change';
  const earlier = p.attempt > 1
    ? [
      '',
      `This is automatic re-land ${p.attempt} of ${MAX_AUTOMATIC_RELANDS} for ${subject}: ` +
        `${p.attempt - 1} earlier automatic fix task(s) were already started for ${subject}; check whether their pull requests were reverted.`,
      'Before choosing a fix, read the earlier failing output in the comments of the linked issue and the earlier fix pull requests, and do not repeat an approach that already failed.',
    ]
    : [];
  const closes = p.issues.length > 0
    ? `5. Deliver through the normal flow (pull request, review, merge). Put ${p.issues.map((n) => `\`Closes #${n}\``).join(' and ')} in the pull request body: the train counts automatic re-lands per issue.`
    : '5. Deliver through the normal flow (pull request, review, merge).';
  return [
    `The integration train reverted PR #${p.pr} because it broke verification on the \`${p.integration}\` branch.`,
    '',
    `- Reverted commit: ${p.culprit}`,
    `- Revert commit: ${p.revertSha}`,
    ...earlier,
    '',
    'Your job:',
    '1. Branch from `origin/main` (fetch first).',
    `2. Re-apply the reverted change: \`git cherry-pick ${p.culprit}\`.`,
    '3. Fix the failure shown in the output below.',
    '4. Run the failing tests until they pass.',
    closes,
    '',
    'Failing verify output (tail):',
    '',
    '```',
    p.failTail,
    '```',
    '',
  ].join('\n');
}

async function pushRef(deps: TrainDeps, refspec: string): Promise<GitResult> {
  return deps.git(['push', '--no-verify', 'origin', refspec]);
}

/**
 * On promotion, for every PR commit that reached main: close its still-open
 * issues, and say on the pull request that it reached main and when it was
 * verified.
 */
async function reportPromoted(deps: TrainDeps, shas: string[], promoted: string, integration: string): Promise<void> {
  const short = promoted.slice(0, 10);
  const at = deps.now().toISOString();
  // A commit the train reverted reaches main together with its revert. Its
  // issue was reopened at revert time and must stay open, so skip every commit
  // that a later commit in the same range reverts, and the reverts themselves.
  const reverted = new Set<string>();
  const reverts = new Set<string>();
  for (const sha of shas) {
    const body = await deps.git(['log', '-1', '--format=%B', sha]);
    const m = body.ok ? /^This reverts commit ([0-9a-f]{40})\b/m.exec(body.stdout) : null;
    if (m) {
      reverted.add(m[1]);
      reverts.add(sha);
    }
  }
  for (const sha of shas) {
    if (reverted.has(sha) || reverts.has(sha)) continue;
    const subj = await deps.git(['log', '-1', '--format=%s', sha]);
    const pr = subj.ok ? prNumberFromSubject(subj.stdout) : null;
    if (pr === null) continue;
    const issues = await safe(deps, () => deps.github.closingIssues(pr)) ?? [];
    const closed: number[] = [];
    for (const issue of issues) {
      if (issue.state !== 'open') { closed.push(issue.number); continue; }
      const ok = await safe(deps, async () => { await deps.github.closeIssue(issue.number, verifiedOnMainComment(short)); return true; });
      if (ok === true) closed.push(issue.number);
    }
    const verified = sha === promoted ? 'this commit' : `\`${integration}\` at ${promoted}, which contains this commit`;
    await commentPullRequestOnce(deps, pr, 'promoted', sha, [
      `**Integration train: promoted.** This pull request reached \`main\` as ${sha}. ` +
        `The full test suite passed on ${verified} at ${at}.`,
      '',
      closed.length > 0
        ? `Next: nothing. Issue(s) ${closed.map((n) => `#${n}`).join(', ')} closed.`
        : 'Next: nothing.',
    ]);
  }
}

/**
 * Notify the operator (best effort) and remember that an alert is outstanding,
 * so the next healthy cycle reports recovery once.
 */
async function raise(deps: TrainDeps, state: TrainState, kind: TrainEventKind, detail: string): Promise<void> {
  state.alerting = true;
  await safe(deps, () => deps.notifier.notify(kind, detail));
}

/** Best-effort wrapper: a failing side channel never fails the cycle. */
async function safe<T>(deps: TrainDeps, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    deps.log(`best-effort call failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}
