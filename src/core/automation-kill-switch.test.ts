import { describe, expect, it } from 'vitest';
import {
  applyKillSwitchTransition,
  formatSafeModeDigestLine,
  isAutonomousLaunchSource,
  resolveSafeModeStatus,
} from './automation-kill-switch.js';

describe('isAutonomousLaunchSource', () => {
  it('treats schedule as autonomous', () => {
    expect(isAutonomousLaunchSource('schedule')).toBe(true);
  });

  it('treats idle-refinery as autonomous (issue #2144)', () => {
    expect(isAutonomousLaunchSource('idle-refinery')).toBe(true);
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
