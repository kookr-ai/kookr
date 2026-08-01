/**
 * Incident close-out gate (issue #1750).
 *
 * The harness historically closed its work loop at the **PR-merge boundary**,
 * not the **outcome boundary**. A merged PR that references an incident-labeled
 * issue is inventory, not resolution — the real-world end state the incident
 * describes may still be broken while the fix sits green on main.
 *
 * This module is the pure classifier for that gap:
 *   - decide whether a PR body may use GitHub auto-close (`Closes`) or must
 *     only reference (`Refs`) so merge cannot silently close the incident;
 *   - classify an incident's lifecycle as `fix-merged-unverified` until a
 *     verification probe proves the end state;
 *   - flag stale unverified incidents for standing operator alerts;
 *   - emit a convergence receipt only when verification holds.
 *
 * No I/O, no LLM, no GitHub calls. Callers (playbooks, CLI probes, optional
 * schedule ticks) gather evidence and hand it here.
 */

/** Labels that mark an issue as an incident (case-insensitive match). */
export const DEFAULT_INCIDENT_LABELS: readonly string[] = Object.freeze([
  'incident',
  'p0',
  'prod-incident',
]);

/**
 * Minutes a fix-merged-but-unverified incident may sit before it becomes a
 * standing operator alert. Short enough to catch deploy lag after a merge,
 * long enough that a just-merged fix still in the deploy pipeline is not noise.
 */
export const DEFAULT_UNVERIFIED_ALERT_MINUTES = 30;

/**
 * Lifecycle of an incident under the close-out gate.
 *
 * - `open-unfixed` — open, no fix PR yet
 * - `fix-open` — open, fix PR still open (merge has not happened)
 * - `fix-merged-unverified` — fix merged (or would have closed via keyword),
 *   end-state not yet proven
 * - `verified-converged` — end-state holds; safe to auto-close with a receipt
 * - `re-escalated` — verification ran and failed after the fix merged
 * - `not-incident` — issue is not incident-labeled; gate does not apply
 * - `already-closed` — issue is already closed (terminal; gate is a no-op)
 */
export type IncidentCloseOutState =
  | 'open-unfixed'
  | 'fix-open'
  | 'fix-merged-unverified'
  | 'verified-converged'
  | 're-escalated'
  | 'not-incident'
  | 'already-closed';

/** GitHub closing keywords a PR body may use. */
export type ClosingKeyword = 'Closes' | 'Refs';

/** Kind of end-state verification performed (or requested). */
export type VerificationKind = 'deploy-sha' | 'generic' | 'manual' | 'none';

export interface VerificationResult {
  ok: boolean;
  kind: VerificationKind;
  /** One-line machine-readable receipt for comments / alerts. */
  receipt: string;
  detail?: string;
}

export interface IncidentCloseOutClassification {
  state: IncidentCloseOutState;
  /** True only for `verified-converged` — the sole state that may auto-close. */
  mayClose: boolean;
  /** True when the incident has been fix-merged longer than the alert threshold. */
  staleUnverified: boolean;
  /** Operator-facing one-liner. */
  message: string;
  verification: VerificationResult | null;
  evaluatedAt: string;
}

export interface ClassifyIncidentCloseOutInput {
  /** GitHub issue state. */
  issueState: 'open' | 'closed';
  /** Issue labels (names only). */
  labels?: readonly string[];
  /** Override the default incident-label set. */
  incidentLabels?: readonly string[];
  /** True when at least one open PR references this issue as a fix. */
  hasOpenFixPr?: boolean;
  /** True when at least one merged PR references this issue as a fix. */
  hasMergedFixPr?: boolean;
  /** ISO timestamp of the earliest merged fix PR (for staleness). */
  fixMergedAt?: string | null;
  /** Result of an end-state probe; omit/null when not yet probed. */
  verification?: VerificationResult | null;
  /** Override "now" for deterministic tests. */
  nowMs?: number;
  /** Minutes before fix-merged-unverified becomes a standing alert. */
  unverifiedAlertMinutes?: number;
}

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}

/** True when any label is in the incident set (case-insensitive). */
export function isIncidentLabeled(
  labels: readonly string[] | undefined | null,
  incidentLabels: readonly string[] = DEFAULT_INCIDENT_LABELS,
): boolean {
  if (!labels || labels.length === 0) return false;
  const set = new Set(incidentLabels.map(normalizeLabel));
  return labels.some((l) => set.has(normalizeLabel(l)));
}

/**
 * Keyword a PR body must use when linking an issue.
 *
 * Incident-labeled issues get `Refs` so GitHub merge **cannot** auto-close them.
 * Non-incident issues keep the normal `Closes` keyword.
 */
export function prClosingKeywordForIssue(
  labels: readonly string[] | undefined | null,
  incidentLabels: readonly string[] = DEFAULT_INCIDENT_LABELS,
): ClosingKeyword {
  return isIncidentLabeled(labels, incidentLabels) ? 'Refs' : 'Closes';
}

/** Only `verified-converged` may auto-close the incident. */
export function shouldCloseIncident(state: IncidentCloseOutState): boolean {
  return state === 'verified-converged';
}

/**
 * Normalize a commit SHA for comparison: trimmed, lowercased, hex only.
 * Returns null for anything that is not a plausible SHA.
 */
export function normalizeSha(sha: unknown): string | null {
  if (typeof sha !== 'string') return null;
  const trimmed = sha.trim().toLowerCase();
  if (!/^[0-9a-f]{4,40}$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * True when two SHAs name the same commit, tolerating short-vs-full form by
 * comparing on the shorter length's prefix (git's own abbreviation rule).
 */
export function shasEqual(a: unknown, b: unknown): boolean {
  const na = normalizeSha(a);
  const nb = normalizeSha(b);
  if (!na || !nb) return false;
  const len = Math.min(na.length, nb.length);
  return na.slice(0, len) === nb.slice(0, len);
}

/**
 * Pull the serving commit SHA out of a health/status JSON body.
 *
 * Tolerates several published shapes so one probe works across Kookr
 * (`build.commitHash`, top-level `gitSha`/`sha`) and sibling runtimes that
 * publish `sha` / `gitSha` / `commit` (e.g. lucy deploy-convergence).
 */
export function extractServingSha(health: unknown): string | null {
  if (!health || typeof health !== 'object') return null;
  const h = health as Record<string, unknown>;
  const fromTop =
    normalizeSha(h.sha) ||
    normalizeSha(h.gitSha) ||
    normalizeSha(h.commit) ||
    normalizeSha(h.commitHash);
  if (fromTop) return fromTop;
  const build = h.build;
  if (build && typeof build === 'object') {
    const b = build as Record<string, unknown>;
    return (
      normalizeSha(b.commitHash) ||
      normalizeSha(b.sha) ||
      normalizeSha(b.gitSha) ||
      normalizeSha(b.commit)
    );
  }
  return null;
}

/**
 * Deploy-SHA verification: the process that does the work is serving a commit
 * that includes (or equals) the target. Prefer `servingIncludesTarget` when
 * the caller can compute git ancestry; otherwise fall back to exact identity.
 */
export function verifyDeploySha(input: {
  servingSha: unknown;
  targetSha: unknown;
  servingIncludesTarget?: boolean | null;
}): VerificationResult {
  const serving = normalizeSha(input.servingSha);
  const target = normalizeSha(input.targetSha);
  if (!serving || !target) {
    return {
      ok: false,
      kind: 'deploy-sha',
      receipt: 'deploy-sha:unknown serving or target SHA missing',
      detail: `serving=${serving ?? 'null'} target=${target ?? 'null'}`,
    };
  }
  const included =
    input.servingIncludesTarget == null
      ? shasEqual(serving, target)
      : Boolean(input.servingIncludesTarget);
  if (included) {
    return {
      ok: true,
      kind: 'deploy-sha',
      receipt: `deploy-sha:converged serving=${serving} target=${target}`,
      detail: 'serving runtime includes target commit',
    };
  }
  return {
    ok: false,
    kind: 'deploy-sha',
    receipt: `deploy-sha:divergent serving=${serving} target=${target}`,
    detail: 'serving runtime does not include target commit',
  };
}

/** Generic probe pass/fail with an explicit receipt string. */
export function verifyGeneric(ok: boolean, receipt: string, detail?: string): VerificationResult {
  return {
    ok,
    kind: 'generic',
    receipt,
    ...(detail !== undefined ? { detail } : {}),
  };
}

/**
 * Build the comment body posted when an incident is auto-closed after
 * verification. Stable shape so later audits can grep for the receipt line.
 */
export function buildConvergenceReceipt(input: {
  issueNumber: number;
  fixPrNumbers?: readonly number[];
  verification: VerificationResult;
  evaluatedAt?: string;
}): string {
  const at = input.evaluatedAt ?? new Date().toISOString();
  const prs =
    input.fixPrNumbers && input.fixPrNumbers.length > 0
      ? input.fixPrNumbers.map((n) => `#${n}`).join(', ')
      : '(none recorded)';
  return [
    `Incident close-out gate: verified-converged for #${input.issueNumber}.`,
    '',
    `- Fix PR(s): ${prs}`,
    `- Verification: \`${input.verification.receipt}\``,
    `- Evaluated at: ${at}`,
    '',
    'Merge alone is not resolution; this close was gated on the end-state probe.',
  ].join('\n');
}

function parseIsoMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * True when the incident is in `fix-merged-unverified` and the fix has been
 * merged longer than the alert threshold.
 */
export function isStaleUnverified(input: {
  state: IncidentCloseOutState;
  fixMergedAt?: string | null;
  nowMs?: number;
  thresholdMinutes?: number;
}): boolean {
  if (input.state !== 'fix-merged-unverified') return false;
  const mergedMs = parseIsoMs(input.fixMergedAt ?? null);
  if (mergedMs === null) {
    // Merged but no timestamp → treat as stale so it cannot hide silently.
    return true;
  }
  const now = input.nowMs ?? Date.now();
  const threshold =
    (input.thresholdMinutes ?? DEFAULT_UNVERIFIED_ALERT_MINUTES) * 60_000;
  return now - mergedMs >= threshold;
}

function messageFor(
  state: IncidentCloseOutState,
  verification: VerificationResult | null,
  stale: boolean,
): string {
  switch (state) {
    case 'not-incident':
      return 'not an incident-labeled issue; close-out gate does not apply';
    case 'already-closed':
      return 'issue already closed';
    case 'open-unfixed':
      return 'incident open with no fix PR yet';
    case 'fix-open':
      return 'incident open; fix PR still open (not yet merged)';
    case 'fix-merged-unverified':
      return stale
        ? 'fix merged but end-state still unverified — STALE standing alert'
        : 'fix merged; end-state not yet verified (within grace)';
    case 'verified-converged':
      return verification?.receipt
        ? `end-state verified; safe to close (${verification.receipt})`
        : 'end-state verified; safe to close';
    case 're-escalated':
      return verification?.receipt
        ? `verification failed after fix merge (${verification.receipt})`
        : 'verification failed after fix merge';
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

/**
 * Classify an incident under the close-out gate.
 *
 * Priority (once `isIncident` holds and the issue is open):
 * 1. verification.ok → `verified-converged`
 * 2. verification present and not ok + merged fix → `re-escalated`
 * 3. merged fix, no successful verification → `fix-merged-unverified`
 * 4. open fix PR only → `fix-open`
 * 5. else → `open-unfixed`
 */
export function classifyIncidentCloseOut(
  input: ClassifyIncidentCloseOutInput,
): IncidentCloseOutClassification {
  const evaluatedAt = new Date(input.nowMs ?? Date.now()).toISOString();
  const verification = input.verification ?? null;
  const incidentLabels = input.incidentLabels ?? DEFAULT_INCIDENT_LABELS;
  const isIncident = isIncidentLabeled(input.labels, incidentLabels);

  if (!isIncident) {
    return {
      state: 'not-incident',
      mayClose: false,
      staleUnverified: false,
      message: messageFor('not-incident', verification, false),
      verification,
      evaluatedAt,
    };
  }

  if (input.issueState === 'closed') {
    return {
      state: 'already-closed',
      mayClose: false,
      staleUnverified: false,
      message: messageFor('already-closed', verification, false),
      verification,
      evaluatedAt,
    };
  }

  const hasMerged = Boolean(input.hasMergedFixPr);
  const hasOpen = Boolean(input.hasOpenFixPr);

  let state: IncidentCloseOutState;
  if (hasMerged && verification?.ok) {
    state = 'verified-converged';
  } else if (hasMerged && verification && !verification.ok) {
    state = 're-escalated';
  } else if (hasMerged) {
    state = 'fix-merged-unverified';
  } else if (hasOpen) {
    state = 'fix-open';
  } else {
    state = 'open-unfixed';
  }

  const staleUnverified = isStaleUnverified({
    state,
    fixMergedAt: input.fixMergedAt,
    nowMs: input.nowMs,
    thresholdMinutes: input.unverifiedAlertMinutes,
  });

  return {
    state,
    mayClose: shouldCloseIncident(state),
    staleUnverified,
    message: messageFor(state, verification, staleUnverified),
    verification,
    evaluatedAt,
  };
}
