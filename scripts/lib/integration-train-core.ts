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
  | 'fix-spawn-failed';

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
}

export interface TrainStateStore {
  load(): TrainState;
  save(state: TrainState): void;
}

export interface TrainDeps {
  /** Runs git inside the train's dedicated worktree. */
  git(args: string[]): Promise<GitResult>;
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

export function emptyTrainState(): TrainState {
  return { halted: null, verifiedGreen: [], flakyHeads: [], fixTasks: {} };
}

export function normalizeTrainState(raw: Partial<TrainState> | null | undefined): TrainState {
  const base = emptyTrainState();
  if (!raw || typeof raw !== 'object') return base;
  return {
    halted: raw.halted ?? null,
    verifiedGreen: Array.isArray(raw.verifiedGreen) ? raw.verifiedGreen : base.verifiedGreen,
    flakyHeads: Array.isArray(raw.flakyHeads) ? raw.flakyHeads : base.flakyHeads,
    fixTasks: raw.fixTasks && typeof raw.fixTasks === 'object' ? raw.fixTasks : base.fixTasks,
  };
}

/** Mirrors `delivery_gate_integration_branch` in scripts/lib/delivery-gate.sh. */
export function parseIntegrationBranch(configJson: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configJson);
  } catch {
    return null;
  }
  const branch = (parsed as { integrationBranch?: unknown } | null)?.integrationBranch;
  if (typeof branch !== 'string' || branch === '') return null;
  if (branch.startsWith('-') || branch.includes('..') || !/^[A-Za-z0-9._/-]+$/.test(branch)) return null;
  if (branch === 'main') return null;
  return branch;
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
 * Issue numbers a pull request body closes by the standard keywords
 * (`close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved`, any case,
 * an optional colon, then `#<number>`). GitHub reports no closing references for
 * a pull request whose base is not the default branch, which is every pull
 * request once they target the integration branch, so the train reads the body
 * itself. `owner/repo#n` and URLs are ignored, and so is a keyword that is only
 * the end of a longer word (`prefixes #3`).
 */
export function closingIssueNumbersFromText(text: string): number[] {
  const re = /(?<![A-Za-z0-9_])(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s*:?\s+#(\d+)(?![A-Za-z0-9_])/gi;
  const found: number[] = [];
  for (const m of text.matchAll(re)) {
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

/** Trailer the train puts on its own revert commits, so it can recognise them later. */
export const TRAIN_REVERT_TRAILER = 'Kookr-Integration-Train: revert';

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
    // A standing halt stays quiet: it was announced when it started.
    if (result.outcome === 'idle' || result.outcome === 'promoted' || result.outcome === 'reconciled') {
      await safe(deps, () => deps.notifier.healthy());
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
  let mainSha = await out(['rev-parse', 'origin/main']);
  const headSha = await out(['rev-parse', intRef]);

  // 2. Standing halt: only a moved ref clears it.
  if (state.halted) {
    if (state.halted.main === mainSha && state.halted.integration === headSha) {
      return { outcome: 'halted', reason: state.halted.reason };
    }
    log(`halt "${state.halted.reason}" cleared: a ref moved`);
    state.halted = null;
  }

  const halt = async (reason: string, main: string, int: string, detail: string): Promise<CycleResult> => {
    state.halted = { reason, main, integration: int, at: deps.now().toISOString() };
    log(`HALT ${reason}: ${detail}`);
    await safe(deps, () => deps.notifier.notify('halted', `${reason}: ${detail}`));
    return { outcome: 'halted', reason, detail };
  };

  // 3.
  if (mainSha === headSha) return { outcome: 'idle' };

  // 4. Someone merged straight into main: fold it into the integration branch.
  const ancestor = await git(['merge-base', '--is-ancestor', 'origin/main', intRef]);
  if (!ancestor.ok) {
    await out(['checkout', '--detach', '-q', headSha]);
    const merge = await git(['merge', '--no-edit', 'origin/main']);
    if (!merge.ok) {
      await git(['merge', '--abort']);
      return halt('reconcile-conflict', mainSha, headSha, 'merging origin/main into the integration branch conflicts');
    }
    const push = await pushRef(deps, `HEAD:refs/heads/${integration}`);
    if (!push.ok) {
      log(`reconcile push rejected: ${push.stderr.trim()}`);
      return { outcome: 'retry', detail: 'reconcile push rejected' };
    }
    log(`reconciled ${integration} with main`);
    return { outcome: 'reconciled' };
  }

  // 5. Only commits that contain main. After a reconcile merge (step 4) the
  // commits older than that merge do not include main's changes, so "main is
  // green" proves nothing about them: testing them could fail for a reason main
  // already fixed, and an innocent commit would be blamed. `--ancestry-path`
  // leaves the merge commit and everything after it; if the merge itself is the
  // first bad commit the train halts (culprit-is-merge) for a human.
  const candidates = (await out([
    'rev-list', '--first-parent', '--ancestry-path', '--reverse', `origin/main..${intRef}`,
  ])).split('\n').filter(Boolean);

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

  const promote = async (sha: string): Promise<boolean> => {
    if (!isGreen(sha)) throw new Error(`refusing to promote ${sha}: not verified green by the train`);
    const fresh = (await out(['rev-list', '--first-parent', '--reverse', `origin/main..${sha}`]))
      .split('\n').filter(Boolean);
    // --no-verify: the repo's pre-push hook demands a reviewer marker and runs
    // the test suite; the train's push is itself the verified promotion, so it
    // must bypass the hook. Plain fast-forward, never forced.
    const push = await pushRef(deps, `${sha}:refs/heads/main`);
    if (!push.ok) {
      log(`promotion push of ${sha.slice(0, 10)} rejected: ${push.stderr.trim()}`);
      return false;
    }
    mainSha = sha;
    pushCapped(state.verifiedGreen, sha, VERIFIED_GREEN_CAP);
    log(`promoted ${sha.slice(0, 10)} to main`);
    await closeIssuesFor(deps, fresh, sha);
    return true;
  };

  // Steps 6-9. An arrow function, so the narrowed types above stay narrowed.
  const decide = async (): Promise<CycleResult> => {
  // 6. Verify the head.
  if (await verify(headSha)) {
    if (!(await promote(headSha))) return { outcome: 'retry', detail: 'promotion push rejected' };
    return { outcome: 'promoted' };
  }

  // 7. One re-run to separate a flake from a real failure.
  log(`head ${headSha.slice(0, 10)} red; re-running once`);
  const firstRedTail = redTails.get(headSha) ?? '';
  if (await verify(headSha)) {
    pushCapped(state.flakyHeads, headSha, FLAKY_CAP);
    if (!(await promote(headSha))) return { outcome: 'retry', detail: 'promotion push rejected' };
    return { outcome: 'promoted', detail: 'flaky' };
  }
  if (!redTails.get(headSha)) redTails.set(headSha, firstRedTail);

  // 8. Is main itself red right now? Always re-run it, even when the train
  // verified this SHA earlier: a full disk, a dead network or an overloaded
  // host fails every commit alike, and bisecting through that would blame and
  // revert an innocent change. A red base means "environment", so halt.
  if (!(await verify(mainSha))) {
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
    if (!(await promote(revertCommit))) return { outcome: 'retry', detail: 'promotion of the reverted head rejected' };
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
  if (lastGood !== mainSha && !(await promote(lastGood))) {
    return { outcome: 'retry', detail: 'promotion of last good rejected' };
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
  const push = await pushRef(deps, `${revertSha}:refs/heads/${integration}`);
  if (!push.ok) {
    log(`revert push rejected (branch moved?): ${push.stderr.trim()}`);
    return { outcome: 'retry', detail: 'revert push rejected' };
  }
  // The revert is verified green and contains main: promote it right away. A
  // rejected push is not an error; the next cycle promotes it.
  const revertPromoted = await promote(revertSha);

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
    if (spawned === 0) {
      const key = `train-fix-${budgetKey}-1`;
      const ok = await safe(deps, async () => {
        await deps.spawner.spawn({
          idempotencyKey: key,
          prompt: fixPrompt({ pr, culprit, revertSha, integration, failTail, issues: issueNumbers }),
        });
        return true;
      });
      if (ok === true) {
        // The budget is consumed only by a task that exists.
        state.fixTasks[budgetKey] = 1;
        fixNote = `fix task ${key} spawned`;
      } else {
        fixNote = `fix task ${key} could not be spawned`;
        await safe(deps, () => deps.notifier.notify(
          'fix-spawn-failed',
          `PR #${pr} reverted as ${revertSha}; fix task ${key} could not be spawned. Needs a human.`,
        ));
      }
    } else {
      fixNote = `fix budget exhausted for ${budgetKey} (PR #${pr})`;
      await safe(deps, () => deps.notifier.notify(
        'fix-budget-exhausted',
        `PR #${pr} failed again after an automatic fix task; reverted ${culprit} (${revertSha}). Needs a human.`,
      ));
    }
  }
  if (!revertPromoted) fixNote += '; promotion of the revert rejected, the next cycle retries';
  await safe(deps, () => deps.notifier.notify(
    'reverted', `reverted ${culprit} as ${revertSha} on ${integration}; ${fixNote}`,
  ));
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
}): string {
  const closes = p.issues.length > 0
    ? `5. Deliver through the normal flow (pull request, review, merge). Put ${p.issues.map((n) => `\`Closes #${n}\``).join(' and ')} in the pull request body: the train counts automatic re-lands per issue.`
    : '5. Deliver through the normal flow (pull request, review, merge).';
  return [
    `The integration train reverted PR #${p.pr} because it broke verification on the \`${p.integration}\` branch.`,
    '',
    `- Reverted commit: ${p.culprit}`,
    `- Revert commit: ${p.revertSha}`,
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

/** Best-effort wrapper: a failing side channel never fails the cycle. */
async function safe<T>(deps: TrainDeps, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    deps.log(`best-effort call failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}
