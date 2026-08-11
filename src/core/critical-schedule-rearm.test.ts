import { describe, expect, it } from 'vitest';
import {
  CRITICAL_SCHEDULE_PLAYBOOK_BASENAMES,
  decideCriticalScheduleRearm,
  isCriticalAllowlistedSchedule,
  listCriticalSchedulesToRearm,
  playbookBasename,
  type CriticalRearmScheduleView,
} from './critical-schedule-rearm.js';

function sched(
  overrides: Partial<CriticalRearmScheduleView> & Pick<CriticalRearmScheduleView, 'id' | 'name' | 'playbook'>,
): CriticalRearmScheduleView {
  return {
    enabled: false,
    ...overrides,
  };
}

describe('playbookBasename', () => {
  it('strips directories and normalizes separators', () => {
    expect(playbookBasename('plugin/playbooks/lucy-orchestration-effectiveness.md')).toBe(
      'lucy-orchestration-effectiveness.md',
    );
    expect(playbookBasename('a\\b\\foo.md')).toBe('foo.md');
  });
});

describe('isCriticalAllowlistedSchedule', () => {
  it('matches orchestration-effectiveness and product-surface by playbook basename', () => {
    expect(
      isCriticalAllowlistedSchedule({
        name: 'anything',
        playbook: { path: 'lucy-orchestration-effectiveness.md' },
      }),
    ).toBe(true);
    expect(
      isCriticalAllowlistedSchedule({
        name: 'x',
        playbook: { path: 'plugin/lucy-product-surface-journey.md' },
      }),
    ).toBe(true);
  });

  it('matches by well-known name when playbook path is renamed', () => {
    expect(
      isCriticalAllowlistedSchedule({
        name: 'Lucy Orchestration Effectiveness',
        playbook: { path: 'renamed-residual.md' },
      }),
    ).toBe(true);
  });

  it('does not match experimental or parked product scouts', () => {
    expect(
      isCriticalAllowlistedSchedule({
        name: 'Lucy parallel issue batch (Grok Build)',
        playbook: { path: 'parallel-issue-batch.md' },
      }),
    ).toBe(false);
    expect(
      isCriticalAllowlistedSchedule({
        name: 'Nightly idea scout',
        playbook: { path: 'repository-idea-scout.md' },
      }),
    ).toBe(false);
  });

  it('allowlist stays small (no accidental expansion)', () => {
    // Three critical roles × (with/without .md) = 6 basenames.
    expect(CRITICAL_SCHEDULE_PLAYBOOK_BASENAMES.length).toBe(6);
  });

  it('allowlists kookr deploy-convergence by playbook and name (issue #2226)', () => {
    expect(
      isCriticalAllowlistedSchedule({
        name: 'other',
        playbook: { path: 'kookr-deploy-convergence.md' },
      }),
    ).toBe(true);
    expect(
      isCriticalAllowlistedSchedule({
        name: 'Kookr Deploy Convergence',
        playbook: { path: 'renamed.md' },
      }),
    ).toBe(true);
  });
});

describe('decideCriticalScheduleRearm', () => {
  const effectiveness = sched({
    id: 'a',
    name: 'Lucy Orchestration Effectiveness',
    playbook: { path: 'lucy-orchestration-effectiveness.md' },
  });

  it('rearms allowlisted schedule that is disabled without hold', () => {
    expect(decideCriticalScheduleRearm(effectiveness)).toEqual({ rearm: true });
  });

  it('skips when already enabled', () => {
    expect(decideCriticalScheduleRearm({ ...effectiveness, enabled: true })).toEqual({
      rearm: false,
      reason: 'already_enabled',
    });
  });

  it('skips when operatorHold is set (explicit park)', () => {
    expect(
      decideCriticalScheduleRearm({ ...effectiveness, operatorHold: true }),
    ).toEqual({ rearm: false, reason: 'operator_hold' });
  });

  it('skips trigger-limit auto-exhaustion (not ops drift)', () => {
    expect(
      decideCriticalScheduleRearm({
        ...effectiveness,
        stopReason: 'trigger_limit_reached',
      }),
    ).toEqual({ rearm: false, reason: 'trigger_limit_exhausted' });
  });

  it('skips non-allowlisted schedules', () => {
    expect(
      decideCriticalScheduleRearm(
        sched({
          id: 'b',
          name: 'Grok Build Daily Upstream Sync',
          playbook: { path: 'grok-build-rebase.md' },
        }),
      ),
    ).toEqual({ rearm: false, reason: 'not_allowlisted' });
  });
});

describe('listCriticalSchedulesToRearm', () => {
  it('returns only rearmable critical schedules, sorted by id', () => {
    const fleet: CriticalRearmScheduleView[] = [
      sched({
        id: 'z-product',
        name: 'Lucy Product Surface Journey',
        playbook: { path: 'lucy-product-surface-journey.md' },
      }),
      sched({
        id: 'a-held',
        name: 'Lucy Orchestration Effectiveness',
        playbook: { path: 'lucy-orchestration-effectiveness.md' },
        operatorHold: true,
      }),
      sched({
        id: 'm-ok',
        name: 'Lucy Orchestration Effectiveness',
        playbook: { path: 'lucy-orchestration-effectiveness.md' },
      }),
      sched({
        id: 'parked-batch',
        name: 'Lucy parallel issue batch (Grok Build)',
        playbook: { path: 'parallel-issue-batch.md' },
      }),
    ];
    const toRearm = listCriticalSchedulesToRearm(fleet);
    expect(toRearm.map((s) => s.id)).toEqual(['m-ok', 'z-product']);
  });
});
