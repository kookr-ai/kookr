import { describe, it, expect, vi } from 'vitest';
import type { Schedule } from '../core/schedule.js';
import type { PlaybookScope } from '../core/playbook.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
import {
  ScheduleResolutionAlerter,
  crossTierResolutionHint,
  type ScheduleResolutionProbe,
  type UnresolvableScheduleInfo,
} from './schedule-resolution-alert.js';

function unresolvable(overrides: Partial<UnresolvableScheduleInfo> = {}): UnresolvableScheduleInfo {
  return {
    id: 'sched-1',
    name: 'Lucy parallel issue batch',
    playbookPath: 'parallel-issue-batch.md',
    scope: 'project',
    legacy: true,
    ...overrides,
  };
}

function scheduleLike(overrides: Partial<Schedule['playbook']> = {}, cwd = '/repos/lucy'): Pick<Schedule, 'playbook' | 'cwd'> {
  return {
    cwd,
    playbook: { path: 'parallel-issue-batch.md', parameters: {}, ...overrides },
  };
}

/** Mirrors schedule-dead-man.test.ts's `makeSwitch` helper. */
function makeAlerter() {
  const broadcast = vi.fn();
  const alerter = new ScheduleResolutionAlerter({ broadcast });
  return { broadcast, alerter };
}

function alerts(broadcast: ReturnType<typeof vi.fn>): Extract<ServerMessage, { type: 'alert' }>[] {
  return broadcast.mock.calls.map((c) => c[0] as Extract<ServerMessage, { type: 'alert' }>);
}

describe('crossTierResolutionHint (issue #1661)', () => {
  it('reproduces 68e9cb52: legacy project-scoped schedule whose playbook lives only in the plugin tier', () => {
    // Playbook resolves ONLY in plugin — exactly the 2026-07-28 incident.
    const probe: ScheduleResolutionProbe = (_path, scope) => scope === 'plugin';
    expect(crossTierResolutionHint(scheduleLike(), probe)).toBe('plugin');
  });

  it('returns undefined when the playbook resolves in no tier (genuinely missing)', () => {
    const probe: ScheduleResolutionProbe = () => false;
    expect(crossTierResolutionHint(scheduleLike(), probe)).toBeUndefined();
  });

  it('never suggests the schedule\'s own (failed) scope', () => {
    // Only the current scope "resolves" — the hint must skip it, returning undefined.
    const explicit = scheduleLike({ scope: 'user' });
    const probe: ScheduleResolutionProbe = (_path, scope) => scope === 'user';
    expect(crossTierResolutionHint(explicit, probe)).toBeUndefined();
  });

  it('returns the FIRST resolving tier in project→user→plugin precedence when several resolve', () => {
    // Both user and plugin resolve; precedence must return user (current scope
    // project is skipped). A defect that returned the last match would fail here.
    const probe: ScheduleResolutionProbe = (_path, scope) => scope === 'user' || scope === 'plugin';
    expect(crossTierResolutionHint(scheduleLike(), probe)).toBe('user');
  });

  it('probes in project→user→plugin precedence order', () => {
    const seen: PlaybookScope[] = [];
    const probe: ScheduleResolutionProbe = (_path, scope) => {
      seen.push(scope);
      return scope === 'plugin';
    };
    // current scope is project, so project is skipped; user then plugin probed.
    crossTierResolutionHint(scheduleLike(), probe);
    expect(seen).toEqual(['user', 'plugin']);
  });

  it('probes a project fallback from the task cwd for a global-tier schedule', () => {
    const seen: Array<{ scope: PlaybookScope; cwd: string }> = [];
    const schedule = scheduleLike(
      { scope: 'user', sourceCwd: '/home/example/.kookr/playbooks' },
      '/repos/task-target',
    );
    const probe: ScheduleResolutionProbe = (_path, scope, cwd) => {
      seen.push({ scope, cwd });
      return scope === 'project';
    };

    expect(crossTierResolutionHint(schedule, probe)).toBe('project');
    expect(seen).toEqual([{ scope: 'project', cwd: '/repos/task-target' }]);
  });

  it('retains the source cwd when a project-scoped schedule probes global tiers', () => {
    const seen: Array<{ scope: PlaybookScope; cwd: string }> = [];
    const schedule = scheduleLike(
      { scope: 'project', sourceCwd: '/repos/catalog-source' },
      '/repos/task-target',
    );
    const probe: ScheduleResolutionProbe = (_path, scope, cwd) => {
      seen.push({ scope, cwd });
      return scope === 'plugin';
    };

    expect(crossTierResolutionHint(schedule, probe)).toBe('plugin');
    expect(seen).toEqual([
      { scope: 'user', cwd: '/repos/catalog-source' },
      { scope: 'plugin', cwd: '/repos/catalog-source' },
    ]);
  });

  it('treats a throwing probe as non-resolving instead of propagating', () => {
    const probe: ScheduleResolutionProbe = (_path, scope) => {
      if (scope === 'user') throw new Error('bad path');
      return scope === 'plugin';
    };
    expect(crossTierResolutionHint(scheduleLike(), probe)).toBe('plugin');
  });
});

describe('ScheduleResolutionAlerter (issue #1661)', () => {
  it('fires ONE warning alert for an already-broken schedule on the first cycle', () => {
    const { broadcast, alerter } = makeAlerter();

    // Already broken at first observation — the seed-silent transition warn
    // would miss this; the alerter must not.
    alerter.check([unresolvable({ resolvableInTier: 'plugin' })]);
    alerter.check([unresolvable({ resolvableInTier: 'plugin' })]);
    alerter.check([unresolvable({ resolvableInTier: 'plugin' })]);

    const fired = alerts(broadcast);
    expect(fired).toHaveLength(1);
    expect(fired[0].severity).toBe('warning');
    expect(fired[0].operationalAlert).toMatchObject({
      key: 'schedule:unresolvable_playbook:sched-1',
      metric: 'schedule_unresolvable_playbook',
      state: 'fired',
    });
    // The actionable (manual) pin hint is present — the feature is alert-only,
    // no auto-pin, so the hint suggests the operator pin the tier themselves.
    expect(fired[0].details).toContain('scope: "plugin"');
    expect(fired[0].details).toContain('legacy schedule');
  });

  it('omits the "legacy schedule" note for an explicitly-scoped schedule', () => {
    const { broadcast, alerter } = makeAlerter();
    alerter.check([unresolvable({ legacy: false, scope: 'plugin', resolvableInTier: 'user' })]);
    const fired = alerts(broadcast);
    expect(fired[0].details).not.toContain('legacy schedule');
  });

  it('emits an info recovery alert (with resolving copy) when the schedule genuinely resolves again', () => {
    const { broadcast, alerter } = makeAlerter();

    alerter.check([unresolvable()]);
    alerter.check([], ['sched-1']); // playbook restored / scope pinned → genuinely resolves

    const fired = alerts(broadcast);
    expect(fired).toHaveLength(2);
    expect(fired[1].severity).toBe('info');
    expect(fired[1].summary).toContain('resolves again');
    expect(fired[1].details).toContain('now resolves');
    expect(fired[1].operationalAlert).toMatchObject({
      key: 'schedule:unresolvable_playbook:sched-1',
      metric: 'schedule_unresolvable_playbook',
      state: 'recovered',
    });
  });

  it('does NOT emit a false recovery when a firing schedule drops out without resolving (deleted / cwd removed)', () => {
    const { broadcast, alerter } = makeAlerter();

    alerter.check([unresolvable()]); // fire
    // Schedule is gone from BOTH lists — deleted, or its cwd was removed (a
    // different, worse config error). It did not resolve, so no recovery alert.
    alerter.check([], []);

    const fired = alerts(broadcast);
    expect(fired).toHaveLength(1);
    expect(fired[0].operationalAlert?.state).toBe('fired');

    // And the firing state is cleared: if it becomes unresolvable again later it
    // fires afresh rather than being suppressed as still-firing.
    alerter.check([unresolvable()]);
    expect(alerts(broadcast).map((a) => a.operationalAlert?.state)).toEqual(['fired', 'fired']);
  });

  it('re-fires after a recovery when the schedule breaks again (edge-triggered)', () => {
    const { broadcast, alerter } = makeAlerter();

    alerter.check([unresolvable()]); // fire
    alerter.check([], ['sched-1']); // recover
    alerter.check([unresolvable()]); // fire again

    const states = alerts(broadcast).map((a) => a.operationalAlert?.state);
    expect(states).toEqual(['fired', 'recovered', 'fired']);
  });

  it('tracks each schedule independently by id', () => {
    const { broadcast, alerter } = makeAlerter();

    const a = unresolvable({ id: 'a', name: 'A' });
    const b = unresolvable({ id: 'b', name: 'B' });

    alerter.check([a, b]); // both fire
    alerter.check([b], ['a']); // a genuinely resolves, b stays firing (no duplicate)

    const fired = alerts(broadcast);
    expect(fired).toHaveLength(3);
    expect(fired[0].operationalAlert?.key).toBe('schedule:unresolvable_playbook:a');
    expect(fired[1].operationalAlert?.key).toBe('schedule:unresolvable_playbook:b');
    expect(fired[2].operationalAlert).toMatchObject({
      key: 'schedule:unresolvable_playbook:a',
      state: 'recovered',
    });
  });

  it('never emits a spurious alert when nothing is unresolvable', () => {
    const { broadcast, alerter } = makeAlerter();
    alerter.check([]);
    alerter.check([], ['other']);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('surfaces the "resolves in no tier" wording when there is no pin hint', () => {
    const { broadcast, alerter } = makeAlerter();
    alerter.check([unresolvable({ resolvableInTier: undefined })]);
    expect(alerts(broadcast)[0].details).toContain('resolves in no tier');
  });
});
