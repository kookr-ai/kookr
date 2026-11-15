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
}

export interface TrainSpawner {
  spawn(request: { idempotencyKey: string; prompt: string }): Promise<void>;
}

export type TrainEventKind =
  | 'halted'
  | 'reverted'
  | 'fix-budget-exhausted'
  | 'fix-spawn-failed'
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

export interface TrainState {
  halted: TrainHalt | null;
  /** SHAs the train verified green (newest last, capped). */
  verifiedGreen: string[];
  /** Heads that were red once and green on the immediate re-run. */
  flakyHeads: string[];
  /**
   * Fix-task budget: key -> automatic re-lands already spawned. The key is the
   * linked issue (`issue-<n>`) when the reverted PR has one, because a re-land
   * is a new PR with a new number but closes the same issue; `pr-<n>` otherwise.
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
  /** Verifies the given SHA (checks it out in the worktree, runs the suite). */
  verify(sha: string): Promise<VerifyResult>;
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

export function emptyTrainState(): TrainState {
  return { halted: null, verifiedGreen: [], flakyHeads: [], fixTasks: {}, alerting: false, pushRejections: 0 };
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

  // Verify bookkeeping for this cycle.
  const results = new Map<string, boolean>();
  const redTails = new Map<string, string>();
  const verify = async (sha: string): Promise<boolean> => {
    const r = await deps.verify(sha);
    if (r.infra) throw new VerifyInfraError(`verify could not run for ${sha.slice(0, 10)}: ${r.tail.slice(-400)}`);
    results.set(sha, r.ok);
    if (r.ok) pushCapped(state.verifiedGreen, sha, VERIFIED_GREEN_CAP);
    else redTails.set(sha, r.tail);
    log(`verify ${sha.slice(0, 10)}: ${r.ok ? 'green' : 'red'}`);
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
    await closeIssuesFor(deps, fresh, sha);
    return pushed;
  };

  // Steps 4-9. An arrow function, so the narrowed types above stay narrowed.
  const decide = async (): Promise<CycleResult> => {
  const listed = await reconcileAndList();
  if (!Array.isArray(listed)) return listed;
  const candidates = listed;

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

  // 8. Is main itself red right now? Always re-run it, even when the train
  // verified this SHA earlier: a full disk, a dead network or an overloaded
  // host fails every commit alike, and bisecting through that would blame and
  // revert an innocent change. A red base means "environment", so halt.
  if (!(await verify(mainSha))) {
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
  // revert itself is red, a second change in the same batch is failing and the
  // train cannot tell which by bisecting commits, so it halts.
  let lo = -1;
  const revertIdx = await newestRevertIndex(deps, candidates);
  if (revertIdx >= 0) {
    const revertCommit = candidates[revertIdx];
    if (revertCommit === headSha || !(await verify(revertCommit))) {
      return halt(
        'multiple-failures', mainSha, headSha,
        `still red at ${revertCommit.slice(0, 10)}, which already reverts an earlier culprit; a second change in the batch is failing`,
      );
    }
    const promoted = await promote(revertCommit);
    if (!promoted.ok) return rejected('promotion of the reverted head', promoted);
    lo = revertIdx;
  }

  // 9b. Bisect. The commit at `lo` (or main) is good, the head is bad; assume a
  // single transition between them.
  let hi = candidates.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (await verify(candidates[mid])) lo = mid;
    else hi = mid;
  }
  const culprit = candidates[hi];
  const lastGood = lo >= 0 ? candidates[lo] : mainSha;
  log(`culprit ${culprit.slice(0, 10)}, last good ${lastGood.slice(0, 10)}`);

  // Confirm before reverting someone's work: the culprit must fail a second
  // time. The head already failed twice in steps 6 and 7; any other commit was
  // seen red only once during the bisect. A green re-run means a flaky test
  // steered the bisect, so revert nothing and let the next cycle start over.
  if (culprit !== headSha && (await verify(culprit))) {
    log(`culprit ${culprit.slice(0, 10)} passed on re-run; treating the failure as flaky, nothing reverted`);
    return { outcome: 'retry', detail: 'culprit passed on re-run' };
  }

  // Promote the last good commit so main keeps moving while the culprit is
  // dealt with. Candidates are limited to commits that contain main, so this is
  // always a fast-forward.
  if (lastGood !== mainSha) {
    const promoted = await promote(lastGood);
    if (!promoted.ok) return rejected('promotion of last good', promoted);
  }

  const parents = (await out(['rev-list', '--parents', '-n', '1', culprit])).split(/\s+/).filter(Boolean);
  if (parents.length > 2) {
    return halt('culprit-is-merge', mainSha, headSha, `culprit ${culprit.slice(0, 10)} is a merge commit`);
  }

  await out(['checkout', '--detach', '-q', headSha]);
  const revert = await git(['revert', '--no-commit', culprit]);
  if (!revert.ok) {
    await git(['revert', '--abort']);
    return halt('revert-conflict', mainSha, headSha, `reverting ${culprit.slice(0, 10)} conflicts`);
  }
  // Commit with the train's trailer. `--allow-empty` because a culprit that was
  // already fixed forward reverts to nothing; that case is rejected just below
  // rather than failing here as an unexpected git error. Step 9a recognises only
  // it: a revert a person made of some unrelated change says nothing about
  // which commits in the range are known-bad.
  const culpritSubject = await out(['log', '-1', '--format=%s', culprit]);
  await out([
    'commit', '-q', '--allow-empty', '-m', `Revert "${culpritSubject}"`,
    '-m', `This reverts commit ${culprit}.`,
    '-m', TRAIN_REVERT_TRAILER,
  ]);
  const revertSha = await out(['rev-parse', 'HEAD']);
  const subject = culpritSubject;

  // A revert that changes nothing (the culprit was already undone or fixed
  // forward) cannot be what makes the head pass. Do not even verify it: the
  // tree is the head's, which failed twice, and a flaky green run here would
  // push an empty revert and reopen an issue for nothing.
  if ((await out(['rev-parse', `${revertSha}^{tree}`])) === (await out(['rev-parse', `${headSha}^{tree}`]))) {
    await git(['reset', '--hard', '-q', headSha]);
    return halt(
      'revert-not-sufficient', mainSha, headSha,
      `reverting suspected culprit ${culprit.slice(0, 10)} (${subject}) changes nothing; nothing pushed`,
    );
  }

  // The bisect assumes one good-to-bad transition. When the head is red for a
  // reason that is not the culprit (the culprit was fixed forward, then something
  // else broke), the revert would not help and the culprit's issue would be
  // reopened for nothing. So the revert itself must pass before it is pushed.
  if (!(await verify(revertSha))) {
    await git(['reset', '--hard', '-q', headSha]);
    return halt(
      'revert-not-sufficient', mainSha, headSha,
      `reverting suspected culprit ${culprit.slice(0, 10)} (${subject}) does not make the head pass; nothing pushed`,
    );
  }
  const revertPush = await push(`${revertSha}:refs/heads/${integration}`);
  if (!revertPush.ok) return rejected('revert push', revertPush);
  // The revert is verified green and contains main: promote it right away. A
  // rejected push is not an error; the next cycle promotes it (and counts it
  // towards PUSH_REJECT_LIMIT).
  const revertPromotion = await promote(revertSha);
  const revertPromoted = revertPromotion.ok;
  if (!revertPromoted) {
    log(`promotion of the revert rejected: ${revertPromotion.stderr.trim()}`);
    state.pushRejections += 1;
  }

  const pr = prNumberFromSubject(subject);
  const failTail = tailForComment(redTails.get(culprit) ?? redTails.get(headSha) ?? '');
  let fixNote = '';
  if (pr === null) {
    fixNote = 'no PR number in the subject; no issue handling and no fix task';
  } else {
    const body =
      `Integration train: commit ${culprit} (PR #${pr}) failed verification and was reverted ` +
      `on \`${integration}\` by ${revertSha}.\n\nLast lines of the failing verify output:\n\n` +
      '```\n' + failTail + '\n```';
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
      const key = `train-fix-${budgetKey}-${attempt}`;
      const ok = await safe(deps, async () => {
        await deps.spawner.spawn({
          idempotencyKey: key,
          prompt: fixPrompt({ pr, culprit, revertSha, integration, failTail, issues: issueNumbers, attempt }),
        });
        return true;
      });
      if (ok === true) {
        // The budget is consumed only by a task that exists.
        state.fixTasks[budgetKey] = attempt;
        fixNote = `fix task ${key} spawned (automatic re-land ${attempt} of ${MAX_AUTOMATIC_RELANDS})`;
      } else {
        fixNote = `fix task ${key} could not be spawned`;
        await raise(
          deps, state, 'fix-spawn-failed',
          `PR #${pr} reverted as ${revertSha}; fix task ${key} could not be spawned. Needs a human.`,
        );
      }
    } else {
      fixNote = `fix budget exhausted for ${budgetKey} (PR #${pr})`;
      await raise(
        deps, state, 'fix-budget-exhausted',
        `PR #${pr} failed again after ${spawned} automatic fix task(s), the limit; reverted ${culprit} (${revertSha}). Needs a human.`,
      );
    }
  }
  if (!revertPromoted) fixNote += '; promotion of the revert rejected, the next cycle retries';
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

/** Index in `candidates` of the newest train-made revert of another candidate, or -1. */
async function newestRevertIndex(deps: TrainDeps, candidates: string[]): Promise<number> {
  const inRange = new Set(candidates);
  for (let i = candidates.length - 1; i >= 0; i--) {
    const body = await deps.git(['log', '-1', '--format=%B', candidates[i]]);
    const m = body.ok ? /^This reverts commit ([0-9a-f]{40})\b/m.exec(body.stdout) : null;
    if (m && inRange.has(m[1]) && body.stdout.includes(TRAIN_REVERT_TRAILER)) return i;
  }
  return -1;
}

function fixPrompt(p: {
  pr: number; culprit: string; revertSha: string; integration: string; failTail: string; issues: number[];
  attempt: number;
}): string {
  // A later attempt must not repeat the fix that was just reverted.
  const earlier = p.attempt > 1
    ? [
      '',
      `This is automatic re-land ${p.attempt} of ${MAX_AUTOMATIC_RELANDS} for this change: ${p.attempt - 1} earlier fix attempt(s) were reverted too.`,
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

/** On promotion, close the still-open issues of every PR commit that reached main. */
async function closeIssuesFor(deps: TrainDeps, shas: string[], promoted: string): Promise<void> {
  const short = promoted.slice(0, 10);
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
    for (const issue of issues) {
      if (issue.state !== 'open') continue;
      await safe(deps, () => deps.github.closeIssue(issue.number, `Verified on main in ${short}.`));
    }
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
