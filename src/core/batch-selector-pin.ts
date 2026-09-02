import type { Schedule } from './schedule.js';
import { isParallelIssueBatchPlaybookId } from './pipeline-starvation.js';

/**
 * Detects a **drained-pin risk** on a recurring Parallel Issue Batch schedule:
 * one whose `issueSelector` is pinned to an explicit, fixed list of issue
 * numbers rather than left blank to scan the live open backlog (issue #2982).
 *
 * ## Why this is a config error, not a preference
 *
 * The Parallel Issue Batch playbook reads `issueSelector` two ways (Phase 2):
 * blank → list every open issue and drain the backlog every fire; a fixed set
 * of issue numbers → work only those specific issues. A *recurring* schedule
 * pinned to specific numbers is self-limiting: once those issues are closed
 * (merged, or resolved elsewhere) every subsequent fire finds NO-ELIGIBLE-WORK
 * and dispatches nothing. The batch keeps firing on its cron but is a permanent
 * no-op — a dead delivery engine that looks alive.
 *
 * ## The 2026-09-02 incident this closes
 *
 * The "Kookr parallel issue batch" schedule (id `d46066da…`) was pinned to
 * `issueSelector: "2756 2757 2758"`. All three issues closed on 2026-08-23, so
 * from that day every fire correctly reported NO-ELIGIBLE-WORK and delivered
 * nothing — ~10 days of no-op fires while 48 open issues rotted. The failure
 * only became visible when two fires happened to be reclaimed by watchdog TTLs
 * (`provider-paused-ttl`, `hung-suspect-ttl`), recorded as `cancelled`, which
 * tripped the consecutive-failure auto-hold. The working Lucy batch never hit
 * this because it uses a blank selector and always finds fresh work.
 *
 * This is the exact silent-config-error class the {@link ScheduleResolutionAlerter}
 * (#1661) was built for: a schedule that is quietly broken and raises no hand.
 * The detector here is purely static — it reads only the schedule config, makes
 * no GitHub calls — so it runs on the runner's existing validation tick.
 *
 * A one-shot pinned batch (`maxTriggers: 1`) is a legitimate, deliberate run of
 * specific issues and is intentionally exempt: it fires once and stops, so it
 * cannot rot.
 */

/** One recurring batch schedule pinned to an explicit issue list. */
export interface PinnedBatchScheduleInfo {
  id: string;
  name: string;
  /** The pinned issue numbers, parsed from `issueSelector`, ascending & unique. */
  issues: number[];
  /** The raw `issueSelector` value, for the operator-facing alert. */
  selector: string;
}

/**
 * Parse an `issueSelector` value the way the playbook's Phase 2 does: a value
 * that is only issue numbers (comma- or whitespace-separated, an optional `#`
 * allowed) is an explicit pin. Anything else — blank, or containing any
 * non-numeric token (a GitHub search filter such as `label:bug`) — is NOT a
 * pin and returns `null`.
 *
 * Returns the parsed numbers ascending and de-duplicated, or `null` when the
 * selector is not a pure explicit pin.
 */
export function parseExplicitIssuePins(issueSelector: string | undefined): number[] | null {
  if (typeof issueSelector !== 'string') return null;
  const trimmed = issueSelector.trim();
  if (trimmed === '') return null;
  const tokens = trimmed.split(/[\s,]+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  const nums: number[] = [];
  for (const token of tokens) {
    const m = /^#?(\d+)$/.exec(token);
    if (!m) return null; // any non-numeric token ⇒ this is a search filter, not a pin
    const n = Number(m[1]);
    if (!Number.isInteger(n) || n <= 0) return null;
    nums.push(n);
  }
  return [...new Set(nums)].sort((a, b) => a - b);
}

/**
 * Classify one schedule. Returns {@link PinnedBatchScheduleInfo} when it is a
 * recurring Parallel Issue Batch pinned to an explicit issue list, else `null`.
 *
 * A `maxTriggers: 1` one-shot is exempt (it fires once and cannot rot); every
 * other trigger budget (unbounded, or a finite `maxTriggers > 1`) recurs and so
 * qualifies. `enabled` is intentionally ignored so a config error is visible
 * even while the schedule is paused/held — matching the resolution alerter.
 */
export function detectDrainedPinRisk(schedule: Schedule): PinnedBatchScheduleInfo | null {
  // Reuse the canonical playbook-id matcher (src/core/pipeline-starvation.ts) so
  // this detector stays in lockstep with the rest of the batch tooling — it also
  // matches the extension-less `parallel-issue-batch` id, not only the `.md` form.
  if (!isParallelIssueBatchPlaybookId(schedule.playbook.path)) return null;
  if (schedule.maxTriggers === 1) return null; // deliberate one-shot; cannot rot
  const issues = parseExplicitIssuePins(schedule.playbook.parameters?.issueSelector);
  if (!issues) return null;
  return {
    id: schedule.id,
    name: schedule.name,
    issues,
    selector: (schedule.playbook.parameters?.issueSelector ?? '').trim(),
  };
}
