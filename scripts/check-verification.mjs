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
// Usage:
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

/**
 * Classify the whole set of check runs for a head SHA.
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

  const runs = checkRuns.map(classifyRun);
  const counts = {
    total: runs.length,
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

/** Fetch check runs for a SHA and enrich each failing run with its annotations. */
function fetchCheckRuns(repo, sha) {
  const raw = gh(['api', `repos/${repo}/commits/${sha}/check-runs?per_page=100`]);
  const parsed = JSON.parse(raw);
  const checkRuns = Array.isArray(parsed.check_runs) ? parsed.check_runs : [];
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

  // Legacy commit statuses (Status API) are a separate required-check surface
  // from check runs. A red *required status* would otherwise be invisible here
  // and the head SHA misread as `none-required` / merge-safe. Fold statuses in
  // as pseudo-runs; a failing status has no billing/never-executed concept, so
  // it carries no annotations and no null started_at and thus classifies as
  // executed-red (the safe direction).
  try {
    const status = JSON.parse(gh(['api', `repos/${repo}/commits/${sha}/status?per_page=100`]));
    for (const s of Array.isArray(status.statuses) ? status.statuses : []) {
      const state = String(s.state);
      if (state === 'success') {
        checkRuns.push({ name: s.context, status: 'completed', conclusion: 'success', annotations: [] });
      } else if (state === 'pending') {
        checkRuns.push({ name: s.context, status: 'in_progress', conclusion: null, annotations: [] });
      } else {
        // failure | error — a genuine red status.
        checkRuns.push({ name: s.context, status: 'completed', conclusion: 'failure', annotations: [] });
      }
    }
  } catch {
    // Status API unavailable or empty — check runs alone still classify.
  }

  return { total_count: checkRuns.length, check_runs: checkRuns };
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

const USAGE = `Usage:
  node scripts/check-verification.mjs <pr-number> [--repo owner/name] [--json]
  node scripts/check-verification.mjs --sha <sha> --repo owner/name [--json]
  node scripts/check-verification.mjs --from-file <check-runs.json> [--json]`;

function printHuman(result, context) {
  const label = result.classification.toUpperCase();
  if (context) console.log(context);
  console.log(`Classification: ${label} — ${result.summary}`);
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
