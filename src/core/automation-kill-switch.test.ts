import { describe, expect, it } from 'vitest';
import {
  applyKillSwitchTransition,
  applyProjectAutomationTransition,
  formatProjectAutomationDigestLine,
  formatSafeModeDigestLine,
  isAutonomousLaunchSource,
  isSafeModeExemptSchedule,
  mayAutonomousActuate,
  resolveSafeModeStatus,
  resolveScheduleAutomationProjectId,
} from './automation-kill-switch.js';

describe('isSafeModeExemptSchedule (issue #2672)', () => {
  it('exempts the cross-repo orchestrator by its playbook path', () => {
    expect(
      isSafeModeExemptSchedule({ playbookPath: 'cross-repo-orchestrator.md' }),
    ).toBe(true);
    expect(
      isSafeModeExemptSchedule({ playbookPath: '/srv/kookr-data/playbooks/cross-repo-orchestrator.md' }),
    ).toBe(true);
  });

  it('does NOT exempt look-alike playbook basenames (exact match only)', () => {
    expect(isSafeModeExemptSchedule({ playbookPath: 'cross-repo-orchestrator-backup.md' })).toBe(false);
    expect(isSafeModeExemptSchedule({ playbookPath: 'my-cross-repo-orchestrator-fork.md' })).toBe(false);
    expect(isSafeModeExemptSchedule({ playbookPath: 'cross-repo-orchestrator.md.bak' })).toBe(false);
  });

  it('does NOT exempt the orchestration-supervisor schedules', () => {
    expect(isSafeModeExemptSchedule({ playbookPath: 'lucy-orchestration-supervisor.md' })).toBe(false);
    expect(isSafeModeExemptSchedule({ playbookPath: 'kb-scout-orchestration-supervisor.md' })).toBe(false);
  });

  it('does NOT exempt the other autonomous schedules', () => {
    expect(isSafeModeExemptSchedule({ playbookPath: 'kookr-queue-feeder.md' })).toBe(false);
    expect(isSafeModeExemptSchedule({ playbookPath: 'parallel-issue-batch.md' })).toBe(false);
    expect(isSafeModeExemptSchedule({ playbookPath: 'repository-idea-scout.md' })).toBe(false);
    expect(isSafeModeExemptSchedule({ playbookPath: 'pr-merge-rebase-watchdog.md' })).toBe(false);
  });

  it('is false with no playbook path', () => {
    expect(isSafeModeExemptSchedule({ playbookPath: null })).toBe(false);
    expect(isSafeModeExemptSchedule({ playbookPath: undefined })).toBe(false);
    expect(isSafeModeExemptSchedule({})).toBe(false);
  });
});

describe('isAutonomousLaunchSource', () => {
  it('treats schedule as autonomous', () => {
    expect(isAutonomousLaunchSource('schedule')).toBe(true);
  });

  it('treats idle-refinery as autonomous (issue #2144)', () => {
    expect(isAutonomousLaunchSource('idle-refinery')).toBe(true);
  });

  it('TS-LAUNCH-POST-RECOVERY-001: treats post-recovery as autonomous (issue #2899)', () => {
    expect(isAutonomousLaunchSource('post-recovery')).toBe(true);
  });

  it('treats operator-driven sources as non-autonomous', () => {
    for (const source of ['api', 'ui', 'cli', 'websocket', 'remote-chat-telegram', 'remote-relay'] as const) {
      expect(isAutonomousLaunchSource(source)).toBe(false);
    }
  });

  it('treats missing source as non-autonomous (defaults to manual)', () => {
    expect(isAutonomousLaunchSource(undefined)).toBe(false);
  });
});

describe('resolveSafeModeStatus / formatSafeModeDigestLine', () => {
  it('reports disengaged when the kill-switch is off', () => {
    expect(resolveSafeModeStatus({ automationKillSwitch: false, safeModeSince: null })).toEqual({
      engaged: false,
    });
    expect(formatSafeModeDigestLine({ engaged: false })).toBeNull();
  });

  it('reports engaged with since when set', () => {
    const status = resolveSafeModeStatus({
      automationKillSwitch: true,
      safeModeSince: '2026-08-01T12:00:00.000Z',
    });
    expect(status).toEqual({ engaged: true, since: '2026-08-01T12:00:00.000Z' });
    expect(formatSafeModeDigestLine(status)).toBe('SAFE MODE since 2026-08-01T12:00:00.000Z');
  });

  it('reports engaged without since when the timestamp is missing', () => {
    const status = resolveSafeModeStatus({ automationKillSwitch: true, safeModeSince: null });
    expect(status).toEqual({ engaged: true });
    expect(formatSafeModeDigestLine(status)).toBe('SAFE MODE');
  });

  it('fails closed and surfaces loadError when settings are untrusted (issue #2085)', () => {
    const status = resolveSafeModeStatus({
      automationKillSwitch: false,
      safeModeSince: null,
      loadError: 'Settings file is not valid JSON',
    });
    expect(status).toEqual({
      engaged: true,
      loadError: 'Settings file is not valid JSON',
    });
    expect(formatSafeModeDigestLine(status)).toBe(
      'SAFE MODE (settings load error: Settings file is not valid JSON)',
    );
  });

  it('includes since + loadError together when both are set', () => {
    const status = resolveSafeModeStatus({
      automationKillSwitch: true,
      safeModeSince: '2026-08-01T12:00:00.000Z',
      loadError: 'Corrupt automationKillSwitch field',
    });
    expect(status).toEqual({
      engaged: true,
      since: '2026-08-01T12:00:00.000Z',
      loadError: 'Corrupt automationKillSwitch field',
    });
    expect(formatSafeModeDigestLine(status)).toBe(
      'SAFE MODE since 2026-08-01T12:00:00.000Z (settings load error: Corrupt automationKillSwitch field)',
    );
  });
});

describe('resolveScheduleAutomationProjectId', () => {
  it('maps kb-scout-reflection.md to kb-scout-evol regardless of cwd id', () => {
    expect(resolveScheduleAutomationProjectId({
      playbookPath: 'kb-scout-reflection.md',
      cwdProjectId: 'github.com/jeanibarz/dotclaude',
    })).toBe('github.com/jeanibarz/kb-scout-evol');
    expect(resolveScheduleAutomationProjectId({
      playbookPath: '/tmp/playbooks/kb-scout-reflection.md',
      cwdProjectId: 'local/dotclaude',
    })).toBe('github.com/jeanibarz/kb-scout-evol');
  });

  it('does not remap the queue-feeder off Lucy', () => {
    expect(resolveScheduleAutomationProjectId({
      playbookPath: 'kookr-queue-feeder.md',
      cwdProjectId: 'github.com/jeanibarz/lucy',
    })).toBe('github.com/jeanibarz/lucy');
  });

  it('uses cwd id for every other playbook', () => {
    expect(resolveScheduleAutomationProjectId({
      playbookPath: 'parallel-issue-batch.md',
      cwdProjectId: 'github.com/kookr-ai/kookr',
    })).toBe('github.com/kookr-ai/kookr');
  });
});

describe('mayAutonomousActuate', () => {
  const lucy = 'github.com/jeanibarz/lucy';
  const paused = new Set([lucy]);

  it('returns not_autonomous for operator sources', () => {
    expect(mayAutonomousActuate({
      source: 'api',
      projectId: lucy,
      globalEnabled: true,
      pausedProjectIds: paused,
    })).toBe('not_autonomous');
  });

  it('returns safe_mode when global automation is off, even if the project is also paused', () => {
    expect(mayAutonomousActuate({
      source: 'schedule',
      projectId: lucy,
      globalEnabled: false,
      pausedProjectIds: paused,
    })).toBe('safe_mode');
  });

  it('lets the cross-repo orchestrator through SAFE MODE but not a Kookr-project pause', () => {
    expect(mayAutonomousActuate({
      source: 'schedule',
      projectId: 'github.com/kookr-ai/kookr',
      globalEnabled: false,
      pausedProjectIds: new Set(),
      safeModeExempt: true,
    })).toBe('allow');
    expect(mayAutonomousActuate({
      source: 'schedule',
      projectId: 'github.com/kookr-ai/kookr',
      globalEnabled: true,
      pausedProjectIds: new Set(['github.com/kookr-ai/kookr']),
      safeModeExempt: true,
    })).toBe('project_paused');
  });

  it('returns project_paused when the stamp is in the live set', () => {
    expect(mayAutonomousActuate({
      source: 'schedule',
      projectId: lucy,
      globalEnabled: true,
      pausedProjectIds: paused,
    })).toBe('project_paused');
  });

  it('does not skip when projectId is missing (Set miss)', () => {
    expect(mayAutonomousActuate({
      source: 'schedule',
      projectId: undefined,
      globalEnabled: true,
      pausedProjectIds: paused,
    })).toBe('allow');
  });
});

describe('applyProjectAutomationTransition', () => {
  const now = '2026-09-03T00:00:00.000Z';

  it('stamps automationPausedSince on the true→false edge', () => {
    const next = applyProjectAutomationTransition(
      { automationEnabled: true },
      { automationEnabled: false, notes: 'keep' },
      now,
    );
    expect(next.automationEnabled).toBe(false);
    expect(next.automationPausedSince).toBe(now);
    expect(next.notes).toBe('keep');
  });

  it('clears automationPausedSince on the false→true edge', () => {
    const next = applyProjectAutomationTransition(
      { automationEnabled: false, automationPausedSince: now },
      { automationEnabled: true, automationPausedSince: now, notes: 'keep' },
      '2026-09-03T01:00:00.000Z',
    );
    expect(next.automationEnabled).toBe(true);
    expect(next.automationPausedSince).toBeUndefined();
    expect(next.notes).toBe('keep');
  });

  it('preserves since on unrelated saves while paused', () => {
    const next = applyProjectAutomationTransition(
      { automationEnabled: false, automationPausedSince: now },
      { automationEnabled: false, automationPausedSince: now, notes: 'new' },
      '2026-09-03T01:00:00.000Z',
    );
    expect(next.automationPausedSince).toBe(now);
    expect(next.notes).toBe('new');
  });
});

describe('formatProjectAutomationDigestLine', () => {
  it('returns null when nothing is paused', () => {
    expect(formatProjectAutomationDigestLine({ paused: [] })).toBeNull();
  });

  it('lists paused project ids', () => {
    expect(formatProjectAutomationDigestLine({
      paused: [{ projectId: 'github.com/jeanibarz/lucy', since: '2026-09-03T00:00:00.000Z' }],
    })).toBe('project automation paused: github.com/jeanibarz/lucy');
  });
});

describe('applyKillSwitchTransition', () => {
  const base = {
    automationKillSwitch: false,
    safeModeSince: null as string | null,
    other: 1,
  };

  it('sets safeModeSince when engaging', () => {
    const next = applyKillSwitchTransition(
      base,
      { ...base, automationKillSwitch: true },
      '2026-08-01T12:00:00.000Z',
    );
    expect(next).toEqual({
      automationKillSwitch: true,
      safeModeSince: '2026-08-01T12:00:00.000Z',
      other: 1,
    });
  });

  it('preserves safeModeSince across unrelated saves while engaged', () => {
    const prev = {
      automationKillSwitch: true,
      safeModeSince: '2026-08-01T12:00:00.000Z',
      other: 1,
    };
    const next = applyKillSwitchTransition(
      prev,
      { ...prev, other: 2 },
      '2026-08-01T15:00:00.000Z',
    );
    expect(next.safeModeSince).toBe('2026-08-01T12:00:00.000Z');
    expect(next.other).toBe(2);
  });

  it('clears safeModeSince when disengaging', () => {
    const prev = {
      automationKillSwitch: true,
      safeModeSince: '2026-08-01T12:00:00.000Z',
      other: 1,
    };
    const next = applyKillSwitchTransition(
      prev,
      { ...prev, automationKillSwitch: false },
      '2026-08-01T15:00:00.000Z',
    );
    expect(next).toEqual({
      automationKillSwitch: false,
      safeModeSince: null,
      other: 1,
    });
  });
});
