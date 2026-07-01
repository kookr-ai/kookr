// PR Checklist Contract — shared types (P1).
// See docs/rfc/rfc-pr-checklist-contract.md.

export type CheckStatus = 'pass' | 'fail' | 'waived' | 'skipped';

export interface CheckResult {
  /** Marker id without the `kookr:check:` / `pr:` prefix, or a synthetic id for structural checks. */
  id: string;
  status: CheckStatus;
  /** Human-readable, content-free explanation (S6: never echoes body/file/secret values). */
  summary: string;
  /** Present when the author struck the box; the recorded reason. */
  reason?: string;
}

export interface VerifyReport {
  /** True iff every result is pass/waived/skipped (no fails). */
  ok: boolean;
  /** True when the PR body was available and attestation rules ran. */
  bodyChecked: boolean;
  results: CheckResult[];
  /** Non-fatal notes (unknown ids, degraded diff base, etc.). */
  notes: string[];
}

/** One parsed checklist line carrying a `<!-- kookr:check:id -->` (or legacy `<!-- pr:id -->`) marker. */
export interface ChecklistRow {
  id: string;
  checked: boolean;
  struck: boolean;
  reason: string;
}

/** Facts about the diff the engine evaluates rules against. */
export interface DiffFacts {
  /** Repo-relative paths changed in the range (any status). */
  changedPaths: string[];
  /** Repo-relative paths added (status A) in the range. */
  addedFiles: string[];
  /** Added ('+') lines under src, for env-var extraction. */
  addedSourceLines: string[];
  /** Added ('+') lines outside env-templates/markdown, for the secret scan. */
  addedScannableLines: { file: string; text: string }[];
  /** True when the diff base could not be resolved (rules that need a diff are skipped, not failed). */
  baseUnresolved: boolean;
}
