/**
 * Reviewer fan-out workflow contract — the structured, first-class shape of a
 * pre-PR reviewer fan-out (issue #1149).
 *
 * Before this model, each reviewer specialist was launched as an ordinary
 * prompt: the fan-out had no identity, the per-specialist runs were unrelated
 * messages, and the session analyzer had to reconstruct the workflow from the
 * text of those prompts (which polluted repeated-instruction and human-message
 * analytics — see recommendation 4 of the 2026-06-27 reflection report).
 *
 * This contract promotes the fan-out to a workflow object with a specialist
 * role, diff scope, repo/worktree, status, and result summary, so launches can
 * be tagged as machine/workflow events (removing reviewer fan-out from
 * repeated-instruction analytics) and per-specialist results can collapse into
 * ONE parent-visible review result per PR.
 *
 * The existing reviewer-specialist instruction files
 * (`plugin/reviewer-specialists/*.md`) are unchanged: this only changes the
 * transport/metadata shape around them. `src/core/reviewer-fanout.ts` composes
 * those instructions into launches from a workflow object.
 */

/** Current serialization version. Bump on any breaking shape change. */
export const REVIEWER_FANOUT_SCHEMA_VERSION = 1;

/**
 * Sentinel that prefixes a structured reviewer-specialist launch prompt. Its
 * presence marks the launch as a machine/workflow event so analyzers stop
 * counting reviewer fan-out as organic repeated user instructions.
 *
 * The session analyzer mirrors this literal
 * (`plugin/skills/self-reflect/scripts/session-analyzer.ts`,
 * `classifyWorkflowInjectedInstruction`). Keep the two in sync — the analyzer
 * cannot import app source without coupling the standalone plugin to it.
 */
export const REVIEWER_FANOUT_LAUNCH_MARKER = '[[kookr-workflow:reviewer-fanout]]';

/**
 * Specialist roles. `lint-like` is the consolidated conventions + deadcode
 * (+ docs-drift when active) reviewer introduced by the diff-adaptive panel
 * (issue #1305); the others map 1:1 to a `plugin/reviewer-specialists/*.md`.
 */
export type ReviewerSpecialistRole =
  | 'conventions'
  | 'correctness'
  | 'deadcode'
  | 'test'
  | 'docs-drift'
  | 'a11y'
  | 'lint-like';

export const REVIEWER_SPECIALIST_ROLES: readonly ReviewerSpecialistRole[] = [
  'conventions',
  'correctness',
  'deadcode',
  'test',
  'docs-drift',
  'a11y',
  'lint-like',
];

/** Lifecycle status of a single specialist run and of the overall workflow. */
export type ReviewerRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export type ReviewerFindingSeverity = 'blocking' | 'suggestion' | 'info';

/** The slice of the branch each specialist reviews. */
export interface ReviewerDiffScope {
  /** Full repo checkout / worktree path the specialist reads (the `{repoDir}`). */
  repoDir: string;
  /** Base ref the diff is computed against (e.g. `origin/main`). */
  baseRef: string;
  /** Head ref under review (e.g. `HEAD` or the branch name). */
  headRef: string;
  /** Files changed in the diff. May be empty for a docs-only or trivial diff. */
  changedFiles: string[];
}

export interface ReviewerFinding {
  severity: ReviewerFindingSeverity;
  category?: string;
  file?: string;
  comment: string;
}

/** One specialist's slot in the fan-out: its role, inputs, status, and result. */
export interface ReviewerSpecialistRun {
  role: ReviewerSpecialistRole;
  /**
   * Specialist instruction source files composed into this run's prompt,
   * relative to `plugin/reviewer-specialists/`. `lint-like` carries several.
   */
  instructionSources: string[];
  status: ReviewerRunStatus;
  /** Short result summary (the specialist's headline / "no issues found"). */
  summary?: string;
  findings: ReviewerFinding[];
  /** Populated when `status === 'failed'`. */
  error?: string;
}

/** A structured pre-PR reviewer fan-out for one PR. */
export interface ReviewerFanoutWorkflow {
  schemaVersion: number;
  /** Stable id for the fan-out (e.g. `reviewer-fanout:<branch>`). */
  id: string;
  /** PR identity, when known. */
  pr?: { number?: number; branch?: string };
  diffScope: ReviewerDiffScope;
  specialists: ReviewerSpecialistRun[];
  /** Overall status, derived from the specialist runs. */
  status: ReviewerRunStatus;
  /** Whether the full un-consolidated 5-panel was forced (`--force`). */
  force: boolean;
  /** Whether the docs-drift concern is active for this diff. */
  docsDrift: 'active' | 'inactive';
}

/**
 * The single parent-visible result of a fan-out: per-specialist statuses and
 * findings rolled up into one object the parent task consumes instead of N
 * loose reviewer messages.
 */
export interface ReviewerAggregateReview {
  workflowId: string;
  status: ReviewerRunStatus;
  rolesRun: ReviewerSpecialistRole[];
  blockerCount: number;
  suggestionCount: number;
  infoCount: number;
  /** Roles that completed cleanly with no findings. */
  noFindingRoles: ReviewerSpecialistRole[];
  failedRoles: Array<{ role: ReviewerSpecialistRole; error: string }>;
  findings: Array<ReviewerFinding & { role: ReviewerSpecialistRole }>;
  summary: string;
}

/**
 * Serialize a fan-out workflow to a compact, stable JSON string. `schemaVersion`
 * is always stamped from the current constant so round-tripped objects are
 * versioned regardless of what the caller passed in.
 */
export function serializeReviewerFanoutWorkflow(workflow: ReviewerFanoutWorkflow): string {
  return JSON.stringify({ ...workflow, schemaVersion: REVIEWER_FANOUT_SCHEMA_VERSION });
}

/**
 * Parse a serialized fan-out workflow. Throws a descriptive error on malformed
 * or unknown-version input rather than returning a half-built object — callers
 * persisting/reading these want a hard signal, not silent data loss.
 */
export function deserializeReviewerFanoutWorkflow(json: string): ReviewerFanoutWorkflow {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('reviewer-fanout: not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('reviewer-fanout: expected a JSON object');
  }
  const rec = parsed as Record<string, unknown>;
  if (rec.schemaVersion !== REVIEWER_FANOUT_SCHEMA_VERSION) {
    throw new Error(
      `reviewer-fanout: unsupported schemaVersion ${String(rec.schemaVersion)} (expected ${REVIEWER_FANOUT_SCHEMA_VERSION})`,
    );
  }
  if (!Array.isArray(rec.specialists)) {
    throw new Error('reviewer-fanout: "specialists" must be an array');
  }
  if (typeof rec.diffScope !== 'object' || rec.diffScope === null) {
    throw new Error('reviewer-fanout: "diffScope" is required');
  }
  if (typeof rec.id !== 'string') {
    throw new Error('reviewer-fanout: "id" is required');
  }
  return parsed as ReviewerFanoutWorkflow;
}

/**
 * True when `text` is a structured reviewer fan-out launch (carries the
 * machine-event marker on its first non-empty line). Pure and side-effect free
 * so both the orchestrator and the analyzer can classify identically.
 */
export function isReviewerFanoutLaunch(text: string): boolean {
  const firstLine = text.trimStart().split('\n', 1)[0] ?? '';
  return firstLine.includes(REVIEWER_FANOUT_LAUNCH_MARKER);
}
