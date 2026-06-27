import { describe, test, expect } from 'vitest';
import { generateTelemetryReport } from './telemetry-report.js';
import type { TelemetryEvent } from './telemetry.js';

function makeEvent(type: string, extra: Record<string, unknown> = {}): TelemetryEvent {
  return {
    type: type as TelemetryEvent['type'],
    timestamp: '2026-03-27T10:00:00Z',
    sessionId: 'test',
    platform: 'linux',
    ...extra,
  };
}

describe('generateTelemetryReport', () => {
  test('empty events produce zero counts', () => {
    const report = generateTelemetryReport([]);
    expect(report.totalEvents).toBe(0);
    expect(report.timeRange).toBeNull();
    expect(report.deadFeatures.length).toBeGreaterThan(0);
  });

  test('counts event types correctly', () => {
    const events = [
      makeEvent('agent_clicked'),
      makeEvent('agent_clicked'),
      makeEvent('shortcut_used', { key: 'Ctrl+N' }),
    ];
    const report = generateTelemetryReport(events);
    expect(report.totalEvents).toBe(3);
    expect(report.eventCounts['agent_clicked']).toBe(2);
    expect(report.eventCounts['shortcut_used']).toBe(1);
  });

  test('tracks input method breakdown from response_sent', () => {
    const events = [
      makeEvent('response_sent', { method: 'input_box' }),
      makeEvent('response_sent', { method: 'input_box' }),
      makeEvent('response_sent', { method: 'shortcut' }),
      makeEvent('response_sent', { method: 'quick_action' }),
    ];
    const report = generateTelemetryReport(events);
    expect(report.inputMethodBreakdown).toEqual({
      input_box: 2,
      shortcut: 1,
      quick_action: 1,
    });
  });

  test('tracks shortcut usage', () => {
    const events = [
      makeEvent('shortcut_used', { key: 'Ctrl+N' }),
      makeEvent('shortcut_used', { key: 'Ctrl+N' }),
      makeEvent('shortcut_used', { key: 'Ctrl+Enter' }),
    ];
    const report = generateTelemetryReport(events);
    expect(report.shortcutUsage).toEqual({
      'Ctrl+N': 2,
      'Ctrl+Enter': 1,
    });
  });

  test('computes suggestion acceptance rate', () => {
    const events = [
      makeEvent('suggestion_accepted'),
      makeEvent('suggestion_accepted'),
      makeEvent('suggestion_ignored'),
    ];
    const report = generateTelemetryReport(events);
    expect(report.suggestionMetrics.accepted).toBe(2);
    expect(report.suggestionMetrics.ignored).toBe(1);
    expect(report.suggestionMetrics.acceptanceRate).toBeCloseTo(2 / 3);
  });

  test('acceptance rate is null when no suggestion events', () => {
    const report = generateTelemetryReport([makeEvent('agent_clicked')]);
    expect(report.suggestionMetrics.acceptanceRate).toBeNull();
  });

  test('tracks frustration signals', () => {
    const events = [
      makeEvent('rapid_repeat_click', { target: 'complete_task', clickCount: 3 }),
      makeEvent('rapid_repeat_click', { target: 'skip', clickCount: 4 }),
      makeEvent('healthy_agent_inspected', { agentId: 'a1' }),
    ];
    const report = generateTelemetryReport(events);
    expect(report.frustrationSignals.rapidRepeatClicks).toBe(2);
    expect(report.frustrationSignals.healthyAgentInspections).toBe(1);
  });

  test('tracks launch dialog metrics', () => {
    const events = [
      makeEvent('launch_dialog_opened', { method: 'button' }),
      makeEvent('launch_dialog_closed', { submitted: true, dwellMs: 5000 }),
      makeEvent('launch_dialog_opened', { method: 'shortcut' }),
      makeEvent('launch_dialog_closed', { submitted: false, dwellMs: 1000 }),
    ];
    const report = generateTelemetryReport(events);
    expect(report.launchDialogMetrics.opened).toBe(2);
    expect(report.launchDialogMetrics.submitted).toBe(1);
    expect(report.launchDialogMetrics.abandoned).toBe(1);
    expect(report.launchDialogMetrics.avgDwellMs).toBe(3000);
  });

  test('cwd-field nonMruRate is null when no cwd-field events recorded', () => {
    const events = [makeEvent('launch_dialog_opened', { method: 'button' })];
    const report = generateTelemetryReport(events);
    expect(report.launchDialogMetrics.nonMruRate).toBeNull();
    expect(report.launchDialogMetrics.cwdFieldMethodCounts).toEqual({});
  });

  test('cwd-field nonMruRate counts typed and paste as non-MRU', () => {
    const events = [
      makeEvent('launch_dialog_cwd_field_used', { method: 'mru' }),
      makeEvent('launch_dialog_cwd_field_used', { method: 'mru' }),
      makeEvent('launch_dialog_cwd_field_used', { method: 'typed' }),
      makeEvent('launch_dialog_cwd_field_used', { method: 'paste' }),
      makeEvent('launch_dialog_cwd_field_used', { method: 'server-cwd-button' }),
    ];
    const report = generateTelemetryReport(events);
    expect(report.launchDialogMetrics.cwdFieldMethodCounts).toEqual({
      'mru': 2,
      'typed': 1,
      'paste': 1,
      'server-cwd-button': 1,
    });
    // 2 of 5 are non-MRU (typed + paste). server-cwd-button counts as MRU-like
    // (assisted, not raw entry) so the threshold doesn't conflate it with friction.
    expect(report.launchDialogMetrics.nonMruRate).toBeCloseTo(0.4, 5);
  });

  test('cwd-field event with missing method falls back to "unknown"', () => {
    const events = [makeEvent('launch_dialog_cwd_field_used', {})];
    const report = generateTelemetryReport(events);
    expect(report.launchDialogMetrics.cwdFieldMethodCounts).toEqual({ unknown: 1 });
    // 'unknown' is not 'typed' or 'paste', so nonMruRate is 0/1 = 0.
    expect(report.launchDialogMetrics.nonMruRate).toBe(0);
  });

  test('platform breakdown', () => {
    const events = [
      makeEvent('agent_clicked', { platform: 'linux' }),
      makeEvent('agent_clicked', { platform: 'linux' }),
      makeEvent('agent_clicked', { platform: 'darwin' }),
    ];
    // Override platform in the events
    events[2].platform = 'darwin';
    const report = generateTelemetryReport(events);
    expect(report.platformBreakdown['linux']).toBe(2);
    expect(report.platformBreakdown['darwin']).toBe(1);
  });

  test('dead features lists unused event types', () => {
    const events = [makeEvent('session_started')];
    const report = generateTelemetryReport(events);
    expect(report.deadFeatures).not.toContain('session_started');
    expect(report.deadFeatures).toContain('agent_clicked');
    expect(report.deadFeatures).toContain('shortcut_used');
  });

  test('time range from timestamps', () => {
    const events = [
      makeEvent('agent_clicked', { timestamp: '2026-03-27T10:00:00Z' }),
      makeEvent('agent_clicked', { timestamp: '2026-03-27T12:00:00Z' }),
      makeEvent('agent_clicked', { timestamp: '2026-03-27T11:00:00Z' }),
    ];
    // Fix: the events already have timestamp from makeEvent, let's override them
    events[0].timestamp = '2026-03-27T10:00:00Z';
    events[1].timestamp = '2026-03-27T12:00:00Z';
    events[2].timestamp = '2026-03-27T11:00:00Z';

    const report = generateTelemetryReport(events);
    expect(report.timeRange).toEqual({
      first: '2026-03-27T10:00:00Z',
      last: '2026-03-27T12:00:00Z',
    });
  });

  test('tab switch counts', () => {
    const events = [
      makeEvent('tab_switched', { from: 'terminal', to: 'github' }),
      makeEvent('tab_switched', { from: 'github', to: 'terminal' }),
      makeEvent('tab_switched', { from: 'terminal', to: 'github' }),
    ];
    const report = generateTelemetryReport(events);
    expect(report.tabSwitchCounts).toEqual({ github: 2, terminal: 1 });
  });

  test('summarizes selection flicker incidents', () => {
    const report = generateTelemetryReport([
      makeEvent('selection_flicker_incident', {
        pairKey: 'a|b',
        switchesPerSecond: 2.5,
        sourceCounts: { selectAgent: 2, handleDashboardSelection: 1 },
      }),
      makeEvent('selection_flicker_incident', {
        pairKey: 'a|b',
        switchesPerSecond: 3,
        sourceCounts: { selectAgent: 1 },
      }),
      makeEvent('selection_flicker_incident', {
        pairKey: 'b|c',
        switchesPerSecond: 1,
        sourceCounts: { nextTask: 3 },
      }),
    ]);

    expect(report.selectionFlickerMetrics).toEqual({
      totalIncidents: 3,
      topPairs: [
        { pairKey: 'a|b', incidentCount: 2 },
        { pairKey: 'b|c', incidentCount: 1 },
      ],
      highestSwitchRate: 3,
      sourceBreakdown: {
        selectAgent: 3,
        handleDashboardSelection: 1,
        nextTask: 3,
      },
    });
  });
});
