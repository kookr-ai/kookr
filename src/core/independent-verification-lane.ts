/**
 * Independent verification lane (issue #1847).
 *
 * After lucy#1890 disabled GitHub Actions ("local verification is the merge
 * gate"), the merge gate degraded to **100% same-context local verification**:
 * the authoring agent's own environment validates the authoring agent's own
 * work, with zero independent execution signal. That is an acceptable emergency
 * bridge but a dangerous steady state — a bad merge that passes locally but is
 * genuinely broken stays invisible until it reaches prod.
 *
 * This lane restores an independent **execution** signal without re-entering the
 * billing trap that motivated #1890: a fresh-context worker clean-clones a
 * merged SHA, installs from scratch, and runs the full suite in an environment
 * distinct from the authoring task. A red result files an incident routed
 * through the existing close-out gate (#1750/#1802); a green result is recorded
 * so the sweep does not re-run it.
 *
 * Distinct from `independent-merge-review` (plugin/skills), which *reviews* a
 * diff in fresh context but does not independently *execute* the test suite.
 *
 * This module is the **pure** core: no clone, no install, no test run, no
 * GitHub calls. Callers (the CLI, playbooks, optional schedule ticks) gather
 * live evidence and hand it here.
 *
 * Safety invariant: the lane is **additive and tightening-only**. It can flag /
 * file an incident but can never approve, auto-merge, or loosen a gate. See
 * {@link LANE_CAPABILITIES} and {@link assertTighteningOnlyAction}.
 */

import { normalizeSha } from './incident-close-out.js';

/**
 * Capability manifest for the lane. Frozen so the contract is not mutated at
 * runtime, and asserted in tests: the lane may surface failures only.
 */
export const LANE_CAPABILITIES = Object.freeze({
  /** May open an incident issue when a run is red. */
  canFileIncident: true,
  /** May post a non-closing flag comment. */
  canFlag: true,
  /** Never merges a PR. */
  canMerge: false,
  /** Never approves a PR / posts a passing review verdict. */
  canApprove: false,
  /** Never closes an issue or loosens a gate. */
  canLoosenGate: false,
} as const);

/** Actions the lane is permitted to take. Anything else is a contract breach. */
export type LaneAction = 'file-incident' | 'flag' | 'record-green' | 'record-error' | 'noop';

/** Actions that are structurally forbidden — the lane can only tighten. */
type ForbiddenLaneAction = 'merge' | 'approve' | 'close-issue' | 'loosen-gate';

const FORBIDDEN_ACTIONS: ReadonlySet<string> = new Set<ForbiddenLaneAction>([
  'merge',
  'approve',
  'close-issue',
  'loosen-gate',
]);

/**
 * Guard used by the CLI before it acts. Throws if asked to take an action that
 * would approve or loosen — making "flag/incident only" enforceable, not just
 * documented. Returns the action unchanged when allowed.
 */
export function assertTighteningOnlyAction(action: string): LaneAction {
  if (FORBIDDEN_ACTIONS.has(action)) {
    throw new Error(
      `independent-verification-lane: forbidden action "${action}" — the lane is flag/incident only and can never approve, merge, close, or loosen (issue #1847)`,
    );
  }
  return action as LaneAction;
}

/**
 * Cadence for the lane.
 * - `per-merge` — verify a single named SHA (cheap enough to run on each merge).
 * - `rolling-sweep` — walk a bounded window of recently-merged SHAs and file on
 *   the first red, so cost is capped regardless of merge volume.
 */
export type LaneCadence = 'per-merge' | 'rolling-sweep';

/** Default number of SHAs a rolling sweep will verify in one tick. */
export const DEFAULT_SWEEP_LIMIT = 5;

/**
 * Hard ceiling on a sweep so a mis-configured window can never re-create the
 * resource pressure that motivated #1890.
 */
export const MAX_SWEEP_LIMIT = 20;

/** Resolve a cadence string, defaulting to the bounded rolling sweep. */
export function resolveCadence(raw: string | undefined | null): LaneCadence {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'per-merge' || v === 'permerge' || v === 'merge') return 'per-merge';
  return 'rolling-sweep';
}

/** Clamp a requested sweep limit into `[1, MAX_SWEEP_LIMIT]`. */
export function boundSweepLimit(raw: number | undefined | null): number {
  if (raw == null || !Number.isFinite(raw)) return DEFAULT_SWEEP_LIMIT;
  const n = Math.floor(raw);
  if (n < 1) return 1;
  if (n > MAX_SWEEP_LIMIT) return MAX_SWEEP_LIMIT;
  return n;
}

/** A commit merged to the base branch, as seen by the caller. */
export interface MergedCommit {
  sha: string;
  prNumber?: number;
  subject?: string;
  /** ISO timestamp the commit merged (for ordering / receipts). */
  mergedAt?: string;
}

export interface SelectTargetsInput {
  cadence: LaneCadence;
  /** Recently-merged commits, caller-ordered newest-first. */
  merged: readonly MergedCommit[];
  /** SHAs already verified (any status) — used to dedup across ticks. */
  alreadyVerified?: readonly string[];
  /** Bound for a rolling sweep. Ignored for per-merge. */
  sweepLimit?: number;
  /** The single SHA to verify in per-merge mode. */
  targetSha?: string | null;
}

/** A normalized target the lane will actually run. */
export interface VerificationTarget {
  sha: string;
  prNumber?: number;
  subject?: string;
  mergedAt?: string;
}

function toTarget(c: MergedCommit): VerificationTarget | null {
  const sha = normalizeSha(c.sha);
  if (!sha) return null;
  return {
    sha,
    ...(c.prNumber !== undefined ? { prNumber: c.prNumber } : {}),
    ...(c.subject !== undefined ? { subject: c.subject } : {}),
    ...(c.mergedAt !== undefined ? { mergedAt: c.mergedAt } : {}),
  };
}

/**
 * Decide which merged SHAs to verify this tick.
 *
 * - Normalizes and de-duplicates against `alreadyVerified` (short-vs-full SHA
 *   tolerant via the shared `normalizeSha`), so a green SHA is never re-run.
 * - `per-merge` returns at most the one `targetSha` (unless already verified).
 * - `rolling-sweep` returns up to `sweepLimit` un-verified commits, preserving
 *   the caller's newest-first order, so the freshest un-checked merge is
 *   verified first and the total is bounded.
 */
export function selectVerificationTargets(input: SelectTargetsInput): VerificationTarget[] {
  const verified = new Set(
    (input.alreadyVerified ?? [])
      .map((s) => normalizeSha(s))
      .filter((s): s is string => s !== null),
  );
  const isVerified = (sha: string): boolean => {
    if (verified.has(sha)) return true;
    // Tolerate short/long mismatch: a stored abbreviation covers a longer form.
    for (const v of verified) {
      const len = Math.min(v.length, sha.length);
      if (v.slice(0, len) === sha.slice(0, len)) return true;
    }
    return false;
  };

  if (input.cadence === 'per-merge') {
    const sha = normalizeSha(input.targetSha);
    if (!sha || isVerified(sha)) return [];
    const match = input.merged.find((c) => {
      const cs = normalizeSha(c.sha);
      if (!cs) return false;
      const len = Math.min(cs.length, sha.length);
      return cs.slice(0, len) === sha.slice(0, len);
    });
    const target = match ? toTarget(match) : { sha };
    return target ? [target] : [];
  }

  const limit = boundSweepLimit(input.sweepLimit);
  const out: VerificationTarget[] = [];
  const seen = new Set<string>();
  for (const c of input.merged) {
    if (out.length >= limit) break;
    const t = toTarget(c);
    if (!t) continue;
    if (isVerified(t.sha) || seen.has(t.sha)) continue;
    seen.add(t.sha);
    out.push(t);
  }
  return out;
}

/** Outcome of a full-suite run against a clean checkout. */
export type SuiteRunStatus = 'green' | 'red' | 'error';

export interface SuiteRunResult {
  status: SuiteRunStatus;
  /** Process exit code of the suite command (or the failing phase). */
  exitCode: number;
  /** Command that was run, e.g. `pnpm test`. */
  suite: string;
  durationMs?: number;
  /** Short human summary of the failure, if any. */
  failedSummary?: string;
  /** Tail of the run log for the incident body. */
  logExcerpt?: string;
}

/**
 * Classify a suite run from its exit code.
 *
 * - `infraError: true` → the run could not complete (clone/install failed
 *   before tests executed) → `error`. Safe default: infra flakes do **not**
 *   file a product incident, so the lane never cries wolf; the CLI still exits
 *   non-zero so the operator sees it.
 * - exit `0` → `green`; any other exit → `red`.
 */
export function classifySuiteExit(
  exitCode: number,
  opts?: { infraError?: boolean },
): SuiteRunStatus {
  if (opts?.infraError) return 'error';
  return exitCode === 0 ? 'green' : 'red';
}

/** Only a genuine red (tests ran and failed) files an incident. */
export function shouldFileIncident(status: SuiteRunStatus): boolean {
  return status === 'red';
}

/** The action the lane takes after a run — always a tightening-only action. */
export function laneActionForRun(status: SuiteRunStatus): LaneAction {
  switch (status) {
    case 'red':
      return 'file-incident';
    case 'green':
      return 'record-green';
    case 'error':
      return 'record-error';
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

/** Grep-able marker so audits and dedup can find lane-filed incidents. */
export const INCIDENT_LANE_MARKER = '<!-- kookr-independent-verification-lane -->';

/** Short SHA length used in titles / dedup keys. */
const SHORT_SHA_LEN = 12;

export function shortSha(sha: string): string {
  const n = normalizeSha(sha);
  return (n ?? sha).slice(0, SHORT_SHA_LEN);
}

/** Stable dedup key for a red SHA, embedded in the incident body. */
export function incidentDedupeKey(sha: string): string {
  return `iv-lane:${shortSha(sha)}`;
}

export interface IncidentReportInput {
  sha: string;
  prNumber?: number;
  subject?: string;
  mergedAt?: string;
  repo?: string;
  /** Command that was run, e.g. `pnpm test`. */
  suite: string;
  failedSummary?: string;
  logExcerpt?: string;
  /** Override "now" for deterministic output. */
  evaluatedAt?: string;
  /** Labels to apply; defaults to `['incident']` so the close-out gate owns it. */
  labels?: readonly string[];
}

export interface IncidentReport {
  title: string;
  body: string;
  labels: string[];
  dedupeKey: string;
}

const MAX_LOG_EXCERPT_CHARS = 4_000;

function clampExcerpt(text: string | undefined): string | undefined {
  if (!text) return undefined;
  if (text.length <= MAX_LOG_EXCERPT_CHARS) return text;
  return `…(truncated)…\n${text.slice(-MAX_LOG_EXCERPT_CHARS)}`;
}

/**
 * Build the incident issue for a red SHA.
 *
 * The body carries machine-readable lines the close-out gate and audits can
 * parse, and deliberately uses **no** GitHub closing keyword — the lane opens
 * incidents, it never closes them. The incident is `incident`-labeled so the
 * existing close-out gate (#1750/#1802) governs its lifecycle: it stays
 * `fix-merged-unverified` until an independent green re-run converges it.
 */
export function buildIncidentReport(input: IncidentReportInput): IncidentReport {
  const sha = normalizeSha(input.sha) ?? input.sha;
  const short = shortSha(sha);
  const dedupeKey = incidentDedupeKey(sha);
  const at = input.evaluatedAt ?? new Date().toISOString();
  const labels = [...(input.labels ?? ['incident'])];
  const prSuffix = input.prNumber ? ` (PR #${input.prNumber})` : '';

  const title = `Independent verification: full suite RED on merged ${short}${prSuffix}`;

  const machine = [
    INCIDENT_LANE_MARKER,
    'iv-lane-verdict: red',
    `iv-lane-sha: ${sha}`,
    `iv-lane-pr: ${input.prNumber ?? '-'}`,
    `iv-lane-suite: ${input.suite}`,
    `iv-lane-dedupe: ${dedupeKey}`,
    `iv-lane-evaluated-at: ${at}`,
  ].join('\n');

  const lines: string[] = [
    machine,
    '',
    '## Independent verification lane — RED',
    '',
    'A fresh-context worker clean-cloned a merged commit, installed from',
    'scratch, and ran the full suite in an environment isolated from the',
    'authoring task. The suite **failed** — this merge passes same-context',
    'local verification but is broken under independent execution.',
    '',
    '### Merge under test',
    '',
    `- Commit: \`${sha}\``,
    ...(input.prNumber ? [`- PR: #${input.prNumber}`] : []),
    ...(input.subject ? [`- Subject: ${input.subject}`] : []),
    ...(input.mergedAt ? [`- Merged at: ${input.mergedAt}`] : []),
    ...(input.repo ? [`- Repo: ${input.repo}`] : []),
    `- Suite: \`${input.suite}\``,
    `- Detected at: ${at}`,
  ];

  if (input.failedSummary) {
    lines.push('', '### Failure summary', '', input.failedSummary);
  }

  const excerpt = clampExcerpt(input.logExcerpt);
  if (excerpt) {
    lines.push('', '### Run log (tail)', '', '```', excerpt, '```');
  }

  lines.push(
    '',
    '### Lifecycle',
    '',
    'This is `incident`-labeled, so the close-out gate (#1750/#1802) owns it:',
    'it stays `fix-merged-unverified` until an independent green re-run',
    'converges the end state. **Do not close on merge or on same-context local',
    'green alone** — close only with a convergence receipt from an independent',
    'green run of this suite.',
    '',
    '_Filed by the independent verification lane (#1847). This lane is',
    'flag/incident-only: it never approves, merges, closes, or loosens a gate._',
  );

  return { title, body: lines.join('\n'), labels, dedupeKey };
}
