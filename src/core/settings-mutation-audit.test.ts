import { describe, expect, it } from 'vitest';
import {
  buildSettingsMutationAuditRow,
  diffSettingsValues,
  SETTINGS_MUTATION_AUDIT_TYPE,
} from './settings-mutation-audit.js';

describe('diffSettingsValues', () => {
  it('reports only changed keys, sorted', () => {
    const diff = diffSettingsValues(
      { maxActiveTasks: 10, hungTaskReapEnabled: true, speakVerbosity: 'medium' },
      { maxActiveTasks: 12, hungTaskReapEnabled: true, speakVerbosity: 'brief' },
    );
    expect(diff.changedKeys).toEqual(['maxActiveTasks', 'speakVerbosity']);
    expect(diff.previous).toEqual({ maxActiveTasks: 10, speakVerbosity: 'medium' });
    expect(diff.next).toEqual({ maxActiveTasks: 12, speakVerbosity: 'brief' });
  });

  it('deep-compares nested objects', () => {
    const diff = diffSettingsValues(
      { agentEffort: { 'claude-code': 'high' } },
      { agentEffort: { 'claude-code': 'low' } },
    );
    expect(diff.changedKeys).toEqual(['agentEffort']);
  });

  it('returns empty when nothing changed', () => {
    const diff = diffSettingsValues({ a: 1 }, { a: 1 });
    expect(diff.changedKeys).toEqual([]);
  });
});

describe('buildSettingsMutationAuditRow', () => {
  it('returns null when there is no diff', () => {
    expect(buildSettingsMutationAuditRow({
      previous: { maxActiveTasks: 10 },
      next: { maxActiveTasks: 10 },
      actor: { source: 'api', actorId: 'dashboard' },
    })).toBeNull();
  });

  it('builds a durable row with actor + changed keys', () => {
    const row = buildSettingsMutationAuditRow({
      previous: { maxActiveTasks: 10, automationKillSwitch: false },
      next: { maxActiveTasks: 12, automationKillSwitch: true },
      actor: { source: 'api', actorId: 'jean' },
      timestamp: '2026-08-01T12:00:00.000Z',
    });
    expect(row).toEqual({
      type: SETTINGS_MUTATION_AUDIT_TYPE,
      timestamp: '2026-08-01T12:00:00.000Z',
      actor: { source: 'api', actorId: 'jean' },
      changedKeys: ['automationKillSwitch', 'maxActiveTasks'],
      previous: { automationKillSwitch: false, maxActiveTasks: 10 },
      next: { automationKillSwitch: true, maxActiveTasks: 12 },
    });
  });
});
