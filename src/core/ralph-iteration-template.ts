import type {
  RalphIterationRecord,
  RalphIterationVerdict,
} from '../shared/contracts/ralph-iteration-log.js';
import type { BurnedOutTarget } from './tasks.js';

/**
 * Per-iteration prompt templating for Ralph loops. See
 * `docs/rfc/rfc-ralph-loop-stall-handling.md` §7.
 *
 * Substitution is opt-in via marker presence: a prompt without any
 * `{{ralph.<token>}}` reference is forwarded unchanged. This protects
 * in-flight loops whose existing prompts may contain literal `{{ralph.x}}`
 * text from accidental rewriting on the first post-deploy iteration.
 *
 * Substitution is unconditional with empty-string fallback when data is
 * unavailable. There is no `{{#if}}` syntax — the templater is intentionally
 * a single string-replace pipeline. Playbook authors who want conditional
 * prose should write the line so it reads acceptably when empty (e.g.
 * `Burned-out targets: {{ralph.burnedOutTargets}}` reads as
 * `Burned-out targets: (none)` when none are burned).
 */

const TOKEN_RE = /\{\{ralph\.[a-zA-Z_]+\}\}/;

export interface IterationTemplateContext {
  iteration: number;
  cumulativeIterations: number;
  burnedOutTargets: BurnedOutTarget[] | undefined;
  recentRecords: RalphIterationRecord[] | undefined;
}

/**
 * Render a prompt with per-iteration template tokens substituted. If no
 * `{{ralph.x}}` token is present in `prompt`, returns `prompt` unchanged
 * (no allocation, no rewrite).
 *
 * Pure function — no IO. The caller assembles `ctx` from the loop state and
 * the iteration-log read model.
 */
export function renderIterationPrompt(prompt: string, ctx: IterationTemplateContext): string {
  if (!TOKEN_RE.test(prompt)) return prompt;

  const burnedOutTargets = formatBurnedOutTargets(ctx.burnedOutTargets);
  const lastStallReason = formatLastStallReason(ctx.burnedOutTargets);
  const recentVerdicts = formatRecentVerdicts(ctx.recentRecords);

  return prompt
    .replaceAll('{{ralph.iteration}}', String(ctx.iteration))
    .replaceAll('{{ralph.cumulativeIterations}}', String(ctx.cumulativeIterations))
    .replaceAll('{{ralph.burnedOutTargets}}', burnedOutTargets)
    .replaceAll('{{ralph.lastStallReason}}', lastStallReason)
    .replaceAll('{{ralph.recentVerdicts}}', recentVerdicts);
}

function formatBurnedOutTargets(targets: BurnedOutTarget[] | undefined): string {
  if (!targets || targets.length === 0) return '(none)';
  // Only show targets that are actually burned (consecutiveStallCount has
  // crossed the threshold). Pre-burn rows are tracked but should not appear
  // in the agent's "do not pick" list.
  const burned = targets.filter((t) => t.burned).map((t) => t.target);
  if (burned.length === 0) return '(none)';
  return burned.join(', ');
}

function formatLastStallReason(targets: BurnedOutTarget[] | undefined): string {
  if (!targets || targets.length === 0) return '';
  // The most-recent stall reason across all burned targets is the one with
  // the largest `lastAttemptedIteration`. Stable tie-break on insertion order.
  let latest: BurnedOutTarget | undefined;
  for (const t of targets) {
    if (!latest || t.lastAttemptedIteration > latest.lastAttemptedIteration) {
      latest = t;
    }
  }
  return latest?.lastStallReason ?? '';
}

function formatRecentVerdicts(records: RalphIterationRecord[] | undefined): string {
  if (!records || records.length === 0) return '';
  // Last 5 records that carry a verdict. Iteration log is in arrival order,
  // so we take the tail. Records without a verdict are skipped — they don't
  // tell the agent anything useful.
  const withVerdict: RalphIterationRecord[] = [];
  for (let i = records.length - 1; i >= 0 && withVerdict.length < 5; i--) {
    if (records[i].verdict) withVerdict.unshift(records[i]);
  }
  if (withVerdict.length === 0) return '';
  return withVerdict.map(formatOneVerdict).join('; ');
}

function formatOneVerdict(record: RalphIterationRecord): string {
  const v = record.verdict as RalphIterationVerdict;
  const head = `iter ${record.iterationNumber}: ${v.verdict}`;
  if (v.verdict === 'stalled') return `${head} (target=${v.target})`;
  if (v.verdict === 'progress' && v.target) return `${head} (target=${v.target})`;
  return head;
}
