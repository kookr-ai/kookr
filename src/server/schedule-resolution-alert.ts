import type { PlaybookScope } from '../core/playbook.js';
import type { Schedule } from '../core/schedule.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
import { OPERATIONAL_ALERT_AGENT_ID } from './operational-alert-rules.js';

/**
 * Edge-triggered operational alerter for schedules whose playbook cannot be
 * resolved in their (defaulted) tier (issue #1661).
 *
 * Motivated by the 2026-07-28 incident: the schedule playbook-scope migration
 * defaulted every legacy (no-`scope`) schedule to `scope: project` with no
 * cross-tier fallback. A single legacy schedule ('Lucy parallel issue batch',
 * id 68e9cb52) pointed at a playbook that lives ONLY in the kookr-toolkit
 * plugin tier, so it became permanently unresolvable — but nothing raised its
 * hand. The `dispatch_failed / missing_playbook` failure surfaced only when an
 * operator re-enabled the schedule ~10 days later and read the execution
 * ledger.
 *
 * The runner already caches tri-state resolution health (R9) and renders an
 * `unresolvable` badge, and it logs a `console.warn` on a resolvable→broken
 * *transition*. But an already-broken schedule (broken at process start, or
 * broken silently by a migration) seeds its baseline silently and never emits
 * a transition warn — exactly the 68e9cb52 gap. This alerter closes it: it
 * fires an operational `alert` for ANY unresolvable schedule, including one
 * that is already broken at the first observation, so the config error is
 * visible within one validation cycle regardless of whether an operator ever
 * re-enables it.
 *
 * Alert semantics mirror {@link ScheduleDeadManSwitch}: edge-triggered, one
 * `alert` ServerMessage (severity `warning`, agentId `system`) per continuous
 * unresolvable episode PER SCHEDULE, and a matching severity-`info` recovery
 * alert when that schedule resolves again (playbook restored, scope pinned,
 * cwd fixed). Keying per schedule id lets each config error fire and clear
 * independently. Alert-only — no auto-pin is attempted, matching the deliberate
 * "no cross-tier shadowing" invariant in `playbook-paths.ts`; the alert instead
 * carries the actionable tier hint (see {@link crossTierResolutionHint}).
 */

/** Tiers probed, in precedence order, for the cross-tier resolution hint. */
const PROBE_SCOPES: readonly PlaybookScope[] = ['project', 'user', 'plugin'];

/** One schedule whose playbook does not resolve in its (defaulted) tier. */
export interface UnresolvableScheduleInfo {
  id: string;
  name: string;
  playbookPath: string;
  /** The (defaulted) scope in which resolution failed. */
  scope: PlaybookScope;
  /** True when the schedule has no explicit `scope` (legacy, pre-migration). */
  legacy: boolean;
  /**
   * A tier where the playbook WOULD resolve, if any — the actionable
   * "pin `scope: <tier>`" hint. `undefined` when the playbook resolves in no
   * tier (a genuinely missing/renamed playbook, not a mis-scoped one).
   */
  resolvableInTier?: PlaybookScope;
}

/** Probe whether `playbookPath` resolves in one concrete tier. Never throws. */
export type ScheduleResolutionProbe = (
  playbookPath: string,
  scope: PlaybookScope,
  cwd: string,
) => boolean;

/**
 * Given a schedule that failed to resolve in its (defaulted) scope, probe the
 * OTHER tiers to find one where the playbook would resolve. This is the hint
 * that would have made the 68e9cb52 incident self-explanatory: "unresolvable
 * in `project`, but resolves in `plugin` — pin `scope: plugin`."
 *
 * Returns the first resolving tier in precedence order, or `undefined` when
 * the playbook resolves in no tier at all.
 */
export function crossTierResolutionHint(
  schedule: Pick<Schedule, 'playbook' | 'cwd'>,
  probe: ScheduleResolutionProbe,
): PlaybookScope | undefined {
  const current = schedule.playbook.scope ?? 'project';
  for (const scope of PROBE_SCOPES) {
    if (scope === current) continue;
    let ok = false;
    try {
      ok = probe(schedule.playbook.path, scope, schedule.cwd);
    } catch {
      ok = false;
    }
    if (ok) return scope;
  }
  return undefined;
}

export interface ScheduleResolutionAlerterDeps {
  broadcast: (msg: ServerMessage) => void;
}

export class ScheduleResolutionAlerter {
  /** Schedule ids currently in an unresolvable episode, with their last info. */
  private readonly firing = new Map<string, UnresolvableScheduleInfo>();
  private readonly deps: ScheduleResolutionAlerterDeps;

  constructor(deps: ScheduleResolutionAlerterDeps) {
    this.deps = deps;
  }

  /**
   * Evaluate one validation cycle. `unresolvable` is the full set of currently
   * unresolvable schedules; `resolvedIds` is the set of schedule ids that were
   * evaluated this cycle and found to GENUINELY resolve (cwd exists and the
   * playbook resolves in its tier). The runner computes both on its existing
   * tick, so this adds no timer and no extra filesystem work on the broadcast
   * hot path.
   *
   * Fires once per schedule on the healthy→unresolvable edge. A recovery alert
   * is emitted ONLY when a firing schedule genuinely resolves again (its id is
   * in `resolvedIds`). A firing schedule that merely drops out of the
   * unresolvable set for another reason — deleted, or its cwd removed (a
   * *different*, worse config error) — is cleared silently: announcing
   * "playbook resolves again" there would be a false positive, the exact class
   * of misleading operator signal this alerter exists to avoid. Must never
   * throw — it only reads the passed inputs and broadcasts.
   */
  check(unresolvable: UnresolvableScheduleInfo[], resolvedIds: Iterable<string> = []): void {
    const current = new Map(unresolvable.map((info) => [info.id, info]));
    const resolved = new Set(resolvedIds);

    // Fire for newly-unresolvable schedules; refresh stored info for all.
    for (const info of unresolvable) {
      if (!this.firing.has(info.id)) {
        this.deps.broadcast(buildUnresolvableAlert(info));
      }
      this.firing.set(info.id, info);
    }

    // Clear firing schedules that are no longer unresolvable. Only the ones
    // that genuinely resolve get a recovery alert; the rest clear silently.
    for (const [id, info] of [...this.firing]) {
      if (current.has(id)) continue;
      this.firing.delete(id);
      if (resolved.has(id)) {
        this.deps.broadcast(buildResolvedRecoveryAlert(info));
      }
    }
  }
}

function alertKey(id: string): string {
  return `schedule:unresolvable_playbook:${id}`;
}

function buildUnresolvableAlert(info: UnresolvableScheduleInfo): Extract<ServerMessage, { type: 'alert' }> {
  const legacyNote = info.legacy ? ' (legacy schedule with no pinned scope)' : '';
  const hint = info.resolvableInTier
    ? `The playbook resolves in the ${info.resolvableInTier} tier — pin \`playbook.scope: "${info.resolvableInTier}"\` to fix it.`
    : 'The playbook resolves in no tier (project/user/plugin) — it was likely renamed, moved, or deleted.';
  return {
    type: 'alert',
    agentId: OPERATIONAL_ALERT_AGENT_ID,
    summary: `Schedule "${info.name}" has an unresolvable playbook`,
    details:
      `Schedule "${info.name}"${legacyNote} references playbook "${info.playbookPath}", ` +
      `which does not resolve in the ${info.scope} tier. This is a permanent config error ` +
      '(it will fail every fire with `dispatch_failed / missing_playbook`), not a transient. ' +
      `${hint} ` +
      'This alert is raised once while the schedule stays unresolvable and clears when it resolves again (issue #1661).',
    severity: 'warning',
    operationalAlert: {
      key: alertKey(info.id),
      metric: 'schedule_unresolvable_playbook',
      state: 'fired',
    },
  };
}

function buildResolvedRecoveryAlert(info: UnresolvableScheduleInfo): Extract<ServerMessage, { type: 'alert' }> {
  return {
    type: 'alert',
    agentId: OPERATIONAL_ALERT_AGENT_ID,
    summary: `Recovered: schedule "${info.name}" playbook resolves again`,
    details:
      `Schedule "${info.name}" playbook "${info.playbookPath}" now resolves ` +
      '(playbook restored, scope pinned, or cwd fixed).',
    severity: 'info',
    operationalAlert: {
      key: alertKey(info.id),
      metric: 'schedule_unresolvable_playbook',
      state: 'recovered',
    },
  };
}
