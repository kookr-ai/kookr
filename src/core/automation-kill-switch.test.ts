import { describe, expect, it } from 'vitest';
import {
  applyKillSwitchTransition,
  formatSafeModeDigestLine,
  isAutonomousLaunchSource,
  isSafeModeExemptSchedule,
  resolveSafeModeStatus,
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
