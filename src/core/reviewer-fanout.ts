/**
 * Reviewer fan-out orchestration (issue #1149).
 *
 * Turns a structured {@link ReviewerFanoutWorkflow} into specialist launches and
 * rolls the per-specialist runs back up into ONE parent-visible aggregate. The
 * transport/metadata shape is new; the specialist instructions themselves are
 * the unchanged `plugin/reviewer-specialists/*.md` bodies — this module only
 * composes them and tags each launch as a machine/workflow event.
 *
 * Pure by design: instruction bodies are supplied through an injected loader so
 * this module does no filesystem I/O and stays trivially testable. The skill
 * (`plugin/skills/pre-pr-review/SKILL.md`) is the runtime caller that reads the
 * files and spawns the agents.
 */

import {
  REVIEWER_FANOUT_LAUNCH_MARKER,
  REVIEWER_FANOUT_SCHEMA_VERSION,
  REVIEWER_SPECIALIST_ROLES,
  type ReviewerAggregateReview,
  type ReviewerDiffScope,
  type ReviewerFanoutWorkflow,
  type ReviewerRunStatus,
  type ReviewerSpecialistRole,
  type ReviewerSpecialistRun,
} from '../shared/contracts/reviewer-fanout.js';

/**
 * Which `plugin/reviewer-specialists/*.md` files compose each role's prompt.
 * `lint-like` folds conventions + deadcode (docs-drift is appended at launch
 * time only when the workflow marks it active — see {@link instructionSources}).
 */
export const SPECIALIST_INSTRUCTION_FILES: Record<ReviewerSpecialistRole, string[]> = {
  conventions: ['conventions-specialist.md'],
  correctness: ['correctness-specialist.md'],
  deadcode: ['deadcode-specialist.md'],
  test: ['test-specialist.md'],
  'docs-drift': ['docs-drift-specialist.md'],
  a11y: ['a11y-specialist.md'],
  'lint-like': ['conventions-specialist.md', 'deadcode-specialist.md'],
};

/** Resolve the instruction files for a role given whether docs-drift is active. */
export function instructionSources(
  role: ReviewerSpecialistRole,
  docsDriftActive: boolean,
): string[] {
  const base = SPECIALIST_INSTRUCTION_FILES[role] ?? [];
  if (role === 'lint-like' && docsDriftActive) {
    return [...base, 'docs-drift-specialist.md'];
  }
  return base;
}

export interface CreateReviewerFanoutInput {
  /** Selected specialist roles (e.g. from `select-specialists.sh`). */
  roles: ReviewerSpecialistRole[];
  diffScope: ReviewerDiffScope;
  pr?: { number?: number; branch?: string };
  force?: boolean;
  docsDrift?: 'active' | 'inactive';
  /** Override the derived id (defaults to `reviewer-fanout:<branch|headRef>`). */
  id?: string;
}

/**
 * Build a fan-out workflow object from a panel selection. Every specialist
 * starts `pending`; the overall status is `pending` until runs are recorded.
 * Duplicate roles are dropped so the panel is a set.
 */
export function createReviewerFanoutWorkflow(
  input: CreateReviewerFanoutInput,
): ReviewerFanoutWorkflow {
  const docsDrift = input.docsDrift ?? 'inactive';
  const seen = new Set<ReviewerSpecialistRole>();
  const specialists: ReviewerSpecialistRun[] = [];
  for (const role of input.roles) {
    if (seen.has(role)) continue;
    seen.add(role);
    specialists.push({
      role,
      instructionSources: instructionSources(role, docsDrift === 'active'),
      status: 'pending',
      findings: [],
    });
  }

  const branch = input.pr?.branch ?? input.diffScope.headRef;
  return {
    schemaVersion: REVIEWER_FANOUT_SCHEMA_VERSION,
    id: input.id ?? `reviewer-fanout:${branch}`,
    pr: input.pr,
    diffScope: input.diffScope,
    specialists,
    status: 'pending',
    force: input.force ?? false,
    docsDrift,
  };
}

/** A single specialist launch derived from the workflow. */
export interface ReviewerSpecialistLaunch {
  role: ReviewerSpecialistRole;
  /** Suggested spawn label / task name (e.g. `review_correctness`). */
  label: string;
  /** Full prompt: machine-event marker header + composed specialist body. */
  prompt: string;
  /** Always true — a structured launch is a machine/workflow event. */
  machineEvent: true;
}

/**
 * Compose the launch prompt for one specialist run. The prompt opens with the
 * {@link REVIEWER_FANOUT_LAUNCH_MARKER} header (so analyzers classify it as a
 * machine event), followed by the verbatim specialist instruction body with
 * `{repoDir}` and the diff scope inlined.
 *
 * `loadInstruction(fileName)` returns the raw body of a
 * `plugin/reviewer-specialists/*.md` file — injected so this stays pure.
 */
export function buildSpecialistLaunch(
  workflow: ReviewerFanoutWorkflow,
  run: ReviewerSpecialistRun,
  loadInstruction: (fileName: string) => string,
): ReviewerSpecialistLaunch {
  const body = run.instructionSources
    .map((file) => loadInstruction(file).trim())
    .filter(Boolean)
    .join('\n\n---\n\n')
    // Function replacement so a `$` in the path (legal in POSIX) is not
    // interpreted as a `$&`/`$n` replacement pattern.
    .replace(/\{repoDir\}/g, () => workflow.diffScope.repoDir);

  const header = [
    `${REVIEWER_FANOUT_LAUNCH_MARKER} role=${run.role} workflow=${workflow.id}`,
    `Repo: ${workflow.diffScope.repoDir}`,
    `Diff scope: ${workflow.diffScope.baseRef}..${workflow.diffScope.headRef}` +
      ` (${workflow.diffScope.changedFiles.length} changed file(s))`,
  ].join('\n');

  return {
    role: run.role,
    label: `review_${run.role.replace(/-/g, '_')}`,
    prompt: `${header}\n\n${body}`,
    machineEvent: true,
  };
}

/** Build launches for every specialist in the workflow. */
export function buildSpecialistLaunches(
  workflow: ReviewerFanoutWorkflow,
  loadInstruction: (fileName: string) => string,
): ReviewerSpecialistLaunch[] {
  return workflow.specialists.map((run) => buildSpecialistLaunch(workflow, run, loadInstruction));
}

/**
 * Overall status from the specialist runs: `failed` if any failed, else
 * `running` if any is still pending/running, else `completed` when at least one
 * ran, else `pending`.
 */
export function deriveWorkflowStatus(specialists: ReviewerSpecialistRun[]): ReviewerRunStatus {
  if (specialists.length === 0) return 'pending';
  if (specialists.some((s) => s.status === 'failed')) return 'failed';
  if (specialists.some((s) => s.status === 'pending' || s.status === 'running')) return 'running';
  if (specialists.some((s) => s.status === 'completed')) return 'completed';
  return 'skipped';
}

/**
 * Collapse the per-specialist runs into the single parent-visible review
 * result. Counts findings by severity, lists clean and failed roles, and
 * produces a one-line human summary.
 */
export function aggregateReviewerRuns(workflow: ReviewerFanoutWorkflow): ReviewerAggregateReview {
  const rolesRun: ReviewerSpecialistRole[] = [];
  const noFindingRoles: ReviewerSpecialistRole[] = [];
  const failedRoles: Array<{ role: ReviewerSpecialistRole; error: string }> = [];
  const findings: Array<ReviewerAggregateReview['findings'][number]> = [];
  let blockerCount = 0;
  let suggestionCount = 0;
  let infoCount = 0;

  for (const run of workflow.specialists) {
    if (run.status === 'pending' || run.status === 'running' || run.status === 'skipped') {
      continue;
    }
    rolesRun.push(run.role);

    if (run.status === 'failed') {
      failedRoles.push({ role: run.role, error: run.error ?? run.summary ?? 'unknown error' });
      continue;
    }

    if (run.findings.length === 0) {
      noFindingRoles.push(run.role);
      continue;
    }

    for (const finding of run.findings) {
      findings.push({ ...finding, role: run.role });
      if (finding.severity === 'blocking') blockerCount++;
      else if (finding.severity === 'suggestion') suggestionCount++;
      else infoCount++;
    }
  }

  const status = deriveWorkflowStatus(workflow.specialists);
  const summary =
    `${rolesRun.length} specialist(s): ${blockerCount} blocker(s), ` +
    `${suggestionCount} suggestion(s), ${infoCount} info, ` +
    `${noFindingRoles.length} clean, ${failedRoles.length} failed`;

  return {
    workflowId: workflow.id,
    status,
    rolesRun,
    blockerCount,
    suggestionCount,
    infoCount,
    noFindingRoles,
    failedRoles,
    findings,
    summary,
  };
}

/**
 * Parse the stable machine-readable block emitted by
 * `plugin/skills/pre-pr-review/select-specialists.sh` into the inputs needed to
 * create a workflow. Unknown role tokens are dropped. Returns the roles, force
 * flag, and docs-drift state; the caller supplies the diff scope.
 */
export function parseSpecialistSelection(text: string): {
  roles: ReviewerSpecialistRole[];
  force: boolean;
  docsDrift: 'active' | 'inactive';
} {
  const known = new Set<string>(REVIEWER_SPECIALIST_ROLES);
  const specialistsLine = /^SPECIALISTS=(.*)$/m.exec(text)?.[1] ?? '';
  const roles = specialistsLine
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is ReviewerSpecialistRole => known.has(s));
  const force = /^FORCE=yes$/m.test(text);
  const docsDrift = /^DOCS_DRIFT=active$/m.test(text) ? 'active' : 'inactive';
  return { roles, force, docsDrift };
}
