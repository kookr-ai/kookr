#!/usr/bin/env node
// check-verification — classify a PR head SHA's GitHub check runs so autonomous
// delivery never merges over a check that RAN and failed on the code, and can
// tell that apart from a check that never executed (a GitHub Actions
// budget/quota/billing block that "completes" as failure in seconds without
// running the job).
//
// Background: on 2026-07-30 a billing failure made every check run "complete"
// as failure in 3-7s with the annotation "The job was not started because
// recent account payments have failed or your spending limit needs to be
// increased." 12 PRs merged over those never-executed checks. This classifier
// is the reusable step the delivery playbooks call before merging:
//
//   executed-green  — every check ran and passed (safe to merge)
//   executed-red    — a check RAN and failed on the code (NEVER merge over)
//   never-executed  — a check "failed" without running (billing/quota block);
//                     merge only after the local gate ran and is recorded on
//                     the PR
//   none-required   — the head SHA has no check runs (nothing to verify)
//   pending         — a check is still running or unresolved (wait)
//
// The classifier itself is pure and unit-tested against recorded `gh` JSON
// fixtures (scripts/fixtures/check-verification/). The CLI wrapper shells out to
// `gh` to fetch the head SHA's check runs plus the annotations of any failing
// run, then prints the classification.
//
// When a check has several attempts on the head SHA (re-runs, or a later run of
// the same workflow for the same push or pull request), an attempt that did not
// pass stops counting once a later attempt succeeded after it finished (see
// `selectDecidingRuns`); anything else, such as a re-run that never executed or
// was skipped, or an attempt whose identity is unknown, leaves the earlier
// failure in place.
//
// Usage (also `kookr check-verification`, which runs this file from any repo):
//   node scripts/check-verification.mjs <pr-number> [--repo owner/name]
//   node scripts/check-verification.mjs --sha <sha> --repo owner/name
//   node scripts/check-verification.mjs --from-file <check-runs.json> [--json]
//
// Exit codes (so callers can branch without parsing stdout):
//   0   executed-green | none-required  (no check-run objection to merging)
//   10  never-executed                  (merge only with recorded local-gate evidence)
//   20  executed-red                    (never merge)
//   30  pending                         (checks unresolved; wait)
//   1   usage or runtime error

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Pure classification core (exported for unit tests)
// ---------------------------------------------------------------------------

export const CLASSIFICATIONS = Object.freeze({
  EXECUTED_GREEN: 'executed-green',
  EXECUTED_RED: 'executed-red',
  NEVER_EXECUTED: 'never-executed',
  NONE_REQUIRED: 'none-required',
  PENDING: 'pending',
});

export const EXIT_CODES = Object.freeze({
  'executed-green': 0,
  'none-required': 0,
  'never-executed': 10,
  'executed-red': 20,
  pending: 30,
});

// Conclusions that mean the check settled without objecting to a merge.
const PASSING_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);
// Conclusions that mean the check settled as "not passing". Each is then split
// into executed-red vs never-executed by `neverExecutedReason`.
const FAILING_CONCLUSIONS = new Set([
  'failure',
  'timed_out',
  'action_required',
  'startup_failure',
]);
// Conclusions that are neither a clean pass nor a code failure — a human or the
// platform interrupted the run. Treated as unresolved (pending-like), never as
// a clean green nor a hard red.
const INCONCLUSIVE_CONCLUSIONS = new Set(['cancelled', 'stale', 'skipped_cancelled']);

// The GitHub Actions annotation emitted when a job never starts because of a
// billing/quota/spending-limit block. This is the authoritative never-executed
// signal: on the recorded 2026-07-30 incident every billing-blocked run carried
// exactly this message, including one that "ran" for a full 10s (so a duration
// heuristic alone would have missed it).
export const NEVER_EXECUTED_ANNOTATION_PATTERN =
  /the job was not started|account payments have failed|spending limit needs to be increased|billing (?:&|and) plans/i;

// A failing run that finished this fast AND recorded zero steps almost certainly
// never ran its body. Used only as a corroborating signal alongside zero steps,
// never on duration alone (a genuine fast failure must stay executed-red).
const NEVER_EXECUTED_MAX_SECONDS = 15;

function durationSeconds(run) {
  if (!run || !run.started_at || !run.completed_at) return null;
  const start = Date.parse(run.started_at);
  const end = Date.parse(run.completed_at);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return (end - start) / 1000;
}

function annotationMessages(run) {
  if (!run || !Array.isArray(run.annotations)) return [];
  return run.annotations
    .map((a) => (a && typeof a.message === 'string' ? a.message : ''))
    .filter(Boolean);
}

/**
 * If a failing run never actually executed, return the reason string; otherwise
 * return null. Conservative by design: only positive never-executed signals
 * flip a failure off the executed-red path.
 */
export function neverExecutedReason(run) {
  // A workflow that failed to *start up* (bad YAML, unresolvable runner image)
  // is a real defect the author must fix, not a billing/quota waiver — keep it
  // executed-red.
  if (run && run.conclusion === 'startup_failure') return null;

  // The Actions API sets started_at to an explicit null when GitHub refused to
  // dispatch the job (billing/quota/concurrency). Use `=== null`, not `== null`:
  // a run object that merely OMITS started_at (e.g. a third-party Checks API
  // integration reporting a genuine failure, or a converted commit status) must
  // stay executed-red rather than be waived as never-executed.
  if (run && run.started_at === null) return 'no-start';

  // Billing/quota/spending-limit annotation — the authoritative signal.
  if (annotationMessages(run).some((m) => NEVER_EXECUTED_ANNOTATION_PATTERN.test(m))) {
    return 'billing-annotation';
  }

  // Zero recorded steps + implausibly fast finish. Steps are only present when
  // the caller enriched the run from the jobs API (the CLI does not, so this
  // branch fires only for in-process callers that supply steps); absent steps
  // never trigger it (undefined length !== 0), so a real failure is never
  // misread.
  const steps = run && run.steps;
  const secs = durationSeconds(run);
  if (Array.isArray(steps) && steps.length === 0 && secs != null && secs < NEVER_EXECUTED_MAX_SECONDS) {
    return 'no-steps-fast';
  }

  return null;
}

/**
 * Classify a single check-run object into a verdict.
 * @returns {{name: string, status: string, conclusion: string|null, verdict: 'passed'|'pending'|'inconclusive'|'executed-red'|'never-executed', reason: string|null}}
 */
export function classifyRun(run) {
  const name = (run && (run.name || run.context)) || '(unnamed check)';
  const status = (run && run.status) || 'unknown';
  const conclusion = run && run.conclusion != null ? String(run.conclusion) : null;

  if (status !== 'completed') {
    return { name, status, conclusion, verdict: 'pending', reason: status };
  }

  if (conclusion && PASSING_CONCLUSIONS.has(conclusion)) {
    return { name, status, conclusion, verdict: 'passed', reason: null };
  }

  if (conclusion && INCONCLUSIVE_CONCLUSIONS.has(conclusion)) {
    return { name, status, conclusion, verdict: 'inconclusive', reason: conclusion };
  }

  if (conclusion && FAILING_CONCLUSIONS.has(conclusion)) {
    const reason = neverExecutedReason(run);
    if (reason) {
      return { name, status, conclusion, verdict: 'never-executed', reason };
    }
    return { name, status, conclusion, verdict: 'executed-red', reason: 'executed-failure' };
  }

  // Completed with an unknown/null conclusion — treat as unresolved rather than
  // guessing it passed.
  return { name, status, conclusion, verdict: 'pending', reason: 'unknown-conclusion' };
}

// A GitHub Actions check run is a job: its id is the job id, and its
// details_url ends in /actions/runs/<run id>/job/<job id>.
const ACTIONS_JOB_URL = /\/actions\/runs\/(\d+)\/job\/(\d+)(?:[/?#]|$)/;

/** The Actions job id behind a check run, or null when it is not an Actions job. */
function actionsJobId(run) {
  if (!run) return null;
  const match = typeof run.details_url === 'string' ? run.details_url.match(ACTIONS_JOB_URL) : null;
  if (match) return match[2];
  if (run.app && run.app.slug === 'github-actions' && run.id != null) return String(run.id);
  return null;
}

/** The workflow run an Actions job belongs to (from its workflow_run or details_url), or null. */
function actionsRunId(run) {
  if (!run) return null;
  const wr = run.workflow_run;
  if (wr && wr.id != null && Number.isFinite(Number(wr.id))) return Number(wr.id);
  const match = typeof run.details_url === 'string' ? run.details_url.match(ACTIONS_JOB_URL) : null;
  return match ? Number(match[1]) : null;
}

/**
 * What makes two workflow runs on one SHA the same check, or null when that is
 * not known. A workflow that runs again for the same push (same branch) or the
 * same pull request (a later `pull_request` event, e.g. the body was edited)
 * runs the same code again in a new workflow run, so a new check suite. Every
 * other event stays apart: `dynamic` runs (Dependabot, CodeQL) share one
 * workflow id and event on a SHA yet check different things (three concurrent
 * runs on kookr-ai/kookr 2b3bec44d5, all workflow 272896356), and a
 * `workflow_dispatch` can differ by its inputs. A pull request run needs exactly
 * one pull request on it: two pull requests that share a head branch test
 * different merge commits, and a fork's run lists none. `workflow_run` is
 * filled in from the Actions runs API by the CLI.
 */
function workflowIdentity(run) {
  const wr = run && run.workflow_run;
  if (!wr || wr.workflow_id == null || actionsRunId(run) == null) return null;
  if (wr.event === 'push') {
    return typeof wr.head_branch === 'string' && wr.head_branch ? `${wr.workflow_id}:push:${wr.head_branch}` : null;
  }
  if (wr.event === 'pull_request') {
    const prs = Array.isArray(wr.pull_requests) ? wr.pull_requests : [];
    if (prs.length !== 1) return null;
    const pr = prs[0];
    const base = pr && pr.base && pr.base.ref;
    if (!pr || pr.number == null || typeof base !== 'string' || !base) return null;
    return `${wr.workflow_id}:pull_request:${pr.number}:${base}`;
  }
  return null;
}

// Which attempts are the same check. A re-run of a GitHub Actions job keeps the
// workflow run, so its new check run lands in the same check suite under the
// same name (checked on live data for #4029: attempts 1 and 2 of
// jeanibarz/lucy run 30574675321 are check runs 90979830604 and 90980750962,
// both in suite 82904850390). Two different workflows can share a job name on
// one SHA (three "Dependabot" runs in separate suites in the lucy-green
// fixture), so the suite is part of the key: a green in one workflow never
// hides a red in another. When the workflow runs again as a new workflow run
// for the same push or pull request (a new suite: kookr-ai/kookr 54fba034's
// "Anti-drift checklist" failed in run 30568807476 and passed in run
// 30569267543 after the PR body was edited), `workflowIdentity` replaces the
// suite so both runs group. Without it, the stale failure stays red: the safe
// side. Runs with no name (or no suite/app data) still group by whatever is
// present.
function attemptKey(run) {
  const name = run && (run.name || run.context);
  if (!name) return null;
  const app = run.app && run.app.id != null ? run.app.id : '';
  const identity = workflowIdentity(run);
  if (identity != null) return `${app}|wf:${identity}|${name}`;
  const suite = run.check_suite && run.check_suite.id != null ? run.check_suite.id : '';
  return `${app}|${suite}|${name}`;
}

// Creation order of two attempts of one check. Check-run ids grow with
// creation time, so the id is the order; timestamps are only a fallback (a
// pending re-run has no completed_at, and a billing-blocked one no started_at).
function isLaterAttempt(candidate, current) {
  const a = Number(candidate.run && candidate.run.id);
  const b = Number(current.run && current.run.id);
  if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return a > b;
  const ta = Date.parse((candidate.run && (candidate.run.started_at || candidate.run.completed_at)) || '');
  const tb = Date.parse((current.run && (current.run.started_at || current.run.completed_at)) || '');
  if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb) return ta > tb;
  return candidate.index > current.index;
}

/** The workflow-run attempt (1, 2, ...) an Actions job belongs to, or null when unknown. */
function runAttempt(run) {
  const attempt = run && run.run_attempt;
  return Number.isInteger(attempt) && attempt > 0 ? attempt : null;
}

/**
 * Where each Actions job of one check sits: its workflow run and attempt, and
 * how many same-named jobs share that attempt. `complete` is false when any
 * Actions job in the group has an unknown attempt: then none of them retires,
 * because an uncounted sibling could be the one that failed.
 */
function actionsPositions(group) {
  const positions = new Map();
  const sizes = new Map();
  let complete = true;
  for (const entry of group) {
    if (!actionsJobId(entry.run)) continue;
    const attempt = runAttempt(entry.run);
    if (attempt == null) {
      complete = false;
      continue;
    }
    const runId = actionsRunId(entry.run);
    const slot = `${runId == null ? '' : runId}#${attempt}`;
    positions.set(entry, { runId, attempt, slot });
    sizes.set(slot, (sizes.get(slot) || 0) + 1);
  }
  return { positions, sizes, complete };
}

/** True when Actions position `a` comes after `b`: a later workflow run, or a later attempt of the same one. */
function isLaterPosition(a, b) {
  if (a.runId != null && b.runId != null && a.runId !== b.runId) return a.runId > b.runId;
  return a.attempt > b.attempt;
}

/**
 * True when `later` is a re-run that replaces `earlier`: it succeeded or is
 * still running (so the check stays pending until it settles), was created
 * after `earlier` (higher id), and started only once `earlier` had finished.
 * Two jobs of one workflow run that share a name and overlap in time are
 * siblings, so neither replaces the other; a re-run of a finished job starts
 * after it. Same-named siblings can also run one after the other (a matrix
 * with a fixed `name:` and `max-parallel: 1`, or jobs chained with `needs:`),
 * so for GitHub Actions jobs timing is not enough: `later` must belong to a
 * later attempt of the workflow run (`run_attempt`, filled in from the jobs
 * API) or to a later workflow run of the same workflow (`workflowIdentity`).
 *
 * GitHub gives same-named jobs no identity of their own (no matrix values), so
 * when the failed attempt holds several same-named jobs, a pass of one of them
 * in a later attempt cannot say which one was re-run: re-running only the leg
 * that passed would otherwise retire the leg that failed. So `later`'s attempt
 * must hold at least as many same-named jobs as `earlier`'s: all of them ran
 * again, and any of those that did not pass still counts on its own. A partial
 * re-run of a fixed-name matrix therefore stays red (and a re-run still
 * creating its jobs reads red, not pending, until all of them exist). An
 * unknown attempt anywhere in the group never retires a failure (#4029).
 */
function replacesAttempt(later, earlier, actions) {
  if (!later.run) return false;
  const running = later.run.status !== 'completed';
  if (!running && later.run.conclusion !== 'success') return false;
  const a = Number(later.run.id);
  const b = Number(earlier.run && earlier.run.id);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= b) return false;
  if (actionsJobId(later.run) || actionsJobId(earlier.run)) {
    if (!actions.complete) return false;
    const laterPos = actions.positions.get(later);
    const earlierPos = actions.positions.get(earlier);
    if (!laterPos || !earlierPos || !isLaterPosition(laterPos, earlierPos)) return false;
    if (actions.sizes.get(laterPos.slot) < actions.sizes.get(earlierPos.slot)) return false;
  }
  const started = Date.parse(later.run.started_at || '');
  const finished = Date.parse((earlier.run && earlier.run.completed_at) || '');
  return !Number.isNaN(started) && !Number.isNaN(finished) && started >= finished;
}

/**
 * Pick the attempts that decide each check, so a stale failure followed by a
 * successful re-run is green. The latest attempt always counts. An earlier
 * attempt that did not pass (ran and failed, never executed, cancelled, still
 * running) is dropped only when a later attempt that started after it finished
 * succeeded or is still running (then the check is pending); otherwise it
 * still counts. So a re-run that never executed, was skipped, or
 * is a same-named sibling job never hides a run that failed on the code
 * (see `replacesAttempt`).
 * @returns {{runs: Array<object>, superseded: number}} the deciding verdicts
 *   (in input order) and how many earlier attempts were dropped.
 */
export function selectDecidingRuns(checkRuns) {
  const groups = new Map();
  const order = [];
  checkRuns.forEach((run, index) => {
    const entry = { run, index, verdict: classifyRun(run) };
    const key = attemptKey(run);
    if (key == null) {
      order.push([entry]);
      return;
    }
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
      order.push(group);
    }
    group.push(entry);
  });

  let superseded = 0;
  const deciding = [];
  for (const group of order) {
    let latest = group[0];
    for (const entry of group) if (isLaterAttempt(entry, latest)) latest = entry;
    const actions = actionsPositions(group);
    for (const entry of group) {
      const keep =
        entry === latest ||
        (entry.verdict.verdict !== 'passed' && !group.some((other) => replacesAttempt(other, entry, actions)));
      if (keep) deciding.push(entry);
      else superseded += 1;
    }
  }
  deciding.sort((x, y) => x.index - y.index);
  return { runs: deciding.map((e) => e.verdict), superseded };
}

/**
 * Classify the whole set of check runs for a head SHA. When one check has
 * several attempts (re-runs), see `selectDecidingRuns` for which count.
 * @param {Array<object>|{check_runs: Array<object>}} input raw check-runs
 *   (the `gh api .../check-runs` response, or just its array), with each failing
 *   run optionally carrying an `annotations` array.
 * @returns {{classification: string, mergeSafe: boolean, runs: Array<object>, counts: object, summary: string}}
 */
export function classifyCheckRuns(input) {
  const checkRuns = Array.isArray(input)
    ? input
    : Array.isArray(input && input.check_runs)
      ? input.check_runs
      : [];

  const { runs, superseded } = selectDecidingRuns(checkRuns);
  const counts = {
    total: runs.length,
    superseded,
    passed: runs.filter((r) => r.verdict === 'passed').length,
    executedRed: runs.filter((r) => r.verdict === 'executed-red').length,
    neverExecuted: runs.filter((r) => r.verdict === 'never-executed').length,
    pending: runs.filter((r) => r.verdict === 'pending' || r.verdict === 'inconclusive').length,
  };

  // Priority: a real red always wins; then anything unresolved (still running or
  // cancelled/stale) must be settled before we trust the rest; then a
  // billing/quota never-executed; otherwise everything passed; otherwise empty.
  let classification;
  if (runs.length === 0) {
    classification = CLASSIFICATIONS.NONE_REQUIRED;
  } else if (counts.executedRed > 0) {
    classification = CLASSIFICATIONS.EXECUTED_RED;
  } else if (counts.pending > 0) {
    classification = CLASSIFICATIONS.PENDING;
  } else if (counts.neverExecuted > 0) {
    classification = CLASSIFICATIONS.NEVER_EXECUTED;
  } else {
    classification = CLASSIFICATIONS.EXECUTED_GREEN;
  }

  const mergeSafe =
    classification === CLASSIFICATIONS.EXECUTED_GREEN ||
    classification === CLASSIFICATIONS.NONE_REQUIRED;

  return { classification, mergeSafe, runs, counts, summary: summarize(classification, counts) };
}

function summarize(classification, counts) {
  switch (classification) {
    case CLASSIFICATIONS.EXECUTED_GREEN:
      return `all ${counts.total} check(s) ran and passed`;
    case CLASSIFICATIONS.EXECUTED_RED:
      return `${counts.executedRed} check(s) ran and failed on the code — never merge`;
    case CLASSIFICATIONS.NEVER_EXECUTED:
      return `${counts.neverExecuted} check(s) never executed (billing/quota) — merge only with recorded local-gate evidence`;
    case CLASSIFICATIONS.PENDING:
      return `${counts.pending} check(s) still unresolved — wait`;
    case CLASSIFICATIONS.NONE_REQUIRED:
      return 'no check runs on the head SHA';
    default:
      return classification;
  }
}

// ---------------------------------------------------------------------------
// CLI wrapper (shells out to `gh`)
// ---------------------------------------------------------------------------

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

function resolveRepo(explicit) {
  if (explicit) return explicit;
  const out = gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
  return out.trim();
}

function resolveSha(repo, pr, explicitSha) {
  if (explicitSha) return explicitSha;
  const out = gh(['api', `repos/${repo}/pulls/${pr}`, '--jq', '.head.sha']);
  return out.trim();
}

/**
 * Fetch ALL check runs for a SHA (following pagination) and enrich each failing
 * run with its annotations. Completeness is a safety property, not an
 * optimization: a caller that merges over a `never-executed` verdict must have
 * seen every run, or a real `executed-red` sitting on page 2 would be invisible
 * and the head misread as merge-safe. The commits/check-runs endpoint caps a
 * page at 100 and reports the true count in `total_count`, so keep pulling pages
 * until we have them all.
 */
const CHECK_RUNS_PER_PAGE = 100;
const CHECK_RUNS_MAX_PAGES = 100; // 100*100 = 10k runs — a hard stop against a runaway loop.

/**
 * Page through the check-runs endpoint to its natural end (a short/empty page),
 * deduping by run id. Returns the runs, the page-1 `total_count`, and whether the
 * end was reached within the page budget.
 */
function fetchCheckRunPages(repo, sha) {
  const byId = new Map();
  const unkeyed = [];
  let totalCount = 0;
  let reachedEnd = false;
  for (let page = 1; page <= CHECK_RUNS_MAX_PAGES; page += 1) {
    // `filter=all` (not the API default `latest`): a rerun keeps the same commit
    // SHA, so a check that RAN and failed and was then re-run into a billing block
    // would, under `latest`, show only the never-executed rerun and hide the real
    // failure. We fetch every attempt and let `selectDecidingRuns` decide which
    // still count (only a later success can retire an earlier failure).
    // Attempts have distinct ids, so the dedup-by-id below keeps them all.
    const parsed = JSON.parse(
      gh(['api', `repos/${repo}/commits/${sha}/check-runs?filter=all&per_page=${CHECK_RUNS_PER_PAGE}&page=${page}`]),
    );
    const batch = Array.isArray(parsed.check_runs) ? parsed.check_runs : [];
    if (page === 1) totalCount = Number(parsed.total_count) || 0;
    for (const run of batch) {
      if (run && run.id != null) byId.set(run.id, run);
      else unkeyed.push(run);
    }
    // A short (or empty) page is the authoritative end of the list at read time.
    if (batch.length < CHECK_RUNS_PER_PAGE) {
      reachedEnd = true;
      break;
    }
  }
  return { runs: [...byId.values(), ...unkeyed], totalCount, reachedEnd };
}

/**
 * Assert a pagination pass is a WHOLE, consistent snapshot. Completeness is a
 * SAFETY property, not an optimization: a caller may waive a `never-executed`
 * verdict and merge, so anything short of the whole list must ERROR and refuse
 * the merge — never look quietly clean.
 */
function assertCompletePass(pass, sha) {
  if (!pass.reachedEnd) {
    throw new Error(`check-runs fetch for ${sha} exceeded ${CHECK_RUNS_MAX_PAGES} pages — refusing to classify`);
  }
  if (pass.runs.length < pass.totalCount) {
    throw new Error(
      `incomplete check-runs fetch for ${sha}: retrieved ${pass.runs.length} of ${pass.totalCount} — refusing to classify a partial view`,
    );
  }
}

/**
 * One complete, enriched read of a SHA's checks: all paginated check runs
 * (asserted whole), each failing run enriched with its annotations, plus legacy
 * commit statuses folded in as pseudo-runs. Returns the run array ready to
 * classify.
 */
function collectCheckRuns(repo, sha) {
  const pass = fetchCheckRunPages(repo, sha);
  assertCompletePass(pass, sha);
  const checkRuns = pass.runs;
  for (const run of checkRuns) {
    const annCount = run.output && run.output.annotations_count;
    const settledNotPass =
      run.status === 'completed' && !PASSING_CONCLUSIONS.has(String(run.conclusion));
    if (settledNotPass && annCount > 0) {
      try {
        run.annotations = JSON.parse(gh(['api', `repos/${repo}/check-runs/${run.id}/annotations`]));
      } catch {
        run.annotations = [];
      }
    } else if (!Array.isArray(run.annotations)) {
      run.annotations = [];
    }
  }

  enrichWorkflowRuns(repo, checkRuns);
  enrichActionsAttempts(repo, checkRuns);

  // Legacy commit statuses (Status API) are a separate required-check surface
  // from check runs. A red *required status* would otherwise be invisible here
  // and the head SHA misread as `none-required` / merge-safe. The combined-status
  // endpoint returns a single `state` aggregated over EVERY context (all pages),
  // so reading that — not the first page of the `statuses` array — is complete by
  // construction: a failed context on page 2 still turns `state` to failure. Fold
  // the aggregate in as one pseudo-run. A failing status has no billing/
  // never-executed concept, so it classifies as executed-red (the safe way).
  // `total_count` distinguishes "no statuses" (the common Actions-only case,
  // where `state` defaults to pending) from genuinely pending statuses.
  try {
    const status = JSON.parse(gh(['api', `repos/${repo}/commits/${sha}/status`]));
    const statusCount = Number(status.total_count) || 0;
    const combined = String(status.state || '').toLowerCase();
    if (statusCount > 0) {
      if (combined === 'success') {
        checkRuns.push({ name: 'commit statuses (combined)', status: 'completed', conclusion: 'success', annotations: [] });
      } else if (combined === 'pending') {
        checkRuns.push({ name: 'commit statuses (combined)', status: 'in_progress', conclusion: null, annotations: [] });
      } else {
        // failure | error — at least one required status failed somewhere.
        checkRuns.push({ name: 'commit statuses (combined)', status: 'completed', conclusion: 'failure', annotations: [] });
      }
    }
  } catch {
    // The status fetch itself FAILED (network/API error) — not the same as an
    // empty statuses list, which parses fine above. We cannot rule out a red
    // required status, so fold in a synthetic unresolved run: that forces a
    // `pending` classification (never a clean `never-executed`/green), so a
    // caller waiving on incomplete data is impossible. Fail closed.
    checkRuns.push({
      name: 'commit-status (unreadable)',
      status: 'in_progress',
      conclusion: null,
      annotations: [],
    });
  }

  return checkRuns;
}

/**
 * Record the workflow run behind each Actions job whose name appears in more
 * than one check suite of its app (the only case where `workflowIdentity` can
 * join attempts across suites), from `actions/runs/<run id>`, once per run. A
 * failed lookup leaves the run keyed by its suite, so a stale failure stays
 * red. Runs before `enrichActionsAttempts`, which groups by the result.
 */
function enrichWorkflowRuns(repo, checkRuns) {
  const suitesByName = new Map();
  for (const run of checkRuns) {
    const name = run && (run.name || run.context);
    if (!name || !run.check_suite || run.check_suite.id == null) continue;
    const key = `${run.app && run.app.id != null ? run.app.id : ''}|${name}`;
    if (!suitesByName.has(key)) suitesByName.set(key, new Set());
    suitesByName.get(key).add(run.check_suite.id);
  }
  const cache = new Map();
  for (const run of checkRuns) {
    const name = run && (run.name || run.context);
    if (!name || run.workflow_run || !actionsJobId(run)) continue;
    const key = `${run.app && run.app.id != null ? run.app.id : ''}|${name}`;
    if (!suitesByName.has(key) || suitesByName.get(key).size < 2) continue;
    const runId = actionsRunId(run);
    if (runId == null) continue;
    if (!cache.has(runId)) {
      let found = null;
      try {
        const wr = JSON.parse(gh(['api', `repos/${repo}/actions/runs/${runId}`]));
        // A workflow run whose suite is not this check run's own is not its run.
        if (wr && Number(wr.id) === runId && Number(wr.check_suite_id) === Number(run.check_suite.id)) {
          found = {
            id: runId,
            workflow_id: wr.workflow_id,
            event: wr.event,
            head_branch: wr.head_branch,
            pull_requests: Array.isArray(wr.pull_requests)
              ? wr.pull_requests.map((pr) => ({ number: pr && pr.number, base: { ref: pr && pr.base && pr.base.ref } }))
              : [],
          };
        }
      } catch {
        // Unknown workflow run: this check stays keyed by its suite.
      }
      cache.set(runId, found);
    }
    const found = cache.get(runId);
    if (found) run.workflow_run = found;
  }
}

/**
 * Record each Actions job's workflow-run attempt (`run_attempt`) on its check
 * run, which the check-runs API does not carry, so `replacesAttempt` can tell
 * a re-run from a same-named sibling job. Only checks with more than one
 * attempt need it. A failed lookup leaves the attempt unknown, and an unknown
 * attempt never retires a failure.
 */
function enrichActionsAttempts(repo, checkRuns) {
  const sizes = new Map();
  for (const run of checkRuns) {
    const key = attemptKey(run);
    if (key != null) sizes.set(key, (sizes.get(key) || 0) + 1);
  }
  for (const run of checkRuns) {
    const key = attemptKey(run);
    if (key == null || sizes.get(key) < 2 || runAttempt(run) != null) continue;
    const jobId = actionsJobId(run);
    if (jobId == null) continue;
    try {
      run.run_attempt = JSON.parse(gh(['api', `repos/${repo}/actions/jobs/${jobId}`])).run_attempt;
    } catch {
      // Unknown attempt: this run cannot retire, or be retired by, another one.
    }
  }
}

function fetchCheckRuns(repo, sha) {
  const first = collectCheckRuns(repo, sha);
  // Enumerating a mutable check set is not atomic: across our page reads a run
  // can be inserted, removed, or updated (its conclusion OR started_at flipped),
  // so a single read can classify a set that never existed as a whole. Read the
  // WHOLE set a second time and compare the VERDICTS — not a hand-picked field
  // list, which is fragile (miss one field and a state change slips through).
  // Classifying both reads and requiring the same verdict is immune to which
  // field changed: any change that would alter the classification is caught, and
  // one that would not is harmless. Fail closed on a mismatch. A change occurring
  // entirely after this second read is the irreducible residual of a non-snapshot
  // API; the exact-head commit pin bounds it at merge time.
  const second = collectCheckRuns(repo, sha);
  const firstClass = classifyCheckRuns(first).classification;
  const secondClass = classifyCheckRuns(second).classification;
  if (firstClass !== secondClass) {
    throw new Error(
      `check-runs verdict changed during pagination for ${sha} (${firstClass} -> ${secondClass}) — refusing to classify a set that mutated mid-scan`,
    );
  }

  return { total_count: first.length, check_runs: first };
}

function parseArgs(argv) {
  const opts = { pr: null, repo: null, sha: null, fromFile: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--repo') opts.repo = argv[(i += 1)];
    else if (arg.startsWith('--repo=')) opts.repo = arg.slice('--repo='.length);
    else if (arg === '--sha') opts.sha = argv[(i += 1)];
    else if (arg.startsWith('--sha=')) opts.sha = arg.slice('--sha='.length);
    else if (arg === '--from-file') opts.fromFile = argv[(i += 1)];
    else if (arg.startsWith('--from-file=')) opts.fromFile = arg.slice('--from-file='.length);
    else if (arg === '--json') opts.json = true;
    else if (arg === '-h' || arg === '--help') opts.help = true;
    else if (!arg.startsWith('-') && opts.pr == null) opts.pr = arg;
    else throw new Error(`unexpected argument: ${arg}`);
  }
  return opts;
}

const USAGE = `Usage (kookr check-verification takes the same arguments):
  node scripts/check-verification.mjs <pr-number> [--repo owner/name] [--json]
  node scripts/check-verification.mjs --sha <sha> --repo owner/name [--json]
  node scripts/check-verification.mjs --from-file <check-runs.json> [--json]`;

function printHuman(result, context) {
  const label = result.classification.toUpperCase();
  if (context) console.log(context);
  console.log(`Classification: ${label} — ${result.summary}`);
  if (result.counts.superseded > 0) {
    console.log(`  (${result.counts.superseded} earlier attempt(s) superseded by a re-run of the same check)`);
  }
  for (const run of result.runs) {
    const detail = run.reason ? ` (${run.reason})` : '';
    console.log(`  - ${run.name}: ${run.verdict}${detail}`);
  }
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`check-verification: ${err.message}\n\n${USAGE}`);
    process.exit(1);
  }
  if (opts.help) {
    console.log(USAGE);
    process.exit(0);
  }

  let result;
  let context = '';
  try {
    if (opts.fromFile) {
      const parsed = JSON.parse(readFileSync(opts.fromFile, 'utf8'));
      result = classifyCheckRuns(parsed);
      context = `Check verification from ${opts.fromFile}`;
    } else {
      if (opts.pr == null && !opts.sha) {
        console.error(`check-verification: a PR number, --sha, or --from-file is required\n\n${USAGE}`);
        process.exit(1);
      }
      const repo = resolveRepo(opts.repo);
      const sha = resolveSha(repo, opts.pr, opts.sha);
      const checkRuns = fetchCheckRuns(repo, sha);
      result = classifyCheckRuns(checkRuns);
      const ref = opts.pr != null ? `#${opts.pr} @ ${sha.slice(0, 12)}` : sha.slice(0, 12);
      context = `Check verification for ${repo} ${ref}`;
    }
  } catch (err) {
    console.error(`check-verification: ${err.message}`);
    process.exit(1);
  }

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHuman(result, context);
  }
  process.exit(EXIT_CODES[result.classification] ?? 1);
}

// Only run the CLI when invoked directly, not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
