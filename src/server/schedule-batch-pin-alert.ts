import type { PinnedBatchScheduleInfo } from '../core/batch-selector-pin.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
import { OPERATIONAL_ALERT_AGENT_ID } from './operational-alert-rules.js';

/**
 * Edge-triggered operational alerter for a recurring Parallel Issue Batch
 * schedule pinned to an explicit `issueSelector` (issue #2982).
 *
 * A recurring batch pinned to specific issue numbers becomes a permanent no-op
 * the moment those issues close: every fire finds NO-ELIGIBLE-WORK and delivers
 * nothing, yet the schedule keeps firing and looks alive. The 2026-09-02 "Kookr
 * parallel issue batch" incident (pinned to `#2756 #2757 #2758`, all closed
 * 2026-08-23) rotted ~10 days before two watchdog-reclaimed fires tripped the
 * consecutive-failure auto-hold and made it visible. See
 * {@link ../core/batch-selector-pin.ts} for the full rationale.
 *
 * This mirrors {@link ScheduleResolutionAlerter} (#1661): purely static config
 * inspection on the runner's existing validation tick, one `warning` alert per
 * continuous pinned episode per schedule, and a matching `info` recovery alert
 * when the pin is cleared (selector blanked or switched to a search filter).
 * A schedule that leaves the pinned set because it was deleted clears silently —
 * announcing "recovered" for a schedule that no longer exists would be a false
 * positive, the class of misleading operator signal this alerter avoids.
 */

export interface ScheduleBatchPinAlerterDeps {
  broadcast: (msg: ServerMessage) => void;
}

export class ScheduleBatchPinAlerter {
  /** Schedule ids currently in a pinned episode, with their last info. */
  private readonly firing = new Map<string, PinnedBatchScheduleInfo>();
  private readonly deps: ScheduleBatchPinAlerterDeps;

  constructor(deps: ScheduleBatchPinAlerterDeps) {
    this.deps = deps;
  }

  /**
   * Evaluate one validation cycle. `pinned` is the full set of schedules that
   * currently carry a drained-pin risk; `evaluatedIds` is every schedule id seen
   * this cycle (used to tell "pin cleared" apart from "schedule deleted").
   *
   * Fires once on the healthy→pinned edge. A recovery alert is emitted only when
   * a firing schedule is still present but no longer pinned; a firing schedule
   * that simply vanished (deleted) clears silently. Must never throw — it only
   * reads its inputs and broadcasts.
   */
  check(pinned: PinnedBatchScheduleInfo[], evaluatedIds: Iterable<string> = []): void {
    const current = new Map(pinned.map((info) => [info.id, info]));
    const present = new Set(evaluatedIds);

    // Fire for newly-pinned schedules; refresh stored info for all.
    for (const info of pinned) {
      if (!this.firing.has(info.id)) {
        this.deps.broadcast(buildPinnedAlert(info));
      }
      this.firing.set(info.id, info);
    }

    // Clear firing schedules no longer pinned. Only those still present (pin
    // removed, schedule kept) get a recovery alert; a deleted schedule clears
    // silently.
    for (const [id, info] of [...this.firing]) {
      if (current.has(id)) continue;
      this.firing.delete(id);
      if (present.has(id)) {
        this.deps.broadcast(buildClearedRecoveryAlert(info));
      }
    }
  }
}

function alertKey(id: string): string {
  return `schedule:batch_drained_pin:${id}`;
}

function formatIssues(issues: number[]): string {
  return issues.map((n) => `#${n}`).join(' ');
}

function buildPinnedAlert(info: PinnedBatchScheduleInfo): Extract<ServerMessage, { type: 'alert' }> {
  const issueList = formatIssues(info.issues);
  return {
    type: 'alert',
    agentId: OPERATIONAL_ALERT_AGENT_ID,
    summary: `Schedule "${info.name}" is a recurring batch pinned to explicit issues`,
    details:
      `Schedule "${info.name}" runs the Parallel Issue Batch playbook on a recurring cron, but its ` +
      `\`issueSelector\` is pinned to a fixed list (${issueList}). Once those issues close, every fire ` +
      'reports NO-ELIGIBLE-WORK and delivers nothing — the batch keeps firing but is a permanent no-op ' +
      '(the 2026-09-02 incident: this schedule pinned to #2756 #2757 #2758, all closed 2026-08-23, ran ' +
      '~10 days of no-op fires before auto-holding). Blank the `issueSelector` so the batch scans the ' +
      'open backlog every fire, like the working Lucy batch; or set `maxTriggers: 1` if a one-shot run ' +
      'of exactly these issues was intended. This alert is raised once while the pin persists and clears ' +
      'when the selector is blanked or changed to a search filter (issue #2982).',
    severity: 'warning',
    operationalAlert: {
      key: alertKey(info.id),
      metric: 'schedule_batch_drained_pin',
      state: 'fired',
    },
  };
}

function buildClearedRecoveryAlert(info: PinnedBatchScheduleInfo): Extract<ServerMessage, { type: 'alert' }> {
  return {
    type: 'alert',
    agentId: OPERATIONAL_ALERT_AGENT_ID,
    summary: `Recovered: schedule "${info.name}" batch selector is no longer pinned`,
    details:
      `Schedule "${info.name}" no longer pins its \`issueSelector\` to an explicit issue list — it now ` +
      'scans the open backlog (or filters it), so recurring fires can find fresh work again (issue #2982).',
    severity: 'info',
    operationalAlert: {
      key: alertKey(info.id),
      metric: 'schedule_batch_drained_pin',
      state: 'recovered',
    },
  };
}
